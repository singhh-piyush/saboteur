/**
 * FaceoffCompare - the guided model comparison card. It sits AS ITS OWN CARD
 * above the scorecard in the main pane during the face-off beat (not crammed
 * into the coachmark), so a viewer can freely toggle between the family's two
 * runs and watch the contrast.
 *
 * Toggling a model (a) swaps the scorecard behind it via switchRun and (b)
 * re-frames every metric focus-relative. On each switch the moved numbers are
 * highlighted: the block settles (metric-pulse) and each row flashes a coloured
 * ring (green improved / red regressed) alongside its up/down arrow + delta,
 * e.g. "8B 44% -> 70B 66% ▲ +22 pts".
 *
 * Every number derives from the two bundled scorecards - nothing is hardcoded,
 * so the same component serves both families (only the runs differ).
 */

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { usePrefersReducedMotion } from "./Spotlight";
import type { FaceoffData } from "./tour";

/** Enter / exit timings for the floating face-off card (see FaceoffCard). */
const FACEOFF_IN_MS = 360;
const FACEOFF_OUT_MS = 240;
const FACEOFF_EASE = "cubic-bezier(0.4, 0, 0.2, 1)";

interface MetricSpec {
  key: "survival_rate" | "deception_detection_rate" | "mttr_steps";
  label: string;
  /** Higher is the better outcome (survival/deception up, MTTR down). */
  higherBetter: boolean;
  kind: "pct" | "steps";
  headline: boolean;
}

const METRICS: MetricSpec[] = [
  { key: "survival_rate", label: "Survival", higherBetter: true, kind: "pct", headline: true },
  { key: "deception_detection_rate", label: "Deception caught", higherBetter: true, kind: "pct", headline: true },
  { key: "mttr_steps", label: "MTTR (steps)", higherBetter: false, kind: "steps", headline: false },
];

function raw(model: FaceoffData["models"][number], key: MetricSpec["key"]): number | null {
  const v = model.scorecard[key];
  return typeof v === "number" ? v : null;
}

function fmt(v: number | null, kind: MetricSpec["kind"]): string {
  if (v === null) return "-";
  return kind === "pct" ? `${Math.round(v * 100)}%` : v.toFixed(1);
}

/** Signed delta of focus vs other, formatted for the metric kind. */
function deltaLabel(focusV: number | null, otherV: number | null, kind: MetricSpec["kind"]): string | null {
  if (focusV === null || otherV === null) return null;
  const d = focusV - otherV;
  if (kind === "pct") {
    const pts = Math.round(d * 100);
    return `${pts >= 0 ? "+" : ""}${pts} pts`;
  }
  return `${d >= 0 ? "+" : ""}${d.toFixed(1)}`;
}

export function FaceoffCompare({
  data,
  focus,
  onFocus,
}: {
  data: FaceoffData;
  /** Index of the model currently in focus (the active run behind the card). */
  focus: number;
  /** Toggle focus - also swaps the scorecard behind via switchRun. */
  onFocus: (index: number) => void;
}) {
  const [a] = data.models;
  const focusModel = data.models[focus] ?? a;
  const otherIndex = focus === 0 ? 1 : 0;
  const otherModel = data.models[otherIndex] ?? data.models[1];

  return (
    <div className="rounded-md border border-line-strong bg-panel">
      {/* Header: title + the model toggle (freely switch to compare). */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-line px-3 py-2">
        <span aria-hidden className="h-3.5 w-[3px] shrink-0 rounded-full bg-accent" />
        <span className="text-[11px] font-bold uppercase tracking-[0.16em] text-ink">
          Model face-off
        </span>
        <span className="text-[11px] font-medium text-ink-faint">
          Toggle to compare - moved metrics highlight
        </span>
        <div className="ml-auto flex items-center gap-1.5">
          {data.models.map((m, i) => (
            <button
              key={m.short}
              type="button"
              onClick={() => onFocus(i)}
              aria-pressed={focus === i}
              className={`rounded-sm border px-2.5 py-1 text-xs font-semibold transition-colors duration-150 ${
                focus === i
                  ? "border-accent/60 bg-accent/15 text-accent"
                  : "border-line text-ink-dim hover:border-line-strong hover:text-ink"
              }`}
            >
              {m.short}
            </button>
          ))}
        </div>
      </div>

      {/* Metric tiles - re-keyed on focus so, on a model switch, every moved
          number highlights: the block settles (metric-pulse) and each tile
          flashes a coloured ring (green improved / red regressed) via
          metric-flash, alongside its arrow + delta. */}
      <div key={focus} className="metric-pulse grid grid-cols-1 gap-2.5 p-3 sm:grid-cols-3">
        {METRICS.map((spec) => {
          const focusV = raw(focusModel, spec.key);
          const otherV = raw(otherModel, spec.key);
          const better = isBetter(focusV, otherV, spec.higherBetter);
          const delta = deltaLabel(focusV, otherV, spec.kind);
          const up = focusV !== null && otherV !== null && focusV >= otherV;
          const toneCls = better === null ? "text-ink" : better ? "text-win" : "text-crit";
          const pulseColor =
            better === null
              ? "var(--color-accent)"
              : better
                ? "var(--color-win)"
                : "var(--color-crit)";
          return (
            <div
              key={spec.key}
              className={`metric-flash rounded-md border px-3 py-2.5 ${
                spec.headline ? "border-line-strong bg-void/40" : "border-line bg-void/20"
              }`}
              style={{ ["--pulse-color" as string]: pulseColor }}
            >
              <div className="flex items-center justify-between gap-2">
                <span className="text-[11px] font-semibold uppercase tracking-[0.14em] text-ink-dim">
                  {spec.label}
                </span>
                {delta && (
                  <span className={`flex items-center gap-1 text-xs font-semibold ${toneCls}`}>
                    <span aria-hidden>{up ? "▲" : "▼"}</span>
                    {delta}
                  </span>
                )}
              </div>
              {/* from -> to, focused value emphasised (it's the live scorecard). */}
              <div className="mt-1.5 flex items-baseline gap-1.5">
                <span className="text-xs text-ink-faint">{otherModel.short}</span>
                <span className="font-display text-sm font-semibold text-ink-dim">
                  {fmt(otherV, spec.kind)}
                </span>
                <span className="text-ink-faint">{"→"}</span>
                <span className="text-xs text-ink-faint">{focusModel.short}</span>
                <span className={`font-display text-xl font-bold ${toneCls}`}>
                  {fmt(focusV, spec.kind)}
                </span>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** Is the focus value the better outcome vs the other? null when incomparable. */
function isBetter(focusV: number | null, otherV: number | null, higherBetter: boolean): boolean | null {
  if (focusV === null || otherV === null || focusV === otherV) return null;
  const higher = focusV > otherV;
  return higherBetter ? higher : !higher;
}

/**
 * FaceoffCard - floats the comparison above the dashboard as its own card that
 * pops in on the face-off beat and eases out when the beat leaves, mirroring the
 * coachmark tour cards (portaled, fixed, above the spotlight dim so its toggle
 * stays clickable). Presence-managed: it stays mounted through the exit
 * animation, retaining the last data so the closing frame still has content.
 */
export function FaceoffCard({
  open,
  data,
  focus,
  onFocus,
}: {
  open: boolean;
  data: FaceoffData | null;
  focus: number;
  onFocus: (index: number) => void;
}) {
  const reduced = usePrefersReducedMotion();
  const [render, setRender] = useState(open);
  const [phase, setPhase] = useState<"in" | "out">("out");
  // Keep the last non-null data so the exit animation still has content to show
  // after the beat (and its `compare` payload) has gone.
  const lastData = useRef<FaceoffData | null>(data);
  if (data) lastData.current = data;

  useEffect(() => {
    if (open) {
      setRender(true);
      // Mount at the pre-enter state, then flip to "in" next frame so the
      // transition actually plays (no first-frame snap).
      const r = requestAnimationFrame(() => setPhase("in"));
      return () => cancelAnimationFrame(r);
    }
    setPhase("out");
    if (!render) return;
    if (reduced) {
      setRender(false);
      return;
    }
    const t = window.setTimeout(() => setRender(false), FACEOFF_OUT_MS + 20);
    return () => window.clearTimeout(t);
  }, [open, reduced, render]);

  if (!render) return null;
  const content = data ?? lastData.current;
  if (!content) return null;

  const shown = phase === "in";
  const dur = shown ? FACEOFF_IN_MS : FACEOFF_OUT_MS;

  return createPortal(
    <div
      className="fixed left-1/2 top-[4.75rem] z-[115] w-[min(92vw,44rem)]"
      style={{
        transition: reduced
          ? undefined
          : `transform ${dur}ms ${FACEOFF_EASE}, opacity ${dur}ms ${FACEOFF_EASE}`,
        transform: shown
          ? "translateX(-50%) translateY(0) scale(1)"
          : "translateX(-50%) translateY(-14px) scale(0.98)",
        opacity: shown ? 1 : 0,
        pointerEvents: shown ? "auto" : "none",
      }}
    >
      <FaceoffCompare data={content} focus={focus} onFocus={onFocus} />
    </div>,
    document.body,
  );
}
