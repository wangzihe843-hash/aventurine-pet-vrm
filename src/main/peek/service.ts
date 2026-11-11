/**
 * 窥屏服务（Wave 3 A7 接口预留）—— **本轮不接线、零采集、零副作用**。
 *
 * 设计依据：`docs/wave3-dsh-integration-design.md` §8 + `docs/research/peek-interface-audit-2026-11-11.md`。
 *
 * 行为契约（测试锚定）：
 * - `getStatus()`：返回**全关**状态（enabled=false / tier='off' / 所有 capability
 *   unavailable / notImplemented=true）；每次返回新对象，调用方改动不影响内部。
 * - `observe()`：恒返回 `{ ok: false, reason: 'not-implemented' }`；
 *   **不调用** 注入的 providers、不采集、不写日志、不抛异常（任何脏输入都安全）。
 * - `dispose()`：幂等 no-op（无 timer / helper / 连接可释放）。
 *
 * 依赖边界（`pnpm typecheck` 与静态测试共同保证）：
 * - 不 import `electron` / `node:*` / 第三方；
 * - 不设置定时器、不 spawn 子进程、不写文件、不申请 TCC。
 *
 * 未来接线（见 `docs/peek-interface.md`，需 Lead 评审）：
 * 1. 真实 provider 实现 `PeekProvider`（P0 先做，零权限）；
 * 2. `observe()` 改为：构造 `PeekObservationRequest` → `evaluatePeekGate(request, getStatus(), now())`
 *    → deny 原样返回；allow 才调用 provider.observe；
 * 3. 由 Lead 在 `src/main/index.ts` 创建实例、在 IPC 层暴露 `getStatus`/`observe`，并补测试。
 */
import {
  PEEK_DEFAULT_STATUS,
  type PeekObservationResult,
  type PeekProvider,
  type PeekStatus
} from '@shared/peek'

/** `createPeekService` 选项（本轮只使用 providers；其余能力在接线时追加）。 */
export interface PeekServiceOptions {
  /**
   * 未来注入的 provider 列表。本轮默认 `[]`（且 `observe()` 不会调用它们）；
   * 传入非空列表只用于未来接线自检——状态依旧全关、observe 依旧 not-implemented。
   */
  readonly providers?: readonly PeekProvider[]
}

/** 服务对外 API（未来由 Lead 接 IPC；本轮不被任何 app 代码 import）。 */
export interface PeekService {
  /** 当前状态快照（全关；每次返回新对象）。 */
  getStatus(): PeekStatus
  /** 本轮恒 `{ ok: false, reason: 'not-implemented' }`；任何输入都不抛。 */
  observe(input?: unknown): Promise<PeekObservationResult>
  /** 幂等释放（本轮无资源）。 */
  dispose(): void
}

/** 由 providers 推导状态：**保持全关**，只把 provider 身份暴露给未来接线自检。 */
function createClosedStatus(providers: readonly PeekProvider[]): PeekStatus {
  const first = providers.length > 0 ? providers[0] : null
  const provider =
    first && typeof first.id === 'string' && typeof first.version === 'string'
      ? { id: first.id, version: first.version }
      : null
  return {
    // 展开默认常量后重建全部可变容器：调用方无法通过 getStatus() 篡改共享状态。
    ...PEEK_DEFAULT_STATUS,
    capabilities: PEEK_DEFAULT_STATUS.capabilities.map((entry) => ({ ...entry })),
    provider,
    sensitiveApps: [...PEEK_DEFAULT_STATUS.sensitiveApps],
    throttle: { ...PEEK_DEFAULT_STATUS.throttle }
  }
}

/**
 * 创建窥屏服务（接口占位）。
 *
 * @param options 只接受 providers（未来接线时再追加 clock/config 等字段）
 */
export function createPeekService(options: PeekServiceOptions = {}): PeekService {
  const providers = Array.isArray(options.providers) ? [...options.providers] : []

  return {
    getStatus(): PeekStatus {
      return createClosedStatus(providers)
    },
    async observe(_input?: unknown): Promise<PeekObservationResult> {
      // 本轮不接线：不读 input、不调用 provider、不采集、不写日志。
      // 未来实现：const decision = evaluatePeekGate(request, this.getStatus(), now());
      //            if (!decision.ok) return { ok: false, reason: decision.reason };
      return { ok: false, reason: 'not-implemented' }
    },
    dispose(): void {
      // 本轮无资源（无 timer/helper/连接）；未来在此释放 provider。
    }
  }
}
