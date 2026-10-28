import { request } from "../api/http";
import type { Job, MediaRef } from "../api/types";

export const preparationApi = {
  create: (ref: MediaRef, signal?: AbortSignal) =>
    request<Job>("/api/jobs", { method: "POST", body: JSON.stringify({ source: ref.source, id: ref.id }), signal }),
  get: (jobId: string, signal?: AbortSignal) => request<Job>(`/api/jobs/${encodeURIComponent(jobId)}`, { signal }),
  cancel: (jobId: string) => request<Job>(`/api/jobs/${encodeURIComponent(jobId)}`, { method: "DELETE" }),
};
