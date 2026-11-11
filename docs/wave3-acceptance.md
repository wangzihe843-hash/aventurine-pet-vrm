# Wave 3 验收矩阵（V9 + V10 + DSH 双向集成）

> 日期：2026-11-11 · 状态：**自动化 + 隔离 E2E + 真机 HMR 激活（12:33）已完成；剩余用户实机观感勾选**
> 工作区：`/Volumes/4TB外置盘/deepseek-harness/aventurine-pet-vrm`（HEAD `3893943` + Wave 3 未提交改动；提交由 Lead 统一执行）
> 依据：[wave3-dsh-integration-design.md](wave3-dsh-integration-design.md)（冻结契约 v2）、
> [wave3-hmr-activation-verification-2026-11-11.md](wave3-hmr-activation-verification-2026-11-11.md)（HMR/live 副本/拉起修复）、
> [wave3-e2e-report-2026-11-11.md](wave3-e2e-report-2026-11-11.md)（独立隔离 E2E）、
> [wave3-perf-baseline-2026-11-11.md](wave3-perf-baseline-2026-11-11.md)（V9 性能）、
> [wave3-packaging-report-2026-11-11.md](wave3-packaging-report-2026-11-11.md)（V9 打包）、
> [docs/research/*-2026-11-11.md](research/)（R1–R4 调研）。
> 图例：✅ = 自动化/命令/实机实测通过；⏳ = 待用户实机勾选；⚠️ = 已接受的已知限制。
> **当前已处于「真机激活态」**（desktop profile 装桥、不重启 DSH、桌宠已由桥拉起并进入 PAIRED；用户确认屏幕可见）；
> 回滚命令与升级流程见 §3。

---

## 0. 一页结论

| 维度 | 结果 | 证据 |
|---|---|---|
| 全量测试 / typecheck | ✅ **129 files / 2419 passed + 11 skipped**（2026-11-11 最终）；`tsc node + web` 0 error | `pnpm test` / `pnpm typecheck` |
| 桥契约 canary | ✅ **PASS**：离线失败回合 + 本地 mock 成功回合（text 精确、无 user/reasoning 泄漏）+ `control.json` attached→detached；WARN「真实桥目录变化」属预期（live 桥正在写心跳） | `/tmp/w3-final-canary.log`；`pnpm dsh:canary` |
| V9 打包（dir + ad-hoc 签名） | ✅ 产出 `dist/mac-arm64/AventurinePet.app`（601 MB，bundle id `com.aventurine.pet`，**ad-hoc 签名**，min macOS 13.0）；`package-check` **35 passed / 1 warning / 0 failed** | [wave3-packaging-report](wave3-packaging-report-2026-11-11.md)；[packaging.md](packaging.md) |
| V9 性能基线 | ✅ idle fps **28.1–28.3**@fpsCap30（p95 29.5/max 30）、drawCalls 39、tri 51829、整树 RSS 964–993 MB、CPU 14.7%、启动 ready 0.78–0.80 s | [wave3-perf-baseline](wave3-perf-baseline-2026-11-11.md) |
| V10 烘焙动作口径 | ✅ app-manifest **40 clips** / catalog **181**，`build-app-manifest --check` PASS；⏳ 动作观感需用户勾选 | 本文 §1.3 |
| DSH 隔离 E2E | ✅ 桥 16/16、气泡 16/16、强耦合 38/38、打包版冷启动 23/23、smoke 回归 11/11；激活脚本曾 21/23（备份名缺陷，**已修复**并复验） | [wave3-e2e-report](wave3-e2e-report-2026-11-11.md) |
| 真机 HMR 激活（12:33） | ✅ `control.json` attached + **bridgeVersion=3** + dshPid=18937；status 心跳持续 online；桌宠被 **direct-exec** 拉起（pid 90219，父进程=DSH Host 18937）并进入 **PAIRED（startup-detected）**；用户确认屏幕可见；**DSH 未重启** | 本文 §2.3 |
| 用户实机观感 | ⏳ 气泡逐段观感、状态反应、强耦合退出场景、V10 动作六项待用户勾选 | 本文 §4 |

---

## 1. 自动化验收矩阵

### 1.1 V9 打包（A5）

| # | 验收项 | 证据（命令/文件/报告） | 状态 |
|---|---|---|---|
| V9-1 | `electron-builder.yml`（appId/productName/output/electronDist/`identity:null`/entitlements/min macOS 13.0/category/`extraResources`） | `electron-builder.yml`；构建日志 `loaded configuration` | ✅ |
| V9-2 | `build/entitlements.mac.plist` 占位（无 TCC key） | `plutil -lint build/entitlements.mac.plist` → OK | ✅ |
| V9-3 | `pnpm package:dir` 可复跑产出 `.app`（build + builder + package-check 一条命令） | `package.json` scripts：`package:dir`；产物 `dist/mac-arm64/AventurinePet.app` | ✅ |
| V9-4 | bundle 身份/最低系统 | Info.plist：`CFBundleIdentifier=com.aventurine.pet`、`CFBundleName=AventurinePet`、`LSMinimumSystemVersion=13.0` | ✅ |
| V9-5 | app.asar 入口与运行时依赖 | `package-check`：main/preload/renderer（含 settings）/`@electron-toolkit/utils` | ✅ |
| V9-6 | `extraResources` 与运行时路径一致 | `package-check`：helper universal（x86_64+arm64、minos 13.0）、model PMX+20 贴图、assets（图标/默认 VRM/app-manifest 40 clips/expressions/props） | ✅ |
| V9-7 | 可执行加载探针 | `ELECTRON_RUN_AS_NODE=1 .../AventurinePet -e ...` → electron 44.10.2 / node 24.22.2 / arm64，exit 0 | ✅ |
| V9-8 | **ad-hoc 签名**（macOS 27 AMFI 必需） | `build/after-pack-adhoc-sign.cjs`（afterPack 内 `codesign --force --deep --sign -`）；`codesign -dv`：`Signature=adhoc`、`flags=0x2(adhoc)`、`Identifier=com.aventurine.pet`、`Sealed Resources version=2`、`_CodeSignature/CodeResources` 存在 | ✅（详见 [packaging.md](packaging.md) §2.6） |
| V9-9 | Developer ID 签名 / 公证 / dmg / zip | 无（本机 0 有效证书；`identity:null` + afterPack 仅做 ad-hoc；`notarize:false`） | ⚠️ 未实现（**仅本机自用，不可分发**） |
| V9-10 | 应用图标 `.icns` | 回退 Electron 默认 `electron.icns`（package-check 唯一 warning） | ⚠️ 缺素材 |
| V9-11 | 打包版 GUI 冷启动（资源/VRM/overlay/气泡/winlist/单实例） | verifier E2E ④ **PASS 23/23**：`debug.ready=true`、humanoidBoneCount=53、clip `adv-idle`、textureCount=20、`.pet-bubble` 存在、winlist spawn 捕获、第二实例立即退出；证据 `tests/tmp/wave3-e2e/2026-11-10T18-47-15-666Z-packaged/` | ✅ |
| V9-12 | `pnpm build` / `pnpm smoke` 语义不被打包改动影响 | 打包只消费 `out/**`+`package.json`；`package:dir` 在 builder 后自动跑 package-check | ✅ |
| V9-13 | 打包版登录项（低优先） | 从 dist 运行未 `/Applications` 的 ad-hoc app 时 Electron 登录项 API `Operation not permitted`，wrapper 仍记 `applied:true`（`launchAtLogin=false` 默认无用户可见影响） | ⚠️ 记录（[known-issues](known-issues.md) W3-L13 相关） |

### 1.2 V9 性能基线（A6，已产出）

| # | 指标（VRM / 1080p / 50% / fpsCap30 / idle 60s） | 实测 | 建议阈值 | 状态 |
|---|---|---|---|---|
| V9P-1 | idle fps mean（cap30 run1/run2） | **28.11 / 28.29**（p95 29.5、max 30） | 26 ≤ mean ≤ 31，p95 ≤ 33 | ✅ |
| V9P-2 | drawCalls / triangles | **39 / 51,829** | 39±2 / ±100 | ✅ |
| V9P-3 | 整树 RSS 合计 / 主进程 RSS p50 | **964 / 993 MB**（上界式；主进程 220–223 MB） | ≤1150 MB / ≤280 MB | ✅ |
| V9P-4 | 整树 CPU%（idle interval） | **14.7%** | ≤20%（cap30） | ✅ |
| V9P-5 | 启动 spawn→ready / SIGTERM→退出 | **0.78–0.80 s / 0.90–1.02 s**，无残留进程 | ≤2.0 s / ≤2.0 s | ✅ |
| V9P-6 | fpsCap 上限有效性 | cap30 不超 30；cap60 实测 54.4（CPU 20.2%，+37.5%）→ 默认 30 合理 | — | ✅ |
| V9P-7 | legacy-pmx 回退对照 | fps 27.9、drawCalls 60、tri 86,792（含描边 pass）、RSS ~914 MB、CPU 9.75% | — | ✅（非回归） |
| V9P-8 | 复跑脚本 | `node scripts/vrm/measure-runtime.mjs [--label] [--fps-cap] [--check]`；产物 `tests/tmp/wave3-perf/` | — | ✅ |

> 局限：非打包构建（`electron .`）测量、机器有并行负载（loadavg 1.3–1.8）、RSS 求和含共享页重复计算；
> 报告 §5 已列明。Wave 3 功能收口后建议用同一脚本在 `.app` 上复测一轮。

### 1.3 V10 烘焙动作收口

| # | 验收项 | 证据 | 状态 |
|---|---|---|---|
| V10-1 | 运行时清单 | `assets/motions/app-manifest.json` = **40 clips**（idle 19 / walk 3 / sit 7 / drag 2 / pat 3 / sleep 1 / dshBusy 2 / dshDone 2 / dshError 1）；`app-catalog.json` = **181**（mate 30 / hsr 14 / adv 137） | ✅ |
| V10-2 | 清单与源数据一致 | `node scripts/vrm/motion/build-app-manifest.mjs --check` → PASS | ✅ |
| V10-3 | mate 口径 | **30 条**（Wave 1.5 报告 29 条 + 2026-11-09 男性适配新增 `dragFemale`）；`app-manifest` 含 26 条 `mate-` 前缀条目（22 直接 + 4 别名；hide 2/intro 3 仅 catalog，pose1-3 以 idle 别名进清单） | ✅ |
| V10-4 | HSR / adv 并入 | hsr 14 / adv 137 均入 catalog；adv 5 条进 app-manifest + 2 条 dsh 别名 | ✅ |
| V10-5 | 私有资产不进 git | `assets/**` gitignore；测试 `skipIf`；`package:check --skip-private-assets` 用于干净 clone 管线验证 | ⚠️ 已知限制 |
| V10-6 | 文档口径 | README/PLAN/wave2-acceptance 统一（29→30、43→181、app 清单 29→40） | ✅ |
| V10-7 | 用户实机动作观感 | 待用户按 [PLAN.md](../PLAN.md) §10 六项勾选（含 DSH 反应动作） | ⏳ |

### 1.4 DSH 桥 v2（A1）

| # | 验收项 | 证据 | 状态 |
|---|---|---|---|
| BR-1 | 契约 v2：`text`（8000 上限）+ `control.json`（attached/detached + **bridgeVersion** + dshPid）+ `launchPet` | `src/shared/bridge-schema.ts`（11 键、`DSH_EVENT_TEXT_MAX_CHARS=8000`、`parseDshBridgeControlFile` 含 bridgeVersion 校验）；`tests/bridge-schema*.test.ts` | ✅ |
| BR-2 | assistant 文本提取（content text 块 join / 空/超长/异常防御） | `bridge/.../lib/index.js` + `tests/bridge-plugin.test.ts` v2 用例 | ✅ |
| BR-3 | 隐私边界（不写 user/reasoning/tool/system 正文） | 契约注释 + bridge README + 单测哨兵断言 | ✅ |
| BR-4 | 控制帧生命周期 + 版本 | apply→`attached`、dispose→`detached`；原子写/0600；`bridgeVersion=BRIDGE_PLUGIN_VERSION`；真机实测 `bridgeVersion=3` | ✅ |
| BR-5 | `launchPet` 拉起（direct-exec `.app/Contents/MacOS/<CFBundleExecutable>` + 清洗 `ELECTRON_RUN_AS_NODE`；fallback `open`） | 真机：桌宠 pid 90219 父进程=18937（Host）→ direct-exec；HMR 报告 fake 验证 env 已清洗 | ✅（fallback `open` 仍继承 env，见 W3-L12） |
| BR-6 | 契约 canary v2 | `pnpm dsh:canary` **PASS**：失败回合（task/error 链、offline 帧）+ mock 成功回合（`assistant/message` 带精确 text：`canary-mock: 桥文本透传 OK。`、无 user/reasoning 哨兵）+ control attached→detached；**WARN 真实桥目录变化属预期**（live 桥正在写心跳，`/tmp/w3-final-canary.log` 有说明） | ✅ |
| BR-7 | engines.dsh / 升级 runbook | bridge package.json + README；HMR/live 副本升级流程见 §3 | ✅ |

### 1.5 DSH 气泡同步（A2 + Lead 接线）

| # | 验收项 | 证据 | 状态 |
|---|---|---|---|
| BB-1 | `DshDialogue` 纯逻辑（思考中→分段→停留→消失→下一段；队列/预算/去重/清洗/打断） | `src/renderer/src/reactions/dsh-dialogue.ts` + `tests/dsh-dialogue.test.ts`（45 it，fake clock） | ✅ |
| BB-2 | 与行为层气泡仲裁（`ownsBubble`；DSH 对话优先；gap hide；关闭开关释放） | `src/renderer/src/main.ts` 接线（Lead） | ✅（静态 + E2E 行为） |
| BB-3 | 配置开关 `dshBubbleSync`（默认 true，设置页可关） | `src/shared/{types,config}.ts`；设置页；`tests/settings-model.test.ts` | ✅ |
| BB-4 | 隔离 E2E：思考中→回复 A→段间隐藏→下一段 B→结束消失（截图 6 张） | verifier E2E ② **PASS 16/16**：停留实测 3163ms（期望 3055ms，容差内）；证据 `tests/tmp/wave3-e2e/2026-11-10T18-40-51-388Z-bubble/` | ✅ |
| BB-5 | 真机数据链路：真实 DSH turn 的 text 已进桥文件 | 真机 `events.jsonl`（107 行）中 **3 条带非空 text 的 `assistant/message`**，max 297 字符；最后一条 text 时间 2026-11-11T04:34:56Z | ✅ |
| BB-6 | 真机气泡目视（用户确认「思考中...→回复」实际出现） | Lead 只确认「屏幕可见」（桌宠窗口）；逐段气泡观感待用户下一轮确认 | ⏳ 用户确认 |
| BB-7 | 长文本/多 session 行为 | 96 字切块、单 turn 4000 字预算、队列 8（溢出丢最旧）；多 session 按到达序 | ⚠️ 已知取舍（W3-L4） |

### 1.6 强耦合 / 生命周期（A3 + Lead 接线）

| # | 验收项 | 证据 | 状态 |
|---|---|---|---|
| CP-1 | 进程探测/拉起/终止（lsappinfo→pgrep 兜底、`open -b`、SIGTERM→≤5s→SIGKILL、排除 Helper、不用 osascript） | `src/main/desktop/dsh-process.ts` + `tests/dsh-process.test.ts`（24 it） | ✅ |
| CP-2 | 状态机（DISABLED/STARTING/PAIRED/CASCADING、冷却/次数、重启 ≤2、grace 1.5s、防互杀环） | `src/main/desktop/dsh-lifecycle.ts` + `tests/dsh-lifecycle.test.ts`（31 it） | ✅ |
| CP-3 | 强耦合语义（**实际实现**） | ① 任一方启动→另一方不在则拉起；② 显式退出：桌宠 `before-quit`→SIGTERM DSH→退出；DSH 显式退出（detached grace 到期+进程已不在）→跟随退出**不重启**；③ 意外崩溃（进程消失且无 detached）→重启 ≤2 次，仍失败→级联退出；④ grace 内 re-attached（HMR）→取消误判；⑤ dev 须 `PET_DSH_COUPLING=1`；`PET_DSH_COUPLING_DISABLE=1` 强制关 | ✅（单测 + E2E） |
| CP-4 | control.json 接入 watcher（mtime+size、≤64KB、脏输入忽略、去重） | `src/main/desktop/dsh-watch.ts` + `tests/dsh-watch.test.ts` | ✅ |
| CP-5 | IPC/主进程接线（不新增 channel；before-quit/will-quit；设置热更） | `src/main/ipc/dsh.ts` + `src/main/config-access.ts` + `tests/dsh-ipc.test.ts` | ✅ |
| CP-6 | fake DSH 强耦合 E2E | verifier E2E ③ **PASS 38/38**：拉起→PAIRED→SIGKILL→2.3s 内恢复→5s 验证通过；HMR grace 取消；重启失败→级联；detached+消失→级联；pet 退出→fake SIGTERM 183ms；证据 `tests/tmp/wave3-e2e/2026-11-10T18-42-44-324Z-coupling/` | ✅ |
| CP-7 | **真机激活联动** | 桥 apply→`launchPet` **direct-exec** 拉起 `dist/mac-arm64/AventurinePet.app`（pid 90219，ppid 18937=DSH Host）；桌宠 `main.log`：`[dsh-lifecycle] 强耦合已启用，进入 STARTING`（isPackaged=true, dshCoupling=true）→ `进入 PAIRED（startup-detected）`；用户确认屏幕可见 | ✅ |
| CP-8 | 真机「一方显式退出另一方跟随」 | 激活后未执行（会终止真实 DSH/桌宠；属用户操作/后续验收）；语义由 E2E+单测覆盖 | ⏳ 未执行（按用户意愿保留） |

### 1.7 窥屏互动接口预留（A7）

| # | 验收项 | 证据 | 状态 |
|---|---|---|---|
| PK-1 | 只落接口（capability/权限/PeekGate/request/result/provider） | `src/shared/peek.ts`；`docs/peek-interface.md` | ✅ |
| PK-2 | 默认关闭 + fail-closed + stub 不可用 | `src/main/peek/service.ts` / `stub-provider.ts`；`tests/peek-gate.test.ts` + `tests/peek-service.test.ts`（62 + 41 例） | ✅ |
| PK-3 | 零采集/未接线/零 TCC | 未被 app 代码 import；无 fs/定时器；设置页不显示 | ✅ |

### 1.8 设置页（A4）

| # | 验收项 | 证据 | 状态 |
|---|---|---|---|
| ST-1 | 两开关（双向保活/气泡同步） | `src/renderer/settings.html`、`settings/main.ts`、`settings-model.ts` | ✅ |
| ST-2 | 状态文案（已连接（运行中/空闲）/未连接（安装桥插件后生效）） | `settings-model.describeDshStatus` + `tests/settings-model.test.ts` | ✅ |
| ST-3 | 设置页 HTML 契约测试 | `tests/settings-html.test.ts`（5 it） | ✅ |
| ST-4 | 真实激活后状态行显示「已连接」 | status.json online/running=true（真机实测）；设置页目视待用户确认 | ⏳ 用户确认 |

### 1.9 整体回归（隔离环境，verifier）

| # | 项 | 结果 | 证据 |
|---|---|---|---|
| RG-1 | `pnpm smoke` vrm + legacy-pmx 双后端 | ✅ **11/11 PASS**（`SMOKE_OK`、model.loaded、missingTextures=[]） | `tests/tmp/wave3-e2e/2026-11-10T18-47-48-066Z-regression/` |
| RG-2 | 真实 DSH/`~/.dsh` 隔离自证 | ✅ 全程真实 DSH pid 不变、真实 desktop patch 与桥目录签名未变、`open -b` 0 次 | e2e 报告 §3 |
| RG-3 | 全量 vitest / typecheck | ✅ 129 files / 2419 passed + 11 skipped；0 error | 2026-11-11 最终实测 |

---

## 2. 实机验证证据

### 2.1 隔离 E2E（verifier，全部在临时 HOME/profile/DSH_HOME，证据 `tests/tmp/wave3-e2e/`）

| # | 验证项 | 结果 | 证据目录 |
|---|---|---|---|
| E2E-1 | 桥隔离 E2E（临时 DSH_HOME + mock LLM 成功/失败回合） | ✅ **PASS 16/16** | `2026-11-10T18-44-37-805Z-bridge/` |
| E2E-2 | 气泡同步 E2E（思考中→回复→停留→段间隐藏→下一段→结束消失，6 张截图） | ✅ **PASS 16/16** | `2026-11-10T18-40-51-388Z-bubble/` |
| E2E-3 | 强耦合 E2E（fake DSH：拉起/重启恢复/grace 取消/级联/pet 退出 SIGTERM） | ✅ **PASS 38/38** | `2026-11-10T18-42-44-324Z-coupling/` |
| E2E-4 | 打包版冷启动（资源/VRM/overlay/气泡/winlist/单实例） | ✅ **PASS 23/23** | `2026-11-10T18-47-15-666Z-packaged/` |
| E2E-5 | 激活脚本 dry-run / 写入 / 幂等 / 回滚 | ⚠️ verifier 当时 **FAIL 21/23**（备份文件名不一致→默认 `--rollback` 找不到备份）；**已修复并复验 PASS**（见 §2.2） | `2026-11-10T18-45-02-652Z-activate/`（FAIL 原始证据） |
| E2E-6 | 回归 `pnpm smoke`（vrm + legacy-pmx 双后端） | ✅ **PASS 11/11** | `2026-11-10T18-47-48-066Z-regression/` |

> 完整判定、断言明细、安全红线核对与未覆盖项见 [wave3-e2e-report-2026-11-11.md](wave3-e2e-report-2026-11-11.md)。
> E2E-3 的 `dsh-exit` 精确分支因 3s tick 与 1.5s grace 竞态未稳定复现（观测为语义等价的 `dsh-gone`），由单测覆盖。

### 2.2 E2E-5 缺陷修复与复验

- **缺陷**：旧脚本备份名生成 `${patchPath}.cordis.patch.yml.bak-wave3-<ts>`（双前缀），而 `findLatestBackup`
  只匹配 `cordis.patch.yml.bak-wave3-*` → 默认 `--rollback` 永远找不到备份（显式 `--backup` 可用）。
- **修复**：脚本改为 `BACKUP_SUFFIX = 'bak-wave3-'`、备份名 `${patchPath}.bak-wave3-<ts>`（与查找前缀一致）；
  真机激活备份已实测为 `cordis.patch.yml.bak-wave3-1794371618741`（12:33，1537B）。
- **复验**：Lead 用隔离 fake home（`/tmp/w3-act2` 演练）验证 `activate → rollback` 后 patch 与原始**完全一致**；
  之后的真机 HMR 激活成功（§2.3）也证明激活路径可用。回滚命令见 §3.5。
- 证据：`/tmp/w3-act2/original.yml`（演练用原始 patch），真机 profile 备份列表见 §2.3。

### 2.3 真机激活记录（2026-11-11 12:33，desktop profile，HMR，不重启 DSH）

> 用户已确认桌宠在屏幕上可见；DSH Host 全程未重启（pid 18937 自前一日持续存活）。

| # | 证据 | 实测值 |
|---|---|---|
| R-1 | `~/.dsh/aventurine-pet/control.json` | `{"schemaVersion":1,"bridgeVersion":3,"ts":1794371620801,"action":"attached","dshPid":18937}`（ts=2026-11-11T04:33:40.801Z=**12:33:40 +08**） |
| R-2 | `~/.dsh/aventurine-pet/status.json` 心跳 | `{"ts":1794371780827,"running":true,"agents":1,"lastEventAt":…,"lastType":"session/event","offline":false}`（12:36:20 +08，持续刷新） |
| R-3 | 真实 desktop profile patch | `cordis.patch.yml:48-54` 追加 `id: aventurine-bridge`，`name` 指向 **live 副本** `work/live-bridge/rev-1794371618691/lib/index.js`，config：`dir: "~/.dsh/aventurine-pet"`、`launchPet: true`、`petAppPath: ".../dist/mac-arm64/AventurinePet.app"`、`petBundleId: "com.aventurine.pet"` |
| R-4 | 激活备份 | `~/.dsh/profiles/desktop/cordis.patch.yml.bak-wave3-1794371618741`（12:33，1537B） |
| R-5 | live 副本 | `work/live-bridge/rev-1794371618691/`（48K，含 `lib/index.js`、`lib/constants.js`、`package.json`；`BRIDGE_PLUGIN_VERSION=3`；gitignored；历史 rev 由脚本自动修剪保留最近 5 个） |
| R-6 | 桌宠进程（direct-exec） | `ps`：`90219 18937 …/dist/mac-arm64/AventurinePet.app/Contents/MacOS/AventurinePet`（**ppid=18937 = DSH Host**，非 LaunchServices `open`） |
| R-7 | 桌宠 `main.log`（`~/Library/Application Support/aventurine-pet/logs/main.log`） | `2026-11-11T04:33:43.776Z [INFO] [dsh-lifecycle] 强耦合已启用，进入 STARTING {"isPackaged":true,…"dshCoupling":true,"dshBubbleSync":true…}` → `04:33:43.879Z [INFO] [dsh-lifecycle] 进入 PAIRED（startup-detected） {"attachedAt":1794371620801}` |
| R-8 | 桥事件文本链路 | `events.jsonl` 107 行，其中 **3 条带非空 `text` 的 `assistant/message`**（max 297 字符），最后一条 text 时间 `2026-11-11T04:34:56Z` |
| R-9 | 打包版签名（真机可启动前提） | `codesign -dv dist/mac-arm64/AventurinePet.app`：`Signature=adhoc`、`flags=0x2(adhoc)`、`Identifier=com.aventurine.pet`、`Sealed Resources version=2 rules=13 files=290` |
| R-10 | DSH 未重启 | Host `pid 18937`（父 18926）连续存活（`etime` 15h+），本次激活全程无重启 |
| R-11 | 用户确认 | 用户确认桌宠**屏幕可见**；桥拉起成功、强耦合进入 PAIRED |

**真机激活态当前保留**（未回滚）；回滚/升级按 §3 执行。若需停止联动：`node scripts/activate-dsh-bridge.mjs --rollback`。

### 2.4 未覆盖 / 待用户项

| 项 | 说明 |
|---|---|
| 真机气泡逐段观感 | 真机数据链路已证明 `text` 进桥；「思考中...→回复→消失→下一段」的目视确认待用户下一轮 DSH 会话确认 |
| 真机状态反应观感 | busy/done/error 动作与台词待用户确认 |
| 真机强耦合「退出跟随」 | 需终止真实 DSH 或桌宠，按用户意愿保留（隔离 E2E 已覆盖语义） |
| 打包版登录项 | dist 运行的 ad-hoc app 登录项 API `Operation not permitted`（默认关闭，无影响；见 W3-L13 相关记录） |
| 多显示器 / 长时间稳定性 / 真实计费模型回合 | 未覆盖（单主屏、mock/桥文件注入） |
| V10 动作观感 | 用户按 PLAN §10 勾选 |

---

## 3. 激活、升级与回滚（当前 live-copy 机制）

### 3.1 机制（重要，2026-11-11 实机修正）

- **HMR 免重启**：桌面版 DSH（0.2.2-rc.1）修改运行中 profile 的 `cordis.patch.yml` 会触发
  `app-boot/config-reload` → 旧桥 `dispose` → 新实例 `apply`（1–2s），无需重启 DSH。
- **HMR 不会重新求值同一模块路径**（Node ESM URL 缓存）：同一 Host 进程内，改仓库 `lib/index.js`
  再 recompose 仍执行旧代码（隔离实测，见 [wave3-hmr-activation-verification](wave3-hmr-activation-verification-2026-11-11.md)）。
  因此激活脚本**默认自动生成新路径 live 副本**：`work/live-bridge/rev-<ts>/`（含 `index.js`/`constants.js`/`package.json`，
  gitignored，自动保留最近 5 个 rev），patch 的 `name` 指向该副本；副本的 `BRIDGE_PLUGIN_VERSION`
  会打印，激活后必须核对 `control.json.bridgeVersion`。
- **`ELECTRON_RUN_AS_NODE=1` 继承问题**：DSH Host 环境带该变量，桥 `launchPet` 改为**直接 spawn
  `.app/Contents/MacOS/<CFBundleExecutable>` 并清洗该 env**（fallback `open` 仍继承 env，见 W3-L12）。
- **`control.json.detached` 只是桥卸载信号**（HMR 也会 detach），桌宠侧用 1.5s grace + 进程探测组合判定。

### 3.2 激活（当前已在激活态；重新激活前必须先回滚）

```bash
cd /Volumes/4TB外置盘/deepseek-harness/aventurine-pet-vrm
APP="$PWD/dist/mac-arm64/AventurinePet.app"

# 0) 预演（只打印，不写文件；会显示将生成的 live 副本入口与 insert 块）
node scripts/activate-dsh-bridge.mjs --pet-app "$APP" --dry-run

# 1) 实际激活（自动：生成新 live 副本 → 备份 patch → YAML 校验 → 追加 insert）
node scripts/activate-dsh-bridge.mjs --pet-app "$APP"
#    输出会打印：备份路径、live 桥入口、BRIDGE_PLUGIN_VERSION=<n>
#    幂等：patch 已含 id: aventurine-bridge 时拒绝执行（提示先 --rollback）
```

### 3.3 激活后核对清单

| 项 | 期望（本次 12:33 实测） |
|---|---|
| `control.json` | `action=attached`、`bridgeVersion` = 脚本打印的 live 副本版本（本次 **3**）、`dshPid` = 真实 Host pid（**18937**） |
| `status.json` | `offline:false`，`ts` 每 5s 刷新（30s TTL 内 online） |
| 桌宠进程 | direct-exec 出现：`ps -axo pid,ppid,args \| grep 'AventurinePet.app/Contents/MacOS/AventurinePet'`，**ppid = DSH Host pid** |
| 桌宠 main.log | `[dsh-lifecycle] 强耦合已启用，进入 STARTING` → `进入 PAIRED（startup-detected）` |
| 设置页 DSH 状态 | 「已连接（运行中/空闲）」 |
| 事件流 | 下一次 DSH turn：`events.jsonl` 增长（`task/start` → `session/event(text)` → `task/end`） |
| 约束 | 激活后**不要无故再改 profile patch**：每次 recompose 都会再 apply 一次并再拉起一次桌宠（单实例锁会合并，但日志/时序会乱） |

### 3.4 升级桥代码（新 rev，免重启）

```bash
# 1) 先回滚（移除旧 insert 行 → HMR dispose → control.json detached）
node scripts/activate-dsh-bridge.mjs --rollback
# 2) 重新激活：脚本自动生成新的 <rev> live 副本（新模块 URL → 新代码）
node scripts/activate-dsh-bridge.mjs --pet-app "$PWD/dist/mac-arm64/AventurinePet.app" --dry-run
node scripts/activate-dsh-bridge.mjs --pet-app "$PWD/dist/mac-arm64/AventurinePet.app"
# 3) 核对 control.json.bridgeVersion == 新副本 BRIDGE_PLUGIN_VERSION（关键！）
```

> 注意：升级**必须**先回滚再激活（脚本幂等检查会拒绝已有 insert 行）；不要「同 id 改 name」或
> 「同路径 recompose」——都不会加载新代码（隔离实测）。`work/live-bridge/` 由脚本自动修剪旧 rev。

### 3.5 回滚

```bash
node scripts/activate-dsh-bridge.mjs --rollback            # 自动找最近 cordis.patch.yml.bak-wave3-<ts>
node scripts/activate-dsh-bridge.mjs --rollback --dry-run  # 预演
# 也可显式指定：node scripts/activate-dsh-bridge.mjs --rollback --backup <path>
```

**顺序与预期**：回滚 → HMR reload → 桥 `dispose`（写 `detached`）→ 桌宠按强耦合策略退出/等待 →
`status.json` 最终 offline（≤30s）→ 手动退出桌宠（若仍在）→ 桥目录保留为证据。
本次真机备份：`cordis.patch.yml.bak-wave3-1794371618741`（12:33）。回滚后核对：patch 与激活前 hash 一致、
`control.json` detached、无残留桌宠/额外桥进程；若 HMR 异常：删除 insert 行即可，提示用户下次重启 DSH 恢复原状。

### 3.6 常见问题（2026-11-11 实机补充）

| 现象 | 可能原因 | 处理 |
|---|---|---|
| 激活后 `control.json` 无 attached / 无心跳 | HMR 未触发；insert YAML 写坏；live 入口路径不存在（如 `work/live-bridge/<rev>` 被删） | 检查 patch YAML 与 live 目录；用 `--dry-run` 复核；必要时回滚后重新激活（新 rev）或重启 DSH |
| `control.json` attached 但 `bridgeVersion` 与脚本打印不一致 | 加载了旧模块（同路径缓存 / 复用了旧 rev） | 回滚 → 重新激活（自动新 rev）；确认 patch `name` 指向最新 rev |
| 桌宠未拉起 / 拉起即退 | Host 带 `ELECTRON_RUN_AS_NODE=1` 且走了 fallback `open`；`.app` 可执行名/bundle 结构异常 | 确认 `petAppPath` 指向的 `.app` 存在且 `Contents/MacOS/<CFBundleExecutable>` 存在（本次已核对）；fallback 已知缺口见 W3-L12 |
| 完全无签名 `.app` 启动即退（AMFI no CMS blob） | macOS 27 AMFI 要求签名 | 已由 afterPack ad-hoc 签名解决（§[packaging.md](packaging.md) §2.6）；重打包会自动签 |
| 桌宠把 HMR 重载误判为 DSH 退出 | grace/探测组合未生效 | 检查 `main.log [dsh-lifecycle]`；HMR 正常应 1.5s grace 内 re-attached |
| 改桥代码后行为不变 | HMR 不 watch 仓库源码/同路径 ESM 缓存 | 按 §3.4 回滚→重新激活（新 rev） |
| canary 出现「真实桥目录变化」WARN | 真机 live 桥正在写心跳（预期） | 忽略该 WARN（隔离断言仍以临时目录为准） |

---

## 4. 用户待办 / 勾选清单

- [x] **DSH 激活**（12:33 已完成，HMR 免重启；用户确认屏幕可见）
- [ ] **气泡同步目视**：在下一轮 DSH 会话确认「思考中... → 每段回复 → 停留消失 → 下一段」（真机 text 已进桥）
- [ ] **状态反应观感**：确认 busy/done/error 动作与台词（含 error 长时间倒地→revive）
- [ ] **强耦合语义**：确认接受默认开（`dshCoupling: true`）；「任一方退出另一方跟随/崩溃先重启 ≤2 次」；
      是否需要在真实环境演示一次「桌宠退出→DSH 跟随」（会关闭当前 DSH 会话，默认不建议）
- [ ] **V10 动作观感**：按 [PLAN.md](../PLAN.md) §10 六项勾选（含 DSH 反应动作）
- [ ] **打包版自用**：`dist/mac-arm64/AventurinePet.app`（ad-hoc）实际启动、透明 overlay、点击穿透、托盘、设置窗正常
- [ ] **开机自启**：是否开启 `launchAtLogin`（默认关；打包版才会真正写系统登录项）
- [ ] **TCC**：确认本应用**不需要**屏幕录制/辅助功能授权（winlist 只读窗口几何、不读标题/不截图）；
      若未来上窥屏内容级能力，按 [packaging.md](packaging.md) §3 红线流程
- [ ] **激活维护**：接受「桥入口=仓库内 live 副本（`work/live-bridge/<rev>`）、移动仓库/删除该目录后需重新激活」；
      升级 = 回滚 + 重新激活（新 rev），每次激活后核对 `bridgeVersion`
- [ ] **已知限制**：接受仅本机 ad-hoc 签名（不可分发）、无应用图标、601 MB、多 session 到达序、长回复只播尾部等
      （见 `docs/known-issues.md` W3-L1~L13）

---

## 5. 复跑命令速查

```bash
cd /Volumes/4TB外置盘/deepseek-harness/aventurine-pet-vrm

# 自动化（本轮最终数字：129 files / 2419 passed + 11 skipped；typecheck 0 error）
pnpm typecheck
pnpm test
pnpm dsh:canary                        # v2：离线失败回合 + 本地 mock 成功回合（~40s，无外网/费用）

# V9 打包（build + builder + package-check 一条命令）
pnpm package:dir                       # → dist/mac-arm64/AventurinePet.app（ad-hoc 签名）
pnpm package:check                     # 期望 35 passed / 1 warning / 0 failed
codesign -dv --verbose=2 dist/mac-arm64/AventurinePet.app   # 期望 Signature=adhoc

# V9 性能（隔离 profile；~2-3 min/轮）
node scripts/vrm/measure-runtime.mjs   # 证据 tests/tmp/wave3-perf/
node scripts/vrm/measure-runtime.mjs --check

# V10 动作清单
node scripts/vrm/motion/build-app-manifest.mjs --check

# 激活/升级/回滚（Lead/维护者；先 --dry-run；升级=回滚+重新激活）
node scripts/activate-dsh-bridge.mjs --pet-app "$PWD/dist/mac-arm64/AventurinePet.app" --dry-run
node scripts/activate-dsh-bridge.mjs --pet-app "$PWD/dist/mac-arm64/AventurinePet.app"
node scripts/activate-dsh-bridge.mjs --rollback

# 隔离 E2E（verifier；~5-8 min 全跑）
node scripts/wave3-e2e/e2e-bridge.mjs
node scripts/wave3-e2e/e2e-bubble.mjs
node scripts/wave3-e2e/e2e-coupling.mjs
node scripts/wave3-e2e/e2e-packaged.mjs
node scripts/wave3-e2e/e2e-activate.mjs
node scripts/wave3-e2e/e2e-regression.mjs
```

---

## 6. 证据索引

| 证据 | 路径 |
|---|---|
| Wave 3 + DSH 集成实施设计（冻结契约 v2 / 激活步骤 / 风险） | [wave3-dsh-integration-design.md](wave3-dsh-integration-design.md) |
| HMR 激活验证 + live 副本 + direct-exec/env 修复 + runbook | [wave3-hmr-activation-verification-2026-11-11.md](wave3-hmr-activation-verification-2026-11-11.md) |
| 独立隔离 E2E（6 项断言、安全红线自证、证据目录） | [wave3-e2e-report-2026-11-11.md](wave3-e2e-report-2026-11-11.md) |
| V9 性能基线（fps/RSS/CPU/启动/关停/阈值） | [wave3-perf-baseline-2026-11-11.md](wave3-perf-baseline-2026-11-11.md) |
| V9 打包交付报告（构建日志/产物/package-check） | [wave3-packaging-report-2026-11-11.md](wave3-packaging-report-2026-11-11.md) |
| 打包/TCC/ad-hoc 签名/已知限制 | [packaging.md](packaging.md) |
| 桥插件 v2 契约/HMR/升级 runbook | [bridge/README.md](../bridge/dsh-aventurine-bridge/README.md) |
| 窥屏接口预留（未接线） | [peek-interface.md](peek-interface.md) |
| R1–R4 调研 | [research/](research/)（`*-2026-11-11.md`） |
| 已知问题与 Wave 3 限制 | [known-issues.md](known-issues.md)（R-07、W3-L1~L13） |
| Wave 2 历史验收 | [wave2-acceptance.md](wave2-acceptance.md) |
| 隔离 E2E 证据 | `tests/tmp/wave3-e2e/**`（gitignore） |
| 性能原始数据 | `tests/tmp/wave3-perf/**`（gitignore） |
| HMR 实验证据 | `tests/tmp/w3-hmr/**`（gitignore） |
| 真机激活运行证据（受控保留） | `~/.dsh/aventurine-pet/{control.json,status.json,events.jsonl}`；`~/Library/Application Support/aventurine-pet/logs/main.log`；`~/.dsh/profiles/desktop/cordis.patch.yml{.bak-wave3-*}`；`work/live-bridge/rev-*` |
