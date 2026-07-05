import { useEffect, useState } from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import {
  ApiError,
  fetchAllEvents,
  fetchScorecard,
  type Scorecard,
} from "../lib/api";
import { deltaInfo, fmtMetric, type MetricKind } from "../lib/compare";
import { num, pct } from "../lib/format";
import { PanelHeader } from "./PanelHeader";
import { Tooltip as HoverTip } from "./Tooltip";
import { foldEvents } from "../state/reducer";
import { survivalRate, survivalSeries, type SurvivalPoint } from "../state/selectors";
import { useRun } from "../state/RunContext";

interface ScorecardData {
  scorecard: Scorecard;
  controlSurvival: number | null;
  series: SurvivalPoint[];
}

interface ScorecardViewProps {
  /** When set (walkthrough face-off beat), each of the three headline tiles
   * that moved versus this baseline scorecard shows an arrow + delta sub-line
   * and a subtle highlight pulse. Undefined in the live console (no change). */
  baseline?: Scorecard | null;
  /** Short label of the baseline model, e.g. "8B" (the "from" side). */
  baselineLabel?: string;
}

export function ScorecardView({ baseline = null, baselineLabel }: ScorecardViewProps = {}) {
  const { state, activeRunId } = useRun();
  const [data, setData] = useState<ScorecardData | null>(null);
  const [note, setNote] = useState<string>("");

  useEffect(() => {
    if (activeRunId === null) {
      setData(null);
      setNote("No active run. Launch one or replay an archived run.");
      return;
    }
    let cancelled = false;

    async function load() {
      if (activeRunId === null) return;
      try {
        const scorecard = await fetchScorecard(activeRunId);
        // The scorecard is a pure function of the event streams (invariant
        // #3) - so is everything extra we derive here, via the same reducer
        // the live grid uses.
        const chaosEvents = await fetchAllEvents(activeRunId);
        let controlSurvival: number | null = null;
        if (scorecard.control_run_id) {
          try {
            const controlEvents = await fetchAllEvents(scorecard.control_run_id);
            controlSurvival = survivalRate(foldEvents(controlEvents));
          } catch {
            controlSurvival = null;
          }
        }
        if (cancelled) return;
        setData({
          scorecard,
          controlSurvival,
          series: survivalSeries(foldEvents(chaosEvents).terminals),
        });
        setNote("");
      } catch (err) {
        if (cancelled) return;
        setData(null);
        setNote(
          err instanceof ApiError && err.status === 425
            ? "Run still in progress - the scorecard lands when the cohort finishes."
            : "No scorecard for this run yet.",
        );
      }
    }

    void load();
    return () => {
      cancelled = true;
    };
  }, [activeRunId, state.finished]);

  if (data === null) {
    return (
      <div className="flex h-full items-center justify-center p-8 text-center text-sm text-ink-dim">
        {note || "Loading scorecard…"}
      </div>
    );
  }

  const { scorecard: sc, controlSurvival, series } = data;

  // Guided highlight (walkthrough face-off): when a baseline model is supplied
  // and this scorecard is a DIFFERENT run, annotate the moved headline metrics
  // with an arrow + delta + subtle pulse. animKey = run_id so the pulse replays
  // on each model switch. No baseline (live console) => every shift is undefined.
  const compareOn = baseline !== null && baseline.run_id !== sc.run_id;
  const makeShift = (
    current: number | null,
    base: number | null,
    higherBetter: boolean,
    kind: MetricKind,
  ): Shift | undefined => {
    if (!compareOn || baseline === null) return undefined;
    const d = deltaInfo(current, base, higherBetter, kind);
    if (!d || !d.changed) return undefined;
    return {
      fromText: fmtMetric(base, kind),
      toText: fmtMetric(current, kind),
      arrow: d.arrow,
      deltaText: d.deltaText,
      tone: d.tone,
      fromLabel: baselineLabel,
      animKey: sc.run_id,
    };
  };

  const recoveryData = Object.entries(sc.recovery_breakdown).map(
    ([kind, count]) => ({ kind, count }),
  );
  const failureEntries = Object.entries(sc.failure_modes);

  return (
    <div className="h-full space-y-4 overflow-y-auto p-4">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Tile
          label="survival - chaos"
          value={pct(sc.survival_rate)}
          hint={sc.survival_rate === null ? reasonLabel(sc.survival_rate_reason) : undefined}
          tone={
            sc.survival_rate === null
              ? "plain"
              : sc.survival_rate >= 0.75
                ? "ok"
                : sc.survival_rate >= 0.4
                  ? "warn"
                  : "crit"
          }
          tooltip="% of agents the oracle judged successful under fault injection (null without an oracle)"
          shift={makeShift(sc.survival_rate, baseline?.survival_rate ?? null, true, "pct")}
        />
        <Tile
          label="survival - control"
          value={pct(controlSurvival)}
          tone="win"
          tooltip="% of agents that completed under the calm-seas baseline (no faults)"
        />
        <Tile
          label="deception caught"
          value={pct(sc.deception_detection_rate)}
          hint={
            sc.deception_detection_rate === null
              ? reasonLabel(sc.deception_detection_rate_reason)
              : undefined
          }
          tone={
            sc.deception_detection_rate === null
              ? "plain"
              : sc.deception_detection_rate >= 0.5
                ? "ok"
                : "crit"
          }
          tooltip="% of lied-to agents that resisted the silent_lie decoy (reference oracle only)"
          shift={makeShift(
            sc.deception_detection_rate,
            baseline?.deception_detection_rate ?? null,
            true,
            "pct",
          )}
        />
        <Tile
          label="crash rate"
          value={pct(sc.crash_rate)}
          tone={sc.crash_rate > 0 ? "crit" : "plain"}
          tooltip="% of agents that hard-crashed (hard_exception). NOT 1 - survival - excludes timeout / stall / abandonment"
        />
        <Tile
          label="MTTR (steps)"
          value={sc.mttr_steps === null ? "-" : num(sc.mttr_steps, 2)}
          tone="plain"
          tooltip="Mean time to recovery - avg steps from a fault to the next productive action"
          shift={makeShift(sc.mttr_steps, baseline?.mttr_steps ?? null, false, "steps")}
        />
        <Tile
          label="waste factor"
          value={sc.waste_factor === null ? "-" : `${num(sc.waste_factor, 2)}x`}
          tone="plain"
          tooltip="Chaos tokens used vs control tokens - ratio >1 means fault recovery burned extra tokens"
        />
        <Tile
          label="latency degr. (rough)"
          value={sc.latency_degradation === null ? "-" : `${num(sc.latency_degradation, 2)}x`}
          tone="plain"
          tooltip="Mean chaos run duration vs control - rough: also reflects batching contention, not isolated injected latency"
        />
        <Tile
          label="oracle"
          value={sc.oracle ?? "-"}
          tone="plain"
          tooltip="Which success oracle judged this run (builtin_reference / regex / assertion_command / http_callback)"
        />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Panel title="SURVIVAL OVER TIME">
          {series.length === 0 ? (
            <Empty>No terminal events.</Empty>
          ) : (
            <ResponsiveContainer width="100%" height={200}>
              <LineChart data={series} margin={{ top: 8, right: 12, bottom: 0, left: -18 }}>
                <CartesianGrid stroke="rgba(255,255,255,0.06)" vertical={false} />
                <XAxis
                  dataKey="t"
                  tick={{ fill: "#6b7385", fontSize: 11 }}
                  stroke="rgba(255,255,255,0.1)"
                  unit="s"
                />
                <YAxis
                  allowDecimals={false}
                  tick={{ fill: "#6b7385", fontSize: 11 }}
                  stroke="rgba(255,255,255,0.1)"
                />
                <Tooltip content={<ChartTip />} />
                <Line
                  type="stepAfter"
                  dataKey="done"
                  name="finished"
                  stroke="#6b7385"
                  strokeWidth={1.5}
                  dot={false}
                  isAnimationActive={false}
                />
                <Line
                  type="stepAfter"
                  dataKey="succeeded"
                  name="succeeded"
                  stroke="var(--color-win)"
                  strokeWidth={2}
                  dot={false}
                  isAnimationActive={false}
                />
              </LineChart>
            </ResponsiveContainer>
          )}
        </Panel>

        <Panel title="RECOVERY BREAKDOWN">
          {recoveryData.length === 0 ? (
            <Empty>No recovery actions recorded.</Empty>
          ) : (
            <ResponsiveContainer width="100%" height={200}>
              <BarChart data={recoveryData} margin={{ top: 8, right: 12, bottom: 0, left: -18 }}>
                <CartesianGrid stroke="rgba(255,255,255,0.06)" vertical={false} />
                <XAxis
                  dataKey="kind"
                  tick={{ fill: "#a0a8b8", fontSize: 11 }}
                  stroke="rgba(255,255,255,0.1)"
                />
                <YAxis
                  allowDecimals={false}
                  tick={{ fill: "#6b7385", fontSize: 11 }}
                  stroke="rgba(255,255,255,0.1)"
                />
                <Tooltip content={<ChartTip />} cursor={{ fill: "rgba(255,255,255,0.04)" }} />
                <Bar
                  dataKey="count"
                  fill="var(--color-ok)"
                  radius={[2, 2, 0, 0]}
                  isAnimationActive={false}
                />
              </BarChart>
            </ResponsiveContainer>
          )}
        </Panel>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Panel title="FAILURE MODES">
          {failureEntries.length === 0 ? (
            <Empty>None - every agent completed.</Empty>
          ) : (
            <ul className="space-y-1.5">
              {failureEntries.map(([mode, count]) => (
                <li
                  key={mode}
                  className="flex items-center justify-between rounded-sm border border-crit/30 bg-crit/5 px-2.5 py-1.5 text-sm"
                >
                  <span className="text-crit">{mode}</span>
                  <span className="font-display text-base font-semibold text-ink">
                    {count}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Panel>

        <Panel title="RUN">
          <dl className="space-y-1.5 text-sm">
            <Row k="run id" v={sc.run_id} mono />
            <Row k="profile" v={sc.profile} />
            <Row k="agents" v={String(sc.n_agents)} />
            <Row k="control" v={sc.control_run_id ?? "none"} mono />
          </dl>
        </Panel>
      </div>
    </div>
  );
}

const TONES: Record<string, string> = {
  ok: "text-ok",
  warn: "text-warn",
  crit: "text-crit",
  win: "text-win",
  plain: "text-ink",
};

const REASON_LABELS: Record<string, string> = {
  no_oracle: "no oracle",
  deception_requires_reference_oracle: "needs reference oracle",
  no_deception_probe: "no silent_lie probe",
};

function reasonLabel(reason: string | null): string | undefined {
  if (!reason) return undefined;
  return REASON_LABELS[reason] ?? reason.replace(/_/g, " ");
}

/** Guided-highlight annotation for a moved metric (walkthrough face-off). */
interface Shift {
  fromText: string;
  toText: string;
  arrow: "▲" | "▼";
  deltaText: string;
  tone: "win" | "crit";
  /** Short label of the baseline model (the "from" side), if known. */
  fromLabel?: string;
  /** Changes on model switch so the pulse overlay replays. */
  animKey: string;
}

function Tile({
  label,
  value,
  tone,
  tooltip,
  hint,
  shift,
}: {
  label: string;
  value: string;
  tone: keyof typeof TONES;
  tooltip?: string;
  hint?: string;
  shift?: Shift;
}) {
  const shiftTone = shift ? (shift.tone === "win" ? "text-win" : "text-crit") : "";
  const pulseColor = shift?.tone === "win" ? "var(--color-win)" : "var(--color-crit)";
  return (
    <div className="relative overflow-hidden rounded-md border border-line bg-panel px-3 py-2.5">
      {/* Subtle highlight overlay - replays via key on each model switch. */}
      {shift ? (
        <span
          key={shift.animKey}
          aria-hidden
          className="metric-shift pointer-events-none absolute inset-0 rounded-md"
          style={{ ["--pulse-color" as string]: pulseColor }}
        />
      ) : null}
      {tooltip ? (
        <HoverTip label={tooltip} side="bottom">
          <div className="inline-block cursor-default border-b border-dashed border-ink-faint/40 text-[11px] font-semibold uppercase tracking-[0.14em] text-ink-dim transition-colors duration-150 hover:text-ink">
            {label}
          </div>
        </HoverTip>
      ) : (
        <div className="text-[11px] font-semibold uppercase tracking-[0.14em] text-ink-dim">
          {label}
        </div>
      )}
      <div className={`font-display mt-1 text-3xl font-bold ${TONES[tone]}`}>
        {value}
      </div>
      {shift ? (
        // Grow the delta line in smoothly so the tile expands into its new size
        // (rather than snapping) when the face-off beat starts.
        <div className="stat-grow">
          <div className="min-h-0 overflow-hidden">
            <div className="mt-1 flex items-center gap-1.5 text-[11px] font-semibold">
              <span className="text-ink-faint">
                {shift.fromLabel ? `${shift.fromLabel} ` : ""}
                {shift.fromText}
              </span>
              <span className="text-ink-faint" aria-hidden>{"→"}</span>
              <span className="text-ink-dim">{shift.toText}</span>
              <span className={`ml-0.5 ${shiftTone}`}>
                <span aria-hidden>{shift.arrow}</span> {shift.deltaText}
              </span>
            </div>
          </div>
        </div>
      ) : hint ? (
        <div className="mt-0.5 text-[10px] font-medium uppercase tracking-[0.1em] text-ink-faint">
          {hint}
        </div>
      ) : null}
    </div>
  );
}

function Panel({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-md border border-line bg-panel">
      <PanelHeader title={title} />
      <div className="p-3">{children}</div>
    </section>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <p className="py-6 text-center text-sm text-ink-faint">{children}</p>;
}

function Row({ k, v, mono = false }: { k: string; v: string; mono?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="shrink-0 text-[11px] font-semibold uppercase tracking-[0.14em] text-ink-dim">{k}</dt>
      <dd className={`truncate font-medium text-ink-dim ${mono ? "font-mono text-xs" : ""}`}>
        {v}
      </dd>
    </div>
  );
}

function ChartTip({
  active,
  payload,
  label,
}: {
  active?: boolean;
  payload?: { name?: string; value?: number; color?: string }[];
  label?: string | number;
}) {
  if (!active || !payload || payload.length === 0) return null;
  return (
    <div className="rounded-sm border border-line bg-raised px-2 py-1.5 text-xs text-ink">
      <div className="mb-0.5 text-ink-faint">{label}</div>
      {payload.map((p, i) => (
        <div key={i} style={{ color: p.color }}>
          {p.name}: {p.value}
        </div>
      ))}
    </div>
  );
}
