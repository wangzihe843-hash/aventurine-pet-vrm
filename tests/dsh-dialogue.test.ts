/**
 * 单测：DSH 对话气泡状态机（`src/renderer/src/reactions/dsh-dialogue.ts`，Wave 3 A2）。
 *
 * 纯逻辑 + 假时钟（不建 DOM / 不跑 Electron）：
 * - 思考中占位（busy 且无可播文本、持续到状态变化）；
 * - assistant/message 文本清洗 → 按句/逗号/空白切块 → 排队的播放调度（dwell → 隐藏 gap → 下一段）；
 * - 队列上限 8 丢最旧、单 turn 4000 字预算、去重 key（sessionId+turn+step+seq / text hash）；
 * - turn/task 生命周期（task/start 清旧队列、task/end/turn/end 播完归 null、task/error 清空）；
 * - `dshBubbleSync` 关闭 / offline 语义 → `reset()`；
 * - `ownsBubble` 边界（思考中/回复段/gap=true；结束/错误/reset=false；尾 gap 给主进程 hide 帧）；
 * - cleanAssistantText 各分支；模块 import 纯净化（无 node/electron/three/DOM）。
 */
import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

import type { DshEvent } from '@shared/types'

import {
  CHUNK_MAX_CHARS,
  DEDUPE_SIZE,
  DWELL_PER_CHAR_MS,
  DshDialogue,
  INTER_SEGMENT_GAP_MS,
  MAX_DWELL_MS,
  MAX_TURN_TEXT_CHARS,
  MIN_DWELL_MS,
  QUEUE_MAX,
  THINKING_REFRESH_MS,
  THINKING_TEXT,
  cleanAssistantText,
  type DshDialogueOutput
} from '../src/renderer/src/reactions/dsh-dialogue'

/** 基准假时钟（ms）；用例内任意平移。 */
const T0 = 10_000

/** 造一条桥事件。 */
function event(
  type: DshEvent['type'],
  payload: Record<string, unknown> = {},
  ts = T0
): DshEvent {
  return { ts, type, payload }
}

/** task/start 事件。 */
const TASK_START = event('task/start', { agent: 'agent-a', status: 'running' })

/** task/end 事件。 */
const TASK_END = event('task/end', { agent: 'agent-a', reason: 'idle' })

/** task/error 事件。 */
const TASK_ERROR = event('task/error', { agent: 'agent-a', turn: 1, reasonKind: 'error' })

/** assistant/message 会话事件选项。 */
interface AssistantOptions {
  sessionId?: string
  turn?: number
  step?: number
  seq?: number
}

/** 造一条 assistant/message（session/event 形状，text 随 payload 走）。 */
function assistant(
  text: string,
  options: AssistantOptions = {},
  ts = T0
): DshEvent {
  const payload: Record<string, unknown> = { eventType: 'assistant/message', text }
  if (options.sessionId !== undefined) payload['sessionId'] = options.sessionId
  if (options.turn !== undefined) payload['turn'] = options.turn
  if (options.step !== undefined) payload['step'] = options.step
  if (options.seq !== undefined) payload['seq'] = options.seq
  return event('session/event', payload, ts)
}

/** 期望停留时长：clamp(2200 + 45*len, 2200, 9000)。 */
function expectedDwell(length: number): number {
  return Math.min(MAX_DWELL_MS, Math.max(MIN_DWELL_MS, MIN_DWELL_MS + DWELL_PER_CHAR_MS * length))
}

/** playAll 的结果。 */
interface PlayResult {
  texts: string[]
  endMs: number
  last: DshDialogueOutput
}

/**
 * 从 `startMs` 起按真实节奏推进假时钟播放，收集所有 speech 段，直到本模块不再输出文本
 * （busy 时停在「思考中」、否则停在 idle）。用于「一次入队多段」的用例。
 */
function playAll(dialogue: DshDialogue, startMs: number, maxSegments = 64): PlayResult {
  let now = startMs
  const texts: string[] = []
  for (let index = 0; index <= maxSegments; index += 1) {
    const output = dialogue.tick(now)
    // 「思考中」也是 text 非 null 的占位，收集 speech 时应在此停下。
    if (output.text === null || output.kind === 'thinking') {
      return { texts, endMs: now, last: output }
    }
    texts.push(output.text)
    now += output.lifetimeMs + INTER_SEGMENT_GAP_MS
  }
  throw new Error(`playAll 超过 ${maxSegments} 段仍未播完`)
}

/* ============================== 常量契约 ============================== */

describe('导出常量符合冻结设计（§5.1）', () => {
  it('文案 / 切块 / 停留 / gap / 队列 / 预算 / 去重 窗口全部与设计一致', () => {
    expect(THINKING_TEXT).toBe('思考中...')
    expect(CHUNK_MAX_CHARS).toBe(96)
    expect(DWELL_PER_CHAR_MS).toBe(45)
    expect(MIN_DWELL_MS).toBe(2200)
    expect(MAX_DWELL_MS).toBe(9000)
    expect(INTER_SEGMENT_GAP_MS).toBe(350)
    expect(QUEUE_MAX).toBe(8)
    expect(MAX_TURN_TEXT_CHARS).toBe(4000)
    expect(DEDUPE_SIZE).toBe(32)
    expect(THINKING_REFRESH_MS).toBe(1200)
  })

  it('模块是纯逻辑：只 import @shared 契约（无 node/electron/three/DOM/require）', () => {
    const source = readFileSync(
      new URL('../src/renderer/src/reactions/dsh-dialogue.ts', import.meta.url),
      'utf8'
    )
    const specifiers = Array.from(source.matchAll(/from\s+['"]([^'"]+)['"]/g), (match) => match[1])
    expect(specifiers.length).toBeGreaterThan(0)
    expect(new Set(specifiers)).toEqual(new Set(['@shared/types', '@shared/bridge-schema']))
    expect(source).not.toMatch(/\brequire\s*\(/)
    expect(source).not.toMatch(/\bdocument\s*\./)
    expect(source).not.toMatch(/\bwindow\s*\./)
  })
})

/* ============================== 文本清洗 ============================== */

describe('cleanAssistantText 清洗规则', () => {
  it('普通文本保留原文并 trim 首尾空白', () => {
    expect(cleanAssistantText('  普通回复文本。 \n')).toBe('普通回复文本。')
  })

  it('代码围栏整块含内容删除（闭合 / 未闭合 / ~~~ 围栏）', () => {
    const closed = '前文\n' + '```js\nconst a = 1\n```' + '\n后文'
    expect(cleanAssistantText(closed)).toBe('前文 后文')
    const unclosed = '可见' + '```ts\nconst b = 2'
    expect(cleanAssistantText(unclosed)).toBe('可见')
    expect(cleanAssistantText('甲~~~python\nx = 1~~~乙')).toBe('甲 乙')
  })

  it('行内反引号去壳、保留内容', () => {
    expect(cleanAssistantText('运行 `pnpm test` 通过')).toBe('运行 pnpm test 通过')
  })

  it('加粗/斜体标记 ** __ * _ 去字符、保留文字', () => {
    expect(cleanAssistantText('**加粗** __加粗2__ *斜体* _斜体2_')).toBe('加粗 加粗2 斜体 斜体2')
  })

  it('链接 [x](url) → x；图片 ![x](url) 整块删除', () => {
    expect(cleanAssistantText('看[文档](https://example.com/a)吧')).toBe('看文档吧')
    expect(cleanAssistantText('前![图片](a.png)后')).toBe('前后')
    expect(cleanAssistantText('看[文档](https://x.y)和![图](a.png)吧')).toBe('看文档和吧')
  })

  it('HTML 注释/标签去掉、标签之间的文字保留', () => {
    expect(cleanAssistantText('<!-- 注释 --><div>你好</div><br/>世界')).toBe('你好 世界')
    expect(cleanAssistantText('<p>段落一</p><p>段落二</p>')).toBe('段落一 段落二')
  })

  it('标题号与列表符号去掉', () => {
    const input = '# 标题\n- 第一\n- 第二\n1. 第三\n2) 第四'
    expect(cleanAssistantText(input)).toBe('标题 第一 第二 第三 第四')
  })

  it('连续空白（空格/换行/制表）折叠成单空格', () => {
    expect(cleanAssistantText('  多   空格 \n\t 折叠  ')).toBe('多 空格 折叠')
  })

  it('纯格式/纯空白文本清洗后为空串（上层应丢弃）', () => {
    expect(cleanAssistantText('```\ncode\n```')).toBe('')
    expect(cleanAssistantText('   \n\t ')).toBe('')
    expect(cleanAssistantText('# ')).toBe('')
    expect(cleanAssistantText('')).toBe('')
  })

  it('组合场景：标题+列表+行内代码+加粗+链接+围栏', () => {
    const input =
      '## 说明\n- 使用 `npm` 安装\n**注意**：看[文档](https://x.y)。\n' + '```js\ncode\n```'
    expect(cleanAssistantText(input)).toBe('说明 使用 npm 安装 注意：看文档。')
  })

  it('中文标点（逗号/感叹号/省略号/括号）不误删', () => {
    expect(cleanAssistantText('你好，世界！这是……测试（括号）？')).toBe(
      '你好，世界！这是……测试（括号）？'
    )
  })

  it('非字符串输入防御性返回空串（不抛）', () => {
    expect(cleanAssistantText(null as unknown as string)).toBe('')
    expect(cleanAssistantText(undefined as unknown as string)).toBe('')
    expect(cleanAssistantText(42 as unknown as string)).toBe('')
  })
})

/* ============================== 思考中 ============================== */

describe('思考中占位', () => {
  it('task/start 后无文本 → 思考中...（thinking / 刷新周期 / ownsBubble）', () => {
    const dialogue = new DshDialogue()
    dialogue.pushEvent(TASK_START, T0)
    expect(dialogue.tick(T0)).toEqual({
      text: THINKING_TEXT,
      kind: 'thinking',
      lifetimeMs: THINKING_REFRESH_MS,
      ownsBubble: true
    })
    // 持续到状态变化：30s 后仍返回思考中（调用方每帧 show 刷新即可）。
    const later = dialogue.tick(T0 + 30_000)
    expect(later.kind).toBe('thinking')
    expect(later.text).toBe(THINKING_TEXT)
    // task/end → 思考中结束、释放气泡所有权。
    dialogue.pushEvent(TASK_END, T0 + 30_001)
    const done = dialogue.tick(T0 + 30_001)
    expect(done.text).toBeNull()
    expect(done.ownsBubble).toBe(false)
  })

  it('agent/status running → 思考中；idle → 归 null', () => {
    const dialogue = new DshDialogue()
    dialogue.pushEvent(event('agent/status', { agent: 'a', status: 'running' }), T0)
    expect(dialogue.tick(T0).kind).toBe('thinking')
    dialogue.pushEvent(event('agent/status', { agent: 'a', status: 'idle' }), T0)
    expect(dialogue.tick(T0).text).toBeNull()
  })

  it('assistant 文本到来打断思考中；播完且 busy 仍为 true 时回到思考中', () => {
    const dialogue = new DshDialogue()
    dialogue.pushEvent(TASK_START, T0)
    dialogue.pushEvent(assistant('收到。', { turn: 1, step: 1, seq: 1 }), T0)
    const played = playAll(dialogue, T0)
    expect(played.texts).toEqual(['收到。'])
    expect(played.last.kind).toBe('thinking')
    expect(played.last.ownsBubble).toBe(true)
  })

  it('纯 tool-call 的 assistant/message（无 text）不弹气泡；tool/result 也忽略', () => {
    const dialogue = new DshDialogue()
    dialogue.pushEvent(TASK_START, T0)
    dialogue.pushEvent(
      event('session/event', {
        eventType: 'assistant/message',
        sessionId: 's1',
        turn: 1,
        step: 1,
        seq: 5
      }),
      T0
    )
    expect(dialogue.tick(T0).kind).toBe('thinking')
    dialogue.pushEvent(
      event('session/event', { eventType: 'tool/result', sessionId: 's1', turn: 1, seq: 6 }),
      T0
    )
    expect(dialogue.tick(T0).kind).toBe('thinking')
  })

  it('task/error 立即结束思考中并释放气泡所有权', () => {
    const dialogue = new DshDialogue()
    dialogue.pushEvent(TASK_START, T0)
    expect(dialogue.tick(T0).kind).toBe('thinking')
    dialogue.pushEvent(TASK_ERROR, T0 + 10)
    expect(dialogue.tick(T0 + 11)).toEqual({
      text: null,
      kind: null,
      lifetimeMs: 0,
      ownsBubble: false
    })
  })
})

/* ============================== 分段 / 停留 / gap ============================== */

describe('分段、停留时长与段间 gap', () => {
  it('短文本单段：dwell = clamp(2200+45*len, 2200, 9000)', () => {
    const dialogue = new DshDialogue()
    const text = '你好世界' // 4 字
    dialogue.pushEvent(assistant(text, { turn: 1, step: 1, seq: 1 }), T0)
    const output = dialogue.tick(T0)
    expect(output.text).toBe(text)
    expect(output.kind).toBe('speech')
    expect(output.ownsBubble).toBe(true)
    expect(output.lifetimeMs).toBe(expectedDwell(text.length))
    expect(output.lifetimeMs).toBe(2380)
    // 段中每帧 show 用该段 dwell 刷新（隐藏时机由状态机决定）。
    expect(dialogue.tick(T0 + 500).lifetimeMs).toBe(expectedDwell(text.length))
  })

  it('dwell 边界：1 字 ≥ MIN，96 字 = 6520 ≤ MAX', () => {
    const shortDialogue = new DshDialogue()
    shortDialogue.pushEvent(assistant('。', { turn: 1, step: 1, seq: 1 }), T0)
    const short = shortDialogue.tick(T0)
    expect(short.lifetimeMs).toBe(MIN_DWELL_MS + DWELL_PER_CHAR_MS)
    expect(short.lifetimeMs).toBeGreaterThanOrEqual(MIN_DWELL_MS)

    const longDialogue = new DshDialogue()
    longDialogue.pushEvent(
      assistant('甲'.repeat(CHUNK_MAX_CHARS), { turn: 1, step: 1, seq: 1 }),
      T0
    )
    const long = longDialogue.tick(T0)
    expect(long.text).toHaveLength(CHUNK_MAX_CHARS)
    expect(long.lifetimeMs).toBe(MIN_DWELL_MS + DWELL_PER_CHAR_MS * CHUNK_MAX_CHARS)
    expect(long.lifetimeMs).toBeLessThanOrEqual(MAX_DWELL_MS)
  })

  it('超长文本优先按句号切块（不把半句硬切成 96）', () => {
    const dialogue = new DshDialogue()
    const sentenceA = '甲'.repeat(80) + '。'
    const sentenceB = '乙'.repeat(80) + '。'
    dialogue.pushEvent(assistant(sentenceA + sentenceB, { turn: 1, step: 1, seq: 1 }), T0)
    const played = playAll(dialogue, T0)
    expect(played.texts).toEqual([sentenceA, sentenceB])
    expect(played.texts.join('')).toBe(sentenceA + sentenceB)
  })

  it('句内超长时按逗号切块', () => {
    const dialogue = new DshDialogue()
    const partA = '甲'.repeat(60) + '，'
    const partB = '乙'.repeat(60) + '。'
    dialogue.pushEvent(assistant(partA + partB, { turn: 1, step: 1, seq: 1 }), T0)
    const played = playAll(dialogue, T0)
    expect(played.texts).toEqual([partA, partB])
  })

  it('英文按空白切块、不切碎单词；所有段 ≤ CHUNK_MAX_CHARS 且拼接守恒', () => {
    const dialogue = new DshDialogue()
    const text = 'word '.repeat(30).trim()
    dialogue.pushEvent(assistant(text, { turn: 1, step: 1, seq: 1 }), T0)
    const played = playAll(dialogue, T0)
    expect(played.texts.length).toBeGreaterThan(1)
    expect(played.texts.join('')).toBe(text)
    for (const chunk of played.texts) {
      expect(chunk.length).toBeLessThanOrEqual(CHUNK_MAX_CHARS)
      expect(chunk.trim()).toMatch(/^word( word)*$/)
    }
  })

  it('无标点超长文本硬切 96 / 96 / 余数，且拼接守恒', () => {
    const dialogue = new DshDialogue()
    const text = '甲'.repeat(250)
    dialogue.pushEvent(assistant(text, { turn: 1, step: 1, seq: 1 }), T0)
    const played = playAll(dialogue, T0)
    expect(played.texts.map((chunk) => chunk.length)).toEqual([96, 96, 58])
    expect(played.texts.join('')).toBe(text)
  })

  it('两段之间完全隐藏 INTER_SEGMENT_GAP_MS=350ms（边界精确）', () => {
    const dialogue = new DshDialogue()
    const sentenceA = '甲'.repeat(80) + '。'
    const sentenceB = '乙'.repeat(80) + '。'
    dialogue.pushEvent(assistant(sentenceA + sentenceB, { turn: 1, step: 1, seq: 1 }), T0)

    const first = dialogue.tick(T0)
    expect(first.text).toBe(sentenceA)
    const hideAt = T0 + first.lifetimeMs
    // 隐藏时刻前 1ms 仍在显示。
    expect(dialogue.tick(hideAt - 1).text).toBe(sentenceA)
    // 到隐藏时刻进入 gap：无文本，但气泡仍归 dialogue（主进程 hide）。
    expect(dialogue.tick(hideAt)).toEqual({
      text: null,
      kind: null,
      lifetimeMs: 0,
      ownsBubble: true
    })
    // gap 结束前 1ms 仍是 gap。
    expect(dialogue.tick(hideAt + INTER_SEGMENT_GAP_MS - 1).ownsBubble).toBe(true)
    expect(dialogue.tick(hideAt + INTER_SEGMENT_GAP_MS - 1).text).toBeNull()
    // gap 结束 → 下一段（lifetime 为该段 dwell）。
    const second = dialogue.tick(hideAt + INTER_SEGMENT_GAP_MS)
    expect(second.text).toBe(sentenceB)
    expect(second.kind).toBe('speech')
    expect(second.lifetimeMs).toBe(expectedDwell(sentenceB.length))
  })

  it('最后一段后同样有尾 gap（给主进程 hide 帧），之后 busy=false 归 null 并释放气泡', () => {
    const dialogue = new DshDialogue()
    const sentenceA = '甲'.repeat(80) + '。'
    const sentenceB = '乙'.repeat(80) + '。'
    dialogue.pushEvent(assistant(sentenceA + sentenceB, { turn: 1, step: 1, seq: 1 }), T0)

    const first = dialogue.tick(T0)
    expect(first.text).toBe(sentenceA)
    const nextStartAt = T0 + first.lifetimeMs + INTER_SEGMENT_GAP_MS
    const second = dialogue.tick(nextStartAt)
    expect(second.text).toBe(sentenceB)
    const secondHideAt = nextStartAt + second.lifetimeMs
    // 尾 gap：仍 ownsBubble（主进程可 hide 掉最后一段）。
    expect(dialogue.tick(secondHideAt)).toEqual({
      text: null,
      kind: null,
      lifetimeMs: 0,
      ownsBubble: true
    })
    // 尾 gap 结束 → busy=false 归 null 并释放气泡。
    expect(dialogue.tick(secondHideAt + INTER_SEGMENT_GAP_MS)).toEqual({
      text: null,
      kind: null,
      lifetimeMs: 0,
      ownsBubble: false
    })
  })

  it('长帧跳过已完全错过的段（不做补播）', () => {
    const dialogue = new DshDialogue()
    const segments = [1, 2, 3].map((index) => '第' + index + '甲'.repeat(86) + '。')
    dialogue.pushEvent(assistant(segments.join(''), { turn: 1, step: 1, seq: 1 }), T0)
    expect(dialogue.tick(T0).text).toBe(segments[0])
    const dwell = expectedDwell(segments[0].length)
    const nextStart = (offset: number): number => T0 + offset * (dwell + INTER_SEGMENT_GAP_MS)
    // 直接跳到第 3 段的显示窗口中间：第 1、2 段视为已错过。
    const third = dialogue.tick(nextStart(2) + 100)
    expect(third.text).toBe(segments[2])
    expect(third.kind).toBe('speech')
    expect(third.lifetimeMs).toBe(dwell)
  })
})

/* ============================== 队列上限 / turn 预算 ============================== */

describe('队列上限与单 turn 文本预算', () => {
  it('队列上限 QUEUE_MAX=8：一次入队 10 段时丢最旧 2 段', () => {
    const dialogue = new DshDialogue()
    const sentences = Array.from(
      { length: 10 },
      (_, index) => '第' + (index + 1) + '甲'.repeat(86) + '。'
    )
    dialogue.pushEvent(assistant(sentences.join(''), { turn: 1, step: 1, seq: 1 }), T0)
    const played = playAll(dialogue, T0)
    expect(played.texts).toHaveLength(QUEUE_MAX)
    expect(played.texts).toEqual(sentences.slice(2))
    expect(played.texts.join('')).toBe(sentences.slice(2).join(''))
  })

  it('单 turn 4000 字预算：用尽后新文本不再入队', () => {
    const dialogue = new DshDialogue()
    for (let step = 1; step <= 4; step += 1) {
      dialogue.pushEvent(assistant('甲'.repeat(1000), { turn: 1, step, seq: step }), T0)
      const played = playAll(dialogue, T0)
      // 1000 字 → 11 段，队列上限 8 → 只播最后 8 段（弃最旧）。
      expect(played.texts).toHaveLength(QUEUE_MAX)
    }
    // 第 5 条 → 预算已满，整条丢弃（不会产生任何 speech）。
    dialogue.pushEvent(assistant('乙'.repeat(1000), { turn: 1, step: 5, seq: 5 }), T0)
    expect(playAll(dialogue, T0).texts).toEqual([])
  })

  it('预算剩余不足时截断到剩余字符（3900 + 500 → 只播前 100）', () => {
    const dialogue = new DshDialogue()
    const lengths = [1000, 1000, 1000, 900]
    lengths.forEach((length, index) => {
      dialogue.pushEvent(
        assistant('甲'.repeat(length), { turn: 1, step: index + 1, seq: index + 1 }),
        T0
      )
      playAll(dialogue, T0)
    })
    dialogue.pushEvent(assistant('乙'.repeat(500), { turn: 1, step: 5, seq: 5 }), T0)
    const played = playAll(dialogue, T0)
    expect(played.texts.join('')).toBe('乙'.repeat(100))
    expect(played.texts.map((chunk) => chunk.length)).toEqual([96, 4])
  })

  it('新 turn 预算重置（turn=2 可以再播满）', () => {
    const dialogue = new DshDialogue()
    for (let step = 1; step <= 4; step += 1) {
      dialogue.pushEvent(assistant('甲'.repeat(1000), { turn: 1, step, seq: step }), T0)
      playAll(dialogue, T0)
    }
    dialogue.pushEvent(assistant('丙丁。', { turn: 2, step: 1, seq: 1 }), T0)
    expect(playAll(dialogue, T0).texts).toEqual(['丙丁。'])
  })
})

/* ============================== 去重 ============================== */

describe('去重（sessionId+turn+step+seq / text hash）', () => {
  it('完全相同的事件（同 id）重复到达只播一次', () => {
    const dialogue = new DshDialogue()
    const duplicate = assistant('重复检测。', { turn: 1, step: 1, seq: 1 })
    dialogue.pushEvent(duplicate, T0)
    expect(playAll(dialogue, T0).texts).toEqual(['重复检测。'])
    dialogue.pushEvent(duplicate, T0)
    const replay = playAll(dialogue, T0)
    expect(replay.texts).toEqual([])
    expect(replay.last.ownsBubble).toBe(false)
  })

  it('无 id 的脏事件退化为文本 hash 去重', () => {
    const dialogue = new DshDialogue()
    const noId = event('session/event', { eventType: 'assistant/message', text: '无编号文本。' })
    dialogue.pushEvent(noId, T0)
    expect(playAll(dialogue, T0).texts).toEqual(['无编号文本。'])
    dialogue.pushEvent(noId, T0)
    expect(playAll(dialogue, T0).texts).toEqual([])
  })

  it('多 session 不串：sessionId 不同则相同 turn/step/seq 也分别入队', () => {
    const dialogue = new DshDialogue()
    dialogue.pushEvent(
      assistant('同文。', { sessionId: 'session-a', turn: 1, step: 1, seq: 1 }),
      T0
    )
    dialogue.pushEvent(
      assistant('同文。', { sessionId: 'session-b', turn: 1, step: 1, seq: 1 }),
      T0
    )
    expect(playAll(dialogue, T0).texts).toEqual(['同文。', '同文。'])
  })

  it('不同 seq 的相同文本是两条合法消息，都播', () => {
    const dialogue = new DshDialogue()
    dialogue.pushEvent(assistant('相同句。', { turn: 1, step: 1, seq: 1 }), T0)
    dialogue.pushEvent(assistant('相同句。', { turn: 1, step: 2, seq: 2 }), T0)
    expect(playAll(dialogue, T0).texts).toEqual(['相同句。', '相同句。'])
  })

  it('DEDUPE_SIZE=32 FIFO 窗口：第 33 个 key 淘汰最旧后可重播', () => {
    const dialogue = new DshDialogue()
    const eventOf = (index: number): DshEvent =>
      assistant('第' + index + '。', { turn: 1, step: index, seq: index })
    for (let index = 1; index <= DEDUPE_SIZE; index += 1) {
      dialogue.pushEvent(eventOf(index), T0)
      expect(playAll(dialogue, T0).texts).toEqual(['第' + index + '。'])
    }
    // 窗口内（32 个 key）：重播被去重。
    dialogue.pushEvent(eventOf(1), T0)
    expect(playAll(dialogue, T0).texts).toEqual([])
    // 第 33 个 key 入窗 → 最旧的 eventOf(1) 被淘汰。
    dialogue.pushEvent(eventOf(33), T0)
    expect(playAll(dialogue, T0).texts).toEqual(['第33。'])
    // 再次重播 eventOf(1)：已不在窗口 → 重新接受。
    dialogue.pushEvent(eventOf(1), T0)
    expect(playAll(dialogue, T0).texts).toEqual(['第1。'])
  })
})

/* ============================== 生命周期 / ownsBubble ============================== */

describe('turn/task 生命周期与 ownsBubble 边界', () => {
  it('task/start 清空旧队列与当前段（防上一轮堆积），进入思考中', () => {
    const dialogue = new DshDialogue()
    const sentences = ['甲'.repeat(80) + '。', '乙'.repeat(80) + '。']
    dialogue.pushEvent(TASK_START, T0)
    dialogue.pushEvent(assistant(sentences.join(''), { turn: 1, step: 1, seq: 1 }), T0)
    expect(dialogue.tick(T0).text).toBe(sentences[0])

    dialogue.pushEvent(TASK_START, T0 + 1)
    const cleared = dialogue.tick(T0 + 2)
    expect(cleared.kind).toBe('thinking')
    expect(cleared.text).toBe(THINKING_TEXT)
    expect(cleared.ownsBubble).toBe(true)

    dialogue.pushEvent(TASK_END, T0 + 3)
    expect(dialogue.tick(T0 + 4).text).toBeNull()
    expect(dialogue.tick(T0 + 500).text).toBeNull()
  })

  it('task/error 清空未播文本并立即释放气泡所有权（不再补播旧队列）', () => {
    const dialogue = new DshDialogue()
    const sentences = ['甲'.repeat(80) + '。', '乙'.repeat(80) + '。']
    dialogue.pushEvent(TASK_START, T0)
    dialogue.pushEvent(assistant(sentences.join(''), { turn: 1, step: 1, seq: 1 }), T0)
    expect(dialogue.tick(T0).kind).toBe('speech')

    dialogue.pushEvent(TASK_ERROR, T0 + 100)
    const afterError = dialogue.tick(T0 + 101)
    expect(afterError).toEqual({ text: null, kind: null, lifetimeMs: 0, ownsBubble: false })
    // 之前入队的第二段不会在之后补播。
    expect(playAll(dialogue, T0 + 500).texts).toEqual([])
  })

  it('task/end 后已入队文本继续播完，播完归 null（不再思考中）', () => {
    const dialogue = new DshDialogue()
    const sentences = ['甲'.repeat(80) + '。', '乙'.repeat(80) + '。']
    dialogue.pushEvent(TASK_START, T0)
    dialogue.pushEvent(assistant(sentences.join(''), { turn: 1, step: 1, seq: 1 }), T0)
    dialogue.pushEvent(TASK_END, T0)
    const played = playAll(dialogue, T0)
    expect(played.texts).toEqual(sentences)
    expect(played.last.kind).toBeNull()
    expect(played.last.ownsBubble).toBe(false)
  })

  it('turn/end（session/event）结束 busy，队列照常播完归 null', () => {
    const dialogue = new DshDialogue()
    const sentences = ['甲'.repeat(80) + '。', '乙'.repeat(80) + '。']
    dialogue.pushEvent(TASK_START, T0)
    dialogue.pushEvent(assistant(sentences.join(''), { turn: 1, step: 1, seq: 1 }), T0)
    dialogue.pushEvent(
      event('session/event', {
        eventType: 'turn/end',
        sessionId: 's1',
        turn: 1,
        seq: 9,
        reasonKind: 'completed'
      }),
      T0
    )
    const played = playAll(dialogue, T0)
    expect(played.texts).toEqual(sentences)
    expect(played.last.ownsBubble).toBe(false)
  })

  it('reset()（dshBubbleSync 关闭 / DSH offline）清空队列、busy 与去重，并可重新开始', () => {
    const dialogue = new DshDialogue()
    const message = assistant('重置测试。', { turn: 1, step: 1, seq: 1 })
    dialogue.pushEvent(TASK_START, T0)
    dialogue.pushEvent(message, T0)
    expect(dialogue.tick(T0).text).toBe('重置测试。')

    dialogue.reset()
    expect(dialogue.tick(T0)).toEqual({ text: null, kind: null, lifetimeMs: 0, ownsBubble: false })
    expect(dialogue.tick(T0 + 10_000)).toEqual({
      text: null,
      kind: null,
      lifetimeMs: 0,
      ownsBubble: false
    })

    // reset 清掉了去重/busy：同一事件可重新入队播放。
    dialogue.pushEvent(message, T0 + 20_000)
    expect(playAll(dialogue, T0 + 20_000).texts).toEqual(['重置测试。'])
  })

  it('ownsBubble 三态矩阵：思考/回复/gap=true；播完/错误/reset=false', () => {
    const dialogue = new DshDialogue()
    expect(dialogue.tick(T0).ownsBubble).toBe(false)

    dialogue.pushEvent(TASK_START, T0)
    const thinking = dialogue.tick(T0)
    expect(thinking.ownsBubble).toBe(true)
    expect(thinking.kind).toBe('thinking')

    const sentenceA = '甲'.repeat(80) + '。'
    const sentenceB = '乙'.repeat(80) + '。'
    dialogue.pushEvent(assistant(sentenceA + sentenceB, { turn: 1, step: 1, seq: 1 }), T0 + 1)
    const speech = dialogue.tick(T0 + 2)
    expect(speech.ownsBubble).toBe(true)
    expect(speech.kind).toBe('speech')

    const gap = dialogue.tick(T0 + 2 + expectedDwell(sentenceA.length))
    expect(gap.text).toBeNull()
    expect(gap.ownsBubble).toBe(true)

    dialogue.pushEvent(TASK_ERROR, T0 + 100_000)
    expect(dialogue.tick(T0 + 100_001).ownsBubble).toBe(false)
  })
})

/* ============================== 脏输入 / 时钟 ============================== */

describe('脏输入与时钟安全', () => {
  it('脏事件（null/未知类型/坏 payload/非字符串 text/空 text）安全忽略且不抛', () => {
    const dialogue = new DshDialogue()
    expect(() => dialogue.pushEvent(null as unknown as DshEvent, T0)).not.toThrow()
    expect(() => dialogue.pushEvent({} as DshEvent, T0)).not.toThrow()
    expect(() =>
      dialogue.pushEvent(
        { ts: T0, type: 'agent/created', payload: {} } as unknown as DshEvent,
        T0
      )
    ).not.toThrow()
    expect(() =>
      dialogue.pushEvent(
        { ts: T0, type: 'session/event', payload: null } as unknown as DshEvent,
        T0
      )
    ).not.toThrow()
    expect(() =>
      dialogue.pushEvent(
        event('session/event', { eventType: 'assistant/message', text: 123 }),
        T0
      )
    ).not.toThrow()
    expect(() =>
      dialogue.pushEvent(event('session/event', { eventType: 'assistant/message', text: '   ' }), T0)
    ).not.toThrow()
    expect(dialogue.tick(T0).text).toBeNull()
    // 状态未被脏输入破坏。
    dialogue.pushEvent(TASK_START, T0)
    expect(dialogue.tick(T0).kind).toBe('thinking')
  })

  it('tick 传入 NaN/Infinity 安全返回空闲输出且不推进时间线', () => {
    const dialogue = new DshDialogue()
    dialogue.pushEvent(TASK_START, T0)
    expect(dialogue.tick(Number.NaN).ownsBubble).toBe(false)
    expect(dialogue.tick(Number.POSITIVE_INFINITY).text).toBeNull()
    // 状态未被破坏：仍可正常进入思考中。
    expect(dialogue.tick(T0).kind).toBe('thinking')

    dialogue.pushEvent(assistant('你好。', { turn: 1, step: 1, seq: 1 }), T0)
    const speech = dialogue.tick(T0)
    expect(speech.kind).toBe('speech')
    // 非有限时钟不推进播放时间线，下一合法帧仍显示同一段。
    expect(dialogue.tick(Number.NaN).text).toBeNull()
    expect(dialogue.tick(T0 + 100).text).toBe('你好。')
  })
})
