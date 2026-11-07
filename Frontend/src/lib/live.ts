// Backend data hook. WS ticks and messages plus REST actions.
// Feeds live values, missions, and replay.
import { useCallback, useEffect, useRef, useState } from "react";
import {
  rest, WS_URL, withToken, type FastMsg, type TickMsg, type WsMsg,
} from "./backend";
import { FAULT_BY_ID, type Severity } from "./faults";

export interface LiveFault {
  code: number;
  conf: number;
  origin: string | null;
  age: number | null;
  cyl: number | null;
  trend: string | null;
  onset: string | null; // first-detected wall clock (stable, not a ticking age)
}

export interface ReplayFrame {
  t: number;
  values: Record<string, number>;
  faults: number[];
  flag: boolean;
}

const HIST_N = 300;

function toSeverity(s: string | null | undefined): Severity {
  switch ((s ?? "").toUpperCase()) {
    case "CRITICAL": return "Critical";
    case "HIGH": return "High";
    case "MEDIUM-HIGH": return "Med-High";
    case "MEDIUM": return "Med";
    default: return "Low";
  }
}

export function useBackend() {
  const [wsConnected, setWsConnected] = useState(false);
  const [snapshot, setSnapshot] = useState<TickMsg | null>(null);
  const [engineOn, setEngineOn] = useState(false);
  const [controls, setControls] = useState({
    rpm: 5500, load: 60, afr: 14.7, cooling: 1,
    injTiming: 20, altitude: 0, ambientT: 15, humidity: 30,
  });
  const [faults, setFaults] = useState<LiveFault[]>([]);
  const [desired, setDesired] = useState<Set<string>>(new Set());
  const [anomaly, setAnomaly] = useState(false);
  // Predicted faults from trend projections. Future faults expire after 7s.
  const [predicted, setPredicted] = useState<{ key: string; code: number; ttfSec: number; at: number }[]>([]);
  // Twin-confirmed active faults polled at 0.2 Hz. Separates sent state from twin state.
  const [twinActive, setTwinActive] = useState<string[]>([]);
  useEffect(() => {
    let stop = false;
    const poll = async () => {
      try {
        const r = (await rest.faults()) as { active?: Record<string, number> };
        if (!stop && r && r.active) setTwinActive(Object.keys(r.active));
      } catch { }
    };
    poll();
    const id = setInterval(poll, 5000);
    return () => { stop = true; clearInterval(id); };
  }, []);  const progRef = useRef<Record<string, { key: string; code: number; ttfSec: number; at: number }>>({});
  const [rulBurn, setRulBurn] = useState(1); // Cruise multiplier.
  const [lifeConsumed, setLifeConsumed] = useState(0); // Hours across missions.
  const [lifeDelta, setLifeDelta] = useState(0); // Hours this mission.
  const lifeStartRef = useRef<number | null>(null);
  // RUL stays null until the first live message.
  const [rul, setRul] = useState<number | null>(null);
  const [trend, setTrend] = useState<Record<string, string>>({});
  const [missionId, setMissionId] = useState<string | null>(null);
  const [replayFrames, setReplayFrames] = useState<ReplayFrame[] | null>(null);
  const [log, setLog] = useState<
    { id: string; faultId: string; name: string; severity: Severity; time: string; action: string }[]
  >([]);

  const historyRef = useRef<Record<string, number>[]>([]);
  const recentRef = useRef<{ codes: number[]; at: number }[]>([]);
  const seenRef = useRef<Set<string>>(new Set());
  // Card hysteresis with vote and hold timers. Prevents borderline flapping.
  const holdRef = useRef<Record<number, number>>({});
  // Last full candidate per code. Preserves conf and cylinder across ticks.
  const candRef = useRef<Record<number, FastMsg["candidates"][number]>>({});
  // First-seat time per code. Stable onset stamp for cards.
  const onsetRef = useRef<Record<number, string>>({});
  const wsRef = useRef<WebSocket | null>(null);
  const desiredRef = useRef(desired);
  useEffect(() => { desiredRef.current = desired; }, [desired]);
  const engineOnRef = useRef(engineOn);
  useEffect(() => { engineOnRef.current = engineOn; }, [engineOn]);
  // Warmup gate from mission clock. Detections pause during spool-up.
  const missionTRef = useRef(1e9);
  const snapSigRef = useRef("");
  // Rate guard processes one tick per 90 ms. Limits console re-renders.
  const lastTickWallRef = useRef(0);
  // Delivery probe. Records backend cadence in window.__aeris_perf.
  const beGapRef = useRef<{ n: number; sum: number; max: number; last: number }>({ n: 0, sum: 0, max: 0, last: 0 });
  useEffect(() => {
    const id = setInterval(() => {
      const g = beGapRef.current;
      if (g.n > 10) {
        const avg = g.sum / g.n;
        (window as unknown as { __aeris_perf?: object }).__aeris_perf = {
          ...((window as unknown as { __aeris_perf?: object }).__aeris_perf ?? {}),
          backend: { avgGapMs: Math.round(avg), maxGapMs: Math.round(g.max), kept: g.n },
        };
        if (avg > 150 || g.max > 500)
          console.info(`[perf:backend] avg tick gap ${avg.toFixed(0)}ms max ${g.max.toFixed(0)}ms over ${g.n} ticks - backend/WS starved`);
      }
      beGapRef.current = { n: 0, sum: 0, max: 0, last: g.last };
    }, 5000);
    return () => clearInterval(id);
  }, []);
  // Tracks last mission from ticks. End clears only the matching mission.
  const missionIdRef = useRef<string | null>(null);
  const controlsRef = useRef(controls);
  useEffect(() => { controlsRef.current = controls; }, [controls]);

  const pushLog = useCallback((faultId: string, action: string) => {
    const def = FAULT_BY_ID[faultId];
    if (!def) return;
    setLog((l) => [
      { id: `${faultId}-${Date.now()}`, faultId, name: def.name,
        severity: def.severity, time: new Date().toISOString(), action },
      ...l,
    ].slice(0, 200));
  }, []);

  // WS connect with auto-retry.
  useEffect(() => {
    let closed = false;
    let retry: ReturnType<typeof setTimeout>;
    const connect = () => {
      let ws: WebSocket;
      try {
        ws = new WebSocket(withToken(WS_URL));
      } catch {
        return;
      }
      wsRef.current = ws;
      ws.onopen = () => { if (!closed) setWsConnected(true); };
      ws.onmessage = (ev) => {
        try {
          const m = JSON.parse(ev.data) as WsMsg;
          if (m.kind === "tick") {
            const t = m as TickMsg;
            const nowW = Date.now();
            if (nowW - lastTickWallRef.current < 90) return;
            lastTickWallRef.current = nowW;
            const bg = beGapRef.current;
            if (bg.last > 0) {
              const gap = nowW - bg.last;
              bg.n++; bg.sum += gap; bg.max = Math.max(bg.max, gap);
            }
            bg.last = nowW;
            missionTRef.current = Number((t as { mission_t?: number }).mission_t ?? t.t ?? 0);
            const row: Record<string, number> = { t: Number(t.mission_t ?? t.t ?? 0) };
            for (const [k, v] of Object.entries(t)) {
              if (typeof v === "number") row[k] = v;
            }
            const h = historyRef.current;
            h.push(row);
            if (h.length > HIST_N) h.splice(0, h.length - HIST_N);
            // Throttled snapshot on decorator change. Quantized ages and health limit re-renders.
            const fa = (t as { faultAge?: Record<string, number> }).faultAge ?? null;
            const hh = (t as { health?: Record<string, number> }).health ?? null;
            const sig = JSON.stringify({
              o: (t as { faultOrigin?: object }).faultOrigin ?? null,
              a: fa ? Object.fromEntries(Object.entries(fa).map(([k, v]) => [k, Math.floor(Number(v) / 5)])) : null,
              h: hh ? Object.fromEntries(Object.entries(hh).map(([k, v]) => [k, Math.round(Number(v))])) : null,
            });
            if (sig !== snapSigRef.current) {
              snapSigRef.current = sig;
              setSnapshot(t);
            }
            // Backend drives engine state from live rpm. Mission end is the off signal.
            if (Number(t.rpm ?? 0) > 200) setEngineOn((p) => (p ? p : true));
            if (t.mission_id !== undefined && t.mission_id !== null) {
              missionIdRef.current = String(t.mission_id);
              setMissionId((cur) => {
                const id = String(t.mission_id);
                return cur === id ? cur : id;
              });
            }
          } else if (m.kind === "fast") {
            const f = m as FastMsg;
            setAnomaly(!!f.anomaly?.flag);
            // Detector pauses during spool-up. Events still log to the database.
            if (missionTRef.current < 8) return;
            const cands = (f.candidates ?? []).filter((c) => c && c.code > 0);
            const now = Date.now();
            recentRef.current.push({ codes: cands.map((c) => c.code), at: now });
            recentRef.current = recentRef.current.filter((r) => now - r.at < 3000);
            // Stable set needs 2 votes in a 3s window.
            const votes: Record<number, number> = {};
            for (const r of recentRef.current) for (const c of r.codes) votes[c] = (votes[c] ?? 0) + 1;
            for (const c of cands) candRef.current[c.code] = c;
            for (const [code] of Object.entries(votes).filter(([, v]) => v >= 2)) {
              const cd = +code;
              holdRef.current[cd] = now + 8000;
              if (!onsetRef.current[cd])
                onsetRef.current[cd] = new Date().toTimeString().slice(0, 8);
            }
            for (const [code, until] of Object.entries(holdRef.current))
              if (until < now) {
                delete holdRef.current[+code];
                delete onsetRef.current[+code];
              }
            const tick = f as unknown as { faultOrigin?: Record<string, string>; faultAge?: Record<string, number> };
            void tick;
            setFaults(
              Object.keys(holdRef.current).map((codeStr) => {
                const code = Number(codeStr);
                const c = candRef.current[code] ?? cands.find((x) => x.code === code);
                return {
                  code,
                // Display raw model probability. Backend stores both raw and calibrated values.
                  conf: c ? Number((c as { p?: number }).p ?? (c as { calibrated?: number }).calibrated ?? 0) : 0,
                  origin: null, age: null,
                  cyl: (c as { cylinder?: number })?.cylinder ?? null,
                  trend: null,
                  onset: onsetRef.current[code] ?? null,
                };
              }),
            );
            // Log newly confirmed codes.
            for (const c of cands) {
              const key = `${f.missionId}:${c.code}`;
              if (!seenRef.current.has(key)) {
                seenRef.current.add(key);
                const def = FAULT_BY_ID[String(c.code)];
                if (def) {
                  setLog((l) => [
                    { id: key, faultId: String(c.code), name: def.name,
                      severity: toSeverity((c as { severity?: string }).severity),
                      time: new Date().toISOString(), action: "detected" },
                    ...l,
                  ].slice(0, 200));
                }
              }
            }
            if (f.missionId !== undefined && f.missionId !== null) {
              setMissionId((cur) => {
                const id = String(f.missionId);
                return cur === id ? cur : id;
              });
            }
          } else if (m.kind === "trend") {
            const tr: Record<string, string> = {};
            for (const [k, v] of Object.entries((m as { trend: Record<string, { status: string }> }).trend ?? {})) {
              tr[k] = v.status;
            }
            setTrend(tr);
            // Predicted faults from trend projections. Forecast only until firing.
            const prog = (m as { prognosis?: { key: string; code: number; ttfSec: number }[] }).prognosis ?? [];
            const nowP = Date.now();
            for (const p of prog) progRef.current[p.key] = { ...p, at: nowP };
            const stale = Object.values(progRef.current).filter((p) => nowP - p.at < 7000);
            setPredicted(stale);
          } else if (m.kind === "rul") {
            const rm = m as { rulSmoothed?: number; rul?: number; burn?: number; consumed?: number };
            const r = rm.rulSmoothed ?? rm.rul;
            // RUL with 1-decimal precision. Shows fractional mission burn.
            if (typeof r === "number") setRul(Math.round(r * 10) / 10);
            if (typeof rm.burn === "number") setRulBurn(rm.burn);
            if (typeof rm.consumed === "number") {
              if (lifeStartRef.current === null) lifeStartRef.current = rm.consumed;
              setLifeConsumed(rm.consumed);
              setLifeDelta(rm.consumed - lifeStartRef.current);
            }
          } else if (m.kind === "mission") {
            const mm = m as { event: string; missionId: string | number };
            if (mm.event === "start") {
              missionIdRef.current = String(mm.missionId);
              setMissionId(String(mm.missionId));
              missionTRef.current = 0;
              lifeStartRef.current = null; // first rul msg of mission re-bases Δ
              snapSigRef.current = "";
              historyRef.current = [];
              recentRef.current = [];
              seenRef.current = new Set();
              holdRef.current = {};
              candRef.current = {};
              onsetRef.current = {};
              setFaults([]);
            } else if (mm.event === "end") {
              if (String(mm.missionId) === missionIdRef.current)
                setEngineOn(false);
            }
          }
        } catch { }
      };
      ws.onclose = (ev) => {
        if (closed) return;
        if (ev && ev.code === 4401) {
          // Token rejected at handshake. Refresh once and reconnect, then logout on failure.
          (async () => {
            const { tryRefresh } = await import("./auth");
            if (closed) return;
            if (await tryRefresh()) connect();
            else window.dispatchEvent(new Event("aeris:unauthorized"));
          })();
          return;
        }
        setWsConnected(false);
        retry = setTimeout(connect, 3000);
      };
      ws.onerror = () => ws.close();
    };
    connect();
    return () => {
      closed = true;
      clearTimeout(retry);
      wsRef.current?.close();
    };
  }, []);

  // Enrich faults with origin and age from latest tick.
  const snap = snapshot as unknown as {
    faultOrigin?: Record<string, string>; faultAge?: Record<string, number>;
  } | null;
  const faultsLive: LiveFault[] = faults.map((f) => ({
    ...f,
    origin: snap?.faultOrigin?.[String(f.code)] ?? null,
    age: snap?.faultAge?.[String(f.code)] ?? null,
  }));

  // Actions confirm over WS. Start also pushes current panel controls.
  const toggleEngine = useCallback(async () => {
    // Decide outside the updater. StrictMode double-invokes updaters in dev.
    const next = !engineOnRef.current;
    setEngineOn(next);
    if (next) {
      const c = controlsRef.current;
      rest.start()
        .then(() => rest.controls({
          rpm: c.rpm, load: c.load, afr: c.afr,
          cooling: c.cooling, injTiming: c.injTiming,
        }).catch(() => {}))
        .catch(() => {});
      rest.env({
        altitude: c.altitude, ambientT: c.ambientT, humidity: c.humidity,
      }).catch(() => {});
    } else {
      rest.stop().catch(() => {});
    }
  }, []);

  const updateControls = useCallback((patch: Record<string, number>) => {
    setControls((c) => ({ ...c, ...patch }));
    const env: Record<string, number> = {};
    const ctl: Record<string, number> = {};
    for (const [k, v] of Object.entries(patch)) {
      if (["altitude", "ambientT", "ambientP", "humidity"].includes(k)) env[k] = v;
      else ctl[k] = v;
    }
    if (Object.keys(ctl).length) rest.controls(ctl).catch(() => {});
    if (Object.keys(env).length) rest.env(env).catch(() => {});
  }, []);

  const toggleFault = useCallback((id: string) => {
    const code = parseInt(id, 10);
    if (!Number.isFinite(code)) return;
    // Decide outside the updater. Each click logs and posts once.
    const enabled = !desiredRef.current.has(id);
    setDesired((prev) => {
      const next = new Set(prev);
      if (enabled) next.add(id);
      else next.delete(id);
      return next;
    });
    // Cylinder faults carry cylinder ids. Twin, classifiers, and camera share the same mapping.
    const extra: Record<string, number> = {};
    if (code === 1) extra.cyl = 3;
    else if (code === 2) extra.cyl = 2;
    else if (code === 9) extra.cyl = 2;
    rest.fault(code, enabled, 0.9, extra).catch(() => {});
    pushLog(id, enabled ? "injected" : "cleared");
  }, [pushLog]);

  const clearFaults = useCallback(() => {
    setDesired(new Set());
    rest.clearFaults().catch(() => {});
  }, []);

  const randomFault = useCallback(() => {
    const ids = Object.keys(FAULT_BY_ID).filter((x) => x !== "0");
    const pick = ids[Math.floor(Math.random() * ids.length)];
    toggleFault(pick);
  }, [toggleFault]);

  const loadReplay = useCallback(async (id: string | number) => {
    const rows = (await rest.replay(id)) as Array<{
      ts: number; telemetry: Record<string, number>; fault_flag: number;
      fault_code: number; fault_codes?: string | null;
    }>;
    const t0 = rows.length ? rows[0].ts : 0;
    const frames: ReplayFrame[] = rows.map((r) => ({
      t: (r.ts - t0) / 1000,
      values: r.telemetry,
      faults: r.fault_codes
        ? String(r.fault_codes).split(",").map((x) => parseInt(x, 10)).filter((x) => x > 0)
        : r.fault_code > 0 ? [r.fault_code] : [],
      flag: r.fault_flag === 1,
    }));
    setReplayFrames(frames);
    return frames;
  }, []);
  const clearReplay = useCallback(() => setReplayFrames(null), []);

  const clearLog = useCallback(() => setLog([]), []);

  return {
    wsConnected, snapshot, historyRef, engineOn, controls, faults: faultsLive,
    desired, twinActive, anomaly, rul, trend, missionId, log,
    predicted, rulBurn, lifeConsumed, lifeDelta,
    replayFrames, loadReplay, clearReplay, clearLog,
    toggleEngine, updateControls, toggleFault, clearFaults, randomFault,
  };
}
