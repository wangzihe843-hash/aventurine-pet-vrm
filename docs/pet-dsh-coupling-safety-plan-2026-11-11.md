# 修正计划：桌宠 × DSH 耦合的"版本更新兼容性安全"（v2，2026-11-11）

> 依据：Lead 对豆包调查/计划的复核（[review](research/pet-coupling-compat-plan-review-2026-11-11.md)）。
> 目标用户（本机）已拍板：**保留"DSH 启动→桌宠启动、DSH 退出→桌宠退出"的默认强耦合**，
> 同时**保证将来某次版本更新出现兼容问题时，DSH 本体一定能打开来修桌宠**。
>
> 本文是实施契约：队友按 §3–§6 的实现规格写代码，按 §7 分工/写盘范围并行；Lead 负责共享契约层、
> 集成与最终验收。**本轮不改 `src/renderer/**`（另一会话正在改模型侧），不改 DSH 安装目录，
> 不动真实 `~/.dsh` 的 profile/桥目录（只读检查除外），不重建 `out/`/`dist/`。**

## 1. 不变项（默认健康时语义与现在完全一致）

| 场景 | 语义（保持） |
|---|---|
| 桌宠启动时 DSH 未运行 | 拉起 DSH（`open -b com.deepseek.dsh`，60s 冷却 / 3 次每 90s） |
| DSH 启动（桥 apply） | 桥 `launchPet` 拉起桌宠一次 |
| DSH 显式退出（detached + 进程消失） | 桌宠跟随退出（`dsh-exit`），**绝不重启** |
| DSH 崩溃（无 detached 的进程消失，**PAIRED 且握手健康**） | 重启 ≤2 次 / 5s；仍失败 → 本轮改为 `DEGRADED` 常驻（见 §2，不再自杀） |
| 桌宠显式退出（PAIRED 且握手健康） | SIGTERM→SIGKILL DSH 后退出（≤5s） |
| HMR | detached → 1.5s grace → attached 取消 |
| 手动 HMR/重装桥 | 允许在 `1.5s`~`20s` 窗口内恢复，不误判退出 |

## 2. 新增：握手门槛与降级语义

### 2.1 握手健康（`PAIRED` 的必要条件）

四项同时成立才允许 `PAIRED`：

1. DSH 进程在运行（`dsh-process.isRunning()`）；
2. `status.online === true`（心跳新鲜，30s TTL；排除陈旧文件）；
3. `control.json` 最近一次帧为 `attached`，且没有被 `detached` 覆盖（即现有 `bridgeDetached=false`）；
4. **兼容判定通过**（§3）：运行时 compat（桥 v4+）或 legacy 回退（桥 v3）或安装清单静态判定。

任一项不满足：`STARTING`/`UNPAIRED`/`DEGRADED`（按 §2.2）。`PAIRED` 后失去 1~3 项之一超过
`DSH_BRIDGE_LOST_GRACE_MS = 30_000` → `DEGRADED`（原因 `bridge-lost`）。

### 2.2 状态机（在现有 4 态上新增 `UNPAIRED`、`DEGRADED`）

```
DISABLED ──config/env/safe-mode on──► (不变)
STARTING ──握手健康──► PAIRED
   │  DSH 运行但握手不健康      → UNPAIRED（无动作，等握手；20s 超时）
   │  拉起失败/一直拉不起来      → 3 次/90s 用尽后再等 90s（共 ~180s）→ DEGRADED(startup-failed)
   │  握手明确不兼容            → 立即 DEGRADED(compat-*)
UNPAIRED ──握手健康──► PAIRED
   │  20s 超时 → DEGRADED(no-bridge-unpaired)
   │  DSH 进程消失 → 跟随退出（dsh-degraded）
DEGRADED ──握手健康──► PAIRED（自动恢复，联动语义恢复）
   │  DSH 进程消失 → 跟随退出（dsh-degraded，**不重启、不发信号**）
   │    例外（2026-11-11 实施裁定）：若**进入 DEGRADED 时 DSH 本就不在运行**
   │    （startup-failed / crash-recovery-failed），桌宠常驻等待用户手动打开 DSH；
   │    此后一旦观察到 DSH 运行，其消失仍按跟随退出处理（degradedSawRunning 语义）。
   │  before-quit → 放行（**不杀 DSH**）
PAIRED ──DSH 进程消失──► 确认窗口（现有逻辑，仅 PAIRED）
   │      └ detached → dsh-exit（不变）
   │      └ 无 detached → 重启 ≤2 → 仍失败 → DEGRADED(crash-recovery-failed)（**不再 cascade**）
```

**`DEGRADED` 下禁止的动作**：拉起/重启 DSH、`handleBeforeQuit` 里 SIGTERM/SIGKILL DSH、
因 DSH 退出而重启 DSH、弹重复告警。**允许的动作**：跟随 DSH 显式/崩溃退出（`dsh-degraded`）、
握手恢复后自动回 `PAIRED`、每 3s 重试握手评估。

### 2.3 安全模式（新增逃生阀，第二道保险）

`~/.dsh/aventurine-pet/safe-mode` **存在即等价于耦合关闭**（优先级高于 config，低于
`PET_DSH_COUPLING_DISABLE=1`）：不拉起、不重启、不杀 DSH、不跟随退出；状态进入 `DISABLED`。
每 3s tick 重新检查（文件可热生效/热失效）。用 `fs.existsSync` 注入，单测可 fake。
用途：桌宠打不开/行为失控时，`mkdir -p ~/.dsh/aventurine-pet && touch ~/.dsh/aventurine-pet/safe-mode`
即可保住 DSH，再修桌宠。

### 2.4 告警（纯主进程，本轮不改 renderer）

新增 `onCouplingAlert?: (alert: DshCouplingAlert) => void` 注入点；`ipc/dsh.ts` 实现：
- 每次**进入** `DEGRADED`：写 main.log + 一次 `dialog.showMessageBox`（每次 app 运行同原因只弹一次）
  + 一次 Electron `Notification`（失败静默）；
- 恢复 `PAIRED`：只写日志 + Notification（不弹 modal）；
- 环境变量 `PET_DSH_COUPLING_SILENT_ALERTS=1` 时只写日志（E2E/自动化用）。
- 文案必须含：原因码、DSH 版本、桥期望范围、以及"DSH 本体不受影响，可正常打开/关闭；
  修复步骤见 docs/pet-dsh-coupling-runbook.md"。

```ts
export type DshCouplingAlertCode =
  | 'compat-incompatible' | 'compat-unverified' | 'bridge-not-loaded'
  | 'bridge-lost' | 'startup-failed' | 'crash-recovery-failed'
export interface DshCouplingAlert {
  kind: 'degraded' | 'recovered'
  code: DshCouplingAlertCode
  /** 人类可读一句原因；不含路径细节时也写日志。 */
  reason: string
  dshVersion: string | null
  bridgeVersion: number | null
  dshRange: string | null
  state: DshLifecycleState
}
```

## 3. 兼容契约（单一事实源）

### 3.1 三层信号

| 层 | 文件/来源 | 写入方 | 用途 |
|---|---|---|---|
| 运行时 | `control.json`/`status.json` 的 `compat` 块（桥 v4+） | 桥 | 桥每次 attach/心跳自述版本与支持范围 |
| 安装 | `~/.dsh/aventurine-pet/install.json` | 激活脚本 | 桥被禁用/未加载时，桌宠仍能静态判定 + 解释 |
| 宿主 | DSH app `Info.plist` `CFBundleShortVersionString` | DSH 安装包 | 被比较的 DSH 版本；`lsappinfo`/`mdfind` 兜底定位 app |

桥 v3（现网）无 `compat`：桌宠用共享常量 `BRIDGE_LEGACY_DSH_RANGE = '>=0.2.2-rc.1 <0.3.0'` 回退判定。

### 3.2 `compat` 块（加法式，`schemaVersion` 保持 1）

`control.json`（每次写帧都带）与 `status.json`（心跳都带）：

```json
{
  "schemaVersion": 1,
  "bridgeVersion": 4,
  "ts": 1794376241734,
  "action": "attached",
  "dshPid": 98123,
  "compat": { "bridgeVersion": 4, "controlSchema": 1,
              "dshRange": ">=0.2.2-rc.1 <0.3.0" }
}
```

- `dshRange` 来自**桥自身 `package.json.engines.dsh`**（运行时读 `../package.json`，读不到 → `null`）；
- 不 bump `control.json` 的 `schemaVersion`（旧桌宠会忽略未知键、仍可工作）；
- 未来若必须 bump，桌宠用"宽松诊断解析"提取 compat 并给出 `compat-unverified` 告警，不会静默。

### 3.3 安装清单 `install.json`（schemaVersion 1）

```json
{
  "schemaVersion": 1,
  "installedAt": 1794371618741,
  "installMethod": "live-copy-insert",
  "bridgeEntry": "/…/work/live-bridge/rev-…/lib/index.js",
  "bridgePackageName": "dsh-aventurine-bridge",
  "bridgePackageVersion": "0.2.0",
  "bridgeVersion": 4,
  "controlSchema": 1,
  "dshRange": ">=0.2.2-rc.1 <0.3.0",
  "dshVersionAtInstall": "0.2.2-rc.1",
  "petAppPath": "/…/AventurinePet.app",
  "petBundleId": "com.aventurine.pet"
}
```

### 3.4 桥故障诊断 `bridge-error.json`（schemaVersion 1，桥 apply 失败时写）

```json
{ "schemaVersion": 1, "ts": 1794376241734, "phase": "apply",
  "message": "Error: …", "bridgeVersion": 4, "dshRange": "…" }
```

### 3.5 共享契约层（**Lead 已实现，勿改**，队友只消费）

`src/shared/semver-range.ts`（新）：

```ts
export function parseSemverVersion(text: unknown): SemverVersion | null
export function compareSemverVersions(a: SemverVersion, b: SemverVersion): number
export function compareSemverStrings(a: string, b: string): number | null
/** 返回 null = 范围/版本无法解析（不可验证，消费方必须降级，不得猜兼容）。 */
export function satisfiesSemverRange(version: string, range: string): boolean | null
```

语义与 DSH 闸门一致：`semver.satisfies(version, range, { includePrerelease: true })`。
支持 `||`、空格分隔比较符（`>= > <= < =`、裸版本）、`^`、`~`、`*`、hyphen range；
未知语法 → `null`。

> **D1 收口（2026-11-11 verifier 发现）**：DSH 内嵌 node-semver 版本会随 app 更新
> （7.8.6 的 caret 下界 `-0` 语义与 7.7.x 不同），而本实现是子集。**桥 `engines.dsh` 契约
> 限定为裸比较符**（比较符 + 完整 semver，禁止 `^ ~ x *`/hyphen/`||`），由
> `tests/bridge-plugin.test.ts` 守卫；裸比较符跨 semver 小版本语义稳定，保证「桥声明 =
> DSH 闸门 = 桌宠判定」三方一致。`^`/`~`/通配仅作防御性兜底，不得用于桥声明。

`src/shared/bridge-schema.ts` 增补（Lead 已实现）：`BRIDGE_PLUGIN_VERSION = 4`、
`BRIDGE_PLUGIN_MIN_SUPPORTED = 3`、`BRIDGE_LEGACY_DSH_RANGE`、`BRIDGE_INSTALL_FILE = 'install.json'`、
`BRIDGE_DIAGNOSTIC_FILE = 'bridge-error.json'`、`BRIDGE_INSTALL_SCHEMA_VERSION = 1`、
`DshBridgeCompat` + `parseDshBridgeCompat()`、`DshBridgeInstallManifest` +
`parseDshBridgeInstallManifest(text)`、`DshBridgeDiagnostic` + `parseDshBridgeDiagnostic(text)`；
`DshBridgeControlFile`/`DshBridgeStatusFile` 增可选 `compat?: DshBridgeCompat`（存在但非法 → 整帧无效）。
单测：`tests/semver-range.test.ts`、`tests/bridge-schema-compat.test.ts`（Lead 所有）。

**桥 `lib/constants.js` 的 `BRIDGE_PLUGIN_VERSION` 必须同步为 4**（parity 测试守护）。

## 4. 宿主侧（DSH）行为：不改，只利用

- 版本闸门依赖 `package.json.engines.dsh`（`dsh-app-boot` 从入口向上找 manifest）；
  → 所以 §5.1 必须把 engines 写进 live 副本，未来 DSH 升级会禁用不兼容行并继续启动；
- 插件 import/apply 失败只 warn，不阻断宿主；异步孤儿抛错会 fatal —— 桥必须杜绝（§4.1）。
- 不修改 `/Applications/DeepSeek Harness.app`、不改真实 profile（部署步骤另见 §8）。

### 4.1 桥的"绝不伤宿主"规则（v4 实现要求）

1. `apply` 导出为箭头函数，内部拆 `startBridge()`，外层 try/catch：失败写 `bridge-error.json`
   + warn + 返回 no-op disposer `() => {}`，**绝不 throw 到宿主**；
2. `setInterval` 心跳回调、所有事件 handler、`writeStatus/writeControl/writeEvent` 内部全部
   try/catch；`spawn` 的同步异常与异步 `'error'` 全部消费；
3. 禁止任何无 `catch` 的 promise、禁止在模块顶层做 IO/副作用（保持纯 ESM、无构建）；
4. apply 成功时 best-effort 清理旧 `bridge-error.json`。

## 5. 安装/激活加固（`scripts/activate-dsh-bridge.mjs`）

1. **live 副本带 engines**：生成的 `work/live-bridge/<rev>/package.json` 复制源包
   `name/version/engines/type/main`（`name` 固定 `dsh-aventurine-bridge`、`version` 用源包版本，
   保证 DSH 豁免键稳定），写 `engines.dsh` → 闸门生效；
2. **写安装清单**（§3.3）到桥目录（原子 tmp→rename，0600；目录 0700）；
3. **YAML 校验 fail-closed**：PyYAML 可用则严格 `yaml.safe_load`；不可用默认**拒绝写入**
   （报错并提示装 PyYAML 或 `--skip-yaml-check` 显式承担风险）；写入前后都校验；
4. **定向操作**：新增 `--remove`（只删本脚本写入的桥 insert 块，保留其它 patch）与
   `--replace`（= remove + append，备份先行）；保留现有 `--rollback`（整份备份恢复）；
5. **激活前预检**：读 DSH app 版本 + 桥 `engines.dsh`；不匹配时打印醒目 WARNING
   （"DSH 会禁用该行、宿主仍可启动，桌宠将 DEGRADED"），但仍允许安装；
6. **激活后验证**（DSH 在跑时）：轮询 `control.json` ≤10s，报告 attached/`bridgeVersion`/
   `compat.dshRange` 是否可见；失败给出原因提示（HMR 时机/被闸门禁用/入口不存在）；
7. `--rollback`/`--remove` 时同步处理 `install.json`（删除或写 removed 标记），不留假清单。

### 5.1 canary（`scripts/dsh-canary.mjs`）新增 `--compat` 组

全部在临时 `DSH_HOME`/临时桥目录，`AVENTURINE_BRIDGE_DISABLE_LAUNCH=1`，不碰真实 `~/.dsh`：

| 组 | 构造 | 断言 |
|---|---|---|
| C1 bundle 安装被拒 | 改 `engines.dsh` 为不兼容的临时包 → `dsh plugin add -w` | 非 0 退出 + 含 incompatible/engines 文案 |
| C2 绝对路径 insert + 不兼容 engines（**现网形态**） | 临时 profile 的 patch 追加 insert（临时 live-copy 风格 package.json）→ 跑失败回合 | 宿主**完成启动**（能跑到 turn 失败）、stderr 含 `disabling profile plugin`/`engines.dsh`、桥目录零产物 |
| C3 绝对路径 insert + 兼容 engines | 同上但 engines 等于源包范围 | `control.json` attached + `bridgeVersion=4` + `compat.dshRange` 正确；`status.json` 心跳在线 |
| C4 import 抛错 | 临时插件顶层 throw + insert | 宿主正常启动、warning `did not activate`、零产物 |
| C5 apply 同步抛错 | 临时插件 apply throw + insert | 同上 |
| C6 桥 apply 失败隔离 | 用 `lib/index.js` + 不可写桥目录（chmod） | 宿主正常、`bridge-error.json` 存在、无未捕获异常 |

C7（静态，单测）：`tests/dsh-patch-lib.test.ts` —— 追加/删除块纯函数 + "追加坏 YAML 被
`--dry-run` 拒绝"；`tests/dsh-canary-lib.test.ts` —— compat/install manifest 解析断言。

## 6. 桌宠侧实现规格（`src/main/desktop/**` + `src/main/ipc/dsh.ts`）

### 6.1 新文件

**`src/main/desktop/dsh-version.ts`**（electron-free，可注入 fs/execFile）：

```ts
export interface DshVersionInfo {
  version: string | null   // semver 文本，如 "0.2.2-rc.1"
  appPath: string | null
  source: 'override' | 'info-plist' | 'lsappinfo' | 'mdfind' | 'unknown'
  error?: string
}
export interface CreateDshVersionDetectorOptions {
  env?: NodeJS.ProcessEnv          // 读 PET_DSH_APP_PATH（测试/非常规安装）
  readFile?: (path: string) => string
  exists?: (path: string) => boolean
  execFile?: (file: string, args: string[]) => Promise<{ stdout: string }>
  now?: () => number
  cacheMs?: number                 // 默认 60_000
}
export function createDshVersionDetector(options?): {
  detect(): Promise<DshVersionInfo>   // 缓存 + 失败返回 version:null
  invalidate(): void
}
```

路径候选：`PET_DSH_APP_PATH` → `/Applications/DeepSeek Harness.app` →
`lsappinfo info -only bundlepath $(lsappinfo find bundleID=com.deepseek.dsh)` →
`mdfind "kMDItemCFBundleIdentifier == 'com.deepseek.dsh'"` 首行。
版本读取：XML plist 用文本解析 `<key>CFBundleShortVersionString</key>` 后一个 `<string>`；
二进制 plist 用 `plutil -extract CFBundleShortVersionString raw -o - <plist>`。
任何失败不抛，`version:null` + `error`。

**`src/main/desktop/dsh-compat.ts`**（纯函数，无 IO）：

```ts
export type CouplingCompatStatus = 'ok' | 'incompatible' | 'unverified'
export interface CouplingCompatInput {
  dshVersion: string | null
  bridgeVersion: number | null
  controlSchema: number | null
  dshRange: string | null            // 运行时 compat 或 install manifest 提供
  installManifest?: DshBridgeInstallManifest | null
}
export interface CouplingCompatResult {
  status: CouplingCompatStatus
  code: 'ok' | 'bridge-too-old' | 'bridge-too-new' | 'schema-mismatch'
      | 'range-missing' | 'range-unparsable' | 'dsh-version-unknown' | 'version-out-of-range'
  detail: string
}
export function evaluateCouplingCompat(input: CouplingCompatInput): CouplingCompatResult
```

规则（按序，命中即返回）：
1. `bridgeVersion == null` → `unverified/no-bridge`;
2. `bridgeVersion < BRIDGE_PLUGIN_MIN_SUPPORTED` → `incompatible/bridge-too-old`；
3. `bridgeVersion > BRIDGE_PLUGIN_VERSION` → `incompatible/bridge-too-new`；
4. `controlSchema !== BRIDGE_CONTROL_SCHEMA_VERSION` → `incompatible/schema-mismatch`；
5. `dshVersion == null` → `unverified/dsh-version-unknown`；
6. `bridgeVersion === 3 && dshRange == null` → 用 `BRIDGE_LEGACY_DSH_RANGE`；
   `bridgeVersion >= 4 && dshRange == null` → `incompatible/range-missing`；
7. `satisfiesSemverRange(...) === null` → `unverified/range-unparsable`；
8. `=== false` → `incompatible/version-out-of-range`（detail 带 DSH 版本与范围）；
9. 否则 `ok`。
`installManifest` 仅在运行时信号缺失时提供 `dshRange/bridgeVersion` 兜底，并做
"install manifest bridgeVersion 与运行时不符"的 detail 记录（不单独改变 status）。

**`src/main/desktop/dsh-bridge-state.ts`**（读文件，electron-free，可注入 fs）：

```ts
export interface BridgeDirState {
  installManifest: DshBridgeInstallManifest | null
  diagnostic: DshBridgeDiagnostic | null
  dir: string
}
export function createBridgeStateReader(options?): {
  read(): BridgeDirState   // 每 tick 可调；mtime 变化才重读，失败只 warn 一次
}
```
读 `BRIDGE_INSTALL_FILE` / `BRIDGE_DIAGNOSTIC_FILE`，上限 `16KB`，坏 JSON 静默忽略。

### 6.2 `dsh-lifecycle.ts` 变更

- `DshLifecycleState` 增 `'UNPAIRED' | 'DEGRADED'`；`DshQuitReason` 增 `'dsh-degraded'`。
- 常量：`DSH_UNPAIRED_GRACE_MS = 20_000`、`DSH_STARTUP_GIVEUP_MS = 180_000`、
  `DSH_BRIDGE_LOST_GRACE_MS = 30_000`（均可 options 覆盖）。
- options 增：
  ```ts
  getDshVersion?: () => Promise<string | null>
  readBridgeDirState?: () => BridgeDirState
  onCouplingAlert?: (alert: DshCouplingAlert) => void
  isSafeMode?: () => boolean            // 默认 () => false
  ```
- 内部新增：`lastStatusOnline`、`controlAttached`、`compat: DshBridgeCompat | null`、
  `handshakeHealthy`、`unpairedSince`、`degradedSince`、`bridgeUnhealthySince`、
  `firstLaunchAt`、`notifiedDegraded`。
- `handleControl(attached)`：记录 `controlAttached=true`、`compat=parseDshBridgeCompat(frame.compat)`；
  **不再单独** `enterPaired`；交给 `evaluateHandshake()`。
- `handleStatus(online)`：记录 `lastStatusOnline`；online 也刷新；不再单独 `enterPaired`。
- `runTick()` 每 3s：读配置/安全模式 → 进程探测 → 按状态分派（见 §2.2）；
  握手评估是 `async`（可能读 DSH 版本），带重入保护。
- `evaluateHandshake()`：Running + online + attached + !bridgeDetached 前提下，
  `dshVersion = await getDshVersion()`, `compat` 来自 control 帧，缺失时用
  `readBridgeDirState()` 兜底，然后 `evaluateCouplingCompat`：
  - `ok` → `enterPaired('handshake')`（从任何非 CASCADING 状态）；
  - `incompatible` → `enterDegraded(code)`（即使是 STARTING/UNPAIRED 立即）；
  - `unverified` → 不立即降级，交给 `UNPAIRED` 20s 超时（避免 DSH 版本读取瞬态失败误降级），
    超时后 `enterDegraded('compat-unverified' | 'no-bridge-unpaired')`。
- `STARTING` 拉不起来：记录 `firstLaunchAt`；`now - firstLaunchAt >= DSH_STARTUP_GIVEUP_MS`
  且进程仍不在运行 → `enterDegraded('startup-failed')`（不再无限重试）。
- `PAIRED` 崩溃恢复失败 → `enterDegraded('crash-recovery-failed')`（**替换 cascade('dsh-gone')**）。
  显式退出（detached→`dsh-exit`）路径保持 cascade。
- `PAIRED` 心跳丢失超过 `DSH_BRIDGE_LOST_GRACE_MS` → `enterDegraded('bridge-lost')`。
- `DEGRADED`/`UNPAIRED` tick：进程消失 → `cascade('dsh-degraded')`；握手恢复 → `PAIRED`；
  DEGRADED 下**禁止** beginRecovery/launch/terminate。
- `handleBeforeQuit`：`state === 'PAIRED'` 才允许终止 DSH；`DEGRADED`/`UNPAIRED`/`DISABLED`
  → 直接放行（不 kill）。`quitReason === 'dsh-degraded'` 时也放行。
- `isSafeMode()` 为真 → 视为禁用（`enabled=false` → `DISABLED`），日志写一次。
- 告警：`enterDegraded(code)` 首次（每 app 运行）触发 `onCouplingAlert({kind:'degraded',...})`；
  `enterPaired` 从 DEGRADED 恢复时触发 `{kind:'recovered'}`。

**必须保留现有 36 条以上 lifecycle 测试的语义**：原测试通过"进程存在即 PAIRED"进入的场景，
改为注入健康握手（status online + control attached + compat ok/legacy）。原 detached/grace/
restart/before-quit 用例在新门槛下重写时序，**断言不许弱化**。

### 6.3 `src/main/ipc/dsh.ts` 接线

- 创建 `createDshVersionDetector()` / `createBridgeStateReader()` / 安全模式检查
  （`existsSync(join(watcher.dir, 'safe-mode'))`）；
- 注入 lifecycle；`onCouplingAlert` 实现见 §2.4（`dialog.showMessageBox` + `Notification`，
  `PET_DSH_COUPLING_SILENT_ALERTS=1` 静默）；
- 不新增 IPC channel、不改 `src/shared/types.ts`、不改 `src/main/index.ts`。

### 6.4 新增单测

`tests/dsh-version.test.ts`、`tests/dsh-compat.test.ts`、`tests/dsh-bridge-state.test.ts`；
扩 `tests/dsh-lifecycle.test.ts`（矩阵见 §7.3 验收）、必要时 `tests/dsh-ipc.test.ts`。
全部离线注入，不碰真实 `~/.dsh`/不执行真实 `open`/`kill`。

## 7. 验收标准

### 7.1 单测（teammate 各自跑，Lead 汇总）

- `tests/semver-range.test.ts`（Lead）、`tests/bridge-schema-compat.test.ts`（Lead）
- `tests/bridge-plugin.test.ts`：v4 compat 帧、parity、apply 失败隔离、诊断文件、无未捕获异常
- `tests/dsh-canary-lib.test.ts`、`tests/dsh-patch-lib.test.ts`
- `tests/dsh-lifecycle.test.ts`：语义矩阵（含 §7.3）
- `tests/dsh-version.test.ts`、`tests/dsh-compat.test.ts`、`tests/dsh-bridge-state.test.ts`
- 运行方式（**不要跑全量 `pnpm test`，避免与模型侧会话互相干扰**）：
  `pnpm exec vitest run tests/<file>...`

### 7.2 静态与隔离验证

- `pnpm typecheck:node` 必须通过（web 端预计因模型侧 WIP 可能失败，不归因于本轮）；
- `node scripts/dsh-canary.mjs --compat`（临时 DSH_HOME）C1–C6 PASS；
- 真实 `~/.dsh/profiles/desktop/cordis.patch.yml`、`work/live-bridge/**`、
  `~/.dsh/aventurine-pet/**` 在验证前后 sha256/文件集合不变（canary 自带隔离自证）；
- `git status` 中 `src/renderer/**` 的改动（模型侧会话）**不得**被本轮触碰/回滚。

### 7.3 桌宠侧关键回归矩阵（单测必须覆盖）

| # | 场景 | 断言 |
|---|---|---|
| 1 | 握手健康 | `PAIRED`；DSH 显式退出→`dsh-exit` 跟随；崩溃→重启≤2 |
| 2 | 陈旧 control/status（桥未加载） | 不 `PAIRED`；`UNPAIRED`→20s→`DEGRADED(no-bridge-unpaired)`；不重启 DSH |
| 3 | compat 不兼容（`dshRange` 不含 DSH 版本） | 立即 `DEGRADED(compat-incompatible)`；不杀/不重启 |
| 4 | v3 legacy 桥 + DSH 0.2.2-rc.1 | `PAIRED`；legacy 范围不含 DSH（如 0.3.0）→ `DEGRADED` |
| 5 | DSH 版本未知 | 超时后 `DEGRADED(compat-unverified)`；不猜兼容 |
| 6 | `DEGRADED` 下 DSH 进程消失（进入降级时 DSH 在运行） | `quit('dsh-degraded')`；fork 启动次数=0；不 SIGTERM |
| 6b | `DEGRADED` 下 DSH 本就不在运行（startup-failed） | 常驻不 quit；观察到 DSH 运行后其消失才跟随退出 |
| 7 | `DEGRADED` 下 `before-quit` | 不 preventDefault、不 terminate、正常退出 |
| 8 | `DEGRADED` → 握手恢复 | 自动回 `PAIRED`；告警 `recovered` |
| 9 | `STARTING` 拉起失败 180s | `DEGRADED(startup-failed)`；之后不再 launch |
| 10 | `PAIRED` 心跳丢失 30s | `DEGRADED(bridge-lost)`；不杀 DSH |
| 11 | 崩溃重启用尽 | `DEGRADED(crash-recovery-failed)`，**不 quit** |
| 12 | `safe-mode` 文件 | `DISABLED`；不 launch/不 kill/不 cascade；删除后 tick 恢复 |
| 13 | 告警去重 | 同一次 `DEGRADED` 只 `onCouplingAlert` 一次；`SILENT` 注入由 ipc 层保证 |

### 7.4 E2E 与隔离夹具的适配（T4 负责）

新握手门槛会改变既有 `scripts/wave3-e2e/e2e-coupling.mjs` 的假桥夹具语义，必须同步适配：

1. **假桥 control 帧必须带 `bridgeVersion`**（建议 3 = legacy，触发 `BRIDGE_LEGACY_DSH_RANGE` 回退；
   DSH 版本探测器在 E2E 中读到的是真实 `/Applications/DeepSeek Harness.app` 的 0.2.2-rc.1，
   在 legacy 范围内 → 可进入 `PAIRED`）。`scripts/wave3-e2e/lib.mjs` 的 `writeControl` 需加该字段
   （或提供 v4 变体 `writeControlV4({compat})` 供降级场景）。
2. **PAIRED 需要 status online + control attached 同时成立**：旧场景只写 status 的用例要补写 control
   attached，否则会停在 `UNPAIRED`。
3. **告警静默**：E2E 启动桌宠的 env 统一加 `PET_DSH_COUPLING_SILENT_ALERTS=1`，避免模态框卡住 CDP。
4. **safe-mode 隔离**：E2E 用 `PET_DSH_DIR` 指向临时桥目录；safe-mode 文件也落在该临时目录内
   （lifecycle 通过 `watcher.dir` 推导），不得写真实 `~/.dsh`。
5. **新增场景**（能跑则跑，跑不了要在验收报告写明原因）：
   - F：假桥写 `bridgeVersion:4 + compat.dshRange` 不含 DSH 版本 → 桌宠 `DEGRADED`、不杀/不重启假 DSH、
     假 DSH 消失时桌宠跟随退出（`dsh-degraded`）；
   - G：`DEGRADED` 下桌宠退出 → 假 DSH 进程仍存活；
   - H：握手恢复（改成兼容 compat / 补 legacy 版本）→ 自动回 `PAIRED`。
6. E2E 需要最新 `out/`（`electron .` 读 `out/main/index.js`）。若模型侧会话仍在改 `src/renderer/**`，
   **不要跑全量 build**；可尝试只构建 main/preload 的临时 electron-vite 配置，或在模型侧收口后再跑，
   并在验收报告标注"E2E 未跑/原因"。
7. **实施状态（2026-11-11，已完成）**：`scripts/wave3-e2e/lib.mjs` 的 `writeControl` 已默认写
   `bridgeVersion: 3`（legacy，支持 `extra` 覆盖为 v4 compat），`isolatedEnv` 默认
   `PET_DSH_COUPLING_SILENT_ALERTS=1`；`e2e-coupling.mjs` 场景 C 改为断言 `DEGRADED` 常驻，
   新增场景 F（v4 compat 不兼容 → DEGRADED → fake 消失跟随退出 `dsh-degraded`）。
   **实跑结果：A–F 62/62 断言 PASS**（真实 DSH pid/profile/桥文件隔离自证均通过）。
   G/H（DEGRADED 下桌宠退出不杀 DSH / 握手恢复自动 PAIRED）由单测 §7.3 #7/#8 覆盖，
   E2E 暂不重复；如需更完整的实机矩阵可后续补。

## 8. 部署 / 上线（本会话结束后由用户执行，Lead 提供 runbook）

1. 等模型侧会话收口（`git status` 中 `src/renderer/**` 无在途改动）后：
   `pnpm typecheck && pnpm package:dir` → 新 `dist/mac-arm64/AventurinePet.app`；
2. 重新激活桥（带 engines 的 v4 live 副本）：`node scripts/activate-dsh-bridge.mjs --replace --pet-app <app>`
   （会触发 HMR：旧桥 detached → 新桥 attached；**不要在正在跑 Agent 会话的 DSH 上做**，
   选一个空闲时刻）；
3. 用 `pnpm dsh:canary --compat` + 新桌宠实机观察 `control.json` 的 `bridgeVersion=4`/`compat`；
4. 回滚：`node scripts/activate-dsh-bridge.mjs --rollback`（或 `--remove`）。

## 9. 分工与写盘范围（advisory；Lead 统一集成）

| 任务 | 写盘范围 |
|---|---|
| Lead：共享契约层（§3.5）+ 两本文档 + 最终集成/提交 | `src/shared/semver-range.ts`、`src/shared/bridge-schema.ts`、`tests/semver-range.test.ts`、`tests/bridge-schema-compat.test.ts`、`docs/**` |
| T1 bridge：§3.2/§4.1、bridge 常量 v4、README、parity/隔离测试 | `bridge/dsh-aventurine-bridge/**`、`tests/bridge-plugin.test.ts`、`tests/bridge-schema.test.ts` |
| T2 installer：§5 + canary `--compat` + runbook | `scripts/activate-dsh-bridge.mjs`、`scripts/dsh-patch-lib.mjs`（新）、`scripts/dsh-canary.mjs`、`scripts/dsh-canary-lib.mjs`、`tests/dsh-patch-lib.test.ts`（新）、`tests/dsh-canary-lib.test.ts`、`docs/pet-dsh-coupling-runbook.md`（新） |
| T3 pet：§2/§6、`ipc/dsh.ts`、生命周期测试 | `src/main/desktop/dsh-lifecycle.ts`、`dsh-version.ts`（新）、`dsh-compat.ts`（新）、`dsh-bridge-state.ts`（新）、`src/main/ipc/dsh.ts`、`tests/dsh-lifecycle.test.ts`、`tests/dsh-version.test.ts`（新）、`tests/dsh-compat.test.ts`（新）、`tests/dsh-bridge-state.test.ts`（新）、`tests/dsh-ipc.test.ts` |
| T4 verifier（后置）：对抗复核 + 验收报告 | `tests/tmp/**`、`docs/pet-dsh-coupling-verification-2026-11-11.md`（新） |

**硬约束（所有 teammate）**：
- 不碰 `src/renderer/**`（模型侧会话在改）；不跑全量 `pnpm test`/`pnpm build`/`package:dir`；
- 不写真实 `~/.dsh`（只读检查允许）；不 `open -b com.deepseek.dsh`；不 kill 任何真实进程；
- 不执行 `git checkout/stash/clean/reset`、不 commit（Lead 统一收口）；
- 不修改 Lead 所有的 `src/shared/semver-range.ts`、`src/shared/bridge-schema.ts`、
  `docs/research/pet-coupling-compat-plan-review-2026-11-11.md`、本文档与两个 Lead 单测文件
  —— 需要契约变更先发消息给 Lead。
