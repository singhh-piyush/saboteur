
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
  | { kind: "walkthrough" }
  | { kind: "runs" }
  | { kind: "live"; runId: string }
  | { kind: "targets" }
  | { kind: "profiles" }
  | { kind: "compare"; a?: string; b?: string };

export interface RunContextValue {
  state: RunViewState;
  /** currently watched or replayed run id */
  activeRunId: string | null;
  /** current page from hash router */
  page: Page;
  /** navigate to a page */
  navigate: (page: Page) => void;
  /** start watching a run via live websocket; stops any replay. `expectedAgents` is a ui hint for skeleton grid size */
  watchRun: (runId: string, expectedAgents?: number) => void;
  /** expected agent count (skeleton hint) */
  expectedAgents: number | null;
  /** start replaying a recorded event array; stops any live socket */
  startReplay: (runId: string, events: TelemetryEvent[]) => void;
  replay: ReplayControls | null;
  stop: () => void;
  /** manual reconnect after max retries exhausted */
  reconnect: () => void;
}

export const RunContext = createContext<RunContextValue | null>(null);

function parseHash(): Page {
  const raw = window.location.hash.replace(/^#\/?/, "");
  const [path, query] = raw.split("?");
  if (path === "" || path === "landing") return { kind: "landing" };
  if (path === "walkthrough") return { kind: "walkthrough" };
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
    case "walkthrough":
      window.location.hash = "#/walkthrough";
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
