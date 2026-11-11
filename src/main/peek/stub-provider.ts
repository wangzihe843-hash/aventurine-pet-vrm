/**
 * 窥屏 stub provider —— 本轮唯一 provider 形态（Wave 3 A7 接口预留）。
 *
 * 硬性行为（测试锚定）：
 * - `capabilities()` 恒返回空数组（不声明任何采集能力）；
 * - `observe()` 恒返回 `{ ok: false, reason: 'not-implemented' }`；
 * - `dispose()` 幂等 no-op；
 * - **零采集副作用**：不读屏幕/窗口标题、不 spawn helper、不写文件、不申请 TCC、不联网、
 *   不设置定时器；只 import `@shared/peek` 的类型（连定时器依赖都没有）。
 *
 * 未来接线：Lead 在 main 进程用真实 provider 替换本 stub，并先过 `evaluatePeekGate`；
 * 本文件保持为「不可用 provider」的参考实现（见 docs/peek-interface.md）。
 */
import type {
  PeekCapability,
  PeekObservationRequest,
  PeekObservationResult,
  PeekProvider
} from '@shared/peek'

/** stub provider id（未来 status.provider 可读；用于区分「接口占位」与真实实现）。 */
export const PEEK_STUB_PROVIDER_ID = 'stub'

/** stub provider 版本（语义化占位：0.0.0-interface）。 */
export const PEEK_STUB_PROVIDER_VERSION = '0.0.0-interface'

/** 本轮统一的「不可用」结果（每次返回新对象，避免调用方共享可变引用）。 */
export function createPeekNotImplementedResult(): PeekObservationResult {
  return { ok: false, reason: 'not-implemented' }
}

/**
 * 创建 stub provider：不采集、不抛异常、无副作用。
 * 即使传入脏请求（或 dispose 之后再次调用）也只返回 not-implemented，绝不读取请求字段。
 */
export function createStubPeekProvider(): PeekProvider {
  return {
    id: PEEK_STUB_PROVIDER_ID,
    version: PEEK_STUB_PROVIDER_VERSION,
    capabilities(): readonly PeekCapability[] {
      return []
    },
    async observe(_request: PeekObservationRequest): Promise<PeekObservationResult> {
      // 不读取 _request：stub 没有任何采集路径，也不需要外部输入。
      return createPeekNotImplementedResult()
    },
    dispose(): void {
      // stub 不持有任何资源（无 helper/连接/缓冲）；幂等 no-op。
    }
  }
}
