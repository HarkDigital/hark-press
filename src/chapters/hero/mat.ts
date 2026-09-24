import * as THREE from 'three'

/*
 * The bed: a green self-healing cutting mat. A halftone field of green ink
 * with the grid reversed out of it (crisp, contone), a heavier line every
 * fifth, 45° angle guides, a few healed knife scores, and a ruled border
 * with tick marks.
 */

const VERT = /* glsl */ `
varying vec2 vP;
void main() {
  vec4 w = modelMatrix * vec4(position, 1.0);
  vP = w.xz;
  gl_Position = projectionMatrix * viewMatrix * w;
}
`

const FRAG = /* glsl */ `
uniform float uGreen;
uniform vec2 uHalf;      // half size of the mat's inner field
uniform float uFade;     // 0..1 fades the mat toward solid green (the cut)
varying vec2 vP;

float h12(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * .1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }

float gridLine(float c, float spacing, float px, float fw) {
  float d = abs(fract(c / spacing + 0.5) - 0.5) * spacing;
  return 1.0 - smoothstep(px * 0.5 * fw - 0.5 * fw, px * 0.5 * fw + 0.5 * fw, d);
}

void main() {
  vec2 p = vP;
  vec2 fwv = fwidth(p);
  float fw = max(1e-5, max(fwv.x, fwv.y));

  float minorX = gridLine(p.x, 0.25, 1.0, fw);
  float minorY = gridLine(p.y, 0.25, 1.0, fw);
  float majorX = gridLine(p.x, 1.25, 2.2, fw);
  float majorY = gridLine(p.y, 1.25, 2.2, fw);
  float minor = max(minorX, minorY);
  float major = max(majorX, majorY);

  // 45° / 60° angle guides from the mat's origin corner
  vec2 o = p + uHalf;
  float d45 = abs(o.x - o.y) * 0.7071;
  float d45b = abs(o.x + o.y - 2.0 * uHalf.y) * 0.7071;
  float guide = max(1.0 - smoothstep(0.4 * fw, 1.2 * fw, d45), 1.0 - smoothstep(0.4 * fw, 1.2 * fw, d45b)) * 0.8;

  // healed knife scores: short random diagonals in a few cells
  vec2 cell = floor(p / 1.6);
  vec2 f = p / 1.6 - cell;
  float r = h12(cell + 17.0);
  float score = 0.0;
  if (r > 0.72) {
    float ang = (h12(cell + 3.0) - 0.5) * 2.4;
    vec2 dir = vec2(cos(ang), sin(ang));
    vec2 c = f - 0.5;
    float along = dot(c, dir);
    float across = abs(dot(c, vec2(-dir.y, dir.x))) * 1.6;
    score = (1.0 - smoothstep(0.35 * fw, 1.1 * fw, across)) * step(abs(along), 0.18 + 0.2 * h12(cell + 9.0)) * 0.55;
  }

  // border: a ruled band with ticks
  vec2 q = abs(p) - uHalf;
  float inBorder = step(0.0, max(q.x, q.y));
  float borderRule = 1.0 - smoothstep(0.8 * fw, 1.8 * fw, abs(max(q.x, q.y)));
  float ticks = inBorder * max(gridLine(p.x, 0.25, 1.2, fw) * step(q.y, 0.18), gridLine(p.y, 0.25, 1.2, fw) * step(q.x, 0.18));

  float knock = max(max(minor * 0.62, major), max(guide * 0.7, score));
  knock = max(knock, max(borderRule, ticks));
  knock *= 1.0 - uFade;
  float g = mix(uGreen, 0.1, knock);
  g = mix(g, 1.0, uFade);
  gl_FragColor = vec4(0.0, g, knock * 0.05, 1.0 - knock);
}
`

export function createMat(): THREE.Mesh {
  const mat = new THREE.ShaderMaterial({
    vertexShader: VERT,
    fragmentShader: FRAG,
    toneMapped: false,
    uniforms: {
      uGreen: { value: 0.66 },
      uHalf: { value: new THREE.Vector2(15, 11.25) },
      uFade: { value: 0 },
    },
  })
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(90, 90), mat)
  mesh.rotation.x = -Math.PI / 2
  mesh.position.set(0, 0, 0)
  return mesh
}
