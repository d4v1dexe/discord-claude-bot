// Usage accounting and spend caps.
//
// Running on a Claude plan (via the Agent SDK) rather than pay-as-you-go
// changes what "how much is left" means. It is no longer a rate-limit window:
// it is your monthly Agent SDK credit. So this tracks month-to-date spend
// against the credit for your plan, plus per-user daily caps so one person
// cannot burn the month in an afternoon.
//
// Every dollar figure is the SDK's own estimate (total_cost_usd). It is an
// estimate, not a billing statement -- treat it as a guide, not gospel.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const STATE_FILE = path.join(here, 'usage.json');

// Monthly Agent SDK credit by plan, USD. Used only to show "remaining".
export const PLAN_CREDITS = { pro: 20, max5x: 100, max20x: 200, none: 0 };

const todayKey = () => new Date().toISOString().slice(0, 10);
const monthKey = () => new Date().toISOString().slice(0, 7);

function money(n) {
  if (n === 0) return '$0.00';
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
    this.state = {
      since: new Date().toISOString(),
      requests: 0,
      inputTokens: 0,
      outputTokens: 0,
      months: {}, // "2026-09" -> cost
      days: {}, // "2026-09-18" -> { userId: cost }
    };
    this.#load();
  }

  #load() {
    try {
      const saved = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
      if (saved && saved.months) this.state = saved;
    } catch {
      /* first run */
    }
  }

  #save() {
    try {
      fs.writeFileSync(STATE_FILE, JSON.stringify(this.state, null, 2));
    } catch {
      /* bookkeeping must never break a reply */
    }
  }

  spentToday(userId) {
    return (this.state.days[todayKey()] || {})[userId] || 0;
  }

  spentTodayAll() {
    const day = this.state.days[todayKey()] || {};
    return Object.values(day).reduce((a, b) => a + b, 0);
  }

  spentThisMonth() {
    return this.state.months[monthKey()] || 0;
  }

  creditUsd() {
    const plan = (this.cfg.plan || 'none').toLowerCase();
    if (typeof this.cfg.monthlyCreditUsd === 'number') return this.cfg.monthlyCreditUsd;
    return PLAN_CREDITS[plan] ?? 0;
  }

  /**
   * Check caps BEFORE spending anything.
   * Returns { allowed, reason }.
   */
  check(userId) {
    const caps = this.cfg.caps || {};
    const perUser = caps.perUserDailyUsd;
    const global = caps.globalDailyUsd;

    if (typeof perUser === 'number' && this.spentToday(userId) >= perUser) {
      return {
        allowed: false,
        reason:
          'You have hit your daily cap (' +
          money(perUser) +
          '). Spent today: ' +
          money(this.spentToday(userId)) +
          '. It resets at midnight UTC.',
      };
    }
    if (typeof global === 'number' && this.spentTodayAll() >= global) {
      return {
        allowed: false,
        reason:
          'The bot has hit its global daily cap (' + money(global) + '). Try again tomorrow.',
      };
    }
    const credit = this.creditUsd();
    if (credit > 0 && this.spentThisMonth() >= credit) {
      return {
        allowed: false,
        reason:
          'The monthly Agent SDK credit (' +
          money(credit) +
          ') is used up. It refreshes at the start of next month.',
      };
    }
    return { allowed: true };
  }

  // How much this one query is allowed to cost, for the SDK's own maxBudgetUsd.
  budgetForQuery(userId) {
    const caps = this.cfg.caps || {};
    const limits = [caps.perQueryUsd].filter((n) => typeof n === 'number');
    if (typeof caps.perUserDailyUsd === 'number') {
      limits.push(Math.max(caps.perUserDailyUsd - this.spentToday(userId), 0.01));
    }
    if (typeof caps.globalDailyUsd === 'number') {
      limits.push(Math.max(caps.globalDailyUsd - this.spentTodayAll(), 0.01));
    }
    const credit = this.creditUsd();
    if (credit > 0) limits.push(Math.max(credit - this.spentThisMonth(), 0.01));
    return limits.length ? Math.min(...limits) : undefined;
  }

  record(userId, costUsd, modelUsage) {
    const cost = Number(costUsd) || 0;
    const day = todayKey();
    const month = monthKey();
    this.state.days[day] = this.state.days[day] || {};
    this.state.days[day][userId] = (this.state.days[day][userId] || 0) + cost;
    this.state.months[month] = (this.state.months[month] || 0) + cost;
    this.state.requests += 1;

    // Cached tokens are the bulk of the input on this SDK -- ~28k of harness per
    // call, nearly all of it served from cache. Counting only `inputTokens`
    // reported single-digit input against five-figure output, which is nonsense.
    for (const m of Object.values(modelUsage || {})) {
      this.state.inputTokens += m.inputTokens || m.input_tokens || 0;
      this.state.outputTokens += m.outputTokens || m.output_tokens || 0;
      this.state.cacheReadTokens =
        (this.state.cacheReadTokens || 0) + (m.cacheReadInputTokens || 0);
      this.state.cacheWriteTokens =
        (this.state.cacheWriteTokens || 0) + (m.cacheCreationInputTokens || 0);
    }

    // Keep the day map from growing forever.
    const days = Object.keys(this.state.days).sort();
    while (days.length > 60) delete this.state.days[days.shift()];

    this.#save();
    return cost;
  }

  footer(cost, userId) {
    const bits = ['~' + money(cost)];
    const caps = this.cfg.caps || {};
    if (typeof caps.perUserDailyUsd === 'number') {
      bits.push(
        'today ' + money(this.spentToday(userId)) + '/' + money(caps.perUserDailyUsd)
      );
    }
    const credit = this.creditUsd();
    if (credit > 0) {
      const left = Math.max(credit - this.spentThisMonth(), 0);
      const pct = Math.round((left / credit) * 100);
      bits.push(money(left) + ' of monthly credit left (' + pct + '%)');
    }
    return '`' + bits.join(' | ') + '`';
  }

  report(userId) {
    const caps = this.cfg.caps || {};
    const credit = this.creditUsd();
    const lines = [];
    lines.push('**Usage**');
    lines.push('Requests since ' + new Date(this.state.since).toLocaleDateString() + ': ' + this.state.requests);
    const cacheRead = this.state.cacheReadTokens || 0;
    const cacheWrite = this.state.cacheWriteTokens || 0;
    lines.push(
      'Tokens: ' + compact(this.state.inputTokens + cacheRead + cacheWrite) + ' in / ' +
      compact(this.state.outputTokens) + ' out' +
      (cacheRead ? '  (' + compact(cacheRead) + ' of the input served from cache)' : '')
    );
    lines.push('');
    lines.push('**This month** (' + monthKey() + ')');
    if (credit > 0) {
      const left = Math.max(credit - this.spentThisMonth(), 0);
      const pct = Math.round((left / credit) * 100);
      lines.push(
        'Spent ' + money(this.spentThisMonth()) + ' of your ' + money(credit) +
        ' Agent SDK credit - **' + money(left) + ' left (' + pct + '%)**'
      );
    } else {
      lines.push(
        'Spent ' + money(this.spentThisMonth()) +
        '. No plan credit configured, so there is no "remaining" to show - set `plan` in config.json.'
      );
    }
    lines.push('');
    lines.push('**Today**');
    lines.push('You: ' + money(this.spentToday(userId)) +
      (typeof caps.perUserDailyUsd === 'number' ? ' / ' + money(caps.perUserDailyUsd) + ' cap' : ''));
    lines.push('Everyone: ' + money(this.spentTodayAll()) +
      (typeof caps.globalDailyUsd === 'number' ? ' / ' + money(caps.globalDailyUsd) + ' cap' : ''));
    lines.push('');
    lines.push(
      '_Costs are the Agent SDK\'s own estimate, not a billing statement. Plan credit figures ' +
      'assume the `plan` set in config.json; the real balance lives in your Claude account._'
    );
    return lines.join('\n');
  }
}
