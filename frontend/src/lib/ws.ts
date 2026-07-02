/**
 * Auto-reconnecting WebSocket client for /ws/{run_id}.
 *
 * Close semantics (matches saboteur/telemetry/ws.py):
 *   - Server sends `{"event":"__stream_complete__"}` control frame then closes
 *     with code 1000 / reason "run_finished" when the stream is exhausted.
 *   - Code 1000 OR the control frame → stream is COMPLETE, do NOT reconnect.
 *   - Any other close → reconnect with exponential backoff + jitter.
 *
 * Resync contract (invariant #3): the server replays the entire JSONL backlog
 * on every connect, then streams live. The reducer deduplicates by event
 * identity so a reconnect that re-sends the backlog produces zero state
 * changes and zero re-renders.
 */

import type { TelemetryEvent } from "../types/telemetry";
import { wsUrl } from "./api";

const BACKOFF_BASE_MS = 1000;
const BACKOFF_MAX_MS = 15000;
const MAX_ATTEMPTS = 10;

export interface RunSocketHandlers {
  /** Fires on every successful (re)connect, before any event arrives. */
  onOpen: () => void;
  onEvent: (event: TelemetryEvent) => void;
  /** Fires when the connection drops and a retry is scheduled. */
  onReconnecting: (attempt: number) => void;
  /** Stream ended cleanly (__stream_complete__ or close code 1000). */
  onComplete: () => void;
  /** Max reconnect attempts exhausted. */
  onOffline: () => void;
}

export class RunSocket {
  private ws: WebSocket | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private attempt = 0;
  private closed = false;
  /** Set when we receive __stream_complete__ - prevents reconnect in onclose. */
  private streamComplete = false;

  constructor(
    private readonly runId: string,
    private readonly handlers: RunSocketHandlers,
  ) {}

  connect(): void {
    if (this.closed) return;
    this.streamComplete = false;
    const ws = new WebSocket(wsUrl(this.runId));
    this.ws = ws;

    ws.onopen = () => {
      this.attempt = 0;
      this.handlers.onOpen();
    };

    ws.onmessage = (msg: MessageEvent<string>) => {
      try {
        const data = JSON.parse(msg.data) as Record<string, unknown>;
        // Detect the __stream_complete__ control frame (transport-only, never
        // a TelemetryEvent - see saboteur/telemetry/ws.py).
        if (data.event === "__stream_complete__") {
          this.streamComplete = true;
          // The server will close with code 1000 right after this frame.
          // We handle completion in onclose to keep a single path.
          return;
        }
        // Idle keepalive control frame - drop it, never dispatch to the reducer.
        if (data.event === "__keepalive__") return;
        this.handlers.onEvent(data as unknown as TelemetryEvent);
      } catch {
        // A malformed frame must never kill the stream.
      }
    };

    ws.onclose = (event: CloseEvent) => {
      if (this.closed) return;
      // Clean close: code 1000 OR we saw __stream_complete__ → finished.
      if (event.code === 1000 || this.streamComplete) {
        this.handlers.onComplete();
        return;
      }
      // Unexpected close → reconnect with backoff.
      this.scheduleReconnect();
    };

    ws.onerror = () => {
      // onclose always follows onerror; reconnect is handled there.
      ws.close();
    };
  }

  private scheduleReconnect(): void {
    if (this.timer !== null || this.closed) return;
    this.attempt += 1;
    if (this.attempt > MAX_ATTEMPTS) {
      this.handlers.onOffline();
      return;
    }
    this.handlers.onReconnecting(this.attempt);
    // Exponential backoff with ±25% jitter, capped at 15s.
    const base = Math.min(BACKOFF_BASE_MS * 2 ** (this.attempt - 1), BACKOFF_MAX_MS);
    const jitter = base * (0.75 + Math.random() * 0.5);
    this.timer = setTimeout(() => {
      this.timer = null;
      this.connect();
    }, jitter);
  }

  /** Manual reconnect (resets attempt counter). */
  reconnect(): void {
    this.attempt = 0;
    this.closed = false;
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.ws?.close();
    this.ws = null;
    this.connect();
  }

  close(): void {
    this.closed = true;
    if (this.timer !== null) clearTimeout(this.timer);
    this.ws?.close();
    this.ws = null;
  }
}
