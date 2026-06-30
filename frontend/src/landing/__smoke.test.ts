import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { Landing } from "./Landing";

describe("Landing smoke render", () => {
  it("renders to static markup without throwing", () => {
    const html = renderToStaticMarkup(createElement(Landing, { onLaunch: () => {} }));
    expect(html).toContain("SABOTEUR");
    expect(html).toContain("Chaos engineering for AI agents");
    // golden-run numbers surface in the example scorecard
    expect(html).toContain("88%");
    // fault taxonomy renders the silent_lie callout
    expect(html).toContain("silent_lie");
  });
});
