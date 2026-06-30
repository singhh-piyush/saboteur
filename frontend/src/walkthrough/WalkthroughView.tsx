/**
 * WalkthroughView - the static, backend-free demo page. It lays out the exact
 * same dashboard components the live console uses (CohortGrid, RunBar,
 * ChaosLog, TimelineDrawer, ScorecardView), driven by the WalkthroughProvider's
 * replay instead of a WebSocket, and layers a guided tour on top.
 *
 * The chrome mirrors App.tsx's Shell (modular gapped cards on the void) so the
 * page is visually indistinguishable from the real console. The network-bound
 * ControlPanel is replaced by a static "recorded run" info card; everything
 * else is the genuine article.
 */

import { useMemo, useState } from "react";

import { ChaosLog } from "../components/ChaosLog";
import { CohortGrid } from "../components/CohortGrid";
import { PanelHeader } from "../components/PanelHeader";
import { RunBar } from "../components/RunBar";
import { ScorecardView } from "../components/ScorecardView";
import { TimelineDrawer } from "../components/TimelineDrawer";
import { TooltipSuppression } from "../components/Tooltip";
import { useRun } from "../state/RunContext";
import { DEMO_RUN } from "../demo";
import { Playbar } from "./Playbar";
import { TourOverlay } from "./TourOverlay";
import { buildTour } from "./tour";
import { useWalkthrough, WalkthroughProvider } from "./WalkthroughProvider";

type Tab = "grid" | "scorecard";

const CARD = "rounded-lg border border-line bg-panel";

export function WalkthroughView({ onExit }: { onExit: () => void }) {
  return (
    <WalkthroughProvider>
      <WalkthroughShell onExit={onExit} />
    </WalkthroughProvider>
  );
}

function WalkthroughShell({ onExit }: { onExit: () => void }) {
  const { state } = useRun();
  const { play } = useWalkthrough();

  const [tab, setTab] = useState<Tab>("grid");
  const [selectedAgent, setSelectedAgent] = useState<number | null>(null);
  const [lastAgent, setLastAgent] = useState<number | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [feedCollapsed, setFeedCollapsed] = useState(false);
  const [tourMode, setTourMode] = useState<"tour" | "free">("tour");
  const [tourBeat, setTourBeat] = useState(0);

  const beats = useMemo(() => buildTour(DEMO_RUN.events, DEMO_RUN.scorecard), []);

  const selectAgent = (id: number | null) => {
    if (id !== null) setLastAgent(id);
    setSelectedAgent(id);
  };

  const drawerAgent = selectedAgent ?? lastAgent;
  const drawerOpen = selectedAgent !== null && state.agents[selectedAgent] !== undefined;
  const tourActive = tourMode === "tour";

  const exitTour = () => {
    setTourMode("free");
    play();
  };
  const replayTour = () => {
    setTourBeat(0);
    setTourMode("tour");
  };

  return (
    <TooltipSuppression active={tourMode === "tour"}>
    <div className="flex h-screen flex-col gap-2 bg-void p-2">
      {/* Header */}
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
            onClick={onExit}
            className="rounded-sm border border-line px-3 py-1 text-xs font-medium text-ink-dim transition-colors duration-150 hover:bg-raised hover:text-ink"
          >
            Back to landing
          </button>
        </div>
      </header>

      {/* Body */}
      <div className="relative flex min-h-0 flex-1 gap-2 overflow-hidden">
        {/* Sidebar */}
        <aside
          className={`absolute inset-y-0 left-0 z-40 w-80 shrink-0 flex-col gap-2 transition-transform xl:relative xl:flex xl:translate-x-0 ${
            sidebarOpen ? "flex translate-x-0" : "hidden -translate-x-full"
          }`}
          style={{ animation: "card-in 0.3s ease-out 60ms backwards" }}
        >
          <div className={`${CARD} overflow-hidden max-xl:bg-panel/95 max-xl:backdrop-blur-md`}>
            <PanelHeader title="RECORDED RUN" />
            <dl className="space-y-2 p-3 text-sm">
              <InfoRow k="profile" v={state.profile ?? DEMO_RUN.scorecard.profile} />
              <InfoRow k="seed" v={state.seed === null ? "-" : String(state.seed)} />
              <InfoRow k="agents" v={String(DEMO_RUN.scorecard.n_agents)} />
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

        {/* Main */}
        <main
          className={`${CARD} flex min-w-0 flex-1 flex-col overflow-hidden`}
          style={{ animation: "card-in 0.3s ease-out 120ms backwards" }}
        >
          <div data-tour="runbar">
            <RunBar />
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

          {/* Both tabs stay mounted and cross-fade with opacity. This pre-warms
              ScorecardView (its heavy foldEvents + recharts first render happen
              once at load, behind the intro spotlight) so switching to the
              scorecard is an instant fade, not a stutter. */}
          <div className="relative min-h-0 flex-1">
            <div
              data-tour="grid"
              className="absolute inset-0 transition-opacity duration-500 ease-out"
              style={{
                opacity: tab === "grid" ? 1 : 0,
                pointerEvents: tab === "grid" ? "auto" : "none",
                zIndex: tab === "grid" ? 2 : 1,
              }}
              aria-hidden={tab !== "grid"}
            >
              <CohortGrid selectedAgent={selectedAgent} onSelect={selectAgent} />
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
              <ScorecardView />
            </div>
          </div>

          <div data-tour="playbar">
            <Playbar onReplayTour={replayTour} showReplayTour={tourMode === "free"} />
          </div>
        </main>

        {/* Timeline drawer - over the grid (no grid reflow). In free mode it slides
            in via transform. During the guided tour it instead snaps to its final
            position and fades in (transition-opacity only, no transform transition):
            a slide-in would move the drawer's rect across the screen, and the tour
            spotlight would try to chase it - so the outline appeared to dart off and
            come back. A fixed-position fade gives the spotlight a stable target to
            glide to in one clean motion. */}
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
        active={tourMode === "tour"}
        beatIndex={tourBeat}
        onSetBeat={setTourBeat}
        onExitTour={exitTour}
        onExitToLanding={onExit}
        selectedAgent={selectedAgent}
        selectAgent={selectAgent}
        setTab={setTab}
      />
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
