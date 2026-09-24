import * as THREE from 'three'
import { clamp } from '../../core/math'
import { inkCanvasMaterial, inkMaterial, type Ink } from '../../print/ink'
import { fitMapper, type Mapper, type Rect } from './art'
import { markFrame, simpleShapes } from './markArt'
import { ADD_BLEND } from './sheet'
import { INK_OF, LIGHT } from './shared'

/*
 * A printing block: a wooden block sized to the art it prints, with that
 * art on its face (type inked on the face; the mark as extruded relief),
 * a turned handle with an inked knob, and a paper index label on top that
 * proofs what it prints (so the waiting row reads as the headline). Drawn like a riso
 * illustration: flat wood tint, halftone shade, and a heavy keyline
 * silhouette (inverted hull).
 *
 * Origin = the centre of the relief's printing face, so y = 0 is contact.
 */

const HULL_FRAG = /* glsl */ `void main() { gl_FragColor = vec4(0.0, 0.0, 1.0, 0.0); }`

/** Keyline silhouette: a pre-grown copy of the shape, back faces only, solid black. */
let _outline: THREE.ShaderMaterial | null = null
function outlineMat() {
  if (!_outline) {
    _outline = new THREE.ShaderMaterial({
      vertexShader: `void main(){ gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
      fragmentShader: HULL_FRAG,
      side: THREE.BackSide,
      toneMapped: false,
    })
  }
  return _outline
}

/** Turned handle profile (radius, y) — a neck swelling into a knob. */
const NECK: [number, number][] = [
  [0.0, 0.0],
  [0.3, 0.0],
  [0.3, 0.045],
  [0.17, 0.1],
  [0.12, 0.22],
  [0.11, 0.5],
  [0.14, 0.58],
]
const KNOB: [number, number][] = [
  [0.0, 0.54],
  [0.14, 0.54],
  [0.24, 0.62],
  [0.29, 0.76],
  [0.27, 0.9],
  [0.18, 0.99],
  [0.0, 1.02],
]
function lathe(profile: [number, number][], scale: number, grow = 0) {
  const last = profile.length - 1
  const pts = profile.map(
    ([r, y], i) => new THREE.Vector2(r === 0 ? 0 : r * scale + grow, y * scale + (i === 0 ? -grow : i === last ? grow : 0)),
  )
  const g = new THREE.LatheGeometry(pts, 28)
  g.computeVertexNormals()
  return g
}

const _relief = new Map<string, THREE.BufferGeometry>()
/** Relief geometry, built once from light contours and shared between blocks. */
function reliefGeo(which: 'loops' | 'diamond', mobile: boolean) {
  const hit = _relief.get(which)
  if (hit) return hit
  const max = mobile ? 90 : 150
  const shapes = simpleShapes(which, max)
  const g = new THREE.ExtrudeGeometry(shapes, { depth: 1, bevelEnabled: false, curveSegments: 1, steps: 1 })
  g.computeVertexNormals()
  _relief.set(which, g)
  return g
}

export interface BlockShared {
  woodMat: THREE.ShaderMaterial
  shadowMat: THREE.ShaderMaterial
  shadowGeo: THREE.PlaneGeometry
}

export function blockShared(): BlockShared {
  return {
    // bare wood: a whisper of pink tint, shade builds pink-brown + black
    woodMat: inkMaterial({ ink: [0.02, 0.0, 0.05], shadow: [0.06, 0.03, 0.6], lightDir: LIGHT }),
    shadowMat: blockShadowMaterial(),
    shadowGeo: new THREE.PlaneGeometry(1, 1),
  }
}

/**
 * What a block prints: its art's rect on the (landscape) sheet, and a
 * painter that draws that art in one ink through a sheet→canvas mapper.
 * The pink block also carries the mark's extruded relief.
 */
export interface PlateSpec {
  plate: number
  rect: Rect
  paint(ctx: CanvasRenderingContext2D, ink: string, m: Mapper): void
  /** mark height (sheet units) when the relief is the extruded mark */
  markH?: number
}

/** ink densities as canvas colours (R pink, G green, B black) */
const CANVAS_INK = ['rgb(0,0,255)', 'rgb(0,255,0)', 'rgb(255,0,0)']
const CODE = ['K · Key', 'G · Green', 'P · Pink']
/** the face is never shallower than this, so the label keeps room for its art */
const MIN_DEPTH = 1.25
/** a strip along the back of each block carries the handle and the drum code */
export const STRIP = 0.62

export class Block {
  /** world placement (contact origin) */
  root = new THREE.Group()
  /** squash/tilt pivot */
  body = new THREE.Group()
  shadow: THREE.Mesh
  /** wood footprint (x across, y front-to-back) */
  readonly footprint: THREE.Vector2
  /** depth of the face part (front of the block, ahead of the handle strip) */
  readonly faceDepth: number
  plate: number
  private label: { material: THREE.ShaderMaterial; texture: THREE.CanvasTexture; canvas: HTMLCanvasElement }
  private face: { material: THREE.ShaderMaterial; texture: THREE.CanvasTexture; canvas: HTMLCanvasElement } | null = null
  private spec: PlateSpec
  private labelSize: THREE.Vector2

  constructor(spec: PlateSpec, shared: BlockShared, mobile: boolean) {
    this.spec = spec
    const plate = (this.plate = spec.plate)
    const ink: Ink = INK_OF[plate]
    const cw = spec.rect.x1 - spec.rect.x0
    const cd = spec.rect.y1 - spec.rect.y0
    const fw = cw
    const fdc = (this.faceDepth = Math.max(cd, MIN_DEPTH))
    const fd = fdc + STRIP
    /** the wood's centre sits back from the face centre by half the strip (local -z = up the print) */
    const back = -STRIP / 2
    const relief = spec.markH ? 0.09 : 0.03
    const bt = 0.42
    this.footprint = new THREE.Vector2(fw, fd)
    const scale = clamp(Math.sqrt(fw * fdc) / 2.8, 0.78, 1)
    this.root.add(this.body)

    // --- the printing face ---
    if (spec.markH) {
      // the mark in relief, mirror-image on the face
      const f = markFrame()
      const markH = spec.markH
      const reliefMat = inkMaterial({ ink: [ink[0] * 0.96, ink[1] * 0.96, ink[2] * 0.92], shadow: [0.0, 0.0, 0.35], lightDir: LIGHT })
      for (const rg of [reliefGeo('loops', mobile), reliefGeo('diamond', mobile)]) {
        const reliefMesh = new THREE.Mesh(rg, reliefMat)
        // mark units → world; local y → print up (-z); face (extrude +z) points down; mirrored in z
        reliefMesh.rotation.x = -Math.PI / 2
        reliefMesh.scale.set(markH, markH, -relief)
        reliefMesh.position.set(-f.cx * markH, relief, f.cy * markH)
        this.body.add(reliefMesh)
      }
    } else {
      // type: the inked face, printed right-reading from above (so it reads
      // mirrored from below, like a real block) just under the wood
      const n = mobile ? 512 : 768
      const W = cw >= cd ? n : Math.round((n * cw) / cd)
      const H = cw >= cd ? Math.round((n * cd) / cw) : n
      const canvas = document.createElement('canvas')
      canvas.width = W
      canvas.height = H
      const mat = inkCanvasMaterial(canvas, 0)
      mat.texture.colorSpace = THREE.NoColorSpace
      this.face = { ...mat, canvas }
      const faceMesh = new THREE.Mesh(new THREE.PlaneGeometry(cw, cd), mat.material)
      faceMesh.rotation.x = -Math.PI / 2
      faceMesh.position.y = relief * 0.5
      this.body.add(faceMesh)
    }

    // --- the block ---
    const blockGeo = new THREE.BoxGeometry(fw, bt, fd)
    const block = new THREE.Mesh(blockGeo, shared.woodMat)
    block.position.set(0, relief + bt / 2, back)
    this.body.add(block)
    const t = 0.03
    const blockHull = new THREE.Mesh(new THREE.BoxGeometry(fw + t * 2, bt + t * 2, fd + t * 2), outlineMat())
    blockHull.position.copy(block.position)
    this.body.add(blockHull)

    // --- index label on top: a proof of what this block prints ---
    this.labelSize = new THREE.Vector2(fw - 0.36, fd - 0.36)
    const ln = mobile ? 512 : 768
    const lw = this.labelSize.x >= this.labelSize.y ? ln : Math.round((ln * this.labelSize.x) / this.labelSize.y)
    const lh = this.labelSize.x >= this.labelSize.y ? Math.round((ln * this.labelSize.y) / this.labelSize.x) : ln
    const lcanvas = document.createElement('canvas')
    lcanvas.width = lw
    lcanvas.height = lh
    const idx = inkCanvasMaterial(lcanvas, 0)
    idx.texture.colorSpace = THREE.NoColorSpace
    this.label = { ...idx, canvas: lcanvas }
    const label = new THREE.Mesh(new THREE.PlaneGeometry(this.labelSize.x, this.labelSize.y), idx.material)
    label.rotation.x = -Math.PI / 2
    label.position.set(0, relief + bt + 0.004, back)
    this.body.add(label)
    // a ruled frame around the label (printed black line)
    const frame = new THREE.LineSegments(
      new THREE.EdgesGeometry(new THREE.PlaneGeometry(this.labelSize.x + 0.05, this.labelSize.y + 0.05)),
      new THREE.ShaderMaterial({
        vertexShader: `void main(){ gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
        fragmentShader: `void main(){ gl_FragColor = vec4(0.0, 0.0, 0.85, 0.0); }`,
        toneMapped: false,
      }),
    )
    frame.rotation.x = -Math.PI / 2
    frame.position.set(0, relief + bt + 0.006, back)
    this.body.add(frame)
    this.draw()

    // --- handle: wooden neck + inked knob ---
    const top = relief + bt
    const neck = new THREE.Mesh(lathe(NECK, scale), shared.woodMat)
    neck.position.y = top
    const knob = new THREE.Mesh(
      lathe(KNOB, scale),
      inkMaterial({ ink: [ink[0] * 0.9, ink[1] * 0.9, ink[2] * 0.85], shadow: [0, 0, 0.45], lightDir: LIGHT }),
    )
    knob.position.y = top
    const neckHull = new THREE.Mesh(lathe(NECK, scale, t), outlineMat())
    neckHull.position.y = top
    const knobHull = new THREE.Mesh(lathe(KNOB, scale, t), outlineMat())
    knobHull.position.y = top
    // the handle stands in the back strip, so from the front it never hides the art
    const hz = back - fd / 2 + 0.18 + (STRIP - 0.18) / 2
    neck.position.z = knob.position.z = neckHull.position.z = knobHull.position.z = hz
    this.body.add(neck, knob, neckHull, knobHull)

    // --- contact shadow (lies on the sheet/mat, not parented to the block) ---
    this.shadow = new THREE.Mesh(shared.shadowGeo, shared.shadowMat.clone())
    this.shadow.rotation.x = -Math.PI / 2
    this.shadow.renderOrder = 2
  }

  /** (Re)draw the label and face art, e.g. once the display face has loaded. */
  draw() {
    const { spec, label } = this
    const ink = CANVAS_INK[spec.plate]
    // label: the drum code in the back strip (either side of the handle),
    // a rule, and the plate's art below it
    {
      const cv = label.canvas
      const ctx = cv.getContext('2d')!
      ctx.setTransform(1, 0, 0, 1, 0, 0)
      ctx.globalCompositeOperation = 'source-over'
      ctx.fillStyle = '#000'
      ctx.fillRect(0, 0, cv.width, cv.height)
      const k = cv.width / this.labelSize.x // px per unit
      const strip = (STRIP - 0.18) * k
      const inset = 0.12 * k
      spec.paint(ctx, ink, fitMapper(spec.rect, inset, strip + inset * 0.6, cv.width - inset * 2, cv.height - strip - inset * 1.4))
      ctx.globalCompositeOperation = 'lighter'
      ctx.fillStyle = 'rgb(0,0,235)'
      ctx.font = `500 ${Math.round(0.125 * k)}px "DM Mono", ui-monospace, monospace`
      ctx.textBaseline = 'middle'
      const y = strip * 0.48
      ctx.fillText(CODE[spec.plate].toUpperCase(), inset, y)
      const plateNo = `PLATE 0${spec.plate + 1}`
      ctx.fillText(plateNo, cv.width - inset - ctx.measureText(plateNo).width, y)
      ctx.fillRect(inset, strip, cv.width - inset * 2, Math.max(2, 0.014 * k))
      label.texture.needsUpdate = true
    }
    // face: exactly the printed art, on nothing
    if (this.face) {
      const cv = this.face.canvas
      const ctx = cv.getContext('2d')!
      ctx.setTransform(1, 0, 0, 1, 0, 0)
      ctx.clearRect(0, 0, cv.width, cv.height)
      spec.paint(ctx, ink, fitMapper(spec.rect, 0, 0, cv.width, cv.height))
      this.face.texture.needsUpdate = true
    }
  }

  get shadowU() {
    return (this.shadow.material as THREE.ShaderMaterial).uniforms
  }
}

/** Rounded-rect halftone contact shadow (densities ADD onto whatever is below). */
function blockShadowMaterial() {
  return new THREE.ShaderMaterial({
    vertexShader: /* glsl */ `
      varying vec2 vUv;
      void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
    `,
    fragmentShader: /* glsl */ `
      uniform vec2 uHalf;
      uniform float uSoft;
      uniform float uStrength;
      uniform vec2 uPlane;
      varying vec2 vUv;
      void main() {
        vec2 p = (vUv - 0.5) * uPlane;
        vec2 q = abs(p) - uHalf + vec2(uSoft);
        float d = length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - uSoft;
        float a = 1.0 - smoothstep(-uSoft * 0.6, uSoft, d);
        if (a <= 0.002) discard;
        gl_FragColor = vec4(0.0, 0.0, uStrength * a, 0.0);
      }
    `,
    uniforms: {
      uHalf: { value: new THREE.Vector2(1, 1) },
      uSoft: { value: 0.2 },
      uStrength: { value: 0.5 },
      uPlane: { value: new THREE.Vector2(3, 3) },
    },
    ...ADD_BLEND,
  })
}
