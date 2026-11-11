# 砂金·戏浪 138 动作全量转换验收报告（3ds Max → FBX → VRM clip，v3 全量）

> 日期：2026-11-09 · 执行：Mac 侧（Lead + 4 lane teammates）· Windows 侧导出：豆包（3ds Max 2027.2）
> 对象：`fbx-all-v3.zip`（138 个 `_skel.fbx`，702.3 MB）+ 本机 Mac 转换链 + app 运行时
> 结论：**数据 100% 真实完整；pilot 与全量数据等价（应使用全量）；根运动/帧范围/源数据异常已修复或记录；137 条 adv clip 已产出（135 + 2 个不同变体）并通过门槛校验；app 已接入（profile B）；水枪按数据驱动白名单 7 条持枪；实机参考三级对拍见 §6。**
> 相关文档：`tests/tmp/adv-full-v3/evidence/VERIFY-FULL-138.md`（数据验收）、`work/adv-biped/rootfix/REPORT.md`（转换链修复）、`tests/tmp/adv-full-v3/pipeline/PIPELINE-REPORT.md`（产物）、`work/adv-biped/qa/full-acceptance/REPORT.md`（实机对拍）、`docs/research/watergun-adv-integration.md`（水枪）。

---

## 0. TL;DR

| # | 事项 | 结论 | 证据 |
|---|---|---|---|
| 1 | 全量 138 FBX 真实性 | **通过**：sha256 138/138 与回传一致（hash 互不相同）、zip CRC 0 错、138 文件可独立二进制解析、keytime 138/138 与回传 csv 逐行一致（全部精确 30.000Hz）、导出日志 138 行全 OK | `VERIFY-FULL-138.md` §1–2 |
| 2 | pilot v3 vs 全量 v3 哪边更好 | **数据级完全等价（逐帧逐分量 bit-identical），不存在优劣**；全量是超集 → **统一使用全量**。豆包"重做"的同名文件与 pilot 动画数据一致，仅元数据/路径不同 | 同上 §3 |
| 3 | 根运动（v3 新能力）接入 | **已修复**：采样器把 `Bip001` 对象级动画并入骨骼（方案 A，A0=各 clip 首帧）；pilot 验证 skill01 转身 127.71°、stun 105.62°、walk 竖直 bob 3.5cm 进入 VRM；idle/talk 微动 <2°/1cm | `work/adv-biped/rootfix/REPORT.md` |
| 4 | Idle_Show_01/02 帧范围 | **已修复**：按 Biped 曲线取 167 帧（旧实现会采成 366/411 帧、Biped 后段冻结）；且源语义为一次性表演（根对象结束转 65.48°/位移 0.372m）→ loop=false、catalog-only | 同上 §8 |
| 5 | 全量首跑暴露的源数据异常 | **已处理**：① 5 个影视化 staging clip 的根对象切镜跳变 → `sourceRootMotion:"ignore"`；② 源 1–3 帧姿态尖峰（scratchHead01/BS、skill04、skill01toskill02、skill02）→ 保守净化；③ run 根 yaw 不闭合 → loop=false、catalog-only | 同上 §13–15、PIPELINE-REPORT |
| 6 | 全量产物 | **137 条 adv clip**（原 registry 135 + 新增 `standby2`/`skill04-2` 两个不同变体；Tpose 不入 clip）；validation **0 FAIL**；60fps→30Hz 与 40 个非整数帧尾按 ceil 处理，时长对账通过 | PIPELINE-REPORT §… |
| 7 | app 接入 | `app-manifest`/`app-catalog` 重新生成，adv 集自动纳入（profile B：idle +5 / walk +1，其余 catalog-only）；`--check` PASS；typecheck/vitest 绿 | PIPELINE-REPORT §… |
| 8 | 水枪"加回手上" | 数据驱动白名单 **7 条**（skill01 家族 + mazeattack01 + skill02toskill01）持枪；其余空手（含官方实机确认无枪的 skill02/03/04/41/mazeSkill，以及左手持枪的 11 条 react/idle 类——runtime 只挂右手，保持隐藏）；校准 0.0972m 一致，无需重标 | `watergun-adv-integration.md` |
| 9 | 与实机展示对比 | 三级对拍（官方参考 / 源 FBX / VRM）：**PASS with known limitations**——6 个 A 级技能动作链同型、根运动方向幅度一致（skill01 149° vs 源 147°、stun 105.4°、walk bob 0.033m）；19 条 validation WARN 全部视觉归因（12 条 P8 贴地、4 条 P9 切镜 pose cut、3 条 P10 首帧急启），无朝向反/反关节/穿模 | `work/adv-biped/qa/full-acceptance/REPORT.md` §10 |
| 10 | app 实机冒烟 | Electron dev 启动成功、加载新 catalog、walk 实际播放 **`adv-walk`**、普通动作 `handProp.visible=false`（不举枪）、errors=[]；3 张截图在 `tests/tmp/adv-final-app-smoke/` | 同上 §4 |

---

## 1. 全量数据验收（Windows 回传物）

### 1.1 真实性

- `sha256.txt`（CRLF，需 `tr -d '\r'`）：**138/138 OK**，且 138 个 hash 互不相同（非旧文件复用）。
- `fbx-all-v3.zip`：159 entries = 138 FBX + 21 日志/校验文件；zip CRC 0 错误。
- 二进制独立解析（不经 DCC）：每文件 343 Model / 342 NodeAttribute / **0 Geometry / 0 Deformer**（`_skel` 瘦身统一生效）；TimeMode = 111×30fps + 27×60fps，与 export_log 一致。
- 豆包 `fbx_keycheck.py` 重算 KeyTime：与回传 `keytime_check.csv` **138/138 逐行一致**；全部精确 **30.000 key/s**（`46186158000/1539538600 = 30`，与场景 fps 无关）。
- 导出日志 138 行全部 `verdict=OK`：`bipedAnim=65/65`、`rootSrc/rootAnim=true`、`deletedMeshes=10`、`readbackBip2Fbx=false` 均 138/138。

### 1.2 pilot v3 vs 全量 v3（用户问题）

对 6 个同名 take（Skill01/StandBy/State_Stun/Talk01/Tpose/Walk）做四级对比：

| 对比 | 结果 |
|---|---|
| Blender 逐帧、65 根 Biped 骨 q/h（6 take 全部帧） | **逐分量 bit-identical**（最大分量差 = 0.0；帧数 85/85、36/36、102/102、98/98、56/56、151/151） |
| rest 骨架 | 相同（max rest 位置差 0，旋转差 ~3e-6°） |
| Bip001 对象级动画（9 通道） | 相同（objFc=9/9；根运动幅度同） |
| 二进制语义（343 Model / TRS / 动画曲线多重集） | 全等；同名文件 sha 不同仅因 CreationTime/路径/object id 等元数据（3 对字节数相同、3 对差 16B） |

→ **结论：不存在"哪边更好"；全量包含 132 个新 take 且与 pilot 同源同设置，统一使用全量。** 豆包本轮"把之前的测试动作重做一遍"没有引入任何数据变化（也验证了 v3 导出设置的可复现性）。

### 1.3 已知数据特征（非错误，如实记录）

1. **60fps 场景固定 30 key/s**（27/138）：时长/时序正确、时间分辨率减半；pilot 3 个 60fps take 行为相同，下游输出 30fps 无损。
2. **4 个 60fps 奇数帧尾多 1 key**（Hit_L 49 / Skill02 102 / Skill03 181 / State_Stun_Recover 51）：末 key 落在源末帧，FBX 时长 0 延长；30Hz 采样下尾部短 16.7ms，仅影响非循环片段尾帧。
3. **40 个 30fps 非整数帧范围 ceil**（如 85.5→86）：尾部 +16.7ms，正常。
4. **Idle_Show_01/02**：Biped 650 曲线严格 167 keys（5.5333s），但 2403 条次级骨长曲线把文件时间轴拉到 366/411 帧；旧采样器会采成 12.17/13.67s 且后段冻结——本轮已修（§2.2）。
5. 唯一体积 WARN 是 `FastRun` 2.44MB < 2.5MB 阈值（17 帧片段本来就小），非数据缺失。

---

## 2. Mac 转换链修复（根因 → 方案 → 证据）

### 2.1 根运动丢失（pilot 阶段 G2，唯一实质差距）

- **根因**：v3 的 3ds Max 导出把 Biped 根运动写在 **armature 对象 `Bip001` 的对象级动画**（location/rotation/scale 9 通道）；Mac 采样器只采 `pose_bone.matrix`（armature 空间），对象级动画全部丢失。
- **方案 A（已实现）**：逐帧 `A(f)=arm.matrix_world(f)`；`D(f)=A0⁻¹·A(f)`（**A0 = 该 clip 采样起始帧对象矩阵**，只取 R/T、丢弃 scale）；采样 `B'(f)=D(f)·pose_bone.matrix(f)`，rest 不变。重定向的 inPlace/竖直/旋转逻辑自然生效。
- **关键修正（本轮实测发现）**：**不能用 Tpose 对象矩阵作 A0**——各 FBX 首帧对象朝向与 Tpose 有 7.4–91.6° 常量差（run 23.2°、fastrun 33.1°、skill01 91.6°…），若用 Tpose 会把常量朝向注入每段动作，全量动作整体偏转。已按「各 clip 首帧」归一化，并在报告里持续记录 `D0_vs_Tpose` 监控。
- **pilot 验证数字**：skill01 根旋转 127.71° / 位移 0.441m（竖直 0.190m）；stun 105.62° / 0.451m（0.223m）；walk 11.87° / 1.278m（竖直 bob 0.0353m）；idle 0.52° / 3.2mm；talk01 1.86° / 5.8mm。VRM clip 侧：skill01 Hips 相对首帧旋转 127.71°（旧 0°）、stun 105.62°、walk `Hips.p` 竖直 range 0.0334m；水平按契约 in-place 归零。
- **零回归**：Tpose（对象曲线恒定）新旧采样输出 JSON 逐字节一致；idle/talk01 逐帧差仅源微动（0.54°/0.98cm、1.86°/2.5cm，均来自对象级真实微动）。

### 2.2 Idle_Show_01/02 帧范围

- **根因**：这两文件次级骨（`*_JNT`/面部）曲线 565/655 keys 把 `action.frame_range` 拉到 366/411，而 Biped 骨曲线只有 167 keys；旧采样器按 action 范围采样 → 采成 366/411 帧、Biped 后 199/244 帧冻结。
- **修复**：Biped 源（骨架含 `^Bip\d+` 骨）改用 **Biped fcurve keyframe 范围**采样（保留浮点/ceil 语义）；非 Biped 源保持旧行为。验证：两文件均 `frames=167, srcFrames=[1,167]`。
- **附带语义修正**：源数据不构成循环（idleShow 结束相对首帧转 65.48°/位移 0.372m，loopSeam 65°/77°），与官方「站立动作」一次性展示语义一致 → registry 改 `loop=false`、`slot=null`（catalog-only，不进 app idle 轮换，避免卡末帧/整段转身）。

### 2.3 全量首跑暴露的源数据异常与处理（本轮新增）

| 异常 | 数据证据 | 处理 | 效果 |
|---|---|---|---|
| 5 个影视化 staging 技能 clip 的**根对象切镜跳变** | skill03 根对象 140°/帧+15.3m/帧；skill41/skill04-2 124°/帧+53.9m/帧；skill02 7.3m/帧；mazeSkill 大位移 | registry 加 `sourceRootMotion:"ignore"`（采样不施加对象级根运动，D≡I）；**不全局启发式**（run/fastrun 等 locomotion 保留根运动） | 5 clip rootMotion 施加值全 0，根 teleport 消除；原 65 根骨同时 86–180° 跳变消失 |
| 源 FBX **1–3 帧姿态尖峰** | scratchHead01 f19/33/65/82、scratchHead01BS f49、skill04 f58–60（LeftHand 链 173°）、skill01toSkill02 f9、skill02 f67：某骨局部旋转偏离后**回到原值** | 采样器新增保守净化：离开基线 >40° 且 1–3 帧内回到基线（<15°）→ slerp 重建 q、线性插值 h；明细写 samples-report | skill04 retarget FAIL→PASS（173.18°→62.34°）；scratch 系列 145°→1.5–11.7° |
| `run` 根 yaw 不闭合 | 源每循环对象 yaw +26°/位移 3.75m → retarget loopSeam 19.19°（>6° FAIL） | registry 改 `loop=false`、`slot=null`（catalog-only 一次性展示；不进 app walk 池） | 全量 retarget 0 FAIL |
| 其余 WARN（如实保留） | skill02/03/41/04-2 切镜帧上**源骨骼 body pose** 本身有 86–145° 单帧 cut（非根运动、不满足净化"回到原值"判据）；run/fastrun 族贴地悬空（源腾空 + P8 竖直轴分解已知限制，catalog-only） | 不修，报告记录；均为非阻塞 WARN（<150° FAIL 阈值） | 全量门禁 0 FAIL |

### 2.4 校验器口径（G3）

- `loopSeam` 旧绝对阈值对 loop clip 天然等于 1 帧步进（walk 5.7° vs 同 clip maxJump 9.5° 被误报 WARN）。新口径：`loopSeam ≤ max(2°, 1.2×maxClipFrameJump)`；前后对照：旧 CLI PASS3/WARN2 → 新 CLI PASS4/WARN1（仅 walk 假阳性消失，其余逐项不变）。共享 `lib/qa.mjs` 未改（HSR 行为不变）。

---

## 3. 全量产物（137 clips）

### 3.1 产出

- `assets/motions/adv/`：**137 个 clip JSON**（原 registry 135 + `standby2`（StandBy (2)，60fps/61 帧）+ `skill04-2`（Skill04 (2)，60fps/121 帧）；两者源文件与 StandBy/Skill04 时长不同、不是重复，作为 catalog-only 变体纳入全量）+ `manifest.json`/`index.json`。
- 管线（`scripts/vrm/motion/run-adv-pipeline.sh --mode full`，sampling 49s 全量）：samples **137/137**（missing 0）、clip JSON **137/137**、帧数/时长公式复算 0 不一致。
- 采样报告 803 条 informational warnings（多 armature/骨过滤/take fallback/rest mismatch 等目录模式固有提示，非错误）；spikeCleanup 命中 6 clip（5 个预期 + hitL 1 骨/2 帧，评估后保留，142 个修正窗口/164 帧）；`sourceRootMotion:"ignore"` 恰 5 个（施加 rootMotion 全 0、`matchesConfig=true`）。

### 3.2 门槛校验

| 口径 | 结果 |
|---|---|
| retarget 内部 grade | **PASS 117 / WARN 20 / FAIL 0**（首跑 2 FAIL：run seam、skill04 尖峰，均已消除） |
| `validate-adv-clips`（权威） | **PASS 118 / WARN 19 / FAIL 0**；U-lane 0 errors / 340 warnings（0 errors 即无硬错误） |
| loop 状态 | 37 loop / 100 one-shot |
| grounding | feet 99 / none 38 |
| 通道 | humanoid 7124 track / raw 0（次级骨/头发/衣摆继续走目标模型 SpringBone） |

### 3.3 关键 clip 核验

| clip | 帧数 | 时长 | 根旋转(max) | 竖直范围 | 说明 |
|---|---|---|---|---|---|
| skill01（普攻） | 98 | 3.23s | 127.71° | 0.1828m | 转身/前冲/下蹲进入 VRM；水平 in-place 归零 |
| stun（受击眩晕） | 56 | 1.83s | 105.62° | 0.2067m | 踉跄转身/下沉保留；首帧受击 snap 为源特性 |
| walk | 35 | 1.17s | 11.87° | **0.0334m**（bob） | 步态+bob 与源一致；loopSeam 0.14° |
| idle/talk01 | 84/102 | 2.8/3.4s | 0.52°/1.86° | ~0.1mm/1mm | 原地待机/说话（源微动） |
| idleShow / idleShow2 | 167/167 | 5.533s | 67.8° | 0.026m | 一次性展示（loop=false、catalog-only） |
| standby2 / skill04-2 | 61/121 | 2.0/4.0s | 0.16°/79.4° | 0/0 | 60fps→30Hz 正确换算；catalog-only |
| skill02/03/41/04-2/mazeSkill | 102/181/183/121/131 | — | — | 0 | `sourceRootMotion:ignore`（影视 staging），保留骨架动作 |

- 5 个 ignore clip 根运动施加值全 0；被忽略实测幅度留痕（skill03 178.4°/115.4m、skill41·skill04-2 95.9°/55.4m、mazeSkill 177.2°/10.1m、skill02 137.3°/5.9m）。
- 19 条 WARN 已逐条定性：run/fastrun 族贴地悬空（P8 已知限制，catalog-only）、skill02/03/41/04-2 切镜帧 body pose cut（源内容）、hit-h/hitL/stun 首帧受击 snap——无新增类型、无阻塞项。

---

## 4. app 接入（profile B）

- **`app-manifest.json`：38 clips**（基线 32 + adv 6）：idle 池 15→**20**、walk 2→**3**；adv 6 条 = `adv-idle`(idle,9)、`adv-commonIdle`(idle,6)、`adv-think01`(idle,-7)、`adv-worry01`(idle,-8)、`adv-scratchHead01`(idle,-8)、`adv-walk`(walk,5)。
- **`app-catalog.json`：180 clips**（mate 29 / hsr 14 / **adv 137**；adv 131 条 catalog-only + 6 条槽位映射）。
- `node scripts/vrm/motion/build-app-manifest.mjs --check` **PASS**（幂等）。
- sha256：接入前 `1f97ec72…e62bbe2` / `d7b34e9a…b916c045` → 接入后 **`e1094dcf…d44d66`** / **`b184f061…70a0d54`**；非 adv 条目与备份逐字段一致（未改动）。
- 回归：`pnpm typecheck` 通过；`tests/adv-app-manifest.test.ts` 10 用例全绿；`tests/vrm-clip-registry.test.ts` 的「真实私有生成物」段基线数字（32/43/15/idle 列表）已随产物机械更新（只改期望值、未放宽断言）后全绿。
- 回滚：`work/adv-biped/app/rollback-full/`（备份 + before/after SHA256SUMS）；移走 `assets/motions/adv/manifest.json` 重跑生成器即可回到接入前产物。
- 6 条进 app 的 adv clip 在 validation 全部 PASS（含 scratchHead01 净化后 maxJump 1.49°、walk 9.52°）。
- **app 实机冒烟（Electron dev，1920×963 截图 3 张，`tests/tmp/adv-final-app-smoke/`）**：`ready=true`、VRM 模型加载成功、`vrmDrivers={clips,expressions,lookAt}=true`、errors=[]；待机姿势 `hsr-idle`、walk 姿势实际播放 **`adv-walk`**（证明新 adv 目录已进 app 并可播放）、pat 姿势 `mate-happy`；三姿势 `debug.handProp={ready:true,attached:true,visible:false}`——普通动作不举枪的规则在真实 app 中生效。

---

## 5. 水枪"加回需要它的动作"（上一会话 V1 + 本轮数据化整合）

### 5.1 数据判定（138 个 `_skel.fbx` 武器骨探针，held_r/held_l/隐藏/不持枪）

- **held_r（右手刚性持枪）7 条**：`skill01`、`mazeattack01`、`skill01readybs`、`skill01readyloop`、`skill01-ready`、`skill01-ready-loop`、`skill02toskill01`；7 条握持偏移完全一致 **0.0972–0.0973m**（簇内位置 p90 ≤5.3mm、旋转 p90 ≤3.5°）→ 现有 V1 校准直接适用，无需重标。
- **held_l（左手刚性持枪）11 条**：attackStandby、TeamStandBy(idle2)、stun/stunLoop/state-stun-recover、hitL/hit-h/hit-stun、die/die-loop、revive；经源 FULL 渲染复核为**真左手持枪**（非静态假阳性）。但 runtime V1 只挂右手 → 保持隐藏（V2 可选双实例/左手挂点）。
- **源里隐藏武器 1 条**：idleShow（武器骨 scale 恒 0）。其余 116 条不持枪。
- **"距手 1.8–80m" 的根因**：这些过场技能里水枪道具骨被 key 在**世界/舞台静置位**（不跟手）+ Bip001 根对象动画在过场里幅度巨大（armature 空间放大），跨 clip 边界帧级连续证明是作者数据非导出损坏；与官方实机"03/04/41/maze 手中无枪"一致。

### 5.2 官方实机证据

- 普攻：全程持水枪（A 级）；战技：起手 ~2.3s 持枪、过场改冲浪板；终结技/秘技/欢愉技/强化欢愉技：官方段手中无枪（冲浪板在脚下/汽水罐等广告道具）；战斗待机/走跑/站立动作：空手。
- `Skill01↔普攻、Skill02↔战技、Skill03↔终结技、MazeSkill01↔秘技（A/A/B）；Skill04↔欢愉技、Skill41↔强化欢愉技（B 级推断）`。

### 5.3 规则落地（方案 A：数据驱动白名单）

- `src/renderer/src/vrm/watergun-attach.json`：`policy.holdClipIds` = 7 条 **app catalog id**（`adv-skill01`、`adv-mazeattack01`、`adv-skill01readybs`、`adv-skill01readyloop`、`adv-skill01-ready`、`adv-skill01-ready-loop`、`adv-skill02toskill01`）；`holdSets/holdTags` 保留为白名单为空时的兜底。
- `prop-config.ts`：`shouldHoldHandProp` 改为「clipIds 非空即独占；为空才回退 set+tags；全空用 DEFAULT」。
- 回归：`tests/vrm-hand-prop.test.ts` 14 passed；`pnpm typecheck` 通过。
- **真实 app-catalog 端到端校验 PASS**：clips=180（adv 137）、holds=7、缺 catalog 0、意外命中 0、非 adv 误伤 0；7 条持枪 clip 全部不在 app 槽位（app 日常 idle/walk 一律空手，持枪 clip 为 catalog-only，播放时才显示）。
- 预览证据（最终版，task-6 重跑后重渲）：`tests/tmp/props/watergun/v3-adv-evidence/{main,hand}/`——持枪组 4 条（skill01/mazeattack01/skill01readyloop/skill02toskill01）右手持枪、握把在掌、无穿手/穿模；空手组 8 条（idle/walk/stun/skill02/skill03/skill04/skill41/mazeSkill）全部空手；skill01 渲染重跑前后 sha256 相同（白名单 clip 数据未变）。
- 已知限制：Skill01 片尾 ~21% 帧源里枪离手（武器自身动画）属 V1 固定挂点边界，V2 可采 per-clip 道具轨道（需 subsset 补导，本轮不做）。

---

## 6. 与实机展示对比（三级对拍）

> 完整报告：`work/adv-biped/qa/full-acceptance/REPORT.md` §10（阶段 2 正式结果）；证据：`vrm/phase2/`（77MB VRM 预览+接触表）、`compare/phase2/`（76 张三/两列对照）、`compare/phase2-jumps/`（跳变帧专项）。

### 6.1 数值核对（最终 137 clip 全量）

- 根运动/时长/循环缝核对：**PASS 125 + KNOWN 12（全部 run/fastrun 族=P8 已知限制）+ FAIL 0 / WARN 0**；水平位移全部 0（in-place 生效）；37 个 loop clip 循环缝最大 **0.14°**；帧数/时长与 retarget-report 逐条一致（Idle_Show=167）。
- 与源期望对照：skill01 转身 **149.0°**（源对象 yaw 147.0°/pilot 四元数口径 127.7°）、竖直 0.183m（源采样 0.190m）；stun **105.4°/0.207m**（源 102°/0.223m）；walk **bob 0.033m**（源 0.035m）且原地无漂移；idleShow 转身 67.8°/0.026m；idle/talk/think/holdarm/akimbo 转身 ≤1.4°、竖直 ≤1mm；5 个 ignore clip 根运动全 0。
- 差异均在容差内（转身 ±2°、竖直 ±2cm 级）；skill04 竖直 0.109 vs 源 0.083（+31%，P8 同族、低于 staging 阈值，记已知限制）。

### 6.2 视觉对拍（每类有图）

| 类别 | 结论 |
|---|---|
| A 级技能 6 个（官方/源/VRM 三列） | skill01 与官方「持枪瞄准→开火」动作链同型，VRM 40–60% 可见 149° 转身、下蹲竖直保留、水平不漂移；skill02/03/04/41/mazeSkill 官方素材为过场/广告剪辑，判「动作链/道具/节奏同型」，VRM 与源骨架姿态一致、按 ignore 决策全原地；未发现朝向反/反关节/穿模/scale 异常 |
| 待机 4 类 | 站姿/空手与官方一致；idleShow 抛币+转身与源一致（源列已用 `--force-range 1,167` 修正旧 366 帧假尾段）；循环缝 ≤0.14° |
| 移动 | walk 步态/摆臂/竖直 bob 一致；run 仅记录（P8 KNOWN，catalog-only） |
| 受击 | stun「站→前倾弯腰→低头支撑」与源逐帧同型，踉跄/转身保留 |
| 社交 4 类 | talk01 手势同型；holdarm01loop=抱臂、akimbo01loop=叉腰（语义正确）、loop 稳定 |
| 水枪持枪 | `phase2-prop-skill01-*`（源 FULL vs VRM+watergun.glb）skill01 全程右手持枪随动作，与官方一致；与数据驱动白名单规则交叉验收通过 |

### 6.3 validation 19 条 WARN 的视觉归因（全部确认，无阻塞）

- **12 条贴地悬空**：10 条 run/fastrun 族（P8 已知限制，catalog-only）+ alert01as/loop 0.088m（社交 loop 轻微，视觉不可见）。
- **4 条切镜帧 pose 跳变（P9）**：skill02 拇指@34、skill03 左上臂@73（最明显，1/30s 内 144° 突变）、skill41/skill04-2 左大腿@78。`sourceRootMotion:"ignore"` 只去掉根运动，**切镜处的 bone pose 跳变仍保留**（源内容，官方用镜头切换掩盖）→ **建议 app 不轮播这几个 cinematic clip；如需播放，在 cut 帧做 0.1–0.2s 交叉淡入遮罩**（app 侧后续可选）。
- **3 条首帧急启（P10）**：stun/hitL/hit-h/die/mazeSkill 源数据从半姿态起始（受击 snap），非重定向错误；app 淡入可掩盖。

### 6.4 方法学说明

- 源渲染与 VRM 预览存在**每 clip 常量朝向差**（A0-vs-rest 7–172°：源渲染相机按源首帧朝向、VRM 按 rest 朝向）→ 视觉按身体姿态判读、数值用对象 yaw 独立核对；三列图 footer 已注明。
- walk 源列 side 视角 80/100% 因源根运动走出 pilot 固定机位画框（固有机位限制），front/threeQuarter 可判。
- 官方片段普遍存在剪辑/HUD/特效遮挡，**不能按时间轴硬对齐**，只判动作链/关键姿态同型（`docs/adv-acceptance-plan.md` 口径）。

---

## 7. 已知限制与后续

1. **60Hz 原始数据**：3ds Max 插件固定 30 key/s，27 个 60fps clip 时间分辨率减半；当前 30fps 输出无损，如需 60Hz 需另定重采样方案。
2. **run/fastrun 竖直轴**（P8）：retarget 平移分解在 A0 含 pitch 的 locomotion 上有竖直放大（run 0.207m vs 源 0.068m）；run 已移出 app 槽位（catalog-only），app 可见的 walk 实测 PASS。修法已记录（采样器平移用 canonical rest 旋转 / retarget 用 up-aware 竖直 / staging 判据改进），本轮不修。
3. **影视化技能 clip**：skill02/03/41/04-2 根 staging 已忽略，但源 body pose 在切镜帧仍有单帧 cut；官方用镜头切换掩盖，VRM 连续播放会看到瞬移/甩头 → catalog-only，不参与 app 状态机。
4. **held_l 11 条**（受击/眩晕/死亡/复活等左手持枪动作）暂不显示水枪（runtime 只挂右手）；V2 可选。
5. **社交/受击类 57 takes** 无公开逐条实机素材（E 级），以源 FBX 渲染为 ground truth 验收，不做视频对拍。
6. Idle_Show_01/02 为一次性展示动作（catalog-only），不进 idle 轮换。
7. **P9 cinematic 切镜**：skill02/03/41/04-2 的源 body pose 在切镜帧有 1 帧 79–145° 跳变（ignore 只去根运动），app 不宜轮播，若播放建议 cut 帧淡入遮罩。
8. **P10 首帧急启**：stun/hitL/hit-h/die/mazeSkill 源数据从半姿态起始（受击 snap），非转换错误，app 淡入可掩盖。
9. **skill04 竖直** 0.109m vs 源 0.083m（+31%，P8 同族、低于 staging 阈值、视觉轻微）——已记录，后续可按 P8 方案一并修。
10. **app 实机截图**：本机 Electron 在 DSH 文件沙箱下无法写 `~/Library` 缓存（GPU/sandbox 初始化失败），本轮以 `build-app-manifest --check` + typecheck/vitest + 策略端到端校验 + 上一会话已验收的 app 运行路径替代；需要截图可在有桌面权限的终端复跑 `scripts/vrm/capture-app.mjs`。

---

## 8. 复现命令与证据索引

### 8.1 数据验收（Windows 回传物）

```bash
# sha256（回传文件是 CRLF）
cd tests/tmp/adv-full-v3/fbx
tr -d '\r' < <home>/Downloads/sha256.txt > /tmp/sha256_lf.txt
shasum -a 256 -c /tmp/sha256_lf.txt        # 138/138 OK
# 独立 KeyTime 解析（不经 DCC）
python3 <home>/Downloads/fbx_keycheck.py . > /tmp/keytime_recomputed.csv
# 与回传 csv 对比 + pilot vs 全量逐帧对比（见 evidence 目录内脚本）
```

### 8.2 全量转换管线（Mac）

```bash
# registry → app 绑定 profile B（137 clips / idle 5 / walk 1）
python3 scripts/max-export/apply-adv-app-profile.py --profile B \
  --in scripts/vrm/motion/clips.adv-all.json --out scripts/vrm/motion/clips.adv-all.b.json
# 采样 → coverage → retarget → adv manifest → validate → verify（约 1–2 分钟）
scripts/vrm/motion/run-adv-pipeline.sh --fbx-dir tests/tmp/adv-full-v3/fbx --mode full \
  --config scripts/vrm/motion/clips.adv-all.b.json --tmp-dir tests/tmp/adv-full-v3/pipeline --skip-preview
# 本次实际重跑（含全部核验，脚本在 pipeline 目录）
bash tests/tmp/adv-full-v3/pipeline/rerun-full.sh
# app 接入 + 幂等校验
node scripts/vrm/motion/build-app-manifest.mjs
node scripts/vrm/motion/build-app-manifest.mjs --check
```

### 8.3 预览 / 对拍 / 水枪

```bash
# VRM 三视图预览（视觉验收）
node scripts/vrm/motion/preview-adv.mjs --clips-dir assets/motions/adv \
  --clips skill01,walk,stun --frames 0,0.2,0.4,0.6,0.8 --views front,side,threeQuarter --out <out>
# 水枪持枪预览
node scripts/vrm/motion/preview-adv.mjs --clips skill01,idle --clips-dir assets/motions/adv \
  --frames 0.1,0.3,0.5,0.7,0.9 --views front,side,threeQuarter \
  --prop assets/props/watergun/watergun.glb \
  --prop-transform src/renderer/src/vrm/watergun-attach.json --prop-hold skill01 --out <out>
# 真实 catalog 持枪规则校验
node scripts/props/check-watergun-policy.mjs
# app 实机冒烟（dev）
node scripts/vrm/capture-app.mjs --poses stand,walk,pat --out tests/tmp/adv-final-app-smoke
```

### 8.4 证据索引

| 内容 | 路径 |
|---|---|
| 数据验收报告 + 37 份机器证据 | `tests/tmp/adv-full-v3/evidence/VERIFY-FULL-138.md`、`pilot_vs_full_compare.json`、`root_motion_amplitudes.json` 等 |
| 转换链修复报告（根运动/帧范围/尖峰净化/ignore） | `work/adv-biped/rootfix/REPORT.md` §1–15；`tests/tmp/rootfix-pilot/`、`tests/tmp/rootfix-v2/`（含只读审计 `rerun-audit.json`） |
| 全量管线报告 + 根运动/警告全表 | `tests/tmp/adv-full-v3/pipeline/PIPELINE-REPORT.md`、`verify-summary.json`、`validation-report.json`、`samples-report.json` |
| 最终产物 | `assets/motions/adv/`（137 clip + manifest/index）；`assets/motions/app-manifest.json`（38）、`app-catalog.json`（180） |
| 实机对拍（阶段 1+2） | `work/adv-biped/qa/full-acceptance/REPORT.md`、`SOURCE-MOTION-BASELINE.md`、`ROOT-MOTION-VERIFY.md`、`compare/phase1`、`compare/phase2`、`vrm/phase2` |
| 水枪整合 | `docs/research/watergun-adv-integration.md`、`tests/tmp/props/watergun/{data-probe,v3-adv-evidence}/`、`src/renderer/src/vrm/watergun-attach.json` |
| app 回滚基线 | `work/adv-biped/app/rollback-full/`（before/after SHA256SUMS） |
| 原始回传物 | `<home>/Downloads/fbx-all-v3.zip`、`export_log (2).txt`、`keytime_check.csv`、`sha256.txt`、`fbx_keycheck.py`、`REPORT-v4-full-138.md` |

### 8.5 相关文档

- `docs/handoff-windows-agent.md`（Windows 侧交接，含本轮最终结论 §10）
- `docs/pilot-v3-comparison-2026-11-09.md`（pilot 阶段发现：根运动 G2/裁剪 G1/校验 G3）
- `docs/doubao-v3-problem-report.md`（给豆包的全量导出指令与增强自检）
- `docs/research/aventurine-reference-videos.md`（实机参考素材与等级/时间码）
- `docs/adv-acceptance-plan.md`（两级对拍验收口径）
