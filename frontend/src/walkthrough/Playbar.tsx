
import { PauseIcon, PlayIcon, RestartIcon } from "../components/Icons";
import type { DemoRun } from "../demo";
import { useWalkthrough } from "./WalkthroughProvider";

const SPEEDS = [0.5, 1, 2, 4];

interface PlaybarProps {
  /** the active family's runs; sibling switcher flips within these only */
  runs: DemoRun[];
  /** restart the guided tour (shown only in free mode) */
  onReplayTour?: () => void;
  showReplayTour: boolean;
  runIndex: number;
  onSwitchRun: (index: number) => void;
  /** true while the guided tour is active - switcher renders dimmed and inert */
  switcherDisabled?: boolean;
  autopilot?: boolean;
  onToggleAutopilot?: () => void;
}

export function Playbar({
  runs,
  onReplayTour,
  showReplayTour,
  runIndex,
  onSwitchRun,
  switcherDisabled = false,
  autopilot = false,
  onToggleAutopilot,
}: PlaybarProps) {
  const { position, length, playing, speed, play, pause, restart, setSpeed, seek } =
    useWalkthrough();

  return (
    <div className="flex flex-wrap items-center gap-3 border-t border-line bg-panel px-3 py-2">
      <span className="font-display text-xs font-semibold tracking-widest text-win">REPLAY</span>

      {/* sibling-run switcher */}
      {runs.length > 1 && (
        <div className="flex gap-1">
          {runs.map((run, i) => (
            <button
              key={run.id}
              type="button"
              disabled={switcherDisabled}
              onClick={() => onSwitchRun(i)}
              title={run.label}
              className={`rounded-sm border px-2 py-0.5 text-xs font-semibold transition-colors duration-150 disabled:cursor-not-allowed disabled:opacity-45 ${
                runIndex === i
                  ? "border-accent/50 bg-accent/10 text-accent"
                  : `border-line text-ink-faint ${switcherDisabled ? "" : "hover:text-ink"}`
              }`}
            >
              {run.short}
            </button>
          ))}
        </div>
      )}

      <button
        type="button"
        onClick={playing ? pause : play}
        className="rounded-sm border border-line p-1.5 text-ink-dim transition-colors duration-150 hover:bg-raised hover:text-ink"
        title={playing ? "Pause" : "Play"}
        aria-label={playing ? "Pause" : "Play"}
      >
        {playing ? <PauseIcon size={12} /> : <PlayIcon size={12} />}
      </button>
      <button
        type="button"
        onClick={restart}
        className="rounded-sm border border-line p-1.5 text-ink-dim transition-colors duration-150 hover:bg-raised hover:text-ink"
        title="Restart from the beginning"
        aria-label="Restart"
      >
        <RestartIcon size={12} />
      </button>

      {onToggleAutopilot && (
        <button
          type="button"
          data-autopilot-safe
          onClick={onToggleAutopilot}
          aria-pressed={autopilot}
          className={`rounded-sm border px-2.5 py-1 text-xs font-semibold transition-colors duration-150 ${
            autopilot
              ? "border-accent/60 bg-accent/10 text-accent"
              : "border-line text-ink-faint hover:text-ink"
          }`}
        >
          AUTOPILOT
        </button>
      )}

      {showReplayTour && onReplayTour && (
        <button
          type="button"
          onClick={onReplayTour}
          className="rounded-sm border border-accent/50 px-2.5 py-1 text-xs font-semibold text-accent transition-colors duration-150 hover:bg-accent/10"
        >
          Replay tour
        </button>
      )}

      {/* scrubber: re-derives state from a fresh fold on drag */}
      <input
        type="range"
        min={0}
        max={length}
        value={Math.min(position, length)}
        onChange={(e) => seek(Number(e.target.value))}
        className="sb-scrubber min-w-[120px] flex-1"
        style={{ ["--sb-pct" as string]: `${length > 0 ? (Math.min(position, length) / length) * 100 : 0}%` }}
        aria-label="Seek"
      />

      <span className="w-24 text-right font-mono text-xs tabular-nums text-ink-faint">
        {position}/{length}
      </span>

      <div className="flex gap-1">
        {SPEEDS.map((s) => (
          <button
            key={s}
            type="button"
            onClick={() => setSpeed(s)}
            className={`rounded-sm border px-1.5 py-0.5 text-xs font-semibold transition-colors duration-150 ${
              speed === s
                ? "border-win/50 text-win"
                : "border-line text-ink-faint hover:text-ink"
            }`}
          >
            {s}x
          </button>
        ))}
      </div>
    </div>
  );
}
