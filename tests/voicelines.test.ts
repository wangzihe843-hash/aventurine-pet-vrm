/**
 * 单测：语音台词（`src/renderer/src/core/voicelines.ts`）
 *
 * 2026-11-11 变更：台词原文**不再进仓库**，改存私有资产 `assets/voicelines.json`
 * （`.gitignore` 排除）。因此本测试分两类：
 * - **与数据无关**：场景池映射（B1 `BUBBLE_LINES`、B7 `DSH_REACTION_BUBBLES` 必须同源）、
 *   缺失私有文件时的安全降级（池为空、不抛错、不阻塞）；
 * - **依赖数据**（本地有私有文件时才跑）：条数/分类覆盖/池内无重复/所有文本 ∈ 原文集合。
 *
 * 用户硬性要求（2026-11-08）不变：气泡台词**禁止自创/改写**，只能用游戏内
 * 砂金 / 砂金·戏浪 的官方中文语音原文；该约束现在由私有数据文件承载，公开库只留读取逻辑。
 */
import { createHash } from 'node:crypto'

import { describe, expect, it } from 'vitest'

import {
  BUSY_BUBBLES,
  canonicalVoiceLineTable,
  DEFEAT_BUBBLES,
  DRAG_BUBBLES,
  GREETING_BUBBLES,
  IDLE_BUBBLES,
  isOfficialVoiceLine,
  OFFICIAL_LINE_TEXTS,
  OFFICIAL_VOICE_LINES,
  PAT_BUBBLES,
  POKE_BUBBLES,
  SUCCESS_BUBBLES,
  VOICE_LINE_STATS,
  VOICE_LINES_LOADED
} from '../src/renderer/src/core/voicelines'
import { BUBBLE_LINES } from '../src/renderer/src/behavior'
import { DSH_REACTION_BUBBLES } from '../src/renderer/src/reactions/dsh'

/** 本地是否配置了私有台词文件（干净 clone 为 false）。 */
const HAS_DATA = VOICE_LINES_LOADED

/** 某分类（可正则）的官方原文集合（两个版本合并、按文本去重）。 */
function linesOf(pattern: RegExp): string[] {
  const result = new Set<string>()
  for (const line of OFFICIAL_VOICE_LINES) {
    if (pattern.test(line.category)) result.add(line.text)
  }
  return [...result]
}

describe('台词池映射（与数据是否存在无关）', () => {
  it('B1 / B7 台词池与单一来源映射一致（不允许各写一份）', () => {
    expect(BUBBLE_LINES.celebrate).toEqual(SUCCESS_BUBBLES)
    expect(BUBBLE_LINES.dshDone).toEqual(SUCCESS_BUBBLES)
    expect(BUBBLE_LINES.gloom).toEqual(DEFEAT_BUBBLES)
    expect(BUBBLE_LINES.dshError).toEqual(DEFEAT_BUBBLES)
    expect(BUBBLE_LINES.dshBusy).toEqual(BUSY_BUBBLES)
    expect(BUBBLE_LINES.idle).toEqual(IDLE_BUBBLES)
    expect(BUBBLE_LINES.hover).toEqual(GREETING_BUBBLES)
    expect(BUBBLE_LINES.pat).toEqual(PAT_BUBBLES)
    expect(BUBBLE_LINES.poke).toEqual(POKE_BUBBLES)
    expect(BUBBLE_LINES.drag).toEqual(DRAG_BUBBLES)
    expect(DSH_REACTION_BUBBLES.dshBusy).toEqual(BUSY_BUBBLES)
    expect(DSH_REACTION_BUBBLES.dshDone).toEqual(SUCCESS_BUBBLES)
    expect(DSH_REACTION_BUBBLES.dshError).toEqual(DEFEAT_BUBBLES)
  })

  it('数据加载后：池内无重复、所有文本 ∈ 官方原文集合（防自创回归）', () => {
    if (!HAS_DATA) return
    const pools = [
      SUCCESS_BUBBLES,
      DEFEAT_BUBBLES,
      IDLE_BUBBLES,
      GREETING_BUBBLES,
      PAT_BUBBLES,
      POKE_BUBBLES,
      DRAG_BUBBLES,
      BUSY_BUBBLES
    ]
    for (const pool of pools) {
      expect(pool.length).toBeGreaterThan(0)
      expect(new Set(pool).size).toBe(pool.length)
      for (const line of pool) {
        expect(OFFICIAL_LINE_TEXTS.has(line)).toBe(true)
        expect(isOfficialVoiceLine(line)).toBe(true)
      }
    }
    expect(isOfficialVoiceLine('这句是自创的')).toBe(false)
  })
})

describe.skipIf(HAS_DATA)('私有台词文件缺失时的降级行为', () => {
  it('所有池为空、统计为零、不抛错（宠物不说话但一切正常）', () => {
    expect(OFFICIAL_VOICE_LINES).toHaveLength(0)
    expect(SUCCESS_BUBBLES).toHaveLength(0)
    expect(DEFEAT_BUBBLES).toHaveLength(0)
    expect(IDLE_BUBBLES).toHaveLength(0)
    expect(GREETING_BUBBLES).toHaveLength(0)
    expect(PAT_BUBBLES).toHaveLength(0)
    expect(POKE_BUBBLES).toHaveLength(0)
    expect(DRAG_BUBBLES).toHaveLength(0)
    expect(BUSY_BUBBLES).toHaveLength(0)
    expect(VOICE_LINE_STATS.total).toBe(0)
    expect(VOICE_LINE_STATS.success).toBe(0)
    expect(OFFICIAL_LINE_TEXTS.size).toBe(0)
    expect(isOfficialVoiceLine('任意文本')).toBe(false)
  })
})

describe.skipIf(!HAS_DATA)('私有台词内容校验（仅本地有 assets/voicelines.json 时）', () => {
  it('规模：基础版 ≥50 条、戏浪版 ≥45 条、总条数一致；每类非空且无空文本', () => {
    expect(VOICE_LINE_STATS.base).toBeGreaterThanOrEqual(50)
    expect(VOICE_LINE_STATS.wave).toBeGreaterThanOrEqual(45)
    expect(VOICE_LINE_STATS.total).toBe(OFFICIAL_VOICE_LINES.length)
    expect(VOICE_LINE_STATS.base + VOICE_LINE_STATS.wave).toBe(OFFICIAL_VOICE_LINES.length)
    for (const line of OFFICIAL_VOICE_LINES) {
      expect(line.text.trim().length).toBeGreaterThan(0)
      expect(line.category.trim().length).toBeGreaterThan(0)
    }
    expect(linesOf(/^无法战斗$/).length).toBe(2)
  })

  it('成功池 = 开启战利品/终结技/角色晋阶/角色满级/行迹激活（两个版本都有覆盖）', () => {
    const success = new Set(SUCCESS_BUBBLES)
    const requiredFamilies: RegExp[] = [
      /^开启.*战利品/,
      /^终结技/,
      /^角色晋阶$/,
      /^角色满级$/,
      /^行迹激活$/
    ]
    for (const family of requiredFamilies) {
      const official = linesOf(family)
      expect(official.length).toBeGreaterThan(0)
      for (const line of official) expect(success.has(line)).toBe(true)
    }
    for (const char of ['砂金', '砂金·戏浪']) {
      const charSuccess = OFFICIAL_VOICE_LINES.filter(
        (line) => line.char === char && success.has(line.text)
      )
      expect(charSuccess.length).toBeGreaterThan(0)
    }
    expect(SUCCESS_BUBBLES.length).toBeGreaterThanOrEqual(15)
  })

  it('失败池 = 无法战斗（两个版本各 1 条）', () => {
    expect(DEFEAT_BUBBLES).toEqual(expect.arrayContaining(['满盘皆输啊…', '扫兴呐。']))
    expect(new Set(DEFEAT_BUBBLES)).toEqual(new Set(linesOf(/^无法战斗$/)))
  })

  it('闲置池 = 关于自己/闲谈/爱好/烦恼/分享/见闻/关于系列/回合待机', () => {
    const idle = new Set(IDLE_BUBBLES)
    expect(idle.size).toBeGreaterThanOrEqual(28)
    for (const family of [
      /^关于自己/,
      /^闲谈/,
      /^爱好$/,
      /^烦恼$/,
      /^分享$/,
      /^见闻$/,
      /^关于/,
      /^回合待机$/
    ]) {
      for (const line of linesOf(family)) expect(idle.has(line)).toBe(true)
    }
    for (const char of ['砂金', '砂金·戏浪']) {
      const count = OFFICIAL_VOICE_LINES.filter(
        (line) => line.char === char && idle.has(line.text)
      ).length
      expect(count).toBeGreaterThanOrEqual(5)
    }
  })

  it('其它交互按同逻辑映射到官方分类', () => {
    expect(new Set(GREETING_BUBBLES)).toEqual(new Set(linesOf(/^问候$/)))
    expect(new Set(POKE_BUBBLES)).toEqual(new Set(linesOf(/^轻受击$/)))
    expect(new Set(DRAG_BUBBLES)).toEqual(new Set(linesOf(/^重受击$/)))
    expect(new Set(PAT_BUBBLES)).toEqual(new Set(linesOf(/^(回合待机|返回城镇)$/)))
    const busyExpected = new Set([
      ...linesOf(/^战技/),
      ...linesOf(/^秘技$/),
      ...linesOf(/^战斗开始/)
    ])
    expect(new Set(BUSY_BUBBLES)).toEqual(busyExpected)
  })
})

/**
 * 数据完整性锁（仅在本地存在 `assets/voicelines.json` 时运行）。
 *
 * 用途：证明台词搬出仓库（TS 数组 → 私有 JSON）后**没有丢句、没有改写、没有重排**。
 * 常量是 2026-11-08 冻结的原始 111 条规范化哈希；若确实要新增/替换台词，重算并更新它即可
 * （干净 clone 没有私有文件 → 整组自动跳过）。
 */
const ORIGINAL_TABLE_SHA256 =
  'c4bba9005fe472bdd9cc17f8613468b0278ef733b344f9c10172afcd01a9a297'

describe.skipIf(!HAS_DATA)('私有台词数据完整性（搬迁未丢句/未改写/未串台）', () => {
  it('规范化全表 SHA-256 == 原始冻结值（逐字、顺序一致）', () => {
    const hash = createHash('sha256').update(canonicalVoiceLineTable(), 'utf8').digest('hex')
    expect(hash).toBe(ORIGINAL_TABLE_SHA256)
  })

  it('规模不变：111 条（基础版 58 + 戏浪版 53）', () => {
    expect(VOICE_LINE_STATS.total).toBe(111)
    expect(VOICE_LINE_STATS.base).toBe(58)
    expect(VOICE_LINE_STATS.wave).toBe(53)
  })

  it('场景池不串台：失败池只有战败、问候池只有问候、成功池不含失败/问候/受击', () => {
    const defeat = new Set(DEFEAT_BUBBLES)
    const success = new Set(SUCCESS_BUBBLES)
    const greeting = new Set(GREETING_BUBBLES)
    expect(defeat).toEqual(new Set(linesOf(/^无法战斗$/)))
    expect(greeting).toEqual(new Set(linesOf(/^问候$/)))
    expect(new Set(POKE_BUBBLES)).toEqual(new Set(linesOf(/^轻受击$/)))
    expect(new Set(DRAG_BUBBLES)).toEqual(new Set(linesOf(/^重受击$/)))
    for (const text of defeat) expect(success.has(text)).toBe(false)
    for (const text of greeting) expect(success.has(text)).toBe(false)
    for (const text of new Set(POKE_BUBBLES)) expect(success.has(text)).toBe(false)
    for (const text of new Set(DRAG_BUBBLES)) expect(success.has(text)).toBe(false)
    expect(defeat.size).toBe(2)
  })
})
