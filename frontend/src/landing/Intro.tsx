
import { useEffect, useRef, useState } from "react";

import { DEMO_FAMILIES } from "../demo";
import { prefersReducedMotion } from "./parts";

const SEEN_KEY = "saboteur.intro.seen";

function introForced(): boolean {
  return (
    typeof window !== "undefined" && new URLSearchParams(window.location.search).has("intro")
  );
}

function introSeen(): boolean {
  try {
    return localStorage.getItem(SEEN_KEY) === "1";
  } catch {
    return false;
  }
}

function markSeen(): void {
  try {
    localStorage.setItem(SEEN_KEY, "1");
  } catch {
    /* storage denied - play every time */
  }
}

export function introShouldSkip(): boolean {
  if (introForced()) return false;
  return introSeen() || prefersReducedMotion();
}

const RUN_8B = DEMO_FAMILIES[0].runs[0];
const RUN_70B = DEMO_FAMILIES[0].runs[1];

type Scene = "thesis" | "wordmark" | "cohort" | "faults" | "verdict" | "resolve";

const SCENES: { id: Scene; ms: number }[] = [
  { id: "thesis", ms: 6600 },
  { id: "wordmark", ms: 3600 },
  { id: "cohort", ms: 5200 },
  { id: "faults", ms: 5600 },
  { id: "verdict", ms: 6200 },
  { id: "resolve", ms: 3400 },
];

const FADE_MS = 1100;
const EASE = "cubic-bezier(0.22, 1, 0.36, 1)";

const STATEMENT =
  "font-display text-2xl font-semibold tracking-tight text-ink sm:text-3xl md:text-4xl";
const OVERLINE =
  "text-[11px] font-semibold uppercase tracking-[0.3em] text-ink-faint";
const SCENE_COPY =
  "font-display text-xl font-semibold tracking-tight text-ink sm:text-2xl md:text-3xl";

export function Intro({ onDone }: { onDone: () => void }) {
  const [sceneIndex, setSceneIndex] = useState(0);
  const [leaving, setLeaving] = useState(false);
  const doneRef = useRef(false);
  const scene = SCENES[sceneIndex].id;

  const finish = () => {
    if (doneRef.current) return;
    doneRef.current = true;
    markSeen();
    onDone();
  };

  const dismiss = () => setLeaving(true);

  const advance = () => {
    if (leaving) return;
    if (sceneIndex >= SCENES.length - 1) dismiss();
    else setSceneIndex((i) => i + 1);
  };

  useEffect(() => {
    if (leaving) return;
    const t = window.setTimeout(advance, SCENES[sceneIndex].ms);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sceneIndex, leaving]);

  useEffect(() => {
    const skip = () => dismiss();
    window.addEventListener("keydown", skip);
    window.addEventListener("wheel", skip, { passive: true });
    return () => {
      window.removeEventListener("keydown", skip);
      window.removeEventListener("wheel", skip);
    };
  }, []);

  useEffect(() => {
    if (!leaving) return;
    const t = window.setTimeout(finish, FADE_MS + 60);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [leaving]);

  return (
    <div
      role="presentation"
      onClick={advance}
      className="fixed inset-0 z-[200] flex cursor-pointer items-center justify-center overflow-hidden bg-black px-6 text-center"
      style={{ opacity: leaving ? 0 : 1, transition: `opacity ${FADE_MS}ms ${EASE}` }}
    >
      {/* one scene mounted at a time: hard film cuts to black between scenes */}
      <div
        key={scene}
        className="absolute inset-0 flex items-center justify-center px-6"
        style={{ animation: "scene-in 600ms ease-out both", pointerEvents: "none" }}
      >
        {scene === "thesis" && <Thesis />}
        {scene === "wordmark" && <WordmarkScene />}
        {scene === "cohort" && <Cohort />}
        {scene === "faults" && <Faults />}
        {scene === "verdict" && <Verdict />}
        {scene === "resolve" && <Resolve />}
      </div>

      {/* studio lighting: drifting key light beam, vignette, film grain */}
      <div aria-hidden className="pointer-events-none absolute inset-0 overflow-hidden">
        <div
          className="absolute left-1/2 top-1/2 h-[240vmax] w-[44vmax]"
          style={{
            background:
              "linear-gradient(90deg, transparent, color-mix(in oklch, var(--color-accent) 8%, transparent) 50%, transparent)",
            mixBlendMode: "screen",
            animation: "intro-keylight 11s ease-in-out infinite alternate",
          }}
        />
      </div>
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            "radial-gradient(ellipse at 50% 44%, transparent 52%, rgba(0, 0, 0, 0.62) 100%)",
        }}
      />
      <div aria-hidden className="intro-grain pointer-events-none absolute -inset-1/2 opacity-[0.05]" />

      <div className="absolute bottom-8 flex flex-col items-center gap-3">
        <div className="flex items-center gap-1.5">
          {SCENES.map((s, i) => (
            <span
              key={s.id}
              className="h-1 w-4 rounded-full transition-colors duration-300"
              style={{
                background:
                  i <= sceneIndex
                    ? "var(--color-accent)"
                    : "oklch(100% 0 0 / 14%)",
              }}
            />
          ))}
        </div>
        <span className="text-[11px] font-medium uppercase tracking-[0.2em] text-ink-faint">
          click to continue
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              dismiss();
            }}
            className="ml-3 border-b border-ink-faint/50 pb-px transition-colors duration-150 hover:text-ink"
          >
            skip
          </button>
        </span>
      </div>
    </div>
  );
}

function Thesis() {
  return (
    <div style={{ perspective: "900px" }}>
      <div
        className="flex max-w-3xl flex-col items-center gap-8"
        style={{
          transformStyle: "preserve-3d",
          animation: "intro-drift 8s ease-in-out infinite alternate",
        }}
      >
        <p className={STATEMENT} style={{ animation: `intro-line 1500ms ${EASE} 400ms backwards` }}>
          You wouldn't ship a microservice without{" "}
          <span className="text-accent">load testing.</span>
        </p>
        <p className={STATEMENT} style={{ animation: `intro-line 1500ms ${EASE} 2600ms backwards` }}>
          Don't ship an agent without <span className="text-accent">chaos testing.</span>
        </p>
      </div>
    </div>
  );
}

const WORDMARK_LG =
  "font-brand text-6xl font-extrabold leading-none tracking-[0.16em] -mr-[0.16em] sm:text-7xl md:text-8xl";

function Reflection({ text, cls }: { text: string; cls: string }) {
  return (
    <span
      aria-hidden
      className={`absolute left-0 top-full ${cls} text-ink`}
      style={{
        transform: "scaleY(-1)",
        opacity: 0.13,
        filter: "blur(2px)",
        maskImage: "linear-gradient(to bottom, transparent 40%, black 96%)",
        WebkitMaskImage: "linear-gradient(to bottom, transparent 40%, black 96%)",
      }}
    >
      {text}
    </span>
  );
}

function WordmarkScene() {
  return (
    <div style={{ perspective: "1000px" }}>
      <div
        aria-hidden
        className="absolute left-1/2 top-1/2 h-64 w-[36rem] max-w-[90vw] -translate-x-1/2 -translate-y-1/2 rounded-full"
        style={{
          background:
            "radial-gradient(ellipse, color-mix(in oklch, var(--color-accent) 14%, transparent), transparent 70%)",
          animation: `scene-in 1800ms ${EASE} both`,
        }}
      />
      <div style={{ animation: `intro-dolly 3600ms ${EASE} both` }}>
        <div className="relative">
          <span className={`glitch-in ${WORDMARK_LG} text-ink`} data-text="SABOTEUR">
            SABOTEUR
          </span>
          <span aria-hidden className={`intro-shine absolute inset-0 ${WORDMARK_LG}`}>
            SABOTEUR
          </span>
          <Reflection text="SABOTEUR" cls={WORDMARK_LG} />
        </div>
      </div>
    </div>
  );
}

function Cohort() {
  const cells = Array.from({ length: 60 }, (_, i) => i);
  return (
    <div className="flex flex-col items-center gap-2">
      <p className={OVERLINE} style={{ animation: `intro-rise 900ms ${EASE} 300ms backwards` }}>
        the cohort
      </p>
      <p className={SCENE_COPY} style={{ animation: `intro-rise 900ms ${EASE} 500ms backwards` }}>
        {RUN_8B.scorecard.n_agents} agents. One task. Seeded chaos.
      </p>
      <div
        className="mt-6"
        style={{ perspective: "760px", animation: `intro-rise 1200ms ${EASE} 800ms backwards` }}
      >
        <div
          className="relative"
          style={{
            width: "min(78vw, 680px)",
            transformStyle: "preserve-3d",
            animation: `intro-floor 5200ms ${EASE} both`,
          }}
        >
          <div
            aria-hidden
            className="absolute -inset-10 rounded-full"
            style={{
              background:
                "radial-gradient(ellipse, color-mix(in oklch, var(--color-accent) 7%, transparent), transparent 70%)",
            }}
          />
          <div
            className="grid grid-cols-10 gap-2"
            style={{
              maskImage: "linear-gradient(to bottom, transparent 0%, black 48%)",
              WebkitMaskImage: "linear-gradient(to bottom, transparent 0%, black 48%)",
            }}
          >
            {cells.map((i) => (
              <div
                key={i}
                className="intro-cell h-8 rounded border sm:h-9"
                style={{ animationDelay: `${-((i * 173) % 2800)}ms` }}
              />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

const FAULT_CHIPS: { name: string; x: number; y: number; z: number; d: number }[] = [
  { name: "api_error", x: 24, y: 28, z: -160, d: 0 },
  { name: "context_drop", x: 50, y: 16, z: 10, d: 140 },
  { name: "rate_limit", x: 74, y: 26, z: -60, d: 280 },
  { name: "latency", x: 15, y: 55, z: 50, d: 420 },
  { name: "timeout", x: 83, y: 56, z: -120, d: 560 },
  { name: "malformed", x: 30, y: 78, z: 90, d: 700 },
  { name: "tool_vanish", x: 66, y: 80, z: -30, d: 840 },
  { name: "silent_lie", x: 50, y: 49, z: 150, d: 1200 },
];

function Faults() {
  return (
    <div className="absolute inset-0" style={{ perspective: "900px" }}>
      <div
        className="absolute inset-0"
        style={{
          transformStyle: "preserve-3d",
          animation: "intro-drift 9s ease-in-out infinite alternate",
        }}
      >
        {FAULT_CHIPS.map((c) => {
          // depth of field: chips deep in z sit soft and dim, near chips stay sharp
          const blur = c.z <= -100 ? 1.5 : c.z < 0 ? 0.6 : 0;
          const dim = c.z <= -100 ? 0.7 : c.z < 0 ? 0.88 : 1;
          return (
            <span
              key={c.name}
              className={`absolute rounded-sm border px-2.5 py-1 font-mono text-xs sm:text-sm ${
                c.name === "silent_lie"
                  ? "border-accent bg-accent/15 font-semibold text-accent"
                  : "border-line-strong bg-panel text-ink-dim"
              }`}
              style={{
                left: `${c.x}%`,
                top: `${c.y}%`,
                transform: `translate(-50%, -50%) translateZ(${c.z}px)`,
                opacity: dim,
                filter: blur ? `blur(${blur}px)` : undefined,
                ["--z" as string]: `${c.z}px`,
                ["--intro-o" as string]: `${dim}`,
                ["--intro-blur" as string]: `${blur}px`,
                animation: `intro-chip 1100ms ${EASE} ${c.d}ms backwards${
                  c.name === "silent_lie" ? `, intro-pulse 2000ms ease-in-out ${c.d + 1100}ms infinite` : ""
                }`,
              }}
            >
              {c.name}
            </span>
          );
        })}
      </div>
      <div className="absolute inset-x-0 bottom-[22%] flex flex-col items-center gap-2">
        <p className={OVERLINE} style={{ animation: `intro-rise 900ms ${EASE} 1600ms backwards` }}>
          the sabotage
        </p>
        <p className={SCENE_COPY} style={{ animation: `intro-rise 900ms ${EASE} 1800ms backwards` }}>
          8 faults. 3 layers. Injected on the wire.
        </p>
      </div>
    </div>
  );
}

function useCountUp(to: number | null, delayMs: number): string {
  const [v, setV] = useState(0);
  useEffect(() => {
    if (to === null) return;
    let raf = 0;
    let start: number | null = null;
    const dur = 1200;
    const tick = (t: number) => {
      if (start === null) start = t;
      const p = Math.min((t - start - delayMs) / dur, 1);
      if (p < 1) raf = requestAnimationFrame(tick);
      if (p >= 0) setV(to * (1 - Math.pow(1 - Math.max(p, 0), 3)));
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [to, delayMs]);
  return to === null ? "-" : `${Math.round(v * 100)}%`;
}

function MetricRow({
  label,
  a,
  b,
  delay,
}: {
  label: string;
  a: number | null;
  b: number | null;
  delay: number;
}) {
  const av = useCountUp(a, delay + 500);
  const bv = useCountUp(b, delay + 900);
  return (
    <div
      className="flex items-baseline justify-between gap-6 sm:gap-10"
      style={{ animation: `intro-rise 900ms ${EASE} ${delay}ms backwards` }}
    >
      <span className={OVERLINE}>{label}</span>
      <span className="flex items-baseline gap-3 font-display font-bold tabular-nums sm:gap-4">
        <span className="flex flex-col items-end">
          <span className="text-3xl text-ink-dim sm:text-5xl">{av}</span>
          <span className="text-[10px] font-semibold tracking-[0.2em] text-ink-faint">
            {RUN_8B.short}
          </span>
        </span>
        <span className="text-sm font-medium text-ink-faint">vs</span>
        <span className="flex flex-col items-end">
          <span
            className="text-3xl text-accent sm:text-5xl"
            style={{ textShadow: "0 0 28px color-mix(in oklch, var(--color-accent) 50%, transparent)" }}
          >
            {bv}
          </span>
          <span className="text-[10px] font-semibold tracking-[0.2em] text-ink-faint">
            {RUN_70B.short}
          </span>
        </span>
      </span>
    </div>
  );
}

function Verdict() {
  const s8 = RUN_8B.scorecard;
  const s70 = RUN_70B.scorecard;
  return (
    <div className="relative flex w-full max-w-xl flex-col gap-7">
      <div
        aria-hidden
        className="absolute left-1/2 top-1/2 h-[24rem] w-[54rem] max-w-[95vw] -translate-x-1/2 -translate-y-1/2 rounded-full"
        style={{
          background:
            "radial-gradient(ellipse, color-mix(in oklch, var(--color-accent) 6%, transparent), transparent 70%)",
          animation: `scene-in 1800ms ${EASE} both`,
        }}
      />
      <p className={OVERLINE} style={{ animation: `intro-rise 900ms ${EASE} 200ms backwards` }}>
        same chaos, two models
      </p>
      <MetricRow label="survival" a={s8.survival_rate} b={s70.survival_rate} delay={400} />
      <MetricRow
        label="deception caught"
        a={s8.deception_detection_rate}
        b={s70.deception_detection_rate}
        delay={800}
      />
      <p
        className="text-base font-medium text-ink-dim sm:text-lg"
        style={{ animation: `intro-rise 900ms ${EASE} 2400ms backwards` }}
      >
        Resilience is a model property. <span className="text-ink">Measure it.</span>
      </p>
    </div>
  );
}

const WORDMARK_MD =
  "font-brand text-5xl font-extrabold leading-none tracking-[0.16em] -mr-[0.16em] sm:text-6xl md:text-7xl";

function Resolve() {
  return (
    <div className="flex flex-col items-center gap-5">
      <div
        aria-hidden
        className="absolute left-1/2 top-1/2 h-56 w-[32rem] max-w-[90vw] -translate-x-1/2 -translate-y-1/2 rounded-full"
        style={{
          background:
            "radial-gradient(ellipse, color-mix(in oklch, var(--color-accent) 12%, transparent), transparent 70%)",
          animation: `scene-in 1600ms ${EASE} both`,
        }}
      />
      <div className="relative">
        <span className={`glitch-in ${WORDMARK_MD} text-ink`} data-text="SABOTEUR">
          SABOTEUR
        </span>
        <span
          aria-hidden
          className={`intro-shine absolute inset-0 ${WORDMARK_MD}`}
          style={{ animationDelay: "900ms" }}
        >
          SABOTEUR
        </span>
      </div>
      <p className={OVERLINE} style={{ animation: `intro-rise 900ms ${EASE} 700ms backwards` }}>
        chaos engineering for AI agents
      </p>
    </div>
  );
}
