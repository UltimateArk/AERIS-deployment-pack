# Database

Canonical data files. Everything the app generates at runtime lives outside
this folder (see repo `.gitignore`) and is never pushed.

## Files

- `fault_catalog.json` - fault codes 0-14 with names, causes and fixes.
  Shared by the backend and the frontend. Code numbers are a contract:
  keep them stable across backend, frontend and models.
