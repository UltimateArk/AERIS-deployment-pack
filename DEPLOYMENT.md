# AERIS — Deployment Specification

Single source of truth for how this project is hosted, where data lives,
and the operational limits. Updated: 2026-11-08.

## 1. Hosting summary

| Item | Value |
|---|---|
| Platform | Render, free tier |
| Source repo | `https://github.com/UltimateArk/AERIS-deployment-pack` (branch `main`, auto-deploy on push) |
| Workspace | SIH team (`tea-dbnla9rl550s73fhiiag`) |
| Region | `oregon` (all services) |
| Blueprint | `render.yaml` at repo root (twin build uses `Backend/requirements.render.txt`) |

| Service | Type | URL | Render ID | Runtime | Plan |
|---|---|---|---|---|---|
| `aeris-twin` | web | `https://aeris-twin-q32r.onrender.com` | `srv-dbnlfd3m8hqs73ci3oj0` | python | free |
| `aeris-backend` | web (backend + bridge in one) | `https://aeris-backend-kxxi.onrender.com` | `srv-dbnlfegu01pc73d3c6pg` | node (22) | free |
| `aeris-console` | static CDN | `https://aeris-console.onrender.com` | `srv-dbnlffrl550s73fhuse0` | static (node 22 build) | free |

Build / start commands (live on the services):

* twin: `pip install -r Backend/requirements.render.txt` → `uvicorn Backend.api:app --host 0.0.0.0 --port $PORT`, health `GET /health`
* backend (`rootDir Backend/aeris`): `npm install && mkdir -p models config data/spill && cp ../../ML_Models/clf_*.onnx models/ && cp ../../ML_Models/rul.onnx models/ && cp ../../ML_Models/*.json config/ (calibrators, feature_list, scaler_anomaly, threshold_anomaly, trend_config) && cp ../../Database/fault_catalog.json config/` → `INGEST_WS=ws://localhost:$PORT/ingest node scripts/bridge.js & npm start`, health `GET /health`
* console (`rootDir Frontend`): `npm install && npm run build`, publish `dist`

Environment keys (values point at the twin/backend URLs above):

* backend: `ENGINE_REST`, `ENGINE_WS`, `NODE_VERSION=22`, `AUTH_SECRET` (stable secret — set once, never in git), `CLIENT_LOST_GRACE_MS=120000`
* console: `VITE_API_BASE`, `VITE_WS_URL`, `VITE_TWIN_BASE`, `VITE_TWIN_WS`, `NODE_VERSION=22`
* twin: none (uses Render-provided `$PORT`)

## 2. Request flow

```
browser console ──REST/WS──▶ aeris-backend :$PORT ──proxy──▶ aeris-twin :$PORT
      │                              ▲ │                           ▲
      └──── twin WS / direct REST ────┘ │ bridge (localhost:$PORT/ingest)
                                        │ 100 Hz twin → 10 Hz ingest
```

Single-port mode: when only `$PORT` is set, the backend serves the
frontend WS on `/` and the twin ingest WS on `/ingest` from one listener
(`noServer` + manual upgrade routing — two `server`-mode WS servers cannot
share one HTTP server). Local dev keeps two ports (`:8080` ingest, `:8081`
frontend). Frontend also holds a direct twin link (`VITE_TWIN_*`) for the
3D view, graphs, and tiles; ML/enriched data comes via the backend WS.

## 3. Data storage (exact locations)

Nothing database-like is in GitHub (schemas live in
`Backend/aeris/src/db/databases.js`; `*.db*`, `Backend/aeris/models|config|data`,
`Backend/wear/`, `.venv/`, `node_modules/`, `Frontend/dist/` are gitignored).

On the Render backend service (clone root `/opt/render/project/src`):

* `/opt/render/project/src/Backend/aeris/data/raw_telemetry.db` (+ `-wal`/`-shm`) —
  `telemetry` (full JSON frame/row @10 Hz while running), `missions`, `sessions`,
  `mission_replay` (1:1 flagged copy of telemetry, built ~2.5 s after mission end)
* `/opt/render/project/src/Backend/aeris/data/events.db` —
  `fault_events` (~1 Hz while a fault fires), `trend_log` (0.2 Hz),
  `rul_log` (0.1 Hz), `life_state` (consumed hours per engine)
* `…/data/spill/raw.wal.ndjson`, `…/data/spill/events.wal.ndjson` — overflow
  spill when a DB is unhealthy; replayed automatically on recovery
* `…/data/auth.secret` — legacy token secret file (superseded by `AUTH_SECRET` env)
* Local mirror of all the above: `Backend/aeris/data/…` in this folder

Twin side: `Backend/wear/<ENGINE>.json` per-engine wear ledgers —
`/opt/render/project/src/Backend/wear/` on the **twin** service.

Auth/users: single shared operator `pilot` / `aeris` (default in
`Backend/aeris/src/auth.js`; overridable via `AUTH_USERS`). 30-min sliding
tokens; the token that opens a session owns it (`ownerFp`) — other consoles
get a locked screen and `409 mission owned by another console` on all drive
routes until the mission ends.

## 4. Capacity, growth, and full-disk behavior

* No application-level quota, pruning, or per-mission row limit exists.
  Effective capacity = free disk on the container (order of a few GB).
* Growth: one telemetry frame ≈ 0.8–1 KB JSON. At 10 Hz ingest that is
  ≈ 30–36 MB per engine-hour in `telemetry`, doubled by the replay copy →
  **≈ 60–70 MB per running hour** total, plus crumbs for events.
  Rule of thumb: ~8 h flying ≈ 0.5 GB; 24 h continuous ≈ 1.5 GB.
* `mission_replay` duplicates telemetry 1:1, so each mission costs ~2× its
  raw ingest. Old missions accumulate until deleted per-mission (trash icon
  in ▷ Mission Replay) or wiped via 🗑 Clear Database (owner console only;
  also resets wear ledgers and life state).
* When the disk fills: SQLite writes fail → store marked unhealthy → rows
  divert to spill NDJSON on the same full disk with 3 s retries; replay
  builds fail; newest data is held-then-lost (spill-write failure inside the
  flush timer can crash the process). Practically on free tier, restarts wipe
  the ephemeral disk long before it fills — persistence needs a paid disk or
  external Postgres.

## 5. Known degraded modes and free-tier caveats

* `ML_Models/*.onnx` in git are 131-byte Git-LFS pointers — the real ~114 KB
  model objects were never pushed to LFS, so the worker logs `Protobuf
  parsing failed` and runs with **zero classifiers** (`ready, classifiers:`).
  Fault cards currently come from the twin-reported fallback (confidence =
  injected magnitude), anomaly + trend + analytic RUL still compute. Upload
  real models → push → redeploy to restore ML detection (no code change).
* Free services sleep when idle: first load after idle takes ~60 s;
  WS blips are tolerated (120 s console-loss grace, 10 s REST timeouts).
* `twin :8000` direct REST has no auth (LAN-demo design); ownership is
  enforced at the backend proxy + UI layers.
* Logs used for diagnosis: Render Dashboard → service → Logs, or
  `GET /v1/logs` API (`[ingest] kept`, `[bridge] fwd`, `[worker]`,
  `[session]`, `[mission]`, `[twin] running=`).
