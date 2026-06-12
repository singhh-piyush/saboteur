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
  survival_rate: number;
  mttr_steps: number | null;
  recovery_breakdown: Record<string, number>;
  waste_factor: number | null;
  deception_detection_rate: number | null;
  failure_modes: Record<string, number>;
  control_run_id: string | null;
  per_agent: Record<
    string,
    {
      outcome: string;
      success: boolean;
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

export interface RunListEntry {
  run_id: string;
  profile: string;
  status: "pending" | "running" | "finished" | "failed" | "archived";
  has_scorecard: boolean;
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
