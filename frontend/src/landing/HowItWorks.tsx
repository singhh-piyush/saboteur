import { Eyebrow, Heading, Lede, Panel, Section } from "./parts";

const STEPS: { n: string; title: string; body: string }[] = [
  {
    n: "01",
    title: "Point your agent at the proxy",
    body: "Swap one environment variable. No SDK, no decorators, no code change - the proxy speaks the OpenAI wire protocol your agent already uses.",
  },
  {
    n: "02",
    title: "Saboteur injects faults",
    body: "Seeded and reproducible: the same profile + seed replays the exact same fault decisions for a given call sequence. Eight faults across tool, transport, and context.",
  },
  {
    n: "03",
    title: "Read the scorecard",
    body: "Survival, MTTR, recovery breakdown, deception detection, failure modes - a behavioral resilience profile, scored from the telemetry stream.",
  },
];

export function HowItWorks() {
  return (
    <Section id="how-it-works" className="scroll-mt-16 border-y border-line bg-panel/40">
      <Eyebrow>How it works</Eyebrow>
      <Heading>One env var. Zero code change.</Heading>
      <Lede className="mt-4">
        Point any OpenAI-compatible agent at the Saboteur proxy and it becomes the system
        under test. The BYO-agent path is the product - we sabotage agents we don't own.
      </Lede>

      {/* The before/after base-URL swap. */}
      <Panel className="mt-10 overflow-hidden">
        <div className="grid divide-y divide-line md:grid-cols-2 md:divide-x md:divide-y-0">
          <div className="p-5">
            <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-ink-faint">
              before
            </div>
            <pre className="mt-3 overflow-x-auto font-mono text-[13px] leading-relaxed text-ink-dim">
              OPENAI_BASE_URL=<span className="text-ink">https://api.openai.com/v1</span>
            </pre>
          </div>
          <div className="p-5">
            <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-accent">
              after - route through Saboteur
            </div>
            <pre className="mt-3 overflow-x-auto font-mono text-[13px] leading-relaxed text-ink-dim">
              OPENAI_BASE_URL=<span className="text-accent">http://localhost:8000/v1</span>
            </pre>
          </div>
        </div>
      </Panel>

      <div className="mt-3 grid gap-3 md:grid-cols-3">
        {STEPS.map(({ n, title, body }) => (
          <Panel key={n} className="p-5">
            <div className="font-mono text-sm font-semibold text-accent">{n}</div>
            <h3 className="mt-2 text-sm font-semibold text-ink">{title}</h3>
            <p className="mt-1.5 text-sm leading-relaxed text-ink-dim">{body}</p>
          </Panel>
        ))}
      </div>
    </Section>
  );
}
