# Backend

Two processes that run together (see `host_all.bat`).

## Twin (`api.py` + `engine_model.py`, port 8000)

FastAPI + WebSocket server around the physics twin. Run from repo root:

```powershell
py -m uvicorn Backend.api:app --port 8000 --host 0.0.0.0
```

- `engine_model.py` - 4-cylinder physics: combustion, thermals, oil,
  vibration, electrics, wear, 14 fault codes (0 = healthy).
- `api.py` - 100 Hz sim loop with compensated sleep, 10 Hz broadcast,
  REST controls and fault injection, per-engine wear ledgers in `wear/`.

Endpoints: `POST /engine/start|/stop|/set_controls|/set_env|/fault|/faults/clear|/switch|/reset|/reset_all|/park` · `GET /engine/id|/engine/faults` · `WS /engine` · `GET /health`.

## Aeris backend (`aeris/`, ports 8080/8081)

Node service: twin ingest, ML worker thread (ONNX classifiers, trend, RUL),
two SQLite databases, mission sessions, frontend REST + WS.

```powershell
cd Backend\aeris; npm install; npm start
```

`scripts/bridge.js` forwards twin frames to ingest. `_probe.js` is a
lifecycle smoke test (`node _probe.js` with the stack running).
