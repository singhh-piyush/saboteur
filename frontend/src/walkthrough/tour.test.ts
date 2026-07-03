/**
 * The guided tour over the REAL bundled demo runs: manifest shape, the face-off
 * beat's placement and data binding, run-binding monotonicity, and copy rules
 * (no em dashes; comparison numbers interpolated from the scorecards, never
 * hardcoded prose).
 */

import { describe, expect, it } from "vitest";

import { DEMO_RUNS } from "../demo";
import { buildTour } from "./tour";

const pct = (v: number | null) => (v === null ? "-" : `${Math.round(v * 100)}%`);

describe("bundled demo manifest", () => {
  it("bundles the two MI300X runs, 8B first", () => {
    expect(DEMO_RUNS).toHaveLength(2);
    expect(DEMO_RUNS[0].label).toContain("8B");
    expect(DEMO_RUNS[1].label).toContain("70B");
  });

  it("both runs are complete N=50 hell_mode cohorts", () => {
    for (const run of DEMO_RUNS) {
      expect(run.scorecard.profile).toBe("hell_mode");
      expect(run.scorecard.n_agents).toBe(50);
      expect(Object.keys(run.scorecard.per_agent)).toHaveLength(50);
      const terminals = run.events.filter(
        (ev) => ev.event === "agent_done" || ev.event === "agent_crashed",
      );
      expect(terminals).toHaveLength(50);
    }
  });
});

describe("buildTour over the bundled runs", () => {
  const beats = buildTour(DEMO_RUNS);
  const ids = beats.map((b) => b.id);

  it("includes every data-driven beat plus the face-off, in order", () => {
    expect(ids).toEqual([
      "intro",
      "grid",
      "chaos",
      "recover",
      "crash",
      "deception",
      "scorecard",
      "faceoff",
      "close",
    ]);
  });

  it("binds run indices monotonically: the 8B beats, then the 70B", () => {
    const runs = beats.map((b) => b.run);
    expect(runs).toEqual([...runs].sort((a, b) => a - b));
    expect(beats.find((b) => b.id === "scorecard")?.run).toBe(0);
    expect(beats.find((b) => b.id === "faceoff")?.run).toBe(1);
    expect(beats.find((b) => b.id === "close")?.run).toBe(1);
  });

  it("face-off compares both scorecards via interpolation", () => {
    const faceoff = beats.find((b) => b.id === "faceoff")!;
    expect(faceoff.target).toEqual({ kind: "region", name: "scorecard" });
    expect(faceoff.body).toContain(DEMO_RUNS[1].label);
    expect(faceoff.body).toContain(pct(DEMO_RUNS[0].scorecard.survival_rate));
    expect(faceoff.body).toContain(pct(DEMO_RUNS[1].scorecard.survival_rate));
    expect(faceoff.body).toContain(pct(DEMO_RUNS[0].scorecard.deception_detection_rate));
    expect(faceoff.body).toContain(pct(DEMO_RUNS[1].scorecard.deception_detection_rate));
  });

  it("entering a beat activates its bound run", () => {
    const switched: number[] = [];
    const ctx = {
      seek: () => {},
      seekSmooth: () => {},
      pause: () => {},
      selectAgent: () => {},
      setTab: () => {},
      switchRun: (i: number) => switched.push(i),
    };
    for (const beat of beats) {
      switched.length = 0;
      beat.onEnter(ctx);
      expect(switched).toEqual([beat.run]);
    }
  });

  it("close beat offers the watch-vs-landing choice on the scorecard", () => {
    const close = beats.find((b) => b.id === "close")!;
    expect(close.finishLabel).toBe("Watch the full run");
    expect(close.actions?.some((a) => a.kind === "exit")).toBe(true);
    // The close beat must not swap the canvas: it stays on the scorecard tab
    // the face-off already shows (the grid only appears when the viewer picks
    // "Watch the full run").
    const tabs: string[] = [];
    close.onEnter({
      seek: () => {},
      seekSmooth: () => {},
      pause: () => {},
      selectAgent: () => {},
      setTab: (t: string) => tabs.push(t),
      switchRun: () => {},
    });
    expect(tabs).toEqual(["scorecard"]);
  });

  it("copy contains no em dashes", () => {
    for (const beat of beats) {
      for (const text of [beat.eyebrow, beat.title, beat.body, beat.promptBody ?? ""]) {
        expect(text).not.toContain("—");
      }
    }
  });

  it("close beat mentions the run switcher when two runs are bundled", () => {
    expect(beats.find((b) => b.id === "close")?.body).toContain("flip runs");
  });
});
