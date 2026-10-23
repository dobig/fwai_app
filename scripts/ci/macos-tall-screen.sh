#!/usr/bin/env bash
# Switch a CI Mac's main display to the tallest mode it offers (at least
# 1080 px), so the simple-mode window has room to change size. See
# macos-idle-smoke.sh for why that matters.
set -euo pipefail

if ! command -v displayplacer >/dev/null; then
  brew install --quiet jakehilborn/jakehilborn/displayplacer
fi

list="$(displayplacer list)"
echo "$list" | sed -n '1,/^Resolutions/p'
id="$(echo "$list" | awk '/Persistent screen id:/ {print $4; exit}')"

# Every mode line looks like "  mode 12: res:1920x1080 hz:60 color_depth:8 ...".
best="$(echo "$list" | grep -oE 'res:[0-9]+x[0-9]+' | sort -u \
  | awk -F'[:x]' '{print $3, $2}' | sort -n | tail -1 | awk '{print $2 "x" $1}')"
echo "modes available: $(echo "$list" | grep -oE 'res:[0-9]+x[0-9]+' | sort -u | tr '\n' ' ')"
[[ -n "$id" && -n "$best" ]] || { echo "no display modes found" >&2; exit 1; }

echo "switching display $id to $best"
displayplacer "id:$id res:$best scaling:off" || displayplacer "id:$id res:$best"
sleep 2
system_profiler SPDisplaysDataType | grep -iE 'resolution|ui looks like' || true

height="${best#*x}"
if (( height < 1080 )); then
  echo "tallest mode is ${best}; the smoke check needs at least 1080 px" >&2
  exit 1
fi
