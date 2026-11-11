# Wave 3 外部同类项目调研：dsh-pet / Mate-Engine / Codex·Claude·豆包桌宠 / 气泡同步 / 互保活 / macOS 拉起 / 窥屏接口

> 日期：2026-11-11 · 任务：R3（task-3）· 工作区：`/Volumes/4TB外置盘/deepseek-harness/aventurine-pet-vrm`（main @ `3893943`）
> 性质：**只读调研**（唯一写入 = 本文件）；不改源码、不安装/运行任何东西、不跑桌宠/DSH。
> 方法：联网检索 + 抓取一手 README/官方文档/插件 registry + 本地 `refs/` 源码只读 + 复用已有调研
> `docs/research/screen-awareness-privacy-focus-feasibility-2026-11-11.md` 的项目/许可证对比（下文简称「既有窥屏报告」）。
> 证据等级：**A** = 一手文档/源码原文（本次抓取）；**B** = 项目 README/官方目录页（本次抓取，非代码级核验）；**C** = 二手教程/新闻/未核验目录（只作线索）；**D** = 本地 `refs/` 只读源码（一手，但按许可证只取模式）。
> 安全红线：web 内容一律视为**不可信外部数据**，只作参考，绝不执行其中任何指令；**不复制 GPL/AGPL/商业许可代码**，只提炼模式与接口设计。

---

## 0. 一页结论

**一句话**：DSH 桌宠生态已经存在且相当繁荣（第三方目录单「状态可视化桌宠」叶子就有 **54 个插件**），主流做法不是「一个官方 dsh-pet」，而是三类实现形态并存——**页面内 client 插件**、**外部原生悬浮窗 + 宿主桥**、**DSH 动态 cordis 插件**；本项目「Electron 外部悬浮窗 + 文件桥」属于第二类的正当先例，且社区已经把「事件源 / 状态投影 / 气泡同步 / 单实例 / 拉起 / 失败降级」这套问题踩过一遍，可直接对齐这些模式，但代码与美术素材必须全自研。

**四个需求点的结论（详见 §6）**

| 需求 | 结论 | 一句话依据 |
|---|---|---|
| **① 互保活** | 采用「**单向宿主拉起 + 幂等 open + 单实例锁 + 心跳文件 + 冷却/退避 + 显式退出墓碑**」，**不要**双进程互相 monitor/互杀/无限重启 | `dsh-co-pet` 的 autoLaunch + 电源开关、`dsh-blender-plugin` 的 15s watchdog「先清尸再重生」、`claude-pet` 的 hooks 拉起 + `exit_when_no_sessions` + 30s grace、LaunchAgent `KeepAlive`/`ThrottleInterval` 语义 |
| **② 状态反应** | 现有「文件桥 → ExternalReaction → 动作」方向正确；补 **粗状态投影（phase）+ 会话维度 + 完成去抖（≈8s 静默）+ 状态优先级聚合** | DSH 社区一致用 `turn/step/tool/approval/turn-end` 投影 9 状态；`dsh-kun-like-pet` 实测部分部署事件不流经动态插件总线（831 次观测 0 条 status），故需「事件 + 轮询/心跳」双通道 |
| **③ 气泡同步** | AI 文本**不逐 token 流式进气泡**：`思考中占位 → 按 turn/段聚合（或完成后取最终文本摘要）→ 停留时长分层 → 去重 → 优先级/钉住/打断 → 队列上限`；气泡之上加纯逻辑 Arbiter | Codex 生态 `OpenPets` 的 `threadId` 替换式气泡、`claude-pet` 的 dwell/优先级、`WhaleIsle` 的三级气泡仲裁 + pinned + `alertId` 幂等撤销、流式 TTS 的「句子累积器 + flush + barge-in」 |
| **④ 窥屏接口** | 本轮只落**接口与文档**：capability 声明 + permission 状态机 + fail-closed gate + 默认关闭 + 可回看 + 事件 schema（source/scope/redaction/ttl/confidence/providerVersion）+ stub 返回 unavailable | `darkitten-pet` 三档观察模式/默认关/闸门、`WhaleIsle` 的「无视觉模型→永不截屏」「手动触发」「成功结果 pinned」、`Peekaboo` 的 TCC 权限矩阵与「CoreGraphics 伪成功返回壁纸/redacted」的 fail-closed 证据 |

**明确「不可借鉴 / 不可复制」**：Mate-Engine 代码与美术（AGPL v3 + MateEngine Pro License v2.1 + assets © Shiny 保留所有权利，见 §2.3）、`screenpipe` 代码（商业许可）、`LingChat`（AGPL-3.0）、Live2D Cubism Core（专有运行库，禁止随包分发）、Codex 精灵图/宠物素材与各仓库的 NC 美术资产。**只取结构与交互模式，不搬代码。**

---

## 1. DeepSeek Harness（DSH）桌宠插件生态

### 1.1 生态现状：存在、且不是「一个 dsh-pet」

- DSH 官方定位就是「一切皆插件（Everything is a Plugin）」（[deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)，B）。插件 = 一个 npm 包，同时可有 **host 面**（`lib/index.js`，注册工具/服务/HTTP 路由/会话事件）与 **client 面**（`lib/client.js`，浏览器里跑 cordis `apply(ctx)` 渲染 UI）；`package.json` 用 `dsh.bundle.patch` 声明 bundle 层，用 `dsh.client`（`platform: "web"`）声明浏览器半边（详见 DSH 社区插件开发指南 [NanmiCoder/dsh-agent-teams · developing-dsh-plugins.md](https://github.com/NanmiCoder/dsh-agent-teams/blob/v0.1.15/docs/developing-dsh-plugins.md)，B）。
- 第三方目录规模（目录自报，仅指规模、不代表质量）：[dshplugin.dev](https://dshplugin.dev/)「1136 repositories」（C）；[dshbase 插件目录](https://dshbase.com/zh/plugins/directory/) 标注「浏览全部 26834 个插件」（C）；`dsh-plugins.tech` 的语义目录把桌宠单列为「界面与个性化 → 个性化与表达 → 桌宠与陪伴装饰 → **状态可视化桌宠**」，该叶子 **54 个插件**（[目录页](https://dsh-plugins.tech/directory/interface/personalization-and-expression/desktop-pets-and-companions/status-visualization-pets)，B/C）。
- **没有唯一的官方「dsh-pet」**：官方仓/官方 npm scope 里没有名为 `dsh-pet` 的官方包；但社区重名/近名很多，其中与我们最相关的是：

| 项目 | 形态 | 事件源 / 通信 | 气泡 / 表现 | 进程拉起与生命周期 | 许可证 |
|---|---|---|---|---|---|
| [mjw-git/dsh-pet](https://github.com/mjw-git/dsh-pet) | 单包 dual-face（host + client），页面内 | host 把会话事件投影为 `thinking/calling-tool/tool-ok/tool-error/answered/turn-end`，经 **`/pet/events` SSE** 推给浏览器，另有 3s 轮询兜底；XP 由 `assistant/message` 的 token 桶从 **durable session logs 重算**（不可抹除） | 右下角精灵（Codex 8×9 契约），hover 面板；`/pet/reset` 只接受 sprite 作用域 | 无独立进程（页面内）；`dsh.bundle` 自安装 | **MIT**（GitHub API 读取，A/B） |
| [LINNoot/dsh-co-pet](https://github.com/LINNoot/dsh-co-pet) | DSH 插件（cordis bundle）+ **外部 Python/PySide6 桌宠进程** | 双通道：**UDP `127.0.0.1:<port>`**（`{"src":"dsh-pet-bridge","event":...,"detail":...}`）+ **状态文件 `~/.dsh/dsh-pet-state.json`**（原子写，桌宠 300ms 轮询兜底）；事件订阅 + **`agents` 服务轮询校正**；完成判定 = `turn/end completed` 或 goal complete + **8s 静默去抖**；空闲兜底 5min | 气泡 = 会话标题 + 状态短语 + **AI 总结第二行（≤20 字）** + 右侧状态圆圈（完成绿勾）；「中断圆圈」（DSH 无暂停 API，点击发中断、保留输入消息）；拖拽/托盘/置顶；Web 侧边栏**电源开关**（关闭=发 `pet/quit` 退出进程，开启=spawn） | `autoLaunch: true`（随 DSH 启动桌宠）；控制事件 `pet/visibility`、`pet/quit`；桌宠自**单实例锁**；状态持久化 `~/.dsh/dsh-pet-visibility.json` | **MIT（代码）**；宠物素材来自开源社区（演示用） |
| [anneheartrecord/dsh-desk-pet](https://github.com/anneheartrecord/dsh-desk-pet)（npm `deepseek-desk-pet`） | **macOS 外部原生窗**（系统 Python + ctypes 调 **AppKit**，无 Electron/零依赖） | 监视 `~/.dsh` 的**进程、会话活动**和一个可选提示文件 `~/.dsh/pet-activity.json`（手动驱动）；自身写 `~/.dsh-desk-pet/state.json`（第二次启动靠它判断已有一只在跑，`--stop` 靠它找 pid） | 六状态：空闲/干活/等你/报错/开心（3.2s 回落）/睡着（agent 与鼠标同时静默 90s）；点一下开会话清单；免打扰；真置顶窗、**跨全屏 Space**、默认关闭需显式开启 | 后台进程，启动后脱离终端；**默认关闭**、托盘/设置主动开启；**停掉 `dsh web` 它也停**；内置 `--probe`/`--foreground`/`--stop`/`--inventory` | **MIT** |
| [@linxin666/dsh-pet](https://www.npmjs.com/package/@linxin666/dsh-pet)（[源码](https://github.com/zhu1090093659/dsh-pet)） | 页面内 client + host（Web GUI 浮动 Live2D/sprite，多宠 registry） | host 投影 `turn/start`、`step/start`、`assistant/message`、`tool/call`、`tool/result`、`turn/end` + `agent/assistant-stream` chunk → waiting/thinking/tool/review/done/failed；可选 legacy `activity/status`；浏览器 2s 轮询 `/api/pet/*` | **状态气泡栈**：默认只有「当前会话」说话，其它活跃顶层会话折叠成 `+N`，hover/点开扇出、点击跳会话；子代理归父会话不占气泡；`pet.announce` 宿主侧插件可推带 `source` 槽位的公告泡（TTL 1s–2h 钳制、`MAX_ANNOUNCEMENTS=4`、最旧让位）；`pet.registerPanelAction` 可注入面板按钮 | 页面内无独立进程；Loop 只在本机；`dsh.bundle` + client module | ⚠️ **许可证冲突**：npm registry 元数据 `Apache-2.0`，README 写 `BSD-3-Clause`；采用前必须复核仓库 `LICENSE` |
| [ankesu/dsh-live2d-pet](https://github.com/ankesu/dsh-live2d-pet) | 页面内 client（Cubism 4 / pixi） | 监听 DSH 会话状态（会话相位时间驱动） | **状态→表情映射表**：`idle/waiting/thinking/deep/tool/done/celebrate/failed/drag/sleep`；拖拽持久化 + 顶栏 ✨ 开关；模型不可见时需 `localStorage` 显式启用 | 页面内；模型资产需自备（Live2D 样例许可仅测试） | **MIT**（插件代码）；模型 © Live2D Inc. 样例许可 |
| [a8chann/dsh-pet-live2d](https://github.com/a8chann/dsh-pet-live2d) | 页面内 client（也支持「显示位置：自动/页面内/**桌面**」） | 订阅 DSH 真实事件：`agent/status`、`tools/*`、`approval/request`、`user-questions/request`、`subagent/start\|end`、`agent/inbox/inserted`、`agent/turn-stopping`、`agent/error` → **8 个会话相位** `thinking/tool/waiting/asking/helper/queued/done/failed` | 每相位绑**动作 + 台词 + 提示音**；气泡位置/字号随体型、「一句话停留多久」可配；装扮/表情 20 个互斥槽位；摸头/摸尾/转圈互动 | 页面内（桌面形态由 DSH 桌面宿主承载）；`dsh.bundle` | **MIT**（插件代码）；自带模型 CC BY-NC-SA 4.0 |
| [ysyyhhh/dsh-pet](https://github.com/ysyyhhh/dsh-pet) | 页面内插件 + **pet 目录契约** | 扫描 `~/.dsh/dsh-pet/pets/<id>/`；`/pet import` 从 Petdex 公共清单下载校验 | `pet.json` + 8×9 精灵图（1536×1872，192×208）固定 9 状态 | 无独立进程 | 仓库未在本次取证中确认（B/C） |
| [liyupi/dsh-kun-like-pet](https://github.com/liyupi/dsh-kun-like-pet)（[dshbase 页](https://dshbase.com/zh/plugins/dsh-kun-like-pet/)） | **DSH 动态插件**（`cordis_define` 生成 host+client） | **轮询 `agents` 服务**（实测部分部署 `agent/status` 等事件不流经动态插件总线：831 次事件观测 0 条 status）+ `tools/execute`、`approval/request`、`agent/request-error` 推导 5 模式；完成音用**系统命令 `afplay`** 播放（跨窗口可闻） | 9 状态 Codex 契约；气泡文案随状态（努力工作中/思考中/在等你回复/呜出错了/完成啦） | 动态插件为**会话级绑定**（只注入激活它的会话页面）；完成音由宿主进程系统级播放 | **MIT**（代码）；素材仅个人学习（含梗语音） |
| [@jadyssey/dsh-desk-pet](https://dsh-plugins.tech/directory/interface/personalization-and-expression/desktop-pets-and-companions/status-visualization-pets)（目录条目） | **Tauri 原生透明置顶窗**，Win/mac/Linux 原生二进制 | 目录未展开（B/C） | 鲸鱼动画、反映 agent 状态 | 原生进程 | 未取证（C） |
| 其它目录条目（`@liguojiang/dsh-plugin-desktop-pet`、`ds-pet`、`deepseek-whale-pet`、`dsh-dafeiyu`、`AgentCat`、`dsh-companion`、`deepseek-harness-pets` 等） | 页面内或外部窗混合 | 多为事件/轮询 + 状态映射 | 任务进度/状态动画 | 部分含 offline launcher/原生构建 | 未逐一取证（C） |

> 结论：**「外部原生悬浮窗 + DSH 侧桥」不是孤例**——`dsh-co-pet`（Python 外部窗 + UDP/文件）、`dsh-desk-pet`（macOS AppKit 外部窗 + `~/.dsh` 监视）、`@jadyssey/dsh-desk-pet`（Tauri 原生窗）都是先例；本项目（Electron 透明 overlay + 文件桥）路线成立，且已有多个可对齐的契约先例。

### 1.2 事件源与状态投影：社区共识

| 层 | 社区普遍做法 | 代表 |
|---|---|---|
| 原始事件 | `agent/status`、`turn/start`、`step/start`、`assistant/message`（可能含 chunk/stream）、`tool/call\|result`、`approval/request`、`user-questions/request`、`subagent/start\|end`、`turn/end`（带 reason/error） | `@linxin666/dsh-pet`、`a8chann/dsh-pet-live2d`、`dsh-co-pet` |
| 兜底通道 | `agents` 服务**轮询**（500ms–2s）、状态文件原子写、SSE 之外再挂轮询 | `dsh-kun-like-pet`（轮询最可靠）、`dsh-co-pet`（UDP+文件）、`mjw-git/dsh-pet`（SSE+3s 轮询） |
| 粗状态投影 | `idle/working(thinking)/tool/waiting(approval)/asking/review/done/failed/sleep`；带**优先级聚合**与**dwell（停留）** | `claude-pet` 的 `waiting > failed > review > running > waving > idle` 聚合最完整 |
| 完成判定 | `turn/end completed` 为终态；**静默去抖**（8s）防误庆祝；有 goal 只认 goal 完成 | `dsh-co-pet`（8s quiet、goal 语义） |
| 会话维度 | 多会话时「只让一个说话 + 其它折叠/汇总」，子代理归父 | `@linxin666/dsh-pet`（+N 折叠、子代理不占泡）、`claude-pet`（多 session 聚合） |

**对本项目最重要的一条工程教训**：`dsh-kun-like-pet` 在 CHANGELOG/README 中记录——在部分部署里 `agent/status`、`agent/turn-stopping` 等状态事件**不流经动态插件所在总线**（831 次事件观测中 status 类为 0），因此它改用**轮询 `agents` 服务**作为最可靠跨部署方案。这与我方 `dsh-watch` 的「文件心跳 + events.jsonl」设计同理：**事件流用于低延迟，心跳/轮询用于判定真伪与在线**，两者都要有。

### 1.3 与本项目现有桥的差异与可借鉴点

现有实现（本地，D）：`bridge/dsh-aventurine-bridge/`（host-only bundle，只订阅事件写 `~/.dsh/aventurine-pet/{status.json,events.jsonl}`）、`src/main/desktop/dsh-watch.ts`（status.json 750ms 轮询 + events.jsonl 字节偏移尾随 + TTL 30s）、`src/shared/bridge-schema.ts`（事件类型白名单：`agent/status|task/start|task/end|task/error|session/event`；payload 10 个安全标量半白名单 + 零信任清洗）。

| 差距 | 社区做法 | 建议（加法式、版本化） |
|---|---|---|
| 无「AI 回复文本/摘要」通道 | `dsh-co-pet` 第二行 AI 总结 ≤20 字；`@linxin666` 状态气泡按场景轮换；`OpenPets` 的 `threadId` 文本气泡 | 桥事件新增 `assistant/summary`（**受控截断 ≤200 字**，或只给 `textLen`+摘要）；同时新增 `phase` 字段（见 §3.3） |
| 无 `phase`（只有原始 type） | 社区把原始事件投影为粗状态 | `DshEvent.payload.phase: 'thinking'\|'tool'\|'waiting'\|'streaming'\|'done'\|'error'`；主进程/渲染层以 phase 驱动动作与气泡，原始 type 仅诊断 |
| 无会话维度 | 多会话折叠/聚合 | payload 增加 `sessionId`、`turn`、`step`（白名单已有 turn/step；补 sessionId 语义），渲染侧做「当前会话优先」策略 |
| 无「拉起/退出」控制通道 | `dsh-co-pet` 的 `pet/visibility`、`pet/quit`；`dsh-blender-plugin` 的 autoStart、pause 语义 | 桥契约新增控制文件/事件（如 `control.json`：`{launchPet, quitPet, paused}`，或 status.json 扩展字段），独立于 events 流，避免误触发 |
| 无 capability 声明 | 未来窥屏接口需要 | status.json 增 `bridgeVersion` 与 `capabilities: string[]`；读取方对未知能力 fail-closed（见 §5） |

> 注意：`bridge-schema.ts` 的 payload 白名单是**安全边界**（注释 R-24：桥文件可被同用户任意进程写），新增字段必须同步扩展白名单、截断上限与单测；不要为了拿文本把「结构化值透传」放开。

---

## 2. Mate-Engine（本地 `refs/Mate-Engine` 一手源码 + 上游 README）

### 2.1 架构与「AI 状态 → 动作/气泡」

本地取证：`shinyflvre/Mate-Engine`，HEAD `2c5ea6b8`（2026-01-20，D）。

| 关注点 | 实现（本地源码证据） | 可借鉴模式 |
|---|---|---|
| 引擎/渲染 | Unity 6（`ProjectSettings/` + `Packages/`），VRM 加载 + Animator 状态机 + `isSitting`/`isWindowSit`/`isDragging`/`isBigScreen` 等 bool 参数驱动动作 | 「bool/trigger 参数 + 动作层」的状态驱动；本项目已有 BehaviorInput/动作映射，不需要迁移 |
| AI 对话 | 本地 **LLMUnity**（Qwen2.5-1.5b GGUF + llama.cpp，`Assets/LLMUnity/Runtime/**`）；人格提示词存 `…/LocalLow/Shinymoon/MateEngineX/ZomeAI_prompt.txt`，`AISystemPromptBinder.cs` 在 `onValueChanged` 即写盘并 `SetPrompt`，**改文件即生效** | 「人格/台词是外置数据，运行时可热改」；本项目台词/表情映射同理（`assets/expressions/**`、voicelines） |
| 气泡表现 | `AvatarBubbleHandler.cs`：气泡是**挂在 Head 骨上的世界空间对象**，随头部移动/缩放，`Lerp` 弹出/收回 + 开关音效；`AvatarRandomMessages.cs`：`AvatarMessage{text, locKey, state, onActive}` 列表 + `minDelay/maxDelay` 随机间隔 + `despawnTime` 停留 + `streamSpeed=35` **逐字打字机** + `allowedStates` 白名单 + `blockObjects` 遮挡即移除 + 对话中/语音中让路 | ①「气泡挂骨骼/跟随头部」在本项目用 DOM 投影到宠物头项已有等价物（`computeBubblePosition` 处理贴顶/侧移），无需搬；②**打字机速度 + 停留时长 + despawn 定时器**参数化值得复用；③**blockObjects/对话中让路**是「多来源台词优先级」的轻量版（等价于 §3.3 的 holdBubbles） |
| AI 文本进气泡 | LLMUnity `Samples/ChatBot/Bubble.cs`：单个 `activeBubble`，流式回调里 `SetText` 逐字更新（伪流式），无「思考中占位/队列/优先级」 | 可借鉴「逐字」但**不建议**用于本项目 AI 回复（会与口型/长文本/遮挡冲突，见 §3.3）；本项目更适合「思考中 → 按句/完成后摘要」 |
| 外部通信 | 本体**没有通用 agent IPC**：只有本地 LLM + 桌面/窗口探针（`DesktopAmbientProbe.cs` 160×90 采样四边带 HSV 平均、排除自身窗口；`APIs/WinApi.cs`、`uWindowCapture` Windows-only）。社区 Mod [MateEngine-CustomLLMAPI](https://github.com/maoxig/MateEngine-CustomLLMAPI)（MIT + MateEngine License）用**本地 HTTP 代理（默认 `127.0.0.1:13333`）**把 LLMUnity 的 OpenAI Chat Completions 请求转发到远端（DeepSeek/ChatGPT 等），配置存 `…/LLMProxySettings.json` | 「外部 agent 通过本地 HTTP/LLM API 接入」是 Mate-Engine 的实际扩展路径；对本项目：**不要**让宠物直连 LLM，保持「DSH 是唯一 agent，宠物只消费事件/摘要」的边界（隐私与成本） |
| 开机自启 | `Tools/SystemStartHandler.cs`：**Windows 注册表 Run** 键（`RunKeyName=MateEngine`，`GetCurrentExecutablePathQuoted`），`startWithWindows` 存 SaveLoad，UI 开关 + 启动时 `TryApplyRegistry` | 「自启是配置项 + 幂等 apply + 失败只 warn」；本项目在 macOS 用 Electron login item（`src/main/login-item.ts`，已实现 dev 跳过/异常 warn），模式一致 |
| 窗口联动 | 窗口吸附/坐窗/任务栏（Windows API）；`DesktopAmbientProbe` 氛围色 | 既有窥屏报告已评估：只取「氛围探针」这一层，不取 `uWindowCapture`（Windows-only） |

### 2.2 Mate-Engine 的「状态 → 气泡」映射细节（可借鉴清单）

- **台词按 Animator 状态触发**：`onActive` 消息在动画状态切换时按 `state` 白名单触发（如坐下时冒一句），并带男女声分流（`isMale` 参数）——等价于「状态事件 → 一次性反应台词」。本项目已有 `ExternalReaction`，可补「状态 dwell 期间的单次触发 + 冷却」。
- **气泡生命周期**：`despawnTime`（随机或固定）+ `Update` 中状态被阻断/白名单不匹配时立即 `RemoveBubble()`；气泡与聊天窗口互斥。
- **打字机参数**：`streamSpeed`（35 字/秒）可在设置里调；本项目气泡 `BubbleView.show()` 是整句渲染，若要做打字机需在 DOM 侧做「逐字 append + 期间不重排（固定宽高/换行）」——**建议不做逐字**，用短句 + 停留即可，理由见 §3.3。
- **设置持久化**：`SaveLoadHandler`（JSON）+ UI 双向绑定，写盘失败只 warn。本项目 config-store 语义一致（版本不符回退默认、未知键丢弃）。

### 2.3 许可证红线（重要）

- 上游 README（B，本地副本同文）：`App License: Mixed — GNU AGPL v3 & MateProv2 License`；`Default Avatar License: All Rights Reserved by Yorshka Shop`；`QWEN 2.5 1.5b LLM: Apache License 2.0`。
- 本地 `refs/Mate-Engine/LICENSE.md`（D）：`MateEngine Pro License (v2.1)`——允许私下使用/修改，但**衍生作品须同许可公开源码、非商业、不得在 Steam/itch.io 等平台分发**；另有「AGPL & COPYRIGHTED LICENSE / ASSETS」章节：所有音频/视觉/模型/材质/动画/字体/UI **© 2025 Shiny，严格保留版权，禁止商用、禁止单独再分发**；还包含 Llama 3.2 Community License 段落。
- 结论：**Mate-Engine 的代码与资产一律不可复制进本项目**（AGPL 传染 + Pro License 非商业 + assets 保留权利）；只可参考其**交互模式与参数经验**（气泡跟随、打字机、despawn、状态白名单、注册表自启、氛围探针），且这些模式在别处也有更宽松许可的实现（如 `claude-pet`/`dsh-co-pet` 的 MIT 实现）。
- 参考：[shinyflvre/Mate-Engine](https://github.com/shinyflvre/Mate-Engine)（B）；本地只读副本 `refs/Mate-Engine`（D，不进 git）。

---

## 3. Codex / Claude / 豆包等 AI 客户端悬浮球与桌宠

### 3.1 Codex 桌宠：事实标准是「9 状态精灵图契约」

- **官方工作流**：OpenAI 的 curated skill [`hatch-pet`](https://github.com/openai/skills/blob/main/skills/.curated/hatch-pet/SKILL.md)（MIT）定义了 Codex 兼容宠物包：`pet.json` + `spritesheet.webp`，**8 列 × 9 行、1536×1872、cell 192×208**，9 状态行固定为 `idle / running-right / running-left / waving / jumping / failed / waiting / running / review`；空单元格必须全透明；生成流水线含 layout guide、逐行 QA、contact sheet、`validate_atlas`（A）。
- **社区画廊/工具**：[codex-pets.net](https://codex-pets.net/)（registry）；[OpenPets.sh](https://openpets.sh)（MIT）；[Petdex](https://github.com/crafter-station/petdex)（MIT）；[awesome-codex-pets-projects](https://github.com/alterhq/awesome-codex-pets-projects)（CC0 索引，A/B）。
- **契约外溢**：DSH 生态大量直接复用该契约（`dsh-co-pet`、`dsh-kun-like-pet`、`@linxin666/dsh-pet`、`ysyyhhh/dsh-pet` 都是 8×9），说明「9 状态语义 + pet.json 清单 + 资产与代码分离」是跨 AI 客户端的**事实接口**。
- **对本项目**：我们是 VRM 3D，不套精灵图；但可借用其**状态枚举与语义**（本项目动作集已有 idle/walk/sit/sleep/interaction 等，但缺 `review/waiting/failed` 的语义层），以及「资产与代码分离、清单校验 fail-closed」的工程做法。

### 3.2 「任一方启动另一方必然存在」——互保活模式拆解

先给结论：**社区没有任何项目做「两个进程互相无条件拉起」**。可归纳为 5 种可组合模式：

| # | 模式 | 代表项目（证据） | 机制 | 风险 / 防范 |
|---|---|---|---|---|
| 1 | **宿主侧拉起**（DSH 启动 → 宠物存在） | `dsh-co-pet` 插件 config `autoLaunch: true`；`dsh-blender-plugin` `autoStart` + 15s watchdog；`claude-pet` `autostart=true` 由 `SessionStart` hook 拉起 overlay | host/插件 `apply` 或 hook 中 spawn 外部进程；用**端口/心跳探测**确认就绪，不用进程存在当就绪 | 用户以为退出后又被拉起 → 必须有**显式 quit/pause 语义**与「用户 quit 后不自动重启」 |
| 2 | **宠物侧拉起宿主**（pet 启动 → DSH 存在） | 社区没有强先例；但 `dsh-desk-pet` 明确「停掉 `dsh web` 它也停」是反向依赖 | `open -b com.deepseek.dsh`（LaunchServices **幂等**：已运行则激活，不双开）；拉起后轮询桥心跳/端口就绪 | 若 DSH 启动慢/失败，需超时放弃 + 提示；不要 `open -n`（强制新实例） |
| 3 | **OS 级守护** | `launchd` LaunchAgent `RunAtLoad + KeepAlive{SuccessfulExit:false, Crashed:true} + ThrottleInterval`（[plist 字段参考](https://github.com/curiositech/port-daddy/blob/main/skills/macos-launchd-supervision/references/plist-field-reference.md)，A/B）；Electron `app.setLoginItemSettings`（[官方文档](https://www.electronjs.org/docs/latest/api/app#appsetloginitemsettingssettings-macos-windows)）；macOS 13+ `SMAppService`（[Apple 文档](https://developer.apple.com/documentation/servicemanagement/smappservice)） | 交给 launchd 重启崩溃进程；对「用户主动退出」用 `SuccessfulExit=false` 或运行时 pause 状态 | `KeepAlive:true` 会与用户「退出」对抗；ThrottleInterval 防崩溃循环；GUI app 用登录项即可，**不要**再叠 LaunchAgent 双重拉起 |
| 4 | **单实例锁** | Electron `app.requestSingleInstanceLock()` + `second-instance`（[官方文档](https://www.electronjs.org/docs/latest/api/app#apprequestsingleinstancelock)）；`dsh-co-pet` 桌宠自带单实例锁；`dsh-desk-pet` 用 `state.json` 里的 pid；macOS LaunchServices 本身保证 `open` 不双开 | 第二实例立即退出或把参数转发给第一实例 | **dev/unpackaged 与 packaged 行为不同**（本项目 `src/main/index.ts:2746` 是 `!app.isPackaged \|\| requestSingleInstanceLock()`，dev 可多开——生产没问题，但测试要按 packaged 语义） |
| 5 | **心跳/状态文件 + Tombstone** | `dsh-desk-pet` 的 `~/.dsh-desk-pet/state.json`（二启动检测/`--stop`）；`dsh-co-pet` 的 `~/.dsh/dsh-pet-state.json` + `~/.dsh/dsh-pet-visibility.json`；`dsh-watch` 的 status.json TTL 30s + `offline:true` | 用**新鲜度**判定在线；显式 `offline/quit-intent` 防止「僵死心跳被当成活着」 | 时钟回拨/未来时间戳不算在线（本项目 bridge-schema 已处理）；写 tombstone 后对端**只读**、不得再拉起 |

**防循环拉起的 6 条硬规则（建议写进实现）**

1. **单 owner 原则**：DSH 是宿主（owner），宠物是伴生。只允许「宿主拉起宠物」与「宠物在用户显式开启时拉起宿主」两个方向，且任一方向都必须先查对端是否已运行。
2. **幂等拉起**：macOS 用 `open -b <bundle>`（已运行=激活，不新开）；Electron 子进程用 `spawn(..., {detached:true, stdio:'ignore'}).unref()`，不要 `-n`。
3. **冷却窗口**：同一方向两次拉起 ≥60s；连续失败指数退避（60s→300s→stop），并把失败写日志/设置页提示。
4. **用户意图优先**：用户显式退出/关闭联动后写 `quit-intent`/`paused`（文件或配置），对端看到后不再拉起；重启系统或用户手动重开才清除。
5. **不互杀**：任何一方退出都**不**杀另一方；DSH 退出 → 宠物进入 offline 待机（保留窗口/托盘），宠物退出 → DSH 不受影响。
6. **就绪判定用协议证据**：DSH 就绪 = 桥 `status.json` 新鲜（或 `agents` 可查），宠物就绪 = 单实例锁成功 / 心跳文件新鲜；**进程存在 ≠ 可用**（Electron 主进程存在但窗口未 ready 是常见状态）。

### 3.3 AI 回复 → 气泡同步：三种数据源、四种节奏、五条冲突规则

**（a）回复文本从哪来（按可靠性排序）**

| 来源 | 可用性 | 代表 / 说明 |
|---|---|---|
| 1. 会话事件里的 `assistant/message` 最终文本 | 最可靠（终态） | `@linxin666/dsh-pet`、`mjw-git/dsh-pet` 均以 `assistant/message` 作为「已答复」信号；`claude-pet` 用 hooks 的 `Stop` 拿「done」 |
| 2. 流式 chunk（`assistant-stream`） | 低延迟但非终态，需自行拼/丢弃 | `@linxin666` 用 live chunks 只驱动「thinking/streaming」状态，不直接当气泡文本 |
| 3. durable session log / 桥文件回读 | 兜底/重算 | `mjw-git/dsh-pet` XP 从 durable logs 重算（不可抹除）；`WhaleIsle` 尾随 `sessions/**/*.jsonl.zstd` 只取事件类型与结构字段、**绝不解析 content/arguments**（隐私优秀示例） |
| 4. 摘要模型/规则摘要 | 当文本太长/不宜外显 | `dsh-co-pet` 第二行 AI 总结 ≤20 字 |

**（b）节奏：流式 vs 按句/按段 vs 完成一次性**

- **流式逐 token 进气泡**：只有 Mate-Engine 这类「单气泡 + 打字机」在做；对长回复会持续遮挡宠物、频繁重排、打断口型/视线，**不建议本项目采用**。
- **按句流式**（first sentence early）：流式 TTS 的标准解法——句子累积器（终止符 `.!?` + 空白切分）、**只取完整句**、流结束 `flush` 余量、新用户消息触发 `barge_in` 清队列（[autobot-ai 的 Streaming Sentence-Level TTS 设计](https://github.com/mrveiss/autobot-ai/blob/15161d7744f447a73b16e4fa515e17a0e56eeca4/docs/archives/plans/2026-03-02-streaming-tts-design.md)，A/B）。**适合“气泡 + 口型同步”**：每句上气泡一次，口型消费当前句，句间短停顿。
- **按段/按 turn 一次性**（最稳）：`turn/end completed` 后取最终回复 → 截断/摘要 → 上气泡。`claude-pet`（`Stop`→review 20s）、`dsh-co-pet`（turn/end + 8s 去抖）都是这个路线。**本项目 P0 建议先用这个**，后续再开「按句」选项。
- **思考中占位**：`WhaleIsle` 的 `lookPin`（`until=Infinity`，加载气泡独占同一气泡，带省略号逐帧动画，结算后原位顶掉）；`dsh-co-pet`「正在思考」；社区普遍在 `step/start|assistant chunk` 时显示固定短语，`turn/end` 替换。**占位必须有上限**（如 60s 或跟 turn 结束），否则长任务会一直挂「思考中」。

**（c）停留时长（dwell）实测参数汇总**

| 场景 | 社区值 | 来源 |
|---|---|---|
| 状态短语（思考/工具） | 持续到状态结束；或 3–8s 轮换 | `@linxin666`（轮换）、`dsh-co-pet`（持续） |
| 「需要你」（审批/提问） | **不超时**，直到用户回应 | `claude-pet`（waiting holds）、`WhaleIsle`（priority 2 提醒） |
| 完成/庆祝 | 3.2s 回落 | 3.5s（`dsh-pet-live2d`） / 10s（`dsh-co-pet`） / 20s（`claude-pet`） / 4800ms（`dsh-kun-like-pet`） |
| 失败 | 20s（`claude-pet`） / 2.6s（`dsh-kun-like-pet`） / 持续到下一轮 |  |
| 本项目现状 | `BUBBLE_DEFAULT_LIFETIME_MS = 4200`（`src/renderer/src/core/bubble.ts`） | 本地 D |

> 建议本项目分层：状态短语 2.5–4s；回复摘要 **6–10s（按长度 4.2s + 7ms/字，上限 15s）**；完成庆祝 8–10s；错误 10–15s 或保持到下一次交互；「需要你」保持到状态解除。

**（d）去重 / 优先级 / 打断 / 排队 / 多来源冲突（最重要的设计）**

最强参照是 `WhaleIsle` 的气泡仲裁（[desktop-live2d-pet 文档](https://github.com/ChisaAlter/WhaleIsle/blob/main/docs/features/desktop-live2d-pet.md)，B；该仓库许可证本次未核实，只提炼模式）：

- **优先级**：`0 自语 < 1 事件反应 < 2 DSH 提醒/审批`；**高级可抢占低级，同级排队（≤3）**。
- **幂等撤销**：`alertId`——同一提醒的重复/撤销按 id 去重，不会因桥重试刷屏。
- **占用期让路**：`holdBubbles` 声明某段时间（如对话卡打开、拖拽、喂食）自语让路，**不显示不入队**；`priority≥2` 照常可达。
- **钉住（pinned）**：`until=Infinity` + 右上角 ✕，仅用户点击关闭才退场；钉住期间新气泡一律入队、不顶替（`OpenPets` 的 `threadId` 同理：同一 thread 更新同一气泡，不同 thread 才新增）。
- **失败分池**：`lookFallback/lookNoModel/lookAssistantOff/lookError` 分别给不同错因台词，不一律「看不清」。
- **空闲让位**：`claude-pet` 的「dwell 属于上报它的会话」——某会话 done 时其它会话还在跑，done 显示 20s 后交还。
- **多会话**：`@linxin666` 只让当前会话冒泡、其它折叠 `+N`、子代理归父；`claude-pet` 多 session 聚合到一个状态（waiting 最高）。

**对本项目的落地建议**：在 `BubbleView`（DOM 展示）之上新增**纯逻辑 `BubbleArbiter`**（可单测、不依赖 three/DOM）：
`enqueue({ id, source, priority, ttlMs, text, dedupeKey, pinned, alertId, tags })` → 内部维护单 active + 有界队列（如 4）+ 去重表 + 抢占/同级 FCFS + 过期清理 + `pause()/resume()`（对话/拖拽/设置窗打开时）；现有 `bubble.show(text, now, lifetime)` 保持为「展示原语」，由 Arbiter 调用。先接 3 个 source：`behavior`（行为层台词，p0）、`dsh-event`（状态短语，p1）、`dsh-reply`（回复摘要，p2），**`peek` 未来以 p1 预留**。

### 3.4 Claude 桌宠：hook 桥 + overlay 轮询的教科书实现

[claude-pet](https://github.com/HaneulOscarLee/claude-pet)（MIT，Linux；Windows 版 [SHIN620265/claude-pet](https://github.com/SHIN620265/claude-pet)）值得逐条拆：

- **架构**：agent hook → 一个 stdlib-only 的 hook 桥（必须快、永远 exit 0）→ 原子写 `~/.local/state/claude-pet/state.json` → overlay **250ms 轮询**。hook 每次工具调用约 33ms，**坏宠物不能坏 agent**。
- **状态机**：`SessionStart → waving → idle`；`UserPromptSubmit → running`；`Stop → jumping(once) → review 20s → idle`；`tool error → failed 20s`；`Notification(blocked) → waiting（不超时，直到 agent 继续）`；`SubagentStop → 父会话 running`。
- **多会话聚合**：`waiting > failed > review > running > waving > idle`；dwell 属于上报它的会话；子代理归父。
- **stale 检测**：「working 但进程 CPU 空闲 45s」→ 放弃 running（因为中断的 turn 不会发 Stop）；只有 running 会二次判定（waiting 是关于「你」的声明，不该被推翻）。
- **生命周期**：`exit_when_no_sessions=true`（会话全结束才退出）+ `exit_grace_seconds=30`（防一开一关）；`autostart=true` 由 `SessionStart` hook 拉起 overlay；`install-hooks` **合并式**写入、卸载只删自己加的块；`claude-pet stop/status/log/doctor` 可观测。
- **气泡**：`bubble=active|alerts|never`；点击跳回会话；「needs you」只在真正阻塞时出现（`Stop` 之后的 `Notification` 一律忽略）。
- **对本项目**：①「hook/桥必须轻、失败不影响主链路」= 我们桥插件「任何 fs 失败只 warn 不抛」的同一原则；②**grace 退出**与**显式退出墓碑**值得抄进互保活；③**多来源优先级聚合 + dwell 归属**可直接映射到 Arbiter 的 priority 表；④`status/log/doctor` 三件套很值得本项目借鉴（桥诊断命令/设置页）。

### 3.5 豆包（Doubao）悬浮球/桌宠：只能作产品形态参考

- 官方桌面端有「悬浮球/桌面快捷助手」形态（可吸附/全局唤起），但**官方技术实现（进程保活/互拉/协议）未公开**；本次仅检索到二手教程与商店页（证据 C）：[豆包AI桌面悬浮助手](https://www.php.cn/faq/2641353.html)、[豆包 App（App Store）](https://apps.apple.com/cn/app/%E8%B1%86%E5%8C%85/id6683305962)、[任务栏固定悬浮窗指南](https://www.php.cn/faq/2104935.html)、[豆包桌宠（第三方）](https://m.gameyj.com/down/55200.html)、[豆包桌面宠物 EXE 教程](https://www.aitop100.cn/infomation/details/34322.html)、[「豆包能养宠物」报道](https://www.toutiao.com/article/7665155223182180890/)。
- 另有「豆包 AI 宠物」类**应用内玩法**（非系统悬浮窗桌宠）。
- **结论**：豆包可借鉴的只有产品层判断——「全局悬浮入口 + 轻量状态 + 一键回主界面」；**技术方案不引用**（无可信一手文档），互保活与气泡同步不以其为据。

---

## 4. 气泡对话/打字机/队列 + macOS 进程检测·拉起·单实例·权限

### 4.1 气泡队列实现模式（跨项目汇总）

| 维度 | 推荐做法 | 依据 |
|---|---|---|
| 数据结构 | **单 active + 有界队列**（≤4）+ `Map<dedupeKey, ts>` 去重表 + 可选 pinned 槽 | `WhaleIsle`（同级 ≤3、pinned、alertId）、`OpenPets`（threadId 槽） |
| 优先级 | 枚举数值：`0 自语 < 1 事件反应 < 2 用户相关提醒 < 3 钉住/审批`；高抢占低，同级 FCFS | `WhaleIsle` |
| 显示时长 | 由来源声明 `ttlMs`；文本长度自适应；pinned 无 ttl | `dsh-co-pet`（完成 10s、AI 摘要）、`claude-pet`（20s） |
| 打字机 | 若做：固定行高/宽度防重排、按字 append、可被新消息打断；**不建议** AI 长回复逐字上气泡 | Mate-Engine `streamSpeed`；本项目 `BubbleView` 现状 |
| 多来源冲突 | 单槽显示最新高优；低优入队；同 key 更新；跨源不堆叠 | `@linxin666`（会话折叠 `+N`）、`OpenPets`（thread 替换） |
| 打断 | 新 turn 开始 → 清空/丢弃旧回复类气泡（保留提醒类）；用户交互可清**非钉住**气泡 | `WhaleIsle`（对话卡打开清场）、`dsh-co-pet`（新任务覆盖） |
| 暂停/静默 | 全局 `paused`（免打扰/专注/对话中）→ 不弹不排队（或只记日志）；`claude-pet` 的「安静模式」 | `dsh-desk-pet`（免打扰）、`WhaleIsle`（holdBubbles） |
| 可观测 | 每条气泡记录 `source/priority/id/dropped reason`，供 `doctor/log` 排查 | `claude-pet` `claude-pet log` |
| 无障碍 | `role=status`/`aria-live`，装饰 `aria-hidden`；`prefers-reduced-motion` 降级 | `@linxin666` 的 decoration 规范（B） |

### 4.2 macOS 进程检测

| 方法 | 权限 | 适用 | 注意 |
|---|---|---|---|
| `NSRunningApplication.runningApplications(withBundleIdentifier:)`（[Apple 文档](https://developer.apple.com/documentation/appkit/nsrunningapplication/)) | **无 TCC** | 最可靠；可拿 pid/bundle/active 状态；可从 Swift/native helper 或 Electron 主进程经 node 原生模块调用 | 后台/LaunchAgent 会话可能有 GUI 会话隔离，需在 Aqua session 内 |
| `lsappinfo`（如 `lsappinfo find bundleID=com.deepseek.dsh` / `lsappinfo info -only pid -app "DeepSeek Harness"`） | 无 TCC | 命令行/native helper 快速检测 | 输出格式随系统版本变化，需容错解析 |
| `pgrep -x "DeepSeek Harness"` / `pgrep -f ".../Contents/MacOS/DeepSeek Harness"` | 无 TCC | 兜底 | Electron 有多个 `Helper` 子进程；用 `-x` 精确进程名或全路径 + 排除 `--type=` 子进程；进程名/路径随安装位置变化 |
| `ps -axo pid,comm` + 过滤 | 无 TCC | 诊断 | 同上 |
| DSH 桥 `status.json` 心跳（本项目已有） | 无 | **判定「在线/可用」的首选** | TTL 30s；未来时间戳/`offline:true` 不算在线（`src/shared/bridge-schema.ts`） |

**本机取证（A）**：`/Applications/DeepSeek Harness.app/Contents/Info.plist` → `CFBundleIdentifier = com.deepseek.dsh`、`CFBundleExecutable/CFBundleName = DeepSeek Harness`；`ps aux` 实测主进程为 `/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness`，另有 `.../Frameworks/DeepSeek Harness Helper*.app/...` 子进程（检测时不要误判）。

### 4.3 拉起方式与可靠性

| 方式 | 结论 | 证据 |
|---|---|---|
| `open -b com.deepseek.dsh` / `open -a "DeepSeek Harness"` | **首选**；LaunchServices 幂等（已运行则激活，不双开）；`-g` 不抢前台；**不要 `-n`** | [ss64 `open` 手册](https://ss64.com/mac/open.html)（B） |
| `open -W` | 不要用于「拉起并等待」——它会阻塞到 app 退出 | 同上 |
| `osascript -e 'tell application "DeepSeek Harness" to activate'` | 不推荐：触发 **Automation（Apple Events）TCC** 弹窗；被拒时静默失败；System Events 还需 Accessibility | Apple TCC/既有窥屏报告（B） |
| Electron 主进程 `spawn('open', args, {detached:true, stdio:'ignore'}).unref()` | 本项目推荐实现（主进程内一行，无需 shell）；失败只 warn | Node `child_process` 语义 |
| 拉起后就绪判定 | 轮询桥 status 新鲜（200ms × 最多 ~20s）或 1s 心跳；**不要**用「进程存在」或「open 返回 0」当就绪 | `dsh-blender-plugin` 用「轮询 addon 端口 = 唯一可信判据」的同构经验 |
| 失败退避 | 拉起失败/超时：60s 冷却 → 指数退避（≤5min）→ 设置页提示 | `dsh-blender-plugin` watchdog（15s 探活、2 次失败=≈30s 才判死、SIGTERM→1.2s→SIGKILL） |

### 4.4 登录项 / 常驻：LaunchAgent vs SMAppService vs Electron login item

| 方案 | 适用 | 关键点 | 证据 |
|---|---|---|---|
| **Electron `app.setLoginItemSettings({openAtLogin})`** | 本项目（单 .app） | macOS 13+ 底层走 SMAppService（`type: 'mainAppService'` 语义）；`app.getLoginItemSettings()` 读真实状态（用户在系统设置里关掉时要尊重）；dev 下不要写（本项目 `src/main/login-item.ts` 已处理） | [Electron 文档](https://www.electronjs.org/docs/latest/api/app#appsetloginitemsettingssettings-macos-windows)（A/B）+ 本地代码（D） |
| **LaunchAgent**（`~/Library/LaunchAgents/*.plist`，用户级，无 sudo） | helper/守护进程（非 GUI 主 app） | `RunAtLoad`；`KeepAlive` 用 dict：`SuccessfulExit:false + Crashed:true`，配 `ThrottleInterval`（默认 10s）防崩溃循环；`LimitLoadToSessionType=Aqua` 防在 SSH/后台会话加载；plist 644 + 属主正确；`plutil -lint`；旧 `launchctl load/unload` 已弃用 → `bootstrap gui/$UID` / `bootout` / `kickstart -k`；`launchctl list <label>` 三态（运行/加载未跑/未加载） | [launchd plist 字段参考](https://github.com/curiositech/port-daddy/blob/main/skills/macos-launchd-supervision/references/plist-field-reference.md)（A/B）、[macOS 服务管理研究](https://github.com/robertelee78/swictation/blob/435c3b7e2ff40daa13bbc6f57a7ef0eba4ed4f9a/docs/macos-service-management-research.md)（B） |
| **SMAppService**（macOS 13+） | 打包 .app 的 helper / 登录项 | 需 app bundle；helper 放 `Contents/Library/LoginItems/`；有系统设置 UI，用户可关；`register()/unregister()/status` | [Apple SMAppService](https://developer.apple.com/documentation/servicemanagement/smappservice)（B） |
| 系统设置「登录项」UI | 仅供用户手动 | 无代码接口 | Apple（B） |

> 本项目当前只用 Electron login item（`launchAtLogin` 配置），**不要**再加 LaunchAgent 去「保活」；若将来需要「DSH 退出后自动重启 DSH」这类 OS 级守护，才考虑 helper/LaunchAgent，且必须先产品化「用户主动退出」语义。

### 4.5 权限矩阵（TCC）与 fail-closed

| 能力 | API | 需要权限 | 备注 |
|---|---|---|---|
| 检测其他 app 是否运行 | NSWorkspace / `lsappinfo` / `pgrep` | **无** | 后台会话需在 Aqua session |
| `open` 拉起 app | LaunchServices | **无** | 不弹 TCC |
| 控制其他 app（AppleScript/System Events） | osascript / Apple Events | **Automation（Apple Events）**；UI scripting 另需 **Accessibility** | 本项目**不用** |
| 读其他窗口标题 | `CGWindowListCopyWindowInfo` 的 `kCGWindowName` | **屏幕录制（Screen Recording）** | 本项目 `native/winlist` 明确不读（既有红线） |
| 截图/录屏 | ScreenCaptureKit / `desktopCapturer` / `CGWindowListCreateImage` | **屏幕录制** | Electron 可 `systemPreferences.getMediaAccessStatus('screen')` 查询；权限被拒时 API 可能**伪成功**（返回壁纸/纯色/红acted 图），必须做证据校验（尺寸/哈希/窗口列表交叉验证） |
| 读 AX 树/模拟键鼠 | AXUIElement / CGEventPost | **Accessibility**（部分输入需 Event Synthesizing） | 本项目不用 |
| 剪贴板读 | NSPasteboard | macOS 15.4+ 有 caller-local 策略/提示 | 不用 |
| 通知 | UNUserNotificationCenter | **Notifications** | 已有 accessibility/notifications 状态字段 |

**Peekaboo 的两个关键经验（A）**：[Peekaboo permissions 文档](https://github.com/openclaw/Peekaboo/blob/main/docs/permissions.md) 明确：
1. **TCC 归因到「二进制/签名」**：3.9.6 换了 Developer ID team 后，macOS 把新签名的 CLI 当**另一个 TCC client**，必须重新授权屏幕录制/辅助功能；Homebrew 升级路径变化也会导致授权指向旧二进制。→ 本项目打包后升级/重签要提示用户「可能需要重新授权」，且设置页显示真实状态。
2. **fail-closed 证据**：`CoreGraphics can otherwise report success while returning only the desktop wallpaper or a redacted image`——尤其 SSH/LaunchAgent/后台会话。→ 未来窥屏层必须把「拿到图」做像素/元数据校验，失败当作 **denied**，不能仅信 API 返回值。

---

## 5. 屏幕感知/窥屏互动类项目：接口是怎么预留的

> 既有窥屏报告已做完整项目对比（P0 元数据 / P1–P3 内容层、隐私闸门、聚焦模式、18–28 人日估算），本节只回答**「接口预留」的通用模式**，并给出与本项目契约对齐的清单。既有报告结论（本地，D）先摘录：默认 `ocr` 档、权限被拒自动降级 `metadata`、采集前 fail-closed 规则引擎、截图不落盘、内存态不可回放、Focus 是应用内状态机。

### 5.1 社区模式对照

| 项目（许可证） | 预留方式 | 可借鉴 | 不可取 |
|---|---|---|---|
| [darkitten-pet](https://github.com/LFELKEEA/darkitten-pet)（**MIT**，B） | **三档观察模式** `window/ocr/vision/auto`；**默认 `auto` 在免费通道只读窗口标题、不截屏**；屏幕观察**默认关闭**需用户开启；隐私闸门（密码/支付/银行/验证码/无痕/远程桌面关键词、全屏应用、聊天中、语音中、刚互动过 → skip）；截图仅内存压缩、OCR 用系统能力、临时图结束即删；插件系统带**权限声明 + 事件 + 定时器 + AI + 截屏 API** | 分档 + 默认关 + 关键词闸门 + 本地处理不留盘 + **插件权限声明** | 整屏截图（隐私最弱）、Windows-only |
| [N.E.K.O](https://github.com/Project-N-E-K-O/N.E.K.O)（**Apache-2.0**，既有报告 B） | **屏幕评论污染隔离**：来源标记、原始记录 ≠ 模型上下文；观察曝光 UI；Focus 滞回状态机 | 「观察结果入上下文前必须带 source/标记」、可回看 | 其 Focus 是模型思考预算，不是用户专注模式 |
| [LingChat](https://github.com/SlimeBoyOwO/LingChat)（**AGPL-3.0**，不可抄代码） | UserState 分类、加权意图路由、interest 累积/衰减、`max_proactive_times`、投递闸门、dHash 变化检测 | 主动互动节奏参数（限次/去重/闸门） | 代码 AGPL；Win32 键鼠钩子需权限 |
| [Miru](https://github.com/kiyotakali/Miru)（**Apache-2.0**，既有报告 B） | 注意力节流：salience 分级延迟、最小介入间隔、意图去重、捕获失败退避、`ioreg` 读空闲（macOS 无权限） | 节流参数、失败退避、**用无权限信号替代键鼠钩子** | 整屏 `screencapture`、无敏感应用闸门、截图经 HTTP 外发 |
| [screenpipe](https://github.com/mediar-ai/screenpipe)（**商业许可**） | 采集规则引擎（`App::Title` include/exclude、effective state）、隐私设置页信息架构、采集时间表、PII 遮蔽 | 规则语法与「有效状态」模型、隐私页 IA | 代码不可复制；常驻全量录制不是本场景 |
| [BongoCat](https://github.com/ayangweb/BongoCat)（**Apache-2.0**，既有报告 B） | overlay 行为的**声明式配置 schema**（clickThrough/hideOnIdle/hideOnHover/keepInsideScreen/maxFps）+ fixture 驱动契约测试 | 用 schema + fixture 固定行为契约 | 键鼠可视化玩法无关 |
| [WhaleIsle](https://github.com/ChisaAlter/WhaleIsle)（许可证未核实，B） | 窥屏接口的**入口即闸门**：仅面板点击触发；`lookAvailable = Boolean(lookRouteOf().model)` 为假时**不渲染入口**且 IPC 在 `desktopCapturer` 之前返回 `{ok:false, reason:'no-vision-model'}`——**无模型路径永不截屏**；截图 ≤768px JPEG70；仅用户主动；4s 冷却；`lookPin` 加载气泡独占；成功结果 pinned + 可 ✕；成功/失败分池台词；截图落本地内容寻址附件、**不入聊天历史**（除真实视觉回合） | 「能力 gate 前置到入口渲染与 IPC 两层」+「无 provider 不采集」+「结果可回看/可关闭」+「失败原因分池」 | 实现绑定其插件栈，不能照搬 |
| [Peekaboo](https://github.com/openclaw/Peekaboo)（许可证未核实，A） | 权限矩阵（Screen Recording / Accessibility / Event Synthesizing / 剪贴板策略）、`permissions status/grant/request` 命令、Bridge host 归因、签名迁移重授权提示 | 权限状态查询/引导（不直接弹窗）、**fail-closed 证据校验** | — |
| **DSH 官方/社区插件面**（B） | host 可注册 **HTTP 路由**（`webServer.register`，`kind: exact\|prefix`，返回 disposer 须包 `ctx.effect`）；client 用 **slots**（`shell.overlay`、`conversation.*`）或 body portal；跨插件协作用 **cordis service**（如 `pet.announce`、`pet.registerPanelAction`），**不设 HTTP 面** | 接口注册的 lifecycle/disposer 纪律；跨插件用 in-process service 面 | — |

### 5.2 窥屏接口「预留」checklist（只落类型/文档/stub，不实现采集）

**A. capability 声明（能力即数据，不做隐式行为）**

```ts
type PeekCapabilityId = 'screen.peek.metadata' | 'screen.peek.ocr' | 'screen.peek.vision'
interface PeekCapability {
  id: PeekCapabilityId
  supported: boolean              // 本机构建是否带实现
  provider?: { id: string; version: string }
  requiresPermission: 'screen-recording' | 'accessibility' | 'none'
  defaultEnabled: false           // 恒为 false；能力≠启用
}
```

**B. permission 状态机（只读查询 + 用户动作后刷新）**

```ts
type PermissionState = 'granted' | 'denied' | 'not-determined' | 'restricted' | 'unsupported'
// main: 查询 native helper / systemPreferences.getMediaAccessStatus('screen')
// 不主动弹窗；UI 提供「打开系统设置」深链；状态变化后 gate 重新评估
```

**C. fail-closed gate（默认拒绝 + 未知即拒绝 + 失败不改状态）**

```ts
interface PeekGateDecision {
  allow: boolean
  reason: 'default-off' | 'permission-missing' | 'permission-unknown' | 'mode-disabled'
        | 'sensitive-app' | 'focus-mode' | 'budget-exhausted' | 'provider-unavailable'
  scope?: { app?: string; window?: string; region?: 'full' | 'window' | 'crop' }  // 允许时才有
  ttlMs?: number
}
// 规则：用户未显式开启 → deny；permission ≠ granted → deny；provider 缺失 → deny；
// 任何异常路径返回 { allow:false }，不 throw、不改状态、不产生采集副作用
```

**D. observation 事件 schema（覆盖 P0–P2 三档，不因升级改契约）**

```ts
interface PeekObservation {
  id: string
  source: 'pet' | 'dsh' | 'user'
  scope: { kind: 'metadata' | 'window' | 'screen'; appBundleId?: string; windowTitleHash?: string }
  provider: { id: string; version: string }
  capability: PeekCapabilityId
  capturedAt: number
  ttlMs: number
  confidence?: number                 // ocr/vision 档
  redaction: { applied: boolean; rules: string[] }
  replayable: false                   // 默认不可回放（内存态）；若要可回看，另存本地 ledger
  content?: never                     // 接口层不承载内容；只给可用标记/本地引用
}
```

**E. 可回看（本地、可删、默认关）**

- 观察记录存**本机**（如 `~/Library/Application Support/<app>/peek-ledger/`，JSONL + 仅结构元数据；如存内容快照则加密 + 保留期 + 一键清空），设置页「窥屏历史」可查看/删除/关闭记录。
- 日志与崩溃报告**不得含内容**（只 id/能力/结果码）；错误路径 reason 枚举化。

**F. provider 注册 / stub（本轮验收点）**

- `PeekProviderRegistry`：注册 `{ capability, probe(): supported|unavailable, request(): unavailable }`；默认只有一个 `NoopPeekProvider` 返回 `unavailable`。
- 测试（纯逻辑，无采集副作用）：默认关闭 → gate 必 deny；permission 非 granted → deny；未知 capability → deny；stub 请求返回 unavailable；调用前后无文件/网络副作用；日志无内容字符串。

**G. 与 DSH 方向的预留**

- 桥 `status.json` 增加 `capabilities: string[]`（如 `["dsh.status","dsh.reply.summary"]`；未来 `screen.peek.metadata` 表示 pet 可提供观察）；
- 反向（pet 请求 DSH 观察）用**控制通道**（文件/事件 + 请求 id + TTL），不与事件流混；请求/响应都要 fail-closed 与配额（每分钟上限、聚焦模式 0）。
- 事件 schema 版本化：`bridgeVersion` + 未知字段忽略、未知 type 丢弃；`bridge-schema.ts` 白名单扩展必须带兼容测试。

### 5.3 红线（与既有窥屏报告一致，再次固化）

1. 接口层**绝不默认开启**采集；stub 必须 `unavailable`。
2. 不做「持续截屏/常驻录屏」；只做用户主动或低频抽样（未来 P0/P1）。
3. 不读窗口标题/不截图（未获得 Screen Recording 时）；`native/winlist` 现状保持。
4. 观察内容不入日志、不默认外发；入模型上下文必须带 source/redaction 标记（N.E.K.O 模式）。
5. 权限被拒/撤销 → 自动降级、不阻断 app；失败进入退避（Miru）。
6. 任何「看屏幕」入口必须在 UI 与 IPC 两层同时 gate（WhaleIsle 模式）。

---

## 6. 对本项目 4 个需求点的具体建议

> 现有关键文件（本地 D）：`src/main/desktop/dsh-watch.ts`、`src/shared/bridge-schema.ts`、`src/main/ipc/dsh.ts`、`src/renderer/src/reactions/dsh.ts`、`src/renderer/src/core/bubble.ts`、`src/main/login-item.ts`、`src/main/index.ts`（单实例/退出）、`bridge/dsh-aventurine-bridge/`、`native/winlist/`。

### 6.1 需求① 互保活（DSH ⇄ 宠物「任一方启动另一方必然存在」）

**推荐方案（P0，最小侵入）**

1. **DSH 侧**：桥插件 `cordis.patch.yml` 增加 config `autoLaunchPet: false`、`petBundleId`、`petPath`（可执行路径，dev/packaged 不同）、`cooldownMs: 60000`。插件 `apply()` 时若 `autoLaunchPet` 且未检测到宠物运行（单实例探测/心跳文件）→ `spawn('open', ['-b', petBundleId], {detached:true, stdio:'ignore'}).unref()`；**dispose/offline 时不杀宠物**，只写 `offline:true`。
2. **宠物侧**：配置 `dshLink.launchDshOnStart`（默认 false）+ `dshLink.dshBundleId='com.deepseek.dsh'`。启动时若开启且桥 status 不新鲜/`agents` 不可查 → `open -b com.deepseek.dsh`，然后轮询桥 status 最多 20s；失败只 warn + 设置页提示。
3. **单实例**：宠物打包版已有 `requestSingleInstanceLock`（`src/main/index.ts:2746`）；`second-instance` 现有逻辑只对「可见 overlay」`showInactive`，建议补：**收到第二实例时把设置窗/托盘提示带出**（或至少日志），避免用户以为没反应。
4. **退出语义（对写进文档+测试）**：宠物退出**不杀 DSH**；DSH 退出 → 宠物保留窗口进入 offline 待机（status TTL 30s 已实现，渲染层 `reactions/dsh.ts` 已有 offline 默认值）；双方都写 `quit-intent/paused` 墓碑，对方看到后**不拉起**；DSH 重启后自动恢复（心跳新鲜即恢复）。
5. **不做**：互相 monitor/互杀、`open -n`、无限重启、launchd KeepAlive 双守护、开机同时双启动（竞态用「先单实例锁，后幂等 open」化解）。

**验收标准**：①DSH 启动后若宠物未运行且开关开 → ≤5s 出现宠物；②宠物先启动且开关开 → DSH ≤20s 就绪、宠物自动在线；③任何时刻双实例=0；④用户显式退出宠物后 60s 内不被拉起；⑤DSH 退出后宠物不退出、显示离线；⑥拉起失败只影响该功能、有日志与设置页提示；⑦单测覆盖「冷却/墓碑/单实例/超时」。

### 6.2 需求② 状态反应（AI/agent 状态 → 动作 + 表情）

**推荐**（在现有 `ExternalReaction`/动作映射上加，不改冻结契约）：

1. 桥/主进程把原始事件投影成 **`phase`**：`thinking | tool | waiting | streaming | done | error | idle`（对齐 `@linxin666`/`a8chann` 的相位集；`waiting` = approval/ask）。
2. **优先级聚合**（多会话）：`waiting > error > streaming/tool > thinking > done > idle`；`done` 仅在已完成 turn 且无其它活跃会话时庆祝。
3. **完成去抖**：`turn/end completed` 后 8s 静默再判 done（`dsh-co-pet` 参数）；goal 语义预留（若未来桥能提供 goal 事件）。
4. **dwell**：`done` 8–10s、`error` 10–15s、`waiting` 保持到解除、`thinking/tool` 持续到相位变化；表情/动作在同一相位内不反复重播（相位变化才切）。
5. **事件 + 轮询双通道**：心跳缺失/事件静默时用 `dsh-status` 轮询兜底（现有 750ms 已够）；不要只信事件流（§1.2 教训）。
6. **映射表**：9 相位 → 现有动作/表情（idle/wave 等）+ 台词池；写成数据文件/常量表 + 单测（类似 `dsh-pet-live2d` 的相位→动作/台词/提示音三件套）。
7. 可选：`review`（代码变更后）与 `sleep`（长时间 idle + 鼠标静默，dsh-desk-pet 90s 参数）可后续加。

### 6.3 需求③ 气泡同步（AI 回复 → 气泡）

**推荐（分层落地）**

- **P0（本轮/下一轮最小）**：新增 `BubbleArbiter`（纯逻辑，`src/renderer/src/core/bubble-arbiter.ts`，单测）；`bubble.show` 保持展示原语；来源三档：`behavior`(p0 自语) / `dsh-event`(p1 状态短语) / `dsh-reply`(p2 回复摘要)。
- **P1（桥扩展后）**：桥事件 `assistant/summary`（≤200 字，或 `textLen` + 首段摘要）→ `dsh-reply` 气泡；规则：turn 结束才上；长度自适应 ttl（4.2s + 7ms/字，上限 15s）；`思考中…` 占位由 `phase==='thinking'` 触发（ttl 到 phase 变化或 60s 上限）；同一 `sessionId+turn` 去重；新 turn 到达 → 丢弃旧 `dsh-reply` 队列项（打断），**保留** `waiting`/错误类。
- **P2（可选）**：按句模式（句子累积器 + 句间 300–600ms + 口型同步消费当前句）；TTS 仅作为显式开关（系统 `say`/本地 TTS），默认关（隐私/成本/打断）。
- **冲突规则**（从 §3.3 收敛）：高优先级抢占；同级 FCFS、队列 ≤4；`pinned`（如「需要你」）不自动过期，用户 ✕/处理后才退；`alertId` 幂等（桥重试不刷屏）；全局 `paused`（拖拽/设置窗/免打扰）只丢弃低优；日志记录 `{source,priority,id,dropReason}`。
- **与口型/动画**：`bubble.visible/text` 已传 `AnimationInput.bubbleText`（本地代码注释）——Arbiter 的 active 文本即口型输入；打字机若启用，口型按「当前显示前缀」而不是整句，避免提前闭合。

### 6.4 需求④ 窥屏接口（只留接口）

**推荐（与 R4 任务协作，不重复设计；本节只给约束）**

- 按 §5.2 的 capability / permission / gate / observation schema / provider stub / 可回看 六件套落**类型 + stub + 设置项（默认关）+ 测试**；不实现采集/截图/OCR/窗口标题。
- **默认关闭 + fail-closed + 日志无内容** 三条作为测试断言（CI 门禁）。
- 与需求①的桥契约联动：`status.json.capabilities` 声明；未来 DSH 可请求观察时走控制通道 + 配额 + 聚焦模式 0。
- UI：本轮可显示禁用占位（灰色 +「需要屏幕录制/后续版本开放」）或完全隐藏；建议**隐藏 + 文档说明**，避免用户误以为已可用。

---

## 7. 可借鉴 / 不可借鉴总表（按来源）

| 来源（链接） | 许可证 | ✅ 可借鉴（模式，不搬代码） | ❌ 不可借鉴 / 注意 |
|---|---|---|---|
| [LINNoot/dsh-co-pet](https://github.com/LINNoot/dsh-co-pet) | MIT（代码）；社区素材 | UDP+状态文件双通道、autoLaunch、电源开关（spawn/quit）、8s 完成去抖、两行气泡（标题+状态+AI 摘要）、单实例、控制事件 | Windows 优先；素材不可直接用于本项目 |
| [mjw-git/dsh-pet](https://github.com/mjw-git/dsh-pet) | MIT | SSE 推送 + 轮询兜底、durable logs 重算、`/pet/reset` 作用域、Codex 精灵契约 | 页面内形态；XP/游戏化与本项目无关 |
| [anneheartrecord/dsh-desk-pet](https://github.com/anneheartrecord/dsh-desk-pet) | MIT | macOS 外部窗 AppKit/ctypes（避开 Tk 老版本渲染坑）、跨全屏 Space、state.json 单实例/`--stop`、默认关、`dsh web` 停则停、`--probe/--foreground` | 零依赖 Python 实现不套用 Electron；皮肤素材不可用 |
| [@linxin666/dsh-pet](https://www.npmjs.com/package/@linxin666/dsh-pet) | ⚠️ npm Apache-2.0 vs README BSD-3-Clause 冲突 | 多会话气泡栈 + `+N` 折叠、子代理归父、`pet.announce` 多来源槽位/TTL/最旧让位、`registerPanelAction`、fail-closed manifest 校验 | 许可证待复核；宠物美术 NC/版权各异 |
| [a8chann/dsh-pet-live2d](https://github.com/a8chann/dsh-pet-live2d) | MIT（插件）；模型 CC BY-NC-SA | 8 相位事件映射、相位→动作/台词/提示音三件套、气泡「一句话停留多久」可配、桌面/页面双形态 | Live2D 模型 NC；Cubism Core 专有不可随包分发 |
| [claude-pet](https://github.com/HaneulOscarLee/claude-pet) | MIT | hook 桥轻量+永远 exit 0、state.json+250ms 轮询、dwell/优先级聚合/stale CPU 检测、exit_when_no_sessions+grace、合并式 install-hooks、status/log/doctor | Linux 实现细节（X11/Wayland）不适用 macOS |
| [OpenPets](https://github.com/alterhq/openpets) / [OpenPetsKit](https://github.com/alterhq/OpenPetsKit) | MIT | 菜单栏 app + 本地 MCP + CLI + Unix socket 共享同一宠物、`threadId` 替换式气泡、`wake/stop` 控制语义、插件面（内置） | MCP 端口暴露风险（默认 127.0.0.1，警告不要 0.0.0.0）；宠物素材版权各异 |
| [openai/skills hatch-pet](https://github.com/openai/skills/blob/main/skills/.curated/hatch-pet/SKILL.md) | MIT（skill） | 9 状态语义、资产清单 + 校验 fail-closed、逐行 QA/contact sheet、运行记录 | 精灵图格式不适用 VRM；生成模型/图片服务有各自条款 |
| [codex-pet-bridge](https://github.com/vcxzvfe/codex-pet-bridge) / [Vibebud](https://github.com/Shellishack/vibebud) / [Talking Pets](https://github.com/arata-ai-daisuki/talking-pets) | MIT（各自 README） | agent 状态→事件桥（MCP/webhook/SSE）、多端 companion、从会话日志做本地 TTS | 只作模式；资产与实现细节不复用 |
| [ChisaAlter/WhaleIsle](https://github.com/ChisaAlter/WhaleIsle)（desktop-live2d-pet 文档） | 本次未核实 | **气泡仲裁**（优先级/同级队列/alertId/holdBubbles/pinned）、窥屏入口双层 gate、无模型不截屏、失败原因分池、per-window 点击穿透/热区 | 许可证未核实，不可引用代码；文档属中文工程笔记，仅模式 |
| [Peekaboo permissions](https://github.com/openclaw/Peekaboo/blob/main/docs/permissions.md) | 本次未核实 | TCC 权限矩阵、签名迁移重授权、Bridge host 归因、fail-closed 证据校验 | 不复制实现；权限文案需本地化 |
| [darkitten-pet](https://github.com/LFELKEEA/darkitten-pet) | MIT | 三档观察模式、默认关、隐私关键词闸门、截图不落盘、本地 OCR、插件权限声明 | 整屏截图、Windows-only |
| [N.E.K.O](https://github.com/Project-N-E-K-O/N.E.K.O) | Apache-2.0 | 屏幕评论污染隔离、来源标记、观察曝光 UI、Focus 滞回 | 其 Focus 非用户专注模式 |
| [Miru](https://github.com/kiyotakali/Miru) | Apache-2.0 | salience 分级/最小介入间隔/意图去重/捕获失败退避/用无权限信号替代键鼠钩子 | 整屏截图、无敏感闸门、截图 HTTP 外发 |
| [screenpipe](https://github.com/mediar-ai/screenpipe) | **商业许可** | 采集规则语法（App::Title include/exclude）、effective state、隐私页 IA、时间表、PII 遮蔽（只学信息架构） | **代码不可复制**；常驻全量录制不采用 |
| [BongoCat](https://github.com/ayangweb/BongoCat) | Apache-2.0（既有报告） | overlay 声明式配置 schema + fixture 契约测试 | 键鼠可视化玩法无关 |
| [LingChat](https://github.com/SlimeBoyOwO/LingChat) | **AGPL-3.0** | 主动互动节奏/兴趣/次数/投递闸门（只学参数思想） | **代码不可抄**（传染）；Win32 键鼠钩子 |
| [VPet](https://github.com/LorisYounger/VPet) | Apache-2.0（既有报告） | 专注计时会话状态机（TimeFinish/ManualStop/StateFail） | 养成经济系统 |
| [Mate-Engine](https://github.com/shinyflvre/Mate-Engine)（本地 `refs/`） | **AGPL v3 + MateEngine Pro License v2.1**；assets © Shiny 保留权利 | 气泡挂骨骼/跟随、打字机+despawn 参数、状态白名单触发、blockObjects 让路、注册表自启、氛围探针（160×90 四边带 HSV） | **代码与资产一律不可复制**（copyleft+非商业+保留权利）；`uWindowCapture` Windows-only |
| [MateEngine-CustomLLMAPI](https://github.com/maoxig/MateEngine-CustomLLMAPI) | MIT（+遵守 Mate-Engine 许可） | 本地 HTTP 代理把 LLMUnity 请求转发到 OpenAI 兼容 API 的扩展思路 | 仅作「外部 LLM 接入」思路；不用于本项目（DSH 已是唯一 agent） |
| [autobot-ai Streaming TTS](https://github.com/mrveiss/autobot-ai/blob/15161d7744f447a73b16e4fa515e17a0e56eeca4/docs/archives/plans/2026-03-02-streaming-tts-design.md) | 仓库许可未核实 | 句子累积器 + 完整句才派发 + stream end flush + barge-in 清队列 + 首句低延迟 | 文档级参考，不复制代码 |
| [launchd plist 字段参考](https://github.com/curiositech/port-daddy/blob/main/skills/macos-launchd-supervision/references/plist-field-reference.md) / [macOS 服务管理研究](https://github.com/robertelee78/swictation/blob/435c3b7e2ff40daa13bbc6f57a7ef0eba4ed4f9a/docs/macos-service-management-research.md) | 未逐一核实（文档） | KeepAlive/ThrottleInterval 语义、bootstrap/bootout、LimitLoadToSessionType、plist 权限、三态检查 | 示例代码（postinstall 等）不照搬 |
| [ss64 `open` 手册](https://ss64.com/mac/open.html) | N/A | `open -b/-a/-g/-n` 语义（幂等/前台/强制新实例） | 不要用 `-n`/`-W` 于本场景 |
| [Electron app API](https://www.electronjs.org/docs/latest/api/app) | MIT（Electron） | `requestSingleInstanceLock`/`second-instance`、`setLoginItemSettings`、`will-quit` 清理 | dev vs packaged 单实例差异 |
| [Apple SMAppService](https://developer.apple.com/documentation/servicemanagement/smappservice) / [NSRunningApplication](https://developer.apple.com/documentation/appkit/nsrunningapplication/) | N/A | 登录项/守护注册、按 bundle id 查运行 app | 需要 app bundle/macOS 13+ |
| 本地 `refs/dsh-blender-plugin`（BSD-3-Clause） | BSD-3-Clause（本地 LICENSE） | bundle 安装形态、**15s watchdog + probe 2 次失败才重启 + 先清尸再重生**、detached spawn + unref、`ctx.effect` 逆序释放、端口探测=唯一可信判据、pause 语义、doctor/health | 与 Blender 强耦合的部分不搬 |
| 本地 `refs/reze-rig`（MIT） | MIT | 历史路线参考，本项目已不依赖 | — |
| 本地 `docs/research/screen-awareness-privacy-focus-feasibility-2026-11-11.md` | 项目内文档 | 既有窥屏报告的三档/闸门/节流/聚焦/项目对比与参数 | 本文不整段照抄；引用其项目与参数 |

---

## 8. 来源与取证说明（URL 汇总）

**DSH 官方/插件生态（A/B）**
- 官方仓库（Everything is a Plugin）：https://github.com/deepseek-ai/deepseek-harness
- 插件开发指南（host/client/bundle/事件/路由/slots）：https://github.com/NanmiCoder/dsh-agent-teams/blob/v0.1.15/docs/developing-dsh-plugins.md
- 插件目录：https://dshplugin.dev/ ；https://dshbase.com/zh/plugins/directory/ ；https://dsh-plugins.tech/directory/interface/personalization-and-expression/desktop-pets-and-companions/status-visualization-pets
- 精选列表：https://github.com/LingHXiao/awesome-dsh-plugin
- 桌宠实现：见 §1.1 表内链接（`mjw-git/dsh-pet`、`LINNoot/dsh-co-pet`、`anneheartrecord/dsh-desk-pet`、`zhu1090093659/dsh-pet`/`@linxin666/dsh-pet`、`ankesu/dsh-live2d-pet`、`a8chann/dsh-pet-live2d`、`ysyyhhh/dsh-pet`、`liyupi/dsh-kun-like-pet`）

**Codex / Claude / 通用桌宠（A/B）**
- Codex pet 官方 skill：https://github.com/openai/skills/blob/main/skills/.curated/hatch-pet/SKILL.md
- Codex 宠物社区索引：https://github.com/alterhq/awesome-codex-pets-projects ；https://codex-pets.net/ ；https://openpets.sh
- OpenPets：https://github.com/alterhq/openpets ；OpenPetsKit：https://github.com/alterhq/OpenPetsKit
- claude-pet：https://github.com/HaneulOscarLee/claude-pet （Windows 版 https://github.com/SHIN620265/claude-pet）
- 其它：https://github.com/rullerzhou-afk/clawd-on-desk ；https://github.com/vcxzvfe/codex-pet-bridge ；https://github.com/Shellishack/vibebud ；https://github.com/arata-ai-daisuki/talking-pets
- 流式 TTS/句子切分：https://github.com/mrveiss/autobot-ai/blob/15161d7744f447a73b16e4fa515e17a0e56eeca4/docs/archives/plans/2026-03-02-streaming-tts-design.md

**Mate-Engine（D/B）**
- 上游：https://github.com/shinyflvre/Mate-Engine ；本地只读副本 `refs/Mate-Engine`（HEAD `2c5ea6b8`）
- 外部 LLM API Mod：https://github.com/maoxig/MateEngine-CustomLLMAPI

**macOS（A/B）**
- Electron app：https://www.electronjs.org/docs/latest/api/app
- `open`：https://ss64.com/mac/open.html
- launchd plist 字段：https://github.com/curiositech/port-daddy/blob/main/skills/macos-launchd-supervision/references/plist-field-reference.md
- macOS 服务管理研究：https://github.com/robertelee78/swictation/blob/435c3b7e2ff40daa13bbc6f57a7ef0eba4ed4f9a/docs/macos-service-management-research.md
- Apple：SMAppService https://developer.apple.com/documentation/servicemanagement/smappservice ；NSRunningApplication https://developer.apple.com/documentation/appkit/nsrunningapplication/ ；TCC 资源 https://developer.apple.com/documentation/security/accessing-protected-resources
- 权限矩阵/fail-closed：https://github.com/openclaw/Peekaboo/blob/main/docs/permissions.md

**屏幕感知/窥屏（A/B；许可证详见 §7）**
- darkitten-pet：https://github.com/LFELKEEA/darkitten-pet
- N.E.K.O：https://github.com/Project-N-E-K-O/N.E.K.O
- Miru：https://github.com/kiyotakali/Miru
- LingChat：https://github.com/SlimeBoyOwO/LingChat
- screenpipe：https://github.com/mediar-ai/screenpipe
- BongoCat：https://github.com/ayangweb/BongoCat
- VPet：https://github.com/LorisYounger/VPet
- WhaleIsle 桌宠文档：https://github.com/ChisaAlter/WhaleIsle/blob/main/docs/features/desktop-live2d-pet.md
- Peekaboo permissions：https://github.com/openclaw/Peekaboo/blob/main/docs/permissions.md
- 项目既有报告：`docs/research/screen-awareness-privacy-focus-feasibility-2026-11-11.md`

**豆包（C，二手，仅产品形态）**
- https://www.php.cn/faq/2641353.html ；https://www.php.cn/faq/2104935.html ；https://m.gameyj.com/down/55200.html ；https://www.aitop100.cn/infomation/details/34322.html ；https://www.toutiao.com/article/7665155223182180890/ ；https://apps.apple.com/cn/app/%E8%B1%86%E5%8C%85/id6683305962

---

## 9. 未决问题 / 低置信项（写进后续任务，不要当事实用）

1. **codex-pet.org 抓取超时/不可达**：Codex 官方宠物产品文档未直接取证；以 OpenAI curated `hatch-pet` skill（A）为契约依据。`codex-pets.net` 等社区画廊的素材许可证未逐包核验。
2. **`@linxin666/dsh-pet` 许可证冲突**（npm `Apache-2.0` vs README `BSD-3-Clause`）：采用前必须读仓库 `LICENSE` 原文；本项目只参考模式，不复制。
3. **WhaleIsle / Peekaboo / autobot-ai / port-daddy / swictation 的许可证本次未核实**：引用其**文档模式**可以，**代码不采**；如后续要抄接口设计，需先补 `LICENSE` 取证。
4. **豆包悬浮球/桌宠**：无一手技术文档；互保活/气泡机制不可引用；本文只保留「产品形态」结论。
5. **DSH 事件真实形状/动态插件总线差异**：本文引用的是社区项目在各自 DSH 版本上的观察（如 `dsh-kun-like-pet` 的 831 次观测），**最终以 R2（`docs/research/dsh-harness-audit-2026-11-11.md`）的源码/实机结论为准**；`bridge-schema.ts` 扩展前需与 R2 对齐字段名。
6. **macOS 版本差异**：TCC 设置页命名（macOS 27+ 改为「Device Control and Data Access」）、SMAppService、`systemPreferences.getMediaAccessStatus` 行为随版本变化；`open -b`/`lsappinfo` 输出格式需真机验证。
7. **性能/体积**：社区项目未提供统一基准；本项目沿用自己 Wave 2 的 FPS/内存测量，不引用社区数字。
8. **「官方 dsh-pet」**：截至本次检索，未发现官方 scope 下的桌宠包；目录中名称含 `dsh-pet` 的均为社区项目（`mjw-git/dsh-pet`、`@linxin666/dsh-pet`、`ysyyhhh/dsh-pet` 等），**不要**在文档中称其为官方。

---

> 报告完（只读调研；唯一写入文件 = 本文件）。后续如果需要把本文结论落成实现，建议按 Lead 的 Wave 3 任务拆分：互保活（桥插件 config + 宠物侧拉起 + 单测）、气泡 Arbiter（纯逻辑 + 单测）、桥字段扩展（phase/summary/sessionId，需与 R2 对齐）、窥屏接口（与 R4 设计对齐，只落类型/stub）。
