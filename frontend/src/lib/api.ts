/**
 * Typed fetchers for the orchestrator REST API. All paths are relative:
 * the Vite dev server proxies them to FastAPI, and the production build is
 * served by FastAPI itself.
 */

import type { TelemetryEvent } from "../types/telemetry";

export interface ProfileInfo {
  name: string;
  description: string;
  seed: number;
  faults: { type: string; probability: number }[];
}

export interface RunStatusInfo {
  run_id: string;
  profile: string;
  n_agents: number;
  with_control: boolean;
  status: "pending" | "running" | "finished" | "failed";
  started_at: string | null;
  finished_at: string | null;
  error: string | null;
  agents: Record<
    string,
    { status: string; step: number | null; faults: number; recoveries: number }
  >;
}

export interface Scorecard {
  run_id: string;
  profile: string;
  n_agents: number;
  // Behavioral tier (always present).
  mttr_steps: number | null;
  recovery_breakdown: Record<string, number>;
  waste_factor: number | null;
  failure_modes: Record<string, number>;
  crash_rate: number;
  latency_degradation: number | null;
  // Oracle-gated tier (null + reason when no/ineligible oracle).
  survival_rate: number | null;
  survival_rate_reason: string | null;
  deception_detection_rate: number | null;
  deception_detection_rate_reason: string | null;
  oracle: string | null;
  control_run_id: string | null;
  per_agent: Record<
    string,
    {
      outcome: string;
      success: boolean | null;
      tokens_used: number;
      steps_taken: number;
      faults: string[];
      recoveries: string[];
    }
  >;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const resp = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    ...init,
  });
  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    throw new ApiError(resp.status, `${resp.status} ${path}: ${body}`);
  }
  return (await resp.json()) as T;
}

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** Full RunListEntry matching the backend RunListEntry model. */
export interface RunListEntry {
  run_id: string;
  profile: string;
  n_agents: number;
  status: "pending" | "running" | "finished" | "failed" | "archived";
  started_at: string | null;
  finished_at: string | null;
  has_scorecard: boolean;
  survival_pct: number | null;
}

export function fetchProfiles(): Promise<ProfileInfo[]> {
  return request<ProfileInfo[]>("/profiles");
}

export function fetchRunList(): Promise<RunListEntry[]> {
  return request<RunListEntry[]>("/runs");
}

export function startRun(body: {
  profile: string;
  n_agents?: number;
  seed_override?: number;
  with_control?: boolean;
}): Promise<{ run_id: string }> {
  return request<{ run_id: string }>("/runs", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export function fetchRunStatus(runId: string): Promise<RunStatusInfo> {
  return request<RunStatusInfo>(`/runs/${encodeURIComponent(runId)}`);
}

export function fetchScorecard(runId: string): Promise<Scorecard> {
  return request<Scorecard>(`/runs/${encodeURIComponent(runId)}/scorecard`);
}

/** Full event history for replay. The backend paginates; pull everything. */
export async function fetchAllEvents(runId: string): Promise<TelemetryEvent[]> {
  const all: TelemetryEvent[] = [];
  let afterTs: string | null = null;
  const limit = 1000;
  for (;;) {
    const params = new URLSearchParams({ limit: String(limit) });
    if (afterTs) params.set("after_ts", afterTs);
    const page = await request<TelemetryEvent[]>(
      `/runs/${encodeURIComponent(runId)}/events?${params.toString()}`,
    );
    all.push(...page);
    if (page.length < limit) return all;
    afterTs = page[page.length - 1].ts;
  }
}

// ---------------------------------------------------------------------------
// Run management (DELETE, downloads)
// ---------------------------------------------------------------------------

/** Delete a single run and its artifacts. Returns 204 on success. */
export async function deleteRun(runId: string): Promise<void> {
  const resp = await fetch(`/runs/${encodeURIComponent(runId)}`, {
    method: "DELETE",
  });
  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    throw new ApiError(resp.status, `${resp.status}: ${body}`);
  }
}

/** Cancel a running or pending run. */
export async function cancelRun(runId: string): Promise<void> {
  const resp = await fetch(`/runs/${encodeURIComponent(runId)}/cancel`, {
    method: "POST",
  });
  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    throw new ApiError(resp.status, `${resp.status}: ${body}`);
  }
}

/** Bulk-delete all finished runs. Returns the count deleted. */
export async function bulkDeleteRuns(): Promise<{ deleted: number }> {
  return request<{ deleted: number }>("/runs?status=finished", {
    method: "DELETE",
  });
}

/** Direct download URL for a run's JSONL event log. */
export function downloadJsonlUrl(runId: string): string {
  return `/runs/${encodeURIComponent(runId)}/download/jsonl`;
}

/** Direct download URL for a run's scorecard JSON. */
export function downloadScorecardUrl(runId: string): string {
  return `/runs/${encodeURIComponent(runId)}/download/scorecard`;
}
