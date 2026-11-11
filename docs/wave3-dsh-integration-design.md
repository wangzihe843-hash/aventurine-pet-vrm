# Wave 3 + DSH 双向集成 — 实施设计（冻结契约 v2）

> 日期：2026-11-11 · 状态：**implementing** · 依据：R1/R2/R3/R4 四份调研报告（`docs/research/*-2026-11-11.md`）+ 用户 2026-11-11 决策
> 目标：V9（清理/性能/打包）+ V10（烘焙动作并入验收收口）+ 桌宠 ⇄ DeepSeek Harness 双向集成
> 用户已拍板：**① 强耦合（一方显式退出另一方跟着退）② 只认桌面版 `DeepSeek Harness.app`（bundle id `com.deepseek.dsh`）③ 气泡按「每段输出」同步 ④ 扩展桥装进 desktop profile、不重启 DSH（HMR 生效）**

---

## 1. 总目标与验收（用户视角）

1. **互保活（强耦合）**：任一方启动 → 另一方若不在则被拉起；任一方显式退出 → 另一方跟随退出；意外崩溃 → 对方在冷却/ grace 内先尝试拉起，失败则跟随退出。任一方运行期间，另一方必然存在。
2. **状态反应**：DSH busy/done/error 驱动桌宠动作与台词（现有 `ExternalReaction` 映射，链路已就绪，缺的是桥真正装上 + 在线）。
3. **气泡实时同步**：DSH 每个 step/段结束后的 assistant 输出 → 头顶气泡；思考中显示 `思考中...`；一段停留后消失，下一段再弹；长文本按句/段拆分轮播；与现有行为层台词/口型/反应气泡仲裁。
4. **窥屏互动接口**：只落类型 + 能力/权限模型 + fail-closed gate + 空 provider + 单测 + 文档；**本轮零采集**、零 IPC/配置改动、默认关闭、设置页不显示。
5. **V9**：electron-builder 本机无签名 `--dir` 打包骨架、extraResources 映射、entitlements 占位、性能基线测量、权限引导回归、known-issues 更新。
6. **V10**：把 Wave 1.5 烘焙动作（mate 30 条 + HSR/adv）并入 app manifest 的最终验收证据、文档口径、可选 `--check` 门禁；不改数据接线（R1 已确认数据接线完成）。
7. **安全红线**：开发期间不碰真实 `~/.dsh`（只读）、不重启/杀死真实 DSH、不在真实 desktop profile 装桥；所有实机实验用临时 `DSH_HOME` + 临时 profile + 临时 `HOME`/`PET_PROFILE`。最终激活只在全部测试通过后由 Lead 执行（备份 + 可回滚）。

---

## 2. 调研结论（决定实现方式的硬事实）

### 2.1 DSH 侧（R2，源码 + 临时 profile 实测）

- assistant 文本可拿：durable `session/event` 的 `type='assistant/message'`，文本在 `data.message.content[]` 中 `type==='text'` 块的 `.text`；**每个 step 一条、完整终态非增量**；turn 最终回答 = 该 turn 最后一个非空 assistant text。
- 实时增量 `agent/assistant-stream` 仅进程内，本轮**不用**（避免高频刷文件；且用户要的是「结束思考/操作之后」的段文本）。
- 「思考中」：无需 thinking 事件；`task/start` → 在线且 busy 且无文本即可。durable `step/start` 可兜底，但本轮不加事件类型。
- 插件 `apply` 在 Host 启动时执行；`dispose` 在 HMR 替换 / DSH 退出（SIGTERM 实测）时执行。插件可 spawn/守护子进程。
- **HMR 免重启激活可行**：改 desktop profile `cordis.patch.yml` 追加 insert 行（可直接写**绝对路径**插件，不经 pnpm）→ 运行中旧实例 dispose + 新实例 apply；可回滚。**这是最终激活方式**。
- 进程/bundle：主 app 进程名 `DeepSeek Harness`，bundle id `com.deepseek.dsh`；`open -b com.deepseek.dsh` 在 Electron 单实例锁下只聚焦现有窗口，安全幂等；无内置开机自启。
- 会话落盘 `session.v4.jsonl.zstd`（批写），只宜兜底，不作主通道。

### 2.2 桌宠侧（R1）

- 当前无反应的根因：桥没装进 desktop profile（超过 TTL → offline → 事件被丢弃），不是映射 bug。
- `BubbleView` 是单槽一次性展示：**不改 bubble.ts 语义**，新增 renderer 纯逻辑对话状态机，Lead 在 `main.ts` 接线。
- `dsh-watch` 尾随 events.jsonl 支持增量/轮转/半行；`status.json` 750ms 轮询；事件只在 online 时转发。
- pet 全仓无 DSH 进程探测；`launchAtLogin` 只管 pet 自身；dev 下 `PET_PROFILE` 隔离 userData。
- V9 未开始；V10 数据接线已完成（app-manifest 40 clips / catalog 181），只剩验收/文档。

### 2.3 外部（R3）

- 生态先例：`dsh-co-pet`（UDP+状态文件+autoLaunch+电源开关）、`dsh-desk-pet`（macOS 外部窗+`~/.dsh` 监视+单实例 `--stop`）、`mjw-git/dsh-pet`（SSE+轮询兜底）。
- 互保活建议：幂等 `open -b`、单实例锁、心跳 TTL、冷却/退避、显式退出墓碑；**用户选择了强耦合**，我们用「显式退出墓碑 + 进程消失检测 + 崩溃先重启后跟随退出」实现，避免互相误杀循环。
- 气泡：不逐 token；按段 + 长度分层 dwell + 去重 + 优先级 + 新段打断旧队列；`思考中` 占位。
- macOS 检测首选 `lsappinfo`（无 TCC），`pgrep` 兜底（排除 Helper）；`osascript` 会触发 Automation TCC，**不用**。

### 2.4 已有可行性报告（R4 / screen-awareness）

- 窥屏是四层能力（P0 元数据零权限 / P1–P3 抽样越权），隐私必须是采集前 fail-closed 的规则引擎；本轮只落接口。

---

## 3. 契约 v2（加法式，冻结）

### 3.1 事件文本（`src/shared/bridge-schema.ts` / `src/shared/types.ts`）

- `DSH_EVENT_PAYLOAD_KEYS` 增加 `'text'`；`DSH_EVENT_TEXT_MAX_CHARS = 8000`（UTF-16 code unit）。
- `sanitizeDshEventPayload`：`text` 走 8000 截断（与 `message` 512 区分）；空串丢弃；其它规则不变。
- **不新增** `DshEventType`；文本随 `session/event` 的 payload 走：
  - `eventType: 'assistant/message'` + `sessionId/turn/step/seq` + `text`（仅当文本非空；纯 tool-call 消息不写 text，仍写事件）。
- 隐私：**只写 assistant 输出文本**；不写 user 输入、不写 reasoning/thinking 正文、不写 tool 参数/结果正文；单行仍受 64KB 硬上限保护。
- 桥插件文本提取：
  1. `event.data.message.content` 为数组时，取所有 `block.type === 'text'` 的 `block.text`（字符串）按 `\n` join；
  2. trim；空 → 不写 `text`；`> 8000` → slice(0, 8000)；
  3. 防御：任何访问异常 → 不写 text（事件仍写）；不把数组/对象塞进 payload。

### 3.2 控制文件（新增，`src/shared/bridge-schema.ts` + 桥 `lib/constants.js` 副本）

`~/.dsh/aventurine-pet/control.json`（原子写：tmp → rename；`0600`）：

```json
{ "schemaVersion": 1, "ts": 1762500000000, "action": "attached", "dshPid": 12345 }
```

- `action ∈ {'attached','detached'}`；`attached` = 桥实例已加载（启动/HMR 重载后）；`detached` = 桥 dispose（DSH 退出或 HMR 卸载）。
- 常量：`BRIDGE_CONTROL_FILE = 'control.json'`、`BRIDGE_CONTROL_SCHEMA_VERSION = 1`。
- 校验：`isDshBridgeControlFile` / `parseDshBridgeControlFile(text)`，脏输入返回 null，绝不抛。
- 语义（2026-11-11 用户拍板「强耦合」后的最终实现）：**detached 只是「桥没了」的信号，不能单独证明 DSH 进程退出**（HMR 也会 detach）。桌宠侧：
  1) detached → 等待 1500ms grace；期间收到 attached 则取消（HMR 竞态）；**grace 未到期前，3s 进程 tick
     不得按「进程消失」发起重启**（tick 与 watcher 750ms 轮询是两个时间线，见 §4.1 的 2026-11-11 修正）；
  2) grace 到期后探测 DSH 进程：
     - **进程已不在** = DSH 显式退出 → 桌宠**跟随退出**（`dsh-exit`，不重启）；
     - **进程仍在** = HMR 重载慢 / 插件被卸载但宿主存活 → 保持 PAIRED 等待重新 attached（不重启不退出）；
       此后进程再消失 = DSH 显式退出 → 跟随退出（`dsh-exit`），仍不重启；
  3) 若始终没有 detached 而进程消失（崩溃/被强杀）→ **先等一个 grace 确认窗口**（给 watcher 读
     detached 的机会，防 tick 抢跑误判），确认窗口内仍无 detached → 按冷却重启 ≤2 次，仍失败 → 跟随退出（`dsh-gone`）。

> **2026-11-11 实机修正（用户报 bug：关掉 DSH 后桌宠反而把 DSH 重新打开）**：旧实现中 3s tick 会抢在
> 1.5s detached grace 之前把「进程消失」判成崩溃并 `open -b` 重启；且「detached 后 grace 到期进程仍在」
> 的等待态下进程再消失会走 process-gone 重启。现实现：detached 待定期禁止重启 + 任何进程消失都先过
> grace 确认窗口（期间 detached → 显式退出不重启；无 detached → 崩溃重启）。单测见
> `tests/dsh-lifecycle.test.ts`「显式退出语义」组；E2E 见 `scripts/wave3-e2e/e2e-coupling.mjs` 场景 E。

### 3.3 配置项（`src/shared/config.ts` + `types.ts`，CONFIG_VERSION 仍为 1）

| 键 | 默认 | 语义 |
|---|---|---|
| `dshCoupling` | `true` | 双向保活/强耦合总开关（dev 下还须 `PET_DSH_COUPLING=1` 才生效；打包版默认按此配置） |
| `dshBubbleSync` | `true` | 气泡同步 DSH 回复（`思考中...` + 每段输出） |

- 设置页新增两个开关（A4）；未知键丢弃、缺省回填沿用 `sanitizeConfig`。
- **不新增 IPC 通道**；生命周期状态复用 `pet:dsh-status`（online/running）+ 设置页现有状态行。

### 3.4 桥插件配置（`cordis.patch.yml` insert row `config`，全部可选）

| 键 | 默认 | 语义 |
|---|---|---|
| `dir` / `rotateBytes` / `maxLineBytes` | 现状 | 不变 |
| `launchPet` | `false` | apply 时若为 true → 拉起桌宠一次（幂等 open） |
| `petAppPath` | `''` | 桌宠 `.app` 绝对路径（优先 `open <path>`） |
| `petBundleId` | `''` | 桌宠 bundle id（`open -b <id>`；与 petAppPath 二选一，path 优先） |
| 环境变量 `AVENTURINE_BRIDGE_DISABLE_LAUNCH=1` | — | 强制禁用拉起（测试/canary 用） |

### 3.5 测试钩子（dev-only，生产无效）

为让验证不碰真实 DSH，`src/main/desktop/dsh-process.ts` 支持（仅当 `PET_DSH_TEST_HOOKS === '1'`）：

| 环境变量 | 作用 |
|---|---|
| `PET_DSH_TEST_PROCESS_PATTERN` | 覆盖进程检测模式（默认 `DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness`） |
| `PET_DSH_TEST_LAUNCH_CMD` | 覆盖拉起命令（`sh -c`，detached） |
| `PET_DSH_TEST_QUIT_DELAY_MS` | 覆盖 term→kill 升级时间 |

`PET_DSH_COUPLING_DISABLE=1` 无条件禁用耦合（任何构建）。

---

## 4. 桌宠 ⇄ DSH 强耦合（A3 实现 + Lead 接线）

### 4.1 状态机（main 进程，单例 `DshLifecycle`）

输入：config（`dshCoupling`）、env、`dsh-watch` 的 control/status、进程探测 tick（3s）、app 生命周期事件。

```
DISABLED ──config/env off──┐
   ▲                       │
   │                  ┌────▼────┐   pet 启动 / config on
   │                  │ STARTING │──(DSH 未运行)──► launch(open -b com.deepseek.dsh)，冷却 60s，最多 3 次/90s
   │                  └────┬─────┘
   │                       │ 桥 online
   │                  ┌────▼────┐
   │                  │ PAIRED   │◄──── attached 控制帧 / 心跳
   │                  └────┬─────┘
   │   detached(grace 到期+进程已不在) → cascade quit('dsh-exit')，不重启
   │   detached(grace 未到期/tick 抢跑)  → 禁止重启；交给 grace 定时器裁决
   │   detached(grace 到期+进程仍在)     → 保持 PAIRED 等 attached（HMR/插件卸载）；
   │                                        之后进程再消失 → cascade quit('dsh-exit')，不重启
   │   无 detached 的进程消失(崩溃)       → 先等 grace 确认窗口：期间收到 detached → dsh-exit；
   │                                        否则重启(≤2 次/5s 间隔)，仍失败 → cascade quit('dsh-gone')
   │                  ┌────▼─────┐
   └──────────────────│ CASCADING│── app.quit(quitReason='dsh-exit'/'dsh-gone')
                      └──────────┘
```

- **pet 退出（显式 `before-quit`）**：若 enabled && DSH 进程存在 && 退出原因不是 `dsh-exit` → `preventDefault()` 一次 → SIGTERM DSH → ≤5s 等进程消失 → `app.quit()`。超时强杀（SIGKILL）后继续退出。
- **不互杀循环**：`quitReason='dsh-exit'` 时不再向 DSH 发信号；`dshTerminatedByPet` 时 DSH 消失不再重启。
- **UI 反馈**：DSH 离线时 `pet:dsh-status.online=false`，设置页显示"离线/未连接"；耦合失败只 log + 设置页状态，不弹窗。
- **dev 安全**：`!app.isPackaged` 时 `dshCoupling` 必须叠加 `PET_DSH_COUPLING=1` 才启用（防开发误杀真实 DSH）；打包版直接按 config 生效。
- 每次动作写 main.log：`[dsh-lifecycle] launch/terminate/cascade/…`，含 reason/pid/耗时。

### 4.2 进程探测/拉起/退出（`src/main/desktop/dsh-process.ts`，可注入）

- `isRunning()`：`lsappinfo find bundleID=com.deepseek.dsh`（exit 0 且输出非空）→ fallback `pgrep -f '<pattern>'`；排除 Helper/browser 进程。注入 `execFile` 便于单测。
- `launch()`：`open -b com.deepseek.dsh`（单实例锁幂等）；注入。
- `getPid()`：pgrep 输出 pid 列表取主进程。
- `terminate(pid)`：SIGTERM，等 ≤5s，仍存在 → SIGKILL。
- **绝不使用 osascript**（Automation TCC）。

### 4.3 控制文件接入（`src/main/desktop/dsh-watch.ts` 扩展 + `src/main/ipc/dsh.ts`）

- `createDshWatcher` 增加 `onControl(cb)`：每 750ms 轮询 `control.json`（mtime+size 变化才读，最大 64KB）；解析失败忽略；去重（同 action+ts）。
- `registerDshIpc`：创建 `DshLifecycle`，传入 watcher control/status；`app.on('before-quit')` 级联；`will-quit` 清理。**全部在 `ipc/dsh.ts` 内自包含，不动 `src/main/index.ts`**。
- 配置读取：`AppContext` 若已暴露 config/getter 则用之；否则由 Lead 在 `ipc/dsh.ts` 注入（A3 先按 `AppContext` 现有能力实现，缺什么找 Lead）。

---

## 5. 气泡同步（A2 纯逻辑 + Lead 在 `main.ts` 接线）

### 5.1 模块 `src/renderer/src/reactions/dsh-dialogue.ts`（新，纯逻辑；不 import DOM/Electron/three）

常量（导出可测）：

| 常量 | 值 | 说明 |
|---|---|---|
| `THINKING_TEXT` | `'思考中...'` | 思考占位（用户指定文案） |
| `CHUNK_MAX_CHARS` | `96` | 单气泡最大字符数（超长按句/逗号/换行拆） |
| `DWELL_PER_CHAR_MS` | `45` | 长度分层层 |
| `MIN_DWELL_MS` / `MAX_DWELL_MS` | `2200` / `9000` | 停留时长钳制 |
| `INTER_SEGMENT_GAP_MS` | `350` | 两段之间完全隐藏的间隔 |
| `QUEUE_MAX` | `8` | 段队列上限（溢出丢最旧，防长回合堆积） |
| `MAX_TURN_TEXT_CHARS` | `4000` | 单 turn 文本总预算 |
| `DEDUPE_SIZE` | `32` | 去重窗口（sessionId+turn+step+seq/text hash） |

API：

```ts
export interface DshDialogueOutput { text: string | null; kind: 'thinking' | 'speech' | null; lifetimeMs: number }
export class DshDialogue {
  pushEvent(event: DshEvent, nowMs: number): void
  tick(nowMs: number): DshDialogueOutput
  reset(): void
}
```

行为：

1. `task/start`（或 `agent/status running`）→ `busy=true`；无文本时 tick 返回 `思考中...`（kind=thinking，lifetime 不设过期，持续到状态变化；由调用方每帧 show 刷新）。
2. `session/event` + `eventType==='assistant/message'` + `payload.text` → 清洗后切块入队；同 key 去重；同 turn 文本总预算 4000 字符（超出截断丢弃并记录）。
3. `task/end` / `task/error` / `turn/end` → `busy=false`；队列继续按顺序播完，播完归 null（main 层再允许行为气泡/`dshDone` 台词）。
4. `tick` 调度：当前段显示 `dwell=clamp(2200+45*len, 2200, 9000)` ms → 隐藏 `GAP` → 下一段；无队列且 busy → thinking；否则 null。
5. 清洗 `cleanAssistantText`：去代码围栏（整块含内容删除）、行内反引号去壳、`**/__/*` 去标记、链接 `[x](url)`→`x`、图片/HTML 标签去掉、列表符号/标题号去掉、连续空白折叠成单空格；空结果丢弃。
6. 打断/重置：config 关闭 / DSH offline / 新 `task/start` 清空旧队列并重新开始（防上一轮堆积）；`task/error` 清空未播文本（错误由反应层表演）。
7. 多 session：按事件到达顺序排队；去重 key 含 sessionId，避免串 session。

单测（fake clock）：思考→文本→消失→下一段、长文本切块、纯 tool-call 消息无 text、去重、队列上限、turn 结束 flush、error 清空、offline reset、无重复同句、dwell 边界、clean 各分支。

### 5.2 Lead 接线（`src/renderer/src/main.ts`）

- `const dshDialogue = new DshDialogue()`（bootstrap 时）；`api.onDshEvent` → `dshDialogue.pushEvent(event, performance.now())` + 现有 `runtime.pushDshEvent` 保持。
- 每帧渲染：`const dialogue = dshDialogue.tick(nowMs)`；若 `dialogue.text !== null` → `bubble.show(dialogue.text, nowMs, dialogue.lifetimeMs)`（思考中持久：lifetime 传 `THINKING_REFRESH_MS`，每帧刷新即可），**不**再显示 behavior 气泡；否则走现有 `output.decision.bubble`。
- `bubbleText`（口型）取实际显示文本；config `dshBubbleSync=false` → dialogue.reset() 并跳过。
- 行为层/反应层台词不删除：dialogue 无输出时照旧。

---

## 6. 桥插件 v2（A1）

- 文本：3.1 的提取/截断/跳过空；`buildSessionPayload` 对 `assistant/message` 增加 `text`；`tool/result` 等仍只写标量。
- 控制文件：3.2；apply 时 `attached`，dispose 时 `detached`；heartbeat 不重写 control（减少写盘，只有状态切换写）。
- 拉起桌宠：3.4；apply 时 `launchPet` 且非 `AVENTURINE_BRIDGE_DISABLE_LAUNCH`：
  - **优先直接执行 `<App>.app/Contents/MacOS/<App>`** 并清洗环境变量 `ELECTRON_RUN_AS_NODE`
    （2026-11-11 实机发现：DSH Host 自身带该变量，`open` 拉起的 Electron app 继承后会以
    Node 模式启动并立即退出；直接执行同时绕过 LaunchServices 对无 CMS 签名 app 的 AMFI 限制）；
  - 解析不到可执行时回退 `open <path>` / `open -b <id>`；失败只 warn，不影响宿主；每个 apply 实例最多一次。
- 测试：`tests/bridge-plugin.test.ts` 更新 F5 断言（现在允许 assistant/message 带 text，但 user/tool 正文仍不得出现）+ 新用例：文本提取（多 text block join/空/超长截断/异常 content）、control 写/读、launchPet spawn 参数（fake spawn）、parity。
- `scripts/dsh-canary.mjs` + `dsh-canary-lib.mjs`：用 R2 的本地 mock LLM 协议（`/tmp/dsh-audit-run` 附录 A）跑**成功回合**（离线 mock，无外网/费用），断言 `events.jsonl` 出现带 `text` 的 assistant/message、`control.json` attached→detached；失败回合断言保持。
- README 同步：事件映射表、control 契约、配置项、HMR/激活说明。

---

## 7. 设置页（A4）

- DSH 联动 section 增加两个开关（`dshCoupling` / `dshBubbleSync`），沿用现有 checkbox + `set-config` 流程；文案：
  - “与 DeepSeek Harness 同生共死（双向保活）”
  - “头顶气泡同步 DSH 回复”
- 状态行：online/running 时显示“已连接（运行中/空闲）”，离线显示“未连接（安装桥插件后生效）”；不新增 IPC。
- 测试更新 `tests/settings-model.test.ts` 等（按现有模式）。

---

## 8. 窥屏互动接口预留（A7，只接口）

- 新文件（只新增，不动既有契约/配置/IPC/preload）：
  - `src/shared/peek.ts`：能力枚举 `PeekCapability = 'screen.peek.metadata' | 'screen.peek.ocr' | 'screen.peek.vision'`；`PeekPermissionState = 'granted'|'denied'|'not-determined'|'restricted'|'unsupported'|'unknown'`；`PeekObservationRequest/Result`、`PeekGateDecision`、`PeekStatus`、`PeekProvider` 接口、`PEEK_DEFAULT_STATUS`（全 unavailable/off）；`evaluatePeekGate(request, status, now)` 纯函数 fail-closed（关闭/未授权/能力缺失/敏感应用/节流未过 → deny，附 reason）。
  - `src/main/peek/service.ts` + `stub-provider.ts`：`createPeekService({providers: []})`；`getStatus()` 全关；`observe()` 永远 `{ok:false, reason:'not-implemented'}`；**零 fs/定时器/Electron 依赖**，未来由 Lead 接 IPC。
  - `tests/peek-gate.test.ts`、`tests/peek-service.test.ts`：默认关闭、fail-closed、无采集副作用（stub 不被调用/无 fs 写）、契约形状。
- 文档：本文件 §8 + `docs/peek-interface.md`（未来 P0–P3 接线清单，标注“未接线”）。
- 设置页本轮不显示（避免误解为可用）。

---

## 9. Wave 3 V9（A5/A6）与 V10（文档收口）

### 9.1 V9 打包（A5）

- Lead 先 `pnpm add -D electron-builder@26.18.0`。
- 新增 `electron-builder.yml`：`appId: com.aventurine.pet`、`productName: AventurinePet`、`directories.output: dist`、`files: [out/**, package.json]`、`mac: { target: dir, category: public.app-category.entertainment, identity: null, hardenedRuntime: false, entitlements: build/entitlements.mac.plist, minimumSystemVersion: '13.0' }`、`extraResources`：
  - `native/winlist/.build/winlist` → `native/winlist/winlist`
  - `assets/model/optimized` → `model`
  - `assets` 的 `icons/`（tracked）→ `assets/icons`；私有 `vrm/motions/expressions/props` → `assets/...`（存在才打包；不存在给 warning）
- 新增 `build/entitlements.mac.plist`（占位：allow-jit/unsigned-executable-memory/disable-library-validation 与 TCC 无关）。
- 新增 npm scripts：`package:dir`、`package:check`（构建后校验 bundle id/资源/helper）。**不改** `build` 语义。
- 打包后处理：`afterPack` 钩子 `build/after-pack-adhoc-sign.cjs` 对 `.app` 做 **ad-hoc 签名**
  （`codesign --force --deep --sign -`）。2026-11-11 实机发现完全无签名产物会被 macOS 27 AMFI
  拒绝（`no CMS blob? Unrecoverable CT signature issue` → 启动即退出）；ad-hoc 仅本机自用，
  对外分发仍需 Developer ID + 公证。
- 验收：`pnpm package:dir` 成功产出 `dist/mac*/AventurinePet.app`（ad-hoc 签名）并自动跑
  `package-check`；资源路径与 `protocol.ts`/`winlist.ts` packaged 分支一致；`pnpm smoke:file` 不回归。
- 文档：`docs/packaging.md` 更新现状（已实现/未实现/签名身份缺失）；`docs/known-issues.md` 更新 R-07。

### 9.2 V9 性能（A6）

- 新 `scripts/vrm/measure-runtime.mjs`（dev-only）：用隔离 `PET_PROFILE` + 临时 HOME 启动生产构建 `electron .`（`PET_SMOKE_TEST` 不行，需要真实渲染），通过 remote debugging 或主进程日志采样 FPS/RSS/CPU 60s（idle + 真实动作），输出 JSON + markdown 表。
- 新 `docs/wave3-perf-baseline-2026-11-11.md`：改动前后基线对比（改前先采一轮、集成分支再采一轮）；注明测量方法/环境/局限。
- 不与真实 DSH 交互，不装桥。

### 9.3 V10 收口（文档 worker / Lead）

- 新 `docs/wave3-acceptance.md`：V9/V10 + DSH 集成验收矩阵（自动化 + 实机证据 + 用户待勾选项）。
- 更新 `PLAN.md`（Wave 3 状态、DSH 集成决策）、`README.md`（状态/运行方式/激活步骤）、`docs/wave2-acceptance.md`（动作数量口径 29→30 / catalog 181）、`docs/known-issues.md`（R-07/R-18/R-21 现状）。
- `build-app-manifest --check` 保留手工复跑证据；是否进 prebuild 由 Lead 决定（默认 **不加** 进 CI，避免私有资产依赖）。

---

## 10. 最终激活（Lead，测试全绿后执行，用户已同意「装进 desktop profile、不重启」）

> **2026-11-11 12:33 已执行成功**：本节的执行方式已由 `scripts/activate-dsh-bridge.mjs` 自动化
> （自动生成 `work/live-bridge/<rev>` 新路径副本、备份、YAML 校验、幂等；激活后核对 `control.json.bridgeVersion`）。
> 实测记录见 [wave3-acceptance.md](wave3-acceptance.md) §2.3；HMR/live 副本依据见
> [wave3-hmr-activation-verification-2026-11-11.md](wave3-hmr-activation-verification-2026-11-11.md)。

1. 备份真实 `~/.dsh/profiles/desktop/cordis.patch.yml` → `cordis.patch.yml.bak-wave3-<timestamp>`（脚本自动完成）。
2. **前提（2026-11-11 实机修正）**：DSH 运行中 HMR 对**同一模块路径**的仓库源码可能复用 Node ESM
   缓存（详见 `docs/wave3-hmr-activation-verification-2026-11-11.md` 的实测结论）；若桥代码有更新，
   激活前需用新入口路径（或按 runbook 触发重载），并核对 `control.json` 的 `bridgeVersion`。
3. 向 `cordis.patch.yml` 追加 insert 行（**推荐直接运行脚本自动完成**）：
   ```bash
   # 自动：生成 work/live-bridge/rev-<ts>/ 新路径副本（规避 HMR 同路径 ESM 缓存）
   #      → 备份 patch → YAML 校验 → 追加 insert（launchPet/petAppPath/petBundleId 自动填）
   node scripts/activate-dsh-bridge.mjs --pet-app "<dist .app 绝对路径>" --dry-run
   node scripts/activate-dsh-bridge.mjs --pet-app "<dist .app 绝对路径>"
   ```
   手工等价形态（仅当该 Host 进程**从未** import 过该路径时可用——本机 09:49 首次激活已缓存旧模块，**不可再用原路径**）：
   ```yaml
   - id: aventurine-bridge
     name: /Volumes/4TB外置盘/deepseek-harness/aventurine-pet-vrm/work/live-bridge/rev-<ts>/lib/index.js
     config:
       dir: ~/.dsh/aventurine-pet
       launchPet: true
       petAppPath: <dist .app 绝对路径>
       petBundleId: com.aventurine.pet
   ```
4. HMR 自动 dispose/apply；观察 `~/.dsh/aventurine-pet/{status.json,control.json,events.jsonl}` 出现 attached/心跳
   （**核对 `control.json.bridgeVersion` = 脚本打印的副本 `BRIDGE_PLUGIN_VERSION`、`dshPid` = Host pid**）；
   桌宠 app 被 direct-exec 拉起（`ps` 中 ppid=Host）；`pet:dsh-status` 变 online。
5. 实机验证：本会话下一次 turn 结束时气泡/动作反应出现（无需重启 DSH）。
6. 回滚脚本/步骤写入 `docs/wave3-acceptance.md`：恢复备份 → HMR detach → 手动退出桌宠；桥目录保留为证据。
7. 若 HMR 不生效或异常：不回滚整个 profile，只删除本 insert 行 → 提示用户下次重启 DSH 即可恢复原状。

---

## 11. 文件所有权矩阵（并行 worker 互不重叠）

| 文件/目录 | Lead (T0/接线) | A1 bridge | A2 dialogue | A3 lifecycle | A4 settings | A5 packaging | A6 perf | A7 peek | V 验证 |
|---|---|---|---|---|---|---|---|---|---|
| `src/shared/**`（bridge-schema/types/config） | 🔒 | | | | | | | | |
| `src/preload/**`、`package.json`、`pnpm-lock.yaml` | 🔒 | | | | | | | | |
| `tests/bridge-schema*.test.ts`、`tests/config-*.test.ts`、`tests/shared-*.test.ts` | 🔒 | | | | | | | | |
| `bridge/**`、`tests/bridge-plugin.test.ts`、`scripts/dsh-canary*.mjs` | | ✅ | | | | | | | |
| `src/renderer/src/reactions/dsh-dialogue.ts`、`tests/dsh-dialogue.test.ts` | | | ✅ | | | | | | |
| `src/main/desktop/dsh-process.ts`、`src/main/desktop/dsh-watch.ts`、`src/main/ipc/dsh.ts`、`tests/dsh-process.test.ts`、`tests/dsh-ipc.test.ts`、`tests/dsh-watch.test.ts` | | | | ✅ | | | | | |
| `src/renderer/settings.html`、`src/renderer/src/settings/**`、`tests/settings-*.test.ts` | | | | | ✅ | | | | |
| `electron-builder.yml`、`build/**`、`scripts/package-*.mjs`、`docs/packaging.md` | | | | | | ✅ | | | |
| `scripts/vrm/measure-runtime.mjs`、`docs/wave3-perf-*.md` | | | | | | | ✅ | | |
| `src/shared/peek.ts`(新)、`src/main/peek/**`(新)、`tests/peek-*.test.ts`(新)、`docs/peek-interface.md`(新) | | | | | | | | ✅ | |
| `src/main/index.ts`、`src/main/ipc/index.ts`、`src/renderer/src/main.ts`、`src/renderer/src/core/**`、`tests/tmp/**` 证据 | 🔒 | | | | | | | | ✅（只写 tests/tmp） |
| `docs/wave3-acceptance.md`、PLAN/README/wave2-acceptance 更新 | 🔒/文档 worker | | | | | | | | |

**硬规则**：worker 不改 `src/shared/**`、`src/preload/**`、`package.json`、`src/main/index.ts`、`src/main/ipc/index.ts`、`src/renderer/src/main.ts`、`src/renderer/src/core/**`；需要契约/接线变更 → 消息给 Lead。worker **不执行 git commit/checkout/stash**；Lead 统一提交。worker 不碰真实 `~/.dsh`、不重启/拉起真实 DSH、不跑未隔离的 `pnpm dev/smoke`。

---

## 12. 任务与依赖

```
T0 Lead 契约（shared/types/config/bridge-schema + 契约测试）  ← 本文件即契约依据
 ├─ A1 bridge（text/control/launchPet/canary/README/tests）      → 依赖 T0 字段名
 ├─ A2 dsh-dialogue（纯逻辑+tests）                              → 依赖 T0 DshEvent 形状
 ├─ A3 lifecycle（dsh-process/dsh-watch/ipc-dsh/tests）          → 依赖 T0 config 字段
 ├─ A4 settings（两开关+状态行+tests）                            → 依赖 T0 config 字段
 ├─ A5 packaging（V9）                                            → 无（Lead 先装 electron-builder）
 ├─ A6 perf baseline（V9）                                        → 无
 └─ A7 peek（接口）                                               → 无
T1 Lead 接线（renderer main.ts 气泡仲裁；main/ipc/dsh 若需）      → 依赖 A2/A3
Test 全量 vitest + typecheck + dsh canary + smoke                  → 依赖全部
V 验证（隔离 DSH_HOME/profile + 临时 HOME/PET_PROFILE + mock LLM） → 依赖 T1
Activation 真实 desktop profile（HMR，备份/回滚）                  → 依赖 V 通过
Docs V10 收口（wave3-acceptance/PLAN/README/known-issues）        → 依赖 Test/Activation
```

---

## 13. 验证计划（V，隔离环境）

1. **单测/静态**：`pnpm typecheck`、`pnpm test`（全量）、`pnpm dsh:canary`（含成功 mock 回合）。
2. **桥隔离 E2E**：临时 `DSH_HOME=/tmp/w3-dsh-home` + profile `pet-e2e`；跑 `dsh --profile pet-e2e`（headless）+ mock LLM 一个成功回合 → 断言 `events.jsonl` 有 text、control attached→detached；再失败回合断言 task/error。
3. **桌宠隔离 E2E**：`HOME=/tmp/w3-home`、`PET_PROFILE=w3-e2e`、`PET_DSH_DIR=<临时桥目录>`、`PET_DSH_COUPLING=1`（仅打包版？dev 需 env）→ 用远程调试截屏验证：思考中气泡 → commit 后文本气泡 → 一段后消失 → 下一段；`dshDone` 动作；失败回合 `dshError`。
4. **强耦合 E2E（fake DSH，不碰真实）**：`PET_DSH_TEST_HOOKS=1` + fake 进程（脚本名含 pattern）+ fake 启动命令；验证 pet 启动拉起 fake、无 detached 的 fake 死亡→重启≤2 次→仍失败跟随退出、detached+进程消失→直接跟随退出（不重启）、detached+进程仍在→保持等待、grace 内 attached 取消、pet 退出杀 fake。
5. **打包版**：`pnpm package:dir` → 隔离 HOME 启动 `.app`（或 `electron dist/...`）验证资源/helper/透明窗口；不要求签名。
6. **不回归**：`pnpm smoke`（vrm + legacy 双后端）在隔离 profile 下跑。
7. 证据写 `tests/tmp/wave3/**`（gitignore）+ `docs/wave3-acceptance.md` 汇总。

---

## 14. 风险与缓解

| 风险 | 缓解 |
|---|---|
| 写 assistant 正文到桥文件（同用户可读） | 用户明确要气泡同步；只写 assistant 输出、不写 user/reasoning/tool 正文；截断 8000 字；桥目录 0700/文件 0600；文档说明 |
| HMR 激活影响运行中 DSH | 仅追加一个 host-only insert 行；先在临时 profile 全流程验证；备份+单行回滚；不重启 |
| 强耦合误杀 DSH | 用户明确选择；dev 需显式 env；dispose/attached grace 防 HMR 误判；SIGTERM 优雅退出；全链路日志 |
| 互相拉起死循环 | 单实例锁 + 60s 冷却 + 次数上限 + 显式退出墓碑 + `quitReason` 防环 |
| 多 session 气泡串台 | 去重 key 含 sessionId+turn+step+seq；新 task/start 清队列 |
| 长文本气泡撑爆布局 | 切块 96 字 + 单 turn 4000 字预算 + bubble maxWidth 340 + CSS 自动换行 |
| 打包无签名/无资产 | `--dir` 本机自用；资产缺失时构建脚本警告/失败指引；不声称可分发 |
| DSH 升级事件形状变化 | `engines.dsh` 护栏 + `pnpm dsh:canary`（含文本断言）+ known-issues 记录 |

---

## 15. 待办勾选（Lead 维护）

- [ ] T0 契约落地 + 契约测试
- [ ] A1 bridge v2 + canary
- [ ] A2 dialogue 纯逻辑
- [ ] A3 lifecycle
- [ ] A4 settings
- [ ] A5 packaging（V9）
- [ ] A6 perf（V9）
- [ ] A7 peek 接口
- [ ] T1 Lead 接线
- [ ] 全量测试 + 隔离 E2E + fake 耦合 E2E
- [ ] 真实 desktop profile HMR 激活 + 实机验证
- [ ] V10 文档收口 + 提交
