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
            ? "Run still in progress — the scorecard lands when the cohort finishes."
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
          label="survival — chaos"
          value={pct(sc.survival_rate)}
          tone={sc.survival_rate >= 0.75 ? "ok" : sc.survival_rate >= 0.4 ? "warn" : "crit"}
        />
        <Tile
          label="survival — control"
          value={pct(controlSurvival)}
          tone="win"
        />
        <Tile
          label="MTTR (steps)"
          value={sc.mttr_steps === null ? "—" : num(sc.mttr_steps, 2)}
          tone="plain"
        />
        <Tile
          label="waste factor"
          value={sc.waste_factor === null ? "—" : `${num(sc.waste_factor, 2)}×`}
          tone="plain"
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
                  tick={{ fill: "#545d70", fontSize: 10 }}
                  stroke="rgba(255,255,255,0.1)"
                  unit="s"
                />
                <YAxis
                  allowDecimals={false}
                  tick={{ fill: "#545d70", fontSize: 10 }}
                  stroke="rgba(255,255,255,0.1)"
                />
                <Tooltip content={<ChartTip />} />
                <Line
                  type="stepAfter"
                  dataKey="done"
                  name="finished"
                  stroke="#545d70"
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
                  tick={{ fill: "#8e96a7", fontSize: 10 }}
                  stroke="rgba(255,255,255,0.1)"
                />
                <YAxis
                  allowDecimals={false}
                  tick={{ fill: "#545d70", fontSize: 10 }}
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
            <Empty>None — every agent completed.</Empty>
          ) : (
            <ul className="space-y-1.5">
              {failureEntries.map(([mode, count]) => (
                <li
                  key={mode}
                  className="flex items-center justify-between rounded-sm border border-crit/30 bg-crit/5 px-2.5 py-1.5 text-xs"
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
          <dl className="space-y-1.5 text-xs">
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
}: {
  label: string;
  value: string;
  tone: keyof typeof TONES;
}) {
  return (
    <div className="rounded-md border border-line bg-panel px-3 py-2.5">
      <div className="text-[10px] uppercase tracking-[0.16em] text-ink-faint">
        {label}
      </div>
      <div className={`font-display mt-1 text-3xl font-bold ${TONES[tone]}`}>
        {value}
      </div>
    </div>
  );
}

function Panel({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-md border border-line bg-panel">
      <header className="border-b border-line px-3 py-2">
        <h3 className="font-display text-xs font-semibold tracking-[0.22em] text-ink-dim">
          {title}
        </h3>
      </header>
      <div className="p-3">{children}</div>
    </section>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <p className="py-6 text-center text-xs text-ink-faint">{children}</p>;
}

function Row({ k, v, mono = false }: { k: string; v: string; mono?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="shrink-0 uppercase tracking-[0.14em] text-ink-faint">{k}</dt>
      <dd className={`truncate text-ink-dim ${mono ? "font-mono text-[11px]" : ""}`}>
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
    <div className="rounded-sm border border-line bg-raised px-2 py-1.5 text-[11px] text-ink">
      <div className="mb-0.5 text-ink-faint">{label}</div>
      {payload.map((p, i) => (
        <div key={i} style={{ color: p.color }}>
          {p.name}: {p.value}
        </div>
      ))}
    </div>
  );
}
