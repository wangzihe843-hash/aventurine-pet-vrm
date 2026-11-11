/**
 * VRM 躯干宽高比（`bodyAspectRatio`）估算 —— 纯函数模块（**不 import three/DOM**，Node 可直测）。
 *
 * 用途：`PetView.modelAspectRatio` → `model/layout.ts` 的 `computePetRect()` 用「身高 × 宽高比」
 * 推出宠物矩形宽度，进而决定**命中区宽度/物理半宽**。因此这里要的是**躯干宽/身高**，
 * 不是 T-pose 臂展（VRM T-pose 的 rest 包围盒含水平手臂，直接拿 bbox 宽会把命中区撑到两倍）。
 *
 * 估算公式（`docs/wave2-vrm-runtime-design.md` §4.1，以 normalized rest 骨世界坐标为准）：
 * ```
 * width ≈ max(|L upperArm.x − R upperArm.x|, 2 × |hips.x − L upperLeg.x| × 1.6) + 0.08 × height
 * aspect = width / height，再 clamp 到 [0.30, 0.90]
 * ```
 * - 肩骨（upperArm 关节点）间距 ≈ 肩宽，是躯干宽的主来源；
 * - 髋骨到左大腿根的距离 ×2×1.6 ≈ 骨盆/裙摆宽度，弯腰/侧身时比肩宽更接近可见轮廓；
 * - `0.08 × height` 是手臂贴体/衣装外扩的软组织补偿（设计文档给定的经验项）；
 * - 数据异常（非有限数、宽 > 身高、缺失）时忽略对应来源；全部缺失时退回固定兜底值。
 *
 * 约定：输入只是**归一化 rest 姿势**的绕 Y 轴世界 x 坐标（米，VRM1 约定左手 +X；VRM0 经
 * `VRMUtils.rotateVRM0` 后同理）；本模块不做 three 计算，由 `avatar-loader.ts` 取骨世界坐标后传入。
 */

/** 躯干宽高比下限（过窄会让命中区/物理半宽过小、贴边时抖动）。 */
export const MIN_BODY_ASPECT_RATIO = 0.3
/** 躯干宽高比上限（超过即视为异常数据；T-pose 臂展宽高比通常 > 1）。 */
export const MAX_BODY_ASPECT_RATIO = 0.9

/**
 * 骨数据全部缺失/异常时的兜底躯干宽高比。
 * 成人直立躯干宽/身高约 0.35–0.45（肩宽 ~0.42m / 身高 ~1.7m，再加衣装外扩），取 0.42 居中；
 * 与 PMX 路径的 `FALLBACK_MODEL_ASPECT = 0.7373`（A-pose 包围盒）语义不同，不要混用。
 */
export const FALLBACK_BODY_ASPECT_RATIO = 0.42

/** 髋宽放大系数（髋中心到单侧大腿根的 ±x 偏移 ×2 得到骨盆宽，再按衣装/腿部外扩放大）。 */
export const HIPS_WIDTH_FACTOR = 1.6

/** 软组织/衣装补偿：按身高的固定比例加到躯干宽上（设计文档 §4.1 的 0.08×height）。 */
export const SHOULDER_SOFT_MARGIN_RATIO = 0.08

/**
 * 单项宽度数据合理性上限（相对身高）：肩宽/髋宽不可能比身高还宽。
 * 超过说明骨世界坐标异常（缩放错误/父子层级错乱），该项忽略，避免把命中区算成巨型矩形。
 */
export const MAX_SPAN_TO_HEIGHT_RATIO = 1.0

/** 估算数据来源（调试/单测断言用）。 */
export type BodyAspectRatioSource = 'shoulders+hips' | 'shoulders' | 'hips' | 'fallback'

/** `estimateBodyAspectRatio` 的输入（全部为 normalized rest 姿势的绕 Y 轴世界 x 坐标，单位米）。 */
export interface BodyAspectRatioInput {
  /** rest 包围盒高度（米；非法值 → fallback）。 */
  heightMeters: number
  /** 左 upperArm（肩关节）世界 x；缺失/非法 = null。 */
  leftUpperArmX?: number | null
  /** 右 upperArm（肩关节）世界 x；缺失/非法 = null。 */
  rightUpperArmX?: number | null
  /** hips 世界 x；缺失/非法 = null。 */
  hipsX?: number | null
  /** 左 upperLeg（大腿根）世界 x；缺失/非法 = null。 */
  leftUpperLegX?: number | null
}

/** `estimateBodyAspectRatio` 的结果。 */
export interface BodyAspectRatioResult {
  /** 最终躯干宽高比（已 clamp 到 [0.30, 0.90]）。 */
  ratio: number
  /** 数据来源。 */
  source: BodyAspectRatioSource
  /** 是否发生过 clamp（true = 原始估算值越界，改用边界值）。 */
  clamped: boolean
  /** 估算的躯干宽（米；fallback 时为 null；clamped 时仍是未 clamp 的原始估算宽）。 */
  torsoWidthMeters: number | null
}

/** 读取有限数；null/undefined/NaN/Infinity 一律返回 null。 */
function readFinite(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/** 把任意数值 clamp 到躯干宽高比合法区间；非有限数退回兜底值。 */
export function clampBodyAspectRatio(value: number): number {
  if (!Number.isFinite(value)) return FALLBACK_BODY_ASPECT_RATIO
  return Math.min(MAX_BODY_ASPECT_RATIO, Math.max(MIN_BODY_ASPECT_RATIO, value))
}

/** 构造「数据不可用」的兜底结果。 */
function fallbackResult(): BodyAspectRatioResult {
  return {
    ratio: FALLBACK_BODY_ASPECT_RATIO,
    source: 'fallback',
    clamped: false,
    torsoWidthMeters: null
  }
}

/**
 * 用 normalized rest 的肩/髋骨世界坐标估算躯干宽高比。
 *
 * 边界行为（单测覆盖）：
 * - `heightMeters` 非有限/≤0 → `fallback`（0.42）；
 * - 只有肩骨 → 仅用肩宽；只有髋/腿骨 → 仅用髋宽×2×1.6；
 * - 两者都缺失/异常 → `fallback`；
 * - 单项宽度 > 1.0 × 身高（骨数据异常）→ 忽略该项；
 * - 原始比值越界 → clamp 到 [0.30, 0.90]，`clamped = true`（`torsoWidthMeters` 保留原始宽）。
 */
export function estimateBodyAspectRatio(input: BodyAspectRatioInput): BodyAspectRatioResult {
  const height = readFinite(input.heightMeters)
  if (height === null || height <= 0) return fallbackResult()
  const maxSpan = height * MAX_SPAN_TO_HEIGHT_RATIO

  // 肩宽：左右 upperArm 关节点间距。
  const leftUpperArmX = readFinite(input.leftUpperArmX)
  const rightUpperArmX = readFinite(input.rightUpperArmX)
  const shoulderSpanRaw =
    leftUpperArmX !== null && rightUpperArmX !== null
      ? Math.abs(leftUpperArmX - rightUpperArmX)
      : null
  const shoulderSpan =
    shoulderSpanRaw !== null && shoulderSpanRaw > 0 && shoulderSpanRaw <= maxSpan
      ? shoulderSpanRaw
      : null

  // 髋宽：髋中心到左大腿根偏移 ×2 × HIPS_WIDTH_FACTOR（裙摆/腿部外扩经验系数）。
  const hipsX = readFinite(input.hipsX)
  const leftUpperLegX = readFinite(input.leftUpperLegX)
  const hipsHalfSpanRaw = hipsX !== null && leftUpperLegX !== null ? Math.abs(hipsX - leftUpperLegX) : null
  const hipsSpanRaw = hipsHalfSpanRaw !== null ? hipsHalfSpanRaw * 2 * HIPS_WIDTH_FACTOR : null
  const hipsSpan = hipsSpanRaw !== null && hipsSpanRaw > 0 && hipsSpanRaw <= maxSpan ? hipsSpanRaw : null

  const baseWidth = Math.max(shoulderSpan ?? 0, hipsSpan ?? 0)
  if (baseWidth <= 0) return fallbackResult()

  const torsoWidthMeters = baseWidth + height * SHOULDER_SOFT_MARGIN_RATIO
  const rawRatio = torsoWidthMeters / height
  const ratio = clampBodyAspectRatio(rawRatio)
  const source: BodyAspectRatioSource =
    shoulderSpan !== null && hipsSpan !== null
      ? 'shoulders+hips'
      : shoulderSpan !== null
        ? 'shoulders'
        : 'hips'

  return {
    ratio,
    source,
    clamped: ratio !== rawRatio,
    torsoWidthMeters
  }
}
