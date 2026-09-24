import { BRAND, CONTACT, PROCESS, SECTIONS, SECURITY, SERVICES, STATS, TESTIMONIALS, WORK } from '../content'

/*
 * The accessible layer. Each chapter's copy, as plain linear semantic HTML,
 * lives inside that chapter's scroll <section> in #track. It is visually
 * hidden (the canvas + stages are the visual layer and are aria-hidden), but
 * screen readers, crawlers and keyboard users get the whole story in order.
 * Focusing a link here moves the visuals to its chapter (Engine.land), and
 * the focused link itself becomes visible (.sr-copy :focus-visible in base.css).
 *
 * renderFallback() reuses the same builders, visibly, when WebGL2 is missing.
 */

const esc = (s: string) =>
  s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!)

const isPreview = (url: string) => /harktest\.com/.test(url)

const ext = (href: string, label: string, anchor?: number) =>
  `<a href="${esc(href)}" target="_blank" rel="noopener"${anchor != null ? ` data-anchor="${anchor}"` : ''}>${esc(label)}<span class="sr-note"> (opens in a new tab)</span></a>`

/** An in-page stop that moves the story to item i of a chapter (see Chapter.anchors). */
const stop = (id: string, i: number, label: string) => `<a href="#${id}" data-anchor="${i}">${esc(label)}</a>`

const COPY: Record<string, () => string> = {
  hero: () => `
    <p class="sr-kicker">${esc(BRAND.name)} · ${esc(BRAND.locale)}</p>
    <h1>${esc(BRAND.tagline)}</h1>
    <p>${esc(BRAND.manifesto)}</p>
    <p><a href="#work" data-land="work">See the work</a> · <a href="#contact" data-land="contact">Start a project</a></p>`,

  work: () => `
    <h2>${esc(SECTIONS.work.title)}</h2>
    <p>${esc(SECTIONS.work.eyebrow)} — ${WORK.length} sites.</p>
    <ul>${WORK.map(
      (w, i) =>
        `<li><h3>${esc(w.name)}</h3><p>${esc(w.industry)}. ${esc(w.blurb)}</p><p>${ext(
          w.url,
          isPreview(w.url) ? `Preview ${w.name} (pre-launch build)` : `Visit ${w.name}`,
          i,
        )}</p></li>`,
    ).join('')}</ul>`,

  services: () => `
    <h2>${esc(SECTIONS.services.title)}</h2>
    <p>${esc(SECTIONS.services.eyebrow)}.</p>
    <ol>${SERVICES.map(
      (s, i) => `<li><h3>${stop('services', i, s.title)}</h3><p>${esc(s.blurb)}</p><p>${s.tags.map(esc).join(' · ')}</p></li>`,
    ).join('')}</ol>`,

  shield: () => `
    <h2>${esc(SECURITY.title)}</h2>
    <p>${esc(SECURITY.eyebrow)}.</p>
    <p>${esc(SECURITY.body)}</p>
    <p><a href="${esc(SECURITY.href)}" data-anchor="0">${esc(SECURITY.cta.replace(/\s*→\s*$/, ''))}</a></p>`,

  voices: () => `
    <h2>${esc(SECTIONS.voices.title)}</h2>
    <p>${esc(SECTIONS.voices.eyebrow)}.</p>
    ${TESTIMONIALS.map(
      (t, i) =>
        `<figure><blockquote><p>${esc(t.quote)}</p></blockquote><figcaption>${stop('voices', i, `${t.name}, ${t.company}`)}</figcaption></figure>`,
    ).join('')}`,

  process: () => `
    <p>How we work</p>
    <h2>We listen first. Then we build.</h2>
    <ol>${PROCESS.map((p, i) => `<li><h3>${stop('process', i, p.title)}</h3><p>${esc(p.text)}</p></li>`).join('')}</ol>
    <ul>${[STATS[0], STATS[2], STATS[1]].map(s => `<li>${esc(s.value)}: ${esc(s.label)}</li>`).join('')}</ul>`,

  contact: () => `
    <h2>${esc(CONTACT.title)}</h2>
    <p>${esc(CONTACT.body)}</p>
    <p>Write to: <a href="${esc(CONTACT.href)}">${esc(BRAND.email)}</a> <button type="button" data-copy-email>Copy email address</button> <span data-copy-status aria-live="polite"></span></p>
    <p>Elsewhere: ${ext(BRAND.classicSite, 'the classic 2026 site')} · ${ext(BRAND.orbitSite, 'the Orbit concept')} · ${ext(BRAND.resonanceSite, 'the Resonance concept')}</p>
    <p>Printed in: © ${new Date().getFullYear()} ${esc(BRAND.name)} · ${esc(BRAND.locale)}</p>
    <p><a href="#hero" data-land="hero">Back to top</a></p>`,
}

/** Visually hidden, linear copy for one chapter (null for unknown ids). */
export function buildChapterCopy(id: string, visible = false): HTMLElement | null {
  const html = COPY[id]
  if (!html) return null
  const div = document.createElement('div')
  div.className = visible ? 'fallback-copy' : 'sr-copy'
  div.innerHTML = html()
  // in-page links drive the story instead of jumping to an empty section
  div.querySelectorAll<HTMLAnchorElement>('a[data-land]').forEach(a =>
    a.addEventListener('click', e => {
      const target = a.dataset.land!
      const hark = window.__hark
      if (!hark) return
      e.preventDefault()
      if (target === 'hero') hark.goto(0)
      else hark.land(target)
      hark.engine.focusChapter(target)
    }),
  )
  // item stops only steer the story (focus does the work); never follow the hash
  div.querySelectorAll<HTMLAnchorElement>('a[data-anchor][href^="#"]').forEach(a =>
    a.addEventListener('click', e => e.preventDefault()),
  )
  div.querySelectorAll<HTMLButtonElement>('[data-copy-email]').forEach(btn =>
    btn.addEventListener('click', async () => {
      const status = div.querySelector<HTMLElement>('[data-copy-status]')
      let ok = false
      try {
        await navigator.clipboard.writeText(BRAND.email)
        ok = true
      } catch {
        const ta = document.createElement('textarea')
        ta.value = BRAND.email
        ta.setAttribute('readonly', '')
        ta.style.position = 'fixed'
        ta.style.opacity = '0'
        document.body.appendChild(ta)
        ta.select()
        try {
          ok = document.execCommand('copy')
        } catch {
          ok = false
        }
        ta.remove()
      }
      if (status) status.textContent = ok ? 'Copied' : `Copy failed — the address is ${BRAND.email}`
    }),
  )
  return div
}

export const CHAPTER_COPY_IDS = Object.keys(COPY)
