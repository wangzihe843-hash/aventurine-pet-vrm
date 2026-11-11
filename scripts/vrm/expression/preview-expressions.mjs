#!/usr/bin/env node
/**
 * V6 表情层：three-vrm 表情预览 + 接触表（dev-only）
 *
 *   node scripts/vrm/expression/preview-expressions.mjs \
 *     --vrm assets/vrm/aventurine-tpose.vrm \
 *     --dir assets/expressions \
 *     --out tests/tmp/expression/preview [--mode presets|clips|combo|all] [--sheet]
 *
 * 依赖私有资产：目标 VRM + assets/expressions/**（gitignore）。产物写 --out（gitignore）。
 *
 * 三种模式：
 * - `presets`：逐个 VRM expression preset（happy/angry/sad/relaxed/surprised/blink/blinkLeft/
 *   blinkRight/aa/ih/ou/ee/oh + neutral 基线）脸特写 + 情绪 preset 全身；证明目标模型表情包可用；
 * - `clips`：`assets/expressions/manifest.json` 里每条 clip 在若干时间点采样权重 → 脸特写帧；
 * - `combo`：代表性运行时组合（情绪+眨眼 override / 说话口型 / 拖拽 clip 叠加）——用于目检
 *   `VRMExpressionDriver` 的合成规则在真实模型上的观感。
 *
 * 退出码：0 成功；1 失败；2 非法参数。
 */
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import sharp from 'sharp'

import { formatHelp, parseCliArgs } from '../../unity-bake/lib/cli-args.mjs'
import { resolveVrmAsset } from '../motion/lib/vrm-rest.mjs'
import { sampleExpressionClip } from './lib/expression-clip.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const ELECTRON = path.join(ROOT, 'node_modules/.bin/electron')
const ENTRY = path.join(ROOT, 'scripts/vrm/expression/preview-electron.mjs')
const ELECTRON_USER_DATA_DIR = path.join(ROOT, 'tests/tmp/electron-userdata-expression')

const PRESET_NAMES = ['happy', 'angry', 'sad', 'relaxed', 'surprised', 'blink', 'blinkLeft', 'blinkRight', 'aa', 'ih', 'ou', 'ee', 'oh']
const EMOTION_FULL_BODY = ['happy', 'angry', 'sad', 'relaxed', 'surprised']

const OPTIONS = {
  vrm: {
    type: 'string',
    default: '',
    valueHint: 'path',
    description: '目标 VRM 路径（缺省按 --vrm-manifest/--vrm-asset-id 解析）'
  },
  dir: { type: 'string', default: 'assets/expressions', valueHint: 'dir', description: '表情 clip 根目录（manifest.json + <set>/*.json）' },
  out: { type: 'string', default: 'tests/tmp/expression/preview', valueHint: 'dir', description: 'PNG/接触表输出目录' },
  mode: { type: 'string', default: 'all', valueHint: 'presets|clips|combo|all', description: '预览模式' },
  frames: { type: 'string', default: '0,0.25,0.5,0.75', valueHint: '0,0.25,0.5', description: 'clips 模式采样时间点（duration 百分比）' },
  clips: { type: 'string', default: '', valueHint: 'a,b', description: 'clips 模式只预览指定 clip id（缺省全部）' },
  sheet: { type: 'boolean', default: true, description: '结束后用 sharp 拼接触表' },
  'vrm-manifest': { type: 'string', default: 'src/shared/vrm-manifest.json', valueHint: 'path', description: 'VRM 注册表（解析目标 VRM）' },
  'vrm-asset-id': { type: 'string', default: 'aventurine-waveflair', valueHint: 'id', description: '目标 avatar id' },
  yaw: { type: 'string', default: 'auto', valueHint: 'auto|<deg>', description: '朝向修正角（auto = 按 vrm-manifest 的 yawOffsetDeg）' }
}

const HELP = formatHelp({
  command: 'node scripts/vrm/expression/preview-expressions.mjs',
  description: 'V6 表情层：在目标 VRM 上渲染 preset/clip/组合表情静帧 + 接触表。',
  usage: 'node scripts/vrm/expression/preview-expressions.mjs [--vrm <path>] [--dir <dir>] [--out <dir>] [--mode all]',
  options: OPTIONS,
  footer: '输出：<out>/*.png + *-sheet.jpg；需本机 Electron + 私有 assets（gitignore）。'
})

function fail(message, code = 1) {
  console.error(`[preview-expressions] ERROR: ${message}`)
  process.exit(code)
}

function toDisplayPath(target) {
  const rel = path.relative(process.cwd(), target)
  return rel && !rel.startsWith('..') ? rel : target
}

/** 朝向修正角（auto = 按 vrm-manifest 匹配 yawOffsetDeg；与 U/V lane 预览一致）。 */
function resolveYawDeg(vrmRelativePath, explicitYaw) {
  if (explicitYaw !== undefined && explicitYaw !== null && explicitYaw !== '' && explicitYaw !== 'auto') {
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
    // 忽略 manifest 解析问题
  }
  return 0
}

/** 转义 XML 文本（标签用）。 */
function escapeXml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/** 给单张 PNG 底部加标签条（返回新 buffer）。 */
async function labelTile(file, label) {
  const buffer = await sharp(file).ensureAlpha().png().toBuffer()
  if (!label) return buffer
  const meta = await sharp(buffer).metadata()
  const stripHeight = 40
  const svg = Buffer.from(
    `<svg width="${meta.width}" height="${stripHeight}" xmlns="http://www.w3.org/2000/svg">` +
      `<rect width="100%" height="100%" fill="#1a1a1a"/>` +
      `<text x="12" y="27" font-family="Helvetica, Arial, sans-serif" font-size="20" fill="#e6e6e6">${escapeXml(label)}</text>` +
      `</svg>`
  )
  return sharp(buffer)
    .extend({ bottom: stripHeight, background: { r: 26, g: 26, b: 26, alpha: 1 } })
    .composite([{ input: svg, left: 0, top: meta.height }])
    .png()
    .toBuffer()
}

/** 拼接触表：`rows` = 文件路径二维数组；`labels` = 文件路径 → 标签文本。 */
async function buildSheet(outDir, name, rows, cols, labels = new Map()) {
  const files = rows.flat()
  if (files.length === 0) return null
  const tiles = await Promise.all(files.map((file) => labelTile(file, labels.get(file))))
  const meta = await sharp(tiles[0]).metadata()
  const width = meta.width
  const height = meta.height
  const canvasWidth = width * cols
  const canvasHeight = height * rows.length
  const composites = []
  for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
    for (let colIndex = 0; colIndex < rows[rowIndex].length; colIndex += 1) {
      const tile = tiles.shift()
      composites.push({ input: tile, left: colIndex * width, top: rowIndex * height })
    }
  }
  const sheetPath = path.join(outDir, `${name}.jpg`)
  await sharp({
    create: { width: canvasWidth, height: canvasHeight, channels: 3, background: { r: 26, g: 26, b: 26 } }
  })
    .composite(composites)
    .flatten({ background: { r: 26, g: 26, b: 26 } })
    .jpeg({ quality: 88 })
    .toFile(sheetPath)
  return sheetPath
}

function chunk(items, size) {
  const rows = []
  for (let index = 0; index < items.length; index += size) rows.push(items.slice(index, index + size))
  return rows
}

/** 构建 preview plan（每项 = 一次截图）。 */
function buildPlan({ mode, dir, frames, clipFilters }) {
  const plan = []
  const groups = []
  /** @type {Map<string, string>} id → 接触表标签 */
  const labels = new Map()
  if (mode === 'presets' || mode === 'all') {
    // neutral 基线（权重全 0）
    plan.push({ id: 'preset-neutral', view: 'face', weights: {} })
    labels.set('preset-neutral', 'neutral（全零基线）')
    for (const name of PRESET_NAMES) {
      plan.push({ id: `preset-${name}`, view: 'face', weights: { [name]: 1 } })
      labels.set(`preset-${name}`, `${name} ×1.0`)
    }
    for (const name of EMOTION_FULL_BODY) {
      plan.push({ id: `full-${name}`, view: 'full', weights: { [name]: 1 } })
      labels.set(`full-${name}`, `${name} ×1.0（全身）`)
    }
    groups.push({ name: 'presets-face', files: ['preset-neutral', ...PRESET_NAMES.map((name) => `preset-${name}`)], cols: 4 })
    groups.push({ name: 'presets-full', files: EMOTION_FULL_BODY.map((name) => `full-${name}`), cols: 5 })
  }

  /** @type {Array<{ entry: object, clip: object }>} */
  const clips = []
  if (mode === 'clips' || mode === 'all' || mode === 'combo') {
    const manifestPath = path.join(dir, 'manifest.json')
    if (!fs.existsSync(manifestPath)) fail(`clips/combo 模式需要 manifest：${toDisplayPath(manifestPath)}（先跑 build-expression-manifest.mjs）`)
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
    const filterSet = new Set(clipFilters.map((item) => item.trim()).filter(Boolean))
    for (const entry of manifest.clips ?? []) {
      if (filterSet.size > 0 && !filterSet.has(entry.id)) continue
      const filePath = path.join(dir, entry.file.split('/').join(path.sep))
      if (!fs.existsSync(filePath)) {
        console.error(`[preview-expressions] WARN：clip 文件缺失，跳过 ${entry.id}（${toDisplayPath(filePath)}）`)
        continue
      }
      clips.push({ entry, clip: JSON.parse(fs.readFileSync(filePath, 'utf8')) })
    }
  }

  if (mode === 'clips' || mode === 'all') {
    for (const { entry, clip } of clips) {
      const times = frames.map((fraction) => Math.min(1, Math.max(0, fraction)) * clip.duration)
      times.forEach((time, index) => {
        const suffix = String(Math.round(frames[index] * 100)).padStart(3, '0')
        const captureId = `clip-${entry.set}-${entry.id}-f${suffix}`
        plan.push({
          id: captureId,
          view: 'face',
          weights: sampleExpressionClip(clip, time)
        })
        labels.set(captureId, `${entry.id} ${Math.round(frames[index] * 100)}%`)
      })
      groups.push({
        name: `clip-${entry.set}-${entry.id}-sheet`,
        files: times.map((_, index) => `clip-${entry.set}-${entry.id}-f${String(Math.round(frames[index] * 100)).padStart(3, '0')}`),
        cols: times.length
      })
    }
  }

  if (mode === 'combo' || mode === 'all') {
    // 代表性运行时组合（与 VRMExpressionDriver 的合成规则一致；目标模型 happy/relaxed
    // 自带 overrideBlink=blend，three-vrm 会自动压 blink，这里用「名义权重」渲染）。
    const combos = [
      { id: 'combo-happy-override-blink', weights: { happy: 0.55, blink: 0.9 }, note: 'happy(0.55)+blink(0.9)：overrideBlink=blend 自动压眨眼' },
      { id: 'combo-relaxed-sit', weights: { relaxed: 0.5 }, note: 'sit 基态 relaxed 0.5' },
      { id: 'combo-sad-speaking', weights: { sad: 0.6, aa: 0.62 }, note: 'DSH error sad 0.6 + 说话 aa 0.62' },
      { id: 'combo-surprised-poke', weights: { surprised: 0.6 }, note: '被戳反应 surprised 0.6' }
    ]
    const dragClip = clips.find((item) => item.entry.id === 'faceDrag')
    if (dragClip) {
      combos.push({
        id: 'combo-drag-clip-mid',
        weights: sampleExpressionClip(dragClip.clip, dragClip.clip.duration * 0.5),
        note: '拖拽中：faceDrag clip 采样'
      })
    }
    const talkClip = clips.find((item) => item.entry.id === 'petTalking')
    if (talkClip) {
      combos.push({
        id: 'combo-talk-clip-mid',
        weights: sampleExpressionClip(talkClip.clip, talkClip.clip.duration * 0.5),
        note: 'Mate-Engine 口型 clip 采样（petTalking）'
      })
    }
    for (const combo of combos) {
      plan.push({ id: combo.id, view: 'face', weights: combo.weights })
      labels.set(combo.id, combo.note ?? combo.id)
    }
    groups.push({ name: 'combos', files: combos.map((combo) => combo.id), cols: 3 })
  }
  return { plan, groups, labels }
}

async function main() {
  const { values, errors, sawHelp } = parseCliArgs(process.argv.slice(2), OPTIONS)
  if (sawHelp) {
    process.stdout.write(HELP)
    process.exit(0)
  }
  if (errors.length > 0) {
    console.error(errors.join('\n'))
    process.stderr.write('\n' + HELP)
    process.exit(2)
  }
  const mode = String(values.mode)
  if (!['presets', 'clips', 'combo', 'all'].includes(mode)) fail(`--mode 非法：${mode}`, 2)

  let vrmPath
  if (values.vrm) {
    vrmPath = path.resolve(ROOT, String(values.vrm))
  } else {
    const resolved = resolveVrmAsset(path.resolve(ROOT, String(values['vrm-manifest'])), path.join(ROOT, 'assets'), String(values['vrm-asset-id']))
    vrmPath = resolved.file
  }
  if (!fs.existsSync(vrmPath)) fail(`VRM 不存在：${toDisplayPath(vrmPath)}`)
  if (!fs.existsSync(ELECTRON)) fail(`electron 不存在：${ELECTRON}（先 pnpm install）`)
  const vrmRelative = path.relative(ROOT, vrmPath)
  if (vrmRelative.startsWith('..')) fail('VRM 必须位于仓库内（HTTP 静态服务限制）')
  const dir = path.resolve(ROOT, String(values.dir))
  const outDir = path.resolve(ROOT, String(values.out))
  const frames = String(values.frames)
    .split(',')
    .map((item) => Number(item))
    .filter((item) => Number.isFinite(item))
  if (frames.length === 0) fail('--frames 非法', 2)
  const clipFilters = String(values.clips)
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
  const yawDeg = resolveYawDeg(vrmRelative, values.yaw)

  const { plan, groups, labels } = buildPlan({ mode, dir, frames, clipFilters })
  if (plan.length === 0) fail('plan 为空（检查 --mode/--dir/--clips）')

  fs.mkdirSync(outDir, { recursive: true })
  fs.mkdirSync(ELECTRON_USER_DATA_DIR, { recursive: true })
  const planPath = path.join(outDir, 'plan.json')
  fs.writeFileSync(planPath, JSON.stringify(plan, null, 2) + '\n')

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
      const mime =
        {
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
    EXPR_BASE: `http://127.0.0.1:${port}`,
    EXPR_OUT: outDir,
    EXPR_VRM: vrmRelative,
    EXPR_PLAN: planPath,
    EXPR_YAW: String(yawDeg)
  })
  console.log(`[preview-expressions] server :${port} vrm=${vrmRelative} yaw=${yawDeg} mode=${mode} captures=${plan.length} out=${toDisplayPath(outDir)}`)
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
    const sheets = []
    for (const group of groups) {
      const files = group.files.map((id) => path.join(outDir, `${id}.png`)).filter((file) => fs.existsSync(file))
      if (files.length === 0) continue
      const rows = chunk(files, group.cols ?? 4)
      const labelMap = new Map(files.map((file) => [file, labels.get(path.basename(file, '.png')) ?? '']))
      const sheet = await buildSheet(outDir, group.name, rows, group.cols ?? 4, labelMap)
      if (sheet) {
        sheets.push(toDisplayPath(sheet))
        console.log(`[preview-expressions] sheet -> ${toDisplayPath(sheet)}`)
      }
    }
    fs.writeFileSync(
      path.join(outDir, 'summary.json'),
      JSON.stringify({ generatedAt: new Date().toISOString(), vrm: vrmRelative, yawDeg, mode, captures: plan.length, sheets }, null, 2) + '\n'
    )
  }
  console.log(`[preview-expressions] OK：${toDisplayPath(outDir)}`)
}

main().catch((error) => {
  console.error(`[preview-expressions] FAIL：${error instanceof Error ? error.stack ?? error.message : String(error)}`)
  process.exit(1)
})
