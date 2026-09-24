import * as THREE from 'three'
import type { CameraPose, Chapter, ChapterContext, Frame } from '../../core/types'
import { el, rise, setRise } from '../../core/dom'
import { clamp, ease, lerp, segment } from '../../core/math'
import { SECTIONS, TESTIMONIALS } from '../../content'
import { LEAVES, N, loadPageFonts, printPages, printStamp, type PageAtlas } from './pages'
import { PAGE_H, PAGE_W, applyPose, leafGeometry, leafMaterial, leafPoint, leafPose, type LeafPose, type LeafUniforms } from './leaf'
import { createTable, type Table } from './table'
import { STAMP_HIT, createStampTool } from './stamp'
import './voices.css'

/*
 * ZINE (voices) — client voices as a stapled A5 riso zine lying open on a
 * green cutting mat. Every spread is one testimonial: a giant pull-quote
 * page facing a story page (doodle, full quote, byline), printed in pink,
 * green and black. Pages turn with a real bend (see leaf.ts), a rubber
 * "HEARD" stamp thunks onto each spread once it settles (animated on twos),
 * and the full quote is set beside the zine as live type on a taped card.
 *
 *   0.00–0.05  in-beat: the zine drops out of the green flood onto the mat
 *              (a slap, a hop, the cover's edge fluttering on the cushion)
 *   0.03–0.08  the cover: WE LISTEN. THEY TALK. + the contents card
 *   0.10       the cover turns — then eight spreads, one turn each
 *              (turns centred on B0 + k·SPAN; each quote holds from one turn's
 *              midpoint to the next, so a quote never resets mid-read)
 *   0.935      the back cover swings over: the zine closes
 *   0.95–1.00  out-beat: the closed zine slides off the mat, the green
 *              flood swells over the mat's green dots
 */

const B0 = 0.1
const B1 = 0.935
const SPAN = (B1 - B0) / N
/** local progress one page turn takes */
const TD = 0.05
const turnAt = (k: number) => B0 + k * SPAN
/** where a keyboard stop for voice i lands: the middle of its settled spread */
const anchorAt = (i: number) => B0 + (i + 0.5) * SPAN
/** leaf spacing in the stacks (world units) */
const EPS = 0.0032
/** switch hysteresis around each turn's midpoint */
const HYST = 0.006

const pad = (n: number) => String(n).padStart(2, '0')
const pp = (s: number) => `pp. ${pad(2 * s + 2)}–${pad(2 * s + 3)}`

/** the HEARD stamp lands in the pull page's clear top-right corner (page uv centre, size) */
const STAMP_AT = { u: 0.735, v: 0.775, size: 0.46 }
/** the stamp's own rotation as baked into its art (radians, counter-clockwise from above) */
const STAMP_YAW = 0.17

interface Block {
  root: HTMLElement
  parts: HTMLElement[]
  on: boolean
}

export default function create(): Chapter {
  const group = new THREE.Group()
  /** the zine (all leaves), moved by the drop / slide */
  const zine = new THREE.Group()
  group.add(zine)

  let atlas: PageAtlas
  let table: Table
  const leaves: { mesh: THREE.Mesh; u: LeafUniforms }[] = []
  const staples: THREE.Mesh[] = []
  const tool = createStampTool()
  const toolAt = new THREE.Vector3()

  // DOM
  let eyebrow: HTMLElement
  let side: HTMLElement
  let panel: HTMLElement
  let tabs: HTMLElement[] = []
  const blocks: Block[] = []
  let shown = -2
  let lastTab = -2

  // layout (measured on resize only)
  const box = { w: 1, h: 1, panelL: 0, panelT: 0, portrait: false, ok: false }

  // stamp animation (time-driven, stepped on twos)
  const stampStart: (number | null)[] = new Array(N).fill(null)

  const inv = new THREE.Matrix4()
  const poses: LeafPose[] = Array.from({ length: LEAVES }, () => ({ theta: 0, bend: 0, twist: 0, gutter: 0, y: 0 }))
  const p2 = new THREE.Vector2()

  /* ------------------------------------------------------------ DOM */

  function buildDom(stage: HTMLElement) {
    eyebrow = rise(el('p', 'hud-eyebrow vz-eyebrow', undefined, stage), SECTIONS.voices.eyebrow)

    side = el('div', 'vz-side', undefined, stage)
    panel = el('div', 'vz-panel', undefined, side)
    el('span', 'vz-tape', undefined, panel).setAttribute('aria-hidden', 'true')
    el('span', 'vz-tape vz-tape--b', undefined, panel).setAttribute('aria-hidden', 'true')
    const stack = el('div', 'vz-stack', undefined, panel)

    // contents (the cover)
    const toc = el('div', 'vz-block vz-toc', undefined, stack)
    const slug = el('p', 'vz-slug', undefined, toc)
    el('span', '', 'Contents', slug)
    el('span', '', 'Issue 01', slug)
    const ol = el('ol', 'vz-toc-list', undefined, toc)
    const tocParts: HTMLElement[] = []
    TESTIMONIALS.forEach((t, i) => {
      const li = el('li', '', undefined, ol)
      li.style.setProperty('--i', String(i))
      el('span', 'vz-pp', pad(2 * i + 2), li)
      const who = el('span', 'vz-who', undefined, li)
      el('b', '', t.name, who)
      el('span', '', t.company, who)
      tocParts.push(li)
    })
    el('p', 'vz-hint', 'Scroll to turn the page', toc)
    blocks.push({ root: toc, parts: [], on: false })

    TESTIMONIALS.forEach((t, i) => {
      const b = el('div', 'vz-block vz-voice', undefined, stack)
      const s = el('p', 'vz-slug', undefined, b)
      el('span', '', `Voice ${pad(i + 1)} / ${pad(N)}`, s)
      el('span', '', pp(i), s)
      const bq = el('blockquote', 'vz-q', undefined, b)
      const q = rise(el('p', 'hud-quote', undefined, bq), `“${t.quote}”`)
      el('hr', 'hud-rule vz-rule', undefined, b)
      const name = rise(el('p', 'vz-name', undefined, b), t.name)
      const co = rise(el('p', 'vz-co', undefined, b), t.company)
      blocks.push({ root: b, parts: [q, name, co], on: false })
    })

    const tabRow = el('div', 'vz-tabs', undefined, panel)
    tabRow.setAttribute('aria-hidden', 'true')
    tabs = TESTIMONIALS.map((_, i) => el('span', 'vz-tab', pad(i + 1), tabRow))

    const measure = () => {
      const r = side.getBoundingClientRect()
      const p = panel.getBoundingClientRect()
      box.w = window.innerWidth
      box.h = window.innerHeight
      box.portrait = box.w / Math.max(1, box.h) < 0.9
      box.panelL = r.left
      box.panelT = p.top
      box.ok = r.width > 0
    }
    measure()
    window.addEventListener('resize', measure)
    if (typeof ResizeObserver !== 'undefined') new ResizeObserver(measure).observe(panel)
    document.fonts?.ready.then(measure).catch(() => {})
  }

  function setBlock(i: number, on: boolean) {
    const b = blocks[i]
    if (!b || b.on === on) return
    b.on = on
    b.root.classList.toggle('is-on', on)
    for (const p of b.parts) setRise(p, on)
  }

  /** which panel block the scroll asks for: 0 contents, 1..N voices, -1 none */
  function wantAt(local: number) {
    let want = local < B0 ? 0 : local >= B1 ? -1 : 1 + Math.min(N - 1, Math.floor((local - B0) / SPAN))
    if (local < 0.03) want = -1
    // hysteresis at each turn's midpoint
    if (shown >= 0 && want !== shown && want >= 0 && Math.abs(want - shown) === 1) {
      const k = Math.max(want, shown) - 1
      if (Math.abs(local - turnAt(k)) < HYST) want = shown
    }
    return want
  }

  /* ---------------------------------------------------------- layout */

  /** the screen rectangle the zine must fit, in NDC (mirrors voices.css) */
  function zineRect(f: Frame) {
    const w = f.width
    const h = f.height
    const nx = (px: number) => (2 * px) / w - 1
    const ny = (px: number) => 1 - (2 * px) / h
    const gutter = Math.max(16, Math.min(48, 0.034 * w))
    const top = Math.max(80, Math.min(112, 0.105 * h))
    const bottom = Math.max(72, Math.min(100, 0.095 * h))
    if (box.portrait) {
      const pt = box.ok ? box.panelT : h * 0.55
      return { x0: nx(gutter - 4), x1: nx(w - gutter + 4), y0: ny(pt - 20), y1: ny(top + 34) }
    }
    const pl = box.ok ? box.panelL : w * 0.64
    return { x0: nx(gutter + 8), x1: nx(pl - 44), y0: ny(h - bottom + 8), y1: ny(top + 40) }
  }

  // fit scratch
  const pts = Array.from({ length: 4 }, () => new THREE.Vector3())
  const liftPts = Array.from({ length: 8 }, () => new THREE.Vector3())
  const dir = new THREE.Vector3()
  const fwd = new THREE.Vector3()
  const right = new THREE.Vector3()
  const up = new THREE.Vector3()
  const cam = new THREE.Vector3()
  const v = new THREE.Vector3()
  const centre = new THREE.Vector3()
  const rest = new THREE.Matrix4()
  const q = new THREE.Quaternion()

  /** eased hinge progress of leaf k (matches leafPose) */
  const leafE = (k: number, local: number) => {
    const t = segment(local, turnAt(k) - TD / 2, turnAt(k) + TD / 2)
    return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2
  }

  /** the zine's resting footprint (x0, x1) for this local: closed → open → closed */
  function footprint(local: number) {
    const open = leafE(0, local)
    const shut = leafE(LEAVES - 1, local)
    return [-PAGE_W * open, PAGE_W * (1 - shut)] as const
  }

  const ZINE_YAW = -0.045

  /** leaf turn state for this local (shared by update and camera) */
  const turn = { topR: LEAVES, topL: -1, k: -1, qs: new Array<number>(LEAVES).fill(0) }
  function computeTurns(local: number, calm: boolean, hopT: number) {
    turn.topR = LEAVES
    turn.topL = -1
    turn.k = -1
    for (let k = 0; k < LEAVES; k++) {
      const t = segment(local, turnAt(k) - TD / 2, turnAt(k) + TD / 2)
      turn.qs[k] = t
      if (t <= 0 && turn.topR === LEAVES) turn.topR = k
      if (t >= 1) turn.topL = k
      if (t > 0 && t < 1) turn.k = k
      // after landing on the left, the free edge rebounds once (scroll-driven)
      const end = turnAt(k) + TD / 2
      const settle = t >= 1 ? segment(local, end, end + 0.024) : 0
      // the cover's edge flutters as the zine slaps onto the mat
      const flutter = k === 0 && !calm ? Math.sin(Math.PI * hopT) * (1 - hopT) * 0.55 : 0
      leafPose(t, (LEAVES - 1 - k) * EPS + 0.004, k * EPS + 0.004, calm, settle < 1 ? settle : 0, flutter, poses[k])
    }
  }

  function fitCamera(local: number, f: Frame, out: CameraPose) {
    const R = zineRect(f)
    const [x0, x1] = footprint(local)
    q.setFromAxisAngle(THREE.Object3D.DEFAULT_UP, ZINE_YAW)
    rest.makeRotationFromQuaternion(q)
    const hz = PAGE_H / 2
    pts[0].set(x0, 0, -hz)
    pts[1].set(x1, 0, -hz)
    pts[2].set(x0, 0, hz)
    pts[3].set(x1, 0, hz)
    for (const p of pts) p.applyMatrix4(rest)
    centre.set((x0 + x1) / 2, 0, 0).applyMatrix4(rest)
    // a turning page stands up off the spread: the fit keeps its top on screen
    let nLift = 0
    if (turn.k >= 0) {
      const P = poses[turn.k]
      for (let i = 0; i < 4; i++) {
        for (const vn of [-0.5, 0.5]) {
          leafPoint(P, 0.25 + i * 0.25, vn, p2)
          liftPts[nLift++].set(p2.x, p2.y, vn * PAGE_H).applyMatrix4(rest)
        }
      }
    }

    const calm = f.reducedMotion
    const az = THREE.MathUtils.degToRad(calm ? -4 : lerp(-9, 7, local))
    const elv = THREE.MathUtils.degToRad(box.portrait ? 64 : lerp(60, 55, local))
    const fov = box.portrait ? 30 : 26
    const tv = Math.tan(THREE.MathUtils.degToRad(fov / 2))
    const aspect = f.width / Math.max(1, f.height)
    const tx = (R.x0 + R.x1) / 2
    const ty = (R.y0 + R.y1) / 2
    const yTop = 1 - (2 * (box.portrait ? Math.max(80, Math.min(112, 0.105 * f.height)) + 20 : 62)) / Math.max(1, f.height)

    dir.set(Math.sin(az) * Math.cos(elv), Math.sin(elv), Math.cos(az) * Math.cos(elv))
    fwd.copy(dir).negate()
    right.crossVectors(fwd, THREE.Object3D.DEFAULT_UP).normalize()
    up.crossVectors(right, fwd)
    let d = 6
    let ox = 0
    let oy = 0
    const proj = (p: THREE.Vector3) => {
      v.copy(p).sub(cam)
      const z = Math.max(0.1, v.dot(fwd))
      return [v.dot(right) / (z * tv * aspect), v.dot(up) / (z * tv)] as const
    }
    for (let it = 0; it < 6; it++) {
      cam.copy(centre).addScaledVector(dir, d)
      cam.addScaledVector(right, -ox * d * tv * aspect).addScaledVector(up, -oy * d * tv)
      let mnx = Infinity
      let mxx = -Infinity
      let mny = Infinity
      let mxy = -Infinity
      for (const p of pts) {
        const [px, py] = proj(p)
        mnx = Math.min(mnx, px)
        mxx = Math.max(mxx, px)
        mny = Math.min(mny, py)
        mxy = Math.max(mxy, py)
      }
      const cx = (mnx + mxx) / 2
      const cy = (mny + mxy) / 2
      let k = Math.max((mxx - mnx) / Math.max(0.05, R.x1 - R.x0), (mxy - mny) / Math.max(0.05, R.y1 - R.y0))
      for (let i = 0; i < nLift; i++) {
        const [, py] = proj(liftPts[i])
        if (py > cy) k = Math.max(k, (py - cy) / Math.max(0.05, yTop - ty))
      }
      ox += tx - cx
      oy += ty - cy
      d *= Math.max(0.5, Math.min(2, k))
    }
    out.target.copy(centre).addScaledVector(right, -ox * d * tv * aspect).addScaledVector(up, -oy * d * tv)
    out.position.copy(out.target).addScaledVector(dir, d)
    out.fov = fov
    out.roll = 0
    out.parallax = calm ? 0 : 0.06 * d
  }

  /* ---------------------------------------------------------- scene */

  async function buildScene(ctx: ChapterContext) {
    const yieldFrame = () => new Promise<void>(r => requestAnimationFrame(() => r()))
    await loadPageFonts()
    // print resolution: about one atlas texel per device pixel of an on-screen page
    const dpr = Math.min(window.devicePixelRatio || 1, ctx.mobile ? 1.5 : 2)
    const vw = window.innerWidth
    const vh = window.innerHeight
    const pagePx = Math.min(vw < vh ? vw * 0.46 : vw * 0.29, vh * 0.42) * dpr
    const cellW = Math.round(clamp(pagePx, 300, ctx.mobile ? 420 : 700))
    atlas = await printPages(cellW, yieldFrame)
    const stampTex = printStamp(ctx.mobile ? 256 : 512)

    table = createTable(ctx.mobile)
    table.mesh.position.set(0.32, -0.012, 0.18)
    table.mesh.rotation.y = 0.035
    table.mesh.renderOrder = 0
    group.add(table.mesh)

    const geo = leafGeometry(ctx.mobile ? 32 : 48, ctx.mobile ? 6 : 10)
    for (let k = 0; k < LEAVES; k++) {
      const { material, uniforms } = leafMaterial(atlas.texture, stampTex)
      atlas.rect(2 * k, uniforms.uFront.value)
      atlas.rect(2 * k + 1, uniforms.uBack.value)
      const mesh = new THREE.Mesh(geo, material)
      mesh.frustumCulled = false
      mesh.renderOrder = 2
      zine.add(mesh)
      leaves.push({ mesh, u: uniforms })
    }

    // two staples in the gutter
    const sg = new THREE.BoxGeometry(0.012, 0.004, 0.13)
    const sm = new THREE.ShaderMaterial({
      vertexShader: /* glsl */ `void main(){ gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
      fragmentShader: /* glsl */ `void main(){ gl_FragColor = vec4(0.0, 0.0, 0.85, 0.0); }`,
      toneMapped: false,
    })
    for (const z of [-PAGE_H * 0.26, PAGE_H * 0.26]) {
      const s = new THREE.Mesh(sg, sm)
      s.position.set(0, 0.034, z)
      zine.add(s)
      staples.push(s)
    }
    zine.rotation.y = ZINE_YAW
    zine.add(tool.group)
  }

  /* ---------------------------------------------------------- update */

  let hitJolt = 0

  function updateZine(local: number, f: Frame, calm: boolean) {
    const now = f.time
    hitJolt = 0
    // in-beat: the drop out of the flood, a slap, a hop
    const drop = calm ? 1 : segment(local, 0, 0.044)
    const hopT = segment(local, 0.044, 0.07)
    const hop = calm ? 0 : Math.sin(Math.PI * hopT) * (1 - hopT) * 0.07
    const y = (1 - ease.inQuad(drop)) * 1.9 + hop
    // out-beat: the closed zine slides off the mat
    const sl = calm ? 0 : ease.inOutCubic(segment(local, 0.948, 0.996))
    zine.position.set(-2.6 * sl, y, -1.1 * sl)
    zine.rotation.y = ZINE_YAW + 0.55 * sl

    // leaves
    computeTurns(local, calm, hopT)
    const { topR, topL, k: turning } = turn
    for (let k = 0; k < LEAVES; k++) {
      const L = leaves[k]
      const vis = k === topR || k === topL || k === turning
      L.mesh.visible = vis
      L.u.uCast.value.z = 0
      if (vis) applyPose(L.u, poses[k])
    }
    // a lifted leaf's shadow on the pages (and the bare mat) beneath it
    let lx0 = 0
    let lx1 = 0
    let lAmt = 0
    let lSoft = 0.1
    if (turning >= 0) {
      const P = poses[turning]
      const s = Math.sin(P.theta)
      leafPoint(P, 1, 0, p2)
      const hgt = Math.max(0, p2.y)
      const edge = p2.x + 0.35 * hgt
      const amt = 0.5 * Math.sqrt(s)
      const soft = 0.06 + 0.3 * s
      const under = P.theta < Math.PI / 2 ? topR : topL
      const target = under >= 0 && under < LEAVES && under !== turning ? leaves[under] : null
      if (target) target.u.uCast.value.set(edge, P.theta < Math.PI / 2 ? 1 : -1, amt, soft)
      lx0 = Math.min(0, edge)
      lx1 = Math.max(0, edge)
      lAmt = 0.34 * Math.sqrt(s)
      lSoft = 0.08 + 0.3 * s
    }
    for (const s of staples) s.visible = topL >= 0 && topR < LEAVES

    // stamps: each pull page gets its HEARD once the spread settles
    // (time-driven, stepped on twos; the tool and the impression share a clock)
    for (const L of leaves) {
      L.u.uStampAF.value = 0
      L.u.uStampAB.value = 0
    }
    let toolAge: number | null = null
    for (let s = 0; s < N; s++) {
      const settled = local >= turnAt(s) + TD / 2 + 0.004 && local < turnAt(s + 1) - TD / 2
      const covered = local < turnAt(s) - TD * 0.1 || local > turnAt(s + 1) + TD * 0.1
      if (covered) stampStart[s] = null
      else if (settled && stampStart[s] === null) stampStart[s] = now
      const st = stampStart[s]
      if (st === null) continue
      const age = calm ? 1 : Math.floor((now - st) * 12) / 12
      const hit = segment(age, STAMP_HIT, STAMP_HIT + 0.04)
      // ink squeezes out a touch heavier on the hit, then the die lifts clean
      const amt = hit * (1 + 0.2 * (1 - segment(age, STAMP_HIT + 0.04, 0.3)))
      const scale = 1 + 0.06 * (1 - ease.outBack(segment(age, STAMP_HIT, 0.34)))
      const w = STAMP_AT.size * scale
      const h = w / (PAGE_H / PAGE_W)
      // even spreads open on the pull page (left: back of leaf s); odd ones face it (right: front of leaf s + 1)
      const onLeft = s % 2 === 0
      const L = leaves[onLeft ? s : s + 1]
      const rect = onLeft ? L.u.uStampB.value : L.u.uStampF.value
      rect.set(STAMP_AT.u - w / 2, STAMP_AT.v - h / 2, w, h)
      if (onLeft) L.u.uStampAB.value = amt
      else L.u.uStampAF.value = amt
      if (!calm && age <= 0.6) {
        toolAge = age
        const pageY = onLeft ? poses[s].y : poses[s + 1].y
        toolAt.set(onLeft ? -PAGE_W * (1 - STAMP_AT.u) : PAGE_W * STAMP_AT.u, pageY + 0.012, (0.5 - STAMP_AT.v) * PAGE_H)
        // the press jolts the drums on the hit
        if (age >= STAMP_HIT && age < STAMP_HIT + 0.1) hitJolt = 1
      }
    }
    // the engine's prewarm runs before the clock starts (time 0): show the
    // tool then so its shaders compile with the rest of the chapter
    if (now === 0 && !calm) {
      toolAge = 0.2
      toolAt.set(0.5, 0.02, -0.3)
    }
    tool.update(toolAge, toolAt, STAMP_YAW)

    // the contact shadow follows the zine: lifted = softer, lighter, further off
    zine.updateMatrixWorld()
    inv.copy(zine.matrixWorld).invert()
    table.uniforms.uZineInv.value.copy(inv)
    // only the stacks lying flat cast the contact shadow
    const sx0 = -PAGE_W * THREE.MathUtils.smoothstep(leafE(0, local), 0.7, 1)
    const sx1 = PAGE_W * (1 - THREE.MathUtils.smoothstep(leafE(LEAVES - 1, local), 0, 0.3))
    table.uniforms.uShadowRect.value.set(sx0, Math.max(sx0 + 0.001, sx1), -PAGE_H / 2, PAGE_H / 2)
    table.uniforms.uLeafShadow.value.set(lx0, lx1, lAmt, lSoft)
    const air = y
    table.uniforms.uShadow.value.set(0.55 / (1 + air * 2.2), 0.05 + air * 0.35, 0)
    table.uniforms.uShadowOff.value.set(0.028 + air * 0.25, 0.04 + air * 0.3)
  }

  function updateDom(local: number) {
    const on = local > 0.026 && local < 0.955
    setRise(eyebrow, on)
    side.classList.toggle('is-on', local > 0.032 && local < B1)

    const want = wantAt(local)
    if (want !== shown) {
      for (let i = 0; i < blocks.length; i++) setBlock(i, i === want)
      shown = want
    }
    const cur = shown >= 1 ? shown - 1 : -1
    if (cur !== lastTab) {
      tabs.forEach((t, i) => {
        t.classList.toggle('is-on', i === cur)
        t.classList.toggle('is-done', cur >= 0 && i < cur)
      })
      lastTab = cur
    }
  }

  /* ---------------------------------------------------------- chapter */

  return {
    id: 'voices',
    group,
    anchors: TESTIMONIALS.map((_, i) => anchorAt(i)),

    async init(ctx) {
      buildDom(ctx.stage)
      await buildScene(ctx)
    },

    onEnter() {
      shown = -2
    },

    onLeave() {
      for (let i = 0; i < blocks.length; i++) setBlock(i, false)
      shown = -2
      stampStart.fill(null)
    },

    update(local, frame, ctx) {
      const calm = ctx.reducedMotion
      updateZine(local, frame, calm)
      updateDom(local)
      const p = ctx.post.params
      p.cell = frame.mobile ? 4.6 : 5.2
      p.misreg = 1.5 + hitJolt * 1.6
      p.grain = 0.45
    },

    camera(local, frame, out) {
      fitCamera(local, frame, out)
    },

    onPointerDown(frame) {
      // tap the right page to turn forward, the left page to turn back
      const hark = window.__hark
      if (!hark) return
      const local = hark.engine.state.local
      if (local < 0.02 || local > B1) return
      const x = frame.pointerRaw.x
      const cur = local < B0 ? -1 : Math.min(N - 1, Math.floor((local - B0) / SPAN))
      const R = zineRect(frame)
      if (x < R.x0 || x > R.x1) return
      const mid = (R.x0 + R.x1) / 2
      const next = x > mid ? cur + 1 : cur - 1
      if (next < -1 || next > N - 1) return
      hark.land('voices', true, next < 0 ? 0.06 : anchorAt(next))
    },
  }
}
