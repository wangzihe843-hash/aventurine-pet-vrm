# 屏幕感知 / 隐私保护 / 聚焦模式 —— 项目内架构复核与修正版集成方案

> 日期：2026-11-11
> 复核对象：`docs/research/screen-awareness-privacy-focus-feasibility-2026-11-11.md`（豆包报告，621 行；其自称基线 `main@3893943`）
> 复核基线：**HEAD `4a2d8b3`**（比豆包基线前进 **24 个提交**；工作树另有另一会话的未跟踪文件，未触碰）
> 关联已有设计：`docs/research/peek-interface-audit-2026-11-11.md`（R4，1572 行，A7 的设计依据）+ `docs/peek-interface.md`（A7 已落地契约说明）
> 范围：**只读复核 + 本文件**；不改任何代码、不跑 build/package/全量测试。
> 结论一句话：豆包报告的**外部项目调研与产品结构有参考价值**，但其“项目内集成方案”（§4.7/§5/§6）在 HEAD 上**不可直接实施**——它既没有看到已落地的 A7 peek 契约，也违反对台词、配置存储、反应通道、权限与网络现状的硬约束。修正后的可行路径见 §9。

---

## 0. 总裁定（TL;DR）

| 维度 | 裁定 |
|---|---|
| 调研价值 | **有**：外部项目对比、闸门顺序、隐私产品结构、节奏参数可借鉴 |
| 项目内可行性 | **部分可行、但需重写集成层**：W-A（零权限聚焦）可行；W-B（P0 元数据互动）可行但要新增 A7 契约扩展 + 一批 IPC + 前台 app 探测；W-C（OCR）可行但依赖新 native helper + TCC 流程；**W-D（VLM）当前不具备任何基础设施** |
| 与 A7 契约的关系 | 豆包完全没提 A7。**必须扩展 `src/shared/peek.ts`，禁止另起 `src/shared/screen.ts` 并行契约**（否则两套 fail-closed 闸门/权限模型并存，直接违约） |
| 台词链路 | **自研台词 / 模型生成台词 / SKIP 输出过滤整条链路不成立**：`core/voicelines.ts` 111 条官方语音原文 + SHA-256 锁 + 用户硬性“禁止自创/改写/扩写”。可用表达 = 官方台词池（语义场景映射）+ 非语言反应（注视/姿态）+ 系统状态文本（非台词，如“思考中...”“专注 25:00”先例）+ DSH 自身转述文本（仅 DSH 自己的回复，不是宠物台词） |
| 配置方案 | 豆包“新增 `screen`/`focus` 嵌套配置组”**在现有 config-store 上会丢键**（§3.3 有实证链）。W-A/W-B 一律用**扁平可选原始键**（已有 `dshCoupling/dshBubbleSync` 先例），不 bump `CONFIG_VERSION`；嵌套组/规则编辑留到 Lead 评审的后续批次 |
| 反应通道 | 豆包“所有新能力通过现有 `ExternalReaction` 注入”**不成立**：`ExternalReaction.mood` 被 Lead-owned 冻结为 `dshBusy/dshDone/dshError` 三值。W-B 的合法替代：renderer `main.ts` 集成层（gaze 覆盖 + 官方台词气泡 + 可选活动触发），不改 `ExternalReaction`/`PET_MOODS`/`behavior-director` 内部 |
| 默认档位 | 豆包 §0/§4.8 的“**默认档位 = `ocr`**（已定决策）”与 A7 契约（默认全关）、`docs/packaging.md` §2.6/§4（ad-hoc 签名、TCC 身份不稳）冲突，且仓库内无该用户决策记录 → **必须回到用户决策**（§12-Q3） |
| 推荐范围 | W-A 3–4 人日、W-B 6–9 人日、W-C 8–12 人日、W-D 独立立项（不作为本季度承诺）。合计 P0–P2 17–25 人日（豆包 18–28 人日覆盖 P0–P3，**偏低**） |

**推荐执行顺序**：Lead 先拍 §12 的 4 个决策 + 批准 §3.10 的 A7 追加式扩展范围 → 落 W-A（零权限、可独立回滚）→ 再落 W-B（P0，单独 IPC/契约提交）→ W-C 视用户是否接受 TCC 权限而定。W-D 在明确“是否允许出网 + provider/密钥/成本”之前不排期。

---

## 1. 复核方法与基线漂移

### 1.1 豆包基线 → HEAD 的漂移（与本方案直接相关的部分）

`git log --oneline 3893943..HEAD` 共 **24 个提交**。影响本方案的是：

| commit | 变更 | 对豆包报告的影响 |
|---|---|---|
| `5012a30` | **feat(peek)：窥屏互动接口预留（契约/gate/stub，零采集）** | 落地 `src/shared/peek.ts`(448 行)、`docs/peek-interface.md`(226 行)、`src/main/peek/{service,stub-provider}.ts`、`tests/peek-{gate,service}.test.ts`(103 例)。豆包报告**完全未提**，其“另起 screen.ts”方案作废 |
| `2f49aa7` | feat(dsh)：强耦合生命周期 + 回复气泡同步 + 设置开关 | 新增 `PetConfig.dshCoupling/dshBubbleSync`（可选键先例）、`reactions/dsh-dialogue.ts`、设置页 3 个开关；给“DSH 转述文本”提供了**已有的显示通道** |
| `dfeb524` | feat(dsh-coupling)：兼容性安全 v2 | 与本方案无关，但占用了 `dsh-*` 模块名 |
| 其余（`f217521`、`6d3fa6b`、动画/比例 `25` 个左右） | DSH 退出耦合、动画姿态/脚锁/比例重定向 | 与本方案无交集；也是另一会话“模型比例/动作重定向”工作所在 |

其它漂移：
- `PetConfig` 当前 **16 个字段**（基线 14）：`src/shared/types.ts:90-151`；`DEFAULT_CONFIG` 同步 16 键（`src/shared/config.ts:36-57`）。
- IPC 面**没有变化**：仍为 14 invoke + 4 事件（`src/shared/ipc.ts:23-57`；`tests/shared-contract.test.ts:39-63,107-110`）。
- `src/renderer/src/core/wave2-contract.ts` 在 Wave3 有 **Lead-owned 追加先例**（`AnimationDebugSnapshot.footLock` 可选字段等，`git diff 3893943..HEAD -- src/renderer/src/core/wave2-contract.ts`）；但 `ExternalReaction`/`BehaviorConfigSubset` **未变**。
- 另有一份 R4 设计报告 `docs/research/peek-interface-audit-2026-11-11.md`（1572 行，A7 的完整设计）与 A7 同一天产出；豆包报告的证据章节没有它。

### 1.2 复核口径

- 每条结论给 `文件:行号`（HEAD 4a2d8b3）或可执行的命令证据；外部仓库声明无法在本工作区重放（外部 clone 未入库），凡涉及外部事实一律标 `uncertain`，不当作本项目实施依据。
- 判定：`confirmed`（在 HEAD 可复核为真）/ `refuted`（与 HEAD 不符）/ `uncertain`（无本地证据或需真机/外部验证）。
- 任务里说 §1 “15 行”，实际**数据行 14 行**（加表头 15 行）；下面逐行覆盖。

---

## 2. 豆包 §1 基线表逐行核对

| # | 豆包结论 | 判定 | HEAD 证据（file:line） | 更正 / 备注 |
|---|---|---|---|---|
| 1 | 透明 overlay / 置顶 / 全屏可见 已有 | **confirmed** | `src/main/windows/overlay-manager.ts:256-257` `setAlwaysOnTop(true,'screen-saver')`、`setVisibleOnAllWorkspaces(true,{visibleOnFullScreen:true})` | — |
| 2 | 点击穿透 + 悬停拦截 已有 | **confirmed** | `src/main/windows/mouse-gate.ts:18,63`（16ms 单帧门）+ `src/main/ipc/window.ts:159-165`（`pet:set-ignore-mouse` handler） | 豆包混写“mouse-gate.ts + ipc/window.ts”是准确的 |
| 3 | 窗口枚举 250ms 已有 | **confirmed** | `src/main/ipc/desktop.ts:40` `POLL_INTERVAL_MS = 250`；`src/main/desktop/winlist.ts` spwan helper；`native/winlist/main.swift` | — |
| 4 | 窗口标题 没有 | **confirmed** | `native/winlist/main.swift:5-8`（明确“不读取标题；标题才需要录屏权限”）；`docs/packaging.md:197-205` TCC 红线 | 补充：P0 也**没有前台 app 字段**（见 M9），比豆包说的更缺 |
| 5 | 屏幕录制权限 没有 | **confirmed** | 全仓 `grep getMediaAccessStatus` 仅 `src/shared/peek.ts:60` 注释；无 `desktopCapturer`/`capturePage` 调用点 | A7 也刻意不接线（`docs/peek-interface.md:19-25`） |
| 6 | 行为状态机 / 自主活动 已有 | **confirmed** | `src/renderer/src/behavior/behavior-director.ts:642,1344`（`if (!frame.config.autonomous)`）；契约在 `wave2-contract.ts:193-230` | — |
| 7 | 外部反应注入 已有 | **confirmed（但通道受限）** | `src/main/desktop/dsh-watch.ts:10,604`；`src/renderer/src/reactions/dsh.ts:119,283-294`；`reactions/dsh-dialogue.ts`；`wave2-contract.ts:177-187` | 豆包把它当成“任意新反应可注入”，**错**：mood 只有 DSH 三值（M11） |
| 8 | 气泡 / 台词 已有 | **confirmed（但约束被完全忽略）** | `src/renderer/src/core/bubble.ts:22`；`core/voicelines.ts:1-33,36-151,176-177`；`behavior/dialogue.ts:23-61`；`main.ts:944-959` | 台词是 111 条官方原文 + SHA-256 锁（`tests/voicelines.test.ts:175`），豆包“自研/模型生成/SKIP”链路不成立（M4） |
| 9 | 配置持久化：版本不符回退/未知键丢弃/新增可选键回填 | **confirmed** | `src/shared/config.ts:22`（`CONFIG_VERSION=1`）、`:150-206`（逐键白名单）；`src/main/config-store.ts:160-172,189-198,217-224` | 补充：这是**扁平原始键**语义；嵌套组会丢键（§3.3） |
| 10 | 透明度 `setOpacity` 只改 canvas CSS | **confirmed** | `src/renderer/src/scene/pet-scene.ts:326-331`；`src/renderer/src/vrm/pet-scene-vrm.ts:453-458` | 注释明确“不影响命中/坐标”，可安全用作聚焦模式表现 |
| 11 | FPS 上限 FrameRateController | **confirmed** | `src/renderer/src/scene/fps-limiter.ts:31`；`pet-scene.ts:316-319`；`vrm/pet-scene-vrm.ts:445-448` | — |
| 12 | 空闲时长 没有（`CGEventSource…` 未调用） | **confirmed（但方案过时）** | 全仓无 idle 探测；但 Electron 44 内置 `powerMonitor.getSystemIdleTime()/getSystemIdleState()/onBatteryPower`：`node_modules/electron/electron.d.ts:11580,11586,11599` | 豆包 §2.7 用 `ioreg` 是**绕路**：Electron 零权限 API 即可，无需 ioreg/CGEventSource、无需 native helper（M6） |
| 13 | 麦克风占用 没有（无 CoreAudio 调用点） | **confirmed** | 全仓无 CoreAudio / `kAudioDeviceProperty*`；Electron 只有**权限查询** `getMediaAccessStatus('microphone')`（`electron.d.ts:14806`），无“占用中”API | 豆包 §4.1 却把麦克风占用列为 **P0 零权限、~0 成本**，遗漏“必须新增 native CoreAudio helper”这一依赖（M7） |
| 14 | 系统 Focus / DND 没有且无公开 API | **confirmed** | 全仓无；macOS 无公开 API（读 `~/Library/DoNotDisturb` 需完全磁盘访问） | `getSystemIdleState` 的 `'locked'` 只是锁屏，不是 DND（别混用） |
| — | 基线判断“完全不知道用户在不在、在不在开会” | **refuted（部分）** | 用户“在不在”= powerMonitor 空闲秒（零权限，只是没接线）；“开不开会”缺信号成立（无麦克风 API） | 修正为：“不知内容、无前台 app 字段；空闲/电源可零权限获取但未实现” |

**外部仓库部分（豆包 §2/§3/§8）**：`refs/Mate-Engine/Assets/MATE ENGINE - Scripts/Tools/DesktopAmbientProbe.cs` 在本地 refs 中**存在**（本次已核实路径），其余外部仓库不在工作区，`git clone` 证据无法复放 → 对 darkitten/N.E.K.O/LingChat/Miru/screenpipe/BongoCat/VPet 的具体行号与参数一律 `uncertain`，只能作为设计灵感，不能作为本项目参数依据。

---

## 3. 冻结契约盘点与“最小合法改法”

### 3.1 冻结面总表

| 冻结对象 | 冻结内容 | 证据 | 新增能力的最小合法改法 |
|---|---|---|---|
| IPC invoke 通道 | **恰好 14 个**，名称/值 `toEqual` 冻结 | `src/shared/ipc.ts:23-48`；`tests/shared-contract.test.ts:14-29,39-42` | **追加**新键到末尾 + 同步 6 处（§3.2）；需 Lead 评审 |
| IPC 事件通道 | **恰好 4 个** | `src/shared/ipc.ts:51-57`；`tests/shared-contract.test.ts:31-36,54-63` | 追加事件（如 `peek-state`）；同步 `IpcEventMap`/`PetApi`/测试 |
| `PetApi` 类型面 | 键集合编译期精确断言 = 14+4 | `src/shared/ipc.ts:116-141`；`tests/shared-contract.test.ts:83-111` | 追加方法；`src/preload/index.d.ts` 用 `PetApi` 类型派生，**无需改** |
| `PetConfig`/`DEFAULT_CONFIG` | 当前 16 字段 + 默认值逐字段断言 | `src/shared/types.ts:90-151`；`src/shared/config.ts:36-57`；`tests/shared-contract.test.ts:115-152` | 追加**可选扁平原始键** + 同步测试；不 bump `CONFIG_VERSION` |
| `CONFIG_VERSION` | `1`；版本不符 → 整份回退默认 | `src/shared/config.ts:22`；`src/main/config-store.ts:160-165` | 不 bump；靠 `sanitizeConfig` 缺省回填（`dshCoupling` 先例 `config.ts:179-180`） |
| `sanitizeConfig` 语义 | 逐键白名单、未知键丢弃、只读自有属性 | `src/shared/config.ts:140-206`；`tests/shared-contract.test.ts:241-252,264-287` | 新增键必须显式加 `readBoolean/readClampedNumber/readEnum` 分支；不改语义 |
| `PET_MOODS` | 12 值冻结，增改需 Lead 评审 | `src/shared/types.ts:43-65` | W-A/W-B **不加 mood**；用现有 idle/sit 等 + gaze 覆盖 |
| `ExternalReaction.mood` | 只允许 `dshBusy/dshDone/dshError` | `src/renderer/src/core/wave2-contract.ts:177-187` | **不得**用它承载屏幕反应；见 M11 替代路径 |
| `BehaviorConfigSubset` | 仅 `autonomous/autonomousLevel/mischief/dshLink` 4 键 | `wave2-contract.ts:193-199` | 不改契约：在 `main.ts` 用**组合后的 PetConfig**调用 `runtime.setConfig`（§3.6） |
| `wave2-contract.ts` 全文件 | Lead-owned，除 Lead 外禁改 | `wave2-contract.ts:1-18` | 任何需要改它的方案都升级为 Lead 决策项 |
| preload 白名单 | 不暴露 `ipcRenderer`/`electron` | `src/preload/index.ts:1-12` | 只做 `PetApi` 纯转发 |
| A7 peek 契约 | capability 顺序/档位/拒绝原因/状态/gate/stub | `src/shared/peek.ts` 全文；`docs/peek-interface.md:19-25` | **扩展而非另起**（§3.10） |

### 3.2 新增一个 IPC 必须同步的文件（缺一个就编译或契约测试失败）

1. `src/shared/ipc.ts`：`IPC` 或 `IPC_EVENTS` 常量、`IpcInvokeMap`/`IpcEventMap`、`PetApi` 方法（3 处，同文件）。
2. `src/preload/index.ts`：`petApi` 对象里的转发实现（`invoke(IPC.xxx)` / `subscribe(IPC_EVENTS.xxx)`）。
3. `src/main/ipc/<领域>.ts`：`ipcMain.handle(...)`（或 `webContents.send` 广播方）；**同一 channel 不可重复注册**（`src/main/ipc/index.ts:8-10` 注释）。
4. `src/main/ipc/index.ts`：把新 registrar 加进 `registerIpcHandlers`（Lead-owned 集成骨架）。
5. `src/main/index.ts`：若需创建/销毁 service 或 `will-quit` 清理（Lead-owned；`registerIpcHandlers` 调用点在 `src/main/index.ts:2613`）。
6. `tests/shared-contract.test.ts`：`EXPECTED_IPC`(14)、`EXPECTED_IPC_EVENTS`(4)、`Object.keys(IPC).toHaveLength(14)`、`PetApi` 键集合精确断言（:86-105）全部同步，否则首跑即红。
7. 消费方：`src/renderer/src/main.ts`（overlay）/ `src/renderer/src/settings/main.ts`（设置页）——新事件/新 invoke 的接线点在 Lead 集成层。

> `src/preload/index.d.ts` 只引用 `PetApi` 类型（11 行），追加方法后自动生效，**不用改**；`src/renderer/src/env.d.ts` 不重复声明 `window.api`。

### 3.3 配置契约：为什么豆包的“嵌套 `screen`/`focus` 组”不能照用

现有 `config-store` 的三个事实（必须读代码确认，已确认）：

1. **写入是浅合并 + 全量 sanitize**：`set(partial)` = `sanitizeConfig({ ...current, ...partial })`（`src/main/config-store.ts:217-224`）。
2. **`sanitizeConfig` 只回填它显式读的顶层键**（`src/shared/config.ts:150-206`），没有嵌套记录读取器（无“嵌套组先例”：`dshCoupling/dshBubbleSync` 全是扁平原始键，`config.ts:178-180`）。
3. **读取是浅拷贝**：`copyConfig = { ...config }`，注释明确写“未来若加嵌套字段必须改成真正的深拷贝”（`src/main/config-store.ts:59-65`）；`toConfigPartial` 只接受与 `DEFAULT_CONFIG` 同名的**顶层**键（`:189-198`）。

推演（嵌套 `focus: { mode, minutes, opacity }`）：

```
current.focus = { mode:'quiet', minutes:50, opacity:0.55 }
用户只改 mode：setConfig({ focus: { mode:'companion' } })
→ set: sanitizeConfig({...current, focus:{mode:'companion'}})
→ focus 组被整体替换；嵌套 sanitizer 对缺失的 minutes/opacity 回填 DEFAULT，
  而不是回填 current.focus.minutes/current.focus.opacity
→ 用户其它 focus 设置被静默重置（丢键）
```

因此：
- **W-A/W-B/W-C v1 一律用扁平可选原始键**（boolean/number/string），`sanitizeConfig` 逐键加分支，`CONFIG_VERSION` 不 bump，`config-store` 零改动——这正是 Wave3 `dshCoupling` 的既有先例，风险最低。
- 若未来确实需要嵌套组/规则数组（用户可编辑 deny 清单），需要一次**独立契约批次**：`copyConfig` 深拷贝、`set` 深合并语义定义、`toConfigPartial` 嵌套语义、`config-store.test.ts` 补“只改子键不丢其它子键”用例，并 Lead 评审。豆包 §5 的 JSON 草案不能直接落。

### 3.4 `src/shared/types.ts` 关键事实

- `PET_MOODS` 12 值冻结（`:49-65`），`PetMood` 从常量派生；新增 mood = 契约变更 + 动画覆盖层映射（B3）——W-A/W-B 不做。
- `WindowInfo`（`:33-41`）：`{id,pid,owner,layer,alpha,bounds,onScreen}`——**没有 active/frontmost 字段**；B5 依赖它做几何吸附。这直接决定 M9：P0“前台 app”不是现成字段。
- `DshEvent`/`DshStatus`（`:153-176`）：`DshEventType` 5 值、`DshStatus{online,running,lastEventAt,lastType}`——专注模式/隐私闸门可直接用 `getDshStatus()`（只表示 DSH 是否在线/忙，不含用户隐私）。
- `AccessibilityStatus`（`:178-182`）只有辅助功能 + 通知，**没有麦克风/录屏**状态；A7 的 `PeekStatus.permission` 是独立契约，不要混。

### 3.5 `wave2-contract.ts`（Lead-owned）关键事实

- `ExternalReaction`（`:177-187`）：`mood: Extract<PetMood,'dshBusy'|'dshDone'|'dshError'>`（三值封闭）、`bubble: string|null`、`durationMs`、`startedAtMs`。
- `BehaviorConfigSubset`（`:193-199`）：只有 `autonomous/autonomousLevel/mischief/dshLink`。
- `BehaviorInput`（`:201-230`）包含 `external` + `config: BehaviorConfigSubset` + 注入 RNG；`BehaviorDecision`（`:232-246`）包含 `mood/motion/facing/lookTarget/bubble/poseHint`。
- 结论：屏幕感知**不能新增 mood、不能新增外部反应类型**；只能在集成层消费/改写这些已有输出（§3.6）。

### 3.6 `behavior-director.ts` 注入点：不改内部能做到什么、做不到什么

**不修改 behavior-director 内部** 可实现的合法手段（按侵入从低到高）：

| 手段 | 做法 | 能实现 | 证据 |
|---|---|---|---|
| A. 组合配置 | `main.ts` 调 `runtime.setConfig({...config, autonomous:false, dshLink:false})`（只影响本次运行，不写盘）→ `pet-runtime.ts:626` `setConfig(PetConfig)` → `toBehaviorConfig`（`:101-111`） | 停自主活动/停随机漫游；`dshLink=false` 同时静默 DSH 反应与气泡 | `behavior-director.ts:1344,1085` |
| B. 气泡显示过滤 | `main.ts` 在 `bubble.show(...)` 前按 `decision.mood`/聚焦状态丢弃；`decide` 里气泡仍会生成，只是不显示 | 专注中停“主动说话”而保留摸头/戳等交互气泡；专注中 DSH 只表情不发言（按 mood ∈ dsh* 过滤） | `main.ts:944-959`；`main.ts:1391-1422` |
| C. 注视/朝向覆盖 | `main.ts:898` `writeAnimationInput` 写入前把 `animationInputScratch.lookTarget` 覆盖为“前台窗口方向”（窗口本地坐标），B3 look-at 直接用 | 屏幕感知的**非语言反应**：扭头看当前 app 窗口/焦点（无需 mood、无台词、无新契约） | `main.ts:898-917`；B3 `AnimationInput.lookTarget`（`wave2-contract.ts:265-286`） |
| D. 活动触发（可选、有风险） | `runtime.debugTriggerActivity(activityId, nowMs)` 已存在于调试面（`main.ts:419-420`）；`activities.ts` 有 `idleStretch/lookAround/idleGaze` 等 id | “写久了伸懒腰/四处看”等一次性表演 | `main.ts:419`；`behavior/activities.ts:27-150`。**用 debug API 做产品功能需 Lead 明确批准**（或后续把 `triggerActivity` 提升为正式 API） |

**做不到（不改内部/契约时）**：新增 `PetMood`（如 `focused`）、新增 `ExternalReaction` 类型、让自主活动支持“外部打断并恢复”语义、让 B1 感知 app/空闲状态做决策。这些都必须 Lead 评审契约。

豆包 §4.7 的“`behavior-director.ts` 增加 `quiet`/`focusActive`”属于 **Lead-owned 契约 + 内部改动**，不是“低侵入”；W-A 用 A+B+C 组合即可，不必动它。

### 3.7 `src/renderer/src/main.ts` 接线点（Lead 集成层，新增能力都从这里进）

| 接线点 | 位置 | 用途 |
|---|---|---|
| `applyConfig` / `subscribeEvents.onConfigChanged` | `main.ts:1103-1119,1391-1394` | 配置热更新；可派生“有效表现”（聚焦时覆盖 opacity/fps，不写盘） |
| `ensureScene` | `main.ts:551-555` | `scene.setFpsCap/setOpacity` 初始值 |
| 每帧输出 | `main.ts:1302-1340`（`runtime.frame`→ `applyRuntimeOutput`） | 读 `output.decision.mood/lookTarget/bubble` 做过滤/覆盖 |
| 气泡显示 | `main.ts:944-959` | `bubble.show/hide`；专注过滤、peek 台词、计时状态文本都走这里 |
| DSH 事件 | `main.ts:1417-1422` | `runtime.pushDshEvent` + `dshDialogue.pushEvent`（`dshBubbleSync` 控制） |
| 交互/菜单 | `main.ts:646-652,1200+` | 右键菜单动作（`toggleAutonomous` 先例）；新增聚焦入口需注意 `InteractionEvent.menuAction` 是冻结类型 |
| 场景容量 | `main.ts:533-535,1107-1108` | `opacity/fpsCap` 有效值合成 |
| 窗口/显示器 | `main.ts:619-640,1400-1414` | 已订阅 `windows-updated`/`screens-updated`；全屏/前台窗口判定可直接用 |
| 调试面 | `main.ts:378-430`；`debug.ts` | 冒烟/实机验收断言（可加 `focus`/`peek` 只读快照） |

### 3.8 气泡与台词（硬约束下的表达通道）

- **宠物台词（第一人称砂金）**：唯一来源 `core/voicelines.ts` 的 111 条官方原文（基础 58 + 戏浪 53），SHA-256 锁 `:176-177`，测试 `tests/voicelines.test.ts:175`；场景池 `:193-237`；选词/冷却在 `behavior/dialogue.ts:109`（`BubbleGate`：全局 60s / 同类 120s / 同句 300s）。
- **系统状态文本（非台词，已有先例）**：`reactions/dsh-dialogue.ts:44` `THINKING_TEXT='思考中...'`；DSH `assistant/message` 文本经 `cleanAssistantText`（`:155`）显示。这是“状态/转述”通道，**不是**砂金在说话。
- **DSH 转述文本**：可显示 DSH 自己生成的回复（`dshBubbleSync`，`PetConfig.dshBubbleSync`），但**前提是 DSH 自己产出了该文本**。宠物端把屏幕内容喂给 DSH 目前**没有通道**（桥契约是 DSH→宠物单向；`src/shared/bridge-schema.ts` 无 pet→DSH 屏幕 payload），属于新产品决策。
- 因此“屏幕感知/专注模式的表达”可行方案只有三类：① 官方台词池的**语义场景映射**（见下表）；② **非语言**反应（gaze/姿态/淡出/计时条）；③ 系统状态文本（专注倒计时、“专注中”等，不是台词）。任何“内容级描述/复述”必须另开文本源（用户决策）。

官方池→新场景的可行映射（推荐，`isOfficialVoiceLine` 兜底校验）：

| 新场景 | 可用官方池 | 语义贴合度 | 说明 |
|---|---|---|---|
| 专注开始 | `BUSY_BUBBLES`（战技/秘技/战斗开始）或 `SUCCESS_BUBBLES` | 中 | “准备下注/全押了”与“进入专注”人格一致 |
| 专注结束（自然完成） | `SUCCESS_BUBBLES`（开启战利品/终结技/晋阶/满级/行迹） | 高 | 与 DSH `task/end` 同一情感语义 |
| 专注提前停止 | `DEFEAT_BUBBLES`（无法战斗） | 低（略负面） | 建议改静默 + 非语言反应，避免“失败”暗示 |
| 离开很久回来/问候 | `GREETING_BUBBLES` | 高 | 与 hover 现有用途一致 |
| 屏幕观察类“注意到你” | `IDLE_BUBBLES` 的 `见闻/闲谈` | 低-中 | 只能表达“砂金随口一句”，不能说“你在写代码” |
| 连续工作提醒休息 | **无对应官方分类** | — | 不能自创“该休息了”；只能官方池随机 + 非语言（伸懒腰/看过来），或用户另行决策 |
| 通话/全屏静音 | 无台词（静默） | 高 | 最安全 |

### 3.9 设置页扩展方式与配置广播链

- 设置页是独立渲染进程页面：`src/renderer/settings.html`（分区：外观 `:40`、行为 `:84`、DSH 联动 `:127`、显示与系统 `:172`），纯逻辑 `settings/settings-model.ts`（`SettingsFormState:17-37`、`formStateFromConfig:135`、`patchForField:161`、`defaultsPatch:192`），DOM 绑定 `settings/main.ts`（`SettingsElements:47-75`、`collectElements:106`、控件绑定 `:351-390`）。扩展 = ① html 加 section/控件 id；② settings-model 加表单字段 + clamp + patch；③ settings/main 抓元素 + 绑定；④ `tests/settings-model.test.ts` 加用例（已有 `dshCoupling/dshBubbleSync` 先例，`tests/settings-model.test.ts:115-129`）。
- 广播链：`pet:set-config`（`src/main/ipc/config.ts:126-145`）→ `store.set` → `ctx.broadcast('config-changed', next)`（`app-context.ts:118-125`，广播目标含 overlay + 设置窗，`registerBroadcastTarget`）→ overlay `applyConfig`（`main.ts:1391`）与设置窗 `onConfigChanged` 双端热更。**专注/peek 的持久偏好直接复用这条链，不新增事件**。

### 3.10 A7 peek 契约现状与缺口（扩展清单）

**已存在**（A7，`5012a30`）：`src/shared/peek.ts` + `src/main/peek/{service,stub-provider}.ts` + 103 例测试 + `docs/peek-interface.md` + `docs/research/peek-interface-audit-2026-11-11.md`（R4 完整设计，1572 行）。

| A7 现状 | 证据 | 对本方案的缺口 |
|---|---|---|
| capability = `metadata/ocr/vision`（顺序冻结，测试锚定） | `peek.ts:22-28`；`tests/peek-gate.test.ts:72-80` | P1 氛围不在集内；R4 原设计有 `title/ambient`，A7 按 Lead §8 砍掉（`docs/peek-interface.md:218-226`）。**W-B 不需要新增 capability**（只用 metadata）；ambient 要单独追加评审 |
| tier = `off/metadata/ocr/vision` | `peek.ts:30-41` | 同上；若加 ambient 需同步 `PEEK_CAPABILITY_TIER` 与测试 |
| gate 的第 4 步：`status.permission !== 'granted'` → 拒绝**所有** capability | `peek.ts:428-430` | **这是 P0 的硬阻塞 bug**：metadata 是零权限（`docs/peek-interface.md:33`），当前 gate 却要求录屏授权。接 P0 provider 前必须改为**按 capability 判定权限**（`PEEK_CAPABILITY_PERMISSION` 映射；metadata=`none`，ocr/vision=`screen-recording`），并补测试 |
| gate 第 7 步 throttle 是**全局单策略**（minGap 600s / 每小时 3） | `peek.ts:384-392,440-442` | 这是“内容观察”预算；P0 元数据反应是事件驱动（秒级状态变化），不能套 10 分钟最小间隔。需要**按 capability 的 throttle**（或 metadata 走独立轻量判定） |
| `PeekObservationRequest` 只有 `foregroundApp`，无 title；注释明确 gate 不做“未知即拒绝” | `peek.ts:170-181` | 规则引擎（allow/unknown/title）无法表达；W-B 需要可选 `rules` + 标题字段（P0 恒 null） |
| deny reason 7 种 | `peek.ts:82-98` | 缺 `paused`、`rule-denied`、`window-unavailable`、`backoff`、`quiet-hours`、`focus-mode` 等；W-B 至少追加 `paused`（暂停）与 `rule-denied` |
| `PeekStatus.notImplemented=true` 时 gate 第 3 步直接拒 | `peek.ts:283-294,425-427` | 接 P0 provider 后置 `false`，并把 ocr/vision 置 `available:false, reason:'capability-unavailable'`（顺序不能反：not-implemented 在 permission 之前） |
| 内容（text/vision）**不过 IPC、不落盘、不进日志** | `peek.ts:255-257`；`docs/peek-interface.md:90,122-124` | 豆包 §4.7 的 `pet:screen-observe-now` 返回 observation、§4.3“回看脱敏文本” **直接违反**该边界；手动观察 IPC 只能返回元数据/摘要 |
| provider 接口：`observe()` 只收已过 gate 的请求；永不抛 | `peek.ts:250-266` | P0 provider 必须遵守；P2 采集 helper 不能进 `src/main/peek/**` 静态扫描范围（`tests/peek-service.test.ts:280-300` 只扫 3 个文件） |
| 默认全关、深冻结 | `peek.ts:283-294` | 与豆包“P0 默认开/默认 ocr”冲突（§12-Q3） |

**A7 最小合法扩展（W-B 前必须做，追加式）**：

1. `PEEK_DENY_REASONS` **末尾追加** `'paused'`、`'rule-denied'`（保序追加，既有 7 值不动；`peek.ts:82-98`）。
2. 新增 `PEEK_CAPABILITY_PERMISSION`（新导出常量）：`metadata:'none'`、`ocr/vision:'screen-recording'`；gate 第 4 步只对需要录屏的 capability 生效；`tests/peek-gate.test.ts:191-196,233` 更新。
3. `PeekStatus` 追加**可选** `rules?: PeekRuleSet`、`paused?: boolean`（可选 → 旧测试的 `makeStatus` 不用全改；`isValidStatus` 增加可选校验；`PEEK_DEFAULT_STATUS` 加 `paused:false`）。
4. `PeekObservationRequest` 追加可选 `foregroundTitle?: string | null`（P0 provider 恒 `null`；title 能力另评审）。
5. `PeekObservationPayload['metadata']` 追加**可选**字段：`idleSeconds?`、`onBattery?`、`fullscreen?: boolean`、`foregroundWindowId?: number|null`、`dshOnline?: boolean`（追加不破坏旧消费方）。
6. gate 接入 rules：deny app（子串匹配，复用 `matchesSensitiveApp` 思路）→ `rule-denied`；allowlist 非空且未命中 → `rule-denied`；`unknownAppPolicy==='deny'` 且 app 为 null/空 → `rule-denied`；**title 规则在 `foregroundTitle===null` 时对内容级 fail-closed**（`rule-denied`，或 W-B 只允许 app 规则则直接不支持 title）。
7. 测试同步：`tests/peek-gate.test.ts`（capability 权限、rules、pause、默认状态）、`tests/peek-service.test.ts`（静态扫描仍应通过：provider 放 `src/main/peek/provider-p0.ts` 但**不要**加入被扫描列表，或把 powerMonitor/窗口依赖做成注入，扫描列表保持原 3 个文件）。
8. `docs/peek-interface.md` 同步：P0 接线步骤、权限按 capability、throttle 分域、内容不过 IPC 的红线。

> 明确**不做**：`screen.peek.title`（读标题 = 新的隐私红线，见 M8）、`screen.peek.ambient`（W-B 不需要，留到用户确认 P1 再追加，追加时按 R4 顺序插在 metadata 之后需同步 `PEEK_TIERS`/映射/测试）。

---

## 4. 关键错误与遗漏修正（M1–M18）

### M1 未提 A7 peek 契约，另起 `screen.ts` 并行契约（严重）
豆包 §4.7 新增 `src/shared/screen-observer.ts` / `src/renderer/src/reactions/screen.ts` / `src/main/ipc/screen.ts`，完全不提 `src/shared/peek.ts`、`docs/peek-interface.md`、`docs/research/peek-interface-audit-2026-11-11.md`。
**修正**：以 A7 为唯一契约根，按 §3.10 追加式扩展；主进程编排放 `src/main/peek/`，IPC 用 `pet:peek-*` 命名；`docs/peek-interface.md` 作为接线文档更新。并行契约会让“fail-closed 单点”变成两点，冻结评审也不会通过。

### M2 IPC 设计违反 A7“内容不过 IPC”边界（严重）
豆包 §4.7 `pet:screen-observe-now` / `pet:screen-observations` 返回 observation，§4.3-7 面板回看含“是否发送、字节数”；但 A7 契约明确 text/vision **永不过 IPC**（`peek.ts:212-214,255-257`；`docs/peek-interface.md:90`）。
**修正**：手动观察 IPC 返回**摘要**（`{ok, tier, reason, atMs, redaction, contentChars, providerId}`，无原文）；透明面板 v1 只回看**元数据**（时间/app 类别/事件类型/是否发言/拒绝原因）；如需“回看脱敏文本”，必须用户决策 + A7 契约变更（新增显式 `allowContentOverIpc` 之类的风险开关），默认不做。

### M3 嵌套配置组在现有 config-store 会丢键（严重）
见 §3.3 推演。
**修正**：W-A/W-B/W-C v1 用扁平原始键；嵌套组/用户可编辑规则清单作为独立契约批次（`config-store.test.ts` 补深拷贝/深合并用例）。

### M4 “自研台词 / 模型生成台词 / SKIP 输出过滤 / 绝不使用的措辞”整条链路不成立（严重）
豆包 §2.1/§4.3/§4.5/§6（“自研”“模型生成台词”“SKIP 输出过滤”“绝不使用的措辞”）。项目硬约束：`core/voicelines.ts:1-33`（**禁止自创/改写/扩写**）+ 111 条原文 SHA-256 锁（`:176-177`）+ `isOfficialVoiceLine` 测试锚点（`tests/voicelines.test.ts:140-143`；`tests/behavior-director.test.ts:1161`；`tests/dsh-reactions.test.ts:252`）。
**修正**：
- 删除“SKIP 输出过滤器 / 敏感词输出过滤 / 措辞黑名单”整条链路——宠物台词是固定官方原文，不可能复述屏幕内容；**DSH 转述文本**的过滤属于 DSH 侧产品（不是宠物台词链路）。
- 表达可行方案 = 官方池语义映射（§3.8 表）+ 非语言反应 + 系统状态文本；任何“屏幕内容级描述”必须用户另行决策新增文本源（官方新台词？DSH 转述？），见 §12-Q1。
- `lastComment` 字段（豆包 §5）冗余：已有 `BubbleGate` 全局/同类/同句冷却（`behavior/dialogue.ts:17-19,109`）。

### M5 P3 VLM 无任何基础设施；与“低侵入”矛盾（严重）
全仓确认：`package.json` 运行时依赖只有 `@electron-toolkit/utils`；无 LLM/VLM SDK、无 HTTP 客户端、无 API key/密钥存储（`grep safeStorage/keytar` 零命中）；renderer 生产网络被 `src/main/security/renderer-network-guard.ts:31,100` 主动取消；`fetch` 仅用于 `pet-asset://` 素材（`src/renderer/src/vrm/avatar-loader.ts:583` 等）。
**修正**：P3 需要新基础设施：provider 配置与**密钥存储**（Electron `safeStorage` 或 keychain——项目当前均未接入）、主进程 HTTP 客户端与超时/重试/出口审计、consent sheet（图像预览）、成本计量、网络故障降级、隐私政策。豆包 §6 W-D 的 5–8 人日**明显低估**，且与 §4.7“低侵入、可独立回滚”矛盾。建议 W-D 独立立项，本季度不做（§12-Q2）。

### M6 空闲探测遗漏 Electron 内置 API（重要）
豆包 §2.7 用 `ioreg -c IOHIDSystem` 读 `HIDIdleTime`，§4.2 说 idle poll 5s，未提 Electron `powerMonitor`；实际 Electron 44 内置 `powerMonitor.getSystemIdleTime()`（秒，零权限）、`getSystemIdleState(threshold)`（active/idle/locked/unknown）、`powerMonitor.onBatteryPower`/`on('lock-screen'|'unlock-screen'|'suspend'|'resume')`（`node_modules/electron/electron.d.ts:11580,11586,11599`）。
**修正**：W-B 在主进程用 `powerMonitor` 即可，零 native helper、零 TCC、零 ioreg；`'locked'` 可映射 AWAY，`suspend/resume` 可做“专注中断/恢复”的硬信号（W-A 也可用）。

### M7 麦克风占用不是 P0 零成本信号（重要）
豆包 §4.1 把“麦克风占用（仅布尔）”列入 P0“无权限、~0 成本”；§4.2/§4.3 用它判定 CALL。但 Electron **没有“占用中”API**（只有 `getMediaAccessStatus('microphone')` 权限查询，`electron.d.ts:14806`）；实现必须新增 native CoreAudio helper（`kAudioDevicePropertyDeviceIsRunningSomewhere`），涉及新 Swift 目标、universal 构建、打包 extraResources/package-check、签名顺序（`docs/packaging.md:2.2/2.3/2.6`）。
**修正**：W-B **砍掉麦克风占用**；CALL/会议检测降级为“前台 app ∈ 会议应用名单（Zoom/Teams/飞书/微信等）+ 可选全屏”，明确是启发式；真要读麦克风占用，作为 W-C 独立 native 能力单独评审（且只返回布尔，不读音频）。

### M8 窗口标题的权限路径与规则引擎在 P0 不可实施（重要）
豆包 §4.4 设计 `App::Title` 语法 + `denyTitleKeywords`，并把规则引擎当 P0 隐私闸门。实际：`native/winlist` 明确不读 `kCGWindowName`（`native/winlist/main.swift:5-8`），`docs/packaging.md:197-205` 规定“读窗口名/截图必须同步 entitlements+公证+降级+文档”红线；`CGWindowList` 的标题字段受 **Screen Recording** TCC 限制（与截图同一权限），AX 读标题则是**另一条 Accessibility 权限红线**（项目只在设置页查询 `isTrustedAccessibilityClient(false)`，`src/main/ipc/window.ts:168-171`，从未使用 AX API）。
**修正**：v1（P0/P1）规则引擎**只做 app 级**（denyApps/allowApps/unknownAppPolicy/denyMeetingApps）；`App::Title`、title 关键词、无痕识别全部推迟到 P2+（或需要新增 `screen.peek.title` capability + 用户明确授权标题读取）。豆包“P0 规则引擎带标题”不可实施。

### M9 “前台 app”不是现成字段，P0 成本被低估（重要）
豆包 §4.1/§4.2 说 P0 前台 app 来自 `WindowInfo.owner`、~0 成本。实际 `WindowInfo`（`src/shared/types.ts:33-41`）没有 active/frontmost；`winlist` 只输出按 z 序排列的窗口，`owner` 可重复、菜单栏/无窗应用不在列表；`native/winlist/main.swift:150-160` 记录 `.optionOnScreenOnly` 语义限制（其他 Space/最小化→从列表消失，不能当“关闭”）。
**最小合法实现**：主进程新增 `src/main/desktop/frontmost-app.ts`，用**系统自带 `lsappinfo`**（项目已有先例：`src/main/desktop/dsh-process.ts:10-15,331-333`、`dsh-version.ts:13`）轮询 `lsappinfo front` + `lsappinfo info -only pid,bundleid`（本机实测可用：返回 `pid = 69434`、`bundleID="com.google.Chrome"`），再与 winlist 缓存的 `pid→owner` 关联得到可读 app 名。零 TCC、零 native 变更、零冻结类型改动；1s 轮询成本可接受（winlist 已 250ms spawn）。备选：给 `WindowInfo` 追加可选 `active?: boolean`（冻结类型追加，Lead 评审）+ 改 Swift helper 读 `NSWorkspace.shared.frontmostApplication`。**不推荐** AX 路径（新权限红线）。

### M10 全屏判定语义没写清（重要）
豆包 §2.1 用“窗口 rect 与 monitor rect 误差 ≤2px”判全屏（Windows 经验），§4.2 依赖它做 GAME/自动静音。macOS 上：winlist 是 `.optionOnScreenOnly + .excludeDesktopElements`，返回**当前 Space** 的窗口；全屏应用在别的 Space 时列表里根本没有（但桌宠 `visibleOnFullScreen` 也跟随到那个 Space，切过去即可见）；`onScreen` 当前恒 true（`native/winlist/main.swift:153-154`）。判定应：`bounds ≈ display.bounds`（用窗口所在 display）且 layer 0 且非自身 overlay；多显示器分别判。**不要把“列表消失”当全屏/关闭**（A4-F08 已记录）。
**修正**：全屏检测写成纯函数 `isWindowFullscreen(window, displays)`（新 `src/shared/peek-activity.ts`），单测覆盖多屏/非 0 layer/亚像素；P0 的“游戏”判定无可靠信号，不要声称能识别 GAME（见 M13）。

### M11 “所有新能力通过现有 ExternalReaction 注入”不成立（严重）
豆包 §4.7 明写“观察 → ExternalReaction + 台词（复用 B7 的注入路径）”，§3 选型也写“不改渲染/动画主干”。但 `ExternalReaction.mood` 是 Lead-owned 冻结三值（`wave2-contract.ts:177-187`），且 `reactions/dsh.ts:35-45` 只产生 DSH 三 mood；`PET_MOODS` 12 值冻结（`types.ts:49-65`）。
**修正**：W-B 的屏幕反应分两层：① 非语言（推荐先做）= `main.ts` 的 gaze 覆盖（§3.6-C）± 经 Lead 批准的 `debugTriggerActivity`（§3.6-D）；② 语言 = `main.ts` 从官方池选文本后直接 `bubbleView.show`（自带 `BubbleGate` 冷却或简易冷却）。**都不改 `ExternalReaction`/`PET_MOODS`**。若产品一定要“屏幕专属 mood/反应类型”，那是一次 Lead 契约批次（`wave2-contract.ts` + B3 动画映射 + 测试），不塞进 W-B。

### M12 聚焦模式不能改 behavior-director 内部，也不能覆盖持久化 PetConfig（严重）
豆包 §4.7 改 `behavior-director.ts`（`BehaviorConfigSubset` 加 `quiet/focusActive`）；§5 把 `focus.opacity=0.55`、`focus.fpsCap=10` 放进配置——会与用户 `PetConfig.opacity/fpsCap/autonomous`（`types.ts:99-129`）混淆，退出专注后若写盘会**覆盖用户设置**。
**修正**（§7）：专注会话是**运行态**，不是用户配置；表现层用“有效值 = 用户配置 × 专注覆盖”的合成（`effectiveOpacity = min(config.opacity, 0.55)`、`effectiveFpsCap = min(config.fpsCap, 10)`），只在 renderer 内存生效、绝不写回 `opacity/fpsCap/autonomous`。停自主活动 = 组合配置传 `autonomous:false`（§3.6-A），不改契约。

### M13 状态分类/兴趣模型依赖不存在的信号，参数不可信（重要）
豆包 §4.2：CALL 靠麦克风占用（无 API，M7）；GAME 靠“游戏键占比”（键鼠钩子 = macOS Input Monitoring 权限，项目不用也不该用，见豆包 §2.3 自己也承认）；“聊天打开/输入为空”投递闸门（本项目**没有聊天窗**，只有气泡，`core/bubble.ts`）；“语音中”（无音频能力）；WORK/BROWSE/GAME 阈值全部来自 LingChat/Miru 的 Windows/别的产品，`inferred`。
**修正**：P0 v1 只用可得信号：前台 app（M9 方案）+ 窗口数/全屏（几何）+ 空闲秒/锁屏/电池（powerMonitor）+ DSH 状态。状态集合建议：`AWAY/IDLE/ACTIVE_LONG/WORK_APP/MEETING_APP/FULLSCREEN/CASUAL`（去掉 GAME/BROWSE 这类无信号强断言）。兴趣/预算 v1 用确定性简化：语言介入 ≤3 次/小时、最小间隔 10 分钟（已有 A7 `PEEK_DEFAULT_THROTTLE` 先例 `peek.ts:132-135`）、同类去重 30 分钟；概率化 interest 模型留到有真实使用数据后再做（避免“参数幻觉”）。

### M14 P1 氛围层仍需屏幕录制 TCC，不是“拒绝内容级权限”的替代（重要）
豆包 §4.1 说 P1 是“拒绝内容级权限但想要生命感”的折中。但 macOS 上任何像素读取（ScreenCaptureKit / CGWindowListCreateImage / screencapture）都受同一 **Screen Recording TCC** 约束；P1 只降低**信息量**，不降低**权限**。
**修正**：若用户拒绝录屏权限，唯一可用层是 **P0**。P1 的卖点改为“最小信息量/最强隐私”（数据不可还原），不是“免权限”。P1 也需 native helper（或 `desktopCapturer` 整屏，隐私更差），且要单独追加 `screen.peek.ambient`。

### M15 “默认档位 = ocr（已定决策）”与 A7/打包现实冲突（严重）
豆包 §0 列了 3 条“已定决策”（接受录屏 TCC、默认 ocr、定期复核降级）。仓库内**没有**该用户决策记录（无 PLAN/决策文档更新）；A7 契约默认全关（`peek.ts:283-294`），`docs/packaging.md:2.6/§4` 明确当前 ad-hoc 签名、`TCC 身份不稳定`、不可分发。
**修正**：默认值必须用户拍板（§12-Q3）。推荐默认 `metadata` 且 **默认关闭**（用户显式开启），内容级（ocr/vision）默认 off；首次授权引导只在用户主动开启内容级时出现，绝不启动即要求录屏。否则 ad-hoc 构建每次重建可能重置/不稳定 TCC，用户会反复被系统弹窗骚扰。
### M16 忽略已有 R4 设计文档与 A7 落地，重复造轮子（重要）
`docs/research/peek-interface-audit-2026-11-11.md`（1572 行）已给出：capability/tier/permission 模型（§3）、26 步 fail-closed gate（§3.4）、`peek-rules/peek-redact/peek-bridge` 草案（§4.3-4.5）、渲染层 `reactions/peek.ts` 不扩 `ExternalReaction`（§4.7）、IPC 追加批次（§4.8）、嵌套 `PeekConfig` 与深拷贝注意（§4.9）。豆包 §8 证据清单没有它。
**修正**：实施时以 A7 契约（已落地）+ R4（完整目标设计）为基线；本报告只在需求变更处修正（如 P0 权限/throttle 分域、IPC 返回摘要、title 能力推迟）。工作量应抵扣 R4/A7 已完成的接口与 gate 实现（约 4–6 人日的部分已省）。

### M17 “记忆污染隔离”在本项目暂无承载对象（中等）
豆包 §4.6 借 N.E.K.O 设计 `source:screen`/`memoryEligible`/历史投影。本项目**没有 LLM 对话历史/长期记忆子系统**：宠物只有气泡（即时显示）+ DSH 自己的会话历史；`reactions/dsh-dialogue.ts` 只是展示队列（`QUEUE_MAX=8`、`MAX_TURN_TEXT_CHARS=4000`，`:70,73`）。也没有 pet→DSH 的屏幕数据通道（`bridge-schema.ts` 无此方向）。
**修正**：§4.6 的隔离不变量在“W-D 引入 LLM/DSH 屏幕上下文”之前**没有落点**；现在唯一需要的是“屏幕观察内容不落日志、不过 IPC、不进气泡”（A7 契约已有）。若未来 P3 走 DSH 通道，再补 source 标记/记忆隔离。

### M18 透明面板/日志的“元数据”边界与 A7 冲突点（中等）
豆包 §4.3-7 说“观察日志只存元数据，7 天自动清理”，§5 配置有观察记录；“回看最近 10 次：app 名”。app 名可以长期记录用户行为（比“元数据”更敏感）。
**修正**：日志只记 `trigger/tier/capability/reason/activityClass/providerId/耗时/计数`，**默认不记 app 名/标题**（排障需要时用显式 opt-in debug 开关）；面板内存历史最多 10 条、只含 app 类别与元数据、可暂停/一键清空（不落盘）；日志轮转已有（`src/main/logger.ts`，1MB 轮转）。若用户要“app 名回看”，属隐私决策（§12-Q4）。

---

## 5. 修正后的能力 / 权限 / 默认档位模型

| 层 | capability | 数据 | 权限 | 默认（推荐） | A7 现状 | 实施期 |
|---|---|---|---|---|---|---|
| P0 元数据 | `screen.peek.metadata` | 前台 app、窗口数、全屏、空闲秒、电池/锁屏、DSH 状态、活动分类（**无标题、无内容**） | **无 TCC**（app 探测用 `lsappinfo`/现有 winlist；idle 用 powerMonitor） | **关**（用户显式开启） | capability 已有；gate 权限 bug 待修；provider 未实现 | W-B |
| P1 氛围 | `screen.peek.ambient`（需追加，按 R4 顺序） | 160×90 四边带 HSV（不可还原内容） | **Screen Recording TCC** | 关 | **不在 capability 集内**（A7 明确取舍，`docs/peek-interface.md:37-38`） | 用户决策后再做（可在 W-C 之后） |
| P2 本地文本 | `screen.peek.ocr` | 前台**单窗口**截图 → 本机 Vision OCR → 行级脱敏（只留主进程内存） | Screen Recording TCC | 关 | capability 已有；无 provider/helper | W-C |
| P3 视觉 | `screen.peek.vision` | 压缩图 → VLM（可能出网） | SR TCC + 网络 + provider/密钥/成本 | 关 | capability 已有；**基础设施零** | 独立立项（W-D） |
| （不建议）标题 | `screen.peek.title` | 窗口标题 | SR TCC（CGWindowList）或 **AX 新权限红线** | — | 未声明（A7 留待评审） | 不排期；需要用户明确决策（§12-Q5） |

**默认档位修正**：不做“默认 ocr”。推荐 `off`（用户显式开启 `metadata`；内容级需二次确认）——理由：A7 契约默认全关 + packaging TCC 现实 + 用户拒权路径必须常驻。

---

## 6. 隐私架构落点（文件级设计）

### 6.1 规则引擎（`src/shared/peek-rules.ts`，新增，环境下中立）
- 类型：`PeekRuleSet { denyApps: string[]; allowApps: string[]; denyTitleKeywords: string[]; unknownAppPolicy: 'allow'|'deny'; denyMeetingApps: boolean }`（title 字段保留但 P0 不可评估）。
- 纯函数：`normalizeRuleSet(raw)`、`matchAppRules(rules, app: string|null): { allowed: boolean; reason: 'deny-app'|'outside-allowlist'|'unknown-app'|null }`、`compileBuiltinRules()`（内置只读默认拒绝清单：1Password/Keychain/Bitwarden/LastPass/银行/Wallet/远程桌面/TeamViewer/AnyDesk/RustDesk/VMware/VirtualBox/Parallels + 会议 app 列表）。
- **语义必须明确**（豆包 §4.4 自相矛盾：`allowApps` 空=全部允许 vs `unknownAppPolicy=deny`）：推荐 `allowApps=[]` 时 → **内容级 deny-by-default（不允许任何 app）**，用户需显式 allowlist 才能截图/OCR；元数据级不受 allowlist 限制（只受 denyApps）。这样“默认拒绝未知”与 allowlist 不冲突。用户可编辑规则推迟（§3.3）。
- 测试：`tests/peek-rules.test.ts` 新增（纯函数、表格驱动，仿 `tests/desktop-filter.test.ts` 风格）。

### 6.2 有效状态（设置页 UI）
- 纯函数 `computeEffectiveStates(apps, rules, {metadataEnabled, contentEnabled, permission})` → 每个 app：`captured / ignored / partial / outside-allowlist / blockedIndirectly`（供设置页直接回答“这个 app 会不会被截/被反应”）。
- 数据来源：设置页可 `getWindows()` 拿当前 app 列表；规则来自主进程状态（`getPeekStatus()` 或内置规则常量）。
- 放在 `src/shared/peek-rules.ts` 或 `src/renderer/src/settings/settings-model.ts`（推荐前者的纯函数，settings-model 只做展示）。

### 6.3 主进程 P0 编排（`src/main/peek/`）
| 文件 | 职责 | 依赖注入（可测性） |
|---|---|---|
| `provider-p0.ts`（新增） | `PeekProvider` 实现：capabilities=`['screen.peek.metadata']`；`observe()` 返回元数据 payload（app、窗口数、全屏、idle、电池、分类） | 构造注入 `{ now, idleProvider, windowsProvider, frontmostProvider, classifier }`；永不抛 |
| `observer.ts`（新增） | 编排：定时/事件触发、调用 `evaluatePeekGate`、更新节流/历史/状态、失败退避、`dispose()` | 注入 `now`、`schedule`（timer 工厂）、`gate`、`historyLimit`；**不 import electron**（由 Lead 在 `main/index.ts` 注入 powerMonitor/windows 数据） |
| `source-frontmost.ts`（新增，`src/main/desktop/`） | `lsappinfo front` → `{pid, bundleId}`；注入 exec 函数（仿 `dsh-version.ts` 的 `safeExec` 模式）；失败返回 null | `exec` 注入、超时/输出上限 |
| `activity-classifier.ts`（新增，纯，可放 `src/shared/peek-activity.ts`） | `classifyActivity({frontApp, windows, displays, idleSeconds, dsh})` → `PeekActivityClass`；纯函数 | 无 IO |
| `ipc/peek.ts`（新增） | `pet:peek-status` / `pet:peek-observe-now`（返回摘要）/ `pet:peek-pause` / `pet:peek-clear-history` + 事件 `peek-state` | 从 AppContext 取广播 |
| `main/index.ts`（Lead 改） | 创建 observer/provider、接 powerMonitor 事件、will-quit dispose | — |

### 6.4 透明面板 / 暂停 / 清空
- 历史：主进程内存 `PeekHistoryEntry[]`（≤10；字段：`atMs/trigger/tier/activityClass/deniedReason/usedForSpeech/contentChars`），**不含内容**（P2 也只加 `linesDropped/truncated` 计数，不加文本）。
- `pet:peek-history` 返回只读数组；`pet:peek-clear-history` 幂等清空；`pet:peek-pause(true)` 置 `paused`（gate 第 1 步新增 → `paused` reason），重启恢复 false（fail-safe）。
- 设置页新增“屏幕感知”分区：总开关（metadata enabled）、当前有效档位/权限状态、内置拒绝清单（只读展示）、最近 10 次元数据、暂停/清空按钮、“去系统设置授权”深链（`x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture`；仿 `src/main/ipc/window.ts:44-45`）。

### 6.5 日志
- 复用 `src/main/logger.ts`；只允许记录：`event/tier/capability/denyReason/activityClass/providerId/durationMs/count`。**不记 app 名、窗口标题、OCR 文本、图像、URL**。
- 每次观察不必然写日志（高频 P0 轮询会刷日志）；只记状态变化与失败、且限流（如首次/每分钟一条）。

### 6.6 fail-closed 与 `evaluatePeekGate` 复用关系
- **内容级（P2/P3）**：`observer` 构造请求 → `evaluatePeekGate(request, status, now)` → deny 原样返回；allow 才调 provider。gate 保持唯一放行点。
- **P0 元数据**：也走 gate（规则/暂停/能力/权限——metadata 的权限要求为 `none`），但**节流策略按 capability 分域**（metadata 不受 600s/3 次限制；语言介入预算单独在主进程 `budget` 模块里算）。这是对 A7 gate 的**必要扩展**，不是绕过。
- 禁止“权限不足→降级整屏重试/升档重试”；降级只在“配置 tier > 权限允许”时由 observer 显式改请求为 metadata 重新过 gate（语义可解释，R4 §3.3 同款）。

### 6.7 IPC 追加批次（最小集，需 Lead 评审）
```ts
// src/shared/ipc.ts 末尾追加（不改既有 14+4）
peekStatus: 'pet:peek-status'            // → PeekStatus（无内容）
peekObserveNow: 'pet:peek-observe-now'   // → PeekObserveSummary（无内容，见 M2）
peekPause: 'pet:peek-pause'              // → PeekStatus
peekClearHistory: 'pet:peek-clear-history' // → void
peekHistory: 'pet:peek-history'          // → PeekHistoryEntry[]（只元数据）
// IPC_EVENTS 追加：
peekState: 'peek-state'                  // PeekUiState（状态+最近一次元数据摘要，无内容）
```
总数 14+5 invoke / 4+1 事件；`PetApi` 追加 6 个键；同步 `tests/shared-contract.test.ts` 的 3 处计数与键集合断言。W-A（聚焦）**不需要**新 IPC（见 §7.1），可与 W-B 分开提交。

### 6.8 配置键（扁平，W-A/W-B 分两批）
- W-A：`focusMode`（enum quiet|companion|pomodoro）、`focusMinutes`（number 5–180，默认 50）、`focusBreakMinutes`（number 1–30，默认 5）、`focusAutoQuiet`（boolean，默认 true）、`focusSessionStartedAtMs`（number，默认 0；>0 表示会话开始时刻）。
- W-B：`peekMetadataEnabled`（boolean，默认 false）；内容级 `peekTier`/`peekIntervalSeconds`/`peekMaxPerHour` 等留到 W-C 批次。
- 全部 `sanitizeConfig` 显式分支、`DEFAULT_CONFIG` 补默认、`tests/shared-contract.test.ts:124-149` 与 `settings-model.test.ts` 同步；`CONFIG_VERSION` 不变。
- **注意**：`focusSessionStartedAtMs` 是“运行态寄存”在配置里（避免 W-A 新 IPC）；会话结束由 overlay 写回 0；启动时若 `now > startedAt + minutes*60000` 视为已结束不恢复。若 Lead 认为“运行态进配置”不可接受，则改用 §7.1 备选（main 进程 + 新 IPC），W-A 多约 1.5 人日。

---

## 7. 聚焦模式设计（W-A）

### 7.1 状态机落点：renderer 为主（推荐 W-A），main 备选
- **推荐（W-A，零新 IPC）**：状态机在 overlay renderer（新增 `src/renderer/src/core/focus-mode.ts`，纯逻辑 + 注入时钟），持久偏好/会话起点走扁平 config 键（§6.8），跨窗口同步走既有 `config-changed` 广播。理由：宠物渲染只在 overlay；W-A 无托盘/全局快捷键需求；零冻结契约改动；设置页写配置即可开始/结束。
- 多显示器：只有 `isPrimaryDisplay` 的 overlay 页面运行会话（`main.ts:350-366` 有 `overlayWindow.isPrimaryDisplay` 快照），其余页面不跑计时。
- **备选（W-A₂，若要托盘/全局快捷键/更可靠中断）**：状态机在 main 进程（`src/main/focus/service.ts`，内存态），托盘菜单加“开始专注 25/50 分钟”（`src/main/tray.ts:117-145` 菜单模板），新 IPC `pet:focus-status/start/stop` + 事件。多约 1.5–2 人日，且 IPC 批次与 W-B 合并评审。
- 不推荐“状态机放设置窗 renderer”：设置窗可被关闭，宠物 overlay 才是常驻渲染方。

### 7.2 三种模式的表现手段映射（全部不改冻结契约）

| 模式表现 | 实现手段 | 文件 | 备注 |
|---|---|---|---|
| 淡到 55% | `scene.setOpacity(min(config.opacity, 0.55))`（运行态，不写配置） | `main.ts`（applyConfig/每帧合成） | `pet-scene.ts:326-331`/`vrm/pet-scene-vrm.ts:453-458` 只改 canvas CSS |
| FPS 降到 10 | `scene.setFpsCap(min(config.fpsCap, 10))` | 同上 | `fps-limiter.ts:31` |
| 停自主活动/捣乱 | `runtime.setConfig({...config, autonomous:false, mischief:false})`（组合值不写盘） | `main.ts:1034` | `behavior-director.ts:1344`；退出时恢复真实配置 |
| 停主动说话 | `main.ts` 在 `bubble.show` 前丢弃“非交互来源”气泡：`decision.mood ∈ dsh*` 或 `debug.behavior.autonomous===true` 时跳过；pat/poke 保留 | `main.ts:944-959` | 无需改 B1；交互气泡保留 |
| 停 DSH 回复气泡 | 专注期间不 `dshDialogue.pushEvent`，进入时 `dshDialogue.reset()` | `main.ts:1417-1422` | `dsh-bubble-sync` 开关沿用 |
| 计时 UI | overlay 加一个 `pointer-events:none` 的 DOM 元素（倒计时/进度环），随宠物摆放定位 | 新增 `src/renderer/src/core/focus-timer-view.ts` + `style.css` | 不改 canvas/命中 |
| 结束语义/统计 | `TimeFinish / ManualStop / Interrupted`（VPet 借语义）；Interrupted 用 `powerMonitor.on('suspend')` 或 window `beforeunload` 检测 | 新增 focus 模块 | v1 统计**只在内存**（不新增存储）；持久统计需用户决策（§12-Q6） |
| 自动静音（全屏/会议 app） | 全屏：`latestWindows`+`displays` 纯函数判定；会议：前台 app ∈ 内置会议清单；通话真伪无信号（M7）→ 文案标注“启发式” | `src/shared/peek-activity.ts` + `main.ts` | `windows-updated`/`screens-updated` 已订阅（`main.ts:1400-1414`） |
| 结束鼓励/开始台词 | 官方池：开始 `BUSY_BUBBLES`，完成 `SUCCESS_BUBBLES`；提前停止建议静默 | `core/voicelines.ts` + `main.ts` | 不可自研（§3.8） |
| 移到角落 | **不做**：`position` 是初始停靠配置，运行态移动需 B1/B2 新指令（契约）；W-A 只淡出不搬位置 | — | 如要“角落专注”，W-B 再评估 `debugTriggerActivity`/新指令 |
| 自动建议（IDE 15 分钟） | **W-A 不做**：依赖 W-B 的 P0 分类；W-B 后再做“气泡建议 + 用户确认” | — | 不自动进入 |
| 专注中 DSH error 只表情 | `main.ts` 按 `decision.mood ∈ dsh*` 过滤气泡（保留动画反应，`external` 仍注入） | `main.ts:944-959` | 无需改 B1 |

### 7.3 与 `PetConfig` 用户设置隔离（硬要求）
- 用户配置（`opacity/fpsCap/autonomous/mischief/dshLink`）**永不**被专注模式写回；专注会话只存偏好键（`focusMode/focusMinutes/focusBreakMinutes/focusAutoQuiet`）+ 会话起点（`focusSessionStartedAtMs`）。
- 合成入口唯一：`getEffectivePresentation(config, focusState)` 返回 `{opacity, fpsCap, behaviorConfig, suppressProactiveBubbles}`；`applyConfig` 与 focus 状态变化都走它；退出专注调用同一函数恢复原值（防“忘记恢复”）。
- 测试：`tests/focus-mode.test.ts`（纯逻辑，注入时钟/配置；覆盖开始/暂停/继续/自然结束/手动停止/中断/恢复、有效值隔离、非主屏不跑）。

---

## 8. P0 状态分类 / 兴趣 / 预算的可实施性复核

### 8.1 可用信号（修正后）

| 信号 | 来源 | 位置 | 权限 | 频率 |
|---|---|---|---|---|
| 窗口列表/几何/layer | `windows-updated` + `pet:windows` | 已有（`src/main/ipc/desktop.ts:40`） | 无 | 250ms |
| 显示器 bounds/workArea | `pet:screen-info` / `screens-updated` | 已有 | 无 | 事件 |
| 前台 app | `lsappinfo front`（本机实测可用）→ pid → winlist owner | 新增 `src/main/desktop/frontmost-app.ts` | 无 | 1s |
| 空闲秒/锁屏 | `powerMonitor.getSystemIdleTime()/getSystemIdleState()` | 新增 main 接线 | 无 | 5s + `lock-screen/unlock-screen` |
| 电池/电源 | `powerMonitor.onBatteryPower` | 新增 main 接线 | 无 | 事件/5s |
| DSH 在线/忙 | `getDshStatus()` | 已有（`src/renderer/src/main.ts:634-651`） | 无 | 事件 |
| 全屏 | 纯函数：窗口 bounds≈display.bounds | 新增 `src/shared/peek-activity.ts` | 无 | 随窗口事件 |
| 会议 app | 内置 app 名单（启发式） | `peek-rules.ts` | 无 | 随前台 app |

### 8.2 必须移除/降级的信号

| 豆包信号 | 处置 |
|---|---|
| 键鼠钩子/游戏键占比（LingChat） | **移除**：macOS 需 Input Monitoring TCC，且与“零权限 P0”矛盾（豆包自己也承认）。 |
| 麦克风占用（CALL 判定） | **降级**：无 Electron API；W-B 用“会议 app 前台”启发式；native CoreAudio helper 另评审（M7）。 |
| 系统 Focus/DND | **移除**：无公开 API（豆包正确）。 |
| 窗口标题 / 无痕识别 | **移除（P0）**：需 Screen Recording 或 AX 新权限（M8）。 |
| “聊天打开/输入为空”“语音中”（投递闸门） | **移除**：本项目无聊天窗/语音能力；投递闸门改为“气泡占用 / 专注中 / 最小间隔 / 刚交互过”。 |
| GAME 精确分类 | **降级**：只做 `FULLSCREEN` 与 app 名单；不声称识别游戏。 |

### 8.3 分类表（修正）

| 状态 | 判定（建议） | 用途 |
|---|---|---|
| `AWAY` | 锁屏 或 idle ≥ 5min | 不互动；回来问候（`GREETING_BUBBLES`） |
| `IDLE` | idle ≥ 15min 未锁屏 | 睡眠表现（`sleep` mood 已有） |
| `MEETING` | 前台 app ∈ 会议名单（启发式） | 硬静音（不发言、不反应） |
| `FULLSCREEN` | 前台窗口 bounds≈display.bounds 且 layer 0 | 自动静音/淡出 |
| `WORK` | 前台 app ∈ 工作类名单 且 10min 切换 ≤2 | 低打扰（W-B 后） |
| `CASUAL` | 其余 | 正常 |
| ~~`GAME`/`BROWSE`/`CALL`~~ | 无可靠零权限信号 | 不实现（或仅用 app 名单做弱提示，名称不用 CALL/GAME） |

阈值是 `inferred`，需真机校准；v1 建议保守（宁可少互动）。

### 8.4 兴趣/预算 v1 简化（替代豆包概率模型）
- 语言介入：`maxPerHour=3`、`minGap=600s`、同类意图 30min 去重（复用 A7 `PEEK_DEFAULT_THROTTLE` 参数语义 `peek.ts:132-135`）。
- 非语言反应（gaze）：可更频繁（例如 app 切换事件后 1–2s 内一次，5s 冷却），不受“说话预算”限制。
- 专注/全屏/会议：0 语言介入。
- 概率化 interest（豆包 §4.2）**延后**：需要真实使用数据校准，否则就是“参数幻觉”。

---

## 9. 分期修正（W-A / W-B / W-C / W-D）

> 工作量 `inferred`；均以“可独立交付、独立回滚”为前提。W-A 不需要新 IPC；W-B 是一次 Lead 评审的追加式契约批次；W-C 是 native+TCC 批次；W-D 独立立项。

### W-A：聚焦模式 + 低打扰（零权限、3–4 人日）
| 做 | 不做 | 改法 | 前置依赖 |
|---|---|---|---|
| 三模式状态机（quiet/companion/pomodoro）、计时 UI、结束语义、有效表现合成、全屏/会议自动静音、设置页“专注”分区、扁平配置键 | 不改 behavior-director/BehaviorConfigSubset/ExternalReaction/PET_MOODS；不做“自动建议”（依赖 W-B）；不做“移到角落”；不做持久统计 | renderer `core/focus-mode.ts` 纯逻辑 + `main.ts` 接线 + 设置页三件套 + `sanitizeConfig` 扁平键 | 无（不依赖 A7 接线） |
| **验收** | 无任何 TCC 权限也能完整跑通；专注中主动说话 0 次、自主活动 0 次；退出后 ≤5s 恢复用户 opacity/fps/autonomous；配置文件中用户 opacity/fps 未被专注改动；非主屏 overlay 不跑计时；暂停/中断语义正确 | | |
| **测试策略** | `tests/focus-mode.test.ts`（注入时钟/RNG，仿 `tests/behavior-director.test.ts` 的 seeded RNG）；`tests/settings-model.test.ts` 扩展；`tests/shared-contract.test.ts` 的 `DEFAULT_CONFIG` 断言更新；`tests/config-store.test.ts` 加“扁平键合并不丢键”用例。**不跑全量**，单文件 `pnpm exec vitest run tests/<file>` | | |

### W-B：P0 元数据互动（零 TCC，6–9 人日）
| 做 | 不做 | 改法 | 前置依赖 |
|---|---|---|---|
| A7 peek.ts 追加式扩展（capability 权限映射/paused/rule-denied/rules/可选 payload 字段）；`peek-rules.ts`；`peek-activity.ts` 分类；`frontmost-app.ts`（lsappinfo）；`provider-p0.ts`+`observer.ts`；IPC 批次（5 invoke+1 事件）；设置页“屏幕感知”分区 + 元数据历史/暂停/清空；renderer 反应（gaze 覆盖 + 官方台词池气泡 + 冷却） | 不做标题读取/无痕识别/麦克风占用/键鼠钩子/系统 Focus；不做“聊天投递闸门”；不新增 mood/ExternalReaction 类型；不做内容级（P1/P2/P3） | main 进程 P0 provider 只依赖注入的 `windows/displays/idle/frontmost`；规则/分类纯函数放 shared；settings 复用 config-changed 广播 | W-A 的“有效表现合成”可复用；Lead 批准 A7 扩展 + IPC 批次；`lsappinfo` 探测实现并单测 fake exec |
| **验收** | 无 TCC；敏感 app 100% 不产生反应与气泡（fixture 表驱动）；未知 app 内容级不采集（W-C 前无内容）；关闭开关时 provider 零调用、零定时器；日志无 app 名/无内容；运行 1 小时主动发言 ≤3；CPU 增量 <2%（真机比对，属 `inferred`）；渲染层零 `ExternalReaction`/`PET_MOODS` 改动 | | |
| **测试策略** | `tests/peek-gate.test.ts` 扩展（权限按 capability、rules、paused）；`tests/peek-rules.test.ts` 新增；`tests/peek-activity.test.ts` 新增；`tests/peek-observer.test.ts` 新增（注入时钟/exec/窗口快照，仿 `tests/dsh-watch.test.ts` / `tests/desktop-ipc.test.ts` 的注入模式）；`tests/shared-contract.test.ts` 更新；`tests/peek-service.test.ts` 静态扫描保持通过 | | |

### W-C：P1 氛围（可选）+ P2 本地 OCR（需 SR TCC，8–12 人日）
| 做 | 不做 | 改法 | 前置依赖 |
|---|---|---|---|
| 新 native helper（单窗口截图 + Vision OCR，内存→stdout，不写盘）；`scripts/build-native.mjs` 新 target（universal/minos，仿 winlist）；打包 `extraResources`+`package-check`；`getMediaAccessStatus('screen')` 查询 + 深链 + 降级/退避；规则扩展（title 需单独能力评审）、行级脱敏、内容只留主进程内存；设置页内容级授权引导 | 不做整屏截图/HTTP 上传/落盘/日志含内容；不回退整屏；不做“默认 ocr” | helper 输出严格 JSON + 上限；observer 只在 allow+permission granted 时调；P1 ambient 仅在用户确认后追加 capability 并同批实现 | 用户接受 TCC（§12-Q3）；A7 扩展已合入；打包/签名流程更新（`docs/packaging.md` §2.2/2.3/2.6） |
| **验收** | 敏感 app/全屏/会议 → 100% 跳过（fixture）；截图/OCR 不落盘（临时目录检查）；日志无文本；拒绝授权自动降级 P0 且可恢复；连续 3 次失败退避且不刷日志；关闭开关后无 helper spawn | | |
| **测试策略** | helper 用可注入 `spawn`/fake stdout 单测（仿 `tests/winlist.test.ts`）；脱敏/规则纯函数表格测试；TCC 分支不做 e2e（手动真机验收） | | |

### W-D：P3 VLM + 模型/记忆链路（不排期，独立立项）
- 前置：用户明确“允许出网/选择 provider/接受成本”；provider 配置与密钥存储（`safeStorage`/keychain 新接入）；主进程 HTTP 客户端 + 出口审计；consent sheet（图像预览）；成本/预算面板；若要走 DSH 转述，需要新的 pet→DSH 通道（`bridge-schema.ts` 扩展 + DSH 侧同意），属**跨项目**决策。
- 与豆包 §4.7/§6“低侵入”矛盾：这不是渲染层改动，而是新网络/模型基础设施 + 隐私政策。

---

## 10. 文件级改动清单

> 冲突规则：禁止改 `src/renderer/src/{model,vrm,animation,scene}` 中与模型比例/动作相关文件、`assets/**`、`scripts/unity-bake/**`、`docs/research/proportion-*`、`tests/tmp/lead-proportion-v3/**`；下表不触碰这些。另一会话当前只新增了 `scripts/unity-bake/**` 与 `tests/unity-bake-*` 等未跟踪文件（`git status` 已核），与下表无重叠；但**不要**在我方改动期间对该工作树执行 `git add -A/stash/checkout/reset/clean`。

| # | 文件 | 类型 | 冻结契约 | Lead 评审 | 冲突风险 |
|---|---|---|---|---|---|
| 1 | `src/shared/peek.ts` | 修改（追加） | **是**（A7 契约） | **是** | 低（另一会话不碰） |
| 2 | `src/shared/peek-rules.ts` | 新增 | 否 | 否 | 无 |
| 3 | `src/shared/peek-activity.ts` | 新增 | 否 | 否 | 无 |
| 4 | `src/shared/ipc.ts` | 修改（追加 5 invoke+1 event） | **是** | **是** | 低 |
| 5 | `src/shared/config.ts` | 修改（扁平键） | **是** | **是** | 低 |
| 6 | `src/shared/types.ts` | 修改（`PetConfig` 扁平键，可选） | **是** | **是** | 低 |
| 7 | `src/preload/index.ts` | 修改（纯转发） | 是（白名单） | 是 | 低 |
| 8 | `src/main/ipc/peek.ts` | 新增 | 否（注册模式） | 否 | 无 |
| 9 | `src/main/ipc/index.ts` | 修改（注册一行） | Lead-owned | 是 | 低 |
| 10 | `src/main/index.ts` | 修改（service 生命周期/powerMonitor） | Lead-owned | 是 | 低 |
| 11 | `src/main/peek/service.ts` | 修改（接 gate 顺序/状态） | A7 接口 | 是 | 低 |
| 12 | `src/main/peek/provider-p0.ts` / `observer.ts` | 新增 | 否 | 否 | 无 |
| 13 | `src/main/desktop/frontmost-app.ts` | 新增 | 否 | 否 | 无 |
| 14 | `src/main/desktop/winlist.ts` / `native/winlist/main.swift` | **可选**（仅若选 native 方案） | 是（`WindowInfo` 追加字段） | 是 | 低（与另一会话无关，但需重建 helper） |
| 15 | `src/main/logger.ts` 使用方（不一致改文件） | 使用 | 否 | 否 | 无 |
| 16 | `src/renderer/src/core/focus-mode.ts` / `focus-timer-view.ts` | 新增 | 否 | 否 | 无 |
| 17 | `src/renderer/src/reactions/peek.ts` | 新增 | 否 | 否 | 无 |
| 18 | `src/renderer/src/main.ts` | 修改（接线：合成/过滤/gaze/气泡） | Lead-owned 集成层 | **是** | 低（非模型相关文件） |
| 19 | `src/renderer/src/style.css` | 修改（计时 UI 样式） | 否 | 否 | 无 |
| 20 | `src/renderer/settings.html` + `settings/settings-model.ts` + `settings/main.ts` | 修改（两个新分区） | 否 | 否 | 无 |
| 21 | `src/renderer/src/debug.ts`（可选：只读快照） | 修改 | 否 | 否 | 无 |
| 22 | `tests/peek-gate.test.ts` / `peek-service.test.ts` | 修改 | 契约测试 | 是 | 低 |
| 23 | `tests/peek-rules.test.ts` / `peek-activity.test.ts` / `peek-observer.test.ts` / `focus-mode.test.ts` / `frontmost-app.test.ts` | 新增 | 否 | 否 | 无 |
| 24 | `tests/shared-contract.test.ts` | 修改（计数/键集合/DEFAULT_CONFIG） | 契约测试 | 是 | 低 |
| 25 | `tests/settings-model.test.ts` / `config-store.test.ts` | 修改/新增用例 | 否 | 否 | 无 |
| 26 | `docs/peek-interface.md` / `docs/packaging.md`（W-C） | 修改 | 文档 | 是（红线） | 无 |
| 27 | `scripts/build-native.mjs` / `electron-builder.yml` / `scripts/package-check.mjs`（W-C） | 修改 | 打包契约 | **是** | 低 |
| 28 | `docs/research/screen-awareness-architecture-review-2026-11-11.md` | 新增（本文件） | 否 | — | 无 |

**不改**：`src/renderer/src/behavior/behavior-director.ts`、`core/wave2-contract.ts`、`scene/pet-scene.ts`、`vrm/**`、`animation/**`、`model/**`、`physics/**`（W-A/W-B 全走集成层，除非法 Lead 明确批准扩展）。

---

## 11. 豆包报告错误/过时清单（编号汇总）

| # | 问题 | 严重度 | 详见 |
|---|---|---|---|
| 1 | 未提 A7 peek 契约，另起 `screen.ts` 并行契约 | 严重 | M1 |
| 2 | IPC 返回/回看含内容，违反 A7 内容不过 IPC 红线 | 严重 | M2 |
| 3 | 嵌套 `screen`/`focus` 配置组在现 config-store 会丢键 | 严重 | M3、§3.3 |
| 4 | 自研/模型生成台词/SKIP 过滤链路违反官方台词硬约束 | 严重 | M4、§3.8 |
| 5 | P3 VLM 无任何基础设施，工作量和“低侵入”都错 | 严重 | M5 |
| 6 | 遗漏 Electron `powerMonitor`（idle/battery/lock） | 重要 | M6 |
| 7 | 麦克风占用列 P0 零权限零成本，实际需 native helper | 重要 | M7 |
| 8 | 窗口标题规则 PoC 不可行（SR/AX 权限路径未写） | 重要 | M8 |
| 9 | “P0 前台 app 现成、~0 成本”错：`WindowInfo` 无 active 字段 | 重要 | M9 |
| 10 | 全屏判定未写 macOS `.optionOnScreenOnly` 语义限制 | 重要 | M10、§2 行 12 更正 |
| 11 | “所有新能力经现有 ExternalReaction 注入”不成立（mood 三值冻结） | 严重 | M11 |
| 12 | 改 behavior-director/`BehaviorConfigSubset` 且把表现写进持久配置 | 严重 | M12 |
| 13 | 状态/兴趣模型依赖不存在信号（键鼠/麦克风/聊天窗/系统 Focus），参数不可信 | 重要 | M13 |
| 14 | P1 氛围仍需 SR TCC，不是“拒绝内容级权限”的替代 | 重要 | M14 |
| 15 | “默认 ocr 已定决策”与 A7 默认全关/打包 TCC 现实冲突，仓库无决策记录 | 严重 | M15、§12-Q3 |
| 16 | 忽略已有 R4 设计（1572 行）与 A7 实现，重复造轮子 | 重要 | M16 |
| 17 | 记忆污染隔离无承载对象（项目无 LLM 对话历史） | 中等 | M17 |
| 18 | 日志/回看“元数据”边界与 A7 冲突；app 名长期记录是隐私回归 | 中等 | M18 |
| 19 | 基线 `3893943` 已过时（HEAD 前进 24 提交），§1 数据行实际 14 行；未标注外部仓库不可本地复核 | 中等 | §1、§2 |
| 20 | `lastComment` 冗余（已有 BubbleGate 冷却）；“观察日志 7 天清理”无存储方案 | 轻微 | M4、M18 |

---

## 12. 须用户决策的开放问题（含推荐）

| # | 问题 | 选项 | 推荐 |
|---|---|---|---|
| Q1 | **台词/表达来源**（最硬约束） | A. 只用 111 条官方原文的语义映射 + 非语言反应（不新增文本源）<br>B. 用户另行授权“官方台词之外的固定文本源”（需定义来源/版权/审核）<br>C. 允许 DSH 生成屏幕评论（需 pet→DSH 屏幕数据通道 + DSH 侧隐私同意，跨项目） | **A**（当前唯一与硬约束相容且可立即做的）；B/C 需用户明确授权 |
| Q2 | **P3 VLM 是否做** | A. 不做（本期）/ 暂缓<br>B. 只做“本地模型”不出网（仍需新基础设施，且性能/成本未知）<br>C. 出网 provider（需密钥存储、consent、成本、隐私政策） | **A**；若用户坚持，先做 B 的技术 spike 再决策 |
| Q3 | **默认档位 / TCC** | A. 默认全关，用户显式开启 P0；内容级二次确认（推荐）<br>B. 默认 metadata（无权限）<br>C. 豆包方案：默认 ocr + 首启引导授权 | **A**（A7 契约默认 + TCC 现实）；B 可接受但需用户点头；C 不推荐（ad-hoc 签名 TCC 不稳、隐私观感差） |
| Q4 | **透明面板回看粒度** | A. 只元数据（app 类别/时间/原因/是否发言），不落盘（推荐）<br>B. 回看最近 N 分钟脱敏文本（需把内容过 IPC/落内存历史，违反 A7 内容边界，需契约变更） | **A**；B 需单独隐私评审 |
| Q5 | **窗口标题能力** | A. 不做（v1 规则只到 app 级）<br>B. P2 时用 Screen Recording 顺带读标题（同 TCC，但标题暴露面更大）<br>C. 新增 Accessibility 路径（新权限红线） | **A**；B 需在 W-C 单独评审；C 不推荐 |
| Q6 | **聚焦统计是否持久化** | A. 不持久化（内存态，推荐）<br>B. 新存储文件 `focus-stats.json`（本地、可清空、只存时长/结束原因） | **A**；B 需要用户明确要“专注历史”再排期 |
| Q7 | **聚焦模式气质** | quiet / companion / pomodoro（可同时实现，默认 quiet；companion 需要“坐在窗沿”表现，涉及 B1/B2 目标，成本更高） | **默认 quiet**；companion 的“陪坐”需要额外动作/行为契约评审（W-B 后再看） |
| Q8 | **麦克风占用（会议检测）** | A. 砍掉，用“会议 app 前台”启发式（推荐）<br>B. 新增 native CoreAudio helper（不同权限路径、多一个二进制） | **A**（W-B）；B 仅当用户明确需要“真在开会”判定 |

---

## 13. 证据索引（本报告引用的关键 file:line）

- IPC/契约：`src/shared/ipc.ts:23-57,78-107,116-141`；`tests/shared-contract.test.ts:14-63,83-111,115-152`
- 配置：`src/shared/config.ts:22,36-57,140-206`；`src/main/config-store.ts:59-65,160-172,189-198,217-224`
- 类型：`src/shared/types.ts:33-41,43-65,90-151,153-176`
- Wave2 契约：`src/renderer/src/core/wave2-contract.ts:1-18,177-199,201-246,265-286`
- 行为：`src/renderer/src/behavior/behavior-director.ts:581-600,642,1070-1095,1300-1335,1344,1397-1425`；`behavior/dialogue.ts:17-19,23-61,109`
- runtime/renderer：`src/renderer/src/core/pet-runtime.ts:101-111,626,790-810`；`main.ts:378-430,533-555,898-917,944-962,1034,1103-1119,1302-1340,1391-1422`
- 台词：`src/renderer/src/core/voicelines.ts:1-33,36-151,176-177,193-237`；`tests/voicelines.test.ts:140-143,175`
- 气泡/展示：`src/renderer/src/core/bubble.ts:22`；`reactions/dsh-dialogue.ts:44,70,73,155`；`reactions/dsh.ts:35-45,119,283-294`
- 设置：`src/renderer/settings.html:40,84,127,172`；`settings/settings-model.ts:17-37,135,161,192`；`settings/main.ts:47-106,129,351-390`；`src/main/ipc/config.ts:126-145`；`app-context.ts:118-125`
- 窗口/桌面：`src/main/ipc/desktop.ts:40,120-142`；`src/main/desktop/winlist.ts:1-16,296-320`；`native/winlist/main.swift:5-8,150-160`；`src/main/windows/overlay-manager.ts:256-257`；`src/main/windows/mouse-gate.ts:18`；`src/main/ipc/window.ts:44-45,168-171,177-194`
- TCC/打包：`docs/packaging.md:197-205`（§3 TCC）、`:64-120`（§2.2/2.3 extraResources/native）、`:163-213`（§2.6 ad-hoc）
- A7：`src/shared/peek.ts`（capability `:22-41`、permission `:57-75`、deny `:82-98`、status `:141-153`、request `:170-181`、payload `:209-244`、provider `:250-266`、default `:283-294`、gate `:394-448`）；`src/main/peek/service.ts`；`src/main/peek/stub-provider.ts`；`docs/peek-interface.md:19-25,33-38,93-108,122-124,153-178`；`tests/peek-gate.test.ts:72-80,114-132,182-196,233`；`tests/peek-service.test.ts:280-300`
- R4 设计：`docs/research/peek-interface-audit-2026-11-11.md:12-36,130-260,976-1093`
- 空闲/电源/权限 API：`node_modules/electron/electron.d.ts:11580,11586,11599`（powerMonitor）、`:14806`（getMediaAccessStatus）
- 前台 app 先例：`src/main/desktop/dsh-process.ts:10-15,331-333`；`dsh-version.ts:13,175-185`（`lsappinfo` 用法）
- 网络现状：`package.json`（运行时依赖仅 `@electron-toolkit/utils`）；`src/main/security/renderer-network-guard.ts:31,100`
- 官方台词测试锚点：`tests/behavior-director.test.ts:1161`；`tests/dsh-reactions.test.ts:252`

---

## 附录 A：与另一会话（模型比例/动作重定向）的冲突边界

- 本报告与后续实施**禁止**触碰：`src/renderer/src/model/**`、`src/renderer/src/vrm/**`、`src/renderer/src/animation/**`、`src/renderer/src/scene/**` 中与模型比例/动作相关的文件；`assets/**`；`scripts/unity-bake/**`；`tests/tmp/lead-proportion-v3/**`；`docs/research/proportion-retarget-*`；根目录 `*.tsbuildinfo`。
- 本方案实际修改的 `src/renderer/src/main.ts`、`settings/*`、`shared/*`、`main/ipc/*` 与上述路径无重叠；但 `scripts/build-native.mjs` / `native/winlist`（仅 W-C/可选 W-B native 方案）会触发 native 重建——**实施前需与另一会话/Lead 对齐**（`prebuild` 会跑 `scripts/build-native.mjs`）。
- 本项目工作树的未跟踪文件属另一会话；不得 `git add -A` / `stash` / `checkout -- .` / `reset` / `clean`，不提交。

---

*本报告为审计/设计结论，不代表用户对 Q1–Q8 的授权；实施前需 Lead 评审 §3.10 扩展范围与 §10 冻结契约改动，并取得用户对 §12 的决策。*
