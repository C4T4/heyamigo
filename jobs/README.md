# Standalone Jobs

Standalone jobs are self-contained folders under `jobs/<job-name>`.
They do not depend on Heyamigo runtime internals. Cron, launchd, systemd, or a human can run the same `job.sh`.

## Install

Default install:

```bash
curl -fsSL https://raw.githubusercontent.com/C4T4/heyamigo/main/jobs/yahoo-earnings/job.sh | bash
```

That unfolds the job into:

```text
./jobs/yahoo-earnings/
```

Install into a custom folder:

```bash
curl -fsSL https://raw.githubusercontent.com/C4T4/heyamigo/main/jobs/yahoo-earnings/job.sh \
  | bash -s -- install ./jobs/yahoo-earnings
```

Install from a different URL or branch:

```bash
curl -fsSL "$JOB_URL" | JOB_INSTALL_URL="$JOB_URL" bash
```

`JOB_INSTALL_URL` tells the streamed installer where to fetch the durable `job.sh` file from. Local installs do not need it.

## Commands

Every job exposes the same commands:

```bash
./job.sh info
./job.sh install [job-dir]
./job.sh run [job-dir] [run-id]
./job.sh help
```

Behavior:

- `curl ... | bash` installs into `./jobs/<job-name>`.
- `./job.sh` runs the job from its own folder.
- `./job.sh install ./somewhere` writes a complete copy there.
- `./job.sh run ./somewhere my-run-id` runs with an explicit folder and run id.

## After Install

Immediately after install:

```text
jobs/yahoo-earnings/
  .gitignore
  job.sh
  job.json
  runs/
```

`job.json` is the durable manifest:

```json
{
  "schema_version": 1,
  "name": "yahoo-earnings",
  "description": "Find today's earnings for main public companies on Yahoo Finance.",
  "enabled": true,
  "schedule": "0 8 * * 1-5",
  "timezone": "America/New_York",
  "runner": {
    "command": "./job.sh run",
    "agent": "claude",
    "default_model": "sonnet",
    "timeout_seconds": 1800
  },
  "browser": {
    "enabled": true,
    "cdp_url_env": "JOB_BROWSER_CDP_URL",
    "default_cdp_url": "http://127.0.0.1:9222",
    "required": true
  },
  "installer": {
    "source_url": "https://raw.githubusercontent.com/C4T4/heyamigo/main/jobs/yahoo-earnings/job.sh",
    "command": "curl -fsSL https://raw.githubusercontent.com/C4T4/heyamigo/main/jobs/yahoo-earnings/job.sh | bash"
  },
  "latest": {
    "run_id": null,
    "status": "idle",
    "updated_at": "2026-05-27T00:00:00Z",
    "summary": "Installed."
  }
}
```

## After Run

After one run:

```text
jobs/yahoo-earnings/
  .gitignore
  job.sh
  job.json
  runs/
    2026-05-27T12-00-00Z/
      prompt.md
      result.json
      output.md
      data/
        earnings.jsonl
      files/
      logs/
        claude.ndjson
        claude.stderr.log
```

`result.json` is the machine-readable source of truth:

```json
{
  "schema_version": 1,
  "job": "yahoo-earnings",
  "run_id": "2026-05-27T12-00-00Z",
  "status": "ok",
  "started_at": "2026-05-27T12:00:00Z",
  "updated_at": "2026-05-27T12:02:00Z",
  "title": "Yahoo earnings for 2026-05-27",
  "summary": "Found 12 relevant earnings rows.",
  "text": "Found 12 relevant earnings rows.",
  "files": [],
  "data": ["data/earnings.jsonl"],
  "metrics": {
    "target_date": "2026-05-27",
    "rows_seen": 80,
    "companies_included": 12,
    "source": "Yahoo Finance"
  }
}
```

Allowed terminal statuses:

- `ok`
- `failed`

Progress statuses:

- `idle`
- `started`
- `in_progress`

## Environment

Common environment variables:

```bash
TARGET_DATE=2026-05-27
JOB_BROWSER_CDP_URL=http://127.0.0.1:9222
CLAUDE_BIN=claude
CLAUDE_MODEL=sonnet
CLAUDE_EXTRA_ARGS=
IS_SANDBOX=1
```

Each job can define its own extra variables, but it should keep the base command stable.

## Cron

Cron should call the installed job:

```cron
0 8 * * 1-5 cd /path/to/heyamigo/jobs/yahoo-earnings && ./job.sh run
```

The job must not rely on cron state. It writes all state into its own folder.

## Job Contract

A standalone job must:

- Install itself from `curl ... | bash`.
- Write `job.sh`, `job.json`, `.gitignore`, and `runs/`.
- Keep every run under `runs/<run-id>/`.
- Always write `result.json`, even on failure.
- Keep logs under `runs/<run-id>/logs/`.
- Keep structured data under `runs/<run-id>/data/`.
- Keep generated attachments under `runs/<run-id>/files/`.
- Use `job.json.latest` for the latest run status.
- Be runnable without importing Heyamigo source files.

