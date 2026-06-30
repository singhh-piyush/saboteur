/**
 * A static example scorecard styled exactly like the live ScorecardView
 * (Tile / Panel / recharts BarChart), populated with our golden hell_mode run:
 * survival 0.88, deception detection 1.0. No fetch, no live data - deterministic
 * and offline. Charts have animation disabled so the section is stable.
 */

import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";

import { PanelHeader } from "../components/PanelHeader";
import { CountUp, Eyebrow, Heading, Lede, Reveal, Section } from "./parts";

// Golden hell_mode run (runs/hell_mode-…, captured offline via the mock).
const SC = {
  survival_rate: 0.88,
  deception_detection_rate: 1.0,
  crash_rate: 0.08,
  mttr_steps: 2.9,
  waste_factor: 1.6,
  recovery_breakdown: { retry: 14, reformulate: 6, fallback_tool: 4, no_action: 3, gave_up: 1 },
  failure_modes: { timeout: 1, silent_abandonment: 1 },
};

const TONES: Record<string, string> = {
  ok: "text-ok",
  warn: "text-warn",
  crit: "text-crit",
  win: "text-win",
  plain: "text-ink",
};

const pctFmt = (n: number) => `${Math.round(n)}%`;
const oneDp = (n: number) => n.toFixed(1);

export function ScorecardSection() {
  const recoveryData = Object.entries(SC.recovery_breakdown).map(([kind, count]) => ({ kind, count }));
  const failureEntries = Object.entries(SC.failure_modes);

  return (
    <Section className="border-y border-line bg-panel/40">
      <Reveal><Eyebrow>The scorecard</Eyebrow></Reveal>
      <Reveal delay={70}><Heading>What you get back.</Heading></Reveal>
      <Reveal delay={140}>
        <Lede className="mt-4">
          Not a pass/fail. A behavioral resilience profile - how the cohort recovered, how
          long it took, and what it failed on. Numbers below are a real hell_mode run.
        </Lede>
      </Reveal>

      <div className="mt-10 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Reveal delay={210}>
          <Tile
            label="survival - chaos"
            value={<CountUp to={SC.survival_rate * 100} format={pctFmt} />}
            tone={SC.survival_rate >= 0.75 ? "ok" : SC.survival_rate >= 0.4 ? "warn" : "crit"}
          />
        </Reveal>
        <Reveal delay={280}>
          <Tile label="deception caught" value={<CountUp to={SC.deception_detection_rate * 100} format={pctFmt} />} tone="ok" />
        </Reveal>
        <Reveal delay={350}>
          <Tile label="crash rate" value={<CountUp to={SC.crash_rate * 100} format={pctFmt} />} tone={SC.crash_rate > 0 ? "crit" : "plain"} />
        </Reveal>
        <Reveal delay={420}>
          <Tile label="MTTR (steps)" value={<CountUp to={SC.mttr_steps} format={oneDp} />} tone="plain" />
        </Reveal>
      </div>

      <div className="mt-3 grid gap-3 lg:grid-cols-2">
        <Reveal>
        <Panel title="RECOVERY BREAKDOWN">
          <ResponsiveContainer width="100%" height={200}>
            <BarChart data={recoveryData} margin={{ top: 8, right: 12, bottom: 0, left: -18 }}>
              <CartesianGrid stroke="rgba(255,255,255,0.06)" vertical={false} />
              <XAxis dataKey="kind" tick={{ fill: "#bcc4d4", fontSize: 11 }} stroke="rgba(255,255,255,0.1)" />
              <YAxis allowDecimals={false} tick={{ fill: "#8c95a8", fontSize: 11 }} stroke="rgba(255,255,255,0.1)" />
              <Tooltip content={<ChartTip />} cursor={{ fill: "rgba(255,255,255,0.04)" }} />
              <Bar dataKey="count" fill="var(--color-ok)" radius={[2, 2, 0, 0]} isAnimationActive={false} />
            </BarChart>
          </ResponsiveContainer>
        </Panel>
        </Reveal>

        <Reveal delay={90}>
        <Panel title="FAILURE MODES">
          <ul className="space-y-1.5">
            {failureEntries.map(([mode, count]) => (
              <li
                key={mode}
                className="flex items-center justify-between rounded-sm border border-crit/30 bg-crit/5 px-2.5 py-1.5 text-sm"
              >
                <span className="text-crit">{mode}</span>
                <span className="font-display text-base font-semibold text-ink">{count}</span>
              </li>
            ))}
            <li className="flex items-center justify-between rounded-sm border border-line bg-raised/40 px-2.5 py-1.5 text-sm">
              <span className="text-ink-dim">waste factor</span>
              <span className="font-display text-base font-semibold text-ink">
                <CountUp to={SC.waste_factor} format={(n) => `${n.toFixed(1)}x`} />
              </span>
            </li>
          </ul>
        </Panel>
        </Reveal>
      </div>
    </Section>
  );
}

function Tile({ label, value, tone }: { label: string; value: React.ReactNode; tone: keyof typeof TONES }) {
  return (
    <div className="rounded-md border border-line bg-panel px-3 py-2.5">
      <div className="text-[11px] font-semibold uppercase tracking-[0.14em] text-ink-dim">{label}</div>
      <div className={`font-display mt-1 text-3xl font-bold ${TONES[tone]}`}>{value}</div>
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
