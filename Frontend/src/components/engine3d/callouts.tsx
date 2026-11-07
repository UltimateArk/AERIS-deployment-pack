import { useEffect, useMemo, useRef } from "react"
import { useFrame } from "@react-three/fiber"
import * as THREE from "three"
import type { SharedAnim, Telemetry3D } from "./types"

// External parameter callouts as canvas sprites. Values stay neutral with red status dot in alarm.
// Redraws only when text changes.

const INK_LIGHT = "#0B1220" // near-black for pure-text chips (light theme)
const INK_DARK = "#E6ECF3"  // near-white for dark theme
const ALARM = "#DC2626"

function drawLabel(canvas: HTMLCanvasElement, text: string, alarm: boolean, dark: boolean) {
  const ctx = canvas.getContext("2d")
  if (!ctx) return
  // Hi-res sprite canvas. Same world size keeps text sharp.
  const S = canvas.width / 256 // supersample factor
  ctx.clearRect(0, 0, canvas.width, canvas.height)
  // Pure text: no card, no box. Small alarm dot only, sharp mono font.
  ctx.fillStyle = alarm ? ALARM : dark ? "#8E9AAD" : "#475569"
  ctx.beginPath()
  ctx.arc(9 * S, (canvas.height / 2), 4 * S, 0, Math.PI * 2)
  ctx.fill()
  ctx.fillStyle = dark ? INK_DARK : INK_LIGHT
  ctx.font = `600 ${24 * S}px Consolas, monospace`
  ctx.textBaseline = "middle"
  ctx.fillText(text, 20 * S, canvas.height / 2 + 1)
}

type Rendered = { text: string; alarm: boolean }
type Shared = { current: SharedAnim }
type V3 = [number, number, number]
type CalloutDef = {
  pos: V3
  part?: V3 // 3D anchor on the exact component (leader line); none = ambient
  get: (s: Telemetry3D, shared: Shared) => Rendered
}

const CALLOUTS: CalloutDef[] = [
  { pos: [1.42, 0.74, 0], part: [0.88, 0.1, 0],
    get: (s, sh) => ({ text: `RPM ${Math.round(sh.current.dispRpm)}`, alarm: false }) },
  { pos: [-1.35, 0.82, 0], part: [-0.62, 0.1, -0.72],
    get: (s) => ({ text: `CHT ${Math.round(s.cht)}C`, alarm: s.cht > 250 }) },
  { pos: [1.36, 0.58, 0], part: [-0.62, 0.05, -0.75],
    get: (s) => ({ text: `EGT1 ${Math.round(s.egt1)}C`, alarm: s.egt1 > 800 }) },
  { pos: [1.36, 0.44, 0], part: [-0.21, 0.05, -0.75],
    get: (s) => ({ text: `EGT2 ${Math.round(s.egt2)}C`, alarm: s.egt2 > 800 }) },
  { pos: [1.36, 0.3, 0], part: [0.21, 0.05, 0.75],
    get: (s) => ({ text: `EGT3 ${Math.round(s.egt3)}C`, alarm: s.egt3 > 800 }) },
  { pos: [1.36, 0.16, 0], part: [0.62, 0.05, 0.75],
    get: (s) => ({ text: `EGT4 ${Math.round(s.egt4)}C`, alarm: s.egt4 > 800 }) },
  { pos: [0.38, 0.94, 0], part: [0, 0.5, 0],
    get: (s) => ({ text: `MAP ${s.map.toFixed(2)}bar`, alarm: false }) },
  { pos: [-1.35, -0.62, 0], part: [-1.02, -0.14, 0.18],
    get: (s) => ({ text: `OIL ${s.oilPressure.toFixed(1)}bar ${Math.round(s.oilTemp)}C`, alarm: s.oilPressure < 1.2 }) },
  { pos: [0.72, 0.78, 0], part: [0, 0.6, 0],
    get: (s) => ({ text: `FUEL ${s.fuelFlow.toFixed(2)}g/s`, alarm: false }) },
  { pos: [-1.45, 0.15, 0], part: [-1.02, 0.42, -0.18],
    get: (s) => ({ text: `BAT ${s.battV.toFixed(1)}V ALT ${s.altA.toFixed(1)}A`, alarm: s.battV < 24 }) },
  { pos: [-0.15, 1.05, 0], part: [0.72, 0.65, 0],
    get: (s) => ({ text: `INJ ${s.injTiming.toFixed(1)}deg`, alarm: false }) },
  { pos: [1.42, -0.34, 0], part: [0.95, -0.06, 0],
    get: (s) => ({ text: `PWR ${s.powerKw.toFixed(1)}kW`, alarm: false }) },
  { pos: [1.4, 0.0, 0], part: [0.45, 0.0, 0.7],
    get: (s) => ({ text: `SPREAD ${Math.round(s.egtSpread)}C`, alarm: s.egtSpread > 60 }) },
  { pos: [-1.45, -0.22, 0], part: [-0.72, 0.05, 0],
    get: (s) => ({ text: `VIB ${s.vibRMS.toFixed(2)}g`, alarm: s.vibRMS > 0.3 }) },
  { pos: [-0.7, 0.98, 0],
    get: (s) => ({ text: `ALT ${Math.round(s.env?.altitude ?? 0)}ft`, alarm: false }) },
  { pos: [0.95, 1.02, 0],
    get: (s) => ({ text: `OAT ${Math.round(s.env?.ambientT ?? 15)}C`, alarm: false }) },
  { pos: [-0.65, 0.68, 0],
    get: (s) => ({ text: `RH ${Math.round(s.env?.humidity ?? 30)}%`, alarm: false }) },
]

function LeaderLines({ dark = false }: { dark?: boolean }) {
  const geo = useMemo(() => {
    const pts: number[] = []
    for (const c of CALLOUTS) {
      if (!c.part) continue
      pts.push(...c.part, ...c.pos)
    }
    const g = new THREE.BufferGeometry()
    g.setAttribute("position", new THREE.Float32BufferAttribute(pts, 3))
    return g
  }, [])
  useEffect(() => () => geo.dispose(), [geo])
  return (
    <lineSegments geometry={geo}>
      <lineBasicMaterial color={dark ? "#8E9AAD" : "#334155"} transparent opacity={0.85} />
    </lineSegments>
  )
}

function CalloutSprite({ def, snapshotRef, shared, dark }: {
  def: CalloutDef
  snapshotRef: React.RefObject<Telemetry3D>
  shared: Shared
  dark: boolean
}) {
  const canvas = useMemo(() => {
    const c = document.createElement("canvas")
    c.width = 512
    c.height = 104
    return c
  }, [])
  const texture = useMemo(() => {
    const t = new THREE.CanvasTexture(canvas)
    t.colorSpace = THREE.SRGBColorSpace
    t.anisotropy = 4 // crisp oblique text, negligible cost
    return t
  }, [canvas])
  const last = useRef("")
  // Upload pacing caps redraws at 10 Hz. Matches telemetry cadence with fewer uploads.
  const lastDraw = useRef(0)
  useFrame(() => {
    const s = snapshotRef.current
    if (!s) return
    const r = def.get(s, shared)
    const key = `${r.text}|${r.alarm}|${dark}`
    if (key !== last.current) {
      last.current = key
      const now = performance.now()
      if (now - lastDraw.current < 100) return
      lastDraw.current = now
      drawLabel(canvas, r.text, r.alarm, dark)
      texture.needsUpdate = true
    }
  })
  return (
    <sprite position={def.pos} scale={[0.68, 0.138, 1]} renderOrder={1000}>
      <spriteMaterial map={texture} transparent depthTest={false} opacity={1} />
    </sprite>
  )
}

function HealthDotsSprite({ snapshotRef, dark }: {
  snapshotRef: React.RefObject<Telemetry3D>
  dark: boolean
}) {
  const canvas = useMemo(() => {
    const c = document.createElement("canvas")
    c.width = 1120
    c.height = 88
    return c
  }, [])
  const texture = useMemo(() => {
    const t = new THREE.CanvasTexture(canvas)
    t.colorSpace = THREE.SRGBColorSpace
    t.anisotropy = 4
    return t
  }, [canvas])
  const last = useRef("")
  const lastDrawH = useRef(0)
  useFrame(() => {
    const s = snapshotRef.current
    if (!s) return
    const items: Array<[string, number]> = [
      ["OIL", s.health?.oil ?? 100],
      ["COOL", s.health?.cool ?? 100],
      ["COMB", s.health?.comb ?? 100],
      ["VIB", s.health?.vib ?? 100],
      ["ELEC", s.health?.elec ?? 100],
    ]
    const key = items.map(([k, v]) => `${k}${Math.round(v)}`).join("|") + `|${dark}`
    if (key === last.current) return
    last.current = key
    const now = performance.now()
    if (now - lastDrawH.current < 100) return
    lastDrawH.current = now
    const ctx = canvas.getContext("2d")
    if (!ctx) return
    ctx.clearRect(0, 0, canvas.width, canvas.height)
    const S = canvas.width / 560 // supersample factor (2x canvas, same layout)
    let x = 6 * S
    ctx.font = `500 ${17 * S}px Consolas, monospace`
    ctx.textBaseline = "middle"
    for (const [k, v] of items) {
      const col = v >= 70 ? "#16A34A" : v >= 40 ? "#CA8A04" : "#DC2626"
      ctx.fillStyle = col
      ctx.beginPath()
      ctx.arc(x + 8 * S, 22 * S, 5 * S, 0, Math.PI * 2)
      ctx.fill()
      ctx.fillStyle = dark ? "#E6ECF3" : "#0B1220"
      ctx.fillText(`${k} ${Math.round(v)}`, x + 18 * S, 23 * S)
      x += 46 * S + ctx.measureText(`${k} ${Math.round(v)}`).width + 14 * S
    }
    texture.needsUpdate = true
  })
  return (
    <sprite position={[0, -0.82, 0]} scale={[1.2, 0.094, 1]} renderOrder={1000}>
      <spriteMaterial map={texture} transparent depthTest={false} opacity={1} />
    </sprite>
  )
}

export function ExternalCallouts({
  snapshotRef,
  shared,
  dark = false,
}: {
  snapshotRef: React.RefObject<Telemetry3D>
  shared: Shared
  dark?: boolean
}) {
  return (
    <group>
      <LeaderLines dark={dark} />
      {CALLOUTS.map((def, i) => (
        <CalloutSprite key={i} def={def} snapshotRef={snapshotRef} shared={shared} dark={dark} />
      ))}
      <HealthDotsSprite snapshotRef={snapshotRef} dark={dark} />
    </group>
  )
}
