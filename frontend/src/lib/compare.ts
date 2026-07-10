
export type MetricKind = "pct" | "steps";

export function fmtMetric(v: number | null | undefined, kind: MetricKind): string {
  if (v === null || v === undefined || Number.isNaN(v)) return "-";
  return kind === "pct" ? `${Math.round(v * 100)}%` : v.toFixed(1);
}

export interface DeltaInfo {
  /** true when both values exist and differ */
  changed: boolean;
  /** direction of improvement: up = better, down = worse */
  arrow: "▲" | "▼";
  /** colour tone for the movement (better = win, worse = crit) */
  tone: "win" | "crit";
  /** signed numeric change in the metric's unit, e.g. "+22 pts" / "-1.1" */
  deltaText: string;
}

export function deltaInfo(
  current: number | null | undefined,
  baseline: number | null | undefined,
  higherBetter: boolean,
  kind: MetricKind,
): DeltaInfo | null {
  if (current === null || current === undefined || baseline === null || baseline === undefined) {
    return null;
  }
  if (Number.isNaN(current) || Number.isNaN(baseline)) return null;

  const diff = current - baseline;
  const changed = diff !== 0;
  const better = higherBetter ? diff > 0 : diff < 0;

  const deltaText =
    kind === "pct"
      ? `${diff >= 0 ? "+" : ""}${Math.round(diff * 100)} pts`
      : `${diff >= 0 ? "+" : ""}${diff.toFixed(1)}`;

  return {
    changed,
    arrow: better ? "▲" : "▼",
    tone: better ? "win" : "crit",
    deltaText,
  };
}
