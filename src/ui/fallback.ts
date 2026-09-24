import { BRAND, CONTACT, PROCESS, SECTIONS, SECURITY, SERVICES, STATS, TESTIMONIALS, WORK, workImage } from '../content'
import { CHAPTERS } from '../chapters'
import { CONCEPT_TAG, WORDMARK, markSvg } from './mark'
import { unmountRotateGate } from './rotate'
import { releaseInert } from './inert'

/**
 * Plain HTML version of the story for browsers without WebGL2 (and the
 * last-resort view if boot fails), printed as a riso zine: newsprint, crop
 * marks, poster headlines, stamped tags, and the work screenshots pulled as
 * two-colour duotones. Same copy, same headlines, same sheet names and the
 * same order as the story (and its accessible copy layer), no scene.
 *
 * The masthead is a real banner, rendered before <main id="track">, so the
 * page's "Skip to content" link jumps past it to the story itself.
 * Styled by the .fb-* rules in ui.css.
 */
export function renderFallback(root: HTMLElement) {
  document.documentElement.classList.add('no-webgl')
  unmountRotateGate()
  // boot can fail while the loader still holds the page inert: let go of it
  releaseInert('loader')
  const esc = (s: string) => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!)
  /** second drum: the last word of a headline prints in green */
  const accent = (s: string) => {
    const t = esc(s)
    const i = t.lastIndexOf(' ')
    return i < 0 ? `<em>${t}</em>` : `${t.slice(0, i)} <em>${t.slice(i + 1)}</em>`
  }
  const newTab = '<span class="sr-only"> (opens in a new tab)</span>'
  const isPreview = (url: string) => /harktest\.com/.test(url)
  /** the chapter's own sheet number and print-shop name, exactly as the chrome prints them */
  const sheet = (id: string) => {
    const i = CHAPTERS.findIndex(c => c.id === id)
    if (i < 0) return ''
    return `<p class="fb-sheet" aria-hidden="true"><span>Sheet ${String(i + 1).padStart(2, '0')}</span><b>·</b><span>${esc(CHAPTERS[i].label)}</span></p>`
  }
  const inks = ['p', 'g', 'k']
  // the stats sit where the story prints them: three on the fold's wings, 24/7 on the shredder
  const statOf = (v: string) => STATS.find(s => s.value === v)
  const watch = statOf('24/7')
  const wings = ['10 years', '$1M+', '15'].map(statOf).filter(s => s && s !== watch) as typeof STATS
  for (const s of STATS) if (s !== watch && !wings.includes(s)) wings.push(s)
  const statList = (list: typeof STATS, cls = '') =>
    `<ul class="fb-stats${cls}">${list.map(st => `<li><span class="fb-stat">${esc(st.value)}</span><span class="fb-stat-l">${esc(st.label)}</span></li>`).join('')}</ul>`

  root.style.pointerEvents = 'auto'
  // the masthead: a banner landmark ahead of <main>, which the skip link targets
  document.querySelector('.fb-banner')?.remove()
  const banner = document.createElement('div')
  banner.className = 'fb fb-banner'
  banner.innerHTML = `
    <header class="fb-top" id="fb-top">
      <a class="fb-brand" href="#fb-top" aria-label="${esc(BRAND.name)}, top of page">
        <span class="fb-mark">${markSvg('fb-mark-svg')}</span>
        <span class="fb-brand-text" aria-hidden="true"><span class="fb-word">${WORDMARK}</span><span class="fb-sub">${CONCEPT_TAG}</span></span>
      </a>
      <nav class="fb-nav" aria-label="Primary">
        <a class="fb-link" href="#fb-work">Work</a>
        <a class="fb-link" href="#fb-services">Services</a>
        <a class="fb-link" href="#fb-contact">Contact</a>
        <a class="fb-cta" href="${CONTACT.href}">Start a project</a>
      </nav>
    </header>`
  root.parentNode?.insertBefore(banner, root)
  // the skip link lands on <main> itself (focusable, tabindex -1), past the masthead
  document.querySelector('.skip-link')?.setAttribute('href', `#${root.id || 'track'}`)
  if (!root.hasAttribute('tabindex')) root.tabIndex = -1

  root.innerHTML = `
  <div class="fb">
    <section class="fb-hero" id="fb-hero" aria-labelledby="fb-h1">
      <span class="fb-dots fb-dots--hero" aria-hidden="true"></span>
      <p class="fb-issue" aria-hidden="true"><span>Issue 01</span><b>·</b><span>Printed in Philadelphia</span></p>
      <p class="hud-eyebrow">${esc(BRAND.locale)}</p>
      <h1 class="hud-title fb-h1" id="fb-h1">${accent(BRAND.tagline)}</h1>
      <p class="hud-body fb-lede">${esc(BRAND.manifesto)}</p>
      <p class="fb-actions">
        <a class="hud-btn" href="#fb-work">See the work</a>
        <a class="hud-btn hud-btn--ghost" href="${CONTACT.href}">Start a project</a>
      </p>
    </section>

    <section class="fb-sec" id="fb-work" aria-labelledby="fb-work-h">
      ${sheet('work')}
      <p class="hud-eyebrow">${esc(SECTIONS.work.eyebrow)}</p>
      <h2 class="hud-h2" id="fb-work-h">${accent(SECTIONS.work.title)}</h2>
      <ul class="fb-work">
        ${WORK.map(
          (w, i) => `<li><a class="fb-card" href="${w.url}" target="_blank" rel="noopener">
            <span class="fb-duo fb-duo--${inks[i % 2]}"><img src="${workImage(w.id)}" alt="" loading="lazy" decoding="async" width="1280" height="800"></span>
            <span class="fb-card-row"><span class="fb-card-name">${esc(w.name)}${newTab}</span>${
              isPreview(w.url) ? '<span class="fb-flag">Preview</span>' : ''
            }</span>
            <span class="hud-label">${esc(w.industry)}</span>
          </a></li>`,
        ).join('')}
      </ul>
    </section>

    <section class="fb-sec" id="fb-services" aria-labelledby="fb-services-h">
      ${sheet('services')}
      <p class="hud-eyebrow">${esc(SECTIONS.services.eyebrow)}</p>
      <h2 class="hud-h2" id="fb-services-h">${accent(SECTIONS.services.title)}</h2>
      <ul class="fb-grid">
        ${SERVICES.map(
          (s, i) => `<li class="fb-cell fb-cell--${inks[i % 3]}"><p class="fb-num" aria-hidden="true">${s.num}</p><h3 class="fb-h3">${esc(s.title)}</h3><p class="hud-body">${esc(s.blurb)}</p>
            <ul class="hud-tags fb-tags">${s.tags.map(t => `<li class="hud-tag">${esc(t)}</li>`).join('')}</ul></li>`,
        ).join('')}
      </ul>
    </section>

    <section class="fb-sec" id="fb-voices" aria-labelledby="fb-voices-h">
      ${sheet('voices')}
      <p class="hud-eyebrow">${esc(SECTIONS.voices.eyebrow)}</p>
      <h2 class="hud-h2" id="fb-voices-h">${accent(SECTIONS.voices.title)}</h2>
      <ul class="fb-quotes">
        ${TESTIMONIALS.map(
          (t, i) => `<li><figure class="fb-quote fb-quote--${inks[i % 3]}"><blockquote><p>“${esc(t.quote)}”</p></blockquote><figcaption class="hud-label">${esc(t.name)} · ${esc(t.company)}</figcaption></figure></li>`,
        ).join('')}
      </ul>
    </section>

    <section class="fb-sec fb-sec--security" id="fb-security" aria-labelledby="fb-security-h">
      ${sheet('shield')}
      <p class="hud-eyebrow">${esc(SECURITY.eyebrow)}</p>
      <h2 class="hud-h2" id="fb-security-h">${accent(SECURITY.title)}</h2>
      <p class="hud-body fb-lede">${esc(SECURITY.body)}</p>
      ${watch ? statList([watch], ' fb-stats--one') : ''}
      <p class="fb-actions"><a class="hud-btn hud-btn--ghost" href="${SECURITY.href}">${esc(SECURITY.cta)}</a></p>
    </section>

    <section class="fb-sec" id="fb-process" aria-labelledby="fb-process-h">
      ${sheet('process')}
      <p class="hud-eyebrow">How we work</p>
      <h2 class="hud-h2" id="fb-process-h">We listen first. <em>Then we build.</em></h2>
      <ol class="fb-grid fb-grid--4">
        ${PROCESS.map(
          (p, i) => `<li class="fb-cell fb-cell--${inks[i % 3]}"><p class="fb-num" aria-hidden="true">${String(i + 1).padStart(2, '0')}</p><h3 class="fb-h3">${esc(p.title)}</h3><p class="hud-body">${esc(p.text)}</p></li>`,
        ).join('')}
      </ol>
      ${statList(wings)}
    </section>

    <section class="fb-sec fb-contact" id="fb-contact" aria-labelledby="fb-contact-h">
      ${sheet('contact')}
      <p class="hud-eyebrow">${esc(CONTACT.eyebrow)}</p>
      <h2 class="hud-title" id="fb-contact-h">${esc(CONTACT.title)}</h2>
      <p class="hud-body fb-lede">${esc(CONTACT.body)}</p>
      <p class="fb-actions"><a class="hud-btn hud-btn--ghost" href="${CONTACT.href}">${esc(BRAND.email)} <span aria-hidden="true">→</span></a></p>
    </section>

    <footer class="fb-foot">
      <p>© ${new Date().getFullYear()} ${esc(BRAND.name)} · ${esc(BRAND.locale)}</p>
      <p class="fb-foot-links"><a href="${BRAND.classicSite}">Classic site</a><a href="${BRAND.orbitSite}">Concept · Orbit</a><a href="${BRAND.resonanceSite}">Concept · Resonance</a></p>
    </footer>
  </div>`
}
