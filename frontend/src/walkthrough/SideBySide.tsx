/**
 * SideBySide - the click-to-reveal model comparison for the face-off beat. A
 * focused two-column metric table (one column per model) with the metrics that
 * moved emphasized by an arrow + delta and a subtle highlight pulse. Portaled
 * above the tour dim as a small modal: backdrop click, the close button, or Esc
 * all dismiss it. Every number derives from the two bundled scorecards.
 */

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { deltaInfo, fmtMetric, type MetricKind } from "../lib/compare";
import { usePrefersReducedMotion } from "./Spotlight";
import type { FaceoffData } from "./tour";

const IN_MS = 260;
const OUT_MS = 200;
const EASE = "cubic-bezier(0.4, 0, 0.2, 1)";

interface Row {
  key: "survival_rate" | "deception_detection_rate" | "mttr_steps" | "crash_rate";
  label: string;
  higherBetter: boolean;
  kind: MetricKind;
}

const ROWS: Row[] = [
  { key: "survival_rate", label: "survival", higherBetter: true, kind: "pct" },
  { key: "deception_detection_rate", label: "deception caught", higherBetter: true, kind: "pct" },
  { key: "mttr_steps", label: "MTTR (steps)", higherBetter: false, kind: "steps" },
  { key: "crash_rate", label: "crash rate", higherBetter: false, kind: "pct" },
];

export function SideBySide({
  open,
  data,
  onClose,
}: {
  open: boolean;
  data: FaceoffData | null;
  onClose: () => void;
}) {
  const reduced = usePrefersReducedMotion();
  const [render, setRender] = useState(open);
  const [phase, setPhase] = useState<"in" | "out">("out");
  const lastData = useRef<FaceoffData | null>(data);
  if (data) lastData.current = data;

  useEffect(() => {
    if (open) {
      setRender(true);
      const r = requestAnimationFrame(() => setPhase("in"));
      return () => cancelAnimationFrame(r);
    }
    setPhase("out");
    if (!render) return;
    if (reduced) {
      setRender(false);
      return;
    }
    const t = window.setTimeout(() => setRender(false), OUT_MS + 20);
    return () => window.clearTimeout(t);
  }, [open, reduced, render]);

  // Esc closes while mounted.
  useEffect(() => {
    if (!render) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [render, onClose]);

  if (!render) return null;
  const content = data ?? lastData.current;
  if (!content) return null;

  const [m0, m1] = content.models;
  const shown = phase === "in";
  const dur = shown ? IN_MS : OUT_MS;

  return createPortal(
    <div className="fixed inset-0 z-[125] flex items-center justify-center p-4">
      {/* Backdrop - click to dismiss. */}
      <div
        aria-hidden
        onClick={onClose}
        className="absolute inset-0 bg-black/60"
        style={{
          transition: reduced ? undefined : `opacity ${dur}ms ${EASE}`,
          opacity: shown ? 1 : 0,
        }}
      />
      {/* Panel. */}
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Model comparison"
        className="relative w-[min(94vw,34rem)] overflow-hidden rounded-lg border border-line-strong bg-raised shadow-[0_20px_60px_-12px_rgb(0_0_0/75%)]"
        style={{
          transition: reduced ? undefined : `transform ${dur}ms ${EASE}, opacity ${dur}ms ${EASE}`,
          transform: shown ? "translateY(0) scale(1)" : "translateY(8px) scale(0.98)",
          opacity: shown ? 1 : 0,
        }}
      >
        {/* Header: title + the two model columns + close. */}
        <div className="flex items-center gap-2 border-b border-line px-4 py-2.5">
          <span aria-hidden className="h-3.5 w-[3px] shrink-0 rounded-full bg-accent" />
          <span className="text-[12px] font-bold uppercase tracking-[0.16em] text-ink">
            Side by side
          </span>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close comparison"
            className="ml-auto rounded-sm border border-line px-1.5 py-1 text-xs font-medium text-ink-dim transition-colors duration-150 hover:bg-panel hover:text-ink"
          >
            ✕
          </button>
        </div>

        <div className="p-4">
          {/* Column headers. */}
          <div className="mb-1.5 grid grid-cols-[1fr_auto_auto] items-baseline gap-x-4 border-b border-line pb-1.5">
            <span className="text-[11px] font-semibold uppercase tracking-[0.14em] text-ink-faint">
              metric
            </span>
            <span className="w-14 text-right text-xs font-bold text-ink-dim">{m0.short}</span>
            <span className="w-24 text-right text-xs font-bold text-accent">{m1.short}</span>
          </div>

          <div className="flex flex-col">
            {ROWS.map((row) => {
              const v0 = numeric(m0.scorecard[row.key]);
              const v1 = numeric(m1.scorecard[row.key]);
              const d = deltaInfo(v1, v0, row.higherBetter, row.kind);
              const changed = d?.changed ?? false;
              const toneCls = !d ? "text-ink" : d.tone === "win" ? "text-win" : "text-crit";
              const pulseColor = d?.tone === "win" ? "var(--color-win)" : "var(--color-crit)";
              return (
                <div
                  key={row.key}
                  className="relative grid grid-cols-[1fr_auto_auto] items-baseline gap-x-4 rounded-sm px-1 py-2"
                >
                  {/* Subtle pulse on changed rows, plays once when the panel opens. */}
                  {changed && !reduced ? (
                    <span
                      aria-hidden
                      className="metric-shift pointer-events-none absolute inset-0 rounded-sm"
                      style={{ ["--pulse-color" as string]: pulseColor }}
                    />
                  ) : null}
                  <span className="relative text-sm font-medium text-ink-dim">{row.label}</span>
                  <span className="relative w-14 text-right font-display text-sm font-semibold text-ink-dim">
                    {fmtMetric(v0, row.kind)}
                  </span>
                  <span className="relative flex w-24 items-baseline justify-end gap-1.5">
                    <span className="font-display text-base font-bold text-ink">
                      {fmtMetric(v1, row.kind)}
                    </span>
                    {d && changed ? (
                      <span className={`text-[11px] font-semibold ${toneCls}`}>
                        <span aria-hidden>{d.arrow}</span> {d.deltaText}
                      </span>
                    ) : null}
                  </span>
                </div>
              );
            })}
          </div>

          <p className="mt-3 border-t border-line pt-2.5 text-[11px] leading-relaxed text-ink-faint">
            Same task, same profile, same seed. Every number re-derives from the recorded
            event logs.
          </p>
        </div>
      </div>
    </div>,
    document.body,
  );
}

/** Read a scorecard field as a number, or null. */
function numeric(v: unknown): number | null {
  return typeof v === "number" ? v : null;
}
