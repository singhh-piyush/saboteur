
import { afterEach, describe, expect, it, vi } from "vitest";

import { apiUrl, wsUrl } from "./api";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("apiUrl", () => {
  it("defaults to same-origin relative paths", () => {
    expect(apiUrl("/runs")).toBe("/runs");
  });

  it("prefixes the configured base URL", () => {
    vi.stubEnv("VITE_API_BASE_URL", "http://localhost:8080");
    expect(apiUrl("/runs")).toBe("http://localhost:8080/runs");
  });

  it("strips trailing slashes from the base", () => {
    vi.stubEnv("VITE_API_BASE_URL", "http://localhost:8080/");
    expect(apiUrl("/runs")).toBe("http://localhost:8080/runs");
  });
});

describe("wsUrl", () => {
  it("derives ws:// from an http base", () => {
    vi.stubEnv("VITE_API_BASE_URL", "http://localhost:8080");
    expect(wsUrl("run 1")).toBe("ws://localhost:8080/ws/run%201");
  });

  it("derives wss:// from an https base", () => {
    vi.stubEnv("VITE_API_BASE_URL", "https://api.example.com");
    expect(wsUrl("r")).toBe("wss://api.example.com/ws/r");
  });

  it("falls back to the page origin when same-origin", () => {
    vi.stubGlobal("window", {
      location: { protocol: "https:", host: "console.example.com" },
    });
    expect(wsUrl("r")).toBe("wss://console.example.com/ws/r");
  });
});
