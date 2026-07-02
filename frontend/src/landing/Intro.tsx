/**
 * Intro - a cinematic cold open that states the thesis, then brands it, before the
 * landing resolves:
 *   1. Two statements fade/stagger in (brand type, accent-lit key phrases):
 *      "You wouldn't ship a microservice without load testing."
 *      "Don't ship an agent without chaos testing."
 *   2. They cross-fade into a large "SABOTEUR" wordmark that glitches hard on
 *      entry, then settles clean (chaos resolving into something solid).
 *   3. The whole overlay fades out to reveal the landing (already painted beneath).
 *
 * Guardrails: instantly skippable (click / scroll / any key), and skipped entirely
 * under prefers-reduced-motion.
 */

import { useEffect, useRef, useState } from "react";

import { prefersReducedMotion } from "./parts";

// In-memory, once-per-page-load. A full reload replays the intro (handy for live
// demoing); in-app navigation (console -> back to landing) does not, since the module
// stays resident. Swap to sessionStorage for once-per-tab-session behaviour.
let introPlayed = false;

/** Skip the intro entirely when it has already played this load, or motion is reduced. */
export function introShouldSkip(): boolean {
  return introPlayed || prefersReducedMotion();
}

const FADE_MS = 1100; // slow, smooth fade-out to the landing
const LINES_HOLD_MS = 5000; // statements on screen before they fade
// A dramatic pause reads as intentional around half a second; much longer and
// a black screen starts to read as "it broke".
const BLACK_MS = 600;
// Entry glitch (1.2s) + a clean hold, then the fade. Long enough to register,
// short enough that the logo never feels parked.
const WORDMARK_MS = 2200;

type Phase = "lines" | "black" | "wordmark";

// Matches the hero tagline ("Chaos engineering for AI agents.") so the intro reads
// as the same voice as the landing, just larger.
const STATEMENT =
  "font-display text-2xl font-semibold tracking-tight text-ink sm:text-3xl md:text-4xl";

export function Intro({ onDone }: { onDone: () => void }) {
  const [phase, setPhase] = useState<Phase>("lines");
  const [leaving, setLeaving] = useState(false);
  const doneRef = useRef(false);

  // One-shot completion - guarded so the timers and a manual skip can never fire
  // onDone more than once.
  const finish = () => {
    if (doneRef.current) return;
    doneRef.current = true;
    introPlayed = true;
    onDone();
  };

  const dismiss = () => setLeaving(true); // skip or final fade-out

  // Phase timeline: lines -> (fade to) black -> wordmark glitch -> fade out.
  useEffect(() => {
    const toBlack = window.setTimeout(() => setPhase("black"), LINES_HOLD_MS);
    const toWordmark = window.setTimeout(() => setPhase("wordmark"), LINES_HOLD_MS + BLACK_MS);
    const toLeave = window.setTimeout(dismiss, LINES_HOLD_MS + BLACK_MS + WORDMARK_MS);
    return () => {
      window.clearTimeout(toBlack);
      window.clearTimeout(toWordmark);
      window.clearTimeout(toLeave);
    };
  }, []);

  // Global skip listeners.
  useEffect(() => {
    const skip = () => dismiss();
    window.addEventListener("keydown", skip);
    window.addEventListener("wheel", skip, { passive: true });
    window.addEventListener("touchstart", skip, { passive: true });
    return () => {
      window.removeEventListener("keydown", skip);
      window.removeEventListener("wheel", skip);
      window.removeEventListener("touchstart", skip);
    };
  }, []);

  // Once the fade-out is underway, complete it after the transition. A deterministic
  // timer (not bubbled transitionend, which the cross-fading children also emit).
  useEffect(() => {
    if (!leaving) return;
    const t = window.setTimeout(finish, FADE_MS + 60);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [leaving]);

  const showLines = phase === "lines" && !leaving;
  const showWordmark = phase === "wordmark" && !leaving;

  return (
    <div
      role="presentation"
      onClick={dismiss}
      className="fixed inset-0 z-[200] flex cursor-pointer items-center justify-center overflow-hidden bg-black px-6 text-center"
      style={{
        opacity: leaving ? 0 : 1,
        transition: `opacity ${FADE_MS}ms cubic-bezier(0.4, 0, 0.2, 1)`,
      }}
    >
      {/* Phase 1 - the thesis. */}
      <div
        className="absolute flex max-w-3xl flex-col items-center gap-8"
        style={{
          opacity: showLines ? 1 : 0,
          transition: "opacity 800ms cubic-bezier(0.4, 0, 0.2, 1)",
          pointerEvents: "none",
        }}
      >
        <p
          className={STATEMENT}
          style={{ animation: "card-in 1.6s cubic-bezier(0.22, 1, 0.36, 1) 500ms backwards" }}
        >
          You wouldn't ship a microservice without{" "}
          <span className="text-accent">load testing.</span>
        </p>
        <p
          className={STATEMENT}
          style={{ animation: "card-in 1.6s cubic-bezier(0.22, 1, 0.36, 1) 2400ms backwards" }}
        >
          Don't ship an agent without <span className="text-accent">chaos testing.</span>
        </p>
      </div>

      {/* Phase 2 - the wordmark: glitches on entry, settles clean, fades. */}
      <div
        className="absolute"
        style={{
          opacity: showWordmark ? 1 : 0,
          transform: showWordmark ? "scale(1)" : "scale(0.97)",
          transition: "opacity 700ms cubic-bezier(0.4, 0, 0.2, 1), transform 700ms cubic-bezier(0.22, 1, 0.36, 1)",
          pointerEvents: "none",
        }}
      >
        {/* glitch-in is applied only once this phase is visible - the one-shot
            entry animation starts on class change, not on (hidden) mount. */}
        <span
          className={`${showWordmark ? "glitch-in " : ""}font-brand text-7xl font-extrabold leading-none tracking-[0.16em] text-ink sm:text-8xl md:text-9xl`}
          data-text="SABOTEUR"
        >
          SABOTEUR
        </span>
      </div>

      <span
        className="absolute bottom-8 text-[11px] font-medium uppercase tracking-[0.2em] text-ink-faint"
        style={{ animation: "card-in 1.2s ease-out 1600ms backwards" }}
      >
        click anywhere to skip
      </span>
    </div>
  );
}
