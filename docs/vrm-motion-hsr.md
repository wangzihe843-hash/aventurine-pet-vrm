# V3：HSR 官方动作 → VRM 动作管线（Wave 1 · 动作资产泳道）

- 日期：2026-11-08 · 状态：**V3.1 已按规范 T-pose VRM 重跑 + QA 全绿**（14 clip）
- 目标：把用户提供的 HSR 官方砂金 FBX（`Avatar_Aventurine_00.fbx`，135 个 60fps take）
  重定向到项目 VRM，作为第二个动作源接入动作资产管线。
- 当前目标模型：`assets/vrm/aventurine-tpose.vrm`（**W1.5-Tpose 重制**，commit `404a4f4`）：
  VRM 1.0 规范 T-pose / 面向 +Z / 左手 +X / 53 humanoid 骨（**无 upperChest**，含 30 手指+toes+eyes）/
  SpringBone 50 链 + 175 collider / 95 表情；旧 A-pose 资产 `aventurine-waveflair-legfix.vrm` 保留可回滚。
- 产物：`assets/motions/hsr/**`（私有，gitignore）+ 工具链 `scripts/vrm/motion/**`（提交）。
- 证据：`tests/tmp/hsr-motion/`（私有）——采样、retarget 报告、QA 报告、14 条 clip
  三视角+手脚特写接触表、官方源对拍图。
- 关联：`docs/vrm-tpose-repair.md`（T-pose 重制）、`docs/wave15-report.md`（U-lane 22 骨动作）、`PLAN.md` §5。

---

## 0. 摘要（V3.1，目标 T-pose）

| 项 | 结果 |
|---|---|
| 动作源 | HSR 官方 `Avatar_Aventurine_00.fbx`：135 take / 60fps / 236 骨；其中 **29 条全身 take**（23 战斗待机/技能 + 6 Adv 待机/破韧表演），54 条 Adv locomotion take 只有次级动画（无身体骨骼） |
| 选片 | 14 条（idle/表演/破韧/技能/受击），见 §3 |
| 重定向 | world-rotation-delta → three-vrm normalized humanoid 空间；**52 骨**（22 核心 + 30 手指） |
| 目标适配 | 对齐 `R_align = identity`（T-pose 面向 +Z）；目标缺 upperChest → `spine←Spine1_M / chest←Chest_M`；`UpperChest` 轨道写 identity 保 22 骨契约 |
| rest 方向修正 | 手臂/手/手指 36 骨 per-bone swing 修正（上臂 54.6° / 前臂 54.8° / 手 51.1° / 手指最高 88.4°） |
| 次级骨 | **raw 留空（rawPolicy=spring）**：新模型自带 SpringBone 50 链/175 collider，由 three-vrm 物理驱动头发/衣摆/袖带/裤腿 |
| Grounding | idle 组按脚骨世界高度逐帧补偿（相对首帧）；残差 0.4–2.2cm（见 §7 已知限制） |
| QA | 本管线 `validate-hsr-clips`：**PASS 11 / WARN 3 / FAIL 0**；Wave 1.5 `clip-validation` 复核：**0 errors**（430 warnings 仅来自扩展手指骨） |
| 动作正确性 | 与 HSR 官方源渲染逐帧对拍（§5）；上一轮报告的 4 个问题（手离身体/膝盖/头/手指怪）全部修复 |
| 测试 | `tests/vrm-motion-*.test.ts` 27 用例；`pnpm test` 全绿；`pnpm typecheck` 0 |
| 授权 | 官方游戏资源：**仅本机私有、禁止再分发/商用/提交 git** |

历史：V3.0（commit `b2aee1f`）按旧 A-pose legfix VRM 标定的 14 条 clip 已归档到
`assets/motions/hsr-apose-legacy/`（gitignore，回滚用）；模型切 T-pose 后旧数据不可用（见 §1.3）。

---

## 1. 背景与两次根因

### 1.1 V3.0：A-pose 目标与世界 delta 法的常偏转（已随模型切 T-pose 解决）

旧 A-pose VRM 手臂 rest 下斜 39.6°，而 HSR 源 rest 下斜 54.6°；世界 delta 法
`target_pose = D_target · target_rest` 在两侧 rest 方向不一致时会保留一个**常量角偏差**：

- 上臂/前臂 15°、手 19.9°、手指 20–38°；
- 后果：垂手姿势接近 A-pose、手腕相对躯干偏 11–12cm → 手离身体/膝盖/头远、手指方向怪。
- 修复：rest 方向修正（本版保留）——对每根骨求
  `C_b = swing(target rest dir, R_align · source rest dir)`，再 `D_fixed = D_target · C_b`。

### 1.2 W1.5-Tpose：目标换成规范 T-pose + 朝向/层级变化

- 手臂 rest 从下斜 39.6° 改为**水平**（T-pose 规范：掌心向下/四指伸直/拇指 45°）：
  rest 方向差扩大到 54.6°（上臂）/ 54.8°（前臂）/ 51.1°（手）/ 70–88°（手指）——
  不做 rest 修正时，新模型上手腕偏差 **0.37–0.45m**。
- HSR armature → VRM scene 的对齐从 180° yaw 变成 **identity**（都面向 +Z/左手 +X）。
- `humanoid`：54 → **53**（VRMify 没有 upperChest；有 eyes/toes；53 = 21 核心 + 30 手指 + 2 eyes）。
- 躯干：hips=`下半身`(1.066m)、spine=`上半身`、chest=`上半身2`；旧 `upperChest` 的旋转必须合并进 chest。
- 层级：VRMify 合并了 MMD 付与骨（足D 等），腿链 humanoid 直接挂在 hips 下；新增 raw `上半身1`。
- 次级骨：MMD 物理转 SpringBone 50 链/175 collider；raw 层级被折叠成 root→…_tail，旧 chain 映射不再适用。

### 1.3 影响面

- 旧 14 条 V3.0 clip 全部作废（对齐轴、目标 rest、upperChest、hips 语义/缩放都变了）。
- `Hips` 缩放基准：旧 `0.714/0.950=0.752` → 新 `1.066/0.950=1.122`。
- raw：目标有 SpringBone，raw 节点本身是 spring joints；three-vrm `VRM.update()` 先 humanoid
  后 spring，若在之前写 raw 会被 spring 覆盖 → **V3.1 采用 rawPolicy=spring（raw 留空）**。

---

## 2. 数据格式（clip JSON）

与 Wave 1.5 的 clip JSON 兼容（同字段、同 `gltf-rh`、`r` 为相对归一化 rest 的四元数），字段：

```jsonc
{
  "version": 1, "clip": "idle", "mood": "idle", "loop": true,
  "fps": 30, "duration": 2.0, "sourceHeight": 1.839, "sourceHipsHeight": 0.9502,
  "space": "gltf-rh", "frames": 60,
  "targetVrm": "assets/vrm/aventurine-tpose.vrm", "targetAvatarId": "aventurine-waveflair",
  "grounding": "feet",              // feet | none（数据已烘焙竖直 grounding）
  "rawPolicy": "spring",            // spring（目标自带 SpringBone，raw 留空）| baked（旧无 spring 资产）
  "sourceClip": "…Ani_StandBy…", "avatar": "HSR-Avatar_Aventurine_00",
  "bones": {
    "Hips": {"r": [[x,y,z,w],…], "p": [[dx,dy,dz],…]},   // 22 核心（含脚趾；UpperChest 见下）
    "LeftHand": {"r": …},
    "LeftThumbMetacarpal": {"r": …}, …                   // + 30 手指
  },
  "rawMeta": {"mapped": 0, "mode": null, "policy": "spring"}
}
```

约定与坑（lib 已处理）：
- 四元数 `[x,y,z,w]`，单位化、连续化；`r`/`p` 支持嵌套或平铺。
- **Hips.p**：米、in-place（水平归零）。垂直语义由 `hipsBase` 决定（registry 可按 clip 覆盖）：
  - `first-frame`（默认，站立/locomotion）：已减首帧基准，首帧=0；过场 staging 位移 >0.5m 整段归零；
  - `rest`（跪/趴/起身/受击，如 `stun`/`hitL`/`breaked`/`revive`）：相对**源 rest 髋高**的绝对偏移
    （首帧不为 0，可表达「整体停在更低高度」）；staging 阈值 1m（真实起身/倒地 ≤1m）。
  玩家按 `normalizedRestPose.hips.y / sourceHipsHeight` 缩放（新模型 ≈1.122）。2026-11-09 修复了
  「误裁受击首帧 / 跪姿丢绝对髋高 → 腰部固定起跳蜷缩」，详见 `docs/research/stun-break-hips-fix.md`。
- **缺 upperChest 的目标**：clip 仍写满 22 骨契约；`UpperChest` 轨道为 identity（播放器按
  humanoid 名取不到该节点时应**跳过**）。上胸旋转折进 `Chest`（HSR Chest_M 世界旋转），
  `Spine` 承担 Spine1_M（HSR Spine2_M 的局部旋转因此并入 chest 的绝对旋转——3 骨近似，见 §7）。
- **rawPolicy=spring**：播放器不要期待 `raw`；three-vrm 在 `vrm.update(delta)` 中自动更新
  SpringBone，**必须按真实帧率传 delta**（不能一次跳过很多帧，否则头发/衣摆物理不收敛）。
- 朝向：目标规范面向 +Z（`vrm-manifest.yawOffsetDeg=0`）；预览/播放器相机在 +Z 侧。
- 应用顺序（V5 player）：写 normalized humanoid（含 Hips.p）→ `humanoid.update()` →
  `vrm.update(delta)`（spring/lookAt）；若将来用 rawPolicy=baked，raw 需在 `vrm.update` 之后写或禁用 spring。

---

## 3. 动作选片（14 条）

来源 take 均为 HSR 官方 `Avatar_Aventurine_00.fbx`；registry 见 `scripts/vrm/motion/clips.hsr.json`。

| id | 来源 take | 帧数/时长 | loop | slot | grounding | 用途 |
|---|---|---|---|---:|---|---|
| `idle` | `Ani_StandBy` | 60 / 2.0s | ✓ | idle | feet | 战斗待机呼吸循环（主 idle） |
| `idle2` | `Ani_TeamStandBy` | 60 / 2.0s | ✓ | idle | feet | 队伍待机 |
| `idleShow` | `Adv_Ani_Idle_Show_01` | 310 / 10.33s | ✓ | idle | feet | 官方「站立动作」（抬手→双臂张开） |
| `idleShow2` | `Adv_Ani_Idle_Show_02` | 357 / 11.9s | ✓ | idle | feet | 官方第二套站立动作 |
| `commonIdle` | `Adv_Ani_Common_IdleShow` | 251 / 8.37s | ✓ | idle | feet | 公共待机表演 |
| `breaked` | `Adv_Ani_Break01Loop` | 80 / 2.67s | ✓ | null | none | 破韧趴跪循环（可由状态机映射受伤/躲藏） |
| `skill01/02/03` | `Ani_Skill01/02/03` | 67 / 61 / 240 | – | null | none | 战技/终结技表演（展示触发） |
| `mazeSkill` | `Ani_MazeSkill01` | 90 / 2.97s | – | null | none | 秘技 |
| `passiveSkill` | `Ani_PassiveSkill` | 117 / 3.87s | – | null | none | 天赋动作 |
| `hitL` | `Ani_Hit_L` | 48 / 1.57s | – | null | none | 受击（可映射 dshError/拖拽反应） |
| `stun` | `Ani_State_Stun` | 55 / 1.8s | – | null | none | 眩晕反应 |
| `revive` | `Ani_Revive` | 46 / 1.5s | – | null | none | 起身/复活 |

覆盖：`idle`×5、`show`×8、`skill`×5、`react`×3、`pose`×1（`breaked` 另有 `weak` tag）。

### 3.1 未采用的 take（原因）
- **54 条 Adv_Ani locomotion**：FBX 里只有 182 根**次级骨**曲线（头发/衣摆/脸骨），**无身体骨骼动画**，不能作为独立动作。
- **17 条 `Emo_*`**：脸骨动画，不能直接驱动 VRM expression（V6 负责）。
- **33 条 `Monster_W3_*`**：Boss 形态，宠物主线不用。

---

## 4. 实现要点

1. **Blender in-between patch**：HSR FBX 带 Maya 式 in-between shapes，Blender 4.2 legacy importer 直接
   raise；导入前 monkey-patch `blen_read_shapes` 跳过（形态键丢弃，骨架/动画完整）。Blender 4.5+ ufbx 原生支持。
2. **坐标对齐 R_align**：由 rest 骨几何构造（肩轴 + 髋/胸 up 轴），旧 A-pose 资产=180° yaw、新 T-pose=identity；
   **目标缺 upperChest 时用 chest 位置定义 up 轴**（fallback 已在 `buildAlignment` 内）。
3. **目标感知 humanoid 映射**（`resolveHumanoidMapping`）：
   - 目标有 upperChest：chest←Spine2_M、upperChest←Chest_M；
   - 目标无 upperChest（新 T-pose）：spine←Spine1_M、**chest←Chest_M**；clip 里 UpperChest=identity。
4. **rest 方向修正**（`lib/rest-direction-fix.mjs`）：对 upperArm/lowerArm/hand + 30 手指求
   `C_b = swing(v_target_rest, R_align·u_source_rest)`，`D_fixed = D_target·C_b`；阈值 0.5°。
   实测修正 36 骨：上臂 54.6°/前臂 54.8°/手 51.1°/手指 mean 76.8° max 88.4°；修正后
   手腕相对躯干误差 1.0–1.3cm、掌心法线 3–6.6°（VS 修正前 0.37–0.45m / 28–35°）。
   不修躯干（差异 ≤0.6°）与脚/脚趾（14° 是 足先EX 骨语义差异，修了会穿地）。
5. **归一化父级**：对每根 humanoid 骨沿 raw parent 链找最近 humanoid 祖先作为父级（legfix 前后资产、T-pose 资产都适用）。
6. **手指**：30 根全部由 humanoid 归一化旋转驱动。
7. **Grounding**：归一化骨架正解算脚骨世界高度，逐帧平移 hips 竖直分量；保持首帧 p=0 约定
   （只施加相对首帧补偿，残差为常数，见 §7）。
8. **参考帧裁剪**：部分战斗 take 首帧是 T-pose 参考帧（首→次帧多数骨 45°+ 跳变），自动丢弃（最多 2 帧）。
9. **In-place**：水平位移归零；`skill03/passiveSkill` 过场 staging 竖直位移（16m/7.4m）整段归零，只保留旋转。
10. **次级骨策略（V3.1）**：目标模型自带 SpringBone → raw 留空（rawPolicy=spring），
    头发/衣摆/袖带/裤腿由 three-vrm 物理驱动；旧无 spring 资产仍支持旧 chain 映射（`--raw map`，V3.0 管线保留）。
11. **预览**：`preview-hsr.mjs` 按 manifest yaw 朝向、相机 +Z 侧、SpringBone 按 delta 从 0 帧步进
    （静帧抓图也能看到头发/衣摆物理状态）。

---

## 5. 动作正确性核对（官方源对拍，V3.1）

证据：`tests/tmp/hsr-motion/evidence-tpose/`
- `verify-official-pose-tpose.jpg`：standby / idleShow / commonIdle 的 **HSR 官方源渲染 vs 新 T-pose VRM**
  同帧（0/20/40/60/80%）对照：举手待机、双手张开、自然垂手均一致。
- `verify-4issues-tpose.jpg`：上一轮 4 个问题的官方源 vs 新输出特写：
  1. commonIdle 垂手（不再 A-pose 外张）；
  2. breaked 手搭膝盖；
  3. stun 手掌盖脸；
  4. passiveSkill 手指/手位（不再反向张开）。
- `before-after-apose-vs-tpose.jpg`：旧 A-pose 输出 vs 新 T-pose 输出同 clip 对照。

→ 结论：**动作选片、方向与手部接触语义与官方源一致**；A-pose 常量偏转问题已消除。

---

## 6. QA 结果（V3.1，`tests/tmp/hsr-motion/validation-report.json`）

| clip | 帧 | humanoid | raw | maxJump | loopSeam | 贴地误差(m) | 状态 |
|---|---:|---:|---:|---:|---|---|
| idle | 60 | 52 | 0(spring) | 0.23° | 0.07° | +0.0218 | PASS |
| idle2 | 60 | 52 | 0(spring) | 0.30° | 0.10° | +0.0218 | PASS |
| idleShow | 310 | 52 | 0(spring) | 22.19° | 0.09° | +0.0053 | PASS |
| idleShow2 | 357 | 52 | 0(spring) | 60.72° | 0.08° | +0.0054 | PASS |
| commonIdle | 251 | 52 | 0(spring) | 0.59° | 0.14° | +0.0054 | PASS |
| breaked | 80 | 52 | 0(spring) | 0.59° | 0.33° | – | PASS |
| skill01 | 67 | 52 | 0(spring) | 83.4° | – | – | WARN（源数据快速手势） |
| skill02 | 61 | 52 | 0(spring) | 68.6° | – | – | PASS |
| skill03 | 240 | 52 | 0(spring) | 100.5° | – | – | WARN（源数据快速手指） |
| mazeSkill | 90 | 52 | 0(spring) | 41.1° | – | – | PASS |
| passiveSkill | 117 | 52 | 0(spring) | 114.2° | – | – | WARN（源数据快速手指） |
| hitL | 48 | 52 | 0(spring) | 62.5° | – | – | PASS |
| stun | 55 | 52 | 0(spring) | 67.4° | – | – | PASS |
| revive | 46 | 52 | 0(spring) | 21.6° | – | – | PASS |

- 汇总：**PASS 11 / WARN 3 / FAIL 0**；U-lane 22 骨 validator：**0 errors**（430 warnings 均为扩展手指骨）。
- 3 个 WARN 的帧跳变经溯源是**源 HSR 动画本身**的逐帧快速动作（技能手指/手部），传输忠实，未额外平滑。
- target：`aventurine-tpose.vrm`，yaw=0，spring=50 链/175 collider，humanoid=53（无 upperChest）。

---

## 7. 已知限制 / 后续

1. **次级骨是原生 spring，不是 HSR 作者动画**：新模型用 SpringBone 物理驱动头发/衣摆（自带 collider），
   视觉自然、无穿模，但大摆幅表演（idleShow/技能）与 HSR 原动画不完全一致。若用户不满意，V3.1-B
   可重烘 raw（逐节点最近骨映射 + 播放器 raw 覆盖 spring），核心数据复用，见 `tests/tmp/hsr-motion/tpose-impact/SCOPE.md`。
2. **骨骼缩放拉伸未搬**：`passiveSkill` 上臂 2.20×/前臂 1.19×、`skill03` 1.55×/1.58×，旋转重定向无法表达；
   这些帧手位会比源短（上一轮结论：不搬，避免橡皮手）。
3. **idle 组首帧悬空 ~2.2cm**：新模型 hips=下半身（1.066m，位于腿根上方），旧 A-pose 资产 hips=センター（0.714m）；
   同样的 HSR 髋旋转下脚骨高度不同，grounding 保持「Hips.p 首帧=0」约定后留下常量残差（0.8cm→2.2cm）。
   场景层/播放器可把该常量作为整体贴地偏移；若必须严格贴地，可给 grounded clip 写首帧非零 p（会破坏
   「首帧 p=0」契约，需要 V5 评审）。
4. **躯干 3 骨近似**：目标无 upperChest，HSR Spine2_M 的局部旋转并入 chest 的绝对旋转；躯干扭转分布
   有轻微近似（Spine2 局部 mean 7.9°/max 33°），视觉未见问题。
5. **脚趾/脚 rest 方向 14° 差异**是 足先EX 语义差异，未修正；grounding 已兜底。
6. **V5 接入要求**：缺 upperChest 时播放器跳过该骨；spring 随 `vrm.update(delta)` 自动更新（需真实 delta）；
   相机按 yawOffset（0）+Z；Hips 缩放按 rest hips 高；rawPolicy=spring 时无 raw。
7. **旧 V3.0 A-pose clip 归档**：`assets/motions/hsr-apose-legacy/`（gitignore）；回滚旧模型时可用。
8. **动作集仍是 14 条**；walk/run 由 U-lane Mate-Engine clip 承担（HSR 包无 body locomotion）。
9. **2026-11-09 已修（Hips 竖直语义）**：`stun`/`hitL` 的「首帧参考帧裁剪」误裁真实受击首帧（Hips 基准
   落在下蹲帧 → 播放时 +0.18m「起跳」）；`breaked`/`revive` 用首帧相对丢失绝对髋高（腰停站立高度、
   悬空「蜷缩」）且 `revive` 起身位移被 staging 归零。修法：参考帧裁剪增加「接近 rest」判定 +
   上述 4 条 clip 改用 `hipsBase:"rest"`；重新生成后 QA PASS 9/WARN 5/FAIL 0。详见
   `docs/research/stun-break-hips-fix.md`。

---

## 8. 复跑

```bash
# 1) Blender 全骨采样（HSR 源侧；与目标模型无关，只需跑一次）
"$BLENDER" -b --factory-startup --python scripts/vrm/motion/extract-hsr-anims.py -- \
  --fbx "$HSR_FBX" --config scripts/vrm/motion/clips.hsr.json --out tests/tmp/hsr-motion/samples.json

# 2) 重定向（自动解析 manifest 目标 = aventurine-tpose.vrm；raw auto=spring）
node scripts/vrm/motion/retarget-hsr.mjs \
  --samples tests/tmp/hsr-motion/samples.json --out assets/motions/hsr --report-dir tests/tmp/hsr-motion

# 3) QA + manifest
node scripts/vrm/motion/validate-hsr-clips.mjs --dir assets/motions/hsr
node scripts/vrm/motion/build-hsr-manifest.mjs --dir assets/motions/hsr --config scripts/vrm/motion/clips.hsr.json

# 4) 预览（+Z 朝向、spring 步进；--frames 多帧）
node scripts/vrm/motion/preview-hsr.mjs --all --out tests/tmp/hsr-motion/preview-tpose \
  --frames 0,0.2,0.4,0.6,0.8 --views front,side,threeQuarter,hand,feet

# 回滚旧 T-pose 数据到 A-pose 资产：把 manifest 的 adventurine file 改回 legfix VRM（另一会话保留），
# 旧 clip 在 assets/motions/hsr-apose-legacy/；重跑 retarget 时 --raw map 可恢复旧 chain raw 行为。
```

---

## 9. 授权与红线

- HSR 官方模型/动画版权归 **miHoYo/HoYoverse**；与项目红线一致：**仅本机个人私有使用，不进 git、
  不发布、不随 app 分发、不二次配布**。
- 因此 `assets/motions/hsr/**`、HSR FBX、`tests/tmp/hsr-motion/**` 全部 gitignore；本文件与
  `scripts/vrm/motion/**` 只包含管线代码/文档，不含任何游戏资产数据。
