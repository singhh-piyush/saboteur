/**
 * Wires the pure reducer to the two event sources: the live WebSocket and
 * the ReplayDriver. Components only ever read `state` and call the actions
 * exposed here - they never touch sockets or timers directly.
 *
 * Navigation: a simple hash-based router (no library). Pages:
 *   #/runs        → RunsPage (run management)
 *   #/live/{id}   → Live view (grid + scorecard)
 *   #/targets     → TargetsPage (register / edit BYO agents)
 *   #/profiles    → ProfileBuilder (compose chaos profiles)
 *   #/compare     → ComparePage (per-metric run delta; ?a=&b= deep-link)
 *   default       → #/runs
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
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

export type Page =
  | { kind: "landing" }
  | { kind: "runs" }
  | { kind: "live"; runId: string }
  | { kind: "targets" }
  | { kind: "profiles" }
  | { kind: "compare"; a?: string; b?: string };

interface RunContextValue {
  state: RunViewState;
  /** The run id currently being watched or replayed. */
  activeRunId: string | null;
  /** Current page from hash router. */
  page: Page;
  /** Navigate to a page. */
  navigate: (page: Page) => void;
  /** Connect the live WebSocket for a run (stops any replay).
   *  `expectedAgents` is a UI hint for the skeleton grid size. */
  watchRun: (runId: string, expectedAgents?: number) => void;
  /** How many agents this run is expected to have (skeleton hint). */
  expectedAgents: number | null;
  /** Start replaying a recorded event array (stops any live socket). */
  startReplay: (runId: string, events: TelemetryEvent[]) => void;
  replay: ReplayControls | null;
  stop: () => void;
  /** Manual reconnect after max retries exhausted. */
  reconnect: () => void;
}

const RunContext = createContext<RunContextValue | null>(null);

function parseHash(): Page {
  const raw = window.location.hash.replace(/^#\/?/, "");
  const [path, query] = raw.split("?");
  // Empty hash or #/landing → the marketing landing page (default front door).
  if (path === "" || path === "landing") return { kind: "landing" };
  if (path.startsWith("live/")) {
    const runId = decodeURIComponent(path.slice(5));
    if (runId) return { kind: "live", runId };
  }
  if (path === "targets") return { kind: "targets" };
  if (path === "profiles") return { kind: "profiles" };
  if (path === "compare") {
    const params = new URLSearchParams(query ?? "");
    return {
      kind: "compare",
      a: params.get("a") ?? undefined,
      b: params.get("b") ?? undefined,
    };
  }
  return { kind: "runs" };
}

function setHash(page: Page): void {
  switch (page.kind) {
    case "landing":
      window.location.hash = "#/landing";
      break;
    case "runs":
      window.location.hash = "#/runs";
      break;
    case "live":
      window.location.hash = `#/live/${encodeURIComponent(page.runId)}`;
      break;
    case "targets":
      window.location.hash = "#/targets";
      break;
    case "profiles":
      window.location.hash = "#/profiles";
      break;
    case "compare": {
      const params = new URLSearchParams();
      if (page.a) params.set("a", page.a);
      if (page.b) params.set("b", page.b);
      const qs = params.toString();
      window.location.hash = qs ? `#/compare?${qs}` : "#/compare";
      break;
    }
  }
}

export function RunProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(reduce, initialState);
  const [activeRunId, setActiveRunId] = useState<string | null>(null);
  const [page, setPage] = useState<Page>(parseHash);
  const [expectedAgents, setExpectedAgents] = useState<number | null>(null);
  const [replayTick, setReplayTick] = useState<{
    position: number;
    length: number;
    playing: boolean;
    speed: number;
  } | null>(null);

  const socketRef = useRef<RunSocket | null>(null);
  const driverRef = useRef<ReplayDriver | null>(null);

  // Listen for hash changes (back/forward navigation).
  useEffect(() => {
    const handler = () => setPage(parseHash());
    window.addEventListener("hashchange", handler);
    return () => window.removeEventListener("hashchange", handler);
  }, []);

  const navigate = useCallback((p: Page) => {
    setHash(p);
    setPage(p);
  }, []);

  const teardown = useCallback(() => {
    socketRef.current?.close();
    socketRef.current = null;
    driverRef.current?.dispose();
    driverRef.current = null;
    setReplayTick(null);
  }, []);

  const watchRun = useCallback(
    (runId: string, agents?: number) => {
      teardown();
      setActiveRunId(runId);
      setExpectedAgents(agents ?? null);
      dispatch({ type: "reset" });
      dispatch({ type: "conn", conn: "connecting" });
      const socket = new RunSocket(runId, {
        onOpen: () => {
          // Server replays the full backlog after open: rebuild from zero.
          // The reducer deduplicates, so re-sent events produce no changes.
          dispatch({ type: "conn", conn: "live" });
          dispatch({ type: "reset" });
        },
        onEvent: (event) => dispatch({ type: "event", event }),
        onReconnecting: () => dispatch({ type: "conn", conn: "reconnecting" }),
        onComplete: () => dispatch({ type: "conn", conn: "complete" }),
        onOffline: () => dispatch({ type: "conn", conn: "offline" }),
      });
      socketRef.current = socket;
      socket.connect();
      // Navigate to the live view.
      navigate({ kind: "live", runId });
    },
    [teardown, navigate],
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
      navigate({ kind: "live", runId });
    },
    [teardown, navigate],
  );

  const stop = useCallback(() => {
    teardown();
    setActiveRunId(null);
    setExpectedAgents(null);
    dispatch({ type: "reset" });
    dispatch({ type: "conn", conn: "idle" });
  }, [teardown]);

  const reconnect = useCallback(() => {
    if (socketRef.current) {
      dispatch({ type: "conn", conn: "connecting" });
      socketRef.current.reconnect();
    }
  }, []);

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
    () => ({ state, activeRunId, page, navigate, watchRun, expectedAgents, startReplay, replay, stop, reconnect }),
    [state, activeRunId, page, navigate, watchRun, expectedAgents, startReplay, replay, stop, reconnect],
  );

  return <RunContext.Provider value={value}>{children}</RunContext.Provider>;
}

export function useRun(): RunContextValue {
  const ctx = useContext(RunContext);
  if (ctx === null) throw new Error("useRun must be used inside RunProvider");
  return ctx;
}
