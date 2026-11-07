import { useEffect, useRef, useState } from "react";
import { fmtDate, fmtDuration, missionStatus, missionStatusColor, type Mission } from "../lib/missions";
import { CHANNELS, type Sample } from "../lib/telemetry";
import { GraphStack } from "./GraphStack";
import { FaultCard, type ActiveFault } from "./MLSection";
import { FAULT_BY_ID } from "../lib/faults";
import type { ReplayFrame } from "../lib/live";

const SPEEDS = [0.5, 1, 2, 4];

export function ReplayScreen({
  mission,
  frames,
  onBack,
}: {
  mission: Mission;
  frames: ReplayFrame[];
  onBack: () => void;
}) {
  // Playhead uses recording timeline. Frame time wins over twin clock.
  const history: Sample[] = frames.map((f) => ({ ...f.values, t: f.t }));
  const [frame, setFrame] = useState(0);
  const [playing, setPlaying] = useState(true);
  const [speed, setSpeed] = useState(1);
  const frameRef = useRef(0);
  const lastTickRef = useRef<number | null>(null);
  const playTRef = useRef(0); // playhead in recorded-time seconds
  const status = missionStatus(mission);

  // Replay advances by time. Playhead seeks the last frame at or prior to target time.
  useEffect(() => {
    if (!playing || !frames.length) { lastTickRef.current = null; return; }
    const endT = frames[frames.length - 1].t;
    playTRef.current = frames[frameRef.current]?.t ?? 0;
    const id = setInterval(() => {
      const now = performance.now();
      const dt = lastTickRef.current == null ? 0 : (now - lastTickRef.current) / 1000;
      lastTickRef.current = now;
      playTRef.current += dt * speed;
      if (playTRef.current >= endT) {
        playTRef.current = endT;
        setFrame(frames.length - 1);
        setPlaying(false);
        return;
      }
      // last index whose timestamp <= playhead (playhead only moves forward)
      let lo = frameRef.current, hi = frames.length - 1, idx = lo;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (frames[mid].t <= playTRef.current) { idx = mid; lo = mid + 1; } else hi = mid - 1;
      }
      if (idx !== frameRef.current) setFrame(idx);
    }, 100);
    return () => { clearInterval(id); lastTickRef.current = null; };
  }, [playing, speed, frames]);

  useEffect(() => {
    setFrame(0);
    setPlaying(true);
    playTRef.current = 0;
  }, [mission.id]);

  frameRef.current = frame;
  // Fixed 30s trailing window. Matches main-page window size.
  const WIN = 30;
  const curT = history.length ? history[Math.min(frame, history.length - 1)].t : 0;
  const shown = history.filter((h) => h.t > curT - WIN && h.t <= curT + 1e-6);
  const latest = shown[shown.length - 1];
  const curFaults = frames[frame]?.faults ?? [];
  const totalSec = history.length ? history[history.length - 1].t : 0;

  // Replay ML column from stored fault timeline. Onset is first frame per code.
  const onsetByCode = new Map<number, number>();
  for (const f of frames) for (const c of f.faults) if (!onsetByCode.has(c)) onsetByCode.set(c, f.t);
  const replayFaults: ActiveFault[] = curFaults
    .map((c) => {
      const def = FAULT_BY_ID[String(c)];
      if (!def) return null;
      const t0 = onsetByCode.get(c) ?? 0;
      const m = Math.floor(t0 / 60), s = Math.round(t0 % 60);
      return {
        def, seconds: 0, onset: `T+${m}:${String(s).padStart(2, "0")}`, trend: null,
      } as ActiveFault;
    })
    .filter((f): f is ActiveFault => !!f);

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2 p-2">
      {/* Replay header bar. */}
      <div
        className="flex shrink-0 items-center justify-between gap-3 px-3 py-1.5"
        style={{ border: "1px solid var(--color-line)", background: "var(--color-panel)" }}
      >
        <div className="flex items-center gap-3">
          <span
            className="h-[9px] w-[9px] rounded-full"
            style={{ background: missionStatusColor(status) }}
          />
          <span className="font-cond text-[14px] font-600 uppercase tracking-[0.04em] text-[var(--color-ink)]">
            Mission Replay · {mission.name || mission.id}
          </span>
          <span className="font-mono text-[12px] text-[var(--color-ink-2)]">
            {mission.name ?? ""} · {fmtDate(mission)} · {fmtDuration(mission)}
            {curFaults.length > 0 && (
              <span style={{ color: "var(--color-crit)" }}>
                {" "}· FAULT {curFaults.join("+")}
              </span>
            )}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => window.print()}
            className="px-3 py-1 font-cond text-[12px] font-500 uppercase tracking-[0.1em] transition-colors hover:brightness-95 print:hidden"
            style={{ border: "1px solid var(--color-line)", background: "var(--color-panel-2)", color: "var(--color-ink)" }}
          >
            ⎙ Report (PDF)
          </button>
          <button
            onClick={onBack}
            className="px-3 py-1 font-cond text-[12px] font-500 uppercase tracking-[0.1em] transition-colors hover:brightness-95 print:hidden"
            style={{ border: "1px solid var(--color-drab-2)", background: "var(--color-drab)", color: "var(--color-button-text)" }}
          >
            ◄ Back to Main
          </button>
        </div>
      </div>

      {/* Telemetry, graphs, and ML columns. */}
      <div className="grid min-h-0 flex-1 gap-2" style={{ gridTemplateColumns: "360px minmax(0,1fr) 360px" }}>
        <section
          className="flex min-h-0 flex-col bg-[var(--color-panel)]"
          style={{ border: "1px solid var(--color-line)" }}
        >
          <div
            className="flex items-center justify-between px-3 py-1.5"
            style={{ borderBottom: "1px solid var(--color-line-soft)" }}
          >
            <span className="font-cond text-[14px] font-600 uppercase tracking-[0.04em] text-[var(--color-ink-2)]">
              Telemetry · All Parameters
            </span>
            <span className="font-mono text-[12px] tabular-nums text-[var(--color-ink-2)]">{CHANNELS.length} PARAMS</span>
          </div>
          <div className="grid grid-cols-3 gap-1.5 overflow-auto p-2.5 content-start">
            {CHANNELS.map((c) => (
              <div
                key={c.key}
                className="flex flex-col px-2 py-1.5"
                style={{ border: "1px solid var(--color-line-soft)", background: "var(--color-panel-2)" }}
              >
                <span className="font-cond text-[12px] font-500 uppercase text-[var(--color-ink-2)]">
                  {c.label}
                </span>
                <div className="flex items-baseline gap-1">
                  <span className="font-mono text-[22px] font-600 tabular-nums leading-none text-[var(--color-ink)]">
                    {latest?.[c.key]?.toFixed(c.decimals ?? 1)}
                  </span>
                  <span className="font-mono text-[12px] font-400 text-[var(--color-ink-2)]">{c.unit}</span>
                </div>
              </div>
            ))}
          </div>
        </section>

        <div className="min-h-0">
          <GraphStack history={shown} winSec={WIN} />
        </div>

        {/* Replayed fault cards from stored timeline. */}
        <section
          className="flex min-h-0 flex-col bg-[var(--color-panel)]"
          style={{ border: "1px solid var(--color-line)", borderTop: "3px solid var(--color-line)" }}
        >
          <div
            className="flex items-center justify-between px-3 py-1.5"
            style={{ borderBottom: "1px solid var(--color-line-soft)" }}
          >
            <span className="font-cond text-[14px] font-600 uppercase tracking-[0.04em] text-[var(--color-ink)]">
              ML Diagnostics · Replay
            </span>
            <span className="font-mono text-[12px] tabular-nums text-[var(--color-ink-2)]">
              {replayFaults.length} ACTIVE
            </span>
          </div>
          <div className="scroll-y flex min-h-0 flex-1 flex-col gap-2 overflow-x-hidden p-2.5 pb-2 overscroll-contain">
            {replayFaults.length === 0 ? (
              <div
                className="flex flex-col items-center justify-center gap-1 py-8"
                style={{ border: "1px dashed var(--color-ok)", background: "var(--color-ok-tint)" }}
              >
                <span className="font-cond text-[22px] font-600 uppercase text-[var(--color-ok)]">No Faults</span>
                <span className="font-mono text-[12px] uppercase text-[var(--color-ink-2)]">Nominal at T+{curT.toFixed(0)}s</span>
              </div>
            ) : (
              replayFaults.map((f) => <FaultCard key={`r${f.def.id}`} f={f} />)
            )}
          </div>
          <footer
            className="flex shrink-0 items-center justify-between px-3 py-1.5 font-mono text-[12px] uppercase text-[var(--color-ink-2)]"
            style={{ borderTop: "1px solid var(--color-line-soft)", background: "var(--color-panel-2)" }}
          >
            <span>RUL / trend live-only</span>
            <span>{fmtDuration(mission)}</span>
          </footer>
        </section>
      </div>

      {/* Playback controls. */}
      <div
        className="flex shrink-0 items-center gap-3 px-3 py-2"
        style={{ border: "1px solid var(--color-line)", background: "var(--color-panel)" }}
      >
        <button
          onClick={() => {
            if (frame >= history.length - 1) setFrame(0);
            setPlaying((p) => !p);
          }}
          className="w-[86px] px-3 py-1 font-cond text-[12px] font-500 uppercase tracking-[0.1em] transition-colors hover:brightness-95"
          style={{ border: "1px solid var(--color-drab-2)", background: "var(--color-drab)", color: "var(--color-button-text)" }}
        >
          {playing ? "❚❚ Pause" : "▶ Play"}
        </button>

        <input
          type="range"
          min={0}
          max={Math.max(0, history.length - 1)}
          value={frame}
          onChange={(e) => {
            const i = parseInt(e.target.value, 10);
            setFrame(i);
            playTRef.current = frames[i]?.t ?? 0;
            setPlaying(false);
          }}
          className="flex-1 accent-[var(--color-drab)]"
        />

          <span className="w-[110px] shrink-0 text-right font-mono text-[12px] tabular-nums text-[var(--color-ink-2)]">
            T {curT.toFixed(1)}s / {totalSec.toFixed(1)}s
          </span>

        <div className="flex items-center gap-1">
          <span className="font-cond text-[12px] font-500 uppercase text-[var(--color-ink-2)]">Speed</span>
          {SPEEDS.map((s) => (
            <button
              key={s}
              onClick={() => setSpeed(s)}
              className="px-1.5 py-0.5 font-mono text-[12px] font-500 tabular-nums transition-colors"
              style={{
                border: `1px solid ${speed === s ? "var(--color-drab-2)" : "var(--color-line-soft)"}`,
                background: speed === s ? "var(--color-drab)" : "var(--color-panel-2)",
                color: speed === s ? "var(--color-button-text)" : "var(--color-ink)",
              }}
            >
              {s}×
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
