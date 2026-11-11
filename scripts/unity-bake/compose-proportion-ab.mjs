#!/usr/bin/env node
/**
 * 生成比例感知重定向的 3 联 A/B 对照图（dev-only）：
 *   源 Zome（canonical source reference） | 男体 before（原 clip） | 男体 after（重定向）
 *
 *   node scripts/unity-bake/compose-proportion-ab.mjs \
 *     --before tests/tmp/lead-proportion/render-before \
 *     --source tests/tmp/lead-proportion/render-source-zome \
 *     --after tests/tmp/lead-proportion/render-after-absolute \
 *     --out tests/tmp/lead-proportion/evidence
 *
 * 只读 PNG，输出 JPG；用于人工目视肩线/手位，不参与产品。
 */
import { existsSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import sharp from 'sharp'
import { parseCliArgs, formatHelp } from './lib/cli-args.mjs'

const OPTIONS = {
  before: { type: 'string', default: 'tests/tmp/lead-proportion/render-before', valueHint: 'dir', description: 'before PNG 目录' },
  source: { type: 'string', default: 'tests/tmp/lead-proportion/render-source-zome', valueHint: 'dir', description: '源 Zome PNG 目录' },
  after: { type: 'string', default: 'tests/tmp/lead-proportion/render-after-absolute', valueHint: 'dir', description: 'after PNG 目录' },
  out: { type: 'string', default: 'tests/tmp/lead-proportion/evidence', valueHint: 'dir', description: '输出 JPG 目录' },
  clips: { type: 'string', default: 'sit1,sit2,windowLay8,windowLay9,windowLay10,sitWindow,sleep,hideLeft,idle,idle4', valueHint: 'a,b,c', description: 'clip 列表' },
  frame: { type: 'string', default: '000', valueHint: '000|025|050|075', description: '取哪一帧' }
}
const HELP = formatHelp({
  command: 'node scripts/unity-bake/compose-proportion-ab.mjs',
  description: '把源/修正前/修正后的 PNG 裁成上身躯干 3 联对照图。',
  usage: 'node scripts/unity-bake/compose-proportion-ab.mjs [--clips a,b,c] [--out DIR]',
  options: OPTIONS
})
const CROP = { left: 150, top: 40, width: 320, height: 470 }
const PANEL_W = 320
const PANEL_H = 470
const SCALE = 2
const LABEL_H = 34

function labelSvg(text, x, y, color = '#111') {
  return Buffer.from(`<svg width="${PANEL_W}" height="${LABEL_H}" xmlns="http://www.w3.org/2000/svg">
    <rect width="100%" height="100%" fill="#f7f7f7"/>
    <text x="10" y="24" font-family="Helvetica,Arial,sans-serif" font-size="18" fill="${color}">${text}</text>
  </svg>`)
}

async function panel(file, label, color) {
  const img = sharp(file).extract(CROP).resize(PANEL_W * SCALE, PANEL_H * SCALE, { kernel: 'lanczos3' })
  const body = await img.jpeg({ quality: 92 }).toBuffer()
  const labelImg = await sharp(labelSvg(label, 0, 0, color)).resize(PANEL_W * SCALE, LABEL_H * SCALE).png().toBuffer()
  return { body, labelImg }
}

async function main() {
  const { values, errors, sawHelp } = parseCliArgs(process.argv.slice(2), OPTIONS)
  if (sawHelp) { console.log(HELP); process.exit(0) }
  if (errors.length) { console.error(errors.join('\n')); process.exit(2) }
  const outDir = path.resolve(String(values.out))
  mkdirSync(outDir, { recursive: true })
  const clips = String(values.clips).split(',').map((s) => s.trim()).filter(Boolean)
  const frame = String(values.frame).padStart(3, '0')
  for (const clip of clips) {
    const files = [
      { file: path.join(String(values.source), `${clip}-${frame}.png`), label: `SOURCE Zome (canonical) ${clip} f${frame}` },
      { file: path.join(String(values.before), `${clip}-${frame}.png`), label: `BEFORE male ${clip} f${frame}` },
      { file: path.join(String(values.after), `${clip}-${frame}.png`), label: `AFTER retarget ${clip} f${frame}` }
    ]
    if (files.some((f) => !existsSync(f.file))) {
      console.warn(`[ab] skip ${clip}（缺 PNG）`)
      continue
    }
    const panels = []
    for (const f of files) panels.push(await panel(f.file, f.label))
    const width = PANEL_W * SCALE * panels.length
    const height = (PANEL_H + LABEL_H) * SCALE
    const base = sharp({ create: { width, height, channels: 3, background: '#ffffff' } })
    const composites = []
    let x = 0
    for (const p of panels) {
      composites.push({ input: p.labelImg, left: x, top: 0 })
      composites.push({ input: p.body, left: x, top: LABEL_H * SCALE })
      x += PANEL_W * SCALE
    }
    const file = path.join(outDir, `${clip}-f${frame}-ab.jpg`)
    await base.composite(composites).jpeg({ quality: 90 }).toFile(file)
    console.log(`[ab] ${path.relative(process.cwd(), file)}`)
  }
}
await main()
