/**
 * The swap point for the static walkthrough demo.
 *
 * Runs are grouped into MODEL FAMILIES: the walkthrough opens on a family
 * selector, plays that family's primary run (`runs[0]`), and the playbar's
 * sibling switcher flips between the family's runs only. To add or replace a
 * run: drop a `{name}.jsonl` + `{name}.scorecard.json` pair in this directory,
 * import them below, and add one entry to the right family with a human label
 * (the model under test) and a `short` switcher label. Nothing else changes -
 * each run's `id` is derived from its scorecard's `run_id`, the walkthrough
 * tour rebuilds from the data (the tour's face-off beat swaps to the family's
 * second run in place), and the landing scorecard renders the first family's
 * primary run.
 *
 * Files are imported as raw text (`?raw`) and parsed at runtime. This keeps
 * `resolveJsonModule` out of tsconfig and makes the JSONL parse explicit.
 */

import type { Scorecard } from "../lib/api";
import type { TelemetryEvent } from "../types/telemetry";

// Vite inlines these as strings at build time (declared by vite/client).
// All four runs: hell_mode, N=50, seed 666, captured on an AMD MI300X via vLLM.
import raw8b from "./llama31_8b_mi300x_n50.jsonl?raw";
import sc8b from "./llama31_8b_mi300x_n50.scorecard.json?raw";
import raw70b from "./llama31_70b_mi300x_n50.jsonl?raw";
import sc70b from "./llama31_70b_mi300x_n50.scorecard.json?raw";
import rawG26 from "./gemma_26b_a4b_mi300x_n50.jsonl?raw";
import scG26 from "./gemma_26b_a4b_mi300x_n50.scorecard.json?raw";
import rawG31 from "./gemma_31b_dense_mi300x_n50.jsonl?raw";
import scG31 from "./gemma_31b_dense_mi300x_n50.scorecard.json?raw";

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
  /** Human label for the run (the model under test). */
  label: string;
  /** Short label for the playbar's within-family sibling switcher. */
  short: string;
  events: TelemetryEvent[];
  scorecard: Scorecard;
}

export interface DemoFamily {
  id: "llama" | "gemma";
  /** Family display name - the selector card and the reveal title card. */
  name: string;
  /** The family's runs; `runs[0]` is the primary the demo opens on. */
  runs: DemoRun[];
}

function makeRun(label: string, short: string, eventsRaw: string, scRaw: string): DemoRun {
  const scorecard = parseScorecard(scRaw);
  return { id: scorecard.run_id, label, short, events: parseEvents(eventsRaw), scorecard };
}

/** The bundled model families. `DEMO_FAMILIES[0].runs[0]` is what the landing
 * scorecard derives from; the walkthrough plays whichever family is chosen. */
export const DEMO_FAMILIES: DemoFamily[] = [
  {
    id: "llama",
    name: "Llama 3.1",
    runs: [
      makeRun("Llama 3.1 8B on MI300X", "8B", raw8b, sc8b),
      makeRun("Llama 3.1 70B on MI300X", "70B", raw70b, sc70b),
    ],
  },
  {
    id: "gemma",
    name: "Gemma",
    runs: [
      makeRun("Gemma 26B-A4B MoE on MI300X", "26B-A4B MoE", rawG26, scG26),
      makeRun("Gemma 31B dense on MI300X", "31B dense", rawG31, scG31),
    ],
  },
];
