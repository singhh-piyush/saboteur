import { Eyebrow, Heading, Section } from "./parts";

type Stage = "now" | "next" | "later";

const ITEMS: { stage: Stage; title: string; body: string }[] = [
  { stage: "now", title: "Local-first", body: "Full chaos engine, proxy, scorecard, and CI gate running on a single local GPU today." },
  { stage: "next", title: "N=50 on MI300X", body: "The full cohort run - 50 concurrent agents under one seeded profile on AMD." },
  { stage: "next", title: "MCP chaos shim", body: "Tool-layer chaos for any MCP client via a stdio relay - sabotage tools/call and tools/list." },
  { stage: "later", title: "Hosted resilience CI", body: "Resilience checks as a service, wired to your PRs with no infrastructure to run." },
];

const STAGE_COLOR: Record<Stage, string> = {
  now: "var(--color-ok)",
  next: "var(--color-warn)",
  later: "var(--color-ink-faint)",
};

const STAGE_LABEL: Record<Stage, string> = { now: "now", next: "next", later: "later" };

export function Roadmap() {
  return (
    <Section>
      <Eyebrow>Roadmap</Eyebrow>
      <Heading>Local-first today. Hosted next.</Heading>

      <ol className="mt-10 space-y-3">
        {ITEMS.map(({ stage, title, body }) => (
          <li
            key={title}
            className="flex items-start gap-4 rounded-lg border border-line bg-panel p-5"
          >
            <span
              className="mt-1 inline-flex shrink-0 items-center rounded-sm px-2 py-0.5 text-[10px] font-semibold uppercase tracking-widest"
              style={{
                color: STAGE_COLOR[stage],
                background: `color-mix(in oklch, ${STAGE_COLOR[stage]} 13%, transparent)`,
              }}
            >
              {STAGE_LABEL[stage]}
            </span>
            <div>
              <h3 className="text-sm font-semibold text-ink">{title}</h3>
              <p className="mt-1 text-sm leading-relaxed text-ink-dim">{body}</p>
            </div>
          </li>
        ))}
      </ol>
    </Section>
  );
}
