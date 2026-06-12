import { useCallback, useEffect, useState } from "react";

import { fetchAllEvents, fetchRunList, type RunListEntry } from "../lib/api";
import { useRun } from "../state/RunContext";

/** Archived & in-flight runs: watch a live one or replay a finished one. */
export function Archive() {
  const { startReplay, watchRun, activeRunId } = useRun();
  const [runs, setRuns] = useState<RunListEntry[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(() => {
    fetchRunList()
      .then(setRuns)
      .catch(() => setRuns([]));
  }, []);

  useEffect(() => {
    refresh();
    const id = setInterval(refresh, 10_000);
    return () => clearInterval(id);
  }, [refresh]);

  async function replay(runId: string) {
    setBusy(runId);
    setError(null);
    try {
      const events = await fetchAllEvents(runId);
      startReplay(runId, events);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className="border-b border-line">
      <header className="flex items-center justify-between border-b border-line px-3 py-2">
        <h2 className="font-display text-sm font-semibold tracking-[0.22em] text-ink-dim">
          RUN ARCHIVE
        </h2>
        <button
          type="button"
          onClick={refresh}
          className="text-[10px] tracking-[0.14em] text-ink-faint hover:text-ink"
        >
          REFRESH
        </button>
      </header>

      <div className="max-h-44 overflow-y-auto px-2 py-1.5">
        {runs.length === 0 ? (
          <p className="px-1 py-1.5 text-xs text-ink-faint">No runs yet.</p>
        ) : (
          <ul className="space-y-1">
            {runs.map((run) => {
              const live = run.status === "running" || run.status === "pending";
              const active = run.run_id === activeRunId;
              return (
                <li
                  key={run.run_id}
                  className={`flex items-center gap-2 rounded-sm border px-2 py-1.5 ${
                    active ? "border-line-strong bg-raised" : "border-line"
                  }`}
                >
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-mono text-[10px] text-ink-dim">
                      {run.run_id}
                    </div>
                    <div className="text-[10px] uppercase tracking-[0.12em] text-ink-faint">
                      {run.profile} · {run.status}
                    </div>
                  </div>
                  {live ? (
                    <ActionButton
                      label="WATCH"
                      tone="text-ok border-ok/40"
                      onClick={() => watchRun(run.run_id)}
                    />
                  ) : (
                    <ActionButton
                      label={busy === run.run_id ? "…" : "REPLAY"}
                      tone="text-win border-win/40"
                      onClick={() => void replay(run.run_id)}
                    />
                  )}
                </li>
              );
            })}
          </ul>
        )}
        {error && <p className="px-1 py-1 text-[10px] text-crit">{error}</p>}
      </div>
    </section>
  );
}

function ActionButton({
  label,
  tone,
  onClick,
}: {
  label: string;
  tone: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`shrink-0 rounded-sm border px-2 py-1 text-[10px] font-semibold tracking-[0.14em] hover:bg-raised ${tone}`}
    >
      {label}
    </button>
  );
}
