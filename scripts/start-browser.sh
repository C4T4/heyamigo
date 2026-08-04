#!/usr/bin/env bash
set -euo pipefail

# ─── Chrome + noVNC for shared browser control ─────────────────
#
# Chrome with remote debugging (CDP) on localhost.
# noVNC for human viewing via SSH tunnel.
# Nothing exposed publicly.
#
# Usage:
#   ./scripts/start-browser.sh           # start all
#   ./scripts/start-browser.sh stop      # stop all
#   ./scripts/start-browser.sh status    # check what's running
#
# Ports (configurable via env):
#   CDP_PORT   = 9222  (Chrome remote debugging)
#   VNC_PORT   = 5900  (x11vnc)
#   NOVNC_PORT = 6090  (noVNC web client)

CDP_PORT="${CDP_PORT:-9222}"
VNC_PORT="${VNC_PORT:-5900}"
NOVNC_PORT="${NOVNC_PORT:-6090}"
DISPLAY_NUM="${DISPLAY_NUM:-99}"
RESOLUTION="${RESOLUTION:-1920x1080x24}"
VNC_PROFILE="${HOME}/.config/google-chrome-novnc"
CHROME_LOG="${CHROME_LOG:-${PWD}/storage/logs/chrome.log}"
CHROME_BIN="${CHROME_BIN:-}"
CHROME_START_URL="${CHROME_START_URL:-about:blank}"

export DISPLAY=":${DISPLAY_NUM}"

# ─── Helpers ────────────────────────────────────────────────────
RED='\033[0;31m'
GREEN='\033[0;32m'
NC='\033[0m'
ok()   { echo -e "${GREEN}[ok]${NC}    $*"; }
fail() { echo -e "${RED}[fail]${NC}  $*"; }

find_chrome() {
  if [ -n "${CHROME_BIN}" ]; then
    if command -v "${CHROME_BIN}" &>/dev/null; then
      command -v "${CHROME_BIN}"
      return
    fi
    return 1
  fi
  for bin in google-chrome google-chrome-stable chromium-browser chromium; do
    if command -v "$bin" &>/dev/null; then
      echo "$bin"
      return
    fi
  done
}

find_novnc_proxy() {
  for p in /usr/share/novnc /usr/share/novnc/utils /usr/local/share/novnc /snap/novnc/current; do
    for f in "$p/utils/novnc_proxy" "$p/novnc_proxy" "$p/utils/launch.sh"; do
      if [ -f "$f" ]; then echo "$f"; return; fi
    done
  done
}

is_running() { pgrep -f "$1" &>/dev/null; }

managed_chrome_pids() {
  local proc_dir exe cmdline
  for proc_dir in /proc/[0-9]*; do
    [ -r "${proc_dir}/cmdline" ] || continue
    exe="$(readlink "${proc_dir}/exe" 2>/dev/null || true)"
    case "${exe##*/}" in
      *chrome*|*chromium*) ;;
      *) continue ;;
    esac
    cmdline="$(tr '\0' '\n' < "${proc_dir}/cmdline" 2>/dev/null || true)"
    if grep -Fqx -- "--remote-debugging-port=${CDP_PORT}" <<<"${cmdline}" &&
       grep -Fqx -- "--user-data-dir=${VNC_PROFILE}" <<<"${cmdline}"; then
      echo "${proc_dir##*/}"
    fi
  done
}

# ─── Stop ───────────────────────────────────────────────────────
do_stop() {
  echo "Stopping browser stack..."
  local chrome_pids
  chrome_pids="$(managed_chrome_pids)"
  if curl -s "http://localhost:${CDP_PORT}/json/version" &>/dev/null && [ -z "${chrome_pids}" ]; then
    fail "CDP :${CDP_PORT} belongs to an unknown Chrome profile; refusing to stop it"
    return 1
  fi
  if [ -n "${chrome_pids}" ]; then
    while IFS= read -r pid; do
      kill "${pid}" 2>/dev/null || true
    done <<<"${chrome_pids}"
  fi
  pkill -f "websockify.*${NOVNC_PORT}" 2>/dev/null || true
  pkill -f "x11vnc.*rfbport.*${VNC_PORT}" 2>/dev/null || true
  pkill -f "Xvfb :${DISPLAY_NUM}" 2>/dev/null || true
  sleep 1
  echo "Stopped."
}

# ─── Status ─────────────────────────────────────────────────────
do_status() {
  echo "Browser stack status:"
  is_running "Xvfb :${DISPLAY_NUM}"                && ok "Xvfb :${DISPLAY_NUM}"       || fail "Xvfb"
  [ -n "$(managed_chrome_pids)" ]                  && ok "VNC Chrome CDP :${CDP_PORT}" || fail "VNC Chrome"
  is_running "x11vnc.*rfbport.*${VNC_PORT}"         && ok "x11vnc :${VNC_PORT}"        || fail "x11vnc"
  is_running "websockify.*${NOVNC_PORT}"              && ok "noVNC :${NOVNC_PORT}"       || fail "noVNC"
  echo ""
  if curl -s "http://localhost:${CDP_PORT}/json/version" &>/dev/null; then
    ok "CDP reachable at http://localhost:${CDP_PORT}"
  else
    fail "CDP not reachable"
  fi
}

# ─── Start ──────────────────────────────────────────────────────
do_start() {
  # Stop anything already running
  do_stop

  # Xvfb
  if ! command -v Xvfb &>/dev/null; then
    fail "Xvfb not installed (apt install xvfb)"
    exit 1
  fi
  Xvfb ":${DISPLAY_NUM}" -screen 0 "${RESOLUTION}" &>/dev/null &
  sleep 1
  is_running "Xvfb :${DISPLAY_NUM}" && ok "Xvfb started (:${DISPLAY_NUM})" || { fail "Xvfb failed"; exit 1; }

  # Chrome
  CHROME=$(find_chrome)
  if [ -z "$CHROME" ]; then
    fail "Chrome/Chromium not found (apt install chromium)"
    exit 1
  fi
  mkdir -p "${VNC_PROFILE}" "$(dirname "${CHROME_LOG}")"
  "$CHROME" \
    --remote-debugging-port="${CDP_PORT}" \
    --remote-debugging-address=127.0.0.1 \
    --no-first-run \
    --no-sandbox \
    --disable-gpu \
    --disable-software-rasterizer \
    --disable-dev-shm-usage \
    --window-size=1920,1080 \
    --user-data-dir="${VNC_PROFILE}" \
    --display=":${DISPLAY_NUM}" \
    "${CHROME_START_URL}" \
    >>"${CHROME_LOG}" 2>&1 &
  sleep 2

  if curl -s "http://localhost:${CDP_PORT}/json/version" &>/dev/null &&
     [ -n "$(managed_chrome_pids)" ]; then
    ok "Chrome started (CDP: localhost:${CDP_PORT}, localhost only)"
  else
    fail "Chrome failed to start"
    exit 1
  fi

  # x11vnc
  if command -v x11vnc &>/dev/null; then
    x11vnc \
      -display ":${DISPLAY_NUM}" \
      -nopw \
      -forever \
      -shared \
      -rfbport "${VNC_PORT}" \
      -localhost \
      &>/dev/null &
    sleep 1
    is_running "x11vnc" && ok "x11vnc started (localhost:${VNC_PORT})" || fail "x11vnc failed"
  else
    fail "x11vnc not installed, skipping (apt install x11vnc)"
  fi

  # noVNC (via websockify, same as openclaw)
  if command -v websockify &>/dev/null; then
    websockify --web=/usr/share/novnc "127.0.0.1:${NOVNC_PORT}" "localhost:${VNC_PORT}" &>/dev/null &
    sleep 1
    is_running "websockify.*${NOVNC_PORT}" && ok "noVNC started (localhost:${NOVNC_PORT})" || fail "noVNC failed"
  else
    fail "websockify not found, skipping (apt install novnc)"
  fi

  echo ""
  echo "View browser (SSH tunnel, localhost only):"
  echo "  ssh -L ${NOVNC_PORT}:127.0.0.1:${NOVNC_PORT} $(whoami)@$(hostname -I 2>/dev/null | awk '{print $1}' || echo '<server-ip>')"
  echo "  Then open: http://localhost:${NOVNC_PORT}/vnc.html"
}

# ─── Main ───────────────────────────────────────────────────────
case "${1:-start}" in
  start)  do_start ;;
  stop)   do_stop ;;
  status) do_status ;;
  *)      echo "Usage: $0 {start|stop|status}" ;;
esac
