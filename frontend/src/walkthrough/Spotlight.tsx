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
// Slow, eased glide between targets - moves in step with the coachmark card
// (same easing + duration) so the spotlight and explainer travel together,
// elegantly. Ease-in-out starts gently, no fast shoot-off.
const EASE = "cubic-bezier(0.4, 0, 0.2, 1)";
const MOVE_MS = 820;

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

/**
 * Bring `el` into view by scrolling ONLY its nearest genuinely-scrollable
 * ancestor (an `overflow-y: auto|scroll` container that actually overflows) -
 * i.e. the cohort grid's own scroll pane for an agent cell. We do NOT use the
 * native `el.scrollIntoView()`: that walks the whole ancestor chain and will
 * bump the scrollTop of an `overflow: hidden` container too (the browser still
 * scrolls hidden overflow programmatically), which shoved the entire main card
 * - RunBar, tab nav, grid - up out of view when the spotlight measured the
 * full-height grid pane. Stopping at the first real scroller keeps `main`
 * fixed, so region targets (grid/chaoslog/scorecard/...) never shift anything.
 */
function scrollWithinContainer(el: HTMLElement): void {
  let parent = el.parentElement;
  while (parent) {
    const oy = getComputedStyle(parent).overflowY;
    if ((oy === "auto" || oy === "scroll") && parent.scrollHeight > parent.clientHeight) {
      const er = el.getBoundingClientRect();
      const cr = parent.getBoundingClientRect();
      const PAD_V = 8;
      if (er.top < cr.top + PAD_V) {
        parent.scrollTop -= cr.top + PAD_V - er.top;
      } else if (er.bottom > cr.bottom - PAD_V) {
        parent.scrollTop += er.bottom - (cr.bottom - PAD_V);
      }
      return;
    }
    parent = parent.parentElement;
  }
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
  // First bring an agent cell into view WITHIN THE GRID'S OWN SCROLL PANE (a
  // no-op for region targets, whose nearest scroller is the grid or nothing) so
  // it is at its FINAL on-screen position before we measure - the hole then
  // glides straight to it instead of diving toward an off-screen rect and
  // snapping back. Crucially this never scrolls the `main` card (see
  // scrollWithinContainer), so region beats can't shove the cohort up. The rAF
  // loop below only refines targets still animating in (e.g. the drawer).
  useLayoutEffect(() => {
    const el = resolveRef.current();
    if (!el) {
      setRect((prev) => (prev === null ? prev : null));
      return;
    }
    scrollWithinContainer(el);
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

  // No target (intro/close beat) - dim AND block the whole screen: during the
  // tour the dimmed UI must be inert (pointerEvents: auto captures the clicks).
  if (rect === null) {
    return createPortal(
      <div
        aria-hidden
        className="fixed inset-0 z-[90]"
        style={{ background: "rgba(0,0,0,0.6)", pointerEvents: "auto" }}
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

  // A viewport-wrapping polygon with a rectangular notch over the hole. This
  // shapes the click-blocker's hit area: it captures pointer events everywhere
  // EXCEPT the hole (the notch is clipped away, so clicks there reach the
  // spotlighted target - e.g. the agent cell on an interactive beat).
  const cut = [
    `0 0`,
    `0 ${vh}px`,
    `${x}px ${vh}px`,
    `${x}px ${y}px`,
    `${x + w}px ${y}px`,
    `${x + w}px ${y + h}px`,
    `${x}px ${y + h}px`,
    `${x}px ${vh}px`,
    `${vw}px ${vh}px`,
    `${vw}px 0`,
  ].join(", ");

  // The visible dim is a single box-shadow-hole element with ONE easing (no
  // second clip-path-animated layer to desync mid-move). `snap` disables the
  // glide when jumping onto a fresh agent cell so the hole never sweeps across
  // the grid. The blocker is invisible, so animating its clip-path costs nothing
  // visually - it just tracks the hole.
  const holeTransition =
    reduced || snap
      ? "none"
      : `left ${MOVE_MS}ms ${EASE}, top ${MOVE_MS}ms ${EASE}, width ${MOVE_MS}ms ${EASE}, height ${MOVE_MS}ms ${EASE}`;
  const blockTransition = reduced || snap ? "none" : `clip-path ${MOVE_MS}ms ${EASE}`;

  return createPortal(
    <>
      {/* Click-blocker: inert everywhere but the hole, so greyed-out UI can't be
          clicked during the tour while the spotlighted target stays live. */}
      <div
        aria-hidden
        className="fixed inset-0 z-[90]"
        style={{ clipPath: `polygon(${cut})`, pointerEvents: "auto", transition: blockTransition }}
      />
      {/* Visible dim via the hole's spread shadow (pass-through: pointer events
          in the hole reach the target beneath). */}
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
