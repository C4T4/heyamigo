#!/usr/bin/env bash
set -euo pipefail

# -----------------------------------------------------------------------------
# Job metadata
# -----------------------------------------------------------------------------

JOB_SCHEMA_VERSION=1
JOB_NAME="yahoo-earnings"
JOB_DESCRIPTION="Find today's earnings for main public companies on Yahoo Finance."
JOB_SCHEDULE="0 8 * * 1-5"
JOB_TIMEZONE="America/New_York"
JOB_BROWSER_CDP_URL_DEFAULT="http://127.0.0.1:9222"
JOB_TIMEOUT_SECONDS=1800
JOB_CLAUDE_MODEL_DEFAULT="sonnet"
JOB_INSTALL_URL_DEFAULT="https://raw.githubusercontent.com/C4T4/heyamigo/main/jobs/yahoo-earnings/job.sh"

# -----------------------------------------------------------------------------
# CLI
# -----------------------------------------------------------------------------

usage() {
  cat <<'EOF'
Usage:
  curl -fsSL https://raw.githubusercontent.com/C4T4/heyamigo/main/jobs/yahoo-earnings/job.sh | bash
  ./job.sh info
  ./job.sh install [job-dir]
  ./job.sh run [job-dir] [run-id]

Environment:
  JOB_INSTALL_URL      URL used by streamed installs to write job.sh.
  TARGET_DATE           Override date, YYYY-MM-DD. Default: today in America/New_York.
  JOB_BROWSER_CDP_URL   Browser CDP URL passed to the Claude prompt.
  CLAUDE_BIN            Claude binary. Default: claude.
  CLAUDE_MODEL          Claude model. Default: sonnet.
  CLAUDE_EXTRA_ARGS     Optional extra args appended to claude -p.
  IS_SANDBOX            Claude root bypass marker. Default: 1 for this job.
EOF
}

# -----------------------------------------------------------------------------
# Small helpers
# -----------------------------------------------------------------------------

script_path() {
  local source="${BASH_SOURCE[0]:-}"
  if [[ -n "$source" && -f "$source" ]]; then
    cd "$(dirname "$source")" && printf '%s/%s\n' "$(pwd -P)" "$(basename "$source")"
    return 0
  fi
  return 1
}

script_dir() {
  local path
  if path="$(script_path)"; then
    dirname "$path"
    return 0
  fi
  pwd -P
}

default_job_dir() {
  if script_path >/dev/null 2>&1; then
    script_dir
  else
    printf '%s/jobs/%s\n' "$(pwd -P)" "$JOB_NAME"
  fi
}

utc_now() {
  date -u +"%Y-%m-%dT%H:%M:%SZ"
}

new_run_id() {
  date -u +"%Y-%m-%dT%H-%M-%SZ"
}

target_date() {
  if [[ -n "${TARGET_DATE:-}" ]]; then
    printf '%s\n' "$TARGET_DATE"
  else
    TZ="$JOB_TIMEZONE" date +"%Y-%m-%d"
  fi
}

# -----------------------------------------------------------------------------
# Job manifests
# -----------------------------------------------------------------------------

write_info_json() {
  node <<NODE
const info = {
  schema_version: $JOB_SCHEMA_VERSION,
  name: "$JOB_NAME",
  description: "$JOB_DESCRIPTION",
  enabled: true,
  schedule: "$JOB_SCHEDULE",
  timezone: "$JOB_TIMEZONE",
  runner: {
    command: "./job.sh run",
    agent: "claude",
    default_model: "$JOB_CLAUDE_MODEL_DEFAULT",
    env: {
      IS_SANDBOX: "1"
    },
    timeout_seconds: $JOB_TIMEOUT_SECONDS
  },
  browser: {
    enabled: true,
    cdp_url_env: "JOB_BROWSER_CDP_URL",
    default_cdp_url: "$JOB_BROWSER_CDP_URL_DEFAULT",
    required: true
  },
  installer: {
    source_url: "$JOB_INSTALL_URL_DEFAULT",
    command: "curl -fsSL $JOB_INSTALL_URL_DEFAULT | bash"
  },
  output_contract: {
    result_file: "runs/<run_id>/result.json",
    output_file: "runs/<run_id>/output.md",
    data_dir: "runs/<run_id>/data",
    files_dir: "runs/<run_id>/files",
    logs_dir: "runs/<run_id>/logs"
  }
}
process.stdout.write(JSON.stringify(info, null, 2) + "\\n")
NODE
}

write_job_json() {
  local job_dir="$1"
  local status="${2:-idle}"
  local run_id="${3:-}"
  local summary="${4:-Ready.}"
  local updated_at
  updated_at="$(utc_now)"
  JOB_DIR="$job_dir" STATUS="$status" RUN_ID="$run_id" SUMMARY="$summary" UPDATED_AT="$updated_at" node <<'NODE'
const fs = require('fs')
const path = require('path')
const jobDir = process.env.JOB_DIR
const data = {
  schema_version: 1,
  name: 'yahoo-earnings',
  description: "Find today's earnings for main public companies on Yahoo Finance.",
  enabled: true,
  schedule: '0 8 * * 1-5',
  timezone: 'America/New_York',
  runner: {
    command: './job.sh run',
    agent: 'claude',
    default_model: 'sonnet',
    env: {
      IS_SANDBOX: '1'
    },
    timeout_seconds: 1800
  },
  browser: {
    enabled: true,
    cdp_url_env: 'JOB_BROWSER_CDP_URL',
    default_cdp_url: 'http://127.0.0.1:9222',
    required: true
  },
  installer: {
    source_url: process.env.JOB_INSTALL_URL || 'https://raw.githubusercontent.com/C4T4/heyamigo/main/jobs/yahoo-earnings/job.sh',
    command: `curl -fsSL ${process.env.JOB_INSTALL_URL || 'https://raw.githubusercontent.com/C4T4/heyamigo/main/jobs/yahoo-earnings/job.sh'} | bash`
  },
  latest: {
    run_id: process.env.RUN_ID || null,
    status: process.env.STATUS,
    updated_at: process.env.UPDATED_AT,
    summary: process.env.SUMMARY
  }
}
fs.writeFileSync(path.join(jobDir, 'job.json'), JSON.stringify(data, null, 2) + '\n')
NODE
}

write_result_json() {
  local result_file="$1"
  local status="$2"
  local title="$3"
  local summary="$4"
  local text="$5"
  local error_message="${6:-}"
  RESULT_FILE="$result_file" STATUS="$status" TITLE="$title" SUMMARY="$summary" TEXT="$text" ERROR_MESSAGE="$error_message" node <<'NODE'
const fs = require('fs')
const path = require('path')
const resultFile = process.env.RESULT_FILE
const result = {
  schema_version: 1,
  job: 'yahoo-earnings',
  run_id: process.env.RUN_ID || path.basename(path.dirname(resultFile)),
  status: process.env.STATUS,
  started_at: process.env.STARTED_AT || new Date().toISOString(),
  updated_at: new Date().toISOString(),
  title: process.env.TITLE,
  summary: process.env.SUMMARY,
  text: process.env.TEXT,
  files: [],
  data: [],
  metrics: {}
}
if (process.env.ERROR_MESSAGE) {
  result.error = { message: process.env.ERROR_MESSAGE }
}
fs.mkdirSync(path.dirname(resultFile), { recursive: true })
fs.writeFileSync(resultFile, JSON.stringify(result, null, 2) + '\n')
NODE
}

# -----------------------------------------------------------------------------
# Install
# -----------------------------------------------------------------------------

install_job() {
  local job_dir="${1:-$(default_job_dir)}"
  local source_path=""
  local source_url="${JOB_INSTALL_URL:-$JOB_INSTALL_URL_DEFAULT}"
  mkdir -p "$job_dir"
  job_dir="$(cd "$job_dir" && pwd)"
  mkdir -p "$job_dir/runs"

  if source_path="$(script_path 2>/dev/null)"; then
    if [[ "$source_path" != "$job_dir/job.sh" ]]; then
      cp "$source_path" "$job_dir/job.sh"
    fi
  else
    if ! command -v curl >/dev/null 2>&1; then
      printf 'curl is required to install streamed job scripts.\n' >&2
      exit 1
    fi
    curl -fsSL "$source_url" -o "$job_dir/job.sh"
  fi

  chmod +x "$job_dir/job.sh"
  if [[ ! -f "$job_dir/.gitignore" ]]; then
    printf 'runs/\n.playwright-mcp/\n' > "$job_dir/.gitignore"
  fi
  write_job_json "$job_dir" "idle" "" "Installed."
  printf 'Installed %s in %s\n' "$JOB_NAME" "$job_dir"
}

# -----------------------------------------------------------------------------
# Claude prompt
# -----------------------------------------------------------------------------

build_prompt() {
  local job_dir="$1"
  local run_id="$2"
  local run_dir="$3"
  local date="$4"
  local cdp_url="$5"

  cat <<EOF
You are running the standalone job "$JOB_NAME".

Use the browser. Open Yahoo Finance's earnings calendar for ${date}:
https://finance.yahoo.com/calendar/earnings?day=${date}

Browser:
- Use any available browser/Playwright tooling.
- Prefer the shared Chrome CDP endpoint if available: ${cdp_url}
- If browser access is unavailable, write a failed result. Do not silently fall back to guessing.

Job folder:
${job_dir}

Run folder:
${run_dir}

You must write these files:
- ${run_dir}/result.json
- ${run_dir}/output.md
- ${run_dir}/data/earnings.jsonl

Task:
Find today's earnings shares for main public companies on Yahoo Finance.
Focus on public companies with meaningful market cap. Prefer the largest market caps and well-known companies.
Collect up to 15 relevant rows.

For each row, capture:
- symbol
- company
- event name
- earnings call time
- EPS estimate
- reported EPS
- surprise percent
- market cap
- source URL

Write ${run_dir}/data/earnings.jsonl as one JSON object per line.
Write ${run_dir}/output.md as the short human-readable brief.

Write ${run_dir}/result.json with this exact shape:
{
  "schema_version": 1,
  "job": "$JOB_NAME",
  "run_id": "$run_id",
  "status": "ok",
  "started_at": "<ISO timestamp>",
  "updated_at": "<ISO timestamp>",
  "title": "Yahoo earnings for ${date}",
  "summary": "<one sentence>",
  "text": "<same message to deliver>",
  "files": [],
  "data": ["data/earnings.jsonl"],
  "metrics": {
    "target_date": "${date}",
    "rows_seen": 0,
    "companies_included": 0,
    "source": "Yahoo Finance"
  }
}

If you cannot produce reliable data, set "status" to "failed", explain the failure in "summary", "text", and "error.message", and still write result.json.
Keep the final Claude response short. The files are the source of truth.
EOF
}

# -----------------------------------------------------------------------------
# Run
# -----------------------------------------------------------------------------

run_job() {
  local job_dir="${1:-$(default_job_dir)}"
  local run_id="${2:-$(new_run_id)}"
  mkdir -p "$job_dir"
  job_dir="$(cd "$job_dir" && pwd)"
  local run_dir="$job_dir/runs/$run_id"
  local logs_dir="$run_dir/logs"
  local data_dir="$run_dir/data"
  local files_dir="$run_dir/files"
  local result_file="$run_dir/result.json"
  local output_file="$run_dir/output.md"
  local date
  local cdp_url
  local started_at

  date="$(target_date)"
  cdp_url="${JOB_BROWSER_CDP_URL:-$JOB_BROWSER_CDP_URL_DEFAULT}"
  started_at="$(utc_now)"

  mkdir -p "$logs_dir" "$data_dir" "$files_dir"
  write_job_json "$job_dir" "started" "$run_id" "Run started for $date."
  RUN_ID="$run_id" STARTED_AT="$started_at" write_result_json "$result_file" "started" "Yahoo earnings for $date" "Run started." "" ""

  build_prompt "$job_dir" "$run_id" "$run_dir" "$date" "$cdp_url" > "$run_dir/prompt.md"
  write_job_json "$job_dir" "in_progress" "$run_id" "Claude is collecting Yahoo Finance earnings for $date."
  RUN_ID="$run_id" STARTED_AT="$started_at" write_result_json "$result_file" "in_progress" "Yahoo earnings for $date" "Claude is collecting Yahoo Finance earnings." "" ""

  local claude_bin="${CLAUDE_BIN:-claude}"
  local claude_model="${CLAUDE_MODEL:-$JOB_CLAUDE_MODEL_DEFAULT}"
  local -a args=(-p --verbose --output-format stream-json --dangerously-skip-permissions --add-dir "$run_dir")
  args+=(--model "$claude_model")
  if [[ -n "${CLAUDE_EXTRA_ARGS:-}" ]]; then
    # shellcheck disable=SC2206
    args+=($CLAUDE_EXTRA_ARGS)
  fi

  set +e
  (cd "$job_dir" && IS_SANDBOX="${IS_SANDBOX:-1}" "$claude_bin" "${args[@]}") < "$run_dir/prompt.md" > "$logs_dir/claude.ndjson" 2> "$logs_dir/claude.stderr.log"
  local claude_status=$?
  set -e

  RESULT_FILE="$result_file" OUTPUT_FILE="$output_file" CLAUDE_STATUS="$claude_status" RUN_ID="$run_id" STARTED_AT="$started_at" node <<'NODE'
const fs = require('fs')
const path = require('path')
const resultFile = process.env.RESULT_FILE
const outputFile = process.env.OUTPUT_FILE
const claudeStatus = Number(process.env.CLAUDE_STATUS || 0)

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return null }
}

function writeFailed(message) {
  const result = {
    schema_version: 1,
    job: 'yahoo-earnings',
    run_id: process.env.RUN_ID,
    status: 'failed',
    started_at: process.env.STARTED_AT,
    updated_at: new Date().toISOString(),
    title: 'Yahoo earnings failed',
    summary: message,
    text: `Yahoo earnings job failed: ${message}`,
    files: [],
    data: [],
    metrics: {},
    error: { message }
  }
  fs.writeFileSync(resultFile, JSON.stringify(result, null, 2) + '\n')
  fs.writeFileSync(outputFile, result.text + '\n')
  return result
}

const result = readJson(resultFile)
if (!result || !['ok', 'failed'].includes(result.status)) {
  writeFailed(claudeStatus === 0
    ? 'Claude finished without writing a final ok/failed result.json.'
    : `Claude exited with status ${claudeStatus}.`)
} else {
  if (!fs.existsSync(outputFile) && result.text) {
    fs.writeFileSync(outputFile, result.text + '\n')
  }
}
NODE

  local final_status
  final_status="$(node -e "const r=require(process.argv[1]); console.log(r.status)" "$result_file")"
  local summary
  summary="$(node -e "const r=require(process.argv[1]); console.log(r.summary || r.title || r.status)" "$result_file")"
  write_job_json "$job_dir" "$final_status" "$run_id" "$summary"

  printf '%s\n' "$result_file"
}

# -----------------------------------------------------------------------------
# Entrypoint
# -----------------------------------------------------------------------------

cmd="${1:-}"
if [[ -z "$cmd" ]]; then
  if script_path >/dev/null 2>&1; then
    cmd="run"
  else
    cmd="install"
  fi
fi
case "$cmd" in
  info)
    write_info_json
    ;;
  install)
    shift
    install_job "${1:-$(default_job_dir)}"
    ;;
  run)
    shift
    run_job "${1:-$(default_job_dir)}" "${2:-}"
    ;;
  help|-h|--help)
    usage
    ;;
  *)
    printf 'Unknown command: %s\n\n' "$cmd" >&2
    usage >&2
    exit 2
    ;;
esac
