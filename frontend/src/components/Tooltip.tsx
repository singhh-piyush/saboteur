import React, { useCallback, useRef, useState } from "react";
import { createPortal } from "react-dom";

interface TooltipProps {
  /** Tooltip content — plain text or JSX */
  label: React.ReactNode;
  /** Which side of the trigger the tooltip appears on (default: "top") */
  side?: "top" | "bottom";
  /** Extra classes on the wrapper div */
  className?: string;
  /**
   * Render via a position:fixed portal instead of CSS-only absolute
   * positioning. Use inside overflow:auto/hidden ancestors (e.g. the
   * battle grid) where the default variant would clip.
   */
  portal?: boolean;
  children: React.ReactNode;
}

const CARD_CLS =
  "rounded-md border border-line-strong bg-raised px-2.5 py-1.5 text-xs leading-relaxed text-ink shadow-[0_8px_24px_-6px_rgb(0_0_0/80%)] whitespace-pre-line";

/**
 * Lightweight tooltip with two modes:
 * - default: CSS-only via Tailwind group-hover (no JS state)
 * - portal:  measured on mouseenter, rendered into document.body with
 *   position:fixed — immune to ancestor overflow clipping
 */
export function Tooltip({ label, side = "top", className = "", portal = false, children }: TooltipProps) {
  if (portal) {
    return (
      <PortalTooltip label={label} side={side} className={className}>
        {children}
      </PortalTooltip>
    );
  }

  const isTop = side === "top";

  return (
    <div className={`relative group ${className}`}>
      {children}

      {/* Tooltip card */}
      <div
        aria-hidden
        className={[
          "pointer-events-none absolute left-1/2 -translate-x-1/2 z-[200]",
          "w-max max-w-[230px]",
          /* fade + slide in */
          "opacity-0 translate-y-1",
          "group-hover:opacity-100 group-hover:translate-y-0",
          "transition-all duration-150 ease-out",
          isTop ? "bottom-full mb-2" : "top-full mt-2",
        ].join(" ")}
      >
        {/* Card */}
        <div className={`relative ${CARD_CLS}`}>{label}</div>

        {/* Caret */}
        <div
          className={[
            "absolute left-1/2 -translate-x-1/2 h-1.5 w-1.5 rotate-45 bg-raised border border-line-strong",
            isTop
              ? "-bottom-[3px] border-t-0 border-l-0"
              : "-top-[3px] border-b-0 border-r-0",
          ].join(" ")}
        />
      </div>
    </div>
  );
}

const GAP = 8; // px between trigger and card

function PortalTooltip({
  label,
  side,
  className,
  children,
}: Required<Pick<TooltipProps, "label" | "side" | "className">> & {
  children: React.ReactNode;
}) {
  const triggerRef = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState<{ x: number; y: number; top: boolean } | null>(null);

  const show = useCallback(() => {
    const el = triggerRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    // Flip if too close to the viewport edge for the requested side.
    let top = side === "top";
    if (top && rect.top < 90) top = false;
    if (!top && window.innerHeight - rect.bottom < 90) top = true;
    setPos({
      x: rect.left + rect.width / 2,
      y: top ? rect.top - GAP : rect.bottom + GAP,
      top,
    });
  }, [side]);

  const hide = useCallback(() => setPos(null), []);

  return (
    <div
      ref={triggerRef}
      className={className}
      onMouseEnter={show}
      onMouseLeave={hide}
      onMouseDown={hide}
    >
      {children}
      {pos !== null &&
        createPortal(
          <div
            aria-hidden
            className="tooltip-portal-in pointer-events-none fixed z-[200] w-max max-w-[230px]"
            style={{
              left: pos.x,
              top: pos.y,
              transform: `translate(-50%, ${pos.top ? "-100%" : "0"})`,
            }}
          >
            <div className={CARD_CLS}>{label}</div>
          </div>,
          document.body,
        )}
    </div>
  );
}
