import type { ErrorInfo } from "./types";

/** An error from our backend (or the network), always with a user-facing message. */
export class ApiError extends Error {
  readonly status: number;
  readonly info: ErrorInfo;

  constructor(status: number, info: ErrorInfo) {
    super(info.message);
    this.name = "ApiError";
    this.status = status;
    this.info = info;
  }

  get isNetwork(): boolean {
    return this.status === 0;
  }
}

function errorInfoFrom(body: unknown, status: number): ErrorInfo {
  if (body && typeof body === "object" && "error" in body) {
    const err = (body as { error: Partial<ErrorInfo> }).error;
    if (err && typeof err.message === "string") {
      return {
        code: typeof err.code === "string" ? err.code : "error",
        message: err.message,
        hint: typeof err.hint === "string" ? err.hint : null,
        retryable: Boolean(err.retryable),
      };
    }
  }
  return {
    code: status >= 500 ? "server_error" : "error",
    message: status >= 500 ? "The server ran into a problem." : `Request failed (${status}).`,
    hint: status === 502 || status === 504 ? "Is the backend running? Start it with `make dev`." : null,
    retryable: status >= 500,
  };
}

export async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      ...init,
      headers: { Accept: "application/json", ...(init.body ? { "Content-Type": "application/json" } : {}), ...init.headers },
    });
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") throw err;
    throw new ApiError(0, {
      code: "network_error",
      message: "Can't reach the yt-canvas server.",
      hint: "Check that the backend is running and try again.",
      retryable: true,
    });
  }
  const text = await response.text();
  let body: unknown = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = null;
    }
  }
  if (!response.ok) throw new ApiError(response.status, errorInfoFrom(body, response.status));
  return body as T;
}

export function query(params: Record<string, string | number | null | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== null && value !== undefined && value !== "") search.set(key, String(value));
  }
  const text = search.toString();
  return text ? `?${text}` : "";
}
