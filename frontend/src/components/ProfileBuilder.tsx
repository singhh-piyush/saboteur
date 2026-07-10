import { useEffect, useMemo, useState } from "react";

import {
  ApiError,
  deleteProfile,
  fetchFaults,
  fetchProfile,
  fetchProfiles,
  saveProfile,
  validateProfile,
  type FaultCatalogEntry,
  type FaultDraft,
  type ParamSpec,
  type ProfileDraft,
  type ProfileInfo,
  type ValidationResult,
} from "../lib/api";
import { faultStyle } from "../lib/faults";
import { pct } from "../lib/format";
import { useRun } from "../state/RunContext";
import { ConfirmDialog } from "./ConfirmDialog";
import { CrossIcon } from "./Icons";
import { PanelHeader } from "./PanelHeader";

const INPUT_CLS =
  "w-full rounded-sm border border-line bg-raised px-2 py-1.5 text-sm text-ink outline-none " +
  "transition-colors duration-150 " +
  "focus:border-accent/60 focus:shadow-[0_0_0_3px_color-mix(in_oklch,var(--color-accent)_18%,transparent)] " +
  "placeholder:text-ink-faint";

const LABEL_CLS =
  "mb-1 block text-[11px] font-semibold uppercase tracking-[0.14em] text-ink-dim";

const BUILTIN_PROFILES = new Set([
  "calm_seas",
  "flaky_friday",
  "rate_limit_storm",
  "hell_mode",
  "liars_den",
]);

const NAME_RE = /^[A-Za-z0-9_-]+$/;

const REFERENCE_TOOLS = ["weather", "calculator", "web_search", "file_report"];

interface BuilderFault {
  type: string;
  probability: number;
  targetTools: string; 
  params: Record<string, unknown>;
}

function newFault(entry: FaultCatalogEntry): BuilderFault {
  const params: Record<string, unknown> = {};
  for (const p of entry.params) params[p.name] = p.default;
  return { type: entry.type, probability: 0.5, targetTools: "", params };
}

function faultFromDict(
  d: Record<string, unknown>,
  byType: Record<string, FaultCatalogEntry>,
): BuilderFault {
  const type = String(d.type);
  const entry = byType[type];
  const params: Record<string, unknown> = {};
  if (entry) {
    for (const p of entry.params) params[p.name] = d[p.name] ?? p.default;
  }
  const tt = Array.isArray(d.target_tools) ? (d.target_tools as string[]).join(", ") : "";
  return { type, probability: Number(d.probability ?? 0.5), targetTools: tt, params };
}

function faultToDraft(f: BuilderFault): FaultDraft {
  const draft: Record<string, unknown> = { type: f.type, probability: f.probability };
  const tools = f.targetTools
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (tools.length) draft.target_tools = tools;
  for (const [k, v] of Object.entries(f.params)) draft[k] = v;
  return draft as FaultDraft;
}

export function ProfileBuilder() {
  const { navigate } = useRun();
  const [catalog, setCatalog] = useState<FaultCatalogEntry[]>([]);
  const [existing, setExisting] = useState<ProfileInfo[]>([]);

  const [name, setName] = useState("");
  const [seed, setSeed] = useState(1337);
  const [description, setDescription] = useState("");
  const [faults, setFaults] = useState<BuilderFault[]>([]);

  const [validation, setValidation] = useState<ValidationResult | null>(null);
  const [saveMsg, setSaveMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [saving, setSaving] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const byType = useMemo(
    () => Object.fromEntries(catalog.map((c) => [c.type, c])),
    [catalog],
  );

  const refreshExisting = () => {
    fetchProfiles().then(setExisting).catch(() => setExisting([]));
  };

  useEffect(() => {
    fetchFaults().then(setCatalog).catch(() => setCatalog([]));
    refreshExisting();
  }, []);

  const draft: ProfileDraft = useMemo(
    () => ({ name, seed, description, faults: faults.map(faultToDraft) }),
    [name, seed, description, faults],
  );
  const draftKey = JSON.stringify({ seed, faults: draft.faults });

  useEffect(() => {
    const id = setTimeout(() => {
      validateProfile({ ...draft, name: "validate" })
        .then(setValidation)
        .catch(() => setValidation(null));
    }, 350);
    return () => clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draftKey]);

  const nameValid = NAME_RE.test(name);
  const nameIsBuiltin = BUILTIN_PROFILES.has(name);
  const schemaValid = validation?.valid ?? false;
  const canSave = nameValid && !nameIsBuiltin && schemaValid && !saving;

  function loadProfile(profileName: string) {
    fetchProfile(profileName)
      .then((p) => {
        const builtin = BUILTIN_PROFILES.has(p.name);
        setName(builtin ? `${p.name}_copy` : p.name);
        setSeed(p.seed);
        setDescription(p.description);
        setFaults(p.faults.map((d) => faultFromDict(d, byType)));
        setSaveMsg(
          builtin
            ? { ok: true, text: `Loaded built-in '${p.name}' as a copy - pick a new name to save.` }
            : null,
        );
      })
      .catch((err: unknown) =>
        setSaveMsg({ ok: false, text: err instanceof Error ? err.message : String(err) }),
      );
  }

  async function handleSave() {
    setSaving(true);
    setSaveMsg(null);
    try {
      await saveProfile(draft);
      setSaveMsg({ ok: true, text: `Saved profile '${name}'.` });
      refreshExisting();
    } catch (err) {
      setSaveMsg({
        ok: false,
        text: err instanceof ApiError ? err.message : err instanceof Error ? err.message : String(err),
      });
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete() {
    setConfirmDelete(false);
    try {
      await deleteProfile(name);
      setSaveMsg({ ok: true, text: `Deleted profile '${name}'.` });
      refreshExisting();
      setName("");
      setFaults([]);
    } catch (err) {
      setSaveMsg({ ok: false, text: err instanceof Error ? err.message : String(err) });
    }
  }

  const isExistingCustom = existing.some((p) => p.name === name) && !nameIsBuiltin;

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <PanelHeader
        title="PROFILE BUILDER"
        right={
          <div className="flex items-center gap-2">
            {isExistingCustom && (
              <button
                type="button"
                onClick={() => setConfirmDelete(true)}
                className="rounded-sm border border-crit/40 bg-crit/5 px-3 py-1.5 text-xs font-semibold text-crit transition-colors hover:bg-crit/10"
              >
                Delete
              </button>
            )}
            <button
              type="button"
              onClick={() => void handleSave()}
              disabled={!canSave}
              className="rounded-sm border border-accent/60 bg-accent/10 px-4 py-1.5 text-xs font-bold uppercase tracking-wider text-accent transition-colors hover:bg-accent/20 disabled:opacity-40"
            >
              {saving ? "Saving…" : "Save profile"}
            </button>
          </div>
        }
      />

      <div className="grid min-h-0 flex-1 gap-4 overflow-y-auto p-4 lg:grid-cols-[1.7fr_1fr]">
        <div className="space-y-4">
          <section className="rounded-md border border-line bg-panel p-4">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <div className="sm:col-span-2">
                <span className={LABEL_CLS}>name</span>
                <input
                  type="text"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="my_chaos"
                  className={INPUT_CLS}
                />
                {name !== "" && !nameValid && (
                  <p className="mt-1 text-[11px] text-crit">Use letters, numbers, _ or - only.</p>
                )}
                {nameIsBuiltin && (
                  <p className="mt-1 text-[11px] text-crit">
                    '{name}' is a built-in profile and cannot be overwritten.
                  </p>
                )}
              </div>
              <div>
                <span className={LABEL_CLS}>seed</span>
                <input
                  type="number"
                  value={seed}
                  onChange={(e) => setSeed(Number(e.target.value) || 0)}
                  className={INPUT_CLS}
                />
              </div>
            </div>
            <div className="mt-3">
              <span className={LABEL_CLS}>description</span>
              <input
                type="text"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="What this profile stresses…"
                className={INPUT_CLS}
              />
            </div>
          </section>

          <section className="rounded-md border border-line bg-panel">
            <PanelHeader
              title={`FAULTS (${faults.length})`}
              right={
                <AddFaultMenu
                  catalog={catalog}
                  onAdd={(entry) => setFaults((fs) => [...fs, newFault(entry)])}
                />
              }
            />
            <div className="space-y-3 p-3">
              {faults.length === 0 ? (
                <p className="py-6 text-center text-sm text-ink-faint">
                  No faults - a control profile. Add faults to inject chaos.
                </p>
              ) : (
                faults.map((f, i) => (
                  <FaultCard
                    key={i}
                    fault={f}
                    spec={byType[f.type]}
                    onChange={(updated) =>
                      setFaults((fs) => fs.map((x, j) => (j === i ? updated : x)))
                    }
                    onRemove={() => setFaults((fs) => fs.filter((_, j) => j !== i))}
                  />
                ))
              )}
            </div>
          </section>
        </div>

        <div className="space-y-4">
          <section className="rounded-md border border-line bg-panel">
            <PanelHeader title="VALIDATION" />
            <div className="p-3 text-sm">
              {validation === null ? (
                <span className="text-ink-faint">Checking…</span>
              ) : validation.valid ? (
                <span className="font-medium text-ok">✓ Schema valid</span>
              ) : (
                <ul className="space-y-1.5">
                  {validation.errors.map((e, i) => (
                    <li
                      key={i}
                      className="rounded-sm border border-crit/30 bg-crit/5 px-2 py-1.5 text-xs text-crit"
                    >
                      <span className="font-mono">{e.loc}</span>: {e.msg}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </section>

          {saveMsg && (
            <div
              className={`rounded-sm border px-3 py-2 text-sm ${
                saveMsg.ok
                  ? "border-ok/40 bg-ok/10 text-ok"
                  : "border-crit/40 bg-crit/10 text-crit"
              }`}
            >
              {saveMsg.text}
            </div>
          )}

          <section className="rounded-md border border-line bg-panel">
            <PanelHeader title="LOAD EXISTING" />
            <div className="space-y-1 p-2">
              {existing.map((p) => (
                <button
                  key={p.name}
                  type="button"
                  onClick={() => loadProfile(p.name)}
                  className="flex w-full items-center justify-between rounded-sm px-2 py-1.5 text-left text-sm text-ink-dim transition-colors hover:bg-raised hover:text-ink"
                >
                  <span className="font-medium">{p.name}</span>
                  <span className="text-[11px] text-ink-faint">
                    {BUILTIN_PROFILES.has(p.name) ? "built-in" : `${p.faults.length} faults`}
                  </span>
                </button>
              ))}
            </div>
          </section>

          <button
            type="button"
            onClick={() => navigate({ kind: "runs" })}
            className="text-[11px] font-medium text-ink-faint underline-offset-2 transition-colors hover:text-accent hover:underline"
          >
            ← back to runs
          </button>
        </div>
      </div>

      <ConfirmDialog
        open={confirmDelete}
        title="Delete Profile"
        message={`Delete profile "${name}"? This removes profiles/${name}.yaml.`}
        confirmLabel="Delete"
        destructive
        onConfirm={() => void handleDelete()}
        onCancel={() => setConfirmDelete(false)}
      />
    </div>
  );
}


function AddFaultMenu({
  catalog,
  onAdd,
}: {
  catalog: FaultCatalogEntry[];
  onAdd: (entry: FaultCatalogEntry) => void;
}) {
  return (
    <select
      value=""
      onChange={(e) => {
        const entry = catalog.find((c) => c.type === e.target.value);
        if (entry) onAdd(entry);
        e.target.value = "";
      }}
      className="sb-select rounded-sm border border-accent/60 bg-accent/10 px-2 py-1 text-xs font-semibold text-accent outline-none"
    >
      <option value="">+ Add fault</option>
      {catalog.map((c) => (
        <option key={c.type} value={c.type}>
          {c.type}
        </option>
      ))}
    </select>
  );
}

function FaultCard({
  fault,
  spec,
  onChange,
  onRemove,
}: {
  fault: BuilderFault;
  spec: FaultCatalogEntry | undefined;
  onChange: (f: BuilderFault) => void;
  onRemove: () => void;
}) {
  const fs = faultStyle(fault.type);
  return (
    <div className="rounded-md border border-line bg-raised/30 p-3" style={{ borderLeft: `3px solid ${fs.color}` }}>
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="font-display text-sm font-bold" style={{ color: fs.color }}>
            {fault.type}
          </span>
          <span className="rounded-sm border border-line px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-ink-faint">
            {fs.layer}
          </span>
        </div>
        <button
          type="button"
          onClick={onRemove}
          title="Remove fault"
          className="rounded-sm border border-line p-1 text-ink-dim transition-colors hover:border-crit/40 hover:text-crit"
        >
          <CrossIcon size={12} />
        </button>
      </div>

      <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div>
          <span className={LABEL_CLS}>probability ({pct(fault.probability)})</span>
          <input
            type="number"
            min={0}
            max={1}
            step={0.05}
            value={fault.probability}
            onChange={(e) =>
              onChange({
                ...fault,
                probability: Math.max(0, Math.min(1, Number(e.target.value) || 0)),
              })
            }
            className={INPUT_CLS}
          />
        </div>
        <div>
          <span className={LABEL_CLS}>target tools (comma list, empty = all)</span>
          <input
            type="text"
            value={fault.targetTools}
            onChange={(e) => onChange({ ...fault, targetTools: e.target.value })}
            placeholder="all tools"
            className={`${INPUT_CLS} font-mono`}
          />
          <div className="mt-1 flex flex-wrap gap-1">
            {REFERENCE_TOOLS.map((tool) => (
              <button
                key={tool}
                type="button"
                onClick={() => {
                  const cur = fault.targetTools
                    .split(",")
                    .map((s) => s.trim())
                    .filter(Boolean);
                  if (!cur.includes(tool)) {
                    onChange({ ...fault, targetTools: [...cur, tool].join(", ") });
                  }
                }}
                className="rounded-sm border border-line px-1.5 py-0.5 text-[10px] text-ink-faint transition-colors hover:border-accent/40 hover:text-accent"
              >
                +{tool}
              </button>
            ))}
          </div>
        </div>
      </div>

      {spec && spec.params.length > 0 && (
        <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
          {spec.params.map((p) => (
            <ParamField
              key={p.name}
              spec={p}
              value={fault.params[p.name]}
              onChange={(v) => onChange({ ...fault, params: { ...fault.params, [p.name]: v } })}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function ParamField({
  spec,
  value,
  onChange,
}: {
  spec: ParamSpec;
  value: unknown;
  onChange: (v: unknown) => void;
}) {
  const label = `${spec.name}${spec.required ? " *" : ""}`;

  if (spec.kind === "range") {
    const arr = Array.isArray(value) ? (value as number[]) : [0, 0];
    return (
      <div>
        <span className={LABEL_CLS}>{label} [low, high]</span>
        <div className="flex items-center gap-1.5">
          <input
            type="number"
            value={arr[0] ?? 0}
            step="any"
            onChange={(e) => onChange([Number(e.target.value), arr[1] ?? 0])}
            className={INPUT_CLS}
          />
          <input
            type="number"
            value={arr[1] ?? 0}
            step="any"
            onChange={(e) => onChange([arr[0] ?? 0, Number(e.target.value)])}
            className={INPUT_CLS}
          />
        </div>
      </div>
    );
  }

  if (spec.kind === "int_list") {
    const arr = Array.isArray(value) ? (value as number[]) : [];
    return (
      <div>
        <span className={LABEL_CLS}>{label} (comma list)</span>
        <input
          type="text"
          value={arr.join(", ")}
          onChange={(e) =>
            onChange(
              e.target.value
                .split(",")
                .map((s) => parseInt(s.trim(), 10))
                .filter((n) => !Number.isNaN(n)),
            )
          }
          className={`${INPUT_CLS} font-mono`}
        />
      </div>
    );
  }

  return (
    <div>
      <span className={LABEL_CLS}>{label}</span>
      <input
        type="number"
        value={typeof value === "number" ? value : ""}
        step={spec.kind === "int" ? 1 : "any"}
        onChange={(e) => onChange(spec.kind === "int" ? parseInt(e.target.value, 10) || 0 : Number(e.target.value))}
        className={INPUT_CLS}
      />
    </div>
  );
}
