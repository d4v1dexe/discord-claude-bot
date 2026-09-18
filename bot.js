// Discord bot on the raw Anthropic Messages API.
//
// Speaks when: you @-mention it, you reply to something it said, or you talk in
// a thread it opened. Silent otherwise.
import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client, GatewayIntentBits, Partials, ChannelType } from 'discord.js';
import Anthropic from '@anthropic-ai/sdk';
import { runAgent } from './agent.js';
import { Usage } from './usage.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const cfg = JSON.parse(fs.readFileSync(path.join(here, 'config.json'), 'utf8'));

if (!process.env.DISCORD_TOKEN) {
  console.error('DISCORD_TOKEN is not set. Run setup-env.ps1.');
  process.exit(1);
}
if (!process.env.ANTHROPIC_API_KEY) {
  console.error('ANTHROPIC_API_KEY is not set. Get one at https://console.anthropic.com and run setup-env.ps1.');
  process.exit(1);
}

const anthropic = new Anthropic();
const usage = new Usage(cfg);

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
  partials: [Partials.Channel, Partials.Message],
});

// conversationKey -> [{ sensitive, user, assistant }]
const histories = new Map();

const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];
const TEXTY = /\.(txt|md|json|js|ts|tsx|jsx|py|java|c|cpp|cs|go|rs|rb|sh|ps1|yml|yaml|toml|ini|csv|log|html|css)$/i;

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

// Build the user content blocks: text, plus images and small text files.
async function buildUserContent(message, raw) {
  const blocks = [];
  const maxBytes = (cfg.attachments || {}).maxBytes || 8 * 1024 * 1024;
  const notes = [];

  for (const att of message.attachments.values()) {
    if (att.size > maxBytes) { notes.push(att.name + ' (too large, skipped)'); continue; }
    try {
      const res = await fetch(att.url);
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const buf = Buffer.from(await res.arrayBuffer());
      const ct = (att.contentType || '').split(';')[0];
      if (IMAGE_TYPES.includes(ct)) {
        blocks.push({ type: 'image', source: { type: 'base64', media_type: ct, data: buf.toString('base64') } });
        notes.push(att.name + ' (image)');
      } else if (TEXTY.test(att.name) || ct.startsWith('text/')) {
        blocks.push({ type: 'text', text: 'Attached file ' + att.name + ':\n```\n' + buf.toString('utf8').slice(0, 60000) + '\n```' });
        notes.push(att.name + ' (text)');
      } else {
        notes.push(att.name + ' (unsupported type ' + (ct || 'unknown') + ', skipped)');
      }
    } catch (e) {
      notes.push(att.name + ' (download failed: ' + e.message + ')');
    }
  }

  const text = raw || (blocks.length ? 'Have a look at this.' : '');
  blocks.push({ type: 'text', text });
  return { blocks, notes };
}

function buildHistory(convKey, repoAllowed) {
  const past = histories.get(convKey) || [];
  const usable = repoAllowed ? past : past.filter((e) => !e.sensitive);
  const keep = usable.slice(-(cfg.historyExchanges || 6));
  const msgs = [];
  for (const e of keep) {
    msgs.push({ role: 'user', content: e.user });
    msgs.push({ role: 'assistant', content: e.assistant });
  }
  return msgs;
}

// Store a compact record: images become placeholders so we do not re-upload
// them (and re-pay for them) on every subsequent turn.
function remember(convKey, userBlocks, assistantText, sensitive) {
  const flattened = userBlocks
    .map((b) => (b.type === 'text' ? b.text : '[image attachment]'))
    .join('\n')
    .slice(0, 4000);
  const list = histories.get(convKey) || [];
  list.push({ user: flattened, assistant: assistantText.slice(0, 4000), sensitive });
  while (list.length > (cfg.historyExchanges || 6) * 2) list.shift();
  histories.set(convKey, list);
}

async function shouldHandle(message) {
  if (message.author.bot) return null;
  if (message.channel.isThread && message.channel.isThread() && histories.has(message.channel.id)) return 'thread';
  if (message.mentions.users.has(client.user.id)) return 'mention';
  if (message.reference && message.reference.messageId) {
    try {
      const ref = await message.channel.messages.fetch(message.reference.messageId);
      if (ref && ref.author.id === client.user.id) return 'reply';
    } catch { /* gone */ }
  }
  return null;
}

client.on('messageCreate', async (message) => {
  try {
    const trigger = await shouldHandle(message);
    if (!trigger) return;

    const raw = message.content.replace(/<@!?\d+>/g, ' ').replace(/\s+/g, ' ').trim();
    const displayName = message.member?.displayName || message.author.username;
    const userId = message.author.id;
    const repoAllowed = mayUseRepos(userId);

    if (/^(usage|quota|cost|budget)\b/i.test(raw)) {
      await message.reply(usage.report(userId, cfg.model));
      return;
    }

    const gate = usage.check(userId);
    if (!gate.allowed) { await message.reply(gate.reason); return; }

    if (!raw && !message.attachments.size) {
      await message.reply('You tagged me but said nothing. What do you need?');
      return;
    }

    let target = message.channel;
    if (
      (cfg.threads || {}).enabled !== false &&
      trigger === 'mention' &&
      message.channel.type === ChannelType.GuildText
    ) {
      try {
        target = await message.startThread({
          name: ((cfg.threads || {}).name || 'claude') + ': ' + (raw.slice(0, 60) || 'chat'),
          autoArchiveDuration: (cfg.threads || {}).autoArchiveMinutes || 1440,
        });
      } catch { target = message.channel; }
    }

    const convKey = target.id;
    const { blocks, notes } = await buildUserContent(message, raw);

    await target.sendTyping();
    const typing = setInterval(() => target.sendTyping().catch(() => {}), 8000);

    let result;
    try {
      result = await runAgent({
        cfg,
        client: anthropic,
        userContent: blocks,
        displayName,
        repoAllowed,
        history: buildHistory(convKey, repoAllowed),
      });
    } finally {
      clearInterval(typing);
    }

    usage.captureRateLimits(result.rateLimits);
    usage.record(userId, result.cost, result.usage);
    remember(convKey, blocks, result.text, result.usedTools);

    let body = result.text;
    if (notes.length) body += '\n_attachments: ' + notes.join(', ') + '_';
    if ((cfg.showUsageFooter ?? true) === true) {
      body += '\n' + usage.footer(result.cost, result.usage, cfg.model);
    }

    const parts = chunk(body);
    if (target.id === message.channel.id) await message.reply(parts[0]);
    else await target.send(parts[0]);
    for (const p of parts.slice(1)) await target.send(p);
  } catch (err) {
    console.error('handler error:', err);
    let msg = 'Something broke: ' + err.message;
    if (err instanceof Anthropic.AuthenticationError) msg = 'My ANTHROPIC_API_KEY is missing or invalid.';
    else if (err instanceof Anthropic.RateLimitError) msg = 'Rate limited by the API. Try again shortly.';
    else if (err instanceof Anthropic.APIConnectionError) msg = 'I could not reach the Anthropic API.';
    else if (err instanceof Anthropic.APIError) msg = 'API error ' + err.status + ': ' + err.message;
    try { await message.reply(msg.slice(0, 1900)); } catch { /* channel gone */ }
  }
});

client.once('clientReady', () => {
  const ra = cfg.repoAccess || {};
  console.log('Logged in as ' + client.user.tag);
  console.log('Model ' + cfg.model + ' | effort ' + (cfg.effort || 'medium') +
    ' | budget ' + (cfg.monthlyBudgetUsd ? '$' + cfg.monthlyBudgetUsd + '/month' : 'unset'));
  console.log('Repo access: ' + (ra.enabled ? Object.keys(ra.repos || {}).join(', ') : 'off'));
  console.log('GitHub tools: ' + (cfg.github && cfg.github.enabled ? (process.env.GITHUB_TOKEN ? 'on' : 'enabled but GITHUB_TOKEN missing') : 'off'));
  console.log('Triggers: @mention, replies to me, threads I opened.');
});

client.login(process.env.DISCORD_TOKEN).catch((e) => {
  console.error('Discord login failed:', e.message);
  process.exit(1);
});
