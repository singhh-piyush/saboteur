import React, { useEffect, useRef, useState } from "react";
import { Activity, Circle, CircleDashed, Flag, RefreshCw, X } from "lucide-react";

import type { AgentState } from "../state/reducer";
import { agentLabel } from "../lib/format";
import { faultStyle } from "../lib/faults";
import { BoltIcon, EyeIcon } from "./Icons";
import { Tooltip } from "./Tooltip";

const STATUS_COLOR: Record<AgentState["status"], string> = {
  pending: "var(--color-ink-faint)",
  healthy: "var(--color-ok)",
  recovering: "var(--color-warn)",
  crashed: "var(--color-crit)",
  succeeded: "var(--color-win)",
  done: "var(--color-ink-dim)",
};

const STATUS_WORD: Record<AgentState["status"], string> = {
  pending: "standby",
  healthy: "nominal",
  recovering: "recovering",
  crashed: "down",
  succeeded: "complete",
  done: "done",
};

const STATUS_EXPLAIN: Record<AgentState["status"], string> = {
  pending: "Waiting to start",
  healthy: "Running normally - no active fault",
  recovering: "Hit a fault and retrying/reformulating to self-heal",
  crashed: "Terminated with an unrecoverable error",
  succeeded: "Completed the task successfully (oracle verdict)",
  done: "Ran to completion - no success oracle to judge it",
};

interface Props {
  agent: AgentState;
  maxSteps: number;
  selected: boolean;
  onSelect: (id: number) => void;
  /** True during a tour seek (many cells change at once): the card CROSSFADES
   * from its old state to the new one (a fading ghost of the previous content)
   * instead of snapping, and the one-shot state-flash is suppressed (and its seq
   * change consumed, so it can't fire late). Default false = live behaviour:
   * instant update + a flash on each genuine step. */
  morphing?: boolean;
}

/** Memoized: only re-renders when its OWN derived state changes. */
export const AgentCell = React.memo(function AgentCellInner({ agent, maxSteps, selected, onSelect, morphing = false }: Props) {
  const color = STATUS_COLOR[agent.status];
  const pending = agent.status === "pending";

  // Flash only when seq advanced SINCE the last committed frame AND we are not
  // morphing. `lastFlashSeq` records the seq every commit (even while
  // suppressed), so a seek that jumps seq while morphing is consumed - it can't
  // fire late (the source of the flash on beat settle). Live play flashes once
  // per step.
  const lastFlashSeq = useRef(agent.seq);
  const doFlash = !morphing && agent.seq > 0 && agent.seq !== lastFlashSeq.current;
  useEffect(() => {
    lastFlashSeq.current = agent.seq;
  }, [agent.seq]);

  // Crossfade ghost: on a state change WHILE morphing, capture the previous
  // visible state as a fading-out overlay so the card dissolves old -> new (the
  // border/bg colour morphs underneath via the .agent-cell CSS transition). The
  // prevRef update is synchronous (not an effect) so the setState-during-render
  // guard can't loop. Live play (morphing false) never makes a ghost = instant.
  const prevRef = useRef<{ agent: AgentState; color: string }>({ agent, color });
  const ghostSeq = useRef(0);
  const [ghost, setGhost] = useState<{ agent: AgentState; color: string; key: number } | null>(null);
  if (prevRef.current.agent !== agent) {
    if (morphing) {
      ghostSeq.current += 1;
      setGhost({ agent: prevRef.current.agent, color: prevRef.current.color, key: ghostSeq.current });
    }
    prevRef.current = { agent, color };
  }
  useEffect(() => {
    if (!ghost) return;
    const t = window.setTimeout(() => setGhost(null), 470);
    return () => window.clearTimeout(t);
  }, [ghost]);

  const tip = [
    `${agentLabel(agent.id)} - ${STATUS_EXPLAIN[agent.status]}`,
    `step ${agent.step}/${maxSteps} · ${agent.faultCount} fault${agent.faultCount === 1 ? "" : "s"}`,
    "click to inspect trace",
  ].join("\n");

  return (
    <div
      className={`agent-cell-wrap ${selected ? "is-selected-wrap" : ""}`}
      style={{
        animationName: "card-in",
        animationDuration: "0.35s",
        animationTimingFunction: "ease-out",
        animationFillMode: "backwards",
        animationDelay: `${Math.min(agent.id, 24) * 15}ms`,
      }}
    >
      <Tooltip portal label={tip} side="top">
        <button
          type="button"
          onClick={() => onSelect(agent.id)}
          className={`agent-cell group relative flex w-full flex-col rounded-md border p-3 text-left ${selected ? "is-selected" : ""}`}
          style={{
            "--state": color,
            opacity: pending ? 0.55 : 1,
          } as React.CSSProperties}
        >
          {/* One-shot flash on a genuine (non-seek) state change */}
          {doFlash && (
            <span
              key={agent.seq}
              aria-hidden
              className="animate-state-flash pointer-events-none absolute inset-0 rounded-md"
              style={{ ["--ring" as string]: color }}
            />
          )}

          <CellBody agent={agent} maxSteps={maxSteps} color={color} selected={selected} />

          {/* Fading ghost of the previous state (crossfade during a tour seek). */}
          {ghost && (
            <div
              key={ghost.key}
              aria-hidden
              className="cell-ghost pointer-events-none absolute inset-0 flex flex-col p-3"
            >
              <CellBody agent={ghost.agent} maxSteps={maxSteps} color={ghost.color} selected={selected} />
            </div>
          )}
        </button>
      </Tooltip>
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

/** The cell's inner rows (header / step / pill / progress). Extracted so the
 * live content and the fading crossfade ghost render identically. */
function CellBody({
  agent,
  maxSteps,
  color,
  selected,
}: {
  agent: AgentState;
  maxSteps: number;
  color: string;
  selected: boolean;
}) {
  const progress =
    agent.status === "succeeded" || agent.status === "done"
      ? 1
      : Math.min(agent.step / maxSteps, 1);
  return (
    <>
      {/* Header: agent ID + status glyph (+ eye marker when inspected) */}
      <div className="flex items-start justify-between pt-0.5">
        <span className="text-sm font-semibold leading-none tracking-wide text-ink transition-colors duration-200 group-hover:text-white">
          {agentLabel(agent.id)}
        </span>
        <span className="flex items-center gap-1.5">
          {selected && <EyeIcon size={13} className="shrink-0 text-accent" />}
          <StatusGlyph status={agent.status} color={color} />
        </span>
      </div>

      {/* Middle: step counter + fault info */}
      <div className="mt-3 flex items-end justify-between">
        <div>
          <div className="text-[11px] font-semibold uppercase tracking-[0.14em] text-ink-dim">
            step
          </div>
          <div className="text-sm text-ink-dim">
            <span className="font-medium text-ink">{agent.step}</span>
            <span className="text-ink-faint">/{maxSteps}</span>
          </div>
        </div>
        <div className="flex items-center gap-1.5">
          {agent.activeFault !== null && (
            <span
              className="max-w-[72px] truncate text-[10px] font-medium"
              style={{ color: faultStyle(agent.activeFault).color }}
              title={faultStyle(agent.activeFault).description}
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
            >
              <BoltIcon size={10} />
              {agent.faultCount}
            </span>
          )}
        </div>
      </div>

      {/* Status pill */}
      <div className="mt-2">
        <span
          className="inline-flex items-center gap-1 rounded-sm px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-widest transition-colors duration-200"
          style={{
            color,
            background: `color-mix(in oklch, ${color} 13%, transparent)`,
          }}
        >
          {STATUS_WORD[agent.status]}
        </span>
      </div>

      {/* Progress footer: step progress tinted by state (symmetric) */}
      <div className="mt-2.5 h-[3px] w-full overflow-hidden rounded-full bg-line-strong">
        <div
          className="h-full rounded-full"
          style={{
            width: `${progress * 100}%`,
            background: color,
            transition: "width 300ms ease, background-color 200ms ease",
          }}
        />
      </div>
    </>
  );
}

/** Color + icon glyph - never color alone (accessibility). Same lucide icon set as
 * the landing cohort preview (HeroGrid). */
function StatusGlyph({
  status,
  color,
}: {
  status: AgentState["status"];
  color: string;
}) {
  const props = {
    size: 14,
    strokeWidth: 2,
    className: "shrink-0 transition-colors duration-200",
    style: { color },
  } as const;
  switch (status) {
    case "succeeded":
      return <Flag {...props} />;
    case "done":
      return <Circle {...props} />;
    case "crashed":
      return <X {...props} />;
    case "recovering":
      return <RefreshCw {...props} />;
    case "healthy":
      return <Activity {...props} />;
    case "pending":
    default:
      return <CircleDashed {...props} />;
  }
}
