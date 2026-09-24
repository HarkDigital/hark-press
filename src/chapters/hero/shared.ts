import * as THREE from 'three'
import { clamp } from '../../core/math'
import type { Ink } from '../../print/ink'

/*
 * HERO — "Proof". Shared timeline, layout and small helpers.
 *
 *   0.00–0.10  BLANK   a sheet of newsprint feeds onto the cutting mat
 *   0.10–0.56  PASSES  three blocks drop, squash and lift: key, green, pink
 *   0.47–0.60  REGISTER the three impressions click into register
 *   0.60–0.92  PULL    the sheet peels off the bed and turns into a poster
 *   0.92–1.00  OUT     the poster is whisked away, green floods the sheet
 */

export interface Pass {
  /** block leaves its hanger */
  a: number
  /** block meets the sheet */
  contact: number
  /** block gone */
  b: number
}

/** each block is home before the next one leaves (no mid-air crossings) */
export const PASSES: Pass[] = [
  { a: 0.085, contact: 0.155, b: 0.245 },
  { a: 0.245, contact: 0.315, b: 0.405 },
  { a: 0.405, contact: 0.475, b: 0.565 },
]

export const T = {
  /** register error: full until regA, clicks to zero by regB */
  regA: 0.5,
  regB: 0.592,
  /** the pull */
  peelA: 0.6,
  liftA: 0.655,
  poster: 0.77,
  /** DOM beats */
  ticketB: 0.085,
  hintB: 0.06,
  readA: 0.12,
  readB: 0.6,
  titleA: 0.745,
  titleB: 0.995,
  /** poster whisked away */
  outA: 0.9,
}

export const INK_OF: Ink[] = [
  [0, 0, 1],
  [0, 1, 0],
  [1, 0, 0],
]
export const INK_NAME = ['Key', 'Green', 'Pink']
export const INK_CODE = ['K', 'G', 'P']

/** Register error per ink, in sheet units at full error (black is the reference drum, but it drifts too). */
export const REG_OFFSET: [number, number][] = [
  [-0.07, 0.045],
  [0.16, -0.1],
  [-0.12, -0.15],
]
/** the register error readout at full error */
export const REG_MM = 3.2

/**
 * Register error 1 → 0. It clicks down like a micrometer knob: eight detents,
 * each with a little overshoot, instead of sliding.
 */
export function registerError(local: number) {
  const x = clamp((local - T.regA) / (T.regB - T.regA))
  const n = 8
  const f = x * n
  const k = Math.floor(f)
  const s = f - k
  // each detent: fast snap, small overshoot, settle
  const snap = s < 0.55 ? 1 - Math.pow(1 - s / 0.55, 3) * 1.0 : 1
  const over = s < 0.55 ? 0 : Math.sin(((s - 0.55) / 0.45) * Math.PI) * 0.12 * (1 - (s - 0.55) / 0.45)
  const steps = Math.min(n, k + snap + over)
  return clamp(1 - steps / n)
}

/** Sheet + print layout. Landscape sheets carry the mark on the right, the headline on the left; portrait stacks them. */
export interface Layout {
  port: boolean
  w: number
  h: number
  /** mark centre (sheet units, y = up the print) and height */
  mx: number
  my: number
  mh: number
  /** hand-placed skew of the sheet on the bed (radians around world y) */
  skew: number
}

export function layoutFor(aspect: number): Layout {
  if (aspect >= 0.95) return { port: false, w: 6.8, h: 4.6, mx: 1.78, my: 0.12, mh: 2.5, skew: -0.045 }
  return { port: true, w: 4.3, h: 6.7, mx: 0, my: 1.46, mh: 2.5, skew: -0.035 }
}

/** Hermite ease with overshoot (snappy stop-motion landings). */
export function backOut(t: number, s = 1.9) {
  const x = clamp(t) - 1
  return 1 + (s + 1) * x * x * x + s * x * x
}

export const easeInCubic = (t: number) => {
  const x = clamp(t)
  return x * x * x
}
export const easeOutCubic = (t: number) => {
  const x = 1 - clamp(t)
  return 1 - x * x * x
}
export const easeInOut = (t: number) => {
  const x = clamp(t)
  return x * x * (3 - 2 * x)
}

/** Seconds, quantized to "twos" (12 drawings a second) for the hand-made parts. */
export const onTwos = (t: number, fps = 12) => Math.floor(t * fps) / fps

const _m = new THREE.Matrix4()

/** Quaternion for a sheet whose print faces `normal` with its top toward `up`. */
export function sheetQuat(normal: THREE.Vector3, up: THREE.Vector3, out: THREE.Quaternion) {
  const z = normal.clone().normalize()
  const x = new THREE.Vector3().crossVectors(up, z).normalize()
  const y = new THREE.Vector3().crossVectors(z, x)
  _m.makeBasis(x, y, z)
  return out.setFromRotationMatrix(_m)
}

/** The press's ink shade direction (from the upper left, over the operator's shoulder). */
export const LIGHT = new THREE.Vector3(-0.5, 0.85, 0.35).normalize()
