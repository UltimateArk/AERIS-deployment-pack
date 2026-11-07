import { useEffect, useRef } from "react"

// 3D contract types. Data comes from live backend snapshot via useBridge.

export type Telemetry3D = {
  t: number
  seq: number
  rpm: number
  cht: number
  egt: number
  egt1: number
  egt2: number
  egt3: number
  egt4: number
  egtSpread: number
  map: number
  oilPressure: number
  oilTemp: number
  fuelFlow: number
  vibX: number
  vibY: number
  vibZ: number
  vibRMS: number
  battV: number
  altA: number
  injTiming: number
  powerKw: number
  bsfc: number
  physRes: number
  faultCode: number
  faultCodes: number[]
  faultCyl: Record<string, number>
  health: { oil: number; cool: number; comb: number; vib: number; elec: number }
  env?: { altitude: number; ambientT: number; ambientP: number; humidity: number }
  controls?: { rpm_cmd: number; load_cmd: number; afr: number; cooling: number; inj: number }
}

// Shared animation state outside React state. Scene writes, callouts read.
export type SharedAnim = { dispRpm: number; resetView?: boolean }

export const DEFAULTS: Telemetry3D = {
  t: 0, seq: 0, rpm: 0, cht: 120, egt: 300,
  egt1: 300, egt2: 300, egt3: 300, egt4: 300, egtSpread: 0,
  map: 1, oilPressure: 3.5, oilTemp: 40, fuelFlow: 0,
  vibX: 0.02, vibY: 0.02, vibZ: 0.02, vibRMS: 0.03,
  battV: 28, altA: 8, injTiming: 20, powerKw: 0, bsfc: 300, physRes: 0,
  faultCode: 0, faultCodes: [0], faultCyl: {},
  health: { oil: 100, cool: 100, comb: 100, vib: 100, elec: 100 },
  env: { altitude: 0, ambientT: 15, ambientP: 101.3, humidity: 30 },
  controls: { rpm_cmd: 0, load_cmd: 0, afr: 14.7, cooling: 1, inj: 20 },
}

// Feeds 3D scene refs from live backend snapshot. Refs only, no extra WebSocket.
export function useBridge(snapshot: unknown, engineOn: boolean) {
  const snapRef = useRef<Telemetry3D>(DEFAULTS)
  const engineOnRef = useRef(false)
  useEffect(() => { engineOnRef.current = engineOn }, [engineOn])
  useEffect(() => {
    if (snapshot && typeof snapshot === "object") {
      snapRef.current = { ...DEFAULTS, ...(snapshot as Record<string, unknown>) } as Telemetry3D
    }
  }, [snapshot])
  return { snapRef, engineOnRef }
}
