
import type { AgentState, RunViewState, TerminalMark } from "./reducer";

export function agentList(state: RunViewState): AgentState[] {
  return Object.values(state.agents).sort((a, b) => a.id - b.id);
}

export interface RunCounts {
  total: number;
  healthy: number;
  recovering: number;
  crashed: number;
  succeeded: number;
  done: number;
  pending: number;
  faults: number;
}

export function runCounts(state: RunViewState): RunCounts {
  const counts: RunCounts = {
    total: 0,
    healthy: 0,
    recovering: 0,
    crashed: 0,
    succeeded: 0,
    done: 0,
    pending: 0,
    faults: 0,
  };
  for (const agent of Object.values(state.agents)) {
    counts.total += 1;
    counts[agent.status] += 1;
    counts.faults += agent.faultCount;
  }
  return counts;
}

/** survival-over-time series: sampled at each terminal event */
export interface SurvivalPoint {
  /** seconds since the first terminal mark */
  t: number;
  /** cumulative succeeded count */
  succeeded: number;
  /** cumulative terminal count */
  done: number;
}

export function survivalSeries(terminals: TerminalMark[]): SurvivalPoint[] {
  if (terminals.length === 0) return [];
  const sorted = [...terminals].sort(
    (a, b) => Date.parse(a.ts) - Date.parse(b.ts),
  );
  const t0 = Date.parse(sorted[0].ts);
  let ok = 0;
  return sorted.map((mark, i) => {
    if (mark.ok) ok += 1;
    return {
      t: Math.round((Date.parse(mark.ts) - t0) / 100) / 10,
      succeeded: ok,
      done: i + 1,
    };
  });
}

export function recoveryBreakdown(state: RunViewState): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const agent of Object.values(state.agents)) {
    for (const ev of agent.events) {
      if (ev.event === "recovery_action" && ev.recovery) {
        counts[ev.recovery] = (counts[ev.recovery] ?? 0) + 1;
      }
    }
  }
  return counts;
}

export function totalTokens(state: RunViewState): number {
  let sum = 0;
  for (const agent of Object.values(state.agents)) sum += agent.tokensUsed ?? 0;
  return sum;
}

export function survivalRate(state: RunViewState): number | null {
  const agents = Object.values(state.agents);
  if (agents.length === 0) return null;
  const judged = agents.some((a) => a.success !== null);
  if (!judged) return null;
  const ok = agents.filter((a) => a.status === "succeeded").length;
  return ok / agents.length;
}
