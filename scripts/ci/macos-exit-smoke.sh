#!/usr/bin/env bash
# Quit and restart the built app on macOS, and fail if either doesn't finish.
#
#   scripts/ci/macos-exit-smoke.sh path/to/fwai_app(.app)
#
# Up to v1.10.1 both froze the app as Not Responding: the exit handler saved
# window state from a tokio task while the main thread wanted the
# window-state plugin's lock for a window event, and each waited on the
# other. Nothing but a real window server shows it, and only at the moment
# the user quits or the updater relaunches.
#
# The app has a debug-build-only hook for this (start_smoke_exit in lib.rs):
# FWAI_SMOKE_EXIT=quit|restart makes it walk the real exit or restart path a
# few seconds after launch. A watchdog force-ends an exit that hangs, so
# "the process ended" isn't enough: the log must also show it ended on its own.
#
# Runs against a throwaway HOME, so it never touches the caller's ~/.fwai_app.
set -euo pipefail

TIMEOUT_SECS="${SMOKE_EXIT_TIMEOUT_SECS:-40}"
WATCHDOG_MSG="强制结束进程"

target="${1:?usage: $0 path/to/fwai_app(.app)}"
if [[ -d "$target" ]]; then
  bin="$target/Contents/MacOS/fwai_app"
else
  bin="$target"
fi
[[ -x "$bin" ]] || { echo "not an executable: $bin" >&2; exit 2; }
# tauri refuses to relaunch from a path with a symlink in it (/tmp is one).
bin="$(cd "$(dirname "$bin")" && pwd -P)/$(basename "$bin")"

if pgrep -x fwai_app >/dev/null; then
  # single-instance would hand the launch to the running copy and exit.
  echo "another fwai_app is already running; quit it first" >&2
  exit 2
fi

home=""
# End whatever a phase left running (a hung app, a relaunched copy) so the
# next phase starts from nothing.
reset() {
  pkill -KILL -x fwai_app 2>/dev/null || true
  while pgrep -x fwai_app >/dev/null; do sleep 0.5; done
  [[ -n "$home" ]] && rm -rf "$home"
  home=""
}
trap reset EXIT

failed=0
fail() { echo "FAIL: $*" >&2; failed=1; }

# Launch with FWAI_SMOKE_EXIT=$1 and wait for the first process to end.
# Sets $home, $log and $pid.
launch_and_wait() {
  home="$(mktemp -d)"
  log="$home/smoke.log"
  HOME="$home" FWAI_SMOKE_EXIT="$1" "$bin" >"$log" 2>&1 &
  pid=$!
  disown "$pid"
  for ((i = 0; i < TIMEOUT_SECS; i++)); do
    kill -0 "$pid" 2>/dev/null || return 0
    sleep 1
  done
  return 1
}

dump() {
  echo "--- app output ---" >&2
  tail -50 "$log" >&2
  if kill -0 "$pid" 2>/dev/null; then
    echo "--- where it is stuck ---" >&2
    sample "$pid" 3 2>/dev/null | grep -E 'Thread_|lock|recv|wait' | head -60 >&2 || true
  fi
}

echo "quit:"
if ! launch_and_wait quit; then
  fail "the app is still running ${TIMEOUT_SECS}s after quit — it hung"
  dump
elif grep -q "$WATCHDOG_MSG" "$log"; then
  fail "quit hung and the watchdog had to end the process"
  dump
elif [[ ! -s "$home/Library/Application Support/space.fwai.app/.window-state.json" ]]; then
  fail "quit didn't save the window state"
  dump
else
  echo "  OK: quit on its own and saved the window state"
fi
reset

echo "restart:"
if ! launch_and_wait restart; then
  fail "the app is still running ${TIMEOUT_SECS}s after restart — it hung"
  dump
elif grep -q "$WATCHDOG_MSG" "$log"; then
  fail "restart hung and the watchdog had to relaunch the app"
  dump
else
  # The relaunched copy inherits stdout, so it logs to the same file.
  sleep 5
  if new="$(pgrep -x fwai_app | grep -vx "$pid")"; then
    echo "  OK: restarted on its own (pid $pid -> $new)"
  else
    fail "the app ended but didn't come back up"
    dump
  fi
fi

(( failed )) && exit 1
echo "OK: quit and restart"
