import { memo } from "react";
import { Area, AreaChart, ResponsiveContainer, YAxis } from "recharts";
import { type FaultDef, SEVERITY_COLOR, SEVERITY_RANK } from "../lib/faults";
import { TacticalButton } from "./ui";
import { useTwinStore, type HealthState, type Store } from "../lib/twin";

export interface ActiveFault {
  def: FaultDef;
  seconds: number;
  conf?: number | null;
  origin?: string | null;
  cyl?: number | null;
  trend?: Record<string, string> | null;
  onset?: string | null; // detected-at clock, stable once detected
  predicted?: boolean;   // prognosis lane - not in the engine yet
  ttfSec?: number | null; // projected time-to-threshold for predicted faults
}

function MLSectionImpl({
  faults,
  rul,
  healthStore,
  onOpenLogs,
  rulBurn,
  lifeDelta,
  onResetEngine,
}: {
  faults: ActiveFault[];
  rul: number | null;
  healthStore: Store<HealthState>;
  onOpenLogs: () => void;
  rulBurn: number;
  lifeDelta: number;
  onResetEngine: () => void;
}) {
  const { health, history: healthHistory } = useTwinStore(healthStore);
  const mostSevere = faults.reduce<FaultDef | null>((acc, f) => {
    if (!acc) return f.def;
    return SEVERITY_RANK[f.def.severity] > SEVERITY_RANK[acc.severity] ? f.def : acc;
  }, null);
  const accent = mostSevere ? SEVERITY_COLOR[mostSevere.severity] : "var(--color-ok)";
  const tint = faults.length === 0 ? "var(--color-ok-tint)" : hexTint(accent);

  return (
    <section
      className="flex h-full min-h-0 flex-col overflow-hidden shadow-[0_1px_2px_rgba(35,39,28,0.10)]"
      style={{ border: `1px solid ${accent}`, borderTop: `3px solid ${accent}`, background: tint }}
    >
      <header
        className="flex shrink-0 items-center justify-between gap-2 px-3 py-1.5"
        style={{ borderBottom: `1px solid ${accent}` }}
      >
        <div className="flex items-center gap-2">
          <span
            className={`h-[8px] w-[8px] rounded-full ${faults.length ? "animate-blip" : ""}`}
            style={{ background: accent }}
          />
          <h2 className="font-cond text-[14px] font-600 uppercase tracking-[0.04em] text-[var(--color-ink)]">
            ML Diagnostics · Prognostics
          </h2>
        </div>
        <TacticalButton onClick={onOpenLogs} className="!py-0.5">
          Fault Logs
        </TacticalButton>
      </header>

      <div className="scroll-y flex min-h-0 flex-1 flex-col gap-1.5 overflow-x-hidden p-2 pb-1.5 overscroll-contain">
        {faults.length === 0 ? (
          <div
            className="flex flex-col items-center justify-center gap-1 py-8"
            style={{ border: "1px dashed var(--color-ok)", background: "var(--color-ok-tint)" }}
          >
            <span className="font-cond text-[22px] font-600 uppercase text-[var(--color-ok)]">
              No Faults
            </span>
            <span className="font-mono text-[12px] uppercase text-[var(--color-ink-2)]">
              All systems nominal
            </span>
          </div>
        ) : (
          faults.map((f) => (
            <FaultCard key={`${f.predicted ? "p" : "c"}${f.def.id}-${f.predicted ? f.ttfSec : f.onset}`} f={f} />
          ))
        )}
      </div>

      {/* Pinned footer with RUL and health. */}
      <footer
        className="flex shrink-0 flex-col gap-2 px-2.5 pb-2.5 pt-2"
        style={{ borderTop: `1px solid ${accent}`, background: tint }}
      >
        <div
          className="flex items-center justify-between px-3 py-2"
          style={{ border: "1px solid var(--color-line)", background: "var(--color-panel)" }}
        >
          <span className="font-cond text-[12px] font-500 uppercase text-[var(--color-ink-2)]">
            Remaining Useful Life
          </span>
          <div className="flex items-baseline gap-1">
            <span
              className="font-mono text-[22px] font-600 tabular-nums leading-none"
              style={{ color: rul === null ? "var(--color-ink-2)" : rul < 10 ? "var(--color-crit)" : rul < 20 ? "var(--color-caution)" : "var(--color-ok)" }}
            >
              {rul === null ? "—" : rul.toLocaleString(undefined, { minimumFractionDigits: 1, maximumFractionDigits: 1 })}
            </span>
            <span className="font-mono text-[12px] font-400 text-[var(--color-ink-2)]">hrs</span>
          </div>
        </div>
        <div className="flex items-center justify-between gap-2 px-2.5 py-1 font-mono text-[11px] tabular-nums text-[var(--color-ink-2)]"
             style={{ border: "1px solid var(--color-line-soft)", background: "var(--color-panel-2)" }}>
          <span>BURN {rulBurn.toFixed(2)}x · THIS MISSION −{lifeDelta.toFixed(3)} h</span>
          <button
            onClick={onResetEngine}
            title="Factory-reset this engine's wear + RUL (replays kept)"
            className="shrink-0 px-1.5 py-0.5 font-mono text-[11px] transition-colors hover:brightness-125 active:translate-y-px"
            style={{ border: "1px solid var(--color-line-soft)", color: "var(--color-crit)" }}
          >
            ⟲ Reset engine (wear + RUL)
          </button>
        </div>

        {/* Health trend */}
        <div
          className="flex flex-col px-2.5 py-2"
          style={{ border: "1px solid var(--color-line)", background: "var(--color-panel)" }}
        >
          <div className="mb-1 flex items-center justify-between">
            <span className="font-cond text-[12px] font-500 uppercase text-[var(--color-ink-2)]">
              Overall Health Trend
            </span>
            <span
              className="font-mono text-[22px] font-600 tabular-nums leading-none"
              style={{ color: health < 40 ? "var(--color-crit)" : health < 70 ? "var(--color-caution)" : "var(--color-ok)" }}
            >
              {health}%
            </span>
          </div>
          <div className="h-[64px]">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={healthHistory} margin={{ top: 4, bottom: 0, left: 0, right: 0 }}>
                <defs>
                  <linearGradient id="hg" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor={accent} stopOpacity={0.35} />
                    <stop offset="100%" stopColor={accent} stopOpacity={0.02} />
                  </linearGradient>
                </defs>
                <YAxis domain={[0, 100]} hide />
                <Area
                  type="monotone"
                  dataKey="h"
                  stroke={accent}
                  strokeWidth={1.5}
                  fill="url(#hg)"
                  isAnimationActive={false}
                />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </div>
      </footer>
    </section>
  );
}

export const MLSection = memo(MLSectionImpl);

// Life-model burn multipliers for display. Faults multiply life burn while active.
const BURN_A: Record<number, number> = {
  1: 8, 2: 6, 3: 10, 4: 30, 5: 12, 6: 15, 7: 25,
  8: 25, 9: 40, 10: 2, 11: 6, 12: 15, 13: 2, 14: 8,
};

export function FaultCard({ f }: { f: ActiveFault }) {
  const { def } = f;
  const color = SEVERITY_COLOR[def.severity];
  const code = parseInt(def.id, 10);
  const num = Number.isFinite(code) ? `F-${code}` : def.id;
  const confPct = f.conf !== undefined && f.conf !== null ? Math.round(f.conf * 100) : def.confidence;
  const origin = f.origin ?? def.origin;
  const isPredicted = !!f.predicted;
  const ttf = f.ttfSec != null
    ? `${Math.floor(f.ttfSec / 60)}:${String(f.ttfSec % 60).padStart(2, "0")}`
    : null;
  // Cards clear when voting or projections stop. No manual dismiss.
  const burn = (BURN_A[code] ?? 2) * 0.9; // at standard injection magnitude
  return (
    <article
      className="flex flex-col gap-1 px-2 py-1.5"
      title={`${def.reason} | ${def.location} | Validate: ${def.validate}`}
      style={{
        border: `1.5px ${isPredicted ? "dashed" : "solid"} ${color}`,
        borderLeft: `4px solid ${color}`,
        background: "var(--color-panel)",
        opacity: isPredicted ? 0.9 : 1,
      }}
    >
      {/* Header with id, time, and status. */}
      <div className="flex items-start justify-between gap-2">
        <div className="flex min-w-0 items-baseline gap-1.5">
          <span className="font-mono text-[11px] uppercase text-[var(--color-ink-2)]">
            {num}
            {f.cyl ? ` · CYL${f.cyl}` : ""}
          </span>
          <span className="truncate font-cond text-[14px] font-600 leading-tight" style={{ color }}>
            {def.name}
          </span>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <Chip
            label={isPredicted ? `⧗ in ${ttf ?? "--:--"}` : `⧗ ${f.onset ?? "--:--:--"}`}
            tone="neutral"
            title={isPredicted ? "Projected time to fault threshold" : "First detected at (clock)"}
          />
          <span
            className="rounded px-1.5 py-px font-mono text-[11px] font-600 uppercase tracking-wide text-white"
            style={{ background: isPredicted ? "var(--color-caution)" : color }}
            title={isPredicted ? "Forecast - not in the engine yet" : "Active in the engine now"}
          >
            {isPredicted ? "PREDICTED" : "CURRENT"}
          </span>
        </div>
      </div>

      {/* Action line with inline meta. */}
      <div className="truncate font-sans text-[12px] leading-tight text-[var(--color-ink)]" title={def.action}>
        {def.action}
      </div>
      <div className="flex items-center justify-between font-mono text-[11px] tabular-nums text-[var(--color-ink-2)]">
        <span className="uppercase">{isPredicted ? "forecast" : origin}</span>
        <span>
          {isPredicted ? "impact starts at fire" : `burn ${burn.toFixed(1)}x`}
          {" · "}
          {confPct}%
        </span>
      </div>
    </article>
  );
}

function Chip({ label, tone, title }: { label: string; tone: "neutral" | "crit" | "caution"; title?: string }) {
  const map = {
    neutral: { c: "var(--color-ink-2)", b: "var(--color-line-soft)" },
    crit: { c: "var(--color-crit)", b: "var(--color-crit)" },
    caution: { c: "var(--color-caution)", b: "var(--color-caution)" },
  } as const;
  return (
    <span
      title={title}
      className="font-mono text-[12px] font-500 uppercase"
      style={{ color: map[tone].c, border: `1px solid ${map[tone].b}`, padding: "1px 5px" }}
    >
      {label}
    </span>
  );
}

function hexTint(accent: string) {
  if (accent === "var(--color-crit)") return "rgba(179,38,30,0.10)";
  if (accent === "var(--color-caution)") return "rgba(179,107,0,0.12)";
  return "var(--color-ok-tint)";
}
