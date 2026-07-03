/**
 * TourOverlay - the guided-tour engine. For the active beat it runs the beat's
 * side effects (seek / pause / select agent / switch tab), spotlights the
 * target, and renders the coachmark callout with Back / Next / Skip controls.
 *
 * Interactive beats are two-phase: phase 1 spotlights an agent's CELL and asks
 * the viewer to click it; once they do (the real selection that opens the
 * drawer), phase 2 spotlights the drawer and explains the trace. An "Open
 * trace" button is the non-click fallback. Keyboard: left/right step beats,
 * Escape drops into free mode.
 *
 * When inactive (free mode) it renders nothing, leaving a fully interactive
 * grid + playback bar.
 */

import { useCallback, useEffect, useRef, useState } from "react";

import { Callout } from "./Callout";
import { Spotlight, useSpotlightRect } from "./Spotlight";
import type { Beat, TourCtx, TourTarget } from "./tour";
import { useWalkthrough } from "./WalkthroughProvider";

interface TourOverlayProps {
  beats: Beat[];
  active: boolean;
  beatIndex: number;
  onSetBeat: (index: number) => void;
  /** Skip the tour: drop into interactive free mode (and resume playback). */
  onExitTour: () => void;
  /** Complete the tour (Finish / advance past the last beat): restart the replay. */
  onFinishTour: () => void;
  /** Navigate back to the marketing landing page. */
  onExitToLanding: () => void;
  /** Current agent selection - used to detect the interactive reveal click. */
  selectedAgent: number | null;
  selectAgent: (id: number | null) => void;
  setTab: (tab: "grid" | "scorecard") => void;
  /** Shell-provided fade-through seek: hides the grid pane for the instant of
   * the jump so only the destination state is visible (no mid-run churn). */
  seekSmooth: (index: number) => void;
}

const BTN_GHOST =
  "rounded-sm border border-line px-2.5 py-1 text-xs font-medium text-ink-dim transition-colors duration-150 hover:bg-raised hover:text-ink disabled:cursor-not-allowed disabled:opacity-40";
const BTN_PRIMARY =
  "rounded-sm border border-accent/60 bg-accent/10 px-3 py-1 text-xs font-semibold text-accent transition-colors duration-150 hover:bg-accent/20";

/** The id-th agent cell in the grid (ids are contiguous so DOM index === id). */
function agentCell(id: number): HTMLElement | null {
  const grid = document.querySelector('[data-tour="grid"]');
  return grid?.querySelectorAll<HTMLElement>(".agent-cell-wrap")[id] ?? null;
}

export function TourOverlay({
  beats,
  active,
  beatIndex,
  onSetBeat,
  onExitTour,
  onFinishTour,
  onExitToLanding,
  selectedAgent,
  selectAgent,
  setTab,
  seekSmooth,
}: TourOverlayProps) {
  const { seek, pause, switchRun } = useWalkthrough();
  const beat: Beat | null = beats[beatIndex] ?? null;
  const total = beats.length;

  // Whether an interactive beat's agent has been clicked open yet.
  const [revealed, setRevealed] = useState(false);

  // Latest side-effect surface, captured in a ref so the per-beat effect runs
  // exactly once per beat (not on every playback tick that re-memoizes seek).
  // switchRun swaps the bundled run in place, so this overlay (and the
  // coachmark it renders) stays mounted straight through the face-off beat.
  const ctxRef = useRef<TourCtx>({ seek, seekSmooth, pause, selectAgent, setTab, switchRun });
  ctxRef.current = { seek, seekSmooth, pause, selectAgent, setTab, switchRun };

  // Run the beat's entrance side effects when the active beat changes; reset the
  // reveal; and (for interactive beats) scroll the target cell into view.
  useEffect(() => {
    if (!active || !beat) return;
    setRevealed(false);
    beat.onEnter(ctxRef.current);
    if (beat.interactive) {
      const id = beat.interactive.agent;
      const raf = requestAnimationFrame(() =>
        agentCell(id)?.scrollIntoView({ block: "center", behavior: "smooth" }),
      );
      return () => cancelAnimationFrame(raf);
    }
    // beat is derived from beatIndex; re-run only when the beat changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, beatIndex]);

  // The interactive reveal: the viewer clicked the prompted agent (or "Open
  // trace"). Uses the real selection, so it is genuine product interaction.
  useEffect(() => {
    if (!active || !beat?.interactive) return;
    if (selectedAgent === beat.interactive.agent) setRevealed(true);
  }, [active, beat, selectedAgent]);

  const next = useCallback(() => {
    if (beatIndex >= total - 1) onFinishTour();
    else onSetBeat(beatIndex + 1);
  }, [beatIndex, total, onFinishTour, onSetBeat]);

  const back = useCallback(() => {
    if (beatIndex > 0) onSetBeat(beatIndex - 1);
  }, [beatIndex, onSetBeat]);

  // Keyboard navigation.
  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "ArrowRight") {
        e.preventDefault();
        next();
      } else if (e.key === "ArrowLeft") {
        e.preventDefault();
        back();
      } else if (e.key === "Escape") {
        e.preventDefault();
        onExitTour();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [active, next, back, onExitTour]);

  // Phase 1 = an interactive beat awaiting the click; spotlight the cell.
  const awaiting = !!beat?.interactive && !revealed;
  const target: TourTarget = awaiting
    ? { kind: "agent", id: beat!.interactive!.agent }
    : (beat?.target ?? { kind: "none" });
  const placement = awaiting ? "bottom" : (beat?.placement ?? "center");
  const bodyText = awaiting ? (beat?.promptBody ?? beat?.body ?? "") : (beat?.body ?? "");
  const phaseKey = awaiting ? "prompt" : "reveal";

  const resolve = useCallback((): HTMLElement | null => {
    if (target.kind === "none") return null;
    if (target.kind === "agent") return agentCell(target.id);
    return document.querySelector<HTMLElement>(`[data-tour="${target.name}"]`);
  }, [target]);

  const rect = useSpotlightRect(resolve, active && beat ? `${beat.id}:${phaseKey}` : "inactive");

  if (!active || !beat) return null;

  const isLast = beatIndex >= total - 1;

  return (
    <>
      <Spotlight rect={rect} />
      <Callout rect={rect} placement={placement} anchorKey={`${beat.id}:${phaseKey}`}>
        <div className="flex flex-col gap-3">
          <div className="flex items-center gap-2">
            <span aria-hidden className="h-3.5 w-[3px] shrink-0 rounded-full bg-accent" />
            <span className="text-[11px] font-semibold uppercase tracking-[0.18em] text-ink-dim">
              {beat.eyebrow}
            </span>
          </div>

          <h3 className="text-lg font-bold leading-tight text-ink">{beat.title}</h3>
          <p className="text-sm leading-relaxed text-ink-dim">{bodyText}</p>

          {beat.actions && (
            <div className="flex flex-wrap gap-2 pt-0.5">
              {beat.actions.map((a) =>
                a.kind === "link" ? (
                  <a
                    key={a.label}
                    href={a.href}
                    target="_blank"
                    rel="noreferrer"
                    className={a.variant === "primary" ? BTN_PRIMARY : BTN_GHOST}
                  >
                    {a.label}
                  </a>
                ) : (
                  <button
                    key={a.label}
                    type="button"
                    onClick={onExitToLanding}
                    className={a.variant === "primary" ? BTN_PRIMARY : BTN_GHOST}
                  >
                    {a.label}
                  </button>
                ),
              )}
            </div>
          )}

          <div className="mt-1 flex items-center justify-between border-t border-line pt-3">
            <div className="flex items-center gap-2">
              <button type="button" onClick={back} disabled={beatIndex === 0} className={BTN_GHOST}>
                Back
              </button>
              <button type="button" onClick={onExitTour} className={BTN_GHOST}>
                Skip tour
              </button>
            </div>
            <div className="flex items-center gap-3">
              <span className="font-mono text-xs tabular-nums text-ink-faint">
                {beatIndex + 1} / {total}
              </span>
              {awaiting ? (
                <button
                  type="button"
                  onClick={() => selectAgent(beat.interactive!.agent)}
                  className={BTN_PRIMARY}
                >
                  Open trace
                </button>
              ) : (
                <button type="button" onClick={next} className={BTN_PRIMARY}>
                  {isLast ? (beat.finishLabel ?? "Finish") : "Next"}
                </button>
              )}
            </div>
          </div>
        </div>
      </Callout>
    </>
  );
}
