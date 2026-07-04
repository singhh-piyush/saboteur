import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { DEMO_FAMILIES } from "../demo";
import { FamilySelect } from "./FamilySelect";
import { Reveal } from "./Reveal";

describe("FamilySelect smoke render", () => {
  const html = renderToStaticMarkup(
    createElement(FamilySelect, {
      families: DEMO_FAMILIES,
      onSelect: () => {},
      onExit: () => {},
    }),
  );

  it("renders the heading and both family cards with actual model names", () => {
    expect(html).toContain("Pick a model family");
    // The actual bundled model names, derived from the run labels.
    expect(html).toContain("Llama 3.1 8B");
    expect(html).toContain("Llama 3.1 70B");
    expect(html).toContain("Gemma 26B-A4B MoE");
    expect(html).toContain("Gemma 31B dense");
    // Cohort facts derive from the scorecard, never hand-typed.
    expect(html).toContain("hell_mode");
    expect(html).toContain("50 agents");
  });

  it("contains no em dashes", () => {
    expect(html).not.toContain("—");
  });
});

describe("Reveal smoke render", () => {
  const html = renderToStaticMarkup(
    createElement(Reveal, { family: DEMO_FAMILIES[1], onDone: () => {} }),
  );

  it("renders the single title page: family logo, tested-under line, wordmark, skip hint", () => {
    expect(html).toContain("tested under");
    expect(html).toContain("SABOTEUR");
    expect(html).toContain("click anywhere to skip");
  });

  it("contains no em dashes", () => {
    expect(html).not.toContain("—");
  });
});
