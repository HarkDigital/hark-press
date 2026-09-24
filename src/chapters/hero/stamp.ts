import * as THREE from 'three'
import { inkCanvasMaterial, inkMaterial, type Ink } from '../../print/ink'
import { buildIndexCanvas, keylineShapes, markFrame, simpleShapes } from './markArt'
import { ADD_BLEND } from './sheet'
import { INK_OF, LIGHT } from './shared'

/*
 * A printing block: a wooden block with the plate's relief mounted
 * (mirror-image) on its face, a turned handle with an inked knob, and a
 * paper index label on top showing what it prints. Drawn like a riso
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
function reliefGeo(which: 'key' | 'loops' | 'diamond', mobile: boolean) {
  const hit = _relief.get(which)
  if (hit) return hit
  const max = mobile ? 90 : 150
  const shapes = which === 'key' ? keylineShapes(0.034, max) : simpleShapes(which, max)
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

export class Block {
  /** world placement (contact origin) */
  root = new THREE.Group()
  /** squash/tilt pivot */
  body = new THREE.Group()
  shadow: THREE.Mesh
  readonly footprint: THREE.Vector2
  readonly height: number
  plate: number

  constructor(plate: number, markH: number, shared: BlockShared, mobile: boolean) {
    this.plate = plate
    const f = markFrame()
    const ink: Ink = INK_OF[plate]
    const fw = f.bw * markH + 0.36
    const fd = f.bh * markH + 0.36
    const relief = 0.09
    const bt = 0.42
    this.footprint = new THREE.Vector2(fw, fd)
    const scale = Math.min(fw, fd) / 2.7
    this.height = relief + bt + 0.99 * scale * 1.1
    this.root.add(this.body)

    // --- relief: mirror-image plate on the face ---
    const reliefMat = inkMaterial({ ink: [ink[0] * 0.96, ink[1] * 0.96, ink[2] * 0.92], shadow: [0.0, 0.0, 0.35], lightDir: LIGHT })
    const geos = plate === 0 ? [reliefGeo('key', mobile)] : plate === 1 ? [reliefGeo('loops', mobile)] : [reliefGeo('loops', mobile), reliefGeo('diamond', mobile)]
    for (const rg of geos) {
      const reliefMesh = new THREE.Mesh(rg, reliefMat)
      // mark units → world; local y → print up (-z); face (extrude +z) points down; mirrored in z
      reliefMesh.rotation.x = -Math.PI / 2
      reliefMesh.scale.set(markH, markH, -relief)
      reliefMesh.position.set(-f.cx * markH, relief, f.cy * markH)
      this.body.add(reliefMesh)
    }

    // --- the block ---
    const blockGeo = new THREE.BoxGeometry(fw, bt, fd)
    const block = new THREE.Mesh(blockGeo, shared.woodMat)
    block.position.y = relief + bt / 2
    this.body.add(block)
    const t = 0.03
    const blockHull = new THREE.Mesh(new THREE.BoxGeometry(fw + t * 2, bt + t * 2, fd + t * 2), outlineMat())
    blockHull.position.copy(block.position)
    this.body.add(blockHull)

    // --- index label on top ---
    const idx = inkCanvasMaterial(buildIndexCanvas(plate, mobile ? 384 : 512), 0)
    idx.texture.colorSpace = THREE.NoColorSpace
    const label = new THREE.Mesh(new THREE.PlaneGeometry(fw * 0.84, fd * 0.84), idx.material)
    label.rotation.x = -Math.PI / 2
    label.position.y = relief + bt + 0.004
    this.body.add(label)
    // a ruled frame around the label (printed black line)
    const frame = new THREE.LineSegments(
      new THREE.EdgesGeometry(new THREE.PlaneGeometry(fw * 0.86, fd * 0.86)),
      new THREE.ShaderMaterial({
        vertexShader: `void main(){ gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
        fragmentShader: `void main(){ gl_FragColor = vec4(0.0, 0.0, 0.85, 0.0); }`,
        toneMapped: false,
      }),
    )
    frame.rotation.x = -Math.PI / 2
    frame.position.y = relief + bt + 0.006
    this.body.add(frame)

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
    this.body.add(neck, knob, neckHull, knobHull)

    // --- contact shadow (lies on the sheet/mat, not parented to the block) ---
    this.shadow = new THREE.Mesh(shared.shadowGeo, shared.shadowMat.clone())
    this.shadow.rotation.x = -Math.PI / 2
    this.shadow.renderOrder = 2
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
