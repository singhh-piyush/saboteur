import React from "react";

import type { AgentState } from "../state/reducer";
import { agentLabel } from "../lib/format";
import { faultStyle } from "../lib/faults";
import { BoltIcon, CircleIcon, CrossIcon, DashedCircleIcon, FlagIcon, LoopIcon } from "./Icons";

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

/** Memoized: only re-renders when its OWN derived state changes. */
export const AgentCell = React.memo(function AgentCellInner({ agent, maxSteps, selected, onSelect }: Props) {
  const color = STATUS_COLOR[agent.status];
  const pending = agent.status === "pending";

  return (
    <div className="agent-cell-wrap">
      <button
        type="button"
        onClick={() => onSelect(agent.id)}
        className={`agent-cell group relative flex w-full flex-col justify-between rounded-md border bg-panel p-3 text-left hover:bg-raised ${
          selected ? "border-line-strong" : "border-line"
        }`}
        style={{
          borderLeftWidth: 3,
          borderLeftColor: color,
          opacity: pending ? 0.55 : 1,
        }}
      >
        {/* One-shot flash on state change — CSS animation, not remount */}
        {agent.seq > 0 && (
          <span
            key={agent.seq}
            aria-hidden
            className="animate-state-flash pointer-events-none absolute inset-0 rounded-md"
            style={{ ["--ring" as string]: color }}
          />
        )}

        <div className="flex items-start justify-between">
          <span className="font-display text-base font-semibold leading-none tracking-wide">
            {agentLabel(agent.id)}
          </span>
          <StatusGlyph status={agent.status} color={color} />
        </div>

        <div className="mt-3 flex items-end justify-between">
          <div>
            <div className="text-xs uppercase tracking-widest text-ink-faint">
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
                className="max-w-20 truncate text-xs"
                style={{ color: faultStyle(agent.activeFault).color }}
              >
                {agent.activeFault}
              </span>
            )}
            {agent.faultCount > 0 && (
              <span
                className="inline-flex items-center gap-0.5 rounded-sm px-1 py-0.5 text-xs font-semibold"
                style={{
                  color: "var(--color-accent)",
                  background: "oklch(70% 0.19 45 / 12%)",
                }}
                title={`${agent.faultCount} fault(s) injected`}
              >
                <BoltIcon size={10} />
                {agent.faultCount}
              </span>
            )}
          </div>
        </div>

        <div
          className="mt-1.5 text-xs uppercase tracking-widest"
          style={{ color }}
        >
          {STATUS_WORD[agent.status]}
        </div>
      </button>
    </div>
  );
}, (prev, next) =>
  prev.agent.seq === next.agent.seq &&
  prev.agent.status === next.agent.status &&
  prev.agent.step === next.agent.step &&
  prev.agent.faultCount === next.agent.faultCount &&
  prev.agent.activeFault === next.agent.activeFault &&
  prev.selected === next.selected
);

/** Color + icon glyph — never color alone (accessibility). */
function StatusGlyph({
  status,
  color,
}: {
  status: AgentState["status"];
  color: string;
}) {
  switch (status) {
    case "succeeded":
      return <FlagIcon size={14} className="shrink-0" style={{ color }} />;
    case "crashed":
      return <CrossIcon size={13} className="shrink-0" style={{ color }} />;
    case "recovering":
      return <LoopIcon size={13} className="shrink-0" style={{ color }} />;
    case "healthy":
      return <CircleIcon size={12} className="shrink-0" style={{ color }} />;
    case "pending":
    default:
      return <DashedCircleIcon size={12} className="shrink-0" style={{ color }} />;
  }
}
