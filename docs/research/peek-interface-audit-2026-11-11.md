# 窥屏互动「只留接口」设计调研（R4）

> 日期：2026-11-11
> 基线：`main` @ `3893943`（工作树除本报告 + 可行性报告外无改动）
> 输入：[screen-awareness-privacy-focus-feasibility-2026-11-11.md](screen-awareness-privacy-focus-feasibility-2026-11-11.md)（622 行已通读）
> 范围：**只读调研 + 接口设计**。本轮不实现采集、不读窗口标题、不申请 TCC、不改源码、不跑 dev/smoke。
> 唯一写入：本文件 `docs/research/peek-interface-audit-2026-11-11.md`。
> 结论：窥屏互动可以在**零冻结契约破坏**的前提下先落「接口骨架」；真正需要 Lead 评审的只有一批**追加式**的 IPC/config 扩展，且可延后到接口阶段末尾一次提交。默认关闭、stub 恒 `unavailable`、fail-closed 单点执行三件事必须由接口层结构保证，而不是靠实现纪律。

---

## 0. 一页结论（TL;DR）

**设计原则（按优先级）**

1. **默认关闭且无副作用**：接口阶段 `peek` 配置全关（连 P0 元数据也默认关）；stub provider 的 `observe()` 永远返回 `unavailable`；观察器在关闭状态下**不装定时器、不调用 provider、不广播、不写历史**。
2. **fail-closed 单点**：gate 是唯一的放行判断点（`decidePeekGate`），provider 只能收到「已被放行」的请求；任何错误/未知状态一律阻断，绝不以「整屏重试」或「升档重试」兜底。
3. **分层契约**：`PeekEvent`（可跨进程/可给 DSH，**恒不含内容**）与 `ObservationResult`（仅主进程内存，可能含 P1/P2 内容）分离；renderer 与 DSH 永远拿不到原文/截图。
4. **加法式契约**：新增文件优先；对冻结文件只做**追加**（新文件、新 key、新成员），既有 14 个 channel 值、既有 config 字段/默认值/`CONFIG_VERSION` 一律不动。
5. **能力可查询、可降级、不可升档**：`pet:peek-status` 返回每个 capability 的可用性与原因；effective tier 只能取 `min(配置, 权限, provider 能力)`。
6. **可回看/可关闭**：内存态历史（最近 10 条、只元数据）+ 手动清空 + 全局暂停；不落盘、不进日志。

**落地分四段（详见 §5.7 / §12）**

| 段 | 内容 | 是否触碰冻结契约 | 可独立合并 |
|---|---|---|---|
| **S0** | `src/shared/peek*.ts` 纯契约/门控/规则/脱敏/DSH envelope + 纯逻辑单测 | 否（全部新增文件） | ✅ 立即可合并 |
| **S1** | `src/main/peek/**` provider 注册表 + stub + 权限探测 + observer 编排 + 单测 | 否（新增文件） | ✅ 可合并 |
| **S2** | 冻结文件**追加批次**：IPC 5 通道 + 1–2 事件、`PetConfig.peek`、preload、config-store 深拷贝、`ipc/peek.ts`、冻结测试追加 | **是（Lead 评审，一次提交）** | 需 Lead |
| **S3** | 渲染层 `reactions/peek.ts` tracker（+ 设置页占位/历史面板，可延后到 W-B） | 否（新增文件；接线文件 Lead-owned） | 可分段 |

**建议 Lead 拍板的关键点（详见 §13）**：批准 S2 的追加范围（19 invoke / 5 或 6 events）；`peek` 配置放 `PetConfig`（推荐，需 `config-store.copyConfig` 深拷贝）还是独立文件；渲染层不新增 `PetMood`（推荐，用 `PeekReaction` + 官方台词池）；接口阶段设置页**隐藏**（推荐），能力落地（W-B）时与开关/回看面板同批上线。

**工作量**：完整接口预留 **11–17.5 人日**；最小可验证切片（S0 契约+gate + stub 注册表，零冻结影响）**4–5.5 人日**。其中 gate/rules/redact 是未来 W-C 的隐私核心提前实现，可从 W-C 的 6–9 人日里抵扣，不是纯额外开销（§11.3）。

---

## 1. 约束与现有契约基线

### 1.1 现有冻结面（本设计必须绕开的红线）

| 冻结对象 | 冻结内容 | 证据 |
|---|---|---|
| IPC invoke 通道 | **恰好 14 个**，名称/值冻结，测试断言 `toEqual` | `src/shared/ipc.ts:23-48`；`tests/shared-contract.test.ts:14-42` |
| IPC 事件通道 | **恰好 4 个**（`windows-updated` / `dsh-event` / `config-changed` / `screens-updated`） | `src/shared/ipc.ts:51-57`；`tests/shared-contract.test.ts:31-63` |
| `PetApi` 类型面 | 键集合编译期精确断言 = 14 invoke + 4 订阅 | `src/shared/ipc.ts:116-141`；`tests/shared-contract.test.ts:83-111` |
| `PetConfig` / `DEFAULT_CONFIG` | 14 个字段；默认值逐字段断言 | `src/shared/types.ts:89-135`；`src/shared/config.ts:36-53`；`tests/shared-contract.test.ts:124-149` |
| `CONFIG_VERSION` | `1`；版本不符 → 整份回退默认 | `src/shared/config.ts:22`；`src/main/config-store.ts:160-165` |
| DSH 桥文件契约 | `status.json` / `events.jsonl` 文件名、行上限、payload 白名单 | `src/shared/bridge-schema.ts:23-42,105-131` |
| `ExternalReaction.mood` | 只允许 `dshBusy/dshDone/dshError` 三种 mood | `src/renderer/src/core/wave2-contract.ts:177-187` |
| `PET_MOODS` | 12 个 mood 冻结（增改需 Lead 评审） | `src/shared/types.ts:49-65` |
| `wave2-contract.ts` | Lead-owned 冻结类型文件 | 文件头注释 `src/renderer/src/core/wave2-contract.ts:1-18` |
| preload 白名单 | 不暴露原始 `ipcRenderer`/`electron`；`window.api` 是唯一桥接面 | `src/preload/index.ts:1-12` |

**可直接复用的既有机制（不新增权限、不新增采集面）**

| 机制 | 位置 | 对本接口的价值 |
|---|---|---|
| 窗口元数据轮询（250ms，**不读标题**） | `src/main/ipc/desktop.ts:40,136-142`；`native/winlist/main.swift`；`native/winlist/README.md:8-15,100-106` | P0 前台 app / 几何 / 全屏判定的现成数据源，零新权限 |
| 权限「只查询 + 深链」模式 | `src/main/ipc/window.ts:42-43,177-194`（`isTrustedAccessibilityClient(false)` + `x-apple.systempreferences:` URL） | TCC 接口照抄该模式，`getMediaAccessStatus('screen')` 只查询 + `shell.openExternal` 深链，绝不弹窗 |
| DSH 文件桥尾随（零信任解析/字节偏移/轮转） | `src/main/desktop/dsh-watch.ts:1-28,85-140`；`src/shared/bridge-schema.ts:230-249` | DSH→观察 与 观察→DSH 的扩展点复用同一套模式，不动既有文件契约 |
| 配置可选键回填（不 bump version） | `src/shared/config.ts:184-198`；`src/main/config-store.ts:171-172` | `peek` 组作为可选键加入，旧 `config.json` 自动回填 |
| 外部反应注入点（单点） | `src/renderer/src/core/pet-runtime.ts:772,791-793,818`；`src/renderer/src/reactions/dsh.ts` | 渲染层反应 tracker 的模式复制；不扩 `ExternalReaction`/`PetMood` |
| 官方台词单一来源 | `src/renderer/src/core/voicelines.ts:36,193-250`；`isOfficialVoiceLine` | 窥屏台词只能从官方池取，禁止自创（用户硬性要求） |
| electron 测试桩 | `tests/helpers/electron-stub.ts:412-430,558-590` | S2 的 IPC 测试不需要启动 Electron；需补 `getMediaAccessStatus` 桩（§9.2） |

### 1.2 「不破坏冻结契约」的操作定义

本报告把变更分四级，**只有 A/B 允许，C 必须 Lead 拍板，D 禁止**：

| 级别 | 定义 | 例子 | 处理 |
|---|---|---|---|
| **A 全新** | 新增文件，不被既有入口 import（零运行时影响） | `src/shared/peek*.ts`、`src/main/peek/**`、`tests/peek-*.test.ts` | 直接做，`git diff` 只显示新增 |
| **B 追加** | 既有文件**只增不改**：追加新 key/成员/字段，既有名称、值、类型、默认值、语义全部保持 | `IPC` 追加 5 键、`PetConfig` 追加 `peek` 组、preload 追加转发、`main/ipc/index.ts` 追加一行 | 需同步**追加**冻结测试期望集合（Lead 评审点；这是流程内加法，不是绕过） |
| **C 语义变更** | 改既有值/类型/默认、扩 `PetMood`/`ExternalReaction`、改 `CONFIG_VERSION`、改 `bridge-schema` 既有契约 | 给窥屏新增 mood、把 `metadataEnabled` 默认改 true | **本轮不做**；未来单独评审 |
| **D 禁止** | 读窗口标题/截图/申请 TCC/整屏/落盘/日志写内容 | `kCGWindowName`、`desktopCapturer`、`askForMediaAccess` | 任何阶段都需先走 `docs/packaging.md` §3 红线四步 |

> **口径**：`tests/shared-contract.test.ts` 的期望集合**必须随 B 级变更追加**（否则契约测试会红）。这不是「破坏」，而是冻结契约的正式扩展流程；破坏 = 改既有值/删键/改语义。本设计保证 B 级批次内**既有 14 个 channel 的字符串、4 个事件值、14 个 config 字段及其默认值逐字节不变**（§5.6 有 diff 清单与回归断言）。

### 1.3 本轮红线自证

- 只读：本报告之外未写/未改任何文件（含 `src/`、`tests/`、`native/`、`scripts/`、`package.json`）。
- 未实现任何采集；未读窗口标题；未调用任何 TCC API（未运行 Electron）；未跑 `pnpm dev` / `pnpm smoke` / `pnpm test`。
- 结论中的平台事实来自仓库文档与本地 `node_modules/electron/electron.d.ts` 类型定义（§14），真机 TCC 行为标 `inferred`/`unverified`。

---

## 2. 与可行性报告的映射（P0–P3 → 接口能力）

### 2.1 档位 / 能力 / 权限 / 默认

| 档位 | 可行性报告定位 | 本设计 capability | 权限 | 数据形态 | 接口阶段默认 | 未来阶段 |
|---|---|---|---|---|---|---|
| **off** | 未开启 | — | — | 无 | **默认** | — |
| **P0 metadata** | 前台 app/几何/全屏/空闲/麦克风布尔/DSH 状态 | `screen.peek.metadata` | **无** | 名称/数值 | **关**（接口阶段不预设默认开；见 §13-Q6） | W-B |
| 辅助 | 标题关键词规则需要标题 | `screen.peek.title` | 录屏 TCC | 字符串（内容级） | 不可用 | W-C |
| **P1 ambient** | 160×90 + 四边带 HSV | `screen.peek.ambient` | 录屏 TCC | 4–8 个浮点 | 不可用 | W-C |
| **P2 ocr** | 前台**单窗口**截图 → 本机 Vision OCR | `screen.peek.ocr` | 录屏 TCC | 本机文本（脱敏后） | 不可用 | W-C |
| **P3 vision** | 单窗口图 → VLM（可能出网） | `screen.peek.vision` | 录屏 TCC + 网络 | 文本描述（图像不出主进程） | 不可用 | W-D |

> 本设计把可行性报告里的 `tier: metadata|ambient|ocr|vision` 原样保留（`PeekTier`），P2/P3 的字段在契约里**都预留**，未来无需改契约。`title` 作为**辅助能力**单列（不是独立档位）：它和截图同属录屏 TCC，但规则引擎需要它做 `App::Title` 判定。

### 2.2 契约字段覆盖矩阵（证明 P0–P3 不改契约）

| 数据需求 | 承载字段（详见 §4） | P0 | P1 | P2 | P3 |
|---|---|---|---|---|---|
| 来源/provider 版本 | `ObservationResult.source {providerId,providerVersion,capability}` | ✅ | ✅ | ✅ | ✅ |
| 观察范围 | `ObservationRequest.scope {kind:'foreground-window',includeTitle,excludeSelf}` | ✅ | ✅ | ✅ | ✅ |
| 闸门决策快照 | `ObservationResult.gate: PeekGateDecision` | ✅ | ✅ | ✅ | ✅ |
| 脱敏汇总 | `PeekRedactionSummary` | ✅（无内容时 `applied=false`） | ✅ | ✅ | ✅ |
| 生命周期 | `ttlMs` | ✅ | ✅ | ✅ | ✅ |
| 置信度 | `confidence` | ✅ | ✅ | ✅ | ✅ |
| 内容负载 | `metadata?` / `ambient?` / `text?`（**可选字段**，按档位出现） | `metadata` | `ambient` | `text` | `text`（描述）+`allowNetwork` 已存在 |
| 网络开关 | `ObservationRequest.allowNetwork`（dsh/renderer 请求恒 false） | 不适用 | 否 | 否 | ✅ |
| 降级/跳过原因 | `ObservationResult.outcome` + `skipReason` + `gate` | ✅ | ✅ | ✅ | ✅ |
| 用户可见回看 | `PeekHistoryEntry`（只元数据，不含内容） | ✅ | ✅ | ✅ | ✅ |
| DSH 方向 | `PeekDshObservationRequest` / `PeekDshObservationEvent`（§4.5） | ✅ | ✅ | ✅（仅元数据，默认不转发文本） | 默认不转发 |

### 2.3 分期映射

| 可行性阶段 | 依赖的接口件 | 本接口阶段是否覆盖 |
|---|---|---|
| W-A 聚焦模式（零权限，3–5d） | 不依赖窥屏接口（应用内状态机）；`focus` 配置单独评审 | 不覆盖（独立任务） |
| W-B P0 元数据互动（零权限，4–6d） | `screen.peek.metadata` provider 从现有 `pet:windows` 取数 → gate → `PeekEvent` → reaction | ✅ 契约/quota/history/reaction 全预留 |
| W-C P1+P2（录屏权限，6–9d） | `peekcap` helper 作为 provider 注入；gate/rules/redact 复用本设计 | ✅ provider 协议 + TCC 接口 + 规则引擎预留 |
| W-D P3 视觉 + 记忆边界（5–8d） | `screen.peek.vision` provider（main 内 VLM 客户端）；`allowNetwork` + `source=screen` 记忆隔离 | ✅ 契约字段预留；记忆隔离属未来消费者约定 |

---

## 3. 能力与权限模型

### 3.1 capability 列表（冻结数组，测试锚定）

| capability id | dataTier | 权限 | content | 说明 |
|---|---|---|---|---|
| `screen.peek.metadata` | `metadata` | none | false | 前台 app、窗口几何、全屏、窗口数；数据来自既有 `WindowInfo`，不新增采集 |
| `screen.peek.title` | null（辅助） | screen-recording | true | 窗口标题；**R4/S0/S1/S2 全部不可用**，仅声明 |
| `screen.peek.ambient` | `ambient` | screen-recording | true | 160×90 四边带 HSV |
| `screen.peek.ocr` | `ocr` | screen-recording | true | 前台单窗口 + 本机 OCR |
| `screen.peek.vision` | `vision` | screen-recording | true | 图像理解（可能出网），默认关闭 |

> capability 数组顺序即冻结顺序；新增 capability = 契约追加（B 级）。

### 3.2 permission 状态与映射

```ts
// 契约状态（6 值，含平台真实状态；不猜测/不伪造，遵循 R-25 的诚实原则）
type PeekPermissionState =
  | 'granted' | 'denied' | 'not-determined' | 'restricted' | 'unsupported' | 'unknown'
```

| Electron `getMediaAccessStatus('screen')`（macOS） | 契约状态 | 可用的内容级能力 |
|---|---|---|
| `granted` | `granted` | 视 provider/probe |
| `denied` | `denied` | ❌（P0 元数据仍可用，但接口阶段也关） |
| `not-determined` | `not-determined` | ❌ |
| `restricted`（MDM） | `restricted` | ❌ |
| `unknown` | `unknown` | ❌（fail-closed） |
| 非 macOS / API 不存在 | `unsupported` | ❌ |

**证据**：Electron 44 类型定义 `getMediaAccessStatus(mediaType: 'microphone'|'camera'|'screen')` 返回 5 值（`node_modules/electron/electron.d.ts:14806`）；`askForMediaAccess` **只支持 microphone/camera**（同文件 `:14746`）→ macOS 录屏权限**无法在应用内弹窗申请**，只能「查询 + 系统设置深链」，与 `docs/packaging.md` §3 一致。

### 3.3 effective tier 解析（只降不升）

```
输入：config.tier（期望档位）、config.enabled（内容总开关）、config.metadataEnabled（P0 开关）、
      permission.screenRecording、provider probe（capabilities[] / available / reason）
1. requested = 若 enabled 且 config.tier ∈ {ambient,ocr,vision} → config.tier
              否则若 metadataEnabled → 'metadata'
              否则 → 'off'
2. 内容级请求但 permission ≠ granted → 视为 requested = metadataEnabled ? 'metadata' : 'off'
   （这是**显式降级**：后续会以一次新的 maxTier=metadata 请求重新走 gate，见 §3.5 注）
3. requested 再与 provider 的可用 dataTier 取 min（从高往低找第一个 available）
4. 仍无可用 → 'off'
返回 effectiveTier（PeekStatus.effectiveTier 使用同一函数，保证 UI 与运行时一致）
```

铁律：`effectiveTier ≤ requested`；**任何情况下不得升档**（DSH 请求、renderer 手动请求、provider 自报都不能超过配置/权限）。降级原因写入 `PeekCapabilityStatus.reason` 与 `PeekStatus.provider`，可被 UI 解释。

### 3.4 fail-closed 决策顺序（`decidePeekGate`，确定性）

> 顺序固定 → 同一输入永远同一 `reason`，便于快照测试；阻断即返回，绝不继续尝试其它路径。

| # | 检查 | 阻断 reason |
|---|---|---|
| 1 | `paused === true` | `paused` |
| 2 | 请求结构非法（未知 tier/负 timeout/超长 id） | `invalid-request` |
| 3 | 前台窗口缺失 / 不可捕获 | `window-unavailable` |
| 4 | 前台窗口是宠物自身 overlay | `self-window` |
| 5 | 内容请求且 `config.enabled === false` | `global-disabled` |
| 6 | 元数据请求且 `config.metadataEnabled === false` | `global-disabled` |
| 7 | `config.tier === 'off'` 且请求非 off | `tier-off` |
| 8 | 内容请求且 permission ≠ granted | `permission-not-determined` / `permission-denied` / `permission-restricted` / `permission-unknown`（按状态映射） |
| 9 | 该档位无可用 capability/provider | `capability-unavailable` / `provider-unavailable` / `stub-provider` |
| 10 | 静音时段（仅内容级） | `quiet-hours` |
| 11 | 专注模式停用内容级观察 | `focus-mode` |
| 12 | 距上次观察 < `minGapSeconds`（或距交互 < `minIdleSeconds`） | `cooldown` |
| 13 | 本小时观察数 ≥ `maxPerHour` | `budget-exceeded` |
| 14 | 退避窗口内（连续失败后） | `backoff` |
| 15 | 规则：命中 denyApps | `denied-app` |
| 16 | 规则：未知 app 且 `unknownAppPolicy === 'deny'`（内容级） | `unknown-app` |
| 17 | 规则：`allowApps` 非空且未命中（内容级） | `outside-allowlist` |
| 18 | 内容级 + `denyTitleKeywords` 非空但 title 不可用 | `title-unavailable`（**fail-closed**：无法评估标题规则就不采） |
| 19 | 标题命中 denyTitleKeywords | `denied-title` |
| 20 | 全屏 + `denyFullscreen` | `fullscreen-app` |
| 21 | 会议 app（检测标志为真）+ `denyMeetingApps` | `meeting-app` |
| 22 | 无痕（检测标志为真）+ `denyIncognito` | `incognito-window` |
| 23 | DSH 触发但 `config.dsh.acceptRequests === false` | `dsh-request-disabled` |
| 24 | DSH 请求内容级档位或 `allowNetwork` | `dsh-content-forbidden`（DSH 只能要 metadata） |
| 25 | DSH 请求频率超限 | `rate-limited` |
| 26 | 全过 | 放行 `{allowed:true, tier, capability, matchedRuleIds}` |

> 注（降级语义）：gate **不会**把一条内容请求「偷偷降级」成元数据请求——权限不足就直接阻断该请求；观察器若开启 `metadataEnabled`，会以 `maxTier='metadata'` 发一条**新的**请求重新过 gate。这样「降级」在历史/决策里可解释，不会掩盖权限被拒。

### 3.5 用户控制面

| 控制 | 接口 | 默认 | 说明 |
|---|---|---|---|
| 内容总开关 | `config.peek.enabled` | **false** | P1–P3 前提 |
| P0 元数据开关 | `config.peek.metadataEnabled` | **false**（接口阶段） | 未来 W-B 是否默认开由产品另行决策（§13-Q6） |
| 档位 | `config.peek.tier` | **'off'** | metadata/ambient/ocr/vision |
| 暂停 | `PeekObserver.setPaused()`（S1 接口预留）；如需 UI 再追加 `pet:peek-set-paused`（第 6 个 invoke，不在 S2 最小批次） | false | 运行期内存态，重启自动恢复为 false（fail-safe） |
| 回看 | `pet:peek-history` | 空 | 最近 10 条，**内存 + 只元数据** |
| 清空 | `pet:peek-clear-history` | — | 立即清空，幂等 |
| 规则 | `config.peek.rules` | 内置安全 deny 清单 | 用户可编辑；默认拒绝未知 app |
| DSH 转发/接收 | `config.peek.dsh.*` | 全部 false/off | 双向默认关闭 |

### 3.6 与 macOS 15 每月复核的关系

macOS 15 起录屏授权会被系统周期性复核（可行性报告 §4.8 / §7）。接口层对策：`pet:peek-status` 每次调用都实时查询 `getMediaAccessStatus`（只读、无副作用、不弹窗），并把 `permission.screenRecording` 随状态返回；观察失败若原因是权限，则写入 `PeekHistoryEntry.blockedReason` 并进入退避。**不缓存权限为 granted**、不在启动时假定授权。

---

## 4. 数据契约草案（TypeScript）

> 命名约定：共享层（`src/shared/peek*.ts`）环境中立（禁止 electron/node/第三方）；类型全部 `readonly` 的「数据快照」用不可变风格，配置对象保持可变（与 `PetConfig` 一致）。以下为可直接落地的草案，实现 agent 可合并文件但**不得改变字段语义**。

### 4.0 分层（谁可以碰内容）

```
┌──────────────────────────────────────────────────────────────────────┐
│ 共享层（renderer 可 import）：PeekConfig / PeekTier / capability /   │
│ permission / PeekEvent（无内容）/ PeekStatus / PeekHistoryEntry /    │
│ gate / rules / redact / DSH envelope —— 纯逻辑，可单测               │
├──────────────────────────────────────────────────────────────────────┤
│ 主进程内部：ObservationRequest / ObservationResult（可含 P1/P2 内容）│
│ provider / probe / observer —— 内容只在这里停留，用完释放             │
├──────────────────────────────────────────────────────────────────────┤
│ renderer overlay：PeekEvent → PeekReaction（只官方台词池 + poseHint） │
│ renderer settings：PeekStatus / PeekHistoryEntry（元数据，可回看/清空）│
└──────────────────────────────────────────────────────────────────────┘
```

### 4.1 `src/shared/peek.ts` —— 契约根

```ts
/**
 * 窥屏互动（peek）接口预留契约 —— 环境中立纯 TS。
 *
 * 定位：只定义「未来采集」的边界/状态/默认关闭语义/校验；**无任何采集实现**。
 * 任何 provider 未注册、不可用、未授权时，状态查询一律 fail-closed。
 */
import type { Rect } from './types'

/* ---------------------------------- 档位 ---------------------------------- */

export const PEEK_TIERS = ['off', 'metadata', 'ambient', 'ocr', 'vision'] as const
export type PeekTier = (typeof PEEK_TIERS)[number]

export const PEEK_TIER_RANK: Readonly<Record<PeekTier, number>> = {
  off: 0,
  metadata: 1,
  ambient: 2,
  ocr: 3,
  vision: 4
}

export function isPeekTier(value: unknown): value is PeekTier {
  return typeof value === 'string' && (PEEK_TIERS as readonly string[]).includes(value)
}

/** fail-closed：任何不确定只能往低走。 */
export function minPeekTier(a: PeekTier, b: PeekTier): PeekTier {
  return PEEK_TIER_RANK[a] <= PEEK_TIER_RANK[b] ? a : b
}

/** P1–P3 内容级（可还原/可能敏感）；metadata 不算内容。 */
export function isPeekContentTier(tier: PeekTier): boolean {
  return PEEK_TIER_RANK[tier] >= PEEK_TIER_RANK.ambient
}

/* --------------------------------- 能力声明 -------------------------------- */

export const PEEK_CAPABILITY_IDS = [
  'screen.peek.metadata',
  'screen.peek.title',
  'screen.peek.ambient',
  'screen.peek.ocr',
  'screen.peek.vision'
] as const
export type PeekCapabilityId = (typeof PEEK_CAPABILITY_IDS)[number]

export type PeekPermissionKind = 'none' | 'screen-recording'

export interface PeekCapabilitySpec {
  readonly id: PeekCapabilityId
  /** 该能力对应的数据档位；null = 辅助能力（不单独产出档位）。 */
  readonly dataTier: PeekTier | null
  readonly permission: PeekPermissionKind
  /** 内容级能力（读取的是屏幕内容/标题）。 */
  readonly content: boolean
}

export const PEEK_CAPABILITIES: Readonly<Record<PeekCapabilityId, PeekCapabilitySpec>> = {
  'screen.peek.metadata': {
    id: 'screen.peek.metadata',
    dataTier: 'metadata',
    permission: 'none',
    content: false
  },
  'screen.peek.title': {
    id: 'screen.peek.title',
    dataTier: null,
    permission: 'screen-recording',
    content: true
  },
  'screen.peek.ambient': {
    id: 'screen.peek.ambient',
    dataTier: 'ambient',
    permission: 'screen-recording',
    content: true
  },
  'screen.peek.ocr': {
    id: 'screen.peek.ocr',
    dataTier: 'ocr',
    permission: 'screen-recording',
    content: true
  },
  'screen.peek.vision': {
    id: 'screen.peek.vision',
    dataTier: 'vision',
    permission: 'screen-recording',
    content: true
  }
}

/** 某档位对应的主 capability（gate 放行时返回）。 */
export const PEEK_TIER_CAPABILITY: Readonly<Record<Exclude<PeekTier, 'off'>, PeekCapabilityId>> = {
  metadata: 'screen.peek.metadata',
  ambient: 'screen.peek.ambient',
  ocr: 'screen.peek.ocr',
  vision: 'screen.peek.vision'
}

/* --------------------------------- 权限状态 -------------------------------- */

export const PEEK_PERMISSION_STATES = [
  'granted',
  'denied',
  'not-determined',
  'restricted',
  'unsupported',
  'unknown'
] as const
export type PeekPermissionState = (typeof PEEK_PERMISSION_STATES)[number]

export interface PeekPermissionSnapshot {
  readonly screenRecording: PeekPermissionState
  /** macOS 录屏权限无法由应用弹窗申请（Electron askForMediaAccess 不支持 screen）→ 恒 false。 */
  readonly canPromptFromApp: false
  readonly checkedAtMs: number
}

/* -------------------------------- 不可用原因 ------------------------------- */

export const PEEK_UNAVAILABLE_REASONS = [
  'stub-provider',
  'provider-disabled',
  'provider-missing',
  'provider-outdated',
  'capability-not-declared',
  'permission-not-determined',
  'permission-denied',
  'permission-restricted',
  'permission-unknown',
  'platform-unsupported',
  'probe-timeout'
] as const
export type PeekUnavailableReason = (typeof PEEK_UNAVAILABLE_REASONS)[number]

/* -------------------------------- 阻断原因 -------------------------------- */

export const PEEK_BLOCK_REASONS = [
  'paused',
  'global-disabled',
  'tier-off',
  'invalid-request',
  'self-window',
  'window-unavailable',
  'unknown-app',
  'denied-app',
  'outside-allowlist',
  'denied-title',
  'title-unavailable',
  'fullscreen-app',
  'meeting-app',
  'incognito-window',
  'quiet-hours',
  'focus-mode',
  'cooldown',
  'budget-exceeded',
  'backoff',
  'permission-not-determined',
  'permission-denied',
  'permission-restricted',
  'permission-unknown',
  'capability-unavailable',
  'provider-unavailable',
  'stub-provider',
  'dsh-request-disabled',
  'dsh-content-forbidden',
  'rate-limited'
] as const
export type PeekBlockReason = (typeof PEEK_BLOCK_REASONS)[number]

/* ---------------------------------- 配置 ---------------------------------- */

export interface PeekQuietHours {
  enabled: boolean
  /** `HH:MM`，24 小时制；跨午夜由 start > end 表达。 */
  start: string
  end: string
}

export interface PeekCaptureLimits {
  /** 固定前台单窗口；**不提供 whole-screen 选项**（安全设计，不是遗漏）。 */
  target: 'foreground-window'
  maxEdge: number
  jpegQuality: number
  ocrMaxChars: number
}

export interface PeekRulesConfig {
  denyApps: string[]
  denyTitleKeywords: string[]
  allowApps: string[]
  unknownAppPolicy: 'deny' | 'metadata-only'
  denyMeetingApps: boolean
  denyIncognito: boolean
  denyFullscreen: boolean
}

/** DSH 方向扩展点（默认全关；详细契约见 peek-bridge.ts）。 */
export interface PeekDshBridgeConfig {
  /** pet → DSH：是否把（已脱敏的）观察事件写到桥目录。 */
  forwardEnabled: boolean
  /** 转发档位；'off' = 不写文件。只允许 metadata（文本/图像永不转发）。 */
  forwardTier: 'off' | 'metadata'
  /** DSH → pet：是否接受 DSH 的观察请求。 */
  acceptRequests: boolean
  /** DSH 请求限流（0 = 一律拒绝）。 */
  maxRequestsPerHour: number
}

export interface PeekConfig {
  /** 内容级（P1–P3）总开关；默认 false。 */
  enabled: boolean
  /** P0 元数据开关；接口阶段默认 false。 */
  metadataEnabled: boolean
  tier: PeekTier
  /** 抽样间隔（90–600s，实际 ±15% 抖动由未来 observer 实现）。 */
  intervalSeconds: number
  /** 距上次交互 < 该值不看（默认 45s）。 */
  minIdleSeconds: number
  /** 每小时观察上限（默认 3）。 */
  maxPerHour: number
  /** 两次观察最小间隔（默认 600s）。 */
  minGapSeconds: number
  quietHours: PeekQuietHours
  capture: PeekCaptureLimits
  rules: PeekRulesConfig
  dsh: PeekDshBridgeConfig
  /** 上次已说过的台词（防重复；只存文本引用/短哈希，不存内容）。 */
  lastComment: string
}

/** **默认全关**（接口层红线）。 */
export const DEFAULT_PEEK_CONFIG: PeekConfig = {
  enabled: false,
  metadataEnabled: false,
  tier: 'off',
  intervalSeconds: 120,
  minIdleSeconds: 45,
  maxPerHour: 3,
  minGapSeconds: 600,
  quietHours: { enabled: false, start: '22:30', end: '08:00' },
  capture: { target: 'foreground-window', maxEdge: 1280, jpegQuality: 70, ocrMaxChars: 1200 },
  rules: {
    denyApps: [
      '1Password', 'Keychain Access', 'Bitwarden', 'LastPass', '银行', 'Wallet',
      '远程桌面', 'TeamViewer', 'AnyDesk', 'RustDesk', 'VMware', 'VirtualBox', 'Parallels'
    ],
    denyTitleKeywords: [
      '密码', '登录', '验证码', '支付', '银行', '私钥', 'token', '无痕', 'Incognito', 'Private', '远程桌面'
    ],
    allowApps: [],
    unknownAppPolicy: 'deny',
    denyMeetingApps: true,
    denyIncognito: true,
    denyFullscreen: true
  },
  dsh: { forwardEnabled: false, forwardTier: 'off', acceptRequests: false, maxRequestsPerHour: 0 },
  lastComment: ''
}

export const PEEK_LIMITS = {
  intervalSeconds: { min: 90, max: 600 },
  minIdleSeconds: { min: 0, max: 600 },
  maxPerHour: { min: 0, max: 6 },
  minGapSeconds: { min: 60, max: 3600 },
  capture: {
    maxEdge: { min: 640, max: 2560 },
    jpegQuality: { min: 30, max: 90 },
    ocrMaxChars: { min: 200, max: 4000 }
  },
  rules: { maxEntries: 64, maxTextLength: 64 },
  manual: { minGapMs: 10_000, maxPerMinute: 3 },
  backoff: { threshold: 3, initialMs: 30_000, maxMs: 30 * 60_000 }
} as const

/* --------------------------------- 内容负载 -------------------------------- */

export const PEEK_ACTIVITY_CLASSES = [
  'work', 'game', 'browse', 'call', 'away', 'idle', 'casual'
] as const
export type PeekActivityClass = (typeof PEEK_ACTIVITY_CLASSES)[number]

/** 前台窗口元数据（**不含标题/截图**）。未来由 observer 用既有 pet:windows 缓存构造。 */
export interface PeekForegroundWindow {
  windowId: number
  owner: string
  bounds: Rect
  layer: number
  fullscreen: boolean
  /** 以下为未来分类器标志；接口阶段恒 undefined（未知 = 不触发对应阻断）。 */
  isMeetingApp?: boolean
  isIncognito?: boolean
}

export interface PeekMetadataPayload {
  foreground: PeekForegroundWindow | null
  windowCount: number
  /** 未来零权限探测（ioreg HIDIdleTime 等）；接口阶段 null。 */
  idleSeconds: number | null
  /** 未来零权限探测（CoreAudio 布尔）；接口阶段 null。 */
  micActive: boolean | null
  activityClass: PeekActivityClass | null
  dsh: { online: boolean; running: boolean } | null
}

export interface PeekAmbientPayload {
  /** 四边带 HSV 均值（P1；未来由 helper 产出）。 */
  bands: readonly { h: number; s: number; v: number }[]
  brightness: number
  saturation: number
  changeRate: number
}

export interface PeekTextPayload {
  /** P2 本机 OCR 文本（已在主进程完成行级脱敏）。 */
  text: string
  chars: number
  truncated: boolean
  linesDropped: number
  confidence: number
  language: string
}

/* --------------------------------- 数据快照 -------------------------------- */

export type PeekObservationTrigger = 'schedule' | 'manual' | 'dsh' | 'behavior'
export type PeekObservationOutcome = 'observed' | 'skipped' | 'unavailable'

export interface PeekObservationScope {
  /** 固定前台单窗口；本设计**不存在** whole-screen 取值。 */
  readonly kind: 'foreground-window'
  /** 是否允许读取标题（仅 title/OCR 级且 TCC 可用时）。 */
  readonly includeTitle: boolean
  readonly excludeSelf: true
}

export interface PeekSourceRef {
  readonly providerId: string
  readonly providerVersion: string
  readonly capability: PeekCapabilityId | null
}

export interface PeekRedactionSummary {
  readonly applied: boolean
  readonly ruleIds: readonly string[]
  readonly linesDropped: number
  readonly bytesOut: number
  readonly truncated: boolean
}

/** 主进程内部请求（renderer/DSH 不能直接构造；由 observer 生成并填充 id/foreground）。 */
export interface ObservationRequest {
  readonly id: string
  readonly trigger: PeekObservationTrigger
  /** epoch ms（历史/展示用）；时长计算用注入的单调时钟。 */
  readonly requestedAtMs: number
  readonly maxTier: PeekTier
  readonly allowNetwork: boolean
  readonly scope: PeekObservationScope
  readonly timeoutMs: number
  readonly foreground: PeekForegroundWindow | null
}

export type PeekGateDecision =
  | {
      readonly allowed: true
      readonly tier: PeekTier
      readonly capability: PeekCapabilityId
      readonly matchedRuleIds: readonly string[]
    }
  | {
      readonly allowed: false
      readonly reason: PeekBlockReason
      readonly capability: PeekCapabilityId | null
      readonly ruleId: string | null
    }

/** 主进程内部结果（**可以含内容**；只允许主进程内存持有与释放，不进日志/不过 IPC）。 */
export interface ObservationResult {
  readonly requestId: string
  readonly atMs: number
  readonly outcome: PeekObservationOutcome
  readonly tier: PeekTier
  readonly source: PeekSourceRef
  readonly scope: PeekObservationScope
  readonly gate: PeekGateDecision
  readonly redaction: PeekRedactionSummary
  readonly ttlMs: number
  readonly confidence: number
  readonly metadata?: PeekMetadataPayload
  readonly ambient?: PeekAmbientPayload
  readonly text?: PeekTextPayload
  readonly skipReason?: PeekBlockReason | PeekUnavailableReason
}

/* -------------------------------- 广播事件 -------------------------------- */

export const PEEK_REACTION_INTENTS = [
  'notice',
  'welcome-back',
  'celebrate-focus',
  'care-break'
] as const
export type PeekReactionIntent = (typeof PEEK_REACTION_INTENTS)[number]

/** renderer 可安全消费的提示（**没有任何内容字段**；title/文本/图像永远不会出现在这里）。 */
export interface PeekEventHints {
  readonly intent: PeekReactionIntent | null
  readonly activityClass: PeekActivityClass | null
}

/** 主→渲染广播事件（peek-event）。结构上杜绝内容泄漏：没有 text/title/image 字段。 */
export interface PeekEvent {
  readonly id: string
  readonly atMs: number
  readonly kind: 'observation' | 'blocked'
  readonly source: PeekSourceRef
  readonly scope: PeekObservationScope
  readonly redaction: PeekRedactionSummary
  readonly ttlMs: number
  readonly confidence: number
  readonly hints: PeekEventHints
  readonly blockReason: PeekBlockReason | null
}

/* -------------------------------- 状态/历史 ------------------------------- */

export interface PeekCapabilityStatus {
  readonly id: PeekCapabilityId
  readonly dataTier: PeekTier | null
  readonly available: boolean
  readonly reason: PeekUnavailableReason | null
  readonly requiresPermission: PeekPermissionKind
}

export type PeekConsentState = 'none' | 'metadata' | 'content'

/** `pet:peek-status` 返回值（能力/权限可查询；settings 与调试面共用）。 */
export interface PeekStatus {
  readonly enabled: boolean
  readonly metadataEnabled: boolean
  readonly tier: PeekTier
  readonly effectiveTier: PeekTier
  readonly paused: boolean
  readonly permission: PeekPermissionSnapshot
  readonly capabilities: readonly PeekCapabilityStatus[]
  readonly provider: { readonly id: string; readonly version: string; readonly kind: 'stub' | 'native-helper' | 'http-vlm' } | null
  readonly historySize: number
  readonly lastObservationAtMs: number | null
  readonly consent: PeekConsentState
}

export const PEEK_HISTORY_LIMIT = 10

/** 「刚刚看到了什么」条目：**只元数据**，内存态，不落盘。 */
export interface PeekHistoryEntry {
  readonly id: string
  readonly atMs: number
  readonly tier: PeekTier
  /** 展示用 app 名（元数据；不进日志、不持久化）。 */
  readonly appOwner: string | null
  readonly outcome: PeekObservationOutcome
  readonly blockedReason: PeekBlockReason | null
  readonly redaction: PeekRedactionSummary
  readonly forwardedToDsh: boolean
  readonly spoken: boolean
  readonly bytesOut: number
}

/* --------------------------------- 日志白名单 ------------------------------ */

/** 日志字段白名单：窥屏相关日志**只允许**这些键（内容/标题/app 名一律禁止）。 */
export const PEEK_LOG_ALLOWED_FIELDS = [
  'requestId', 'tier', 'effectiveTier', 'capability', 'providerId', 'providerVersion',
  'outcome', 'reason', 'durationMs', 'bytesOut', 'linesDropped', 'historySize', 'count'
] as const

export function sanitizePeekLogMeta(
  meta: Record<string, unknown>
): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {}
  for (const key of PEEK_LOG_ALLOWED_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(meta, key)) continue
    const value = meta[key]
    if (typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))) {
      out[key] = value
    } else if (typeof value === 'string') {
      out[key] = value.length > 64 ? value.slice(0, 64) : value
    }
  }
  return out
}
```

### 4.2 `src/shared/peek-gate.ts` —— 纯门控

```ts
import {
  type ObservationRequest, type PeekBlockReason, type PeekCapabilityId,
  type PeekCapabilityStatus, type PeekConfig, type PeekGateDecision,
  type PeekPermissionSnapshot, type PeekRulesConfig, type PeekTier,
  type PeekUnavailableReason, PEEK_TIER_CAPABILITY, minPeekTier
} from './peek'
import { evaluateAppDecision } from './peek-rules'

export interface PeekBudgetState {
  readonly lastObservationAtMs: number | null
  readonly lastInteractionAtMs: number | null
  readonly observationsLastHour: number
  readonly dshRequestsLastHour: number
  readonly backoffUntilMs: number | null
}

export interface PeekGateContext {
  readonly config: PeekConfig
  readonly permission: PeekPermissionSnapshot
  readonly capabilities: readonly PeekCapabilityStatus[]
  readonly paused: boolean
  readonly quietHoursActive: boolean
  readonly focusContentSuspended: boolean
  readonly budget: PeekBudgetState
  readonly titleAvailable: boolean
  readonly title: string | null
  readonly isSelfWindow: boolean
  readonly nowMs: number
}

export function resolveCapabilityStatuses(input: {
  config: PeekConfig
  permission: PeekPermissionSnapshot
  provider: {
    readonly available: boolean
    readonly capabilities: readonly PeekCapabilityId[]
    readonly reason: PeekUnavailableReason | null
  }
}): readonly PeekCapabilityStatus[]

/** 只降不升：effective = min(配置允许, 权限允许, provider 可用)。 */
export function resolveEffectiveTier(input: {
  config: PeekConfig
  permission: PeekPermissionSnapshot
  capabilities: readonly PeekCapabilityStatus[]
}): PeekTier

/** 确定性闸门；见 §3.4 的 26 步顺序。 */
export function decidePeekGate(
  request: ObservationRequest,
  ctx: PeekGateContext
): PeekGateDecision
```

**实现要求**：`resolveCapabilityStatuses` 与 `resolveEffectiveTier` 必须与 `PeekStatus` 完全同源（`getStatus()` 直接调用它们）；`decidePeekGate` 必须是纯函数（不读时间、不读随机、不读环境），所有外部事实经 `ctx` 注入。

### 4.3 `src/shared/peek-rules.ts` —— 规则引擎（screenpipe 语法）

```ts
import type { PeekRulesConfig } from './peek'

export const PEEK_EFFECTIVE_STATES = ['captured', 'ignored', 'partial', 'outside-allowlist'] as const
export type PeekEffectiveState = (typeof PEEK_EFFECTIVE_STATES)[number]

/** 解析 `App` / `App::Title` / `::Keyword` / `App::`；空/超长/非法 → null。 */
export interface PeekRule {
  readonly kind: 'app' | 'app-title' | 'title'
  readonly app: string | null
  readonly title: string | null
  readonly raw: string
}
export function parsePeekRule(raw: string): PeekRule | null
export function ruleRequiresTitle(rule: PeekRule): boolean

/** 标题不可用时返回 false；调用方必须配合 requiresFailClosedOnMissingTitle 使用。 */
export function matchPeekRule(rule: PeekRule, app: string | null, title: string | null): boolean

/** 内容级请求在标题不可用 + 存在标题规则时 → fail-closed（gate 返回 title-unavailable）。 */
export function requiresTitleToEvaluate(rules: PeekRulesConfig): boolean

export interface PeekAppDecision {
  readonly state: PeekEffectiveState
  readonly matchedRuleIds: readonly string[]
  readonly blockedIndirectly: boolean
}
/** 有效状态：直接回答 UI「这个 app 现在会不会被截」。 */
export function evaluateAppDecision(input: {
  app: string
  title: string | null
  titleAvailable: boolean
  rules: PeekRulesConfig
  contentTier: boolean
}): PeekAppDecision
```

**测试锚点**：`blockedIndirectly` 定义 = 该 app 同时命中 deny 与 allow（deny 获胜，但 UI 要提示「你的过宽 allow/deny 规则正在误伤」）。

### 4.4 `src/shared/peek-redact.ts` —— 脱敏与输出过滤（纯函数）

```ts
import type { PeekRedactionSummary } from './peek'

export const PEEK_REDACTION_RULE_IDS = [
  'line-sensitive-keyword', 'url', 'email', 'long-digit', 'char-cap'
] as const
export type PeekRedactionRuleId = (typeof PEEK_REDACTION_RULE_IDS)[number]

export interface PeekTextRedactionInput {
  readonly text: string
  readonly maxChars: number
  readonly sensitiveKeywords?: readonly string[]
}
export function redactObservationText(input: PeekTextRedactionInput): {
  text: string
  summary: PeekRedactionSummary
}

/** 输出过滤器：气泡/台词命中敏感模式（≥11 位数字、邮箱、URL、代码样式、敏感词）→ false。 */
export function isSafePeekOutput(text: string): boolean
```

**默认敏感词**（与可行性报告 §4.3 一致）：`密码|验证码|token|secret|私钥|身份证|银行卡`；URL/邮箱/≥11 位连续数字/引号内 >40 字原文复述 → 丢弃/截断。规则命中写入 `summary.ruleIds`，**原始文本永不进日志**。

### 4.5 `src/shared/peek-bridge.ts` —— DSH 方向扩展点（新增文件，不碰 `bridge-schema.ts`）

```ts
import type {
  PeekBlockReason, PeekEventHints, PeekObservationOutcome, PeekRedactionSummary,
  PeekSourceRef, PeekTier
} from './peek'

/** 与 DSH 桥共用目录 ~/.dsh/aventurine-pet/，但使用**新文件名**（既有契约不动）。 */
export const PEEK_BRIDGE_REQUESTS_FILE = 'peek-requests.jsonl' // DSH → pet
export const PEEK_BRIDGE_EVENTS_FILE = 'peek-events.jsonl'     // pet → DSH
export const PEEK_BRIDGE_SCHEMA_VERSION = 1
export const PEEK_BRIDGE_MAX_LINE_BYTES = 8 * 1024
export const PEEK_BRIDGE_ROTATE_BYTES = 5 * 1024 * 1024

/** DSH 主动请求观察（零信任解析：未知字段丢弃、档位只能降、绝对不能要网络/整屏）。 */
export interface PeekDshObservationRequest {
  readonly v: 1
  readonly kind: 'observe'
  readonly id: string
  readonly ts: number
  readonly maxTier: 'metadata' // 契约上只允许 metadata；内容级请求一律拒绝
  readonly ttlMs: number
  readonly scope: { readonly kind: 'foreground-window' }
}
export function parsePeekDshRequestLine(line: string): PeekDshObservationRequest | null

/** pet → DSH：只含已脱敏元数据；**没有 text/title/image 字段**。 */
export interface PeekDshObservationEvent {
  readonly v: 1
  readonly kind: 'observation' | 'blocked'
  readonly id: string
  readonly ts: number
  readonly tier: PeekTier
  readonly source: PeekSourceRef
  readonly outcome: PeekObservationOutcome
  readonly blockReason: PeekBlockReason | null
  readonly redaction: PeekRedactionSummary
  readonly confidence: number
  readonly hints: PeekEventHints
  readonly ttlMs: number
}
export function serializePeekDshEvent(event: PeekDshObservationEvent): string | null
export function isPeekDshObservationEvent(value: unknown): value is PeekDshObservationEvent
```

**扩展点语义（三个候选方案，推荐 A）**

| 方案 | 做法 | 结论 |
|---|---|---|
| **A（推荐）** | 桥目录新增 `peek-requests.jsonl`（DSH→pet）+ `peek-events.jsonl`（pet→DSH），复用 dsh-watch 的字节偏移/零信任/轮转模式 | ✅ 不改既有 `status.json`/`events.jsonl` 契约；双向默认关闭；后续插件只需读写新文件 |
| B | 复用 `events.jsonl` 加新 `DshEventType` | ❌ 要改冻结 `DSH_EVENT_TYPES` + 桥插件白名单 + payload 白名单，跨进程破坏面大 |
| C | 本地 HTTP/socket | ❌ 新增监听端口/攻击面；与 renderer 网络 guard 语义冲突；不推荐 |

**安全约束（写死在契约/实现里）**：双向默认关闭；DSH 请求只能 metadata、不能要网络、不能要整屏；请求必须过 gate（`dsh-request-disabled`/`dsh-content-forbidden`/`rate-limited`）；出站文件 0600、5MB 轮转、单行 ≤8KB；解析失败静默跳过；**失败绝不阻断观察器主流程**；DSH 插件侧新增读写属独立版本工作（不在本接口轮）。

### 4.6 主进程 provider 接口（`src/main/peek/provider.ts`，非共享）

```ts
import type {
  ObservationRequest, ObservationResult, PeekCapabilityId, PeekPermissionState,
  PeekTier, PeekUnavailableReason
} from '@shared/peek'

export interface PeekProviderProbe {
  readonly available: boolean
  readonly capabilities: readonly PeekCapabilityId[]
  readonly permission: PeekPermissionState
  readonly reason: PeekUnavailableReason | null
  readonly checkedAtMs: number
}

export interface PeekProvider {
  readonly id: string
  readonly version: string
  readonly kind: 'stub' | 'native-helper' | 'http-vlm'
  /**
   * 只读能力探测。**硬性约束**：不得触发 TCC 弹窗、不得截图/录屏、不得读标题、不得写盘、
   * 不得出网；超时必须由调用方强杀（helper）或忽略（in-process）。
   */
  probe(): Promise<PeekProviderProbe>
  /** 单次观察。永不抛异常；失败返回 outcome='unavailable' 的完整结果。 */
  observe(request: ObservationRequest): Promise<ObservationResult>
  /** 幂等释放（kill helper / 关连接 / 清缓冲）。 */
  dispose(): void
}

export interface PeekProviderRegistry {
  /** 重复 id 抛错（启动期配置错误，不静默覆盖）。 */
  register(provider: PeekProvider): void
  unregister(id: string): void
  setEnabled(id: string, enabled: boolean): void
  list(): readonly { id: string; version: string; kind: PeekProvider['kind']; enabled: boolean }[]
  probe(id: string): Promise<PeekProviderProbe>
  probeAll(): Promise<readonly PeekProviderProbe[]>
  /** 静态优先级选择；无可用 → null（gate 得到 provider-unavailable / stub-provider）。 */
  pick(tier: PeekTier): PeekProvider | null
}
```

### 4.7 渲染层反应接口（`src/renderer/src/reactions/peek.ts`，不扩 `ExternalReaction`/`PetMood`）

```ts
import type { PeekEvent, PeekReactionIntent } from '@shared/peek'

/** 只来自 `core/voicelines.ts` 官方池的台词映射（禁止自创，用户硬性要求）。 */
export type PeekBubblePool = 'idle' | 'greeting' | 'success' | 'defeat' | null

export interface PeekReaction {
  readonly bubblePool: PeekBubblePool
  readonly intent: PeekReactionIntent
  readonly durationMs: number
  readonly startedAtMs: number
}

export const PEEK_REACTION_DURATIONS: Readonly<Record<PeekReactionIntent, number>> = {
  notice: 3_000,
  'welcome-back': 4_000,
  'celebrate-focus': 5_000,
  'care-break': 6_000
}
export const PEEK_REACTION_MIN_GAP_MS = 10 * 60_000

export class PeekReactionTracker {
  /** 消费一个 peek-event（重复 id / blocked / intent=null → 忽略；绝不抛异常）。 */
  pushEvent(event: PeekEvent, nowMs: number): void
  /** 当前未过期的反应；过期/冷却中 → null。 */
  reactionAt(nowMs: number): PeekReaction | null
  reset(): void
}
```

**与主链路的关系**：本模块**不**改 `BehaviorInput`/`ExternalReaction`/`PetMood`；接线由 Lead 决定（把 `PeekReaction.bubblePool` 解析成官方台词文本后走 `main.ts` 现有气泡显示路径，或在 W-B 再评估是否并入 B1）。台词文本必须在 renderer 内由 `voicelines.ts` 的池 + `isOfficialVoiceLine` 校验产生，**任何 app 名/标题/文本不得拼进气泡**。

### 4.8 IPC 追加（S2，`src/shared/ipc.ts` 仅追加）

```ts
// src/shared/ipc.ts —— 既有 14 键的值/顺序全部不变，以下追加在末尾
import type { PeekEvent, PeekHistoryEntry, PeekStatus } from './peek'
import type { PeekManualObserveRequest, PeekManualObserveResult } from './peek'

export const IPC = {
  /* …既有 14 键原样… */
  peekStatus: 'pet:peek-status',
  peekObserveNow: 'pet:peek-observe-now',
  peekHistory: 'pet:peek-history',
  peekClearHistory: 'pet:peek-clear-history',
  peekOpenPermissionSettings: 'pet:peek-open-permission-settings'
} as const

export const IPC_EVENTS = {
  /* …既有 4 键原样… */
  peekEvent: 'peek-event',
  peekStatusChanged: 'peek-status-changed' // 可选：S2-min 可先不加
} as const

// IpcInvokeMap 追加
'pet:peek-status': { args: []; result: PeekStatus }
'pet:peek-observe-now': { args: [request?: PeekManualObserveRequest]; result: PeekManualObserveResult }
'pet:peek-history': { args: []; result: PeekHistoryEntry[] }
'pet:peek-clear-history': { args: []; result: void }
'pet:peek-open-permission-settings': { args: []; result: void }

// IpcEventMap 追加
'peek-event': PeekEvent
'peek-status-changed': PeekStatus

// PetApi 追加（preload 纯转发）
getPeekStatus(): Promise<PeekStatus>
peekObserveNow(request?: PeekManualObserveRequest): Promise<PeekManualObserveResult>
getPeekHistory(): Promise<PeekHistoryEntry[]>
clearPeekHistory(): Promise<void>
openPeekPermissionSettings(): Promise<void>
onPeekEvent(callback: (event: PeekEvent) => void): Unsubscribe
onPeekStatusChanged(callback: (status: PeekStatus) => void): Unsubscribe
```

```ts
/** 渲染层手动请求：只能降档；不允许指定 scope/网络/id。 */
export interface PeekManualObserveRequest { readonly maxTier?: PeekTier }
export interface PeekManualObserveResult {
  readonly accepted: boolean
  readonly outcome: PeekObservationOutcome
  readonly tier: PeekTier
  readonly reason: PeekBlockReason | null
}
```

### 4.9 配置追加（S2，`src/shared/types.ts` + `config.ts`）

```ts
// types.ts
import type { PeekConfig } from './peek'
export interface PetConfig {
  /* …既有 14 字段原样… */
  /** R4 新增（可选键语义）：窥屏互动接口预留；默认全关。 */
  peek: PeekConfig
}

// config.ts
import { DEFAULT_PEEK_CONFIG, sanitizePeekConfig } from './peek'
export const DEFAULT_CONFIG: PetConfig = { /* …既有字段… */, peek: DEFAULT_PEEK_CONFIG }
// sanitizeConfig 末尾追加：
peek: sanitizePeekConfig(readOwn(source, 'peek'))
```

**嵌套组必须注意的两件事**（Lead 评审点）：

1. `src/main/config-store.ts:63-65` 的 `copyConfig` 目前是浅拷贝，注释明确写「未来若加嵌套字段必须改成真正的深拷贝」。加 `peek` 组后必须改为：
   ```ts
   function copyConfig(config: PetConfig): PetConfig {
     return { ...config, peek: copyPeekConfig(config.peek) } // 或 structuredClone(config)
   }
   ```
   并补测试：改 `get()` 返回值里的 `peek.rules.denyApps` 不得污染 store。
2. `toConfigPartial`（`src/main/config-store.ts:189-198`）对顶层 `peek` 是**整组替换**语义：设置页必须发送完整 `peek` 组；补测试锁定该语义（避免「只传 enabled 把规则重置」的坑）。

### 4.10 Stub 行为定义（S1，逐 API）

| API | 返回值/行为 | 副作用 | 日志 |
|---|---|---|---|
| `registry.register(stub)` | 成功；重复 id 抛错 | 无 | 1 条 `info`（注册完成） |
| `stub.probe()` | `{available:false, capabilities:[], permission:<实时查询>, reason:'stub-provider'}` | **无 TCC 弹窗、无截图、无 spawn、无 fs、无标题读取** | 无 |
| `stub.observe(req)` | `{outcome:'unavailable', tier:'off', source:{providerId:'stub', providerVersion:'0.0.0-interface', capability:null}, redaction:{applied:false,ruleIds:[],linesDropped:0,bytesOut:0,truncated:false}, ttlMs:0, confidence:0, skipReason:'stub-provider', gate:{allowed:false,reason:'stub-provider'}}`；忽略 request.maxTier | 无 | 无（或 debug 级 1 条，默认不写） |
| `observer.start()`（默认配置） | **不装定时器**立即返回 | 无 | 无 |
| `observer.observeNow()`（默认配置） | `{accepted:false,outcome:'skipped',tier:'off',reason:'global-disabled'}`，**provider 不被调用** | 无 | 无 |
| `observer.getStatus()` | `stub provider` + 全部 capability `available:false` + 实时权限快照 + `effectiveTier:'off'` | 仅 `getMediaAccessStatus` 只读查询 | 无 |
| `observer.getHistory()` | `[]`（关闭态不写历史） | 无 | 无 |
| `observer.clearHistory()` | 幂等 no-op | 无 | 无 |
| `observer.setPaused(true)` | 状态变更；后续 observe 返回 `paused` 阻断 | 无 | 无 |
| `broadcast(PeekEvent)` | 关闭态永不调用 | 无 | 无 |

> 说明：`stub.observe()` 仅用于接口完整性与单测；正常路径下 observer 的 gate 会在调用 provider **之前**以 `stub-provider` 阻断，stub 永远不会被真正调用（这也是「网关先行」的证明点）。

### 4.11 `pet:peek-open-permission-settings` 精确行为

```ts
const SCREEN_RECORDING_SETTINGS_URL =
  'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture'
// handler：await shell.openExternal(URL) —— 只开系统设置，不查询、不修改、不弹窗、不引导授权
```

与 `src/main/ipc/window.ts:42-43,192-194` 的辅助功能深链完全同构；**非 macOS 直接 no-op**。

---

## 5. 进程 / IPC 布局与数据流

### 5.1 数据流（未来 P0 形态；接口阶段全部短路）

```
[既有] native/winlist（250ms，无标题/无权限）
        │ pet:windows / windows-updated
        ▼
[main] PeekObserver ── 构造 PeekForegroundWindow（fullscreen = 与 display.bounds 误差 ≤2px）
        │
        ├─ 定时器（仅 enabled 时安装；±15% 抖动）──┐
        ├─ pet:peek-observe-now（手动，限流）─────┤
        └─ DSH peek-requests.jsonl（默认关）──────┤
                                                   ▼
                                    decidePeekGate(request, ctx)  ← fail-closed 单点
                                                   │ allowed
                                                   ▼
                               registry.pick(tier) → provider.observe(request)
                                                   │
                     ┌─────────────────────────────┴──────────────────────────┐
                     ▼                                                        ▼
        ObservationResult（主进程内存，可含内容）                PeekEvent（无内容）
         ├─ 脱敏/截断/ttl → 立即释放引用                           ├─ broadcast 'peek-event' → renderer
         ├─ 写内存历史 PeekHistoryEntry（只元数据）                ├─ reactions/peek.ts → PeekReaction
         └─ DSH 转发（默认关，只元数据）→ peek-events.jsonl       └─ 官方台词池气泡 + poseHint（Lead 接线）
```

### 5.2 各进程职责

| 层 | 文件（新增/修改） | 职责 | 禁止 |
|---|---|---|---|
| shared | `peek.ts` / `peek-gate.ts` / `peek-rules.ts` / `peek-redact.ts` / `peek-bridge.ts` | 类型、默认值、清洗、gate/rules/redact/envelope 纯逻辑 | electron/node/第三方 import；任何采集 |
| main | `peek/provider.ts` / `registry.ts` / `stub-provider.ts` / `permission.ts` / `observer.ts`；`ipc/peek.ts` | 编排、权限查询、深链、provider 生命周期、历史/退避、IPC | 整屏、标题、落盘、日志写内容 |
| preload | `src/preload/index.ts`（S2 追加） | 5 invoke + 1–2 事件纯转发 | 暴露原始 `ipcRenderer` |
| renderer overlay | `reactions/peek.ts`（S3） | `PeekEvent` → `PeekReaction`（官方台词池/冷却/去重） | 接触内容字段；自创台词 |
| renderer settings | `settings/peek-model.ts`（S3 可选/延后） | `PeekStatus`/`PeekHistoryEntry` 文案纯函数 + 回看面板 | 展示原文/标题/截图 |
| native | 未来 `native/peekcap/**`（本轮不做） | 单窗口截图/OCR/氛围采样（SCK + Vision） | 整屏、落盘、探测时采集 |

### 5.3 IPC 清单

| 通道 | 方向 | 参数 | 返回 | 默认（stub）行为 |
|---|---|---|---|---|
| `pet:peek-status` | invoke | — | `PeekStatus` | stub provider、全不可用、`effectiveTier='off'` |
| `pet:peek-observe-now` | invoke | `{maxTier?}` | `PeekManualObserveResult` | `global-disabled` 或 `stub-provider`，无副作用 |
| `pet:peek-history` | invoke | — | `PeekHistoryEntry[]` | `[]` |
| `pet:peek-clear-history` | invoke | — | `void` | 幂等 |
| `pet:peek-open-permission-settings` | invoke | — | `void` | 打开系统设置（仅用户点击时；非 macOS no-op） |
| `peek-event` | main→renderer | — | `PeekEvent` | 关闭态永不广播 |
| `peek-status-changed` | main→renderer | — | `PeekStatus` | 关闭态永不广播（S2-min 可省） |

> 可选追加（不在 S2 最小批次）：`pet:peek-set-paused`（`paused: boolean` → `PeekStatus`）——仅当设置页需要「暂停 1 小时」这类运行期控制时再加（invoke 由 19 变 20）。S1 的 observer 已提供 `setPaused()`，加通道只是补一层转发。

### 5.4 preload 追加

`src/preload/index.ts` 的 `petApi` 对象追加 5 个 `invoke(...)` + 1–2 个 `subscribe(...)`；类型由 `IpcInvokeMap`/`IpcEventMap` 自动约束（现有 `invoke<K>`/`subscribe<K>` 泛型无需改）。**不新增第二个全局对象**（保持「唯一桥接面」不变）。

> 备选（若 Lead 拒绝改冻结 IPC/PetApi 测试）：`src/shared/peek-ipc.ts` 独立通道常量 + `contextBridge.exposeInMainWorld('peekApi', ...)`。代价：破坏「window.api 唯一桥接面」文档口径、需改 `src/preload/index.d.ts`/`env.d.ts`、无 `shared-contract` 护栏；**不推荐**，仅作退路记录。

### 5.5 渲染层消费

1. **reaction**：`window.api.onPeekEvent(event => peekTracker.pushEvent(event, performance.now()))`（Lead 在 `main.ts` 接线，参照 `onDshEvent` 的同构位置 `src/renderer/src/main.ts:1395-1402`）；每帧 `peekTracker.reactionAt(now)` → 由 Lead 决定气泡/poseHint 呈现（W-B）。
2. **settings**：打开设置页时 `getPeekStatus()` + `getPeekHistory()`；「清空」按钮 → `clearPeekHistory()`；权限被拒 → 显示深链按钮（点击才 `openPeekPermissionSettings()`）。
3. **overlay 不接受任何内容**：`PeekEventHints` 只有 `intent`/`activityClass`，理论上无法拼出「我看到你在用 X」。

### 5.6 冻结契约影响矩阵（S2 精确 diff 清单）

| 文件 | 变更 | 级别 | 既有值是否变化 | 同步测试 |
|---|---|---|---|---|
| `src/shared/peek*.ts`（新） | 新增 | A | 否 | 新增 `tests/peek-*.test.ts` |
| `src/shared/ipc.ts` | IPC 追加 5 键、IPC_EVENTS 追加 1–2 键、IpcInvokeMap/IpcEventMap/PetApi 追加 | B | **否**（既有 14 值原样） | `tests/shared-contract.test.ts` 期望集合**追加**；14→19、4→5/6、18→24/25 |
| `src/shared/types.ts` | `PetConfig` 追加 `peek: PeekConfig` | B | 否（14 既有字段原样） | 同上（DEFAULT_CONFIG 追加一行，字段 14→15） |
| `src/shared/config.ts` | `DEFAULT_CONFIG` 追加 `peek`；`sanitizeConfig` 追加一行 `peek: sanitizePeekConfig(...)` | B | 否；`CONFIG_VERSION` 保持 1 | 同上 + `tests/ipc-config.test.ts`/新增 sanitize 用例 |
| `src/main/config-store.ts` | `copyConfig` 深拷贝 `peek`（修既有注释预告的坑） | B（行为加固） | 否（仅更安全） | `tests/config-store.test.ts` 追加深拷贝用例 |
| `src/preload/index.ts` | 追加 5 invoke + 1–2 subscribe 转发 | B | 否 | `tests/peek-ipc.test.ts`（或 source 断言） |
| `src/main/ipc/peek.ts`（新） | 5 handler 注册 | A | 否 | 新增 `tests/peek-ipc.test.ts` |
| `src/main/ipc/index.ts` | Lead 追加 `registerPeekIpc(ctx, logger)` 一行 | B | 否 | `tests/peek-ipc.test.ts`/启动集成（现有 `desktop-ipc` 模式） |
| `tests/helpers/electron-stub.ts` | `FakeSystemPreferences` 补 `getMediaAccessStatus` + 查询记录；`askForMediaAccess` spy | B（测试基建） | 否 | 供 peek-ipc 测试 |
| `docs/known-issues.md` | Lead 追加一条「R-33 peek 接口占位未实现采集」 | B（文档） | 否 | — |
| `docs/packaging.md` | **本轮不改**；未来采集实现时按 §3 红线四步更新 | — | — | — |
| `src/main/index.ts` / `src/renderer/src/main.ts` / `core/pet-runtime.ts` / `wave2-contract.ts` | **本轮不改**（接线留到 W-B） | — | — | — |
| `native/winlist/**` / `bridge-schema.ts` / `ExternalReaction` / `PetMood` | **保持不动** | D | — | 回归测试兜底 |

**冻结批次提交建议**：在干净工作树、一次性提交（单一 writer，避免与其它 agent 冲突）；提交信息注明「契约追加：+5 invoke/+1–2 events/+peek config，既有值不变」。

### 5.7 三阶段提交切分与依赖

```
S0（shared 纯逻辑，零冻结）──► S1（main 基础设施，零冻结）──► S2（冻结追加批次）
        │                                                        │
        └──────────────► S3-1 reactions（依赖 S0 契约）───────────┘（接线由 Lead 在 W-B 做）
S3-2 设置占位/历史面板：延后到 W-B（与 P0 能力上线同批，见 §7）
```

### 5.8 文件总清单（新增 / 追加 / 禁止改动）

**新增（A 级，无人 import 时零运行时影响）**

| 文件 | 段 | 说明 |
|---|---|---|
| `src/shared/peek.ts` | S0 | 契约根（tier/capability/permission/config/defaults/sanitize/validators/log 白名单） |
| `src/shared/peek-gate.ts` | S0 | gate / effective tier / capability status 纯函数 |
| `src/shared/peek-rules.ts` | S0 | 规则解析/匹配/有效状态 |
| `src/shared/peek-redact.ts` | S0 | 文本脱敏 + 输出过滤器 |
| `src/shared/peek-bridge.ts` | S0 | DSH 双向 envelope（零信任解析，不碰 fs） |
| `src/main/peek/provider.ts` | S1 | provider/probe 接口 |
| `src/main/peek/registry.ts` | S1 | provider 注册/禁用/探测/选择 |
| `src/main/peek/stub-provider.ts` | S1 | 唯一 provider：恒 `unavailable`、零副作用 |
| `src/main/peek/permission.ts` | S1 | TCC 查询映射（纯函数）/ 深链 / 注入式 probe |
| `src/main/peek/observer.ts` | S1 | 编排：定时/manual/DSH、gate、历史、退避、广播 |
| `src/main/ipc/peek.ts` | S2 | 5 个 handler 注册（由 `ipc/index.ts` 接线） |
| `src/renderer/src/reactions/peek.ts` | S3 | `PeekEvent` → `PeekReaction` tracker |
| `src/renderer/src/settings/peek-model.ts` | S3-2（可延后） | status/history 文案纯函数 |
| `tests/peek-*.test.ts`（约 9 个） | S0–S3 | 见 §9 |

**追加（B 级，既有值/语义不变）**

| 文件 | 追加内容 |
|---|---|
| `src/shared/ipc.ts` | 5 invoke + 1–2 event + IpcMap + PetApi 成员 |
| `src/shared/types.ts` | `PetConfig.peek: PeekConfig` |
| `src/shared/config.ts` | `DEFAULT_CONFIG.peek`；`sanitizeConfig` 一行接入 |
| `src/main/config-store.ts` | `copyConfig` 深拷贝 `peek`（修既有浅拷贝预留坑） |
| `src/preload/index.ts` | 5 invoke + 1–2 subscribe 转发 |
| `src/main/ipc/index.ts`（Lead） | `registerPeekIpc(ctx, logger)` 一行 |
| `tests/shared-contract.test.ts` 等（Lead 评审） | 期望集合追加 |
| `tests/helpers/electron-stub.ts` | `FakeSystemPreferences.getMediaAccessStatus` |
| `docs/known-issues.md`（Lead） | 接口占位条目 |

**禁止改动（本轮）**：`native/winlist/**`、`src/shared/bridge-schema.ts`、`src/renderer/src/core/wave2-contract.ts`、`PET_MOODS`/`ExternalReaction`、`src/main/index.ts`/`src/renderer/src/main.ts`/`core/pet-runtime.ts`（接线留 W-B）、`docs/packaging.md`（采集实现时再动）、`package.json`/锁文件/构建脚本。

---

## 6. Provider 注册与插件化

### 6.1 原则

1. **编译内置，不动态加载第三方代码**：provider 只能是本仓库源码（`src/main/peek/**`）或独立 native helper 进程；**禁止**从用户目录/环境变量 require/import 任意 JS（这会把 TCC 权限面变成代码执行面）。
2. **静态优先级**：registry 内部按 `tier` 选 provider（未来可加 `priority` 字段，追加式）；无可用 → `provider-unavailable`。
3. **能力探测只读**：`probe()` 不得产生任何采集/TCC 弹窗/出网；helper 探测用 `--capabilities` 子命令（见 6.2），UI 状态查询可 5s 缓存。
4. **禁用在三个层级**：`config.peek.enabled=false`（全局）、`observer.setPaused(true)`（临时）、`registry.setEnabled(id,false)`（运维/故障）。任一层 → gate 阻断，provider 不被调用。
5. **故障隔离**：provider 抛错/超时/返回非法结构 → 本次 `unavailable` + 连续失败退避（3 次 → 30s 起指数退避，上限 30min），**只 warn 一次**；权限恢复（用户重新授权）→ 清零立即恢复（Miru 做法，可行性报告 §2.7）。

### 6.2 未来 native helper 协议草案（`native/peekcap`，本轮不实现）

```bash
native/peekcap --capabilities
# stdout 单行 JSON（不采集、不弹 TCC、不落盘）：
# {"schemaVersion":1,"helperVersion":"1.0.0","platform":"macos",
#  "captureBackend":"screencapturekit|screencapturekit-fallback",
#  "capabilities":["screen.peek.ambient","screen.peek.ocr"],
#  "permission":"screen-recording"}

native/peekcap --observe --request -     # stdin 单行 ObservationRequest JSON
# stdout 单行 JSON：{"schemaVersion":1,"outcome":"observed|skipped|unavailable",
#  "tier":"ambient|ocr","ambient":{...}|null,"text":{...}|null,
#  "skipReason":"...","bytesOut":123}
# stderr：错误 envelope（不含画面/标题内容）；exit 0/2
```

硬性约束（写进未来 helper 的 README/验收）：**不写文件**（帧/OCR 图/文本只在内存 → stdout）；单行输出 ≤256KB（超限 → 主进程 kill）；超时 2–5s 强杀；只接受 `foreground-window` scope 且窗口不可得时 `skipped`，**绝不回退整屏**；不读 `kCGWindowName`（除未来 title provider 显式能力，且同样走 TCC+评审）；universal（arm64+x86_64）、minos 13.0、复用 `scripts/build-native.mjs` 的 TARGETS/stamp/`--check` 模式（`scripts/build-native.mjs:9-11,113-117`）。

### 6.3 与现有 `native/winlist` 的边界

- `winlist` **保持现状**：只读 bounds/owner/pid/layer/alpha，不读标题、不需要权限（`native/winlist/README.md:8-15,100-106`）。P0 metadata provider 只消费其输出，**不新增 native 代码**。
- 一旦未来要读标题/截图：必须先走 `docs/packaging.md` §3 红线四步（entitlements、签名/公证、设置页引导+降级、同步文档），并新增 `screen.peek.title` / `peekcap` 的验收项；本接口轮**不做**。

### 6.4 TCC 权限流程接口（只查询 + 深链，不弹窗）

| 能力 | 接口 | 行为 |
|---|---|---|
| 查询 | `systemPreferences.getMediaAccessStatus('screen')`（main，只读） | 映射为 `PeekPermissionState`；`unknown` 也按未授权处理 |
| 申请 | **不存在**（macOS 录屏不可应用内申请；`askForMediaAccess` 不支持 screen） | 不实现、不调用 |
| 引导 | `shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture')` | 仅用户点击「去系统设置」时触发 |
| 刷新 | `pet:peek-status` 每次实时查询 + 从系统设置返回应用后重新查询（未来 W-C 加 window focus 监听） | 不缓存为 granted |

---

## 7. 设置页 / UX 建议

### 7.1 本轮（接口阶段）结论：**隐藏，不显示禁用占位**

理由：

1. 接口阶段**没有任何可用能力**，显示开关只能是 disabled；用户看到「屏幕感知（即将推出）」会追问/误解，且无法验证任何行为。
2. 隐私类功能应先有「可关闭/可回看」再出现入口；先出开关后补能力会形成「开了但没反应」或「有了但没说清」的坏体验。
3. 设置页当前权限区（`src/renderer/settings.html:185-195`）只展示辅助功能/通知；**不加探屏项**可以保持现有 UI 验收不变，S2 的 IPC 也可先只被调试面/测试使用。
4. 把 UI 与能力同批上线，让「开关 + 权限引导 + 回看面板 + 降级文案」一次到位，避免中间态。

### 7.2 未来上线时机（W-B / W-C）

| 阶段 | 设置页内容 |
|---|---|
| W-B（P0 元数据落地） | 「屏幕感知」分区：总开关（默认关）、`仅应用名模式`说明、暂停（若加暂停按钮，同时补可选通道 `pet:peek-set-paused`）、最近观察（只元数据，10 条，可清空）、能力/权限状态 badge、DSH 转发开关（默认关） |
| W-C（P1/P2 落地） | 在上表基础上加：录屏权限引导 + 深链按钮、单窗口/不落盘/本机 OCR 说明、敏感应用规则编辑（deny/allow + 有效状态预览）、`最近 10 次`含脱敏摘要（仍不含原文） |
| W-D（P3） | 网络 provider 选择 + 首次发送前 consent sheet（预览将发送的图/文本）；成本/次数面板 |

**文案红线**：不得使用「我看到你…」「你的屏幕上…」「你正在输入…」；统一「这会儿…」「你好像…」的模糊表述（可行性报告 §4.3）。台词只能取官方语音原文（`core/voicelines.ts`）。

### 7.3 可在 S3 先写的纯函数（不依赖 UI）

```ts
// src/renderer/src/settings/peek-model.ts（可选；不接 DOM，可单测）
export function describePeekStatus(status: PeekStatus): { text: string; tone: 'off' | 'stub' | 'warn' | 'ok' }
// stub                    → { text: '接口预留 · 尚未启用', tone: 'stub' }
// globally off            → { text: '已关闭', tone: 'off' }
// permission denied/...   → { text: '未授权 · 需在系统设置中开启屏幕录制', tone: 'warn' }
// effectiveTier metadata  → { text: '仅应用名模式', tone: 'warn' }
// effectiveTier >= ambient→ { text: '已启用', tone: 'ok' }

export function describePeekHistoryEntry(entry: PeekHistoryEntry): {
  time: string; tier: string; outcome: string; detail: string
}
```

### 7.4 「可回看」保留策略

- **内存态 ring buffer 10 条**，进程退出即消失（接口阶段就按此契约实现，不落盘）。
- 条目字段见 `PeekHistoryEntry`：tier/outcome/blockedReason/redaction/forwardedToDsh/spoken/bytesOut + app 名（仅展示）。
- `pet:peek-clear-history` 立即清空；`getHistory()` 返回副本（防调用方篡改）。
- 可行性报告的「观察日志只存元数据、7 天自动清理」属于未来持久化选项，**接口阶段不做持久化**（更安全；未来若要落盘须单独评审 + 每用户可关）。

---

## 8. 安全与隐私红线（执行点 + 验证）

| # | 红线 | 执行点 | 验证方式（S0–S3 可测） |
|---|---|---|---|
| 1 | 接口层默认不开启任何采集 | `DEFAULT_PEEK_CONFIG` 全关；`observer.start()` 关闭态不装定时器；stub 恒 unavailable | `tests/peek-contract.test.ts` 断言默认值；`tests/peek-observer.test.ts` fake timers 断言零定时器/零 provider 调用 |
| 2 | stub 必须返回 unavailable | `stub-provider.ts` | 单测逐字段断言 outcome/skipReason/ttl/confidence；source scan 断言无 electron/fs/child_process import |
| 3 | fail-closed 单点 | `decidePeekGate`；provider 只收已放行请求 | gate 真值表（≥30 例）；"provider 不被调用" spy 断言 |
| 4 | 不申请 TCC / 不弹窗 | `src/main/peek/permission.ts` 只 import `getMediaAccessStatus`；深链只 `shell.openExternal` | electron stub：`askForMediaAccess` spy 恒零调用；`openExternal` URL 精确断言 |
| 5 | 不读窗口标题 | capability `screen.peek.title` 恒不可用；`native/winlist` 零改动；P0 metadata 无 title 字段 | `git diff --stat native/winlist` 为空；契约/事件类型无 title 字段（编译期） |
| 6 | 不整屏 | scope 类型只有 `foreground-window`；无 fallback 分支 | 类型系统 + `tests/peek-gate.test.ts` 断言 window 不可得时直接 `window-unavailable` |
| 7 | 不落盘 | observer/stub 无 fs import；history 内存；帧/文本只在内存 | source scan；`tests/peek-observer.test.ts` 断言无写盘调用（注入 fs spy 或静态扫描） |
| 8 | 默认不出网 / renderer 无网络能力 | 阶段内 vision 不可用；未来 P3 只在 main 进程；renderer 网络 guard 不变 | 类型 + 现有 `renderer-network-guard` 测试不变 |
| 9 | 日志不含内容 | `sanitizePeekLogMeta` 白名单；禁 text/title/app 名键 | 单测：传入含内容键的 meta → 输出只剩白名单；静态扫描 logger 调用参数是否出现 text/title/owner 键 |
| 10 | renderer 不接触内容 | `PeekEvent`/`hints` 无内容字段；history 只元数据 | 类型精确断言 + 广播 payload 快照测试 |
| 11 | DSH 边界 | 双向默认关；`peek-bridge.ts` 零信任解析；DSH 请求只能 metadata、不能网络 | envelope 解析测试：提档/网络/超长/未知枚举 → null；默认配置不写文件 |
| 12 | 契约不被破坏 | S2 只追加；既有 channel/config 值不变；`CONFIG_VERSION=1` | `shared-contract` 既有断言不变（新增期望另加）；旧 config 回填测试 |
| 13 | 用户可关/可暂停/可回看/可清空 | `enabled`/`paused`/`history`/`clear` | observer/ipc 单测 |
| 14 | 不动态加载第三方代码 | provider 只来自本仓库/helper；无动态 import | code review + 静态扫描（无 `require(userPath)` / `import(variable)`） |

---

## 9. 测试清单（纯逻辑优先，不启动 Electron）

### 9.1 S0 shared 纯逻辑（node 环境）

| 测试文件 | 关键用例（数量为最低要求） |
|---|---|
| `tests/peek-contract.test.ts` | tier 顺序/rank/min/内容判定；capability 表冻结（5 个 id/顺序/权限映射）；`DEFAULT_PEEK_CONFIG` 全关断言；`sanitizePeekConfig`：未知键丢弃、数值钳制、枚举回退、规则数组上限/去重/trim、quietHours 格式、原型链/`__proto__` 输入安全、每次返回新嵌套对象；`sanitizePeekLogMeta` 白名单；`isPeekTier`/类型守卫；`PEEK_LIMITS` 与默认值自洽（默认值都在范围内）（≥20 例） |
| `tests/peek-gate.test.ts` | 26 步决策顺序逐条真值表：paused / global-disabled / tier-off / 各 permission 状态 / capability 缺失 / stub-provider / quiet-hours / focus-mode / cooldown / budget / backoff / denied-app / unknown-app / outside-allowlist / title-unavailable（标题不可用 + 有标题规则）/ denied-title / fullscreen / meeting / incognito / dsh-request-disabled / dsh-content-forbidden / rate-limited / allowed；`resolveEffectiveTier` 永不升档（覆盖 enabled/metadataEnabled/permission/provider 组合）；阈值边界（maxPerHour=0、minGap 恰好相等）（≥30 例） |
| `tests/peek-rules.test.ts` | screenpipe 语法四写法；大小写不敏感；空/超长/非法；有效状态 captured/ignored/partial/outside-allowlist；deny+allow 同时命中 → ignored + blockedIndirectly；标题不可用时 `requiresTitleToEvaluate` 为真；中文/空格 app 名（≥15 例） |
| `tests/peek-redact.test.ts` | 行级敏感词丢弃；URL/邮箱/长数字移除；1200 字符截断与 `truncated` 标志；`summary.bytesOut/linesDropped` 计数；`isSafePeekOutput` 对手机号/邮箱/代码样式/敏感词/官方台词样本的判定（≥12 例） |
| `tests/peek-bridge.test.ts` | 合法请求/事件往返；未知字段丢弃；`maxTier` 非 metadata → null；超长行/截断 JSON/坏枚举 → null；事件序列化单行 ≤8KB；`isPeekDshObservationEvent` 严格校验；DSH 事件无内容字段（类型/结构断言）（≥10 例） |

### 9.2 S1 main 基础设施（node 环境 + fake clock/provider）

| 测试文件 | 关键用例 |
|---|---|
| `tests/peek-registry.test.ts` | 注册/重复 id 抛错/注销/setEnabled/list；probe 聚合与超时降级；pick 无可用 → null；provider 抛错 → unavailable（吞异常） |
| `tests/peek-permission.test.ts` | Electron 5 值 → 契约状态映射（含 unknown/非 darwin→unsupported）；深链常量精确；`canPromptFromApp:false`；不调用 `askForMediaAccess`（注入 fake 断言零调用） |
| `tests/peek-observer.test.ts` | **默认关闭**：start 不装定时器（fake timers）、observeNow→global-disabled、provider 零调用、broadcast 零调用、history 空、无 fs 写；stub 状态 snapshot；enabled+permission denied→阻断；连续 3 次失败→backoff（只 warn 一次、到点恢复）；history ring 10 条 + clear + 副本；paused；配置热更；dispose 后无定时器；manual 限流（minGap/每分钟）（≥20 例） |

### 9.3 S2 IPC（electron stub，不启动 Electron）

| 测试文件 | 关键用例 |
|---|---|
| `tests/peek-ipc.test.ts` | 5 个 handler 注册且不重复（`FakeIpcMain` 重复注册会抛）；status 返回 stub/全不可用；observe-now 关闭态无副作用；history 空/clear 幂等；open-permission-settings → `shell.openExternal` 精确 URL；handler 输入脏数据（null/数组/超大对象）不抛；无 TCC 弹窗调用 |
| `tests/shared-contract.test.ts`（追加，Lead 评审） | 既有 14 通道值逐字节不变；新增 5 键计数 19；事件 4→5/6；PetApi 精确键集合追加；`DEFAULT_CONFIG` 追加 `peek` 且既有 14 字段值不变；`CONFIG_VERSION` 仍为 1；旧 config（无 peek）回填默认 |
| `tests/config-store.test.ts`（追加） | `copyConfig` 深拷贝：改返回值 `peek.rules.denyApps` 不污染 store；`set({peek:...})` 整组替换语义 |
| `tests/ipc-config.test.ts`（追加） | `pet:set-config` 对 peek 脏输入钳制/丢弃未知键；`config-changed` 携带完整 peek 组 |

### 9.4 S3 renderer 纯逻辑

| 测试文件 | 关键用例 |
|---|---|
| `tests/peek-reactions.test.ts` | `observation`+intent → 反应一次；重复 id 去重；blocked 事件忽略；TTL 过期；10 分钟冷却；`bubblePool` 只映射官方池且池内每句 `isOfficialVoiceLine` 为真；气泡文本不含 app 名/标题/数字串；reset/幂等（≥10 例） |
| `tests/peek-settings-model.test.ts`（若做） | status 文案/tone 映射（stub/off/denied/metadata/ok）；history 条目格式化不含敏感字段 |

### 9.5 「无采集副作用」防回归（静态扫描，纯逻辑测试）

`tests/peek-no-side-effects.test.ts`（新增）：读源码文本并断言
- `src/main/peek/stub-provider.ts` 不含 `electron|child_process|node:fs|capturePage|desktopCapturer|kCGWindowName|askForMediaAccess`；
- `src/shared/peek*.ts` 不含 `electron|node:` 的前置 import（与 shared 规则一致）；
- `src/main/peek/observer.ts` 在默认关闭分支不出现 `setInterval(` 调用（或通过行为测试覆盖）。

### 9.6 本轮不测 / 后续测试

- 真机 TCC 授权/拒绝/每月复核、单窗口截图、OCR、VLM 出网：属 W-C/W-D 真机验收（可行性报告 §6 验收条）。
- 打包/公证后的权限行为：`docs/packaging.md` §2.5/§3，未打包前不承诺。
- 本轮不新增 smoke；S2 的 Electron 启动接线（`main/index.ts`）留到 W-B，届时用 `pnpm smoke` 的既有守护验收。

---

## 10. 验收清单

### 10.1 S0（shared 纯逻辑，可独立合并）

- [ ] `pnpm typecheck`（node+web）0 错误；`pnpm exec vitest run tests/peek-*.test.ts` 全绿。
- [ ] `git diff --stat` 仅新增文件（无既有文件改动）。
- [ ] `DEFAULT_PEEK_CONFIG.enabled/metadataEnabled === false`、`tier === 'off'`、`dsh.*` 全关（测试断言）。
- [ ] 所有 29 个 block reason 中，接口阶段可触达的（paused/global-disabled/tier-off/permission-*/capability-unavailable/provider-unavailable/stub-provider/dsh-*）都有真值表用例；其余在 `decidePeekGate` 中有确定实现（后续 provider 才可触发）。
- [ ] 规则引擎在「标题不可用 + 有标题规则」时返回 fail-closed 信号（`requiresTitleToEvaluate`/gate `title-unavailable`）。
- [ ] 脱敏/输出过滤器对官方台词样本全部 safe，对构造的手机号/邮箱/URL/代码样式全部 unsafe。
- [ ] DSH envelope 提档/网络/超长/未知字段一律拒绝。
- [ ] 无 electron/node/第三方 import（静态扫描测试）。

### 10.2 S1（main 基础设施，零冻结）

- [ ] registry/stub/permission/observer 单测全绿；fake timers 下默认关闭态**零定时器、零 provider 调用、零广播、零写盘**。
- [ ] stub `probe()` 无 TCC 弹窗、无截图、无 spawn、无标题读取（source scan + spy）。
- [ ] 连续 3 次失败 → backoff，日志只 warn 一次；成功/权限恢复 → 清零。
- [ ] history：最多 10 条、只元数据、返回副本、clear 幂等、不落盘。
- [ ] 权限映射 6 值全覆盖；深链 URL 精确；`askForMediaAccess` 零调用。

### 10.3 S2（冻结追加批次，Lead 评审）

- [ ] 既有 14 通道**值/顺序**逐字节不变（`toEqual` 期望只追加）；事件 4→5/6；`PetApi` 编译期键集合=24/25。
- [ ] `PetConfig` 仅追加 `peek`；`DEFAULT_CONFIG` 仅追加 `peek`；`CONFIG_VERSION` 仍为 1。
- [ ] 旧 `config.json`（version 1、无 peek）启动回填 `DEFAULT_PEEK_CONFIG`（测试）。
- [ ] `sanitizeConfig` 对 peek 脏输入：未知键丢弃、钳制、枚举回退、规则上限；`copyConfig` 深拷贝（改返回值不污染 store）。
- [ ] preload 只转发白名单；无原始 `ipcRenderer` 暴露。
- [ ] `pet:peek-status` 返回 stub/全不可用/`effectiveTier:'off'`；`pet:peek-observe-now` 默认 `global-disabled` 且无副作用；history 空；clear 幂等；deep link 精确 URL。
- [ ] 既有测试全绿（`shared-contract` / `ipc-config` / `config-store` / `desktop-ipc` 等）；全量 `pnpm test` 无回归。

### 10.4 S3（渲染层，可延后）

- [ ] `PeekEvent` → `PeekReaction` 映射/去重/冷却/TTL 单测全绿。
- [ ] 气泡文本 100% 来自官方池（`isOfficialVoiceLine` 逐句断言），不含 app 名/标题/数字串。
- [ ] 不修改 `ExternalReaction`/`PetMood`/`wave2-contract`（`git diff` 为空）。
- [ ] 若做设置占位：文案通过评审，默认关闭态可读且不出现「已开启」歧义。

### 10.5 未来采集轮验收（来自可行性报告 §6，接口就绪后对照）

- **W-B（P0）**：无新权限；切 IDE/浏览器/游戏各 1 次反应符合预期；1 小时主动发言 ≤3；CPU 增量 <2%；关闭开关后观察器零调用。
- **W-C（P1/P2）**：敏感 app/标题/全屏/通话/无痕 fixture 100% 跳过；截图不落盘（`fs_usage`/临时目录检查）；OCR 文本不出现在日志；拒绝授权自动降级且可恢复；连续 3 次失败退避不刷日志。
- **W-D（P3）**：`SKIP`/越界内容不发言；屏幕轮次不进长期记忆；关闭 P3 后零网络请求；DSH 转发默认关且只元数据。

---

## 11. 实现工作量估计

> 单位：人日；范围粗估（`inferred`，实施前用 spike 校准）。假设实施者熟悉本仓库契约体系与测试基建。

### 11.1 分项

| 任务 | 交付物 | 依赖 | 人日 |
|---|---|---|---|
| S0-1 | `src/shared/peek.ts`（tier/capability/permission/config/defaults/sanitize/validators/log 白名单）+ 契约测试 | — | 1.5–2 |
| S0-2 | `src/shared/peek-gate.ts`（gate/effective tier/capability status）+ 门控真值表测试 | S0-1 | 1.5–2 |
| S0-3 | `src/shared/peek-rules.ts`（screenpipe 语法 + 有效状态）+ 测试 | S0-1 | 0.75–1 |
| S0-4 | `src/shared/peek-redact.ts`（脱敏 + 输出过滤器）+ 测试 | S0-1 | 0.5–0.75 |
| S0-5 | `src/shared/peek-bridge.ts`（DSH envelope 零信任）+ 测试 | S0-1 | 0.5–0.75 |
| **S0 小计** | | | **4.5–6.5** |
| S1-1 | `provider.ts` + `registry.ts` + `stub-provider.ts` + 测试 | S0-1 | 1–1.5 |
| S1-2 | `permission.ts`（映射纯函数 + 深链 + 注入式 probe）+ 测试 | S0-1 | 0.5–1 |
| S1-3 | `observer.ts`（定时/manual/gate/历史/退避/广播/dispose）+ 测试 | S0-2/3/4、S1-1/2 | 1.5–2.5 |
| **S1 小计** | | | **3–5** |
| S2-1 | 冻结追加批次：ipc/types/config/preload/config-store 深拷贝 + `tests/shared-contract` 等追加 + `electron-stub` 补强 | S0-1 | 1.5–2.5 |
| S2-2 | `src/main/ipc/peek.ts` + `ipc/index.ts` 接线（Lead）+ `tests/peek-ipc.test.ts` | S1-3、S2-1 | 0.75–1.5 |
| **S2 小计** | | | **2.5–4** |
| S3-1 | `reactions/peek.ts` + `tests/peek-reactions.test.ts` | S0-1 | 0.5–1 |
| S3-2 | `settings/peek-model.ts` + 占位/历史面板（可延后 W-B） | S3-1、S2 | 0–1.5 |
| S4 | 文档（known-issues 条目、实现 README、验收记录） | 全部 | 0.5–1 |
| **合计（S0+S1+S2+S3-1+S4）** | | | **11–17.5** |

### 11.2 切片建议

- **最小可验证切片**（推荐先做）：S0-1 + S0-2 + S1-1（stub 注册表）≈ **4–5.5 人日**，零冻结契约影响、可立即合并，能证明「默认关闭 + stub unavailable + fail-closed」三件事。
- **完整接口预留**（S0+S1+S2+S3-1+S4）≈ **11–17.5 人日**。
- **设置占位/历史面板**（S3-2）建议与 W-B 的 P0 能力同批，不单独提前。

### 11.3 与可行性报告 18–28 人日的口径差异

- 本接口预留里的 `peek-gate`/`peek-rules`/`peek-redact` **就是**可行性报告 W-C 的隐私核心（约 3.5–4.5 人日），提前实现可从 W-C 抵扣；真正只为「接口预留」额外支出的约 **5–7 人日**（契约/stub/probe/冻结批次/IPC/文档）。
- 接口阶段不碰 native helper、不碰 SCK/OCR/VLM、不碰真机 TCC，因此显著低于 W-C/W-D 的实现风险。

---

## 12. 给实现 agent 的最小任务拆分

> 所有任务共享同一工作目录；**S2 是唯一改冻结契约的批次，必须单一 writer + Lead 评审**。写作用域互不重叠，依赖关系如下。

| 任务 | 建议 owner | 只允许写 | 依赖 | 验收 |
|---|---|---|---|---|
| **T1 `peek-core-contract`** | agent-A | `src/shared/peek.ts`、`src/shared/peek-gate.ts`、`tests/peek-contract.test.ts`、`tests/peek-gate.test.ts` | — | §10.1 中默认值/契约/gate 相关项；零冻结 diff |
| **T2 `peek-rules-redact-bridge`** | agent-B | `src/shared/peek-rules.ts`、`src/shared/peek-redact.ts`、`src/shared/peek-bridge.ts`、`tests/peek-rules.test.ts`、`tests/peek-redact.test.ts`、`tests/peek-bridge.test.ts` | T1（类型） | §10.1 中规则/脱敏/envelope 相关项 |
| **T3 `peek-main-runtime`** | agent-C | `src/main/peek/**`、`tests/peek-registry.test.ts`、`tests/peek-permission.test.ts`、`tests/peek-observer.test.ts` | T1、T2 | §10.2 全部；零冻结 diff |
| **T4 `peek-frozen-contract-batch`** | **Lead 或 Lead 指定单一 agent** | `src/shared/ipc.ts`、`src/shared/types.ts`、`src/shared/config.ts`、`src/main/config-store.ts`、`src/preload/index.ts`、`src/main/ipc/peek.ts`、`src/main/ipc/index.ts`、`tests/shared-contract.test.ts`、`tests/config-store.test.ts`、`tests/ipc-config.test.ts`、`tests/peek-ipc.test.ts`、`tests/helpers/electron-stub.ts` | T1、T3 | §10.3 全部；既有冻结值不变；全量测试无回归 |
| **T5 `peek-renderer-reaction`** | agent-D | `src/renderer/src/reactions/peek.ts`、`tests/peek-reactions.test.ts` | T1（契约） | §10.4 前两项；`git diff` 不含 `wave2-contract`/`pet-runtime`/`main.ts` |
| **T6（延后，W-B 同批）** `peek-settings-ux` | agent-E | `src/renderer/src/settings/peek-model.ts`、`src/renderer/settings.html`、`src/renderer/src/settings/main.ts` + 测试 | T4、T5 | §10.4 后两项 + 文案评审 |

**并行建议**：T1 先行（半天内先落类型，其他人即可开工）；T2 与 T1 后半段可并行；T3 依赖 T1/T2 契约落定；T5 只依赖 T1，可与 T3/T4 并行。T4 与其它任务**禁止并行写同一文件**，且应在工作树干净时一次提交。

**实现方禁止事项**：不实现采集（不截图/不 OCR/不读标题/不 spawn 采集 helper）；不申请 TCC；不改 `native/winlist`；不扩 `PetMood`/`ExternalReaction`；不改 `bridge-schema.ts`；不新增依赖；不跑 `pnpm dev`/smoke 做验收（用 `pnpm typecheck` + `pnpm test`）；日志不写内容。

---

## 13. 开放问题（需 Lead 拍板）

| # | 问题 | 推荐 | 影响 |
|---|---|---|---|
| Q1 | 是否批准 S2 冻结追加批次？范围用 19 invoke + 5 events（省略 `peek-status-changed`）还是 19 invoke + 6 events？ | 批准；建议 **+6**（macOS 15 权限月度复核需要状态推送） | S2 全部；冻结测试期望集合 |
| Q2 | `peek` 配置放 `PetConfig`（推荐）还是独立 `peek-settings.json`（零 PetConfig 影响，但两套配置/两套默认/设置页分裂）？ | **放 PetConfig** + 修 `config-store.copyConfig` 深拷贝 | S2 范围 |
| Q3 | 渲染层反应是否新增 `PetMood`？ | **不新增**：`PeekReaction` + 官方台词池 + 可选 `poseHint`，Lead 在 W-B 接入 `main.ts` 现有气泡路径 | 避免 C 级语义变更 |
| Q4 | 接口阶段设置页显示禁用占位还是隐藏？ | **隐藏**；W-B 能力落地时开关/回看/权限引导同批上线 | S3-2 排期 |
| Q5 | DSH 双向扩展本轮只写契约（推荐）还是也落文件读写？ | 只写契约（`peek-bridge.ts` + 测试）；文件读写属 W-B/W-C，且 DSH 插件侧需新版本 | T2 范围 |
| Q6 | P0 元数据未来默认开还是显式开？ | 接口阶段不预设；建议直到 consent/设置 UI 完成前都**显式开启**，之后再评估是否默认开 | W-B 产品决策 |
| Q7 | 参数是否接受本设计默认值（`interval 120s`/`minIdle 45s`/`maxPerHour 3`/`minGap 600s`/退避 3 次 30s 起）？ | 接受；可后续在配置里调 | S0 默认值 |
| Q8 | 通道/配置命名是否接受 `pet:peek-*` / `peek` 组 / `screen.peek.*` capability？ | 接受 | S2 冻结批次命名 |

---

## 14. 证据清单

**本仓（读取；本轮未修改）**

| 文件 | 关键位置 | 用途 |
|---|---|---|
| `src/shared/ipc.ts` | `:23-48`（14 invoke）、`:51-57`（4 events）、`:116-141`（PetApi） | 冻结面 |
| `tests/shared-contract.test.ts` | `:14-42`、`:54-63`、`:83-111`、`:124-149` | 冻结断言（S2 需追加） |
| `src/shared/types.ts` | `:49-65`（PET_MOODS）、`:89-135`（PetConfig）、`:162-166`（AccessibilityStatus） | 冻结配置/权限类型 |
| `src/shared/config.ts` | `:22`（CONFIG_VERSION）、`:36-53`（DEFAULT_CONFIG）、`:184-198`（可选键回填模式） | 配置扩展方式 |
| `src/shared/bridge-schema.ts` | `:23-42`（文件/上限）、`:105-131`（payload 白名单）、`:230-249`（零信任解析） | DSH 扩展点参考 |
| `src/main/config-store.ts` | `:63-65`（浅拷贝注释）、`:160-172`（版本/回退）、`:189-198`（toConfigPartial） | 嵌套 config 注意点 |
| `src/main/ipc/window.ts` | `:42-43`（深链常量）、`:177-194`（只查询+深链模式） | TCC 接口模板 |
| `src/main/ipc/desktop.ts` | `:40`、`:56-142` | P0 数据源/轮询模式 |
| `src/main/desktop/dsh-watch.ts` | `:1-28`、`:85-140` | 文件桥尾随模式 |
| `src/renderer/src/reactions/dsh.ts` | 全文（tracker/去重/TTL 模式） | reaction tracker 模板 |
| `src/renderer/src/core/wave2-contract.ts` | `:177-187`（ExternalReaction）、`:201-246`（BehaviorInput） | 反应契约边界 |
| `src/renderer/src/core/pet-runtime.ts` | `:772`、`:791-793`、`:818` | 外部反应单点注入 |
| `src/renderer/src/core/voicelines.ts` | `:36`、`:193-250` | 官方台词单一来源 |
| `src/renderer/src/main.ts` | `:1363-1408`（事件订阅）、`:1395-1402`（DSH 接线同构位置） | 未来 peek-event 接线点 |
| `src/renderer/src/settings/settings-model.ts` | `:286-318`（权限文案） | 设置模型模式 |
| `src/renderer/settings.html` | `:185-195`（权限区） | 未来设置入口位置 |
| `native/winlist/README.md` | `:8-15`、`:100-106` | 无标题/无权限边界 |
| `scripts/build-native.mjs` | `:9-11`、`:113-117` | 未来 helper target 模板 |
| `docs/packaging.md` | `:86-101`（§3 TCC 红线）、`:18-60`（打包前置） | 采集实现时的红线 |
| `docs/known-issues.md` | `:29-43`（R-21 占位、R-25 诚实的 unknown） | 占位契约与权限诚实原则 |
| `tests/helpers/electron-stub.ts` | `:412-430`（ipcMain）、`:558-590`（shell/systemPreferences） | S2 测试基建（需补 `getMediaAccessStatus`） |
| `node_modules/electron/electron.d.ts` | `:14746`（askForMediaAccess 仅 mic/camera）、`:14806`（getMediaAccessStatus 含 screen/5 值） | TCC 接口事实 |

**可行性报告章节引用**：§0（决策）、§2.1/§2.7（darkitten/Miru 闸门与退避）、§4.1（分层）、§4.2（管线/状态/兴趣）、§4.3（七条不变量）、§4.4（规则语法）、§4.7（文件级接线）、§4.8（权限降级矩阵）、§5（配置草案）、§6（分期/验收）、§7（风险）。

**未验证 / 未知（不写死结论）**

- 真机 TCC 在未签名/ad-hoc 构建下的表现（`docs/packaging.md` §4：打包版完全未验证）。
- macOS 15 每月复核的实际提示时序（`inferred`，以真机 W-C 验收为准）。
- 单窗口 SCK/CGWindowListCreateImage 在不同 Space/最小化下的可用性（可行性报告 §7 标中风险）。
- DSH 0.2.2-rc.1 客户端是否愿意/能够新增 `peek-requests.jsonl` 读写（需与 R2 报告交叉确认）。
