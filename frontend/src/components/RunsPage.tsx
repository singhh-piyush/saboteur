import { useCallback, useEffect, useMemo, useState } from "react";

import {
  bulkDeleteRuns,
  deleteRun,
  downloadJsonlUrl,
  downloadScorecardUrl,
  fetchAllEvents,
  fetchRunList,
  type RunListEntry,
  type RunListFilters,
} from "../lib/api";
import { relativeTime } from "../lib/format";
import { useRun } from "../state/RunContext";
import { ConfirmDialog } from "./ConfirmDialog";
import { PanelHeader } from "./PanelHeader";
import {
  BoltIcon,
  CheckIcon,
  CircleIcon,
  CrossIcon,
  DashedCircleIcon,
  DownloadIcon,
  EyeIcon,
  PlayIcon,
  TrashIcon,
} from "./Icons";

const SELECT_CLS =
  "rounded-sm border border-line bg-raised px-2 py-1 text-xs text-ink outline-none focus:border-accent/60 sb-select";

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
  if (pct === null) return <span className="text-sm font-medium text-ink-faint">-</span>;
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
  const { watchRun, navigate, startReplay } = useRun();
  const [runs, setRuns] = useState<RunListEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Filters (target / profile / status / date range).
  const [filters, setFilters] = useState<RunListFilters>({});
  // Run ids selected for comparison (max 2; must have a scorecard).
  const [selected, setSelected] = useState<string[]>([]);

  // Delete confirm
  const [deleteTarget, setDeleteTarget] = useState<RunListEntry | null>(null);
  // Bulk delete confirm
  const [bulkConfirm, setBulkConfirm] = useState(false);

  const refresh = useCallback(() => {
    fetchRunList(filters)
      .then((list) => {
        setRuns(list);
        setLoading(false);
      })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : String(err));
        setLoading(false);
      });
  }, [filters]);

  // Poll: fast while any run is active, slow otherwise.
  useEffect(() => {
    refresh();
    const hasActive = runs.some((r) => r.status === "running" || r.status === "pending");
    const interval = hasActive ? 5_000 : 30_000;
    const id = setInterval(refresh, interval);
    return () => clearInterval(id);
  }, [refresh, runs.length > 0 && runs.some((r) => r.status === "running" || r.status === "pending")]);

  // Distinct filter option values (computed from whatever is loaded).
  const targetOptions = useMemo(
    () => Array.from(new Set(runs.map((r) => r.target))).sort(),
    [runs],
  );
  const profileOptions = useMemo(
    () => Array.from(new Set(runs.map((r) => r.profile))).sort(),
    [runs],
  );

  function toggleSelected(runId: string) {
    setSelected((cur) =>
      cur.includes(runId)
        ? cur.filter((id) => id !== runId)
        : cur.length >= 2
          ? [cur[1], runId] // keep most recent two
          : [...cur, runId],
    );
  }

  async function replayRun(run: RunListEntry) {
    try {
      const events = await fetchAllEvents(run.run_id);
      startReplay(run.run_id, events);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

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
    watchRun(run.run_id, run.n_agents > 0 ? run.n_agents : undefined);
  }

  return (
    <div className="flex h-full flex-col overflow-hidden">
      {/* Header bar */}
      <PanelHeader
        title="RUNS"
        right={
          <div className="flex items-center gap-2">
            {selected.length === 2 && (
              <button
                type="button"
                onClick={() => navigate({ kind: "compare", a: selected[0], b: selected[1] })}
                className="inline-flex items-center gap-1.5 rounded-sm border border-accent/60 bg-accent/10 px-3 py-1.5 text-xs font-semibold text-accent transition-colors duration-150 hover:bg-accent/20"
              >
                Compare selected
              </button>
            )}
            {finishedCount > 0 && (
              <button
                type="button"
                onClick={() => setBulkConfirm(true)}
                className="inline-flex items-center gap-1.5 rounded-sm border border-crit/40 bg-crit/5 px-3 py-1.5 text-xs font-semibold text-crit transition-colors duration-150 hover:bg-crit/10"
              >
                <TrashIcon size={13} />
                Clear finished ({finishedCount})
              </button>
            )}
            <button
              type="button"
              onClick={refresh}
              className="rounded-sm border border-line px-3 py-1.5 text-xs font-medium text-ink-dim transition-colors duration-150 hover:bg-raised hover:text-ink"
            >
              Refresh
            </button>
          </div>
        }
      />

      {/* Filter bar */}
      <div className="flex flex-wrap items-center gap-2 border-b border-line px-5 py-2">
        <select
          value={filters.target ?? ""}
          onChange={(e) => setFilters((f) => ({ ...f, target: e.target.value || undefined }))}
          className={SELECT_CLS}
        >
          <option value="">all targets</option>
          {targetOptions.map((t) => (
            <option key={t} value={t}>{t}</option>
          ))}
        </select>
        <select
          value={filters.profile ?? ""}
          onChange={(e) => setFilters((f) => ({ ...f, profile: e.target.value || undefined }))}
          className={SELECT_CLS}
        >
          <option value="">all profiles</option>
          {profileOptions.map((p) => (
            <option key={p} value={p}>{p}</option>
          ))}
        </select>
        <select
          value={filters.status ?? ""}
          onChange={(e) => setFilters((f) => ({ ...f, status: e.target.value || undefined }))}
          className={SELECT_CLS}
        >
          <option value="">all statuses</option>
          {["running", "finished", "failed", "archived", "pending"].map((s) => (
            <option key={s} value={s}>{s}</option>
          ))}
        </select>
        <input
          type="date"
          value={filters.date_from ?? ""}
          onChange={(e) => setFilters((f) => ({ ...f, date_from: e.target.value || undefined }))}
          title="From date"
          className={SELECT_CLS}
        />
        <input
          type="date"
          value={filters.date_to ?? ""}
          onChange={(e) => setFilters((f) => ({ ...f, date_to: e.target.value || undefined }))}
          title="To date"
          className={SELECT_CLS}
        />
        {Object.values(filters).some(Boolean) && (
          <button
            type="button"
            onClick={() => setFilters({})}
            className="text-[11px] font-medium text-ink-faint underline-offset-2 hover:text-accent hover:underline"
          >
            clear filters
          </button>
        )}
      </div>

      {/* Run list */}
      <div className="min-h-0 flex-1 overflow-y-auto">
        {loading && runs.length === 0 && (
          <div className="flex h-40 items-center justify-center text-sm font-medium text-ink-faint">
            Loading runs...
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
                  {/* Compare select (scored runs only) */}
                  <input
                    type="checkbox"
                    className="sb-check shrink-0"
                    checked={selected.includes(run.run_id)}
                    disabled={!run.has_scorecard}
                    onChange={() => toggleSelected(run.run_id)}
                    title={
                      run.has_scorecard
                        ? "Select for comparison (max 2)"
                        : "No scorecard - cannot compare"
                    }
                  />

                  {/* Profile + run id */}
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="font-display text-base font-semibold tracking-wide text-ink">
                        {run.profile}
                      </span>
                      <span className="rounded-sm border border-line px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-ink-dim">
                        {run.target}
                      </span>
                      <StatusBadge status={run.status} />
                      {isActive && (
                        <span className="relative flex h-2 w-2">
                          <span className="absolute inline-flex h-full w-full animate-breathe rounded-full bg-ok" />
                        </span>
                      )}
                    </div>
                    <div className="mt-0.5 flex items-center gap-3 text-sm font-medium text-ink-dim">
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
                      title="Open live grid"
                      onClick={() => openRun(run)}
                      icon={<EyeIcon size={14} />}
                    />
                    <ActionBtn
                      title="Replay"
                      onClick={() => void replayRun(run)}
                      icon={<PlayIcon size={12} />}
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
