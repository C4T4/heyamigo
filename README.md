<p align="center">
  <img src="assets/heyamigo-premium-clean.jpg" alt="Heyamigo" width="100%">
</p>

# heyamigo

A chat-resident assistant for WhatsApp and Telegram. Claude, Codex, or Grok under the hood, durable SQLite queues, per-sender timezone scheduling, two-track architecture so browser work never blocks the chat.

```
WhatsApp / Telegram ─► inbound ─► chat workers ─► outbound ─► WhatsApp / Telegram
                                     │                ▲
                                     ├──────► async / browser ─┤
                                     └──────► memory_writes ───┘
```

## What it does

- **Long-term memory per person, per chat, per topic.** Files on disk. The agent decides what's worth keeping; background workers consolidate while you're not chatting.
- **A relevance watchlist.** Open loops the agent tracks on your behalf — questions you'd forget, things you're waiting on — surfaced naturally when the moment matches. Built like external working memory for the user.
- **Scheduling in the sender's timezone.** Natural language → `[REMIND: 2026-05-26 09:00 — ...]` or `[CRON: 0 9 * * 1 PROMPT — ...]`. Fires at the user's wall-clock 9am, not the server's. Cron variants: deliver text, run AI, kick off async work, or drive a browser.
- **A real Chrome.** Browser delegation via `[ASYNC-BROWSER: ...]` to a parallel provider session on a shared logged-in Chrome over CDP. TikTok, Instagram, anywhere the owner is logged in. SSH-tunneled noVNC for setup.
- **Per-reply footer with confirmation tags.** Every side effect from the turn is visible: `_9.9s · 465k↑ 169↓ · +remind · +thread-new · +digest_`. No guessing whether a schedule actually got created.
- **Default-deny proactive messaging.** Groups stay silent unless explicitly opted in. Per-role token quotas, file-size caps, tool restrictions.

For the why behind these — claim primitives, tag-as-side-effect channel, per-category learning, provider abstraction, the trade-offs that didn't survive the first revision — see [`docs/architecture.md`](docs/architecture.md).

## Quick start

```bash
npm install -g @anthropic-ai/claude-code
claude                                  # log in once, then exit

npx @c4t4/heyamigo setup                # wizard: pair WhatsApp, pick personality
npx @c4t4/heyamigo start                # background, auto-restart
npx @c4t4/heyamigo logs                 # tail
```

Telegram is optional. Create a bot with BotFather, set `telegram.enabled: true` and `telegram.botToken` in `config/config.json`, then allow users/groups in `config/access.json`. Telegram user keys use `tg_<user_id>`; Telegram group entries use addresses like `tg:group:-1001234567890`.

Other providers:

- Codex: install `@openai/codex` and set `ai.provider: "codex"` in `config/config.json`.
- Grok Build: install with `curl -fsSL https://x.ai/cli/install.sh | bash`, run `grok login`, and set `ai.provider: "grok"`.

## In-chat commands

| Command | What it does |
|---|---|
| `/reset` | Fresh AI session for this chat |
| `/status` | Session info, context utilization |
| `/queues` | Live queue depths |
| `/crons` · `/reminders` | List recurring schedules + one-shots (token cost included) |
| `/threads` | List the relevance watchlist; resolve / drop / pause / weight |
| `/digest` | Force a memory consolidation now |

## Roles

`config/access.json`. Three default roles, easily extended.

| Role | Memory | Tools | Notes |
|---|---|---|---|
| admin | everything | all | unrestricted |
| user | own profile | none | can't see other users or internals |
| guest | none | none | prompt-injection resistant |

## Personalities

`config/personalities/*.md` — system-prompt fragments that define the bot's voice. The default (`sharp.md`) is opinionated about not people-pleasing. Swap or write your own.

## Where to run it

A VPS (Hetzner, DO) at ~$5/mo is the path of least resistance. Home server or Raspberry Pi also fine. Needs Node 18+, a persistent filesystem, and outbound access to the enabled chat channels. Not serverless-compatible.

## Tracking memory with git

The bot writes markdown files under `storage/memory/` as it learns. `git init` in your project root and commit periodically gives you a readable diff of what the assistant has come to believe about people and topics. Skip `storage/auth/` (WhatsApp keys) and `storage/logs/`.

## License

MIT. Built by [Catalin Waack](https://github.com/C4T4) · [LinkedIn](https://www.linkedin.com/in/catalinwaack/).
