/**
 * 桌宠侧兼容判定（2026-11-11 兼容性安全 v2）—— **纯函数、无 IO、绝不抛异常**。
 *
 * 契约依据：`docs/pet-dsh-coupling-safety-plan-2026-11-11.md` §3/§6.1。
 *
 * 输入三路信号（按优先级）：
 * 1. 运行时：桥 v4+ 写进 `control.json` 的 `compat` 块（bridgeVersion/controlSchema/dshRange）；
 * 2. 安装清单：`~/.dsh/aventurine-pet/install.json`（桥被版本闸门禁用/未加载时的静态兜底）；
 * 3. 宿主：DSH app `Info.plist` 的 `CFBundleShortVersionString`（由 `dsh-version.ts` 读取）。
 *
 * 判定原则：**只在可验证时声称兼容**。版本/范围解析失败一律 `unverified`（不可验证，
 * 消费方按握手不健康降级），绝不猜"兼容"或"不兼容"。
 *
 * 规则（按序、命中即返回；见计划 §6.1）：
 * 1. 桥版本未知（运行时与安装清单都没有）→ `unverified/no-bridge`；
 * 2. 桥版本低于桌宠最低支持 → `incompatible/bridge-too-old`；
 * 3. 桥版本高于桌宠已知版本（未来桥）→ `incompatible/bridge-too-new`；
 * 4. 控制帧 schema 不匹配 → `incompatible/schema-mismatch`；
 * 5. DSH 版本未知 → `unverified/dsh-version-unknown`；
 * 6. v3 legacy 且无 dshRange → 回退共享常量 `BRIDGE_LEGACY_DSH_RANGE`；v4+ 无 dshRange →
 *    `incompatible/range-missing`；
 * 7. `satisfiesSemverRange` 返回 null（范围/版本不可解析）→ `unverified/range-unparsable`；
 * 8. 返回 false → `incompatible/version-out-of-range`（detail 带 DSH 版本与范围）；
 * 9. 否则 `ok`。
 *
 * `installManifest` 兜底规则：**仅当运行时 compat 信号缺失**（桥 v3 或桥未加载）时才用清单的
 * `bridgeVersion/controlSchema/dshRange`；运行时信号存在时以运行时为准，清单与运行时不符只写进
 * detail（便于排障，不单独改变 status —— 避免"装的是 v3、跑的是 v4"这种中间态误判）。
 */
import {
  BRIDGE_CONTROL_SCHEMA_VERSION,
  BRIDGE_LEGACY_DSH_RANGE,
  BRIDGE_PLUGIN_MIN_SUPPORTED,
  BRIDGE_PLUGIN_VERSION
} from '@shared/bridge-schema'
import type { DshBridgeInstallManifest } from '@shared/bridge-schema'
import { satisfiesSemverRange } from '@shared/semver-range'

/** 兼容判定三态。 */
export type CouplingCompatStatus = 'ok' | 'incompatible' | 'unverified'

/** 兼容判定原因码（`ok` 之外的值都会进告警/detail）。 */
export type CouplingCompatCode =
  | 'ok'
  | 'bridge-too-old'
  | 'bridge-too-new'
  | 'schema-mismatch'
  | 'range-missing'
  | 'range-unparsable'
  | 'dsh-version-unknown'
  | 'version-out-of-range'
  | 'no-bridge'

/** `evaluateCouplingCompat` 输入（全部可为 null = 该路信号缺失）。 */
export interface CouplingCompatInput {
  /** DSH app 版本（semver 文本）；读取失败/未知 → null。 */
  dshVersion: string | null
  /** 运行时桥版本（来自 control 帧 compat 或顶层 bridgeVersion）；未知 → null。 */
  bridgeVersion: number | null
  /** 运行时桥认识的控制帧 schema 版本（来自 compat）；未知 → null。 */
  controlSchema: number | null
  /** 运行时桥声明的 DSH 范围（来自 compat）；未声明 → null。 */
  dshRange: string | null
  /** 安装清单（运行时信号缺失时兜底；纯排障信息，不参与安全决策）。 */
  installManifest?: DshBridgeInstallManifest | null
}

/** `evaluateCouplingCompat` 结果。 */
export interface CouplingCompatResult {
  status: CouplingCompatStatus
  code: CouplingCompatCode
  /** 一行人类可读原因（含关键版本/范围，供日志与告警 detail）。 */
  detail: string
  /** 实际参与判定的桥版本（运行时优先，缺失时来自安装清单；都没有 → null）。 */
  bridgeVersion: number | null
  /** 实际参与判定的 DSH 范围（v3 legacy 回退后的值；不可用 → null）。 */
  dshRange: string | null
}

/** 归一化正整数（非法 → null）。 */
function normalizePositiveInt(value: number | null | undefined): number | null {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) return null
  return value
}

/** 归一化非空字符串（trim；非法/空白 → null）。 */
function normalizeNonEmptyString(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

/** 构造结果（统一填充 detail / 生效版本 / 生效范围）。 */
function result(
  status: CouplingCompatStatus,
  code: CouplingCompatCode,
  detail: string,
  bridgeVersion: number | null,
  dshRange: string | null
): CouplingCompatResult {
  return { status, code, detail, bridgeVersion, dshRange }
}

/**
 * 判定桌宠与当前 DSH 的兼容性（纯函数、无 IO、绝不抛异常）。
 *
 * @returns `ok` = 可进 PAIRED；`incompatible` = 立即 DEGRADED；`unverified` = 不可验证，
 *          由调用方按握手不健康处理（不得猜兼容）。
 */
export function evaluateCouplingCompat(input: CouplingCompatInput): CouplingCompatResult {
  const manifest = input.installManifest ?? null
  const runtimeBridgeVersion = normalizePositiveInt(input.bridgeVersion)
  const runtimeControlSchema = normalizePositiveInt(input.controlSchema)
  const runtimeRange = normalizeNonEmptyString(input.dshRange)

  // 运行时 compat 是否可用：兼容块必须同时给出 bridgeVersion + controlSchema（dshRange 允许 null）。
  const runtimeCompatPresent = runtimeBridgeVersion !== null && runtimeControlSchema !== null

  let bridgeVersion = runtimeBridgeVersion
  let controlSchema = runtimeControlSchema
  let dshRange = runtimeRange
  const notes: string[] = []
  if (!runtimeCompatPresent && manifest) {
    // 运行时 compat 缺失（v3 legacy / 桥未加载）→ 安装清单兜底。
    bridgeVersion = bridgeVersion ?? manifest.bridgeVersion
    controlSchema = controlSchema ?? manifest.controlSchema
    dshRange = dshRange ?? manifest.dshRange
    notes.push('运行时 compat 缺失，使用安装清单兜底')
  }
  // v3 legacy 特殊处理：v3 桥不写 compat，但它的控制帧 schema 固定为共享契约版本
  // （control.json 的 schemaVersion 已由解析器校验），因此 schema 视为已知而非"不匹配"。
  if (!runtimeCompatPresent && controlSchema === null && bridgeVersion === 3) {
    controlSchema = BRIDGE_CONTROL_SCHEMA_VERSION
    notes.push('v3 legacy 无 compat，控制帧 schema 按契约视为 1')
  }
  if (
    runtimeBridgeVersion !== null &&
    manifest !== null &&
    manifest.bridgeVersion !== runtimeBridgeVersion
  ) {
    notes.push(`安装清单 bridgeVersion=${manifest.bridgeVersion} 与运行时 ${runtimeBridgeVersion} 不一致`)
  }
  const suffix = notes.length > 0 ? `（${notes.join('；')}）` : ''

  // 1) 桥版本未知：没有任何一路信号能说明桥实现版本 → 不可验证。
  if (bridgeVersion === null) {
    return result(
      'unverified',
      'no-bridge',
      `未检测到桥版本信号（control 帧无 compat、无安装清单）${suffix}`,
      null,
      dshRange
    )
  }

  // 2/3) 桥版本上下界：比桌宠旧（不支持）或比桌宠新（未来桥，可能改了契约）。
  if (bridgeVersion < BRIDGE_PLUGIN_MIN_SUPPORTED) {
    return result(
      'incompatible',
      'bridge-too-old',
      `桥版本 ${bridgeVersion} 过旧（桌宠最低支持 v${BRIDGE_PLUGIN_MIN_SUPPORTED}）${suffix}`,
      bridgeVersion,
      dshRange
    )
  }
  if (bridgeVersion > BRIDGE_PLUGIN_VERSION) {
    return result(
      'incompatible',
      'bridge-too-new',
      `桥版本 ${bridgeVersion} 高于桌宠已知版本 v${BRIDGE_PLUGIN_VERSION}（未来桥契约未验证）${suffix}`,
      bridgeVersion,
      dshRange
    )
  }

  // 4) 控制帧 schema：桥认识的控制帧版本必须与共享契约一致（未来 schema 不兼容）。
  if (controlSchema !== BRIDGE_CONTROL_SCHEMA_VERSION) {
    return result(
      'incompatible',
      'schema-mismatch',
      `桥控制帧 schema=${String(controlSchema)} 与桌宠期望 ${BRIDGE_CONTROL_SCHEMA_VERSION} 不匹配${suffix}`,
      bridgeVersion,
      dshRange
    )
  }

  // 5) DSH 版本未知：无法证明兼容 → 不可验证（不得猜）。
  if (normalizeNonEmptyString(input.dshVersion) === null) {
    return result(
      'unverified',
      'dsh-version-unknown',
      `无法读取 DSH 版本，不能验证桥声明范围 ${dshRange ?? '（未声明）'}${suffix}`,
      bridgeVersion,
      dshRange
    )
  }
  const dshVersion = (input.dshVersion as string).trim()

  // 6) 范围缺失：v3 legacy 回退共享常量；v4+ 必须显式声明。
  if (dshRange === null) {
    if (bridgeVersion === 3) {
      dshRange = BRIDGE_LEGACY_DSH_RANGE
      notes.push(`v3 legacy 桥未声明范围，回退 ${BRIDGE_LEGACY_DSH_RANGE}`)
    } else {
      return result(
        'incompatible',
        'range-missing',
        `桥 v${bridgeVersion} 未声明 DSH 兼容范围（engines.dsh 缺失）${suffix}`,
        bridgeVersion,
        null
      )
    }
  }
  const effectiveSuffix = notes.length > 0 ? `（${notes.join('；')}）` : ''

  // 7/8) SemVer 判定：null = 不可验证；false = 明确不兼容。
  const satisfied = satisfiesSemverRange(dshVersion, dshRange)
  if (satisfied === null) {
    return result(
      'unverified',
      'range-unparsable',
      `DSH 版本 ${dshVersion} 或桥范围 ${dshRange} 无法解析（不可验证）${effectiveSuffix}`,
      bridgeVersion,
      dshRange
    )
  }
  if (satisfied === false) {
    return result(
      'incompatible',
      'version-out-of-range',
      `DSH 版本 ${dshVersion} 不满足桥声明范围 ${dshRange}${effectiveSuffix}`,
      bridgeVersion,
      dshRange
    )
  }

  // 9) 可验证且满足。
  return result(
    'ok',
    'ok',
    `兼容：DSH ${dshVersion} 满足桥 v${bridgeVersion} 声明范围 ${dshRange}${effectiveSuffix}`,
    bridgeVersion,
    dshRange
  )
}
