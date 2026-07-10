
import { describe, expect, it } from "vitest";

import { ReplayDriver } from "../lib/replay";
import type { TelemetryEvent } from "../types/telemetry";
import { RUN_EVENTS } from "./fixtures/run-events";
import {
  foldEvents,
  initialState,
  reduce,
  type Action,
  type RunViewState,
} from "./reducer";
import { survivalRate } from "./selectors";

function view(state: RunViewState): Omit<RunViewState, "conn" | "_seen"> {
  const { conn: _conn, _seen: _s, ...rest } = state;
  return rest;
}

function ev(partial: Partial<TelemetryEvent>): TelemetryEvent {
  return {
    ts: "2026-06-10T12:00:00+00:00",
    run_id: "r",
    agent_id: 0,
    step: null,
    event: "step_start",
    fault: null,
    recovery: null,
    tokens_used: null,
    latency_ms: null,
    payload: {},
    ...partial,
  };
}


describe("live vs replay parity (invariant #3)", () => {
  it("replaying the recorded run reproduces the live state at every index", () => {
    const liveSnapshots: string[] = [];
    let live = initialState;
    for (const event of RUN_EVENTS) {
      live = reduce(live, { type: "event", event });
      liveSnapshots.push(JSON.stringify(view(live)));
    }

    const replaySnapshots: string[] = [];
    let replayed = initialState;
    const dispatch = (action: Action) => {
      replayed = reduce(replayed, action);
      if (action.type === "event") replaySnapshots.push(JSON.stringify(view(replayed)));
    };
    const driver = new ReplayDriver(RUN_EVENTS, dispatch);
    driver.runToEnd();

    expect(replaySnapshots.length).toBe(liveSnapshots.length);
    for (let i = 0; i < liveSnapshots.length; i++) {
      expect(replaySnapshots[i], `state diverged at event ${i}`).toBe(
        liveSnapshots[i],
      );
    }
    expect(view(replayed)).toEqual(view(live));
  });

  it("the fixture exercises a non-trivial run (sanity)", () => {
    const state = foldEvents(RUN_EVENTS);
    expect(state.nAgents).toBe(8);
    expect(state.finished).toBe(true);
    expect(state.chaosLog.length).toBeGreaterThan(0);
    expect(state.terminals.length).toBe(8);
  });

  it("reset rebuilds identically after a simulated reconnect backlog replay", () => {
    let interrupted = initialState;
    for (const event of RUN_EVENTS.slice(0, 50))
      interrupted = reduce(interrupted, { type: "event", event });
    interrupted = reduce(interrupted, { type: "reset" });
    for (const event of RUN_EVENTS)
      interrupted = reduce(interrupted, { type: "event", event });

    expect(view(interrupted)).toEqual(view(foldEvents(RUN_EVENTS)));
  });
});


describe("idempotent event deduplication", () => {
  it("duplicate events produce zero state changes (same reference)", () => {
    const events = [
      ev({ agent_id: -1, event: "run_started", payload: { n_agents: 2 } }),
      ev({ event: "step_start", step: 1, ts: "2026-06-10T12:00:01+00:00" }),
      ev({ event: "fault_injected", step: 2, fault: "api_error", ts: "2026-06-10T12:00:02+00:00" }),
    ];

    let state = initialState;
    for (const event of events) {
      state = reduce(state, { type: "event", event });
    }
    const after = state;

    for (const event of events) {
      const next = reduce(state, { type: "event", event });
      expect(next).toBe(state);
      state = next;
    }

    expect(view(state)).toEqual(view(after));
  });

  it("_seen set is cleared on reset", () => {
    let state = initialState;
    state = reduce(state, { type: "event", event: ev({ agent_id: -1, event: "run_started", payload: { n_agents: 1 } }) });
    expect(state._seen.size).toBe(1);
    state = reduce(state, { type: "reset" });
    expect(state._seen.size).toBe(0);
  });

  it("reconnect backlog replay deduplicates correctly", () => {
    const events = [
      ev({ agent_id: -1, event: "run_started", payload: { n_agents: 2 }, ts: "2026-06-10T12:00:00+00:00" }),
      ev({ event: "step_start", step: 1, ts: "2026-06-10T12:00:01+00:00" }),
      ev({ event: "fault_injected", step: 2, fault: "latency", ts: "2026-06-10T12:00:02+00:00" }),
      ev({ event: "recovery_action", step: 3, recovery: "retry", ts: "2026-06-10T12:00:03+00:00" }),
    ];

    let state = initialState;
    for (const e of events) state = reduce(state, { type: "event", event: e });
    const seqAfterFirst = state.agents[0]?.seq ?? 0;

    for (const e of events) {
      const next = reduce(state, { type: "event", event: e });
      expect(next).toBe(state); 
      state = next;
    }

    expect(state.agents[0]?.seq).toBe(seqAfterFirst);
  });
});


describe("agent status transitions", () => {
  it("run_started creates N pending agents", () => {
    const state = foldEvents([
      ev({
        agent_id: -1,
        event: "run_started",
        payload: { profile: "hell_mode", seed: 7, n_agents: 3 },
      }),
    ]);
    expect(Object.keys(state.agents)).toHaveLength(3);
    expect(state.agents[0].status).toBe("pending");
    expect(state.profile).toBe("hell_mode");
    expect(state.seed).toBe(7);
  });

  it("fault makes an agent recovering; recovery makes it healthy again", () => {
    const base = [
      ev({ agent_id: -1, event: "run_started", payload: { n_agents: 1 } }),
      ev({ event: "step_start", step: 1, ts: "2026-06-10T12:00:01+00:00" }),
    ];
    const faulted = foldEvents([
      ...base,
      ev({ event: "fault_injected", step: 2, fault: "api_error", ts: "2026-06-10T12:00:02+00:00" }),
    ]);
    expect(faulted.agents[0].status).toBe("recovering");
    expect(faulted.agents[0].faultCount).toBe(1);
    expect(faulted.agents[0].activeFault).toBe("api_error");
    expect(faulted.chaosLog).toHaveLength(1);

    const recovered = foldEvents([
      ...base,
      ev({ event: "fault_injected", step: 2, fault: "api_error", ts: "2026-06-10T12:00:02+00:00" }),
      ev({ event: "recovery_action", step: 3, recovery: "retry", ts: "2026-06-10T12:00:03+00:00" }),
    ]);
    expect(recovered.agents[0].status).toBe("healthy");
    expect(recovered.agents[0].activeFault).toBeNull();
    expect(recovered.agents[0].recoveryCount).toBe(1);
  });

  it("chaos-log detail renders context_drop's dropped_steps (backend field name)", () => {
    const state = foldEvents([
      ev({ agent_id: -1, event: "run_started", payload: { n_agents: 1 } }),
      ev({
        event: "fault_injected",
        step: 2,
        fault: "context_drop",
        payload: { detail: { dropped_steps: 3 } },
        ts: "2026-06-10T12:00:02+00:00",
      }),
    ]);
    expect(state.chaosLog[0].detail).toContain("dropped 3 steps");
  });

  it("a clean tool call also resolves a fault", () => {
    const state = foldEvents([
      ev({ agent_id: -1, event: "run_started", payload: { n_agents: 1 } }),
      ev({ event: "fault_injected", step: 1, fault: "latency", ts: "2026-06-10T12:00:01+00:00" }),
      ev({
        event: "tool_call",
        step: 2,
        payload: { tool: "weather", sabotaged: false, errored: false },
        ts: "2026-06-10T12:00:02+00:00",
      }),
    ]);
    expect(state.agents[0].status).toBe("healthy");
  });

  it("faultCount keeps counting past the chaos-log render cap", () => {
    const events = [ev({ agent_id: -1, event: "run_started", payload: { n_agents: 1 } })];
    for (let i = 0; i < 250; i++) {
      events.push(
        ev({
          event: "fault_injected",
          step: 1,
          fault: "api_error",
          ts: `2026-06-10T12:00:00.${String(i).padStart(3, "0")}+00:00`,
        }),
      );
    }
    const state = foldEvents(events);
    expect(state.chaosLog).toHaveLength(200); 
    expect(state.faultCount).toBe(250); 
  });

  it("agent_done routes to succeeded or crashed on the verifier verdict", () => {
    const done = (success: boolean) =>
      foldEvents([
        ev({ agent_id: -1, event: "run_started", payload: { n_agents: 1 } }),
        ev({
          event: "agent_done",
          tokens_used: 1234,
          payload: { outcome: "completed", success, steps_taken: 4 },
          ts: "2026-06-10T12:00:01+00:00",
        }),
      ]).agents[0];

    expect(done(true).status).toBe("succeeded");
    expect(done(false).status).toBe("crashed");
    expect(done(true).tokensUsed).toBe(1234);
  });

  it("agent_done with null success (no oracle) is neutral 'done', never green", () => {
    const doneNull = (outcome: string) =>
      foldEvents([
        ev({ agent_id: -1, event: "run_started", payload: { n_agents: 1 } }),
        ev({
          event: "agent_done",
          tokens_used: 50,
          payload: { outcome, success: null, steps_taken: 4 },
          ts: "2026-06-10T12:00:01+00:00",
        }),
      ]).agents[0];

    const completed = doneNull("completed");
    expect(completed.status).toBe("done");
    expect(completed.success).toBeNull();
    expect(doneNull("timeout").status).toBe("crashed");
    expect(doneNull("hard_exception").status).toBe("crashed");
  });

  it("survivalRate is null for a no-oracle run (no fabricated %)", () => {
    const state = foldEvents([
      ev({ agent_id: -1, event: "run_started", payload: { n_agents: 2 } }),
      ev({ event: "agent_done", payload: { outcome: "completed", success: null }, ts: "2026-06-10T12:00:01+00:00" }),
      ev({ agent_id: 1, event: "agent_done", payload: { outcome: "completed", success: null }, ts: "2026-06-10T12:00:02+00:00" }),
    ]);
    expect(survivalRate(state)).toBeNull();
    const judged = foldEvents([
      ev({ agent_id: -1, event: "run_started", payload: { n_agents: 2 } }),
      ev({ event: "agent_done", payload: { outcome: "completed", success: true }, ts: "2026-06-10T12:00:01+00:00" }),
      ev({ agent_id: 1, event: "agent_done", payload: { outcome: "completed", success: false }, ts: "2026-06-10T12:00:02+00:00" }),
    ]);
    expect(survivalRate(judged)).toBe(0.5);
  });

  it("agent_crashed is terminal and sticky against later faults", () => {
    const state = foldEvents([
      ev({ agent_id: -1, event: "run_started", payload: { n_agents: 1 } }),
      ev({ event: "agent_crashed", payload: { error: "RuntimeError" }, ts: "2026-06-10T12:00:01+00:00" }),
      ev({ event: "fault_injected", step: 5, fault: "timeout", ts: "2026-06-10T12:00:02+00:00" }),
    ]);
    expect(state.agents[0].status).toBe("crashed");
    expect(state.agents[0].faultCount).toBe(1); 
  });

  it("seq bumps on every status change (drives the pulse animation)", () => {
    const state = foldEvents([
      ev({ agent_id: -1, event: "run_started", payload: { n_agents: 1 } }),
      ev({ event: "step_start", step: 1, ts: "2026-06-10T12:00:01+00:00" }), // pending → healthy
      ev({ event: "fault_injected", step: 2, fault: "api_error", ts: "2026-06-10T12:00:02+00:00" }), // → recovering
      ev({ event: "recovery_action", step: 3, recovery: "retry", ts: "2026-06-10T12:00:03+00:00" }), // → healthy
    ]);
    expect(state.agents[0].seq).toBe(3);
  });
});
