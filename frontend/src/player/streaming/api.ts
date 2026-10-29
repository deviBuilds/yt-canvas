import { ApiError, query, request } from "../../api/http";
import type { MediaRef, StreamSession } from "../../api/types";

export const streamsApi = {
  create: (ref: MediaRef, signal?: AbortSignal) =>
    request<StreamSession>("/api/streams", { method: "POST", body: JSON.stringify({ source: ref.source, id: ref.id }), signal }),

  /** Bytes ``start``–``end`` (inclusive) of a track, proxied by the backend. */
  async range(sessionId: string, trackId: string, start: number, end: number, signal?: AbortSignal): Promise<ArrayBuffer> {
    const url = `/api/streams/${encodeURIComponent(sessionId)}/tracks/${encodeURIComponent(trackId)}${query({ start, end })}`;
    let response: Response;
    try {
      response = await fetch(url, { signal, cache: "no-store" });
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") throw err;
      throw new ApiError(0, { code: "network_error", message: "Lost contact with the server.", hint: null, retryable: true });
    }
    if (!response.ok) {
      let info = { code: "error", message: `Streaming failed (${response.status}).`, hint: null as string | null, retryable: response.status >= 500 };
      try {
        const body = (await response.json()) as { error?: typeof info };
        if (body.error?.message) info = { ...info, ...body.error };
      } catch {
        // not JSON
      }
      throw new ApiError(response.status, info);
    }
    return response.arrayBuffer();
  },
};
