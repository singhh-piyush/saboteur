import { useState } from "react";

import { BattleGrid } from "./components/BattleGrid";
import { ChaosLog } from "./components/ChaosLog";
import { ConnectionBadge } from "./components/ConnectionBadge";
import { ControlPanel } from "./components/ControlPanel";
import { ReplayBar } from "./components/ReplayBar";
import { RunsPage } from "./components/RunsPage";
import { ScorecardView } from "./components/ScorecardView";
import { TimelineDrawer } from "./components/TimelineDrawer";
import { RunProvider, useRun } from "./state/RunContext";
import { runCounts } from "./state/selectors";

type Tab = "grid" | "scorecard";

export default function App() {
  return (
    <RunProvider>
      <Shell />
    </RunProvider>
  );
}

function Shell() {
  const { state, activeRunId, page, navigate } = useRun();
  const [tab, setTab] = useState<Tab>("grid");
  const [selectedAgent, setSelectedAgent] = useState<number | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const counts = runCounts(state);

  return (
    <div className="flex h-screen flex-col">
      {/* ---------------------------------------------------------------- */}
      <header className="flex items-center gap-4 border-b border-line bg-panel px-4 py-2.5">
        <button
          type="button"
          onClick={() => navigate({ kind: "runs" })}
          className="font-display text-2xl font-bold leading-none tracking-[0.18em] hover:text-accent transition-colors"
        >
          SABOTEUR
          <span className="ml-2 align-middle text-[11px] font-semibold tracking-[0.3em] text-accent">
            CHAOS CONSOLE
          </span>
        </button>

        {page.kind === "live" && (
          <>
            <div className="min-w-0 flex-1 truncate text-center font-mono text-xs text-ink-faint">
              {activeRunId ?? ""}
              {state.profile && (
                <span className="ml-2 text-ink-dim">
                  {state.profile}
                  {state.seed !== null && ` · seed ${state.seed}`}
                </span>
              )}
            </div>

            {counts.total > 0 && (
              <div className="hidden items-center gap-3 text-sm sm:flex">
                <Count label="nominal" value={counts.healthy} className="text-ok" />
                <Count label="recovering" value={counts.recovering} className="text-warn" />
                <Count label="down" value={counts.crashed} className="text-crit" />
                <Count label="complete" value={counts.succeeded} className="text-win" />
              </div>
            )}

            {/* Sidebar toggle for tablet/mobile */}
            <button
              type="button"
              onClick={() => setSidebarOpen(!sidebarOpen)}
              className="rounded-sm border border-line p-1.5 text-ink-dim hover:bg-raised hover:text-ink xl:hidden"
              title={sidebarOpen ? "Hide panel" : "Show panel"}
            >
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden>
                <path d="M2 4h12M2 8h12M2 12h12" />
              </svg>
            </button>
          </>
        )}

        <div className="ml-auto">
          <ConnectionBadge conn={state.conn} />
        </div>
      </header>

      {/* ---------------------------------------------------------------- */}
      {page.kind === "runs" ? (
        <div className="min-h-0 flex-1">
          <RunsPage />
        </div>
      ) : (
        <div className="flex min-h-0 flex-1">
          {/* Sidebar — hidden on mobile, collapsible on tablet */}
          {sidebarOpen && (
            <aside className="hidden w-80 shrink-0 flex-col border-r border-line bg-panel/60 xl:flex">
              <ControlPanel />
              <ChaosLog />
            </aside>
          )}

          <main className="flex min-w-0 flex-1 flex-col">
            <nav className="flex items-center gap-1 border-b border-line px-3 py-1.5">
              <TabButton active={tab === "grid"} onClick={() => setTab("grid")}>
                BATTLE GRID
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
                className="rounded-sm border border-line px-2.5 py-1 text-xs font-medium text-ink-dim hover:bg-raised hover:text-ink"
              >
                ← Runs
              </button>
            </nav>

            <div className="min-h-0 flex-1">
              {tab === "grid" ? (
                <BattleGrid
                  selectedAgent={selectedAgent}
                  onSelect={setSelectedAgent}
                />
              ) : (
                <ScorecardView />
              )}
            </div>

            <ReplayBar />
          </main>

          {/* Timeline drawer — full-screen sheet on mobile */}
          {selectedAgent !== null && state.agents[selectedAgent] && (
            <TimelineDrawer
              agentId={selectedAgent}
              onClose={() => setSelectedAgent(null)}
            />
          )}
        </div>
      )}
    </div>
  );
}

function Count({
  label,
  value,
  className,
}: {
  label: string;
  value: number;
  className: string;
}) {
  return (
    <span className="flex items-baseline gap-1" title={label}>
      <span className={`font-display text-lg font-bold leading-none ${className}`}>
        {value}
      </span>
      <span className="text-xs uppercase tracking-widest text-ink-faint">
        {label}
      </span>
    </span>
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
      className={`font-display rounded-sm px-3 py-1 text-xs font-semibold tracking-widest transition-colors ${
        active
          ? "bg-raised text-ink"
          : "text-ink-faint hover:bg-raised/60 hover:text-ink-dim"
      }`}
    >
      {children}
    </button>
  );
}
