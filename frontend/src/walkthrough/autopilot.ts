
import type { Beat } from "./tour";

export type AutopilotStep =
  | { kind: "dwell"; ms: number }
  | { kind: "click"; target: "agent" | "next" | "compare"; agent?: number };

export const DRIVE_LABEL = "Let it drive";

const COMPARE_DWELL_MS = 4200;
const AFTER_COMPARE_MS = 900;

/** how long a viewer needs on a coachmark before the cursor moves on */
export function readingMs(text: string): number {
  return Math.min(7500, Math.max(3000, Math.round(2600 + 26 * text.length)));
}

export function planPhase(beat: Beat, awaiting: boolean): AutopilotStep[] {
  if (awaiting && beat.interactive) {
    return [
      { kind: "dwell", ms: readingMs(beat.promptBody ?? beat.body) },
      { kind: "click", target: "agent", agent: beat.interactive.agent },
    ];
  }
  const steps: AutopilotStep[] = [{ kind: "dwell", ms: readingMs(beat.body) }];
  if (beat.compare) {
    steps.push(
      { kind: "click", target: "compare" },
      { kind: "dwell", ms: COMPARE_DWELL_MS },
      { kind: "click", target: "compare" },
      { kind: "dwell", ms: AFTER_COMPARE_MS },
    );
  }
  steps.push({ kind: "click", target: "next" });
  return steps;
}

export function agentCell(id: number): HTMLElement | null {
  const grid = document.querySelector('[data-tour="grid"]');
  return grid?.querySelectorAll<HTMLElement>(".agent-cell-wrap")[id] ?? null;
}

export function resolveClickTarget(step: AutopilotStep): HTMLElement | null {
  if (step.kind !== "click") return null;
  if (step.target === "agent") {
    const wrap = agentCell(step.agent ?? -1);
    return wrap?.querySelector<HTMLElement>(".agent-cell") ?? wrap;
  }
  return document.querySelector<HTMLElement>(`[data-autopilot="${step.target}"]`);
}
