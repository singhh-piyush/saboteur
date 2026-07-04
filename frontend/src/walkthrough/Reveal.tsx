/**
 * Reveal - the branded title sequence between picking a model family and the
 * demo. Modeled on the landing Intro (phase timers, one-shot finish, global
 * click/key/touch skip, deterministic fade-out timer):
 *
 *   1. A short black beat.
 *   2. The SABOTEUR wordmark bursts in with the existing `.glitch-in`
 *      treatment and settles clean.
 *   3. A studio-style title card: the family's logo lockup settles in
 *      (`logo-in`), with "tested under SABOTEUR" beneath.
 *   4. The overlay fades out over the already-painted demo.
 *
 * Fast (~4s) and instantly skippable - a click/tap/key jumps straight to the
 * fade-out. The demo mounts UNDER this opaque overlay, so its keyed remount
 * and first paint are never visible; only the finished frame fades in.
 * Reduced motion never reaches this component (the view skips the reveal).
 */

import { useEffect, useRef, useState } from "react";

import type { DemoFamily } from "../demo";
import { FamilyLogo } from "./logos";

const EASE = "cubic-bezier(0.22, 1, 0.36, 1)";

const BLACK_MS = 350; // dramatic beat; longer starts to read as "it broke"
const WORDMARK_MS = 1600; // glitch burst (1.2s) + a short clean hold
const TITLE_MS = 1500; // logo settle + the "tested under" line
const FADE_MS = 500; // fade out over the painted demo

type Phase = "black" | "wordmark" | "title";

export function Reveal({ family, onDone }: { family: DemoFamily; onDone: () => void }) {
  const [phase, setPhase] = useState<Phase>("black");
  const [leaving, setLeaving] = useState(false);
  const doneRef = useRef(false);

  // One-shot completion - timers and a manual skip can never fire onDone twice.
  const finish = () => {
    if (doneRef.current) return;
    doneRef.current = true;
    onDone();
  };

  const dismiss = () => setLeaving(true); // skip or the natural fade-out

  // Phase timeline: black -> wordmark glitch -> title card -> fade out.
  useEffect(() => {
    const toWordmark = window.setTimeout(() => setPhase("wordmark"), BLACK_MS);
    const toTitle = window.setTimeout(() => setPhase("title"), BLACK_MS + WORDMARK_MS);
    const toLeave = window.setTimeout(dismiss, BLACK_MS + WORDMARK_MS + TITLE_MS);
    return () => {
      window.clearTimeout(toWordmark);
      window.clearTimeout(toTitle);
      window.clearTimeout(toLeave);
    };
  }, []);

  // Global skip listeners - any interaction cuts straight to the fade-out.
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

  // Complete after the fade-out transition (deterministic timer, not
  // transitionend - the cross-fading children emit those too).
  useEffect(() => {
    if (!leaving) return;
    const t = window.setTimeout(finish, FADE_MS + 60);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [leaving]);

  const showWordmark = phase === "wordmark" && !leaving;
  const showTitle = phase === "title" && !leaving;

  return (
    <div
      role="presentation"
      onClick={dismiss}
      className="fixed inset-0 z-[200] flex cursor-pointer items-center justify-center overflow-hidden bg-black px-6 text-center"
      style={{ opacity: leaving ? 0 : 1, transition: `opacity ${FADE_MS}ms ${EASE}` }}
    >
      {/* Phase 2 - the wordmark: glitches on entry, settles clean. */}
      <div
        className="absolute"
        style={{
          opacity: showWordmark ? 1 : 0,
          transform: showWordmark ? "scale(1)" : "scale(0.97)",
          transition: `opacity 500ms ${EASE}, transform 500ms ${EASE}`,
          pointerEvents: "none",
        }}
      >
        {/* glitch-in only once visible - the one-shot burst starts on class
            change, not on (hidden) mount. */}
        <span
          className={`${showWordmark ? "glitch-in " : ""}font-brand text-7xl font-extrabold leading-none tracking-[0.16em] text-ink sm:text-8xl md:text-9xl`}
          data-text="SABOTEUR"
        >
          SABOTEUR
        </span>
      </div>

      {/* Phase 3 - the family title card. */}
      <div
        className="absolute flex flex-col items-center gap-6"
        style={{
          opacity: showTitle ? 1 : 0,
          transition: `opacity 500ms ${EASE}`,
          pointerEvents: "none",
        }}
      >
        {/* Re-keyed by visibility so the one-shot entrance replays cleanly. */}
        {showTitle && (
          <>
            <div style={{ animation: `logo-in 900ms ${EASE} backwards` }}>
              <FamilyLogo family={family.id} markSize={72} />
            </div>
            <p
              className="text-sm font-semibold uppercase tracking-[0.24em] text-ink-dim"
              style={{ animation: `card-in 900ms ${EASE} 250ms backwards` }}
            >
              tested under{" "}
              <span className="font-brand text-base font-extrabold tracking-[0.24em] text-accent">
                SABOTEUR
              </span>
            </p>
          </>
        )}
      </div>

      <span
        className="absolute bottom-8 text-[11px] font-medium uppercase tracking-[0.2em] text-ink-faint"
        style={{ animation: "card-in 1.2s ease-out 1200ms backwards" }}
      >
        click anywhere to skip
      </span>
    </div>
  );
}
