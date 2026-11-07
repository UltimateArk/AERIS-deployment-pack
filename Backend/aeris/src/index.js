const http = require("http");
const path = require("path");
const { Worker } = require("worker_threads");
const protobuf = require("protobufjs");
const { WebSocketServer, WebSocket } = require("ws");
const C = require("./config");
const { create } = require("./db/databases");
const replay = require("./db/replay");

// Protobuf decoding.
const Telemetry = new protobuf.Root()
  .loadSync(C.paths.proto, { keepCase: true })
  .lookupType("Telemetry");
const decode = (buf) =>
  Telemetry.toObject(Telemetry.decode(buf), { defaults: true, longs: Number });

// Database setup.
const pendingReplay = new Set();
let buildingReplay = false;
async function tryReplay() {
  // Builds replays one at a time.
  // Interval retries pending ids.
  if (buildingReplay) return;
  buildingReplay = true;
  try {
    for (const id of [...pendingReplay]) {
      if (!replay.ready(rawStore, eventsStore)) return;
      try {
        await replay.build(id, rawStore, eventsStore);
        pendingReplay.delete(id);
      } catch (e) {
        console.error("[replay] failed, will retry:", e.message);
        return;
      }
    }
  } finally {
    buildingReplay = false;
  }
}
const { rawStore, eventsStore } = create(tryReplay);
setInterval(tryReplay, 5000);
// Folds WAL files into the database each minute.
// Keeps queries fast under continuous ingest.
setInterval(() => {
  rawStore.checkpoint();
  eventsStore.checkpoint();
}, 60000);

// ML worker thread.
const worker = new Worker(path.join(__dirname, "worker", "ml.worker.js"));
worker.on("error", (e) => console.error("[worker] crashed:", e));
worker.on("exit", (c) => console.error("[worker] exited", c));

// Operator tokens or script API key gate access.
// Login, refresh, and health stay public.
// Disabled flag opens access for local scripts.
const auth = require("./auth");
const API_KEY = process.env.API_KEY || null;
const AUTH_DISABLED = process.env.AUTH_DISABLED === "1";
if (AUTH_DISABLED)
  console.warn("[auth] AUTH_DISABLED=1 - REST/WS open (dev only)");

function tokenOf(req) {
  const u = new URL(req.url, "http://x");
  const h = req.headers["authorization"] || "";
  const bearer = h.startsWith("Bearer ") ? h.slice(7) : null;
  return bearer || u.searchParams.get("token") || req.headers["x-api-key"] || null;
}
function authOk(req) {
  if (AUTH_DISABLED) return true;
  const t = tokenOf(req);
  if (!t) return false;
  if (API_KEY && t === API_KEY) return true;
  return !!auth.verify(t);
}
function needKey(req, res) {
  if (authOk(req)) return true;
  res.writeHead(401, { "Content-Type": "application/json",
                       "Access-Control-Allow-Origin": "*" });
  res.end(JSON.stringify({ error: "unauthorized" }));
  return false;
}

// Frontend server. Single-port PaaS mode shares one $PORT:
// frontend WS on `/`, twin ingest WS on `/ingest`.
const server = http.createServer(handleHttp);
const feWss = new WebSocketServer({ server, path: "/" });
// Ends the mission when the console disconnects.
// Short grace frames form the shutdown signature.
let lastFrontendSeen = Date.now();
feWss.on("connection", (ws, req) => {
  if (!authOk(req)) {
    ws.close(4401, "unauthorized");
    return;
  }
  lastFrontendSeen = Date.now();
  ws.on("close", () => { lastFrontendSeen = Date.now(); });
});

const CLIENT_LOST_GRACE_MS = 8000;
setInterval(() => {
  if (feWss.clients.size > 0) { lastFrontendSeen = Date.now(); return; }
  if (openSession && Date.now() - lastFrontendSeen > CLIENT_LOST_GRACE_MS) {
    console.log("[session] console gone - ending mission");
    closePilotSession("client disconnected");
    twinFire("POST", "/engine/stop", {});
  }
}, 2000);

// Forwards controls to the engine service.
// Backend holds no physics model.
const ENGINE_REST = process.env.ENGINE_REST || "http://localhost:8000";
function proxyJson(res, method, path, body) {
  const data = body ? JSON.stringify(body) : null;
  const u = new URL(path, ENGINE_REST);
  const lib = u.protocol === "https:" ? require("https") : require("http");
  const rq = lib.request(
    {
      hostname: u.hostname,
      port: u.port,
      path: u.pathname,
      method,
      headers: {
        "Content-Type": "application/json",
        ...(data ? { "Content-Length": Buffer.byteLength(data) } : {}),
      },
    },
    (rp) => {
      let buf = "";
      rp.on("data", (c) => (buf += c));
      rp.on("end", () => {
        res.writeHead(rp.statusCode || 200, {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        });
        res.end(buf || "{}");
      });
    },
  );
  rq.on("error", (e) =>
    res.end(JSON.stringify({ error: "engine unreachable: " + e.message })),
  );
  if (data) rq.write(data);
  rq.end();
}
// Sends control without waiting for a response.
// Used by the watchdog path.
function twinFire(method, path, body) {
  const data = body ? JSON.stringify(body) : null;
  const u = new URL(path, ENGINE_REST);
  const lib = u.protocol === "https:" ? require("https") : require("http");
  const rq = lib.request(
    {
      hostname: u.hostname,
      port: u.port,
      path: u.pathname,
      method,
      headers: {
        "Content-Type": "application/json",
        ...(data ? { "Content-Length": Buffer.byteLength(data) } : {}),
      },
    },
    (rp) => { rp.on("data", () => {}); rp.on("end", () => {}); },
  );
  rq.on("error", () => {});
  if (data) rq.write(data);
  rq.end();
}
function readBody(req) {
  return new Promise((resolve) => {
    let b = "";
    req.on("data", (c) => (b += c));
    req.on("end", () => {
      try {
        resolve(b ? JSON.parse(b) : {});
      } catch {
        resolve({});
      }
    });
  });
}
const broadcast = (o) => {
  const s = JSON.stringify(o);
  feWss.clients.forEach((c) => c.readyState === WebSocket.OPEN && c.send(s));
};

worker.on("message", (m) => {
  if (m.kind === "ready") {
    console.log("[worker] ready, classifiers:", m.classifiers.join(","));
    if (Array.isArray(m.thresholds)) workerThresholds = m.thresholds;
    // Resends the active mission after init.
    // First message can land during init.
    if (mission) worker.postMessage({ type: "mission", id: mission.id });
    // Restores consumed hours for the active engine.
    // Out of range values reset to zero.
    try {
      const row = eventsStore.db
        .prepare("SELECT consumed_h FROM life_state WHERE engine_id=?")
        .get(CUR_ENGINE);
      if (row && typeof row.consumed_h === "number") {
        const c = row.consumed_h;
        worker.postMessage({ type: "life", engineId: CUR_ENGINE, c: c > 0 && c < 2000 ? c : 0 });
      }
    } catch {}
    return;
  }
  const id = m.missionId;
  if (!id) return;
  if (m.kind === "fast") {
    // Stores one row per firing candidate.
    // Anomaly only ticks store a single code zero row.
    const cands = m.fault ? m.candidates.filter((c) => c.code !== m.fault.code) : [];
    const rows = m.fault
      ? [m.fault, ...cands.map((c) => ({ ...c }))]
      : [null];
    for (const f of rows) {
      const rowFault = f ?? m.fault;
      eventsStore.enqueue("fault", {
        mission_id: id,
        ts: m.ts,
        anomaly: m.anomaly.flag ? 1 : 0,
        anomaly_score: m.anomaly.score,
        anomaly_feature: m.anomaly.feature,
        fault_code: rowFault ? rowFault.code : 0,
        fault_name: rowFault?.name ?? null,
        severity: rowFault?.severity ?? null,
        action: rowFault?.action ?? null,
        prob: rowFault?.p ?? null,
        calibrated: rowFault?.calibrated ?? null,
        cylinder: rowFault?.cylinder ?? null,
        details: rowFault
          ? JSON.stringify({
              description: rowFault.description,
              cause: rowFault.cause,
              rectification: rowFault.rectification,
              candidates: m.candidates,
            })
          : null,
      });
    }
  } else if (m.kind === "trend") {
    eventsStore.enqueue("trend", {
      mission_id: id,
      ts: m.ts,
      json: JSON.stringify(m.trend),
    });
  } else if (m.kind === "rul") {
    eventsStore.enqueue("rul", {
      mission_id: id,
      ts: m.ts,
      rul: m.rul,
      rul_smoothed: m.rulSmoothed,
    });
    // Stores consumed hours per engine across missions.
    if (typeof m.consumed === "number" && m.engineId) {
      try {
        eventsStore.db
          .prepare(
            "INSERT INTO life_state(engine_id, consumed_h, updated_at) VALUES(?,?,?) " +
              "ON CONFLICT(engine_id) DO UPDATE SET consumed_h=excluded.consumed_h, updated_at=excluded.updated_at",
          )
          .run(m.engineId, m.consumed, m.ts);
      } catch {}
    }
  }
  broadcast(m);
});

// Session maps to one mission id.
// Engine start and stop are events inside it.
// Parked frames record as part of the mission.
let openSession = null;
let mission = null;
let CUR_ENGINE = "ENG-01";
let workerThresholds = null;

function startMission(id, ts) {
  mission = { id, lastSeen: Date.now() };
  rawStore.enqueue("missionStart", { id, started_at: ts });
  worker.postMessage({ type: "mission", id });
  broadcast({ kind: "mission", event: "start", missionId: id });
  console.log("[mission] start", id);
}
function endMission(reason) {
  if (!mission) return;
  const id = mission.id;
  mission = null;
  rawStore.enqueue("missionEnd", { id, ended_at: Date.now() });
  broadcast({ kind: "mission", event: "end", missionId: id });
  console.log("[mission] end", id, `(${reason})`);
  setTimeout(() => {
    pendingReplay.add(id);
    tryReplay();
  }, 2500); // 2.5 second delay
}

function openPilotSession({ name, engineId, pilot }) {
  const clean = String(name || "").trim();
  if (!clean) return { error: "mission name required" };
  const clashed = rawStore.db
    .prepare("SELECT name FROM sessions WHERE name=? COLLATE NOCASE")
    .get(clean);
  if (clashed) return { error: "mission name already used", suggest: `${clean} (2)` };
  if (openSession) return { error: "a mission is already open", sessionId: openSession.id };
  const sid = "s" + Date.now().toString(36) + Math.floor(Math.random() * 1e4).toString(36);
  const missionId = sid;
  const startedAt = Date.now();
  rawStore.db
    .prepare(
      "INSERT INTO sessions(id,name,engine_id,pilot,started_at,status,mission_id) VALUES(?,?,?,?,?,'OPEN',?)",
    )
    .run(sid, clean, engineId || "ENG-01", pilot || "pilot", startedAt, missionId);
  openSession = {
    id: sid, name: clean, engineId: engineId || "ENG-01",
    pilot: pilot || "pilot", missionId, startedAt,
    // Recording starts on the first running frame.
    // Login time stays unrecorded.
    recorded: false,
  };
  // Points the twin and worker at the session engine.
  // Separate ledgers stop cross engine leakage.
  CUR_ENGINE = openSession.engineId;
  twinFire("POST", "/engine/switch", { engineId: openSession.engineId });
  // Parks the twin stopped with channels at ambient.
  // Blocks recordable data until start.
  twinFire("POST", "/engine/park", {});
  try {
    const row = eventsStore.db
      .prepare("SELECT consumed_h FROM life_state WHERE engine_id=?")
      .get(CUR_ENGINE);
    const c = row && typeof row.consumed_h === "number" ? row.consumed_h : 0;
    worker.postMessage({ type: "life", engineId: CUR_ENGINE, c: c > 0 && c < 2000 ? c : 0 });
  } catch {}
  broadcast({ kind: "session", event: "start", sessionId: sid, name: clean,
              engineId: openSession.engineId, missionId });
  console.log(`[session] open "${clean}" (${sid}) engine=${openSession.engineId}`);
  return { sessionId: sid, missionId, name: clean, engineId: openSession.engineId };
}

function closePilotSession(reason = "manual") {
  if (!openSession) return { error: "no open session" };
  const s = openSession;
  openSession = null;
  endMission(reason);
  rawStore.db
    .prepare("UPDATE sessions SET ended_at=?, status='ENDED' WHERE id=?")
    .run(Date.now(), s.id);
  broadcast({ kind: "session", event: "end", sessionId: s.id, name: s.name });
  console.log(`[session] close "${s.name}" (${s.id}) (${reason})`);
  return { sessionId: s.id, name: s.name, missionId: s.missionId };
}

// Ingest path.
// Drops frames closer than 80 ms.
// Contract rate is 10 Hz.
// Single-port mode (Render: INGEST_PORT == HTTP_PORT) attaches to the same
// HTTP server at `/ingest`; local dev keeps a separate `:8080` listener.
let lastIngestTs = 0;
let ingestN = 0, ingestDropped = 0;
setInterval(() => {
  // Logs kept and dropped counts each 30 seconds.
  console.log(`[ingest] ${ingestN} kept, ${ingestDropped} rate-dropped in 30s`);
  ingestN = 0; ingestDropped = 0;
}, 30000);
function handleIngestConnection(ws) {
  console.log("[ingest] twin connected");
  ws.on("message", (data, isBinary) => {
    let s;
    try {
      s = isBinary ? decode(data) : JSON.parse(data.toString());
    } catch (e) {
      return console.error("[ingest] bad frame:", e.message);
    }
    // Prefers generation stamp over arrival time.
    // Falls back to arrival stamp without it.
    if (typeof s.ts_ms === "number" && s.ts_ms > 0) s.ts = Math.round(s.ts_ms);
    else if (!s.ts) s.ts = Date.now();
    if (s.end_of_mission !== true && s.ts - lastIngestTs < 80) { ingestDropped++; return; }
    lastIngestTs = s.ts;
    ingestN++;
    // Switches ledger when the engine id changes.
    if (s.engineId && s.engineId !== CUR_ENGINE) {
      CUR_ENGINE = s.engineId;
      try {
        const row = eventsStore.db
          .prepare("SELECT consumed_h FROM life_state WHERE engine_id=?")
          .get(CUR_ENGINE);
        const c = row && typeof row.consumed_h === "number" ? row.consumed_h : 0;
        worker.postMessage({ type: "life", engineId: CUR_ENGINE, c: c > 0 && c < 2000 ? c : 0 });
      } catch {}
    }
    // Drops parked heartbeats without an open session.
    if (!openSession) return;
    // Recording starts on running frames above 200 rpm.
    // Parked frames open no mission.
    if (!openSession.recorded) {
      if (s.parked === true || Number(s.rpm ?? 0) <= 200) return;
      openSession.recorded = true;
    }
    // Reopens the mission window after a database clear.
    // Keeps live ingest flowing.
    if (!mission) startMission(openSession.missionId, s.ts);
    // Records under the session mission id.
    const rec = { ...s, mission_id: openSession.missionId };
    mission.lastSeen = Date.now();
    rawStore.enqueue("telemetry", {
      mission_id: rec.mission_id,
      ts: rec.ts,
      json: JSON.stringify(rec),
    });
    broadcast({ kind: "tick", ...rec });
    worker.postMessage({ type: "sample", sample: rec });
  });
  ws.on("close", () => {
    // Twin drops hold the mission open.
    // Session owns the mission end.
    console.log("[ingest] twin disconnected (session owns mission end)");
  });
}

let ingestWss = null;
if (C.SINGLE_PORT) {
  ingestWss = new WebSocketServer({ server, path: "/ingest" });
  ingestWss.on("connection", handleIngestConnection);
  console.log("[ingest] single-port mode: ws /ingest on same $PORT");
} else {
  ingestWss = new WebSocketServer({ port: C.INGEST_PORT });
  ingestWss.on("connection", handleIngestConnection);
}

// REST handlers.
async function handleHttp(req, res) {
  const url = new URL(req.url, "http://x");
  const json = (o, c = 200) => {
    res.writeHead(c, {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
    });
    res.end(JSON.stringify(o));
  };
  try {
    // Answers CORS preflight for JSON posts.
    // Missing headers block browser controls.
    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization, x-api-key",
        "Access-Control-Max-Age": "86400",
      });
      res.end();
      return;
    }
    // Public routes.
    if (url.pathname === "/health")
      return json({
        raw: rawStore.status(),
        events: eventsStore.status(),
        mission: mission?.id ?? null,
        workerThresholds,
        session: openSession ? { id: openSession.id, name: openSession.name,
                                 engineId: openSession.engineId } : null,
        pendingReplay: [...pendingReplay],
      });
    if (url.pathname === "/api/auth/login" && req.method === "POST") {
      const b = await readBody(req);
      const t = auth.login(b.username, b.password);
      if (!t) return json({ error: "invalid credentials" }, 401);
      return json({ token: t, username: b.username, expiresMs: auth.ACCESS_MS });
    }
    if (url.pathname === "/api/auth/refresh" && req.method === "POST") {
      const b = await readBody(req);
      const t = auth.refresh(b.token);
      if (!t) return json({ error: "refresh denied" }, 401);
      return json({ token: t, expiresMs: auth.ACCESS_MS });
    }
    // Tab close beacon ends the mission.
    // Token arrives in query string.
    if (url.pathname === "/api/session/abort") {
      const t = url.searchParams.get("token");
      if (t && auth.verify(t)) {
        if (openSession) closePilotSession("client closed");
        twinFire("POST", "/engine/stop", {});
      }
      return json({ status: "ok" });
    }
    // Routes under this line need a token.
    if (
      (url.pathname.startsWith("/api/") ||
        url.pathname.startsWith("/admin/")) &&
      !needKey(req, res)
    )
      return;
    // Session control.
    if (url.pathname === "/api/session/start" && req.method === "POST") {
      const b = await readBody(req);
      const out = openPilotSession(b);
      return json(out, out.error ? 409 : 200);
    }
    if (url.pathname === "/api/session/end" && req.method === "POST") {
      const out = closePilotSession("pilot end");
      return json(out, out.error ? 409 : 200);
    }
    if (url.pathname === "/api/session/current")
      return json({
        session: openSession
          ? { id: openSession.id, name: openSession.name,
              engineId: openSession.engineId, missionId: openSession.missionId }
          : null,
      });
    if (url.pathname === "/api/sessions")
      return json(
        rawStore.db
          .prepare(
            "SELECT id,name,engine_id,pilot,started_at,ended_at,status,mission_id " +
              "FROM sessions ORDER BY started_at DESC",
          )
          .all(),
      );
    if (url.pathname === "/api/engines") {
      const ids = rawStore.db
        .prepare("SELECT DISTINCT engine_id FROM sessions ORDER BY engine_id")
        .all()
        .map((r) => r.engine_id);
      const hrs = {};
      try {
        for (const r of eventsStore.db
          .prepare("SELECT engine_id, consumed_h FROM life_state")
          .all())
          hrs[r.engine_id] = r.consumed_h;
      } catch {}
      // Remaining life hours with 2000 hour floor.
      return json(ids.map((id) => ({
        id, hours: hrs[id] ?? 0, rul: Math.max(0, 2000 - (hrs[id] ?? 0)),
      })));
    }
    if (url.pathname === "/admin/db/down") {
      eventsStore.simulateDown(true);
      return json({ events: "forced DOWN (spilling to disk)" });
    }
    if (url.pathname === "/admin/db/up") {
      eventsStore.simulateDown(false);
      return json({ events: "restored" });
    }
    if (url.pathname === "/api/admin/clear" && req.method === "POST") {
      // Clears both databases and engine wear ledgers.
      // Running mission restarts on the next sample.
      endMission("db cleared");
      rawStore.db.exec(
        "DELETE FROM mission_replay; DELETE FROM telemetry; DELETE FROM missions; DELETE FROM sessions; VACUUM;",
      );
      eventsStore.db.exec(
        "DELETE FROM fault_events; DELETE FROM trend_log; DELETE FROM rul_log; DELETE FROM life_state; VACUUM;",
      );
      pendingReplay.clear();
      // Resets worker life and ring state at once.
      // Next sample starts from zero.
      worker.postMessage({ type: "life", engineId: CUR_ENGINE, c: 0 });
      if (mission) worker.postMessage({ type: "mission", id: mission.id });
      // Clears twin wear ledgers.
      twinFire("POST", "/engine/reset_all", {});
      return json({ status: "cleared" });
    }
    if (url.pathname === "/api/engine/reset" && req.method === "POST") {
      // Resets the active engine wear profile.
      // Missions and replays stay intact.
      const body = await readBody(req);
      const eid = body.engineId || CUR_ENGINE;
      try {
        eventsStore.db.prepare("DELETE FROM life_state WHERE engine_id=?").run(eid);
        worker.postMessage({ type: "life", engineId: eid, c: 0 });
      } catch {}
      return proxyJson(res, "POST", "/engine/reset", {});
    }
    // Reports twin confirmed fault state.
    // Separates link faults from model misses.
    if (url.pathname === "/api/faults" && req.method === "GET") {
      return proxyJson(res, "GET", "/engine/faults", null);
    }
    if (url.pathname === "/api/missions")
      return json(
        rawStore.db
          .prepare("SELECT * FROM missions ORDER BY started_at DESC")
          .all(),
      );
    // Twin controls proxied to the engine.
    if (
      req.method === "POST" &&
      ["/api/start", "/api/stop", "/api/controls", "/api/env",
       "/api/fault", "/api/faults/clear", "/api/switch"].includes(url.pathname)
    ) {
      const body = await readBody(req);
      const twinPath = {
        "/api/start": "/engine/start",
        "/api/stop": "/engine/stop",
        "/api/controls": "/engine/set_controls",
        "/api/env": "/engine/set_env",
        "/api/fault": "/engine/fault",
        "/api/faults/clear": "/engine/faults/clear",
        "/api/switch": "/engine/switch",
      }[url.pathname];
      return proxyJson(res, "POST", twinPath, body);
    }
    // Resolves missions by id or name.
    // Panels address missions by name.
    const resolveMission = (key) => {
      const direct = rawStore.db
        .prepare("SELECT 1 AS ok FROM mission_replay WHERE mission_id=? LIMIT 1")
        .get(key);
      if (direct) return key;
      const s = rawStore.db
        .prepare("SELECT mission_id FROM sessions WHERE name=? COLLATE NOCASE LIMIT 1")
        .get(String(key));
      return s ? s.mission_id : key;
    };
    let m = url.pathname.match(/^\/api\/replay\/([^/]+)$/);
    if (m && req.method === "GET") {
      const id = resolveMission(decodeURIComponent(m[1]));
      const rows = rawStore.db
        .prepare(
          "SELECT ts,json,anomaly_flag,fault_flag,fault_code,fault_codes,fault_name,severity,action,prob FROM mission_replay WHERE mission_id=? ORDER BY ts",
        )
        .all(id);
      return json(
        rows.map((r) => ({
          ...r,
          telemetry: JSON.parse(r.json),
          json: undefined,
        })),
      );
    }
    m = url.pathname.match(/^\/api\/replay\/([^/]+)\/faults$/);
    if (m) {
      const id = resolveMission(decodeURIComponent(m[1]));
      return json(
        eventsStore.db
          .prepare(
            "SELECT * FROM fault_events WHERE mission_id=? AND fault_code>0 ORDER BY ts",
          )
          .all(id),
      );
    }
    // Deletes one mission and its event logs.
    // Refuses the live mission.
    m = url.pathname.match(/^\/api\/replay\/([^/]+)$/);
    if (m && req.method === "DELETE") {
      const id = resolveMission(decodeURIComponent(m[1]));
      if ((openSession && openSession.missionId === id) ||
          (mission && mission.id === id))
        return json({ error: "mission is live - end it first" }, 409);
      const exists = rawStore.db
        .prepare("SELECT 1 AS ok FROM sessions WHERE mission_id=? LIMIT 1")
        .get(id);
      if (!exists) return json({ error: "unknown mission" }, 404);
      rawStore.db.prepare("DELETE FROM mission_replay WHERE mission_id=?").run(id);
      rawStore.db.prepare("DELETE FROM telemetry WHERE mission_id=?").run(id);
      rawStore.db.prepare("DELETE FROM missions WHERE id=?").run(id);
      rawStore.db.prepare("DELETE FROM sessions WHERE mission_id=?").run(id);
      eventsStore.db.prepare("DELETE FROM fault_events WHERE mission_id=?").run(id);
      eventsStore.db.prepare("DELETE FROM trend_log WHERE mission_id=?").run(id);
      eventsStore.db.prepare("DELETE FROM rul_log WHERE mission_id=?").run(id);
      pendingReplay.delete(id);
      return json({ status: "deleted", missionId: id });
    }
    json({ error: "not found" }, 404);
  } catch (e) {
    json({ error: e.message }, 500);
  }
}
server.listen(C.HTTP_PORT, () =>
  console.log(
    C.SINGLE_PORT
      ? `[http/ws] single-port :${C.HTTP_PORT} (frontend ws / + ingest ws /ingest)`
      : `[http/ws] frontend on :${C.HTTP_PORT}, twin ingest on :${C.INGEST_PORT}`,
  ),
);

process.on("SIGINT", () => {
  endMission("shutdown");
  rawStore.close();
  eventsStore.close();
  process.exit(0);
});
