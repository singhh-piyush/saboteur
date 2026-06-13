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

export function ScorecardView() {
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
        // #3) — so is everything extra we derive here, via the same reducer
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
  const recoveryData = Object.entries(sc.recovery_breakdown).map(
    ([kind, count]) => ({ kind, count }),
  );
  const failureEntries = Object.entries(sc.failure_modes);

  return (
    <div className="h-full space-y-4 overflow-y-auto p-4">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        <Tile
          label="survival - chaos"
          value={pct(sc.survival_rate)}
          tone={sc.survival_rate >= 0.75 ? "ok" : sc.survival_rate >= 0.4 ? "warn" : "crit"}
          tooltip="% of agents that completed the task under fault injection"
        />
        <Tile
          label="survival - control"
          value={pct(controlSurvival)}
          tone="win"
          tooltip="% of agents that completed under the calm-seas baseline (no faults)"
        />
        <Tile
          label="MTTR (steps)"
          value={sc.mttr_steps === null ? "-" : num(sc.mttr_steps, 2)}
          tone="plain"
          tooltip="Mean time to recovery - avg steps from a fault to the next successful action"
        />
        <Tile
          label="waste factor"
          value={sc.waste_factor === null ? "-" : `${num(sc.waste_factor, 2)}x`}
          tone="plain"
          tooltip="Chaos tokens used vs control tokens - ratio >1 means fault recovery burned extra tokens"
        />
        <Tile
          label="deception caught"
          value={pct(sc.deception_detection_rate)}
          tone={
            sc.deception_detection_rate === null
              ? "plain"
              : sc.deception_detection_rate >= 0.5
                ? "ok"
                : "crit"
          }
          tooltip="% of agents that detected a silent_lie fault (correct data shape, wrong values)"
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

function Tile({
  label,
  value,
  tone,
  tooltip,
}: {
  label: string;
  value: string;
  tone: keyof typeof TONES;
  tooltip?: string;
}) {
  return (
    <div className="rounded-md border border-line bg-panel px-3 py-2.5">
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
