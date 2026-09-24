import * as THREE from 'three'
import { SEPARATE_GLSL } from '../../print/ink'

/*
 * Paper for the PASTE-UP wall. Everything outputs ink densities
 * (pink, green, black, halftone) — see src/core/post.ts.
 *
 *  paperMaterial   a sheet that can be slapped on and brushed flat
 *                  (pressed line + loose, bowing tail), wrinkled, have a
 *                  corner curl, and be peeled off in a page curl. It prints a
 *                  canvas of ink plus an optional screenshot through a 3-ink
 *                  separation (overprinted). Shade adds black; the back of
 *                  the sheet is bare paper with a little show-through.
 *  wallMaterial    the plywood hoarding: panel seams, grain, bolts, grime.
 *  oldMaterial     instanced faded, torn posters from earlier runs.
 *  flyerMaterial   instanced stapled flyers that flutter.
 *  shadowMaterial  ADDS black ink under lifted paper (keeps the halftone flag).
 */

const NOISE = /* glsl */ `
float h12(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * .1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
float vn(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(h12(i), h12(i + vec2(1.0, 0.0)), u.x), mix(h12(i + vec2(0.0, 1.0)), h12(i + vec2(1.0, 1.0)), u.x), u.y);
}
float fbm(vec2 p) {
  float a = 0.5, s = 0.0;
  for (int i = 0; i < 3; i++) { s += a * vn(p); p = p * 2.03 + 17.1; a *= 0.5; }
  return s * 1.143;
}
`

/** Page-curl around a cylinder of radius r; u points at the free edge, c is the fold line. */
const CURL = /* glsl */ `
vec3 curlAt(vec3 P, vec2 u, float c, float r) {
  float s = dot(P.xy, u) - c;
  if (s <= 0.0) return P;
  vec2 base = P.xy - u * s;
  float th = s / r;
  if (th < 3.14159265) {
    vec3 n = vec3(-u * sin(th), cos(th));
    return vec3(base + u * (r * sin(th)), r * (1.0 - cos(th))) + n * P.z;
  }
  return vec3(base - u * (s - 3.14159265 * r), 2.0 * r - P.z);
}
`

const LIGHT = new THREE.Vector3(-0.5, 0.75, 0.45).normalize()

export interface PaperUniforms {
  uMap: { value: THREE.Texture | null }
  uMapRect: { value: THREE.Vector4 }
  uShot: { value: THREE.Texture | null }
  uShotRect: { value: THREE.Vector4 }
  uHasShot: { value: number }
  uShotHt: { value: number }
  uShotGain: { value: number }
  uMono: { value: THREE.Vector4 }
  uSize: { value: THREE.Vector2 }
  uPress: { value: number }
  uHang: { value: number }
  uSwing: { value: number }
  uWrinkle: { value: number }
  uSeed: { value: number }
  uBoil: { value: number }
  uCurl: { value: number }
  uCurlDir: { value: THREE.Vector2 }
  uPeel: { value: number }
  uPeelR: { value: number }
  uPeelDir: { value: THREE.Vector2 }
  uScreen: { value: number }
  uDist: { value: number }
  /** camera-space xy offset for screen sheets */
  uOffset: { value: THREE.Vector2 }
  uInk: { value: THREE.Vector3 }
  uTone: { value: number }
  uWet: { value: number }
  uHt: { value: number }
  uEdge: { value: number }
  /** how much the sheet's folds shade (1 = full) */
  uShade: { value: number }
  uLight: { value: THREE.Vector3 }
}

export function paperMaterial(map: THREE.Texture | null, size: [number, number]) {
  const uniforms: PaperUniforms = {
    uMap: { value: map },
    uMapRect: { value: new THREE.Vector4(0, 0, 1, 1) },
    uShot: { value: null },
    uShotRect: { value: new THREE.Vector4(0, 0, 1, 1) },
    uHasShot: { value: 0 },
    uShotHt: { value: 1 },
    uShotGain: { value: 1 },
    uMono: { value: new THREE.Vector4(0, 0, 0, 0) },
    uSize: { value: new THREE.Vector2(...size) },
    uPress: { value: 1 },
    uHang: { value: 0 },
    uSwing: { value: 0 },
    uWrinkle: { value: 0.01 },
    uSeed: { value: Math.random() * 10 },
    uBoil: { value: 0 },
    uCurl: { value: 0 },
    uCurlDir: { value: new THREE.Vector2(1, -1).normalize() },
    uPeel: { value: 0 },
    uPeelR: { value: 0.3 },
    uPeelDir: { value: new THREE.Vector2(1, -1).normalize() },
    uScreen: { value: 0 },
    uDist: { value: 1 },
    uOffset: { value: new THREE.Vector2() },
    uInk: { value: new THREE.Vector3(1, 1, 1) },
    uTone: { value: 0.03 },
    uWet: { value: 0 },
    uHt: { value: 1 },
    uEdge: { value: 0.55 },
    uShade: { value: 1 },
    uLight: { value: LIGHT.clone() },
  }
  const material = new THREE.ShaderMaterial({
    uniforms: uniforms as unknown as Record<string, THREE.IUniform>,
    side: THREE.DoubleSide,
    toneMapped: false,
    vertexShader: /* glsl */ `
      uniform vec2 uSize, uCurlDir, uPeelDir, uOffset;
      uniform float uPress, uHang, uSwing, uWrinkle, uSeed, uBoil, uCurl, uPeel, uPeelR, uScreen, uDist;
      varying vec2 vUv;
      varying vec3 vN;
      varying vec3 vRest;
      varying float vLoose;
      ${NOISE}
      ${CURL}
      vec3 deform(vec2 p) {
        vec3 P = vec3(p, 0.0);
        vec2 uv = p / uSize + 0.5;
        float yP = uSize.y * (0.5 - uPress);
        float d = max(yP - p.y, 0.0);
        float xn = p.x / uSize.x;
        // the loose tail bows off the wall, cupped, and swings
        P.z += uHang * d * d + uHang * d * xn * xn * 1.4 + uSwing * d * (0.7 + xn);
        // creases (ridged) + bubbles, strongest in the tail and at the brush line
        vec2 q = uv * vec2(2.4, 3.2) + vec2(uSeed, uSeed * 1.7) + uBoil;
        float cr = 1.0 - abs(vn(q) * 2.0 - 1.0);
        cr *= cr;
        float bub = vn(q * 2.1 + 7.3);
        float line = exp(-abs(p.y - yP) * 3.5) * step(0.001, uPress) * step(uPress, 0.999);
        P.z += uWrinkle * (cr * 0.75 + bub * 0.45) * (1.0 + line * 1.6 + min(d, 1.2) * 2.2);
        if (uCurl > 0.0005) {
          vec2 u = normalize(uCurlDir);
          float cmax = dot(abs(u), uSize * 0.5);
          P = curlAt(P, u, cmax - uCurl, max(0.035, uCurl * 0.42));
        }
        if (uPeel > 0.0005) {
          vec2 u = normalize(uPeelDir);
          float cmax = dot(abs(u), uSize * 0.5);
          P = curlAt(P, u, mix(cmax, -cmax - 3.14159265 * uPeelR, uPeel), uPeelR);
        }
        return P;
      }
      void main() {
        vec2 p = (uv - 0.5) * uSize;
        vec3 P = deform(p);
        float e = max(uSize.x, uSize.y) * 0.004;
        vec3 Px = deform(p + vec2(e, 0.0));
        vec3 Py = deform(p + vec2(0.0, e));
        vec3 n = normalize(cross(Px - P, Py - P));
        vUv = uv;
        vLoose = clamp(P.z, 0.0, 1.0);
        if (uScreen > 0.5) {
          vN = n;
          vRest = vec3(0.0, 0.0, 1.0);
          gl_Position = projectionMatrix * vec4(P.xy + uOffset, P.z - uDist, 1.0);
        } else {
          vN = normalize(mat3(modelMatrix) * n);
          vRest = normalize(mat3(modelMatrix) * vec3(0.0, 0.0, 1.0));
          gl_Position = projectionMatrix * viewMatrix * modelMatrix * vec4(P, 1.0);
        }
      }
    `,
    fragmentShader: /* glsl */ `
      uniform sampler2D uMap, uShot;
      uniform vec4 uMapRect, uShotRect, uMono;
      uniform float uHasShot, uShotHt, uShotGain, uTone, uWet, uHt, uEdge, uSeed, uShade;
      uniform vec3 uInk, uLight;
      varying vec2 vUv;
      varying vec3 vN;
      varying vec3 vRest;
      varying float vLoose;
      ${NOISE}
      ${SEPARATE_GLSL}
      void main() {
        vec2 uv = vUv;
        vec2 fw = max(fwidth(uv), vec2(1e-5));
        vec3 n = normalize(vN);
        vec3 rest = normalize(vRest);
        float front = gl_FrontFacing ? 1.0 : 0.0;
        if (front < 0.5) { n = -n; rest = -rest; }
        vec3 L = normalize(uLight);
        float dl = dot(n, L) - dot(rest, L);
        float shade = clamp(-dl * 1.7, 0.0, 1.0) * uShade;
        float hl = clamp(dl * 1.4, 0.0, 1.0) * uShade;

        vec3 ink = texture2D(uMap, uMapRect.xy + uv * uMapRect.zw).rgb;
        vec2 s = (uv - uShotRect.xy) / max(uShotRect.zw - uShotRect.xy, vec2(1e-4));
        vec3 c = texture2D(uShot, clamp(s, 0.0, 1.0)).rgb;
        c *= c;
        float inside = uHasShot * step(0.0, s.x) * step(s.x, 1.0) * step(0.0, s.y) * step(s.y, 1.0);
        vec3 sep = separate(c);
        float dark = 1.0 - sqrt(dot(c, vec3(0.2126, 0.7152, 0.0722)));
        sep = mix(sep, uMono.rgb * dark * 1.15, uMono.a);
        ink = min(ink + sep * uShotGain * inside, vec3(1.0));
        float ht = mix(uHt, uShotHt, inside);

        vec3 d = mix(ink * 0.07, ink * uInk, front);
        d.b += uTone;
        d *= 1.0 - hl * 0.3;
        d.b += shade * 0.62;
        d.r += shade * 0.05;
        // wet paste soaks the newsprint in brush streaks
        float streak = vn(vec2(uv.x * 1.5 + uv.y * 0.5 + uSeed, uv.y * 26.0));
        d.b += uWet * front * (0.035 + 0.08 * streak * streak);
        // hairline paper edge so bare sheets separate from the wall
        vec2 ed = min(uv, 1.0 - uv) / fw;
        float edge = (1.0 - smoothstep(0.6, 1.8, min(ed.x, ed.y))) * uEdge;
        d.b = max(d.b, edge);
        ht = mix(ht, 0.0, step(0.02, edge));
        gl_FragColor = vec4(max(d, 0.0), ht);
      }
    `,
  })
  return { material, uniforms }
}

/** The plywood hoarding. */
export function wallMaterial() {
  return new THREE.ShaderMaterial({
    toneMapped: false,
    uniforms: { uPanel: { value: 4.4 }, uBase: { value: -4.8 } },
    vertexShader: /* glsl */ `
      varying vec3 vW;
      void main() {
        vec4 w = modelMatrix * vec4(position, 1.0);
        vW = w.xyz;
        gl_Position = projectionMatrix * viewMatrix * w;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform float uPanel, uBase;
      varying vec3 vW;
      ${NOISE}
      void main() {
        vec2 p = vW.xy;
        vec2 fw = max(fwidth(p), vec2(1e-5));
        float id = floor(p.x / uPanel);
        float px = p.x - id * uPanel;
        float seam = min(px, uPanel - px);
        float seamLine = 1.0 - smoothstep(0.02, 0.02 + fw.x * 1.5, seam);
        float gap = 1.0 - smoothstep(0.0, 0.06, seam);
        // grain runs vertically on each panel
        vec2 gp = vec2(px * 5.0 + id * 31.0, p.y * 0.22);
        float g = fbm(gp + vec2(vn(gp * 0.7) * 1.8, 0.0));
        float rings = abs(fract(g * 5.0) - 0.5) * 2.0;
        float grain = smoothstep(0.55, 1.0, rings) * 0.55 + g * 0.45;
        vec3 d = vec3(0.1, 0.07, 0.07) + vec3(0.06, 0.03, 0.1) * grain;
        d.b += gap * 0.16;
        d.b = max(d.b, seamLine * 0.85);
        // bolt heads beside each seam
        vec2 b = vec2(seam - 0.16, mod(p.y + 0.2, 1.3) - 0.65);
        float bolt = 1.0 - smoothstep(0.035, 0.035 + fw.x * 1.5, length(b));
        d.b = max(d.b, bolt * 0.9);
        // grime creeping up from the pavement
        float grime = smoothstep(uBase + 2.2, uBase, p.y) * (0.5 + 0.5 * vn(p * vec2(2.0, 5.0)));
        d.b += grime * 0.22;
        // top rail
        float ht = 1.0 - seamLine * 0.8 - bolt * 0.8;
        gl_FragColor = vec4(d, clamp(ht, 0.0, 1.0));
      }
    `,
  })
}

/**
 * Instanced torn posters. Per instance (aData): atlas cell, seed, fade,
 * tear mode (0 intact, 1 bottom ripped away, 2 corner ripped, 3 band ripped).
 */
export function oldMaterial(atlas: THREE.Texture, cols: number, rows: number) {
  return new THREE.ShaderMaterial({
    toneMapped: false,
    uniforms: { uAtlas: { value: atlas }, uGrid: { value: new THREE.Vector2(cols, rows) }, uFade: { value: 1 } },
    vertexShader: /* glsl */ `
      attribute vec4 aData;
      varying vec2 vUv;
      varying vec4 vData;
      void main() {
        vUv = uv;
        vData = aData;
        gl_Position = projectionMatrix * viewMatrix * modelMatrix * instanceMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      uniform sampler2D uAtlas;
      uniform vec2 uGrid;
      uniform float uFade;
      varying vec2 vUv;
      varying vec4 vData;
      ${NOISE}
      void main() {
        vec2 uv = vUv;
        float cell = vData.x, seed = vData.y, mode = vData.w;
        vec2 cr = vec2(mod(cell, uGrid.x), floor(cell / uGrid.x));
        vec2 auv = vec2((cr.x + uv.x) / uGrid.x, (uGrid.y - cr.y - 1.0 + uv.y) / uGrid.y);
        vec3 ink = texture2D(uAtlas, auv).rgb;
        float n1 = fbm(vec2(uv.x * 7.0 + seed * 3.1, seed));
        float n2 = vn(vec2(uv.y * 9.0 + seed * 1.7, seed * 2.3));
        float jag = (h12(floor(uv * 90.0) + seed) - 0.5) * 0.012;
        float keep = 1.0;
        if (mode > 0.5 && mode < 1.5) keep = uv.y - (0.18 + fract(seed * 7.31) * 0.35 + (n1 - 0.5) * 0.3) + jag;
        else if (mode > 1.5 && mode < 2.5) keep = (uv.x + (1.0 - uv.y)) * 0.7 - (0.9 + fract(seed * 3.7) * 0.25 + (n1 - 0.5) * 0.25) + jag;
        else if (mode > 2.5) keep = abs(uv.y - (0.35 + fract(seed * 5.3) * 0.3) + (n1 - 0.5) * 0.16) - (0.05 + fract(seed * 9.1) * 0.1) + jag;
        float edgeWear = min(min(uv.x, 1.0 - uv.x), min(uv.y, 1.0 - uv.y)) - 0.012 * n2 + jag * 0.4;
        keep = min(keep, edgeWear);
        if (keep < 0.0) discard;
        // torn edge: white fibre, no ink
        float core = 1.0 - smoothstep(0.004, 0.016, keep);
        vec3 d = ink * vData.z * uFade * (1.0 - core);
        // weather: water streaks + dirt
        float wx = vn(vec2(uv.x * 14.0 + seed, uv.y * 1.2));
        d *= 0.8 + 0.2 * wx;
        d.b += 0.03 + 0.05 * smoothstep(0.55, 0.9, vn(uv * vec2(3.0, 6.0) + seed)) + core * 0.05;
        gl_FragColor = vec4(d, 1.0);
      }
    `,
  })
}

/**
 * Stapled flyers (instanced). aData: cell, seed, lift (bottom edge off the
 * board), print (0..1 ink). The photo window of every cell is printed through
 * a 3-ink separation; everything else is ink.
 */
export function flyerMaterial(atlas: THREE.Texture, cols: number, rows: number, shot: THREE.Vector4, size: [number, number]) {
  return new THREE.ShaderMaterial({
    toneMapped: false,
    side: THREE.DoubleSide,
    uniforms: {
      uAtlas: { value: atlas },
      uGrid: { value: new THREE.Vector2(cols, rows) },
      uShotRect: { value: shot },
      uSize: { value: new THREE.Vector2(...size) },
      uTime: { value: 0 },
      uLight: { value: LIGHT.clone() },
    },
    vertexShader: /* glsl */ `
      attribute vec4 aData;
      uniform vec2 uSize;
      uniform float uTime;
      varying vec2 vUv;
      varying vec4 vData;
      varying vec3 vN;
      vec3 bend(vec2 uv) {
        float t = 1.0 - uv.y;
        float lift = vData.z;
        float flutter = sin(uTime * 2.1 + vData.y * 6.0 + uv.x * 2.2) * 0.5 + 0.5;
        float z = t * t * (lift * 0.9 + 0.05 + flutter * 0.05) + t * sin(uv.x * 3.14159) * lift * 0.12;
        return vec3((uv - 0.5) * uSize, z);
      }
      void main() {
        vUv = uv;
        vData = aData;
        vec3 P = bend(uv);
        vec3 Px = bend(uv + vec2(0.01, 0.0));
        vec3 Py = bend(uv + vec2(0.0, 0.01));
        vN = normalize(mat3(modelMatrix) * mat3(instanceMatrix) * cross(Px - P, Py - P));
        gl_Position = projectionMatrix * viewMatrix * modelMatrix * instanceMatrix * vec4(P, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      uniform sampler2D uAtlas;
      uniform vec2 uGrid;
      uniform vec4 uShotRect;
      uniform vec3 uLight;
      varying vec2 vUv;
      varying vec4 vData;
      varying vec3 vN;
      ${SEPARATE_GLSL}
      void main() {
        vec2 uv = vUv;
        float cell = vData.x;
        vec2 cr = vec2(mod(cell, uGrid.x), floor(cell / uGrid.x));
        vec2 auv = vec2((cr.x + uv.x) / uGrid.x, (uGrid.y - cr.y - 1.0 + uv.y) / uGrid.y);
        vec3 t = texture2D(uAtlas, auv).rgb;
        float inside = step(uShotRect.x, uv.x) * step(uv.x, uShotRect.z) * step(uShotRect.y, uv.y) * step(uv.y, uShotRect.w);
        vec3 photo = separate(t * t);
        vec3 ink = mix(t, photo, inside);
        vec3 n = normalize(vN);
        float front = gl_FrontFacing ? 1.0 : 0.0;
        if (front < 0.5) n = -n;
        float dl = dot(n, normalize(uLight)) - dot(vec3(0.0, 0.0, 1.0), normalize(uLight));
        float shade = clamp(-dl * 1.8, 0.0, 1.0);
        vec3 d = mix(ink * 0.07, ink * vData.w, front);
        d.b += 0.025 + shade * 0.6;
        gl_FragColor = vec4(d, 1.0);
      }
    `,
  })
}

/**
 * Additive shadow under a sheet that's lifting off the wall. Draw it on the
 * wall just behind the sheet. Ink adds; the halftone flag underneath is kept.
 */
export interface ShadowUniforms {
  uSize: { value: THREE.Vector2 }
  uPress: { value: number }
  uHang: { value: number }
  uFly: { value: number }
  uCurl: { value: number }
  uStrength: { value: number }
}
export function shadowMaterial(size: [number, number]) {
  const uniforms: ShadowUniforms = {
    uSize: { value: new THREE.Vector2(...size) },
    uPress: { value: 1 },
    uHang: { value: 0 },
    uFly: { value: 0 },
    uCurl: { value: 0 },
    uStrength: { value: 0.5 },
  }
  const material = new THREE.ShaderMaterial({
    uniforms: uniforms as unknown as Record<string, THREE.IUniform>,
    toneMapped: false,
    transparent: true,
    depthWrite: false,
    blending: THREE.CustomBlending,
    blendEquation: THREE.AddEquation,
    blendSrc: THREE.OneFactor,
    blendDst: THREE.OneFactor,
    blendEquationAlpha: THREE.AddEquation,
    blendSrcAlpha: THREE.ZeroFactor,
    blendDstAlpha: THREE.OneFactor,
    vertexShader: /* glsl */ `
      varying vec2 vP;
      void main() {
        vP = position.xy;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      uniform vec2 uSize;
      uniform float uPress, uHang, uFly, uCurl, uStrength;
      varying vec2 vP;
      float box(vec2 p, vec2 b, float soft) {
        vec2 q = abs(p) - b;
        float sd = length(max(q, 0.0)) + min(max(q.x, q.y), 0.0);
        return 1.0 - smoothstep(-soft, soft, sd);
      }
      void main() {
        vec2 p = vP;
        vec2 half_ = uSize * 0.5;
        // the sheet in flight: one soft offset blob
        float fly = box(p - vec2(0.35, -0.45) * uFly * 1.4, half_, 0.08 + uFly * 0.45) * uFly * 0.75;
        // the loose tail: lift grows with distance below the pressed line
        float yP = half_.y - uPress * uSize.y;
        float d = max(yP - p.y + 0.0, 0.0);
        float lift = uHang * d * d;
        float tail = box(p - vec2(0.3, -0.35) * lift, half_, 0.03 + lift * 0.35) * smoothstep(0.0, 0.25, lift) * (1.0 - uFly);
        tail *= step(p.y, yP + 0.05);
        // under a curled corner
        vec2 u = normalize(vec2(1.0, -1.0));
        float cmax = dot(abs(u), half_);
        float cs = dot(p, u) - (cmax - uCurl * 1.15);
        float corner = smoothstep(0.0, 0.08, cs) * box(p - vec2(0.03, -0.05), half_ + 0.04, 0.05) * step(0.001, uCurl) * 0.8;
        float a = max(fly, max(tail, corner)) * uStrength;
        if (a < 0.003) discard;
        gl_FragColor = vec4(0.0, 0.0, a, 0.0);
      }
    `,
  })
  return { material, uniforms }
}
