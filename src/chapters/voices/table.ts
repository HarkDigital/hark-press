import * as THREE from 'three'

/*
 * The work table: an A2 self-healing CUTTING MAT printed in the green drum
 * (a halftone tint), its 1 cm grid, 5 cm majors, a mm ruler along two edges
 * and a 45° guide, all as crisp contone black keylines; plus the zine's
 * contact shadow, computed in the zine's own space so it follows every
 * drop, turn and slide. Outside the mat the plane is bare table (no ink)
 * that still takes the shadow.
 *
 * Units: 1 world unit = one A5 page width = 148 mm.
 */

export const MM = 1 / 148
/** A2 landscape */
export const MAT_MM = new THREE.Vector2(594, 420)

const VERT = /* glsl */ `
varying vec2 vMat;
varying vec3 vWorld;
uniform vec2 uMatMM;
void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWorld = wp.xyz;
  // plane is in XZ; mat mm coordinates, origin at the mat's top-left corner
  vMat = vec2(position.x / ${MM.toFixed(8)} + uMatMM.x * 0.5, position.z / ${MM.toFixed(8)} + uMatMM.y * 0.5);
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`

const FRAG = /* glsl */ `
uniform vec2 uMatMM;
uniform float uTint;
uniform sampler2D uNums;
uniform mat4 uZineInv;
uniform vec4 uShadowRect;   // x0, x1, z0, z1 in zine space
uniform vec3 uShadow;       // strength, softness, 0
uniform vec2 uShadowOff;
uniform vec4 uLeafShadow;   // x0, x1, strength, softness: a lifted leaf's soft shadow
uniform float uHalfH;
varying vec2 vMat;
varying vec3 vWorld;

float sdBox(vec2 p, vec2 b) {
  vec2 d = abs(p) - b;
  return length(max(d, 0.0)) + min(max(d.x, d.y), 0.0);
}
// anti-aliased line on a grid of spacing 'step' (mm), width in px
float gridLine(float c, float stepMM, float wpx, float fw) {
  float d = abs(fract(c / stepMM - 0.5) - 0.5) * stepMM / max(fw, 1e-5);
  return 1.0 - smoothstep(wpx * 0.5 - 0.5, wpx * 0.5 + 0.5, d);
}

void main() {
  vec2 m = vMat;
  vec2 fw = fwidth(m);
  float fwm = max(fw.x, fw.y);

  // the mat's rounded outline
  vec2 half_ = uMatMM * 0.5;
  float sd = sdBox(m - half_, half_ - 14.0) - 14.0;
  float inside = 1.0 - smoothstep(-0.5, 0.5, sd / max(fwm, 1e-5));
  float border = (1.0 - smoothstep(0.7, 1.7, abs(sd) / max(fwm, 1e-5)));

  // grid: 1 cm minors, 5 cm majors, inset from the ruler margin
  vec2 g = m - vec2(20.0, 20.0);
  float inGrid = step(0.0, g.x) * step(0.0, g.y) * step(g.x, uMatMM.x - 40.0) * step(g.y, uMatMM.y - 40.0);
  float minor = max(gridLine(g.x, 10.0, 0.9, fw.x), gridLine(g.y, 10.0, 0.9, fw.y));
  float major = max(gridLine(g.x, 50.0, 1.7, fw.x), gridLine(g.y, 50.0, 1.7, fw.y));
  // 45° guide from the bottom-left grid corner
  float diag = abs((g.x - (uMatMM.y - 40.0 - g.y))) * 0.7071 / max(fwm, 1e-5);
  float guide = (1.0 - smoothstep(0.2, 1.2, diag)) * inGrid;

  // mm ruler ticks along the top and left edges
  float tx = fract(m.x - 0.5);
  float mmIdx = floor(m.x + 0.5);
  float tLen = mod(mmIdx - 20.0, 10.0) < 0.5 ? 9.0 : (mod(mmIdx - 20.0, 5.0) < 0.5 ? 6.0 : 3.5);
  float tickTop = (1.0 - smoothstep(0.35, 1.1, abs(tx - 0.5) / max(fw.x, 1e-5))) * step(m.y, 4.0 + tLen) * step(4.0, m.y) * step(20.0, m.x) * step(m.x, uMatMM.x - 20.0);
  float ty = fract(m.y - 0.5);
  float mmIdy = floor(m.y + 0.5);
  float tLenY = mod(mmIdy - 20.0, 10.0) < 0.5 ? 9.0 : (mod(mmIdy - 20.0, 5.0) < 0.5 ? 6.0 : 3.5);
  float tickLeft = (1.0 - smoothstep(0.35, 1.1, abs(ty - 0.5) / max(fw.y, 1e-5))) * step(m.x, 4.0 + tLenY) * step(4.0, m.x) * step(20.0, m.y) * step(m.y, uMatMM.y - 20.0);

  vec3 nums = texture2D(uNums, vec2(m.x / uMatMM.x, 1.0 - m.y / uMatMM.y)).rgb;

  float lines = max(max(minor * 0.42 * inGrid, major * 0.7 * inGrid), guide * 0.5);
  lines = max(lines, max(tickTop, tickLeft) * 0.75);
  lines = max(lines, nums.b);
  lines *= inside;

  float green = uTint * inside;

  // the zine's contact shadow
  vec3 zp = (uZineInv * vec4(vWorld, 1.0)).xyz;
  vec2 c = vec2(uShadowRect.x + uShadowRect.y, uShadowRect.z + uShadowRect.w) * 0.5 + uShadowOff;
  vec2 b = vec2(uShadowRect.y - uShadowRect.x, uShadowRect.w - uShadowRect.z) * 0.5;
  float sdz = sdBox(zp.xz - c, b);
  float shadow = uShadow.x * (1.0 - smoothstep(-uShadow.y * 0.35, uShadow.y, sdz));
  vec2 lc = vec2((uLeafShadow.x + uLeafShadow.y) * 0.5, 0.0) + uShadowOff * 1.6;
  vec2 lb = vec2(abs(uLeafShadow.y - uLeafShadow.x) * 0.5, uHalfH * 0.94);
  float sdl = sdBox(zp.xz - lc, lb);
  shadow = max(shadow, uLeafShadow.z * (1.0 - smoothstep(-uLeafShadow.w * 0.5, uLeafShadow.w, sdl)));

  float k = max(lines, border * 0.85);
  vec3 ink = vec3(0.0, green, k + shadow * (1.0 - k));
  float crisp = max(lines, border);
  float ht = 1.0 - crisp * (1.0 - smoothstep(0.08, 0.25, shadow));
  gl_FragColor = vec4(clamp(ink, 0.0, 1.0), ht);
}
`

function numbersCanvas(width: number) {
  const aspect = MAT_MM.y / MAT_MM.x
  const c = document.createElement('canvas')
  c.width = width
  c.height = Math.round(width * aspect)
  const ctx = c.getContext('2d')!
  ctx.fillStyle = '#000'
  ctx.fillRect(0, 0, c.width, c.height)
  const k = width / MAT_MM.x
  ctx.scale(k, k)
  ctx.fillStyle = 'rgb(0,0,235)'
  ctx.font = '500 4.2px "DM Mono", ui-monospace, monospace'
  ctx.textBaseline = 'middle'
  ctx.textAlign = 'center'
  for (let i = 1; i * 10 + 20 < MAT_MM.x - 20; i++) ctx.fillText(String(i), 20 + i * 10, 16.5)
  ctx.textAlign = 'left'
  for (let i = 1; i * 10 + 20 < MAT_MM.y - 20; i++) ctx.fillText(String(i), 14.2, 20 + i * 10)
  ctx.font = '500 5px "DM Mono", ui-monospace, monospace'
  ctx.textAlign = 'right'
  ctx.fillText('HARK PRESS · SELF-HEALING MAT · A2 · 594 × 420 MM', MAT_MM.x - 22, MAT_MM.y - 11)
  ctx.textAlign = 'left'
  ctx.fillText('CUT HERE, NOT THE TYPE', 22, MAT_MM.y - 11)
  const tex = new THREE.CanvasTexture(c)
  tex.colorSpace = THREE.NoColorSpace
  tex.generateMipmaps = true
  tex.minFilter = THREE.LinearMipmapLinearFilter
  tex.anisotropy = 8
  return tex
}

export interface Table {
  mesh: THREE.Mesh
  uniforms: {
    uTint: THREE.IUniform<number>
    uZineInv: THREE.IUniform<THREE.Matrix4>
    uShadowRect: THREE.IUniform<THREE.Vector4>
    uShadow: THREE.IUniform<THREE.Vector3>
    uShadowOff: THREE.IUniform<THREE.Vector2>
    uLeafShadow: THREE.IUniform<THREE.Vector4>
    uHalfH: THREE.IUniform<number>
  }
}

export function createTable(mobile: boolean): Table {
  const uniforms = {
    uMatMM: { value: MAT_MM.clone() },
    uTint: { value: 0.34 },
    uNums: { value: numbersCanvas(mobile ? 1400 : 2400) as THREE.Texture },
    uZineInv: { value: new THREE.Matrix4() },
    uShadowRect: { value: new THREE.Vector4(-1, 1, -0.7, 0.7) },
    uShadow: { value: new THREE.Vector3(0.5, 0.12, 0) },
    uShadowOff: { value: new THREE.Vector2(0.03, 0.045) },
    uLeafShadow: { value: new THREE.Vector4(0, 0, 0, 0.1) },
    uHalfH: { value: 0.7071 },
  }
  const material = new THREE.ShaderMaterial({
    vertexShader: VERT,
    fragmentShader: FRAG,
    uniforms,
    toneMapped: false,
  })
  // the table extends well past the mat so the shadow can leave it
  const geo = new THREE.PlaneGeometry(16, 12, 1, 1)
  geo.rotateX(-Math.PI / 2)
  const mesh = new THREE.Mesh(geo, material)
  mesh.frustumCulled = false
  return { mesh, uniforms }
}
