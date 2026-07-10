
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

const PAD = 8;
const RADIUS = 10;
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

export function useSpotlightRect(resolve: () => HTMLElement | null, key: string): DOMRect | null {
  const [rect, setRect] = useState<DOMRect | null>(null);
  const resolveRef = useRef(resolve);
  resolveRef.current = resolve;

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

      const settled = committed && stable >= 6;
      if (frames < 90 && !settled) raf = requestAnimationFrame(loop);
    };
    loop();

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

  const holeTransition =
    reduced || snap
      ? "none"
      : `left ${MOVE_MS}ms ${EASE}, top ${MOVE_MS}ms ${EASE}, width ${MOVE_MS}ms ${EASE}, height ${MOVE_MS}ms ${EASE}`;
  const blockTransition = reduced || snap ? "none" : `clip-path ${MOVE_MS}ms ${EASE}`;

  return createPortal(
    <>
      {/* blocks clicks outside the hole; spotlighted target stays interactive */}
      <div
        aria-hidden
        className="fixed inset-0 z-[90]"
        style={{ clipPath: `polygon(${cut})`, pointerEvents: "auto", transition: blockTransition }}
      />
      {/* hole with spread shadow; pointer events pass through to target */}
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
