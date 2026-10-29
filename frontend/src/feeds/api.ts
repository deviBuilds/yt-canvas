import { request } from "../api/http";
import type { Feed, FeedInfo, VideoSummary } from "../api/types";

export const feedsApi = {
  list: (signal?: AbortSignal) => request<{ feeds: FeedInfo[] }>("/api/feeds", { signal }),
  get: (id: string, signal?: AbortSignal) => request<Feed>(`/api/feeds/${encodeURIComponent(id)}`, { signal }),
  related: (videoId: string, signal?: AbortSignal) =>
    request<{ items: VideoSummary[] }>(`/api/related/${encodeURIComponent(videoId)}`, { signal }),
};
