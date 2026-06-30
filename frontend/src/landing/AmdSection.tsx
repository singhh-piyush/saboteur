import { Eyebrow, Heading, Lede, Panel, Section } from "./parts";

const POINTS: { stat: string; label: string; body: string }[] = [
  {
    stat: "50",
    label: "concurrent agents",
    body: "Continuous batching on vLLM is what makes 50 agent loops run at once - the cohort is the demo, and the cohort needs throughput.",
  },
  {
    stat: "ROCm",
    label: "vLLM on MI300X",
    body: "An open inference stack on AMD: vLLM on ROCm and Fireworks. No proprietary runtime in the path.",
  },
  {
    stat: "1",
    label: ".env change",
    body: "Local llama.cpp to MI300X is a single config swap - OPENAI_BASE_URL and MODEL_ID. No endpoint or model is ever hardcoded.",
  },
];

export function AmdSection() {
  return (
    <Section className="border-y border-line bg-panel/40">
      <Eyebrow>Open stack on AMD</Eyebrow>
      <Heading>Runs on open infrastructure.</Heading>
      <Lede className="mt-4">
        Develop locally on a single GPU, then scale the same cohort to AMD MI300X for the
        50-agent run. The harness only speaks the OpenAI-compatible wire protocol, so the
        backend is swappable.
      </Lede>

      <div className="mt-10 grid gap-3 md:grid-cols-3">
        {POINTS.map(({ stat, label, body }) => (
          <Panel key={label} className="p-5">
            <div className="font-display text-3xl font-bold text-accent">{stat}</div>
            <div className="mt-1 text-[11px] font-semibold uppercase tracking-[0.14em] text-ink-dim">
              {label}
            </div>
            <p className="mt-3 text-sm leading-relaxed text-ink-dim">{body}</p>
          </Panel>
        ))}
      </div>
    </Section>
  );
}
