
import type { TelemetryEvent } from "../types/telemetry";


export type AgentStatus =
  | "pending" 
  | "healthy"
  | "recovering" 
  | "crashed" 
  | "succeeded" 
  | "done"; 

export type ConnStatus =
  | "idle"
  | "connecting"
  | "live"
  | "reconnecting"
  | "complete"  
  | "offline"   
  | "replay";

export interface AgentState {
  id: number;
  status: AgentStatus;
  /** highest step number seen for this agent */
  step: number;
  faultCount: number;
  recoveryCount: number;
  /** active fault type; cleared on recovery or clean tool call */
  activeFault: string | null;
  outcome: string | null;
  success: boolean | null;
  tokensUsed: number | null;
  /** bumps on each visible state change; drives the cell pulse animation key */
  seq: number;
  /** per-agent event trace in arrival order (timeline drawer) */
  events: TelemetryEvent[];
}

export interface ChaosLogEntry {
  id: number;
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
  /** newest-first fault feed, capped for rendering */
  chaosLog: ChaosLogEntry[];
  /** total fault count; keeps incrementing past the render cap */
  faultCount: number;
  /** agent_done/agent_crashed marks for the survival-over-time chart */
  terminals: TerminalMark[];
  eventCount: number;
  conn: ConnStatus;
  /** dedup set: prevents backlog replay from re-rendering seen events */
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
  faultCount: 0,
  terminals: [],
  eventCount: 0,
  conn: "idle",
  _seen: new Set(),
};


function eventIdentity(ev: TelemetryEvent): string {
  return `${ev.ts}|${ev.agent_id}|${ev.step ?? ""}|${ev.event}|${ev.fault ?? ""}|${ev.recovery ?? ""}`;
}


export function reduce(state: RunViewState, action: Action): RunViewState {
  switch (action.type) {
    case "reset":
      return { ...initialState, conn: state.conn, _seen: new Set() };
    case "conn":
      return { ...state, conn: action.conn };
    case "event":
      return applyEvent(state, action.event);
  }
}

export function foldEvents(events: TelemetryEvent[]): RunViewState {
  return events.reduce(
    (state, event) => reduce(state, { type: "event", event }),
    initialState,
  );
}

function applyEvent(state: RunViewState, ev: TelemetryEvent): RunViewState {
  const id = eventIdentity(ev);
  if (state._seen.has(id)) {
    return state;
  }
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
    next.faultCount = state.faultCount + 1;
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


function transition(prev: AgentState, ev: TelemetryEvent): AgentState {
  const agent: AgentState = { ...prev, events: [...prev.events, ev] };
  const terminal =
    prev.status === "crashed" ||
    prev.status === "succeeded" ||
    prev.status === "done";
  if (ev.step !== null) agent.step = Math.max(agent.step, ev.step);

  switch (ev.event) {
    case "step_start":
      if (!terminal && prev.status === "pending") setStatus(agent, "healthy");
      break;

    case "tool_call": {
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
      else agent.seq = prev.seq + 1; // seq bump even for terminal agents keeps the cell reactive
      break;

    case "recovery_action":
      if (ev.recovery === "no_action") break;
      agent.recoveryCount = prev.recoveryCount + 1;
      agent.activeFault = null;
      if (!terminal) setStatus(agent, "healthy");
      break;

    case "agent_done": {
      const raw = ev.payload["success"];
      const success = raw === true ? true : raw === false ? false : null;
      agent.outcome = asString(ev.payload["outcome"]);
      agent.success = success;
      agent.tokensUsed = ev.tokens_used;
      let status: AgentStatus;
      if (success === true) status = "succeeded";
      else if (success === false) status = "crashed";
      else status = agent.outcome === "completed" ? "done" : "crashed";
      setStatus(agent, status);
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
    if (typeof d["dropped_steps"] === "number")
      parts.push(`dropped ${d["dropped_steps"]} steps`);
  }
  return parts.join(" · ");
}

function asString(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

function asNumber(v: unknown): number | null {
  return typeof v === "number" ? v : null;
}
