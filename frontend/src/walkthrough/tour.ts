/**
 * The guided tour is data-driven: it scans the bundled run to pick
 * representative agents (one that recovers and survives, one that crashes, one
 * that resists a planted lie) and the event indices to seek to, then emits an
 * ordered list of beats. Swapping the run rebinds everything automatically -
 * nothing here is hardcoded to a specific agent id.
 */

import { agentLabel } from "../lib/format";
import type { Scorecard } from "../lib/api";
import type { TelemetryEvent } from "../types/telemetry";

export const REPO_URL = "https://github.com/singhh-piyush/saboteur";

export type TourTarget =
  | { kind: "region"; name: "runbar" | "grid" | "chaoslog" | "scorecard" | "timeline" | "playbar" }
  | { kind: "agent"; id: number }
  | { kind: "none" };

export type TourAction =
  | { label: string; variant: "primary" | "ghost"; kind: "exit" }
  | { label: string; variant: "primary" | "ghost"; kind: "link"; href: string };

/** Side-effect surface a beat can drive when it becomes active. */
export interface TourCtx {
  seek: (index: number) => void;
  pause: () => void;
  selectAgent: (id: number | null) => void;
  setTab: (tab: "grid" | "scorecard") => void;
}

export interface Beat {
  id: string;
  /** The phase-2 (or sole) target. Interactive beats override this with the
   * agent cell during phase 1 (handled in TourOverlay). */
  target: TourTarget;
  placement: "top" | "bottom" | "left" | "right" | "center";
  eyebrow: string;
  title: string;
  body: string;
  /** When set, the beat waits for the viewer to click this agent before
   * revealing the trace: phase 1 spotlights the cell + shows `promptBody`;
   * once clicked, phase 2 spotlights the drawer + shows `body`. */
  interactive?: { agent: number };
  /** Phase-1 call to action, shown while waiting for the click. */
  promptBody?: string;
  actions?: TourAction[];
  onEnter: (ctx: TourCtx) => void;
}

const REAL_RECOVERIES = new Set(["retry", "reformulate", "fallback_tool"]);

interface PerAgent {
  success: boolean | null;
  faults: string[];
  recoveries: string[];
}

/** Fold index (exclusive upper bound) such that folding events[0..idx) includes
 * the n-th (1-based) event matching `pred`. Falls back to the last match, or to
 * `fallback` when there is no match at all. */
function nthFoldIndex(
  events: TelemetryEvent[],
  pred: (ev: TelemetryEvent) => boolean,
  n: number,
  fallback: number,
): number {
  let count = 0;
  let lastMatch = -1;
  for (let i = 0; i < events.length; i++) {
    if (pred(events[i])) {
      lastMatch = i;
      count += 1;
      if (count === n) return i + 1;
    }
  }
  return lastMatch >= 0 ? lastMatch + 1 : fallback;
}

/** A small fold index where the cohort is visibly underway (a handful of faults
 * have landed) but nothing has finished yet - the opening shot. Also used by the
 * provider to seed the first paint so it matches the tour's first beat. All
 * cells already exist from run_started, so this is purely for visual liveness. */
export function introFoldIndex(events: TelemetryEvent[]): number {
  return nthFoldIndex(
    events,
    (ev) => ev.event === "fault_injected",
    10,
    Math.max(1, Math.round(events.length * 0.04)),
  );
}

function seedFrom(events: TelemetryEvent[]): number | null {
  const started = events.find((ev) => ev.event === "run_started");
  const seed = started?.payload?.["seed"];
  return typeof seed === "number" ? seed : null;
}

function pickAgents(perAgent: Record<string, PerAgent>): {
  recovering: number | null;
  crashed: number | null;
  deceived: number | null;
} {
  const entries = Object.entries(perAgent)
    .map(([id, a]) => ({ id: Number(id), ...a }))
    .sort((a, b) => a.id - b.id);

  const survived = entries.filter((a) => a.success === true);
  const failed = entries.filter((a) => a.success !== true);
  const realRecovery = (a: PerAgent) => a.recoveries.some((r) => REAL_RECOVERIES.has(r));

  // Recovering + survived; prefer one that was rate-limited (matches narrative).
  const recovering =
    survived.find((a) => realRecovery(a) && a.faults.includes("rate_limit"))?.id ??
    survived.find(realRecovery)?.id ??
    survived[0]?.id ??
    null;

  // Crashed; prefer a vanished-tool victim ("retried a dead tool").
  const crashed =
    failed.find((a) => a.faults.includes("tool_vanish") && a.id !== recovering)?.id ??
    failed.find((a) => a.id !== recovering)?.id ??
    failed[0]?.id ??
    null;

  // Deceived + survived: got a silent_lie and still passed.
  const deceived =
    survived.find((a) => a.faults.includes("silent_lie") && a.id !== recovering && a.id !== crashed)?.id ??
    survived.find((a) => a.faults.includes("silent_lie") && a.id !== recovering)?.id ??
    survived.find((a) => a.faults.includes("silent_lie"))?.id ??
    null;

  return { recovering, crashed, deceived };
}

function asPct(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) return "-";
  return `${Math.round(value * 100)}%`;
}

export function buildTour(events: TelemetryEvent[], scorecard: Scorecard): Beat[] {
  const end = events.length;
  const intro = introFoldIndex(events);
  const clampIdx = (i: number) => Math.max(intro, Math.min(i, end));
  // Mid-run frames chosen for visual richness (a mix of nominal / recovering /
  // crashed / succeeded cells, and a busy chaos feed). Trace beats seek to the
  // end so the grid is fully resolved while we inspect one agent's full trace.
  const mixedIdx = clampIdx(Math.round(end * 0.3));
  const feedBusyIdx = clampIdx(Math.round(end * 0.46));

  const { recovering, crashed, deceived } = pickAgents(
    scorecard.per_agent as unknown as Record<string, PerAgent>,
  );
  const seed = seedFrom(events);
  const n = scorecard.n_agents;
  const surv = asPct(scorecard.survival_rate);
  const dec = asPct(scorecard.deception_detection_rate);
  const mttr = scorecard.mttr_steps === null ? "-" : scorecard.mttr_steps.toFixed(1);

  const beats: Beat[] = [];

  beats.push({
    id: "intro",
    target: { kind: "region", name: "runbar" },
    placement: "bottom",
    eyebrow: "Recorded run",
    title: "A real Saboteur cohort",
    body: `${n} agents run the same task at once under hell_mode, with every one of the 8 fault types firing on a fixed seed${seed === null ? "" : ` (${seed})`}. The survival ticker resolves as agents finish.`,
    onEnter: (ctx) => {
      ctx.selectAgent(null);
      ctx.setTab("grid");
      ctx.seek(intro);
      ctx.pause();
    },
  });

  beats.push({
    id: "grid",
    target: { kind: "region", name: "grid" },
    placement: "top",
    eyebrow: "Cohort grid",
    title: "One cell per agent",
    body: "Green is nominal, amber is recovering from a fault, red has crashed, cyan has completed and passed the verifier. Cells change state the moment chaos hits.",
    onEnter: (ctx) => {
      ctx.selectAgent(null);
      ctx.seek(mixedIdx);
      ctx.pause();
    },
  });

  beats.push({
    id: "chaos",
    target: { kind: "region", name: "chaoslog" },
    placement: "right",
    eyebrow: "Chaos feed",
    title: "Faults are landing",
    body: "Every injection streams here in order: API 500s, 429 rate limits, injected latency, malformed and silent-lie tool results, vanished tools, dropped context. Same seed, same sequence, every run.",
    onEnter: (ctx) => {
      ctx.selectAgent(null);
      ctx.seek(feedBusyIdx);
      ctx.pause();
    },
  });

  if (recovering !== null) {
    beats.push({
      id: "recover",
      target: { kind: "region", name: "timeline" },
      placement: "left",
      eyebrow: "Self-healing",
      title: `${agentLabel(recovering)} recovers`,
      interactive: { agent: recovering },
      promptBody: `${agentLabel(recovering)} was hit by faults but still passed. Click its cell to open the step-by-step trace and see how.`,
      body: "Hit by faults, this agent retried and then fell back to an alternate tool, and still filed a correct report. The green rows are its productive recovery actions.",
      onEnter: (ctx) => {
        ctx.setTab("grid");
        ctx.selectAgent(null);
        ctx.seek(end);
        ctx.pause();
      },
    });
  }

  if (crashed !== null) {
    beats.push({
      id: "crash",
      target: { kind: "region", name: "timeline" },
      placement: "left",
      eyebrow: "Failure mode",
      title: `${agentLabel(crashed)} goes down`,
      interactive: { agent: crashed },
      promptBody: `Not everyone survives. Click ${agentLabel(crashed)} to see where it ran out of road.`,
      body: "This agent kept retrying a tool that had vanished and ran out its step budget. The trace shows exactly where it stalled.",
      onEnter: (ctx) => {
        ctx.setTab("grid");
        ctx.selectAgent(null);
        ctx.seek(end);
        ctx.pause();
      },
    });
  }

  if (deceived !== null) {
    beats.push({
      id: "deception",
      target: { kind: "region", name: "timeline" },
      placement: "left",
      eyebrow: "Deception test",
      title: `${agentLabel(deceived)} resists the lie`,
      interactive: { agent: deceived },
      promptBody: `${agentLabel(deceived)} was fed a well-formed but wrong tool result - a planted decoy. Click it to see how it caught the lie.`,
      body: "It cross-checked, refused the decoy, and still passed. Deception resistance is the metric Saboteur exists to measure - and the one most agent benchmarks miss.",
      onEnter: (ctx) => {
        ctx.setTab("grid");
        ctx.selectAgent(null);
        ctx.seek(end);
        ctx.pause();
      },
    });
  }

  beats.push({
    id: "scorecard",
    target: { kind: "region", name: "scorecard" },
    placement: "top",
    eyebrow: "Resilience scorecard",
    title: "Every number is earned",
    body: `When the cohort finishes, the scorecard is a pure function of the event log: survival ${surv}, deception caught ${dec}, mean time to recovery ${mttr} steps, plus the recovery and failure-mode breakdowns.`,
    onEnter: (ctx) => {
      ctx.selectAgent(null);
      ctx.setTab("scorecard");
      ctx.seek(end);
      ctx.pause();
    },
  });

  beats.push({
    id: "close",
    target: { kind: "region", name: "playbar" },
    placement: "top",
    eyebrow: "Explore freely",
    title: "Now it's yours to drive",
    body: "Drag the timeline to scrub, change speed, switch to the scorecard, or click any agent to open its trace. Same profile and seed reproduce this exact run - point Saboteur at your own agent and get this scorecard in CI.",
    actions: [
      { label: "Back to landing", variant: "ghost", kind: "exit" },
      { label: "View on GitHub", variant: "primary", kind: "link", href: REPO_URL },
    ],
    onEnter: (ctx) => {
      ctx.selectAgent(null);
      ctx.setTab("grid");
      ctx.seek(end);
      ctx.pause();
    },
  });

  return beats;
}
