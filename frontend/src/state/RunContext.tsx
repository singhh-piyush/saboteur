/**
 * Wires the pure reducer to the two event sources: the live WebSocket and
 * the ReplayDriver. Components only ever read `state` and call the actions
 * exposed here — they never touch sockets or timers directly.
 */

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useReducer,
  useRef,
  useState,
  type ReactNode,
} from "react";

import { ReplayDriver } from "../lib/replay";
import { RunSocket } from "../lib/ws";
import type { TelemetryEvent } from "../types/telemetry";
import { initialState, reduce, type RunViewState } from "./reducer";

export interface ReplayControls {
  position: number;
  length: number;
  playing: boolean;
  speed: number;
  play: () => void;
  pause: () => void;
  restart: () => void;
  skipToEnd: () => void;
  setSpeed: (speed: number) => void;
}

interface RunContextValue {
  state: RunViewState;
  /** The run id currently being watched or replayed. */
  activeRunId: string | null;
  /** Connect the live WebSocket for a run (stops any replay). */
  watchRun: (runId: string) => void;
  /** Start replaying a recorded event array (stops any live socket). */
  startReplay: (runId: string, events: TelemetryEvent[]) => void;
  replay: ReplayControls | null;
  stop: () => void;
}

const RunContext = createContext<RunContextValue | null>(null);

export function RunProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(reduce, initialState);
  const [activeRunId, setActiveRunId] = useState<string | null>(null);
  const [replayTick, setReplayTick] = useState<{
    position: number;
    length: number;
    playing: boolean;
    speed: number;
  } | null>(null);

  const socketRef = useRef<RunSocket | null>(null);
  const driverRef = useRef<ReplayDriver | null>(null);

  const teardown = useCallback(() => {
    socketRef.current?.close();
    socketRef.current = null;
    driverRef.current?.dispose();
    driverRef.current = null;
    setReplayTick(null);
  }, []);

  const watchRun = useCallback(
    (runId: string) => {
      teardown();
      setActiveRunId(runId);
      dispatch({ type: "reset" });
      dispatch({ type: "conn", conn: "connecting" });
      const socket = new RunSocket(runId, {
        onOpen: () => {
          // Server replays the full backlog after open: rebuild from zero.
          dispatch({ type: "conn", conn: "live" });
          dispatch({ type: "reset" });
        },
        onEvent: (event) => dispatch({ type: "event", event }),
        onReconnecting: () => dispatch({ type: "conn", conn: "reconnecting" }),
      });
      socketRef.current = socket;
      socket.connect();
    },
    [teardown],
  );

  const startReplay = useCallback(
    (runId: string, events: TelemetryEvent[]) => {
      teardown();
      setActiveRunId(runId);
      const driver = new ReplayDriver(events, dispatch, (position, length, playing) =>
        setReplayTick({ position, length, playing, speed: driver.speed }),
      );
      driverRef.current = driver;
      driver.restart();
      driver.play();
    },
    [teardown],
  );

  const stop = useCallback(() => {
    teardown();
    setActiveRunId(null);
    dispatch({ type: "reset" });
    dispatch({ type: "conn", conn: "idle" });
  }, [teardown]);

  const replay = useMemo<ReplayControls | null>(() => {
    const driver = driverRef.current;
    if (driver === null || replayTick === null) return null;
    return {
      ...replayTick,
      play: () => driver.play(),
      pause: () => driver.pause(),
      restart: () => {
        driver.restart();
        driver.play();
      },
      skipToEnd: () => driver.runToEnd(),
      setSpeed: (speed: number) => {
        driver.speed = speed;
        setReplayTick((tick) => (tick === null ? null : { ...tick, speed }));
      },
    };
  }, [replayTick]);

  const value = useMemo<RunContextValue>(
    () => ({ state, activeRunId, watchRun, startReplay, replay, stop }),
    [state, activeRunId, watchRun, startReplay, replay, stop],
  );

  return <RunContext.Provider value={value}>{children}</RunContext.Provider>;
}

export function useRun(): RunContextValue {
  const ctx = useContext(RunContext);
  if (ctx === null) throw new Error("useRun must be used inside RunProvider");
  return ctx;
}
