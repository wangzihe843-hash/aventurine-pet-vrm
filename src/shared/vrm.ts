/**
 * 冻结共享契约 —— VRM 模型资产（W0-3）
 *
 * 本文件定义 Phase 3 VRM 路线的**模型侧契约**：humanoid 骨骼名、表情预设、avatar 资产描述、
 * avatar manifest（`src/shared/vrm-manifest.json`）与清洗规则、模型后端 flag 的解析规则。
 *
 * 规则（与 `src/shared/types.ts` 相同）：
 * - 环境中立纯 TS：不得 import `electron` / `node:*` / `three` / 任何第三方运行时依赖。
 *   本文件同时被 `tsconfig.node.json` 与 `tsconfig.web.json` 检查，并会被打包进 main/preload/renderer。
 * - **冻结后不得擅改**：新增/修改字段、枚举、默认值都属于契约变更，必须走 Lead 评审
 *   （PLAN §7/§8/§13）。实现方可以新增自己模块内的私有类型，但不得改本文件的既有语义。
 * - 只描述数据形状与纯函数清洗，不 import three.js 类型：three-vrm 的运行时对象
 *   （VRM / VRMHumanoid / VRMExpressionManager 等）由 `src/renderer/src/vrm/**` 负责。
 *
 * 坐标/单位约定（W0-4 实测 + 后续 Wave 统一）：
 * - 高度单位 = 米（three.js 世界单位，VRM 规范；模型 Y-up）；
 * - `heightMeters` 是**绑定姿势包围盒高度**，用于 layout/physics 的比例换算，不是屏幕像素；
 * - `yawOffsetDeg` 是模型朝向修正：VRM 规范约定模型面向 +Z（VRM0 由 three-vrm 的
 *   `VRMUtils.rotateVRM0` 转到同一约定）；若实测某资产朝向反了（面向 -Z），在 manifest 填 180。
 *
 * 相关契约：`src/shared/animation-contract.ts`（动作/clip）、`src/shared/config.ts`
 * （`modelBackend` / `animBackend` / `motionSet` 配置项）、`docs/vrm-contract.md`（冻结说明）。
 */
import {
  MODEL_BACKENDS,
  type ModelBackend,
  type SanitizeResult
} from './types'

/** 重新导出基础类型/常量，便于使用方只 import 本模块。 */
export type { ModelBackend } from './types'
export { MODEL_BACKENDS } from './types'

/** avatar manifest 的 schema 版本（不兼容变更时递增）。 */
export const VRM_MANIFEST_SCHEMA_VERSION = 1

/** 模型后端环境变量名；值 `vrm` / `legacy-pmx`（优先级：env > 配置 > 默认 vrm）。 */
export const MODEL_BACKEND_ENV = 'PET_MODEL_BACKEND'

/* -------------------------------------------------------------------------- */
/* humanoid 骨骼                                                               */
/* -------------------------------------------------------------------------- */

/**
 * VRM 1.0 humanoid 标准骨骼名全集（55 个，three-vrm 会把 VRM 0.x 的骨名归一化到这套名字）。
 * 顺序 = VRM 1.0 规范顺序（躯干/眼/颌/腿/肩臂手/手指）。
 */
export const HUMANOID_BONES = [
  'hips',
  'spine',
  'chest',
  'upperChest',
  'neck',
  'head',
  'leftEye',
  'rightEye',
  'jaw',
  'leftUpperLeg',
  'leftLowerLeg',
  'leftFoot',
  'leftToes',
  'rightUpperLeg',
  'rightLowerLeg',
  'rightFoot',
  'rightToes',
  'leftShoulder',
  'leftUpperArm',
  'leftLowerArm',
  'leftHand',
  'rightShoulder',
  'rightUpperArm',
  'rightLowerArm',
  'rightHand',
  'leftThumbMetacarpal',
  'leftThumbProximal',
  'leftThumbDistal',
  'leftIndexProximal',
  'leftIndexIntermediate',
  'leftIndexDistal',
  'leftMiddleProximal',
  'leftMiddleIntermediate',
  'leftMiddleDistal',
  'leftRingProximal',
  'leftRingIntermediate',
  'leftRingDistal',
  'leftLittleProximal',
  'leftLittleIntermediate',
  'leftLittleDistal',
  'rightThumbMetacarpal',
  'rightThumbProximal',
  'rightThumbDistal',
  'rightIndexProximal',
  'rightIndexIntermediate',
  'rightIndexDistal',
  'rightMiddleProximal',
  'rightMiddleIntermediate',
  'rightMiddleDistal',
  'rightRingProximal',
  'rightRingIntermediate',
  'rightRingDistal',
  'rightLittleProximal',
  'rightLittleIntermediate',
  'rightLittleDistal'
] as const

/** humanoid 标准骨骼名（VRM 1.0 命名，three-vrm 归一化后的名字）。 */
export type HumanoidBone = (typeof HUMANOID_BONES)[number]

/**
 * VRM 规范要求**必须存在**的核心人形骨（缺任一即视为模型不可用/需人工修正映射）。
 * 眼/颌/手指/趾为可选骨（V1/V5/V6 按需使用；缺失不算错误）。
 */
export const VRM_REQUIRED_HUMANOID_BONES = [
  'hips',
  'spine',
  'head',
  'leftUpperArm',
  'leftLowerArm',
  'leftHand',
  'rightUpperArm',
  'rightLowerArm',
  'rightHand',
  'leftUpperLeg',
  'leftLowerLeg',
  'leftFoot',
  'rightUpperLeg',
  'rightLowerLeg',
  'rightFoot'
] as const satisfies readonly HumanoidBone[]

/* -------------------------------------------------------------------------- */
/* 表情                                                                        */
/* -------------------------------------------------------------------------- */

/**
 * VRM 1.0 expression preset 全集（18 个；VRM 0.x 的 `joy/blink_l/...` 由 three-vrm 归一化）。
 * 仅作为「资产里实际存在哪些 preset」的运行时清单/诊断用；应用语义见 `PET_EXPRESSIONS`。
 */
export const VRM_EXPRESSION_PRESETS = [
  'happy',
  'angry',
  'sad',
  'relaxed',
  'surprised',
  'aa',
  'ih',
  'ou',
  'ee',
  'oh',
  'blink',
  'blinkLeft',
  'blinkRight',
  'lookUp',
  'lookDown',
  'lookLeft',
  'lookRight',
  'neutral'
] as const

/** VRM 1.0 expression preset 名。 */
export type VrmExpressionPreset = (typeof VRM_EXPRESSION_PRESETS)[number]

/**
 * 桌宠业务语义的表情名（V1/V6 用这套名字驱动；具体映射到 VRM expression 名由 manifest 的
 * `expressions` 字段决定——preset 名通常同名，自定义 expression 可映射成任意名字）。
 * `lookAtX/lookAtY` 不在这里：注视方向走 `lookAt` 配置/骨骼驱动，不占用 expression 通道。
 */
export const PET_EXPRESSIONS = [
  'blink',
  'blinkLeft',
  'blinkRight',
  'happy',
  'sad',
  'angry',
  'relaxed',
  'surprised',
  'neutral'
] as const

/** 桌宠业务语义表情名。 */
export type PetExpression = (typeof PET_EXPRESSIONS)[number]

/** 业务表情 → VRM expression 名（preset 或自定义）；缺键 = 该表情不可用（调用方跳过）。 */
export type VrmExpressionBindings = Partial<Record<PetExpression, string>>

/* -------------------------------------------------------------------------- */
/* 资产描述                                                                    */
/* -------------------------------------------------------------------------- */

/** VRM 规范版本（VRM 0.x 资产由 three-vrm 兼容层加载，行为与 1.0 对齐）。 */
export const VRM_AVATAR_SPEC_VERSIONS = ['0.x', '1.0'] as const
export type VrmAvatarSpecVersion = (typeof VRM_AVATAR_SPEC_VERSIONS)[number]

/**
 * 注视实现方式：
 * - `vrm`：模型带 `VRMC_vrm.lookAt` 扩展，直接用 three-vrm 的 lookAt（最省事）
 * - `procedural`：无 lookAt 扩展，由渲染层驱动 head/eye 骨旋转（W0 实测两个现有资产都属此类）
 * - `none`：关闭注视
 */
export const VRM_LOOK_AT_MODES = ['vrm', 'procedural', 'none'] as const
export type VrmLookAtMode = (typeof VRM_LOOK_AT_MODES)[number]

/** 注视参数（骨骼/VRM lookAt 的角度上限；单位：度）。 */
export interface VrmLookAtConfig {
  mode: VrmLookAtMode
  /** 左右最大偏航角（0–90，默认 35）；`procedural` 模式的头部旋转上限。 */
  maxYawDeg: number
  /** 上下最大俯仰角（0–90，默认 20）。 */
  maxPitchDeg: number
}

/** 注视默认值：procedural + 35°/20°（W0 实测两个资产均无 VRM lookAt）。 */
export const DEFAULT_VRM_LOOK_AT: VrmLookAtConfig = {
  mode: 'procedural',
  maxYawDeg: 35,
  maxPitchDeg: 20
}

/** 归一化后的 avatar 资产（manifest 清洗产物；所有字段必有值，可直接消费）。 */
export interface VrmAvatarAsset {
  /** 稳定 id（如 `aventurine-waveflair` / `canary-outfit`；manifest 内唯一）。 */
  id: string
  /**
   * 资产引用：**assets 根相对路径**（POSIX，如 `vrm/aventurine.vrm`），
   * 或已经构造好的 `pet-asset://<host>/<path>` URL。loader 负责转成可 fetch 的 URL。
   */
  file: string
  /** 规范版本（元数据；实际加载以文件自身为准，three-vrm 自动识别）。 */
  specVersion: VrmAvatarSpecVersion
  /** 绑定姿势包围盒高度（米），用于 layout/physics 比例换算。 */
  heightMeters: number
  /** 非标准/generic 骨需要显式映射时填（VRM standard 骨无需写）。 */
  humanoid: Partial<Record<HumanoidBone, string>>
  /** 业务表情 → VRM expression 名映射（缺键 = 不可用）。 */
  expressions: VrmExpressionBindings
  /** 注视实现参数。 */
  lookAt: VrmLookAtConfig
  /** spring bone 链数量（0 = 资产没有 spring；V6 决定是否自研/Blender 补链）。 */
  springChains: number
  /** 朝向修正（绕 Y 轴度数；0 = 按 VRM 规范面向 +Z）。 */
  yawOffsetDeg: number
  /** 缩略图资产引用（可选，assets 相对路径或 pet-asset URL）。 */
  thumbnail: string | null
  /** 备注（作者/来源/限制/待办；最多 500 字符，供排障与文档用）。 */
  notes: string
}

/**
 * manifest 中手写的 avatar 条目（JSON 里的形状；除 id/file 外可省略，清洗时回填默认值）。
 * 用于 `src/shared/vrm-manifest.json` 的类型标注与本地自定义 manifest。
 */
export interface VrmAvatarAssetInput {
  id: string
  file: string
  specVersion?: VrmAvatarSpecVersion
  heightMeters?: number
  humanoid?: Partial<Record<HumanoidBone, string>>
  expressions?: VrmExpressionBindings
  lookAt?: Partial<VrmLookAtConfig>
  springChains?: number
  yawOffsetDeg?: number
  thumbnail?: string | null
  notes?: string
}

/** 归一化 avatar manifest（`sanitizeVrmAssetManifest` 的输出，运行期直接消费）。 */
export interface VrmAssetManifest {
  schemaVersion: 1
  /** 默认 avatar id；空串表示没有可用 avatar（走 legacy 回退）。 */
  defaultAvatarId: string
  avatars: VrmAvatarAsset[]
}

/** manifest 文件（JSON）的输入形状。 */
export interface VrmAssetManifestInput {
  schemaVersion: 1
  defaultAvatarId?: string
  avatars?: VrmAvatarAssetInput[]
}

/** 空 manifest（无资产时的安全缺省；调用方应回退 legacy/程序化路径）。 */
export const EMPTY_VRM_ASSET_MANIFEST: VrmAssetManifest = {
  schemaVersion: VRM_MANIFEST_SCHEMA_VERSION,
  defaultAvatarId: '',
  avatars: []
}

/**
 * 已知 avatar id（PLAN §8 约定；manifest 里可以出现更多本地 id，但这几个是代码里会被
 * 直接引用的稳定名字，改名前需评审）。
 */
export const KNOWN_AVATAR_IDS = {
  aventurine: 'aventurine-waveflair',
  canary: 'canary-outfit'
} as const

/** 已知 avatar id 联合类型。 */
export type KnownAvatarId = (typeof KNOWN_AVATAR_IDS)[keyof typeof KNOWN_AVATAR_IDS]

/**
 * 实测到的 VRM 内建 lookAt 能力（V1 task-2 追加，Lead 2026-11-08 明确要求；纯追加、可选字段，
 * 旧消费方可忽略。用途：V6 look-at 层判断能否用 three-vrm 内建 applier 驱动眼球，
 * 以及调试面/冒烟确认模型确实带 `VRMC_vrm.lookAt`）。
 */
export interface VrmLookAtCapability {
  /** 是否带 `VRMC_vrm.lookAt` 扩展（three-vrm 加载后 `vrm.lookAt` 非空）。 */
  present: boolean
  /** 注视驱动类型：`bone` = 驱动眼球骨旋转；`expression` = 驱动 expression 权重；null = 无。 */
  type: 'bone' | 'expression' | null
  /** applier 类名（如 `VRMLookAtBoneApplier` / `VRMLookAtExpressionApplier`；null = 无）。 */
  applier: string | null
  /** 相对 head 骨的注视原点偏移（米，[x,y,z]；null = 无内建 lookAt）。 */
  offsetFromHeadBone: readonly [number, number, number] | null
}

/**
 * 加载后实测的资产能力（V1 loader 填充，供调试面板/验收脚本/后续行为层判断）。
 * 纯数据（不含 three 类型），因此可以放在 shared。
 */
export interface VrmAvatarCapabilities {
  specVersion: VrmAvatarSpecVersion
  /** 实际存在的 humanoid 骨（VRM 1.0 标准名，已归一化）。 */
  humanoidBones: readonly HumanoidBone[]
  /** 缺失的规范必需骨（空数组 = 模型人形骨完整）。 */
  missingRequiredBones: readonly HumanoidBone[]
  /** 实际存在的 expression preset 名（含自定义 expression 时由 loader 另行扩展）。 */
  expressions: readonly VrmExpressionPreset[]
  /** spring bone joint 总数（0 = 无 spring）。 */
  springBoneCount: number
  /** 是否带 `VRMC_vrm.lookAt` 扩展（等价于 `lookAt.present`；保留旧字段兼容）。 */
  hasLookAt: boolean
  /**
   * 实测内建 lookAt 详情（V1 task-2 追加，可选：旧代码/旧资产可能没有）。
   * `present=false` 时 type/applier/offsetFromHeadBone 均为 null。
   */
  lookAt?: VrmLookAtCapability
  /** 文件内嵌 animation clip 名（VRM 通常为空；VRMA 走 motion manifest）。 */
  animationNames: readonly string[]
  /** 绑定姿势包围盒高度（米）。 */
  heightMeters: number
}

/* -------------------------------------------------------------------------- */
/* 资产引用 / 后端 flag 的纯函数校验                                             */
/* -------------------------------------------------------------------------- */

/** `pet-asset://<host>/<path>` URL 的宽松白名单（host 为小写字母开头的 kebab 段）。 */
const PET_ASSET_URL_PATTERN = /^pet-asset:\/\/[a-z][a-z0-9-]*\/[^\s?#]+$/i

/** 资产引用最大长度（防御异常长字符串）。 */
const MAX_ASSET_REFERENCE_LENGTH = 512

/**
 * 校验资产引用（`VrmAvatarAsset.file` / `AnimationClipEntry.file` / `thumbnail` 共用）：
 * - 允许 `pet-asset://<host>/<path>`（host 非空、path 非空、无空白/查询串）；
 * - 允许 **assets 根相对路径**（POSIX）：不能以 `/` 开头、不能含 `..`/`.`/空段、
 *   不能含反斜杠/NUL/控制字符/`:`/`://`；
 * - 其余一律非法（防目录穿越/绝对路径注入）。
 *
 * 注意：这里只做**字符串级**校验；真正的路径安全边界由 `pet-asset://` handler
 * （`src/main/protocol*.ts`，realpath + O_NOFOLLOW）负责，二者是纵深防御关系。
 */
export function isSafeAssetReference(file: unknown): file is string {
  if (typeof file !== 'string') return false
  const value = file.trim()
  if (value.length === 0 || value.length > MAX_ASSET_REFERENCE_LENGTH) return false
  // 控制字符 / NUL / 反斜杠（路径分隔符歧义）一律拒绝。
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f\\]/.test(value)) return false
  if (value.startsWith('pet-asset://')) return PET_ASSET_URL_PATTERN.test(value)
  if (value.startsWith('/') || value.includes('://') || value.includes(':')) return false
  const segments = value.split('/')
  for (const segment of segments) {
    if (segment.length === 0 || segment === '.' || segment === '..') return false
  }
  return true
}

/** 是否为合法 humanoid 骨名。 */
export function isHumanoidBone(value: unknown): value is HumanoidBone {
  return typeof value === 'string' && (HUMANOID_BONES as readonly string[]).includes(value)
}

/** 是否为合法业务表情名。 */
export function isPetExpression(value: unknown): value is PetExpression {
  return typeof value === 'string' && (PET_EXPRESSIONS as readonly string[]).includes(value)
}

/** 是否为合法 VRM expression preset 名。 */
export function isVrmExpressionPreset(value: unknown): value is VrmExpressionPreset {
  return typeof value === 'string' && (VRM_EXPRESSION_PRESETS as readonly string[]).includes(value)
}

/**
 * 解析模型后端 flag（`PET_MODEL_BACKEND` 的值或配置值）；非法/缺失返回 null。
 * 大小写敏感（`VRM` 不算合法；env 值先 trim）。
 */
export function parseModelBackend(value: unknown): ModelBackend | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return (MODEL_BACKENDS as readonly string[]).includes(trimmed) ? (trimmed as ModelBackend) : null
}

/**
 * 决定最终模型后端：**环境变量 > 配置 > 默认 `vrm`**（PLAN D4/§4）。
 * @param environmentValue `process.env.PET_MODEL_BACKEND`（可为 undefined/非法）
 * @param configured `PetConfig.modelBackend`（已 sanitize，仍做一次防御校验）
 */
export function resolveModelBackend(
  environmentValue: unknown,
  configured: ModelBackend
): ModelBackend {
  return (
    parseModelBackend(environmentValue) ??
    parseModelBackend(configured) ??
    'vrm'
  )
}

/* -------------------------------------------------------------------------- */
/* manifest 清洗                                                               */
/* -------------------------------------------------------------------------- */

/** 单个 manifest 允许的 avatar 数量上限（防御异常大的输入）。 */
const MAX_AVATARS = 32
/** id / 绑定名最大长度。 */
const MAX_ID_LENGTH = 64
/** 绑定值（骨骼名/expression 名）最大长度。 */
const MAX_BINDING_VALUE_LENGTH = 128
/** notes 最大长度（与 `VrmAvatarAsset.notes` 文档一致）。 */
const MAX_NOTES_LENGTH = 500
/** 高度合法区间（米；含极端值防御）。 */
const MIN_HEIGHT_METERS = 0.2
const MAX_HEIGHT_METERS = 10
/** 高度缺失时的兜底（米；写 warning 提示人工核对）。 */
const FALLBACK_HEIGHT_METERS = 1.7
/** spring 链数上限。 */
const MAX_SPRING_CHAINS = 1000
/** 朝向修正合法区间（度）。 */
const MIN_YAW_OFFSET_DEG = -360
const MAX_YAW_OFFSET_DEG = 360

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readFiniteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function clampNumber(value: number, min: number, max: number): number {
  if (value < min) return min
  if (value > max) return max
  return value
}

function readTrimmedString(value: unknown, maxLength: number): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (trimmed.length === 0 || trimmed.length > maxLength) return null
  return trimmed
}

/** 校验并清洗一个键值绑定表（humanoid 覆盖映射 / expression 映射共用）。 */
function sanitizeBindingMap<K extends string>(
  value: unknown,
  allowedKeys: readonly K[],
  label: string,
  warnings: string[]
): Partial<Record<K, string>> {
  const result: Partial<Record<K, string>> = {}
  if (value === undefined) return result
  if (!isRecord(value)) {
    warnings.push(`${label}：期望对象，已忽略`)
    return result
  }
  const keys = Object.keys(value).slice(0, 200)
  for (const key of keys) {
    if (!(allowedKeys as readonly string[]).includes(key)) continue
    const binding = readTrimmedString(value[key], MAX_BINDING_VALUE_LENGTH)
    if (binding === null) {
      warnings.push(`${label}.${key}：期望非空字符串，已忽略`)
      continue
    }
    result[key as K] = binding
  }
  return result
}

/** 清洗单个 avatar 条目；非法返回 null（并写 warning）。 */
function sanitizeAvatar(
  input: unknown,
  index: number,
  warnings: string[]
): VrmAvatarAsset | null {
  const label = `avatars[${index}]`
  if (!isRecord(input)) {
    warnings.push(`${label}：期望对象，已丢弃`)
    return null
  }

  const id = readTrimmedString(input['id'], MAX_ID_LENGTH)
  if (id === null || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id)) {
    warnings.push(`${label}.id：缺失或非法（需 [A-Za-z0-9._-]，首字符非点），已丢弃`)
    return null
  }

  const file = typeof input['file'] === 'string' ? input['file'].trim() : ''
  if (!isSafeAssetReference(file)) {
    warnings.push(`${label}.file：缺失或不是安全的 assets 相对路径/pet-asset URL，已丢弃`)
    return null
  }

  const rawSpec = input['specVersion']
  const specVersion: VrmAvatarSpecVersion = (VRM_AVATAR_SPEC_VERSIONS as readonly string[]).includes(
    String(rawSpec)
  )
    ? (rawSpec as VrmAvatarSpecVersion)
    : '1.0'
  if (rawSpec !== undefined && specVersion !== rawSpec) {
    warnings.push(`${label}.specVersion：非法值 ${String(rawSpec)}，按 1.0 处理`)
  }

  const rawHeight = readFiniteNumber(input['heightMeters'])
  let heightMeters = FALLBACK_HEIGHT_METERS
  if (rawHeight === null) {
    warnings.push(`${label}.heightMeters：缺失/非法，暂用 ${FALLBACK_HEIGHT_METERS}m（需人工核对）`)
  } else {
    heightMeters = clampNumber(rawHeight, MIN_HEIGHT_METERS, MAX_HEIGHT_METERS)
    if (heightMeters !== rawHeight) {
      warnings.push(`${label}.heightMeters：越界，已钳制到 ${heightMeters}m`)
    }
  }

  const rawSpring = readFiniteNumber(input['springChains'])
  let springChains = 0
  if (rawSpring !== null) {
    springChains = Math.round(clampNumber(rawSpring, 0, MAX_SPRING_CHAINS))
  } else if (input['springChains'] !== undefined) {
    warnings.push(`${label}.springChains：非法，按 0 处理`)
  }

  const rawYaw = readFiniteNumber(input['yawOffsetDeg'])
  let yawOffsetDeg = 0
  if (rawYaw !== null) {
    yawOffsetDeg = clampNumber(rawYaw, MIN_YAW_OFFSET_DEG, MAX_YAW_OFFSET_DEG)
    if (yawOffsetDeg !== rawYaw) {
      warnings.push(`${label}.yawOffsetDeg：越界，已钳制到 ${yawOffsetDeg}°`)
    }
  } else if (input['yawOffsetDeg'] !== undefined) {
    warnings.push(`${label}.yawOffsetDeg：非法，按 0 处理`)
  }

  const rawLookAt = input['lookAt']
  const lookAt: VrmLookAtConfig = { ...DEFAULT_VRM_LOOK_AT }
  if (rawLookAt !== undefined) {
    if (!isRecord(rawLookAt)) {
      warnings.push(`${label}.lookAt：期望对象，已用默认值`)
    } else {
      const mode = rawLookAt['mode']
      if ((VRM_LOOK_AT_MODES as readonly string[]).includes(String(mode))) {
        lookAt.mode = mode as VrmLookAtMode
      } else if (mode !== undefined) {
        warnings.push(`${label}.lookAt.mode：非法值 ${String(mode)}，按 procedural 处理`)
      }
      const yaw = readFiniteNumber(rawLookAt['maxYawDeg'])
      if (yaw !== null) {
        const clampedYaw = clampNumber(yaw, 0, 90)
        if (clampedYaw !== yaw) {
          warnings.push(`${label}.lookAt.maxYawDeg：越界，已钳制到 ${clampedYaw}°`)
        }
        lookAt.maxYawDeg = clampedYaw
      }
      const pitch = readFiniteNumber(rawLookAt['maxPitchDeg'])
      if (pitch !== null) {
        const clampedPitch = clampNumber(pitch, 0, 90)
        if (clampedPitch !== pitch) {
          warnings.push(`${label}.lookAt.maxPitchDeg：越界，已钳制到 ${clampedPitch}°`)
        }
        lookAt.maxPitchDeg = clampedPitch
      }
    }
  }

  const rawThumbnail = input['thumbnail']
  let thumbnail: string | null = null
  if (typeof rawThumbnail === 'string') {
    if (isSafeAssetReference(rawThumbnail)) thumbnail = rawThumbnail.trim()
    else warnings.push(`${label}.thumbnail：不是安全的资产引用，已忽略`)
  }

  const notes = readTrimmedString(input['notes'], MAX_NOTES_LENGTH) ?? ''

  return {
    id,
    file,
    specVersion,
    heightMeters,
    humanoid: sanitizeBindingMap(
      input['humanoid'],
      HUMANOID_BONES,
      `${label}.humanoid`,
      warnings
    ),
    expressions: sanitizeBindingMap(
      input['expressions'],
      PET_EXPRESSIONS,
      `${label}.expressions`,
      warnings
    ),
    lookAt,
    springChains,
    yawOffsetDeg,
    thumbnail,
    notes
  }
}

/**
 * 把任意输入（`JSON.parse` 的 manifest / 本地面板传入的对象）清洗为可消费的
 * `VrmAssetManifest`。**永不抛异常**；非法数据被丢弃并在 `warnings` 里说明。
 *
 * 规则：
 * - `schemaVersion` 必须为 1，否则返回空 manifest（不猜测旧/新格式）；
 * - avatar 按 `id` 去重（保留第一个，重复项丢弃并 warning）；
 * - `id` 需匹配 `[A-Za-z0-9._-]`（首字符非点）；`file` 必须通过 `isSafeAssetReference`；
 * - 缺省值：`specVersion='1.0'`、`heightMeters=1.7`、`lookAt=DEFAULT_VRM_LOOK_AT`、
 *   `springChains=0`、`yawOffsetDeg=0`、`humanoid/expressions={}`；
 * - `defaultAvatarId` 缺失/非法时回退第一个 avatar 的 id；无 avatar 时为 `''`。
 */
export function sanitizeVrmAssetManifest(input: unknown): SanitizeResult<VrmAssetManifest> {
  const warnings: string[] = []
  const empty: VrmAssetManifest = {
    schemaVersion: VRM_MANIFEST_SCHEMA_VERSION,
    defaultAvatarId: '',
    avatars: []
  }

  if (!isRecord(input)) {
    warnings.push('vrm manifest：期望对象，已回退空 manifest')
    return { value: empty, warnings }
  }
  if (input['schemaVersion'] !== VRM_MANIFEST_SCHEMA_VERSION) {
    warnings.push(
      `vrm manifest.schemaVersion：期望 ${VRM_MANIFEST_SCHEMA_VERSION}，实际 ${String(
        input['schemaVersion']
      )}，已回退空 manifest`
    )
    return { value: empty, warnings }
  }

  const rawAvatars = input['avatars']
  if (!Array.isArray(rawAvatars)) {
    warnings.push('vrm manifest.avatars：期望数组，已回退空 manifest')
    return { value: empty, warnings }
  }

  const avatars: VrmAvatarAsset[] = []
  const seenIds = new Set<string>()
  for (let index = 0; index < rawAvatars.length && avatars.length < MAX_AVATARS; index += 1) {
    const avatar = sanitizeAvatar(rawAvatars[index], index, warnings)
    if (avatar === null) continue
    if (seenIds.has(avatar.id)) {
      warnings.push(`avatars[${index}].id：重复 id "${avatar.id}"，已丢弃`)
      continue
    }
    seenIds.add(avatar.id)
    avatars.push(avatar)
  }

  let defaultAvatarId = readTrimmedString(input['defaultAvatarId'], MAX_ID_LENGTH)
  if (defaultAvatarId === null || !seenIds.has(defaultAvatarId)) {
    const fallbackId = avatars.length > 0 ? avatars[0].id : ''
    if (input['defaultAvatarId'] !== undefined) {
      warnings.push(
        `vrm manifest.defaultAvatarId：缺失/不存在，回退 "${fallbackId}"`
      )
    }
    defaultAvatarId = fallbackId
  }

  return {
    value: { schemaVersion: VRM_MANIFEST_SCHEMA_VERSION, defaultAvatarId, avatars },
    warnings
  }
}

/**
 * 从 manifest 选择 avatar：显式 id > `defaultAvatarId` > 第一个；空 manifest 返回 null
 * （调用方应回退 legacy-pmx 路径）。
 */
export function resolveAvatarAsset(
  manifest: VrmAssetManifest,
  avatarId?: string | null
): VrmAvatarAsset | null {
  if (manifest.avatars.length === 0) return null
  if (typeof avatarId === 'string' && avatarId.length > 0) {
    const explicit = manifest.avatars.find((avatar) => avatar.id === avatarId)
    if (explicit !== undefined) return explicit
  }
  const defaultAvatar = manifest.avatars.find(
    (avatar) => avatar.id === manifest.defaultAvatarId
  )
  return defaultAvatar ?? manifest.avatars[0]
}
