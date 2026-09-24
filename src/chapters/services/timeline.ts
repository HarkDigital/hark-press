import { SERVICES } from '../../content'

/*
 * The Type Case run sheet (local progress 0..1 of the chapter).
 *
 *  0.000–0.085  in-beat + intro. We open inside the wet green ink on the
 *               slab (matching the ink-flood cut) and pull back to the case,
 *               the chase already locked up with WHAT WE DO.
 *               "Eleven ways to be heard."
 *  0.085–0.833  eleven jobs, one per service. Each job:
 *                 distribute the last line back into the case, set the new
 *                 one (sorts hop out of their compartments in arcs; its slip
 *                 goes up on the HUD pile as the first sort lifts), lock up
 *                 the furniture, roll ink across (green or pink), drop a
 *                 sheet, press, peel the proof, and the slip's PROOF stamp
 *                 comes down.
 *  0.833–0.933  the finale job sets HARK and pulls the last proof, bold.
 *  0.933–1.000  out-beat: back into the green ink for the cut.
 */

export const INTRO_END = 0.085
export const BEAT = 0.068
export const SVC_END = INTRO_END + SERVICES.length * BEAT
export const FIN_LEN = 0.1
export const OUT_START = SVC_END + FIN_LEN
/** services + the HARK finale */
export const JOBS = SERVICES.length + 1

/** what each job sets in wood type (the full title lives in the HUD) */
export const INTRO_WORD = 'WHAT WE DO'
export const SET_WORDS = [
  'SOFTWARE',
  'WEB DESIGN',
  'ECOMMERCE',
  'SEO/GEO',
  'PAGE SPEED',
  'AI',
  'AERIAL',
  'REMEDIATION',
  'SECURITY',
  'ADA',
  'WORDPRESS',
  'HARK',
]

/** 0 = green drum (right slab), 1 = pink drum (left slab); -1 = the intro line (black) */
export const inkOf = (job: number) => (job < 0 ? -1 : job === JOBS - 1 ? 0 : job % 2)

export const jobStart = (k: number) => (k < SERVICES.length ? INTRO_END + k * BEAT : SVC_END)
export const jobLen = (k: number) => (k < SERVICES.length ? BEAT : FIN_LEN)

/** phases inside a job (fractions of the job) */
export const PH = {
  /** last line goes back to the case */
  dist0: 0.0,
  distSpan: 0.12,
  /** one sort's hop */
  hop: 0.15,
  /** new line is set (the HUD slip switches to it here) */
  set0: 0.07,
  setSpan: 0.13,
  /** furniture: unlock (start of job) / lock up (after setting) */
  unlock1: 0.05,
  lock0: 0.35,
  lock1: 0.41,
  /** brayer */
  roll0: 0.39,
  roll1: 0.57,
  /** sheet: drop, press, peel, fly */
  drop0: 0.55,
  drop1: 0.63,
  press1: 0.67,
  peel1: 0.8,
  fly1: 0.92,
  /** the proof is pulled: the slip's PROOF stamp comes down */
  pull: 0.72,
  /** settled: type inked, sheet gone, slip up */
  anchor: 0.94,
}

export interface JobPhase {
  /** -1 intro, 0..JOBS-1 */
  k: number
  /** 0..1 inside the job (clamped to 1 after the finale) */
  p: number
}

export function jobAt(local: number, out: JobPhase): JobPhase {
  if (local < INTRO_END) {
    out.k = -1
    out.p = local / INTRO_END
  } else if (local < SVC_END) {
    out.k = Math.min(SERVICES.length - 1, Math.floor((local - INTRO_END) / BEAT))
    out.p = (local - jobStart(out.k)) / BEAT
  } else {
    out.k = JOBS - 1
    out.p = Math.min(1, (local - SVC_END) / FIN_LEN)
  }
  return out
}

/** Local progress where service k is settled (proof pulled, sheet gone). */
export const ANCHORS = SERVICES.map((_, k) => jobStart(k) + PH.anchor * BEAT)
