/**
 * 冻结共享契约 —— DSH 桥文件契约（M0-2）
 *
 * 数据流向：A5（DSH 桥插件，独立 npm 包）写文件 → 主进程 B7（dsh-watch）读文件。
 * 文件位置约定为 `~/.dsh/aventurine-pet/`（由插件/读取方各自用 node:os 拼路径；
 * 本文件是环境中立纯 TS，只描述文件名、常量与校验/解析逻辑，不碰 node:os/fs）。
 *
 * - `status.json`：覆盖写的心跳状态，DSH 运行时每 5s 更新一次。
 * - `events.jsonl`：追加写的 NDJSON，每行一个 `DshEvent`；插件负责 5MB 轮转。
 * - 判在线：`!offline && now >= status.ts && now - status.ts < BRIDGE_ONLINE_TTL_MS`（30s）。
 *   未来时间戳（时钟回拨/伪造）**不算** online；`offline: true` 是插件退出时的显式离线标记。
 * - 解析函数必须对任意脏输入（截断行、半行、非 JSON、字段缺失、超长行）返回 null，绝不抛异常。
 * - 单行超过 `BRIDGE_MAX_LINE_BYTES`（64KB）时 `parseDshEventLine` 直接丢弃，防止内存膨胀。
 * - **payload 零信任（R-24）**：`events.jsonl` 可能被任意同用户进程写。`parseDshEventLine`
 *   解析成功后用 `sanitizeDshEventPayload` 做半白名单清洗：已知字段（10 个安全标量，见
 *   `DSH_EVENT_PAYLOAD_KEYS`）严格校验/截断，未知字段只透传 JSON 标量、结构化值丢弃，
 *   再交给 main/renderer 消费。未知**标量**保留是为兼容桥文件历史/测试夹具字段（见函数注释）。
 *
 * 规则：环境中立纯 TS，禁止 import electron / node: 内置模块 / 第三方运行时依赖。
 */
import type { DshEvent, DshEventType, DshStatus } from './types'

/** `~/.dsh/` 下的桥目录名（完整路径：`~/.dsh/aventurine-pet/`）。 */
export const BRIDGE_DIR_NAME = 'aventurine-pet'

/** 心跳状态文件名。 */
export const BRIDGE_STATUS_FILE = 'status.json'

/** 事件流文件名（NDJSON，每行一个 DshEvent）。 */
export const BRIDGE_EVENTS_FILE = 'events.jsonl'

/**
 * 生命周期控制文件名（桥插件 apply/dispose 时原子覆盖写）。
 * 语义：`attached` = 桥实例已加载（DSH 启动或 HMR 重载后）；`detached` = 桥实例被卸载
 * （DSH 退出或 HMR 卸载）。**detached 不能单独证明 DSH 进程退出**（HMR 也会 detach），
 * 桌宠侧必须用 grace（等待重新 attached）+ 进程探测交叉判定。
 */
export const BRIDGE_CONTROL_FILE = 'control.json'

/** `control.json` 的 schema 版本（不兼容变更时递增）。 */
export const BRIDGE_CONTROL_SCHEMA_VERSION = 1

/**
 * 桥插件实现版本（2026-11-11 兼容性安全 v2：3 → 4，v4 起 `control/status` 带 `compat` 块）。
 * 与 `bridge/dsh-aventurine-bridge/lib/constants.js` 的 `BRIDGE_PLUGIN_VERSION` 由 parity
 * 测试守护（`tests/bridge-plugin.test.ts`）。
 */
export const BRIDGE_PLUGIN_VERSION = 4

/** 桌宠支持的最旧桥插件版本（v3 = 现网 legacy：无 compat，用 {@link BRIDGE_LEGACY_DSH_RANGE}）。 */
export const BRIDGE_PLUGIN_MIN_SUPPORTED = 3

/**
 * legacy（v3）桥未声明 `dshRange` 时沿用的 DSH 范围 —— 等于 bridge v3 的 `engines.dsh`。
 * 只用于向后兼容现网已安装的 v3 桥；v4 起必须由桥/安装清单显式声明范围。
 */
export const BRIDGE_LEGACY_DSH_RANGE = '>=0.2.2-rc.1 <0.3.0'

/** 桥安装清单文件名（激活脚本写入；桥被 DSH 版本闸门禁用时桌宠据此解释原因）。 */
export const BRIDGE_INSTALL_FILE = 'install.json'

/** 桥故障诊断文件名（`apply` 失败时桥写入；桌宠据此解释"桥为什么没加载"）。 */
export const BRIDGE_DIAGNOSTIC_FILE = 'bridge-error.json'

/** 安装清单 schema 版本（不兼容变更时递增）。 */
export const BRIDGE_INSTALL_SCHEMA_VERSION = 1

/** 安装清单允许读取的最大字节数（清单应 <2KB；防御超大/伪造文件）。 */
export const BRIDGE_INSTALL_MAX_BYTES = 16 * 1024

/** 桥故障诊断文件允许读取的最大字节数。 */
export const BRIDGE_DIAGNOSTIC_MAX_BYTES = 16 * 1024

/** 控制帧 action：桥实例已加载 / 已卸载。 */
export type DshBridgeControlAction = 'attached' | 'detached'

/**
 * 桥的运行时兼容自述（v4 起写入 `control.json` 与 `status.json` 的 `compat` 块）。
 *
 * 来源是桥自己的 `package.json.engines.dsh`（运行时读取）；桥**不**声称知道 DSH 版本，
 * DSH 版本由桌宠从 app `Info.plist` 读取后与这里的 `dshRange` 比较。
 * 这是加法式契约：旧桌宠忽略未知键，旧桥（v3）不写该块、由桌宠走 legacy 回退。
 */
export interface DshBridgeCompat {
  /** 桥实现版本（与 `control.json` 顶层 `bridgeVersion` 相同；重复便于独立解析）。 */
  bridgeVersion: number
  /** 桥认识的控制帧 schema 版本（当前 {@link BRIDGE_CONTROL_SCHEMA_VERSION}）。 */
  controlSchema: number
  /** 桥声明的 DSH SemVer 范围（`engines.dsh`）；桥读不到自己的 manifest 时为 null。 */
  dshRange: string | null
}

/**
 * 解析 `compat` 块（纯函数、绝不抛异常）。
 * 任一字段缺失/类型非法 → null（消费方按"未声明 compat"降级，不做猜测）。
 */
export function parseDshBridgeCompat(value: unknown): DshBridgeCompat | null {
  if (!isRecord(value)) return null
  const bridgeVersion = value.bridgeVersion
  if (
    typeof bridgeVersion !== 'number' ||
    !Number.isSafeInteger(bridgeVersion) ||
    bridgeVersion <= 0
  ) {
    return null
  }
  const controlSchema = value.controlSchema
  if (
    typeof controlSchema !== 'number' ||
    !Number.isSafeInteger(controlSchema) ||
    controlSchema <= 0
  ) {
    return null
  }
  const dshRange = value.dshRange
  if (dshRange !== null && dshRange !== undefined && typeof dshRange !== 'string') return null
  return {
    bridgeVersion,
    controlSchema,
    dshRange: typeof dshRange === 'string' && dshRange.trim().length > 0 ? dshRange.trim() : null
  }
}

/** `~/.dsh/aventurine-pet/control.json` 的文件结构（Wave 3 新增，加法式契约）。 */
export interface DshBridgeControlFile {
  /** 固定为 {@link BRIDGE_CONTROL_SCHEMA_VERSION} */
  schemaVersion: number
  /** 写入时间戳（毫秒） */
  ts: number
  action: DshBridgeControlAction
  /** 写控制帧的 DSH 进程 pid（可选；排障/强耦合判定用） */
  dshPid?: number
  /** 桥插件实现版本（可选；Wave 3 起写入，便于确认 HMR 是否加载了新代码） */
  bridgeVersion?: number
  /** 桥的运行时兼容自述（v4 起写入；旧帧无此键 → 桌宠走 legacy 回退） */
  compat?: DshBridgeCompat
}

/** `control.json` 允许读取的最大字节数（控制帧应 <1KB；防御超大/伪造文件）。 */
export const BRIDGE_CONTROL_MAX_BYTES = 4096

/** 桥插件心跳周期（毫秒）。 */
export const BRIDGE_HEARTBEAT_MS = 5000

/** 判在线的 TTL（毫秒）：now - status.ts < 30000 视为 DSH 在线。 */
export const BRIDGE_ONLINE_TTL_MS = 30000

/** events.jsonl 轮转阈值（字节，5MB）。 */
export const BRIDGE_ROTATE_BYTES = 5 * 1024 * 1024

/** 单行事件允许的最大字节数（64KB）；超长行应被丢弃，防止内存膨胀。 */
export const BRIDGE_MAX_LINE_BYTES = 64 * 1024

/** 冻结的事件类型白名单（顺序即 §8 顺序）。 */
export const DSH_EVENT_TYPES = [
  'agent/status',
  'task/start',
  'task/end',
  'task/error',
  'session/event'
] as const satisfies readonly DshEventType[]

/** `~/.dsh/aventurine-pet/status.json` 的文件结构。 */
export interface DshBridgeStatusFile {
  /** 心跳写入时间戳（毫秒） */
  ts: number
  running: boolean
  agents: number
  lastEventAt: number
  lastType: DshEventType | null
  /**
   * 显式离线标记（可选）：桥插件退出时写 `{ ts: Date.now(), offline: true, running: false, ... }`。
   * 为 true 时即使 ts 新鲜也判 offline；缺省/undefined 表示按心跳新鲜度判断。
   */
  offline?: boolean
  /** 桥的运行时兼容自述（v4 起心跳帧携带；缺省 → 按无 compat 处理） */
  compat?: DshBridgeCompat
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

/** 判断任意值是否为合法事件类型。 */
export function isDshEventType(value: unknown): value is DshEventType {
  return (
    typeof value === 'string' && (DSH_EVENT_TYPES as readonly string[]).includes(value)
  )
}

/** 判断任意值是否为合法 `DshEvent`（ts 有限数值 + type 白名单 + payload 为普通对象）。 */
export function isDshEvent(value: unknown): value is DshEvent {
  if (!isRecord(value)) return false
  if (!isFiniteNumber(value.ts)) return false
  if (!isDshEventType(value.type)) return false
  if (!isRecord(value.payload)) return false
  return true
}

/**
 * R-24：`DshEvent.payload` 的字段白名单（11 个安全标量）。
 *
 * 与桥插件（`bridge/dsh-aventurine-bridge/lib/index.js`）实际写入的字段一致：
 * - `agent` / `status`：`agent/status`、`task/*` 的 agent 与运行状态；
 * - `reason` / `reasonKind`：`task/end`（如 `disposed`）、`task/error`（`error`）；
 * - `turn` / `step` / `seq`：进度与去重用的有限整数；
 * - `message`：任务错误摘要（桥插件侧已截断到 512 字符）；
 * - `text`：assistant/message 的回复正文（Wave 3 气泡同步；桥插件侧截断到 8000 字符）；
 * - `sessionId` / `eventType`：`session/event` 透传字段。
 *
 * renderer（`reactions/dsh.ts` / `reactions/dsh-dialogue.ts`）与 main（`desktop/dsh-watch.ts`）
 * 只消费上述字段，因此清洗不会改变现有行为；写入方新增字段必须同步扩展本白名单。
 */
export const DSH_EVENT_PAYLOAD_KEYS = [
  'agent',
  'status',
  'reason',
  'reasonKind',
  'turn',
  'step',
  'message',
  'text',
  'sessionId',
  'eventType',
  'seq'
] as const

/** `DshEvent.payload` 白名单键的联合类型。 */
export type DshEventPayloadKey = (typeof DSH_EVENT_PAYLOAD_KEYS)[number]

/** `message` 允许的最大字符数（与桥插件写入侧截断一致；错误摘要可能较长）。 */
export const DSH_EVENT_MESSAGE_MAX_CHARS = 512

/**
 * `text` 允许的最大字符数（Wave 3：assistant/message 的回复正文，供桌宠气泡同步）。
 * 8000 字符（UTF-16 code unit）≈ 最多 24KB UTF-8，远小于 64KB 单行硬上限；
 * 桥插件写入侧同口径截断，读侧 `sanitizeDshEventPayload` 再截断一次（零信任）。
 */
export const DSH_EVENT_TEXT_MAX_CHARS = 8000

/** 其余字符串字段允许的最大字符数。 */
export const DSH_EVENT_STRING_MAX_CHARS = 256

/** 只接受有限整数的字段（turn / step / seq）。 */
const DSH_EVENT_INTEGER_KEYS: ReadonlySet<string> = new Set(['turn', 'step', 'seq'])

/** 白名单键集合（判断「未知键」用）。 */
const DSH_EVENT_WHITELIST_KEYS: ReadonlySet<string> = new Set(DSH_EVENT_PAYLOAD_KEYS)

/**
 * 原型污染危险键：即使值是标量也**永远丢弃**（`Object.entries` 读不到 `__proto__` 的
 * 原型赋值，但 `JSON.parse('{"__proto__": "x"}')` 会产生同名的自有属性，赋值时必须防住）。
 */
const DSH_EVENT_FORBIDDEN_KEYS: ReadonlySet<string> = new Set([
  '__proto__',
  'prototype',
  'constructor'
])

/**
 * R-24：`DshEvent.payload` 半白名单清洗（纯函数、绝不抛异常）。
 *
 * **已知字段（`DSH_EVENT_PAYLOAD_KEYS`）严格校验**：
 * - 字符串：空串丢弃，超长按 `message ≤ 512` / 其余 `≤ 256` 字符**截断**（不丢弃，
 *   保留错误摘要可读性）；
 * - `turn` / `step` / `seq`：只接受有限安全整数，浮点 / NaN / 字符串 / null 一律丢弃；
 * - 非字符串 / 非整数的已知字段丢弃。
 *
 * **未知字段（半白名单）**：
 * - 只透传 JSON 标量（string / number / boolean）—— 它们无结构、renderer 也从不读取，
 *   保留可兼容桥文件/测试夹具的历史字段（如 `tests/dsh-watch.test.ts` 的大积压夹具用
 *   `payload.i` 校验顺序）；
 * - **对象 / 数组 / null / 函数等结构化值一律丢弃**（R-24 的实际加固点：桥文件被同用户
 *   进程写入时，不把嵌套结构透传给 renderer）；`__proto__` / `prototype` / `constructor`
 *   永远丢弃。
 *
 * 非普通对象输入（null / 数组 / 字符串…）→ `{}`。
 */
export function sanitizeDshEventPayload(
  payload: Record<string, unknown>
): Record<string, unknown> {
  if (!isRecord(payload)) return {}
  const sanitized: Record<string, unknown> = {}

  // 1) 已知字段：严格类型 / 截断 / 整数校验。
  for (const key of DSH_EVENT_PAYLOAD_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(payload, key)) continue
    const value = payload[key]
    if (DSH_EVENT_INTEGER_KEYS.has(key)) {
      // 有限安全整数：排除 NaN / ±Infinity / 浮点 / 超出 2^53 的精度丢失值。
      if (typeof value !== 'number' || !Number.isSafeInteger(value)) continue
      sanitized[key] = value
      continue
    }
    if (typeof value !== 'string' || value.length === 0) continue
    const maxChars =
      key === 'message'
        ? DSH_EVENT_MESSAGE_MAX_CHARS
        : key === 'text'
          ? DSH_EVENT_TEXT_MAX_CHARS
          : DSH_EVENT_STRING_MAX_CHARS
    sanitized[key] = value.length > maxChars ? value.slice(0, maxChars) : value
  }

  // 2) 未知字段：只保留无结构的 JSON 标量；结构化值丢弃（见函数注释的兼容说明）。
  for (const [key, value] of Object.entries(payload)) {
    if (DSH_EVENT_WHITELIST_KEYS.has(key) || DSH_EVENT_FORBIDDEN_KEYS.has(key)) continue
    if (typeof value === 'string') {
      if (value.length > 0) sanitized[key] = value
      continue
    }
    if (typeof value === 'number') {
      if (Number.isFinite(value)) sanitized[key] = value
      continue
    }
    if (typeof value === 'boolean') sanitized[key] = value
  }

  return sanitized
}

/**
 * 计算字符串的 UTF-8 字节数（环境中立实现，不依赖 Buffer/TextEncoder）。
 * 用于在 `src/shared` 内强制执行 `BRIDGE_MAX_LINE_BYTES` 上限。
 */
export function utf8ByteLength(text: string): number {
  let bytes = 0
  for (const char of text) {
    const codePoint = char.codePointAt(0) ?? 0
    if (codePoint <= 0x7f) bytes += 1
    else if (codePoint <= 0x7ff) bytes += 2
    else if (codePoint <= 0xffff) bytes += 3
    else bytes += 4
  }
  return bytes
}

/** 单行是否超过 `BRIDGE_MAX_LINE_BYTES`（64KB，UTF-8 字节）。 */
export function isBridgeLineTooLong(line: string): boolean {
  return utf8ByteLength(line) > BRIDGE_MAX_LINE_BYTES
}

/**
 * 解析 events.jsonl 的一行。
 * 空行 / 半行 / 非 JSON / 字段不合法 / 超长行（>64KB）一律返回 null（绝不抛异常），
 * 调用方（B7 tailer）可安全跳过。
 *
 * R-24：解析成功后 payload 还会过 `sanitizeDshEventPayload` 半白名单（已知字段严格校验 /
 * 字符串截断 / turn/step/seq 只留有限整数；未知字段只透传 JSON 标量、结构化值丢弃）。
 * `isDshEvent` 的语义不变（仍只校验 ts/type/payload 为普通对象），其它调用方不受影响。
 */
export function parseDshEventLine(line: string): DshEvent | null {
  if (typeof line !== 'string') return null
  if (isBridgeLineTooLong(line)) return null
  const trimmed = line.trim()
  if (trimmed.length === 0) return null

  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch {
    return null
  }

  if (!isDshEvent(parsed)) return null
  return {
    ts: parsed.ts,
    type: parsed.type,
    payload: sanitizeDshEventPayload(parsed.payload)
  }
}

/** 判断任意值是否为合法 `status.json` 内容。 */
export function isDshBridgeStatusFile(value: unknown): value is DshBridgeStatusFile {
  if (!isRecord(value)) return false
  if (!isFiniteNumber(value.ts)) return false
  if (typeof value.running !== 'boolean') return false
  if (!isFiniteNumber(value.agents)) return false
  if (!isFiniteNumber(value.lastEventAt)) return false
  if (value.lastType !== null && !isDshEventType(value.lastType)) return false
  if (value.offline !== undefined && typeof value.offline !== 'boolean') return false
  // compat 是加法式契约：缺省合法；存在但形状非法 → 整帧无效（桥是我们的代码，坏形状视为 bug，
  // 消费方应按"无状态"降级而不是带病使用）。
  if (value.compat !== undefined && parseDshBridgeCompat(value.compat) === null) return false
  return true
}

/**
 * 把 `status.json` 文件内容折算为渲染层使用的 `DshStatus`。
 * - `online = 文件存在 && !file.offline && now >= file.ts && now - file.ts < BRIDGE_ONLINE_TTL_MS`
 *   （未来时间戳不算 online，避免时钟回拨/伪造导致永久在线）
 * - 文件不存在/为空 → 全量离线默认值
 * - offline 时仍透传 file 里的 running/lastEventAt/lastType 原始值，
 *   消费方（B7）应只以 `online` 决定是否做 DSH 反应，避免陈旧文件误触发。
 */
export function toDshStatus(
  file: DshBridgeStatusFile | null | undefined,
  now: number
): DshStatus {
  if (!file) {
    return { online: false, running: false, lastEventAt: 0, lastType: null }
  }

  const online =
    file.offline !== true &&
    isFiniteNumber(now) &&
    isFiniteNumber(file.ts) &&
    now >= file.ts &&
    now - file.ts < BRIDGE_ONLINE_TTL_MS

  return {
    online,
    running: file.running,
    lastEventAt: file.lastEventAt,
    lastType: file.lastType
  }
}

/**
 * 判断任意值是否为合法 `control.json` 内容（Wave 3 冻结）。
 *
 * - `schemaVersion` 必须等于 {@link BRIDGE_CONTROL_SCHEMA_VERSION}（未来版本不兼容 → 视为无效，
 *   由消费方按「无控制帧」降级，不做猜测）；
 * - `ts` 有限数值；`action` 二值白名单；`dshPid` 可选，存在时必须是正安全整数。
 */
export function isDshBridgeControlFile(value: unknown): value is DshBridgeControlFile {
  if (!isRecord(value)) return false
  if (value.schemaVersion !== BRIDGE_CONTROL_SCHEMA_VERSION) return false
  if (!isFiniteNumber(value.ts)) return false
  if (value.action !== 'attached' && value.action !== 'detached') return false
  if (value.dshPid !== undefined) {
    if (
      typeof value.dshPid !== 'number' ||
      !Number.isSafeInteger(value.dshPid) ||
      value.dshPid <= 0
    ) {
      return false
    }
  }
  if (value.bridgeVersion !== undefined) {
    if (
      typeof value.bridgeVersion !== 'number' ||
      !Number.isSafeInteger(value.bridgeVersion) ||
      value.bridgeVersion <= 0
    ) {
      return false
    }
  }
  // v4 起可带 compat；缺省合法、存在但形状非法 → 整帧无效（见 isDshBridgeStatusFile 注释）。
  if (value.compat !== undefined && parseDshBridgeCompat(value.compat) === null) return false
  return true
}

/**
 * 解析 `control.json` 文本（纯函数、绝不抛异常）。
 *
 * 空串 / 非 JSON / 非法结构 / 超过 `BRIDGE_CONTROL_MAX_BYTES` → null；
 * 调用方（桌宠 dsh-watch）对 null 静默跳过。
 */
export function parseDshBridgeControlFile(text: unknown): DshBridgeControlFile | null {
  if (typeof text !== 'string') return null
  if (utf8ByteLength(text) > BRIDGE_CONTROL_MAX_BYTES) return null
  const trimmed = text.trim()
  if (trimmed.length === 0) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch {
    return null
  }
  return isDshBridgeControlFile(parsed) ? parsed : null
}

/** 桥安装方式（写入 `install.json`；仅用于排障与兼容判定，不参与安全决策）。 */
export type DshBridgeInstallMethod = 'live-copy-insert' | 'bundle' | 'unknown'

/**
 * 桥安装清单（`~/.dsh/aventurine-pet/install.json`，激活脚本写入）。
 *
 * 存在的理由：桥可能被 DSH 的 `engines.dsh` 闸门**静默禁用**（桥一次都不会 apply），
 * 此时 `control/status/compat` 全部不可达；桌宠需要另一条路径得知"装了什么桥、它支持
 * 哪个 DSH 范围、为什么可能没加载"，才能给出可操作提示而不是笼统"未连接"。
 */
export interface DshBridgeInstallManifest {
  /** 固定为 {@link BRIDGE_INSTALL_SCHEMA_VERSION}。 */
  schemaVersion: number
  /** 写入时间（毫秒）。 */
  installedAt: number
  installMethod: DshBridgeInstallMethod
  /** 桥插件入口（绝对路径或包名；排障用）。 */
  bridgeEntry: string
  /** 桥包名（稳定身份，用于 DSH 版本豁免键）。 */
  bridgePackageName: string
  /** 桥包版本（semver 文本）。 */
  bridgePackageVersion: string
  /** 桥实现版本（= `BRIDGE_PLUGIN_VERSION`）。 */
  bridgeVersion: number
  /** 桥认识的控制帧 schema 版本。 */
  controlSchema: number
  /** 桥声明的 DSH 范围（`engines.dsh`）；缺失/非法为 null。 */
  dshRange: string | null
  /** 安装时的 DSH 版本（排障用；可缺省）。 */
  dshVersionAtInstall?: string | null
  /** 安装时记录的桌宠 app 路径（排障用；可缺省）。 */
  petAppPath?: string | null
  /** 安装时记录的桌宠 bundle id（排障用；可缺省）。 */
  petBundleId?: string | null
}

/** 只接受普通对象。 */
function isManifestRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 读取可选的非空字符串字段（缺失/非法 → null）。 */
function optionalNonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null
}

/**
 * 解析 `install.json` 文本（纯函数、绝不抛异常）。
 * 超长 / 非 JSON / schemaVersion 不匹配 / 必填字段非法 → null。
 */
export function parseDshBridgeInstallManifest(text: unknown): DshBridgeInstallManifest | null {
  if (typeof text !== 'string') return null
  if (utf8ByteLength(text) > BRIDGE_INSTALL_MAX_BYTES) return null
  const trimmed = text.trim()
  if (trimmed.length === 0) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch {
    return null
  }
  if (!isManifestRecord(parsed)) return null
  if (parsed.schemaVersion !== BRIDGE_INSTALL_SCHEMA_VERSION) return null
  const installedAt = parsed.installedAt
  if (typeof installedAt !== 'number' || !Number.isFinite(installedAt) || installedAt < 0) return null
  const method = parsed.installMethod
  const installMethod: DshBridgeInstallMethod =
    method === 'live-copy-insert' || method === 'bundle' ? method : 'unknown'
  const bridgeEntry = optionalNonEmptyString(parsed.bridgeEntry)
  const bridgePackageName = optionalNonEmptyString(parsed.bridgePackageName)
  const bridgePackageVersion = optionalNonEmptyString(parsed.bridgePackageVersion)
  if (bridgeEntry === null || bridgePackageName === null || bridgePackageVersion === null) return null
  const bridgeVersion = parsed.bridgeVersion
  if (
    typeof bridgeVersion !== 'number' ||
    !Number.isSafeInteger(bridgeVersion) ||
    bridgeVersion <= 0
  ) {
    return null
  }
  const controlSchema = parsed.controlSchema
  if (
    typeof controlSchema !== 'number' ||
    !Number.isSafeInteger(controlSchema) ||
    controlSchema <= 0
  ) {
    return null
  }
  const dshRangeRaw = parsed.dshRange
  if (dshRangeRaw !== null && dshRangeRaw !== undefined && typeof dshRangeRaw !== 'string') return null
  const dshRange =
    typeof dshRangeRaw === 'string' && dshRangeRaw.trim().length > 0 ? dshRangeRaw.trim() : null
  const optionalVersion = (value: unknown): string | null => optionalNonEmptyString(value)
  return {
    schemaVersion: BRIDGE_INSTALL_SCHEMA_VERSION,
    installedAt,
    installMethod,
    bridgeEntry,
    bridgePackageName,
    bridgePackageVersion,
    bridgeVersion,
    controlSchema,
    dshRange,
    dshVersionAtInstall: optionalVersion(parsed.dshVersionAtInstall),
    petAppPath: optionalVersion(parsed.petAppPath),
    petBundleId: optionalVersion(parsed.petBundleId)
  }
}

/** 桥故障诊断（`bridge-error.json`，桥 `apply` 失败时写入）。 */
export interface DshBridgeDiagnostic {
  /** 固定为 {@link BRIDGE_INSTALL_SCHEMA_VERSION}。 */
  schemaVersion: number
  /** 写入时间（毫秒）。 */
  ts: number
  /** 故障阶段（如 `apply` / `heartbeat` / `launch-pet`）。 */
  phase: string
  /** 一行可读错误（已截断）。 */
  message: string
  /** 桥实现版本（可缺省）。 */
  bridgeVersion?: number
  /** 桥声明的 DSH 范围（可缺省）。 */
  dshRange?: string | null
}

/** 单条诊断 message 的最大字符数（防御被污染的文件撑大内存）。 */
export const BRIDGE_DIAGNOSTIC_MESSAGE_MAX_CHARS = 1024

/**
 * 解析 `bridge-error.json` 文本（纯函数、绝不抛异常）。
 * 超长 / 非 JSON / schemaVersion 不匹配 / 必填字段非法 → null。
 */
export function parseDshBridgeDiagnostic(text: unknown): DshBridgeDiagnostic | null {
  if (typeof text !== 'string') return null
  if (utf8ByteLength(text) > BRIDGE_DIAGNOSTIC_MAX_BYTES) return null
  const trimmed = text.trim()
  if (trimmed.length === 0) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch {
    return null
  }
  if (!isManifestRecord(parsed)) return null
  if (parsed.schemaVersion !== BRIDGE_INSTALL_SCHEMA_VERSION) return null
  const ts = parsed.ts
  if (typeof ts !== 'number' || !Number.isFinite(ts)) return null
  const phase = optionalNonEmptyString(parsed.phase)
  const message = optionalNonEmptyString(parsed.message)
  if (phase === null || message === null) return null
  const bridgeVersion = parsed.bridgeVersion
  if (
    bridgeVersion !== undefined &&
    (typeof bridgeVersion !== 'number' || !Number.isSafeInteger(bridgeVersion) || bridgeVersion <= 0)
  ) {
    return null
  }
  const dshRangeRaw = parsed.dshRange
  if (dshRangeRaw !== null && dshRangeRaw !== undefined && typeof dshRangeRaw !== 'string') return null
  return {
    schemaVersion: BRIDGE_INSTALL_SCHEMA_VERSION,
    ts,
    phase,
    message:
      message.length > BRIDGE_DIAGNOSTIC_MESSAGE_MAX_CHARS
        ? message.slice(0, BRIDGE_DIAGNOSTIC_MESSAGE_MAX_CHARS)
        : message,
    ...(bridgeVersion === undefined ? {} : { bridgeVersion }),
    ...(typeof dshRangeRaw === 'string' && dshRangeRaw.trim().length > 0
      ? { dshRange: dshRangeRaw.trim() }
      : { dshRange: null })
  }
}
