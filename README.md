# AERIS - Piston Engine Digital Twin (SIH 2026)

Physics twin + live telemetry + ML fault prediction for MALE UAV piston engines.

## Layout

| Folder | Contents |
|---|---|
| `Backend/` | `api.py` (twin REST + WS, port 8000), `engine_model.py` (physics), `aeris/` (Node backend: ingest, ML worker, SQLite, port 8081) |
| `Frontend/` | React + Vite + Tailwind console (`npm run dev` -> :8443) |
| `ML_Models/` | Shipped model set: 14 ONNX classifiers, RUL model, calibrators, scalers |
| `Database/` | `fault_catalog.json` (fault codes 0-14, shared by backend and frontend) |
| `docs/` | `api_spec.yaml`, `ws_message_schema.json`, event and security notes |
| `_local/` | Training code and datasets. Local only, never pushed |

## Quick start

```powershell
setup.bat        # one-time: installs deps, deploys models into Backend\aeris
host_all.bat     # starts twin :8000, backend :8080/:8081, bridge, frontend :8443
stop_all.bat     # stops everything
```

Open `:8443`, sign in (`pilot` / `aeris`), enter engine number and mission name,
press START ENGINE, inject a fault, watch the ML panel and mission replay.

Run exactly ONE copy of each process. Two servers on :8000 slow the sim loop.

## Never pushed (see `.gitignore`)

Runtime databases (`*.db*`), per-engine wear ledgers (`Backend/wear/`),
deployed runtime copies (`Backend/aeris/models|config|data`),
`node_modules/`, `Frontend/dist/`, `__pycache__/`, `*.log`, `.venv/`, `_local/`.
