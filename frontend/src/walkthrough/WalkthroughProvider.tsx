/**
 * WalkthroughProvider - the static, backend-free twin of RunProvider.
 *
 * It owns the SAME pure reducer the live console uses, but the event source is
 * a ReplayDriver fed by a bundled JSONL run instead of a WebSocket. Crucially
 * it supplies a same-shaped `RunContext` value, so every dashboard component
 * (CohortGrid, RunBar, ChaosLog, TimelineDrawer, ScorecardView) consumes it
 * unchanged - they cannot tell they are being replayed from a file.
 *
 * No socket is ever opened and no API is fetched: ScorecardView's reads are
 * served from the offline registry (lib/api), and ControlPanel (which fetches)
 * is simply not rendered in the walkthrough.
 *
 * A second context, WalkthroughContext, exposes the richer playback controls
 * (scrub / 0.5-4x / seek) that the walkthrough chrome (Playbar, tour) needs but
 * the live ReplayBar does not.
 */

import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type ReactNode,
} from "react";

import { clearOfflineRuns, registerOfflineRun, setOffline } from "../lib/api";
import { ReplayDriver } from "../lib/replay";
import { foldEvents, reduce } from "../state/reducer";
import { RunContext, type RunContextValue } from "../state/RunContext";
import type { DemoRun } from "../demo";
import { introFoldIndex } from "./tour";

export interface WalkthroughControls {
  /** Current event index (0..length). */
  position: number;
  length: number;
  playing: boolean;
  speed: number;
  /** position / length, clamped to [0,1]. */
  progress: number;
  play: () => void;
  pause: () => void;
  /** Restart from the beginning and play (free-mode replay button). */
  restart: () => void;
  setSpeed: (speed: number) => void;
  /** Seek to an event index (re-derives state from a fresh reducer). */
  seek: (index: number) => void;
}

const WalkthroughContext = createContext<WalkthroughControls | null>(null);

/** Tight pacing so a recorded run feels live: clamp every inter-event gap into
 * [16ms, 400ms] (before speed) - a 15s injected-latency gap never stalls. */
const REPLAY_OPTIONS = { minGapMs: 16, maxGapMs: 400 } as const;
const INITIAL_SPEED = 1;

const noop = () => {};

interface Tick {
  position: number;
  length: number;
  playing: boolean;
  speed: number;
}

export function WalkthroughProvider({
  run,
  children,
}: {
  run: DemoRun;
  children: ReactNode;
}) {
  // Seed the very first paint with a populated grid (rather than an empty
  // "NO ACTIVE COHORT" frame) by folding events up to the intro index. The
  // tour's first beat seeks to the same index, so nothing visibly jumps.
  // The provider is remounted (keyed) when the demo run switches, so these
  // once-per-mount initializers always see the current run.
  const initialFoldRef = useRef<number | null>(null);
  if (initialFoldRef.current === null) {
    initialFoldRef.current = introFoldIndex(run.events);
  }
  const initialFold = initialFoldRef.current;

  const [state, dispatch] = useReducer(reduce, undefined, () =>
    foldEvents(run.events.slice(0, initialFold)),
  );
  const [tick, setTick] = useState<Tick>({
    position: initialFold,
    length: run.events.length,
    playing: false,
    speed: INITIAL_SPEED,
  });

  // Stable indirection so the driver's onTick closure never goes stale.
  const tickRef = useRef<(i: number, t: number, p: boolean) => void>(noop);
  tickRef.current = (position, length, playing) =>
    setTick((prev) => ({ position, length, playing, speed: prev.speed }));

  // Lazily create the single driver (survives re-renders via the ref).
  const driverRef = useRef<ReplayDriver | null>(null);
  if (driverRef.current === null) {
    const driver = new ReplayDriver(
      run.events,
      dispatch,
      (i, t, p) => tickRef.current(i, t, p),
      REPLAY_OPTIONS,
    );
    driver.speed = INITIAL_SPEED;
    driverRef.current = driver;
  }

  // Mount: go offline + register the bundled run; sync the driver to the seeded
  // frame (paused - the tour drives playback from here). Unmount: restore live
  // behavior fully.
  useEffect(() => {
    const driver = driverRef.current;
    if (driver === null) return;
    setOffline(true);
    registerOfflineRun(run.id, run.scorecard, run.events);
    driver.seek(initialFold);
    return () => {
      driver.dispose();
      clearOfflineRuns();
      setOffline(false);
    };
    // Once per mount: the provider is keyed by the run, never re-run in place.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const controls = useMemo<WalkthroughControls>(() => {
    const driver = driverRef.current!;
    const length = tick.length || driver.length;
    return {
      position: tick.position,
      length,
      playing: tick.playing,
      speed: tick.speed,
      progress: length > 0 ? Math.min(tick.position / length, 1) : 0,
      play: () => driver.play(),
      pause: () => driver.pause(),
      restart: () => {
        driver.restart();
        driver.play();
      },
      setSpeed: (speed) => {
        driver.speed = speed;
        setTick((prev) => ({ ...prev, speed }));
      },
      seek: (index) => driver.seek(index),
    };
  }, [tick]);

  // Same shape as the live RunContext value, so reused components work as-is.
  // activeRunId is what ScorecardView needs to load the (offline) scorecard;
  // navigation / socket actions are inert no-ops here.
  const runValue = useMemo<RunContextValue>(
    () => ({
      state,
      activeRunId: run.id,
      page: { kind: "live", runId: run.id },
      navigate: noop,
      watchRun: noop,
      expectedAgents: run.scorecard.n_agents,
      startReplay: noop,
      replay: null,
      stop: noop,
      reconnect: noop,
    }),
    [state, run],
  );

  return (
    <WalkthroughContext.Provider value={controls}>
      <RunContext.Provider value={runValue}>{children}</RunContext.Provider>
    </WalkthroughContext.Provider>
  );
}

export function useWalkthrough(): WalkthroughControls {
  const ctx = useContext(WalkthroughContext);
  if (ctx === null) {
    throw new Error("useWalkthrough must be used inside WalkthroughProvider");
  }
  return ctx;
}
