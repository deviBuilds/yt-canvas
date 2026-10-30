import { ApiError } from "../../api/http";
import { CodecError, flacDescription } from "./codecs";
import { MkvError } from "./mkv";
import { Mp4Error, type AudioTrackConfig, type VideoTrackConfig } from "./mp4";
import { isAbort, type EncodedSample, type EngineSource, type MediaReaders, type ReaderSegment, type TrackReader } from "./readers";

/**
 * Plays video without a media element: compressed samples are fetched in byte
 * ranges, decoded with WebCodecs, and each VideoFrame is handed to the canvas
 * renderer as an image. Audio is decoded the same way and scheduled on a Web
 * Audio context, whose clock drives everything (video frames are shown when the
 * audio clock reaches them).
 *
 * It mirrors the part of HTMLVideoElement the player uses (currentTime, play(),
 * pause(), volume, playbackRate, buffered, readyState, media events and
 * requestVideoFrameCallback), so the player and renderer work with either.
 */

// Compressed data fetched ahead of the playhead.
const AHEAD_SECONDS = 20;
const MAX_LOADED_SEGMENTS = 12;
// Decoded frames waiting to be shown. Decoders stall when too many frames are held.
const MAX_FRAMES = 6;
const MAX_VIDEO_DECODE_QUEUE = 4;
// Seconds of audio decoded, and handed to Web Audio, ahead of the clock.
const AUDIO_DECODE_AHEAD = 4;
const AUDIO_SCHEDULE_AHEAD = 1;
const AUDIO_SCHEDULE_AHEAD_HIDDEN = 3;
// How much decoded data is needed to (re)start after loading, seeking or buffering.
const START_AUDIO_SECONDS = 0.3;
const START_FRAMES = 3;
// Headroom between asking Web Audio to start and the first sample playing.
const START_LEAD = 0.05;
const TICK_MS = 100;
const TIMEUPDATE_MS = 250;

const HAVE_NOTHING = 0;
const HAVE_METADATA = 1;
const HAVE_CURRENT_DATA = 2;
const HAVE_ENOUGH_DATA = 4;

/** Like MediaError: ``code`` uses the same numbers, ``message`` is shown to the user. */
export interface EngineError {
  readonly code: 1 | 2 | 3 | 4;
  readonly message: string;
}

/** What the engine can decode in this browser: the capability profile sources pick tracks by. */
export interface EngineSupport {
  /** H.264 and AAC: what every source can fall back to. */
  supported: boolean;
  avc: boolean;
  hevc: boolean;
  av1: boolean;
  vp9: boolean;
  aac: boolean;
  mp3: boolean;
  opus: boolean;
  flac: boolean;
}

class Ranges implements TimeRanges {
  constructor(private readonly ranges: Array<[number, number]>) {}
  get length() {
    return this.ranges.length;
  }
  start(index: number) {
    return this.ranges[index]![0];
  }
  end(index: number) {
    return this.ranges[index]![1];
  }
}

/** Media time as a function of an underlying clock (the audio context's, or performance.now). */
class Clock {
  rate = 1;
  running = false;
  private anchorMedia = 0;
  private anchorTime = 0;

  constructor(private readonly time: () => number) {}

  now(): number {
    return this.running ? this.anchorMedia + Math.max(0, this.time() - this.anchorTime) * this.rate : this.anchorMedia;
  }

  /** Media time at an underlying time, without clamping (for scheduling audio). */
  mediaAt(time: number): number {
    return this.anchorMedia + (time - this.anchorTime) * this.rate;
  }

  timeFor(media: number): number {
    return this.anchorTime + (media - this.anchorMedia) / this.rate;
  }

  get startsAt(): number {
    return this.anchorTime;
  }

  start(lead: number): void {
    this.anchorTime = this.time() + lead;
    this.running = true;
  }

  stop(): void {
    this.anchorMedia = this.now();
    this.running = false;
  }

  set(media: number): void {
    this.anchorMedia = media;
    this.anchorTime = this.time();
  }

  setRate(rate: number): void {
    if (this.running) this.set(this.now());
    this.rate = rate;
  }
}

interface Lane {
  reader: TrackReader;
  loaded: Map<number, EncodedSample[]>;
  inflight: { index: number; controller: AbortController } | null;
  /** Next sample to decode. */
  feedSegment: number;
  feedSample: number;
  /** Presentation end (s) of the last sample sent to the decoder. */
  fedUntil: number;
  /** Every sample was sent and the decoder was asked to flush. */
  drained: boolean;
  /** The flush finished: nothing more will come out of the decoder. */
  finished: boolean;
}

interface VideoPart {
  lane: Lane;
  decoder: VideoDecoder;
  config: VideoDecoderConfig;
}

interface AudioPart {
  lane: Lane;
  decoder: AudioDecoder;
  config: AudioDecoderConfig;
}

interface Pipeline {
  source: EngineSource;
  controller: AbortController;
  readers: MediaReaders | null;
  video: VideoPart | null;
  audio: AudioPart | null;
  /** Stopped after a source error the caller handles; waits to be replaced. */
  halted: boolean;
}

interface AudioChunk {
  start: number;
  end: number;
  buffer: AudioBuffer;
  node: AudioBufferSourceNode | null;
  /** Already played (or skipped) entirely. */
  done: boolean;
}

function segmentIndexAt(segments: ReaderSegment[], time: number): number {
  let lo = 0;
  let hi = segments.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (segments[mid]!.time <= time + 1e-3) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

function videoConfig(config: VideoTrackConfig): VideoDecoderConfig {
  return {
    codec: config.codec,
    description: config.description,
    codedWidth: config.width || undefined,
    codedHeight: config.height || undefined,
  };
}

function audioConfig(config: AudioTrackConfig): AudioDecoderConfig {
  return {
    codec: config.codec,
    description: config.description,
    sampleRate: config.sampleRate,
    numberOfChannels: config.channels,
  };
}

/** Planar float samples from any AudioData format. */
function planes(data: AudioData): Float32Array<ArrayBuffer>[] {
  const frames = data.numberOfFrames;
  const channels = data.numberOfChannels;
  try {
    return Array.from({ length: channels }, (_, plane) => {
      const out = new Float32Array(frames);
      data.copyTo(out, { planeIndex: plane, format: "f32-planar" });
      return out;
    });
  } catch {
    // Older engines can't convert while copying; do it by hand.
  }
  const format = data.format;
  const out = Array.from({ length: channels }, () => new Float32Array(frames));
  if (format === "f32-planar" || format === "s16-planar") {
    for (let c = 0; c < channels; c++) {
      if (format === "f32-planar") data.copyTo(out[c]!, { planeIndex: c });
      else {
        const raw = new Int16Array(frames);
        data.copyTo(raw, { planeIndex: c });
        for (let i = 0; i < frames; i++) out[c]![i] = raw[i]! / 32768;
      }
    }
    return out;
  }
  const interleaved = format === "s16" ? new Int16Array(frames * channels) : new Float32Array(frames * channels);
  data.copyTo(interleaved, { planeIndex: 0 });
  const scale = format === "s16" ? 1 / 32768 : 1;
  for (let i = 0; i < frames; i++) for (let c = 0; c < channels; c++) out[c]![i] = interleaved[i * channels + c]! * scale;
  return out;
}

function toEngineError(err: unknown): EngineError {
  if (err instanceof ApiError) return { code: 2, message: err.message || "A network error interrupted playback." };
  if (err instanceof Mp4Error || err instanceof MkvError || err instanceof CodecError) return { code: 4, message: err.message };
  if (err instanceof DOMException && (err.name === "NotSupportedError" || err.name === "EncodingError")) {
    return { code: 3, message: "This video could not be decoded by your browser." };
  }
  return { code: 3, message: "Playback failed." };
}

let support: Promise<EngineSupport> | null = null;

export class CanvasEngine extends EventTarget {
  /** Whether this browser can decode H.264 + AAC with WebCodecs and play it with Web Audio. */
  static probe(): Promise<EngineSupport> {
    support ??= (async () => {
      const none = { supported: false, avc: false, hevc: false, av1: false, vp9: false, aac: false, mp3: false, opus: false, flac: false };
      if (typeof VideoDecoder === "undefined" || typeof AudioDecoder === "undefined" || typeof AudioContext === "undefined") return none;
      const video = async (codec: string) => (await VideoDecoder.isConfigSupported({ codec }).catch(() => null))?.supported ?? false;
      const audio = async (codec: string, description?: Uint8Array) =>
        (await AudioDecoder.isConfigSupported({ codec, sampleRate: 48000, numberOfChannels: 2, description }).catch(() => null))
          ?.supported ?? false;
      const [avc, hevc, av1, vp9, aac, mp3, opus, flac] = await Promise.all([
        video("avc1.42E01E"),
        video("hvc1.1.6.L93.B0"),
        video("av01.0.08M.08"),
        video("vp09.00.10.08"),
        audio("mp4a.40.2"),
        audio("mp3"),
        audio("opus"),
        audio("flac", flacDescription(48000, 2)),
      ]);
      return { supported: avc && aac, avc, hevc, av1, vp9, aac, mp3, opus, flac };
    })();
    return support;
  }

  /** Synchronous guess before probe() settles: are the APIs there at all? */
  static get available(): boolean {
    return typeof VideoDecoder !== "undefined" && typeof AudioDecoder !== "undefined" && typeof AudioContext !== "undefined";
  }

  defaultPlaybackRate = 1;

  private pipeline: Pipeline | null = null;
  private source: string | null = null;
  private context: AudioContext | null = null;
  private gain: GainNode | null = null;
  private readonly clock = new Clock(() => this.clockTime());

  private isPaused = true;
  private isEnded = false;
  private isSeeking = false;
  private isWaiting = false;
  private mediaDuration = NaN;
  private volumeLevel = 1;
  private isMuted = false;
  private state = HAVE_NOTHING;
  private failure: EngineError | null = null;
  private width = 0;
  private height = 0;

  private queue: VideoFrame[] = [];
  private current: VideoFrame | null = null;
  private presented = 0;
  /** Decoded frames replaced by a later one before they were shown (the clock got ahead). */
  private dropped = 0;
  /** A frame must be shown before seeking or loading completes. */
  private needFrame = false;
  private seekTarget = 0;
  private audioChunks: AudioChunk[] = [];
  private audioDecodedUntil = -Infinity;

  private frameCallbacks = new Map<number, VideoFrameRequestCallback>();
  private nextCallbackId = 1;
  private timer: number | null = null;
  private animation: number | null = null;
  private lastTimeupdate = 0;
  private pumping = false;
  private disposed = false;

  // -- HTMLMediaElement-like surface -------------------------------------------------------

  get hasSource(): boolean {
    return this.source !== null;
  }

  /** The source's id, like a media element's ``src``. */
  get src(): string {
    return this.source ?? "";
  }

  /** The frame on screen, for the canvas renderer. */
  get frame(): VideoFrame | null {
    return this.current;
  }

  get currentTime(): number {
    if (this.isSeeking) return this.seekTarget;
    const time = this.clock.now();
    return Number.isFinite(this.mediaDuration) ? Math.min(Math.max(0, time), this.mediaDuration) : Math.max(0, time);
  }

  set currentTime(value: number) {
    const pipeline = this.pipeline;
    if (!pipeline?.readers || !Number.isFinite(value)) return;
    this.seek(pipeline, Math.min(Math.max(0, value), Number.isFinite(this.mediaDuration) ? this.mediaDuration : value));
  }

  get duration(): number {
    return this.mediaDuration;
  }

  get paused(): boolean {
    return this.isPaused;
  }

  get ended(): boolean {
    return this.isEnded;
  }

  get seeking(): boolean {
    return this.isSeeking;
  }

  get readyState(): number {
    return this.state;
  }

  get error(): EngineError | null {
    return this.failure;
  }

  get videoWidth(): number {
    return this.width;
  }

  get videoHeight(): number {
    return this.height;
  }

  get volume(): number {
    return this.volumeLevel;
  }

  set volume(value: number) {
    const next = Math.min(1, Math.max(0, value));
    if (next === this.volumeLevel) return;
    this.volumeLevel = next;
    this.applyGain();
    this.emit("volumechange");
  }

  get muted(): boolean {
    return this.isMuted;
  }

  set muted(value: boolean) {
    if (value === this.isMuted) return;
    this.isMuted = value;
    this.applyGain();
    this.emit("volumechange");
  }

  get playbackRate(): number {
    return this.clock.rate;
  }

  set playbackRate(value: number) {
    if (!(value > 0) || value === this.clock.rate) return;
    const running = this.clock.running;
    if (running) this.stopAudio();
    this.clock.setRate(value);
    if (running) this.scheduleAudio();
    this.emit("ratechange");
  }

  get buffered(): TimeRanges {
    const pipeline = this.pipeline;
    const now = this.currentTime;
    if (!pipeline?.readers) return new Ranges([]);
    const lanes = [pipeline.video?.lane, pipeline.audio?.lane].filter((lane): lane is Lane => Boolean(lane));
    let end = Infinity;
    for (const lane of lanes) {
      const segments = lane.reader.segments;
      let k = lane.feedSegment;
      while (lane.loaded.has(k)) k++;
      const covered = lane.finished || k >= segments.length ? this.mediaDuration : k > lane.feedSegment ? segments[k - 1]!.time + segments[k - 1]!.duration : now;
      end = Math.min(end, covered);
    }
    if (!Number.isFinite(end)) return new Ranges([]);
    return new Ranges([[Math.max(0, Math.min(now, end) - 0.001), Math.max(now, end)]]);
  }

  /** What the engine holds right now, for tests and debugging. */
  get diagnostics() {
    const context = this.context;
    return {
      audioContext: context?.state ?? "none",
      audioOutput: context
        ? {
            sampleRate: context.sampleRate,
            baseLatency: context.baseLatency ?? null,
            outputLatency: "outputLatency" in context ? context.outputLatency : null,
          }
        : null,
      audioDecodedUntil: this.audioDecodedUntil,
      audioScheduled: this.audioChunks.filter((chunk) => chunk.node).length,
      framesQueued: this.queue.length,
      framesPresented: this.presented,
      framesDropped: this.dropped,
      waiting: this.isWaiting,
    };
  }

  requestVideoFrameCallback(callback: VideoFrameRequestCallback): number {
    const id = this.nextCallbackId++;
    this.frameCallbacks.set(id, callback);
    return id;
  }

  cancelVideoFrameCallback(handle: number): void {
    this.frameCallbacks.delete(handle);
  }

  async play(): Promise<void> {
    const pipeline = this.pipeline;
    if (!pipeline) throw new DOMException("There is nothing to play.", "NotSupportedError");
    if (this.isEnded) this.seek(pipeline, 0);
    if (!pipeline.readers || pipeline.audio) {
      // Autoplay policy: the audio context only starts after a user gesture on the page.
      const context = this.audioContext();
      if (context.state !== "running") {
        await Promise.race([context.resume().catch(() => undefined), new Promise((resolve) => window.setTimeout(resolve, 400))]);
        // The await above may have changed the state; read it again.
        if ((context.state as AudioContextState) !== "running") throw new DOMException("Playback needs a click first.", "NotAllowedError");
      }
    }
    if (this.isPaused) {
      this.isPaused = false;
      this.emit("play");
    }
    this.pump();
  }

  pause(): void {
    if (this.isPaused) return;
    this.isPaused = true;
    this.isWaiting = false;
    if (this.clock.running) {
      this.clock.stop();
      this.stopAudio();
    }
    this.stopAnimation();
    this.emit("timeupdate");
    this.emit("pause");
  }

  /** Start playing ``source`` (replacing the current one); metadata arrives with "loadedmetadata". */
  open(source: EngineSource): void {
    if (this.disposed) return;
    this.teardown();
    this.resetState();
    const pipeline: Pipeline = { source, controller: new AbortController(), readers: null, video: null, audio: null, halted: false };
    this.pipeline = pipeline;
    this.source = source.id;
    this.needFrame = true;
    this.emit("emptied");
    this.emit("loadstart");
    this.ensureTimer();
    void this.start(pipeline);
  }

  /** Stop and forget the source. */
  close(): void {
    const had = this.source !== null;
    this.teardown();
    this.resetState();
    this.source = null;
    this.stopTimer();
    if (had) this.emit("emptied");
  }

  dispose(): void {
    if (this.disposed) return;
    this.close();
    this.disposed = true;
    this.frameCallbacks.clear();
    void this.context?.close().catch(() => undefined);
    this.context = null;
    this.gain = null;
  }

  // -- loading -----------------------------------------------------------------------------------

  private async start(pipeline: Pipeline): Promise<void> {
    try {
      const readers = await pipeline.source.open(pipeline.controller.signal);
      if (pipeline !== this.pipeline) return;
      const video = readers.video?.config.kind === "video" ? videoConfig(readers.video.config) : null;
      const audio = readers.audio?.config.kind === "audio" ? audioConfig(readers.audio.config) : null;
      if (video && !(await VideoDecoder.isConfigSupported(video)).supported) {
        throw new Mp4Error(`This browser can't decode ${video.codec} video with WebCodecs.`);
      }
      if (audio && !(await AudioDecoder.isConfigSupported(audio)).supported) {
        throw new Mp4Error(`This browser can't decode ${audio.codec} audio with WebCodecs.`);
      }
      if (pipeline !== this.pipeline) return;

      const lane = (reader: TrackReader): Lane => ({
        reader,
        loaded: new Map(),
        inflight: null,
        feedSegment: 0,
        feedSample: 0,
        fedUntil: reader.segments[0]?.time ?? 0,
        drained: false,
        finished: false,
      });
      if (video && readers.video) {
        const decoder = new VideoDecoder({
          output: (frame) => this.onVideoFrame(pipeline, frame),
          error: (err) => this.fail(pipeline, err),
        });
        decoder.configure(video);
        pipeline.video = { lane: lane(readers.video), decoder, config: video };
        const config = readers.video.config as VideoTrackConfig;
        this.resize(config.width, config.height);
      }
      if (audio && readers.audio) {
        this.audioContext();
        const decoder = new AudioDecoder({
          output: (data) => this.onAudioData(pipeline, data),
          error: (err) => this.fail(pipeline, err),
        });
        decoder.configure(audio);
        pipeline.audio = { lane: lane(readers.audio), decoder, config: audio };
      }
      pipeline.readers = readers;
      this.mediaDuration = readers.duration > 0 ? readers.duration : NaN;
      this.state = HAVE_METADATA;
      this.emit("durationchange");
      this.emit("loadedmetadata");
      this.pump();
    } catch (err) {
      this.fail(pipeline, err);
    }
  }

  private fail(pipeline: Pipeline, err: unknown): void {
    if (pipeline !== this.pipeline || pipeline.halted || isAbort(err)) return;
    // Decoder callbacks report closing as an AbortError too.
    if (err instanceof DOMException && err.name === "AbortError") return;
    this.halt(pipeline);
    if (pipeline.source.onError?.(err)) return;
    this.failure = toEngineError(err);
    if (!this.isPaused) {
      this.isPaused = true;
      this.emit("pause");
    }
    this.emit("error");
  }

  /** Stop all work for ``pipeline`` but keep the last frame on screen. */
  private halt(pipeline: Pipeline): void {
    pipeline.halted = true;
    pipeline.controller.abort();
    for (const part of [pipeline.video, pipeline.audio]) {
      part?.lane.inflight?.controller.abort();
      if (part && part.decoder.state !== "closed") part.decoder.close();
    }
    if (this.clock.running) this.clock.stop();
    this.stopAudio();
    this.stopAnimation();
    for (const frame of this.queue) frame.close();
    this.queue = [];
  }

  private teardown(): void {
    const pipeline = this.pipeline;
    if (pipeline) {
      this.halt(pipeline);
      this.pipeline = null;
    }
    this.current?.close();
    this.current = null;
    this.audioChunks = [];
  }

  private resetState(): void {
    this.isPaused = true;
    this.isEnded = false;
    this.isSeeking = false;
    this.isWaiting = false;
    this.mediaDuration = NaN;
    this.state = HAVE_NOTHING;
    this.failure = null;
    this.width = 0;
    this.height = 0;
    this.seekTarget = 0;
    this.audioDecodedUntil = -Infinity;
    this.needFrame = false;
    this.presented = 0;
    this.dropped = 0;
    this.clock.set(0);
  }

  // -- clock and audio output -------------------------------------------------------------

  private audioContext(): AudioContext {
    if (!this.context) {
      this.context = new AudioContext();
      this.gain = this.context.createGain();
      this.gain.connect(this.context.destination);
      this.applyGain();
    }
    return this.context;
  }

  private clockTime(): number {
    const context = this.context;
    return this.pipeline?.audio && context ? context.currentTime : performance.now() / 1000;
  }

  /** Where the picture should be: the clock minus the time sound takes to reach the speakers. */
  private videoTime(): number {
    const now = this.clock.now();
    if (!this.clock.running || !this.pipeline?.audio || !this.context) return now;
    const latency = this.context.outputLatency || this.context.baseLatency || 0;
    return now - latency * this.clock.rate;
  }

  private applyGain(): void {
    if (this.gain) this.gain.gain.value = this.isMuted ? 0 : this.volumeLevel;
  }

  private scheduleAudio(): void {
    const context = this.context;
    const gain = this.gain;
    if (!this.clock.running || !context || !gain || !this.pipeline?.audio) return;
    const now = this.clock.now();
    const ahead = document.hidden ? AUDIO_SCHEDULE_AHEAD_HIDDEN : AUDIO_SCHEDULE_AHEAD;
    const earliest = Math.max(context.currentTime + 0.01, this.clock.startsAt);
    for (const chunk of this.audioChunks) {
      if (chunk.node || chunk.done) continue;
      if (chunk.start > now + ahead) break;
      let at = this.clock.timeFor(chunk.start);
      let offset = 0;
      if (at < earliest) {
        offset = this.clock.mediaAt(earliest) - chunk.start;
        at = earliest;
      }
      if (offset >= chunk.buffer.duration - 1e-4) {
        chunk.done = true;
        continue;
      }
      const node = context.createBufferSource();
      node.buffer = chunk.buffer;
      node.playbackRate.value = this.clock.rate;
      node.connect(gain);
      node.start(at, Math.max(0, offset));
      chunk.node = node;
    }
    // Forget what has been played.
    while (this.audioChunks.length > 0 && this.audioChunks[0]!.end < now - 0.5) {
      const chunk = this.audioChunks.shift()!;
      chunk.node?.disconnect();
    }
  }

  /** Silence everything scheduled; chunks are rescheduled from the clock when playback resumes. */
  private stopAudio(): void {
    for (const chunk of this.audioChunks) {
      if (!chunk.node) continue;
      try {
        chunk.node.stop();
      } catch {
        // never started
      }
      chunk.node.disconnect();
      chunk.node = null;
    }
  }

  // -- decoding ------------------------------------------------------------------------------

  private onVideoFrame(pipeline: Pipeline, frame: VideoFrame): void {
    if (pipeline !== this.pipeline || pipeline.halted) {
      frame.close();
      return;
    }
    // Frames between the key frame and a seek target are decoded but never shown.
    if (frame.duration !== null && (frame.timestamp + frame.duration) / 1e6 <= this.seekTarget - 1e-4) {
      frame.close();
      return;
    }
    let i = this.queue.length;
    while (i > 0 && this.queue[i - 1]!.timestamp > frame.timestamp) i--;
    this.queue.splice(i, 0, frame);
    this.present();
    this.pumpSoon();
  }

  private onAudioData(pipeline: Pipeline, data: AudioData): void {
    const context = this.context;
    if (pipeline !== this.pipeline || pipeline.halted || !context) {
      data.close();
      return;
    }
    const start = data.timestamp / 1e6;
    const end = start + data.numberOfFrames / data.sampleRate;
    if (end <= this.seekTarget || data.numberOfFrames === 0) {
      data.close();
      return;
    }
    const buffer = context.createBuffer(data.numberOfChannels, data.numberOfFrames, data.sampleRate);
    planes(data).forEach((plane, channel) => buffer.copyToChannel(plane, channel));
    data.close();
    this.audioChunks.push({ start, end, buffer, node: null, done: false });
    this.audioDecodedUntil = Math.max(this.audioDecodedUntil, end);
    this.scheduleAudio();
    this.pumpSoon();
  }

  /** The next sample to decode, "wait" for a segment still loading, or "end". */
  private nextSample(lane: Lane): EncodedSample | "wait" | "end" {
    const segments = lane.reader.segments;
    while (lane.feedSegment < segments.length) {
      const samples = lane.loaded.get(lane.feedSegment);
      if (!samples) return "wait";
      if (lane.feedSample < samples.length) return samples[lane.feedSample++]!;
      lane.loaded.delete(lane.feedSegment);
      lane.feedSegment++;
      lane.feedSample = 0;
    }
    return "end";
  }

  private drain(pipeline: Pipeline, part: VideoPart | AudioPart): void {
    if (part.lane.drained) return;
    part.lane.drained = true;
    const lane = part.lane;
    part.decoder.flush().then(
      () => {
        if (pipeline !== this.pipeline || part.lane !== lane || !lane.drained) return;
        lane.finished = true;
        this.pump();
      },
      () => undefined, // reset by a seek, or closed
    );
  }

  private feedVideo(pipeline: Pipeline): void {
    const part = pipeline.video;
    if (!part || part.decoder.state !== "configured") return;
    const { decoder, lane } = part;
    while (decoder.decodeQueueSize < MAX_VIDEO_DECODE_QUEUE && this.queue.length + decoder.decodeQueueSize < MAX_FRAMES) {
      const sample = this.nextSample(lane);
      if (sample === "wait") return;
      if (sample === "end") return this.drain(pipeline, part);
      decoder.decode(new EncodedVideoChunk({ type: sample.key ? "key" : "delta", timestamp: sample.timestamp, duration: sample.duration, data: sample.data }));
      lane.fedUntil = Math.max(lane.fedUntil, (sample.timestamp + sample.duration) / 1e6);
    }
  }

  private feedAudio(pipeline: Pipeline): void {
    const part = pipeline.audio;
    if (!part || part.decoder.state !== "configured") return;
    const { decoder, lane } = part;
    const limit = this.clock.now() + AUDIO_DECODE_AHEAD;
    while (decoder.decodeQueueSize < 16 && lane.fedUntil < limit) {
      const sample = this.nextSample(lane);
      if (sample === "wait") return;
      if (sample === "end") return this.drain(pipeline, part);
      decoder.decode(new EncodedAudioChunk({ type: "key", timestamp: sample.timestamp, duration: sample.duration, data: sample.data }));
      lane.fedUntil = Math.max(lane.fedUntil, (sample.timestamp + sample.duration) / 1e6);
    }
  }

  private fetchAhead(pipeline: Pipeline, lane: Lane): void {
    if (lane.inflight || pipeline.halted) return;
    const segments = lane.reader.segments;
    let index = lane.feedSegment;
    while (index < segments.length && lane.loaded.has(index)) index++;
    if (index >= segments.length || lane.loaded.size >= MAX_LOADED_SEGMENTS) return;
    if (index > lane.feedSegment && segments[index]!.time > this.clock.now() + AHEAD_SECONDS) return;
    const controller = new AbortController();
    lane.inflight = { index, controller };
    lane.reader.load(index, controller.signal).then(
      (samples) => {
        if (lane.inflight?.controller !== controller) return;
        lane.inflight = null;
        if (pipeline !== this.pipeline || pipeline.halted) return;
        if (index >= lane.feedSegment) lane.loaded.set(index, samples);
        this.emit("progress");
        this.pump();
      },
      (err: unknown) => {
        if (lane.inflight?.controller === controller) lane.inflight = null;
        if (!isAbort(err)) this.fail(pipeline, err);
      },
    );
  }

  // -- presenting -------------------------------------------------------------------------

  /** Show the latest decoded frame that is due, dropping the ones it replaces. */
  private present(): void {
    if (this.queue.length === 0) return;
    const due = this.videoTime() * 1e6 + 1000;
    let pick = -1;
    for (let i = 0; i < this.queue.length && this.queue[i]!.timestamp <= due; i++) pick = i;
    // Paused after loading or seeking (or the target is before the first frame): show the first one.
    if (pick < 0 && this.needFrame && !this.clock.running) pick = 0;
    if (pick < 0) return;
    const frame = this.queue[pick]!;
    for (const late of this.queue.splice(0, pick + 1)) {
      if (late === frame) continue;
      late.close();
      this.dropped++;
    }
    this.current?.close();
    this.current = frame;
    const first = this.presented === 0;
    this.presented++;
    this.resize(frame.displayWidth, frame.displayHeight);
    if (this.state < HAVE_CURRENT_DATA) this.state = HAVE_CURRENT_DATA;
    const callbacks = [...this.frameCallbacks.values()];
    this.frameCallbacks.clear();
    const now = performance.now();
    for (const callback of callbacks) {
      callback(now, {
        mediaTime: frame.timestamp / 1e6,
        presentationTime: now,
        expectedDisplayTime: now,
        width: frame.displayWidth,
        height: frame.displayHeight,
        presentedFrames: this.presented,
      });
    }
    if (first) this.emit("loadeddata");
    if (this.needFrame) {
      this.needFrame = false;
      this.finishSeek();
    }
  }

  private resize(width: number, height: number): void {
    if (!width || !height || (width === this.width && height === this.height)) return;
    this.width = width;
    this.height = height;
    this.emit("resize");
  }

  private finishSeek(): void {
    if (!this.isSeeking) return;
    this.isSeeking = false;
    this.emit("seeked");
    this.emit("timeupdate");
  }

  // -- seeking ------------------------------------------------------------------------------

  private seek(pipeline: Pipeline, target: number): void {
    if (pipeline.halted) return;
    if (this.clock.running) this.clock.stop();
    this.stopAudio();
    this.stopAnimation();
    this.clock.set(target);
    this.seekTarget = target;
    this.isEnded = false;
    this.isSeeking = true;
    this.audioChunks = [];
    this.audioDecodedUntil = -Infinity;
    for (const frame of this.queue) frame.close();
    this.queue = [];
    if (this.state > HAVE_METADATA) this.state = HAVE_METADATA;

    for (const part of [pipeline.video, pipeline.audio]) {
      if (!part) continue;
      const lane = part.lane;
      const segment = segmentIndexAt(lane.reader.segments, target);
      lane.feedSegment = segment;
      lane.feedSample = 0;
      lane.fedUntil = lane.reader.segments[segment]?.time ?? target;
      lane.drained = false;
      lane.finished = false;
      for (const index of [...lane.loaded.keys()]) if (index < segment || index > segment + MAX_LOADED_SEGMENTS) lane.loaded.delete(index);
      if (lane.inflight && lane.inflight.index !== segment && !lane.loaded.has(segment)) {
        lane.inflight.controller.abort();
        lane.inflight = null;
      }
      if (part.decoder.state !== "closed") {
        part.decoder.reset();
        if (pipeline.video === part) (part.decoder as VideoDecoder).configure((part as VideoPart).config);
        else (part.decoder as AudioDecoder).configure((part as AudioPart).config);
      }
    }
    this.emit("seeking");
    this.needFrame = Boolean(pipeline.video);
    if (!pipeline.video) queueMicrotask(() => this.finishSeek());
    this.pump();
  }

  // -- the loop -----------------------------------------------------------------------------

  private ensureTimer(): void {
    if (this.timer === null) this.timer = window.setInterval(() => this.pump(), TICK_MS);
  }

  private stopTimer(): void {
    if (this.timer !== null) window.clearInterval(this.timer);
    this.timer = null;
    this.stopAnimation();
  }

  private startAnimation(): void {
    if (this.animation !== null) return;
    const step = () => {
      this.animation = null;
      if (!this.clock.running) return;
      this.pump();
      this.animation = requestAnimationFrame(step);
    };
    this.animation = requestAnimationFrame(step);
  }

  private stopAnimation(): void {
    if (this.animation !== null) cancelAnimationFrame(this.animation);
    this.animation = null;
  }

  private pumpSoon(): void {
    if (this.pumping) return;
    this.pumping = true;
    queueMicrotask(() => {
      this.pumping = false;
      this.pump();
    });
  }

  private videoFinished(pipeline: Pipeline): boolean {
    return !pipeline.video || (pipeline.video.lane.finished && this.queue.length === 0);
  }

  private audioFinished(pipeline: Pipeline): boolean {
    return !pipeline.audio || pipeline.audio.lane.finished;
  }

  private pump(): void {
    const pipeline = this.pipeline;
    if (!pipeline?.readers || pipeline.halted) return;
    for (const part of [pipeline.video, pipeline.audio]) if (part) this.fetchAhead(pipeline, part.lane);
    this.feedVideo(pipeline);
    this.feedAudio(pipeline);
    this.present();
    if (this.isPaused || this.isEnded) return;

    const now = this.clock.now();
    if (this.clock.running) {
      const lastAudio = pipeline.audio ? this.audioDecodedUntil : -Infinity;
      const lastFrame = this.current ? (this.current.timestamp + (this.current.duration ?? 0)) / 1e6 : -Infinity;
      if (now >= this.mediaDuration - 0.01 || (this.videoFinished(pipeline) && this.audioFinished(pipeline) && now >= Math.max(lastAudio, lastFrame))) {
        return this.end();
      }
      const audioShort = !this.audioFinished(pipeline) && this.audioDecodedUntil < now + 0.05;
      const videoShort =
        !this.videoFinished(pipeline) && this.queue.length === 0 && this.current !== null && lastFrame < this.videoTime() - 0.1;
      if (audioShort || videoShort) {
        this.clock.stop();
        this.stopAudio();
        this.stopAnimation();
        this.isWaiting = true;
        this.state = HAVE_CURRENT_DATA;
        this.emit("waiting");
        return;
      }
      this.scheduleAudio();
      const tick = performance.now();
      if (tick - this.lastTimeupdate >= TIMEUPDATE_MS) {
        this.lastTimeupdate = tick;
        this.emit("timeupdate");
      }
      return;
    }

    const videoReady =
      this.videoFinished(pipeline) || (!this.needFrame && (this.queue.length >= START_FRAMES || pipeline.video!.lane.drained));
    const audioReady = this.audioFinished(pipeline) || this.audioDecodedUntil >= now + START_AUDIO_SECONDS;
    if (videoReady && audioReady && !this.isSeeking) {
      if (pipeline.audio && this.context?.state !== "running") return; // play() resumes it
      this.clock.set(now);
      this.clock.start(pipeline.audio ? START_LEAD : 0);
      this.isWaiting = false;
      this.state = HAVE_ENOUGH_DATA;
      this.scheduleAudio();
      this.startAnimation();
      this.emit("playing");
    } else if (!this.isWaiting) {
      this.isWaiting = true;
      this.emit("waiting");
    }
  }

  private end(): void {
    if (this.clock.running) this.clock.stop();
    if (Number.isFinite(this.mediaDuration)) this.clock.set(this.mediaDuration);
    this.stopAudio();
    this.stopAnimation();
    this.isEnded = true;
    this.isPaused = true;
    this.isWaiting = false;
    this.emit("timeupdate");
    this.emit("pause");
    this.emit("ended");
  }

  private emit(type: string): void {
    this.dispatchEvent(new Event(type));
  }
}
