import * as THREE from 'three'
import { inkFlatMaterial, inkLineMaterial, inkMaterial } from '../../print/ink'
import { ease, segment } from '../../core/math'

/*
 * The rubber stamp itself: a wooden mount with a pink rubber die and a green
 * turned knob, printed like everything else (ink + shade that adds ink, black
 * keylines). It animates ON TWOS (12 fps, like stop-motion): drops out of
 * the sky, slams and squashes, holds a beat, lifts away. The impression it
 * leaves is drawn by the page shader (leaf.ts) from the same clock.
 *
 *   age 0.00–0.16  drop (tilted, easing in)
 *   age 0.16       hit — the impression appears
 *   age 0.16–0.30  squash, rebound, hold
 *   age 0.30–0.58  lift and leave
 */

export const STAMP_HIT = 0.16
const OUT = 0.6

const LIGHT = new THREE.Vector3(-0.5, 0.85, 0.35)

export function createStampTool() {
  const group = new THREE.Group()
  const body = new THREE.Group()
  group.add(body)

  // wooden mount
  const blockGeo = new THREE.BoxGeometry(0.4, 0.075, 0.25)
  const block = new THREE.Mesh(blockGeo, inkMaterial({ ink: [0, 0, 0.05], shadow: [0, 0, 0.6], lightDir: LIGHT }))
  block.position.y = 0.018 + 0.0375
  body.add(block)
  const edges = new THREE.LineSegments(new THREE.EdgesGeometry(blockGeo), inkLineMaterial([0, 0, 1]))
  edges.position.copy(block.position)
  body.add(edges)
  // rubber die
  const die = new THREE.Mesh(new THREE.BoxGeometry(0.37, 0.018, 0.22), inkFlatMaterial([1, 0, 0], 0))
  die.position.y = 0.009
  body.add(die)
  // turned handle: neck + knob
  const knobMat = inkMaterial({ ink: [0, 0.9, 0], shadow: [0, 0.15, 0.55], lightDir: LIGHT })
  const neck = new THREE.Mesh(new THREE.CylinderGeometry(0.036, 0.055, 0.11, 20), knobMat)
  neck.position.y = 0.093 + 0.055
  body.add(neck)
  const knob = new THREE.Mesh(new THREE.SphereGeometry(0.078, 24, 16), knobMat)
  knob.scale.set(1, 0.82, 1)
  knob.position.y = 0.093 + 0.11 + 0.05
  body.add(knob)
  const ring = new THREE.Mesh(new THREE.TorusGeometry(0.056, 0.008, 8, 28), inkFlatMaterial([0, 0, 1], 0))
  ring.rotation.x = Math.PI / 2
  ring.position.y = 0.093 + 0.012
  body.add(ring)

  group.visible = false

  /**
   * Pose for a stepped age (seconds since the stamp started). `at` is the
   * impression centre in the parent's space, `yaw` the stamp's rotation.
   */
  function update(age: number | null, at: THREE.Vector3, yaw: number) {
    if (age === null || age < 0 || age > OUT) {
      group.visible = false
      return
    }
    group.visible = true
    group.position.copy(at)
    group.rotation.set(0, yaw, 0)
    const drop = segment(age, 0, STAMP_HIT)
    const lift = segment(age, 0.3, 0.58)
    const y = (1 - ease.inQuad(drop)) * 1.2 + ease.inQuad(lift) * 1.5
    // squash on the hit, a small rebound, then back to shape
    const sq = segment(age, STAMP_HIT, 0.3)
    const squash = age < STAMP_HIT ? 0 : Math.sin(Math.PI * Math.min(1, sq * 1.6)) * (1 - sq) * 0.9
    body.position.set(-0.25 * ease.inQuad(lift), y, -0.35 * ease.inQuad(lift))
    body.scale.set(1 + squash * 0.1, 1 - squash * 0.28, 1 + squash * 0.1)
    body.rotation.set(0.35 * (1 - drop) - 0.5 * lift, 0, 0.12 * (1 - drop) + 0.25 * lift)
  }

  return { group, update }
}
