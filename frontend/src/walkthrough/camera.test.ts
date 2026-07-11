
import { describe, expect, it } from "vitest";

import {
  applyToRect,
  CAMERA_IDENTITY,
  computeCamera,
  untransformRect,
  type CameraTransform,
  type SimpleRect,
} from "./camera";

const VW = 1280;
const VH = 800;

describe("computeCamera", () => {
  it("full-viewport rect stays at identity", () => {
    const c = computeCamera({ left: 0, top: 0, width: VW, height: VH }, VW, VH);
    expect(c).toEqual(CAMERA_IDENTITY);
  });

  it("small central rect zooms, capped at 1.35, and centers the target", () => {
    const rect = { left: 500, top: 300, width: 180, height: 90 };
    const c = computeCamera(rect, VW, VH);
    expect(c.scale).toBe(1.35);
    const cx = rect.left + rect.width / 2;
    expect(c.x + c.scale * cx).toBeCloseTo(VW / 2, 5);
    const cy = rect.top + rect.height / 2;
    expect(c.y + c.scale * cy).toBeCloseTo(VH / 2, 5);
  });

  it("translate is clamped so the console never leaves gutters", () => {
    const corner = { left: 0, top: 0, width: 200, height: 100 };
    const c = computeCamera(corner, VW, VH);
    expect(c.x).toBeLessThanOrEqual(0);
    expect(c.x).toBeGreaterThanOrEqual(VW - c.scale * VW);
    expect(c.y).toBeLessThanOrEqual(0);
    expect(c.y).toBeGreaterThanOrEqual(VH - c.scale * VH);
  });

  it("tall narrow panel gets a modest push, not the cap", () => {
    const panel = { left: 8, top: 160, width: 320, height: 480 };
    const c = computeCamera(panel, VW, VH);
    expect(c.scale).toBeGreaterThan(1);
    expect(c.scale).toBeLessThan(1.35);
  });

  it("near-full-height panel resolves to identity (no room to zoom)", () => {
    const panel = { left: 8, top: 120, width: 320, height: 620 };
    expect(computeCamera(panel, VW, VH)).toEqual(CAMERA_IDENTITY);
  });
});

describe("applyToRect / untransformRect", () => {
  const cam: CameraTransform = { scale: 1.3, x: -120, y: -64 };
  const base: SimpleRect = { left: 300, top: 200, width: 240, height: 160 };

  it("round-trips exactly", () => {
    const applied = applyToRect(base, cam);
    const back = untransformRect(applied, cam);
    expect(back.left).toBeCloseTo(base.left, 8);
    expect(back.top).toBeCloseTo(base.top, 8);
    expect(back.width).toBeCloseTo(base.width, 8);
    expect(back.height).toBeCloseTo(base.height, 8);
  });

  it("identity is a no-op", () => {
    expect(applyToRect(base, CAMERA_IDENTITY)).toEqual(base);
    expect(untransformRect(base, CAMERA_IDENTITY)).toEqual(base);
  });

  it("spot rect at the camera destination centers with the camera", () => {
    const central: SimpleRect = { left: 500, top: 320, width: 240, height: 160 };
    const c = computeCamera(central, VW, VH);
    const spot = applyToRect(central, c);
    expect(spot.left + spot.width / 2).toBeCloseTo(VW / 2, 5);
    expect(spot.top + spot.height / 2).toBeCloseTo(VH / 2, 5);
  });
});
