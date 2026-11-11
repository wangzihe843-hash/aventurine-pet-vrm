/**
 * DSH 桥插件常量（host 侧）。
 *
 * 单一来源：`src/shared/bridge-schema.ts`（M0-2 / Wave 3 契约 v2，冻结契约，桌宠 app 侧 B7 读取）。
 * 本插件是独立 npm 包，不能 import app 源码，因此在这里保留一份**副本**；
 * 一致性由 `tests/bridge-plugin.test.ts` 的 parity 用例逐一断言，禁止在任何其它
 * 位置再写魔法字符串。修改任一侧都必须同步另一侧并跑 parity 测试。
 *
 * 契约快照（PLAN §8 / §9 / wave3 设计 §3）：
 * - `~/.dsh/aventurine-pet/status.json`：覆盖写的心跳状态（5s 一帧，退出写 offline）。
 * - `~/.dsh/aventurine-pet/events.jsonl`：追加写的 NDJSON，每行一个 DshEvent；
 *   单行超过 64KB 丢弃，文件超过 5MB 轮转为 `events.jsonl.1`。
 * - `~/.dsh/aventurine-pet/control.json`：桥实例状态（apply→attached / dispose→detached，
 *   原子覆盖写；只用于区分「桥没了」，不能单独证明 DSH 进程退出——HMR 重载也会 detach）。
 */

/** `~/.dsh/` 下的桥目录名（完整路径：`~/.dsh/aventurine-pet/`）。 */
export const BRIDGE_DIR_NAME = 'aventurine-pet'

/** 心跳状态文件名。 */
export const BRIDGE_STATUS_FILE = 'status.json'

/** 事件流文件名（NDJSON）。 */
export const BRIDGE_EVENTS_FILE = 'events.jsonl'

/** 控制文件名（桥实例 attached/detached 状态，原子覆盖写）。 */
export const BRIDGE_CONTROL_FILE = 'control.json'

/** control.json 的冻结 schema 版本（与 `src/shared/bridge-schema.ts` 同步）。 */
export const BRIDGE_CONTROL_SCHEMA_VERSION = 1

/**
 * 桥插件实现版本（写入 control.json 顶层 `bridgeVersion` 与每帧 `compat.bridgeVersion`）。
 *
 * 版本语义（单一事实源：`src/shared/bridge-schema.ts`）：
 * - v3 = 现网 legacy：`control/status` 无 `compat` 块，桌宠用 legacy 范围回退判定；
 * - v4 = 兼容性安全 v2：`control/status` **每帧**带 `compat`（`bridgeVersion/controlSchema/
 *   dshRange`），桌宠据此做运行时兼容判定；v4 起 `dshRange` 必须可读，否则桌宠按
 *   `range-missing` 判不兼容（桥不能自称兼容）。
 *
 * 用途：运维/激活时确认「HMR 重新加载的是不是新代码」（DSH HMR 对同一模块路径可能复用
 * Node ESM 缓存；当前实例需用新模块路径才能生效时，据此核对），也是桌宠兼容判定的第一信号。
 */
export const BRIDGE_PLUGIN_VERSION = 4

/**
 * 桥安装清单 / 故障诊断共用的 schema 版本（`install.json` 由激活脚本写，
 * `bridge-error.json` 由桥 apply 失败时写；两者 schemaVersion 语义同源，见共享契约
 * `DshBridgeInstallManifest` / `DshBridgeDiagnostic`）。
 */
export const BRIDGE_INSTALL_SCHEMA_VERSION = 1

/**
 * 桥故障诊断文件名（v4）：`apply` 失败时写入，桥被 DSH 版本闸门禁用/装坏时桌宠据此解释
 * 「桥为什么没加载」（bridge 一次都不会 apply 时只能靠安装清单，见 `install.json`）。
 */
export const BRIDGE_DIAGNOSTIC_FILE = 'bridge-error.json'

/** 诊断 message 的最大字符数（写入侧截断；读取侧共享契约再截断一次）。 */
export const BRIDGE_DIAGNOSTIC_MESSAGE_MAX_CHARS = 1024

/** 桥插件心跳周期（毫秒）。 */
export const BRIDGE_HEARTBEAT_MS = 5000

/** 判在线的 TTL（毫秒）：`now - status.ts < 30000` 视为 DSH 在线。 */
export const BRIDGE_ONLINE_TTL_MS = 30000

/** events.jsonl 轮转阈值（字节，5MB）。 */
export const BRIDGE_ROTATE_BYTES = 5 * 1024 * 1024

/** 单行事件允许的最大字节数（64KB）；超长行丢弃，防止内存膨胀。 */
export const BRIDGE_MAX_LINE_BYTES = 64 * 1024

/**
 * `assistant/message` 写入 `payload.text` 的最大字符数（UTF-16 code unit，8000）。
 * 与 `src/shared/bridge-schema.ts` 的 `DSH_EVENT_TEXT_MAX_CHARS` 一致：写入侧截断 +
 * 读取侧 `sanitizeDshEventPayload` 再截断一次（双保险，防手写脏文件）。
 */
export const DSH_EVENT_TEXT_MAX_CHARS = 8000

/**
 * 强制禁用「拉起桌宠」的环境变量：值为 `'1'` 时即使 config.launchPet=true 也不 spawn。
 * 测试/canary/隔离验收用（防止验证流程真的 open 桌宠 app）。
 */
export const BRIDGE_DISABLE_LAUNCH_ENV = 'AVENTURINE_BRIDGE_DISABLE_LAUNCH'

/** 冻结的事件类型白名单（顺序即 PLAN §8 顺序）。 */
export const DSH_EVENT_TYPES = [
  'agent/status',
  'task/start',
  'task/end',
  'task/error',
  'session/event'
]

/**
 * 短名别名（值来自上面的契约常量，不是第二份魔法字符串）。
 * 插件内部统一用 `BRIDGE_*` 全名；别名便于阅读与外部引用。
 */
export const STATUS_FILE = BRIDGE_STATUS_FILE
export const EVENTS_FILE = BRIDGE_EVENTS_FILE
export const CONTROL_FILE = BRIDGE_CONTROL_FILE
export const DIAGNOSTIC_FILE = BRIDGE_DIAGNOSTIC_FILE
export const HEARTBEAT_MS = BRIDGE_HEARTBEAT_MS
export const ONLINE_TTL_MS = BRIDGE_ONLINE_TTL_MS
export const ROTATE_BYTES = BRIDGE_ROTATE_BYTES
export const MAX_LINE_BYTES = BRIDGE_MAX_LINE_BYTES
