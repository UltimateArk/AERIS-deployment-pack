// Raw store holds telemetry, missions, and replay rows.
// Event store holds fault events, trend log, and RUL log.
// Schemas create tables on first open.
const path = require("path");
const C = require("../config");
const Store = require("./store");

const rawSchema = `
CREATE TABLE IF NOT EXISTS missions(
  id TEXT PRIMARY KEY, started_at INTEGER, ended_at INTEGER,
  status TEXT DEFAULT 'RUNNING', replay_built INTEGER DEFAULT 0);
CREATE TABLE IF NOT EXISTS sessions(
  id TEXT PRIMARY KEY, name TEXT, engine_id TEXT, pilot TEXT,
  started_at INTEGER, ended_at INTEGER, status TEXT DEFAULT 'OPEN',
  mission_id TEXT);
CREATE TABLE IF NOT EXISTS telemetry(
  mission_id TEXT NOT NULL, ts INTEGER NOT NULL, json TEXT NOT NULL,
  PRIMARY KEY(mission_id, ts)) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS mission_replay(
  mission_id TEXT NOT NULL, ts INTEGER NOT NULL, json TEXT NOT NULL,
  anomaly_flag INTEGER DEFAULT 0, fault_flag INTEGER DEFAULT 0,
  fault_code INTEGER DEFAULT 0, fault_name TEXT, severity TEXT, action TEXT, prob REAL,
  fault_codes TEXT,
  PRIMARY KEY(mission_id, ts)) WITHOUT ROWID;`;
const rawStmts = {
  telemetry:
    "INSERT OR IGNORE INTO telemetry(mission_id,ts,json) VALUES(@mission_id,@ts,@json)",
  missionStart:
    "INSERT OR IGNORE INTO missions(id,started_at) VALUES(@id,@started_at)",
  missionEnd:
    "UPDATE missions SET ended_at=@ended_at, status='ENDED' WHERE id=@id",
};

const evSchema = `
CREATE TABLE IF NOT EXISTS fault_events(
  mission_id TEXT NOT NULL, ts INTEGER NOT NULL,
  anomaly INTEGER, anomaly_score REAL, anomaly_feature TEXT,
  fault_code INTEGER DEFAULT 0, fault_name TEXT, severity TEXT, action TEXT,
  prob REAL, calibrated REAL, cylinder INTEGER, details TEXT,
  PRIMARY KEY(mission_id, ts, fault_code)) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS trend_log(
  mission_id TEXT NOT NULL, ts INTEGER NOT NULL, json TEXT, PRIMARY KEY(mission_id, ts)) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS rul_log(
  mission_id TEXT NOT NULL, ts INTEGER NOT NULL, rul REAL, rul_smoothed REAL,
  PRIMARY KEY(mission_id, ts)) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS life_state(
  engine_id TEXT PRIMARY KEY, consumed_h REAL, updated_at INTEGER)`;
const evStmts = {
  fault: `INSERT OR IGNORE INTO fault_events VALUES(@mission_id,@ts,@anomaly,@anomaly_score,@anomaly_feature,
    @fault_code,@fault_name,@severity,@action,@prob,@calibrated,@cylinder,@details)`,
  trend: "INSERT OR IGNORE INTO trend_log VALUES(@mission_id,@ts,@json)",
  rul: "INSERT OR IGNORE INTO rul_log VALUES(@mission_id,@ts,@rul,@rul_smoothed)",
};

function create(onRecover) {
  const rawStore = new Store({
    name: "raw",
    file: C.paths.rawDb,
    schema: rawSchema,
    statements: rawStmts,
    spillFile: path.join(C.paths.spillDir, "raw.wal.ndjson"),
    onRecover,
  });
  const eventsStore = new Store({
    name: "events",
    file: C.paths.eventsDb,
    schema: evSchema,
    statements: evStmts,
    spillFile: path.join(C.paths.spillDir, "events.wal.ndjson"),
    onRecover,
  });
  // Adds missing columns to existing tables.
  for (const sql of [
    "ALTER TABLE missions ADD COLUMN session_id TEXT",
    "ALTER TABLE missions ADD COLUMN engine_id TEXT",
  ]) {
    try { rawStore.db.exec(sql); } catch {}
  }
  return { rawStore, eventsStore };
}
module.exports = { create };
