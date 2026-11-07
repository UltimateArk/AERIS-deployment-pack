import { memo, useEffect, useRef, useState } from "react";
import type { TwinFrame } from "../lib/twin";
import type { Controls } from "../lib/telemetry";
import { Panel, SliderControl, TacticalButton } from "./ui";
import { Engine3D } from "./engine3d/Engine3D";
import { DEFAULTS, type SharedAnim, type Telemetry3D } from "./engine3d/types";

// 3D reads twin frames on its own interval. Canvas subtree skips per-tick re-renders.
// Parked/end-of-mission frames are skipped so the model holds its last live
// state after stop instead of tracking the cooldown transient or flashing
// to defaults on the sparse end-of-mission marker.
function EngineVisual({ frameRef, engineOnRef, dark, shared }: {
  frameRef: React.RefObject<TwinFrame | null>;
  engineOnRef: React.RefObject<boolean>;
  dark: boolean;
  shared: React.RefObject<SharedAnim>;
}) {
  const snapRef = useRef<Telemetry3D>(DEFAULTS);
  useEffect(() => {
    const id = setInterval(() => {
      const s = frameRef.current;
      if (!s || typeof s !== "object" || Array.isArray(s)) return;
      if (s.parked === true || s.end_of_mission === true) return;
      if (typeof (s as { rpm?: unknown }).rpm !== "number") return;
      snapRef.current = { ...DEFAULTS, ...(s as Record<string, unknown>) } as Telemetry3D;
    }, 80);
    return () => clearInterval(id);
  }, [frameRef]);
  return <Engine3D snapRef={snapRef} engineOnRef={engineOnRef} dark={dark} shared={shared} />;
}

interface BarDef {
  key: keyof Controls;
  label: string;
  min: number;
  max: number;
  step: number;
  unit: string;
  decimals: number;
  accent: string;
}

const PRESETS: { name: string; set: Partial<Record<string, number>> }[] = [
  // Presets include realistic altitude for MALE UAV operation.
  { name: "Normal", set: { rpm: 5500, load: 60, afr: 14.7, cooling: 1, injTiming: 20, altitude: 3000, ambientT: 9, humidity: 30 } },
  { name: "High-Alt", set: { altitude: 8000, ambientT: 5, rpm: 5500, load: 65 } },
  { name: "Hot-Day", set: { ambientT: 45, altitude: 1000, load: 60, cooling: 0.8 } },
  { name: "Endurance", set: { rpm: 4800, load: 55, altitude: 3000, ambientT: 9 } },
  { name: "Slam", set: { rpm: 7000, load: 90, altitude: 1500, ambientT: 12 } },
];

const BARS: BarDef[] = [
  { key: "rpm", label: "RPM", min: 0, max: 10000, step: 50, unit: "rpm", decimals: 0, accent: "var(--color-accent-rpm)" },
  { key: "load", label: "Load", min: 0, max: 100, step: 1, unit: "%", decimals: 0, accent: "var(--color-accent-load)" },
  { key: "afr", label: "AFR Mixture", min: 12, max: 16, step: 0.1, unit: ":1", decimals: 1, accent: "var(--color-accent-fuel)" },
  { key: "cooling", label: "Cooling", min: 0, max: 1, step: 0.05, unit: "", decimals: 2, accent: "var(--color-accent-oil-temp)" },
  { key: "injTiming", label: "Injection Timing", min: 10, max: 30, step: 0.5, unit: "°", decimals: 1, accent: "var(--color-accent-map)" },
  { key: "altitude", label: "Altitude", min: 0, max: 15000, step: 100, unit: "ft", decimals: 0, accent: "var(--color-accent-oil-p)" },
  { key: "ambientT", label: "Ambient Temp", min: -20, max: 55, step: 1, unit: "°C", decimals: 0, accent: "var(--color-accent-cht)" },
  { key: "humidity", label: "Humidity", min: 0, max: 100, step: 5, unit: "%", decimals: 0, accent: "var(--color-accent-egt)" },
];

// Memoized panel. Updates on prop change, not on every tick.
export const EnginePanel = memo(EnginePanelImpl);

function EnginePanelImpl({
  phase,
  controls,
  onControl,
  onStart,
  onEndMission,
  frameRef,
  engineOnRef,
  dark,
  missionName,
  awaitingMission,
}: {
  phase: "idle" | "running";
  controls: Controls;
  onControl: (k: keyof Controls, v: number) => void;
  onStart: () => void;
  onEndMission: () => void;
  frameRef: React.RefObject<TwinFrame | null>;
  engineOnRef: React.RefObject<boolean>;
  dark: boolean;
  missionName: string;
  awaitingMission: boolean;
}) {
  const running = phase === "running";
  // Shared with the 3D canvas for orbit reset without re-renders.
  const sharedRef = useRef<SharedAnim>({ dispRpm: 0 });
  // Expanded preview reuses the same wrapper and canvas. Backdrop, button, or Esc collapses it.
  const [expanded, setExpanded] = useState(false);
  const [closing, setClosing] = useState(false);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const expand = () => {
    if (closeTimer.current) { clearTimeout(closeTimer.current); closeTimer.current = null; }
    setClosing(false);
    sharedRef.current.resetView = true;
    setExpanded(true);
  };
  const collapse = () => {
    setClosing(true);
    if (closeTimer.current) clearTimeout(closeTimer.current);
    closeTimer.current = setTimeout(() => {
      setExpanded(false);
      setClosing(false);
      closeTimer.current = null;
    }, 240);
  };
  useEffect(() => () => { if (closeTimer.current) clearTimeout(closeTimer.current); }, []);
  useEffect(() => {
    if (!expanded || closing) return;
    const h = (e: KeyboardEvent) => { if (e.key === "Escape") collapse(); };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [expanded, closing]);
  return (
    <Panel
      title="Digital Twin — Engine"
      right={
        <div className="flex items-center gap-1">
          <button
            onClick={expand}
            title="Expand 3D preview"
            className="rounded px-1.5 py-px font-mono text-[11px] uppercase transition-colors hover:brightness-125 active:translate-y-px"
            style={{ border: "1px solid var(--color-line-soft)", color: "var(--color-ink-2)" }}
          >
            ⤢ Expand
          </button>
          <button
            onClick={() => { sharedRef.current.resetView = true; }}
            title="Reset camera (drag to orbit, wheel to zoom, right-drag to pan)"
            className="rounded px-1.5 py-px font-mono text-[11px] uppercase transition-colors hover:brightness-125 active:translate-y-px"
            style={{ border: "1px solid var(--color-line-soft)", color: "var(--color-ink-2)" }}
          >
            ⟲ View
          </button>
        </div>
      }
      bodyClass="flex flex-col overflow-hidden p-2 gap-2 min-h-0"
    >
      {expanded && (
        <div
          className="fixed inset-0 z-40"
          onClick={collapse}
          style={{
            background: "rgba(20,22,18,0.45)", backdropFilter: "blur(6px)",
            animation: closing ? "aeris-fade-out 0.24s ease both" : "aeris-fade-in 0.28s ease both",
          }}
        />
      )}
      <div
        className={expanded ? "fixed z-50 overflow-hidden" : "relative h-[230px] shrink-0 overflow-hidden"}
        style={
          expanded
            ? {
                top: 12, left: 12, width: "min(860px, 68vw)", height: "min(600px, 68vh)",
                border: "1px solid var(--color-line)", background: "var(--color-inset)",
                boxShadow: "0 8px 40px rgba(0,0,0,0.35)",
                animation: closing ? "aeris-pop-out 0.24s ease both" : "aeris-pop-in 0.3s ease both",
              }
            : {
                border: "1px solid var(--color-line-soft)",
                background:
                  "repeating-linear-gradient(0deg,rgba(154,166,178,0.14),rgba(154,166,178,0.14) 1px,transparent 1px,transparent 22px),repeating-linear-gradient(90deg,rgba(154,166,178,0.14),rgba(154,166,178,0.14) 1px,transparent 1px,transparent 22px),var(--color-inset)",
              }
        }
      >
        <span className="absolute left-2 top-1.5 z-10 font-mono text-[12px] uppercase text-[var(--color-ink-2)]">
          ROTAX 915-CLASS · MALE UAV
        </span>
        {expanded && (
          <button
            onClick={collapse}
            title="Close preview (Esc)"
            className="absolute right-2 top-1.5 z-10 rounded px-1.5 py-px font-mono text-[12px] transition-colors hover:brightness-125 active:translate-y-px"
            style={{ border: "1px solid var(--color-line)", background: "var(--color-panel-2)", color: "var(--color-ink)" }}
          >
            ✕
          </button>
        )}
        <EngineVisual frameRef={frameRef} engineOnRef={engineOnRef} dark={dark} shared={sharedRef} />
        <div className="absolute bottom-1.5 right-2 flex items-center gap-1.5">
          <span
            className="h-[7px] w-[7px] rounded-full"
            style={{ background: running ? "var(--color-ok)" : "var(--color-ink-2)" }}
          />
          <span className="font-mono text-[12px] uppercase text-[var(--color-ink-2)]">
            {running ? "OPERATING" : "STANDBY"}
          </span>
        </div>
      </div>

      <div className="flex shrink-0 gap-1.5">
        {phase === "idle" && (
          <TacticalButton
            onClick={onStart}
            tone="drab"
            className="flex-1 !py-1.5 !text-[13px]"
          >
            {awaitingMission ? "▷ Start new mission" : "▶ Start Engine"}
          </TacticalButton>
        )}
        {phase === "running" && (
          <TacticalButton disabled className="flex-1 !py-1.5 !text-[13px]">
            ● Engine Running
          </TacticalButton>
        )}
        <button
          onClick={onEndMission}
          disabled={phase !== "running"}
          title={phase === "running" ? `End mission "${missionName}" and store it` : "Only an active mission can be ended"}
          className={`shrink-0 px-2 py-1.5 font-cond text-[12px] font-600 uppercase tracking-[0.08em] transition-colors ${
            phase === "running" ? "hover:brightness-110 active:translate-y-px" : "cursor-not-allowed opacity-40"
          }`}
          style={{ border: "1px solid var(--color-crit)", background: "var(--color-crit)", color: "#fff" }}
        >
          ⏹ End Mission
        </button>
      </div>

      <div className="flex shrink-0 flex-wrap gap-1.5">
        {PRESETS.map((p) => (
          <button
            key={p.name}
            onClick={() => {
              for (const [k, v] of Object.entries(p.set)) {
                if (v !== undefined) onControl(k as keyof Controls, v);
              }
            }}
            className="rounded px-2 py-0.5 font-cond text-[11px] font-500 uppercase tracking-[0.08em] transition-colors hover:brightness-95 active:translate-y-px"
            style={{ border: "1px solid var(--color-line-soft)", background: "var(--color-panel-2)", color: "var(--color-ink)" }}
          >
            {p.name}
          </button>
        ))}
      </div>

      <div className="scroll-y flex min-h-0 flex-1 flex-col gap-1.5 overflow-x-hidden pr-1 overscroll-contain">
        {BARS.map((b) => (
          <SliderControl
            key={b.key}
            label={b.label}
            value={controls[b.key]}
            min={b.min}
            max={b.max}
            step={b.step}
            unit={b.unit}
            decimals={b.decimals}
            accent={b.accent}
            onChange={(v) => onControl(b.key, v)}
          />
        ))}
      </div>
    </Panel>
  );
}

