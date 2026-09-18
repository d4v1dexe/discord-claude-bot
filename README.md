# discord-claude-bot

A Discord bot powered by the Anthropic Messages API. It answers when you talk to it, reads
your code, handles images, and tracks every cent it spends.

Built deliberately on the raw API rather than the Claude Agent SDK. The SDK is lovely but
ships Claude Code's entire harness -- about 28k tokens of system prompt and tool definitions
on *every* call, measured at ~$0.28 per message. Defining a small tool set here puts the
overhead near 1k tokens, so a message costs cents.

## Features

- **Speaks only when spoken to** — an @-mention, a reply to one of its messages, or a message
  in a thread it opened. Never `@everyone`, never keyword triggers, never other bots.
- **Threads** — the first mention in a channel opens a thread, so long conversations don't
  flood the channel. Inside the thread you don't need to tag it again.
- **Reads your repos** — list, read, regex-search and `git log`, fenced by an allowlist (see Security).
- **Reads GitHub** — optional read-only tools for repos, files, code search, issues and PRs.
- **Reads attachments** — drop in an image or a file and ask about it.
- **Spend caps** — per user per day, global per day, and a monthly budget, all enforced before the call.
- **Usage reporting** — a footer on each reply, `@bot usage` for the full picture.

## Requirements

- Node 18+
- A Discord bot application
- An Anthropic API key with credit

## Setup

```bash
git clone <your-fork-url> discord-claude-bot
cd discord-claude-bot
npm install
cp config.example.json config.json
cp .env.example .env
```

Edit `.env` (Discord token; GitHub token only if you want GitHub tools) and `config.json`
(your Discord user ID, your repo paths, your budget, your caps).

### Authentication

Get an API key at <https://console.anthropic.com> → API keys, add some credit, and put it in
`.env` via `setup-env.ps1`. Billing is pay-as-you-go and separate from any Claude
subscription.

Set `monthlyBudgetUsd` in `config.json` to whatever you topped up with; the bot tracks spend
against it and refuses to go over.

### Run

```bash
npm start
```

## Security

The bot gives Claude real access to your disk, so the fencing matters. Every check lives in
[`tools.js`](tools.js), inside the handlers themselves:

| Rule | Effect |
|---|---|
| Small tool surface | Five read-only repo tools and six read-only GitHub tools. No shell, no write, no edit — those tools do not exist here. |
| Path containment | Every path is resolved and must sit inside a configured repo. Traversal and absolute escapes are rejected, not clamped. |
| Secrets denylist | `.env*`, `*.pem`, `*.key`, `*.pfx`, `*.p12`, `*.crt`, `id_rsa`, `credentials.json`, `.claude.json`. |
| User allowlist | Repo and GitHub tools attach only for `repoAccess.allowedUserIds`. Everyone else gets a bot with no file access. |
| Unbypassable | Path checks live *inside* the tool handlers. There is no permission callback to shadow and no built-in file tool to fall back on. |

**The allowlist is the whole security model.** Anyone on it can read any non-denied file in
any configured repo, through Discord, and whatever they read lands in Discord's message
history. Keep it to people you would hand a terminal to, and add repos deliberately.

`config.json` is gitignored because it holds your user IDs and local paths. Ship
`config.example.json` instead.

## Usage reporting

Footer on every reply:

```
opus-5 | 2.1k in / 340 out | ~$0.0139 | $18.42 left of $20.00 (92%)
```

`@bot usage` gives the full report: a budget bar, spend this month, an estimate of how many
messages remain at your current average, token totals, per-user daily spend, and the live
rate-limit window from the `anthropic-ratelimit-*` headers.

Costs are computed from exact token counts at list prices. The authoritative balance is in
the Anthropic Console.

## Configuration

| Key | Meaning |
|---|---|
| `model` | Default `claude-opus-5`. |
| `effort` | `low`/`medium`/`high`/`xhigh`/`max`. `medium` suits chat; raise for hard code questions. |
| `maxToolSteps` | Max tool round-trips per message. |
| `maxTokens` | Output cap per call, thinking included. |
| `monthlyBudgetUsd` | Your top-up for the month. Drives the "left" figure and the hard stop. |
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

## License

MIT — see [LICENSE](LICENSE).
