// Verifies models load, feature vector = 111, calibrators/thresholds line up.
const ort = require("onnxruntime-node");
const fs = require("fs");
const path = require("path");
const C = require("../src/config");
const F = require("../src/worker/features");
(async () => {
  console.log("features:", F.FEATURES.length, "(model expects 111)");
  if (F.FEATURES.length !== 111) throw new Error("feature_list.json must be 111");
  const calib = JSON.parse(
    fs.readFileSync(path.join(C.paths.config, "calibrators.json"), "utf8"),
  );
  console.log(
    `calibrators: thresholds=${calib.thresholds.length} bins=${calib.bins.length} (expect 14/14)`,
  );
  if (calib.thresholds.length !== 14 || calib.bins.length !== 14)
    throw new Error("calibrators.json must have 14 thresholds + 14 bins");
  const x = new ort.Tensor("float32", new Float32Array(111), [1, 111]);
  for (const f of fs
    .readdirSync(C.paths.models)
    .filter((f) => f.endsWith(".onnx"))) {
    const s = await ort.InferenceSession.create(path.join(C.paths.models, f));
    const o = await s.run({ input: x });
    console.log(f.padEnd(14), Object.keys(o).join(","), "OK");
  }
})();
