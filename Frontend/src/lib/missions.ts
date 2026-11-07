// Missions from backend GET /api/missions.
export interface Mission {
  id: string;
  started_at?: number;
  ended_at?: number | null;
  status: string;
  replay_built?: number;
  // display fallbacks
  name?: string;
  date?: string;
  duration?: string;
  faults?: number;
}

export function missionStatus(m: Mission): "NOMINAL" | "CAUTION" | "CRITICAL" {
  if (m.status === "ENDED" || m.status === "CRITICAL") return "CRITICAL";
  if (m.status === "CAUTION") return "CAUTION";
  return "NOMINAL";
}

export function missionStatusColor(s: "NOMINAL" | "CAUTION" | "CRITICAL"): string {
  return s === "CRITICAL"
    ? "var(--color-crit)"
    : s === "CAUTION"
      ? "var(--color-caution)"
      : "var(--color-ok)";
}

export function fmtDuration(m: Mission): string {
  if (m.duration) return m.duration;
  if (m.started_at && m.ended_at) {
    const s = Math.max(0, Math.round((m.ended_at - m.started_at) / 1000));
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
  }
  return m.ended_at ? "ended" : "live";
}

export function fmtDate(m: Mission): string {
  if (m.date) return m.date;
  if (m.started_at) return new Date(m.started_at).toISOString().slice(0, 10);
  return "";
}
