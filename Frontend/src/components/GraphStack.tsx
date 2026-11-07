import { memo, useEffect, useRef } from "react";
import type { Sample } from "../lib/telemetry";
import { Panel } from "./ui";
import { useTwinStore, type DisplayState, type Store } from "../lib/twin";

const SERIES = {
  a: "var(--color-accent-map)",
  b: "var(--color-accent-cht)",
  c: "var(--color-accent-fuel)",
  d: "var(--color-accent-egt)",
  e: "var(--color-accent-oil-p)",
} as const;

interface GraphDef {
  title: string;
  lines: { key: string; label: string; color: string; dom?: [number, number] }[];
  // Shared Y-axis for same-unit groups.
  sharedAxis?: boolean;
  // Shared domain for the shared axis.
  sharedDom?: [number, number];
  // Shared axis for listed keys. Other lines keep separate axes.
  sharedKeys?: string[];
  // Domain for the shared keys axis.
  sharedKeysDom?: [number, number];
  // Vertical share of the stack. Default 1.
  flex?: number;
}

// Fixed physical Y domains per channel. New data passes at constant scale.
const GRAPHS: GraphDef[] = [
  {
    title: "CHT + EGT AVG",
    lines: [
      { key: "cht", label: "CHT", color: SERIES.a, dom: [0, 700] },
      { key: "egt", label: "EGT avg", color: SERIES.b, dom: [0, 900] },
    ],
  },
  {
    title: "EGT 1–4 + SPREAD",
    flex: 1.75,
    sharedKeys: ["egt1", "egt2", "egt3", "egt4"],
    sharedKeysDom: [0, 900],
    lines: [
      { key: "egt1", label: "E1", color: SERIES.a },
      { key: "egt2", label: "E2", color: SERIES.c },
      { key: "egt3", label: "E3", color: SERIES.b },
      { key: "egt4", label: "E4", color: SERIES.e },
      { key: "egtSpread", label: "spread", color: SERIES.d, dom: [0, 150] },
    ],
  },
  {
    title: "OIL PRESS + TEMP",
    lines: [
      { key: "oilPressure", label: "press", color: "var(--color-accent-oil-press)", dom: [0, 5] },
      { key: "oilTemp", label: "temp", color: "var(--color-accent-oil-temp)", dom: [0, 130] },
    ],
  },
  {
    title: "MAP + FUEL FLOW",
    flex: 0.85,
    lines: [
      { key: "map", label: "MAP", color: SERIES.a, dom: [0.8, 2.5] },
      { key: "fuelFlow", label: "flow", color: SERIES.c, dom: [0, 5] },
    ],
  },
  {
    title: "RPM + POWER kW",
    flex: 0.85,
    lines: [
      { key: "rpm", label: "RPM", color: SERIES.a, dom: [0, 10000] },
      { key: "powerKw", label: "kW", color: SERIES.b, dom: [0, 120] },
    ],
  },
  {
    title: "VIB X/Y/Z + RMS",
    sharedAxis: true,
    sharedDom: [0, 0.5],
    flex: 1.2,
    lines: [
      { key: "vibX", label: "X", color: SERIES.a },
      { key: "vibY", label: "Y", color: SERIES.c },
      { key: "vibZ", label: "Z", color: SERIES.b },
      { key: "vibRMS", label: "RMS", color: SERIES.d },
    ],
  },
  {
    title: "BATT V + ALT A",
    flex: 0.75,
    lines: [
      { key: "battV", label: "V", color: SERIES.a, dom: [20, 29] },
      { key: "altA", label: "A", color: SERIES.b, dom: [0, 25] },
    ],
  },
  {
    title: "INJ TIMING",
    flex: 0.7,
    lines: [
      { key: "injTiming", label: "timing", color: SERIES.a, dom: [0, 30] },
    ],
  },
];

const ALL_KEYS = [...new Set(GRAPHS.flatMap((g) => g.lines.map((l) => l.key)))];

function zerosAt(t: number): Sample {
  const r = { t } as unknown as Sample;
  for (const k of ALL_KEYS) (r as unknown as Record<string, number>)[k] = 0;
  return r;
}

function GraphStackImpl({ history, winSec = 30 }: { history: Sample[]; winSec?: number }) {
  const latest = history[history.length - 1];
  // Fixed time domain pinned to real time. Fresh points preserve existing spacing.
  const curT = latest ? Number((latest as { t?: number }).t ?? 0) : winSec;
  const winStart = curT - winSec;
  const xDom: [number, number] = [winStart, curT];
  // Charts show the visible window only. Zero lead-in restores baseline at mission start.
  const visible = history.filter((h) => Number((h as { t?: number }).t ?? 0) >= winStart);
  const firstT = visible.length ? Number((visible[0] as { t?: number }).t ?? 0) : 0;
  let data: Sample[];
  if (!visible.length) {
    data = [zerosAt(winStart), zerosAt(curT)];
  } else if (firstT > winStart + 2) {
    data = [zerosAt(winStart), zerosAt(firstT - 0.01), ...visible];
  } else {
    data = visible;
  }
  return (
    <Panel
      title="Live Telemetry Graphs"
      right={<span className="font-mono text-[12px] text-[var(--color-ink-2)]">8 CH · LIVE 10Hz</span>}
      bodyClass="flex min-h-0 flex-col overflow-hidden"
    >
      <div className="flex min-h-0 flex-1 flex-col divide-y divide-[var(--color-line-soft)]">
        {GRAPHS.map((g) => (
          <div
            key={g.title}
            className="flex min-h-0 items-stretch gap-1.5 overflow-hidden px-1.5 py-0.5"
            style={{ flex: `${g.flex ?? 1} 1 0%` }}
          >
            <div className="flex w-[96px] shrink-0 flex-col justify-center overflow-hidden">
              <span className="font-cond text-[12px] font-500 uppercase leading-tight text-[var(--color-ink)]">
                {g.title}
              </span>
              <div className="mt-0.5 flex flex-wrap gap-x-2 gap-y-0.5">
                {g.lines.map((l) => (
                  <span key={l.key} className="flex items-center gap-1 leading-none">
                    <span className="h-[2px] w-2.5 shrink-0" style={{ background: l.color }} />
                    <span className="font-mono text-[12px] font-500 tabular-nums leading-none text-[var(--color-ink-2)]">
                      {l.label}
                      {latest ? ` ${fmt(latest[l.key])}` : ""}
                    </span>
                  </span>
                ))}
              </div>
            </div>
            <div className="flex min-h-0 flex-1">
              <CanvasChart g={g} data={data} xDom={xDom} />
            </div>
          </div>
        ))}
      </div>
    </Panel>
  );
}

function fmt(v: number | undefined) {
  if (v === undefined) return "–";
  return Math.abs(v) >= 100 ? v.toFixed(0) : v.toFixed(1);
}

// Draw-cost probe. Tracks chart cost as the window fills.
const drawStat = { n: 0, sum: 0, max: 0 };
function probeDraw(ms: number, points: number) {
  drawStat.n++; drawStat.sum += ms; drawStat.max = Math.max(drawStat.max, ms);
  if (drawStat.n >= 100) {
    const avg = drawStat.sum / drawStat.n;
    (window as unknown as { __aeris_perf?: object }).__aeris_perf = {
      ...((window as unknown as { __aeris_perf?: object }).__aeris_perf ?? {}),
      graphsDraw: { avgMs: +avg.toFixed(2), maxMs: +drawStat.max.toFixed(2), points },
    };
    if (avg > 8)
      console.info(`[perf:graphs] draw avg ${avg.toFixed(1)}ms max ${drawStat.max.toFixed(0)}ms over ${drawStat.n} draws (${points} pts) - chart-bound`);
    drawStat.n = 0; drawStat.sum = 0; drawStat.max = 0;
  }
}
// CSS var colors cached per theme. Avoids style flush per frame.
const colorCache = new Map<string, string>();
let colorTheme = "";
function cssColor(v: string): string {
  if (!v.startsWith("var(")) return v;
  const theme = document.documentElement.getAttribute("data-theme") ?? "";
  if (theme !== colorTheme) { colorTheme = theme; colorCache.clear(); }
  const hit = colorCache.get(v);
  if (hit) return hit;
  const name = v.slice(4, -1).trim();
  const rgb = getComputedStyle(document.documentElement).getPropertyValue(name).trim() || "#888888";
  colorCache.set(v, rgb);
  return rgb;
}

// Canvas time chart. Draws imperatively without per-point reconciliation.
const CanvasChart = memo(function CanvasChart({
  g, data, xDom,
}: {
  g: GraphDef; data: Sample[]; xDom: [number, number];
}) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const wrap = wrapRef.current;
    const canvas = canvasRef.current;
    if (!wrap || !canvas) return;
    const draw = () => {
      const t0 = performance.now();
      const w = wrap.clientWidth;
      const h = wrap.clientHeight;
      if (w <= 0 || h <= 0) return;
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const bw = Math.round(w * dpr);
      const bh = Math.round(h * dpr);
      if (canvas.width !== bw || canvas.height !== bh) {
        canvas.width = bw;
        canvas.height = bh;
      }
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);
      const [x0, x1] = xDom;
      const span = Math.max(1e-6, x1 - x0);
      const X = (t: number) => ((t - x0) / span) * w;
      const domFor = (key: string): [number, number] => {
        if (g.sharedAxis && g.sharedDom) return g.sharedDom;
        if ((g.sharedKeys ?? []).includes(key) && g.sharedKeysDom) return g.sharedKeysDom;
        const own = g.lines.find((l) => l.key === key)?.dom;
        if (own) return own;
        let mn = Infinity, mx = -Infinity;
        for (const p of data) {
          const v = (p as unknown as Record<string, number>)[key];
          if (typeof v === "number") { if (v < mn) mn = v; if (v > mx) mx = v; }
        }
        if (!isFinite(mn)) { mn = 0; mx = 1; }
        if (mx - mn < 1e-9) { mn -= 1; mx += 1; }
        return [mn, mx];
      };
      ctx.lineWidth = 1.3;
      ctx.lineJoin = "round";
      ctx.lineCap = "round";
      for (const l of g.lines) {
        const [y0, y1] = domFor(l.key);
        const yr = Math.max(1e-9, y1 - y0);
        const Y = (v: number) => h - 3 - ((v - y0) / yr) * (h - 6);
        ctx.strokeStyle = cssColor(l.color);
        ctx.beginPath();
        let started = false;
        for (const p of data) {
          const rec = p as unknown as Record<string, number>;
          const t = Number(rec.t ?? 0);
          const v = rec[l.key];
          if (typeof v !== "number" || t < x0) continue;
          const x = X(t);
          if (x > w + 1) continue;
          if (!started) { ctx.moveTo(x, Y(v)); started = true; }
          else ctx.lineTo(x, Y(v));
        }
        ctx.stroke();
      }
      probeDraw(performance.now() - t0, data.length);
    };
    draw();
    const ro = new ResizeObserver(draw);
    ro.observe(wrap);
    return () => ro.disconnect();
  });

  return (
    <div ref={wrapRef} className="relative min-h-0 w-full flex-1">
      <canvas ref={canvasRef} style={{ position: "absolute", inset: 0, width: "100%", height: "100%", display: "block" }} />
    </div>
  );
});

// Static variant. Replay uses it with fixed frame history.
export const GraphStack = memo(GraphStackImpl);

// Live variant. Subscribes to the display store so only charts re-render.
export const LiveGraphStack = memo(function LiveGraphStack({
  store,
}: {
  store: Store<DisplayState>;
}) {
  const d = useTwinStore(store);
  return <GraphStackImpl history={d.history as unknown as Sample[]} />;
});
