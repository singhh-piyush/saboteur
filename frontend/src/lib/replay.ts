/**
 * ReplayDriver - re-drives the SAME reducer with a recorded event array.
 *
 * Replay and live are identical by construction: both paths dispatch
 * `{type:"reset"}` followed by `{type:"event"}` actions in event order; the
 * only difference is pacing. `runToEnd()` (synchronous) is what the
 * invariant #3 test uses; `play()` paces dispatches by the recorded
 * timestamp gaps scaled by `speed`.
 *
 * Gap clamping is configurable. The live console keeps the default cap (a long
 * gap between control and chaos cohorts must not stall replay). The static
 * walkthrough passes a tight `[minGapMs, maxGapMs]` window so a recorded run
 * feels live and a 15s injected-latency gap never freezes the guided tour.
 */

import type { Action } from "../state/reducer";
import type { TelemetryEvent } from "../types/telemetry";

/** A single long gap (e.g. between control and chaos cohorts) is capped so
 * replay never appears to stall. */
const MAX_GAP_MS = 2000;

export interface ReplayOptions {
  /** Floor for the inter-event delay before dividing by speed (default 0). */
  minGapMs?: number;
  /** Ceiling for the inter-event delay before dividing by speed (default 2000). */
  maxGapMs?: number;
}

export class ReplayDriver {
  private index = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private sprintRaf: number | null = null;
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
    this.cancelSprint();
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
    this.cancelSprint();
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

  /** Jump to event `i` (0..length): re-derive state from a fresh reducer by
   * folding events[0..i). Correct for backward scrub - the reducer is pure, so
   * folding from the start always reproduces the exact state at that index. */
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

  /** Animated forward seek: fold the remaining events steadily over
   * `durationMs` (eased), so the UI shows a rapid time-lapse of the run
   * resolving instead of an instant jump. Ends paused at `target`. Backward
   * targets fall back to an instant `seek` (the reducer only folds forward),
   * as does a missing rAF (SSR / tests). Any play/pause/seek cancels a sprint
   * in flight. */
  sprintTo(target: number, durationMs = 1000): void {
    const to = Math.max(0, Math.min(target, this.events.length));
    if (
      to <= this.index ||
      durationMs <= 0 ||
      typeof requestAnimationFrame === "undefined"
    ) {
      this.seek(to);
      return;
    }
    this.pause(); // stops the transport and any previous sprint
    const from = this.index;
    const t0 = performance.now();
    const tick = (now: number) => {
      this.sprintRaf = null;
      const p = Math.min((now - t0) / durationMs, 1);
      // Ease-in-out: the rush starts and lands gently.
      const eased = p < 0.5 ? 2 * p * p : 1 - (2 - 2 * p) ** 2 / 2;
      const idx = from + Math.round((to - from) * eased);
      while (this.index < idx) {
        this.dispatch({ type: "event", event: this.events[this.index] });
        this.index += 1;
      }
      this.notify();
      if (p < 1) this.sprintRaf = requestAnimationFrame(tick);
    };
    this.sprintRaf = requestAnimationFrame(tick);
  }

  private cancelSprint(): void {
    if (this.sprintRaf !== null) {
      cancelAnimationFrame(this.sprintRaf);
      this.sprintRaf = null;
    }
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
