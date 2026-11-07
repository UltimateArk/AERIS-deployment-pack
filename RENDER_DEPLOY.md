# Hosting AERIS on Render (free) — split setup

Repo is deploy-ready. You still have to click Deploy in Render —
I have no access to your Render dashboard.

## What is ready

- `render.yaml` — 3-service blueprint: `aeris-twin`, `aeris-backend`
  (backend+bridge in one free service), `aeris-console`.
- `Backend/aeris/src/config.js` + `src/index.js` — single-port mode:
  frontend WS `/` + ingest WS `/ingest` on one `$PORT`.
- `Backend/api.py` — respects `$PORT`.

## Steps in your open Render dashboard

1. New > Blueprint > select this repo. Render detects `render.yaml`.
   Click Apply. First deploy uses placeholder `*.onrender.com` URLs.
2. Wait for service URLs (each service gets `https://<name>-xxxx.onrender.com`).
   Rename if yours differ from `aeris-twin` / `aeris-backend`.
3. Update env vars (service > Environment > Edit, `sync: false` means
   Render prompts you — paste real URLs):
   - `aeris-backend`: `ENGINE_REST=https://<your-twin>`,
     `ENGINE_WS=wss://<your-twin>/engine`
   - `aeris-console`: `VITE_API_BASE=https://<your-backend>`,
     `VITE_WS_URL=wss://<your-backend>/`,
     `VITE_TWIN_BASE=https://<your-twin>`,
     `VITE_TWIN_WS=wss://<your-twin>/engine`
4. Manual Deploy > Deploy latest commit on `aeris-backend`, then
   `aeris-console` (VITE_* bakes at build time, so console must rebuild
   after env edit).
5. Open console URL, login `pilot / aeris`, START ENGINE.

Check health first: `https://<twin>/health` and `https://<backend>/health`.
Bridge logs `fwd X frames (Y/s)` ~10/s in backend logs.

## Free-tier caveats

- Sleep: first load ~60s. Twin 100 Hz burns free hours — suspend when idle.
- No disk: SQLite + `wear/*.json` ephemeral. Replays vanish on restart.
- Node 22 pinned (`NODE_VERSION=22`) for `better-sqlite3@13` +
  `onnxruntime-node@1.30`.
