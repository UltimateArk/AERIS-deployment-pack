# Hosting AERIS on Render (free) — split setup

You asked me to host it. I can't create Render/Vercel accounts for you,
but the repo is now deploy-ready. Follow these 10 minutes of clicks.

## What I changed for hosting

- `Backend/aeris/src/config.js` — respects `$PORT`. When only `$PORT` is set
  (Render), ingest + frontend share one port (single-port mode).
- `Backend/aeris/src/index.js` — frontend WS on `/`, twin ingest WS on
  `/ingest` when `INGEST_PORT == HTTP_PORT`. Local 2-port `:8080/:8081`
  behavior unchanged.
- `Backend/api.py` — `__main__` respects `$PORT`.
- `render.yaml` — 4-service blueprint (twin, backend, bridge, console).

## Deploy steps

1. Push this repo to GitHub (include `render.yaml`, `ML_Models/`, `Database/`,
   `Frontend/`, `Backend/`).
2. Render Dashboard > New > Blueprint > select repo. Render creates:
   `aeris-twin`, `aeris-backend`, `aeris-bridge`, `aeris-console`.
   First deploy will fail URL wiring — expected.
3. After URLs exist, update env vars (Render Dashboard > service > Environment):
   - `aeris-backend`: `ENGINE_REST=https://<your-twin>.onrender.com`
   - `aeris-bridge`: `ENGINE_WS=wss://<your-twin>.onrender.com/engine`,
     `INGEST_WS=wss://<your-backend>.onrender.com/ingest`
   - `aeris-console` (static): `VITE_API_BASE=https://<your-backend>.onrender.com`,
     `VITE_WS_URL=wss://<your-backend>.onrender.com/`,
     `VITE_TWIN_BASE=https://<your-twin>.onrender.com`,
     `VITE_TWIN_WS=wss://<your-twin>.onrender.com/engine`
   - Redeploy each after editing (Manual Deploy > Deploy latest commit for
     static to bake VITE_* at build time).
4. Open `https://<your-console>.onrender.com`, login `pilot / aeris`.

## Free-tier caveats

- Sleep: free web services sleep after inactivity. First load takes ~60s.
  Twin 100 Hz loop + ONNX burn free hours fast — suspend when not demoing.
- No disk: SQLite `data/*.db` and `Backend/wear/*.json` are ephemeral on
  Render free. Missions/replays vanish on restart. Paid disks fix this.
- Native builds: `better-sqlite3@13` + `onnxruntime-node@1.30` build on
  Node 22 (`NODE_VERSION=22` already set in `render.yaml`).
- Bridge logs `fwd X frames (Y/s)` every 30s — expect ~10/s.

## Local check before pushing

```bash
# aeris single-port smoke (simulates Render $PORT)
PORT=18081 node Backend/aeris/src/index.js
# expect: "[http/ws] single-port :18081 (frontend ws / + ingest ws /ingest)"
```
