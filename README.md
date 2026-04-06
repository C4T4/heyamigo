# heyamigo

> It remembers. It learns. It gets better while you sleep.

heyamigo lives in your WhatsApp. It meets people and builds a mental model of each one. It picks up on what matters and forgets what doesn't. It organizes what it knows the way you would, by person, by project, by topic. It browses the web, reads what you send it, sees images, and connects the dots across conversations you had weeks apart.

Between chats, it processes. Background workers compress raw experience into understanding. Short-term becomes long-term. Noise becomes signal. The next time you talk, it's not starting from scratch. It's starting from everything it's learned.

It runs on your Claude subscription. No API keys, no third-party services. One command to set up.

---

## Why this exists

Most AI tools try to be everything. heyamigo tries to be one thing well: **the AI you actually want in your group chat.**

Something simple you can talk to, ask things, share stuff with, and that gets better the more you use it.

Anthropic changed how third-party apps consume your Claude usage. Third-party tools now draw from extra usage, not your plan limits. heyamigo is **first-party**: it runs through Claude CLI, your direct Claude subscription. No middlemen, no extra costs.

---

## What it does

### Talks on WhatsApp
Groups and DMs. Mention its name to get a reply: "amigo what do you think?" or "claude check this". Stays quiet when not mentioned. Replying to one of its messages also triggers a response. Handles text, images, videos, documents, voice messages.

### Builds a profile for every person it talks to
Not a chat log. A structured profile.

After 20 conversations it knows your partner prefers short replies, your coworker only responds to direct questions, and your friend is lactose intolerant. Facts, preferences, patterns, accumulated over time. Each person's profile grows independently, whether they talk in a group or a DM.

### Organizes what it knows into buckets
People, projects, topics, each in their own folder with an index.

Ask about a project and it pulls that project's brief. Ask about a person and it pulls their profile. It doesn't shove everything into one giant prompt. Only the relevant buckets load per message. The rest stays on disk, accessible when needed.

### Amigo decides what's worth remembering
Most bots store everything or nothing.

This one lets the AI flag moments during conversation. You mention you're moving to Berlin next month, it flags it. Your profile gets updated. You send "lol", nothing happens. The signal-to-noise ratio improves over time because the AI itself is curating what matters.

### Processes what happened while you're not chatting
Raw conversations sit in short-term memory. Between chats, background workers compress them into long-term profiles and topic summaries.

Like how your brain consolidates memories during sleep. The bot processes while idle, so the next conversation starts with better context than the last one ended with.

### Imports what you already have
Got a messy folder of notes, project docs, or an existing AI workspace? Point amigo at it. It reads through everything, distills the useful stuff, and organizes it into structured buckets (people, projects, topics). Your unstructured knowledge becomes searchable context that amigo references in every conversation. One command: `heyamigo import ~/my-notes`

### Browses the web
Controls a real Chrome browser. Navigates pages, takes screenshots, sends them back to WhatsApp. You can watch it browse via SSH tunnel.

---

## Quick start

### 1. Install Claude CLI and log in

```bash
npm install -g @anthropic-ai/claude-code
claude
```

Run `claude` and follow the login instructions. After logging in, exit claude and run `npx @c4t4/heyamigo setup` again. You need an [Anthropic account](https://console.anthropic.com). The bot runs on your Claude subscription — no API keys needed.

### 2. Clone and set up

```bash
git clone https://github.com/C4T4/heyamigo.git
cd heyamigo
npm install
npm run setup
```

The wizard handles the rest:
- WhatsApp pairing (QR code + pairing code)
- Browser setup (optional)
- Personality selection
- Knowledge import (optional)

Then:

```bash
heyamigo start
```

That's it. Runs in the background, auto-restarts on crash, survives SSH disconnect.

---

## Commands

```
npx @c4t4/heyamigo setup           # setup wizard
npx @c4t4/heyamigo start           # start (background, auto-restart)
npx @c4t4/heyamigo stop            # stop
npx @c4t4/heyamigo restart         # restart
npx @c4t4/heyamigo logs            # tail live logs
npx @c4t4/heyamigo status          # check if running
npx @c4t4/heyamigo update          # update to latest version
npx @c4t4/heyamigo import <path>   # import knowledge folder
npx @c4t4/heyamigo dev             # foreground (development)
```

### In-chat commands

| Command | What it does |
|---------|-------------|
| `/reset` | Fresh Claude session |
| `/status` | Session info + context usage % |
| `/reload` | Re-read personality |
| `/digest` | Force memory update |

---

## Memory

Three layers, inspired by how brains work:

```
Short-term      raw messages (JSONL per chat)
Working memory  Claude session (--resume)
Long-term       profiles, topics, project briefs
```

```
storage/memory/
  buckets/       projects, topics (imported or auto-created)
  persons/       per-person profiles (grow over time)
  chats/         per-chat briefs
```

### How memory updates

The bot updates memory in two ways:

**Real-time (DIGEST flag):** During a conversation, Claude decides if something is worth remembering (a preference, fact, life event). It appends a hidden `[DIGEST: reason]` tag to its reply, which gets stripped before sending. This triggers a background digest within 2 minutes that updates the person's profile and the chat brief.

**Background sweep:** Every 3 hours, the bot checks all active chats for new messages that weren't flagged. This catches anything Claude missed. You can also force an immediate update with the `/digest` command in chat.

Memory is stored as plain markdown files. You can read, edit, or delete them directly.

---

## Roles

Defined in `config/access.json`.

| Role | Memory | Tools | Boundary |
|------|--------|-------|----------|
| **admin** | everything | all | unrestricted |
| **user** | own profile | web search | can't see other users or internals |
| **guest** | own profile | none | locked down, prompt-injection resistant |

---

## Browser

Optional. Chrome via CDP. You watch via noVNC over SSH tunnel. Setup wizard handles install.

```
You (SSH tunnel)  ->  noVNC  ->  Chrome  <-  Claude (CDP)
```

All localhost. Nothing public.

---

## Personalities

Three built-in:

[**Sharp**](config/personalities/sharp.md) (default)
Talks like a smart friend at dinner. Specific, confident, never vague. Won't hedge, won't lecture, won't sound like a brochure. Calls things out when they're obvious, meets people where they actually are. Checks every reply against: would I be embarrassed saying this out loud?

[**Casual**](config/personalities/casual.md)
Warm, relaxed, friend-over-coffee energy. Short messages, matches your vibe.

[**Professional**](config/personalities/professional.md)
Clear, efficient, business-appropriate. Gets to the answer fast.

Create your own: add a `.md` file to `config/personalities/`, point `config.json` at it.

---

## Configuration

### config/config.json

Core settings. The wizard sets these up, but you can edit anytime.

```json
{
  "owner": { "number": "17861234567" },
  "triggers": { "aliases": ["heyamigo", "amigo", "claude"], "groupMode": "mention" },
  "claude": { "model": "claude-opus-4-6", "timeoutMs": 60000 },
  "reply": { "quoteInGroups": true, "typingIndicator": true }
}
```

### config/access.json

Who can use the bot and what they can do. See `access.example.json` for all options.

```json
{
  "users": {
    "17861234567": { "role": "admin", "name": "Alice" },
    "491701234567": { "role": "user", "name": "Carlos" }
  },
  "groups": [
    { "jid": "120363xxx@g.us", "name": "Family", "mode": "active", "allowedSenders": "*" },
    { "jid": "120363yyy@g.us", "name": "Work", "mode": "active", "allowedSenders": ["17861234567"] }
  ],
  "dms": {
    "defaultMode": "off",
    "allowed": [{ "number": "491701234567", "mode": "active" }]
  }
}
```

Groups auto-discover with `mode: "off"` when the bot first sees a message. Flip to `"active"` to enable.

### Other files

| File | Purpose |
|------|---------|
| `config/personalities/*.md` | System prompts (sharp, casual, professional) |
| `.claude/settings.json` | Tool permissions for Claude CLI |

---

## Where to run it

Needs a persistent filesystem and a long-running process.

| Option | Cost | Notes |
|--------|------|-------|
| **VPS** (Hetzner, DigitalOcean) | ~$5/mo | Recommended. Setup wizard just works. |
| **Home server / Raspberry Pi** | One-time | Always-on device at home. |
| **Your laptop** | Free | For testing. Bot stops when laptop sleeps. |
| **Cloud** (Railway, Fly) | Varies | Needs persistent volumes. No interactive setup. |

Not compatible with serverless (Lambda, Vercel). Needs a persistent WebSocket connection.

---

## Requirements

- Node.js 18+
- [Claude CLI](https://docs.anthropic.com/en/docs/claude-code) (`npm install -g @anthropic-ai/claude-code`) + Anthropic account
- A WhatsApp account
- **macOS or Linux** (Windows: use WSL)

---

## Tracking memory with git

The bot updates files in `storage/memory/` over time as it learns. We recommend tracking your project with git so you can see what changed and roll back if needed.

```bash
cd ~/heyamigo
git init
echo "storage/auth/" >> .gitignore
echo "storage/logs/" >> .gitignore
git add -A && git commit -m "initial setup"
```

Never commit `storage/auth/` — it contains your WhatsApp session keys.

---

## Security

- `storage/auth/` contains your WhatsApp session keys. Guard them.
- All ports bind to localhost. Nothing exposed publicly.
- Baileys is an unofficial WhatsApp protocol. Use at your own risk.
- Role restrictions are prompt-enforced. Strong but not bulletproof.
- Outgoing media auto-deleted after sending.

---

## License

MIT - Built by [Catalin Waack](https://github.com/C4T4) · [LinkedIn](https://www.linkedin.com/in/catalinwaack/)

If you use heyamigo in your project or build something on top of it, a mention or link back is appreciated.
