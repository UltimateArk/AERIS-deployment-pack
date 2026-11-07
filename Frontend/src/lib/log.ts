import type { Severity } from "./faults";

export interface FaultLogEntry {
  id: string;
  faultId: string;
  name: string;
  severity: Severity;
  time: string;
  action: "injected" | "cleared";
}

export function nowStamp(): string {
  const d = new Date();
  const p = (n: number) => n.toString().padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}Z`;
}
