import { useCallback, useEffect, useState } from "react";

import {
  bulkDeleteRuns,
  deleteRun,
  downloadJsonlUrl,
  downloadScorecardUrl,
  fetchRunList,
  type RunListEntry,
} from "../lib/api";
import { relativeTime } from "../lib/format";
import { useRun } from "../state/RunContext";
import { ConfirmDialog } from "./ConfirmDialog";
import {
  BoltIcon,
  CheckIcon,
  CircleIcon,
  CrossIcon,
  DashedCircleIcon,
  DownloadIcon,
  EyeIcon,
  TrashIcon,
} from "./Icons";

// ---------------------------------------------------------------------------
// Status badge display
// ---------------------------------------------------------------------------

const STATUS_STYLE: Record<string, { color: string; icon: React.ReactNode }> = {
  pending:  { color: "var(--color-ink-faint)",  icon: <DashedCircleIcon size={12} /> },
  running:  { color: "var(--color-ok)",         icon: <CircleIcon size={12} /> },
  finished: { color: "var(--color-win)",        icon: <CheckIcon size={12} /> },
  failed:   { color: "var(--color-crit)",       icon: <CrossIcon size={12} /> },
  archived: { color: "var(--color-ink-dim)",     icon: <CheckIcon size={12} /> },
};

function StatusBadge({ status }: { status: string }) {
  const s = STATUS_STYLE[status] ?? STATUS_STYLE.archived;
  return (
    <span
      className="inline-flex items-center gap-1 rounded-sm border px-2 py-0.5 text-xs font-semibold uppercase tracking-wider"
      style={{ color: s.color, borderColor: `color-mix(in oklch, ${s.color} 35%, transparent)` }}
    >
      {s.icon}
      {status}
    </span>
  );
}

function SurvivalBadge({ pct }: { pct: number | null }) {
  if (pct === null) return <span className="text-sm text-ink-faint">—</span>;
  const color =
    pct >= 75 ? "var(--color-ok)" : pct >= 40 ? "var(--color-warn)" : "var(--color-crit)";
  return (
    <span
      className="font-display text-lg font-bold"
      style={{ color }}
      title={`${pct.toFixed(1)}% survival`}
    >
      {pct.toFixed(0)}%
    </span>
  );
}

// ---------------------------------------------------------------------------
// RunsPage
// ---------------------------------------------------------------------------

export function RunsPage() {
  const { watchRun } = useRun();
  const [runs, setRuns] = useState<RunListEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Delete confirm
  const [deleteTarget, setDeleteTarget] = useState<RunListEntry | null>(null);
  // Bulk delete confirm
  const [bulkConfirm, setBulkConfirm] = useState(false);

  const refresh = useCallback(() => {
    fetchRunList()
      .then((list) => {
        setRuns(list);
        setLoading(false);
      })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : String(err));
        setLoading(false);
      });
  }, []);

  // Poll: fast while any run is active, slow otherwise.
  useEffect(() => {
    refresh();
    const hasActive = runs.some((r) => r.status === "running" || r.status === "pending");
    const interval = hasActive ? 5_000 : 30_000;
    const id = setInterval(refresh, interval);
    return () => clearInterval(id);
  }, [refresh, runs.length > 0 && runs.some((r) => r.status === "running" || r.status === "pending")]);

  const finishedCount = runs.filter(
    (r) => r.status === "finished" || r.status === "failed" || r.status === "archived",
  ).length;

  async function handleDelete() {
    if (!deleteTarget) return;
    try {
      await deleteRun(deleteTarget.run_id);
      setDeleteTarget(null);
      refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setDeleteTarget(null);
    }
  }

  async function handleBulkDelete() {
    try {
      const { deleted } = await bulkDeleteRuns();
      setBulkConfirm(false);
      setError(null);
      if (deleted > 0) refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBulkConfirm(false);
    }
  }

  function openRun(run: RunListEntry) {
    watchRun(run.run_id);
  }

  return (
    <div className="flex h-full flex-col overflow-hidden">
      {/* Header bar */}
      <div className="flex items-center justify-between border-b border-line px-5 py-3">
        <h2 className="font-display text-xl font-bold tracking-widest text-ink">
          RUNS
        </h2>
        <div className="flex items-center gap-2">
          {finishedCount > 0 && (
            <button
              type="button"
              onClick={() => setBulkConfirm(true)}
              className="inline-flex items-center gap-1.5 rounded-sm border border-crit/40 bg-crit/5 px-3 py-1.5 text-xs font-semibold text-crit hover:bg-crit/10"
            >
              <TrashIcon size={13} />
              Clear finished ({finishedCount})
            </button>
          )}
          <button
            type="button"
            onClick={refresh}
            className="rounded-sm border border-line px-3 py-1.5 text-xs font-medium text-ink-dim hover:bg-raised hover:text-ink"
          >
            Refresh
          </button>
        </div>
      </div>

      {/* Run list */}
      <div className="min-h-0 flex-1 overflow-y-auto">
        {loading && runs.length === 0 && (
          <div className="flex h-40 items-center justify-center text-sm text-ink-faint">
            Loading runs…
          </div>
        )}
        {!loading && runs.length === 0 && (
          <div className="flex h-40 flex-col items-center justify-center gap-2 text-center">
            <div className="font-display text-xl font-semibold tracking-widest text-ink-faint">
              NO RUNS YET
            </div>
            <p className="text-sm text-ink-dim">
              Launch a chaos run from the control panel to get started.
            </p>
          </div>
        )}
        {error && (
          <div className="mx-5 mt-3 rounded-sm border border-crit/40 bg-crit/10 px-3 py-2 text-sm text-crit">
            {error}
          </div>
        )}

        {runs.length > 0 && (
          <div className="divide-y divide-line">
            {runs.map((run) => {
              const isActive = run.status === "running" || run.status === "pending";
              return (
                <div
                  key={run.run_id}
                  className="flex items-center gap-4 px-5 py-3 hover:bg-raised/40"
                >
                  {/* Profile + run id */}
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="font-display text-base font-semibold tracking-wide text-ink">
                        {run.profile}
                      </span>
                      <StatusBadge status={run.status} />
                      {isActive && (
                        <span className="relative flex h-2 w-2">
                          <span className="absolute inline-flex h-full w-full animate-breathe rounded-full bg-ok" />
                        </span>
                      )}
                    </div>
                    <div className="mt-0.5 flex items-center gap-3 text-sm text-ink-dim">
                      <span className="font-mono text-xs text-ink-faint truncate max-w-xs">
                        {run.run_id}
                      </span>
                      {run.n_agents > 0 && (
                        <span>{run.n_agents} agents</span>
                      )}
                      <span>{relativeTime(run.started_at)}</span>
                    </div>
                  </div>

                  {/* Survival badge */}
                  <div className="w-16 text-center">
                    <SurvivalBadge pct={run.survival_pct} />
                  </div>

                  {/* Actions */}
                  <div className="flex items-center gap-1">
                    <ActionBtn
                      title="Open"
                      onClick={() => openRun(run)}
                      icon={<EyeIcon size={14} />}
                    />
                    <a
                      href={downloadJsonlUrl(run.run_id)}
                      download
                      className="rounded-sm border border-line p-1.5 text-ink-dim hover:bg-raised hover:text-ink"
                      title="Download JSONL"
                    >
                      <DownloadIcon size={14} />
                    </a>
                    {run.has_scorecard && (
                      <a
                        href={downloadScorecardUrl(run.run_id)}
                        download
                        className="rounded-sm border border-line p-1.5 text-ink-dim hover:bg-raised hover:text-ink"
                        title="Download Scorecard"
                      >
                        <BoltIcon size={14} />
                      </a>
                    )}
                    <ActionBtn
                      title={isActive ? "Cannot delete while running" : "Delete"}
                      onClick={() => !isActive && setDeleteTarget(run)}
                      icon={<TrashIcon size={14} />}
                      disabled={isActive}
                      destructive
                    />
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Confirm dialogs */}
      <ConfirmDialog
        open={deleteTarget !== null}
        title="Delete Run"
        message={`Delete run "${deleteTarget?.run_id}"? This removes all event logs and scorecards. This action cannot be undone.`}
        confirmLabel="Delete"
        destructive
        onConfirm={handleDelete}
        onCancel={() => setDeleteTarget(null)}
      />
      <ConfirmDialog
        open={bulkConfirm}
        title="Clear Finished Runs"
        message={`Delete ${finishedCount} finished run(s) and their artifacts? This action cannot be undone.`}
        confirmLabel={`Delete ${finishedCount} run(s)`}
        destructive
        onConfirm={() => void handleBulkDelete()}
        onCancel={() => setBulkConfirm(false)}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function ActionBtn({
  title,
  onClick,
  icon,
  disabled = false,
  destructive = false,
}: {
  title: string;
  onClick: () => void;
  icon: React.ReactNode;
  disabled?: boolean;
  destructive?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={`rounded-sm border border-line p-1.5 transition-colors ${
        disabled
          ? "cursor-not-allowed opacity-30 text-ink-faint"
          : destructive
            ? "text-ink-dim hover:bg-crit/10 hover:text-crit hover:border-crit/40"
            : "text-ink-dim hover:bg-raised hover:text-ink"
      }`}
    >
      {icon}
    </button>
  );
}
