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

cpu0="$(cpu_secs "$pid")"; rss0="$(rss_mb "$pid")"; areas0="$(tracking_areas "$pid")"
sleep "$WINDOW_SECS"
kill -0 "$pid" 2>/dev/null || { echo "app exited while idle" >&2; cat "$log" >&2; exit 1; }
cpu1="$(cpu_secs "$pid")"; rss1="$(rss_mb "$pid")"; areas1="$(tracking_areas "$pid")"

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
