// Spend tracking and caps.
//
// On the raw Messages API the numbers are good: exact token counts from
// response.usage, priced at list rates, plus the live rate-limit window from
// the anthropic-ratelimit-* headers. Set monthlyBudgetUsd to whatever you
// topped the account up with and the bot will tell you what is left of it.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const STATE_FILE = path.join(here, 'usage.json');

const todayKey = () => new Date().toISOString().slice(0, 10);
const monthKey = () => new Date().toISOString().slice(0, 7);

function money(n) {
  if (!n) return '$0.00';
  if (n < 0.01) return '$' + n.toFixed(4);
  return '$' + n.toFixed(2);
}

function compact(n) {
  if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
  if (n >= 1000) return (n / 1000).toFixed(1) + 'k';
  return String(Math.round(n));
}

export class Usage {
  constructor(cfg) {
    this.cfg = cfg;
    this.rateLimits = {};
    this.rateLimitsSeenAt = null;
    this.state = {
      since: new Date().toISOString(),
      requests: 0,
      tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      months: {},
      days: {},
    };
    this.#load();
  }

  #load() {
    try {
      const s = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
      if (s && s.months && s.tokens) this.state = s;
    } catch { /* first run */ }
  }

  #save() {
    try { fs.writeFileSync(STATE_FILE, JSON.stringify(this.state, null, 2)); } catch { /* never break a reply */ }
  }

  spentToday(userId) { return (this.state.days[todayKey()] || {})[userId] || 0; }
  spentTodayAll() { return Object.values(this.state.days[todayKey()] || {}).reduce((a, b) => a + b, 0); }
  spentThisMonth() { return this.state.months[monthKey()] || 0; }
  budget() { return typeof this.cfg.monthlyBudgetUsd === 'number' ? this.cfg.monthlyBudgetUsd : 0; }
  remaining() { const b = this.budget(); return b > 0 ? Math.max(b - this.spentThisMonth(), 0) : null; }

  check(userId) {
    const caps = this.cfg.caps || {};
    if (typeof caps.perUserDailyUsd === 'number' && this.spentToday(userId) >= caps.perUserDailyUsd) {
      return { allowed: false, reason: 'You have hit your daily cap (' + money(caps.perUserDailyUsd) +
        '). Spent today: ' + money(this.spentToday(userId)) + '. Resets at midnight UTC.' };
    }
    if (typeof caps.globalDailyUsd === 'number' && this.spentTodayAll() >= caps.globalDailyUsd) {
      return { allowed: false, reason: 'The bot hit its global daily cap (' + money(caps.globalDailyUsd) + '). Try tomorrow.' };
    }
    const b = this.budget();
    if (b > 0 && this.spentThisMonth() >= b) {
      return { allowed: false, reason: 'The monthly budget (' + money(b) + ') is used up. Raise monthlyBudgetUsd or wait for next month.' };
    }
    return { allowed: true };
  }

  captureRateLimits(found) {
    if (found && Object.keys(found).length) {
      this.rateLimits = found;
      this.rateLimitsSeenAt = new Date();
    }
  }

  buckets() {
    const names = new Set();
    for (const k of Object.keys(this.rateLimits)) {
      const m = k.match(/^(.*)-(remaining|limit|reset)$/);
      if (m) names.add(m[1]);
    }
    const out = [];
    for (const n of names) {
      const remaining = Number(this.rateLimits[n + '-remaining']);
      const limit = Number(this.rateLimits[n + '-limit']);
      if (!Number.isFinite(remaining)) continue;
      out.push({
        name: n, remaining,
        limit: Number.isFinite(limit) ? limit : null,
        pct: Number.isFinite(limit) && limit > 0 ? Math.round((remaining / limit) * 100) : null,
        reset: this.rateLimits[n + '-reset'],
      });
    }
    return out;
  }

  record(userId, cost, usage) {
    const day = todayKey(), month = monthKey();
    this.state.days[day] = this.state.days[day] || {};
    this.state.days[day][userId] = (this.state.days[day][userId] || 0) + cost;
    this.state.months[month] = (this.state.months[month] || 0) + cost;
    this.state.requests += 1;
    this.state.tokens.input += usage.input_tokens || 0;
    this.state.tokens.output += usage.output_tokens || 0;
    this.state.tokens.cacheRead += usage.cache_read_input_tokens || 0;
    this.state.tokens.cacheWrite += usage.cache_creation_input_tokens || 0;

    const days = Object.keys(this.state.days).sort();
    while (days.length > 60) delete this.state.days[days.shift()];
    this.#save();
  }

  footer(cost, usage, model) {
    const bits = [
      model.replace('claude-', ''),
      compact((usage.input_tokens || 0) + (usage.cache_read_input_tokens || 0)) + ' in / ' +
        compact(usage.output_tokens || 0) + ' out',
      '~' + money(cost),
    ];
    const left = this.remaining();
    if (left !== null) {
      const pct = Math.round((left / this.budget()) * 100);
      bits.push(money(left) + ' left of ' + money(this.budget()) + ' (' + pct + '%)');
    }
    return '`' + bits.join(' | ') + '`';
  }

  report(userId, model) {
    const caps = this.cfg.caps || {};
    const t = this.state.tokens;
    const lines = [];
    const b = this.budget();

    if (b > 0) {
      const left = this.remaining();
      const pct = Math.round((left / b) * 100);
      const bar = '█'.repeat(Math.round(pct / 5)) + '░'.repeat(20 - Math.round(pct / 5));
      lines.push('**Budget this month** (' + monthKey() + ')');
      lines.push('`' + bar + '` ' + pct + '%');
      lines.push('Spent **' + money(this.spentThisMonth()) + '** of ' + money(b) + ' - **' + money(left) + ' left**');
      const avg = this.state.requests ? this.spentThisMonth() / this.state.requests : 0;
      if (avg > 0) lines.push('At ~' + money(avg) + '/message that is roughly **' + Math.floor(left / avg) + ' messages** to go.');
      lines.push('');
    }

    lines.push('**Totals since ' + new Date(this.state.since).toLocaleDateString() + '**');
    lines.push('Requests: ' + this.state.requests);
    lines.push('Tokens: ' + compact(t.input) + ' in, ' + compact(t.output) + ' out, ' +
      compact(t.cacheRead) + ' cache read, ' + compact(t.cacheWrite) + ' cache write');
    lines.push('');
    lines.push('**Today** - you: ' + money(this.spentToday(userId)) +
      (typeof caps.perUserDailyUsd === 'number' ? ' / ' + money(caps.perUserDailyUsd) : '') +
      '  |  everyone: ' + money(this.spentTodayAll()) +
      (typeof caps.globalDailyUsd === 'number' ? ' / ' + money(caps.globalDailyUsd) : ''));

    const buckets = this.buckets();
    if (buckets.length) {
      lines.push('');
      lines.push('**Rate limit window** (as of ' + this.rateLimitsSeenAt.toLocaleTimeString() + ')');
      for (const bk of buckets) {
        let l = '- ' + bk.name + ': ' + compact(bk.remaining);
        if (bk.limit !== null) l += ' / ' + compact(bk.limit) + ' (' + bk.pct + '%)';
        lines.push(l);
      }
    }

    lines.push('');
    lines.push('_Costs are computed from exact token counts at ' + model +
      ' list prices. The authoritative balance is in the Anthropic Console._');
    return lines.join('\n');
  }
}
