import * as THREE from 'three'

/*
 * The page as N paper strips (one InstancedMesh). Each strip is a ribbon
 * bent in the vertex shader from a handful of per-strip pose numbers, so the
 * same geometry can be a flat page, strips curling out of the shredder,
 * strips tumbling through the air, or strips lying scattered on the table.
 *
 * Ribbon model (s = distance from the root, which is the page's TOP edge):
 *   flat until sFlat, then elevation θ(e) = pitch + kUp·e + ½·kGrow·e² + wave·sin(f·e + φ)
 *   and heading ψ(e) = yaw + kSide·e (e = s − sFlat); roll = roll0 + twist·s.
 * The centreline is integrated in a fixed 24-step loop.
 */

export interface StripPose {
  x: number
  y: number
  z: number
  yaw: number
  pitch: number
  kUp: number
  kSide: number
  twist: number
  roll: number
  sFlat: number
  kGrow: number
  seam: number
  wave: number
  phase: number
  breach: number
  sCut: number
  /** in-plane bend along the whole length (a strip lying in an arc) */
  kBend: number
}

export const newPose = (): StripPose => ({
  x: 0, y: 0, z: 0, yaw: 0, pitch: 0, kUp: 0, kSide: 0, twist: 0, roll: 0,
  sFlat: 0, kGrow: 0, seam: 0, wave: 0, phase: 0, breach: 0, sCut: -1, kBend: 0,
})

export interface RestPose {
  x: number
  z: number
  yaw: number
  sFlat: number
  flip: boolean
  kBend: number
}

/** light the whole chapter is lit from (world direction the light comes FROM) */
export const LIGHT = new THREE.Vector3(-0.42, 0.82, 0.4).normalize()

const RIBBON = /* glsl */ `
attribute vec4 iA; // root.xyz, yaw
attribute vec4 iB; // pitch, kUp, kSide, twist
attribute vec4 iC; // roll, sFlat, kGrow, seam
attribute vec4 iD; // wave, phase, breach, sCut
attribute vec4 iR; // rest root.x, rest root.z, rest yaw, ±rest sFlat (negative = face down)
attribute vec4 iE; // index, kBend, rest kBend, -
uniform float uLen, uWid, uWaveF;

float thetaAt(float e) {
  return iB.x + iB.y * e + 0.5 * iC.z * e * e + iD.x * sin(e * uWaveF + iD.y) * min(e * 1.5, 1.0);
}

// centreline point, tangent frame and the vertex position
vec3 ribbon(float s, float q, out vec3 N) {
  float sFlat = iC.y;
  float ds = s / 24.0;
  vec3 p = iA.xyz;
  for (int k = 0; k < 24; k++) {
    float sm = (float(k) + 0.5) * ds;
    float e = max(sm - sFlat, 0.0);
    float on = step(sFlat, sm);
    float th = on * thetaAt(e);
    float ps = iA.w + iE.y * sm + iB.z * e;
    p += ds * vec3(cos(th) * sin(ps), sin(th), cos(th) * cos(ps));
  }
  float e = max(s - sFlat, 0.0);
  float th = step(sFlat, s) * thetaAt(e);
  float ps = iA.w + iE.y * s + iB.z * e;
  vec3 H = vec3(sin(ps), 0.0, cos(ps));
  vec3 S = vec3(cos(ps), 0.0, -sin(ps));
  vec3 T = cos(th) * H + vec3(0.0, sin(th), 0.0);
  vec3 N0 = cross(T, S);
  float r = iC.x + iB.w * s;
  vec3 W = cos(r) * S + sin(r) * N0;
  N = cos(r) * N0 - sin(r) * S;
  return p + (q - 0.5) * uWid * W;
}
`

const VERT = /* glsl */ `
${RIBBON}
uniform float uFloor;
varying vec2 vQS;
varying vec3 vN;
varying vec2 vRest;
varying float vRestOK;
varying float vRestFlip;
varying float vSeam;
varying float vBreach;
varying float vIdx;
varying float vCut;
void main() {
  float q = uv.x;
  float s01 = 1.0 - uv.y;
  float s = s01 * uLen;
  vec3 N;
  vec3 pos = ribbon(s, q, N);
  // paper can't go through the table: it lies flat where it would dip below
  float iIdx = iE.x;
  pos.y = max(pos.y, uFloor + iIdx * 0.0012);
  vN = N;
  vQS = vec2(q, s01);
  vSeam = iC.w;
  vBreach = iD.z;
  vIdx = iIdx;
  vCut = s - iD.w;
  // where this point lay when the strip rested on the table (for the BREACH stamps)
  float ry = iR.z;
  float flip = step(iR.w, 0.0);
  // the rest centreline is an arc of curvature iE.z
  float kb = iE.z;
  float kbs = abs(kb) < 1e-4 ? 1e-4 : kb;
  float pr = ry + kbs * s;
  vec2 cl = vec2(cos(ry) - cos(pr), sin(pr) - sin(ry)) / kbs;
  vec2 Sr = vec2(cos(pr), -sin(pr)) * (1.0 - 2.0 * flip);
  vRest = iR.xy + cl + (q - 0.5) * uWid * Sr;
  vRestOK = 1.0 - smoothstep(abs(iR.w) - 0.15, abs(iR.w), s);
  vRestFlip = flip;
  gl_Position = projectionMatrix * viewMatrix * vec4(pos, 1.0);
}
`

const FRAG = /* glsl */ `
uniform sampler2D uPrint, uLine, uStamp;
uniform vec4 uSt[3];
uniform vec2 uStHalf;
uniform vec3 uLight;
uniform float uN, uLineW;
varying vec2 vQS;
varying vec3 vN;
varying vec2 vRest;
varying float vRestOK;
varying float vRestFlip;
varying float vSeam;
varying float vBreach;
varying float vIdx;
varying float vCut;

void main() {
  vec2 fw = fwidth(vQS);
  float q = vQS.x;
  float s = vQS.y;
  vec2 uv = vec2((vIdx + q) / uN, 1.0 - s);
  vec3 pr = texture2D(uPrint, uv).rgb;
  vec3 ln = texture2D(uLine, uv).rgb;

  // BREACH stamps, projected where this bit of paper rested
  float st = 0.0;
  for (int k = 0; k < 3; k++) {
    vec4 S = uSt[k];
    vec2 dl = vRest - S.xy;
    float c = cos(S.z), sn = sin(S.z);
    vec2 lc = vec2(c * dl.x + sn * dl.y, -sn * dl.x + c * dl.y);
    vec2 suv = lc / (uStHalf * 2.0) + 0.5;
    float inside = step(0.0, suv.x) * step(suv.x, 1.0) * step(0.0, suv.y) * step(suv.y, 1.0);
    float m = texture2D(uStamp, vec2(clamp(suv.x, 0.0, 1.0), 1.0 - clamp(suv.y, 0.0, 1.0))).r;
    st = max(st, m * inside * S.w);
  }
  st *= vBreach * vRestOK;

  bool front = gl_FrontFacing;
  vec3 n = normalize(vN) * (front ? 1.0 : -1.0);
  float ndl = dot(n, uLight);
  float shade = 1.0 - smoothstep(-0.3, 0.92, ndl);

  // cut edges (outer page edges always; inner edges only where cut)
  float cut = vSeam * step(0.0, vCut);
  float first = 1.0 - step(0.5, vIdx);
  float last = step(uN - 1.5, vIdx);
  float eL = 1.0 - smoothstep(0.0, fw.x * uLineW, q);
  float eR = 1.0 - smoothstep(0.0, fw.x * uLineW, 1.0 - q);
  float eT = 1.0 - smoothstep(0.0, fw.y * uLineW, s);
  float eB = 1.0 - smoothstep(0.0, fw.y * uLineW, 1.0 - s);
  float edge = max(max(eT, eB), max(eL * max(cut, first), eR * max(cut, last)));

  vec3 d;
  float crisp;
  float stampSide = front ? 1.0 - vRestFlip : vRestFlip;
  if (front) {
    d = max(pr, ln);
    crisp = step(0.06, max(ln.r, max(ln.g, ln.b)));
  } else {
    // bare back of the sheet: a faint tone and the print showing through
    d = vec3(0.0, 0.0, 0.045) + pr * 0.07 + ln * 0.1;
    crisp = 1.0;
  }
  d.r = max(d.r, st * stampSide * 0.92);
  d.b += shade * 0.62;
  float screened = max(1.0 - crisp, step(0.04, shade * 0.62));
  d.b = max(d.b, edge);
  screened *= 1.0 - edge;
  gl_FragColor = vec4(d, screened);
}
`

const SHADOW_VERT = /* glsl */ `
${RIBBON}
uniform vec3 uLight;
uniform float uLift;
varying float vH;
void main() {
  float q = uv.x;
  float s = (1.0 - uv.y) * uLen;
  vec3 N;
  vec3 pos = ribbon(s, q, N);
  float h = max(pos.y, 0.0) + uLift;
  vH = h;
  pos.xz -= uLight.xz / uLight.y * h;
  pos.y = 0.0015;
  gl_Position = projectionMatrix * viewMatrix * vec4(pos, 1.0);
}
`

const SHADOW_FRAG = /* glsl */ `
uniform float uStrength;
varying float vH;
void main() {
  // hard and dark while the paper lies close, pale once it's up in the air
  float a = uStrength * (1.0 - smoothstep(0.08, 1.2, vH) * 0.62);
  gl_FragColor = vec4(0.0, 0.0, a, 1.0);
}
`

export class Strips {
  readonly n: number
  readonly mesh: THREE.InstancedMesh
  readonly shadow: THREE.InstancedMesh
  readonly material: THREE.ShaderMaterial
  readonly shadowMaterial: THREE.ShaderMaterial
  private attrs: THREE.InstancedBufferAttribute[]
  private rest: THREE.InstancedBufferAttribute
  private extra: THREE.InstancedBufferAttribute

  constructor(n: number, pageW: number, pageH: number, print: THREE.Texture, line: THREE.Texture, stamp: THREE.Texture, stampHalf: THREE.Vector2) {
    this.n = n
    const geo = new THREE.PlaneGeometry(1, 1, 1, 64)
    const mk = () => new THREE.InstancedBufferAttribute(new Float32Array(n * 4), 4).setUsage(THREE.DynamicDrawUsage)
    this.attrs = [mk(), mk(), mk(), mk()]
    this.rest = new THREE.InstancedBufferAttribute(new Float32Array(n * 4), 4)
    this.extra = new THREE.InstancedBufferAttribute(new Float32Array(n * 4), 4).setUsage(THREE.DynamicDrawUsage)
    for (let i = 0; i < n; i++) (this.extra.array as Float32Array)[i * 4] = i
    geo.setAttribute('iA', this.attrs[0])
    geo.setAttribute('iB', this.attrs[1])
    geo.setAttribute('iC', this.attrs[2])
    geo.setAttribute('iD', this.attrs[3])
    geo.setAttribute('iR', this.rest)
    geo.setAttribute('iE', this.extra)

    const common = {
      uLen: { value: pageH },
      uWid: { value: pageW / n },
      uWaveF: { value: 3.2 },
    }
    this.material = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      side: THREE.DoubleSide,
      toneMapped: false,
      uniforms: {
        ...common,
        uFloor: { value: 0.004 },
        uPrint: { value: print },
        uLine: { value: line },
        uStamp: { value: stamp },
        uSt: { value: [new THREE.Vector4(), new THREE.Vector4(), new THREE.Vector4()] },
        uStHalf: { value: stampHalf },
        uLight: { value: LIGHT },
        uN: { value: n },
        uLineW: { value: 1.6 },
      },
    })
    this.shadowMaterial = new THREE.ShaderMaterial({
      vertexShader: SHADOW_VERT,
      fragmentShader: SHADOW_FRAG,
      side: THREE.DoubleSide,
      depthWrite: false,
      toneMapped: false,
      uniforms: {
        ...common,
        uLight: { value: LIGHT },
        uLift: { value: 0.045 },
        uStrength: { value: 0.3 },
      },
    })
    this.mesh = new THREE.InstancedMesh(geo, this.material, n)
    this.shadow = new THREE.InstancedMesh(geo, this.shadowMaterial, n)
    this.mesh.frustumCulled = false
    this.shadow.frustumCulled = false
    this.shadow.renderOrder = -2
    this.shadowMaterial.blending = THREE.CustomBlending
    this.shadowMaterial.blendEquation = THREE.AddEquation
    this.shadowMaterial.blendSrc = THREE.OneFactor
    this.shadowMaterial.blendDst = THREE.OneFactor
    this.shadowMaterial.blendSrcAlpha = THREE.OneFactor
    this.shadowMaterial.blendDstAlpha = THREE.ZeroFactor
    // instanceMatrix stays identity: the ribbon shader places everything in world space
    const id = new THREE.Matrix4()
    for (let i = 0; i < n; i++) {
      this.mesh.setMatrixAt(i, id)
      this.shadow.setMatrixAt(i, id)
    }
  }

  get stamps(): THREE.Vector4[] {
    return this.material.uniforms.uSt.value
  }

  setRest(rest: RestPose[]) {
    const a = this.rest.array as Float32Array
    rest.forEach((r, i) => {
      a[i * 4] = r.x
      a[i * 4 + 1] = r.z
      a[i * 4 + 2] = r.yaw
      a[i * 4 + 3] = (r.sFlat + 0.001) * (r.flip ? -1 : 1)
      ;(this.extra.array as Float32Array)[i * 4 + 2] = r.kBend
    })
    this.rest.needsUpdate = true
    this.extra.needsUpdate = true
  }

  write(poses: StripPose[]) {
    const [A, B, C, D] = this.attrs.map(x => x.array as Float32Array)
    const E = this.extra.array as Float32Array
    for (let i = 0; i < this.n; i++) {
      const p = poses[i]
      const o = i * 4
      A[o] = p.x
      A[o + 1] = p.y
      A[o + 2] = p.z
      A[o + 3] = p.yaw
      B[o] = p.pitch
      B[o + 1] = p.kUp
      B[o + 2] = p.kSide
      B[o + 3] = p.twist
      C[o] = p.roll
      C[o + 1] = p.sFlat
      C[o + 2] = p.kGrow
      C[o + 3] = p.seam
      D[o] = p.wave
      D[o + 1] = p.phase
      D[o + 2] = p.breach
      D[o + 3] = p.sCut
      E[o + 1] = p.kBend
    }
    for (const x of this.attrs) x.needsUpdate = true
    this.extra.needsUpdate = true
  }
}
