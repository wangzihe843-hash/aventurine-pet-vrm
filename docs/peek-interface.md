# 窥屏互动接口预留（A7 / Wave 3）

> 更新：2026-11-11
> 状态：**接口预留已落地，本轮未接线、未申请 TCC、无任何采集**。
> 依据：[wave3-dsh-integration-design.md](wave3-dsh-integration-design.md) §8 + [research/peek-interface-audit-2026-11-11.md](research/peek-interface-audit-2026-11-11.md)（R4 设计调研）。
> 写入范围：仅新增 6 个文件（见 §1），**未改**任何既有 shared/config/IPC/preload/main/renderer 文件。

## 0. 一句话

窥屏互动的「能力声明 / 权限状态 / fail-closed 闸门 / 不可用 stub」先以**纯接口**形式落库：
默认全关、脏输入一律拒绝、stub 恒 `not-implemented`、零 fs/定时器/Electron 依赖；
真实采集（P0 元数据、P2 OCR、P3 视觉）与 IPC/设置页接线全部留到后续由 Lead 评审后再做。

## 1. 文件清单（本轮全部为新增）

| 文件 | 作用 |
|---|---|
| `src/shared/peek.ts` | 契约根：capability/tier/权限/deny reason/request/result/status/provider 接口 + `PEEK_DEFAULT_STATUS` + 纯函数 `evaluatePeekGate` |
| `src/main/peek/service.ts` | `createPeekService()`：`getStatus()` 全关、`observe()` 恒 `{ ok:false, reason:'not-implemented' }`、`dispose()` 幂等；零副作用 |
| `src/main/peek/stub-provider.ts` | stub provider：`capabilities()` 恒空、`observe()` 恒 not-implemented、`dispose()` 幂等 |
| `tests/peek-gate.test.ts` | 闸门单测（62 例）：默认关闭 / fail-closed / 权限 / 能力 / 敏感应用 / 节流 / 脏输入 / 契约形状 |
| `tests/peek-service.test.ts` | 服务与 stub 单测（41 例）：全关状态 / 恒 not-implemented / provider 零调用 / 静态扫描无采集依赖 |
| `docs/peek-interface.md` | 本文（接口说明 + 未来接线清单） |

**未被任何 app 代码 import**（`src/main/index.ts`、IPC、preload、renderer、设置页均未接线）——接口预留，不影响现有功能与启动路径。

## 2. 契约摘要（`src/shared/peek.ts`）

### 2.1 能力与档位

| capability | 档位 | 说明 | 权限 |
|---|---|---|---|
| `screen.peek.metadata` | `metadata` | P0 元数据（前台 app 名/窗口数/活动分类），来自既有 `pet:windows` 数据，零新权限 | 无 |
| `screen.peek.ocr` | `ocr` | P2 前台**单窗口**截图 + 本机 OCR（未来） | 屏幕录制 TCC |
| `screen.peek.vision` | `vision` | P3 视觉理解（未来，可能出网） | 屏幕录制 TCC + 网络 |

> P1 氛围层（160×90 HSV）**不在本轮冻结的 capability 集内**；未来若要做，需先做契约追加
> （`screen.peek.ambient`）并走 Lead 评审。这是 A7 最小切片的明确取舍。

```ts
export const PEEK_CAPABILITIES = ['screen.peek.metadata', 'screen.peek.ocr', 'screen.peek.vision'] as const
export type PeekCapability = (typeof PEEK_CAPABILITIES)[number]

export const PEEK_TIERS = ['off', 'metadata', 'ocr', 'vision'] as const
export const PEEK_CAPABILITY_TIER = {
  'screen.peek.metadata': 'metadata',
  'screen.peek.ocr': 'ocr',
  'screen.peek.vision': 'vision'
} as const
```

### 2.2 权限状态（诚实映射，不猜测）

```ts
export const PEEK_PERMISSION_STATES = [
  'granted', 'denied', 'not-determined', 'restricted', 'unsupported', 'unknown'
] as const
```

- 本 slice 不 import Electron、不查询 TCC：`PEEK_DEFAULT_STATUS.permission = 'not-determined'`；
- 未来由 main 接线用 `systemPreferences.getMediaAccessStatus('screen')` **只查询**注入真实值，
  并通过系统设置深链引导，**绝不弹窗申请**（macOS 录屏无法应用内申请）；
- 除 `granted` 外全部视为未授权（`permission-not-granted`），`unknown` 也 fail-closed。

### 2.3 状态快照 `PeekStatus`（纯数据，无屏幕内容）

| 字段 | 含义 |
|---|---|
| `enabled` / `tier` | 总开关与目标档位（默认 `false` / `'off'`） |
| `permission` | 屏幕录制 TCC 状态（见 2.2） |
| `capabilities[]` | 每个 capability 的 `available` + `reason`（UI 可解释「为什么不可用」） |
| `provider` | provider 身份 `{id, version}` 或 null（不含实现细节/内容） |
| `sensitiveApps[]` | 敏感应用名单（隐私闸门输入；默认空，未来由配置注入内置清单） |
| `throttle` | `{minGapMs, maxPerHour}`（默认 600s / 3 次每小时） |
| `lastObservationAtMs` / `observationsLastHour` | 节流输入（默认 null / 0） |
| `notImplemented` | true = 本轮接口占位（无 provider 实现） |

`PEEK_DEFAULT_STATUS`：**全关 + 全不可用 + 深冻结**；任何消费方都不得把它当「已启用」。

### 2.4 观察结果 `PeekObservationResult`

```ts
type PeekObservationResult =
  | { ok: true; capability; tier; atMs; confidence; payload: PeekObservationPayload; redaction }
  | { ok: false; reason: PeekDenyReason }
```

- `payload` 按档位分型：`metadata`（P0 元数据）/ `text`（P2 本机 OCR 文本）/ `vision`（P3 文本描述），
  未来字段已预留，追加不破坏现有消费方；
- **内容边界**：`text`/`vision` 一律只在主进程内存；不落盘、不过 IPC、不进日志；图像字节永不出 provider；
- 本轮 stub 从不产生 `ok:true`。

### 2.5 闸门 `evaluatePeekGate(request, status, now)`（fail-closed 单点）

纯函数、不读时钟/环境/随机；调用方注入 `now`。决策顺序固定：

| # | 检查 | deny reason |
|---|---|---|
| 1 | 请求/状态结构非法、`now` 非有限数 | `invalid-request` |
| 2 | `enabled=false` 或 `tier='off'`（默认态） | `disabled` |
| 3 | `status.notImplemented=true`（本轮占位） | `not-implemented` |
| 4 | `status.permission !== 'granted'` | `permission-not-granted` |
| 5 | 状态中缺少该 capability 或 `available!==true` | `capability-unavailable` |
| 6 | 前台 app 命中 `sensitiveApps`（大小写不敏感子串） | `sensitive-app` |
| 7 | 未过节流（minGap / 每小时上限 / 时钟回拨） | `throttled` |
| 8 | 全过 | `{ ok:true, capability, tier }` |

任何不确定 → deny，绝不「整屏重试/升档重试/未知放行」。

### 2.6 provider 接口（未来实现，本轮只有 stub）

```ts
interface PeekProvider {
  readonly id: string
  readonly version: string
  capabilities(): readonly PeekCapability[]              // 只读声明，不得采集/弹权限
  observe(request: PeekObservationRequest): Promise<PeekObservationResult>  // 只收已过 gate 的请求
  dispose?(): void                                       // 幂等释放
}
```

实现约束（评审红线）：不得整屏回退、不得升档、不得读窗口标题（除非未来 `screen.peek.title`
单独评审）、不得落盘、不得在 `capabilities()` 里触发任何采集或 TCC 弹窗、`observe()` 永不抛异常。

## 3. 服务与 stub 行为（`src/main/peek/**`）

```ts
const service = createPeekService({ providers: [] })
service.getStatus()   // → PEEK_DEFAULT_STATUS 同形（enabled:false / tier:'off' / 未实现）
await service.observe() // → { ok: false, reason: 'not-implemented' }
service.dispose()     // 幂等 no-op
```

- `observe()` **恒** `{ ok:false, reason:'not-implemented' }`：不读输入、不调用 providers、不采集、
  不写日志、不抛异常（脏输入/循环引用/抛错 getter 都安全）。
- `providers` 选项只用于未来接线自检：即使传入非空 provider 列表，状态仍全关、`observe()` 仍不调用
  它们的任何方法（`capabilities()`/`observe()`/`dispose()` 调用次数均为 0）。
- `stub-provider.ts` 是「不可用 provider」的参考实现；本轮默认服务不注册任何 provider。

## 4. 安全与隐私约束（本轮已验证）

| 约束 | 执行点 | 测试 |
|---|---|---|
| 默认关闭 | `PEEK_DEFAULT_STATUS` / `createPeekService` 全关 | `peek-gate.test.ts` / `peek-service.test.ts` |
| fail-closed | `evaluatePeekGate` 固定顺序 + 脏输入 `invalid-request` | `peek-gate.test.ts`（含脏请求/脏状态/非法 now 不抛） |
| stub 恒 unavailable | `service.observe` / `stub.observe` 恒 not-implemented | `peek-service.test.ts` |
| 零采集副作用 | 不 import electron/node；无 timer/spawn/fs write/截图/标题/TCC 符号 | `peek-service.test.ts` 静态扫描 3 个新模块 × 9 类模式 |
| 日志无内容 | 本模块**没有 logger**、无 console 输出；日志接入属未来接线 | 源码静态扫描（无日志调用） |
| 内容边界 | `PeekStatus`/`PeekObservationResult` 类型无标题/图像字段；text/vision 仅主进程内存约定 | 契约 review + 类型 |
| 不申请 TCC | 本模块不 import Electron、不调用权限 API | 静态扫描 |
| 不改既有契约 | 仅新增文件；不 bump `CONFIG_VERSION`、不加 IPC/preload/config | `git status`（仅新增） |

## 5. 未来接线清单（P0–P3；全部需 Lead 评审，本轮不做）

### 5.1 通用接线步骤（Lead）

1. **provider 实现**（main 进程）：实现 `PeekProvider`，先做 P0（零权限）。
2. **service 接线**：`src/main/index.ts` 创建 service（Lead-owned）；`observe()` 改为
   「构造 `PeekObservationRequest` → `evaluatePeekGate(request, getStatus(), now())` → deny 原样返回
   → allow 才调用 `provider.observe()`」，并在成功/失败后更新节流计数与状态。
3. **IPC/preload**（冻结契约加法批次，Lead 评审）：新增 `pet:peek-status` / `pet:peek-observe-now`
   （未来可能再加 `pet:peek-history`）；`src/shared/ipc.ts` + `src/preload/index.ts` + 契约测试同步追加。
4. **设置页**：与能力上线同批；本轮**不显示**任何窥屏项（避免误解为可用）。
5. **配置**：未来可加可选 `peek` 配置组（默认关闭；`CONFIG_VERSION` 不 bump），需另行评审。

### 5.2 P0 元数据（零权限，建议第一个做）

- 数据源：既有 `pet:windows` / `windows-updated`（`owner`/`bounds`/`layer`；**不读标题**）；
- 全屏判定：窗口 bounds 与 `display.bounds` 误差 ≤2px；
- provider：`capabilities()` 返回 `['screen.peek.metadata']`；
- 新增测试：provider 输出形状、gate 放行后调用、敏感 app 默认名单、节流计数；
- 验收：无新 TCC 权限；关闭开关时 provider 零调用。

### 5.3 P1 氛围层（当前**不在** capability 集内）

- 若产品要做：先契约追加 `screen.peek.ambient`（`src/shared/peek.ts` + 测试），Lead 评审后
  再由 native helper 产出 160×90 四边带 HSV；需屏幕录制 TCC；默认关闭。
- 当前 slice 不预留该 capability，避免「声明了却永不实现」的假接口。

### 5.4 P2 本地 OCR（需 TCC）

- 新增 `native/peekcap` helper（单窗口截图 + Vision OCR；内存 → stdout，不落盘），
  `scripts/build-native.mjs` 加 target；
- 主进程 provider 校验 helper JSON、行级脱敏（`redactObservationText` 纯函数）、
  内容只留内存；
- TCC 流程：`getMediaAccessStatus('screen')` 只查询 + `x-apple.systempreferences:...?Privacy_ScreenCapture`
  深链；`docs/packaging.md` §3 红线四步（entitlements/签名公证/设置页引导+降级/文档）；
- 验收：敏感 app/标题/全屏 fixture 100% 跳过；日志无 OCR 文本；拒绝授权自动降级可恢复；
  连续失败退避；截图不落盘（详见 R4 报告 §6/§9）。

### 5.5 P3 视觉（需 TCC + 网络）

- main 进程内 VLM 客户端（renderer 不出网）；首次/换 provider 的 consent sheet；
- 只发压缩图（长边 ≤1280、JPEG ≤70），图像字节不跨进程；`screen` 来源轮次不进长期记忆；
- 验收：关闭 P3 后零网络请求；模型越界输出不发言。

### 5.6 每阶段都必须保持的不变量

默认关闭 / fail-closed 顺序不变 / stub→真实 provider 替换后 gate 仍先行 /
日志不含内容（只允许 `reason`/`tier`/`capability`/`providerId`/耗时/计数）/
text/vision 只留主进程内存 / 不整屏 / 不读标题（除非单独评审）。

## 6. 自测命令

```bash
# 本轮新增测试（103 例）
pnpm exec vitest run tests/peek-gate.test.ts tests/peek-service.test.ts
# 等价写法（注意 pnpm 10 下 `pnpm test -- <file>` 会把 `--` 透传给 vitest，导致跑全量）
pnpm run test tests/peek-gate.test.ts tests/peek-service.test.ts

# 类型检查（本轮新增文件 0 错误）
pnpm typecheck
```

> 2026-11-11 实测：peek 两文件 103/103 通过；typecheck 通过。
> 全量 `pnpm test` 期间存在 **其它 worker 进行中的** `tests/bridge-plugin.test.ts` 失败（A1 桥字节上限/正文泄漏相关），与本接口新增文件无关。

## 7. 与 R4 设计报告的差异（有意简化）

| 项 | R4 完整设计 | A7 本轮落地 |
|---|---|---|
| capability | metadata/title/ambient/ocr/vision | **metadata/ocr/vision**（按 Lead §8 冻结；title/ambient 留待追加评审） |
| 规则引擎 | screenpipe 式 deny/allow + 有效状态 | 仅 `sensitiveApps` 名单（足够表达隐私闸门；完整规则引擎属 P0 provider） |
| 事件广播/历史/多档节流状态机 | 完整 | 仅 `PeekStatus` 快照（无事件通道、无历史，避免提前冻结 IPC） |
| IPC/config/preload/设置页 | 追加批次 | **全部不做**（本轮零接线） |
| 单测规模 | 9 个文件 | 2 个文件 103 例（闸门 + 服务/静态扫描） |
