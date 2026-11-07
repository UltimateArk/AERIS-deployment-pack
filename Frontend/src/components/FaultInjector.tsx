import { memo } from "react";
import { conflictsWith, FAULTS, MAX_ACTIVE } from "../lib/faults";
import { Panel, SeverityTag } from "./ui";

// Memoized injector. Re-renders only when the active set changes.
export const FaultInjector = memo(FaultInjectorImpl);

function FaultInjectorImpl({
  active,
  confirmed = [],
  onToggle,
  onRandom,
  onClear,
}: {
  active: string[];
  confirmed?: string[];
  onToggle: (id: string) => void;
  onRandom: () => void;
  onClear: () => void;
}) {
  const full = active.length >= MAX_ACTIVE;
  return (
    <Panel
      title="Fault Injection"
      right={
        <div className="flex items-center gap-1.5">
          <span className="font-mono text-[12px] text-[var(--color-ink-2)]">
            {active.length}/{MAX_ACTIVE} ACTIVE
          </span>
          <button
            onClick={onClear}
            disabled={active.length === 0}
            title={active.length ? "Remove all injected faults" : "No faults injected"}
            className={`rounded px-1.5 py-px font-mono text-[11px] uppercase transition-colors ${
              active.length ? "hover:brightness-125 active:translate-y-px" : "cursor-not-allowed opacity-40"
            }`}
            style={{ border: "1px solid var(--color-crit)", color: "var(--color-crit)" }}
          >
            Clear all
          </button>
        </div>
      }
      bodyClass="scroll-y overflow-x-hidden overscroll-contain p-2"
    >
      <div className="grid grid-cols-2 gap-1.5">
        {FAULTS.map((f) => {
          const isActive = active.includes(f.id);
          const conflict = conflictsWith(f.id, active);
          const blockedByCap = full && !isActive;
          const disabled = (!!conflict && !isActive) || blockedByCap;
          const title = conflict
            ? `Conflicts with active fault: ${conflict}`
            : blockedByCap
              ? `Max ${MAX_ACTIVE} active faults`
              : undefined;
          return (
            <button
              key={f.id}
              title={title}
              disabled={disabled}
              onClick={() => onToggle(f.id)}
              className={`group flex flex-col gap-0.5 px-2 py-1 text-left transition-colors ${
                disabled ? "cursor-not-allowed" : "hover:brightness-[0.97] active:translate-y-px"
              }`}
              style={{
                border: `1px solid ${isActive ? "var(--color-drab-2)" : "var(--color-line-soft)"}`,
                background: isActive ? "var(--color-drab)" : "var(--color-panel-2)",
                opacity: disabled ? 0.42 : 1,
              }}
            >
              <span
                className="font-cond text-[13px] font-500 leading-tight text-[var(--color-ink)]"
                style={isActive ? { color: "var(--color-button-text)" } : undefined}
              >
                {f.name}
              </span>
              {isActive ? (
                <span
                  className="font-mono text-[12px] uppercase"
                  style={{ color: confirmed.includes(f.id) ? "var(--color-ok)" : "var(--color-caution)" }}
                  title={confirmed.includes(f.id)
                    ? "Twin confirms this fault is active in the engine"
                    : "Sent - waiting for twin confirmation (link or engine down?)"}
                >
                  {confirmed.includes(f.id) ? "INJECTED ✓" : "SENT…"}
                </span>
              ) : (
                <SeverityTag severity={f.severity} />
              )}
            </button>
          );
        })}
      </div>
      <button
        onClick={onRandom}
        disabled={full}
        title={full ? `Max ${MAX_ACTIVE} active faults` : "Inject a random valid fault"}
        className={`mt-1.5 w-full px-2 py-1.5 font-cond text-[12px] font-500 uppercase tracking-[0.1em] transition-colors ${
          full ? "cursor-not-allowed opacity-40" : "hover:brightness-95 active:translate-y-px"
        }`}
        style={{
          border: "1px dashed var(--color-drab-2)",
          background: "var(--color-panel-2)",
          color: "var(--color-ink)",
        }}
      >
        ⟳ Random Fault
      </button>
    </Panel>
  );
}
