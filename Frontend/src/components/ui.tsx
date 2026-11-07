import { useEffect, useRef, useState, type ReactNode } from "react";

export function Panel({
  title,
  right,
  children,
  className = "",
  accent,
  bodyClass = "",
}: {
  title?: string;
  right?: ReactNode;
  children: ReactNode;
  className?: string;
  accent?: string;
  bodyClass?: string;
}) {
  return (
    <section
      className={`flex h-full min-h-0 flex-col overflow-hidden bg-[var(--color-panel)] shadow-[0_1px_2px_rgba(35,39,28,0.10)] ${className}`}
      style={{
        border: "1px solid var(--color-line)",
        borderTop: accent ? `2px solid ${accent}` : "1px solid var(--color-line)",
      }}
    >
      {title !== undefined && (
        <header
          className="flex shrink-0 items-center justify-between gap-2 px-2.5 py-0.5"
          style={{ borderBottom: "1px solid var(--color-line-soft)" }}
        >
          <h2 className="font-cond text-[14px] font-600 uppercase tracking-[0.04em] text-[var(--color-ink-2)]">
            {title}
          </h2>
          {right}
        </header>
      )}
      <div className={`min-h-0 flex-1 ${bodyClass}`}>{children}</div>
    </section>
  );
}

export function TacticalButton({
  children,
  onClick,
  active = false,
  disabled = false,
  title,
  className = "",
  tone = "default",
}: {
  children: ReactNode;
  onClick?: () => void;
  active?: boolean;
  disabled?: boolean;
  title?: string;
  className?: string;
  tone?: "default" | "drab" | "danger";
}) {
  const base =
    "font-cond uppercase tracking-[0.08em] text-[12px] font-500 px-2.5 py-1 transition-colors select-none";
  let style: React.CSSProperties = {
    border: "1px solid var(--color-line)",
    color: "var(--color-ink)",
    background: "var(--color-panel-2)",
  };
  if (tone === "drab") style = { border: "1px solid var(--color-drab-2)", color: "var(--color-button-text)", background: "var(--color-button)" };
  if (active) style = { border: "1px solid var(--color-drab-2)", color: "var(--color-button-text)", background: "var(--color-button)" };
  if (disabled) style = { ...style, opacity: 0.4, cursor: "not-allowed" };
  return (
    <button
      title={title}
      disabled={disabled}
      onClick={onClick}
      className={`${base} ${disabled ? "" : "hover:brightness-[0.96] active:translate-y-px"} ${className}`}
      style={style}
    >
      {children}
    </button>
  );
}

export function Toggle({
  label,
  on,
  onClick,
}: {
  label: string;
  on: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className="flex items-center justify-between gap-2 px-2 py-1 transition-colors hover:bg-[var(--color-panel-2)]"
      style={{ border: "1px solid var(--color-line-soft)" }}
    >
      <span className="font-cond text-[12px] font-500 uppercase text-[var(--color-ink)]">
        {label}
      </span>
      <span
        className="relative h-[14px] w-[26px] shrink-0 transition-colors"
        style={{
          background: on ? "var(--color-ok)" : "var(--color-line-soft)",
          border: "1px solid var(--color-line)",
        }}
      >
        <span
          className="absolute top-[1px] h-[10px] w-[10px] bg-[var(--color-panel)] transition-all"
          style={{ left: on ? "13px" : "1px" }}
        />
      </span>
    </button>
  );
}

export function SliderControl({
  label,
  value,
  min,
  max,
  step = 1,
  unit,
  accent = "var(--color-button)",
  decimals = 0,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  unit: string;
  accent?: string;
  decimals?: number;
  onChange: (v: number) => void;
}) {
  // Local value for drag input. Parent updates on throttle and release.
  const [local, setLocal] = useState(value);
  const dragging = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pending = useRef(value);
  useEffect(() => {
    if (!dragging.current) setLocal(value);
  }, [value]);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  const push = (v: number) => {
    pending.current = v;
    if (timer.current) return;
    timer.current = setTimeout(() => {
      timer.current = null;
      onChange(pending.current);
    }, 90);
  };
  const flush = () => {
    if (timer.current) { clearTimeout(timer.current); timer.current = null; }
    onChange(pending.current);
  };
  return (
    <div
      className="flex flex-col gap-1 px-2 py-1.5"
      style={{ border: "1px solid var(--color-line-soft)", background: "var(--color-inset)" }}
    >
      <div className="flex items-baseline justify-between">
        <span className="font-cond text-[12px] font-500 uppercase text-[var(--color-ink)]">
          {label}
        </span>
        <span className="font-mono text-[22px] font-600 tabular-nums text-right" style={{ color: accent }}>
          {local.toFixed(decimals)}
          <span className="ml-0.5 text-[12px] font-400 text-[var(--color-ink-2)]">{unit}</span>
        </span>
      </div>
      <input
        type="range"
        className="bar"
        min={min}
        max={max}
        step={step}
        value={local}
        onPointerDown={() => { dragging.current = true; }}
        onChange={(e) => {
          const v = parseFloat(e.target.value);
          setLocal(v);
          push(v);
        }}
        onPointerUp={() => { dragging.current = false; flush(); }}
        onKeyUp={flush}
        onBlur={() => { dragging.current = false; flush(); }}
      />
    </div>
  );
}

export function SeverityTag({ severity }: { severity: string }) {
  const short =
    severity === "Critical" ? "CRIT" : severity === "High" ? "HIGH" : severity === "Low" ? "LOW" : "MED";
  const color =
    severity === "Critical" || severity === "High"
      ? "var(--color-crit)"
      : severity === "Med-High" || severity === "Med"
        ? "var(--color-caution)"
        : "var(--color-ok)";
  return (
    <span
      className="font-mono text-[12px] font-500 uppercase leading-none rounded-full px-1.5 py-px"
      style={{ color, border: `1px solid ${color}` }}
    >
      {short}
    </span>
  );
}
