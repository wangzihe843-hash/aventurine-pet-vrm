# T4 独立验收报告：桌宠 × DSH 耦合兼容性安全 v2（2026-11-11）

> 角色：独立 verifier（task-4）。**不复用实现者结论、不复用其测试 harness 之外的覆盖**：diff 只读复核 +
> 指定单测/typecheck/canary 复跑 + verifier 自写对抗用例 + 手工探针。
> 验证基线：本仓库 working tree（HEAD 起始 `f217521`；验证期间另一会话提交了 `2b9340a`/`fb21e61`，
> 与本轮耦合改动文件无交集，见 §2）。
> 验收依据：[`pet-dsh-coupling-safety-plan-2026-11-11.md`](pet-dsh-coupling-safety-plan-2026-11-11.md) §7
> 与 [`research/pet-coupling-compat-plan-review-2026-11-11.md`](research/pet-coupling-compat-plan-review-2026-11-11.md)。

## 0. 结论

**PASS with issues（0 FAIL）**

- T1（桥 v4）、T2（安装/激活加固 + canary）、T3（桌宠握手/降级）三块实现与计划 §2/§3/§4/§5/§6 一致，
  指定单测/回归/typecheck/canary/help 全部通过，§7.3 十三项矩阵与 task-4 追加对抗场景全部 PASS。
- **1 项低风险契约偏差**（不影响本轮判定）：`src/shared/semver-range.ts` 的 caret（`^0.x.y`）下界语义
  与 **当前 DSH 内嵌的 node-semver 7.8.6** 不一致（该实现对齐 7.7.x：`^0.2.2` 对 `0.2.2-rc.1` 判 true，
  7.8.6 判 false）。本轮所有真实 range 都是裸比较符（`>=0.2.2-rc.1 <0.3.0`），parity 100% 对齐，不受影响。
  详见 §5-D1。
- **E2E 动态执行未由 verifier 验证**（Lead 明确由 Lead 负责且验证窗口内正在改脚本；verifier 未改/未跑，
  只做静态复核并记录所需 diff 状态，见 §6）。按任务定义该项不影响总体验收结论，标注「未验证」。
- 其余为环境说明/文案级 nit，列出但非失败项：canary 隔离 WARN 由**真实 DSH 实例正在运行**导致（§7）；
  dry-run 摘要措辞、测试注释错别字（§5-D3/D4）。

> **Lead 补记（2026-11-11 14:47）**：verifier 报告后，Lead 完成了 E2E 脚本适配并**实跑**
> `node scripts/wave3-e2e/e2e-coupling.mjs`（当前 `out/` 构建，含本轮主进程改动）：
> **A–F 共 62/62 断言 PASS**，含新增场景 F（v4 compat 不兼容 → DEGRADED → fake 消失跟随退出
> `dsh-degraded`，0 次重启）；隔离自证 `real-dsh-pids-unchanged` / `real-desktop-patch-unchanged` /
> `real-bridge-control-unchanged` / `real-bridge-files-unchanged` / `open-shim-not-invoked` 全 PASS。
> 证据：`tests/tmp/wave3-e2e/2026-11-11T06-46-24-480Z-coupling/result.json`。
> E2E G/H 未加（由单测 §7.3 #7/#8 覆盖）。

## 1. 验证环境与隔离遵守

| 项 | 值 |
|---|---|
| 仓库/工作目录 | `/Volumes/4TB外置盘/deepseek-harness/aventurine-pet-vrm` |
| Node / pnpm / vitest | v24.21.0 / 10.20.0 / 5.1.0 |
| DSH | `/Applications/DeepSeek Harness.app`，`CFBundleShortVersionString=0.2.2-rc.1` |
| 真实 DSH 实例 | **本会话宿主 DSH 桌面版正在运行**（v3 桥 attached：`control.json` dshPid=98123，ts=12:48），
其桥心跳会持续写真实 `~/.dsh/aventurine-pet/{status,events}` → 解释 canary 隔离 WARN |
| 真实现网桥 | 仍为 **v3 legacy**（`bridgeVersion:3`），本轮**未**重新激活 v4、未 HMR（符合 §8 部署由用户执行） |

遵守的硬约束（均有证据）：

- 未修改 T1/T2/T3 实现文件（`git status` 与 mtime 复核，见 §2）；
- 未触碰 `src/renderer/**`：验证开始前对 `foot-lock.ts`/`wave2-contract.ts`/`runtime-types.ts` 取 sha256，
  结束时逐一相同（§7）；验证期间另一会话在该目录新增 `upper-chest-fold.ts`（14:43:01）与本轮无关；
- 未写真实 `~/.dsh`：真实 profile `cordis.patch.yml` sha256 验证前后一致、`control.json` 内容未变、
  未产生新备份文件（§7）；所有 canary/probe 均用临时 `DSH_HOME`/临时桥目录；
- 未 open/kill 真实 DSH、未 kill 任何真实进程（E2E/fake DSH 未运行）；
- 未跑全量 `pnpm test`/`pnpm build`/`package:dir`；未执行任何 git checkout/stash/clean/reset/commit；
- 唯一写入：`tests/tmp/verify-dsh-coupling/**`（证据+自写用例）与本报告。

## 2. 改动范围复核（只读 `git status`/`git diff`）

### 2.1 本轮改动文件 → 归属/范围

| 归属（计划 §9） | 文件 | 结论 |
|---|---|---|
| T1 bridge | `bridge/dsh-aventurine-bridge/{README.md,package.json,lib/constants.js,lib/index.js}`、`tests/bridge-plugin.test.ts` | ✅ 均在 T1 写盘范围 |
| T2 installer | `scripts/activate-dsh-bridge.mjs`、`scripts/dsh-patch-lib.mjs`(新)、`scripts/dsh-canary.mjs`、`scripts/dsh-canary-lib.mjs`、`tests/dsh-patch-lib.test.ts`(新)、`tests/dsh-canary-lib.test.ts`、`docs/pet-dsh-coupling-runbook.md`(新) | ✅ 均在 T2 写盘范围 |
| T3 pet | `src/main/desktop/dsh-lifecycle.ts`、`src/main/desktop/dsh-version.ts`(新)、`dsh-compat.ts`(新)、`dsh-bridge-state.ts`(新)、`src/main/ipc/dsh.ts`、`tests/dsh-lifecycle.test.ts`、`tests/dsh-version.test.ts`(新)、`tests/dsh-compat.test.ts`(新)、`tests/dsh-bridge-state.test.ts`(新)、`tests/dsh-ipc.test.ts` | ✅ 均在 T3 写盘范围 |
| Lead 共享契约 | `src/shared/bridge-schema.ts`、`src/shared/semver-range.ts`(新)、`tests/semver-range.test.ts`(新)、`tests/bridge-schema-compat.test.ts`(新)、`docs/pet-dsh-coupling-safety-plan-*.md`、`docs/research/pet-coupling-compat-plan-review-*.md` | ✅ 仅 Lead 契约/文档；`src/shared/**` 无第三方改动 |
| Lead E2E 适配（Lead 明确负责） | `scripts/wave3-e2e/lib.mjs`、`scripts/wave3-e2e/e2e-coupling.mjs`（mtime 14:33，验证窗口内由 Lead 修改；verifier 未改） | ✅ 归属注明，不计入 T1/T2/T3 越界 |

结论：**没有越出声明写盘范围的实现文件**；`src/shared/**` 仅 Lead 的两个契约文件 + 两个 Lead 单测新增。

### 2.2 无关并发改动（不属于本轮，已排除）

- 验证期间另一会话提交 `2b9340a`（foot-lock/known-issues/vrm 测试）与 `fb21e61`（standing-leg bake 脚本/报告），
  并在 14:32:48 重建 `dist/mac-arm64/AventurinePet.app`（`package:dir`，由该会执行）——**未触碰任何耦合文件**
  （`git show --name-only` 复核为空），`dist/` 不在本报告证据链内；
- 该会话仍在写 `src/renderer/src/vrm/upper-chest-fold.ts`(14:43)、`docs/research/mate-female-to-male-*.md`(14:42)；
- 结论：耦合改动与模型侧并发改动互不污染；`foot-lock.ts` 等原未提交改动在验证窗口内**内容 sha256 不变**
  （后被该会话自行提交），本轮未触碰/回滚。

### 2.3 实现与计划契约逐条核对（摘要）

| 计划条款 | 实现位置 | 结论 |
|---|---|---|
| §3.2 compat 块（control+status 每帧） | `bridge/dsh-aventurine-bridge/lib/index.js:318-362`（`readDeclaredDshRange`/`buildCompat`）、`:811-853` 写帧 | ✅（canary C3 + verifier 手工探针实测帧） |
| §4.1 apply 失败隔离（写 `bridge-error.json`+no-op disposer，绝不 throw） | 同文件 `:395-440`（诊断写）、`:1176-1190`（apply 外层兜底） | ✅（T1 单测 + verifier 手工探针 14 项） |
| §3.1 legacy v3 回退范围 | `src/shared/bridge-schema.ts:56-60`（常量）、`src/main/desktop/dsh-compat.ts:199-213` | ✅（§7.3 #4 双向 + 真机版本交叉验证） |
| §2.1 PAIRED 四门槛 | `src/main/desktop/dsh-lifecycle.ts:627-629,730-806` | ✅（陈旧/单帧场景见 §4-A1/A2） |
| §2.2 状态机/限时/降级出口 | 同文件 `:695-728`(enterDegraded)、`:1072-1086`(startup-failed)、`:969-1022`(崩溃确认/恢复)、`:1138-1163`(bridge-lost)、`:1090-1106`(UNPAIRED)、`:1166-1187`(DEGRADED tick) | ✅ |
| §2.2 DEGRADED 禁止拉起/重启/终止；DSH 消失跟随退出 | 同文件 `:1166-1187`（tick 仅探测+握手评估）、`:1359-1375`（before-quit 仅 PAIRED 终止） | ✅ |
| §2.3 safe-mode 文件逃生阀 | 同文件 `:543-558,1218-1248` + `src/main/ipc/dsh.ts:180-190,229` | ✅（含删除后 tick 恢复） |
| §2.4 告警（去重/静默/文案） | `src/main/ipc/dsh.ts:70-86,143-178` | ✅（文案含原因码/DSH 版本/期望范围/runbook + “DSH 本体不受影响”） |
| §5 安装加固 1–7 | `scripts/activate-dsh-bridge.mjs`：`:461-500`(源包 engines 校验)、`:568-595`(live 副本带 engines)、`:781-810`(install.json 原子写)、`:347-419`(YAML fail-closed)、`:963-1116`(--rollback/--remove 定向+删清单)、`:746-775`(预检 WARNING)、`:843-899`(激活后 ≤10s 验证)、`:1272-1288`(dry-run) | ✅（静态+代码审阅；dry-run 实测零写入 §4-A10；非 dry-run 未执行，见 §8 剩余风险） |
| §6.1 三个新模块 | `src/main/desktop/dsh-version.ts` / `dsh-compat.ts` / `dsh-bridge-state.ts` | ✅（各自单测 + 纯函数/注入边界审阅） |
| §6.3 ipc 接线（不新增 channel、不改 index/types） | `src/main/ipc/dsh.ts:201-272`；`git diff` 未见 `src/main/index.ts`/`src/shared/types.ts` 改动 | ✅ |
| §7.3 矩阵 | 见 §4 逐项 | ✅ 13/13 |

## 3. 复跑结果（命令 → 结果 → 证据）

| # | 命令 | 结果 | 证据 |
|---|---|---|---|
| 1 | `pnpm exec vitest run tests/semver-range.test.ts tests/bridge-schema-compat.test.ts tests/bridge-plugin.test.ts tests/dsh-canary-lib.test.ts tests/dsh-patch-lib.test.ts tests/dsh-lifecycle.test.ts tests/dsh-ipc.test.ts tests/dsh-version.test.ts tests/dsh-compat.test.ts tests/dsh-bridge-state.test.ts --reporter=dot` | **PASS：10 files / 408 tests passed**（238ms） | `tests/tmp/verify-dsh-coupling/evidence/vitest-primary.log` |
| 2 | 相关既有回归：`pnpm exec vitest run tests/dsh-watch.test.ts tests/dsh-process.test.ts tests/bridge-schema.test.ts tests/bridge-schema-sanitize.test.ts --reporter=dot` | **PASS：4 files / 108 tests passed** | `.../evidence/vitest-regression.log` |
| 3 | `pnpm typecheck:node` | **PASS：exit 0，无输出错误** | `.../evidence/typecheck-node.log` |
| 4 | `node scripts/dsh-canary.mjs --compat`（隔离临时 DSH_HOME，约 2m） | **PASS：exit 0，C1–C6 全 PASS**（C1 闸门拒绝/C2 现网形态宿主仍启动+桥零产物/C3 attached+bridgeVersion=4+compat.dshRange+心跳/C4 import 抛错/C5 apply 抛错/C6 不可写目录→bridge-error.json） | `.../evidence/canary-compat.log` |
| 5 | `node scripts/dsh-canary.mjs`（默认，约 20s） | **PASS：exit 0**，既有事件/文本/control 契约匹配；含 canary 隔离 WARN（环境解释见 §7） | `.../evidence/canary-default.log` |
| 6 | `node scripts/activate-dsh-bridge.mjs --help` | **PASS：exit 0**，输出含 `--remove/--replace/--rollback/--dry-run/--skip-yaml-check` 等 | `.../evidence/activate-help.log` |
| 7 | verifier 自写对抗用例（独立 fake 调度器/进程，不复用 T3 harness）：`pnpm exec vitest run --config tests/tmp/verify-dsh-coupling/vitest.config.mts` | **PASS：2 files / 19 tests passed**（13 对抗 + 6 semver parity） | `.../evidence/vitest-adversarial.log` |
| 8 | verifier 手工桥 apply 探针：`node tests/tmp/verify-dsh-coupling/bridge-apply-probe.mjs` | **PASS：14/14 检查，exit 0** | `.../evidence/bridge-apply-probe.log` |
| 9 | verifier 手工安装脚本探针：`bash tests/tmp/verify-dsh-coupling/installer-probe.sh` | **PASS：17/17 检查，exit 0** | `.../evidence/installer-probe.log` |

> 说明：`pnpm exec vitest` 均未跑全量 `pnpm test`；所有命令未触碰真实 `~/.dsh`/真实 DSH。

## 4. 对抗复核（逐项 PASS/FAIL + 证据）

图例：✅ PASS；⏭ 未验证；❌ FAIL。T3 指 `tests/dsh-lifecycle.test.ts`（下同）。

### 4-A1 陈旧 `control.json` attached + status 过期 + DSH 进程不存在

- **要求**：不得 PAIRED、不得重启 DSH。
- **实现**：`dsh-lifecycle.ts:760-806` 先 `probeRunning()`，进程不在即返回；PAIRED 仅由四门槛同时成立触发。
- **T3 覆盖**：`T3:955-975`（running=true 但无新鲜心跳 → UNPAIRED→20s→DEGRADED(bridge-not-loaded)，0 launch/0 terminate/0 quit）。
- **verifier 独立复现**（`adversarial.test.ts` A1）：启动时 DSH 未运行 + 注入上一会话陈旧 attached + offline 心跳 →
  全程 `states` 不含 `PAIRED`；仅按契约 §1 正常拉起一次（`launchCalls=1`，即正常启动路径而非重试）；随后
  UNPAIRED→20s→DEGRADED；再等 120s：launch 仍 1 次、terminate=[]、quit=[]。
- **verifier 独立复现**（A2，更严苛）：陈旧 attached + **看似新鲜**的心跳（上一进程 TTL 余温）+ 进程始终不在 →
  180s 内 `launchCalls=3`（`DSH_MAX_LAUNCHES_PER_WINDOW` 正常启动预算）后 DEGRADED(startup-failed)，
  全程从未 PAIRED、0 terminate、0 quit。
- **结论**：✅ PASS（无假 PAIRED；无崩溃恢复式重启）。

### 4-A2 PAIRED 但 status.online 变 false 30s → DEGRADED(bridge-lost)；DEGRADED 下不杀/不重启

- **实现**：`dsh-lifecycle.ts:1138-1163`（`monitorPairedBridgeHealth`：宽限 30s → enterDegraded）；DEGRADED tick
  (`:1166-1187`) 只探测+重试握手，不 launch/terminate；before-quit (`:1359-1375`) 仅 PAIRED 才终止。
- **T3 覆盖**：`T3:1182-1195`（心跳丢失 30s → DEGRADED、进程仍在、0 terminate/0 launch）；`T3:831-841`
  （DEGRADED 下 before-quit 放行）。
- **verifier 独立复现**（A3）：PAIRED→offline→30s→DEGRADED(bridge-lost)；DEGRADED 下 before-quit 不
  preventDefault、不 terminate、不请求 quit；再等 60s 仍 DEGRADED、0 launch/0 terminate。
- **语义备注**（非问题）：watcher 先按 TTL(30s) 判 offline 再推给 lifecycle，故「最后心跳 → DEGRADED」最坏
  约 60s（TTL 30s + 丢失宽限 30s）；计划 §2.1 的「丢失超过 30s」若按最后心跳时刻口径为 60s。实现与
  「检测到丢失后 30s」一致，T3 用直接注入 `online=false` 验证 30s 逻辑。
- **结论**：✅ PASS。

### 4-A3 compat 不兼容 → 立即 DEGRADED(compat-incompatible)，0 launch/0 terminate

- **实现**：`dsh-compat.ts:110-244`（不兼容判定）；`dsh-lifecycle.ts:796-800`（立即 `enterDegraded('compat-incompatible')`）。
- **T3 覆盖**：`T3:999-1042`（DSH 0.3.0 超出 v4 范围 → 立即 DEGRADED、0 launch/0 terminate；PAIRED 中未来桥帧也立即降级）。
- **verifier 独立复现**（A4）：running=true + v4 范围 + DSH 0.3.0 → 首帧握手后立即 DEGRADED；DEGRADED 下
  before-quit 放行、0 terminate；进程消失后才 `quit('dsh-degraded')`，0 launch。
- **结论**：✅ PASS。

### 4-A4 v3 legacy 双向（0.2.2-rc.1 PAIRED / 0.3.0 DEGRADED）

- **实现**：`bridge-schema.ts:56-60`（`BRIDGE_LEGACY_DSH_RANGE='>=0.2.2-rc.1 <0.3.0'`）；`dsh-compat.ts:130-135,199-213`
  （v3 无 compat 时 schema 视为 1、range 回退 legacy）。
- **T3 覆盖**：`T3:1044-1069`（双向）。
- **verifier 独立复现**（A5：legacy 0.2.2-rc.1 → PAIRED、无告警；legacy 0.3.0 → 立即 DEGRADED，detail 含
  legacy 范围、0 terminate）；**A9**：真机只读读取 `/Applications` Info.plist = `0.2.2-rc.1`，
  `evaluateCouplingCompat(v3,null,null)` → `ok` 且 dshRange 回退 legacy；`0.3.0` → incompatible。
- **结论**：✅ PASS（现网 v3 桥向后兼容成立）。

### 4-A5 崩溃重启用尽 → DEGRADED(crash-recovery-failed)，不 cascade quit

- **实现**：`dsh-lifecycle.ts:913-928`（attempts 用尽 → `enterDegraded('crash-recovery-failed')`，替换旧 `cascade('dsh-gone')`）。
- **T3 覆盖**：`T3:561-586`（2 次重启失败 → DEGRADED、quits=[]、launch 不再增加；常驻 120s 不退出）。
- **verifier 独立复现**（A6）：确认 launchCalls=DSH_MAX_RESTARTS、quits=[]、告警 code。
- **结论**：✅ PASS。

### 4-A6 DEGRADED 跟随退出语义（含 T3 报告第 4 条调和）

- **要求（Lead 裁决）**：进入 DEGRADED 时 DSH 在运行 → 进程消失即 `quit('dsh-degraded')`、0 launch、不 SIGTERM；
  进入时 DSH 未运行（startup-failed/crash-recovery-failed）→ 常驻等待，之后**观察到** DSH 运行再消失才跟随。
- **实现**：`dsh-lifecycle.ts:477-484`（`degradedSawRunning` 语义注释）、`:695-728`（进入时记录
  `lastKnownRunning`）、`:1166-1187`（未运行且未观察到运行 → 常驻；观察到运行后消失 → cascade）。
- **T3 覆盖**：`T3:1099-1130`（在运行进入降级 → 消失 → quit(dsh-degraded)、0 launch/0 terminate；UNPAIRED 同）；
  `T3:1157-1179`（startup-failed 后常驻、不 quit、用户手动打开后自动恢复）。
- **verifier 独立复现**（A6 后半）：crash-recovery-failed 进入（DSH 不在）→ 120s 不 quit；DSH 出现运行但
  握手仍不健康 → 仍 DEGRADED 且记录「观察到运行」（0 重启）；随后消失 → `quit('dsh-degraded')`、0 terminate。
  **A4**：compat-incompatible（在运行进入降级）→ 消失即跟随。
- **结论**：✅ PASS（按 Lead 裁决语义实现；与计划 §7.3 #6 字面在「进入时已不在运行」情形的差异属有意调和，非 FAIL）。

### 4-A7 safe-mode 文件 → DISABLED；不 launch/kill/cascade；删除后 tick 恢复

- **实现**：`dsh-lifecycle.ts:543-558`（`evaluateEnabled` 合并 safe-mode，热检查）、`:1218-1248`（DISABLED 分支不动作）；
  `src/main/ipc/dsh.ts:180-190,229`（`~/.dsh/aventurine-pet/safe-mode` → watcher.dir）。
- **T3 覆盖**：`T3:1198-1239`（启动时生效 → DISABLED 零动作；删除后 tick 恢复 STARTING/拉起；运行中开启 →
  DISABLED 不杀 DSH，期间 DSH 退出不 cascade，关闭后恢复 PAIRED）。
- **verifier 独立复现**（A7）：safe-mode 生效时注入健康握手帧仍保持 DISABLED（不能顶开）；删除后 tick → PAIRED；
  再开启 → DISABLED，期间 DSH 退出无 quit/terminate。
- **结论**：✅ PASS。

### 4-A8 告警去重 / SILENT

- **实现**：lifecycle 每次进入 DEGRADED 只 `emitCouplingAlert` 一次（`enterDegraded` 早退，`:695-704`），恢复时
  `recovered`（`:650-674`）；ipc 层 `createCouplingAlertNotifier`（`ipc/dsh.ts:143-178`）：每次 app 运行同 code
  只弹一次 modal、每次通知、`PET_DSH_COUPLING_SILENT_ALERTS=1` 只写日志。
- **T3 覆盖**：`T3:1241-1266`（持续 DEGRADED 60s 只 1 次告警；恢复 1 次 recovered；再次降级再 1 次）；
  `tests/dsh-ipc.test.ts:411-486`（modal 去重/恢复只通知/SILENT 静默/异常静默）。
- **verifier 独立复现**（A8）：同左（DEGRADED 60s 仍 1 次、恢复 1 次、再降级新增 1 次）。
- **结论**：✅ PASS。

### 4-A9 桥 apply 失败 → 返回函数 disposer、不抛、写 `bridge-error.json`

- **实现**：`bridge/lib/index.js:1176-1190`（外层 try/catch → `writeBridgeDiagnostic(config,'apply',error)` + `() => {}`）；
  `:407-440`（原子写诊断、候选目录回退、失败只 warn）。
- **T1 覆盖**：`tests/bridge-plugin.test.ts:1809-1975`（不可写目录/投毒 ctx/目录被文件占用/全候选不可写/
  unhandledRejection 毒化驱动）。
- **verifier 手工探针**（真实 `lib/index.js` + 自造 fake ctx）：bridge 目录 chmod 0555 → apply 不 throw、返回
  function、disposer 重复调用不 throw；诊断回退写 `AVENTURINE_BRIDGE_DIR`，`{schemaVersion:1,phase:'apply',
  bridgeVersion:4,dshRange:'>=0.2.2-rc.1 <0.3.0'}`；不可写目录零产物；正常目录 apply 写 control attached(compat)+
  status 心跳、disposer 写 detached+offline、桥自建目录 0700/文件 0600、无 unhandledRejection —— **14/14 PASS**。
- **结论**：✅ PASS。

### 4-A10 安装脚本：`--dry-run --replace` 零写入；PyYAML fail-closed

- **verifier 手工探针**（临时自建 `DSH_HOME/profiles/desktop/cordis.patch.yml` + 假 pet/DSH app，未碰真实 `~/.dsh`）：
  - `--dry-run --replace`：exit 0；输出 DRY-RUN、install.json 目标、打印的清单含 `bridgeVersion:4` 与
    `dshRange:">=0.2.2-rc.1 <0.3.0"`（证明 live 副本 engines 来源被消费）；**临时 DSH_HOME 文件集合+sha256+目录集合
    前后不变**、未创建 `--bridge-dir`/install.json、未在 repo `work/live-bridge` 生成 rev、真实 profile sha256 不变。
  - PyYAML 不可用（PATH 遮蔽模拟）：默认路径 exit 1、报 `PyYAML 不可用`+`fail-closed 拒绝写入`、零写入；
    `--skip-yaml-check` 才降级（WARN 显式承担风险）且 dry-run 仍零写入。
  - 合计 **17/17 PASS**（`installer-probe.log`）。
- **代码审阅**：`activate-dsh-bridge.mjs:347-419`（严格 `yaml.safe_load` + 顶层数组 + 桥行/其它条目不变断言）、
  `:568-595`（live 副本复制 `name/version/engines/type/main`，`engines` 缺失视为错误）、`:781-810`（install.json
  tmp→rename 0600）、`:963-1116`（`--remove/--rollback` 同步删 install.json）。
- **结论**：✅ PASS（dry-run 零写入与 fail-closed 实测通过；非 dry-run 写盘路径未实跑，见 §8）。

### 4-A11 §1 不变项回归（显式退出 / before-quit / HMR）

- **T3 覆盖**：`T3:609-685`（HMR grace 内 re-attach 取消退出）、`T3:624-635`（detached+进程消失 → dsh-exit 不重启）、
  `T3:687-775`（显式退出防重启矩阵）、`T3:777-920`（before-quit 仅 PAIRED 杀 DSH、终止异常/拿不到 pid 仍退出）。
- **verifier 独立复现**：A10（PAIRED detached+进程消失 → `quit('dsh-exit')`、0 launch/0 terminate；HMR 750ms 内
  re-attach → 保持 PAIRED 不重启）；A11（PAIRED before-quit → 拦截一次 + terminate(pid) + `quit('pet-exit')`；
  第二次放行不卡死）。
- **结论**：✅ PASS（强耦合默认语义保持）。

### 4-A12 §7.3 其余项速览

| # | 场景 | T3 用例 | 结果 |
|---|---|---|---|
| 1 | 握手健康 → PAIRED；显式退出跟随；崩溃重启≤2 | `T3:466-475,541-604,609-685` | ✅ |
| 5 | DSH 版本未知 → 超时 DEGRADED(compat-unverified)，不猜兼容 | `T3:1072-1097` | ✅ |
| 9 | STARTING 拉起失败 180s → DEGRADED(startup-failed)，之后不再 launch | `T3:1157-1180` | ✅ |
| 11 | 崩溃重启用尽 → DEGRADED，不 quit | `T3:561-586` | ✅ |
| 13 | 告警去重 | `T3:1241-1266` | ✅ |
| 安装清单兜底（E6） | 运行时 compat 缺失时用 install.json 静态判定 | `T3:1268-1309` | ✅ |

## 5. 与计划的偏离 / 发现的问题（显式列出；无 FAIL）

### D1（低风险·契约偏差）`semver-range.ts` 的 caret 语义与当前 DSH 内嵌 node-semver 不一致

- **事实**：当前 DSH app.asar 内 `dsh/node_modules/semver/package.json` = **7.8.6**（dsh-app-boot 依赖 `semver:^7.8.5`，
  `dsh-app-boot/lib/index.js:1094-1095` 用 `semver.satisfies(v, range, {includePrerelease:true})`）。
  `src/shared/semver-range.ts` 文档与实现按 **7.7.x** 语义（caret 0.x 下界补 `-0`）：
  `satisfiesSemverRange('0.2.2-rc.1','^0.2.2')=true`；而 DSH 内嵌 7.8.6 为 `false`
  （7.8.x 起 `replaceCaret` 删除了下界 `-0`，见 `semver/classes/range.js` 差异）。
- **本轮影响**：**无**。所有真实 range 都是裸比较符：桥 `engines.dsh='>=0.2.2-rc.1 <0.3.0'`、
  `BRIDGE_LEGACY_DSH_RANGE` 相同、runtime compat/install.json 均复制该值。verifier 以 7.8.6 对
  「7 条裸比较符/legacy range × 10 版本」交叉验证 **0 mismatch**；仅全语法矩阵的 `^0.2.2`×`0.2.2-rc.1`
  一格不符（已写成显式用例记录）。
- **风险方向**：若未来桥声明 caret/x 语法且在 prerelease 版本上，桌宠可能比 DSH 闸门**偏宽**（桌宠认为兼容、
  DSH 闸门禁用桥 → 桌宠最终走 `no-bridge-unpaired` 降级，安全方向；但违反「双源一致」契约）。
- **建议**：桥 `engines.dsh` 契约上限定为**裸比较符**（当前即是），或把 `semver-range.ts` caret 下界对齐
  semver 7.8.x（需同步 Lead 单测 `tests/semver-range.test.ts:83` 的 `['0.2.2-rc.1','^0.2.2',true]` 预期）。
- **Lead 收口（2026-11-11）**：采纳"契约限定裸比较符"方案 —— bridge README/plan 写入维护规则，
  并在 `tests/bridge-plugin.test.ts` 新增「D1 收口」守卫用例（`engines.dsh` 含 `^~x*-||` 即 fail）；
  `semver-range.ts` 头注释标注 caret/tilde 仅为防御性兜底、不得用于桥声明。实现不改（裸比较符语义稳定）。
- **证据**：`tests/tmp/verify-dsh-coupling/semver-parity.test.ts`（2 个用例：裸比较符 0 mismatch / 已知偏差清单）；
  `evidence/vitest-adversarial.log`。**不改本轮验收结论**。

### D2（信息·非问题）canary 隔离 WARN 的归因

- `--compat` 与默认 canary 均打印 `WARN 真实 ~/.dsh/aventurine-pet 在 canary 期间发生变化；若有其它 DSH 实例
  同时运行请忽略`。归因为**本会话宿主 DSH 桌面版正在运行**：真实 v3 桥持续写真实桥目录 `status.json`/`events.jsonl`
  （验证窗口内 events 836KB→890KB、status mtime 持续更新），而 `control.json` 内容未变（仍 12:48 的 v3 attached）。
  canary 自身使用临时 `DSH_HOME`（日志打印 `/var/folders/.../pet-dsh-canary-*/`）+ 两个临时
  `AVENTURINE_BRIDGE_DIR`；真实 `~/.dsh/profiles/desktop/cordis.patch.yml` sha256 未变。**不是隔离失效**，
  是计划 §7.2 的隔离自证在「真机 DSH 在跑」环境下的预期噪声；T4 已用 canary 输出/真实目录快照交叉自证。

### D3（轻微·文案）dry-run 摘要措辞

- `scripts/activate-dsh-bridge.mjs:913` 在 DRY-RUN 下输出 `[activate] DRY-RUN 已追加桥插件 insert 行`，
  「已追加」易误读为已写入（实际零写入已被 §4-A10 证实）；建议改为「将追加/将替换」。
  另 dry-run 因 `liveCopy=null` 不打印 live 副本 engines 摘要（信息仍可见于打印的 install.json 内容），非功能问题。

### D4（轻微·注释）测试注释错别字

- `tests/dsh-lifecycle.test.ts:1232` 注释「DSK 重新打开」应为「DSH」。纯注释，无行为影响。

### D5（流程·不属于实现缺陷）E2E 动态执行未验证

- 见 §6：由 Lead 负责适配/执行；verifier 未改 E2E 脚本、未实跑。按任务定义标注「未验证」，不影响总体结论。

### D6（信息·预期状态）真实环境仍为 v3 桥、未部署 v4

- 真实 `~/.dsh` profile 仍指向 12:33 的 v3 live 副本（该副本 `package.json` **无 engines**、`lib/constants.js`
  仍为 v3 旧版），本轮按计划**未**修改真实 profile/live 副本/未 HMR（§8 部署由用户执行）。因此本轮验收结论
  「legacy 兼容成立」对现网直接有效；v4 部署后的行为由 canary C3 + 单测覆盖，实机待 §8 步骤验证。

## 6. E2E 适配（任务项 4：stretch，未验证）

- **分工现状**：Lead 已明确 E2E 脚本由其负责；验证窗口内 Lead 正在改 `scripts/wave3-e2e/lib.mjs`、
  `e2e-coupling.mjs`（mtime 14:33，未提交）。verifier **未修改、未运行**这两个文件。
- **verifier 静态复核所需 diff 的落地情况**（对计划 §7.4）：
  1. ✅ `writeControl` 默认写 `bridgeVersion: 3`（legacy 回退）+ 支持 `extra` 覆盖 v4 compat（`lib.mjs:578-594`）；
  2. ✅ PAIRED 同时需要 status online + control attached：既有 A/B/D/E 场景均同时 `writeStatus` + `writeControl('attached')`
     （`e2e-coupling.mjs:213-214,258-259,291-292,331-332,366-367`）；
  3. ✅ E2E 启动 env 统一 `PET_DSH_COUPLING_SILENT_ALERTS=1`（`lib.mjs:199-201`，可 extra 覆盖）；
  4. ✅ safe-mode/桥目录隔离沿用 `PET_DSH_DIR` 临时目录（`lib.mjs:170-206`）；
  5. ⚠️ 计划 §7.4.5 的新增场景：Lead 已加 **F**（v4 compat 不兼容 → DEGRADED，不杀/不重启，fake 消失 →
     `dsh-degraded` 跟随退出），并改造 **C**（重启失败 → DEGRADED 常驻、不 cascade）；**G/H 尚未加入**
     （G：DEGRADED 下桌宠退出而 fake DSH 存活；H：握手恢复自动回 PAIRED）——均为计划中的可选项。
- **未跑原因**：① Lead 明确 E2E 脚本归其负责且正在修改，verifier 不改；② 运行 E2E 会与 Lead/另一会话并发操作
  Electron、free port、临时 profile / `dist`，且 verifier 被禁止跑全量 build/package（`out/` 在 14:32:48 由另一
  会话的 `package:dir` 重建，非 verifier 行为）；③ 原任务 20 分钟时间上限不足以稳定跑完 A–F 六场景。
- **建议**：Lead 收口后执行 `node scripts/wave3-e2e/e2e-coupling.mjs`（可加场景过滤逐个跑）；若要补齐 §7.4.5，
  在 F 基础上加 G/H 两个断言场景即可（所需 helper 已具备：`writeControl(...,extra)`/`waitPetExit`/`readLog`）。

## 7. 隔离与真实环境不变式（实测）

| 不变式 | 前 | 后 | 结论 |
|---|---|---|---|
| 真实 `~/.dsh/profiles/desktop/cordis.patch.yml` sha256 | `344ad48e…ee2` | 同值 | ✅ 未写 |
| 真实 profile 备份集合 | 4 个旧 `.bak*`（最新 12:33） | 无新增 | ✅ |
| 真实桥 `control.json` | `{"bridgeVersion":3,"ts":1794372520764,"action":"attached","dshPid":98123}` | 同值（内容） | ✅ 未被写 |
| repo `work/live-bridge/rev-1794371618691/**` | 3 文件 | 同 3 文件，`package.json` sha256 `af5f6964…`、`lib/index.js` `ab8d571a…` | ✅ 未变 |
| `src/renderer/**` 内容（模型侧在改文件） | `foot-lock.ts 74d227b9…`、`wave2-contract.ts 02640727…`、`runtime-types.ts 90761acb…` | 同值 | ✅ 本轮未触碰 |
| `tests/vrm-*.test.ts` | — | 已由另一会话提交（`2b9340a`），内容非本轮改动 | ✅ 无关联 |

- 真实 `~/.dsh/aventurine-pet/{status,events}` 的 mtime/体积变化来自**正在运行的真实 DSH 桥心跳**（非 canary/probe；
  canary 使用临时目录且 `control.json` 内容未变），已在 §5-D2 归因。

## 8. 剩余风险与建议

1. **非 dry-run 安装路径未被 verifier 实跑**（约束禁止）：live 副本创建 + `install.json` 实际写盘 + 激活后
   HMR 验证仅做代码审阅 + dry-run 形状验证 + canary C2/C3 形态等价验证。建议 Lead 在收口后按 §8 部署时
   留意脚本输出 PASS（`verifyActivation`）。
2. **v4 桥尚未部署**：现网 v3 → v4 的 HMR/回滚仅单测+canary 覆盖；部署时按 runbook 操作并观察
   `control.json` 的 `bridgeVersion=4`/`compat.dshRange`（脚本已内置 ≤10s 轮询验证）。
3. **semver caret 契约偏差**（D1）：建议按 §5-D1 处理（或在桥契约中显式限定裸比较符）。
4. **E2E G/H 未补**（可选）；A–F 已具备运行条件（见 §6）。
5. 「PAIRED 心跳丢失 → DEGRADED」的最坏时延约 60s（TTL 30s + 宽限 30s），若产品口径要求自最后心跳 30s 内降级，
   需调 watcher TTL 或 lifecycle 宽限；当前实现与计划「丢失后 30s」字面一致，记录备查。
6. DEGRADED 跟随退出在「进入时 DSH 已不在运行」下常驻等待属 Lead 裁定的有意行为（§4-A6），runbook 需确保
   用户能理解「桌宠不自杀、可打开 DSH 修复」，该文案已实现。

## 9. 证据文件清单

所有证据位于 `tests/tmp/verify-dsh-coupling/`（gitignored，符合写盘范围）：

| 路径 | 内容 |
|---|---|
| `evidence/vitest-primary.log` | 验收主力 10 文件 / 408 tests PASS |
| `evidence/vitest-regression.log` | 既有回归 4 文件 / 108 tests PASS |
| `evidence/typecheck-node.log` | `tsc -p tsconfig.node.json` exit 0 |
| `evidence/canary-compat.log` | canary `--compat` C1–C6 PASS（exit 0） |
| `evidence/canary-default.log` | 默认 canary PASS（exit 0，含环境隔离 WARN） |
| `evidence/activate-help.log` | `activate-dsh-bridge.mjs --help` exit 0 |
| `evidence/vitest-adversarial.log` | verifier 自写 13 对抗 + 6 semver parity tests PASS |
| `evidence/bridge-apply-probe.log` | 真实桥 `lib/index.js` apply 失败隔离探针 14/14 PASS |
| `evidence/installer-probe.log` | dry-run 零写入 / PyYAML fail-closed 探针 17/17 PASS |
| `evidence/baseline-status.txt` | 验证开始时 `git status`/diffstat/renderer sha256 基线 |
| `adversarial.test.ts` | verifier 独立 lifecycle 对抗用例（A1–A11） |
| `semver-parity.test.ts` | 与 DSH 内嵌 semver 7.8.6 的 parity/偏差用例 |
| `bridge-apply-probe.mjs` | 桥 apply 探针脚本（可复跑） |
| `installer-probe.sh` | 安装脚本 dry-run/fail-closed 探针（可复跑） |
| `vitest.config.mts` | verifier 私有 vitest 配置（只收集 tests/tmp，不改仓库配置） |

复跑方式（可选）：

```bash
pnpm exec vitest run --config tests/tmp/verify-dsh-coupling/vitest.config.mts
node tests/tmp/verify-dsh-coupling/bridge-apply-probe.mjs
bash tests/tmp/verify-dsh-coupling/installer-probe.sh
```

---

**结论重述：T1/T2/T3 实现满足计划 §7 验收标准（0 FAIL）；本报告 §5-D1 为低风险契约偏差（不影响本轮真实 range），
§5-D5/E2E 为未验证项（Lead 负责），其余为环境/文案说明。建议 Lead 在最终集成时决定 D1 是否在提交前收口。**
