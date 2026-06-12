import { useEffect, useState } from "react";

import { fetchProfiles, startRun, type ProfileInfo } from "../lib/api";
import { faultStyle } from "../lib/faults";
import { pct } from "../lib/format";
import { useRun } from "../state/RunContext";

export function ControlPanel() {
  const { watchRun, state } = useRun();
  const [profiles, setProfiles] = useState<ProfileInfo[]>([]);
  const [profileName, setProfileName] = useState<string>("");
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
  }, []);

  const profile = profiles.find((p) => p.name === profileName) ?? null;
  const busy = launching || state.conn === "connecting";

  async function launch() {
    if (profile === null || busy) return;
    setLaunching(true);
    setError(null);
    try {
      const body: Parameters<typeof startRun>[0] = {
        profile: profile.name,
        n_agents: nAgents,
        with_control: withControl,
      };
      const parsedSeed = seed.trim() === "" ? null : Number(seed);
      if (parsedSeed !== null && Number.isFinite(parsedSeed))
        body.seed_override = parsedSeed;
      const { run_id } = await startRun(body);
      watchRun(run_id);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLaunching(false);
    }
  }

  return (
    <section className="border-b border-line">
      <header className="border-b border-line px-3 py-2">
        <h2 className="font-display text-sm font-semibold tracking-[0.22em] text-ink-dim">
          CHAOS CONTROL
        </h2>
      </header>

      <div className="space-y-3 p-3">
        <Field label="profile">
          <select
            value={profileName}
            onChange={(e) => setProfileName(e.target.value)}
            className="w-full rounded-sm border border-line bg-raised px-2 py-1.5 text-sm text-ink outline-none focus:border-line-strong"
          >
            {profiles.map((p) => (
              <option key={p.name} value={p.name}>
                {p.name}
              </option>
            ))}
          </select>
        </Field>

        {profile && (
          <div className="rounded-sm border border-line bg-panel px-2.5 py-2">
            <p className="text-xs leading-snug text-ink-dim">
              {profile.description || "No description."}
            </p>
            <div className="mt-2 flex flex-wrap gap-1">
              {profile.faults.length === 0 ? (
                <span className="text-[10px] uppercase tracking-[0.14em] text-ok">
                  zero faults — control profile
                </span>
              ) : (
                profile.faults.map((f) => (
                  <span
                    key={f.type}
                    className="rounded-sm border border-line px-1.5 py-0.5 text-[10px] font-medium"
                    style={{ color: faultStyle(f.type).color }}
                  >
                    {f.type} {pct(f.probability)}
                  </span>
                ))
              )}
            </div>
          </div>
        )}

        <div className="grid grid-cols-2 gap-3">
          <Field label="agents">
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
              className="w-full rounded-sm border border-line bg-raised px-2 py-1.5 text-sm text-ink outline-none focus:border-line-strong"
            />
          </Field>
          <Field label={`seed${profile ? ` (${profile.seed})` : ""}`}>
            <input
              type="text"
              inputMode="numeric"
              placeholder={profile ? String(profile.seed) : "profile default"}
              value={seed}
              onChange={(e) => setSeed(e.target.value)}
              className="w-full rounded-sm border border-line bg-raised px-2 py-1.5 text-sm text-ink outline-none placeholder:text-ink-faint focus:border-line-strong"
            />
          </Field>
        </div>

        <label className="flex cursor-pointer items-center gap-2 text-xs text-ink-dim">
          <input
            type="checkbox"
            checked={withControl}
            onChange={(e) => setWithControl(e.target.checked)}
            className="accent-(--color-accent)"
          />
          pair with calm-seas control cohort
        </label>

        <button
          type="button"
          onClick={() => void launch()}
          disabled={busy || profile === null}
          className="font-display w-full rounded-sm border border-accent/60 bg-accent/10 px-3 py-2.5 text-base font-bold tracking-[0.3em] text-accent transition-all duration-200 hover:bg-accent/20 hover:shadow-[0_0_24px_-6px_var(--color-accent)] disabled:cursor-not-allowed disabled:opacity-40"
        >
          {busy ? "LAUNCHING…" : "LAUNCH RUN"}
        </button>

        {error && (
          <p className="rounded-sm border border-crit/40 bg-crit/10 px-2 py-1.5 text-xs text-crit">
            {error}
          </p>
        )}
      </div>
    </section>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-[10px] uppercase tracking-[0.16em] text-ink-faint">
        {label}
      </span>
      {children}
    </label>
  );
}
