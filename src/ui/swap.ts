import { rise, setRise } from '../core/dom'

/*
 * A one-line readout that changes with the site's stamp motion: the old words
 * lift off the sheet while the new ones stamp down in the same spot (two
 * stacked cards in one grid cell). Used by the chrome's print-run readout.
 * Text is always exact.
 *
 * No forced layout: the new card is written in its "above the sheet" start
 * state now, and every card waiting to stamp is flipped to is-in together
 * once the browser has styled that start state in its own rendering pass (a
 * cut used to force a full-document style + layout flush here, per card).
 */

/** cards written since the last flip, stamped down together */
const pending = new Set<() => void>()
let flipRaf = 0
const flipAll = () => {
  flipRaf = 0
  const fns = [...pending]
  pending.clear()
  for (const fn of fns) fn()
}
const schedule = (fn: () => void) => {
  pending.add(fn)
  if (flipRaf) return
  // two frames: set() runs both inside the engine's frame callback and from
  // pointer/focus events between frames; either way one full rendering pass
  // (style of the start state) lies between the write and the flip
  flipRaf = requestAnimationFrame(() => {
    flipRaf = requestAnimationFrame(flipAll)
  })
}

export function createSwap(host: HTMLElement, cardClass = '') {
  host.classList.add('sw')
  const make = () => {
    const s = document.createElement('span')
    s.className = `sw-card ${cardClass}`.trim()
    s.setAttribute('aria-hidden', 'true')
    host.appendChild(s)
    return s
  }
  const a = make()
  const b = make()
  let cur = a
  let html = ''
  let clearTimer = 0
  // stamp the current card down, unless another swap has replaced it since
  const stamp = () => setRise(cur, true)

  return {
    get html() {
      return html
    },
    /** Swap to new markup (<em>/<br> allowed). `instant` skips the motion. */
    set(next: string, instant = false) {
      if (next === html) return
      html = next
      const out = cur
      const inn = cur === a ? b : a
      cur = inn
      out.classList.add('is-out')
      setRise(out, false)
      inn.classList.remove('is-out', 'is-in', 'sw-instant')
      rise(inn, next)
      inn.removeAttribute('aria-label')
      if (instant) {
        // no motion to play, so no start state to wait for
        inn.classList.add('sw-instant')
        pending.delete(stamp)
        setRise(inn, true)
      } else schedule(stamp)
      // once the old words have lifted away, drop them so they never widen the line
      clearTimeout(clearTimer)
      clearTimer = window.setTimeout(() => {
        if (out !== cur) out.textContent = ''
      }, 420)
    },
  }
}
