/**
 * Boot screen. STUB — the UI build replaces the internals.
 * API: createLoader(root, { skip }) -> { progress(0..1), finish(): Promise<void> }
 */
export function createLoader(root: HTMLElement, { skip = false } = {}) {
  root.innerHTML = `<div style="position:absolute;inset:0;display:grid;place-items:center;background:var(--paper);font:500 12px var(--font-mono);letter-spacing:.1em;color:var(--ink);transition:opacity .5s">PRINTING <span data-pct>000</span>%</div>`
  const wrap = root.firstElementChild as HTMLElement
  const pct = root.querySelector<HTMLElement>('[data-pct]')!
  return {
    progress(p: number) {
      pct.textContent = String(Math.round(p * 100)).padStart(3, '0')
    },
    finish(): Promise<void> {
      if (skip) {
        root.remove()
        return Promise.resolve()
      }
      wrap.style.opacity = '0'
      return new Promise(r =>
        setTimeout(() => {
          root.remove()
          r()
        }, 550),
      )
    },
  }
}
