
import { describe, expect, it } from "vitest";

import { CAMERA_IDENTITY, computeCamera, type CameraTransform } from "./camera";

const VW = 1280;
const VH = 800;

function applied(base: { left: number; top: number; width: number; height: number }, c: CameraTransform) {
  return {
    left: c.x + c.scale * base.left,
    top: c.y + c.scale * base.top,
    width: c.scale * base.width,
    height: c.scale * base.height,
  };
}

describe("computeCamera", () => {
  it("full-viewport rect stays at identity", () => {
    const c = computeCamera({ left: 0, top: 0, width: VW, height: VH }, CAMERA_IDENTITY, VW, VH);
    expect(c).toEqual(CAMERA_IDENTITY);
  });

  it("small central rect zooms, capped at 1.35, and centers the target", () => {
    const rect = { left: 500, top: 300, width: 180, height: 90 };
    const c = computeCamera(rect, CAMERA_IDENTITY, VW, VH);
    expect(c.scale).toBe(1.35);
    const cx = rect.left + rect.width / 2;
    expect(c.x + c.scale * cx).toBeCloseTo(VW / 2, 5);
    const cy = rect.top + rect.height / 2;
    expect(c.y + c.scale * cy).toBeCloseTo(VH / 2, 5);
  });

  it("translate is clamped so the console never leaves gutters", () => {
    const corner = { left: 0, top: 0, width: 200, height: 100 };
    const c = computeCamera(corner, CAMERA_IDENTITY, VW, VH);
    expect(c.x).toBeLessThanOrEqual(0);
    expect(c.x).toBeGreaterThanOrEqual(VW - c.scale * VW);
    expect(c.y).toBeLessThanOrEqual(0);
    expect(c.y).toBeGreaterThanOrEqual(VH - c.scale * VH);
  });

  it("is stable when re-measured under its own transform", () => {
    const base = { left: 300, top: 200, width: 240, height: 160 };
    const c1 = computeCamera(base, CAMERA_IDENTITY, VW, VH);
    const c2 = computeCamera(applied(base, c1), c1, VW, VH);
    expect(c2.scale).toBeCloseTo(c1.scale, 5);
    expect(c2.x).toBeCloseTo(c1.x, 5);
    expect(c2.y).toBeCloseTo(c1.y, 5);
  });

  it("tall narrow panel gets a modest push, not the cap", () => {
    const panel = { left: 8, top: 160, width: 320, height: 480 };
    const c = computeCamera(panel, CAMERA_IDENTITY, VW, VH);
    expect(c.scale).toBeGreaterThan(1);
    expect(c.scale).toBeLessThan(1.35);
  });

  it("near-full-height panel resolves to identity (no room to zoom)", () => {
    const panel = { left: 8, top: 120, width: 320, height: 620 };
    expect(computeCamera(panel, CAMERA_IDENTITY, VW, VH)).toEqual(CAMERA_IDENTITY);
  });
});
