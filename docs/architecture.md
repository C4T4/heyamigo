# Architecture notes

A chat-resident assistant for WhatsApp and Telegram on top of Claude, Codex, or Grok. The interesting parts are not the LLM calls themselves — those are well-trodden territory — but everything around them: how messages flow, how state survives restarts, how schedules fire in the right timezone, how the agent's reply text becomes durable side effects.

This document is a curated set of design notes. The ones that earned their place because the alternative didn't survive contact with real use.

## Mental model

```
WhatsApp (Baileys) / Telegram (Bot API)
   │
   ▼
inbound (sqlite)  ──── per-address claim ────►  chat workers (N)
                                                    │
                          ┌─────────────────────────┼──────────────────┐
                          ▼                         ▼                  ▼
                    outbound (sqlite)         async / browser     memory_writes
                          │                    (own lanes)         (digests,
                          ▼                                         journals,
                    channel send                                    threads)
```

Every queue is a SQLite table. The orchestrator's heartbeat polls due rows; workers claim atomically via `UPDATE ... RETURNING` with a `claimed_by` safety check. A row only leaves the queue when its idempotency key is recorded against the side effect, so retries don't duplicate.

Chat workers preserve per-chat reply order. The claim filter ignores any row whose address has another row already in-flight, so worker N+1 picks a different chat instead of cutting the line on chat M. Net effect: N chats can be processed in parallel without ever interleaving replies within one chat.

## The agent reply is a side-effect channel

The user-visible text is one output; the rest of the reply is structured tags the agent appends. They get parsed off the tail and dispatched.

```
"Got it, I'll check in tomorrow morning."
[REMIND: 2026-05-26 09:00 — check in about the meeting]
[THREAD-NEW: title="Jana meeting confirm" summary="waiting on Tue confirmation" hotness=70]
[DIGEST: meeting with Jana pending confirmation]
```

The tag parser walks brackets right-to-left tracking depth (a regex would terminate on inner `]` and silently drop payloads that contain brackets — that bug shipped to users and got fixed). After parsing, the worker routes each tag to its handler: scheduling, async/browser delegation, memory writes, journal updates, thread state transitions.

Each tag emitted is surfaced in the reply footer so the user sees confirmation in real time:

```
_9.9s · 465k↑ (230k cached) 169↓ · +remind · +thread-new · +digest_
```

Without that surface, "did my reminder actually get scheduled?" turns into a 35-minute waiting game. With it, the answer arrives in the same message.

## Per-sender timezone, propagated everywhere

Owners message from one timezone; their friends and coworkers message from others. "Remind me at 9am" means the SENDER's 9am, not the server's.

Every cron row carries an IANA tz column. The agent's preamble shows the current local time in the sender's tz, so the agent's translation of "tomorrow morning" → `[REMIND: 2026-05-26 09:00 — ...]` resolves correctly without further conversion. The cron dispatcher uses [croner](https://github.com/Hexagon/croner) for standard 5-field POSIX expressions with timezone-aware DST math, plus a custom `@every Nu` parser for sub-minute shorthand.

`persons.timezone` carries per-identity overrides, fallback to `config.owner.timezone`. The lookup is one function — `getTimezoneForSenderNumber` — called wherever scheduling touches user time.

## Cron variants

A recurring schedule isn't just "deliver text at time T." It can be one of four behaviors per firing, picked by a verb in the tag:

| Verb | What fires | Cost |
|---|---|---|
| `SAY` | Body delivered verbatim to chat | free |
| `PROMPT` | Body fed to the AI as if the user typed it | 1 inference |
| `ASYNC` | Body kicked off as a background async task | 1 inference + tools |
| `BROWSER` | Body kicked off as a browser task on shared Chrome | 1 inference + Playwright |

Each cron row carries `fire_count`, `total_input_tokens`, `total_output_tokens`. The `/crons` chat command shows running token cost per schedule, so the user can identify expensive recurring inferences and pause them. Token attribution is propagated via a `cronId` field on the synthesized job; the worker calls `addCronUsage(cronId, in, out)` after the AI run completes.

## Two-track architecture

The chat track answers in real time. Browser work — anything touching Playwright / `mcp__*playwright*` tools — is always delegated to a parallel provider session via an `[ASYNC-BROWSER: <task>]` tag.

```
chat reply ──── [ASYNC-BROWSER: ...] ────► browser_tasks (sqlite)
                                                │
                                                ▼
                                       browser worker pool
                                                │
                                                ▼
                                       shared Chrome (CDP, :9222)
                                       with owner's sessions
                                       (TikTok, IG, etc.) logged in
                                                │
                                                ▼
                                       result message back to chat
```

The shared-Chrome model means the bot doesn't have to re-authenticate to social sites every task. The owner logs in once via noVNC over an SSH tunnel; sessions persist on disk. Browser tasks land back in the originating chat through the same outbound queue, with idempotency keys so retries don't double-post.

The split is enforced in the system prompt + tag grammar. The agent never has direct browser tool access; if it tries, the tool call simply isn't available. The `[ASYNC-BROWSER:]` tag is the only path.

## Threads — relevance between cold memory and conversation

A new layer (v0.10): an AI-curated watchlist of currently load-bearing context. Open loops the user mentioned in passing that have a future resolution point.

```
Cold memory:  journals, profiles, buckets        (mostly dormant)
[State]:      compressed index, regenerated      (backward-looking)
[Live threads]: AI-curated active loops          (forward-looking)
Conversation: current chat turn                   (now)
```

The agent maintains threads via tags (`[THREAD-NEW|UPDATE|TOUCH|COOL|RESOLVE|DROP|COMPRESS|WEIGHT]`). Each thread has hotness 0-100, learned per-category weights so future threads in topics the owner cares about start hotter. User voice always wins: explicit `/threads` commands and RESOLVE/DROP tags override anything the AI inferred.

The model replaces a predicate-based subsystem (silence detection on journal entries, flat-file state) that had a class of `Invalid time value` crashes from corrupt JSON. The AI is the predicate; the table holds the watchlist; the orchestrator dispatches reviews.

## Memory layers

```
storage/memory/
  index.md, compressed.md          master + rolling snapshot
  buckets/<slug>/index.md          topical knowledge
  persons/<phone>/profile.md       per-person facts, preferences, patterns
  chats/<jid>/brief.md             per-chat purpose, tone, recent topics
  journals/<slug>/entries.jsonl    append-only tracked topics
```

`compressed.md` is the rolling state — one to three lines per entity, regenerated after digests. It's an index, not a summary. The agent reads it every turn to know what exists, then reads the full file on demand when going deep on a topic.

A `[DIGEST: <reason>]` tag on the agent's reply triggers a debounced background pass that consolidates the recent conversation into the relevant profile/brief/bucket. Debounce coalesces rapid-fire flags into a single update.

## Multi-provider

Claude, Codex, and Grok Build implement the same `AiProvider` interface. Swap via `config.ai.provider`. Sessions persist across model switches (the session-id mapping is provider-aware). Cumulative-vs-per-turn token reporting differs by provider — Claude and Grok report per-turn when available, Codex reports cumulative — handled in the worker with a `usageReportingMode` discriminator + delta math. Without that, the context % footer reads `7018% ctx` and the user loses trust.

## Defaults that bias toward not-broken

- **Proactive messaging defaults to off.** Groups stay silent unless `proactive: true` is explicitly set in `access.json`. The bot never volunteers a message into a group it wasn't invited into the conversation of.
- **Per-role token quotas.** Each user role has a daily token cap. Once exceeded, replies are dropped silently (logged, not announced).
- **Per-role file-size caps.** Inbound media over the role's MB limit is rejected before download.
- **Sessions survive provider swaps.** If you switch between Claude, Codex, and Grok mid-stream, existing sessions stay dormant under their provider key rather than vanishing.
- **Schema migrations through drizzle-kit, never direct DDL.** A schema-drift detector at boot warns when the live SQLite shape diverges from the codebase's expectations.
- **WAL mode + Litestream-friendly.** Database lives on a single durable volume; remote replication is configured but optional.

## Job estimation

Before a job starts, the user sees an ETA. The estimator is a plugin registry (`src/estimates/*.ts`) — each plugin recognizes a job kind from message content, returns an estimate from past samples. First-time kinds use the single available sample; later runs converge to the running average.

```
"can you scrape these 5 IG profiles?"
   ↓
estimator: 'browser-scrape', n=12, avg=185s
   ↓
ack sent to chat: "On it. ~3 min."
```

The estimate ack hits the chat before the AI even starts processing the message, via the outbound queue. The user gets a timeline immediately; the agent's reply arrives when ready.

## Observability

- `/queues` shows live queue depths per kind.
- `/crons` lists recurring schedules with fire counts and accumulated token cost.
- `/threads` lists the live watchlist with hotness and per-category learning state.
- `/status` shows the current provider session's context utilization.
- Per-reply footer surfaces every emitted tag (`+remind`, `+browser`, `+thread-new`, etc).
- Structured pino logs are queryable; long-running prompts are retained on disk for replay (`promptlog`).

## Trade-offs the codebase deliberately made

- **SQLite, not Redis.** The bot is a single-process workload with durable-by-default semantics. SQLite with WAL gives us atomic claims, durable rows, and Litestream replication for the price of zero infrastructure. A queue layer would have been overkill.
- **Tags as the side-effect channel, not tool calls.** The agent emits side effects as text. This works across providers (Claude, Codex, and Grok see the same grammar), survives provider tool-schema differences, and gives us a parseable record per turn. Trade-off: the agent has to be coaxed into using the grammar reliably — that's what the system prompt + per-turn `[Live threads]` / scheduling reminders are for.
- **Address-bound everything.** Every queue row carries the target JID. Reminders fire to the chat where they were created. Threads belong to a chat. Schedules respect the per-chat proactive gate. No row floats free.
- **Personality as a separate file.** The bot's voice is a markdown file loaded into the system prompt. The default ("sharp") is opinionated about not people-pleasing, not hedging, not opening with validation. Swap or write your own for a different voice.
- **No metrics dashboard. Yet.** The footer + `/queues` + `/crons` + `/threads` are the visible state. A real dashboard makes sense once volume warrants it; for personal-bot scale, the chat itself is the dashboard.

## Where things live

| Concern | Module |
|---|---|
| Queue tables, schema | `src/db/schema.ts`, `migrations/` |
| Queue dispatch | `src/queue/*.ts` |
| AI providers | `src/ai/{claude,codex,grok,provider}.ts` |
| Tag parsing | `src/memory/digest-flag.ts` |
| Memory layers | `src/memory/{store,router,compressed,journals}.ts` |
| Preamble assembly | `src/memory/preamble.ts` |
| Threads watchlist | `src/queue/{threads,thread-weights,thread-list}.ts` |
| Two-track / browser | `src/queue/browser-tasks.ts` + Playwright MCP |
| Per-role gates | `src/wa/whitelist.ts` |
| Estimation plugins | `src/estimates/*.ts` |
| Outbound + footer | `src/gateway/outgoing.ts` |

If you want to read one file to understand the system: `src/queue/worker.ts`. It's the per-turn pipeline from inbound row to outbound + side effects, ~400 lines.
