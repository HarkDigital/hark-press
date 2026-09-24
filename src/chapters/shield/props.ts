import * as THREE from 'three'
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js'
import { inkFlatMaterial, inkLineMaterial, inkMaterial, inkShadowMaterial, type Ink } from '../../print/ink'
import { canvasTexture, drawHeadFront, drawHeadTop } from './print'
import { LIGHT } from './strips'

/*
 * Printed props for the Shredder: the shredder head, the rubber stamps, the
 * stamp impressions (decals) and the cutting-mat grid on the table.
 */

/**
 * Overprint: inks on flat layers (mat grid, shadows, stamp impressions) ADD
 * their densities instead of replacing what's below; the top layer decides
 * screened vs contone.
 */
export function overprint<T extends THREE.Material>(m: T, order: number, mesh?: THREE.Object3D): T {
  m.blending = THREE.CustomBlending
  m.blendEquation = THREE.AddEquation
  m.blendSrc = THREE.OneFactor
  m.blendDst = THREE.OneFactor
  m.blendSrcAlpha = THREE.OneFactor
  m.blendDstAlpha = THREE.ZeroFactor
  m.depthWrite = false
  if (mesh) mesh.renderOrder = order
  return m
}

/** screened print plate on a flat face (canvas R/G/B = inks) */
function plateMaterial(tex: THREE.Texture, halftone = 1) {
  return new THREE.ShaderMaterial({
    vertexShader: /* glsl */ `
      varying vec2 vUv;
      void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
    `,
    fragmentShader: /* glsl */ `
      uniform sampler2D uMap; uniform float uHalftone;
      varying vec2 vUv;
      void main() { gl_FragColor = vec4(texture2D(uMap, vUv).rgb, uHalftone); }
    `,
    toneMapped: false,
    uniforms: { uMap: { value: tex }, uHalftone: { value: halftone } },
  })
}

export const HEAD = { w: 4.5, d: 0.9, h: 0.56 }

export class Shredder {
  group = new THREE.Group()
  /** the shaking part (body + plates) */
  body = new THREE.Group()
  lamp: THREE.Mesh
  lampMat: THREE.ShaderMaterial
  lampWorld = new THREE.Vector3()
  private shadow: THREE.Mesh

  constructor(blades: number) {
    const { w, d, h } = HEAD
    const box = new THREE.Mesh(
      new RoundedBoxGeometry(w, h, d, 3, 0.07),
      inkMaterial({ ink: [0, 0, 0.8], shadow: [0, 0, 0.35], lightDir: LIGHT }),
    )
    box.position.y = h / 2
    this.body.add(box)

    const top = drawHeadTop(w - 0.12, d - 0.12)
    const topMesh = new THREE.Mesh(new THREE.PlaneGeometry(w - 0.12, d - 0.12), plateMaterial(canvasTexture(top.canvas)))
    topMesh.rotation.x = -Math.PI / 2
    topMesh.position.y = h + 0.002
    this.body.add(topMesh)

    const front = drawHeadFront(w - 0.14, h - 0.08, blades)
    const frontMesh = new THREE.Mesh(new THREE.PlaneGeometry(w - 0.14, h - 0.08), plateMaterial(canvasTexture(front)))
    frontMesh.position.set(0, h / 2 - 0.01, d / 2 + 0.002)
    this.body.add(frontMesh)

    // status lamp, set in the bezel on the top plate
    this.lampMat = inkFlatMaterial([1, 0, 0], 0)
    this.lamp = new THREE.Mesh(new THREE.CircleGeometry(0.105, 32), this.lampMat)
    this.lamp.rotation.x = -Math.PI / 2
    this.lamp.position.set(-(w - 0.12) / 2 + top.lamp.u * (w - 0.12), h + 0.004, -(d - 0.12) / 2 + top.lamp.v * (d - 0.12))
    this.body.add(this.lamp)

    this.shadow = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), inkShadowMaterial(0.5, 0.35))
    overprint(this.shadow.material as THREE.Material, -2, this.shadow)
    this.shadow.rotation.x = -Math.PI / 2
    this.shadow.scale.set(w * 1.18, d * 2.2, 1)
    this.shadow.position.set(h * 0.55, 0.0012, -h * 0.5)
    this.group.add(this.shadow, this.body)
  }

  setLamp(ink: Ink) {
    ;(this.lampMat.uniforms.uInk.value as THREE.Vector3).set(...ink)
  }

  lampPosition(out: THREE.Vector3) {
    return this.lamp.getWorldPosition(out)
  }
}

/** A rubber stamp: rubber, mount, neck and knob. Rest pose touches the table at y = 0. */
export class StampTool {
  group = new THREE.Group()
  squash = new THREE.Group()
  private shadow: THREE.Mesh
  private shadowMat: THREE.ShaderMaterial
  private footprint: number

  constructor(shape: 'rect' | 'round', sx: number, sz: number, rubber: Ink, knob: Ink) {
    // drawn like a printed illustration: bare-paper wood with ink outlines,
    // shade building dots, solid ink rubber and knob
    const rub = inkMaterial({ ink: rubber, shadow: [0, 0, 0.35], lightDir: LIGHT })
    const wood = inkMaterial({ ink: [0, 0, 0.06], shadow: [0, 0, 0.62], lightDir: LIGHT })
    const knobMat = inkMaterial({ ink: knob, shadow: [0, 0, 0.6], lightDir: LIGHT })
    const line = inkLineMaterial([0, 0, 1])
    let rubberGeo: THREE.BufferGeometry
    let mountGeo: THREE.BufferGeometry
    const mh = 0.26
    if (shape === 'rect') {
      rubberGeo = new THREE.BoxGeometry(sx, 0.07, sz)
      mountGeo = new THREE.BoxGeometry(sx + 0.1, mh, sz + 0.1)
    } else {
      rubberGeo = new THREE.CylinderGeometry(sx / 2, sx / 2, 0.07, 72)
      mountGeo = new THREE.CylinderGeometry(sx / 2 + 0.05, sx / 2 + 0.07, mh, 72)
    }
    const r = new THREE.Mesh(rubberGeo, rub)
    r.position.y = 0.035
    const m = new THREE.Mesh(mountGeo, wood)
    m.position.y = 0.07 + mh / 2
    const mEdges = new THREE.LineSegments(new THREE.EdgesGeometry(mountGeo, 30), line)
    mEdges.position.copy(m.position)
    const neckGeo = new THREE.CylinderGeometry(0.12, 0.17, 0.7, 28)
    const neck = new THREE.Mesh(neckGeo, wood)
    neck.position.y = 0.07 + mh + 0.35
    const nEdges = new THREE.LineSegments(new THREE.EdgesGeometry(neckGeo, 30), line)
    nEdges.position.copy(neck.position)
    const k = new THREE.Mesh(new THREE.SphereGeometry(0.32, 32, 16), knobMat)
    k.scale.set(1, 0.8, 1)
    k.position.y = 0.07 + mh + 0.7 + 0.2
    this.squash.add(r, m, mEdges, neck, nEdges, k)
    this.group.add(this.squash)
    this.footprint = Math.max(sx, sz)

    this.shadowMat = inkShadowMaterial(0.5, 0.6)
    this.shadow = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), this.shadowMat)
    overprint(this.shadowMat, -2, this.shadow)
    this.shadow.rotation.x = -Math.PI / 2
  }

  /** add the tool's shadow to a parent that is NOT moved with the tool */
  get shadowMesh() {
    return this.shadow
  }

  /** place the tool: (x, z) on the table, h = height of the rubber above it, squash 0..1 */
  set(x: number, z: number, h: number, yaw: number, squash: number, tilt: number) {
    const visible = h < 9
    this.group.visible = visible
    this.shadow.visible = visible && h < 7
    if (!visible) return
    this.group.position.set(x, h, z)
    this.group.rotation.set(tilt, yaw, tilt * 0.6)
    this.squash.scale.set(1 + squash * 0.08, 1 - squash * 0.2, 1 + squash * 0.08)
    // the shadow sharpens and darkens as the stamp comes down
    const k = Math.min(1, h / 5)
    this.shadow.position.set(x - (LIGHT.x / LIGHT.y) * h * 0.6, 0.0014, z - (LIGHT.z / LIGHT.y) * h * 0.6)
    const s = this.footprint * (1.15 + k * 1.3)
    this.shadow.scale.set(s, s * 0.75, 1)
    this.shadow.rotation.z = yaw
    this.shadowMat.uniforms.uStrength.value = 0.62 * (1 - k * 0.75)
    this.shadowMat.uniforms.uSoft.value = 0.35 + k * 0.6
  }
}

/** A stamp impression lying on a surface: mask canvas (white) printed in one ink. */
export function decalMaterial(tex: THREE.Texture, ink: Ink, seed: number) {
  return new THREE.ShaderMaterial({
    vertexShader: /* glsl */ `
      varying vec2 vUv;
      void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
    `,
    fragmentShader: /* glsl */ `
      uniform sampler2D uMap; uniform vec3 uInk; uniform float uAmt, uSeed, uHalftone;
      varying vec2 vUv;
      float hash(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * .1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
      float vnoise(vec2 p) {
        vec2 i = floor(p), f = fract(p);
        vec2 u = f * f * (3.0 - 2.0 * f);
        return mix(mix(hash(i), hash(i + vec2(1, 0)), u.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), u.x), u.y);
      }
      void main() {
        float m = texture2D(uMap, vUv).r;
        // uneven rubber: heavier ink on one side, a few pale patches
        float n = vnoise(vUv * vec2(9.0, 5.0) + uSeed) * 0.6 + vnoise(vUv * 31.0 + uSeed * 2.0) * 0.4;
        float d = m * uAmt * (0.97 + 0.16 * n) * (0.95 + 0.1 * (1.0 - vUv.x));
        if (d < 0.02) discard;
        gl_FragColor = vec4(uInk * min(d, 1.0), uHalftone);
      }
    `,
    depthWrite: false,
    toneMapped: false,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -2,
    uniforms: {
      uMap: { value: tex },
      uInk: { value: new THREE.Vector3(...ink) },
      uAmt: { value: 0 },
      uSeed: { value: seed },
      uHalftone: { value: 0 },
    },
  })
}

/** Cutting-mat grid printed faintly in green on the table (fades out radially). */
export function matMaterial() {
  return new THREE.ShaderMaterial({
    vertexShader: /* glsl */ `
      varying vec2 vXZ;
      void main() {
        vec4 w = modelMatrix * vec4(position, 1.0);
        vXZ = w.xz;
        gl_Position = projectionMatrix * viewMatrix * w;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform vec2 uCenter, uRadius;
      uniform float uAmt;
      varying vec2 vXZ;
      void main() {
        vec2 p = vXZ;
        vec2 fw = max(fwidth(p), vec2(1e-5));
        vec2 g1 = abs(fract(p * 4.0 + 0.5) - 0.5) / (fw * 4.0);
        float l1 = 1.0 - min(min(g1.x, g1.y), 1.0);
        vec2 g2 = abs(fract(p + 0.5) - 0.5) / fw;
        float l2 = 1.0 - min(min(g2.x, g2.y) / 1.4, 1.0);
        // fine lines fade out where they'd crowd into moire
        float fine = 1.0 - smoothstep(0.035, 0.07, max(fw.x, fw.y));
        vec2 r2 = (p - uCenter) / uRadius;
        float fade = 1.0 - smoothstep(0.55, 1.0, length(r2));
        float g = max(l1 * 0.13 * fine, l2 * 0.42) * fade * uAmt;
        if (g < 0.01) discard;
        gl_FragColor = vec4(0.0, g, 0.0, 0.0);
      }
    `,
    depthWrite: false,
    toneMapped: false,
    uniforms: {
      uCenter: { value: new THREE.Vector2(0, 1) },
      uRadius: { value: new THREE.Vector2(7, 6) },
      uAmt: { value: 1 },
    },
  })
}
