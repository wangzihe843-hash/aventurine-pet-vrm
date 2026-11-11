#!/usr/bin/env node
/**
 * U2 clip preview launcher（dev-only）
 *
 *   node scripts/unity-bake/preview-clips.mjs --clips idle,sitWindow,walk
 *   node scripts/unity-bake/preview-clips.mjs --all --vrm assets/vrm/aventurine-tpose.vrm \
 *        --out tests/tmp/clip-preview --metrics tests/tmp/clip-preview/metrics --sheet
 *
 * 启动静态服务器 + Electron（scripts/unity-bake/preview-electron.mjs），把
 * assets/motions/mate/<clip>.json 应用到 VRM：
 * - 抓帧 PNG → `--out`（默认 tests/tmp/clip-preview）；
 * - `--metrics DIR` → 每个 clip 写 `<clip>.metrics.json`（自然度度量，见 clip-viewer.mjs metrics()）；
 * - `--all` → 从 assets/motions/mate/index.json 读全部 clip；
 * - `--sheet` → 结束后生成接触表（复用 contact-sheets.mjs）。
 *
 * 本机 DSH 沙箱下 Electron 必须带 `--no-sandbox` 与工作区内的 `--user-data-dir`
 * （默认 tests/tmp/electron-userdata），否则无法启动/加载 VRM（Lead 已验证）。
 */
import http from 'node:http'
import { createReadStream, existsSync, mkdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import process from 'node:process'
import { parseCliArgs, formatHelp } from './lib/cli-args.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const ELECTRON = path.join(ROOT, 'node_modules/.bin/electron')
const ENTRY = path.join(ROOT, 'scripts/unity-bake/preview-electron.mjs')
const INDEX_FILE = path.join(ROOT, 'assets/motions/mate/index.json')
const VRM_MANIFEST_FILE = path.join(ROOT, 'src/shared/vrm-manifest.json')
const ELECTRON_USER_DATA_DIR = path.join(ROOT, 'tests/tmp/electron-userdata')

const DEFAULTS = {
  vrm: 'assets/vrm/aventurine-tpose.vrm',
  clips: 'idle,sitWindow,walk',
  frames: '0,0.25,0.5,0.75',
  out: 'tests/tmp/clip-preview'
}

const OPTIONS = {
  vrm: {
    type: 'string',
    default: DEFAULTS.vrm,
    valueHint: 'path',
    description: 'VRM 模型路径（仓库根相对/绝对）'
  },
  clips: {
    type: 'string',
    default: DEFAULTS.clips,
    valueHint: 'a,b,c',
    description: '逗号分隔的 clip 名'
  },
  frames: {
    type: 'string',
    default: DEFAULTS.frames,
    valueHint: '0,0.25,0.5,0.75',
    description: '抓帧时间点（duration 的百分比）'
  },
  all: {
    type: 'boolean',
    default: false,
    description: '从 index.json 预览全部 clip（优先于 --clips）'
  },
  out: {
    type: 'string',
    default: DEFAULTS.out,
    valueHint: 'dir',
    description: 'PNG 输出目录'
  },
  metrics: {
    type: 'string',
    valueHint: 'dir',
    description: '自然度度量 JSON 输出目录（不设则不度量）'
  },
  sheet: {
    type: 'boolean',
    default: false,
    description: '结束后生成接触表 JPG（contact-sheets.mjs）'
  },
  yaw: {
    type: 'string',
    valueHint: 'deg',
    description: '朝向修正角（默认按 vrm-manifest 的 yawOffsetDeg 自动匹配；0 = 面向 +Z）'
  }
}

const HELP = formatHelp({
  command: 'node scripts/unity-bake/preview-clips.mjs',
  description: 'U2：无头 Electron 把 clip 应用到 VRM，抓帧 + 可选自然度度量 + 可选接触表。',
  usage:
    'node scripts/unity-bake/preview-clips.mjs [--clips a,b,c | --all] [--vrm <path>] ' +
    '[--frames <pct,...>] [--out <dir>] [--metrics <dir>] [--yaw <deg>] [--sheet]',
  options: OPTIONS,
  footer: '私有的 assets/vrm 与 assets/motions 只读；输出只写 --out/--metrics 目录。'
})

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.vrm': 'application/octet-stream',
  '.glb': 'model/gltf-binary',
  '.bin': 'application/octet-stream'
}

function toDisplayPath(target) {
  const rel = path.relative(process.cwd(), target)
  return rel && !rel.startsWith('..') ? rel : target
}

function fail(message, code = 1) {
  console.error(`[preview] ${message}`)
  process.exit(code)
}

/** 校验 clip 名（防止路径穿越；与 animation-contract 的 id 规则一致）。 */
function isValidClipName(name) {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(name)
}

/**
 * 解析预览朝向修正角（度）：
 * - 显式 `--yaw <deg>` 优先；
 * - 否则按 VRM 路径后缀匹配 `src/shared/vrm-manifest.json` 的 `yawOffsetDeg`（契约见 src/shared/vrm.ts）；
 * - 匹配不到按 0（VRM 规范面向 +Z；VRM0 已由 three-vrm rotateVRM0 归一化）。
 */
function resolveYawDeg(vrmRelPath, explicitYaw) {
  if (explicitYaw !== undefined) {
    const parsed = Number(explicitYaw)
    if (!Number.isFinite(parsed) || parsed < -360 || parsed > 360) fail(`--yaw 非法：${explicitYaw}`, 2)
    return parsed
  }
  if (!existsSync(VRM_MANIFEST_FILE)) return 0
  try {
    const manifest = JSON.parse(readFileSync(VRM_MANIFEST_FILE, 'utf8'))
    const target = vrmRelPath.split(path.sep).join('/')
    const avatar = (manifest.avatars || []).find((entry) => {
      if (typeof entry?.file !== 'string' || entry.file.length === 0) return false
      const file = entry.file.split(path.sep).join('/')
      return target === file || target.endsWith('/' + file) || file.endsWith('/' + target)
    })
    if (avatar && Number.isFinite(avatar.yawOffsetDeg)) return avatar.yawOffsetDeg
  } catch {
    // manifest 缺失/损坏时按 0 处理，不影响抓帧
  }
  return 0
}

function readAllClipNames() {
  if (!existsSync(INDEX_FILE)) fail(`--all 需要 index.json：${toDisplayPath(INDEX_FILE)}（先跑 convert-clips.mjs）`)
  let index
  try {
    index = JSON.parse(readFileSync(INDEX_FILE, 'utf8'))
  } catch (error) {
    fail(`index.json 解析失败：${error instanceof Error ? error.message : String(error)}`)
  }
  const clips = index && typeof index === 'object' ? index.clips : null
  if (!clips || typeof clips !== 'object' || Object.keys(clips).length === 0) {
    fail('index.json 里没有 clips（先跑 convert-clips.mjs）')
  }
  return Object.keys(clips).sort()
}

function createServer() {
  return http.createServer((req, res) => {
    try {
      const url = new URL(req.url, 'http://127.0.0.1')
      let rel = decodeURIComponent(url.pathname)
      if (rel === '/') rel = '/index.html'
      const file = path.join(ROOT, rel)
      if (!file.startsWith(ROOT) || !existsSync(file) || !statSync(file).isFile()) {
        res.writeHead(404)
        res.end('not found')
        return
      }
      res.writeHead(200, { 'content-type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream' })
      createReadStream(file).pipe(res)
    } catch (e) {
      res.writeHead(500)
      res.end(String(e))
    }
  })
}

async function main() {
  const { values, errors, sawHelp } = parseCliArgs(process.argv.slice(2), OPTIONS)
  if (sawHelp) {
    console.log(HELP)
    process.exit(0)
  }
  if (errors.length > 0) {
    for (const error of errors) console.error(`[preview] 参数错误：${error}`)
    console.error(HELP)
    process.exit(2)
  }

  const all = values.all === true
  let clipNames
  if (all) {
    clipNames = readAllClipNames()
  } else {
    clipNames = String(values.clips)
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
  }
  if (clipNames.length === 0) fail('没有指定 clip（--clips 或 --all）', 2)
  for (const name of clipNames) {
    if (!isValidClipName(name)) fail(`非法 clip 名：${name}`, 2)
  }

  const frames = String(values.frames)
    .split(',')
    .map((s) => Number(s))
    .filter((n) => Number.isFinite(n) && n >= 0)
  if (frames.length === 0) fail('--frames 至少需要一个非负数字', 2)

  // VRM 路径：仓库根相对（静态服务器以仓库根为根）；绝对路径在仓库内则转相对。
  let vrm = String(values.vrm)
  if (path.isAbsolute(vrm)) {
    const rel = path.relative(ROOT, vrm)
    if (rel.startsWith('..')) fail(`VRM 不在仓库内，静态服务器无法提供：${vrm}`)
    vrm = rel
  }
  if (!existsSync(path.join(ROOT, vrm))) fail(`VRM 不存在：${vrm}`)

  const yawDeg = resolveYawDeg(vrm, values.yaw)

  const outDir = path.resolve(String(values.out))
  const metricsDir = values.metrics !== undefined ? path.resolve(String(values.metrics)) : null
  const makeSheet = values.sheet === true
  mkdirSync(outDir, { recursive: true })
  if (metricsDir) mkdirSync(metricsDir, { recursive: true })
  mkdirSync(ELECTRON_USER_DATA_DIR, { recursive: true })

  if (!existsSync(ELECTRON)) fail(`electron 不存在：${ELECTRON}（先 pnpm install）`)

  const server = createServer()
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
    PREVIEW_VRM: vrm,
    PREVIEW_CLIPS: clipNames.join(','),
    PREVIEW_FRAMES: frames.join(','),
    PREVIEW_YAW: String(yawDeg)
  })
  if (metricsDir) env.PREVIEW_METRICS_DIR = metricsDir

  console.log(
    `[preview] server :${port}, vrm=${vrm}（yaw=${yawDeg}°）, clips=${clipNames.length}（${clipNames.slice(0, 4).join(',')}${
      clipNames.length > 4 ? ',…' : ''
    }）, out=${toDisplayPath(outDir)}${metricsDir ? `, metrics=${toDisplayPath(metricsDir)}` : ''}`
  )

  const child = spawn(
    ELECTRON,
    ['--no-sandbox', `--user-data-dir=${ELECTRON_USER_DATA_DIR}`, ENTRY],
    { cwd: ROOT, env, stdio: 'inherit' }
  )
  const code = await new Promise((resolve) => {
    child.on('exit', (exitCode, signal) => {
      if (exitCode !== 0) console.error(`[preview] electron exit code=${exitCode} signal=${signal}`)
      resolve(exitCode ?? 1)
    })
  })
  server.close()
  if (code !== 0) process.exit(code)

  if (makeSheet) {
    const { buildContactSheets } = await import('./contact-sheets.mjs')
    try {
      await buildContactSheets({ dir: outDir, outDir })
    } catch (error) {
      console.error(`[preview] 接触表生成失败：${error instanceof Error ? error.stack ?? error.message : String(error)}`)
      process.exit(1)
    }
  }
  console.log('[preview] OK:', toDisplayPath(outDir))
  process.exit(0)
}

main().catch((error) => {
  console.error(`[preview] FAIL：${error instanceof Error ? error.stack ?? error.message : String(error)}`)
  process.exit(1)
})
