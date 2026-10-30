import { request } from "@/api/http";

export interface PairingStatus {
  /** Accounts are on: devices are paired to the account that approves them. */
  accounts?: boolean;
  /** This computer: never needs pairing. */
  local: boolean;
  paired: boolean;
  /** The server holds private data, so other devices must be paired first. */
  required: boolean;
  device: string | null;
}

export interface PairingRequest {
  id: string;
  code: string;
  name: string;
  expires_at: number;
  approved: boolean;
}

export interface PairedDevice {
  id: string;
  name: string;
  created: number;
  last_seen: number;
}

const BASE = "/api/pairing";

export const pairingApi = {
  status: (signal?: AbortSignal) => request<PairingStatus>(`${BASE}/status`, { signal }),
  start: (name: string | null) => request<PairingRequest>(`${BASE}/requests`, { method: "POST", body: JSON.stringify({ name }) }),
  check: (id: string, signal?: AbortSignal) => request<{ state: "waiting" | "paired" | "expired" }>(`${BASE}/requests/${encodeURIComponent(id)}`, { signal }),
  approve: (code: string) => request<PairingRequest>(`${BASE}/approve`, { method: "POST", body: JSON.stringify({ code }) }),
  devices: (signal?: AbortSignal) =>
    request<{ devices: PairedDevice[]; requests: PairingRequest[]; current?: string | null }>(`${BASE}/devices`, { signal }),
  revoke: (id: string) => request<{ ok: boolean }>(`${BASE}/devices/${encodeURIComponent(id)}`, { method: "DELETE" }),
  /** A device paired to an account signs itself out. */
  forget: () => request<{ ok: boolean }>(`${BASE}/forget`, { method: "POST" }),
};
