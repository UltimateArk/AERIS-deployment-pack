import type { ReactNode } from "react";

export function SlidePanel({
  open,
  title,
  onClose,
  children,
  footer,
  width = 340,
}: {
  open: boolean;
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  width?: number;
}) {
  return (
    <>
      <div
        onClick={onClose}
        className={`fixed inset-0 z-40 bg-[rgba(35,39,28,0.35)] transition-opacity duration-200 ${
          open ? "opacity-100" : "pointer-events-none opacity-0"
        }`}
      />
      <aside
        className="fixed right-0 top-0 z-50 flex h-full flex-col bg-[var(--color-panel)] shadow-[-4px_0_16px_rgba(35,39,28,0.18)] transition-transform duration-250 ease-out"
        style={{
          width,
          borderLeft: "2px solid var(--color-drab-2)",
          transform: open ? "translateX(0)" : "translateX(100%)",
        }}
      >
        <header
          className="flex shrink-0 items-center justify-between px-3 py-2"
          style={{ background: "var(--color-drab)", color: "var(--color-button-text)" }}
        >
          <h2 className="font-cond text-[14px] font-600 uppercase tracking-[0.04em]">{title}</h2>
          <button
            onClick={onClose}
            className="font-cond text-[12px] font-500 uppercase hover:text-white"
          >
            ✕
          </button>
        </header>
        <div className="min-h-0 flex-1 overflow-auto p-2.5">{children}</div>
        {footer && (
          <div className="shrink-0 p-2.5" style={{ borderTop: "1px solid var(--color-line)" }}>
            {footer}
          </div>
        )}
      </aside>
    </>
  );
}
