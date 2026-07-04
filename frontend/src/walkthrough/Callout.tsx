/**
 * Callout - the coachmark card. Renders into document.body via a fixed-position
 * portal (same pattern as Tooltip's portal mode) and edge-flips so it never
 * clips at a grid or viewport edge.
 *
 * Motion contract (why this reads smoothly): when the beat changes we swap the
 * content IMMEDIATELY (render-phase), so position AND height are computed ONCE
 * from the incoming content. The card then makes a SINGLE glide - left, top and
 * height all transition together with one easing - never a mid-move reposition
 * (the old bug: the card started toward a spot sized for the previous text, then
 * jerked to a new spot when the text swapped at the midpoint). The text itself
 * cross-fades (incoming fades in, the outgoing text fades out as an overlay) so
 * the switch is almost imperceptible.
 */

import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

import { usePrefersReducedMotion } from "./Spotlight";

export type Placement = "top" | "bottom" | "left" | "right" | "center";

const MARGIN = 12;
const GAP = 14;
/** Card widths: narrow docks in the left gutter (scorecard / face-off beats),
 * wide gives the action-heavy close beat room for its button row. The width
 * morphs between them (see the transition below) instead of snapping. */
const CW_NARROW = 320;
const CW_WIDE = 440;
/** One easing, one duration for the whole card move (position + size together).
 * Ease-in-out: starts gently (no fast "shoot off"), glides, settles softly -
 * slow and elegant, and no reposition to catch in the middle any more. */
const MOVE_MS = 820;
const EASE = "cubic-bezier(0.4, 0, 0.2, 1)";
/** Content cross-fade - soft and unhurried so the text switch barely registers. */
const FADE_OUT_MS = 380;

interface CalloutProps {
  rect: DOMRect | null;
  placement: Placement;
  /** Changes per beat so position + content recompute even when the target rect
   * is the same element (e.g. successive timeline beats). */
  anchorKey: string;
  /** Roomier card for action-heavy beats (e.g. the closing beat's button row),
   * so the controls sit on one line instead of wrapping into a cramped stack. */
  wide?: boolean;
  children: ReactNode;
}

/** Where to place a card of size (cw, ch) around `rect`, flipping toward the
 * side with room and clamping into the viewport. Pure - depends only on inputs,
 * so a single call gives the card's final resting spot. */
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
  // "Dockable" to a side = there is roughly a card-width of gutter there, so the
  // card (clamped to the viewport edge) sits beside the target and only grazes
  // its padding - not a strict fit-with-gap. This keeps the scorecard / face-off
  // coachmarks in the left gutter (over the sidebar) on desktop instead of
  // flipping on top of the scorecard.
  const dockLeft = rect.left >= cw;
  const dockRight = vw - rect.right >= cw;
  const roomBelow = rect.bottom + GAP + ch <= vh - MARGIN;
  const roomAbove = rect.top - GAP - ch >= MARGIN;
  // Flip toward the side with room. With no side gutter (a wide target on a
  // narrow viewport, e.g. the scorecard on mobile), drop to bottom/top so the
  // card never lands on top of the target.
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
  const [height, setHeight] = useState<number | null>(null);
  const [entered, setEntered] = useState(false);
  const reduced = usePrefersReducedMotion();

  // Immediate (render-phase) content swap: the incoming node goes in-flow at
  // once so the card sizes to it and the layout effect below computes position +
  // height ONE time from the final content. The outgoing node is kept as an
  // absolute overlay purely to cross-fade out.
  const [shown, setShown] = useState<{ key: string; node: ReactNode }>({
    key: anchorKey,
    node: children,
  });
  const [outgoing, setOutgoing] = useState<{ key: string; node: ReactNode } | null>(null);
  if (shown.key !== anchorKey) {
    setOutgoing(reduced ? null : shown);
    setShown({ key: anchorKey, node: children });
  }

  // Retire the outgoing overlay once it has faded.
  useEffect(() => {
    if (!outgoing) return;
    const t = window.setTimeout(() => setOutgoing(null), FADE_OUT_MS + 20);
    return () => window.clearTimeout(t);
  }, [outgoing]);

  // Measure + place from the inner wrapper's natural size (the outgoing overlay
  // is absolute, so the wrapper is always sized to the CURRENT content). A
  // ResizeObserver keeps height + position correct not just across beats but
  // when the content itself changes size mid-beat (e.g. the face-off toggles its
  // chart or swaps models), so the card grows/shrinks in one smooth motion.
  useLayoutEffect(() => {
    const card = cardRef.current;
    const inner = innerRef.current;
    if (!card || !inner) return;
    const compute = () => {
      const cw = card.offsetWidth;
      const ch = inner.offsetHeight;
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
    // Re-place when the target moves/changes or the content swaps.
  }, [rect, placement, shown.key]);

  // Smooth first appearance: once positioned, fade in on the next frame (no glide
  // in from the corner); `entered` also gates the left/top/height glide so the
  // very first show never flies in.
  useEffect(() => {
    if (pos !== null && !entered) {
      const r = requestAnimationFrame(() => setEntered(true));
      return () => cancelAnimationFrame(r);
    }
  }, [pos, entered]);

  const move = reduced
    ? undefined
    : entered
      ? `left ${MOVE_MS}ms ${EASE}, top ${MOVE_MS}ms ${EASE}, height ${MOVE_MS}ms ${EASE}, opacity 360ms ease-out`
      : "opacity 360ms ease-out";

  return createPortal(
    <div
      ref={cardRef}
      role="dialog"
      aria-modal="false"
      className={`fixed z-[120] ${wide ? "w-[440px]" : "w-[320px]"} max-w-[88vw] overflow-hidden rounded-lg border border-line-strong bg-raised shadow-[0_16px_48px_-8px_rgb(0_0_0/70%)]`}
      style={{
        left: pos?.left ?? -9999,
        top: pos?.top ?? -9999,
        height: reduced || height === null ? undefined : height,
        opacity: entered ? 1 : 0,
        transition: move,
      }}
    >
      {/* Inner wrapper carries the padding and is always its natural height, so
          the measurement above is the true content size. */}
      <div ref={innerRef} className="relative p-4">
        {/* Incoming content, in flow - fades in on each beat. */}
        <div
          key={shown.key}
          style={reduced ? undefined : { animation: `callout-in 440ms ease-out both` }}
        >
          {shown.node}
        </div>
        {/* Outgoing content, overlaid - fades out, then is retired. */}
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
