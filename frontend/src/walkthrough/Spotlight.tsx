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

import { useEffect, useRef, useState } from "react";
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

export function Spotlight({ rect }: { rect: DOMRect | null }) {
  const reduced = usePrefersReducedMotion();

  // No target (intro/close beat) - dim and blur the whole screen.
  if (rect === null) {
    return createPortal(
      <div
        aria-hidden
        className="fixed inset-0 z-[90]"
        style={{ background: "rgba(0,0,0,0.6)", backdropFilter: "blur(2px)", pointerEvents: "none" }}
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

  // A single non-self-intersecting polygon that wraps the viewport with a
  // rectangular notch over the hole - robust across browsers (no fill-rule).
  const cut = [
    `0px 0px`,
    `0px ${vh}px`,
    `${x}px ${vh}px`,
    `${x}px ${y}px`,
    `${x + w}px ${y}px`,
    `${x + w}px ${y + h}px`,
    `${x}px ${y + h}px`,
    `${x}px ${vh}px`,
    `${vw}px ${vh}px`,
    `${vw}px 0px`,
  ].join(", ");

  const holeTransition = reduced
    ? "none"
    : `left ${MOVE_MS}ms ${EASE}, top ${MOVE_MS}ms ${EASE}, width ${MOVE_MS}ms ${EASE}, height ${MOVE_MS}ms ${EASE}`;
  const blurTransition = reduced ? "none" : `clip-path ${MOVE_MS}ms ${EASE}`;

  return createPortal(
    <>
      {/* Blur everything but the hole; the cutout morphs smoothly between beats. */}
      <div
        aria-hidden
        className="fixed inset-0 z-[90]"
        style={{
          backdropFilter: "blur(2px)",
          clipPath: `polygon(${cut})`,
          pointerEvents: "none",
          transition: blurTransition,
        }}
      />
      {/* Dim the screen via the hole's huge spread shadow; ring the hole accent. */}
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
      />
    </>,
    document.body,
  );
}
