const path = require("path");
const ROOT = path.resolve(__dirname, "..");
// Render (and most PaaS) expose a single public $PORT.
// Local dev keeps two ports: ingest :8080 + frontend :8081.
// When $PORT is set and INGEST_PORT/HTTP_PORT are unset, both share $PORT
// (frontend WS on `/`, twin ingest WS on `/ingest`).
const PLATFORM_PORT = +process.env.PORT || 0;
const _http = +process.env.HTTP_PORT || PLATFORM_PORT || 8081;
const _ingest = +process.env.INGEST_PORT ||
  (process.env.PORT ? _http : 8080);
module.exports = {
  ROOT,
  INGEST_PORT: _ingest,
  HTTP_PORT: _http,
  SINGLE_PORT: _ingest === _http,
  TICK_HZ: 10,
  RING_SECONDS: 180, // 3 minute buffer
  ROLL_N: 5, // training window of 5 steps, 0.5 s
  FAST_MS: 1000, // 1 second cadence
  SLOW_MS: 5000, // trend step, 5 seconds
  TREND_WINDOW_MS: 60000, // 1 minute trend window
  RUL_MS: 10000, // RUL step, 10 seconds
  RUL_WINDOW_MS: 180000, // 3 minute RUL window
  RUL_SMOOTH: 18, // median over 18 outputs, 3 minutes
  MISSION_IDLE_MS: 30000, // 30 second idle grace, stop flag ends at once
  GATE_ON_ANOMALY: false, // classifiers run each tick independent of anomaly gate
  paths: {
    data: path.join(ROOT, "data"),
    models: path.join(ROOT, "models"),
    config: path.join(ROOT, "config"),
    proto: path.join(ROOT, "proto", "telemetry.proto"),
    rawDb: path.join(ROOT, "data", "raw_telemetry.db"),
    eventsDb: path.join(ROOT, "data", "events.db"),
    spillDir: path.join(ROOT, "data", "spill"),
  },
};
