# 桌宠「窥屏实时互动 + 隐私保护 + 聚焦模式」设计 v2（修正版）

> 日期：2026-11-11
> 状态：**设计交付（本文档即本轮最终产物）；本轮不改任何代码**（用户 2026-11-11 决策 D2）。
> 定位：替代 `docs/research/screen-awareness-privacy-focus-feasibility-2026-11-11.md`（豆包报告，下称「原报告」）中的**项目内集成方案**；原报告的外部调研与产品结构作为参考输入保留，不再作为实施依据。
> 复核基线：`main` @ `4a2d8b3`（相对原报告基线 `3893943` 已前进 **23** 个提交；审计期间另一会话另提交了 `672c9da`（比例感知）、`e467f82`（sleep）、`aaba07e`（gitignore），均未触及本设计契约面；本文结论以 `4a2d8b3` 代码为复核基线）。
> 审计依据（4 份独立报告，本文所有"confirmed/refuted"均指向它们或本工作区 file:line）：
> - `docs/research/screen-awareness-architecture-review-2026-11-11.md`（T1，605 行，项目架构/契约/台词/配置/反应通道/分期）
> - `docs/research/screen-awareness-native-spike-2026-11-11.md`（T2，717 行，macOS 27.2 原生能力/TCC/性能真机探针）
> - `docs/research/screen-awareness-dsh-integration-audit-2026-11-11.md`（T3，775 行；含附录 A「DSH 生成屏幕评论链路」）
> - `docs/research/screen-awareness-reference-audit-2026-11-11.md`（T4，348 行，参考项目/许可证/参数核对）
> 用户决策记录：
> - **D1（2026-11-11 16:45）**：屏幕感知的「说话」= **借 DSH 模型生成评论**（替代原报告的自研台词/自建 VLM 客户端链路）。
> - **D2（2026-11-11 16:45）**：**本轮只交付修正设计，暂不动代码**；实施另起批次。

---

## 0. 一页结论

| 问题 | 结论 |
|---|---|
| 豆包的设计是否可行？ | **产品方向可行，项目内集成方案不可直接实施**。原报告没有见已落地的 A7 peek 契约，违反台词/配置/反应通道/权限/网络五类硬约束，并低估 P0 成本、高估可行信号。 |
| 修正后是否可行？ | **可行**：W-A 聚焦模式（零权限）→ W-B P0 元数据互动（零权限）→ W-B2a DSH 评论（零内容权限）→ W-C P1/P2 内容级（需屏幕录制 TCC）→ W-B2b 内容评论。全程不动渲染/动画/物理/模型主干。 |
| 「说话」怎么解决？ | 三层表达：**① 非语言反应**（gaze/受控活动，零新增文本）→ **② 官方语音池语义映射**（111 条原文 + SHA-256 锁，零新增文本）→ **③ DSH 模型评论**（用户 D1 决策；独立新文本类别「DSH 评论」，UI 标注、默认关闭、七条出口过滤，不进口台词池/SHA 锁）。 |
| 默认档位 | 推荐：**内容级默认全关**（用户显式开启 metadata；P2 二次确认）。原报告"默认 ocr"与 A7 契约（默认全关）、当前 ad-hoc 签名 TCC 不稳定冲突，且仓库无该决策记录 → 见 §9-Q2 待确认。 |
| 需要的新权限 | P0/P1？**P0 零权限**；**P1/P2 都需屏幕录制 TCC**（P1 只降低信息量，不降低权限）；DSH 评论链路本身不需要新 TCC（但它调用的模型会收到脱敏文本，需用户同意）。 |
| 工作量 | 约 **23–34 人日**（纯实施 19–28 = W-A 3–4 + W-B 6–9 + W-B2 2–3 + W-C 8–12；另加真机/评审/回滚验证 4–6；A7/R4 已完成的契约与 gate 已抵扣约 4–6 人日，不再重复计）；原报告 18–28 人日覆盖 P0–P3 属**偏低**。 |
| 本轮交付 | 4 份审计报告 + 本文档；**零代码改动、零提交代码**（详见 §12）。 |

**修正后的总体架构（一句话）**：把「窥屏」拆成 **P0 元数据（零权限）+ P1 氛围 + P2 本机 OCR（均需 TCC）+ P3 由 DSH 模型评论取代**；实时互动主靠 P0 + 非语言反应，内容级只在**单窗口、低频、可回看、fail-closed** 的前提下发生；隐私不是事后脱敏，而是**采集前闸门 + 采集后内存态 + 展示前出口过滤**；聚焦模式是**独立于系统 Focus 的应用内运行态**，绝不改写用户配置。

---

## 1. 复核方法与结论可信度

1. 四名独立 teammate 分别从「项目架构 / 原生能力 / DSH 侧 / 参考项目」四个角度只读审计；全部结论要求 `file:line` 或命令/输出证据。
2. Lead 复核：对原报告逐节比对、抽查四份报告的关键论断（含本地复跑 `git log`、`lsappinfo`、`electron.d.ts`、`tsconfig`、A7 契约与测试、config-store 合并链、wave2-contract 冻结面），并裁决冲突（见 §3「Lead 复核裁定」）。
3. 可信度分级：`confirmed`（工作区/本机可复核）/ `likely`（外部仓库或文档一致但未本机复现）/ `unverified`（需真机或临时 profile 实验，已在 §8 列明）。
4. **严格区分三类事实**：本机实测（T2）、本仓库代码（T1）、DSH 安装态 app.asar（T3）、外部参考仓库（T4）；外部事实一律不当作实施前提。

---

## 2. 原报告勘误（Lead 汇总；完整证据见四份审计报告）

### 2.1 严重（直接推翻原报告方案）

| # | 原报告问题 | 修正 | 证据 |
|---|---|---|---|
| S1 | **完全没提 A7 peek 契约**（`src/shared/peek.ts`、`docs/peek-interface.md`，commit `5012a30`），另起 `src/shared/screen.ts` 并行契约 | 以 A7 为**唯一契约根**，按 §6.1 追加式扩展；主进程编排放 `src/main/peek/`；IPC 用 `pet:peek-*` | T1 §3.10、M1 |
| S2 | IPC 返回/回看含 observation 原文（`screen-observe-now`、`screen-observations`），违反 A7「text/vision 永不过 IPC、不落盘、不进日志」 | 手动观察只回**摘要**；透明面板 v1 只回看**元数据**；回看原文属需契约变更的独立隐私决策 | T1 M2；`src/shared/peek.ts:212-214,255-257` |
| S3 | 新增 `screen`/`focus` **嵌套配置组** | 现有 `config-store` 是浅合并 + 全量 sanitize 回填，嵌套 Partial 会**丢键**（改一个子键会重置同组其它子键）；v1 全部用**扁平可选原始键**（`dshCoupling` 先例），`CONFIG_VERSION` 不 bump | T1 §3.3、M3；`config-store.ts:59-65,189-198,217-224` |
| S4 | 「自研台词 / 模型生成台词 / SKIP 输出过滤 / 绝不使用的措辞」整条链路 | 项目台词 = 111 条砂金官方语音原文 + SHA-256 锁 + 用户硬性禁止自创；**宠物台词链路不做模型生成**。模型评论作为**独立新类别「DSH 评论」**（用户 D1 决策）单独建模，不进口台词池 | T1 §3.8、M4；`core/voicelines.ts:1-33,176-177` |
| S5 | P3「自建 VLM 客户端」（provider/密钥/HTTP/prompt/成本面板）当低侵入 | 项目零模型/零网络基础设施，渲染层生产网络被主动拦截；**P3 由「DSH 模型评论」替代**（W-B2），自建 VLM 不排期 | T1 M5；T3 A.4；`renderer-network-guard.ts:31,100` |
| S6 | 「所有新能力经现有 `ExternalReaction` 注入」 | `ExternalReaction.mood` 冻结为 DSH 三值、`PET_MOODS` 12 值冻结；屏幕反应**不得**复用该通道。合法替代：renderer `main.ts` 集成层（gaze 覆盖 + 受控活动 + 独立气泡/评论通道），不改 `wave2-contract.ts`/`PET_MOODS`/behavior-director 内部 | T1 M11、§3.5-3.6 |
| S7 | 改 `behavior-director.ts`（`BehaviorConfigSubset` 加 `quiet/focusActive`），并把 `focus.opacity=0.55` 等**表现值写进持久配置** | 不改内部；专注态是**运行态**，用「有效值 = 用户配置 × 专注覆盖」合成（`min` 规则），**绝不写回** `opacity/fpsCap/autonomous` | T1 M12、§7 |
| S8 | 「已定决策：默认 ocr」 | 与 A7 默认全关、当前 ad-hoc 签名 TCC 不稳定冲突，仓库无决策记录；**默认值须重新拍板**（§9-Q2），推荐默认全关/用户显式开启 | T1 M15；T2 §0、§2.3 |
| S9 | 麦克风占用列为 **P0 零权限 ~0 成本** | Electron 无"占用中"API（只有权限查询），须新增 native CoreAudio helper；**v1 砍掉**，CALL 降级为「会议 app 前台」启发式 | T1 M7；T2 §6.3（本机无输入设备，只验证 false 分支） |
| S10 | 窗口标题规则（`App::Title`/`denyTitleKeywords`）当 P0 隐私闸门 | `kCGWindowName` 无录屏权限时**键直接缺失**（不是空串）；AX 读标题需辅助功能权限（本项目从未申请）→ **P0 规则只到 app 级**；标题能力另立评审（§9-Q5） | T2 §5.2；T1 M8 |
| S11 | 「前台 app 现成、~0 成本」 | `WindowInfo` 无 active/frontmost 字段；新增 `lsappinfo front`（零权限，本机实测可用）+ winlist `pid→owner` 关联 | T1 M9；`types.ts:33-41` |
| S12 | 全屏判定只写「rect 与 monitor 误差 ≤2px」 | 必须**过滤 `layer==0`**（否则 Dock/壁纸/通知中心全命中）+ 与 `CGDisplayBounds` 比较（不能用 `NSScreen.visibleFrame`）；`.optionOnScreenOnly` 下其他 Space 窗口不出现，不能把「列表消失」当全屏/关闭 | T2 §7；T1 M10 |
| S13 | P1 氛围层当作「拒绝内容级权限的免权限折中」 | **P1 也需屏幕录制 TCC**；它只降低信息量，不降低权限。拒权后唯一可用层是 P0 | T1 M14；T2 §0 |
| S14 | `CGWindowListCreateImage`「deprecated 但仍可用」 | SDK 27.2 中已 **`obsoleted=15.0`**：默认部署目标编译**直接失败**，仅 `-target macos13.0` 可编；运行期 27.2 仍可用（实测 9–12ms/全屏）。只能作 **macOS 13.x 回退分支**，且需运行时 `dlsym` 探测 | T2 §4 |
| S15 | 遗漏 Electron `powerMonitor`（idle/battery/lock/suspend） | 空闲秒/锁屏/电池/挂起全部可直接用 `powerMonitor`，零 native、零 ioreg/CGEventSource | T1 M6；`electron.d.ts:11580,11586,11599` |
| S16 | 状态分类/兴趣模型参数（GAME/BROWSE/CALL、键鼠钩子、interest 概率） | 依赖不存在信号（键鼠钩子需 Input Monitoring；Electron 无麦克风占用 API，仅 CoreAudio native helper 可读布尔；无系统 Focus；无聊天窗/语音）；**v1 去掉概率 interest 模型**，用确定性预算：≤3 次/小时、最小间隔 10min、同类去重 30min；分类只做 `AWAY/IDLE/MEETING/FULLSCREEN/WORK/CASUAL` | T1 M13、§8 |
| S17 | 「记忆污染隔离」（`source:screen`/`memoryEligible`/历史投影） | 项目当前**没有** LLM 对话历史/长期记忆承载对象；但 D1 引入 DSH 评论后**必须有**：评论句标 `source:'dsh-model'`、`memoryEligible:false`、不进 DSH 会话历史（评论直调不建 session） | T1 M17；T3 A.3、A.5 |
| S18 | 参考项目事实错误/引用错位 | 用户点名的 `darkitten-launcher` 是 Minecraft 启动器+下载站（MIT，无屏实现），窥屏实现在姊妹仓库 `darkitten-pet`（MIT，原报告审计 commit 正好一致）；`focus_guard` 默认 **50min 专注/5min 休息**（非 5 分钟）；`lastComment` 是死字段；BongoCat 审计 commit 已是 **Rust/GPUI**（非 Tauri）；VPet 显示模式是 3 种+隐藏；darkitten `vendor/live2d` 与第三方模型不在 MIT 内 | T4 §2/§6（E1–E7、E9–E13；E8 属 commit 漂移，已并入 §1） |
| S19 | 工作量 18–28 人日覆盖 P0–P3 | 修正：纯实施约 **19–28 人日**（P0–P2 17–25 + DSH 评论 2–3），加真机/评审/回滚验证 4–6 → **约 23–34 人日**；P3 不再自建 | T1 §0、§9；T3 A.6 |

### 2.2 重要（需修正设计细节）

- 原报告 §4.3「内存清零」措辞：项目采用「**不持久化、不扩散**」，不承诺 JS/Swift 堆清零（原报告已接近正确，保留）。
- 原报告 §4.5「移到角落」：`position` 是初始停靠配置，运行态移动需 B1/B2 新指令；v1 不做（只淡出/降帧）。
- 原报告 §4.5「结束给一句鼓励」：只能用官方池映射（完成→`SUCCESS_BUBBLES`），提前停止建议静默。
- 原报告 §4.2「聊天打开/输入为空/语音中」投递闸门：本项目无聊天窗/语音，改为「气泡占用 / 专注中 / 最小间隔 / 刚交互过 / 全屏/会议」。
- 原报告 §4.4 规则语义自相矛盾（`allowApps` 空=全部允许 vs `unknownAppPolicy=deny`）：v1 明确为——**内容级 deny-by-default**（allowlist 空 = 不允许任何 app 内容采集），元数据级只受 denyApps 约束、allowApps 仅约束内容级（详见 §5.2）。
- 原报告 §4.8 权限矩阵：需补 **TCC 归责/假绿**（见 §7.1）与 **helper 冷启动 12.7s**（见 §7.2）。
- 原报告 §4.7 文件清单：`native/screengrab` 不是一次性 CLI 就够——Vision 首调用冷启动要求 helper **常驻+预热**；打包需 `extraResources`/`package-check`/签名顺序同步。
- 原报告 §2.1 darkitten 的「插件 `screen.context` 可再否决」：T4 证实并补充 `screen.comment`/`prompt_context` 双向钩子与两级失败降级，可借鉴（§10）。
- 原报告 §8 证据清单：缺 A7/R4 设计文档、launcher 审计行、TCC/原生实测证据。

---

## 3. Lead 复核裁定（对四份审计的关键判定）

| 判定 | 内容 |
|---|---|
| **采纳 T1 的核心结构** | A7 为唯一契约根；扁平配置键；不新增 mood/ExternalReaction；renderer 集成层（gaze/气泡/过滤）承载表达；W-A/W-B/W-C/W-D 重排（W-D 由 B2 取代）。 |
| **采纳 T2 的 TCC/性能结论** | P0 全部零权限实测通过；P1/P2 需 SR TCC；helper 必须常驻/预热；SCK 14+ 主路径、13.x 旧 API 回退；标题不做 P0。 |
| **采纳 T3 的 DSH 结论并升级** | DSH 安装态**无**采集/OCR 能力，不借其权限；DSH **有**模型层（`ctx.llm.stream`，插件可调，纯文本不落 session/JSONL/OTel）；现有桥保持单向、不承载内容；评论走**新独立 bundle + loopback HTTP**（T3 附录 A）。 |
| **采纳 T4 的参考项目结论** | 窥屏参考 = darkitten-pet（非 launcher）；许可证：MIT/Apache 可复制实现，AGPL/商业只借设计；BongoCat pomodoro 与本项目专注模式同题可参考。 |
| **Lead 追加裁决** | ① D1 选择 DSH 评论后，原报告 S4 的「台词链路作废」仍需保留——评论不是官方台词，必须按新类别建模（T3 A.5-A1），并在文档记录该决策；② 默认值改为「内容级全关」并列入待确认（§9-Q2）；③ 本轮**不实施**，因此冻结契约改动、IPC/配置批次都在下一轮评审后落地。 |

---

## 4. 修正后的总体架构

### 4.1 能力分层（权限 / 数据 / 默认）

| 层 | capability | 数据形态 | 权限 | 默认 | 落点 |
|---|---|---|---|---|---|
| **P0 元数据** | `screen.peek.metadata` | 前台 app 名、窗口数/几何、全屏布尔、空闲秒、锁屏/电池、DSH 在线/忙、活动分类（**无标题、无内容**） | **无 TCC**（winlist + `lsappinfo front` + `powerMonitor` + 现有 DSH 状态） | **总开关关**；用户显式开启后可用 | W-B |
| **P1 氛围** | `screen.peek.ambient`（**需追加 capability**） | 160×90 采样、四边带 HSV、亮度/变化率（不可还原内容） | **Screen Recording TCC** | 关 | 用户确认 P1 后追加（W-C 之后） |
| **P2 本地文本** | `screen.peek.ocr` | 前台**单窗口**截图 → Vision OCR → 行级脱敏（**只在主进程内存**） | **Screen Recording TCC** | 关 | W-C |
| **P3 视觉/评论** | ~~`screen.peek.vision`~~ → **DSH 评论通道** | ① metadata-only 评论：app 类别/时长；② content 评论：脱敏 OCR 文本。**均纯文本、不带图** | D1：**无桌宠新 TCC**（内容评论依赖 W-C 的 OCR）；调用 DSH 模型 = 脱敏文本出网，需用户同意 | 关（默认关闭的实验特性） | W-B2a / W-B2b |

> 说明：`screen.peek.vision` 保留在 A7 capability 集中不删除（已冻结），但**本设计不实现 vision 层**；D1 用 DSH 评论替代。未来若恢复图像理解，应重新评审（图像附件在 DSH 侧会永久落盘，T3 A.3 已证，不推荐）。

### 4.2 三条不变量（隐私架构）

1. **采集前 fail-closed**：权限被拒、规则解析失败、app 未知（内容级）、窗口不可捕获、helper 异常、DSH 未就绪 → **本次跳过**；绝不「降级整屏再试」。
2. **采集后内存态**：截图/OCR 只在 helper 与主进程内存；**不过 IPC、不落盘、不进日志、不进崩溃报告**；透明面板只回看元数据。
3. **展示前出口过滤**：模型评论必须过七条过滤器（§5.4-C）；失败即沉默或回退官方台词池；评论不进口台词池、不写 DSH 会话历史、不进长期记忆。

### 4.3 表达三层（替代原报告「模型生成台词」单层）

```
事件源（P0 为主，P2 低频补充）
  ├─ 前台 app 变化 / 全屏进入退出 / 空闲/锁屏/电池 / DSH 状态 / 聚焦会话
  ├─ 低频内容观察（90–180s，P2，需 TCC；两阶段：probe → gate → capture）
  ↓
[Gate 1 隐私/状态闸门]  fail-closed（A7 evaluatePeekGate 扩展）
  ↓
[活动分类]  AWAY / IDLE / MEETING / FULLSCREEN / WORK / CASUAL
  ↓
[表达路由]
  ├─ 非语言：gaze 覆盖（看当前 app 窗口方向）+ 受控一次性活动（idleStretch/lookAround）  ← 零新增文本、5s 冷却
  ├─ 官方语音池：专注开始/完成/离开回来等语义场景映射（111 条原文，BubbleGate 冷却）    ← 零新增文本
  └─ DSH 评论：metadata-only 或脱敏 OCR → DSH commenter 插件 → 1 句旁白               ← 新文本类别，默认关、UI 标注、七条出口过滤
  ↓
[展示层]  renderer main.ts 集成层（不改 behavior-director / ExternalReaction / PET_MOODS）
```

**「实时」的真实边界**（保留原报告的正确判断并修正）：P0 反应在 1s 内（app 切换、全屏、锁屏、DSH 状态）；P2 理解在 2–10s（含 OCR），内容观察最低间隔 90s；DSH 评论在 1–20s（含模型延迟）。**不承诺「实时看懂屏幕」**，承诺「实时察觉你在做什么，偶尔说一句」。

---

## 5. 各模块设计

### 5.1 P0 元数据采集与活动分类（W-B）

**数据源（全部零权限，T2 §6/§7 实测）**

| 信号 | 来源 | 频率 | 说明 |
|---|---|---|---|
| 窗口列表/几何/layer | 现有 `windows-updated`（250ms winlist） | 事件/250ms | 不改 `WindowInfo` 类型 |
| 显示器 bounds/workArea | 现有 `pet:screen-info`/`screens-updated` | 事件 | — |
| 前台 app | 新增 `src/main/desktop/frontmost-app.ts`：`lsappinfo front` → pid → winlist `pid→owner` | 1s | 零权限、本机实测可用；失败返回 null（fail-closed） |
| 空闲秒/锁屏 | `powerMonitor.getSystemIdleTime()/getSystemIdleState()`、`lock-screen/unlock-screen` | 5s + 事件 | `'locked'` → AWAY |
| 电池/电源 | `powerMonitor.onBatteryPower` | 事件/5s | 电池供电时观察间隔翻倍 |
| DSH 在线/忙 | 现有 `getDshStatus()`（桥 status） | 事件/5s | 只表示 DSH 状态，不含用户隐私 |
| 全屏 | 纯函数 `isWindowFullscreen(window, displays)`（新 `src/shared/peek-activity.ts`） | 随窗口事件 | **必须过滤 `layer==0`** + `CGDisplayBounds` 口径；要求 `onScreen==true`、面积覆盖率 ≥0.95、连续 2 次采样一致（T2 §7.2）；多屏分别判；不把「列表消失」当全屏 |

**活动分类（v1，纯函数，阈值 `inferred` 待真机校准）**

| 状态 | 判定（建议） | 表达策略 |
|---|---|---|
| `AWAY` | 锁屏，或 idle ≥ 5min | 不互动；回来问候（`GREETING_BUBBLES`） |
| `IDLE` | idle ≥ 15min 未锁屏 | 睡眠表现（`sleep` mood 已有） |
| `MEETING` | 前台 app ∈ 内置会议名单（Zoom/Teams/飞书/腾讯会议/微信语音…） | 硬静音（不发言、不反应） |
| `FULLSCREEN` | 前台窗口 bounds≈display.bounds 且 layer 0 | 自动静音/淡出（可配） |
| `WORK` | 前台 app ∈ 工作类名单，且 10min 内 app 切换 ≤2 次 | 低打扰 |
| `CASUAL` | 其余 | 正常 |

> **不实现** `GAME/BROWSE/CALL` 的精确分类：无可靠零权限信号（键鼠钩子需 Input Monitoring；Electron 无麦克风占用 API，真占用需 native helper；系统 Focus 无公开 API）。会议/游戏只按 app 名单做**弱提示**，文案不声称"检测到通话"。

**节奏与预算（v1 确定性简化，替代原报告概率 interest 模型）**
- 语言介入（官方台词/DSH 评论合计）：**≤3 次/小时**、**最小间隔 10 分钟**、同类意图 **30 分钟去重**（复用 A7 `PEEK_DEFAULT_THROTTLE` 语义）。
- 非语言反应：app 切换事件后 1–2s 内一次、**5s 冷却**，不受语言预算限制。
- 专注/全屏/会议：语言介入 0，非语言也降级（只保留专注计时 UI）。

### 5.2 隐私规则引擎（W-B；纯函数 `src/shared/peek-rules.ts`）

**语法（v1 只到 app 级）**：`denyApps` / `allowApps`（大小写不敏感子串匹配）；标题规则字段保留但 **P0 恒不可评估**（`kCGWindowName` 需 SR TCC；见 §9-Q5）。

**语义（修正原报告自相矛盾处）**
- 内容级（P2）：`allowApps` 非空 → 仅 allowlist 内 app 可采集，其余 `rule-denied`；`allowApps` 为空 → **deny-by-default（不允许任何 app）**，用户需显式 allowlist。
- 元数据级（P0）：只受 `denyApps` 约束（不发内容）；未知 app 仍可产生非语言反应与否决。
- **内置默认拒绝清单**（可编辑；默认在）：`1Password`、`Keychain Access`、`Bitwarden`、`LastPass`、`银行`、`Wallet`、`远程桌面/TeamViewer/AnyDesk/RustDesk/VMware/VirtualBox/Parallels`；会议 app 名单（`denyMeetingApps` 默认 true）。
- **有效状态**（设置页直接回答「会不会被观察」）：`captured / ignored / partial / outside-allowlist / blockedIndirectly`（screenpipe 语义，T4 核对成立）。
- **边界声明**：词表是启发式，不可能覆盖所有敏感场景；「未知内容级默认拒绝 + 用户可编辑」比词表长度更重要。

### 5.3 内容级采集 P1/P2（W-C；需 Screen Recording TCC）

**采集对象**：**前台单窗口**，绝无整屏选项。

**native helper 设计（`native/screengrab/`，新增 Swift target）**

| 项 | 设计 | 依据 |
|---|---|---|
| 进程形态 | **常驻 helper**（stdin/stdout NDJSON 或 Unix domain socket）；启动时预热 Vision；空闲 10min（可配 5–15min）自动退出；崩溃重启退避 1/5/15min；**首行必须 `_ = NSApplication.shared`**（否则 CLI 下 `CGS_REQUIRE_INIT` SIGABRT，T2 §3.3/§14.3） | T2 §8.3：Vision 每进程首次请求 **12.7s 冷启动**；warm accurate 82–98ms / fast 8–15ms |
| 两阶段 API | ① `probe`：前台窗口 id/几何/是否可捕获（**不读标题、不截图**）→ 主进程 gate 判定 → ② `capture`：指定窗口 id 截图 + OCR/氛围采样；任一步失败本次跳过 | 隐私「采集前拒绝」原则；darkitten `screen.context` 前置否决同款 |
| 截图主路径 | macOS 14+：`SCShareableContent` + `SCContentFilter(desktopIndependentWindow:)` + `SCScreenshotManager`（单次约 35ms）；macOS 13.x：`CGWindowListCreateImage` **仅在部署目标 13.0 的独立编译分支 + 运行时 `dlsym` 探测**（SDK 27.2 已 obsoleted=15.0，默认目标编译失败，T2 §4） | T2 §3/§4 |
| 处理腿 | 缩放（长边 ≤1280）→ JPEG（quality ≤70）；氛围层另做 160×90 四边带 HSV（排除自身 overlay）；dHash 9×8 变化检测，Hamming ≥6 才继续 | T2 §9（旧 API 整链 16–20ms）；dHash 参数来自 T4 §4.1（LingChat） |
| OCR | Vision `VNRecognizeTextRequest`（SDK 27.2 未废弃，仅 Revision2 deprecated；离线本机）；行级丢弃命中敏感词的行；截断 ≤1200 字符 | T2 §8；darkitten REDACT 行级（T4 核对） |
| 输出 | 严格 JSON 到 stdout/socket；**不写任何文件**；错误只回 code；图像字节不出 helper | A7 红线；T1 M2 |
| 失败/退避 | 无权限→`metadata`；连续 3 次失败→退避（1/5/15min），不刷日志；授权恢复后自动回 ocr | Miru 3 次/5min 退避（T4 核对）+ 原报告正确部分 |
| macOS 13 降级 | 内容级最低支持建议 14.0；13.x 自动 `metadata`（推荐方案 a，T2 §3.4） | — |

**TCC 流程**
- 只**查询** `systemPreferences.getMediaAccessStatus('screen')`（Electron 44 支持），**不弹窗申请**（`askForMediaAccess` 不支持 screen）；设置页提供系统设置深链 `x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture`。
- 首次开启内容级必须过 consent sheet：截图范围=前台单窗口、本机 OCR、不出网（评论例外需单独同意）、如何关闭；**确认前不采集**。
- 拒绝/撤销/受限 → 自动降级 `metadata`，不阻断启动与 P0。

**打包/签名（W-C 前置）**
- `scripts/build-native.mjs` 增加 `screengrab` target（universal arm64+x86_64、minos 13.0、stamp 幂等、`--check`）；
- `electron-builder.yml` `extraResources` 映射 + `scripts/package-check.mjs` 校验；签名顺序：先签嵌套 helper 再签 `.app`，最后公证；
- `docs/packaging.md` 增 TCC 行与降级路径；**adhoc 签名下每次重建都会重置 TCC 授权**（T2 §2.3），默认 ocr 在分发前不可行。

### 5.4 表达层

#### A. 非语言反应（零新增文本，W-B）
- **gaze 覆盖**：renderer `main.ts` 在写 `AnimationInput` 前把 `lookTarget` 覆盖为「前台 app 窗口方向/焦点」（窗口本地坐标），B3 look-at 直接消费；无需 mood/台词/契约变更（T1 §3.6-C）。
- **受控活动**：`runtime.debugTriggerActivity()` 已存在，可用于 `idleStretch/lookAround/idleGaze` 等一次性表演；**作为产品功能使用需 Lead 明确批准**（或下一轮把它提升为正式只读 API）。
- 冷却：app 切换事件后 1–2s 内一次、5s 冷却；专注/全屏/会议禁用。

#### B. 官方语音池语义映射（零新增文本，W-A/W-B）
| 场景 | 官方池 | 说明 |
|---|---|---|
| 专注开始 | `BUSY_BUBBLES`（战技/秘技/战斗开始） | "准备下注/全押"语义贴合 |
| 专注完成（自然结束） | `SUCCESS_BUBBLES`（战利品/终结技/晋阶/满级/行迹） | 与 DSH task/end 同情感语义 |
| 专注提前停止 | **静默**（`DEFEAT_BUBBLES` 语义偏负面，不用） | 只做非语言反应 |
| 离开很久回来/问候 | `GREETING_BUBBLES` | 与 hover 现有用途一致 |
| 屏幕观察类随口一句 | `IDLE_BUBBLES`（见闻/闲谈） | 只能说"砂金随口一句"，**不能说"你在写代码"** |
| 连续工作提醒休息 | **无对应官方分类** | 不自创；用官方池随机 + 非语言，或由 DSH 评论承担（默认关） |
| 通话/全屏静音 | 无台词（静默） | 最安全 |

#### C. DSH 模型评论（D1 决策；W-B2；独立文本类别）

**架构（T3 附录 A：有条件可行；两个阻断项均可设计规避——OCR 文本出网需用户同意、模型评论须按新文本类别建模）**

```
桌宠主进程                                   DSH Host 进程（桌面版常驻）
┌──────────────────────────┐   loopback   ┌────────────────────────────────┐
│ peek gate 放行            │  HTTP POST   │ dsh-aventurine-commenter 插件   │
│ → 脱敏 OCR/元数据文本      │ ──────────► │  ├─ webServer 路由（token/限流） │
│ → 出口脱敏（行级）         │  x-aventurine-token     │  ├─ ctx.llm.stream（无 sessionId）│
│ → dsh-commenter client    │ ◄────────── │  └─ 纯文本、无 attachments        │
│ → 出口七条过滤 → 气泡      │  评论/错误码  │     （DeepSeek 模型，默认关）      │
└──────────────────────────┘              └────────────────────────────────┘
        ▲ 能力文件 commenter.json（0600：origin/path/token/provider/model/limits）
```

- **DSH 侧新增独立 bundle** `bridge/dsh-aventurine-commenter/`（不改现有桥；`inject: ['llm','webServer']`；register `/__aventurine/comment`；随机 token；POST-only；loopback-only；body ≤32KB；单次 AbortSignal 20s；**不传 sessionId、不用 attachments、不写日志**；`reasoningEffort:'off'` 控费）。
- **桌宠侧新增**：`src/shared/commenter-schema.ts`（能力文件/请求/响应纯校验 + 出口过滤纯函数）、`src/main/desktop/dsh-commenter.ts`（HTTP client，读 `~/.dsh/aventurine-pet/commenter.json`）、`src/main/peek/comment-orchestrator.ts`、`src/main/ipc/screen-comment.ts`、`src/renderer/src/reactions/peek-comment.ts`、扁平配置键（`screenCommentEnabled` 默认 false 等）。
- **文本类别**：评论**不是**官方台词（不进口 `core/voicelines.ts`、不参与 SHA-256 锁测试）；气泡显示时**明确标注来源**（如「DSH」角标/不同样式），默认关闭；长度 ≤40 汉字。
- **出口七条过滤**（失败即沉默/回退官方池）：① 长度 ≤40 汉字；② 禁第一/第二人称接触式措辞（`我看到|你的屏幕上|你正在输入|正在看|屏幕里`）；③ 与本次 OCR 文本最长公共子串 ≥8 字 → 丢弃（防复读）；④ 禁 ≥11 位数字串/邮箱/URL/文件路径/代码样式；⑤ 与官方台词 ≥8 字连续匹配 → 丢弃（防复读/改写官方语音）；⑥ `SKIP`/空/系统提示泄漏（"作为 AI"）→ 静默；⑦ 失败静默优先，可选官方池兜底。
- **降级阶梯**：L0 能力文件缺失/过期 → 零调用；L1 401/403 → 重读 token；L2 连接失败 → backoff 10min；L3 `RATE_LIMIT/QUOTA/ACCOUNT_QUOTA` → 冷却 10min，`TRANSPORT/TIMEOUT` → 连续 3 次退避；L4 超时 → 丢弃本次不重试；L5 SKIP/过滤失败 → 静默/官方池兜底；L6 成功 → 「DSH 评论」气泡，`source:'dsh-model'`、`memoryEligible:false`。
- **隐私边界（必须写进设置页文案）**：纯文本直调不写 session JSONL、不发送 `dsh_session_log`、不产生 OTel session 记录、不产生本地附件；**唯一出网内容是脱敏后的 OCR 文本**；模型 provider 侧日志由 DeepSeek 政策决定（`unverified`）；用户可一键关闭。
- **费用**：单次约 0.8–1.2k tokens（prompt ≤1200 字符 + 输出 ≤120 tokens，`reasoningEffort:off`）；评论 ≤3 次/小时、最小间隔 10min；预算面板用 `usage` chunk 统计次数/token（不显示金额，费率由用户套餐决定）。
- **形态选择（待用户确认，§9-Q1）**：
  - **A1（推荐，已按 D1 预设计）**：自由生成「DSH 评论」一句旁白（新文本类别 + UI 标注 + 默认关 + 七条过滤）；
  - **A2（零新文本，最保守）**：模型只输出场景/情绪标签（如 `WORK_LONG`/`FOCUS_DONE`/`AWAY_BACK`），文本仍从官方池取——完全满足官方台词硬约束；若用户不愿新文本源，落这个。

> 决策记录要求：A1 会在产品语义上引入「非官方台词的宠物旁白」，Lead 应在 `docs/` 显式记录该决策（已有「思考中...」这类 UI 状态的先例，但「角色旁白」是新边界），避免后续 review 再判违规。

### 5.5 聚焦模式（W-A，零权限）

**定位**：应用内运行态状态机，**不尝试开关系统 Focus**（macOS 无公开 API）。

**状态机**
```
NORMAL --(用户开始 / 接受自动建议)--> FOCUS
FOCUS  --(计时结束 / 用户停止 / 硬中断)--> WRAP_UP(2s) --> NORMAL
FOCUS  --(用户拖宠物 / 打开聊天/设置)--> PAUSED --(继续 / 放弃)--> FOCUS
```

**三种模式**
| 模式 | 表现 | 适用 |
|---|---|---|
| `quiet`（默认） | 淡到 55%、FPS 降到 10、停自主活动、停主动说话、停内容级观察、只剩计时小条 | 不想被打扰 |
| `companion` | 保持可见、不说话、偶尔抬头；结束一句鼓励（官方池） | 想要陪伴感 |
| `pomodoro` | 25/5 或 50/10，结束提醒休息 + 伸展动作（`idleStretch`），内存态记录段数 | 需要节奏 |

**表现合成（硬要求）**
- 专注态是运行态：`effectiveOpacity = min(config.opacity, 0.55)`、`effectiveFpsCap = min(config.fpsCap, 10)`、`behaviorConfig = {...config, autonomous:false, mischief:false}`（组合值不写盘）。
- **绝不写回**用户 `PetConfig` 的 `opacity/fpsCap/autonomous/mischief`；退出专注恢复真实配置。
- 合成入口唯一：`getEffectivePresentation(config, focusState)`，`applyConfig` 与 focus 状态变化都走它。

**触发与结束**
- 用户主动（W-A 零新 IPC 路径）：设置页点「开始专注」→ 写扁平**运行态寄存键** `focusSessionStartedAtMs`（>0 = 会话开始时刻；`0` = 未在专注）→ 既有 `config-changed` 广播到 overlay → overlay `core/focus-mode.ts` 按该起点 + 偏好（`focusMode/focusMinutes`）跑状态机；结束/停止时写回 0 并清内存统计。该键是「运行态寄存」而非用户偏好（`sanitizeConfig` 注释与文档写明），启动时若 `now > startedAt + minutes*60000` 视为已结束、不恢复。备用入口：overlay 右键菜单本地开始（`InteractionEvent.menuAction` 是冻结类型，扩展需 Lead 评审，v1 可不做）。
- 自动建议（不自动进入）：IDE 前台持续 15min 且切换 ≤2 次 → 气泡建议，用户确认才进（依赖 W-B 的 P0 分类）。
- 自动静音（不是专注）：全屏/会议 → 立即淡出+静音，条件消失 5s 恢复；不计时、不统计。
- 结束语义：`TimeFinish / ManualStop / Interrupted`（`Interrupted` 用 `powerMonitor` suspend/lock 或 `beforeunload` 检测）；v1 统计**只在内存**（不新增存储）。

**计时 UI**：overlay 内 `pointer-events:none` 的 DOM 元素（倒计时/进度环），随宠物摆放定位；不改 canvas/命中。`position`（角落/自由）不搬移（运行态移动需要 B1/B2 新指令，v1 不做）。

### 5.6 透明面板 / 暂停 / 清空（W-B）

- 历史：主进程内存 `PeekHistoryEntry[]`（≤10；字段：`atMs/trigger/tier/activityClass/deniedReason/usedForSpeech/contentChars`），**不含内容、不含 app 名/标题**（排障需要时另设显式 opt-in debug 开关）。
- IPC：`pet:peek-history`（只读元数据）、`pet:peek-pause`、`pet:peek-clear-history`；手动观察 `pet:peek-observe-now` **只返回摘要**（`{ok,tier,reason,atMs,redaction,contentChars,providerId}`）。
- 设置页「屏幕感知」分区：总开关（metadata enabled）、有效档位/权限状态、内置拒绝清单（只读展示）、最近 10 次元数据、暂停/清空、「去系统设置授权」深链。
- 日志：只允许 `event/tier/capability/denyReason/activityClass/providerId/durationMs/count`；**不记 app 名、标题、OCR 文本、图像、URL、评论原文**；只记状态变化与失败，限流（首次/每分钟一条）。

---

## 6. 与现有代码的接线设计

### 6.1 A7 peek 契约最小合法扩展（W-B 前必须，追加式）

1. `PEEK_DENY_REASONS` **末尾追加** `'paused'`、`'rule-denied'`（保序，既有 7 值不动）。
2. 新增 `PEEK_CAPABILITY_PERMISSION`：`metadata:'none'`、`ocr/vision:'screen-recording'`；**修复 gate 第 4 步**——当前对 metadata 也要求 `granted`，会让零权限 P0 被永久拒绝（`src/shared/peek.ts:428-430`）。
3. gate 第 7 步 throttle **按 capability 分域**：metadata 事件驱动（轻量预算在主进程 budget 模块），内容级沿用 600s/3 次。
4. `PeekStatus` 追加可选 `rules?`、`paused?`；`PeekObservationRequest` 追加可选 `foregroundTitle?: string | null`（P0 恒 null）；`PeekObservationPayload['metadata']` 追加可选 `idleSeconds?/onBattery?/fullscreen?/foregroundWindowId?/dshOnline?`（追加不破坏旧消费方）。
5. 同步 `docs/peek-interface.md`、`tests/peek-gate.test.ts`、`tests/peek-service.test.ts`（静态扫描列表保持原 3 文件；P0 provider 不加入被扫描列表）。
6. 接 P0 provider 时把 `PEEK_DEFAULT_STATUS.notImplemented` 置 `false`（并让 ocr/vision 保持 `available:false, reason:'capability-unavailable'`）；否则 gate 第 3 步恒拒（`peek.ts:283-294,425-427`），同步 `tests/peek-service.test.ts`。
7. **明确不做**：`screen.peek.title`、`screen.peek.ambient`（后者等用户确认 P1 再追加）。

### 6.2 IPC 追加批次（需 Lead 评审，W-B/W-B2）

```
// invoke（加法式；既有 14 个不动）
pet:peek-status / pet:peek-observe-now / pet:peek-pause / pet:peek-clear-history / pet:peek-history
pet:screen-comment-status / pet:screen-comment-now        // DSH 评论（W-B2）
// 事件
peek-state / screen-comment-state                          // 状态摘要（无内容）
```

同步 6 处：`src/shared/ipc.ts`、`src/preload/index.ts`、`src/main/ipc/<领域>.ts`、`src/main/ipc/index.ts`、`src/renderer/src/main.ts`/`settings/main.ts`、`tests/shared-contract.test.ts`（14+4 计数与 `PetApi` 键集合精确断言）。

### 6.3 配置键（扁平可选原始键，不 bump `CONFIG_VERSION`）

| 期 | 键 | 默认 | 说明 |
|---|---|---|---|
| W-A | `focusMode`（enum quiet\|companion\|pomodoro）、`focusMinutes`（5–180，默认 50）、`focusBreakMinutes`（1–30，默认 5）、`focusAutoQuiet`（bool，默认 true）、`focusStatsEnabled`（bool，默认 false）、`focusSessionStartedAtMs`（number，默认 0；**运行态寄存键**：>0 = 会话开始时刻，结束/停止写回 0，启动时超时视为已结束不恢复） | — | 用户偏好键沿用扁平可选原始键；`focusSessionStartedAtMs` 是 W-A 零新 IPC 下设置页→overlay 的启动信号（T1 §6.8 方案，文档写明它是运行态寄存、不是用户设置） |
| W-B | `peekMetadataEnabled`（bool，默认 false）、`peekPaused`（bool，默认 false，重启恢复 false） | — | 内容级键留到 W-C 批次 |
| W-B2 | `screenCommentEnabled`（bool，默认 false）、`screenCommentTier`（metadata\|content，默认 metadata）、`screenCommentProvider`（string，默认空=用 commenter.json）、`screenCommentModel`（string，默认空）、`screenCommentMaxChars`（number 20–120，默认 40） | — | 幂等回填；`sanitizeConfig` 逐键分支 |
| W-C | `peekTier`（off\|metadata\|ambient\|ocr）、`peekIntervalSeconds`（90–600，默认 120）、`peekMaxPerHour`（0–10，默认 3）、`peekMinGapSeconds`（300–1800，默认 600） | — | 内容级默认 off |

> 嵌套 `screen`/`focus` 组若未来要做，必须先升级 `config-store`：`copyConfig` 深拷贝（现为浅拷贝，注释已警告）+ `set` 深合并语义 + `toConfigPartial` 嵌套语义 + `config-store.test.ts`「只改子键不丢其它子键」用例 + Lead 评审。**v1 不做。**

### 6.4 设置页分区（`src/renderer/settings.html` + `settings-model.ts` + `settings/main.ts`）

1. **「专注」**：模式选择、时长/休息、自动静音开关、开始/停止按钮、当前状态与剩余时间、统计（内存）。
2. **「屏幕感知」**：总开关、当前档位/权限状态（录屏 TCC 只读查询 + 深链）、内置拒绝清单（只读）、最近 10 次元数据、暂停/清空、consent sheet 入口。
3. **「DSH 评论」**（W-B2）：总开关（默认关）、provider/model 显示（来自 commenter.json）、频率上限、来源说明与隐私文案（脱敏文本会发送给模型）、预算统计。

### 6.5 文件级改动清单（实施批次用；本轮不改）

| # | 文件 | 类型 | 冻结契约/Lead 评审 | 冲突风险 |
|---|---|---|---|---|
| 1 | `src/shared/peek.ts` | 修改（追加） | **是** | 低 |
| 2 | `src/shared/peek-rules.ts`、`peek-activity.ts` | 新增 | 否 | 无 |
| 3 | `src/shared/ipc.ts` | 修改（追加） | **是** | 低 |
| 4 | `src/shared/config.ts`、`types.ts` | 修改（扁平键） | **是** | 低 |
| 5 | `src/shared/commenter-schema.ts` | 新增 | **是**（shared 层） | 低 |
| 6 | `src/preload/index.ts` | 修改（纯转发） | 是（白名单） | 低 |
| 7 | `src/main/ipc/{peek,screen-comment}.ts`、`ipc/index.ts`、`main/index.ts` | 新增/修改 | Lead-owned 集成 | 低 |
| 8 | `src/main/peek/{service,provider-p0,observer,comment-orchestrator}.ts` | 修改/新增 | A7 接口 | 低 |
| 9 | `src/main/desktop/{frontmost-app,dsh-commenter}.ts` | 新增 | 否 | 低 |
| 10 | `native/screengrab/**`、`scripts/build-native.mjs`、`electron-builder.yml`、`scripts/package-check.mjs`（W-C） | 新增/修改 | 打包契约 **是** | 中（native 重建需与另一会话对齐） |
| 11 | `src/renderer/src/core/{focus-mode,focus-timer-view}.ts`、`reactions/peek.ts`、`reactions/peek-comment.ts` | 新增 | 否 | 无 |
| 12 | `src/renderer/src/main.ts` | 修改（接线：合成/过滤/gaze/气泡） | Lead-owned 集成 | 低 |
| 13 | `src/renderer/settings.html`、`settings/settings-model.ts`、`settings/main.ts`、`style.css` | 修改 | 否 | 无 |
| 14 | `bridge/dsh-aventurine-commenter/**`、`scripts/activate-dsh-commenter.mjs` | 新增 | 否（不碰现有桥） | 低 |
| 15 | `tests/{peek-gate,peek-service,shared-contract,settings-model,config-store}.test.ts` + 新增 tests | 修改/新增 | 契约测试 | 低 |
| 16 | `docs/peek-interface.md`、`docs/packaging.md` | 修改（W-C） | 文档红线 | 无 |

**不改**：`src/renderer/src/behavior/behavior-director.ts`、`core/wave2-contract.ts`、`scene/pet-scene.ts`、`vrm/**`、`animation/**`、`model/**`、`physics/**`（全部走集成层）。**禁触**（另一会话活跃）：`assets/**`、`scripts/unity-bake/**`、`tests/tmp/lead-proportion-v3/**`、`docs/research/proportion-*`、`src/renderer/src/{model,vrm,animation,scene}` 中与模型比例/动作相关的文件。

> ⚠️ 并发会话提醒：审计期间另一会话已提交 `672c9da`（比例感知）、`e467f82`（sleep 移出自动播放）、`aaba07e`（gitignore）；任一后续实施前都须重新确认工作树状态。后续实施前须重新确认工作树状态；**禁止 `git add -A`/`stash`/`checkout -- .`/`reset`/`clean`**；`scripts/build-native.mjs`（W-C）会触发 native 重建，需与另一会话对齐。

---

## 7. 风险、未知与降级

### 7.1 TCC 真机现实（T2 实测，必须写进验收前提）

- 本机 **DeepSeek Harness 已获屏幕录制 + 辅助功能权限**；其 shell 子进程**继承**该授权（tccd 日志归责 `responsible=com.deepseek.dsh`）→ 从终端跑的 `electron .` / Swift 探针会**假绿**。
- **开发版验证 TCC 必须用 LaunchServices 独立启动**（Finder/open），不能从本会话 shell 启动。
- 当前打包 app 是 **adhoc 签名**（`flags=0x2(adhoc)`、无 TeamIdentifier）→ TCC 身份 = bundle id + cdhash，**每次重新打包都会重置授权**；默认 ocr 在正式签名/公证前不可行。
- macOS 27.2 仍要求用户授权屏幕录制（T2 §2.4 有来源）；「每月重新确认」在 27.2 是否仍存在**无法本机查证**（`unverified`）→ 降级路径必须常驻。

### 7.2 性能/工程风险

| 项 | 等级 | 缓解 |
|---|---|---|
| Vision 每进程首个请求冷启动 **12.7s** | 高 | helper **常驻+预热**（W-C 设计前提，首行 NSApplication 初始化）；空闲 10min（可配 5–15）退出；启动预热失败→降级 `metadata` |
| SCK 单次 35ms / 旧 API 整链 16–20ms（全屏） | 低 | 低频 90–180s 完全可接受；P1 10Hz 需 `SCStream`（**未验证**） |
| macOS 13.x 无 `SCScreenshotManager` | 中 | 建议内容级最低 14.0，13.x 自动 metadata（方案 a）；若必须 13.x 再启用旧 API 回退分支 |
| helper 常驻带来额外进程/内存 | 中 | 空闲退出 + 单个 helper 服务多个 overlay；CPU 增量目标 <2%（真机比对） |
| 单窗口在最小化/其他 Space/不可捕获 | 中 | probe 阶段判定，本次跳过；**绝不回退整屏** |
| 规则词表误判/漏判 | 中 | 未知内容级默认拒绝 + 用户可编辑 + 有效状态可视化；不宣称"100% 安全" |
| 模型评论复述/越界 | 高 | 七条出口过滤 + SKIP + 静态 prompt 约束 + 默认关闭 + 长度上限 |
| DSH 评论链路未在真实 desktop profile 验证 | 中 | T3 A.6.3 列出 6 项 `unverified`（webServer 路由、reasoningEffort off、account 直调、计费、过滤器阈值）；实施前用临时 DSH_HOME + 绝对路径 insert 实验，**不得在真实 profile 试装** |
| DSH 评论费用/隐私 | 中 | 默认关、≤3 次/h、`reasoningEffort:off`、明示"脱敏文本会发给 DeepSeek"、预算面板 |
| 与另一会话/未来改动冲突 | 中 | 实施前重查工作树；分批提交（A7 扩展、IPC、W-A、W-B、W-C 各自独立 commit/回滚点）；共享契约变更走 Lead 评审 |

---

## 8. 分期实施计划（本轮不实施；供下一轮排期）

| 期 | 范围 | 工作量 | 验收标准 | 测试策略 |
|---|---|---|---|---|
| **W-A** 聚焦模式（零权限） | 三模式状态机、计时 UI、有效表现合成、全屏/会议自动静音、设置页「专注」、扁平配置键 | 3–4 人日 | 无任何 TCC 可完整跑通；专注中主动说话 0 次、自主活动 0 次；退出 ≤5s 恢复；配置文件里用户 opacity/fps 未被改动；非主屏不跑计时；暂停/中断正确 | `tests/focus-mode.test.ts`（注入时钟）、`settings-model.test.ts`、`shared-contract.test.ts`、`config-store.test.ts` |
| **W-B** P0 元数据互动（零权限） | A7 扩展（gate 修复/规则/暂停/payload）、`peek-rules`/`peek-activity`、`frontmost-app`、P0 provider/observer、IPC 批次、设置页「屏幕感知」、gaze 非语言反应 + 官方池映射 | 6–9 人日 | 无 TCC；敏感 app 100% 不产生反应（fixture）；关闭开关零调用/零定时器；日志无 app 名/内容；1h 主动发言 ≤3；渲染层零 ExternalReaction/PET_MOODS 改动 | `peek-gate/peek-rules/peek-activity/peek-observer/frontmost-app` 新增测试（注入时钟/exec/快照）；`shared-contract` 更新 |
| **W-B2a** DSH 评论（metadata-only，零内容权限） | `dsh-aventurine-commenter` bundle + 桌宠 client/schema/IPC/orchestrator/气泡 + 七条过滤 + 设置页开关 | 2–3 人日（W-B2 合计，含 B2b 链路骨架；T3 A.6.1） | DSH 离线零调用；评论 ≤40 字；过滤 fixture 全绿；默认关；不进台词池/SHA 锁/会话历史；出口无 OCR 原文 | `commenter-schema/dsh-commenter/peek-comment` 单测（mock HTTP 200/401/429/超时/畸形 JSON） |
| **W-C** P1/P2 内容级（需 TCC） | `native/screengrab` 常驻 helper（probe/capture、SCK 主路径、13.x 回退）、Vision OCR 预热、单窗口/氛围/dHash、TCC 查询/深链/降级/退避、打包链、设置页授权引导 | 8–12 人日 | 敏感 app/全屏/会议 100% 跳过；截图/OCR 不落盘（临时目录检查）；日志无文本；拒权自动降级 P0 可恢复；连续 3 次失败退避不刷日志；关闭后无 helper spawn | helper 注入 fake spawn/stdout；脱敏/规则表格测试；TCC 分支手动真机验收（LaunchServices 启动） |
| **W-B2b** 内容评论（随 W-C） | OCR 脱敏文本 → 同一评论链路；content consent sheet（明示出网） | 增量约 0.5–1 人日（含在 W-B2 合计内，随 W-C） | 只有显式同意+开启才出网；出口过滤对原文复读 0 容忍 | 复用 W-B2a 测试 + consent 状态机单测 |
| **W-D** 原 P3 VLM | **取消/不排期**：由 D1 的 DSH 评论替代；保留 DSH 图像能力作为未来可选（附件永久落盘，不推荐） | — | — | — |

**总计**：纯实施约 **19–28 人日**（W-A 3–4 + W-B 6–9 + W-B2 2–3 + W-C 8–12；A7/R4 已完成的契约与 gate 已抵扣约 4–6 人日，不再重复计）；加真机/评审/回滚验证 4–6 → **约 23–34 人日**。**W-A 可独立交付**，且不依赖任何新契约（只加扁平配置键）；W-B 是一次 Lead 评审的追加式契约批次；W-C 是 native+TCC 批次。

---

## 9. 待用户拍板的剩余决策（含推荐）

| # | 问题 | 选项 | 推荐 |
|---|---|---|---|
| Q1 | 评论形态（D1 已定"用 DSH 模型"，但未定形态） | A1 自由生成「DSH 评论」一句旁白（新文本类别/UI 标注/默认关/七条过滤）<br>A2 模型只输出场景标签、文本仍取官方池（零新文本） | **A1**（按 D1 预设计；若你更看重"绝不新增角色文本"，改 A2，成本不变） |
| Q2 | 默认档位/TCC | A. 内容级默认**全关**，用户显式开 metadata；内容级二次确认<br>B. 默认 metadata（无权限）<br>C. 原报告：默认 ocr + 首启引导 | **A**（A7 契约默认 + adhoc TCC 现实 + 隐私观感）；C 在正式签名/公证前不可行 |
| Q3 | P1 氛围层是否做 | A. 不做（v1 只 P0）<br>B. 做（需 SR TCC，信息量最小但权限同 P2） | **A**；若你明确要"拒绝内容级权限也要生命感"，再排 P1（注意它不免权限） |
| Q4 | 透明面板回看粒度 | A. 只元数据（app 类别/时间/原因/是否发言），不落盘<br>B. 回看最近 N 分钟脱敏文本（需内容过 IPC/内存历史，违反 A7 内容边界，需契约变更） | **A**；B 属独立隐私评审 |
| Q5 | 窗口标题能力 | A. 不做（规则只到 app 级）<br>B. P2 时用 SR 顺带读标题（同 TCC，但标题暴露面更大）<br>C. 新增 Accessibility 路径（新权限红线） | **A**；B 在 W-C 单独评审；C 不做 |
| Q6 | 专注统计是否持久化 | A. 只在内存（推荐）<br>B. 新存储 `focus-stats.json`（本地、可清空、只存时长/结束原因） | **A**；B 等明确要"专注历史"再排 |
| Q7 | 聚焦模式气质 | quiet / companion / pomodoro（可同时实现） | **默认 quiet**；companion 的"陪坐"涉及 B1/B2 目标，W-B 后评估 |
| Q8 | 麦克风/会议检测 | A. 砍掉麦克风，用会议 app 名单启发式<br>B. 新增 native CoreAudio helper（新二进制） | **A**（T2 本机无输入设备，且无 Electron API） |
| Q9 | DSH 评论默认 provider/model | A. 跟随 commenter.json（`deepseek-account`/`deepseek-flash`）<br>B. 固定某 provider | **A**；插件 `listProviders/listModels` 校验，不可用则能力文件 `enabled:false` |

---

## 10. 参考项目修正后的选型（原报告 §3 的修正版）

| 项目 | 许可证 | 取它什么 | 明确不取什么 |
|---|---|---|---|
| `LFELKEEA/darkitten-pet`（用户点名 launcher 的姊妹仓库，**屏实现在这里**） | MIT（代码；`vendor/live2d` 与第三方模型不在内） | 三档观察模式（window/ocr/vision + auto）、6 道 pre-gate 顺序、默认关闭、内存态/不落盘、OCR 行级 REDACT、SKIP 提示词、两级失败降级（vision 拒绝→window；OCR 空→window）、可配置闸门+状态原因 UI | 整屏 `grabWindow(0)`；Windows-only；`lastComment` 死字段（不抄） |
| `LFELKEEA/darkitten-launcher`（用户点名仓库） | MIT | **发布/运维**参考：manifest+sha256+原子替换+失败回滚、自更新两阶段、诊断包 token 脱敏 | 无屏能力（198 个 .py 无采集实现）；无进程守护/权限引导 |
| `Project-N-E-K-O/N.E.K.O` | Apache-2.0 | 屏幕评论污染隔离（原始记录≠模型上下文）、曝光 UI、Focus 滞回、图片规格统一、链式污染判定器（可复制） | 它的 Focus 是模型思考预算，不是用户专注模式 |
| `SlimeBoyOwO/LingChat` | AGPL-3.0 | 节奏设计：UserState 分类、加权意图路由、interest 累积/发言清零、`max_proactive_times=3`、投递闸门、9×8 dHash | **代码不可抄**（AGPL）；Win32 键鼠钩子（macOS 需 Input Monitoring） |
| `kiyotakali/Miru` | Apache-2.0 | 采样/退避参数（30s/5s/0.30、3 次失败 5min 退避、`ioreg` 空闲）、salience 分级延迟、15min 介入下限、30min 意图去重、聊天中静默 | 整屏 `screencapture`、无敏感闸门、HTTP POST、半废弃记忆链路 |
| `mediar-ai/screenpipe`（现 `screenpipe/screenpipe`） | Screenpipe Commercial License（source-available） | 规则语法（`App`/`App::Title`/`::Keyword`）、有效状态（captured/ignored/partial/outside-allowlist + blockedIndirectly）、隐私设置页 IA、无痕识别决策 | 常驻全量录制；**代码不可复制** |
| `ayangweb/BongoCat` | Apache-2.0 | overlay 声明式配置 schema + accept fixture 写法（schema 81 属性，核心行为有 fixture）、**内置 pomodoro 插件**（宿主不持有计时规则、25min 可配、暂停/重启/状态持久化） | 键鼠可视化玩法 |
| `Mate-Engine`（本地 refs） | MateEngine Pro License v2.1（自定义商业，非开源） | 氛围探针：160×90、四边带 HSV、排除自身窗口、smoothing 0.85、10Hz | `uWindowCapture`（Windows-only 纹理捕获）；不可复制代码 |
| `LorisYounger/VPet`（可选） | Apache-2.0 | 专注计时结束语义（TimeFinish/ManualStop/StateFail/Other）、显示模式（默认/剩余/已获取/隐藏） | 养成经济系统 |

**许可证结论**：只复制 MIT（darkitten）/Apache（N.E.K.O、Miru、BongoCat、VPet）实现；AGPL（LingChat）与商业许可（screenpipe、Mate-Engine）**只借设计，不抄代码**；Apache 复制需保留 LICENSE/NOTICE。

---

## 11. 证据索引

- 本轮四份审计报告（见开头）；A7 契约 `src/shared/peek.ts` / `docs/peek-interface.md` / `tests/peek-{gate,service}.test.ts`；R4 完整设计 `docs/research/peek-interface-audit-2026-11-11.md`。
- 冻结契约：`src/shared/ipc.ts:23-57,116-141`、`tests/shared-contract.test.ts:14-63,83-111,115-152`、`src/shared/config.ts:22,36-57,140-206`、`src/shared/types.ts:33-65,90-151`、`src/renderer/src/core/wave2-contract.ts:177-199,201-246`。
- 配置存储陷阱：`src/main/config-store.ts:59-65,189-198,217-224`。
- 台词硬约束：`src/renderer/src/core/voicelines.ts:1-33,176-177`；`behavior/dialogue.ts:17-19,23-61,109`；`tests/voicelines.test.ts:140-143,175`。
- 渲染/行为接线点：`src/renderer/src/main.ts:533-555,898-917,944-962,1103-1119,1302-1340,1391-1422`；`core/pet-runtime.ts:101-111,626,739,790-810`。
- 零权限信号：`node_modules/electron/electron.d.ts:11580,11586,11599`（powerMonitor）、`:14806`（getMediaAccessStatus）；`src/main/desktop/{dsh-process,dsh-version}.ts`（lsappinfo 先例）。
- 全屏/winlist 语义：`native/winlist/main.swift:5-8,150-160`；`docs/packaging.md:64-120,163-213`（TCC 红线/ad-hoc）。
- DSH 评论链路：`docs/research/screen-awareness-dsh-integration-audit-2026-11-11.md` §A.1–A.6（`dsh-llm/lib/typert.host.js:355,360,552`、`dsh-host-webserver/README.md:39,63,132`、`dsh-compaction-basic/lib/index.js:289-335,801-805`、`dsh-attachment/README.md:119`、`dsh-session-log-deepseek/README.md`）。
- 原生实测证据：`/tmp/screen-spike/**`（探针源码/日志/输出索引见 T2 §12）。

---

## 12. 本轮交付物与下一步

**交付物（均为文档；代码零改动）**
1. `docs/research/screen-awareness-architecture-review-2026-11-11.md`（T1）
2. `docs/research/screen-awareness-native-spike-2026-11-11.md`（T2）
3. `docs/research/screen-awareness-dsh-integration-audit-2026-11-11.md`（T3，含附录 A）
4. `docs/research/screen-awareness-reference-audit-2026-11-11.md`（T4）
5. **本文档**（修正版设计，替代原报告的项目内集成方案）
6. `README.md` 索引 +1 行（本文档入口）

**明确不做**：不改任何 `src/**`、`tests/**`、`native/**`、`bridge/**`、`assets/**`、打包配置；不申请/触发 TCC；不在真实 DSH profile 安装插件；不重启 DSH；不提交代码（工作树中另一会话的改动保持原样）。

**建议的下一步（下一轮，需用户确认 §9 决策后）**
1. Lead 评审并批准 §6.1（A7 追加式扩展）+ §6.2（IPC 批次）+ §6.3（扁平配置键）；
2. 落 **W-A**（零权限、可独立回滚）→ 用户实机验收聚焦气质；
3. 落 **W-B**（P0 元数据互动 + 透明面板 + 非语言/官方池表达）→ 验收"实时但不烦人"；
4. 落 **W-B2a**（DSH 评论 metadata-only，默认关）→ 用临时 DSH_HOME 先验证 commenter bundle，再决定是否进真实 profile；
5. 视用户对 TCC 的接受度与签名称号，再排 **W-C**（内容级）与 **W-B2b**（内容评论）。

---

*本文档为设计交付，不代表用户对 §9 剩余决策的授权；实施前需 Lead 评审冻结契约改动，并取得用户对 Q1–Q9 的确认。*
