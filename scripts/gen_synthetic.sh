#!/usr/bin/env bash
# Synthetic long recordings for stress tests, mirroring the real recorder's
# output: webm with stereo opus (L = 440Hz "tab", R = 880Hz "mic"), vp8 video
# in realtime mode so a 2-hour file encodes in minutes, not hours.
# Usage: ./scripts/gen_synthetic.sh <seconds> [video|audio] [out.webm]
set -euo pipefail

DUR="${1:?usage: gen_synthetic.sh <seconds> [video|audio] [out.webm]}"
MODE="${2:-video}"
OUT="${3:-/tmp/synthetic-${MODE}-${DUR}s.webm}"

if [[ "$MODE" == "audio" ]]; then
  ffmpeg -y -hide_banner -loglevel error \
    -f lavfi -i "sine=frequency=440:duration=${DUR}" \
    -f lavfi -i "sine=frequency=880:duration=${DUR}" \
    -filter_complex "[0:a][1:a]join=inputs=2:channel_layout=stereo[a]" \
    -map "[a]" -c:a libopus -b:a 128k "$OUT"
else
  ffmpeg -y -hide_banner -loglevel error \
    -f lavfi -i "testsrc2=size=1280x720:rate=30:duration=${DUR}" \
    -f lavfi -i "sine=frequency=440:duration=${DUR}" \
    -f lavfi -i "sine=frequency=880:duration=${DUR}" \
    -filter_complex "[1:a][2:a]join=inputs=2:channel_layout=stereo[a]" \
    -map 0:v -map "[a]" \
    -c:v libvpx -deadline realtime -cpu-used 8 -b:v 2500k \
    -c:a libopus -b:a 128k "$OUT"
fi

ls -lh "$OUT"
echo "Feed it through the real pipeline: dashboard -> Import file (debug)"
