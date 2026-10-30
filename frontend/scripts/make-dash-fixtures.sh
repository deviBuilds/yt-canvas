#!/usr/bin/env bash
# Regenerates the small DASH outputs (manifest, init and media segments) the DASH reader tests
# read: one with a SegmentTimeline, one with plain numbered segments, like Plex's transcoder.
set -euo pipefail
out="$(cd "$(dirname "$0")/.." && pwd)/src/player/engine/fixtures/dash"
rm -rf "$out" && mkdir -p "$out/timeline" "$out/number"

make() {
  ffmpeg -hide_banner -loglevel error -y \
    -f lavfi -i "testsrc2=size=160x90:rate=24:duration=2" -f lavfi -i "sine=frequency=440:sample_rate=48000:duration=2" \
    -map_metadata -1 -fflags +bitexact -c:v libx264 -preset veryfast -g 12 -keyint_min 12 -sc_threshold 0 -pix_fmt yuv420p \
    -c:a aac -b:a 64k -ac 2 -f dash -seg_duration 0.5 -use_template 1 -use_timeline "$2" \
    -adaptation_sets "id=0,streams=v id=1,streams=a" \
    -init_seg_name 'init-$RepresentationID$.m4s' -media_seg_name 'chunk-$RepresentationID$-$Number%05d$.m4s' \
    "$out/$1/manifest.mpd"
}
make timeline 1
make number 0
ls -l "$out"/*
