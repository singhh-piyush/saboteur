import { useState } from "react";

import { CohortGrid } from "./components/CohortGrid";
import { ChaosLog } from "./components/ChaosLog";
import { ComparePage } from "./components/ComparePage";
import { ConnectionBadge } from "./components/ConnectionBadge";
import { ControlPanel } from "./components/ControlPanel";
import { ProfileBuilder } from "./components/ProfileBuilder";
import { ReplayBar } from "./components/ReplayBar";
import { RunBar } from "./components/RunBar";
import { RunsPage } from "./components/RunsPage";
import { ScorecardView } from "./components/ScorecardView";
import { TargetsPage } from "./components/TargetsPage";
import { TimelineDrawer } from "./components/TimelineDrawer";
import { Landing } from "./landing/Landing";
import { WalkthroughView } from "./walkthrough/WalkthroughView";
import { RunProvider, useRun } from "./state/RunContext";

type Tab = "grid" | "scorecard";

const CARD = "rounded-lg border border-line bg-panel";

export default function App() {
  return (
    <RunProvider>
      <Shell />
    </RunProvider>
  );
}

function Shell() {
  const { state, page, navigate } = useRun();
  const [tab, setTab] = useState<Tab>("grid");
  const [selectedAgent, setSelectedAgent] = useState<number | null>(null);
  const [lastAgent, setLastAgent] = useState<number | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [feedCollapsed, setFeedCollapsed] = useState(false);

  const selectAgent = (id: number | null) => {
    if (id !== null) setLastAgent(id);
    setSelectedAgent(id);
  };

  if (page.kind === "walkthrough") {
    return <WalkthroughView onExit={() => navigate({ kind: "landing" })} />;
  }

  if (page.kind === "landing") {
    return (
      <Landing
        onLaunch={() => navigate({ kind: "runs" })}
        onWatch={() => navigate({ kind: "walkthrough" })}
      />
    );
  }

  const drawerAgent = selectedAgent ?? lastAgent;
  const drawerOpen =
    selectedAgent !== null &&
    state.agents[selectedAgent] !== undefined &&
    page.kind === "live";

  const showSidebar = page.kind === "runs" || page.kind === "live";

  return (
    <div className="flex h-screen flex-col gap-2 bg-void p-2">
      <header
        className={`${CARD} flex items-center gap-4 px-4 py-2.5`}
        style={{ animation: "card-in 0.3s ease-out backwards" }}
      >
        {showSidebar && (
          <button
            type="button"
            onClick={() => setSidebarOpen(!sidebarOpen)}
            className="rounded-sm border border-line p-1.5 text-ink-dim transition-colors duration-150 hover:bg-raised hover:text-ink xl:hidden"
            title={sidebarOpen ? "Hide panel" : "Show panel"}
          >
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden>
              <path d="M2 4h12M2 8h12M2 12h12" />
            </svg>
          </button>
        )}

        <button
          type="button"
          onClick={() => navigate({ kind: "runs" })}
          className="flex items-center gap-3"
        >
          <span className="font-brand text-[32px] font-extrabold leading-none tracking-[0.22em] text-ink transition-all duration-200 hover:text-accent hover:[text-shadow:0_0_20px_color-mix(in_oklch,var(--color-accent)_50%,transparent)]">
            SABOTEUR
          </span>
          <span className="hidden rounded-sm border border-accent/50 bg-accent/10 px-2 py-1 text-[10px] font-bold leading-none tracking-[0.3em] text-accent sm:inline-block">
            CHAOS CONSOLE
          </span>
        </button>

        <nav className="ml-4 hidden items-center gap-1 sm:flex">
          <NavLink active={page.kind === "runs" || page.kind === "live"} onClick={() => navigate({ kind: "runs" })}>
            RUNS
          </NavLink>
          <NavLink active={page.kind === "targets"} onClick={() => navigate({ kind: "targets" })}>
            TARGETS
          </NavLink>
          <NavLink active={page.kind === "profiles"} onClick={() => navigate({ kind: "profiles" })}>
            PROFILES
          </NavLink>
          <NavLink active={page.kind === "compare"} onClick={() => navigate({ kind: "compare" })}>
            COMPARE
          </NavLink>
        </nav>

        <div className="ml-auto">
          <ConnectionBadge conn={state.conn} />
        </div>
      </header>

      <div className="relative flex min-h-0 flex-1 gap-2 overflow-hidden">
        {/* off-canvas sidebar on mobile, visible on xl; run views only */}
        {showSidebar && (
          <aside
            className={`absolute inset-y-0 left-0 z-40 w-80 shrink-0 flex-col gap-2 transition-transform xl:relative xl:flex xl:translate-x-0 ${
              sidebarOpen ? "translate-x-0 flex" : "-translate-x-full hidden"
            }`}
            style={{ animation: "card-in 0.3s ease-out 60ms backwards" }}
          >
            <div className={`${CARD} overflow-hidden max-xl:bg-panel/95 max-xl:backdrop-blur-md`}>
              <ControlPanel />
            </div>
            {page.kind === "live" && (
              <div
                className={`${CARD} flex min-h-0 flex-col overflow-hidden max-xl:bg-panel/95 max-xl:backdrop-blur-md ${
                  feedCollapsed ? "" : "flex-1"
                }`}
              >
                <ChaosLog
                  collapsed={feedCollapsed}
                  onToggle={() => setFeedCollapsed((c) => !c)}
                />
              </div>
            )}
          </aside>
        )}

        {showSidebar && sidebarOpen && (
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
          {page.kind === "runs" ? (
            <RunsPage />
          ) : page.kind === "targets" ? (
            <TargetsPage />
          ) : page.kind === "profiles" ? (
            <ProfileBuilder />
          ) : page.kind === "compare" ? (
            <ComparePage initialA={page.a} initialB={page.b} />
          ) : (
            <>
              <RunBar />

              <nav className="flex items-center gap-1 border-b border-line px-3 py-1.5">
                <TabButton active={tab === "grid"} onClick={() => setTab("grid")}>
                  COHORT
                </TabButton>
                <TabButton
                  active={tab === "scorecard"}
                  onClick={() => setTab("scorecard")}
                >
                  SCORECARD
                  {state.finished && tab !== "scorecard" && (
                    <span className="ml-1.5 inline-block h-1.5 w-1.5 rounded-full bg-accent align-middle" />
                  )}
                </TabButton>
                <div className="flex-1" />
                <button
                  type="button"
                  onClick={() => navigate({ kind: "runs" })}
                  className="rounded-sm border border-line px-2.5 py-1 text-xs font-medium text-ink-dim transition-colors duration-150 hover:bg-raised hover:text-ink"
                >
                  ← Runs
                </button>
              </nav>

              {/* key forces remount + fade animation on tab switch */}
              <div key={tab} className="animate-feed-in min-h-0 flex-1">
                {tab === "grid" ? (
                  <CohortGrid
                    selectedAgent={selectedAgent}
                    onSelect={selectAgent}
                  />
                ) : (
                  <ScorecardView />
                )}
              </div>

              <ReplayBar />
            </>
          )}
        </main>

        {/* transform slide keeps grid layout stable (no reflow); content stays mounted during close */}
        <div
          className={`absolute inset-y-0 right-0 z-30 w-[20.5rem] pl-2 xl:w-[23rem] max-sm:inset-0 max-sm:w-full max-sm:pl-0 transition-transform duration-[280ms] ease-[cubic-bezier(0.25,1,0.3,1)] will-change-transform ${
            drawerOpen ? "translate-x-0" : "translate-x-full pointer-events-none"
          }`}
        >
          <div className="h-full">
            {drawerAgent !== null && state.agents[drawerAgent] && page.kind === "live" && (
              <TimelineDrawer
                agentId={drawerAgent}
                onClose={() => setSelectedAgent(null)}
              />
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function NavLink({
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
      className={`rounded-sm px-2.5 py-1 text-[11px] font-bold uppercase tracking-[0.16em] transition-colors duration-150 ${
        active
          ? "bg-accent/10 text-accent"
          : "text-ink-faint hover:bg-raised hover:text-ink"
      }`}
    >
      {children}
    </button>
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
        active
          ? "text-ink"
          : "text-ink-faint hover:text-ink-dim"
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
