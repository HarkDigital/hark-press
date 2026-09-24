import * as THREE from 'three'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'
import { inkCanvasMaterial, inkLineMaterial, inkMaterial, type Ink } from '../../print/ink'
import { clamp, ease, lerp, rng, segment } from '../../core/math'
import { buildAtlas, CASE_ROWS, CELL_WORLD, type Atlas, type Glyph } from './atlas'
import { INTRO_WORD, JOBS, PH, SET_WORDS, inkOf, type JobPhase } from './timeline'

/*
 * The letterpress bench, printed in ink densities:
 *
 *   the TYPE CASE      a wide drawer of wood type, 6 × 8 compartments, each
 *                      holding a few sorts of one letter (faces up)
 *   the CHASE          an iron frame in front of it where a line is set,
 *                      with wood furniture that locks the line up
 *   two INK SLABS      green (right) and pink (left), each with its brayer
 *   the SHEET          dropped on the inked forme, pressed, then peeled
 *
 * Sorts are one InstancedMesh of boxes; the top face of each samples its
 * letter from a glyph atlas (per-instance cell + width), so the letters are
 * real, crisp and carry per-instance ink. The ~20 sorts that travel are a
 * second InstancedMesh; the case copy they came from is hidden while they
 * are out, so every hop starts and ends exactly in its compartment.
 *
 * Everything is derived from `local` (see timeline.ts): jumping to any
 * point of the story lands on the right state.
 */

/* ---------------- dimensions (world units; the type body is 1 deep) ---------------- */

export const TH = 0.55
export const CASE_FLOOR = 0.12
const WALL = 0.1
const COMP_W = 2.0
const COMP_D = 2.12
const SORT_GAP = 0.05
const CASE_COLS = 8
export const CASE_W = CASE_COLS * COMP_W + (CASE_COLS + 1) * WALL
export const CASE_D = CASE_ROWS.length * COMP_D + (CASE_ROWS.length + 1) * WALL
/** the case's front edge sits on z = 0; the chase is in front of it */
export const Z_CHASE = 2.85
const SPACE = 0.36
const SET_GAP = 0.03
const FURN_D = 0.5
const CHASE_BAR = 0.3
const CHASE_H = TH * 0.76
const RR = 0.34
const BRAYER_L = 1.7
const SLAB_W = 2.9
const SLAB_D = 2.4
const SLAB_H = 0.1

const INK_GREEN: Ink = [0, 1, 0]
const INK_PINK: Ink = [1, 0, 0.04]
const INK_KEY: Ink = [0, 0, 0.93]
const inkVec = (i: number): Ink => (i === 0 ? INK_GREEN : i === 1 ? INK_PINK : INK_KEY)

const LIGHT = new THREE.Vector3(-0.5, 0.82, 0.42).normalize()

/* ---------------- layout ---------------- */

interface Slot {
  x: number
  z: number
  yaw: number
  ink: Ink
}
interface Compartment {
  ch: string
  cx: number
  cz: number
  slots: Slot[]
  /** index of slot 0 in the static mesh */
  base: number
}
interface Sort {
  ch: string
  g: Glyph
  x: number
  comp: number
  copy: number
  yaw: number
}
export interface SetLine {
  text: string
  sorts: Sort[]
  /** half the set width */
  half: number
  ink: number
}

const groupOf = (job: number) => ((job % 2) + 2) % 2

/* ---------------- shaders ---------------- */

const SORT_VERT = /* glsl */ `
attribute vec4 aGlyph;
attribute vec3 aInkA;
attribute vec4 aInkB;
varying vec3 vObj;
varying vec3 vNObj;
varying vec3 vN;
varying vec3 vWorld;
varying vec4 vGlyph;
varying vec3 vInkA;
varying vec4 vInkB;
void main() {
  vObj = position;
  vNObj = normal;
  vGlyph = aGlyph;
  vInkA = aInkA;
  vInkB = aInkB;
  vec4 wp = modelMatrix * instanceMatrix * vec4(position, 1.0);
  vWorld = wp.xyz;
  vN = normalize(mat3(modelMatrix) * mat3(instanceMatrix) * normal);
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`

const SORT_FRAG = /* glsl */ `
uniform sampler2D uAtlas;
uniform vec2 uCell;
uniform float uCellWorld, uTH;
uniform vec3 uLight;
uniform vec2 uShadowOff;
uniform vec3 uRoll;
varying vec3 vObj;
varying vec3 vNObj;
varying vec3 vN;
varying vec3 vWorld;
varying vec4 vGlyph;
varying vec3 vInkA;
varying vec4 vInkB;
void main() {
  vec3 n = normalize(vN);
  float ndl = dot(n, uLight);
  float shade = 1.0 - smoothstep(-0.3, 0.95, ndl);
  float w = vGlyph.z;
  float top = step(0.5, vNObj.y);

  // the letter on the top face (sampled everywhere, used on top only)
  vec2 f = vec2(vObj.x * w, -vObj.z);
  vec2 cuv = vGlyph.xy + (f / uCellWorld + 0.5) * uCell;
  float g = texture2D(uAtlas, cuv).r;
  float gs = texture2D(uAtlas, cuv + uShadowOff).r;
  float aa = max(fwidth(g), 0.015);
  float letter = smoothstep(0.5 - aa, 0.5 + aa, g);
  float castSh = smoothstep(0.3, 0.7, gs) * (1.0 - letter);

  // printer's edges: every face gets a hairline where it meets its neighbours
  vec3 an = abs(vNObj);
  float ex = (0.5 - abs(vObj.x)) * w;
  float ey = min(vObj.y, 1.0 - vObj.y) * uTH;
  float ez = 0.5 - abs(vObj.z);
  float e = min(mix(ex, 9.0, an.x), min(mix(ey, 9.0, an.y), mix(ez, 9.0, an.z)));
  float fe = max(fwidth(e), 1e-4);
  float line = 1.0 - smoothstep(fe * 0.7, fe * 1.7, e);

  // ink on the face: the old ink, or fresh ink where the brayer has passed
  float rolled = vInkB.w > 0.5 ? 1.0 : (vInkB.w < -0.5 ? 0.0 : step(0.0, uRoll.y * (uRoll.x - vWorld.x)));
  vec3 ink = mix(vInkA, vInkB.rgb, rolled);

  // end-grain maple, darker on the routed floor round the letter
  vec3 wood = vec3(0.05, 0.0, 0.02);
  vec3 floorInk = wood + vec3(0.03, 0.0, 0.07) + vec3(0.0, 0.0, 0.3) * castSh;
#ifdef BOLD
  // the final proof prints bold: where the fresh ink lands, the letter gets a
  // key keyline and a deep key drop, so the green reads dense on the bench
  float bold = vGlyph.w * rolled;
  vec2 kr = uCell * (0.05 / uCellWorld);
  vec2 kd = kr * 0.7071;
  float halo = max(
    max(texture2D(uAtlas, cuv + vec2(kr.x, 0.0)).r, texture2D(uAtlas, cuv - vec2(kr.x, 0.0)).r),
    max(texture2D(uAtlas, cuv + vec2(0.0, kr.y)).r, texture2D(uAtlas, cuv - vec2(0.0, kr.y)).r));
  halo = max(halo, max(
    max(texture2D(uAtlas, cuv + kd).r, texture2D(uAtlas, cuv - kd).r),
    max(texture2D(uAtlas, cuv + vec2(kd.x, -kd.y)).r, texture2D(uAtlas, cuv + vec2(-kd.x, kd.y)).r)));
  float drop = texture2D(uAtlas, cuv + uShadowOff * 2.2).r;
  float rim = max(smoothstep(0.2, 0.55, halo), smoothstep(0.3, 0.7, drop)) * (1.0 - letter);
  floorInk = mix(floorInk, vec3(0.0, 0.0, 0.97), rim * bold);
#endif
  vec3 faceCol = mix(floorInk, ink, letter);
  vec3 sideCol = wood + vec3(0.1, 0.0, 0.06) + vec3(0.06, 0.0, 0.5) * shade;
  vec3 d = mix(sideCol, faceCol, top);
  d = mix(d, vec3(max(d.r, 0.1), d.g, 0.9), line);
  gl_FragColor = vec4(d, 1.0 - line);
}
`

const SHADOW_VERT = /* glsl */ `
attribute float aStrength;
varying vec2 vUv;
varying float vS;
void main() {
  vUv = uv;
  vS = aStrength;
  gl_Position = projectionMatrix * viewMatrix * modelMatrix * instanceMatrix * vec4(position, 1.0);
}
`
const SHADOW_FRAG = /* glsl */ `
varying vec2 vUv;
varying float vS;
void main() {
  vec2 q = (vUv - 0.5) * 2.0;
  float r = length(q);
  float a = 1.0 - smoothstep(0.35, 1.0, r);
  if (a * vS <= 0.004) discard;
  gl_FragColor = vec4(0.0, 0.0, vS * a, 1.0);
}
`

const PLAIN_VERT = /* glsl */ `
varying vec2 vUv;
varying vec3 vN;
void main() {
  vUv = uv;
  vN = normalize(mat3(modelMatrix) * normal);
  gl_Position = projectionMatrix * viewMatrix * modelMatrix * vec4(position, 1.0);
}
`

/** brayer rubber: solid ink with roller streaks, shade adds black */
const ROLLER_FRAG = /* glsl */ `
uniform vec3 uInk, uLight;
varying vec2 vUv;
varying vec3 vN;
void main() {
  float ndl = dot(normalize(vN), uLight);
  float shade = 1.0 - smoothstep(-0.4, 0.9, ndl);
  float streak = step(0.72, fract(vUv.x * 19.0 + sin(vUv.y * 9.0) * 0.08));
  vec3 d = uInk * (0.94 - 0.18 * streak) + vec3(0.0, 0.0, 0.55) * shade;
  gl_FragColor = vec4(d, 1.0);
}
`

/** ink rolled out on the slab: an even film with brayer tracks */
const SLAB_INK_FRAG = /* glsl */ `
uniform vec3 uInk;
varying vec2 vUv;
varying vec3 vN;
float h(float x) { return fract(sin(x * 91.7) * 43758.5); }
void main() {
  float lane = floor(vUv.y * 7.0);
  float track = step(0.86, fract(vUv.y * 7.0)) * 0.22 + h(lane) * 0.08;
  float edge = smoothstep(0.0, 0.05, vUv.x) * smoothstep(1.0, 0.95, vUv.x);
  vec3 d = uInk * (0.97 - track) * mix(0.55, 1.0, edge);
  gl_FragColor = vec4(d, 1.0);
}
`

const SHEET_VERT = /* glsl */ `
uniform float uCurl, uR, uBend, uW;
varying vec2 vUv;
varying vec3 vN;
varying float vLift;
const float PI = 3.14159265;
void main() {
  vUv = uv;
  vec3 p = position;
  vec3 n = vec3(0.0, 1.0, 0.0);
  // a little billow while it floats down
  p.y += uBend * sin(PI * uv.x) * (0.6 + 0.4 * sin(PI * uv.y));
  float s = uCurl - p.x;
  vLift = 0.0;
  if (s > 0.0) {
    float th = s / uR;
    if (th < PI) {
      p.x = uCurl - uR * sin(th);
      p.y += uR * (1.0 - cos(th));
      n = vec3(sin(th), cos(th), 0.0);
    } else {
      p.x = uCurl + (s - PI * uR);
      p.y += 2.0 * uR;
      n = vec3(0.0, -1.0, 0.0);
    }
    vLift = 1.0;
  }
  vN = normalize(mat3(modelMatrix) * n);
  gl_Position = projectionMatrix * viewMatrix * modelMatrix * vec4(p, 1.0);
}
`

const SHEET_FRAG = /* glsl */ `
uniform sampler2D uPrint;
uniform vec4 uRow;
uniform vec3 uInk, uLight;
uniform float uGhost;
varying vec2 vUv;
varying vec3 vN;
varying float vLift;
void main() {
  vec3 n = normalize(vN);
  bool front = gl_FrontFacing;
  // the printed side reads right once the sheet has turned over
  vec2 pu = vec2(front ? vUv.x : 1.0 - vUv.x, vUv.y);
  vec4 t = texture2D(uPrint, uRow.xy + pu * uRow.zw);
  float ndl = dot(front ? n : -n, uLight);
  float shade = 1.0 - smoothstep(-0.2, 0.95, ndl);
  vec2 ed = min(vUv, 1.0 - vUv) * vec2(10.0, 2.4);
  float e = min(ed.x, ed.y);
  float fe = max(fwidth(e), 1e-4);
  float line = 1.0 - smoothstep(fe * 0.7, fe * 1.8, e);
  // clean stock: a whisper of tone, shade only where it curls
  float curl = smoothstep(0.08, 0.5, shade);
  vec3 d = vec3(0.0, 0.0, 0.03 + 0.42 * curl);
  float ht = step(0.02, curl);
  if (front) {
    // show-through of the print (the final proof bites hard enough to read)
    d += uInk * t.r * uGhost;
    d.b = max(d.b, t.b * uGhost);
    ht = max(ht, step(0.01, max(t.r, t.b) * uGhost));
  } else {
    d = max(d, uInk * t.r * 0.97);
    d.b = max(d.b, t.b * 0.9);
    ht = 1.0;
  }
  d = mix(d, vec3(0.0, 0.0, 0.9), line);
  gl_FragColor = vec4(d, ht * (1.0 - line));
}
`

/* ---------------- helpers ---------------- */

/** shadows build ink over whatever is printed below (max), never erase it */
const MAX_BLEND = {
  transparent: true,
  depthWrite: false,
  toneMapped: false,
  blending: THREE.CustomBlending,
  blendEquation: THREE.MaxEquation,
  blendEquationAlpha: THREE.MaxEquation,
  blendSrc: THREE.OneFactor,
  blendDst: THREE.OneFactor,
} as const

function boxAt(w: number, h: number, d: number, x: number, y: number, z: number) {
  const g = new THREE.BoxGeometry(w, h, d)
  g.translate(x, y + h / 2, z)
  return g
}

function outline(geo: THREE.BufferGeometry, ink: Ink = [0, 0, 0.92], angle = 20) {
  return new THREE.LineSegments(new THREE.EdgesGeometry(geo, angle), inkLineMaterial(ink, 0))
}

const _m = new THREE.Matrix4()
const _m2 = new THREE.Matrix4()
const _q = new THREE.Quaternion()
const _q2 = new THREE.Quaternion()
const _p = new THREE.Vector3()
const _s = new THREE.Vector3()
const _ax = new THREE.Vector3()
const _up = new THREE.Vector3(0, 1, 0)

interface Pose {
  x: number
  y: number
  z: number
  yaw: number
}

/* ---------------- the press ---------------- */

export interface PressState {
  /** 0..1 how far the brayer is through its pass (for post wobble) */
  rolling: number
  /** 0..1 impression kick at the press */
  impression: number
  /** world position of the brayer */
  roller: THREE.Vector3
  /** world point at the left end of the set line (for the setting callout) */
  lineStart: THREE.Vector3
  /** half width of the line currently in the chase */
  lineHalf: number
}

export class Press {
  group = new THREE.Group()
  atlas!: Atlas
  lines: SetLine[] = []
  introLine!: SetLine
  comps: Compartment[] = []
  private compOf = new Map<string, number>()
  private statics!: THREE.InstancedMesh
  private movers!: THREE.InstancedMesh
  private shadows!: THREE.InstancedMesh
  private staticHidden!: Uint8Array
  private staticWant!: Uint8Array
  private staticMats!: Float32Array
  private moverGlyph!: THREE.InstancedBufferAttribute
  private moverInkA!: THREE.InstancedBufferAttribute
  private moverInkB!: THREE.InstancedBufferAttribute
  private shadowStrength!: THREE.InstancedBufferAttribute
  private sortMat!: THREE.ShaderMaterial
  private maxN = 0
  private chaseInHalf = 5
  private furnL!: THREE.Object3D
  private furnR!: THREE.Object3D
  private brayers: { root: THREE.Group; roller: THREE.Mesh; rest: THREE.Vector3; side: number }[] = []
  private sheet!: THREE.Mesh
  private sheetShadow!: THREE.Mesh
  private sheetMat!: THREE.ShaderMaterial
  private sheetW = 10
  private sheetD = 2.2
  private printRows = { cols: 2, rows: 6 }
  readonly state: PressState = {
    rolling: 0,
    impression: 0,
    roller: new THREE.Vector3(),
    lineStart: new THREE.Vector3(),
    lineHalf: 0,
  }
  /** world boxes the camera frames */
  readonly bounds = {
    chaseHalfX: 5,
    chaseHalfZ: 1.3,
    slabX: 8,
  }

  constructor(private mobile: boolean) {}

  /* ---------- build ---------- */

  async build(yieldFrame: () => Promise<void>) {
    // one chunk per frame so the loader keeps moving
    const steps: (() => void)[] = [
      () => {
        this.atlas = buildAtlas(this.mobile ? 128 : 224)
        this.layoutLines()
        this.layoutCase()
      },
      () => {
        this.buildCase()
        this.buildSorts()
      },
      () => {
        this.buildChase()
        this.buildSlabs()
      },
      () => this.buildSheet(),
      () => this.buildTable(),
    ]
    for (let i = 0; i < steps.length; i++) {
      if (i) await yieldFrame()
      steps[i]()
    }
  }

  private makeLine(text: string, job: number): SetLine {
    const sorts: Sort[] = []
    let x = 0
    const r = rng(17 + job * 31)
    const seen = new Map<string, number>()
    for (const ch of text) {
      if (ch === ' ') {
        x += SPACE
        continue
      }
      const g = this.atlas.glyphs.get(ch)
      if (!g) continue
      const occ = seen.get(ch) ?? 0
      seen.set(ch, occ + 1)
      sorts.push({ ch, g, x: x + g.w / 2, comp: -1, copy: occ, yaw: (r() - 0.5) * 0.02 })
      x += g.w + SET_GAP
    }
    const width = x - SET_GAP
    for (const s of sorts) s.x -= width / 2
    return { text, sorts, half: width / 2, ink: inkOf(job) }
  }

  private layoutLines() {
    this.introLine = this.makeLine(INTRO_WORD, -1)
    this.lines = SET_WORDS.map((w, k) => this.makeLine(w, k))
    this.maxN = Math.max(this.introLine.sorts.length, ...this.lines.map(l => l.sorts.length))
    const maxHalf = Math.max(this.introLine.half, ...this.lines.map(l => l.half))
    this.chaseInHalf = maxHalf + 0.95
    this.bounds.chaseHalfX = this.chaseInHalf + CHASE_BAR
    this.bounds.chaseHalfZ = 0.5 + FURN_D + CHASE_BAR
    this.bounds.slabX = this.bounds.chaseHalfX + 0.7 + SLAB_W / 2
  }

  private layoutCase() {
    // copies each group needs of each letter (even jobs, odd jobs incl. the intro line)
    const need: [Map<string, number>, Map<string, number>] = [new Map(), new Map()]
    const all: [SetLine, number][] = [[this.introLine, -1], ...this.lines.map((l, k) => [l, k] as [SetLine, number])]
    for (const [line, job] of all) {
      const count = new Map<string, number>()
      for (const s of line.sorts) count.set(s.ch, (count.get(s.ch) ?? 0) + 1)
      const n = need[groupOf(job)]
      for (const [ch, c] of count) n.set(ch, Math.max(n.get(ch) ?? 0, c))
    }
    const r = rng(2026)
    let base = 0
    CASE_ROWS.forEach((row, ri) => {
      for (let ci = 0; ci < row.length; ci++) {
        const ch = row[ci]
        const g = this.atlas.glyphs.get(ch)!
        const cx = -CASE_W / 2 + WALL + COMP_W / 2 + ci * (COMP_W + WALL)
        const cz = -WALL - COMP_D / 2 - ri * (COMP_D + WALL)
        const perRow = Math.max(1, Math.floor((COMP_W - 0.08 + SORT_GAP) / (g.w + SORT_GAP)))
        const cap = perRow * 2
        const needed = (need[0].get(ch) ?? 0) + (need[1].get(ch) ?? 0)
        const fill = this.mobile ? Math.ceil(cap * 0.5) : cap - (r() < 0.35 ? 1 : 0)
        const count = Math.min(cap, Math.max(needed, fill))
        const slots: Slot[] = []
        for (let i = 0; i < count; i++) {
          const rowI = i < perRow ? 0 : 1
          const inRow = rowI === 0 ? Math.min(count, perRow) : count - perRow
          const j = rowI === 0 ? i : i - perRow
          const rowW = inRow * g.w + (inRow - 1) * SORT_GAP
          const slack = COMP_W - 0.08 - rowW
          const x0 = cx - COMP_W / 2 + 0.04 + slack * (0.3 + r() * 0.4)
          const roll = r()
          const ink: Ink =
            roll < 0.12 ? [0.9, 0, 0.12] : roll < 0.2 ? [0, 0.85, 0.1] : roll < 0.26 ? [0, 0, 0.6] : [0, 0, 0.9]
          slots.push({
            x: x0 + j * (g.w + SORT_GAP) + g.w / 2 + (r() - 0.5) * 0.02,
            z: cz + (rowI === 0 ? 0.53 : -0.53) + (r() - 0.5) * 0.03,
            yaw: (r() - 0.5) * 0.07,
            ink,
          })
        }
        this.compOf.set(ch, this.comps.length)
        this.comps.push({ ch, cx, cz, slots, base })
        base += slots.length
      }
    })
    // each sort in a line takes its own copy: group 0 uses the first copies, group 1 the next
    const assign = (line: SetLine, job: number) => {
      const grp = groupOf(job)
      for (const s of line.sorts) {
        const c = this.compOf.get(s.ch)!
        s.comp = c
        const off = grp === 0 ? 0 : (need[0].get(s.ch) ?? 0)
        s.copy = Math.min(this.comps[c].slots.length - 1, off + s.copy)
      }
    }
    assign(this.introLine, -1)
    this.lines.forEach((l, k) => assign(l, k))
  }

  private sortMaterial() {
    const tex = new THREE.CanvasTexture(this.atlas.canvas)
    tex.colorSpace = THREE.NoColorSpace
    tex.anisotropy = 8
    tex.generateMipmaps = true
    tex.minFilter = THREE.LinearMipmapLinearFilter
    // the letter's shadow falls away from the light across the routed floor
    const off = new THREE.Vector2(LIGHT.x, -LIGHT.z).normalize().multiplyScalar(0.05 / CELL_WORLD)
    return new THREE.ShaderMaterial({
      vertexShader: SORT_VERT,
      fragmentShader: SORT_FRAG,
      toneMapped: false,
      uniforms: {
        uAtlas: { value: tex },
        uCell: { value: new THREE.Vector2(this.atlas.cu, this.atlas.cv) },
        uCellWorld: { value: CELL_WORLD },
        uTH: { value: TH },
        uLight: { value: LIGHT.clone() },
        uShadowOff: { value: new THREE.Vector2(off.x * this.atlas.cu, off.y * this.atlas.cv) },
        uRoll: { value: new THREE.Vector3(0, 1, 0) },
      },
    })
  }

  private buildSorts() {
    const geo = new THREE.BoxGeometry(1, 1, 1)
    geo.translate(0, 0.5, 0)
    this.sortMat = this.sortMaterial()

    // the case: every copy of every letter
    const nStatic = this.comps.reduce((a, c) => a + c.slots.length, 0)
    const sGeo = geo.clone()
    const sGlyph = new Float32Array(nStatic * 4)
    const sInkA = new Float32Array(nStatic * 3)
    const sInkB = new Float32Array(nStatic * 4)
    this.statics = new THREE.InstancedMesh(sGeo, this.sortMat, nStatic)
    this.staticMats = new Float32Array(nStatic * 16)
    for (const c of this.comps) {
      const g = this.atlas.glyphs.get(c.ch)!
      c.slots.forEach((s, j) => {
        const i = c.base + j
        this.slotMatrix(_m, s, g.w, CASE_FLOOR)
        _m.toArray(this.staticMats, i * 16)
        this.statics.setMatrixAt(i, _m)
        sGlyph.set([g.u, g.v, g.w, 0], i * 4)
        sInkA.set(s.ink, i * 3)
        sInkB.set([0, 0, 0, -1], i * 4)
      })
    }
    sGeo.setAttribute('aGlyph', new THREE.InstancedBufferAttribute(sGlyph, 4))
    sGeo.setAttribute('aInkA', new THREE.InstancedBufferAttribute(sInkA, 3))
    sGeo.setAttribute('aInkB', new THREE.InstancedBufferAttribute(sInkB, 4))
    this.statics.frustumCulled = false
    this.staticHidden = new Uint8Array(nStatic)
    this.staticWant = new Uint8Array(nStatic)
    this.group.add(this.statics)

    // the travellers: two lines' worth (one being set while the last is distributed)
    const nMov = this.maxN * 2
    const mGeo = geo.clone()
    this.moverGlyph = new THREE.InstancedBufferAttribute(new Float32Array(nMov * 4), 4)
    this.moverInkA = new THREE.InstancedBufferAttribute(new Float32Array(nMov * 3), 3)
    this.moverInkB = new THREE.InstancedBufferAttribute(new Float32Array(nMov * 4), 4)
    for (const a of [this.moverGlyph, this.moverInkA, this.moverInkB]) a.setUsage(THREE.DynamicDrawUsage)
    mGeo.setAttribute('aGlyph', this.moverGlyph)
    mGeo.setAttribute('aInkA', this.moverInkA)
    mGeo.setAttribute('aInkB', this.moverInkB)
    // the travellers print the final proof bold (a few extra atlas taps, so only
    // these ~20 sorts pay for them); the uniforms are shared with the case
    const moverMat = new THREE.ShaderMaterial({
      vertexShader: SORT_VERT,
      fragmentShader: SORT_FRAG,
      toneMapped: false,
      defines: { BOLD: 1 },
      uniforms: this.sortMat.uniforms,
    })
    this.movers = new THREE.InstancedMesh(mGeo, moverMat, nMov)
    this.movers.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
    this.movers.frustumCulled = false
    this.group.add(this.movers)

    // their contact shadows
    const shGeo = new THREE.PlaneGeometry(1, 1)
    shGeo.rotateX(-Math.PI / 2)
    this.shadowStrength = new THREE.InstancedBufferAttribute(new Float32Array(nMov), 1)
    this.shadowStrength.setUsage(THREE.DynamicDrawUsage)
    shGeo.setAttribute('aStrength', this.shadowStrength)
    this.shadows = new THREE.InstancedMesh(
      shGeo,
      new THREE.ShaderMaterial({
        vertexShader: SHADOW_VERT,
        fragmentShader: SHADOW_FRAG,
        ...MAX_BLEND,
      }),
      nMov,
    )
    this.shadows.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
    this.shadows.frustumCulled = false
    this.shadows.renderOrder = 2
    this.group.add(this.shadows)
  }

  private slotMatrix(out: THREE.Matrix4, s: { x: number; z: number; yaw: number }, w: number, y: number) {
    _q.setFromAxisAngle(_up, s.yaw)
    _p.set(s.x, y, s.z)
    _s.set(w, TH, 1)
    return out.compose(_p, _q, _s)
  }

  private buildCase() {
    const wood = inkMaterial({ ink: [0.36, 0, 0.3], shadow: [0.1, 0, 0.45], lightDir: LIGHT })
    const floorMat = inkMaterial({ ink: [0.3, 0, 0.8], shadow: [0, 0, 0.15], lightDir: LIGHT })
    const floor = boxAt(CASE_W, CASE_FLOOR, CASE_D, 0, 0, -CASE_D / 2)
    const walls: THREE.BufferGeometry[] = []
    const outerH = TH * 1.05
    const innerH = TH * 0.62
    // outer frame
    walls.push(boxAt(CASE_W, outerH, WALL, 0, CASE_FLOOR, -WALL / 2))
    walls.push(boxAt(CASE_W, outerH, WALL, 0, CASE_FLOOR, -CASE_D + WALL / 2))
    walls.push(boxAt(WALL, outerH, CASE_D, -CASE_W / 2 + WALL / 2, CASE_FLOOR, -CASE_D / 2))
    walls.push(boxAt(WALL, outerH, CASE_D, CASE_W / 2 - WALL / 2, CASE_FLOOR, -CASE_D / 2))
    // dividers
    for (let r = 1; r < CASE_ROWS.length; r++) {
      const z = -r * (COMP_D + WALL) - WALL / 2
      walls.push(boxAt(CASE_W - 2 * WALL, innerH, WALL, 0, CASE_FLOOR, z))
    }
    for (let c = 1; c < CASE_COLS; c++) {
      const x = -CASE_W / 2 + c * (COMP_W + WALL) + WALL / 2
      walls.push(boxAt(WALL, innerH, CASE_D - 2 * WALL, x, CASE_FLOOR, -CASE_D / 2))
    }
    // a drawer pull on the front
    walls.push(boxAt(2.2, 0.16, 0.16, 0, CASE_FLOOR + outerH * 0.35, 0.08))
    const wallGeo = mergeGeometries(walls)!
    const floorMesh = new THREE.Mesh(floor, floorMat)
    const wallMesh = new THREE.Mesh(wallGeo, wood)
    this.group.add(floorMesh, wallMesh, outline(wallGeo), outline(floor))
    // the drawer's own shadow on the bench
    this.group.add(this.softShadow(CASE_W + 1.4, CASE_D + 1.4, 0, -CASE_D / 2 + 0.25, 0.32))
  }

  private softShadow(w: number, d: number, x: number, z: number, strength: number) {
    const g = new THREE.PlaneGeometry(w, d)
    g.rotateX(-Math.PI / 2)
    const m = new THREE.ShaderMaterial({
      vertexShader: PLAIN_VERT,
      fragmentShader: /* glsl */ `
        uniform float uS, uEdgeX, uEdgeZ;
        varying vec2 vUv;
        void main() {
          vec2 q = abs(vUv - 0.5) * 2.0;
          float a = (1.0 - smoothstep(1.0 - uEdgeX, 1.0, q.x)) * (1.0 - smoothstep(1.0 - uEdgeZ, 1.0, q.y));
          if (a <= 0.003) discard;
          gl_FragColor = vec4(0.0, 0.0, uS * a, 1.0);
        }
      `,
      ...MAX_BLEND,
      uniforms: { uS: { value: strength }, uEdgeX: { value: 1.2 / w }, uEdgeZ: { value: 1.2 / d } },
    })
    const mesh = new THREE.Mesh(g, m)
    mesh.position.set(x + 0.25, 0.004, z)
    mesh.renderOrder = 1
    return mesh
  }

  private buildChase() {
    const iron = inkMaterial({ ink: [0, 0, 0.5], shadow: [0, 0, 0.4], lightDir: LIGHT })
    const light = inkMaterial({ ink: [0.07, 0, 0.13], shadow: [0.04, 0, 0.42], lightDir: LIGHT })
    const ix = this.chaseInHalf
    const iz = 0.5 + FURN_D
    const bars = mergeGeometries([
      boxAt(2 * (ix + CHASE_BAR), CHASE_H, CHASE_BAR, 0, 0, Z_CHASE - iz - CHASE_BAR / 2),
      boxAt(2 * (ix + CHASE_BAR), CHASE_H, CHASE_BAR, 0, 0, Z_CHASE + iz + CHASE_BAR / 2),
      boxAt(CHASE_BAR, CHASE_H, 2 * iz, -ix - CHASE_BAR / 2, 0, Z_CHASE),
      boxAt(CHASE_BAR, CHASE_H, 2 * iz, ix + CHASE_BAR / 2, 0, Z_CHASE),
    ])!
    this.group.add(new THREE.Mesh(bars, iron), outline(bars))
    // long furniture above and below the line
    const furn = mergeGeometries([
      boxAt(2 * ix - 0.04, CHASE_H * 0.94, FURN_D - 0.03, 0, 0, Z_CHASE - 0.5 - FURN_D / 2),
      boxAt(2 * ix - 0.04, CHASE_H * 0.94, FURN_D - 0.03, 0, 0, Z_CHASE + 0.5 + FURN_D / 2),
    ])!
    this.group.add(new THREE.Mesh(furn, light), outline(furn))
    // sliding furniture either end of the line (unit box, scaled per frame)
    const unit = boxAt(1, CHASE_H * 0.94, 0.96, 0, 0, 0)
    const mk = () => {
      const g = new THREE.Group()
      g.add(new THREE.Mesh(unit, light), outline(unit))
      g.position.z = Z_CHASE
      this.group.add(g)
      return g
    }
    this.furnL = mk()
    this.furnR = mk()
    // quoins: the wedges that lock it all up
    const quoin = inkMaterial({ ink: [0, 0, 0.72], shadow: [0, 0, 0.25], lightDir: LIGHT })
    const qg = mergeGeometries([
      boxAt(0.9, CHASE_H * 0.8, 0.22, ix - 0.9, 0, Z_CHASE + iz + CHASE_BAR + 0.14),
      boxAt(0.9, CHASE_H * 0.8, 0.22, -ix + 0.9, 0, Z_CHASE + iz + CHASE_BAR + 0.14),
    ])!
    this.group.add(new THREE.Mesh(qg, quoin), outline(qg))
    this.group.add(this.softShadow(2 * (ix + CHASE_BAR) + 0.9, 2 * (iz + CHASE_BAR) + 0.9, 0, Z_CHASE + 0.1, 0.34))
  }

  private buildSlabs() {
    const steel = inkMaterial({ ink: [0, 0, 0.14], shadow: [0, 0, 0.35], lightDir: LIGHT })
    const handleMat = inkMaterial({ ink: [0.4, 0, 0.18], shadow: [0.1, 0, 0.5], lightDir: LIGHT })
    const metal = inkMaterial({ ink: [0, 0, 0.78], shadow: [0, 0, 0.2], lightDir: LIGHT })
    for (const side of [1, -1]) {
      const ink = side > 0 ? INK_GREEN : INK_PINK
      const x = side * this.bounds.slabX
      const slab = boxAt(SLAB_W, SLAB_H, SLAB_D, x, 0, Z_CHASE)
      this.group.add(new THREE.Mesh(slab, steel), outline(slab))
      const film = new THREE.PlaneGeometry(SLAB_W * 0.8, SLAB_D * 0.74)
      film.rotateX(-Math.PI / 2)
      const filmMesh = new THREE.Mesh(
        film,
        new THREE.ShaderMaterial({
          vertexShader: PLAIN_VERT,
          fragmentShader: SLAB_INK_FRAG,
          toneMapped: false,
          uniforms: { uInk: { value: new THREE.Vector3(...ink) } },
        }),
      )
      filmMesh.position.set(x, SLAB_H + 0.004, Z_CHASE)
      this.group.add(filmMesh)
      this.group.add(this.softShadow(SLAB_W + 0.6, SLAB_D + 0.6, x, Z_CHASE + 0.05, 0.3))

      // the brayer: an inked rubber roller, a wire fork and a wooden handle
      const root = new THREE.Group()
      const rollGeo = new THREE.CylinderGeometry(RR, RR, BRAYER_L, 40, 1)
      rollGeo.rotateX(Math.PI / 2)
      const rollMat = new THREE.ShaderMaterial({
        vertexShader: PLAIN_VERT,
        fragmentShader: ROLLER_FRAG,
        toneMapped: false,
        uniforms: { uInk: { value: new THREE.Vector3(...ink) }, uLight: { value: LIGHT.clone() } },
      })
      const roller = new THREE.Mesh(rollGeo, [rollMat, metal, metal])
      root.add(roller)
      const hx = side
      const fork = mergeGeometries([
        boxAt(0.06, 0.06, BRAYER_L + 0.2, 0, -0.03, 0),
        this.strut(0, 0, BRAYER_L / 2 + 0.07, hx * 0.62, 0.52, 0.2),
        this.strut(0, 0, -BRAYER_L / 2 - 0.07, hx * 0.62, 0.52, -0.2),
        boxAt(0.07, 0.07, 0.46, hx * 0.62, 0.49, 0),
      ])!
      root.add(new THREE.Mesh(fork, metal))
      const handle = new THREE.CylinderGeometry(0.1, 0.12, 1.25, 16)
      handle.rotateZ(-hx * (Math.PI / 2 - 0.62))
      handle.translate(hx * (0.62 + 0.52), 0.52 + 0.36, 0)
      const hMesh = new THREE.Mesh(handle, handleMat)
      root.add(hMesh, outline(handle, [0, 0, 0.9], 40))
      root.position.set(x, SLAB_H + RR, Z_CHASE)
      this.group.add(root)
      this.brayers.push({ root, roller, rest: root.position.clone(), side })
    }
  }

  /** a thin box from a to b */
  private strut(ax: number, ay: number, az: number, bx: number, by: number, bz: number) {
    const a = new THREE.Vector3(ax, ay, az)
    const b = new THREE.Vector3(bx, by, bz)
    const len = a.distanceTo(b)
    const g = new THREE.BoxGeometry(0.06, len, 0.06)
    const dir = b.clone().sub(a).normalize()
    g.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir))
    g.translate((ax + bx) / 2, (ay + by) / 2, (az + bz) / 2)
    return g
  }

  private buildSheet() {
    this.sheetW = 2 * this.chaseInHalf + 0.5
    this.sheetD = 1 + 2 * FURN_D + 0.5
    const geo = new THREE.PlaneGeometry(this.sheetW, this.sheetD, 64, 4)
    geo.rotateX(-Math.PI / 2)
    // PlaneGeometry's v runs +y → after the rotation, v = 1 is the far (−z) edge
    const { cols, rows } = this.printRows
    const canvas = document.createElement('canvas')
    const rowW = this.mobile ? 512 : 1024
    const ppu = rowW / this.sheetW
    const rowH = Math.round(this.sheetD * ppu)
    canvas.width = rowW * cols
    canvas.height = rowH * rows
    const ctx = canvas.getContext('2d')!
    ctx.fillStyle = '#000'
    ctx.fillRect(0, 0, canvas.width, canvas.height)
    const cell = this.atlas.canvas.width / this.atlas.cols
    this.lines.forEach((line, k) => {
      const ox = (k % cols) * rowW
      const oy = Math.floor(k / cols) * rowH
      ctx.save()
      ctx.beginPath()
      ctx.rect(ox, oy, rowW, rowH)
      ctx.clip()
      // the type, printed: red channel = the job's ink
      ctx.globalCompositeOperation = 'lighter'
      for (const s of line.sorts) {
        const sx = s.g.u * this.atlas.canvas.width
        const sy = (1 - s.g.v - this.atlas.cv) * this.atlas.canvas.height
        const size = CELL_WORLD * ppu
        const cx = ox + (s.x + this.sheetW / 2) * ppu
        const cy = oy + rowH / 2
        ctx.drawImage(this.atlas.canvas, sx, sy, cell, cell, cx - size / 2, cy - size / 2, size, size)
      }
      ctx.globalCompositeOperation = 'source-over'
      // keep only red for the ink, then a black slug in blue
      ctx.globalCompositeOperation = 'multiply'
      ctx.fillStyle = 'rgb(255,0,0)'
      ctx.fillRect(ox, oy, rowW, rowH)
      ctx.globalCompositeOperation = 'lighter'
      // the final proof prints bold, like its type: a key keyline and drop in blue
      if (k === JOBS - 1) ctx.drawImage(this.keylineRow(line, rowW, rowH, ppu, cell), ox, oy)
      ctx.fillStyle = 'rgb(0,0,255)'
      ctx.font = `500 ${Math.round(rowH * 0.075)}px 'DM Mono', ui-monospace, monospace`
      ctx.textBaseline = 'top'
      if (k < JOBS - 1) {
        const slug = `PROOF ${String(k + 1).padStart(2, '0')}/${String(JOBS - 1).padStart(2, '0')} · HARK PRESS`
        ctx.fillText(slug, ox + rowH * 0.12, oy + rowH * 0.06)
      } else {
        // the final proof reads through the stock, so its slug sits centred over HARK
        ctx.textAlign = 'center'
        ctx.fillText('FINAL PROOF · HARK PRESS', ox + rowW / 2, oy + rowH * 0.17)
        ctx.textAlign = 'left'
      }
      ctx.restore()
    })
    const tex = new THREE.CanvasTexture(canvas)
    tex.colorSpace = THREE.NoColorSpace
    tex.anisotropy = 8
    this.sheetMat = new THREE.ShaderMaterial({
      vertexShader: SHEET_VERT,
      fragmentShader: SHEET_FRAG,
      side: THREE.DoubleSide,
      toneMapped: false,
      uniforms: {
        uPrint: { value: tex },
        uRow: { value: new THREE.Vector4(0, 0, 1 / cols, 1 / rows) },
        uInk: { value: new THREE.Vector3(0, 1, 0) },
        uLight: { value: LIGHT.clone() },
        uGhost: { value: 0 },
        uCurl: { value: -99 },
        uR: { value: 0.42 },
        uBend: { value: 0 },
        uW: { value: this.sheetW },
      },
    })
    this.sheet = new THREE.Mesh(geo, this.sheetMat)
    this.sheet.frustumCulled = false
    this.sheet.visible = false
    this.sheet.renderOrder = 3
    this.group.add(this.sheet)
    // its shadow on the forme while it floats down
    this.sheetShadow = this.softShadow(this.sheetW, this.sheetD, 0, Z_CHASE, 0.4)
    this.sheetShadow.position.y = TH + 0.006
    this.sheetShadow.renderOrder = 2
    this.group.add(this.sheetShadow)
  }

  /**
   * The key rim round a printed line, in blue on black: the letters stamped
   * round a ring and along the drop, minus the letters themselves. It matches
   * the BOLD path of SORT_FRAG, so the proof looks like the type that made it.
   */
  private keylineRow(line: SetLine, rowW: number, rowH: number, ppu: number, cell: number) {
    const c = document.createElement('canvas')
    c.width = rowW
    c.height = rowH
    const t = c.getContext('2d')!
    t.fillStyle = '#000'
    t.fillRect(0, 0, rowW, rowH)
    const A = this.atlas
    const size = CELL_WORLD * ppu
    const stamp = (dx: number, dy: number) => {
      for (const s of line.sorts) {
        const sx = s.g.u * A.canvas.width
        const sy = (1 - s.g.v - A.cv) * A.canvas.height
        const cx = (s.x + this.sheetW / 2) * ppu + dx
        t.drawImage(A.canvas, sx, sy, cell, cell, cx - size / 2, rowH / 2 + dy - size / 2, size, size)
      }
    }
    t.globalCompositeOperation = 'lighten'
    const r = 0.05 * ppu
    for (let i = 0; i < 12; i++) stamp(Math.cos((i * Math.PI) / 6) * r, Math.sin((i * Math.PI) / 6) * r)
    // the drop falls away from the light (+x, away from the viewer = up the sheet)
    const dl = Math.hypot(LIGHT.x, LIGHT.z)
    for (let i = 1; i <= 4; i++) {
      const d = 0.11 * ppu * (i / 4)
      stamp((-LIGHT.x / dl) * d, (-LIGHT.z / dl) * d)
    }
    // take the letters back out (white − white = black), keep only blue
    t.globalCompositeOperation = 'difference'
    stamp(0, 0)
    t.globalCompositeOperation = 'multiply'
    t.fillStyle = 'rgb(0,0,255)'
    t.fillRect(0, 0, rowW, rowH)
    return c
  }

  /** crop marks, registration targets, a line gauge and a colour bar printed on the bench */
  private buildTable() {
    const X0 = -12.5
    const X1 = 12.5
    const Z0 = -16.5
    const Z1 = 8.5
    const W = X1 - X0
    const D = Z1 - Z0
    const px = this.mobile ? 1024 : 2048
    const ppu = px / W
    const canvas = document.createElement('canvas')
    canvas.width = px
    canvas.height = Math.round(D * ppu)
    const ctx = canvas.getContext('2d')!
    ctx.fillStyle = '#000'
    ctx.fillRect(0, 0, canvas.width, canvas.height)
    const X = (x: number) => (x - X0) * ppu
    const Z = (z: number) => (z - Z0) * ppu
    const K = 'rgb(0,0,255)'
    ctx.strokeStyle = K
    ctx.fillStyle = K
    ctx.lineWidth = Math.max(1.5, 0.035 * ppu)
    const line = (x0: number, z0: number, x1: number, z1: number) => {
      ctx.beginPath()
      ctx.moveTo(X(x0), Z(z0))
      ctx.lineTo(X(x1), Z(z1))
      ctx.stroke()
    }
    // crop marks round the job
    const rx = this.bounds.slabX + SLAB_W / 2 + 0.6
    const r0 = -CASE_D - 0.9
    const r1 = Z_CHASE + 2.6
    for (const [cx, sx] of [
      [-rx, -1],
      [rx, 1],
    ] as const) {
      for (const [cz, sz] of [
        [r0, -1],
        [r1, 1],
      ] as const) {
        line(cx + sx * 0.25, cz, cx + sx * 1.2, cz)
        line(cx, cz + sz * 0.25, cx, cz + sz * 1.2)
      }
    }
    // registration targets
    const reg = (x: number, z: number, r: number) => {
      ctx.beginPath()
      ctx.arc(X(x), Z(z), r * ppu, 0, Math.PI * 2)
      ctx.stroke()
      line(x - r * 1.6, z, x + r * 1.6, z)
      line(x, z - r * 1.6, x, z + r * 1.6)
    }
    reg(-rx - 0.7, Z_CHASE, 0.3)
    reg(rx + 0.7, Z_CHASE, 0.3)
    reg(0, r0 - 0.7, 0.3)
    reg(0, r1 + 0.75, 0.3)
    // a line gauge along the front of the chase (picas, numbered)
    const gz = Z_CHASE + this.bounds.chaseHalfZ + 0.75
    const g0 = -this.chaseInHalf
    const g1 = this.chaseInHalf
    ctx.lineWidth = Math.max(1.2, 0.028 * ppu)
    ctx.strokeRect(X(g0), Z(gz), (g1 - g0) * ppu, 0.62 * ppu)
    const step = 1 / 6
    for (let i = 0, x = g0; x <= g1 + 1e-6; i++, x += step) {
      const len = i % 6 === 0 ? 0.3 : i % 3 === 0 ? 0.2 : 0.11
      line(x, gz, x, gz + len)
    }
    ctx.font = `500 ${Math.round(0.19 * ppu)}px 'DM Mono', ui-monospace, monospace`
    ctx.textAlign = 'center'
    ctx.textBaseline = 'alphabetic'
    for (let i = 0, x = g0; x <= g1 + 1e-6; i++, x += 1) if (i > 0) ctx.fillText(String(i * 6), X(x), Z(gz + 0.54))
    ctx.textAlign = 'left'
    ctx.fillText('PICAS', X(g0 + 0.08), Z(gz + 0.54))
    // slug + colour bar
    const sz = r1 + 0.55
    ctx.font = `500 ${Math.round(0.24 * ppu)}px 'DM Mono', ui-monospace, monospace`
    ctx.fillText('HARK PRESS · TYPE CASE · WOOD TYPE, 36-LINE GOTHIC · JOB 2026 · SHEET 03/07', X(-rx), Z(sz + 0.12))
    const tints = [1, 0.7, 0.4, 0.15]
    const sw = 0.42
    let bx = rx - 12 * sw - 0.2
    for (const ch of ['rgb(V,0,0)', 'rgb(0,V,0)', 'rgb(0,0,V)']) {
      for (const t of tints) {
        ctx.fillStyle = ch.replace('V', String(Math.round(t * 255)))
        ctx.fillRect(X(bx), Z(sz - 0.2), sw * ppu - 2, sw * ppu)
        bx += sw
      }
    }
    const { material } = inkCanvasMaterial(canvas, 1)
    const geo = new THREE.PlaneGeometry(W, D)
    geo.rotateX(-Math.PI / 2)
    const mesh = new THREE.Mesh(geo, material)
    mesh.position.set((X0 + X1) / 2, 0.002, (Z0 + Z1) / 2)
    mesh.renderOrder = 0
    this.group.add(mesh)
  }

  /* ---------- per frame ---------- */

  private hopPose(a: Pose, b: Pose, t: number, w: number, out: THREE.Matrix4, flip: number) {
    const tf = clamp(t)
    const e = ease.inOutCubic(tf)
    const dx = b.x - a.x
    const dz = b.z - a.z
    const dist = Math.hypot(dx, dz)
    const H = 1.1 + 0.16 * dist
    const x = lerp(a.x, b.x, e)
    const z = lerp(a.z, b.z, e)
    const y = lerp(a.y, b.y, e) + H * 4 * tf * (1 - tf)
    // squash & stretch: crouch at take-off, stretch in the air, squash on landing and settle
    let sq = 0
    if (tf < 0.12) sq = 0.2 * Math.sin((Math.PI * tf) / 0.12)
    else if (t < 1) sq = -0.12 * Math.sin((Math.PI * (tf - 0.12)) / 0.88)
    if (t >= 1) {
      const u = clamp((t - 1) / 0.35)
      sq = 0.3 * (1 - u) * (1 - u) * Math.cos(u * Math.PI * 3)
    }
    const sy = 1 - sq
    const sxz = 1 + sq * 0.45
    // one somersault on the way
    const ang = flip * Math.PI * 2 * ease.inOutCubic(segment(tf, 0.08, 0.9))
    if (dist > 1e-4) _ax.set(dz / dist, 0, -dx / dist)
    else _ax.set(1, 0, 0)
    _q.setFromAxisAngle(_ax, ang)
    _q2.setFromAxisAngle(_up, lerp(a.yaw, b.yaw, e))
    _q.multiply(_q2)
    const hh = (TH * sy) / 2
    // rotate about the sort's centre, keep the base on the surface when upright
    _m.makeTranslation(0, -hh, 0)
    _m2.makeScale(w * sxz, TH * sy, sxz)
    _m.multiply(_m2)
    _m2.makeRotationFromQuaternion(_q)
    _m.premultiply(_m2)
    _m2.makeTranslation(x, y + hh, z)
    _m.premultiply(_m2)
    out.copy(_m)
    return y
  }

  private surfaceY(x: number, z: number) {
    if (Math.abs(x) <= CASE_W / 2 && z <= 0.02 && z >= -CASE_D) return CASE_FLOOR + TH
    if (Math.abs(x) <= this.bounds.chaseHalfX && Math.abs(z - Z_CHASE) <= this.bounds.chaseHalfZ) return CHASE_H
    return 0
  }

  /* ---------- a tap on the case makes a sort hop in its compartment ---------- */

  private pokes: { i: number; t0: number; w: number; slot: Slot }[] = []
  private ray = new THREE.Raycaster()
  private pokePlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -(CASE_FLOOR + TH))
  private hit = new THREE.Vector3()

  poke(ndc: THREE.Vector2, camera: THREE.Camera, time: number) {
    this.ray.setFromCamera(ndc, camera)
    if (!this.ray.ray.intersectPlane(this.pokePlane, this.hit)) return
    const { x, z } = this.hit
    if (Math.abs(x) > CASE_W / 2 - WALL || z > -WALL || z < -CASE_D + WALL) return
    const col = Math.floor((x + CASE_W / 2 - WALL / 2) / (COMP_W + WALL))
    const row = Math.floor((-z - WALL / 2) / (COMP_D + WALL))
    const comp = this.comps[row * CASE_COLS + col]
    if (!comp || col < 0 || col >= CASE_COLS) return
    let best = -1
    let bd = Infinity
    comp.slots.forEach((sl, j) => {
      const d = (sl.x - x) ** 2 + (sl.z - z) ** 2
      if (d < bd && !this.staticHidden[comp.base + j]) {
        bd = d
        best = j
      }
    })
    if (best < 0 || bd > 1) return
    const i = comp.base + best
    this.pokes = this.pokes.filter(pk => pk.i !== i).slice(-7)
    this.pokes.push({ i, t0: time, w: this.atlas.glyphs.get(comp.ch)!.w, slot: comp.slots[best] })
  }

  private updatePokes(time: number, calm: boolean) {
    if (!this.pokes.length) return false
    let dirty = false
    this.pokes = this.pokes.filter(pk => {
      const t = (time - pk.t0) / 0.5
      const done = t >= 1.35 || t < 0 || this.staticHidden[pk.i] === 1
      if (done) {
        if (!this.staticHidden[pk.i]) {
          _m.fromArray(this.staticMats, pk.i * 16)
          this.statics.setMatrixAt(pk.i, _m)
        }
      } else {
        const s = pk.slot
        const pose: Pose = { x: s.x, y: CASE_FLOOR, z: s.z, yaw: s.yaw }
        this.hopPose(pose, pose, t, pk.w, _m, calm ? 0 : 1)
        this.statics.setMatrixAt(pk.i, _m)
      }
      dirty = true
      return !done
    })
    return dirty
  }

  /** Half width of the line the camera should frame (eases from the last line to the new one). */
  frameHalf(jp: JobPhase) {
    const { k, p } = jp
    if (k < 0) return this.introLine.half
    const prev = k === 0 ? this.introLine.half : this.lines[k - 1].half
    return lerp(prev, this.lines[k].half, ease.inOutCubic(segment(p, 0.04, 0.36)))
  }

  /** Pose the whole bench for this moment of the story. */
  update(jp: JobPhase, time: number, calm: boolean) {
    const { k, p } = jp
    this.staticWant.fill(0)
    const st = this.state
    st.rolling = 0
    st.impression = 0

    // brayers rest on their slabs unless it's their job's pass
    const rollJob = k >= 0 ? k : -99
    const rollR = k >= 0 ? segment(p, PH.roll0, PH.roll1) : 0
    const rollInk = k >= 0 ? this.lines[k].ink : 0
    let activeRollX = 0
    let rollDir = 1
    let rolledAll = false
    for (const b of this.brayers) {
      const mine = rollJob >= 0 && (b.side > 0 ? rollInk === 0 : rollInk === 1)
      if (!mine || rollR <= 0 || rollR >= 1) {
        const idle = calm ? 0 : Math.sin(time * 1.3 + b.side) * 0.015
        b.root.position.copy(b.rest)
        b.root.position.x += idle
        b.roller.rotation.z = -b.root.position.x / RR
        b.root.rotation.set(0, 0, 0)
        if (mine && rollR >= 1) rolledAll = true
        continue
      }
      const line = this.lines[rollJob]
      const s = b.side
      const x0 = -s * (line.half + 0.8)
      const x1 = s * (line.half + 0.8)
      const yT = TH + RR
      const yR = b.rest.y
      let x: number
      let y: number
      if (rollR < 0.3) {
        const e = ease.inOutCubic(rollR / 0.3)
        x = lerp(b.rest.x, x0, e)
        y = lerp(yR, yT, e) + 2.0 * Math.sin(Math.PI * e)
      } else if (rollR < 0.8) {
        const e = ease.inOutQuad((rollR - 0.3) / 0.5)
        x = lerp(x0, x1, e)
        y = yT
        st.rolling = Math.sin(Math.PI * e)
      } else {
        const e = ease.inOutCubic((rollR - 0.8) / 0.2)
        x = lerp(x1, b.rest.x, e)
        y = lerp(yT, yR, e) + 0.45 * Math.sin(Math.PI * e)
      }
      b.root.position.set(x, y, Z_CHASE)
      b.roller.rotation.z = -x / RR
      // tilt the handle a touch as it's pushed
      b.root.rotation.z = st.rolling * 0.05 * s
      activeRollX = rollR < 0.3 ? (s > 0 ? -99 : 99) : x
      rollDir = s
      st.roller.set(x, y, Z_CHASE)
    }
    this.sortMat.uniforms.uRoll.value.set(activeRollX, rollDir, 1)

    // lines in the chase: this job's (being set) and the last one (going back)
    let n = 0
    const nMov = this.maxN * 2
    const mm = this.movers.instanceMatrix.array as Float32Array
    const glyph = this.moverGlyph.array as Float32Array
    const inkA = this.moverInkA.array as Float32Array
    const inkB = this.moverInkB.array as Float32Array
    const shStr = this.shadowStrength.array as Float32Array
    const shM = this.shadows.instanceMatrix.array as Float32Array
    let lineHalf = 0
    for (let grp = 0; grp < 2; grp++) {
      const job = groupOf(k) === grp ? k : k - 1
      if (job < -1) continue
      const line = job === -1 ? this.introLine : this.lines[job]
      const setting = job === k
      const nS = line.sorts.length
      if (setting) lineHalf = line.half
      for (let i = 0; i < nS; i++) {
        const s = line.sorts[i]
        const comp = this.comps[s.comp]
        const slot = comp.slots[s.copy]
        const src: Pose = { x: slot.x, y: CASE_FLOOR, z: slot.z, yaw: slot.yaw }
        const dst: Pose = { x: s.x, y: 0, z: Z_CHASE, yaw: s.yaw }
        let t: number
        if (job === -1 && k === -1) t = 9
        else if (setting) t = (p - (PH.set0 + (nS > 1 ? i / (nS - 1) : 0) * PH.setSpan)) / PH.hop
        else t = 1.35 - (p - (PH.dist0 + (nS > 1 ? (nS - 1 - i) / (nS - 1) : 0) * PH.distSpan)) / PH.hop
        // t: 0 = in the case, ≥1.35 = settled in the chase
        if (t <= 0) continue
        this.staticWant[comp.base + s.copy] = 1
        const w = s.g.w
        let y: number
        if (setting) {
          y = this.hopPose(src, dst, Math.min(t, 1.35), w, _m, 1)
        } else {
          // going home: fly back out of the chase (time runs the other way)
          y = this.hopPose(dst, src, 1.35 - t, w, _m, -1)
        }
        _m.toArray(mm, n * 16)
        // ink: the old face (evened to key black in the air, so the set line reads as
        // one colour before the brayer), fresh ink where the brayer has been
        const old = slot.ink
        if (setting && job >= 0) {
          const f = segment(t, 0.15, 0.85)
          inkA.set([lerp(old[0], INK_KEY[0], f), lerp(old[1], INK_KEY[1], f), lerp(old[2], INK_KEY[2], f)], n * 3)
        } else inkA.set(old, n * 3)
        const fresh = inkVec(line.ink)
        let mode = -1
        if (job === -1) mode = 1
        else if (setting) {
          if (rollR >= 1 || rolledAll) mode = 1
          else if (rollR > 0.3) mode = 0
        } else {
          mode = 1
        }
        if (!setting && job >= 0) {
          // going home the ink dries back into the old face (never seen: it's mid-air)
          const dry = segment(1.35 - t, 0.5, 1.2)
          inkB.set([lerp(fresh[0], old[0], dry), lerp(fresh[1], old[1], dry), lerp(fresh[2], old[2], dry), mode], n * 4)
        } else inkB.set([fresh[0], fresh[1], fresh[2], mode], n * 4)
        // the finale's HARK prints bold (keyline + drop, see SORT_FRAG)
        glyph.set([s.g.u, s.g.v, w, setting && job === JOBS - 1 ? 1 : 0], n * 4)
        // contact shadow while airborne
        const cx = _m.elements[12]
        const cz = _m.elements[14]
        const sy = this.surfaceY(cx, cz)
        const h = y - sy
        if (h > 0.03) {
          const sc = 1 + h * 0.3
          _m2.makeScale((w + 0.35) * sc, 1, 1.35 * sc)
          _m2.setPosition(cx, sy + 0.012, cz)
          _m2.toArray(shM, n * 16)
          shStr[n] = 0.5 / (1 + h * 0.8)
        } else {
          _m2.makeScale(0, 0, 0)
          _m2.toArray(shM, n * 16)
          shStr[n] = 0
        }
        n++
      }
    }
    // hide the rest
    for (let i = n; i < nMov; i++) {
      _m.makeScale(0, 0, 0)
      _m.toArray(mm, i * 16)
      _m.toArray(shM, i * 16)
      shStr[i] = 0
    }
    this.movers.count = Math.max(n, 1)
    this.shadows.count = Math.max(n, 1)
    this.movers.instanceMatrix.needsUpdate = true
    this.moverGlyph.needsUpdate = true
    this.moverInkA.needsUpdate = true
    this.moverInkB.needsUpdate = true
    this.shadows.instanceMatrix.needsUpdate = true
    this.shadowStrength.needsUpdate = true

    // case copies that are out of the case disappear from it
    let dirty = false
    for (let i = 0; i < this.staticWant.length; i++) {
      if (this.staticWant[i] !== this.staticHidden[i]) {
        this.staticHidden[i] = this.staticWant[i]
        if (this.staticWant[i]) _m.makeScale(0, 0, 0)
        else _m.fromArray(this.staticMats, i * 16)
        this.statics.setMatrixAt(i, _m)
        dirty = true
      }
    }
    if (this.updatePokes(time, calm)) dirty = true
    if (dirty) this.statics.instanceMatrix.needsUpdate = true

    // furniture: unlocked at the start of a job, slides to the new line, locks up
    const ix = this.chaseInHalf
    let half: number
    if (k < 0) half = this.introLine.half
    else {
      const prev = k === 0 ? this.introLine.half : this.lines[k - 1].half
      const cur = this.lines[k].half
      const open = 0.34
      const u = segment(p, 0, PH.unlock1)
      const slide = ease.inOutCubic(segment(p, PH.unlock1, PH.lock0))
      const lock = segment(p, PH.lock0, PH.lock1)
      const gap = open * ease.outCubic(u) * (1 - ease.outBack(lock))
      half = lerp(prev, cur, slide) + gap
    }
    const fw = Math.max(0.05, ix - half - 0.02)
    this.furnL.scale.set(fw, 1, 1)
    this.furnL.position.x = -ix + fw / 2
    this.furnR.scale.set(fw, 1, 1)
    this.furnR.position.x = ix - fw / 2

    // the sheet
    this.updateSheet(k, p, calm)

    st.lineHalf = lineHalf || (k < 0 ? this.introLine.half : 0)
    st.lineStart.set(-(st.lineHalf || 2), TH, Z_CHASE - 0.5)
  }

  private updateSheet(k: number, p: number, calm: boolean) {
    const sh = this.sheet
    const u = this.sheetMat.uniforms
    const shadow = this.sheetShadow
    const su = (shadow.material as THREE.ShaderMaterial).uniforms
    shadow.visible = false
    if (k < 0 || p < PH.drop0 || p >= PH.fly1) {
      sh.visible = false
      return
    }
    sh.visible = true
    const line = this.lines[k]
    const { cols, rows } = this.printRows
    u.uRow.value.set((k % cols) / cols, 1 - (Math.floor(k / cols) + 1) / rows, 1 / cols, 1 / rows)
    u.uInk.value.set(...inkVec(line.ink))
    const yRest = TH + 0.012
    sh.rotation.set(0, 0, 0)
    sh.position.set(0, yRest, Z_CHASE)
    u.uBend.value = 0
    u.uCurl.value = -this.sheetW / 2 - 1
    u.uGhost.value = 0
    // a proof shows through the stock faintly; the final one is pulled with a heavy
    // impression and a full drum, so HARK bites through bold and dense
    const ghost = k === JOBS - 1 ? 0.95 : 0.1
    if (p < PH.drop1) {
      // flutters down from above
      const e = segment(p, PH.drop0, PH.drop1)
      const f = 1 - ease.inQuad(e)
      sh.position.y = yRest + 5.5 * f * f
      sh.position.x = -1.2 * f
      sh.position.z = Z_CHASE - 1.2 * f
      const wob = calm ? 0 : 1
      sh.rotation.z = 0.28 * f * Math.sin(e * 9.0) * wob
      sh.rotation.x = 0.16 * f * Math.cos(e * 7.0) * wob
      u.uBend.value = 0.45 * f
      shadow.visible = true
      shadow.position.x = sh.position.x * 0.5 + 0.25
      shadow.position.z = Z_CHASE + 0.15
      const sc = 1 + f * 0.35
      shadow.scale.set(sc, 1, sc)
      su.uS.value = 0.45 * (1 - f * 0.75)
    } else if (p < PH.press1) {
      const e = segment(p, PH.drop1, PH.press1)
      this.state.impression = Math.sin(Math.PI * Math.min(1, e * 1.6))
      u.uGhost.value = ghost * e
      sh.position.y = yRest - 0.004 * this.state.impression
    } else {
      u.uGhost.value = ghost
      // peel from the left edge over to the right, then hand the proof up
      const e = segment(p, PH.press1, PH.peel1)
      const R = u.uR.value as number
      const c0 = -this.sheetW / 2
      const c1 = this.sheetW / 2 + Math.PI * R
      u.uCurl.value = lerp(c0, c1, ease.inOutCubic(e))
      const f = segment(p, PH.peel1 - 0.02, PH.fly1)
      if (f > 0) {
        const g = ease.inCubic(f)
        sh.position.y = yRest + g * 7
        sh.position.z = Z_CHASE + g * 3.5
        sh.position.x = -g * 6
        sh.rotation.z = -g * 0.5
        sh.rotation.x = g * 0.8
      }
    }
  }
}
