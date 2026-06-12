import type { AgentState } from "../state/reducer";
import { agentLabel } from "../lib/format";
import { faultStyle } from "../lib/faults";
import { BoltIcon, CrossIcon, FlagIcon } from "./Icons";

const STATUS_COLOR: Record<AgentState["status"], string> = {
  pending: "var(--color-ink-faint)",
  healthy: "var(--color-ok)",
  recovering: "var(--color-warn)",
  crashed: "var(--color-crit)",
  succeeded: "var(--color-win)",
};

const STATUS_WORD: Record<AgentState["status"], string> = {
  pending: "standby",
  healthy: "nominal",
  recovering: "recovering",
  crashed: "down",
  succeeded: "complete",
};

interface Props {
  agent: AgentState;
  maxSteps: number;
  selected: boolean;
  onSelect: (id: number) => void;
}

export function AgentCell({ agent, maxSteps, selected, onSelect }: Props) {
  const color = STATUS_COLOR[agent.status];
  const pending = agent.status === "pending";

  return (
    <button
      type="button"
      onClick={() => onSelect(agent.id)}
      className={`group relative flex flex-col justify-between rounded-md border bg-panel p-2.5 text-left transition-colors duration-300 hover:bg-raised ${
        selected ? "border-line-strong" : "border-line"
      }`}
      style={{
        borderLeftWidth: 3,
        borderLeftColor: color,
        opacity: pending ? 0.55 : 1,
      }}
    >
      {/* Pulse overlay: keyed on seq so every state change re-mounts it and
          restarts the expanding-ring animation — the grid's heartbeat. */}
      {agent.seq > 0 && (
        <span
          key={agent.seq}
          aria-hidden
          className="animate-pulse-ring pointer-events-none absolute inset-0 rounded-md"
          style={{ ["--ring" as string]: color }}
        />
      )}

      <div className="flex items-start justify-between">
        <span className="font-display text-lg font-semibold leading-none tracking-wide">
          {agentLabel(agent.id)}
        </span>
        <StatusGlyph status={agent.status} color={color} />
      </div>

      <div className="mt-3 flex items-end justify-between">
        <div>
          <div className="text-[10px] uppercase tracking-[0.14em] text-ink-faint">
            step
          </div>
          <div className="text-sm text-ink-dim">
            <span className="text-ink">{agent.step}</span>
            <span className="text-ink-faint">/{maxSteps}</span>
          </div>
        </div>
        <div className="flex items-center gap-1.5">
          {agent.activeFault !== null && (
            <span
              className="max-w-20 truncate text-[10px]"
              style={{ color: faultStyle(agent.activeFault).color }}
            >
              {agent.activeFault}
            </span>
          )}
          {agent.faultCount > 0 && (
            <span
              className="inline-flex items-center gap-0.5 rounded-sm px-1 py-0.5 text-[10px] font-semibold"
              style={{
                color: "var(--color-accent)",
                background: "oklch(70% 0.19 45 / 12%)",
              }}
              title={`${agent.faultCount} fault(s) injected`}
            >
              <BoltIcon size={9} />
              {agent.faultCount}
            </span>
          )}
        </div>
      </div>

      <div
        className="mt-1.5 text-[10px] uppercase tracking-[0.16em]"
        style={{ color }}
      >
        {STATUS_WORD[agent.status]}
      </div>
    </button>
  );
}

function StatusGlyph({
  status,
  color,
}: {
  status: AgentState["status"];
  color: string;
}) {
  if (status === "succeeded")
    return <FlagIcon size={13} className="shrink-0" style={{ color }} />;
  if (status === "crashed")
    return <CrossIcon size={12} className="shrink-0" style={{ color }} />;
  return (
    <span
      className={`mt-0.5 h-2 w-2 shrink-0 rounded-full ${
        status === "healthy" || status === "recovering" ? "animate-breathe" : ""
      }`}
      style={{ background: color }}
    />
  );
}
