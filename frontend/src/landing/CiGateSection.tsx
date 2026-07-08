import { Check, X } from "lucide-react";

import { CodeBlock, Eyebrow, Heading, Lede, Panel, Reveal, Section } from "./parts";

export function CiGateSection() {
  return (
    <Section>
      <Reveal><Eyebrow>CI gate</Eyebrow></Reveal>
      <Reveal delay={70}><Heading>Block the merge if resilience drops.</Heading></Reveal>
      <Reveal delay={140}>
        <Lede className="mt-4">
          Resilience becomes a check, like coverage or types. One command exits non-zero
          below your threshold, so it drops straight into a shell <code className="font-mono text-ink">if</code> or
          a CI step.
        </Lede>
      </Reveal>

      <Reveal delay={210}>
        <CodeBlock className="mt-8">
          <span className="text-ink-faint">$ </span>
          saboteur run --target my-agent --profile hell_mode --ci --threshold 0.7
        </CodeBlock>
      </Reveal>

      <div className="mt-3 grid gap-3 lg:grid-cols-2">
        <Reveal delay={280}>
          <Panel className="h-full p-5">
            <h3 className="text-sm font-semibold text-ink">As a GitHub Action</h3>
            <p className="mt-1.5 text-sm leading-relaxed text-ink-dim">
              Runs the gate in a container, fails the check below threshold, uploads the
              scorecard as an artifact, and comments the resilience delta versus the base
              branch's last run on the PR. A bundled deterministic mock model runs it
              green or red on a GPU-less runner with no secrets.
            </p>
          </Panel>
        </Reveal>

        <Reveal delay={350}>
          <Panel className="flex h-full flex-col justify-center gap-2.5 p-5">
            <CheckRow ok label="resilience / hell_mode @ 0.70" detail="survival 0.88 - pass" />
            <CheckRow ok={false} label="resilience / hell_mode @ 0.95" detail="survival 0.88 - below threshold" />
            <p className="text-[11px] text-ink-faint">
              Real numbers from the bundled mock model's hell_mode run.
            </p>
          </Panel>
        </Reveal>
      </div>
    </Section>
  );
}

function CheckRow({ ok, label, detail }: { ok: boolean; label: string; detail: string }) {
  const color = ok ? "var(--color-ok)" : "var(--color-crit)";
  return (
    <div className="flex items-center gap-3 rounded-sm border border-line bg-raised/40 px-3 py-2">
      <span
        className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full"
        style={{ background: `color-mix(in oklch, ${color} 18%, transparent)`, color }}
      >
        {ok ? <Check size={12} strokeWidth={2.5} /> : <X size={12} strokeWidth={2.5} />}
      </span>
      <div className="min-w-0">
        <div className="truncate font-mono text-xs text-ink">{label}</div>
        <div className="truncate text-[11px] text-ink-faint">{detail}</div>
      </div>
    </div>
  );
}
