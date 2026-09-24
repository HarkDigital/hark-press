import * as THREE from 'three'
import type { Chapter } from '../../core/types'
import { el, rise, setRise } from '../../core/dom'
import { inkMaterial, inkShadowMaterial } from '../../print/ink'
import { logoGeometry } from '../../logo/logo'

// PLACEHOLDER — replaced by the process chapter build.
export default function create(): Chapter {
  const group = new THREE.Group()
  const mark = new THREE.Mesh(logoGeometry({ depth: 0.2 }), inkMaterial({ ink: [0, 0.85, 0], shadow: [0.25, 0.1, 0.5] }))
  mark.scale.setScalar(2.2)
  group.add(mark)
  const shadow = new THREE.Mesh(new THREE.PlaneGeometry(3, 3), inkShadowMaterial(0.5))
  shadow.rotation.x = -Math.PI / 2
  shadow.position.y = -1.6
  group.add(shadow)
  let title: HTMLElement
  return {
    id: 'process',
    group,
    init(ctx) {
      el('p', 'hud-eyebrow', 'Fold', ctx.stage).style.cssText = 'position:absolute;left:var(--gutter);top:var(--safe-top)'
      title = rise(el('h2', 'hud-h2', undefined, ctx.stage), 'We listen first. <em>Then we build.</em>')
      title.style.cssText = 'position:absolute;left:var(--gutter);top:calc(var(--safe-top) + 34px);max-width:60vw'
    },
    update(local, frame) {
      mark.rotation.set(0.25, local * 4 + frame.time * 0.2, 0)
      setRise(title, local > 0.05 && local < 0.95)
    },
    camera(_local, _frame, out) {
      out.position.set(0, 0.6, 7)
      out.target.set(0, 0, 0)
      out.fov = 40
      out.parallax = 0.4
    },
  }
}
