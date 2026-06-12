import type { ConnStatus } from "../state/reducer";

const STYLES: Record<ConnStatus, { label: string; dot: string; text: string; breathe: boolean }> = {
  idle: { label: "STANDBY", dot: "bg-ink-faint", text: "text-ink-faint", breathe: false },
  connecting: { label: "CONNECTING", dot: "bg-warn", text: "text-warn", breathe: true },
  live: { label: "LIVE", dot: "bg-ok", text: "text-ok", breathe: true },
  reconnecting: { label: "RECONNECTING", dot: "bg-warn", text: "text-warn", breathe: true },
  replay: { label: "REPLAY", dot: "bg-win", text: "text-win", breathe: false },
};

export function ConnectionBadge({ conn }: { conn: ConnStatus }) {
  const s = STYLES[conn];
  return (
    <span
      className={`inline-flex items-center gap-2 rounded-sm border border-line px-2.5 py-1 text-[11px] font-semibold tracking-[0.18em] ${s.text}`}
      title={`Connection: ${s.label.toLowerCase()}`}
    >
      <span
        className={`h-1.5 w-1.5 rounded-full ${s.dot} ${s.breathe ? "animate-breathe" : ""}`}
      />
      {s.label}
    </span>
  );
}
