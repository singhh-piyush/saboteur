/**
 * Shared metric comparison helpers for the walkthrough face-off: format a
 * scorecard metric and describe how one model's value moved versus another.
 * Used by the guided highlight on ScorecardView tiles and by the side-by-side
 * comparison overlay - one source of truth so both read identically.
 */

export type MetricKind = "pct" | "steps";

/** Format a metric value for display. null renders as "-". */
export function fmtMetric(v: number | null | undefined, kind: MetricKind): string {
  if (v === null || v === undefined || Number.isNaN(v)) return "-";
  return kind === "pct" ? `${Math.round(v * 100)}%` : v.toFixed(1);
}

export interface DeltaInfo {
  /** True when both values exist and differ. */
  changed: boolean;
  /** Direction of improvement: up = better, down = worse. */
  arrow: "▲" | "▼";
  /** Colour tone for the movement (better = win, worse = crit). */
  tone: "win" | "crit";
  /** Signed numeric change in the metric's unit, e.g. "+22 pts" / "-1.1". */
  deltaText: string;
}

/**
 * How `current` moved relative to `baseline`. Arrow/tone follow BETTER vs WORSE
 * (per `higherBetter`), not raw numeric direction - so MTTR falling 3.2 -> 2.1
 * is an improvement (▲ win) even though the number went down. Returns null when
 * either value is missing. `changed` is false when the values are equal.
 */
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
