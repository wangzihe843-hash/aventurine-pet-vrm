// Scale rehearsal: synthesize a Biped samples.json containing ALL 135 adv clips
// (from clips.adv-all.json) using the Biped fixture rest skeleton, so the FULL
// retarget -> manifest -> validate -> app-manifest path can be exercised before
// the real 3ds Max FBX arrive.
//
// Usage: node scripts/vrm/motion/make-scale-rehearsal-samples.mjs
// Output: work/adv-biped/scale-rehearsal/samples.json  (private, gitignored)
//
// Purpose: before the real 3ds Max FBX exist, exercise the FULL 135-clip path:
//   samples -> retarget-adv -> build-adv-manifest (+coverage) -> validate -> build-app-manifest
// All rotations are procedural; this is a plumbing rehearsal, NOT animation validation.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { qMul, qNormalize } from './lib/quat.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..', '..', '..')
const FIXTURE = path.join(ROOT, 'work/adv-biped/fixture/samples-skel.json')
const REGISTRY = path.join(ROOT, 'scripts/vrm/motion/clips.adv-all.json')
const OUT = path.join(ROOT, 'work/adv-biped/scale-rehearsal/samples.json')

const fixture = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'))
const registry = JSON.parse(fs.readFileSync(REGISTRY, 'utf8'))

const rest = fixture.rest
const children = fixture.children
const bones = Object.keys(rest)
const FPS = 30

// bones that get a visible oscillation (arm chain, spine, head)
const ARM_BONES = ['Bip001 L UpperArm', 'Bip001 R UpperArm', 'Bip001 L Forearm', 'Bip001 R Forearm']
const BODY_BONES = ['Bip001 Spine', 'Bip001 Spine1', 'Bip001 Spine2', 'Bip001 Neck', 'Bip001 Head']
const ALL_ANIM_BONES = [...ARM_BONES, ...BODY_BONES]

function axisAngle([x, y, z], angleDeg) {
  const half = (angleDeg * Math.PI) / 180 / 2
  const s = Math.sin(half)
  return qNormalize([x * s, y * s, z * s, Math.cos(half)])
}

function makeClip(clipDef, index) {
  const loop = Boolean(clipDef.loop)
  const frames = loop ? 61 : 31
  const phase = (index % 7) * 0.9
  const amp = 6 + (index % 5) * 2 // degrees
  const data = []
  for (let i = 0; i < frames; i += 1) {
    const t = i / (frames - 1)
    const wave = Math.sin(2 * Math.PI * t + phase)
    const wave2 = Math.sin(4 * Math.PI * t + phase * 0.5)
    const q = {}
    const h = {}
    for (const bone of bones) {
      const restQ = rest[bone].quat
      const restH = rest[bone].head
      let delta = null
      if (ALL_ANIM_BONES.includes(bone)) {
        if (ARM_BONES.includes(bone)) {
          const sign = bone.includes(' L ') ? 1 : -1
          delta = qMul(axisAngle([1, 0, 0], sign * amp * wave), axisAngle([0, 0, 1], sign * 0.3 * amp * wave2))
        } else {
          delta = axisAngle([0, 1, 0], amp * 0.4 * wave2)
        }
      }
      const worldQ = delta ? qNormalize(qMul(delta, restQ)) : restQ
      q[bone] = worldQ.map((v) => Number(v.toFixed(8)))
      // keep heads at rest except a tiny vertical hips bob (exercises grounding/hips.p)
      if (bone === 'Bip001 Pelvis') {
        const bob = clipDef.grounding === 'feet' ? 0.008 * wave2 : 0
        h[bone] = [restH[0], Number((restH[1] + bob).toFixed(8)), restH[2]]
      } else {
        h[bone] = [restH[0], restH[1], restH[2]]
      }
    }
    data.push({ f: 1 + i, q, h })
  }
  return {
    action: `Bip001|Bip001|${clipDef.takeMatch}`,
    takeMatch: clipDef.takeMatch,
    srcFrames: [1, frames],
    frames,
    sourceFps: FPS,
    data
  }
}

const out = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  fbx: 'SYNTHETIC(scale-rehearsal)',
  sourceFps: FPS,
  fps: FPS,
  sourceHeightMeters: fixture.sourceHeightMeters,
  sourceHipsHeightMeters: fixture.sourceHipsHeightMeters,
  rest,
  children,
  clips: {}
}
registry.clips.forEach((clipDef, index) => {
  out.clips[clipDef.id] = makeClip(clipDef, index)
})
// Tpose sample: rest only, no clip (as real sampler does)
fs.writeFileSync(OUT, JSON.stringify(out))
const sizeMb = (fs.statSync(OUT).size / 1048576).toFixed(1)
console.log(`[scale-rehearsal] clips=${Object.keys(out.clips).length} bones=${bones.length} -> ${OUT} (${sizeMb} MB)`)
