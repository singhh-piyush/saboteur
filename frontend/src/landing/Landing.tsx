/**
 * SABOTEUR product landing page - a chrome-less, single-scrolling marketing
 * view that is visually indistinguishable from the chaos console: it reuses the
 * console's @theme tokens, fonts, primitives, and motion. Mounted as the default
 * top-level view; "Launch Console" flips the hash router to the live dashboard
 * with no reload (see App.tsx).
 *
 * The console app is fixed-height (`body { overflow: hidden }`), so this view
 * owns its own scroll container.
 */

import { useState } from "react";
import { Play } from "lucide-react";

import { CTAButton, scrollToId, Wordmark } from "./parts";
import { Hero } from "./Hero";
import { Intro, introShouldSkip } from "./Intro";
import { ProblemSection } from "./ProblemSection";
import { HowItWorks } from "./HowItWorks";
import { FaultTaxonomy } from "./FaultTaxonomy";
import { ScorecardSection } from "./ScorecardSection";
import { CiGateSection } from "./CiGateSection";
import { AmdSection } from "./AmdSection";
import { Roadmap } from "./Roadmap";
import { Footer } from "./Footer";

const NAV: { id: string; label: string }[] = [
  { id: "how-it-works", label: "How it works" },
];

export function Landing({ onLaunch, onWatch }: { onLaunch: () => void; onWatch: () => void }) {
  const [introDone, setIntroDone] = useState(introShouldSkip);
  return (
    <div className="h-screen overflow-y-auto scroll-smooth bg-void text-ink">
      {!introDone && <Intro onDone={() => setIntroDone(true)} />}
      {/* Sticky top bar - wordmark + CTAs, mirroring the console header. */}
      <div className="sticky top-0 z-30 border-b border-line bg-void/85 backdrop-blur-md">
        <div className="mx-auto flex w-full max-w-6xl items-center gap-4 px-5 py-3 sm:px-8">
          <button type="button" onClick={onWatch} className="flex items-center gap-3">
            <Wordmark className="text-xl" />
            <span className="hidden rounded-sm border border-accent/50 bg-accent/10 px-2 py-1 text-[10px] font-bold leading-none tracking-[0.3em] text-accent sm:inline-block">
              CHAOS CONSOLE
            </span>
          </button>

          <nav className="ml-auto hidden items-center gap-1 sm:flex">
            {NAV.map(({ id, label }) => (
              <button
                key={id}
                type="button"
                onClick={() => scrollToId(id)}
                className="rounded-sm px-2.5 py-1 text-[11px] font-bold uppercase tracking-[0.16em] text-ink-faint transition-colors duration-150 hover:bg-raised hover:text-ink"
              >
                {label}
              </button>
            ))}
          </nav>

          <div className="ml-auto flex items-center gap-2 sm:ml-0">
            <CTAButton onClick={onLaunch} variant="ghost" size="sm">
              Console
            </CTAButton>
            <CTAButton onClick={onWatch} size="sm">
              <Play size={13} />
              Watch the demo
            </CTAButton>
          </div>
        </div>
      </div>

      <main>
        <Hero onLaunch={onLaunch} onWatch={onWatch} />
        <ProblemSection />
        <HowItWorks />
        <FaultTaxonomy />
        <ScorecardSection />
        <CiGateSection />
        <AmdSection />
        <Roadmap />
      </main>

      <Footer onLaunch={onLaunch} onWatch={onWatch} />
    </div>
  );
}
