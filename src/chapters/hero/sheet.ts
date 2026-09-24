import * as THREE from 'three'
import { BRAND, MICROCOPY } from '../../content'
import { buildMaskCanvas, markFrame, SHADOW_OFF } from './markArt'
import { LIGHT, type Layout } from './shared'

/*
 * The sheet: a subdivided plane whose vertex shader can peel it off the bed
 * from a corner (a bend of radius R up to angle alpha, then straight) and
 * ripple it, and whose fragment shader PRINTS it: crop marks and slugs,
 * corner registration targets and a colour bar per ink, and the three
 * impressions of the mark (key keyline, green loops, pink diamond + shadow)
 * with rough ink edges, each at its own register offset.
 */

export const TRIM = 0.32

const VERT = /* glsl */ `
uniform vec2 uSize;
uniform vec4 uPeel;     // dir.xy (from the lifted edge into the sheet), fold distance, bend angle
uniform float uPeelR;
uniform vec4 uWave;     // amp, wavenumber, phase, edge bias
uniform vec2 uWaveDir;
varying vec2 vUv;
varying vec2 vP;
varying vec3 vN;
varying float vLift;
void main() {
  vUv = uv;
  vec2 p = (uv - 0.5) * uSize;
  vP = p;
  vec2 dir = uPeel.xy;
  float sMin = -(abs(dir.x) * uSize.x + abs(dir.y) * uSize.y) * 0.5;
  float s = dot(p, dir) - sMin;
  float d = uPeel.z - s;
  vec3 pos = vec3(p, 0.0);
  vec3 n = vec3(0.0, 0.0, 1.0);
  vLift = 0.0;
  if (d > 0.0 && uPeel.w > 0.001) {
    float R = uPeelR;
    float a = uPeel.w;
    float arc = R * a;
    float along;
    float up;
    float phi;
    if (d < arc) {
      phi = d / R;
      along = R * sin(phi);
      up = R * (1.0 - cos(phi));
    } else {
      phi = a;
      along = R * sin(a) + (d - arc) * cos(a);
      up = R * (1.0 - cos(a)) + (d - arc) * sin(a);
    }
    pos.xy = p + dir * (d - along);
    pos.z = up;
    n = vec3(dir * sin(phi), cos(phi));
    vLift = phi;
  }
  // ripple: a travelling wave, stronger toward the free edge
  float wd = dot(p, uWaveDir);
  float edge = mix(1.0, smoothstep(-0.6, 0.6, wd / max(0.001, length(uSize) * 0.5)), uWave.w);
  float ph = wd * uWave.y + uWave.z;
  pos.z += uWave.x * sin(ph) * edge;
  n.xy -= uWaveDir * (uWave.x * uWave.y * cos(ph) * edge);
  vN = normalize(mat3(modelMatrix) * normalize(n));
  gl_Position = projectionMatrix * viewMatrix * modelMatrix * vec4(pos, 1.0);
}
`

const FRAG = /* glsl */ `
uniform vec2 uSize;
uniform float uTrim;
uniform sampler2D uMask;
uniform sampler2D uSlug;
uniform vec2 uMarkPos;
uniform float uMarkSpan;
uniform vec3 uAmt;        // K, G, P impressions 0..1
uniform vec2 uOffK;
uniform vec2 uOffG;
uniform vec2 uOffP;
uniform vec2 uShadow;     // pink shadow offset, sheet units
uniform float uGuide;     // pencil guides 0..1
uniform float uPort;
uniform vec3 uLight;
varying vec2 vUv;
varying vec2 vP;
varying vec3 vN;
varying float vLift;

float h12(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * .1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
float vn(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(h12(i), h12(i + vec2(1, 0)), u.x), mix(h12(i + vec2(0, 1)), h12(i + vec2(1, 1)), u.x), u.y);
}

// a pixel-width line from a distance in sheet units
float lineAA(float d, float px, float fw) { return 1.0 - smoothstep(px * 0.5 * fw - 0.5 * fw, px * 0.5 * fw + 0.5 * fw, d); }

vec2 markUv(vec2 p) { return (p - uMarkPos) / uMarkSpan + 0.5; }

// rough, mottled ink from one mask channel (soft = how far the edge wanders, mottle = density variation)
float inkOf(vec2 uv, vec3 ch, float grit, float softMix, float mottle) {
  float crisp = dot(texture2D(uMask, uv).rgb, ch);
  float soft = dot(texture2D(uMask, uv, 2.2).rgb, ch);
  float n = vn(uv * 210.0) * 0.6 + vn(uv * 57.0 + 7.3) * 0.4;
  float m = mix(crisp, soft, softMix) + (n - 0.5) * grit;
  float ink = smoothstep(0.46, 0.54, m);
  return ink * (1.0 - mottle + mottle * vn(uv * 34.0 + 3.1));
}

// corner registration target (ring + cross + dot), centred at the margin corners
float target(vec2 p, float fw) {
  vec2 c = uSize * 0.5 - vec2(uTrim * 0.5);
  vec2 q = abs(p) - c;
  float R = uTrim * 0.27;
  float r = length(q);
  float ring = lineAA(abs(r - R), 1.4, fw);
  float cx = lineAA(abs(q.x), 1.2, fw) * step(abs(q.y), R * 1.55);
  float cy = lineAA(abs(q.y), 1.2, fw) * step(abs(q.x), R * 1.55);
  float dotc = 1.0 - smoothstep(R * 0.26 - fw, R * 0.26 + fw, r);
  return max(max(ring, dotc), max(cx, cy));
}

// ink spatter: sparse specks thrown off around the impression (seeded per ink)
float speck(vec2 p, float seed) {
  vec2 c = p - uMarkPos;
  float r = length(c) / uMarkSpan;
  if (r > 0.52) return 0.0;
  vec2 cell = floor(p / 0.075);
  float h = h12(cell + seed);
  if (h < 0.93) return 0.0;
  vec2 o = (vec2(h12(cell + seed + 3.7), h12(cell + seed + 9.1)) - 0.5) * 0.05;
  float rad = 0.004 + 0.012 * h12(cell + seed + 5.3) * h12(cell + seed + 1.9);
  float d = length(p - (cell + 0.5) * 0.075 - o);
  return (1.0 - smoothstep(rad * 0.6, rad, d)) * smoothstep(0.52, 0.34, r);
}

// colour bar along the foot margin: K, G, P tints, then two overprints
float bar(vec2 p, float ink) {
  float pitch = uPort > 0.5 ? 0.19 : 0.215;
  float pw = pitch - 0.028;
  float x0 = -uSize.x * 0.5 + uTrim + (uPort > 0.5 ? 0.18 : 0.52);
  float yc = -uSize.y * 0.5 + uTrim * 0.5;
  float fx = (p.x - x0) / pitch;
  float j = floor(fx);
  if (j < 0.0 || j > 13.0) return 0.0;
  if (fract(fx) * pitch > pw || abs(p.y - yc) > uTrim * 0.22) return 0.0;
  float group = floor(j / 4.0);
  float tint = 1.0 - mod(j, 4.0) * 0.27;
  if (group < 2.5) return group == ink ? tint : 0.0;
  // overprints: G+P, then K+G+P
  if (j < 12.5) return ink > 0.5 ? 1.0 : 0.0;
  return 1.0;
}

void main() {
  vec2 p = vP;
  vec2 fwv = fwidth(p);
  float fw = max(1e-5, max(fwv.x, fwv.y));

  // --- pre-printed: crop marks + slugs (black, crisp) and pencil guides ---
  vec2 q = abs(p);
  vec2 tr = uSize * 0.5 - vec2(uTrim);
  float g = 0.05;
  float L = uTrim - g - 0.04;
  float cropH = lineAA(abs(q.y - tr.y), 1.2, fw) * step(tr.x + g, q.x) * step(q.x, tr.x + g + L);
  float cropV = lineAA(abs(q.x - tr.x), 1.2, fw) * step(tr.y + g, q.y) * step(q.y, tr.y + g + L);
  float crop = max(cropH, cropV);
  vec4 slug = texture2D(uSlug, vUv);
  float text = slug.b;
  float pencil = slug.r * uGuide;

  // --- the three plates, each at its own register ---
  float key = inkOf(markUv(p - uOffK), vec3(0.0, 1.0, 0.0), 0.16, 0.3, 0.0) * uAmt.x;
  float grn = inkOf(markUv(p - uOffG), vec3(1.0, 0.0, 0.0), 0.3, 0.55, 0.1) * uAmt.y;
  vec2 up = markUv(p - uOffP);
  float dia = inkOf(up, vec3(0.0, 0.0, 1.0), 0.3, 0.55, 0.1);
  float shd = inkOf(up - uShadow / uMarkSpan, vec3(1.0, 0.0, 0.0), 0.3, 0.55, 0.1);
  float knock = dot(texture2D(uMask, up).rgb, vec3(1.0, 0.0, 0.0));
  float pnk = max(dia, shd * (1.0 - smoothstep(0.35, 0.65, knock)) * 0.52) * uAmt.z;
  key = max(key, speck(p - uOffK, 11.0) * uAmt.x);
  grn = max(grn, speck(p - uOffG, 47.0) * uAmt.y);
  pnk = max(pnk, speck(p - uOffP, 83.0) * uAmt.z);

  float tK = target(p - uOffK, fw) * uAmt.x;
  float tG = target(p - uOffG, fw) * uAmt.y;
  float tP = target(p - uOffP, fw) * uAmt.z;
  float bK = bar(p - uOffK, 0.0) * uAmt.x;
  float bG = bar(p - uOffG, 1.0) * uAmt.y;
  float bP = bar(p - uOffP, 2.0) * uAmt.z;

  // --- paper: edge rule, tone, and the shade of the bend ---
  vec2 e2 = uSize * 0.5 - q;
  float edge = lineAA(min(e2.x, e2.y), 1.8, fw);
  vec3 n = normalize(vN);
  if (!gl_FrontFacing) n = -n;
  float shade = 1.0 - smoothstep(-0.3, 0.72, dot(n, normalize(uLight)));

  float pink = max(pnk, max(tP, bP));
  float green = max(grn, max(tG, bG));
  float crispK = max(max(crop, text), max(key, tK));
  float black = max(crispK, bK);
  black = max(black, pencil * 0.34);

  if (!gl_FrontFacing) {
    // the back of the sheet: greyer stock, the print showing through
    pink *= 0.1;
    green *= 0.1;
    black = black * 0.12 + 0.06;
    crispK = 0.0;
  }
  black = min(1.0, black + shade * 0.55 + edge * 0.9);
  float ht = 1.0 - clamp(max(max(crispK, edge), max(tG, tP)), 0.0, 1.0);
  gl_FragColor = vec4(pink, green, black, ht);
}
`

export class Sheet {
  mesh: THREE.Mesh
  material: THREE.ShaderMaterial
  private slugCanvas: HTMLCanvasElement
  private slugTex: THREE.CanvasTexture
  private layout: Layout | null = null

  constructor(mobile: boolean) {
    const mask = new THREE.CanvasTexture(buildMaskCanvas(mobile ? 1024 : 1024))
    mask.colorSpace = THREE.NoColorSpace
    mask.anisotropy = 4
    this.slugCanvas = document.createElement('canvas')
    this.slugTex = new THREE.CanvasTexture(this.slugCanvas)
    this.slugTex.colorSpace = THREE.NoColorSpace
    this.slugTex.anisotropy = 8

    this.material = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      side: THREE.DoubleSide,
      toneMapped: false,
      uniforms: {
        uSize: { value: new THREE.Vector2(6, 4) },
        uTrim: { value: TRIM },
        uMask: { value: mask },
        uSlug: { value: this.slugTex },
        uMarkPos: { value: new THREE.Vector2() },
        uMarkSpan: { value: 3 },
        uAmt: { value: new THREE.Vector3() },
        uOffK: { value: new THREE.Vector2() },
        uOffG: { value: new THREE.Vector2() },
        uOffP: { value: new THREE.Vector2() },
        uShadow: { value: new THREE.Vector2() },
        uGuide: { value: 1 },
        uPort: { value: 0 },
        uLight: { value: LIGHT.clone() },
        uPeel: { value: new THREE.Vector4(-0.7071, 0.7071, 0, 0) },
        uPeelR: { value: 0.32 },
        uWave: { value: new THREE.Vector4() },
        uWaveDir: { value: new THREE.Vector2(0, 1) },
      },
    })
    const seg = mobile ? [40, 40] : [72, 60]
    this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1, seg[0], seg[1]), this.material)
    this.mesh.frustumCulled = false
  }

  get u() {
    return this.material.uniforms
  }

  setLayout(l: Layout) {
    if (this.layout && this.layout.port === l.port) return
    this.layout = l
    const f = markFrame()
    const u = this.u
    u.uSize.value.set(l.w, l.h)
    u.uPort.value = l.port ? 1 : 0
    u.uMarkPos.value.set(l.mx, l.my)
    u.uMarkSpan.value = f.span * l.mh
    u.uShadow.value.set(SHADOW_OFF.x * l.mh, SHADOW_OFF.y * l.mh)
    this.drawSlug()
  }

  /** Slug lines (black, B channel) and pencil guides for the headline (R channel), in sheet space. */
  drawSlug() {
    const l = this.layout
    if (!l) return
    const W = l.port ? 1400 : 2048
    const H = Math.round((W * l.h) / l.w)
    const cv = this.slugCanvas
    if (cv.width !== W || cv.height !== H) {
      cv.width = W
      cv.height = H
    }
    const ctx = cv.getContext('2d')!
    const k = W / l.w // px per sheet unit
    const X = (x: number) => (x + l.w / 2) * k
    const Y = (y: number) => (l.h / 2 - y) * k
    ctx.globalCompositeOperation = 'source-over'
    ctx.fillStyle = '#000'
    ctx.fillRect(0, 0, W, H)
    ctx.globalCompositeOperation = 'lighter'
    const tx = l.w / 2 - TRIM
    const ty = l.h / 2 - TRIM
    const mono = (px: number) => `500 ${Math.round(px)}px "DM Mono", ui-monospace, monospace`

    // top slug, in the margin
    ctx.fillStyle = 'rgb(0,0,255)'
    ctx.font = mono(0.062 * k)
    ctx.textBaseline = 'middle'
    const top = l.port
      ? `HARK PRESS · ${MICROCOPY.signalEyebrow.toUpperCase()} · 3/C RISO`
      : `HARK PRESS  ·  ${MICROCOPY.signalEyebrow.toUpperCase()}  ·  JOB 26-001  ·  3/C RISO: K · G · P  ·  NEWSPRINT 80#`
    ctx.fillText(top, X(-tx + (l.port ? 0.42 : 0.5)), Y(ty + TRIM * 0.5))
    const right = 'SHEET 01/07'
    ctx.fillText(right, X(tx - (l.port ? 0.42 : 0.5)) - ctx.measureText(right).width, Y(ty + TRIM * 0.5))
    // foot slug, right of the colour bar
    if (!l.port) {
      const foot = `${BRAND.short.toUpperCase()}  ·  PHILADELPHIA`
      ctx.fillText(foot, X(tx - 0.5) - ctx.measureText(foot).width, Y(-ty - TRIM * 0.5))
    }

    // pencil: the headline's type area, dashed, with a setting note
    ctx.fillStyle = 'rgb(255,0,0)'
    ctx.strokeStyle = 'rgb(255,0,0)'
    ctx.lineWidth = Math.max(2, 0.012 * k)
    ctx.setLineDash([0.06 * k, 0.045 * k])
    const box = l.port
      ? { x0: -tx + 0.16, x1: tx - 0.16, y0: -ty + 0.16, y1: 0.02 }
      : { x0: -tx + 0.16, x1: 0.34, y0: -ty + 0.16, y1: ty - 0.16 }
    ctx.strokeRect(X(box.x0), Y(box.y1), (box.x1 - box.x0) * k, (box.y1 - box.y0) * k)
    ctx.setLineDash([])
    // a diagonal cross, the way a paste-up marks a space for type
    ctx.globalAlpha = 0.55
    ctx.beginPath()
    ctx.moveTo(X(box.x0), Y(box.y1))
    ctx.lineTo(X(box.x1), Y(box.y0))
    ctx.moveTo(X(box.x1), Y(box.y1))
    ctx.lineTo(X(box.x0), Y(box.y0))
    ctx.stroke()
    ctx.globalAlpha = 1
    ctx.font = mono(0.075 * k)
    ctx.textBaseline = 'top'
    const notes = ['HEADLINE — BRICOLAGE 800, 78% WIDTH', 'SET FLUSH LEFT, CAPS', '+ 2 BUTTONS']
    notes.forEach((t, i) => ctx.fillText(t, X(box.x0 + 0.14), Y(box.y1 - 0.14) + i * 0.11 * k))
    // a fresh texture each time so the mip chain is rebuilt from this drawing
    // (updating in place kept stale mips from the fallback-font pass)
    const old = this.slugTex
    this.slugTex = new THREE.CanvasTexture(cv)
    this.slugTex.colorSpace = THREE.NoColorSpace
    this.slugTex.anisotropy = 8
    this.u.uSlug.value = this.slugTex
    old.dispose()
  }
}

/** Rounded-rect halftone shadow for the sheet, lying on the mat (densities ADD). */
export function sheetShadowMaterial() {
  return new THREE.ShaderMaterial({
    vertexShader: /* glsl */ `
      varying vec2 vUv;
      void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
    `,
    fragmentShader: /* glsl */ `
      uniform vec2 uHalf;     // shadow half size (in the plane's uv * size)
      uniform vec2 uPlane;    // plane size
      uniform float uSoft;
      uniform float uStrength;
      varying vec2 vUv;
      void main() {
        vec2 p = (vUv - 0.5) * uPlane;
        vec2 q = abs(p) - uHalf + vec2(uSoft);
        float d = length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - uSoft;
        float a = 1.0 - smoothstep(-uSoft * 0.35, uSoft, d);
        if (a <= 0.002) discard;
        gl_FragColor = vec4(0.0, 0.0, uStrength * a, 0.0);
      }
    `,
    uniforms: {
      uHalf: { value: new THREE.Vector2(3, 2) },
      uPlane: { value: new THREE.Vector2(8, 6) },
      uSoft: { value: 0.1 },
      uStrength: { value: 0.4 },
    },
    ...ADD_BLEND,
  })
}

/** Blend state that ADDS ink densities (colour) and leaves the halftone flag alone. */
export const ADD_BLEND = {
  transparent: true,
  depthWrite: false,
  toneMapped: false,
  blending: THREE.CustomBlending,
  blendEquation: THREE.AddEquation,
  blendSrc: THREE.OneFactor,
  blendDst: THREE.OneFactor,
  blendEquationAlpha: THREE.AddEquation,
  blendSrcAlpha: THREE.ZeroFactor,
  blendDstAlpha: THREE.OneFactor,
} as const
