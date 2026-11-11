'use strict'

/**
 * 外部 MMD 动作（VMD/VPD）× 本 PMX 的独立观感预览器 —— Electron 主进程。
 *
 * 目标：不改 app 的 src/**，用一个独立 Electron 窗口把「外部动作包直接套到
 * `assets/model/optimized/星穹铁道—砂金·戏浪.pmx`」的实际渲染结果截成 PNG + 接触表，
 * 并输出 VMD/VPD 兼容性元数据（骨骼名交集/缺失、帧率/时长、IK 帧、センター位移…）。
 *
 * 用法（仓库根目录）：
 *   ./scripts/anim-pipeline/preview/run.sh --motion tests/tmp/motions/xxx.vmd --frames 0,30,60
 *   ./scripts/anim-pipeline/preview/run.sh --vpd tests/tmp/motions/xxx.vpd
 *   PREVIEW_MOTION=... PREVIEW_FRAMES=0,30,60 ./scripts/anim-pipeline/preview/run.sh
 *
 * 无参数时：自动扫描 tests/tmp/motions/**（含 converted/ 子目录）找 VMD/VPD；
 * 找不到就用内置自造最小 VMD（真实二进制格式）跑通管线。
 *
 * 退出码：0 成功；1 运行失败；2 参数/环境错误；3 超时（watchdog）。
 */

const { app, BrowserWindow, screen } = require('electron')
const fs = require('node:fs')
const path = require('node:path')
const { pathToFileURL } = require('node:url')

const {
  inspectPmx,
  inspectVmd,
  inspectVpd,
  findMotionCandidates,
  renderCompatibilityMarkdown,
  MMD_FPS,
} = require('./lib/motion-meta.cjs')
const { buildSyntheticVmd, buildSyntheticVpd } = require('./lib/synthetic-motion.cjs')

const TOOL_NAME = 'vmd-preview'
const TOOL_VERSION = '1.1.0'
const THREE_REVISION = '171'
const ROOT = path.resolve(__dirname, '..', '..', '..')
const PREVIEW_HTML = path.join(__dirname, 'index.html')
const MOTIONS_DIR = path.join(ROOT, 'tests', 'tmp', 'motions')
const MODEL_DIRS = [path.join(ROOT, 'assets', 'model', 'optimized'), path.join(ROOT, 'assets', 'model')]

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

let logStream = null
function log(...args) {
  const line = args
    .map((value) => (typeof value === 'string' ? value : JSON.stringify(value)))
    .join(' ')
  const text = `[preview] ${line}`
  console.log(text)
  if (logStream) logStream.write(`${text}\n`)
}
function logError(...args) {
  const text = `[preview] ERROR ${args.join(' ')}`
  console.error(text)
  if (logStream) logStream.write(`${text}\n`)
}

/* ------------------------------------------------------------------ 参数解析 */

function usage() {
  return `用法: run.sh [options]
  --pmx <path>           PMX 模型（默认 assets/model/optimized/ 下自动发现）
  --motion <path>        VMD 动作文件（默认自动扫描 tests/tmp/motions/**）
  --vpd <path>           VPD 静态姿势文件（与 --motion 二选一）
  --frames <list>        VMD 采样帧号（30fps），逗号/空格分隔；默认按动作时长均匀取 4 帧
  --angles <list>        相机角度，逗号分隔：front|side|45|back|任意度数；默认 front,side,45,back
  --out <dir>            输出目录（默认 tests/tmp/preview/<动作名>）
  --size <w>x<h>         窗口/截图尺寸（默认 480x720）
  --sheet-cell <w>x<h>   接触表单格像素（默认 300x450）
  --no-sheet             不生成接触表
  --ik <on|off>          MMDAnimationHelper 的 CCDIK 开关（默认 on；off 用于对比 FK 腿被 IK 覆盖）
  --synthetic            强制用内置自造 VMD（验证管线 / 回归）
  --synthetic-vpd        强制用内置自造 VPD（验证 VPD 路径 / 回归）
  --no-verify            跳过骨骼移动量自动化断言
  --timeout <seconds>    总超时（默认 180）
  --json                 额外把 metadata.json 摘要打印到 stdout
  --debug-info           打印 mixer/骨骼调试信息（排查「动作没生效」）
  --show                 显示预览窗口（默认窗口 opacity=0 + 不可聚焦 + 穿透鼠标，用户看不见）
  --show                 显示预览窗口（默认隐藏：截图用不可见窗口，避免干扰桌面）
  -h, --help             显示本帮助
环境变量（优先级低于命令行）：PREVIEW_PMX / PREVIEW_MOTION / PREVIEW_VPD / PREVIEW_FRAMES /
  PREVIEW_ANGLES / PREVIEW_OUT / PREVIEW_SIZE / PREVIEW_IK / PREVIEW_TIMEOUT`
}

function parseArgs(argv) {
  const options = {}
  const rest = argv.slice()
  const takeValue = (index, name) => {
    if (index + 1 >= rest.length) throw new Error(`参数 ${name} 缺少值`)
    return rest[index + 1]
  }
  for (let i = 0; i < rest.length; i++) {
    const token = rest[i]
    if (token === '-h' || token === '--help') {
      options.help = true
      continue
    }
    if (token === '--no-sheet') {
      options.sheet = false
      continue
    }
    if (token === '--synthetic') {
      options.synthetic = true
      continue
    }
    if (token === '--synthetic-vpd') {
      options.syntheticVpd = true
      continue
    }
    if (token === '--no-verify') {
      options.verify = false
      continue
    }
    if (token === '--json') {
      options.json = true
      continue
    }
    if (token === '--debug-info') {
      options.debugInfo = true
      continue
    }
    if (token === '--show') {
      options.show = true
      continue
    }
    if (!token.startsWith('--')) throw new Error(`未知参数: ${token}`)
    const eq = token.indexOf('=')
    const name = eq >= 0 ? token.slice(0, eq) : token
    const inlineValue = eq >= 0 ? token.slice(eq + 1) : undefined
    const value = inlineValue !== undefined ? inlineValue : takeValue(i, name)
    if (inlineValue === undefined) i += 1
    switch (name) {
      case '--pmx':
        options.pmx = value
        break
      case '--motion':
        options.motion = value
        break
      case '--vpd':
        options.vpd = value
        break
      case '--frames':
        options.frames = value
        break
      case '--angles':
        options.angles = value
        break
      case '--out':
        options.out = value
        break
      case '--size':
        options.size = value
        break
      case '--sheet-cell':
        options.sheetCell = value
        break
      case '--ik':
        options.ik = value
        break
      case '--timeout':
        options.timeout = value
        break
      default:
        throw new Error(`未知参数: ${name}`)
    }
  }
  return options
}

function splitList(value) {
  return String(value)
    .split(/[,;\s]+/)
    .map((item) => item.trim())
    .filter((item) => item.length > 0)
}

function parseSize(text, fallback) {
  if (!text) return fallback
  const match = String(text).match(/^(\d+)x(\d+)$/i)
  if (!match) throw new Error(`尺寸格式应为 WxH: ${text}`)
  return { width: Number(match[1]), height: Number(match[2]) }
}

function sanitizeSlug(text) {
  return String(text)
    .replace(/[^\w\u4e00-\u9fff.-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'motion'
}

function resolveUserPath(filePath) {
  return path.isAbsolute(filePath) ? filePath : path.resolve(process.cwd(), filePath)
}

function findDefaultPmx() {
  for (const dir of MODEL_DIRS) {
    if (!fs.existsSync(dir)) continue
    const candidates = fs
      .readdirSync(dir)
      .filter((name) => name.toLowerCase().endsWith('.pmx'))
      .map((name) => path.join(dir, name))
    if (candidates.length > 0) return candidates[0]
  }
  return null
}

/* ------------------------------------------------------------------ 兼容性工具 */

function round(value, digits = 3) {
  const factor = 10 ** digits
  return Math.round(value * factor) / factor
}

function evaluateMotionCheck(snapshots) {
  const list = Object.entries(snapshots)
  if (list.length < 2) {
    return { ok: false, detail: '需要至少 2 帧骨骼快照才能判断是否在动', frames: [] }
  }
  const [, base] = list[0]
  if (!base) return { ok: false, detail: '骨骼快照为空', frames: [] }
  const frames = []
  let overallMaxPosition = 0
  let overallMaxAngle = 0
  for (const [label, snapshot] of list) {
    if (!snapshot) continue
    let maxPosition = 0
    let maxAngleDeg = 0
    let movedBones = 0
    const changedSamples = []
    const count = snapshot.positions.length / 3
    for (let i = 0; i < count; i++) {
      const dx = snapshot.positions[i * 3] - base.positions[i * 3]
      const dy = snapshot.positions[i * 3 + 1] - base.positions[i * 3 + 1]
      const dz = snapshot.positions[i * 3 + 2] - base.positions[i * 3 + 2]
      const distance = Math.sqrt(dx * dx + dy * dy + dz * dz)
      let dot =
        snapshot.quaternions[i * 4] * base.quaternions[i * 4] +
        snapshot.quaternions[i * 4 + 1] * base.quaternions[i * 4 + 1] +
        snapshot.quaternions[i * 4 + 2] * base.quaternions[i * 4 + 2] +
        snapshot.quaternions[i * 4 + 3] * base.quaternions[i * 4 + 3]
      dot = Math.min(1, Math.max(-1, Math.abs(dot)))
      const angleDeg = (2 * Math.acos(dot) * 180) / Math.PI
      if (distance > maxPosition) maxPosition = distance
      if (angleDeg > maxAngleDeg) maxAngleDeg = angleDeg
      if (distance > 0.01 || angleDeg > 0.5) {
        movedBones += 1
        if (changedSamples.length < 8) {
          changedSamples.push({ bone: snapshot.boneNames[i], positionDelta: round(distance, 3), angleDeg: round(angleDeg, 2) })
        }
      }
    }
    overallMaxPosition = Math.max(overallMaxPosition, maxPosition)
    overallMaxAngle = Math.max(overallMaxAngle, maxAngleDeg)
    frames.push({
      label,
      maxBonePositionDelta: round(maxPosition, 4),
      maxBoneRotationDeg: round(maxAngleDeg, 2),
      movedBones,
      changedSamples,
    })
  }
  const ok = overallMaxPosition > 0.01 || overallMaxAngle > 0.5
  return {
    ok,
    detail: ok
      ? `骨架确实在动：最大骨骼位移 ${round(overallMaxPosition, 3)} 单位 / 最大旋转 ${round(overallMaxAngle, 2)}°`
      : `骨架几乎没动（最大位移 ${round(overallMaxPosition, 4)} 单位 / 旋转 ${round(overallMaxAngle, 2)}°）`,
    maxPositionDelta: round(overallMaxPosition, 4),
    maxRotationDeg: round(overallMaxAngle, 2),
    frames,
  }
}

function buildConclusion({ model, motion, checks, motionCheck, groundCheck, ikMode }) {
  const lines = []
  if (!motion) {
    lines.push('只加载了模型（未提供 VMD/VPD）：用于检查 PMX 渲染管线本身。')
    return { lines }
  }
  if (motion.type === 'vmd') {
    const compat = motion.compatibility
    const coverage = Math.round(compat.boneCoverage * 1000) / 10
    const standardCoverage = Math.round((compat.standardCoverage || 0) * 1000) / 10
    const requiredCoverage = Math.round((compat.requiredCoverage || 0) * 1000) / 10
    lines.push(`VMD 骨骼轨道命中率 ${coverage}%（${compat.boneMatchedCount}/${motion.trackedBoneCount}）；动作本体必需骨 ${compat.requiredTrackedCount || 0}/${compat.requiredBoneCount || 0}（${requiredCoverage}%，标准人形骨含控制骨 ${compat.standardTrackedCount || 0}/${compat.standardBoneCount || 0}）；MMDLoader 会静默丢弃 ${compat.boneMissingCount} 条缺失轨道。`)
    if (requiredCoverage >= 99.9) {
      lines.push(`动作本体完整：17 根必需人形骨（躯干/四肢/足首）全部有轨道——可以直接套到本 PMX 上播放；缺失的 ${compat.boneMissingCount} 条轨道都是非标准骨（发型/裙摆/饰品/尾巴等），这些部位会保持静止（本模型自带衣服/头发，观感上等于「没有二次运动」）。`)
    } else if ((compat.requiredCoverage || 0) >= 0.8) {
      lines.push(`动作本体部分覆盖（${requiredCoverage}%）：未动到的必需骨 ${(compat.requiredUntracked || []).join('、')} 会保持 rest 位，身体姿态会不完整，需补轨道或重定向。`)
    } else {
      lines.push('动作本体覆盖不足：该 VMD 基本是给另一副骨架做的，直接套用不可用，需重定向。')
    }
    if ((compat.standardCoverage || 0) < 0.6) {
      lines.push(`提示：标准人形骨（含控制骨）覆盖仅 ${Math.round((compat.standardCoverage || 0) * 1000) / 10}%，控制骨（グルーブ/腰/目/IK親 等）缺失可能让细节不一致。`)
    }
    if (motion.ikSection.present && (motion.ikSection.records || []).length > 0) {
      const ikRecords = motion.ikSection.records
      const offCount = ikRecords.filter((record) => !record.show).length
      if (offCount === 0) {
        const sample = ikRecords.slice(0, 2).map((record) => `f${record.frame}:on(${(record.bones || []).filter(Boolean).join('/')})`).join('，')
        lines.push(`VMD 带 ${ikRecords.length} 条 IK on/off 记录且全部 show=on（${sample}）：与 r171 helper「默认始终开 IK」一致，无实际影响。`)
      } else {
        lines.push(`⚠ VMD 有 ${offCount}/${ikRecords.length} 条 IK 关闭记录，但 r171 MMDAnimationHelper 不解析 IK on/off 段 → 这些帧 IK 依然强制生效，与 MMD 官方播放器不一致（FK 腿会被拉回，可用 --ik off 对比）。`)
      }
    } else if (motion.ikSection.present) {
      lines.push('VMD 末尾有空的 IK on/off 段（0 条记录），无影响。')
    }
    if (motion.ikControlTracks.length > 0) {
      lines.push(`含足ＩＫ 控制轨道（${motion.ikControlTracks.map((track) => track.bone).join('/')}）：脚部由 CCDIK 解算（${ikMode === 'off' ? '但本次 --ik off 已关闭' : '本次开启'}）。`)
    } else if (motion.legFkTracks.length > 0) {
      lines.push('腿部走 FK（无足ＩＫ 轨道），而模型自带 4 根 IK 骨：建议对比 --ik off 截图判断 IK 是否把腿拉回 rest 位。')
    }
    if (groundCheck && groundCheck.framesSinking > 0) {
      lines.push(`⚠ 脚底穿地：有 ${groundCheck.framesSinking} 帧脚骨低于 bind pose（最大 ${groundCheck.maxAbsDelta} 单位 ≈${groundCheck.maxAbsDeltaPetPx540}px@540px 宠物），app 直接套用会插进桌面。`)
    } else if (groundCheck && groundCheck.framesFloating > 0) {
      lines.push(`脚底浮空：${groundCheck.framesFloating}/${groundCheck.sampledFrameCount || '?'} 帧脚骨高于 bind pose（最大 ${groundCheck.maxAbsDelta} 单位 ≈${groundCheck.maxAbsDeltaPetPx540}px@540px 宠物）；跑步/跳跃类动作属正常，站立类需要在 app 里按「最低脚骨/包围盒」整体贴地补偿。`)
    } else if (groundCheck) {
      lines.push(`脚底贴地良好：脚骨世界高度相对 bind pose 最大漂移仅 ${groundCheck.maxAbsDelta} 单位。`)
    }
    const center = motion.centerDisplacement.find((item) => item.bone === 'センター')
    if (center) {
      lines.push(`センター 位移范围：X ${center.translation.min[0]}..${center.translation.max[0]} / Y ${center.translation.min[1]}..${center.translation.max[1]} / Z ${center.translation.min[2]}..${center.translation.max[2]}（模型单位；1 单位≈24.9px@540px 宠物）。`)
      if (Math.abs(center.translation.maxAbs) > 1) {
        lines.push('センター 有可见位移：直接套用会带 root motion（整体上下/漂移），app 集成时需要决定是否归零/贴地。')
      }
    } else {
      lines.push('无 センター 位移轨道：动作在原地播放（站桩），不会整体漂移。')
    }
    lines.push('物理（刚体/关节/头发摆动）被显式关闭（physics:false），与本 app Wave 1/2 的决策一致；裙摆/辫子会呈静态。')
  } else if (motion.type === 'vpd') {
    const compat = motion.compatibility
    lines.push(`VPD 骨名命中率 ${Math.round(compat.boneCoverage * 1000) / 10}%（${compat.boneMatchedCount}/${motion.boneCount}），helper.pose 按骨名查表应用后做 CCDIK+grant。`)
    if (motionCheck && motionCheck.vpdChangedBones > 0) {
      lines.push(`VPD 确实改变了姿势（${motionCheck.vpdChangedBones} 根骨偏离 rest）。`)
    }
    if (compat.boneMissingCount > 0) {
      lines.push(`缺失骨名：${compat.boneMissing.join('、')}（这些块会被静默跳过）。`)
    }
    lines.push('VPD 是静态姿势（无时间轴）：只可用于「摆一个姿势截图」，不能当动作播放。')
  }
  if (!checks.every((check) => check.ok)) {
    lines.push(`⚠ 有 ${checks.filter((check) => !check.ok).length} 项自动断言未通过，先看 compatibility.md 的失败项。`)
  }
  return { lines }
}

/* ------------------------------------------------------------------ 主流程 */

async function run() {
  const startedAt = Date.now()
  const startedAtIso = new Date(startedAt).toISOString()
  const options = parseArgs(process.argv.slice(2))
  if (options.help) {
    console.log(usage())
    app.exit(0)
    return
  }
  if (!process.versions.electron) {
    logError('必须用 Electron 启动（本文件是主进程脚本）。请用 ./scripts/anim-pipeline/preview/run.sh')
    process.exit(2)
  }

  const env = process.env
  const timeoutSeconds = Number(options.timeout || env.PREVIEW_TIMEOUT || 180)
  const watchdog = setTimeout(() => {
    logError(`watchdog 超时（${timeoutSeconds}s），强制退出`)
    app.exit(3)
  }, Math.max(10, timeoutSeconds) * 1000)

  let win = null
  try {
    /* ---------- 1. 解析输入 ---------- */
    const pmxPath = options.pmx
      ? resolveUserPath(options.pmx)
      : env.PREVIEW_PMX
        ? resolveUserPath(env.PREVIEW_PMX)
        : findDefaultPmx()
    if (!pmxPath || !fs.existsSync(pmxPath)) throw new Error(`找不到 PMX 模型: ${pmxPath || '(默认目录无 pmx)'}`)

    const outDir = options.out
      ? resolveUserPath(options.out)
      : env.PREVIEW_OUT
        ? resolveUserPath(env.PREVIEW_OUT)
        : null
    fs.mkdirSync(outDir || path.join(ROOT, 'tests', 'tmp', 'preview'), { recursive: true })

    // 动作优先级：CLI > env > 自动扫描 tests/tmp/motions/** > 内置自造。
    const candidates = findMotionCandidates(MOTIONS_DIR)
    let motionKind = null // 'vmd' | 'vpd' | null
    let motionPath = null
    let synthetic = false

    if (options.syntheticVpd) {
      motionKind = 'vpd'
      synthetic = true
    } else if (options.synthetic) {
      motionKind = 'vmd'
      synthetic = true
    } else if (options.motion) {
      motionKind = 'vmd'
      motionPath = resolveUserPath(options.motion)
    } else if (options.vpd) {
      motionKind = 'vpd'
      motionPath = resolveUserPath(options.vpd)
    } else if (env.PREVIEW_MOTION) {
      motionKind = 'vmd'
      motionPath = resolveUserPath(env.PREVIEW_MOTION)
    } else if (env.PREVIEW_VPD) {
      motionKind = 'vpd'
      motionPath = resolveUserPath(env.PREVIEW_VPD)
    } else if (candidates.vmd.length > 0) {
      motionKind = 'vmd'
      motionPath = candidates.vmd[0].path
      log(`自动发现 VMD：${motionPath}`)
    } else if (candidates.vpd.length > 0) {
      motionKind = 'vpd'
      motionPath = candidates.vpd[0].path
      log(`自动发现 VPD：${motionPath}`)
    } else {
      motionKind = 'vmd'
      synthetic = true
      log(`tests/tmp/motions/ 下没有 VMD/VPD（扫描 ${candidates.scanned} 个文件），使用内置自造最小 VMD`)
    }

    const runName = sanitizeSlug(
      synthetic
        ? motionKind === 'vpd'
          ? 'synthetic-vpd'
          : 'synthetic-vmd'
        : path.basename(motionPath, path.extname(motionPath))
    )
    const finalOutDir = outDir || path.join(ROOT, 'tests', 'tmp', 'preview', runName)
    fs.mkdirSync(finalOutDir, { recursive: true })
    logStream = fs.createWriteStream(path.join(finalOutDir, 'run.log'), { flags: 'w' })

    if (synthetic) {
      motionPath = path.join(finalOutDir, motionKind === 'vpd' ? 'synthetic-test.vpd' : 'synthetic-test.vmd')
      if (motionKind === 'vpd') fs.writeFileSync(motionPath, buildSyntheticVpd(), 'utf8')
      else fs.writeFileSync(motionPath, buildSyntheticVmd())
      log(`已生成内置测试动作：${motionPath}`)
    }
    if (!fs.existsSync(motionPath)) throw new Error(`找不到动作文件: ${motionPath}`)

    const size = parseSize(options.size || env.PREVIEW_SIZE, { width: 480, height: 720 })
    const sheetEnabled = options.sheet !== false && env.PREVIEW_SHEET !== '0'
    const sheetCell = parseSize(options.sheetCell, { width: 300, height: 450 })
    const ikMode = String(options.ik || env.PREVIEW_IK || 'on').toLowerCase() === 'off' ? 'off' : 'on'
    const verify = options.verify !== false

    /* ---------- 2. 静态解析（main 侧独立体检） ---------- */
    log(`解析 PMX: ${pmxPath}`)
    const model = inspectPmx(pmxPath)
    log(`模型 ${model.counts.bones} 骨 / ${model.counts.morphs} morph / IK ${model.ikBones.length} 根`)

    log(`解析动作: ${motionPath}`)
    const motion = motionKind === 'vmd'
      ? inspectVmd(motionPath, { boneNames: model.boneNames, morphNames: model.morphNames, ikBoneNames: model.ikBones.map((ik) => ik.name) })
      : inspectVpd(motionPath, { boneNames: model.boneNames })
    motion.synthetic = synthetic

    if (motionKind === 'vmd') {
      log(`VMD ${motion.metadata.motionCount} 骨骼关键帧 / 帧 ${motion.minFrame}-${motion.maxFrame} (${motion.durationSec}s) / 轨道骨 ${motion.trackedBoneCount} / 命中 ${motion.compatibility.boneMatchedCount}`)
      if (motion.compatibility.boneMissing.length > 0) {
        log(`缺失骨骼名 ${motion.compatibility.boneMissing.length} 个：${motion.compatibility.boneMissing.join('、')}`)
      }
    } else {
      log(`VPD ${motion.boneCount} 骨 / 命中 ${motion.compatibility.boneMatchedCount} / 编码 ${motion.encoding}`)
    }

    /* ---------- 3. 采样帧 / 角度 ---------- */
    let frames
    if (motionKind === 'vmd') {
      const requested = options.frames || env.PREVIEW_FRAMES
      if (requested) {
        frames = splitList(requested).map((item) => {
          const value = Number(item)
          if (!Number.isFinite(value) || value < 0) throw new Error(`非法帧号: ${item}`)
          return Math.round(value)
        })
      } else {
        const maxFrame = Math.max(0, motion.maxFrame)
        const fractions = [0, 0.33, 0.66, 1]
        frames = fractions.map((fraction) => Math.round(maxFrame * fraction))
      }
      frames = Array.from(new Set(frames)).sort((a, b) => a - b)
      if (frames.length === 0) frames = [0]
      const beyond = frames.filter((frame) => frame > motion.maxFrame)
      if (beyond.length > 0) log(`警告：帧 ${beyond.join(',')} 超过动作最大帧 ${motion.maxFrame}（AnimationMixer 会循环播放）`)
    } else {
      frames = [null] // VPD 为静态姿势
    }

    const anglesRaw = options.angles || env.PREVIEW_ANGLES || 'front,side,45,back'
    const angles = splitList(anglesRaw)
    if (angles.length === 0) throw new Error('--angles 不能为空')
    log(`采样：帧 [${frames.map((frame) => (frame === null ? 'static' : frame)).join(', ')}] × 角度 [${angles.join(', ')}]`)

    /* ---------- 4. 启动 Electron 渲染窗口 ---------- */
    app.commandLine.appendSwitch('allow-file-access-from-files')

    await app.whenReady()
    // 默认不显示窗口：截图走 webContents.capturePage，不需要用户屏幕；
    // 只有显式 --show（或 PREVIEW_SHOW=1）才显示，避免验证时在桌面上闪/转模型。
    const showWindow = Boolean(options.show) || env.PREVIEW_SHOW === '1'
    if (!showWindow && app.dock) app.dock.hide()
    const workArea = screen.getPrimaryDisplay().workArea
    win = new BrowserWindow({
      width: size.width,
      height: size.height,
      x: workArea.x + Math.max(0, Math.round((workArea.width - size.width) / 2)),
      y: workArea.y + Math.max(0, Math.round((workArea.height - size.height) / 2)),
      useContentSize: true,
      show: true, // 保持显示以便 macOS 合成器持续渲染（capturePage 稳定）；用 opacity 0 让它对用户不可见
      opacity: showWindow ? 1 : 0,
      focusable: showWindow,
      frame: false,
      transparent: true,
      backgroundColor: '#00000000',
      hasShadow: false,
      resizable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      title: 'aventurine-vmd-preview',
      webPreferences: {
        webSecurity: false, // 允许 file:// 页面用 ES module import node_modules/three + 读 assets/model/optimized
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
        backgroundThrottling: false,
        devTools: false,
      },
    })

    if (!showWindow) win.setIgnoreMouseEvents(true, { forward: true })

    const consoleMessages = []
    win.webContents.on('console-message', (event, level, message) => {
      const text = String(message)
      consoleMessages.push(text)
      if (!text.includes('deprecated') && !text.includes('THREE.MMDLoader') && !text.includes('THREE.MMDAnimationHelper')) {
        log(`[renderer] ${text}`)
      }
    })
    win.webContents.on('render-process-gone', (_event, details) => {
      logError(`renderer 进程崩溃: ${JSON.stringify(details)}`)
      app.exit(1)
    })
    win.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedUrl) => {
      logError(`页面加载失败 ${errorCode} ${errorDescription} ${validatedUrl}`)
    })

    log('加载预览页 index.html')
    await win.loadFile(PREVIEW_HTML)

    const evalJs = async (code, timeoutMs, label) => {
      const result = await Promise.race([
        win.webContents.executeJavaScript(code, true),
        new Promise((resolve, reject) => setTimeout(() => reject(new Error(`executeJavaScript 超时: ${label}`)), timeoutMs)),
      ])
      return result
    }

    // 等 renderer 模块就绪
    const readyDeadline = Date.now() + 20000
    let rendererReady = false
    while (Date.now() < readyDeadline) {
      try {
        rendererReady = await win.webContents.executeJavaScript('Boolean(window.__preview && window.__preview.init)')
      } catch {
        rendererReady = false
      }
      if (rendererReady) break
      await sleep(100)
    }
    if (!rendererReady) throw new Error('renderer 未在 20s 内就绪（importmap/模块加载失败？）')
    log('renderer 模块就绪，开始加载 PMX/动作')

    /* ---------- 5. 初始化 renderer（加载 PMX + 动作） ---------- */
    const initConfig = {
      pmxUrl: pathToFileURL(pmxPath).href,
      angles,
      frames: frames.filter((frame) => frame !== null),
      ik: ikMode,
      motion:
        motionKind === 'vmd'
          ? { kind: 'vmd', url: pathToFileURL(motionPath).href, file: path.basename(motionPath) }
          : motionKind === 'vpd'
            ? { kind: 'vpd', vpd: { bones: motion.bones.map((bone) => ({ name: bone.name, translation: bone.translation, quaternion: bone.quaternion })) }, file: path.basename(motionPath) }
            : null,
    }
    if (motionKind === 'vmd') initConfig.ik = ikMode === 'off' ? false : true

    const initStart = Date.now()
    const initResult = await evalJs(`window.__preview.init(${JSON.stringify(initConfig)})`, 180000, 'init')
    if (!initResult || initResult.ok !== true) {
      throw new Error(`renderer init 失败: ${JSON.stringify(initResult, null, 2)}`)
    }
    log(`模型加载完成（${Date.now() - initStart}ms）：${initResult.model.vertices} 顶点 / ${initResult.model.materials} 材质 / 贴图 ${initResult.textureStats.loaded.length} 张（失败 ${initResult.textureStats.failed.length}）`)

    /* ---------- 6. 逐帧 × 角度截图 ---------- */
    const framesDir = path.join(finalOutDir, 'frames')
    fs.mkdirSync(framesDir, { recursive: true })
    const samples = []
    const snapshots = {}
    const footProbes = {}
    for (const frame of frames) {
      for (const angle of angles) {
        const prepare = await evalJs(
          `window.__preview.prepareFrame(${JSON.stringify({ frame, angle })})`,
          60000,
          `prepareFrame(${frame},${angle})`
        )
        if (!prepare || prepare.ok !== true) throw new Error(`渲染帧失败 (${frame}, ${angle}): ${JSON.stringify(prepare)}`)
        if (options.debugInfo) {
          const debugInfo = await evalJs('window.__preview.debugInfo()', 30000, 'debugInfo')
          log(`[debug] ${JSON.stringify(debugInfo)}`)
        }
        if (verify && angle === angles[0]) {
          const snapshot = await evalJs('window.__preview.boneSnapshot()', 30000, 'boneSnapshot')
          snapshots[frame === null ? 'static' : `f${frame}`] = snapshot
          const footProbe = await evalJs('window.__preview.footProbe()', 30000, 'footProbe')
          if (footProbe) footProbes[frame === null ? 'static' : String(frame)] = footProbe
        }
        await sleep(60) // 给合成器提交一帧
        const image = await win.webContents.capturePage()
        const fileName = `f${frame === null ? 'static' : String(frame).padStart(4, '0')}-${sanitizeSlug(angle)}.png`
        fs.writeFileSync(path.join(framesDir, fileName), image.toPNG())
        samples.push({
          frame,
          angle,
          file: path.join('frames', fileName),
          stats: prepare.stats,
          renderMs: prepare.renderMs,
          seek: prepare.seek,
        })
        if (prepare.stats && prepare.stats.tainted) {
          logError(`帧 (${frame}, ${angle}) 读回失败/tainted：${prepare.stats.error || ''}`)
        }
        log(`截图 ${path.join('frames', fileName)}：alpha 覆盖 ${(prepare.stats.nonTransparentRatio * 100).toFixed(2)}%${prepare.seek && prepare.seek.frame !== null ? `，t=${prepare.seek.seconds.toFixed(3)}s` : ''}`)
      }
    }

    /* ---------- 7. 骨骼运动量断言 ---------- */
    let motionCheck = null
    if (verify) {
      if (motionKind === 'vmd' && motion.maxFrame <= 2) {
        // 例如 "Arms Down.vmd" 这种单帧姿势导出：没有时间轴，不作运动量断言。
        motionCheck = {
          ok: true,
          skipped: true,
          detail: `VMD 只有 ${motion.minFrame}-${motion.maxFrame} 帧（静态姿势，无时间轴），跳过运动量断言`,
          frames: [],
        }
      } else if (motionKind === 'vmd') {
        motionCheck = evaluateMotionCheck(snapshots)
      } else if (motionKind === 'vpd') {
        const vpdCheck = initResult.motion && initResult.motion.vpdCheck
        motionCheck = {
          ok: Boolean(vpdCheck && vpdCheck.changedBones > 0),
          detail: vpdCheck
            ? `VPD 应用后 ${vpdCheck.changedBones}/${vpdCheck.totalBones} 根骨偏离 rest 姿势`
            : '无 VPD 姿势变化数据',
          vpdChangedBones: vpdCheck ? vpdCheck.changedBones : 0,
          sample: vpdCheck ? vpdCheck.sample : [],
        }
      }
      if (motionCheck) log(`运动量断言：${motionCheck.ok ? 'PASS' : 'FAIL'} — ${motionCheck.detail}`)
    }

    // 3.5) 脚底贴地检查：VMD 的 センター/腿部让脚骨世界高度相对 bind pose 漂移多少
    let groundCheck = null
    const footEntries = Object.entries(footProbes)
    if (footEntries.length > 0) {
      const restMinY = footEntries[0][1].rest ? footEntries[0][1].rest.minY : null
      const perFrame = footEntries.map(([label, probe]) => ({
        frame: label === 'static' ? null : Number(label),
        footMinY: probe.current ? probe.current.minY : null,
        minBone: probe.current ? probe.current.minBone : null,
        deltaFromRest: probe.minYDelta,
      }))
      const deltas = perFrame.map((item) => Math.abs(item.deltaFromRest || 0))
      const maxAbsDelta = deltas.length > 0 ? Math.max(...deltas) : 0
      const floating = perFrame.filter((item) => (item.deltaFromRest || 0) > 0.3).length
      const sinking = perFrame.filter((item) => (item.deltaFromRest || 0) < -0.3).length
      groundCheck = {
        restFootMinY: restMinY,
        sampledFrameCount: perFrame.length,
        perFrame,
        maxAbsDelta: round(maxAbsDelta, 4),
        maxAbsDeltaPetPx540: round(maxAbsDelta * (540 / 21.681), 1),
        framesFloating: floating,
        framesSinking: sinking,
        // 判定口径：脚骨「低于 bind pose」= 穿地风险（失败）；「高于」= 浮空（app 可整体下移贴地，
        // 只作为观感提示，不作为失败）。
        ok: sinking === 0,
      }
      log(`脚底贴地：脚骨世界高度相对 bind pose 最大漂移 ${groundCheck.maxAbsDelta} 单位（≈${groundCheck.maxAbsDeltaPetPx540}px@540 宠物），浮空帧 ${floating} / 陷地帧 ${sinking}`)
    }

    /* ---------- 8. 接触表 ---------- */
    let contactSheet = null
    if (sheetEnabled) {
      const sheetGridColumns = angles.length === 1 && frames.length > 6 ? 4 : null
      const sheetResult = await evalJs(
        `window.__preview.composeSheet(${JSON.stringify({ frames, angles, cellWidth: sheetCell.width, cellHeight: sheetCell.height, gridColumns: sheetGridColumns })})`,
        180000,
        'composeSheet'
      )
      if (!sheetResult || sheetResult.ok !== true) throw new Error(`接触表合成失败: ${JSON.stringify(sheetResult)}`)
      const sheetFile = 'contact-sheet.png'
      fs.writeFileSync(path.join(finalOutDir, sheetFile), Buffer.from(sheetResult.base64, 'base64'))
      contactSheet = {
        file: sheetFile,
        width: sheetResult.width,
        height: sheetResult.height,
        rows: sheetResult.rows || frames.length,
        cols: sheetResult.cols || angles.length,
        sampledFrames: frames.length,
        sampledAngles: angles.length,
      }
      log(`接触表：${path.join(finalOutDir, sheetFile)}（${sheetResult.width}×${sheetResult.height}）`)
    }

    /* ---------- 9. 自动化断言 + 结论 + 落盘 ---------- */
    const expectedTextures = model.counts.textures || model.textureRefs.length
    const checks = []
    const addCheck = (name, ok, detail) => checks.push({ name, ok, detail })
    addCheck('模型加载', initResult.model.boneCount === model.counts.bones, `renderer ${initResult.model.boneCount} 骨 vs main 解析 ${model.counts.bones} 骨`)
    addCheck(
      '贴图加载',
      initResult.textureStats.failed.length === 0 && initResult.textureStats.loaded.length >= expectedTextures,
      `成功 ${initResult.textureStats.loaded.length}/${expectedTextures}，失败 ${initResult.textureStats.failed.length}`
    )
    addCheck('贴图未 taint（可读回）', samples.every((sample) => sample.stats && sample.stats.tainted === false), '所有帧 getImageData 成功')
    addCheck(
      '渲染非空白（透明背景之上有模型像素）',
      samples.every((sample) => sample.stats && sample.stats.nonTransparentRatio > 0.005),
      `最小 alpha 覆盖 ${Math.min(...samples.map((sample) => (sample.stats ? sample.stats.nonTransparentRatio : 0)))}`
    )
    addCheck('截图数量', samples.length === frames.length * angles.length, `${samples.length} 张（期望 ${frames.length * angles.length}）`)
    if (motionCheck && !motionCheck.skipped) addCheck('骨架运动量', motionCheck.ok, motionCheck.detail)
    if (motionCheck && motionCheck.skipped) log(`运动量断言：SKIP — ${motionCheck.detail}`)
    if (groundCheck) {
      addCheck(
        '脚底不穿地（脚骨不显著低于 bind pose）',
        groundCheck.ok,
        `最大高度漂移 ${groundCheck.maxAbsDelta} 单位（≈${groundCheck.maxAbsDeltaPetPx540}px@540），浮空帧 ${groundCheck.framesFloating}、陷地帧 ${groundCheck.framesSinking}`
      )
    }

    const runtimeCheck = {
      webglVersion: initResult.renderer.webglVersion,
      devicePixelRatio: initResult.renderer.devicePixelRatio,
      viewport: initResult.renderer.viewport,
      ikMode,
    }

    const conclusion = buildConclusion({ model, motion, checks, motionCheck, groundCheck, ikMode })

    const metadata = {
      tool: {
        name: TOOL_NAME,
        version: TOOL_VERSION,
        threeRevision: THREE_REVISION,
        electronVersion: process.versions.electron,
        nodeVersion: process.versions.node,
        command: process.execPath,
        argv: process.argv.slice(2),
        synthetic,
      },
      timings: {
        startedAtIso,
        totalMs: Date.now() - startedAt,
        initMs: Date.now() - initStart,
      },
      inputs: {
        pmx: pmxPath,
        motion: motionPath,
        motionKind,
        frames,
        angles,
        size,
        sheetCell,
        sheetEnabled,
        ikMode,
        verify,
        outDir: finalOutDir,
      },
      model,
      motion: { ...motion, synthetic },
      runtime: {
        ...initResult.model,
        textureStats: initResult.textureStats,
        clip: initResult.motion,
        ...runtimeCheck,
      },
      samples,
      motionCheck,
      groundCheck,
      contactSheet,
      checks,
      conclusion,
      rendererConsoleTail: consoleMessages.slice(-40),
    }

    fs.writeFileSync(path.join(finalOutDir, 'metadata.json'), `${JSON.stringify(metadata, null, 2)}\n`)
    fs.writeFileSync(path.join(finalOutDir, 'compatibility.md'), `${renderCompatibilityMarkdown(metadata)}\n`)
    // 接触表里的索引页（人/agent 快速对照）
    const indexLines = [
      `# 预览证据索引：${path.basename(finalOutDir)}`,
      '',
      `- 动作：${motion.file}（${motion.type.toUpperCase()}${synthetic ? '，内置自造' : ''}）`,
      `- 模型：${model.file}`,
      `- 接触表：contact-sheet.png（${frames.length} 行帧 × ${angles.length} 列角度）`,
      `- 元数据：metadata.json / compatibility.md`,
      '',
      ...samples.map((sample) => `- \`${sample.file}\` — frame=${sample.frame === null ? 'static' : sample.frame} angle=${sample.angle} alpha=${(sample.stats.nonTransparentRatio * 100).toFixed(2)}%`),
      '',
    ]
    fs.writeFileSync(path.join(finalOutDir, 'index.md'), `${indexLines.join('\n')}\n`)

    /* ---------- 10. 输出摘要 + 退出 ---------- */
    log('================ 预览完成 ================')
    log(`输出目录：${finalOutDir}`)
    log(`截图：${samples.length} 张（frames/）+ 接触表 ${contactSheet ? contactSheet.file : '(未生成)'}`)
    log(`骨骼兼容：${motion.type === 'vmd' ? `命中 ${motion.compatibility.boneMatchedCount}/${motion.trackedBoneCount}（缺失 ${motion.compatibility.boneMissingCount}）` : `命中 ${motion.compatibility.boneMatchedCount}/${motion.boneCount}`}`)
    if (motion.type === 'vmd') {
      log(`VMD：${motion.frameRate}fps / ${motion.minFrame}-${motion.maxFrame} 帧 / ${motion.durationSec}s / IK 段 ${motion.ikSection.present ? `${motion.ikSection.count} 条` : '无'} / センター位移 ${motion.centerDisplacement.length > 0 ? motion.centerDisplacement.map((item) => `${item.bone} maxAbs ${item.translation.maxAbs}`).join('，') : '无'}`)
    }
    log(`断言：${checks.filter((check) => check.ok).length}/${checks.length} 通过`)
    for (const line of conclusion.lines) log(`结论：${line}`)
    if (options.json) console.log(JSON.stringify({ ok: true, outDir: finalOutDir, checks, conclusion }, null, 2))
    log('PREVIEW_OK')

    clearTimeout(watchdog)
    if (logStream) logStream.end()
    await sleep(120)
    app.exit(0)
  } catch (error) {
    const message = error && error.stack ? error.stack : String(error)
    logError(message)
    try {
      const outDir = options && options.out ? resolveUserPath(options.out) : path.join(ROOT, 'tests', 'tmp', 'preview', '_failed')
      fs.mkdirSync(outDir, { recursive: true })
      fs.writeFileSync(path.join(outDir, 'failure.log'), `${new Date().toISOString()}\n${message}\n`)
    } catch {
      /* ignore */
    }
    if (win && !win.isDestroyed()) {
      try {
        const state = await win.webContents.executeJavaScript(
          'JSON.stringify(window.__preview ? { ...window.__preview.getState(), model: window.__preview.getState().model ? { boneCount: window.__preview.getState().model.boneCount, vertices: window.__preview.getState().model.vertices, materials: window.__preview.getState().model.materials } : null } : null)'
        )
        logError(`renderer 状态：${state}`)
      } catch {
        /* ignore */
      }
    }
    log('PREVIEW_FAIL')
    clearTimeout(watchdog)
    if (logStream) logStream.end()
    app.exit(1)
  }
}

app.on('window-all-closed', () => {
  // 由 run() 显式 app.exit()，这里只兜底（避免窗口全关后进程悬挂）。
})

run().catch((error) => {
  logError(error && error.stack ? error.stack : String(error))
  app.exit(1)
})
