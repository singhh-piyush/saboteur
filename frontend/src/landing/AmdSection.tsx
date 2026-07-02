import { CountUp, Eyebrow, Heading, Lede, Panel, Reveal, Section } from "./parts";

/** Numeric stats count up; text stats (ROCm) render as-is. */
const POINTS: { stat: string; countTo?: number; label: string; body: string }[] = [
  {
    stat: "50",
    countTo: 50,
    label: "concurrent agents",
    body: "Continuous batching on vLLM is what makes 50 agent loops run at once - the cohort is the demo, and the cohort needs throughput.",
  },
  {
    stat: "ROCm",
    label: "vLLM on MI300X",
    body: "An open inference stack on AMD: vLLM on ROCm. No proprietary runtime in the path.",
  },
  {
    stat: "1",
    countTo: 1,
    label: ".env change",
    body: "Local llama.cpp to MI300X is a single config swap - OPENAI_BASE_URL and MODEL_ID. No endpoint or model is ever hardcoded.",
  },
];

export function AmdSection() {
  return (
    <Section className="border-y border-line bg-panel/40">
      <Reveal><Eyebrow>Open stack on AMD</Eyebrow></Reveal>
      <Reveal delay={70}><Heading>Runs on open infrastructure.</Heading></Reveal>
      <Reveal delay={140}>
        <Lede className="mt-4">
          Develop locally on a single GPU, then scale the same cohort to AMD MI300X for the
          50-agent run. The harness only speaks the OpenAI-compatible wire protocol, so the
          backend is swappable.
        </Lede>
      </Reveal>

      <div className="mt-10 grid gap-3 md:grid-cols-3">
        {POINTS.map(({ stat, countTo, label, body }, i) => (
          <Reveal key={label} delay={210 + i * 70}>
            <Panel className="h-full p-5">
              <div className="font-display text-3xl font-bold text-accent">
                {countTo === undefined ? (
                  stat
                ) : (
                  <CountUp to={countTo} format={(n) => String(Math.round(n))} />
                )}
              </div>
              <div className="mt-1 text-[11px] font-semibold uppercase tracking-[0.14em] text-ink-dim">
                {label}
              </div>
              <p className="mt-3 text-sm leading-relaxed text-ink-dim">{body}</p>
            </Panel>
          </Reveal>
        ))}
      </div>
    </Section>
  );
}
