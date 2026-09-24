import * as THREE from 'three'
import type { CardArt } from './art'
import { POSTMARK_RECT, CARD_U, CARD_V } from './art'
import type { Crease } from './fold'
import { SHEET_W, SHEET_H } from './fold'

/*
 * Shaders for the airmail chapter. All output ink densities
 * (pink, green, black, halftone) for the riso pass in src/core/post.ts.
 */

export const MAX_CREASES = 16

const VALUE_NOISE = /* glsl */ `
float ctHash(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * .1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
float ctNoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(ctHash(i), ctHash(i + vec2(1, 0)), u.x), mix(ctHash(i + vec2(0, 1)), ctHash(i + vec2(1, 1)), u.x), u.y);
}
`

/**
 * Sheet-space vertex code shared by the paper and its shadow. The card
 * variant (define CARD) bends one corner up around a line (paper lifting in
 * a draught); the fold variant uses the CPU-posed positions as they are.
 */
const SHEET_VERTEX_HEAD = /* glsl */ `
uniform vec4 uCurl;      // corner.xy (sheet), curvature, bend distance from the corner
varying vec2 vUv;
varying vec2 vFlat;
vec3 sheetPos(inout vec3 n) {
  vec3 p = position;
  n = normal;
  #ifdef CARD
    vec2 corner = uCurl.xy;
    vec2 dir = normalize(corner);
    vec2 base = corner - dir * uCurl.w;
    float s = max(0.0, dot(p.xy - base, dir));
    float k = uCurl.z;
    if (k > 1e-4 && s > 0.0) {
      float th = s * k;
      float r = 1.0 / k;
      p.xy += dir * (r * sin(th) - s);
      p.z += r * (1.0 - cos(th));
      n = normalize(vec3(-dir * sin(th), cos(th)));
    }
  #endif
  return p;
}
`

export interface SheetUniforms {
  [k: string]: THREE.IUniform
  uA: THREE.IUniform<THREE.Texture>
  uAc: THREE.IUniform<THREE.Texture>
  uB: THREE.IUniform<THREE.Texture>
  uPost: THREE.IUniform<THREE.Texture>
  uPostRect: THREE.IUniform<THREE.Vector4>
  uPostmark: THREE.IUniform<number>
  uLight: THREE.IUniform<THREE.Vector3>
  uSheetRot: THREE.IUniform<THREE.Matrix3>
  uCrease: THREE.IUniform<THREE.Vector4[]>
  uCreaseW: THREE.IUniform<number[]>
  uCreaseR: THREE.IUniform<number[]>
  uRelief: THREE.IUniform<number>
  uShade: THREE.IUniform<number>
  uTone: THREE.IUniform<number>
  uLine: THREE.IUniform<number>
  uCurl: THREE.IUniform<THREE.Vector4>
  uGreen: THREE.IUniform<number>
}

export function sheetUniforms(art: CardArt, creases: Crease[]): SheetUniforms {
  const cr: THREE.Vector4[] = []
  const w: number[] = []
  const r: number[] = []
  for (let i = 0; i < MAX_CREASES; i++) {
    const c = creases[i]
    cr.push(c ? new THREE.Vector4(c.a[0], c.a[1], c.b[0], c.b[1]) : new THREE.Vector4(9, 9, 9.01, 9))
    w.push(0)
    r.push(c ? c.relief : 0)
  }
  // postmark rect in uv space (v up)
  const pr = POSTMARK_RECT
  return {
    uA: { value: art.sideA },
    uAc: { value: art.sideAc },
    uB: { value: art.sideB },
    uPost: { value: art.postmark },
    uPostRect: { value: new THREE.Vector4(pr.x / CARD_U, 1 - (pr.y + pr.h) / CARD_V, pr.w / CARD_U, pr.h / CARD_V) },
    uPostmark: { value: 0 },
    uLight: { value: new THREE.Vector3(-0.45, 0.85, -0.3).normalize() },
    uSheetRot: { value: new THREE.Matrix3() },
    uCrease: { value: cr },
    uCreaseW: { value: w },
    uCreaseR: { value: r },
    uRelief: { value: 0 },
    uShade: { value: 0.42 },
    uTone: { value: 0 },
    uLine: { value: 0.95 },
    uCurl: { value: new THREE.Vector4(1.5, -1, 0, 0.5) },
    uGreen: { value: 0 },
  }
}

export function sheetMaterial(u: SheetUniforms, card: boolean) {
  return new THREE.ShaderMaterial({
    defines: card ? { CARD: '' } : {},
    uniforms: u,
    side: THREE.DoubleSide,
    toneMapped: false,
    vertexShader: /* glsl */ `
      ${SHEET_VERTEX_HEAD}
      varying vec3 vN;
      void main() {
        vec3 n;
        vec3 p = sheetPos(n);
        vUv = uv;
        vFlat = (uv - 0.5) * vec2(${SHEET_W.toFixed(1)}, ${SHEET_H.toFixed(1)});
        vN = normalize(mat3(modelMatrix) * n);
        gl_Position = projectionMatrix * viewMatrix * modelMatrix * vec4(p, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      uniform sampler2D uA, uAc, uB, uPost;
      uniform vec4 uPostRect;
      uniform float uPostmark, uRelief, uShade, uTone, uLine, uGreen;
      uniform vec3 uLight;
      uniform mat3 uSheetRot;
      uniform vec4 uCrease[${MAX_CREASES}];
      uniform float uCreaseW[${MAX_CREASES}];
      uniform float uCreaseR[${MAX_CREASES}];
      varying vec2 vUv;
      varying vec2 vFlat;
      varying vec3 vN;
      ${VALUE_NOISE}
      void main() {
        vec2 f = vFlat;
        // world units per pixel, hoisted out of any branch
        float px = max(length(fwidth(f)), 1e-5);

        vec3 sA = texture2D(uA, vUv).rgb;
        vec3 sAc = texture2D(uAc, vUv).rgb;
        // side B is laid out to read upright when the dart topples and its outer half faces up
        vec3 sB = texture2D(uB, vec2(vUv.x, 1.0 - vUv.y)).rgb;
        vec2 pu = (vUv - uPostRect.xy) / uPostRect.zw;
        vec3 pm = texture2D(uPost, clamp(pu, 0.0, 1.0)).rgb;
        float inPost = step(0.0, pu.x) * step(pu.x, 1.0) * step(0.0, pu.y) * step(pu.y, 1.0);

        float front = gl_FrontFacing ? 1.0 : 0.0;
        vec3 n = normalize(vN);
        n = mix(-n, n, front);

        // creases: drawn lines (folded edges read as outlines) + residual relief
        float line = 0.0;
        vec2 tilt = vec2(0.0);
        for (int i = 0; i < ${MAX_CREASES}; i++) {
          vec4 s = uCrease[i];
          vec2 a = s.xy, b = s.zw;
          vec2 ba = b - a, pa = f - a;
          float h = clamp(dot(pa, ba) / max(dot(ba, ba), 1e-6), 0.0, 1.0);
          vec2 q = pa - ba * h;
          float d = length(q);
          line = max(line, uCreaseW[i] * (1.0 - smoothstep(0.55 * px, 1.35 * px, d)));
          vec2 perp = normalize(vec2(-ba.y, ba.x));
          float sd = sign(dot(pa, perp));
          tilt += perp * sd * uCreaseR[i] * exp(-d / 0.16) * step(h, 0.999) * step(0.001, h);
        }
        vec3 tw = uSheetRot * vec3(tilt * 0.22 * uRelief, 0.0);
        n = normalize(n + tw * front);

        // the sheet's own edge, a crisp printed rule
        vec2 e2 = vec2(${(SHEET_W / 2).toFixed(2)}, ${(SHEET_H / 2).toFixed(2)}) - abs(f);
        float edge = min(e2.x, e2.y);
        float rim = 1.0 - smoothstep(0.7 * px, 1.6 * px, edge);

        float ndl = dot(n, normalize(uLight));
        float shade = (1.0 - smoothstep(0.08, 0.83, ndl)) * uShade;

        vec3 screened = mix(sB, sA, front);
        vec3 crisp = sAc * front;
        // postmark: rubber-stamp ink, uneven and a touch starved
        float starve = ctNoise(vUv * vec2(260.0, 173.0)) * 0.55 + ctNoise(vUv * 40.0) * 0.45;
        float pmk = pm.r * inPost * front * uPostmark * smoothstep(0.18, 0.62, starve + uPostmark * 0.35);
        crisp.r = max(crisp.r, pmk * 0.95);

        vec3 d = max(screened, crisp);
        d.b = max(d.b, uTone) + shade;
        d.g = max(d.g, uGreen);
        float lineInk = max(line, rim * uLine);
        d.b = max(d.b, lineInk);
        float crispMask = max(max(max(crisp.r, crisp.g), crisp.b), lineInk);
        float ht = 1.0 - step(0.06, crispMask);
        gl_FragColor = vec4(d, ht);
      }
    `,
  })
}

/**
 * Planar halftone shadow: the geometry flattened onto the table along the
 * light. `lift` pretends the object is a little higher than it is (the
 * hard offset shadow a paste-up casts).
 */
export function shadowMaterial(u: { uCurl: THREE.IUniform<THREE.Vector4> }, card: boolean) {
  return new THREE.ShaderMaterial({
    defines: card ? { CARD: '' } : {},
    uniforms: {
      uCurl: u.uCurl,
      uLightW: { value: new THREE.Vector3(-0.55, 1, -0.42) },
      uLift: { value: 0.1 },
      uTableY: { value: 0.0015 },
      uStrength: { value: 0.42 },
      uFade: { value: 2.5 },
    },
    vertexShader: /* glsl */ `
      ${SHEET_VERTEX_HEAD}
      uniform vec3 uLightW;
      uniform float uLift, uTableY;
      varying float vH;
      void main() {
        vec3 n;
        vec3 p = sheetPos(n);
        vUv = uv;
        vFlat = vec2(0.0);
        vec4 w = modelMatrix * vec4(p, 1.0);
        float hgt = max(0.0, w.y - uTableY) + uLift;
        w.xz -= uLightW.xz / uLightW.y * hgt;
        w.y = uTableY;
        vH = hgt;
        gl_Position = projectionMatrix * viewMatrix * w;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform float uStrength, uFade;
      varying float vH;
      void main() {
        float s = uStrength / (1.0 + vH * uFade);
        gl_FragColor = vec4(0.0, 0.0, s, 1.0);
      }
    `,
    side: THREE.DoubleSide,
    depthWrite: false,
    toneMapped: false,
    blending: THREE.CustomBlending,
    blendEquation: THREE.MaxEquation,
    blendEquationAlpha: THREE.AddEquation,
    blendSrcAlpha: THREE.ZeroFactor,
    blendDstAlpha: THREE.OneFactor,
  })
}

/** Plain planar shadow for arbitrary meshes (the rubber stamp). */
export function blockShadowMaterial() {
  return new THREE.ShaderMaterial({
    uniforms: {
      uLightW: { value: new THREE.Vector3(-0.55, 1, -0.42) },
      uTableY: { value: 0.012 },
      uStrength: { value: 0.5 },
      uFade: { value: 0.9 },
    },
    vertexShader: /* glsl */ `
      uniform vec3 uLightW;
      uniform float uTableY;
      varying float vH;
      void main() {
        vec4 w = modelMatrix * vec4(position, 1.0);
        float hgt = max(0.0, w.y - uTableY);
        w.xz -= uLightW.xz / uLightW.y * hgt;
        w.y = uTableY;
        vH = hgt;
        gl_Position = projectionMatrix * viewMatrix * w;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform float uStrength, uFade;
      varying float vH;
      void main() { gl_FragColor = vec4(0.0, 0.0, uStrength / (1.0 + vH * uFade), 1.0); }
    `,
    depthWrite: false,
    depthTest: false,
    toneMapped: false,
    blending: THREE.CustomBlending,
    blendEquation: THREE.MaxEquation,
    blendEquationAlpha: THREE.AddEquation,
    blendSrcAlpha: THREE.ZeroFactor,
    blendDstAlpha: THREE.OneFactor,
  })
}

/**
 * A fluorescent-pink self-healing cutting mat (The Fold's was green; this is
 * the mailroom desk): a rounded rect of screened ink with knocked-out grid
 * lines, black ruler ticks along two edges, and a hard offset shadow. Geometry is a unit plane (XY) scaled to (w + pad, h + pad).
 */
export function matMaterial() {
  return new THREE.ShaderMaterial({
    uniforms: {
      uSize: { value: new THREE.Vector2(4, 3) },
      uPad: { value: 0.3 },
      uRadius: { value: 0.16 },
      uDensity: { value: 0.8 },
      uInk: { value: new THREE.Vector3(1, 0, 0) },
      uShadow: { value: new THREE.Vector2(0.06, -0.06) },
      uUnit: { value: 0.5 },
      uReveal: { value: 1 },
    },
    vertexShader: /* glsl */ `
      varying vec2 vUv;
      void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
    `,
    fragmentShader: /* glsl */ `
      uniform vec2 uSize, uShadow;
      uniform float uPad, uRadius, uDensity, uUnit, uReveal;
      uniform vec3 uInk;
      varying vec2 vUv;
      float rbox(vec2 p, vec2 b, float r) { vec2 q = abs(p) - b + r; return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r; }
      float gridLine(float x, float fw, float period, float w) {
        float g = abs(fract(x / period + 0.5) - 0.5) * period;
        return 1.0 - smoothstep(w * 0.5, w * 0.5 + fw * 0.9, g);
      }
      void main() {
        vec2 full = uSize + 2.0 * uPad;
        vec2 p = (vUv - 0.5) * full;            // centred, world units, y = away from camera (screen up)
        // derivatives first: nothing below may take them after the discard
        vec2 fw = max(fwidth(p), vec2(1e-5));
        float px = fw.x;
        float dMat = rbox(p, uSize * 0.5, uRadius);
        float dSh = rbox(p - uShadow, uSize * 0.5, uRadius);
        float inMat = 1.0 - smoothstep(-0.5 * px, 0.5 * px, dMat);
        float inSh = (1.0 - smoothstep(-0.5 * px, 0.5 * px, dSh)) * (1.0 - inMat);
        if (inMat + inSh < 0.001) discard;

        // mat coords from its top-left corner (x right, y down), in world units
        vec2 m = vec2(p.x + uSize.x * 0.5, uSize.y * 0.5 - p.y);
        float u = uUnit;
        float minor = gridLine(m.x, fw.x, u * 0.5, px * 0.8) + gridLine(m.y, fw.y, u * 0.5, px * 0.8);
        float major = gridLine(m.x, fw.x, u, px * 1.6) + gridLine(m.y, fw.y, u, px * 1.6);
        // a 45° guide from the bottom-left corner
        float diag = abs((m.x - (uSize.y - m.y))) * 0.7071;
        float guide = 1.0 - smoothstep(px * 0.6, px * 1.5, diag);
        // inner border
        vec2 bm = min(m, uSize - m);
        float border = 1.0 - smoothstep(px * 0.6, px * 1.6, abs(min(bm.x, bm.y) - u * 0.5));
        float inside = step(u * 0.5, min(bm.x, bm.y));
        float knock = clamp(max(major * 0.9, max(minor * 0.45, max(guide * 0.8, border))) * inside, 0.0, 1.0);

        // black ruler ticks along the top and left margins
        float tx = gridLine(m.x, fw.x, u * 0.25, px * 1.1) * step(m.y, u * (0.18 + 0.14 * gridLine(m.x, fw.x, u, px * 1.1)));
        float ty = gridLine(m.y, fw.y, u * 0.25, px * 1.1) * step(m.x, u * (0.18 + 0.14 * gridLine(m.y, fw.y, u, px * 1.1)));
        float ticks = clamp(tx + ty, 0.0, 1.0) * step(u * 0.25, min(m.x, m.y) + u * 0.25) * inMat;

        float fill = uDensity * inMat * (1.0 - knock) * uReveal;
        float black = max(ticks * 0.9, inSh * 0.3) * uReveal;
        float ht = 1.0 - step(0.5, ticks);
        vec3 d = uInk * fill;
        d.b = max(d.b, black);
        gl_FragColor = vec4(d, ht);
      }
    `,
    depthWrite: true,
    toneMapped: false,
  })
}

/** A rubber-stamp impression lying on the table (end of print run). */
export function impressionMaterial(map: THREE.Texture, ink: THREE.Vector3) {
  return new THREE.ShaderMaterial({
    uniforms: { uMap: { value: map }, uInk: { value: 0 }, uSeed: { value: 3 }, uColor: { value: ink } },
    vertexShader: /* glsl */ `
      varying vec2 vUv;
      void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
    `,
    fragmentShader: /* glsl */ `
      uniform sampler2D uMap;
      uniform float uInk, uSeed;
      uniform vec3 uColor;
      varying vec2 vUv;
      ${VALUE_NOISE}
      void main() {
        float t = texture2D(uMap, vUv).r;
        float starve = ctNoise(vUv * vec2(180.0, 60.0) + uSeed) * 0.55 + ctNoise(vUv * vec2(22.0, 8.0) + uSeed * 3.0) * 0.45;
        float k = t * uInk * smoothstep(0.08, 0.42, starve + uInk * 0.22);
        if (k < 0.01) discard;
        gl_FragColor = vec4(uColor * k * 0.95, 0.0);
      }
    `,
    depthWrite: false,
    depthTest: false,
    toneMapped: false,
    blending: THREE.CustomBlending,
    blendEquation: THREE.MaxEquation,
    blendEquationAlpha: THREE.AddEquation,
    blendSrcAlpha: THREE.ZeroFactor,
    blendDstAlpha: THREE.OneFactor,
  })
}
