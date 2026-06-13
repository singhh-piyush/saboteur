import React from "react";

interface PanelHeaderProps {
  title: React.ReactNode;
  /** Optional right-aligned slot (counts, buttons). */
  right?: React.ReactNode;
  /** When provided, renders a collapse chevron and makes the header clickable. */
  collapsed?: boolean;
  onToggle?: () => void;
}

/**
 * Unified section header for every panel card: accent tick + bold caps title.
 * Replaces the assorted dim-grey caps headers so all panels share one look.
 */
export function PanelHeader({ title, right, collapsed, onToggle }: PanelHeaderProps) {
  const collapsible = onToggle !== undefined;

  const inner = (
    <>
      <span className="flex min-w-0 items-center gap-2">
        <span aria-hidden className="h-3.5 w-[3px] shrink-0 rounded-full bg-accent" />
        <h2 className="truncate text-xs font-bold uppercase tracking-[0.18em] text-ink">
          {title}
        </h2>
      </span>
      <span className="flex shrink-0 items-center gap-2">
        {right}
        {collapsible && (
          <svg
            width="10"
            height="6"
            viewBox="0 0 10 6"
            fill="none"
            aria-hidden
            className="text-ink-faint transition-transform duration-200"
            style={{ transform: collapsed ? "rotate(-90deg)" : "rotate(0deg)" }}
          >
            <path
              d="M1 1l4 4 4-4"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        )}
      </span>
    </>
  );

  if (collapsible) {
    return (
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={!collapsed}
        className="flex w-full cursor-pointer items-center justify-between border-b border-line px-3 py-2 text-left transition-colors duration-150 hover:bg-raised/60"
      >
        {inner}
      </button>
    );
  }

  return (
    <header className="flex items-center justify-between border-b border-line px-3 py-2">
      {inner}
    </header>
  );
}
