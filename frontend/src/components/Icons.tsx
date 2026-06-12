/** Minimal inline SVG glyph set — no emoji, no icon library. */

import type { CSSProperties } from "react";

interface IconProps {
  size?: number;
  className?: string;
  style?: CSSProperties;
}

export function BoltIcon({ size = 12, className, style }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="currentColor"
      className={className}
      style={style}
      aria-hidden
    >
      <path d="M9.5 1 3 9h3.5L6 15l6.5-8H9z" />
    </svg>
  );
}

export function LoopIcon({ size = 12, className, style }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      className={className}
      style={style}
      aria-hidden
    >
      <path d="M13 8a5 5 0 1 1-1.5-3.5" />
      <path d="M13 1v3.5H9.5" fill="none" />
    </svg>
  );
}

export function FlagIcon({ size = 12, className, style }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="currentColor"
      className={className}
      style={style}
      aria-hidden
    >
      <path d="M3 1.5h1.5v13H3zM6 2h7l-2 3 2 3H6z" />
    </svg>
  );
}

export function CrossIcon({ size = 12, className, style }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      className={className}
      style={style}
      aria-hidden
    >
      <path d="M3.5 3.5l9 9M12.5 3.5l-9 9" />
    </svg>
  );
}

export function PlayIcon({ size = 12, className, style }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="currentColor" className={className} style={style} aria-hidden>
      <path d="M4 2.5v11l9-5.5z" />
    </svg>
  );
}

export function PauseIcon({ size = 12, className, style }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="currentColor" className={className} style={style} aria-hidden>
      <path d="M4 2.5h3v11H4zM9 2.5h3v11H9z" />
    </svg>
  );
}

export function RestartIcon({ size = 12, className, style }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      className={className}
      style={style}
      aria-hidden
    >
      <path d="M3 8a5 5 0 1 0 1.5-3.5" />
      <path d="M3 1.5V5h3.5" />
    </svg>
  );
}

export function SkipIcon({ size = 12, className, style }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="currentColor" className={className} style={style} aria-hidden>
      <path d="M3 2.5v11l7-5.5zM11.5 2.5h2v11h-2z" />
    </svg>
  );
}

/** Filled circle — healthy / nominal status. */
export function CircleIcon({ size = 12, className, style }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="currentColor" className={className} style={style} aria-hidden>
      <circle cx="8" cy="8" r="5" />
    </svg>
  );
}

/** Dashed circle — pending / standby status. */
export function DashedCircleIcon({ size = 12, className, style }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeDasharray="3 2.5" className={className} style={style} aria-hidden>
      <circle cx="8" cy="8" r="5" />
    </svg>
  );
}

/** Checkmark icon for completed states. */
export function CheckIcon({ size = 12, className, style }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className} style={style} aria-hidden>
      <path d="M3.5 8.5l3 3 6-7" />
    </svg>
  );
}

/** Download icon. */
export function DownloadIcon({ size = 12, className, style }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" className={className} style={style} aria-hidden>
      <path d="M8 2v9M4.5 7.5 8 11l3.5-3.5M3 13h10" />
    </svg>
  );
}

/** Trash / delete icon. */
export function TrashIcon({ size = 12, className, style }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" className={className} style={style} aria-hidden>
      <path d="M3 4h10M5.5 4V2.5h5V4M6 6.5v5M8 6.5v5M10 6.5v5M4.5 4l.5 9.5h6l.5-9.5" />
    </svg>
  );
}

/** Eye / view icon for "Open" action. */
export function EyeIcon({ size = 12, className, style }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" className={className} style={style} aria-hidden>
      <path d="M1.5 8s2.5-4.5 6.5-4.5S14.5 8 14.5 8s-2.5 4.5-6.5 4.5S1.5 8 1.5 8z" />
      <circle cx="8" cy="8" r="2" />
    </svg>
  );
}

/** WiFi-off / disconnected icon. */
export function WifiOffIcon({ size = 12, className, style }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" className={className} style={style} aria-hidden>
      <path d="M2 2l12 12M3.5 5.5a8.5 8.5 0 0 1 5.6-1.9M12.5 5.5a8.5 8.5 0 0 0-1.5-.9M5.5 8a5.5 5.5 0 0 1 3.2-1.3M10.5 8a5.5 5.5 0 0 0-.7-.4" />
      <circle cx="8" cy="12" r="1" fill="currentColor" stroke="none" />
    </svg>
  );
}
