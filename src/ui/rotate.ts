import { CONCEPT_TAG, WORDMARK, markSvg } from './mark'
import { holdInert, releaseInert } from './inert'
import { holdScene, releaseScene } from './scene'

/*
 * Phone-landscape gate. The press prints in portrait on phones, so a short,
 * touch-first landscape viewport gets a paper card pinned to the sheet
 * ("Turn your phone upright") instead of a cramped scene. Tablets and laptops
 * in landscape are taller than 500px and never see it.
 *
 * Visibility is pure CSS (the same query, in ui.css) so it is right on the
 * very first paint; JS makes the rest of the page inert while it shows,
 * announces it to screen readers, and pauses the (fully hidden) scene
 * (engine.paused, via scene.ts) so a phone held sideways is not rendering
 * WebGL nobody can see.
 */

export const ROTATE_QUERY = '(orientation: landscape) and (max-height: 500px) and (pointer: coarse)'

let gate: { el: HTMLElement; mq: MediaQueryList; sync: () => void; listeners: ((shown: boolean) => void)[] } | null =
  null

/** A little paper phone, cut out and pinned: it turns upright on twos (stop-motion). */
const phoneSvg = () => `
  <svg class="rot-art" viewBox="0 0 120 120" aria-hidden="true" focusable="false">
    <path class="rot-arc" d="M28 34 A40 40 0 0 1 92 30" />
    <path class="rot-arc-head" d="M84 22 L93 30 L82 36" />
    <g class="rot-phone">
      <rect class="rot-phone-shadow" x="41" y="30" width="44" height="74" rx="7" />
      <rect class="rot-phone-body" x="37" y="26" width="44" height="74" rx="7" />
      <rect class="rot-phone-screen" x="42" y="35" width="34" height="54" rx="2" />
      <line class="rot-phone-slot" x1="54" y1="31" x2="64" y2="31" />
      <circle class="rot-phone-btn" cx="59" cy="94.5" r="2.4" />
      <g class="rot-phone-dots">
        <circle cx="52" cy="52" r="4.2" class="rot-dot rot-dot--p" />
        <circle cx="62" cy="62" r="4.2" class="rot-dot rot-dot--g" />
        <circle cx="56" cy="72" r="4.2" class="rot-dot rot-dot--k" />
      </g>
    </g>
  </svg>`

export function mountRotateGate(onChange?: (shown: boolean) => void) {
  if (gate) {
    if (onChange) {
      gate.listeners.push(onChange)
      onChange(gate.mq.matches)
    }
    return
  }
  if (typeof matchMedia === 'undefined') return
  const el = document.createElement('div')
  el.className = 'rot'
  el.setAttribute('role', 'dialog')
  el.setAttribute('aria-modal', 'true')
  el.setAttribute('aria-labelledby', 'rot-title')
  el.setAttribute('aria-describedby', 'rot-sub')
  el.tabIndex = -1
  el.innerHTML = `
    <p class="rot-brand" aria-hidden="true"><span class="rot-brand-mark">${markSvg('rot-brand-svg')}</span><span class="rot-brand-text"><span class="rot-word">${WORDMARK}</span><span class="rot-tag">${CONCEPT_TAG}</span></span></p>
    <p class="rot-slug" aria-hidden="true">Job HRK-2026 <b>·</b> Portrait stock</p>
    <div class="rot-card">
      <i class="rot-crop rot-crop--tl" aria-hidden="true"></i><i class="rot-crop rot-crop--tr" aria-hidden="true"></i>
      <i class="rot-crop rot-crop--bl" aria-hidden="true"></i><i class="rot-crop rot-crop--br" aria-hidden="true"></i>
      <div class="rot-icon">${phoneSvg()}</div>
      <div class="rot-text">
        <p class="hud-eyebrow rot-eyebrow" aria-hidden="true">Wrong way round</p>
        <h2 class="rot-title" id="rot-title">Turn your phone <em>upright.</em></h2>
        <p class="rot-sub" id="rot-sub">The press prints in portrait.</p>
      </div>
      <span class="rot-tape" aria-hidden="true"></span>
    </div>
    <p class="sr-only" aria-live="assertive" data-rot-live></p>`
  document.body.appendChild(el)

  const live = el.querySelector<HTMLElement>('[data-rot-live]')!
  const mq = matchMedia(ROTATE_QUERY)
  const listeners: ((shown: boolean) => void)[] = onChange ? [onChange] : []
  let on = false
  const sync = () => {
    if (mq.matches === on) return
    on = mq.matches
    el.classList.toggle('is-on', on)
    if (on) {
      holdScene('rotate')
      holdInert('rotate', ['chrome', 'stages', 'track', 'loader'].map(id => document.getElementById(id)))
      holdInert('rotate', [document.querySelector<HTMLElement>('.skip-link')])
      // focus is now stranded in an inert layer (or on <body>): bring it in
      el.focus({ preventScroll: true })
      // a live region only speaks when its text changes after it is shown
      requestAnimationFrame(() => (live.textContent = 'Turn your phone upright. The press prints in portrait.'))
    } else {
      releaseInert('rotate')
      releaseScene('rotate')
      live.textContent = ''
    }
    for (const fn of listeners) fn(on)
  }
  mq.addEventListener?.('change', sync)
  gate = { el, mq, sync, listeners }
  sync()
}

/** The plain HTML fallback reads fine in any orientation. */
export function unmountRotateGate() {
  if (!gate) return
  gate.mq.removeEventListener?.('change', gate.sync)
  gate.el.remove()
  releaseInert('rotate')
  releaseScene('rotate')
  gate = null
}
