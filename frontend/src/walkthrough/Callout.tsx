
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

import { usePrefersReducedMotion } from "./Spotlight";

export type Placement = "top" | "bottom" | "left" | "right" | "center";

const MARGIN = 12;
const GAP = 14;
const CW_NARROW = 320;
const CW_WIDE = 440;
const MOVE_MS = 820;
const EASE = "cubic-bezier(0.4, 0, 0.2, 1)";
const FADE_OUT_MS = 380;

interface CalloutProps {
  rect: DOMRect | null;
  placement: Placement;
  /** changes per beat so position + content recompute even for the same target element */
  anchorKey: string;
  /** wider card for action-heavy beats so buttons sit on one line */
  wide?: boolean;
  children: ReactNode;
}

function computePos(
  rect: DOMRect | null,
  placement: Placement,
  cw: number,
  ch: number,
): { left: number; top: number } {
  const vw = window.innerWidth;
  const vh = window.innerHeight;

  if (rect === null || placement === "center") {
    return { left: (vw - cw) / 2, top: (vh - ch) / 2 };
  }

  const cx = rect.left + rect.width / 2;
  const cy = rect.top + rect.height / 2;
  let place = placement;
  const dockLeft = rect.left >= cw;
  const dockRight = vw - rect.right >= cw;
  const roomBelow = rect.bottom + GAP + ch <= vh - MARGIN;
  const roomAbove = rect.top - GAP - ch >= MARGIN;
  if (place === "bottom" && !roomBelow && roomAbove) place = "top";
  else if (place === "top" && !roomAbove && roomBelow) place = "bottom";
  else if (place === "right" && !dockRight) place = dockLeft ? "left" : roomBelow ? "bottom" : "top";
  else if (place === "left" && !dockLeft) place = dockRight ? "right" : roomBelow ? "bottom" : "top";

  let left: number;
  let top: number;
  switch (place) {
    case "top":
      left = cx - cw / 2;
      top = rect.top - GAP - ch;
      break;
    case "left":
      left = rect.left - GAP - cw;
      top = cy - ch / 2;
      break;
    case "right":
      left = rect.right + GAP;
      top = cy - ch / 2;
      break;
    case "bottom":
    default:
      left = cx - cw / 2;
      top = rect.bottom + GAP;
      break;
  }

  left = Math.max(MARGIN, Math.min(left, vw - cw - MARGIN));
  top = Math.max(MARGIN, Math.min(top, vh - ch - MARGIN));
  return { left, top };
}

export function Callout({ rect, placement, anchorKey, wide = false, children }: CalloutProps) {
  const cardRef = useRef<HTMLDivElement>(null);
  const innerRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const [width, setWidth] = useState<number | null>(null);
  const [height, setHeight] = useState<number | null>(null);
  const [entered, setEntered] = useState(false);
  const reduced = usePrefersReducedMotion();

  // live children render directly (so same-beat content changes, e.g. the
  // autopilot pause strip, appear immediately); only the outgoing overlay
  // needs a snapshot of the previous beat's content
  const [shownKey, setShownKey] = useState(anchorKey);
  const [outgoing, setOutgoing] = useState<{ key: string; node: ReactNode } | null>(null);
  const lastChildren = useRef(children);
  if (shownKey !== anchorKey) {
    setOutgoing(reduced ? null : { key: shownKey, node: lastChildren.current });
    setShownKey(anchorKey);
  }
  lastChildren.current = children;

  useEffect(() => {
    if (!outgoing) return;
    const t = window.setTimeout(() => setOutgoing(null), FADE_OUT_MS + 20);
    return () => window.clearTimeout(t);
  }, [outgoing]);

  useLayoutEffect(() => {
    const inner = innerRef.current;
    if (!inner) return;
    const compute = () => {
      const cw = Math.min(wide ? CW_WIDE : CW_NARROW, window.innerWidth - MARGIN * 2);
      inner.style.width = `${cw}px`;
      const ch = inner.offsetHeight;
      setWidth(cw);
      setHeight(ch);
      setPos(computePos(rect, placement, cw, ch));
    };
    compute();
    const ro = new ResizeObserver(compute);
    ro.observe(inner);
    window.addEventListener("resize", compute);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", compute);
    };
    // Re-place when the target moves, content swaps, or width mode flips.
  }, [rect, placement, anchorKey, wide]);

  useEffect(() => {
    if (pos !== null && !entered) {
      const r = requestAnimationFrame(() => setEntered(true));
      return () => cancelAnimationFrame(r);
    }
  }, [pos, entered]);

  const move = reduced
    ? undefined
    : entered
      ? `left ${MOVE_MS}ms ${EASE}, top ${MOVE_MS}ms ${EASE}, width ${MOVE_MS}ms ${EASE}, height ${MOVE_MS}ms ${EASE}, opacity 360ms ease-out`
      : "opacity 360ms ease-out";

  return createPortal(
    <div
      ref={cardRef}
      role="dialog"
      aria-modal="false"
      className="fixed z-[120] overflow-hidden rounded-lg border border-line-strong bg-raised shadow-[0_16px_48px_-8px_rgb(0_0_0/70%)]"
      style={{
        left: pos?.left ?? -9999,
        top: pos?.top ?? -9999,
        width: width === null ? CW_NARROW : width,
        height: reduced || height === null ? undefined : height,
        opacity: entered ? 1 : 0,
        transition: move,
      }}
    >
      {/* inner wrapper: natural height so measurement is accurate */}
      <div ref={innerRef} className="relative p-4">
        {/* incoming content: fades in on each beat */}
        <div
          key={anchorKey}
          style={reduced ? undefined : { animation: `callout-in 440ms ease-out both` }}
        >
          {children}
        </div>
        {/* outgoing content: overlaid + fades out, then retired */}
        {outgoing && (
          <div
            key={outgoing.key}
            aria-hidden
            className="pointer-events-none absolute inset-0 p-4"
            style={{ animation: `callout-out ${FADE_OUT_MS}ms ease-out forwards` }}
          >
            {outgoing.node}
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}
