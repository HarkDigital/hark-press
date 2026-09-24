import * as THREE from 'three'

/*
 * Ink materials for the Press. Every chapter renders INK DENSITIES, not
 * colour (see src/core/post.ts):
 *
 *   R = fluorescent pink, G = signal green, B = black (key), A = halftone
 *   (A 1 = screened with dots, 0 = contone/crisp).
 *
 * The riso pass prints them onto newsprint with rotated halftone screens and
 * a little misregistration, so a plain lit shape comes out as a riso print.
 * Shadows ADD ink (print logic), so keep lit faces light and let shade build
 * density.
 *
 *   const m = inkMaterial({ ink: [0, 0.9, 0], shadow: [0, 0.2, 0.55] })
 *   const shot = inkMaterial({ map: screenshotTexture, halftone: 0.6 })
 *   const lines = inkLineMaterial([0, 0, 1])
 *   const shadow = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), inkShadowMaterial(0.5))
 *
 * InstancedMesh works with every material here (per-instance densities via
 * setColorAt: instanceColor multiplies `ink`).
 */

export type Ink = [pink: number, green: number, black: number]

/** Densities of the house inks, handy constants. */
export const INK = {
  none: [0, 0, 0] as Ink,
  pink: [1, 0, 0] as Ink,
  green: [0, 1, 0] as Ink,
  black: [0, 0, 1] as Ink,
}

/**
 * GLSL: separate a (linear) RGB colour into pink/green/black densities —
 * a three-drum riso separation of a photo or screenshot.
 */
export const SEPARATE_GLSL = /* glsl */ `
vec3 separate(vec3 c) {
  c = clamp(c, 0.0, 1.0);
  float lum = dot(c, vec3(0.2126, 0.7152, 0.0722));
  float dark = 1.0 - sqrt(lum);
  float k = clamp(dark * dark * 1.35, 0.0, 1.0);
  float green = clamp((c.g - max(c.r, c.b)) * 2.2 + (c.g - c.r) * 0.35, 0.0, 1.0);
  float pink = clamp((max(c.r, c.b) - c.g) * 1.9, 0.0, 1.0);
  return vec3(pink, green, k);
}
`

const VERT = /* glsl */ `
varying vec3 vN;
varying vec3 vWorld;
varying vec2 vUv;
varying vec3 vTint;
void main() {
  vec4 pos = vec4(position, 1.0);
  vec3 n = normal;
  vTint = vec3(1.0);
  #ifdef USE_INSTANCING
    pos = instanceMatrix * pos;
    n = mat3(instanceMatrix) * n;
  #endif
  #ifdef USE_INSTANCING_COLOR
    vTint = instanceColor;
  #endif
  vec4 wp = modelMatrix * pos;
  vWorld = wp.xyz;
  vN = normalize(mat3(modelMatrix) * n);
  vUv = uv;
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`

const FRAG = /* glsl */ `
uniform vec3 uInk, uShadow, uLightDir;
uniform float uHalftone, uUseMap, uMapGain;
uniform sampler2D uMap;
varying vec3 vN;
varying vec3 vWorld;
varying vec2 vUv;
varying vec3 vTint;
${SEPARATE_GLSL}
void main() {
  vec3 n = normalize(vN);
  if (!gl_FrontFacing) n = -n;
  float ndl = dot(n, normalize(uLightDir));
  float shade = 1.0 - smoothstep(-0.35, 0.95, ndl);
  vec3 d = uInk * vTint + uShadow * shade;
  if (uUseMap > 0.5) d = max(d, separate(texture2D(uMap, vUv).rgb) * uMapGain);
  gl_FragColor = vec4(d, uHalftone);
}
`

export interface InkMaterialOptions {
  /** densities on lit faces */
  ink?: Ink
  /** densities ADDED in shade (0 lit → 1 fully shaded) */
  shadow?: Ink
  /** world-space direction the light comes FROM */
  lightDir?: THREE.Vector3
  /** 1 = halftone dots, 0 = crisp contone (default 1) */
  halftone?: number
  /** a colour texture printed via a 3-ink separation */
  map?: THREE.Texture | null
  mapGain?: number
  side?: THREE.Side
  transparent?: boolean
}

/** Lit "printed" material: flat ink + shade that builds density. */
export function inkMaterial(o: InkMaterialOptions = {}): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    vertexShader: VERT,
    fragmentShader: FRAG,
    side: o.side ?? THREE.FrontSide,
    transparent: o.transparent ?? false,
    toneMapped: false,
    uniforms: {
      uInk: { value: new THREE.Vector3(...(o.ink ?? INK.none)) },
      uShadow: { value: new THREE.Vector3(...(o.shadow ?? [0, 0, 0.45])) },
      uLightDir: { value: (o.lightDir ?? new THREE.Vector3(-0.45, 0.8, 0.55)).clone().normalize() },
      uHalftone: { value: o.halftone ?? 1 },
      uUseMap: { value: o.map ? 1 : 0 },
      uMapGain: { value: o.mapGain ?? 1 },
      uMap: { value: o.map ?? null },
    },
  })
}

/** Unlit flat ink (type, rules, sticker shapes). */
export function inkFlatMaterial(ink: Ink, halftone = 1, side: THREE.Side = THREE.DoubleSide) {
  return new THREE.ShaderMaterial({
    vertexShader: VERT,
    fragmentShader: /* glsl */ `
      uniform vec3 uInk; uniform float uHalftone;
      varying vec3 vTint;
      void main() { gl_FragColor = vec4(uInk * vTint, uHalftone); }
    `,
    side,
    toneMapped: false,
    uniforms: { uInk: { value: new THREE.Vector3(...ink) }, uHalftone: { value: halftone } },
  })
}

/** Lines / wireframes in ink. */
export function inkLineMaterial(ink: Ink, halftone = 0) {
  return new THREE.ShaderMaterial({
    vertexShader: /* glsl */ `void main() { gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
    fragmentShader: /* glsl */ `uniform vec3 uInk; uniform float uHalftone; void main() { gl_FragColor = vec4(uInk, uHalftone); }`,
    toneMapped: false,
    uniforms: { uInk: { value: new THREE.Vector3(...ink) }, uHalftone: { value: halftone } },
  })
}

/**
 * Soft contact shadow for a PlaneGeometry lying under an object: a radial
 * falloff of black ink that the press screens into a dot gradient.
 * Rotate the mesh flat (-PI/2 on x) and scale it to the object's footprint.
 */
export function inkShadowMaterial(strength = 0.45, softness = 0.55) {
  return new THREE.ShaderMaterial({
    vertexShader: VERT,
    fragmentShader: /* glsl */ `
      uniform float uStrength, uSoft;
      varying vec2 vUv;
      void main() {
        float r = length(vUv - 0.5) * 2.0;
        float a = 1.0 - smoothstep(1.0 - uSoft, 1.0, r);
        if (a <= 0.001) discard;
        gl_FragColor = vec4(0.0, 0.0, uStrength * a, 1.0);
      }
    `,
    depthWrite: false,
    toneMapped: false,
    uniforms: { uStrength: { value: strength }, uSoft: { value: softness } },
  })
}

/**
 * Draw type/graphics on a canvas and use it as INK directly: the canvas's
 * R/G/B channels are pink/green/black densities (so draw black text with
 * fillStyle 'rgb(0,0,255)', green with 'rgb(0,255,0)', etc.) on a
 * transparent/black background. Returns a texture for inkMaterial-like use
 * via `inkCanvasMaterial`.
 */
export function inkCanvasMaterial(canvas: HTMLCanvasElement, halftone = 0) {
  const tex = new THREE.CanvasTexture(canvas)
  tex.colorSpace = THREE.NoColorSpace
  tex.anisotropy = 8
  const mat = new THREE.ShaderMaterial({
    vertexShader: VERT,
    fragmentShader: /* glsl */ `
      uniform sampler2D uMap; uniform float uHalftone;
      varying vec2 vUv;
      void main() {
        vec4 t = texture2D(uMap, vUv);
        if (t.a < 0.02 && max(t.r, max(t.g, t.b)) < 0.02) discard;
        gl_FragColor = vec4(t.rgb, uHalftone);
      }
    `,
    side: THREE.DoubleSide,
    transparent: false,
    toneMapped: false,
    uniforms: { uMap: { value: tex }, uHalftone: { value: halftone } },
  })
  return { material: mat, texture: tex }
}
