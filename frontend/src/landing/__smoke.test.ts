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
    // cold-open intro copy (renders on the front door; landing paints behind it).
    // Key phrases sit in accent <span>s, so assert the contiguous fragments.
    expect(html).toContain("ship a microservice without");
    expect(html).toContain("chaos testing.");
    // the example scorecard section renders (its numbers count up client-side,
    // so assert on stable copy rather than the animated value)
    expect(html).toContain("What you get back");
    // fault taxonomy renders the silent_lie callout
    expect(html).toContain("silent_lie");
  });
});
