
import { useCallback, useEffect, useRef, useState } from "react";

import { Callout } from "./Callout";
import { Spotlight, useSpotlightRect } from "./Spotlight";
import type { Beat, TourCtx, TourTarget } from "./tour";
import { agentCell, DRIVE_LABEL } from "./autopilot";
import { useWalkthrough } from "./WalkthroughProvider";

interface TourOverlayProps {
  beats: Beat[];
  active: boolean;
  beatIndex: number;
  onSetBeat: (index: number) => void;
  /** drop into free mode and resume playback */
  onExitTour: () => void;
  /** complete tour (advance past last beat): restarts replay */
  onFinishTour: () => void;
  /** navigate back to the landing page */
  onExitToLanding: () => void;
  /** current agent selection; used to detect the interactive reveal click */
  selectedAgent: number | null;
  selectAgent: (id: number | null) => void;
  setTab: (tab: "grid" | "scorecard") => void;
  /** fade-through seek: hides grid pane during jump so only destination state is visible */
  seekSmooth: (index: number) => void;
  /** other family display name; when set, last beat offers a link to that family */
  otherFamilyLabel?: string;
  /** route to the other family (dip to black → reveal → run) */
  onViewOtherFamily?: () => void;
  /** whether the side-by-side comparison overlay is open */
  sideBySideOpen?: boolean;
  /** toggle the side-by-side comparison from the face-off beat */
  onToggleSideBySide?: () => void;
  /** true while the synthetic cursor is driving */
  autopilot?: boolean;
  onStartAutopilot?: () => void;
}

const BTN_GHOST =
  "whitespace-nowrap rounded-sm border border-line px-2.5 py-1 text-xs font-medium text-ink-dim transition-colors duration-150 hover:bg-raised hover:text-ink disabled:cursor-not-allowed disabled:opacity-40";
const BTN_PRIMARY =
  "whitespace-nowrap rounded-sm border border-accent/60 bg-accent/10 px-3 py-1 text-xs font-semibold text-accent transition-colors duration-150 hover:bg-accent/20";
const BTN_RED =
  "whitespace-nowrap rounded-sm border border-crit/70 bg-crit/15 px-2.5 py-1 text-xs font-semibold text-crit transition-colors duration-150 hover:bg-crit/25";

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
  otherFamilyLabel,
  onViewOtherFamily,
  sideBySideOpen,
  onToggleSideBySide,
  autopilot = false,
  onStartAutopilot,
}: TourOverlayProps) {
  const { seek, pause, switchRun } = useWalkthrough();
  const beat: Beat | null = beats[beatIndex] ?? null;
  const total = beats.length;

  const [revealedBeat, setRevealedBeat] = useState<number | null>(null);
  const revealed = revealedBeat === beatIndex;

  const ctxRef = useRef<TourCtx>({ seek, seekSmooth, pause, selectAgent, setTab, switchRun });
  ctxRef.current = { seek, seekSmooth, pause, selectAgent, setTab, switchRun };

  useEffect(() => {
    if (!active || !beat) return;
    beat.onEnter(ctxRef.current);
    // beat is derived from beatIndex; re-run only when the beat changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, beatIndex]);

  useEffect(() => {
    if (!active || !beat?.interactive) return;
    if (selectedAgent === beat.interactive.agent) setRevealedBeat(beatIndex);
  }, [active, beat, beatIndex, selectedAgent]);

  const next = useCallback(() => {
    if (beatIndex >= total - 1) onFinishTour();
    else onSetBeat(beatIndex + 1);
  }, [beatIndex, total, onFinishTour, onSetBeat]);

  const back = useCallback(() => {
    if (beatIndex > 0) onSetBeat(beatIndex - 1);
  }, [beatIndex, onSetBeat]);

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
      {/* spotlight glides between targets via eased position; correct target is resolved synchronously */}
      <Spotlight rect={rect} />
      <Callout rect={rect} placement={placement} anchorKey={`${beat.id}:${phaseKey}`} wide={isLast}>
        <div className="flex flex-col gap-3">
          <div className="flex items-center gap-2">
            <span aria-hidden className="h-3.5 w-[3px] shrink-0 rounded-full bg-accent" />
            <span className="text-[11px] font-semibold uppercase tracking-[0.18em] text-ink-dim">
              {beat.eyebrow}
            </span>
          </div>

          <h3 className="text-lg font-bold leading-tight text-ink">{beat.title}</h3>

          <p className="text-sm leading-relaxed text-ink-dim">{bodyText}</p>

          {(beat.actions ||
            (beat.compare && onToggleSideBySide) ||
            (isLast && onViewOtherFamily && otherFamilyLabel)) && (
            <div className="flex flex-wrap gap-2 pt-0.5">
              {beat.compare && onToggleSideBySide && (
                <button
                  type="button"
                  data-autopilot="compare"
                  onClick={onToggleSideBySide}
                  aria-pressed={sideBySideOpen}
                  className={sideBySideOpen ? BTN_PRIMARY : BTN_GHOST}
                >
                  <span aria-hidden className="mr-1">⇄</span>
                  {sideBySideOpen ? "Hide comparison" : "Compare side by side"}
                </button>
              )}
              {beat.actions?.map((a) =>
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
              {isLast && onViewOtherFamily && otherFamilyLabel && (
                <button type="button" onClick={onViewOtherFamily} className={BTN_RED}>
                  View the {otherFamilyLabel} run
                </button>
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
              {beatIndex === 0 && !autopilot && onStartAutopilot && (
                <button
                  type="button"
                  data-autopilot-safe
                  onClick={onStartAutopilot}
                  className={BTN_GHOST}
                >
                  <span aria-hidden className="mr-1">⏵</span>
                  {DRIVE_LABEL}
                </button>
              )}
              {awaiting ? (
                <button
                  type="button"
                  onClick={() => selectAgent(beat.interactive!.agent)}
                  className={BTN_PRIMARY}
                >
                  Open trace
                </button>
              ) : (
                <button type="button" data-autopilot="next" onClick={next} className={BTN_PRIMARY}>
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
