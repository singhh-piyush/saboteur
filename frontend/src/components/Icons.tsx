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
