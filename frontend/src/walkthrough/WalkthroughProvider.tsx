
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

import { acquireOffline, registerOfflineRun, releaseOffline } from "../lib/api";
import { ReplayDriver } from "../lib/replay";
import { foldEvents, reduce } from "../state/reducer";
import { RunContext, type RunContextValue } from "../state/RunContext";
import type { DemoRun } from "../demo";
import { introFoldIndex } from "./tour";

export interface WalkthroughControls {
  /** current event index (0..length) */
  position: number;
  length: number;
  playing: boolean;
  speed: number;
  /** position / length, clamped to [0,1] */
  progress: number;
  /** index of the active bundled run */
  runIndex: number;
  play: () => void;
  pause: () => void;
  /** restart from beginning and play */
  restart: () => void;
  setSpeed: (speed: number) => void;
  /** seek to an event index (re-derives state from a fresh reducer) */
  seek: (index: number) => void;
  /** swap active run in place, paused at its intro fold; no-op if index is already active or out of range */
  switchRun: (index: number) => void;
}

const WalkthroughContext = createContext<WalkthroughControls | null>(null);

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

  const offlineToken = useRef(Symbol("walkthrough-offline"));

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

  const driverRef = useRef<ReplayDriver | null>(null);
  if (driverRef.current === null) {
    acquireOffline(offlineToken.current);
    for (const run of runs) registerOfflineRun(run.id, run.scorecard, run.events);
    driverRef.current = makeDriver(runs[0], INITIAL_SPEED);
  }

  const offlineTeardown = useRef<number | null>(null);
  useEffect(() => {
    if (offlineTeardown.current !== null) {
      window.clearTimeout(offlineTeardown.current);
      offlineTeardown.current = null;
    }
    acquireOffline(offlineToken.current);
    for (const run of runs) registerOfflineRun(run.id, run.scorecard, run.events);
    driverRef.current?.seek(initialFold);
    return () => {
      driverRef.current?.dispose();
      offlineTeardown.current = window.setTimeout(() => {
        offlineTeardown.current = null;
        releaseOffline(offlineToken.current);
      }, 0);
    };
    // Once per mount: the bundled runs never change at runtime.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const controls = useMemo<WalkthroughControls>(() => {
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
