# Frontend Contract - Piston Engine DT

## Visuals (all driven by single WS state)
| Component | WS field | Display |
|-----------|----------|---------|
| RPM gauge | `rpm` | 0-10000 rpm dial |
| CHT bar | `cht` | 30-850 C |
| EGT dial | `egt` | 250-950 C |
| MAP bar | `map` | 0.8-2.5 bar |
| Oil P gauge | `oilPressure` | 0.3-5 bar |
| Oil T gauge | `oilTemp` | 20-130 C |
| Fuel bar | `fuelFlow` | 0-5 g/s |
| Vib indicator | `vibZ` | 0-0.4 g -> circle radius / color |
| Fault LED | `faultCode` | 0=green, !=0 red + label |

## Controls -> REST
- ON/OFF: `POST /engine/start` , `POST /engine/stop`
- RPM slider (0-10000): `POST /engine/set_controls {rpm}`
- Load slider (0-100): `POST /engine/set_controls {load}`
- Optional AFR (12-16), cooling (0-1): same endpoint
- Fault toggles (8): `POST /engine/fault {faultId, enabled, magnitude}` faultId 1 oil_low, 2 misfire, 3 fuel_restrict, 4 back_press, 5 cooling_fail, 6 sensor_bias, 7 knock, 8 low_compression

## WS
- `ws://localhost:8000/engine` pushes JSON per `ws_message_schema.json` at up to 100Hz while running (measured ~85Hz on Windows; ML fields refresh ~3-4Hz via cache). UI: `ws.onmessage -> setState(JSON.parse(e.data))`

## Example React snippet
```js
const ws = new WebSocket("ws://localhost:8000/engine");
ws.onmessage = e => setEngineState(JSON.parse(e.data));
// controls
fetch("/engine/set_controls", {method:"POST", headers:{"Content-Type":"application/json"}, body: JSON.stringify({rpm:3500, load:60})})
fetch("/engine/fault", {method:"POST", headers:{"Content-Type":"application/json"}, body: JSON.stringify({faultId:1, enabled:true})})
```
