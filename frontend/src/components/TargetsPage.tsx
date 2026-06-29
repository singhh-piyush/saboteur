import { useCallback, useEffect, useState } from "react";

import {
  ApiError,
  createTarget,
  deleteTarget,
  fetchTargets,
  updateTarget,
  type OracleKind,
  type Target,
} from "../lib/api";
import { ConfirmDialog } from "./ConfirmDialog";
import { CrossIcon, EyeIcon, TrashIcon } from "./Icons";
import { PanelHeader } from "./PanelHeader";

const INPUT_CLS =
  "w-full rounded-sm border border-line bg-raised px-2 py-1.5 text-sm text-ink outline-none " +
  "transition-colors duration-150 " +
  "focus:border-accent/60 focus:shadow-[0_0_0_3px_color-mix(in_oklch,var(--color-accent)_18%,transparent)] " +
  "placeholder:text-ink-faint";

const LABEL_CLS =
  "mb-1 block text-[11px] font-semibold uppercase tracking-[0.14em] text-ink-dim";

interface EnvRow {
  key: string;
  value: string;
}

interface EditorState {
  original: string | null; // null = creating; non-null = editing this name
  name: string;
  cmd: string; // one argv token per line
  cwd: string;
  env: EnvRow[];
  oracleKind: OracleKind;
  oraclePattern: string;
  oracleCommand: string;
  oracleUrl: string;
}

function blankEditor(): EditorState {
  return {
    original: null,
    name: "",
    cmd: "",
    cwd: "",
    env: [],
    oracleKind: "none",
    oraclePattern: "",
    oracleCommand: "",
    oracleUrl: "",
  };
}

function editorFrom(target: Target): EditorState {
  const o = target.oracle ?? { kind: "none" };
  return {
    original: target.name,
    name: target.name,
    cmd: (target.cmd ?? []).join("\n"),
    cwd: target.cwd ?? "",
    env: Object.entries(target.env ?? {}).map(([key, value]) => ({ key, value })),
    oracleKind: o.kind,
    oraclePattern: o.pattern ?? "",
    oracleCommand: o.command ?? "",
    oracleUrl: o.url ?? "",
  };
}

function toTarget(ed: EditorState): Target {
  const env: Record<string, string> = {};
  for (const { key, value } of ed.env) {
    if (key.trim()) env[key.trim()] = value;
  }
  return {
    name: ed.name.trim(),
    kind: "command",
    cmd: ed.cmd
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean),
    cwd: ed.cwd.trim() || null,
    env,
    oracle: {
      kind: ed.oracleKind,
      pattern: ed.oracleKind === "regex" ? ed.oraclePattern : null,
      command: ed.oracleKind === "command" ? ed.oracleCommand : null,
      url: ed.oracleKind === "http" ? ed.oracleUrl : null,
    },
  };
}

export function TargetsPage() {
  const [targets, setTargets] = useState<Target[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [deleteName, setDeleteName] = useState<string | null>(null);

  const refresh = useCallback(() => {
    fetchTargets()
      .then(setTargets)
      .catch((err: unknown) =>
        setError(err instanceof Error ? err.message : String(err)),
      );
  }, []);

  useEffect(refresh, [refresh]);

  async function handleSave() {
    if (editor === null) return;
    setSaving(true);
    setSaveError(null);
    const target = toTarget(editor);
    if (!target.name) {
      setSaveError("Name is required.");
      setSaving(false);
      return;
    }
    if (!target.cmd || target.cmd.length === 0) {
      setSaveError("Command (at least one argv token) is required.");
      setSaving(false);
      return;
    }
    try {
      if (editor.original === null) {
        await createTarget(target);
      } else {
        await updateTarget(editor.original, target);
      }
      setEditor(null);
      refresh();
    } catch (err) {
      setSaveError(
        err instanceof ApiError ? err.message : err instanceof Error ? err.message : String(err),
      );
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete() {
    if (deleteName === null) return;
    try {
      await deleteTarget(deleteName);
      setDeleteName(null);
      refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setDeleteName(null);
    }
  }

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <PanelHeader
        title="TARGETS"
        right={
          <button
            type="button"
            onClick={() => {
              setEditor(blankEditor());
              setSaveError(null);
            }}
            className="rounded-sm border border-accent/60 bg-accent/10 px-3 py-1.5 text-xs font-semibold text-accent transition-colors duration-150 hover:bg-accent/20"
          >
            + New target
          </button>
        }
      />

      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4">
        {error && (
          <div className="rounded-sm border border-crit/40 bg-crit/10 px-3 py-2 text-sm text-crit">
            {error}
          </div>
        )}

        {editor && (
          <TargetEditor
            editor={editor}
            saving={saving}
            error={saveError}
            onChange={setEditor}
            onSave={() => void handleSave()}
            onCancel={() => setEditor(null)}
          />
        )}

        <div className="space-y-2">
          {targets.map((t) => (
            <TargetRow
              key={t.name}
              target={t}
              onEdit={() => {
                setEditor(editorFrom(t));
                setSaveError(null);
              }}
              onDelete={() => setDeleteName(t.name)}
            />
          ))}
        </div>
      </div>

      <ConfirmDialog
        open={deleteName !== null}
        title="Delete Target"
        message={`Delete target "${deleteName}"? This cannot be undone.`}
        confirmLabel="Delete"
        destructive
        onConfirm={() => void handleDelete()}
        onCancel={() => setDeleteName(null)}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------

function TargetRow({
  target,
  onEdit,
  onDelete,
}: {
  target: Target;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const builtin = target.kind === "reference";
  const oracleKind = target.oracle?.kind ?? "none";
  return (
    <div className="flex items-center gap-4 rounded-md border border-line bg-panel px-4 py-3">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="font-display text-base font-semibold tracking-wide text-ink">
            {target.name}
          </span>
          {builtin ? (
            <span className="rounded-sm border border-line px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-ink-dim">
              built-in
            </span>
          ) : (
            oracleKind !== "none" && (
              <span className="rounded-sm border border-accent/40 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-accent">
                oracle: {oracleKind}
              </span>
            )
          )}
        </div>
        <div className="mt-0.5 truncate font-mono text-xs text-ink-faint">
          {builtin
            ? "Saboteur smolagents agent (tool-boundary faults)"
            : (target.cmd ?? []).join(" ") || "-"}
        </div>
      </div>
      {builtin ? (
        <span className="text-xs font-medium text-ink-faint">not editable</span>
      ) : (
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={onEdit}
            title="Edit"
            className="rounded-sm border border-line p-1.5 text-ink-dim transition-colors hover:bg-raised hover:text-ink"
          >
            <EyeIcon size={14} />
          </button>
          <button
            type="button"
            onClick={onDelete}
            title="Delete"
            className="rounded-sm border border-line p-1.5 text-ink-dim transition-colors hover:border-crit/40 hover:bg-crit/10 hover:text-crit"
          >
            <TrashIcon size={14} />
          </button>
        </div>
      )}
    </div>
  );
}

function TargetEditor({
  editor,
  saving,
  error,
  onChange,
  onSave,
  onCancel,
}: {
  editor: EditorState;
  saving: boolean;
  error: string | null;
  onChange: (ed: EditorState) => void;
  onSave: () => void;
  onCancel: () => void;
}) {
  const set = <K extends keyof EditorState>(key: K, value: EditorState[K]) =>
    onChange({ ...editor, [key]: value });

  return (
    <section className="rounded-md border border-accent/40 bg-panel">
      <PanelHeader title={editor.original === null ? "NEW COMMAND TARGET" : `EDIT: ${editor.original}`} />
      <div className="space-y-3 p-4">
        <div>
          <span className={LABEL_CLS}>name</span>
          <input
            type="text"
            value={editor.name}
            disabled={editor.original !== null}
            onChange={(e) => set("name", e.target.value)}
            placeholder="my_agent"
            className={`${INPUT_CLS} disabled:opacity-50`}
          />
          {editor.original !== null && (
            <p className="mt-1 text-[11px] text-ink-faint">
              The name is the target's key and cannot be changed.
            </p>
          )}
        </div>

        <div>
          <span className={LABEL_CLS}>command (one argv token per line)</span>
          <textarea
            value={editor.cmd}
            onChange={(e) => set("cmd", e.target.value)}
            rows={3}
            placeholder={"python\nagent.py"}
            className={`${INPUT_CLS} resize-y font-mono`}
          />
        </div>

        <div>
          <span className={LABEL_CLS}>working dir (optional)</span>
          <input
            type="text"
            value={editor.cwd}
            onChange={(e) => set("cwd", e.target.value)}
            placeholder="/path/to/agent"
            className={INPUT_CLS}
          />
        </div>

        <EnvEditor rows={editor.env} onChange={(env) => set("env", env)} />

        <OracleEditor editor={editor} set={set} />

        {error && (
          <div className="rounded-sm border border-crit/40 bg-crit/10 px-3 py-2 text-sm text-crit">
            {error}
          </div>
        )}

        <div className="flex justify-end gap-2 pt-1">
          <button
            type="button"
            onClick={onCancel}
            className="rounded-sm border border-line px-3 py-2 text-sm font-medium text-ink-dim transition-colors hover:bg-raised hover:text-ink"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onSave}
            disabled={saving}
            className="rounded-sm border border-accent/60 bg-accent/10 px-4 py-2 text-sm font-semibold text-accent transition-colors hover:bg-accent/20 disabled:opacity-40"
          >
            {saving ? "Saving…" : "Save target"}
          </button>
        </div>
      </div>
    </section>
  );
}

function EnvEditor({
  rows,
  onChange,
}: {
  rows: EnvRow[];
  onChange: (rows: EnvRow[]) => void;
}) {
  return (
    <div>
      <span className={LABEL_CLS}>environment variables (optional)</span>
      <div className="space-y-1.5">
        {rows.map((row, i) => (
          <div key={i} className="flex items-center gap-1.5">
            <input
              type="text"
              value={row.key}
              onChange={(e) =>
                onChange(rows.map((r, j) => (j === i ? { ...r, key: e.target.value } : r)))
              }
              placeholder="KEY"
              className={`${INPUT_CLS} font-mono`}
            />
            <input
              type="text"
              value={row.value}
              onChange={(e) =>
                onChange(rows.map((r, j) => (j === i ? { ...r, value: e.target.value } : r)))
              }
              placeholder="value"
              className={`${INPUT_CLS} font-mono`}
            />
            <button
              type="button"
              onClick={() => onChange(rows.filter((_, j) => j !== i))}
              title="Remove"
              className="shrink-0 rounded-sm border border-line p-1.5 text-ink-dim transition-colors hover:border-crit/40 hover:text-crit"
            >
              <CrossIcon size={12} />
            </button>
          </div>
        ))}
        <button
          type="button"
          onClick={() => onChange([...rows, { key: "", value: "" }])}
          className="text-[11px] font-medium text-ink-faint underline-offset-2 transition-colors hover:text-accent hover:underline"
        >
          + add variable
        </button>
      </div>
    </div>
  );
}

function OracleEditor({
  editor,
  set,
}: {
  editor: EditorState;
  set: <K extends keyof EditorState>(key: K, value: EditorState[K]) => void;
}) {
  return (
    <div className="rounded-sm border border-line bg-raised/40 p-3">
      <span className={LABEL_CLS}>success oracle</span>
      <select
        value={editor.oracleKind}
        onChange={(e) => set("oracleKind", e.target.value as OracleKind)}
        className={`${INPUT_CLS} sb-select`}
      >
        <option value="none">none (behavioral metrics only)</option>
        <option value="regex">regex (match final output)</option>
        <option value="command">command (exit 0 = success)</option>
        <option value="http">http callback (POST trace)</option>
      </select>

      {editor.oracleKind === "regex" && (
        <input
          type="text"
          value={editor.oraclePattern}
          onChange={(e) => set("oraclePattern", e.target.value)}
          placeholder="ANSWER:\\s*71\\.6"
          className={`${INPUT_CLS} mt-2 font-mono`}
        />
      )}
      {editor.oracleKind === "command" && (
        <input
          type="text"
          value={editor.oracleCommand}
          onChange={(e) => set("oracleCommand", e.target.value)}
          placeholder="./check.sh"
          className={`${INPUT_CLS} mt-2 font-mono`}
        />
      )}
      {editor.oracleKind === "http" && (
        <input
          type="text"
          value={editor.oracleUrl}
          onChange={(e) => set("oracleUrl", e.target.value)}
          placeholder="http://localhost:9000/judge"
          className={`${INPUT_CLS} mt-2 font-mono`}
        />
      )}
    </div>
  );
}
