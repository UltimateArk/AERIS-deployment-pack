import { useCallback, useEffect, useMemo, useState } from "react";
import { EnginePanel } from "./components/EnginePanel";
import { FaultInjector } from "./components/FaultInjector";
import { FaultLogsPanel } from "./components/FaultLogsPanel";
import { LiveGraphStack } from "./components/GraphStack";
import { LoginPage } from "./components/LoginPage";
import { MLSection, type ActiveFault } from "./components/MLSection";
import { ReplayListPanel } from "./components/ReplayListPanel";
import { ReplayScreen } from "./components/ReplayScreen";
import { LiveTelemetryGrid } from "./components/TelemetryGrid";
import { conflictsWith, FAULT_BY_ID, FAULTS } from "./lib/faults";
import { rest, type TickMsg } from "./lib/backend";
import { useBackend, type ReplayFrame } from "./lib/live";
import { useTwinDirect, twinRest } from "./lib/twin";
import { isAuthed, clearToken, armRefreshFromStored, API_BASE, authHeaders, getToken } from "./lib/auth";
import type { Mission } from "./lib/missions";
import type { Controls } from "./lib/telemetry";

interface SessionInfo {
  sessionId: string;
  name: string;
  engineId: string;
  missionId: string;
}

// Top-level gate. Login and mission setup lead to the console.
export default function App() {
  const [session, setSession] = useState<SessionInfo | null>(null);
  const [checking, setChecking] = useState(true);
  // Theme state at app root. Shared by login, console, and replay.
  const [dark, setDark] = useState(() => {
    try { return localStorage.getItem("aeris.theme") === "dark"; } catch { return false; }
  });
  useEffect(() => {
    document.documentElement.setAttribute("data-theme", dark ? "dark" : "light");
    try { localStorage.setItem("aeris.theme", dark ? "dark" : "light"); } catch { }
  }, [dark]);
  const toggleDark = () => setDark((d) => !d);

  useEffect(() => {
    armRefreshFromStored();
    (async () => {
      if (isAuthed()) {
        try {
          const r = (await rest.sessionCurrent()) as {
            session?: { id: string; name: string; engineId: string; missionId: string };
          };
          const s = r.session;
          if (s)
            setSession({ sessionId: s.id, name: s.name, engineId: s.engineId, missionId: s.missionId });
        } catch { }
      }
      setChecking(false);
    })();
  }, []);

  useEffect(() => {
    const h = () => { clearToken(); setSession(null); };
    window.addEventListener("aeris:unauthorized", h);
    return () => window.removeEventListener("aeris:unauthorized", h);
  }, []);

  if (checking)
    return <div className="h-screen w-full" style={{ background: "var(--color-page)" }} />;
  if (!session) return <LoginPage onEnter={setSession} dark={dark} onToggleDark={toggleDark} />;
  return (
    <Console
      key={session.sessionId}
      session={session}
      dark={dark}
      onToggleDark={toggleDark}
      onEndMission={() => setSession(null)}
      onSessionChange={setSession}
    />
  );
}

// Console. Requires an open pilot mission.
function Console({
  session,
  dark,
  onToggleDark,
  onEndMission,
  onSessionChange,
}: {
  session: SessionInfo;
  dark: boolean;
  onToggleDark: () => void;
  onEndMission: () => void;
  onSessionChange: (s: SessionInfo) => void;
}) {
  const eng = useBackend();
  const twin = useTwinDirect();
  const [replayPanelOpen, setReplayPanelOpen] = useState(false);
  const [logsPanelOpen, setLogsPanelOpen] = useState(false);

  const [activeReplay, setActiveReplay] = useState<{
    meta: Mission; frames: ReplayFrame[];
  } | null>(null);
  const [missions, setMissions] = useState<Mission[]>([]);

  // Replay list shows pilot missions from the backend by name.
  const refreshMissions = useCallback(async () => {
    try {
      const rows = (await rest.sessions()) as Array<{
        id: string; name: string; engine_id: string; pilot: string;
        started_at: number; ended_at: number | null; status: string; mission_id: string;
      }>;
      setMissions(
        (Array.isArray(rows) ? rows : []).map((s) => ({
          id: s.mission_id,
          name: s.name,
          started_at: s.started_at,
          ended_at: s.ended_at,
          status: s.status === "OPEN" ? "NOMINAL" : "ENDED",
          replay_built: s.status === "ENDED" ? 1 : 0,
        })),
      );
    } catch { }
  }, []);
  useEffect(() => {
    refreshMissions();
    const id = setInterval(refreshMissions, 15000);
    return () => clearInterval(id);
  }, [refreshMissions]);

  // Stable array for memoized injector. Rebuilt only when the desired set changes.
  const desiredArr = useMemo(() => [...eng.desired], [eng.desired]);

  const randomFault = useCallback(() => {
    const cur = [...eng.desired];
    if (cur.length >= 3) return;
    const candidates = FAULTS.filter(
      (f) => f.id !== "0" && !cur.includes(f.id) && !conflictsWith(f.id, cur),
    );
    if (!candidates.length) return;
    eng.toggleFault(candidates[Math.floor(Math.random() * candidates.length)].id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [eng.desired]);

  // Mission end flow. Stop closes the mission and resets console state.
  type Phase = "idle" | "running";
  const [phase, setPhase] = useState<Phase>("idle");
  const [awaitingMission, setAwaitingMission] = useState(false);
  const [replayReady, setReplayReady] = useState(false);
  const [missionEnd, setMissionEnd] = useState<null | { next: string; err: string; busy: boolean }>(null);

  // Sync phase with backend after reload. Running engine sets running phase.
  useEffect(() => {
    if (eng.engineOn && phase === "idle") setPhase("running");
  }, [eng.engineOn, phase]);

  // Tab close ends the mission at once. Beacon posts during unload with token in query.
  useEffect(() => {
    const bye = () => {
      const t = getToken();
      if (!t) return;
      try {
        navigator.sendBeacon(`${API_BASE}/api/session/abort?token=${encodeURIComponent(t)}`);
      } catch { }
    };
    window.addEventListener("pagehide", bye);
    return () => window.removeEventListener("pagehide", bye);
  }, []);

  // Stable callbacks for memoized panel. Avoids per-tick reconciliation of the canvas subtree.
  const startEngine = useCallback(() => {
    if (phase !== "idle") return;
    // Fresh state has no open mission. Start opens the next-mission card.
    if (awaitingMission) {
      if (!missionEnd) setMissionEnd({ next: "", err: "", busy: false });
      return;
    }
    if (!twin.engineOnRef.current) twin.toggleEngine();
    setPhase("running");
  }, [phase, awaitingMission, missionEnd, twin.engineOnRef, twin.toggleEngine]);

  const endMission = useCallback(async () => {
    if (phase !== "running" || missionEnd) return;
    // Stop uses backend and direct twin paths. Either stop takes effect.
    await Promise.allSettled([rest.stop(), twinRest.stop()]);
    try { await rest.sessionEnd(); } catch { }
    // Sync twin engine flag after stop. Keeps 3D state and next start consistent.
    if (twin.engineOnRef.current) twin.toggleEngine();
    refreshMissions();
    // Reset graphs, faults, and log unconditionally. Failed requests leave no stale mission state.
    twin.clearBuffers();
    eng.clearFaults();
    eng.clearLog();
    setReplayReady(true);
    setPhase("idle");
    setAwaitingMission(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, missionEnd, refreshMissions]);

  const openNextMission = useCallback(() => {
    if (missionEnd) return;
    setMissionEnd({ next: "", err: "", busy: false });
  }, [missionEnd]);

  async function startNextMission() {
    const name = missionEnd?.next.trim() ?? "";
    if (!name) { setMissionEnd((m) => m && { ...m, err: "mission name required" }); return; }
    setMissionEnd((m) => m && { ...m, busy: true, err: "" });
    // Switch twin and backend to the session engine, then open.
    try { await twinRest.switchEngine(session.engineId); } catch { }
    try { await rest.switchEngine(session.engineId); } catch { }
    try {
      const r = await fetch(`${API_BASE}/api/session/start`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders() },
        body: JSON.stringify({ name, engineId: session.engineId, pilot: "pilot" }),
      });
      const out = (await r.json()) as {
        sessionId?: string; name?: string; engineId?: string; missionId?: string;
        error?: string; suggest?: string;
      };
      if (!r.ok || out.error) {
        setMissionEnd((m) => m && {
          ...m, busy: false,
          err: out.suggest ? `${out.error}. Try "${out.suggest}".` : (out.error || `error ${r.status}`),
        });
        return;
      }
      setMissionEnd(null);
      onSessionChange({
        sessionId: out.sessionId!, name: out.name!, engineId: out.engineId!, missionId: out.missionId!,
      });
    } catch (e) {
      setMissionEnd((m) => m && { ...m, busy: false, err: "could not start: " + (e as Error).message });
    }
  }

  // Memoized arrays for the ML section. Limits re-renders to real changes.
  const openLogs = useCallback(() => setLogsPanelOpen(true), []);
  const closeLogs = useCallback(() => setLogsPanelOpen(false), []);
  const resetEngineWear = useCallback(() => {
    if (window.confirm(`Factory-reset ${twin.engineId} wear + RUL (fresh 2000 h, clean health)? Replays are kept.`)) {
      twin.resetEngine();
      rest.resetEngine({ engineId: twin.engineId }).catch(() => {});
    }
  }, [twin.engineId, twin.resetEngine]);

  const openReplayPanel = useCallback(() => {
    refreshMissions();
    setReplayReady(false);
    setReplayPanelOpen(true);
  }, [refreshMissions]);
  const closeReplayPanel = useCallback(() => setReplayPanelOpen(false), []);

  // Console logout. Stops engine, closes mission, clears token.
  const logout = useCallback(async () => {
    try { await rest.stop(); } catch { }
    try { await rest.sessionEnd(); } catch { }
    clearToken();
    onEndMission();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const selectReplay = useCallback(async (m: Mission) => {
    try {
      const frames = await eng.loadReplay(m.id);
      setActiveReplay({ meta: m, frames });
    } catch {
      setActiveReplay({ meta: m, frames: [] });
    }
    setReplayPanelOpen(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const clearDatabase = useCallback(async () => {
    try { await rest.clearDatabase(); } catch { }
    setMissions([]);
    setActiveReplay(null);
    eng.clearReplay();
    eng.clearLog();
    refreshMissions();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshMissions]);

  const deleteMission = useCallback(async (m: Mission) => {
    try {
      await rest.deleteReplay(m.id);
    } catch (e) {
      window.alert("Could not delete: " + (e as Error).message);
      return;
    }
    setActiveReplay((a) => (a && a.meta.id === m.id ? null : a));
    refreshMissions();
  }, [refreshMissions]);

  const activeFaults: ActiveFault[] = useMemo(
    () =>
      eng.faults
        .map((f) => ({
          def: FAULT_BY_ID[String(f.code)],
          seconds: f.age ?? 0,
          conf: f.conf,
          origin: f.origin,
          cyl: f.cyl,
          trend: eng.trend,
          onset: f.onset,
        }))
        .filter((f) => f.def),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [eng.faults, eng.trend],
  );
  const predictedFaults: ActiveFault[] = useMemo(
    () =>
      eng.predicted
        .filter((p) => !eng.desired.has(String(p.code)))
        .map((p) => ({
          def: FAULT_BY_ID[String(p.code)],
          seconds: 0, predicted: true, ttfSec: p.ttfSec, trend: eng.trend,
        }))
        .filter((f) => f.def),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [eng.predicted, eng.desired, eng.trend],
  );

  return (
    <div className="screen-in flex h-screen flex-col overflow-hidden">
      <header
        className="flex shrink-0 items-center justify-between gap-4 px-4 py-2"
        style={{ background: "var(--color-header)", color: "var(--color-title)", borderBottom: "1px solid var(--color-line)" }}
      >
        <div className="flex min-w-[280px] items-center gap-2">
          <span className="font-cond text-[12px] font-500 uppercase text-[var(--color-ink-2)]">
            Mission:
          </span>
          <span className="font-stencil text-[13px] tracking-wide text-[var(--color-ink)]">
            {session.name}
          </span>
          <span className="px-1.5 py-0.5 font-mono text-[11px] uppercase"
                style={{ border: "1px solid var(--color-line-soft)", color: "var(--color-ok)" }}>
            {session.engineId}
          </span>
          <button
            onClick={onToggleDark}
            title="Toggle light / dark theme"
            className="ml-1 flex items-center gap-1 rounded px-2 py-0.5 font-cond text-[11px] font-600 uppercase tracking-[0.08em] transition-colors hover:brightness-125 active:translate-y-px"
            style={{ border: "1px solid var(--color-ok)", background: "var(--color-ok-tint)", color: "var(--color-ok)" }}
          >
            {dark ? "☀" : "☾"} Theme
          </button>
        </div>
        <div className="flex flex-1 flex-col items-center">
          <h1 className="font-cond text-[24px] font-600 uppercase leading-none tracking-[0.05em] text-[var(--color-title)]">
            AERIS: Digital Twin
          </h1>
          <span className="mt-0.5 font-mono text-[12px] uppercase text-[var(--color-ink-2)]">
            MALE UAV · Engine Health Monitoring System
          </span>
        </div>
        <div className="flex min-w-[280px] items-center justify-end gap-3">
          <span className="flex items-center gap-1.5 font-mono text-[12px] uppercase text-[var(--color-ink-2)]">
            <span
              className="h-[7px] w-[7px] rounded-full"
              style={{
                background: activeReplay
                  ? "var(--color-ink-2)"
                  : twin.connected && twin.engineOn
                    ? "var(--color-ok)"
                    : "var(--color-ink-2)",
              }}
            />
            {activeReplay ? "REPLAY" : twin.connected ? (twin.engineOn ? "LIVE" : "STANDBY") : "OFFLINE"}
          </span>
          <button
            onClick={openReplayPanel}
            className={`relative px-3 py-1 font-cond text-[12px] font-500 uppercase tracking-[0.1em] transition-colors hover:brightness-110 ${replayReady ? "animate-blip" : ""}`}
            style={{
              border: `1px solid ${replayReady ? "var(--color-caution)" : "var(--color-drab-2)"}`,
              background: "var(--color-button)",
              color: "var(--color-button-text)",
              boxShadow: replayReady ? "0 0 0 3px var(--color-caution-tint, rgba(179,107,0,0.25))" : "none",
            }}
          >
            ▷ Mission Replay{replayReady ? " ●" : ""}
          </button>
          <button
            onClick={logout}
            title="Log out (ends mission if running, back to sign-in)"
            className="px-2 py-1 font-cond text-[12px] font-500 uppercase tracking-[0.1em] transition-colors hover:brightness-110 active:translate-y-px"
            style={{ border: "1px solid var(--color-line-soft)", background: "transparent", color: "var(--color-ink-2)" }}
          >
            ⏻ Logout
          </button>
        </div>
      </header>

      {activeReplay ? (
        <ReplayScreen
          mission={activeReplay.meta}
          frames={activeReplay.frames}
          onBack={() => { setActiveReplay(null); eng.clearReplay(); }}
        />
      ) : (
        <main
          className="grid min-h-0 flex-1 gap-2 p-2"
          style={{
            gridTemplateColumns: "390px minmax(0,1fr) 360px",
            gridTemplateRows: "minmax(0,1.75fr) minmax(0,0.65fr)",
          }}
        >
          <div className="min-h-0 min-w-0">
            <EnginePanel
              phase={phase}
              controls={twin.controls as Controls}
              onControl={(k, v) => twin.updateControls({ [k]: v })}
              onStart={startEngine}
              onEndMission={endMission}
              frameRef={twin.frameRef}
              engineOnRef={twin.engineOnRef}
              dark={dark}
              missionName={session.name}
            />
          </div>
          <div className="min-h-0 min-w-0">
            <LiveGraphStack store={twin.display} />
          </div>
          <div className="row-span-2 min-h-0 min-w-0">
            <MLSection
              faults={[...activeFaults, ...predictedFaults]}
              rul={eng.rul}
              healthStore={twin.healthStore}
              onOpenLogs={openLogs}
              rulBurn={eng.rulBurn}
              lifeDelta={eng.lifeDelta}
              onResetEngine={resetEngineWear}
            />
          </div>
          <div className="min-h-0 min-w-0">
            <FaultInjector active={desiredArr} confirmed={eng.twinActive} onToggle={eng.toggleFault} onRandom={randomFault} onClear={eng.clearFaults} />
          </div>
          <div className="min-h-0 min-w-0">
            <LiveTelemetryGrid store={twin.display} />
          </div>
        </main>
      )}

      <ReplayListPanel
        open={replayPanelOpen}
        onClose={closeReplayPanel}
        missionId={session.name}
        missions={missions}
        onSelect={selectReplay}
        onDelete={deleteMission}
        onClearDatabase={clearDatabase}
      />
      <FaultLogsPanel
        open={logsPanelOpen}
        onClose={closeLogs}
        logs={eng.log.map((l) => ({
          id: l.id, faultId: l.faultId, name: l.name,
          severity: l.severity, time: l.time, action: l.action as "injected" | "cleared",
        }))}
        onClear={eng.clearLog}
      />

      {missionEnd && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4"
          style={{ background: "rgba(20,22,18,0.45)", backdropFilter: "blur(6px)" }}
        >
          <div
            className="w-full max-w-[440px] overflow-hidden"
            style={{ border: "1px solid var(--color-line)", background: "var(--color-panel)",
                     boxShadow: "0 8px 40px rgba(0,0,0,0.35)" }}
          >
            <header className="px-5 pb-2.5 pt-5 text-center" style={{ borderBottom: "1px solid var(--color-line-soft)" }}>
              <h2 className="font-stencil text-[20px] tracking-wide text-[var(--color-title)]">
                MISSION COMPLETE
              </h2>
              <p className="mt-1 font-mono text-[12px] uppercase text-[var(--color-ink-2)]">
                {session.name} saved — replay available
              </p>
            </header>
            <div className="flex flex-col gap-3 p-5">
              <label className="font-cond text-[12px] font-600 uppercase tracking-[0.1em] text-[var(--color-ink-2)]">
                New mission name
              </label>
              <input
                autoFocus
                disabled={missionEnd.busy}
                value={missionEnd.next}
                placeholder="e.g. SORTIE-03"
                className="w-full rounded px-2.5 py-1.5 font-mono text-[13px] outline-none transition-colors focus:brightness-110"
                style={{ background: "var(--color-inset)", border: "1px solid var(--color-line)", color: "var(--color-ink)" }}
                onChange={(e) => setMissionEnd((m) => m && { ...m, next: e.target.value })}
                onKeyDown={(e) => { if (e.key === "Enter") startNextMission(); }}
              />
              <div className="flex items-center justify-between font-mono text-[11px] uppercase text-[var(--color-ink-2)]">
                <span>engine {session.engineId} carries over</span>
                <button
                  onClick={() => { setMissionEnd(null); onEndMission(); }}
                  className="normal-case underline-offset-2 hover:text-[var(--color-ink)] hover:underline"
                >
                  change engine
                </button>
              </div>
              {missionEnd.err && (
                <span className="font-mono text-[12px]" style={{ color: "var(--color-crit)" }}>
                  {missionEnd.err}
                </span>
              )}
              <div className="mt-1 flex gap-2">
                <button
                  onClick={startNextMission}
                  disabled={missionEnd.busy || !missionEnd.next.trim()}
                  className={`flex-1 px-3 py-2 font-cond text-[13px] font-600 uppercase tracking-[0.1em] transition-colors ${
                    missionEnd.busy || !missionEnd.next.trim()
                      ? "cursor-not-allowed opacity-40"
                      : "hover:brightness-110"
                  }`}
                  style={{ background: "var(--color-button)", color: "var(--color-button-text)" }}
                >
                  {missionEnd.busy ? "Working…" : "Start next mission ▸"}
                </button>
                <button
                  onClick={() => { setMissionEnd(null); onEndMission(); }}
                  disabled={missionEnd.busy}
                  title="Back to the login gate - pick the same or a different engine"
                  className="shrink-0 whitespace-nowrap px-3 py-2 font-cond text-[12px] font-600 uppercase tracking-[0.08em] transition-colors hover:brightness-95 disabled:opacity-40"
                  style={{ border: "1px solid var(--color-line)", background: "var(--color-panel-2)", color: "var(--color-ink)" }}
                >
                  Return to main menu / Change engine
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export type { TickMsg };
