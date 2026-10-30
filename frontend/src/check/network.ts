/** Connection speed from this browser to the yt-canvas server, the path video will take. */

const PING_BYTES = 1024;
const DOWNLOAD_BYTES = 24 * 1024 * 1024;
const DOWNLOAD_LIMIT_MS = 8000;

export interface SpeedResult {
  /** Megabits per second, counted from the first byte. */
  mbps: number;
  bytes: number;
  seconds: number;
  /** The fastest of three tiny requests. */
  latencyMs: number;
  /** False when the time limit stopped the download early. */
  complete: boolean;
}

const url = (bytes: number) => `/api/diagnostics/speed?bytes=${bytes}`;

async function get(bytes: number, signal?: AbortSignal): Promise<Response> {
  const response = await fetch(url(bytes), { cache: "no-store", signal });
  if (!response.ok) throw new Error(`The speed test failed (${response.status}).`);
  return response;
}

export async function measureSpeed(signal?: AbortSignal): Promise<SpeedResult> {
  const pings: number[] = [];
  for (let i = 0; i < 3; i++) {
    const t = performance.now();
    await (await get(PING_BYTES, signal)).arrayBuffer();
    pings.push(performance.now() - t);
  }

  const response = await get(DOWNLOAD_BYTES, signal);
  if (!response.body) throw new Error("This browser can't read responses as they arrive.");
  const reader = response.body.getReader();
  const start = performance.now();
  let first: number | null = null;
  let bytes = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    first ??= performance.now();
    bytes += value.byteLength;
    if (performance.now() - start > DOWNLOAD_LIMIT_MS) {
      await reader.cancel();
      break;
    }
  }
  const seconds = (performance.now() - (first ?? start)) / 1000;
  return {
    mbps: Math.round((bytes * 8) / Math.max(seconds, 0.001) / 1e5) / 10,
    bytes,
    seconds: Math.round(seconds * 100) / 100,
    latencyMs: Math.round(Math.min(...pings)),
    complete: bytes >= DOWNLOAD_BYTES,
  };
}
