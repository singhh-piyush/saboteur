import { useMemo } from "react";

import { agentLabel, clockTime, compactArgs, num } from "../lib/format";
import { faultStyle } from "../lib/faults";
import { useRun } from "../state/RunContext";
import type { TelemetryEvent } from "../types/telemetry";
import { BoltIcon, CrossIcon, FlagIcon, LoopIcon } from "./Icons";

interface Props {
  agentId: number;
  onClose: () => void;
}

export function TimelineDrawer({ agentId, onClose }: Props) {
  const { state } = useRun();
  const agent = state.agents[agentId];

  const entries = useMemo(
    () =>
      (agent?.events ?? []).filter(
        (ev) =>
          ev.event === "tool_call" ||
          ev.event === "fault_injected" ||
          ev.event === "recovery_action" ||
          ev.event === "agent_done" ||
          ev.event === "agent_crashed",
      ),
    [agent?.events],
  );

  if (!agent) return null;

  return (
    <aside className="flex h-full w-80 shrink-0 flex-col border-l border-line bg-panel max-sm:fixed max-sm:inset-0 max-sm:z-40 max-sm:w-full xl:w-90">
      <header className="flex items-center justify-between border-b border-line px-3 py-2">
        <h2 className="font-display text-sm font-semibold tracking-widest text-ink-dim">
          {agentLabel(agent.id)} TRACE
        </h2>
        <button
          type="button"
          onClick={onClose}
          className="rounded-sm border border-line px-2 py-0.5 text-xs tracking-widest text-ink-faint hover:bg-raised hover:text-ink"
        >
          CLOSE
        </button>
      </header>

      <div className="flex items-center gap-4 border-b border-line px-3 py-2 text-sm text-ink-dim">
        <span>
          step <span className="text-ink">{agent.step}</span>
        </span>
        <span>
          faults <span className="text-accent">{agent.faultCount}</span>
        </span>
        <span>
          recoveries <span className="text-ok">{agent.recoveryCount}</span>
        </span>
        {agent.tokensUsed !== null && (
          <span>
            tokens <span className="text-ink">{agent.tokensUsed}</span>
          </span>
        )}
      </div>

      <ol className="min-h-0 flex-1 space-y-1 overflow-y-auto p-3">
        {entries.length === 0 && (
          <p className="text-sm text-ink-faint">No activity yet.</p>
        )}
        {entries.map((ev, i) => (
          <TimelineEntry key={i} ev={ev} />
        ))}
      </ol>
    </aside>
  );
}

function TimelineEntry({ ev }: { ev: TelemetryEvent }) {
  const meta = (
    <span className="shrink-0 pt-0.5 text-xs text-ink-faint">
      {ev.step !== null && (
        <span className="mr-1.5 text-ink-dim">S{ev.step}</span>
      )}
      {clockTime(ev.ts).slice(0, 12)}
      {ev.latency_ms !== null && (
        <span className="ml-1.5">{num(ev.latency_ms / 1000, 1)}s</span>
      )}
    </span>
  );

  switch (ev.event) {
    case "tool_call": {
      const tool = String(ev.payload["tool"] ?? "?");
      const args = compactArgs(ev.payload["arguments"]);
      const errored = ev.payload["errored"] === true;
      const sabotaged = ev.payload["sabotaged"] === true;
      return (
        <li className="rounded-sm border border-line bg-void/40 px-2 py-1.5">
          <div className="flex items-baseline justify-between gap-2">
            <span
              className={`text-sm font-semibold ${errored ? "text-crit" : "text-ink"}`}
            >
              {tool}
              {sabotaged && (
                <span className="ml-1.5 text-xs font-medium text-accent">
                  SABOTAGED
                </span>
              )}
            </span>
            {meta}
          </div>
          {args && (
            <div className="mt-0.5 truncate font-mono text-xs text-ink-faint">
              {args}
            </div>
          )}
        </li>
      );
    }

    case "fault_injected": {
      const fault = ev.fault ?? "unknown";
      const color = faultStyle(fault).color;
      return (
        <li
          className="rounded-sm border px-2 py-1.5"
          style={{
            borderColor: `color-mix(in oklch, ${color} 35%, transparent)`,
            background: `color-mix(in oklch, ${color} 7%, transparent)`,
          }}
        >
          <div className="flex items-baseline justify-between gap-2">
            <span
              className="inline-flex items-center gap-1.5 text-sm font-semibold"
              style={{ color }}
            >
              <BoltIcon size={12} />
              FAULT — {fault}
            </span>
            {meta}
          </div>
        </li>
      );
    }

    case "recovery_action": {
      const kind = ev.recovery ?? "unknown";
      const after = ev.payload["after_fault"];
      return (
        <li className="rounded-sm border border-ok/30 bg-ok/5 px-2 py-1.5">
          <div className="flex items-baseline justify-between gap-2">
            <span className="inline-flex items-center gap-1.5 text-sm font-semibold text-ok">
              <LoopIcon size={12} />
              RECOVERY — {kind}
            </span>
            {meta}
          </div>
          {typeof after === "string" && after && (
            <div className="mt-0.5 text-xs text-ink-faint">
              after {after}
            </div>
          )}
        </li>
      );
    }

    case "agent_done":
    case "agent_crashed": {
      const success =
        ev.event === "agent_done" && ev.payload["success"] === true;
      const outcome =
        ev.event === "agent_crashed"
          ? "hard_exception"
          : String(ev.payload["outcome"] ?? "?");
      return (
        <li
          className={`rounded-sm border px-2 py-1.5 ${
            success ? "border-win/40 bg-win/5" : "border-crit/40 bg-crit/5"
          }`}
        >
          <div className="flex items-baseline justify-between gap-2">
            <span
              className={`inline-flex items-center gap-1.5 text-sm font-bold ${
                success ? "text-win" : "text-crit"
              }`}
            >
              {success ? <FlagIcon size={12} /> : <CrossIcon size={12} />}
              {success ? "TASK COMPLETE" : `TERMINAL — ${outcome}`}
            </span>
            {meta}
          </div>
        </li>
      );
    }

    default:
      return null;
  }
}
