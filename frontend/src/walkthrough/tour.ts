/**
 * The guided tour is data-driven: it scans the bundled run to pick
 * representative agents (one that recovers and survives, one that crashes, one
 * that resists a planted lie) and the event indices to seek to, then emits an
 * ordered list of beats. Swapping the runs rebinds everything automatically -
 * nothing here is hardcoded to a specific agent id, model, or number.
 *
 * The tour is built ONCE over the active family's runs. Each beat carries the
 * index of the run it narrates; entering a beat first ensures that run is
 * active (a no-op when it already is), so stepping forward or backward across
 * the face-off boundary always shows the right run. With two runs in the
 * family, the tour walks the primary and ends by switching to the sibling in
 * place.
 */

import { agentLabel } from "../lib/format";
import type { Scorecard } from "../lib/api";
import type { DemoRun } from "../demo";
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
  /** Jump the replay position behind a quick grid fade: only the start and
   * destination states are ever visible, never the churn of the events in
   * between. Reduced motion (or a no-op target) seeks instantly. */
  seekSmooth: (index: number) => void;
  pause: () => void;
  selectAgent: (id: number | null) => void;
  setTab: (tab: "grid" | "scorecard") => void;
  /** Make a bundled run active (in-place swap; no-op when already active). */
  switchRun: (index: number) => void;
}

/** One model's identity + frozen scorecard for the face-off comparison. */
export interface FaceoffModel {
  label: string;
  short: string;
  scorecard: Scorecard;
}

/** The two models a face-off beat contrasts (primary vs sibling). Every number
 * the comparison shows derives from these scorecards - nothing is hardcoded. */
export interface FaceoffData {
  models: [FaceoffModel, FaceoffModel];
}

export interface Beat {
  id: string;
  /** Which bundled run this beat narrates; entering the beat activates it. */
  run: number;
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
  /** Label for the last beat's primary footer button (default "Finish"). */
  finishLabel?: string;
  /** When set, the beat renders the interactive face-off comparison (metric
   * deltas + model toggle + chart popup) instead of a plain body paragraph. */
  compare?: FaceoffData;
  onEnter: (ctx: TourCtx) => void;
}

const REAL_RECOVERIES = new Set(["retry", "reformulate", "fallback_tool"]);

interface PerAgent {
  outcome: string;
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
 * provider to seed the first paint (and every run switch), so it matches the
 * tour's first beat. All cells already exist from run_started, so this is
 * purely for visual liveness. */
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

/** How the picked crashed agent actually failed, from its frozen outcome -
 * never assert a failure story the data doesn't back. */
function crashStory(agent: PerAgent | undefined): string {
  switch (agent?.outcome) {
    case "infinite_retry":
      return "This agent kept retrying the same dead call until its step budget ran out.";
    case "timeout":
      return "This agent ran out its wall-clock budget and the harness cut it off.";
    case "hard_exception":
      return "This agent died on an unhandled exception mid-task.";
    case "silent_abandonment":
      return "This agent quietly stopped acting and never filed a report.";
    case "completed":
      return "This agent finished - but filed a wrong answer, and the verifier caught it.";
    default:
      return "This agent never made it to a correct report.";
  }
}

/** The recovery actions the picked surviving agent actually took. */
function recoveryStory(agent: PerAgent | undefined): string {
  const kinds = new Set((agent?.recoveries ?? []).filter((r) => REAL_RECOVERIES.has(r)));
  const parts: string[] = [];
  if (kinds.has("retry")) parts.push("retried");
  if (kinds.has("reformulate")) parts.push("reformulated its call");
  if (kinds.has("fallback_tool")) parts.push("fell back to an alternate tool");
  const did = parts.length > 0 ? parts.join(", then ") : "kept making progress";
  return `Hit by faults, this agent ${did} - and still filed a correct report. The green rows are its productive recovery actions.`;
}

export function buildTour(runs: DemoRun[]): Beat[] {
  const primary = runs[0];
  const events = primary.events;
  const scorecard = primary.scorecard;
  const end = events.length;
  const intro = introFoldIndex(events);
  const clampIdx = (i: number) => Math.max(intro, Math.min(i, end));
  // Mid-run frames chosen for visual richness (a mix of nominal / recovering /
  // crashed / succeeded cells, and a busy chaos feed). Trace beats seek to the
  // end so the grid is fully resolved while we inspect one agent's full trace.
  const mixedIdx = clampIdx(Math.round(end * 0.3));
  const feedBusyIdx = clampIdx(Math.round(end * 0.46));

  const perAgent = scorecard.per_agent as unknown as Record<string, PerAgent>;
  const { recovering, crashed, deceived } = pickAgents(perAgent);
  const seed = seedFrom(events);
  const n = scorecard.n_agents;
  const surv = asPct(scorecard.survival_rate);
  const dec = asPct(scorecard.deception_detection_rate);
  const mttr = scorecard.mttr_steps === null ? "-" : scorecard.mttr_steps.toFixed(1);

  const faceoff: DemoRun | undefined = runs[1];
  const lastRun = faceoff === undefined ? 0 : 1;

  const beats: Beat[] = [];

  beats.push({
    id: "intro",
    run: 0,
    target: { kind: "region", name: "runbar" },
    placement: "bottom",
    eyebrow: "Recorded run",
    title: "A real Saboteur cohort",
    body: `${n} agents (${primary.label}) run the same task at once under ${scorecard.profile}, with all 8 fault types in play on a fixed seed${seed === null ? "" : ` (${seed})`}. The survival ticker resolves as agents finish.`,
    onEnter: (ctx) => {
      ctx.switchRun(0);
      ctx.selectAgent(null);
      ctx.setTab("grid");
      ctx.pause();
      ctx.seekSmooth(intro);
    },
  });

  beats.push({
    id: "grid",
    run: 0,
    target: { kind: "region", name: "grid" },
    placement: "top",
    eyebrow: "Cohort grid",
    title: "One cell per agent",
    body: "Green is nominal, amber is recovering from a fault, red has crashed, cyan has completed and passed the verifier. Cells change state the moment chaos hits.",
    onEnter: (ctx) => {
      ctx.switchRun(0);
      ctx.selectAgent(null);
      ctx.setTab("grid");
      ctx.pause();
      ctx.seekSmooth(mixedIdx);
    },
  });

  beats.push({
    id: "chaos",
    run: 0,
    target: { kind: "region", name: "chaoslog" },
    placement: "right",
    eyebrow: "Chaos feed",
    title: "Faults are landing",
    body: "Every injection streams here in order: API 500s, 429 rate limits, injected latency, malformed and silent-lie tool results, vanished tools, dropped context. All seeded - the same profile and seed replay the same fault decisions for a given call sequence.",
    onEnter: (ctx) => {
      ctx.switchRun(0);
      ctx.selectAgent(null);
      ctx.setTab("grid");
      ctx.pause();
      ctx.seekSmooth(feedBusyIdx);
    },
  });

  if (recovering !== null) {
    beats.push({
      id: "recover",
      run: 0,
      target: { kind: "region", name: "timeline" },
      placement: "left",
      eyebrow: "Self-healing",
      title: `${agentLabel(recovering)} recovers`,
      interactive: { agent: recovering },
      promptBody: `${agentLabel(recovering)} was hit by faults but still passed. Click its cell to open the step-by-step trace and see how.`,
      body: recoveryStory(perAgent[String(recovering)]),
      onEnter: (ctx) => {
        ctx.switchRun(0);
        ctx.setTab("grid");
        ctx.selectAgent(null);
        ctx.pause();
        // Fade-jump to the finished run - the cut hides the churn in between.
        ctx.seekSmooth(end);
      },
    });
  }

  if (crashed !== null) {
    beats.push({
      id: "crash",
      run: 0,
      target: { kind: "region", name: "timeline" },
      placement: "left",
      eyebrow: "Failure mode",
      title: `${agentLabel(crashed)} goes down`,
      interactive: { agent: crashed },
      promptBody: `Not everyone survives. Click ${agentLabel(crashed)} to see where it ran out of road.`,
      body: `${crashStory(perAgent[String(crashed)])} The trace shows exactly where it went wrong.`,
      onEnter: (ctx) => {
        ctx.switchRun(0);
        ctx.setTab("grid");
        ctx.selectAgent(null);
        ctx.pause();
        // Fade-jump to the finished run - the cut hides the churn in between.
        ctx.seekSmooth(end);
      },
    });
  }

  if (deceived !== null) {
    beats.push({
      id: "deception",
      run: 0,
      target: { kind: "region", name: "timeline" },
      placement: "left",
      eyebrow: "Deception test",
      title: `${agentLabel(deceived)} resists the lie`,
      interactive: { agent: deceived },
      promptBody: `${agentLabel(deceived)} was fed a well-formed but wrong tool result - a planted decoy. Click it to see how it caught the lie.`,
      body: "It cross-checked, refused the decoy, and still passed. Deception resistance is the metric Saboteur exists to measure - and the one most agent benchmarks miss.",
      onEnter: (ctx) => {
        ctx.switchRun(0);
        ctx.setTab("grid");
        ctx.selectAgent(null);
        ctx.pause();
        // Fade-jump to the finished run - the cut hides the churn in between.
        ctx.seekSmooth(end);
      },
    });
  }

  beats.push({
    id: "scorecard",
    run: 0,
    target: { kind: "region", name: "scorecard" },
    placement: "left",
    eyebrow: "Resilience scorecard",
    title: "Every number is earned",
    body: `When the cohort finishes, the scorecard is a pure function of the event log: survival ${surv}, deception caught ${dec}, mean time to recovery ${mttr} steps, plus the recovery and failure-mode breakdowns.`,
    onEnter: (ctx) => {
      ctx.switchRun(0);
      ctx.selectAgent(null);
      ctx.setTab("scorecard");
      ctx.seek(end);
      ctx.pause();
    },
  });

  if (faceoff !== undefined) {
    const sc2 = faceoff.scorecard;
    const end2 = faceoff.events.length;
    beats.push({
      id: "faceoff",
      run: 1,
      target: { kind: "region", name: "scorecard" },
      placement: "left",
      eyebrow: "Face-off",
      title: "Same chaos, different model",
      body: `Same task, same profile, same seed - now ${faceoff.label}. The scorecard swaps to the sibling model and every metric that moved highlights in place: survival ${surv} to ${asPct(sc2.survival_rate)}, deception caught ${dec} to ${asPct(sc2.deception_detection_rate)}. Hit "Compare side by side" to see both scorecards at once. Resilience is a model property, and now you can measure it.`,
      compare: {
        models: [
          { label: primary.label, short: primary.short, scorecard },
          { label: faceoff.label, short: faceoff.short, scorecard: sc2 },
        ],
      },
      onEnter: (ctx) => {
        ctx.switchRun(1);
        ctx.selectAgent(null);
        ctx.setTab("scorecard");
        ctx.seek(end2);
        ctx.pause();
      },
    });
  }

  // The tour ends on a choice, not a hard cut: the scorecard stays on screen
  // (nothing behind the card changes on the way in), and the viewer picks
  // between watching the full replay (free mode: scrubber, speed, run
  // switcher) or heading back to the landing.
  beats.push({
    id: "close",
    run: lastRun,
    target: { kind: "region", name: "playbar" },
    placement: "top",
    eyebrow: "Explore freely",
    title: "Now it's yours to drive",
    body: `That's the tour. Watch the full run play out - scrub the timeline, change speed, ${faceoff === undefined ? "" : "flip runs to compare models, "}click any agent to open its trace. Or head back to the landing. Everything you see re-derives from the recorded event logs - point Saboteur at your own agent and get this scorecard in CI.`,
    finishLabel: "Watch the full run",
    actions: [
      { label: "Back to landing", variant: "ghost", kind: "exit" },
      { label: "View on GitHub", variant: "ghost", kind: "link", href: REPO_URL },
    ],
    onEnter: (ctx) => {
      ctx.switchRun(lastRun);
      ctx.selectAgent(null);
      ctx.setTab("scorecard");
      ctx.seek(lastRun === 0 ? end : runs[1].events.length);
      ctx.pause();
    },
  });

  return beats;
}
