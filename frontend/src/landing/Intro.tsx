
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

type Scene = "thesis" | "cohort" | "sabotage" | "verdict" | "resolve";

const SCENES: { id: Scene; ms: number }[] = [
  { id: "thesis", ms: 6200 },
  { id: "cohort", ms: 6600 },
  { id: "sabotage", ms: 6200 },
  { id: "verdict", ms: 6800 },
  { id: "resolve", ms: 3800 },
];

const FADE_MS = 1400;
const XFADE_MS = 860;
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
        style={{ animation: `intro-scene-in 880ms ${EASE} both`, pointerEvents: "none" }}
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

const COLS = 6;

function MiniCard({ id, delay, barW, win }: { id: number; delay: number; barW: number; win: boolean }) {
  const dl = `${delay}ms`;
  return (
    <div
      className={`intro-agent rounded-md border p-2.5 text-left ${win ? "intro-agent-win" : ""}`}
      style={{ animationDelay: dl }}
    >
      <div className="flex items-center justify-between">
        <span className="font-mono text-[11px] font-semibold tracking-wide text-ink">
          A-{String(id).padStart(2, "0")}
        </span>
        <span
          aria-hidden
          className="h-2 w-2 rounded-full"
          style={{ background: "currentColor", boxShadow: "0 0 8px currentColor" }}
        />
      </div>
      {/* the status word rides the card's animation clock via ::after */}
      <span
        className="intro-pill mt-2 inline-block rounded-sm px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-[0.14em]"
        style={{ animationDelay: dl, background: "color-mix(in oklch, currentColor 15%, transparent)" }}
      />
      <div className="mt-2 h-[3px] w-full overflow-hidden rounded-full bg-white/10">
        <div
          className="h-full rounded-full"
          style={{ width: `${barW}%`, background: "currentColor", boxShadow: "0 0 6px currentColor" }}
        />
      </div>
    </div>
  );
}

function Cohort() {
  const cards = Array.from({ length: 18 }, (_, i) => i);
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
        style={{ perspective: "780px", animation: `intro-rise 1100ms ${EASE} 700ms backwards` }}
      >
        <div
          className="relative"
          style={{
            width: "min(90vw, 880px)",
            transformStyle: "preserve-3d",
            // static end state keeps the plane tilted in the crossfade snapshot
            transform: "rotateX(36deg) translateY(0) scale(1)",
            animation: `intro-floor 6600ms ${EASE} both`,
          }}
        >
          {/* preserve-3d here lets each card's translateZ pop compose with the tilt
              (a mask would flatten the subtree, so depth fog is an overlay instead) */}
          <div className="grid grid-cols-6 gap-2.5" style={{ transformStyle: "preserve-3d" }}>
            {cards.map((i) => {
              const row = Math.floor(i / COLS);
              const col = i % COLS;
              return (
                <MiniCard
                  key={i}
                  id={i}
                  delay={(col + row * 1.5) * 260 - 3600}
                  barW={18 + ((i * 37) % 68)}
                  win={i % 3 === 0}
                />
              );
            })}
          </div>
          {/* depth fog: far edge of the floor dissolves into the void */}
          <div
            aria-hidden
            className="pointer-events-none absolute -inset-x-3 -top-3 h-1/2"
            style={{
              background: "linear-gradient(to bottom, rgba(0, 0, 0, 0.94) 12%, transparent)",
            }}
          />
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

/** faults streak in from off-screen and land in three tidy layer clusters:
    transport left of the node, context right, tool row beneath, and the
    silent_lie probe alone above it - structure over scatter, no ring shapes */
const STRIKES: { name: string; x: number; y: number; d: number; fx: string; fy: string; big?: boolean }[] = [
  { name: "latency", x: -238, y: -44, d: 500, fx: "-58vw", fy: "-6vh" },
  { name: "timeout", x: -238, y: 6, d: 740, fx: "-58vw", fy: "8vh" },
  { name: "context_drop", x: 238, y: -20, d: 980, fx: "58vw", fy: "-4vh" },
  { name: "api_error", x: -168, y: 118, d: 1260, fx: "-30vw", fy: "54vh" },
  { name: "rate_limit", x: -56, y: 118, d: 1480, fx: "-10vw", fy: "54vh" },
  { name: "malformed", x: 56, y: 118, d: 1700, fx: "10vw", fy: "54vh" },
  { name: "tool_vanish", x: 168, y: 118, d: 1920, fx: "30vw", fy: "54vh" },
  { name: "silent_lie", x: 0, y: -116, d: 2450, fx: "0vw", fy: "-52vh", big: true },
];

const FLIGHT_MS = 650;

const LAYER_CAPTIONS: { text: string; x: number; y: number; d: number }[] = [
  { text: "transport", x: -238, y: 46, d: 1550 },
  { text: "context", x: 238, y: 16, d: 1800 },
  { text: "tool", x: 0, y: 158, d: 2750 },
  { text: "the deception probe", x: 0, y: -156, d: 3350 },
];

function Sabotage() {
  const impacts = STRIKES.map((s) => `intro-impact 260ms ease-out ${s.d + FLIGHT_MS}ms`).join(", ");
  return (
    <div className="absolute inset-0">
      {/* centering stays on the wrapper; entrance + hit flinches animate the inner
          div so the node never drifts off its anchor mid-animation */}
      <div className="absolute left-1/2 top-[42%]" style={{ transform: "translate(-50%, -50%)" }}>
        <div style={{ animation: `intro-rise 700ms ${EASE} 200ms backwards, ${impacts}` }}>
          <div className="relative rounded border border-line-strong bg-panel px-5 py-3">
            <span className="font-mono text-sm font-semibold text-ink">your agent</span>
            <span
              aria-hidden
              className="absolute -inset-2 rounded border border-accent/40"
              style={{ animation: "intro-ring 2200ms ease-out infinite" }}
            />
          </div>
        </div>
      </div>
      {STRIKES.map((s) => {
        const lie = s.big === true;
        return (
          <span
            key={s.name}
            className={`absolute left-1/2 top-[42%] rounded-sm border px-2.5 py-1 font-mono ${
              lie
                ? "border-accent bg-accent/15 text-sm font-semibold text-accent sm:text-base"
                : "border-line-strong bg-panel text-xs text-ink-dim sm:text-sm"
            }`}
            style={{
              ["--tx" as string]: `${s.x}px`,
              ["--ty" as string]: `${s.y}px`,
              ["--fx" as string]: s.fx,
              ["--fy" as string]: s.fy,
              transform: `translate(calc(-50% + ${s.x}px), calc(-50% + ${s.y}px))`,
              animation: `intro-converge ${FLIGHT_MS}ms cubic-bezier(0.4, 0, 0.9, 0.6) ${s.d}ms backwards, intro-land 550ms ease-out ${s.d + FLIGHT_MS}ms backwards${
                lie ? `, intro-pulse 2000ms ease-in-out ${s.d + 1400}ms infinite` : ""
              }`,
            }}
          >
            {s.name}
          </span>
        );
      })}
      {STRIKES.map((s) => (
        <span
          key={`shock-${s.name}`}
          aria-hidden
          className={`absolute h-12 w-12 rounded-full border ${s.big ? "border-accent/70" : "border-white/30"}`}
          style={{
            left: `calc(50% + ${s.x}px)`,
            top: `calc(42% + ${s.y}px)`,
            // natural opacity 0 hides the ring outside its burst (no fill mode:
            // "both"/"backwards" would paint the from-state during the delay)
            opacity: 0,
            animation: `intro-shock 700ms ease-out ${s.d + FLIGHT_MS - 40}ms`,
          }}
        />
      ))}
      {LAYER_CAPTIONS.map((c) => (
        <span
          key={c.text}
          className="absolute left-1/2 top-[42%] whitespace-nowrap text-[10px] font-semibold uppercase tracking-[0.25em] text-ink-faint"
          style={{
            transform: `translate(calc(-50% + ${c.x}px), calc(-50% + ${c.y}px))`,
            animation: `scene-in 700ms ${EASE} ${c.d}ms backwards`,
          }}
        >
          {c.text}
        </span>
      ))}
      <div className="absolute inset-x-0 bottom-[16%] flex flex-col items-center gap-2">
        <p className={OVERLINE} style={{ animation: `intro-rise 900ms ${EASE} 3000ms backwards` }}>
          the sabotage
        </p>
        <p className={SCENE_COPY} style={{ animation: `intro-rise 900ms ${EASE} 3200ms backwards` }}>
          8 faults. 3 layers. Injected on the wire.
        </p>
      </div>
    </div>
  );
}

function useCountUp(to: number | null, delayMs: number, format: (v: number) => string): string {
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
  return to === null ? "-" : format(v);
}

function Tile({
  label,
  value,
  caption,
  delay,
  accent,
  format,
}: {
  label: string;
  value: number | null;
  caption: string;
  delay: number;
  accent?: boolean;
  format: (v: number) => string;
}) {
  const display = useCountUp(value, delay, format);
  return (
    <div
      className="flex flex-col items-center gap-1.5 px-3 py-5"
      style={{ animation: `intro-rise 800ms ${EASE} ${delay}ms backwards` }}
    >
      <span className="text-[10px] font-semibold uppercase tracking-[0.2em] text-ink-faint">
        {label}
      </span>
      <span
        className={`font-display text-3xl font-bold tabular-nums sm:text-4xl ${
          accent ? "text-accent" : "text-ink"
        }`}
        style={
          accent
            ? { textShadow: "0 0 24px color-mix(in oklch, var(--color-accent) 45%, transparent)" }
            : undefined
        }
      >
        {display}
      </span>
      <span className="text-xs font-medium text-ink-dim">{caption}</span>
    </div>
  );
}

function Verdict() {
  const s = RUN_8B.scorecard;
  const pct = (v: number) => `${Math.round(v * 100)}%`;
  return (
    <div className="relative flex w-full max-w-xl flex-col items-center gap-6">
      <p className={OVERLINE} style={{ animation: `intro-rise 900ms ${EASE} 200ms backwards` }}>
        the verdict
      </p>
      <p className={SCENE_COPY} style={{ animation: `intro-rise 900ms ${EASE} 400ms backwards` }}>
        Every run ends in a Resilience Scorecard.
      </p>
      <div
        className="w-full overflow-hidden rounded-lg border border-line-strong bg-panel/90"
        style={{
          animation: `intro-rise 900ms ${EASE} 1000ms backwards`,
          boxShadow:
            "0 24px 80px -24px rgb(0 0 0 / 80%), 0 0 44px -16px color-mix(in oklch, var(--color-accent) 30%, transparent)",
        }}
      >
        <div className="flex items-center gap-2 border-b border-line px-4 py-2.5">
          <span aria-hidden className="h-3 w-[3px] shrink-0 rounded-full bg-accent" />
          <span className="text-[10px] font-bold uppercase tracking-[0.25em] text-ink-dim">
            resilience scorecard
          </span>
          <span className="ml-auto font-mono text-[10px] text-ink-faint">
            {s.profile} · {s.n_agents} agents
          </span>
        </div>
        <div className="grid grid-cols-3 divide-x divide-line">
          <Tile
            label="survival"
            value={s.survival_rate}
            caption="finished under fire"
            delay={1500}
            format={pct}
          />
          <Tile
            label="deception caught"
            value={s.deception_detection_rate}
            caption="refused a planted lie"
            delay={2000}
            accent
            format={pct}
          />
          <Tile
            label="recovery"
            value={s.mttr_steps}
            caption="steps to bounce back"
            delay={2500}
            format={(v) => v.toFixed(1)}
          />
        </div>
      </div>
      <p
        className="text-base font-medium text-ink-dim sm:text-lg"
        style={{ animation: `intro-rise 900ms ${EASE} 3900ms backwards` }}
      >
        Resilience is measurable. <span className="text-ink">Know before you ship.</span>
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
