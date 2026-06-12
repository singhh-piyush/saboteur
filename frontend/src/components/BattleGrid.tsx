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
      <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
        <div className="font-display text-2xl font-semibold tracking-widest text-ink-faint">
          NO ACTIVE COHORT
        </div>
        <p className="max-w-md text-sm text-ink-dim">
          {state.conn === "live" || state.conn === "connecting"
            ? "Standing by — the calm-seas control cohort runs first; agents appear here when the chaos cohort launches."
            : "Select a chaos profile and launch a run, or open an archived one from the Runs page."}
        </p>
      </div>
    );
  }

  return (
    <div
      className="grid content-start gap-2.5 overflow-y-auto p-3"
      style={{ gridTemplateColumns: "repeat(auto-fill, minmax(180px, 1fr))" }}
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
