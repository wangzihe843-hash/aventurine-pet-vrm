# Wave 4 报告：砂金·戏浪 3ds Max Biped 官方动作 → VRM 桌宠动作（进行中）

> 状态：**Mac 侧管线与工具链已完成并验证；等待用户 Windows 侧 pilot/全量 FBX 回传**。
> 本文件为交付报告主文档：已完成的章节写实数据，`⬜ 待填` 章节在真实数据验收后补完。
> 日期：2026-11-09

## 0. 摘要

| 项 | 结果 |
|---|---|
| 输入 | `砂金戏浪.zip`：**138 个 3ds Max 2021 `.max` 场景**（Biped 骨架 + 完整模型）+ 35 张贴图；官方动作包（HSR 4.5 新角色「砂金·戏浪」） |
| 与旧路线差异 | 既不是 Wave1 的 HSR 官方 FBX，也不是 Wave1.5 的 Mate-Engine Unity `.anim`；`.max` 只有 3ds Max 能取骨骼动画（Blender 官方插件仅网格/材质） |
| 路线 | 用户 Windows 11 + 3ds Max 2027 试用 `run_pilot.bat`/`run_full.bat` 批量导 FBX → macOS Blender 采样 → Biped→VRM 重定向 → 对拍验收 → app 接入 |
| Mac 侧验证 | 采样器 334/334 断言 PASS；重定向 合成 e2e 设计值 18/18；**HSR 旧管线 14/14 clip SHA-256 逐字节零回归**；`pnpm test` 1826 passed；typecheck 0 |
| 规模彩排 | 合成 Biped 数据跑通**全 135 条**链路：retarget 135/135 PASS、validate 135/135 PASS、manifest+coverage `--check` PASS；app 层 adv 新增 13 条 app-manifest（idle 11/walk 2）+135 条 catalog，剔除 adv 后与现有产物**逐字段完全一致**（零回归） |
| Pilot（2026-11-09） | 数据/骨架/单位/帧率/采样/重定向 5/5 PASS；**发现 P1 Biped 动画未导出（阻塞）+ P2 skel 未瘦身（已修）**；已给豆包 2 个诊断/实验脚本定导出设置 → 重导 pilot 后再放全量 |
| 待办 | ⬜ P1 修复+重导 pilot 验证 → ⬜ 全量 138 导出 → ⬜ 135 条 catalog 转换 → ⬜ 官方演示对拍 → ⬜ app 接入（idle 池收敛需用户确认） |

## 1. 调查结论（已完成）

1. **格式取证**：`.max` 为 OLE/CFB 容器，`Scene` 流；`DllDirectory` 含 `biped.dlc`（Autodesk Biped 控制器），`ClassDirectory3` 含 `Biped/BipSlave`；`FileAssetMetaData3` 显示 `F:\3DMAX2021\3ds Max 2021\...` 与 `G:\game_ziyuan\...\Animator\Avatar_AventurineW_00`（数据挖掘机工作路径）。
2. **旧 FBX 不够用实测**：Wave1 的 `Avatar_Aventurine_00.fbx` 中 54 条 `Adv_Ani_*`（社交/移动）take **核心人形骨 0 条动画**（只动头发/布料/脸）→ 身体动画只在 `.max` 里。
3. **离线路线不可行**：Blender `io_scene_max` 1.9.2 只导 mesh/material（Biped 变空物体）；无任何已核实的 macOS/Linux `.max` 骨骼动画工具；自研 Biped 关键帧解析估计 3–8 人周、成功率 <50%（建议不做）。
4. **Windows 路线取证**：3ds Max 2027 仅 Win11；官方 30 天试用完整功能、无需信用卡；新版可直接打开 2021 场景（本批无第三方插件依赖）；批量导出用 `3dsmaxbatch.exe` + MaxScript（`Animation/BakeAnimation/Bip2FBX/...`，官方参数表核对）。
5. 详见：`docs/research/max-importer-capabilities.md`、`docs/research/max-windows-routes.md`、`docs/max-anim-conversion-plan.md`、`docs/research/wave1-15-pitfalls.md`。

## 2. Windows 侧导出（工具已交付，⬜ 待用户执行）

- 工具：`scripts/max-export/{export_max.ms, run_pilot.bat, run_full.bat, diagnose_max.ms, export_one.ms, inventory.py}`；用户指南 `docs/user-3dsmax-export-guide.md`；网盘同步副本 `百度网盘/砂金动作转换/`。
- pilot：6 个代表动作 × 2 版本（全场景含网格 / 纯骨架），用于格式+对拍验证。
- 全量：138 个 `.max` → 骨架 FBX（每文件 <2MB 量级，预计总量 50–150MB）。
- 关键 MaxScript 设置：`BakeAnimation=true`（Biped IK/Footsteps→FK）、`Bip2FBX=true`、`BakeFrameStart/End/Step`、`FilterKeyReducer=false`、`UpAxis=Y`、`EmbedTextures=false`、`#noPrompt`；失败可跑 `diagnose_max.ms` 回传诊断。
- **API 对照官方文档核对（2026-11-09）**：`loadMaxFile <file> [useFileUnits:][quiet:]`、`exportFile <file> [#noPrompt][selectedOnly:][using:]`、`maxOps.mxsCmdLineArgs`（dictionary/DataPairs，`-mxsString k:v` 传递）、`3dsmaxbatch` 的 `-dm on`（Dialog Monitor 关弹窗）/-listenerlog/-log 用法与退出码（0/-8 license/-7 graphics/-130 script/-110 start/-120 comm）均与 Autodesk 官方文档一致；batch 判定改用官方 `maxops.isInNonInteractiveMode()`（保留 `-mxsString dir:` 回退）。静态括号平衡自检三个 `.ms` 通过。
- ⬜ 待填：3ds Max 实际版本号、pilot 导出耗时与文件大小、`export_log.txt` 数据。

## 3. Mac 侧管线（已完成并验证）

### 3.1 采样（Biped FBX → samples.json）

- `scripts/vrm/motion/extract-biped-anims.py`：Blender 4.2 headless；目录批量（Tpose 优先作 rest 基准）、自动识别 30/60fps（per-clip `sourceFps`）、采全部骨骼（rest 用 bind 矩阵）、linked-bone unconnect 修复（防位置动画被吞）、单 take 回退（真实 FBX action 名可能是 `Take 001`）、多 armature/非 BipXXX 降级告警。
- 验证：`scripts/vrm/motion/verify-biped-sampler.py` → **334/334 断言 PASS**（合成 Biped 8 变体 + 旧 HSR FBX 零回归 23/23）。

### 3.2 重定向（Biped → VRM humanoid clip JSON）

- `scripts/vrm/motion/lib/humanoid-biped.mjs`：Pelvis→hips、Spine→spine、Spine2→chest（三节脊柱→目标两档，Spine1 旋转经世界 delta 并入 chest）、四肢/脚趾 1:1、30 指 1:1；`Finger0=拇指` 三重证据（Autodesk Biped Node Hierarchy 链接顺序 / BipedPlus 骨表 / AvatarToolkit 别名表 + rest 方向打分复核）。
- `lib/retarget.mjs` 等 3 个 lib 文件纯增量「可插拔 source」重构：默认=HSR 现有行为；**HSR 14/14 clip SHA-256 逐字节零回归**。
- `scripts/vrm/motion/retarget-adv.mjs` + `clips.adv.json`（首批 25 条）+ `clips.adv-all.json`（全量 135 条 catalog）。
- 合成 e2e：设计值 18/18 全过（上臂 90.000°、拇指 60/40°、Hips 90°、chest 15°=Spine1 扭转并入、Hips.p in-place）；混合 30/60fps 2/2 PASS。

### 3.3 工具链

- `build-adv-manifest.mjs` / `validate-adv-clips.mjs` / `preview-adv.mjs`（合成夹具冒烟 PASS 2/WARN 0/FAIL 0，含负向与幂等）。
- `run-adv-pipeline.sh`：pilot/full 一键（采样→门禁→重定向→manifest/validate→preview），合成夹具实测通过（含 Electron 预览）。
- **135 条规模彩排**（`scripts/vrm/motion/make-scale-rehearsal-samples.mjs` + 全链路）：135/135 retarget+validate PASS、manifest coverage OK、app 层零回归；唯一待用户决策 = idle 池从 15 扩到 26 的收敛策略（`work/adv-biped/scale-rehearsal/REPORT.md`）。
- 两级验收对拍：`render-source-fbx.py`（源 FBX 网格/纯骨架渲染、固定机位三视图、render-meta）+ `build-compare-sheet.py`（官方参考|源|VRM 三列/两列；mp4 抽帧/官方 GIF 直抽）；原型用旧 HSR FBX + 官方视频/GIF 跑通。
- `build-app-manifest.mjs` 支持 adv 可选源集：缺省时现有 app-manifest/catalog **sha256 逐字节不变**；合成 adv fixture 10 用例、`--check` PASS。

### 3.4 质量门

| 检查 | 结果 |
|---|---|
| 采样器 E2E | 334/334 PASS |
| HSR 重定向回归 | 14/14 clip SHA-256 一致 |
| `pnpm test` | 106 files / 1826 passed / 14 skipped |
| `pnpm typecheck` | 0 errors |
| app 清单零变更 | `1f97ec72…e62bbe2` / `d7b34e9a…b916c045`（与 baseline 一致） |

## 4. 选片与接入设计（已完成，待用户确认）

- `docs/adv-clip-selection.md`：catalog 全收（135）、app-manifest 精选（核心 idle/walk + 6–8 条社交稀有变体）、三段式 AS/BS/Loop 先接 Loop、旧集保留回退、待数据验证假设清单。
- `docs/adv-app-integration.md`：app 清单生成器改动、启用/回滚、风险；首期不加 mood 别名/override（需用户实机确认）。
- `docs/adv-app-manifest-proposal.md`：**接入选片提案（待用户拍板）**——A 保守(19)/B 平衡(21)/C 全展示(26) 三方案、主待机是否更换、走路主/变体、DSH 事件扩展 4 个决策点；落地只需改 registry slot/priority + 两条构建命令。

## 5. 验收方案与参考证据（已完成）

- `docs/adv-acceptance-plan.md`：证据分级（A/B/C/E）+ **两级对拍**（源保真 / 重定向保真）+ 差异处理纪律。
- `docs/research/aventurine-reference-videos.md`：B 站 47 视频 + 官方 wiki GIF 8 条 + 时间码 + 138 take 映射；**2026-11-09 补采**：米游社渠道打通（7 视频）+ 4.5 千星城剧情 cut 81min 扫片 → Talk01/02→B、HoldArm/Think/LookAtPhone/WatchPhone→C、Idle_Show→B、Walk/Run→B–C；仍 E≈57 takes（唯一可靠补法=游戏内录屏，文档 §9.6 有清单）。本机 `work/ref-aventurine/`（~963MB）。
- `docs/adv-pilot-ingest-runbook.md`：pilot 到货后的 G1–G6 硬门禁 + 6 动作对拍映射。
- ⬜ 待填：pilot/全量对拍结果、差异清单与修法。

## 6. Pilot 验证（2026-11-09 已收到豆包回传，发现 2 个导出问题）

> 详细报告：[docs/pilot-findings-2026-11-09.md](pilot-findings-2026-11-09.md)

**通过项**：6 场景导出日志全 OK；3ds Max 2027；单位 cm（hips 0.922m/身高 1.682m）；骨架 332 骨=65 Biped+187 JNT+80 面部；fps 30/60 混合（per-clip 已处理）；帧范围正常；采样 5/5；重定向 **5/5 PASS**（rest 修正 36 骨、grounding 残差≤0.3cm）。

**问题**：
- ⛔ **P1（阻塞）Biped 身体动画未导出**：FBX action 只有 267 根非 Biped 骨的曲线（恰好 332−65），65 根 Biped 骨帧间变化 0.000° → 转出的是静止 T-pose（对比图 `tests/tmp/adv-pilot-real/user-images/pilot-idle-issue.jpg`）。根因在 3ds Max FBX 导出侧（BakeAnimation 未生效/隐藏对象/`Bip2FBX` 之一），已提供 `probe_scene_anim.ms` + `export_experiments.ms`（6 变体）给豆包跑一次定设置。
- ⚠️ **P2（次要）`_skel` 未瘦身**：`deletedMeshes=0`（场景 338 个 GeometryClass，类名不匹配）→ 已改为「选中 `Bip*` → Export Selected」导出，待重跑验证体积（预期 <2MB/文件）。
- 复验门禁（verify-pilot G0–G6）已在真实数据上跑通采样/重定向部分；P1 修复后重跑即可完成 G1–G6 与 6 动作对拍。

### 6.1 v2 复核（2026-11-09 晚，`fbx-pilot-v2.zip`）

> 详细报告：[docs/pilot-v2-comparison-2026-11-09.md](pilot-v2-comparison-2026-11-09.md) · 给豆包的下一轮指令：[docs/doubao-v2-problem-report.md](doubao-v2-problem-report.md)

- **v2 与 v1 数据等价**：12/12 FBX 的 Biped 骨仍是 **0 条动画曲线**（帧间姿态差 0–0.05°）；6 个 `_skel` 与 v1 **逐字节相同**（P2 未修复、新工具包未使用）；6 个全场景仅有文件头/UUID/时间戳差异（曲线数、节点数完全一致）。
- **回传物缺失**：无 `export_log.txt` / `probe-scene-anim.txt` / `exp` 实验变体 / `StandBy_gui.fbx` → 无法判断本轮改了什么。
- **管线复跑**：采样/重定向 5/5 PASS，但 VRM 校验 `maxJump` 全为 0°、`loopSeam` 全为 0°；5 clip × 5 时间点 × 3 视角渲染均为同一静止姿态。
- **上网核实的根因方向**：Biped 属 FBX 不支持的控制器，**必须 Bake Animation 重采样**（官方文档原文含 Biped）；Biped 动画层为有条件支持（需顶层 + bake，或塌陷层）；`FbxExporterSetParam` 存在「插件未加载则设置静默失效」的官方告警与社区实证。→ 待豆包用 GUI 手动导出 1 个 StandBy 做「脚本问题 vs 场景/层问题」判定。
- **验收效果图**：`tests/tmp/adv-pilot-v2/acceptance/`（官方实机 vs v2 产物对比 + 5 张接触表），已同步网盘 `砂金动作转换/pilot-v2-结果/`。

## 7. 全量转换与验收（⬜ 待全量 FBX）

- ⬜ `run-adv-pipeline.sh --mode full`：135/135 采样 → retarget → manifest/index → validate → preview
- ⬜ 逐类别对拍（技能 A 级硬门禁；待机/移动 B 级；受击/社交 E 级 = 源保真+重定向保真，不做视频对拍）
- ⬜ 差异清单（现象→根因→验证→修法→复验）

## 8. app 接入与实机（⬜ 待验收后）

- ⬜ 用户确认选片（主 idle/walk 是否替换、社交稀有变体名单、dsh* 绑定）
- ⬜ `assets/motions/adv/**` + `build-adv-manifest` + `build-app-manifest`（现有产物基线可回滚）
- ⬜ 实机验收：待机/走路/社交/受击/技能各至少一条；typecheck/test/smoke 全绿
- ⬜ 旧集回退策略与最终性能记录

## 9. 风险与未决（当前）

| # | 风险 | 状态 |
|---|---|---|
| R1 | 用户 3ds Max 试用安装/下载受阻 | 已备 diagnose_max.ms/export_one.ms/云/VM 备选路线文档 |
| R2 | 真实 FBX 骨骼命名/单位/fps 与合成夹具不同 | 采样器+映射器已做命名/帧率/单位/rest 兜底；pilot G1–G6 先验 |
| R3 | Biped 手指语义（Finger0=拇指）真机未验 | pilot Tpose 几何复核留待执行 |
| R4 | 社交 E 级动作无视频可对拍 | 已定「源保真+重定向保真」口径，报告明确不冒充；2026-11-09 补采后 B/C 覆盖 Talk/抱臂/托腮/看手机等约 22 takes，剩余 ~57 takes 仍 E（游戏内录屏是唯一可靠补法） |
| R5 | 全量 135 clip catalog 体积/预览耗时 | 可接受（catalog 一次性解析；预览按需） |
| R6 | app 主 idle/walk 优先级冲突 | 首期既有集优先；替换需 override + 用户确认 |
