/**
 * ReplayDriver - re-drives the SAME reducer with a recorded event array.
 *
 * Replay and live are identical by construction: both paths dispatch
 * `{type:"reset"}` followed by `{type:"event"}` actions in event order; the
 * only difference is pacing. `runToEnd()` (synchronous) is what the
 * invariant #3 test uses; `play()` paces dispatches by the recorded
 * timestamp gaps scaled by `speed`.
 */

import type { Action } from "../state/reducer";
import type { TelemetryEvent } from "../types/telemetry";

/** A single long gap (e.g. between control and chaos cohorts) is capped so
 * replay never appears to stall. */
const MAX_GAP_MS = 2000;

export class ReplayDriver {
  private index = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private _playing = false;
  speed = 4;

  constructor(
    private readonly events: TelemetryEvent[],
    private readonly dispatch: (action: Action) => void,
    private readonly onTick?: (index: number, total: number, playing: boolean) => void,
  ) {}

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

  /** Dispatch every remaining event synchronously (tests + "skip to end"). */
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

  private gapMs(i: number): number {
    const prev = Date.parse(this.events[i - 1].ts);
    const cur = Date.parse(this.events[i].ts);
    const raw = Number.isFinite(prev) && Number.isFinite(cur) ? cur - prev : 0;
    return Math.min(Math.max(raw, 0), MAX_GAP_MS * this.speed) / this.speed;
  }

  private notify(): void {
    this.onTick?.(this.index, this.events.length, this._playing);
  }
}
