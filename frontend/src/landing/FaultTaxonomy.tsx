import { FAULT_STYLES, type FaultStyle } from "../lib/faults";
import { Tooltip } from "../components/Tooltip";
import { Eyebrow, Heading, Lede, Panel, Reveal, Section } from "./parts";

type Layer = FaultStyle["layer"];

const LAYER_LABEL: Record<Layer, string> = {
  tool: "Tool",
  transport: "Transport",
  context: "Context",
};

const LAYER_ORDER: Layer[] = ["tool", "transport", "context"];

const BY_LAYER: Record<Layer, string[]> = { tool: [], transport: [], context: [] };
for (const [name, style] of Object.entries(FAULT_STYLES)) {
  BY_LAYER[style.layer].push(name);
}

export function FaultTaxonomy() {
  return (
    <Section>
      <Reveal><Eyebrow>Fault taxonomy</Eyebrow></Reveal>
      <Reveal delay={70}><Heading>8 faults. 3 layers.</Heading></Reveal>
      <Reveal delay={140}>
        <Lede className="mt-4">
          Every fault is seeded and deterministic at the decision layer. They hit where
          agents actually fail: the tool boundary, the transport, and the context window.
        </Lede>
      </Reveal>

      <div className="mt-10 grid gap-3 md:grid-cols-3">
        {LAYER_ORDER.map((layer, i) => (
          <Reveal key={layer} delay={210 + i * 70}>
            <Panel className="h-full p-5">
              <h3 className="text-[11px] font-semibold uppercase tracking-[0.18em] text-ink-dim">
                {LAYER_LABEL[layer]}
              </h3>
              <ul className="mt-4 space-y-2">
                {BY_LAYER[layer].map((name) => (
                  <FaultRow key={name} name={name} style={FAULT_STYLES[name]} />
                ))}
              </ul>
            </Panel>
          </Reveal>
        ))}
      </div>

      {/* silent_lie gets its own callout - the failure class benchmarks miss. */}
      <Reveal delay={120}>
      <Panel className="mt-3 p-6" >
        <div className="flex flex-col gap-2 sm:flex-row sm:items-baseline sm:gap-4">
          <span
            className="inline-flex w-fit items-center rounded-sm px-2 py-1 font-mono text-xs font-semibold"
            style={{
              color: FAULT_STYLES.silent_lie.color,
              background: `color-mix(in oklch, ${FAULT_STYLES.silent_lie.color} 14%, transparent)`,
            }}
          >
            silent_lie
          </span>
          <p className="text-sm leading-relaxed text-ink-dim sm:text-base">
            <span className="font-semibold text-ink">Well-formed but wrong tool data</span>{" "}
            - the failure class no agent benchmark covers. The tool returns valid JSON with
            a corrupted value; only an agent that cross-checks its inputs catches it. We
            score that as a <span className="text-ink">deception detection rate</span>.
          </p>
        </div>
      </Panel>
      </Reveal>
    </Section>
  );
}

function FaultRow({ name, style }: { name: string; style: FaultStyle }) {
  return (
    <li>
      <Tooltip label={style.description} side="top">
        <span className="inline-flex cursor-default items-center gap-2">
          <span aria-hidden className="h-2 w-2 shrink-0 rounded-full" style={{ background: style.color }} />
          <span className="font-mono text-[13px] text-ink transition-colors duration-150 hover:text-white">
            {name}
          </span>
        </span>
      </Tooltip>
    </li>
  );
}
