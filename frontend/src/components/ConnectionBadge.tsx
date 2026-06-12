import type { ConnStatus } from "../state/reducer";
import { useRun } from "../state/RunContext";
import { WifiOffIcon } from "./Icons";

interface StyleDef {
  label: string;
  dot: string;
  text: string;
  breathe: boolean;
}

const STYLES: Record<ConnStatus, StyleDef> = {
  idle:         { label: "STANDBY",       dot: "bg-ink-faint",  text: "text-ink-faint",  breathe: false },
  connecting:   { label: "CONNECTING",    dot: "bg-warn",       text: "text-warn",       breathe: true },
  live:         { label: "LIVE",          dot: "bg-ok",         text: "text-ok",         breathe: true },
  reconnecting: { label: "RECONNECTING",  dot: "bg-warn",       text: "text-warn",       breathe: true },
  complete:     { label: "COMPLETE",      dot: "bg-win",        text: "text-win",        breathe: false },
  offline:      { label: "OFFLINE",       dot: "bg-crit",       text: "text-crit",       breathe: false },
  replay:       { label: "REPLAY",        dot: "bg-win",        text: "text-win",        breathe: false },
};

export function ConnectionBadge({ conn }: { conn: ConnStatus }) {
  const { reconnect } = useRun();
  const s = STYLES[conn];

  return (
    <span
      className={`inline-flex items-center gap-2 rounded-sm border border-line px-2.5 py-1 text-xs font-semibold tracking-widest ${s.text}`}
      title={`Connection: ${s.label.toLowerCase()}`}
    >
      {conn === "offline" ? (
        <WifiOffIcon size={12} />
      ) : (
        <span
          className={`h-1.5 w-1.5 rounded-full ${s.dot} ${s.breathe ? "animate-breathe" : ""}`}
        />
      )}
      {s.label}
      {conn === "offline" && (
        <button
          type="button"
          onClick={reconnect}
          className="ml-1 rounded-sm border border-crit/40 bg-crit/10 px-1.5 py-0.5 text-[10px] font-semibold tracking-widest text-crit hover:bg-crit/20"
        >
          RETRY
        </button>
      )}
    </span>
  );
}
