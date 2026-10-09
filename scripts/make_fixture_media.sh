#!/usr/bin/env bash
# Synthetic test media: stereo opus audio (L=440Hz "tab", R=880Hz "mic") and a
# small vp9+opus video, so pipeline tests never need a real 2-hour recording.
# Usage: ./scripts/make_fixture_media.sh [duration_seconds]
set -euo pipefail

DUR="${1:-30}"
OUT_DIR="$(dirname "$0")/../shared/fixtures/media"
mkdir -p "$OUT_DIR"

ffmpeg -y -hide_banner -loglevel error \
  -f lavfi -i "sine=frequency=440:duration=${DUR}" \
  -f lavfi -i "sine=frequency=880:duration=${DUR}" \
  -filter_complex "[0:a][1:a]join=inputs=2:channel_layout=stereo[a]" \
  -map "[a]" -c:a libopus -b:a 48k \
  "$OUT_DIR/stereo-${DUR}s.webm"

ffmpeg -y -hide_banner -loglevel error \
  -f lavfi -i "testsrc=size=640x360:rate=30:duration=${DUR}" \
  -f lavfi -i "sine=frequency=440:duration=${DUR}" \
  -f lavfi -i "sine=frequency=880:duration=${DUR}" \
  -filter_complex "[1:a][2:a]join=inputs=2:channel_layout=stereo[a]" \
  -map 0:v -map "[a]" -c:v libvpx-vp9 -b:v 500k -c:a libopus -b:a 48k \
  "$OUT_DIR/video-${DUR}s.webm"

echo "Wrote $OUT_DIR/stereo-${DUR}s.webm and $OUT_DIR/video-${DUR}s.webm"
