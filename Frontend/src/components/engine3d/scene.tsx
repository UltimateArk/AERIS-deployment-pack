import { useEffect, useMemo, useRef } from "react"
import { useFrame, useThree } from "@react-three/fiber"
import * as THREE from "three"
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js"
import { RoundedBoxGeometry } from "three/examples/jsm/geometries/RoundedBoxGeometry.js"
import { EDGE, heatColor } from "./materials"
import { faultAnchorFor } from "./camera"
import type { SharedAnim, Telemetry3D } from "./types"

// Boxer-4 layout. Crank along X with 4 opposed cylinders. Heat shows as emissive glow only.
const CYL_X = [-0.62, -0.21, 0.21, 0.62]
const CYL_SIDE = [-1, -1, 1, 1]
const FIRE_PHASE = [0, Math.PI, Math.PI * 2, Math.PI * 3]
const CRANK_Y = -0.45
const CRANK_R = 0.1
// Wind streak anchors. Flow past the engine.
const WIND_SPOTS: Array<[number, number, number]> = [
  [-1.8, -0.6, -1.1], [-0.6, -0.3, -0.7], [0.7, 0, 1.0], [1.8, 0.3, 0.8],
  [-1.2, 0.6, -0.9], [0.2, 0.75, 0.3], [1.4, -0.75, -0.4], [-0.1, 0.45, 1.15],
  [0.9, -0.5, 0.9], [-1.5, 0.2, -0.6], [0.4, -0.7, -1.0], [1.7, 0.1, 0.5],
  [-0.9, 0.05, 0.7], [1.1, 0.55, -0.85], [-0.3, -0.55, -0.95], [0.95, 0.15, -0.25],
]
const UP = new THREE.Vector3(0, 1, 0)
const DIR = new THREE.Vector3()
const PIN = new THREE.Vector3()
const ATT = new THREE.Vector3()
const TMP = new THREE.Color()

// Shared EdgesGeometry per geometry instance (boundaries, not per-mesh).
const edgeCache = new Map<THREE.BufferGeometry, THREE.BufferGeometry>()
function edgesOf(g: THREE.BufferGeometry, threshold = 25): THREE.BufferGeometry {
  let e = edgeCache.get(g)
  if (!e) {
    e = new THREE.EdgesGeometry(g, threshold)
    edgeCache.set(g, e)
  }
  return e
}

// Outlined part: mesh + bright boundary lines (engineering drawing look).
function P({ g, m, p, r, name, edge = EDGE, edgeOp = 0.85 }: {
  g: THREE.BufferGeometry
  m: THREE.Material | THREE.Material[]
  p?: [number, number, number]
  r?: [number, number, number]
  name?: string
  edge?: string | null
  edgeOp?: number
}) {
  return (
    <group position={p} rotation={r}>
      <mesh geometry={g} material={m} name={name} />
      {edge && (
        <lineSegments geometry={edgesOf(g)}>
          <lineBasicMaterial color={edge} transparent opacity={edgeOp} />
        </lineSegments>
      )}
    </group>
  )
}

// Dotted shell with dashed outline and wireframe. Unlit variant costs less.
function DashedShell({ g, p, r, s, tint, fillOp, lineOp, ghost = false }: {
  g: THREE.BufferGeometry
  p?: [number, number, number]
  r?: [number, number, number]
  s?: [number, number, number]
  tint: string
  fillOp: number
  lineOp: number
  ghost?: boolean
}) {
  const { le, lw } = useMemo(() => {
    const mk = (geo: THREE.BufferGeometry, op: number) => {
      const m = new THREE.LineDashedMaterial({
        color: EDGE, dashSize: 0.045, gapSize: 0.032,
        transparent: true, opacity: op,
      })
      const l = new THREE.LineSegments(geo, m)
      l.computeLineDistances()
      return l
    }
    return {
      le: mk(new THREE.EdgesGeometry(g, 12), lineOp),
      lw: mk(new THREE.WireframeGeometry(g), lineOp * 0.4),
    }
  }, [g, lineOp])
  useEffect(() => () => {
    le.geometry.dispose()
    ;(le.material as THREE.Material).dispose()
    lw.geometry.dispose()
    ;(lw.material as THREE.Material).dispose()
  }, [le, lw])
  return (
    <group position={p} rotation={r} scale={s}>
      <mesh geometry={g}>
        {ghost ? (
          <meshBasicMaterial color={tint} transparent opacity={fillOp} depthWrite={false} />
        ) : (
          <meshPhysicalMaterial color={tint} transmission={0.92} roughness={0.12}
                                 thickness={0.3} ior={1.35} transparent opacity={1} />
        )}
      </mesh>
      <primitive object={le} />
      <primitive object={lw} />
    </group>
  )
}

// Background follows altitude.
export function BgByAlt({ snapRef, dark = false }: {
  snapRef: React.RefObject<Telemetry3D>
  dark?: boolean
}) {
  const { scene } = useThree()
  const col = useMemo(() => new THREE.Color("#E9EDF2"), [])
  const hi = useMemo(() => new THREE.Color("#C3CFDE"), [])
  // Dark palette deepens with altitude.
  const colD = useMemo(() => new THREE.Color("#111824"), [])
  const hiD = useMemo(() => new THREE.Color("#0A0F16"), [])
  const last = useRef(-1)
  const lastDark = useRef<boolean | null>(null)
  useFrame(() => {
    const alt = snapRef.current?.env?.altitude ?? 0
    if (Math.abs(alt - last.current) < 100 && lastDark.current === dark) return
    last.current = alt
    lastDark.current = dark
    const k = Math.min(1, alt / 12000)
    scene.background = dark ? colD.clone().lerp(hiD, k) : col.clone().lerp(hi, k)
  })
  return null
}

// Offline PBR environment. Supplies reflections without network HDR.
export function Env() {
  const { gl, scene } = useThree()
  useEffect(() => {
    const pmrem = new THREE.PMREMGenerator(gl)
    const envTex = pmrem.fromScene(new RoomEnvironment(), 0.04).texture
    scene.environment = envTex
    return () => {
      scene.environment = null
      envTex.dispose()
      pmrem.dispose()
    }
  }, [gl, scene])
  return null
}

function updateRod(mesh: THREE.Mesh | null, a: THREE.Vector3, b: THREE.Vector3) {
  if (!mesh) return
  DIR.subVectors(b, a)
  const len = DIR.length() || 0.001
  mesh.position.set((a.x + b.x) / 2, (a.y + b.y) / 2, (a.z + b.z) / 2)
  mesh.scale.set(1, len, 1)
  DIR.normalize()
  mesh.quaternion.setFromUnitVectors(UP, DIR)
}

// Frame probe. Records FPS and worst frame per 300-frame window.
const fpsProbe = { n: 0, sum: 0, worst: 0 }
function probeFrame(dt: number) {
  fpsProbe.n++; fpsProbe.sum += dt; fpsProbe.worst = Math.max(fpsProbe.worst, dt)
  if (fpsProbe.n >= 300) {
    const avgFps = fpsProbe.n / Math.max(fpsProbe.sum, 1e-6);
    ;(window as unknown as { __aeris_perf?: object }).__aeris_perf = {
      ...((window as unknown as { __aeris_perf?: object }).__aeris_perf ?? {}),
      gl: { fps: Math.round(avgFps), worstFrameMs: Math.round(fpsProbe.worst * 1000) },
    }
    if (avgFps < 25)
      console.info(`[perf:3d] ${avgFps.toFixed(0)}fps avg, worst frame ${(fpsProbe.worst * 1000).toFixed(0)}ms - GPU-bound`)
    fpsProbe.n = 0; fpsProbe.sum = 0; fpsProbe.worst = 0
  }
}
// Animated parts use single standard materials. Beacons mark active faults with phase-offset blink.
const MAX_BEACONS = 3;
function FaultBeacon({ snapRef }: {
  snapRef: React.RefObject<Telemetry3D>
}) {
  const tex = useMemo(() => {
    const c = document.createElement("canvas")
    c.width = 128
    c.height = 128
    const ctx = c.getContext("2d")
    if (ctx) {
      const g = ctx.createRadialGradient(64, 64, 4, 64, 64, 62)
      g.addColorStop(0, "rgba(255,70,60,1)")
      g.addColorStop(0.35, "rgba(220,38,38,0.95)")
      g.addColorStop(0.7, "rgba(220,38,38,0.25)")
      g.addColorStop(1, "rgba(220,38,38,0)")
      ctx.fillStyle = g
      ctx.fillRect(0, 0, 128, 128)
    }
    const t = new THREE.CanvasTexture(c)
    t.colorSpace = THREE.SRGBColorSpace
    return t
  }, [])
  const refs = useRef<Array<THREE.Sprite | null>>([])
  const ats = useRef([new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()])
  const seen = useRef("")
  const magOf = (s: Telemetry3D, code: number) =>
    ((s as unknown as { faultMag?: Record<string, number> }).faultMag ?? {})[String(code)] ?? 0
  useFrame((state) => {
    const s = snapRef.current
    const codes = s
      ? (s.faultCodes ?? []).filter((cd) => cd > 0).sort((a, b) => magOf(s, b) - magOf(s, a)).slice(0, MAX_BEACONS)
      : []
    const key = codes.join(",")
    if (key !== seen.current) {
      seen.current = key
      refs.current.forEach((sp, i) => {
        if (!sp) return
        const c = codes[i]
        if (c === undefined || !s) {
          sp.visible = false
          return
        }
        const a = faultAnchorFor(s, c)
        if (!a) {
          sp.visible = false
          return
        }
        ats.current[i].set(a[0], a[1], a[2])
        sp.visible = true
      })
    }
    const el = state.clock.elapsedTime
    refs.current.forEach((sp, i) => {
      if (!sp || !sp.visible) return
      sp.position.copy(ats.current[i])
      const on = Math.sin(el * 9 + i * 2.1) > 0
      const sc = (on ? 0.22 : 0.13) + 0.02 * Math.sin(el * 9 + i * 2.1)
      sp.scale.set(sc, sc, 1)
      ;(sp.material as THREE.SpriteMaterial).opacity = on ? 1 : 0.25
    })
  })
  return (
    <>
      {[0, 1, 2].map((i) => (
        <sprite
          key={i}
          ref={(sp) => { refs.current[i] = sp; }}
          renderOrder={1002}
          visible={false}
        >
          <spriteMaterial map={tex} transparent depthTest={false} opacity={1} />
        </sprite>
      ))}
    </>
  )
}

// Cached name->mesh lookup (traverses once, then O(1)).
type StdMesh = THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial>
function useNamed() {
  const root = useRef<THREE.Group>(null)
  const cache = useRef<Record<string, StdMesh | null>>({})
  const get = (name: string): StdMesh | null => {
    const hit = cache.current[name]
    if (hit !== undefined) return hit
    const o = (root.current?.getObjectByName(name) as StdMesh | undefined) ?? null
    cache.current[name] = o
    return o
  }
  return { root, get }
}

export function Boxer4Engine({
  snapRef,
  engineOnRef,
  shared,
}: {
  snapRef: React.RefObject<Telemetry3D>
  engineOnRef: React.RefObject<boolean>
  shared: { current: SharedAnim }
}) {
  const { root, get } = useNamed()
  const mount = useRef<THREE.Group>(null)
  const crank = useRef<THREE.Group>(null)
  const prop = useRef<THREE.Group>(null)
  const needle = useRef<THREE.Group>(null)

  // Shared geometries (one instance each, edges shared too).
  const G = useMemo(() => {
    const exh = (x: number, side: number) => new THREE.TubeGeometry(
      new THREE.CatmullRomCurve3([
        new THREE.Vector3(x, 0.05, side * 0.75),
        new THREE.Vector3(x, -0.3, side * 0.62),
        new THREE.Vector3(x, -0.62, side * 0.4),
        new THREE.Vector3(x, -0.72, side * 0.15),
      ]), 24, 0.032, 10, false)
    const runner = (x: number, side: number) => new THREE.TubeGeometry(
      new THREE.CatmullRomCurve3([
        new THREE.Vector3(x, 0.38, 0),
        new THREE.Vector3(x, 0.24, side * 0.18),
        new THREE.Vector3(x, 0.12, side * 0.28),
      ]), 16, 0.028, 10, false)
    return {
      cylBody: new THREE.CylinderGeometry(0.14, 0.14, 0.55, 32),
      fin: new THREE.TorusGeometry(0.16, 0.012, 12, 48),
      head: new RoundedBoxGeometry(0.3, 0.3, 0.1, 2, 0.03),
      glow: new THREE.CylinderGeometry(0.105, 0.105, 0.16, 24),
      spark: new THREE.SphereGeometry(0.028, 20, 20),
      piston: new THREE.CylinderGeometry(0.11, 0.11, 0.16, 24),
      rod: new THREE.CylinderGeometry(0.024, 0.024, 1, 12),
      crankShaft: new THREE.CylinderGeometry(0.07, 0.07, 1.5, 24),
      counter: new THREE.CylinderGeometry(0.13, 0.13, 0.03, 24),
      pin: new THREE.CylinderGeometry(0.03, 0.03, 0.07, 12),
      block: new RoundedBoxGeometry(1.45, 0.42, 0.36, 3, 0.06),
      hub: new THREE.CylinderGeometry(0.07, 0.07, 0.14, 20),
      blade: (() => {
        // Tapered propeller blade planform (wide root, rounded tip),
        // span along Y, chord along shape-X, thin extrude (rotated to X below)
        const bs = new THREE.Shape();
        bs.moveTo(-0.065, 0.08);
        bs.lineTo(-0.05, 0.48);
        bs.quadraticCurveTo(-0.045, 0.58, 0, 0.6);
        bs.quadraticCurveTo(0.045, 0.58, 0.05, 0.48);
        bs.lineTo(0.065, 0.08);
        bs.quadraticCurveTo(0, 0.05, -0.065, 0.08);
        const geo = new THREE.ExtrudeGeometry(bs, {
          depth: 0.016, bevelEnabled: false, curveSegments: 12,
        });
        geo.translate(0, 0, -0.008);
        geo.rotateY(Math.PI / 2); // chord -> Z, thin -> X (prop axis)
        return geo;
      })(),
      inj: new THREE.CylinderGeometry(0.02, 0.02, 0.14, 12),
      fdot: new THREE.SphereGeometry(0.014, 12, 12),
      oilTank: new RoundedBoxGeometry(0.22, 0.32, 0.3, 2, 0.04),
      rad: new RoundedBoxGeometry(0.08, 0.5, 0.85, 2, 0.02),
      batt: new RoundedBoxGeometry(0.2, 0.2, 0.26, 2, 0.03),
      alt: new THREE.CylinderGeometry(0.07, 0.07, 0.1, 20),
      dial: new THREE.CylinderGeometry(0.1, 0.1, 0.025, 24),
      needle: new THREE.BoxGeometry(0.012, 0.075, 0.01),
      turbo: new THREE.TorusGeometry(0.1, 0.04, 12, 32),
      plenum: new RoundedBoxGeometry(1.35, 0.16, 0.28, 2, 0.04),
      rail: new THREE.CylinderGeometry(0.018, 0.018, 1.4, 12),
      cowl: new THREE.CapsuleGeometry(0.52, 0.9, 8, 24),
      wingLeft: new THREE.BoxGeometry(1.1, 0.06, 2.6),
      wingA: new THREE.BoxGeometry(1.1, 0.06, 1.0),
      wingB: new THREE.BoxGeometry(0.8, 0.055, 1.2),
      wingC: new THREE.BoxGeometry(0.55, 0.05, 1.4),
      blur: new THREE.CircleGeometry(0.66, 40),
      caseGlow: new THREE.BoxGeometry(1.3, 0.07, 0.3),
      wind: new THREE.BoxGeometry(0.18, 0.006, 0.006),
      cool: new THREE.SphereGeometry(0.012, 12, 12),
      exh: CYL_X.map((x, i) => exh(x, CYL_SIDE[i])),
      runner: CYL_X.map((x, i) => runner(x, CYL_SIDE[i])),
    }
  }, [])

  // Shared materials use light neutrals. Heat shows as emissive glow with per-cylinder arrays.
  const M = useMemo(() => {
    const shell = () => new THREE.MeshStandardMaterial({
      color: "#E4E8ED", transparent: true, opacity: 0.22, depthWrite: false,
      metalness: 0.1, roughness: 0.45,
    })
    const frame = () => new THREE.MeshStandardMaterial({
      color: "#E3D5B8", transparent: true, opacity: 0.24, depthWrite: false,
      metalness: 0.15, roughness: 0.5,
    })
    return {
      shell: shell(),
      steel: new THREE.MeshStandardMaterial({ color: "#465062", metalness: 0.7, roughness: 0.3 }),
      mid: new THREE.MeshStandardMaterial({ color: "#B9C0C9", metalness: 0.4, roughness: 0.5 }),
      dark: new THREE.MeshStandardMaterial({ color: "#7C8590", metalness: 0.3, roughness: 0.6 }),
      glow: [0, 1, 2, 3].map(() => new THREE.MeshStandardMaterial({
        color: "#F4F6F8", emissive: new THREE.Color("#3B82F6"), emissiveIntensity: 0.5,
      })),
      egt: [0, 1, 2, 3].map(() => new THREE.MeshStandardMaterial({
        color: "#C9CFD6", emissive: new THREE.Color("#EF4444"), emissiveIntensity: 0.35,
      })),
      spark: [0, 1, 2, 3].map(() => new THREE.MeshStandardMaterial({
        color: "#8A94A0", emissive: new THREE.Color("#ffffff"), emissiveIntensity: 0.2,
        transparent: true, opacity: 0.85,
      })),
      inj: [0, 1, 2, 3].map(() => new THREE.MeshStandardMaterial({
        color: "#F0C795", emissive: new THREE.Color("#F2994A"), emissiveIntensity: 0.5,
        transparent: true, opacity: 0.5,
      })),
      rail: new THREE.MeshStandardMaterial({
        color: "#F0C795", emissive: new THREE.Color("#F2994A"), emissiveIntensity: 0.4,
        transparent: true, opacity: 0.5,
      }),
      oilTank: new THREE.MeshStandardMaterial({
        color: "#BFE0DA", emissive: new THREE.Color("#0284C7"), emissiveIntensity: 0.5,
      }),
      oilGallery: new THREE.MeshStandardMaterial({
        color: "#C9CFD6", emissive: new THREE.Color("#56CCF2"), emissiveIntensity: 0.45,
      }),
      rad: new THREE.MeshStandardMaterial({ color: "#16A34A", metalness: 0.3, roughness: 0.6 }),
      batt: new THREE.MeshStandardMaterial({ color: "#EFD6D6", metalness: 0.4, roughness: 0.4 }),
      alt: new THREE.MeshStandardMaterial({ color: "#EFD6D6", metalness: 0.4, roughness: 0.4 }),
      turbo: new THREE.MeshStandardMaterial({
        color: "#C9CFD6", emissive: new THREE.Color("#F2994A"), emissiveIntensity: 0,
      }),
      pin: [0, 1, 2, 3].map(() => new THREE.MeshStandardMaterial({
        color: "#56CCF2", emissive: new THREE.Color("#56CCF2"), emissiveIntensity: 0.7,
      })),
      needle: new THREE.MeshStandardMaterial({
        color: "#7C3AED", emissive: new THREE.Color("#7C3AED"), emissiveIntensity: 0.8,
      }),
      frame: frame(),
      cylBody: [0, 1, 2, 3].map(() => new THREE.MeshStandardMaterial({
        color: "#C9E8D4", transparent: true, opacity: 0.3, depthWrite: false,
        emissive: new THREE.Color("#3B82F6"), emissiveIntensity: 0.3,
        metalness: 0.1, roughness: 0.45,
      })),
      blade: new THREE.MeshStandardMaterial({
        color: "#5B6B7F", metalness: 0.6, roughness: 0.35,
        transparent: true, opacity: 1,
      }),
      blur: new THREE.MeshBasicMaterial({
        color: "#9AA3AE", transparent: true, opacity: 0, depthWrite: false,
        side: THREE.DoubleSide,
      }),
      caseGlow: new THREE.MeshStandardMaterial({
        color: "#EDEFF2", emissive: new THREE.Color("#3B82F6"), emissiveIntensity: 0.5,
      }),
      collector: new THREE.MeshStandardMaterial({
        color: "#C9CFD6", emissive: new THREE.Color("#EF4444"), emissiveIntensity: 0.3,
      }),
      wind: new THREE.MeshBasicMaterial({ color: "#7FB3E8", transparent: true, opacity: 0.4 }),
      cool: new THREE.MeshBasicMaterial({ color: "#7DD3FC", transparent: true, opacity: 0.6 }),
      fdot: [0, 1, 2, 3, 4].map(() => new THREE.MeshStandardMaterial({
        color: "#F2994A", emissive: new THREE.Color("#F2994A"), emissiveIntensity: 1.2,
        transparent: true, opacity: 0.6,
      })),
    }
  }, [])

  useFrame((state, dt) => {
    probeFrame(Math.min(dt, 0.5))
    const s = snapRef.current
    if (!s) return
    const on = engineOnRef.current
    const cl = Math.min(dt, 0.1)
    const el = state.clock.elapsedTime

    // Display rpm eases to 0 on stop. Avoids freezing at last value.
    const target = on ? s.rpm : 0
    shared.current.dispRpm += (target - shared.current.dispRpm) * Math.min(1, 2.2 * cl)
    if (Math.abs(shared.current.dispRpm) < 5 && !on) shared.current.dispRpm = 0
    const w = (shared.current.dispRpm / 60) * Math.PI * 2 * cl
    if (crank.current) crank.current.rotation.x += w
    if (prop.current) prop.current.rotation.x += w

    // Shake stays subtle with high deadzone and tiny cap. Telemetry carries values.
    if (mount.current) {
      const ax = Math.min(0.02, Math.max(0, s.vibX - 0.12) * 0.12) * (on ? 1 : 0)
      const ay = Math.min(0.02, Math.max(0, s.vibY - 0.12) * 0.12) * (on ? 1 : 0)
      const az = Math.min(0.02, Math.max(0, s.vibZ - 0.12) * 0.12) * (on ? 1 : 0)
      mount.current.position.x = (Math.sin(el * 43) * 0.7 + (Math.random() - 0.5) * 0.3) * ax
      mount.current.position.y = (Math.sin(el * 51) * 0.7 + (Math.random() - 0.5) * 0.3) * ay
      mount.current.position.z = (Math.sin(el * 47) * 0.7 + (Math.random() - 0.5) * 0.3) * az
    }

    const misCyl = s.faultCyl?.["1"] ?? 0
    const clogCyl = s.faultCyl?.["2"] ?? 0
    const codes = s.faultCodes ?? []
    const misfire = codes.includes(1)
    const knock = codes.includes(9)
    const knockCyl = s.faultCyl?.["9"] ?? 1

    // CHT and EGT glow use remapped norms. Cruise reads blue, overheat reads red.
    const chtN = Math.max(0, Math.min(1, (s.cht - 207) / 132))
    const egtN = (v: number) => Math.max(0, Math.min(1, (v - 397) / 403))
    for (let i = 1; i <= 4; i++) {
      const g = get(`glow${i}`)
      if (g) {
        heatColor(chtN, TMP)
        g.material.emissive.copy(TMP)
        g.material.emissiveIntensity = 0.55 + chtN * 2.0
      }
      const e = get(`egt${i}`)
      if (e) {
        const egtV = s[`egt${i}` as "egt1"] ?? 300
        const n = egtN(egtV)
        heatColor(n, TMP)
        e.material.emissive.copy(TMP)
        e.material.emissiveIntensity = 0.45 + n * 2.2
      }
      // Spark pulses white for misfire and orange for knock on affected cylinders.
      const sp = get(`spark${i}`)
      if (sp) {
        const isMis = misfire && misCyl === i
        const isKnock = knock && knockCyl === i
        if (isMis || isKnock) {
          sp.material.emissive.set(isKnock ? "#F2994A" : "#ffffff")
          sp.material.emissiveIntensity = 1.4
          sp.material.opacity = 0.25 + 0.75 * Math.abs(Math.sin(el * 25))
        } else {
          sp.material.emissiveIntensity = 0.15
          sp.material.opacity = 0.7
        }
      }
      // Injectors: pulse rate proportional to fuel flow; dim on clog.
      const inj = get(`inj${i}`)
      if (inj) {
        let op = 0.3 + 0.7 * Math.abs(Math.sin(el * (0.5 + s.fuelFlow * 2.2)))
        if (clogCyl === i) op *= 0.15
        inj.material.opacity = op
      }
    }

    // X-ray bodies glow with CHT across the cylinder.
    for (let i = 1; i <= 4; i++) {
      const cb = get(`cylBody${i}`)
      if (cb) {
        heatColor(chtN, TMP)
        cb.material.emissive.copy(TMP)
        cb.material.emissiveIntensity = 0.35 + chtN * 2.0
      }
    }

    // Prop blur disc fades in with rpm. Blades fade out.
    const spin = Math.min(1, shared.current.dispRpm / 8000)
    M.blade.opacity = 1 - spin * 0.65
    M.blur.opacity = spin * 0.32 * (on ? 1 : 0)

    // Fuel rail pulse with travelling flow dots.
    const rail = get("rail")
    if (rail) {
      let op = 0.3 + 0.7 * Math.abs(Math.sin(el * (0.4 + s.fuelFlow * 1.8)))
      if (codes.includes(3)) op *= 0.35
      rail.material.opacity = op
    }
    for (let k = 1; k <= 5; k++) {
      const d = get(`fdot${k}`)
      if (d) {
        const speed = 0.25 + s.fuelFlow * 0.55
        d.position.set(((el * speed + (k - 1) * 0.28) % 1.4) - 0.7, 0.6, 0)
        d.material.opacity = (0.2 + 0.8 * Math.min(1, s.fuelFlow / 2)) * (on ? 1 : 0.15)
      }
    }

    // Oil tank color follows temp. Gallery turns red below 1.2 bar.
    const oilN = Math.max(0, Math.min(1, (s.oilTemp - 85) / 40))
    const tank = get("oilTank")
    if (tank) {
      heatColor(oilN, TMP)
      tank.material.emissive.copy(TMP)
      tank.material.emissiveIntensity = 0.5 + oilN * 0.9
    }
    const gallery = get("oilGallery")
    if (gallery) {
      if (s.oilPressure < 1.2) {
        gallery.material.emissive.set("#DC2626")
        gallery.material.emissiveIntensity = 0.5 + 0.9 * Math.abs(Math.sin(el * 8))
      } else {
        gallery.material.emissive.set("#0284C7")
        gallery.material.emissiveIntensity = 0.45
      }
    }

    // Coolant radiator from health index; electrical red on sag.
    const rad = get("rad")
    if (rad) rad.material.color.set(health3(s.health?.cool ?? 100))
    const battBad = s.battV < 24 || (s.health?.elec ?? 100) < 50
    const batt = get("batt")
    if (batt) batt.material.color.set(battBad ? "#DC2626" : "#EFD6D6")
    const alt = get("alt")
    if (alt) alt.material.color.set(battBad ? "#DC2626" : "#EFD6D6")

    // Turbo glow follows boost. Bearing pins pulse on wear.
    const turbo = get("turbo")
    if (turbo) {
      const boost = Math.max(0, Math.min(1, (s.map - 1.6) / 0.9))
      turbo.material.emissive.set("#F2994A")
      turbo.material.emissiveIntensity = boost * 1.4
    }

    // Crankcase glow follows oil temp.
    const cse = get("caseGlow")
    if (cse) {
      heatColor(oilN, TMP)
      cse.material.emissive.copy(TMP)
      cse.material.emissiveIntensity = 0.5 + oilN * 0.9
    }

    // Collector glows with the hottest cylinder.
    const col = get("collector")
    if (col) {
      const mx = Math.max(s.egt1, s.egt2, s.egt3, s.egt4)
      const n = egtN(mx)
      heatColor(n, TMP)
      col.material.emissive.copy(TMP)
      col.material.emissiveIntensity = 0.3 + n * 2.2
    }

    // Wind streaks follow rpm. Still air while engine is off.
    const air = on ? (0.25 + (s.rpm / 10000) * 2.5) * 0.7 : 0
    const windN = WIND_SPOTS.length
    for (let k = 1; k <= windN; k++) {
      const wm = get(`wind${k}`)
      if (wm) {
        wm.visible = on
        if (!on) continue
        let x = wm.position.x - air * cl
        if (x < -2.4) x = 2.4
        wm.position.x = x
      }
    }

    // Cooling dashes follow cooling command. Still while engine is off.
    const coolRate = on ? (0.3 + (s.controls?.cooling ?? 1) * 1.2) * 0.7 : 0
    for (let k = 1; k <= 4; k++) {
      const cm = get(`cool${k}`)
      if (cm) {
        cm.visible = on
        if (!on) continue
        let x = cm.position.x - coolRate * cl
        if (x < 0.68) x = 1.4
        cm.position.x = x
      }
    }
    const bearing = codes.includes(5)
    for (let i = 1; i <= 4; i++) {
      const pin = get(`pin${i}`)
      if (pin) {
        if (bearing) {
          pin.material.emissive.set("#DC2626")
          pin.material.emissiveIntensity = 0.5 + 0.8 * Math.abs(Math.sin(el * 6))
        } else {
          pin.material.emissive.set("#0284C7")
          pin.material.emissiveIntensity = 0.7
        }
      }
    }

    // Fault marker blinks red on failed parts. Only emissive changes, heat logic restores after clear.
    const bl = Math.sin(el * 9) > 0 ? 1 : 0.12
    const alarm = (0.4 + 5.2 * bl)
    const paint = (name: string, k = 1) => {
      const mm = get(name)
      if (mm) {
        mm.material.emissive.set("#DC2626")
        mm.material.emissiveIntensity = alarm * k
      }
    }
    if (misfire) {
      paint(`glow${misCyl || 3}`)
      paint(`cylBody${misCyl || 3}`, 0.9)
    }
    if (codes.includes(2)) {
      paint(`inj${clogCyl || 2}`)
      paint(`cylBody${clogCyl || 2}`, 0.9)
    }
    if (codes.includes(3)) {
      paint("rail")
      paint("fdot1", 0.9)
      paint("fdot2", 0.9)
      paint("fdot3", 0.9)
    }
    if (codes.includes(4)) {
      paint("oilTank")
      paint("oilGallery", 1.2)
    }
    if (codes.includes(5)) paint("caseGlow", 0.9)
    if (codes.includes(6)) {
      paint("cylBody1", 0.9)
      paint("glow1", 0.8)
    }
    if (codes.includes(7)) paint("rad", 1.2)
    if (codes.includes(8)) {
      for (let i = 1; i <= 4; i++) {
        paint(`glow${i}`, 0.9)
        paint(`cylBody${i}`, 0.8)
      }
    }
    if (knock) {
      paint(`glow${knockCyl || 2}`)
      paint(`cylBody${knockCyl || 2}`, 0.9)
    }
    if (codes.includes(10)) paint("rail", 0.8)
    if (codes.includes(11)) {
      paint("turbo", 1.2)
      paint("collector")
    }
    if (codes.includes(12)) {
      const bb = get("batt")
      if (bb) {
        bb.material.color.set("#DC2626")
        bb.material.emissive.set("#DC2626")
        bb.material.emissiveIntensity = alarm
      }
      const al = get("alt")
      if (al) {
        al.material.color.set("#DC2626")
        al.material.emissive.set("#DC2626")
        al.material.emissiveIntensity = alarm
      }
    }
    if (codes.includes(13)) paint("caseGlow", 0.8)
    if (codes.includes(14)) {
      for (let i = 1; i <= 4; i++) paint(`egt${i}`, 0.7)
      paint("collector", 0.8)
    }

    // Injection timing needle: 20 deg = center, +/-10 = +/-60deg sweep.
    if (needle.current) {
      needle.current.rotation.z = -((s.injTiming - 20) / 10) * (Math.PI / 3)
    }

    // Kinematics: piston slide along Z + connecting rod to crank pin.
    const th = crank.current ? crank.current.rotation.x : 0
    for (let i = 0; i < 4; i++) {
      const side = CYL_SIDE[i]
      const pistonZ = side * (0.3 + 0.09 * Math.sin(th + FIRE_PHASE[i]))
      const pm = get(`piston${i + 1}`)
      if (pm) pm.position.z = pistonZ
      const ly = CRANK_R * Math.sin(FIRE_PHASE[i])
      const lz = CRANK_R * Math.cos(FIRE_PHASE[i])
      PIN.set(CYL_X[i], CRANK_Y + ly * Math.cos(th) - lz * Math.sin(th),
              ly * Math.sin(th) + lz * Math.cos(th))
      ATT.set(CYL_X[i], 0, pistonZ - side * 0.1)
      updateRod(get(`rod${i + 1}`), ATT, PIN)
    }
  })

  return (
    <group ref={mount}>
      <group ref={root}>
        <FaultBeacon snapRef={snapRef} />
        {/* Wing outlines with engine between. */}
        <DashedShell g={G.wingLeft} p={[0.1, -0.32, 1.6]}
                     tint="#9CC3FF" fillOp={0.04} lineOp={0.28} ghost />
        <DashedShell g={G.wingA} p={[0.1, -0.32, -0.2]}
                     tint="#9CC3FF" fillOp={0.04} lineOp={0.28} ghost />
        <DashedShell g={G.wingB} p={[0.1, -0.32, -1.3]}
                     tint="#9CC3FF" fillOp={0.04} lineOp={0.28} ghost />
        <DashedShell g={G.wingC} p={[0.1, -0.32, -2.6]}
                     tint="#9CC3FF" fillOp={0.04} lineOp={0.28} ghost />

        {/* Transparent cowling shell. */}
        <DashedShell g={G.cowl} p={[-0.1, 0, 0]} r={[0, 0, Math.PI / 2]} s={[1, 0.95, 0.95]}
                     tint="#BFD9FF" fillOp={1} lineOp={0.6} />

        {/* Block frame. */}
        <P g={G.block} m={M.frame} p={[0, -0.08, 0]} name="block" />

        {/* Four cylinders with per-cylinder glow. */}
        {CYL_X.map((x, i) => {
          const side = CYL_SIDE[i]
          const n = i + 1
          return (
            <group key={n}>
              <P g={G.cylBody} m={M.cylBody[i]} p={[x, 0, side * 0.42]} r={[Math.PI / 2, 0, 0]}
                 name={`cylBody${n}`} />
              {[0.26, 0.36, 0.46].map((z) => (
                <P key={z} g={G.fin} m={M.frame} p={[x, 0, side * z]} />
              ))}
              <P g={G.head} m={M.frame} p={[x, 0, side * 0.72]} />
              <P g={G.glow} m={M.glow[i]} p={[x, 0, side * 0.6]} r={[Math.PI / 2, 0, 0]}
                 name={`glow${n}`} edge={null} />
              <mesh name={`spark${n}`} position={[x, 0, side * 0.8]} material={M.spark[i]} geometry={G.spark} />
              <mesh name={`piston${n}`} position={[x, 0, side * 0.3]} rotation={[Math.PI / 2, 0, 0]}
                    material={M.steel} geometry={G.piston} />
              <mesh name={`rod${n}`} material={M.steel} geometry={G.rod} />
              <mesh name={`egt${n}`} material={M.egt[i]} geometry={G.exh[i]} />
            </group>
          )
        })}

        {/* Crankshaft group with pins. */}
        <group ref={crank} position={[0, CRANK_Y, 0]}>
          <P g={G.crankShaft} m={M.steel} r={[0, 0, Math.PI / 2]} />
          {CYL_X.map((x, i) => (
            <group key={i}>
              <P g={G.counter} m={M.mid} p={[x, 0, 0]} r={[0, 0, Math.PI / 2]} />
              <mesh name={`pin${i + 1}`} material={M.pin[i]} geometry={G.pin}
                    position={[x, CRANK_R * Math.sin(FIRE_PHASE[i]), CRANK_R * Math.cos(FIRE_PHASE[i])]}
                    rotation={[0, 0, Math.PI / 2]} />
            </group>
          ))}
        </group>

        {/* Exhaust collector and turbo. */}
        <mesh name="collector">
          <tubeGeometry args={[new THREE.CatmullRomCurve3([
            new THREE.Vector3(0.72, -0.72, 0.1),
            new THREE.Vector3(0.3, -0.75, 0.05),
            new THREE.Vector3(-0.3, -0.75, -0.05),
            new THREE.Vector3(-0.8, -0.7, -0.08),
          ]), 24, 0.045, 10, false]} />
          <meshStandardMaterial color="#C9CFD6" emissive="#EF4444" emissiveIntensity={0.3} />
        </mesh>
        <P g={G.turbo} m={M.turbo} p={[-0.88, -0.68, -0.12]} r={[Math.PI / 2, 0, 0]} name="turbo" />

        {/* Intake plenum and runners. */}
        <P g={G.plenum} m={M.frame} p={[0, 0.42, 0]} />
        {G.runner.map((geo, i) => (
          <mesh key={`r${i}`} geometry={geo}>
            <meshStandardMaterial color="#DFD0AC" metalness={0.3} roughness={0.5} />
          </mesh>
        ))}

        {/* Fuel rail, injectors, and flow dots. */}
        <P g={G.rail} m={M.rail} p={[0, 0.6, 0]} r={[0, 0, Math.PI / 2]} name="rail" />
        {CYL_X.map((x, i) => (
          <mesh key={`inj${i}`} name={`inj${i + 1}`} material={M.inj[i]} geometry={G.inj}
                position={[x, 0.51, 0]} />
        ))}
        {[1, 2, 3].map((k) => (
          <mesh key={`fdot${k}`} name={`fdot${k}`} material={M.fdot[k - 1]} geometry={G.fdot}
                position={[(k - 2) * 0.47, 0.6, 0]} />
        ))}

        {/* Oil tank and gallery. */}
        <P g={G.oilTank} m={M.oilTank} p={[-1.02, -0.3, 0.18]} name="oilTank" />
        <mesh name="oilGallery">
          <tubeGeometry args={[new THREE.CatmullRomCurve3([
            new THREE.Vector3(-0.95, -0.25, 0.1),
            new THREE.Vector3(-0.85, -0.18, 0.06),
            new THREE.Vector3(-0.75, -0.1, 0.04),
          ]), 16, 0.02, 10, false]} />
          <meshStandardMaterial color="#BFE0DA" emissive="#0284C7" emissiveIntensity={0.45} />
        </mesh>

        {/* Coolant radiator. */}
        <P g={G.rad} m={M.rad} p={[0.62, -0.45, 0]} name="rad" />

        {/* Crankcase glow. */}
        <mesh name="caseGlow" material={M.caseGlow} geometry={G.caseGlow}
              position={[0, -0.3, 0]} />

        {/* Wind streaks past the engine. */}
        {WIND_SPOTS.map((w, k) => (
          <mesh key={`wind${k}`} name={`wind${k + 1}`} material={M.wind} geometry={G.wind}
                position={[w[0], w[1], w[2]]} />
        ))}

        {/* Cooling airflow dashes. */}
        {[1, 2, 3, 4].map((k) => (
          <mesh key={`cool${k}`} name={`cool${k}`} material={M.cool} geometry={G.cool}
                position={[1.3, -0.45, (k - 2.5) * 0.15]} />
        ))}

        {/* Battery and alternator. */}
        <P g={G.batt} m={M.batt} p={[-1.02, 0.32, -0.18]} name="batt" />
        <P g={G.alt} m={M.alt} p={[-0.92, 0.32, 0.22]} r={[0, 0, Math.PI / 2]} name="alt" />

        {/* Injection timing dial and needle. */}
        <P g={G.dial} m={M.mid} p={[0.72, 0.62, 0]} r={[Math.PI / 2, 0, 0]} />
        <group ref={needle} position={[0.72, 0.645, 0]}>
          <mesh position={[0, 0.037, 0]} material={M.needle} geometry={G.needle} />
        </group>

        {/* Propeller with rpm-driven blur disc. */}
        <group ref={prop} position={[0.88, 0, 0]}>
          <P g={G.hub} m={M.steel} r={[0, 0, Math.PI / 2]} />
          <P g={G.blade} m={M.blade} edge={null} />
          <P g={G.blade} m={M.blade} r={[(2 * Math.PI) / 3, 0, 0]} edge={null} />
          <P g={G.blade} m={M.blade} r={[(4 * Math.PI) / 3, 0, 0]} edge={null} />
          <mesh name="blur" material={M.blur} geometry={G.blur}
                position={[0.02, 0, 0]} rotation={[0, Math.PI / 2, 0]} />
        </group>
      </group>
    </group>
  )
}

function health3(v: number): string {
  if (v >= 70) return "#16A34A"
  if (v >= 40) return "#CA8A04"
  return "#DC2626"
}
