import * as THREE from 'three'

/*
 * One LEAF of the zine: a sheet hinged at the staples (x = 0), front face up
 * when it lies on the right-hand stack, back face up once turned to the left.
 *
 * The vertex shader bends the sheet in its cross-section: every point sits at
 * arc length s from the spine, and the sheet's angle along s is
 *
 *   phi(s) = theta                      hinge angle (0 right … PI left)
 *          + gutter * exp(-9 s)         the rise out of the stapled gutter
 *          + bend * s * (0.35 + 0.65 s) the free edge leading / trailing
 *          + twist * s * v              the grabbed corner leading the turn
 *
 * integrated along s in 16 fixed steps (no dynamic loop bounds), so the paper
 * never stretches along its length: it rolls, lifts and lays down like a real
 * sheet. Both faces are printed from the page atlas; shade on the bent paper
 * ADDS black ink (screened), the page keeps a faint contone paper tone and a
 * crisp keyline so bare paper still separates from the mat.
 */

export const PAGE_W = 1
export const PAGE_H = 1.4142

const VERT = /* glsl */ `
uniform float uTheta, uBend, uTwist, uY, uGutter;
uniform float uW, uH;
varying vec2 vUv;
varying vec3 vN;
varying vec3 vLocal;
varying float vGut;

float phiAt(float x, float vn) {
  return uTheta + uGutter * exp(-x * 9.0) + uBend * x * (0.35 + 0.65 * x) + uTwist * x * vn;
}

void main() {
  float x = clamp(position.x / uW, 0.0, 1.0);
  float v = position.z;
  float vn = v / uH;
  vec2 p = vec2(0.0, uY);
  float ds = x / 16.0;
  for (int i = 0; i < 16; i++) {
    float ph = phiAt((float(i) + 0.5) * ds, vn);
    p += (uW * ds) * vec2(cos(ph), sin(ph));
  }
  float pe = phiAt(x, vn);
  vec3 pos = vec3(p.x, p.y, v);
  vLocal = pos;
  vN = normalize(mat3(modelMatrix) * vec3(-sin(pe), cos(pe), 0.0));
  vUv = uv;
  vGut = exp(-x * 14.0);
  gl_Position = projectionMatrix * viewMatrix * modelMatrix * vec4(pos, 1.0);
}
`

const FRAG = /* glsl */ `
uniform sampler2D uAtlas;
uniform vec4 uFront, uBack;
uniform vec3 uLight;
uniform float uTone;
/* shadow of a leaf lifted above this one: (edge x, side, amount, softness) */
uniform vec4 uCast;
/* rubber-stamp impressions, one per face: uv rect + amount */
uniform vec4 uStampF, uStampB;
uniform float uStampAF, uStampAB;
uniform sampler2D uStampMap;
varying vec2 vUv;
varying vec3 vN;
varying vec3 vLocal;
varying float vGut;

void main() {
  bool front = gl_FrontFacing;
  vec2 fuv = front ? vUv : vec2(1.0 - vUv.x, vUv.y);
  vec4 r = front ? uFront : uBack;
  vec3 tex = texture2D(uAtlas, r.xy + fuv * r.zw).rgb;

  // rubber-stamp impression on this face, sampled unconditionally
  vec4 sr = front ? uStampF : uStampB;
  float sa = front ? uStampAF : uStampAB;
  vec2 suv = (fuv - sr.xy) / max(sr.zw, vec2(1e-4));
  vec4 st = texture2D(uStampMap, clamp(suv, 0.0, 1.0));
  float inStamp = step(0.0, suv.x) * step(suv.x, 1.0) * step(0.0, suv.y) * step(suv.y, 1.0);
  vec3 stampInk = st.rgb * inStamp * sa;

  // derivatives up front (uniform control flow)
  vec2 fw = max(fwidth(vUv), vec2(1e-5));
  float kEdge = fwidth(tex.b);

  // crisp keyline around the trimmed sheet, ~1px on screen
  vec2 e2 = min(vUv, 1.0 - vUv) / fw;
  float outline = 1.0 - smoothstep(0.55, 1.45, min(e2.x, e2.y));

  vec3 n = normalize(vN);
  if (!front) n = -n;
  float ndl = dot(n, normalize(uLight));
  float shade = 1.0 - smoothstep(-0.45, 0.95, ndl);
  shade = max(shade - 0.08, 0.0);

  // a lifted leaf's shadow falls across this page
  float side = uCast.y * (uCast.x - vLocal.x);
  float castSh = uCast.z * smoothstep(-uCast.w, uCast.w * 0.25, side);

  float gutter = vGut * 0.22;
  float shadeInk = shade * 0.36 + castSh * 0.42 + gutter;

  vec3 ink = max(tex, stampInk);
  ink.b += uTone + shadeInk;
  ink.b = max(ink.b, outline * 0.92);

  float tint = smoothstep(0.02, 0.1, max(tex.r, tex.g) + max(stampInk.r, stampInk.g));
  float kTint = smoothstep(0.02, 0.1, tex.b) * (1.0 - smoothstep(0.05, 0.22, kEdge));
  float sh = smoothstep(0.05, 0.14, shadeInk);
  float ht = max(max(tint, kTint), sh) * (1.0 - outline);
  gl_FragColor = vec4(clamp(ink, 0.0, 1.0), ht);
}
`

export interface LeafUniforms {
  [k: string]: THREE.IUniform
  uTheta: THREE.IUniform<number>
  uBend: THREE.IUniform<number>
  uTwist: THREE.IUniform<number>
  uY: THREE.IUniform<number>
  uGutter: THREE.IUniform<number>
  uW: THREE.IUniform<number>
  uH: THREE.IUniform<number>
  uAtlas: THREE.IUniform<THREE.Texture | null>
  uFront: THREE.IUniform<THREE.Vector4>
  uBack: THREE.IUniform<THREE.Vector4>
  uLight: THREE.IUniform<THREE.Vector3>
  uTone: THREE.IUniform<number>
  uCast: THREE.IUniform<THREE.Vector4>
  uStampF: THREE.IUniform<THREE.Vector4>
  uStampB: THREE.IUniform<THREE.Vector4>
  uStampAF: THREE.IUniform<number>
  uStampAB: THREE.IUniform<number>
  uStampMap: THREE.IUniform<THREE.Texture | null>
}

let _geo: THREE.BufferGeometry | null = null
let _geoKey = ''

/** A sheet from the spine (x = 0) to the free edge (x = W), lying in XZ, front face up. */
export function leafGeometry(segS: number, segV: number) {
  const key = `${segS}x${segV}`
  if (_geo && _geoKey === key) return _geo
  const g = new THREE.PlaneGeometry(PAGE_W, PAGE_H, segS, segV)
  g.rotateX(-Math.PI / 2)
  g.translate(PAGE_W / 2, 0, 0)
  g.deleteAttribute('normal')
  _geo = g
  _geoKey = key
  return g
}

export function leafMaterial(atlas: THREE.Texture, stampMap: THREE.Texture) {
  const uniforms: LeafUniforms = {
    uTheta: { value: 0 },
    uBend: { value: 0 },
    uTwist: { value: 0 },
    uY: { value: 0 },
    uGutter: { value: 0 },
    uW: { value: PAGE_W },
    uH: { value: PAGE_H },
    uAtlas: { value: atlas },
    uFront: { value: new THREE.Vector4(0, 0, 1, 1) },
    uBack: { value: new THREE.Vector4(0, 0, 1, 1) },
    uLight: { value: new THREE.Vector3(-0.5, 0.85, 0.35).normalize() },
    uTone: { value: 0.045 },
    uCast: { value: new THREE.Vector4(0, 1, 0, 0.2) },
    uStampF: { value: new THREE.Vector4(0.5, 0.5, 0.3, 0.3) },
    uStampB: { value: new THREE.Vector4(0.5, 0.5, 0.3, 0.3) },
    uStampAF: { value: 0 },
    uStampAB: { value: 0 },
    uStampMap: { value: stampMap },
  }
  const material = new THREE.ShaderMaterial({
    vertexShader: VERT,
    fragmentShader: FRAG,
    uniforms,
    side: THREE.DoubleSide,
    toneMapped: false,
  })
  return { material, uniforms }
}

export interface LeafPose {
  theta: number
  bend: number
  twist: number
  gutter: number
  y: number
}

/**
 * Pose a leaf for turn progress q (0 = lying right, 1 = lying left).
 * `settle` (0..1) is a small rebound of the free edge right after it lands;
 * `lift` adds extra bend (the cover fluttering on its air cushion).
 */
export function leafPose(q: number, yRight: number, yLeft: number, calm: boolean, settle = 0, lift = 0, out?: LeafPose) {
  const o = out ?? { theta: 0, bend: 0, twist: 0, gutter: 0, y: 0 }
  // spine angle: a snappy in-out with the page hanging near the top
  const e = q < 0.5 ? 4 * q * q * q : 1 - Math.pow(-2 * q + 2, 3) / 2
  o.theta = Math.PI * e
  const s2 = Math.sin(2 * Math.PI * q)
  const s1 = Math.sin(Math.PI * q)
  // lifting: the free edge leads and rolls over (an arch at mid-turn);
  // falling: it trails on a cushion of air
  const bend = calm ? 0.35 * s2 + 0.5 * s1 : 0.85 * s2 + 1.05 * s1
  const rebound = calm ? 0 : Math.sin(Math.PI * settle) * (1 - settle) * 0.24
  o.bend = bend - rebound * (e > 0.5 ? 1 : -1) + lift
  o.twist = (calm ? 0.2 : 0.6) * s1
  o.gutter = 0.3 * Math.cos(o.theta)
  o.y = yRight + (yLeft - yRight) * e
  return o
}

export function applyPose(u: LeafUniforms, p: LeafPose) {
  u.uTheta.value = p.theta
  u.uBend.value = p.bend
  u.uTwist.value = p.twist
  u.uGutter.value = p.gutter
  u.uY.value = p.y
}

/**
 * CPU mirror of the vertex shader: the (x, y) of the point at arc fraction
 * `x` along the row `vn` (-0.5 far edge … 0.5 near edge).
 */
export function leafPoint(p: LeafPose, x: number, vn: number, out: THREE.Vector2) {
  const phi = (t: number) => p.theta + p.gutter * Math.exp(-t * 9) + p.bend * t * (0.35 + 0.65 * t) + p.twist * t * vn
  let px = 0
  let py = p.y
  const ds = x / 16
  for (let i = 0; i < 16; i++) {
    const ph = phi((i + 0.5) * ds)
    px += PAGE_W * ds * Math.cos(ph)
    py += PAGE_W * ds * Math.sin(ph)
  }
  return out.set(px, py)
}
