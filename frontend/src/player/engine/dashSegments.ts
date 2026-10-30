import { ApiError } from "../../api/http";
import { locateMoov, Mp4Error, parseFragments, parseMovie, type MovieTrack } from "./mp4";
import { isAbort, type EncodedSample, type EngineSource, type MediaReaders, type TrackReader } from "./readers";

/**
 * Plays DASH with segment templates: a manifest, an init segment per track, then numbered
 * (or timed) fragmented-MP4 segments. That's what Plex's transcoder makes; the segments
 * are parsed with the MP4 demuxer and decoded like every other source.
 */

export interface DashSegment {
  /** Seconds. */
  time: number;
  duration: number;
  url: string;
}

export interface DashTrack {
  kind: "video" | "audio";
  id: string;
  codecs: string | null;
  bandwidth: number;
  init: string;
  segments: DashSegment[];
}

export interface DashManifest {
  /** Seconds. */
  duration: number;
  video: DashTrack | null;
  audio: DashTrack | null;
}

export class DashError extends Error {
  override name = "DashError";
}

/** ISO 8601 durations as manifests write them: PT1H2M3.5S. */
export function isoSeconds(value: string | null): number {
  const match = value ? /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:([\d.]+)S)?)?$/.exec(value) : null;
  if (!match) return 0;
  const [, days, hours, minutes, seconds] = match;
  return Number(days ?? 0) * 86400 + Number(hours ?? 0) * 3600 + Number(minutes ?? 0) * 60 + Number(seconds ?? 0);
}

interface TemplateValues {
  id: string;
  number?: number;
  time?: number;
  bandwidth?: number;
}

/** Fill a template: $RepresentationID$, $Number$ (with %0Nd), $Time$, $Bandwidth$, $$. */
export function fillTemplate(template: string, values: TemplateValues): string {
  return template.replace(/\$(RepresentationID|Number|Time|Bandwidth|)(%0(\d+)d)?\$/g, (_all, name: string, _format, width?: string) => {
    if (name === "") return "$";
    const value =
      name === "RepresentationID" ? values.id : name === "Number" ? values.number : name === "Time" ? values.time : values.bandwidth;
    const text = String(value ?? "");
    return width ? text.padStart(Number(width), "0") : text;
  });
}

const childrenOf = (parent: Element, name: string) => [...parent.children].filter((node) => node.localName === name);
const childOf = (parent: Element | null, name: string) => (parent ? (childrenOf(parent, name)[0] ?? null) : null);
const attr = (element: Element | null, name: string, fallback: number) => {
  const value = element?.getAttribute(name);
  return value !== null && value !== undefined && value !== "" ? Number(value) : fallback;
};

function resolveBase(base: string, elements: Array<Element | null>): string {
  let url = base;
  for (const element of elements) {
    const text = childOf(element, "BaseURL")?.textContent?.trim();
    if (text) url = new URL(text, url).href;
  }
  return url;
}

function segmentsOf(template: Element, id: string, bandwidth: number, base: string, duration: number): DashSegment[] {
  const timescale = attr(template, "timescale", 1);
  const startNumber = attr(template, "startNumber", 1);
  const offset = attr(template, "presentationTimeOffset", 0);
  const media = template.getAttribute("media");
  if (!media) throw new DashError("The video manifest's segment template has no media address.");
  const segment = (number: number, ticks: number, length: number): DashSegment => ({
    time: (ticks - offset) / timescale,
    duration: length / timescale,
    url: new URL(fillTemplate(media, { id, number, time: ticks, bandwidth }), base).href,
  });

  const timeline = childOf(template, "SegmentTimeline");
  const out: DashSegment[] = [];
  if (timeline) {
    let ticks = 0;
    let number = startNumber;
    for (const s of childrenOf(timeline, "S")) {
      ticks = attr(s, "t", ticks);
      const length = attr(s, "d", 0);
      let repeat = attr(s, "r", 0);
      if (repeat < 0) repeat = Math.max(0, Math.ceil((duration * timescale - (ticks - offset)) / length) - 1);
      for (let i = 0; i <= repeat; i++) {
        out.push(segment(number++, ticks, length));
        ticks += length;
      }
    }
    return out;
  }
  const length = attr(template, "duration", 0);
  if (!length || !duration) throw new DashError("The video manifest doesn't say how long its segments are.");
  const count = Math.ceil((duration * timescale) / length);
  for (let i = 0; i < count; i++) {
    const ticks = offset + i * length;
    out.push({ ...segment(startNumber + i, ticks, Math.min(length, duration * timescale - i * length)) });
  }
  return out;
}

/** Parse a static DASH manifest with SegmentTemplate (numbered, or with a SegmentTimeline). */
export function parseManifest(text: string, url: string): DashManifest {
  const doc = new DOMParser().parseFromString(text, "application/xml");
  const mpd = doc.documentElement;
  if (!mpd || mpd.localName !== "MPD" || doc.getElementsByTagName("parsererror").length > 0) {
    throw new DashError("The video manifest couldn't be read.");
  }
  const period = childOf(mpd, "Period");
  if (!period) throw new DashError("The video manifest has no period.");
  const duration = isoSeconds(period.getAttribute("duration")) || isoSeconds(mpd.getAttribute("mediaPresentationDuration"));
  const absolute = new URL(url, typeof location !== "undefined" ? location.href : "http://localhost/").href;

  const manifest: DashManifest = { duration, video: null, audio: null };
  for (const set of childrenOf(period, "AdaptationSet")) {
    const rep = childrenOf(set, "Representation").sort((a, b) => attr(b, "bandwidth", 0) - attr(a, "bandwidth", 0))[0];
    if (!rep) continue;
    const mime = rep.getAttribute("mimeType") ?? set.getAttribute("mimeType") ?? "";
    const kind = set.getAttribute("contentType") ?? mime.split("/")[0];
    if ((kind !== "video" && kind !== "audio") || manifest[kind]) continue;
    const template = childOf(rep, "SegmentTemplate") ?? childOf(set, "SegmentTemplate");
    if (!template) throw new DashError("The video manifest has no segment template.");
    const base = resolveBase(absolute, [mpd, period, set, rep]);
    const id = rep.getAttribute("id") ?? "0";
    const bandwidth = attr(rep, "bandwidth", 0);
    const init = template.getAttribute("initialization");
    if (!init) throw new DashError("The video manifest has no initialization segment.");
    manifest[kind] = {
      kind,
      id,
      codecs: rep.getAttribute("codecs") ?? set.getAttribute("codecs"),
      bandwidth,
      init: new URL(fillTemplate(init, { id, bandwidth }), base).href,
      segments: segmentsOf(template, id, bandwidth, base, duration),
    };
  }
  if (!manifest.video && !manifest.audio) throw new DashError("The video manifest has no video or audio.");
  return manifest;
}

export type UrlFetcher = (url: string, signal?: AbortSignal) => Promise<ArrayBuffer>;

/** A same-origin GET with retries for network hiccups and 5xx. */
export const httpGet: UrlFetcher = async (url, signal) => {
  for (let attempt = 0; ; attempt++) {
    let response: Response;
    try {
      response = await fetch(url, { signal, cache: "no-store" });
    } catch (err) {
      if (isAbort(err)) throw err;
      if (attempt < 2) continue;
      throw new ApiError(0, { code: "network_error", message: "Lost contact with the server.", hint: null, retryable: true });
    }
    if (response.ok) return response.arrayBuffer();
    if (response.status >= 500 && attempt < 2) continue;
    let info = { code: "error", message: `Reading the video failed (${response.status}).`, hint: null as string | null, retryable: response.status >= 500 };
    try {
      const body = (await response.json()) as { error?: typeof info };
      if (body.error?.message) info = { ...info, ...body.error };
    } catch {
      // not JSON
    }
    throw new ApiError(response.status, info);
  }
};

async function openTrack(track: DashTrack, fetcher: UrlFetcher, signal: AbortSignal): Promise<TrackReader> {
  const init = await fetcher(track.init, signal);
  const where = locateMoov(init);
  if (where.kind !== "found") throw new Mp4Error(`The ${track.kind} track has no movie header.`);
  const movie = parseMovie(new Uint8Array(init, 0, where.end), where.start);
  const media: MovieTrack | undefined = movie.tracks.find((t) => t.config?.kind === track.kind);
  if (!media?.config) throw new Mp4Error(`The ${track.kind} track uses a codec the canvas engine can't read.`);
  const micros = (ticks: number) => Math.round((ticks / media.timescale + media.shift) * 1e6);
  return {
    config: media.config,
    segments: track.segments.map(({ time, duration }) => ({ time: time + media.shift, duration })),
    async load(index, loadSignal): Promise<EncodedSample[]> {
      const bytes = new Uint8Array(await fetcher(track.segments[index]!.url, loadSignal));
      return parseFragments(bytes, 0, media).map((sample) => ({
        data: sample.data,
        timestamp: micros(sample.cts),
        duration: Math.round((sample.duration / media.timescale) * 1e6),
        key: sample.key,
      }));
    },
  };
}

export async function openDash(manifestUrl: string, fetcher: UrlFetcher, signal: AbortSignal): Promise<MediaReaders> {
  const text = new TextDecoder().decode(await fetcher(manifestUrl, signal));
  const manifest = parseManifest(text, manifestUrl);
  const [video, audio] = await Promise.all([
    manifest.video ? openTrack(manifest.video, fetcher, signal) : null,
    manifest.audio ? openTrack(manifest.audio, fetcher, signal) : null,
  ]);
  const end = (reader: TrackReader | null) => {
    const last = reader?.segments[reader.segments.length - 1];
    return last ? last.time + last.duration : 0;
  };
  return { duration: manifest.duration || Math.max(end(video), end(audio)), video, audio };
}

/** A DASH manifest on this server (e.g. a Plex transcode session), segments read as playback needs them. */
export function dashManifestSource(manifestUrl: string, onError?: (error: unknown) => boolean): EngineSource {
  return { id: manifestUrl, open: (signal) => openDash(manifestUrl, httpGet, signal), onError };
}
