import { AlertTriangle, Gauge, Scissors, EyeOff } from "lucide-react";
import type { LucideIcon } from "lucide-react";

import { Eyebrow, Heading, Lede, Panel, Reveal, Section } from "./parts";

const FAILURES: { icon: LucideIcon; title: string; body: string }[] = [
  {
    icon: AlertTriangle,
    title: "API 500s & timeouts",
    body: "The model endpoint or a tool returns an error, or never returns at all. Does the agent retry, or fall over?",
  },
  {
    icon: Gauge,
    title: "Rate limits",
    body: "A 429 with Retry-After mid-task. Does the agent back off and resume, or spin into an infinite retry?",
  },
  {
    icon: Scissors,
    title: "Context truncation",
    body: "Earlier steps drop out of memory between turns. Does the agent notice the gap, or repeat itself?",
  },
  {
    icon: EyeOff,
    title: "Well-formed, wrong data",
    body: "A tool returns valid JSON with a wrong value. Does the agent trust it, or cross-check and catch the lie?",
  },
];

export function ProblemSection() {
  return (
    <Section>
      <Reveal><Eyebrow>The problem</Eyebrow></Reveal>
      <Reveal delay={70}><Heading>Agents break in production.</Heading></Reveal>
      <Reveal delay={140}>
        <Lede className="mt-4">
          The failure modes that take down an agent aren't in your unit tests. They show up
          live, under load, when a dependency degrades - and there's no standard pre-deploy
          resilience test for agents today.
        </Lede>
      </Reveal>

      <div className="mt-10 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {FAILURES.map(({ icon: Icon, title, body }, i) => (
          <Reveal key={title} delay={210 + i * 70}>
            <Panel className="h-full p-5">
              <Icon size={18} className="text-accent" />
              <h3 className="mt-3 text-sm font-semibold text-ink">{title}</h3>
              <p className="mt-1.5 text-sm leading-relaxed text-ink-dim">{body}</p>
            </Panel>
          </Reveal>
        ))}
      </div>
    </Section>
  );
}
