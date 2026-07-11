
import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { ChaosLog } from "../components/ChaosLog";
import { CohortGrid } from "../components/CohortGrid";
import { PanelHeader } from "../components/PanelHeader";
import { RunBar } from "../components/RunBar";
import { ScorecardView } from "../components/ScorecardView";
import { TimelineDrawer } from "../components/TimelineDrawer";
import { TooltipSuppression } from "../components/Tooltip";
import { prefersReducedMotion } from "../landing/parts";
import { useRun } from "../state/RunContext";
import { DEMO_FAMILIES, type DemoRun } from "../demo";
import { Autopilot } from "./Autopilot";
import { FamilySelect } from "./FamilySelect";
import { Playbar } from "./Playbar";
import { Reveal } from "./Reveal";
import { SideBySide } from "./SideBySide";
import { usePrefersReducedMotion } from "./Spotlight";
import { TourOverlay } from "./TourOverlay";
import { TourPrompt } from "./TourPrompt";
import { buildTour } from "./tour";
import { useTourCamera } from "./useTourCamera";
import { useWalkthrough, WalkthroughProvider } from "./WalkthroughProvider";

type Tab = "grid" | "scorecard";

const CARD = "rounded-lg border border-line bg-panel";

const MORPH_MS = 480;

const DIP_MS = 320;

type Stage =
  | { kind: "select" }
  | { kind: "reveal" | "demo"; family: number; nonce: number };

export function WalkthroughView({ onExit }: { onExit: () => void }) {
  const [stage, setStage] = useState<Stage>({ kind: "select" });
  const [dipping, setDipping] = useState(false);
  const [tourArmed, setTourArmed] = useState(false);
  const dipTimer = useRef<number | null>(null);
  const nonceRef = useRef(0);

  useEffect(
    () => () => {
      if (dipTimer.current !== null) window.clearTimeout(dipTimer.current);
    },
    [],
  );

  const pickFamily = (index: number) => {
    nonceRef.current += 1;
    setTourArmed(false);
    setStage({
      kind: prefersReducedMotion() ? "demo" : "reveal",
      family: index,
      nonce: nonceRef.current,
    });
  };

  const runDip = (after: () => void) => {
    if (dipping) return;
    if (prefersReducedMotion()) {
      after();
      return;
    }
    setDipping(true);
    dipTimer.current = window.setTimeout(() => {
      dipTimer.current = null;
      after();
      setDipping(false);
    }, DIP_MS + 40);
  };

  const switchFamily = () => runDip(() => setStage({ kind: "select" }));
  const exitToLanding = () => runDip(onExit);

  if (stage.kind === "select") {
    return <FamilySelect families={DEMO_FAMILIES} onSelect={pickFamily} onExit={onExit} />;
  }

  const family = DEMO_FAMILIES[stage.family] ?? DEMO_FAMILIES[0];
  const otherFamilyIndex = stage.family === 0 ? 1 : 0;
  const otherFamily = DEMO_FAMILIES[otherFamilyIndex];
  return (
    <>
      <WalkthroughProvider key={stage.nonce} runs={family.runs}>
        <WalkthroughShell
          runs={family.runs}
          onSwitchFamily={switchFamily}
          onExit={exitToLanding}
          otherFamilyLabel={otherFamily?.name}
          onViewOtherFamily={
            otherFamily ? () => runDip(() => pickFamily(otherFamilyIndex)) : undefined
          }
          tourSuspended={stage.kind === "reveal" && !tourArmed}
        />
      </WalkthroughProvider>
      {stage.kind === "reveal" && (
        <Reveal
          family={family}
          onLeaveStart={() => setTourArmed(true)}
          onDone={() => setStage({ kind: "demo", family: stage.family, nonce: stage.nonce })}
        />
      )}
      {dipping &&
        createPortal(
          <div
            aria-hidden
            className="dip-cover pointer-events-none fixed inset-0 z-[210] bg-black"
            style={{ animation: `dip-in ${DIP_MS}ms ease forwards` }}
          />,
          document.body,
        )}
    </>
  );
}

function WalkthroughShell({
  runs,
  onSwitchFamily,
  onExit,
  otherFamilyLabel,
  onViewOtherFamily,
  tourSuspended = false,
}: {
  runs: DemoRun[];
  onSwitchFamily: () => void;
  onExit: () => void;
  otherFamilyLabel?: string;
  onViewOtherFamily?: () => void;
  tourSuspended?: boolean;
}) {
  const { state } = useRun();
  const { play, setSpeed, restart, seek, position, runIndex, switchRun } = useWalkthrough();
  const run: DemoRun = runs[runIndex] ?? runs[0];

  const [tab, setTab] = useState<Tab>("grid");
  const [selectedAgent, setSelectedAgent] = useState<number | null>(null);
  const [lastAgent, setLastAgent] = useState<number | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [feedCollapsed, setFeedCollapsed] = useState(false);
  const [tourMode, setTourMode] = useState<"tour" | "free">("tour");
  const [tourBeat, setTourBeat] = useState(0);
  const [sideBySideOpen, setSideBySideOpen] = useState(false);
  const [autopilot, setAutopilot] = useState(false);
  // pre-tour choice: autopilot vs manual; re-shown on tour replay
  const [tourPrompt, setTourPrompt] = useState(true);
  const [apOrigin, setApOrigin] = useState<{ x: number; y: number } | null>(null);
  const [apStopped, setApStopped] = useState(false);

  const beats = useMemo(() => buildTour(runs), [runs]);

  const selectAgent = (id: number | null) => {
    if (id !== null) setLastAgent(id);
    setSelectedAgent(id);
  };

  const switchRunFree = (index: number) => {
    switchRun(index);
    selectAgent(null);
    setTab("grid");
  };

  const reducedMotion = usePrefersReducedMotion();

  const [morphing, setMorphing] = useState(false);
  const morphTimer = useRef<number | null>(null);
  const seekSmooth = (index: number) => {
    if (index === position) return; 
    if (reducedMotion) {
      seek(index);
      return;
    }
    if (morphTimer.current !== null) window.clearTimeout(morphTimer.current);
    setMorphing(true);
    seek(index);
    morphTimer.current = window.setTimeout(() => {
      morphTimer.current = null;
      setMorphing(false);
    }, MORPH_MS);
  };
  useEffect(
    () => () => {
      if (morphTimer.current !== null) window.clearTimeout(morphTimer.current);
    },
    [],
  );

  const drawerAgent = selectedAgent ?? lastAgent;
  const drawerOpen = selectedAgent !== null && state.agents[selectedAgent] !== undefined;
  const tourActive = tourMode === "tour";

  const activeBeat = tourActive ? (beats[tourBeat] ?? null) : null;
  const activeBeatId = activeBeat?.id ?? null;
  const scorecardDock = activeBeatId === "scorecard" || activeBeatId === "faceoff";
  const faceoffData = activeBeat?.compare ?? null;
  const scBaseline = faceoffData ? faceoffData.models[0].scorecard : null;
  const scBaselineLabel = faceoffData ? faceoffData.models[0].short : undefined;

  useEffect(() => {
    if (faceoffData === null && sideBySideOpen) setSideBySideOpen(false);
  }, [faceoffData, sideBySideOpen]);

  const [covered, setCovered] = useState(!reducedMotion);
  const [coverFade, setCoverFade] = useState(false);
  useEffect(() => {
    if (!covered) return;
    const raf = requestAnimationFrame(() => setCoverFade(true));
    const t = window.setTimeout(() => setCovered(false), 520);
    return () => {
      cancelAnimationFrame(raf);
      window.clearTimeout(t);
    };
    // Run once on mount; the cover lifts and is then removed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const exitTour = () => {
    setAutopilot(false);
    setApStopped(false);
    setTourPrompt(false);
    setTourMode("free");
    play();
  };
  const finishTour = () => {
    setAutopilot(false);
    setApStopped(false);
    setTourMode("free");
    selectAgent(null);
    setTab("grid");
    setSpeed(2);
    restart();
  };
  const replayTour = () => {
    setTourBeat(0);
    setAutopilot(false);
    setApStopped(false);
    setTourPrompt(true);
    setTourMode("tour");
  };
  const startAutopilot = (origin: { x: number; y: number } | null) => {
    setApOrigin(origin);
    setApStopped(false);
    setTourPrompt(false);
    setAutopilot(true);
  };
  const toggleAutopilot = () => {
    if (autopilot) {
      setAutopilot(false);
      setApStopped(true);
      return;
    }
    if (tourMode !== "tour") {
      setTourBeat(0);
      setTourMode("tour");
    }
    startAutopilot(null);
  };

  // interactive reveal is sticky per beat: once the trace is opened the beat
  // stays revealed even if the drawer is closed, until the beat changes
  const [revealedBeat, setRevealedBeat] = useState<number | null>(null);
  useEffect(() => {
    if (!tourActive || !activeBeat?.interactive) return;
    if (selectedAgent === activeBeat.interactive.agent) setRevealedBeat(tourBeat);
  }, [tourActive, activeBeat, selectedAgent, tourBeat]);
  const apAwaiting = !!activeBeat?.interactive && revealedBeat !== tourBeat;

  const promptOpen = tourActive && !tourSuspended && !covered && tourPrompt;

  const wrapperRef = useRef<HTMLDivElement>(null);
  const { camera, spotRect } = useTourCamera({
    active: tourActive && !tourSuspended && !covered && !tourPrompt,
    beat: activeBeat,
    awaiting: apAwaiting,
    reducedMotion,
    wrapperRef,
  });

  return (
    <TooltipSuppression active={tourMode === "tour"}>
    <div className="fixed inset-0 overflow-hidden bg-void">
    <div
      ref={wrapperRef}
      className="flex h-full flex-col gap-2 p-2"
      style={{
        transformOrigin: "0 0",
        transform: `translate(${camera.x}px, ${camera.y}px) scale(${camera.scale})`,
        transition: reducedMotion ? undefined : "transform 820ms cubic-bezier(0.4, 0, 0.2, 1)",
        willChange: tourActive ? "transform" : undefined,
      }}
    >
      <header
        className={`${CARD} flex items-center gap-4 px-4 py-2.5`}
        style={{ animation: "card-in 0.3s ease-out backwards" }}
      >
        <button
          type="button"
          onClick={() => setSidebarOpen((o) => !o)}
          className="rounded-sm border border-line p-1.5 text-ink-dim transition-colors duration-150 hover:bg-raised hover:text-ink xl:hidden"
          title={sidebarOpen ? "Hide panel" : "Show panel"}
        >
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden>
            <path d="M2 4h12M2 8h12M2 12h12" />
          </svg>
        </button>

        <div className="flex items-center gap-3">
          <span className="font-brand text-[32px] font-extrabold leading-none tracking-[0.22em] text-ink">
            SABOTEUR
          </span>
          <span className="hidden rounded-sm border border-accent/50 bg-accent/10 px-2 py-1 text-[10px] font-bold leading-none tracking-[0.3em] text-accent sm:inline-block">
            CHAOS CONSOLE
          </span>
          <span className="hidden rounded-sm border border-win/40 bg-win/10 px-2 py-1 text-[10px] font-bold leading-none tracking-[0.28em] text-win md:inline-block">
            DEMO REPLAY
          </span>
        </div>

        <div className="ml-auto flex items-center gap-2">
          {tourMode === "free" && (
            <button
              type="button"
              onClick={replayTour}
              className="rounded-sm border border-accent/50 px-3 py-1 text-xs font-semibold text-accent transition-colors duration-150 hover:bg-accent/10"
            >
              Replay tour
            </button>
          )}
          <button
            type="button"
            onClick={onSwitchFamily}
            className="rounded-sm border border-line px-3 py-1 text-xs font-medium text-ink-dim transition-colors duration-150 hover:bg-raised hover:text-ink"
          >
            Switch family
          </button>
          <button
            type="button"
            onClick={onExit}
            className="rounded-sm border border-line px-3 py-1 text-xs font-medium text-ink-dim transition-colors duration-150 hover:bg-raised hover:text-ink"
          >
            Back to landing
          </button>
        </div>
      </header>

      <div className="relative flex min-h-0 flex-1 gap-2 overflow-hidden">
        <aside
          className={`absolute inset-y-0 left-0 z-40 w-80 shrink-0 flex-col gap-2 transition-transform xl:relative xl:flex xl:translate-x-0 ${
            sidebarOpen ? "flex translate-x-0" : "hidden -translate-x-full"
          }`}
          style={{ animation: "card-in 0.3s ease-out 60ms backwards" }}
        >
          <div className={`${CARD} overflow-hidden max-xl:bg-panel/95 max-xl:backdrop-blur-md`}>
            <PanelHeader title="RECORDED RUN" />
            <dl className="space-y-2 p-3 text-sm">
              <InfoRow k="run" v={run.label} />
              <InfoRow k="profile" v={state.profile ?? run.scorecard.profile} />
              <InfoRow k="seed" v={state.seed === null ? "-" : String(state.seed)} />
              <InfoRow k="agents" v={String(run.scorecard.n_agents)} />
              <InfoRow k="source" v="static replay" />
            </dl>
          </div>

          <div
            data-tour="chaoslog"
            className={`${CARD} flex min-h-0 flex-col overflow-hidden max-xl:bg-panel/95 max-xl:backdrop-blur-md ${
              feedCollapsed ? "" : "flex-1"
            }`}
          >
            <ChaosLog collapsed={feedCollapsed} onToggle={() => setFeedCollapsed((c) => !c)} />
          </div>
        </aside>

        {sidebarOpen && (
          <div
            className="fixed inset-0 z-30 bg-void/50 xl:hidden"
            onClick={() => setSidebarOpen(false)}
            aria-hidden
          />
        )}

        <main
          className={`${CARD} flex min-w-0 flex-1 flex-col overflow-hidden`}
          style={{ animation: "card-in 0.3s ease-out 120ms backwards" }}
        >
          <div data-tour="runbar">
            <RunBar staticRun />
          </div>

          <nav className="flex items-center gap-1 border-b border-line px-3 py-1.5">
            <TabButton active={tab === "grid"} onClick={() => setTab("grid")}>
              COHORT
            </TabButton>
            <TabButton active={tab === "scorecard"} onClick={() => setTab("scorecard")}>
              SCORECARD
              {state.finished && tab !== "scorecard" && (
                <span className="ml-1.5 inline-block h-1.5 w-1.5 rounded-full bg-accent align-middle" />
              )}
            </TabButton>
          </nav>

          {/* both tabs stay mounted: pre-warms ScorecardView (heavy first render) so tab switch is instant */}
          <div className="relative min-h-0 flex-1">
            <div
              data-tour="grid"
              className={`absolute inset-0 transition-opacity duration-500 ease-out ${morphing ? "grid-morphing" : ""}`}
              style={{
                opacity: tab === "grid" ? 1 : 0,
                pointerEvents: tab === "grid" ? "auto" : "none",
                zIndex: tab === "grid" ? 2 : 1,
              }}
              aria-hidden={tab !== "grid"}
            >
              <CohortGrid selectedAgent={selectedAgent} onSelect={selectAgent} morphing={morphing} />
            </div>
            <div
              data-tour="scorecard"
              className="absolute inset-0 transition-opacity duration-500 ease-out"
              style={{
                opacity: tab === "scorecard" ? 1 : 0,
                pointerEvents: tab === "scorecard" ? "auto" : "none",
                zIndex: tab === "scorecard" ? 2 : 1,
              }}
              aria-hidden={tab !== "scorecard"}
            >
              <div className={`h-full ${scorecardDock ? "max-lg:[&>*]:pb-[46vh]" : ""}`}>
                <ScorecardView baseline={scBaseline} baselineLabel={scBaselineLabel} />
              </div>
            </div>
          </div>

          <div data-tour="playbar">
            <Playbar
              runs={runs}
              onReplayTour={replayTour}
              showReplayTour={tourMode === "free"}
              runIndex={runIndex}
              onSwitchRun={switchRunFree}
              switcherDisabled={tourActive}
              autopilot={autopilot}
              onToggleAutopilot={toggleAutopilot}
            />
          </div>
        </main>

        {/* tour mode: opacity-only transition so spotlight has a stable rect to glide to (not a sliding target) */}
        <div
          data-tour="timeline"
          className={`absolute inset-y-0 right-0 z-30 w-[20.5rem] pl-2 xl:w-[23rem] max-sm:inset-0 max-sm:w-full max-sm:pl-0 will-change-transform ${
            tourActive
              ? `transition-opacity duration-300 ease-out ${
                  drawerOpen ? "translate-x-0 opacity-100" : "translate-x-full opacity-0 pointer-events-none"
                }`
              : `transition-transform duration-[280ms] ease-[cubic-bezier(0.25,1,0.3,1)] ${
                  drawerOpen ? "translate-x-0" : "translate-x-full pointer-events-none"
                }`
          }`}
        >
          <div className="h-full">
            {drawerAgent !== null && state.agents[drawerAgent] && (
              <TimelineDrawer agentId={drawerAgent} onClose={() => setSelectedAgent(null)} />
            )}
          </div>
        </div>
      </div>

      <TourOverlay
        beats={beats}
        active={tourMode === "tour" && !tourSuspended && !tourPrompt}
        beatIndex={tourBeat}
        onSetBeat={setTourBeat}
        onExitTour={exitTour}
        onFinishTour={finishTour}
        onExitToLanding={onExit}
        otherFamilyLabel={otherFamilyLabel}
        onViewOtherFamily={onViewOtherFamily}
        selectAgent={selectAgent}
        setTab={setTab}
        seekSmooth={seekSmooth}
        sideBySideOpen={sideBySideOpen}
        onToggleSideBySide={() => setSideBySideOpen((o) => !o)}
        autopilot={autopilot}
        canResume={apStopped}
        onStartAutopilot={startAutopilot}
        awaiting={apAwaiting}
        spotRect={spotRect}
      />

      {promptOpen && (
        <TourPrompt
          totalBeats={beats.length}
          onAutopilot={startAutopilot}
          onManual={() => setTourPrompt(false)}
          onSkip={exitTour}
        />
      )}

      <Autopilot
        enabled={autopilot && tourActive && !tourSuspended && !tourPrompt}
        beat={activeBeat}
        awaiting={apAwaiting}
        isLast={tourBeat >= beats.length - 1}
        origin={apOrigin}
        onStop={(reason) => {
          setAutopilot(false);
          if (reason === "interrupt") setApStopped(true);
        }}
      />

      {/* face-off beat: side-by-side scorecard comparison */}
      <SideBySide
        open={sideBySideOpen && faceoffData !== null}
        data={faceoffData}
        onClose={() => setSideBySideOpen(false)}
      />

      {/* fade-in-from-black cover portaled above tour overlays */}
      {covered &&
        createPortal(
          <div
            aria-hidden
            className="pointer-events-none fixed inset-0 z-[180] bg-black"
            style={{ opacity: coverFade ? 0 : 1, transition: "opacity 460ms ease" }}
          />,
          document.body,
        )}
    </div>
    </div>
    </TooltipSuppression>
  );
}

function InfoRow({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="text-[11px] font-semibold uppercase tracking-[0.14em] text-ink-dim">{k}</dt>
      <dd className="truncate font-medium text-ink">{v}</dd>
    </div>
  );
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`relative px-3 py-1 text-xs font-semibold tracking-widest transition-colors duration-200 ${
        active ? "text-ink" : "text-ink-faint hover:text-ink-dim"
      }`}
    >
      {children}
      <span
        className="absolute inset-x-0 -bottom-px h-[2px] bg-accent transition-all duration-200"
        style={{ opacity: active ? 1 : 0, transform: active ? "scaleX(1)" : "scaleX(0.3)" }}
      />
    </button>
  );
}
