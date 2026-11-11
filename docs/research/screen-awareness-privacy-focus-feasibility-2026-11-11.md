# 桌宠「窥屏实时互动 + 隐私保护 + 聚焦模式」参考项目对比与可行性方案

> 日期：2026-11-11
> 项目基线：`main` @ `3893943`（读取时工作树无未提交改动；另一会话可能继续提交，本文按**模块/符号**定位，不按行号强绑）
> 范围：只做调研、对比与方案；**本轮不改代码**。
> 关联：`PLAN.md` §10/§11、`docs/packaging.md` §3（TCC 红线）、`native/winlist/README.md`、`docs/research/repos-audit.md`

---

## 0. 一页结论

**一句话方案**：把「窥屏」拆成四层能力，**实时互动靠零权限的元数据层（P0）**，内容理解靠低频、单窗口、可回看的抽样层（P2/P3）；隐私不是事后脱敏，而是**采集前就 fail-closed 的规则引擎 + 采集后不可回放的内存态**；聚焦模式是**独立于系统 Focus 的应用内状态机**，不依赖私有 API。

**选型结论（每个项目只取一块）**

| 项目 | 许可证 | 取它什么 | 明确不取什么 |
|---|---|---|---|
| `LFELKEEA/darkitten-pet` | MIT | **产品级三档观察模式**（window / ocr / vision）、隐私闸门清单、默认关闭、截图不落盘、提示词 `SKIP`、OCR 行级脱敏 | 整屏截图（`screen.grabWindow(0)`）——隐私最弱的一环；Windows-only 实现 |
| `Project-N-E-K-O/N.E.K.O` | Apache-2.0 | **屏幕评论污染隔离**（来源标记、原始记录 ≠ 模型上下文）、观察曝光 UI、Focus 滞回状态机、图片规格统一 | 它的 Focus 是「模型思考预算」，不是用户专注模式，不能直接当产品功能 |
| `SlimeBoyOwO/LingChat` | AGPL-3.0 | **主动互动节奏系统**：UserState 分类、加权意图路由、interest 累积/衰减、`max_proactive_times`、投递闸门、9×8 dHash 变化检测 | 代码不能抄（AGPL 传染）；Win32 键鼠钩子（要辅助功能权限、Windows-only） |
| `kiyotakali/Miru` | Apache-2.0 | **注意力节流**：salience 分级延迟、15 分钟最小介入间隔、30 分钟意图去重、聊天中静默、捕获失败退避、`ioreg` 读空闲（macOS 无权限） | 整屏 `screencapture`、无敏感应用闸门、截图经 HTTP 发后端——这三条都不取 |
| `mediar-ai/screenpipe` | 商业许可 | **采集规则引擎**（`App::Title` 作用域、ignored/included、effective state）、隐私设置页信息架构、采集时间表、PII 遮蔽 | 常驻全量录制（不是我们的场景）；代码不可复制（商业许可） |
| `ayangweb/BongoCat` | Apache-2.0 | **overlay 行为的声明式配置 schema**（clickThrough / hideOnIdle / hideOnHover / keepInsideScreen / maxFps）+ fixture 驱动契约测试 | 键鼠可视化玩法（与本项目无关） |
| `Mate-Engine`（本地 refs） | 混合许可 | **氛围探针**：160×90 采样 + 四边带 HSV 平均 + 排除自身窗口矩形，只产出 4 个颜色值 | `uWindowCapture`（Windows-only，抓到的是窗口纹理，不是给模型看的内容）；窗口吸附已在 B5 实现 |
| `LorisYounger/VPet`（可选） | Apache-2.0 | 专注计时的**会话状态机**（TimeFinish / ManualStop / StateFail）与「时长→成果」反馈 | 它的养成经济系统（与本项目人设不符） |

**可行性判断**：可行，且不需要动渲染/动画/物理主干。新增的是**采集侧 native helper + 共享纯逻辑 + 一层主进程编排 + 设置页**。粗估 18–28 人日（不含打包公证与真机权限反复调试），分四期，每期都可独立交付、独立回滚。

**已定决策**（2026-11-11）：
1. **接受新增 macOS「屏幕录制」TCC 权限**，内容级能力（P1–P3）纳入范围。
2. **默认档位 = `ocr`**（前台单窗口截图 + 本机 Vision OCR），**权限被拒 / 被撤销时自动降级 `metadata`**，不阻断应用启动与 P0 互动。
3. macOS 15 起系统会周期性复核录屏授权——降级路径因此必须常驻，但它不再决定默认档位。

---

## 1. 我们现在的基线（证据表）

| 能力 | 现状 | 证据 | 等级 |
|---|---|---|---|
| 透明 overlay / 置顶 / 全屏可见 | 已有 | `src/main/windows/overlay-manager.ts`：`setAlwaysOnTop(true,'screen-saver')`、`setVisibleOnAllWorkspaces(true,{visibleOnFullScreen:true})` | confirmed |
| 点击穿透 + 悬停拦截 | 已有 | `src/main/windows/mouse-gate.ts`、`src/main/ipc/window.ts` | confirmed |
| 窗口枚举（250ms） | 已有 | `src/main/ipc/desktop.ts`：`POLL_INTERVAL_MS=250`；`native/winlist/main.swift` | confirmed |
| 窗口标题 | **没有** | `native/winlist/main.swift` 注释明确不读 `kCGWindowName`；`docs/packaging.md` §3「读窗口名/截图才需要该权限」 | confirmed |
| 屏幕录制权限 | **没有** | 同上；`src/main` 无 `getMediaAccessStatus` 调用点 | confirmed |
| 行为状态机 / 自主活动 | 已有 | `src/renderer/src/behavior/behavior-director.ts`；`BehaviorInput`/`BehaviorConfigSubset` 在 `core/wave2-contract.ts` | confirmed |
| 外部反应注入 | 已有 | `src/main/desktop/dsh-watch.ts` + `src/renderer/src/reactions/dsh.ts` + `ExternalReaction` | confirmed |
| 气泡 / 台词 | 已有 | `src/renderer/src/core/bubble.ts`、`core/voicelines.ts` | confirmed |
| 配置持久化 | 已有 | `src/main/config-store.ts`：版本不符→回退默认；未知键丢弃；新增可选键会自动回填 | confirmed |
| 透明度 | 已有 | `src/renderer/src/scene/pet-scene.ts::setOpacity`（只改 canvas CSS） | confirmed |
| FPS 上限 | 已有 | `src/renderer/src/scene/fps-limiter.ts::FrameRateController` | confirmed |
| 空闲时长 | **没有** | `CGEventSourceSecondsSinceLastEventType` 未被调用 | confirmed |
| 麦克风占用 | **没有** | 无 CoreAudio 调用点 | confirmed |
| 系统 Focus / DND 状态 | **没有**，且**无公开 API** | — | unknown（见 §8） |

**基线判断**：现有 app 是「几何感知」型桌宠——知道窗口在哪、能坐上去、能跟窗口动，但**完全不知道窗口里是什么**，也不知道用户在不在、在不在开会。要做的三件事恰好补的是这三块空白。

---

## 2. 参考项目拆解（只列与本题相关的部分）

### 2.1 darkitten-pet（MIT，Windows / PySide6 + Live2D）

**它做对了什么**

- **三档模式 + auto 降级**：`screen_watch.mode ∈ {window, ocr, vision, auto}`；`auto` 在模型不支持视觉时退回 `window`（`screen_watcher.py::_resolved_mode`）。这是「能力不够就别硬上」的正确姿势。
- **隐私闸门是硬编码的 pre-gate，不是 prompt 软约束**（`ScreenWatcher.observe`）：
  1. 用户隐藏 / 睡觉 → 跳过；
  2. 聊天窗打开 / 语音中 → 跳过；
  3. 距上次互动 `< min_idle_seconds`（默认 45s）→ 跳过；
  4. 前台窗口命中 `SENSITIVE_PROCESSES`（1Password/Bitwarden/远程桌面/虚拟机…）或标题命中 `SENSITIVE_TITLE_WORDS`（密码/验证码/支付/银行/无痕/隐私…）→ 跳过；
  5. 全屏应用（窗口 rect 与 monitor rect 误差 ≤2px）→ 跳过；
  6. 插件 `screen.context` 可再否决（"先让插件补充或跳过，再决定是否截屏，避免白截一张隐私画面"）。
- **数据最小化**：截图只在内存里压缩（`QImage`→JPEG，`max_edge` 1280 / quality 68），**不写磁盘**；OCR 临时图放 `C:\Users\Public\LFELKEEA\ocr` 且结束删除；OCR 结果按行丢弃命中 `REDACT_WORDS` 的行（`_redact_sensitive_text`）。
- **提示词层兜底**：系统提示要求「只说 1–2 句、只挑安全细节、绝不复述密码/账号/验证码/聊天内容/文件名/网址/代码/邮件；不确定就模糊；涉及隐私只回 `SKIP`」。
- **节奏**：`interval_seconds` 默认 120，实际延迟 `interval × uniform(0.85, 1.15)`，下限 15s 启动（`_schedule`）。
- **默认关闭**：`config.screen_watch.enabled = False`。

**它做错了什么（我们必须改）**

- `capture_screen()` 抓的是**主屏整屏**（`QGuiApplication.primaryScreen().grabWindow(0)`）。这意味着：通知、私聊、密码框、别的窗口全都进画面。即使有闸门，只要前台是「安全的应用」，画面里仍可能有敏感内容。
- 闸门是**标题/进程名关键词**，误判率取决于词表；没有「未知应用默认拒绝」的策略。
- 没有「用户可回看刚刚看到了什么」的透明面板；没有规则引擎；没有错误输出过滤器（模型若复述了内容，会直接 `say`）。

**结论**：取它的**产品结构**（模式、闸门顺序、默认关闭、内存态、SKIP、行级脱敏），不取它的**采集粒度**（整屏）。

---

### 2.2 N.E.K.O（Apache-2.0，Python + React，实时语音/视觉 companion）

**它做对了什么**

- **屏幕评论污染隔离**（`docs/design/screen-history-local-reference.md`，0A-1 已实现 `utils/screen_comment_guard.py::project_screen_history`）：
  - 问题定义不是「标签泄漏」，而是**异常回答进入历史后变成 few-shot 示例**，导致下一轮重放或串场景；
  - 「普通生成 / 逐字引用 / 引用内容的翻译分析」是三种任务，权限不能互相继承；
  - **原始记录、用户可见交付记录、自动模型上下文分开**：完整保存 ≠ 自动注入，隔离 ≠ 删除；
  - 引用原文及派生结果默认不进入后续普通生成上下文。
- **观察曝光**：`frontend/react-neko-chat/src/ScreenObservationExposure.tsx` 把「本轮有屏幕观察」作为可曝光、可交互的 UI 锚点（`recommendationId` → `proactive_recommendation_shown`），不是偷偷发生。
- **Focus 状态机**（`docs/design/focus-truename-mode.md`）：`REGULAR --charge>=enter--> FOCUS`，退出靠 decay / topic change / hard cap；`episode/turn token` 防旧异步回调污染新 episode；总开关默认关闭。**滞回**（hysteresis）思想可直接搬到我们的「自动进入/退出专注」判定，避免在阈值附近抖动。
- **图片规格统一**：`utils/screenshot_utils.py` 前端 1280 宽 / 后端 720 高 / JPEG 80，两端同一口径，避免「前端 1280、后端不限宽」的 5120×1440 惨案。

**它不适合直接搬什么**

- 它的 Focus 是**模型思考预算**（provider thinking 参数），不是用户生产力专注模式；只能借状态机与滞回，不借语义。
- 它的屏幕观察是「主动搭话」的一路输入，没有独立规则引擎与权限分层（权限由前端能力决定）。

**结论**：取**记忆边界 + 曝光 UI + 滞回**，这是「窥屏不变成监视」的关键。

---

### 2.3 LingChat（AGPL-3.0，Rust/Tauri）

**它做对了什么**（`src-tauri/src/ai_service/proactive_system/*`）

- **用户状态分类**（`activity_monitor.rs::get_user_status`）：20s 滑窗统计 keystrokes / game keys / clicks / mouse distance →
  - 无输入 → `IDLE`（interest modifier **-15**）
  - 少键 + 大鼠标位移/多点击 → `BROWSING`（**+10**）
  - 键多且游戏键占比 ≥0.6 且 >20 次，或点击 >30 且占比 ≥0.4 → `GAME`（**+20**）
  - 键多但非游戏 → `WORK`（**-10**）
  - 其余 → `CASUAL`（0）
- **加权意图路由**（`strategy_dispatcher.rs`）：优先级 `重要日 > Todo > 屏幕观察 > 话题`；屏幕权重在 `GAME` 时 60、其他 30；用轮盘赌选意图，而不是每轮都看屏幕。
- **兴趣累积/衰减**（`interest_manager.rs`）：每次 tick `interest += U(5,10)`，上限 100；触发概率 `(interest + status_mod - 50)/50`；每次发言 `interest=0`、`proactive_times++`、`max_interest_cap -= 50/max_proactive_count`（下限 50）；`restore` 重置。配合 `max_proactive_times` 默认 **3**，形成「说 3 次就明显变安静」的节流。
- **投递闸门**（`delivery_evaluator.rs`）：所有意图投放前必经；`can_deliver` 由前端上报（聊天界面 + 无设置面板 + 输入为空）。
- **画面变化检测**（`visual_monitor.rs`）：9×8 像素网格灰度 → 64-bit dHash；Hamming distance ≥6 才算「画面变了」。**没变就不看**，这是省 token 的关键。

**不能搬的**

- 代码是 AGPL-3.0：抄进本项目会要求整体 AGPL 化。**只借参数与结构，不复制实现**。
- Win32 低级键鼠钩子：macOS 对应能力要「输入监控/辅助功能」权限，代价远大于收益；我们用 `CGEventSource` 的空闲时长替代（无权限）。

**结论**：取**节奏模型**（状态权重 + 兴趣 + 次数上限 + 投递闸门 + dHash），这是「实时但不烦人」的核心。

---

### 2.4 screenpipe（商业许可，Rust/Tauri，常驻屏幕记录）

**它做对了什么**

- **规则语法**（`crates/screenpipe-core/src/window_pattern.rs`）：
  - `App` → 应用名或标题包含（历史语义，逻辑 OR）；
  - `App::Title` → 应用包含 **且** 标题包含（作用域规则）；
  - `::Keyword` → 任意应用、标题包含；
  - `App::` → 等价于 `App`。
- **有效状态而不是字符串袋子**（`apps/.../lib/settings/capture-filters.ts`）：每个 app 计算 `captured / ignored / partial / outside-allowlist`，并单独标 `blockedIndirectly`（被过宽规则误伤，例如规则 `bit` 吞掉 Bitwarden）。UI 直接回答「Bitwarden 现在会不会被截」。
- **隐私设置页信息架构**（`components/settings/privacy-section.tsx` + `schedule-settings.tsx`）：内容过滤（应用/窗口）、排除网站、忽略无痕窗口、PII 遮蔽、采集时间表（按星期 + 时段 + 模式）、隐私处理状态、应用后重启提示。
- **无痕识别是显式能力，不是猜**：`planEnhancedIncognitoPermission` 把「哪些浏览器在跑、授权状态、Arc 走 Accessibility、其他走 Automation」拆成 `ready / prompt / settings / arc-only / open-browser` 五种 UI 决策。

**不能搬的**

- 它是「常驻全量录制」，我们的产品承诺相反（低频、按需、不落盘）。只借**规则引擎与设置页**。
- 商业许可：不可复制代码。

**结论**：取**规则引擎 + 有效状态 + 设置页结构**。这是「用户能自己管住它」的基础。

---

### 2.5 BongoCat（Apache-2.0，Tauri）

**它做对了什么**（`shared/config/fixtures/accept-idle-hide.json`、`config.schema.json`）

- overlay 行为完全声明式：
  ```json
  "overlay": {
    "click_through": false,
    "hold_modifier_to_interact": null,
    "always_on_top": true,
    "scale_percent": 100,
    "opacity_percent": 100,
    "corner_radius_percent": 0,
    "hide_on_pointer_hover": false,
    "hide_on_pointer_hover_delay_seconds": 0,
    "hide_on_idle": true,
    "hide_on_idle_delay_seconds": 10,
    "keep_inside_screen": true,
    "maximum_fps": 60
  }
  ```
- 每个字段都有 `accept-*.json` fixture 与 schema，**配置契约可测**。

**结论**：取**配置 schema + fixture 测试**的写法，用于我们的「低打扰」行为（隐藏/淡出/降帧/穿透），让专注模式的表现不是散落的魔法数字。

---

### 2.6 Mate-Engine（本地 refs，Unity；混合许可）

**它做对了什么**（`Assets/MATE ENGINE - Scripts/Tools/DesktopAmbientProbe.cs`）

- **氛围探针**：把全屏 `StretchBlt` 到 **160×90**，只在宠物窗口矩形的**四条边带**（`bandThicknessPx=120`，按屏高换算）取平均色，**排除自身窗口矩形**（`Exclude(inside)`），`RGB→HSV`，`smoothing=0.85` 平滑，10Hz 驱动四盏灯。
- **关键设计**：它从不保存、不上传、不识别内容，只产出 4 个 `Vector3`（H/S/V）。这是「有感知、但没有信息」的中间层。
- `uWindowCapture` 是 Windows Graphics Capture/PrintWindow 的封装，用于把窗口内容当纹理渲染（`UwcWindowTexture`），**不是给模型看的截图**；macOS 不可用。

**结论**：取**氛围层**作为「用户拒绝内容级权限、但仍想要实时反应」的折中；窗口捕获层不取（B5 已有更合适的 CGWindowList 几何方案）。

---

### 2.7 Miru（Apache-2.0，Python/Flask + Live2D，macOS/Windows/Android）

**它做对了什么**

- `sensor.py` 的采样默认值：`CHECK_INTERVAL=30s`、`MIN_INTERVAL=5s`、`CHANGE_THRESHOLD=0.30`（200×150 缩略图上 **30% 像素差**才算变化）、`CAPTURE_MAX_SIZE=1920×1080`、`JPEG_QUALITY=60`；`_user_enabled` **默认 false**。
- **捕获失败退避**：连续 3 次失败 → 暂停捕获，记录原因，到点自动重试；用户重新授权后 `reset` 立即恢复。这解决了「没权限时每 30 秒失败一次、日志刷屏、还可能反复触发系统提示」的经典问题。
- `get_system_idle_seconds()`：macOS 走 `ioreg -c IOHIDSystem -d 4` 读 `HIDIdleTime`，**不需要任何权限**，也不碰键鼠内容。这条直接印证了我们的 P0 空闲探测可行。
- `attention_engine.py` 的**节流参数**（比 LingChat 更贴近成品）：
  - `PROACTIVE_MIN_INTERVAL_SECONDS = 15 * 60`（两次主动介入至少 15 分钟）；
  - `INTENT_DEDUP_SECONDS = 30 * 60`（同类意图 30 分钟内去重）；
  - `ACTIVE_CHAT_PROACTIVE_SILENCE_SECONDS = 2 * 60`（用户正在聊天时静默 2 分钟）；
  - `SIGNAL_BUFFER_MAX = 160` / `SIGNAL_BUFFER_AGE = 3600`（信号只留 1 小时，防止无限累积）；
  - `INTENT_QUEUE_LIMIT = 40`；
  - **salience 分级延迟**：`strong 10–20s` / `normal 60–90s` / `weak 180–300s`（越重要越不拖）；
  - 内部状态集 `observing / settled / focused / waiting / concerned / celebrating / curious / quiet`，**「focused」是显式状态**。
- **决策与措辞分离**：Attention LLM 只决定「说不说」，主 agent 才负责「怎么说」。这避免了「让一个模型同时判断时机和组织语言」时常见的过度表达。
- `screen_analyzer.py`：VLM 调用有 per-device 冷却（`DEFAULT_VLM_INTERVAL=10s`，下限 5s）、观察文本去重、`significance` 分级（`sig>=2` 只进 Attention，不进记忆）。

**它做错了什么（我们必须改）**

- **整屏 `screencapture`**（错误信息里出现 `screencapture failed`），没有单窗口捕获。
- **没有敏感应用/标题/全屏/通话闸门**——`sensor.py` 里搜不到 `password / incognito / sensitive / fullscreen` 这类判断。它的隐私承诺是「自托管 + 截完即弃」，而不是「采集前拒绝」。
- 截图经 **HTTP POST**（localhost 或 LAN/服务器）交给后端，进程间有落点；我们的设计是 **helper 内存 → stdout → 主进程内存**，更严格。
- 它的「截屏写记忆」链路在 2026-05 之后处于半废弃状态（`docs/SCREENSHOT_REFACTOR_TODO.md` 记录 `trigger_route_async` 变成 no-op），**不能把它的记忆管线当可靠参考**。

**结论**：取**采样/退避/节流/空闲探测**这四组参数与机制；不取采集粒度、隐私模型与 HTTP 架构。它是「节奏工程」的最好参考，不是「隐私工程」的参考。

### 2.8 VPet（Apache-2.0，WPF，可选）

**它做对了什么**：`WorkTimer.xaml.cs` 的会话状态机把「工作结束」分成 `TimeFinish / MenualStop / StateFail / Other`，并且有「剩余时间 / 已获取收益」两种显示模式。这是专注模式「结束原因要可解释」的最小模型。

**结论**：可选参考「计时结束语义」，不取养成经济。

---

## 3. 对比矩阵与选型

| 维度 | darkitten | N.E.K.O | LingChat | Miru | screenpipe | BongoCat | Mate-Engine | 本项目取谁 |
|---|---|---|---|---|---|---|---|---|
| 感知粒度 | 整屏/窗口标题 | 屏幕 + 语音 | 整屏 + VLM | 整屏 + VLM | 整屏常驻 | 无 | 160×90 氛围 | **分层 P0–P3**（darkitten 结构 + Mate 氛围） |
| 隐私默认 | 关；闸门关键词 | 曝光 UI | 关（默认 `enable_proactive_system=false`） | 关；截完即弃，**无闸门** | 开（产品即录屏） | 无 | 无 | **默认 `ocr` + 首次确认 + 拒绝降级 `metadata`**（darkitten + screenpipe） |
| 权限成本 | Windows 低 | 视部署 | Windows 钩子 | 录屏常驻 | 录屏常驻 | 无 | 录屏 | **P0 零权限，P2/P3 才要录屏** |
| 节奏控制 | 定时 + 抖动 | 状态机滞回 | **兴趣/次数/权重/投递闸门** | **salience/15min/去重/静默窗口** | 时间表 | idle/hover 隐藏 | 无 | **LingChat 兴趣 + Miru 节流 + screenpipe 时间表** |
| 聚焦/低打扰 | 5 分钟插件计时 | 模型 Focus | 无 | `focused` 显式状态 | 时间表 | **overlay 行为配置** | 无 | **BongoCat 配置 + VPet 状态机 + 自研** |
| 透明/可审计 | 仅状态文案 | **曝光标记** | 日志 | 仅日志 | **有效状态 + 隐私页** | 无 | 无 | **screenpipe 页 + N.E.K.O 曝光** |
| 记忆边界 | 无 | **污染隔离** | 无 | 截屏写记忆半废弃（不可靠） | 无 | 无 | 无 | **N.E.K.O** |
| 许可可复制性 | MIT ✅ | Apache ✅ | AGPL ❌ | Apache ✅ | 商业 ❌ | Apache ✅ | 混合 ⚠️ | 只抄 MIT/Apache 的实现；AGPL/商业只借设计 |

**Miru 的四个补充贡献（不改变上面的主选型）**

1. **捕获失败退避**：连续 3 次失败暂停，超时自动重试，授权后立即恢复——这是「没权限」场景的正确工程处理。
2. **两级节奏**：`salience` 决定延迟（strong 10–20s / normal 60–90s / weak 3–5min），`PROACTIVE_MIN_INTERVAL=15min` 决定「说话」下限；二者正交。
3. **意图去重 + 聊天静默**：同类意图 30 分钟内不重复；用户正在对话时静默 2 分钟。
4. **空闲探测的 macOS 实现**：`ioreg` 读 `HIDIdleTime`，零权限、零内容。

**最终参考组合（按模块）**

```
感知分层与闸门   ← darkitten-pet（结构） + Mate-Engine（氛围层）
规则引擎与透明页 ← screenpipe（语法/有效状态/设置页）
互动节奏         ← LingChat（状态权重/兴趣/次数） + Miru（salience/去重/退避）
记忆与曝光       ← N.E.K.O（来源标记/污染隔离/曝光锚点）
低打扰表现       ← BongoCat（overlay 配置 schema + fixtures）
专注计时         ← VPet（结束原因状态机） + 自研
```

---

## 4. 方案总体设计

### 4.1 感知分层（权限 / 成本 / 隐私）

| 层 | 能力 | 数据形态 | 新权限 | 单次成本 | 默认 | 可还原内容？ |
|---|---|---|---|---|---|---|
| **P0 元数据** | 前台 app（`WindowInfo.owner`）、窗口几何、是否全屏、空闲时长、麦克风占用（仅布尔）、专注会话、DSH 状态 | 名称/数值 | **无** | ~0 | **开** | 否 |
| **P1 氛围** | 160×90 采样、四边带 HSV、亮度/饱和度、变化率 | 4–8 个浮点 | 录屏 | 低（<10ms） | 关（可选） | 否（不足以还原） |
| **P2 本地文本** | 前台**单窗口**截图 → Vision OCR → 行级脱敏 | 文本（本机） | 录屏 | 中（50–150ms） | 关 | 是（文本） |
| **P3 视觉** | 前台**单窗口**截图 → 缩放 JPEG → VLM | 图像（可能出网） | 录屏 + 网络 | 高（2–10s + token） | 关 | 是 |

**关键判断**：**P0 就能撑起「实时互动」**。窗口列表已经 250ms 轮询，app 切换在 1s 内可感知；空闲时长与麦克风占用都是零权限信号。P2/P3 只负责「理解内容」，天然低频。

**为什么 P1 值得保留**：它是「拒绝内容级权限但想要生命感」的唯一折中——宠物能对屏幕色温/明暗变化做反应（例如深夜变暖、游戏画面高饱和时扭头看），但拿不到任何可读信息。Mate-Engine 已经证明 160×90 + 四边带足够驱动视觉反应。

**P1/P2/P3 的采集对象**：**优先单窗口**（前台窗口），不是整屏。
- 单窗口捕获天然排除通知、私聊、宠物 overlay、其他应用；
- 单窗口在 ScreenCaptureKit 里是 `SCContentFilter(desktopIndependentWindow:)`；
- 若窗口最小化 / 尺寸为 0 / 在别的 Space 不可得 → **跳过本次**，不回退整屏。

### 4.2 实时互动管线

```
事件源（P0）
  ├─ windows-updated（250ms，已有）→ 前台 app 变化 / 全屏进入退出 / 窗口开关
  ├─ idle poll（5s）→ active / idle / away
  ├─ mic poll（10s）→ 是否在通话
  ├─ focus session → 专注状态
  └─ 低频抽样（90–180s，P1/P2/P3，需权限）
        ↓
[Gate 1 隐私/状态闸门]  fail-closed
        ↓
[Perceive 状态分类]  WORK / GAME / BROWSE / CALL / AWAY / IDLE
        ↓
[Interest 兴趣与预算]  累积/衰减 + 每小时上限 + 冷却
        ↓
[Intent 加权选择]  观察屏幕 / 关心休息 / 任务进展 / 闲聊 / 不说话
        ↓
[Gate 2 投递闸门]  气泡占用 / 聊天打开 / 通话中 / 专注中 / 刚互动过
        ↓
[两层输出]
   ├─ 非语言反应：转头/眼神/蹦一下（无台词，5s 冷却，静默模式关闭）
   └─ 语言介入：1–2 句 + 输出过滤器（失败则沉默；≥10min 间隔）
```

**为什么必须分两层**：用户要的「实时互动」里，**大部分魅力来自不说话的反应**（切到 IDE 时扭头看一眼、写久了伸个懒腰）。把「实时」和「说话」解耦，才能既灵敏又不烦人——这也是 Miru「Attention 只决定说不说、主 agent 才决定怎么说」与 LingChat「投递闸门」的共同结论。

**语言介入的 salience 分档**（借 Miru，改小延迟以适配桌宠）

| 级别 | 例子 | 延迟 |
|---|---|---|
| `strong` | 专注段自然结束、从 30 分钟离开后回来、连续报错 | 10–30s |
| `normal` | app 类别切换、同一状态持续 45 分钟 | 60–120s |
| `weak` | 氛围色温变化、窗口开关 | 3–5min，通常不发言 |

**状态分类（P0，零权限）**

| 状态 | 判定（建议阈值） | 说明 |
|---|---|---|
| `CALL` | CoreAudio `kAudioDevicePropertyDeviceIsRunningSomewhere` 为 true 持续 ≥20s（**只读布尔，不读音频**），或前台是会议 app | 最高优先级，硬静音 |
| `GAME` | 前台 app 命中游戏类别，且窗口全屏 | 不打扰 |
| `WORK` | 前台 app 属于 IDE/Office/设计/终端，且 10 分钟内 app 切换 ≤2 次 | 低打扰 |
| `BROWSE` | 前台浏览器，且非全屏 | 可互动 |
| `AWAY` | 空闲 5–15 分钟 | 不互动，回来再问候 |
| `IDLE` | 空闲 >15 分钟 | 睡眠表现 |
| `CASUAL` | 其余 | 正常 |

> 注意：这里**不用键鼠钩子**（LingChat 的做法需要 macOS 输入监控权限）。用「前台 app + app 切换频率 + 空闲时长」近似，精度略低但零权限。`inferred`，需真机验证分类准确率。

**兴趣模型（改编自 LingChat，重新配参）**

- `interest ∈ [0,100]`；**活跃时每 1 分钟 `+U(2,4)`**（≈ 90–180/小时，封顶 100）；app 类别切换 `+15`；专注段完成 `+20`。
- 发言后 `interest = 0`，`proactiveTimes++`，`cap -= 50 / maxPerHour`（下限 50）。
- 触发概率 `p = (interest + stateModifier - 50) / 50`；`stateModifier`：`WORK -10`、`GAME +20`、`BROWSE +10`、`CALL -40`、`AWAY -20`、`IDLE -15`。
  - 自洽校验：`WORK` 需 `interest > 60` → 连续工作约 20 分钟才可能开口；`BROWSE` 约 13 分钟；`GAME` 约 10 分钟；`CALL` 需 `> 90`，实际被硬闸门直接拦死。
- 硬上限：`maxPerHour = 3`（默认），**语言介入最小间隔 10 分钟**（可配 8–15），专注模式 0；同类意图 30 分钟内去重（Miru）。
- **长时间同状态**才允许「关心休息」类意图；否则优先「观察屏幕」或「不说话」。

**变化检测（P1/P2/P3 共用）**：9×8 灰度 dHash，Hamming ≥6 才算变化；没变则跳过本次内容理解，只更新元数据。省 token，也减少「盯着你看」的感觉。

**「实时」的真实边界**：P0 反应在 1s 内（app 切换、全屏、通话、空闲）；P2/P3 的理解与发言在 2–10s（含 OCR/VLM），且最低间隔 90s。**不要承诺「实时看懂屏幕」**，承诺「实时察觉你在做什么，偶尔看懂一点」。

### 4.3 隐私架构：七条不变量

1. **默认档位 `ocr`，但首次采集前必须显式确认**：P0 默认开（无内容）；P2（ocr）为默认档，首次启动必须过 consent sheet（写清「截图范围 = 前台单窗口、本机 OCR、不出网、如何关闭」）；P1/P3 仍需单独开启；**确认前不采集**。
2. **Fail-closed**：权限拒绝、规则解析失败、app 未知、窗口不可捕获、模型输出不合规 → **本次跳过**；绝不「降级成整屏再试一次」。
3. **只截单窗口**：优先 `SCContentFilter(desktopIndependentWindow:)`；排除自身 overlay；最小化/零尺寸/跨 Space 不可得 → 跳过。
4. **内存态，不落盘**：帧只在 helper 进程内存 → JPEG `Data` → stdout JSON → 主进程内存 → 用完释放引用；不写临时文件、不写 `main.log`、不进 crash 报告。OCR 文本同样不落盘。**不承诺「内存清零」**（JS/Swift 堆无法保证立即归零），承诺「不持久化、不扩散」。
5. **本地优先**：OCR 用 Vision `VNRecognizeTextRequest`（本机）；规则匹配、状态分类、dHash 全在本机；只有 P3 才出网，且必须用户显式选 provider。
6. **出口前脱敏**：OCR 行级丢弃命中敏感词的行（密码/验证码/token/银行卡/身份证/私钥/API key）；截断到 1200 字符；移除 URL/邮箱/长数字串；P3 只发压缩图（长边 ≤1280，JPEG ≤70）。
7. **透明与可撤销**：「刚刚看到了什么」面板（最近 10 次：时间、app、层级、是否发送、字节数、是否发言、[删除]）；全局暂停；按 app 允许/拒绝；一键清空；观察日志**只存元数据**，7 天自动清理。

**补充：输出过滤器（防止「看到了不该说的」）**

发言前检查：命中以下任一 → 丢弃该句，改为沉默或通用关心话：
- ≥11 位连续数字（手机号/卡号/验证码）；
- 邮箱、URL、文件路径、代码样式（`{...}`、`=>`、`function`）；
- `password|验证码|token|secret|私钥|身份证|银行卡`；
- 引号内 >40 字的「原文复述」；
- 模型返回 `SKIP` / 空 / 与屏幕无关的长篇。

**补充：绝不使用的措辞**：`我看到你…`、`你的屏幕上…`、`你正在输入…`。统一用「你好像…」「这会儿…」的模糊表述（darkitten 的提示词也是这个原则）。

### 4.4 规则引擎（`App` / `App::Title`）

**语法（改编自 screenpipe，保持存储为 `string[]`）**

| 写法 | 含义 |
|---|---|
| `1Password` | 应用名包含（大小写不敏感） |
| `Chrome::无痕` | 应用包含 Chrome **且** 标题包含「无痕」 |
| `::confidential` | 任意应用，标题包含 |
| `Slack::` | 等价于 `Slack` |

**两套列表 + 未知策略**

```ts
interface ScreenRules {
  denyApps: string[]          // 不观察、不评论、不据此发言（含元数据反应）
  denyTitleKeywords: string[] // 标题命中即拒绝
  allowApps: string[]         // 空 = 所有非 deny 应用都允许内容级；非空 = 仅这些
  unknownAppPolicy: 'deny' | 'metadata-only'  // 内容级默认 'deny'
  denyMeetingApps: boolean    // 默认 true：会议 app 永不内容级
  denyIncognito: boolean      // 默认 true
  allowUrls: string[]         // 可选，仅当能拿到标题/URL
  denyUrls: string[]
}
```

**有效状态**（UI 直接回答「会不会被截」）：`captured / ignored / partial / outside-allowlist`，并标 `blockedIndirectly`（规则过宽误伤）。

**内置默认拒绝清单**（可编辑，但默认在）：`1Password`、`Keychain Access`、`Bitwarden`、`LastPass`、`银行`、`Wallet`、`远程桌面`、`TeamViewer`、`AnyDesk`、`RustDesk`、`VMware`、`VirtualBox`、`Parallels`；标题关键词：`密码`、`登录`、`验证码`、`支付`、`银行`、`私钥`、`token`、`无痕`、`Incognito`、`Private`、`远程桌面`。

> 边界：这些是**启发式**，不可能覆盖所有敏感场景。因此「默认拒绝未知应用」+「用户可编辑」比「词表越长越好」更重要。

### 4.5 聚焦模式

**定位**：应用内状态机，**不尝试开关系统 Focus**（macOS 没有公开 API；读 `~/Library/DoNotDisturb/DB/*` 需要完全磁盘访问且在新系统上不稳定）。

**状态机**

```
NORMAL --(用户开始 / 接受自动建议)--> FOCUS
FOCUS  --(计时结束 / 用户停止 / 硬中断)--> WRAP_UP(2s) --> NORMAL
FOCUS  --(用户拖宠物 / 打开聊天)--> PAUSED --(继续 / 放弃)--> FOCUS
```

**三种模式**

| 模式 | 表现 | 适用 |
|---|---|---|
| `quiet`（默认） | 淡到 55%，移到角落，停自主活动，停主动说话，停内容级观察（P1–P3，保留 P0 元数据），FPS 降到 10，只剩计时小条 | 不想被打扰 |
| `companion` | 保持可见，坐在窗沿「一起工作」，不说话，偶尔抬头；结束给一句鼓励 | 想要陪伴感 |
| `pomodoro` | 25/5 或 50/10，结束提醒休息 + 伸展动作，本地记录段数 | 需要节奏 |

**触发**

- 用户主动：设置页/右键菜单「开始专注 25/50/90 分钟」。
- 自动建议（不自动进入）：IDE 前台持续 15 分钟且切换 ≤2 次 → 气泡问「要不要进入专注？」，用户点确认才进。
- 自动静音（不是专注）：全屏 / 游戏 / 通话 / 会议 → 立即淡出+静音，条件消失后 5s 恢复；不计时、不统计。

**结束语义**（借 VPet）：`TimeFinish`（自然结束）/ `ManualStop`（用户停）/ `Interrupted`（关机/休眠/权限丢失）。统计只在本地，可关闭。

**与 DSH 的联动**：专注中若 DSH 有 `task/error`，只做一次极轻量的表情反应（不发言），避免「专注被 agent 打断」。

### 4.6 记忆与上下文边界（N.E.K.O 的核心贡献）

- 屏幕观察产生的**原始内容（OCR 文本 / 图像）永不进入对话历史与长期记忆**。
- 宠物因屏幕而说的话，入库时带 `source: 'screen'` + `memoryEligible: false`；后续普通生成**不把它当 few-shot 示例**（避免「每次都用同一种句式说屏幕」）。
- 用户追问「你刚才看到什么」→ 只答**元数据**（app 名/时段），不答原文；原文已随内存释放。
- 长期记忆提取显式跳过 `source=screen` 的轮次。
- 这样做的代价：宠物不会「记住你昨天在写什么」；这是**故意的**，隐私优先。

### 4.7 与现有代码的接线（文件级）

| 新增/修改 | 文件 | 内容 |
|---|---|---|
| 新增 | `native/screengrab/main.swift` | 单窗口截图（SCScreenshotManager 14+ / CGWindowListCreateImage 13 回退）、Vision OCR、160×90 氛围采样、权限探测；JSON 到 stdout，**不写文件** |
| 修改 | `scripts/build-native.mjs` | 增加 `screengrab` target（沿用 `winlist` 的 universal 构建、stamp 幂等、`--check` 校验） |
| 新增 | `src/shared/screen-rules.ts` | 规则解析/匹配/有效状态（纯函数，无 Electron/Node） |
| 新增 | `src/shared/screen-observer.ts` | 类型：`ObservationTier`、`ActivityState`、`ScreenObservation`、`PrivacyDecision`；`sanitize` 与预算纯函数 |
| 新增 | `src/main/desktop/screen-observer.ts` | 编排：定时器、闸门、spawn helper、兴趣/预算、错误降级；依赖注入以便单测 |
| 新增 | `src/main/ipc/screen.ts` | `pet:screen-status` / `pet:screen-observe-now` / `pet:screen-observations` / `pet:screen-clear` / `pet:screen-open-settings` |
| 新增 | `src/renderer/src/reactions/screen.ts` | 观察 → `ExternalReaction` + 台词（复用 B7 的注入路径） |
| 修改 | `src/shared/ipc.ts` + `tests/shared-contract.test.ts` | 新增通道（**冻结契约变更，需 Lead 评审**） |
| 修改 | `src/shared/config.ts` + `src/shared/types.ts` | 新增可选 `screen` / `focus` 配置组；**不 bump `CONFIG_VERSION`**（沿用 W0-3 的可选键回填模式；bump 会导致旧配置整体回退默认） |
| 修改 | `src/renderer/src/settings/*` | 新增「屏幕感知」「专注」两个设置分区 + 权限引导 + 观察记录面板 |
| 修改 | `src/renderer/src/behavior/behavior-director.ts` | `BehaviorConfigSubset` 增加 `quiet` / `focusActive`；专注时抑制自主活动与捣乱 |
| 修改 | `src/main/index.ts` | 接线 `registerScreenIpc`；will-quit 清理 |
| 修改 | `docs/packaging.md` | 新增 TCC 行、entitlements、Info.plist 用途说明、拒绝后的降级路径 |

**不改动**：渲染/动画/VRM/物理/窗口吸附主干。所有新能力通过现有 `ExternalReaction` 与 config 注入，**可独立回滚**。

### 4.8 权限与降级矩阵

| 场景 | 权限状态 | 行为 |
|---|---|---|
| 未授权 / `not-determined` | 录屏 | P0 正常；首次启动引导授权（consent sheet + 深链）；**未确认前不采集**；确认后进入 `ocr` |
| `denied` | 录屏 | P0 正常；**自动降级 `metadata`**；设置页显示当前档位 + 「去系统设置」深链；**不弹二次授权**（Electron 的 `askForMediaAccess` 不支持 `screen`；只能用 `getMediaAccessStatus` 查询 + 深链） |
| `restricted` | 录屏 | 同上，文案说明受 MDM 限制；降级 `metadata` |
| 授权但窗口不可捕获 | 单窗口 | 本次跳过；记录 `reason=window-unavailable`；不回退整屏 |
| 连续 3 次捕获失败（如权限被撤） | 录屏 | **进入退避**：暂停抽样，记录原因与下次重试时间；用户重新授权后立即清零重试（Miru 的做法）；日志不重复刷屏 |
| 权限每月到期 | 录屏 | 启动时 `getMediaAccessStatus('screen')` 若变 `denied/not-determined` → **自动降级 `metadata`** 并提示「重新授权」；重新授权后回到 `ocr` |

> `confirmed`：`systemPreferences.getMediaAccessStatus('screen')` 存在，macOS 10.15+ 需要屏幕录制授权；`desktopCapturer` 也受同一授权约束（Electron 官方文档）。
> `confirmed`：`SCScreenshotManager` 为 macOS 14.0+；ScreenCaptureKit 整体 macOS 12.3+。

---

## 5. 配置草案（新增可选键，不改版本号）

```jsonc
{
  "screen": {
    "enabled": true,                  // 内容级总开关（P1–P3）；首次采集前必须先过 consent sheet
    "metadataEnabled": true,          // P0 元数据（无权限、无内容）；想完全退出可关
    "tier": "ocr",                    // metadata | ambient | ocr | vision；权限被拒自动降级 metadata
    "intervalSeconds": 120,           // 90–600，实际 ±15% 抖动
    "minIdleSeconds": 45,             // 刚互动过不看
    "maxPerHour": 3,
    "minGapSeconds": 600,             // 语言介入最小间隔（非语言反应不受此限）
    "quietHours": { "enabled": false, "start": "22:30", "end": "08:00" },
    "onBatteryOnlyReduce": true,      // 电池供电时间隔翻倍
    "capture": {
      "target": "foreground-window",  // 固定单窗口；不提供 whole-screen 选项
      "maxEdge": 1280,
      "jpegQuality": 70,
      "ocrMaxChars": 1200
    },
    "rules": {
      "denyApps": ["1Password", "Keychain Access", "Bitwarden", "银行", "Wallet"],
      "denyTitleKeywords": ["密码", "验证码", "支付", "无痕", "Incognito", "私钥", "token"],
      "allowApps": [],
      "unknownAppPolicy": "deny",
      "denyMeetingApps": true,
      "denyIncognito": true
    },
    "lastComment": ""                 // 与 darkitten 一致，避免重复同一句
  },
  "focus": {
    "mode": "quiet",                  // quiet | companion | pomodoro
    "defaultMinutes": 50,
    "breakMinutes": 5,
    "opacity": 0.55,
    "fpsCap": 10,
    "suspendProactive": true,
    "suspendScreenObservation": true, // 仅停内容级（P1–P3）；P0 元数据保留用于状态判定
    "autoSuggest": true,              // 仅建议，不自动进入
    "autoQuietOnFullscreen": true,
    "autoQuietOnCall": true,
    "statsEnabled": true
  }
}
```

**配置契约**：`sanitizeConfig` 对未知键丢弃、对枚举/数值钳制；新增组用 `readOptionalRecord` 回填默认，不 bump `CONFIG_VERSION`（避免旧配置被整体重置）。

---

## 6. 分期实施计划

> 每期结束都可独立交付；任一期失败不影响前一期。工作量是粗估（`inferred`），需在实施前用 spike 校准。
> W-A/W-B 是 W-C 的前置（状态分类与投递闸门先在零权限下跑通），**W-C 是默认档位 `ocr` 的落地期，不是可选项**。

### W-A：聚焦模式 + 低打扰（零权限，3–5 人日）

- 专注状态机、三种模式、计时 UI、本地统计；
- 全屏自动静音（复用现有 `windows-updated` 的几何判定，零权限）；
- overlay 行为配置化（借 BongoCat schema），淡出/降帧/角落停靠；
- 设置页「专注」分区 + fixture 测试。
- **验收**：无录屏权限也能完整跑通；专注中主动说话次数 = 0；退出后 5s 内恢复；测试覆盖状态迁移与「硬中断」。

### W-B：P0 元数据实时互动（零权限，4–6 人日）

- 前台 app 变化事件、全屏判定、空闲/通话探测；
- `ActivityState` 分类 + 兴趣/预算 + 投递闸门；
- `screen.ts` 反应映射 + 台词（砂金人设，短句）；
- 通话/游戏自动静音（补 W-A 的全屏判定）；
- 「刚刚看到了什么」面板（此时只有元数据）。
- **验收**：切到 IDE/浏览器/游戏各 1 次，反应符合预期且不与专注冲突；1 小时内主动发言 ≤3；无新权限；CPU 增量 <2%。

### W-C：P1 + P2（录屏权限，默认档位 `ocr` 的落地期，6–9 人日）

- `native/screengrab` helper（单窗口截图 + Vision OCR + 氛围采样）；
- 权限查询/深链/降级；
- 规则引擎 + 有效状态 + 设置页「屏幕感知」；
- 行级脱敏 + 出口过滤器 + 透明面板；
- dHash 变化检测（没变不看）。
- **验收**：敏感 app/标题/全屏/通话/无痕 → 100% 跳过（fixture 覆盖）；截图不落盘（`fs_usage`/临时目录检查）；OCR 文本不出现在日志；拒绝授权后自动降级 P0 并可恢复；**连续 3 次失败进入退避且不刷日志**。

### W-D：P3 视觉 + 记忆边界（录屏 + 网络，5–8 人日）

- VLM 客户端（provider 配置、超时、失败降级）；
- 首次/换 provider 的 consent sheet（预览将发送的图）；
- `source=screen` 标记 + `memoryEligible=false` + 历史投影（防污染）；
- 预算与成本面板（次数/字节/token 粗估）。
- **验收**：模型返回 `SKIP`/越界内容 → 不发言；屏幕轮次不进入长期记忆；关闭 P3 后无网络请求；成本可解释。

**总计**：18–28 人日（若 W-C 的 SCK 回退路径复杂，+3 人日）。

---

## 7. 风险、未知与开放问题

| 项 | 等级 | 说明 / 缓解 |
|---|---|---|
| macOS 15 每月重新授权 | 高 | **默认档位是 `ocr`**，因此降级路径必须常驻：启动时检测并自动降到 `metadata`；文案提前解释，避免「偷偷失效」 |
| 开发版 TCC 不稳定 | 高 | 未签名/ad-hoc 构建在系统设置里可能不出现或每次重建重置；**默认 `ocr` 会放大这个问题**，打包公证后再验（`docs/packaging.md` §3 红线） |
| `CGWindowListCreateImage` 已弃用 | 中 | macOS 14+ 用 `SCScreenshotManager`；13 用旧 API（自 macOS 14 起标记 deprecated，但仍可用）；14–15 双路径都要测 |
| 单窗口在别的 Space / 最小化不可捕获 | 中 | 跳过并记录原因；不回退整屏 |
| 系统 Focus 状态不可读 | 中 | 不依赖；专注模式自建；自动静音用全屏/通话/游戏信号 |
| 分类误判（把工作判成浏览） | 中 | 阈值保守；只影响「要不要说话」，不影响隐私；可加「最近 10 次判定」调试面板 |
| 模型复述屏幕内容 | 高 | 出口过滤器 + `SKIP` + 行级脱敏 + 不存原文；失败即沉默 |
| 记忆污染（句式被复读） | 中 | `source=screen` + `memoryEligible=false` + 历史投影（N.E.K.O） |
| 录屏带来的「被监视感」 | 高 | 默认 `ocr` 但首次采集必须显式确认、单窗口、低频、可回看、可删除、观察时宠物有可感知状态（耳朵/眼神），不用「我看到」措辞 |
| VLM 延迟/成本 | 中 | 只在 P3 + 低频；90s 起；dHash 去重；预算面板 |
| 与另一会话的改动冲突 | 中 | 实施前确认工作树干净；新增文件优先，`ipc.ts`/`config.ts` 等共享契约变更单独提交并走评审 |
| 许可 | 中 | 只复制 MIT（darkitten）/Apache（N.E.K.O、BongoCat、VPet、Miru）实现；AGPL（LingChat）与商业（screenpipe）**只借设计，不抄代码** |

**开放问题（剩余）**

1. **专注模式气质**：`quiet`（完全安静，推荐）还是 `companion`（陪着你但不说话）？
2. **屏幕观察的「可回看」程度**：只回看元数据（推荐，最安全）还是保留最近 N 分钟的脱敏文本（更有用，但要多一层存储与清理）？

---

## 8. 证据清单（可复核）

**克隆方式**：`git clone --depth 1 --filter=blob:none --no-checkout`（不落工作区；`git show` 按需取 blob）。

**检索但未纳入正式对比**：`Koishi007/koishi-ai-pet`（PySide6，截图 + 窗口探测 + 重力吸附 + SQLite 记忆，Apache-2.0，README 可读）——只读了 README，未深读其隐私实现，列为备选；若后续要做「窗口物理交互 + 记忆管理 UI」再补审计。

| 仓库 | 审计 commit | 关键文件 |
|---|---|---|
| `LFELKEEA/darkitten-pet` | `e1b0951`（2026-11-07） | `screen_watcher.py`（`SCREEN_SYSTEM_PROMPT`/`SENSITIVE_*`/`observe`/`capture_screen`/`OcrTask`）、`config.py::screen_watch`、`plugins/lfelkeea.focus_guard/main.py`、`README.md` 隐私说明 |
| `Project-N-E-K-O/N.E.K.O` | `a89b685`（2026-11-10） | `docs/design/screen-history-local-reference.md`、`docs/design/focus-truename-mode.md`、`utils/screen_comment_guard.py`、`utils/screenshot_utils.py`、`frontend/react-neko-chat/src/ScreenObservationExposure.tsx` |
| `SlimeBoyOwO/LingChat` | `848fd34`（2026-09-13） | `src-tauri/src/ai_service/proactive_system/{activity_monitor,strategy_dispatcher,interest_manager,delivery_evaluator,visual_monitor}.rs`、`src-tauri/src/config/proactive.rs`、`src-tauri/src/ai_service/screen_analyzer.rs` |
| `kiyotakali/Miru` | `cbea20b`（2026-10-14） | `sensor.py`（`CHECK_INTERVAL=30`/`CHANGE_THRESHOLD=0.30`/退避/`ioreg` 空闲）、`attention_engine.py`（`PROACTIVE_MIN_INTERVAL=15min`/`INTENT_DEDUP=30min`/salience 延迟）、`screen_analyzer.py`、`docs/SCREENSHOT_REFACTOR_TODO.md` |
| `mediar-ai/screenpipe` | `2619d10`（2026-11-09） | `crates/screenpipe-core/src/window_pattern.rs`、`apps/screenpipe-app-tauri/lib/settings/capture-filters.ts`、`components/settings/privacy-section.tsx`、`components/settings/schedule-settings.tsx`、`lib/utils/incognito-permission.ts` |
| `ayangweb/BongoCat` | `47a73ed`（2026-10-28） | `shared/config/fixtures/accept-idle-hide.json`、`shared/config/config.schema.json` |
| `LorisYounger/VPet` | `c26be33`（2026-11-08） | `VPet-Simulator.Core/Display/WorkTimer.xaml.cs` |
| `refs/Mate-Engine` | `2c5ea6b`（2026-01-20） | `Assets/MATE ENGINE - Scripts/Tools/DesktopAmbientProbe.cs`、`Assets/uWindowCapture/package.json` |

**本项目证据（工作树）**

- `native/winlist/main.swift`（不读标题、无权限的边界）
- `src/main/ipc/desktop.ts::POLL_INTERVAL_MS`（250ms）
- `src/main/config-store.ts`（版本不符回退、未知键丢弃）
- `src/renderer/src/core/wave2-contract.ts::BehaviorInput` / `BehaviorConfigSubset`
- `src/renderer/src/scene/pet-scene.ts::setOpacity`、`scene/fps-limiter.ts::FrameRateController`
- `docs/packaging.md` §3（TCC 红线：读标题/截图必须同步 entitlements、公证、降级路径、文档）

**外部文档**

- Electron `systemPreferences.getMediaAccessStatus`（`screen`，macOS 10.15+ 需授权）
- Electron `desktopCapturer`（截屏需用户同意；`thumbnailSize` 可设 0 省开销）
- Apple `SCScreenshotManager`（macOS 14.0+）；ScreenCaptureKit（macOS 12.3+）
- macOS Sequoia 按月重新确认屏幕录制权限（9to5Mac / Apple 支持文档）
</content>
