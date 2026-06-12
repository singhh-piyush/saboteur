import { useRun } from "../state/RunContext";
import { agentLabel, clockTime } from "../lib/format";
import { faultStyle } from "../lib/faults";
import { BoltIcon } from "./Icons";

export function ChaosLog() {
  const { state } = useRun();

  return (
    <section className="flex min-h-0 flex-1 flex-col">
      <header className="flex items-center justify-between border-b border-line px-3 py-2">
        <h2 className="font-display text-sm font-semibold tracking-[0.22em] text-ink-dim">
          CHAOS FEED
        </h2>
        <span className="text-[10px] tracking-[0.14em] text-ink-faint">
          {state.chaosLog.length} INJECTIONS
        </span>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-2 py-1.5">
        {state.chaosLog.length === 0 ? (
          <p className="px-1 py-2 text-xs text-ink-faint">
            No faults injected yet.
          </p>
        ) : (
          <ul className="space-y-px">
            {state.chaosLog.map((entry) => {
              const style = faultStyle(entry.fault);
              return (
                <li
                  key={entry.id}
                  className="animate-feed-in flex items-baseline gap-2 rounded-sm px-1 py-1 font-mono text-[11px] leading-tight hover:bg-raised"
                >
                  <span className="shrink-0 text-ink-faint">
                    {clockTime(entry.ts).slice(0, 8)}
                  </span>
                  <span className="shrink-0 text-ink-dim">
                    {agentLabel(entry.agentId)}
                  </span>
                  <span
                    className="inline-flex shrink-0 items-center gap-1 font-semibold"
                    style={{ color: style.color }}
                  >
                    <BoltIcon size={9} />
                    {entry.fault}
                  </span>
                  {entry.detail && (
                    <span className="truncate text-ink-faint">{entry.detail}</span>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </section>
  );
}
