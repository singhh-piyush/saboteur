import { useMemo } from "react";

import { agentLabel, clockTime, compactArgs, num } from "../lib/format";
import { faultStyle } from "../lib/faults";
import { useRun } from "../state/RunContext";
import type { TelemetryEvent } from "../types/telemetry";
import { BoltIcon, CrossIcon, FlagIcon, LoopIcon } from "./Icons";
import { PanelHeader } from "./PanelHeader";
import { Tooltip } from "./Tooltip";

const RECOVERY_TIP: Record<string, string> = {
  retry: "Repeated the same tool call after a fault",
  backoff: "Waited (respecting Retry-After) before retrying",
  fallback_tool: "Switched to an alternative tool after the primary failed",
  replan: "Changed approach/arguments after a fault",
  gave_up: "Stopped attempting recovery for this fault",
};

const OUTCOME_TIP: Record<string, string> = {
  completed: "Agent finished its run loop",
  infinite_retry: "Hit the step cap while repeating the same failing call",
  hard_exception: "Crashed with an unhandled exception",
  timeout: "Exceeded the per-agent wall-clock limit",
  silent_abandonment: "Stopped working on the task without filing a report",
};

interface Props {
  agentId: number;
  /** Drives the mobile slide-in; desktop width is animated by the parent wrapper. */
  open: boolean;
  onClose: () => void;
}

export function TimelineDrawer({ agentId, open, onClose }: Props) {
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
    <aside
      className={`flex h-full w-80 shrink-0 flex-col rounded-lg border border-line bg-panel max-sm:fixed max-sm:inset-0 max-sm:z-40 max-sm:w-full max-sm:rounded-none max-sm:transition-transform max-sm:duration-[280ms] max-sm:ease-out xl:w-90 ${
        open ? "max-sm:translate-x-0" : "max-sm:translate-x-full"
      }`}
    >
      <PanelHeader
        title={`${agentLabel(agent.id)} TRACE`}
        right={
          <button
            type="button"
            onClick={onClose}
            className="rounded-sm border border-line px-2 py-0.5 text-xs tracking-widest text-ink-faint transition-colors duration-150 hover:bg-raised hover:text-ink"
          >
            CLOSE
          </button>
        }
      />

      <div className="flex items-center gap-4 border-b border-line px-3 py-2 text-sm font-medium text-ink-dim">
        <Tooltip portal side="bottom" label="Current step of this agent's run (capped at 15)" className="inline-flex">
          <span className="cursor-default">
            step <span className="text-ink">{agent.step}</span>
          </span>
        </Tooltip>
        <Tooltip portal side="bottom" label="Faults the chaos engine injected into this agent" className="inline-flex">
          <span className="cursor-default">
            faults <span className="text-accent">{agent.faultCount}</span>
          </span>
        </Tooltip>
        <Tooltip portal side="bottom" label="Recovery actions detected (retry, backoff, fallback tool, replan)" className="inline-flex">
          <span className="cursor-default">
            recoveries <span className="text-ok">{agent.recoveryCount}</span>
          </span>
        </Tooltip>
        {agent.tokensUsed !== null && (
          <Tooltip portal side="bottom" label="Total LLM tokens this agent consumed" className="inline-flex">
            <span className="cursor-default">
              tokens <span className="text-ink">{agent.tokensUsed}</span>
            </span>
          </Tooltip>
        )}
      </div>

      {/* key={agentId}: re-run the feed-in entrance when switching agents */}
      <ol key={agentId} className="animate-feed-in min-h-0 flex-1 space-y-1 overflow-y-auto p-3">
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
            <Tooltip
              portal
              side="bottom"
              label={
                errored
                  ? `Tool call that returned an error - the agent must handle it`
                  : `Tool the agent invoked at this step`
              }
              className="inline-flex min-w-0"
            >
              <span
                className={`cursor-default text-sm font-semibold ${errored ? "text-crit" : "text-ink"}`}
              >
                {tool}
                {sabotaged && (
                  <span
                    className="ml-1.5 text-xs font-medium text-accent"
                    title="This call was intercepted by the chaos engine"
                  >
                    SABOTAGED
                  </span>
                )}
              </span>
            </Tooltip>
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
            <Tooltip
              portal
              side="bottom"
              label={`${faultStyle(fault).layer.toUpperCase()} LAYER\n${faultStyle(fault).description}`}
              className="inline-flex"
            >
              <span
                className="inline-flex cursor-default items-center gap-1.5 text-sm font-semibold"
                style={{ color }}
              >
                <BoltIcon size={12} />
                FAULT - {fault}
              </span>
            </Tooltip>
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
            <Tooltip
              portal
              side="bottom"
              label={RECOVERY_TIP[kind] ?? "Recovery action detected after a fault"}
              className="inline-flex"
            >
              <span className="inline-flex cursor-default items-center gap-1.5 text-sm font-semibold text-ok">
                <LoopIcon size={12} />
                RECOVERY - {kind}
              </span>
            </Tooltip>
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
            <Tooltip
              portal
              side="top"
              label={
                success
                  ? "Agent finished AND the verifier confirmed the filed report is correct"
                  : OUTCOME_TIP[outcome] ?? "Agent ended without completing the task"
              }
              className="inline-flex"
            >
              <span
                className={`inline-flex cursor-default items-center gap-1.5 text-sm font-bold ${
                  success ? "text-win" : "text-crit"
                }`}
              >
                {success ? <FlagIcon size={12} /> : <CrossIcon size={12} />}
                {success ? "TASK COMPLETE" : `TERMINAL - ${outcome}`}
              </span>
            </Tooltip>
            {meta}
          </div>
        </li>
      );
    }

    default:
      return null;
  }
}
