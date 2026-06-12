import { useRun } from "../state/RunContext";
import { agentList } from "../state/selectors";
import { AgentCell } from "./AgentCell";

const MAX_STEPS = 15; // CLAUDE.md invariant #5 (display only)

interface Props {
  selectedAgent: number | null;
  onSelect: (id: number | null) => void;
}

export function BattleGrid({ selectedAgent, onSelect }: Props) {
  const { state } = useRun();
  const agents = agentList(state);

  if (agents.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 text-center">
        <div className="font-display text-2xl font-semibold tracking-[0.2em] text-ink-faint">
          NO ACTIVE COHORT
        </div>
        <p className="max-w-sm text-sm text-ink-dim">
          {state.conn === "live" || state.conn === "connecting"
            ? "Standing by — the calm-seas control cohort runs first; agents appear here when the chaos cohort launches."
            : "Select a chaos profile and launch a run, or replay an archived one."}
        </p>
      </div>
    );
  }

  return (
    <div
      className="grid content-start gap-2 overflow-y-auto p-1"
      style={{ gridTemplateColumns: "repeat(auto-fill, minmax(128px, 1fr))" }}
    >
      {agents.map((agent) => (
        <AgentCell
          key={agent.id}
          agent={agent}
          maxSteps={MAX_STEPS}
          selected={selectedAgent === agent.id}
          onSelect={(id) => onSelect(selectedAgent === id ? null : id)}
        />
      ))}
    </div>
  );
}
