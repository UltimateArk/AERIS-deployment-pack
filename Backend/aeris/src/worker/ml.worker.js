// Owns the ring buffer and ONNX sessions inside a worker thread.
const { parentPort } = require("worker_threads");
const fs = require("fs");
const path = require("path");
const ort = require("onnxruntime-node");
const C = require("../config");
const RingBuffer = require("./ringBuffer");
const F = require("./features");

const cfg = (n) =>
  JSON.parse(fs.readFileSync(path.join(C.paths.config, n), "utf8"));
const catalog = cfg("fault_catalog.json");
const calib = cfg("calibrators.json");
const scaler = cfg("scaler_anomaly.json");
const anom = cfg("threshold_anomaly.json");
const trendCfg = cfg("trend_config.json");

const ring = new RingBuffer(C.RING_SECONDS * C.TICK_HZ, F.COLS.length);
const clfs = {}; // faultCode -> InferenceSession
let rulSession = null;
let ready = false;
let missionId = null;
let nextFast = 0,
  nextSlow = 0,
  nextRul = 0;
let busyFast = false,
  busyRul = false;
const fastStat = { n: 0, sum: 0, max: 0 };
const rulHist = [];
const trendState = {
  cht: { dir: 0, n: 0 },
  oilT: { dir: 0, n: 0 },
  egt: { dir: 0, n: 0 },
};

// Life model computes RUL from consumed hours and burn rate.
// Consumed hours persist across missions per engine.
const LIFE_L0 = 2000; // hours, service life floor
// Burn multipliers per fault code, scaled by magnitude.
const BURN_A = {
  1: 8,   // misfire (mid)
  2: 6,   // injector clog
  3: 10,  // fuel pump
  4: 30,  // oil low (severe)
  5: 12,  // bearing wear
  6: 15,  // low compression
  7: 25,  // cooling fail (severe)
  8: 25,  // overheat (severe)
  9: 40,  // knock (highest)
  10: 2,  // injection timing (minor)
  11: 6,  // back pressure
  12: 15, // alt fail
  13: 2,  // sensor drift (minor)
  14: 8,  // egt imbalance
};
let lifeC = 0; // consumed hours for active engine
let lastLifeTs = 0;
let lastBurnMult = 1; // burn multiplier at latest sample
let missionStartMs = 0; // mission start time, ms
let curEngine = "ENG-01";
let lastCodes = [];

// Duty term ranges 0.6 at loiter to 1.3 at max.
function dutyRate(rpm, load) {
  const rn = Math.max(0, Math.min(1.25, (rpm ?? 0) / 5800)); // 5800 is rated rpm
  const ln = Math.max(0, Math.min(1.2, (load ?? 50) / 100));
  return 0.3 + 0.5 * rn + 0.35 * ln;
}
function burnMult(sample) {
  let m = 1;
  const codes = (sample?.faultCodes ?? []).filter((c) => c > 0);
  for (const c of codes) {
    const raw = sample?.faultMag?.[String(c)];
    const mag = Number.isFinite(raw) ? Math.max(0, Math.min(1, raw)) : 0.9;
    m *= 1 + (BURN_A[c] ?? 2) * mag;
  }
  // Clamps stacked faults to 1000x.
  return Math.min(m, 1000);
}

async function init() {
  const opts = { executionProviders: ["cpu"], graphOptimizationLevel: "all" };
  // Checks calibrator shape.
  if (
    !Array.isArray(calib.thresholds) ||
    calib.thresholds.length !== 14 ||
    !Array.isArray(calib.bins) ||
    calib.bins.length !== 14
  )
    throw new Error(
      `[worker] calibrators.json must have 14 thresholds + 14 bins, got ${calib.thresholds?.length}/${calib.bins?.length}`,
    );
  if (F.FEATURES.length !== 111)
    throw new Error(
      `[worker] feature_list.json must be 111, got ${F.FEATURES.length}`,
    );
  for (let code = 1; code <= 14; code++) {
    const f = path.join(C.paths.models, `clf_f${code}.onnx`);
    if (!fs.existsSync(f)) {
      console.warn(
        `[worker] no model for fault ${code} (${catalog[code]?.name?.split(" ")[0] ?? "unknown"}) -> skipped`,
      );
      continue;
    }
    try {
      const s = await ort.InferenceSession.create(f, opts);
      // Checks model input and output names.
      if (!s.inputNames.includes("input") || !s.outputNames.includes("probabilities"))
        throw new Error(`unexpected IO: in=${s.inputNames} out=${s.outputNames}`);
      clfs[code] = s;
    } catch (e) {
      console.error(`[worker] failed to load clf_f${code}.onnx:`, e.message);
    }
  }
  rulSession = null;
  try {
    rulSession = await ort.InferenceSession.create(
      path.join(C.paths.models, "rul.onnx"),
      opts,
    );
  } catch (e) {
    console.error("[worker] failed to load rul.onnx (analytic RUL fallback):", e.message);
  }
  ready = true;
  parentPort.postMessage({
    kind: "ready",
    classifiers: Object.keys(clfs).map(Number),
    // Reports live thresholds for health checks.
    thresholds: calib.thresholds,
  });
}

// Anomaly score is max absolute z score.
function anomaly() {
  let best = 0,
    name = null;
  anom.features.forEach((f, i) => {
    const z = Math.abs(
      (ring.get(F.IDX[f], 0) - scaler.mean[i]) / scaler.scale[i],
    );
    if (z > best) {
      best = z;
      name = f;
    }
  });
  return { flag: best > anom.threshold, score: best, feature: name };
}

// Maps raw probability to calibrated rate via bins.
function calibrate(code, p) {
  const b = calib.bins[code - 1];
  if (!b || !Array.isArray(b.rates) || !b.rates.length) return p; // fallback: use raw p if bin missing
  const nb = b.rates.length;
  const pc = Math.min(1, Math.max(0, p));
  const i = Math.min(nb - 1, Math.max(0, Math.floor(pc * nb)));
  return b.rates[i];
}

async function runFast(ts) {
  const t0 = Date.now();
  const x = F.buildVector(ring);
  const a = anomaly();
  const cands = [];
  if (!C.GATE_ON_ANOMALY || a.flag) {
    const input = new ort.Tensor("float32", x, [1, x.length]);
    await Promise.all(
      Object.entries(clfs).map(async ([code, s]) => {
        try {
          const out = await s.run({ input });
          if (!out.probabilities) return;
          const p = out.probabilities.data[1];
          // Decides on raw probability.
          // Calibrated values adjust display only.
          if (p >= calib.thresholds[code - 1])
            cands.push({ code: +code, p, calibrated: calibrate(+code, p) });
        } catch (e) {
          console.error(`[fast] clf_f${code} infer failed:`, e.message);
        }
      }),
    );
  }
  cands.sort((u, v) => v.calibrated - u.calibrated || v.p - u.p);
  // Logs raw scores for injected faults at 1 Hz.
  if (lastCodes.length) {
    const byCode = Object.fromEntries(cands.map((c) => [c.code, c.p]));
    console.log(
      `[fast] injected [${lastCodes.join(",")}] ` +
        lastCodes.map((c) =>
          `f${c} raw ${(byCode[c] ?? 0).toFixed(3)} ${((byCode[c] ?? 0) >= calib.thresholds[c - 1] ? ">=" : "<")} thr ${calib.thresholds[c - 1]}`,
        ).join(" "),
    );
  }
  // Enriches each candidate for multi fault storage.
  const enrich = (t) => {
    const c = catalog[t.code] || {};
    const e = {
      ...t,
      name: c.name ?? null,
      severity: c.severity ?? null,
      action: c.action_priority ?? null,
      description: c.description ?? null,
      cause: c.likely_cause ?? null,
      rectification: c.rectification ?? null,
      subsystem: c.subsystem ?? null,
    };
    if (t.code === 1 || t.code === 2) {
      // Cylinder with largest EGT deviation.
      let k = 1,
        m = 0;
      for (let i = 1; i <= 4; i++) {
        const d = Math.abs(ring.get(F.IDX[`egt${i}_d`], 0));
        if (d > m) {
          m = d;
          k = i;
        }
      }
      e.cylinder = k;
    }
    return e;
  };
  const enriched = cands.map(enrich);
  const fault = enriched.length ? enriched[0] : null;
  // Logs inference timing every 30 runs.
  const dt = Date.now() - t0;
  fastStat.n++; fastStat.sum += dt; fastStat.max = Math.max(fastStat.max, dt);
  if (fastStat.n >= 30) {
    console.log(`[fast] infer avg ${(fastStat.sum / fastStat.n).toFixed(1)}ms max ${fastStat.max.toFixed(0)}ms over ${fastStat.n} runs`);
    fastStat.n = 0; fastStat.sum = 0; fastStat.max = 0;
  }
  parentPort.postMessage({
    kind: "fast",
    ts,
    missionId,
    anomaly: a,
    fault,
    candidates: enriched,
  });
}

function trend(ts) {
  // Mean rate over the trailing trend window.
  const n = Math.round((C.TREND_WINDOW_MS / 1000) * C.TICK_HZ);
  const spec = [
    ["cht", "cht", trendCfg.cht_roc_rising, 250, 8], // limit 250, code 8
    ["oilT", "oilTemp", trendCfg.oilT_roc_rising, 120, 4], // limit 120, code 4
    ["egt", "egt", trendCfg.egt_roc_rising, 800, 8], // limit 800, code 8
  ];
  const res = {};
  const prognosis = [];
  for (const [key, col, thr, limit, progCode] of spec) {
    const roc = F.meanRoc(ring, col, n);
    const cur = ring.get(F.IDX[col], 0);
    const dir = roc > thr ? 1 : roc < -thr ? -1 : 0;
    const st = trendState[key];
    if (dir === st.dir) st.n++;
    else {
      st.dir = dir;
      st.n = 1;
    }
    const sustained = dir !== 0 && st.n >= 5; // 5 consecutive ticks
    res[key] = {
      roc,
      status: sustained ? (dir > 0 ? "RISING" : "FALLING") : "STABLE",
    };
    // Prognosis needs a full window and sustained rise.
    // Runs after 15 seconds of mission time.
    const windowFull = ring.size > 0 && (ring.size - 1) >= n;
    if (
      missionStartMs > 0 && ts - missionStartMs > 15000 &&
      windowFull &&
      res[key].status === "RISING" &&
      roc > 0 && cur < limit
    ) {
      const ttf = (limit - cur) / (roc * C.TICK_HZ); // seconds      if (ttf > 0 && ttf < 600)
        prognosis.push({ key, code: progCode, ttfSec: Math.round(ttf), limit, cur: Math.round(cur) });
    }
  }
  parentPort.postMessage({ kind: "trend", ts, missionId, trend: res, prognosis });
}

async function runRul(ts) {
  // Analytic life model sets displayed RUL.
  // ONNX output stays for comparison (null when model missing/invalid).
  const n = Math.round((C.RUL_WINDOW_MS / 1000) * C.TICK_HZ);
  const x = F.buildWindowVector(ring, n, 30); // every 30 ticks, 3 s
  let v = null;
  if (rulSession) {
    try {
      const out = await rulSession.run({
        input: new ort.Tensor("float32", x, [1, x.length]),
      });
      v = out.variable.data[0];
    } catch (e) {
      console.error("[worker] rul inference failed (analytic fallback):", e.message);
    }
  }
  const rpm = ring.get(F.IDX.rpm, 0);
  const load = ring.get(F.IDX.load_cmd, 0);
  const rNow = dutyRate(rpm, load);
  let rulNow = Math.max(0, (LIFE_L0 - lifeC) / Math.max(0.35, rNow));
  rulHist.push(rulNow);
  if (rulHist.length > C.RUL_SMOOTH) rulHist.shift();
  const s = [...rulHist].sort((p, q) => p - q);
  parentPort.postMessage({
    kind: "rul",
    ts,
    missionId,
    rul: rulNow,
    rulSmoothed: s[Math.floor(s.length / 2)],
    engineId: curEngine,
    burn: rNow * lastBurnMult, // true burn with fault multipliers
    consumed: lifeC, // consumed hours for this engine
    rulModel: v, // ONNX output for comparison
  });
}

function onSample(sample) {
  const ts = sample.ts;
  if (sample.engineId) curEngine = sample.engineId;
  lastCodes = (sample?.faultCodes ?? []).filter((c) => c > 0);
  // Integrates burn rate each tick from fault codes and magnitudes.
  if (lastLifeTs > 0) {
    const dtH = (ts - lastLifeTs) / 3.6e6; // ms to hours
    // Caps steps to 10 Hz equivalents.
    // Ignores clock jumps and duplicates.
    const step = dtH > 0 ? Math.min(dtH, 0.1 / 3600 * 40) : 0;
    if (step > 0) {
      lastBurnMult = burnMult(sample);
      lifeC += dutyRate(sample.rpm, sample.load_cmd ?? 50) * lastBurnMult * step;
    }
  }
  lastLifeTs = ts;
  ring.push(ts, F.toRow(sample));
  if (!nextFast) {
    nextFast = ts + C.FAST_MS;
    nextSlow = ts + C.SLOW_MS;
    nextRul = ts + C.RUL_MS;
  }
  if (ts >= nextFast && !busyFast) {
    nextFast = ts + C.FAST_MS;
    busyFast = true;
    runFast(ts)
      .catch((e) => console.error("[fast]", e))
      .finally(() => (busyFast = false));
  }
  if (ts >= nextSlow) {
    nextSlow = ts + C.SLOW_MS;
    try {
      trend(ts);
    } catch (e) {
      console.error("[trend]", e);
    }
  }
  if (ts >= nextRul && !busyRul) {
    nextRul = ts + C.RUL_MS;
    busyRul = true;
    runRul(ts)
      .catch((e) => console.error("[rul]", e))
      .finally(() => (busyRul = false));
  }
}

parentPort.on("message", (m) => {
  // Mission messages apply during init as well.
  // Skipped init messages drop all outputs.
  if (m.type === "mission") {
    missionId = m.id;
    missionStartMs = Date.now();
    ring.clear();
    F.resetLag();
    rulHist.length = 0;
    nextFast = nextSlow = nextRul = 0;
    lastLifeTs = 0;
    for (const k in trendState) trendState[k] = { dir: 0, n: 0 };
    // Consumed life spans missions and stays across resets.
    return;
  }
  if (m.type === "life") {
    // Accepts ledger restores for the active engine only.
    if (m.engineId) curEngine = m.engineId;
    lifeC = Number(m.c) || 0;
    return;
  }
  if (!ready) return;
  if (m.type === "sample") onSample(m.sample);
});

init().catch((e) => {
  console.error("[worker] init failed", e);
  process.exit(1);
});
