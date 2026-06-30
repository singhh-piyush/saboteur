import { GitBranch, Play } from "lucide-react";

import { Container, CTAButton, Wordmark } from "./parts";

const REPO_URL = "https://github.com/singhh-piyush/saboteur";

export function Footer({ onLaunch, onWatch }: { onLaunch: () => void; onWatch: () => void }) {
  return (
    <footer className="border-t border-line">
      <Container className="flex flex-col items-start justify-between gap-8 py-14 sm:flex-row sm:items-center">
        <div>
          <Wordmark className="block text-3xl" />
          <p className="mt-2 text-sm text-ink-dim">Chaos engineering for AI agents.</p>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <CTAButton onClick={onWatch}>
            <Play size={15} />
            Watch the demo
          </CTAButton>
          <CTAButton href={REPO_URL} variant="ghost">
            <GitBranch size={15} />
            GitHub
          </CTAButton>
          <CTAButton onClick={onLaunch} variant="ghost">
            Console (local)
          </CTAButton>
        </div>
      </Container>

      <Container className="border-t border-line py-5">
        <p className="text-[11px] text-ink-faint">
          Built for the AMD Developer Hackathon · ACT II.
        </p>
      </Container>
    </footer>
  );
}
