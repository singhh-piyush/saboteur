/**
 * A small, looping cohort grid for the hero - a live-feeling preview of the
 * product. It reuses the console's `.agent-cell` CSS (border tint, glow,
 * state-flash) and the AgentCell visual language (label / status glyph / step
 * counter / progress footer), but is a self-contained presentational loop -
 * it never touches the reducer or real telemetry.
 *
 * Motion is gated on prefers-reduced-motion: when the user opts out, the grid
 * renders a static mixed-state snapshot and never animates.
 */

import { useEffect, useMemo, useState } from "react";
import { Activity, Flag, RefreshCw, X } from "lucide-react";

type Status = "healthy" | "recovering" | "crashed" | "succeeded";

const STATE_COLOR: Record<Status, string> = {
  healthy: "var(--color-ok)",
  recovering: "var(--color-warn)",
  crashed: "var(--color-crit)",
  succeeded: "var(--color-win)",
};

const STATE_WORD: Record<Status, string> = {
  healthy: "nominal",
  recovering: "recovering",
  crashed: "down",
  succeeded: "complete",
};

const MAX_STEPS = 15;
const COUNT = 12;

interface Cell {
  status: Status;
  step: number;
  /** Bumps on every change - keys the one-shot flash, like AgentCell.seq. */
  seq: number;
}

/** A plausible cohort seed: mostly healthy, a couple recovering, one done. */
function seed(): Cell[] {
  const start: Status[] = [
    "succeeded", "healthy", "recovering", "healthy",
    "healthy", "succeeded", "recovering", "healthy",
    "crashed", "healthy", "succeeded", "recovering",
  ];
  return start.map((status, i) => ({
    status,
    step: status === "succeeded" ? MAX_STEPS : 3 + ((i * 5) % 9),
    seq: 0,
  }));
}

/** Where a cell goes next - a small, believable resilience state machine. */
function advance(c: Cell): Cell {
  const r = c.step; // deterministic-ish churn without an RNG dep
  switch (c.status) {
    case "healthy":
      return { status: (r % 3 === 0 ? "recovering" : "healthy"), step: Math.min(c.step + 1, MAX_STEPS), seq: c.seq + 1 };
    case "recovering":
      // recover most of the time, occasionally crash
      return { status: r % 4 === 0 ? "crashed" : r % 3 === 0 ? "succeeded" : "healthy", step: Math.min(c.step + 1, MAX_STEPS), seq: c.seq + 1 };
    case "crashed":
    case "succeeded":
      // terminal cells respawn into a fresh run
      return { status: "healthy", step: 2, seq: c.seq + 1 };
  }
}

export function HeroGrid() {
  const reduced = useMemo(
    () => typeof matchMedia !== "undefined" && matchMedia("(prefers-reduced-motion: reduce)").matches,
    [],
  );
  const [cells, setCells] = useState<Cell[]>(seed);

  useEffect(() => {
    if (reduced) return;
    const id = setInterval(() => {
      setCells((prev) => {
        const next = prev.slice();
        // Churn 1–3 cells per tick so the grid feels alive, not frantic.
        const hits = 1 + (Date.now() % 3);
        for (let k = 0; k < hits; k++) {
          const i = (Date.now() + k * 7) % next.length;
          next[i] = advance(next[i]);
        }
        return next;
      });
    }, 900);
    return () => clearInterval(id);
  }, [reduced]);

  return (
    <div className="grid grid-cols-3 gap-2 sm:grid-cols-4">
      {cells.slice(0, COUNT).map((cell, i) => (
        <HeroCell key={i} id={i} cell={cell} />
      ))}
    </div>
  );
}

function HeroCell({ id, cell }: { id: number; cell: Cell }) {
  const color = STATE_COLOR[cell.status];
  const progress = cell.status === "succeeded" ? 1 : Math.min(cell.step / MAX_STEPS, 1);

  return (
    <div className="agent-cell-wrap">
      <div
        className="agent-cell group relative flex w-full flex-col rounded-md border p-2.5 text-left"
        style={{ "--state": color } as React.CSSProperties}
      >
        {cell.seq > 0 && (
          <span
            key={cell.seq}
            aria-hidden
            className="animate-state-flash pointer-events-none absolute inset-0 rounded-md"
            style={{ ["--ring" as string]: color }}
          />
        )}

        <div className="flex items-start justify-between">
          <span className="text-xs font-semibold leading-none tracking-wide text-ink">
            A-{String(id).padStart(2, "0")}
          </span>
          <Glyph status={cell.status} color={color} />
        </div>

        <div className="mt-2 text-[11px] text-ink-dim">
          <span className="font-medium text-ink">{cell.step}</span>
          <span className="text-ink-faint">/{MAX_STEPS}</span>
        </div>

        <div className="mt-1.5">
          <span
            className="inline-flex items-center rounded-sm px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-widest"
            style={{ color, background: `color-mix(in oklch, ${color} 13%, transparent)` }}
          >
            {STATE_WORD[cell.status]}
          </span>
        </div>

        <div className="mt-2 h-[3px] w-full overflow-hidden rounded-full bg-line-strong">
          <div
            className="h-full rounded-full"
            style={{
              width: `${progress * 100}%`,
              background: color,
              transition: "width 300ms ease, background-color 200ms ease",
            }}
          />
        </div>
      </div>
    </div>
  );
}

function Glyph({ status, color }: { status: Status; color: string }) {
  const props = { size: 13, style: { color }, strokeWidth: 2 } as const;
  switch (status) {
    case "succeeded":
      return <Flag {...props} />;
    case "crashed":
      return <X {...props} />;
    case "recovering":
      return <RefreshCw {...props} />;
    case "healthy":
    default:
      return <Activity {...props} />;
  }
}
