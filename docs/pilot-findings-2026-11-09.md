# Pilot FBX 验证报告：问题定位与修复方案（2026-11-09）

> 对象：豆包回传的 `fbx-pilot.zip`（6 场景 × 全场景/`_skel` 两版 + `export_log.txt`）
> 结论：**pilot 数据本身可用（导入/骨架/单位/fps/时长/重定向全过），但有 2 个导出侧问题需要修，修完重导即可**。
> 相关：`docs/adv-pilot-ingest-runbook.md`（门禁）、`docs/adv-acceptance-plan.md`（对拍口径）、`docs/wave4-adv-report.md`
> 后续：豆包第二版 `fbx-pilot-v2.zip` 复核结论见 **`docs/pilot-v2-comparison-2026-11-09.md`**（v2 与 v1 等价，P1/P2 均未修复）与 **`docs/doubao-v2-problem-report.md`**（下一轮 GUI 诊断指令）

## 0. TL;DR（给豆包/用户的行动结论）

| # | 问题 | 严重度 | 现状 | 需要做什么 |
|---|---|---|---|---|
| **P1** | 导出的 FBX **没有 Biped 身体动画**：65 根 Biped 骨全部静止，只有 267 根次级/表情骨有动画 → 转出的动作是静止 T-pose | **阻塞（必须修）** | 已定位到「FBX 导出没把 Biped 的程序化控制器烘焙成骨骼关键帧」这一层；**不是 Mac 转换错误**（源 FBX 里就没有身体动画曲线） | 豆包跑 2 个小脚本（`probe_scene_anim.ms` + `export_experiments.ms`，约 1–2 分钟）回传 → Mac 定出正确导出设置 → 重跑 pilot |
| **P2** | `_skel` 版**没有瘦身**（和全场景版一样大，`deletedMeshes=0`） | 次要（影响全量传输体积） | 已修：skeleton-only 改为「选中 `Bip*` 层级 → Export Selected」，不删任何物体 | 重跑 pilot 时验证 `_skel` 大小应 <2MB |
| P3 | 渲染取景/朝向异常（源 FBX 世界尺度 0.01、pelvis 在原点） | 工具侧（不影响数据） | 采样器已修高度/竖直轴计算（hips 0.922m、height 1.682m）；渲染相机取景后续修 | Mac 内部处理，不需要豆包操作 |

## 1. 已通过的检查（pilot 数据本身没问题）

| 检查 | 结果 |
|---|---|
| 导出日志 | 6 个场景全部 `OK`，`=== DONE mode=pilot ok=6 fail=0 ===` |
| 3ds Max 版本 | 2027（`maxVersion=#(29000,70,0,29,2,0,20588,2027,".2")`） |
| 场景 fps | **混合**：Skill01/State_Stun/Tpose=60fps，StandBy/Talk01/Walk=30fps（采样器已按 per-clip 处理） |
| 单位 | `centimeters`，源 hips 高度 **0.922m**、角色高 **1.682m**（合理） |
| 骨架 | 332 骨 = **65 根 Biped 骨**（Pelvis/Spine/Spine1/Spine2/Neck/Head/Clavicle/UpperArm/Forearm/Hand/Thigh/Calf/Foot/Toe0/Finger0-4×3 节）+ 187 根 `*_JNT` 次级骨 + 80 根面部骨 |
| 动画帧范围 | StandBy 84f@30 / Walk 36f@30 / Talk01 102f@30 / Skill01 195f@60 / State_Stun 111f@60 / Tpose 301f@60（Tpose 动画不影响，rest 取 bind） |
| 采样 | 5/5 clip 采样成功（take 名都是 `Take 001`，采样器已自动回退；只采 65 根 Biped 骨） |
| 重定向 | **5/5 PASS**（idle/walk/talk01/stun/skill01；rest 修正 36 骨、grounding 残差 0.0–0.3cm） |
| 结论 | 数据格式/骨架/单位/fps/采样/重定向链路全部正确 |

## 2. P1（阻塞）：Biped 身体动画没有导出到 FBX

### 2.1 证据（本机实测）

1. **FBX 里根本没有 Biped 骨的动画曲线**：`Bip001` 骨架的 action 有 2670 条曲线，恰好 = **267 根非 Biped 骨 × 10 通道**（location 801/rotation 1068/scale 801）；65 根 Biped 骨一条曲线都没有。
2. **帧间姿态完全相同**：采样 idle 的 84 帧中，`Bip001 L UpperArm / Forearm / Spine / Head` 的四元数在整段动画里 **变化 0.000°**。
3. **转出的 VRM 是静止 T-pose**：见 `tests/tmp/adv-pilot-real/user-images/pilot-idle-issue.jpg`（上排官方实机待机 vs 下排当前输出），与上一条一致。
4. **不是 Mac 侧 bug**：源 FBX 的 Biped 骨就没有动画曲线 → Mac 侧无论怎么重定向都只能是静止姿态。
5. **原始 FBX 文件级证据（不依赖 Blender 导入）**：用 FBX SDK 的解析逻辑直接读二进制 FBX（版本 7400 / FBX2014）：
   `StandBy.fbx` 有 **836 个 AnimationCurveNode / 2508 条 AnimationCurve**，连接到的动画目标是 **287 个非 Biped 节点**（`0000_Body…0009_Weapon` 等网格节点 + `*_JNT` 次级骨 + 面部骨），**Biped 目标 = 0**。
   → 说明「Biped 动画没被写进 FBX」是文件级别的事实，不是 Blender/采样器读漏了第二层动画。

### 2.2 分析

- 3ds Max 的 Biped 是**程序化控制器**（不是普通 keyframe 控制器）。FBX 导出必须靠 **Bake Animation** 把它采样成骨骼关键帧；如果 bake 没生效，就会出现「普通 keyframe 的次级/表情骨有动画、Biped 骨没有」这个精确症状。
- 需要确认的可能原因（一次诊断即可区分）：
  1. **BakeAnimation 参数没被当前 FBX 插件识别/生效**（需要看 `FBXExporterSetParam` 返回值）；
  2. **Biped 所在物体/层被隐藏**（Max 的动画烘焙可能跳过隐藏对象；脚本里我们没显式 unhide）；
  3. `Bip2FBX` 选项（我们照旧文档设置了 true）在 2027 里行为不同，导致 Biped 转换走「静态骨骼」路径；
  4. **Biped 处于 Figure Mode（体形模式）**：该模式下 Biped 被冻结在 rest 骨架、不播放/不烘焙动画，正好会产生「所有 Biped 骨静止在 A-pose」的症状。**需要人工确认**：打开 StandBy.max → 选中 Biped 根 → Motion 面板 Biped rollout → Figure Mode（小人图标）是否高亮；播放时人物身体是否动。若 Figure Mode 曾为 ON，关掉后再导出即可验证。
  5. **动画在 Biped Layers（Biped 动画层）里**：Biped 支持动画层（Motion 面板 → Biped Layers），FBX 的 bake 可能只读 base layer（或要求层激活），导致图层里的动画没被烘焙。诊断脚本会打印 `numLayers`/每层名字与 active 状态；实验变体 I/J 会先把所有层激活、`collapseAtLayer` 合并到 base layer 再导出。
  
  > `probe_scene_anim.ms` 已包含「人工检查清单」输出（Figure Mode 状态 / 播放是否动 / 中间帧姿态是否变），并会把 Biped 骨骼在起始帧 vs 中间帧的 transform 数值打出来。
- 另外注意：以上都是**导出设置问题**，`export_log.txt` 里的 `frames=` 证明场景动画区间正常，场景里 Biped 本身应该是有动画的。

### 2.3 修复方案（需要豆包执行 2 个脚本，Mac 已准备好）

**脚本 A：`probe_scene_anim.ms`**（诊断，只读，不改场景）
- 打开 `D:\sjxl\max\StandBy.max`，输出 `D:\sjxl\probe-scene-anim.txt`：
  - FBX 导出参数支持矩阵（`BakeAnimation` / `Bip2FBX` 等到底认不认）；
  - 隐藏/冻结物体数、Layer 隐藏状态、`Bip*` 节点是否 animated、控制器类名；
  - 起始帧 vs 中间帧的 Biped 骨骼/根节点 transform 对比（**证明场景里 Biped 到底动不动**）。
- 回传 `probe-scene-anim.txt`。

**脚本 B（手动对照，1 分钟）：先用 3ds Max GUI 默认设置导一次 StandBy**

这个用来快速区分「我们的 MaxScript 参数没生效」还是「场景本身/Figure Mode/图层问题」：

1. 3ds Max 打开 `D:\sjxl\max\StandBy.max`；
2. 菜单 `File → Export → Export...`（文件 → 导出 → 导出），保存类型选 **FBX (*.FBX)**，文件名 `StandBy_gui.fbx`，保存到 `D:\sjxl\exp\`；
3. 在弹出的 FBX Export 对话框里：
   - 预设选 **Autodesk Media & Entertainment**（默认）；
   - **Animation** 勾上（Bake Animation 默认勾选的话保持勾选；若有 "Resample All" 也勾上）；
   - 其它保持默认 → OK；
4. 把 `StandBy_gui.fbx` 一起回传。

判读：如果 GUI 默认导出的 FBX 里 **Biped 身体动画正常**（Mac 侧一测便知），说明是我们脚本里的某个参数（`Bip2FBX`/bake 参数名）在 2027 不被接受 → 改成「清空设置 + 只开 Animation/BakeAnimation」或「LoadExportPresetFile 载入默认预设」即可；如果 GUI 默认导出也**没有**身体动画，则问题在场景侧（Figure Mode / Biped Layers / 隐藏对象），由实验 A–J 定位。

**脚本 C：`export_experiments.ms`**（实验，1 个场景导出 10 个变体）
- 对 `StandBy.max` 导出到 `D:\sjxl\exp\StandBy_<变体>.fbx`（每 5–10MB，共约 50–70MB）：
  - `A_current`：当前设置（基线，复现问题）
  - `B_nobip2fbx`：去掉 `Bip2FBX`
  - `C_unhide`：导出前全部 unhide（物体+层）+ 当前设置
  - `D_unhide_nobip2fbx`：unhide + 去掉 `Bip2FBX`
  - `E_minimal`：只开 `Animation` + `BakeAnimation`（其余默认）
  - `F_minimal_unhide`：minimal + unhide
  - `G_figureOff`：尝试关闭 Biped Figure Mode + 当前设置（脚本会先探测/打印 Figure Mode 状态与可用的关闭 API）
  - `H_figureOff_unhide`：关闭 Figure Mode + unhide
  - `I_collapseLayers`：激活全部 Biped Layers 并合并到 base layer + 关闭 Figure Mode + 当前设置
  - `J_collapseLayers_unhide`：I + unhide
- 所有变体都会把关键信息（参数是否被识别、Biped 层数/层名、Figure Mode 探测结果、导出文件大小）写进 `experiments-log.txt`。
- 脚本会先把 Figure Mode 探测结果（`figureMode` 属性/函数是否可用、当前值）写进日志——如果探测不到 API，日志里会显示 `no *Biped* transform controller found` 或 `probe value=?`，我们再改用手工方式。
- 回传整个 `D:\sjxl\exp` 文件夹 + `experiments-log.txt`。
- Mac 侧会逐个检查「哪个变体的 Biped 骨有动画」，确定最终设置，然后改好 `export_max.ms` 让豆包重跑 pilot。

> 修复验证顺序建议：先只重导 **StandBy + Skill01** 两个文件给 Mac 快速验证（30 秒），通过后再跑全量 6 个 pilot 文件。

## 3. P2（次要）：`_skel` 版本没有瘦身

- 证据：`export_log.txt` 里 `OK,SKEL,...,deletedMeshes=0`；`StandBy.fbx` 7,274,032B vs `StandBy_skel.fbx` 7,274,048B（只差 16B）→ skel 版 = 全场景版。
- 根因：场景里 `superClassOf==GeometryClass` 的对象有 **338 个**（10 个模型网格 + 328 个骨骼/次级几何对象；Biped/骨骼在 Max 里也是 geometry 类），我们原来按 `Editable_Poly/Editable_Mesh/PolyMeshObject` 类名删模型网格，**实际类名不匹配 → 0 个被删**。不能改成「删所有 GeometryClass」——那会把 Biped 骨架一起删掉。
- 已修复（`scripts/max-export/export_max.ms`）：skeleton-only 导出改为 **先选中 `Bip*`/`*Footsteps*` 对象 → `exportFile ... selectedOnly:true`**，不删除任何物体；没选中任何 Bip 对象时自动回退整场景并记 WARN。
- 预期重跑后：`StandBy_skel.fbx` 约 **0.5–2MB**（只有 65 根 Biped 骨 + 动画），全量 138 文件约 100–300MB，传输可接受。
- 如果 selection 导出仍不理想：跑 `diagnose_max.ms` 回传类名清单，可改回按类删除（精确名单）。

## 4. 其它观察（不是问题）

- **fps 混合**（30/60）：采样器每个 clip 写 `sourceFps`，下游已按 clip 处理——无需重导统一。
- **Tpose.max 有 301 帧动画**：采样只取 bind/rest 矩阵（不是第 0 帧），且已验证 rest 是 A-pose（与 HSR 原 rest 一致，手臂下斜 54.6°）；rest-direction-fix 会修到目标 T-pose，符合预期。
- **骨骼名**：源就是标准 Biped 命名（`Bip001 Pelvis` 等，Finger0=拇指），与我们的 `humanoid-biped.mjs` 映射一致，指纹识别/手指打分与 Wave1 HSR 原始数据的数值完全吻合（54.59°/54.79°/51.13°/88.43°），说明映射正确。
- **源 FBX 世界尺度 0.01**（armature 父级带缩放）：不影响重定向（用 armature 局部空间），采样器已修高度计算。

## 5. 需要豆包做的事（按顺序，约 3 分钟）

1. 把 `probe_scene_anim.ms`、`export_experiments.ms` 放到 `D:\sjxl\`（新版工具包里有）。
2. 3ds Max 里 `Scripting → Run Script…` 依次运行：
   - `probe_scene_anim.ms` → 得到 `D:\sjxl\probe-scene-anim.txt`
   - `export_experiments.ms` → 等待 6 个变体导出完成 → 得到 `D:\sjxl\exp\`
3. 再做一个**手动对照导出**（见上「脚本 B」）：3ds Max GUI 默认设置导出 `StandBy_gui.fbx` 到 `D:\sjxl\exp\`。
4. 把 `probe-scene-anim.txt` + `D:\sjxl\exp` 整个文件夹压缩传回 Mac。
5. 等 Mac 回复「正确导出设置」后，用更新后的工具包重跑 `run_pilot.bat`（先只发 StandBy+Skill01 做快速验证）。

## 6. 结论

**pilot 验证暴露的是导出设置问题，不是数据/格式/兼容性问题**。骨架、单位、帧率、动作时长、命名、重定向数学全部正确；只要把 Biped 动画烘焙进 FBX（预计就是 BakeAnimation 生效/隐藏对象/`Bip2FBX` 三选一），整条链路就能直接跑通全量 138。
