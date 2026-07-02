import { ArrowRight, Play } from "lucide-react";

import { CARD_HOVER, Container, CTAButton, Wordmark } from "./parts";
import { HeroGrid } from "./HeroGrid";

export function Hero({ onLaunch, onWatch }: { onLaunch: () => void; onWatch: () => void }) {
  return (
    <header className="relative overflow-hidden border-b border-line">
      <Container className="grid items-center gap-12 py-20 sm:py-28 lg:grid-cols-2 lg:gap-10">
        {/* Copy */}
        <div style={{ animation: "card-in 0.5s ease-out backwards" }}>
          <Wordmark className="block text-5xl sm:text-7xl" glitch="ambient" />

          <p className="mt-6 font-display text-2xl font-semibold tracking-tight text-ink sm:text-3xl">
            Chaos engineering for AI agents.
          </p>

          <p className="mt-4 max-w-xl text-base leading-relaxed text-ink-dim sm:text-lg">
            You wouldn't ship a microservice without load testing. Don't ship an
            agent without chaos testing.
          </p>

          <div className="mt-8 flex flex-wrap items-center gap-3">
            <CTAButton onClick={onWatch}>
              <Play size={15} />
              Watch the demo
            </CTAButton>
            <CTAButton onClick={onLaunch} variant="ghost">
              Launch Console (local)
              <ArrowRight size={16} />
            </CTAButton>
          </div>
        </div>

        {/* Live-feeling product preview */}
        <div
          className={`rounded-lg border border-line bg-panel p-3 sm:p-4 ${CARD_HOVER}`}
          style={{ animation: "card-in 0.5s ease-out 120ms backwards" }}
        >
          <div className="mb-3 flex items-center justify-between px-1">
            <span className="text-[11px] font-semibold uppercase tracking-[0.18em] text-ink-dim">
              Cohort · hell_mode
            </span>
            <span className="inline-flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-widest text-accent">
              <span className="animate-breathe h-1.5 w-1.5 rounded-full bg-accent" />
              live
            </span>
          </div>
          <HeroGrid />
        </div>
      </Container>
    </header>
  );
}
