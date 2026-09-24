import * as THREE from 'three'
import type { CameraPose, Chapter, ChapterContext, Frame } from '../../core/types'
import { el, rise, setRise } from '../../core/dom'
import { clamp, ease, lerp, segment, smoothstep } from '../../core/math'
import { BRAND, CONTACT } from '../../content'
import { inkMaterial, inkLineMaterial } from '../../print/ink'
import { buildFold, OP_COUNT } from './fold'
import { drawCardArt, loadCardFonts, POSTMARK_RECT, CARD_U, CARD_V } from './art'
import {
  blockShadowMaterial,
  impressionMaterial,
  matMaterial,
  shadowMaterial,
  sheetMaterial,
  sheetUniforms,
} from './materials'
import './contact.css'

/*
 * AIRMAIL — the last sheet of the run (1.5 vh, nav lands at 0.3).
 *
 * The paper dart from The Fold glides in over a pink cutting mat, lands,
 * and is unfolded — last crease first — into the thing it was folded from:
 * an airmail postcard, message side up, addressed to the studio. A rubber
 * stamp comes down and cancels it (PHILADELPHIA · 2026). The copy is set
 * beside the mat like a poster: "Say hello.", the address as the primary
 * link, a copy button, the sister concepts and the colophon.
 *
 *   0.00–0.17  the dart glides in on a banked, descending curve (plays out
 *              of the ink flood); touchdown + skid to 0.19
 *   0.185–0.265 unfold: wings up, topple onto its side, open the centre
 *              fold, then the nose flaps (each slaps flat with a bounce)
 *   0.255–0.29 the sheet relaxes: residual crease relief comes up
 *   0.258–0.294 the postmark stamp: drop, squash, lift (ink at contact)
 *   0.19–0.27  the copy stamps in
 *   0.30–0.81  hold; the free corner lifts a little in the draught
 *   0.815–0.88 a second stamp: END OF PRINT RUN (green) across the corner;
 *              the pink END OF PRINT RUN tag lands beside the eyebrow by 0.85
 */

const PI = Math.PI
/** card yaw on the table (a casual, slightly crooked lay) */
const YAW = -0.055
/** hold camera elevation (near flat-lay, never exactly overhead) */
const HOLD_EL = (86.5 * PI) / 180
const FOV = 30
const TABLE_Y = 0.004
const WING_FLIGHT = 1.38

const TL = {
  flight: [0.0, 0.17] as const,
  skid: [0.165, 0.19] as const,
  wings: [0.185, 0.201] as const,
  tip: [0.197, 0.215] as const,
  open: [0.211, 0.236] as const,
  f2: [0.231, 0.252] as const,
  f1: [0.246, 0.266] as const,
  settle: [0.258, 0.292] as const,
  stamp: [0.258, 0.294] as const,
  end: [0.815, 0.878] as const,
}

/** a fold closing from `from` to 0 over [a,b]: eases in, slaps flat, bounces once */
function unfold(l: number, a: number, b: number, from: number, bounce = 0.16) {
  const t = segment(l, a, b)
  const hit = 0.72
  if (t < hit) {
    const k = t / hit
    return from * (1 - ease.inOutCubic(k))
  }
  const k = (t - hit) / (1 - hit)
  return bounce * Math.sin(PI * k) * (1 - k * 0.35)
}

/** Copy text to the clipboard: async Clipboard API, then a textarea fallback. */
async function copyText(text: string) {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch {
    /* denied / unsupported: fall through */
  }
  const ta = document.createElement('textarea')
  ta.value = text
  ta.setAttribute('readonly', '')
  ta.setAttribute('aria-hidden', 'true')
  ta.style.cssText = 'position:fixed;top:0;left:0;width:1px;height:1px;opacity:0;pointer-events:none;'
  const active = document.activeElement as HTMLElement | null
  document.body.appendChild(ta)
  ta.select()
  ta.setSelectionRange(0, text.length)
  let ok = false
  try {
    ok = document.execCommand('copy')
  } catch {
    ok = false
  }
  ta.remove()
  active?.focus?.({ preventScroll: true })
  return ok
}

type Rect = { x0: number; y0: number; x1: number; y1: number }

export default function create(): Chapter {
  const group = new THREE.Group()
  const sheet = new THREE.Group() // sheet space → world (plane in flight, card on the table)
  group.add(sheet)
  const angles = new Float32Array(OP_COUNT)
  let fold!: ReturnType<typeof buildFold>
  let u!: ReturnType<typeof sheetUniforms>
  let foldMesh!: THREE.Mesh
  let foldShadow!: THREE.Mesh
  let cardMesh!: THREE.Mesh
  let cardShadow!: THREE.Mesh
  let foldShadowMat!: THREE.ShaderMaterial
  let cardShadowMat!: THREE.ShaderMaterial
  let mat!: THREE.Mesh
  let matMat!: THREE.ShaderMaterial
  const stamp = new THREE.Group()
  const stampBody = new THREE.Group()
  let impression!: THREE.Mesh
  let impressionMat!: THREE.ShaderMaterial
  let reduced = false
  let mobile = false
  /** the scroll as the paper sees it (sampled on twos) */
  const held = { l: 0, at: -1 }

  // rest transform of the card on the table
  const restQ = new THREE.Quaternion()
  const restMatrix = new THREE.Matrix4()
  const qYaw = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), YAW)
  {
    const qTip = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -PI / 2)
    restQ.copy(qYaw).multiply(qTip)
    restMatrix.compose(new THREE.Vector3(0, TABLE_Y, 0), restQ, new THREE.Vector3(1, 1, 1))
  }
  const sheetToWorld = (x: number, y: number, out = new THREE.Vector3()) => out.set(x, y, 0).applyMatrix4(restMatrix)

  // ---------------------------------------------------------------- HUD
  const hud = {} as {
    probe: HTMLElement
    copy: HTMLElement
    eyebrow: HTMLElement
    endTag: HTMLElement
    title: HTMLElement
    body: HTMLElement
    mailRow: HTMLElement
    mail: HTMLAnchorElement
    copyBtn: HTMLButtonElement
    links: HTMLElement
    foot: HTMLElement
  }
  const box = {
    dirty: true,
    w: 0,
    h: 0,
    portrait: false,
    art: { x0: 0, y0: 0, x1: 1, y1: 1 } as Rect,
  }

  function buildHud(stage: HTMLElement) {
    const probe = el('div', 'ct-probe', undefined, stage)
    probe.setAttribute('aria-hidden', 'true')
    const copy = el('div', 'ct-copy', undefined, stage)

    const head = el('div', 'ct-head', undefined, copy)
    const eyeRow = el('div', 'ct-eyerow', undefined, head)
    const eyebrow = rise(el('p', 'hud-eyebrow ct-eyebrow', undefined, eyeRow), CONTACT.eyebrow)
    const endTag = el('p', 'ct-end', undefined, eyeRow)
    endTag.innerHTML = `<span class="ct-end-k">End of print run</span><span class="ct-end-v">07 / 07</span>`
    const words = CONTACT.title.split(' ')
    const last = words.pop() ?? ''
    const title = rise(el('h2', 'hud-title ct-title', undefined, head), `${words.join(' ')} <br><em>${last}</em>`)

    const main = el('div', 'ct-main', undefined, copy)
    const body = el('p', 'hud-body ct-body', CONTACT.body, main)

    const mailRow = el('div', 'ct-mailrow', undefined, main)
    const mail = el('a', 'ct-mail', undefined, mailRow)
    mail.href = CONTACT.href
    mail.setAttribute('aria-label', `Email ${BRAND.email}`)
    const at = BRAND.email.indexOf('@')
    const addr = el('span', 'ct-mail-addr', undefined, mail)
    addr.append(BRAND.email.slice(0, at))
    el('span', 'ct-mail-at', '@', addr)
    addr.append(BRAND.email.slice(at + 1))
    el('span', 'ct-mail-go', '→', mail).setAttribute('aria-hidden', 'true')

    const copyBtn = el('button', 'hud-btn hud-btn--ghost ct-copybtn', undefined, mailRow)
    copyBtn.type = 'button'
    copyBtn.setAttribute('aria-label', `Copy ${BRAND.email}`)
    el('span', 'ct-copy-idle', 'Copy email', copyBtn)
    el('span', 'ct-copy-done', 'Copied', copyBtn)
    let resetT = 0
    copyBtn.addEventListener('click', async () => {
      const ok = await copyText(BRAND.email)
      window.clearTimeout(resetT)
      copyBtn.classList.toggle('is-copied', ok)
      copyBtn.classList.toggle('is-failed', !ok)
      resetT = window.setTimeout(() => copyBtn.classList.remove('is-copied', 'is-failed'), 1800)
    })

    const links = el('nav', 'ct-links', undefined, main)
    links.setAttribute('aria-label', 'Elsewhere')
    const addLink = (label: string, href: string) => {
      const a = el('a', 'ct-link', label, links)
      a.href = href
      a.target = '_blank'
      a.rel = 'noopener noreferrer'
      el('span', 'ct-ext', '↗', a).setAttribute('aria-hidden', 'true')
    }
    addLink('Classic site', BRAND.classicSite)
    addLink('Orbit concept', BRAND.orbitSite)
    addLink('Resonance concept', BRAND.resonanceSite)
    const top = el('button', 'ct-link ct-top', 'Back to top', links)
    top.type = 'button'
    el('span', 'ct-ext', '↑', top).setAttribute('aria-hidden', 'true')
    top.addEventListener('click', () => window.__hark?.goto(0))

    const foot = el('p', 'ct-foot', undefined, copy)
    const parts = [`© 2026 ${BRAND.name}`, ...BRAND.locale.split(' · '), 'Printed on the web']
    parts.forEach((p, i) => {
      if (i) foot.append(' · ')
      el('span', 'ct-nw', p, foot)
    })

    Object.assign(hud, { probe, copy, eyebrow, endTag, title, body, mailRow, mail, copyBtn, links, foot })

    const dirty = () => (box.dirty = true)
    if (typeof ResizeObserver !== 'undefined') {
      const ro = new ResizeObserver(dirty)
      ro.observe(copy)
      ro.observe(probe)
    }
    window.addEventListener('resize', dirty)
    document.fonts?.ready.then(dirty).catch(() => {})
  }

  const isPortrait = (w: number, h: number) => w < 768 || w / Math.max(1, h) < 0.9

  /*
   * Short viewports (a 1280x720 laptop at 125%, a short window): step the
   * copy down until it fits its band, so nothing runs into the AUDIO
   * sticker or the docket. 1 drops the colophon, 2 and 3 set smaller type,
   * 4 drops the body (the postcard prints its first line anyway).
   * Measured with offsets, so the stamp-in transforms never skew it.
   */
  const FIT = ['ct-fit-1', 'ct-fit-2', 'ct-fit-3', 'ct-fit-4'] as const
  function fitCopy(stage: HTMLElement, portrait: boolean, band: number) {
    stage.classList.remove(...FIT)
    const copy = hud.copy
    const fits = () => {
      // portrait: the copy stacks up from the bottom; keep a third of the band for the mat
      if (portrait) return copy.offsetHeight <= band * 0.68
      let bottom = 0
      for (const k of copy.children) {
        const e = k as HTMLElement
        bottom = Math.max(bottom, e.offsetTop + e.offsetHeight)
      }
      return bottom <= copy.clientHeight + 1
    }
    for (let i = 0; i < FIT.length && !fits(); i++) stage.classList.add(FIT[i])
  }

  function measure(frame: Frame) {
    if (!hud.copy) return
    if (!box.dirty && box.w === frame.width && box.h === frame.height) return
    box.dirty = false
    box.w = frame.width
    box.h = frame.height
    const W = frame.width
    const H = frame.height
    const portrait = isPortrait(window.innerWidth || W, window.innerHeight || H)
    box.portrait = portrait
    const stage = hud.copy.parentElement!
    stage.classList.toggle('ct-portrait', portrait)
    const p = hud.probe.getBoundingClientRect()
    fitCopy(stage, portrait, p.height)
    const c = hud.copy.getBoundingClientRect()
    const gutter = p.left
    const safeTop = p.top
    const safeBottom = p.bottom
    let art: Rect
    if (!portrait) {
      const gap = Math.max(36, W * 0.035)
      art = { x0: c.right + gap, x1: W - gutter, y0: safeTop, y1: safeBottom }
      // keep the mat a mat: between A-series-ish and a wide desk pad
      const aw = art.x1 - art.x0
      const ah = art.y1 - art.y0
      const maxH = aw / 1.22
      if (ah > maxH) {
        const cy = (art.y0 + art.y1) / 2
        art.y0 = cy - maxH / 2
        art.y1 = cy + maxH / 2
      }
      const maxW = ah * 1.7
      if (aw > maxW) art.x0 = art.x1 - maxW
    } else {
      const gap = Math.max(18, H * 0.024)
      art = { x0: gutter, x1: W - gutter, y0: safeTop, y1: Math.max(safeTop + 90, c.top - gap) }
    }
    box.art = art
    fitHold(W, H)
  }

  // ---------------------------------------------------------------- camera fitting
  const fitCam = new THREE.PerspectiveCamera(FOV, 1, 0.1, 200)
  const hold = {
    target: new THREE.Vector3(),
    dist: 12,
    dir: new THREE.Vector3(0, Math.sin(HOLD_EL), Math.cos(HOLD_EL)),
    /** world offset that centres the mat on screen (the intro frames the flight there) */
    centre: new THREE.Vector2(),
  }
  const corners = [
    [-1.5, -1],
    [1.5, -1],
    [1.5, 1],
    [-1.5, 1],
  ].map(([x, y]) => sheetToWorld(x, y))
  const tmp = new THREE.Vector3()
  const ray = new THREE.Ray()
  const tablePlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0)

  function placeFit(W: number, H: number, target: THREE.Vector3, dist: number) {
    fitCam.aspect = W / Math.max(1, H)
    fitCam.fov = FOV
    fitCam.position.copy(target).addScaledVector(hold.dir, dist)
    fitCam.up.set(0, 1, 0)
    fitCam.lookAt(target)
    fitCam.updateProjectionMatrix()
    fitCam.updateMatrixWorld(true)
  }
  const toPx = (p: THREE.Vector3, W: number, H: number) => {
    tmp.copy(p).project(fitCam)
    return [(tmp.x * 0.5 + 0.5) * W, (-tmp.y * 0.5 + 0.5) * H] as const
  }
  const unproject = (x: number, y: number, W: number, H: number, out: THREE.Vector3) => {
    tmp.set((x / W) * 2 - 1, -(y / H) * 2 + 1, 0.5).unproject(fitCam)
    ray.origin.copy(fitCam.position)
    ray.direction.copy(tmp).sub(fitCam.position).normalize()
    return ray.intersectPlane(tablePlane, out) ?? out.set(0, 0, 0)
  }

  function fitHold(W: number, H: number) {
    const a = box.art
    const aw = a.x1 - a.x0
    const ah = a.y1 - a.y0
    const pad = Math.max(box.portrait ? 16 : 26, Math.min(aw, ah) * (box.portrait ? 0.075 : 0.1))
    const r = { x0: a.x0 + pad, x1: a.x1 - pad, y0: a.y0 + pad, y1: a.y1 - pad }
    const rw = Math.max(40, r.x1 - r.x0)
    const rh = Math.max(40, r.y1 - r.y0)
    const target = hold.target.set(0, 0, 0)
    let dist = 12
    const tanH = Math.tan((FOV * PI) / 360)
    for (let it = 0; it < 7; it++) {
      placeFit(W, H, target, dist)
      let minX = Infinity,
        maxX = -Infinity,
        minY = Infinity,
        maxY = -Infinity
      for (const c of corners) {
        const [x, y] = toPx(c, W, H)
        minX = Math.min(minX, x)
        maxX = Math.max(maxX, x)
        minY = Math.min(minY, y)
        maxY = Math.max(maxY, y)
      }
      const scale = Math.max((maxX - minX) / rw, (maxY - minY) / rh)
      const wpp = (2 * dist * tanH) / H
      const dx = (r.x0 + r.x1) / 2 - (minX + maxX) / 2
      const dy = (r.y0 + r.y1) / 2 - (minY + maxY) / 2
      target.x -= dx * wpp
      target.z -= dy * wpp / Math.sin(HOLD_EL)
      if (Number.isFinite(scale) && scale > 0) dist *= scale
    }
    hold.dist = dist
    placeFit(W, H, target, dist)
    const wpp = (2 * dist * tanH) / H
    hold.centre.set(((a.x0 + a.x1) / 2 - W / 2) * wpp, (((a.y0 + a.y1) / 2 - H / 2) * wpp) / Math.sin(HOLD_EL))
    // the mat: the art rect unprojected onto the table
    const tl = unproject(a.x0, a.y0, W, H, new THREE.Vector3())
    const tr = unproject(a.x1, a.y0, W, H, new THREE.Vector3())
    const bl = unproject(a.x0, a.y1, W, H, new THREE.Vector3())
    const br = unproject(a.x1, a.y1, W, H, new THREE.Vector3())
    const x0 = (tl.x + bl.x) / 2
    const x1 = (tr.x + br.x) / 2
    const z0 = (tl.z + tr.z) / 2
    const z1 = (bl.z + br.z) / 2
    const mw = Math.max(0.5, x1 - x0)
    const mh = Math.max(0.5, z1 - z0)
    const matPad = 0.3
    mat.position.set((x0 + x1) / 2, 0, (z0 + z1) / 2)
    mat.scale.set(mw + matPad * 2, mh + matPad * 2, 1)
    matMat.uniforms.uSize.value.set(mw, mh)
    matMat.uniforms.uPad.value = matPad
    matMat.uniforms.uRadius.value = Math.min(mw, mh) * 0.035
    matMat.uniforms.uShadow.value.set(mw * 0.012, -mw * 0.012)
  }

  // ---------------------------------------------------------------- flight
  const P0 = new THREE.Vector3(-8.2, 5.2, -4.6)
  const P1 = new THREE.Vector3(-5.2, 3.4, 2.1)
  const P2 = new THREE.Vector3(-2.7, 0.6, 0.35)
  const P3 = new THREE.Vector3(-0.62, 0, 0)
  const bez = (t: number, out: THREE.Vector3) => {
    const s = 1 - t
    return out
      .set(0, 0, 0)
      .addScaledVector(P0, s * s * s)
      .addScaledVector(P1, 3 * s * s * t)
      .addScaledVector(P2, 3 * s * t * t)
      .addScaledVector(P3, t * t * t)
  }
  const bezD = (t: number, out: THREE.Vector3) => {
    const s = 1 - t
    return out
      .set(0, 0, 0)
      .addScaledVector(P0, -3 * s * s)
      .addScaledVector(P1, 3 * s * s - 6 * s * t)
      .addScaledVector(P2, 6 * s * t - 3 * t * t)
      .addScaledVector(P3, 3 * t * t)
  }
  const fp = new THREE.Vector3()
  const fd = new THREE.Vector3()
  const fd2 = new THREE.Vector3()
  const qA = new THREE.Quaternion()
  const qB = new THREE.Quaternion()
  const X = new THREE.Vector3(1, 0, 0)
  const Y = new THREE.Vector3(0, 1, 0)
  const Z = new THREE.Vector3(0, 0, 1)
  const heading = (d: THREE.Vector3) => Math.atan2(-d.z, d.x)

  /** pose the sheet group + fold angles for local l */
  function poseSheet(l: number, time: number) {
    const tFlight = segment(l, TL.flight[0], TL.flight[1])
    const landed = l >= TL.flight[1]
    // fold angles
    angles.fill(0)
    const wing = l < TL.wings[0] ? WING_FLIGHT : unfold(l, TL.wings[0], TL.wings[1], WING_FLIGHT, 0)
    const f3 = unfold(l, TL.open[0], TL.open[1], PI - 0.06, 0.2)
    const f2 = unfold(l, TL.f2[0], TL.f2[1], PI, 0.18)
    const f1 = unfold(l, TL.f1[0], TL.f1[1], PI, 0.14)
    angles[0] = angles[1] = f1
    angles[2] = angles[3] = f2
    angles[4] = angles[6] = wing
    angles[5] = f3

    if (!landed) {
      // glide: position on the curve, heading along it, banked into the turn
      const t = ease.inOutQuad(tFlight) * 0.94 + tFlight * 0.06
      bez(t, fp)
      bezD(t, fd)
      bezD(Math.min(1, t + 0.02), fd2)
      const hd = heading(fd)
      const turn = heading(fd2) - hd
      const horiz = Math.hypot(fd.x, fd.z)
      let pitch = Math.atan2(fd.y, horiz) * 0.8
      pitch += 0.26 * smoothstep(0.78, 1, t) // flare
      let bank = clamp(-turn * 9, -0.6, 0.6)
      const idle = reduced ? 0 : 1 - smoothstep(0.7, 1, t)
      const tq = Math.floor(time * 12) / 12 // flutter on twos
      bank += Math.sin(tq * 5.3) * 0.05 * idle
      pitch += Math.sin(tq * 3.7 + 1) * 0.035 * idle
      fp.applyAxisAngle(Y, YAW)
      sheet.position.set(fp.x, fp.y + TABLE_Y, fp.z)
      qA.setFromAxisAngle(Y, YAW + hd)
      qB.setFromAxisAngle(Z, pitch)
      qA.multiply(qB)
      qB.setFromAxisAngle(X, bank)
      sheet.quaternion.copy(qA.multiply(qB))
    } else {
      // skid to a stop, then topple onto its side
      const s = ease.outCubic(segment(l, TL.skid[0], TL.skid[1]))
      const x = lerp(P3.x, 0, s)
      const nose = Math.sin(PI * segment(l, TL.skid[0], TL.skid[0] + 0.012)) * 0.05
      const tipT = segment(l, TL.tip[0], TL.tip[1])
      let tip = ease.inCubic(Math.min(1, tipT / 0.78))
      if (tipT > 0.78) tip = 1 - Math.sin(PI * ((tipT - 0.78) / 0.22)) * 0.06
      fp.set(x, 0, 0).applyAxisAngle(Y, YAW)
      sheet.position.set(fp.x, TABLE_Y, fp.z)
      qA.copy(qYaw)
      qB.setFromAxisAngle(Z, 0.26 * (1 - s) - nose)
      qA.multiply(qB)
      qB.setFromAxisAngle(X, (-PI / 2) * tip)
      sheet.quaternion.copy(qA.multiply(qB))
    }
  }

  // ---------------------------------------------------------------- the rubber stamp
  // A wood-mounted rubber stamp seen from above: a paper-coloured block with
  // its index label printed on top (what it prints, readable), shaded sides,
  // a black rubber die underneath. It swaps labels between its two jobs.
  let blockMats: THREE.Material[] = []
  let labelPost!: THREE.ShaderMaterial
  let labelEnd!: THREE.ShaderMaterial
  let block!: THREE.Mesh

  function labelMaterial(map: THREE.Texture, ink: THREE.Vector3) {
    return new THREE.ShaderMaterial({
      uniforms: { uMap: { value: map }, uInk: { value: ink } },
      vertexShader: /* glsl */ `
        varying vec2 vUv;
        void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
      `,
      fragmentShader: /* glsl */ `
        uniform sampler2D uMap;
        uniform vec3 uInk;
        varying vec2 vUv;
        void main() {
          float t = texture2D(uMap, mix(vec2(0.5), vUv, 1.06)).r;
          vec3 d = uInk * t * 0.9;
          d.b = max(d.b, 0.04);
          gl_FragColor = vec4(d, 0.0);
        }
      `,
      toneMapped: false,
    })
  }

  function buildStamp(post: THREE.Texture, end: THREE.Texture) {
    const H = 0.3
    const side = inkMaterial({ ink: [0, 0, 0.05], shadow: [0, 0, 0.6], lightDir: new THREE.Vector3(-0.5, 0.8, -0.35) })
    labelPost = labelMaterial(post, new THREE.Vector3(1, 0, 0))
    labelEnd = labelMaterial(end, END_INK)
    // BoxGeometry groups: +x, -x, +y (top), -y, +z, -z
    blockMats = [side, side, labelPost, side, side, side]
    block = new THREE.Mesh(new THREE.BoxGeometry(1, H, 1), blockMats)
    block.position.y = 0.05 + H / 2
    const die = new THREE.Mesh(new THREE.BoxGeometry(0.97, 0.05, 0.97), inkMaterial({ ink: [0, 0, 0.85], shadow: [0, 0, 0.15] }))
    die.position.y = 0.025
    const edgeMat = inkLineMaterial([0, 0, 1])
    const edges = new THREE.LineSegments(new THREE.EdgesGeometry(block.geometry), edgeMat)
    edges.position.copy(block.position)
    stampBody.add(block, die, edges)
    // shadow: the block's footprint projected onto the table (drawn over the card)
    const sh = new THREE.Mesh(new THREE.BoxGeometry(1, H + 0.05, 1), blockShadowMaterial())
    sh.position.y = (H + 0.05) / 2
    sh.renderOrder = 6
    stampBody.add(sh)
    for (const m of [block, die, edges]) m.renderOrder = 8
    stamp.rotation.order = 'YXZ'
    stamp.add(stampBody)
    stamp.visible = false
    group.add(stamp)
  }

  // stamp targets (world), set once
  const postTarget = new THREE.Vector3()
  const endTarget = new THREE.Vector3()
  const endYaw = YAW + 0.16
  const END_W = 1.5
/** the end-of-run stamp prints in the green drum (the mat is pink) */
const END_INK = new THREE.Vector3(0, 1, 0)
  let endH = 0.6

  function poseStamp(l: number) {
    const inPost = l > TL.stamp[0] && l < TL.stamp[1]
    const inEnd = l > TL.end[0] && l < TL.end[1]
    stamp.visible = inPost || inEnd
    if (!stamp.visible) return 0
    const win = inPost ? TL.stamp : TL.end
    const w = segment(l, win[0], win[1])
    const target = inPost ? postTarget : endTarget
    const sx = inPost ? (POSTMARK_RECT.w / 100) * 1.04 : END_W * 1.03
    const sz = inPost ? (POSTMARK_RECT.h / 100) * 1.06 : endH * 1.06
    const yaw = inPost ? YAW : endYaw
    blockMats[2] = inPost ? labelPost : labelEnd
    block.material = blockMats
    let h = 0
    let squash = 0
    let drift = 0
    if (w < 0.38) {
      // drop: in from above and to the right, tilted, straightening as it lands
      const k = w / 0.38
      h = 3.6 * (1 - ease.inCubic(k))
      drift = 1 - ease.inCubic(k)
    } else if (w < 0.56) {
      // squash on the sheet
      squash = Math.sin(PI * ((w - 0.38) / 0.18))
    } else {
      // lift: a little hop up, then away
      const k = (w - 0.56) / 0.44
      h = 4.2 * ease.inCubic(k) + 0.3 * Math.sin(PI * Math.min(1, k * 1.6))
      drift = ease.inCubic(k) * 0.9
    }
    stamp.position.set(target.x + drift * 1.5, TABLE_Y + 0.012 + h, target.z - drift * 1.0)
    stamp.rotation.set(-drift * 0.32, yaw + drift * 0.3, drift * 0.42)
    stampBody.scale.set(sx * (1 + squash * 0.04), 1 - squash * 0.22, sz * (1 + squash * 0.04))
    return squash
  }

  // ---------------------------------------------------------------- lifecycle
  return {
    id: 'contact',
    group,

    async init(ctx: ChapterContext) {
      reduced = ctx.reducedMotion
      mobile = ctx.mobile
      buildHud(ctx.stage)
      await loadCardFonts()
      const aniso = Math.min(8, ctx.renderer.capabilities.getMaxAnisotropy())
      const art = drawCardArt(mobile, aniso)
      await new Promise(r => requestAnimationFrame(r))

      fold = buildFold()
      u = sheetUniforms(art, fold.creases)
      foldMesh = new THREE.Mesh(fold.geometry, sheetMaterial(u, false))
      foldMesh.renderOrder = 4
      foldMesh.frustumCulled = false
      foldShadowMat = shadowMaterial(u, false)
      foldShadow = new THREE.Mesh(fold.geometry, foldShadowMat)
      foldShadow.renderOrder = 2
      foldShadow.frustumCulled = false
      cardMesh = new THREE.Mesh(new THREE.PlaneGeometry(3, 2, mobile ? 24 : 36, mobile ? 16 : 24), sheetMaterial(u, true))
      cardMesh.renderOrder = 4
      cardShadowMat = shadowMaterial(u, true)
      cardShadow = new THREE.Mesh(cardMesh.geometry, cardShadowMat)
      cardShadow.renderOrder = 2
      cardShadow.frustumCulled = false
      sheet.add(foldMesh, foldShadow, cardMesh, cardShadow)

      matMat = matMaterial()
      mat = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), matMat)
      mat.rotation.x = -PI / 2
      mat.renderOrder = 0
      group.add(mat)

      // impression for the end of the run, lying across the card's lower-left corner
      endH = END_W / art.endAspect
      impressionMat = impressionMaterial(art.endStamp, END_INK)
      impression = new THREE.Mesh(new THREE.PlaneGeometry(END_W, endH), impressionMat)
      impression.rotation.set(-PI / 2, 0, endYaw)
      impression.renderOrder = 5
      sheetToWorld(-0.64, -0.6, endTarget)
      impression.position.set(endTarget.x, TABLE_Y + 0.02, endTarget.z)
      group.add(impression)
      sheetToWorld(
        (POSTMARK_RECT.x + POSTMARK_RECT.w / 2) / 100 - CARD_U / 200,
        CARD_V / 200 - (POSTMARK_RECT.y + POSTMARK_RECT.h / 2) / 100,
        postTarget,
      )

      buildStamp(art.postmark, art.endStamp)
    },

    update(l, frame, ctx) {
      measure(frame)
      const t = frame.time

      // paper handling moves "on twos": once the dart is down, the sheet and the
      // stamps sample the scroll 12 times a second (a jump applies at once)
      if (reduced || l < TL.flight[1] || Math.abs(l - held.l) > 0.04 || t - held.at >= 1 / 12 || t < held.at) {
        held.l = l
        held.at = t
      }
      const pl = held.l

      // ---- the sheet: dart → card
      poseSheet(pl, t)
      const flat = pl >= TL.f1[1]
      foldMesh.visible = foldShadow.visible = !flat
      cardMesh.visible = cardShadow.visible = flat
      if (!flat) fold.pose(angles)
      sheet.updateMatrixWorld(true)
      u.uSheetRot.value.setFromMatrix4(sheet.matrixWorld)

      // crease lines: folded edges read as outlines; once flat, a faint memory of each crease
      const relief = smoothstep(TL.settle[0], TL.settle[1], pl)
      u.uRelief.value = relief
      const creases = fold.creases
      for (let i = 0; i < creases.length && i < u.uCreaseW.value.length; i++) {
        const th = Math.abs(angles[creases[i].op])
        u.uCreaseW.value[i] = Math.max(smoothstep(0.04, 0.5, th) * 0.9, relief * 0.16)
      }
      // shadows: the dart's falls away with height; the card casts a hard offset
      const air = sheet.position.y
      foldShadowMat.uniforms.uStrength.value = 0.46
      foldShadowMat.uniforms.uLift.value = 0.05
      cardShadowMat.uniforms.uLift.value = 0.07 + air * 0
      // the free corner lifts in a draught (idle, stepped on twos)
      if (flat) {
        const tq = reduced ? 0 : Math.floor(t * 12) / 12
        const px = frame.pointer.x
        const py = frame.pointer.y
        const near = clamp(1 - Math.hypot(px - 0.7, py + 0.5) / 0.9)
        const breath = reduced ? 0.12 : 0.18 + 0.12 * Math.sin(tq * 1.3) + 0.08 * Math.sin(tq * 3.1)
        const settleIn = smoothstep(TL.settle[0], TL.settle[1] + 0.02, pl)
        u.uCurl.value.set(1.5, -1, (breath + near * 0.35) * settleIn * 0.9, 0.62)
      }

      // ---- stamps
      const squash = poseStamp(pl)
      u.uPostmark.value = smoothstep(TL.stamp[0] + 0.4 * (TL.stamp[1] - TL.stamp[0]), TL.stamp[0] + 0.48 * (TL.stamp[1] - TL.stamp[0]), pl)
      const endInk = smoothstep(TL.end[0] + 0.4 * (TL.end[1] - TL.end[0]), TL.end[0] + 0.48 * (TL.end[1] - TL.end[0]), pl)
      impressionMat.uniforms.uInk.value = endInk
      impression.visible = endInk > 0.001
      if (squash > 0.05 && !reduced) {
        ctx.post.params.glitch = squash * 0.22
        ctx.post.params.misreg = 1.4 + squash * 1.2
      }

      // ---- the ink flood hand-off: the dart is still wet with green as it comes out of the cut
      u.uGreen.value = reduced ? 0 : 0.85 * (1 - smoothstep(0.03, 0.115, l))

      // ---- HUD
      setRise(hud.eyebrow, l > 0.19)
      setRise(hud.title, l > 0.2)
      const tog = (n: HTMLElement, on: boolean) => {
        if (n.classList.contains('is-in') !== on) n.classList.toggle('is-in', on)
      }
      tog(hud.body, l > 0.212)
      tog(hud.mailRow, l > 0.228)
      tog(hud.links, l > 0.242)
      tog(hud.foot, l > 0.252)
      tog(hud.endTag, l > TL.end[0] + 0.5 * (TL.end[1] - TL.end[0]))
    },

    camera(l: number, frame: Frame, out: CameraPose) {
      measure(frame)
      // intro: low and oblique over the approach, craning up to the flat-lay by 0.3
      const k = ease.inOutCubic(segment(l, 0.0, 0.3))
      const el0 = (44 * PI) / 180
      const elv = lerp(el0, HOLD_EL, k)
      const az = lerp(-0.34, 0, k)
      const endPull = ease.inOutCubic(segment(l, 0.8, 1))
      const drift = segment(l, 0.3, 0.81)
      const dist = hold.dist * lerp(1.0, 1, k) * (1 - drift * 0.025 + endPull * 0.05)
      // the flight is framed with the mat centred; it slides to its place as the copy arrives
      const tx = hold.target.x + (1 - k) * (hold.centre.x - 1.0)
      const tz = hold.target.z + (1 - k) * (hold.centre.y - 0.45)
      out.target.set(tx, 0, tz)
      out.position.set(
        tx + Math.sin(az) * Math.cos(elv) * dist,
        Math.sin(elv) * dist,
        tz + Math.cos(az) * Math.cos(elv) * dist,
      )
      out.fov = FOV
      out.roll = 0
      out.parallax = reduced ? 0 : lerp(0.15, 0.22, k)
    },
  }
}
