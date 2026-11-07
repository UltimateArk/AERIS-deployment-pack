// Builds replay rows from telemetry and fault events.
// A prediction at time T covers samples in (T-1000ms, T].
// Uses an indexed SQL pass plus a chunked sweep for fault codes.
const C = require("../config");

const CHUNK = 2000;
const tick = () => new Promise((r) => setImmediate(r));

function ready(rawStore, eventsStore) {
  rawStore.flush();
  eventsStore.flush();
  return (
    rawStore.status().healthy &&
    eventsStore.status().healthy &&
    !rawStore.spillPending() &&
    !eventsStore.spillPending()
  );
}

async function build(missionId, rawStore, eventsStore) {
  const db = rawStore.db;
  db.prepare("ATTACH DATABASE ? AS ev").run(C.paths.eventsDb);
  try {
    // Inserts flags and top fault per frame.
    db.transaction(() => {
      db.prepare("DELETE FROM mission_replay WHERE mission_id=?").run(
        missionId,
      );
      db.prepare(
        `
        INSERT INTO mission_replay(mission_id,ts,json,anomaly_flag,fault_flag,fault_code,fault_name,severity,action,prob)
        SELECT t.mission_id, t.ts, t.json,
               COALESCE(MAX(e.anomaly),0),
               CASE WHEN COALESCE(MAX(e.fault_code),0)>0 THEN 1 ELSE 0 END,
               COALESCE(MAX(e.fault_code),0), MAX(e.fault_name), MAX(e.severity), MAX(e.action), MAX(e.calibrated)
        FROM telemetry t
        LEFT JOIN ev.fault_events e
          ON e.mission_id=t.mission_id AND t.ts > e.ts-1000 AND t.ts <= e.ts
        WHERE t.mission_id=?
        GROUP BY t.mission_id, t.ts`,
      ).run(missionId);
    })();
    // Fault events load into memory at around 1 Hz.
    const evs = db
      .prepare(
        "SELECT ts, fault_code FROM ev.fault_events WHERE mission_id=? AND fault_code>0 ORDER BY ts",
      )
      .all(missionId);
    const rows = db
      .prepare(
        "SELECT ts FROM mission_replay WHERE mission_id=? ORDER BY ts",
      )
      .all(missionId)
      .map((r) => r.ts);
    // Adds distinct fault codes per row in chunks.
    const upd = db.prepare(
      "UPDATE mission_replay SET fault_codes=? WHERE mission_id=? AND ts=?",
    );
    let lo = 0;
    const tx = db.transaction((batch) => {
      for (const [ts, codes] of batch) upd.run(codes, missionId, ts);
    });
    let batch = [];
    const flush = async () => {
      if (batch.length) tx(batch);
      batch = [];
      await tick();
    };
    for (const ts of rows) {
      while (lo < evs.length && evs[lo].ts <= ts - 1000) lo++;
      const set = new Set();
      for (let i = lo; i < evs.length && evs[i].ts <= ts; i++)
        set.add(evs[i].fault_code);
      if (set.size)
        batch.push([ts, [...set].sort((a, b) => a - b).join(",")]);
      if (batch.length >= CHUNK) {
        await flush();
      }
    }
    await flush();
    db.prepare("UPDATE missions SET replay_built=1 WHERE id=?").run(
      missionId,
    );
  } finally {
    db.prepare("DETACH DATABASE ev").run();
  }
  const n = db
    .prepare(
      "SELECT COUNT(*) c, SUM(fault_flag) f FROM mission_replay WHERE mission_id=?",
    )
    .get(missionId);
  console.log(
    `[replay] mission ${missionId}: ${n.c} frames, ${n.f || 0} flagged as fault`,
  );
}
module.exports = { ready, build };
