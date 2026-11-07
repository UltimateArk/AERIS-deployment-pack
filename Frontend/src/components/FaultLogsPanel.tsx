import { SEVERITY_COLOR } from "../lib/faults";
import type { FaultLogEntry } from "../lib/log";
import { SlidePanel } from "./SlidePanel";

export function FaultLogsPanel({
  open,
  onClose,
  logs,
  onClear,
}: {
  open: boolean;
  onClose: () => void;
  logs: FaultLogEntry[];
  onClear: () => void;
}) {
  return (
    <SlidePanel
      open={open}
      onClose={onClose}
      title="Fault Logs"
      footer={
        <button
          onClick={onClear}
          disabled={logs.length === 0}
          className={`w-full px-3 py-1.5 font-cond text-[12px] font-500 uppercase tracking-[0.1em] transition-colors ${
            logs.length === 0 ? "cursor-not-allowed opacity-40" : "hover:brightness-95 active:translate-y-px"
          }`}
          style={{ border: "1px solid var(--color-crit)", background: "var(--color-panel-2)", color: "var(--color-crit)" }}
        >
          ✕ Clear Logs
        </button>
      }
    >
      <div className="mb-2 flex items-center justify-between px-0.5">
        <span className="font-cond text-[12px] font-500 uppercase text-[var(--color-ink-2)]">
          Event History
        </span>
        <span className="font-mono text-[12px] tabular-nums text-[var(--color-ink-2)]">{logs.length} ENTRIES</span>
      </div>
      {logs.length === 0 ? (
        <div
          className="flex items-center justify-center py-10 font-mono text-[12px] uppercase text-[var(--color-ink-2)]"
          style={{ border: "1px dashed var(--color-line-soft)" }}
        >
          No logged events
        </div>
      ) : (
        <ul className="flex flex-col">
          {logs.map((e) => {
            const color = SEVERITY_COLOR[e.severity];
            return (
              <li
                key={e.id}
                className="flex items-center gap-2.5 px-2 py-1.5"
                style={{ borderBottom: "1px solid var(--color-line-soft)", borderLeft: `3px solid ${color}` }}
              >
                <span className="h-[9px] w-[9px] shrink-0" style={{ background: color }} />
                <div className="flex min-w-0 flex-1 flex-col">
                  <span className="font-cond text-[13px] font-500 leading-tight text-[var(--color-ink)]">
                    {e.name}
                    {e.action === "cleared" && (
                      <span className="ml-1.5 font-mono text-[12px] text-[var(--color-ink-2)]">
                        RESOLVED
                      </span>
                    )}
                  </span>
                  <span className="font-mono text-[12px] tabular-nums text-[var(--color-ink-2)]">
                    {e.time} · {e.action === "injected" ? "DETECTED" : "CLEARED"}
                  </span>
                </div>
                <span
                  className="shrink-0 font-mono text-[12px] font-500 uppercase rounded-full px-1.5 py-px"
                  style={{ color, border: `1px solid ${color}` }}
                >
                  {e.severity === "Critical"
                    ? "CRIT"
                    : e.severity === "High"
                      ? "HIGH"
                      : e.severity === "Low"
                        ? "LOW"
                        : "MED"}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </SlidePanel>
  );
}
