/**
 * 单测：WebGL context 丢失后的页面重载限流（B-02 补强）。
 *
 * 纯函数 + 内存 fake sessionStorage，不启动 Electron / 不碰 DOM。
 */
import { describe, expect, it } from 'vitest'

import {
  CONTEXT_LOSS_RELOAD_MAX,
  CONTEXT_LOSS_RELOAD_STORAGE_KEY,
  CONTEXT_LOSS_RELOAD_WINDOW_MS,
  shouldReloadAfterContextLoss,
  type ContextLossReloadStorage
} from '../src/renderer/src/vrm/context-loss'

function createFakeStorage(initial?: Record<string, string>): ContextLossReloadStorage & {
  data: Map<string, string>
} {
  const data = new Map<string, string>(Object.entries(initial ?? {}))
  return {
    data,
    getItem(key: string): string | null {
      return data.has(key) ? (data.get(key) as string) : null
    },
    setItem(key: string, value: string): void {
      data.set(key, value)
    }
  }
}

function readStore(storage: ContextLossReloadStorage): number[] {
  const raw = storage.getItem(CONTEXT_LOSS_RELOAD_STORAGE_KEY)
  return raw === null ? [] : (JSON.parse(raw) as number[])
}

describe('shouldReloadAfterContextLoss：10 分钟最多 3 次重载', () => {
  it('窗内前 3 次允许并计数，第 4 次拒绝且不再写计数', () => {
    const storage = createFakeStorage()
    const now = 1_000_000
    expect(shouldReloadAfterContextLoss(now, storage)).toBe(true)
    expect(shouldReloadAfterContextLoss(now + 1_000, storage)).toBe(true)
    expect(shouldReloadAfterContextLoss(now + 2_000, storage)).toBe(true)
    expect(readStore(storage)).toHaveLength(CONTEXT_LOSS_RELOAD_MAX)

    // 第 4 次：拒绝，且计数不能被推长（否则持续丢失会永久锁死）
    expect(shouldReloadAfterContextLoss(now + 3_000, storage)).toBe(false)
    expect(readStore(storage)).toHaveLength(CONTEXT_LOSS_RELOAD_MAX)
    // 连续再试仍拒绝
    expect(shouldReloadAfterContextLoss(now + 4_000, storage)).toBe(false)
    expect(readStore(storage)).toHaveLength(CONTEXT_LOSS_RELOAD_MAX)
  })

  it('时间窗外的旧记录被修剪，之后允许重载', () => {
    const now = 2_000_000
    const storage = createFakeStorage({
      [CONTEXT_LOSS_RELOAD_STORAGE_KEY]: JSON.stringify([now - 1_000, now - 2_000, now - 3_000])
    })
    expect(shouldReloadAfterContextLoss(now, storage)).toBe(false)

    // 全部滑出 10 分钟窗口后恢复允许
    const later = now + CONTEXT_LOSS_RELOAD_WINDOW_MS + 1
    expect(shouldReloadAfterContextLoss(later, storage)).toBe(true)
    expect(readStore(storage)).toEqual([later])
  })

  it('损坏 / 非数组 / 非数字内容视为空计数（不阻断恢复）', () => {
    for (const raw of ['not-json', '{}', '["x",null,{}]', 'null', '[]']) {
      const storage = createFakeStorage({ [CONTEXT_LOSS_RELOAD_STORAGE_KEY]: raw })
      expect(shouldReloadAfterContextLoss(1_000, storage)).toBe(true)
      expect(readStore(storage)).toEqual([1_000])
    }
  })

  it('混入的合法历史时间戳仍参与限流（只丢弃非数字项）', () => {
    const now = 1_000_000
    const storage = createFakeStorage({
      [CONTEXT_LOSS_RELOAD_STORAGE_KEY]: JSON.stringify([now - 5_000, 'x', null])
    })
    // 已有 1 个窗内有效时间戳 → 本次计入第 2 个；剩余 1 次预算。
    expect(shouldReloadAfterContextLoss(now, storage)).toBe(true)
    expect(shouldReloadAfterContextLoss(now + 1, storage)).toBe(true)
    expect(shouldReloadAfterContextLoss(now + 2, storage)).toBe(false)
  })

  it('未来时间戳（时钟回拨/篡改）不参与限流', () => {
    const now = 5_000
    const storage = createFakeStorage({
      [CONTEXT_LOSS_RELOAD_STORAGE_KEY]: JSON.stringify([now + 60_000, now + 120_000, now + 180_000])
    })
    expect(shouldReloadAfterContextLoss(now, storage)).toBe(true)
    expect(readStore(storage)).toEqual([now])
  })

  it('存储读写抛异常时放行（限流故障不能阻断恢复）', () => {
    const throwing: ContextLossReloadStorage = {
      getItem(): string | null {
        throw new Error('storage disabled')
      },
      setItem(): void {
        throw new Error('storage disabled')
      }
    }
    expect(shouldReloadAfterContextLoss(1_000, throwing)).toBe(true)
  })
})
