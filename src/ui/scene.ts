/*
 * Reference-counted "something opaque covers the scene" holds. The phone-
 * landscape rotate card and the fully open mobile menu each hide the WebGL
 * scene completely; while any of them holds, the engine skips rendering
 * (engine.paused) so an unseen press never burns battery.
 *
 * Holds may be taken before the engine exists (the rotate card mounts with
 * the loader, on the very first frame); they apply the moment bindScene() is
 * called.
 */

interface Pausable {
  paused: boolean
}

let target: Pausable | null = null
const holds = new Set<string>()
/** called with the new paused state whenever it flips */
export const onScenePause: ((paused: boolean) => void)[] = []

const apply = () => {
  const paused = holds.size > 0
  if (!target || target.paused === paused) return
  target.paused = paused
  for (const fn of onScenePause) fn(paused)
}

export function bindScene(engine: Pausable) {
  target = engine
  apply()
}

export function holdScene(key: string) {
  holds.add(key)
  apply()
}

export function releaseScene(key: string) {
  if (holds.delete(key)) apply()
}
