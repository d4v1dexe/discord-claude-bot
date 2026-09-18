// Discord bot powered by the Claude Agent SDK.
//
// It speaks when: you @-mention it, you reply to something it said, or you talk
// in a thread it opened. It stays silent otherwise -- no keyword triggers, no
// answering @everyone.
import 'dotenv/config';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client, GatewayIntentBits, Partials, ChannelType } from 'discord.js';
import { runAgent, ERROR_HINTS } from './agent.js';
import { Usage } from './usage.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const cfg = JSON.parse(fs.readFileSync(path.join(here, 'config.json'), 'utf8'));

if (!process.env.DISCORD_TOKEN) {
  console.error('DISCORD_TOKEN is not set. Copy .env.example to .env and fill it in.');
  process.exit(1);
}

const usage = new Usage(cfg);
const SCRATCH = path.join(os.tmpdir(), 'discord-claude-bot');

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
  partials: [Partials.Channel, Partials.Message],
});

// conversationKey (thread id or channel id) -> Agent SDK session id.
// Persisted, so a restart does not throw away every ongoing conversation.
const SESSION_FILE = path.join(here, 'sessions.json');
const sessions = new Map();
try {
  for (const [k, v] of Object.entries(JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8')))) {
    sessions.set(k, v);
  }
} catch { /* first run */ }

function saveSessions() {
  try {
    fs.writeFileSync(SESSION_FILE, JSON.stringify(Object.fromEntries(sessions), null, 2));
  } catch { /* never break a reply over bookkeeping */ }
}

const mayUseRepos = (userId) => {
  const ra = cfg.repoAccess || {};
  return Boolean(ra.enabled && (ra.allowedUserIds || []).includes(userId));
};

function chunk(text, size) {
  const limit = size || 1900;
  const out = [];
  let rest = text;
  while (rest.length > limit) {
    let cut = rest.lastIndexOf('\n', limit);
    if (cut < limit * 0.5) cut = limit;
    out.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  if (rest.trim()) out.push(rest);
  return out.length ? out : ['(empty)'];
}

// Save attachments locally so the agent can Read them (images included).
async function saveAttachments(message) {
  if (!message.attachments.size) return { dir: null, notes: [] };
  const max = (cfg.attachments || {}).maxBytes || 8 * 1024 * 1024;
  const dir = path.join(SCRATCH, message.id);
  fs.mkdirSync(dir, { recursive: true });
  const notes = [];
  for (const att of message.attachments.values()) {
    if (att.size > max) {
      notes.push(att.name + ' (skipped: ' + att.size + ' bytes exceeds the limit)');
      continue;
    }
    try {
      const res = await fetch(att.url);
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const buf = Buffer.from(await res.arrayBuffer());
      const safeName = path.basename(att.name).replace(/[^\w.\-]/g, '_');
      const dest = path.join(dir, safeName);
      fs.writeFileSync(dest, buf);
      notes.push(dest + '  (' + (att.contentType || 'unknown type') + ', ' + att.size + ' bytes)');
    } catch (e) {
      notes.push(att.name + ' (download failed: ' + e.message + ')');
    }
  }
  return { dir, notes };
}

function cleanup(dir) {
  if (!dir) return;
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
}

// Did someone tag the bot's own integration role (<@&...>) rather than the bot
// user (<@...>)? Discord shows both as "@claude_dc", so people use them
// interchangeably. Only `managed` roles count -- those are created by Discord
// for the bot itself, so this cannot fire on an ordinary role the bot happens
// to share with humans, and never on @everyone or @here.
function mentionsOurRole(message) {
  try {
    const me = message.guild && message.guild.members.me;
    if (!me) return false;
    return message.mentions.roles.some((r) => r.managed && me.roles.cache.has(r.id));
  } catch {
    return false;
  }
}

// Should we answer this message at all?
async function shouldHandle(message) {
  if (message.author.bot) return null;

  // A thread we opened. Checked by ownership, not by in-memory state: the
  // session map used to live only in memory, so restarting the bot silently
  // orphaned every open thread.
  if (message.channel.isThread && message.channel.isThread()) {
    if (message.channel.ownerId === client.user.id) return 'thread';
  }

  if (message.mentions.users.has(client.user.id) || mentionsOurRole(message)) return 'mention';

  // Reply to something we said, without needing a fresh tag.
  if (message.reference && message.reference.messageId) {
    try {
      const ref = await message.channel.messages.fetch(message.reference.messageId);
      if (ref && ref.author.id === client.user.id) return 'reply';
    } catch {
      /* referenced message may be gone */
    }
  }
  return null;
}

client.on('messageCreate', async (message) => {
  let scratchDir = null;
  try {
    const trigger = await shouldHandle(message);
    if (!trigger) return;

    const raw = message.content.replace(/<@!?\d+>/g, ' ').replace(/\s+/g, ' ').trim();
    const displayName = message.member?.displayName || message.author.username;
    const userId = message.author.id;

    if (/^(usage|quota|cost)\b/i.test(raw)) {
      await message.reply(usage.report(userId));
      return;
    }

    const gate = usage.check(userId);
    if (!gate.allowed) {
      await message.reply(gate.reason);
      return;
    }

    if (!raw && !message.attachments.size) {
      await message.reply('You tagged me but said nothing. What do you need?');
      return;
    }

    // Open a thread on the first mention in a normal channel, so the channel
    // does not fill up with a long back-and-forth.
    let target = message.channel;
    const wantThreads = (cfg.threads || {}).enabled !== false;
    if (
      wantThreads &&
      trigger === 'mention' &&
      message.channel.type === ChannelType.GuildText &&
      message.channel.threads
    ) {
      try {
        const label = raw.slice(0, 60) || 'chat';
        target = await message.startThread({
          name: ((cfg.threads || {}).name || 'claude') + ': ' + label,
          autoArchiveDuration: (cfg.threads || {}).autoArchiveMinutes || 1440,
        });
      } catch {
        target = message.channel; // no thread permission: answer in place
      }
    }

    const convKey = target.id;
    const saved = await saveAttachments(message);
    scratchDir = saved.dir;

    let prompt = raw;
    if (saved.notes.length) {
      prompt +=
        '\n\n[Files attached to this Discord message, saved locally for you to Read:\n' +
        saved.notes.join('\n') +
        '\n]';
    }

    await target.sendTyping();
    const typing = setInterval(() => target.sendTyping().catch(() => {}), 8000);

    let result;
    try {
      result = await runAgent({
        cfg,
        prompt,
        displayName,
        sessionId: sessions.get(convKey) || null,
        repoAllowed: mayUseRepos(userId),
        extraRoots: scratchDir ? [scratchDir] : [],
        maxBudgetUsd: usage.budgetForQuery(userId),
      });
    } finally {
      clearInterval(typing);
    }

    if (result.sessionId) {
      sessions.set(convKey, result.sessionId);
      saveSessions();
    }
    usage.record(userId, result.cost, result.modelUsage);

    let body = result.text;
    if (!body) {
      body = result.error
        ? ERROR_HINTS[result.error] || 'Something went wrong: ' + result.error
        : 'I came back with nothing to say.';
    } else if (result.error && ERROR_HINTS[result.error]) {
      body += '\n\n_' + ERROR_HINTS[result.error] + '_';
    }
    if (result.denials) {
      body += '\n_(' + result.denials + ' tool call(s) blocked by the permission guard.)_';
    }
    if ((cfg.showUsageFooter ?? true) === true) {
      body += '\n' + usage.footer(result.cost, userId);
    }

    const parts = chunk(body);
    if (target.id === message.channel.id) await message.reply(parts[0]);
    else await target.send(parts[0]);
    for (const p of parts.slice(1)) await target.send(p);
  } catch (err) {
    console.error('handler error:', err);
    try {
      await message.reply(('Something broke: ' + err.message).slice(0, 1900));
    } catch {
      /* channel gone */
    }
  } finally {
    cleanup(scratchDir);
  }
});

client.once('clientReady', () => {
  const ra = cfg.repoAccess || {};
  console.log('Logged in as ' + client.user.tag);
  console.log('Model ' + cfg.model + ' | effort ' + (cfg.effort || 'medium'));
  console.log('Repo access: ' + (ra.enabled ? Object.keys(ra.repos || {}).join(', ') : 'off'));
  console.log(
    'GitHub tools: ' +
      (cfg.github && cfg.github.enabled
        ? process.env.GITHUB_TOKEN
          ? 'on'
          : 'enabled but GITHUB_TOKEN is missing'
        : 'off')
  );
  console.log('Triggers: @mention (user or my own role), replies to me, threads I opened.');
  console.log('Restored ' + sessions.size + ' saved thread session(s).');
  for (const guild of client.guilds.cache.values()) {
    const me = guild.members.me;
    const managed = me ? me.roles.cache.filter((r) => r.managed).map((r) => '@' + r.name) : [];
    console.log('  ' + guild.name + ': answers to ' + (managed.join(', ') || '(no managed role found)'));
  }
});

client.login(process.env.DISCORD_TOKEN).catch((e) => {
  console.error('Discord login failed:', e.message);
  process.exit(1);
});
