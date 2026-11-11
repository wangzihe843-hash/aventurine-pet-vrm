/**
 * 窥屏互动（peek）接口预留契约 —— 环境中立纯 TS。
 *
 * 规则（M0-2）：禁止 import electron / node: 内置模块 / 第三方运行时依赖；
 * 本文件同时被 `tsconfig.node.json`（main/preload）与 `tsconfig.web.json`（renderer）typecheck。
 *
 * 本轮定位（Wave 3 A7，只留接口、**零采集**）：
 * - 默认关闭：`PEEK_DEFAULT_STATUS` 全 off、所有 capability unavailable；
 * - fail-closed：`evaluatePeekGate` 是唯一放行判断点，任何不确定/脏输入一律 deny；
 * - 不实现截图/OCR/窗口标题读取，不申请 TCC；本文件不引用任何采集 API。
 *
 * 未来接线（见 `docs/peek-interface.md`）：
 * - main 进程实现 `PeekProvider`（P0 元数据 → 0 权限；P2 OCR / P3 vision → TCC，另行评审）；
 * - service 在调用 provider 前先跑 `evaluatePeekGate`；
 * - 通过新增 IPC（Lead 评审）暴露状态/手动观察；renderer 只消费无内容的状态与事件。
 */

/* -------------------------------------------------------------------------- */
/* 能力与档位                                                                   */
/* -------------------------------------------------------------------------- */

/** 本契约声明的能力（顺序冻结，测试锚定）。 */
export const PEEK_CAPABILITIES = [
  'screen.peek.metadata',
  'screen.peek.ocr',
  'screen.peek.vision'
] as const
export type PeekCapability = (typeof PEEK_CAPABILITIES)[number]

/** 数据档位：off 之外与 capability 对应（P0 / P2 / P3）。 */
export const PEEK_TIERS = ['off', 'metadata', 'ocr', 'vision'] as const
export type PeekTier = (typeof PEEK_TIERS)[number]

/** capability → 生效档位（gate 放行时返回；不可能出现 off）。 */
export const PEEK_CAPABILITY_TIER: Readonly<
  Record<PeekCapability, Exclude<PeekTier, 'off'>>
> = {
  'screen.peek.metadata': 'metadata',
  'screen.peek.ocr': 'ocr',
  'screen.peek.vision': 'vision'
}

/** 判断任意值是否为合法 capability。 */
export function isPeekCapability(value: unknown): value is PeekCapability {
  return typeof value === 'string' && (PEEK_CAPABILITIES as readonly string[]).includes(value)
}

/** 判断任意值是否为合法档位。 */
export function isPeekTier(value: unknown): value is PeekTier {
  return typeof value === 'string' && (PEEK_TIERS as readonly string[]).includes(value)
}

/* -------------------------------------------------------------------------- */
/* 权限状态                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * 屏幕录制 TCC 状态的诚实映射（含平台真实取值；未知不猜测）。
 * 本 slice 不导入 Electron、不查询 TCC：默认值为 `'not-determined'`，
 * 真实状态由未来 main 接线用 `systemPreferences.getMediaAccessStatus('screen')` 注入。
 */
export const PEEK_PERMISSION_STATES = [
  'granted',
  'denied',
  'not-determined',
  'restricted',
  'unsupported',
  'unknown'
] as const
export type PeekPermissionState = (typeof PEEK_PERMISSION_STATES)[number]

/** 判断任意值是否为合法权限状态。 */
export function isPeekPermissionState(value: unknown): value is PeekPermissionState {
  return typeof value === 'string' && (PEEK_PERMISSION_STATES as readonly string[]).includes(value)
}

/* -------------------------------------------------------------------------- */
/* 拒绝原因（fail-closed 唯一出口）                                              */
/* -------------------------------------------------------------------------- */

/** `evaluatePeekGate` / `PeekObservationResult` / `PeekCapabilityStatus` 共用的拒绝原因。 */
export const PEEK_DENY_REASONS = [
  /** 总开关关闭或档位为 off（默认态）。 */
  'disabled',
  /** 本轮接口占位：没有任何 provider 实现，observe 恒不可用。 */
  'not-implemented',
  /** 屏幕录制权限未授予（denied / not-determined / restricted / unsupported / unknown）。 */
  'permission-not-granted',
  /** provider 未声明该 capability 或探测为不可用。 */
  'capability-unavailable',
  /** 前台应用命中敏感名单（隐私闸门）。 */
  'sensitive-app',
  /** 节流未通过（最小间隔 / 每小时上限 / 时钟异常）。 */
  'throttled',
  /** 请求或状态结构非法（脏输入，fail-closed）。 */
  'invalid-request'
] as const
export type PeekDenyReason = (typeof PEEK_DENY_REASONS)[number]

/** 判断任意值是否为合法拒绝原因。 */
export function isPeekDenyReason(value: unknown): value is PeekDenyReason {
  return typeof value === 'string' && (PEEK_DENY_REASONS as readonly string[]).includes(value)
}

/* -------------------------------------------------------------------------- */
/* 状态快照                                                                     */
/* -------------------------------------------------------------------------- */

/** 单条 capability 的可用性（UI/测试可解释「为什么不可用」）。 */
export interface PeekCapabilityStatus {
  readonly capability: PeekCapability
  readonly available: boolean
  /** `available=false` 时的原因；`available=true` 时恒为 null。 */
  readonly reason: PeekDenyReason | null
}

/** provider 身份（不含任何采集实现细节）。 */
export interface PeekProviderInfo {
  readonly id: string
  readonly version: string
}

/** 节流策略（默认值仅预留；未来由配置注入）。 */
export interface PeekThrottlePolicy {
  /** 两次观察的最小间隔（毫秒）。 */
  readonly minGapMs: number
  /** 每小时观察上限（0 = 一律拒绝）。 */
  readonly maxPerHour: number
}

/** 默认节流参数（沿用可行性报告：最小间隔 600s、每小时 3 次）。 */
export const PEEK_DEFAULT_THROTTLE: PeekThrottlePolicy = Object.freeze({
  minGapMs: 600_000,
  maxPerHour: 3
})

/**
 * 窥屏状态快照（纯数据；不含任何屏幕内容）。
 * 未来通过新增 IPC 暴露给设置页/调试面（本轮不接线）。
 */
export interface PeekStatus {
  readonly enabled: boolean
  readonly tier: PeekTier
  readonly permission: PeekPermissionState
  readonly capabilities: readonly PeekCapabilityStatus[]
  readonly provider: PeekProviderInfo | null
  readonly sensitiveApps: readonly string[]
  readonly throttle: PeekThrottlePolicy
  readonly lastObservationAtMs: number | null
  readonly observationsLastHour: number
  /** true = 本轮接口占位（无 provider 实现；observe 恒 not-implemented）。 */
  readonly notImplemented: boolean
}

/* -------------------------------------------------------------------------- */
/* 观察请求 / 结果                                                              */
/* -------------------------------------------------------------------------- */

export const PEEK_OBSERVATION_TRIGGERS = ['schedule', 'manual', 'dsh', 'behavior'] as const
export type PeekObservationTrigger = (typeof PEEK_OBSERVATION_TRIGGERS)[number]

/** 判断任意值是否为合法触发源。 */
export function isPeekObservationTrigger(value: unknown): value is PeekObservationTrigger {
  return (
    typeof value === 'string' &&
    (PEEK_OBSERVATION_TRIGGERS as readonly string[]).includes(value)
  )
}

/** 主进程内部观察请求（renderer/DSH 不能直接构造；provider 只收已过 gate 的请求）。 */
export interface PeekObservationRequest {
  readonly trigger: PeekObservationTrigger
  readonly capability: PeekCapability
  /** 请求发起时刻（epoch ms；仅用于历史/展示，不参与节流计算）。 */
  readonly requestedAtMs: number
  /**
   * 前台应用名（元数据；仅用于敏感规则匹配，**不落日志**）。
   * null = 未知；gate 不做「未知即拒绝」（该策略属未来 P0 provider 的规则引擎）。
   */
  readonly foregroundApp: string | null
}

/** 脱敏摘要（内容级能力必须填写；本轮 stub 不产生内容）。 */
export interface PeekRedactionSummary {
  readonly applied: boolean
  readonly ruleIds: readonly string[]
  readonly truncated: boolean
}

/** 空脱敏摘要（无内容时使用；冻结避免共享可变引用）。 */
export const PEEK_EMPTY_REDACTION: PeekRedactionSummary = Object.freeze({
  applied: false,
  ruleIds: Object.freeze([] as string[]),
  truncated: false
})

/** 未来活动分类（P0 元数据；本 slice 不产生）。 */
export const PEEK_ACTIVITY_CLASSES = [
  'work',
  'game',
  'browse',
  'call',
  'away',
  'idle',
  'casual'
] as const
export type PeekActivityClass = (typeof PEEK_ACTIVITY_CLASSES)[number]

/**
 * 观察结果负载（按 capability 分型；字段为未来 P0–P3 预留，本 slice 无 provider 产生）：
 * - `metadata`：P0 零权限元数据；
 * - `text`：P2 本机 OCR 文本（**仅主进程内存**，不落盘、不过 IPC、不进日志）；
 * - `vision`：P3 文本描述（图像字节永不出 provider）。
 */
export type PeekObservationPayload =
  | {
      readonly kind: 'metadata'
      readonly foregroundApp: string | null
      readonly windowCount: number | null
      readonly activityClass: PeekActivityClass | null
    }
  | {
      readonly kind: 'text'
      readonly text: string
      readonly linesDropped: number
      readonly truncated: boolean
    }
  | {
      readonly kind: 'vision'
      readonly description: string
    }

/** provider/service 的观察结果；deny 分支与 gate 原因同源。 */
export type PeekObservationResult =
  | {
      readonly ok: true
      readonly capability: PeekCapability
      readonly tier: Exclude<PeekTier, 'off'>
      readonly atMs: number
      readonly confidence: number
      readonly payload: PeekObservationPayload
      readonly redaction: PeekRedactionSummary
    }
  | { readonly ok: false; readonly reason: PeekDenyReason }

/* -------------------------------------------------------------------------- */
/* provider 接口                                                                */
/* -------------------------------------------------------------------------- */

/**
 * 采集 provider 契约（未来实现；本 slice 只有 stub）。
 *
 * 硬性约束（写进接口注释，实现方与评审方共同遵守）：
 * - `capabilities()` 只读声明，不得触发 TCC 弹窗/截图/读标题/写盘/出网；
 * - `observe()` 只处理**已过 gate** 的请求，不得自行扩大采集范围（不许整屏回退、不许升档）；
 * - `observe()` 永不抛异常；不可用/失败返回 `{ok:false, reason}`；
 * - 内容（文本/图像）只允许留在主进程内存，永不进入日志/磁盘/IPC。
 */
export interface PeekProvider {
  readonly id: string
  readonly version: string
  capabilities(): readonly PeekCapability[]
  observe(request: PeekObservationRequest): Promise<PeekObservationResult>
  /** 幂等释放；不得产生采集副作用。 */
  dispose?(): void
}

/* -------------------------------------------------------------------------- */
/* 默认状态（全关 / 全不可用）                                                   */
/* -------------------------------------------------------------------------- */

/** 默认：每个 capability 都不可用，原因 = 本轮未实现。 */
const PEEK_DEFAULT_CAPABILITY_STATUSES: readonly PeekCapabilityStatus[] = Object.freeze(
  PEEK_CAPABILITIES.map((capability) =>
    Object.freeze({ capability, available: false, reason: 'not-implemented' as const })
  )
)

/**
 * 默认状态：**关闭 + 全不可用**（接口层红线，任何消费方都不得把它当成「已启用」）。
 * 深冻结：防止调用方误改共享常量（需要变更时构造新对象）。
 */
export const PEEK_DEFAULT_STATUS: PeekStatus = Object.freeze({
  enabled: false,
  tier: 'off',
  permission: 'not-determined',
  capabilities: PEEK_DEFAULT_CAPABILITY_STATUSES,
  provider: null,
  sensitiveApps: Object.freeze([] as string[]),
  throttle: PEEK_DEFAULT_THROTTLE,
  lastObservationAtMs: null,
  observationsLastHour: 0,
  notImplemented: true
})

/* -------------------------------------------------------------------------- */
/* 纯函数：peek 闸门（fail-closed 单点）                                         */
/* -------------------------------------------------------------------------- */

export type PeekGateDecision =
  | {
      readonly ok: true
      readonly capability: PeekCapability
      readonly tier: Exclude<PeekTier, 'off'>
    }
  | { readonly ok: false; readonly reason: PeekDenyReason }

/** 普通对象判定（排除 null / 数组）。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 有限数字判定（排除 NaN / ±Infinity）。 */
function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

/** 请求结构校验（脏输入 → false，调用方 fail-closed）。 */
function isValidObservationRequest(value: unknown): value is PeekObservationRequest {
  if (!isRecord(value)) return false
  if (!isPeekObservationTrigger(value['trigger'])) return false
  if (!isPeekCapability(value['capability'])) return false
  if (!isFiniteNumber(value['requestedAtMs'])) return false
  if (value['foregroundApp'] !== null && typeof value['foregroundApp'] !== 'string') return false
  return true
}

/** capability 状态结构校验。 */
function isValidCapabilityStatus(value: unknown): value is PeekCapabilityStatus {
  if (!isRecord(value)) return false
  if (!isPeekCapability(value['capability'])) return false
  if (typeof value['available'] !== 'boolean') return false
  if (value['reason'] !== null && !isPeekDenyReason(value['reason'])) return false
  return true
}

/** 状态结构校验（脏状态 → false，gate 返回 invalid-request）。 */
function isValidStatus(value: unknown): value is PeekStatus {
  if (!isRecord(value)) return false
  if (typeof value['enabled'] !== 'boolean') return false
  if (!isPeekTier(value['tier'])) return false
  if (!isPeekPermissionState(value['permission'])) return false
  const capabilities = value['capabilities']
  if (!Array.isArray(capabilities) || !capabilities.every(isValidCapabilityStatus)) return false
  const provider = value['provider']
  if (provider !== null) {
    if (!isRecord(provider)) return false
    if (typeof provider['id'] !== 'string' || provider['id'].length === 0) return false
    if (typeof provider['version'] !== 'string') return false
  }
  const sensitiveApps = value['sensitiveApps']
  if (!Array.isArray(sensitiveApps) || !sensitiveApps.every((app) => typeof app === 'string')) {
    return false
  }
  const throttle = value['throttle']
  if (!isRecord(throttle)) return false
  if (!isFiniteNumber(throttle['minGapMs']) || throttle['minGapMs'] < 0) return false
  if (!isFiniteNumber(throttle['maxPerHour']) || throttle['maxPerHour'] < 0) return false
  const lastObservationAtMs = value['lastObservationAtMs']
  if (lastObservationAtMs !== null && !isFiniteNumber(lastObservationAtMs)) return false
  if (
    !isFiniteNumber(value['observationsLastHour']) ||
    value['observationsLastHour'] < 0
  ) {
    return false
  }
  return typeof value['notImplemented'] === 'boolean'
}

/** 敏感应用匹配：大小写不敏感的子串匹配；app 未知/空 → 不命中。 */
function matchesSensitiveApp(
  sensitiveApps: readonly string[],
  foregroundApp: string | null
): boolean {
  if (foregroundApp === null) return false
  const app = foregroundApp.trim().toLowerCase()
  if (app.length === 0) return false
  return sensitiveApps.some((entry) => {
    const needle = entry.trim().toLowerCase()
    return needle.length > 0 && app.includes(needle)
  })
}

/** 节流判定：时钟回拨/最小间隔/每小时上限任一不满足 → true（fail-closed）。 */
function isThrottled(status: PeekStatus, now: number): boolean {
  if (status.lastObservationAtMs !== null) {
    // 时钟回拨（now 早于上次观察）不猜测，直接视为节流。
    if (now < status.lastObservationAtMs) return true
    if (now - status.lastObservationAtMs < status.throttle.minGapMs) return true
  }
  return status.observationsLastHour >= status.throttle.maxPerHour
}

/**
 * peek 闸门（纯函数，**fail-closed 单点**）：决定本次观察是否可以交给 provider。
 *
 * 决策顺序固定（同一输入永远同一 reason；阻断即返回）：
 *  1. `invalid-request`：请求/状态结构非法、`now` 非有限数（脏输入绝不抛异常）；
 *  2. `disabled`：总开关关闭或档位为 'off'（默认态走这里）；
 *  3. `not-implemented`：`status.notImplemented === true`（本轮接口占位）；
 *  4. `permission-not-granted`：屏幕录制权限非 granted（含 unknown）；
 *  5. `capability-unavailable`：状态中没有该 capability 或 `available !== true`；
 *  6. `sensitive-app`：前台应用命中敏感名单；
 *  7. `throttled`：最小间隔 / 每小时上限 / 时钟回拨未过；
 *  8. 放行：返回 `{ok:true, capability, tier}`。
 *
 * @param request 观察请求（主进程内部构造）
 * @param status  状态快照（provider/权限/开关/节流输入）
 * @param now     当前单调/墙钟毫秒（由调用方注入，gate 自身不读时钟）
 */
export function evaluatePeekGate(
  request: PeekObservationRequest,
  status: PeekStatus,
  now: number
): PeekGateDecision {
  if (!isValidObservationRequest(request) || !isFiniteNumber(now)) {
    return { ok: false, reason: 'invalid-request' }
  }
  if (!isValidStatus(status)) {
    return { ok: false, reason: 'invalid-request' }
  }
  if (status.enabled !== true || status.tier === 'off') {
    return { ok: false, reason: 'disabled' }
  }
  if (status.notImplemented === true) {
    return { ok: false, reason: 'not-implemented' }
  }
  if (status.permission !== 'granted') {
    return { ok: false, reason: 'permission-not-granted' }
  }
  const capabilityStatus = status.capabilities.find(
    (entry) => entry.capability === request.capability
  )
  if (!capabilityStatus || capabilityStatus.available !== true) {
    return { ok: false, reason: 'capability-unavailable' }
  }
  if (matchesSensitiveApp(status.sensitiveApps, request.foregroundApp)) {
    return { ok: false, reason: 'sensitive-app' }
  }
  if (isThrottled(status, now)) {
    return { ok: false, reason: 'throttled' }
  }
  return {
    ok: true,
    capability: request.capability,
    tier: PEEK_CAPABILITY_TIER[request.capability]
  }
}
