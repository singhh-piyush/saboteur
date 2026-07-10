
import type { TelemetryEvent } from "../types/telemetry";

function apiBase(): string {
  const base = (import.meta.env.VITE_API_BASE_URL as string | undefined) ?? "";
  return base.replace(/\/+$/, "");
}

export function apiUrl(path: string): string {
  return `${apiBase()}${path}`;
}

export function wsUrl(runId: string): string {
  const base = apiBase();
  const origin = base !== "" ? base : `${window.location.protocol}//${window.location.host}`;
  return `${origin.replace(/^http/, "ws")}/ws/${encodeURIComponent(runId)}`;
}

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
  mttr_steps: number | null;
  recovery_breakdown: Record<string, number>;
  waste_factor: number | null;
  failure_modes: Record<string, number>;
  crash_rate: number;
  latency_degradation: number | null;
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
  const resp = await fetch(apiUrl(path), {
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


let OFFLINE = false;
const OFFLINE_RUNS = new Map<string, { scorecard: Scorecard; events: TelemetryEvent[] }>();

const OFFLINE_OWNERS = new Set<symbol>();

export function acquireOffline(token: symbol): void {
  OFFLINE_OWNERS.add(token);
  OFFLINE = true;
}

export function releaseOffline(token: symbol): void {
  OFFLINE_OWNERS.delete(token);
  if (OFFLINE_OWNERS.size === 0) {
    OFFLINE = false;
    OFFLINE_RUNS.clear();
  }
}

export function registerOfflineRun(
  id: string,
  scorecard: Scorecard,
  events: TelemetryEvent[],
): void {
  OFFLINE_RUNS.set(id, { scorecard, events });
}

/** matches the backend RunListEntry model */
export interface RunListEntry {
  run_id: string;
  target: string;
  profile: string;
  n_agents: number;
  status: "pending" | "running" | "finished" | "failed" | "archived";
  started_at: string | null;
  finished_at: string | null;
  has_scorecard: boolean;
  survival_pct: number | null;
}

export interface RunListFilters {
  target?: string;
  profile?: string;
  status?: string;
  date_from?: string;
  date_to?: string;
}

export function fetchProfiles(): Promise<ProfileInfo[]> {
  return request<ProfileInfo[]>("/profiles");
}

export function fetchRunList(filters?: RunListFilters): Promise<RunListEntry[]> {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(filters ?? {})) {
    if (v) params.set(k, v);
  }
  const qs = params.toString();
  return request<RunListEntry[]>(qs ? `/runs?${qs}` : "/runs");
}

export function startRun(body: {
  profile: string;
  target?: string;
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
  const offline = OFFLINE_RUNS.get(runId);
  if (offline) return Promise.resolve(offline.scorecard);
  if (OFFLINE) {
    return Promise.reject(new ApiError(404, `${runId}: no offline scorecard`));
  }
  return request<Scorecard>(`/runs/${encodeURIComponent(runId)}/scorecard`);
}

export async function fetchAllEvents(runId: string): Promise<TelemetryEvent[]> {
  const offline = OFFLINE_RUNS.get(runId);
  if (offline) return offline.events;
  if (OFFLINE) {
    throw new ApiError(404, `${runId}: no offline events`);
  }
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


export async function deleteRun(runId: string): Promise<void> {
  const resp = await fetch(apiUrl(`/runs/${encodeURIComponent(runId)}`), {
    method: "DELETE",
  });
  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    throw new ApiError(resp.status, `${resp.status}: ${body}`);
  }
}

export async function cancelRun(runId: string): Promise<void> {
  if (OFFLINE) return;
  const resp = await fetch(apiUrl(`/runs/${encodeURIComponent(runId)}/cancel`), {
    method: "POST",
  });
  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    throw new ApiError(resp.status, `${resp.status}: ${body}`);
  }
}

export async function bulkDeleteRuns(): Promise<{ deleted: number }> {
  return request<{ deleted: number }>("/runs?status=finished", {
    method: "DELETE",
  });
}

export function downloadJsonlUrl(runId: string): string {
  return apiUrl(`/runs/${encodeURIComponent(runId)}/download/jsonl`);
}

export function downloadScorecardUrl(runId: string): string {
  return apiUrl(`/runs/${encodeURIComponent(runId)}/download/scorecard`);
}


export function startProxyRun(body: {
  profile: string;
  n_agents?: number;
  capture_all?: boolean;
}): Promise<{ run_id: string }> {
  return request<{ run_id: string }>("/proxy/runs", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export function fetchCaptureStatus(): Promise<{ run_id: string | null }> {
  return request<{ run_id: string | null }>("/proxy/capture");
}

export function finishProxyRun(runId: string): Promise<{ status: string; run_id: string }> {
  return request<{ status: string; run_id: string }>(
    `/proxy/runs/${encodeURIComponent(runId)}/finish`,
    { method: "POST" },
  );
}


export type OracleKind = "none" | "regex" | "command" | "http";

export interface OracleConfig {
  kind: OracleKind;
  pattern?: string | null;
  command?: string | null;
  url?: string | null;
}

export interface Target {
  name: string;
  kind: "reference" | "command";
  cmd?: string[] | null;
  cwd?: string | null;
  env?: Record<string, string>;
  oracle?: OracleConfig;
}

export function fetchTargets(): Promise<Target[]> {
  return request<Target[]>("/targets");
}

export function createTarget(target: Target): Promise<Target> {
  return request<Target>("/targets", {
    method: "POST",
    body: JSON.stringify(target),
  });
}

export function updateTarget(name: string, target: Target): Promise<Target> {
  return request<Target>(`/targets/${encodeURIComponent(name)}`, {
    method: "PUT",
    body: JSON.stringify(target),
  });
}

export async function deleteTarget(name: string): Promise<void> {
  const resp = await fetch(apiUrl(`/targets/${encodeURIComponent(name)}`), {
    method: "DELETE",
  });
  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    throw new ApiError(resp.status, `${resp.status}: ${body}`);
  }
}


export type ParamKind = "range" | "int" | "float" | "int_list";

export interface ParamSpec {
  name: string;
  kind: ParamKind;
  required: boolean;
  default: unknown;
}

export interface FaultCatalogEntry {
  type: string;
  layer: "tool" | "transport" | "context";
  required: string[];
  params: ParamSpec[];
}

/** one fault entry in a profile draft; validated server-side */
export type FaultDraft = Record<string, unknown> & { type: string; probability: number };

export interface ProfileDraft {
  name: string;
  seed: number;
  description: string;
  faults: FaultDraft[];
}

export interface ValidationItem {
  loc: string;
  msg: string;
}

export interface ValidationResult {
  valid: boolean;
  errors: ValidationItem[];
}

/** full saved profile, for loading into the builder */
export interface FullProfile {
  name: string;
  seed: number;
  description: string;
  faults: Record<string, unknown>[];
}

export function fetchFaults(): Promise<FaultCatalogEntry[]> {
  return request<FaultCatalogEntry[]>("/faults");
}

export function fetchProfile(name: string): Promise<FullProfile> {
  return request<FullProfile>(`/profiles/${encodeURIComponent(name)}`);
}

export function validateProfile(draft: ProfileDraft): Promise<ValidationResult> {
  return request<ValidationResult>("/profiles/validate", {
    method: "POST",
    body: JSON.stringify(draft),
  });
}

export function saveProfile(draft: ProfileDraft): Promise<ProfileInfo> {
  return request<ProfileInfo>("/profiles", {
    method: "POST",
    body: JSON.stringify(draft),
  });
}

export async function deleteProfile(name: string): Promise<void> {
  const resp = await fetch(apiUrl(`/profiles/${encodeURIComponent(name)}`), {
    method: "DELETE",
  });
  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    throw new ApiError(resp.status, `${resp.status}: ${body}`);
  }
}


export interface MetricDelta {
  a: number | null;
  b: number | null;
  delta: number | null;
  regressed: boolean;
  higher_is_better: boolean;
  threshold: number;
}

export interface RunComparison {
  a: string;
  b: string;
  metrics: Record<string, MetricDelta>;
  regressions: string[];
}

export function fetchComparison(a: string, b: string): Promise<RunComparison> {
  const params = new URLSearchParams({ a, b });
  return request<RunComparison>(`/runs/compare?${params.toString()}`);
}
