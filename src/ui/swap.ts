import { rise, setRise } from '../core/dom'

/*
 * A one-line readout that changes with the site's stamp motion: the old words
 * lift off the sheet while the new ones stamp down in the same spot (two
 * stacked cards in one grid cell). Used by the chrome's print-run readout.
 * Text is always exact.
 */
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
      if (instant) inn.classList.add('sw-instant')
      // flush the "above the sheet" start state so the stamp always plays
      void inn.offsetWidth
      setRise(inn, true)
      // once the old words have lifted away, drop them so they never widen the line
      clearTimeout(clearTimer)
      clearTimer = window.setTimeout(() => {
        if (out !== cur) out.textContent = ''
      }, 420)
    },
  }
}
