/**
 * FaceoffCompare - the guided model comparison rendered inside the face-off
 * beat's coachmark. It contrasts the family's two runs on the headline
 * resilience metrics (survival + deception, with MTTR secondary), lets the
 * viewer toggle which model is in focus (which also swaps the scorecard behind
 * via switchRun), and auto-opens a small dismissible grouped bar chart so a
 * judge can see the contrast visually.
 *
 * Every number derives from the two bundled scorecards - nothing is hardcoded,
 * so the same component serves both families (only the runs differ).
 */

import { useState } from "react";
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, XAxis, YAxis } from "recharts";

import type { FaceoffData } from "./tour";

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
  const [a, b] = data.models;
  const focusModel = data.models[focus] ?? a;
  const otherIndex = focus === 0 ? 1 : 0;
  const otherModel = data.models[otherIndex] ?? b;

  // The chart auto-opens on entry on wide screens (where it docks left, clear
  // of the scorecard); dismissible and reopenable. On narrow screens it starts
  // closed so it never covers the scorecard - one tap opens it.
  const [chartOpen, setChartOpen] = useState(
    () => typeof window !== "undefined" && window.matchMedia?.("(min-width: 1024px)").matches,
  );

  const chartData = [
    { metric: "Survival", [a.short]: pctVal(a, "survival_rate"), [b.short]: pctVal(b, "survival_rate") },
    {
      metric: "Deception",
      [a.short]: pctVal(a, "deception_detection_rate"),
      [b.short]: pctVal(b, "deception_detection_rate"),
    },
  ];

  return (
    <div className="relative flex flex-col gap-3">
      {/* Model toggle - focus + swap the scorecard behind. */}
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="mr-1 text-[11px] font-semibold uppercase tracking-[0.14em] text-ink-faint">
          Compare
        </span>
        {data.models.map((m, i) => (
          <button
            key={m.short}
            type="button"
            onClick={() => onFocus(i)}
            className={`rounded-sm border px-2 py-0.5 text-xs font-semibold transition-colors duration-150 ${
              focus === i
                ? "border-accent/60 bg-accent/10 text-accent"
                : "border-line text-ink-faint hover:text-ink"
            }`}
          >
            {m.short}
          </button>
        ))}
        <button
          type="button"
          onClick={() => setChartOpen((o) => !o)}
          className="ml-auto rounded-sm border border-line px-2 py-0.5 text-xs font-medium text-ink-dim transition-colors duration-150 hover:bg-raised hover:text-ink"
        >
          {chartOpen ? "Hide chart" : "Chart"}
        </button>
      </div>

      {/* Metric rows - re-keyed on focus so, on a model switch, every moved
          number highlights: the whole block settles (metric-pulse) and each row
          flashes a coloured ring (green improved / red regressed) via
          metric-flash, alongside its arrow + delta. */}
      <div key={focus} className="metric-pulse flex flex-col gap-2.5">
        {METRICS.map((spec) => {
          const focusV = raw(focusModel, spec.key);
          const otherV = raw(otherModel, spec.key);
          const better = isBetter(focusV, otherV, spec.higherBetter);
          const delta = deltaLabel(focusV, otherV, spec.kind);
          const up = focusV !== null && otherV !== null && focusV >= otherV;
          const toneCls = better === null ? "text-ink-dim" : better ? "text-win" : "text-crit";
          const pulseColor =
            better === null
              ? "var(--color-accent)"
              : better
                ? "var(--color-win)"
                : "var(--color-crit)";
          return (
            <div
              key={spec.key}
              className={`metric-flash rounded-md border px-3 py-2 ${
                spec.headline ? "border-line-strong bg-panel" : "border-line bg-panel/60"
              }`}
              style={{ ["--pulse-color" as string]: pulseColor }}
            >
              <div className="flex items-center justify-between">
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
              <div
                className={`mt-1 font-display font-bold ${spec.headline ? "text-base" : "text-sm"} ${
                  better === null ? "text-ink" : better ? "text-win" : "text-crit"
                }`}
              >
                <span className="text-ink-faint">{otherModel.short} </span>
                {fmt(otherV, spec.kind)}
                <span className="mx-1.5 text-ink-faint">{"→"}</span>
                <span className="text-ink-faint">{focusModel.short} </span>
                {fmt(focusV, spec.kind)}
              </div>
            </div>
          );
        })}
      </div>

      {/* Chart - small grouped bars (survival + deception, one bar per model).
          Docked in-flow within the (left-docked) card so it never covers the
          scorecard and the card grows to it in one smooth motion. */}
      {chartOpen && (
        <div className="rounded-md border border-line bg-panel/60 p-3">
          <div className="mb-1.5 flex items-center justify-between">
            <span className="text-[11px] font-semibold uppercase tracking-[0.14em] text-ink-dim">
              Survival vs deception (%)
            </span>
            <button
              type="button"
              onClick={() => setChartOpen(false)}
              className="rounded-sm px-1 text-ink-faint transition-colors duration-150 hover:text-ink"
              aria-label="Dismiss chart"
            >
              {"✕"}
            </button>
          </div>
          <ResponsiveContainer width="100%" height={150}>
            <BarChart data={chartData} margin={{ top: 4, right: 8, bottom: 0, left: -22 }} barGap={2}>
              <CartesianGrid stroke="rgba(255,255,255,0.06)" vertical={false} />
              <XAxis dataKey="metric" tick={{ fill: "#bcc4d4", fontSize: 11 }} stroke="rgba(255,255,255,0.1)" />
              <YAxis
                domain={[0, 100]}
                tick={{ fill: "#8c95a8", fontSize: 10 }}
                stroke="rgba(255,255,255,0.1)"
                width={34}
              />
              <Bar dataKey={a.short} fill="#8c95a8" radius={[2, 2, 0, 0]} isAnimationActive={false} />
              <Bar dataKey={b.short} fill="var(--color-accent)" radius={[2, 2, 0, 0]} isAnimationActive={false} />
            </BarChart>
          </ResponsiveContainer>
          <div className="mt-1 flex items-center justify-center gap-4 text-[11px] text-ink-dim">
            <LegendDot color="#8c95a8" label={a.short} />
            <LegendDot color="var(--color-accent)" label={b.short} />
          </div>
        </div>
      )}
    </div>
  );
}

function LegendDot({ color, label }: { color: string; label: string }) {
  return (
    <span className="flex items-center gap-1.5">
      <span className="inline-block h-2 w-2 rounded-sm" style={{ background: color }} />
      {label}
    </span>
  );
}

/** Metric value as a 0-100 number for the chart (0 when null). */
function pctVal(model: FaceoffData["models"][number], key: MetricSpec["key"]): number {
  const v = raw(model, key);
  return v === null ? 0 : Math.round(v * 100);
}

/** Is the focus value the better outcome vs the other? null when incomparable. */
function isBetter(focusV: number | null, otherV: number | null, higherBetter: boolean): boolean | null {
  if (focusV === null || otherV === null || focusV === otherV) return null;
  const higher = focusV > otherV;
  return higherBetter ? higher : !higher;
}
