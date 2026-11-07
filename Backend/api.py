"""
Piston-engine API serving the engine loop and frontend surface.
Run from repo root: uvicorn Backend.api:app --port 8000 --host 0.0.0.0
"""
from fastapi import FastAPI, WebSocket, WebSocketDisconnect, Body
from fastapi.responses import JSONResponse
from fastapi.middleware.cors import CORSMiddleware
import asyncio
import json
import sys
import time
import uvicorn

# Windows timer defaults to coarse granularity.
# Request 1 ms resolution for the 100 Hz loop.
if sys.platform == "win32":
    try:
        import ctypes
        ctypes.windll.winmm.timeBeginPeriod(1)
    except Exception:
        pass

try:
    from .engine_model import EngineSimulator
except ImportError:
    from engine_model import EngineSimulator

from contextlib import asynccontextmanager


@asynccontextmanager
async def lifespan(app: FastAPI):
    task = asyncio.create_task(engine_loop())
    yield
    task.cancel()


app = FastAPI(title="Piston-Engine Digital Twin API", lifespan=lifespan)

# CORS stays open for local frontend development.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

sim = EngineSimulator(dt=0.01)
connected_ws: set[WebSocket] = set()


async def broadcast_state(state: dict):
    if not connected_ws:
        return
    payload = json.dumps(state)
    # Bounded send with short timeout. Slow clients are dropped.
    for ws in list(connected_ws):
        try:
            await asyncio.wait_for(ws.send_text(payload), timeout=0.05)
        except Exception:
            stats["slow_sends"] += 1
            connected_ws.discard(ws)


# Broadcast runs off the physics loop with latest-wins scheduling.
# Physics still steps at 100 Hz.
pending_broadcast: asyncio.Task | None = None
stats = {"slow_sends": 0, "dropped_frames": 0, "overruns": 0}


def schedule_broadcast(state: dict):
    global pending_broadcast
    if pending_broadcast is not None and not pending_broadcast.done():
        stats["dropped_frames"] += 1
        return  # skip, latest wins on next step
    payload = json.dumps(state)
    clients = list(connected_ws)
    if not clients:
        return

    async def _send():
        for ws in clients:
            try:
                await asyncio.wait_for(ws.send_text(payload), timeout=0.05)
            except Exception:
                stats["slow_sends"] += 1
                connected_ws.discard(ws)

    pending_broadcast = asyncio.get_event_loop().create_task(_send())
    pending_broadcast.add_done_callback(lambda t: None)


async def engine_loop():
    next_deadline = asyncio.get_event_loop().time()
    last_parked = 0.0
    last_coast = 0.0
    while True:
        if sim.running:
            last_parked = 0.0  # re-arm immediate broadcast on next stop
            last_coast = 0.0
            st = sim.step()
            payload = {
                **st,
                "health": sim.health(),
                "faultCyl": {str(k): v for k, v in sim.fault_cyl.items()},
                # Per-code magnitudes for the life model.
                "faultMag": {str(k): v for k, v in sim.active_faults.items()},
                "engineId": sim.engine_id,
                "mission_id": sim.mission_id,
                "seq": sim.seq,
                "ts_ms": int(time.time() * 1000),
                # Generation timestamp in ms epoch for storage.
                # Flat env and command keys match dataset column names.
                "altitude": sim.altitude,
                "ambientT": sim.ambientT,
                "ambientP": round(sim.ambientP, 2),
                "humidity": sim.humidity,
                "rpm_cmd": sim.rpm_cmd,
                "load_cmd": sim.load_cmd,
                "afr_cmd": sim.afr_cmd,
                "cooling_cmd": sim.cooling_cmd,
                "inj_cmd": sim.inj_cmd,
            }
            # Broadcast stays off the physics loop.
            schedule_broadcast(payload)
        else:
            # Parked heartbeat coasts state toward ambient at 10 Hz.
            # Shutdown stays visible and replay density stays uniform.
            now = asyncio.get_event_loop().time()
            if last_coast == 0.0:
                last_coast = now
            sim.coast(now - last_coast)
            last_coast = now
            if last_parked == 0.0 or (now - last_parked) >= 0.1:
                last_parked = now
                await broadcast_state({
                    **dict(sim.state),
                    "health": sim.health(),
                    "faultCyl": {str(k): v for k, v in sim.fault_cyl.items()},
                    "faultMag": {str(k): v for k, v in sim.active_faults.items()},
                    "engineId": sim.engine_id,
                    "mission_id": sim.mission_id,
                    "parked": True,
                    "ts_ms": int(time.time() * 1000),
                    "altitude": sim.altitude,
                    "ambientT": sim.ambientT,
                    "ambientP": round(sim.ambientP, 2),
                    "humidity": sim.humidity,
                })
        # Compensated sleep accounts for loop work time.
        next_deadline += sim.dt
        delay = next_deadline - asyncio.get_event_loop().time()
        if delay > 0:
            await asyncio.sleep(delay)
        else:
            # Resync deadline after overrun.
            stats["overruns"] += 1
            next_deadline = asyncio.get_event_loop().time()
            await asyncio.sleep(0)
        # Loop counters for lag diagnosis.
        now_log = asyncio.get_event_loop().time()
        if now_log - stats.get("last_log", 0.0) >= 30.0:
            stats["last_log"] = now_log
            print(f"[twin] running={sim.running} clients={len(connected_ws)} "
                  f"overruns={stats['overruns']} slow_sends={stats['slow_sends']} "
                  f"dropped_frames={stats['dropped_frames']}", flush=True)


@app.post("/engine/start")
async def start_engine():
    # Start is idempotent. Running state reuses the current mission.
    if sim.running:
        return JSONResponse({"status": "running",
                             "mission_id": getattr(sim, "mission_id", 0),
                             "resumed": True})
    anchor = sim.begin_mission()
    return JSONResponse({"status": "running", **anchor})


@app.post("/engine/stop")
async def stop_engine():
    sim.stop()
    # Final frame closes the mission immediately.
    await broadcast_state({
        "end_of_mission": True,
        "mission_id": getattr(sim, "mission_id", 0),
        "ts_ms": int(time.time() * 1000),
        "t": getattr(sim, "t", 0),
    })
    return JSONResponse({"status": "stopped"})


@app.post("/engine/set_controls")
async def set_controls(
    rpm: float | None = Body(None),
    load: float | None = Body(None),
    afr: float | None = Body(None),
    cooling: float | None = Body(None),
    injTiming: float | None = Body(None),
    altitude: float | None = Body(None),
    ambientT: float | None = Body(None),
    ambientP: float | None = Body(None),
    humidity: float | None = Body(None),
):
    sim.set_controls(rpm=rpm, load=load, afr=afr, cooling=cooling,
                     injTiming=injTiming, altitude=altitude, ambientT=ambientT,
                     ambientP=ambientP, humidity=humidity)
    return JSONResponse({"status": "controls updated",
                         "rpm_cmd": sim.rpm_cmd, "load_cmd": sim.load_cmd})


@app.post("/engine/set_env")
async def set_env(
    altitude: float | None = Body(None),
    ambientT: float | None = Body(None),
    ambientP: float | None = Body(None),
    humidity: float | None = Body(None),
):
    sim.set_env(altitude=altitude, ambientT=ambientT,
                ambientP=ambientP, humidity=humidity)
    return JSONResponse({"status": "env updated",
                         "altitude": sim.altitude, "ambientT": sim.ambientT})


@app.post("/engine/fault")
async def set_fault(faultId: int = Body(...), enabled: bool = Body(...),
                    magnitude: float = Body(1.0), cyl: int = Body(0),
                    sensor_id: str | None = Body(None)):
    # Fault codes 0-14 accumulate across posts. Disabled codes are removed.
    try:
        fid = int(faultId)
    except (TypeError, ValueError):
        return JSONResponse({"error": "faultId must be an integer 0-14"}, status_code=422)
    if fid not in EngineSimulator.FAULT_NAMES:
        return JSONResponse({"error": "faultId must be 0-14"}, status_code=422)
    if not (0.0 <= magnitude <= 1.0):
        return JSONResponse({"error": "magnitude must be 0.0-1.0"}, status_code=422)
    if not (0 <= int(cyl or 0) <= 4):
        return JSONResponse({"error": "cyl must be 0-4"}, status_code=422)
    sim.set_fault(fid, enabled, magnitude, cyl=int(cyl or 0), sensor_id=sensor_id)
    return JSONResponse({"status": f"fault {fid} set to {enabled}",
                         "active": {str(k): v for k, v in sim.active_faults.items()},
                         "primary": sim.primary_fault()})


@app.post("/engine/faults/clear")
async def clear_faults():
    sim.clear_faults()
    return JSONResponse({"status": "cleared"})


# Engine identity for multiple physical assets.
@app.get("/engine/id")
async def engine_id():
    return JSONResponse({"engine_id": sim.engine_id,
                         "hours": sim.wear["hours"]})


@app.post("/engine/switch")
async def engine_switch(engineId: str = Body(..., embed=True)):
    # Engine swap requires a stopped engine.
    out = sim.switch_engine(engineId)
    return JSONResponse({"status": "switched", **out})


@app.post("/engine/reset")
async def engine_reset():
    sim.reset_engine_wear()
    return JSONResponse({"status": "factory-reset",
                         "engine_id": sim.engine_id})


@app.post("/engine/reset_all")
async def engine_reset_all():
    """Factory reset for all engine wear ledgers."""
    import pathlib
    sim.reset_engine_wear()
    try:
        for f in sim.WEAR_DIR.glob("*.json"):
            try:
                f.unlink()
            except Exception:
                pass
    except Exception:
        pass
    return JSONResponse({"status": "factory-reset-all",
                         "engine_id": sim.engine_id})


@app.post("/engine/park")
async def engine_park():
    """Park the twin cold with channels at ambient."""
    sim.park_cold()
    return JSONResponse({"status": "parked-cold",
                         "engine_id": sim.engine_id})


@app.get("/engine/faults")
async def list_faults():
    return {"active": {str(k): v for k, v in sim.active_faults.items()},
            "primary": sim.primary_fault(),
            "origin": {str(k): v for k, v in sim.fault_origin.items()}}


@app.websocket("/engine")
async def ws_engine(ws: WebSocket):
    await ws.accept()
    connected_ws.add(ws)
    try:
        while True:
            await ws.receive_text()
    except WebSocketDisconnect:
        connected_ws.discard(ws)
    except Exception:
        connected_ws.discard(ws)


@app.get("/health")
async def health():
    return {"status": "ok", "running": sim.running, "version": sim.VERSION}


if __name__ == "__main__":
    import os
    uvicorn.run("api:app", host="0.0.0.0",
                port=int(os.environ.get("PORT", "8000")), reload=True)
