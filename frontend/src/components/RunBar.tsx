import { cancelRun } from "../lib/api";
import { useRun } from "../state/RunContext";
import { runCounts } from "../state/selectors";
import { Tooltip } from "./Tooltip";

const COUNT_TIP: Record<string, string> = {
  nominal: "Agents running normally - no active fault",
  recovering: "Agents that hit a fault and are retrying/replanning to self-heal",
  down: "Agents that crashed with an unrecoverable error",
  complete: "Agents an oracle judged a success",
  done: "Agents that ran to completion but had no success oracle to judge them",
};

/**
 * Run context bar at the top of the main card (live page only).
 * Holds everything that used to crowd the app header: run identity,
 * live survival ticker, per-state counts, and STOP RUN.
 */
export function RunBar() {
  const { state, activeRunId } = useRun();
  const counts = runCounts(state);

  // Only show a survival % when at least one agent carries a real oracle verdict.
  // A no-oracle run (success===null) has no survival rate - show "-", never a
  // fabricated 0% or 100% (honesty, invariant #4; matches the scorecard's null).
  const hasVerdict = Object.values(state.agents).some((a) => a.success !== null);
  const survival = hasVerdict ? (counts.succeeded / counts.total) * 100 : null;

  return (
    <div className="animate-feed-in flex flex-wrap items-center gap-x-4 gap-y-1.5 border-b border-line px-3 py-2">
      {/* Run identity */}
      <div className="flex min-w-0 items-baseline gap-2">
        {state.profile && (
          <span className="text-sm font-semibold text-ink">{state.profile}</span>
        )}
        {state.seed !== null && (
          <span className="text-xs font-medium text-ink-dim">seed {state.seed}</span>
        )}
        {activeRunId && (
          <span className="hidden max-w-56 truncate font-mono text-xs text-ink-faint lg:inline">
            {activeRunId}
          </span>
        )}
      </div>

      <div className="flex-1" />

      {/* Live survival ticker */}
      {counts.total > 0 && (
        <Tooltip
          portal
          side="bottom"
          label={"Live survival rate - agents that completed the task, out of the whole cohort\n(shows - until the first agent finishes)"}
          className="inline-flex"
        >
          <span className="flex cursor-default items-baseline gap-1.5">
            <span className="text-[11px] font-semibold uppercase tracking-[0.14em] text-ink-dim">
              survival
            </span>
            <span className="text-base font-bold leading-none text-win transition-colors duration-200">
              {survival === null ? "-" : `${survival.toFixed(0)}%`}
            </span>
          </span>
        </Tooltip>
      )}

      {/* Per-state counts */}
      {counts.total > 0 && (
        <div className="hidden items-center gap-3 text-sm md:flex">
          <Count label="nominal" value={counts.healthy} className="text-ok" />
          <Count label="recovering" value={counts.recovering} className="text-warn" />
          <Count label="down" value={counts.crashed} className="text-crit" />
          <Count label="complete" value={counts.succeeded} className="text-win" />
          {counts.done > 0 && (
            <Count label="done" value={counts.done} className="text-ink-dim" />
          )}
        </div>
      )}

      {/* Stop */}
      {!state.finished && activeRunId && (
        <button
          type="button"
          onClick={() => {
            if (confirm("Are you sure you want to stop this run?")) {
              cancelRun(activeRunId).catch((err) => alert(String(err)));
            }
          }}
          className="rounded-sm border border-crit/40 bg-crit/10 px-3 py-1 text-xs font-bold tracking-widest text-crit transition-colors duration-150 hover:bg-crit/20"
        >
          STOP RUN
        </button>
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
    <Tooltip portal side="bottom" label={COUNT_TIP[label] ?? label} className="inline-flex">
      <span className="flex cursor-default items-baseline gap-1">
        <span className={`text-base font-bold leading-none transition-colors duration-200 ${className}`}>
          {value}
        </span>
        <span className="text-[11px] font-medium uppercase tracking-[0.14em] text-ink-dim">
          {label}
        </span>
      </span>
    </Tooltip>
  );
}
