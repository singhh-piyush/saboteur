/**
 * Playbar - the walkthrough's playback transport. Richer than the live
 * ReplayBar: a draggable scrubber (seek to any event index, re-deriving state)
 * and a 0.5x / 1x / 2x / 4x speed selector. Same flight-ops look as the rest of
 * the console.
 */

import { PauseIcon, PlayIcon, RestartIcon } from "../components/Icons";
import { useWalkthrough } from "./WalkthroughProvider";

const SPEEDS = [0.5, 1, 2, 4];

interface PlaybarProps {
  /** Restart the guided tour (shown only in free mode). */
  onReplayTour?: () => void;
  showReplayTour: boolean;
}

export function Playbar({ onReplayTour, showReplayTour }: PlaybarProps) {
  const { position, length, playing, speed, play, pause, restart, setSpeed, seek } =
    useWalkthrough();

  return (
    <div className="flex flex-wrap items-center gap-3 border-t border-line bg-panel px-3 py-2">
      <span className="font-display text-xs font-semibold tracking-widest text-win">REPLAY</span>

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

      {showReplayTour && onReplayTour && (
        <button
          type="button"
          onClick={onReplayTour}
          className="rounded-sm border border-accent/50 px-2.5 py-1 text-xs font-semibold text-accent transition-colors duration-150 hover:bg-accent/10"
        >
          Replay tour
        </button>
      )}

      {/* Scrubber - drag backward or forward; state re-derives from a fresh fold. */}
      <input
        type="range"
        min={0}
        max={length}
        value={Math.min(position, length)}
        onChange={(e) => seek(Number(e.target.value))}
        className="h-1.5 min-w-[120px] flex-1 cursor-pointer"
        style={{ accentColor: "var(--color-win)" }}
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
