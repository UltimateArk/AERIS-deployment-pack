import { memo } from "react";
import { CHANNELS, type Sample } from "../lib/telemetry";
import { Panel } from "./ui";
import { useTwinStore, type DisplayState, type Store } from "../lib/twin";

function statusColor(key: string, v: number): string {
  const c = CHANNELS.find((x) => x.key === key);
  if (!c || c.warn === undefined) return "var(--color-ink)";
  const inverted = key === "oilPress" || key === "battV"; // lower is worse
  if (inverted) {
    if (c.crit !== undefined && v <= c.crit) return "var(--color-crit)";
    if (v <= c.warn) return "var(--color-caution)";
  } else {
    if (c.crit !== undefined && v >= c.crit) return "var(--color-crit)";
    if (v >= c.warn) return "var(--color-caution)";
  }
  return "var(--color-ok)";
}

export const TelemetryGrid = memo(function TelemetryGrid({ latest }: { latest: Sample | undefined }) {
  return (
    <Panel
      title="Telemetry"
      right={<span className="font-mono text-[12px] text-[var(--color-ink-2)]">{CHANNELS.length} PARAMS</span>}
      bodyClass="overflow-hidden p-1.5"
    >
      <div className="grid h-full grid-cols-5 grid-rows-4 gap-0.5">
        {CHANNELS.map((c) => {
          const v = latest?.[c.key];
          const color = v !== undefined ? statusColor(c.key, v) : "var(--color-ink-2)";
          return (
            <div
              key={c.key}
              className="flex h-full min-h-0 items-center justify-between gap-1 px-1.5 py-0.5"
              title={c.label}
              style={{ border: "1px solid var(--color-line-soft)", background: "var(--color-panel-2)" }}
            >
              <span className="truncate font-cond text-[11px] font-600 uppercase leading-none text-[var(--color-ink)]">
                {c.label}
              </span>
              <span className="font-mono text-[22px] font-600 tabular-nums leading-none" style={{ color }}>
                {v !== undefined ? v.toFixed(c.decimals ?? 1) : "––"}
                <span className="ml-0.5 font-mono text-[11px] font-400 text-[var(--color-ink-2)]">{c.unit}</span>
              </span>
            </div>
          );
        })}
      </div>
    </Panel>
  );
});

// Live variant. Subscribes to the display store so only tiles re-render.
export const LiveTelemetryGrid = memo(function LiveTelemetryGrid({
  store,
}: {
  store: Store<DisplayState>;
}) {
  const d = useTwinStore(store);
  return <TelemetryGrid latest={d.latest as unknown as Sample | undefined} />;
});
