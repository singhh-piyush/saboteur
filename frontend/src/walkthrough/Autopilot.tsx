
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { usePrefersReducedMotion } from "./Spotlight";
import type { Beat } from "./tour";
import { planPhase, resolveClickTarget, type AutopilotStep } from "./autopilot";

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
  const posRef = useRef<{ x: number; y: number } | null>(null);
  const firstRef = useRef(false);

  const moveTo = (x: number, y: number) => {
    posRef.current = { x, y };
    setPos({ x, y });
  };

  useEffect(() => {
    if (!enabled) {
      setPos(null);
      posRef.current = null;
    } else {
      firstRef.current = true;
    }
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

    const resolveWithRetry = async (step: AutopilotStep) => {
      for (let i = 0; i < 10 && !cancelled; i++) {
        const el = resolveClickTarget(step);
        if (el) return el;
        await sleep(200);
      }
      return null;
    };

    const glideTo = async (el: HTMLElement) => {
      const r = el.getBoundingClientRect();
      const to = { x: r.left + r.width / 2, y: r.top + r.height / 2 };
      const from = posRef.current;
      const moved = !from || Math.hypot(to.x - from.x, to.y - from.y) > 4;
      moveTo(to.x, to.y);
      if (moved) await sleep(reduced ? 150 : GLIDE_MS + 120);
      return moved;
    };

    const steps = planPhase(beat, awaiting);

    const run = async () => {
      // engage beat: the viewer already read this coachmark before opting in
      const capFirstDwell = firstRef.current;
      firstRef.current = false;
      // cursor is visible from the first frame, never a dead screen
      if (posRef.current === null)
        moveTo(window.innerWidth / 2, window.innerHeight - 110);

      for (let i = 0; i < steps.length; i++) {
        if (cancelled) return;
        const step = steps[i];
        if (step.kind === "dwell") {
          let ms = capFirstDwell && i === 0 ? Math.min(step.ms, 2600) : step.ms;
          // park the cursor on the upcoming button while the viewer reads
          const nxt = steps[i + 1];
          if (nxt?.kind === "click") {
            const el = await resolveWithRetry(nxt);
            if (cancelled) return;
            if (el && (await glideTo(el))) ms = Math.max(ms - GLIDE_MS, 600);
          }
          if (cancelled) return;
          await sleep(ms);
          continue;
        }
        const el = await resolveWithRetry(step);
        if (cancelled) return;
        if (!el) {
          stopRef.current();
          return;
        }
        // re-measure at click time: corrects for camera/layout motion during the dwell
        await glideTo(el);
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
        animation: "ap-in 240ms ease-out both",
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
