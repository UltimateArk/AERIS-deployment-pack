// Direct display link to the twin. Feeds 3D model, graphs, and telemetry tiles.
// External stores update at 10 Hz without console re-renders.
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";

const TWIN_BASE =
  (import.meta as unknown as { env?: Record<string, string> }).env
    ?.VITE_TWIN_BASE ?? "http://localhost:8000";
const TWIN_WS =
  ((import.meta as unknown as { env?: Record<string, string> }).env
    ?.VITE_TWIN_WS as string | undefined) ??
  TWIN_BASE.replace(/^http/, "ws") + "/engine";

async function twinApi(path: string, init?: RequestInit) {
  const r = await fetch(TWIN_BASE + path, {
    headers: { "Content-Type": "application/json" },
    ...init,
  });
  if (!r.ok) throw new Error(`${path}: ${r.status}`);
  return r.json().catch(() => ({}));
}

const twinPost = (path: string, body: unknown = {}) =>
  twinApi(path, { method: "POST", body: JSON.stringify(body) });

export const twinRest = {
  start: () => twinPost("/engine/start"),
  stop: () => twinPost("/engine/stop"),
  controls: (b: Record<string, number>) => twinPost("/engine/set_controls", b),
  switchEngine: (engineId: string) => twinPost("/engine/switch", { engineId }),
  resetEngine: () => twinPost("/engine/reset"),
};

export type TwinFrame = Record<string, number | string | number[] | object | boolean> & {
  t?: number;
  mission_t?: number;
  mission_id?: string | number;
  rpm?: number;
};

const HIST_N = 300;

// Tiny external stores.
export interface Store<T> {
  subscribe: (l: () => void) => () => void;
  get: () => T;
}
function makeStore<T>(initial: T): Store<T> & { set: (n: T) => void } {
  let state = initial;
  const listeners = new Set<() => void>();
  return {
    subscribe(l) { listeners.add(l); return () => listeners.delete(l); },
    get: () => state,
    set(n) { state = n; listeners.forEach((f) => f()); },
  };
}
export function useTwinStore<T>(store: Store<T>): T {
  return useSyncExternalStore(store.subscribe, store.get, store.get);
}

export interface DisplayState {
  history: Record<string, number>[];
  latest: Record<string, number> | null;
}
export interface HealthState {
  health: number;
  history: { t: number; h: number }[];
}

export function useTwinDirect() {
  const [connected, setConnected] = useState(false);
  const [engineOn, setEngineOn] = useState(false);
  const [engineId, setEngineId] = useState("ENG-01");
  const [controls, setControls] = useState({
    rpm: 5500, load: 60, afr: 14.7, cooling: 1,
    injTiming: 20, altitude: 0, ambientT: 15, humidity: 30,
  });

  const latestRef = useRef<TwinFrame | null>(null);
  const bufRef = useRef<Record<string, number>[]>([]);
  const controlsRef = useRef(controls);
  useEffect(() => { controlsRef.current = controls; }, [controls]);
  const engineOnRef = useRef(engineOn);
  useEffect(() => { engineOnRef.current = engineOn; }, [engineOn]);

  // Stable store identities for the lifetime of the hook.
  const displayRef = useRef(makeStore<DisplayState>({ history: [], latest: null }));
  const healthRef = useRef(makeStore<HealthState>({
    health: 100,
    history: Array.from({ length: 40 }, (_, i) => ({ t: i, h: 100 })),
  }));
  const hhTRef = useRef(40);
  const lastHealthRef = useRef(100);

  // WS stores frames without setState. Rate guard keeps one frame per 90 ms.
  let lastKeptWall = 0;
  useEffect(() => {
    let closed = false;
    let retry: ReturnType<typeof setTimeout>;
    let live: WebSocket | null = null;
    const connect = () => {
      try {
        live = new WebSocket(TWIN_WS);
      } catch {
        return;
      }
      const ws = live;
      ws.onopen = () => { if (!closed) setConnected(true); };
      ws.onmessage = (ev) => {
        try {
          const m = JSON.parse(ev.data);
          if (!m || typeof m !== "object" || Array.isArray(m)) return;
          if ((m as { end_of_mission?: boolean }).end_of_mission !== true) {
            const now = Date.now();
            if (now - lastKeptWall < 90) return;
            lastKeptWall = now;
          }
          latestRef.current = m as TwinFrame;
        } catch { }
      };
      ws.onclose = () => {
        if (closed) return;
        setConnected(false);
        retry = setTimeout(connect, 2000);
      };
      ws.onerror = () => ws.close();
    };
    connect();
    return () => {
      closed = true;
      clearTimeout(retry);
      // Close socket on cleanup. Prevents duplicate streams in dev.
      try { live?.close(); } catch { }
      live = null;
    };
  }, []);

  // Flush into stores at 10 Hz. Gap stats record delivery in window.__aeris_perf.
  const gapRef = useRef<{ n: number; sum: number; max: number; last: number }>({ n: 0, sum: 0, max: 0, last: 0 });
  useEffect(() => {
    const id = setInterval(() => {
      const g = gapRef.current;
      if (g.n > 10) {
        const avg = g.sum / g.n;
        (window as unknown as { __aeris_perf?: object }).__aeris_perf = {
          ...((window as unknown as { __aeris_perf?: object }).__aeris_perf ?? {}),
          twin: { avgGapMs: Math.round(avg), maxGapMs: Math.round(g.max), kept: g.n },
        };
        if (avg > 150 || g.max > 500)
          console.info(`[perf:twin] avg flush gap ${avg.toFixed(0)}ms max ${g.max.toFixed(0)}ms over ${g.n} flushes - tab starved, not the twin`);
      }
      gapRef.current = { n: 0, sum: 0, max: 0, last: g.last };
    }, 5000);
    return () => clearInterval(id);
  }, []);
  useEffect(() => {
    const id = setInterval(() => {
      const s = latestRef.current;
      if (!s) return;
      const nowP = performance.now();
      const gg = gapRef.current;
      if (gg.last > 0) {
        const gap = nowP - gg.last;
        gg.n++; gg.sum += gap; gg.max = Math.max(gg.max, gap);
      }
      gg.last = nowP;
      // Stop marker skips display.
      if (s.end_of_mission === true) return;
      // Parked heartbeats skip display. Console holds baseline until start and freezes after end.
      if ((s as { parked?: boolean }).parked === true) {
        const eid = (s as { engineId?: string }).engineId;
        if (typeof eid === "string" && eid) setEngineId(eid);
        return;
      };
      const row: Record<string, number> = { t: Number(s.mission_t ?? s.t ?? 0) };
      for (const [k, v] of Object.entries(s)) {
        if (typeof v === "number") row[k] = v;
      }
      // Re-assert mission clock. Keeps graph x-axis stable within a mission.
      row.t = Number(s.mission_t ?? s.t ?? 0);
      const hz = (s as { health?: Record<string, number> }).health;
      if (hz) {
        row.h_oil = hz.oil ?? 100; row.h_cool = hz.cool ?? 100;
        row.h_comb = hz.comb ?? 100; row.h_vib = hz.vib ?? 100;
        row.h_elec = hz.elec ?? 100;
      }
      const eid = (s as { engineId?: string }).engineId;
      if (typeof eid === "string" && eid) setEngineId(eid);

      const h = bufRef.current;
      h.push(row);
      if (h.length > HIST_N) h.splice(0, h.length - HIST_N);
      displayRef.current.set({ history: [...h], latest: row });

      // Health store notifies on integer change. Limits ML re-renders.
      const hv = Math.round(Math.min(row.h_oil, row.h_cool, row.h_comb, row.h_vib, row.h_elec));
      if (hv !== lastHealthRef.current) {
        lastHealthRef.current = hv;
        const prev = healthRef.current.get().history;
        healthRef.current.set({
          health: hv,
          history: [...prev.slice(1), { t: hhTRef.current++, h: hv }],
        });
      }
    }, 100);
    return () => clearInterval(id);
  }, []);

  const clearBuffers = useCallback(() => {
    bufRef.current = [];
    displayRef.current.set({ history: [], latest: null });
    // Fresh missions reset health. Store moves only on change.
    lastHealthRef.current = 100;
    healthRef.current.set({
      health: 100,
      history: Array.from({ length: 40 }, (_, i) => ({ t: i, h: 100 })),
    });
  }, []);

  // Start pushes panel controls. Twin boots with rpm_cmd 0.
  const toggleEngine = useCallback(async () => {
    const next = !engineOnRef.current;
    setEngineOn(next);
    if (next) {
      const c = { ...controlsRef.current };
      twinRest.start()
        .then(() => twinRest.controls(c).catch(() => {}))
        .catch(() => {});
    } else {
      twinRest.stop().catch(() => {});
    }
  }, []);

  const updateControls = useCallback((patch: Record<string, number>) => {
    setControls((c) => ({ ...c, ...patch }));
    twinRest.controls(patch).catch(() => {});
  }, []);

  const switchEngine = useCallback(async (eid: string) => {
    setEngineOn(false);
    setEngineId(eid);
    clearBuffers();
    await twinRest.switchEngine(eid).catch(() => {});
  }, [clearBuffers]);

  const resetEngine = useCallback(async () => {
    await twinRest.resetEngine().catch(() => {});
  }, []);

  return {
    connected, engineOn, controls, engineId,
    switchEngine, resetEngine, toggleEngine, updateControls, clearBuffers,
    // Refs for 3D viewer. Stores for charts and tiles.
    frameRef: latestRef, engineOnRef,
    display: displayRef.current as Store<DisplayState>,
    healthStore: healthRef.current as Store<HealthState>,
  };
}

export { TWIN_BASE, TWIN_WS };
