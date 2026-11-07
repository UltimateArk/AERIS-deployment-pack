import { useEffect, useRef, useState } from "react";
import { rest } from "../lib/backend";
import { twinRest } from "../lib/twin";
import { login as doLogin, getToken, clearToken, API_BASE, authHeaders } from "../lib/auth";

interface EngineRow { id: string; hours: number; rul: number }
interface SessionRow {
  id: string; name: string; engine_id: string; pilot: string;
  started_at: number; ended_at: number | null; status: string; mission_id: string;
}

// Ground-station gate. Title sits above the cards. Login card left and fleet board right.
export function LoginPage({
  onEnter,
  dark,
  onToggleDark,
}: {
  onEnter: (session: { sessionId: string; name: string; engineId: string; missionId: string }) => void;
  dark: boolean;
  onToggleDark: () => void;
}) {
  const [step, setStep] = useState<"creds" | "mission">(getToken() ? "mission" : "creds");
  const [username, setUsername] = useState("pilot");
  const [password, setPassword] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  const [engines, setEngines] = useState<EngineRow[]>([]);
  const [missionsByEngine, setMissionsByEngine] = useState<Record<string, SessionRow[]>>({});
  const [engineNum, setEngineNum] = useState("01"); // digits only
  const [mission, setMission] = useState("");
  const [openSession, setOpenSession] = useState<{ name: string; engineId: string; owned: boolean } | null>(null);
  const missionRef = useRef<HTMLInputElement>(null);
  const engineRef = useRef<HTMLInputElement>(null);

  // Engine id derives from engine number. Input stays digits-only with ENG-XX convention.
  const engineId = engineNum ? `ENG-${engineNum.padStart(2, "0")}` : "";

  async function loadFleet() {
    try {
      const [list, sessions] = await Promise.all([
        rest.engines() as Promise<EngineRow[]>,
        rest.sessions() as Promise<SessionRow[]>,
      ]);
      setEngines(Array.isArray(list) ? list : []);
      const grouped: Record<string, SessionRow[]> = {};
      for (const s of Array.isArray(sessions) ? sessions : [])
        (grouped[s.engine_id] = grouped[s.engine_id] ?? []).push(s);
      setMissionsByEngine(grouped);
    } catch { return; }
  }

  useEffect(() => {
    if (step !== "mission") return;
    loadFleet();
    const check = () => rest.sessionCurrent()
      .then((r) => {
        const s = (r as { session?: { name: string; engineId: string } }).session;
        const owned = (r as { owned?: boolean }).owned !== false;
        setOpenSession(s ? { name: s.name, engineId: s.engineId, owned } : null);
      })
      .catch(() => {});
    check();
    // Re-check ownership while a foreign mission runs so the
    // form unlocks itself the moment the mission ends.
    const id = setInterval(check, 5000);
    return () => clearInterval(id);
  }, [step]);

  function pickEngine(id: string) {
    const digits = (id.match(/\d+/)?.[0] ?? "").replace(/^0+(?=\d)/, "");
    setEngineNum(digits || engineNum);
    // Focus moves to mission name for continued typing.
    requestAnimationFrame(() => missionRef.current?.focus());
  }

  async function signIn(e: React.FormEvent) {
    e.preventDefault();
    setErr(""); setBusy(true);
    try {
      const ok = await doLogin(username.trim(), password);
      if (!ok) { setErr("Invalid credentials."); }
      else setStep("mission");
    } catch {
      // Unreachable backend shows an error. Button resets after failure.
      setErr("Cannot reach the server - check network / firewall, then retry.");
    }
    setBusy(false);
  }

  async function enter(resume = false) {
    setErr(""); setBusy(true);
    try {
      if (!resume) {
        const eid = engineId || "ENG-01";
        // Point twin at this engine, then open. Wear and health belong to this airframe.
        try { await twinRest.switchEngine(eid); } catch { }
        try { await rest.switchEngine(eid); } catch { }
        const r = await fetch(`${API_BASE}/api/session/start`, {
          method: "POST",
          headers: { "Content-Type": "application/json", ...authHeaders() },
          body: JSON.stringify({ name: mission.trim(), engineId: eid, pilot: username }),
        });
        const out = (await r.json()) as { sessionId?: string; name?: string; engineId?: string; missionId?: string; error?: string; suggest?: string };
        if (!r.ok || out.error) {
          setErr(out.suggest ? `${out.error}. Try "${out.suggest}".` : (out.error || `error ${r.status}`));
          setBusy(false);
          return;
        }
        onEnter({
          sessionId: out.sessionId!, name: out.name!, engineId: out.engineId!, missionId: out.missionId!,
        });
      } else {
        const r = (await rest.sessionCurrent()) as {
          session?: { id: string; name: string; engineId: string; missionId: string };
          owned?: boolean;
        };
        const s = r.session;
        if (!s) { setErr("No open mission to resume."); setBusy(false); return; }
        if (r.owned === false) {
          setOpenSession({ name: s.name, engineId: s.engineId, owned: false });
          setErr("That mission belongs to another console - wait for it to end.");
          setBusy(false);
          return;
        }
        onEnter({ sessionId: s.id, name: s.name, engineId: s.engineId, missionId: s.missionId });
      }
    } catch (e) {
      setErr("Could not start the mission: " + (e as Error).message);
    }
    setBusy(false);
  }

  const field =
    "w-full rounded px-2.5 py-1.5 font-mono text-[13px] outline-none transition-colors focus:brightness-110";
  const fstyle = {
    background: "var(--color-inset)",
    border: "1px solid var(--color-line)",
    color: "var(--color-ink)",
  };
  const labelStyle = {
    background: "var(--color-ok-tint)",
    color: "var(--color-ok)",
    borderLeft: "3px solid var(--color-ok)",
  } as const;

  const known = engines.some((e) => e.id === engineId);

  return (
    <div className="gate-in flex h-screen w-full flex-col" style={{ background: "var(--color-page)" }}>
      {/* Title above the login box. */}
      <header className="relative flex shrink-0 items-center justify-center px-6 pb-3 pt-5">
        <div className="text-center">
          <h1 className="font-stencil text-[32px] leading-none tracking-wide text-[var(--color-title)]">
            AERIS: DIGITAL TWIN
          </h1>
          <p className="mt-1.5 font-cond text-[13px] uppercase tracking-[0.22em] text-[var(--color-ink-2)]">
            Simulate · Detect · Protect
          </p>
          <p className="mt-1 font-cond text-[12px] uppercase tracking-[0.14em] text-[var(--color-ink-2)]">
            MALE UAV · Engine Health Monitoring
          </p>
        </div>
        <button
          onClick={onToggleDark}
          title="Toggle light / dark theme"
          className="absolute right-6 flex items-center gap-1 rounded px-2 py-0.5 font-cond text-[11px] font-600 uppercase tracking-[0.08em] transition-colors hover:brightness-125 active:translate-y-px"
          style={{ border: "1px solid var(--color-ok)", background: "var(--color-ok-tint)", color: "var(--color-ok)" }}
        >
          {dark ? "☀" : "☾"} Theme
        </button>
      </header>

      <div className="flex min-h-0 flex-1 gap-3 px-4 pb-4">
        {/* Login and mission card. */}
        <div className="flex min-w-0 items-center justify-center" style={{ flex: "62 1 0%" }}>
          <div
            className="w-full max-w-[520px] overflow-hidden"
            style={{ border: "1px solid var(--color-line)", background: "var(--color-panel)",
                     boxShadow: "0 8px 40px rgba(0,0,0,0.25)" }}
          >
            {step === "creds" ? (
              <form onSubmit={signIn} className="flex flex-col gap-3 p-6">
                <label className="inline-flex w-fit items-center gap-1.5 px-2 py-0.5 font-cond text-[12px] font-600 uppercase tracking-[0.12em]" style={labelStyle}>
                  Operator ID
                </label>
                <input className={field} style={fstyle} value={username}
                       onChange={(e) => setUsername(e.target.value)} autoFocus />
                <label className="inline-flex w-fit items-center gap-1.5 px-2 py-0.5 font-cond text-[12px] font-600 uppercase tracking-[0.12em]" style={labelStyle}>
                  Password
                </label>
                <input className={field} style={fstyle} type="password" value={password}
                       onChange={(e) => setPassword(e.target.value)} />
                {err && <span className="font-mono text-[12px]" style={{ color: "var(--color-crit)" }}>{err}</span>}
                <button type="submit" disabled={busy}
                  className="mt-1 w-full px-3 py-2 font-cond text-[14px] font-600 uppercase tracking-[0.12em] transition-colors hover:brightness-110"
                  style={{ background: "var(--color-button)", color: "var(--color-button-text)" }}>
                  {busy ? "Signing in…" : "Sign in"}
                </button>
                <div
                  className="mt-1 flex items-center justify-between px-2.5 py-1.5 font-mono text-[12px]"
                  style={{ border: "1px dashed var(--color-line-soft)", color: "var(--color-ink-2)" }}
                >
                  <span>demo login</span>
                  <span>username <span style={{ color: "var(--color-ink)" }}>pilot</span> · password <span style={{ color: "var(--color-ink)" }}>aeris</span></span>
                </div>
              </form>
            ) : (
              <div className="flex flex-col gap-3 p-6">
                {openSession?.owned && (
                  <button
                    onClick={() => enter(true)}
                    className="w-full px-3 py-2 font-cond text-[13px] font-600 uppercase tracking-[0.12em] transition-colors hover:brightness-110"
                    style={{ border: "1px solid var(--color-caution)", background: "var(--color-panel-2)", color: "var(--color-caution)" }}>
                    ▸ Resume open mission "{openSession.name}" · {openSession.engineId}
                  </button>
                )}
                {openSession && !openSession.owned ? (
                  <div className="flex flex-col items-center gap-2 px-3 py-6 text-center"
                       style={{ border: "1px dashed var(--color-caution)" }}>
                    <span className="font-cond text-[15px] font-600 uppercase"
                          style={{ color: "var(--color-caution)" }}>
                      Mission "{openSession.name}" in progress
                    </span>
                    <span className="font-mono text-[12px] text-[var(--color-ink-2)]">
                      {openSession.engineId} · owned by another console.
                      New missions stay locked until it ends — this page
                      refreshes automatically.
                    </span>
                    <button onClick={() => { loadFleet();
                      rest.sessionCurrent()
                        .then((r) => {
                          const s = (r as { session?: { name: string; engineId: string } }).session;
                          const owned = (r as { owned?: boolean }).owned !== false;
                          setOpenSession(s ? { name: s.name, engineId: s.engineId, owned } : null);
                        }).catch(() => {}); }}
                      className="mt-1 px-3 py-1 font-cond text-[12px] font-600 uppercase tracking-[0.1em] hover:brightness-110"
                      style={{ border: "1px solid var(--color-line)", background: "var(--color-panel-2)", color: "var(--color-ink)" }}>
                      ⟳ Check again
                    </button>
                  </div>
                ) : (
                <>
                {/* Engine number field. Digits only. */}
                <label className="inline-flex w-fit items-center gap-1.5 px-2 py-0.5 font-cond text-[12px] font-600 uppercase tracking-[0.12em]" style={labelStyle}>
                  Engine No.
                </label>
                <input
                  ref={engineRef}
                  className={field}
                  style={fstyle}
                  inputMode="numeric"
                  value={engineNum}
                  placeholder="e.g. 06  →  ENG-06"
                  onChange={(e) => setEngineNum(e.target.value.replace(/\D/g, "").slice(0, 4))}
                  onKeyDown={(e) => { if (e.key === "Enter") missionRef.current?.focus(); }}
                />
                <span className="font-mono text-[11px] text-[var(--color-ink-2)]">
                  {engineNum === ""
                    ? "type a new engine number, or click an engine cell on the right ▸"
                    : known
                      ? `${engineId} — existing asset (wear ledger carries over)`
                      : `${engineId} — new asset will be created · or pick a cell on the right ▸`}
                </span>

                {/* Mission name field. */}
                <label className="mt-1 inline-flex w-fit items-center gap-1.5 px-2 py-0.5 font-cond text-[12px] font-600 uppercase tracking-[0.12em]" style={labelStyle}>
                  Mission Name
                </label>
                <input ref={missionRef} className={field} style={fstyle} value={mission}
                       placeholder="e.g. SORTIE-01"
                       onChange={(e) => setMission(e.target.value)}
                       onKeyDown={(e) => {
                         if (e.key === "Enter" && !busy && mission.trim() && engineId) enter(false);
                       }} autoFocus />

                <div className="flex items-center justify-end">
                  <button onClick={() => { clearToken(); setStep("creds"); }}
                          className="font-mono text-[12px] text-[var(--color-ink-2)] hover:text-[var(--color-ink)]">
                    sign out
                  </button>
                </div>

                {err && <span className="font-mono text-[12px]" style={{ color: "var(--color-crit)" }}>{err}</span>}

                <button
                  onClick={() => enter(false)}
                  disabled={busy || !mission.trim() || !engineId}
                  className={`mt-1 w-full px-3 py-2 font-cond text-[14px] font-600 uppercase tracking-[0.12em] transition-colors ${
                    busy || !mission.trim() || !engineId ? "cursor-not-allowed opacity-40" : "hover:brightness-110"
                  }`}
                  style={{ background: "var(--color-button)", color: "var(--color-button-text)" }}>
                  {busy ? "Opening console…" : "Enter console ▸"}
                </button>
                <p className="text-center font-mono text-[11px] text-[var(--color-ink-2)]">
                  The engine starts on START ENGINE in the console. A mission ends only via END MISSION.
                </p>
                </>
                )}
              </div>
            )}
          </div>
        </div>

        {/* Engine fleet board. */}
        <div
          className="flex min-h-0 min-w-0 flex-col self-stretch"
          style={{
            flex: "38 1 0%",
            border: "1px solid var(--color-line)",
            background: "var(--color-panel)",
            boxShadow: "0 8px 40px rgba(0,0,0,0.25)",
          }}
        >
          <header
            className="flex shrink-0 items-center justify-between px-3 py-2"
            style={{ borderBottom: "1px solid var(--color-line-soft)" }}
          >
            <h2 className="font-cond text-[14px] font-600 uppercase tracking-[0.08em] text-[var(--color-ink-2)]">
              Engine Fleet
            </h2>
            <span className="font-mono text-[12px] text-[var(--color-ink-2)]">
              {step === "creds" ? "—" : `${engines.length} ${engines.length === 1 ? "ASSET" : "ASSETS"}`}
            </span>
          </header>

          <div className="scroll-y flex min-h-0 flex-1 flex-col gap-1.5 overflow-x-hidden p-2 overscroll-contain">
            {step === "creds" ? (
              <div
                className="flex flex-col items-center justify-center gap-1 px-3 py-8"
                style={{ border: "1px dashed var(--color-line)", color: "var(--color-ink-2)" }}
              >
                <span className="font-cond text-[15px] font-600 uppercase">Fleet locked</span>
                <span className="font-mono text-[12px]">sign in to load engines</span>
              </div>
            ) : engines.length === 0 ? (
              <div
                className="flex flex-col items-center justify-center gap-1 px-3 py-8"
                style={{ border: "1px dashed var(--color-line)", color: "var(--color-ink-2)" }}
              >
                <span className="font-cond text-[15px] font-600 uppercase">No engines on record</span>
                <span className="font-mono text-[12px]">enter a new engine no. on the left</span>
              </div>
            ) : null}
            {step === "mission" &&
              engines.map((e) => {
                const on = engineId === e.id;
                const ms = missionsByEngine[e.id] ?? [];
                const live = ms.some((s) => s.status === "OPEN");
                const rulLow = e.rul < 200;
                return (
                  <button
                    key={e.id}
                    onClick={() => pickEngine(e.id)}
                    className="flex flex-col gap-1 px-2.5 py-1.5 text-left transition-colors hover:brightness-105 active:translate-y-px"
                    style={{
                      border: `1px solid ${on ? "var(--color-ok)" : "var(--color-line-soft)"}`,
                      borderLeft: `3px solid ${on ? "var(--color-ok)" : "var(--color-line-soft)"}`,
                      background: on ? "var(--color-ok-tint)" : "var(--color-panel-2)",
                    }}
                  >
                    <div className="flex items-baseline justify-between gap-2">
                      <div className="flex min-w-0 items-baseline gap-1.5">
                        <span style={{ width: 7, height: 7, borderRadius: 9, flexShrink: 0, alignSelf: "center", background: on ? "var(--color-ok)" : "var(--color-line)" }} />
                        <span className="font-cond text-[15px] font-600 uppercase leading-none" style={{ color: on ? "var(--color-ok)" : "var(--color-ink)" }}>
                          {e.id}
                        </span>
                        {live && (
                          <span className="rounded px-1 font-mono text-[10px] font-600 uppercase text-white"
                                style={{ background: "var(--color-ok)" }}>
                            LIVE
                          </span>
                        )}
                      </div>
                      <span className="shrink-0 font-mono text-[12px] tabular-nums"
                            style={{ color: rulLow ? "var(--color-crit)" : "var(--color-ink-2)" }}>
                        {Number(e.hours || 0).toFixed(1)} h · RUL {Number(e.rul || 0).toFixed(0)} h
                      </span>
                    </div>
                    <div className="scroll-y max-h-[72px] overflow-x-hidden overflow-y-auto overscroll-contain"
                         style={{ borderTop: "1px dashed var(--color-line-soft)" }}>
                      {ms.length === 0 ? (
                        <span className="font-mono text-[11px] uppercase text-[var(--color-ink-2)]">no missions yet</span>
                      ) : (
                        ms.map((s) => (
                          <div key={s.id} className="flex items-center justify-between gap-2 py-px font-mono text-[11px] uppercase">
                            <span className="truncate text-[var(--color-ink)]">{s.name}</span>
                            <span className="shrink-0" style={{ color: s.status === "OPEN" ? "var(--color-ok)" : "var(--color-ink-2)" }}>
                              {s.status === "OPEN" ? "live" : "ended"}
                            </span>
                          </div>
                        ))
                      )}
                    </div>
                  </button>
                );
              })}
          </div>

          <footer className="shrink-0 px-3 py-1.5 font-mono text-[11px] uppercase text-[var(--color-ink-2)]"
                  style={{ borderTop: "1px solid var(--color-line-soft)" }}>
            {step === "mission" ? "click a cell to select its engine" : "operator sign-in required"}
          </footer>
        </div>
      </div>
    </div>
  );
}
