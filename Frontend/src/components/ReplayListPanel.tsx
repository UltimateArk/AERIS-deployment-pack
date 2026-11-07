import { useState } from "react";
import type { Mission } from "../lib/missions";
import { fmtDate, fmtDuration, missionStatus, missionStatusColor } from "../lib/missions";
import { SlidePanel } from "./SlidePanel";

export function ReplayListPanel({
  open,
  onClose,
  missionId,
  missions,
  onSelect,
  onDelete,
  onClearDatabase,
}: {
  open: boolean;
  onClose: () => void;
  missionId: string;
  missions: Mission[];
  onSelect: (m: Mission) => void;
  onDelete: (m: Mission) => void;
  onClearDatabase: () => void;
}) {
  const [delTarget, setDelTarget] = useState<Mission | null>(null);
  return (
    <>
    <SlidePanel
      open={open}
      onClose={onClose}
      title="Mission Replays"
      footer={
        <button
          onClick={() => {
            if (
              window.confirm(
                "Wipe ALL missions, telemetry, replays, fault logs AND engine wear ledgers? This cannot be undone.",
              )
            )
              onClearDatabase();
          }}
          className="w-full px-3 py-1.5 font-cond text-[12px] font-500 uppercase tracking-[0.1em] transition-colors hover:brightness-110 active:translate-y-px"
          style={{ border: "1px solid var(--color-crit)", background: "var(--color-crit)", color: "#fff" }}
        >
          🗑 Clear Database
        </button>
      }
    >
      <div className="mb-2 flex items-center gap-2 px-0.5">
        <span className="font-cond text-[12px] font-500 uppercase text-[var(--color-ink-2)]">
          Mission
        </span>
        <span className="font-stencil text-[12px] text-[var(--color-ink)]">{missionId}</span>
      </div>
      <div className="flex flex-col gap-2">
        {missions.length === 0 && (
          <span className="font-mono text-[12px] uppercase text-[var(--color-ink-2)]">
            No missions yet - start the engine.
          </span>
        )}
        {missions.map((m, i) => {
          const st = missionStatus(m);
          return (
          <div
            key={m.id}
            className="flex items-stretch gap-1 p-2.5 transition-colors hover:brightness-[0.97]"
            style={{
              border: "1px solid var(--color-line)",
              background: "var(--color-panel-2)",
              borderLeft: `3px solid ${missionStatusColor(st)}`,
            }}
          >
            <button
              onClick={() => onSelect(m)}
              className="flex min-w-0 flex-1 flex-col gap-1 text-left active:translate-y-px"
            >
              <div className="flex items-center justify-between">
                <span className="font-cond text-[14px] font-600 uppercase tracking-[0.04em] text-[var(--color-ink)]">
                  {m.name || `Mission ${i + 1}`}
                </span>
                <span
                  className="font-mono text-[12px] font-500 uppercase"
                  style={{ color: missionStatusColor(st) }}
                >
                  {m.status}{m.replay_built ? "" : " · building…"}
                </span>
              </div>
              <div className="flex items-center gap-3 font-mono text-[12px] tabular-nums text-[var(--color-ink-2)]">
                <span>◷ {fmtDate(m)}</span>
                <span>⧗ {fmtDuration(m)}</span>
              </div>
            </button>
            <button
              onClick={() => setDelTarget(m)}
              title={`Delete mission "${m.name || m.id}"`}
              className="shrink-0 self-center rounded px-1.5 py-1 font-mono text-[13px] transition-colors hover:brightness-125 active:translate-y-px"
              style={{ border: "1px solid var(--color-line-soft)", color: "var(--color-crit)" }}
            >
              🗑
            </button>
          </div>
          );
        })}
      </div>
    </SlidePanel>

      {delTarget && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4"
          style={{ background: "rgba(20,22,18,0.45)", backdropFilter: "blur(6px)" }}
          onClick={() => setDelTarget(null)}
        >
          <div
            className="w-full max-w-[400px] overflow-hidden"
            style={{ border: "1px solid var(--color-line)", background: "var(--color-panel)",
                     boxShadow: "0 8px 40px rgba(0,0,0,0.35)" }}
            onClick={(e) => e.stopPropagation()}
          >
            <header className="px-5 pb-2.5 pt-5 text-center" style={{ borderBottom: "1px solid var(--color-line-soft)" }}>
              <h2 className="font-stencil text-[18px] tracking-wide" style={{ color: "var(--color-crit)" }}>
                DELETE MISSION?
              </h2>
              <p className="mt-1 font-mono text-[12px] uppercase text-[var(--color-ink-2)]">
                "{delTarget.name || delTarget.id}" · replay + telemetry + logs go too
              </p>
            </header>
            <div className="flex gap-2 p-5">
              <button
                onClick={() => setDelTarget(null)}
                className="flex-1 px-3 py-2 font-cond text-[13px] font-600 uppercase tracking-[0.1em] transition-colors hover:brightness-95"
                style={{ border: "1px solid var(--color-line)", background: "var(--color-panel-2)", color: "var(--color-ink)" }}
              >
                Cancel
              </button>
              <button
                onClick={() => { onDelete(delTarget); setDelTarget(null); }}
                className="flex-1 px-3 py-2 font-cond text-[13px] font-600 uppercase tracking-[0.1em] transition-colors hover:brightness-110"
                style={{ background: "var(--color-crit)", color: "#fff" }}
              >
                Delete 🗑
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
