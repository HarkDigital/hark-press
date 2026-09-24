import * as THREE from 'three'
import type { CameraPose, Chapter, ChapterContext, Frame } from '../../core/types'
import { el, rise, setRise } from '../../core/dom'
import { clamp, lerp, rng, segment, smoothstep } from '../../core/math'
import { SECTIONS, WORK, workImage } from '../../content'
import { inkCanvasMaterial, inkMaterial } from '../../print/ink'
import * as art from './art'
import {
  flyerMaterial,
  oldMaterial,
  paperMaterial,
  shadowMaterial,
  wallMaterial,
  type PaperUniforms,
  type ShadowUniforms,
} from './paper'
import './work.css'

/*
 * PASTE-UP — Selected work as a street hoarding.
 *
 * A plywood wall layered with older, sun-bleached riso posters. The camera
 * walks the wall; at each featured job an old sheet is ripped off, a fresh
 * proof is slapped up, brushed flat with wheatpaste (wrinkles boil, then
 * settle; a corner stays curled) and its job ticket stamps in beside it.
 * The nine other sites are flyers stapled to a black notice board. The
 * chapter opens by peeling a green sheet off the lens and closes by pasting
 * one over it — straight into the ink flood.
 *
 * Paper motion is animated "on twos" (stepped) for a stop-motion feel while
 * the camera glides. Everything is derived from `local`, so any scroll
 * position renders correctly on its own.
 */

const FEATURED = WORK.filter(w => w.featured)
const REST = WORK.filter(w => !w.featured)
const NF = FEATURED.length
const NR = REST.length

const DEG = Math.PI / 180
const UP = new THREE.Vector3(0, 1, 0)

// ---------------------------------------------------------------- world

const PW = 2.6
const PH = 3.68
const IW = 3.3
const IH = 4.67
const INTRO_AT = new THREE.Vector3(-4.6, 0.35, 0.06)
const SLOT_X0 = 3.4
const SLOT_DX = 7.2
const SLOT_Y = [0.3, 0.05, 0.4, 0.1, 0.35, 0.15]
const SLOT_ROT = [-1.2, 0.9, -0.7, 1.1, -0.9, 0.6].map(d => d * DEG)
const slotPos = (k: number) => new THREE.Vector3(SLOT_X0 + SLOT_DX * k, SLOT_Y[k % SLOT_Y.length], 0)
const BOARD_AT = new THREE.Vector3(SLOT_X0 + SLOT_DX * (NF - 1) + 9.4, 0.25, 0)
const FLW = 1.3
const FLH = 1.3 * 1.414
const FLGAP = 0.3
const BOARD_W = 3 * FLW + 2 * FLGAP + 0.9
const BOARD_H = 3 * FLH + 2 * FLGAP + 1.0

// ---------------------------------------------------------------- timeline

const F0 = 0.084
const FW = 0.125
const sOf = (k: number) => F0 + FW * k
/** whip pan between stations (ends as the next station's window opens) */
const PANW = 0.024
/** each job holds until here (relative to its window), then pans on */
const HOLD_END = FW - PANW
const LENS_IN: [number, number] = [0.014, 0.046]
/** the opener run, far copy first: slap, slap, slap (the nearest one brushed) */
const INTRO_PASTE: [number, number][] = [
  [0.012, 0.05],
  [0.006, 0.028],
  [0.0, 0.02],
]
const INTRO_RUN = [
  { dx: 0, dy: 0, rot: -0.8 },
  { dx: -(IW + 0.14), dy: -0.08, rot: 1.0 },
  { dx: -2 * (IW + 0.14), dy: 0.1, rot: -1.5 },
]
const INTRO_ON: [number, number] = [0.03, sOf(0) - PANW + 0.008]
const PEEL: [number, number] = [-0.01, 0.008]
const PASTE: [number, number] = [0.0, 0.04]
const CARD: [number, number] = [0.016, HOLD_END - 0.001]
const BOARD_IN: [number, number] = [sOf(NF - 1) + HOLD_END, sOf(NF - 1) + HOLD_END + PANW + 0.006]
const HOP0 = BOARD_IN[0] + 0.016
const HOP_DT = 0.0055
const HOP_LEN = 0.012
const BOARD_ON: [number, number] = [BOARD_IN[1] - 0.002, 0.958]
const SWEEP0 = HOP0 + (NR - 1) * HOP_DT + HOP_LEN + 0.012
const SWEEP_DT = (0.952 - SWEEP0) / (NR - 1)
const LENS_OUT: [number, number] = [0.956, 0.992]

// ---------------------------------------------------------------- helpers

const pad = (n: number, l = 3) => String(n).padStart(l, '0')
const esc = (s: string) => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!)
const emLast = (name: string) => {
  const parts = name.split(' ')
  if (parts.length < 2) return `<em>${esc(name)}</em>`
  const last = parts.pop()!
  return `${esc(parts.join(' '))} <em>${esc(last)}</em>`
}
const isPreview = (url: string) => /harktest\.com/.test(url)
const outBack = (t: number, s = 1.4) => {
  const c3 = s + 1
  const x = t - 1
  return 1 + c3 * x * x * x + s * x * x
}
const outCubic = (t: number) => 1 - (1 - t) * (1 - t) * (1 - t)
const inOutSine = (t: number) => 0.5 - 0.5 * Math.cos(Math.PI * t)
const inOutCubic = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - ((-2 * t + 2) * (-2 * t + 2) * (-2 * t + 2)) / 2)
/** camera pan: in-out with a small overshoot that settles */
const pan = (t: number) => inOutCubic(t) + 0.035 * Math.sin(Math.PI * clamp((t - 0.55) / 0.45))
/** stop-motion: hold each pose for a beat */
const twos = (t: number, n: number) => (t >= 1 ? 1 : t <= 0 ? 0 : Math.floor(t * n) / n)
const bump = (x: number, c: number, w: number) => {
  const d = (x - c) / w
  return d <= -1 || d >= 1 ? 0 : 0.5 + 0.5 * Math.cos(Math.PI * d)
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.decoding = 'async'
    img.onload = () => {
      if (typeof img.decode === 'function') img.decode().then(() => resolve(img), () => resolve(img))
      else resolve(img)
    }
    img.onerror = () => reject(new Error(`failed to load ${url}`))
    img.src = url
  })
}

interface Pose {
  pos: THREE.Vector3
  tgt: THREE.Vector3
  fov: number
  roll: number
}
const pose = (): Pose => ({ pos: new THREE.Vector3(), tgt: new THREE.Vector3(), fov: 34, roll: 0 })
function blend(a: Pose, b: Pose, t: number, out: Pose) {
  out.pos.lerpVectors(a.pos, b.pos, t)
  out.tgt.lerpVectors(a.tgt, b.tgt, t)
  out.fov = lerp(a.fov, b.fov, t)
  out.roll = lerp(a.roll, b.roll, t)
  return out
}
interface Region {
  x0: number
  x1: number
  y0: number
  y1: number
}
const _r = new THREE.Vector3()
const _u = new THREE.Vector3()
/** Place the camera looking along D so a w×h subject centred at C fills screen region `reg`. */
function frameTo(out: Pose, C: THREE.Vector3, D: THREE.Vector3, w: number, h: number, reg: Region, W: number, H: number, fov: number) {
  const aspect = W / H
  const tanH = Math.tan((fov * DEG) / 2)
  const fw = Math.max(0.05, (reg.x1 - reg.x0) / W)
  const fh = Math.max(0.05, (reg.y1 - reg.y0) / H)
  const cx = ((reg.x0 + reg.x1) / 2 / W) * 2 - 1
  const cy = 1 - ((reg.y0 + reg.y1) / 2 / H) * 2
  const dist = Math.max(w / 2 / (fw * tanH * aspect), h / 2 / (fh * tanH))
  const hh = dist * tanH
  const hw = hh * aspect
  _r.crossVectors(D, UP).normalize()
  _u.crossVectors(_r, D).normalize()
  out.pos.copy(C).addScaledVector(D, -dist).addScaledVector(_r, -cx * hw).addScaledVector(_u, -cy * hh)
  out.tgt.copy(out.pos).addScaledVector(D, dist)
  out.fov = fov
  out.roll = 0
  return out
}
const dirOf = (yaw: number, pitch: number, out: THREE.Vector3) =>
  out.set(Math.sin(yaw * DEG) * Math.cos(pitch * DEG), Math.sin(pitch * DEG), -Math.cos(yaw * DEG) * Math.cos(pitch * DEG)).normalize()

/** One sheet on the wall: a pivot at its top edge, the deforming mesh, its shadow. */
interface Sheet {
  pivot: THREE.Group
  mesh: THREE.Mesh
  u: PaperUniforms
  shadow: THREE.Mesh
  su: ShadowUniforms
  home: THREE.Vector3
  rot: number
  w: number
  h: number
  canvas?: HTMLCanvasElement
  tex?: THREE.CanvasTexture
}

interface Card {
  slot: HTMLElement
  card: HTMLElement
  name: HTMLElement
}

type Job = () => void

class Work implements Chapter {
  id = 'work'
  group = new THREE.Group()
  /** WORK order: featured jobs at their settled hold; the nine at their turn in the board sweep. */
  anchors = WORK.map(w => {
    const k = FEATURED.indexOf(w)
    if (k >= 0) return sOf(k) + 0.064
    return SWEEP0 + REST.indexOf(w) * SWEEP_DT
  })

  private ctx!: ChapterContext
  private mobile = false
  private reduced = false

  // paper
  private intros: Sheet[] = []
  private posters: Sheet[] = []
  private olds: Sheet[] = []
  private lens!: { mesh: THREE.Mesh; u: PaperUniforms; texIn: THREE.CanvasTexture; texOut: THREE.CanvasTexture }
  private shots: (THREE.Texture | null)[] = []
  private art: art.PosterArt[] = []
  private brush!: THREE.Group
  private brushShadow!: THREE.Mesh
  private flyers!: THREE.InstancedMesh
  private flyData!: THREE.InstancedBufferAttribute
  private flyMat!: THREE.ShaderMaterial
  private flyCanvas!: HTMLCanvasElement
  private flyTex!: THREE.CanvasTexture
  private flyHome: { pos: THREE.Vector3; rot: number }[] = []
  private boardCanvas!: HTMLCanvasElement
  private boardTex!: THREE.Texture
  private oldCanvas!: HTMLCanvasElement
  private oldTex!: THREE.CanvasTexture
  private stencil!: THREE.Mesh
  private m4 = new THREE.Matrix4()
  private q4 = new THREE.Quaternion()
  private e4 = new THREE.Euler()
  private v4 = new THREE.Vector3()
  private s4 = new THREE.Vector3(1, 1, 1)

  // DOM
  private introEl!: HTMLElement
  private cards: Card[] = []
  private boardEl!: HTMLElement
  private boardTitle!: HTMLElement
  private spots: HTMLAnchorElement[] = []
  private spotBox: number[][] = []

  // camera
  private layKey = ''
  private portrait = false
  private S = {
    intro: pose(),
    proj: [] as Pose[],
    board: pose(),
  }
  private cur = pose()
  private tmpA = pose()
  private tmpB = pose()
  private D = new THREE.Vector3()
  private pcam = new THREE.PerspectiveCamera(34, 1, 0.1, 400)
  private v = new THREE.Vector3()

  // images + canvas jobs
  private jobs: Job[] = []
  private pumping = false
  private queue: (() => void)[] = []
  private loading = 0
  private streaming = false
  private flyImgs: (HTMLImageElement | null)[] = REST.map(() => null)
  private flyDirty = false
  /** flyer screenshots still in flight (the atlas uploads once they've all settled) */
  private flyPending = NR

  init(ctx: ChapterContext) {
    this.ctx = ctx
    this.mobile = ctx.mobile
    this.reduced = ctx.reducedMotion
    const q = this.mobile ? 0.72 : 1

    this.buildWall(q)
    this.buildPosters(q)
    this.buildBoard(q)
    this.buildBrush()
    this.buildLens(q)
    this.buildDom(ctx.stage)

    // print the canvases once the faces are in, one per frame
    art.loadFonts().then(() => {
      this.jobs.push(() => this.drawIntro())
      this.jobs.push(() => this.drawOld())
      this.jobs.push(() => this.drawSheets())
      for (let k = 0; k < NF; k++) this.jobs.push(() => this.drawPosterK(k))
      this.jobs.push(() => this.drawStencil())
      this.jobs.push(() => {
        art.drawBoard(this.boardCanvas)
        this.upload(this.boardTex)
      })
      for (let j = 0; j < NR; j++) this.jobs.push(() => this.drawFlyerJ(j))
      this.jobs.push(() => this.upload(this.flyTex))
      this.pump()
    })

    // screenshots: the first job now, the rest after the reveal
    this.queue = [
      ...FEATURED.map((_, k) => () => this.fetchShot(k)),
      ...REST.map((_, j) => () => this.fetchFlyer(j)),
    ]
    this.queue.shift()!()
    const go = () => this.startStreaming()
    if (document.documentElement.dataset.ready === '1') go()
    else {
      window.addEventListener('hark:reveal', go, { once: true })
      window.setTimeout(go, 12000)
    }
  }

  // ------------------------------------------------------------------ build

  private makeSheet(w: number, h: number, map: THREE.Texture | null, home: THREE.Vector3, rot: number, seed: number): Sheet {
    const seg = this.mobile ? [18, 26] : [28, 40]
    const geo = new THREE.PlaneGeometry(1, 1, seg[0], seg[1])
    const { material, uniforms } = paperMaterial(map, [w, h])
    uniforms.uSeed.value = seed
    const mesh = new THREE.Mesh(geo, material)
    mesh.frustumCulled = false
    mesh.position.y = -h / 2
    // opaque draw order is front-to-back so the busy wall shades only what shows
    mesh.renderOrder = 0
    const pivot = new THREE.Group()
    pivot.position.set(home.x, home.y + h / 2, home.z)
    pivot.rotation.z = rot
    pivot.add(mesh)
    const { material: sm, uniforms: su } = shadowMaterial([w, h])
    const shadow = new THREE.Mesh(new THREE.PlaneGeometry(w * 1.8, h * 1.6), sm)
    shadow.position.set(home.x, home.y, 0.05)
    shadow.rotation.z = rot
    shadow.renderOrder = 2
    shadow.frustumCulled = false
    this.group.add(pivot, shadow)
    return { pivot, mesh, u: uniforms, shadow, su, home: home.clone(), rot, w, h }
  }

  private buildWall(q: number) {
    const wall = new THREE.Mesh(new THREE.PlaneGeometry(90, 16), wallMaterial())
    wall.position.set(22, 0.8, 0)
    wall.renderOrder = 2
    this.group.add(wall)

    // older runs, torn and faded (instanced)
    this.oldCanvas = document.createElement('canvas')
    this.oldCanvas.width = Math.round(art.OLD.cols * art.OLD.cw * q)
    this.oldCanvas.height = Math.round(art.OLD.rows * art.OLD.ch * q)
    this.oldTex = this.canvasTex(this.oldCanvas)
    const r = rng(2026)
    type Old = { x: number; y: number; w: number; h: number; rot: number; cell: number; fade: number; tear: number; z: number }
    const list: Old[] = []
    const keepOut = (x: number, y: number, w: number, h: number) => {
      // leave the stencil and the board's own panel alone
      const hits = (ax: number, ay: number, aw: number, ah: number) => Math.abs(x - ax) < (w + aw) / 2 && Math.abs(y - ay) < (h + ah) / 2
      return hits(-11.2, -2.9, 4.8, 1.2) || hits(BOARD_AT.x, BOARD_AT.y, BOARD_W + 0.2, BOARD_H + 0.2)
    }
    for (let layer = 0; layer < 2; layer++) {
      let x = -16 + r() * 1.5
      while (x < 64) {
        const big = r() < 0.45
        const w = big ? 2.2 : 1.55
        const h = w * 1.414
        const col: number[] = []
        const rows = big ? [3.2, 0.4, -2.5] : [4.1, 1.8, -0.5, -2.8]
        for (const ry of rows) col.push(ry + (r() - 0.5) * 0.5)
        for (const y of col) {
          if (r() < (layer === 0 ? 0.12 : 0.3)) continue
          if (keepOut(x, y, w, h)) continue
          list.push({
            x: x + (r() - 0.5) * 0.3,
            y,
            w: w * (0.96 + r() * 0.08),
            h: h * (0.96 + r() * 0.08),
            rot: (r() - 0.5) * 3 * DEG,
            cell: Math.floor(r() * 8),
            fade: layer === 0 ? 0.2 + r() * 0.1 : 0.26 + r() * 0.14,
            tear: layer === 0 ? Math.floor(1 + r() * 3) : r() < 0.55 ? 0 : Math.floor(1 + r() * 3),
            z: 0.004 + layer * 0.012 + r() * 0.006,
          })
        }
        x += w + 0.05 + r() * 0.35
      }
    }
    const n = list.length
    const geo = new THREE.PlaneGeometry(1, 1)
    const data = new Float32Array(n * 4)
    const mesh = new THREE.InstancedMesh(geo, oldMaterial(this.oldTex, art.OLD.cols, art.OLD.rows), n)
    list.forEach((o, i) => {
      this.m4.compose(this.v4.set(o.x, o.y, o.z), this.q4.setFromEuler(this.e4.set(0, 0, o.rot)), this.s4.set(o.w, o.h, 1))
      mesh.setMatrixAt(i, this.m4)
      data.set([o.cell, r() * 10, o.fade, o.tear], i * 4)
    })
    geo.setAttribute('aData', new THREE.InstancedBufferAttribute(data, 4))
    mesh.instanceMatrix.needsUpdate = true
    mesh.frustumCulled = false
    mesh.renderOrder = 1
    this.group.add(mesh)

    // POST NO BILLS, stencilled on the ply
    const sc = document.createElement('canvas')
    sc.width = 1024
    sc.height = 256
    const { material } = inkCanvasMaterial(sc, 1)
    this.stencil = new THREE.Mesh(new THREE.PlaneGeometry(4.8, 1.2), material)
    this.stencil.position.set(-11.2, -2.9, 0.002)
    this.stencil.rotation.z = -1.5 * DEG
    this.group.add(this.stencil)
  }

  private canvasTex(c: HTMLCanvasElement) {
    const t = new THREE.CanvasTexture(c)
    t.colorSpace = THREE.NoColorSpace
    t.anisotropy = Math.min(8, this.ctx.renderer.capabilities.getMaxAnisotropy())
    return t
  }

  private buildPosters(q: number) {
    // the opener
    const ic = document.createElement('canvas')
    ic.width = Math.round(art.INTRO.w * q)
    ic.height = Math.round(art.INTRO.h * q)
    const itex = this.canvasTex(ic)
    INTRO_RUN.forEach((c, i) => {
      const at = INTRO_AT.clone().add(new THREE.Vector3(c.dx, c.dy, 0))
      const s = this.makeSheet(IW, IH, itex, at, c.rot * DEG, 3.7 + i * 2.3)
      s.canvas = ic
      s.tex = itex
      this.intros.push(s)
    })

    for (let k = 0; k < NF; k++) {
      const home = slotPos(k)
      // the sheet it replaces: an older proof from the house atlas
      const old = this.makeSheet(PW * 1.02, PH * 1.02, this.oldTex, home.clone().setZ(0.03), SLOT_ROT[k] * -0.6, 11 + k)
      const cell = (k * 3 + 1) % 8
      old.u.uMapRect.value.set((cell % art.OLD.cols) / art.OLD.cols, 1 - (Math.floor(cell / art.OLD.cols) + 1) / art.OLD.rows, 1 / art.OLD.cols, 1 / art.OLD.rows)
      old.u.uInk.value.setScalar(0.4)
      old.u.uPeelR.value = 0.26
      old.u.uPeelDir.value.set(k % 2 ? -1 : 1, -0.8).normalize()
      old.u.uWrinkle.value = 0.008
      old.u.uEdge.value = 0.35
      old.shadow.visible = false
      this.olds.push(old)

      const c = document.createElement('canvas')
      c.width = Math.round(art.POSTER.w * q)
      c.height = Math.round(art.POSTER.h * q)
      const tex = this.canvasTex(c)
      const s = this.makeSheet(PW, PH, tex, home.clone().setZ(0.06), SLOT_ROT[k], 1.3 + k * 2.1)
      s.canvas = c
      s.tex = tex
      s.u.uCurlDir.value.set(k % 2 ? -1 : 1, -1).normalize()
      s.u.uShotHt.value = 0.82
      this.posters.push(s)
      this.shots.push(null)
      this.art.push({ shot: [0.08, 0.3, 0.92, 0.7], mono: [0, 0, 0, 0] })
    }
  }

  private buildBoard(q: number) {
    // black-painted notice board, timber frame
    const board = new THREE.Mesh(
      new THREE.BoxGeometry(BOARD_W, BOARD_H, 0.1),
      inkMaterial({ ink: [0, 0, 0.86], shadow: [0, 0, 0.1] }),
    )
    board.position.set(BOARD_AT.x, BOARD_AT.y, 0.07)
    board.renderOrder = 1
    this.group.add(board)
    this.boardCanvas = document.createElement('canvas')
    this.boardCanvas.width = Math.round(640 * q)
    this.boardCanvas.height = Math.round(640 * q * (BOARD_H / BOARD_W))
    const face = inkCanvasMaterial(this.boardCanvas, 1)
    this.boardTex = face.texture
    const faceMesh = new THREE.Mesh(new THREE.PlaneGeometry(BOARD_W, BOARD_H), face.material)
    faceMesh.position.set(BOARD_AT.x, BOARD_AT.y, 0.122)
    faceMesh.renderOrder = 1
    this.group.add(faceMesh)
    const frameMat = inkMaterial({ ink: [0.3, 0.16, 0.1], shadow: [0.1, 0.05, 0.45] })
    const t = 0.16
    for (const [w, h, x, y] of [
      [BOARD_W + 2 * t, t, 0, BOARD_H / 2 + t / 2],
      [BOARD_W + 2 * t, t, 0, -BOARD_H / 2 - t / 2],
      [t, BOARD_H, -BOARD_W / 2 - t / 2, 0],
      [t, BOARD_H, BOARD_W / 2 + t / 2, 0],
    ]) {
      const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, 0.2), frameMat)
      m.position.set(BOARD_AT.x + x, BOARD_AT.y + y, 0.1)
      this.group.add(m)
    }
    const shadow = new THREE.Mesh(new THREE.PlaneGeometry(BOARD_W + 1.2, BOARD_H + 1.2), shadowMaterial([BOARD_W + 0.3, BOARD_H + 0.3]).material)
    const su = (shadow.material as THREE.ShaderMaterial).uniforms
    su.uFly.value = 0.28
    su.uStrength.value = 0.5
    su.uPress.value = 1
    shadow.position.set(BOARD_AT.x, BOARD_AT.y, 0.03)
    shadow.renderOrder = 2
    this.group.add(shadow)

    // the nine flyers
    this.flyCanvas = document.createElement('canvas')
    this.flyCanvas.width = Math.round(art.FLY.cols * art.FLY.cw * q)
    this.flyCanvas.height = Math.round(art.FLY.rows * art.FLY.ch * q)
    this.flyTex = this.canvasTex(this.flyCanvas)
    const S = art.FLY_SHOT
    const shot = new THREE.Vector4(S.x / art.FLY.cw, 1 - (S.y + S.h) / art.FLY.ch, (S.x + S.w) / art.FLY.cw, 1 - S.y / art.FLY.ch)
    this.flyMat = flyerMaterial(this.flyTex, art.FLY.cols, art.FLY.rows, shot, [FLW, FLH])
    const geo = new THREE.PlaneGeometry(1, 1, 6, 8)
    const data = new Float32Array(NR * 4)
    this.flyData = new THREE.InstancedBufferAttribute(data, 4)
    this.flyData.setUsage(THREE.DynamicDrawUsage)
    geo.setAttribute('aData', this.flyData)
    this.flyers = new THREE.InstancedMesh(geo, this.flyMat, NR)
    this.flyers.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
    this.flyers.frustumCulled = false
    this.flyers.renderOrder = 0
    const r = rng(77)
    for (let j = 0; j < NR; j++) {
      const col = j % 3
      const row = Math.floor(j / 3)
      const pos = new THREE.Vector3(
        BOARD_AT.x + (col - 1) * (FLW + FLGAP) + (r() - 0.5) * 0.08,
        BOARD_AT.y + (1 - row) * (FLH + FLGAP) + (r() - 0.5) * 0.08 - 0.05,
        0.14,
      )
      this.flyHome.push({ pos, rot: (r() - 0.5) * 4 * DEG })
      data.set([j, r() * 10, 0, 1], j * 4)
    }
    this.group.add(this.flyers)
  }

  private buildBrush() {
    const g = new THREE.Group()
    const L = new THREE.Vector3(-0.5, 0.75, 0.45)
    const bristle = new THREE.Mesh(new THREE.BoxGeometry(1.05, 0.1, 0.34), inkMaterial({ ink: [0, 0, 0.8], shadow: [0, 0, 0.2], lightDir: L }))
    bristle.position.z = 0.17
    // splayed tufts at the tips
    for (let i = 0; i < 9; i++) {
      const t = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.06, 0.06), inkMaterial({ ink: [0, 0, 0.9], shadow: [0, 0, 0.1], lightDir: L }))
      t.position.set(-0.46 + i * 0.115, (i % 2) * 0.02 - 0.01, 0.02)
      t.rotation.z = (i - 4) * 0.06
      g.add(t)
    }
    const block = new THREE.Mesh(new THREE.BoxGeometry(1.12, 0.24, 0.18), inkMaterial({ ink: [0.85, 0, 0.05], shadow: [0.1, 0, 0.5], lightDir: L }))
    block.position.z = 0.36
    const handle = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.065, 1.0, 12), inkMaterial({ ink: [0, 0.75, 0.05], shadow: [0, 0.15, 0.5], lightDir: L }))
    handle.position.set(0, 0.36, 0.72)
    handle.rotation.x = 0.85
    const ferrule = new THREE.Mesh(new THREE.CylinderGeometry(0.075, 0.075, 0.12, 12), inkMaterial({ ink: [0, 0, 0.25], shadow: [0, 0, 0.6], lightDir: L }))
    ferrule.position.set(0, 0.07, 0.5)
    ferrule.rotation.x = 0.85
    g.add(bristle, block, handle, ferrule)
    g.traverse(o => (o.renderOrder = 0))
    g.visible = false
    this.brush = g
    this.group.add(g)
    // soft contact shadow under the brush
    const m = new THREE.ShaderMaterial({
      toneMapped: false,
      transparent: true,
      depthWrite: false,
      blending: THREE.CustomBlending,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneFactor,
      blendSrcAlpha: THREE.ZeroFactor,
      blendDstAlpha: THREE.OneFactor,
      uniforms: { uA: { value: 0.4 } },
      vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
      fragmentShader: `uniform float uA; varying vec2 vUv; void main(){ vec2 p = (vUv - 0.5) * 2.0; float a = 1.0 - smoothstep(0.2, 1.0, length(p)); if (a < 0.01) discard; gl_FragColor = vec4(0.0, 0.0, a * uA, 0.0); }`,
    })
    this.brushShadow = new THREE.Mesh(new THREE.PlaneGeometry(1.7, 0.9), m)
    this.brushShadow.renderOrder = 5
    this.brushShadow.visible = false
    this.group.add(this.brushShadow)
  }

  private buildLens(q: number) {
    const mk = () => {
      const c = document.createElement('canvas')
      c.width = Math.round(768 * q)
      c.height = Math.round(768 * q)
      return this.canvasTex(c)
    }
    const texIn = mk()
    const texOut = mk()
    const { material, uniforms } = paperMaterial(texIn, [2, 2])
    // drawn last, over everything (incl. the additive shadows in the transparent pass)
    material.depthTest = false
    material.depthWrite = false
    material.transparent = true
    material.blending = THREE.NoBlending
    uniforms.uScreen.value = 1
    uniforms.uDist.value = 1.2
    uniforms.uPeelR.value = 0.16
    uniforms.uEdge.value = 0
    uniforms.uTone.value = 0
    uniforms.uShade.value = 0.4
    const geo = new THREE.PlaneGeometry(1, 1, this.mobile ? 24 : 36, this.mobile ? 24 : 36)
    const mesh = new THREE.Mesh(geo, material)
    mesh.frustumCulled = false
    mesh.renderOrder = 100
    mesh.visible = false
    this.group.add(mesh)
    this.lens = { mesh, u: uniforms, texIn, texOut }
  }

  private buildDom(stage: HTMLElement) {
    // opener caption (the headline itself is the poster)
    this.introEl = el('div', 'wk-intro', undefined, stage)
    const ib = el('div', 'wk-sticker', undefined, this.introEl)
    el('p', 'hud-eyebrow', SECTIONS.work.eyebrow, ib)
    el('p', 'hud-label wk-intro-note', `${pad(NF, 2)} featured · ${pad(NR, 2)} more · pasted fresh`, ib)

    // a job ticket per featured project
    FEATURED.forEach((item, k) => {
      const slot = el('div', `wk-slot ${this.sideOf(k) === 'right' ? 'is-left' : 'is-right'}`, undefined, stage)
      const card = el('article', 'wk-card hud-panel', undefined, slot)
      el('span', 'wk-tape', undefined, card).setAttribute('aria-hidden', 'true')
      const top = el('div', 'wk-card-top', undefined, card)
      el('p', 'hud-eyebrow', `Job ${pad(k + 1)} / ${pad(NF, 2)}`, top)
      if (isPreview(item.url)) el('span', 'wk-stamp', 'Preview', top)
      const name = rise(el('h3', 'hud-h2 wk-name', undefined, card), emLast(item.name))
      el('p', 'hud-label wk-ind', item.industry, card)
      el('p', 'hud-body wk-blurb', item.blurb, card)
      const tags = el('ul', 'hud-tags wk-tags', undefined, card)
      for (const t of item.tags) el('li', 'hud-tag', t, tags)
      el('hr', 'hud-rule', undefined, card)
      const foot = el('div', 'wk-foot', undefined, card)
      const a = el('a', 'hud-btn', isPreview(item.url) ? 'Preview site ↗' : 'Visit site ↗', foot)
      a.href = item.url
      a.target = '_blank'
      a.rel = 'noopener'
      el('span', 'hud-label wk-meta', isPreview(item.url) ? 'Pre-launch build' : `Sheet ${pad(k + 1, 2)} · 3-ink riso`, foot)
      this.cards.push({ slot, card, name })
    })

    // the notice board
    this.boardEl = el('div', 'wk-board', undefined, stage)
    const bc = el('div', 'wk-board-card hud-panel', undefined, this.boardEl)
    el('span', 'wk-tape', undefined, bc).setAttribute('aria-hidden', 'true')
    el('p', 'hud-eyebrow', `Also on the wall · ${pad(NF + 1, 2)}–${pad(NF + NR, 2)}`, bc)
    this.boardTitle = rise(el('h3', 'hud-h2 wk-board-title', undefined, bc), 'Nine more, <em>all live.</em>')
    el('p', 'hud-label wk-board-note', 'Stapled up · tap a flyer to visit', bc)
    const cta = el('div', 'wk-board-cta', undefined, this.boardEl)
    const btn = el('button', 'hud-btn', 'Say hello →', cta)
    btn.type = 'button'
    btn.addEventListener('click', () => window.__hark?.land('contact'))

    const spots = el('div', 'wk-spots', undefined, stage)
    REST.forEach(item => {
      const a = el('a', 'wk-spot', undefined, spots)
      a.href = item.url
      a.target = '_blank'
      a.rel = 'noopener'
      a.setAttribute('aria-label', `Visit ${item.name}`)
      el('span', 'wk-spot-tag', `${item.url.replace(/^https?:\/\//, '').replace(/\/$/, '')} ↗`, a)
      this.spots.push(a)
      this.spotBox.push([0, 0, 0, 0, -1])
    })
  }

  private sideOf(k: number): 'left' | 'right' {
    return k % 2 === 0 ? 'right' : 'left'
  }

  // ------------------------------------------------------------------ canvas jobs

  private upload(tex: THREE.Texture) {
    tex.needsUpdate = true
    try {
      this.ctx.renderer.initTexture(tex)
    } catch {
      /* uploads on first use instead */
    }
  }

  private pump() {
    if (this.pumping) return
    this.pumping = true
    const step = () => {
      const job = this.jobs.shift()
      try {
        job?.()
      } catch (err) {
        console.warn('[work] art job failed', err)
      }
      if (this.flyDirty && !this.jobs.length && this.flyPending <= 0) {
        this.flyDirty = false
        this.upload(this.flyTex)
      }
      if (this.jobs.length || (this.flyDirty && this.flyPending <= 0)) next()
      else this.pumping = false
    }
    const next = () => {
      if (document.hidden) setTimeout(step, 30)
      else requestAnimationFrame(step)
    }
    next()
  }

  private drawIntro() {
    art.drawIntro(this.intros[0].canvas!, NF, NR)
    this.upload(this.intros[0].tex!)
  }

  private drawOld() {
    art.drawOldAtlas(this.oldCanvas)
    this.upload(this.oldTex)
  }

  private drawSheets() {
    art.drawSheet(this.lens.texIn.image as HTMLCanvasElement, '02', 'PASTE-UP · SELECTED WORK', 'HARK PRESS · SHEET 02 / 07')
    art.drawSheet(this.lens.texOut.image as HTMLCanvasElement, '03', 'NEXT SHEET · TYPE CASE →', 'HARK PRESS · SHEET 03 / 07')
    this.upload(this.lens.texIn)
    this.upload(this.lens.texOut)
  }

  private drawPosterK(k: number) {
    const s = this.posters[k]
    const a = art.drawPoster(s.canvas!, { k, item: FEATURED[k] })
    this.art[k] = a
    s.u.uShotRect.value.set(...a.shot)
    s.u.uMono.value.set(...a.mono)
    this.upload(s.tex!)
  }

  private drawStencil() {
    const c = (this.stencil.material as THREE.ShaderMaterial).uniforms.uMap.value.image as HTMLCanvasElement
    const g = c.getContext('2d')!
    g.clearRect(0, 0, c.width, c.height)
    g.fillStyle = 'rgb(0,0,0)'
    g.fillRect(0, 0, c.width, c.height)
    g.fillStyle = 'rgb(0,0,235)'
    g.font = `800 condensed 190px ${art.FONT}`
    const any = g as CanvasRenderingContext2D & { fontStretch?: string; letterSpacing?: string }
    if ('fontStretch' in g) any.fontStretch = 'condensed'
    if ('letterSpacing' in g) any.letterSpacing = '8px'
    g.textAlign = 'center'
    g.fillText('POST NO BILLS', c.width / 2, 200)
    // stencil bridges + overspray
    g.globalCompositeOperation = 'multiply'
    g.fillStyle = 'rgb(0,0,0)'
    const r = rng(9)
    for (let x = 40; x < c.width; x += 23 + r() * 18) g.fillRect(x, 0, 5, c.height)
    g.globalCompositeOperation = 'lighter'
    for (let i = 0; i < 1400; i++) {
      g.fillStyle = `rgb(0,0,${Math.floor(40 + r() * 80)})`
      const x = c.width / 2 + (r() - 0.5) * c.width * 0.95
      const y = 128 + (r() - 0.5) * 220
      g.fillRect(x, y, 2, 2)
    }
    g.globalCompositeOperation = 'source-over'
    const tex = (this.stencil.material as THREE.ShaderMaterial).uniforms.uMap.value as THREE.Texture
    this.upload(tex)
  }

  private drawFlyerJ(j: number) {
    art.drawFlyer(this.flyCanvas, j, NF + j + 1, NF + NR, REST[j], this.flyImgs[j])
    this.flyDirty = true
  }

  // ------------------------------------------------------------------ images

  private startStreaming() {
    if (this.streaming) return
    this.streaming = true
    this.pumpLoads()
  }

  private pumpLoads() {
    while (this.loading < 2 && this.queue.length) this.queue.shift()!()
  }

  private fetchShot(k: number) {
    this.loading++
    loadImage(workImage(FEATURED[k].id))
      .then(img => {
        this.jobs.push(() => {
          // downsample once into a canvas (smaller upload, decoded off the hot path)
          const c = document.createElement('canvas')
          const w = this.mobile ? 640 : 896
          c.width = w
          c.height = Math.round(w * 0.625)
          c.getContext('2d')!.drawImage(img, 0, 0, c.width, c.height)
          const tex = this.canvasTex(c)
          tex.generateMipmaps = true
          this.upload(tex)
          this.shots[k] = tex
          const u = this.posters[k].u
          u.uShot.value = tex
          u.uHasShot.value = 1
        })
        this.pump()
      })
      .catch(err => console.warn(`[work] missing screenshot for ${FEATURED[k].id}`, err))
      .finally(() => {
        this.loading--
        if (this.streaming) this.pumpLoads()
      })
  }

  private fetchFlyer(j: number) {
    this.loading++
    loadImage(workImage(REST[j].id))
      .then(img => {
        this.flyImgs[j] = img
        art.loadFonts().then(() => {
          this.jobs.push(() => {
            this.drawFlyerJ(j)
            this.settleFlyer()
          })
          this.pump()
        })
      })
      .catch(err => {
        console.warn(`[work] missing screenshot for ${REST[j].id}`, err)
        this.settleFlyer()
      })
      .finally(() => {
        this.loading--
        if (this.streaming) this.pumpLoads()
      })
  }

  private settleFlyer() {
    this.flyPending--
    if (this.flyPending <= 0) this.pump()
  }

  // ------------------------------------------------------------------ layout

  private ensureLayout(f: Frame) {
    const key = `${f.width}x${f.height}`
    if (key === this.layKey) return
    this.layKey = key
    const W = f.width
    const H = f.height
    this.portrait = W / H < 0.95
    this.ctx.stage.classList.toggle('is-portrait', this.portrait)
    const safeTop = clamp(0.105 * H, 80, 112)
    const safeBot = clamp(0.095 * H, 72, 100)
    const gutter = clamp(0.034 * W, 16, 48)
    const fov = this.portrait ? 40 : 32
    const S = this.S
    const stageRect = this.ctx.stage.getBoundingClientRect()

    // opener
    const introR = this.introEl.getBoundingClientRect()
    let reg: Region
    if (this.portrait) reg = { x0: gutter * 0.6, x1: W - gutter * 0.6, y0: safeTop - 8, y1: introR.top - stageRect.top - 14 }
    else reg = { x0: W * 0.44, x1: W - gutter * 0.5, y0: safeTop * 0.6, y1: H - safeBot * 0.55 }
    // three-quarter view down the run
    dirOf(this.portrait ? -8 : -14, 1.5, this.D)
    frameTo(S.intro, INTRO_AT, this.D, IW + 0.25, IH + 0.25, reg, W, H, fov)

    // jobs
    for (let k = 0; k < NF; k++) {
      const side = this.sideOf(k)
      const cardEl = this.cards[k].card
      const slotR = this.cards[k].slot.getBoundingClientRect()
      if (this.portrait) {
        const top = slotR.bottom - stageRect.top - cardEl.offsetHeight
        reg = { x0: gutter, x1: W - gutter, y0: safeTop - 10, y1: top - 16 }
      } else {
        const cw = cardEl.offsetWidth
        reg =
          side === 'right'
            ? { x0: gutter + cw + 36, x1: W - gutter * 0.6, y0: safeTop - 22, y1: H - safeBot + 14 }
            : { x0: gutter * 0.6, x1: W - gutter - cw - 36, y0: safeTop - 22, y1: H - safeBot + 14 }
      }
      dirOf(side === 'right' ? 5 : -5, 1.5, this.D)
      const p = S.proj[k] ?? pose()
      frameTo(p, slotPos(k), this.D, PW + 0.3, PH + 0.3, reg, W, H, fov)
      S.proj[k] = p
    }

    // board
    const bc = this.boardEl.querySelector<HTMLElement>('.wk-board-card')!
    const cta = this.boardEl.querySelector<HTMLElement>('.wk-board-cta')!
    if (this.portrait) {
      const bb = bc.getBoundingClientRect()
      const cb = cta.getBoundingClientRect()
      reg = { x0: gutter * 0.6, x1: W - gutter * 0.6, y0: bb.bottom - stageRect.top + 10, y1: cb.top - stageRect.top - 12 }
    } else {
      const bb = bc.getBoundingClientRect()
      reg = { x0: bb.right - stageRect.left + 40, x1: W - gutter * 0.6, y0: safeTop - 16, y1: H - safeBot + 10 }
    }
    dirOf(4, 1, this.D)
    frameTo(S.board, BOARD_AT, this.D, BOARD_W + 0.5, BOARD_H + 0.5, reg, W, H, fov)
  }

  // ------------------------------------------------------------------ camera path

  private poseAt(local: number, out: Pose) {
    const S = this.S
    const p0 = sOf(0) - PANW
    if (local < p0) {
      // settle in from the lens peel: a slow push and un-roll
      const e = outCubic(segment(local, 0, p0))
      out.pos.copy(S.intro.pos).lerp(S.intro.tgt, -(1 - e) * 0.1 + e * 0.04)
      out.tgt.copy(S.intro.tgt)
      out.fov = S.intro.fov
      out.roll = -(1 - e) * 0.03
      return out
    }
    if (local < sOf(0)) {
      const a = this.tmpA
      a.pos.copy(S.intro.pos).lerp(S.intro.tgt, 0.04)
      a.tgt.copy(S.intro.tgt)
      a.fov = S.intro.fov
      a.roll = 0
      return this.panBetween(a, this.holdPose(0, 0, this.tmpB), segment(local, p0, sOf(0)), out)
    }
    for (let k = 0; k < NF; k++) {
      const s = sOf(k)
      if (local < s + HOLD_END) return this.holdPose(k, segment(local, s, s + HOLD_END), out)
      const last = k === NF - 1
      const end = last ? BOARD_IN[1] : sOf(k + 1)
      if (local < end) {
        const a = this.holdPose(k, 1, this.tmpA)
        const b = last ? S.board : this.holdPose(k + 1, 0, this.tmpB)
        return this.panBetween(a, b, segment(local, s + HOLD_END, end), out)
      }
    }
    // the board: a slow push
    const h = segment(local, BOARD_IN[1], 1)
    out.pos.copy(S.board.pos)
    out.tgt.copy(S.board.tgt)
    _r.subVectors(out.tgt, out.pos).normalize()
    out.pos.addScaledVector(_r, h * 0.5)
    out.fov = S.board.fov
    out.roll = 0
    return out
  }

  /** A job's framing, drifting slowly through its hold (h 0..1). */
  private holdPose(k: number, h: number, out: Pose) {
    const P = this.S.proj[k]
    out.pos.copy(P.pos)
    out.tgt.copy(P.tgt)
    _r.subVectors(out.tgt, out.pos).normalize()
    out.pos.addScaledVector(_r, h * 0.35)
    this.v.crossVectors(_r, UP).normalize()
    const dir = this.sideOf(k) === 'right' ? 1 : -1
    out.pos.addScaledVector(this.v, (h - 0.5) * 0.18 * dir)
    out.tgt.addScaledVector(this.v, (h - 0.5) * 0.18 * dir)
    out.fov = P.fov
    out.roll = 0
    return out
  }

  private panBetween(a: Pose, b: Pose, t: number, out: Pose) {
    const e = pan(t)
    blend(a, b, e, out)
    // pull back mid-pan so the wall reads, with a little lean into the move
    const arc = Math.sin(Math.PI * clamp(t))
    _r.subVectors(out.tgt, out.pos).normalize()
    out.pos.addScaledVector(_r, -arc * 1.4)
    out.roll += arc * 0.018 * Math.sign(b.pos.x - a.pos.x)
    return out
  }

  // ------------------------------------------------------------------ paper states

  /** Slap-up + brush-down of a sheet for paste progress q (0..1). */
  private paste(s: Sheet, q: number, local: number, time: number, dry: number, curlSide: number) {
    const on = q > 0
    s.pivot.visible = on
    s.shadow.visible = on
    if (!on) return
    const u = s.u
    const su = s.su
    if (this.reduced) {
      // calm: the sheet is up, the drums print in turn
      s.pivot.position.set(s.home.x, s.home.y + s.h / 2, s.home.z)
      s.pivot.rotation.set(0, 0, s.rot)
      u.uPress.value = 1
      u.uHang.value = 0
      u.uSwing.value = 0
      u.uWrinkle.value = 0.008
      u.uInk.value.set(segment(q, 0, 0.45), segment(q, 0.25, 0.7), segment(q, 0.5, 1))
      u.uWet.value = 0
      u.uCurl.value = 0.12
      u.uCurlDir.value.set(curlSide, -1).normalize()
      su.uPress.value = 1
      su.uHang.value = 0
      su.uFly.value = 0
      su.uCurl.value = 0.12
      return
    }
    u.uInk.value.set(1, 1, 1)
    const qs = twos(q, 22)
    const flyT = segment(qs, 0, 0.24)
    const ez = outCubic(flyT)
    const eb = flyT >= 1 ? 1 : outBack(flyT, 1.6)
    const away = 1 - ez
    s.pivot.position.set(s.home.x + away * 0.9, s.home.y + s.h / 2 + away * 1.3, s.home.z + away * 2.4)
    s.pivot.rotation.set(-away * 0.6, 0, s.rot + (1 - eb) * 0.3)
    const pr = segment(qs, 0.22, 0.86)
    const press = flyT < 1 ? 0 : 0.035 + 0.965 * inOutSine(pr)
    u.uPress.value = press
    const loose = 1 - pr
    u.uHang.value = flyT < 1 ? 0.12 : 0.1 * loose + 0.03
    u.uSwing.value = 0.05 * Math.sin(qs * 31) * loose
    const settle = smoothstep(0.78, 1, q)
    u.uWrinkle.value = lerp(0.05, 0.009, settle)
    u.uBoil.value = q < 1 ? (Math.floor(time * 12) % 7) * 0.37 : 0
    u.uWet.value = Math.min(1, 1.2 - dry)
    // a corner that never quite took the paste
    // breeze on the loose corner, animated on twos (12 fps), with the odd gust
    const tq = Math.floor(time * 12) / 12
    const gust = Math.max(0, Math.sin(tq * 0.9 + s.u.uSeed.value * 3.1)) ** 6
    const idle = this.reduced ? 0 : Math.sin(tq * 2.3 + s.u.uSeed.value) * 0.02 + gust * 0.06
    const curl = settle * (0.13 + idle)
    u.uCurl.value = curl
    u.uCurlDir.value.set(curlSide, -1).normalize()
    su.uPress.value = press
    su.uHang.value = u.uHang.value
    su.uFly.value = away
    su.uCurl.value = curl
    su.uStrength.value = 0.55
    void local
  }

  /** Rip an old sheet off the wall. */
  private peel(s: Sheet, r: number) {
    const on = r < 1
    s.pivot.visible = on
    if (!on) return
    if (this.reduced) {
      s.u.uPeel.value = 0
      s.pivot.visible = r < 0.5
      return
    }
    const rs = twos(r, 10)
    s.u.uPeel.value = inOutSine(rs) * 0.92
    const yank = smoothstep(0.55, 1, rs)
    s.pivot.position.set(s.home.x + yank * 1.2 * Math.sign(s.u.uPeelDir.value.x), s.home.y + s.h / 2 + yank * 2.2, s.home.z + yank * 1.6)
    s.pivot.rotation.set(-yank * 0.4, 0, s.rot + yank * 0.4)
  }

  private placeBrush(s: Sheet | null, q: number, time: number) {
    if (!s || this.reduced || q <= 0.12 || q >= 1) {
      this.brush.visible = false
      this.brushShadow.visible = false
      return
    }
    const qs = twos(q, 22)
    const enter = segment(qs, 0.12, 0.22)
    const pr = segment(qs, 0.22, 0.86)
    const exit = segment(qs, 0.86, 1)
    const press = 0.035 + 0.965 * inOutSine(pr)
    const top = s.home.y + s.h / 2
    let y = top - press * s.h + 0.03
    // zig-zag strokes across the sheet
    const zig = Math.sin(pr * Math.PI * 7)
    let x = s.home.x + zig * s.w * 0.26
    let z = s.home.z + 0.03
    y += (1 - enter) * 1.2 - exit * 1.6
    x += (1 - enter) * 1.4 + exit * 1.1
    z += (1 - enter) * 1.4 + exit * 1.2
    this.brush.visible = true
    this.brush.position.set(x, y, z)
    const scale = s.w / PW
    this.brush.scale.setScalar(1.08 * Math.max(0.9, scale * 0.85))
    // leaning into the stroke: bristles on the sheet, block above, handle up and out
    this.brush.rotation.set(-0.72 + (1 - enter) * 0.6, Math.cos(pr * Math.PI * 7) * 0.14, -Math.cos(pr * Math.PI * 7) * 0.18 + (1 - enter) * 0.4)
    this.brushShadow.visible = true
    this.brushShadow.position.set(x + 0.25, y - 0.32, s.home.z + 0.055)
    this.brushShadow.scale.setScalar(this.brush.scale.x)
    void time
  }

  // ------------------------------------------------------------------ frame

  update(local: number, frame: Frame, ctx: ChapterContext) {
    this.ensureLayout(frame)
    const time = frame.time
    this.poseAt(local, this.cur)
    this.pcam.fov = this.cur.fov
    this.pcam.aspect = frame.width / frame.height
    this.pcam.position.copy(this.cur.pos)
    this.pcam.up.set(0, 1, 0)
    this.pcam.lookAt(this.cur.tgt)
    if (this.cur.roll) this.pcam.rotateZ(this.cur.roll)
    this.pcam.updateProjectionMatrix()
    this.pcam.updateMatrixWorld()

    // ---- the opener run
    let active: Sheet | null = null
    let activeQ = 0
    let kick = 0
    for (let i = 0; i < this.intros.length; i++) {
      const w = INTRO_PASTE[i]
      const qi = segment(local, w[0], w[1])
      this.paste(this.intros[i], qi, local, time, segment(local, w[1] - 0.01, 0.12), i % 2 ? -1 : 1)
      kick = Math.max(kick, bump(qi, 0.26, 0.08))
      if (i === 0 && qi > 0 && qi < 1) {
        active = this.intros[0]
        activeQ = qi
      }
    }

    // ---- the six jobs
    for (let k = 0; k < NF; k++) {
      const s = sOf(k)
      this.peel(this.olds[k], segment(local, s + PEEL[0], s + PEEL[1]))
      const q = segment(local, s + PASTE[0], s + PASTE[1])
      this.paste(this.posters[k], q, local, time, segment(local, s + PASTE[1] - 0.01, s + HOLD_END), k % 2 ? -1 : 1)
      if (q > 0 && q < 1) {
        active = this.posters[k]
        activeQ = q
      }
      kick = Math.max(kick, bump(q, 0.26, 0.08))
      // posters well off-camera don't need their vertex work
      const near = Math.abs(local - (s + 0.05)) < 0.2
      this.posters[k].mesh.visible = near
      this.olds[k].mesh.visible = near
    }
    this.placeBrush(active, activeQ, time)

    // ---- the board of nine
    this.updateFlyers(local, time)

    // ---- lens sheets at the cuts
    this.updateLens(local, frame)

    // ---- HUD
    this.updateDom(local, frame)

    // ---- the press
    const p = ctx.post.params
    p.misreg = 1.4 + kick * 1.4
    const holdK = this.cards.some(c => c.card.classList.contains('is-on'))
    p.cell = holdK ? 5.0 : 5.5
  }

  private updateFlyers(local: number, time: number) {
    const d = this.flyData.array as Float32Array
    const vis = local > BOARD_IN[0] - 0.03
    this.flyers.visible = vis
    if (!vis) return
    // on a slow connection, show whatever flyers have printed once the board is up
    if (this.flyDirty && !this.jobs.length) {
      this.flyDirty = false
      this.upload(this.flyTex)
    }
    for (let j = 0; j < NR; j++) {
      const home = this.flyHome[j]
      const t0 = HOP0 + j * HOP_DT
      const h = segment(local, t0, t0 + HOP_LEN)
      const hs = this.reduced ? (h > 0 ? 1 : 0) : twos(h, 8)
      const away = 1 - (hs >= 1 ? 1 : outCubic(hs))
      const tilt = hs >= 1 ? 0 : 1 - outBack(hs, 2)
      const shown = h > 0 ? 1 : 0
      this.m4.compose(
        this.v4.set(home.pos.x + away * 0.5 * ((j % 3) - 1), home.pos.y + away * 1.1, home.pos.z + away * 1.4),
        this.q4.setFromEuler(this.e4.set(-away * 0.5, 0, home.rot + tilt * 0.35 * (j % 2 ? 1 : -1))),
        this.s4.setScalar(shown),
      )
      this.flyers.setMatrixAt(j, this.m4)
      const landing = h > 0 && h < 1 ? 0.35 * (1 - hs) : 0
      const sweep = bump(local, SWEEP0 + j * SWEEP_DT, SWEEP_DT * 1.4)
      d[j * 4 + 2] = this.reduced ? 0 : landing + sweep * 0.55
      d[j * 4 + 3] = this.reduced ? segment(h, 0, 1) : 1
    }
    this.flyers.instanceMatrix.needsUpdate = true
    this.flyData.needsUpdate = true
    this.flyMat.uniforms.uTime.value = this.reduced ? 0 : Math.floor(time * 12) / 12
  }

  private updateLens(local: number, frame: Frame) {
    const L = this.lens
    const u = L.u
    const inT = segment(local, LENS_IN[0], LENS_IN[1])
    const outT = segment(local, LENS_OUT[0], LENS_OUT[1])
    const showIn = local < LENS_IN[1] && !this.reduced
    const showOut = local > LENS_OUT[0] && !this.reduced
    L.mesh.visible = showIn || showOut
    if (!L.mesh.visible) return
    const dist = 1.2
    const hh = 2 * dist * Math.tan((this.cur.fov * DEG) / 2) * 1.3
    const ww = hh * (frame.width / frame.height) * 1.1
    u.uSize.value.set(ww, hh)
    u.uDist.value = dist
    if (showIn) {
      u.uMap.value = L.texIn
      u.uPeel.value = inOutSine(twos(inT, 14))
      u.uPeelDir.value.set(1, -0.7).normalize()
      u.uPeelR.value = hh * 0.15
      u.uPress.value = 1
      u.uHang.value = 0
      u.uSwing.value = 0
      u.uWrinkle.value = 0.02
      u.uCurl.value = 0
      u.uWet.value = 0
      u.uBoil.value = 0
      L.mesh.position.set(0, 0, 0)
      this.setLensOffset(0, 0)
    } else {
      // slapped over the lens: arrives top-first, brushed flat down the frame
      u.uMap.value = L.texOut
      u.uPeel.value = 0
      const qs = twos(outT, 16)
      const fly = outCubic(segment(qs, 0, 0.3))
      u.uPress.value = fly < 1 ? 0 : 0.05 + 0.95 * inOutSine(segment(qs, 0.3, 0.85))
      u.uHang.value = -0.03 * (1 - segment(qs, 0.3, 0.85))
      u.uSwing.value = 0
      u.uWrinkle.value = lerp(0.035, 0.01, segment(qs, 0.7, 1))
      u.uBoil.value = (Math.floor(frame.time * 12) % 5) * 0.41
      u.uCurl.value = 0
      u.uWet.value = 0.5
      this.setLensOffset((1 - fly) * hh * 0.1, (1 - fly) * hh * 1.05)
    }
  }

  private setLensOffset(x: number, y: number) {
    this.lens.u.uOffset.value.set(x, y)
  }

  private updateDom(local: number, frame: Frame) {
    // opener
    const introOn = local > INTRO_ON[0] && local < INTRO_ON[1] + 0.01
    this.introEl.classList.toggle('is-on', introOn)

    for (let k = 0; k < NF; k++) {
      const s = sOf(k)
      const on = local > s + CARD[0] && local < s + CARD[1]
      const c = this.cards[k]
      if (c.card.classList.contains('is-on') !== on) c.card.classList.toggle('is-on', on)
      setRise(c.name, on)
    }

    const boardOn = local > BOARD_ON[0] && local < BOARD_ON[1]
    this.boardEl.classList.toggle('is-on', boardOn)
    setRise(this.boardTitle, boardOn)

    // flyer hotspots follow the board
    const spotsOn = local > HOP0 + NR * HOP_DT + HOP_LEN - 0.004 && local < BOARD_ON[1]
    const W = frame.width
    const H = frame.height
    for (let j = 0; j < NR; j++) {
      const a = this.spots[j]
      const box = this.spotBox[j]
      const vis = spotsOn ? 1 : 0
      if (box[4] !== vis) {
        box[4] = vis
        a.classList.toggle('is-on', !!vis)
      }
      if (!vis) continue
      const hp = this.flyHome[j].pos
      let x0 = Infinity
      let y0 = Infinity
      let x1 = -Infinity
      let y1 = -Infinity
      for (const [dx, dy] of [
        [-1, -1],
        [1, -1],
        [-1, 1],
        [1, 1],
      ]) {
        this.v.set(hp.x + (dx * FLW) / 2, hp.y + (dy * FLH) / 2, hp.z).project(this.pcam)
        const sx = (this.v.x * 0.5 + 0.5) * W
        const sy = (-this.v.y * 0.5 + 0.5) * H
        x0 = Math.min(x0, sx)
        x1 = Math.max(x1, sx)
        y0 = Math.min(y0, sy)
        y1 = Math.max(y1, sy)
      }
      if (!Number.isFinite(x0 + x1 + y0 + y1)) continue
      const hot = bump(local, SWEEP0 + j * SWEEP_DT, SWEEP_DT * 0.6) > 0.35
      a.classList.toggle('is-hot', hot)
      if (Math.abs(box[0] - x0) > 0.5 || Math.abs(box[1] - y0) > 0.5 || Math.abs(box[2] - x1) > 0.5 || Math.abs(box[3] - y1) > 0.5) {
        box[0] = x0
        box[1] = y0
        box[2] = x1
        box[3] = y1
        a.style.transform = `translate3d(${x0.toFixed(1)}px, ${y0.toFixed(1)}px, 0)`
        a.style.width = `${(x1 - x0).toFixed(1)}px`
        a.style.height = `${(y1 - y0).toFixed(1)}px`
      }
    }
  }

  camera(_local: number, _frame: Frame, out: CameraPose) {
    out.position.copy(this.cur.pos)
    out.target.copy(this.cur.tgt)
    out.fov = this.cur.fov
    out.roll = this.cur.roll
    out.parallax = this.reduced ? 0 : 0.18
  }
}

export default function create(): Chapter {
  return new Work()
}
