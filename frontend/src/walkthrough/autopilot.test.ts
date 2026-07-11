
import { describe, expect, it } from "vitest";

import { DRIVE_LABEL, planPhase, readingMs } from "./autopilot";
import type { Beat } from "./tour";

function beat(overrides: Partial<Beat> = {}): Beat {
  return {
    id: "b",
    run: 0,
    target: { kind: "none" },
    placement: "center",
    eyebrow: "E",
    title: "T",
    body: "x".repeat(80),
    onEnter: () => {},
    ...overrides,
  };
}

describe("readingMs", () => {
  it("clamps to [4000, 30000]", () => {
    expect(readingMs("")).toBe(4000);
    expect(readingMs("x".repeat(500))).toBe(30000);
    const mid = readingMs("x".repeat(80));
    expect(mid).toBeGreaterThan(4000);
    expect(mid).toBeLessThan(30000);
  });

  it("paces a typical coachmark near 100 wpm including the orientation beat", () => {
    const ms = readingMs("x".repeat(250));
    const words = 250 / 5.8;
    const wpm = words / (ms / 60000);
    expect(wpm).toBeGreaterThan(90);
    expect(wpm).toBeLessThan(110);
  });
});

describe("planPhase", () => {
  it("normal beat: dwell then next", () => {
    const steps = planPhase(beat(), false);
    expect(steps).toEqual([
      { kind: "dwell", ms: readingMs("x".repeat(80)) },
      { kind: "click", target: "next" },
    ]);
  });

  it("interactive awaiting: dwell on promptBody then click the agent cell", () => {
    const b = beat({ interactive: { agent: 7 }, promptBody: "click it" });
    const steps = planPhase(b, true);
    expect(steps).toEqual([
      { kind: "dwell", ms: readingMs("click it") },
      { kind: "click", target: "agent", agent: 7 },
    ]);
  });

  it("interactive revealed: dwell on body then next", () => {
    const b = beat({ interactive: { agent: 7 }, promptBody: "click it" });
    const steps = planPhase(b, false);
    expect(steps[0]).toEqual({ kind: "dwell", ms: readingMs("x".repeat(80)) });
    expect(steps[steps.length - 1]).toEqual({ kind: "click", target: "next" });
  });

  it("face-off: opens and closes the comparison before advancing", () => {
    const b = beat({
      compare: { models: [{}, {}] } as unknown as Beat["compare"],
    });
    const kinds = planPhase(b, false).map((s) =>
      s.kind === "click" ? s.target : "dwell",
    );
    expect(kinds).toEqual(["dwell", "compare", "dwell", "compare", "dwell", "next"]);
  });

  it("non-interactive beat ignores awaiting", () => {
    expect(planPhase(beat(), true)).toEqual(planPhase(beat(), false));
  });

  it("last beat: dwell only, never clicks past the closing choice", () => {
    expect(planPhase(beat(), false, true)).toEqual([
      { kind: "dwell", ms: readingMs("x".repeat(80)) },
    ]);
  });

  it("last beat still clicks the agent cell while awaiting", () => {
    const b = beat({ interactive: { agent: 3 }, promptBody: "click it" });
    const steps = planPhase(b, true, true);
    expect(steps[steps.length - 1]).toEqual({ kind: "click", target: "agent", agent: 3 });
  });
});

describe("copy", () => {
  it("has no em-dash", () => {
    expect(DRIVE_LABEL).not.toMatch(/—/);
  });
});
