/**
 * 连续微动层 + 静态手部姿态（「活人感」核心；纯函数，不 import three）。
 *
 * v3（用户：「默认动作还是很诡异/僵硬，没有优化感」）重点：
 * 1. **静态半握**：模型 rest 手指是大张的「僵尸手」→ 每根指骨静态弯曲 10–25°，
 *    手腕微内旋，让默认站姿就有「放松的手」而不是五指张开；
 * 2. 呼吸/重心/头漂移幅度加大到**远处也看得见**（单骨 3–6°，周期 3–6s）；
 * 3. 多频率不可通约叠加（0.23/0.17/0.11/0.075/0.19Hz）→ 永不循环；
 * 4. 慢层「每 8–15s 换一次承重脚」由 pipeline 的 weight-shift 状态机驱动，
 *    本模块只接收 `weightShift`（-1..1，正 = 重心压角色左腿）转成骨盆/躯干/头角度。
 *
 * 手指弯曲轴（由模型 rest 位置推断）：左手指向 +X/-Y、掌心朝 -Y，
 * 因此左手指弯曲 = 绕 **Z 负**、右侧镜像绕 **Z 正**（即 `curlSign = -1 / +1`）。
 */
import { clamp } from './quat'
import type { EulerDeg } from './types'

/** 微动幅度缩放（不同姿态给不同权重）。 */
export interface MicroMotionScale {
  /** 呼吸/胸腔起伏（含头颈滞后）。 */
  breath: number
  /** 重心摆动/骨盆 roll。 */
  sway: number
  /** 头/颈延迟跟随。 */
  headLag: number
  /** 手臂/手腕 follow-through。 */
  arm: number
  /** 手指收放。 */
  finger: number
}

/** 默认（站/坐等安静姿态）。 */
export const DEFAULT_MICRO_SCALE: MicroMotionScale = {
  breath: 1,
  sway: 1,
  headLag: 1,
  arm: 1,
  finger: 1
}

/** 按姿态类型的微动缩放。 */
export const MICRO_SCALE_BY_MODE: Readonly<Record<string, MicroMotionScale>> = {
  stand: DEFAULT_MICRO_SCALE,
  idle: DEFAULT_MICRO_SCALE,
  walk: { breath: 0.9, sway: 0.6, headLag: 0.7, arm: 1.2, finger: 0.8 },
  climb: { breath: 1.2, sway: 1.1, headLag: 0.8, arm: 1.5, finger: 0.4 },
  sit: { breath: 1.1, sway: 0.8, headLag: 1.1, arm: 0.9, finger: 1.1 },
  sitEdge: { breath: 1.1, sway: 1.2, headLag: 1.1, arm: 1, finger: 1.1 },
  sleep: { breath: 0.5, sway: 0.4, headLag: 0.5, arm: 0.35, finger: 0.6 },
  drag: { breath: 0.8, sway: 1.6, headLag: 1.4, arm: 1.6, finger: 0.6 },
  fall: { breath: 0.9, sway: 1.8, headLag: 1.2, arm: 1.8, finger: 0.6 },
  pat: { breath: 1.1, sway: 0.9, headLag: 1.2, arm: 0.8, finger: 1.1 },
  celebrate: { breath: 1.2, sway: 0.9, headLag: 1.1, arm: 1, finger: 0.9 },
  sad: { breath: 0.8, sway: 0.6, headLag: 1.2, arm: 0.6, finger: 0.8 },
  busy: { breath: 0.9, sway: 0.7, headLag: 0.9, arm: 0.8, finger: 1.3 }
}

/** 由姿态 id/模式取微动缩放（未知回退默认）。 */
export function microScaleFor(mode: string): MicroMotionScale {
  return MICRO_SCALE_BY_MODE[mode] ?? DEFAULT_MICRO_SCALE
}

/** 每只手参与「自然半握」的指骨（静态弯曲；模型所有手指 rest 都是张开）。 */
export const MICRO_FINGER_BONES = {
  left: [
    '左人指１',
    '左人指２',
    '左人指３',
    '左中指１',
    '左中指２',
    '左中指３',
    '左薬指１',
    '左薬指２',
    '左薬指３',
    '左小指１',
    '左小指２',
    '左小指３',
    '左親指１',
    '左親指２'
  ],
  right: [
    '右人指１',
    '右人指２',
    '右人指３',
    '右中指１',
    '右中指２',
    '右中指３',
    '右薬指１',
    '右薬指２',
    '右薬指３',
    '右小指１',
    '右小指２',
    '右小指３',
    '右親指１',
    '右親指２'
  ]
} as const

/**
 * 静态半握弯曲（度；正数 = 弯曲量）。
 * 手指按「人指/中指/薬指/小指」的 1/2/3 节递减递增排列，模仿自然放松手的弧线。
 */
const FINGER_CURL_DEG: Readonly<Record<string, number>> = {
  // 2026-11-08 用户：「不能所有时候手都像鸡爪子一样缩着」→ 默认只保留**自然放松的轻微弧**
  // （5–13°，看起来是放松的手而不是握拳）；大的弯曲只在明确手势里用 `fingerCurlExtraDeg` 叠加。
  人指１: 7,
  人指２: 9,
  人指３: 5,
  中指１: 8,
  中指２: 10,
  中指３: 5,
  薬指１: 9,
  薬指２: 11,
  薬指３: 6,
  小指１: 10,
  小指２: 12,
  小指３: 6,
  親指１: 4,
  親指２: 5
}


/**
 * 手势需要的额外手指弯曲（度；在自然放松弧之上叠加）。
 * 用户：「只有明确手势（抛硬币/敬礼/整理）才弯曲」——所以 boost 只在抓/捏/整理类手势里非零：
 * 抛接硬币=抓握、整理衣领=捏布料、望远处=手插兜；
 * 敬礼/伸懒腰等手要展开的动作保持自然放松弧（≤4°）。
 */
export const GESTURE_FINGER_CURL_BOOST: Readonly<Record<string, number>> = {
  coinRoll: 26,
  coinToss: 26,
  adjustCuff: 14,
  salute: 2,
  stretch: 2,
  gazeAway: 8,
  patReact: 4,
  pokedHead: 2,
  pokedBody: 4,
  pokedLeg: 2,
  thrown: 6,
  landed: 4,
  cheer: 4
}

/** 手部整体放松（手腕微内旋，避免「手腕僵直」）。 */
const HAND_RELAX_DEG = {
  left: { wristX: 6, wristY: 0, wristZ: -8 },
  right: { wristX: 8, wristY: 0, wristZ: 10 }
} as const

/** 四个不可通约的微动频率（Hz；0.15–0.42 人因频段内）。 */
const FREQ_BREATH = 0.23
const FREQ_SWAY = 0.17
const FREQ_WEIGHT = 0.075
const FREQ_FINGER = 0.19
const TAU = Math.PI * 2

function addDeg(
  out: Record<string, EulerDeg>,
  bone: string,
  x: number,
  y: number,
  z: number
): void {
  const current = out[bone] ?? {}
  out[bone] = { x: (current.x ?? 0) + x, y: (current.y ?? 0) + y, z: (current.z ?? 0) + z }
}

/**
 * 把「静态手部姿态」写进度数表（左右镜像）。
 *
 * 轴向（2026-11-08 用 FK + 实机截图校准，修复用户反馈「手指像骨折」）：
 * 本模型 A-pose 手掌**掌心朝下/后**（由 hand 骨与指骨 rest 向量叉积求得法线 ≈ (−0.31,−0.63,−0.60)），
 * 手指沿 ±X 伸出；绕 Z 旋转时，**左手指向 −Z（向下）才是朝掌心弯**（此前符号反了，
 * 手指向上/外翻 → 视觉上像骨折/爪子）。右手指向 −X，符号相反。
 */
function applyRelaxedHands(
  out: Record<string, EulerDeg>,
  scale: number,
  extraCurlDeg = 0
): void {
  const amount = clamp(scale, 0, 2)
  const left = HAND_RELAX_DEG.left
  const right = HAND_RELAX_DEG.right
  addDeg(out, '左手首', left.wristX * amount, left.wristY * amount, left.wristZ * amount)
  addDeg(out, '右手首', right.wristX * amount, right.wristY * amount, right.wristZ * amount)
  const extra = clamp(extraCurlDeg, -20, 40)
  for (const [suffix, curlDeg] of Object.entries(FINGER_CURL_DEG)) {
    const curl = Math.max(0, curlDeg * amount + extra)
    addDeg(out, `左${suffix}`, 0, 0, -curl)
    addDeg(out, `右${suffix}`, 0, 0, curl)
  }
}

/**
 * 计算某时刻的微动（度）：静态半握 + 呼吸 + 重心摆动 + 头颈滞后 + 手臂 follow + 手指微动。
 * @param timeSec 单调时间（秒）
 * @param scale 幅度缩放
 * @param options.weightShift 慢层承重脚（-1..1；正 = 重心压角色左腿）
 * @param options.withFingers 是否包含手指（测试可关）
 */
export function computeMicroMotion(
  timeSec: number,
  scale: MicroMotionScale = DEFAULT_MICRO_SCALE,
  options: {
    weightShift?: number
    withFingers?: boolean
    /** 手势额外手指弯曲（度；0 = 默认自然放松弧） */
    fingerCurlExtraDeg?: number
  } = {}
): Record<string, EulerDeg> {
  const t = Number.isFinite(timeSec) ? timeSec : 0
  const breath = Math.sin(TAU * FREQ_BREATH * t)
  const breath2 = Math.sin(TAU * FREQ_BREATH * t + 1.9)
  const sway = Math.sin(TAU * FREQ_SWAY * t + 0.7)
  const sway2 = Math.sin(TAU * FREQ_SWAY * t + 2.6)
  const weight = Math.sin(TAU * FREQ_WEIGHT * t + 1.2)
  const finger = Math.sin(TAU * FREQ_FINGER * t)
  const shift = clamp(options.weightShift ?? 0, -1.5, 1.5)

  const out: Record<string, EulerDeg> = {}
  const b = clamp(scale.breath, 0, 2)
  const s = clamp(scale.sway, 0, 2)
  const h = clamp(scale.headLag, 0, 2)
  const a = clamp(scale.arm, 0, 2)

  // ① 呼吸：胸/肩 1–1.5°（远景可见），颈略微滞后。
  addDeg(out, '上半身', 1.2 * b * breath, 0, 0)
  addDeg(out, '上半身2', 1.5 * b * breath2, 0, 0)
  addDeg(out, '左肩', 0, 0, 1.2 * b * Math.sin(TAU * FREQ_BREATH * t + 0.4))
  addDeg(out, '右肩', 0, 0, -1.2 * b * Math.sin(TAU * FREQ_BREATH * t + 0.4))
  addDeg(out, '首', -1.1 * h * Math.sin(TAU * FREQ_BREATH * t - 0.6), 0, 0.7 * h * sway2)

  // ② 重心摆动（快层）+ 慢层承重脚（weightShift，8–15s 换一次）。
  const shiftRoll = shift * 2.4
  addDeg(
    out,
    '下半身',
    0.5 * s * sway2,
    2.2 * s * weight + shift * 1.6,
    3.0 * s * sway - shiftRoll
  )
  addDeg(out, '上半身', 0.4 * s * sway2, -1.6 * s * weight - shift * 1.0, -2.2 * s * sway + shiftRoll * 0.8)
  addDeg(out, '上半身2', 0, 0.9 * s * weight, -0.9 * s * sway)

  // ③ 头/颈延迟跟随（比躯干滞后 0.5–1.0 rad；再叠慢层重心反向，头部保持水平感）。
  addDeg(
    out,
    '頭',
    -1.0 * h * Math.sin(TAU * FREQ_BREATH * t - 1.0),
    2.4 * h * Math.sin(TAU * FREQ_SWAY * t - 0.5) + shift * 1.4,
    -2.2 * h * Math.sin(TAU * FREQ_SWAY * t - 0.9) - shiftRoll * 0.9
  )
  addDeg(out, '首', 0, 0.8 * h * Math.sin(TAU * FREQ_SWAY * t - 0.75), 0.9 * h * Math.sin(TAU * FREQ_SWAY * t - 0.75))

  // ④ 手臂/手腕 follow-through（大臂跟随躯干、肘/腕再慢半拍；左右相位错开 = 不对称）。
  const armPhase = TAU * FREQ_SWAY * t - 0.8
  addDeg(out, '左腕', 1.3 * a * Math.sin(armPhase + 0.35), 0, 1.8 * a * sway2)
  addDeg(out, '右腕', 1.3 * a * Math.sin(armPhase - 0.15), 0, -1.8 * a * sway2)
  addDeg(out, '左ひじ', 1.7 * a * Math.sin(armPhase - 0.6), 0, 0.9 * a * sway)
  addDeg(out, '右ひじ', 1.7 * a * Math.sin(armPhase - 0.9), 0, -0.9 * a * sway)

  // ⑤ 手：静态半握 + 手腕微动 + 手指微小收放（幅度小，叠加在静态弯曲上）。
  const fingerScale = clamp(scale.finger, 0, 2)
  applyRelaxedHands(out, fingerScale, options.fingerCurlExtraDeg ?? 0)
  const w = 1.1 * a
  addDeg(out, '左手首', w * Math.sin(TAU * FREQ_BREATH * t - 1.3), 0, 0.8 * a * weight)
  addDeg(out, '右手首', w * Math.sin(TAU * FREQ_BREATH * t - 1.7), 0, -0.8 * a * weight)
  if (options.withFingers !== false) {
    const f = 1.2 * fingerScale
    const curl = f * (0.5 + 0.5 * finger)
    const curlSlow = f * (0.5 + 0.5 * Math.sin(TAU * FREQ_FINGER * t + 1.1))
    // 手指微动 = 绕 Z 的微小变化（与静态弯曲同轴，不改变手势方向）。
    addDeg(out, '左人指２', 0, 0, curl)
    addDeg(out, '左中指２', 0, 0, curlSlow)
    addDeg(out, '左小指２', 0, 0, curlSlow * 0.8)
    addDeg(out, '右人指２', 0, 0, -curlSlow)
    addDeg(out, '右中指２', 0, 0, -curl)
    addDeg(out, '右小指２', 0, 0, -curl * 0.7)
  }
  return out
}

/**
 * 极慢的头部漂移（无 look-at 目标时叠加：人不会一直盯着正前方）。
 * v3 幅度加到 ≤4°（远景可读），两个不可通约频率（0.06/0.043Hz）。
 */
export function computeIdleHeadDrift(timeSec: number, scale = 1): Record<string, EulerDeg> {
  const t = timeSec
  const drift = Math.sin(TAU * 0.06 * t + 0.4)
  const drift2 = Math.sin(TAU * 0.043 * t + 1.7)
  const amt = clamp(scale, 0, 2)
  return {
    首: { x: 0.7 * amt * drift2, y: 2.0 * amt * drift, z: 0.8 * amt * drift },
    頭: { x: 0.8 * amt * drift, y: 3.0 * amt * drift2, z: 1.2 * amt * drift }
  }
}
