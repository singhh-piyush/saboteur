/**
 * FamilySelect - the walkthrough's front door. "Watch the demo" lands here:
 * two model-family cards (their real logos, their actual bundled models), on
 * pure black so the landing's dip-to-black hands off seamlessly. Picking a
 * card starts the branded reveal for that family.
 *
 * Entrance is ONE smooth popup on the whole block (`pop-in`), with a gentle
 * inner stagger for the cards. The popup starts ~350ms after mount so the
 * browser has finished tearing down the landing DOM before the first animated
 * frame - starting earlier drops frames and reads as a stutter. All copy is
 * short and derived from the bundled data - no hardcoded run numbers.
 */

import type { DemoFamily } from "../demo";
import { FamilyLogo } from "./logos";

/** The Intro's settle curve - one shared easing across the cold-open pieces. */
const EASE = "cubic-bezier(0.22, 1, 0.36, 1)";

/** Run label without the hardware suffix - the model name itself. */
function modelName(label: string): string {
  return label.replace(/ on MI300X$/, "");
}

export function FamilySelect({
  families,
  onSelect,
  onExit,
}: {
  families: DemoFamily[];
  onSelect: (index: number) => void;
  onExit: () => void;
}) {
  // Derived, not typed: every bundled run shares the profile / cohort size.
  const sc = families[0]?.runs[0]?.scorecard;

  return (
    <div className="flex h-screen flex-col items-center justify-center overflow-y-auto bg-black px-6 py-10 text-center">
      {/* One popup for the whole block - the smooth entrance. */}
      <div
        className="flex flex-col items-center gap-10"
        style={{
          willChange: "transform, opacity",
          animation: `pop-in 1s ${EASE} 350ms backwards`,
        }}
      >
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-[0.2em] text-accent">
            Recorded runs
          </p>
          <h1 className="mt-3 font-display text-2xl font-semibold tracking-tight text-ink sm:text-3xl">
            Pick a model family
          </h1>
          {sc && (
            <p className="mt-2 text-sm font-medium text-ink-dim">
              Same task, same {sc.profile} chaos, {sc.n_agents} agents each. Real runs, recorded on
              AMD MI300X.
            </p>
          )}
        </div>

        <div className="flex w-full max-w-2xl flex-col items-stretch justify-center gap-4 sm:flex-row">
          {families.map((family, i) => (
            <button
              key={family.id}
              type="button"
              onClick={() => onSelect(i)}
              className="group flex flex-1 flex-col items-center gap-5 rounded-lg border border-line bg-panel px-8 py-10 transition-all duration-200 hover:-translate-y-0.5 hover:border-accent/60 hover:shadow-[0_0_28px_color-mix(in_oklch,var(--color-accent)_18%,transparent)] focus-visible:border-accent/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50"
              style={{ animation: `logo-in 950ms ${EASE} ${650 + i * 140}ms backwards` }}
            >
              <FamilyLogo
                family={family.id}
                markSize={52}
                className="transition-transform duration-200 group-hover:scale-[1.04]"
              />
              <span className="flex flex-col gap-1">
                {family.runs.map((run) => (
                  <span key={run.id} className="text-sm font-medium text-ink-dim">
                    {modelName(run.label)}
                  </span>
                ))}
              </span>
              <span className="text-[11px] font-semibold uppercase tracking-[0.16em] text-ink-faint transition-colors duration-200 group-hover:text-accent">
                Watch this family
              </span>
            </button>
          ))}
        </div>

        <button
          type="button"
          onClick={onExit}
          className="rounded-sm border border-line px-3 py-1 text-xs font-medium text-ink-dim transition-colors duration-150 hover:bg-raised hover:text-ink"
          style={{ animation: `card-in 900ms ${EASE} 1050ms backwards` }}
        >
          Back to landing
        </button>
      </div>
    </div>
  );
}
