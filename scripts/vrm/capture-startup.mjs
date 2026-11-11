#!/usr/bin/env node
/**
 * 启动逐帧捕获 / T-pose 闪现证据（dev-only）—— 用一次 `electron-vite dev` 跑真实 app，
 * 主进程在 renderer `did-finish-load` 后逐帧落 PNG（`PET_DEV_CAPTURE_STARTUP_FRAMES`），
 * 本脚本用 sharp 逐帧分析：非透明像素数 + 内容 bbox 宽高比，输出每帧摘要与 `analysis.json`。
 *
 * 判定依据（VRM rest = T-pose，双臂水平展开）：
 * - 全透明帧 = 模型尚未显示（`firstAnimationApplied` 门控窗口期）→ transparent；
 * - bbox 很宽（宽高比 ≈ 身体高度，手臂水平）→ wide，疑似 rest T-pose；
 * - idle 双臂放下，bbox 明显更窄 → narrow；
 * - 介于两者之间 = 首次 idle clip 从 rest pose crossfade 的中间态（transition）。
 *
 * 安全隔离（参考 capture-app.mjs）：
 * - HOME 指向 /tmp 临时目录 + PET_DSH_DIR 硬隔离，不碰真实 `~/.dsh` 与用户配置；
 * - PET_PROFILE=startup-capture 让 userData/logs 落在独立 profile；
 * - 一次性运行：主进程抓完自动 `app.exit`，不留常驻 app 窗口。
 *
 * 用法：
 *   node scripts/vrm/capture-startup.mjs --out tests/tmp/startup-pose/before
 *   node scripts/vrm/capture-startup.mjs --out tests/tmp/startup-pose/after --frames 450 --max-ms 14000
 *
 * 产物（--out 目录）：
 * - `startup-001.png`…（主进程逐帧 PNG，宽度 = --width，默认 512，保留 alpha）
 * - `startup-frames.json` / `startup-debug.json`（主进程逐帧时间戳 + renderer debug 时间线）
 * - `app.log`（electron-vite dev 全量 stdout/stderr）
 * - `analysis.json` + `analysis.txt`（本脚本逐帧分析 + 汇总）
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const ELECTRON_VITE = path.join(ROOT, 'node_modules/electron-vite/bin/electron-vite.js')

/** 非透明判定：alpha > 阈值才计入内容（忽略边缘极淡抗锯齿像素）。 */
const ALPHA_THRESHOLD = 16
/** bbox 宽高比 ≥ 该值 → wide（疑似 T-pose；idle 实测会明显低于此值）。 */
const WIDE_ASPECT = 0.7
/** bbox 宽高比 ≤ 该值 → narrow（idle 姿态）。 */
const IDLE_ASPECT = 0.6
/** 判定「已进入 idle 稳定」需要的连续 narrow 帧数。 */
const STABLE_FRAMES = 6

function parseArgs(argv) {
  const options = {
    out: path.join(ROOT, 'tests/tmp/startup-pose/before'),
    phase: '',
    backend: 'vrm',
    frames: 450,
    maxMs: 14000,
    width: 512,
    home: '/tmp/pet-startup-home',
    profile: 'startup-capture',
    debugIntervalMs: 250,
    compare: null,
    report: null,
    timeoutMs: 240_000
  }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    const next = () => {
      const value = argv[index + 1]
      if (value === undefined || value.startsWith('--')) throw new Error(`${arg} requires a value`)
      index += 1
      return value
    }
    if (arg === '--out') options.out = path.resolve(ROOT, next())
    else if (arg === '--phase') options.phase = next()
    else if (arg === '--backend') options.backend = next()
    else if (arg === '--frames') options.frames = Math.max(1, Math.floor(Number(next())))
    else if (arg === '--max-ms') options.maxMs = Math.max(500, Number(next()))
    else if (arg === '--width') options.width = Math.max(160, Math.round(Number(next())))
    else if (arg === '--debug-interval-ms') options.debugIntervalMs = Math.max(50, Math.round(Number(next())))
    else if (arg === '--compare') {
      options.compare = [path.resolve(ROOT, next()), path.resolve(ROOT, next())]
    } else if (arg === '--report') options.report = path.resolve(ROOT, next())
    else if (arg === '--home') options.home = path.resolve(next())
    else if (arg === '--profile') options.profile = next()
    else if (arg === '--timeout-ms') options.timeoutMs = Math.max(10_000, Number(next()))
    else if (arg === '--help' || arg === '-h') {
      console.log(
        'Usage: node scripts/vrm/capture-startup.mjs [--out dir] [--phase before|after] [--frames N] [--max-ms MS] [--width PX] [--debug-interval-ms MS] [--home dir] [--profile name] [--timeout-ms MS]\n       node scripts/vrm/capture-startup.mjs --compare <beforeDir> <afterDir> [--report comparison.json]'
      )
      process.exit(0)
    } else {
      console.warn(`[capture-startup] 忽略未知参数: ${arg}`)
    }
  }
  if (!options.phase && options.compare === null) {
    // 未显式给 --phase 时取 out 目录名（before/after），仅用于报告标注。
    options.phase = path.basename(options.out)
  }
  return options
}

const options = parseArgs(process.argv.slice(2))
const outDir = options.out
const appLogPath = path.join(outDir, 'app.log')

/* -------------------------------------------------------------------------- */
/* spawn electron-vite dev                                                     */
/* -------------------------------------------------------------------------- */

function spawnStartupCapture() {
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
    PET_DEV_CAPTURE_STARTUP_FRAMES: String(options.frames),
    PET_DEV_CAPTURE_STARTUP_MAX_MS: String(options.maxMs),
    PET_DEV_CAPTURE_STARTUP_WIDTH: String(options.width),
    PET_DEV_CAPTURE_STARTUP_DEBUG_INTERVAL_MS: String(options.debugIntervalMs),
    // 启动捕获优先于姿态回环：清空姿态/动作相关 env，避免 runDevCapture 分支干扰。
    PET_DEV_CAPTURE_POSES: '',
    PET_DEV_CAPTURE_MOOD: '',
    PET_DEV_CAPTURE_DRAG: '',
    PET_DEV_CAPTURE_WALK: ''
  }

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
      writeFileSync(appLogPath, `${stdout}\n\n----- stderr -----\n${stderr}`)
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
    child.on('error', (error) =>
      finish({ code: -1, stdout, stderr: `${stderr}\nspawn error: ${error?.stack ?? error}` })
    )
    child.on('close', (code) => finish({ code, stdout, stderr }))
  })
}

/* -------------------------------------------------------------------------- */
/* sharp 逐帧分析                                                              */
/* -------------------------------------------------------------------------- */

/** 分析单帧：非透明像素数 + 内容 bbox（透明背景 canvas）。 */
async function analyzeFrame(file) {
  const { data, info } = await sharp(file)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true })
  const { width, height, channels } = info
  let opaque = 0
  let minX = width
  let maxX = -1
  let minY = height
  let maxY = -1
  for (let y = 0; y < height; y += 1) {
    const rowOffset = y * width * channels
    for (let x = 0; x < width; x += 1) {
      if (data[rowOffset + x * channels + (channels - 1)] > ALPHA_THRESHOLD) {
        opaque += 1
        if (x < minX) minX = x
        if (x > maxX) maxX = x
        if (y < minY) minY = y
        if (y > maxY) maxY = y
      }
    }
  }
  const visible = opaque > 0 && maxX >= minX && maxY >= minY
  const bbox = visible
    ? { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 }
    : null
  const aspect = bbox !== null && bbox.height > 0 ? bbox.width / bbox.height : null
  const kind =
    !visible ? 'transparent' : aspect === null ? 'unknown' : aspect >= WIDE_ASPECT ? 'wide' : aspect <= IDLE_ASPECT ? 'narrow' : 'transition'
  return {
    width,
    height,
    opaque,
    opaqueRatio: Number((opaque / (width * height)).toFixed(6)),
    bbox,
    aspect: aspect === null ? null : Number(aspect.toFixed(4)),
    kind
  }
}

/* -------------------------------------------------------------------------- */
/* 主流程                                                                      */
/* -------------------------------------------------------------------------- */

function readJsonIfExists(file) {
  if (!existsSync(file)) return null
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

/** 从 app.log 解析主进程逐帧日志（startup-frames.json 缺失时的兜底时间戳来源）。 */
function parseFrameLogs(stdout) {
  const byIndex = new Map()
  for (const line of stdout.split('\n')) {
    const marker = 'DEV_CAPTURE_STARTUP_FRAME '
    const at = line.indexOf(marker)
    if (at < 0) continue
    try {
      const payload = JSON.parse(line.slice(at + marker.length))
      byIndex.set(payload.index, payload)
    } catch {
      // 忽略截断/异常行。
    }
  }
  return byIndex
}

function pickLogPayload(stdout, marker) {
  const line = stdout
    .split('\n')
    .find((entry) => entry.includes(marker))
  if (!line) return null
  try {
    return JSON.parse(line.slice(line.indexOf(marker) + marker.length))
  } catch {
    return null
  }
}

/** debug 时间线压缩：只保留关键字段，便于证据阅读。 */
function summarizeDebugSnapshot(snapshot) {
  if (!snapshot || snapshot.present !== true) return { present: false }
  const animation = snapshot.animation ?? {}
  const model = snapshot.model ?? {}
  return {
    present: true,
    ready: snapshot.ready === true,
    modelLoaded: model.loaded === true,
    pose: animation.pose ?? null,
    poseWeight: animation.poseWeight ?? null,
    activeLayers: animation.activeLayers ?? null,
    source: animation.source ?? null,
    clipId: animation.clipId ?? null,
    clipTimeSec: animation.clipTimeSec ?? null
  }
}

async function main() {
  console.log(
    `[capture-startup] phase=${options.phase} out=${outDir} frames<=${options.frames} maxMs=${options.maxMs} pngWidth=${options.width} debugIntervalMs=${options.debugIntervalMs} backend=${options.backend}`
  )
  const run = await spawnStartupCapture()
  const combined = `${run.stdout}\n${run.stderr}`
  const startupOk = combined.includes('DEV_CAPTURE_STARTUP_OK')
  const startupFail = combined.includes('DEV_CAPTURE_STARTUP_FAIL')
  const okPayload = pickLogPayload(combined, 'DEV_CAPTURE_STARTUP_OK ')
  const beginPayload = pickLogPayload(combined, 'DEV_CAPTURE_STARTUP_BEGIN ')
  const frameLogs = parseFrameLogs(combined)

  const framesMeta = readJsonIfExists(path.join(outDir, 'startup-frames.json'))
  const debugMeta = readJsonIfExists(path.join(outDir, 'startup-debug.json'))

  const pngFiles = existsSync(outDir)
    ? readdirSync(outDir)
        .filter((name) => /^startup-\d+\.png$/.test(name))
        .sort()
    : []
  const metaByFile = new Map()
  for (const frame of framesMeta?.frames ?? []) {
    metaByFile.set(path.basename(frame.png), frame)
  }

  const frames = []
  for (let index = 0; index < pngFiles.length; index += 1) {
    const file = pngFiles[index]
    const metadata = metaByFile.get(file) ?? frameLogs.get(index + 1) ?? null
    const analysis = await analyzeFrame(path.join(outDir, file))
    frames.push({
      index: index + 1,
      file,
      tMs: metadata?.tMs ?? null,
      windowVisible: metadata?.windowVisible ?? null,
      ...analysis
    })
  }

  // 时间线：帧 tMs → 最近的 debug 快照（说明该帧时动画状态）。
  const debugTimeline = debugMeta?.timeline ?? []
  for (const frame of frames) {
    if (frame.tMs === null) continue
    let nearest = null
    let nearestDelta = Infinity
    for (const sample of debugTimeline) {
      const delta = Math.abs((sample.tMs ?? 0) - frame.tMs)
      if (delta < nearestDelta) {
        nearestDelta = delta
        nearest = sample
      }
    }
    frame.debug = summarizeDebugSnapshot(nearest?.snapshot ?? null)
    frame.debugDeltaMs = nearest === null ? null : Math.round(nearestDelta)
  }

  // ---- 汇总指标 ----
  const visibleFrames = frames.filter((frame) => frame.kind !== 'transparent')
  const wideFrames = frames.filter((frame) => frame.kind === 'wide')
  const narrowFrames = frames.filter((frame) => frame.kind === 'narrow')
  const transitionFrames = frames.filter((frame) => frame.kind === 'transition')

  const maxWideRun = (() => {
    let best = { length: 0, start: null, end: null }
    let current = null
    for (const frame of frames) {
      if (frame.kind === 'wide') {
        if (current === null) current = { length: 0, start: frame, end: frame }
        current.length += 1
        current.end = frame
        if (current.length > best.length) best = { ...current }
      } else {
        current = null
      }
    }
    return best
  })()

  const firstVisible = visibleFrames[0] ?? null
  // 首个「已进入 idle 稳定」帧：连续 STABLE_FRAMES 帧 narrow。
  let firstStableIdle = null
  for (let index = 0; index < frames.length; index += 1) {
    if (frames[index].kind !== 'narrow') continue
    const runFrames = frames.slice(index, index + STABLE_FRAMES)
    if (runFrames.length === STABLE_FRAMES && runFrames.every((frame) => frame.kind === 'narrow')) {
      firstStableIdle = frames[index]
      break
    }
  }

  const wideStartTMs = maxWideRun.start?.tMs ?? null
  const wideEndTMs = maxWideRun.end?.tMs ?? null
  const wideDurationMs =
    wideStartTMs !== null && wideEndTMs !== null ? Math.max(0, wideEndTMs - wideStartTMs) : null

  let verdict
  if (frames.length === 0) verdict = 'capture-failed'
  else if (wideFrames.length >= 2) verdict = 'flash-reproduced'
  else if (visibleFrames.length > 0 && wideFrames.length === 0) verdict = 'no-flash-detected'
  else verdict = 'inconclusive'

  const summary = {
    phase: options.phase,
    frameCount: frames.length,
    captureSpanMs: frames.length > 0 && frames[0].tMs !== null && frames.at(-1).tMs !== null ? frames.at(-1).tMs - frames[0].tMs : null,
    effectiveFps:
      frames.length > 1 && frames[0].tMs !== null && frames.at(-1).tMs !== null && frames.at(-1).tMs > frames[0].tMs
        ? Number(((frames.length - 1) / ((frames.at(-1).tMs - frames[0].tMs) / 1000)).toFixed(1))
        : null,
    thresholds: { alpha: ALPHA_THRESHOLD, wideAspect: WIDE_ASPECT, idleAspect: IDLE_ASPECT, stableFrames: STABLE_FRAMES },
    transparentFrames: frames.length - visibleFrames.length,
    visibleFrames: visibleFrames.length,
    wideFrames: wideFrames.length,
    transitionFrames: transitionFrames.length,
    narrowFrames: narrowFrames.length,
    firstVisibleFrame: firstVisible ? { index: firstVisible.index, tMs: firstVisible.tMs, aspect: firstVisible.aspect, kind: firstVisible.kind } : null,
    firstStableIdleFrame: firstStableIdle ? { index: firstStableIdle.index, tMs: firstStableIdle.tMs, aspect: firstStableIdle.aspect } : null,
    maxWideRun: {
      length: maxWideRun.length,
      startIndex: maxWideRun.start?.index ?? null,
      endIndex: maxWideRun.end?.index ?? null,
      startTMs: wideStartTMs,
      endTMs: wideEndTMs,
      durationMs: wideDurationMs
    },
    maxAspect: visibleFrames.length > 0 ? Math.max(...visibleFrames.map((frame) => frame.aspect ?? 0)) : null,
    idleAspectMedian: (() => {
      const values = narrowFrames.map((frame) => frame.aspect).filter((value) => typeof value === 'number').sort((a, b) => a - b)
      if (values.length === 0) return null
      const mid = Math.floor(values.length / 2)
      return values.length % 2 === 1 ? values[mid] : Number(((values[mid - 1] + values[mid]) / 2).toFixed(4))
    })(),
    verdict
  }

  const analysis = {
    generatedAt: new Date().toISOString(),
    phase: options.phase,
    outDir,
    options,
    run: {
      exitCode: run.code,
      timedOut: run.timedOut === true,
      startupOk,
      startupFail,
      okPayload,
      beginPayload
    },
    summary,
    debug: {
      timeline: debugTimeline.map((sample) => ({ tMs: sample.tMs, ...summarizeDebugSnapshot(sample.snapshot) })),
      final: summarizeDebugSnapshot(debugMeta?.final ?? null)
    },
    frames
  }
  writeFileSync(path.join(outDir, 'analysis.json'), JSON.stringify(analysis, null, 2))

  // ---- 控制台逐帧摘要 ----
  const lines = []
  lines.push(`[capture-startup] phase=${options.phase} out=${outDir}`)
  lines.push(
    `[capture-startup] app: exit=${run.code} timedOut=${run.timedOut === true} startupOk=${startupOk} startupFail=${startupFail} captured=${frames.length}`
  )
  if (okPayload) lines.push(`[capture-startup] OK payload: ${JSON.stringify(okPayload)}`)
  if (beginPayload) lines.push(`[capture-startup] BEGIN payload: ${JSON.stringify(beginPayload)}`)
  lines.push('')
  lines.push('idx  tMs    window  pngSize      opaque(%)  bbox(w x h)      aspect  kind         pose/weight  clipId')
  for (const frame of frames) {
    const t = frame.tMs === null ? '?' : frame.tMs
    const windowVisible = frame.windowVisible === null ? '?' : frame.windowVisible ? 'yes' : 'NO'
    const size = `${frame.width}x${frame.height}`
    const opaque = `${String(frame.opaque).padStart(6)}(${(frame.opaqueRatio * 100).toFixed(2)}%)`
    const bbox = frame.bbox ? `${frame.bbox.width}x${frame.bbox.height}` : '-'
    const aspect = frame.aspect === null ? '-' : frame.aspect.toFixed(3)
    const pose = frame.debug?.present === true ? `${frame.debug.pose ?? '-'}/${frame.debug.poseWeight ?? '-'}` : '-'
    const clipId = frame.debug?.clipId ?? '-'
    lines.push(
      `${String(frame.index).padStart(3, '0')}  ${String(t).padStart(5, ' ')}  ${windowVisible.padEnd(4)}  ${size.padEnd(11)}  ${opaque.padEnd(14)}  ${bbox.padEnd(15)}  ${String(aspect).padStart(6, ' ')}  ${frame.kind.padEnd(11)}  ${String(pose).padEnd(12)}  ${clipId}`
    )
  }
  lines.push('')
  lines.push(`[capture-startup] SUMMARY ${JSON.stringify(summary)}`)
  const text = `${lines.join('\n')}\n`
  writeFileSync(path.join(outDir, 'analysis.txt'), text)
  process.stdout.write(text)

  // 退出码：捕获成功且有帧 = 0；捕获失败（进程崩溃/无帧/超时）= 1。
  // 注意：「未复现闪现」不是失败 —— 由 summary.verdict 表达（after 期望 no-flash-detected）。
  const captureOk = startupOk && frames.length > 0 && !run.timedOut
  if (!captureOk) {
    console.error('[capture-startup] 捕获失败（无帧/进程异常/超时），见 app.log 与 analysis.json')
    process.exit(1)
  }
}


/* -------------------------------------------------------------------------- */
/* before/after 对比                                                            */
/* -------------------------------------------------------------------------- */

/** 从分析目录读 analysis.json；缺文件直接抛错（对比失败要明确可见）。 */
function loadAnalysis(dir) {
  const file = path.join(dir, 'analysis.json')
  if (!existsSync(file)) throw new Error(`analysis.json 不存在：${file}（先跑该 phase 的捕获）`)
  return JSON.parse(readFileSync(file, 'utf8'))
}

function firstVisibleRow(analysis) {
  const frame = analysis?.summary?.firstVisibleFrame
  return frame ?? null
}

/** 生成 before/after 对比：关键指标 + 判定 + 精简逐帧表。写 comparison.json 并打印 markdown。 */
async function comparePhases(beforeDir, afterDir, reportPath) {
  const before = loadAnalysis(beforeDir)
  const after = loadAnalysis(afterDir)
  const pick = (analysis) => {
    const summary = analysis.summary ?? {}
    return {
      dir: analysis.outDir,
      phase: analysis.phase,
      frameCount: summary.frameCount ?? 0,
      effectiveFps: summary.effectiveFps ?? null,
      transparentFrames: summary.transparentFrames ?? null,
      visibleFrames: summary.visibleFrames ?? null,
      wideFrames: summary.wideFrames ?? null,
      transitionFrames: summary.transitionFrames ?? null,
      narrowFrames: summary.narrowFrames ?? null,
      maxAspect: summary.maxAspect ?? null,
      idleAspectMedian: summary.idleAspectMedian ?? null,
      firstVisibleFrame: summary.firstVisibleFrame ?? null,
      firstStableIdleFrame: summary.firstStableIdleFrame ?? null,
      maxWideRun: summary.maxWideRun ?? null,
      verdict: summary.verdict ?? null,
      run: analysis.run ?? null
    }
  }
  const beforePick = pick(before)
  const afterPick = pick(after)

  const ratio = (frame, idle) =>
    frame && typeof frame.aspect === 'number' && typeof idle === 'number' && idle > 0
      ? Number((frame.aspect / idle).toFixed(3))
      : null

  const checks = [
    {
      name: 'after 无 wide 帧（T-pose 帧数 = 0）',
      pass: afterPick.wideFrames === 0,
      detail: `after.wideFrames=${afterPick.wideFrames}`
    },
    {
      name: 'after 首个可见帧已是 idle 窄 bbox（aspect ≤ IDLE_ASPECT）',
      pass:
        afterPick.firstVisibleFrame !== null &&
        typeof afterPick.firstVisibleFrame.aspect === 'number' &&
        afterPick.firstVisibleFrame.aspect <= IDLE_ASPECT,
      detail: `after 首个可见帧 aspect=${afterPick.firstVisibleFrame?.aspect ?? 'null'}（idle 中位 ${afterPick.idleAspectMedian}，阈值 ${IDLE_ASPECT}）`
    },
    {
      name: 'after 首个可见帧宽高比接近 idle 中位（≤1.15×）',
      pass: (() => {
        const value = ratio(afterPick.firstVisibleFrame, afterPick.idleAspectMedian)
        return value !== null && value <= 1.15
      })(),
      detail: `ratio=${ratio(afterPick.firstVisibleFrame, afterPick.idleAspectMedian)}（before=${ratio(beforePick.firstVisibleFrame, beforePick.idleAspectMedian)}）`
    },
    {
      name: 'after 捕获了可见帧且进入 idle 稳定',
      pass:
        (afterPick.visibleFrames ?? 0) > 0 &&
        afterPick.firstStableIdleFrame !== null &&
        afterPick.verdict === 'no-flash-detected',
      detail: `visible=${afterPick.visibleFrames} firstStableIdle=${afterPick.firstStableIdleFrame?.tMs ?? 'null'}ms verdict=${afterPick.verdict}`
    },
    {
      name: 'after 未因隐藏过久导致「始终不可见」回归',
      pass:
        afterPick.firstVisibleFrame !== null &&
        typeof afterPick.firstVisibleFrame.tMs === 'number' &&
        afterPick.firstVisibleFrame.tMs <= 3000,
      detail: `after 首个可见帧 t=${afterPick.firstVisibleFrame?.tMs ?? 'null'}ms（阈值 3000ms，模型加载完成前保持隐藏是预期行为）`
    }
  ]
  const passed = checks.every((check) => check.pass === true)

  const briefFrames = (analysis, limit) =>
    (analysis.frames ?? []).slice(0, limit).map((frame) => ({
      index: frame.index,
      tMs: frame.tMs,
      opaque: frame.opaque,
      bbox: frame.bbox,
      aspect: frame.aspect,
      kind: frame.kind,
      pose: frame.debug?.pose ?? null,
      poseWeight: frame.debug?.poseWeight ?? null
    }))

  const comparison = {
    generatedAt: new Date().toISOString(),
    passed,
    before: beforePick,
    after: afterPick,
    deltas: {
      wideFrames: (afterPick.wideFrames ?? 0) - (beforePick.wideFrames ?? 0),
      firstVisibleFrameAspect: {
        before: beforePick.firstVisibleFrame?.aspect ?? null,
        after: afterPick.firstVisibleFrame?.aspect ?? null
      },
      firstVisibleFrameTMs: {
        before: beforePick.firstVisibleFrame?.tMs ?? null,
        after: afterPick.firstVisibleFrame?.tMs ?? null
      },
      maxWideRunDurationMs: {
        before: beforePick.maxWideRun?.durationMs ?? null,
        after: afterPick.maxWideRun?.durationMs ?? null
      },
      anomalyWindowMs: {
        before:
          beforePick.firstVisibleFrame !== null && beforePick.firstStableIdleFrame !== null
            ? beforePick.firstStableIdleFrame.tMs - beforePick.firstVisibleFrame.tMs
            : null,
        after:
          afterPick.firstVisibleFrame !== null && afterPick.firstStableIdleFrame !== null
            ? afterPick.firstStableIdleFrame.tMs - afterPick.firstVisibleFrame.tMs
            : null
      }
    },
    checks,
    thresholds: { wideAspect: WIDE_ASPECT, idleAspect: IDLE_ASPECT, stableFrames: STABLE_FRAMES },
    firstFrames: { before: briefFrames(before, 12), after: briefFrames(after, 12) }
  }

  const target = reportPath ?? path.join(path.dirname(beforeDir), 'comparison.json')
  mkdirSync(path.dirname(target), { recursive: true })
  writeFileSync(target, JSON.stringify(comparison, null, 2))

  const lines = []
  lines.push('# 启动 T-pose 闪现 before/after 对比')
  lines.push('')
  lines.push(`- before: ${beforeDir}`)
  lines.push(`- after:  ${afterDir}`)
  lines.push(`- 结论: **${passed ? 'PASS（修复后无 T/A-pose 闪现证据）' : 'FAIL（未达标，看 checks）'}**`)
  lines.push('')
  lines.push('| 指标 | before | after |')
  lines.push('| --- | --- | --- |')
  const metrics = [
    ['verdict', beforePick.verdict, afterPick.verdict],
    ['wide 帧数（T-pose）', beforePick.wideFrames, afterPick.wideFrames],
    ['transition 帧数', beforePick.transitionFrames, afterPick.transitionFrames],
    ['transparent 帧数', beforePick.transparentFrames, afterPick.transparentFrames],
    ['首个可见帧 tMs', beforePick.firstVisibleFrame?.tMs ?? null, afterPick.firstVisibleFrame?.tMs ?? null],
    ['首个可见帧 aspect', beforePick.firstVisibleFrame?.aspect ?? null, afterPick.firstVisibleFrame?.aspect ?? null],
    ['idle 稳定帧 aspect 中位', beforePick.idleAspectMedian, afterPick.idleAspectMedian],
    ['首个稳定 idle 帧 tMs', beforePick.firstStableIdleFrame?.tMs ?? null, afterPick.firstStableIdleFrame?.tMs ?? null],
    ['首可见→稳定 idle 异常窗口 ms', comparison.deltas.anomalyWindowMs.before, comparison.deltas.anomalyWindowMs.after],
    ['maxAspect', beforePick.maxAspect, afterPick.maxAspect],
    ['max wide run（帧/ms）', `${beforePick.maxWideRun?.length ?? 0} / ${beforePick.maxWideRun?.durationMs ?? 0}`, `${afterPick.maxWideRun?.length ?? 0} / ${afterPick.maxWideRun?.durationMs ?? 0}`],
    ['捕获帧数 / 有效 fps', `${beforePick.frameCount} / ${beforePick.effectiveFps}`, `${afterPick.frameCount} / ${afterPick.effectiveFps}`]
  ]
  for (const [name, beforeValue, afterValue] of metrics) {
    lines.push(`| ${name} | ${beforeValue} | ${afterValue} |`)
  }
  lines.push('')
  lines.push('## 验收 checks')
  for (const check of checks) lines.push(`- [${check.pass ? 'x' : ' '}] ${check.name} — ${check.detail}`)
  lines.push('')
  for (const phase of ['before', 'after']) {
    lines.push(`## ${phase} 前 12 帧`)
    lines.push('')
    lines.push('| # | tMs | opaque | bbox | aspect | kind | pose/weight |')
    lines.push('| --- | --- | --- | --- | --- | --- | --- |')
    for (const frame of comparison.firstFrames[phase]) {
      const bbox = frame.bbox ? `${frame.bbox.width}x${frame.bbox.height}` : '-'
      const pose = frame.pose === null ? '-' : `${frame.pose}/${frame.poseWeight ?? '-'}`
      lines.push(`| ${frame.index} | ${frame.tMs} | ${frame.opaque} | ${bbox} | ${frame.aspect ?? '-'} | ${frame.kind} | ${pose} |`)
    }
    lines.push('')
  }
  const markdown = lines.join('\n')
  writeFileSync(target.replace(/\.json$/, '.md'), markdown)
  process.stdout.write(`${markdown}\n`)
  console.error(`[capture-startup] comparison 写入 ${target}（passed=${passed}）`)
  process.exit(passed ? 0 : 2)
}

if (options.compare !== null) {
  await comparePhases(options.compare[0], options.compare[1], options.report)
} else {
  await main()
}
