import { query, request } from "../api/http";
import type { Me, Page } from "../api/types";

export type PersonalFeed = "recommended" | "subscriptions" | "history" | "watch_later" | "liked";

export const accountApi = {
  me: (signal?: AbortSignal) => request<Me>("/api/me", { signal }),
  feed: (feed: PersonalFeed, offset = 0, signal?: AbortSignal) =>
    request<Page>(`/api/me/feed/${feed}${query({ offset })}`, { signal }),
};
