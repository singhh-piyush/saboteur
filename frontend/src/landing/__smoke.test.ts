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
    expect(html).toContain("ship a microservice without");
    expect(html).toContain("chaos testing.");
    expect(html).toContain("What you get back");
    expect(html).toContain("silent_lie");
  });
});
