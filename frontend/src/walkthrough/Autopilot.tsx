
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { usePrefersReducedMotion } from "./Spotlight";
import type { Beat } from "./tour";
import { planPhase, resolveClickTarget } from "./autopilot";

const GLIDE_MS = 680;
const EASE = "cubic-bezier(0.3, 0.7, 0.2, 1)";

interface AutopilotProps {
  enabled: boolean;
  beat: Beat | null;
  /** interactive beat still waiting for the agent-cell click */
  awaiting: boolean;
  onStop: () => void;
}

export function Autopilot({ enabled, beat, awaiting, onStop }: AutopilotProps) {
  const reduced = usePrefersReducedMotion();
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const [pressed, setPressed] = useState(false);
  const [ripple, setRipple] = useState(0);
  const stopRef = useRef(onStop);
  stopRef.current = onStop;

  useEffect(() => {
    if (!enabled) setPos(null);
  }, [enabled]);

  // any trusted user input hands control back; our own el.click() is untrusted
  useEffect(() => {
    if (!enabled) return;
    const onInput = (e: Event) => {
      if (!e.isTrusted) return;
      const t = e.target as HTMLElement | null;
      if (t?.closest?.("[data-autopilot-safe]")) return;
      stopRef.current();
    };
    window.addEventListener("pointerdown", onInput, true);
    window.addEventListener("keydown", onInput, true);
    window.addEventListener("wheel", onInput, true);
    return () => {
      window.removeEventListener("pointerdown", onInput, true);
      window.removeEventListener("keydown", onInput, true);
      window.removeEventListener("wheel", onInput, true);
    };
  }, [enabled]);

  useEffect(() => {
    if (!enabled || !beat) return;
    let cancelled = false;
    const sleep = (ms: number) =>
      new Promise<void>((resolve) => window.setTimeout(resolve, ms));

    const run = async () => {
      for (const step of planPhase(beat, awaiting)) {
        if (cancelled) return;
        if (step.kind === "dwell") {
          await sleep(step.ms);
          continue;
        }
        let el: HTMLElement | null = null;
        for (let i = 0; i < 10 && !cancelled; i++) {
          el = resolveClickTarget(step);
          if (el) break;
          await sleep(200);
        }
        if (cancelled) return;
        if (!el) {
          stopRef.current();
          return;
        }
        const r = el.getBoundingClientRect();
        setPos({ x: r.left + r.width / 2, y: r.top + r.height / 2 });
        await sleep(reduced ? 150 : GLIDE_MS + 160);
        if (cancelled) return;
        setPressed(true);
        setRipple((n) => n + 1);
        await sleep(160);
        setPressed(false);
        if (cancelled) return;
        el.click();
        await sleep(450);
      }
    };
    void run();
    return () => {
      cancelled = true;
    };
  }, [enabled, beat, awaiting, reduced]);

  if (!enabled || pos === null) return null;

  return createPortal(
    <div
      aria-hidden
      className="pointer-events-none fixed left-0 top-0 z-[150]"
      style={{
        transform: `translate3d(${pos.x}px, ${pos.y}px, 0)`,
        transition: reduced ? "none" : `transform ${GLIDE_MS}ms ${EASE}`,
      }}
    >
      {ripple > 0 && (
        <span
          key={ripple}
          className="absolute -left-4 -top-4 h-8 w-8 rounded-full border-2 border-accent"
          style={{ animation: "ap-ripple 600ms ease-out forwards" }}
        />
      )}
      <div
        style={{
          transform: pressed ? "scale(0.82)" : "scale(1)",
          transition: "transform 140ms ease",
          filter: "drop-shadow(0 2px 8px rgb(0 0 0 / 60%))",
        }}
      >
        <svg width="22" height="22" viewBox="0 0 24 24" style={{ display: "block" }}>
          <path
            d="M5 3l14 8.2-6.6 1.5L9.4 19 5 3z"
            fill="#fff"
            stroke="#1a1d24"
            strokeWidth="1.4"
            strokeLinejoin="round"
          />
        </svg>
      </div>
      <span className="absolute left-5 top-5 whitespace-nowrap rounded-sm border border-accent/60 bg-black/80 px-1.5 py-0.5 text-[9px] font-bold tracking-[0.22em] text-accent">
        AUTOPILOT
      </span>
    </div>,
    document.body,
  );
}
