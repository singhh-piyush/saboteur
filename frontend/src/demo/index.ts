
import type { Scorecard } from "../lib/api";
import type { TelemetryEvent } from "../types/telemetry";

import raw8b from "./llama31_8b_mi300x_n50.jsonl?raw";
import sc8b from "./llama31_8b_mi300x_n50.scorecard.json?raw";
import raw70b from "./llama31_70b_mi300x_n50.jsonl?raw";
import sc70b from "./llama31_70b_mi300x_n50.scorecard.json?raw";
import rawG26 from "./gemma_26b_a4b_mi300x_n50.jsonl?raw";
import scG26 from "./gemma_26b_a4b_mi300x_n50.scorecard.json?raw";
import rawG31 from "./gemma_31b_dense_mi300x_n50.jsonl?raw";
import scG31 from "./gemma_31b_dense_mi300x_n50.scorecard.json?raw";

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
  /** the run id - drives the offline registry + scorecardview's activerunid */
  id: string;
  /** human label for the run (the model under test) */
  label: string;
  /** short label for the playbar's within-family sibling switcher */
  short: string;
  events: TelemetryEvent[];
  scorecard: Scorecard;
}

export interface DemoFamily {
  id: "llama" | "gemma";
  /** family display name - the selector card and the reveal title card */
  name: string;
  /** the family's runs; `runs[0]` is the primary the demo opens on */
  runs: DemoRun[];
}

function makeRun(label: string, short: string, eventsRaw: string, scRaw: string): DemoRun {
  const scorecard = parseScorecard(scRaw);
  return { id: scorecard.run_id, label, short, events: parseEvents(eventsRaw), scorecard };
}

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
