// Builds the 111 feature vector in list order from the ring buffer.
const { ROLL_N } = require("../config");
const FEATURES = require("../../config/feature_list.json").features;

const BASE = FEATURES.slice(0, 28); // raw channels 0 to 27
// Maps each residual to its source channel.
const RES_MAP = {
  cht_r: "cht",
  egt1_r: "egt1",
  egt2_r: "egt2",
  egt3_r: "egt3",
  egt4_r: "egt4",
  map_r: "map",
  oilP_r: "oilPressure",
  oilT_r: "oilTemp",
  vib_r: "vibRMS",
  altA_r: "altA",
  battV_r: "battV",
  injT_r: "injTiming",
  spread_r: "egtSpread",
};
const D_COLS = ["egt1_d", "egt2_d", "egt3_d", "egt4_d"]; // each cylinder EGT minus mean EGT
const COLS = [...BASE, ...Object.keys(RES_MAP), ...D_COLS];
const IDX = Object.fromEntries(COLS.map((c, i) => [c, i]));

const SPEC = FEATURES.map((name) => {
  if (name in IDX) return { col: IDX[name], kind: "cur" };
  if (name.endsWith("_roll") && name.slice(0, -5) in IDX)
    return { col: IDX[name.slice(0, -5)], kind: "roll" };
  if (name.endsWith("_roc") && name.slice(0, -4) in IDX)
    return { col: IDX[name.slice(0, -4)], kind: "roc" };
  throw new Error("Unresolved feature: " + name);
});

// Nominal targets from closed form physics formulas.
// Reference point is standard mixture and fresh wear.
function nominal(s) {
  const dens = Math.min(1.05, Math.max(0.55,
    (s.ambientP / 101.3) * Math.sqrt(288.15 / (273.15 + s.ambientT))));
  const lp = Math.min(100, Math.max(0, (s.fuelFlow / 5) * 100));
  const t = {
    cht: 90 + (s.ambientT - 15) * 1.2 + 22 * s.fuelFlow + 0.015 * s.rpm
           + 0.35 * lp * (1 - dens * 0.2) - 18,
    egt: 320 + (s.ambientT - 15) * 1.5 + 60 * s.fuelFlow + 0.012 * s.rpm - 8,
    map: s.ambientP / 101.3 + (0.35 * s.rpm) / 10000
         + (0.08 * s.fuelFlow) / 5 + 0.1 * (1 - dens),
    oilP: 3.6 + 0.00012 * s.rpm - 0.008 * lp,
    oilT: 42 + 0.006 * s.rpm + 0.38 * lp + 3.2 * s.fuelFlow - 12
          + (s.ambientT - 15) * 0.4,
    vib: 0.018 + 0.000012 * s.rpm + 0.0006 * lp + 0.004 * s.fuelFlow,
    alt: 10 + 0.001 * s.rpm - 0.05 * lp,
    inj: 20,
  };
  t.batt = 24 + 4 * (t.alt / 10) - 0.01 * lp;
  return t;
}

// Lowpass state for nominal targets at 10 Hz.
// Cleared at each mission start.
const TAU = { cht: 1.8, egt: 1.2, map: 0.15, oilP: 0.7, oilT: 6.0,
              vib: 0.25, alt: 0.5, batt: 0.5, inj: 0.1 };
const lag = {};
function resetLag() {
  for (const k in lag) delete lag[k];
}
function lagged(key, target) {
  const a = 0.1 / (TAU[key] + 0.1);
  lag[key] = key in lag ? lag[key] + a * (target - lag[key]) : target;
  return lag[key];
}

function toRow(s) {
  const row = new Float64Array(COLS.length);
  BASE.forEach((n, i) => (row[i] = +s[n] || 0));
  // Residuals use local nominal values with physics lag.
  // Twin sent values stay unused.
  const t = nominal(s);
  const e = {};
  for (const k of Object.keys(TAU)) e[k] = lagged(k, t[k]);
  const R = {
    cht_r: s.cht - e.cht,
    egt1_r: s.egt1 - e.egt, egt2_r: s.egt2 - e.egt,
    egt3_r: s.egt3 - e.egt, egt4_r: s.egt4 - e.egt,
    map_r: s.map - e.map,
    oilP_r: s.oilPressure - e.oilP,
    oilT_r: s.oilTemp - e.oilT,
    vib_r: s.vibRMS - e.vib,
    altA_r: s.altA - e.alt,
    battV_r: s.battV - e.batt,
    injT_r: s.injTiming - e.inj,
    spread_r: s.egtSpread,
  };
  for (const [r, v] of Object.entries(R)) row[IDX[r]] = v;
  const m = (R.egt1_r + R.egt2_r + R.egt3_r + R.egt4_r) / 4;
  D_COLS.forEach((d, i) => (row[IDX[d]] = R[`egt${i + 1}_r`] - m));
  return row;
}

// Feature vector at a given tick offset.
// Short history reads as clamped edge values.
function buildVectorAt(ring, back) {
  const x = new Float32Array(SPEC.length);
  for (let i = 0; i < SPEC.length; i++) {
    const { col, kind } = SPEC[i];
    if (kind === "cur") x[i] = ring.get(col, back);
    else if (kind === "roll") {
      let s = 0;
      for (let k = 0; k < ROLL_N; k++) s += ring.get(col, back + k);
      x[i] = s / ROLL_N;
    } else x[i] = ring.get(col, back) - ring.get(col, back + 1); // per-tick ROC
  }
  return x;
}

// Mean vector sampled every step ticks over the trailing window.
function buildWindowVector(ring, windowTicks, step = 10) {
  const n = Math.min(windowTicks, ring.size);
  if (n <= step) return buildVector(ring);
  const acc = new Float64Array(SPEC.length);
  let m = 0;
  for (let b = 0; b < n; b += step, m++) {
    const v = buildVectorAt(ring, b);
    for (let i = 0; i < v.length; i++) acc[i] += v[i];
  }
  const x = new Float32Array(SPEC.length);
  for (let i = 0; i < x.length; i++) x[i] = acc[i] / m;
  return x;
}

function buildVector(ring) {
  return buildVectorAt(ring, 0);
}

// Mean per tick rate of change over the last n ticks.
function meanRoc(ring, colName, n) {
  const c = IDX[colName];
  const k = Math.min(n, ring.size - 1);
  return k > 0 ? (ring.get(c, 0) - ring.get(c, k)) / k : 0;
}

module.exports = {
  FEATURES,
  COLS,
  IDX,
  toRow,
  resetLag,
  buildVector,
  buildVectorAt,
  buildWindowVector,
  meanRoc,
  D_COLS,
};
