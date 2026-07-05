import { useRun } from "../state/RunContext";
import { agentList } from "../state/selectors";
import { AgentCell } from "./AgentCell";

const MAX_STEPS = 15; // CLAUDE.md invariant #5 (display only)

interface Props {
  selectedAgent: number | null;
  onSelect: (id: number | null) => void;
  /** Forwarded to each cell: false suppresses the per-cell state-flash (the
   * walkthrough sets this false during a tour seek). Default true. */
  flash?: boolean;
}

const GRID_STYLE = { gridTemplateColumns: "repeat(auto-fill, minmax(190px, 1fr))" };

export function CohortGrid({ selectedAgent, onSelect, flash = true }: Props) {
  const { state, expectedAgents } = useRun();
  const agents = agentList(state);

  if (agents.length === 0) {
    if (state.conn === "live" || state.conn === "connecting") {
      // Skeleton mirrors the real card layout, sized to the launched cohort.
      return (
        <div className="grid h-full content-start gap-3 overflow-y-auto p-3" style={GRID_STYLE}>
          {Array.from({ length: expectedAgents ?? 8 }).map((_, i) => (
            <div
              key={i}
              className="flex h-[132px] w-full flex-col rounded-md border border-line bg-panel p-3 animate-pulse"
              style={{ animationDelay: `${Math.min(i, 24) * 40}ms` }}
            >
              {/* Header: label + glyph */}
              <div className="flex items-start justify-between pt-0.5">
                <div className="h-3.5 w-14 rounded bg-line-strong" />
                <div className="h-3 w-3 rounded-full bg-line-strong" />
              </div>
              {/* Step block */}
              <div className="mt-3">
                <div className="mb-1 h-2.5 w-8 rounded bg-line" />
                <div className="h-3.5 w-10 rounded bg-line-strong" />
              </div>
              {/* Status pill */}
              <div className="mt-2 h-[18px] w-16 rounded-sm bg-line" />
              {/* Progress track */}
              <div className="mt-2.5 h-[3px] w-full rounded-full bg-line-strong" />
            </div>
          ))}
        </div>
      );
    }

    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
        <div className="font-display text-2xl font-semibold tracking-widest text-ink-faint">
          NO ACTIVE COHORT
        </div>
        <p className="max-w-md text-sm text-ink-dim">
          Select a chaos profile and launch a run, or open an archived one from the Runs page.
        </p>
      </div>
    );
  }

  return (
    <div
      className={`grid h-full content-start gap-3 overflow-y-auto p-3 ${selectedAgent !== null ? "has-selection" : ""}`}
      style={GRID_STYLE}
    >
      {agents.map((agent) => (
        <AgentCell
          key={agent.id}
          agent={agent}
          maxSteps={MAX_STEPS}
          selected={selectedAgent === agent.id}
          onSelect={(id) => onSelect(selectedAgent === id ? null : id)}
          flash={flash}
        />
      ))}
    </div>
  );
}
