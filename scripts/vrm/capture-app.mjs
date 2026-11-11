#!/usr/bin/env node
/**
 * Wave 2 实机端到端抓图/验收（dev-only）—— 用一次 `electron-vite dev` 跑真实 app，
 * 通过 `PET_DEV_CAPTURE_*` 回环让主进程驱动 `window.__aventurineDebug` 摆姿态/切 mood 并截图，
 * 然后本脚本校验截图/调试快照并写 run-summary.json。
 *
 * 安全隔离（用户要求）：
 * - 默认 `HOME=/tmp/pet-dsh-home`（可用 --home 覆盖）+ `PET_PROFILE=agent-e2e`：
 *   app 的 userData/日志/DSH 桥目录都落在临时 HOME，不碰真实 `~/.dsh` 与用户配置；
 * - 退出后不改仓库外任何文件；`--keep-home` 可复用（默认保留以便复跑）。
 *
 * 用法：
 *   node scripts/vrm/capture-app.mjs --out tests/tmp/wave2/vrm --poses stand,walk,sit,sleep,pat,drag
 *   node scripts/vrm/capture-app.mjs --backend legacy-pmx --poses stand --out tests/tmp/wave2/legacy
 *
 * 校验（任一失败 → exit 1）：
 * - 进程 stdout 含 `DEV_CAPTURE_OK` 且无 `DEV_CAPTURE_FAIL`；
 * - 每张 PNG 尺寸 = 主屏 workArea（从 DEV_CAPTURE_SHOT 日志读取）且不透明像素占比 > 阈值；
 * - 每个 <tag>.json 里 debug.ready=true、model.loaded=true；vrm 后端还要求 debug.vrm 存在、
 *   humanoidBoneCount>0、animation.clipId 非空、errors 无新增（对比首张）。
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const DEFAULT_OUT = path.join(ROOT, 'tests/tmp/wave2/app-capture')
const DEFAULT_HOME = '/tmp/pet-dsh-home'
const ELECTRON_VITE = path.join(ROOT, 'node_modules/electron-vite/bin/electron-vite.js')

function parseArgs(argv) {
  const options = {
    backend: 'vrm',
    poses: 'stand',
    out: DEFAULT_OUT,
    home: DEFAULT_HOME,
    profile: 'agent-e2e',
    mood: '',
    gaze: '',
    warmupMs: 0,
    frames: 1,
    holdMs: 700,
    timeoutMs: 240_000,
    center: true,
    idle: true,
    check: false,
    config: '',
    drag: '',
    place: '',
    sitStyle: '',
    walk: false,
    morphs: '',
    moodSequence: '',
    propVisible: ''
  }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    const next = () => {
      const value = argv[index + 1]
      if (value === undefined || value.startsWith('--')) throw new Error(`${arg} requires a value`)
      index += 1
      return value
    }
    if (arg === '--backend') options.backend = next()
    else if (arg === '--poses') options.poses = next()
    else if (arg === '--out') options.out = path.resolve(ROOT, next())
    else if (arg === '--home') options.home = path.resolve(next())
    else if (arg === '--profile') options.profile = next()
    else if (arg === '--mood') options.mood = next()
    else if (arg === '--gaze') options.gaze = next()
    else if (arg === '--warmup-ms') options.warmupMs = Number(next())
    else if (arg === '--frames') options.frames = Number(next())
    else if (arg === '--hold-ms') options.holdMs = Number(next())
    else if (arg === '--timeout-ms') options.timeoutMs = Number(next())
    else if (arg === '--no-center') options.center = false
    else if (arg === '--no-idle') options.idle = false
    else if (arg === '--check') options.check = true
    else if (arg === '--config') options.config = next()
    else if (arg === '--size') options.config = JSON.stringify({ sizePercent: Number(next()) })
    else if (arg === '--drag') options.drag = next()
    else if (arg === '--place') options.place = next()
    else if (arg === '--sit-style') options.sitStyle = next()
    else if (arg === '--walk') options.walk = true
    else if (arg === '--morphs') options.morphs = next()
    else if (arg === '--prop-visible') options.propVisible = next()
    else if (arg === '--mood-sequence') options.moodSequence = next()
    else if (arg === '--help' || arg === '-h') {
      console.log(
        'Usage: node scripts/vrm/capture-app.mjs [--backend vrm|legacy-pmx] [--poses a,b] [--mood m] [--gaze yaw,pitch] [--out dir] [--home dir] [--check]'
      )
      process.exit(0)
    } else {
      console.warn(`[capture-app] 忽略未知参数: ${arg}`)
    }
  }
  return options
}

const options = parseArgs(process.argv.slice(2))
const outDir = options.out
const summaryPath = path.join(outDir, 'run-summary.json')

/* -------------------------------------------------------------------------- */
/* --check：只校验已有产物                                                      */
/* -------------------------------------------------------------------------- */

async function checkExisting() {
  if (!existsSync(outDir)) {
    console.error(`[capture-app] --check 失败：输出目录不存在 ${outDir}`)
    process.exit(1)
  }
  const files = readdirSync(outDir).filter((name) => name.endsWith('.json') && name !== 'run-summary.json')
  const failures = []
  for (const file of files) {
    const snapshot = JSON.parse(readFileSync(path.join(outDir, file), 'utf8'))
    const debug = snapshot?.debug ?? {}
    if (debug.ready !== true) failures.push(`${file}: debug.ready !== true`)
    if (debug.model?.loaded !== true) failures.push(`${file}: model.loaded !== true`)
  }
  if (failures.length > 0) {
    console.error(`[capture-app] --check 失败：\n  ${failures.join('\n  ')}`)
    process.exit(1)
  }
  console.log(`[capture-app] --check OK：${files.length} 个快照（${outDir}）`)
}

/* -------------------------------------------------------------------------- */
/* 截图像素校验                                                                 */
/* -------------------------------------------------------------------------- */

async function inspectPng(filePath) {
  const metadata = await sharp(filePath).metadata()
  const { data, info } = await sharp(filePath).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
  const total = info.width * info.height
  let opaque = 0
  for (let index = 3; index < data.length; index += 4) {
    if (data[index] > 8) opaque += 1
  }
  return { width: metadata.width, height: metadata.height, opaque, total, opaqueRatio: opaque / total }
}

/* -------------------------------------------------------------------------- */
/* 运行 dev 抓图                                                                */
/* -------------------------------------------------------------------------- */

function spawnCapture() {
  mkdirSync(outDir, { recursive: true })
  mkdirSync(options.home, { recursive: true })
  const env = {
    ...process.env,
    HOME: options.home,
    ELECTRON_RUN_AS_NODE: '',
    ELECTRON_DISABLE_SECURITY_WARNINGS: '1',
    PET_PROFILE: options.profile,
    // 硬隔离 DSH 桥目录：即使 Electron/Node 的 homedir 解析绕过 HOME，也只读临时目录。
    PET_DSH_DIR: path.join(options.home, '.dsh', 'aventurine-pet'),
    PET_MODEL_BACKEND: options.backend,
    PET_DEV_CAPTURE_DIR: outDir,
    ...(options.propVisible ? { PET_DEV_CAPTURE_PROP_VISIBLE: String(options.propVisible) } : {}),
    PET_DEV_CAPTURE_POSES: options.poses,
    PET_DEV_CAPTURE_MORPHS: '',
    PET_DEV_CAPTURE_HOLD_MS: String(options.holdMs),
    PET_DEV_CAPTURE_CENTER: options.center ? '1' : '0',
    PET_DEV_CAPTURE_IDLE: options.idle ? '1' : '0',
    PET_DEV_CAPTURE_WARMUP_MS: String(options.warmupMs),
    PET_DEV_CAPTURE_FRAMES: String(options.frames),
    PET_DEV_CAPTURE_READY_TIMEOUT_MS: '60000'
  }
  if (options.mood) env.PET_DEV_CAPTURE_MOOD = options.mood
  if (options.config) env.PET_DEV_CAPTURE_CONFIG = options.config
  if (options.drag) env.PET_DEV_CAPTURE_DRAG = options.drag
  if (options.place) env.PET_DEV_CAPTURE_PLACE = options.place
  if (options.sitStyle) env.PET_DEV_CAPTURE_SIT_STYLE = options.sitStyle
  if (options.walk) env.PET_DEV_CAPTURE_WALK = '1'
  if (options.morphs) env.PET_DEV_CAPTURE_MORPHS = options.morphs
  if (options.moodSequence) env.PET_DEV_CAPTURE_MOOD_SEQUENCE = options.moodSequence
  if (options.gaze) env.PET_DEV_CAPTURE_GAZE = options.gaze

  return new Promise((resolve) => {
    const child = spawn('node', [ELECTRON_VITE, 'dev'], {
      cwd: ROOT,
      env,
      stdio: ['ignore', 'pipe', 'pipe']
    })
    let stdout = ''
    let stderr = ''
    let settled = false
    const finish = (result) => {
      if (settled) return
      settled = true
      clearTimeout(watchdog)
      resolve(result)
    }
    const watchdog = setTimeout(() => {
      child.kill('SIGKILL')
      finish({ code: -1, stdout, stderr, timedOut: true })
    }, options.timeoutMs)
    child.stdout.on('data', (chunk) => {
      stdout += chunk
      process.stdout.write(chunk)
    })
    child.stderr.on('data', (chunk) => {
      stderr += chunk
      process.stderr.write(chunk)
    })
    child.on('error', (error) => finish({ code: -1, stdout, stderr: `${stderr}\nspawn error: ${error?.stack ?? error}` }))
    child.on('close', (code) => finish({ code, stdout, stderr }))
  })
}

async function main() {
  if (options.check) {
    await checkExisting()
    return
  }

  const shotLogs = []
  const run = await spawnCapture()
  const combined = `${run.stdout}\n${run.stderr}`
  for (const line of run.stdout.split('\n')) {
    if (line.includes('DEV_CAPTURE_SHOT')) shotLogs.push(line.trim())
  }
  const okLine = combined.includes('DEV_CAPTURE_OK')
  const failLine = combined.includes('DEV_CAPTURE_FAIL')

  // 截图校验
  const pngFiles = existsSync(outDir)
    ? readdirSync(outDir).filter((name) => name.endsWith('.png')).sort()
    : []
  const images = []
  for (const file of pngFiles) {
    const info = await inspectPng(path.join(outDir, file))
    images.push({ file, ...info })
  }
  // 快照校验
  const snapshots = []
  for (const file of readdirSync(outDir).filter((name) => name.endsWith('.json') && name !== 'run-summary.json').sort()) {
    const raw = JSON.parse(readFileSync(path.join(outDir, file), 'utf8'))
    const debug = raw?.debug ?? {}
    snapshots.push({
      file,
      pose: raw?.pose ?? null,
      ready: debug.ready === true,
      loaded: debug.model?.loaded === true,
      vrmAvatarId: debug.vrm?.avatarId ?? null,
      humanoidBones: debug.vrm?.humanoidBoneCount ?? null,
      clipId: debug.animation?.clipId ?? null,
      footErrorPx: debug.animation?.footErrorPx ?? null,
      errors: debug.errors ?? []
    })
  }

  const failures = []
  if (!okLine) failures.push('DEV_CAPTURE_OK 未出现（进程可能崩溃/超时）')
  if (failLine) failures.push('出现 DEV_CAPTURE_FAIL')
  if (images.length === 0) failures.push('没有截图产物')
  if (options.drag && !images.some((image) => image.file.includes('drag-'))) failures.push('drag 抓图缺失')
  if (options.place && !images.some((image) => image.file.includes('place-after'))) failures.push('place-after 抓图缺失')
  if (options.walk && !images.some((image) => image.file.startsWith('walk-'))) failures.push('walk 抓图缺失')
  for (const image of images) {
    if (!(image.width > 0 && image.height > 0)) failures.push(`${image.file}: 尺寸非法`)
    if (image.opaqueRatio < 0.002) failures.push(`${image.file}: 不透明像素过少（${image.opaqueRatio.toFixed(4)}）`)
  }
  for (const snapshot of snapshots) {
    if (!snapshot.ready) failures.push(`${snapshot.file}: debug.ready !== true`)
    if (!snapshot.loaded) failures.push(`${snapshot.file}: model.loaded !== true`)
    if (options.backend === 'vrm') {
      if (!snapshot.vrmAvatarId) failures.push(`${snapshot.file}: debug.vrm.avatarId 缺失`)
      if (!(snapshot.humanoidBones > 0)) failures.push(`${snapshot.file}: humanoidBoneCount 非法`)
      if (!snapshot.clipId) failures.push(`${snapshot.file}: animation.clipId 为空（clip 未播放）`)
    }
  }
  const firstErrors = snapshots[0]?.errors ?? []
  const newErrors = snapshots.slice(1).flatMap((snapshot) => snapshot.errors.filter((error) => !firstErrors.includes(error)))

  const summary = {
    generatedAt: new Date().toISOString(),
    backend: options.backend,
    home: options.home,
    profile: options.profile,
    poses: options.poses,
    mood: options.mood || null,
    config: options.config || null,
    drag: options.drag || null,
    place: options.place || null,
    sitStyle: options.sitStyle || null,
    walk: options.walk === true,
    morphs: options.morphs || null,
    moodSequence: options.moodSequence || null,
    exitCode: run.code,
    timedOut: run.timedOut === true,
    devCaptureOk: okLine,
    devCaptureFail: failLine,
    images,
    snapshots,
    newErrors,
    failures,
    stdoutTail: run.stdout.slice(-8000),
    stderrTail: run.stderr.slice(-8000)
  }
  writeFileSync(summaryPath, JSON.stringify(summary, null, 2))
  writeFileSync(path.join(outDir, 'stdout.log'), run.stdout)
  writeFileSync(path.join(outDir, 'stderr.log'), run.stderr)

  if (failures.length > 0) {
    console.error(`[capture-app] FAIL：\n  ${failures.join('\n  ')}`)
    console.error(`[capture-app] summary: ${summaryPath}`)
    process.exit(1)
  }
  console.log(
    `[capture-app] OK：${images.length} 张截图 / ${snapshots.length} 个快照 / backend=${options.backend} / summary=${summaryPath}`
  )
}

main().catch((error) => {
  console.error('[capture-app] 未捕获异常：', error)
  process.exit(1)
})
