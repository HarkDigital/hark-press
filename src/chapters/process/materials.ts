import * as THREE from 'three'

/*
 * Ink shaders for the Fold. All of them write DENSITIES (pink, green, black,
 * halftone) for the riso pass in src/core/post.ts.
 *
 * Texel rule shared by the printed surfaces: full-strength ink (type, rules)
 * prints crisp, tints and shading are screened into dots, and bare paper
 * carries a faint contone tone so a white sheet still separates from the
 * newsprint behind it.
 */

const tex = (c: HTMLCanvasElement, aniso = 8) => {
  const t = new THREE.CanvasTexture(c)
  t.colorSpace = THREE.NoColorSpace
  t.anisotropy = aniso
  t.generateMipmaps = true
  t.minFilter = THREE.LinearMipmapLinearFilter
  t.magFilter = THREE.LinearFilter
  return t
}

const PRINT_GLSL = /* glsl */ `
  // ink texel + paper tone + shade (black) → density with the crisp/screen rule
  vec4 printInk(vec3 ink, float tone, float shade) {
    float mx = max(ink.r, max(ink.g, ink.b));
    float crisp = smoothstep(0.55, 0.9, mx);
    vec3 d = vec3(ink.r, ink.g, clamp(max(ink.b, tone) + shade, 0.0, 1.0));
    float screen = smoothstep(0.03, 0.12, max(mx, shade)) * (1.0 - crisp);
    return vec4(d, screen);
  }
`

/** The folding sheet: front/back canvases, lit so shade builds black ink. */
export function sheetMaterial(front: HTMLCanvasElement, back: HTMLCanvasElement, aniso: number) {
  return new THREE.ShaderMaterial({
    side: THREE.DoubleSide,
    toneMapped: false,
    uniforms: {
      uFront: { value: tex(front, aniso) },
      uBack: { value: tex(back, aniso) },
      uLight: { value: new THREE.Vector3(-0.45, 0.85, 0.5).normalize() },
      uTone: { value: 0.05 },
      uShade: { value: 0.55 },
      uFade: { value: 1 },
    },
    vertexShader: /* glsl */ `
      varying vec3 vN;
      varying vec2 vUv;
      void main() {
        vN = normalize(mat3(modelMatrix) * normal);
        vUv = uv;
        gl_Position = projectionMatrix * viewMatrix * modelMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      uniform sampler2D uFront, uBack;
      uniform vec3 uLight;
      uniform float uTone, uShade, uFade;
      varying vec3 vN;
      varying vec2 vUv;
      ${PRINT_GLSL}
      void main() {
        vec3 n = normalize(vN);
        vec3 ink = texture2D(uFront, vUv).rgb;
        vec3 inkB = texture2D(uBack, vec2(1.0 - vUv.x, vUv.y)).rgb;
        if (!gl_FrontFacing) { n = -n; ink = inkB; }
        float ndl = dot(n, uLight);
        float shade = (1.0 - smoothstep(-0.25, 0.92, ndl)) * uShade;
        gl_FragColor = printInk(ink * uFade, uTone, shade);
      }
    `,
  })
}

/** The cutting mat (a plain textured plane). */
export function matMaterial(canvas: HTMLCanvasElement, aniso: number) {
  return new THREE.ShaderMaterial({
    toneMapped: false,
    uniforms: { uMap: { value: tex(canvas, aniso) } },
    vertexShader: /* glsl */ `
      varying vec2 vUv;
      void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
    `,
    fragmentShader: /* glsl */ `
      uniform sampler2D uMap;
      varying vec2 vUv;
      ${PRINT_GLSL}
      void main() {
        vec3 ink = texture2D(uMap, vUv).rgb;
        gl_FragColor = printInk(ink, 0.0, 0.0);
      }
    `,
  })
}

/**
 * Planar contact shadow: the same folded geometry squashed onto the mat along
 * the light, printed as a black screen that fades with height. MAX blending
 * overprints it on the mat (and never double-inks where layers overlap).
 */
export function planarShadowMaterial() {
  return new THREE.ShaderMaterial({
    side: THREE.DoubleSide,
    toneMapped: false,
    depthWrite: false,
    transparent: false,
    blending: THREE.CustomBlending,
    blendEquation: THREE.MaxEquation,
    blendSrc: THREE.OneFactor,
    blendDst: THREE.OneFactor,
    uniforms: {
      uL: { value: new THREE.Vector3(0.2, -1, 0.16).normalize() },
      uY: { value: 0.004 },
      uStrength: { value: 0.27 },
      uReach: { value: 3.2 },
    },
    vertexShader: /* glsl */ `
      uniform vec3 uL;
      uniform float uY;
      varying float vH;
      void main() {
        vec4 w = modelMatrix * vec4(position, 1.0);
        float h = max(w.y - uY, 0.0);
        vec3 p = w.xyz + uL * (h / max(-uL.y, 0.05));
        p.y = uY;
        vH = h;
        gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      uniform float uStrength, uReach;
      varying float vH;
      void main() {
        float a = uStrength * (1.0 - smoothstep(0.0, uReach, vH));
        if (a < 0.01) discard;
        gl_FragColor = vec4(0.0, 0.0, a, 1.0);
      }
    `,
  })
}

/** A stamp impression riding on the wing: ink arrives with uInk (0..1). */
export function stampMaterial(canvas: HTMLCanvasElement, aniso: number) {
  return new THREE.ShaderMaterial({
    side: THREE.DoubleSide,
    toneMapped: false,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -2,
    uniforms: { uMap: { value: tex(canvas, aniso) }, uInk: { value: 0 } },
    vertexShader: /* glsl */ `
      varying vec2 vUv;
      void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
    `,
    fragmentShader: /* glsl */ `
      uniform sampler2D uMap;
      uniform float uInk;
      varying vec2 vUv;
      void main() {
        vec4 t = texture2D(uMap, vUv);
        // alpha = the stamp's footprint; knocked-out type stays opaque paper
        if (t.a < 0.5 || uInk < 0.01) discard;
        vec3 ink = t.rgb * uInk;
        float mx = max(ink.r, max(ink.g, ink.b));
        // crisp where the ink bit, screened while it's still landing
        gl_FragColor = vec4(ink, 1.0 - smoothstep(0.6, 0.92, mx));
      }
    `,
  })
}
