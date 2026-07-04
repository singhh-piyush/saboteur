/**
 * Reveal - the branded title sequence between picking a model family and the
 * demo. One studio-style title page (not separate cuts): after a short black
 * beat the family's logo settles in, "TESTED UNDER" fades up beneath it, and
 * the SABOTEUR wordmark bursts in with the existing `.glitch-in` treatment
 * and settles clean. Then the whole overlay fades out over the
 * already-painted demo.
 *
 * Modeled on the landing Intro: phase timers, one-shot finish, global
 * click/key/touch skip, deterministic fade-out timer. Every element is
 * mounted up front (hidden) so nothing mounts mid-sequence - each piece is
 * revealed by a state flip, which also makes the one-shot glitch burst start
 * exactly on cue. Fast (~4s) and instantly skippable - any interaction jumps
 * straight to the fade-out. The demo mounts UNDER this opaque overlay, so its
 * keyed remount and first paint are never visible; only the finished frame
 * fades in. Reduced motion never reaches this component (the view skips the
 * reveal).
 */

import { useEffect, useRef, useState } from "react";

import type { DemoFamily } from "../demo";
import { FamilyLogo } from "./logos";

const EASE = "cubic-bezier(0.22, 1, 0.36, 1)";

const BLACK_MS = 450; // dramatic beat; longer starts to read as "it broke"
const WORDMARK_AT = 750; // into the card: logo has settled, SABOTEUR bursts in
const CARD_MS = 3200; // the full title page: settle, glitch, clean hold
const FADE_MS = 1050; // fade out over the painted demo - a longer, softer
// dissolve into the demo (also covers the tour's first-beat cold-start, which
// is armed when this fade begins)

export function Reveal({
  family,
  onDone,
  onLeaveStart,
}: {
  family: DemoFamily;
  onDone: () => void;
  /** Fired once when the fade-out begins, so the demo can arm the guided tour
   * UNDER the still-opaque overlay - the coachmark measures + fades in behind
   * the fading black, leaving no dead pause before step 1. */
  onLeaveStart?: () => void;
}) {
  const [showCard, setShowCard] = useState(false);
  const [showWordmark, setShowWordmark] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const doneRef = useRef(false);
  const leaveStartedRef = useRef(false);

  // One-shot completion - timers and a manual skip can never fire onDone twice.
  const finish = () => {
    if (doneRef.current) return;
    doneRef.current = true;
    onDone();
  };

  const dismiss = () => setLeaving(true); // skip or the natural fade-out

  // Timeline: black beat -> title page (logo settles, then the wordmark
  // glitches in on the same page) -> fade out.
  useEffect(() => {
    const toCard = window.setTimeout(() => setShowCard(true), BLACK_MS);
    const toWordmark = window.setTimeout(() => setShowWordmark(true), BLACK_MS + WORDMARK_AT);
    const toLeave = window.setTimeout(dismiss, BLACK_MS + CARD_MS);
    return () => {
      window.clearTimeout(toCard);
      window.clearTimeout(toWordmark);
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
  // transitionend - the fading children emit those too). Arm the tour at the
  // START of the fade so it comes up behind the still-opaque black.
  useEffect(() => {
    if (!leaving) return;
    if (!leaveStartedRef.current) {
      leaveStartedRef.current = true;
      onLeaveStart?.();
    }
    const t = window.setTimeout(finish, FADE_MS + 60);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [leaving]);

  const cardVisible = showCard && !leaving;

  return (
    <div
      role="presentation"
      onClick={dismiss}
      className="fixed inset-0 z-[200] flex cursor-pointer items-center justify-center overflow-hidden bg-black px-6 text-center"
      style={{ opacity: leaving ? 0 : 1, transition: `opacity ${FADE_MS}ms ${EASE}` }}
    >
      {/* The one title page: "[family logo] / TESTED UNDER / SABOTEUR". */}
      <div
        className="flex flex-col items-center gap-9"
        style={{ opacity: cardVisible ? 1 : 0, pointerEvents: "none" }}
      >
        <div
          style={{
            willChange: "transform, opacity",
            animation: cardVisible ? `logo-in 1100ms ${EASE} backwards` : "none",
          }}
        >
          <FamilyLogo family={family.id} markSize={76} />
        </div>

        <div className="flex flex-col items-center gap-4">
          <p
            className="text-xs font-semibold uppercase tracking-[0.3em] text-ink-dim"
            style={{
              willChange: "transform, opacity",
              animation: cardVisible ? `card-in 900ms ${EASE} 400ms backwards` : "none",
            }}
          >
            tested under
          </p>
          {/* Mounted from the start; the glitch-in burst fires on the class
              flip, exactly when the wordmark is revealed. */}
          <span
            className={`${showWordmark && !leaving ? "glitch-in " : ""}font-brand text-5xl font-extrabold leading-none tracking-[0.16em] -mr-[0.16em] text-ink sm:text-6xl md:text-7xl`}
            data-text="SABOTEUR"
            style={{
              opacity: showWordmark && !leaving ? 1 : 0,
              transition: `opacity 350ms ${EASE}`,
            }}
          >
            SABOTEUR
          </span>
        </div>
      </div>

      <span
        className="absolute bottom-8 text-[11px] font-medium uppercase tracking-[0.2em] text-ink-faint"
        style={{ animation: "card-in 1.2s ease-out 1400ms backwards" }}
      >
        click anywhere to skip
      </span>
    </div>
  );
}
