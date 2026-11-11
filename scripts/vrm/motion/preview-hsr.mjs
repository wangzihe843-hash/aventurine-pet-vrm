#!/usr/bin/env node
/**
 * V3：HSR 动作集无头预览（dev-only；static server + Electron + sharp 接触表）
 *
 *   node scripts/vrm/motion/preview-hsr.mjs --clips idle,idleShow,breaked \
 *        --out tests/tmp/hsr-motion/preview [--views front,side,threeQuarter,hand,feet]
 *   node scripts/vrm/motion/preview-hsr.mjs --all --out tests/tmp/hsr-motion/preview-all
 *
 * 依赖私有资产：`assets/motions/hsr/**`（gitignore）与目标 VRM。
 */
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'

import { parseCliArgs, formatHelp } from '../../unity-bake/lib/cli-args.mjs'
import { resolveVrmAsset } from './lib/vrm-rest.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const ELECTRON = path.join(ROOT, 'node_modules/.bin/electron')
const ENTRY = path.join(ROOT, 'scripts/vrm/motion/preview-electron.mjs')
const ELECTRON_USER_DATA_DIR = path.join(ROOT, 'tests/tmp/electron-userdata-hsr')

const DEFAULTS = {
  clips: 'idle,idleShow,breaked',
  frames: '0,0.25,0.5,0.75',
  views: 'front,side,threeQuarter,hand,feet',
  out: 'tests/tmp/hsr-motion/preview',
  'vrm-manifest': 'src/shared/vrm-manifest.json',
  'vrm-asset-id': 'aventurine-waveflair',
  'clips-dir': 'assets/motions/hsr',
  yaw: 'auto'
}

const OPTIONS = {
  clips: { type: 'string', default: DEFAULTS.clips, valueHint: 'a,b,c', description: '逗号分隔 clip id' },
  all: { type: 'boolean', default: false, description: '预览 clips-dir/index.json 里的全部 clip' },
  frames: { type: 'string', default: DEFAULTS.frames, valueHint: '0,0.25,0.5', description: '抓帧时间点（duration 百分比）' },
  views: { type: 'string', default: DEFAULTS.views, valueHint: 'front,side,threeQuarter,hand,feet', description: '视图列表' },
  out: { type: 'string', default: DEFAULTS.out, valueHint: 'dir', description: 'PNG 输出目录' },
  'clips-dir': { type: 'string', default: DEFAULTS['clips-dir'], valueHint: 'dir', description: 'clip 目录' },
  'vrm-manifest': { type: 'string', default: DEFAULTS['vrm-manifest'], valueHint: 'path', description: 'vrm-manifest.json' },
  'vrm-asset-id': { type: 'string', default: DEFAULTS['vrm-asset-id'], valueHint: 'id', description: '目标 VRM avatar id' },
  raw: { type: 'boolean', default: true, description: '是否应用 raw 次级骨通道（新 T-pose 资产 rawPolicy=spring，无 raw 数据）' },
  yaw: {
    type: 'string',
    default: DEFAULTS.yaw,
    valueHint: 'auto|<deg>',
    description: '朝向修正角：auto=按 vrm-manifest 的 yawOffsetDeg 匹配；0=模型规范面向 +Z'
  },
  sheet: { type: 'boolean', default: true, description: '结束后用 sharp 拼接触表' }
}

const HELP = formatHelp({
  command: 'node scripts/vrm/motion/preview-hsr.mjs',
  description: 'V3：在目标 VRM 上预览 HSR clip（humanoid + raw 次级骨），输出 PNG/接触表。',
  usage: 'node scripts/vrm/motion/preview-hsr.mjs [--clips a,b,c | --all] [--out <dir>]',
  options: OPTIONS,
  footer: 'PNG 与接触表输出到 --out（默认 tests/tmp/hsr-motion/preview，gitignore）。'
})

function toDisplayPath(target) {
  const rel = path.relative(process.cwd(), target)
  return rel && !rel.startsWith('..') ? rel : target
}

function fail(message, code = 1) {
  console.error(`[preview-hsr] ERROR: ${message}`)
  process.exit(code)
}

/** 读 PNG 拼 网格 接触表（rows=views × cols=frames）。 */
async function buildSheets(outDir, clipIds, views, fractions) {
  for (const clipId of clipIds) {
    const rows = []
    for (const view of views) {
      const row = []
      for (const fraction of fractions) {
        const suffix = String(Math.round(fraction * 100)).padStart(3, '0')
        const file = path.join(outDir, `${clipId}-${view}-${suffix}.png`)
        if (fs.existsSync(file)) row.push(file)
      }
      if (row.length > 0) rows.push(row)
    }
    if (rows.length === 0) continue
    const tiles = await Promise.all(rows.flat().map((file) => sharp(file).ensureAlpha().png().toBuffer()))
    const meta = await sharp(tiles[0]).metadata()
    const width = meta.width
    const height = meta.height
    const cols = Math.max(...rows.map((row) => row.length))
    const canvasWidth = width * cols
    const canvasHeight = height * rows.length
    const composites = []
    for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
      for (let colIndex = 0; colIndex < rows[rowIndex].length; colIndex += 1) {
        const tile = tiles.shift()
        composites.push({ input: tile, left: colIndex * width, top: rowIndex * height })
      }
    }
    const sheetPath = path.join(outDir, `${clipId}-sheet.jpg`)
    await sharp({
      create: { width: canvasWidth, height: canvasHeight, channels: 3, background: { r: 30, g: 30, b: 30 } }
    })
      .composite(composites)
      .flatten({ background: { r: 30, g: 30, b: 30 } })
      .jpeg({ quality: 88 })
      .toFile(sheetPath)
    console.log(`[preview-hsr] sheet ${clipId} -> ${toDisplayPath(sheetPath)}`)
  }
}

/**
 * 朝向修正角（与 src/shared/vrm.ts 的 yawOffsetDeg 同语义，和 U-lane preview 一致）：
 * - 显式 --yaw 优先；
 * - 否则按 VRM 路径相对匹配 src/shared/vrm-manifest.json 的 yawOffsetDeg；
 * - 匹配不到按 0（VRM 规范面向 +Z；VRM0 已由 three-vrm rotateVRM0 归一化）。
 */
function resolveYawDeg(vrmRelativePath, explicitYaw) {
  if (explicitYaw !== 'auto' && explicitYaw !== undefined && explicitYaw !== null && explicitYaw !== '') {
    const parsed = Number(explicitYaw)
    if (!Number.isFinite(parsed) || parsed < -360 || parsed > 360) fail(`--yaw 非法：${explicitYaw}`, 2)
    return parsed
  }
  const manifestPath = path.join(ROOT, 'src/shared/vrm-manifest.json')
  if (!fs.existsSync(manifestPath)) return 0
  try {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
    const target = vrmRelativePath.split(path.sep).join('/')
    const avatar = (manifest.avatars ?? []).find((entry) => {
      if (!entry || typeof entry.file !== 'string') return false
      const normalized = entry.file.split(path.sep).join('/')
      return target.endsWith(normalized) || target.endsWith(path.basename(normalized))
    })
    if (avatar && Number.isFinite(avatar.yawOffsetDeg)) return avatar.yawOffsetDeg
  } catch {
    // manifest 缺失/损坏按 0 处理，不影响抓帧
  }
  return 0
}

async function main() {
  const { values, errors, sawHelp } = parseCliArgs(process.argv.slice(2), OPTIONS)
  if (sawHelp) {
    console.log(HELP)
    return
  }
  for (const error of errors) console.error(`[preview-hsr] ${error}`)
  if (errors.length > 0) process.exit(2)

  const clipsDir = path.resolve(String(values['clips-dir']))
  const outDir = path.resolve(String(values.out))
  const fractions = String(values.frames)
    .split(',')
    .map((value) => Number(value))
    .filter((value) => Number.isFinite(value))
  const views = String(values.views)
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean)

  let clipIds = String(values.clips)
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean)
  if (values.all === true) {
    const indexFile = path.join(clipsDir, 'index.json')
    if (!fs.existsSync(indexFile)) fail(`--all 需要 ${indexFile}（先跑 build-hsr-manifest.mjs）`)
    clipIds = Object.keys(JSON.parse(fs.readFileSync(indexFile, 'utf8')).clips ?? {})
  }
  if (clipIds.length === 0) fail('没有可预览的 clip')

  const vrm = resolveVrmAsset(path.resolve(String(values['vrm-manifest'])), path.join(ROOT, 'assets'), String(values['vrm-asset-id']))
  if (!fs.existsSync(vrm.file)) fail(`VRM 不存在：${vrm.file}`)
  if (!fs.existsSync(ELECTRON)) fail(`electron 不存在：${ELECTRON}（先 pnpm install）`)

  const vrmRelative = path.relative(ROOT, vrm.file)
  if (vrmRelative.startsWith('..')) fail('VRM 必须位于仓库内（HTTP 静态服务限制）')
  const yawDeg = resolveYawDeg(vrmRelative, values.yaw)

  fs.mkdirSync(outDir, { recursive: true })
  fs.mkdirSync(ELECTRON_USER_DATA_DIR, { recursive: true })

  const server = http.createServer((request, response) => {
    try {
      const url = new URL(request.url, 'http://127.0.0.1')
      const relative = decodeURIComponent(url.pathname)
      const file = path.join(ROOT, relative)
      if (!file.startsWith(ROOT) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
        response.writeHead(404)
        response.end('not found')
        return
      }
      const extension = path.extname(file).toLowerCase()
      const mime = {
        '.html': 'text/html; charset=utf-8',
        '.js': 'text/javascript; charset=utf-8',
        '.mjs': 'text/javascript; charset=utf-8',
        '.json': 'application/json; charset=utf-8',
        '.png': 'image/png',
        '.vrm': 'application/octet-stream',
        '.glb': 'model/gltf-binary',
        '.bin': 'application/octet-stream'
      }[extension] || 'application/octet-stream'
      response.writeHead(200, { 'content-type': mime })
      fs.createReadStream(file).pipe(response)
    } catch (error) {
      response.writeHead(500)
      response.end(String(error))
    }
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const { port } = server.address()
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  Object.assign(env, {
    PREVIEW_BASE: `http://127.0.0.1:${port}`,
    PREVIEW_OUT: outDir,
    PREVIEW_VRM: vrmRelative,
    PREVIEW_CLIPS: clipIds.join(','),
    PREVIEW_VIEWS: views.join(','),
    PREVIEW_FRAMES: fractions.join(','),
    PREVIEW_RAW: values.raw === false ? '0' : '1',
    PREVIEW_YAW: String(yawDeg),
    PREVIEW_CLIP_PREFIX: path.relative(ROOT, clipsDir)
  })
  console.log(
    `[preview-hsr] server :${port} vrm=${vrmRelative} yaw=${yawDeg} clips=${clipIds.length} views=${views.join(',')} out=${toDisplayPath(outDir)}`
  )
  const child = spawn(ELECTRON, ['--no-sandbox', `--user-data-dir=${ELECTRON_USER_DATA_DIR}`, ENTRY], {
    cwd: ROOT,
    env,
    stdio: 'inherit'
  })
  const code = await new Promise((resolve) => {
    child.on('exit', (exitCode) => resolve(exitCode ?? 1))
  })
  server.close()
  if (code !== 0) fail(`electron exit code=${code}`)
  if (values.sheet !== false) {
    await buildSheets(outDir, clipIds, views, fractions)
  }
  console.log(`[preview-hsr] OK：${toDisplayPath(outDir)}`)
}

main().catch((error) => {
  console.error(`[preview-hsr] FAIL：${error instanceof Error ? error.stack ?? error.message : String(error)}`)
  process.exit(1)
})
