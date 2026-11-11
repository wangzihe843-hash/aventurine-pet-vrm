/**
 * dsh-canary 的纯函数库（无 IO、无子进程）。
 *
 * 职责：解析并校验桌宠 DSH 桥（bridge/dsh-aventurine-bridge）在 canary 运行后写出的
 * `status.json` / `events.jsonl` / `control.json`，把「DSH 事件契约是否仍然匹配」变成
 * 可断言的错误列表。供 `scripts/dsh-canary.mjs`（CLI）与 `tests/dsh-canary-lib.test.ts`
 * （单测）共用。
 *
 * Wave 3（v2）扩展：
 * - 成功回合断言：`events.jsonl` 必须出现带非空 `payload.text` 的 `assistant/message`
 *   （`session/event`），可精确比对 mock LLM 注入文本（`expectedText`）；
 * - 隐私断言：`forbiddenSubstrings`（user 输入 / reasoning 哨兵）不得出现在 events 原文；
 * - `control.json` 生命周期断言：解析 + `attached → detached` 顺序（`validateControlArtifacts`）。
 *
 * 设计原则：
 * - 与 app 侧共享契约保持一致：`src/shared/bridge-schema.ts` 是文件契约的冻结实现，
 *   这里的规则是它面向 canary 的**子集 + 事件序列断言**（单测会做交叉校验）；
 * - 全部失败都返回结构化 `errors`，不抛异常（CLI 负责打印与退出码）；
 * - 校验只读文本，不访问文件系统；
 * - 向后兼容：新增断言全部是可选参数，旧调用（失败回合）行为不变。
 */

/** 单条事件允许的最大序列化长度（与桥插件单行上限一致：64KB）。 */
export const MAX_EVENT_LINE_BYTES = 64 * 1024

/** status.json 允许的最大字节数（心跳文件应 <1KB；防御超大/伪造文件）。 */
export const MAX_STATUS_BYTES = 256 * 1024

/** control.json 允许的最大字节数（控制帧应 <1KB；与共享契约 BRIDGE_CONTROL_MAX_BYTES 一致）。 */
export const MAX_CONTROL_BYTES = 4096

/** install.json 允许的最大字节数（与共享契约 BRIDGE_INSTALL_MAX_BYTES 一致）。 */
export const MAX_INSTALL_BYTES = 16 * 1024

/** bridge-error.json 允许的最大字节数（与共享契约 BRIDGE_DIAGNOSTIC_MAX_BYTES 一致）。 */
export const MAX_DIAGNOSTIC_BYTES = 16 * 1024

/** install.json / bridge-error.json 的 schema 版本（与共享契约 BRIDGE_INSTALL_SCHEMA_VERSION 一致）。 */
export const INSTALL_SCHEMA_VERSION = 1

/** 安装方式白名单（与共享契约 `DshBridgeInstallMethod` 一致）。 */
export const INSTALL_METHODS = ['live-copy-insert', 'bundle', 'unknown']

/** bridge-error.json 允许的 phase 白名单（canary 的 C6 断言 `phase === 'apply'`）。 */
export const DIAGNOSTIC_PHASES = ['apply', 'heartbeat', 'launch-pet', 'dispose']

/** bridge-error.json message 最大字符数（与共享契约 BRIDGE_DIAGNOSTIC_MESSAGE_MAX_CHARS 一致）。 */
export const DIAGNOSTIC_MESSAGE_MAX_CHARS = 1024

/** 合法的 control action（与共享契约 `DshBridgeControlAction` 一致）。 */
export const CONTROL_ACTIONS = ['attached', 'detached']

/** 一条 DshEvent 的最小形状（payload 必须是对象；内部键不冻结，见桥 README）。 */
function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 有限非负数（时间戳/计数）。 */
function isNonNegativeNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

/** 正安全整数（pid 等）。 */
function isPositiveSafeInteger(value) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

/** 非空字符串（trim 后非空）→ trim 后的值；否则 null。 */
function nonEmptyStringOrNull(value) {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null
}

/**
 * 解析 `compat` 块（v4 桥的运行时兼容自述；纯函数、绝不抛异常）。
 *
 * 与共享契约 `parseDshBridgeCompat()` 同规则（独立实现，单测交叉校验）：
 * `bridgeVersion` / `controlSchema` 必须是正安全整数；`dshRange` 允许 null/缺失/字符串，
 * 空串归一为 null；任一字段类型非法 → null（消费方按"未声明 compat"降级）。
 *
 * @param {unknown} value
 * @returns {{ bridgeVersion: number, controlSchema: number, dshRange: string | null } | null}
 */
export function parseCompat(value) {
  if (!isRecord(value)) return null
  if (!isPositiveSafeInteger(value.bridgeVersion)) return null
  if (!isPositiveSafeInteger(value.controlSchema)) return null
  const dshRange = value.dshRange
  if (dshRange !== null && dshRange !== undefined && typeof dshRange !== 'string') return null
  return {
    bridgeVersion: value.bridgeVersion,
    controlSchema: value.controlSchema,
    dshRange: nonEmptyStringOrNull(dshRange)
  }
}

/**
 * 解析 `status.json` 文本。
 *
 * @param {string} text 文件内容（UTF-8）
 * @returns {{ ok: true, status: Record<string, unknown> } | { ok: false, error: string }}
 */
export function parseStatusFile(text) {
  if (typeof text !== 'string') return { ok: false, error: 'status.json 内容不是字符串' }
  if (Buffer.byteLength(text, 'utf8') > MAX_STATUS_BYTES) {
    return { ok: false, error: `status.json 超过 ${MAX_STATUS_BYTES} 字节上限` }
  }
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    return { ok: false, error: `status.json 不是合法 JSON：${error instanceof Error ? error.message : String(error)}` }
  }
  if (!isRecord(parsed)) return { ok: false, error: 'status.json 顶层必须是对象' }
  return { ok: true, status: parsed }
}

/**
 * 解析 `events.jsonl` 文本（NDJSON：每行一个事件；空行忽略）。
 *
 * @param {string} text 文件内容（UTF-8）
 * @returns {{ ok: true, events: Array<Record<string, unknown>> } | { ok: false, error: string }}
 */
export function parseEventsFile(text) {
  if (typeof text !== 'string') return { ok: false, error: 'events.jsonl 内容不是字符串' }
  const lines = text.split('\n')
  /** @type {Array<Record<string, unknown>>} */
  const events = []
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    if (line === '') continue
    if (Buffer.byteLength(line, 'utf8') > MAX_EVENT_LINE_BYTES) {
      return { ok: false, error: `events.jsonl 第 ${index + 1} 行超过 ${MAX_EVENT_LINE_BYTES} 字节上限` }
    }
    let parsed
    try {
      parsed = JSON.parse(line)
    } catch (error) {
      return {
        ok: false,
        error: `events.jsonl 第 ${index + 1} 行不是合法 JSON：${error instanceof Error ? error.message : String(error)}`
      }
    }
    if (!isRecord(parsed)) return { ok: false, error: `events.jsonl 第 ${index + 1} 行顶层必须是对象` }
    events.push(parsed)
  }
  return { ok: true, events }
}

/**
 * 解析 `control.json` 文本（纯函数、绝不抛异常）。
 *
 * 只做**形状**校验（与共享契约 `isDshBridgeControlFile` 同规则）：
 * - `schemaVersion` 正安全整数；`ts` 有限非负；`action ∈ {'attached','detached'}`；
 * - `dshPid` 可选，存在时必须是正安全整数；
 * - 非 JSON / 非对象 / 超长 / 脏字段 → `{ ok:false, error }`。
 *
 * 精确的 schemaVersion 比对放在 `validateControlArtifacts`（CLI 传入契约常量）。
 *
 * @param {unknown} text 文件内容（UTF-8）
 * @returns {{ ok: true, control: Record<string, unknown> } | { ok: false, error: string }}
 */
export function parseControlFile(text) {
  if (typeof text !== 'string') return { ok: false, error: 'control.json 内容不是字符串' }
  if (Buffer.byteLength(text, 'utf8') > MAX_CONTROL_BYTES) {
    return { ok: false, error: `control.json 超过 ${MAX_CONTROL_BYTES} 字节上限` }
  }
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    return { ok: false, error: `control.json 不是合法 JSON：${error instanceof Error ? error.message : String(error)}` }
  }
  if (!isRecord(parsed)) return { ok: false, error: 'control.json 顶层必须是对象' }
  if (!isPositiveSafeInteger(parsed.schemaVersion)) {
    return { ok: false, error: 'control.schemaVersion 必须是正安全整数' }
  }
  if (!isNonNegativeNumber(parsed.ts)) {
    return { ok: false, error: 'control.ts 必须是有限非负数（毫秒时间戳）' }
  }
  if (!CONTROL_ACTIONS.includes(parsed.action)) {
    return { ok: false, error: `control.action 必须是 ${CONTROL_ACTIONS.join(' / ')}，实际 ${JSON.stringify(parsed.action)}` }
  }
  if (parsed.dshPid !== undefined && !isPositiveSafeInteger(parsed.dshPid)) {
    return { ok: false, error: 'control.dshPid 存在时必须是正安全整数' }
  }
  if (parsed.bridgeVersion !== undefined && !isPositiveSafeInteger(parsed.bridgeVersion)) {
    return { ok: false, error: 'control.bridgeVersion 存在时必须是正安全整数' }
  }
  // v4 起可带 compat；缺省合法、存在但形状非法 → 整帧无效（与共享契约 isDshBridgeControlFile 同规则）。
  if (parsed.compat !== undefined && parseCompat(parsed.compat) === null) {
    return { ok: false, error: 'control.compat 存在时必须是 {bridgeVersion,controlSchema,dshRange} 合法形状' }
  }
  return { ok: true, control: parsed }
}

/**
 * 校验 `control.json` 生命周期（v2 契约 §3.2）。
 *
 * 断言：
 * 1. 最终帧可解析、`schemaVersion === expectedSchemaVersion`、`action === 'detached'`
 *    （DSH 正常退出 / HMR 卸载后桥 dispose 必须写 detached；SIGKILL 才可能残留 attached）；
 * 2. `ts` / `dshPid` 形状合法；
 * 3. canary 运行期间轮询观察到的 action 序列必须包含 `attached` 且早于 `detached`，
 *    最后观察到的是 `detached`（apply 挂载 → dispose 卸载的完整生命周期）。
 *
 * @param {{
 *   controlText: string | null,
 *   observedActions?: string[],
 *   expectedSchemaVersion?: number
 * }} input
 * @returns {{ errors: string[], control: Record<string, unknown> | null, observedActions: string[] }}
 */
export function validateControlArtifacts(input = {}) {
  const errors = []
  const {
    controlText,
    observedActions = [],
    expectedSchemaVersion = 1
  } = input

  const parsed = parseControlFile(controlText)
  const control = parsed.ok ? parsed.control : null
  if (!parsed.ok) errors.push(parsed.error)

  if (control !== null) {
    if (control.schemaVersion !== expectedSchemaVersion) {
      errors.push(
        `control.schemaVersion 应为 ${expectedSchemaVersion}，实际 ${JSON.stringify(control.schemaVersion)}`
      )
    }
    if (control.action !== 'detached') {
      errors.push(`control.action 退出后应为 'detached'，实际 ${JSON.stringify(control.action)}`)
    }
  }

  const actions = Array.isArray(observedActions)
    ? observedActions.filter((action) => typeof action === 'string')
    : []
  const attachedIndex = actions.indexOf('attached')
  const detachedIndex = actions.indexOf('detached')
  if (attachedIndex < 0) {
    errors.push('control.json 未观察到 applied 阶段（attached）控制帧')
  }
  if (detachedIndex < 0) {
    errors.push('control.json 未观察到 disposed 阶段（detached）控制帧')
  }
  if (attachedIndex >= 0 && detachedIndex >= 0 && attachedIndex > detachedIndex) {
    errors.push('control 生命周期顺序错误：detached 出现在 attached 之前')
  }
  if (actions.length > 0 && actions[actions.length - 1] !== 'detached') {
    errors.push(`control 最后观察到的 action 应为 'detached'，实际 ${JSON.stringify(actions[actions.length - 1])}`)
  }

  return { errors, control, observedActions: actions }
}

/**
 * 校验一次 canary 回合的桥产物（失败回合 / 成功回合共用）。
 *
 * 基础断言（对应桥 README 的事件映射）：
 * 1. `status.json` 在 DSH 退出后是显式离线帧：`offline:true`、`running:false`、`agents:0`、
 *    `lastType:'task/end'`；时间戳为有限数且 `ts >= lastEventAt`；
 * 2. `events.jsonl` 至少包含 `task/start` →（失败回合：`task/error`）→ `task/end` 且顺序正确；
 * 3. `task/start.payload.status === 'running'`，`task/end.payload.status === 'idle'`，
 *    失败回合 `task/error.payload.reasonKind === 'error'`；
 * 4. 同一 agent 的三段事件 agent 一致；
 * 5. 文件尾事件与 status 的 `lastEventAt/lastType` 对齐。
 *
 * v2 成功回合断言（可选，向后兼容）：
 * - `requireAssistantText: true`：必须出现 `session/event` + `payload.eventType === 'assistant/message'`
 *   且至少一条 `payload.text` 为非空字符串（DSH assistant 文本已透传）；
 * - `expectedText`：上面某条 `payload.text` 必须与 mock LLM 注入文本**完全一致**；
 * - `maxTextChars`：`payload.text` 不得超过该字符数（CLI 传桥契约 `DSH_EVENT_TEXT_MAX_CHARS`）；
 * - `forbiddenSubstrings`：这些子串（user 输入 / reasoning 哨兵）不得出现在 events.jsonl 原文中。
 *
 * @param {{
 *   statusText: string,
 *   eventsText: string,
 *   allowedTypes: Iterable<string>,
 *   expectError?: boolean,
 *   requireAssistantText?: boolean,
 *   expectedText?: string | null,
 *   maxTextChars?: number | null,
 *   forbiddenSubstrings?: string[]
 * }} input
 * @returns {{
 *   errors: string[],
 *   status: Record<string, unknown> | null,
 *   events: Array<Record<string, unknown>>,
 *   summary: {
 *     types: string[], agents: string[], lastType: string | null,
 *     eventCount: number, texts: string[]
 *   }
 * }}
 */
export function validateCanaryArtifacts(input) {
  const errors = []
  const {
    statusText,
    eventsText,
    allowedTypes,
    expectError = true,
    requireAssistantText = false,
    expectedText = null,
    maxTextChars = null,
    forbiddenSubstrings = []
  } = input
  const allowed = new Set(allowedTypes)

  const statusResult = parseStatusFile(statusText)
  const eventsResult = parseEventsFile(eventsText)
  const status = statusResult.ok ? statusResult.status : null
  const events = eventsResult.ok ? eventsResult.events : []
  if (!statusResult.ok) errors.push(statusResult.error)
  if (!eventsResult.ok) errors.push(eventsResult.error)

  // —— status.json 形状 ——
  if (status !== null) {
    if (status.offline !== true) errors.push('status.offline 必须是 true（插件 disposer 显式离线帧）')
    if (status.running !== false) errors.push('status.running 退出后必须是 false')
    if (status.agents !== 0) errors.push('status.agents 退出后必须是 0')
    if (!isNonNegativeNumber(status.ts)) errors.push('status.ts 必须是有限非负数（毫秒时间戳）')
    if (!isNonNegativeNumber(status.lastEventAt)) errors.push('status.lastEventAt 必须是有限非负数')
    if (status.lastType !== 'task/end') {
      errors.push(`status.lastType 应为 'task/end'，实际 ${JSON.stringify(status.lastType)}`)
    }
    if (typeof status.ts === 'number' && typeof status.lastEventAt === 'number' && status.ts < status.lastEventAt) {
      errors.push('status.ts 不能早于 status.lastEventAt')
    }
  }

  // —— events.jsonl 逐行形状 ——
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index]
    const label = `events.jsonl 第 ${index + 1} 行`
    if (!isNonNegativeNumber(event.ts)) errors.push(`${label} ts 必须是有限非负数`)
    if (typeof event.type !== 'string' || event.type === '') {
      errors.push(`${label} type 必须是非空字符串`)
    } else if (!allowed.has(event.type)) {
      errors.push(`${label} type=${JSON.stringify(event.type)} 不在桥的事件白名单内`)
    }
    if (!isRecord(event.payload)) errors.push(`${label} payload 必须是对象`)
  }

  // —— 隐私断言：user 输入 / reasoning 正文不得落盘（桥只写 assistant 输出）——
  if (Array.isArray(forbiddenSubstrings) && typeof eventsText === 'string') {
    for (const needle of forbiddenSubstrings) {
      if (typeof needle !== 'string' || needle.length === 0) continue
      if (eventsText.includes(needle)) {
        errors.push(`events.jsonl 中出现了不应落盘的隐私文本：${JSON.stringify(needle)}`)
      }
    }
  }

  // —— 失败/成功回合的事件序列 ——
  const findIndex = (type, after = -1) => events.findIndex((event, index) => index > after && event.type === type)
  const startIndex = findIndex('task/start')
  if (startIndex < 0) {
    errors.push('events.jsonl 缺少 task/start')
  } else {
    const startPayload = isRecord(events[startIndex].payload) ? events[startIndex].payload : {}
    if (startPayload.status !== 'running') {
      errors.push(`task/start.payload.status 应为 'running'，实际 ${JSON.stringify(startPayload.status)}`)
    }
  }

  let errorIndex = -1
  if (expectError) {
    errorIndex = findIndex('task/error', startIndex)
    if (errorIndex < 0) {
      errors.push('events.jsonl 缺少 task/error（DSH 失败回合未被桥映射）')
    } else {
      const payload = isRecord(events[errorIndex].payload) ? events[errorIndex].payload : {}
      if (payload.reasonKind !== 'error') {
        errors.push(`task/error.payload.reasonKind 应为 'error'，实际 ${JSON.stringify(payload.reasonKind)}`)
      }
      const message = payload.message
      if (message !== undefined && (typeof message !== 'string' || message.length > 512)) {
        errors.push('task/error.payload.message 必须是不超过 512 字符的字符串（隐私/行上限约束）')
      }
    }
  } else {
    // 成功回合：不允许出现 task/error。
    if (findIndex('task/error') >= 0) errors.push('成功回合不应出现 task/error')
  }

  const endIndex = findIndex('task/end', expectError ? errorIndex : startIndex)
  if (endIndex < 0) {
    errors.push('events.jsonl 缺少 task/end')
  } else {
    const payload = isRecord(events[endIndex].payload) ? events[endIndex].payload : {}
    if (payload.status !== 'idle') {
      errors.push(`task/end.payload.status 应为 'idle'，实际 ${JSON.stringify(payload.status)}`)
    }
  }

  // —— 同一 agent 的 start/error/end ——
  const sequenceIndexes = expectError ? [startIndex, errorIndex, endIndex] : [startIndex, endIndex]
  const agents = sequenceIndexes
    .map((index) => {
      const event = index >= 0 ? events[index] : undefined
      const payload = event && isRecord(event.payload) ? event.payload : {}
      return typeof payload.agent === 'string' ? payload.agent : null
    })
    .filter((value) => value !== null)
  const uniqueAgents = [...new Set(agents)]
  if (uniqueAgents.length > 1) errors.push(`task/start·task/error·task/end 的 agent 不一致：${uniqueAgents.join(', ')}`)
  if (sequenceIndexes.every((index) => index >= 0) && agents.length !== sequenceIndexes.length) {
    errors.push('task/start·task/error·task/end 的 payload.agent 必须是非空字符串')
  }

  // —— v2：assistant/message 文本已透传（成功回合核心断言）——
  const assistantMessages = events.filter(
    (event) =>
      event.type === 'session/event' &&
      isRecord(event.payload) &&
      event.payload.eventType === 'assistant/message'
  )
  const texts = []
  for (const event of assistantMessages) {
    const payload = isRecord(event.payload) ? event.payload : {}
    const text = payload.text
    if (text === undefined) continue
    if (typeof text !== 'string' || text.length === 0) {
      errors.push(`assistant/message 的 payload.text 必须是非空字符串，实际 ${JSON.stringify(text)}`)
      continue
    }
    if (typeof maxTextChars === 'number' && maxTextChars > 0 && text.length > maxTextChars) {
      errors.push(`assistant/message 的 payload.text 超过 ${maxTextChars} 字符上限（实际 ${text.length}）`)
    }
    texts.push(text)
  }
  if (requireAssistantText && texts.length === 0) {
    if (assistantMessages.length === 0) {
      errors.push('成功回合 events.jsonl 缺少 session/event assistant/message（assistant 文本未透传）')
    } else {
      errors.push('成功回合 assistant/message 事件都没有非空 payload.text（文本提取失效）')
    }
  }
  if (typeof expectedText === 'string' && expectedText.length > 0) {
    if (!texts.includes(expectedText)) {
      errors.push(
        `assistant/message payload.text 与 mock LLM 注入文本不一致：期望 ${JSON.stringify(expectedText)}，实际 ${JSON.stringify(texts)}`
      )
    }
  }

  // —— status 与文件尾对齐 ——
  if (status !== null && events.length > 0) {
    const last = events[events.length - 1]
    if (status.lastEventAt !== last.ts) {
      errors.push(`status.lastEventAt (${JSON.stringify(status.lastEventAt)}) 必须等于最后一条事件的 ts (${JSON.stringify(last.ts)})`)
    }
    if (status.lastType !== last.type) {
      errors.push(`status.lastType (${JSON.stringify(status.lastType)}) 必须等于最后一条事件的 type (${JSON.stringify(last.type)})`)
    }
  }

  return {
    errors,
    status,
    events,
    summary: {
      types: events.map((event) => (typeof event.type === 'string' ? event.type : '?')),
      agents: uniqueAgents,
      lastType: typeof status?.lastType === 'string' ? status.lastType : null,
      eventCount: events.length,
      texts
    }
  }
}

// ---------------------------------------------------------------------------
// v4 兼容性契约：install.json（安装清单）/ bridge-error.json（故障诊断）/ compat 块。
//
// 与共享契约 `src/shared/bridge-schema.ts` 的 `parseDshBridgeInstallManifest` /
// `parseDshBridgeDiagnostic` / `parseDshBridgeCompat` 语义一致（独立实现，单测交叉校验）：
// canary 是 DSH 宿主 + 桥的**外部独立**验证者，不能 import TS 源码，否则验证就变成自证。
// 全部解析失败只返回 `null` / 结构化 errors，绝不抛异常。
// ---------------------------------------------------------------------------

/**
 * 读取并解析一个 JSON 文档（限长 + 必须是普通对象）。
 * @param {unknown} text
 * @param {number} maxBytes
 * @param {string} label
 * @returns {{ ok: true, value: Record<string, unknown> } | { ok: false, error: string }}
 */
function parseJsonRecord(text, maxBytes, label) {
  if (typeof text !== 'string') return { ok: false, error: `${label} 内容不是字符串` }
  if (Buffer.byteLength(text, 'utf8') > maxBytes) {
    return { ok: false, error: `${label} 超过 ${maxBytes} 字节上限` }
  }
  const trimmed = text.trim()
  if (trimmed === '') return { ok: false, error: `${label} 为空` }
  let parsed
  try {
    parsed = JSON.parse(trimmed)
  } catch (error) {
    return { ok: false, error: `${label} 不是合法 JSON：${error instanceof Error ? error.message : String(error)}` }
  }
  if (!isRecord(parsed)) return { ok: false, error: `${label} 顶层必须是对象` }
  return { ok: true, value: parsed }
}

/**
 * 解析 `install.json` 文本（激活脚本写入的安装清单）。
 *
 * 与共享契约 `parseDshBridgeInstallManifest()` 同规则：
 * - 必填：`schemaVersion=1`、`installedAt` 有限非负数、`installMethod`（非法值归一为 'unknown'）、
 *   `bridgeEntry`/`bridgePackageName`/`bridgePackageVersion` 非空字符串、
 *   `bridgeVersion`/`controlSchema` 正安全整数、`dshRange` 允许 null/字符串；
 * - 可选：`dshVersionAtInstall`/`petAppPath`/`petBundleId` 归一为"非空字符串或 null"。
 *
 * @param {unknown} text
 * @returns {{
 *   schemaVersion: number, installedAt: number, installMethod: string,
 *   bridgeEntry: string, bridgePackageName: string, bridgePackageVersion: string,
 *   bridgeVersion: number, controlSchema: number, dshRange: string | null,
 *   dshVersionAtInstall: string | null, petAppPath: string | null, petBundleId: string | null
 * } | null}
 */
export function parseInstallManifest(text) {
  const parsed = parseJsonRecord(text, MAX_INSTALL_BYTES, 'install.json')
  if (!parsed.ok) return null
  const value = parsed.value
  if (value.schemaVersion !== INSTALL_SCHEMA_VERSION) return null
  if (!isNonNegativeNumber(value.installedAt)) return null
  const installMethod = INSTALL_METHODS.includes(value.installMethod) ? value.installMethod : 'unknown'
  const bridgeEntry = nonEmptyStringOrNull(value.bridgeEntry)
  const bridgePackageName = nonEmptyStringOrNull(value.bridgePackageName)
  const bridgePackageVersion = nonEmptyStringOrNull(value.bridgePackageVersion)
  if (bridgeEntry === null || bridgePackageName === null || bridgePackageVersion === null) return null
  if (!isPositiveSafeInteger(value.bridgeVersion)) return null
  if (!isPositiveSafeInteger(value.controlSchema)) return null
  const dshRangeRaw = value.dshRange
  if (dshRangeRaw !== null && dshRangeRaw !== undefined && typeof dshRangeRaw !== 'string') return null
  return {
    schemaVersion: INSTALL_SCHEMA_VERSION,
    installedAt: value.installedAt,
    installMethod,
    bridgeEntry,
    bridgePackageName,
    bridgePackageVersion,
    bridgeVersion: value.bridgeVersion,
    controlSchema: value.controlSchema,
    dshRange: nonEmptyStringOrNull(dshRangeRaw),
    dshVersionAtInstall: nonEmptyStringOrNull(value.dshVersionAtInstall),
    petAppPath: nonEmptyStringOrNull(value.petAppPath),
    petBundleId: nonEmptyStringOrNull(value.petBundleId)
  }
}

/**
 * 校验 `install.json`（形状 + 可选期望值）。
 *
 * @param {unknown} text
 * @param {{
 *   expectedBridgeEntry?: string,
 *   expectedBridgeVersion?: number,
 *   expectedControlSchema?: number,
 *   expectedDshRange?: string | null,
 *   expectedPetAppPath?: string,
 *   expectedInstallMethod?: string
 * }} [options]
 * @returns {{ ok: boolean, manifest: ReturnType<typeof parseInstallManifest>, errors: string[] }}
 */
export function validateInstallManifest(text, options = {}) {
  const errors = []
  const manifest = parseInstallManifest(text)
  if (manifest === null) {
    errors.push('install.json 缺失/不是合法安装清单（JSON/schemaVersion/必填字段校验失败）')
    return { ok: false, manifest, errors }
  }
  const {
    expectedBridgeEntry,
    expectedBridgeVersion,
    expectedControlSchema,
    expectedDshRange,
    expectedPetAppPath,
    expectedInstallMethod
  } = options
  if (typeof expectedBridgeEntry === 'string' && manifest.bridgeEntry !== expectedBridgeEntry) {
    errors.push(`install.bridgeEntry 应为 ${JSON.stringify(expectedBridgeEntry)}，实际 ${JSON.stringify(manifest.bridgeEntry)}`)
  }
  if (typeof expectedBridgeVersion === 'number' && manifest.bridgeVersion !== expectedBridgeVersion) {
    errors.push(`install.bridgeVersion 应为 ${expectedBridgeVersion}，实际 ${JSON.stringify(manifest.bridgeVersion)}`)
  }
  if (typeof expectedControlSchema === 'number' && manifest.controlSchema !== expectedControlSchema) {
    errors.push(`install.controlSchema 应为 ${expectedControlSchema}，实际 ${JSON.stringify(manifest.controlSchema)}`)
  }
  if (expectedDshRange !== undefined && manifest.dshRange !== (expectedDshRange ?? null)) {
    errors.push(`install.dshRange 应为 ${JSON.stringify(expectedDshRange)}, 实际 ${JSON.stringify(manifest.dshRange)}`)
  }
  if (typeof expectedPetAppPath === 'string' && manifest.petAppPath !== expectedPetAppPath) {
    errors.push(`install.petAppPath 应为 ${JSON.stringify(expectedPetAppPath)}，实际 ${JSON.stringify(manifest.petAppPath)}`)
  }
  if (typeof expectedInstallMethod === 'string' && manifest.installMethod !== expectedInstallMethod) {
    errors.push(`install.installMethod 应为 ${JSON.stringify(expectedInstallMethod)}，实际 ${JSON.stringify(manifest.installMethod)}`)
  }
  return { ok: errors.length === 0, manifest, errors }
}

/**
 * 解析 `bridge-error.json` 文本（桥 apply 失败诊断）。
 *
 * 与共享契约 `parseDshBridgeDiagnostic()` 同规则：`schemaVersion=1`、`ts` 有限数、
 * `phase`/`message` 非空字符串（message 截断到 1024 字符）、可选 `bridgeVersion`
 * 正安全整数、可选 `dshRange` 非空字符串（缺省归一为 null）。
 *
 * @param {unknown} text
 * @returns {{
 *   schemaVersion: number, ts: number, phase: string, message: string,
 *   bridgeVersion?: number, dshRange: string | null
 * } | null}
 */
export function parseDiagnostic(text) {
  const parsed = parseJsonRecord(text, MAX_DIAGNOSTIC_BYTES, 'bridge-error.json')
  if (!parsed.ok) return null
  const value = parsed.value
  if (value.schemaVersion !== INSTALL_SCHEMA_VERSION) return null
  if (!isNonNegativeNumber(value.ts)) return null
  const phase = nonEmptyStringOrNull(value.phase)
  const message = nonEmptyStringOrNull(value.message)
  if (phase === null || message === null) return null
  if (value.bridgeVersion !== undefined && !isPositiveSafeInteger(value.bridgeVersion)) return null
  const dshRangeRaw = value.dshRange
  if (dshRangeRaw !== null && dshRangeRaw !== undefined && typeof dshRangeRaw !== 'string') return null
  const diagnostic = {
    schemaVersion: INSTALL_SCHEMA_VERSION,
    ts: value.ts,
    phase,
    message: message.length > DIAGNOSTIC_MESSAGE_MAX_CHARS ? message.slice(0, DIAGNOSTIC_MESSAGE_MAX_CHARS) : message
  }
  if (value.bridgeVersion !== undefined) diagnostic.bridgeVersion = value.bridgeVersion
  diagnostic.dshRange = nonEmptyStringOrNull(dshRangeRaw)
  return diagnostic
}

/**
 * 校验 `bridge-error.json`（形状 + 可选期望值；canary C6 用）。
 *
 * @param {unknown} text
 * @param {{
 *   expectedPhase?: string,
 *   expectedBridgeVersion?: number,
 *   expectedDshRange?: string | null
 * }} [options]
 * @returns {{ ok: boolean, diagnostic: ReturnType<typeof parseDiagnostic>, errors: string[] }}
 */
export function validateDiagnostic(text, options = {}) {
  const errors = []
  const diagnostic = parseDiagnostic(text)
  if (diagnostic === null) {
    errors.push('bridge-error.json 缺失/不是合法诊断（JSON/schemaVersion/phase/message 校验失败）')
    return { ok: false, diagnostic, errors }
  }
  const { expectedPhase = 'apply', expectedBridgeVersion, expectedDshRange } = options
  if (diagnostic.phase !== expectedPhase) {
    errors.push(`bridge-error.phase 应为 ${JSON.stringify(expectedPhase)}，实际 ${JSON.stringify(diagnostic.phase)}`)
  }
  if (typeof expectedBridgeVersion === 'number' && diagnostic.bridgeVersion !== expectedBridgeVersion) {
    errors.push(
      `bridge-error.bridgeVersion 应为 ${expectedBridgeVersion}，实际 ${JSON.stringify(diagnostic.bridgeVersion)}`
    )
  }
  if (expectedDshRange !== undefined && diagnostic.dshRange !== (expectedDshRange ?? null)) {
    errors.push(`bridge-error.dshRange 应为 ${JSON.stringify(expectedDshRange)}，实际 ${JSON.stringify(diagnostic.dshRange)}`)
  }
  return { ok: errors.length === 0, diagnostic, errors }
}

/**
 * 校验 canary 轮询收集到的 control 帧序列（v4 compat 断言，C3 用）。
 *
 * 输入帧来自 `dsh-canary.mjs` 的 `runTurn().controlFrames`（每帧是解析后的 JSON 对象）：
 * 1. 每帧形状合法（schemaVersion/ts/action/bridgeVersion?/compat?）；
 * 2. 观察到 attached 且早于 detached、最后一个是 detached（与 validateControlArtifacts 同语义）；
 * 3. `requireCompat`：attached 帧必须带合法 compat，且 `compat.bridgeVersion === expectedBridgeVersion`、
 *    `compat.controlSchema === expectedControlSchema`、`compat.dshRange === expectedDshRange`
 *    （expectedDshRange 为 null 时要求 compat.dshRange 也是 null）。
 *
 * @param {{
 *   frames?: Array<Record<string, unknown>>,
 *   expectedBridgeVersion?: number | null,
 *   expectedControlSchema?: number,
 *   expectedDshRange?: string | null,
 *   requireCompat?: boolean
 * }} [input]
 * @returns {{
 *   errors: string[],
 *   frames: Array<Record<string, unknown>>,
 *   attached: Record<string, unknown> | null,
 *   detached: Record<string, unknown> | null,
 *   compat: ReturnType<typeof parseCompat>
 * }}
 */
export function validateCompatControlFrames(input = {}) {
  const errors = []
  const {
    frames = [],
    expectedBridgeVersion = null,
    expectedControlSchema = INSTALL_SCHEMA_VERSION,
    expectedDshRange = null,
    requireCompat = true
  } = input
  const list = Array.isArray(frames) ? frames.filter(isRecord) : []
  if (!Array.isArray(frames) || list.length !== (Array.isArray(frames) ? frames.length : 0)) {
    errors.push('controlFrames 必须是对象数组')
  }

  let attached = null
  let detached = null
  for (let index = 0; index < list.length; index += 1) {
    const frame = list[index]
    const parsed = parseControlFile(JSON.stringify(frame))
    if (!parsed.ok) {
      errors.push(`control 帧 #${index + 1} 形状非法：${parsed.error}`)
      continue
    }
    if (frame.action === 'attached' && attached === null) attached = frame
    if (frame.action === 'detached') detached = frame
  }
  if (attached === null) errors.push('control.json 未观察到 attached 帧（桥未 apply 或 HMR 未生效）')
  if (detached === null) errors.push('control.json 未观察到 detached 帧（dispose 未写帧）')
  if (attached !== null && detached !== null) {
    const attachedIndex = list.indexOf(attached)
    const detachedIndex = list.lastIndexOf(detached)
    if (attachedIndex > detachedIndex) errors.push('control 生命周期顺序错误：detached 出现在 attached 之前')
  }
  if (list.length > 0 && list[list.length - 1].action !== 'detached') {
    errors.push(`control 最后观察到的 action 应为 'detached'，实际 ${JSON.stringify(list[list.length - 1].action)}`)
  }

  let compat = null
  if (attached !== null) {
    if (attached.compat === undefined) {
      if (requireCompat) errors.push('attached 帧缺少 compat 块（v4 桥必须每帧自述兼容范围）')
    } else {
      compat = parseCompat(attached.compat)
      if (compat === null) errors.push('attached 帧的 compat 块形状非法')
    }
    if (typeof expectedBridgeVersion === 'number') {
      if (!isPositiveSafeInteger(attached.bridgeVersion)) {
        errors.push('attached 帧缺少顶层 bridgeVersion（正安全整数）')
      } else if (attached.bridgeVersion !== expectedBridgeVersion) {
        errors.push(
          `attached.bridgeVersion 应为 ${expectedBridgeVersion}，实际 ${JSON.stringify(attached.bridgeVersion)}`
        )
      }
    }
  }
  if (requireCompat && compat !== null) {
    if (typeof expectedBridgeVersion === 'number' && compat.bridgeVersion !== expectedBridgeVersion) {
      errors.push(`compat.bridgeVersion 应为 ${expectedBridgeVersion}，实际 ${JSON.stringify(compat.bridgeVersion)}`)
    }
    if (compat.controlSchema !== expectedControlSchema) {
      errors.push(`compat.controlSchema 应为 ${expectedControlSchema}，实际 ${JSON.stringify(compat.controlSchema)}`)
    }
    if (compat.dshRange !== (expectedDshRange ?? null)) {
      errors.push(`compat.dshRange 应为 ${JSON.stringify(expectedDshRange)}, 实际 ${JSON.stringify(compat.dshRange)}`)
    }
  }
  return { errors, frames: list, attached, detached, compat }
}

/**
 * 校验 `status.json` 心跳帧的 v4 compat（C3 用；C2 用 `offline:false` 的零产物断言）。
 *
 * @param {{
 *   statusText?: string | null,
 *   expectedBridgeVersion?: number | null,
 *   expectedControlSchema?: number,
 *   expectedDshRange?: string | null,
 *   requireCompat?: boolean,
 *   expectedOffline?: boolean
 * }} [input]
 * @returns {{ errors: string[], status: Record<string, unknown> | null, compat: ReturnType<typeof parseCompat> }}
 */
export function validateCompatStatus(input = {}) {
  const errors = []
  const {
    statusText = null,
    expectedBridgeVersion = null,
    expectedControlSchema = INSTALL_SCHEMA_VERSION,
    expectedDshRange = null,
    requireCompat = true,
    expectedOffline = true
  } = input
  if (statusText === null || statusText === undefined) {
    errors.push('status.json 缺失（桥没有写出心跳，插件可能未加载）')
    return { errors, status: null, compat: null }
  }
  const parsed = parseStatusFile(statusText)
  if (!parsed.ok) {
    errors.push(parsed.error)
    return { errors, status: null, compat: null }
  }
  const status = parsed.status
  if (expectedOffline && status.offline !== true) {
    errors.push('status.offline 必须是 true（disposer 显式离线帧）')
  }
  if (!isNonNegativeNumber(status.ts)) errors.push('status.ts 必须是有限非负数')
  let compat = null
  if (status.compat === undefined) {
    if (requireCompat) errors.push('status.json 缺少 compat 块（v4 桥必须每帧自述兼容范围）')
  } else {
    compat = parseCompat(status.compat)
    if (compat === null) errors.push('status.compat 形状非法')
  }
  if (requireCompat && compat !== null) {
    if (typeof expectedBridgeVersion === 'number' && compat.bridgeVersion !== expectedBridgeVersion) {
      errors.push(`status.compat.bridgeVersion 应为 ${expectedBridgeVersion}，实际 ${JSON.stringify(compat.bridgeVersion)}`)
    }
    if (compat.controlSchema !== expectedControlSchema) {
      errors.push(`status.compat.controlSchema 应为 ${expectedControlSchema}，实际 ${JSON.stringify(compat.controlSchema)}`)
    }
    if (compat.dshRange !== (expectedDshRange ?? null)) {
      errors.push(`status.compat.dshRange 应为 ${JSON.stringify(expectedDshRange)}, 实际 ${JSON.stringify(compat.dshRange)}`)
    }
  }
  return { errors, status, compat }
}
