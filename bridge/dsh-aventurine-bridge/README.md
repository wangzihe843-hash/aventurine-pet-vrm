# dsh-aventurine-bridge

「砂金·戏浪」桌面宠物的 **DSH（DeepSeek Harness）host-only 文件桥插件**。它只订阅 DSH 事件，
把 agent 运行状态与任务事件写成桌宠 app 可从固定路径读取的文件；不注册工具、不改宿主行为。

数据流：`DSH 进程（本插件）` → 文件 → `aventurine-pet 主进程（B7 dsh-watch）`。
文件契约的冻结实现与校验函数在仓库的 `src/shared/bridge-schema.ts`；本包内的
`lib/constants.js` 是契约常量的副本，一致性由 `tests/bridge-plugin.test.ts` 的 parity 用例守护。

Wave 3（v2，加法式，向后兼容）新增：`assistant/message` 的 `payload.text`（气泡同步的
assistant 输出文本）、`control.json` 生命周期控制帧、`launchPet` 配置（apply 时拉起桌宠一次）。

Wave 4（`BRIDGE_PLUGIN_VERSION = 4`，2026-11-11 兼容性安全 v2，加法式）新增：
**运行时兼容自述 `compat`**（`control.json` 与 `status.json` 的每一帧都带
`{ bridgeVersion, controlSchema, dshRange }`，`dshRange` 运行时读本包 `package.json.engines.dsh`）、
**`apply` 失败隔离**（启动失败只写 `bridge-error.json` 诊断 + 返回 no-op disposer，绝不把异常
抛给宿主）、以及**「禁止异步孤儿抛错」的显式维护规则**。升级/排障见
[`docs/pet-dsh-coupling-runbook.md`](../../docs/pet-dsh-coupling-runbook.md)。

> v4 与 v3 的兼容关系：v4 是**加法式**契约（旧桌宠忽略未知键仍可工作）；而新桌宠支持
> `BRIDGE_PLUGIN_MIN_SUPPORTED = 3` —— 现网 v3 桥（无 `compat`）由桌宠用 legacy 范围
> `>=0.2.2-rc.1 <0.3.0` 回退判定，不强制先升级桥。

> ⚠️ **只允许安装到独立 profile（`pet-bridge-test`）。禁止装进正在使用的 profile**
> （会重启当前 DSH、影响其他并行窗口，并可能改变当前工作流的插件栈）。
> 本仓库的开发与单测**不需要安装**本插件；安装验收由 Lead 在独立 profile 收口。

## 目录结构

```
bridge/dsh-aventurine-bridge/
├── package.json        # host-only bundle：type:module、main、exports、dsh.bundle.patch
├── cordis.patch.yml    # bundle patch：insert { id: aventurine-bridge, name: dsh-aventurine-bridge }
├── lib/
│   ├── index.js        # 入口：export const name / apply(ctx, config) / createEventLog / createPetLauncher
│   └── constants.js    # 契约常量副本（parity test 对齐 src/shared/bridge-schema.ts）
├── locale/{en,zh}.json # 插件管理页展示元数据（meta.title / meta.description）
├── icon.svg            # 自绘图标（≤256KiB，原创简单图形）
└── README.md
```

## 生命周期：`apply` 必须是箭头函数

```js
export const name = 'dsh-aventurine-bridge'
export const apply = (ctx, config = {}) => {
  // …订阅事件、写心跳…
  return function dispose() { /* 停心跳 + 退订 + 写 offline:true 帧 */ }
}
```

**`apply` 必须是箭头函数（不可构造）**：cordis 4.x 用 `isConstructor(func) = !!func.prototype`
判定插件形态；普通 `function apply` 有 `.prototype`，会被 `new apply(ctx, config)` 调用，
其返回的 disposer 会被当作「构造器返回值」丢弃（cordis 只认 `instance[symbols.init]`）——
结果是心跳 interval 永不清除、`offline: true` 永不写入。箭头函数没有 `prototype`，
disposer 才会被 cordis 收集为 fiber effect。回归断言见 `tests/bridge-plugin.test.ts`。

## 写入契约（`~/.dsh/aventurine-pet/`）

### `status.json` —— 覆盖写的心跳

默认每 **5s** 覆盖写一次。为保证消费方不会读到半截文件，写入方式是**同目录原子替换**：
先写本次写入专用的临时文件 `.status.json.<pid>.<instance>.<seq>.tmp`，再 `renameSync` 到
`status.json`（临时文件名按进程 + 进程内实例 + 写序号唯一，同进程多实例也不会互踩临时文件）。

```json
{
  "ts": 1762500000000,
  "running": true,
  "agents": 1,
  "lastEventAt": 1762499998000,
  "lastType": "task/start",
  "offline": false,
  "compat": {
    "bridgeVersion": 4,
    "controlSchema": 1,
    "dshRange": ">=0.2.2-rc.1 <0.3.0"
  }
}
```

| 字段 | 含义 |
|---|---|
| `ts` | 本帧写入时间（毫秒） |
| `running` | 当前是否有 running 状态的 agent |
| `agents` | 当前 running 状态的 agent 数量 |
| `lastEventAt` | 最近一次**成功写入** events.jsonl 的事件时间戳；无事件为 `0` |
| `lastType` | 最近一次成功写入的事件类型；无事件为 `null` |
| `offline` | 插件退出时写 `true` 的**显式离线标记**；运行中恒为 `false` |
| `compat` | **v4**：桥的运行时兼容自述（每帧都带，含 `offline:true` 的退出帧）；形状见下文「兼容自述与版本规则」 |

判在线（消费方必须照此实现，见 `toDshStatus`）：

```
online = (offline !== true) && (now >= ts) && (now - ts < 30000)
```

- 未来时间戳（时钟回拨/伪造）**不算** online；
- `offline: true` 时即使 `ts` 仍然新鲜也必须判 offline；
- 插件启动时立即写一帧，然后按 5s 心跳覆盖；disposer 执行时（host 卸载插件 / 进程退出）
  先 `clearInterval`、退订事件，再写最后一帧 `{ ..., "running": false, "agents": 0, "offline": true }`。

> **单写者假设（已知限制）**：同一时间只应有一个 DSH profile 安装本插件并写这个目录。
> 若多个 DSH 实例/重复实例同时运行，`status.json` 是 **last-writer-wins**（后写的帧会覆盖
> 先写者的 `running/agents`），本插件不做实例标识或文件锁；临时文件名唯一只保证不会写出
> 半截 JSON / 不会互删临时文件。B7 消费 `status.running` 时应容忍这种抖动。

### `control.json` —— 桥实例生命周期（Wave 3 新增）

**只在状态切换时写**（`apply` → `attached`，`dispose` → `detached`），心跳**不**重写
（减少写盘）；写入方式与 `status.json` 相同：同目录临时文件
`.control.json.<pid>.<instance>.<seq>.tmp` → `renameSync` 原子替换，权限 `0600`。

```json
{
  "schemaVersion": 1,
  "bridgeVersion": 4,
  "ts": 1762500000000,
  "action": "attached",
  "dshPid": 12345,
  "compat": {
    "bridgeVersion": 4,
    "controlSchema": 1,
    "dshRange": ">=0.2.2-rc.1 <0.3.0"
  }
}
```

| 字段 | 含义 |
|---|---|
| `schemaVersion` | 固定 `1`（`BRIDGE_CONTROL_SCHEMA_VERSION`；不兼容变更才递增） |
| `bridgeVersion` | **v3 起**：桥实现版本（当前 `4`；确认 HMR 是否加载了新代码） |
| `ts` | 本帧写入时间（毫秒） |
| `action` | `'attached'` = 桥实例已加载（DSH 启动 / HMR 重载后）；`'detached'` = 桥 dispose（DSH 退出 / HMR 卸载 / 被禁用） |
| `dshPid` | 写帧的 DSH 进程 pid（排障 + 强耦合判定用；可选） |
| `compat` | **v4**：桥的运行时兼容自述（`attached` 与 `detached` 帧都带）；形状见下文「兼容自述与版本规则」 |

**语义（重要）**：`detached` 只表示「桥没了」，**不能单独证明 DSH 进程退出** —— HMR 重载
也会先 detach 再 attach。桌宠侧必须在收到 `detached` 后等 1500ms grace：期间收到新的
`attached` 就取消（HMR）；否则再结合进程探测/心跳判定，走「DSH 已退出」级联
（见 wave3 设计 §3.2/§4.1）。`attached` 也会在启动/重载后立即写一帧，桌宠无需等心跳。

### `bridge-error.json` —— apply 失败诊断（v4）

**只在 `apply` 启动失败时写**（成功启动会 best-effort 删掉旧文件）。存在的理由：桥被
DSH 版本闸门禁用 / 目录不可写 / 插件初始化异常时，宿主会继续运行但桥一次都不会 attach，
桌宠只能看到「DSH 在跑、桥文件没有」；有了诊断文件 + 安装清单（`install.json`，激活脚本写）
才能解释「桥为什么没加载」，而不是笼统的「未连接」。

```json
{
  "schemaVersion": 1,
  "ts": 1762500000000,
  "phase": "apply",
  "message": "Error: bridge dir not writable: /…/aventurine-pet (Error: EACCES: …)",
  "bridgeVersion": 4,
  "dshRange": ">=0.2.2-rc.1 <0.3.0"
}
```

| 字段 | 含义 |
|---|---|
| `schemaVersion` | 固定 `1`（与 `install.json` 共用 `BRIDGE_INSTALL_SCHEMA_VERSION`，见共享契约 `DshBridgeDiagnostic`） |
| `ts` | 写入时间（毫秒） |
| `phase` | 故障阶段；当前为 `apply` |
| `message` | 一行可读错误（写入侧截断到 1024 字符，`BRIDGE_DIAGNOSTIC_MESSAGE_MAX_CHARS`） |
| `bridgeVersion` | 桥实现版本（排障用；可缺省） |
| `dshRange` | 桥声明的 DSH 范围（排障用；可缺省） |

**落点规则**：优先写本次 apply 的桥目录（`config.dir` > `AVENTURINE_BRIDGE_DIR` > 默认）；
若该目录不可写，回退到环境变量 `AVENTURINE_BRIDGE_DIR` 指向的目录（仅当与主目录不同）。
同目录 `tmp → rename` 原子写、权限 `0600`；所有候选都不可写时只 `console.warn`（绝不二次抛错）。
桥自己**不写** `install.json`（安装清单由激活脚本 `scripts/activate-dsh-bridge.mjs` 写）。

### `events.jsonl` —— 追加写的 NDJSON

每行一个 `DshEvent`：`{ "ts": <毫秒>, "type": <白名单类型>, "payload": <对象> }`。
`payload` 的键由本 README 文档化（共享契约里是 `Record<string, unknown>`，未冻结内部键）。

#### 事件映射表（真实 DSH 4.x 形状）

| DSH 事件（真实形状） | 写入的 `type` | `payload` |
|---|---|---|
| `agent/status`（`{ status, agent }`）变为 `running` | `task/start` | `{ "agent": "<agentId>", "status": "running" }` |
| `agent/status` 变为 `idle` | `task/end` | `{ "agent": "<agentId>", "status": "idle" }` |
| `agent/error`（`{ turn, step, error, agent }`） | `task/error` | `{ "agent": "<agentId>", "turn"?, "step"?, "reasonKind": "error", "message"? }` |
| `session/event` 的 `turn/end`，且 `event.data.reason.kind === "error"` | `task/error` | `{ "sessionId"?, "eventType": "turn/end", "seq"?, "turn"?, "reasonKind": "error" }`（**不再**透传 `session/event`） |
| `session/event` 的 `turn/end`，其它 `reason.kind`（completed / max-tokens / blocked / aborted…） | `session/event` | `{ "sessionId"?, "eventType": "turn/end", "seq"?, "turn"?, "reasonKind"? }` |
| `session/event` 的 `assistant/message` | `session/event` | `{ "sessionId"?, "eventType": "assistant/message", "seq"?, "turn"?, "step"?, "text"? }`（`text` 仅当该步有非空 assistant 输出文本，见下节） |
| `session/event` 的 `tool/result` | `session/event` | `{ "sessionId"?, "eventType": "tool/result", "seq"?, "turn"?, "step"?, "reasonKind"? }`（**不含工具结果正文**） |
| `agent/disposed`（该 agent 上一状态为 running） | `task/end` | `{ "agent": "<agentId>", "reason": "disposed" }` |
| `agent/created` / `agent/disposed`（非 running） | —— | 只维护内存状态表，不写事件 |
| 其它 `session/event`（token 流、step 细节等） | —— | 忽略，避免每 token 刷屏 |

#### `assistant/message` 文本提取（v2，供气泡同步）

`session/event` 的 durable `assistant/message` 事件里，assistant 的**输出文本**位于
`event.data.message.content[]`（内容块数组）：

```jsonc
{ "type": "assistant/message", "seq": 15,
  "data": { "turn": 1, "step": 1,
    "message": { "role": "assistant", "content": [
      { "type": "reasoning", "text": "…思考过程…" },   // 不写
      { "type": "text", "text": "第一步：记录审计待办。" }, // ← 写入 payload.text
      { "type": "tool-call", "name": "todo_write", "arguments": "…" } // 不写
    ] } } }
```

提取算法（`lib/index.js` 的 `extractAssistantText`）：

1. 只取 `content[]` 中 `type === 'text'` 且 `text` 为字符串的块（未知块类型宽容跳过）；
2. 按 `\n` join，再 `trim`；
3. 空串 / 没有 text 块 / `content` 非数组 → **不写** `text` 键（`assistant/message` 事件本身仍写）；
4. 超过 **8000 字符**（UTF-16 code unit，与 `DSH_EVENT_TEXT_MAX_CHARS` 同口径）→ `slice(0, 8000)`；
5. 任何访问异常（getter 抛错等）→ 不写 `text`，只 warn 降级，绝不把数组/对象塞进 payload。

**隐私边界**：`text` 只来自 **assistant 输出**（模型写的回复，UI 会展示；桌宠端应作为纯文本渲染、
不解析指令）。**不写** `user/message` 用户输入、**不写** `reasoning`/thinking 正文、
**不写** tool 参数与 `tool/result` 正文、不写 `system/message` 系统提示。
纯 tool-call 消息的 `assistant/message` 没有 text 块 → 不产生气泡文本，但事件仍透传（供桌宠
识别「这一步只有工具调用」）。上下文窗口空 text 块（如 max-tokens 的空 assistant）同样不写。

映射依据（真实 DSH 源码）：`agent/status` / `agent/error` 是 agent-scoped 事件
（payload 由 DSH 融合 `agent` 字段）；`session/event` 监听签名是 `(session, event)`，
`event = { type, seq, time, data }`；**DSH 的错误信号是 `turn/end` 的
`data.reason.kind === 'error'`（或运行时的 `agent/error` 事件）**，durable 事件类型表里
没有 error/failed 类类型，因此本插件**不再用事件类型名模糊匹配** `/error|failed|.../`。

去重：`agent/error` 与 `turn/end(reason.kind=error)` 是同一个错误的两个真实信号
（DSH 先 emit `agent/error`，随后 append `turn/end`）。同一 `agentId(/sessionId) + turn`
只写一条 `task/error`（先到先得）；去重集合最多保留 64 个键（FIFO 淘汰），长期运行不增长内存。

`message` 字段：仅来自 `agent/error` 的 error 标量文本，截断到 **512 字符**；
`text` 字段：仅来自 `assistant/message` 的 assistant 输出文本，截断到 **8000 字符**（见上节）。
除这两个字段外，payload 只带 sessionId/eventType/seq/turn/step/reasonKind 等安全标量
（隐私 + 64KB 上限）；**永远不写 user 输入 / reasoning / system 提示 / tool 正文**。

保护措施：

- **单行上限 64KB**：序列化后 UTF-8 字节数超限的事件**直接丢弃**并 `console.warn`，不写半行；
- **5MB 轮转**：每次追加前检查文件大小，超过阈值则 `renameSync(events.jsonl, events.jsonl.1)`
  （覆盖旧 `.1`），随后新事件重新写入空 `events.jsonl`；
  **只保留 `events.jsonl` + `events.jsonl.1` 两段**（约最多 10MB，更早历史会被静默覆盖）。
  `events.jsonl.1` 是轮转后的旧段；B7 尾随时必须支持「文件被 rename / 截断」检测
  （inode/size 回退或读取中断后从新文件重开），否则会漏读轮转瞬间的事件；
- **失败只 warn 不抛**：目录不可写、磁盘满、序列化失败等任何异常都不会影响 DSH 运行；
- **事件类型运行时白名单**：写入前用 `DSH_EVENT_TYPES` 校验，非法类型只 warn 不写（防调用点拼错）；
- **权限**：桥目录创建为 `0700`，`status.json` / `events.jsonl` 创建为 `0600`（仅当前用户可读写）。
  已存在的目录/文件不强制 chmod，避免改动宿主既有权限。

## 兼容自述与版本规则（v4）

### `compat` 块（单一来源 = `src/shared/bridge-schema.ts` 的 `DshBridgeCompat`）

`control.json` 与 `status.json` 的**每一帧**都带：

```json
{ "bridgeVersion": 4, "controlSchema": 1, "dshRange": ">=0.2.2-rc.1 <0.3.0" }
```

| 字段 | 含义 |
|---|---|
| `bridgeVersion` | 桥实现版本（= `BRIDGE_PLUGIN_VERSION`，与 control 顶层 `bridgeVersion` 相同；重复便于独立解析） |
| `controlSchema` | 桥认识的控制帧 schema 版本（当前 `1`） |
| `dshRange` | 桥声明的 DSH SemVer 范围；**运行时读本包 `package.json.engines.dsh`**，读不到/未声明 → `null` |

为什么 `dshRange` 必须运行时从相邻 `package.json` 读、而不是在本包常量里再抄一份：

- 真实部署形态是 `work/live-bridge/<rev>/` 的 live 副本，其 `package.json` 由激活脚本生成，
  `engines.dsh` 必须与 DSH 版本闸门**实际使用的 manifest 同源**（闸门从入口向上找最近
  `package.json`）；抄常量会漂移成「桥自称的范围 ≠ 闸门用的范围」。live 副本与正规 bundle
  安装的入口都在包内 `lib/` 下，`../package.json` 相邻可读，两种形态同一套逻辑。
- 读不到 → `null`（**绝不猜兼容**）：v4 桥带 `null` 范围时，桌宠判 `incompatible/range-missing`
  → `DEGRADED` 并提示「桥未声明兼容范围」，而不是静默当兼容。所以 live 副本**必须**带
  `engines.dsh`（激活脚本职责，见 `docs/pet-dsh-coupling-runbook.md`）。

**版本语义**（桌宠侧 `evaluateCouplingCompat` 按序判定）：

| 版本 | 语义 |
|---|---|
| `bridgeVersion < 3`（`BRIDGE_PLUGIN_MIN_SUPPORTED`） | 不兼容（`bridge-too-old`） |
| `bridgeVersion === 3`（现网 legacy） | 无 `compat` → 用 `BRIDGE_LEGACY_DSH_RANGE = '>=0.2.2-rc.1 <0.3.0'` 回退判定；可验证就照常联动 |
| `bridgeVersion === 4` | 必须带 `compat`；`dshRange` 参与运行时判定 |
| `bridgeVersion > 4`（比桌宠新） | 不兼容（`bridge-too-new`，提示升级桌宠） |
| `controlSchema !== 1` | 不兼容（`schema-mismatch`） |

兼容判定**只用 SemVer 范围 + DSH app `Info.plist` 的 `CFBundleShortVersionString`**，语义与
DSH 版本闸门一致（`semver.satisfies(..., { includePrerelease: true })`）。桥**不声称**知道当前
DSH 版本；它只自述范围，比较由桌宠完成。`compat` 是加法式契约：v3 旧桥不写该块、旧桌宠忽略
未知键，互不破坏。

### 桥目录可写性预检（v4 行为变更）

`startBridge()` 在订阅/写帧前做「建目录 + 写探针文件」预检；**目录不可写会让 `apply` 失败**
（写 `bridge-error.json` + 返回 no-op disposer，宿主完全无感），而不是像 v3 那样静默降级成
「永远写不出 status/control 的僵尸桥」。若下一次加载（HMR/重启）时目录恢复可写，桥会正常
attach 并自动清掉旧诊断文件。

## 维护规则：禁止异步孤儿抛错（§4.1，硬约束）

DSH 对插件失败是隔离的：import/`apply` 同步抛错只 warn、不阻断宿主；但**脱离 `apply` 调用栈的
异步孤儿抛错（timer 回调里 throw、无 `catch` 的 promise rejection、EventEmitter `'error'` 无人
消费）会直接 fatal 宿主进程** —— 那正是「DSH 打不开来修桌宠」要绝对避免的场景。维护本插件时：

1. `apply` 保持**箭头函数**，且只做一层 try/catch；真正逻辑在 `startBridge()`。启动失败 →
   `writeBridgeDiagnostic()` + warn + 返回 no-op disposer `() => {}`，**绝不 throw 给宿主**；
2. 心跳 `setInterval` 回调**必须**内嵌 try/catch；所有事件 handler 各自 try/catch；
   `writeStatus` / `writeControl` / `writeEvent`（`createEventLog.appendEvent`）内部逐层
   try/catch，失败只 warn；
3. **禁止任何无 `catch` 的 promise**（本文件当前没有 promise 路径）；`spawn` 的同步异常与子进程
   异步 `'error'` 都必须被消费（见 `createPetLauncher`）；
4. **禁止模块顶层 IO/副作用**（保持纯 ESM、无构建步骤）：manifest 读取用惰性
   `readDeclaredDshRange()`（首次调用时读并缓存结果，读不到也缓存 `null`）；
5. 新增任何定时器/监听器都必须有对应清理，且 disposer 自身 try/catch（cordis 在卸载路径调用它）；
6. 回归断言见 `tests/bridge-plugin.test.ts`：投毒 ctx / 不可写目录 / spawn 失败都不抛、不产生
   `unhandledRejection`，失败场景写 `bridge-error.json`。

## 安装 / 卸载（仅限独立 profile）

在**仓库根目录**执行（`<repo-root>` 指你的 aventurine-pet 仓库根目录，按实际路径展开）：

```bash
# 安装到独立 profile：会初始化 ~/.dsh/profiles/pet-bridge-test，并把本包加入其 dsh.profile.bundles
dsh plugin --profile pet-bridge-test add -w <repo-root>/bridge/dsh-aventurine-bridge

# 启动该独立 profile 的 DSH（不影响正在使用的 profile）
dsh --profile pet-bridge-test

# 退出该 DSH 后，检查退出时写入的显式离线标记（应为 offline:true）
cat ~/.dsh/aventurine-pet/status.json
```

预期文件变化（安装验收判据）：

1. `dsh plugin ...` 成功执行（exit 0），`~/.dsh/profiles/pet-bridge-test/package.json` 的
   `dependencies` 出现 `dsh-aventurine-bridge`，`dsh.profile.bundles` 追加同名条目；
2. 启动该 profile 后，插件被激活，`~/.dsh/aventurine-pet/status.json` 出现且
   `offline:false`、`ts` 在 30s 内持续更新（心跳 5s）；
3. 在 DSH 里跑一个会产生事件的任务后，`~/.dsh/aventurine-pet/events.jsonl` 出现合法 NDJSON 行
   （`task/start` / `task/end` / `task/error` / `session/event`）；
4. 退出该 profile 的 DSH 后，`status.json` 变为 `offline:true`（且 `running:false`；
   H-2 修复后由 disposer 真实写出，不再只依赖 30s TTL）。

卸载（**不要**动其它 profile）：

```bash
# 仍在独立 profile 里操作；卸载后该 profile 的 bundle 列表同步移除
dsh plugin --profile pet-bridge-test remove dsh-aventurine-bridge
```

> 插件是否装对、元数据（标题/描述/图标）是否正常显示，由 Lead 在 `pet-bridge-test`
> 独立 profile 做最终安装验收；本包开发阶段只跑 `pnpm test` 与契约 canary，
> **不得**安装到任何真实 profile（canary 只在临时 `DSH_HOME` 的隔离 profile 中安装，见下节）。

## HMR 热加载与激活（desktop profile）

DSH 0.2.2-rc.1 桌面版**默认开启 HMR**：修改运行中 profile 的 `cordis.patch.yml`
（或安装/启用 bundle）会在约 1~2s 内触发 `app-boot/config-reload` → 旧桥实例 `dispose`
→ 新实例 `apply`，**无需重启 DSH**。因此激活方式是「向 desktop profile 追加一条 insert 行」：

1. 备份 `~/.dsh/profiles/desktop/cordis.patch.yml` → `cordis.patch.yml.bak-wave3-<timestamp>`；
2. 在 `~/.dsh/profiles/desktop/cordis.patch.yml` **末尾追加**（路径按实际 checkout/打包产物调整）：

   ```yaml
   - insert:
       - id: aventurine-bridge
         name: /Volumes/4TB外置盘/deepseek-harness/aventurine-pet-vrm/bridge/dsh-aventurine-bridge/lib/index.js
         config:
           dir: ~/.dsh/aventurine-pet
           launchPet: true
           petAppPath: /Applications/AventurinePet.app
           petBundleId: com.aventurine.pet
   ```

3. HMR 自动组合后应观察到：`control.json` 变 `attached`、`status.json` 心跳出现
   （`offline:false`）、（若 `launchPet:true`）桌宠 app 被拉起一次；
4. 回滚：删除该 insert 行（或恢复备份）→ HMR 再次 reload → `control.json` 变 `detached`，
   桌宠侧不应把这次 reload 误判为 DSH 退出（见 §control 的 1.5s grace）。

HMR 生命周期时序（桥视角）：`apply → attached → 心跳 → dispose → detached`。
重载时是 `detached → attached` 紧邻出现；桌宠侧必须在 grace 窗口内等到 `attached` 才取消
「DSH 已退出」判定。**桥代码本身的修改**不在 HMR watch 范围内（profile HMR `root: []`），
改 `lib/index.js` 后需要一次 recompose（再编辑一次 profile patch / 重启 DSH）才生效。

> **真实部署形态（v4 起推荐）**：不要手工把源仓库路径 insert 进 desktop profile。用激活脚本
> `node scripts/activate-dsh-bridge.mjs --replace --pet-app <app>` 生成
> `work/live-bridge/<rev>/` **live 副本**（自带 `package.json`，**必须含 `engines.dsh`**，
> 否则 DSH 版本闸门失效）并写入安装清单 `~/.dsh/aventurine-pet/install.json`；`--remove` /
> `--rollback` 可定向回滚。部署与排障步骤见
> [`docs/pet-dsh-coupling-runbook.md`](../../docs/pet-dsh-coupling-runbook.md)。
> 激活后核对：`control.json` 为 `attached` 且 `bridgeVersion=4`、`compat.dshRange` 与 live 副本
> `package.json.engines.dsh` 一致；若看到 `bridge-error.json`，按其 `phase`/`message` 排障。

> 安全：激活前先用 `pet-bridge-test` 独立 profile / `pnpm dsh:canary` 验证；desktop profile
> 的变更由 Lead 在全部测试通过后执行，且必须先备份、可单行回滚。本包**不会**自己改 profile。

## 配置项（可选）

`cordis.patch.yml` 的 insert row 可带 `config`；默认值即冻结契约，一般无需配置：

| 字段 | 默认 | 说明 |
|---|---|---|
| `dir` | `~/.dsh/aventurine-pet` | 桥目录覆盖；优先级 `config.dir` > 环境变量 `AVENTURINE_BRIDGE_DIR` > 默认值（测试注入用）。支持 `~/` 前缀（展开到当前用户 home），不支持 `~otheruser/…`；相对路径按 DSH 进程 cwd 解析，建议用绝对路径 |
| `rotateBytes` | `5 * 1024 * 1024` | events.jsonl 轮转阈值；测试用覆盖 |
| `maxLineBytes` | `64 * 1024` | 单行事件字节上限；测试用覆盖 |
| `launchPet` | `false` | v2：apply 时**拉起桌宠 app 一次**（幂等，每个 apply 实例最多一次；失败只 warn，不影响 DSH）。默认关闭，需显式开启 |
| `petAppPath` | `''` | 桌宠 `.app` 绝对路径。**能解析出内部可执行文件时优先直接 spawn 可执行并清洗 `ELECTRON_RUN_AS_NODE`**（见下方设计要点）；解析不到才回退 `open <path>` |
| `petBundleId` | `''` | 桌宠 bundle id（`open -b <id>`；与 `petAppPath` 二选一，**path 优先**）；`launchPet: true` 但两者都缺时只 warn 不 launch |
| 环境变量 `AVENTURINE_BRIDGE_DISABLE_LAUNCH=1` | —— | 强制禁用拉起（测试/canary/隔离验收用；优先级高于 config） |

`launchPet` 设计要点：

- **直接执行 `.app` 内部可执行文件（优先路径）**：`<App>.app/Contents/MacOS/<App>` 存在时，
  `spawn(executable, [], { detached: true, stdio: 'ignore', env: 清洗后的 env }).unref()`。
  原因（2026-11-11 实机发现）：DSH Host 进程自身以 `ELECTRON_RUN_AS_NODE=1` 运行；
  `open` 拉起的 Electron app 若继承该变量会以纯 Node 模式启动并立即退出（窗口不出现）。
  直接执行时显式复制 `process.env` 并 `delete ELECTRON_RUN_AS_NODE`，规避该问题；
  同时绕过 LaunchServices 对「无 CMS 签名」app 的 AMFI 限制（本机自用 ad-hoc 签名即可）。
- **回退 `open`**：`petAppPath` 不是 `.app`/内部可执行不存在 → `open <path>`；
  只有 `petBundleId` → `open -b <id>`；
- spawn 后立即 `unref()` + `detached`：桌宠是独立常驻进程，**不能**因 DSH 退出/HMR 重载被带走；
- 插件**不会**反过来杀桌宠，也不管理桌宠生命周期（只负责「确保它被拉起」这一次）；
- 拉起放在 `status.json`/`control.json` 写完之后：桌宠一启动就能读到桥文件，无需竞态等待；
- 异步 spawn 失败（可执行不存在 / `open` 失败）会挂 `child.on('error')` 消费掉并只 warn，
  绝不产生未捕获异常打挂 DSH Host。

样例：

```yaml
- insert:
    - id: aventurine-bridge
      name: dsh-aventurine-bridge
      config:
        dir: ~/.dsh/aventurine-pet
        launchPet: true
        petAppPath: /Applications/AventurinePet.app
        # petBundleId: com.aventurine.pet   # 与 petAppPath 二选一（path 优先）
```

## 版本护栏与契约 canary（A+ 加固）

DSH 0.x 明确不承诺稳定 API（官方插件开发 skill 的原话是"已安装的 Harness 才是权威"）。
本包用两层护栏把"DSH 更新导致接口失效"从**静默故障**变成**可检测事件**：

### 1. 版本护栏 `engines.dsh`

`package.json` 声明：

```json
"engines": { "dsh": ">=0.2.2-rc.1 <0.3.0" }
```

DSH 在安装插件和 profile 启动时会按该 SemVer 范围检查运行时版本；不匹配时明确拒绝
（安装返回 `incompatible-version`；启动时跳过该 bundle 并告警/拒绝），而不是静默加载一个
行为未知的插件。唯一例外是用户在 profile 的 `compatibility.json` 里对
`dsh-aventurine-bridge@0.2.0` + **精确** DSH 版本做的显式豁免（DSH 升级不继承豁免）。

**live 副本必须带 `engines.dsh`（E1，关键）**：DSH 的版本闸门 `manifestOf()` 从**插件入口**
向上找最近的 `package.json`；`work/live-bridge/<rev>/package.json` 由激活脚本生成，如果只写
`name/version/type/main` 而漏了 `engines.dsh`，闸门在真实部署形态下**完全不生效**（未来 DSH
0.3 会把旧桥照装不误）。所以激活脚本必须把本包的 `name/version/engines/type/main` 复制进
live 副本；`tests/bridge-plugin.test.ts` 的 parity 用例与 canary `--compat` 组共同守护这一点。

v4 起桥还会把该 `engines.dsh` 通过 `compat.dshRange` **运行时自述**出去，桌宠据此做兼容判定
（见「兼容自述与版本规则」）；两边同源，不会出现「闸门用一个范围、桌宠认为另一个范围」。

**`engines.dsh` 只允许裸比较符（D1 收口，2026-11-11）**：范围必须是「比较符 + 完整 semver」
的空白分隔组合（如 `>=0.2.2-rc.1 <0.3.0`），**禁止** `^` / `~` / `x` / `*` / hyphen / `||`。
原因：DSH 内嵌 node-semver 的版本会随 app 更新（7.7.x → 7.8.6 的 caret 下界 `-0` 语义已出现
差异），而桌宠侧 `src/shared/semver-range.ts` 是环境中立的子集实现；裸比较符在 node-semver 7.x
各小版本间语义稳定，能保证「桥声明 = DSH 闸门判定 = 桌宠判定」三方一致。
`tests/bridge-plugin.test.ts` 的「D1 收口」用例会拦截违规范围。

维护规则：每次 DSH 跨 minor（如 0.3.x）先跑 canary；通过后把范围改为
`">=<新版本> <0.4.0>"`（0.2.x 内的小版本不用改）。改范围属于**代码变更**，要随适配
commit 一起评审，不能由用户手工豁免代替。

### 2. 契约 canary `pnpm dsh:canary`

```bash
pnpm dsh:canary               # 默认：离线失败回合 + 本地 mock LLM 成功回合（v2），~40s，无 API key、无外网/费用
pnpm dsh:canary --compat      # v4：兼容组 C1–C6（真实部署形态：绝对路径 insert + live 副本 engines）
pnpm dsh:canary --keep        # 失败时保留临时目录，便于对照原始产物
pnpm dsh:canary --online      # 成功回合改用真实模型：需要环境变量 DEEPSEEK_API_KEY（产生少量真实调用）
pnpm dsh:canary --dsh <path>  # 指定 DSH CLI（默认 macOS 桌面版内置 CLI，其次 PATH 中的 dsh）
```

执行流程（全部在临时目录 + 临时 `DSH_HOME`，**不碰真实 `~/.dsh`**；`AVENTURINE_BRIDGE_DISABLE_LAUNCH=1`
保证 canary 不会真的拉起桌宠 app）：

1. 临时 `DSH_HOME` + `--from-default-profile headless` 初始化隔离 profile；
2. 以本地路径安装本包 —— 顺带验证 `engines.dsh` 护栏与 bundle patch 安装格式；
3. `--dump-config` 确认 `aventurine-bridge` 行确实组合进配置树；
4. **失败回合**：把 `DEEPSEEK_BASE_URL` 指向本机**已关闭端口** + 占位 API key
   （DSH 的 agent 循环、错误信号、session 事件都是真的，只有模型服务是假的，无网络外呼）；
   断言 `status.json` / `events.jsonl`：`task/start → task/error → task/end` 顺序、
   `payload.status` / `reasonKind` / `agent`、`offline:true` 退出帧、`lastEventAt/lastType` 对齐；
5. **成功回合（v2，离线 mock）**：canary 在本机 127.0.0.1 起一个临时 Anthropic-Messages
   SSE mock 服务（`message_start → content blocks（thinking + text）→ message_delta → message_stop`），
   把 `DEEPSEEK_BASE_URL` 指向它，驱动一个真实成功的 agent 回合；
   断言 `events.jsonl` 出现**带非空 `text` 的 `assistant/message`**（`session/event`），
   且文本与 mock 注入一致、`task/start → … → task/end` 顺序正确、成功回合无 `task/error`；
6. **control 生命周期（v2）**：canary 在回合运行期间轮询 `control.json`，断言观察到
   `attached → detached` 两个状态（apply 挂载 → dispose 卸载），且最终帧 schema 合法
   （`schemaVersion/ts/action/dshPid`）；
7. 对比真实 `~/.dsh/aventurine-pet` 前后快照，确认桥目录隔离没失效（有变化会 WARN）。

退出码：`0=PASS`、`1=FAIL`（契约不匹配/安装被拒/断言失败）、`2=SKIP`（找不到 DSH CLI）。
CI/无桌面版机器会 SKIP；开发机与升级后的验收机应把它当必跑项。

**`pnpm dsh:canary --compat`（v4 新增组）**：全部在临时 `DSH_HOME`/临时桥目录、
`AVENTURINE_BRIDGE_DISABLE_LAUNCH=1`，不碰真实 `~/.dsh`。覆盖「真实部署形态」而非只测 bundle：

| 组 | 构造 | 断言（桥 v4 起严格） |
|---|---|---|
| C1 | 不兼容 `engines.dsh` 的临时包 → `dsh plugin add -w` | 非 0 退出 + incompatible/engines 文案 |
| C2 | 临时 profile 追加**绝对路径 insert** + 不兼容 live 副本 package.json | 宿主完成启动、stderr 含 disable 行、桥目录零产物 |
| C3 | 绝对路径 insert + 兼容 engines | `control.json` attached + `bridgeVersion=4` + `compat.dshRange` 正确；status 心跳在线且带 `compat` |
| C4 | 临时插件顶层 throw + insert | 宿主正常启动、warning、零产物 |
| C5 | 临时插件 apply 同步 throw + insert | 同上 |
| C6 | 本包 `lib/index.js` + 不可写桥目录（chmod 0555，`AVENTURINE_BRIDGE_DIR` 指向可写目录做诊断落点） | 宿主正常、**apply 返回 no-op disposer**、`bridge-error.json` 存在（`phase:'apply'`、`bridgeVersion:4`）、无未捕获异常、不可写目录零产物 |

> C6 详细落点规则见「`bridge-error.json` —— apply 失败诊断」节：主桥目录不可写时回退到
> `AVENTURINE_BRIDGE_DIR` 目录，所以 canary 必须构造两个不同目录（config.dir=不可写、
> env=可写）才能断言诊断文件存在。

> `control.json` 是「桥实例」状态而非「DSH 进程」状态：正常退出时最终帧为 `detached`；
> 崩溃/SIGKILL 时 disposer 不跑，文件可能停留在 `attached`，此时只能靠 status 心跳 TTL 兜底
> （消费方必须两者结合判定，禁止 single-source 到 control）。

### 3. DSH 升级 runbook

1. DSH 更新后先跑 `pnpm dsh:canary`；
2. **PASS** → 桥仍适配，无需改代码（0.2.x 内通常也不用改 `engines.dsh`）；
3. **FAIL 且提示安装被拒/`engines.dsh`** → 跨了 minor：按新版 DSH 源码/`cordis_inspect_query`
   核对 5 个事件与 `session/event` envelope，改 `lib/index.js` 映射与 `lib/constants.js`
   白名单、补真实形状 fixtures，更新 `engines.dsh`，再跑 canary；
4. **FAIL 且事件断言失败** → `--keep` 查看临时目录原始产物，对照新旧 DSH 事件形状定位；
5. 任何修改后都跑三件套：`pnpm test`、`pnpm typecheck`、`pnpm dsh:canary`。

## 开发与测试

```bash
# 全量单测（vitest 会自动收集 tests/**/*.test.ts，含本包的桥插件用例）
pnpm test

# 只跑桥插件 + canary 断言库用例
pnpm test -- tests/bridge-plugin.test.ts tests/dsh-canary-lib.test.ts

# 契约 canary（需要 macOS DeepSeek Harness 桌面版内置 CLI；详见上节）
pnpm dsh:canary
```

单测用 fake `ctx` + `mkdtempSync` 临时目录，覆盖：`apply` 形态回归（箭头不可构造）、启停
（含离线帧/幂等/退订）、真实 DSH 形状的事件映射（`agent/status` / `agent/error` /
`turn/end reason.kind` / `assistant/message` / `tool/result` / `agent/disposed`）、同 turn 去重、
心跳、轮转、超长行丢弃、事件类型白名单、目录不可写不抛、`~/` 展开、文件权限、
常量 parity、bundle 元数据（patch/locale/icon）形状；

v2 新增用例：`assistant/message` 的 `text` 提取（多 text 块 `\n` join / 空文本不写 /
8000 字符截断 / `content` 非数组与 getter 抛错等异常防御 / 纯 tool-call 无 text /
**user 输入、reasoning、tool 正文不得出现在任何 payload**）、`control.json`
（apply→attached / dispose→detached / 原子写无 tmp 残留 / 0600 / 心跳不重写）、
`launchPet`（fake spawn：`open <path>` / `open -b <id>` / path 优先 / 每 apply 最多一次 /
`AVENTURINE_BRIDGE_DISABLE_LAUNCH=1` 禁用 / 未配置 warn 不 spawn / spawn 抛错与异步
`error` 只 warn 不抛）、以及常量 parity 覆盖 `text` 上限与 control 常量。

v4 新增用例（兼容性安全 §3.2/§4.1）：`BRIDGE_PLUGIN_VERSION=4` 与共享契约
`src/shared/bridge-schema.ts` 的 parity；`control/status` **每一帧**（attached/detached、
启动帧/心跳/离线帧）都带合法 `compat`，且 `dshRange` 确实来自相邻 `package.json.engines.dsh`
（复制包到临时目录改 engines 后重新 import 验证；缺 engines → `null` 且不抛）；
`apply` 失败隔离（投毒 ctx getter / 不可写目录 chmod → 不抛、返回函数 disposer、
`bridge-error.json` 形状合法且可通过共享契约 `parseDshBridgeDiagnostic`、主目录不可写时
回退 `AVENTURINE_BRIDGE_DIR`）；成功 apply 清理旧诊断；毒化事件 payload / handler 抛错不
影响宿主；**不产生 `unhandledRejection`/`uncaughtException`**。

## 假设与风险

- 事件订阅依赖 DSH 的**稳定事件名与真实形状**：`agent/status`（payload `{ status, agent }`，
  状态仅 `'idle' | 'running'`，只在变化时 emit）、`agent/error`（payload `{ turn, step, error, agent }`）、
  `agent/created` / `agent/disposed`（payload `{ agent, source? }` / `{ agent }`）、
  `session/event`（`(session, event)`，`event.type`/`event.seq`/`event.data` 为 durable 字段）。
  字段访问全部做了防御，但 DSH 大版本若改事件名/形状，需要按新版契约适配。
  **护栏**：`package.json` 的 `engines.dsh` 让不兼容的 DSH 在安装/启动时明确拒绝，
  `pnpm dsh:canary` 在每次 DSH 更新后用真实运行时断言这 5 个事件仍能映射（见上节）。
- `task/error` 依据真实 DSH 错误信号：`agent/error` 事件 + `turn/end.data.reason.kind === 'error'`
  （同 turn 去重）。若未来 DSH 增加新的错误信号，需同步补映射。
- 桥目录与桌宠 app 的读取端（B7）必须使用**同一份契约常量**；改任一侧都要同步
  `src/shared/bridge-schema.ts` 与本包 `lib/constants.js`，并让 parity 测试通过。
- 不允许依赖旧皮肤的 `/aventurine-skin/status` 路由（端口每次启动都变、数据太薄，见 PLAN §9.1）。
- 多实例/重复实例同写一个桥目录是**已知限制**（last-writer-wins，见上文「单写者假设」）。

## 已知限制

### 插件 reload 后看不到「已在运行」的 agent（不修复，仅记录）

- **现象**：若插件在某个 agent **已经 running 之后**才被加载（DSH 运行中重装 / 重新启用插件、
  HMR reload、`apply()` 重新执行），桥的 `agents` 表从空 Map 起，`status.json` 在下一次心跳
  （默认 5s）里会报 `running:false` / `agents:0`。桌宠侧 B7 因此不会进入 busy，直到该 agent
  发生下一次状态变化（`agent/status` 变为 idle，或新 agent 变为 running）。
- **原因**：本插件只订阅 DSH 的变化事件，而 `agent/status` **只在状态变化时 emit**，DSH 不会
  为后加载的插件补发「当前已在运行」的快照。cordis 插件 API 目前没有提供枚举现存 agent 的
  稳定接口，因此 `apply()` 无法可靠 hydrate `agents` 表 —— 本轮决定**不改桥行为**。
- **影响面**：只影响「插件晚于 agent 启动」这一窗口期的实时状态精度（busy/idle 指示滞后），
  事件流本身不受影响：`session/event`、后续 `task/start` / `task/end` / `task/error` 仍会
  正常写入 `events.jsonl` 并被主进程转发。
- **旁路**：消费方（桌宠 app）已按 M-1 修复「启动时从 events.jsonl 历史重放」——app 启动或
  reload 期间不会把旧事件当新事件重演（启动基线 = EOF）。
- **后续**：若 cordis 未来暴露 agent 枚举 API，在 `apply()` 内对现存 agent 调一次
  `agents.set(id, 'running')` 并立即 `writeStatus(false)` 即可消除该窗口期。

### 桥目录不可写 → 本次 apply 失败（v4 行为变更，非缺陷）

- **现象**：v4 起 `apply` 会先做「建目录 + 写探针」预检；桥目录不可写（权限、被文件占用、
  磁盘只读等）时本次 apply 直接失败：写 `bridge-error.json`（能落到回退目录时）+ warn +
  返回 no-op disposer。此后该次 DSH 会话内桥不写 status/control（桌宠会走 `UNPAIRED`/
  `DEGRADED` 并在告警里带原因），直到下一次加载（HMR 重载 / DSH 重启）目录恢复可写。
- **为什么这样设计**：v3 的写入失败全部内部 catch，目录不可写时桥会静默变成「永远写不出
  status/control 的僵尸桥」——桌宠只能看到「未连接」而无法知道原因，排障成本高。v4 选择
  fail-fast + 可诊断证据，同时保证宿主完全无感（`apply` 绝不 throw）。
- **修复**：按 `bridge-error.json` 的 `message` 修目录权限/路径后触发一次 HMR 重载即可；
  桥成功启动会自动删除旧诊断文件。
