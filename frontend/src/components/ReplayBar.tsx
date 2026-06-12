import { useRun } from "../state/RunContext";
import { PauseIcon, PlayIcon, RestartIcon, SkipIcon } from "./Icons";

const SPEEDS = [1, 4, 16];

export function ReplayBar() {
  const { replay } = useRun();
  if (replay === null) return null;

  const progress = replay.length === 0 ? 0 : replay.position / replay.length;

  return (
    <div className="flex items-center gap-3 border-t border-line bg-panel px-3 py-2">
      <span className="font-display text-xs font-semibold tracking-widest text-win">
        REPLAY
      </span>

      <button
        type="button"
        onClick={replay.playing ? replay.pause : replay.play}
        className="rounded-sm border border-line p-1.5 text-ink-dim hover:bg-raised hover:text-ink"
        title={replay.playing ? "Pause" : "Play"}
      >
        {replay.playing ? <PauseIcon size={12} /> : <PlayIcon size={12} />}
      </button>
      <button
        type="button"
        onClick={replay.restart}
        className="rounded-sm border border-line p-1.5 text-ink-dim hover:bg-raised hover:text-ink"
        title="Restart"
      >
        <RestartIcon size={12} />
      </button>
      <button
        type="button"
        onClick={replay.skipToEnd}
        className="rounded-sm border border-line p-1.5 text-ink-dim hover:bg-raised hover:text-ink"
        title="Skip to end"
      >
        <SkipIcon size={12} />
      </button>

      <div className="relative h-1 flex-1 overflow-hidden rounded-full bg-raised">
        <div
          className="absolute inset-y-0 left-0 bg-win transition-[width] duration-150"
          style={{ width: `${progress * 100}%` }}
        />
      </div>

      <span className="w-24 text-right font-mono text-xs text-ink-faint">
        {replay.position}/{replay.length}
      </span>

      <div className="flex gap-1">
        {SPEEDS.map((s) => (
          <button
            key={s}
            type="button"
            onClick={() => replay.setSpeed(s)}
            className={`rounded-sm border px-1.5 py-0.5 text-xs font-semibold ${
              replay.speed === s
                ? "border-win/50 text-win"
                : "border-line text-ink-faint hover:text-ink"
            }`}
          >
            {s}×
          </button>
        ))}
      </div>
    </div>
  );
}
