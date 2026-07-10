
import { describe, expect, it } from "vitest";

import { DEMO_FAMILIES } from "../demo";
import { buildTour } from "./tour";

const pct = (v: number | null) => (v === null ? "-" : `${Math.round(v * 100)}%`);

const CANONICAL_ORDER = [
  "intro",
  "grid",
  "chaos",
  "recover",
  "crash",
  "deception",
  "scorecard",
  "faceoff",
  "close",
];

describe("bundled demo manifest", () => {
  it("bundles two families of two MI300X runs each", () => {
    expect(DEMO_FAMILIES).toHaveLength(2);
    expect(DEMO_FAMILIES[0].id).toBe("llama");
    expect(DEMO_FAMILIES[1].id).toBe("gemma");
    for (const family of DEMO_FAMILIES) {
      expect(family.runs).toHaveLength(2);
      expect(family.name.length).toBeGreaterThan(0);
    }
  });

  it("family primaries are the 8B and the 26B MoE", () => {
    expect(DEMO_FAMILIES[0].runs[0].label).toContain("8B");
    expect(DEMO_FAMILIES[0].runs[1].label).toContain("70B");
    expect(DEMO_FAMILIES[1].runs[0].label).toContain("26B");
    expect(DEMO_FAMILIES[1].runs[1].label).toContain("31B");
  });

  it("all four runs are complete N=50 hell_mode cohorts with switcher labels", () => {
    for (const family of DEMO_FAMILIES) {
      for (const run of family.runs) {
        expect(run.scorecard.profile).toBe("hell_mode");
        expect(run.scorecard.n_agents).toBe(50);
        expect(Object.keys(run.scorecard.per_agent)).toHaveLength(50);
        expect(run.short.length).toBeGreaterThan(0);
        const terminals = run.events.filter(
          (ev) => ev.event === "agent_done" || ev.event === "agent_crashed",
        );
        expect(terminals).toHaveLength(50);
      }
    }
  });
});

describe.each(DEMO_FAMILIES.map((family) => [family.id, family] as const))(
  "buildTour over the %s family",
  (_id, family) => {
    const beats = buildTour(family.runs);
    const ids = beats.map((b) => b.id);

    it("includes every data-driven beat plus the face-off, in order", () => {
      expect(ids).toEqual(CANONICAL_ORDER);
    });

    it("binds run indices monotonically: the primary's beats, then the sibling", () => {
      const runs = beats.map((b) => b.run);
      expect(runs).toEqual([...runs].sort((a, b) => a - b));
      expect(beats.find((b) => b.id === "scorecard")?.run).toBe(0);
      expect(beats.find((b) => b.id === "faceoff")?.run).toBe(1);
      expect(beats.find((b) => b.id === "close")?.run).toBe(1);
    });

    it("face-off compares both scorecards via interpolation", () => {
      const faceoff = beats.find((b) => b.id === "faceoff")!;
      expect(faceoff.target).toEqual({ kind: "region", name: "scorecard" });
      expect(faceoff.body).toContain(family.runs[1].label);
      expect(faceoff.body).toContain(pct(family.runs[0].scorecard.survival_rate));
      expect(faceoff.body).toContain(pct(family.runs[1].scorecard.survival_rate));
      expect(faceoff.body).toContain(pct(family.runs[0].scorecard.deception_detection_rate));
      expect(faceoff.body).toContain(pct(family.runs[1].scorecard.deception_detection_rate));
    });

    it("face-off carries a compare payload wired to both runs' scorecards", () => {
      const faceoff = beats.find((b) => b.id === "faceoff")!;
      expect(faceoff.compare?.models).toHaveLength(2);
      expect(faceoff.compare?.models[0].scorecard).toBe(family.runs[0].scorecard);
      expect(faceoff.compare?.models[1].scorecard).toBe(family.runs[1].scorecard);
      expect(faceoff.compare?.models[0].short).toBe(family.runs[0].short);
      expect(faceoff.compare?.models[1].short).toBe(family.runs[1].short);
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

    it("copy contains no em dashes and no run-specific numbers in prose", () => {
      for (const beat of beats) {
        for (const text of [beat.eyebrow, beat.title, beat.body, beat.promptBody ?? ""]) {
          expect(text).not.toContain("—");
        }
      }
    });

    it("close beat mentions the run switcher when two runs are bundled", () => {
      expect(beats.find((b) => b.id === "close")?.body).toContain("flip runs");
    });
  },
);
