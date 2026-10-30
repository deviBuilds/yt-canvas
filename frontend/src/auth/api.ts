import { request } from "@/api/http";

export interface AuthConfig {
  /** Accounts are on: everyone signs in with Clerk (or pairs a device to their account). */
  accounts: boolean;
  clerk_publishable_key?: string;
  clerk_frontend_api?: string;
}

export interface AccountUser {
  email: string;
  name: string | null;
  image_url: string | null;
  admin: boolean;
  /** "clerk": signed in here; "device": a device paired to the account. */
  via: "clerk" | "device";
  device: string | null;
}

/** What an upload was read as; it's always stored as a Netscape cookies.txt. */
export type CookieFormat = "netscape" | "json" | "header";

export interface AllowlistEntry {
  email: string;
  addedBy: string | null;
  addedAt: number;
  admin: boolean;
}

export const authApi = {
  config: (signal?: AbortSignal) => request<AuthConfig>("/api/auth/config", { signal }),
  me: (signal?: AbortSignal) => request<AccountUser>("/api/auth/me", { signal }),
  uploadCookies: (text: string) =>
    request<{ ok: boolean; count: number; uploaded_at: number; format: CookieFormat }>("/api/me/cookies", {
      method: "PUT",
      body: text,
      headers: { "Content-Type": "text/plain" },
    }),
  deleteCookies: () => request<{ ok: boolean }>("/api/me/cookies", { method: "DELETE" }),
  renewCookies: () =>
    request<{ ok: boolean; renewed_at: number; refreshed: string[] }>("/api/me/cookies/renew", { method: "POST" }),
  allowlist: (signal?: AbortSignal) => request<{ entries: AllowlistEntry[] }>("/api/admin/allowlist", { signal }),
  allow: (emails: string[]) =>
    request<{ added: number }>("/api/admin/allowlist", { method: "POST", body: JSON.stringify({ emails }) }),
  disallow: (email: string) =>
    request<{ ok: boolean }>(`/api/admin/allowlist/${encodeURIComponent(email)}`, { method: "DELETE" }),
};
