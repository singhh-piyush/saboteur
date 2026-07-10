
export type EventKind =
  | "step_start"
  | "tool_call"
  | "fault_injected"
  | "recovery_action"
  | "agent_done"
  | "agent_crashed"
  | "run_started"
  | "run_finished";

export interface TelemetryEvent {
  /** iso-8601 utc timestamp (pydantic datetime serialization) */
  ts: string;
  run_id: string;
  /** -1 marks run-lifecycle events (run_started / run_finished) */
  agent_id: number;
  step: number | null;
  event: EventKind;
  fault: string | null;
  recovery: string | null;
  tokens_used: number | null;
  latency_ms: number | null;
  payload: Record<string, unknown>;
}

export const FAULT_TYPES = [
  "api_error",
  "rate_limit",
  "malformed",
  "silent_lie",
  "tool_vanish",
  "latency",
  "timeout",
  "context_drop",
] as const;

export type FaultType = (typeof FAULT_TYPES)[number];
