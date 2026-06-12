import { useState } from "react";

import { Archive } from "./components/Archive";
import { BattleGrid } from "./components/BattleGrid";
import { ChaosLog } from "./components/ChaosLog";
import { ConnectionBadge } from "./components/ConnectionBadge";
import { ControlPanel } from "./components/ControlPanel";
import { ReplayBar } from "./components/ReplayBar";
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
  const { state, activeRunId } = useRun();
  const [tab, setTab] = useState<Tab>("grid");
  const [selectedAgent, setSelectedAgent] = useState<number | null>(null);
  const counts = runCounts(state);

  return (
    <div className="flex h-screen flex-col">
      {/* ---------------------------------------------------------------- */}
      <header className="flex items-center gap-4 border-b border-line bg-panel px-4 py-2.5">
        <h1 className="font-display text-2xl font-bold leading-none tracking-[0.18em]">
          SABOTEUR
          <span className="ml-2 align-middle text-[10px] font-semibold tracking-[0.3em] text-accent">
            AGENT CHAOS CONSOLE
          </span>
        </h1>

        <div className="min-w-0 flex-1 truncate text-center font-mono text-[11px] text-ink-faint">
          {activeRunId ?? ""}
          {state.profile && (
            <span className="ml-2 text-ink-dim">
              {state.profile}
              {state.seed !== null && ` · seed ${state.seed}`}
            </span>
          )}
        </div>

        {counts.total > 0 && (
          <div className="flex items-center gap-3 text-xs">
            <Count label="nominal" value={counts.healthy} className="text-ok" />
            <Count label="recovering" value={counts.recovering} className="text-warn" />
            <Count label="down" value={counts.crashed} className="text-crit" />
            <Count label="complete" value={counts.succeeded} className="text-win" />
          </div>
        )}

        <ConnectionBadge conn={state.conn} />
      </header>

      {/* ---------------------------------------------------------------- */}
      <div className="flex min-h-0 flex-1">
        <aside className="flex w-80 shrink-0 flex-col border-r border-line bg-panel/60">
          <ControlPanel />
          <Archive />
          <ChaosLog />
        </aside>

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

        {selectedAgent !== null && state.agents[selectedAgent] && (
          <TimelineDrawer
            agentId={selectedAgent}
            onClose={() => setSelectedAgent(null)}
          />
        )}
      </div>
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
      <span className="text-[9px] uppercase tracking-[0.14em] text-ink-faint">
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
      className={`font-display rounded-sm px-3 py-1 text-xs font-semibold tracking-[0.22em] transition-colors ${
        active
          ? "bg-raised text-ink"
          : "text-ink-faint hover:bg-raised/60 hover:text-ink-dim"
      }`}
    >
      {children}
    </button>
  );
}
