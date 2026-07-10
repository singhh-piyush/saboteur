import { useRun } from "../state/RunContext";
import { agentLabel, clockTime } from "../lib/format";
import { faultStyle } from "../lib/faults";
import { BoltIcon } from "./Icons";
import { PanelHeader } from "./PanelHeader";

interface Props {
  collapsed: boolean;
  onToggle: () => void;
}

export function ChaosLog({ collapsed, onToggle }: Props) {
  const { state } = useRun();

  return (
    <section className="flex min-h-0 flex-1 flex-col">
      <PanelHeader
        title="CHAOS FEED"
        collapsed={collapsed}
        onToggle={onToggle}
        right={
          <span className="text-xs font-medium tracking-widest text-ink-faint">
            {state.faultCount} INJECTIONS
          </span>
        }
      />

      {/* smooth collapse via grid-rows: 1fr ↔ 0fr */}
      <div
        className="grid min-h-0 flex-1 transition-[grid-template-rows] duration-[250ms] ease-out"
        style={{ gridTemplateRows: collapsed ? "0fr" : "1fr" }}
      >
        <div className="min-h-0 overflow-hidden">
          <div className="h-full overflow-y-auto px-2 py-1.5">
            {state.chaosLog.length === 0 ? (
              <p className="px-1 py-2 text-sm text-ink-faint">
                No faults injected yet.
              </p>
            ) : (
              <ul className="space-y-px">
                {state.chaosLog.map((entry) => {
                  const style = faultStyle(entry.fault);
                  return (
                    <li
                      key={entry.id}
                      className="animate-feed-in flex items-baseline gap-2 rounded-sm px-1 py-1 font-mono text-xs leading-tight hover:bg-raised"
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
                        <BoltIcon size={10} />
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
        </div>
      </div>
    </section>
  );
}
