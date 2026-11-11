/**
 * DSH 对话气泡状态机（Wave 3 A2，渲染层**纯逻辑**；不 import DOM/Electron/three/node）。
 *
 * 数据流（见 docs/wave3-dsh-integration-design.md §5）：
 * main（dsh-watch）→ `dsh-event` IPC → Lead 在 `main.ts` 订阅后调用
 * `dialogue.pushEvent(event, performance.now())`；每帧调用 `dialogue.tick(nowMs)`
 * 取当前该显示的气泡，再交给 `BubbleView.show/hide`。
 *
 * 目标语义（用户需求「思考中… → 每段输出 → 停留 → 消失 → 下一段」）：
 * 1. `task/start`（或 `agent/status running`）→ busy；没有可播文本时 tick 返回 `思考中...`
 *    （kind=thinking，主进程每帧用固定刷新周期 show 即可持续显示，直到状态变化）。
 * 2. `session/event` + `eventType==='assistant/message'` + `payload.text` → 清洗后按
 *    `CHUNK_MAX_CHARS=96` 切块入队（超长按句/逗号/空白优先拆，再硬切）；同 key 去重；
 *    同一 turn 文本总预算 `MAX_TURN_TEXT_CHARS=4000`。
 * 3. 每段显示 `dwell=clamp(2200+45*len, 2200, 9000)` ms → 完全隐藏 `INTER_SEGMENT_GAP_MS=350`
 *    → 下一段（队列上限 `QUEUE_MAX=8`，溢出丢最旧）；队列播完后，busy 则回到思考中，否则归 null。
 * 4. `task/end` / `task/error` / `turn/end` → busy=false；已入队文本继续播完（error 例外：
 *    `task/error` 清空未播文本，错误交给反应层表演）。
 * 5. `task/start` 清空旧队列与当前段（防上一轮堆积）；`reset()` 清空一切
 *    （Lead 用于 `dshBubbleSync=false` / DSH offline / 关闭联动）。
 *
 * `ownsBubble` 契约（Lead 接线需要，避免与行为层台词互相覆盖）：
 * - 显示思考中、显示回复段、以及两段之间的隐藏 gap（text=null）期间均为 true；
 * - 队列播完且 busy=false（且最后一段的 gap 已结束）后的那一 tick 起为 false；
 * - `task/error` / `reset()` 后立即为 false（下一 tick 即体现）。
 * 主进程调用约定：`text !== null` → `bubble.show(text, now, lifetimeMs)`；
 * 否则 `ownsBubble === true` → `bubble.hide()`；否则走现有行为层/反应层气泡。
 * - 带尾 gap 是有意的：最后一段结束后仍给主进程一个 `text=null & ownsBubble=true` 的帧去
 *   `hide()`（`BubbleView.show` 每帧刷新计时，若直接切到 ownsBubble=false 会残留上一条）。
 *
 * 时长字段：speech = 该段完整 `dwell`（主进程每帧 show 刷新，隐藏时机由本状态机决定）；
 * thinking = `THINKING_REFRESH_MS`（固定刷新周期）；gap = 0（该帧应调用 hide）。
 *
 * 已知取舍（Lead 接线时知晓）：
 * - 事件按到达顺序全局排队（多 session 不串：去重/预算 key 含 sessionId；队列仍按到达序播）；
 * - 单个大文本会一次切出很多段，`QUEUE_MAX=8` 丢最旧 → 只保留消息尾部；这是冻结规则
 *   「溢出丢最旧」的直接结果（配合 4000 字预算，一次超长回复只播最后约 8 段）；
 * - 主进程不 tick 时气泡不推进（本模块无定时器/副作用，便于单测）。
 */
import { DSH_EVENT_TEXT_MAX_CHARS } from '@shared/bridge-schema'
import type { DshEvent } from '@shared/types'

/** 思考占位文案（用户指定）。 */
export const THINKING_TEXT = '思考中...'

/**
 * 思考中气泡的刷新周期（ms）。
 *
 * `BubbleView.show` 每次调用都会把过期时间重置为 `now + lifetimeMs`，主进程每帧
 * 用本周期 show 即可让「思考中...」持续显示，直到 busy 状态变化。
 */
export const THINKING_REFRESH_MS = 1200

/** 单气泡最大字符数（超长按句/逗号/空白拆；仍超长再硬切）。 */
export const CHUNK_MAX_CHARS = 96

/** 每字符停留时长（ms）。 */
export const DWELL_PER_CHAR_MS = 45

/** 单段最短停留（ms）。 */
export const MIN_DWELL_MS = 2200

/** 单段最长停留（ms）。 */
export const MAX_DWELL_MS = 9000

/** 两段之间「完全隐藏」的间隔（ms）。 */
export const INTER_SEGMENT_GAP_MS = 350

/** 段队列上限（溢出丢最旧，防长回合堆积）。 */
export const QUEUE_MAX = 8

/** 单 turn 文本总预算（字符，清洗后计数；超出截断并丢弃其余）。 */
export const MAX_TURN_TEXT_CHARS = 4000

/** 去重窗口（最近 N 个 key，FIFO 淘汰）。 */
export const DEDUPE_SIZE = 32

/** 单次 tick 的输出（主进程据 text/ownsBubble/lifetimeMs 驱动 BubbleView）。 */
export interface DshDialogueOutput {
  /** 本帧应显示的气泡文本；null = 本帧不显示文本（思考中/间隙/空闲见 kind 与 ownsBubble）。 */
  text: string | null
  /** 语义：思考占位 / 回复段 / 无文本。 */
  kind: 'thinking' | 'speech' | null
  /**
   * 显示时长（ms）：speech=该段 dwell；thinking=THINKING_REFRESH_MS；gap/空闲=0。
   * 主进程每帧 `bubble.show(text, now, lifetimeMs)` 刷新即可。
   */
  lifetimeMs: number
  /**
   * 本模块是否「拥有」气泡：true 时主进程可用/需用气泡（文本或隐藏），
   * false 时主进程才允许行为层/反应层台词占用气泡。
   */
  ownsBubble: boolean
}

/** 队列中的一段（文本 + 预先算好的停留时长）。 */
interface Segment {
  text: string
  dwellMs: number
}

/** 预算桶上限（sessionId+turn 组合数，FIFO 淘汰，防长期运行内存增长）。 */
const TURN_BUDGET_BUCKETS_MAX = 16

/** 空闲输出（一次构造，tick 时浅拷贝返回，避免调用方误改共享对象）。 */
const IDLE_OUTPUT: DshDialogueOutput = {
  text: null,
  kind: null,
  lifetimeMs: 0,
  ownsBubble: false
}

/** 间隙输出：本帧不显示文本，但气泡仍归本模块所有（主进程应 hide 掉上一段）。 */
const GAP_OUTPUT: DshDialogueOutput = {
  text: null,
  kind: null,
  lifetimeMs: 0,
  ownsBubble: true
}

/* ------------------------------ 文本清洗 ------------------------------ */

/** 代码围栏（``` 或 ~~~，含未闭合尾块）：整块连同内容删除。 */
const FENCED_CODE_BACKTICK_RE = /```[\s\S]*?(?:```|$)/g
const FENCED_CODE_TILDE_RE = /~~~[\s\S]*?(?:~~~|$)/g

/** Markdown 行内代码：去反引号外壳、保留内容。 */
const INLINE_CODE_RE = /`([^`\n]*)`/g

/** 加粗/斜体标记：`***` `**` `*` `___` `__` `_`（只去标记字符，保留文字）。 */
const BOLD_MARKERS_RE = /\*\*\*|\*\*|\*/g
const UNDERSCORE_MARKERS_RE = /___|__|_/g

/** Markdown 图片（整块删除）与链接（保留链接文字）。 */
const MARKDOWN_IMAGE_RE = /!\[[^\]]*\]\([^)]*\)/g
const MARKDOWN_LINK_RE = /\[([^\]]*)\]\([^)]*\)/g

/** HTML 注释与标签（去掉标签本身，保留夹在标签之间的文字）。 */
const HTML_COMMENT_RE = /<!--[\s\S]*?-->/g
const HTML_TAG_RE = /<[^>]*>/g

/** 标题号（`#`–`######` + 空白）与列表符号（`-`/`*`/`+`/`•`/`·`/`1.`/`1)`）。 */
const HEADING_MARKER_RE = /^[ \t]{0,3}#{1,6}(?:[ \t]+|$)/gm
const UNORDERED_LIST_MARKER_RE = /^[ \t]{0,3}(?:[-*+]|\u2022|\u00b7)[ \t]+/gm
const ORDERED_LIST_MARKER_RE = /^[ \t]{0,3}\d{1,3}[.)][ \t]+/gm

/** 连续空白（含换行/制表）折叠为单空格。 */
const WHITESPACE_RE = /\s+/g

/**
 * 清洗 assistant 输出文本为「可上气泡的纯文本」（纯函数、绝不抛异常）：
 * 去代码围栏整块 → 行内反引号去壳 → 去加粗/斜体标记 → 链接留文字/图片删除 →
 * HTML 标签去掉 → 标题号/列表符号去掉 → 连续空白折叠成单空格 → trim；空串表示不显示。
 */
export function cleanAssistantText(input: string): string {
  if (typeof input !== 'string' || input.length === 0) return ''
  let text = input
  // 1) 代码围栏整块（含内容）删除；未闭合的围栏删到结尾。
  text = text.replace(FENCED_CODE_BACKTICK_RE, ' ')
  text = text.replace(FENCED_CODE_TILDE_RE, ' ')
  // 2) 行内代码去反引号外壳（保留内容）。
  text = text.replace(INLINE_CODE_RE, '$1')
  // 3) 加粗/斜体标记去字符。
  text = text.replace(BOLD_MARKERS_RE, '')
  text = text.replace(UNDERSCORE_MARKERS_RE, '')
  // 4) 图片整块删除；链接 `[x](url)` → `x`。
  text = text.replace(MARKDOWN_IMAGE_RE, '')
  text = text.replace(MARKDOWN_LINK_RE, '$1')
  // 5) HTML 注释/标签去掉（保留标签之间的可见文字）。
  text = text.replace(HTML_COMMENT_RE, ' ')
  text = text.replace(HTML_TAG_RE, ' ')
  // 6) 标题号 / 列表符号去掉。
  text = text.replace(HEADING_MARKER_RE, '')
  text = text.replace(UNORDERED_LIST_MARKER_RE, '')
  text = text.replace(ORDERED_LIST_MARKER_RE, '')
  // 7) 连续空白折叠为单空格并 trim。
  return text.replace(WHITESPACE_RE, ' ').trim()
}

/* ------------------------------ 分段 / 去重 / 预算辅助 ------------------------------ */

/** 句末标点（优先在此断句）。 */
const SENTENCE_END_CHARS: ReadonlySet<string> = new Set(['。', '！', '？', '!', '?', '；', ';', '…'])

/** 逗号级标点（句内次优先断点）。 */
const CLAUSE_END_CHARS: ReadonlySet<string> = new Set(['，', ',', '、'])

/** 判断是否空白字符（空格/换行/制表；清洗后一般只剩空格）。 */
function isWhitespaceChar(char: string): boolean {
  return char === ' ' || char === '\n' || char === '\r' || char === '\t'
}

/**
 * 把清洗后的文本按「句 → 逗号 → 空白 → 硬切」优先级切成原子片段。
 *
 * 原子片段拼起来严格等于原文本（不丢字符）；只有原子本身超过 `CHUNK_MAX_CHARS`
 * 时才在打包阶段硬切。保持「拼接 == 输入」便于预算/去重口径一致。
 */
function splitIntoAtoms(text: string): string[] {
  const atoms: string[] = []
  let current = ''
  for (const char of text) {
    current += char
    if (SENTENCE_END_CHARS.has(char) || CLAUSE_END_CHARS.has(char) || isWhitespaceChar(char)) {
      atoms.push(current)
      current = ''
    }
  }
  if (current.length > 0) atoms.push(current)
  return atoms
}

/**
 * 按 `CHUNK_MAX_CHARS` 切块（导出给测试/调试不必要，保持内部实现，行为由状态机覆盖）。
 *
 * 贪心打包原子片段：句末/逗号/空白是第一优先断点，单原子超长再按 96 字符硬切；
 * 返回值每段长度 1..CHUNK_MAX_CHARS，拼接严格等于输入（丢弃空串）。
 */
function splitAssistantText(text: string): string[] {
  if (text.length === 0) return []
  if (text.length <= CHUNK_MAX_CHARS) return [text]
  const chunks: string[] = []
  let chunk = ''
  for (const atom of splitIntoAtoms(text)) {
    let rest = atom
    while (rest.length > 0) {
      if (chunk.length === 0 && rest.length > CHUNK_MAX_CHARS) {
        // 单原子超长：先硬切一整段。
        chunks.push(rest.slice(0, CHUNK_MAX_CHARS))
        rest = rest.slice(CHUNK_MAX_CHARS)
        continue
      }
      const room = CHUNK_MAX_CHARS - chunk.length
      if (rest.length <= room) {
        chunk += rest
        rest = ''
      } else {
        chunks.push(chunk)
        chunk = ''
      }
    }
  }
  if (chunk.length > 0) chunks.push(chunk)
  return chunks
}

/** 段停留时长：clamp(2200 + 45 * len, 2200, 9000)（len 为字符数）。 */
function computeDwellMs(text: string): number {
  const raw = MIN_DWELL_MS + DWELL_PER_CHAR_MS * text.length
  return Math.min(MAX_DWELL_MS, Math.max(MIN_DWELL_MS, raw))
}

/** 判断普通对象（数组/null 排除）。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 取非空字符串（脏值 → null）。 */
function nonEmptyStringOf(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

/** 取有限整数（脏值 → null；浮点截断）。 */
function finiteIntegerOf(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null
  return Math.trunc(value)
}

/** FNV-1a 32 位文本哈希（确定性、环境中立，用于无 id 事件的去重 key）。 */
function hashText(text: string): string {
  let hash = 0x811c9dc5
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(16).padStart(8, '0')
}

/**
 * 去重 key：优先 `sessionId+turn+step+seq`（桥对每条 durable 事件保证 seq）；
 * 没有稳定 id 的脏事件退化为 `sessionId + text hash + 长度`。
 */
function dedupeKeyOf(payload: Record<string, unknown>, rawText: string): string {
  const sessionId = nonEmptyStringOf(payload['sessionId'])
  const turn = finiteIntegerOf(payload['turn'])
  const step = finiteIntegerOf(payload['step'])
  const seq = finiteIntegerOf(payload['seq'])
  const hasStableId = seq !== null || (turn !== null && step !== null)
  if (hasStableId) {
    return `id:${sessionId ?? ''}|${turn ?? ''}|${step ?? ''}|${seq ?? ''}`
  }
  const normalized = rawText.trim()
  return `text:${sessionId ?? '*'}:${hashText(normalized)}:${normalized.length}`
}

/** 单 turn 文本预算的桶 key（sessionId + turn）。 */
function turnBudgetKeyOf(payload: Record<string, unknown>): string {
  const sessionId = nonEmptyStringOf(payload['sessionId'])
  const turn = finiteIntegerOf(payload['turn'])
  return `${sessionId ?? '*'}|${turn ?? '?'}`
}

/**
 * 按 UTF-16 长度截断，且不把代理对劈成两半（emoji 等不会出现半个码点）。
 * `maxChars <= 0` → ''。
 */
function truncateTextUtf16(text: string, maxChars: number): string {
  if (maxChars <= 0) return ''
  if (text.length <= maxChars) return text
  let end = maxChars
  const lastCode = text.charCodeAt(end - 1)
  if (lastCode >= 0xd800 && lastCode <= 0xdbff) end -= 1
  return text.slice(0, end)
}

/* ------------------------------ 状态机 ------------------------------ */

/**
 * DSH 对话气泡状态机（纯逻辑、无定时器/无副作用，时钟由调用方注入）。
 *
 * Lead 接线示例：
 * ```ts
 * const dialogue = new DshDialogue()
 * api.onDshEvent((event) => dialogue.pushEvent(event, performance.now())) // 仅 dshBubbleSync 时
 * // 每帧：
 * const out = dialogue.tick(performance.now())
 * if (out.text !== null) bubble.show(out.text, now, out.lifetimeMs)
 * else if (out.ownsBubble) bubble.hide()
 * // out.ownsBubble === false 时照旧走 output.decision.bubble
 * ```
 */
export class DshDialogue {
  /** 是否处于 busy（task/start 之后、task/end/turn/end/task/error 之前）。 */
  private busy = false

  /** 待播段队列（FIFO；上限 QUEUE_MAX，溢出丢最旧）。 */
  private queue: Segment[] = []

  /** 当前正在显示（或处于段后 gap）的段；null = 没有当前段。 */
  private current: Segment | null = null

  /** 当前段「时间线开始时刻」（可能略早于/等于 tick 时刻；gap 期间下一段开始时间可在未来）。 */
  private currentStartedAtMs = 0

  /** 当前段「应隐藏时刻」= 开始时刻 + dwell。 */
  private currentHideAtMs = 0

  /** 去重 FIFO（与 dedupeSet 同步；超 DEDUPE_SIZE 淘汰最旧）。 */
  private dedupeOrder: string[] = []

  /** 去重集合（O(1) 命中）。 */
  private readonly dedupeSet = new Set<string>()

  /** 单 turn 文本预算使用量（key=sessionId+turn；FIFO 桶数上限防内存增长）。 */
  private readonly turnTextUsed = new Map<string, number>()

  /**
   * 消费一条桥事件（与 `DshReactionTracker` 同级、独立实例；脏事件安全忽略、绝不抛）。
   *
   * @param event 桥事件（`DshEvent`）
   * @param _nowMs 单调时钟毫秒（保留契约参数；播放调度由 `tick` 驱动）
   */
  pushEvent(event: DshEvent, _nowMs: number): void {
    if (!isRecord(event)) return
    const payload = isRecord(event.payload) ? event.payload : {}
    switch (event.type) {
      case 'task/start':
        this.beginTask()
        return
      case 'task/end':
        this.busy = false
        return
      case 'task/error':
        this.busy = false
        this.clearPendingText()
        return
      case 'agent/status': {
        const status = payload['status']
        if (status === 'running') this.busy = true
        else if (status === 'idle') this.busy = false
        return
      }
      case 'session/event':
        this.handleSessionEvent(payload)
        return
      default:
        // 未知/未来事件类型：静默忽略（前向兼容）。
        return
    }
  }

  /**
   * 取当前该显示的气泡（每帧调用；纯查询 + 推进内部时间线，无副作用外部可见）。
   *
   * @param nowMs 单调时钟毫秒（与 `pushEvent` 同口径；Lead 传 `performance.now()`）
   */
  tick(nowMs: number): DshDialogueOutput {
    if (!Number.isFinite(nowMs)) return { ...IDLE_OUTPUT }
    const now = nowMs

    // 1) 推进时间线：当前段若连「段后 gap」都已结束，则进入下一段或清空当前段；
    //    长帧（窗口隐藏/掉帧）会跳过已完全错过的段，避免恢复时逐段补播。
    while (this.current !== null && now >= this.currentHideAtMs + INTER_SEGMENT_GAP_MS) {
      const nextStartAt = this.currentHideAtMs + INTER_SEGMENT_GAP_MS
      this.current = null
      const next = this.queue.shift()
      if (next === undefined) break
      this.current = next
      this.currentStartedAtMs = nextStartAt
      this.currentHideAtMs = nextStartAt + next.dwellMs
    }

    // 2) 没有当前段但队列有内容（空闲时新来文本 / reset 后重新开始）→ 从本帧起播第一段。
    if (this.current === null && this.queue.length > 0) {
      const next = this.queue.shift()
      if (next !== undefined) {
        this.current = next
        this.currentStartedAtMs = now
        this.currentHideAtMs = now + next.dwellMs
      }
    }

    // 3) 输出当前状态。
    const current = this.current
    if (current !== null) {
      if (now < this.currentStartedAtMs) {
        // 两段之间的完全隐藏 gap：文本不显示，但气泡仍归本模块（主进程 hide）。
        return { ...GAP_OUTPUT }
      }
      if (now < this.currentHideAtMs) {
        return {
          text: current.text,
          kind: 'speech',
          lifetimeMs: current.dwellMs,
          ownsBubble: true
        }
      }
      // 当前段已到隐藏时刻，仍处于段后 gap。
      return { ...GAP_OUTPUT }
    }

    if (this.busy) {
      return {
        text: THINKING_TEXT,
        kind: 'thinking',
        lifetimeMs: THINKING_REFRESH_MS,
        ownsBubble: true
      }
    }
    return { ...IDLE_OUTPUT }
  }

  /** 清空全部状态（`dshBubbleSync=false` / DSH offline / 关闭联动 / Lead 复位时调用）。 */
  reset(): void {
    this.busy = false
    this.clearPendingText()
    this.dedupeOrder = []
    this.dedupeSet.clear()
    this.turnTextUsed.clear()
  }

  /* ------------------------------ 事件处理 ------------------------------ */

  /** `task/start`：进入 busy，并清空上一轮未播队列/当前段（防堆积）。 */
  private beginTask(): void {
    this.busy = true
    this.clearPendingText()
  }

  /** 清空当前段与队列（不影响 busy / 去重 / 预算）。 */
  private clearPendingText(): void {
    this.current = null
    this.queue = []
  }

  /** `session/event` 分流：assistant 文本入队；turn/end 结束 busy（error 清空）。 */
  private handleSessionEvent(payload: Record<string, unknown>): void {
    const eventType = payload['eventType']
    if (eventType === 'assistant/message') {
      this.enqueueAssistantMessage(payload)
      return
    }
    if (eventType === 'turn/end') {
      this.busy = false
      // 防御：桥已把 turn/end(reason.kind=error) 转成 task/error；若仍收到 error 版本，
      // 与 task/error 同语义清空未播文本（错误由反应层表演）。
      if (payload['reasonKind'] === 'error') this.clearPendingText()
    }
  }

  /** assistant/message：清洗 → 去重 → 单 turn 预算 → 切块 → 入队（含队列上限）。 */
  private enqueueAssistantMessage(payload: Record<string, unknown>): void {
    const rawValue = payload['text']
    if (typeof rawValue !== 'string' || rawValue.length === 0) return
    const raw =
      rawValue.length > DSH_EVENT_TEXT_MAX_CHARS
        ? rawValue.slice(0, DSH_EVENT_TEXT_MAX_CHARS)
        : rawValue
    const cleaned = cleanAssistantText(raw)
    if (cleaned.length === 0) return

    const dedupeKey = dedupeKeyOf(payload, raw)
    if (this.dedupeSet.has(dedupeKey)) return

    // 单 turn 文本预算：超出部分截断并丢弃其余（去重 key 仅在被接受后记录）。
    const budgetKey = turnBudgetKeyOf(payload)
    const used = this.turnTextUsed.get(budgetKey) ?? 0
    const remaining = MAX_TURN_TEXT_CHARS - used
    if (remaining <= 0) return
    const accepted = truncateTextUtf16(cleaned, remaining)
    if (accepted.length === 0) return
    this.turnTextUsed.set(budgetKey, used + accepted.length)
    this.trimTurnBudgetBuckets()
    this.rememberDedupeKey(dedupeKey)

    for (const chunk of splitAssistantText(accepted)) {
      this.queue.push({ text: chunk, dwellMs: computeDwellMs(chunk) })
      // 队列上限：溢出丢最旧（长回合只保留最近 QUEUE_MAX 段）。
      while (this.queue.length > QUEUE_MAX) this.queue.shift()
    }
  }

  /* ------------------------------ 去重 / 预算簿记 ------------------------------ */

  /** 记录去重 key（FIFO 窗口 DEDUPE_SIZE）。 */
  private rememberDedupeKey(key: string): void {
    this.dedupeSet.add(key)
    this.dedupeOrder.push(key)
    while (this.dedupeOrder.length > DEDUPE_SIZE) {
      const oldest = this.dedupeOrder.shift()
      if (oldest !== undefined) this.dedupeSet.delete(oldest)
    }
  }

  /** 预算桶数超过上限时淘汰最旧（Map 按插入顺序迭代）。 */
  private trimTurnBudgetBuckets(): void {
    while (this.turnTextUsed.size > TURN_BUDGET_BUCKETS_MAX) {
      const oldest = this.turnTextUsed.keys().next()
      if (oldest.done === true) return
      this.turnTextUsed.delete(oldest.value)
    }
  }
}
