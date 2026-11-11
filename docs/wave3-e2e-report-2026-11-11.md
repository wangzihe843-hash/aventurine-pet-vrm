# Wave 3 + DSH 双向集成 — 独立实机验证报告（V，隔离环境）

> 日期：2026-11-11 · 任务：task-13（V 独立实机验证）· 验证者：research-external（独立于实现方）
> 工作区：`/Volumes/4TB外置盘/deepseek-harness/aventurine-pet-vrm`（main @ `3893943` + Lead 未提交 Wave3 改动）
> 性质：**只读验证**；不 git commit；不改 `src/**`、`tests/**` 既有文件；只新增 `scripts/wave3-e2e/**`、`tests/tmp/wave3-e2e/**`（gitignore）与本报告。
> 安全红线执行情况：**未重启/终止真实 DeepSeek Harness、未对真实 DSH 发任何信号、未 open 真实 DSH、未修改真实 `~/.dsh`/desktop profile**；所有桌宠进程隔离（`HOME`+`PET_PROFILE`+`PET_DSH_DIR`），打包版启动强制 `PET_DSH_COUPLING_DISABLE=1`；强耦合测试仅用 fake DSH（`PET_DSH_TEST_HOOKS=1` + `PATH` 前置 `open` shim 兜底）。

---

## 0. 一页结论

| # | 验证项（task-13） | 结果 | 断言 | 证据（`tests/tmp/wave3-e2e/`） |
|---|---|---|---|---|
| 1 | 桥隔离 E2E（临时 DSH_HOME + mock LLM 成功/失败回合，独立二次断言） | ✅ **PASS** | 16/16 | `2026-11-10T18-44-37-805Z-bridge/` |
| 2 | 气泡同步 E2E（思考中 → 回复 → 停留 → 段间隐藏 → 下一段 → 结束消失） | ✅ **PASS** | 16/16 | `2026-11-10T18-40-51-388Z-bubble/`（6 张阶段截图） |
| 3 | 强耦合 E2E（fake DSH：拉起 / 重启恢复 / grace 取消 / 级联退出 / pet 退出 SIGTERM） | ✅ **PASS** | 38/38 | `2026-11-10T18-42-44-324Z-coupling/` |
| 4 | 打包版冷启动（资源/VRM/overlay/气泡/winlist/单实例） | ✅ **PASS** | 23/23 | `2026-11-10T18-47-15-666Z-packaged/` |
| 5 | 激活脚本 dry-run / 实际写入 / 幂等 / 回滚 | ❌ **FAIL（1 个真实缺陷）** | 21/23 | `2026-11-10T18-45-02-652Z-activate/` |
| 6 | 回归 `pnpm smoke`（vrm + legacy-pmx 双后端，隔离 profile） | ✅ **PASS** | 11/11 | `2026-11-10T18-47-48-066Z-regression/` |

**总判定：核心链路 PASS（4/5 项），1 项 FAIL 为 Lead-owned 激活脚本的「备份文件名与查找规则不一致」缺陷**：`--rollback`（不带 `--backup`）找不到刚生成的备份，**默认回滚路径不可用**；显式 `--backup` 回滚可用。建议**先修该缺陷再执行真实 desktop profile 激活**（修复量约 1 行 + 1 个用例；本报告只报告不修改 Lead-owned 脚本）。

**未覆盖/风险摘要**：① 纯 `dsh-exit` 级联路径（detached grace 到期时进程已消失且无 tick 竞态）本次未稳定复现，两个 detached+消失场景均因 3s tick 先命中恢复而观测为 `dsh-gone`（语义结果一致：级联退出）；② 打包版 `PET_PROFILE` 不生效 → 使用真实默认 userData（已确认强耦合关闭、未写真实 `~/.dsh`）；③ 打包版未签名 app 的登录项注册失败（Electron 内部报 `Operation not permitted`，但我们的 wrapper 记为 `applied:true`，低优先一致性问题）；④ 真实 DSH HMR 激活未执行（红线留给 Lead）。

---

## 1. 验证环境与安全隔离自证

**环境**（本次实测）：macOS（host 27.2）、Apple arm64；Electron `44.10.2` / Chrome `152.0.7977.169`；Node `v24.21.0` / pnpm `10.20.0`；主屏 `1920×1080`（workArea `1920×963`，scaleFactor 1）；打包产物 `dist/mac-arm64/AventurinePet.app`（601 MB，bundle id `com.aventurine.pet`，含 `model/`、`assets/{vrm,motions,expressions,props}`、`native/winlist/winlist`）。

**隔离手段**
- dev 版：`HOME=<临时>` + `PET_PROFILE=w3e2e-*`（macOS 上 Electron 的 appData 走 NSHomeDirectory，**`HOME` 环境变量不生效**；userData 隔离实际由 `PET_PROFILE` 后缀目录完成——证据见各 run 的 main.log 路径）+ `PET_DSH_DIR=<临时桥目录>`；`PET_DSH_COUPLING_DISABLE=1` 关闭耦合。
- 打包版：`PET_DSH_COUPLING_DISABLE=1`（打包版忽略 `PET_PROFILE`/测试钩子；默认 userData=`~/Library/Application Support/aventurine-pet`，已记录）；`PET_DSH_DIR` 指向临时目录。
- 强耦合：`PET_DSH_TEST_HOOKS=1` + `PET_DSH_TEST_PROCESS_PATTERN=w3e2e-fake-dsh` + `PET_DSH_TEST_LAUNCH_CMD=<本 run launch 脚本>`；**安全闸门**：必须先在 main.log 观测到 `[dsh-process] launch via test hook`、fake 日志出现 `start`，才允许后续操作；对 fake 发信号前用 `ps -o command=` 校验命令行包含本 run 的 `w3e2e-fake-dsh.mjs` 路径；`PATH` 前置 `open` shim，任何真实 `open -b com.deepseek.dsh` 只会被记录、不会执行（**全流程 shim 未被调用**）。
- 真实 DSH 全程只用只读快照（`ps` 找主进程 pid + `~/.dsh` 关键文件签名），**从未发送信号/调用 open**。

**隔离自证（每个 E2E 脚本结束时均断言）**

| 检查 | 结果 |
|---|---|
| 真实 DSH 主进程 pid（全程）= `18926`（另有 Host/Helper 子进程） | 所有 run **before == after** |
| 真实 `~/.dsh/profiles/desktop/cordis.patch.yml` | 签名 `1537:1794325232669.615:0df330447a1ba5e4a5c62f3b90dedac8c2f4f53e80cf4e397bd7e8c026ae1130`，**未变** |
| 真实 `~/.dsh/aventurine-pet/{status.json,events.jsonl}` | 仍为 2026-11-07 的 `96B`/`396B` 旧文件，签名**未变**（桥从未装进真实 profile） |
| 真实 `open -b com.deepseek.dsh` | **0 次调用**（PATH shim 日志为空；main.log 无 `launch open -b`） |
| 真实 desktop profile 备份 | 仅有历史的 `cordis.patch.yml.bak-20261109-195209`（非本次产生） |

> 副作用（可接受、可清理）：因 Electron 忽略 `HOME`，dev 测试的 userData 落在真实 `~/Library/Application Support/aventurine-pet-w3e2e-*`（8 个，均为小型日志/缓存）；打包版实测向默认 userData 的 `logs/main.log` 追加本次日志（25 KB 级）。如需清理：`rm -rf ~/Library/Application\ Support/aventurine-pet-w3e2e-*`（不影响默认 `aventurine-pet/`）。

---

## 2. 逐项验证详情

### 2.1 ① 桥隔离 E2E — ✅ PASS 16/16

**命令**：`node scripts/wave3-e2e/e2e-bridge.mjs`
（内部执行 `node scripts/dsh-canary.mjs --keep`：临时 `DSH_HOME` + profile `pet-canary` + 本地 mock LLM；`AVENTURINE_BRIDGE_DISABLE_LAUNCH=1`）

**结果（canary 关键输出）**
```
6/6 成功回合断言：PASS（事件 task/start → session/event → session/event → task/end；
  text=["canary-mock: 桥文本透传 OK。"]；control attached → detached）
PASS 桥与当前 DSH 的事件/文本/control 契约匹配。
```
**本脚本独立二次断言**（直接读保留目录的桥产物，不依赖 canary 自证）：
- `success-turn` 的 `events.jsonl` 存在 `session/event` 且 `payload.eventType==='assistant/message'`、`payload.text` 与 mock 注入文本**完全一致**（`canary-mock: 桥文本透传 OK。`）；
- `control.json` 终态 `{schemaVersion:1, action:'detached', dshPid}`；canary 轮询观测到 `attached → detached`；
- 失败回合 events 含 `task/error`，成功回合**无** `task/error`；失败回合最终 status 为 `{offline:true, running:false}`；
- 隐私白名单：user 输入哨兵（`canary-success-sentinel`/`canary-fail-sentinel`）与 reasoning 哨兵**均未出现在 payload.text**；
- 真实 `~/.dsh` 与真实 DSH pid 未变（见 §1）。

**证据**：`tests/tmp/wave3-e2e/2026-11-10T18-44-37-805Z-bridge/`
`canary.stdout.log`、`artifacts/`（固化的 events/control/status 副本 + parsed JSON）、`bridge-evidence.json`、`result.json`。
（canary `--keep` 的原始临时目录：`/var/folders/…/T/pet-dsh-canary-oumosJ`，可删。）

### 2.2 ② 气泡同步 E2E — ✅ PASS 16/16（核心）

**命令**：`node scripts/wave3-e2e/e2e-bubble.mjs`
**方法**：隔离 dev 版（真实 VRM 渲染）+ 临时桥目录；写 `status.json(online,running)` + `control.json(attached)`；用 remote debugging（CDP）读 `.pet-bubble` 文本/可见性并截图；注入 `task/start` → `session/event(assistant/message, text A)` → `task/end`（中间夹 text B）驱动状态机。

**三阶段实测（时间线）**
| 阶段 | 注入 | DOM 断言 | 截图 |
|---|---|---|---|
| 1 思考中 | `task/start` | `.pet-bubble` 可见、文本 **`思考中...`**（visibility=visible, opacity≈0.54 淡入中） | `01-thinking-*.png` |
| 2 回复 A | `session/event` text=`你好呀，我是砂金。今天想看我表演什么？` | 可见、文本**逐字完整一致** | `02-reply-a-*.png` |
| 3 段间隐藏 | （dwell 到期） | 气泡 `visible=false`（段间 GAP 350ms 窗口被捕获；随后回到「思考中」） | `03-gap-*.png` |
| 4 下一段 B | `session/event` text=`第一段看完了？那再给你变个小把戏，别眨眼。` | 可见、文本完整一致 | `04-thinking-again-*.png`、`05-reply-b-*.png` |
| 5 结束消失 | `task/end` | 队列播完 + 隐藏后 **保持隐藏 ≥1.2s** | `06-ended-*.png` |

**量化断言**
- 停留时长：期望 `clamp(2200+45×len, 2200, 9000)` = **3055 ms**（19 字），实测可见段 **3163 ms**（误差 +108ms，在容差内）；
- 结束/间隙后无残留文本；`window.__aventurineDebug.errors` 为空；main.log 无 renderer crash；隔离日志无真实 DSH 操作痕迹；
- 截图 6 张（整页 + 气泡裁剪特写；特写可见「思考中...」与两段完整回复文本）。

**证据**：`tests/tmp/wave3-e2e/2026-11-10T18-40-51-388Z-bubble/`
`bubble-evidence.json`、`timeline.jsonl`、`shots/01-thinking-full|bubble.png` … `06-ended-*`、main.log 路径记录。
气泡特写示例：`shots/01-thinking-bubble.png`（「思考中...」）、`shots/02-reply-a-bubble.png`（完整回复 A）、`shots/05-reply-b-bubble.png`（下一段 B）。

### 2.3 ③ 强耦合 E2E（fake DSH）— ✅ PASS 38/38

**命令**：`node scripts/wave3-e2e/e2e-coupling.mjs`
**安全**：`PET_DSH_COUPLING=1` + 测试钩子 + PATH `open` shim + fake 命令行校验；**每个场景先过安全闸门**（hook 日志 + fake 启动）才继续；对 fake 的 kill 前校验 `ps` 命令行为本 run 路径。

| 场景 | 实测 | 关键日志（`main.log`） |
|---|---|---|
| **A 拉起→重启→退出** | pet 启动后**自动拉起 fake**（pid 44743）；status online → **PAIRED**；SIGKILL fake → tick 2.3s 内进入恢复 → 拉起新 fake（pid 44767）→ **5s 验证通过 `DSH 已恢复`**；pet 显式退出（`window.api.quit()`）→ fake 收到 **SIGTERM**（fake.log `sigterm`）→ **183ms 优雅终止** → pet 退出（code 0） | `已拉起 DSH（open -b 幂等）`→`进入 PAIRED（bridge-online）`→`DSH 疑似退出，进入重启恢复（process-gone）`→`DSH 已恢复`→`桌宠退出：先终止 DSH`→`已终止 DSH pid=44767（terminated，183ms）` |
| **B HMR grace 取消** | detached 后进入 1500ms grace；400ms 内 attached → **取消级联**；无重启（fake 启动次数=1）、pet 存活 | `收到 detached，等待重新 attached（grace）{"graceMs":1500}` → `桥已 attached（PAIRED）` |
| **C 重启失败→级联** | fake 被 SIGKILL 后恢复 2 次均失败（一次性拉起 wrapper）→ **级联退出 `dsh-gone`**，pet 退出 code 0 | `尝试重启 第1/2 次` → `第2/2 次` → `重启次数已达上限` → `级联退出（dsh-gone）` |
| **D detached + 消失→级联** | detached 后 kill fake → **级联退出**（本 run 观测为 `dsh-gone`），pet 退出 code 0 | `级联退出（dsh-gone）：DSH 已不可恢复` |

**其它断言**：每个场景 `open` shim 未被调用；fake 进程全部清理；真实 DSH pid 不变；真实 desktop patch / bridge 目录签名不变。

**覆盖说明（重要）**：设计 §4.1 区分 `dsh-exit`（detached grace 到期且进程已不在→跟随退出、不重启）与 `dsh-gone`（进程消失且重启失败→级联）。本次 D 场景存在 **3s tick 与 1.5s grace 的竞态**：先观测到 tick 的 `process-gone` 恢复路径，最终原因为 `dsh-gone`。两者**用户可见语义一致**（都由 DSH 消失导致 pet 级联退出、且不互杀）；`dsh-exit` 精确分支由 Lead 的全量单测覆盖（2417 tests），本次实机未稳定复现，列为未覆盖项。

**证据**：`tests/tmp/wave3-e2e/2026-11-10T18-42-44-324Z-coupling/`（`scenarios/{a,b,c,d}/{fake.log,fake.pid,scenario.json,pet-dev.stdout.log}`、`open-shim.log` 不存在、`result.json`；各场景 main.log 在 `~/Library/Application Support/aventurine-pet-w3e2e-cpl-{a,b,c,d}/logs/main.log`）。

### 2.4 ④ 打包版冷启动 — ✅ PASS 23/23

**命令**：`node scripts/wave3-e2e/e2e-packaged.mjs`
**方法**：直接执行 `dist/mac-arm64/AventurinePet.app/Contents/MacOS/AventurinePet`（非 `open`），隔离桥目录 + `PET_DSH_COUPLING_DISABLE=1` + remote debugging。

**实测**
- 资源齐全：`app.asar`、`model/`、`assets/vrm`（4 个 `.vrm`）、`assets/motions`、`native/winlist/winlist` 均在 `Contents/Resources`；
- 主进程启动：stdout `[main] aventurine-pet overlays created on workArea x1 display(s)`、main.log `[config] 配置 IPC 已注册`；
- VRM：`debug.ready=true`、`model.loaded=true`、`humanoidBoneCount=53`、`animationClip=adv-idle`、`textureCount=20`、`errors=[]`（无资源错误）；
- overlay 内 `.pet-bubble` DOM 存在；注入 fake 桥 `task/start` → 显示「思考中...」；注入 `assistant/message` → 显示「打包版气泡同步验证：这是一句来自 DSH 桥的回复文本。」（截图 `shots/packaged-thinking.png`、`shots/packaged-reply.png`）；
- **winlist helper**：高频采样捕获到真实 spawn（pid 46056，`Resources/native/winlist/winlist`）；
- **单实例锁**：启动第二实例 → **立即退出（code 0）**，第一实例存活且 CDP 仍可响应；
- 本次启动日志：**无**资源错误行；**无**耦合动作（`拉起/终止/级联`）；**无**真实 `open -b`；
- 真实 DSH/~/.dsh 快照未变。

**打包版注意事项（本次实测发现，非阻断）**
1. macOS 上 `HOME` 对 Electron `appData` 不生效、`PET_PROFILE` 打包版忽略 → 使用真实默认 userData `~/Library/Application Support/aventurine-pet`（实测向 `logs/main.log` 追加日志）。已确认无真实 DSH 耦合（`PET_DSH_COUPLING_DISABLE=1`）。
2. 未签名 app 从 dist 路径运行时登录项 API 失败：stdout `ERROR:electron/shell/common/platform_util_mac.mm:221] Unable to set login item: The operation couldn't be completed. Operation not permitted`；而 `src/main/login-item.ts` 的 wrapper 仍记录 `applied:true`（Electron API 未抛错）。当前配置 `launchAtLogin=false`，无用户可见影响；**建议**未来让登录项结果以 `app.getLoginItemSettings()` 复核（低优先）。
3. stdout 另有 `sandbox_extension_issue_file failed for … Helper.app/Contents/Resources` 警告——未签名/非 `/Applications` 运行的常见现象，不影响启动与渲染（本机自用 `--dir` 包可接受；对外分发需签名/公证，不在验收范围）。

**证据**：`tests/tmp/wave3-e2e/2026-11-10T18-47-15-666Z-packaged/`（`packaged-evidence.json`、`shots/*.png`、`pet-packaged*.stdout.log`、`result.json`）。

### 2.5 ⑤ 激活脚本 dry-run / 回滚 — ❌ FAIL（真实缺陷：备份名不一致导致默认回滚不可用）

**命令**：`node scripts/wave3-e2e/e2e-activate.mjs`（指向**临时 fake DSH_HOME**：`…/fake-dsh-home/profiles/desktop/cordis.patch.yml`，绝不指向真实 `~/.dsh`）

**通过的断言（21 项）**
- `--dry-run`：exit 0、打印目标路径与将追加的 insert 块、**不写文件**、不产生备份；
- 实际写入：exit 0、文件变化、**PyYAML 可解析**、含 `id: aventurine-bridge` / `name: <repo>/bridge/dsh-aventurine-bridge/lib/index.js` / `launchPet: true` / `petAppPath: <dist app>` / `petBundleId: "com.aventurine.pet"`，且**保留原有条目**；
- 备份已创建（内容与原始逐字节一致）；幂等：重复激活 **exit 1** 且提示「已包含 id: aventurine-bridge」；
- 显式 `--rollback --backup <实际备份>`：exit 0，恢复后 hash == 原始；`--rollback --dry-run` 不写文件；
- 全程真实 `~/.dsh` 未变。

**失败断言（2 项，同根因）**
- `rollback-auto-finds-backup`：写入后执行 `--rollback`（不带 `--backup`）→ **exit 1**「找不到可回滚的备份」；
- `rollback-dry-run-exit-0`：同上，`--rollback --dry-run` 也失败（1）。

**根因（源码定位，Lead-owned 文件 `scripts/activate-dsh-bridge.mjs`）**
```js
const backupPath = `${patchPath}.${BACKUP_PREFIX}${Date.now()}`   // L259
// patchPath 已含文件名 → 实际生成：
// cordis.patch.yml.cordis.patch.yml.bak-wave3-<ts>   ← 双前缀
function findLatestBackup(patchPath) {
  .filter(name => name.startsWith(`${base}.bak-wave3-`))          // 期望 cordis.patch.yml.bak-wave3-*
}
```
→ 生成的备份名与查找前缀不匹配，`findLatestBackup` 永远返回 `null`，**默认 `--rollback` 不可用**；`--rollback --backup <path>` 可正常恢复。**修复建议（1 行）**：`const backupPath = `${patchPath}.bak-wave3-${Date.now()}``（或同步调整 `findLatestBackup` 前缀），并补一条「activate → rollback（默认）」的自动化用例。本报告**未修改**该脚本（写作用域/所有权约束）。

**影响**：激活写入本身可用（HMR 追加 insert 行），但 Lead 在真实 desktop profile 激活后若需回滚，**必须显式传 `--backup`**，否则默认回滚会失败——建议修复后再执行真实激活。**证据**：`tests/tmp/wave3-e2e/2026-11-10T18-45-02-652Z-activate/`（`result.json`、`activate-*.log`、fake home 目录与备份文件）。

### 2.6 ⑥ 回归 `pnpm smoke`（vrm + legacy-pmx 双后端）— ✅ PASS 11/11

**命令**：`node scripts/wave3-e2e/e2e-regression.mjs`（内部 `pnpm run smoke`，env：`PET_PROFILE=w3e2e-smoke-{vrm,legacy}` + `PET_DSH_COUPLING_DISABLE=1`，legacy 另加 `PET_MODEL_BACKEND=legacy-pmx`/`PET_ANIM_BACKEND=legacy-pmx`）

**结果**
- vrm：exit 0、`SMOKE_OK`、`backends={modelBackend:'vrm',animBackend:'vrm'}`、`render.ready=true`、`model.loaded=true`（`missingTextures:[]`）；
- legacy-pmx：exit 0、`SMOKE_OK`、`backends={modelBackend:'legacy-pmx',animBackend:'legacy-pmx'}`、`render.ready=true`、`model.loaded=true`（20 材质/20 贴图、`missingTextures:[]`）；
- smoke 负载同时覆盖：overlay 构造常量 `transparent:true / ignoreMouse:true / sandbox:true`、托盘、pointerGate、settings 窗、preload `apiMethodCount=18`、协议资源加载、`accessibility=true` 等；
- 真实 DSH pid / desktop patch / bridge 目录未变。

**证据**：`tests/tmp/wave3-e2e/2026-11-10T18-47-48-066Z-regression/`（`smoke-vrm.{stdout,stderr}.log`、`smoke-legacy.*`、`smoke-{vrm,legacy}.json`、`regression-evidence.json`、`result.json`）。

---

## 3. 安全红线核对表（全程）

| 红线 | 执行 | 证据 |
|---|---|---|
| 不重启/终止真实 DSH | ✅ 未执行任何 send/open/kill；真实 pid `18926` 全程存活且未变 | 每个 run 的 `real-dsh-pids-unchanged` 断言 |
| 不 `open -a` 真实 DSH | ✅ `open` shim 未被调用（0 条记录）；日志无 `launch open -b` | 各 run `open-shim-not-invoked` / `no-real-open-*` 断言 |
| 不修改真实 `~/.dsh` / desktop profile | ✅ desktop patch 签名、bridge 目录签名未变；未产生真实 profile 备份 | 各 run `real-desktop-patch-unchanged` / `real-bridge-dir-unchanged` |
| 启动桌宠隔离 `HOME`/`PET_PROFILE` | ✅ 所有 dev 进程 `PET_PROFILE=w3e2e-*` + 临时 `PET_DSH_DIR`；打包版 `PET_DSH_COUPLING_DISABLE=1` | main.log `dev userData isolated for PET_PROFILE=…`、各断言 |
| 强耦合仅 fake DSH | ✅ 测试钩子 + fake 进程 + PATH shim + 信号前命令行校验；净空后无残留 fake 进程 | coupling `safety-*` 断言、`fake.log`、进程清理 |
| 不 git commit / 不改既有 src/tests | ✅ 未提交；仅新增 `scripts/wave3-e2e/**` 与本报告；`tests/tmp` 为 gitignore 证据区 | `git status`（`src/**` 的 M 均为 Lead 既有改动，非本次产生） |

---

## 4. 未覆盖项 / 风险 / 建议

| 项 | 说明 | 建议 |
|---|---|---|
| 激活脚本默认回滚不可用 | 见 §2.5：备份名 `cordis.patch.yml.cordis.patch.yml.bak-wave3-*` 与查找前缀 `cordis.patch.yml.bak-wave3-*` 不匹配 | **P1：修复后再做真实 HMR 激活**（1 行 + 用例）；修复前回滚必须显式 `--backup` |
| `dsh-exit` 精确分支未实机复现 | 3s tick 与 1.5s grace 竞态，D 场景观测为 `dsh-gone`；语义一致（级联退出） | 由单测覆盖即可；如需 E2E 精确分支，可加测试钩子冻结 tick（改动实现，需 Lead 决定） |
| 打包版 userData 未隔离 | macOS Electron appData 忽略 `HOME`；打包版忽略 `PET_PROFILE` → 写真实默认 userData | 已确认无 DSH 耦合风险；如需严格隔离，可在 packaged 版支持 `PET_PROFILE` 或 `--user-data-dir`（非必须） |
| 打包版登录项 | 未签名 app 从 dist 运行：Electron 内部 `Operation not permitted`，wrapper 仍返回 `applied:true` | 低优先：用 `app.getLoginItemSettings()` 复核真实状态，失败时如实返回 |
| overlay 像素级透明 | CDP `Page.captureScreenshot` 合成白底（截图证据用于 DOM/文本，不用于透明度判定）；透明性由 smoke 的 `constructOnly.transparent=true` + 窗口创建日志间接覆盖 | 如强需求证，可用 native `CGWindowList` 检查窗口 alpha/层次（需更多 native 权限探测，本轮未做） |
| 真实 DSH HMR 激活 | 按红线**未执行**（Lead 执行） | 修复 §2.5 缺陷后，按设计 §10 备份 → 追加 → 观察 control/status/心跳 → 实机气泡 |
| 多显示器 / 长时间稳定性 / 真实模型回合 | 本轮未覆盖（单主屏；mock/桥文件注入；未跑真实 LLM 回合） | 可在后续验收补：真实回合 1 次（需用户同意费用）+ 双屏拖拽/全屏 Space |
| canary/临时目录残留 | `--keep` 保留的 `/var/folders/.../pet-dsh-canary-*` 与 `tests/tmp/wave3-e2e/**` 均在本机临时/gitignore 目录 | 可随时删除，不影响真实数据 |

**结论**：Wave3 + DSH 集成在隔离实机环境下**核心链路全部 PASS**（桥 v2 文本/control、气泡四段节奏、强耦合状态机、打包版冷启动+单实例+bubble、双后端 smoke 回归）；**唯一 FAIL 为激活脚本备份命名缺陷**（不影响运行时功能，但影响回滚安全），建议修复后再执行真实 desktop profile 激活。

---

## 5. 复跑方式与证据索引

```bash
# 全部脚本（在仓库根目录；均自带隔离与真实 DSH 只读快照断言）
node scripts/wave3-e2e/probe-cdp.mjs      # 基础设施自检（CDP/隔离/VRM）
node scripts/wave3-e2e/e2e-bridge.mjs     # ① 桥隔离（含 canary --keep + 独立断言，约 45-90s）
node scripts/wave3-e2e/e2e-bubble.mjs     # ② 气泡三阶段（约 30-45s）
node scripts/wave3-e2e/e2e-coupling.mjs   # ③ fake DSH 强耦合（约 60-90s）
node scripts/wave3-e2e/e2e-packaged.mjs   # ④ 打包版冷启动（约 60-90s）
node scripts/wave3-e2e/e2e-activate.mjs   # ⑤ 激活脚本 dry-run/回滚（<5s）
node scripts/wave3-e2e/e2e-regression.mjs # ⑥ pnpm smoke 双后端（约 2-4min）
```

- 公共库：`scripts/wave3-e2e/lib.mjs`（隔离 env、CDP 客户端、桥文件注入、真实 DSH 快照、断言收集）。
- 本次结果目录：`tests/tmp/wave3-e2e/<UTC 时间戳>-<name>/`（`result.json` 为逐条断言 PASS/FAIL + 证据路径）。
- 关键证据速查：
  - 气泡截图：`tests/tmp/wave3-e2e/2026-11-10T18-40-51-388Z-bubble/shots/`（6 张 × 整页+特写）
  - 打包版截图：`tests/tmp/wave3-e2e/2026-11-10T18-47-15-666Z-packaged/shots/packaged-{ready,thinking,reply}.png`
  - 强耦合 fake 日志：`tests/tmp/wave3-e2e/2026-11-10T18-42-44-324Z-coupling/scenarios/{a,b,c,d}/fake.log`
  - 激活缺陷证据：`tests/tmp/wave3-e2e/2026-11-10T18-45-02-652Z-activate/result.json`（`failures` 两条）
  - canary 原始输出：`tests/tmp/wave3-e2e/2026-11-10T18-44-37-805Z-bridge/canary.stdout.log`
  - smoke 双后端：`tests/tmp/wave3-e2e/2026-11-10T18-47-48-066Z-regression/smoke-{vrm,legacy}.stdout.log`

> 备注：本报告所有结论均来自本次实机命令与文件证据；早期脚本自身缺陷（CDP 等待条件、main.log 路径发现、日志过滤等）已在 `scripts/wave3-e2e/**` 修复，不影响最终结果。未对 `src/**`、`tests/**` 或 Lead-owned 脚本做任何修改。
