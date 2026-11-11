# Wave 3 V9 / A6 性能基线（2026-11-11）

> 任务：`task-11`（A6 V9 性能）——依据 `docs/wave3-dsh-integration-design.md` §9.2。
> 执行者：perf-worker。工作区：`/Volumes/4TB外置盘/deepseek-harness/aventurine-pet-vrm`。
> 交付：`scripts/vrm/measure-runtime.mjs`（新，可重复执行）+ 本报告（数据来自 2026-11-11 凌晨真实采样）。
> 结论先行：**生产构建在 1080p/50% 默认配置、VRM 后端、fpsCap=30 下，idle 实测 fps 均值 28.1–28.3（p95 29.5，max 30），drawCalls 39、triangles 51829，整进程树 RSS 合计约 0.96–0.99 GB（主进程约 220 MB），整树 CPU 约 14–15%（M5 Max/18 核，机器仍有其它并行任务），启动 spawn→renderer ready 约 0.79 s，SIGTERM→退出约 0.9–1.0 s，无残留进程。fpsCap 上限有效；把 cap 提到 60 后 idle fps 均值 54.4、CPU 升到约 20%，说明帧率上限是主要 CPU 成本开关，默认 30 合理。**

---

## 1. 范围与方法

### 1.1 测量对象

- **生产构建**（非 dev server、非打包 .app）：仓库根 `electron .` 加载 `out/main/index.js` + `out/renderer/index.html`。
- 真实 VRM 渲染路径（`PET_MODEL_BACKEND` 默认 `vrm`；debug 自检 `avatarId=aventurine-waveflair`、humanoid 骨 53、expression 95、spring 链 50、材质 39、贴图 17、顶点 37196、三角 51829、当前 clip `adv-idle`）。
- 默认配置（`sizePercent=50`，1080p 主屏 → petHeightPx=540；`opacity=1`；`autonomous=true`；`fpsCap=30`）。
- 对照组：`fpsCap=60`（预置 config）与 `legacy-pmx` 后端（`PET_MODEL_BACKEND=legacy-pmx PET_ANIM_BACKEND=legacy-pmx`，用于近似「VS v1」回退路径）。

### 1.2 隔离与安全（沿用仓库既有隔离模式）

参考 `scripts/vrm/capture-app.mjs` / `scripts/vrm/e2e-restart.mjs` 的隔离启动模式：

- `HOME=/tmp/w3-perf-home`（临时 HOME；可用 `--home` 覆盖）；
- `PET_PROFILE=w3-perf`：dev 下 app 将 userData 指向
  `<系统 home>/Library/Application Support/aventurine-pet-w3-perf`
  —— **注意** macOS `app.getPath('appData')` 不受 `$HOME` 影响（同 `e2e-restart.mjs:22-47` 的说明），所以 userData 落在真实 Application Support 的**独立 profile 子目录**；脚本每轮默认删除该目录保证确定性（`--keep-profile` 可保留），不触碰用户默认 `aventurine-pet`；
- `PET_DSH_DIR=/tmp/w3-perf-home/.dsh/aventurine-pet`：硬隔离 DSH 桥目录；**不打开真实 DSH、不装桥、不读写真实 `~/.dsh`**；脚本还对真实 `~/.dsh/aventurine-pet` 做**只读**前后快照并校验 hash 未变（每次运行 `isolation.realDshUntouched=true`）；
- 不设置 `PET_SMOKE_TEST` / `PET_DEV_CAPTURE_*`（脚本还会主动从继承环境删除这些变量），app 走正常启动路径（真实渲染 + 正常自主行为）；
- 每轮结束 `SIGTERM → 等待 → SIGKILL 兜底 + 清理 tracking 到的进程树`，`shutdown.leftoverTrackedPids=[]`；运行后 `ps` 复核无残留 Electron；
- 只新增 `scripts/vrm/measure-runtime.mjs` + 本报告 + `tests/tmp/wave3-perf/`（已 gitignore，`.gitignore:56`）；**未改源码/配置、未 git commit**。

### 1.3 采样方式

1. `--remote-debugging-port=<随机空闲端口>` 启动 Electron（非打包 dev 模式，单实例锁不启用，避免与任何已有实例冲突）；
2. 轮询 CDP `/json/list`，连接 renderer page，轮询 `window.__aventurineDebug.ready === true && model.loaded === true` 作为 ready（记录 `spawn→CDP target` / `spawn→ready`）；
3. **每 `sampleMs`（默认 1000ms）** 通过 CDP `Runtime.evaluate` 读取 `window.__aventurineDebug.stats()`：`fps`、`drawCalls`、`triangles`、`petHeightPx`、`petRect`、`displayId`、`isPrimaryDisplay`、`outlinePx`，以及 `behavior.activity/mood`、`errors`；
4. 同一 tick 用 `ps -axo pid,ppid,rss,time,pcpu,comm` + `ps -o pid,args` 采样**本实例 Electron 进程树**：主进程 / renderer / GPU / utility 的 RSS 与累计 CPU 时间；CPU% 用**相邻两次累计 CPU 时间的差值 / 墙上时间**计算（interval），另记录 `ps` 的 lifetime 平均值与系统 `loadavg`；
5. 阶段：`warmup`（默认 5s，不计入统计）→ `idle`（默认 60s，不主动触发动作，让自主行为自然发生）→ `action`（默认 20s，每 5s 用 `debugTriggerActivity()` 轮换触发 `walkTo / returnCorner / idleStretch / lookAround / idleToss / idleCoin / idleTidy` 真实活动；被冷却/姿态/窗沿约束拒绝时记录 `ok=false`，属预期）；
6. `SIGTERM` 关停并记录 shutdown 耗时/退出码/残留；把 `main.log`、app stdout/stderr 复制进结果目录。

> 说明：`__aventurineDebug` 是**生产构建同样存在**的调试面（`src/renderer/src/debug.ts` 文件头明确），所以本方法不需要 dev-only 的 `PET_DEV_CAPTURE_*` 回环，也不需要冒烟模式（`PET_SMOKE_TEST=1` 会走 app 自身的断言/退出路径，不适合长时采样）。

### 1.4 构建口径（重要）

| 项 | 值 |
|---|---|
| git HEAD | `3893943`（`fix(vrm): 抬脚释放阈值 + hipShift 命中区补偿`） |
| out/ 构建时间（本报告最终 4 轮实际使用） | `2026-11-10T18:34:47Z` = 本地 **2026-11-11 02:34:47**，`stale=false`（构建时间晚于当时最新源码 mtime） |
| 工作树状态 | 测量期间有其它 worker 并行改动：`git status --porcelain` 53→59 个未提交文件（含 `src/main/desktop/*`、`src/shared/*`、`bridge/*`、`docs/*` 等 Wave 3 并行 WIP） |
| 打包形态 | 非打包（`electron .`，`app.isPackaged=false`）。dev userData profile 隔离、登录项写入跳过；**渲染/VRM/动画/窗口/协议代码路径与打包版一致**（打包版仅资源根路径与网络 guard 不同） |

> 口径说明：本报告是「**当前 main 工作树的生产构建**」基线（Lead 要求的“改动前基线：可在当前 main 上先测一轮”）。测量期间（02:34）另一 worker 刷新过一次 `out/`；最终 4 轮均使用该 02:34 构建（每轮 `environment.json` 都记录构建时间与 dirty 数，可审计）。**Wave 3 集成收口、最终 `pnpm build` 之后应重跑 `measure-runtime.mjs` 做严格 before/after 对比**（脚本可重复执行，见 §6）。
> 备注：02:34 之前的首轮采样（旧 `out/`，构建于 01:13）与刷新后同配置结果差异 <1 fps（idle 约 27.9 vs 28.1），说明结论对这次构建刷新不敏感；旧产物目录未保留。

---

## 2. 环境

| 项 | 值 |
|---|---|
| 机器 | Apple M5 Max，18 CPU、32 核 GPU，36 GB RAM |
| OS | macOS 27.2（Build 26B123），darwin arm64 |
| 显示器 | 内置 1920×1080 @60Hz（主屏，唯一在线屏） |
| Electron | 44.10.2（Node v24.21.0） |
| 测量期间系统负载 | `loadavg1` 均值 **1.3–1.8**（其它 worker 的构建/测试在并行运行，见各 run 的 `analysis.phases.*.loadavg1`） |

---

## 3. 采样数据

原始产物（**gitignored**，`tests/tmp/wave3-perf/`）：

| run | 目录 | 配置 | 说明 |
|---|---|---|---|
| cap30-run1 | `tests/tmp/wave3-perf/2026-11-10T18-35-43-496Z-cap30-run1/` | 默认 fpsCap=30 | idle 60s + action 20s |
| cap30-run2 | `tests/tmp/wave3-perf/2026-11-10T18-37-19-517Z-cap30-run2/` | 默认 fpsCap=30 | 重复性验证 |
| cap60-run1 | `tests/tmp/wave3-perf/2026-11-10T18-38-55-541Z-cap60-run1/` | 预置 `config.fpsCap=60` | idle 60s + action 20s |
| legacy-pmx | `tests/tmp/wave3-perf/2026-11-10T18-40-56-719Z-legacy-pmx/` | `PET_MODEL_BACKEND=legacy-pmx PET_ANIM_BACKEND=legacy-pmx`，默认 fpsCap=30 | idle 60s（仅对照） |

每目录含：`run.json`（完整原始样本+分析）、`summary.md`（自动生成的人读表）、`samples.csv`（逐秒 CSV）、`environment.json`、`main.log`、`app-stdout.log`、`app-stderr.log`。汇总入口：`tests/tmp/wave3-perf/latest.json` / `latest.md`（最近一轮）。

### 3.1 主表（VRM，1080p/50%，idle 60s；warmup 5s 不计入）

| run | phase | samples | fps mean | fps p50 | fps p95 | fps min | fps max | drawCalls | triangles | RSS 合计 mean(MB) | 主进程 RSS p50(MB) | renderer RSS mean(MB) | GPU RSS mean(MB) | CPU% interval mean | CPU% lifetime sum mean | loadavg1 mean |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| cap30-run1 | idle | 58 | **28.11** | 27.90 | 29.50 | 25.9 | 30.0 | 39 | 51829 | 963.7 | 220.5 | 453.5 | 240.7 | **14.68** | 14.15 | 1.63 |
| cap30-run1 | action | 20 | 28.37 | 28.45 | 29.50 | 27.4 | 29.5 | 39 | 51829 | 969.1 | 221.3 | 459.0 | 240.7 | 14.78 | 14.63 | 1.75 |
| cap30-run2 | idle | 58 | **28.29** | 28.45 | 29.50 | 25.7 | 30.0 | 39 | 51829 | 993.3 | 222.4 | 461.7 | 255.0 | **14.67** | 14.06 | 1.77 |
| cap30-run2 | action | 20 | 28.36 | 28.40 | 29.02 | 26.9 | 29.5 | 39 | 51829 | 993.4 | 222.9 | 466.6 | 255.2 | 13.56 | 12.73 | 1.44 |
| cap60-run1 | idle | 59 | **54.44** | 54.80 | 57.08 | 48.8 | 58.0 | 39 | 51829 | 974.7 | 222.5 | 460.0 | 240.5 | **20.18** | 19.47 | 1.49 |
| cap60-run1 | action | 20 | 54.08 | 53.90 | 59.05 | 48.7 | 60.0 | 39 | 51829 | 975.7 | 223.0 | 463.6 | 240.5 | 20.35 | 19.45 | 1.33 |
| legacy-pmx | idle | 58 | 27.88 | 27.90 | 29.07 | 25.4 | 29.5 | **60** | **86792** | **914.5** | 179.1 | 440.8 | 245.8 | **9.75** | 9.16 | 1.62 |

（`stats.triangles` 口径：VRM = 模型主 pass 三角数；legacy PMX 的 F03 统计包含 OutlineEffect 描边 pass，故显示 86792。）

### 3.2 与 fpsCap 30 的关系（本任务重点）

| 指标 | cap30（run1/run2） | cap60（run1） | 结论 |
|---|---|---|---|
| idle fps mean | 28.11 / 28.29 | 54.44 | cap 提高后 fps 提升 ~1.93× |
| 实测/上限 | 0.937 / 0.943 | 0.907 | 两档都在上限之内；`fpsCap` 是**有效上限**而不是目标精确帧率 |
| fps p95 / max | 29.5 / 30.0 | 57.08 / 58 | cap30 从未超过 30（上限有效） |
| idle CPU%（interval） | 14.68 / 14.67 | 20.18 | 30→60 帧 CPU 约 **+37.5%**（帧率 1.93 倍，CPU 增长慢于帧率，说明存在固定开销/渲染并非按帧线性） |
| RSS 合计 | 963.7–993.3 MB | 974.7 MB | 与 fpsCap 基本无关（内存由资产/进程基线决定） |
| drawCalls / triangles | 39 / 51829 | 39 / 51829 | 与 fpsCap 无关 |

结论：
1. **fpsCap=30 已生效且为硬上限**：idle 实测均值 28.1–28.3（约 cap 的 93–94%），p95=29.5、max=30，无超限样本；display 是 60Hz，macOS `requestAnimationFrame` 跟随刷新率、`FrameRateController` 按 `1000/cap` 阈值跳帧（`src/renderer/src/scene/fps-limiter.ts`），60Hz 下理论 30fps，实测略低是 rAF 抖动/窗口合成与 1s 滑动窗口统计的共同结果，不是 cap 失效。
2. **默认 30 是合理的桌面宠物上限**：cap 提到 60 只把 fps 提到 ~54，却把整树 CPU 从 ~14.7% 抬到 ~20.2%（+37.5%）；内存/绘制调用不变。对桌面常驻宠物，30fps 是明显的能效拐点。
3. 若未来验收要求“稳定 30fps”，建议口径写成 **idle fps mean ∈ [26, 31] 且 p95 ≤ 33、max ≤ 33**（本机实测均可满足），不要要求精确等于 30。

### 3.3 启动 / 关停

| run | spawn→CDP target | spawn→renderer ready | SIGTERM→退出 | 退出码 | 残留 |
|---|---|---|---|---|---|
| cap30-run1 | 272 ms | **790 ms** | 941 ms | 0 | 无 |
| cap30-run2 | 268 ms | **781 ms** | 1021 ms | 0 | 无 |
| cap60-run1 | 265 ms | **804 ms** | 898 ms | 0 | 无 |
| legacy-pmx | 266 ms | **1624 ms** | 917 ms | 0 | 无 |

- VRM 生产构建冷启动到“可渲染且 debug.ready”约 **0.8 s**；legacy PMX 反而慢（PMX 解析 + 20 贴图，1.62 s）。
- 关停均 graceful（`SIGTERM` 后 app 自己退出，无需 SIGKILL），约 0.9–1.0 s；`leftoverTrackedPids=[]`。
- 启动/关停均无人工介入，适合作为 CI/验收门禁项（脚本退出码 0/1）。

### 3.4 action 阶段（真实活动）说明

`action` 阶段每 5s 轮换 `debugTriggerActivity()`，成功与否取决于冷却/姿态/窗沿等**游戏内真实约束**，并且与自主行为竞争：

| run | 触发尝试 | 成功 | action 阶段活动分布（采样） |
|---|---|---|---|
| cap30-run1 | walkTo / returnCorner / idleStretch 各 1 次 | 0（pet 自主进入 `sit` 状态，窗沿约束拒绝站立/走动类触发） | `sit` ×20 |
| cap30-run2 | walkTo / returnCorner / idleStretch | 3 | `idle` ×12、`walkTo` ×8 |
| cap60-run1 | walkTo / returnCorner / idleStretch | 2 | `idle` ×15、`walkTo` ×5 |

- **这是真实自主行为带来的正常方差**，不是脚本缺陷：run1 的 action 阶段实际测得的是「自主坐下」时的渲染开销（fps 28.37、CPU 14.78%，与 idle 几乎一致）；说明坐/待机/走动对本项目渲染成本影响很小。
- `action` 与 `idle` 的 fps/CPU/RSS 差异都在噪声范围内（Δfps ≤0.4，ΔCPU ≤1.2%，ΔRSS ≤5.6 MB），**当前 VRM 角色动画不是性能瓶颈**。

### 3.5 内存构成（RSS，按进程角色拆分，idle 中位数）

| run | 合计 RSS(MB) | main | renderer | GPU | utility |
|---|---|---|---|---|---|
| cap30-run1 | 965.7 | 220.5 | 456.4 | 240.7 | ~47 |
| cap30-run2 | 989.9 | 222.4 | 464.6 | 255.1 | ~47 |
| cap60-run1 | 972.6 | 222.5 | 462.0 | 240.5 | ~47 |
| legacy-pmx | ~914.5（合计 mean） | 179.1 | 440.8 | 245.8 | ~49 |

> 注意：**进程树 RSS 直接求和会重复计算 Chromium 共享页**（同一份代码/共享内存会出现在多个进程的 RSS 里），所以“RSS 合计 ~0.96–0.99 GB”是**上界式**观测值；主进程 ~220 MB、renderer ~455–465 MB、GPU ~240–255 MB 是更细的参考。真正“物理内存独占”低于求和值，macOS 可用 `footprint` 进一步核实（本轮未做，列入局限）。

### 3.6 对照：legacy PMX 回退路径（近似 VS v1）

| 指标 | VRM（cap30） | legacy-pmx（cap30） | 差异 |
|---|---|---|---|
| idle fps mean | 28.1–28.3 | 27.88 | 基本持平（都受 cap30 约束） |
| drawCalls | 39 | **60** | PMX + OutlineEffect 多 pass，绘制调用 +54% |
| triangles（stats 口径） | 51829 | 86792 | PMX 统计含描边 pass |
| 整树 CPU%（interval） | 14.7 | **9.75** | PMX 反而更省 CPU（VRM/MToon/spring 计算更重） |
| RSS 合计(MB) | ~964–993 | **914** | PMX 更省内存（纹理/材质路径不同） |
| 启动 ready | 781–790 ms | 1624 ms | PMX 解析更慢 |

结论：VRM 路径以少量 CPU/内存代价换取更好材质/骨骼/spring 表现；两者在 fpsCap30 下都可稳定贴住上限附近，legacy 回退不会带来帧率优势（反而 drawCalls 更多）。若未来要“VS v1”严格对比，需要用 Wave 1 时代的构建在相同机器复测（本轮 legacy-pmx 是当前构建的回退后端，可作近似参考）。

---

## 4. 结论与建议验收阈值

**结论**：当前生产构建（VRM 默认路径，1080p/50%，fpsCap30）在本机表现稳定：帧率贴合 30 上限、绘制调用与三角面恒定、内存与 CPU 无异常增长、启动/关停干净。没有发现“性能不可接受”的证据。

建议把以下**软阈值**写进 Wave 3 验收/后续回归（超出即人工复核，不直接 fail 用户侧构建）：

| 指标 | 建议阈值（本机 M5 Max/1080p/50%，idle 60s，VRM，fpsCap30） | 本轮实测 |
|---|---|---|
| idle fps mean | 26 ≤ mean ≤ 31 | 28.11 / 28.29 |
| idle fps p95 | ≤ 33（且无样本 > 33） | 29.5 / 29.5 |
| drawCalls（idle/action） | 39 ± 2 | 39 |
| triangles（idle/action） | 51829 ± 100 | 51829 |
| 整树 RSS 合计 mean | ≤ 1150 MB（建议门禁，留 15% 余量） | 964 / 993 |
| 主进程 RSS p50 | ≤ 280 MB | 220–223 |
| CPU% interval mean（idle） | ≤ 20%（fpsCap30） | 14.7 |
| 启动 spawn→ready | ≤ 2.0 s | 0.78–0.80 s |
| 关停 SIGTERM→退出 | ≤ 2.0 s，且无残留进程 | 0.90–1.02 s |
| real `~/.dsh` 未被写 | 必须 | 全部 true |

**与 fpsCap 30 的关系**：默认 30 是本项目合理的能效上限（60 档 fps +93% 但 CPU +37.5%，内存/绘制不变）；建议保持默认 30，把 60 作为用户可选项并在文档里注明 CPU 代价。验收口径不要写“精确 30fps”，写“有效上限 ≤ cap 且实测均值在 cap 的 90%±5% 内”。

---

## 5. 局限与风险

1. **非打包构建**：`electron .`（`app.isPackaged=false`）与最终 `dist/AventurinePet.app` 的渲染代码路径一致，但 userData 隔离/登录项/网络 guard/资源根路径不同；打包落地后（V9 A5）建议在 `.app` 上用同一脚本复测（脚本仅依赖 CDP + ps，理论可用；需确认打包版 userData profile 行为）。
2. **机器有并行负载**：测量期间其它 worker 仍在构建/测试，`loadavg1` 1.3–1.8，绝对数值会有 ±5% 波动；本报告用 2 次重复（cap30-run1/run2）给出方差，跨机/跨时比较需记录 loadavg。
3. **构建口径非严格“改动前 commit”**：out/ 在测量期间（02:34）被并行工作刷新；最终 4 轮用同一构建（每轮 environment.json 记录构建时间与 dirty 数），但工作树在测量期间继续被并行修改（dirty 53→59），因此这是“当前工作树构建”的基线，不是干净 commit 的基线。**Wave 3 集成收口后应重跑本脚本**做正式 before/after。
4. **GPU 利用率未直接测量**：没有权限用 `powermetrics`；GPU 进程只计 CPU/RSS。若未来需要 GPU 成本，可用 `powermetrics --samplers gpu_power`（需 sudo）或 Instruments 手工采。
5. **RSS 求和含共享页重复计算**：见 §3.5；绝对内存占用应结合 `footprint`/Activity Monitor 复核。
6. **action 阶段有真实行为方差**：自主 `sit`/`sleep` 会拒掉调试触发；若需要严格 A/B 动作成本，建议在独立 profile 预置 `autonomous=false`（脚本可加 `--config` 预置，当前只预置 fpsCap）后再对比 walk。
7. **CDP 采样开销**：每 1s 一次 `Runtime.evaluate` 对 fps 的影响估计 <1fps（对比：无 CDP 的 60Hz 原生 rAF 应接近 60，cap60 实测 54.4 的差距主要来自透明窗合成/WindowServer 与统计窗口，而非 evaluate 本身）；如追求极致精度可降到 2–5s 一次。
8. **单机单 OS**：macOS 27.2 / M5 Max / 内置 60Hz 屏；不同 Mac（Intel/低刷新率/外接屏）数值不同，脚本可直接复用。

---

## 6. 复现方式

```bash
# 0) 前置：out/ 存在（本报告使用 02:34 构建；若缺失或需要最新构建，用 --build）
ls out/main/index.js out/renderer/index.html

# 1) 默认基线（idle 60s + action 20s，fpsCap 默认 30）
node scripts/vrm/measure-runtime.mjs --label cap30

# 2) 重复性验证（同配置再跑一轮）
node scripts/vrm/measure-runtime.mjs --label cap30-run2

# 3) fpsCap 60 对照（脚本预置隔离 profile 的 config.json，不碰真实用户配置）
node scripts/vrm/measure-runtime.mjs --label cap60 --fps-cap 60

# 4) legacy PMX 回退后端对照（通过继承环境变量覆盖后端；脚本保留 PET_MODEL_BACKEND）
PET_MODEL_BACKEND=legacy-pmx PET_ANIM_BACKEND=legacy-pmx \
  node scripts/vrm/measure-runtime.mjs --label legacy-pmx --no-action

# 5) 校验最近一次结果并快速回归（退出码 0/1；适合验收/CI 门禁）
node scripts/vrm/measure-runtime.mjs --check

# 6) 强制重新构建后再测（会跑 pnpm build；不改源码）
node scripts/vrm/measure-runtime.mjs --label after-integration --build
```

主要参数：`--label`、`--fps-cap 5..60`、`--idle-ms`（默认 60000）、`--action-ms`（默认 20000）、`--action-trigger-ms`（默认 5000）、`--warmup-ms`（默认 5000）、`--sample-ms`（默认 1000）、`--home`、`--profile`、`--out`、`--build`、`--no-action`、`--keep-profile`/`--no-clean-profile`、`--check`。
产物目录：`tests/tmp/wave3-perf/<timestamp>-<label>/`（`run.json` / `summary.md` / `samples.csv` / `environment.json` / `main.log` / `app-stdout.log` / `app-stderr.log`）+ 顶层 `latest.json` / `latest.md`。

---

## 7. 后续建议（给 Lead / V10 收口）

1. **Wave 3 集成收口后**：`pnpm build` → `node scripts/vrm/measure-runtime.mjs --label after-integration`，与 `cap30-run1/2` 对比主表；建议只比较 idle fps/CPU/RSS 与 drawCalls，动作阶段因真实行为方差仅供参考。
2. 把 `measure-runtime.mjs --check` 作为**手工/可选**性能回归（不适合 CI：需要 GUI 会话与真实 GPU；且并行构建时机器负载会污染结果）。
3. 如 V9 后续调整 `fpsCap` 默认值或引入新的渲染特性（描边/阴影/新动作），用同脚本重采，并把阈值表（§4）更新到 `docs/wave3-acceptance.md`。
4. 打包版（A5）落地后补一次 `.app` 运行测量；若 `electron-builder --dir` 产物不能直接 `--remote-debugging-port`，可改为在 `main` 启动参数加调试端口（需 Lead 决定，不在本轮改源码）。

---

## 附录 A：关键原始证据

- 主表数据：`tests/tmp/wave3-perf/2026-11-10T18-35-43-496Z-cap30-run1/run.json`、`...18-37-19-517Z-cap30-run2/run.json`、`...18-38-55-541Z-cap60-run1/run.json`、`...18-40-56-719Z-legacy-pmx/run.json`
- 自动生成 markdown（同数据）：各 run 目录下 `summary.md`；最新一份 `tests/tmp/wave3-perf/latest.md`
- 逐秒 CSV：各 run 目录 `samples.csv`（列：phase,elapsedMs,fps,drawCalls,triangles,activity,rssTotalMb,rssMainMb,cpuIntervalPct,cpuLifetimePctSum,loadavg1）
- 环境/构建：各 run 目录 `environment.json`（含 out 构建时间/stale、git HEAD/dirty、显示器/CPU 信息）
- app 日志：各 run 目录 `main.log` / `app-stdout.log` / `app-stderr.log`（`main.log` 含 `[config] ... effectiveBackends` 与 `status.json not found: /tmp/w3-perf-home/.dsh/...`，证明 DSH 隔离生效且未连接真实 DSH）
- 脚本：`scripts/vrm/measure-runtime.mjs`（新文件，dev-only，不进入生产 bundle）

## 附录 B：本轮没有做的事（边界声明）

- 没有打开/重启真实 DSH、没有安装 bridge、没有读写真实 `~/.dsh` 数据（只读快照校验）；
- 没有改 `src/`、`assets/`、`electron.vite.config.ts` 等源码/配置，没有改 `out/`（未执行 `--build`；out/ 的 02:34 刷新由其它 worker 完成）；
- 没有 git commit；
- 没有测打包 `.app`、没有测 GPU 功耗、没有做多机/多分辨率矩阵。
