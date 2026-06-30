/**
 * The single swap point for the static walkthrough demo.
 *
 * To point the walkthrough at a later run (e.g. an AMD MI300X cohort), replace
 * the two bundled files - `run.jsonl` and `scorecard.json` - and nothing else.
 * `DEMO_RUN.id` is derived from the scorecard's `run_id`, so it follows the
 * data automatically; no constant needs editing.
 *
 * Both files are imported as raw text (`?raw`) and parsed at runtime. This
 * keeps `resolveJsonModule` out of tsconfig and makes the JSONL parse explicit.
 */

import type { Scorecard } from "../lib/api";
import type { TelemetryEvent } from "../types/telemetry";

// Vite inlines these as strings at build time (declared by vite/client).
import runRaw from "./run.jsonl?raw";
import scorecardRaw from "./scorecard.json?raw";

/** Parse a JSONL event log: one TelemetryEvent JSON object per line. A single
 * malformed line is skipped rather than failing the whole replay. */
export function parseEvents(raw: string): TelemetryEvent[] {
  const events: TelemetryEvent[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    try {
      events.push(JSON.parse(trimmed) as TelemetryEvent);
    } catch {
      // Skip a corrupt line; never abort the bundled demo.
    }
  }
  return events;
}

export function parseScorecard(raw: string): Scorecard {
  return JSON.parse(raw) as Scorecard;
}

export interface DemoRun {
  /** The run id - drives the offline registry + ScorecardView's activeRunId. */
  id: string;
  events: TelemetryEvent[];
  scorecard: Scorecard;
}

const scorecard = parseScorecard(scorecardRaw);

export const DEMO_RUN: DemoRun = {
  id: scorecard.run_id,
  events: parseEvents(runRaw),
  scorecard,
};
