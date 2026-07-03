/**
 * The swap point for the static walkthrough demo.
 *
 * To add or replace a demo run: drop a `{name}.jsonl` + `{name}.scorecard.json`
 * pair in this directory, import them below, and add one entry to `DEMO_RUNS`
 * with a human label (the model under test). Nothing else changes - each run's
 * `id` is derived from its scorecard's `run_id`, the walkthrough tour rebuilds
 * from the data, and the landing scorecard renders `DEMO_RUNS[0]`. With more
 * than one entry, the walkthrough playbar shows a run switcher and the guided
 * tour ends with a face-off beat that swaps to `DEMO_RUNS[1]` in place (the
 * provider switches runs without remounting, so the swap is seamless).
 *
 * Files are imported as raw text (`?raw`) and parsed at runtime. This keeps
 * `resolveJsonModule` out of tsconfig and makes the JSONL parse explicit.
 */

import type { Scorecard } from "../lib/api";
import type { TelemetryEvent } from "../types/telemetry";

// Vite inlines these as strings at build time (declared by vite/client).
// Both runs: hell_mode, N=50, seed 666, captured on an AMD MI300X via vLLM.
import raw8b from "./llama31_8b_mi300x_n50.jsonl?raw";
import sc8b from "./llama31_8b_mi300x_n50.scorecard.json?raw";
import raw70b from "./llama31_70b_mi300x_n50.jsonl?raw";
import sc70b from "./llama31_70b_mi300x_n50.scorecard.json?raw";

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
  /** Human label for the run switcher (typically the model under test). */
  label: string;
  events: TelemetryEvent[];
  scorecard: Scorecard;
}

function makeRun(label: string, eventsRaw: string, scRaw: string): DemoRun {
  const scorecard = parseScorecard(scRaw);
  return { id: scorecard.run_id, label, events: parseEvents(eventsRaw), scorecard };
}

/** The bundled demo runs. `DEMO_RUNS[0]` is the default everywhere; the tour's
 * face-off beat switches to `DEMO_RUNS[1]` when a second run is bundled. */
export const DEMO_RUNS: DemoRun[] = [
  makeRun("Llama 3.1 8B on MI300X", raw8b, sc8b),
  makeRun("Llama 3.1 70B on MI300X", raw70b, sc70b),
];
