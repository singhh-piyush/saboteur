/**
 * Spotlight - dims the whole screen except a measured "hole" around the tour's
 * current target, using the box-shadow-hole technique: a transparent box with a
 * huge spread shadow paints the dim around it, while the target beneath stays
 * lit and fully interactive (the layers are pointer-events:none). A second
 * blur-cutout layer adds a slight backdrop blur everywhere but the hole.
 *
 * Rendered into document.body so a transformed/contained ancestor can never
 * clip or mis-anchor the fixed positioning.
 */

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

const PAD = 8;
const RADIUS = 10;
// Slower, eased glide between targets - smooth "gradient" motion, not a snap.
const EASE = "cubic-bezier(0.4, 0, 0.2, 1)";
const MOVE_MS = 600;

export function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(
    () =>
      typeof window !== "undefined" &&
      window.matchMedia?.("(prefers-reduced-motion: reduce)").matches,
  );
  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const handler = () => setReduced(mq.matches);
    mq.addEventListener?.("change", handler);
    return () => mq.removeEventListener?.("change", handler);
  }, []);
  return reduced;
}

function closeRect(a: DOMRect | null, b: DOMRect | null): boolean {
  if (a === null || b === null) return a === b;
  return (
    Math.abs(a.left - b.left) < 0.5 &&
    Math.abs(a.top - b.top) < 0.5 &&
    Math.abs(a.width - b.width) < 0.5 &&
    Math.abs(a.height - b.height) < 0.5
  );
}

/**
 * Measure a target element's viewport rect and commit it to state only once it
 * has SETTLED (stable for a couple frames). This is the key to smooth motion:
 * an element that is still animating into place (e.g. the timeline drawer
 * sliding open over ~280ms) is not committed mid-flight - so the hole does not
 * chase a moving target frame-by-frame (which fought the CSS transition and
 * stuttered). Instead we wait for it to stop, commit once, and let a single
 * smooth transition glide the hole to its final position.
 *
 * Re-runs on `key` change (new beat) and on resize/scroll. `resolve` is read
 * from a ref so the latest closure is used without restarting the loop.
 */
export function useSpotlightRect(resolve: () => HTMLElement | null, key: string): DOMRect | null {
  const [rect, setRect] = useState<DOMRect | null>(null);
  const resolveRef = useRef(resolve);
  resolveRef.current = resolve;

  // Commit the target's rect SYNCHRONOUSLY on a beat/phase change, before paint.
  // Static targets (agent cells) are at their final position immediately, so the
  // hole lands on the correct element on the first frame - no multi-frame settle
  // delay and no glide from a stale target. The rAF loop below then only refines
  // targets that are still animating in (e.g. the timeline drawer).
  useLayoutEffect(() => {
    const el = resolveRef.current();
    if (!el) {
      setRect((prev) => (prev === null ? prev : null));
      return;
    }
    const r = el.getBoundingClientRect();
    if (r.width > 1 || r.height > 1) setRect((prev) => (closeRect(prev, r) ? prev : r));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  useEffect(() => {
    let stopped = false;
    let raf = 0;
    let frames = 0;
    let stable = 0;
    let committed = false;
    let last: DOMRect | null = null;

    const measure = (): DOMRect | null => {
      const el = resolveRef.current();
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return r.width > 1 || r.height > 1 ? r : null;
    };

    const loop = () => {
      if (stopped) return;
      frames += 1;
      const r = measure();
      stable = closeRect(r, last) ? stable + 1 : 0;
      last = r;

      if (r === null) {
        setRect((prev) => (prev === null ? prev : null));
      } else if (stable >= 2) {
        setRect((prev) => (closeRect(prev, r) ? prev : r));
        committed = true;
      }

      // Stop once a non-null target has clearly settled, or after ~1.5s.
      const settled = committed && stable >= 6;
      if (frames < 90 && !settled) raf = requestAnimationFrame(loop);
    };
    loop();

    // Window changes are discrete - commit immediately.
    const onChange = () => {
      const r = measure();
      setRect((prev) => (closeRect(prev, r) ? prev : r));
    };
    window.addEventListener("resize", onChange);
    window.addEventListener("scroll", onChange, true);
    return () => {
      stopped = true;
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", onChange);
      window.removeEventListener("scroll", onChange, true);
    };
  }, [key]);

  return rect;
}

export function Spotlight({ rect, snap = false }: { rect: DOMRect | null; snap?: boolean }) {
  const reduced = usePrefersReducedMotion();

  // No target (intro/close beat) - dim the whole screen.
  if (rect === null) {
    return createPortal(
      <div
        aria-hidden
        className="fixed inset-0 z-[90]"
        style={{ background: "rgba(0,0,0,0.6)", pointerEvents: "none" }}
      />,
      document.body,
    );
  }

  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const x = Math.max(rect.left - PAD, 0);
  const y = Math.max(rect.top - PAD, 0);
  const w = Math.min(rect.width + PAD * 2, vw - x);
  const h = Math.min(rect.height + PAD * 2, vh - y);

  // A single element carries the whole effect: its huge spread shadow dims
  // everything outside the hole, and it glides between targets with ONE easing
  // (no second clip-path-animated layer to desync mid-move). `snap` disables the
  // glide when jumping onto a fresh agent cell, so the hole never sweeps across
  // the grid to reach it.
  const holeTransition =
    reduced || snap
      ? "none"
      : `left ${MOVE_MS}ms ${EASE}, top ${MOVE_MS}ms ${EASE}, width ${MOVE_MS}ms ${EASE}, height ${MOVE_MS}ms ${EASE}`;

  return createPortal(
    <div
      aria-hidden
      className="fixed z-[91]"
      style={{
        left: x,
        top: y,
        width: w,
        height: h,
        borderRadius: RADIUS,
        boxShadow:
          "0 0 0 9999px rgba(0,0,0,0.6), inset 0 0 0 1px color-mix(in oklch, var(--color-accent) 45%, transparent)",
        pointerEvents: "none",
        transition: holeTransition,
      }}
    />,
    document.body,
  );
}
