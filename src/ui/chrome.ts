import type { Engine, EngineState } from '../core/Engine'
import type { Frame } from '../core/types'
import type { Sound } from './sound'
import { BRAND, MICROCOPY } from '../content'
import { CONCEPT_TAG, WORDMARK, markSvg } from './mark'
import { holdInert, releaseInert } from './inert'
import { mountRotateGate } from './rotate'
import { bindScene, holdScene, onScenePause, releaseScene } from './scene'
import { createSwap } from './swap'

/*
 * Persistent chrome: the masthead and slugs of a sheet on the press.
 *
 *   corners       crop marks at the four corners of the viewport (the trim),
 *                 registration targets at the mid-edges on wide screens, and
 *                 a job slug bottom centre, like the waste margin of a press
 *                 sheet
 *   top-left      the Hark mark (black loops, green diamond, a pink drum a
 *                 hair off register) + the real "Hark.Digital" wordmark (its
 *                 dot is a drop of green ink) and a "Concept · Press" tag
 *                 (→ back to start)
 *   top-right     Work · Services · Contact (a riso highlight prints under
 *                 the current one) + a green "Start a project" sticker
 *                 (≤ 820px: Menu → a full-screen contents sheet that feeds
 *                 in from the top)
 *   bottom-left   AUDIO sticker switch, with the three drums (pink, green,
 *                 black) that thump with the press when it is running
 *   bottom-right  PRINT RUN: "Sheet 03 / 07 — Type Case · Services" (the
 *                 sheet number stamps over like a numbering machine) and a
 *                 colour bar with one clickable patch per chapter,
 *                 proportional to its length, that prints as you read
 *
 * Stages that print on a solid ink ground (.on-ink on the stage) flip the
 * chrome to paper type. All bands respect env(safe-area-inset-*). Visitor
 * jumps go through engine.land().
 *
 * API: createChrome(root, engine, sound) -> { update(frame, state) }
 */

const NAV = [
  { id: 'work', label: 'Work' },
  { id: 'services', label: 'Services' },
  { id: 'contact', label: 'Contact' },
]

/** Plain business names shown beside each chapter's print-shop name. */
const PLAIN: Record<string, string> = {
  hero: 'Home',
  work: 'Work',
  services: 'Services',
  voices: 'Clients',
  shield: 'Security',
  process: 'Process',
  contact: 'Contact',
}

/** each sheet's patch in the colour bar: the three drums in turn */
const INK = ['k', 'p', 'g']

const AUDIO_ON = 'On'
const AUDIO_OFF = 'Off'

const pad2 = (n: number) => String(n).padStart(2, '0')
const esc = (s: string) => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!)

const arrowSvg = `<svg class="ch-arrow" viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path d="M2 8h11M9 3.5 13.5 8 9 12.5"/></svg>`
const regSvg = (cls: string) =>
  `<svg class="${cls}" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><circle cx="12" cy="12" r="6.5"/><path d="M12 1V23M1 12H23"/></svg>`

export function createChrome(root: HTMLElement, engine: Engine, sound: Sound) {
  const slots = engine.slots
  const total = slots.length
  const indexOf = (id: string) => slots.findIndex(s => s.def.id === id)
  const plainOf = (id: string, fallback: string) => PLAIN[id] ?? fallback
  const nav = NAV.filter(n => indexOf(n.id) >= 0)

  mountRotateGate()
  // rotate card, open menu: an unseen scene is not rendered
  bindScene(engine)
  // chapters stop updating while the scene is paused, so let go of any tone they asked for
  onScenePause.push(paused => {
    if (paused) sound.hush()
  })
  // dev-only handle for audio checks in headless tests
  if (import.meta.env.DEV) (window as unknown as { __harkSound?: Sound }).__harkSound = sound

  const navLinks = nav
    .map(n => `<li><a class="ch-link" href="#${n.id}" data-goto="${n.id}"><span class="ch-link-txt">${n.label}</span></a></li>`)
    .join('')

  // the colour bar: one patch per chapter, as long as the chapter is
  const segs = slots
    .map((s, i) => {
      const plain = plainOf(s.def.id, s.def.label)
      return `<button class="ch-seg" type="button" data-goto="${s.def.id}" data-i="${i}" data-ink="${INK[i % INK.length]}" style="flex:${s.def.length} 1 0" aria-label="Sheet ${i + 1} of ${total}: ${esc(plain)} (${esc(s.def.label)})"><i class="ch-patch"><b></b></i></button>`
    })
    .join('')

  const menuItems = slots
    .map((s, i) => {
      const plain = plainOf(s.def.id, s.def.label)
      return `<li style="--i:${i}"><a class="ch-ml" href="#${s.def.id}" data-goto="${s.def.id}" aria-label="${esc(plain)}, ${esc(s.def.label)}">
        <span class="ch-ml-n" aria-hidden="true">${pad2(i + 1)}</span>
        <span class="ch-ml-name" aria-hidden="true">${esc(plain)}</span>
        <span class="ch-ml-tag" aria-hidden="true"><span class="ch-ml-now">Printing</span>${esc(s.def.label)}</span>
      </a></li>`
    })
    .join('')

  const brandInner = `<span class="ch-mark">${markSvg('ch-mark-svg')}</span>
        <span class="ch-brand-text" aria-hidden="true">
          <span class="ch-word">${WORDMARK}</span>
          <span class="ch-sub">${CONCEPT_TAG}</span>
        </span>`

  root.innerHTML = `
  <div class="chrome">
    <div class="ch-marks" aria-hidden="true">
      <i class="ch-crop ch-crop--tl"></i><i class="ch-crop ch-crop--tr"></i><i class="ch-crop ch-crop--bl"></i><i class="ch-crop ch-crop--br"></i>
      ${regSvg('ch-reg ch-reg--t')}${regSvg('ch-reg ch-reg--b')}${regSvg('ch-reg ch-reg--l')}${regSvg('ch-reg ch-reg--r')}
      <p class="ch-slug">Job HRK-2026 <b>·</b> Pink <b>/</b> Green <b>/</b> Black<span class="ch-slug-x"> <b>·</b> 80gsm newsprint</span></p>
    </div>

    <header class="ch-top">
      <a class="ch-brand" href="#hero" data-goto="hero" aria-label="${esc(BRAND.name)}, back to start">
        ${brandInner}
      </a>
      <nav class="ch-nav" aria-label="Primary">
        <ul class="ch-links">${navLinks}</ul>
        <a class="ch-cta" href="#contact" data-goto="contact" data-focus><span>Start a project</span>${arrowSvg}</a>
      </nav>
      <button class="ch-menu-btn" type="button" aria-expanded="false" aria-controls="ch-menu" aria-haspopup="dialog">
        <span class="ch-menu-btn-txt">Menu</span><span class="ch-menu-icon" aria-hidden="true"><i></i><i></i></span>
      </button>
    </header>

    <div class="ch-menu" id="ch-menu" role="dialog" aria-modal="true" aria-labelledby="ch-menu-title" data-lenis-prevent hidden>
      <div class="ch-menu-sheet">
        <div class="ch-menu-top">
          <span class="ch-brand ch-menu-brand" aria-hidden="true">${brandInner}</span>
          <button class="ch-menu-btn ch-menu-close" type="button" aria-label="Close menu">
            <span class="ch-menu-btn-txt" aria-hidden="true">Close</span><span class="ch-menu-icon" aria-hidden="true"><i></i><i></i></span>
          </button>
        </div>
        <div class="ch-menu-body">
          <p class="hud-eyebrow ch-menu-eyebrow"><span id="ch-menu-title">Contents</span><span aria-hidden="true"> · ${total} sheets</span></p>
          <ol class="ch-menu-list">${menuItems}</ol>
          <div class="ch-menu-foot">
            <a class="hud-btn ch-menu-cta" href="#contact" data-goto="contact">Start a project ${arrowSvg}</a>
            <a class="ch-menu-mail" href="mailto:${BRAND.email}">${BRAND.email}</a>
          </div>
          <p class="ch-menu-slug" aria-hidden="true">Job HRK-2026 <b>·</b> ${esc(BRAND.locale)}</p>
        </div>
        <span class="ch-menu-dots" aria-hidden="true"></span>
      </div>
    </div>

    <div class="ch-bottom">
      <button class="ch-audio" type="button" data-sound-toggle aria-pressed="false">
        <span class="ch-switch" aria-hidden="true"><i></i></span>
        <span class="ch-audio-txt">${MICROCOPY.audio}<span class="ch-audio-colon" aria-hidden="true">:</span> <span class="ch-audio-state" aria-hidden="true">${AUDIO_OFF}</span></span>
        <span class="ch-drums" aria-hidden="true"><i class="ch-drum ch-drum--p"></i><i class="ch-drum ch-drum--g"></i><i class="ch-drum ch-drum--k"></i></span>
      </button>

      <div class="ch-run">
        <p class="ch-readout" aria-hidden="true">
          <span class="ch-key">Sheet</span>
          <span class="ch-num"></span>
          <span class="ch-of">/ ${pad2(total)}</span>
          <span class="ch-dash">—</span>
          <span class="ch-names"><span class="ch-title"></span><span class="ch-plain"></span></span>
        </p>
        <nav class="ch-bar" aria-label="Chapters">
          ${regSvg('ch-bar-reg')}
          <span class="ch-segs">${segs}</span>
          ${regSvg('ch-bar-reg')}
        </nav>
      </div>
    </div>
  </div>`

  const $ = <T extends Element = HTMLElement>(s: string) => root.querySelector<T>(s)!
  const chrome = $('.chrome')
  const soundBtn = $<HTMLButtonElement>('.ch-audio')
  const soundState = $('.ch-audio-state')
  const drumEls = [...root.querySelectorAll<HTMLElement>('.ch-drum')]
  const menuBtn = $<HTMLButtonElement>('.ch-top .ch-menu-btn')
  const menuClose = $<HTMLButtonElement>('.ch-menu-close')
  const menu = $('.ch-menu')
  const segEls = [...root.querySelectorAll<HTMLButtonElement>('.ch-seg')]
  const navEls = [...root.querySelectorAll<HTMLAnchorElement>('.ch-link')]
  const menuLinks = [...root.querySelectorAll<HTMLAnchorElement>('.ch-ml')]
  const keyEl = $('.ch-key')
  const numSw = createSwap($('.ch-num'))
  const titleSw = createSwap($('.ch-title'))
  const plainSw = createSwap($('.ch-plain'))

  // header-first tab order: the chrome comes before the active chapter's content
  const stagesEl = document.getElementById('stages')
  if (stagesEl && stagesEl.parentNode === root.parentNode && root.compareDocumentPosition(stagesEl) & Node.DOCUMENT_POSITION_PRECEDING) {
    stagesEl.parentNode!.insertBefore(root, stagesEl)
  }

  // ---------------------------------------------------------------- navigation

  const go = (id: string) => {
    if (indexOf(id) >= 0) engine.land(id)
  }

  root.addEventListener('click', e => {
    const a = (e.target as Element).closest<HTMLElement>('[data-goto]')
    if (!a || !root.contains(a)) return
    e.preventDefault()
    const id = a.dataset.goto!
    const fromMenu = menuOpen && menu.contains(a)
    if (menuOpen) closeMenu(false)
    sound.stamp(a.matches('.ch-cta, .ch-menu-cta') ? 1 : 0.7)
    go(id)
    // menu links always hand focus on (the menu they lived in is gone); the
    // top nav, CTA and colour bar do it for keyboard activation (click.detail 0)
    if (fromMenu || (e.detail === 0 && (a.matches('.ch-link, .ch-seg, .ch-brand') || a.hasAttribute('data-focus'))))
      engine.focusChapter(id)
  })

  // a fingertip tap on hover
  root.querySelectorAll<HTMLElement>('.ch-link, .ch-cta, .ch-seg, .ch-brand, .ch-audio, .ch-menu-btn, .ch-ml').forEach((node, i) => {
    node.addEventListener('pointerenter', e => {
      if ((e as PointerEvent).pointerType !== 'touch') sound.blip(i)
    })
  })

  // ------------------------------------------------------- print-run readout

  let lastIndex = -1
  let cueIndex = -1
  const showSheet = (i: number, instant = false) => {
    const s = slots[i]
    if (!s) return
    numSw.set(pad2(i + 1), instant)
    titleSw.set(esc(s.def.label), instant)
    plainSw.set(`· ${esc(plainOf(s.def.id, s.def.label))}`, instant)
  }
  const cue = (i: number) => {
    cueIndex = i
    chrome.classList.add('is-cue')
    keyEl.textContent = 'Go to'
    showSheet(i)
  }
  const uncue = () => {
    if (cueIndex < 0) return
    cueIndex = -1
    chrome.classList.remove('is-cue')
    keyEl.textContent = 'Sheet'
    if (lastIndex >= 0) showSheet(lastIndex)
  }
  segEls.forEach((seg, i) => {
    seg.addEventListener('pointerenter', () => cue(i))
    seg.addEventListener('focus', () => cue(i))
    seg.addEventListener('pointerleave', uncue)
    seg.addEventListener('blur', uncue)
  })

  // --------------------------------------------------------------------- sound

  const syncSound = (on: boolean) => {
    soundBtn.setAttribute('aria-pressed', String(on))
    soundState.textContent = on ? AUDIO_ON : AUDIO_OFF
    chrome.classList.toggle('is-live', on)
  }
  soundBtn.addEventListener('click', () => sound.toggle())
  sound.onChange.push(syncSound)
  syncSound(sound.enabled)

  // ---------------------------------------------------------------- mobile menu

  // A real modal: its own Close button lives inside the dialog (drawn exactly
  // where Menu sits), focus moves in on open and back on close, Escape closes,
  // and everything behind it is inert while it is open. The sheet feeds in
  // from the top of the press; its lines stamp down one after another.
  let menuOpen = false
  let hideTimer = 0
  let pauseTimer = 0
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches
  const focusables = () =>
    [...menu.querySelectorAll<HTMLElement>('a[href], button')].filter(el => !el.hidden && el.getClientRects().length > 0)
  const openMenu = () => {
    if (menuOpen) return
    menuOpen = true
    clearTimeout(hideTimer)
    menu.hidden = false
    // flush the closed state so the feed transition runs
    void menu.offsetWidth
    chrome.classList.add('is-menu')
    menuBtn.setAttribute('aria-expanded', 'true')
    holdInert('menu', [
      document.getElementById('stages'),
      document.getElementById('track'),
      document.querySelector<HTMLElement>('.skip-link'),
      $('.ch-top'),
      $('.ch-bottom'),
    ])
    engine.lenis.stop()
    sound.sfx('rustle', 0.6)
    // once the sheet has fully covered the scene, stop rendering it
    clearTimeout(pauseTimer)
    pauseTimer = window.setTimeout(() => menuOpen && holdScene('menu'), reduced ? 60 : 640)
    menu.scrollTop = 0
    const now = menuLinks[lastIndex] ?? menuLinks[0]
    now?.focus({ preventScroll: true })
  }
  const closeMenu = (restoreFocus = true) => {
    if (!menuOpen) return
    menuOpen = false
    chrome.classList.remove('is-menu')
    menuBtn.setAttribute('aria-expanded', 'false')
    releaseInert('menu')
    clearTimeout(pauseTimer)
    releaseScene('menu')
    engine.lenis.start()
    hideTimer = window.setTimeout(() => {
      if (!menuOpen) menu.hidden = true
    }, reduced ? 30 : 420)
    if (restoreFocus) menuBtn.focus({ preventScroll: true })
  }
  menuBtn.addEventListener('click', () => (menuOpen ? closeMenu() : openMenu()))
  menuClose.addEventListener('click', () => closeMenu())
  window.addEventListener('keydown', e => {
    if (!menuOpen) return
    if (e.key === 'Escape') {
      e.preventDefault()
      closeMenu()
    } else if (e.key === 'Tab') {
      const f = focusables()
      if (!f.length) return
      const i = f.indexOf(document.activeElement as HTMLElement)
      const next = e.shiftKey ? (i <= 0 ? f.length - 1 : i - 1) : i < 0 || i === f.length - 1 ? 0 : i + 1
      e.preventDefault()
      f[next].focus()
    }
  })
  matchMedia('(min-width: 821px)').addEventListener('change', e => {
    if (e.matches) closeMenu(false)
  })

  // -------------------------------------------------------------------- reveal

  let revealed = false
  const revealChrome = () => {
    if (revealed) return
    revealed = true
    chrome.classList.add('is-in')
  }
  if (document.documentElement.dataset.ready) revealChrome()
  else window.addEventListener('hark:reveal', revealChrome, { once: true })
  // safety net: never leave the chrome hidden
  const safety = () => (document.querySelector('#loader .ld') ? window.setTimeout(safety, 2000) : revealChrome())
  window.setTimeout(safety, 9000)

  // -------------------------------------------------------------------- update

  let ink = false
  let flood = false
  let lastF = -1
  const drumV = [-1, -1, -1]

  // a new sheet: its patch in the colour bar takes the impression. Played with
  // the Web Animations API, so a restart never needs a style/layout flush
  let impress: Animation | null = null
  const pulseCut = (i: number) => {
    impress?.cancel()
    impress = null
    const patch = segEls[i]?.firstElementChild as HTMLElement | null
    if (reduced || !patch || typeof patch.animate !== 'function') return
    impress = patch.animate([{ transform: 'scale(1.25, 1.7)' }, { transform: 'none' }], {
      duration: 420,
      easing: 'cubic-bezier(0.3, 1.6, 0.5, 1)',
    })
  }

  return {
    update(_frame: Frame, state: EngineState) {
      const slot = state.slots[state.index]
      if (!slot) return

      if (state.index !== lastIndex) {
        const first = lastIndex < 0
        lastIndex = state.index
        if (cueIndex < 0) showSheet(state.index, first)
        segEls.forEach((t, i) => {
          t.classList.toggle('is-active', i === state.index)
          t.classList.toggle('is-past', i < state.index)
          if (i === state.index) t.setAttribute('aria-current', 'step')
          else t.removeAttribute('aria-current')
        })
        navEls.forEach(a => {
          const on = a.dataset.goto === slot.def.id
          a.classList.toggle('is-active', on)
          if (on) a.setAttribute('aria-current', 'location')
          else a.removeAttribute('aria-current')
        })
        menuLinks.forEach((a, i) => {
          a.classList.toggle('is-now', i === state.index)
          if (i === state.index) a.setAttribute('aria-current', 'location')
          else a.removeAttribute('aria-current')
        })
        chrome.dataset.chapter = slot.def.id
        lastF = -1
        if (!first) pulseCut(state.index)
      }

      // paper type over a stage printed on solid ink (not at the green flood of a cut)
      const cutT = engine.post.transition
      const onInk = slot.stage.classList.contains('on-ink') && cutT < 0.5
      if (onInk !== ink) {
        ink = onInk
        chrome.classList.toggle('is-ink', ink)
      }
      const inFlood = cutT > 0.35
      if (inFlood !== flood) {
        flood = inFlood
        chrome.classList.toggle('is-flood', flood)
      }

      // the current sheet's patch prints left to right as you read
      const f = Math.min(1, Math.max(0, state.local))
      if (Math.abs(f - lastF) > 0.001) {
        lastF = f
        segEls[state.index]?.style.setProperty('--f', f.toFixed(4))
      }

      // the three drums thump with the press (quantised so styles only change on a real step)
      for (let i = 0; i < 3; i++) {
        const v = sound.enabled ? Math.round(sound.pulse(i) * 8) / 8 : 0
        if (v !== drumV[i]) {
          drumV[i] = v
          drumEls[i].style.setProperty('--pulse', String(v))
        }
      }
    },
  }
}
