# Wave 3 项目现状审计（R1）—— DSH 联动 / 气泡 / 生命周期 / V9 / V10 / 测试基建 / 窥屏接口现状

> 日期：2026-11-11（02:0x +08:00） · 任务：`task-1` R1 · 执行者：research-project（只读调研 agent）
> 工作区：`/Volumes/4TB外置盘/deepseek-harness/aventurine-pet-vrm` · 基线：`main @ 3893943`
> 读取时工作树：仅一个前序未跟踪文档 `docs/research/screen-awareness-privacy-focus-feasibility-2026-11-11.md`（未修改）；
> 另发现仓库根出现一个未跟踪 `mock.pid`（02:03 出现，来源未知；非本任务显式写入，本任务未触碰；提交前需 Lead 清理）。
> 性质：**只读调研**。未改任何 `src/**`、`bridge/**`、`scripts/**`、`tests/**`、`package.json`、配置文件；未写/改真实 `~/.dsh`（软链到 `/Volumes/4TB外置盘/dsh-appdata`）；未安装插件到 profile；未重启/杀死 DSH 或 Electron；未 `open -a`；未跑 `pnpm dev` / `pnpm smoke`。
> 唯一写入：本文件 `docs/research/wave3-project-audit-2026-11-11.md`。
> 证据约定：`路径:行号` 均指本仓库基线 `3893943`；环境事实（非仓库文件）标 `[环境实测]`，无法用行号时给路径/命令与输出要点。
> 并行任务：R2（task-2，DSH 源码/事件/生命周期）、R3（task-3，外部同类）、R4（task-4，窥屏接口）——本报告与 R2 在「事件形状」上有少量独立交叉验证，结论以 R2 源码级审计为准；本报告负责项目侧现状与落地 scope。

---

## 0. 一页结论（TL;DR）

1. **DSH 联动的代码链路是完整且全绿的，但当前"没有输入"**：`bridge 插件未安装进正在运行的 desktop profile`，桥目录文件最后写入停在 **2026-11-07 21:16/21:17**（[环境实测] `status.json` ts=1794057469070 → `2026-11-07T13:17:49Z` = 21:17:49 +08），远超 30s 在线 TTL → `online=false` → 主进程按契约不转发任何事件（`src/main/ipc/dsh.ts:42-46`）。用户真实配置 `~/Library/Application Support/aventurine-pet/config.json` 里 `dshLink=true`，所以**busy/done/error 看不到不是配置或映射 bug，而是桥插件不在场**。DSH 链路单测（`tests/dsh-*.test.ts`、`tests/bridge-*.test.ts`）全部通过。

2. **「DSH 回复文本」「思考中」在现有桥契约里不存在，需要加法式契约扩展**：桥插件**故意丢弃** `assistant/message` 正文（`bridge/dsh-aventurine-bridge/lib/index.js:16-24`、`:565-591`，并用测试锁死：`tests/bridge-plugin.test.ts:829`「不含消息正文」）。真实 DSH 0.2.2-rc.1 的 durable 事件里，最终回复文本在 `session/event.assistant/message.data.message.content[type='text'].text`（本报告只读抽样 12/12 个 turn 各有一条「无 tool-call 的 text message」作为最终回复，长度 440–3437 字符；详见 §2.7）。落地需要：`src/shared/bridge-schema.ts` 白名单加文本字段、桥写入侧在「最终文本」条件下写入（截断）、两侧 parity/sanitize 测试同步——属于**冻结契约变更，必须 Lead 评审**。

3. **气泡机制目前是"单槽 + 一次性"，不支持「思考中→回复→停留→消失→下一段」**：`BubbleView` 只有一个 DOM 气泡（`core/bubble.ts:126`）、行为层每帧只有一个 `pendingBubble` 槽（`behavior/behavior-director.ts:757`）、`ExternalReaction` 每条反应只带一个 `bubble`（`core/wave2-contract.ts:177-187`），且 DSH 反应是 mood 驱动的一次性 5s/2.5s/12s（`reactions/dsh.ts:44-48`）。需要**新增独立的 DSH 对话状态机/队列**（推荐放 `src/renderer/src/reactions/`，纯逻辑可测），由 Lead 在 `src/renderer/src/main.ts` 做气泡仲裁接线；**不建议改 `BubbleView`/`wave2-contract` 的既有语义**。

4. **生命周期：pet 侧完全没有 DSH 进程/窗口感知**（`src/main/**` 无任何 `pgrep`/`open -a`/进程探测调用；grep 结果为空），只有「桥文件心跳」这一间接信号；`launchAtLogin` 只写 pet 自己的登录项（`src/main/login-item.ts:30-46`）。**互保活必须单独立项**（检测 / 拉起 / 防重启风暴 / 退出语义），且「DSH→拉起 pet」在 dev 下不可行、必须等 V9 打包版；桥插件 `apply/dispose`（`lib/index.js:350-671`）是 DSH 启动/退出钩子的天然位置，但**把桥装进 desktop profile 需要重启用户正在使用的 DSH，属于用户红线，实施前必须用户明确同意**。

5. **Wave 3 / V9 未开始**：无 `electron-builder.yml`、无签名/公证/entitlements、无 app 图标打包（`docs/packaging.md:8-16`；`docs/known-issues.md:8-13` R-07）；本机 `0 valid identities found`（`docs/packaging.md:11-12`，环境阻塞）。可立即做的：打包配置 + `extraResources` 映射 + helper universal 校验（已实测 universal/minos=13.0 通过）+ FPS/内存测量脚本 + 占位 channel 决策 + legacy 去留文档。**签名/公证与"打包版含私有资产"需用户拍板**。

6. **Wave 3 / V10 的数据接线事实上已经完成**：运行时读的是**私有生成清单** `assets/motions/app-manifest.json`（40 clips）与 `app-catalog.json`（181 clips），源集 = mate 30 / hsr 14 / adv 137；本任务实测 `node scripts/vrm/motion/build-app-manifest.mjs --check` → **PASS**。`src/shared/motion-manifest.json` 仍为空 `{schemaVersion:1,clips:[]}` 是 W0-3 冻结契约的**占位（私有资产不进 git）**，不是缺陷（`tests/animation-contract.test.ts:98-105`）。V10 剩余 = 用户实机最终验收 + 文档口径（Wave 1.5 报告写 29 条，实际 mate 已 30 条：新增 `dragFemale`，见 `scripts/unity-bake/clips.json:19`）+ 可选把 `--check` 纳入 prebuild。

7. **窥屏互动接口**：现有仓库**零采集能力**（无录屏权限查询、无截图/OCR helper、无对应通道/config）；可行性文档提出的新增面（capability 模型、IPC 通道、config 组、`native/screengrab`、packaging/TCC）全部缺失，但可复用钩子已具备：winlist 250ms 窗口元数据（`src/main/ipc/desktop.ts:40`）、`ExternalReaction`/`BehaviorInput` 注入路径、`config-store` 可选键回填（`src/main/config-store.ts:205-226`）、TCC 红线文档（`docs/packaging.md:86-101`）。只留接口时注意冻结契约测试锁了 14 个 invoke + 4 个事件（`tests/shared-contract.test.ts:38-110`）。

---

## 1. 基线与环境事实

### 1.1 仓库与测试基线（本次实测）

| 项 | 结果 | 证据 |
|---|---|---|
| HEAD | `3893943 fix(vrm): 抬脚释放阈值 + hipShift 命中区补偿（已知限制 R1/L2）` | `git log --oneline -1` |
| 工作树 | 仅 `?? docs/research/screen-awareness-...md`；另有 `?? mock.pid`（非本任务产物） | `git status --short` |
| 全量单测 | **123 files / 2149 passed + 11 skipped（2160 cases），3.86s** | 本任务实测 `pnpm test`（与 Lead 基线 `/tmp/baseline-test-1794333276.log` 一致） |
| typecheck | `tsc node + web` 0 error | 本任务实测 `pnpm typecheck` |
| 动作清单一致性 | `build-app-manifest --check` **PASS**（app-manifest 40 clips / catalog 181） | 本任务实测 `node scripts/vrm/motion/build-app-manifest.mjs --check` |
| native helper | universal `x86_64+arm64`、每 slice minos=13.0、`--json` 运行 OK（12 windows/40ms） | 本任务实测 `node scripts/build-native.mjs --check` |

### 1.2 运行中的 DSH / 桌宠环境 [环境实测]

| 项 | 值 | 证据 |
|---|---|---|
| DSH 桌面版 | **0.2.2-rc.1**（`com.deepseek.dsh`） | `defaults read "/Applications/DeepSeek Harness.app/Contents/Info.plist" CFBundleShortVersionString` |
| 正在运行的 profile | **desktop** | `ps ax`：`DeepSeek Harness --expose-internals .../dsh-desktop-host/lib/index.js .../app.asar/dsh ~/.dsh/profiles/desktop ...` |
| DSH_HOME | `~/.dsh` → 软链 `/Volumes/4TB外置盘/dsh-appdata` | `ls -la ~/.dsh` |
| 桌宠进程 | 审计时**未运行**（`ps ax \| grep -i aventurine` 无结果） | — |
| desktop profile 的 bundle 列表（15 项） | base / web-app / agent-team / voice-input / auto-review / inspector / tool-worktree / session-search / session-titles / ralph / plugin-market / terminal / subagent-codex / forge / personalized-recommendations —— **无 `dsh-aventurine-bridge`** | [环境实测] `/Volumes/4TB外置盘/dsh-appdata/profiles/desktop/package.json:6-22` |
| profile 依赖 | `dependencies` 仅有 `@deepseek-ai/dsh-subagent-codex`；`node_modules` 无 `dsh-aventurine-bridge`；`cordis.patch.yml`/`cordis.yml` grep `aventurine` = 0 命中 | 同上 + 目录 grep |
| 桥目录 | `/Volumes/4TB外置盘/dsh-appdata/aventurine-pet/`（= `~/.dsh/aventurine-pet/`）；`status.json` 96B mtime **Nov 7 21:17:49**、`events.jsonl` 396B mtime **Nov 7 21:16:08**；status 内容 `{"ts":1794057469070,"running":false,"agents":0,"lastEventAt":0,"lastType":null,"offline":false}` | [环境实测] `stat`/`cat`（只读） |
| 用户桌宠配置 | `~/Library/Application Support/aventurine-pet/config.json`：`dshLink: true`、`autonomous: true`；另有 e2e/验收 profile 若干（部分 `dshLink:false`，属测试隔离目录，不影响主配置） | [环境实测] `cat`（只读） |

**结论**：运行中的 DSH 是 desktop profile，它**没有装桥插件**；桥目录里是 11-07 的陈旧文件（可能是早期独立 profile/手工实验留下的）。因此 pet 读到的永远是 `online=false`，`dsh-event` 一条都不会广播。

### 1.3 本任务实际执行的操作（可复核）

只读/只跑安全命令：`git status/log`、`read/grep/wc/find`、`cat/stat`（桥目录、profile、用户配置、会话日志只读解压）、`ps ax`、`defaults read`、`pnpm test`、`pnpm typecheck`、`node scripts/build-native.mjs --check`、`node scripts/vrm/motion/build-app-manifest.mjs --check`。**没有**执行 `pnpm dev`/`pnpm smoke`/`dsh:canary`（canary 会装临时 profile，虽隔离但属"安装插件"动作，交实现阶段做）、没有写任何 `~/.dsh` 或 `/Applications` 内容。

---

## 2. DSH 联动全链路审计

### 2.1 总览（数据流）

```
DSH 进程（desktop profile）
  └─ [桥插件 dsh-aventurine-bridge]  (host-only cordis bundle；当前未安装)
       ├─ status.json   每 5s 覆盖写（原子 rename），退出写 offline:true
       └─ events.jsonl  追加 NDJSON（5MB 轮转、单行 ≤64KB、0600）
                 │ 文件系统（~/.dsh/aventurine-pet/）
                 ▼
pet main（src/main/desktop/dsh-watch.ts）  750ms 轮询
  ├─ status.json → toDshStatus(now)  → online（30s TTL / offline 标记 / 未来 ts 不算在线）
  └─ events.jsonl 增量尾随（EOF 基线、半行拼接、inode 轮转、截断回零）
       └─ src/main/ipc/dsh.ts：仅 status.online 时 ctx.broadcast('dsh-event', event)
                 │ IPC（preload 白名单；PetApi.onDshEvent）
                 ▼
pet renderer（src/renderer/src/main.ts）
  └─ api.onDshEvent → PetRuntime.pushDshEvent（dshLink 开时）→ DshReactionTracker
       └─ 每帧 reactionAt(now) → BehaviorInput.external → BehaviorDirector 的 ExternalReaction 分支
            → BehaviorDecision.mood = dshBusy/dshDone/dshError + 一次性 bubble
```

### 2.2 文件契约层（`src/shared/bridge-schema.ts`）

| 契约 | 内容 | 证据 |
|---|---|---|
| 目录/文件名 | `~/.dsh/aventurine-pet`、`status.json`、`events.jsonl`；读侧可用 `PET_DSH_DIR` 覆盖 | `bridge-schema.ts:24-33`；`dsh-watch.ts:48-51,134-140` |
| 心跳/TTL | 插件 5s 心跳；在线 = `!offline && now>=ts && now-ts<30000`；未来 ts 不算在线 | `bridge-schema.ts:35-36,263-292` |
| 事件类型白名单（5 个） | `agent/status` / `task/start` / `task/end` / `task/error` / `session/event` | `bridge-schema.ts:44-51`；`types.ts:137-143` |
| 事件结构 | `{ts:number, type:白名单, payload:对象}`；解析对脏输入返回 null 不抛、超长行丢弃 | `bridge-schema.ts:83-90,222-249` |
| payload 零信任清洗（R-24） | 已知 10 键严格校验/截断；未知键只透传 JSON 标量、结构化值丢弃；`message ≤512` 字符、其余 ≤256 | `bridge-schema.ts:92-128,143-198` |
| status.json 结构 | `{ts,running,agents,lastEventAt,lastType,offline?}`；offline 显式离线 | `bridge-schema.ts:53-66,251-292` |

**关键点**：当前 payload 白名单里**没有**任何承载消息正文的字段（`DSH_EVENT_PAYLOAD_KEYS` 10 键：`agent/status/reason/reasonKind/turn/step/message/sessionId/eventType/seq`，`bridge-schema.ts:105-116`）；`message` 仅用于 `task/error` 的错误摘要（≤512 字符）。

### 2.3 桥插件（写入侧）

| 能力 | 实现 | 证据 |
|---|---|---|
| 包形态 | host-only bundle：`type:module`、`main:lib/index.js`、`dsh.bundle.patch:./cordis.patch.yml`、`engines.dsh: ">=0.2.2-rc.1 <0.3.0"` | `bridge/.../package.json:8-10,25-29`；`cordis.patch.yml:4-14` |
| 常量 | 与 `src/shared/bridge-schema.ts` 同源副本（目录/文件名/心跳/TTL/轮转/64KB 行上限/5 类事件） | `lib/constants.js:15-54`；parity 测试 `tests/bridge-plugin.test.ts:384-412` |
| 事件映射 | `agent/status` running↔idle → `task/start`/`task/end`；`agent/error` → `task/error`；`turn/end(reason.kind=error)` → `task/error`（同 turn 去重）；`assistant/message`/`tool/result`/正常 `turn/end` → `session/event`（**只带安全标量，不含正文**）；高频事件忽略 | `lib/index.js:11-27,91-95,474-501,516-539,565-630` |
| 生命周期 | `apply` 箭头函数；启动写一帧 status；5s 心跳；disposer 清定时器/退订/写 `offline:true` 帧 | `lib/index.js:350-672`；README:28-42 |
| 隐私/上限 | 单行 ≤64KB（超长丢弃）、5MB 轮转、目录 0700/文件 0600、任何 fs 错误只 warn 不抛；`assistant/message` 正文被显式排除（F5） | `lib/index.js:86,293-327,416-440`；`tests/bridge-plugin.test.ts:829-927` |
| 已知限制 | 插件晚于 agent 启动时无法 hydrate 正在运行的 agent（`agent/status` 只在变化时 emit） | `bridge/.../README.md:281-298` |

**这是"当前没有 busy/done/error"之外的第二层事实**：即使桥装上了，`assistant/message` 也不会带出回复文本——现有设计是隐私优先的「事件形状只透传」，要显示回复必须改桥。

### 2.4 主进程尾随器与 IPC

| 环节 | 行为 | 证据 |
|---|---|---|
| 目录解析 | `options.dir` > `PET_DSH_DIR` > `~/.dsh/aventurine-pet` | `dsh-watch.ts:48-51,130-140` |
| 轮询 | 默认 **750ms**；status 读 status.json 折算，变化才回调；events 按字节偏移增量读（单次 ≤256KB，单行 ≤64KB，启动 EOF 基线不回放历史） | `dsh-watch.ts:47-64,279-293,331-340,398-450` |
| 异常隔离 | 缺失/坏 JSON/权限错误只首次 warn、绝不抛；回调逐个 try/catch；`stop()` 幂等 | `dsh-watch.ts:209-257,296-328,487-505` |
| IPC | 只注册 `pet:dsh-status`（返回 `DshStatus`）；仅 `status.online===true` 才广播 `dsh-event`；`will-quit` stop | `src/main/ipc/dsh.ts:37-51` |
| 接线 | `registerIpcHandlers` 统一调用：window/config/desktop/settings/**dsh** | `src/main/ipc/index.ts:30-36` |
| 契约 | `IPC.dshStatus='pet:dsh-status'`；`IPC_EVENTS.dshEvent='dsh-event'`；`PetApi.onDshEvent` | `shared/ipc.ts:39,52-53,90,100,128,137` |

### 2.5 渲染层反应与行为契约

| 环节 | 行为 | 证据 |
|---|---|---|
| 订阅 | `api.onDshEvent(event => runtime?.pushDshEvent(event, performance.now()))` | `src/renderer/src/main.ts:1395-1402` |
| 开关 | `pushDshEvent` 只在 `dshLink` 开启时进 tracker | `core/pet-runtime.ts:652-656`；`BehaviorConfigSubset.dshLink` `core/wave2-contract.ts:194-199` |
| 状态轮询 | `pet:dsh-status` 每 **5s**；`runtime.updateDshStatus`（离线清残留） | `main.ts:614-626,671-677` |
| 映射 | `task/start`/`agent/status running` → `dshBusy`(5s)；`task/end`/idle → `dshDone`(2.5s)；`task/error` → `dshError`(12s)；`session/event` 无反应；同 agent/turn 去重；error→end 2s 抑制 | `reactions/dsh.ts:8-27,44-48,119-293` |
| 台词 | 三种 mood 各取**官方语音原文池**（BUSY/SUCCESS/DEFEAT），顺序循环、一次一句 | `reactions/dsh.ts:50-61`；`core/voicelines.ts:192-237` |
| 注入 | 每帧 `external = dshEnabled ? tracker.reactionAt(now) : null` → `BehaviorInput.external` | `core/pet-runtime.ts:791-792,810-821` |
| 优先级 | drag > pat/poke > fall > **DSH external** > 自主活动 > idle | `behavior/behavior-director.ts:780-793` |
| 行为层消费 | `buildExternalDecision`：每条外部反应实例**只发一次 bubble**（`lastExternalBubbleKey`），随后 `dshLink` 兜底 | `behavior-director.ts:1307-1330,1069-1105` |
| 契约 | `ExternalReaction { mood: dshBusy \| dshDone \| dshError; bubble: string \| null; durationMs; startedAtMs }` | `core/wave2-contract.ts:177-187` |

### 2.6 为什么当前会话里实际看不到 busy/done/error（证据链 + 排除法）

| 可能假设 | 结论 | 证据 |
|---|---|---|
| `dshLink` 配置被关 | ❌ 用户主配置是 `true` | [环境实测] `~/Library/Application Support/aventurine-pet/config.json`；默认值也是 true `shared/config.ts:36-43` |
| 渲染层/行为层没实现 | ❌ 链路完整、单测全绿 | `tests/dsh-reactions.test.ts`（事件→反应→去重→台词）、`tests/dsh-ipc.test.ts`（广播/离线不转发/will-quit）、`tests/dsh-watch.test.ts`（尾随/轮转/基线/TTL） |
| 桥插件未安装进 desktop profile | ✅ **主因** | profile `package.json:6-22` 15 个 bundle 无桥；`node_modules` 无包；`cordis.*` 无 `aventurine` 引用 |
| 桥目录陈旧/离线 | ✅ 放大因素 | `status.json` mtime/ts = 2026-11-07 21:17:49，`running:false`、`lastEventAt:0`；30s TTL 早过 → `online=false`；`events.jsonl` 停在 11-07 21:16（只含一条旧 session 的 3 行） |
| 主进程被判离线后丢弃事件 | ✅ 契约如此 | `src/main/ipc/dsh.ts:42-46` |
| pet 未运行 | 审计时未运行（不影响结论；运行中的 pet 也只会显示离线） | `ps ax` grep |

**复现路径**（实现阶段验收用，不在本轮执行）：`pnpm dsh:canary` 先验桥契约（隔离 `DSH_HOME`）→ 用户同意后在 desktop profile：`dsh plugin --profile desktop add -w <repo>/bridge/dsh-aventurine-bridge` → 重启 DSH → pet 设置页「DSH 状态」应显示「在线 · 空闲/任务运行中」（`settings-model.ts:273-284`）。

### 2.7 取「DSH 回复文本 / 思考状态」的可行性与契约缺口（实测 + 结论）

#### 2.7.1 真实 durable 事件结构抽样 [环境实测，只读，不落盘]

方法：读取 2026-11-11 的一条真实会话落盘文件（`/Volumes/4TB外置盘/dsh-appdata/sessions/--Volumes-4TB~5916~7F6E~76D8-deepseek-harness-aventurine-pet-vrm--/session-b30d3784-.../session.v4.jsonl.zstd`），用 Node `zlib.zstdDecompressSync` 按 zstd frame 逐帧解压到内存，**只统计结构与长度，不记录正文**。该文件为「多帧拼接 zstd」（2482 frames），单帧解压会截断（供 R2 参考）。

样本规模：4282 条 durable 事件，其中 `turn/start` 12、`step/start` 403、`assistant/message` 403、`step/end` 403、`tool/call` 505、`tool/result` 518、`turn/end` 12。

| durable 事件 | data 结构（实测） | 对本题的用途 |
|---|---|---|
| `turn/start` | `{ turn }` | **「思考中」起点**（一个用户回合开始） |
| `step/start` / `step/end` | `{ turn, step }` | 步进粒度（可做「思考中/执行中」区分） |
| `assistant/message` | `{ turn, step, message: { id, role, source, content: Part[] }, usage, stream }`；`Part` = `{type:'text', text}` / `{type:'reasoning', text}` / `{type:'tool-call', id, name, arguments}` | **最终回复文本**来源 |
| `tool/call` / `tool/result` | 工具调用/结果（含正文） | 默认不发给气泡（隐私+无关） |
| `turn/end` | `{ turn, reason: { kind } }`；样本 12/12 = `completed`（失败/中止形状由 canary/失败会话 fixture 覆盖：`reason.kind='error'` 见 `tests/bridge-plugin.test.ts:950-1000`） | 回合结束信号（现有 `task/end` 已覆盖） |
| `user/message` / `system/message` | `{ content/id/role/source }` / `{ turn, step, message }` | 不需要（不显示用户输入） |

**文本分布结论（样本）**：
- 403 条 `assistant/message` 中 **28 条含 text part**；其中 **375 条只有 reasoning（无 text）**——大量 step 是纯思考/工具调用，不会产生回复文本。
- 28 条含 text 的消息里：**12 条同时含 tool-call**（中间旁白，36–253 字符）、**12 条不含 tool-call**（每个 turn 恰好 1 条）= **最终回复**；每个 turn 的最终回复都出现在该 turn 的最后一步。
- 最终回复长度：**440 / 544 / 929 / 1033 / 1525 / 1551 / 2066 / 2427 / 2444 / 3018 / 3145 / 3437 字符**（12 条）。→ 气泡必须做「分段/截断」，不能整段塞入。
- 判定规则候选：`assistant/message` 的 `message.content` **含 text 且不含 tool-call** → 视为最终回复；含 tool-call 的 text → 中间旁白（默认不显示，可配置）。**该规则对「同一步里先说一句再调工具」的形态也安全**（此时有 tool-call，归旁白）。

**边界/未知**：失败或中止回合可能没有最终 text（`turn/end.reason.kind=error/aborted`），此时不应清空上一段仍在停留中的气泡（或按配置显示错误表情 + 原有 error 台词）；`assistant/message` 是否每步必有、流式 delta 是否 durable——**以 R2 源码级审计为准**（样本中未见 `assistant/delta` durable 事件，桥也把它们当高频事件忽略，`lib/index.js:91-92`）。

#### 2.7.2 契约缺口清单（要显示回复文本必须改的）

| # | 缺口 | 现状 | 需要改动（加法式，Lead 评审） |
|---|---|---|---|
| G1 | 桥写入侧不带正文 | `buildSessionPayload` 只取安全标量（`lib/index.js:565-591`）；F5 测试锁死 | `lib/index.js`：对「最终 text」的 `assistant/message` 追加 payload 字段（如 `text`，截断到契约上限，如 4096 字符）；更新 `tests/bridge-plugin.test.ts:829-927`（改为「只带最终文本、不带 tool/reasoning/stream/usage」） |
| G2 | 读侧白名单无文本字段 | `DSH_EVENT_PAYLOAD_KEYS` 10 键（`bridge-schema.ts:105-116`）；未知标量虽可透传，但结构化截断逻辑不覆盖 | `bridge-schema.ts`：白名单加 `text`（专用最大长度，如 `DSH_EVENT_TEXT_MAX_CHARS=4096`），`sanitizeDshEventPayload` 对该键截断；同步 `tests/bridge-schema-sanitize.test.ts`（现在断言 10 键，`tests/bridge-schema-sanitize.test.ts:21-36`） |
| G3 | 「思考中」无显式信号（可用现有） | `task/start` 已存在（agent/status running），但语义是「agent 忙碌」而非「本 turn 开始」 | **无需新增事件类型**：用 `task/start` 进入 thinking，`turn/end`→`task/end` 结束；若要区分思考/工具执行，可在桥对 `step/start` 增加轻量事件（可选，需新事件类型/白名单，成本更高，建议本轮不做） |
| G4 | 多 turn 串扰/去重 | `session/event` payload 已有 `turn/step/seq/sessionId` | renderer 侧状态机用 `turn/seq` 去重与丢弃乱序；不需要桥改 |
| G5 | 隐私与落盘 | 桥文件是磁盘文件（`~/.dsh/aventurine-pet/events.jsonl`，0600、5MB 轮转） | 需 Lead+用户确认「回复正文写入桥文件」；缓解事实：DSH 自身已把完整会话正文持久化在 `~/.dsh/sessions/**`（本报告实测），故增量暴露面有限；仍应在文档/README 明示，并提供 `dshReplyText` 开关 |

> 注：G1/G2 是**冻结契约变更**，按项目规则需 Lead 统一改 `src/shared/**` 并同步 bridge 副本（`bridge/.../lib/constants.js` 的 parity 测试会强制一致）。

### 2.8 三种"回复文本通道"方案对比（供 Lead 决策）

| 方案 | 做法 | 优点 | 缺点/风险 | 建议 |
|---|---|---|---|---|
| **A. 文件桥扩展（推荐）** | 桥把最终文本写进 `events.jsonl` 的 `session/event` payload；pet 现有 tailer 直接消费 | 改动最小、复用已验收的轮询/在线判定/轮转/权限；canary 可覆盖 | 正文落盘（与 DSH 会话日志同权限边界）；64KB 行上限需截断；轮转后历史被覆盖 | ✅ 本轮首选 |
| B. 本地 socket/HTTP 推送 | pet 主进程起 127.0.0.1 临时端口 + token 文件；桥 POST 文本 | 不落盘、实时性更好、将来可做双向（窥屏） | 新增网络面/鉴权/端口生命周期/多实例冲突；桥需在 host Node 侧发请求（可行性待 R2 确认）；测试面大 | ⏸ 留 Wave 4 / 与窥屏接口一起设计 |
| C. 读 DSH 会话日志兜底 | pet 直接 tail `~/.dsh/sessions/**/session.v4.jsonl.zstd` | 不需要插件 | 格式非契约（多帧 zstd、版本化文件名）；延迟/断帧/轮转不可控；隐私（读到全部会话）；等于绕过桥契约 | ❌ 不建议作为主路径（可作 R2 的"无插件可观测性"参考） |

---

## 3. 气泡机制审计

### 3.1 `BubbleView` API（`src/renderer/src/core/bubble.ts`，Lead-owned）

| API/常量 | 语义 | 证据 |
|---|---|---|
| `BUBBLE_DEFAULT_LIFETIME_MS = 4200` | `show` 默认停留时长 | `bubble.ts:21-22` |
| `BUBBLE_FADE_OUT_MS = 200` / CSS 过渡 160ms | hide 先淡出 200ms 再 `visibility:hidden` | `bubble.ts:24-25`；`:245-258` |
| `BUBBLE_MAX_WIDTH_PX = 340` | 最大宽度（约 25–28 字/行），**无高度上限** | `bubble.ts:30-31`；`:146-161` |
| `show(text, nowMs, lifetimeMs=4200)` | trim；空串→hide；文本变化才写 `textContent`；可刷新计时；自挂过期定时器（不依赖渲染帧）；文本变化时下一帧 rAF 重测尺寸 | `bubble.ts:174-212` |
| `update(nowMs)` | 每帧兜底过期（定时器节流时） | `bubble.ts:214-221` |
| `place(petRect, viewport)` | 宠物矩形/视口不变时不重算不写 style；跟随宠物 | `bubble.ts:223-243` |
| `hide()` / `visible` / `text` / `rect()` / `destroy()` | 显隐/文本查询/几何/销毁 | `bubble.ts:164-172,245-279` |
| 定位 `computeBubblePosition` | 头顶上方 → 侧方 → 下方 → 兜底贴顶（避免盖住宠物头；本轮前已修） | `bubble.ts:53-108` |
| 安全 | `textContent` 不用 innerHTML；`pointer-events:none`；`role=status/aria-live` | `bubble.ts:10-17,150-160` |

**已足够**：单段文本的显示/隐藏/跟随/淡出都可靠，且被测试覆盖（`tests/fix-f2b-bubble.test.ts`：淡出、独立过期、不每帧 reflow、几何）。**不够**：队列、分段、优先级、打字机、长文本高度限制、按文本长度自适应时长。

### 3.2 每帧调用链（renderer `main.ts`）

| 步骤 | 证据 |
|---|---|
| `frame(nowMs)`：仅当 `scene && shouldRenderPet() && 无连续错误` 时推进 runtime | `main.ts:1283-1342` |
| `runtime.frame({ nowMs, dt, interaction, events, bubbleText })` | `main.ts:1306-1313` |
| `applyRuntimeOutput(output, nowMs)`：`bubble.place(pointerRect, viewport)` → `if (output.decision.bubble) bubble.show(...)` → `bubble.update(nowMs)` → `bubbleText = bubble.text` → 写入动画输入（口型） | `main.ts:912-944`（气泡段 `:933-944`） |
| 口型链路 | `AnimationInput.bubbleText`（`wave2-contract.ts:264-286`）→ VRM expression 层驱动 aa/ih/ou…（README Wave2 §4） |
| 生命周期：`beforeunload → shutdown()` 清 rAF/定时器/订阅、`bubbleView.destroy()` | `main.ts:1423-1476` |
| 创建：`boot()` 中 `bubbleView = new BubbleView({ container: appRoot })` | `main.ts:1486-1488` |

### 3.3 现有气泡来源与优先级

| 优先级 | 来源 | 机制 | 证据 |
|---|---|---|---|
| 1（最高） | 拖拽 | `buildDragDecision` → `tryEmitBubble('drag')`（每次拖拽一次） | `behavior-director.ts:1252-1265,2450-2453` |
| 2 | 摸头/戳 | `reaction.bubbleEmitted` 一次性 → `tryEmitBubble('pat'/'poke')` | `:1282-1305` |
| 3 | 落地/空中 | `startFall/finishFall` 不清气泡；落地姿态 hint | `:1140-1179` |
| 4 | **DSH 外部反应** | `external.bubble` 直接写入 `pendingBubble`（绕过冷却）+ `bubbleGate.notifyExternalBubble` 刷新全局冷却 | `:1307-1330` |
| 5 | 自主活动/idle/hover | `tryEmitBubble(category)` 经 `BubbleGate` 冷却（全局 60s / 同类 120s / 同句 300s；不连续重复） | `behavior/dialogue.ts:14-20,66-71,142-201`；`behavior-director.ts:2440-2453` |
| — | 单槽约束 | 每帧 `pendingBubble=null` 起；`tryEmitBubble` 只在槽空时写；DSH 分支直接覆盖（同级不叠加） | `behavior-director.ts:757,1307-1330,2450-2453` |

台词来源单一：`core/voicelines.ts` 111 条官方原文（SHA-256 锁，禁止自创/改写；`voicelines.ts:1-22,170-177`），池由 `dialogue.ts:53-64` 映射。

### 3.4 目标状态机 vs 现有机制：缺口表

目标：**「思考中…」→ DSH 最终回复文本 → 停留 → 消失 → 下一段**（用户需求语义）。

| # | 缺口 | 现有机制 | 影响 |
|---|---|---|---|
| B1 | 没有独立文本通道：回复文本与"角色台词"共用一个 `BehaviorDecision.bubble` 槽 | 单槽、每帧一个 | 回复与自主台词/交互台词互相覆盖，无法排队 |
| B2 | 每条 DSH 反应只发一次 bubble（`lastExternalBubbleKey`） | `behavior-director.ts:1312-1322` | 无法「思考中→回复→结束语」三段式；同一 turn 只显示一条 |
| B3 | 没有"段/队列"：`ExternalReaction` 无 segment 列表 | `wave2-contract.ts:177-187` | 长回复（实测 440–3437 字）无法分段展示与翻页 |
| B4 | 没有按文本长度自适应停留 | `BUBBLE_DEFAULT_LIFETIME_MS=4200` 固定、调用方传 lifetime | 长句刚显示就消失 / 短句停留过久 |
| B5 | 无优先级抢占/打断规则 | 行为层优先级只到 mood 级；`pendingBubble` 覆盖顺序由分支顺序决定 | 摸头/拖拽发生时回复气泡应让位；新 turn 应清掉旧段 |
| B6 | 无去重/乱序保护（按 event 到达顺序） | 桥事件顺序由文件追加保证，但 renderer 无 `turn/seq` 去重 | pet 重启/文件轮转/重复写可能重播 |
| B7 | 无"思考中"文案 | 无任何状态文案；`voicelines.ts` 禁止自创台词 | 文案是否允许是**用户决策项**（见 §10 Q4） |
| B8 | 长文本渲染无高度上限 | `maxWidth=340`、auto wrap、无 max-height / 字号自适应 | 3437 字会生成超高气泡（可能出屏/盖住宠物） |
| B9 | 气泡与口型耦合 | `bubble.text` 直接进 `AnimationInput.bubbleText` | 长文本会让口型持续夸张开合；分段后每段口型正常，但需 Lead 决定口型跟随哪一段 |
| B10 | DSH 气泡与"窗沿卧姿压制"冲突 | 窗沿 sit/趴时动画 mood 被安全网压成 sit（`known-issues.md:149-154`） | 气泡/表情仍可显示，但动作反应不播；需产品接受或给安全网加白名单 |

### 3.5 冲突面（实现时必须显式处理）

1. **与自主台词冷却**：DSH 文本不应受 `BubbleGate` 60s/120s 冷却限制（用户主动对话的回复必须及时），但显示后应刷新全局冷却，避免紧接着冒自主台词（现状 `notifyExternalBubble` 已做一半，`behavior-director.ts:1319`；新模块需要 Lead 在 main.ts 里调用等价逻辑或直接走新通道）。
2. **与交互反应**：摸头/戳/拖拽是用户主动交互，优先级应高于 DSH 文本；但**不应丢弃**最新回复——建议"暂停/让位，交互结束后恢复下一段"。
3. **与落地/窗沿**：DSH 文本显示期间宠物可能掉落/被放到窗沿；气泡必须跟随 `pointerRect`（含 visualOffset/hipShift，`main.ts:912-944`），不能在旧位置停留。
4. **与口型**：分段后 `bubbleText` 应为**当前段文本**；整段文本不应直接进口型。
5. **与未来专注/静音模式（窥屏线）**：需预留 `quiet/focusActive` gate，专注中 DSH 文本默认降级为无台词/仅表情（可行性文档 §4.5）。

### 3.6 推荐实现接口（建议新增模块，扩展现有契约）

**不改 `bubble.ts` / `wave2-contract.ts` 的既有语义**，新增纯逻辑模块（renderer，可单测）承担「DSH 对话状态机 + 分段 + 优先级 + 时长」：

```ts
// 建议：src/renderer/src/reactions/dsh-dialogue.ts（纯逻辑，不 import DOM/Electron/three）
export interface DshDialogueBubble {
  text: string
  lifetimeMs: number
  /** 语义来源：thinking / reply / error / done */
  kind: 'thinking' | 'reply' | 'error' | 'done'
  /** 用于去重（turn/step/seq），以及多来源仲裁 */
  key: string
}

export interface DshDialogueOptions {
  thinkingText?: string            // 是否允许由用户/Lead 决定（默认可能为空=不显示思考文案）
  maxCharsPerSegment?: number      // 建议 60–120
  maxSegments?: number             // 建议 3（超出以"…"结尾）
  minReplyMs?: number              // 建议 2500
  maxReplyMs?: number              // 建议 10000
  msPerChar?: number               // 建议 60–90ms/字（用于估算停留）
  thinkingTimeoutMs?: number       // 长时间无回复时保持/放弃
}

export class DshDialogue {
  /** 消费一条桥事件（与 DshReactionTracker 同级，独立实例；main.ts 同时喂给两者）。 */
  pushEvent(event: DshEvent, nowMs: number): void
  /** 每帧取当前该显示的气泡（null = 不显示）。 */
  current(nowMs: number): DshDialogueBubble | null
  /** 交互/拖拽让位与恢复。 */
  setBlocked(blocked: boolean): void
  /** 调试/测试快照。 */
  snapshot(): { state: 'idle'|'thinking'|'showing'|'blocked'; pending: number; shown: number }
  reset(): void
}
```

**接线建议（Lead 在 `src/renderer/src/main.ts:933-944` 处改几行）**：
- 事件来源：`api.onDshEvent` 里同时 `runtime.pushDshEvent` 与 `dshDialogue.pushEvent`（`main.ts:1395-1402`）；
- 每帧：在现有 `bubble.show(output.decision.bubble)` 之后，若 `dshDialogue.current(nowMs)` 非空则**用其覆盖**（DSH 对话优先于行为台词，但交互反应时 `setBlocked(true)` 让位），并把当前段文本传给口型；
- `shutdown` 中 `dshDialogue.reset()`（`main.ts:1423-1476`）。

> 备注：`thinking` 文案建议做成**非角色台词**的 UI 状态（例如 `…`/`思考中`），与 `voicelines.ts` 的「官方台词唯一来源」红线分开评审；若用户要求砂金语气，必须走官方台词或由用户提供文本。

---

## 4. 生命周期与系统集成现状

### 4.1 pet 启动 / 退出 / 单实例 / 托盘 / 崩溃恢复

| 环节 | 行为 | 证据 |
|---|---|---|
| 单实例 | **仅打包版**启用 `requestSingleInstanceLock`；dev 允许多 worktree 并行 | `src/main/index.ts:2744-2751` |
| dev userData 隔离 | `PET_PROFILE` → `appData/aventurine-pet-<profile>`（打包版不启用） | `src/main/index.ts:416-432`；`scripts/print-profile.sh` |
| ready 前 | `applyDevProfile()` + `registerPetAssetScheme()` + 冒烟守护 | `src/main/index.ts:2751-2759` |
| bootstrap | accessory（无 Dock/Cmd-Tab）+ `app.dock.hide()` → logger → crashRecovery → 协议 → IPC 注册 → overlay manager → 显示器监听 → GPU 崩溃兜底 → **tray** → `will-quit` 清理 → `activate` 兜底 | `src/main/index.ts:2592-2742` |
| IPC 注册 | `registerIpcHandlers(appContext, appLogger)`（含 DSH IPC） | `src/main/index.ts:2613`；`ipc/index.ts:30-36` |
| overlay | 每显示器一个；`focusable:false`、透明、sandbox、contextIsolation；只 `showInactive()` 不抢焦点；`setAlwaysOnTop(true,'screen-saver')` + 全屏可见 | `windows/overlay-manager.ts:202-210,229-260` |
| 退出语义 | 托盘常驻：overlay 隐藏/关闭不退出；只有托盘「退出」/`pet:quit`/无托盘兜底才退出；`will-quit` 销毁 crashRecovery/settings/tray/overlay | `src/main/index.ts:2716-2722,2783-2787`；`tray.ts:109-164` |
| second-instance | 打包版第二次启动只把已可见 overlay 再 `showInactive()`（隐藏状态不变） | `src/main/index.ts:2773-2781` |
| 崩溃恢复 | `render-process-gone`/`unresponsive`/`child-process-gone(GPU)` → 限流 reload（10min/3 次；unresponsive 5s 延迟 + 5min 冷却）；`crashRecovery.dispose()` 在 will-quit | `src/main/index.ts:2664-2696,2716-2722`；`windows/crash-recovery.ts:34-70,166+` |
| 设置窗 | 单例、可聚焦、登记为广播目标、`will-quit` 销毁 | `src/main/windows/settings-window.ts:55,136,197` |
| 已知限制 | `unresponsive` 真卡死恢复待真机验证（R-05 残余）、`src/main/index.ts` 接线无集成测试 | `docs/known-issues.md:45-54,121-128` |

### 4.2 登录项（`launchAtLogin`）

- 设置项持久化：`PetConfig.launchAtLogin`（`shared/types.ts:114-115`、默认 false `shared/config.ts:45`）；IPC `pet:set-config` 变更后调用 `applyLaunchAtLogin`（`src/main/ipc/config.ts:80-99`）。
- 实现：dev（`!app.isPackaged`）**不写**登录项；macOS packaged 用 `app.setLoginItemSettings({openAtLogin})`；异常只 warn（`src/main/login-item.ts:30-46`）。
- 单测覆盖 dev/packaged darwin on-off/异常/非 darwin（`tests/login-item.test.ts:45-105`）。
- **DSH 自身没有由 pet 设置的登录项能力**：`setLoginItemSettings` 只能设置当前 app 自身；要让 DSH 开机自启必须由 DSH 自己的设置或用户手动配置（可行性见 §4.4）。

### 4.3 DSH 进程/窗口感知：现状 = 没有

| 探测方式 | 是否已实现 | 证据 |
|---|---|---|
| 桥文件心跳（间接） | ✅（但当前无输入） | `dsh-watch.ts:331-340`；`ipc/dsh.ts:42-46` |
| 进程探测（pgrep/ps/NSWorkspace） | ❌ 全仓无调用 | `grep -rn "pgrep \| open -a \| process.execFile \| spawn(" src/main src/renderer/src` → 无匹配 |
| 端口探测（DSH web） | ❌ 无 | 同上；桥 README 也明确不依赖旧皮肤端口（`bridge/README.md:278`） |
| DSH 窗口/应用生命周期事件 | ❌ 无 | 同上 |

### 4.4 互保活（DSH ↔ 桌宠）可行性与推荐语义

**可用信号/手段**：
- DSH 是否在跑：桥心跳 `online`（零权限、最准确，但要求装桥）；进程探测（`ps -ax -o comm=`/`pgrep -f`，零权限，但打包版/CLI/不同启动路径都可能命中，需防误判；macOS 上 `open -a` 单一入口最稳）。
- 拉起 DSH：`/usr/bin/open -a "DeepSeek Harness"`（已有实例则激活/交给 DSH 单实例逻辑；不 `--args` 避免副作用）。
- 拉起 pet：桥插件 `apply` 里 spawn 已打包的 pet 可执行文件（host Node 环境可 `child_process.spawn`，可行性以 R2 确认）；dev 下 pet 是 `pnpm dev`，不能作为生产路径。
- 防风暴：single-flight + 冷却（建议 ≥60s）+ 只在"用户显式启动 pet"或"设置开关开启"时做一次性 ensure，不做持续 watchdog。
- 退出语义：**pet 退出不杀 DSH**（DSH 可能正在跑任务/用户在对话）；**DSH 退出不杀 pet**（降级为离线状态即可）。

**推荐默认语义（保守）**：
1. pet 启动时：若 `dshLink` 开启且配置 `dshEnsureRunning=true`（新键，默认 **false** 待用户拍板）→ 检测（优先桥心跳，退化进程探测）→ 不在运行则 `open -a` 拉起一次；无论结果如何都只做一次 + 冷却，失败只 log。
2. DSH 启动时（bridge `apply`）：若配置 `launchPet` 且指向有效打包路径 → spawn pet（仅打包版；dev 跳过）。**默认关**。
3. 不做双向 watchdog（代价/风险见 §10.2 R-M3/R-M4）。
4. 设置页提供「启动时确保 DSH 在运行」开关 + 手动「立即检查/启动」按钮 + 状态展示。

### 4.5 桥安装现状（desktop profile）

- 未安装（§1.2 证据）；桥 README 明确「只允许安装到独立 profile，禁止装进正在使用的 profile」（`bridge/README.md:10-12,133-168`），这是开发阶段红线；**生产联动必须装进用户实际使用的 profile**——这是本轮调研发现的最大落地矛盾，需要用户明确授权 + 重启窗口（见 §10 Q6/R-M2）。
- 安装/升级路径已有：`dsh plugin --profile <p> add -w <repo>/bridge/dsh-aventurine-bridge`；`engines.dsh` 护栏（`package.json:8-10`）；契约 canary `pnpm dsh:canary`（`bridge/README.md:190-244`、`scripts/dsh-canary.mjs:1-30`）。
- 已缓存真实失败会话 fixture（`session-a1c00648`）与 canary 断言库（`scripts/dsh-canary-lib.mjs`，`tests/dsh-canary-lib.test.ts`），实现阶段扩展文本断言可直接复用。

---

## 5. Wave 3 / V9（清理/性能/打包）现状

### 5.1 现状（未开始，有前置清单）

| 项 | 现状 | 证据 |
|---|---|---|
| electron-builder | **无**：无 `electron-builder.yml`、无 build 配置、无依赖、无签名/公证/entitlements（`package.json` 里的 `build` 只是 npm script） | `docs/packaging.md:8-16`；`package.json:10-38` |
| 签名身份 | 本机 2026-11-10 实测 `0 valid identities found` | `docs/packaging.md:10-12`（本轮未重复跑 `security`，沿用该实测） |
| 未打包生产构建 | `pnpm smoke:file` = build + native + `electron .`（最接近打包的验证路径，但不是 `.app`） | `docs/packaging.md:13-15`；`package.json` scripts |
| 打包版验收 | 完全未验证 | `docs/packaging.md:103-107` |
| R-07 跟踪 | 已知问题条目：打包链路未接线、打包版行为未验证 | `docs/known-issues.md:8-19` |
| 无自动更新 | 无 Sparkle/updater | `docs/packaging.md:105-107` |

### 5.2 剩余可执行项（按可开始性排序）

| # | 项 | 现状/证据 | 可执行性 | 建议 |
|---|---|---|---|---|
| V9-1 | electron-builder 配置骨架（`appId/productName/mac.category/target/dir 先跑通`） | 前置清单 `docs/packaging.md:20-35` | ✅ 可立即做（unsigned `dir` 在本机可验证产物结构） | 新增 `electron-builder.yml` + `entitlements.mac.plist`（先空/最小）；先 `--dir` 目标，不签名 |
| V9-2 | `extraResources` 映射（**路径已在代码里写死**） | helper：`Resources/native/winlist/winlist`（`src/main/desktop/winlist.ts:167-179`）；PMX：`Resources/model`（`src/main/protocol.ts:113-125`）；私有资产：`Resources/assets`（`src/main/protocol.ts:127-140`）；托盘图标回退（`src/main/tray.ts:78-86`） | ✅ 可立即做 + `electron .` 验证 | 与 `docs/packaging.md:37-50` 表逐项对齐；私有资产红线：仅本机打包 |
| V9-3 | native helper universal/签名顺序 | 已实现 universal（`scripts/build-native.mjs:25-56`）；本轮实测 `--check` PASS（x86_64+arm64, minos 13.0）；签名/公证顺序见 `docs/packaging.md:35` | ✅ helper 部分已完成；签名阻塞于 V9-4 | 打包时先签 helper 再签 `.app` |
| V9-4 | Developer ID 签名 + hardenedRuntime + notarize + staple | 环境无证书（`docs/packaging.md:10-12`） | ❌ **环境/用户阻塞** | 需用户提供证书/决定"仅本机 unsigned"；否则 V9 只能做到 `--dir` |
| V9-5 | App 图标（`.icns`） | 仓库只有托盘 `assets/icons/trayTemplate.png`（tracked）；无 app icon；`packaging.md` 未列 | ✅ 可做（用户提供/生成） | 列入 V9 清单，需美术资源（用户拍板） |
| V9-6 | FPS/内存性能测量 | 仅 smoke 瞬时断言：fps≈29@30cap、drawCalls 39、52k tri（`docs/wave2-acceptance.md:69,72`；smoke 断言 `src/main/index.ts:2181-2191`）；**无内存测量**（main/index.ts、scripts 均无 `getProcessMemoryInfo`/RSS）；无 soak/长跑；R-18 bundle 体积未测（`docs/known-issues.md:22-27`） | ✅ 可做（新增 dev-only 脚本） | 新增 `scripts/vrm/measure-runtime.mjs`：spawn `electron .`（或 dev），用 `ps` 采样进程树 RSS/CPU + 读 `window.__aventurineDebug.animation/stats`，输出 JSON；需 GUI 会话与用户同意 |
| V9-7 | `moveWindow` / `notify` 占位 channel | 契约冻结（`shared/ipc.ts:32-44,89,91,126-130`）；preload 暴露、main **无 handler**、renderer 无调用点；R-21 保留 | ✅ 可做（实现或显式标注） | V9 决策：要么补 handler（C1/C3 提前），要么保留占位并文档标注；注意 `tests/shared-contract.test.ts` 锁键集合 |
| V9-8 | legacy 去留（D9） | `animation/legacy/**` 全部保留；`modelBackend/animBackend` 有 env/config，但设置面板**无后端切换 UI**（grep `settings-*` 无 `modelBackend`）；R-18 静态 import 使 renderer bundle 变大 | ⏸ 需用户/Lead 决策 | 建议本轮保留 legacy + 文档化「回退路径」，把 R-18 体积测量并入 V9-6 |
| V9-9 | 权限引导回归（TCC） | `packaging.md:86-101` 红线；现有只查询 `accessibility`（`src/main/ipc/window.ts:178-186`）+ 系统设置深链；通知状态 unknown（R-25 `docs/known-issues.md:38-43`） | ✅ 可做回归清单 | 打包验收时按 `docs/packaging.md:77-84` 执行 |
| V9-10 | `native:check` 不校验 stamp 与源码同步 | `docs/known-issues.md:100-104` | ✅ 可做小改进 | CI/打包前先 `pnpm native:build` 再 `--check`（文档化即可） |

### 5.3 风险

- **签名/公证环境阻塞**：无证书时无法产出可分发 `.app`；`pnpm smoke:file` 不能替代打包验收（`docs/packaging.md:16`）。
- **私有资产与打包红线**：`assets/**` 默认 gitignore 且版权禁止分发；打包包内容必须由用户明确（仅本机 vs 不含资产）；`extraResources` 若打包 assets 会违反红线（README:26-29）。
- **electron-builder 与 Electron 44/pnpm 10 兼容性**：新增依赖需 Lead 决策 + 锁版本；`postinstall: install-electron` 与 builder 可能冲突（待验证）。
- 打包版 `PET_SMOKE_TEST` 生产可达（A-02 已接受，`docs/known-issues.md:55-65`）——打包验收后若要收紧需改 `is.dev` 门控（`src/main/index.ts` Lead-owned）。

---

## 6. Wave 3 / V10（并入 Wave 1.5 烘焙结果）现状

### 6.1 结论：数据接线已完成（事实上的 V10 主体）

| 事实 | 证据 |
|---|---|
| 运行时读**私有生成清单**：`app-manifest.json`（冻结契约形状，选片槽位）+ `app-catalog.json`（运行时全量，一次性动作） | `src/renderer/src/vrm/clip-registry.ts:1-16,36-38` |
| 生成器：`scripts/vrm/motion/build-app-manifest.mjs`（源 mate/hsr 必需、adv 可选；`--check` 幂等） | 脚本头注释 `build-app-manifest.mjs:1-32`；本轮实测 `--check` PASS |
| 本轮实测产物：**app-manifest 40 clips / catalog 181**；槽位 idle 19 / walk 3 / sit 7 / drag 2 / pat 3 / sleep 1 / dshBusy 2 / dshDone 2 / dshError 1；来源 mate 30 / hsr 14 / adv 137 | 本轮实测输出 + `tests/vrm-clip-registry.test.ts:698-730`（真实产物断言，skipIf 私有资产） |
| mate 集 30 条（Wave 1.5 报告写 29 条：实际新增 `dragFemale` 男性适配 step2） | `assets/motions/mate/manifest.json`（30 条）；`scripts/unity-bake/clips.json:19`（2026-11-09 step2：drag 保留男女两版） |
| `src/shared/motion-manifest.json` 为空是**设计**（W0-3 冻结占位；私有资产不进 git，运行时实际读 `assets/motions/` 私有清单） | 契约注释 `src/shared/animation-contract.ts:9`；`tests/animation-contract.test.ts:98-105`；`docs/wave1-15-pitfalls.md:221` |
| DSH 动作别名：catalog clip → `dshBusy/dshDone/dshError` 槽位（`hsr-commonIdle-dshBusy`、`adv-think01-dshBusy`、`mate-happy-dshDone`、`adv-snap01loop-dshDone`、`hsr-stun-dshError`） | `tests/vrm-clip-registry.test.ts:552+`；`tests/adv-app-manifest.test.ts:309` |
| 构建/测试覆盖 | `tests/unity-bake-assets.test.ts`（真实 mate 产物 + manifest --check，skipIf）、`tests/adv-app-manifest.test.ts`（生成器/CLI/--check 篡改检测）、`tests/unity-bake-motion-manifest.test.ts`、`tests/vrm-clip-registry.test.ts`（40/181 真实产物）、`tests/animation-contract.test.ts` |

### 6.2 契约与脚本入口（实现阶段可直接用）

| 用途 | 入口 | 说明 |
|---|---|---|
| 生成/校验运行时清单 | `node scripts/vrm/motion/build-app-manifest.mjs [--check]` | 私有资产必需（mate/hsr）；adv 可选（缺失整集跳过、不报错） |
| Wave 1.5 manifest（canonical/镜像） | `node scripts/unity-bake/build-motion-manifest.mjs [--check]` | 生成 `assets/motions/mate/manifest.json` + `assets/motions/manifest.json`；与 V10 的 app 清单是**两层**（源 manifest → app manifest） |
| hsr 清单 | `scripts/vrm/motion/build-hsr-manifest.mjs` | 与 `retarget-hsr` 管线配套 |
| adv 清单 | `scripts/vrm/motion/build-adv-manifest.mjs` | 可选源集 |
| 运行时消费 | `src/renderer/src/vrm/clip-registry.ts` → `clip-player.ts` | 槽位选片、变体轮换、一次性 `playOneShotClip` |
| 契约类型 | `src/shared/animation-contract.ts`（`AnimationClipManifest`/槽位/priority） | 冻结；新增字段需评审 |

### 6.3 剩余项（V10 收口）

1. **用户实机最终验收**（PLAN V10 的"最终验收"语义）：40 条 app 清单/30 条 mate 动作的真实观感勾选（`PLAN.md:10` 清单）；证据可复用 `scripts/vrm/capture-app.mjs`（发一次 dev 实例 + 截图，`scripts/vrm/capture-app.mjs:1-22`），需要用户在场。
2. **文档口径统一**：Wave 1.5 报告"29 条" vs 实际 30 条（`dragFemale`）；README:165 写"29 条 app 动作清单 + 43 条 catalog"已过时（当前 40/181）。更新 README/PLAN/wave2-acceptance 属于 Lead-owned 文档。
3. **可选自动化**：把 `build-app-manifest.mjs --check` 加入 `prebuild` 或 CI 门禁（当前 `prebuild` 只跑 native + assets check，`docs/packaging.md:63-75`；`scripts/prebuild.mjs`）。需 package.json（Lead）。
4. **干净 clone 可验证性**：私有资产 gitignore → 相关测试 `skipIf`，CI 永远无法覆盖真实 40/181（`tests/vrm-clip-registry.test.ts:698-703`）；接受并文档化。

---

## 7. 测试基建

### 7.1 相关测试矩阵（本任务实际全量跑过：123 files / 2149 passed + 11 skipped）

| 测试文件 | 覆盖点 | 关键行 |
|---|---|---|
| `tests/dsh-watch.test.ts` | 目录/周期解析、status TTL/未来 ts/offline、事件 EOF 基线/半行/截断/轮转/超长/脏行/单次读上限、stop 幂等、回调隔离、logger | `:137,177,311,527` |
| `tests/dsh-ipc.test.ts` | 只注册 `pet:dsh-status`、online 才广播、离线不转发、在线→离线、`will-quit` 后停止、历史不回放 | `:118,175,196,214,243` |
| `tests/dsh-reactions.test.ts` | 事件→mood/时长/台词、重复去重、H-1 error→end 抑制、过期/时钟回拨、离线 reset、脏输入、官方台词池映射/循环 | `:43,94,111,158,197,244` |
| `tests/bridge-plugin.test.ts` | 包结构/engines/patch/locale/icon、apply 箭头不可构造、启停/offline 帧、目录优先级/`~/` 展开/权限、常量 parity、真实 DSH 形状映射（agent/status、agent/disposed、agent/error、turn/end error、assistant/message/tool/result 安全标量、高频事件忽略、真实失败会话复放）、轮转/超长/白名单/目录不可写/并发实例 | `:233,273,349,384,414,579,829,928,950,1046,1123,1152,1241` |
| `tests/bridge-schema.test.ts` | 常量冻结、在线判定、status 结构、解析脏输入、64KB 行上限/UTF-8 字节 | `:40,69,121,147,183` |
| `tests/bridge-schema-sanitize.test.ts` | R-24 payload 白名单（**锁 10 键**）、截断/类型、parse 后清洗 | `:21-36,43,162` |
| `tests/dsh-canary-lib.test.ts` | canary 产物断言库（顺序/字段/离线帧/文件尾） | — |
| `tests/fix-f2b-bubble.test.ts` | BubbleView 淡出/独立过期/不每帧 reflow/rAF 测量、几何（头顶/侧/下/高窗沿不盖宠物） | `:99,135,170,228` |
| `tests/login-item.test.ts` | dev 跳过、packaged darwin on/off、异常、非 darwin | `:45-105` |
| `tests/tray.test.ts` | 图标加载/模板图/缺失降级、菜单结构与勾选、生命周期/幂等 | `:96,131,192` |
| `tests/dsh-work-fidget.test.ts` / `tests/idle-one-shot-fidget.test.ts` | DSH 工作小动作/闲时一次性动作的调度、blocked、seeded 随机、退化输入 | `dsh-work-fidget.test.ts:67,109,196,317` |
| `tests/settings-model.test.ts` / `tests/settings-ipc.test.ts` | DSH 状态文案（`describeDshStatus`）、权限文案、表单同步、广播 | `settings-model.test.ts:261` |
| `tests/shared-contract.test.ts` | IPC 14 通道 + 4 事件冻结、PetApi 键集合、配置默认值/清洗 | `:38-110,114+` |

### 7.2 如何 fake 桥目录/事件（写新测试可直接抄）

- **桥目录**：全部用 `mkdtempSync(join(tmpdir(), '...'))` 注入 `dir`（读取侧还可 `PET_DSH_DIR`）；绝不碰真实 `~/.dsh`。样例：`tests/dsh-watch.test.ts:137-176`（`resolveDshDir`）、`tests/dsh-ipc.test.ts`（temp dir + fake timers + stub `app.once`/`ipcMain`）；plugin 侧 `tests/bridge-plugin.test.ts:124-131`、`:20-25`（`mkdtempSync` + 清理 `AVENTURINE_BRIDGE_DIR`）。
- **fake 事件/时间**：`dsh-watch`/`dsh-ipc` 用 `vi.useFakeTimers()` + 直接 `appendFileSync` 写 events.jsonl 驱动轮询；`dsh-reactions` 用纯逻辑 `pushEvent(event, nowMs)` 注入时钟；bridge 单测用 fake `ctx.on/emit`（`tests/bridge-plugin.test.ts:53-130`）。
- **Electron stub**：`tests/helpers/electron-stub.ts`（ipcMain/app 等最小 stub）。

### 7.3 跑法

```bash
pnpm install
pnpm typecheck                 # node + web，0 error
pnpm test                      # 全量 123 files / 2149 passed + 11 skipped（本任务实测 3.86s）
pnpm test -- tests/dsh-watch.test.ts   # 注意：本机 vitest 5/vite 8 下位置参数仍会跑全量（实测），用 -t 过滤更可靠
pnpm native:build / node scripts/build-native.mjs --check   # helper 编译/校验
node scripts/vrm/motion/build-app-manifest.mjs --check      # 私有动作清单一致性（本任务实测 PASS）
pnpm dsh:canary                # 桥契约 canary（临时 DSH_HOME；~20s；不碰真实 ~/.dsh）
pnpm smoke / pnpm smoke:file   # 端到端冒烟（会开真实桌宠窗口；需私有资产+helper；实现阶段由 Lead/用户窗口执行）
node scripts/vrm/capture-app.mjs ...   # 实机截图/姿态验证（同上，需要 GUI 会话）
node scripts/vrm/e2e-restart.mjs       # 多轮重启/真实数据隔离（同上）
```

### 7.4 私有资产 / 条件跳过（`skipIf`）

`docs/known-issues.md:108-113` 记录 17 处 `skipIf`；与本报告相关的：
- 私有动作/模型相关：`tests/unity-bake-assets.test.ts:74,135-187`（mate 真实产物/manifest）、`tests/vrm-clip-registry.test.ts:698`（app-manifest/app-catalog 真实 40/181）、`tests/assets-pipeline.test.ts:73`（assets/model check）、`tests/vrm-glb.test.ts:216,235`、`tests/animation-vmd-hybrid.test.ts:573+`。
- 平台/工作树条件：`tests/config-store.test.ts:382`（win32）、`tests/scripts.test.ts:190`（`IS_MAIN_WORKTREE`）。
- 干净 clone 中这些会跳过，属预期；**不要**把跳过当失败，也不为凑数删测试。

---

## 8. 「窥屏互动接口」对现有契约的需求摘要（只列约束与缺口）

> 输入：`docs/research/screen-awareness-privacy-focus-feasibility-2026-11-11.md`（621 行，只读，未修改）。本报告不重复其设计，只提炼对**本项目现有契约**的约束与缺口，供 R4/task-4 与实现阶段使用。

### 8.1 该文档对本项目的硬约束（必须继承）

1. **默认档位 `ocr`，首次采集前显式 consent**；权限被拒/被撤销自动降级 `metadata`，不阻断 P0（文档 §0、§4.3-1、§4.8）。
2. **Fail-closed**：权限拒绝/规则解析失败/未知应用/窗口不可捕获/模型输出不合规 → 本次跳过，绝不回退整屏（§4.3-2、§4.5）。
3. **只截前台单窗口**，排除自身 overlay；最小化/零尺寸/跨 Space 不可得 → 跳过（§4.1、§4.3-3）。
4. **内存态、不落盘**：帧只走 helper 内存→stdout JSON→主进程内存；不写临时文件/日志/crash report；不承诺清零（§4.3-4）。
5. **本地优先**：OCR 用 Vision 本机；仅 P3 出网且需用户显式选 provider（§4.3-5）。
6. **出口前脱敏 + 输出过滤器**：行级敏感词、数字/邮箱/URL/代码、`SKIP`、长引用复述；禁用「我看到你…」措辞（§4.3 补充、§4.4）。
7. **透明可回看/可撤销**：最近 10 次观察元数据面板、全局暂停、按 app 允许/拒绝、一键清空、观察日志仅元数据 7 天清理（§4.3-7）。
8. **记忆边界**：屏幕原文永不进对话历史/长期记忆；`source=screen` + `memoryEligible=false`（§4.6）。
9. **TCC 红线**：新增录屏 helper 必须同步 entitlements/用途说明/签名公证/设置页降级路径/文档（`docs/packaging.md:86-101`）。
10. **不改渲染/动画/VRM/物理/窗口吸附主干**；所有能力经现有 `ExternalReaction` 与 config 注入，可独立回滚（§4.7）。

### 8.2 现状缺口（逐项，带现有证据）

| 缺口 | 现状 | 现有触点/可复用 |
|---|---|---|
| 录屏权限状态查询 | **无**：`src/main` 无 `systemPreferences.getMediaAccessStatus('screen')` 调用；现有只查辅助功能（`src/main/ipc/window.ts:178-186`） | 可扩展现有 `pet:accessibility-status` 或新通道 |
| 截图/OCR/氛围采样 helper | **无**；`native/` 只有 winlist（`native/winlist/main.swift`，且明确不读标题/不截图 `main.swift:7`） | 需新 `native/screengrab/main.swift` + `scripts/build-native.mjs` 加 target（现脚本按 targets 配置，`build-native.mjs:119,149-162`） |
| 窗口标题（规则引擎需要） | **无**（winlist 不读 `kCGWindowName`，TCC 红线；`native/winlist/README.md:7-16`、`docs/packaging.md:90`） | 若要 `App::Title` 规则必须新增录屏权限与读标题路径——属于 TCC 升级，需用户拍板 |
| IPC 通道 | **无** screen/peek 通道；冻结契约 14 invoke + 4 事件（`shared/ipc.ts:23-57`；`tests/shared-contract.test.ts:38-110`） | 需 Lead 加法式扩展 `IPC`/`IPC_EVENTS`/`IpcInvokeMap`/`IpcEventMap`/`PetApi`/preload |
| config | **无** `screen`/`focus` 配置组；`sanitizeConfig` 只认已知键、未知键丢弃（`shared/config.ts:146-198`）；`PetConfig` 冻结（`shared/types.ts:89-135`） | 加法式可选键 + `readOptionalRecord`；**不 bump `CONFIG_VERSION`**（否则旧配置整体回退默认：`config-store.ts:160-165`） |
| 主进程编排（gate/节流/预算/退避） | **无**；现有最近似的是 DSH 文件尾随（`dsh-watch.ts`）与 winlist 轮询（`ipc/desktop.ts:40`） | 需新 `src/main/desktop/screen-observer.ts`（依赖注入、纯逻辑可测） |
| 渲染层反应 | 现有 `ExternalReaction` 仅 3 个 DSH mood（`wave2-contract.ts:177-187`），无屏幕观察来源 | 需扩展 mood/新增通道，或复用 tracker 注入路径（R4 设计） |
| 设置页 | 现有 DSH/权限/尺寸等分区（`src/renderer/settings.html:126-144`），无「屏幕感知/专注」 | 新增分区（与 A4 设置任务协调，避免文件冲突） |
| native 打包 | `extraResources` 尚无（`docs/packaging.md:37-50`）；新增 screengrab helper 必须加映射 + 签名顺序 | V9 打包任务需同步 |
| 测试 | 无 gate/fail-closed/无采集副作用测试 | 需纯逻辑单测（R4 §7） |

### 8.3 「只留接口」的契约触点清单（供 R4/Lead 决策）

- **必须 Lead 改**：`src/shared/ipc.ts`、`src/shared/types.ts`、`src/shared/config.ts`、`src/preload/index.ts`、`tests/shared-contract.test.ts`、`package.json`（若加依赖）。
- **新增独立文件（可并行、低冲突）**：`src/shared/peek.ts`（能力/契约类型 + sanitize）、`src/main/ipc/peek.ts`（stub handler，返回 `unavailable`）、`src/renderer/src/reactions/peek.ts`（或不接 UI）、`tests/peek-*.test.ts`。
- **红线**：stub 必须返回 `unavailable`；默认关闭；接口层不得触发任何采集/权限弹窗；日志不含内容；不得在 `native/winlist` 增加标题/截图读取。

---

## 9. 实现阶段任务拆分与文件级写作用域矩阵

### 9.1 拆分原则

1. **Lead 独占（T0）**：`src/shared/**`（冻结契约）、`src/preload/**`、`package.json`/`pnpm-lock.yaml`、`electron.vite.config.ts`、`tsconfig*`、`vitest.config.mts`、`tests/shared-contract.test.ts`、以及所有 Lead-owned 集成文件（`src/main/index.ts`、`src/main/ipc/index.ts`、`src/renderer/src/main.ts`、`src/renderer/src/core/{bubble,voicelines,wave2-contract,pet-runtime}.ts`、`src/main/windows/settings-window.ts`、`src/main/ipc/settings.ts`、`src/renderer/src/vrm/runtime-types.ts`）。理由：这些文件单一所有权，避免契约/接线冲突（PLAN §7、`wave2-contract.ts:1-18` 明示）。
2. **按"文件簇"划分 worker**：bridge 包、renderer 反应模块、main DSH 生命周期、settings 页面、打包、性能脚本、窥屏接口——各自文件不重叠。
3. **冻结契约先改后并行**：任何新增 channel/config/payload 字段先由 T0 落地并更新契约测试，其它任务只消费，不回改 `src/shared/**`。
4. **实现阶段不执行**：不装桥进 desktop profile（用户 gate）、不 `open -a`、不重启 DSH；联调在独立 profile/临时 `DSH_HOME`/临时 `PET_PROFILE` 内做。

### 9.2 任务表（建议 9 个任务 + 2 个用户 gate）

| ID | 任务 | 负责 | 依赖 | 主要交付 | 验收 |
|---|---|---|---|---|---|
| **T0** | 契约扩展与基线冻结（Lead-only） | Lead | 用户决策 Q1/Q6 初判 | `bridge-schema` payload `text`（+专用上限）；`DshStatus` 可选扩展/新 `DshProcessStatus`；新 IPC（如 `pet:dsh-process-status`、`pet:dsh-launch`）；config 新键（`dshEnsureRunning` 等）；preload 转发；更新冻结测试 | `pnpm typecheck` + `pnpm test` 全绿；契约测试同步；`docs/research` 决策记录 |
| **A1** | bridge：最终回复文本 + 生命周期钩子 | bridge-worker | T0 | `lib/index.js`：最终 text 写入、截断/去重、README 映射表更新；可选 `launchPet` 钩子（默认关）；测试同步（F5 改写 + 新用例） | `pnpm test -- bridge-plugin`；`pnpm dsh:canary`（离线失败回合 + 文本断言）；独立 profile 手工安装验收 |
| **A2** | renderer：DSH 对话气泡状态机（思考中→回复→停留→下一段） | renderer-worker | T0 | 新 `src/renderer/src/reactions/dsh-dialogue.ts`（纯逻辑，无 DOM/Electron/three） + `tests/dsh-dialogue.test.ts`（fake 时钟、分段/去重/优先级/打断/乱序） | 单测全绿；快照字段供 Lead 接线/冒烟断言 |
| **A3** | main：DSH 进程检测/拉起/状态 IPC（互保活 pet→DSH） | main-worker | T0 | 新 `src/main/desktop/dsh-process.ts`（可注入 exec/open/时钟；single-flight+冷却+错误降级） + `src/main/ipc/dsh.ts` 扩展 handler + `tests/dsh-process.test.ts` + `tests/dsh-ipc.test.ts` 更新 | 单测全绿；不触发真实 `open -a`（注入 fake）；`will-quit` 清理 |
| **A4** | 设置页：DSH 回复气泡/互保活开关 + 状态展示 | settings-worker | T0、A3 契约（读类型即可） | `src/renderer/settings.html`、`src/renderer/src/settings/main.ts`、`src/renderer/src/settings/settings-model.ts` + 对应测试 | 单测全绿；不破坏现有 DSH/权限分区 |
| **A5** | V9 打包链路骨架（unsigned dir + extraResources + entitlements 占位） | packaging-worker | 用户签名决策（可先做 unsigned） | 新 `electron-builder.yml`、新 `entitlements.mac.plist`、`docs/packaging.md` 更新、可选 `scripts/package-check.mjs` | 本机 `--dir` 产出可启动；`electron .` 行为不回归；资源路径与 `protocol.ts`/`winlist.ts` 对齐 |
| **A6** | V9 性能/内存测量（dev-only 脚本） | perf-worker | 无（需 GUI 会话 + 用户同意） | 新 `scripts/vrm/measure-runtime.mjs` + 新 `docs/research/perf-baseline-2026-11-11.md`（或 `docs/performance-*.md`） | 输出 fps/RSS/CPU/drawCalls JSON；对比基线；不进 CI |
| **A7** | 窥屏接口预留（仅接口/stub/默认关闭/fail-closed） | peek-worker | R4 结论 + T0（第二轮契约） | 新 `src/shared/peek.ts`、`src/main/ipc/peek.ts`、`tests/peek-*.test.ts`；通道注册由 Lead | stub 返回 unavailable、无采集副作用、默认关闭、gate 单测 |
| **A8** | V10 最终验收准备 + 文档口径 | Lead + 用户 | 用户在场 | 新 `docs/wave3-v10-acceptance.md`；更新 README/PLAN/wave2-acceptance 口径；实机证据 | 用户勾选 40 条动作；`--check` 纳入门禁（可选） |
| **G1** | 用户 gate：是否允许「DSH 回复正文写入桥文件」+ 是否允许安装桥进 desktop profile（需重启窗口） | 用户 | — | 决策记录 | 用户明确同意后才做 T3/T4 |
| **G2** | 用户 gate：互保活语义/默认开关/是否允许 pet 拉起 DSH | 用户 | R2/R3 输入 | 决策记录 | 同左 |

> 注：bridge 包内所有改动集中在 A1 一个 owner（`lib/index.js` 是单文件，拆两个任务必冲突）；`bridge/.../lib/constants.js` 由 T0 改（若 payload 常量/事件类型变化）或 A1 在 T0 契约确定后同步（parity 测试强制一致，建议由 T0 一次改完）。
> 注：`src/main/ipc/dsh.ts` 由 A3 owner（现有文件）；若 T0 决定把文本/生命周期拆到新 channel，也统一在 A3 注册。

### 9.3 写作用域矩阵（文件级，互不重叠；✅=owner，🔒=Lead-only 不可由 worker 改）

| 文件/目录 | T0 Lead | A1 bridge | A2 renderer | A3 main | A4 settings | A5 packaging | A6 perf | A7 peek | A8 docs |
|---|---|---|---|---|---|---|---|---|---|
| `src/shared/bridge-schema.ts`、`src/shared/types.ts`、`src/shared/config.ts`、`src/shared/ipc.ts`、`src/shared/peek.ts`(新) | 🔒✅ | | | | | | | | |
| `src/preload/index.ts`、`src/preload/index.d.ts` | 🔒✅ | | | | | | | | |
| `package.json`、`pnpm-lock.yaml` | 🔒✅ | | | | | | | | |
| `tests/shared-contract.test.ts`、`tests/bridge-schema*.test.ts` | 🔒✅ | | | | | | | | |
| `bridge/dsh-aventurine-bridge/lib/index.js`、`lib/constants.js`*、`README.md`、`tests/bridge-plugin.test.ts` | | ✅ | | | | | | | |
| `src/renderer/src/reactions/dsh-dialogue.ts`(新)、`tests/dsh-dialogue.test.ts`(新) | | | ✅ | | | | | | |
| `src/main/desktop/dsh-process.ts`(新)、`src/main/ipc/dsh.ts`、`tests/dsh-process.test.ts`(新)、`tests/dsh-ipc.test.ts` | | | | ✅ | | | | | |
| `src/renderer/settings.html`、`src/renderer/src/settings/main.ts`、`src/renderer/src/settings/settings-model.ts`、`tests/settings-model.test.ts` | | | | | ✅ | | | | |
| `electron-builder.yml`(新)、`entitlements.mac.plist`(新)、`docs/packaging.md`、`scripts/prepare-package.mjs`(可选新) | | | | | | ✅ | | | |
| `scripts/vrm/measure-runtime.mjs`(新)、`docs/research/perf-baseline-2026-11-11.md`(新) | | | | | | | ✅ | | |
| `src/main/ipc/peek.ts`(新)、`tests/peek-*.test.ts`(新) | | | | | | | | ✅ | |
| `docs/wave3-v10-acceptance.md`(新)；README/PLAN/wave2-acceptance 修改 | 🔒（Lead） | | | | | | | | ✅（新文档）/ 🔒（既有文档） |
| `src/main/index.ts`、`src/main/ipc/index.ts`、`src/renderer/src/main.ts`、`src/renderer/src/core/{bubble,voicelines,wave2-contract,pet-runtime}.ts`、`src/main/windows/settings-window.ts`、`src/main/ipc/settings.ts`、`src/renderer/src/vrm/runtime-types.ts`、`electron.vite.config.ts`、`tsconfig*`、`vitest.config.mts` | 🔒 全部 Lead 集成 | — | — | — | — | — | — | — | — |

> *`lib/constants.js` 若 T0 扩展事件类型白名单才需要改；仅加 payload 字段不需要（写入侧不校验 payload 键）。
> `src/renderer/src/vrm/**`、`src/renderer/src/behavior/**` 等其余文件本轮**不需要改**；A2 只在 `main.ts`（Lead）接线，不改 behavior director 语义。
> 冲突规避：`tests/dsh-ipc.test.ts` 归 A3（因为 A3 扩 handler）；`tests/bridge-plugin.test.ts` 归 A1；`tests/settings-model.test.ts` 归 A4；`tests/shared-contract.test.ts` 归 T0。无交叉。

### 9.4 依赖顺序（关键路径）

```text
Phase 0（Lead，先决）
  T0 契约扩展/冻结 + G1/G2 用户决策 + 决定「回复文本落盘 or socket」
        │
        ├───────────────┬───────────────┬───────────────┬──────────────┐
        ▼               ▼               ▼               ▼              ▼
Phase 1（并行，全部只消费 T0 契约）
  A1 bridge        A2 renderer      A3 main         A4 settings     A5 packaging / A6 perf
  (文本+钩子)       (对话状态机)      (进程检测/拉起)   (开关/状态)      (互不依赖，可最早开始)
        │               │               │               │
        ▼               ▼               ▼               ▼
Phase 2（Lead 集成，必须串行在 Phase1 之后）
  T1 src/renderer/src/main.ts 接线（A2 产出 + 气泡仲裁 + 口型）
  T2 src/main/index.ts + ipc/index.ts 接线（A3/A4 新 IPC）
  T3 canary + 独立 profile 安装验收（A1；临时 DSH_HOME；`pnpm dsh:canary`）
        │
        ▼
Phase 3（用户 gate 后）
  T4 desktop profile 安装桥 + 重启 DSH（G1 通过后；用户操作/在场）
  T5 端到端验收：DSH 会话 → 思考中 → 最终回复气泡 → 停留/消失/下一段（含失败回合/多 session/窗沿/交互打断）
        │
        ▼
Phase 4
  A7 窥屏接口（R4 + T0 第二轮契约）  →  与 A4 设置页改动串行/合并
  A8 V10 最终验收（用户在场）+ A5 签名（若 G2 提供证书）
```

关键路径：`T0 → A1 → T3 → T4（用户） → T5`；气泡线：`T0 → A2 → T1 → T5`；packaging/perf 可与主线并行但签名/打包验收在用户 gate 后。

### 9.5 阶段建议（给 Lead 的排期口径）

- **第一批可立刻开工**（不依赖用户 gate）：T0 契约、A1、A2、A3、A4、A5（unsigned dir）、A6。
- **必须在用户在场时做**：T4 桥安装+重启 DSH、A8 V10 实机验收、A5 打包版验收（TCC/签名）、A6 GUI 采样。
- **建议先做 T0 + A2 + T1 的最小闭环**：即使桥未安装，可用离屏 fake（测试里注入 DSH 事件）验证「思考中→回复→停留→下一段」的端到端装配；再接 A1/T3/T4 打通真实链路。

---

## 10. 未决问题与风险

### 10.1 需要用户/Lead 决策的开放问题（附推荐）

| # | 问题 | 推荐默认 | 影响 |
|---|---|---|---|
| Q1 | 回复正文是否允许写入桥文件（落盘）？ | 允许（与 DSH 自身会话日志同权限边界；桥文件 0600、5MB 轮转）；备选 socket 方案留 Wave 4 | 决定 A1 方案与隐私文档 |
| Q2 | 显示哪些文本？ | 只显示「无 tool-call 的最终 text」；中间旁白/工具结果默认不显示（可配置） | A1/A2 过滤规则 |
| Q3 | 分段与停留参数？ | 每段 ≤80 字、按句切、最多 3 段（超出以「…」）、每段停留 `clamp(2500 + 80*nChars, 2500, 10000)ms` | A2 参数 |
| Q4 | 「思考中…」文案是否允许？ | 作为**非角色台词**的 UI 状态（`…`/`思考中`）；若需砂金语气必须用官方台词或用户提供文本（`voicelines.ts` 红线） | A2/T1、产品文案 |
| Q5 | 多 session 过滤：desktop profile 可能并行多个 agent/session（用户主会话 + 子代理 + agent team），只显示哪个？ | 只显示「最近活跃的用户主会话」；bridge payload 已有 `sessionId`（`lib/index.js:569-591`），renderer 侧过滤；主会话识别依赖 R2 | A1/A2 |
| Q6 | 桥是否安装进 desktop profile（需重启 DSH）？ | G1 用户同意后执行；先 canary + 独立 profile 验收 | 整个联动链路能否真实工作 |
| Q7 | 互保活语义与默认开关？ | 「启动时一次性 ensure + 手动按钮」，默认关；不做持续 watchdog；pet 退出不杀 DSH、DSH 退出不杀 pet | A3/A4 设计 |
| Q8 | DSH→pet 拉起是否做？ | 仅打包版 + bridge `launchPet` 可选（默认关）；dev 不做 | A1/A3 + V9 依赖 |
| Q9 | V9 签名/分发范围？ | 本机 unsigned `dir` 验收，不做分发；若需分发，用户提供 Developer ID | A5 能否完整 |
| Q10 | V10 验收口径（29 vs 30、40 clips）与谁勾选？ | 以 30 条 mate/40 条 app 清单为准更新文档；用户在现场勾选 | A8 |
| Q11 | 窥屏接口本轮范围？ | 仅 R4 的「接口/stub/默认关闭/fail-closed」；不做 native/OCR、不申请 TCC | A7 |

### 10.2 风险登记

**P0（会阻塞或造成返工/真实损失）**

- **R-M1 契约扩展与既有隐私承诺冲突**：桥当前显式承诺「不含消息正文」（`lib/index.js:16-24`、F5 测试）。加文本前必须 Lead 评审 + 用户确认（G1），并更新 README/隐私文档；否则实现与文档/测试互相矛盾。
- **R-M2 桥安装改变用户正在使用的 DSH profile**：安装到 desktop profile 会改 `package.json`/`cordis.patch.yml` 并需重启 DSH（用户红线）。**本轮不得执行**；实施阶段必须在用户在场时做，并提供回滚命令（`dsh plugin --profile desktop remove dsh-aventurine-bridge`）。
- **R-M3 互保活重启风暴**：若"确保在场"没有 single-flight/冷却/用户退出记忆，可能出现 pet↔DSH 互相拉起/循环重启（消耗 CPU、打断用户任务）。实现必须：一次性启动 ensure + ≥60s 冷却 + 默认关 + 失败只 log + 不监听"DSH 退出"做持续拉起。
- **R-M4 杀掉用户会话**：任何"pet 退出联动退 DSH"都不可接受（DSH 可能正在跑任务）。禁止。

**P1（影响体验/验收）**

- R-M5 长回复溢出：3437 字符长文本若无分段/高度限制会出屏/盖宠物（气泡 `maxWidth=340`、无 max-height，`bubble.ts:30-31`）。
- R-M6 口型/表情耦合：`bubbleText` 直接驱动口型（`main.ts:933-944`）；长文本/分段边界处理不好会口型夸张或突然停止。需 A2/T1 约定"当前段"。
- R-M7 气泡抢占：摸头/拖拽/菜单/窗沿卧姿会与 DSH 文本争抢（`behavior-director.ts:780-793`、`known-issues.md:149-154`）；需要明确的抢占/恢复规则与冒烟断言。
- R-M8 online 门控丢失事件：pet 启动后 watcher 以 EOF 为基线（`dsh-watch.ts:279-293`）→ pet 未运行期间的回复不会补播；若桥写事件瞬间 status 心跳过期（>30s，如 DSH 挂起）事件会被 `ipc/dsh.ts:42-46` 丢弃。用户预期需对齐「实时/不重放」。
- R-M9 DSH 升级契约漂移：0.x 不承诺 API；`engines.dsh` 只挡版本号，事件形状变了只有 canary 能发现（`bridge/README.md:236-244`）。扩展文本断言后 canary 必须同步，纳入每次 DSH 升级 runbook。
- R-M10 V9 环境阻塞：无签名身份 → 无法产出可分发 `.app`；打包版行为（登录项/helper spawn/资源路径/权限）仍全部未验证（`docs/packaging.md:103-107`）。
- R-M11 私有资产与打包红线：`extraResources` 若把 `assets/**` 打进包，违反"禁止二次配布/商用"红线（README:26-29）；打包策略必须用户确认（仅本机/不含资产）。
- R-M12 无内存/长跑基线：当前只有瞬时 fps/drawCalls（`docs/wave2-acceptance.md:69-72`），无 RSS/CPU 长跑；V9「内存」项无数据可验收，需 A6。

**P2（记录/后续）**

- R-M13 `src/shared/motion-manifest.json` 空集易被误判为 V10 未完成；需在文档中显式解释（本报告 §6.1 已给证据），否则审查/新 agent 会反复误判。
- R-M14 私有资产导致真实 40/181 清单无法在 CI 验证（`tests/vrm-clip-registry.test.ts:698` skipIf）；干净 clone 测试全绿不代表动作清单正确。
- R-M15 `native/winlist/README.md:5` 写"每 500ms 轮询"，实现是 250ms（`src/main/ipc/desktop.ts:40`）；文档漂移，打包/性能文档校对时一并修。
- R-M16 仓库根未跟踪 `mock.pid`（02:03 出现，来源未知、非本任务显式写入）——提交前需 Lead 清理，避免误提交。
- R-M17 `tests/shared-contract.test.ts` 把 IPC 锁死 14+4（`:38-110`）：任何窥屏/DSH 新通道都要 Lead 同步改测试，否则全量测试会失败（这是**有意的契约护栏**，不要绕过）。
- R-M18 通知授权不可查询（R-25 `docs/known-issues.md:38-43`）；若未来要用通知表达 DSH 状态，只能降级 UI/声音。
- R-M19 打包版 `PET_SMOKE_TEST` 生产可达（A-02）；未来把烟测用作打包验收时注意它会在完成/失败时 `app.exit`，不能与日常运行混用。

---

## 11. 证据索引与复跑命令

### 11.1 外部环境证据（只读）

| 事实 | 路径/命令 |
|---|---|
| DSH 版本 | `defaults read "/Applications/DeepSeek Harness.app/Contents/Info.plist" CFBundleShortVersionString` → `0.2.2-rc.1` |
| 运行中 profile | `ps ax \| grep "DeepSeek Harness"` → args 末尾 `.../dsh ~/.dsh/profiles/desktop ...` |
| profile bundle 列表 | `/Volumes/4TB外置盘/dsh-appdata/profiles/desktop/package.json`（无桥） |
| 桥目录陈旧 | `stat -f "%N %Sm" /Volumes/4TB外置盘/dsh-appdata/aventurine-pet/{status.json,events.jsonl}`（Nov 7 21:16/21:17）；`cat status.json`（`ts=1794057469070`、`offline:false`） |
| 用户配置 | `cat ~/Library/Application\ Support/aventurine-pet/config.json`（`dshLink:true`） |
| 真实会话事件结构 | 只读解压 `~/.dsh/sessions/.../session.v4.jsonl.zstd`（多帧 zstd；本报告只记录结构/计数/长度，不记录正文） |

### 11.2 复跑命令（只读/安全）

```bash
cd /Volumes/4TB外置盘/deepseek-harness/aventurine-pet-vrm
git status --short && git log --oneline -1
pnpm typecheck
pnpm test
node scripts/build-native.mjs --check
node scripts/vrm/motion/build-app-manifest.mjs --check
# 环境只读检查
stat -f "%N mtime=%Sm size=%z" ~/.dsh/aventurine-pet/{status.json,events.jsonl}
cat ~/.dsh/aventurine-pet/status.json
sed -n 1,30p ~/.dsh/profiles/desktop/package.json
```

桥 canary（临时 DSH_HOME，不碰真实 `~/.dsh`，实现阶段执行）：

```bash
pnpm dsh:canary            # 离线失败回合，~20s，无 API key
pnpm dsh:canary --keep     # 失败保留临时目录
```

### 11.3 关键代码证据速查（本报告引用）

- `src/shared/bridge-schema.ts:24-128,222-292`
- `bridge/dsh-aventurine-bridge/lib/index.js:11-27,86-92,207-218,293-327,350-672`
- `src/main/desktop/dsh-watch.ts:48-51,130-140,279-293,331-340,398-450,487-505`
- `src/main/ipc/dsh.ts:37-51`；`src/main/ipc/index.ts:30-36`
- `src/renderer/src/main.ts:614-626,912-982,1283-1342,1395-1402,1423-1476,1486-1513`
- `src/renderer/src/reactions/dsh.ts:44-61,119-293`
- `src/renderer/src/core/{bubble.ts:21-279, wave2-contract.ts:177-187,264-286, voicelines.ts:1-22,170-237}`
- `src/renderer/src/behavior/behavior-director.ts:757,780-793,1069-1105,1307-1330,2450-2517`
- `src/renderer/src/behavior/dialogue.ts:14-20,66-71,142-201`
- `src/main/{index.ts:2592-2787, login-item.ts:30-46, tray.ts:109-164, config-store.ts:102-127,160-165,205-226, ipc/config.ts:59-108}`
- `src/main/windows/{overlay-manager.ts:202-260, crash-recovery.ts:34-70, settings-window.ts:55,136,197}`
- `src/shared/{types.ts:89-160, config.ts:36-53,146-198, ipc.ts:23-57,78-141}`
- `tests/{dsh-watch,dsh-ipc,dsh-reactions,bridge-plugin,bridge-schema*,shared-contract,fix-f2b-bubble,login-item,tray,settings-model}.test.ts`
- `docs/{packaging.md, known-issues.md, wave2-acceptance.md, wave15-report.md}`；`PLAN.md:168-173`
