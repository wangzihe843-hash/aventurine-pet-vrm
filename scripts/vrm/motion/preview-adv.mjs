#!/usr/bin/env node
/**
 * V3.2 adv：Biped 动作集无头预览（dev-only；static server + Electron + sharp 接触表）
 *
 *   node scripts/vrm/motion/preview-adv.mjs --clips idle,walk,skill01 \
 *        --out tests/tmp/adv-motion/preview [--views front,side,threeQuarter,hand,feet]
 *   node scripts/vrm/motion/preview-adv.mjs --all --out tests/tmp/adv-motion/preview-all
 *
 * 由 `preview-hsr.mjs` 泛化而来（独立文件，不改 HSR 版）：
 * - 默认 clip 目录 `assets/motions/adv`、输出 `tests/tmp/adv-motion/preview`、
 *   Electron userData `tests/tmp/electron-userdata-adv`（与 HSR 预览互不加锁）；
 * - 渲染逻辑完全复用仓库内既有 Electron 入口 `preview-electron.mjs` + `viewer.html/viewer.js`
 *   （three-vrm normalized humanoid + SpringBone delta 步进），本文件只做编排/接触表；
 * - `--all` 读 `<clips-dir>/index.json`（先跑 build-adv-manifest.mjs），并校验 index.set === "adv"
 *   防止误对 HSR 目录。
 *
 * 依赖私有资产：`assets/motions/adv/**`（gitignore）与目标 VRM。
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
const ELECTRON_USER_DATA_DIR = path.join(ROOT, 'tests/tmp/electron-userdata-adv')
const SET = 'adv'

const DEFAULTS = {
  clips: 'idle,idle2,idleShow,walk,skill01',
  frames: '0,0.25,0.5,0.75',
  views: 'front,side,threeQuarter,hand,feet',
  out: `tests/tmp/${SET}-motion/preview`,
  'vrm-manifest': 'src/shared/vrm-manifest.json',
  'vrm-asset-id': 'aventurine-waveflair',
  'clips-dir': `assets/motions/${SET}`,
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
  raw: { type: 'boolean', default: true, description: '是否应用 raw 次级骨通道（adv 目标 rawPolicy=spring，无 raw 数据）' },
  prop: { type: 'string', default: '', valueHint: 'path', description: '手持道具 GLB（repo 相对路径；如 assets/props/watergun/watergun.glb）' },
  'prop-calib': { type: 'string', default: '', valueHint: 'path', description: '道具挂点标定数据 JSON（Blender 导出的枪世界变换 samples）' },
  'prop-calib-clip': { type: 'string', default: '', valueHint: 'id', description: '用哪个 clip 做标定（默认第一个 clip）' },
  'prop-hold': { type: 'string', default: '', valueHint: 'a,b,c', description: '持道具的 clip id 列表（其余 clip 隐藏道具）' },
  'prop-transform': { type: 'string', default: '', valueHint: 'path', description: '固定挂载变换 JSON（如 src/renderer/src/vrm/watergun-attach.json；优先于 --prop-calib）' },
  yaw: {
    type: 'string',
    default: DEFAULTS.yaw,
    valueHint: 'auto|<deg>',
    description: '朝向修正角：auto=按 vrm-manifest 的 yawOffsetDeg 匹配；0=模型规范面向 +Z'
  },
  sheet: { type: 'boolean', default: true, description: '结束后用 sharp 拼接触表（--sheet=false 关闭）' }
}

const HELP = formatHelp({
  command: 'node scripts/vrm/motion/preview-adv.mjs',
  description: 'V3.2：在目标 VRM 上预览 adv（3ds Max Biped）clip（humanoid + SpringBone），输出 PNG/接触表。',
  usage: 'node scripts/vrm/motion/preview-adv.mjs [--clips a,b,c | --all] [--out <dir>] [--views ...]',
  options: OPTIONS,
  footer: `PNG 与接触表输出到 --out（默认 ${DEFAULTS.out}，gitignore）；--all 需要先跑 build-adv-manifest.mjs。`
})

function toDisplayPath(target) {
  const rel = path.relative(process.cwd(), target)
  return rel && !rel.startsWith('..') ? rel : target
}

function fail(message, code = 1) {
  console.error(`[preview-adv] ERROR: ${message}`)
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
    console.log(`[preview-adv] sheet ${clipId} -> ${toDisplayPath(sheetPath)}`)
  }
}

/**
 * 朝向修正角（与 src/shared/vrm.ts 的 yawOffsetDeg 同语义，和 HSR/U-lane preview 一致）：
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
  for (const error of errors) console.error(`[preview-adv] ${error}`)
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
    if (!fs.existsSync(indexFile)) fail(`--all 需要 ${toDisplayPath(indexFile)}（先跑 build-adv-manifest.mjs）`)
    const indexDoc = JSON.parse(fs.readFileSync(indexFile, 'utf8'))
    if (indexDoc.set !== undefined && indexDoc.set !== SET) {
      fail(`index.json set=${JSON.stringify(indexDoc.set)} ≠ "${SET}"，检查 --clips-dir：${toDisplayPath(clipsDir)}`)
    }
    clipIds = Object.keys(indexDoc.clips ?? {})
  }
  if (clipIds.length === 0) fail('没有可预览的 clip')

  const prop = String(values.prop || '').trim()
  const propHold = String(values['prop-hold'] || '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean)
  let propFile = ''
  let propCalibFile = ''
  let propTransformFile = ''
  if (prop) {
    const absolute = path.resolve(ROOT, prop)
    if (!fs.existsSync(absolute)) fail(`道具 GLB 不存在：${prop}`)
    if (!absolute.startsWith(ROOT + path.sep)) fail('道具 GLB 必须位于仓库内')
    propFile = path.relative(ROOT, absolute)
    if (values['prop-calib']) {
      const calibAbsolute = path.resolve(ROOT, String(values['prop-calib']))
      if (!fs.existsSync(calibAbsolute)) fail(`道具标定 JSON 不存在：${values['prop-calib']}`)
      propCalibFile = calibAbsolute
    }
    if (values['prop-transform']) {
      const transformAbsolute = path.resolve(ROOT, String(values['prop-transform']))
      if (!fs.existsSync(transformAbsolute)) fail(`道具挂载变换 JSON 不存在：${values['prop-transform']}`)
      propTransformFile = transformAbsolute
    }
  }

  const vrm = resolveVrmAsset(
    path.resolve(String(values['vrm-manifest'])),
    path.join(ROOT, 'assets'),
    String(values['vrm-asset-id'])
  )
  if (!fs.existsSync(vrm.file)) fail(`VRM 不存在：${vrm.file}`)
  if (!fs.existsSync(ELECTRON)) fail(`electron 不存在：${ELECTRON}（先 pnpm install）`)
  for (const clipId of clipIds) {
    if (!fs.existsSync(path.join(clipsDir, `${clipId}.json`))) {
      fail(`clip 不存在：${path.join(toDisplayPath(clipsDir), `${clipId}.json`)}（--clips / index.json 与目录不一致）`)
    }
  }

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
    PREVIEW_CLIP_PREFIX: path.relative(ROOT, clipsDir),
    PREVIEW_ROOT: ROOT,
    PREVIEW_PROP: propFile,
    PREVIEW_PROP_CALIB: propCalibFile,
    PREVIEW_PROP_CALIB_CLIP: String(values['prop-calib-clip'] || ''),
    PREVIEW_PROP_HOLD: propHold.join(','),
    PREVIEW_PROP_TRANSFORM: propTransformFile,
    PREVIEW_PROP_BONE: String(process.env.PREVIEW_PROP_BONE || '')
  })
  console.log(
    `[preview-adv] server :${port} vrm=${vrmRelative} yaw=${yawDeg} clips=${clipIds.length} views=${views.join(',')} out=${toDisplayPath(outDir)}` +
      (propFile
        ? ` prop=${propFile} hold=${propHold.join('|') || '-'} calib=${propCalibFile || '-'} transform=${propTransformFile || '-'}`
        : '')
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
  console.log(`[preview-adv] OK：${toDisplayPath(outDir)}`)
}

main().catch((error) => {
  console.error(`[preview-adv] FAIL：${error instanceof Error ? error.stack ?? error.message : String(error)}`)
  process.exit(1)
})
