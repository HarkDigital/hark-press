import * as THREE from 'three'
import { clamp } from '../../core/math'
import type { Ink } from '../../print/ink'

/*
 * HERO — "Proof". Shared timeline, layout and small helpers.
 *
 *   0.00–0.08  LAYOUT  the sheet is a pencil layout of the headline; the
 *                      three blocks wait, inked, at its head
 *   0.08–0.49  PASSES  key prints MAKE THE / INTERNET (LISTEN. hollow),
 *                      green fills LISTEN., pink prints the mark
 *   0.43–0.52  REGISTER the plates click into register
 *   0.53–0.68  PULL    the sheet peels off the bed and turns into a poster
 *   0.68–0.90  POSTER  settled, with its credit and buttons
 *   0.90–1.00  OUT     the poster is whisked away, green floods the sheet
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
  { a: 0.08, contact: 0.145, b: 0.215 },
  { a: 0.215, contact: 0.28, b: 0.35 },
  { a: 0.35, contact: 0.415, b: 0.49 },
]

export const T = {
  /** register error: full until regA, clicks to zero by regB */
  regA: 0.43,
  regB: 0.52,
  /** the pull */
  peelA: 0.53,
  liftA: 0.58,
  poster: 0.68,
  /** DOM beats */
  ticketB: 0.16,
  ticketPort: 0.105,
  hintB: 0.07,
  readA: 0.1,
  readB: 0.5,
  titleA: 0.64,
  /** the poster is settled, credit and buttons in (the keyboard anchor) */
  settled: 0.8,
  /** poster whisked away */
  outA: 0.9,
}

export const INK_OF: Ink[] = [
  [0, 0, 1],
  [0, 1, 0],
  [1, 0, 0],
]
export const INK_NAME = ['Key', 'Green', 'Pink']

/** Register error per ink, in sheet units at full error (black is the reference drum, but it drifts too). */
export const REG_OFFSET: [number, number][] = [
  [-0.05, 0.035],
  [0.085, -0.06],
  [-0.1, -0.12],
]

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

/** Sheet + print layout. Landscape sheets carry the mark on the right, the headline on the left; portrait stacks them (mark on top). */
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
  return { port: true, w: 4.3, h: 6.7, mx: 0, my: 1.7, mh: 2.15, skew: -0.035 }
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
