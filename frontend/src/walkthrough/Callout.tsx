/**
 * Callout - the coachmark card. Renders into document.body via a fixed-position
 * portal (same pattern as Tooltip's portal mode) and edge-flips so it never
 * clips at a grid or viewport edge. Measured after layout so flipping/clamping
 * uses the card's real size.
 */

import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

import { usePrefersReducedMotion } from "./Spotlight";

export type Placement = "top" | "bottom" | "left" | "right" | "center";

const MARGIN = 12;
const GAP = 14;

interface CalloutProps {
  rect: DOMRect | null;
  placement: Placement;
  /** Changes per beat so position recomputes even when the target rect is the
   * same element (e.g. successive timeline beats). */
  anchorKey: string;
  children: ReactNode;
}

export function Callout({ rect, placement, anchorKey, children }: CalloutProps) {
  const cardRef = useRef<HTMLDivElement>(null);
  const childrenRef = useRef<ReactNode>(children);
  childrenRef.current = children;
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const [entered, setEntered] = useState(false);
  // The content actually on screen. It is swapped only at the midpoint of the
  // cross-fade (once the old text has faded out) so the body text transitions
  // smoothly between beats instead of snapping.
  const [shown, setShown] = useState<{ key: string; node: ReactNode }>(() => ({
    key: anchorKey,
    node: children,
  }));
  const [contentVisible, setContentVisible] = useState(true);
  const reduced = usePrefersReducedMotion();

  useLayoutEffect(() => {
    const compute = () => {
      const card = cardRef.current;
      if (!card) return;
      const cw = card.offsetWidth;
      const ch = card.offsetHeight;
      const vw = window.innerWidth;
      const vh = window.innerHeight;

      let left: number;
      let top: number;

      if (rect === null || placement === "center") {
        left = (vw - cw) / 2;
        top = (vh - ch) / 2;
      } else {
        const cx = rect.left + rect.width / 2;
        const cy = rect.top + rect.height / 2;
        let place = placement;
        const roomLeft = rect.left - GAP - cw >= MARGIN;
        const roomRight = rect.right + GAP + cw <= vw - MARGIN;
        const roomBelow = rect.bottom + GAP + ch <= vh - MARGIN;
        // Flip toward the side with room. For a side placement with no room on
        // EITHER flank (a wide target on a narrow viewport, e.g. the scorecard
        // on mobile), drop to bottom (or top) so the card never lands on top of
        // the target - the scorecard stays unobscured at any width.
        if (place === "bottom" && !roomBelow && rect.top - GAP - ch > MARGIN) place = "top";
        else if (place === "top" && rect.top - GAP - ch < MARGIN && roomBelow) place = "bottom";
        else if (place === "right" && !roomRight) place = roomLeft ? "left" : roomBelow ? "bottom" : "top";
        else if (place === "left" && !roomLeft) place = roomRight ? "right" : roomBelow ? "bottom" : "top";

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
      }

      left = Math.max(MARGIN, Math.min(left, vw - cw - MARGIN));
      top = Math.max(MARGIN, Math.min(top, vh - ch - MARGIN));
      setPos({ left, top });
    };

    compute();
    window.addEventListener("resize", compute);
    return () => window.removeEventListener("resize", compute);
    // Recompute off the *shown* content (post-swap) so the card is measured at the
    // size it actually displays, plus whenever the target rect/placement changes.
  }, [rect, placement, shown.key]);

  // Smooth first appearance: once positioned, place at the real spot (no glide in
  // from the corner), then fade in on the next frame. `entered` also gates the
  // left/top glide so the very first show never flies in.
  useEffect(() => {
    if (pos !== null && !entered) {
      const r = requestAnimationFrame(() => setEntered(true));
      return () => cancelAnimationFrame(r);
    }
  }, [pos, entered]);

  // Cross-fade the body text on beat change: fade the current text out, swap it at
  // the midpoint (while invisible), then fade the new text in. Reduced motion swaps
  // instantly.
  useEffect(() => {
    if (anchorKey === shown.key) return;
    if (reduced) {
      setShown({ key: anchorKey, node: childrenRef.current });
      return;
    }
    setContentVisible(false);
    const t = window.setTimeout(() => {
      setShown({ key: anchorKey, node: childrenRef.current });
      setContentVisible(true);
    }, 160);
    return () => window.clearTimeout(t);
  }, [anchorKey, shown.key, reduced]);

  const POSE = "cubic-bezier(0.4, 0, 0.2, 1)";

  return createPortal(
    <div
      ref={cardRef}
      role="dialog"
      aria-modal="false"
      className="fixed z-[120] w-[340px] max-w-[88vw] rounded-lg border border-line-strong bg-raised p-4 shadow-[0_16px_48px_-8px_rgb(0_0_0/70%)]"
      style={{
        left: pos?.left ?? -9999,
        top: pos?.top ?? -9999,
        opacity: entered ? 1 : 0,
        transition: reduced
          ? undefined
          : entered
            ? `left 560ms ${POSE}, top 560ms ${POSE}, opacity 320ms ease-out`
            : "opacity 320ms ease-out",
      }}
    >
      {/* Body text cross-fades (out -> swap -> in) as the card glides to the next beat. */}
      <div
        style={
          reduced
            ? undefined
            : {
                opacity: contentVisible ? 1 : 0,
                transform: contentVisible ? "translateY(0)" : "translateY(4px)",
                transition: contentVisible
                  ? "opacity 280ms ease-out, transform 280ms cubic-bezier(0.22, 1, 0.36, 1)"
                  : "opacity 160ms ease-in, transform 160ms ease-in",
              }
        }
      >
        {shown.node}
      </div>
    </div>,
    document.body,
  );
}
