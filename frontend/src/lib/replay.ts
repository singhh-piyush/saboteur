
import type { Action } from "../state/reducer";
import type { TelemetryEvent } from "../types/telemetry";

const MAX_GAP_MS = 2000;

export interface ReplayOptions {
  /** min inter-event delay before speed divisor (default 0ms) */
  minGapMs?: number;
  /** max inter-event delay before speed divisor (default 2000ms) */
  maxGapMs?: number;
}

export class ReplayDriver {
  private index = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private _playing = false;
  private readonly minGapMs: number;
  private readonly maxGapMs: number;
  speed = 4;

  constructor(
    private readonly events: TelemetryEvent[],
    private readonly dispatch: (action: Action) => void,
    private readonly onTick?: (index: number, total: number, playing: boolean) => void,
    options?: ReplayOptions,
  ) {
    this.minGapMs = options?.minGapMs ?? 0;
    this.maxGapMs = options?.maxGapMs ?? MAX_GAP_MS;
  }

  get length(): number {
    return this.events.length;
  }

  get position(): number {
    return this.index;
  }

  get playing(): boolean {
    return this._playing;
  }

  restart(): void {
    this.pause();
    this.index = 0;
    this.dispatch({ type: "reset" });
    this.dispatch({ type: "conn", conn: "replay" });
    this.notify();
  }

  play(): void {
    if (this._playing || this.index >= this.events.length) return;
    if (this.index === 0) {
      this.dispatch({ type: "reset" });
      this.dispatch({ type: "conn", conn: "replay" });
    }
    this._playing = true;
    this.notify();
    this.step();
  }

  pause(): void {
    this._playing = false;
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.notify();
  }

  /** dispatch every remaining event synchronously (skip-to-end) */
  runToEnd(): void {
    this.pause();
    if (this.index === 0) {
      this.dispatch({ type: "reset" });
      this.dispatch({ type: "conn", conn: "replay" });
    }
    while (this.index < this.events.length) {
      this.dispatch({ type: "event", event: this.events[this.index] });
      this.index += 1;
    }
    this.notify();
  }

  dispose(): void {
    this.pause();
  }

  private step(): void {
    if (!this._playing) return;
    if (this.index >= this.events.length) {
      this._playing = false;
      this.notify();
      return;
    }
    this.dispatch({ type: "event", event: this.events[this.index] });
    this.index += 1;
    this.notify();

    if (this.index >= this.events.length) {
      this._playing = false;
      this.notify();
      return;
    }
    const gap = this.gapMs(this.index);
    this.timer = setTimeout(() => this.step(), gap);
  }

  /** seek to event index `i`; re-derives state from scratch (correct for backward scrub) */
  seek(i: number): void {
    this.pause();
    const target = Math.max(0, Math.min(i, this.events.length));
    this.dispatch({ type: "reset" });
    this.dispatch({ type: "conn", conn: "replay" });
    for (let k = 0; k < target; k++) {
      this.dispatch({ type: "event", event: this.events[k] });
    }
    this.index = target;
    this.notify();
  }

  private gapMs(i: number): number {
    const prev = Date.parse(this.events[i - 1].ts);
    const cur = Date.parse(this.events[i].ts);
    const raw = Number.isFinite(prev) && Number.isFinite(cur) ? cur - prev : 0;
    return Math.min(Math.max(raw, this.minGapMs), this.maxGapMs) / this.speed;
  }

  private notify(): void {
    this.onTick?.(this.index, this.events.length, this._playing);
  }
}
