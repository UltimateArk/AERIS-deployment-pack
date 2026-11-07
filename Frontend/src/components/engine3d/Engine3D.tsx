import { Suspense, memo, useRef } from "react"
import { Canvas, useFrame, useThree } from "@react-three/fiber"
import * as THREE from "three"
import { BgByAlt, Boxer4Engine, Env } from "./scene"
import { CameraRig } from "./camera"
import { ExternalCallouts } from "./callouts"
import { BG } from "./materials"
import type { SharedAnim, Telemetry3D } from "./types"

// 3D engine viewer. Free orbit camera with fault autofocus. Data flows through snapRef without re-renders.

// Scene weight readout. Draw calls and triangles in window.__aeris_perf.gl.
function GlInfo() {
  const gl = useThree((s) => s.gl)
  const n = useRef(0)
  useFrame(() => {
    if (++n.current < 300) return
    n.current = 0
    const info = gl.info.render
    ;(window as unknown as { __aeris_perf?: object }).__aeris_perf = {
      ...((window as unknown as { __aeris_perf?: object }).__aeris_perf ?? {}),
      glCalls: info.calls,
      glTris: info.triangles,
    }
  })
  return null
}

export const Engine3D = memo(function Engine3D({
  snapRef,
  engineOnRef,
  showCallouts = true,
  dark = false,
  shared: sharedProp,
}: {
  snapRef: React.RefObject<Telemetry3D>
  engineOnRef: React.RefObject<boolean>
  showCallouts?: boolean
  dark?: boolean
  shared?: { current: SharedAnim }
}) {
  const internal = useRef<SharedAnim>({ dispRpm: 0 })
  const shared = sharedProp ?? internal
  return (
    <Canvas
      camera={{ position: [2.5, 1.7, 2.17], fov: 34 }}
      dpr={[1, 2]}
      gl={{ antialias: true, powerPreference: "high-performance" }}
      onCreated={({ gl }) => {
        gl.toneMapping = THREE.ACESFilmicToneMapping
        gl.toneMappingExposure = dark ? 1.0 : 1.05
      }}
      style={{ background: dark ? "#0A0F16" : BG, borderRadius: 8 }}
    >
      <CameraRig snapRef={snapRef} shared={shared} />
      <Env />
      <BgByAlt snapRef={snapRef} dark={dark} />
      <ambientLight intensity={dark ? 0.4 : 0.55} />
      <directionalLight position={[2.5, 3, 2]} intensity={dark ? 1.5 : 1.3} />
      <pointLight position={[2.5, 0.3, -1.5]} intensity={dark ? 0.4 : 0.5} />
      <Suspense fallback={null}>
        <GlInfo />
        <Boxer4Engine snapRef={snapRef} engineOnRef={engineOnRef} shared={shared} />
        {showCallouts && <ExternalCallouts snapshotRef={snapRef} shared={shared} dark={dark} />}
      </Suspense>
    </Canvas>
  )
})
