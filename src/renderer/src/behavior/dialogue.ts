/**
 * B1 台词气泡池 + 冷却门（纯 TS；**不 import DOM / three / Electron / Node 内置**）。
 *
 * ⚠️ 台词来源（用户硬性要求，2026-11-08）：
 * 本文件的台词**全部为《崩坏：星穹铁道》游戏内砂金 / 砂金·戏浪的官方中文语音原文**，
 * 原文存放于私有资产 `assets/voicelines.json`（入库排除），由 `core/voicelines.ts` 读取并派生场景池。
 * - **禁止自创/改写/仿写**；每句保留原文（含「…」「？」等标点），不得改词；
 * - 场景映射（用户 2026-11-08 指示，见 `core/voicelines.ts` 文件头）：
 *   任务成功/完成庆祝 = 开启战利品/终结技/角色晋阶/角色满级/行迹激活；
 *   失败/出错 = 无法战斗；
 *   闲置 = 关于自己/闲谈/爱好/烦恼/分享/见闻/关于系列/回合待机；
 *   鼠标靠近 = 问候；摸头 = 回合待机+返回城镇；戳 = 轻受击；拖拽 = 重受击；
 *   DSH 忙碌 = 战技/秘技/战斗开始；
 *
 * 冷却规则（B1 验收：气泡冷却 ≥60s、同一场景不刷屏）：
 * - 全局：任意两条台词气泡间隔 ≥ `bubbleGlobalCooldownMs`（默认 60s）；
 * - 同类场景：同一 category 间隔 ≥ `bubbleCategoryCooldownMs`（默认 120s）；
 * - 同一句：间隔 ≥ `bubbleLineCooldownMs`（默认 300s），且不连续重复上一句；
 * - 外部 DSH 气泡由 B7 的 `ExternalReaction.bubble` 提供（一次性、只播一次），
 *   出现后会刷新全局冷却，避免紧接着又冒自主台词。
 */

/** 台词场景分类。 */
export type BubbleCategory =
  | 'pat'
  | 'poke'
  | 'drag'
  | 'celebrate'
  | 'gloom'
  | 'idle'
  | 'hover'
  | 'dshBusy'
  | 'dshDone'
  | 'dshError'

import {
  BUSY_BUBBLES,
  DEFEAT_BUBBLES,
  DRAG_BUBBLES,
  GREETING_BUBBLES,
  IDLE_BUBBLES,
  PAT_BUBBLES,
  POKE_BUBBLES,
  SUCCESS_BUBBLES
} from '../core/voicelines'

/**
 * 官方语音台词池（全部原文照录；单一来源 = `core/voicelines.ts`；分场景映射见文件头注释）。
 *
 * 说明：台词池较长（如闲置池覆盖两个版本的全部「关于/闲谈/爱好…」语音），由 `BubbleGate`
 * 的全局/同类/同句冷却控制频率；同一句官方原文允许跨场景复用。
 */
export const BUBBLE_LINES: Readonly<Record<BubbleCategory, readonly string[]>> = {
  pat: PAT_BUBBLES,
  poke: POKE_BUBBLES,
  drag: DRAG_BUBBLES,
  celebrate: SUCCESS_BUBBLES,
  gloom: DEFEAT_BUBBLES,
  idle: IDLE_BUBBLES,
  hover: GREETING_BUBBLES,
  dshBusy: BUSY_BUBBLES,
  dshDone: SUCCESS_BUBBLES,
  dshError: DEFEAT_BUBBLES
}

/** 气泡冷却默认值（毫秒）。 */
export const DEFAULT_BUBBLE_COOLDOWNS = {
  globalMs: 60_000,
  categoryMs: 120_000,
  lineMs: 300_000
} as const

/** 冒烟/单测可用的全部台词（扁平化，只读快照）。 */
export function collectAllBubbleLines(): string[] {
  const lines: string[] = []
  for (const category of Object.keys(BUBBLE_LINES) as BubbleCategory[]) {
    for (const line of BUBBLE_LINES[category]) lines.push(line)
  }
  return lines
}

/** `BubbleGate` 构造参数。 */
export interface BubbleGateOptions {
  globalCooldownMs?: number
  categoryCooldownMs?: number
  lineCooldownMs?: number
}

interface CooldownState {
  /** 最近一次任意气泡的时钟。 */
  lastAnyAtMs: number | null
  /** category → 最近一次时钟。 */
  categoryAtMs: Map<BubbleCategory, number>
  /** 台词文本 → 最近一次时钟。 */
  lineAtMs: Map<string, number>
  /** 最近一条台词（用于避免连续重复）。 */
  lastLine: string | null
}

function normalizeCooldown(value: number | undefined, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return fallback
  return value
}

/**
 * 气泡冷却门：所有自主/交互台词都从这里过，保证不刷屏、可复现。
 * 纯逻辑类，时钟由调用方传入（不读 Date.now/performance.now）。
 */
export class BubbleGate {
  private readonly globalCooldownMs: number
  private readonly categoryCooldownMs: number
  private readonly lineCooldownMs: number
  private readonly state: CooldownState = {
    lastAnyAtMs: null,
    categoryAtMs: new Map<BubbleCategory, number>(),
    lineAtMs: new Map<string, number>(),
    lastLine: null
  }

  constructor(options: BubbleGateOptions = {}) {
    this.globalCooldownMs = normalizeCooldown(
      options.globalCooldownMs,
      DEFAULT_BUBBLE_COOLDOWNS.globalMs
    )
    this.categoryCooldownMs = normalizeCooldown(
      options.categoryCooldownMs,
      DEFAULT_BUBBLE_COOLDOWNS.categoryMs
    )
    this.lineCooldownMs = normalizeCooldown(options.lineCooldownMs, DEFAULT_BUBBLE_COOLDOWNS.lineMs)
  }

  /** 全局冷却是否已过（时钟回退视为已过，防止低时钟卡死）。 */
  isGlobalReady(nowMs: number): boolean {
    const last = this.state.lastAnyAtMs
    return last === null || nowMs < last || nowMs - last >= this.globalCooldownMs
  }

  /**
   * 尝试从 category 池里挑一句台词。
   * @returns 台词文本；冷却未过 / 无可用台词时返回 null（**不消耗随机数**）。
   */
  tryEmit(category: BubbleCategory, nowMs: number, random: () => number): string | null {
    if (!this.isGlobalReady(nowMs)) return null
    const lastCategory = this.state.categoryAtMs.get(category)
    if (
      lastCategory !== undefined &&
      nowMs >= lastCategory &&
      nowMs - lastCategory < this.categoryCooldownMs
    ) {
      return null
    }
    const pool = BUBBLE_LINES[category]
    if (!pool || pool.length === 0) return null
    // 过滤「最近用过的同一句」和「上一句」，剩余候选按固定顺序扫描 → 同 seed 可复现。
    const candidates = pool.filter((line) => {
      if (line === this.state.lastLine) return false
      const last = this.state.lineAtMs.get(line)
      if (last === undefined) return true
      return nowMs < last || nowMs - last >= this.lineCooldownMs
    })
    if (candidates.length === 0) return null
    const index = Math.min(candidates.length - 1, Math.floor(readRandomSafe(random) * candidates.length))
    const line = candidates[index]
    this.record(category, line, nowMs)
    return line
  }

  /**
   * 记录一次外部（DSH）气泡：外部台词由 B7 给现成文本（同样应为官方台词），只播一次，
   * 这里只负责刷新「全局冷却」让自主台词安静一阵。
   */
  notifyExternalBubble(nowMs: number): void {
    this.state.lastAnyAtMs = nowMs
  }

  /** 调试/单测：当前最近一条台词。 */
  get lastLine(): string | null {
    return this.state.lastLine
  }

  /** 调试/单测：指定 category 是否处于冷却。 */
  isCategoryCooling(category: BubbleCategory, nowMs: number): boolean {
    const last = this.state.categoryAtMs.get(category)
    return last !== undefined && nowMs >= last && nowMs - last < this.categoryCooldownMs
  }

  /** 时钟回退/测试重置（清空全部冷却记录）。 */
  reset(): void {
    this.state.lastAnyAtMs = null
    this.state.categoryAtMs.clear()
    this.state.lineAtMs.clear()
    this.state.lastLine = null
  }

  private record(category: BubbleCategory, line: string, nowMs: number): void {
    this.state.lastAnyAtMs = nowMs
    this.state.categoryAtMs.set(category, nowMs)
    this.state.lineAtMs.set(line, nowMs)
    this.state.lastLine = line
  }
}

/** 局部防御：台词挑选用的随机值（与 random.ts 解耦，避免循环依赖时的边界问题）。 */
function readRandomSafe(random: () => number): number {
  let value: number
  try {
    value = random()
  } catch {
    return 0
  }
  if (!Number.isFinite(value) || value <= 0) return 0
  if (value >= 1) return 0.9999999999
  return value
}
