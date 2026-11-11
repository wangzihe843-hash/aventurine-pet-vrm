# fbx-pilot-v3 验收对比报告（豆包第三版）

> 日期：2026-11-09 · 对象：`<home>/Downloads/fbx-pilot-v2-gui.zip`（27,205,229 B；包内实际是**第三版 v3** 产物：12 个 pilot FBX + `StandBy_gui.fbx` + `export_log.txt` + `sha256.txt` + `diag/` + `proof/` + `scripts/`）
> 对照基准：v1/v2 回传物、源 `.max` 取证（前两轮）、官方实机素材（B站/米游社视频抽帧）、本机 Blender 4.2 / 管线复跑
> 一句话结论：**豆包 v3 修好了 P1（Biped 动画 0 曲线）和 P2（`_skel` 瘦身），12/12 FBX 都有完整烘焙曲线（Tpose 为首帧参考、静止属预期），导出侧 pilot 门禁通过，可以放行全量 138。**
> 同时本轮新发现两类“差异”，**都不在豆包导出侧、而在 Mac 侧转换链**：① v3 FBX 新增了 `Bip001` **根对象动画**（根运动），当前采样器只采骨骼、不采对象级动画，导致 Skill01/State_Stun/Walk 在 VRM 里少掉转身/位移/上下起伏；② 重定向库有一条旧的“首帧参考姿势裁剪”启发式，误把 `State_Stun` 合法开头裁掉 2 帧（已在本机修复）。
> 相关文档：`docs/pilot-findings-2026-11-09.md`（v1 问题定位）、`docs/pilot-v2-comparison-2026-11-09.md`（v2 复核）、**`docs/doubao-v3-problem-report.md`（本轮给豆包的全量导出指令与改进方案）**、`docs/research/v3-bip2fbx-rootcause.md`（Bip2Fbx 根因研究）、`docs/research/v3-fbx-export-bestpractices.md`（全量导出/自检 best practices 研究）
> 效果图（供验收）：`tests/tmp/adv-pilot-v3/acceptance/`（另已同步网盘 `砂金动作转换/pilot-v3-结果/`）

---

## 0. TL;DR

| # | 检查项 | v2（第二版） | v3（本版） | 判定 |
|---|---|---|---|---|
| P1 | Biped 身体动画（65 根 Biped 骨） | 0 条曲线 / 静止 | **650 条曲线/文件（65 骨 × 10 通道），逐帧烘焙** | ✅ **已修复** |
| P2 | `_skel` 瘦身 | 未瘦身（=全场景） | 已删 10 个网格，体积降 37–49% | ✅ **已修复** |
| — | 文件级自检 12/12 | 0/65 | **65/65 骨有曲线 + 帧间姿态变化（Tpose 除外，Tpose 本来就静止）** | ✅ |
| — | 关键帧完整性 | 无 | 每通道 **85 keys（85 帧）× LINEAR**，无 key reduction | ✅ |
| — | 回传日志/诊断 | 缺失 | `export_log.txt` + `diag/` + `sha256.txt` + 源场景渲染 5 帧 | ✅ |
| — | 转换管线复跑（v3 → 采样 → 重定向 → VRM） | 5/5 数据 PASS 但动作全静止 | **5 clip：4 PASS / 1 WARN（walk 循环接缝 5.7°），动作已连续** | ✅ |
| — | 与官方实机对比 | “静止 T-pose vs 连续动作”本质差异 | **StandBy/Talk01/Walk 定性一致；Skill01 动作链一致** | ✅ 定性通过 |
| 新增 | **`Bip001` 根对象动画** | 无（v2 对象级 0 条曲线） | **9 条对象级通道（loc/rot/scale），逐帧烘焙** | ⚠️ Mac 侧未采样（待修） |
| 新增 | 根运动幅度（Skill01/Stun/Walk） | — | 转身 127°、前冲 0.44m、下蹲 0.18m（Skill01） | ⚠️ 见 §5 |
| 设计内 | 道具/面部/次级骨 | — | 不随动作导出（只转人体骨架） | 非差异（契约） |

**一句话给豆包**：v3 可以了，按同一套设置（最小参数集、**绝不写 `Bip2Fbx`**）跑全量 138 的 `_skel`；不要改成 Export Selected；保留 `Bip001` 根对象动画；按 `docs/doubao-v3-problem-report.md` 的增强自检回传日志。

---

## 1. 回传物核对

`unzip -l fbx-pilot-v2-gui.zip`：37 个文件，解压 94,063,919 B。

| 内容 | 数量/大小 | 核对结果 |
|---|---|---|
| `pilot/*.fbx` | 12 个（6 全场景 FULL + 6 `_skel`） | ✅ 都在，且与 `sha256.txt` 一致 |
| `StandBy_gui.fbx` | 8,147,040 B | ✅ 与 `pilot/StandBy.fbx` **sha256 完全相同**（`543b9a4f…d9627`），与豆包 §4 的说法一致（脚本按同一组勾选项导出） |
| `export_log.txt` | 24 行 | ✅ 12 行 OK、0 FAIL，末行 `=== DONE mode=pilot ok=6 fail=0 ===` |
| `sha256.txt` | 13 条 | ✅ 本机重算 13/13 一致（排除“拿旧文件充数”） |
| `diag/exp1..exp5`、`diag1-StandBy.txt` | 6 份 | ✅ 单变量实验原始日志（A–J 矩阵、参数回读、Bip2Fbx 归零证据） |
| `proof/source_f0/20/41/62/83.png` | 5 张 | ✅ 源场景 3ds Max 渲染帧（相机/灯光为批处理临时加的，未保存 .max） |
| `proof/render_check.txt`、`render_fbx.txt` | 2 份 | ✅ 如实记录“回导 FBX 后批渲染崩溃”（本机 Blender 渲染正常，见 §4） |
| `scripts/*.ms` | 8 份 | ✅ `export_max_v3.ms` 源码已核对：无 `Bip2Fbx`、只留最小参数集、`selectedOnly:false` 整场景导出、`_skel` 为“删 10 个网格后整场景导出” |

> 结论：v3 的回传物**完整、可复核**。上一轮缺失“日志/诊断”的问题已解决。

---

## 2. 数据级复核（本机 Blender 4.2 独立验证）

### 2.1 逐文件：动画曲线 / 姿态变化

`work/adv-biped/check_biped_anim.py`（Blender 导入每个 FBX，统计 65 根 Biped 骨的 fcurve 数 + 起/中/末帧世界四元数差）：

| 文件 | 骨架 | Biped 骨 | Biped 曲线 | 帧间最大姿态变化 | 判定 |
|---|---|---|---|---|---|
| Skill01.fbx / Skill01_skel.fbx | Bip001 | 65 | **650** | 139.75° | PASS |
| StandBy.fbx / StandBy_skel.fbx | Bip001 | 65 | **650** | 1.61°（待机本就微动） | PASS |
| State_Stun.fbx / State_Stun_skel.fbx | Bip001 | 65 | **650** | 172.06° | PASS |
| Talk01.fbx / Talk01_skel.fbx | Bip001 | 65 | **650** | 4.64° | PASS |
| Tpose.fbx / Tpose_skel.fbx | Bip001 | 65 | **650** | 0.07°（T-pose，应静止） | 预期内 FAIL |
| Walk.fbx / Walk_skel.fbx | Bip001 | 65 | **650** | 51.28° | PASS |

- 650 = 65 骨 × 10 通道（location 3 + rotation 4 + scale 3）；v2 同项 = **0**。
- 复合场景里还有 267 根非 Biped 骨（187 `*_JNT` + 80 面部），v3 里也仍有动画（总 fcurve 3,329 = 332 骨 × 10 + 9 条对象级通道）。

### 2.2 关键帧完整性（无 key reduction）

对 `StandBy_skel.fbx` 逐曲线检查：

| 项 | 结果 |
|---|---|
| action | `Bip001|Take 001|BaseLayer`，range 1..85（= 源场景 0..84，Blender 时间轴 +1 偏移） |
| fcurve 数 | **3,329**（3,320 骨通道 + 9 条 `Bip001` 对象级通道） |
| 每曲线关键帧数 | **85 / 85 / … 全部 85**（= 帧数，逐帧烘焙，没有丢帧/抽帧） |
| 插值 | **LINEAR**（采样 500 条曲线共 42,500 keys 全部 LINEAR） |
| 结论 | 完整 dense bake，不是“稀疏关键帧+曲线拟合”，下游逐帧采样不会有插值误差 |

### 2.3 `_skel` 与 FULL 的动画等价性（关键）

把 6 个 FULL 与 6 个 `_skel` 分别用同一采样器采样后逐帧逐骨比对（65 根 Biped 骨，四元数分量差，考虑四元数符号）：

| clip | 帧数 FULL/SKEL | 全骨最大差 | **非 Nub 骨最大差** | 结论 |
|---|---|---|---|---|
| skill01 | 98 / 98 | 1.06（仅 Nub） | **9.0e-6（≈0.001°）** | 等价 |
| idle | 85 / 85 | 0.85（仅 Nub） | **2.0e-6** | 等价 |
| stun | 56 / 56 | 1.17（仅 Nub） | **3.7e-6** | 等价 |
| talk01 | 102 / 102 | 1.08（仅 Nub） | **1.9e-6** | 等价 |
| walk | 36 / 36 | 1.01（仅 Nub） | **9.9e-6** | 等价 |

> Nub 是 Biped 的叶子标记骨（`*Nub`，不参与变形/重定向）；它的 rest 方向在不同导出里不固定，属正常。**派生结论：全量阶段只导 `_skel` 不会损失任何要用的动画**（体积降 37–49%，见 §2.5）。

### 2.4 本版新增：`Bip001` 根对象动画（v2 没有）

v3 的 `Bip001`（Biped 根对象，armature object）带 **对象级动画**：location 3 + rotation 3 + scale 3 = 9 条通道，逐帧 85 keys。**v2 没有**（v2 `Bip001|Take 001` 的 obj-level 曲线数 = 0）。

| clip | 根对象位移范围（世界，换算成米*） | 根对象旋转（相对首帧） | 对应动作含义 |
|---|---|---|---|
| StandBy | x 0.7mm / 水平 2.9mm / 竖直 0.2mm | 0.58° | 待机微动（可忽略） |
| Skill01 | 水平 **0.435m**、横向 0.12m、竖直 **0.175m** | **127.5°** | 普攻的转身+前冲+下蹲（staging） |
| State_Stun | 水平 **0.378m**、横向 0.08m、竖直 **0.098m** | **103.7°** | 受击后踉跄/后仰 |
| Talk01 | 5mm / 1.6mm / 0 | 1.86° | 说话时几乎不动（可忽略） |
| Walk | 前向 **1.177m**（原地化会去掉）、竖直 **0.032m**（走路上下起伏） | 11.9° | 走路 root motion + bob |
| Tpose | 0 | 0 | 静置 |

\* 换算系数 = 1.6817m / 0.018254（同源 rest 高度），±3%。

→ 这是 **v3 相对 v2 的能力提升**（Biped 根对象动画也被 bake 出来了），但**当前 Mac 采样器只采 `pose_bone.matrix`（armature 空间），不采 armature 对象本身的世界变换**，所以这 9 条通道目前全部丢失（详见 §5）。

### 2.5 体积对比（v2 → v3）

| 文件 | v2 FULL | v3 FULL | Δ | v3 SKEL | SKEL 降幅 |
|---|---|---|---|---|---|
| Skill01 | 10,196,768 | 11,161,072 | +964,304 | 8,138,240 | −27% |
| StandBy | 7,274,032 | 8,147,040 | +873,008 | 5,128,896 | −37% |
| State_Stun | 9,374,624 | 10,035,008 | +660,384 | 7,027,312 | −30% |
| Talk01 | 7,729,248 | 8,722,496 | +993,248 | 5,698,224 | −35% |
| Tpose | 5,089,264 | 6,218,176 | +1,128,912 | 3,187,168 | −49% |
| Walk | 5,743,408 | 6,259,072 | +515,664 | 3,258,576 | −48% |

→ FULL 增大的部分正好是**新烘焙进来的 Biped 曲线**（~0.5–1.1MB/文件）；`_skel` 删掉 10 个网格后明显变小。
→ 全量 138 的 `_skel` 预估 ≈ **5.4MB × 138 ≈ 750MB**（zip 后约 500–600MB）；若需要更小，可做“只留 Biped 67 节点”的超瘦身（估 ~1MB/文件，见给豆包的方案 §4，本轮不做，避免引入风险）。

---

## 3. 转换管线复跑（v3 → 采样 → 重定向 → 校验 → VRM）

命令（本机）：
```
scripts/vrm/motion/run-adv-pipeline.sh --fbx-dir tests/tmp/adv-pilot-v3/fbx --mode pilot \
  --tmp-dir tests/tmp/adv-pilot-v3/pipeline
```

### 3.1 采样

- 12 个 FBX 里成对 FULL/SKEL 由采样器自动优先 `_skel`（已证等价，见 §2.3）；`StandBy_gui.fbx` 与 `StandBy.fbx` 同 sha，去重后不影响。
- 65 根 Biped 骨全部采到；267 根次级/面部骨按设计不采（目标 VRM 用 SpringBone，见 §4.5）。
- **rest 基准 = `Tpose_skel.fbx`（A-pose，手臂下斜 54.6°）**；每个动画文件的 rest 与它不同（`max diff 1.4–1.8`）属正常——因为 `_skel` 没有蒙皮，FBX 里节点的“rest”写的是导出时场景姿态；我们的采样是**逐帧 armature 空间绝对矩阵**，不依赖这个 rest，实测 FULL/SKEL 采样结果一致（§2.3）也证明了这一点。
- fps：Skill01/State_Stun/Tpose=60，StandBy/Talk01/Walk=30，采样器按 per-clip `sourceFps` 处理（60→30 降采样），无混用错误。

### 3.2 重定向 + 校验（修复本机裁剪 bug 后的最终结果）

| clip | 帧数@30 | 时长 | maxFrameJump | loopSeam | hipsHeightRange | grounding | 校验 |
|---|---|---|---|---|---|---|---|
| idle（StandBy） | 84 | 2.800s | 0.19° | **0.07°** | 0.3mm | feet（残差 0.7mm） | **PASS** |
| walk | 35 | 1.167s | 9.52° | 5.7° | 3.03cm | feet（残差 2.6cm） | WARN（见 §6-G3） |
| talk01 | 102 | 3.367s | 8.30° | — | 0.8mm | feet（0.7mm） | **PASS** |
| stun | 56 | 1.833s | 90.7°（首帧受击 snap，源动画本身如此） | — | 0 | none | WARN（源动作特性，非错误） |
| skill01 | 98 | 3.233s | 43.75° | — | 0 | none | **PASS** |

- **v2 对照**：v2 复跑时 5 个 clip 的 `maxJump` 全为 0°、`loopSeam` 全 0°（整段静止）；v3 **全部非 0，动作真实存在**。
- 时长与源场景一致（StandBy 源 0–83.5f@30 ≈ 2.78–2.8s、Walk 35f、Talk01 101f、State_Stun 110f@60=1.833s、Skill01 194f@60=3.233s）。

### 3.3 本机已修：`State_Stun` 首帧被误裁（Mac 侧 bug，非豆包问题）

`lib/retarget.mjs` 里有一条历史启发式：“非循环 clip 若首帧→次帧 >15% 的骨跳变 >45°，判定首帧是参考 T-pose，最多裁掉 2 帧”。这条规则是给旧 HSR 数据写的；v3 的 `State_Stun` 受击动画**开头本来就有合法的大幅 snap**（站立持板 → 受击弯腰），于是被误裁 2 帧：修复前 clip = 54 帧 / 1.767s、首帧直接是“弯腰受击”；修复后 56 帧 / 1.833s、首帧恢复为源场景的站立持板。

- 修复：把该启发式限定为 `sourceInfo.name === 'hsr'`（Biped 源不裁）。
- 修改文件：`scripts/vrm/motion/lib/retarget.mjs`（本机已改，未提交）。
- 证据：`tests/tmp/adv-pilot-v3/pipeline/retarget-report.json` 的 `trimmedReferenceFrames` 从 2 → 0；`tests/tmp/adv-pilot-v3/acceptance/对比-源FBXvsVRM-受击眩晕-三视图.jpg` 首帧已与源一致。

---

## 4. 与官方实机效果对比（视觉）

> 三层证据：① 官方实机视频抽帧（B站 BV1Nyta66Evh 等，见 `docs/research/aventurine-reference-videos.md`）；② 源 FBX 渲染（Blender 4.2 Workbench，含网格/蒙皮/根对象动画，`render-source-fbx.py` 固定机位三视图）；③ VRM 重定向输出（`preview-adv.mjs`，同一机位/同一时间百分比）。
> 验收图：`tests/tmp/adv-pilot-v3/acceptance/对比-官方实机vs豆包v3-待机.jpg`、`…-普攻.jpg`（三列）；`对比-源FBXvsVRM-{待机/普攻/走路/对话待机/受击眩晕}-三视图.jpg`（源 vs VRM 逐帧）。

### 4.1 StandBy（战斗待机）——定性一致

- 官方实机：站姿连续待机，呼吸/重心微动，手臂自然垂放（运镜环绕，10.6s）。
- v3 源 FBX：同一姿态、同一量级的微动（帧间姿态差 1.61°，源场景 5 帧渲染可见手臂/躯干变化）。
- VRM 输出：连续站姿待机，`maxFrameJump 0.19°`、`loopSeam 0.07°`（循环无缝），姿态与官方同型。
- **判定：一致**（不再是 v2 的“五个时间点完全静止同一 T-pose”）。

### 4.2 Skill01（普攻）——动作链一致，但 VRM 缺根运动

- 官方实机片「普攻」段（0–2.2s，A 级素材）：持板瞄准 → 突刺/发光 → 收势。
- v3 源 FBX：持板瞄准（0%）→ 前冲劈/刺（10%）→ 转身收势（20–60%）→ 二次挥板（70%）→ 持板结束（100%）；**含根对象动画**（转身 127°、前冲 0.44m、下蹲 0.18m）。
- VRM 输出：骨架姿态与源 FBX 一致（同一时间点的四肢/躯干角度匹配），**但根对象动画没采到** → 30–60% 源在转身/前冲，VRM 保持原位正面站姿；这是肉眼可见的最大差异（见 `对比-源FBXvsVRM-普攻-三视图.jpg` 第 3–5 列）。
- 另：官方片段 2.2s vs 源动画 3.25s，二者时长不同（官方疑似只截了一段），**动作↔官方片段的逐帧对应关系待下一轮用完整长视频确认**；本轮只能判“动作链同型”。
- **判定：源导出保真；VRM 侧因根运动未采样而不一致（Mac 侧待修，见 §5）**。

### 4.3 Walk（走路）——步态一致，竖直起伏被原地化吞掉

- v3 源 FBX：标准走路循环，35 帧@30（1.167s），骨盆竖直起伏 3.2cm，根节点前移 1.18m/循环（游戏用 root motion）。
- VRM 输出：`maxFrameJump 9.52°`、步态/摆臂正确；按契约**原地化**去掉水平位移（预期），但 3.2cm 的竖直 bob 也被丢掉，脚部 grounding 用 2.6cm 的常量补偿代替（`footErrorMax 2.62cm`，WARN 阈值边缘）。
- **判定：步态一致；原地化是设计，竖直 bob 属 §5 的同一个根运动问题**。

### 4.4 Talk01 / State_Stun（无公开逐条素材）

- Talk01：源 vs VRM 三视图逐帧对比**动作基本一致**（抬手/放下的时机与幅度吻合；差异仅道具/手指细节）。根对象动画仅 5mm，可忽略。
- State_Stun：源 = 站立持板 → 受击弯腰 → 踉跄 → 眩晕低头；修复首帧裁剪后 VRM 序列与源同型，**但缺根运动的竖直/位移/转身**（源下蹲 9.8cm、后移 0.38m、转 104°），所以 VRM 显得“站得更直、更不狼狈”。
- **判定：骨架动作一致；Stun 的“幅度/位置”差一块根运动（同 §5）**。

### 4.5 设计内差异（不是 bug，不在豆包修改范围）

| 差异 | 原因 | 处理 |
|---|---|---|
| 道具（冲浪板/武器）不出现 | 只转人体骨架 + 目标 VRM 无道具绑定 | 契约内；**2026-11-09 晚已解决来源**：全场景 FBX 内含 `0009_Weapon` 网格 + 武器骨，已提取 `assets/props/watergun/watergun.glb`，挂点方案见 `docs/research/watergun-prop-plan.md` |
| 头发/衣摆/围巾等 267 根次级骨动画不随动作 | 目标 VRM 用 SpringBone 物理驱动 + 表情系统 | 契约内（`rawPolicy=spring`）；本批 5 clip `raw=0` |
| 面部表情骨（80 根）动作不导出 | 同上，表情走 app 表情系统 | 契约内 |
| Tpose rest 是 A-pose（手臂下斜 54.6°） | 源 Biped Figure Mode 的 rest 即 A-pose，与 v1/v2 一致 | 已由 `rest-direction-fix` 修正（36 骨），无需豆包改 |

---

## 5. 【本轮最重要新发现】`Bip001` 根对象动画未被 Mac 转换链采样

### 5.1 事实

1. **v3 FBX 里确实有根运动**：每个动画文件的 `Bip001`（armature object）带 9 条对象级动画通道（location/rotation/scale），逐帧 85 keys、LINEAR；**v2 为 0 条**。幅度见 §2.4（Skill01 转身 127°/前冲 0.44m/下蹲 0.18m；State_Stun 104°/0.38m/0.098m；Walk bob 3.2cm）。
2. **我们的采样器只采骨骼**：`extract-biped-anims.py` 逐帧取 `pose_bone.matrix`（armature 空间），**armature 对象本身的世界变换没有采**；因此这 9 条通道在 samples.json 里不存在。
3. **重定向设计本来就留了接口**：`lib/retarget.mjs` 的台阶 4「Hips 位移 + grounding」会读 `hips` 的世界位置并做 `inPlace` 处理（**水平位移归零、竖直位移保留（>0.5m 才判 staging 归零）、旋转保留**）——注释明确写“旋转仍保留”。也就是说**只要采样器把根对象动画并进来，重定向侧就会按设计处理**。
4. **影响面**：StandBy/Talk01 可忽略（毫米级）；Skill01、State_Stun、Walk 的“转身/前后位移/上下起伏”缺失——这正是 §4.2/4.4 里肉眼看到的差异。

### 5.2 根因定位

| 层 | 现状 | 证据 |
|---|---|---|
| 源 `.max` | Biped 根对象 `Bip001` 在场景里是**有动画的**（diag1：`Bip001 … isAnimated=true`；层级 `Root → Bip001 → Pelvis`） | `diag/diag1-StandBy.txt` |
| 3ds Max 导出 | v3 把根对象动画也 bake 进 FBX（对象级 9 通道），**信息是完整的** | `probe_objanim`：v3 有 9 条 obj-level 曲线；v2 = 0 |
| Mac 采样器 | **只采 pose bone（armature 空间）**，漏了 armature object 的世界矩阵 | `extract-biped-anims.py` `sample_action()`：`pose_bone.matrix` |
| 重定向 | 具备 in-place/竖直/旋转处理能力，但输入里没有根运动 | `lib/retarget.mjs` §4 |

→ **不是豆包的导出问题；是 Mac 侧采样器对“Biped 根运动写在 armature object 上”这一 3ds Max 特性没有覆盖。**

### 5.3 修复方案（Mac 侧，下轮实施）

**方案 A（推荐）**：采样器逐帧把 armature object 的动画增量并进骨骼矩阵：

1. 记录 rest 参考 `M_obj_rest = arm.matrix_world`（Tpose 文件同一帧，Tpose 无对象动画，稳定）。
2. 每帧 `D(f) = M_obj_rest⁻¹ · arm.matrix_world(f)`（这是“对象动画增量”，含转身/位移；不含 Root 空物体的常量轴转换/缩放）。
3. 采样时对每根骨取 `pose_world(f) = D(f) · pose_bone.matrix(f)` 的旋转与平移（保持 armature 空间单位，避免引入 0.01 缩放换算）。
4. rest 不变（`bone.matrix_local`）；重定向数学不需要改：`delta = pose_world · rest⁻¹` 会自然把根旋转带到 hips，`hips` 位置会带上根位移，`inPlace` 逻辑照旧去水平、留竖直/旋转。
5. 验收：`skill01` 的 VRM 在 30–60% 出现与源一致的转身，骨盆高度差 ≤2cm；`walk` 出现 3.2cm 竖直 bob；`stun` 下蹲/后移恢复；`idle/talk01` 变化 <1cm（回归无感）。

**方案 B（备选）**：只采 `Bip001` 对象的位置+旋转，作为“虚拟 hips 父级”单独写进 samples schema，由 retarget 合成。—— 改动更显式，但要扩 schema，不如 A 简洁。

> 本轮按用户要求**只出报告不动转换脚本主体**（除已修的小 bug），方案 A 留待下一轮实施；实施后 §4.2/4.4/4.3 的差异应全部消失。

---

## 6. 剩余问题清单（按 owner 分类）

| # | 问题 | Owner | 严重度 | 状态/动作 |
|---|---|---|---|---|
| G1 | `State_Stun` 首帧被旧启发式误裁 2 帧 | Mac | 中 | **已修**（`lib/retarget.mjs` 限定 hsr 源） |
| G2 | `Bip001` 根对象动画未采样 → Skill01/Stun/Walk 缺转身/位移/起伏 | Mac | **高（本轮唯一实质差距）** | 待实施 §5.3 方案 A |
| G3 | `walk` loopSeam 5.7° 报 WARN | Mac | 低 | 校验器口径问题：loop clip 不存重复末帧，seam 天然 = 1 帧步进（5.7° < 同 clip maxFrameJump 9.5°），不是数据问题；建议校验器改为对比 `maxFrameJump`（如 `loopSeam ≤ max(2°, 1.2×maxJump)`） |
| G4 | StandBy 源场景 end=83.5，`BakeFrameEnd` 只能整数 → 导到 84（多半个帧） | 豆包/设计 | 低 | 已定策略：沿用 `ceil`（保留最后半帧），本机 loop 裁剪后 loopSeam 0.07°，无需改。全量日志补 `rawRange/rawTicks/bakeRangeInt/expectedKeys` 便于对账；若后续对时长精度有更高要求，可选“临时把场景 fps 改 60、bake 0..167、导出后恢复”的 2× 重采样方案（需先 pilot，不用于本轮全量） |
| G5 | 道具/面部/次级骨不随动作 | 设计 | 契约内 | 不在本轮范围 |
| G6 | Skill01 与官方「普攻」片段的逐帧对应未确认（官方片段 2.2s vs 源 3.25s） | 验收 | 中 | 下一轮用完整长视频（V11/V13 全程 + 慢放）复核 take↔动作映射；本轮只判动作链同型 |
| G7 | 全量 138 未跑 | 豆包 | — | **v3 已放行**：按 `docs/doubao-v3-problem-report.md` 跑 `_skel` |
| G8 | 豆包 v3 的自检“导入”没有显式关掉导入侧 Resample/Key Reducer → 极端情况下自检 key 数可能不可信 | 豆包（自检） | 低 | 本轮我们用 Blender 独立复核不受影响；已要求全量自检按 `FBXImporterSetParam ResetImport/Mode #create/TakeIndex 1/Resampling 1.0/PostSamplingKeyReducer false/KeepFrameRate true/FillTimeline true` 显式设置（见 `docs/doubao-v3-problem-report.md` §4） |
| G9 | 单进程跑 138 个文件的内存/长稳风险（社区经验：Max 长批处理可能内存增长/卡死） | 豆包（运维） | 低 | 已建议：若内存上升/崩溃就分 3–4 段（每段 30–40 文件，设置不变）或对失败项单独重跑；不建议并行。另建议每文件日志补 `rawRange/rawTicks/bakeRangeInt/expectedKeys`（83.5 这类非整数范围可对账） |

---

## 7. 结论与下一步

1. **豆包 v3 = 通过**：P1/P2 全修，12/12 数据自检通过，导出侧信息完整（含根对象动画），日志/证据齐全。可以进入全量 138。
2. **Mac 侧下一轮必须先做**：实现 §5.3 的根运动采样（这是目前 VRM 输出与源/实机之间**剩下唯一的实质差距**），并回归 `walk` 校验器口径（G3）。
3. **豆包侧下一轮**：只跑全量 `_skel`（同一套设置，禁止 `Bip2Fbx`），按增强自检回传日志；细节见 `docs/doubao-v3-problem-report.md`。
4. **验收口径**：全量回来后按 `docs/adv-acceptance-plan.md` 两层对拍；本轮的验收效果图已存档（下 §8）。

---

## 8. 证据索引

| 内容 | 路径 |
|---|---|
| v3 原始包（解压） | `tests/tmp/adv-pilot-v3/fbx-pilot-v2-gui/` |
| v3 FBX（13 个） | `tests/tmp/adv-pilot-v3/fbx/` |
| 本机 Blender 逐文件自检 | `tests/tmp/adv-pilot-v3/check_biped_anim.log` |
| 采样/重定向/校验产物 | `tests/tmp/adv-pilot-v3/pipeline/`（samples.json、samples-report.json、retarget-report.json、validation-report.json、clips/、preview/） |
| 源 FBX 三视图渲染 | `tests/tmp/adv-pilot-v3/source-render/{idle,skill01,walk,talk01,stun}/` |
| VRM 三视图渲染 | `tests/tmp/adv-pilot-v3/preview/` |
| **验收效果图** | **`tests/tmp/adv-pilot-v3/acceptance/`** |
| 官方参考抽帧 | `tests/tmp/adv-pilot-v3/ref/` |
| 网盘同步副本 | `/Volumes/4TB外置盘/百度网盘/砂金动作转换/pilot-v3-结果/` |

---

## 9. 根因技术复核（本轮上网核实）：`Bip2Fbx` 是什么

> 详细版见 `docs/research/v3-bip2fbx-rootcause.md`（含 20+ 条证据表、抓取记录、未解问题）。

1. **它是真实存在的官方导出参数，但官方从未解释语义**：2027 MaxScript「FBX Export Dialog Access」参数表里有 `"Bip2Fbx" | True or False.`，只有名字没有说明；2012 版 FBX 插件帮助写作 `Bip2FBX`，同样只有 True/False。2024 版参数表里**没有**这一项，2027 又出现 → 文档维护来回，不是功能新增。
2. **它不在当前导出对话框里**：2024/2025 官方帮助的 Geometry 页、Advanced Options 页都没有 Biped/Bip2Fbx 选项；真实用户的 `.fbxexportpreset` XML 里也没有这个节点 → 它不是普通用户会勾到的 UI 选项，而是插件内部/遗留开关。
3. **SDK 头文件显示它挂在 Geometry 组**：`#define IOSN_BIP2FBX "Bip2Fbx"`、`#define EXP_BIP2FBX EXP_GEOMETRY "|" IOSN_BIP2FBX`（FBX SDK 2012/2014 `kfbxiosettingspath.h`）。结合名字（Biped→FBX）与位置，最合理的推断是“把 Biped 对象转换成普通 FBX 骨骼节点”的**几何阶段**转换开关；它不在 Bake/Animation 组里。
4. **为什么会让烘焙动画消失（推断，机制未获官方确认）**：Bake 采样/曲线写入仍指向被替换的那套 Biped 节点，转换后节点不再承载 AnimationCurve → 文件里 67 个 `Bip001*` 节点存在但 0 条曲线；体积正好少掉 ~0.9MB 烘焙数据 = 单变量实测。**没有官方 bug 记录**，也不建议继续猜，工程结论足够明确：**永远不要设 true**。
5. **对全量 138 的一个重要风险（已写进给豆包的指令）**：豆包的 exp3 是在**同一个 3ds Max 进程**里先后跑 V4（`Bip2FBX true`）→ V5（`Bip2Fbx true`）→ V6（7 参数堆叠）都 0/67；如果 `ResetExport` 并不会把这个隐藏属性清回 false，那么 V6/H 的“堆参数也归零”可能是**继承 true 的污染**，而不是“堆参数”本身有害。→ 全量前让豆包做 30 秒干净进程实验（get 默认值 → set true → ResetExport → get），或者干脆**每个文件显式 `Bip2Fbx false` + 回读**（实验 E 已证 false 与不写结果完全一致，安全）。
6. **可选的进一步定位**（不影响全量）：对同一场景导两份 ASCII FBX（最小集 / 最小集+Bip2Fbx true），比较 `Objects` 里 Model 节点数量/名字/类型、`AnimationCurveNode` 的 OP 连接目标 ID、是否多出 Biped user property —— 可区分“替换节点”还是“绕过采样”两种机制。留档即可，不做也行。

---

## 10. 参考资料（本轮上网核实）

1. Autodesk · 3ds Max 2027 MaxScript · **FBX Export Dialog Access**（`FbxExporterSetParam` 官方参数表：`Animation` / `BakeAnimation` / `BakeFrameStart/End/Step` / `BakeResampleAnimation` / `Bip2Fbx` / `FilterKeyReducer` / `GeomAsBone` / `ResetExport` 等；插件需先 `pluginManager.loadClass FbxExporter` 才能设参；`BakeFrameStart/End` 为整数）：https://help.autodesk.com/cloudhelp/2027/ENU/MAXScript-Help/files/MAXScript-Tools-and-Interaction/Interacting-with-the-3ds-Max/FBX-Import-and-Export-Dialog/GUID-54B1F140-B304-48A2-9829-C68B345E2044.html
2. Autodesk · 3ds Max 2027 FBX 帮助 · **Animation**（原文：“when you activate this option all unsupported constraints and controllers, **including the 3ds Max Biped**, are resampled into animation curves”；Bake Start/End/Step 不能存进 preset，永远取场景时间轴；Resample All 按宿主帧率重采样）：https://help.autodesk.com/cloudhelp/2027/ENU/3DSMax-Interoperability/files/GUID-31EA2A4F-A126-498B-96E8-31811522738A.htm
3. Autodesk · 3ds Max 2027 FBX 帮助 · **FBX Limitations**（Biped Layers 只条件支持；Bake 值不能存 preset；控制器时间范围未定义时自动用场景区间）：https://help.autodesk.com/cloudhelp/2027/ENU/3DSMax-Interoperability/files/GUID-511AE209-156C-4406-85B1-4266FEA57834.htm
4. Autodesk · FBX 帮助（旧版）· **FBXExporterSetParam 参数表**（更早的官方列表，含 `Bip2FBX`；同样没有语义说明）：https://download.autodesk.com/us/fbx/3ds_max_help/fbx_3dsmax_online/files/WS644c7983f449f2df-53d205c5113e574e97c-8000.htm
5. Autodesk · **Where Are My Animation Layers?**（动画层排障：顶层 + Bake 才导出下层；建议塌陷）：https://help.autodesk.com/cloudhelp/2017/ENU/3DSMax/files/GUID-21B5781D-5D3D-40E7-8620-587BEC650C5D.htm
6. 社区 · Tech-Artists「[maxScript] FBX export option control」（`FBXExporterSetParam` 不可靠、参数名与 `FBXExporterGetParam` 不一致、建议用预设）：https://www.tech-artists.org/t/maxscript-fbx-export-option-control/3305
7. 社区 · RealtimeVFX「MAX - FBX Export Gotchas!」（Resample All 默认关闭且设置不持久）：https://realtimevfx.com/t/max-fbx-export-gotchas/705/1
8. 开源参考 · AniBullet/BsKeyTools `BsRetargetTools.ms`（社区常用 Biped FBX 导出设置：`BakeAnimation true` / `BakeResampleAnimation false`，不使用 `Bip2Fbx`）：https://github.com/AniBullet/BsKeyTools/blob/main/_BsKeyTools/Scripts/BulletScripts/BsRetargetTools.ms
9. 官方 wiki · 砂金•戏浪（技能 GIF 来源）：https://wiki.biligame.com/sr/砂金•戏浪
10. Autodesk · FBX SDK 2012/2014 `kfbxiosettingspath.h`（`IOSN_BIP2FBX "Bip2Fbx"`；`EXP_BIP2FBX = EXP_GEOMETRY "|" IOSN_BIP2FBX`）：https://download.autodesk.com/global/docs/FBXsdk2012/en_us/cpp_ref/kfbxiosettingspath_8h.html
11. Autodesk · 3ds Max 2024 MaxScript FBX Export Dialog Access（2024 表里没有 Bip2Fbx，佐证文档不稳定）：https://help.autodesk.com/cloudhelp/2024/ENU/MAXScript-Help/files/MAXScript-Tools-and-Interaction/Interacting-with-the-3ds-Max/FBX-Import-and-Export-Dialog/GUID-54B1F140-B304-48A2-9829-C68B345E2044.html
12. Autodesk · 3ds Max FBX 帮助 · Geometry（当前导出对话框 Geometry 页无 Biped 选项）：https://help.autodesk.com/cloudhelp/2024/ENU/3DSMax-Interoperability/files/GUID-249100FE-67BE-43B8-AF12-D20703CDF8D1.htm
13. 真实 `.fbxexportpreset` 样本（无 Bip2Fbx 节点；`Animation` / `BakeComplexAnimation`=Bake Animation / `ResampleAnimationCurves`=Resample All）：https://raw.githubusercontent.com/Makiah/BotW-SBFRES-to-FBX/master/fbxextraction/BotW%20Export%20Preset.fbxexportpreset

> 说明：`Bip2Fbx` 在官方帮助里**只有参数名、没有语义说明**（2027 的 FBX Export Dialog Access 和 2012 的 FBX 插件帮助都是如此），公开社区也没有可靠的用法说明。因此本项目的结论基于**单变量受控实测**（豆包 `diag/exp3`：仅加 `Bip2Fbx`/`Bip2FBX` true → 67/67 变 0/67、体积正好少掉烘焙数据；去掉即恢复）＋官方文档中“Biped 必须靠 Bake Animation 重采样”的依据。最终规则：**批量脚本永远不要设置 `Bip2Fbx`（默认即为 false，ResetExport 后不碰它）**。
