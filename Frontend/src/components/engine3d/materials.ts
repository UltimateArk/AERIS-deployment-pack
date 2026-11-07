import * as THREE from "three"

// Temperature ramp from blue to red. Base colors stay outside the ramp for clear heat signal.
const STOPS: Array<[number, [number, number, number]]> = [
  [0, [59, 130, 246]], // blue cool
  [0.45, [234, 179, 8]], // yellow slight-high
  [0.7, [249, 115, 22]], // orange
  [1, [239, 68, 68]], // red hot
]

export const EDGE = "#2F6FED" // bright engineering-blue boundaries
export const BG = "#E9EDF2" // light paper background

export function heatColor(norm: number, out: THREE.Color): THREE.Color {
  const t = Math.max(0, Math.min(1, norm))
  let a = STOPS[0]
  let b = STOPS[STOPS.length - 1]
  for (let i = 0; i < STOPS.length - 1; i++) {
    if (t >= STOPS[i][0] && t <= STOPS[i + 1][0]) {
      a = STOPS[i]
      b = STOPS[i + 1]
      break
    }
  }
  const f = (t - a[0]) / (b[0] - a[0] || 1)
  return out.setRGB(
    (a[1][0] + (b[1][0] - a[1][0]) * f) / 255,
    (a[1][1] + (b[1][1] - a[1][1]) * f) / 255,
    (a[1][2] + (b[1][2] - a[1][2]) * f) / 255,
  )
}

export function healthColor(v: number): string {
  if (v >= 70) return "#16A34A"
  if (v >= 40) return "#CA8A04"
  return "#DC2626"
}
