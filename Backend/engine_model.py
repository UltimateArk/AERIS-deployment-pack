"""
Piston-engine digital twin core.
Simulates 4-cylinder engine physics with wear and faults.
"""
from __future__ import annotations
import time
import numpy as np

LHV_FUEL = 44e6  # J per kg gasoline


class EngineSimulator:
    VERSION = "v2.2"

    # Limits for validation and display redlines.
    MAX_RPM = 10000
    MAX_TORQUE = 300.0
    MAX_FUEL_FLOW = 5.0
    MIN_OIL_PRESSURE = 0.3
    MAX_OIL_PRESSURE = 5.0
    MAX_OIL_TEMP = 130.0
    MAX_EGT = 950.0
    MAX_CHT = 850.0
    MAX_MAP = 2.5
    VIB_SCALE = 0.5
    BATT_MIN = 20.0
    BATT_MAX = 29.0
    ALT_MAX = 25.0
    INJ_MIN = 10.0
    INJ_MAX = 30.0

    LIMITS = {
        "rpm": (0, 10000), "cht": (30, 850), "egt": (250, 950),
        "map": (0.8, 2.5), "oilPressure": (0.3, 5.0), "oilTemp": (20, 130),
        "fuelFlow": (0, 5.0), "vibRMS": (0, 0.5), "battV": (20, 29),
        "altA": (0, 25), "injTiming": (10, 30), "powerKw": (0, 120),
        "bsfc": (200, 600),
    }

    # Fault codes 0 healthy plus 14 faults.
    FAULT_NONE = 0
    FAULT_MISFIRE = 1          # Single-cylinder misfire.
    FAULT_INJECTOR_CLOG = 2    # Clogged injector in one cylinder.
    FAULT_FUEL_PUMP = 3        # Fuel pump degradation.
    FAULT_OIL_LOW = 4          # Low lubrication pressure.
    FAULT_BEARING_WEAR = 5     # Progressive bearing wear.
    FAULT_LOW_COMPRESSION = 6  # Low compression from worn rings.
    FAULT_COOLING_FAIL = 7     # Cooling circuit failure.
    FAULT_OVERHEAT = 8         # Sustained overheat condition.
    FAULT_KNOCK = 9            # Detonation in the chamber.
    FAULT_INJ_TIMING = 10      # Incorrect injection advance.
    FAULT_BACK_PRESS = 11      # Exhaust blockage.
    FAULT_ALT_FAIL = 12        # Alternator and battery failure.
    FAULT_SENSOR_DRIFT = 13    # Drift on the selected sensor channel.
    FAULT_EGT_IMBALANCE = 14   # Imbalance across cylinders.

    FAULT_FUEL_RESTRICT = 3
    FAULT_SENSOR_BIAS = 13
    FAULT_BACK_PRESS = 11
    FAULT_COOLING_FAIL = 7
    FAULT_KNOCK = 9

    FAULT_NAMES = {
        0: "HEALTHY", 1: "MISFIRE", 2: "INJECTOR_CLOG", 3: "FUEL_PUMP",
        4: "OIL_LOW", 5: "BEARING_WEAR", 6: "LOW_COMPRESSION",
        7: "COOLING_FAIL", 8: "OVERHEAT", 9: "KNOCK", 10: "INJ_TIMING",
        11: "BACK_PRESS", 12: "ALT_FAIL", 13: "SENSOR_DRIFT",
        14: "EGT_IMBALANCE",
    }

    def __init__(self, dt: float = 0.01, seed: int | None = None,
                 wear_rate_scale: float = 1.0):
        self.dt = dt
        self.rng = np.random.default_rng(seed)
        self.wear_rate_scale = float(wear_rate_scale)
        self.time = 0.0
        self.seq = 0
        self.running = False
        # Control commands.
        self.rpm_cmd = 0.0
        self.load_cmd = 0.0
        self.afr_cmd = 14.7
        self.cooling_cmd = 1.0
        self.inj_cmd = 20.0
        # Environment inputs.
        self.altitude = 0.0
        self.ambientT = 15.0
        self.ambientP = 101.3
        self.humidity = 30.0
        # Multi-fault state with magnitude range 0-1.
        self.active_faults: dict[int, float] = {}
        self.fault_cyl: dict[int, int] = {}
        self.sensor_id: str = "map"
        self.fault_origin: dict[int, str] = {}  # code to origin string
        self.fault_age: dict[int, float] = {}  # code to active seconds
        self.mission_id: int = 0
        self.mission_t0: float = 0.0
        self.mission_t0_wall: float = 0.0
        self.degradation_fired: set[int] = set()  # latched per run
        self.cascade_fired: set[int] = set()
        self._overheat_t: float = 0.0
        # Slow wear persists across missions per engine.
        self.engine_id: str = "ENG-01"
        self.wear = self._fresh_wear()
        self._load_wear_profile()
        self.state = {
            "t": 0.0, "rpm": 0.0, "cht": 120.0, "egt": 300.0,
            "egt1": 300.0, "egt2": 300.0, "egt3": 300.0, "egt4": 300.0,
            "egtSpread": 0.0, "map": 1.0, "oilPressure": 3.5, "oilTemp": 40.0,
            "fuelFlow": 0.0, "vibX": 0.02, "vibY": 0.02, "vibZ": 0.02,
            "vibRMS": 0.03, "battV": 28.0, "altA": 8.0, "injTiming": 20.0,
            "powerKw": 0.0, "bsfc": 300.0, "physRes": 0.0,
            "faultCode": 0, "faultCodes": [0],
            "faultOrigin": {}, "faultAge": {},
            "mission_id": 0, "mission_t": 0.0, "wall_ts": 0.0,
            "engineId": self.engine_id,
        }

    # Engine identity for multiple assets.
    WEAR_DIR = __import__("pathlib").Path(__file__).resolve().parent / "wear"

    @staticmethod
    def _fresh_wear() -> dict:
        return {"hours": 0.0, "ringWear": 0.0, "oilHealth": 1.0,
                "coolantHealth": 1.0, "plugHealth": 1.0,
                "filterClog": 0.0, "altHealth": 1.0}

    def _wear_file(self, eid: str | None = None):
        import re
        safe = re.sub(r"[^A-Za-z0-9_-]", "_", (eid or self.engine_id))
        return self.WEAR_DIR / f"{safe}.json"

    def _load_wear_profile(self) -> None:
        import json
        f = self._wear_file()
        if f.exists():
            try:
                saved = json.loads(f.read_text())
                for k in self.wear:
                    if k in saved:
                        self.wear[k] = float(saved[k])
            except Exception:
                pass  # fall back to a fresh profile

    def save_wear(self) -> None:
        """Save current engine wear to disk."""
        import json
        try:
            self.WEAR_DIR.mkdir(parents=True, exist_ok=True)
            self._wear_file().write_text(json.dumps(self.wear))
        except Exception:
            pass

    def switch_engine(self, eid: str) -> dict:
        """Swap to another engine profile while stopped."""
        if self.running:
            self.stop()
        self.save_wear()
        self.engine_id = str(eid).strip() or "ENG-01"
        self.wear = self._fresh_wear()
        self._load_wear_profile()
        return {"engine_id": self.engine_id, "hours": self.wear["hours"]}

    def reset_engine_wear(self) -> None:
        """Reset current engine wear to factory state."""
        self.wear = self._fresh_wear()
        try:
            self._wear_file().unlink(missing_ok=True)
        except Exception:
            pass

    # Compatibility accessor for single active fault.
    @property
    def active_fault(self) -> int:
        return self.primary_fault()

    @active_fault.setter
    def active_fault(self, v: int) -> None:
        if int(v) == 0:
            self.active_faults.clear()
            self.fault_age.clear()
            self.fault_origin.clear()
        else:
            self.active_faults = {int(v): self.fault_mag}
            self.fault_origin.setdefault(int(v), "manual")

    @property
    def fault_mag(self) -> float:
        if not self.active_faults:
            return 0.0
        return max(self.active_faults.values())

    @fault_mag.setter
    def fault_mag(self, v: float) -> None:
        pass  # magnitude lives in the fault dict

    def primary_fault(self) -> int:
        if not self.active_faults:
            return 0
        return max(self.active_faults, key=lambda k: self.active_faults[k])

    # Control commands and lifecycle.
    def start(self) -> None:
        self.running = True

    def stop(self) -> None:
        self.running = False  # wear persists across stops
        self.save_wear()

    def park_cold(self) -> None:
        """Park the twin cold with channels at ambient."""
        self.running = False
        self.save_wear()
        self.active_faults.clear()
        self.fault_cyl.clear()
        self.fault_age.clear()
        self.fault_origin.clear()
        self._overheat_t = 0.0
        amb = float(self.ambientT)
        ambP = max(0.95, float(self.ambientP) / 101.3)
        self.state.update({
            "rpm": 0.0, "fuelFlow": 0.0, "powerKw": 0.0, "bsfc": 550.0,
            "cht": amb, "oilTemp": amb,
            "egt": amb + 20.0, "egt1": amb + 20.0, "egt2": amb + 20.0,
            "egt3": amb + 20.0, "egt4": amb + 20.0, "egtSpread": 0.0,
            "map": ambP, "oilPressure": 0.0,
            "vibX": 0.0, "vibY": 0.0, "vibZ": 0.0, "vibRMS": 0.0,
            "battV": 25.6, "altA": 0.0, "injTiming": float(self.inj_cmd),
            "physRes": 0.0,
            "faultCode": 0, "faultCodes": [0],
            "faultOrigin": {}, "faultAge": {},
        })
        self.state["mission_t"] = float(self.time - self.mission_t0)
        import time as _t
        self.state["wall_ts"] = _t.time()

    def coast(self, dt: float) -> None:
        """Cool the stopped engine state toward ambient."""
        dt = float(max(0.0, min(dt, 5.0)))
        if dt <= 0.0:
            return
        self.time += dt
        s = self.state
        amb = self.ambientT

        def approach(key: str, target: float, tau: float) -> None:
            cur = float(s.get(key, target))
            s[key] = cur + (target - cur) * (1.0 - float(np.exp(-dt / tau)))

        approach("rpm", 0.0, 2.0)
        approach("fuelFlow", 0.0, 2.0)
        approach("powerKw", 0.0, 2.0)
        approach("oilPressure", 0.0, 6.0)
        approach("altA", 0.0, 3.0)
        approach("battV", 25.6, 15.0)
        approach("map", max(0.95, self.ambientP / 101.3), 8.0)
        approach("egt", amb + 20.0, 25.0)
        approach("egtSpread", 0.0, 25.0)
        for k in ("egt1", "egt2", "egt3", "egt4"):
            approach(k, amb + 20.0, 25.0)
        approach("cht", amb, 120.0)
        approach("oilTemp", amb, 120.0)
        for k in ("vibX", "vibY", "vibZ", "vibRMS"):
            approach(k, 0.0, 4.0)
        self.state["mission_t"] = float(self.time - self.mission_t0)
        self.state["wall_ts"] = time.time()

    def begin_mission(self) -> dict:
        """Start a new mission with fresh clocks."""
        self.mission_id += 1
        self.mission_t0 = self.time
        self.mission_t0_wall = time.time()
        self.running = True
        return {"mission_id": self.mission_id,
                "mission_t0_wall": self.mission_t0_wall}

    def reset(self) -> None:
        self.time = 0.0
        self.seq = 0
        self.fault_age.clear()
        self.degradation_fired.clear()
        self.cascade_fired.clear()
        self._overheat_t = 0.0
        self.mission_id = 0
        self.mission_t0 = 0.0
        self.mission_t0_wall = 0.0
        for k in ("rpm", "fuelFlow", "powerKw", "vibX", "vibY", "vibZ",
                  "vibRMS"):
            self.state[k] = 0.0 if k in ("powerKw",) else (0.0 if k == "rpm" else 0.02)
        self.state.update({"t": 0.0, "cht": 120.0, "egt": 300.0,
                           "egt1": 300.0, "egt2": 300.0, "egt3": 300.0,
                           "egt4": 300.0, "faultCode": 0, "faultCodes": [0]})

    def reset_wear(self) -> None:
        for k in self.wear:
            self.wear[k] = 0.0 if k in ("hours", "ringWear", "filterClog") else 1.0
        # Degradation faults clear with the cause.
        for fid in [f for f, o in self.fault_origin.items() if o == "degradation"]:
            self.active_faults.pop(fid, None)
            self.fault_age.pop(fid, None)
            self.fault_origin.pop(fid, None)
            self.fault_cyl.pop(fid, None)
        self.degradation_fired.clear()
        self._overheat_t = 0.0

    def set_wear(self, **kw) -> None:
        for k, v in kw.items():
            if k in self.wear:
                self.wear[k] = float(v)

    def set_controls(self, *, rpm=None, load=None, afr=None, cooling=None,
                     injTiming=None, altitude=None, ambientT=None,
                     ambientP=None, humidity=None) -> None:
        if rpm is not None:
            self.rpm_cmd = float(np.clip(rpm, 0, self.MAX_RPM))
        if load is not None:
            self.load_cmd = float(np.clip(load, 0, 100))
        if afr is not None:
            self.afr_cmd = float(np.clip(afr, 12.0, 16.0))
        if cooling is not None:
            self.cooling_cmd = float(np.clip(cooling, 0.0, 1.0))
        if injTiming is not None:
            self.inj_cmd = float(np.clip(injTiming, self.INJ_MIN, self.INJ_MAX))
        self.set_env(altitude=altitude, ambientT=ambientT,
                     ambientP=ambientP, humidity=humidity)

    def set_env(self, *, altitude=None, ambientT=None, ambientP=None,
                humidity=None) -> None:
        if altitude is not None:
            self.altitude = float(np.clip(altitude, 0, 15000))
            # Derive pressure from standard atmosphere.
            if ambientP is None:
                self.ambientP = float(101.3 * (1 - 2.2558e-5 * self.altitude) ** 5.2559)
        if ambientT is not None:
            self.ambientT = float(np.clip(ambientT, -20, 55))
        if ambientP is not None:
            self.ambientP = float(np.clip(ambientP, 50, 110))
        if humidity is not None:
            self.humidity = float(np.clip(humidity, 0, 100))

    # Fault dict and single fault access.
    def set_fault(self, fault_id: int, enabled: bool, magnitude: float = 1.0,
                  cyl: int = 0, sensor_id: str | None = None) -> None:
        try:
            fid = int(fault_id)
        except (TypeError, ValueError):
            return
        if fid not in self.FAULT_NAMES:
            return
        if enabled and fid != 0:
            self.active_faults[fid] = float(np.clip(magnitude, 0.0, 1.0))
            if fid not in self.fault_origin:
                self.fault_origin[fid] = "manual"
            if cyl:
                self.fault_cyl[fid] = int(np.clip(cyl, 1, 4))
            if sensor_id:
                self.sensor_id = str(sensor_id)
        else:
            self.active_faults.pop(fid, None)
            self.fault_cyl.pop(fid, None)
            self.fault_age.pop(fid, None)
            self.fault_origin.pop(fid, None)
            if fid == 0:
                self.active_faults.clear()
                self.fault_cyl.clear()
                self.fault_age.clear()
                self.fault_origin.clear()

    def set_faults(self, faults: dict[int, float]) -> None:
        self.active_faults = {int(k): float(np.clip(v, 0, 1))
                              for k, v in faults.items()
                              if int(k) in self.FAULT_NAMES and int(k) != 0}

    def clear_faults(self) -> None:
        self.active_faults.clear()
        self.fault_cyl.clear()
        self.fault_age.clear()
        self.fault_origin.clear()

    def mag(self, fid: int) -> float:
        return float(self.active_faults.get(fid, 0.0))

    def has(self, fid: int) -> bool:
        return fid in self.active_faults

    # External telemetry input replaces physics state.
    def apply_telemetry(self, frame: dict) -> dict:
        """Apply an external sensor frame and update wear and health."""
        for k in ("rpm", "cht", "egt", "map", "oilPressure", "oilTemp",
                  "fuelFlow", "vibZ", "battV", "altA", "injTiming"):
            if k in frame:
                self.state[k] = float(frame[k])
        for i in (1, 2, 3, 4):
            if f"egt{i}" in frame:
                self.state[f"egt{i}"] = float(frame[f"egt{i}"])
        self._update_wear()
        self.state["t"] = float(self.time)
        self.state["faultCode"] = self.primary_fault()
        self.state["faultCodes"] = sorted(self.active_faults) or [0]
        self.state["faultOrigin"] = {str(k): v for k, v in self.fault_origin.items()}
        self.state["faultAge"] = {str(k): round(v, 1) for k, v in self.fault_age.items()}
        self.state["mission_id"] = self.mission_id
        self.state["mission_t"] = float(self.time - self.mission_t0)
        self.state["engineId"] = self.engine_id
        self.state["wall_ts"] = time.time()
        return dict(self.state)

    def _update_wear(self) -> None:
        # Wear rates use real seconds at scale 1.0.
        # Faults accelerate wear through heat and load.
        s = self.wear_rate_scale / 60.0
        load_n = self.load_cmd / 100.0
        heat = max(0.0, (self.state["cht"] - 180) / 100.0)
        self.wear["hours"] += self.dt / 3600.0 * s
        self.wear["ringWear"] = min(1.0, self.wear["ringWear"] + self.dt * 1.9e-6 * (0.5 + load_n + heat) * s)
        self.wear["oilHealth"] = max(0.0, self.wear["oilHealth"] - self.dt * 8.0e-6 * np.exp((self.state["oilTemp"] - 100) / 15.0) * s)
        self.wear["coolantHealth"] = max(0.0, self.wear["coolantHealth"] - self.dt * 2.1e-6 * (0.5 + heat) * s)
        self.wear["plugHealth"] = max(0.0, self.wear["plugHealth"] - self.dt * 1.4e-6 * (0.5 + load_n) * s)
        self.wear["filterClog"] = min(1.0, self.wear["filterClog"] + self.dt * 3.7e-6 * (0.3 + load_n) * s)
        self.wear["altHealth"] = max(0.0, self.wear["altHealth"] - self.dt * 4.2e-7 * s)

    def _fire_auto(self, fid: int, mag: float, origin: str, cyl: int = 0) -> None:
        mag = float(np.clip(mag, 0.2, 1.0))
        if fid in self.active_faults:
            # Active faults update only from the same origin.
            if self.fault_origin.get(fid) == origin:
                self.active_faults[fid] = mag
            return
        self.active_faults[fid] = mag
        self.fault_origin[fid] = origin
        if cyl:
            self.fault_cyl[fid] = int(np.clip(cyl, 1, 4))

    def _check_auto_faults(self) -> None:
        # Wear limits fire faults 1-14.
        # Clearing a fault acknowledges it for the run.
        w = self.wear
        clip = lambda v: float(np.clip(v, 0.2, 1.0))
        if w["ringWear"] >= 0.8 and 6 not in self.degradation_fired:
            self._fire_auto(6, clip((w["ringWear"] - 0.8) / 0.2), "degradation")
            self.degradation_fired.add(6)
        if w["oilHealth"] <= 0.2 and 4 not in self.degradation_fired:
            self._fire_auto(4, clip((0.2 - w["oilHealth"]) / 0.2), "degradation")
            self.degradation_fired.add(4)
        if w["coolantHealth"] <= 0.2 and 7 not in self.degradation_fired:
            self._fire_auto(7, clip((0.2 - w["coolantHealth"]) / 0.2), "degradation")
            self.degradation_fired.add(7)
        if w["plugHealth"] <= 0.15 and 1 not in self.degradation_fired:
            self._fire_auto(1, clip((0.15 - w["plugHealth"]) / 0.15), "degradation", cyl=1)
            self.degradation_fired.add(1)
        if w["filterClog"] >= 0.7 and 3 not in self.degradation_fired:
            self._fire_auto(3, clip((w["filterClog"] - 0.7) / 0.3), "degradation")
            self.degradation_fired.add(3)
        if w["altHealth"] <= 0.3 and 12 not in self.degradation_fired:
            self._fire_auto(12, clip((0.3 - w["altHealth"]) / 0.3), "degradation")
            self.degradation_fired.add(12)
        # Sustained overheat fires fault 8.
        if self.state["cht"] > 280:
            self._overheat_t += self.dt
        else:
            self._overheat_t = 0.0
        if self._overheat_t >= 30.0 and 8 not in self.degradation_fired:
            self._fire_auto(8, 0.6, "degradation")
            self.degradation_fired.add(8)
        # Sustained severe faults fire related faults.
        def sustained(fid: int, mag_min: float, secs: float) -> bool:
            return (self.mag(fid) >= mag_min
                    and self.fault_age.get(fid, 0.0) >= secs)
        if sustained(7, 0.5, 60.0) and 8 not in self.cascade_fired:
            self._fire_auto(8, 0.6, "cascade")
            self.cascade_fired.add(8)
        if sustained(4, 0.6, 60.0) and 5 not in self.cascade_fired:
            self._fire_auto(5, 0.6, "cascade")
            self.cascade_fired.add(5)
        if sustained(8, 0.5, 60.0) and 9 not in self.cascade_fired:
            self._fire_auto(9, 0.5, "cascade")
            self.cascade_fired.add(9)

    def health(self) -> dict:
        """Compute subsystem health scores from 0 to 100."""
        w = self.wear
        s = self.state
        fuel = float(s.get("fuelFlow", 0.0))
        if (not self.running) or s["rpm"] < 250.0:
            # Gate vibration health when the engine is off or idling.
            # Low speed has no combustion vibration to assess.
            vib = 100.0
        else:
            base = (0.018 + 0.000012 * s["rpm"] + 0.0006 * self.load_cmd
                    + 0.004 * fuel)
            rel = max(0.0, (s["vibRMS"] - base) / max(base, 1e-6))
            vib = 100.0 * np.exp(-3.0 * rel) - 20.0 * self.mag(5)
        oil = 100 * w["oilHealth"] - 10 * self.mag(4)
        cool = 100 * w["coolantHealth"] - 25 * self.mag(7) - 15 * self.mag(8)
        comb = 100 * w["plugHealth"] - 20 * self.mag(1) - 15 * self.mag(9) - 10 * self.mag(10)
        elec = 100 * w["altHealth"] - 40 * self.mag(12)
        clip = lambda v: float(np.clip(v, 0, 100))
        return {"oil": clip(oil), "cool": clip(cool), "comb": clip(comb),
                "vib": clip(vib), "elec": clip(elec)}

    def step(self) -> dict:
        if not self.running:
            return dict(self.state)
        self.time += self.dt
        self.seq += 1
        r = self.rng.normal
        F = self.active_faults.get
        m1, m2, m3, m4 = F(1, 0), F(2, 0), F(3, 0), F(4, 0)
        m5, m6, m7, m8 = F(5, 0), F(6, 0), F(7, 0), F(8, 0)
        m9, m10, m11, m12 = F(9, 0), F(10, 0), F(11, 0), F(12, 0)
        m13, m14 = F(13, 0), F(14, 0)

        # Interaction multipliers for combined faults.
        heat_x = 1.0 + 0.3 * (1 if (m7 and m4) else 0)
        comb_x = 1.0 + 0.4 * (1 if (m1 and m9) else 0) + 0.5 * (1 if (m3 and m10) else 0)

        # Rotor speed lag.
        err = self.rpm_cmd - self.state["rpm"]
        self.state["rpm"] = float(np.clip(self.state["rpm"] + err / 0.3 * self.dt, 0, self.MAX_RPM))

        # Altitude derate from air density.
        dens = (self.ambientP / 101.3) * np.sqrt(288.15 / (273.15 + self.ambientT))
        dens = float(np.clip(dens, 0.55, 1.05))

        # Fuel flow with pump and wear effects.
        desired = self.load_cmd / 100.0 * self.MAX_FUEL_FLOW
        fuel = desired * (14.7 / self.afr_cmd) * dens
        fuel *= (1 - 0.45 * m3) * (1 - 0.25 * m2) * (1 + 0.22 * m6)
        fuel *= (1 + 0.5 * self.wear["filterClog"]) * (1 + 0.3 * self.wear["ringWear"])
        fuel = float(np.clip(fuel, 0, self.MAX_FUEL_FLOW))
        self.state["fuelFlow"] = fuel

        # Combustion efficiency from mixture and timing.
        eff = 0.32 - 0.02 * abs(self.afr_cmd - 14.7) - 0.008 * abs(self.inj_cmd - 20)
        eff *= (1 - 0.25 * m6) * (1 - 0.2 * m1 * comb_x) * (1 - 0.15 * m10)
        eff = float(np.clip(eff, 0.15, 0.35))

        # Injection timing with control and fault effects.
        inj = self.inj_cmd + 4 * m9 - 2 * m10 + r(0, 0.2)
        if m10:
            inj += r(0, 3 * m10)
        if m13 and self.sensor_id == "injTiming":
            inj += 3 * m13
        self.state["injTiming"] = float(np.clip(inj, self.INJ_MIN, self.INJ_MAX))

        # Cylinder head temperature with ambient shift and faults.
        cool_eff = self.cooling_cmd * self.wear["coolantHealth"]
        cht_t = (90 + (self.ambientT - 15) * 1.2 + 22 * fuel + 0.015 * self.state["rpm"]
                 + 0.35 * self.load_cmd * (1 - dens * 0.2) - 18 * cool_eff)
        cht_t += (self.afr_cmd - 14.7) * 8
        cht_t += (65 * m7 + 55 * m8 + 42 * m9 * comb_x) * heat_x
        cht_t *= (1 - 0.18 * m1 - 0.14 * m6)
        cht = self.state["cht"] + (cht_t - self.state["cht"]) * self.dt / 1.8 + r(0, 0.3)
        if m13 and self.sensor_id == "cht":
            cht += 30 * m13
        self.state["cht"] = float(np.clip(cht, 30, self.MAX_CHT))

        # Per-cylinder exhaust temperature with ambient and timing effects.
        egt_base = (320 + (self.ambientT - 15) * 1.5
                    + 60 * fuel * (self.afr_cmd / 14.7) * (1 + 0.2 * (1 - dens))
                    + 0.012 * self.state["rpm"] - 8 * cool_eff)
        egt_base += (20 - self.state["injTiming"]) * 6
        egt_base += (110 * m11 + 32 * m7 + 28 * m9 - 40 * m1 - 22 * m6)
        mis_cyl = self.fault_cyl.get(1, 0) or self.fault_cyl.get(2, 0)
        for i in (1, 2, 3, 4):
            prev = self.state[f"egt{i}"]
            tgt = egt_base
            if mis_cyl == i and (m1 or m2):
                tgt -= (60 if m1 else 40) * max(m1, m2)
            if m14:
                tgt += (30 * m14) if i in (1, 3) else (-20 * m14)
            val = prev + (tgt - prev) * self.dt / 1.2 + r(0, 0.5)
            if m13 and self.sensor_id == f"egt{i}":
                val += 50 * m13
            self.state[f"egt{i}"] = float(np.clip(val, 250, self.MAX_EGT))
        egt_avg = float(sum(self.state[f"egt{i}"] for i in (1, 2, 3, 4)) / 4)
        self.state["egt"] = egt_avg
        self.state["egtSpread"] = float(max(self.state[f"egt{i}"] for i in (1, 2, 3, 4))
                                        - min(self.state[f"egt{i}"] for i in (1, 2, 3, 4)))

        # Manifold pressure with density and faults.
        map_v = (self.ambientP / 101.3 * 1.0 + 0.35 * self.state["rpm"] / self.MAX_RPM
                 + 0.08 * fuel / self.MAX_FUEL_FLOW + 0.1 * (1 - dens))
        map_v += 0.45 * m11 - 0.12 * m3 - 0.22 * m6
        map_v += r(0, 0.005)
        if m13 and self.sensor_id == "map":
            map_v += 0.55 * m13
        self.state["map"] = float(np.clip(map_v, 0.8, self.MAX_MAP))

        # Oil pressure and temperature with wear effects.
        oil_tgt = 3.6 + 0.00012 * self.state["rpm"] - 0.008 * self.load_cmd
        oil_tgt *= (0.5 + 0.5 * self.wear["oilHealth"])
        if m4:
            oil_tgt = 0.9 - 0.4 * m4
        oil_p = self.state["oilPressure"] + (oil_tgt - self.state["oilPressure"]) * self.dt / 0.7 + r(0, 0.015)
        self.state["oilPressure"] = float(np.clip(oil_p, self.MIN_OIL_PRESSURE, self.MAX_OIL_PRESSURE))
        oilT_t = (42 + 0.006 * self.state["rpm"] + 0.38 * self.load_cmd + 3.2 * fuel
                  - 12 * cool_eff + (self.ambientT - 15) * 0.4)
        oilT_t += 14 * m4 + 26 * m7 * heat_x + 10 * m9 + 8 * m5 + 20 * self.wear["ringWear"]
        oil_t = self.state["oilTemp"] + (oilT_t - self.state["oilTemp"]) * self.dt / 6.0 + r(0, 0.15)
        self.state["oilTemp"] = float(np.clip(oil_t, 20, self.MAX_OIL_TEMP))

        # Three-axis vibration and RMS value.
        base = 0.018 + 0.000012 * self.state["rpm"] + 0.0006 * self.load_cmd + 0.004 * fuel
        vx = base + 0.06 * m5 + 0.09 * m1 * comb_x + 0.07 * m9 + 0.03 * m6 + r(0, 0.004)
        vy = base + 0.05 * m5 + 0.08 * m1 + 0.06 * m9 + 0.02 * m11 + r(0, 0.004)
        vzt = base + 0.18 * m1 * comb_x + 0.14 * m9 + 0.06 * m6 + 0.04 * m11 + 0.03 * m7 + r(0, 0.004)
        self.state["vibX"] = float(np.clip(vx, 0, self.VIB_SCALE))
        self.state["vibY"] = float(np.clip(vy, 0, self.VIB_SCALE))
        self.state["vibZ"] = float(np.clip(vzt, 0, self.VIB_SCALE))
        self.state["vibRMS"] = float(np.sqrt((vx ** 2 + vy ** 2 + vzt ** 2) / 3))

        # Electrical charge with load and health.
        alt_t = (10 + 0.001 * self.state["rpm"] - 0.05 * self.load_cmd) * self.wear["altHealth"]
        if m12:
            alt_t *= (1 - 0.95 * m12)
        alt = self.state["altA"] + (alt_t - self.state["altA"]) * self.dt / 0.5 + r(0, 0.05)
        self.state["altA"] = float(np.clip(alt, 0, self.ALT_MAX))
        batt_t = 24 + 4 * (self.state["altA"] / 10) - 0.01 * self.load_cmd - (6 * m12)
        batt = self.state["battV"] + (batt_t - self.state["battV"]) * self.dt / 0.5 + r(0, 0.02)
        self.state["battV"] = float(np.clip(batt, self.BATT_MIN, self.BATT_MAX))

        # Power and fuel consumption from fuel energy.
        fuel_kg_s = fuel / 1000.0
        power = fuel_kg_s * (LHV_FUEL / 1000.0) * eff
        torque = float(np.clip(power * 1000 / max(50.0, self.state["rpm"] * 2 * np.pi / 60),
                               0, self.MAX_TORQUE))
        self.state["powerKw"] = float(np.clip(power, 0, 120))
        self.state["bsfc"] = (float(np.clip(fuel * 3600 / max(0.5, power), 200, 600))
                              if power > 0.5 else 550.0)

        # Physics residual from fuel, shaft, and heat power.
        fuel_kw = fuel / 1000 * LHV_FUEL / 1000
        heat_kw = max(0.0, (self.state["cht"] - self.ambientT) * 0.05 + (egt_avg - self.ambientT) * 0.02)
        self.state["physRes"] = float(fuel_kw - power - heat_kw)

        self._update_wear()
        for fid in list(self.active_faults.keys()):
            self.fault_age[fid] = self.fault_age.get(fid, 0.0) + self.dt
        self._check_auto_faults()
        self.state["faultCode"] = self.primary_fault()
        self.state["faultCodes"] = sorted(self.active_faults) or [0]
        self.state["faultOrigin"] = {str(k): v for k, v in self.fault_origin.items()}
        self.state["faultAge"] = {str(k): round(v, 1) for k, v in self.fault_age.items()}
        self.state["mission_id"] = self.mission_id
        self.state["mission_t"] = float(self.time - self.mission_t0)
        self.state["engineId"] = self.engine_id
        self.state["wall_ts"] = time.time()
        self.state["t"] = float(self.time)
        return dict(self.state)
