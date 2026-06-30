import { useEffect, useState } from "react";

import {
  fetchProfiles,
  fetchTargets,
  startRun,
  type ProfileInfo,
  type Target,
} from "../lib/api";
import { faultStyle } from "../lib/faults";
import { pct } from "../lib/format";
import { useRun } from "../state/RunContext";
import { PanelHeader } from "./PanelHeader";
import { Tooltip } from "./Tooltip";

/** Shared input style applied to text, number, and select controls */
const INPUT_CLS =
  "w-full rounded-sm border border-line bg-raised px-2 py-1.5 text-sm text-ink outline-none " +
  "transition-colors duration-150 " +
  "focus:border-accent/60 focus:shadow-[0_0_0_3px_color-mix(in_oklch,var(--color-accent)_18%,transparent)] " +
  "placeholder:text-ink-faint";

export function ControlPanel() {
  const { watchRun, state, navigate } = useRun();
  const [profiles, setProfiles] = useState<ProfileInfo[]>([]);
  const [profileName, setProfileName] = useState<string>("");
  const [targets, setTargets] = useState<Target[]>([]);
  const [targetName, setTargetName] = useState<string>("reference");
  const [nAgents, setNAgents] = useState(8);
  const [seed, setSeed] = useState<string>("");
  const [withControl, setWithControl] = useState(true);
  const [launching, setLaunching] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetchProfiles()
      .then((list) => {
        setProfiles(list);
        const preferred =
          list.find((p) => p.name === "flaky_friday") ?? list[0];
        if (preferred) setProfileName(preferred.name);
      })
      .catch((err: unknown) =>
        setError(err instanceof Error ? err.message : String(err)),
      );
    fetchTargets()
      .then(setTargets)
      .catch(() => setTargets([{ name: "reference", kind: "reference" }]));
  }, []);

  const profile = profiles.find((p) => p.name === profileName) ?? null;
  const busy = launching || state.conn === "connecting";
  // BYO command targets run chaos-only - no control cohort in v1.
  const isByo = targetName !== "reference";
  const effectiveControl = isByo ? false : withControl;

  async function launch() {
    if (profile === null || busy) return;
    setLaunching(true);
    setError(null);
    try {
      const body: Parameters<typeof startRun>[0] = {
        profile: profile.name,
        target: targetName,
        n_agents: nAgents,
        with_control: effectiveControl,
      };
      const parsedSeed = seed.trim() === "" ? null : Number(seed);
      if (parsedSeed !== null && Number.isFinite(parsedSeed))
        body.seed_override = parsedSeed;
      const { run_id } = await startRun(body);
      watchRun(run_id, nAgents);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLaunching(false);
    }
  }

  return (
    <section>
      <PanelHeader title="CHAOS CONTROL" />

      <div className="space-y-3 p-3">
        {/* Target selector */}
        <Field
          label="target"
          tooltip={
            "Which agent to run.\nreference = Saboteur's built-in agent (faults at the tool boundary).\nA BYO command target is launched as a cohort through the wire proxy."
          }
        >
          <select
            value={targetName}
            onChange={(e) => setTargetName(e.target.value)}
            className={`${INPUT_CLS} sb-select`}
          >
            {targets.map((t) => (
              <option key={t.name} value={t.name}>
                {t.name}
                {t.kind === "reference" ? " (built-in)" : ""}
              </option>
            ))}
          </select>
          <button
            type="button"
            onClick={() => navigate({ kind: "targets" })}
            className="mt-1 text-[11px] font-medium text-ink-faint underline-offset-2 transition-colors duration-150 hover:text-accent hover:underline"
          >
            + manage targets
          </button>
        </Field>

        {/* Profile selector */}
        <Field
          label="profile"
          tooltip="The chaos profile defines which faults are injected and at what probability"
        >
          <select
            value={profileName}
            onChange={(e) => setProfileName(e.target.value)}
            className={`${INPUT_CLS} sb-select`}
          >
            {profiles.map((p) => (
              <option key={p.name} value={p.name}>
                {p.name}
              </option>
            ))}
          </select>
          <button
            type="button"
            onClick={() => navigate({ kind: "profiles" })}
            className="mt-1 text-[11px] font-medium text-ink-faint underline-offset-2 transition-colors duration-150 hover:text-accent hover:underline"
          >
            + build profile
          </button>
        </Field>

        {/* Profile description + fault chips */}
        {profile && (
          <div className="rounded-sm border border-line bg-panel px-2.5 py-2">
            <p className="text-sm font-medium leading-relaxed text-ink">
              {profile.description || "No description."}
            </p>
            <div className="mt-2 flex flex-wrap gap-1">
              {profile.faults.length === 0 ? (
                <span className="text-xs font-medium uppercase tracking-widest text-ok">
                  zero faults - control profile
                </span>
              ) : (
                profile.faults.map((f) => {
                  const fs = faultStyle(f.type);
                  return (
                    <Tooltip
                      key={f.type}
                      label={`${fs.layer.toUpperCase()} LAYER\n${fs.description}`}
                      side="bottom"
                    >
                      <span
                        className="cursor-default rounded-sm border border-line px-1.5 py-0.5 text-xs font-medium transition-colors duration-150 hover:border-current"
                        style={{ color: fs.color }}
                      >
                        {f.type} {pct(f.probability)}
                      </span>
                    </Tooltip>
                  );
                })
              )}
            </div>
          </div>
        )}

        {/* Agents + Seed */}
        <div className="grid grid-cols-2 gap-3">
          <Field
            label="agents"
            tooltip={`Number of agents to run concurrently\n(1-8 local / up to 50 on MI300X)`}
          >
            {/* Custom number stepper: hide native spinners, add +/- buttons */}
            <div className="relative flex">
              <input
                type="number"
                min={1}
                max={50}
                value={nAgents}
                onChange={(e) =>
                  setNAgents(
                    Math.max(1, Math.min(50, Number(e.target.value) || 1)),
                  )
                }
                className={`${INPUT_CLS} pr-7`}
              />
              <div className="absolute inset-y-0 right-0 flex flex-col border-l border-line">
                <button
                  type="button"
                  tabIndex={-1}
                  aria-label="Increase agents"
                  onClick={() => setNAgents((n) => Math.min(50, n + 1))}
                  className="flex flex-1 items-center justify-center px-1.5 text-ink-faint transition-colors duration-100 hover:bg-raised hover:text-accent"
                >
                  <svg width="8" height="5" viewBox="0 0 8 5" fill="none" aria-hidden>
                    <path d="M1 4l3-3 3 3" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                </button>
                <button
                  type="button"
                  tabIndex={-1}
                  aria-label="Decrease agents"
                  onClick={() => setNAgents((n) => Math.max(1, n - 1))}
                  className="flex flex-1 items-center justify-center border-t border-line px-1.5 text-ink-faint transition-colors duration-100 hover:bg-raised hover:text-accent"
                >
                  <svg width="8" height="5" viewBox="0 0 8 5" fill="none" aria-hidden>
                    <path d="M1 1l3 3 3-3" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                </button>
              </div>
            </div>
          </Field>

          <Field
            label={`seed${profile ? ` (${profile.seed})` : ""}`}
            tooltip={`Random seed for fault injection\nSame seed = identical fault sequence`}
          >
            <input
              type="text"
              inputMode="numeric"
              placeholder={profile ? String(profile.seed) : "profile default"}
              value={seed}
              onChange={(e) => setSeed(e.target.value)}
              className={INPUT_CLS}
            />
          </Field>
        </div>

        {/* Control cohort checkbox */}
        <Tooltip
          label={
            isByo
              ? "BYO command targets run chaos-only in v1 (no control cohort)."
              : "Run a parallel calm-seas cohort (no faults) as a baseline for waste factor and survival comparison"
          }
          side="bottom"
          className="w-full"
        >
          <label
            className={`flex items-center gap-2 text-sm font-medium transition-colors duration-150 ${
              isByo
                ? "cursor-not-allowed text-ink-faint"
                : "cursor-pointer text-ink-dim hover:text-ink"
            }`}
          >
            <input
              type="checkbox"
              checked={effectiveControl}
              disabled={isByo}
              onChange={(e) => setWithControl(e.target.checked)}
              className="sb-check"
            />
            {isByo ? "chaos-only (BYO target)" : "pair with calm-seas control cohort"}
          </label>
        </Tooltip>

        {/* Launch */}
        <button
          type="button"
          onClick={() => void launch()}
          disabled={busy || profile === null}
          className="font-display w-full rounded-sm border border-accent/60 bg-accent/10 px-3 py-2.5 text-base font-bold tracking-widest text-accent transition-all duration-200 hover:bg-accent/20 hover:shadow-[0_0_24px_-6px_var(--color-accent)] disabled:cursor-not-allowed disabled:opacity-40"
        >
          {busy ? "LAUNCHING..." : "LAUNCH RUN"}
        </button>

        {error && (
          <p className="rounded-sm border border-crit/40 bg-crit/10 px-2 py-1.5 text-sm text-crit">
            {error}
          </p>
        )}
      </div>
    </section>
  );
}

function Field({
  label,
  tooltip,
  children,
}: {
  label: string;
  tooltip?: string;
  children: React.ReactNode;
}) {
  const labelEl = (
    <span className="mb-1 block text-[11px] font-semibold uppercase tracking-[0.14em] text-ink-dim">
      {label}
    </span>
  );

  return (
    <label className="block">
      {tooltip ? (
        <Tooltip label={tooltip} side="top" className="inline-flex">
          <span className="mb-1 block cursor-default border-b border-dashed border-ink-faint/40 text-[11px] font-semibold uppercase tracking-[0.14em] text-ink-dim transition-colors duration-150 hover:text-ink hover:border-ink-dim/40">
            {label}
          </span>
        </Tooltip>
      ) : (
        labelEl
      )}
      {children}
    </label>
  );
}
