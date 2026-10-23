#!/usr/bin/env bash
# Launch the built app on macOS, leave it idle, and fail if it isn't idle.
#
#   scripts/ci/macos-idle-smoke.sh path/to/fwai_app(.app)
#
# An idle app should burn ~0% CPU and hold steady memory. This catches
# feedback loops that only exist against the real window server and that no
# jsdom test can see — e.g. v1.9.0's resize → isMaximized → resize loop,
# which pegged a core from the moment the simple-mode window appeared and
# leaked an NSTrackingArea per pass (hundreds a second on macOS 26).
#
# Runs against a throwaway HOME, so the app starts on a fresh profile (simple
# mode, the default) and never touches the caller's real ~/.fwai_app.
#
# Thresholds are deliberately loose: the loop it guards against runs at 100%
# CPU and leaks ~750 tracking areas a second, so anything near a limit here is
# already a bug worth a look.
set -euo pipefail

SETTLE_SECS="${SMOKE_SETTLE_SECS:-25}"
WINDOW_SECS="${SMOKE_WINDOW_SECS:-30}"
MAX_CPU_PCT="${SMOKE_MAX_CPU_PCT:-20}"
MAX_TRACKING_AREA_GROWTH="${SMOKE_MAX_TRACKING_AREA_GROWTH:-50}"
MAX_RSS_GROWTH_MB="${SMOKE_MAX_RSS_GROWTH_MB:-150}"

target="${1:?usage: $0 path/to/fwai_app(.app)}"
if [[ -d "$target" ]]; then
  bin="$target/Contents/MacOS/fwai_app"
else
  bin="$target"
fi
[[ -x "$bin" ]] || { echo "not an executable: $bin" >&2; exit 2; }

if pgrep -x fwai_app >/dev/null; then
  # single-instance would hand the launch to the running copy and exit, and
  # we would end up measuring nothing (or the wrong process).
  echo "another fwai_app is already running; quit it first" >&2
  exit 2
fi

home="$(mktemp -d)"
log="$home/smoke.log"
pid=""
cleanup() {
  if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then
    kill -TERM "$pid" 2>/dev/null || true
    sleep 2
    kill -KILL "$pid" 2>/dev/null || true
  fi
  rm -rf "$home"
}
trap cleanup EXIT

# CPU time a process has used so far, in seconds. ps prints [[dd-]hh:]mm:ss.ss.
cpu_secs() {
  ps -o time= -p "$1" | awk '{
    n = split($1, p, /[-:]/); s = 0
    for (i = 1; i <= n; i++) s = s * 60 + p[i]
    print s
  }'
}
rss_mb() { ps -o rss= -p "$1" | awk '{print int($1 / 1024)}'; }
# Live NSTrackingArea objects. Empty when heap can't inspect the process.
tracking_areas() {
  # Read heap's output to the end: exiting awk early would SIGPIPE heap, and
  # pipefail would take the whole script down with it.
  { heap "$1" 2>/dev/null || true; } | awk '$4 == "NSTrackingArea" {n = $1} END {print n}'
}
here="$(cd "$(dirname "$0")" && pwd)"
# Where the window is and how big the screen is: when the check passes on a
# build that should fail, this is the first thing to look at.
window_info() { swift "$here/window-info.swift" "$1" 2>&1 | sed 's/^/  /' || true; }
artifacts="${SMOKE_ARTIFACT_DIR:-}"
[[ -n "$artifacts" ]] && mkdir -p "$artifacts"

echo "launching $bin (HOME=$home)"
HOME="$home" "$bin" >"$log" 2>&1 &
pid=$!
disown "$pid" # we stop it ourselves; skip bash's "Terminated" job notice

sleep "$SETTLE_SECS"
if ! kill -0 "$pid" 2>/dev/null; then
  echo "app exited during startup; its output:" >&2
  cat "$log" >&2
  exit 1
fi

echo "after settle:"; window_info "$pid"
[[ -n "$artifacts" ]] && screencapture -x "$artifacts/after-settle.png" 2>/dev/null || true

# Poke it the way a user would before measuring. Whether a loop starts on its
# own at launch depends on timing and screen size (on a 1024x768 runner it
# didn't), so don't leave it to chance: dismiss the welcome dialog, open and
# leave settings, and move/resize the window. Each step needs the
# Accessibility permission; report what was refused instead of failing on it.
poke() {
  local what="$1" script="$2" out
  if out="$(osascript -e "$script" 2>&1)"; then
    echo "  poke ok:      $what"
  else
    echo "  poke refused: $what ($out)"
  fi
  sleep 2
}
ax_proc="first process whose unix id is $pid"
echo "poking:"
poke "bring to front" "tell application \"System Events\" to set frontmost of ($ax_proc) to true"
poke "dismiss dialog (return)" "tell application \"System Events\" to key code 36"
poke "open settings (cmd-,)" "tell application \"System Events\" to keystroke \",\" using command down"
[[ -n "$artifacts" ]] && screencapture -x "$artifacts/settings.png" 2>/dev/null || true
poke "leave settings (escape)" "tell application \"System Events\" to key code 53"
poke "move window" "tell application \"System Events\" to set position of window 1 of ($ax_proc) to {40, 60}"
poke "resize window" "tell application \"System Events\" to set size of window 1 of ($ax_proc) to {600, 500}"
sleep 3
echo "after poking:"; window_info "$pid"
[[ -n "$artifacts" ]] && screencapture -x "$artifacts/after-poke.png" 2>/dev/null || true
# Don't pass by default: on a screen too short for the simple-mode window
# (1024x768 runner) the window is pinned at full height and the very loop
# this exists for cannot run. Fail so someone fixes the environment.
if ! room="$(swift "$here/window-info.swift" "$pid" --check-room 2>&1 | tail -1)" \
    || [[ "$room" == *"fills"* || "$room" == *"no on-screen"* ]]; then
  echo "FAIL: can't exercise the app here: $room — give the machine a taller screen" >&2
  exit 1
fi

cpu0="$(cpu_secs "$pid")"; rss0="$(rss_mb "$pid")"; areas0="$(tracking_areas "$pid")"
sleep "$WINDOW_SECS"
kill -0 "$pid" 2>/dev/null || { echo "app exited while idle" >&2; cat "$log" >&2; exit 1; }
cpu1="$(cpu_secs "$pid")"; rss1="$(rss_mb "$pid")"; areas1="$(tracking_areas "$pid")"
echo "after idle:"; window_info "$pid"
[[ -n "$artifacts" ]] && cp "$log" "$artifacts/app.log"

cpu_pct="$(awk -v a="$cpu0" -v b="$cpu1" -v w="$WINDOW_SECS" 'BEGIN {printf "%d", (b - a) / w * 100}')"
rss_growth=$((rss1 - rss0))

echo "idle for ${WINDOW_SECS}s after a ${SETTLE_SECS}s settle:"
echo "  cpu            ${cpu_pct}%  (limit ${MAX_CPU_PCT}%)"
echo "  rss            ${rss0} MB -> ${rss1} MB  (+${rss_growth} MB, limit +${MAX_RSS_GROWTH_MB} MB)"
if [[ -n "$areas0" && -n "$areas1" ]]; then
  echo "  NSTrackingArea ${areas0} -> ${areas1}  (+$((areas1 - areas0)), limit +${MAX_TRACKING_AREA_GROWTH})"
else
  echo "  NSTrackingArea n/a (heap could not inspect the process)"
fi

failed=0
if (( cpu_pct > MAX_CPU_PCT )); then
  echo "FAIL: the app is busy while idle — something is looping" >&2
  failed=1
fi
if (( rss_growth > MAX_RSS_GROWTH_MB )); then
  echo "FAIL: memory keeps growing while idle" >&2
  failed=1
fi
if [[ -n "$areas0" && -n "$areas1" ]] && (( areas1 - areas0 > MAX_TRACKING_AREA_GROWTH )); then
  echo "FAIL: NSTrackingArea count keeps growing — the window is being resized or restyled in a loop" >&2
  failed=1
fi
if (( failed )); then
  echo "--- app output ---" >&2
  tail -50 "$log" >&2
  exit 1
fi
echo "OK: idle"
