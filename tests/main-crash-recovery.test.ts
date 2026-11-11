/**
 * 单测：生产态崩溃恢复策略（R-05，`src/main/windows/crash-recovery.ts`）。
 *
 * 纯策略测试：不 mock electron、不启动 Electron —— 时钟 / 定时器 / reload 函数全部注入，
 * 用假时钟精确覆盖限流窗口、5s 无响应延迟、5 分钟冷却与容量上界。
 */
import { describe, expect, it, vi } from 'vitest'

import {
  CRASH_RECOVERY_POLICY,
  createCrashRecovery
} from '../src/main/windows/crash-recovery'
import type {
  CrashRecoveryLogger,
  CrashRecoveryPolicy,
  CrashRecoveryTarget,
  CrashRecoveryTimers
} from '../src/main/windows/crash-recovery'

/* --------------------------------- 假时钟 / 计时器 --------------------------------- */

interface FakeTimerTask {
  handle: number
  due: number
  callback: () => void
}

interface FakeClock {
  now(): number
  timers: CrashRecoveryTimers
  /** 推进时钟并同步执行所有到期的定时器（按 due/handle 升序）。 */
  advance(ms: number): void
  /** 尚未执行的定时器数量。 */
  pending(): number
}

function createFakeClock(startMs = 0): FakeClock {
  let current = startMs
  let nextHandle = 1
  const tasks = new Map<number, FakeTimerTask>()

  const timers: CrashRecoveryTimers = {
    setTimeout(callback: () => void, ms: number): unknown {
      const handle = nextHandle
      nextHandle += 1
      tasks.set(handle, { handle, due: current + ms, callback })
      return handle
    },
    clearTimeout(handle: unknown): void {
      tasks.delete(handle as number)
    }
  }

  return {
    now: () => current,
    timers,
    advance(ms: number): void {
      const target = current + ms
      for (;;) {
        let nextTask: FakeTimerTask | null = null
        for (const task of tasks.values()) {
          if (task.due > target) continue
          if (
            !nextTask ||
            task.due < nextTask.due ||
            (task.due === nextTask.due && task.handle < nextTask.handle)
          ) {
            nextTask = task
          }
        }
        if (!nextTask) break
        tasks.delete(nextTask.handle)
        current = nextTask.due
        nextTask.callback()
      }
      current = target
    },
    pending: () => tasks.size
  }
}

/* ------------------------------------ 夹具 ------------------------------------ */

interface FakeTarget extends CrashRecoveryTarget {
  destroyed: boolean
  reloadCalls: number
}

function createTarget(id: number): FakeTarget {
  const target: FakeTarget = {
    id,
    destroyed: false,
    reloadCalls: 0,
    isDestroyed(): boolean {
      return target.destroyed
    },
    reload(): void {
      target.reloadCalls += 1
    }
  }
  return target
}

interface LoggerSpy extends Required<CrashRecoveryLogger> {
  info: ReturnType<typeof vi.fn>
  warn: ReturnType<typeof vi.fn>
  error: ReturnType<typeof vi.fn>
}

function createLoggerSpy(): LoggerSpy {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn()
  } as unknown as LoggerSpy
}

function logText(spy: ReturnType<typeof vi.fn>): string {
  return spy.mock.calls.map((call) => String(call[0])).join('\n')
}

interface Harness {
  clock: FakeClock
  logger: LoggerSpy
  recovery: ReturnType<typeof createCrashRecovery>
}

function createHarness(policy: Partial<CrashRecoveryPolicy> = {}): Harness {
  const clock = createFakeClock()
  const logger = createLoggerSpy()
  const recovery = createCrashRecovery({
    now: clock.now,
    timers: clock.timers,
    logger,
    policy
  })
  return { clock, logger, recovery }
}

/* ----------------------------- render-process-gone ----------------------------- */

describe('R-05 render-process-gone：按 reason 决定是否恢复', () => {
  it('clean-exit 不 reload（正常销毁路径），只记 info', () => {
    const { logger, recovery } = createHarness()
    const target = createTarget(1)

    expect(recovery.handleRenderProcessGone(target, { reason: 'clean-exit' })).toBe(false)
    expect(target.reloadCalls).toBe(0)
    expect(logText(logger.info)).toContain('clean-exit')
    expect(logger.error).not.toHaveBeenCalled()
  })

  it.each(['crashed', 'oom', 'killed', 'abnormal-exit', 'launch-failed', 'integrity-failure', 'memory-eviction'])(
    'reason=%s 触发一次限流 reload',
    (reason) => {
      const { logger, recovery } = createHarness()
      const target = createTarget(7)

      expect(recovery.handleRenderProcessGone(target, { reason })).toBe(true)
      expect(target.reloadCalls).toBe(1)
      expect(logText(logger.error)).toContain(`reason=${reason}`)
      expect(logText(logger.warn)).toContain('webContents 7')
    }
  )

  it('details 缺失（未知 reason）也走恢复；已销毁窗口不 reload', () => {
    const { recovery } = createHarness()
    const target = createTarget(2)

    expect(recovery.handleRenderProcessGone(target, null)).toBe(true)
    expect(target.reloadCalls).toBe(1)

    target.destroyed = true
    expect(recovery.handleRenderProcessGone(target, { reason: 'crashed' })).toBe(false)
    expect(target.reloadCalls).toBe(1)
  })

  it('限流：10 分钟内最多 3 次；窗口滑过后恢复预算', () => {
    const { clock, logger, recovery } = createHarness()
    const target = createTarget(3)

    for (let index = 0; index < 5; index += 1) {
      recovery.handleRenderProcessGone(target, { reason: 'crashed' })
    }
    expect(target.reloadCalls).toBe(CRASH_RECOVERY_POLICY.maxReloads)
    expect(logText(logger.error)).toContain('reload budget exhausted')

    // 刚好 10 分钟：旧时间戳被移出窗口（严格小于窗口才保留），重新允许 reload。
    clock.advance(CRASH_RECOVERY_POLICY.reloadWindowMs)
    expect(recovery.handleRenderProcessGone(target, { reason: 'crashed' })).toBe(true)
    expect(target.reloadCalls).toBe(CRASH_RECOVERY_POLICY.maxReloads + 1)
  })

  it('限流按 webContents.id 隔离：一个窗口耗尽预算不影响另一个', () => {
    const { recovery } = createHarness()
    const crashing = createTarget(10)
    const healthy = createTarget(11)

    for (let index = 0; index < 4; index += 1) {
      recovery.handleRenderProcessGone(crashing, { reason: 'crashed' })
    }
    expect(crashing.reloadCalls).toBe(3)

    expect(recovery.handleRenderProcessGone(healthy, { reason: 'crashed' })).toBe(true)
    expect(healthy.reloadCalls).toBe(1)
  })

  it('reload 抛错被吞掉（只记 error，不冒泡）', () => {
    const { logger, recovery } = createHarness()
    const target = createTarget(4)
    target.reload = (): void => {
      throw new Error('Object has been destroyed')
    }

    expect(() => recovery.handleRenderProcessGone(target, { reason: 'crashed' })).not.toThrow()
    expect(logText(logger.error)).toContain('reload failed')
  })

  it('unresponsive 待触发期间 renderer 崩溃：取消 pending 延迟检查，只 reload 一次', () => {
    const { clock, recovery } = createHarness()
    const target = createTarget(6)

    recovery.handleUnresponsive(target)
    expect(clock.pending()).toBe(1)
    clock.advance(1_000) // 还没到 5s 延迟

    expect(recovery.handleRenderProcessGone(target, { reason: 'crashed' })).toBe(true)
    expect(target.reloadCalls).toBe(1)
    // pending 的 unresponsive 定时器必须被清掉，否则 5s 后会第二次 reload。
    expect(clock.pending()).toBe(0)
    clock.advance(CRASH_RECOVERY_POLICY.unresponsiveDelayMs)
    expect(target.reloadCalls).toBe(1)
  })
})

/* -------------------------------- unresponsive -------------------------------- */

describe('R-05 unresponsive：延迟 5s 等 responsive，超时才 reload', () => {
  it('5s 内无 reload；超时后 reload 一次', () => {
    const { clock, recovery } = createHarness()
    const target = createTarget(1)

    expect(recovery.handleUnresponsive(target)).toBe(true)
    expect(clock.pending()).toBe(1)

    clock.advance(CRASH_RECOVERY_POLICY.unresponsiveDelayMs - 1)
    expect(target.reloadCalls).toBe(0)

    clock.advance(1)
    expect(target.reloadCalls).toBe(1)
    expect(clock.pending()).toBe(0)
  })

  it('延迟期间收到 responsive → 取消，不再 reload', () => {
    const { clock, logger, recovery } = createHarness()
    const target = createTarget(2)

    recovery.handleUnresponsive(target)
    clock.advance(2_000)
    recovery.handleResponsive(target)
    expect(clock.pending()).toBe(0)
    expect(logText(logger.info)).toContain('recovered')

    clock.advance(CRASH_RECOVERY_POLICY.unresponsiveDelayMs)
    expect(target.reloadCalls).toBe(0)
  })

  it('连续 unresponsive 事件合并为一个延迟检查（不重复排队）', () => {
    const { clock, recovery } = createHarness()
    const target = createTarget(3)

    expect(recovery.handleUnresponsive(target)).toBe(true)
    expect(recovery.handleUnresponsive(target)).toBe(false)
    expect(clock.pending()).toBe(1)

    clock.advance(CRASH_RECOVERY_POLICY.unresponsiveDelayMs)
    expect(target.reloadCalls).toBe(1)
  })

  it('unresponsive 冷却 5 分钟：冷却内再次卡死不 reload，冷却后恢复', () => {
    const { clock, logger, recovery } = createHarness()
    const target = createTarget(4)

    recovery.handleUnresponsive(target)
    clock.advance(CRASH_RECOVERY_POLICY.unresponsiveDelayMs)
    expect(target.reloadCalls).toBe(1)

    // 1 分钟后再次卡死：5s 延迟到了，但仍在 5 分钟冷却内。
    clock.advance(60_000)
    recovery.handleUnresponsive(target)
    clock.advance(CRASH_RECOVERY_POLICY.unresponsiveDelayMs)
    expect(target.reloadCalls).toBe(1)
    expect(logText(logger.warn)).toContain('cooldown active')

    // 越过 5 分钟冷却（相对首次 reload 时间）后允许再次 reload。
    clock.advance(CRASH_RECOVERY_POLICY.unresponsiveCooldownMs)
    recovery.handleUnresponsive(target)
    clock.advance(CRASH_RECOVERY_POLICY.unresponsiveDelayMs)
    expect(target.reloadCalls).toBe(2)
  })

  it('已销毁窗口不排入延迟检查；延迟到期时窗口已销毁也不 reload', () => {
    const { clock, recovery } = createHarness()
    const target = createTarget(5)
    target.destroyed = true
    expect(recovery.handleUnresponsive(target)).toBe(false)

    target.destroyed = false
    recovery.handleUnresponsive(target)
    target.destroyed = true
    clock.advance(CRASH_RECOVERY_POLICY.unresponsiveDelayMs)
    expect(target.reloadCalls).toBe(0)
  })

  it('unresponsive 待触发期间 GPU 恢复先 reload：取消 pending 延迟检查，不重复 reload', () => {
    const { clock, recovery } = createHarness()
    const target = createTarget(6)

    recovery.handleUnresponsive(target)
    recovery.handleGpuProcessGone([target])
    clock.advance(CRASH_RECOVERY_POLICY.gpuRecoveryDelayMs)
    expect(target.reloadCalls).toBe(1)
    // GPU 路径的 tryReload 也要清掉同一个 pending unresponsive 定时器。
    expect(clock.pending()).toBe(0)
    clock.advance(CRASH_RECOVERY_POLICY.unresponsiveDelayMs)
    expect(target.reloadCalls).toBe(1)
  })
})

/* --------------------------------- GPU 恢复 --------------------------------- */

describe('R-05 GPU（child-process-gone）：延迟 1s 对存活 overlay 限流 reload', () => {
  it('延迟约 1s；只 reload 存活窗口', () => {
    const { clock, logger, recovery } = createHarness()
    const first = createTarget(1)
    const second = createTarget(2)
    const destroyed = createTarget(3)
    destroyed.destroyed = true

    recovery.handleGpuProcessGone([first, second, destroyed])
    expect(clock.pending()).toBe(1)

    clock.advance(CRASH_RECOVERY_POLICY.gpuRecoveryDelayMs - 1)
    expect(first.reloadCalls + second.reloadCalls).toBe(0)

    clock.advance(1)
    expect(first.reloadCalls).toBe(1)
    expect(second.reloadCalls).toBe(1)
    expect(destroyed.reloadCalls).toBe(0)
    expect(logText(logger.warn)).toContain('recovery finished (2/2')
  })

  it('同一波 GPU 崩溃只排一个定时器（去重）', () => {
    const { clock, recovery } = createHarness()
    const target = createTarget(1)

    recovery.handleGpuProcessGone([target])
    recovery.handleGpuProcessGone([target])
    expect(clock.pending()).toBe(1)

    clock.advance(CRASH_RECOVERY_POLICY.gpuRecoveryDelayMs)
    expect(target.reloadCalls).toBe(1)
  })

  it('空列表 / 全部已销毁不排定时器', () => {
    const { clock, recovery } = createHarness()
    recovery.handleGpuProcessGone([])
    expect(clock.pending()).toBe(0)

    const destroyed = createTarget(1)
    destroyed.destroyed = true
    recovery.handleGpuProcessGone([destroyed])
    expect(clock.pending()).toBe(0)
  })

  it('与崩溃 reload 共享同一 10 分钟限流预算（关掉同事故去重，隔离验证预算）', () => {
    // incidentDedupeMs=0：本用例只验证「预算共享」，不验证去重（去重见下方用例）。
    const { clock, logger, recovery } = createHarness({ incidentDedupeMs: 0 })
    const target = createTarget(1)
    for (let index = 0; index < CRASH_RECOVERY_POLICY.maxReloads; index += 1) {
      recovery.handleRenderProcessGone(target, { reason: 'crashed' })
    }
    expect(target.reloadCalls).toBe(CRASH_RECOVERY_POLICY.maxReloads)

    recovery.handleGpuProcessGone([target])
    expect(logText(logger.warn)).toContain('scheduling')

    clock.advance(CRASH_RECOVERY_POLICY.gpuRecoveryDelayMs)
    // 预算已被 3 次崩溃耗尽：GPU 恢复只记 error，不再 reload。
    expect(target.reloadCalls).toBe(CRASH_RECOVERY_POLICY.maxReloads)
    expect(logText(logger.error)).toContain('reload budget exhausted')
  })

  it('同一事故去重：renderer 刚 reload 过，GPU 波不再重复 reload / 重复扣预算', () => {
    const { clock, logger, recovery } = createHarness()
    const target = createTarget(1)

    expect(recovery.handleRenderProcessGone(target, { reason: 'crashed' })).toBe(true)
    expect(target.reloadCalls).toBe(1)

    recovery.handleGpuProcessGone([target])
    clock.advance(CRASH_RECOVERY_POLICY.gpuRecoveryDelayMs)
    // GPU 计时器到点时间距 renderer reload 仅 gpuRecoveryDelayMs(< incidentDedupeMs) → 跳过。
    expect(target.reloadCalls).toBe(1)
    expect(logText(logger.warn)).toContain('1 recent reload(s) skipped')

    // 再连崩 2 次仍允许（预算只被用了 1 次）→ 证明跳过的 GPU reload 没有扣预算。
    expect(recovery.handleRenderProcessGone(target, { reason: 'crashed' })).toBe(true)
    expect(recovery.handleRenderProcessGone(target, { reason: 'crashed' })).toBe(true)
    expect(target.reloadCalls).toBe(3)
    // 第 4 次才耗尽。
    expect(recovery.handleRenderProcessGone(target, { reason: 'crashed' })).toBe(false)
  })

  it('去重窗之外：GPU 波仍会 reload（reload 后再次真崩溃必须能恢复）', () => {
    const { clock, recovery } = createHarness()
    const target = createTarget(1)

    recovery.handleRenderProcessGone(target, { reason: 'crashed' })
    expect(target.reloadCalls).toBe(1)
    clock.advance(CRASH_RECOVERY_POLICY.incidentDedupeMs)

    recovery.handleGpuProcessGone([target])
    clock.advance(CRASH_RECOVERY_POLICY.gpuRecoveryDelayMs)
    expect(target.reloadCalls).toBe(2)
  })

  it('GPU clean-exit（正常退出）不排定时器、不 reload', () => {
    const { clock, logger, recovery } = createHarness()
    const target = createTarget(1)

    recovery.handleGpuProcessGone([target], { reason: 'clean-exit' })
    expect(clock.pending()).toBe(0)
    clock.advance(CRASH_RECOVERY_POLICY.gpuRecoveryDelayMs)
    expect(target.reloadCalls).toBe(0)
    expect(logText(logger.info)).toContain('clean-exit')

    // 非 clean-exit 仍正常排队
    recovery.handleGpuProcessGone([target], { reason: 'crashed' })
    expect(clock.pending()).toBe(1)
    clock.advance(CRASH_RECOVERY_POLICY.gpuRecoveryDelayMs)
    expect(target.reloadCalls).toBe(1)
  })
})

/* ------------------------------- 容量 / 清理 ------------------------------- */

describe('R-05 状态容量有界 / dispose 清理', () => {
  it('跟踪的 webContents 数量不超过 maxTrackedTargets', () => {
    const { recovery } = createHarness()
    for (let id = 1; id <= 100; id += 1) {
      recovery.handleRenderProcessGone(createTarget(id), { reason: 'crashed' })
    }
    expect(recovery.trackedCount).toBe(CRASH_RECOVERY_POLICY.maxTrackedTargets)
  })

  it('dispose 清空全部延迟定时器与状态；之后调用为 no-op', () => {
    const { clock, recovery } = createHarness()
    const target = createTarget(1)
    recovery.handleUnresponsive(target)
    recovery.handleGpuProcessGone([target])
    expect(clock.pending()).toBe(2)

    recovery.dispose()
    expect(clock.pending()).toBe(0)
    expect(recovery.trackedCount).toBe(0)

    expect(recovery.handleUnresponsive(target)).toBe(false)
    recovery.handleGpuProcessGone([target])
    clock.advance(CRASH_RECOVERY_POLICY.unresponsiveCooldownMs)
    expect(target.reloadCalls).toBe(0)

    // 幂等
    expect(() => recovery.dispose()).not.toThrow()
  })
})
