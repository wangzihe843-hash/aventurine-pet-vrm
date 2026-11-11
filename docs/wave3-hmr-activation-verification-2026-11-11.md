# Wave 3 HMR 激活验证：不重启 DSH 加载新桥代码 + 拉起 env 修复 + 免重启激活 Runbook（2026-11-11）

> 任务：`task-15`（H 隔离验证）。执行者：hmr-verifier。工作区：`/Volumes/4TB外置盘/deepseek-harness/aventurine-pet-vrm`。
> 背景：Lead 在真实 desktop profile 临时激活桥插件时发现（a）`open` 拉起的桌宠继承了 DSH Host 的 `ELECTRON_RUN_AS_NODE=1` 而以 Node 模式退出；（b）桥代码改为「直接 spawn `.app` 内可执行文件 + 清洗 env」后，再次 HMR recompose 疑似仍执行旧代码（仍出现 LaunchServices 的 `open` 调用）。真实 profile 已回滚（`hash` 与 `/tmp/w3-real-patch-pre-activation.yml` 一致；`control.json` = `detached`；真实 DSH 仍存活）。
> **本报告全部结论来自临时 DSH_HOME + 临时 profile + 内置 CLI 的隔离实测**；未写真实 `~/.dsh`、未重启/终止真实 DSH、未 `open` 真实 app（fixture 只写 `/tmp`）、未 git commit。证据：`tests/tmp/w3-hmr/`（gitignored）。

---

## 0. 结论速查

| # | 问题 | 结论 | 关键证据 |
|---|---|---|---|
| a1 | HMR recompose 会重新求值**同一模块路径**的仓库源码吗？ | **不会。** 在默认 `hmr.root: []` 配置下，HMR 只比较 **profile 目录 + profile `node_modules` 里 symlink 的 linked 包**（`app.asar/.../dsh-hmr/lib/index.js:1454-1459` 的 `profileRoots`），仓库源码不在比较范围；改 `lib/index.js` 不触发任何 reload。 | 主实验 A1：改 `constants.js` 2→3 后 4s 无任何 apply；`tests/tmp/w3-hmr/probes/probe.jsonl` 仅 1 行 apply v2 |
| a2 | 手动触发一次 recompose（改 profile patch）会加载磁盘新代码吗？ | **不会。** recompose 会 `dispose + apply`，但 apply 执行的仍是旧模块代码（Node ESM 按 URL 缓存；`bridgeVersion` 仍为 2，而磁盘已是 3）。config 变更会生效、代码不会。 | A2：`dispose v2 → apply v2`（磁盘 constants=3）；control `bridgeVersion=2` |
| a3 | 回滚后（row 移除）再**用同一路径**追加 insert，会加载新代码吗？ | **不会。** Host 进程内的 ESM 模块缓存是进程生命周期的；只要同一 URL 曾被 import，后续 entry 重启仍复用旧 namespace。 | A4：remove → re-add 同路径，apply 仍 v2 |
| a4 | 只换入口路径、保留同一 row id 行吗？ | **不生效（最坑）。** 同一 `id` 的 entry 被 Include 按 id 复用；改 `name` 不会重新 import（实测 dispose/apply 都不发生或仍执行旧代码）。 | 主实验 B（新路径同 id）→ apply 仍 v2；activate-sim S2（同 id + 新路径 v12）→ 无任何 probe/control 变化 |
| a5 | 只换 row id、路径不变？ | **不生效。** 新 entry 会 import，但同一 URL 命中旧 ESM 缓存 → 旧代码。 | 主实验 B3：新 id + 旧路径 → apply v2（磁盘已 v5） |
| b1 | 哪种免重启方案可行？ | **换「新 row id + 新模块路径（新目录）」**：Loader 新建 entry + Node 以新 URL import → 执行新代码。**首次激活（row 已被回滚移除）可以只换新路径、保留原 id**；但**后续升级必须同时换 id+路径**。 | activate-sim S1（冷 profile + 同 id + 新路径 v11）✅；S3（新 id + 新路径 v12）✅；S2（同 id + 新路径）❌ |
| b2 | 备选方案验证 | ① HMR `root` 源码 watch：配置后改文件会自动 reload（同 id/path 也可）✅；② linked 包：HMR 比较 linked target，改文件+recompose 可热加载（同 id/path）✅；③ file URL `?rev=` query：只对**单文件自包含**模块有效；桥有相对 `./constants.js` import，query 换不掉其缓存，不推荐现状使用。 | E1：`- id: hmr config: root: [<plugin lib>]` 后改 constants 5→9，自动 dispose/apply **v9**；linked：11→21（同 id/path）；solo：`?rev=2` → v2，重复同 URL → stale |
| c1 | 拉起修复（direct-exec + 清洗 env）在模拟真实 Host（`ELECTRON_RUN_AS_NODE=1`）下有效吗？ | **有效。** Host 环境确有 `ELECTRON_RUN_AS_NODE=1`（探针记录）；FakePet 以 **直接 exec** 方式启动（argv=可执行文件、无参数、ppid=Host pid），其 env 中 `ELECTRON_RUN_AS_NODE` **已不存在**，`DSH_HOME/HOME/PATH` 保留；单次 apply 只拉起 **1 次**。 | `tests/tmp/w3-hmr/launch/launch.log`；`launch/probe-launch-verify.jsonl`（`electronRunAsNode:"1"`） |
| c2 | 回退 `open` 行为？ | 现有代码只在 `.app` 解析不到内部可执行时回退 `open`；**回退分支未清洗 env**（`bridge/lib/index.js:503`），实测 fake `open` 收到的 env 仍有 `ELECTRON_RUN_AS_NODE=1` —— 即原 bug 在 fallback 路径仍存在。真实 `.app` 解析成功（`dist/mac-arm64/AventurinePet.app/Contents/MacOS/AventurinePet`）时走 direct-exec，不触发该问题。 | `launch/open.log`（missing `.app` → `open <path>` env 含 1；bundleId → `open -b` 同样） |
| c3 | 每次 HMR recompose 会怎样？ | 桥的 `launchPetOnce` 是「每个 apply 实例一次」；**每次 apply 都会再拉起一次桌宠**。实测一次 patch 变更后 Launch 计数 1→2。**打包版桌宠有自己的单实例锁**（`src/main/index.ts:2746` `!app.isPackaged || requestSingleInstanceLock()`），第二次会被合并/退出；仍建议激活后不要无故再改 patch。 | `launch/launch-recompose.log`（2 行）、`probes/probe-launch.jsonl` |
| d | 最终 Runbook | 见 §5：真实 profile 当前状态核对 → 生成 new-path live 副本 → 备份 → 追加 new-path insert（可复用 `scripts/activate-dsh-bridge.mjs --bridge-entry <live path>`）→ 观察 control/status/拉起 → 校验清单 → 回滚步骤。 | §5 + `tests/tmp/w3-hmr/activation-script/` |

**一句话**：Lead 观察到的「HMR 后仍执行旧代码」被完全复现并定位——**在同一 Host 进程里，桥「同一路径 + 同一 row id」的源码改动永远不会被重新求值**；不重启 DSH 的唯一可靠加载方式是**从未被 import 过的新模块路径**（首激活可保留原 id），**后续升级需新 id + 新路径**。真实 desktop profile 在 09:49 那次激活已经让 Host 缓存了旧模块，所以**不能**再对 `repo/bridge/.../lib/index.js` 原路径做「重新追加」——必须使用新的 live 副本路径。

---

## 1. 实验环境与方法

### 1.1 隔离环境（红线遵守）

- 临时 DSH_HOME：`/tmp/w3-hmr/home`（`DSH_HOME`）；临时 profile 由内置 CLI 从 `web` 模板创建（`hmr-a` / `hmr-b` / `launch-a` / `launch-disabled` / `query-a` / `activate-sim` / `linked-a` / `launch-verify`）。
- 内置 CLI：`/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh`；以 `dsh --profile <p> --no-open --host 127.0.0.1 --port 41<xxx>` 启动临时 Web Host（HMR 默认开启，`profileContext.name` = profile 名）。
- 真实 `~/.dsh`、真实 desktop profile 完全只读：仅做 hash/文件内容核对（`tests/tmp/w3-hmr/real-state/`）；真实 DSH 进程未动（pid 18937 连续存活）。
- 拉起床宠只使用临时 fixture `FakePet.app` + fake `open`（`/tmp/w3-hmr/fixture`、`/tmp/w3-hmr/fake-bin`），日志只写 `/tmp`/证据目录。
- 实验结束后所有临时 Host 均 `SIGTERM` 关停并确认无残留（dispose 探针记录可见）。

### 1.2 观测手段

- 给桥插件**副本**加了一个仅测试用的 `probeLog()`（`apply` / `dispose` / `BRIDGE_PLUGIN_VERSION` / `ELECTRON_RUN_AS_NODE` / 桥 dir 写到 `W3_HMR_PROBE_LOG`）；生产插件不含该函数（`tests/tmp/w3-hmr/probe-plugin/` 保存了带探针的副本）。
- 观测文件：`~/.dsh` 等价物 → 临时 `bridge-out-*/{control.json,status.json,events.jsonl}`；Host 日志、fixture 日志；必要时用 CLI `--dump-config` 复核组合结果（只读、独立进程）。
- 每次 HMR 判定为：probe 日志出现 `dispose/apply` 及其 `version`（= 该次执行代码内 `BRIDGE_PLUGIN_VERSION`），并与磁盘 constants 对照。

### 1.3 真实 profile 当前状态（只读核对）

`tests/tmp/w3-hmr/real-state/README.txt`（2026-11-11T01:58:58Z 采集）：

- 真实 `cordis.patch.yml` sha256 = `0df330447a1ba5e4a5c62f3b90dedac8c2f4f53e80cf4e397bd7e8c026ae1130`，与 `/tmp/w3-real-patch-pre-activation.yml` **一致**；
- 真实 patch 中 **无** `aventurine-bridge` 行（回滚完成）；
- `~/.dsh/aventurine-pet/control.json` = `{"schemaVersion":1,"ts":1794361757482,"action":"detached","dshPid":18937}`；`status.json` = `offline:true`；
- 真实 DSH Host 进程 **pid 18937**（父 18926）自 21:26（本地）起持续存活——**09:49 激活与回滚都没有重启 Host，ESM 模块缓存仍在**（见 §2.3）。

---

## 2. 发现（a）：HMR 对仓库 in-place 源码不会重新求值

### 2.1 同一路径改源码：无 reload；触发 recompose 仍执行旧代码

实验 profile `hmr-a`，patch insert 绝对路径 `/tmp/w3-hmr/plugin-a/lib/index.js`（repo 桥插件副本，`BRIDGE_PLUGIN_VERSION=2`）：

| 步骤 | 操作 | probe 结果（关键） | 结论 |
|---|---|---|---|
| A0 | 启动 Host（port 41901） | `apply v2`；control attached v2 | 基线 |
| A1 | 改磁盘 `constants.js`：`BRIDGE_PLUGIN_VERSION=2→3`，**不改 patch**，等 4s | 仅 1 行 apply（无新事件） | 默认 `hmr.root=[]` 不 watch 仓库源码 |
| A2 | 改 patch 给 bridge row 加 `rotateBytes`，等 4s | `dispose v2 → apply v2`（磁盘已是 3）；control 仍 v2 | recompose 会重启插件，但执行**旧模块**；config 变更生效（dir/configKeys 反映新配置） |
| A4a | 整行删除（回滚模拟），等 3s | `dispose v2`；control `detached` v2 | 正常卸载 |
| A4b | **同路径**重新追加 insert，等 3s | `apply v2`（磁盘 3） | 进程级 ESM 缓存复用，旧代码 |

证据：`tests/tmp/w3-hmr/probes/probe.jsonl` 前 14 行；`patches/01..04`。

### 2.2 「换行/换 id」的组合矩阵（决定免重启方案）

在同一个运行中的 Host（pid 76607）依次测试（`probes/probe.jsonl`）：

| 场景 | row id | 入口 path | 磁盘代码版本 | 实际 apply 版本 | 结果 |
|---|---|---|---|---|---|
| 原 row（基线） | `aventurine-bridge` | `/tmp/w3-hmr/plugin-a/lib/index.js`（已缓存） | 3/5 | **2** | 旧代码 |
| B：同 id + **新 path**（plugin-b） | `aventurine-bridge` | `/tmp/w3-hmr/plugin-b/lib/index.js` | 4（全新 URL） | **2** | ❌ 同 id 的 row 被 Include 复用，未 re-import |
| B2：**新 id + 新 path** | `aventurine-bridge-b` | `plugin-b/lib/index.js` | 4 | **4** | ✅ 新 entry + 新 URL |
| B3：**新 id + 旧 path**（已缓存） | `aventurine-bridge-c` | `plugin-a/lib/index.js` | 5 | **2** | ❌ URL 缓存 |
| E1：同 id/path + **hmr root watch** | `aventurine-bridge-c` | `plugin-a/lib/index.js` | 5→9 | **9**（自动） | ✅ HMR 主动 evict 模块 |
| S2：同 id + 新 path（v12） | `aventurine-bridge` | `plugin-live-v12/lib/index.js` | 12 | 无 apply/control 变化（仍 11） | ❌ 同 id 变更被忽略 |

结论：
1. 只改源码（不碰 patch）→ 无任何发生；
2. 只换 `name`、保留 row `id` → Include 按 id 复用 entry，**不会重新 import**（甚至不重启）；
3. 只换 `path` 但 path 已被本进程 import 过（缓存 URL）→ 仍旧代码；
4. **新 id + 从未 import 过的新 path → 新代码**（B2/activate-sim S3）；
5. 若 row 已被完全移除（回滚后），**再插入时 path 是新的即可**（id 可以沿用）——activate-sim S1（冷 profile → 同 id `aventurine-bridge` + 新 path v11 → apply v11）。

### 2.3 机制（源码依据）

- HMR 只对 **profile 目录 + profile `node_modules` 中 symlink 的 linked 包**做文件比较：`profileRoots(dir)` 返回 `[profileDir, ...linkedTargets]`（`app.asar/dsh/node_modules/@deepseek-ai/dsh-hmr/lib/index.js:1454-1459`）；recompose 时只对 `profileModules(profileRoots(profile.dir))` 比较并 evict（`:1325-1360`）。仓库源码（`/Volumes/.../bridge/...`）不在其中，因此**默认不会重载**。
- 即使 recompose，app-boot 以 **row id** 组装/对比 entry（`rowIds()`，`dsh-app-boot/lib/index.js:4565`；`entry.update({config:{patches}})` `:4601`），同一 id 的 name 变化不会触发新 module import；代码执行取决于 Cordis/Loader 的 entry identity 与 Node ESM 的 URL 缓存（同一 `file://` URL = 同一 module instance，进程生命周期）。
- `file://` 相对 import 的缓存也按解析后 URL：桥的 `index.js` 静态 `import './constants.js'` 在同一目录下永远是同一 URL，因此**只对 index.js 加 query 不能刷新 constants**（solo 单文件实验除外，见 §3.2）。
- 例外：HMR README 明确「linked 包 target 上的文件变化会在下一次 recomposition 被替换」（`dsh-hmr/README.md:49`）；HMR `root` 配置会主动 watch 指定源码根（E1 实测）。

---

## 3. 发现（b）：可行/不可行方案与实测证据

### 3.1 方案总览

| 方案 | 是否免重启 | 实测 | 维护性/评价 |
|---|---|---|---|
| **新 row id + 新模块路径（新目录副本）** | ✅ | activate-sim S3：v11→v12；主实验 B2：v4 | **推荐（激活与升级都用）**；每个版本一个目录，简单可审计；只需 `cp lib/index.js lib/constants.js` 到 `lib/live/<rev>/`，patch 指向新目录；磁盘成本 ~42KB/版 |
| 新模块路径（row 先被移除/不存在，可留原 id） | ✅ | activate-sim S1（同 id + 新 path v11，冷 profile） | **真实首激活可用**（回滚后 row 已不存在）：只换 path、保留 `id: aventurine-bridge`，`activate-dsh-bridge.mjs` 可直接复用 |
| 同 id + 新 path（row 已存在时替换） | ❌ | S2/B | 绝对不能用于升级；甚至不会重启 |
| 新 id + 旧 path（已缓存 URL） | ❌ | B3 | 只换 id 不够 |
| file URL `?rev=N`（同 row id 或新 id 都可以试） | 单文件 ✅ / 多文件 ❌ | solo Q1/Q2：新 URL → v2；同 URL → stale；桥有相对 import → 旧 constants | 仅当入口是**单文件自包含**（把 constants 内联/打包）才可靠；当前桥结构不适用 |
| HMR `root` 源码 watch | ✅（同 id/path 也行） | E1：改 constants 5→9 自动 `dispose/apply v9` | 适合开发/高频维护；需要在 profile patch 增加 `- id: hmr config: {root: ["<repo>/bridge/dsh-aventurine-bridge/lib"]}`，把仓库路径永久纳入 watch；也适合作为「紧急 evict」手段 |
| 安装为 linked package（`dsh plugin add -w <bridge dir>`） | ✅（同 id/path，改文件后 recompose） | linked 实验：v11→v21（编辑 linked target + patch 触发 recompose） | 维护友好，但会改 profile 的 package.json/pnpm-lock（不再只是 patch 行）；首次激活不如 patch insert 轻量；适合长期频繁迭代 |
| 重启 DSH | ✅（但违背本次目标） | — | 仅在 HMR 失败时的兜底 |

### 3.2 file URL query 实验（solo 单文件插件）

`/tmp/w3-hmr/plugin-solo/index.js`（自包含，`VERSION` 常量）：

| 步骤 | 模块 URL | 磁盘 VERSION | apply 版本 |
|---|---|---|---|
| 初始 | `file:///tmp/w3-hmr/plugin-solo/index.js?rev=1` | 1 | 1 |
| Q1 | 新 id `solo-b` + `?rev=2` | 2 | **2** ✅ |
| Q2 | 新 id `solo-c` + **同一** `?rev=2` | 3 | **2** ❌（URL 缓存） |
| Q3 | 新 id `solo-d` + plain path（本进程未加载过） | 4 | **4** ✅ |

证据：`probes/probe-solo.jsonl`。→ query 的语义就是「构造一个新 URL」；对多文件模块，只有 entry 的 URL 变了，其相对 import 仍是旧 URL。

### 3.3 HMR root watch 与 linked 实验（维护选项）

- **HMR root watch（E1）**：在 `hmr-a` 的 patch 中加
  ```yaml
  - id: hmr
    name: '@deepseek-ai/dsh-hmr'
    config:
      root: ["/tmp/w3-hmr/plugin-a/lib"]
  ```
  然后编辑 `plugin-a/lib/constants.js`（5→9）→ 约 2-3s 内自动 `dispose v2 → apply v9`（不需要再改 patch）。证据 `probe.jsonl` 末尾；这与 DSH HMR README「source watching through `root`」语义一致。
- **linked package**：`dsh plugin --profile linked-a add -w /tmp/w3-hmr/plugin-live-v11` 安装后（symlink），编辑 linked target 的 constants（11→21）+ 改 profile patch 触发 recompose → `dispose v11 → apply v21`（同 id/path 也能热更新）。证据 `probes/probe-linked.jsonl`。`profileRoots` 会把 `node_modules` 里 symlink 的 target 纳入比较（`dsh-hmr/lib/index.js:1454-1459`）。

---

## 4. 发现（c）：拉起修复验证（FakePet + Host `ELECTRON_RUN_AS_NODE=1`）

### 4.1 测试装置

- `fixture/FakePet.app`：`Contents/Info.plist`（`CFBundleExecutable=FakePet`、`CFBundleIdentifier=com.w3hmr.fakepet`）+ `Contents/MacOS/FakePet`（sh 脚本，记录 `argv/ppid/cwd/env` 到 `launch.log`）。
- fake `open`：`/tmp/w3-hmr/fake-bin/open`（记录 argv/env 到 `open.log`），通过 PATH 前置拦截真实 LaunchServices。
- profile `launch-verify`：桥 row `launchPet:true, petAppPath:/tmp/w3-hmr/fixture/FakePet.app`，桥 dir 指向临时目录。
- Host 启动环境注入 `ELECTRON_RUN_AS_NODE=1`（与真实 Host 一致；探针记录证明 Host 内确实为 `1`）。

### 4.2 实测结果

**direct-exec（主路径）** —— `tests/tmp/w3-hmr/launch/launch.log`：

```
launch ts=… pid=77651 ppid=77646 argv=/tmp/w3-hmr/fixture/FakePet.app/Contents/MacOS/FakePet
  cwd=/tmp/w3-hmr
  env.ELECTRON_RUN_AS_NODE=__UNSET__          ← 已清洗
  env.DSH_HOME=/tmp/w3-hmr/home               ← 保留
  env.HOME=/tmp/w3-hmr/home                   ← 保留
  env.PATH=/tmp/w3-hmr/fake-bin:…             ← 保留（fake open 没被用到）
```

- Host 探针：`{"kind":"apply","version":4,"electronRunAsNode":"1",...}` → **Host 环境确实是 `1`**；
- FakePet：**直接 exec**（`argv` 是 `.app/Contents/MacOS/FakePet`，无参数）、`ppid` = Host pid、`ELECTRON_RUN_AS_NODE` **不存在**、`DSH_HOME/HOME/PATH` 保留、`launch.log` 只有 **1 条**（每个 apply 一次）；
- fake `open.log` 不存在 → 没有走 LaunchServices。

**recompose 二次拉起**：一次 patch 变更（加 `rotateBytes`）后 `dispose→apply`，`launch.log` 计数 **1→2**（`launch/launch-recompose.log`）。说明「每个 apply 一次」；打包桌宠有单实例锁（`src/main/index.ts:2746`），第二次进程会自行退出，但**激活后应避免不必要的 patch 编辑**。

**fallback `open`**：

| 场景 | 实际行为 | env |
|---|---|---|
| `petAppPath=/tmp/w3-hmr/fixture/Missing.app`（不存在） | `open <path>`（fake open 记录） | **`ELECTRON_RUN_AS_NODE=1` 被继承**（fallback 分支未清洗 env，`bridge/lib/index.js:503`） |
| 仅 `petBundleId=com.w3hmr.fakepet` | `open -b com.w3hmr.fakepet` | 同上，继承 1 |
| `AVENTURINE_BRIDGE_DISABLE_LAUNCH=1` | 不触发（launch.log/open.log 均无） | — |

→ **结论**：真实 `dist/mac-arm64/AventurinePet.app`（已核对 `Contents/MacOS/AventurinePet` 存在、`CFBundleExecutable=AventurinePet`、`CFBundleIdentifier=com.aventurine.pet`）会命中 direct-exec 分支，env 清洗有效、拉起 bug 修复成立。**但 fallback `open` 仍会带上 `ELECTRON_RUN_AS_NODE`**：如果将来 `.app` 的可执行文件名与 bundle 目录名不一致或结构异常，会退化回原 bug；建议后续把 fallback 的 spawn 也传 `env: cleanEnv`（一行改动，`bridge/lib/index.js:503`），并在激活前核对 §5.3 的 `.app` 检查项。

---

## 5. 发现（d）：真实 profile 免重启激活 Runbook

> 前提：用户已同意「不重启 DSH 激活」；真实 profile 已回滚；真实 Host pid 18937 仍存活（其 Node ESM 缓存里可能已有 09:49 首次激活加载的旧桥模块 → **必须使用没被 import 过的模块路径**）。以下步骤尚未在真实 profile 执行（红线），仅供 Lead 执行。

### 5.1 为什么必须用新路径（不能直接重新追加 repo 原路径）

- 09:49 首次激活时 Host 已 import 过 `repo/bridge/dsh-aventurine-bridge/lib/index.js`（及其 `constants.js`）；回滚只 dispose，**Node 进程内的模块缓存不会释放**。
- 本报告 §2 已在隔离环境复现：同路径 remove→re-add → 仍执行旧代码（A4b）；同 id 换新 path → 被忽略（S2）；新 id 换旧 path → 旧缓存（B3）。
- 因此真实激活必须使用 **从未被该 Host import 过的路径**（新目录），否则即使 `control.json` 出现 `attached`，执行的也可能是旧代码（正是 Lead 观察到的现象）。

### 5.2 推荐做法（版本化 live 目录 + patch 追加）

在仓库内生成一个版本化副本（不要改动原 `lib/index.js` 作为激活入口；副本是独立模块 URL）：

```bash
cd /Volumes/4TB外置盘/deepseek-harness/aventurine-pet-vrm
REV=2026-11-11.1
mkdir -p "bridge/dsh-aventurine-bridge/lib/live/$REV"
cp bridge/dsh-aventurine-bridge/lib/index.js   "bridge/dsh-aventurine-bridge/lib/live/$REV/"
cp bridge/dsh-aventurine-bridge/lib/constants.js "bridge/dsh-aventurine-bridge/lib/live/$REV/"
# 在副本里把 BRIDGE_PLUGIN_VERSION 从 2 改为 3，作为「新代码已加载」的可核对标记（只改副本）
sed -i '' 's/export const BRIDGE_PLUGIN_VERSION = 2/export const BRIDGE_PLUGIN_VERSION = 3/' \
  "bridge/dsh-aventurine-bridge/lib/live/$REV/constants.js"
node --check "bridge/dsh-aventurine-bridge/lib/live/$REV/index.js"
node --check "bridge/dsh-aventurine-bridge/lib/live/$REV/constants.js"
```

> `index.js` 的相对 `import './constants.js'` 在新目录内解析到副本；`engines.dsh` 由 app-boot 的 manifest 向上查找命中 `bridge/dsh-aventurine-bridge/package.json`（同包内子目录，未改动 package.json）。
> 之后每次桥代码更新：换 `REV`（新目录）→ 新路径；若行仍存在，还必须同时把 patch 的 `id` 改成新 id（如 `aventurine-bridge-2026-11-11.2`）。

**激活（先 dry-run）**：

```bash
node scripts/activate-dsh-bridge.mjs \
  --pet-app "$PWD/dist/mac-arm64/AventurinePet.app" \
  --bridge-entry "$PWD/bridge/dsh-aventurine-bridge/lib/live/$REV/index.js" \
  --dry-run
```

确认 dry-run 输出的 `insert` 块包含：新 bridge-entry 绝对路径、`launchPet: true`、`petAppPath`、`petBundleId: "com.aventurine.pet"`、`dir: "~/.dsh/aventurine-pet"`；然后去掉 `--dry-run` 执行。脚本会：

1. 备份真实 patch → `~/.dsh/profiles/desktop/cordis.patch.yml.bak-wave3-<ts>`（本报告已在临时 home 验证：备份 hash = 激活前 hash，`--rollback` 可精确恢复）；
2. YAML 校验追加后的文件；
3. 追加 insert 行（真实 patch 当前**无** `id: aventurine-bridge`，幂等检查通过——本次首次激活可用脚本默认 id；**后续升级需给脚本加 `--entry-id` 或手工改 id**，见 §5.6）。

**观察（2-5s 内 HMR 应完成）**：

```bash
cat ~/.dsh/aventurine-pet/control.json
# 期望：{"schemaVersion":1,"bridgeVersion":3,"ts":<新>,"action":"attached","dshPid":18937}
cat ~/.dsh/aventurine-pet/status.json
# 期望：offline:false（随后 5s 心跳刷新；30s TTL 内 online）
# 桌宠进程（direct-exec；父进程=Host）：
ps -axo pid,ppid,etime,args | grep 'AventurinePet.app/Contents/MacOS/AventurinePet' | grep -v grep
# 若桌宠已运行/单实例：确认没有第二个窗口/托盘图标（打包版 single instance lock 会合并）
```

随后在 DSH 会话触发一次 turn，确认 `events.jsonl` 出现 `task/start`、`session/event(text)`、`task/end`，且桌宠响应（B7 online）。

### 5.3 执行前必须核对的检查项（Lead checklist）

| # | 检查 | 期望/命令 |
|---|---|---|
| 1 | 真实 patch 是否仍为回滚态 | `shasum -a 256 ~/.dsh/profiles/desktop/cordis.patch.yml` = `0df330447a1ba5e4a5c62f3b90dedac8c2f4f53e80cf4e397bd7e8c026ae1130`；且 `grep -c aventurine-bridge` = 0 |
| 2 | 真实 Host 存活且是同一进程 | `ps -axo pid,args \| grep dsh-desktop-host/lib/index.js`，期望 pid **18937**（若已重启过，缓存问题不存在，可直接用 repo 路径；但本 runbook 仍建议新路径） |
| 3 | 桥目录状态 | `control.json` = `detached`；`status.json` = `offline:true`（旧证据可保留） |
| 4 | 桌宠 app | `dist/mac-arm64/AventurinePet.app/Contents/MacOS/AventurinePet` 可执行；`CFBundleExecutable=AventurinePet`；`CFBundleIdentifier=com.aventurine.pet`（`real-state/README.txt` 已核对） |
| 5 | live 副本 | 新 `REV` 目录存在 `index.js`+`constants.js`；`node --check` 通过；`BRIDGE_PLUGIN_VERSION` 已 bump；无仓库内其它相对 import |
| 6 | 桌宠是否在运行 | 建议先退出桌宠（干净观察拉起；若在运行，打包版单实例锁会合并第二次启动，但日志可能混） |
| 7 | patch 可写/可备份 | 当前用户对 `~/.dsh/profiles/desktop/` 可写；磁盘空间足够；先手工 `cp` 一份额外备份（双保险） |
| 8 | 不要同时改 `hmr`/其它行 | 本次只需追加 bridge insert 行；避免一次改多行造成多重 recompose |
| 9 | 回滚路径就绪 | `node scripts/activate-dsh-bridge.mjs --rollback --dry-run` 应能找到备份（激活后立即再 dry-run 一次确认） |

### 5.4 激活后核对清单（No-restart 验收）

| 项 | 期望 |
|---|---|
| control attached + `bridgeVersion` = 新副本的值（e.g. 3）+ `dshPid` = 真实 Host pid | ✅ |
| status 心跳 fresh、`offline:false` | ✅ |
| 桌宠进程 direct-exec 出现（父进程=Host），窗口出现、无双实例 | ✅ |
| 桌宠 `main.log` 有 DSH 连接/online 日志；设置页 DSH 状态「已连接」 | ✅ |
| 下一次 DSH turn：`events.jsonl` 增长（`task/start` → `session/event`（assistant text）→ `task/end`），桌宠气泡/动作响应 | ✅ |
| 无 LaunchServices `open` 调用痕迹（`log show --predicate 'process == "open"'` 可选，非必需；direct-exec 已在 fixture 验证） | ✅ |
| 激活后**不要再随意编辑** profile patch（每次 recompose 会重新 apply + 再拉起一次桌宠） | 约束 |

### 5.5 回滚

```bash
node scripts/activate-dsh-bridge.mjs --rollback
# 期望：HMR dispose 桥 → control.json detached（bridgeVersion=当前副本值）→ 桌宠按强耦合策略退出/进入等待
```
- 已在临时 home 验证：回滚后 patch hash 与激活前完全一致（`activation-script/` 证据）。
- 回滚后核对：`control.json` detached、`status.json` 最终 offline（≤30s）、无残留桌宠/桥进程；桥目录保留为证据。
- 若 HMR 未生效/异常：删除 bridge insert 行（与脚本回滚等价）→ 不要回滚整个 profile；提示用户下次重启 DSH 即可恢复。

### 5.6 已知脚本缺口（Lead 可决定是否补）

`scripts/activate-dsh-bridge.mjs` 目前：
- `ENTRY_ID = 'aventurine-bridge'` 硬编码（`:50`），**没有 `--entry-id`** → 首次激活可用；**后续升级**（必须新 id）需手工编辑 patch 或给脚本加 `--entry-id`（同时 `hasBridgeEntry()` 与 `buildInsertBlock()` 使用该值，改动约 10 行）；
- 默认 bridge entry 是 repo 原路径（`DEFAULT_BRIDGE_ENTRY`），**本次必须显式传 `--bridge-entry` 指向新 live 副本**，否则会命中旧模块缓存；
- 幂等检查只匹配 `id: aventurine-bridge`；若升级改 id 后再次运行，需人工确认 patch 中没有旧行（建议扩展脚本做「任意 `aventurine-bridge*` 行」检查）。
- 本报告已在**临时 home**完整跑通 dry-run → activate → rollback（`tests/tmp/w3-hmr/activation-script/`），未触碰真实 profile。

### 5.7 若仍疑似旧代码（排障顺序）

1. `control.json.bridgeVersion` 是否等于新副本 bump 后的值？不等 → 加载的仍是旧模块/旧行；
2. patch 中 insert 行的 `name` 是否**新副本路径**（不是 repo `lib/index.js`）、`id` 是否与旧行不同（若旧行仍在）？
3. 新副本目录是否真的未被该 Host 加载过（同一天内不要复用同一 REV 目录）；
4. 兜底 evict（已验证可行）：在 patch 加 `- id: hmr config: {root: ["<repo>/bridge/dsh-aventurine-bridge/lib"]}`，然后 `touch` 一次被加载的桥文件（或轻微编辑），HMR 会 evict 并 reload 当前磁盘代码；确认后**移除 hmr root 行**（避免长期 watch 仓库）。
5. 最终兜底：删除 insert 行 → 请用户重启 DSH（放弃本次「免重启」目标）。

---

## 6. 风险与未知项

1. **HMR 行为不是契约**：本结论基于 DSH 0.2.2-rc.1 shipped build 的内部实现（`profileRoots` 比较、ById entry 复用、Node ESM URL 缓存）。未来 DSH 版本可能变化；桥 `engines.dsh`（`>=0.2.2-rc.1 <0.3.0`）是闸门，升级后应重新验证（可复用本报告实验：临时 profile + 探针副本 + `bridgeVersion` 标记）。
2. **未在真实 profile 执行**（红线）：真实 Host 的模块缓存状态是**推断**（同进程连续存活 + 隔离环境复现机制），无法从外部直接读取 Node ESM cache。Runbook 用「新路径 + 版本标记」绕开此不确定性。
3. **每次 recompose 会再拉起一次桌宠**（实测 1→2）：打包版单实例锁会合并，但若某次桌宠 app 未打包/异常退出，会出现第二个进程；激活后避免改 patch；后续可给桥加「已在运行则跳过」的检测（如 `pgrep`/`NSRunningApplication`）。
4. **fallback `open` 未清洗 env**：`bridge/lib/index.js:503` 的 fallback 仍继承 `ELECTRON_RUN_AS_NODE=1`；真实 `.app` 解析成功时不会触发，但建议补 `env: cleanEnv`（1 行）以消除结构性风险。
5. **launchPet 语义是「每 apply 一次」**：HMR reload、手动禁用再启用都会重新拉起；桌宠耦合逻辑的 grace/detached 已由 e2e 报告覆盖，但「重复拉起」的实机影响需在激活后核对（双托盘/双窗口）。
6. **live 副本方案的分发/维护**：副本目录需要随仓库/部署保留；如果用户移动仓库或删除 `lib/live/<REV>`，下次 DSH 重启会因入口路径不存在而**插件行导入失败**（可选行失败只 warn，`--dump-config` 可查；桥目录状态可提示）。建议在 `docs`/`README` 记录 live 目录与 patch 行的对应关系，并在移动仓库时重建。
7. **激活脚本缺口**（§5.6）：后续升级需要 `--entry-id` 或手工 patch；未改脚本前不要用同 id 改 name（会被静默忽略）。
8. **未验证**：真实 DSH 激活后的 UI/桌宠联动（留给 Lead 按 §5.4 核对）；`hmr.root` 在真实 desktop（15 bundle）下的性能影响未测（仅 dev/test 环境）；linked-package 方案未在真实 desktop 试验（避免改 profile 依赖）。

---

## 7. 证据清单（`tests/tmp/w3-hmr/`，gitignored）

| 路径 | 内容 |
|---|---|
| `probes/probe.jsonl` | 主 HMR 实验（同一 Host 内 14 条 apply/dispose，含 A1/A2/A4/B/B2/B3/E1） |
| `probes/probe-activate-sim.jsonl` | 真实激活流程模拟 S1/S2/S3/S4（v11/v12/detached） |
| `launch/probe-launch-verify.jsonl`、`launch/launch.log`、`launch/open.log` | direct-exec + env 清洗 + fallback open（含 Host env=1 与子进程 env 对比） |
| `launch/launch-recompose.log`、`launch/probe-launch-verify2.jsonl` | recompose 后二次拉起（计数 1→2） |
| `probes/probe-launch.jsonl` / `probe-launch-disabled.jsonl` | 多次 apply 的拉起记录 / `AVENTURINE_BRIDGE_DISABLE_LAUNCH=1` 不拉起 |
| `probes/probe-solo.jsonl` | file URL query 实验（单文件） |
| `probes/probe-linked.jsonl` | linked package 热加载实验（11→21） |
| `patches/01..12-*.yml` | 按执行顺序重建的 profile patch 快照（内容来自实际命令） |
| `probe-plugin/` | 带 `W3_HMR_PROBE_LOG` 探针的桥插件副本 + solo 插件（复现用） |
| `hosts/*.log` | 各临时 `dsh web` Host 启动日志 |
| `activation-script/` | 在临时 DSH_HOME 上 dry-run/activate/rollback 的日志 + 备份/恢复 patch（hash 一致） |
| `real-state/` | 真实 profile 回滚核对（hash、detached、无 bridge 行）、真实 Host pid、dist `.app` 检查（只读） |

复现提示：把 `probe-plugin/` 中的副本放到任意绝对路径，临时 profile patch 用 `insert` + 该路径；启动 `dsh --profile <p> --no-open --host 127.0.0.1 --port <p>`，用 `W3_HMR_PROBE_LOG` 观察 apply/dispose；fixture 与 fake `open` 见 `launch/`。

---

## 8. 对 Wave 3 收口的建议（一句话版）

1. **不要**再对真实 desktop profile 用 repo `lib/index.js` 原路径重试；按 §5 生成 `lib/live/<REV>/` 新路径，用 `activate-dsh-bridge.mjs --bridge-entry ...`（dry-run 先行）追加，`control.json.bridgeVersion` 必须等于新副本值才算成功。
2. **后续升级**：新 `REV` 目录 + **新 row id + 新 name**（必要时给 activation 脚本加 `--entry-id`）；不要在同一路径上「改了再 recompose」。
3. **可选加固**：fallback `open` 也清洗 `ELECTRON_RUN_AS_NODE`；桥加「桌宠已在运行则跳过拉起」；把 `hmr.root` 作为开发/紧急 evict 手段写进运维文档（不要长期保留 watch）。
4. 激活前按 §5.3 九项核对、激活后按 §5.4 验收；任何异常先回滚（§5.5），本次「不重启 DSH」目标优先。
