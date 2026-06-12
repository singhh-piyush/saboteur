/**
 * Auto-reconnecting WebSocket client for /ws/{run_id}.
 *
 * Resync contract (invariant #3): the server replays the entire JSONL
 * backlog on every connect, then streams live. So on EVERY open — first
 * connect or reconnect — `onOpen` fires first; the consumer dispatches a
 * reducer reset and rebuilds state from the replayed backlog. Killing and
 * restarting the backend mid-run therefore recovers without a refresh.
 */

import type { TelemetryEvent } from "../types/telemetry";

const BACKOFF_MIN_MS = 500;
const BACKOFF_MAX_MS = 8000;

export interface RunSocketHandlers {
  /** Fires on every successful (re)connect, before any event arrives. */
  onOpen: () => void;
  onEvent: (event: TelemetryEvent) => void;
  /** Fires when the connection drops and a retry is scheduled. */
  onReconnecting: () => void;
}

export class RunSocket {
  private ws: WebSocket | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private backoff = BACKOFF_MIN_MS;
  private closed = false;

  constructor(
    private readonly runId: string,
    private readonly handlers: RunSocketHandlers,
  ) {}

  connect(): void {
    if (this.closed) return;
    const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
    const url = `${proto}//${window.location.host}/ws/${encodeURIComponent(this.runId)}`;
    const ws = new WebSocket(url);
    this.ws = ws;

    ws.onopen = () => {
      this.backoff = BACKOFF_MIN_MS;
      this.handlers.onOpen();
    };
    ws.onmessage = (msg: MessageEvent<string>) => {
      try {
        this.handlers.onEvent(JSON.parse(msg.data) as TelemetryEvent);
      } catch {
        // A malformed frame must never kill the stream.
      }
    };
    ws.onclose = () => {
      if (this.closed) return;
      this.handlers.onReconnecting();
      this.scheduleReconnect();
    };
    ws.onerror = () => {
      // onclose always follows onerror; reconnect is handled there.
      ws.close();
    };
  }

  private scheduleReconnect(): void {
    if (this.timer !== null) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.connect();
    }, this.backoff);
    this.backoff = Math.min(this.backoff * 2, BACKOFF_MAX_MS);
  }

  close(): void {
    this.closed = true;
    if (this.timer !== null) clearTimeout(this.timer);
    this.ws?.close();
    this.ws = null;
  }
}
