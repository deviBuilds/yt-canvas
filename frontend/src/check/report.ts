import { request } from "@/api/http";

import type { BenchmarkResult } from "./benchmark";
import type { SpeedResult } from "./network";
import type { Capabilities } from "./probes";
import type { DriveLockResult, LocationResult } from "./vehicle";

/** Everything /check measured. Sent to the server so it can be read on the computer running yt-canvas. */
export interface CheckReport extends Capabilities {
  version: 1;
  takenAt: string;
  benchmark: BenchmarkResult | null;
  speed: SpeedResult | null;
  location: LocationResult | null;
  driveLock: DriveLockResult | null;
  /** Steps that failed, with their messages. */
  errors: Record<string, string>;
}

export interface SentReport {
  id: string;
  received_at: number;
}

export function sendReport(report: CheckReport): Promise<SentReport> {
  return request<SentReport>("/api/diagnostics/browser", { method: "POST", body: JSON.stringify(report) });
}
