# DSH 0.2.2-rc.1 源码审计：事件形状 / assistant 文本 / 插件 API / 进程生命周期

> 任务：`task-2`（R2 DSH 源码审计）。执行者：research-dsh。日期：2026-11-11。
> 对象：DeepSeek Harness 桌面版 **0.2.2-rc.1**（`/Applications/DeepSeek Harness.app`，build commit `c59d10aff167ad7eefead4b3a9082fb57c8fbfe8`，`0.2.2-rc.1`、`node v24.21.0`、`pnpm 11.28.5`）。
> 真实数据目录：`~/.dsh -> /Volumes/4TB外置盘/dsh-appdata`（**只读**），活跃 profile=`desktop`。
> 本报告只写这一个文件；解包/实验产物全部在 `/tmp`。**未**安装任何插件到真实 desktop profile、**未**重启/杀死真实 DSH、**未** `open -a` 拉新实例、**未**修改 `/Applications`。

---

## 0. 结论速查（TL;DR）

| 关键问题 | 结论 | 证据 |
|---|---|---|
| assistant 最终文本在哪 | **durable**：`session/event` 中 `type === "assistant/message"`，文本在 `event.data.message.content[]` 里 `type === "text"` 块的 `text` 字段。这是**每步结束时的完整终态文本**（不是增量）。一轮（turn）最终回复 = 该 turn 内**最后一个** `assistant/message` 中所有 text 块拼接（DSH 自己的 headless runner 就是这么做的）。 | 源码 `dsh-agent-loop:941-955`、`dsh-llm:70-84`、`dsh-headless:114-139`；实测 `/tmp/dsh-audit-run/out-ok/events.jsonl` n=49、n=68 |
| 增量/流式文本在哪 | **进程内事件** `agent/assistant-stream`，payload `{agent, frame}`，`frame.type='chunk'` 且 `frame.chunk.type='text-delta'`（`chunk.text`）为可见文本增量；`reasoning-delta` 为思考增量。**不落盘**（除 `assistant/message.data.stream` 的压缩回放流外）。 | 源码 `dsh-agent-loop:873, 354-470`、`dsh-llm:977-1037`；实测 out-ok n=30~50 |
| 「思考中」信号 | 有：`agent/assistant-stream` 的 `frame.type='start'`（模型请求开始）+ `chunk.type='reasoning-delta'`（思考文本）+ `block-start` 的 `chunk.blockType='reasoning'`；durable 侧只有事后 `assistant/message` 的 `content[].type='reasoning'`。**没有**专门的 durable `thinking/start` 事件类型。 | `dsh-headless:141-197`（官方正是这样投影 reasoning）；实测 out-ok n=34-36、59-61 |
| 「每处理完一步输出的那段话」对应序列 | `turn/start → step/start → (system/user/request* 内部事件) → agent/assistant-stream(start→chunks→end) → assistant/message(durable) → [tool/call → tool/result] → step/end →（下一步 step/start…）→ turn/end`。每步的「那段话」就是该步的 `assistant/message` 的 text 块；工具调用后下一步的 assistant/message 才是新的那段话；turn 最后一步的就是最终回答。 | 实测 out-ok n=21~72 全序列；源码 `dsh-agent-loop:731-822, 930-976` |
| 插件能否拿到这些文本 | **能**：`ctx.on('session/event', (session,event)=>{...}, {global:true})` 可拿到完整 `assistant/message`（实测）；`ctx.on('agent/assistant-stream', ({agent,frame})=>{...},{global:true})` 可拿到实时增量（官方 API controller/headless 就是这么订阅的）。 | `bridge/dsh-aventurine-bridge/lib/index.js:615-637`（现有订阅方式实测有效）；`dsh-api-session-controller/lib/types/history/assistant-stream.js:11-19`；`dsh-headless:147-197` |
| 插件能否 spawn/守护桌宠进程 | **能**：host-only 插件运行在 DSH Host 的 Node 进程里，可直接 `node:child_process`；实测 spawn `/bin/sh -c "sleep 900"` 成功、dispose 时 kill 掉。插件还能拿到 `process.pid/ppid/execPath/argv`。**但**插件被 HMR 重载/DSH 退出都会执行 disposer，若把桌宠当子进程「绑死」会被一起杀掉，见 §4.4/§4.5。 | 实测 `out-ok/capabilities.json`、`out-ok/events.jsonl` n=1/75；`out-hmr/events.jsonl` dispose 记录 |
| apply/dispose 时机 | apply 在 Host 组合启动时（DSH 启动后、用户会话开始前）；dispose 在：插件被禁用/替换（HMR 生效时立即）、Host 关停（桌面退出/SIGTERM）时。**桌面 app 退出 → Host 关停 → disposer 执行**（实测 SIGTERM 关停 temp `dsh web` 时全部实例的 disposer 都跑了）。 | 实测 out-hmr dispose（3 个实例）；源码 `dsh-desktop-host/lib/index.js:441-487, 584-589`、`dsh-profile-boot` 文件 `profile-boot-e2mS45fC.js:258-330` |
| 桌宠如何检测/拉起 DSH | 检测首选**桥心跳** `~/.dsh/aventurine-pet/status.json`（现有 30s TTL）；兜底看进程：主进程 `/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness` + Host 子进程命令行含 `dsh-desktop-host/lib/index.js`。bundle id=`com.deepseek.dsh`。拉起用 `open -a "DeepSeek Harness"`（Electron `requestSingleInstanceLock`，二次启动只会聚焦/恢复已有窗口，不会拉出第二个实例，见 §5）。CLI `dsh` 不等于桌面 app：CLI 是 Electron Node 模式跑 headless/web profile，且 **明确拒绝** `--profile desktop`。 | 实测本机进程树/端口/plist；源码 `app.asar/lib/main.js:15227-15232, 9976-10010`、`dsh/bin.js:35-39,101-120` |
| 插件热加载 / 安装后免重启 | **支持**：desktop profile 的 HMR 是开启的（base bundle 在 `profileContext` 存在时启用，desktop Host 恒提供 `profileContext.name='desktop'`），HMR 监听 profile patch + profile manifest（package.json）+ home patch；实测（temp `web` profile，同 base+web-app 组合）：改 `cordis.patch.yml` → 旧实例 dispose → 新实例 apply（**免重启**）；运行中 `dsh plugin ... add` 安装新 bundle → 新插件被 HMR 组合进来并 apply；甚至直接往 patch 里 `insert` 一个**绝对路径插件行**（不经 pnpm 安装）也当场生效。 | 实测 `/tmp/dsh-audit-run/out-hmr*`；源码 `dsh-base/cordis.patch.yml:22-31`、`dsh-hmr/lib/index.js:830,872-873,1327-1328`、`dsh-plugin-manager` README「With HMR enabled … apply immediately」 |
| 官方/内置桌宠类插件 | **没有**。0.2.2-rc.1 内置 332 个 `@deepseek-ai/*` 包里没有 pet/avatar/mascot/live2d/vrm 类包；可选 bundle 列表与 on-demand 目录里也没有。可参考的官方实现只有 `dsh-headless` 的「从 durable log 取最后 assistant text + 从 assistant-stream 投影 reasoning」逻辑。 | §9；`dsh-official-bundles/lib/index.js:4-70` |

**会改变设计的关键事实（正面）**：assistant 文本**可以**稳定拿到（durable 终态 + 实时增量都有）；不需要读会话落盘文件，也不需要改 DSH 内部；现有桥插件的事件订阅方式已被实测证明能拿到消息正文——只需扩展它写出的契约（当前实现**故意**只写标量、丢弃正文，见 `bridge/dsh-aventurine-bridge/lib/index.js:92,569-630`）。

---

## 1. 审计环境、方法、边界

### 1.1 安全边界（已遵守）

- 真实 `~/.dsh` 全程只读（`ls/cat` 少量文件）；未写入、未改权限。
- 未把任何插件安装到真实 `profiles/desktop`；未触发 DSH 重启；未 `open -a`；未改 `/Applications`。
- 所有实机实验使用 **临时 DSH_HOME**（`mktemp -d /tmp/dsh-audit-home-XXXX`，本次为 `/tmp/dsh-audit-home-B9VjGQ`）+ 临时 profile + 安装包自带 CLI：
  `/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh`
- 会话/模型调用：本环境 **没有** `DEEPSEEK_API_KEY`（实测 env 为空），故没有、也没有必要用真实凭据。为覆盖「成功回合 + 真实 assistant 文本」路径，自己写了一个**本地离线的 Anthropic-Messages 兼容 mock 服务**（`/tmp/dsh-audit-run/mock-llm.mjs`），让 DSH 通过 `DEEPSEEK_BASE_URL` 指向 `127.0.0.1`，占位 key，不产生任何外网调用/费用（DSH 在指向非官方 endpoint 时不会去请求 `/models` 列表，见 `dsh-llm-deepseek-api-key` README）。
- 未跑桌宠项目自身的 `pnpm dev/smoke`；临时目录不在仓库内。

### 1.2 app.asar 解包（自写解析器）

`app.asar` 为 Electron asar 格式（8 字节大小前缀 + Pickle 包裹的 JSON 目录树 + 拼接文件数据）。网络不可依赖，直接自写 Node 解析+按前缀抽取（脚本：`/tmp/dsh-asar-audit/asar-read.mjs`、`asar-list.mjs`、`asar-extract.mjs`，解包目录 `/tmp/dsh-asar-audit/extract/`）：

| 事实 | 值 |
|---|---|
| asar 大小 | 213,240,777 B |
| 头部字段 | `field0=4`、`field1=5,748,756`（header pickle 总长）、JSON 目录树 5,748,746 B |
| 数据起始 | `8 + 5,748,756 = 5,748,764` |
| 文件总数 | 22,105；`dsh/` 21,050 个；`lib/`+`renderer/`=Electron shell 29 个；`node_modules/` 1,025 个（asar 顶层） |
| 未打包文件 | 1,576 个在 `app.asar.unpacked`（fflate/pako 等，`.d.ts` **未随包发行**，只有编译后 JS，但保留了完整 JSDoc 注释） |

源码引用约定：下文 `app.asar/dsh/...` 指 asar 内路径，行号取自解包后**同字节**文件 `/tmp/dsh-asar-audit/extract/dsh/...`。

### 1.3 关键模块路径（源码导览）

| 模块 | asar 路径（`app.asar/dsh/node_modules/@deepseek-ai/`） | 职责 |
|---|---|---|
| agent 事件/生命周期 | `dsh-agent/lib/index.js`、`dsh-agent/lib/types/dispatch.js` | AgentRegistry、`agent/*` 事件、agent 对象注入 |
| agent 主循环 | `dsh-agent-loop/lib/index.js` | turn/step 边界、assistant 流、assistant/message 落库、message 组装 |
| durable 会话 | `dsh-session/lib/index.js`、`lib/types/known-event-types.js`、`lib/types/surface.js` | event log、`session/event` 发布、62 种 durable 事件类型、surface/message 投影 |
| LLM 消息/流 | `dsh-llm/lib/index.js` | `createAssistantMessage`、`BlockAssembler`（text/reasoning/tool-call）、流 chunk 类型、compact stream |
| DeepSeek 传输 | `dsh-llm-deepseek/lib/index.js` | Anthropic Messages 协议、SSE 翻译（`thinking_delta→reasoning-delta` 等） |
| Host（真正跑插件的进程） | `dsh-desktop-host/lib/index.js`、`lib/cli.js` | 加载 desktop profile、`runProfile`、IPC 关停、CLI 入口 |
| Electron shell | `app.asar/lib/main.js`、`app.asar/package.json` | 单实例锁、spawn Host 子进程、窗口、更新、before-quit |
| profile/组合/兼容性 | `dsh-app-boot/lib/index.js`、`dsh-official-bundles/lib/index.js` | profile 装载、bundle patch 叠加、`engines.dsh` 准入、insert 路径→file URL |
| profile 启动骨架 | `dsh/lib/profile-boot-e2mS45fC.js`、`dsh/lib/bin.js` | `profileContext`、信号→dispose、CLI 参数/desktop profile 护栏 |
| 热加载 | `dsh-hmr/lib/index.js` | 监听 profile patch/manifest、recompose、模块替换 |
| 插件管理 | `dsh-plugin-manager/lib/index.js` | 安装/启用 bundle、compat 预检、HMR 即时应用 |
| Web 服务/客户端插件 | `dsh-host-webserver/lib/index.js`、`dsh-client-modules/lib/index.js`、`dsh-client-hmr/lib/index.js` | 自定义 HTTP 路由、客户端 bundle/面板、页面内热更新 |
| headless 参考实现 | `dsh-headless/lib/index.js` | **官方「取最终文本 / 投影 thinking」的实现范本** |
| 会话持久化 | `dsh-session-persistence-jsonl/lib/index.js` | 落盘布局、zstd 帧、flush |
| API/客户端流 | `dsh-api-session-controller/lib/types/history/assistant-stream.js`、`lib/types/assistant-stream.js` | Web 端 assistant 流基线/增量 |

---

## 2. 事件系统实测形状

### 2.1 两类事件（最重要区分）

1. **进程内 agent 事件**（Cordis 事件总线，`ctx.events`，payload 自动注入 `agent` 对象）：`agent/status`、`agent/error`、`agent/created`、`agent/disposed`、`agent/assistant-stream`、`agent/inbox/*`、`agent/turn-stopping` 等。**只有全局监听（`ctx.on(name, cb, {global:true})`）能跨 agent 收到**；官方 Web API 层与 headless runner 都这样订阅。不会写进会话文件。
2. **durable 会话事件**（`session/event`，签名 `(session, event)`）：`event` 形如 `{ type, seq, time, data, surfaceOp?, sourceEventSeqs?, ignorable? }`，每个事件由 `Session.append()` 冻结后提交并**同步**通知监听器（`dsh-session/lib/index.js:1524-1546`, `1585-1605`）。这是**会话文件里同源的数据**，插件读它等价于读落盘内容，但实时、且无需解析 zstd。

### 2.2 `agent/*` 事件形状（实测）

| 事件 | payload（真实形状） | 触发/语义 | 源码 |
|---|---|---|---|
| `agent/created` | `{ agent, source, signal? }`；`source` 为字符串（文档枚举：fresh creation / resume / clear / compaction；实测 headless CLI 回合为 `"startup"`，`signal` 为创建监听器 AbortSignal）；`agent.id === agent.session.id` | 注册并 announce 新 agent（`ctx.serial`，创建处理器异常会拒绝创建） | `dsh-agent/lib/index.js:600-624, 703-720`；`dsh-agent-loop/lib/index.js:1622/1691/1765` |
| `agent/disposed` | `{ agent }` | agent 被注销（fiber dispose/会话关闭/进程收尾），可能在最后一个 turn 排空后 | `dsh-agent/lib/index.js:681-694` |
| `agent/status` | `{ status: 'idle'｜'running', agent }` | **仅在变化时 emit**：idle↔running（maintenance 也算 idle）。实测顺序：`running` 在 `turn/start` **之前**；`idle` 在 `turn/end` **之后** | `dsh-agent-loop/lib/index.js:554-562` |
| `agent/error` | `{ turn, step, error, agent }`；`error` 是真实 Error（实测 `LlmError`，有 `.message`/`.code`，如 `TRANSPORT`） | 运行边界处的错误（每轮重试失败后仍会先 emit 它，再 append `turn/end`） | `dsh-agent-loop/lib/index.js:636-648` |
| `agent/assistant-stream` | `{ agent, frame }`（见下） | 每次模型 attempt 的实时流：start/chunk/end；**失败重试会产生多组 start/end，revision 连续递增** | `dsh-agent-loop/lib/index.js:354-470, 873` |

`frame` 三态（`AssistantStreamAttempt`，`dsh-agent-loop/lib/index.js:354-470`）：

```jsonc
// start（发请求前）
{"type":"start","attemptId":"session-xxx:1","revision":1,"turn":1,"step":1}
// chunk（每个流块；chunk 来自 dsh-llm 的 StreamChunk）
{"type":"chunk","attemptId":"session-xxx:1","revision":2,"index":0,"time":1794333830544,
 "chunk":{"type":"reasoning-delta","index":0,"text":"先想一下：…"}}
// end（durable settlement 提交后）
{"type":"end","attemptId":"session-xxx:1","revision":17,"index":17,
 "outcome":{"kind":"committed","eventType":"assistant/message","seq":15}}
// 失败型 settlement：outcome.kind='committed' 且 eventType='assistant/attempt'；无法提交时 outcome={kind:'abandoned'}
```

`chunk.type` 取值（`dsh-llm/lib/index.js:954-1130` 的 BlockAssembler / 流协议）：
`block-start{index,blockType:'text'|'reasoning'|'tool-call'}`、`text-delta{index,text}`、`reasoning-delta{index,text}`、`tool-call-delta{index,id?,name?,argumentsDelta}`、`block-end{index,block}`、`usage{usage}`、`finish{reason:{kind:'stop'|'tool-calls'|'max-tokens'|'error'|'aborted',...},replayState?}`。

> 实测（成功回合）：`block-start(0)` → `reasoning-delta` → `block-end(0)` → `block-start(1)` → `text-delta ×2` → `block-end(1)` → `block-start(2)` → `tool-call-delta ×4` → `block-end(2)` → `usage` → `finish` → `end{committed assistant/message seq=15}`。证据：`/tmp/dsh-audit-run/out-ok/events.jsonl` n=30-50。

### 2.3 `session/event` envelope 与关键 durable 事件

envelope（`dsh-session/lib/index.js:1524-1546`）：`{ type, seq, time, data, surfaceOp?, sourceEventSeqs?, ignorable? }`；`seq` 从 0 递增；`surfaceOp:'append'` 表示该消息事件进入模型可见 surface（替换型另有 surfaceOp）；`sourceEventSeqs` 例如 tool/result 引用 tool/call 的 seq。

本次实测到的 durable 事件（成功回合，按 seq）：

| 事件 | `data` 形状（实测） | 说明 |
|---|---|---|
| `permission/preset` | `{preset}` | 权限预设 |
| `sandbox/mode` | `{mode}` | 沙箱模式 |
| `approval/policy` | `{policy}` | 审批策略 |
| `agent/inbox/spliced` | `{target,start,inserted?,removedCount?,...}` | 收件箱变更（含用户消息注入/认领） |
| `turn/start` | `{turn}` | 一轮开始 |
| `step/start` | `{turn,step}` | **一步开始（= 一次模型请求 + 可能跟工具执行）** |
| `system/message` | `{turn,step,message:{id,role:'system',content:[{type:'text',text}],source:{kind:'system-prompt'}}}` | 系统提示（surfaceOp=append） |
| `user/message` | `message` 本身：`{id,role:'user',content:[{type:'text',text}],source:{kind:'user'}}`（运行时上下文为 `source.kind='runtime-context'`） | 用户输入/上下文 |
| `request/header` | `{header:{config:{provider,model,maxTokens?,reasoningEffort?},adapterDefaults?,tools?},reason:'initial'|'resume'|'change'|'series'}` | 请求头快照（含工具名列表；本报告脱敏） |
| `request/context` | `{provider,model,contextWindow?,systemPromptUpdate?}` | 路由/上下文 |
| `session/title` | `{title,messageSeqs,source:{kind:'fallback'...}}` | 会话标题（不来自 agent 流） |
| `session/title-llm-request` | `{titleProvider,messageSeqs,route,system,messages,maxTokens,reasoningEffort}` | 标题 LLM 请求（独立于 agent；**不会**产生 agent/assistant-stream） |
| `assistant/message` | **见 §2.4** | ★ 每步最终文本 |
| `assistant/attempt` | `{turn,step,stream:[compact records]}` | 失败/中止 attempt 的 durable 记录（无 message） |
| `tool/call` | `{turn,step,callId,name,arguments}` | 工具调用开始 |
| `tool/result` | `{turn,step,message:{id,role:'tool',source:{kind:'tool',callId},toolCallId,content:[blocks],isError}}`，envelope 带 `surfaceOp:'append', sourceEventSeqs:[tool/call.seq]` | 工具结果 |
| `todo/write`（示例插件事件） | `{todos:[...]}` | 其它插件自己的 durable 事件 |
| `llm/retry` / `llm/retry-started` | `{retryId,turn,step,provider,mode,policyKey,retry,maxRetries,delayMs,failure:{message,code}}` / `{retryId,turn,step,retry}` | 重试（失败回合实测 5 次） |
| `step/end` | `{turn,step}` | 一步结束（在工具结果之后） |
| `turn/end` | `{turn,reason}`；reason.kind ∈ `completed｜blocked｜error｜aborted｜max-tokens`；`error` 形如 `{kind:'error',error:{message,code}}`；`aborted` 形如 `{kind:'aborted',reason:{kind:'user'|'parent'|'disposed'|'hook',...}}` | 一轮结束；**要注意 `turn/end` 本身不含最终文本** |
| `session-log-deepseek/delivery-accepted` | 交付确认（遥测/日志） | 可忽略 |

源码锚点：`dsh-agent-loop/lib/index.js:731-822`（turn/step 边界与 turn/end reason）、`dsh-tools/lib/pipeline.js:188`（tool/call append）、`dsh-session/lib/types/index.js`（每个事件的 data 校验/投影）、`dsh-session/lib/types/surface.js:75-105`（message 事件→投影）。

### 2.4 ★ `assistant/message` 精确形状（实测原文）

```jsonc
{
  "type": "assistant/message",
  "seq": 15,
  "time": 1794333830570,
  "surfaceOp": "append",
  "data": {
    "turn": 1,
    "step": 1,
    "message": {
      "id": "b2cce903-…",                       // 稳定消息 id（每次模型响应一个新 id）
      "role": "assistant",
      "content": [
        {"type": "reasoning", "text": "先想一下：用户要我审计，我先记一个待办。"},
        {"type": "text",      "text": "第一步：记录审计待办。"},
        {"type": "tool-call", "id": "toolu_mock_1", "name": "todo_write",
         "arguments": "{\"todos\":[…completed…]}"}
      ],
      "source": {
        "kind": "model",
        "provider": "deepseek-official",
        "model": "deepseek-flash",
        "replayState": { "response": {"kind":"deepseek-messages","version":1,"model":"deepseek-flash"},
                         "blocks": [ … ] }        // 可回放元数据（含 thinking signature），插件不需要
      }
    },
    "usage": {"inputTokens": 12, "outputTokens": 64, "totalTokens": 76},  // 可能缺席
    "stream": [ … compact 记录 … ],               // 该 attempt 的压缩回放流（见 §2.5）；可能很大
    "interrupted": true                           // 仅被中止时出现（此时 message 可能只含部分 text/reasoning 块）
  }
}
```

- 这就是**终极形态**：`BlockAssembler.blocks()` 组装的完整内容块（`dsh-llm/lib/index.js:954-1130`），不是 delta；每个 step 的模型响应**结算时**（流结束后）append 一次。
- 文本提取：`data.message.content.filter(b => b.type === 'text').map(b => b.text).join('')`；官方 headless 正是这么取最终回答（`dsh-headless/lib/index.js:129-132`）。DSH 前端 transcript 也基于 `assistant/message` + `text` 块（`dsh-api-session-controller/lib/types/history/*`）。
- `content` 里可能出现的块类型（当前版本）：`text`、`reasoning`、`tool-call`；未来版本可能新增（建议提取逻辑对未知 `type` 宽容跳过）。
- `message.content` 为空数组的情况存在：`max-tokens` 步骤只带 usage 的空 assistant（`dsh-session/lib/types/surface.js:93-100` 注释明确），此时不应把它当回答。

### 2.5 增量流 vs 压缩回放流

- 实时增量：`agent/assistant-stream`（§2.2）。
- `assistant/message.data.stream` 是**压缩后的回放流**（`AssistantStreamAccumulator`：`dsh-llm/lib/index.js:1150-1255`，`expandAssistantStream`：`:1257+`），把连续 delta 合并成 `{type:'text-chunks',time0,index,dt:[],texts:[]}` / `{type:'reasoning-chunks',…}` / `{type:'tool-call-chunks',…}` / `{type:'chunk',time,chunk}`。它用于重放/断线恢复，**不是给实时 UI 用的**；桥插件不要写它（体积大且含重复内容）。

### 2.6 成功回合完整时序（实测；temp headless，mock 离线模型）

证据：`/tmp/dsh-audit-run/out-ok/events.jsonl`（75 行）。关键帧：

| # | 事件 | 关键字段 | 含义 |
|---|---|---|---|
| 1 | probe apply | spawnPid | 插件 apply（Host 启动时） |
| 14-16 | `session/event` permission/preset → sandbox/mode → approval/policy | seq 0-2 | 会话创建时初始状态 |
| 17 | `agent/created` | agent.id=session-ca4d…, source=startup | 会话对应 agent 创建 |
| 18-19 | inbox/spliced、agent/inbox/inserted | | 用户消息入队 |
| 20 | `agent/status` | running | **turn/start 之前** |
| 21 | `turn/start` | turn=1 | |
| 22-23 | inbox/spliced、agent/inbox/claimed | | 认领输入 |
| 24 | `step/start` | turn=1, step=1 | |
| 25-27 | system/message、user/message ×2 | seq 7-9 | 请求上下文 |
| 28-29 | request/header、request/context | | 请求头/路由 |
| 30 | `agent/assistant-stream` | frame start turn=1 step=1 | 模型请求开始（「思考中」可用信号） |
| 31-33 | session/title、session/title-llm-request、delivery-accepted | | 标题旁路调用（独立，不进 agent 流） |
| 34-48 | `agent/assistant-stream` chunk ×15 | block-start/reasoning-delta/block-end/text-delta×2/block-end/tool-call-delta×4/block-end/usage/finish | 流式内容 |
| 49 | **`assistant/message`** | seq15, step1：reasoning + text + tool-call | ★ 第一步的「那段话」+工具调用 |
| 50 | assistant-stream frame end | outcome committed assistant/message seq15 | |
| 51 | `tool/call` | seq16, todo_write | 开始执行工具 |
| 52-53 | delivery-accepted、`todo/write` | seq17-18 | 工具副作用 |
| 54 | `tool/result` | seq19, content text | 工具结果 |
| 55 | `step/end` | turn1 step1 | |
| 56 | `step/start` | turn1 step2 | 进入下一步 |
| 57-69 | assistant-stream 第二轮（start→reasoning/text→end） | | |
| 68 | **`assistant/message`** | seq23, step2：reasoning + final text（无 tool-call） | ★ 最终回答 |
| 70 | `step/end` | turn1 step2 | |
| 71 | `agent/turn-stopping`（serial） | | |
| 72 | `turn/end` | seq25, reason={kind:'completed'} | turn 结束（无文本） |
| 73 | `agent/status` | idle | **turn/end 之后** |
| 74 | `agent/disposed` | | CLI 回合结束退出 |
| 75 | probe dispose | child killed | Host 关停时 disposer |

headless CLI 的 stdout（`/tmp/dsh-audit-run/ok-turn.log`）也印证：
```
dsh: reasoning:
先想一下：…
dsh: reasoning:
再想一下：…
第二步：审计完成，这就是最终文本。
```
（reasoning 写到 stderr、最终 assistant text 写到 stdout —— 正是 §2.4 的两个来源。）

### 2.7 失败回合时序（离线，模型端点关闭）

证据：`/tmp/dsh-audit-run/out-fail/events.jsonl`（71 行）。核心序列（与成功回合的差异）：
`turn/start → step/start → system/user/request* → assistant/assistant-stream{start → chunk finish(kind:error,failure{message,code:TRANSPORT}) → end{committed assistant/attempt}}`，`llm/retry`/`llm/retry-started` 重复 **5 次**（退避 ~0.5s→1s→2s→4s→8s），然后：
`step/end → agent/error{turn:1,step:1,error:LlmError(code:'TRANSPORT')} → turn/end{reason:{kind:'error',error:{message,code}}} → agent/status idle → agent/disposed → dispose`。
注意顺序：**`agent/error` 在 `turn/end` 之前**；`turn/end` 的 error 是 `reason.error`（不是 `failure`）。这一点现有桥插件 `agent/error` + `turn/end(reason.kind=error)` 去重逻辑是正确可行的。

### 2.8 「每处理完一步输出的那段话」与「思考中」

- **一步** = 一个 `step/start` 到 `step/end`。步内只有一次模型请求（重试属同一步）。模型响应结算 → `assistant/message`（含该步全部 text/reasoning/tool-call 块）→ 若有 tool-call 则执行工具（`tool/call`→`tool/result`）→ `step/end`。
- 因此「每处理完一步（思考/工具调用后）输出的那段话」= 该步 `assistant/message` 中 `type='text'` 的块内容。工具调用后如果还有下一步，则下一步的 `assistant/message` 是「续写的那段话」；turn 的最后一步通常没有 tool-call，其 text 就是**最终回答**。
- 一个 step 的 assistant/message 可能**没有 text 块**（只有 reasoning + tool-call，或空）：此时不应弹气泡文本。
- **思考中**判定（推荐）：
  1. 进入新的 step（durable `step/start`）或 `agent/assistant-stream` 的 `frame.type='start'` → 进入「思考中」；
  2. 收到 `reasoning-delta` → 仍「思考中」，可显示思考文本（或只显示占位）；
  3. 收到第一个 `text-delta`（或 `tool-call-delta`/`finish`）→ 结束「思考中」，进入「输出中/调用工具」；
  4. `frame.type='end'` 且 outcome committed assistant/message → 该步文本终态（`assistant/message` 事件到）。
  - 若模型不输出 reasoning（reasoningEffort=off），仍然有 start/step/start 兜底信号；不要依赖 reasoning 文本存在。
  - 失败重试会重新发 start 帧（实测失败回合 6 组 start/end），UI 侧应做去抖/只在 `turn/end`/`agent/error` 时明确失败。

---

## 3. 插件能力证据

### 3.1 host-only bundle 装载格式（现有的桥插件就是这种）

- 包声明：`package.json` 里 `"type":"module"`、`main`、可选 `exports`、`engines.dsh`、`dsh.bundle.patch: "./cordis.patch.yml"`；`cordis.patch.yml` 是一层 loader patch（`- insert: - id: xxx name: 包名`）。现有实现：`bridge/dsh-aventurine-bridge/package.json`、`cordis.patch.yml`。
- 装载：`dsh-app-boot` 读 profile 的 `dsh.profile.bundles` 顺序叠加 bundle patch，再叠 profile patch、home patch；每个 bundle 先做 `engines.dsh`/peer 兼容性准入（不满足则**整层跳过**并报告 `skippedBundles`；见 `dsh-app-boot/lib/index.js:1119-1130`、README「Profiles」）。
- 插件入口 `apply` 必须是**箭头函数**（不可构造），返回 disposer；cordis 4.x 用 `isConstructor` 判定。现有桥文件头注释与 README 已记录该坑，实测正确。
- patch `insert` 的 `name` 支持：包名 / **绝对路径** / `./`、`../` 相对路径 / file URL；路径会被 `anchorInsertedPluginNames` 转成 file URL（`dsh-app-boot/lib/index.js:4718-4727`），**不需要 pnpm 安装**（§4.6 实测）。
- 同一行被 profile patch 覆盖时按 `id` 定位；`config` 是整块替换不合并。

### 3.2 事件订阅（实测有效）

```js
// agent 事件：全局监听；官方 API controller / headless 也这样用
ctx.on('agent/assistant-stream', ({ agent, frame }) => { … }, { global: true })
// session/event：签名是 (session, event)；第三个参数 { global: true }
ctx.on('session/event', (session, event) => { … }, { global: true })
```
- 现有桥插件就是这么订阅的（`bridge/dsh-aventurine-bridge/lib/index.js:461-472, 633-637`），本次 temp profile 实测全部收到。
- `session/event` 监听是**同步**派发、单监听器异常被宿主隔离（不会打挂会话；`dsh-session/lib/index.js:1595-1605` 的 `invokeContainedSessionObservers`）——但插件仍应自己 try/catch。
- 监听器收到的 `session` 是**活对象**：可用 `session.id`、`session.seq`、`session.eventAt(seq)`、`session.snapshotEvents()`、`session.header`（`dsh-session/lib/index.js:1441,1454,1479,1331`），可做回填/过滤；`agent.session.header.origin === 'subagent'`/`parentSession`/`delegationDepth` 可区分 subagent（`dsh-subagent/lib/index.js:355-356`）。
- `agent` 对象：`agent.id`（=session.id）、`agent.status`、`agent.session`；**用 `agent` 对象身份或 id 过滤到自己关心的会话**（headless 用 `subject !== agent` 过滤，`dsh-headless:159-161`）。

### 3.3 访问 DSH 服务需要 `inject`

- 无 `inject` 声明时 `ctx.get('tools')/('webServer')/('agents')…` 都是 `undefined`（本次 probe 实测 `out-ok/capabilities.json`：`ctxKeys` 只有 `fiber`）。要访问服务，bundle 必须 `export const inject = ['agents','sessions','webServer',...]`（示例：`dsh-headless/lib/index.js:105-108` `inject = ['agentDefaultModel','agents','sessions']`）。
- 桥插件只订阅事件，**不需要** inject（现状即可）；若将来要做自定义 Web 面板/接口，需要 `inject: ['webServer']`（§8）。

### 3.4 插件可以 spawn / 守护子进程（实测）

- host-only 插件运行在 DSH Host 的 Node 进程里（不是 Electron renderer，也不受 workspace 文件沙箱限制——插件管理 README 明确「installed Host code executes in-process outside the workspace sandbox」）。本次 probe 在 `apply` 里 `spawn('/bin/sh',['-c','sleep 900'])` 成功，拿到 pid；`dispose` 时 SIGTERM，事后 `pgrep 'sleep 900'` 为空。
- 插件可见自身进程事实（实测 capabilities）：
  `pid=Host 子进程 pid`、`ppid=Electron 主进程 pid`、`execPath=/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness`、`argv=[Electron, .../dsh-desktop-host/lib/index.js, runtimeDir, projectDir, …]`、`cwd`、以及 `DSH_HOME/DSH_PROFILE/DSH_PROFILE_DIR/DSH_SESSION_ID/DSH_WEB_URL` 等环境变量。
- **限制/坑**：
  - 插件生命周期 ≠ 桌宠生命周期。HMR 重载、用户在插件管理里禁用、DSH 退出都会 dispose；若把桌宠作为插件子进程且未 unref/detach，会被一起杀掉。反过来若 detach，DSH 崩溃后桌宠变孤儿。推荐：**桌宠独立进程常驻**，插件只写事件；或插件负责「确保桌宠在跑」（单实例锁 + detached spawn）并在 disposer 里不杀它。
  - 插件进程内**没有** Electron/窗口 API：拿不到窗口焦点、最小化、主题等；只能进程级/文件级。若将来需要，得走 Web 客户端插件（§8）。

### 3.5 apply / dispose 时机（实测）

| 时机 | 行为 | 证据 |
|---|---|---|
| DSH（Host）启动组合时 | bundle patch 行被 Loader 导入并 apply；此时一般还没有用户会话/agent | 失败回合/成功回合 probe 首条都是 apply；desktop Host `runProfile`（`dsh-desktop-host/lib/index.js:441-460`） |
| 会话/agent 创建 | 不重建插件，只是事件开始出现 | out-ok n=14-21 |
| 插件被禁用/替换（HMR） | 旧实例 disposer 先跑，再 apply 新实例 | out-hmr：`app-boot/config-reload` → dispose → apply（改 config 触发） |
| 用户退出桌面 app | Electron `before-quit` → `finishQuit` → Host IPC `shutdown` → `running.shutdown.shutdown(0)` → Cordis fiber dispose → 所有 disposer；>10s 未退则 SIGTERM/SIGKILL（`dsh-desktop-host/lib/index.js:475-487`、`lib/main.js:21314+`） | 实测 temp `dsh web` SIGTERM 关停后出 dispose 记录、子进程被清 |
| 崩溃/SIGKILL | 不保证 disposer；桥文件会残留，靠心跳 TTL/异常退出策略处理 | 源码推断（`runProfile` 只处理 SIGTERM/SIGINT；`dsh/lib/profile-boot-e2mS45fC.js:280-295`） |

### 3.6 HMR 热加载与「安装后免重启」（本任务重点核实）

**结论：0.2.2-rc.1 桌面版默认开启 HMR，profile 的配置/插件变更可以实时生效，无需重启 DSH。** 链路与实测：

1. **desktop Host 一定提供 `profileContext`**：`runProfile({profile:"desktop", …})` 内部 `hostCtx.provide("profileContext", {name: …, dir, patchPath, startedBundles, …})`（`dsh/lib/profile-boot-e2mS45fC.js:291-305`；`dsh-desktop-host/lib/index.js:441-460`）。
2. **base bundle 的 hmr 行**：`- id: hmr name: '@deepseek-ai/dsh-hmr' disabled: !!js "!ctx.get('profileContext')" config: {root: []}`（`dsh-base/cordis.patch.yml:26-31`）→ desktop 下**启用**。
3. **HMR 监听**：profile patch 文件（`profileContext.patchPath`）+ profile manifest（package.json 的 `dsh.profile.bundles`）+ home patch（`dsh-hmr/lib/index.js:830, 872-873, 1327-1328`）；recompose 由 app-boot 执行，成功 emit `app-boot/config-reload`。
4. **plugin-manager 语义**：HMR 开启时启用/安装/配置变更「apply immediately」；无 HMR 才返回 `restart-required`/`no-hmr`（`dsh-plugin-manager` README 与 `dsh-plugin-manager/lib/index.js:3125`）。
5. **实测（temp `web` profile，组合 = base + web-app，与 desktop 同机制）**：
   - 改 `profiles/pet-live/cordis.patch.yml` 中 probe 的 config → 约 1-2 秒内：probe 收到 `app-boot/config-reload` → 旧实例 `dispose`（aliveMs 12257）→ 新实例 `apply`（config.hotReloadTest=1）。`out-hmr/events.jsonl` n=14/15/16/29。
   - **运行中安装新 bundle**：另一个进程执行 `dsh plugin --profile pet-live add -w …/probe-plugin2`（自动把 bundle 追加进 `dsh.profile.bundles`）→ 运行中的 Host 立即把 probe2 apply（新 spawn pid 6754），同样 emit config-reload。`out-hmr` 后续记录。
   - **不安装、直接 patch insert 绝对路径**：在运行中的 profile patch 加 `- insert: [{id: audit-probe3, name: /tmp/…/probe-plugin3/lib/index.js}]` → 立即 apply（spawn pid 8102）。`out-hmr2/events.jsonl`。
   - **graceful 关停**：SIGTERM → 3 个实例的 disposer 都执行、子进程清空、端口关闭。
6. **边界/坑**：
   - HMR 的 profile 重组合会替换「文件在 profile 目录下发生变化」的包；对**仓库里 in-place 修改的桥源码**（不在 profile node_modules 下），HMR `root: []` 不 watch 源码，代码更新需要一次 recompose 触发（例如再编辑一次 patch，或重启 DSH）。若希望改代码即时生效，可在 profile patch 里把 hmr 配置 `root` 指向仓库路径（dev 用，不建议长期）。
   - 插件加载失败时的 HMR 策略：替换失败会停掉旧实现并报 `failed`，不影响其余插件；下次 recompose 再试（README）。所以桥插件必须**幂等、绝不抛异常**（现有实现已遵守）。
   - 桌面 profile 的 bundle 列表很长（15 个 bundle，含 experimental），recompose 比 temp web 慢一些，但机制相同。
   - **反向风险**：HMR 意味着用户运行中改 desktop profile 的插件栈会**立即**影响正在使用的窗口。激活操作要显式、可回滚、且插件必须无侵入（现有桥满足）。

### 3.7 如何激活到用户正在使用的 desktop profile（推荐方案，供后续实现；本次未执行）

> ⚠️ 审计边界：以下仅方案与已验证的等价实验，**本次没有对真实 desktop profile 做任何写操作**。

**方案 A（推荐，无需 pnpm、免重启、可回滚）：在 `~/.dsh/profiles/desktop/cordis.patch.yml` 追加一条 insert 行，name 用桥插件入口的绝对路径。**

```yaml
# ~/.dsh/profiles/desktop/cordis.patch.yml 末尾追加（示例路径按实际 checkout 调整）
- insert:
    - id: aventurine-bridge
      name: /Volumes/4TB外置盘/deepseek-harness/aventurine-pet-vrm/bridge/dsh-aventurine-bridge/lib/index.js
```

已验证的等价事实：
- 绝对路径 insert 在 temp headless profile 中实际加载成功（`out-path/events.jsonl` 有 apply + 71 条事件；`--dump-config` 显示 `name: file:///…`）。
- 运行中的 temp web profile 动态加绝对路径 insert 当场 apply（`out-hmr2`）。
- 兼容性准入会从入口文件向上找 `package.json`（`dsh-app-boot/lib/index.js:3049-3080` 的 `manifestOf`），桥包声明了 `engines.dsh: ">=0.2.2-rc.1 <0.3.0"`，当前版本通过；未来不匹配会被**禁用该行**并在 stderr 报告（不会打挂 DSH）。
- 回滚：删除该 insert 行；HMR 会 dispose 插件（并写 `offline:true` 帧），立刻恢复。
- 注意：该行持久化在 profile patch 里；DSH 升级到 0.3+ 时需先更新桥的 engines/契约。

**方案 B（发布形态，官方路径）：做成 bundle 包安装进 desktop profile。**
- 用户可用 Web 侧 Plugins 页/`plugin_manager` 工具安装，或用安装包自带 CLI（**只有 desktop 安装的 CLI 允许管理 desktop profile**）：
  `"/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh" plugin --profile desktop add -w <桥目录绝对路径>`
- 实测等价事实（temp profile，非 desktop）：`dsh plugin --profile <p> add -w <本地路径>` 会 pnpm link 安装 + **自动把 bundle 追加到 `dsh.profile.bundles`**（`dsh-plugin-manager/lib/index.js:863` 的 `reconcile`），有 HMR 的 profile 立即生效。
- desktop profile 护栏：CLI 的 **boot** 模式拒绝 `profile "desktop"`（`error: profile "desktop" is managed exclusively by the Electron application`），**plugin 子命令**在 `manageDesktopProfile:true` 时放行（`dsh-desktop-host/lib/cli.js:96-97`、`dsh/lib/bin.js:119,209-210`），但要求 desktop profile 已由桌面 app 初始化（temp home 实测错误信息：「Open DeepSeek Harness Desktop once to initialize its profile…」）。真实用户 profile 已存在，此前提满足（**但本次未对真实 profile 验证**，见未知项）。
- 风险：pnpm 写入/自动启用 bundle 会改 profile 的 package.json/lockfile；升级/回滚要更谨慎；HMR 组合失败会报错但一般不影响其它插件。

**方案 C（分发/远程）：插件市场/agent 工具安装** —— 需要把包发到 registry 或用户手动放包；本任务不需要。桥代码在仓库里，A/B 更现实。

---

## 4. DSH 进程/实例生命周期与「桌宠 ⇄ DSH」互拉

### 4.1 本机真实进程树（只读实测，2026-11-11 02:06）

```
pid 18926  /Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness          ← Electron 主进程（ppid 1）
 ├ 18929  DeepSeek Harness Helper --type=gpu-process
 ├ 18930  DeepSeek Harness Helper --type=utility --utility-sub-type=network.mojom.NetworkService
 ├ 18936  DeepSeek Harness Helper (Renderer) --type=renderer
 └ 18937  /Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness --expose-internals \
          .../app.asar/dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/index.js <runtimeDir> <projectDir> …   ← DSH Host（插件/agent/web 都在这）
```

- Host 监听 `127.0.0.1:38765`（真实 profile patch 把 webserver port 固定为 38765；默认 desktop 启动参数是 `--port 0`，见 `dsh-desktop-host/lib/index.js:441-455`，真实 profile 的 `cordis.patch.yml` 有 webserver override）。
- **插件运行在 Host 子进程里**（申请/命令的 `ELECTRON_RUN_AS_NODE` 模式），Electron 主进程只负责窗口/更新/单实例/生命周期。
- bundle id 实测：`com.deepseek.dsh`（`Info.plist`；package.json `dshDesktopAppId` 同为 `com.deepseek.dsh`）；版本 `0.2.2-rc.1`；`LSUIElement` 未设置（普通前台 app，有 Dock 图标）。
- 真实 `profiles/desktop/lock` 当前**不存在**：该 lock 只在 Electron 做 profile 初始化/恢复/插件禁用等操作时短暂存在（`app.asar/lib/main.js:5580-5620`，内容是 pid），**不是「实例正在运行」锁**，不能用来判断 DSH 是否在线。

### 4.2 单实例与启动方式

- Electron 主进程启动第一步就 `requestSingleInstanceLock()`，拿不到锁就 `app.quit()`；已有实例收到 `second-instance` 后聚焦/恢复主窗口（`app.asar/lib/main.js:15227-15232`、`21260-21280` 的 `focusPrimaryWindow`）。
- 因此 `open -a "DeepSeek Harness"` 或 `open -b com.deepseek.dsh` 是**安全**的「确保在/前台」手段：DSH 已在跑就只是聚焦；没跑就正常启动（会重新初始化 Host，插件随组合 apply）。
- 真实 DSH 启动时：读 `~/.dsh` → `profiles/desktop` → 启动 Host 子进程 → Host bind web 端口 → Electron 打开窗口指向带 token 的 URL。**不要**用 `--args --profile …` 之类参数去「拉起」桌面版，它的 profile 固定是 desktop（CLI 已显式拒绝 boot desktop profile）。

### 4.3 CLI vs 桌面 app 的区别（重要）

| 维度 | 桌面 app（`open -a`） | 安装包内置 CLI（`.../runtime/cli/bin/dsh`） |
|---|---|---|
| 形态 | Electron GUI + Host 子进程 | Electron 二进制以 `ELECTRON_RUN_AS_NODE=1` 跑 `dsh-desktop-host/lib/cli.js`（纯 Node 进程，无窗口） |
| profile | 固定 `profiles/desktop`，用 `runProfile`+`profileContext`（HMR 开） | 任意 profile：`--profile <name>`；`headless`/`web`/`acp`/`sdk` 模板；HMR 仅在 profileContext 提供时开（`dsh --profile web` 也有 profileContext，因此 web 也有 HMR） |
| 与桌宠关系 | 用户正在用的实例；**检测/拉起的目标** | 用于隔离实验/插件安装；不要用它「假装」桌面版 |
| `--profile desktop` | 正常启动 | **拒绝**（boot 模式） |
| `plugin --profile desktop` | — | 允许（`manageDesktopProfile:true`），要求 profile 已初始化 |
| 环境变量 | Electron 启动环境（登录 shell 补环境，`readDesktopLoginShellEnvironment`） | 继承调用者环境 + `DSH_HOME` 等 |

### 4.4 桌宠侧检测/拉起 DSH 的可靠方案（推荐）

**检测（优先级从高到低）：**
1. **桥心跳**：`~/.dsh/aventurine-pet/status.json`：`online = !offline && now>=ts && now-ts<30000`（现有契约 `BRIDGE_ONLINE_TTL_MS=30s`，cron 5s；`src/shared/bridge-schema.ts:271-292`）。这是**语义最准**的（插件没装/DSH 没跑都会离线），并且不受进程名/端口变化影响；限制是插件必须先安装。
2. **进程扫描**（插件未装时兜底）：`pgrep -f 'dsh-desktop-host/lib/index.js'` 命中 Host；`pgrep -f '/Contents/MacOS/DeepSeek Harness$'`（或 `pgrep -x` 不可靠，ps comm 会被截断）；排除 `Helper` 进程。`ps -axo pid,ppid,args` 校验 parent 关系。
3. **端口**：`lsof -nP -iTCP:<port> -sTCP:LISTEN`；端口可能被用户改（真实 profile 是 38765，但默认是随机 `--port 0`），不要硬编码；可解析 GUI URL（`DSH_WEB_URL` 只在 CLI/host 环境里有；桌宠侧拿不到）。
4. **bundle id**：`lsappinfo`/NSWorkspace/AppleScript 查询 `com.deepseek.dsh`；适合判断「app 是否在跑」，但无法判断 Host 是否健康（Host 崩溃时 app 可能在重启/报错）。
5. **profile lock**：**不要**用作运行检测（见 §4.1）。

**拉起：**
- 直接 `open -a "DeepSeek Harness"`（或 `execFile('open', ['-b','com.deepseek.dsh'])`），然后轮询 1 的 status.json/heartbeat（首次启动到 Host ready 一般数秒；超时 ~30-60s 判失败并提示用户）。**不要**在此流程里杀进程/重启。
- 若确定「用户没装桥插件」而需要检测，进程扫描 + 端口可作为过渡。
- 注意：Electron app 已有实例但 Host 坏掉（fatal/崩溃）时，`open -a` 可能只聚焦坏窗口；可靠做法是提示用户重启 app（产品决策），桌宠侧不要主动 kill。

### 4.5 autostart / 登录项

- 在 Electron shell 源码里**没有** `setLoginItemSettings`/`openAtLogin`/`launchAtLogin` 相关调用（`grep` `app.asar/lib/main.js` 无命中）。
- 本机 `~/Library/LaunchAgents` 里没有 DeepSeek/DSH 相关 plist；`app-update.yml` 只用于更新。
- `sfltool dumpbtm`（系统登录项数据库）查询**超时未完成**（已终止），因此「用户是否手动把 DSH 加进登录项」**未核实**；只能确认 DSH 自身安装/代码没有设置登录项。
- 结论：**0.2.2-rc.1 桌面版没有内置开机自启/登录项设置**（至少 macOS 代码层面）。桌宠若要「DSH 开机即起」，需用户自行在系统设置里加登录项，或桌宠侧在启动时 `open -a`（注意不要与用户预期冲突，建议做成可配置且默认关闭/询问）。

---

## 5. 会话/消息落盘位置与格式（无插件兜底数据源评估）

### 5.1 真实布局（只读观察）

```
$DSH_HOME/sessions/--<cwd-escaped>--/<session-dir>/
   session.v4.jsonl.zstd      # 当前格式 v4，默认 zstd 压缩（每 session 一个）
   session.lock               # 会话级锁
```
- 真实样例：`/Volumes/4TB外置盘/dsh-appdata/sessions/--Volumes-4TB~…-aventurine-pet--/<session-id>/session.v4.jsonl.zstd`。
- 每个事件一行逻辑记录，物理上是 zstd 帧（可配置 `compression: 'none'` 输出纯 JSONL；默认 `'zstd'`）。写侧按批 append + `fsync`，崩溃尾帧可恢复（`dsh-session-persistence-jsonl` README「On-disk layout」「Durability」）。
- 会话 id 与 cwd 都做过路径转义；`session.lock`、`.plugin-manager/`、`logs/` 等同级目录存在。

### 5.2 作为兜底数据源的评估

| 维度 | 结论 |
|---|---|
| 可行性 | 技术上可行：格式公开（`dsh-session-format*` 有 v0→v4 迁移读者）；Node 24 有 zstd 解压能力，但需要处理「帧边界/撕裂尾/批内多行」。 |
| 实时性 | **差**：批写 + fsync + 压缩帧，tail 需要自己解帧；且会话可能长期不落盘（未 materialize/flush 前内存态）。 |
| 可靠性 | 中：v4 格式可能随 DSH 升级变化（已有 v0-v4 迁移机制说明格式会变）；多实例写同一 `$DSH_HOME` 时会话目录不冲突但读取语义复杂。 |
| 风险 | 需要用户目录读权限（桌宠本来就有）；但绕过 DSH 契约读取内部格式，**升级即可能坏**，且可能读到不该展示的系统/用户消息。 |
| 结论 | **只作为「桥插件未安装」时的临时降级（可选）**，不要当主数据源；主源用插件事件（durable + live），必要时由桥插件把「最近一条 assistant text / 会话列表」写进更简单的小文件。 |

---

## 6. 现有桥插件评估与 v2 推荐方案

### 6.1 现有实现（`bridge/dsh-aventurine-bridge/lib/index.js`）实测正确性

- 事件映射**已验证与 0.2.2-rc.1 真实形状一致**：`agent/status` running/idle → task/start/task/end；`agent/error` → task/error；`turn/end(reason.kind='error')` 去重 → task/error；`assistant/message`/`tool/result` → `session/event`（只带标量）；`agent/disposed` 补 task/end。实测序/字段都对得上（§2.6、§2.7）。
- **缺口（本任务的直接结论）**：
  1. `NOTABLE_SESSION_EVENTS` 只透传类型/seq/turn/step/reasonKind（`lib/index.js:92, 569-591`），**没有 assistant 文本**；
  2. 没有 `agent/assistant-stream` 订阅（`lib/index.js:632-637` 只有 5 个订阅）→ 拿不到实时 text/reasoning 增量与「思考中」信号；
  3. 没有 `tool/call`（只有 tool/result）→ 工具开始阶段不可见；
  4. 没有 `step/start|end`、没有「turn 最终文本」汇总事件；
  5. `session/event` payload 里 `reasonKind` 只在 data.reason 存在时才有（turn/end），task/end 只有 status（可接受）。
- 现有契约是冻结的（`src/shared/bridge-schema.ts`、`lib/constants.js`），扩展需同步多文件 + parity 测试 + 下游 `src/renderer/reactions/dsh.ts`/`desktop/dsh-watch.ts` 消费。

### 6.2 推荐 v2 事件契约（在现有白名单上追加；向后兼容）

建议新增 `DshEventType`（写入方：桥插件；读取方：桌宠 B7）：

| 新 type | 触发 | payload（含上限） |
|---|---|---|
| `assistant/text` | 每个 `session/event` 的 `assistant/message` | `{agent, sessionId, turn, step, seq, text, textChars, truncated, hasToolCalls, interrupted?}`；text = text 块拼接（建议 ≤8KB 截断，`truncated` 标记；**不含 reasoning**） |
| `reasoning/start` | `agent/assistant-stream` frame start 或首个 reasoning-delta；按 `agent+turn+step+attemptId` 去重 | `{agent, sessionId, turn, step}` |
| `reasoning/end` | 该 attempt 收到首个 text-delta/tool-call-delta/finish/end；与 start 配对 | `{agent, sessionId, turn, step, chars, preview?}`（preview 可选、≤500 字符，默认不带以减小隐私面） |
| `step/start` / `step/end` | durable `step/start`/`step/end` | `{agent, sessionId, turn, step}` |
| `tool/call` | durable `tool/call` | `{agent, sessionId, turn, step, name}`（**不带 arguments**，隐私/体积） |
| `turn/final` | durable `turn/end` 且 reason.kind='completed'，并已有本 turn 最后一条非空 assistant text | `{agent, sessionId, turn, text, textChars, truncated}`；error/aborted 不写 final |
| （可选）`assistant/delta` | 实时 text-delta 合并（建议 150-250ms 合并一帧、≤2KB/行；**不写每个 token**） | `{agent, sessionId, turn, step, text, fullTextChars}` |

保持现有 `task/start|end|error`、`session/event` 类型不变；`session/event` 的 payload 可加 `textChars` 等标量，但建议把正文放到新 type，避免旧读取方误读/64KB 行被丢。

### 6.3 提取算法（可直接落到桥插件）

```js
// 状态：sessionId -> { turn, lastText }
const turnState = new Map()

function onSessionEvent(session, event) {
  const sid = session.id
  switch (event.type) {
    case 'turn/start':
      turnState.set(sid, { turn: event.data.turn, lastText: '' })
      emit('task/start', { agent: sid, turn: event.data.turn })   // 也可继续用 agent/status
      break
    case 'step/start':
      emit('step/start', { agent: sid, sessionId: sid, turn: event.data.turn, step: event.data.step })
      break
    case 'tool/call':
      emit('tool/call', { agent: sid, sessionId: sid, turn: event.data.turn, step: event.data.step, name: event.data.name })
      break
    case 'assistant/message': {
      const blocks = event.data.message.content
      const text = blocks.filter(b => b.type === 'text').map(b => b.text).join('')
      const hasToolCalls = blocks.some(b => b.type === 'tool-call')
      const st = turnState.get(sid)
      if (text.trim() !== '') {
        st.lastText = text
        emit('assistant/text', { agent: sid, sessionId: sid, turn: event.data.turn, step: event.data.step,
          seq: event.seq, text: cap(text, 8192), textChars: text.length,
          truncated: text.length > 8192, hasToolCalls, interrupted: event.data.interrupted === true })
      }
      break
    }
    case 'step/end':
      emit('step/end', { agent: sid, sessionId: sid, turn: event.data.turn, step: event.data.step })
      break
    case 'turn/end': {
      const st = turnState.get(sid)
      if (event.data.reason?.kind === 'completed' && st?.lastText) {
        emit('turn/final', { agent: sid, sessionId: sid, turn: event.data.turn, text: cap(st.lastText, 8192),
          textChars: st.lastText.length, truncated: st.lastText.length > 8192 })
      }
      turnState.delete(sid)
      break
    }
  }
}

// 思考相位：只关心主 agent（可选过滤 subagent）
let thinking = new Map()  // agentId -> {turn,step,attempt}
function onAssistantStream({ agent, frame }) {
  const sid = agent.session.id
  if (frame.type === 'start') { emit('reasoning/start', { ... }); thinking.set(...) }
  else if (frame.type === 'chunk') {
    const c = frame.chunk
    if (c.type === 'reasoning-delta' && c.text) { if (!thinking.has(sid)) emit('reasoning/start', {...}) }
    else if (c.type === 'text-delta' || c.type === 'tool-call-delta' || c.type === 'finish') closeThinking(sid)
  } else if (frame.type === 'end') closeThinking(sid)
}
```

关键工程点：
- **过滤**：只关心 `agent.session.header.origin !== 'subagent'`（或用户当前前台会话；桌面里有多个会话/子代理，桥要避免把 subagent 的文本混进桌宠气泡）。可用 `agent.session.id` 与桌宠侧选中的会话对齐；桥可写 `sessionId` 让桌宠过滤。
- **去重/顺序**：`agent/error` 与 `turn/end(error)` 同 turn 去重（现有逻辑）；失败重试的 stream start/end 多组，reasoning/start/end 去抖。
- **失败**：`reason.kind='error'` → 沿用 `task/error`；`aborted` → 建议 `task/end {reason:'aborted'}`；`max-tokens` → `task/end {reason:'max-tokens'}` 且 assistant text 可能不完整。
- **隐私**：绝对不要把 `user/message`、`system/message`、`request/header`、`tool arguments` 写出去；assistant text 是模型输出，可以展示（但建议截断、并且 UI 端作为纯文本渲染，不解析指令）。reasoning 默认不落正文，只报相位与长度。
- **体积**：`assistant/text` 单行 64KB 上限可能被长回答撑爆 → cap 8KB + `truncated`；`turn/final` 同理；实时 delta 必须合并，禁止 per-token 追加文件（会打爆 events.jsonl 5MB 轮转与磁盘 IO）。
- **现有冻结契约升级**：`src/shared/bridge-schema.ts`（`DSH_EVENT_TYPES`、`DSH_EVENT_PAYLOAD_KEYS`、`sanitizeDshEventPayload`、`parseDshEventLine`、`DshEventPayloadKey`）、`src/shared/types.ts`、`bridge/.../lib/constants.js`（白名单副本）、`tests/bridge-plugin.test.ts`（parity）、`scripts/dsh-canary-lib.mjs`（validator）需同步；新 payload 键建议：`text`/`textChars`/`truncated`/`hasToolCalls`/`interrupted`/`step`/`name`。
- **canary 扩展**：现有 `scripts/dsh-canary.mjs` 只跑离线**失败**回合（`/error/` 断言）。建议加「离线 mock 成功回合」：把本次的 `/tmp/dsh-audit-run/mock-llm.mjs` 模式（Anthropic Messages SSE：`message_start`→content blocks→`message_delta`→`message_stop`；main 请求带 tools，标题请求不带 tools）产品化进 `scripts/`，canary 断言 `assistant/text` 至少出现一次、文本与 mock 注入的文本一致、`turn/final` 与最后一条 `assistant/text` 一致、reasoning start/end 配对。这样「DSH 升级后还能不能拿到文本」也可自动化回归（这是本任务最有价值的后续动作之一）。

### 6.4 现有桥的 runtime 降级/L1 备选（若最终决定不做 v2 插件）

- 从 `agent/assistant-stream` 的 `text-delta` 直接拼文本（实时，但需要插件；若无插件则完全拿不到）。
- 从 `$DSH_HOME/sessions/.../session.v4.jsonl.zstd` 事后读取（见 §5，不实时、格式风险）。
- 通过 DSH Web API（`/api/...`，需要 token/登录）——桌面窗口 URL 带 token，桌宠侧拿不到；不推荐。
- 因此：**插件是唯一可靠实时源**；无插件兜底只适合「历史回顾/失败恢复」。

---

## 7. 未来 UI/接口预留（窥屏互动 UI）

- **Host 侧自定义 HTTP 路由**：插件 `export const inject = ['webServer']` 后可用 `ctx.webServer.register(route)` / `registerUpgrade`（WebSocket）/ `registerFallback`（`dsh-host-webserver` README「Registering routes」「The fallback seat」；实现 `dsh-host-webserver/lib/index.js`，导出 `WebServer` at :663）。路由可返回 SSE/JSON；`compression` 不会压缩 SSE。**安全注意**：普通自定义 route 不自动经过 DSH API 网关鉴权，desktop webserver 绑在 127.0.0.1，但仍应自带 token/Origin 校验（`peer`/cookie 机制见 README「Registering routes」；`authenticatedUrl`/`connection` 服务见 desktop host 用法）。
- **客户端（浏览器）插件/面板**：包声明 `dsh.client`（`platform:'web'`）+ 导出 `./client` bundle，Host 的 `dsh-client-modules` 会把它作为可加载模块服务（`/plugins`），页面内 `dsh-client-hmr` 支持启用/禁用/重建的热更新，无需刷新页面（`dsh-client-modules` README「Declaring a client plugin」「Live plugin composition」；`dsh-client-hmr` README）。适合将来做「DSH 内嵌的桌宠状态面板/设置页」，但需要 tsdown 构建与客户端 bundle，工作量比 host-only 大。
- **桌宠自己**：当前文件桥（status.json + events.jsonl）足够；若未来要低延迟/双向（桌宠回传点击到 DSH），可考虑 host 插件开一个**仅 loopback 的 HTTP/WS 路由**（同样要注意鉴权），或双向文件协议。**不**建议直接从桌宠进程注入 DSH 进程。

---

## 8. 官方/内置桌宠类插件调查

- 0.2.2-rc.1 asar 内 `@deepseek-ai/*` 共 332 个包；包名 grep `pet|avatar|mascot|character|live2d|vrm|companion` **无命中**（唯一含 desktop 的是 `dsh-desktop-host`）。
- 官方安装本身带的 bundle：`@deepseek-ai/dsh-base`、`dsh-web-app`、`dsh-headless`、`dsh-acp-app`、`dsh-sdk-app`、`dsh-sdk-minimal`，以及可选/实验 bundle（agent-team、voice-input、plugin-market、auto-review、inspector、worktree、session-search、session-titles、ralph、forge、personalized-recommendations 等，`dsh-official-bundles/lib/index.js:4-70`）。
- on-demand 官方包：`@deepseek-ai/dsh-subagent-claude-code`、`dsh-subagent-codex`、`dsh-cua-bundle`（都不是 pet；cua 是 computer-use）。
- 结论：**没有可直接参考的官方桌宠插件**；最接近可借用的官方代码是：
  - `dsh-headless/lib/index.js:114-197`（从 durable log 取最后 assistant text、从 `agent/assistant-stream` 投影 reasoning 到 stderr）——提取逻辑的权威范本；
  - `dsh-api-session-controller/lib/types/history/assistant-stream.js` + `lib/types/assistant-stream.js`（Web 端如何把 start/chunk/end 帧折叠为可断线恢复的流基线）；
  - 现有 `dsh-aventurine-bridge` 是仓库自己的实现，继续作为基座。

---

## 9. 升级/兼容风险与 canary 能覆盖/不能覆盖的

### 风险

1. **契约漂移**：`assistant/message`/`agent/assistant-stream` 是 0.2.2-rc.1 的真实形状，但 DSH 内部演进快（session format 已 v0→v4）。桥必须只依赖事件名/字段的子集并宽容未知块类型；`engines.dsh` 只是安装闸门，不是契约保证。
2. **`engines.dsh` 不匹配**：未来 DSH 0.3.x 会拒绝安装/在组合时禁用桥行（不是崩溃）。需要升级桥 + 重新准入；canary 能提前发现（安装被拒/组合缺行）。
3. **HMR 即时性依赖 profile 配置**：用户若在 patch 里 `- id: hmr disabled: true`，安装/改配置就变回「重启生效」。桥的激活文档要提示检查 HMR 是否开启（`dsh --profile desktop --dump-config` 在桌面 profile 被拒，但可从运行中 UI/日志/进程推断；或直接看 profile patch 无 hmr disable）。
4. **插件异常不能打挂 DSH**：HMR 替换失败会停旧实现；apply 抛错会让该行失败（可选行只警告）。桥必须继续「任何 fs/事件异常只 warn」，并保证 disposer 幂等。
5. **多实例/多 profile 写同一桥目录**：现状是单写者假设（`status.json` last-writer-wins）。若用户同时跑 `dsh web` 且装了桥，会互相覆盖。建议 v2 在 status.json 加 `instanceId/profile`，或桥目录按 profile 分目录。
6. **隐私**：session/event 能拿到用户输入/系统提示（实测），桥必须白名单只写 assistant 输出；reasoning 正文默认不落盘。
7. **体积/性能**：per-token 写文件不可行；必须合并/截断；events.jsonl 5MB 轮转可接受，但高频事件会加速轮转并丢可见历史（桌宠需要按行号/游标读取）。
8. **崩溃**：SIGKILL/崩溃不会执行 disposer，`offline` 帧可能不写；消费方必须靠 30s TTL 兜底（现有契约已如此）。
9. **激活方式的风险**：改 desktop profile patch 会持久化；写错 YAML 会让 profile 启动失败（用户下次启动 DSH 失败）——激活脚本必须做 YAML 校验/备份（app-boot 对 profile patch 解析失败会 fail startup）。方案 B 的 pnpm 安装会改 lockfile/package.json，需可回滚。
10. **未知/未验证**：
    - 未在**真实 desktop profile + 真实用户会话**上验证插件（安全红线），只验证了同 Host 代码路径的 temp profile；
    - 未用真实 DeepSeek 云端凭据跑成功回合（无 key、禁止读凭据），成功回合用本地 mock Messages 服务验证；真实 provider 的 thinking signature、tool_calls、max-tokens 等具体块仍由适配器归一，理论上一致，但未实测；
    - `aborted`/`blocked`/`max-tokens`/`interrupted` 的文本/事件组合未实测；
    - subagent/agent-team 的文本归属与过滤策略未实测（只从字段/代码推断）；
    - HMR 在真实 desktop（15 bundle 组合）下的 recompose 行为未实测；桌面 app 的插件管理 UI 安装本地路径包的流程未实测；
    - DSH 0.2.2-rc.1 之后的版本契约未验证。
11. **canary 能覆盖**：安装/engines 护栏、bundle patch 组合、失败回合事件序列、桥产物格式/心跳/离线帧、隔离性。**不能覆盖**：成功回合文本（当前 canary 只有失败回合）、真实云端 provider 差异、HMR/桌面 UI 行为、subagent 过滤、未来版本格式迁移。→ 建议按 §6.3 扩展 offline mock 成功回合断言。

---

## 附录 A：实验原始产物与复现

**产物（全部在 `/tmp`，不在仓库）：**

| 路径 | 内容 |
|---|---|
| `/tmp/dsh-asar-audit/extract/` | app.asar 解包（`dsh/`、`lib/`、`renderer/`、`package.json`；153MB） |
| `/tmp/dsh-asar-audit/header.json`、`files.json` | asar 目录树/文件偏移清单（22,105 项） |
| `/tmp/dsh-asar-audit/asar-read.mjs` / `asar-list.mjs` / `asar-extract.mjs` | 自写解析/抽取脚本 |
| `/tmp/dsh-audit-home-B9VjGQ/` | 临时 DSH_HOME（profiles: pet-audit/pet-live/pet-path） |
| `/tmp/dsh-audit-run/probe-plugin*/` | 探针插件（订阅所有相关事件、记录 capabilities/lifecycle、spawn 测试） |
| `/tmp/dsh-audit-run/mock-llm.mjs` | 离线 Anthropic Messages mock（SSE），支持 thinking/text/tool_use |
| `/tmp/dsh-audit-run/mock-requests.jsonl` | mock 收到的 4 个请求（主回合×2 + 标题×1 + tool_result 后续×1） |
| `/tmp/dsh-audit-run/out-ok/events.jsonl` | ★ 成功回合 75 条原始事件（assistant/message 全文） |
| `/tmp/dsh-audit-run/out-fail/events.jsonl` | 失败回合 71 条（agent/error、turn/end error、重试） |
| `/tmp/dsh-audit-run/out-path/events.jsonl` | headless 临时 profile 用**绝对路径 patch insert**（不经 pnpm）加载成功的证据 |
| `/tmp/dsh-audit-run/out-hmr/events.jsonl` | HMR：改 patch config 触发 dispose+apply；运行中安装新 bundle 生效；SIGTERM 全 dispose |
| `/tmp/dsh-audit-run/out-hmr2/events.jsonl` | 运行中 patch insert 绝对路径插件当场生效 |
| `/tmp/dsh-audit-run/{ok-turn,fail-turn,web,web2}.log`、`install*.log`、`boot-desktop.log` | CLI 输出/守卫证据 |
| `/tmp/dsh-audit-run/pet-audit-default.yml`、`pet-live-default.yml`、`pet-path-dump.yml` | `--dump-config` 组合树 |

**复现命令（安全隔离，必须在 `/tmp`）：**

```bash
CLI='/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh'
T=$(mktemp -d /tmp/dsh-home-XXXX)
# 1) 隔离 headless profile
env DSH_HOME="$T" "$CLI" --profile pet-audit --from-default-profile headless --dump-config
# 2) 本地路径安装探针（会写临时 profile 的 package.json，自动启用 bundle）
env DSH_HOME="$T" "$CLI" plugin --profile pet-audit add -w /tmp/dsh-audit-run/probe-plugin
# 3) 离线失败回合（关闭端口 + 占位 key；无外网/费用）
env DSH_HOME="$T" AUDIT_PROBE_DIR=/tmp/out1 DEEPSEEK_API_KEY=x \
    DEEPSEEK_BASE_URL=http://127.0.0.1:9471 "$CLI" --profile pet-audit 'audit task'
# 4) 成功回合：先起本地 mock Messages 服务（打印 MOCK_LLM_PORT），再：
node /tmp/dsh-audit-run/mock-llm.mjs &
env DSH_HOME="$T" AUDIT_PROBE_DIR=/tmp/out2 DEEPSEEK_API_KEY=x \
    DEEPSEEK_BASE_URL=http://127.0.0.1:<MOCK_LLM_PORT> "$CLI" --profile pet-audit 'audit task'
# 5) HMR 验证（web 模板 = desktop 同 base/web-app 机制）：
env DSH_HOME="$T" "$CLI" --profile pet-live --from-default-profile web --dump-config
env DSH_HOME="$T" "$CLI" plugin --profile pet-live add -w /tmp/dsh-audit-run/probe-plugin
env DSH_HOME="$T" AUDIT_PROBE_DIR=/tmp/out3 "$CLI" --profile pet-live --no-open --host 127.0.0.1 --port 41871 &
#   → 编辑 $T/profiles/pet-live/cordis.patch.yml 改 probe config / insert 绝对路径行；观察 apply/dispose
#   → kill -TERM <pid>，确认 disposer 执行、子进程清理
```
（mock 服务协议关键：`POST /v1/messages` 返回 `text/event-stream`，事件 `message_start`→`content_block_start`→`content_block_delta{text_delta|thinking_delta|input_json_delta}`→`content_block_stop`→`message_delta{stop_reason}`→`message_stop`；主请求带 `tools` 时返回 tool_use，标题请求不带 tools 返回纯文本。DSH 对 `DEEPSEEK_BASE_URL` 指向非官方 endpoint 时不会请求 `/models`。）

---

## 附录 B：0.2.2-rc.1 durable 事件类型全表（62 个）

来自 `app.asar/dsh/node_modules/@deepseek-ai/dsh-session/lib/types/known-event-types.js:20-84`（`KNOWN_SESSION_EVENT_TYPES`，用于持久化读路径的完备性判定；不在表内的插件事件需带 `ignorable` 标记）：

```
agent-preset/selected  agent/inbox/spliced  approval/asked  approval/decided  approval/policy
assistant/attempt  assistant/message  command/done  command/run  compaction/end
compaction/prune  compaction/start  compaction/summary  deliverables/presented
developer/message  feedback/message-delete  feedback/message-put  feedback/record
goal/change  hook/invoked  hook/result  image/offload  job/registered  job/settled
llm/retry  llm/retry-started  model/selection  permission/preset  plan/mode
request/context  request/header  sandbox/mode  schedule/change
session-log-deepseek/delivery-accepted  session/end-seed  session/title
session/title-llm-request  step/end  step/start  subagent/catalog  subagent/descriptor
subagent/model-selection-policy  system/message  team/member  team/message/delivered
team/message/queued  team/task  todo/write  tool-workflow/agent-end  tool-workflow/agent-start
tool-workflow/run-end  tool-workflow/run-start  tool/call  tool/ptc-dispatch
tool/ptc-dispatch-start  tool/result  turn/end  turn/start  user/message
web/deepseek-search-llm-request  working-directory/change  workspace/changes
```

---

## 附录 C：关键源码行号索引（asar 内路径）

| 事实 | 引用 |
|---|---|
| `agent/status` 只在状态变化时 emit | `dsh-agent-loop/lib/index.js:554-562` |
| `agent/error` payload | `dsh-agent-loop/lib/index.js:636-648` |
| turn/start、step/start、tool/result(恢复)、step/end、turn/end reason | `dsh-agent-loop/lib/index.js:731-822`（reason: 747/753/803-815） |
| `agent/assistant-stream` 发射点 | `dsh-agent-loop/lib/index.js:873` |
| Attempt 帧（start/push/settle/abandon、compact stream） | `dsh-agent-loop/lib/index.js:354-470` |
| `assistant/message` append（正常/中断） | `dsh-agent-loop/lib/index.js:891-900, 941-955` |
| `assistant/attempt` append（失败 settlement） | `dsh-agent-loop/lib/index.js:906-930` |
| `createAssistantMessage` | `dsh-llm/lib/index.js:70-84` |
| BlockAssembler（text/reasoning/tool-call 组装） | `dsh-llm/lib/index.js:954-1130` |
| 实时流 chunk 类型/可见性 | `dsh-llm/lib/index.js:1310-1500` |
| compact 回放流/expand | `dsh-llm/lib/index.js:1150-1300` |
| Anthropic Messages SSE 翻译（thinking→reasoning） | `dsh-llm-deepseek/lib/index.js:1780-2035` |
| session append/envelope/commit/session-event 派发 | `dsh-session/lib/index.js:1524-1546, 1556-1605`；事件类型表 `lib/types/known-event-types.js:20-84` |
| 官方 headless 提取最终文本/投影 reasoning | `dsh-headless/lib/index.js:114-139, 141-197, 340-381` |
| `agent/created`/`agent/disposed`/source 文档 | `dsh-agent/lib/index.js:600-624, 681-720`；`lib/types/dispatch.js:31-84` |
| API 层全局订阅 assistant-stream | `dsh-api-session-controller/lib/types/history/assistant-stream.js:5-27` |
| desktop Host 启动/关停 | `dsh-desktop-host/lib/index.js:426-487, 584-600`；CLI 入口 `lib/cli.js:96-97` |
| Electron 单实例/窗口/退出/Host spawn | `app.asar/lib/main.js:15227-15232, 9976-10010, 20222, 20632, 21314+`；desktop 路径/lock `:1783-1787, 5580-5620` |
| profileContext 提供 + HMR 启用 | `dsh/lib/profile-boot-e2mS45fC.js:291-305`；`dsh-base/cordis.patch.yml:26-31` |
| HMR 监听/重组合 | `dsh-hmr/lib/index.js:830, 872-873, 1327-1328` |
| 插件兼容性准入（engines.dsh） | `dsh-app-boot/lib/index.js:1070-1130, 3120-3183`；patch insert 路径→file URL `:4718-4727` |
| CLI desktop profile 护栏 / plugin 放行 | `dsh/lib/bin.js:35-39, 101-120, 209-210`；`dsh-desktop-host/lib/cli.js:96-97`；`dsh/lib/plugin-DscIHF4k.js:14-17, 62-98` |
| 会话落盘格式/durability | `dsh-session-persistence-jsonl/README.md`（On-disk layout/Durability）；真实文件 `$DSH_HOME/sessions/--<cwd>--/<id>/session.v4.jsonl.zstd` |
| Web 自定义路由/客户端插件 | `dsh-host-webserver/README.md`（Registering routes）；`dsh-client-modules/README.md`（Declaring a client plugin/Live composition）；`dsh-client-hmr/README.md` |
| 官方 bundle 清单 | `dsh-official-bundles/lib/index.js:4-70` |
