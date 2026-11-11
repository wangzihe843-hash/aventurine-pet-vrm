#!/usr/bin/env node
/**
 * 把 mate clip 转成「在 Zome 上渲染 canonical 源姿态」的参考数据（dev-only）。
 *
 * 背景：three-vrm 的 VRM0 路径是 `rawRest + q` 后再 `rotateY(π)`；而我们的源期望姿态
 * 是 canonical（Unity 源 avatar）`rotRest + q`。二者差一个绕 Y 180° 的共轭：
 *   q' = R0⁻¹ q R0 = (-x, y, -z, w)，p' = R0⁻¹ p = (-px, py, -pz)。
 * 把 q' 写进 clip 再让 preview-clips 在 Zome 上播，渲染出来才是源视觉姿态（不是镜像版）。
 *
 *   node scripts/unity-bake/source-canonical-reference.mjs \
 *     --motions assets/motions/mate --clips idle,sit1 --out tests/tmp/lead-proportion/clips-source-canonical
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { parseCliArgs, formatHelp } from './lib/cli-args.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

const OPTIONS = {
  motions: { type: 'string', default: 'assets/motions/mate', valueHint: 'dir', description: '源 clip 目录' },
  clips: { type: 'string', default: 'idle,sit1', valueHint: 'a,b,c', description: '逗号分隔 clip 名' },
  out: { type: 'string', default: 'tests/tmp/lead-proportion/clips-source-canonical', valueHint: 'dir', description: '输出目录' }
}
const HELP = formatHelp({
  command: 'node scripts/unity-bake/source-canonical-reference.mjs',
  description: '把 mate clip 共轭到 canonical 源姿态，供 preview-clips 在 Zome 上渲染源参考。',
  usage: 'node scripts/unity-bake/source-canonical-reference.mjs --clips idle,sit1 --out DIR',
  options: OPTIONS
})

function conjugateTrackR(track) {
  if (!Array.isArray(track)) return track
  const nested = Array.isArray(track[0])
  const out = []
  const push = (q) => {
    // q' = (-x, y, -z, w)
    out.push([-q[0], q[1], -q[2], q[3]])
  }
  if (nested) for (const q of track) push(q)
  else for (let i = 0; i + 3 < track.length; i += 4) push(track.slice(i, i + 4))
  return nested ? out : out.flat()
}
function conjugateTrackP(track) {
  if (!Array.isArray(track)) return track
  const nested = Array.isArray(track[0])
  const out = []
  const push = (p) => out.push([-p[0], p[1], -p[2]])
  if (nested) for (const p of track) push(p)
  else for (let i = 0; i + 2 < track.length; i += 3) push(track.slice(i, i + 3))
  return nested ? out : out.flat()
}

function main() {
  const { values, errors, sawHelp } = parseCliArgs(process.argv.slice(2), OPTIONS)
  if (sawHelp) { console.log(HELP); process.exit(0) }
  if (errors.length) { console.error(errors.join('\n')); process.exit(2) }
  const motionsDir = path.resolve(ROOT, String(values.motions))
  const outDir = path.resolve(ROOT, String(values.out))
  mkdirSync(outDir, { recursive: true })
  const clips = String(values.clips).split(',').map((s) => s.trim()).filter(Boolean)
  for (const clipName of clips) {
    const file = path.join(motionsDir, `${clipName}.json`)
    if (!existsSync(file)) { console.error(`缺 clip：${file}`); process.exit(1) }
    const clip = JSON.parse(readFileSync(file, 'utf8'))
    for (const [bone, track] of Object.entries(clip.bones ?? {})) {
      if (track?.r) track.r = conjugateTrackR(track.r)
      if (bone === 'Hips' && track?.p) track.p = conjugateTrackP(track.p)
    }
    clip.sourceCanonicalReference = {
      tool: 'scripts/unity-bake/source-canonical-reference.mjs',
      note: 'q\' = (-x,y,-z,w)（VRM0 raw→canonical 的 Y-π 共轭），用于在 Zome 上渲染源姿态',
      generatedAt: new Date().toISOString()
    }
    writeFileSync(path.join(outDir, `${clipName}.json`), JSON.stringify(clip, null, 2) + '\n')
    console.log(`[source-canonical] ${clipName} → ${path.join(path.relative(ROOT, outDir), clipName + '.json')}`)
  }
}
main()
