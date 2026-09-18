# discord-claude-bot

A Discord bot powered by the [Claude Agent SDK](https://code.claude.com/docs/en/agent-sdk).
It answers when you talk to it, can read your code, and runs on your **Claude plan's
monthly Agent SDK credit** rather than pay-as-you-go API billing.

## Features

- **Speaks only when spoken to** — an @-mention, a reply to one of its messages, or a message
  in a thread it opened. Never `@everyone`, never keyword triggers, never other bots.
- **Threads** — the first mention in a channel opens a thread, so long conversations don't
  flood the channel. Inside the thread you don't need to tag it again.
- **Reads your repos** — real `Read`/`Grep`/`Glob`, fenced by an allowlist (see Security).
- **Reads GitHub** — optional read-only tools for repos, files, code search, issues and PRs.
- **Reads attachments** — drop in an image or a file and ask about it.
- **Spend caps** — per query, per user per day, and global per day, enforced before the call.
- **Usage reporting** — a footer on each reply, `@bot usage` for the full picture.

## Requirements

- Node 18+
- A Discord bot application
- Either a Claude plan (Pro / Max) **or** an Anthropic API key

## Setup

```bash
git clone <your-fork-url> discord-claude-bot
cd discord-claude-bot
npm install
cp config.example.json config.json
cp .env.example .env
```

Edit `.env` (Discord token; GitHub token only if you want GitHub tools) and `config.json`
(your Discord user ID, your repo paths, your plan, your caps).

### Authentication — plan vs API key

**On your Claude plan (default).** Leave `ANTHROPIC_API_KEY` unset. The Agent SDK uses the
login from Claude Code on the same machine. Sign in once:

```bash
claude
```

If you see `OAuth session expired and could not be refreshed`, your login lapsed — run
`claude` and sign in again.

Eligible plans get a monthly Agent SDK credit (Pro $20, Max 5x $100, Max 20x $200) separate
from your normal plan usage. Set `plan` in `config.json` so the bot can report what's left.

> **Read this before running it for a community.** Anthropic's guidance is that the
> subscription credit is for *individual* experimentation and automation, and that credits
> are per-user and non-transferable — teams running shared production automation are
> directed to an API key instead. A bot answering a room full of people is closer to the
> second thing than the first. For personal use this is fine; if you open it up, use an API
> key. Check the current terms yourself rather than taking this README's word for it.

**On an API key.** Put `ANTHROPIC_API_KEY` in `.env`. Pay-as-you-go, billed separately from
any subscription. Same code, no other changes.

### Run

```bash
npm start
```

## Security

The bot hands Claude genuine file tools, so the guard matters. Every tool call goes through
`canUseTool` in [`guard.js`](guard.js), which denies by default:

| Rule | Effect |
|---|---|
| Tool allowlist | Only `Read`, `Grep`, `Glob` (+ `mcp__github__*` when enabled). |
| Explicit blocks | `Bash`, `Write`, `Edit`, `NotebookEdit`, `Task`, `WebFetch`, `WebSearch`, `SlashCommand`. |
| Path containment | Every path is resolved and must sit inside a configured repo. Traversal and absolute escapes are rejected, not clamped. |
| Secrets denylist | `.env*`, `*.pem`, `*.key`, `*.pfx`, `*.p12`, `*.crt`, `id_rsa`, `credentials.json`, `.claude.json`. |
| User allowlist | Repo and GitHub tools attach only for `repoAccess.allowedUserIds`. Everyone else gets a bot with no file access. |
| No host settings | `settingSources: []` — it will not inherit your `CLAUDE.md` or local Claude settings. |

**The allowlist is the whole security model.** Anyone on it can read any non-denied file in
any configured repo, through Discord, and whatever they read lands in Discord's message
history. Keep it to people you would hand a terminal to, and add repos deliberately.

`config.json` is gitignored because it holds your user IDs and local paths. Ship
`config.example.json` instead.

## Usage reporting

Footer on every reply:

```
~$0.1147 | today $0.11/$1.50 | $18.69 of monthly credit left (93%)
```

**Measured costs** (a real repo question, tools used):

| Model | per message | messages per $20 |
|---|---|---|
| `claude-sonnet-5` (default) | ~$0.11 | ~180 |
| `claude-opus-5` | ~$0.28 | ~70 |

Most of that is fixed overhead: the Agent SDK sends Claude Code's system prompt and tool
definitions (~28k tokens) on every call. Your actual question is a rounding error beside it,
which is why a short "hi" costs nearly as much as a real question.

`@bot usage` gives the full report. Costs are the Agent SDK's own estimate
(`total_cost_usd`), not a billing statement. The "monthly credit left" figure assumes the
`plan` you set in config — the authoritative balance is in your Claude account.

## Configuration

| Key | Meaning |
|---|---|
| `model` | Default `claude-sonnet-5`. `claude-opus-5` is sharper but ~2.5x the cost; `claude-haiku-4-5` is cheaper again. |
| `effort` | `low`/`medium`/`high`/`xhigh`/`max`. `medium` suits chat; raise for hard code questions. |
| `maxTurns` | Max agent turns per message. |
| `plan` | `pro`, `max5x`, `max20x`, or `none`. Only used to compute remaining credit. |
| `caps.perQueryUsd` | Hard ceiling for one message, passed to the SDK as `maxBudgetUsd`. |
| `caps.perUserDailyUsd` | Per-person daily ceiling. Checked before the call. |
| `caps.globalDailyUsd` | Whole-bot daily ceiling. |
| `threads.enabled` | Open a thread on first mention. |
| `threads.name` | Thread name prefix. |
| `github.enabled` | Turn on GitHub tools (needs `GITHUB_TOKEN`). |
| `repoAccess.allowedUserIds` | Discord user IDs allowed file and GitHub access. |
| `repoAccess.repos` | Name → absolute path. Forward slashes on Windows. |

### GitHub token

Create a **fine-grained** personal access token at
<https://github.com/settings/personal-access-tokens>. Read-only is enough: *Contents:
Read-only*, plus *Issues* and *Pull requests* read if you want those tools. Don't use a
classic token with write scopes — the bot never writes.

## Switching to the raw Messages API

A second build lives on the **`raw-api`** branch. It drops the Agent SDK and calls the
Messages API directly with a small hand-written tool set, so the per-call overhead falls
from ~28k tokens to ~1k:

| | this branch (`main`) | `raw-api` branch |
|---|---|---|
| Billing | Claude plan's Agent SDK credit | pay-as-you-go API credit |
| Cost per message | ~$0.11 (Sonnet) | ~$0.01-0.08 |
| Messages per $20 | ~180 | ~250-900 |
| Needs | a `claude` login | an API key with credit |

The catch: **API credit is a different balance from your subscription.** The $20 Agent SDK
credit that comes with a Claude plan cannot be spent through the Messages API, and it does
not appear in the Anthropic Console. The Console's "Organization credits" is a separate
wallet that starts at $0.00, and its "tier limit" is a spending ceiling, not a balance.

To switch:

1. Go to <https://console.anthropic.com> -> **Billing** -> **Add funds**. Whatever you add
   is what you can spend; there is no free allowance.
2. Create a key under **API keys**.
3. Put it in `.env` as `ANTHROPIC_API_KEY` (run `setup-env.ps1`, which prompts with hidden
   input rather than having you paste it anywhere visible).
4. Check out the branch and install:

   ```bash
   git checkout raw-api
   npm install
   ```

5. Set `monthlyBudgetUsd` in `config.json` to what you topped up. The bot tracks spend
   against it and hard-stops at the limit.

To come back, `git checkout main` and `npm install`.

## License

MIT — see [LICENSE](LICENSE).
