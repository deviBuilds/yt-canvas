#!/usr/bin/env bash
# Regenerates the small Matroska/WebM files the MKV demuxer tests read, and ffprobe's view
# of each (streams and packets), which the tests compare against.
# Needs FFmpeg with libx264, libx265, libsvtav1, libvpx-vp9 and libopus.
set -euo pipefail
out="$(cd "$(dirname "$0")/.." && pwd)/src/player/engine/fixtures/mkv"
mkdir -p "$out"
cd "$out"

video=(-f lavfi -i "testsrc2=size=160x90:rate=24:duration=2")
tone=(-f lavfi -i "sine=frequency=440:sample_rate=48000:duration=2")
common=(-hide_banner -loglevel error -y)
clean=(-map_metadata -1 -fflags +bitexact)

ffmpeg "${common[@]}" "${video[@]}" "${tone[@]}" "${clean[@]}" -c:v libx264 -preset veryfast -g 12 -bf 2 -pix_fmt yuv420p \
  -c:a aac -b:a 64k -ac 2 h264-aac.mkv
ffmpeg "${common[@]}" "${video[@]}" "${tone[@]}" "${clean[@]}" -c:v libx265 -preset veryfast -x265-params "keyint=12:log-level=error" \
  -pix_fmt yuv420p -c:a aac -b:a 64k -ac 2 hevc-aac.mkv
ffmpeg "${common[@]}" "${video[@]}" "${tone[@]}" "${clean[@]}" -c:v libsvtav1 -preset 12 -g 12 -pix_fmt yuv420p \
  -c:a libopus -b:a 48k av1-opus.webm
ffmpeg "${common[@]}" "${video[@]}" "${tone[@]}" "${clean[@]}" -c:v libvpx-vp9 -deadline realtime -cpu-used 8 -g 12 -b:v 200k \
  -c:a libopus -b:a 48k vp9-opus.webm
ffmpeg "${common[@]}" "${video[@]}" "${tone[@]}" "${clean[@]}" -c:v libx264 -preset veryfast -g 12 -pix_fmt yuv420p \
  -c:a ac3 -b:a 192k -ac 6 h264-ac3.mkv
ffmpeg "${common[@]}" "${video[@]}" "${tone[@]}" "${clean[@]}" -c:v libx264 -preset veryfast -g 12 -pix_fmt yuv420p \
  -c:a flac -ac 2 h264-flac.mkv
ffmpeg "${common[@]}" "${video[@]}" "${tone[@]}" "${clean[@]}" -c:v libx264 -preset veryfast -g 12 -pix_fmt yuv420p \
  -c:a dca -strict -2 -b:a 768k -ac 2 h264-dts.mkv
# Written to a pipe, so the muxer can't seek back: no Cues, unknown Segment and Cluster sizes.
ffmpeg "${common[@]}" "${video[@]}" "${tone[@]}" "${clean[@]}" -c:v libx264 -preset veryfast -g 12 -pix_fmt yuv420p \
  -c:a aac -b:a 64k -ac 2 -f matroska pipe:1 > h264-aac-live.mkv

for file in *.mkv *.webm; do
  ffprobe -v error -show_streams -show_packets -of json "$file" | python3 -c '
import json, sys
probe = json.load(sys.stdin)
streams = [{"index": s["index"], "type": s["codec_type"], "codec": s["codec_name"]} for s in probe["streams"]]
packets = [{"stream": p["stream_index"], "pts": round(float(p["pts_time"]) * 1e6) if p.get("pts_time") not in (None, "N/A") else None,
            "size": int(p["size"]), "key": "K" in p["flags"]} for p in probe["packets"]]
json.dump({"streams": streams, "packets": packets}, sys.stdout, separators=(",", ":"))
' > "$file.json"
done
ls -l
