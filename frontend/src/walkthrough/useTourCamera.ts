
import { useEffect, useState, type RefObject } from "react";

import { resolveTourTarget } from "./autopilot";
import {
  applyToRect,
  CAMERA_IDENTITY,
  computeCamera,
  untransformRect,
  type CameraTransform,
  type SimpleRect,
} from "./camera";
import { scrollWithinContainer } from "./Spotlight";
import type { Beat, TourTarget } from "./tour";

export interface TourCameraState {
  camera: CameraTransform;
  /** screen-space spotlight rect at the camera's destination; null = full dim / centered callout */
  spotRect: DOMRect | null;
}

const IDLE: TourCameraState = { camera: CAMERA_IDENTITY, spotRect: null };

/** Read the wrapper's currently RENDERED transform (exact even mid-transition). */
function renderedCamera(wrapper: HTMLElement | null): CameraTransform {
  if (!wrapper) return CAMERA_IDENTITY;
  const t = getComputedStyle(wrapper).transform;
  if (!t || t === "none") return CAMERA_IDENTITY;
  const m = new DOMMatrixReadOnly(t);
  return { scale: m.a, x: m.e, y: m.f };
}

/**
 * One measurement pipeline for the tour's cinematics: settles the target's rect
 * in base (untransformed) space - which is invariant while the camera is in
 * flight - then commits the camera transform AND the spotlight rect at that
 * camera's destination in a single state update, so hole, callout and zoom
 * travel together on the same 820ms ease.
 */
export function useTourCamera(opts: {
  active: boolean;
  beat: Beat | null;
  awaiting: boolean;
  reducedMotion: boolean;
  wrapperRef: RefObject<HTMLDivElement | null>;
}): TourCameraState {
  const { active, beat, awaiting, reducedMotion, wrapperRef } = opts;
  const [state, setState] = useState<TourCameraState>(IDLE);
  const [epoch, setEpoch] = useState(0);

  useEffect(() => {
    const onInvalidate = () => setEpoch((e) => e + 1);
    window.addEventListener("resize", onInvalidate);
    window.addEventListener("scroll", onInvalidate, true);
    return () => {
      window.removeEventListener("resize", onInvalidate);
      window.removeEventListener("scroll", onInvalidate, true);
    };
  }, []);

  useEffect(() => {
    if (!active || !beat) {
      setState(IDLE);
      return;
    }
    const target: TourTarget =
      awaiting && beat.interactive
        ? { kind: "agent", id: beat.interactive.agent }
        : beat.target;
    if (target.kind === "none") {
      setState(IDLE);
      return;
    }
    const wide = target.kind === "region" && target.name === "grid";

    let stopped = false;
    let raf = 0;
    let frames = 0;
    let stable = 0;
    let committed: SimpleRect | null = null;
    let last: SimpleRect | null = null;
    let scrolled = false;

    const close = (a: SimpleRect | null, b: SimpleRect | null): boolean => {
      if (a === null || b === null) return a === b;
      return (
        Math.abs(a.left - b.left) < 0.5 &&
        Math.abs(a.top - b.top) < 0.5 &&
        Math.abs(a.width - b.width) < 0.5 &&
        Math.abs(a.height - b.height) < 0.5
      );
    };

    const measureBase = (): SimpleRect | null => {
      const el = resolveTourTarget(target);
      if (!el) return null;
      if (!scrolled) {
        scrollWithinContainer(el);
        scrolled = true;
      }
      const r = el.getBoundingClientRect();
      if (r.width <= 1 && r.height <= 1) return null;
      return untransformRect(r, renderedCamera(wrapperRef.current));
    };

    const commit = (base: SimpleRect) => {
      const cam =
        wide || reducedMotion
          ? CAMERA_IDENTITY
          : computeCamera(base, window.innerWidth, window.innerHeight);
      const s = applyToRect(base, cam);
      setState({ camera: cam, spotRect: new DOMRect(s.left, s.top, s.width, s.height) });
      committed = base;
    };

    const loop = () => {
      if (stopped) return;
      frames += 1;
      const b = measureBase();
      stable = close(b, last) ? stable + 1 : 0;
      last = b;

      if (b === null) {
        if (committed !== null || frames > 12) {
          committed = null;
          setState(IDLE);
        }
      } else if (stable >= 2 && !close(b, committed)) {
        commit(b);
      }

      const settled = committed !== null && stable >= 8;
      if (frames < 120 && !settled) raf = requestAnimationFrame(loop);
    };
    loop();

    return () => {
      stopped = true;
      cancelAnimationFrame(raf);
    };
    // wrapperRef is a stable ref; beat identity covers target/wide.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, beat, awaiting, reducedMotion, epoch]);

  return state;
}
