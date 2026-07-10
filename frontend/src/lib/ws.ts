
import type { TelemetryEvent } from "../types/telemetry";
import { wsUrl } from "./api";

const BACKOFF_BASE_MS = 1000;
const BACKOFF_MAX_MS = 15000;
const MAX_ATTEMPTS = 10;

export interface RunSocketHandlers {
  /** fires before any event arrives on each (re)connect */
  onOpen: () => void;
  onEvent: (event: TelemetryEvent) => void;
  /** fires when the connection drops and a retry is scheduled */
  onReconnecting: (attempt: number) => void;
  /** stream ended cleanly (__stream_complete__ or close code 1000) */
  onComplete: () => void;
  /** max reconnect attempts exhausted */
  onOffline: () => void;
}

export class RunSocket {
  private ws: WebSocket | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private attempt = 0;
  private closed = false;
  // prevents reconnect in onclose after clean stream end
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
        if (data.event === "__stream_complete__") {
          this.streamComplete = true;
          return;
        }
        if (data.event === "__keepalive__") return;
        this.handlers.onEvent(data as unknown as TelemetryEvent);
      } catch {
        // A malformed frame must never kill the stream.
      }
    };

    ws.onclose = (event: CloseEvent) => {
      if (this.closed) return;
      if (event.code === 1000 || this.streamComplete) {
        this.handlers.onComplete();
        return;
      }
      this.scheduleReconnect();
    };

    ws.onerror = () => {
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
    const base = Math.min(BACKOFF_BASE_MS * 2 ** (this.attempt - 1), BACKOFF_MAX_MS);
    const jitter = base * (0.75 + Math.random() * 0.5);
    this.timer = setTimeout(() => {
      this.timer = null;
      this.connect();
    }, jitter);
  }

  /** resets attempt counter and reconnects */
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
