#!/usr/bin/env node
/**
 * `straighten-standing-knees.mjs` — 静态站立 clip「膝拉直」数据侧 bake（不依赖 Unity）。
 *
 * 背景（investigation：`tests/tmp/inv-leg2/REPORT.md` §13）：
 * 一部分用户可见的**站立 idle / 一次性社交** clip 的作者数据本身就屈膝（膝角均值
 * 166–174°，比伸直少 6–14°）。这些 clip 在 one-shot/manual 路径（foot-lock allow=false）
 * 下腿形 = 作者数据，运行时 IK 再准也修不了；P2 方案是**数据侧 bake**：在不移动脚位、
 * 不改变其他骨骼/元数据的前提下，把站立膝角拉到目标范围。
 *
 * 算法（逐帧，真实 VRM 的 normalized humanoid rig）：
 *   1. 复刻产品层序 `clip JSON → normalized 骨 + Hips.p（按 hipsRestHeight/sourceHipsHeight
 *      缩放）→ 贴地常量补偿（grounding==='feet'：首帧脚骨最低点对齐 rest 脚骨）→ FK 测量`；
 *   2. 量作者每帧左右膝角（髋-膝-踝）与髋/踝位置（avatar.scene 局部坐标）：
 *      膝角只由「髋→踝距离」唯一决定（余弦定理，腿骨长固定）；
 *   3. 目标：每帧膝角 = 作者膝角 + Δ_leg（**只拉直、绝不掰弯**，Δ≥0），Δ 按 clip 类别
 *      （idle 轮换池 / 社交一次性）与左右差异方向解出，并保证「最差帧」也达下限；
 *   4. 髋位移 δ：先按任务规定的 **1 维最小二乘**解 hips.y 抬升（δy，|δ|≤5mm），再补一个
 *      极小的 hips x/z 修正（默认上限 30mm，实测绝大多数 clip ≤6mm）以让**左右两条腿同时**
 *      命中各自目标 —— 近伸直时左右膝角差对应的髋→踝距离差会被放大（1°≈0.3mm），单靠
 *      δy 无法同时满足「左右差异方向保留」+「最差帧 ≥ 下限」，这一步是几何必需（见报告）；
 *   5. 用与 `src/renderer/src/vrm/foot-lock.ts` 同款的**两骨 IK**（solveKneePosition 算法，
 *      IK 余量从运行时 1mm 放宽到 1e-6m：数据侧姿态本身可以到 175.5–179.5°，不需要运行时
 *      防抖余量）在**脚踝位置固定、脚朝向固定**的前提下重解 UpperLeg/LowerLeg，并反解 Foot
 *      局部旋转保持脚的世界朝向不变；
 *   6. 写回 clip JSON：只改 `Hips.p`（按 `sourceHipsHeight/hipsRestHeight` 换算回源单位）与
 *      `Left/RightUpperLeg.r`、`Left/RightLowerLeg.r`、`Left/RightFoot.r`；其他骨/字段逐位保留；
 *      数值按数据约定 round 到 7 位小数；NaN/越界防护。
 *
 * 产品口径同步（只读参考，不 import TS，避免 Node 里解析 `@shared` 别名）：
 * - `src/renderer/src/vrm/clip-data.ts`（parseClipData / sample* / hipsPositionScale）；
 * - `src/renderer/src/vrm/humanoid-map.ts`（Unity→VRM normalized 映射，脚本用仓库内纯 ESM
 *   权威副本 `scripts/unity-bake/lib/humanoid-map.mjs`）；
 * - `src/renderer/src/vrm/clip-player.ts`（贴地：grounding==='feet' → 首帧脚骨最低点对齐 rest
 *   脚骨；Hips.p 缩放 = hipsRestHeight/sourceHipsHeight）；
 * - `src/renderer/src/vrm/foot-lock.ts`（两骨 IK + 世界→局部四元数写回）。
 *
 * 子命令：
 *   analyze                 只做 FK 统计 / 清单筛选，打印表格，不写盘。
 *   bake                    默认。分析 + bake + 写 staging + 数值验证 + 写 metrics。
 *   validate                重新读取 staging，复跑数值验证（不重 bake）。
 *   apply   --yes           备份 → 原子写入 assets/motions/** → 复验 → 失败自动回滚。
 *   rollback --yes          从备份目录一键恢复（幂等）。
 *
 * 安全边界：
 * - **bake 只写 `tests/tmp/bake-leg/staging/**`，绝不碰 `assets/**`**；`apply` 必须显式
 *   `--yes`（且需要 Lead 批准），写前备份到 `assets/motions-leg-backup-2026-11-11/<相对路径>`，
 *   写入后复验，任何失败自动回滚本次写入。
 * - `--motions-dir` / `--backup-dir` / `--out-dir` 可覆盖路径（离线 apply 演练用）。
 *
 * 退出码：0 = 通过；1 = 失败（验证不过/清单为空/apply 被拒/写入后复验失败）。
 *
 * 用法示例：
 *   node scripts/vrm/motion/straighten-standing-knees.mjs analyze
 *   node scripts/vrm/motion/straighten-standing-knees.mjs bake
 *   node scripts/vrm/motion/straighten-standing-knees.mjs validate
 *   node scripts/vrm/motion/straighten-standing-knees.mjs apply --yes
 *   node scripts/vrm/motion/straighten-standing-knees.mjs rollback --yes
 */
import { execSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { Quaternion, Vector3 } from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { VRMLoaderPlugin } from '@pixiv/three-vrm'

import { UNITY_TO_VRM_BONE } from '../../unity-bake/lib/humanoid-map.mjs'

/* -------------------------------------------------------------------------- */
/* 路径 / 常量                                                                  */
/* -------------------------------------------------------------------------- */

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))
/** 仓库根（脚本位于 scripts/vrm/motion/）。 */
export const REPO_ROOT = resolve(SCRIPT_DIR, '../../..')

/** 默认真实 VRM（用户可见资产；只读）。 */
export const DEFAULT_VRM = join(REPO_ROOT, 'assets/vrm/aventurine-tpose.vrm')
/** 默认动作目录（relPath = `<set>/<clip>.json`）。 */
export const DEFAULT_MOTIONS_DIR = join(REPO_ROOT, 'assets/motions')
/** 默认 staging / 指标输出目录（不进 git）。 */
export const DEFAULT_OUT_DIR = join(REPO_ROOT, 'tests/tmp/bake-leg')
/** 默认备份根目录（相对 motions 目录保留子路径；gitignored 之外的本地目录，勿提交）。 */
export const DEFAULT_BACKUP_DIR = join(REPO_ROOT, 'assets/motions-leg-backup-2026-11-11')

const DEG = 180 / Math.PI
const RAD = Math.PI / 180

/** 数值写回精度（与现有 clip 数据一致：7 位小数，见测试/报告）。 */
const WRITE_DECIMALS = 7

/** 腿骨（改名/读取时统一用 Unity HumanBodyBones 名）。 */
const LEG_BONES = Object.freeze({
  leftUpper: 'LeftUpperLeg',
  leftLower: 'LeftLowerLeg',
  leftFoot: 'LeftFoot',
  rightUpper: 'RightUpperLeg',
  rightLower: 'RightLowerLeg',
  rightFoot: 'RightFoot',
  hips: 'Hips'
})
const LEG_BONE_NAMES = Object.freeze([
  LEG_BONES.hips,
  LEG_BONES.leftUpper,
  LEG_BONES.leftLower,
  LEG_BONES.leftFoot,
  LEG_BONES.rightUpper,
  LEG_BONES.rightLower,
  LEG_BONES.rightFoot
])
/** 脚骨 raw 节点（贴地测量用，与 clip-player FEET_BONE_NAMES 同口径）。 */
const RAW_FOOT_BONES = Object.freeze(['leftFoot', 'rightFoot', 'leftToes', 'rightToes'])

/** 默认参数（报告里逐项记录；CLI 可覆盖）。 */
export const DEFAULT_PARAMS = Object.freeze({
  /** idle 轮换池目标均值膝角（度）。 */
  idleBaseDeg: 175.5,
  /** idle 轮换池最差帧下限（accepted worst 174° + 0.1° 数值余量）。 */
  idleFloorDeg: 174.1,
  /** idle 轮换池验收：均值 / 最差下限（任务门禁）。 */
  idleAcceptAvgDeg: 175.5,
  idleAcceptWorstDeg: 174,
  /** 社交/一次性目标均值膝角（度）。 */
  socialBaseDeg: 173,
  /** 社交/一次性最差帧下限（accepted worst 170° + 0.2° 数值余量）。 */
  socialFloorDeg: 170.2,
  socialAcceptAvgDeg: 172,
  socialAcceptWorstDeg: 170,
  /** 逐腿目标上限（任务要求 min(θ_target, 180−1)；数据侧取 179.5° 更稳）。 */
  capDeg: 179.5,
  /** hips.y 抬升上限（任务门禁 ≤5mm）。 */
  maxLiftMm: 5,
  /** hips.y 允许的向下容差（近伸直时个别帧可能需要 ~-0.1mm；不改变「抬髋」语义）。 */
  minLiftMm: -1,
  /** hips x/z 修正上限（几何必需的左右差异补偿；默认 30mm，见报告）。 */
  maxHorizontalMm: 30,
  /** 数值验证门禁。 */
  footDriftMm: 0.5,
  footOrientationDeg: 0.5,
  loopContinuityMm: 0.1,
  kneeRangeGrowthDeg: 0.5,
  /** 数据侧两骨 IK 允许的最大距离余量（米；运行时是 1mm，数据侧放宽到 0.001mm）。 */
  ikMarginM: 1e-6,
  /** 数值验证容差（膝角；度）。 */
  kneeTolDeg: 0.02,
  /** 一个 clip 被判为「静态站立」的筛选条件（与 §13.2 审计同口径）。 */
  standingKneeMinDeg: 145,
  standingHipsYRefM: 1.02,
  standingHipsYTolM: 0.18,
  standingAnkleYMaxM: 0.16,
  staticKneeRangeMaxDeg: 10,
  bentMeanKneeMaxDeg: 174,
  /** 「髋部水平位移需人工复核」的提示阈值（像素 @540px 宠物高 311.4px/m）。 */
  horizontalWarnMm: 6,
  /** 每米多少像素（540px 宠物 / 1.734m 模型；报告换算用）。 */
  pixelsPerMeter: 311.4
})

/**
 * IdleOneShotFidget 一次性池（与 `src/renderer/src/reactions/idle-one-shot-fidget.ts`
 * 的 `IDLE_ONE_SHOT_FIDGET_DEFAULTS.clipIds` 同步；脚本不能 import TS）。
 */
export const FIDGET_POOL_IDS = Object.freeze([
  'adv-talk01',
  'adv-talk02',
  'adv-bye01',
  'adv-idleShow',
  'adv-idleShow2',
  'adv-lookAtPhone',
  'adv-watchphone01loop',
  'adv-useheadphone01loop'
])

/** 参与「用户可见站立」审计的 app-manifest mood（§13.1；walk/sit/sleep 等不在内）。 */
const STANDING_MOODS = Object.freeze(['idle', 'pat', 'dshBusy', 'dshDone', 'dshError'])

/* -------------------------------------------------------------------------- */
/* 通用小工具                                                                   */
/* -------------------------------------------------------------------------- */

const round7 = (value) => Math.round(value * 1e7) / 1e7
const round = (value, digits = 2) => {
  const k = 10 ** digits
  return Math.round(value * k) / k
}
const isFiniteNum = (value) => typeof value === 'number' && Number.isFinite(value)
const clamp = (value, min, max) => Math.min(max, Math.max(min, value))
const mean = (xs) => (xs.length === 0 ? NaN : xs.reduce((a, b) => a + b, 0) / xs.length)
const maxAbs = (xs) => (xs.length === 0 ? 0 : xs.reduce((m, v) => Math.max(m, Math.abs(v)), 0))

/**
 * 四元数夹角（度）。先把两个四元数归一化再点乘：
 * 7 位小数写回的 quat 范数有 ~1e-7 偏差，若不归一化，近单位夹角公式会把范数误差
 * 放大成 ~0.04° 的假漂移（真实的旋转差 ~1e-6°）。
 */
function quatAngleDeg(a, b) {
  const na = Math.hypot(a.x, a.y, a.z, a.w) || 1
  const nb = Math.hypot(b.x, b.y, b.z, b.w) || 1
  const dot =
    (a.x * b.x + a.y * b.y + a.z * b.z + a.w * b.w) / (na * nb)
  return 2 * Math.acos(Math.min(1, Math.abs(dot))) * DEG
}

/** sha256（hex）。 */
function sha256(buf) {
  return createHash('sha256').update(buf).digest('hex')
}

/** 文件 sha256。 */
function fileSha256(path) {
  return sha256(readFileSync(path))
}

/** 原子写文件（同目录 tmp + rename；跨平台同卷 rename 原子）。 */
function writeFileAtomic(path, content) {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`
  writeFileSync(tmp, content)
  renameSync(tmp, path)
}

/** 递归列出目录下所有文件（相对路径）。 */
function walkFiles(root) {
  const result = []
  const walk = (dir, prefix) => {
    for (const name of readdirSync(dir)) {
      const absolute = join(dir, name)
      const rel = prefix === '' ? name : `${prefix}/${name}`
      const stat = statSync(absolute)
      if (stat.isDirectory()) walk(absolute, rel)
      else result.push(rel)
    }
  }
  if (!existsSync(root)) return result
  walk(root, '')
  return result
}

/* -------------------------------------------------------------------------- */
/* 极简 clip JSON 解析（产品 parseClipData 的读侧子集；写回前用产品逻辑校验）      */
/* -------------------------------------------------------------------------- */

/**
 * 读取某骨某帧的轨道值。
 * @param {unknown} track clip JSON 的 `bones[bone]`（`{r:[...], p?:[...]}`）
 * @param {number} frame 帧号
 * @param {3|4} components 分量数
 * @returns {number[]|null}
 */
function readTrackFrame(track, frame, components) {
  if (typeof track !== 'object' || track === null) return null
  const raw = components === 4 ? track.r : track.p
  if (!Array.isArray(raw) || raw.length === 0) return null
  if (Array.isArray(raw[0])) {
    const row = raw[frame]
    if (!Array.isArray(row) || row.length !== components) return null
    return row
  }
  const base = frame * components
  if (raw.length < base + components) return null
  const out = new Array(components)
  for (let i = 0; i < components; i += 1) out[i] = raw[base + i]
  return out
}

/**
 * 把原始 clip JSON 归一成脚本内部结构。坏数据抛错（bake 前即失败）。
 * @returns {{raw:object, frames:number, fps:number, loop:boolean, duration:number,
 *   sourceHipsHeight:number, bones:Map<string, {rFrame:(f:number)=>number[]|null, pFrame:(f:number)=>number[]|null}>}}
 */
export function normalizeClip(raw, label) {
  if (typeof raw !== 'object' || raw === null) throw new Error(`${label}: clip 不是对象`)
  if (raw.version !== 1) throw new Error(`${label}: version !== 1`)
  const frames = raw.frames
  const fps = raw.fps
  if (!Number.isInteger(frames) || frames <= 0) throw new Error(`${label}: frames 非法`)
  if (!isFiniteNum(fps) || fps <= 0) throw new Error(`${label}: fps 非法`)
  if (typeof raw.bones !== 'object' || raw.bones === null) throw new Error(`${label}: bones 非法`)
  const sourceHipsHeight =
    isFiniteNum(raw.sourceHipsHeight) && raw.sourceHipsHeight > 0 ? raw.sourceHipsHeight : 1
  const loop = raw.loop === true
  const duration = isFiniteNum(raw.duration) && raw.duration > 0 ? raw.duration : frames / fps
  const bones = new Map()
  for (const unityName of LEG_BONE_NAMES) {
    const track = raw.bones[unityName]
    if (track === undefined) {
      throw new Error(`${label}: 缺少必需骨轨道 ${unityName}`)
    }
    bones.set(unityName, {
      rFrame: (frame) => readTrackFrame(track, frame, 4),
      pFrame: unityName === 'Hips' ? (frame) => readTrackFrame(track, frame, 3) : () => null
    })
  }
  return { raw, frames, fps, loop, duration, sourceHipsHeight, bones }
}

/* -------------------------------------------------------------------------- */
/* VRM rig（真实 VRM 的 normalized humanoid 子集 + 腿 FK/IK 工具）               */
/* -------------------------------------------------------------------------- */

/** 从真实 VRM 解析 normalized humanoid rig（只保留髋+双腿 7 根骨 + 脚部 raw 骨）。 */
export class LegRig {
  /**
   * @param {object} vrm three-vrm VRM 实例
   */
  constructor(vrm) {
    this.vrm = vrm
    this.scene = vrm.scene
    this.humanoid = vrm.humanoid
    this.scene.updateMatrixWorld(true)

    /** @type {Map<string, import('three').Object3D>} Unity 骨名 → normalized 节点 */
    this.nodes = new Map()
    for (const unityName of LEG_BONE_NAMES) {
      const node = this.humanoid.getNormalizedBoneNode(UNITY_TO_VRM_BONE[unityName])
      if (!node) throw new Error(`VRM 缺少 normalized 骨 ${UNITY_TO_VRM_BONE[unityName]}`)
      this.nodes.set(unityName, node)
    }
    /** @type {Map<string, Quaternion>} */
    this.restQuats = new Map()
    for (const [unityName, node] of this.nodes) this.restQuats.set(unityName, node.quaternion.clone())

    const hipsNode = this.nodes.get(LEG_BONES.hips)
    this.restHipsPos = hipsNode.position.clone()
    /** Hips.p 位移缩放基准（= avatar-loader 的 hipsRestHeight = normalizedRestPose.hips.y）。 */
    this.hipsRestHeight = this.restHipsPos.y

    /** 脚部 raw 骨（贴地测量）。 */
    this.rawFootNodes = RAW_FOOT_BONES.map((name) => this.humanoid.getRawBoneNode(name)).filter(
      Boolean
    )
    if (this.rawFootNodes.length === 0) throw new Error('VRM 缺少 raw 脚骨节点')

    /** rest 脚骨最低 y（avatar.scene 局部；= clip-player.restFeetLocalY）。 */
    this.restFeetLocalY = this.measureRawFootMinLocalY()

    /** rest 腿段长度（旋转不变，构造期量一次；与 foot-lock FootRig 同口径）。 */
    this.scene.updateMatrixWorld(true)
    const leftHip = this.sceneLocalOf(this.nodes.get(LEG_BONES.leftUpper))
    const leftKnee = this.sceneLocalOf(this.nodes.get(LEG_BONES.leftLower))
    const leftAnkle = this.sceneLocalOf(this.nodes.get(LEG_BONES.leftFoot))
    this.upperLength = leftHip.distanceTo(leftKnee)
    this.lowerLength = leftKnee.distanceTo(leftAnkle)
    if (!(this.upperLength > 0) || !(this.lowerLength > 0)) throw new Error('腿骨长度异常')
  }

  /** Hips.p 缩放系数（米→米；与 clip-data.hipsPositionScale 同口径）。 */
  hipsPositionScale(clip) {
    return this.hipsRestHeight / (clip.sourceHipsHeight > 0 ? clip.sourceHipsHeight : 1)
  }

  /** 节点世界位置 → avatar.scene 局部坐标。 */
  sceneLocalOf(node) {
    node.updateWorldMatrix(true, false)
    const world = node.getWorldPosition(new Vector3())
    return this.scene.worldToLocal(world)
  }

  /** 世界四元数 → avatar.scene 局部四元数。 */
  sceneLocalQuatOf(node) {
    node.updateWorldMatrix(true, false)
    const world = node.getWorldQuaternion(new Quaternion())
    const sceneWorld = this.scene.getWorldQuaternion(new Quaternion())
    return sceneWorld.invert().multiply(world)
  }

  /** 把期望的世界四元数写回 normalized 节点局部 quaternion（同 foot-lock.setLocalFromWorldQuat）。 */
  setLocalFromWorldQuat(node, desiredWorld) {
    if (node.parent === null) {
      node.quaternion.copy(desiredWorld)
      return
    }
    const parentWorld = node.parent.getWorldQuaternion(new Quaternion())
    node.quaternion.copy(parentWorld.invert().multiply(desiredWorld))
  }

  /** 量 raw 脚骨（feet/toes）在 scene 局部的最低 y。 */
  measureRawFootMinLocalY() {
    this.scene.updateMatrixWorld(true)
    let minY = Infinity
    for (const node of this.rawFootNodes) {
      const p = this.sceneLocalOf(node)
      if (p.y < minY) minY = p.y
    }
    return Number.isFinite(minY) ? minY : 0
  }

  /** 复位到 rest（只复位本脚本会改的 7 根骨 + 脚部 raw 由 humanoid.update 同步）。 */
  reset() {
    for (const [unityName, node] of this.nodes) {
      if (unityName === LEG_BONES.hips) continue
      node.quaternion.copy(this.restQuats.get(unityName))
    }
    const hips = this.nodes.get(LEG_BONES.hips)
    hips.quaternion.copy(this.restQuats.get(LEG_BONES.hips))
    hips.position.copy(this.restHipsPos)
    this.sync()
  }

  /** normalized 骨 → raw 骨同步 + 场景矩阵刷新（复刻 animator 每帧 humanoid.update）。 */
  sync() {
    this.humanoid.update()
    this.scene.updateMatrixWorld(true)
  }

  /**
   * 把一帧 clip 姿态写到 rig。
   * @param {ReturnType<typeof normalizeClip>} clip
   * @param {number} frame
   * @param {{extraHips?: {x?:number,y?:number,z?:number},
   *          quatOverrides?: Record<string, Quaternion>}} [options]
   *   `extraHips` 在 Hips.p 缩放后的位移之上再叠加（scene 局部米；含贴地常量 g）。
   */
  applyClipFrame(clip, frame, options = {}) {
    const quatOverrides = options.quatOverrides ?? null
    for (const unityName of LEG_BONE_NAMES) {
      const node = this.nodes.get(unityName)
      const override = quatOverrides === null ? undefined : quatOverrides[unityName]
      if (override !== undefined) {
        node.quaternion.copy(override)
        continue
      }
      const r = clip.bones.get(unityName).rFrame(frame)
      if (r === null) {
        node.quaternion.copy(this.restQuats.get(unityName))
        continue
      }
      node.quaternion.set(round7(r[0]), round7(r[1]), round7(r[2]), round7(r[3]))
    }
    const hips = this.nodes.get(LEG_BONES.hips)
    const p = clip.bones.get(LEG_BONES.hips).pFrame(frame) ?? [0, 0, 0]
    const scale = this.hipsPositionScale(clip)
    const extra = options.extraHips ?? {}
    hips.position.set(
      this.restHipsPos.x + p[0] * scale + (extra.x ?? 0),
      this.restHipsPos.y + p[1] * scale + (extra.y ?? 0),
      this.restHipsPos.z + p[2] * scale + (extra.z ?? 0)
    )
    this.sync()
  }

  /**
   * 复刻产品贴地：grounding==='feet' → `restFeetLocalY − 首帧脚骨最低 y`；
   * 其他（grounding 缺失/none）→ 0（本脚本只 bake 站立 clip，实际均为 feet）。
   */
  computeGroundOffset(clip) {
    const mode = clip.raw.grounding === 'feet' ? 'feet' : 'non-feet'
    if (mode !== 'feet') return { offsetM: 0, mode }
    this.reset()
    this.applyClipFrame(clip, 0)
    const minFootY = this.measureRawFootMinLocalY()
    this.reset()
    return { offsetM: this.restFeetLocalY - minFootY, mode }
  }

  /** 逐帧腿 FK 测量（调用前需已 applyClipFrame）。 */
  measureLegs() {
    const hipL = this.sceneLocalOf(this.nodes.get(LEG_BONES.leftUpper))
    const kneeL = this.sceneLocalOf(this.nodes.get(LEG_BONES.leftLower))
    const ankleL = this.sceneLocalOf(this.nodes.get(LEG_BONES.leftFoot))
    const hipR = this.sceneLocalOf(this.nodes.get(LEG_BONES.rightUpper))
    const kneeR = this.sceneLocalOf(this.nodes.get(LEG_BONES.rightLower))
    const ankleR = this.sceneLocalOf(this.nodes.get(LEG_BONES.rightFoot))
    return {
      hipL,
      kneeL,
      ankleL,
      hipR,
      kneeR,
      ankleR,
      kneeAngleL: angleAt(kneeL, hipL, ankleL),
      kneeAngleR: angleAt(kneeR, hipR, ankleR),
      footQuatL: this.sceneLocalQuatOf(this.nodes.get(LEG_BONES.leftFoot)),
      footQuatR: this.sceneLocalQuatOf(this.nodes.get(LEG_BONES.rightFoot)),
      hipsPos: this.nodes.get(LEG_BONES.hips).position.clone()
    }
  }

  /** 当前脚踝/脚朝向（bake 中用于对比）。 */
  measureFeet() {
    const ankleL = this.sceneLocalOf(this.nodes.get(LEG_BONES.leftFoot))
    const ankleR = this.sceneLocalOf(this.nodes.get(LEG_BONES.rightFoot))
    return {
      ankleL,
      ankleR,
      footQuatL: this.sceneLocalQuatOf(this.nodes.get(LEG_BONES.leftFoot)),
      footQuatR: this.sceneLocalQuatOf(this.nodes.get(LEG_BONES.rightFoot))
    }
  }
}

/** 膝角：∠(hip, knee, ankle)（度；180 = 伸直）。 */
export function angleAt(knee, hip, ankle) {
  const a = hip.clone().sub(knee)
  const b = ankle.clone().sub(knee)
  if (a.lengthSq() < 1e-12 || b.lengthSq() < 1e-12) return 180
  return a.angleTo(b) * DEG
}

/* -------------------------------------------------------------------------- */
/* 两骨 IK（与 foot-lock.solveKneePosition 同款算法，余量可配）                   */
/* -------------------------------------------------------------------------- */

/**
 * 解析两骨 IK：返回膝的 scene 局部位置。
 * 与 `src/renderer/src/vrm/foot-lock.ts:solveKneePosition` 完全同款（含极向量退化兜底），
 * 仅 `maxDistance = length1 + length2 − ikMarginM` 的余量可配（运行时 1mm，数据侧 1e-6m）。
 */
export function solveKneePosition({
  hip,
  targetFoot,
  currentKnee,
  length1,
  length2,
  poleHint = null,
  ikMarginM = 1e-6
}) {
  const u = targetFoot.clone().sub(hip)
  const rawDistance = u.length()
  const minDistance = Math.abs(length1 - length2) + 1e-4
  const maxDistance = Math.max(minDistance, length1 + length2 - ikMarginM)
  const distance = clamp(rawDistance, minDistance, maxDistance)
  if (rawDistance > 1e-6) u.divideScalar(rawDistance)
  else u.set(0, -1, 0)

  const pole = currentKnee.clone().sub(hip)
  pole.addScaledVector(u, -pole.dot(u))
  if (pole.lengthSq() < 1e-6 && poleHint !== null) {
    const hint = poleHint.clone()
    hint.addScaledVector(u, -hint.dot(u))
    if (hint.lengthSq() > 1e-8) pole.copy(hint)
  }
  if (pole.lengthSq() < 1e-8) {
    pole.set(0, 0, 1).addScaledVector(u, -u.z)
    if (pole.lengthSq() < 1e-8) pole.set(0, 1, 0)
  }
  pole.normalize()

  const a = (length1 * length1 - length2 * length2 + distance * distance) / (2 * distance)
  const h = Math.sqrt(Math.max(0, length1 * length1 - a * a))
  return hip.clone().addScaledVector(u, a).addScaledVector(pole, h)
}

/** 由「当前膝方向→解算膝方向」的最小旋转，叠加到上段世界旋转（同 foot-lock）。 */
function computeUpperDesiredWorldQuat(hip, currentKnee, solvedKnee, upperWorld) {
  const from = currentKnee.clone().sub(hip)
  const to = solvedKnee.clone().sub(hip)
  if (from.lengthSq() < 1e-10 || to.lengthSq() < 1e-10) return upperWorld.clone()
  const delta = new Quaternion().setFromUnitVectors(from.normalize(), to.normalize())
  return delta.multiply(upperWorld)
}

/** 由「当前 foot−knee 方向→目标踝方向」的最小旋转，叠加到小腿世界旋转（同 foot-lock）。 */
function computeLowerDesiredWorldQuat(knee, foot, targetFoot, lowerWorld) {
  const from = foot.clone().sub(knee)
  const to = targetFoot.clone().sub(knee)
  if (from.lengthSq() < 1e-10 || to.lengthSq() < 1e-10) return lowerWorld.clone()
  const delta = new Quaternion().setFromUnitVectors(from.normalize(), to.normalize())
  return delta.multiply(lowerWorld)
}

/* -------------------------------------------------------------------------- */
/* 髋位移求解（y 一维最小二乘 + x/z 极小修正）                                    */
/* -------------------------------------------------------------------------- */

const dFromKneeAngle = (kneeDeg, length1, length2) => {
  const cos = Math.cos(kneeDeg * RAD)
  return Math.sqrt(
    Math.max(0, length1 * length1 + length2 * length2 - 2 * length1 * length2 * cos)
  )
}

/** 1 维 Gauss-Newton：求 δy 使 Σ_i (|v_i + δy·ŷ| − d_i)² 最小（任务规定的 1 维最小二乘）。 */
export function solveLiftY(vL, vR, dTargetL, dTargetR) {
  let y = 0
  for (let iter = 0; iter < 60; iter += 1) {
    let num = 0
    let den = 0
    for (const [v, dTarget] of [
      [vL, dTargetL],
      [vR, dTargetR]
    ]) {
      const vy = v.y + y
      const len = Math.sqrt(v.x * v.x + vy * vy + v.z * v.z)
      if (!(len > 1e-9)) continue
      const r = len - dTarget
      const j = vy / len
      num += r * j
      den += j * j
    }
    if (!(Math.abs(den) > 1e-12)) break
    const step = num / den
    y -= step
    if (Math.abs(step) < 1e-13) break
  }
  return y
}

/** 固定 δy 后解 δx/δz 使两腿距离同时命中目标（2×2 Gauss-Newton）。 */
export function solveHorizontalXZ(vL, vR, dTargetL, dTargetR, dy) {
  let x = 0
  let z = 0
  for (let iter = 0; iter < 80; iter += 1) {
    const rows = []
    const residuals = []
    for (const [v, dTarget] of [
      [vL, dTargetL],
      [vR, dTargetR]
    ]) {
      const vx = v.x + x
      const vy = v.y + dy
      const vz = v.z + z
      const len = Math.sqrt(vx * vx + vy * vy + vz * vz)
      if (!(len > 1e-9)) return { x, z, residual: Infinity }
      rows.push([vx / len, vz / len])
      residuals.push(len - dTarget)
    }
    const a00 = rows[0][0] ** 2 + rows[1][0] ** 2
    const a01 = rows[0][0] * rows[0][1] + rows[1][0] * rows[1][1]
    const a11 = rows[0][1] ** 2 + rows[1][1] ** 2
    const b0 = rows[0][0] * residuals[0] + rows[1][0] * residuals[1]
    const b1 = rows[0][1] * residuals[0] + rows[1][1] * residuals[1]
    const det = a00 * a11 - a01 * a01
    if (!(Math.abs(det) > 1e-16)) break
    const dx = (a11 * b0 - a01 * b1) / det
    const dz = (a00 * b1 - a01 * b0) / det
    x -= dx
    z -= dz
    if (Math.hypot(dx, dz) < 1e-13) break
  }
  const residual = (v, dTarget) => {
    const vx = v.x + x
    const vy = v.y + dy
    const vz = v.z + z
    return Math.abs(Math.sqrt(vx * vx + vy * vy + vz * vz) - dTarget)
  }
  return {
    x,
    z,
    residual: Math.max(residual(vL, dTargetL), residual(vR, dTargetR))
  }
}

/**
 * 解每帧髋位移：δy（1 维 LS，clamp）→ δxz（极小修正，clamp）。
 * @returns {{dx:number,dy:number,dz:number,residualM:number,clamped:boolean}}
 */
export function solveHipsDelta({ hipL, ankleL, hipR, ankleR, dTargetL, dTargetR, params }) {
  const vL = hipL.clone().sub(ankleL)
  const vR = hipR.clone().sub(ankleR)
  const maxLift = params.maxLiftMm / 1000
  const minLift = params.minLiftMm / 1000
  const maxHorizontal = params.maxHorizontalMm / 1000

  let dy = solveLiftY(vL, vR, dTargetL, dTargetR)
  let clamped = false
  const dyClamped = clamp(dy, minLift, maxLift)
  if (dyClamped !== dy) clamped = true
  dy = dyClamped

  let { x, z, residual } = solveHorizontalXZ(vL, vR, dTargetL, dTargetR, dy)
  const horiz = Math.hypot(x, z)
  if (horiz > maxHorizontal) {
    clamped = true
    const k = maxHorizontal / horiz
    x *= k
    z *= k
    // 重新评估残差（被 clamp 后可能无法同时命中）
    const lenL = new THREE_VECTOR(vL.x + x, vL.y + dy, vL.z + z).length()
    const lenR = new THREE_VECTOR(vR.x + x, vR.y + dy, vR.z + z).length()
    residual = Math.max(Math.abs(lenL - dTargetL), Math.abs(lenR - dTargetR))
  }
  return { dx: x, dy, dz: z, residualM: residual, clamped }
}

/** 轻量三元组长度（避免拉入 Vector3 的 clone 开销）。 */
class THREE_VECTOR {
  constructor(x, y, z) {
    this.x = x
    this.y = y
    this.z = z
  }
  length() {
    return Math.sqrt(this.x * this.x + this.y * this.y + this.z * this.z)
  }
}

/* -------------------------------------------------------------------------- */
/* VRM 加载（去掉贴图/材质以加速：FK/IK 只需要骨架）                              */
/* -------------------------------------------------------------------------- */

/** 把真实 VRM 的 GLB 重打包为「无贴图/无材质」版本再交给 three-vrm 解析。 */
export function loadVrmSanitizedBuffer(vrmPath) {
  const buf = readFileSync(vrmPath)
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
  const jsonLen = view.getUint32(12, true)
  const jsonStart = 20
  const json = JSON.parse(
    new TextDecoder()
      .decode(buf.subarray(jsonStart, jsonStart + jsonLen))
      .replace(/\u0000+$/g, '')
      .trim()
  )
  delete json.images
  delete json.textures
  delete json.samplers
  for (const mesh of json.meshes ?? []) {
    for (const primitive of mesh.primitives ?? []) delete primitive.material
  }
  const binLenPos = 12 + 8 + jsonLen
  const binLen = view.getUint32(binLenPos, true)
  const binStart = binLenPos + 8
  const bin = buf.subarray(binStart, binStart + binLen)
  const textBytes = new TextEncoder().encode(JSON.stringify(json))
  const pad4 = (n) => Math.ceil(n / 4) * 4
  const paddedText = pad4(textBytes.length)
  const paddedBin = pad4(bin.length)
  const total = 12 + 8 + paddedText + 8 + paddedBin
  const out = new Uint8Array(total)
  const dv = new DataView(out.buffer)
  dv.setUint32(0, 0x46546c67, true) // 'glTF'
  dv.setUint32(4, 2, true)
  dv.setUint32(8, total, true)
  dv.setUint32(12, paddedText, true)
  dv.setUint32(16, 0x4e4f534a, true) // 'JSON'
  out.set(textBytes, 20)
  out.fill(0x20, 20 + textBytes.length, 20 + paddedText)
  const binOffset = 20 + paddedText
  dv.setUint32(binOffset, paddedBin, true)
  dv.setUint32(binOffset + 4, 0x004e4942, true) // 'BIN\0'
  out.set(bin, binOffset + 8)
  return out.buffer
}

/** 加载真实 VRM → LegRig（每次调用独立实例；脚本内复用同一实例）。 */
export async function loadLegRig(vrmPath = DEFAULT_VRM) {
  const arrayBuffer = loadVrmSanitizedBuffer(vrmPath)
  const vrm = await new Promise((resolvePromise, reject) => {
    const loader = new GLTFLoader()
    loader.register((parser) => new VRMLoaderPlugin(parser))
    loader.parse(
      arrayBuffer,
      `${dirname(vrmPath)}/`,
      (gltf) => resolvePromise(gltf.userData.vrm),
      reject
    )
  })
  return new LegRig(vrm)
}

/* -------------------------------------------------------------------------- */
/* clip 池 / 元数据                                                             */
/* -------------------------------------------------------------------------- */

/** 读 JSON 文件。 */
function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'))
}

/**
 * 构建目标池（用户可见站立 clip 候选）：
 * - idle：app-manifest 中 mood=idle 且 priority ≥ −9（VARIANT_ROTATION_MIN_PRIORITY，轮换池 9 条）；
 * - fidget：IdleOneShotFidget 8 条一次性社交 clip；
 * - dsh：app-manifest 的 dshBusy/dshDone/dshError 别名（多为已覆盖文件的别名，按文件去重后标注）；
 * - pat：app-manifest 的 pat（动态反应，预期全部被筛掉，仅用于报告说明）。
 * @returns {{byRelPath: Map<string, {relPath:string, ids:Set<string>, moods:Set<string>, category:'idle'|'social'}>,
 *   idToFile: Map<string,string>, manifest: object, catalog: object}}
 */
export function buildPools({ motionsDir = DEFAULT_MOTIONS_DIR } = {}) {
  const appManifest = readJson(join(motionsDir, 'app-manifest.json'))
  const appCatalog = readJson(join(motionsDir, 'app-catalog.json'))
  const idToFile = new Map()
  for (const entry of appCatalog.clips ?? []) {
    if (typeof entry.id === 'string' && typeof entry.file === 'string') {
      idToFile.set(entry.id, entry.file)
    }
  }
  for (const entry of appManifest.clips ?? []) {
    if (typeof entry.id === 'string' && typeof entry.file === 'string') {
      idToFile.set(entry.id, entry.file)
    }
  }

  /** relPath → 池信息 */
  const byRelPath = new Map()
  const add = (id, relPath, mood, category) => {
    if (typeof relPath !== 'string') return
    let entry = byRelPath.get(relPath)
    if (entry === undefined) {
      entry = { relPath, ids: new Set(), moods: new Set(), category }
      byRelPath.set(relPath, entry)
    }
    entry.ids.add(id)
    entry.moods.add(mood ?? 'null')
    // idle 类别优先（同一文件同时属于 idle 池时按 idle 目标 bake）
    if (category === 'idle') entry.category = 'idle'
  }

  const idleEntryIds = new Set()
  for (const entry of appManifest.clips ?? []) {
    if (entry.mood !== 'idle') continue
    const priority = isFiniteNum(entry.priority) ? entry.priority : 0
    if (priority < -9) continue // VARIANT_ROTATION_MIN_PRIORITY（轮换池外）
    idleEntryIds.add(entry.id)
    add(entry.id, entry.file, entry.mood, 'idle')
  }
  for (const id of FIDGET_POOL_IDS) add(id, idToFile.get(id), 'oneShotFidget', 'social')
  for (const entry of appManifest.clips ?? []) {
    if (!STANDING_MOODS.includes(entry.mood)) continue
    if (entry.mood === 'idle') continue
    add(entry.id, entry.file, entry.mood, 'social')
  }
  return { byRelPath, idToFile, idleEntryIds, manifest: appManifest, catalog: appCatalog }
}

/* -------------------------------------------------------------------------- */
/* author FK 统计（单 clip 全帧）                                                */
/* -------------------------------------------------------------------------- */

/**
 * 对一条 clip 做全帧 author FK 统计（真实 VRM + 产品贴地口径）。
 * @returns {object} 统计 + 逐帧数据（bake 复用）
 */
export function analyzeClipAuthor(rig, clip, params = DEFAULT_PARAMS) {
  const { offsetM, mode: groundMode } = rig.computeGroundOffset(clip)
  const frames = []
  let nan = 0
  for (let f = 0; f < clip.frames; f += 1) {
    rig.applyClipFrame(clip, f, { extraHips: { y: offsetM } })
    const legs = rig.measureLegs()
    const rawFootMinY = rig.measureRawFootMinLocalY()
    for (const value of [
      legs.kneeAngleL,
      legs.kneeAngleR,
      legs.ankleL.x,
      legs.ankleL.y,
      legs.ankleL.z,
      legs.ankleR.x,
      legs.ankleR.y,
      legs.ankleR.z,
      legs.hipsPos.x,
      legs.hipsPos.y,
      legs.hipsPos.z
    ]) {
      if (!Number.isFinite(value)) nan += 1
    }
    frames.push({
      f,
      kneeL: legs.kneeAngleL,
      kneeR: legs.kneeAngleR,
      hipL: legs.hipL,
      kneeLPos: legs.kneeL,
      ankleL: legs.ankleL,
      hipR: legs.hipR,
      kneeRPos: legs.kneeR,
      ankleR: legs.ankleR,
      footQuatL: legs.footQuatL,
      footQuatR: legs.footQuatR,
      hipsY: legs.hipsPos.y,
      rawFootMinY
    })
  }
  rig.reset()

  const kneeL = frames.map((row) => row.kneeL)
  const kneeR = frames.map((row) => row.kneeR)
  const hipsY = frames.map((row) => row.hipsY)
  const ankleY = frames.map((row) => (row.ankleL.y + row.ankleR.y) / 2)
  const meanKneeL = mean(kneeL)
  const meanKneeR = mean(kneeR)
  const minKneeL = Math.min(...kneeL)
  const minKneeR = Math.min(...kneeR)
  const maxKneeL = Math.max(...kneeL)
  const maxKneeR = Math.max(...kneeR)
  const meanKnee = (meanKneeL + meanKneeR) / 2
  const rangeL = maxKneeL - minKneeL
  const rangeR = maxKneeR - minKneeR
  const hipsYAvg = mean(hipsY)
  const ankleYAvg = mean(ankleY)
  const kneeMin = Math.min(minKneeL, minKneeR)
  const standing =
    kneeMin > params.standingKneeMinDeg &&
    Math.abs(hipsYAvg - params.standingHipsYRefM) < params.standingHipsYTolM &&
    ankleYAvg < params.standingAnkleYMaxM
  const staticStance = Math.max(rangeL, rangeR) < params.staticKneeRangeMaxDeg
  const bent = meanKnee < params.bentMeanKneeMaxDeg

  const hipAnkleDistanceL = frames.map((row) => row.hipL.distanceTo(row.ankleL))
  const hipAnkleDistanceR = frames.map((row) => row.hipR.distanceTo(row.ankleR))

  // loop 首尾：踝/膝/髋 6 点最大距离差（作者自身；用于 bake 后对比「不劣化」）
  let loopWrapMm = 0
  if (clip.loop && frames.length > 1) {
    const first = frames[0]
    const last = frames[frames.length - 1]
    const points = [
      [first.hipL, last.hipL],
      [first.kneeLPos, last.kneeLPos],
      [first.ankleL, last.ankleL],
      [first.hipR, last.hipR],
      [first.kneeRPos, last.kneeRPos],
      [first.ankleR, last.ankleR]
    ]
    for (const [a, b] of points) loopWrapMm = Math.max(loopWrapMm, a.distanceTo(b) * 1000)
  }

  return {
    frames,
    groundOffsetM: offsetM,
    groundMode,
    nanCount: nan,
    kneeLMean: meanKneeL,
    kneeRMean: meanKneeR,
    kneeLMin: minKneeL,
    kneeRMin: minKneeR,
    kneeLMax: maxKneeL,
    kneeRMax: maxKneeR,
    kneeLRange: rangeL,
    kneeRRange: rangeR,
    meanKnee,
    worstKnee: kneeMin,
    hipAnkleDistanceAvgL: mean(hipAnkleDistanceL),
    hipAnkleDistanceAvgR: mean(hipAnkleDistanceR),
    hipsYAvg,
    ankleYAvg,
    standing,
    staticStance,
    bent,
    loopWrapMm,
    frameCount: clip.frames
  }
}

/* -------------------------------------------------------------------------- */
/* 目标膝角 / 髋位移解（单 clip）                                                */
/* -------------------------------------------------------------------------- */

/**
 * 由 author 统计推出目标：逐腿「平均目标 + 最差帧下限」，保留作者左右差异方向。
 *
 * 记作者逐腿全帧均值 a_L/a_R、最小 a_min、最大 a_max，类别 base/floor：
 *   diff = a_L − a_R;  k = min(1, 2·(base − floor)/|diff|)   // 左右差异幅度压缩系数
 *   average 目标: T_L = base + k·diff/2,  T_R = base − k·diff/2（方向不变）
 *   Δ_leg = max(0, T_leg − a_leg, floor − a_min_leg)          // 只拉直、且最差帧不破 floor
 *   逐帧目标: t_leg(f) = a_leg(f) + Δ_leg                     // 保留作者逐帧膝角变化
 * 若 a_max + Δ 超 cap 则下调 Δ（并记录），最后用 after 均值/最差复验门禁。
 */
export function computeTargets(author, category, params = DEFAULT_PARAMS) {
  const isIdle = category === 'idle'
  const base = isIdle ? params.idleBaseDeg : params.socialBaseDeg
  const floor = isIdle ? params.idleFloorDeg : params.socialFloorDeg
  const cap = params.capDeg
  const acceptAvg = isIdle ? params.idleAcceptAvgDeg : params.socialAcceptAvgDeg
  const acceptWorst = isIdle ? params.idleAcceptWorstDeg : params.socialAcceptWorstDeg

  const aL = author.kneeLMean
  const aR = author.kneeRMean
  const diff = aL - aR
  const k = Math.abs(diff) < 1e-9 ? 1 : Math.min(1, (2 * (base - floor)) / Math.abs(diff))
  const meanTargetL = base + (k * diff) / 2
  const meanTargetR = base - (k * diff) / 2

  let deltaL = Math.max(0, meanTargetL - aL, floor - author.kneeLMin)
  let deltaR = Math.max(0, meanTargetR - aR, floor - author.kneeRMin)
  let capLimited = false
  if (author.kneeLMax + deltaL > cap) {
    deltaL = cap - author.kneeLMax
    capLimited = true
  }
  if (author.kneeRMax + deltaR > cap) {
    deltaR = cap - author.kneeRMax
    capLimited = true
  }
  deltaL = Math.max(0, deltaL)
  deltaR = Math.max(0, deltaR)

  const afterMeanL = aL + deltaL
  const afterMeanR = aR + deltaR
  const afterOverallMean = (afterMeanL + afterMeanR) / 2
  const afterWorst = Math.min(author.kneeLMin + deltaL, author.kneeRMin + deltaR)
  const pass =
    afterOverallMean >= acceptAvg - params.kneeTolDeg &&
    afterWorst >= acceptWorst - params.kneeTolDeg

  return {
    category,
    baseDeg: base,
    floorDeg: floor,
    capDeg: cap,
    acceptAvgDeg: acceptAvg,
    acceptWorstDeg: acceptWorst,
    asymmetryScaleK: round(k, 4),
    authorMeanL: round(aL, 3),
    authorMeanR: round(aR, 3),
    deltaL: round(deltaL, 4),
    deltaR: round(deltaR, 4),
    afterMeanL: round(afterMeanL, 3),
    afterMeanR: round(afterMeanR, 3),
    afterOverallMean: round(afterOverallMean, 3),
    afterWorst: round(afterWorst, 3),
    capLimited,
    pass
  }
}

/* -------------------------------------------------------------------------- */
/* bake 单 clip                                                                */
/* -------------------------------------------------------------------------- */

/**
 * 对单条 clip 执行 bake（纯离线：改回内存 JSON，写盘由调用方决定）。
 * @returns {{bakedJson: object, metrics: object}}
 */
export function bakeClip(rig, clip, meta, params = DEFAULT_PARAMS) {
  const author = analyzeClipAuthor(rig, clip, params)
  const targets = computeTargets(author, meta.category, params)
  const groundOffsetM = author.groundOffsetM
  const scale = rig.hipsPositionScale(clip)
  const L1 = rig.upperLength
  const L2 = rig.lowerLength
  const bakedJson = JSON.parse(JSON.stringify(clip.raw))
  const bakedLegR = {
    [LEG_BONES.leftUpper]: [],
    [LEG_BONES.leftLower]: [],
    [LEG_BONES.leftFoot]: [],
    [LEG_BONES.rightUpper]: [],
    [LEG_BONES.rightLower]: [],
    [LEG_BONES.rightFoot]: []
  }
  const frameMetrics = []
  const deltaY = []
  const deltaHoriz = []
  const residuals = []
  let clampedFrames = 0
  let nanCount = 0

  for (let f = 0; f < clip.frames; f += 1) {
    const frame = author.frames[f]
    // --- 作者姿态（含贴地常量）已由 analyzeClipAuthor 量过；这里重新应用以做 IK ---
    rig.applyClipFrame(clip, f, { extraHips: { y: groundOffsetM } })
    const before = rig.measureLegs()
    const targetL = frame.kneeL + targets.deltaL
    const targetR = frame.kneeR + targets.deltaR
    const dTargetL = dFromKneeAngle(Math.min(targetL, params.capDeg), L1, L2)
    const dTargetR = dFromKneeAngle(Math.min(targetR, params.capDeg), L1, L2)

    const solved = solveHipsDelta({
      hipL: before.hipL,
      ankleL: before.ankleL,
      hipR: before.hipR,
      ankleR: before.ankleR,
      dTargetL,
      dTargetR,
      params
    })
    if (solved.clamped) clampedFrames += 1
    deltaY.push(solved.dy)
    deltaHoriz.push(Math.hypot(solved.dx, solved.dz))
    residuals.push(solved.residualM)

    // --- 附加 hips 位移（scene 局部）---
    rig.applyClipFrame(clip, f, {
      extraHips: { x: solved.dx, y: groundOffsetM + solved.dy, z: solved.dz }
    })
    const shifted = rig.measureLegs()
    const targetAnkleL = before.ankleL.clone()
    const targetAnkleR = before.ankleR.clone()
    const authorFootQuatL = before.footQuatL.clone()
    const authorFootQuatR = before.footQuatR.clone()

    // --- 左腿两骨 IK ---
    const solvedKneeL = solveKneePosition({
      hip: shifted.hipL,
      targetFoot: targetAnkleL,
      currentKnee: shifted.kneeL,
      length1: L1,
      length2: L2,
      poleHint: solvedKneePoleHint(before.hipL, before.kneeL, shifted.hipL),
      ikMarginM: params.ikMarginM
    })
    const upperL = rig.nodes.get(LEG_BONES.leftUpper)
    const lowerL = rig.nodes.get(LEG_BONES.leftLower)
    const footL = rig.nodes.get(LEG_BONES.leftFoot)
    const upperWorldL = upperL.getWorldQuaternion(new Quaternion())
    rig.setLocalFromWorldQuat(
      upperL,
      computeUpperDesiredWorldQuat(shifted.hipL, shifted.kneeL, solvedKneeL, upperWorldL)
    )
    upperL.updateWorldMatrix(true, false)
    const kneePosL = rig.sceneLocalOf(lowerL)
    const footPosL = rig.sceneLocalOf(footL)
    const lowerWorldL = lowerL.getWorldQuaternion(new Quaternion())
    rig.setLocalFromWorldQuat(
      lowerL,
      computeLowerDesiredWorldQuat(kneePosL, footPosL, targetAnkleL, lowerWorldL)
    )
    lowerL.updateWorldMatrix(true, false)
    const parentWorldL = lowerL.getWorldQuaternion(new Quaternion())
    footL.quaternion.copy(parentWorldL.invert().multiply(authorFootQuatL))

    // --- 右腿两骨 IK ---
    const solvedKneeR = solveKneePosition({
      hip: shifted.hipR,
      targetFoot: targetAnkleR,
      currentKnee: shifted.kneeR,
      length1: L1,
      length2: L2,
      poleHint: solvedKneePoleHint(before.hipR, before.kneeR, shifted.hipR),
      ikMarginM: params.ikMarginM
    })
    const upperR = rig.nodes.get(LEG_BONES.rightUpper)
    const lowerR = rig.nodes.get(LEG_BONES.rightLower)
    const footR = rig.nodes.get(LEG_BONES.rightFoot)
    const upperWorldR = upperR.getWorldQuaternion(new Quaternion())
    rig.setLocalFromWorldQuat(
      upperR,
      computeUpperDesiredWorldQuat(shifted.hipR, shifted.kneeR, solvedKneeR, upperWorldR)
    )
    upperR.updateWorldMatrix(true, false)
    const kneePosR = rig.sceneLocalOf(lowerR)
    const footPosR = rig.sceneLocalOf(footR)
    const lowerWorldR = lowerR.getWorldQuaternion(new Quaternion())
    rig.setLocalFromWorldQuat(
      lowerR,
      computeLowerDesiredWorldQuat(kneePosR, footPosR, targetAnkleR, lowerWorldR)
    )
    lowerR.updateWorldMatrix(true, false)
    const parentWorldR = lowerR.getWorldQuaternion(new Quaternion())
    footR.quaternion.copy(parentWorldR.invert().multiply(authorFootQuatR))

    rig.sync()
    const after = rig.measureLegs()

    // --- 读回 normalized 局部旋转（写 JSON） ---
    for (const unityName of Object.keys(bakedLegR)) {
      const q = rig.nodes.get(unityName).quaternion
      bakedLegR[unityName].push([round7(q.x), round7(q.y), round7(q.z), round7(q.w)])
    }
    const oldP = readTrackFrame(clip.raw.bones.Hips, f, 3) ?? [0, 0, 0]
    const newP = [
      round7(oldP[0] + solved.dx / scale),
      round7(oldP[1] + solved.dy / scale),
      round7(oldP[2] + solved.dz / scale)
    ]
    // 写回（只改 Hips.p / 腿/脚 r）
    ensureTrack(bakedJson.bones, 'Hips', 'p', clip.frames)
    writeTrackFrame(bakedJson.bones.Hips.p, f, 3, newP)
    ensureTrack(bakedJson.bones, LEG_BONES.leftUpper, 'r', clip.frames)
    ensureTrack(bakedJson.bones, LEG_BONES.leftLower, 'r', clip.frames)
    ensureTrack(bakedJson.bones, LEG_BONES.leftFoot, 'r', clip.frames)
    ensureTrack(bakedJson.bones, LEG_BONES.rightUpper, 'r', clip.frames)
    ensureTrack(bakedJson.bones, LEG_BONES.rightLower, 'r', clip.frames)
    ensureTrack(bakedJson.bones, LEG_BONES.rightFoot, 'r', clip.frames)
    writeTrackFrame(bakedJson.bones[LEG_BONES.leftUpper].r, f, 4, bakedLegR[LEG_BONES.leftUpper][f])
    writeTrackFrame(bakedJson.bones[LEG_BONES.leftLower].r, f, 4, bakedLegR[LEG_BONES.leftLower][f])
    writeTrackFrame(bakedJson.bones[LEG_BONES.leftFoot].r, f, 4, bakedLegR[LEG_BONES.leftFoot][f])
    writeTrackFrame(bakedJson.bones[LEG_BONES.rightUpper].r, f, 4, bakedLegR[LEG_BONES.rightUpper][f])
    writeTrackFrame(bakedJson.bones[LEG_BONES.rightLower].r, f, 4, bakedLegR[LEG_BONES.rightLower][f])
    writeTrackFrame(bakedJson.bones[LEG_BONES.rightFoot].r, f, 4, bakedLegR[LEG_BONES.rightFoot][f])

    // --- 逐帧验收量 ---
    const footDriftL = after.ankleL.distanceTo(targetAnkleL) * 1000
    const footDriftR = after.ankleR.distanceTo(targetAnkleR) * 1000
    const footOriDriftL = quatAngleDeg(after.footQuatL, authorFootQuatL)
    const footOriDriftR = quatAngleDeg(after.footQuatR, authorFootQuatR)
    for (const value of [
      after.kneeAngleL,
      after.kneeAngleR,
      footDriftL,
      footDriftR,
      footOriDriftL,
      footOriDriftR,
      solved.dx,
      solved.dy,
      solved.dz
    ]) {
      if (!Number.isFinite(value)) nanCount += 1
    }
    frameMetrics.push({
      f,
      kneeBeforeL: round(frame.kneeL, 4),
      kneeBeforeR: round(frame.kneeR, 4),
      targetL: round(targetL, 4),
      targetR: round(targetR, 4),
      kneeAfterL: round(after.kneeAngleL, 4),
      kneeAfterR: round(after.kneeAngleR, 4),
      hipsLiftMm: round(solved.dy * 1000, 4),
      hipsHorizMm: round(Math.hypot(solved.dx, solved.dz) * 1000, 4),
      hipsDXMm: round(solved.dx * 1000, 4),
      hipsDZMm: round(solved.dz * 1000, 4),
      dResidualMm: round(solved.residualM * 1000, 6),
      footDriftLMm: round(footDriftL, 6),
      footDriftRMm: round(footDriftR, 6),
      footOriDriftLDeg: round(footOriDriftL, 6),
      footOriDriftRDeg: round(footOriDriftR, 6),
      ankleBeforeL: vec3r(before.ankleL),
      ankleBeforeR: vec3r(before.ankleR),
      ankleAfterL: vec3r(after.ankleL),
      ankleAfterR: vec3r(after.ankleR),
      kneeAfterLPos: vec3r(after.kneeL),
      kneeAfterRPos: vec3r(after.kneeR),
      hipAfterLPos: vec3r(after.hipL),
      hipAfterRPos: vec3r(after.hipR),
      footQuatBeforeL: quatr(before.footQuatL),
      footQuatBeforeR: quatr(before.footQuatR),
      footQuatAfterL: quatr(after.footQuatL),
      footQuatAfterR: quatr(after.footQuatR)
    })
  }
  rig.reset()

  // 其他骨/字段逐位保留检查（除允许修改的 Hips.p / 6 条腿骨 r 外）
  const untouchedCheck = verifyUntouched(clip.raw, bakedJson)

  const kneeAfterL = frameMetrics.map((row) => row.kneeAfterL)
  const kneeAfterR = frameMetrics.map((row) => row.kneeAfterR)
  const allAfter = [...kneeAfterL, ...kneeAfterR]
  const beforeAll = [...frameMetrics.map((r) => r.kneeBeforeL), ...frameMetrics.map((r) => r.kneeBeforeR)]
  const afterMeanL = mean(kneeAfterL)
  const afterMeanR = mean(kneeAfterR)
  const afterOverallMean = mean(allAfter)
  const afterWorst = Math.min(...allAfter)
  const afterRangeL = Math.max(...kneeAfterL) - Math.min(...kneeAfterL)
  const afterRangeR = Math.max(...kneeAfterR) - Math.min(...kneeAfterR)
  const authorAsymmetryDeg = author.kneeLMean - author.kneeRMean
  const afterAsymmetryDeg = afterMeanL - afterMeanR
  const asymmetryDirectionPreserved =
    Math.abs(authorAsymmetryDeg) < 0.2
      ? true
      : Math.sign(authorAsymmetryDeg) === Math.sign(afterAsymmetryDeg)
  // 只拉直不掰弯：逐帧 bake 后膝角不得低于作者（数值容差 1e-3°）
  const neverBendMaxDeg = Math.max(
    ...frameMetrics.map((row) =>
      Math.max(row.kneeBeforeL - row.kneeAfterL, row.kneeBeforeR - row.kneeAfterR)
    )
  )

  // loop 首尾（bake 后 6 点最大距离差）
  let loopWrapMm = 0
  if (clip.loop && frameMetrics.length > 1) {
    const firstRow = frameMetrics[0]
    const lastRow = frameMetrics[frameMetrics.length - 1]
    const points = [
      [firstRow.hipAfterLPos, lastRow.hipAfterLPos],
      [firstRow.kneeAfterLPos, lastRow.kneeAfterLPos],
      [firstRow.ankleAfterL, lastRow.ankleAfterL],
      [firstRow.hipAfterRPos, lastRow.hipAfterRPos],
      [firstRow.kneeAfterRPos, lastRow.kneeAfterRPos],
      [firstRow.ankleAfterR, lastRow.ankleAfterR]
    ]
    for (const [a, b] of points) {
      loopWrapMm = Math.max(loopWrapMm, new Vector3(...a).distanceTo(new Vector3(...b)) * 1000)
    }
  }

  const metrics = {
    id: meta.id,
    file: meta.relPath,
    pools: [...meta.ids],
    moods: [...meta.moods],
    category: meta.category,
    frames: clip.frames,
    fps: clip.fps,
    loop: clip.loop,
    duration: clip.duration,
    sourceHipsHeight: clip.sourceHipsHeight,
    hipsPositionScale: round(scale, 6),
    groundOffsetMm: round(groundOffsetM * 1000, 4),
    groundMode: author.groundMode,
    author: {
      kneeLMean: round(author.kneeLMean, 3),
      kneeRMean: round(author.kneeRMean, 3),
      kneeLMin: round(author.kneeLMin, 3),
      kneeRMin: round(author.kneeRMin, 3),
      kneeLMax: round(author.kneeLMax, 3),
      kneeRMax: round(author.kneeRMax, 3),
      kneeLRange: round(author.kneeLRange, 3),
      kneeRRange: round(author.kneeRRange, 3),
      meanKnee: round(author.meanKnee, 3),
      worstKnee: round(author.worstKnee, 3),
      hipAnkleDistanceAvgLmm: round(author.hipAnkleDistanceAvgL * 1000, 3),
      hipAnkleDistanceAvgRmm: round(author.hipAnkleDistanceAvgR * 1000, 3),
      hipsYAvg: round(author.hipsYAvg, 4),
      ankleYAvg: round(author.ankleYAvg, 4),
      standing: author.standing,
      staticStance: author.staticStance,
      bent: author.bent,
      loopWrapMm: round(author.loopWrapMm, 4),
      nanCount: author.nanCount
    },
    targets,
    bake: {
      dyMinMm: round(Math.min(...deltaY) * 1000, 4),
      dyMaxMm: round(Math.max(...deltaY) * 1000, 4),
      dxMinMm: round(Math.min(...frameMetrics.map((r) => r.hipsDXMm)), 4),
      dxMaxMm: round(Math.max(...frameMetrics.map((r) => r.hipsDXMm)), 4),
      dzMinMm: round(Math.min(...frameMetrics.map((r) => r.hipsDZMm)), 4),
      dzMaxMm: round(Math.max(...frameMetrics.map((r) => r.hipsDZMm)), 4),
      horizMaxMm: round(Math.max(...deltaHoriz) * 1000, 4),
      horizJitterMm: round(maxStep(frameMetrics.map((r) => r.hipsHorizMm)), 4),
      liftJitterMm: round(maxStep(frameMetrics.map((r) => r.hipsLiftMm)), 4),
      solveResidualMaxMm: round(Math.max(...residuals) * 1000, 8),
      clampedFrames,
      nanCount
    },
    after: {
      kneeLMean: round(afterMeanL, 3),
      kneeRMean: round(afterMeanR, 3),
      overallMean: round(afterOverallMean, 3),
      worstKnee: round(afterWorst, 3),
      kneeLMin: round(Math.min(...kneeAfterL), 3),
      kneeRMin: round(Math.min(...kneeAfterR), 3),
      kneeLRange: round(afterRangeL, 3),
      kneeRRange: round(afterRangeR, 3),
      kneeRangeGrowthMax: round(
        Math.max(afterRangeL - author.kneeLRange, afterRangeR - author.kneeRRange),
        4
      ),
      footDriftMaxMm: round(Math.max(...frameMetrics.map((r) => Math.max(r.footDriftLMm, r.footDriftRMm))), 6),
      footOrientationDriftMaxDeg: round(
        Math.max(...frameMetrics.map((r) => Math.max(r.footOriDriftLDeg, r.footOriDriftRDeg))),
        6
      ),
      hipsLiftMaxAbsMm: round(Math.max(...frameMetrics.map((r) => Math.abs(r.hipsLiftMm))), 4),
      hipsHorizMaxMm: round(Math.max(...frameMetrics.map((r) => r.hipsHorizMm)), 4),
      asymmetryAuthorDeg: round(authorAsymmetryDeg, 4),
      asymmetryAfterDeg: round(afterAsymmetryDeg, 4),
      asymmetryDirectionPreserved,
      neverBendMaxDeg: round(neverBendMaxDeg, 6),
      loopWrapMm: round(loopWrapMm, 4),
      loopWrapDeltaMm: round(loopWrapMm - author.loopWrapMm, 4)
    },
    untouched: untouchedCheck,
    matchesTargets: round(
      Math.max(
        ...frameMetrics.map((r) =>
          Math.max(Math.abs(r.kneeAfterL - r.targetL), Math.abs(r.kneeAfterR - r.targetR))
        )
      ),
      6
    ),
    frameMetrics
  }
  return { bakedJson, metrics, author }
}

/** 极向量兜底：作者膝相对髋方向（world/scene 局部一致；近伸直时避免膝平面翻转）。 */
function solvedKneePoleHint(beforeHip, beforeKnee, shiftedHip) {
  return beforeKnee.clone().sub(beforeHip)
}

/** 逐帧相邻差的最大值（用于抖动指标）。 */
function maxStep(values) {
  let m = 0
  for (let i = 1; i < values.length; i += 1) m = Math.max(m, Math.abs(values[i] - values[i - 1]))
  return m
}

const vec3r = (v) => [round(v.x, 6), round(v.y, 6), round(v.z, 6)]
const quatr = (q) => [round(q.x, 7), round(q.y, 7), round(q.z, 7), round(q.w, 7)]

/** 确保 `bones[bone][key]` 存在（保留原数组形状：nested/flat 以第一帧为准）。 */
function ensureTrack(bones, boneName, key, frames) {
  if (bones[boneName] === undefined) bones[boneName] = {}
  const track = bones[boneName]
  if (track[key] === undefined) {
    const components = key === 'p' ? 3 : 4
    track[key] = Array.from({ length: frames }, () => new Array(components).fill(0))
  }
  return track[key]
}

/** 按原数组形状写某骨某帧（nested 直接写行；flat 写偏移）。 */
function writeTrackFrame(track, frame, components, values) {
  if (Array.isArray(track[0])) {
    track[frame] = values.slice()
    return
  }
  const base = frame * components
  for (let i = 0; i < components; i += 1) track[base + i] = values[i]
}

/**
 * 校验「除 Hips.p 与 6 条腿骨 r 之外」的字段/轨道逐值不变（返回 diff 列表，空 = 通过）。
 */
function verifyUntouched(originalRaw, bakedRaw) {
  const diffs = []
  const allowed = new Set([
    'Hips.p',
    LEG_BONES.leftUpper + '.r',
    LEG_BONES.leftLower + '.r',
    LEG_BONES.leftFoot + '.r',
    LEG_BONES.rightUpper + '.r',
    LEG_BONES.rightLower + '.r',
    LEG_BONES.rightFoot + '.r'
  ])
  const originalBones = originalRaw.bones ?? {}
  const bakedBones = bakedRaw.bones ?? {}
  const boneNames = new Set([...Object.keys(originalBones), ...Object.keys(bakedBones)])
  for (const boneName of boneNames) {
    const originalTrack = originalBones[boneName]
    const bakedTrack = bakedBones[boneName]
    const keys = new Set([
      ...Object.keys(originalTrack ?? {}),
      ...Object.keys(bakedTrack ?? {})
    ])
    for (const key of keys) {
      if (allowed.has(`${boneName}.${key}`)) continue
      if (JSON.stringify(originalTrack?.[key]) !== JSON.stringify(bakedTrack?.[key])) {
        diffs.push(`${boneName}.${key}`)
      }
    }
  }
  const originalTop = { ...originalRaw, bones: undefined }
  const bakedTop = { ...bakedRaw, bones: undefined }
  if (JSON.stringify(originalTop) !== JSON.stringify(bakedTop)) diffs.push('top-level')
  return { ok: diffs.length === 0, diffs }
}

/* -------------------------------------------------------------------------- */
/* staged clip 数值验证（apply 前必须全过；也用于 apply 后复验）                    */
/* -------------------------------------------------------------------------- */

/**
 * 从 staged JSON 重新加载并验证（不依赖 bake 内部状态）：
 * FK 用我们自己的「产品层序」复刻，逐帧量膝角/脚位/脚朝向/髋位移/loop。
 */
export function validateStagedClip(rig, stagedJson, meta, beforeMetrics, params = DEFAULT_PARAMS) {
  const clip = normalizeClip(stagedJson, meta.relPath)
  const after = analyzeClipAuthor(rig, clip, params)
  const failures = []
  const checks = []

  const addCheck = (name, pass, detail) => {
    checks.push({ name, pass, detail })
    if (!pass) failures.push(`${meta.relPath}: ${name} (${detail})`)
  }

  const isIdle = meta.category === 'idle'
  const acceptAvg = isIdle ? params.idleAcceptAvgDeg : params.socialAcceptAvgDeg
  const acceptWorst = isIdle ? params.idleAcceptWorstDeg : params.socialAcceptWorstDeg
  const author = beforeMetrics.author
  const target = beforeMetrics.targets

  addCheck(
    'knee_avg',
    after.meanKnee >= acceptAvg - params.kneeTolDeg,
    `after mean ${round(after.meanKnee, 3)} ≥ ${acceptAvg}`
  )
  addCheck(
    'knee_worst',
    after.worstKnee >= acceptWorst - params.kneeTolDeg,
    `after worst ${round(after.worstKnee, 3)} ≥ ${acceptWorst}`
  )
  addCheck(
    'knee_avg_vs_target',
    after.meanKnee >= target.afterOverallMean - params.kneeTolDeg,
    `after mean ${round(after.meanKnee, 3)} ≥ target ${target.afterOverallMean}`
  )

  // 目标达成：逐帧 after vs target（staged 文件重算 vs bake 期望）
  const expected = beforeMetrics.frameMetrics
  let kneeDeviation = 0
  let footDrift = 0
  let footOriDrift = 0
  for (let f = 0; f < clip.frames; f += 1) {
    const row = expected[f]
    const afterAngleL = after.frames[f].kneeL
    const afterAngleR = after.frames[f].kneeR
    kneeDeviation = Math.max(
      kneeDeviation,
      Math.abs(afterAngleL - row.targetL),
      Math.abs(afterAngleR - row.targetR)
    )
    footDrift = Math.max(
      footDrift,
      after.frames[f].ankleL.distanceTo(new Vector3(...row.ankleBeforeL)) * 1000,
      after.frames[f].ankleR.distanceTo(new Vector3(...row.ankleBeforeR)) * 1000
    )
    footOriDrift = Math.max(
      footOriDrift,
      quatAngleDeg(after.frames[f].footQuatL, new Quaternion(...row.footQuatBeforeL)),
      quatAngleDeg(after.frames[f].footQuatR, new Quaternion(...row.footQuatBeforeR))
    )
  }
  addCheck(
    'knee_matches_target',
    kneeDeviation <= params.kneeTolDeg + 0.01,
    `max |after−target| ${round(kneeDeviation, 4)}°`
  )
  addCheck(
    'foot_position_drift',
    footDrift <= params.footDriftMm,
    `max ${round(footDrift, 4)}mm ≤ ${params.footDriftMm}mm`
  )
  addCheck(
    'foot_orientation_drift',
    footOriDrift <= params.footOrientationDeg,
    `max ${round(footOriDrift, 4)}° ≤ ${params.footOrientationDeg}°`
  )
  addCheck(
    'hip_lift_limit',
    beforeMetrics.bake.dyMinMm >= params.minLiftMm - 1e-6 &&
      beforeMetrics.bake.dyMaxMm <= params.maxLiftMm + 1e-6,
    `δy ${beforeMetrics.bake.dyMinMm}..${beforeMetrics.bake.dyMaxMm}mm ⊂ [${params.minLiftMm},${params.maxLiftMm}]mm`
  )
  addCheck(
    'hip_horizontal_limit',
    beforeMetrics.bake.horizMaxMm <= params.maxHorizontalMm + 1e-6,
    `|δxz| max ${beforeMetrics.bake.horizMaxMm}mm ≤ ${params.maxHorizontalMm}mm`
  )
  const authorAsym = author.kneeLMean - author.kneeRMean
  const afterAsym = after.kneeLMean - after.kneeRMean
  addCheck(
    'asymmetry_direction',
    Math.abs(authorAsym) < 0.2
      ? true
      : Math.sign(authorAsym) === Math.sign(afterAsym),
    `作者 L−R ${round(authorAsym, 3)}° → bake 后 ${round(afterAsym, 3)}°（方向须一致）`
  )
  const neverBend = Math.max(
    ...expected.map((row) =>
      Math.max(row.kneeBeforeL - row.kneeAfterL, row.kneeBeforeR - row.kneeAfterR)
    )
  )
  addCheck(
    'never_bend',
    neverBend <= 1e-3,
    `逐帧 bake 后膝角 − 作者膝角最小值 ${round(-neverBend, 4)}°（≥0 = 只拉直不掰弯）`
  )
  addCheck(
    'knee_range_growth',
    after.kneeLRange - author.kneeLRange <= params.kneeRangeGrowthDeg + 1e-6 &&
      after.kneeRRange - author.kneeRRange <= params.kneeRangeGrowthDeg + 1e-6,
    `Δrange L ${round(after.kneeLRange - author.kneeLRange, 4)}° / R ${round(
      after.kneeRRange - author.kneeRRange,
      4
    )}° ≤ ${params.kneeRangeGrowthDeg}°`
  )
  // loop 连续性：bake 后 wrap 不得比作者原始 wrap 更差（>0.1mm）；作者本身 ≤0.1mm 时 bake 后也必须 ≤0.1mm
  const loopPass =
    after.loopWrapMm - author.loopWrapMm <= params.loopContinuityMm + 1e-6 &&
    (author.loopWrapMm > params.loopContinuityMm ||
      after.loopWrapMm <= params.loopContinuityMm + 1e-6)
  addCheck(
    'loop_continuity',
    clip.loop ? loopPass : true,
    clip.loop
      ? `after wrap ${round(after.loopWrapMm, 4)}mm vs author ${round(
          author.loopWrapMm,
          4
        )}mm（增量 ${round(after.loopWrapMm - author.loopWrapMm, 4)}mm）`
      : 'non-loop clip（不适用）'
  )
  addCheck('no_nan', after.nanCount === 0, `NaN 计数 ${after.nanCount}`)
  addCheck(
    'untouched_fields',
    beforeMetrics.untouched.ok,
    beforeMetrics.untouched.ok ? '仅 Hips.p / 6 腿骨 r 变化' : beforeMetrics.untouched.diffs.join(',')
  )
  addCheck(
    'solve_residual',
    beforeMetrics.bake.solveResidualMaxMm <= 0.05,
    `髋位移求解残差 max ${beforeMetrics.bake.solveResidualMaxMm}mm ≤ 0.05mm`
  )

  return {
    pass: failures.length === 0,
    failures,
    checks,
    stats: {
      afterMean: round(after.meanKnee, 3),
      afterWorst: round(after.worstKnee, 3),
      afterMeanL: round(after.kneeLMean, 3),
      afterMeanR: round(after.kneeRMean, 3),
      afterRangeL: round(after.kneeLRange, 3),
      afterRangeR: round(after.kneeRRange, 3),
      footDriftMaxMm: round(footDrift, 5),
      loopWrapMm: round(after.loopWrapMm, 4),
      loopWrapAuthorMm: round(author.loopWrapMm, 4),
      kneeDeviationDeg: round(kneeDeviation, 4)
    }
  }
}

/* -------------------------------------------------------------------------- */
/* 清单筛选（analyze / bake 共用）                                              */
/* -------------------------------------------------------------------------- */

/**
 * 遍历池内文件 → 全帧 FK 统计 → 筛选「standing && 静态 && 屈膝」→ 目标可行性预判。
 */
export function selectClips(rig, pools, params = DEFAULT_PARAMS, options = {}) {
  const selected = []
  const excluded = []
  const motionsDir = options.motionsDir ?? DEFAULT_MOTIONS_DIR
  /** 上次 bake 产物 sha（apply 后资产 == shaAfter ⇒ 防止对已 bake 数据二次 bake）。 */
  const appliedAfterHashes = options.appliedAfterHashes ?? new Set()
  for (const [relPath, meta] of [...pools.byRelPath.entries()].sort((a, b) =>
    a[0] < b[0] ? -1 : 1
  )) {
    const absolute = join(motionsDir, relPath)
    if (!existsSync(absolute)) {
      excluded.push({ file: relPath, ids: [...meta.ids], reasons: ['文件不存在'] })
      continue
    }
    let raw
    let clip
    try {
      raw = readJson(absolute)
      clip = normalizeClip(raw, relPath)
    } catch (error) {
      excluded.push({ file: relPath, ids: [...meta.ids], reasons: [`解析失败：${error.message}`] })
      continue
    }
    if (appliedAfterHashes.has(fileSha256(absolute))) {
      excluded.push({
        file: relPath,
        ids: [...meta.ids],
        reasons: ['资产已是上次 bake 的产物（sha == staging sha256After；防止二次 bake）']
      })
      continue
    }
    const author = analyzeClipAuthor(rig, clip, params)
    const targets = computeTargets(author, meta.category, params)
    const reasons = []
    if (!author.standing) reasons.push('非站立（standing=false）')
    if (!author.staticStance)
      reasons.push(
        `动态屈膝（逐腿 range L=${round(author.kneeLRange, 2)}°/R=${round(
          author.kneeRRange,
          2
        )}°，≥${params.staticKneeRangeMaxDeg}°）`
      )
    if (!author.bent) reasons.push(`作者已接近伸直（均值 ${round(author.meanKnee, 2)}° ≥ 174°）`)
    if (!targets.pass) reasons.push('目标膝角/最差帧下限不可同时满足')
    const item = {
      relPath,
      ids: [...meta.ids],
      moods: [...meta.moods],
      category: meta.category,
      raw,
      clip,
      author,
      targets,
      eligible: reasons.length === 0
    }
    if (reasons.length === 0) selected.push(item)
    else excluded.push({ file: relPath, ids: [...meta.ids], reasons, author, targets })
  }
  return { selected, excluded }
}

/* -------------------------------------------------------------------------- */
/* staging 写盘 / manifest                                                     */
/* -------------------------------------------------------------------------- */

function stagingPathFor(outDir, relPath) {
  return join(outDir, 'staging', relPath)
}

function metricsPathFor(outDir) {
  return join(outDir, 'metrics.json')
}

function stagingManifestPathFor(outDir) {
  return join(outDir, 'staging-manifest.json')
}

function gitHead() {
  try {
    return execSync('git rev-parse HEAD', { cwd: REPO_ROOT, encoding: 'utf8' }).trim()
  } catch {
    return null
  }
}

/* -------------------------------------------------------------------------- */
/* CLI 参数                                                                    */
/* -------------------------------------------------------------------------- */

function parseArgs(argv) {
  const first = argv[0]
  const options = {
    command: first === undefined ? 'bake' : first === '--help' || first === '-h' ? 'help' : first,
    vrm: DEFAULT_VRM,
    motionsDir: DEFAULT_MOTIONS_DIR,
    outDir: DEFAULT_OUT_DIR,
    backupDir: DEFAULT_BACKUP_DIR,
    params: { ...DEFAULT_PARAMS },
    only: null,
    exclude: new Set(),
    yes: false,
    dryRun: false,
    quiet: false,
    simulateFailAfterWrite: false
  }
  for (let i = 1; i < argv.length; i += 1) {
    const arg = argv[i]
    const next = () => {
      i += 1
      if (i >= argv.length) throw new Error(`${arg} 缺少参数`)
      return argv[i]
    }
    switch (arg) {
      case '--vrm':
        options.vrm = resolve(next())
        break
      case '--motions-dir':
        options.motionsDir = resolve(next())
        break
      case '--out-dir':
        options.outDir = resolve(next())
        break
      case '--backup-dir':
        options.backupDir = resolve(next())
        break
      case '--max-lift-mm':
        options.params.maxLiftMm = Number(next())
        break
      case '--max-horizontal-mm':
        options.params.maxHorizontalMm = Number(next())
        break
      case '--idle-base':
        options.params.idleBaseDeg = Number(next())
        options.params.idleAcceptAvgDeg = Math.min(
          options.params.idleAcceptAvgDeg,
          options.params.idleBaseDeg
        )
        break
      case '--social-base':
        options.params.socialBaseDeg = Number(next())
        break
      case '--only':
        options.only = new Set(
          next()
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean)
        )
        break
      case '--exclude':
        for (const id of next().split(',')) options.exclude.add(id.trim())
        break
      case '--yes':
        options.yes = true
        break
      case '--dry-run':
        options.dryRun = true
        break
      case '--quiet':
        options.quiet = true
        break
      case '--simulate-fail-after-write':
        options.simulateFailAfterWrite = true
        break
      case '--help':
      case '-h':
        options.command = 'help'
        break
      default:
        throw new Error(`未知参数 ${arg}（--help 查看用法）`)
    }
  }
  return options
}

const HELP_TEXT = `用法：
  node scripts/vrm/motion/straighten-standing-knees.mjs <command> [options]

命令：
  analyze    只统计/筛选/打印目标清单（不写盘）
  bake       bake 到 staging（默认；不碰 assets/**）+ 数值验证 + 写 metrics
  validate   重新读 staging 做数值验证
  apply      备份 → 原子写入 assets/motions/** → 复验 → 失败自动回滚（需 --yes）
  rollback   从备份一键恢复（需 --yes）

选项：
  --vrm <path>                 真实 VRM（默认 assets/vrm/aventurine-tpose.vrm）
  --motions-dir <dir>          动作根目录（默认 assets/motions）
  --out-dir <dir>              staging/metrics 输出目录（默认 tests/tmp/bake-leg）
  --backup-dir <dir>           备份根目录（默认 assets/motions-leg-backup-2026-11-11）
  --max-lift-mm <mm>           hips.y 抬升上限（默认 5）
  --max-horizontal-mm <mm>     hips x/z 修正上限（默认 30；少数强不对称 clip 必需）
  --idle-base <deg>            idle 池目标均值（默认 175.5）
  --social-base <deg>          社交/一次性目标均值（默认 173）
  --only <id,id>               只处理这些 id（调试）
  --exclude <id,id>            排除这些 id
  --yes                        apply / rollback 必须显式确认
  --dry-run                    apply 只打印计划不写盘
  --quiet                      少打印
`

/* -------------------------------------------------------------------------- */
/* 打印工具                                                                    */
/* -------------------------------------------------------------------------- */

function pad(value, width) {
  const text = String(value)
  return text.length >= width ? text : text + ' '.repeat(width - text.length)
}
function padStart(value, width) {
  const text = String(value)
  return text.length >= width ? text : ' '.repeat(width - text.length) + text
}

function printTable(rows, headers) {
  const widths = headers.map((h, i) =>
    Math.max(String(h).length, ...rows.map((row) => String(row[i] ?? '').length))
  )
  console.log(headers.map((h, i) => pad(h, widths[i])).join('  '))
  console.log(widths.map((w) => '-'.repeat(w)).join('  '))
  for (const row of rows) console.log(row.map((v, i) => pad(v, widths[i])).join('  '))
}

/* -------------------------------------------------------------------------- */
/* 命令实现                                                                    */
/* -------------------------------------------------------------------------- */

async function commandAnalyze(options) {
  const pools = applyOnlyFilter(buildPools({ motionsDir: options.motionsDir }), options)
  const rig = await loadLegRig(options.vrm)
  const { selected, excluded } = selectClips(rig, pools, options.params, {
    motionsDir: options.motionsDir
  })
  console.log(`\n== 目标池（用户可见站立 clip，${pools.byRelPath.size} 个文件）==`)
  const rows = []
  for (const item of selected) {
    rows.push([
      item.relPath,
      item.category,
      round(item.author.kneeLMean, 2),
      round(item.author.kneeRMean, 2),
      round(item.author.meanKnee, 2),
      round(item.author.kneeLRange, 2),
      round(item.author.kneeRRange, 2),
      round(item.targets.deltaL, 2),
      round(item.targets.deltaR, 2)
    ])
  }
  printTable(rows, [
    'file',
    'category',
    '作者L',
    '作者R',
    '均值',
    'rangeL',
    'rangeR',
    'ΔL',
    'ΔR'
  ])
  console.log(`\n== 剔除（${excluded.length}）==`)
  for (const item of excluded) {
    console.log(`${pad(item.file, 34)} ${item.reasons.join('；')}`)
  }
  return 0
}

/**
 * 收集「上次 staging 的 sha256After 且当前资产已等于该 sha」的集合（apply 二次保护）。
 * 若 staging-manifest.json 不存在/损坏 → 空集合（正常首次 bake）。
 */
function collectAppliedAfterHashes(options) {
  const manifestPath = stagingManifestPathFor(options.outDir)
  const result = new Set()
  if (!existsSync(manifestPath)) return result
  try {
    const previous = readJson(manifestPath)
    for (const entry of previous.clips ?? []) {
      if (typeof entry.sha256After !== 'string') continue
      const assetPath = join(options.motionsDir, entry.file)
      if (existsSync(assetPath) && fileSha256(assetPath) === entry.sha256After) {
        result.add(entry.sha256After)
      }
    }
  } catch {
    // 忽略：无法读取上次 manifest 时按首次 bake 处理
  }
  return result
}

function applyOnlyFilter(pools, options) {
  if (options.only === null && options.exclude.size === 0) return pools
  const byRelPath = new Map()
  for (const [relPath, meta] of pools.byRelPath) {
    const ids = [...meta.ids]
    if (options.only !== null && !ids.some((id) => options.only.has(id))) continue
    if (ids.some((id) => options.exclude.has(id))) continue
    byRelPath.set(relPath, meta)
  }
  return { ...pools, byRelPath }
}

async function commandBake(options) {
  const startedAt = Date.now()
  const pools = applyOnlyFilter(buildPools({ motionsDir: options.motionsDir }), options)
  const rig = await loadLegRig(options.vrm)
  const rigInfo = {
    vrm: relative(REPO_ROOT, options.vrm),
    hipsRestHeight: round(rig.hipsRestHeight, 6),
    upperLengthMm: round(rig.upperLength * 1000, 4),
    lowerLengthMm: round(rig.lowerLength * 1000, 4),
    totalLegMm: round((rig.upperLength + rig.lowerLength) * 1000, 4),
    restFeetLocalY: round(rig.restFeetLocalY, 6)
  }
  const appliedAfterHashes = collectAppliedAfterHashes(options)
  const { selected, excluded } = selectClips(rig, pools, options.params, {
    motionsDir: options.motionsDir,
    appliedAfterHashes
  })
  if (selected.length === 0) {
    console.error('没有可 bake 的 clip（全部被筛掉）；见 analyze 输出。')
    return 1
  }

  // --- no-op 往返自检（解析→应用→读回→写盘→再解析，误差应≈0） ---
  const roundtrip = []
  for (const item of selected) {
    const result = noopRoundtrip(rig, item.clip, options.params)
    roundtrip.push({ id: item.ids[0], file: item.relPath, ...result })
    if (!result.pass) {
      console.error(`no-op 往返自检失败：${item.relPath} maxJointDiff=${result.maxJointDiffMm}mm`)
      return 1
    }
  }

  const clips = []
  const failed = []
  for (const item of selected) {
    const meta = { id: item.ids[0], relPath: item.relPath, ids: item.ids, moods: item.moods, category: item.category }
    const started = Date.now()
    const { bakedJson, metrics } = bakeClip(rig, item.clip, meta, options.params)
    const stagedPath = stagingPathFor(options.outDir, item.relPath)
    const originalBytes = readFileSync(join(options.motionsDir, item.relPath))
    const serialized = JSON.stringify(bakedJson)
    const bakedBytes = Buffer.from(serialized)
    if (!options.dryRun) {
      writeFileAtomic(stagedPath, serialized)
      // 直接从磁盘重新读回，后续验证用磁盘版本
      const stagedRaw = readJson(stagedPath)
      const validation = validateStagedClip(rig, stagedRaw, meta, metrics, options.params)
      metrics.validation = validation
      metrics.staged = {
        path: relative(REPO_ROOT, stagedPath),
        bytesBefore: originalBytes.length,
        bytesAfter: bakedBytes.length,
        sha256Before: sha256(originalBytes),
        sha256After: sha256(bakedBytes)
      }
      metrics.roundtrip = roundtrip.find((r) => r.file === item.relPath)
      clips.push(metrics)
      if (!validation.pass) failed.push({ file: item.relPath, failures: validation.failures })
    }
    if (!options.quiet) {
      console.log(
        `baked ${pad(item.relPath, 30)} ${pad(metrics.category, 7)} ` +
          `knee ${round(metrics.author.kneeLMean, 1)}/${round(metrics.author.kneeRMean, 1)} -> ` +
          `${round(metrics.after.kneeLMean, 1)}/${round(metrics.after.kneeRMean, 1)}  ` +
          `worst ${round(metrics.author.worstKnee, 1)} -> ${round(metrics.after.worstKnee, 1)}  ` +
          `δy ${round(metrics.bake.dyMinMm, 2)}..${round(metrics.bake.dyMaxMm, 2)}mm  ` +
          `|δxz| ${round(metrics.bake.horizMaxMm, 1)}mm  ` +
          `(${Date.now() - started}ms)`
      )
    }
  }

  const generatedAt = new Date().toISOString()
  const allChecks = clips.flatMap((c) => (c.validation?.checks ?? []).map((check) => ({ file: c.file, ...check })))
  const validationPassed = clips.length === selected.length && failed.length === 0
  const metricsFile = {
    schemaVersion: 1,
    kind: 'standing-knee-straighten-bake',
    generatedAt,
    gitHead: gitHead(),
    vrm: rigInfo,
    params: options.params,
    pools: {
      idleEntryIds: [...buildPools({ motionsDir: options.motionsDir }).idleEntryIds],
      fidgetPoolIds: [...FIDGET_POOL_IDS]
    },
    clipCount: clips.length,
    clips,
    excluded: excluded.map((item) => ({
      file: item.file,
      ids: item.ids,
      reasons: item.reasons,
      author: item.author
        ? {
            standing: item.author.standing,
            meanKnee: round(item.author.meanKnee, 2),
            kneeLMean: round(item.author.kneeLMean, 2),
            kneeRMean: round(item.author.kneeRMean, 2),
            kneeLRange: round(item.author.kneeLRange, 2),
            kneeRRange: round(item.author.kneeRRange, 2)
          }
        : null
    })),
    roundtrip,
    validation: {
      passed: validationPassed,
      checks: allChecks,
      failures: failed.flatMap((f) => f.failures),
      clipCount: clips.length,
      totalMs: Date.now() - startedAt
    }
  }
  if (!options.dryRun) {
    writeFileAtomic(metricsPathFor(options.outDir), JSON.stringify(metricsFile, null, 1))
    const manifest = {
      schemaVersion: 1,
      kind: 'standing-knee-straighten-staging',
      generatedAt,
      gitHead: metricsFile.gitHead,
      vrm: rigInfo.vrm,
      params: options.params,
      motionsDir: relative(REPO_ROOT, options.motionsDir),
      backupDir: relative(REPO_ROOT, options.backupDir),
      clips: clips.map((c) => ({
        id: c.id,
        file: c.file,
        category: c.category,
        sha256Before: c.staged.sha256Before,
        sha256After: c.staged.sha256After,
        stagedPath: c.staged.path,
        assetPath: join(relative(REPO_ROOT, options.motionsDir), c.file),
        metrics: {
          kneeBeforeL: c.author.kneeLMean,
          kneeBeforeR: c.author.kneeRMean,
          kneeAfterL: c.after.kneeLMean,
          kneeAfterR: c.after.kneeRMean,
          worstAfter: c.after.worstKnee,
          hipsLiftMaxMm: c.after.hipsLiftMaxAbsMm,
          hipsHorizMaxMm: c.after.hipsHorizMaxMm,
          footDriftMaxMm: c.after.footDriftMaxMm
        }
      }))
    }
    writeFileAtomic(stagingManifestPathFor(options.outDir), JSON.stringify(manifest, null, 1))
  }

  // --- 打印汇总 ---
  console.log(`\n== bake 汇总（${clips.length} 条，${Date.now() - startedAt}ms）==`)
  const rows = clips.map((c) => [
    c.file,
    c.category,
    `${round(c.author.kneeLMean, 1)}/${round(c.author.kneeRMean, 1)}`,
    `${round(c.after.kneeLMean, 1)}/${round(c.after.kneeRMean, 1)}`,
    round(c.author.worstKnee, 1),
    round(c.after.worstKnee, 1),
    round(c.after.kneeLRange - c.author.kneeLRange, 2),
    round(c.after.kneeRRange - c.author.kneeRRange, 2),
    round(c.bake.dyMinMm, 2),
    round(c.bake.dyMaxMm, 2),
    round(c.bake.horizMaxMm, 2),
    round(c.after.loopWrapDeltaMm, 3),
    c.validation?.pass ? 'PASS' : 'FAIL'
  ])
  printTable(rows, [
    'file',
    'category',
    'before L/R',
    'after L/R',
    'worstB',
    'worstA',
    'ΔrangeL',
    'ΔrangeR',
    'δy min',
    'δy max',
    '|δxz|max',
    'loopΔ',
    'valid'
  ])
  if (!options.dryRun) {
    console.log(`\nstaging: ${relative(REPO_ROOT, join(options.outDir, 'staging'))}/`)
    console.log(`metrics: ${relative(REPO_ROOT, metricsPathFor(options.outDir))}`)
  }
  console.log(`\n验证结果：${validationPassed ? 'PASS（全部 clip 通过）' : 'FAIL'}`)
  if (!validationPassed) {
    for (const failure of failed.flatMap((f) => f.failures)) console.error(`  ✗ ${failure}`)
    return 1
  }
  console.log('下一步：经 Lead 批准后执行 apply（--yes）；回滚：rollback --yes')
  return 0
}

/** no-op 往返：原 clip → 序列化（含 7 位小数 round）→ 重新解析应用，比对全帧关节位置/膝角。 */
function noopRoundtrip(rig, clip, params) {
  const noopJson = JSON.parse(JSON.stringify(clip.raw))
  // 只通过「读回写轨道」的方式过一遍（不改变数值），模拟写盘-读盘路径
  for (const unityName of LEG_BONE_NAMES) {
    const track = noopJson.bones[unityName]
    if (unityName === 'Hips' && Array.isArray(track.p)) {
      for (let f = 0; f < clip.frames; f += 1) {
        const p = readTrackFrame(track, f, 3) ?? [0, 0, 0]
        writeTrackFrame(track.p, f, 3, p.map(round7))
      }
    }
    const rTrack = track.r
    for (let f = 0; f < clip.frames; f += 1) {
      const r = readTrackFrame(track, f, 4) ?? [0, 0, 0, 1]
      writeTrackFrame(rTrack, f, 4, r.map(round7))
    }
  }
  const noopClip = normalizeClip(noopJson, 'noop')
  rig.reset()
  const { offsetM } = rig.computeGroundOffset(clip)
  const { offsetM: noopOffsetM } = rig.computeGroundOffset(noopClip)
  let maxJointDiffMm = 0
  let maxKneeDiffDeg = 0
  for (let f = 0; f < clip.frames; f += 1) {
    rig.applyClipFrame(clip, f, { extraHips: { y: offsetM } })
    const a = rig.measureLegs()
    rig.applyClipFrame(noopClip, f, { extraHips: { y: noopOffsetM } })
    const b = rig.measureLegs()
    maxKneeDiffDeg = Math.max(
      maxKneeDiffDeg,
      Math.abs(a.kneeAngleL - b.kneeAngleL),
      Math.abs(a.kneeAngleR - b.kneeAngleR)
    )
    for (const [p, q] of [
      [a.hipL, b.hipL],
      [a.kneeL, b.kneeL],
      [a.ankleL, b.ankleL],
      [a.hipR, b.hipR],
      [a.kneeR, b.kneeR],
      [a.ankleR, b.ankleR]
    ]) {
      maxJointDiffMm = Math.max(maxJointDiffMm, p.distanceTo(q) * 1000)
    }
  }
  rig.reset()
  const pass =
    Math.abs(offsetM - noopOffsetM) < 1e-9 &&
    maxJointDiffMm < 0.01 &&
    maxKneeDiffDeg < 0.001
  return {
    pass,
    maxJointDiffMm: round(maxJointDiffMm, 8),
    maxKneeDiffDeg: round(maxKneeDiffDeg, 8),
    groundOffsetDiffMm: round((noopOffsetM - offsetM) * 1000, 8)
  }
}

async function commandValidate(options) {
  const manifestPath = stagingManifestPathFor(options.outDir)
  const metricsPath = metricsPathFor(options.outDir)
  if (!existsSync(manifestPath) || !existsSync(metricsPath)) {
    console.error(`缺少 staging manifest/metrics：${manifestPath} / ${metricsPath}（先跑 bake）`)
    return 1
  }
  const manifest = readJson(manifestPath)
  const metrics = readJson(metricsPath)
  const validateParams = { ...options.params, ...(manifest.params ?? {}) }
  const byFile = new Map(metrics.clips.map((c) => [c.file, c]))
  const rig = await loadLegRig(options.vrm)
  let failed = 0
  const rows = []
  for (const entry of manifest.clips) {
    const stagedPath = join(options.outDir, 'staging', entry.file)
    if (!existsSync(stagedPath)) {
      console.error(`staging 缺文件：${entry.file}`)
      failed += 1
      continue
    }
    const stagedRaw = readJson(stagedPath)
    const before = byFile.get(entry.file)
    if (before === undefined) {
      console.error(`metrics 缺条目：${entry.file}`)
      failed += 1
      continue
    }
    const meta = { id: entry.id, relPath: entry.file, category: entry.category }
    const validation = validateStagedClip(rig, stagedRaw, meta, before, validateParams)
    const currentSha = fileSha256(stagedPath)
    const shaOk = currentSha === entry.sha256After
    rows.push([
      entry.file,
      round(validation.stats.afterMean, 2),
      round(validation.stats.afterWorst, 2),
      validation.stats.footDriftMaxMm,
      validation.stats.loopWrapMm,
      shaOk ? 'ok' : 'SHA-MISMATCH',
      validation.pass && shaOk ? 'PASS' : 'FAIL'
    ])
    if (!validation.pass || !shaOk) {
      failed += 1
      for (const failure of validation.failures) console.error(`  ✗ ${failure}`)
      if (!shaOk) console.error(`  ✗ ${entry.file}: staging 文件 sha256 与 bake 时不一致`)
    }
  }
  printTable(rows, ['file', 'afterMean', 'afterWorst', 'footDriftMm', 'loopWrapMm', 'sha', 'valid'])
  console.log(`\nvalidate：${failed === 0 ? 'PASS' : `FAIL（${failed} 条）`}`)
  return failed === 0 ? 0 : 1
}

/* -------------------------------------------------------------------------- */
/* apply / rollback                                                           */
/* -------------------------------------------------------------------------- */

function resolveCliPlan(options) {
  const manifestPath = stagingManifestPathFor(options.outDir)
  const metricsPath = metricsPathFor(options.outDir)
  if (!existsSync(manifestPath) || !existsSync(metricsPath)) {
    throw new Error(`缺少 staging（${manifestPath}）；先跑 bake 并等待 Lead 批准`)
  }
  const manifest = readJson(manifestPath)
  const metrics = readJson(metricsPath)
  if (metrics.validation?.passed !== true) {
    throw new Error('bake 的数值验证未通过，拒绝 apply')
  }
  if (manifest.clips.length === 0) throw new Error('staging 为空，拒绝 apply')
  const plan = []
  for (const entry of manifest.clips) {
    const assetPath = join(options.motionsDir, entry.file)
    const stagedPath = join(options.outDir, 'staging', entry.file)
    const backupPath = join(options.backupDir, entry.file)
    const state = classifyApplyState({ assetPath, stagedPath, backupPath, entry })
    plan.push({ ...entry, assetPath, stagedPath, backupPath, state })
  }
  return { manifest, metrics, plan }
}

function classifyApplyState({ assetPath, stagedPath, backupPath, entry }) {
  if (!existsSync(stagedPath)) return { kind: 'missing-staging' }
  const stagedSha = fileSha256(stagedPath)
  if (stagedSha !== entry.sha256After) return { kind: 'staged-changed' }
  if (!existsSync(assetPath)) return { kind: 'missing-asset' }
  const assetSha = fileSha256(assetPath)
  if (assetSha === entry.sha256After) {
    // 已应用（幂等）：备份应存在且等于原文件
    if (!existsSync(backupPath)) return { kind: 'already-applied-no-backup' }
    if (fileSha256(backupPath) !== entry.sha256Before) return { kind: 'already-applied-backup-mismatch' }
    return { kind: 'already-applied' }
  }
  if (assetSha === entry.sha256Before) {
    if (existsSync(backupPath) && fileSha256(backupPath) !== entry.sha256Before) {
      return { kind: 'backup-conflict' }
    }
    return { kind: 'pending' }
  }
  return { kind: 'asset-changed' }
}

async function commandApply(options) {
  if (!options.yes && !options.dryRun) {
    console.error('apply 会修改真实 assets/**；需要 Lead 批准后显式加 --yes。')
    return 1
  }
  let resolved
  try {
    resolved = resolveCliPlan(options)
  } catch (error) {
    console.error(`apply 拒绝：${error.message}`)
    return 1
  }
  const { manifest, metrics, plan } = resolved
  const applyParams = { ...options.params, ...(manifest.params ?? {}) }
  console.log(`\n== apply 计划（${plan.length} 条；backup → ${relative(REPO_ROOT, options.backupDir)}）==`)
  for (const item of plan) {
    const state = item.state.kind
    console.log(`  ${pad(item.file, 32)} ${pad(state, 24)} ${item.sha256Before.slice(0, 12)} -> ${item.sha256After.slice(0, 12)}`)
  }
  const notReady = plan.filter(
    (item) => !['pending', 'already-applied'].includes(item.state.kind)
  )
  if (notReady.length > 0) {
    console.error('\napply 拒绝：存在不可安全应用的条目（staging/asset/backup 状态异常）：')
    for (const item of notReady) console.error(`  ✗ ${item.file}: ${item.state.kind}`)
    return 1
  }
  if (options.dryRun) {
    console.log('\n--dry-run：不写盘（计划如上）。')
    return 0
  }

  // --- 备份 + 原子写入 ---
  const written = []
  const applyLog = []
  try {
    for (const item of plan) {
      if (item.state.kind !== 'pending') {
        applyLog.push({ file: item.file, action: item.state.kind, backup: null })
        continue
      }
      mkdirSync(dirname(item.backupPath), { recursive: true })
      if (!existsSync(item.backupPath)) {
        copyFileSync(item.assetPath, item.backupPath)
        // 备份必须与 bake 时的原文件字节一致
        if (fileSha256(item.backupPath) !== item.sha256Before) {
          throw new Error(`${item.file}: 备份 sha256 校验失败`)
        }
      }
      const content = readFileSync(item.stagedPath)
      writeFileAtomic(item.assetPath, content)
      const writtenSha = fileSha256(item.assetPath)
      if (writtenSha !== item.sha256After) {
        throw new Error(`${item.file}: 写入后 sha256 校验失败`)
      }
      written.push(item)
      applyLog.push({ file: item.file, action: 'written', backup: relative(REPO_ROOT, item.backupPath) })
    }
    console.log(`\n已写入 ${written.length} 个 clip（${plan.length - written.length} 个已是目标状态/跳过）。`)

    if (options.simulateFailAfterWrite) {
      throw new Error('--simulate-fail-after-write：演练自动回滚路径')
    }

    // --- 写后复验（读真实 assets 文件，重新 FK 验证） ---
    const rig = await loadLegRig(options.vrm)
    const byFile = new Map(metrics.clips.map((c) => [c.file, c]))
    let failed = 0
    for (const item of plan) {
      const raw = readJson(item.assetPath)
      const before = byFile.get(item.file)
      const meta = { id: item.id, relPath: item.file, category: item.category }
      const validation = validateStagedClip(rig, raw, meta, before, applyParams)
      if (!validation.pass) {
        failed += 1
        console.error(`  ✗ 写后复验失败 ${item.file}: ${validation.failures.join('；')}`)
      }
    }
    if (failed > 0) throw new Error(`写后复验失败 ${failed} 条`)
    console.log('写后复验：PASS（全部 clip 数值验证通过）')
  } catch (error) {
    console.error(`\napply 失败：${error.message}`)
    console.error('自动回滚本次写入 ...')
    let rollbackFailed = 0
    for (const item of written.reverse()) {
      try {
        if (existsSync(item.backupPath)) {
          writeFileAtomic(item.assetPath, readFileSync(item.backupPath))
          if (fileSha256(item.assetPath) !== item.sha256Before) throw new Error('restore sha mismatch')
          console.error(`  ✓ 已恢复 ${item.file}`)
        } else {
          rollbackFailed += 1
        }
      } catch (rollbackError) {
        rollbackFailed += 1
        console.error(`  ✗ 恢复 ${item.file} 失败：${rollbackError.message}`)
      }
    }
    if (rollbackFailed === 0) {
      for (const item of written) {
        // 回滚成功：保留备份目录，便于人工核对
      }
      console.error('自动回滚完成：assets/** 已恢复原文件。')
    } else {
      console.error('自动回滚未完全成功！请手工从备份目录恢复。')
    }
    return 1
  }

  const result = {
    schemaVersion: 1,
    kind: 'standing-knee-straighten-apply',
    appliedAt: new Date().toISOString(),
    gitHead: gitHead(),
    restored: false,
    backupDir: relative(REPO_ROOT, options.backupDir),
    clips: applyLog,
    validationPassed: true
  }
  writeFileAtomic(join(options.outDir, 'apply-result.json'), JSON.stringify(result, null, 1))
  console.log(`\napply：PASS（${written.length} 条写入，全部复验通过）`)
  console.log(`回滚命令：node scripts/vrm/motion/straighten-standing-knees.mjs rollback --yes`)
  void manifest
  return 0
}

async function commandRollback(options) {
  if (!options.yes) {
    console.error('rollback 会覆盖真实 assets/**；需要显式 --yes。')
    return 1
  }
  let plan
  try {
    plan = resolveCliPlan(options).plan
  } catch (error) {
    // 即使 metrics 验证失败也允许回滚（rollback 是安全通道）：
    // 优先退化为只读 staging manifest；manifest 也丢失时直接扫备份目录恢复（兜底一键回滚）。
    const manifestPath = stagingManifestPathFor(options.outDir)
    if (existsSync(manifestPath)) {
      const manifest = readJson(manifestPath)
      plan = manifest.clips.map((entry) => ({
        ...entry,
        assetPath: join(options.motionsDir, entry.file),
        stagedPath: join(options.outDir, 'staging', entry.file),
        backupPath: join(options.backupDir, entry.file)
      }))
    } else {
      const files = walkFiles(options.backupDir)
      if (files.length === 0) {
        console.error(`rollback 失败：${error.message}（备份目录 ${options.backupDir} 也为空）`)
        return 1
      }
      console.log(`staging manifest 缺失，直接从备份目录恢复 ${files.length} 个文件：${options.backupDir}`)
      plan = files.map((rel) => ({
        file: rel,
        assetPath: join(options.motionsDir, rel),
        stagedPath: join(options.outDir, 'staging', rel),
        backupPath: join(options.backupDir, rel)
      }))
    }
  }
  let restored = 0
  const rows = []
  for (const item of plan) {
    if (!existsSync(item.backupPath)) {
      rows.push([item.file, '无备份', existsSync(item.assetPath) ? '跳过' : '缺 asset'])
      continue
    }
    const backupSha = fileSha256(item.backupPath)
    const currentSha = existsSync(item.assetPath) ? fileSha256(item.assetPath) : null
    if (currentSha === backupSha) {
      rows.push([item.file, '已是原文件', '跳过'])
      continue
    }
    writeFileAtomic(item.assetPath, readFileSync(item.backupPath))
    if (fileSha256(item.assetPath) !== backupSha) {
      console.error(`✗ 恢复 ${item.file} 校验失败`)
      return 1
    }
    restored += 1
    rows.push([item.file, '已恢复', ''])
  }
  printTable(rows, ['file', 'action', 'note'])
  console.log(`\nrollback：${restored} 条恢复（备份目录：${relative(REPO_ROOT, options.backupDir)}）`)
  return 0
}

/* -------------------------------------------------------------------------- */
/* main                                                                       */
/* -------------------------------------------------------------------------- */

/** 是否被直接 `node script.mjs ...` 执行（被 import 用于验证测试时不自动跑 CLI）。 */
function isMainModule() {
  if (typeof process.argv[1] !== 'string') return false
  try {
    return pathToFileURL(resolve(process.argv[1])).href === import.meta.url
  } catch {
    return false
  }
}

async function main() {
  let options
  try {
    options = parseArgs(process.argv.slice(2))
  } catch (error) {
    console.error(error.message)
    console.error(HELP_TEXT)
    return 2
  }
  switch (options.command) {
    case 'analyze':
      return commandAnalyze(options)
    case 'bake':
      return commandBake(options)
    case 'validate':
      return commandValidate(options)
    case 'apply':
      return commandApply(options)
    case 'rollback':
      return commandRollback(options)
    case 'help':
      console.log(HELP_TEXT)
      return 0
    default:
      console.error(`未知命令 ${options.command}`)
      console.error(HELP_TEXT)
      return 2
  }
}

if (isMainModule()) {
  main()
    .then((code) => {
      process.exitCode = typeof code === 'number' ? code : 1
    })
    .catch((error) => {
      console.error('未捕获错误：', error)
      process.exitCode = 1
    })
}
