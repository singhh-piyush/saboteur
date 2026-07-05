/**
 * Typed fetchers for the orchestrator REST API. Paths are same-origin by
 * default: the Vite dev server proxies them to FastAPI, and the production
 * build is served by FastAPI itself. When the API lives elsewhere (split
 * ports, SSH tunnels, a static deploy), set VITE_API_BASE_URL and every
 * request - REST and WebSocket - is rebased onto it.
 */

import type { TelemetryEvent } from "../types/telemetry";

/** The configured API origin, "" = same-origin (the default). Read at call
 * time so tests can stub the env without re-importing the module. */
function apiBase(): string {
  const base = (import.meta.env.VITE_API_BASE_URL as string | undefined) ?? "";
  return base.replace(/\/+$/, "");
}

/** Prefix an API path with the configured base (no-op when same-origin). */
export function apiUrl(path: string): string {
  return `${apiBase()}${path}`;
}

/** WebSocket URL for a run's telemetry channel, derived from the API base
 * (http→ws / https→wss) or from the page origin when same-origin. */
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

// ---------------------------------------------------------------------------
// Offline mode (static walkthrough deploy - no backend)
// ---------------------------------------------------------------------------
//
// The static walkthrough serves a recorded run with no FastAPI behind it. To
// keep the reused `ScorecardView` byte-identical (it statically imports
// `fetchScorecard` / `fetchAllEvents`), we intercept those reads here instead
// of editing the component: a registered run resolves from bundled data, and
// any other read is refused WITHOUT touching the network while offline. Live
// behavior is unchanged when `OFFLINE` is false (the default).

let OFFLINE = false;
const OFFLINE_RUNS = new Map<string, { scorecard: Scorecard; events: TelemetryEvent[] }>();

// Offline mode is reference-counted by owner token (one per mounted walkthrough
// provider). A keyed remount (switching model family) mounts the new provider
// BEFORE the old one's deferred teardown runs; with a naive boolean + global
// clear, that stale teardown wiped the new provider's just-registered runs and
// flipped offline off, so the end-of-tour scorecard escaped to the network and
// 404'd. Counting owners keeps offline on (and the runs map intact) as long as
// any provider is mounted - the map is cleared only when the LAST owner leaves.
const OFFLINE_OWNERS = new Set<symbol>();

/** Acquire offline mode for an owner token (idempotent per token, so a provider
 * may call it from both render and its mount effect). */
export function acquireOffline(token: symbol): void {
  OFFLINE_OWNERS.add(token);
  OFFLINE = true;
}

/** Release an owner's hold on offline mode. Only when no owners remain does
 * offline turn off and the registered runs get cleared. */
export function releaseOffline(token: symbol): void {
  OFFLINE_OWNERS.delete(token);
  if (OFFLINE_OWNERS.size === 0) {
    OFFLINE = false;
    OFFLINE_RUNS.clear();
  }
}

/** Register a run's bundled scorecard + events so the reused views resolve it
 * without any network request. */
export function registerOfflineRun(
  id: string,
  scorecard: Scorecard,
  events: TelemetryEvent[],
): void {
  OFFLINE_RUNS.set(id, { scorecard, events });
}

/** Full RunListEntry matching the backend RunListEntry model. */
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

/** Full event history for replay. The backend paginates; pull everything. */
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

// ---------------------------------------------------------------------------
// Run management (DELETE, downloads)
// ---------------------------------------------------------------------------

/** Delete a single run and its artifacts. Returns 204 on success. */
export async function deleteRun(runId: string): Promise<void> {
  const resp = await fetch(apiUrl(`/runs/${encodeURIComponent(runId)}`), {
    method: "DELETE",
  });
  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    throw new ApiError(resp.status, `${resp.status}: ${body}`);
  }
}

/** Cancel a running or pending run. */
export async function cancelRun(runId: string): Promise<void> {
  // Offline (walkthrough): there is nothing to stop and no backend to call.
  if (OFFLINE) return;
  const resp = await fetch(apiUrl(`/runs/${encodeURIComponent(runId)}/cancel`), {
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
  return apiUrl(`/runs/${encodeURIComponent(runId)}/download/jsonl`);
}

/** Direct download URL for a run's scorecard JSON. */
export function downloadScorecardUrl(runId: string): string {
  return apiUrl(`/runs/${encodeURIComponent(runId)}/download/scorecard`);
}

// ---------------------------------------------------------------------------
// Wire proxy (capture-all "sabotage my agent" mode)
// ---------------------------------------------------------------------------

/** Start a proxy run. With `capture_all`, headerless /v1 traffic is absorbed
 * into it - point any agent's OPENAI_BASE_URL at the proxy and it renders live. */
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

/** The run currently absorbing headerless /v1 traffic (run_id null = none). */
export function fetchCaptureStatus(): Promise<{ run_id: string | null }> {
  return request<{ run_id: string | null }>("/proxy/capture");
}

/** Finish a proxy run: emit terminals, score, persist the scorecard. */
export function finishProxyRun(runId: string): Promise<{ status: string; run_id: string }> {
  return request<{ status: string; run_id: string }>(
    `/proxy/runs/${encodeURIComponent(runId)}/finish`,
    { method: "POST" },
  );
}

// ---------------------------------------------------------------------------
// Targets (registry of runnable agents)
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Profile builder (fault catalog + validate + save)
// ---------------------------------------------------------------------------

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

/** One fault entry in a profile draft. Loose record: validated server-side. */
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

/** A full saved profile (every fault field), for loading into the builder. */
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

// ---------------------------------------------------------------------------
// Compare (per-metric delta between two runs)
// ---------------------------------------------------------------------------

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
