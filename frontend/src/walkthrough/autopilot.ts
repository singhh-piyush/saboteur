
import type { Beat, TourTarget } from "./tour";

export type AutopilotStep =
  | { kind: "dwell"; ms: number }
  | { kind: "click"; target: "agent" | "next" | "compare"; agent?: number };

export const DRIVE_LABEL = "Let autopilot drive";

const COMPARE_DWELL_MS = 7000;
const AFTER_COMPARE_MS = 900;

/** how long a viewer needs on a coachmark before the cursor moves on:
    60ms/char + a 1.2s orientation beat lands the WHOLE dwell at ~150-160 wpm
    (at ~5.8 chars/word the base beat eats into the effective pace) */
export function readingMs(text: string): number {
  return Math.min(22000, Math.max(4000, Math.round(1200 + 60 * text.length)));
}

export function planPhase(beat: Beat, awaiting: boolean, isLast = false): AutopilotStep[] {
  if (awaiting && beat.interactive) {
    return [
      { kind: "dwell", ms: readingMs(beat.promptBody ?? beat.body) },
      { kind: "click", target: "agent", agent: beat.interactive.agent },
    ];
  }
  const steps: AutopilotStep[] = [{ kind: "dwell", ms: readingMs(beat.body) }];
  // the closing beat is a decision point: autopilot never clicks past it
  if (isLast) return steps;
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

export function resolveTourTarget(target: TourTarget): HTMLElement | null {
  if (target.kind === "none") return null;
  if (target.kind === "agent") return agentCell(target.id);
  return document.querySelector<HTMLElement>(`[data-tour="${target.name}"]`);
}

export function resolveClickTarget(step: AutopilotStep): HTMLElement | null {
  if (step.kind !== "click") return null;
  if (step.target === "agent") {
    const wrap = agentCell(step.agent ?? -1);
    return wrap?.querySelector<HTMLElement>(".agent-cell") ?? wrap;
  }
  return document.querySelector<HTMLElement>(`[data-autopilot="${step.target}"]`);
}
