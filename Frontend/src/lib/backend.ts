// Backend client for :8081 REST and WS. Engine :8000 routes through backend proxy.
import { authHeaders, wsUrl as withToken, tryRefresh } from "./auth";

const API_BASE =
  (import.meta as unknown as { env?: Record<string, string> }).env
    ?.VITE_API_BASE ?? "http://localhost:8081";
const WS_URL =
  ((import.meta as unknown as { env?: Record<string, string> }).env
    ?.VITE_WS_URL as string | undefined) ??
  API_BASE.replace(/^http/, "ws");

async function api(path: string, init?: RequestInit, retried = false): Promise<unknown> {
  const r = await fetch(API_BASE + path, {
    headers: { "Content-Type": "application/json", ...authHeaders(), ...(init?.headers ?? {}) },
    ...init,
  });
  if (r.status === 401) {
    // One recovery attempt on 401. Refresh and retry once, then redirect to login.
    if (!retried && (await tryRefresh())) return api(path, init, true);
    window.dispatchEvent(new Event("aeris:unauthorized"));
    throw new Error(`${path}: 401`);
  }
  if (!r.ok) throw new Error(`${path}: ${r.status}`);
  return r.json();
}

const post = (path: string, body: unknown = {}) =>
  api(path, { method: "POST", body: JSON.stringify(body) });

export const rest = {
  health: () => api("/health"),
  start: () => post("/api/start"),
  stop: () => post("/api/stop"),
  controls: (b: Record<string, number>) => post("/api/controls", b),
  env: (b: Record<string, number>) => post("/api/env", b),
  fault: (faultId: number, enabled: boolean, magnitude = 0.9, extra: Record<string, number | string> = {}) =>
    post("/api/fault", { faultId, enabled, magnitude, ...extra }),
  faults: () => api("/api/faults"),
  clearFaults: () => post("/api/faults/clear"),
  missions: () => api("/api/missions"),
  sessions: () => api("/api/sessions"),
  engines: () => api("/api/engines"),
  sessionCurrent: () => api("/api/session/current"),
  sessionStart: (b: { name: string; engineId: string; pilot: string }) =>
    post("/api/session/start", b),
  sessionEnd: () => post("/api/session/end", {}),
  switchEngine: (engineId: string) => post("/api/switch", { engineId }),
  resetEngine: (b: { engineId: string }) => post("/api/engine/reset", b),
  replay: (id: string | number) => api(`/api/replay/${id}`),
  deleteReplay: (id: string | number) => api(`/api/replay/${id}`, { method: "DELETE" }),
  replayFaults: (id: string | number) => api(`/api/replay/${id}/faults`),
  clearDatabase: () => post("/api/admin/clear", {}),
};

// Backend WS protocol. Tick, fast, trend, rul, and mission messages.
export type TickMsg = Record<string, number | string | number[] | object> & {
  kind: "tick";
  t: number;
  mission_id: string | number;
};
export interface AnomalyMsg { flag: boolean; score: number; feature: string | null }
export interface FaultMsg {
  code: number; name: string; severity: string; action: string;
  description: string; cause: string; rectification: string; subsystem: string;
  p: number; calibrated: number; cylinder?: number;
}
export interface FastMsg {
  kind: "fast"; ts: number; missionId: string | number;
  anomaly: AnomalyMsg; fault: FaultMsg | null; candidates: FaultMsg[];
}
export interface TrendMsg {
  kind: "trend"; ts: number; missionId: string | number;
  trend: Record<string, { roc: number; status: "RISING" | "FALLING" | "STABLE" }>;
}
export interface RulMsg {
  kind: "rul"; ts: number; missionId: string | number;
  rul: number; rulSmoothed: number;
}
export interface MissionMsg {
  kind: "mission"; event: "start" | "end"; missionId: string | number;
}
export type WsMsg = TickMsg | FastMsg | TrendMsg | RulMsg | MissionMsg;

export { API_BASE, WS_URL, withToken };
