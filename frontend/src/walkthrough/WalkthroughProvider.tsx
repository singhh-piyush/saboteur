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
 * The provider also owns WHICH bundled run is active. `switchRun` swaps the
 * driver and re-derives reducer state **in place** - synchronously, so React
 * batches the whole swap into one commit and nothing ever unmounts or paints
 * an empty frame. That is what makes the tour's mid-run face-off (and the
 * free-mode run switcher) seamless: the grid cells stay mounted and tint to
 * the new outcomes via their normal CSS state transitions.
 *
 * A second context, WalkthroughContext, exposes the richer playback controls
 * (scrub / 0.5-4x / seek / run switching) that the walkthrough chrome
 * (Playbar, tour) needs but the live ReplayBar does not.
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
  /** Index of the active bundled run. */
  runIndex: number;
  play: () => void;
  pause: () => void;
  /** Restart from the beginning and play (free-mode replay button). */
  restart: () => void;
  setSpeed: (speed: number) => void;
  /** Seek to an event index (re-derives state from a fresh reducer). */
  seek: (index: number) => void;
  /** Swap the active run in place (paused at its intro fold). No-op when the
   * index is already active or out of range. */
  switchRun: (index: number) => void;
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
  runs,
  children,
}: {
  runs: DemoRun[];
  children: ReactNode;
}) {
  const [runIndex, setRunIndex] = useState(0);
  const runIndexRef = useRef(0);
  const activeRun = runs[runIndex] ?? runs[0];

  // Seed the very first paint with a populated grid (rather than an empty
  // "NO ACTIVE COHORT" frame) by folding events up to the intro index. The
  // tour's first beat seeks to the same index, so nothing visibly jumps.
  const initialFoldRef = useRef<number | null>(null);
  if (initialFoldRef.current === null) {
    initialFoldRef.current = introFoldIndex(runs[0].events);
  }
  const initialFold = initialFoldRef.current;

  const [state, dispatch] = useReducer(reduce, undefined, () =>
    foldEvents(runs[0].events.slice(0, initialFold)),
  );
  const [tick, setTick] = useState<Tick>({
    position: initialFold,
    length: runs[0].events.length,
    playing: false,
    speed: INITIAL_SPEED,
  });

  // Stable indirection so the driver's onTick closure never goes stale.
  const tickRef = useRef<(i: number, t: number, p: boolean) => void>(noop);
  tickRef.current = (position, length, playing) =>
    setTick((prev) => ({ position, length, playing, speed: prev.speed }));

  const makeDriver = (run: DemoRun, speed: number): ReplayDriver => {
    const driver = new ReplayDriver(
      run.events,
      dispatch,
      (i, t, p) => tickRef.current(i, t, p),
      REPLAY_OPTIONS,
    );
    driver.speed = speed;
    return driver;
  };

  // Lazily create the first driver (survives re-renders via the ref).
  const driverRef = useRef<ReplayDriver | null>(null);
  if (driverRef.current === null) {
    driverRef.current = makeDriver(runs[0], INITIAL_SPEED);
  }

  // Mount: go offline + register EVERY bundled run (so a mid-session run switch
  // resolves ScorecardView's refetch instantly from memory - no error flash);
  // sync the driver to the seeded frame (paused - the tour drives playback from
  // here). Unmount: restore live behavior fully.
  useEffect(() => {
    const driver = driverRef.current;
    if (driver === null) return;
    setOffline(true);
    for (const run of runs) registerOfflineRun(run.id, run.scorecard, run.events);
    driver.seek(initialFold);
    return () => {
      driverRef.current?.dispose();
      clearOfflineRuns();
      setOffline(false);
    };
    // Once per mount: the bundled runs never change at runtime.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const controls = useMemo<WalkthroughControls>(() => {
    // Closures read driverRef.current at call time (never a captured driver),
    // so they stay correct after switchRun swaps the driver.
    const length = tick.length || driverRef.current!.length;
    return {
      position: tick.position,
      length,
      playing: tick.playing,
      speed: tick.speed,
      progress: length > 0 ? Math.min(tick.position / length, 1) : 0,
      runIndex,
      play: () => driverRef.current!.play(),
      pause: () => driverRef.current!.pause(),
      restart: () => {
        driverRef.current!.restart();
        driverRef.current!.play();
      },
      setSpeed: (speed) => {
        driverRef.current!.speed = speed;
        setTick((prev) => ({ ...prev, speed }));
      },
      seek: (index) => driverRef.current!.seek(index),
      switchRun: (index) => {
        if (index === runIndexRef.current) return;
        const run = runs[index];
        if (run === undefined) return;
        // Synchronous swap: dispose, rebuild, seek. React batches the reducer
        // reset + refold and the runIndex change into ONE commit - the mounted
        // grid repaints straight to the new run's frame, no empty state.
        driverRef.current?.dispose();
        const driver = makeDriver(run, tick.speed);
        driverRef.current = driver;
        driver.seek(introFoldIndex(run.events));
        runIndexRef.current = index;
        setRunIndex(index);
      },
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tick, runIndex]);

  // Same shape as the live RunContext value, so reused components work as-is.
  // activeRunId is what ScorecardView needs to load the (offline) scorecard;
  // navigation / socket actions are inert no-ops here.
  const runValue = useMemo<RunContextValue>(
    () => ({
      state,
      activeRunId: activeRun.id,
      page: { kind: "live", runId: activeRun.id },
      navigate: noop,
      watchRun: noop,
      expectedAgents: activeRun.scorecard.n_agents,
      startReplay: noop,
      replay: null,
      stop: noop,
      reconnect: noop,
    }),
    [state, activeRun],
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
