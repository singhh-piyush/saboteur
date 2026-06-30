import { useEffect, useState } from "react";

import {
  fetchComparison,
  fetchRunList,
  type MetricDelta,
  type RunComparison,
  type RunListEntry,
} from "../lib/api";
import { num, pct } from "../lib/format";
import { useRun } from "../state/RunContext";
import { PanelHeader } from "./PanelHeader";

const INPUT_CLS =
  "w-full rounded-sm border border-line bg-raised px-2 py-1.5 text-sm text-ink outline-none " +
  "transition-colors duration-150 focus:border-accent/60 " +
  "focus:shadow-[0_0_0_3px_color-mix(in_oklch,var(--color-accent)_18%,transparent)]";

// How each compared metric is labelled + formatted. Order = display order.
const METRIC_META: { key: string; label: string; fmt: (v: number) => string }[] = [
  { key: "survival_rate", label: "Survival rate", fmt: (v) => pct(v) },
  { key: "deception_detection_rate", label: "Deception caught", fmt: (v) => pct(v) },
  { key: "mttr_steps", label: "MTTR (steps)", fmt: (v) => num(v, 2) },
  { key: "waste_factor", label: "Waste factor", fmt: (v) => `${num(v, 2)}x` },
  { key: "crash_rate", label: "Crash rate", fmt: (v) => pct(v) },
  { key: "latency_degradation", label: "Latency degr.", fmt: (v) => `${num(v, 2)}x` },
];

export function ComparePage({
  initialA,
  initialB,
}: {
  initialA?: string;
  initialB?: string;
}) {
  const { navigate } = useRun();
  const [runs, setRuns] = useState<RunListEntry[]>([]);
  const [a, setA] = useState(initialA ?? "");
  const [b, setB] = useState(initialB ?? "");
  const [cmp, setCmp] = useState<RunComparison | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetchRunList()
      .then((list) => setRuns(list.filter((r) => r.has_scorecard)))
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));
  }, []);

  useEffect(() => {
    if (!a || !b) {
      setCmp(null);
      return;
    }
    let cancelled = false;
    setError(null);
    fetchComparison(a, b)
      .then((c) => !cancelled && setCmp(c))
      .catch((err: unknown) => {
        if (cancelled) return;
        setCmp(null);
        setError(err instanceof Error ? err.message : String(err));
      });
    navigate({ kind: "compare", a, b });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [a, b]);

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <PanelHeader title="COMPARE RUNS" />

      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <RunPicker label="Run A (baseline)" value={a} runs={runs} exclude={b} onChange={setA} />
          <RunPicker label="Run B (candidate)" value={b} runs={runs} exclude={a} onChange={setB} />
        </div>

        {error && (
          <div className="rounded-sm border border-crit/40 bg-crit/10 px-3 py-2 text-sm text-crit">
            {error}
          </div>
        )}

        {cmp === null && !error && (
          <div className="flex h-40 items-center justify-center text-sm text-ink-faint">
            Pick two scored runs to see the per-metric delta.
          </div>
        )}

        {cmp && (
          <>
            {cmp.regressions.length > 0 ? (
              <div className="rounded-sm border border-crit/40 bg-crit/10 px-3 py-2 text-sm font-medium text-crit">
                {cmp.regressions.length} regression
                {cmp.regressions.length > 1 ? "s" : ""}: {cmp.regressions.join(", ")}
              </div>
            ) : (
              <div className="rounded-sm border border-ok/40 bg-ok/10 px-3 py-2 text-sm font-medium text-ok">
                No regressions - Run B holds or improves on every comparable metric.
              </div>
            )}

            <div className="overflow-hidden rounded-md border border-line">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-line bg-panel text-left">
                    <Th>Metric</Th>
                    <Th className="text-right">Run A</Th>
                    <Th className="text-right">Run B</Th>
                    <Th className="text-right">Δ (B − A)</Th>
                  </tr>
                </thead>
                <tbody>
                  {METRIC_META.map((m) => (
                    <MetricRow
                      key={m.key}
                      label={m.label}
                      fmt={m.fmt}
                      delta={cmp.metrics[m.key]}
                    />
                  ))}
                </tbody>
              </table>
            </div>

            <p className="text-[11px] text-ink-faint">
              A metric is flagged red when Run B is worse than Run A past its threshold.
              Metrics that are null in either run show "-" and never flag.
            </p>
          </>
        )}
      </div>
    </div>
  );
}

function RunPicker({
  label,
  value,
  runs,
  exclude,
  onChange,
}: {
  label: string;
  value: string;
  runs: RunListEntry[];
  exclude: string;
  onChange: (v: string) => void;
}) {
  return (
    <div>
      <span className="mb-1 block text-[11px] font-semibold uppercase tracking-[0.14em] text-ink-dim">
        {label}
      </span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className={`${INPUT_CLS} sb-select`}
      >
        <option value="">Select a run…</option>
        {runs
          .filter((r) => r.run_id !== exclude)
          .map((r) => (
            <option key={r.run_id} value={r.run_id}>
              {r.profile} · {r.target} · {r.run_id.slice(-13)}
            </option>
          ))}
      </select>
    </div>
  );
}

function MetricRow({
  label,
  fmt,
  delta,
}: {
  label: string;
  fmt: (v: number) => string;
  delta: MetricDelta | undefined;
}) {
  if (!delta) return null;
  const { a, b, delta: d, regressed, higher_is_better } = delta;
  const movedBetter = d !== null && d !== 0 && higher_is_better === d > 0;
  const improved = !regressed && movedBetter;

  const deltaText = d === null ? "-" : `${d > 0 ? "+" : ""}${fmt(d)}`;
  const deltaClass = regressed ? "text-crit" : improved ? "text-ok" : "text-ink-dim";
  const arrow = d === null || d === 0 ? "" : movedBetter ? " ▲" : " ▼";

  return (
    <tr className={`border-b border-line/60 ${regressed ? "bg-crit/5" : ""}`}>
      <td className="px-3 py-2 font-medium text-ink">{label}</td>
      <td className="px-3 py-2 text-right font-mono text-ink-dim">{a === null ? "-" : fmt(a)}</td>
      <td className="px-3 py-2 text-right font-mono text-ink">{b === null ? "-" : fmt(b)}</td>
      <td className={`px-3 py-2 text-right font-mono font-semibold ${deltaClass}`}>
        {deltaText}
        {arrow}
      </td>
    </tr>
  );
}

function Th({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return (
    <th className={`px-3 py-2 text-[11px] font-semibold uppercase tracking-[0.14em] text-ink-dim ${className}`}>
      {children}
    </th>
  );
}
