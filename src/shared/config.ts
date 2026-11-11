/**
 * 冻结共享契约 —— 配置默认值、限制与纯函数清洗（M0-2）
 *
 * 规则：
 * - 环境中立纯 TS，禁止 import electron / node: 内置模块 / 第三方运行时依赖。
 * - `sanitizeConfig` 是纯函数：接收任意 unknown（本地配置 JSON、IPC 输入），
 *   做类型校验 + 数值钳制 + 枚举校验 + 缺省回填，未知键丢弃，返回完整 `PetConfig`。
 *   A3（配置持久化）与 A6（单测）会复用它，行为变更需走契约评审。
 */
import { DEFAULT_MOTION_SET_ID, MOTION_SET_ID_MAX_LENGTH } from './animation-contract'
import {
  ANIMATION_BACKENDS,
  MODEL_BACKENDS,
  type AnimationBackend,
  type AutonomousLevel,
  type ModelBackend,
  type PetConfig,
  type PetPosition
} from './types'

/** 配置 schema 版本；A3 持久化时写入，后续不兼容变更时递增。 */
export const CONFIG_VERSION = 1

/** 数值配置项的合法范围（闭区间）。 */
export const CONFIG_LIMITS = {
  sizePercent: { min: 10, max: 100 },
  opacity: { min: 0.3, max: 1 },
  fpsCap: { min: 5, max: 60 }
} as const

/**
 * 全部配置项的默认值（§8 冻结）。
 * sizePercent 默认 50（用户 2026-11-07 确认，近景模式；原定 30），可在 10–100 调整；
 * 100% 时受 overlay 窗口高度（display.workArea）限制，实际见 renderer/model/layout.ts。
 */
export const DEFAULT_CONFIG: PetConfig = {
  sizePercent: 50,
  opacity: 1,
  clickThrough: true,
  autonomous: true,
  autonomousLevel: 'normal',
  mischief: true,
  dshLink: true,
  // Wave 3（2026-11-11，用户决策）：与 DSH 双向保活/强耦合 + 头顶气泡同步 DSH 回复。
  // 均可选：旧 config.json 缺这两个键时自动回填 true（不 bump CONFIG_VERSION）。
  dshCoupling: true,
  dshBubbleSync: true,
  fpsCap: 30,
  launchAtLogin: false,
  position: 'corner',
  sound: false,
  // W0-3：Phase 3 默认走 VRM 路径；可用 `PET_MODEL_BACKEND=legacy-pmx` /
  // `PET_ANIM_BACKEND=legacy-pmx` 环境变量（或设置项）随时回退 v1 实现（PLAN D4）。
  modelBackend: 'vrm',
  animBackend: 'vrm',
  motionSet: DEFAULT_MOTION_SET_ID
}

const AUTONOMOUS_LEVELS: readonly AutonomousLevel[] = ['low', 'normal', 'high']
const PET_POSITIONS: readonly PetPosition[] = ['corner', 'free']
const MODEL_BACKEND_VALUES: readonly ModelBackend[] = MODEL_BACKENDS
const ANIMATION_BACKEND_VALUES: readonly AnimationBackend[] = ANIMATION_BACKENDS

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * 只读取对象**自有属性**。
 * 配置来源是 JSON 文件（`JSON.parse` 只产生自有属性）与 IPC structured clone（同样只产生
 * 自有属性）；继承属性/原型链注入的值一律忽略并回退默认值，避免 `Object.create({...})`
 * 这类输入绕过默认值（独立复验 LOW-7 覆盖缺口）。
 */
function readOwn(input: Record<string, unknown>, key: keyof PetConfig): unknown {
  return Object.prototype.hasOwnProperty.call(input, key) ? input[key] : undefined
}

/** 读取数值并钳制到 [min, max]；非 number / NaN / Infinity 时回退默认值。 */
function readClampedNumber(
  input: Record<string, unknown>,
  key: keyof PetConfig,
  fallback: number,
  min: number,
  max: number
): number {
  const value = readOwn(input, key)
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  if (value < min) return min
  if (value > max) return max
  return value
}

/** 读取布尔值；非 boolean 时回退默认值。 */
function readBoolean(
  input: Record<string, unknown>,
  key: keyof PetConfig,
  fallback: boolean
): boolean {
  const value = readOwn(input, key)
  return typeof value === 'boolean' ? value : fallback
}

/** 读取字符串枚举；不在白名单内时回退默认值。 */
function readEnum<T extends string>(
  input: Record<string, unknown>,
  key: keyof PetConfig,
  allowed: readonly T[],
  fallback: T
): T {
  const value = readOwn(input, key)
  if (typeof value === 'string' && (allowed as readonly string[]).includes(value)) {
    return value as T
  }
  return fallback
}

/**
 * 动作集 id 的合法字符集：`[A-Za-z0-9._-]`。
 * 动作集会被拼接为 `assets/motions/<id>/` 目录名，因此必须拒绝路径分隔符/`..`/空白，
 * 把路径穿越挡在契约层（渲染层还会再做一次白名单校验）。首字符不允许 `.`（隐藏目录）。
 */
const MOTION_SET_ID_PATTERN = /^[A-Za-z0-9_-][A-Za-z0-9._-]*$/

/**
 * 读取动作集 id：trim 后必须非空、长度 ≤ `MOTION_SET_ID_MAX_LENGTH`、匹配
 * `MOTION_SET_ID_PATTERN`；否则回退默认值（`default`）。非法输入不抛异常。
 */
function readMotionSetId(
  input: Record<string, unknown>,
  key: keyof PetConfig,
  fallback: string
): string {
  const value = readOwn(input, key)
  if (typeof value !== 'string') return fallback
  const trimmed = value.trim()
  if (trimmed.length === 0 || trimmed.length > MOTION_SET_ID_MAX_LENGTH) return fallback
  return MOTION_SET_ID_PATTERN.test(trimmed) ? trimmed : fallback
}

/**
 * 清洗配置：从可能脏/不完整的输入构造一份完整合法配置。
 * - 缺省键回填 `DEFAULT_CONFIG`
 * - 数值越界钳制到 `CONFIG_LIMITS`
 * - 枚举非法回退默认值
 * - 未知键丢弃（不会透传到持久化文件）
 * - 只读取自有属性：继承属性 / 原型链注入的值忽略（`Object.create({sizePercent:99})` 等价空对象）
 * - 对 JSON 可表示的输入（object/array/null/基本类型）不抛异常；
 *   不防御"抛错 getter / Proxy"这类恶意对象（配置来源是本机 userData 的 JSON 文件与 IPC 输入）
 */
export function sanitizeConfig(input: unknown): PetConfig {
  const source = isRecord(input) ? input : {}

  return {
    sizePercent: readClampedNumber(
      source,
      'sizePercent',
      DEFAULT_CONFIG.sizePercent,
      CONFIG_LIMITS.sizePercent.min,
      CONFIG_LIMITS.sizePercent.max
    ),
    opacity: readClampedNumber(
      source,
      'opacity',
      DEFAULT_CONFIG.opacity,
      CONFIG_LIMITS.opacity.min,
      CONFIG_LIMITS.opacity.max
    ),
    clickThrough: readBoolean(source, 'clickThrough', DEFAULT_CONFIG.clickThrough),
    autonomous: readBoolean(source, 'autonomous', DEFAULT_CONFIG.autonomous),
    autonomousLevel: readEnum(
      source,
      'autonomousLevel',
      AUTONOMOUS_LEVELS,
      DEFAULT_CONFIG.autonomousLevel
    ),
    mischief: readBoolean(source, 'mischief', DEFAULT_CONFIG.mischief),
    dshLink: readBoolean(source, 'dshLink', DEFAULT_CONFIG.dshLink),
    // Wave 3 新增（可选键：旧 config.json 没有这两项时自动回填 true）
    dshCoupling: readBoolean(source, 'dshCoupling', DEFAULT_CONFIG.dshCoupling === true),
    dshBubbleSync: readBoolean(source, 'dshBubbleSync', DEFAULT_CONFIG.dshBubbleSync === true),
    fpsCap: readClampedNumber(
      source,
      'fpsCap',
      DEFAULT_CONFIG.fpsCap,
      CONFIG_LIMITS.fpsCap.min,
      CONFIG_LIMITS.fpsCap.max
    ),
    launchAtLogin: readBoolean(source, 'launchAtLogin', DEFAULT_CONFIG.launchAtLogin),
    position: readEnum(source, 'position', PET_POSITIONS, DEFAULT_CONFIG.position),
    sound: readBoolean(source, 'sound', DEFAULT_CONFIG.sound),
    // W0-3 新增（可选键：旧版 config.json 没有这三项时自动回填默认值，无需 bump CONFIG_VERSION）
    modelBackend: readEnum(
      source,
      'modelBackend',
      MODEL_BACKEND_VALUES,
      DEFAULT_CONFIG.modelBackend
    ),
    animBackend: readEnum(
      source,
      'animBackend',
      ANIMATION_BACKEND_VALUES,
      DEFAULT_CONFIG.animBackend
    ),
    motionSet: readMotionSetId(source, 'motionSet', DEFAULT_CONFIG.motionSet)
  }
}
