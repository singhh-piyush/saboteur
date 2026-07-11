
import { useEffect } from "react";
import { createPortal } from "react-dom";

import { CursorGlyph } from "./Autopilot";
import { DRIVE_LABEL } from "./autopilot";

const BTN_GHOST =
  "whitespace-nowrap rounded-sm border border-line px-3 py-1.5 text-xs font-medium text-ink-dim transition-colors duration-150 hover:bg-raised hover:text-ink";
const BTN_PRIMARY =
  "whitespace-nowrap rounded-sm border border-accent/60 bg-accent/10 px-3.5 py-1.5 text-xs font-semibold text-accent transition-colors duration-150 hover:bg-accent/20";

interface TourPromptProps {
  totalBeats: number;
  onAutopilot: (origin: { x: number; y: number }) => void;
  onManual: () => void;
  onSkip: () => void;
}

/** shown once between the family reveal and the first tour beat */
export function TourPrompt({ totalBeats, onAutopilot, onManual, onSkip }: TourPromptProps) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onManual();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onManual]);

  return createPortal(
    <div
      className="fixed inset-0 z-[130] flex items-center justify-center bg-black/60 p-6 backdrop-blur-[2px]"
      style={{ animation: "scene-in 380ms ease-out both" }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="tour-prompt-title"
        className="w-full max-w-md rounded-lg border border-line-strong bg-raised p-5 shadow-[0_16px_48px_-8px_rgb(0_0_0/70%)]"
        style={{ animation: "card-in 420ms ease-out both" }}
      >
        <div className="flex flex-col gap-3">
          <div className="flex items-center gap-2">
            <span aria-hidden className="h-3.5 w-[3px] shrink-0 rounded-full bg-accent" />
            <span className="text-[11px] font-semibold uppercase tracking-[0.18em] text-ink-dim">
              Guided tour
            </span>
          </div>

          <h3 id="tour-prompt-title" className="text-lg font-bold leading-tight text-ink">
            Want the guided tour?
          </h3>

          <p className="text-sm leading-relaxed text-ink-dim">
            {totalBeats} short steps walk through this recorded chaos run: the live cohort grid,
            faults landing, agents recovering (or not), and the final scorecard. Autopilot moves a
            cursor and clicks through every step for you. Click or press any key at any time to
            take over.
          </p>

          <div className="mt-1 flex flex-wrap items-center gap-2 border-t border-line pt-3">
            <button
              type="button"
              data-autopilot-safe
              onClick={(e) => onAutopilot({ x: e.clientX, y: e.clientY })}
              className={BTN_PRIMARY}
            >
              <CursorGlyph className="mr-1.5 inline-block align-[-1px]" />
              {DRIVE_LABEL}
            </button>
            <button type="button" onClick={onManual} className={BTN_GHOST}>
              I'll drive myself
            </button>
            <button type="button" onClick={onSkip} className={`${BTN_GHOST} ml-auto`}>
              Skip tour
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
