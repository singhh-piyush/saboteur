/**
 * Callout - the coachmark card. Renders into document.body via a fixed-position
 * portal (same pattern as Tooltip's portal mode) and edge-flips so it never
 * clips at a grid or viewport edge. Measured after layout so flipping/clamping
 * uses the card's real size.
 */

import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
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
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
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
        // Flip toward the side with room.
        if (place === "bottom" && rect.bottom + GAP + ch > vh - MARGIN && rect.top - GAP - ch > MARGIN)
          place = "top";
        else if (place === "top" && rect.top - GAP - ch < MARGIN && rect.bottom + GAP + ch < vh - MARGIN)
          place = "bottom";
        else if (place === "right" && rect.right + GAP + cw > vw - MARGIN && rect.left - GAP - cw > MARGIN)
          place = "left";
        else if (place === "left" && rect.left - GAP - cw < MARGIN && rect.right + GAP + cw < vw - MARGIN)
          place = "right";

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
  }, [rect, placement, anchorKey]);

  return createPortal(
    <div
      ref={cardRef}
      role="dialog"
      aria-modal="false"
      className="fixed z-[120] w-[340px] max-w-[88vw] rounded-lg border border-line-strong bg-raised p-4 shadow-[0_16px_48px_-8px_rgb(0_0_0/70%)]"
      style={{
        left: pos?.left ?? -9999,
        top: pos?.top ?? -9999,
        opacity: pos === null ? 0 : 1,
        transition: reduced
          ? undefined
          : "left 600ms cubic-bezier(0.4,0,0.2,1), top 600ms cubic-bezier(0.4,0,0.2,1)",
      }}
    >
      {/* Cross-fade the content as the card glides to the next beat. */}
      <div key={anchorKey} className={reduced ? undefined : "animate-feed-in"}>
        {children}
      </div>
    </div>,
    document.body,
  );
}
