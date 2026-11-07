import { useEffect, useRef } from "react"
import { useFrame, useThree } from "@react-three/fiber"
import * as THREE from "three"
import type { SharedAnim, Telemetry3D } from "./types"

// Custom orbit rig with drag, zoom, pan, and pinch. Fault autofocus moves target to failed part.
// Pilot input writes the same goals.

const HOME_POS: [number, number, number] = [2.5, 1.7, 2.17]
const HOME_TGT: [number, number, number] = [0, 0.075, 0]
const HOME_DIST = Math.hypot(HOME_POS[0] - HOME_TGT[0], HOME_POS[1] - HOME_TGT[1], HOME_POS[2] - HOME_TGT[2])
const FOCUS_DIST = 2.7 // Frames part closely.
  // Stays outside the engine.
const MIN_DIST = 1.6 // manual zoom stops outside the cowling too
const MAX_DIST = 9
const CYL_X = [-0.62, -0.21, 0.21, 0.62]
const CYL_SIDE = [-1, -1, 1, 1]

function cylAnchor(cyl: number): [number, number, number] {
  const i = Math.min(4, Math.max(1, Math.round(cyl) || 1)) - 1
  return [CYL_X[i], 0.1, CYL_SIDE[i] * 0.6]
}

// Fault code -> 3D focus point (mirrors the part layout in scene.tsx).
export function faultAnchor(s: Telemetry3D): [number, number, number] | null {
  const codes = (s.faultCodes ?? []).filter((c) => c > 0)
  if (!codes.length) return null
  const mag = (s as unknown as { faultMag?: Record<string, number> }).faultMag ?? {}
  const primary = codes.reduce(
    (a, b) => ((mag[String(b)] ?? 0) > (mag[String(a)] ?? 0) ? b : a),
    codes[0],
  )
  return faultAnchorFor(s, primary)
}

// Single-code anchor (one beacon per active fault; camera takes the primary).
export function faultAnchorFor(s: Telemetry3D, code: number): [number, number, number] | null {
  const cylOf = (fid: number) => (s.faultCyl ?? {})[String(fid)] ?? 0
  switch (code) {
    case 1:
    case 2:
    case 9:
      return cylAnchor(cylOf(code) || (code === 2 || code === 9 ? 2 : 3))
    case 3:
      return [0, 0.6, 0] // fuel rail
    case 4:
      return [-1.02, -0.3, 0.18] // oil tank
    case 5:
      return [0, -0.45, 0] // crank/bearings
    case 6:
      return cylAnchor(1) // cyl 1 sealing
    case 7:
      return [0.62, -0.45, 0] // radiator
    case 8:
      return [0, 0.25, 0] // whole hot block
    case 10:
      return [0.72, 0.62, 0] // timing dial
    case 11:
      return [-0.88, -0.68, -0.12] // turbo/collector
    case 12:
      return [-1.02, 0.32, -0.18] // battery
    case 13:
      return [0.62, 0.05, 0.75] // EGT probe cyl 4
    case 14:
      return [0, 0.42, 0] // intake plenum
    default:
      return null
  }
}

const V = () => new THREE.Vector3()

export function CameraRig({ snapRef, shared }: {
  snapRef: React.RefObject<Telemetry3D>
  shared: { current: SharedAnim }
}) {
  const camera = useThree((s) => s.camera)
  const gl = useThree((s) => s.gl)

  // Goals (input writes these; the frame loop eases actual -> goal).
  const g = useRef({
    theta: 0, phi: 1.1, dist: HOME_DIST,
    tgt: V().set(HOME_TGT[0], HOME_TGT[1], HOME_TGT[2]),
  })
  // Actual (eased) state.
  const cur = useRef({
    theta: 0, phi: 1.1, dist: HOME_DIST,
    tgt: V().set(HOME_TGT[0], HOME_TGT[1], HOME_TGT[2]),
  })
  const seen = useRef("")
  const check = useRef(0)
  const homeTheta = useRef(0)
  const homePhi = useRef(1.1)

  // Seed spherical from opening camera position.
  useEffect(() => {
    const off = V().copy(camera.position).sub(g.current.tgt)
    const sph = new THREE.Spherical().setFromVector3(off)
    g.current.theta = sph.theta
    g.current.phi = Math.min(2.9, Math.max(0.2, sph.phi))
    g.current.dist = Math.min(MAX_DIST, Math.max(MIN_DIST, sph.radius))
    cur.current.theta = g.current.theta
    cur.current.phi = g.current.phi
    cur.current.dist = g.current.dist
    homeTheta.current = g.current.theta
    homePhi.current = g.current.phi
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [camera])

  // Direct pointer wiring on the canvas: rotate / pan / wheel / pinch.
  useEffect(() => {
    const el = gl.domElement
    el.style.touchAction = "none"
    const pts = new Map<number, { x: number; y: number; btn: number }>()
    let pinchD = 0
    const onDown = (e: PointerEvent) => {
      el.setPointerCapture?.(e.pointerId)
      pts.set(e.pointerId, { x: e.clientX, y: e.clientY, btn: e.button })
      if (pts.size === 2) {
        const [a, b] = [...pts.values()]
        pinchD = Math.hypot(a.x - b.x, a.y - b.y)
      }
    }
    const onMove = (e: PointerEvent) => {
      const p = pts.get(e.pointerId)
      if (!p) return
      const dx = e.clientX - p.x
      const dy = e.clientY - p.y
      p.x = e.clientX
      p.y = e.clientY
      if (pts.size === 2) {
        // Pinch zoom (touch): dolly by span ratio.
        const [a, b] = [...pts.values()]
        const d = Math.max(1, Math.hypot(a.x - b.x, a.y - b.y))
        if (pinchD > 0) {
          g.current.dist = Math.min(MAX_DIST, Math.max(MIN_DIST, g.current.dist * (pinchD / d)))
        }
        pinchD = d
        return
      }
      if (p.btn === 2) {
        // Right-drag pan in the camera plane, scaled by distance.
        const s = g.current.dist * 0.0016
        const right = V().setFromMatrixColumn(camera.matrix, 0)
        const up = V().setFromMatrixColumn(camera.matrix, 1)
        g.current.tgt.addScaledVector(right, -dx * s).addScaledVector(up, dy * s)
        if (g.current.tgt.length() > 3) g.current.tgt.setLength(3)
        return
      }
      g.current.theta -= dx * 0.0052
      g.current.phi = Math.min(2.9, Math.max(0.2, g.current.phi - dy * 0.0052))
    }
    const onUp = (e: PointerEvent) => {
      pts.delete(e.pointerId)
      pinchD = 0
    }
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      g.current.dist = Math.min(MAX_DIST, Math.max(MIN_DIST,
        g.current.dist * Math.exp(e.deltaY * 0.0011)))
    }
    const onCtx = (e: Event) => e.preventDefault()
    el.addEventListener("pointerdown", onDown)
    el.addEventListener("pointermove", onMove)
    el.addEventListener("pointerup", onUp)
    el.addEventListener("pointercancel", onUp)
    el.addEventListener("wheel", onWheel, { passive: false })
    el.addEventListener("contextmenu", onCtx)
    return () => {
      el.removeEventListener("pointerdown", onDown)
      el.removeEventListener("pointermove", onMove)
      el.removeEventListener("pointerup", onUp)
      el.removeEventListener("pointercancel", onUp)
      el.removeEventListener("wheel", onWheel)
      el.removeEventListener("contextmenu", onCtx)
    }
  }, [camera, gl])

  useFrame(() => {
    if (shared.current.resetView) {
      shared.current.resetView = false
      seen.current = ""
      g.current.tgt.set(HOME_TGT[0], HOME_TGT[1], HOME_TGT[2])
      g.current.dist = HOME_DIST
      g.current.theta = homeTheta.current
      g.current.phi = homePhi.current
    } else {
      check.current += 1
      if (check.current >= 15) {
        // Fault watch at 4 Hz. Pilot drives freely between checks.
        check.current = 0
        const s = snapRef.current
        const key = s ? (s.faultCodes ?? []).filter((c) => c > 0).sort().join(",") : ""
        if (key !== seen.current) {
          seen.current = key
          if (s) {
            const a = faultAnchor(s)
            if (a) {
              g.current.tgt.set(a[0], a[1], a[2])
              g.current.dist = FOCUS_DIST
              // Swing to face the part. Distance lerp dollies in.
              g.current.theta = Math.atan2(a[0] - HOME_TGT[0], a[2] - HOME_TGT[2])
              g.current.phi = 1.05
            } else {
              g.current.tgt.set(HOME_TGT[0], HOME_TGT[1], HOME_TGT[2])
              g.current.dist = HOME_DIST
              g.current.theta = homeTheta.current
              g.current.phi = homePhi.current
            }
          }
        }
      }
    }
    // Ease actual toward goals for damped feel.
    const c = cur.current
    c.theta += (g.current.theta - c.theta) * 0.22
    c.phi += (g.current.phi - c.phi) * 0.22
    c.dist += (g.current.dist - c.dist) * 0.14
    c.tgt.lerp(g.current.tgt, 0.2)
    const off = V().setFromSphericalCoords(c.dist, c.phi, c.theta)
    camera.position.copy(c.tgt).add(off)
    camera.lookAt(c.tgt)
  })
  return null
}
