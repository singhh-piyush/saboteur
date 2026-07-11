
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

type Scene = "thesis" | "cohort" | "sabotage" | "verdict" | "resolve";

const SCENES: { id: Scene; ms: number }[] = [
  { id: "thesis", ms: 6200 },
  { id: "cohort", ms: 5800 },
  { id: "sabotage", ms: 5600 },
  { id: "verdict", ms: 6600 },
  { id: "resolve", ms: 3800 },
];

const FADE_MS = 1400;
const XFADE_MS = 500;
const EASE = "cubic-bezier(0.22, 1, 0.36, 1)";

const STATEMENT =
  "font-display text-2xl font-semibold tracking-tight text-ink sm:text-3xl md:text-4xl";
const OVERLINE = "text-[11px] font-semibold uppercase tracking-[0.3em] text-ink-faint";
const SCENE_COPY =
  "font-display text-xl font-semibold tracking-tight text-ink sm:text-2xl md:text-3xl";

export function Intro({ onDone }: { onDone: () => void }) {
  const [sceneIndex, setSceneIndex] = useState(0);
  const [outgoing, setOutgoing] = useState<Scene | null>(null);
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
    if (sceneIndex >= SCENES.length - 1) {
      dismiss();
      return;
    }
    setOutgoing(SCENES[sceneIndex].id);
    setSceneIndex((i) => i + 1);
  };

  useEffect(() => {
    if (leaving) return;
    const t = window.setTimeout(advance, SCENES[sceneIndex].ms);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sceneIndex, leaving]);

  useEffect(() => {
    if (outgoing === null) return;
    const t = window.setTimeout(() => setOutgoing(null), XFADE_MS + 40);
    return () => window.clearTimeout(t);
  }, [outgoing]);

  // only an explicit escape dismisses; stray keys and scrolling never kill the film
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") dismiss();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    if (!leaving) return;
    const t = window.setTimeout(finish, FADE_MS + 60);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [leaving]);

  const renderScene = (s: Scene) => (
    <>
      {s === "thesis" && <Thesis />}
      {s === "cohort" && <Cohort />}
      {s === "sabotage" && <Sabotage />}
      {s === "verdict" && <Verdict />}
      {s === "resolve" && <Resolve leaving={leaving} />}
    </>
  );

  return (
    <div
      role="presentation"
      onClick={advance}
      className="fixed inset-0 z-[200] flex cursor-pointer items-center justify-center overflow-hidden bg-black px-6 text-center"
      style={{ opacity: leaving ? 0 : 1, transition: `opacity ${FADE_MS}ms ${EASE}` }}
    >
      <div
        key={scene}
        className="absolute inset-0 flex items-center justify-center px-6"
        style={{ animation: "scene-in 700ms ease-out both", pointerEvents: "none" }}
      >
        {renderScene(scene)}
      </div>
      {/* outgoing scene overlaps the incoming one: linked crossfade, no cut to black */}
      {outgoing !== null && outgoing !== scene && (
        <div
          key={`out-${outgoing}`}
          aria-hidden
          className="intro-out absolute inset-0 flex items-center justify-center px-6"
          style={{ pointerEvents: "none" }}
        >
          {renderScene(outgoing)}
        </div>
      )}

      {/* studio lighting: drifting key light shaft, vignette, film grain */}
      <div aria-hidden className="pointer-events-none absolute inset-0 overflow-hidden">
        <div
          className="absolute left-1/2 top-1/2 h-[240vmax] w-[30vmax]"
          style={{
            background:
              "linear-gradient(90deg, transparent, color-mix(in oklch, var(--color-accent) 13%, transparent) 50%, transparent)",
            mixBlendMode: "screen",
            animation: "intro-keylight 13s ease-in-out infinite alternate",
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
                background: i <= sceneIndex ? "var(--color-accent)" : "oklch(100% 0 0 / 14%)",
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

const COLS = 8;

function MiniCard({ id, delay, barW, win }: { id: number; delay: number; barW: number; win: boolean }) {
  return (
    <div
      className={`intro-agent rounded border px-2 pb-2 pt-1.5 text-left ${win ? "intro-agent-win" : ""}`}
      style={{ animationDelay: `${delay}ms` }}
    >
      <div className="flex items-center justify-between">
        <span className="font-mono text-[10px] font-semibold tracking-wide text-ink-dim">
          A-{String(id).padStart(2, "0")}
        </span>
        <span aria-hidden className="h-2 w-2 rounded-full" style={{ background: "currentColor" }} />
      </div>
      <div className="mt-2 h-1 w-full rounded bg-white/10">
        <div className="h-full rounded" style={{ width: `${barW}%`, background: "currentColor" }} />
      </div>
    </div>
  );
}

function Cohort() {
  const cards = Array.from({ length: 24 }, (_, i) => i);
  return (
    <div className="flex w-full flex-col items-center gap-2">
      <p className={OVERLINE} style={{ animation: `intro-rise 900ms ${EASE} 200ms backwards` }}>
        the cohort
      </p>
      <p className={SCENE_COPY} style={{ animation: `intro-rise 900ms ${EASE} 400ms backwards` }}>
        {RUN_8B.scorecard.n_agents} agents. One task. Seeded chaos.
      </p>
      <div
        className="mt-8"
        style={{ perspective: "820px", animation: `intro-rise 1100ms ${EASE} 700ms backwards` }}
      >
        <div
          className="relative"
          style={{
            width: "min(88vw, 840px)",
            transformStyle: "preserve-3d",
            // static end state keeps the plane tilted in the crossfade snapshot
            transform: "rotateX(38deg) scale(1)",
            animation: `intro-floor 5600ms ${EASE} both`,
          }}
        >
          <div
            aria-hidden
            className="absolute -inset-12 rounded-full"
            style={{
              background:
                "radial-gradient(ellipse, color-mix(in oklch, var(--color-accent) 8%, transparent), transparent 70%)",
            }}
          />
          <div
            className="grid grid-cols-8 gap-2"
            style={{
              maskImage: "linear-gradient(to bottom, transparent 0%, black 32%)",
              WebkitMaskImage: "linear-gradient(to bottom, transparent 0%, black 32%)",
            }}
          >
            {cards.map((i) => {
              const row = Math.floor(i / COLS);
              const col = i % COLS;
              return (
                <MiniCard
                  key={i}
                  id={i}
                  delay={(col + row * 1.4) * 210 - 3600}
                  barW={18 + ((i * 37) % 68)}
                  win={i % 3 === 0}
                />
              );
            })}
          </div>
          {/* light sweep travels with the chaos wave */}
          <div
            aria-hidden
            className="pointer-events-none absolute inset-0"
            style={{
              background:
                "linear-gradient(100deg, transparent 34%, color-mix(in oklch, var(--color-accent) 11%, transparent) 50%, transparent 66%)",
              backgroundSize: "300% 100%",
              mixBlendMode: "screen",
              animation: "intro-floor-sweep 3600ms linear infinite",
            }}
          />
        </div>
      </div>
    </div>
  );
}

/** angle/radius ring around the agent node; deep start point = same bearing, far out */
const FAULTS: { name: string; angle: number; r: number; d: number }[] = [
  { name: "api_error", angle: 205, r: 148, d: 500 },
  { name: "rate_limit", angle: 338, r: 152, d: 720 },
  { name: "latency", angle: 162, r: 132, d: 940 },
  { name: "timeout", angle: 22, r: 138, d: 1160 },
  { name: "malformed", angle: 118, r: 126, d: 1380 },
  { name: "tool_vanish", angle: 62, r: 130, d: 1600 },
  { name: "context_drop", angle: 272, r: 120, d: 1820 },
  { name: "silent_lie", angle: 90, r: 96, d: 2400 },
];

function Sabotage() {
  return (
    <div className="absolute inset-0">
      <div
        className="absolute left-1/2 top-[42%]"
        style={{ transform: "translate(-50%, -50%)", animation: `intro-rise 700ms ${EASE} 200ms backwards` }}
      >
        <div className="relative rounded border border-line-strong bg-panel px-5 py-3">
          <span className="font-mono text-sm font-semibold text-ink">your agent</span>
          <span
            aria-hidden
            className="absolute -inset-2 rounded border border-accent/40"
            style={{ animation: "intro-ring 2200ms ease-out infinite" }}
          />
        </div>
      </div>
      {FAULTS.map((c) => {
        const rad = (c.angle * Math.PI) / 180;
        const tx = Math.cos(rad) * c.r * 1.9;
        const ty = -Math.sin(rad) * c.r;
        const lie = c.name === "silent_lie";
        return (
          <span
            key={c.name}
            className={`absolute left-1/2 top-[42%] rounded-sm border px-2.5 py-1 font-mono text-xs sm:text-sm ${
              lie
                ? "border-accent bg-accent/15 font-semibold text-accent"
                : "border-line-strong bg-panel text-ink-dim"
            }`}
            style={{
              ["--tx" as string]: `${tx}px`,
              ["--ty" as string]: `${ty}px`,
              ["--fx" as string]: `${tx * 4.4}px`,
              ["--fy" as string]: `${ty * 4.4}px`,
              transform: `translate(calc(-50% + ${tx}px), calc(-50% + ${ty}px))`,
              animation: `intro-converge 950ms ${EASE} ${c.d}ms backwards, intro-land 550ms ease-out ${c.d + 950}ms backwards${
                lie ? `, intro-pulse 2000ms ease-in-out ${c.d + 1500}ms infinite` : ""
              }`,
            }}
          >
            {c.name}
          </span>
        );
      })}
      <div className="absolute inset-x-0 bottom-[21%] flex flex-col items-center gap-2">
        <p className={OVERLINE} style={{ animation: `intro-rise 900ms ${EASE} 2900ms backwards` }}>
          the sabotage
        </p>
        <p className={SCENE_COPY} style={{ animation: `intro-rise 900ms ${EASE} 3100ms backwards` }}>
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

function BarRow({
  name,
  value,
  display,
  accent,
  delay,
}: {
  name: string;
  value: number | null;
  display: string;
  accent: boolean;
  delay: number;
}) {
  return (
    <div className="flex items-center gap-3">
      <span className="w-14 shrink-0 text-right font-mono text-[11px] text-ink-faint">{name}</span>
      <div className="h-2 flex-1 overflow-hidden rounded-sm bg-white/10">
        <div
          className={`intro-bar h-full rounded-sm ${accent ? "bg-accent" : "bg-ink-dim/60"}`}
          style={{
            width: `${(value ?? 0) * 100}%`,
            animationDelay: `${delay}ms`,
            boxShadow: accent
              ? "0 0 14px color-mix(in oklch, var(--color-accent) 55%, transparent)"
              : undefined,
          }}
        />
      </div>
      <span
        className={`w-16 text-left font-display text-2xl font-bold tabular-nums sm:text-3xl ${
          accent ? "text-accent" : "text-ink-dim"
        }`}
        style={
          accent
            ? { textShadow: "0 0 24px color-mix(in oklch, var(--color-accent) 45%, transparent)" }
            : undefined
        }
      >
        {display}
      </span>
    </div>
  );
}

function MetricBars({
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
  const av = useCountUp(a, delay + 300);
  const bv = useCountUp(b, delay + 500);
  return (
    <div
      className="flex flex-col gap-2.5"
      style={{ animation: `intro-rise 900ms ${EASE} ${delay}ms backwards` }}
    >
      <span className={`${OVERLINE} text-left`}>{label}</span>
      <BarRow name={RUN_8B.short} value={a} display={av} accent={false} delay={delay + 300} />
      <BarRow name={RUN_70B.short} value={b} display={bv} accent delay={delay + 500} />
    </div>
  );
}

function Verdict() {
  const s8 = RUN_8B.scorecard;
  const s70 = RUN_70B.scorecard;
  return (
    <div className="relative flex w-full max-w-xl flex-col gap-8">
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
      <MetricBars label="survival" a={s8.survival_rate} b={s70.survival_rate} delay={500} />
      <MetricBars
        label="deception caught"
        a={s8.deception_detection_rate}
        b={s70.deception_detection_rate}
        delay={1500}
      />
      <p
        className="text-base font-medium text-ink-dim sm:text-lg"
        style={{ animation: `intro-rise 900ms ${EASE} 3600ms backwards` }}
      >
        Resilience is a model property. <span className="text-ink">Measure it.</span>
      </p>
    </div>
  );
}

const WORDMARK =
  "font-brand text-6xl font-extrabold leading-none tracking-[0.16em] -mr-[0.16em] sm:text-7xl md:text-8xl";

function Resolve({ leaving }: { leaving: boolean }) {
  return (
    <div
      className="flex flex-col items-center gap-5"
      style={{
        transform: leaving ? "translateY(-7vh) scale(0.92)" : undefined,
        transition: `transform ${FADE_MS}ms ${EASE}`,
      }}
    >
      <div
        aria-hidden
        className="absolute left-1/2 top-1/2 h-64 w-[36rem] max-w-[90vw] -translate-x-1/2 -translate-y-1/2 rounded-full"
        style={{
          background:
            "radial-gradient(ellipse, color-mix(in oklch, var(--color-accent) 13%, transparent), transparent 70%)",
          animation: `scene-in 1600ms ${EASE} both`,
        }}
      />
      <div className="relative">
        <span className={`glitch-in ${WORDMARK} text-ink`} data-text="SABOTEUR">
          SABOTEUR
        </span>
        <span
          aria-hidden
          className={`intro-shine absolute inset-0 ${WORDMARK}`}
          style={{ animationDelay: "900ms" }}
        >
          SABOTEUR
        </span>
        <span
          aria-hidden
          className={`absolute left-0 top-full ${WORDMARK} text-ink`}
          style={{
            transform: "scaleY(-1)",
            opacity: 0.13,
            filter: "blur(2px)",
            maskImage: "linear-gradient(to bottom, transparent 40%, black 96%)",
            WebkitMaskImage: "linear-gradient(to bottom, transparent 40%, black 96%)",
          }}
        >
          SABOTEUR
        </span>
      </div>
      <p className={OVERLINE} style={{ animation: `intro-rise 900ms ${EASE} 800ms backwards` }}>
        chaos engineering for AI agents
      </p>
    </div>
  );
}
