
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { usePrefersReducedMotion } from "./Spotlight";
import type { Beat } from "./tour";
import { planPhase, resolveClickTarget, type AutopilotStep } from "./autopilot";

const GLIDE_MS = 680;
const EASE = "cubic-bezier(0.3, 0.7, 0.2, 1)";

export type AutopilotStopReason = "interrupt" | "done";

/** the autopilot cursor arrow, reused on the buttons that summon it */
export function CursorGlyph({ className }: { className?: string }) {
  return (
    <svg width="11" height="11" viewBox="0 0 24 24" aria-hidden className={className}>
      <path d="M5 3l14 8.2-6.6 1.5L9.4 19 5 3z" fill="currentColor" strokeLinejoin="round" />
    </svg>
  );
}

interface AutopilotProps {
  enabled: boolean;
  beat: Beat | null;
  /** interactive beat still waiting for the agent-cell click */
  awaiting: boolean;
  /** closing beat: dwell only, then hand control back without clicking */
  isLast: boolean;
  /** where the cursor spawns (the button the viewer just clicked) */
  origin: { x: number; y: number } | null;
  onStop: (reason: AutopilotStopReason) => void;
}

export function Autopilot({ enabled, beat, awaiting, isLast, origin, onStop }: AutopilotProps) {
  const reduced = usePrefersReducedMotion();
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const [pressed, setPressed] = useState(false);
  const [ripple, setRipple] = useState(0);
  // active reading pause: drives a shimmer across the chip so long dwells
  // read as "autopilot is waiting", never as a frozen screen
  const [dwelling, setDwelling] = useState(false);
  // glide transition stays off until the spawn position has painted, so the
  // cursor fades in exactly where the viewer clicked instead of sliding there
  const [settled, setSettled] = useState(false);
  const stopRef = useRef(onStop);
  stopRef.current = onStop;
  const posRef = useRef<{ x: number; y: number } | null>(null);
  const firstRef = useRef(false);
  const originRef = useRef(origin);
  originRef.current = origin;

  const moveTo = (x: number, y: number) => {
    posRef.current = { x, y };
    setPos({ x, y });
  };

  useEffect(() => {
    if (!enabled) {
      setPos(null);
      posRef.current = null;
      setSettled(false);
      return;
    }
    firstRef.current = true;
    const o = originRef.current;
    moveTo(o?.x ?? window.innerWidth / 2, o?.y ?? window.innerHeight - 110);
    let raf2 = 0;
    const raf = requestAnimationFrame(() => {
      raf2 = requestAnimationFrame(() => setSettled(true));
    });
    return () => {
      cancelAnimationFrame(raf);
      cancelAnimationFrame(raf2);
    };
  }, [enabled]);

  // any trusted user input hands control back; our own el.click() is untrusted
  useEffect(() => {
    if (!enabled) return;
    const onInput = (e: Event) => {
      if (!e.isTrusted) return;
      const t = e.target as HTMLElement | null;
      if (t?.closest?.("[data-autopilot-safe]")) return;
      stopRef.current("interrupt");
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

    const steps = planPhase(beat, awaiting, isLast);

    const scrollTraceToEnd = async () => {
      // the drawer opens with a width transition; let it settle first
      await sleep(reduced ? 100 : 650);
      let list: HTMLElement | null = null;
      for (let i = 0; i < 10 && !cancelled; i++) {
        list = document.querySelector<HTMLElement>('[data-tour="trace-list"]');
        if (list) break;
        await sleep(150);
      }
      if (!list || cancelled) return;
      const target = list;
      const dist = target.scrollHeight - target.clientHeight - target.scrollTop;
      if (dist <= 4) return;
      if (reduced) {
        target.scrollTop = target.scrollHeight;
        return;
      }
      const start = target.scrollTop;
      const dur = Math.min(3600, Math.max(1400, dist * 2.4));
      const t0 = performance.now();
      await new Promise<void>((resolve) => {
        const tick = (now: number) => {
          if (cancelled) return resolve();
          const t = Math.min(1, (now - t0) / dur);
          const e = t < 0.5 ? 2 * t * t : 1 - (2 - 2 * t) ** 2 / 2;
          target.scrollTop = start + dist * e;
          if (t < 1) requestAnimationFrame(tick);
          else resolve();
        };
        requestAnimationFrame(tick);
      });
    };

    const run = async () => {
      setDwelling(false);
      // engage beat: the viewer already read this coachmark before opting in
      const capFirstDwell = firstRef.current;
      firstRef.current = false;
      // fresh spawn: let the fade-in land before the first glide
      if (capFirstDwell) await sleep(reduced ? 50 : 320);

      // the trace just opened on this interactive beat: walk it to the end
      // so the viewer sees the whole story before the dwell starts
      if (beat.interactive && !awaiting) await scrollTraceToEnd();
      if (cancelled) return;

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
          setDwelling(true);
          await sleep(ms);
          setDwelling(false);
          continue;
        }
        const el = await resolveWithRetry(step);
        if (cancelled) return;
        if (!el) {
          stopRef.current("interrupt");
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
      // closing beat plan has no click: hand the choice back to the viewer
      if (isLast && !awaiting && !cancelled) {
        await sleep(300);
        if (!cancelled) stopRef.current("done");
      }
    };
    void run();
    return () => {
      cancelled = true;
    };
  }, [enabled, beat, awaiting, isLast, reduced]);

  if (!enabled || pos === null) return null;

  return createPortal(
    <div
      aria-hidden
      className="pointer-events-none fixed left-0 top-0 z-[150]"
      style={{
        transform: `translate3d(${pos.x}px, ${pos.y}px, 0)`,
        transition: reduced || !settled ? "none" : `transform ${GLIDE_MS}ms ${EASE}`,
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
      <span
        className="absolute left-5 top-5 whitespace-nowrap rounded-sm border border-accent/60 bg-black/80 px-1.5 py-0.5 text-[9px] font-bold tracking-[0.22em] text-accent"
        style={{
          boxShadow: dwelling
            ? "0 0 14px color-mix(in oklch, var(--color-accent) 40%, transparent)"
            : "0 0 0 transparent",
          transition: "box-shadow 500ms ease",
        }}
      >
        AUTOPILOT
        <span aria-hidden className="ap-orbit" style={{ opacity: dwelling ? 1 : 0 }} />
      </span>
    </div>,
    document.body,
  );
}
