/**
 * Invariant #3, literally tested: the dashboard is a pure function of the
 * event stream, so replaying a recorded JSONL must produce *identical* view
 * state to live streaming — at every single event index, not just at the
 * end. The fixture is a real, unedited event log from an accepted N=8 run.
 */

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

/** Strip the connection field: it reflects the transport (live vs replay),
 * not the event stream, and is deliberately excluded from the invariant. */
function view(state: RunViewState): Omit<RunViewState, "conn"> {
  const { conn: _conn, ...rest } = state;
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

// ---------------------------------------------------------------------------
// Invariant #3: live ≡ replay
// ---------------------------------------------------------------------------

describe("live vs replay parity (invariant #3)", () => {
  it("replaying the recorded run reproduces the live state at every index", () => {
    // Live path: events dispatched one by one as WS frames would arrive.
    const liveSnapshots: string[] = [];
    let live = initialState;
    for (const event of RUN_EVENTS) {
      live = reduce(live, { type: "event", event });
      liveSnapshots.push(JSON.stringify(view(live)));
    }

    // Replay path: the ReplayDriver drives the same reducer.
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
    // Stream half the events, "drop the connection", reset, stream all of
    // them (the server replays the full backlog on reconnect).
    let interrupted = initialState;
    for (const event of RUN_EVENTS.slice(0, 50))
      interrupted = reduce(interrupted, { type: "event", event });
    interrupted = reduce(interrupted, { type: "reset" });
    for (const event of RUN_EVENTS)
      interrupted = reduce(interrupted, { type: "event", event });

    expect(view(interrupted)).toEqual(view(foldEvents(RUN_EVENTS)));
  });
});

// ---------------------------------------------------------------------------
// Status transition rules
// ---------------------------------------------------------------------------

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
      ev({ event: "step_start", step: 1 }),
    ];
    const faulted = foldEvents([
      ...base,
      ev({ event: "fault_injected", step: 2, fault: "api_error" }),
    ]);
    expect(faulted.agents[0].status).toBe("recovering");
    expect(faulted.agents[0].faultCount).toBe(1);
    expect(faulted.agents[0].activeFault).toBe("api_error");
    expect(faulted.chaosLog).toHaveLength(1);

    const recovered = foldEvents([
      ...base,
      ev({ event: "fault_injected", step: 2, fault: "api_error" }),
      ev({ event: "recovery_action", step: 3, recovery: "retry" }),
    ]);
    expect(recovered.agents[0].status).toBe("healthy");
    expect(recovered.agents[0].activeFault).toBeNull();
    expect(recovered.agents[0].recoveryCount).toBe(1);
  });

  it("a clean tool call also resolves a fault", () => {
    const state = foldEvents([
      ev({ agent_id: -1, event: "run_started", payload: { n_agents: 1 } }),
      ev({ event: "fault_injected", step: 1, fault: "latency" }),
      ev({
        event: "tool_call",
        step: 2,
        payload: { tool: "weather", sabotaged: false, errored: false },
      }),
    ]);
    expect(state.agents[0].status).toBe("healthy");
  });

  it("agent_done routes to succeeded or crashed on the verifier verdict", () => {
    const done = (success: boolean) =>
      foldEvents([
        ev({ agent_id: -1, event: "run_started", payload: { n_agents: 1 } }),
        ev({
          event: "agent_done",
          tokens_used: 1234,
          payload: { outcome: "completed", success, steps_taken: 4 },
        }),
      ]).agents[0];

    expect(done(true).status).toBe("succeeded");
    expect(done(false).status).toBe("crashed");
    expect(done(true).tokensUsed).toBe(1234);
  });

  it("agent_crashed is terminal and sticky against later faults", () => {
    const state = foldEvents([
      ev({ agent_id: -1, event: "run_started", payload: { n_agents: 1 } }),
      ev({ event: "agent_crashed", payload: { error: "RuntimeError" } }),
      ev({ event: "fault_injected", step: 5, fault: "timeout" }),
    ]);
    expect(state.agents[0].status).toBe("crashed");
    expect(state.agents[0].faultCount).toBe(1); // badge still counts
  });

  it("seq bumps on every status change (drives the pulse animation)", () => {
    const state = foldEvents([
      ev({ agent_id: -1, event: "run_started", payload: { n_agents: 1 } }),
      ev({ event: "step_start", step: 1 }), // pending → healthy
      ev({ event: "fault_injected", step: 2, fault: "api_error" }), // → recovering
      ev({ event: "recovery_action", step: 3, recovery: "retry" }), // → healthy
    ]);
    expect(state.agents[0].seq).toBe(3);
  });
});
