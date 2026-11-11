#!/usr/bin/env node
/**
 * v3 比例感知重定向 A/B 证据图（dev-only）。
 *
 * 输入（默认 tests/tmp/lead-proportion-v3/）：
 *   render-source-zome/              SOURCE Zome canonical
 *   render-before/                   BEFORE male（原 clip）
 *   render-s2-absolute/              S2-absolute f=1.0
 *   render-s2-absolute-f075/         S2-absolute f=0.75
 *   render-hybrid-absolute-g15/      hybrid-absolute f=1.0 g=15°（推荐接触类）
 *   render-hybrid-absolute-g04/      hybrid-absolute 默认 4°（严格）
 *   render-hybrid-absolute-blend-g15/ hybrid blend p=0.7 g=15°
 *   render-v2-s2-socket/             v2 S2-only 兜底（仅接触类）
 *
 * 输出：
 *   evidence/full/<clip>-f000-ab.jpg            4/5 栏全身 A/B（SOURCE|BEFORE|ABS|HYBRID[|BLEND/V2]）
 *   evidence/shoulder/<clip>-f000-zoom.jpg      肩部放大（BEFORE|ABS|HYBRID|…）
 *   evidence/contact/<clip>-f000-zoom.jpg       手/接触区放大（接触类）
 *   evidence/strict/<clip>-f000-ab.jpg          默认 4° hybrid 对照（接触类）
 *
 * 只读 PNG、只写 --out；不参与产品、不做 git 操作。
 */
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import sharp from 'sharp'

import { parseCliArgs, formatHelp } from './lib/cli-args.mjs'

const OPTIONS = {
  root: { type: 'string', default: 'tests/tmp/lead-proportion-v3', valueHint: 'dir', description: '渲染/指标根目录' },
  clips: { type: 'string', default: 'idle,idle2,idle3,idle4,idle5,idle6,idle7,happy,laughing,shyPoint,pose1,pose2,pose3,sit1,sit2,suwari3,sitWindow,windowLay8,windowLay9,windowLay10,hideLeft,hideOnce,sleep', valueHint: 'a,b,c', description: 'clip 列表' },
  frames: { type: 'string', default: '000,025,050,075', valueHint: '000,025,...', description: '帧标签' },
  out: { type: 'string', default: 'evidence', valueHint: 'dir', description: '输出目录（相对 --root）' },
  recommended: { type: 'boolean', default: false, description: '只生成推荐混合集（render-recommended）的 A/B' }
}
const HELP = formatHelp({
  command: 'node scripts/unity-bake/compose-proportion-ab-v3.mjs',
  description: '把 v3 的 source/before/absolute/hybrid 渲染拼成 A/B、肩部放大、接触区放大。',
  usage: 'node scripts/unity-bake/compose-proportion-ab-v3.mjs [--clips a,b,c] [--frames 000,025,050,075]',
  options: OPTIONS
})

const CONTACT_CLIPS = new Set(['sit1', 'sit2', 'suwari3', 'sitWindow', 'windowLay8', 'windowLay9', 'windowLay10', 'hideLeft', 'hideOnce'])
const FALLBACK_CLIPS = new Set(['sit2', 'windowLay9', 'windowLay10'])
const IDLE_GESTURE = new Set(['idle', 'idle2', 'idle3', 'idle4', 'idle5', 'idle6', 'idle7', 'happy', 'laughing', 'shyPoint', 'pose1', 'pose2', 'pose3'])

const PANEL_W = 470
const PANEL_H = 700
const LABEL_H = 36
const BODY_H = PANEL_H - LABEL_H - 6
const ZOOM_W = 680
const ZOOM_H = 560
const SCALE_FULL = 1.15
const SCALE_ZOOM = 1.25

/** 肩部放大框（相对 trim 后 bbox；只用于男体）。 */
const SHOULDER_BOX = { x0: 0.00, x1: 1.00, y0: 0.08, y1: 0.62 }
/** 手/接触区放大框（相对 trim 后 bbox；接触类）。 */
const CONTACT_BOX = {
  sit1: { x0: 0.00, x1: 0.95, y0: 0.18, y1: 0.95 },
  sit2: { x0: 0.00, x1: 0.78, y0: 0.16, y1: 0.88 },
  suwari3: { x0: 0.00, x1: 0.78, y0: 0.16, y1: 0.92 },
  sitWindow: { x0: 0.00, x1: 0.95, y0: 0.12, y1: 0.90 },
  windowLay8: { x0: 0.00, x1: 1.00, y0: 0.10, y1: 0.85 },
  windowLay9: { x0: 0.00, x1: 1.00, y0: 0.10, y1: 0.85 },
  windowLay10: { x0: 0.00, x1: 1.00, y0: 0.10, y1: 0.85 },
  hideLeft: { x0: 0.00, x1: 1.00, y0: 0.00, y1: 0.62 },
  hideOnce: { x0: 0.00, x1: 1.00, y0: 0.00, y1: 0.62 }
}

const COLORS = {
  source: '#5b4b8a',
  before: '#555555',
  abs: '#1565c0',
  hybrid: '#1b7f3a',
  blend: '#b26a00',
  v2: '#7a3e9d'
}

const fmt = (v, n = 1) => (Number.isFinite(v) ? v.toFixed(n) : '—')

function readJsonSafe(file) {
  if (!existsSync(file)) return null
  try { return JSON.parse(readFileSync(file, 'utf8')) } catch { return null }
}

function labelSvg(text, width, color) {
  const safe = String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  return Buffer.from(`<svg width="${width}" height="${LABEL_H}" xmlns="http://www.w3.org/2000/svg">
    <rect width="100%" height="100%" fill="#f4f5f7"/>
    <rect x="0" y="0" width="6" height="100%" fill="${color}"/>
    <text x="14" y="24" font-family="Helvetica,Arial,sans-serif" font-size="16" fill="#111">${safe}</text>
  </svg>`)
}

async function trimInfo(file) {
  const { data, info } = await sharp(file)
    .trim({ background: { r: 0, g: 0, b: 0, alpha: 0 }, threshold: 1 })
    .png()
    .toBuffer({ resolveWithObject: true })
  return {
    buf: data,
    width: info.width,
    height: info.height,
    offsetLeft: -info.trimOffsetLeft,
    offsetTop: -info.trimOffsetTop
  }
}

async function fullPanel(file, label, color) {
  const trimmed = await trimInfo(file)
  const body = await sharp(trimmed.buf)
    .resize({ width: PANEL_W, height: BODY_H, fit: 'inside', kernel: 'lanczos3' })
    .png()
    .toBuffer({ resolveWithObject: true })
  const left = Math.round((PANEL_W - body.info.width) / 2)
  const top = LABEL_H + (BODY_H - body.info.height)
  const outW = Math.round(PANEL_W * SCALE_FULL)
  const outH = Math.round(PANEL_H * SCALE_FULL)
  const labelImg = await sharp(labelSvg(label, PANEL_W, color))
    .resize(outW, Math.round(LABEL_H * SCALE_FULL))
    .png()
    .toBuffer()
  const bodyImg = await sharp(body.data)
    .resize(Math.round(body.info.width * SCALE_FULL), Math.round(body.info.height * SCALE_FULL))
    .png()
    .toBuffer()
  return {
    width: outW,
    height: outH,
    composites: [
      { input: labelImg, left: 0, top: 0 },
      { input: bodyImg, left: Math.round(left * SCALE_FULL), top: Math.round(top * SCALE_FULL) }
    ]
  }
}

async function cropPanel(file, box, label, color) {
  const trimmed = await trimInfo(file)
  const x0 = Math.max(0, Math.round(trimmed.offsetLeft + box.x0 * trimmed.width))
  const y0 = Math.max(0, Math.round(trimmed.offsetTop + box.y0 * trimmed.height))
  const x1 = Math.min(600, Math.round(trimmed.offsetLeft + box.x1 * trimmed.width))
  const y1 = Math.min(800, Math.round(trimmed.offsetTop + box.y1 * trimmed.height))
  const width = Math.max(8, x1 - x0)
  const height = Math.max(8, y1 - y0)
  const body = await sharp(file)
    .extract({ left: x0, top: y0, width, height })
    .resize({ width: ZOOM_W, height: ZOOM_H, fit: 'contain', background: '#ffffff', kernel: 'lanczos3' })
    .png()
    .toBuffer()
  const outW = Math.round(ZOOM_W * SCALE_ZOOM)
  const outH = Math.round(ZOOM_H * SCALE_ZOOM)
  const labelImg = await sharp(labelSvg(label, ZOOM_W, color))
    .resize(outW, Math.round(LABEL_H * SCALE_ZOOM))
    .png()
    .toBuffer()
  const bodyImg = await sharp(body)
    .resize(outW, Math.round((ZOOM_H - LABEL_H) * SCALE_ZOOM), { fit: 'contain', background: '#ffffff' })
    .png()
    .toBuffer()
  return {
    width: outW,
    height: outH,
    composites: [
      { input: labelImg, left: 0, top: 0 },
      { input: bodyImg, left: 0, top: Math.round(LABEL_H * SCALE_ZOOM) }
    ]
  }
}

async function composeRow(panels, file) {
  const width = panels.reduce((s, p) => s + p.width, 0)
  const height = Math.max(...panels.map((p) => p.height))
  const composites = []
  let x = 0
  for (const panel of panels) {
    composites.push(...panel.composites.map((c) => ({ ...c, left: c.left + x })))
    x += panel.width
  }
  mkdirSync(path.dirname(file), { recursive: true })
  await sharp({ create: { width, height, channels: 3, background: '#ffffff' } })
    .composite(composites)
    .jpeg({ quality: 90, chromaSubsampling: '4:4:4' })
    .toFile(file)
  return file
}

function metricsAcceptance(root, variant) {
  const data = readJsonSafe(path.join(root, `metrics-${variant}.json`))
  const map = new Map()
  for (const row of data?.clips ?? []) {
    map.set(row.clip, {
      policy: row.policy,
      accepted: row.hybrid?.acceptedSideFrames ?? null,
      candidate: row.hybrid?.candidateFrames ?? null,
      handLeft: row.metrics?.handShiftLeftMaxCm ?? null,
      handRight: row.metrics?.handShiftRightMaxCm ?? null,
      body: row.metrics?.upperArmBodyDirChangeMaxDeg ?? null,
      aPose: row.metrics?.aPoseBodyHorizontalChangeMaxDeg ?? null
    })
  }
  return map
}


async function composeRecommended(root, outDir, clips, frames) {
  const rec = readJsonSafe(path.join(root, 'recommended.json'))
  let count = 0
  for (const clip of clips) {
    const meta = rec?.clips?.[clip]
    const variant = meta?.variant ?? 'recommended'
    for (const frame of frames) {
      const name = `${clip}-${frame}`
      const source = path.join(root, 'render-source-zome', `${name}.png`)
      const before = path.join(root, 'render-before', `${name}.png`)
      const after = path.join(root, 'render-recommended', `${name}.png`)
      if (!existsSync(source) || !existsSync(before) || !existsSync(after)) continue
      const panels = []
      panels.push(await fullPanel(source, `SOURCE Zome (canonical) ${clip} f${frame}`, COLORS.source))
      panels.push(await fullPanel(before, `BEFORE male ${clip} f${frame}`, COLORS.before))
      panels.push(await fullPanel(after, `RECOMMENDED ${variant} ${clip} f${frame}`, COLORS.hybrid))
      await composeRow(panels, path.join(outDir, 'recommended', `${name}-ab.jpg`))
      count += 1
      if (!(clip === 'sleep')) {
        const zoomPanels = []
        zoomPanels.push(await cropPanel(before, SHOULDER_BOX, `BEFORE male ${clip} f${frame}`, COLORS.before))
        zoomPanels.push(await cropPanel(after, SHOULDER_BOX, `RECOMMENDED ${variant} ${clip} f${frame}`, COLORS.hybrid))
        await composeRow(zoomPanels, path.join(outDir, 'recommended-shoulder', `${name}-zoom.jpg`))
        count += 1
      }
      if (CONTACT_CLIPS.has(clip) && CONTACT_BOX[clip]) {
        const box = CONTACT_BOX[clip]
        const contactPanels = []
        contactPanels.push(await cropPanel(before, box, `BEFORE male ${clip} f${frame}`, COLORS.before))
        contactPanels.push(await cropPanel(after, box, `RECOMMENDED ${variant} ${clip} f${frame}`, COLORS.hybrid))
        await composeRow(contactPanels, path.join(outDir, 'recommended-contact', `${name}-zoom.jpg`))
        count += 1
      }
    }
  }
  console.log(`[ab-v3] wrote ${count} recommended images -> ${path.relative(process.cwd(), outDir)}`)
}

async function main() {
  const { values, errors, sawHelp } = parseCliArgs(process.argv.slice(2), OPTIONS)
  if (sawHelp) { console.log(HELP); process.exit(0) }
  if (errors.length) { console.error(errors.join('\n')); console.error('\n' + HELP); process.exit(2) }
  const root = path.resolve(String(values.root))
  const outDir = path.resolve(root, String(values.out))
  const clips = String(values.clips).split(',').map((s) => s.trim()).filter(Boolean)
  const frames = String(values.frames).split(',').map((s) => s.trim()).filter(Boolean)
  if (values.recommended) {
    await composeRecommended(root, outDir, clips, frames)
    return
  }
  const label = {
    source: 'SOURCE Zome (canonical)',
    before: 'BEFORE male',
    abs: 'S2-absolute f=1.0',
    abs075: 'S2-absolute f=0.75',
    hybrid: 'HYBRID-absolute g=15°',
    strict: 'HYBRID-absolute g=4° (default)',
    blend: 'HYBRID blend p=0.7 g=15°',
    v2: 'v2 S2-only k=0.714'
  }
  const acceptG15 = metricsAcceptance(root, 'hybrid-absolute-g15')
  const acceptG04 = metricsAcceptance(root, 'hybrid-absolute-g04')
  const dirs = {
    source: 'render-source-zome',
    before: 'render-before',
    abs: 'render-s2-absolute',
    abs075: 'render-s2-absolute-f075',
    hybrid: 'render-hybrid-absolute-g15',
    strict: 'render-hybrid-absolute-g04',
    blend: 'render-hybrid-absolute-blend-g15',
    v2: 'render-v2-s2-socket'
  }
  let count = 0
  for (const clip of clips) {
    const isContact = CONTACT_CLIPS.has(clip)
    const isFallback = FALLBACK_CLIPS.has(clip)
    const isIdle = IDLE_GESTURE.has(clip)
    const isSleep = clip === 'sleep'
    const acc = acceptG15.get(clip)
    const accStrict = acceptG04.get(clip)
    const hybridLabel = isContact
      ? `${label.hybrid} [IK ${acc?.accepted ?? '—'}/${acc?.candidate ?? '—'}]`
      : `${label.hybrid} [policy=${acc?.policy ?? '—'}; no IK]`
    const strictLabel = `${label.strict} [IK ${accStrict?.accepted ?? '—'}/${accStrict?.candidate ?? '—'}]`

    for (const frame of frames) {
      const name = `${clip}-${frame}`
      const pathOf = (key) => path.join(root, dirs[key], `${name}.png`)
      const fullFiles = [
        ['source', pathOf('source'), label.source, COLORS.source],
        ['before', pathOf('before'), `${label.before} ${clip} f${frame}`, COLORS.before],
        ['abs', pathOf('abs'), `${label.abs} ${clip} f${frame}`, COLORS.abs],
        ['hybrid', pathOf('hybrid'), `${hybridLabel} ${clip} f${frame}`, COLORS.hybrid]
      ]
      if (isContact && existsSync(pathOf('blend'))) {
        fullFiles.push(['blend', pathOf('blend'), `${label.blend} ${clip} f${frame}`, COLORS.blend])
      } else if (isFallback && existsSync(pathOf('v2'))) {
        fullFiles.push(['v2', pathOf('v2'), `${label.v2} ${clip} f${frame}`, COLORS.v2])
      }
      if (fullFiles.every(([, file]) => existsSync(file))) {
        const panels = []
        for (const [, file, text, color] of fullFiles) panels.push(await fullPanel(file, text, color))
        await composeRow(panels, path.join(outDir, 'full', `${name}-ab.jpg`))
        count += 1
      }

      // 严格 4° 对照（接触类，仅 frame 000/050 控制输出量）
      if (isContact && (frame === '000' || frame === '050') && existsSync(pathOf('strict')) && existsSync(pathOf('abs')) && existsSync(pathOf('before'))) {
        const panels = []
        panels.push(await fullPanel(pathOf('before'), `${label.before} ${clip} f${frame}`, COLORS.before))
        panels.push(await fullPanel(pathOf('abs'), `${label.abs} ${clip} f${frame}`, COLORS.abs))
        panels.push(await fullPanel(pathOf('strict'), `${strictLabel} ${clip} f${frame}`, COLORS.strict))
        panels.push(await fullPanel(pathOf('hybrid'), `${hybridLabel} ${clip} f${frame}`, COLORS.hybrid))
        await composeRow(panels, path.join(outDir, 'strict', `${name}-ab.jpg`))
        count += 1
      }

      // 肩部放大
      if (!isSleep && existsSync(pathOf('before')) && existsSync(pathOf('abs')) && existsSync(pathOf('hybrid'))) {
        const panels = []
        panels.push(await cropPanel(pathOf('before'), SHOULDER_BOX, `${label.before} ${clip} f${frame}`, COLORS.before))
        if (isIdle) {
          panels.push(await cropPanel(pathOf('abs075'), SHOULDER_BOX, `${label.abs075} ${clip} f${frame}`, COLORS.abs))
          panels.push(await cropPanel(pathOf('abs'), SHOULDER_BOX, `${label.abs} ${clip} f${frame}`, COLORS.abs))
        } else {
          panels.push(await cropPanel(pathOf('abs'), SHOULDER_BOX, `${label.abs} ${clip} f${frame}`, COLORS.abs))
          panels.push(await cropPanel(pathOf('hybrid'), SHOULDER_BOX, `${hybridLabel} ${clip} f${frame}`, COLORS.hybrid))
          if (isContact && existsSync(pathOf('blend'))) {
            panels.push(await cropPanel(pathOf('blend'), SHOULDER_BOX, `${label.blend} ${clip} f${frame}`, COLORS.blend))
          } else if (isFallback && existsSync(pathOf('v2'))) {
            panels.push(await cropPanel(pathOf('v2'), SHOULDER_BOX, `${label.v2} ${clip} f${frame}`, COLORS.v2))
          }
        }
        await composeRow(panels, path.join(outDir, 'shoulder', `${name}-zoom.jpg`))
        count += 1
      }

      // 手/接触区放大（接触类）
      if (isContact && CONTACT_BOX[clip] && existsSync(pathOf('before')) && existsSync(pathOf('abs')) && existsSync(pathOf('hybrid'))) {
        const box = CONTACT_BOX[clip]
        const panels = []
        panels.push(await cropPanel(pathOf('before'), box, `${label.before} ${clip} f${frame}`, COLORS.before))
        panels.push(await cropPanel(pathOf('abs'), box, `${label.abs} ${clip} f${frame}`, COLORS.abs))
        panels.push(await cropPanel(pathOf('hybrid'), box, `${hybridLabel} ${clip} f${frame}`, COLORS.hybrid))
        if (existsSync(pathOf('blend'))) {
          panels.push(await cropPanel(pathOf('blend'), box, `${label.blend} ${clip} f${frame}`, COLORS.blend))
        } else if (existsSync(pathOf('v2'))) {
          panels.push(await cropPanel(pathOf('v2'), box, `${label.v2} ${clip} f${frame}`, COLORS.v2))
        }
        await composeRow(panels, path.join(outDir, 'contact', `${name}-zoom.jpg`))
        count += 1
      }
    }
  }
  console.log(`[ab-v3] wrote ${count} images -> ${path.relative(process.cwd(), outDir)}`)
}
main().catch((error) => {
  console.error('[ab-v3] FAIL:', error instanceof Error ? error.stack ?? error.message : String(error))
  process.exit(1)
})
