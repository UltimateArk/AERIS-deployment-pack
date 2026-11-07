# ML_Models

Shipped model set. `setup.bat` copies these into `Backend/aeris/models`
and `Backend/aeris/config` on a fresh clone (those runtime copies are
gitignored; this folder is the canonical one that gets pushed).

## Files

- `clf_f1.onnx` … `clf_f14.onnx` - one fault classifier per fault code.
- `rul.onnx` - RUL regressor (runs as a cross-check; displayed RUL is analytic).
- `calibrators.json` - per-fault decision thresholds and display bins.
- `feature_list.json` - the 111 features in shared order.
- `scaler_anomaly.json`, `threshold_anomaly.json` - anomaly tripwire.
- `trend_config.json` - trend ROC thresholds and prognosis limits.
