import { query, request } from "../api/http";
import type { Health, Page, ParsedInput } from "../api/types";

export const discoveryApi = {
  resolve: (input: string, signal?: AbortSignal) =>
    request<ParsedInput>(`/api/resolve${query({ q: input })}`, { signal }),
  search: (q: string, offset = 0, signal?: AbortSignal) =>
    request<Page>(`/api/search${query({ q, offset })}`, { signal }),
  channel: (ref: string, offset = 0, signal?: AbortSignal) =>
    request<Page>(`/api/channel${query({ ref, offset })}`, { signal }),
  playlist: (id: string, offset = 0, signal?: AbortSignal) =>
    request<Page>(`/api/playlist${query({ id, offset })}`, { signal }),
  demo: (signal?: AbortSignal) => request<Page>("/api/demo", { signal }),
  health: (signal?: AbortSignal) => request<Health>("/api/health", { signal }),
};
