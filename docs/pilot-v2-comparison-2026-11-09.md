# fbx-pilot-v2 验收对比报告（豆包第二版小批量测试）

> 日期：2026-11-09 · 对象：`<home>/Downloads/fbx-pilot-v2.zip`（豆包回传的第二版 pilot，6 动作 × 全场景/`_skel` 共 12 个 FBX）
> 对照基准：v1 `fbx-pilot.zip`（2026-11-09 15:21 回传）+ 官方实机素材（B站实机视频）+ 源 `.max` 取证结论
> 结论：**v2 与 v1 在数据层面等价，P1（Biped 身体动画未导出，阻塞）与 P2（`_skel` 未瘦身）都没有修复**；v2 还缺失了上一轮要求的全部诊断/日志回传物。与官方实机对比为「静止 T-pose vs 连续动作」的本质差异。
> 相关文档：`docs/pilot-findings-2026-11-09.md`（v1 问题定位）、`docs/adv-acceptance-plan.md`（验收口径）、`docs/handoff-windows-agent.md`（上一轮给豆包的指令）、**`docs/doubao-v2-problem-report.md`（本次给豆包的问题报告与改进方案）**
> 效果图（供验收）：`tests/tmp/adv-pilot-v2/acceptance/`（另已同步网盘 `砂金动作转换/pilot-v2-结果/`）

---

## 0. TL;DR

| # | 检查项 | v1（第一版） | v2（第二版） | 判定 |
|---|---|---|---|---|
| P1 | Biped 身体动画（65 根 Biped 骨） | 0 条曲线，静止 A/T-pose | **0 条曲线，完全相同** | ⛔ **未修复** |
| P2 | `_skel` 瘦身 | 未瘦身（=全场景版） | **6 个 `_skel` 与 v1 逐字节相同** | ⛔ **未修复** |
| P3 | 全场景 FBX 是否重导过 | — | 重导过（文件时间 15:58），但**导出设置/有效结果与 v1 完全一致** | ⚠️ 无效重导 |
| — | 回传 `export_log.txt` | 有 | **没有** | ⛔ 缺失 |
| — | 回传 `probe-scene-anim.txt` | 要求（见 §6 指令） | **没有** | ⛔ 缺失 |
| — | 回传 `export_experiments.ms` 的 10 个变体 | 要求 | **没有** | ⛔ 缺失 |
| — | 回传 GUI 默认导出 `StandBy_gui.fbx` | 要求 | **没有** | ⛔ 缺失 |
| — | 与官方实机对比 | 差异（静止 T-pose） | **差异相同：5 帧×3 视角全部同一姿态** | ⛔ 不通过 |

**一句话**：v2 只是把 6 个全场景 FBX 又按同样方式导了一遍（`_skel` 直接沿用 v1 文件），导出侧的根本问题没有动；本轮仍不能放行全量 138。

---

## 1. 回传物核对（v2 包内容）

`unzip -l fbx-pilot-v2.zip`：**只有 12 个 FBX，没有任何日志/诊断/实验文件**。

| 文件 | 大小 (B) | zip 内时间戳 | 备注 |
|---|---|---|---|
| Skill01.fbx | 10,196,768 | 15:58 | 本轮重新导出 |
| StandBy.fbx | 7,274,032 | 15:58 | 本轮重新导出 |
| State_Stun.fbx | 9,374,624 | 15:58 | 本轮重新导出 |
| Talk01.fbx | 7,729,248 | 15:58 | 本轮重新导出 |
| Tpose.fbx | 5,089,264 | 15:58 | 本轮重新导出 |
| Walk.fbx | 5,743,408 | 15:58 | 本轮重新导出 |
| 6 × `*_skel.fbx` | 与 v1 相同（+16B） | **15:13–15:14** | **时间戳=v1 导出时间，未重导** |

上一轮（`docs/handoff-windows-agent.md` §6）明确要求的回传清单，一条都没有：
1. `probe-scene-anim.txt`（Biped 是否在动 / Figure Mode / Biped Layers 诊断）
2. `D:\sjxl\exp\`（10 个导出设置变体 + `experiments-log.txt`）
3. `StandBy_gui.fbx`（3ds Max GUI 默认设置手动导出对照）
4. 新工具包的 `export_log.txt`（`run_pilot.bat` 每次都会生成）

> 这直接导致：**无法判断豆包这一轮到底改了什么、用哪种方式导出**；只能从产物反推「有效设置与 v1 相同」。

---

## 2. 文件级对比：v2 和 v1 是不是同一份东西？

### 2.1 `_skel` 版：逐字节相同（未重导，P2 未修复）

```
$ shasum -a 256 ...
a0d56b287bcf1b0dfd19d7e85116bf7b7e5a724a9d3feaaed97bab74d15e1245  v1/fbx-pilot/StandBy_skel.fbx
a0d56b287bcf1b0dfd19d7e85116bf7b7e5a724a9d3feaaed97bab74d15e1245  v2/StandBy_skel.fbx
48db439085530cb62ee560d7706ea3170151b813eb4612e58ae45a6455f9a00a  v1/fbx-pilot/Tpose_skel.fbx
48db439085530cb62ee560d7706ea3170151b813eb4612e58ae45a6455f9a00a  v2/Tpose_skel.fbx
```

且 v2 的 `*_skel.fbx` 每个恰好比同名全场景版大 16B（和 v1 一样）→ 骨架版仍是整场景，**没有瘦身**。
另外：新工具包（15:49 上传网盘）里 `export_max.ms` 的 `_skel` 已改成「只选 `Bip*` 后 Export Selected」，若按新工具包重跑 `run_pilot.bat`，`_skel` 会明显变小（预期 0.5–2MB）——**v2 的 `_skel` 没变，说明新工具包根本没被使用**。

### 2.2 全场景版：重新导出过，但结构与 v1 完全一致

| 文件 | v1 大小 | v2 大小 | 差异字节数 | 结论 |
|---|---|---|---|---|
| StandBy.fbx | 7,274,032 | 7,274,032 | 65,139（≈0.9%，仅 header/UUID/时间戳等元数据区） | 结构相同 |
| Skill01.fbx | 10,196,768 | 10,196,768 | 同上量级 | 结构相同 |
| 其余 4 个 | 相同 | 相同 | 同上 | 结构相同 |

**原始 FBX 二进制解析**（不依赖 Blender，直接读 FBX 7400 容器）——逐文件统计动画曲线节点与目标：

| 文件 | AnimationCurve | AnimationCurveNode | Biped 曲线目标 | 非 Biped 曲线目标 |
|---|---|---|---|---|
| Skill01.fbx / Skill01_skel.fbx | 2,466 | 822 | **0** | 287 |
| StandBy.fbx / StandBy_skel.fbx | 2,508 | 836 | **0** | 287 |
| State_Stun.fbx / State_Stun_skel.fbx | 2,466 | 822 | **0** | 287 |
| Talk01.fbx / Talk01_skel.fbx | 2,508 | 836 | **0** | 287 |
| Tpose.fbx / Tpose_skel.fbx | 864 | 288 | **0** | 287 |
| Walk.fbx / Walk_skel.fbx | 2,508 | 836 | **0** | 287 |

v1 与 v2 的 `StandBy.fbx` 这组数字**完全相同**（另有 287 个非 Biped 目标：`0000_Body`…`0009_Weapon`、`*_JNT` 次级骨、面部骨、`Avatar_AventurineW_00` 等）。
→ 结论：**v2 全场景 FBX = v1 用同样有效设置重导了一遍，只换了文件头/UUID/时间戳**。

---

## 3. 动画验证：Biped 骨依然没有关键帧（Blender 实测）

`work/adv-biped/check_biped_anim.py`（Blender 4.2 导入每个 FBX，统计 Biped 骨曲线数 + 起/中/末帧姿态差）：

| 文件 | verdict | Biped 骨数 | Biped 曲线数 | 帧间最大姿态差 |
|---|---|---|---|---|
| Skill01.fbx / _skel | **FAIL** | 65 | 0 | 0.000° |
| StandBy.fbx / _skel | **FAIL** | 65 | 0 | 0.036° |
| State_Stun.fbx / _skel | **FAIL** | 65 | 0 | 0.052° |
| Talk01.fbx / _skel | **FAIL** | 65 | 0 | 0.000° |
| Tpose.fbx / _skel | **FAIL** | 65 | 0 | 0.016° |
| Walk.fbx / _skel | **FAIL** | 65 | 0 | 0.030° |

12/12 FAIL：332 根骨里恰好只有 267 根非 Biped 骨有动画曲线，65 根 Biped 骨一条都没有（与 v1 症状完全一致）。
另：v2 全场景 StandBy 的 5 帧源渲染 PNG **5/5 哈希完全相同** → 源 FBX 本身就是静止的。

---

## 4. 转换管线复跑（v2 → 采样 → 重定向 → 校验 → VRM 渲染）

命令：`scripts/vrm/motion/run-adv-pipeline.sh --fbx-dir tests/tmp/adv-pilot-v2/fbx --mode pilot --tmp-dir tests/tmp/adv-pilot-v2/pipeline --skip-preview`

- 采样/重定向：**5/5 PASS**（idle / walk / talk01 / skill01 / stun；数据格式、骨架、单位、fps 依然全部正常）
- VRM 校验：5 clip PASS；但关键指标暴露问题：**`maxJump` 全部 0°、`loopSeam` 全部 0°**（即整段动画没有任何帧间姿态变化）
- VRM 渲染（`preview-adv.mjs`）：5 个 clip × 5 个时间点 × 3 视角，**所有帧的身体姿态完全相同**（唯一微小差异来自 SpringBone 头发/衣摆的物理收敛，非骨骼动画）
- 产物：`tests/tmp/adv-pilot-v2/pipeline/`、`tests/tmp/adv-pilot-v2/vrm-preview/`、`tests/tmp/adv-pilot-v2/source-render/`

> 说明：转换链路（采样/重定向/映射）没有出错——它忠实转换了「源 FBX 里静止的姿态」。问题 100% 在 FBX 导出侧。

---

## 5. 与官方实机效果对比（差异=阻塞级）

### 5.1 StandBy（战斗待机）——官方实机 vs v2 产物

![StandBy 对比](../tests/tmp/adv-pilot-v2/acceptance/对比-官方实机vs豆包v2-待机.jpg)

- 官方参考：`work/ref-aventurine/clips/xilang_standby_battle_arena_戏浪战斗待机.mp4`（0–10s 实机待机，包含呼吸起伏、重心左右移动、手臂自然垂放/微摆、镜头带转身）
- v2 产物：t=0/2.5/5/7.5/10s 五个时间点**完全静止在同一 T-pose**，双臂外张、无任何动作
- 判定：**不一样**（不是节奏/幅度差异，而是「没有动画」）

### 5.2 Skill01（普攻，A 级金标准）——官方实机 vs v2 产物

![Skill01 对比](../tests/tmp/adv-pilot-v2/acceptance/对比-官方实机vs豆包v2-普攻.jpg)

- 官方参考：`work/ref-aventurine/clips/labeled_puwang_普攻.mp4`（砂金持冲浪板挥击 → 命中特效 → 收势的完整动作链）
- v2 产物：4 个时间点姿态完全相同（静止）
- 判定：**不一样**

### 5.3 其它产物接触表（供验收）

| 图 | 路径 |
|---|---|
| v2 输出-待机（5 帧 × 3 视角） | `tests/tmp/adv-pilot-v2/acceptance/豆包v2输出-待机-三视图接触表.jpg` |
| v2 输出-普攻 | `tests/tmp/adv-pilot-v2/acceptance/豆包v2输出-普攻-三视图接触表.jpg` |
| v2 输出-走路 | `tests/tmp/adv-pilot-v2/acceptance/豆包v2输出-走路-三视图接触表.jpg` |
| v2 输出-对话待机 | `tests/tmp/adv-pilot-v2/acceptance/豆包v2输出-对话待机-三视图接触表.jpg` |
| v2 输出-受击眩晕 | `tests/tmp/adv-pilot-v2/acceptance/豆包v2输出-受击眩晕-三视图接触表.jpg` |
| 官方参考 | `tests/tmp/adv-pilot-v2/compare/idle/`、`.../skill01/` |

> 备注（工具侧已知限制，不影响结论）：`render-source-fbx.py` 对本批源 FBX 的取景/朝向仍有异常（P3，源场景世界尺度 0.01、Biped 朝向特殊），所以三列对比图中的「源 FBX 渲染」列偏小/侧躺；结论以 VRM 列 + 数值指标（0 曲线 / maxJump 0°）为准。

---

## 6. 根因调查（上网核实结果）

### 6.1 本地证据链先锁死范围

1. 源 `.max` **确实有 Biped 身体动画**（上一轮取证，`docs/research/max-importer-capabilities.md` §4）：138 个 `.max` 的 Scene 流里都有 class=`Biped`(0x9155) 的控制器块，内含 20 条动画轨道；帧数与动作时长一致（Tpose=0、Walk=71、Skill01=195，138/138 全部通过残差校验）。不是「场景里本来就没动画」。
2. **场景还带「高级动画系统」的痕迹**（本轮补充取证，解析 `.max` 的 ClassDirectory3 + Scene 内嵌类表）：
   - `Anim Layer Control Manager`（3ds Max 动画层管理器）、`Max MotionClip Manager`（运动剪辑管理器）、`Max 混合器剪辑`（Motion Mixer 剪辑）、`共享运动流`（Shared Motion Flow）、`Bip001 Footsteps`、`块控制`（Block Control）等类都在场景类表里出现；
   - `ClassDirectory3` 同时含 `MasterLayerControlManager`、`基础层`（Base Layer）、`Biped 子动画`、`BipSlave 控制`、`Footsteps` 等类。
   → 说明这些 `.max` 除了 Biped 基础关键帧外，**还可能把动画放在 3ds Max 动画层 / Biped Layers / Motion Mixer / Motion Flow 这类"有条件导出"的系统里**；这几种系统在 FBX 导出前都需要先「塌陷/合并/Unify/Mixdown 成 freeform 关键帧」，否则 FBX 只能拿到 freeform 层（可能为空）。
3. 导出的 FBX **Biped 目标曲线数 = 0**（v1/v2 都是，文件级事实）。
4. 转换/重定向管线正常（5/5 PASS）。
→ 动画丢失发生在「3ds Max Biped → FBX 导出」这一步。

### 6.2 官方文档确认的技术事实（重点）

| # | 官方结论 | 出处 |
|---|---|---|
| F1 | **Biped 是 FBX 不支持的控制器，必须靠 Bake Animation 重采样成动画曲线**；开启 Bake Animation 后「所有不支持的约束和控制器（包括 3ds Max Biped）都会重采样为动画曲线」 | 3ds Max 2027 FBX 帮助 · [Animation](https://help.autodesk.com/cloudhelp/2027/ENU/3DSMax-Interoperability/files/GUID-31EA2A4F-A126-498B-96E8-31811522738A.htm)（[中文版](https://help.autodesk.com/cloudhelp/2024/CHS/3DSMax-Interoperability/files/GUID-31EA2A4F-A126-498B-96E8-31811522738A.htm)） |
| F2 | **Biped 动画层只是有条件支持**：「Multiple layer animation may not export. … If you highlight a layer and export it with the Media & Entertainment default preset, you will only export the animation from that specific layer.」 | FBX 限制 · [FBX Limitations](https://help.autodesk.com/cloudhelp/2027/ENU/3DSMax-Interoperability/files/GUID-511AE209-156C-4406-85B1-4266FEA57834.htm) |
| F3 | 动画层排障：**只有处在最上层（top layer）且开启 Bake Animation，才会从上到下导出所选层以下的全部动画；不烘焙则只导出顶层**；官方建议的规避法=导出前把所有层塌陷成一个层 | [Where Are My Animation Layers?](https://help.autodesk.com/cloudhelp/2017/ENU/3DSMax/files/GUID-21B5781D-5D3D-40E7-8620-587BEC650C5D.htm)（[中文版](https://help.autodesk.com/cloudhelp/2020/CHS/3DSMax-Data-Exchange/files/GUID-21B5781D-5D3D-40E7-8620-587BEC650C5D.htm)） |
| F4 | Biped Layers 面板语义：「3ds Max 只播放当前层及其以下层的动画」；有 **Activate All**（激活全部层）与 **Collapse Layers**（把当前层合并到下方最近的活动层）按钮 | [Layers Rollout](https://help.autodesk.com/cloudhelp/2027/ENU/3DSMax-Character-Animation/files/GUID-1D2FBDE2-55A3-4788-90F8-884A60EEFA6F.htm)；层 API（numLayers/collapseAtLayer 等）见 [Biped Layers (MAXScript)](https://help.autodesk.com/cloudhelp/2019/ENU/3DSMax-MAXScript/files/GUID-AD28D4D6-D961-43EF-8F8C-DC3EBB6655BA.htm) |
| F5 | **调用 `FbxExporterSetParam` 前 FBX 导出插件必须已在内存中**，否则设置不生效；官方给出的加载方式是 `pluginManager.loadClass FbxExporter`。另外参数名/返回值有坑：`FbxExporterSetParam` 返回 `"OK"` / `"unsupplied"`（未识别参数） | [FBX Export Dialog Access（3ds Max 2027 MaxScript 帮助）](https://help.autodesk.com/cloudhelp/2027/ENU/MAXScript-Help/files/MAXScript-Tools-and-Interaction/Interacting-with-the-3ds-Max/FBX-Import-and-Export-Dialog/GUID-54B1F140-B304-48A2-9829-C68B345E2044.html) |
| F6 | Figure Mode 是「静置/拟合姿态」编辑模式（官方建议蒙皮/拟合时开启、之后退出） | [Figure Mode](https://help.autodesk.com/cloudhelp/2027/ENU/3DSMax-Character-Animation/files/GUID-1360F08E-5976-4752-B775-D1571A817A1F.htm) |
| F7 | **Motion Flow 模式**：动画来自「脚本+剪辑」，需要先执行 **Create Unified Motion（统一运动）** 才能把脚本转成 freeform 关键帧、退出 Motion Flow 模式后可用；FBX 导出的是 freeform 层 | [Motion Flow Mode](https://help.autodesk.com/cloudhelp/2027/ENU/3DSMax-Character-Animation/files/GUID-31A4A769-D55B-4D55-A187-7EA48ACA1E65.htm) · [Motion Flow Rollout](https://help.autodesk.com/cloudhelp/2027/ENU/3DSMax-Character-Animation/files/GUID-0CC8D6B5-43D0-4C51-B2FD-C0B19EB4D5A8.htm) · [Unifying Motion](https://download.autodesk.com/us/3DSmax/2012help/files/GUID-469CCB7E-895B-4BE0-A5B5-C5B6FE48178-1558.htm) |
| F8 | **Motion Mixer 模式**：动画在混合器轨道里，需「右键轨道 → **Compute Mixdown** → 选中 Mixdown 轨 → **Bipeds 菜单 → Copy Mixdown to Biped** → 关闭 Mixer Mode」后才会变成 Biped 自己的关键帧；此外 **3ds Max 动画层**（Animation 菜单 → Animation Layers 工具栏）可用 **Collapse Anim Layer / Disable Anim Layer** 把层合并/移除，回到普通关键帧 | [Exporting Animation to the Biped](https://download.autodesk.com/us/3DSmax/2012help/files/GUID-378E7B9E-581A-4FB0-ADAE-4DD2B9DC414-1262.htm) · [Animation Layers (Layer Controller)](https://download.autodesk.com/us/3dsmax/2012help/files/GUID-ACAD407C-B079-4DAB-9DD0-6C8DC22389E-998.htm) |

### 6.3 社区证据：MaxScript 设 FBX 参数本身不可靠

- Tech-Artists 老帖（3ds Max 2012–2013）实测：「FBXExporterSetParam 的 hooks 是坏的，脚本设了值，用户手动导出时这些值不会生效」；「`FBXExporterGetParam "FBXProperties"` 返回的名字和 `FBXExporterSetParam` 要用的名字不一样（例如 `BakeComplexAnimation` vs `BakeAnimation`）」；结论是**改用显式导出预设（LoadExportPresetFile）+ 只改预设管不到的项**才稳。→ [\[maxScript\] FBX export option control](https://www.tech-artists.org/t/maxscript-fbx-export-option-control/3305)
- RealtimeVFX 帖子：「3ds Max 2016/2017 里 **Resample All 默认是关的，而且设置不持久**；推荐的 FBXExporterSetParam 根本改不动导出对话框设置；保存预设也不可靠」→ [MAX - FBX Export Gotchas!](https://realtimevfx.com/t/max-fbx-export-gotchas/705/1)

### 6.4 根因候选（按可能性排序）与判定方法

| 排序 | 根因假设 | 支持证据 | 判定方法（最快） |
|---|---|---|---|
| **R1** | **导出时 Bake Animation 实际没生效**（批量脚本里 `FBXExporterSetParam "BakeAnimation" true` 被静默丢弃：插件未加载 / 参数被预设覆盖 / 批量模式不生效），Biped 作为“不支持的控制器”被整个跳过 → 0 条 Biped 曲线 | 官方 F1/F5 + 社区证据；v2 只多出元数据差异说明设置没变；脚本 `setParam` 的 try/catch 吞掉返回值，从不检查 `"OK"/"unsupplied"` | GUI 手动导出（显式勾 Bake Animation + Resample All）→ 若出动画则确认 R1 |
| **R2** | **Biped 动画层状态问题**：动画在非当前层/未激活层（官方“有条件支持”）；当前层若是空层，播放/烘焙都取不到骨骼动画 | 官方 F2/F3/F4；上一轮取证发现 Biped 块内恰好 20 条动画轨（可能对应 10 层×2 轨），但语义未解 | 打开场景播放 + Motion 面板 Layers 截图；`Activate All`/到顶层/`Collapse Layers` 后再导 |
| **R3** | **场景侧不播放**：Figure Mode/被冻结/数据挖掘机写入的 Biped 状态在 2027 里不评估 | 概率低（源 `.max` 有完整关键帧数据），但未在 Max 里验证过 | 打开 StandBy.max 拖时间轴播放/截图 |
| **R4** | 参数名/大小写问题：官方参数是 `"Bip2Fbx"`，脚本写 `"Bip2FBX"`；`"RemoveSinglekeys"` 等也有大小写差异 | 官方 F5 参数表；若大小写敏感会返回 `unsupplied` 被吞 | 跑已提供的 `probe_scene_anim.ms`（它会打印参数是否被识别） |
| **R5** | **动画实际存放在 Motion Mixer / Motion Flow / 3ds Max 动画层里，Biped 的 freeform 层是空的** → FBX 只导出 freeform 层，所以 Biped 曲线 = 0（与 bake 设置无关） | 场景类表含 `Anim Layer Control Manager` / `Max MotionClip Manager` / `Max 混合器剪辑` / `共享运动流`（§6.1-2）；官方 F2/F3/F7/F8 都说明这些系统要先塌陷/Unify/Mixdown 才会变成普通关键帧 | 打开场景看 Biped 模式按钮（Motion Flow/Mixer 是否高亮）+ Animation Layers 工具栏 + Motion Mixer 里有没有轨道/剪辑；按 F7/F8 做 Unify/Mixdown 后再导 |

> 注：R1/R2/R5 可以叠加成立（例如动画在 Mixer 里 + 当前在空层 + bake 没生效）。**必须先做 GUI 侧两个动作（播放 + 手动导出），再看 Biped 模式/动画层状态，才能一锤定音**，这也是本次给豆包的核心要求。

---

## 7. 结论与下一步

1. **v2 不通过**：P1/P2 均未修复，且未按要求回传任何诊断物；不能放行全量 138。
2. 已有证据链足够定位到「3ds Max 导出侧、Bake Animation/Biped 层/批量脚本设置」这三层，但**最后一步（哪一层）需要 Windows 侧 GUI 的 2 个动作**：① 播放验证场景里 Biped 是否动；② GUI 手动导出 1 个 StandBy 并回传。
3. 给豆包的可执行步骤、判据、回传清单见 **`docs/doubao-v2-problem-report.md`**（纯 GUI 操作，不需要豆包写/改任何脚本）。
4. Mac 侧收到 `StandBy_gui.fbx` 后 30 秒内可判定：有 Biped 曲线 → 走「修正批量导出设置/预设」路线；仍无 → 依次排查 Biped 模式（Motion Flow/Mixer）、Biped Layers、3ds Max 动画层（见 F7/F8 的 Unify/Mixdown/Collapse 方案），最后才考虑「向素材方要 FBX/.bip」或逐文件 GUI 导出兜底。
5. 最终全量方案（138 文件）等 pilot 门禁通过后再定；在通过前不消耗豆包时间跑全量。

---

## 8. 参考资料（本次上网核实）

1. Autodesk 3ds Max 2027 FBX 帮助 · Animation（Bake Animation 会把包括 Biped 在内的不支持控制器重采样为曲线）：https://help.autodesk.com/cloudhelp/2027/ENU/3DSMax-Interoperability/files/GUID-31EA2A4F-A126-498B-96E8-31811522738A.htm
2. 同上中文版（含「包括 3ds Max Biped」原文）：https://help.autodesk.com/cloudhelp/2024/CHS/3DSMax-Interoperability/files/GUID-31EA2A4F-A126-498B-96E8-31811522738A.htm
3. Autodesk · FBX Limitations（Biped Layers FBX limitation）：https://help.autodesk.com/cloudhelp/2027/ENU/3DSMax-Interoperability/files/GUID-511AE209-156C-4406-85B1-4266FEA57834.htm
4. Autodesk · Where Are My Animation Layers?（顶层+bake 的关系、塌陷层建议）：https://help.autodesk.com/cloudhelp/2017/ENU/3DSMax/files/GUID-21B5781D-5D3D-40E7-8620-587BEC650C5D.htm
5. 同上中文版「动画层怎么不见了？」：https://help.autodesk.com/cloudhelp/2020/CHS/3DSMax-Data-Exchange/files/GUID-21B5781D-5D3D-40E7-8620-587BEC650C5D.htm
6. Autodesk · Biped Layers Rollout（当前层/Activate All/Collapse Layers 语义）：https://help.autodesk.com/cloudhelp/2027/ENU/3DSMax-Character-Animation/files/GUID-1D2FBDE2-55A3-4788-90F8-884A60EEFA6F.htm
7. Autodesk · Biped Layers（MAXScript：numLayers / getCurrentLayer / collapseAtLayer 等）：https://help.autodesk.com/cloudhelp/2019/ENU/3DSMax-MAXScript/files/GUID-AD28D4D6-D961-43EF-8F8C-DC3EBB6655BA.htm
8. Autodesk · FBX Export Dialog Access（2027 MaxScript：FbxExporterSetParam 参数表；**插件必须已加载**；返回值 OK/unsupplied）：https://help.autodesk.com/cloudhelp/2027/ENU/MAXScript-Help/files/MAXScript-Tools-and-Interaction/Interacting-with-the-3ds-Max/FBX-Import-and-Export-Dialog/GUID-54B1F140-B304-48A2-9829-C68B345E2044.html
9. Autodesk · Figure Mode：https://help.autodesk.com/cloudhelp/2027/ENU/3DSMax-Character-Animation/files/GUID-1360F08E-5976-4752-B775-D1571A817A1F.htm
10. Tech-Artists：FBXExporterSetParam 不可靠 / 参数名不一致 / 应改用预设：https://www.tech-artists.org/t/maxscript-fbx-export-option-control/3305
11. RealtimeVFX：Resample All 默认关闭且设置不持久：https://realtimevfx.com/t/max-fbx-export-gotchas/705/1
12. 3ds Max 2025.3 更新（Biped FBX 相关改进背景）：https://cgworld.jp/flashnews/202410-3dsMax2025-3.html
13. Autodesk · Motion Flow Mode（2027，含 create a unified motion 的说明）：https://help.autodesk.com/cloudhelp/2027/ENU/3DSMax-Character-Animation/files/GUID-31A4A769-D55B-4D55-A187-7EA48ACA1E65.htm
14. Autodesk · Unifying Motion（Create Unified Motion 步骤）：https://download.autodesk.com/us/3DSmax/2012help/files/GUID-469CCB7E-895B-4BE0-A5B5-C5B6FE48178-1558.htm
15. Autodesk · Exporting Animation to the Biped（Motion Mixer：Compute Mixdown → Copy Mixdown to Biped）：https://download.autodesk.com/us/3DSmax/2012help/files/GUID-378E7B9E-581A-4FB0-ADAE-4DD2B9DC414-1262.htm
16. Autodesk · Animation Layers (Layer Controller)（Animation Layers 工具栏；Collapse/Disable Anim Layer）：https://download.autodesk.com/us/3dsmax/2012help/files/GUID-ACAD407C-B079-4DAB-9DD0-6C8DC22389E-998.htm

---

## 9. 证据文件索引（本机私有目录）

| 内容 | 路径 |
|---|---|
| v2 原始 FBX（解压） | `tests/tmp/adv-pilot-v2/fbx/` |
| 原始 FBX 二进制解析（逐文件） | `tests/tmp/adv-pilot-v2/fbx-tree-v2.jsonl` |
| Blender 逐文件动画检查输出 | （见本报告 §3；脚本 `work/adv-biped/check_biped_anim.py`） |
| 采样/重定向/校验产物 | `tests/tmp/adv-pilot-v2/pipeline/` |
| 源 FBX 渲染（5 帧 × 3 视角） | `tests/tmp/adv-pilot-v2/source-render/` |
| VRM 渲染（5 clip × 5 时间点 × 3 视角） | `tests/tmp/adv-pilot-v2/vrm-preview/` |
| 三列对比图 | `tests/tmp/adv-pilot-v2/compare/idle/`、`.../skill01/` |
| **验收效果图（2 张拼接 + 5 张接触表）** | `tests/tmp/adv-pilot-v2/acceptance/` |
| 网盘同步副本（供用户/豆包查看） | `/Volumes/4TB外置盘/百度网盘/砂金动作转换/pilot-v2-结果/` |
