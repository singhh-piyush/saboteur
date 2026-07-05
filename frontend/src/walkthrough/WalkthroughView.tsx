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
import { FaceoffCard } from "./FaceoffCompare";
import { FamilySelect } from "./FamilySelect";
import { Playbar } from "./Playbar";
import { Reveal } from "./Reveal";
import { usePrefersReducedMotion } from "./Spotlight";
import { TourOverlay } from "./TourOverlay";
import { buildTour } from "./tour";
import { useWalkthrough, WalkthroughProvider } from "./WalkthroughProvider";

type Tab = "grid" | "scorecard";

const CARD = "rounded-lg border border-line bg-panel";

/** Blur-through timings for a tour position jump: the grid briefly blurs + dims
 * (never to black) while the seek happens behind it, then eases back in. */
const WARP_OUT_MS = 220;
const WARP_IN_MS = 420;
const WARP_EASE = "cubic-bezier(0.4, 0, 0.2, 1)";

/** Dip-to-black time for the demo -> family-selector handoff. */
const DIP_MS = 320;

type Stage =
  | { kind: "select" }
  | { kind: "reveal" | "demo"; family: number; nonce: number };

export function WalkthroughView({ onExit }: { onExit: () => void }) {
  // Stage machine: family selector -> branded reveal -> demo. The provider +
  // shell mount at "reveal", UNDER the opaque Reveal overlay, so the keyed
  // remount and the first paint are never visible - the reveal fades out over
  // a fully painted demo. Within a mounted demo the provider still swaps the
  // family's sibling runs IN PLACE (no remount): the tour's face-off beat and
  // the free-mode switcher stay seamless.
  const [stage, setStage] = useState<Stage>({ kind: "select" });
  const [dipping, setDipping] = useState(false);
  // Armed when the reveal begins its fade-out: the tour comes up UNDER the still
  // opaque black so there is no dead pause before step 1. Reset on every pick.
  const [tourArmed, setTourArmed] = useState(false);
  const dipTimer = useRef<number | null>(null);
  const nonceRef = useRef(0);

  useEffect(
    () => () => {
      if (dipTimer.current !== null) window.clearTimeout(dipTimer.current);
    },
    [],
  );

  // Every pick gets a fresh nonce -> fresh provider + fresh guided tour, even
  // when re-picking the same family. Reduced motion skips the reveal.
  const pickFamily = (index: number) => {
    nonceRef.current += 1;
    setTourArmed(false);
    setStage({
      kind: prefersReducedMotion() ? "demo" : "reveal",
      family: index,
      nonce: nonceRef.current,
    });
  };

  // Dip to black, run `after` at the darkest point, then lift. The selector and
  // the reveal are both pure black, so a handoff through the dip is seamless.
  // Reduced motion runs `after` immediately (no fade).
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
  // The other bundled family (two families total) - the last tour beat offers to
  // route to its run through the reveal sequence.
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
  /** The other bundled family's name + a handler that routes to its run (via
   * the reveal); surfaced as an extra action on the last tour beat. */
  otherFamilyLabel?: string;
  onViewOtherFamily?: () => void;
  /** True while the reveal overlay covers the shell: the tour overlay stays
   * dormant so the reveal's skip keys can never step or exit the tour. */
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

  // Built once over the family's runs; each beat carries its run binding, so
  // the list stays stable across in-place run switches.
  const beats = useMemo(() => buildTour(runs), [runs]);

  const selectAgent = (id: number | null) => {
    if (id !== null) setLastAgent(id);
    setSelectedAgent(id);
  };

  // Free-mode run switch: land on a clean paused grid at the new run's intro
  // fold (the swap itself seeks there). Tour beats do their own tab/selection.
  const switchRunFree = (index: number) => {
    switchRun(index);
    selectAgent(null);
    setTab("grid");
  };

  const reducedMotion = usePrefersReducedMotion();

  // Tour beat position jumps: blur through, don't churn. The grid briefly blurs
  // and dims to a panel tint (never black), the instant seek happens behind the
  // blur, then it eases back in showing only the destination state - none of the
  // mid-run color flashing a live fold would paint. Reduced motion seeks instantly.
  const [warping, setWarping] = useState(false);
  const warpTimer = useRef<number | null>(null);
  const seekSmooth = (index: number) => {
    if (index === position) return; // nothing changes - no blink
    if (reducedMotion) {
      seek(index);
      return;
    }
    if (warpTimer.current !== null) window.clearTimeout(warpTimer.current);
    setWarping(true);
    warpTimer.current = window.setTimeout(() => {
      warpTimer.current = null;
      seek(index);
      setWarping(false);
    }, WARP_OUT_MS + 10);
  };
  useEffect(
    () => () => {
      if (warpTimer.current !== null) window.clearTimeout(warpTimer.current);
    },
    [],
  );

  const drawerAgent = selectedAgent ?? lastAgent;
  const drawerOpen = selectedAgent !== null && state.agents[selectedAgent] !== undefined;
  const tourActive = tourMode === "tour";

  // While the scorecard / face-off beats dock their coachmark to the left, the
  // scorecard is fully visible beside it on wide screens. On narrow screens the
  // callout flips to a bottom bar, so reserve room beneath the scorecard there
  // (lg+ needs none) - nothing is hidden under the docked card at any width.
  const activeBeat = tourActive ? (beats[tourBeat] ?? null) : null;
  const activeBeatId = activeBeat?.id ?? null;
  const scorecardDock = activeBeatId === "scorecard" || activeBeatId === "faceoff";
  // The face-off beat surfaces the model-comparison as its own floating card
  // (FaceoffCard) that pops in over the top of the dashboard - like the
  // coachmark cards - where the viewer can freely toggle models and watch the
  // moved metrics highlight. Null on every other beat drives its exit.
  const faceoffData = activeBeat?.compare ?? null;

  // Fade in from black on entry, completing the dip-to-black handoff from the
  // landing page (the demo mounts under a black cover that then lifts).
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
    setTourMode("free");
    play();
  };
  // Finishing the tour ("Watch the full run" on the last beat) drops into free
  // mode and auto-plays the full replay from the very beginning at 2x - the
  // grid tab fades in as the run starts, so the canvas only changes because
  // the viewer chose to watch.
  const finishTour = () => {
    setTourMode("free");
    selectAgent(null);
    setTab("grid");
    setSpeed(2);
    restart(); // seeks to the start and plays
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
            {/* During a tour seek (`warping`) the grid blurs + dims to a panel
                tint (never black) - a quick blur out, a slower ease back - so
                the destination state resolves under a soft veil, not a hard
                flash. Tab switching still cross-fades via the pane opacity. */}
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
              <div
                className="h-full w-full"
                style={{
                  transition: reducedMotion
                    ? undefined
                    : `filter ${warping ? WARP_OUT_MS : WARP_IN_MS}ms ${WARP_EASE}, opacity ${warping ? WARP_OUT_MS : WARP_IN_MS}ms ${WARP_EASE}`,
                  filter: warping ? "blur(6px)" : "blur(0px)",
                  opacity: warping ? 0.4 : 1,
                }}
              >
                <CohortGrid selectedAgent={selectedAgent} onSelect={selectAgent} />
              </div>
              {/* Panel-tinted veil (matches the card, never black) that fades in
                  with the blur so the seek reads as a soft dim, not a black cut. */}
              <div
                aria-hidden
                className="pointer-events-none absolute inset-0 bg-panel"
                style={{
                  transition: reducedMotion
                    ? undefined
                    : `opacity ${warping ? WARP_OUT_MS : WARP_IN_MS}ms ${WARP_EASE}`,
                  opacity: warping ? 0.45 : 0,
                }}
              />
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
                <ScorecardView />
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
            />
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
        active={tourMode === "tour" && !tourSuspended}
        beatIndex={tourBeat}
        onSetBeat={setTourBeat}
        onExitTour={exitTour}
        onFinishTour={finishTour}
        onExitToLanding={onExit}
        otherFamilyLabel={otherFamilyLabel}
        onViewOtherFamily={onViewOtherFamily}
        selectedAgent={selectedAgent}
        selectAgent={selectAgent}
        setTab={setTab}
        seekSmooth={seekSmooth}
      />

      {/* Floating model face-off card - pops in on the face-off beat, eases out
          when it leaves (its own top card, like the coachmarks). */}
      <FaceoffCard
        open={faceoffData !== null}
        data={faceoffData}
        focus={runIndex}
        onFocus={switchRun}
      />

      {/* Fade-in-from-black cover (portaled above the tour overlays). */}
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
