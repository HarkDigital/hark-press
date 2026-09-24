import * as THREE from 'three'
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js'
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js'
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js'

/*
 * The PRESS. Chapters don't render colour — they render INK DENSITIES:
 *
 *   gl_FragColor = vec4(pink, green, black, halftone)
 *
 * (0 = no ink, 1 = solid; alpha 1 = halftone-screened, 0 = contone — use 0
 * for things that must stay crisp, like a screenshot's fine print.) The
 * riso pass below prints those densities onto newsprint: one rotated
 * halftone screen per ink, each drum slightly out of register, overprinted
 * multiplicatively, with ink grain and paper fibre. Chapter cuts are an INK
 * FLOOD: the green screen's dots swell until the sheet is solid, the next
 * sheet feeds, and the dots shrink away.
 *
 * Everything is in display space; there is no tone mapping and no bloom.
 */

export const INKS = {
  paper: new THREE.Color('#f3eee4'),
  pink: new THREE.Color('#ff3e9d'),
  green: new THREE.Color('#00d975'),
  black: new THREE.Color('#1b1b1f'),
}

const RisoShader = {
  uniforms: {
    tDiffuse: { value: null as THREE.Texture | null },
    uTime: { value: 0 },
    uResolution: { value: new THREE.Vector2(1, 1) },
    uDpr: { value: 1 },
    /** halftone cell size in CSS px */
    uCell: { value: 5.5 },
    /** drum misregistration in CSS px */
    uMisreg: { value: 1.4 },
    uGrain: { value: 0.5 },
    /** 0..1 peaks at a chapter cut (engine-driven) */
    uTransition: { value: 0 },
    /** 0..1 roller wobble: misregistration jitter + slight sheet skew */
    uGlitch: { value: 0 },
    /** 0..1 wash to clean paper */
    uFlash: { value: 0 },
    /** 0..1 fade to paper (reduced-motion cuts) */
    uFade: { value: 0 },
    uPaper: { value: INKS.paper.clone() },
    uPink: { value: INKS.pink.clone() },
    uGreen: { value: INKS.green.clone() },
    uBlack: { value: INKS.black.clone() },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
  `,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform float uTime, uDpr, uCell, uMisreg, uGrain, uTransition, uGlitch, uFlash, uFade;
    uniform vec2 uResolution;
    uniform vec3 uPaper, uPink, uGreen, uBlack;
    varying vec2 vUv;

    float hash(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * .1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
    float vnoise(vec2 p) {
      vec2 i = floor(p), f = fract(p);
      vec2 u = f * f * (3.0 - 2.0 * f);
      return mix(mix(hash(i), hash(i + vec2(1, 0)), u.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), u.x), u.y);
    }

    // coverage of one rotated halftone screen at density d (0..1)
    float screenDot(vec2 px, float d, float ang, float cell) {
      float c = cos(ang), s = sin(ang);
      vec2 p = mat2(c, -s, s, c) * px / cell;
      vec2 f = fract(p) - 0.5;
      float dist = length(f);
      float r = sqrt(clamp(d, 0.0, 1.0)) * 0.74;
      float aa = 0.9 / cell;
      // zero ink prints nothing (no ghost dots on bare paper)
      float dotCov = (1.0 - smoothstep(r - aa, r + aa, dist)) * smoothstep(0.004, 0.035, d);
      // dense areas close up into solid ink instead of leaving pinholes
      return max(dotCov, smoothstep(0.82, 0.98, d));
    }

    void main() {
      vec2 px = gl_FragCoord.xy / uDpr;               // CSS pixels
      float t = clamp(uTransition, 0.0, 1.0);
      float wob = clamp(uGlitch, 0.0, 1.0);

      // a new sheet feeding through at the cut
      vec2 uv = vUv;
      uv.y += t * t * 0.035;
      uv.x += wob * 0.004 * sin(uv.y * 7.0 + uTime * 2.3);

      // each drum is a little out of register (more during cuts and wobble)
      float mis = (uMisreg + t * 6.0 + wob * 3.0) / uResolution.y * uDpr;
      vec2 oP = vec2(0.8, -0.55) * mis + wob * 0.002 * vec2(sin(uTime * 5.1), cos(uTime * 4.3));
      vec2 oG = vec2(-0.6, 0.7) * mis;
      vec2 oK = vec2(0.0);

      vec4 sP = texture2D(tDiffuse, uv + oP);
      vec4 sG = texture2D(tDiffuse, uv + oG);
      vec4 sK = texture2D(tDiffuse, uv + oK);
      float dP = sP.r, dG = sG.g, dK = sK.b;
      float ht = sK.a;                                 // 1 = screen it, 0 = contone

      // INK FLOOD: green dots swell to solid at the cut, then recede
      float flood = smoothstep(0.08, 0.92, t);
      dG = max(dG, flood);
      dK = max(dK, flood * flood * 0.18);

      float cell = uCell * (1.0 + t * 0.6);
      float cP = mix(clamp(dP, 0.0, 1.0), screenDot(px, dP, 1.309, cell), ht);  // 75°
      float cG = mix(clamp(dG, 0.0, 1.0), screenDot(px, dG, 0.262, cell), max(ht, flood)); // 15°
      float cK = mix(clamp(dK, 0.0, 1.0), screenDot(px, dK, 0.785, cell * 0.9), ht); // 45°

      // ink grain: voids where the drum starved
      float g1 = vnoise(px * 0.9 + 13.1), g2 = vnoise(px * 0.23 + 91.7);
      float starve = uGrain * (0.22 * g1 + 0.12 * g2);
      cP *= 1.0 - starve;
      cG *= 1.0 - starve * 0.8;
      cK *= 1.0 - starve * 0.3;

      // paper: warm stock with fibre and a whisper of tooth
      float fib = vnoise(vec2(px.x * 0.02, px.y * 0.35)) * 0.5 + vnoise(px * 0.08) * 0.5;
      vec3 col = uPaper * (0.975 + 0.035 * fib) - (hash(px) - 0.5) * 0.012;

      // overprint (multiply), in print order: green, pink, black
      col *= mix(vec3(1.0), uGreen, cG * 0.96);
      col *= mix(vec3(1.0), uPink, cP * 0.94);
      // key prints dense so WebGL black matches the page's type
      col *= mix(vec3(1.0), uBlack, cK * 0.995);

      col = mix(col, uPaper, clamp(max(uFlash, uFade), 0.0, 1.0));
      gl_FragColor = vec4(col, 1.0);
      #include <colorspace_fragment>
    }
  `,
}

export type PostParams = {
  /** halftone cell size (CSS px) — bigger = coarser, more "riso" */
  cell: number
  /** drum misregistration (CSS px) */
  misreg: number
  /** ink grain / starved-drum voids 0..1 */
  grain: number
  /** roller wobble 0..1 */
  glitch: number
  /** wash to clean paper 0..1 */
  flash: number
}

export const POST_DEFAULTS: PostParams = { cell: 5.5, misreg: 1.4, grain: 0.5, glitch: 0, flash: 0 }

export class Post {
  composer: EffectComposer
  final: ShaderPass
  params: PostParams = { ...POST_DEFAULTS }
  private current: PostParams = { ...POST_DEFAULTS }
  transition = 0
  fade = 0

  constructor(
    private renderer: THREE.WebGLRenderer,
    scene: THREE.Scene,
    camera: THREE.Camera,
    /** unused on the press (ink density targets are never multisampled) */
    _noMsaa: boolean,
  ) {
    const size = renderer.getDrawingBufferSize(new THREE.Vector2())
    const rt = new THREE.WebGLRenderTarget(size.x, size.y, { type: THREE.HalfFloatType, samples: 0 })
    this.composer = new EffectComposer(renderer, rt)
    const render = new RenderPass(scene, camera)
    // clear to "no ink" with halftone on
    render.clearColor = new THREE.Color(0, 0, 0)
    render.clearAlpha = 1
    this.composer.addPass(render)
    this.final = new ShaderPass(RisoShader)
    this.composer.addPass(this.final)
  }

  resetParams() {
    Object.assign(this.params, POST_DEFAULTS)
  }

  /** kept for engine compatibility (reduced-motion dips always go to paper here) */
  setFadeTone(_tone: number) {}

  setSize(w: number, h: number, dpr: number) {
    this.composer.setPixelRatio(dpr)
    this.composer.setSize(w, h)
    this.final.uniforms.uResolution.value.set(w * dpr, h * dpr)
    this.final.uniforms.uDpr.value = dpr
  }

  render(dt: number, time: number) {
    const k = 1 - Math.exp(-6 * dt)
    const c = this.current
    const p = this.params
    for (const key of Object.keys(p) as (keyof PostParams)[]) {
      c[key] = key === 'flash' || key === 'glitch' ? p[key] : c[key] + (p[key] - c[key]) * k
    }
    const u = this.final.uniforms
    u.uTime.value = time
    u.uTransition.value = this.transition
    u.uGlitch.value = c.glitch
    u.uCell.value = c.cell
    u.uMisreg.value = c.misreg
    u.uGrain.value = c.grain
    u.uFlash.value = c.flash
    u.uFade.value = this.fade
    this.composer.render(dt)
  }
}
