# Security notes (read before SIH demo / any network exposure)

Threat model: **local demo on a trusted LAN / laptop**. The stack has NO
authentication by design. Do NOT expose port 8000/8443 to the public
internet without adding auth first.

## Accepted risks (deliberate, demo-scoped)

- **CORS `allow_origins=["*"]`** (`Backend/api.py`): the UI runs on a
  different port/host on venue networks. No cookies, tokens, or credentials
  exist, so wildcard CORS cannot leak auth state. Tighten to the venue IP
  for the final demo if time permits.
- **No auth on REST/WS, incl. `DELETE /fault-log`**: anyone on the LAN can
  drive the sim. Intended for a demo pit; add an API key middleware before
  any shared-network judging round.
- **`/engine/fault` + `/engine/set_controls`**: intentionally unauthenticated
  remote control of the twin. Same LAN-only assumption as above.
- **ML models via `joblib.load`**: pickle deserialization. Files come only
  from `ML/train_pipeline.py` in this repo. Never load a `.pkl` received
  from outside the team.

## Already hardened

- `faultId` restricted to 0-8 and `magnitude` to 0.0-1.0 (HTTP 422
  otherwise); the model layer re-validates and ignores garbage, so a bad
  code can never poison the WS stream or crash the UI catalog.
- All slider inputs clipped server-side (`set_controls` clamps rpm/load/afr/
  cooling); the physics step has no division by user input.
- SQLite writes are parameterized (`Backend/db.py`); no string-built SQL.
- WS broadcast is time-bounded (50ms/client); slow readers are dropped
  instead of stalling the sim loop (slow-loris style DoS on the loop).
- `fault_history.db`, `Backend/models/*.pkl`, `.env*` are gitignored and
  never pushed. No secrets exist in the repo (verified by scan).
- Frontend: no `eval`/innerHTML, React auto-escapes; backend URL is
  env-overridable (`VITE_API_BASE`, `VITE_WS_URL`) with a localhost default.
- `Database/fault_history.db` table capped at 1000 newest rows.

## Before venue judging

1. Run exactly ONE backend instance (two servers on :8000 fight and halve
   the sim rate - observed 0.26x with duplicates + unoptimized loop).
2. `DELETE /fault-log` (or sidebar Clear) so judging starts from zero rows.
3. Confirm `GET /ml/status` shows `ml_ready: true`.
