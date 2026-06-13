/**
 * The event-sourced core (invariant #3): one pure reducer consumes
 * TelemetryEvents — from the live WebSocket or from a replayed JSONL — and
 * derives ALL view state. Live and replay are indistinguishable by
 * construction: same events in, same state out (literally tested in
 * reducer.test.ts).
 *
 * Idempotency: the reducer deduplicates events by identity (ts + agent_id +
 * step + event + fault + recovery) so a reconnect that re-sends the JSONL
 * backlog produces ZERO state changes and zero re-renders. The `_seen` set
 * is cleared on `reset`.
 */

import type { TelemetryEvent } from "../types/telemetry";

// ---------------------------------------------------------------------------
// State shapes
// ---------------------------------------------------------------------------

export type AgentStatus =
  | "pending" // cell exists (run_started said N agents) but no events yet
  | "healthy"
  | "recovering" // fault seen, not yet resolved
  | "crashed" // agent_crashed, or agent_done with success=false
  | "succeeded";

export type ConnStatus =
  | "idle"
  | "connecting"
  | "live"
  | "reconnecting"
  | "complete"  // stream finished cleanly — no reconnect
  | "offline"   // max retries exhausted
  | "replay";

export interface AgentState {
  id: number;
  status: AgentStatus;
  /** Highest step number seen for this agent. */
  step: number;
  faultCount: number;
  recoveryCount: number;
  /** Unresolved fault type, cleared by a recovery or a clean tool call. */
  activeFault: string | null;
  outcome: string | null;
  success: boolean | null;
  tokensUsed: number | null;
  /** Bumps on every visible state change — keys the cell pulse animation. */
  seq: number;
  /** Full per-agent event trace, in arrival order (timeline drawer). */
  events: TelemetryEvent[];
}

export interface ChaosLogEntry {
  id: number; // monotonic, for React keys
  ts: string;
  agentId: number;
  fault: string;
  step: number | null;
  detail: string;
}

export interface TerminalMark {
  ts: string;
  agentId: number;
  ok: boolean;
}

export interface RunViewState {
  runId: string | null;
  profile: string | null;
  seed: number | null;
  nAgents: number;
  finished: boolean;
  agents: Record<number, AgentState>;
  /** Newest-first feed of fault injections, capped. */
  chaosLog: ChaosLogEntry[];
  /** agent_done / agent_crashed marks, for the survival-over-time line. */
  terminals: TerminalMark[];
  eventCount: number;
  conn: ConnStatus;
  /** Dedup set: event identity → true. Prevents backlog replay re-renders. */
  _seen: Set<string>;
}

export type Action =
  | { type: "event"; event: TelemetryEvent }
  | { type: "reset" }
  | { type: "conn"; conn: ConnStatus };

const CHAOS_LOG_CAP = 200;

export const initialState: RunViewState = {
  runId: null,
  profile: null,
  seed: null,
  nAgents: 0,
  finished: false,
  agents: {},
  chaosLog: [],
  terminals: [],
  eventCount: 0,
  conn: "idle",
  _seen: new Set(),
};

// ---------------------------------------------------------------------------
// Event identity for deduplication
// ---------------------------------------------------------------------------

/** Stable identity matching the backend's _Identity tuple in ws.py. */
function eventIdentity(ev: TelemetryEvent): string {
  return `${ev.ts}|${ev.agent_id}|${ev.step ?? ""}|${ev.event}|${ev.fault ?? ""}|${ev.recovery ?? ""}`;
}

// ---------------------------------------------------------------------------
// Reducer
// ---------------------------------------------------------------------------

export function reduce(state: RunViewState, action: Action): RunViewState {
  switch (action.type) {
    case "reset":
      // Keep the connection status: reset fires on (re)connect, right before
      // the backlog replays.
      return { ...initialState, conn: state.conn, _seen: new Set() };
    case "conn":
      return { ...state, conn: action.conn };
    case "event":
      return applyEvent(state, action.event);
  }
}

/** Fold a full event log into a view state (scorecard view + tests). */
export function foldEvents(events: TelemetryEvent[]): RunViewState {
  return events.reduce(
    (state, event) => reduce(state, { type: "event", event }),
    initialState,
  );
}

function applyEvent(state: RunViewState, ev: TelemetryEvent): RunViewState {
  // --- Idempotency: deduplicate by event identity ---
  const id = eventIdentity(ev);
  if (state._seen.has(id)) {
    // Already processed — return the SAME reference so React skips re-render.
    return state;
  }
  // Mutating the set is safe: we always spread into a new state object below,
  // and the set is never read by React for rendering.
  const seen = new Set(state._seen);
  seen.add(id);

  const next: RunViewState = { ...state, eventCount: state.eventCount + 1, _seen: seen };

  if (ev.agent_id < 0) {
    if (ev.event === "run_started") {
      const n = asNumber(ev.payload["n_agents"]) ?? 0;
      const agents: Record<number, AgentState> = {};
      for (let i = 0; i < n; i++) agents[i] = freshAgent(i);
      return {
        ...next,
        runId: ev.run_id,
        profile: asString(ev.payload["profile"]),
        seed: asNumber(ev.payload["seed"]),
        nAgents: n,
        finished: false,
        agents,
      };
    }
    if (ev.event === "run_finished") {
      return { ...next, finished: true };
    }
    return next;
  }

  const prev = state.agents[ev.agent_id] ?? freshAgent(ev.agent_id);
  const agent = transition(prev, ev);
  next.agents = { ...state.agents, [ev.agent_id]: agent };
  next.nAgents = Math.max(state.nAgents, ev.agent_id + 1);

  if (ev.event === "fault_injected" && ev.fault) {
    const entry: ChaosLogEntry = {
      id: next.eventCount,
      ts: ev.ts,
      agentId: ev.agent_id,
      fault: ev.fault,
      step: ev.step,
      detail: describeFault(ev),
    };
    next.chaosLog = [entry, ...state.chaosLog].slice(0, CHAOS_LOG_CAP);
  }

  if (ev.event === "agent_done" || ev.event === "agent_crashed") {
    next.terminals = [
      ...state.terminals,
      {
        ts: ev.ts,
        agentId: ev.agent_id,
        ok: ev.event === "agent_done" && ev.payload["success"] === true,
      },
    ];
  }

  return next;
}

// ---------------------------------------------------------------------------
// Per-agent transition rules
// ---------------------------------------------------------------------------

function transition(prev: AgentState, ev: TelemetryEvent): AgentState {
  const agent: AgentState = { ...prev, events: [...prev.events, ev] };
  const terminal = prev.status === "crashed" || prev.status === "succeeded";
  if (ev.step !== null) agent.step = Math.max(agent.step, ev.step);

  switch (ev.event) {
    case "step_start":
      if (!terminal && prev.status === "pending") setStatus(agent, "healthy");
      break;

    case "tool_call": {
      // A clean (unsabotaged, unerrored) call after a fault means the agent
      // is making progress again, even before a classified recovery arrives.
      const clean =
        ev.payload["sabotaged"] === false && ev.payload["errored"] !== true;
      if (!terminal) {
        if (prev.status === "pending") setStatus(agent, "healthy");
        if (prev.status === "recovering" && clean) {
          setStatus(agent, "healthy");
          agent.activeFault = null;
        }
      }
      break;
    }

    case "fault_injected":
      agent.faultCount = prev.faultCount + 1;
      agent.activeFault = ev.fault;
      if (!terminal) setStatus(agent, "recovering");
      else agent.seq = prev.seq + 1; // badge still updates post-terminal
      break;

    case "recovery_action":
      // `no_action` is a stall (no tool call / parse failure), not a
      // productive recovery: don't count it, don't clear the fault, and leave
      // the agent in `recovering` — it hasn't actually recovered yet.
      if (ev.recovery === "no_action") break;
      agent.recoveryCount = prev.recoveryCount + 1;
      agent.activeFault = null;
      if (!terminal) setStatus(agent, "healthy");
      break;

    case "agent_done": {
      const success = ev.payload["success"] === true;
      agent.outcome = asString(ev.payload["outcome"]);
      agent.success = success;
      agent.tokensUsed = ev.tokens_used;
      setStatus(agent, success ? "succeeded" : "crashed");
      break;
    }

    case "agent_crashed":
      agent.outcome = agent.outcome ?? "hard_exception";
      agent.success = false;
      setStatus(agent, "crashed");
      break;

    default:
      break;
  }
  return agent;
}

function setStatus(agent: AgentState, status: AgentStatus): void {
  if (agent.status !== status) {
    agent.status = status;
    agent.seq += 1;
  }
}

function freshAgent(id: number): AgentState {
  return {
    id,
    status: "pending",
    step: 0,
    faultCount: 0,
    recoveryCount: 0,
    activeFault: null,
    outcome: null,
    success: null,
    tokensUsed: null,
    seq: 0,
    events: [],
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function describeFault(ev: TelemetryEvent): string {
  const detail = ev.payload["detail"];
  const tool = ev.payload["tool"];
  const parts: string[] = [];
  if (typeof tool === "string" && tool) parts.push(tool);
  if (detail && typeof detail === "object") {
    const d = detail as Record<string, unknown>;
    if (typeof d["retry_after_s"] === "number")
      parts.push(`retry-after ${d["retry_after_s"]}s`);
    if (typeof d["status_code"] === "number") parts.push(`HTTP ${d["status_code"]}`);
    if (typeof d["delay_s"] === "number") parts.push(`+${d["delay_s"]}s`);
    if (typeof d["dropped"] === "number") parts.push(`dropped ${d["dropped"]} steps`);
  }
  return parts.join(" · ");
}

function asString(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

function asNumber(v: unknown): number | null {
  return typeof v === "number" ? v : null;
}
