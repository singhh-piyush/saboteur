/**
 * Shared landing-page primitives. Everything here is built from the console's
 * existing @theme tokens (index.css) - no new palette, type scale, or spacing.
 */

import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";

/** Wide, centered content column with the console's gutter rhythm. */
export function Container({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <div className={`mx-auto w-full max-w-6xl px-5 sm:px-8 ${className}`}>{children}</div>;
}

/**
 * Smooth-scroll to an in-page section by id WITHOUT touching the URL hash -
 * the app is hash-routed, so a real `#anchor` link would be parsed as an
 * unknown route and bounce the user into the console. Use this for on-page nav.
 */
export function scrollToId(id: string) {
  document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" });
}

/**
 * A page section: vertical breathing room + a centered content column. Motion
 * lives on the children now (per-element `<Reveal>` staggers), not on the
 * whole block - so the section just provides layout.
 */
export function Section({
  id,
  children,
  className = "",
}: {
  id?: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section id={id} className={`py-16 sm:py-24 ${className}`}>
      <Container>{children}</Container>
    </section>
  );
}

/** Reveals once when the element scrolls into view. */
export function useReveal<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [shown, setShown] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (typeof IntersectionObserver === "undefined") {
      setShown(true);
      return;
    }
    const io = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setShown(true);
          io.disconnect();
        }
      },
      { threshold: 0.12, rootMargin: "0px 0px -8% 0px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);

  return { ref, shown };
}

export function prefersReducedMotion(): boolean {
  return (
    typeof matchMedia !== "undefined" &&
    matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

type RevealDir = "up" | "left" | "right";

/** Props to spread onto a semantic element (e.g. an `<li>`) so it reveals on
 * scroll without an extra wrapper div. Merge your own classes AFTER. */
export function useRevealProps<T extends HTMLElement>(delay = 0, dir: RevealDir = "up") {
  const { ref, shown } = useReveal<T>();
  return {
    ref,
    "data-dir": dir,
    className: `reveal ${shown ? "is-visible" : ""}`,
    style: { "--reveal-delay": `${delay}ms` } as CSSProperties,
  };
}

/**
 * Wrap any block so it fades + rises into view on scroll. `delay` (ms) staggers
 * siblings via the `--reveal-delay` CSS var; `dir` picks the slide axis. The
 * reveal CSS lives in index.css; reduced-motion shows it instantly.
 */
export function Reveal({
  children,
  delay = 0,
  dir = "up",
  className = "",
}: {
  children: ReactNode;
  delay?: number;
  dir?: RevealDir;
  className?: string;
}) {
  const { ref, shown } = useReveal<HTMLDivElement>();
  return (
    <div
      ref={ref}
      data-dir={dir}
      className={`reveal ${shown ? "is-visible" : ""} ${className}`}
      style={{ "--reveal-delay": `${delay}ms` } as CSSProperties}
    >
      {children}
    </div>
  );
}

/**
 * Counts a number up from 0 to `to` (ease-out cubic, ~900ms) the first time it
 * scrolls into view. `format` turns the running value into display text. Starts
 * at 0 and is offscreen until revealed, so there is no visible jump.
 */
export function CountUp({
  to,
  format,
  className = "",
}: {
  to: number;
  format: (n: number) => string;
  className?: string;
}) {
  const { ref, shown } = useReveal<HTMLSpanElement>();
  const [value, setValue] = useState(0);

  useEffect(() => {
    if (!shown) return;
    if (prefersReducedMotion()) {
      setValue(to);
      return;
    }
    let raf = 0;
    const t0 = performance.now();
    const dur = 900;
    const tick = (t: number) => {
      const p = Math.min((t - t0) / dur, 1);
      setValue(to * (1 - Math.pow(1 - p, 3)));
      if (p < 1) raf = requestAnimationFrame(tick);
      else setValue(to);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [shown, to]);

  return (
    <span ref={ref} className={className}>
      {format(value)}
    </span>
  );
}

/** The console's micro-label recipe (accent tick + caps tracked label). */
export function Eyebrow({ children }: { children: ReactNode }) {
  return (
    <div className="mb-4 flex items-center gap-2">
      <span aria-hidden className="h-3.5 w-[3px] shrink-0 rounded-full bg-accent" />
      <span className="text-[11px] font-semibold uppercase tracking-[0.18em] text-ink-dim">
        {children}
      </span>
    </div>
  );
}

/** Section heading - display font, primary ink, no hype. */
export function Heading({ children, className = "" }: { children: ReactNode; className?: string }) {
  return (
    <h2 className={`font-display text-3xl font-bold leading-tight tracking-tight text-ink sm:text-4xl ${className}`}>
      {children}
    </h2>
  );
}

/** Body copy under a heading. */
export function Lede({ children, className = "" }: { children: ReactNode; className?: string }) {
  return (
    <p className={`max-w-2xl text-base leading-relaxed text-ink-dim sm:text-lg ${className}`}>
      {children}
    </p>
  );
}

/**
 * Shared card hover treatment: the border turns accent orange with a soft orange
 * glow. Border-color + box-shadow only (no transform) so it is safe even on the
 * scroll-reveal elements that already drive their own transform.
 */
export const CARD_HOVER =
  "transition-[border-color,box-shadow] duration-200 hover:border-accent hover:shadow-[0_0_28px_-6px_color-mix(in_oklch,var(--color-accent)_40%,transparent)]";

/** A floating panel card - the UI-v3 modular look (border-line + bg-panel). */
export function Panel({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <div className={`rounded-lg border border-line bg-panel ${CARD_HOVER} ${className}`}>{children}</div>;
}

/** The SABOTEUR wordmark - `font-brand` only, with the console's accent glow. */
export function Wordmark({ className = "" }: { className?: string }) {
  return (
    <span
      className={`font-brand font-extrabold leading-none tracking-[0.22em] text-ink transition-all duration-200 hover:text-accent hover:[text-shadow:0_0_24px_color-mix(in_oklch,var(--color-accent)_55%,transparent)] ${className}`}
    >
      SABOTEUR
    </span>
  );
}

type CTAProps = {
  children: ReactNode;
  onClick?: () => void;
  href?: string;
  variant?: "primary" | "ghost";
  size?: "md" | "sm";
  className?: string;
};

/**
 * Call-to-action button. `primary` mirrors the console's launch button
 * (accent-outlined, accent-tinted, glow on hover); `ghost` is the neutral
 * bordered action used across the console nav.
 */
export function CTAButton({ children, onClick, href, variant = "primary", size = "md", className = "" }: CTAProps) {
  const sizing = size === "sm" ? "px-3.5 py-1.5 text-xs" : "px-5 py-2.5 text-sm";
  const base = `inline-flex items-center justify-center gap-2 rounded-sm font-semibold tracking-wide transition-all duration-200 ${sizing}`;
  const styles =
    variant === "primary"
      ? "border border-accent/60 bg-accent/10 text-accent hover:bg-accent/20 hover:shadow-[0_0_24px_-6px_var(--color-accent)]"
      : "border border-line text-ink-dim hover:bg-raised hover:text-ink";
  const cls = `${base} ${styles} ${className}`;

  if (href) {
    return (
      <a href={href} className={cls}>
        {children}
      </a>
    );
  }
  return (
    <button type="button" onClick={onClick} className={cls}>
      {children}
    </button>
  );
}

/** A monospace code block on the console's raised surface. */
export function CodeBlock({ children, className = "" }: { children: ReactNode; className?: string }) {
  return (
    <pre
      className={`overflow-x-auto rounded-md border border-line bg-raised px-4 py-3 font-mono text-[13px] leading-relaxed text-ink ${className}`}
    >
      {children}
    </pre>
  );
}
