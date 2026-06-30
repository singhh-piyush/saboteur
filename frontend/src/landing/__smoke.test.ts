import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { Landing } from "./Landing";

describe("Landing smoke render", () => {
  it("renders to static markup without throwing", () => {
    const html = renderToStaticMarkup(
      createElement(Landing, { onLaunch: () => {}, onWatch: () => {} }),
    );
    expect(html).toContain("SABOTEUR");
    expect(html).toContain("Chaos engineering for AI agents");
    // the example scorecard section renders (its numbers count up client-side,
    // so assert on stable copy rather than the animated value)
    expect(html).toContain("What you get back");
    // fault taxonomy renders the silent_lie callout
    expect(html).toContain("silent_lie");
  });
});
