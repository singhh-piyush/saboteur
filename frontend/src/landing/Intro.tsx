
import { useEffect, useRef, useState } from "react";

import { prefersReducedMotion } from "./parts";

let introPlayed = false;

export function introShouldSkip(): boolean {
  return introPlayed || prefersReducedMotion();
}

const FADE_MS = 1100; 
const LINES_HOLD_MS = 5000; 
const BLACK_MS = 600;
const WORDMARK_MS = 2200;

type Phase = "lines" | "black" | "wordmark";

const STATEMENT =
  "font-display text-2xl font-semibold tracking-tight text-ink sm:text-3xl md:text-4xl";

export function Intro({ onDone }: { onDone: () => void }) {
  const [phase, setPhase] = useState<Phase>("lines");
  const [leaving, setLeaving] = useState(false);
  const doneRef = useRef(false);

  const finish = () => {
    if (doneRef.current) return;
    doneRef.current = true;
    introPlayed = true;
    onDone();
  };

  const dismiss = () => setLeaving(true); 

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
          className={`${showWordmark ? "glitch-in " : ""}font-brand text-6xl font-extrabold leading-none tracking-[0.16em] text-ink sm:text-7xl md:text-8xl`}
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
