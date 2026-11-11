# 水枪持枪规则数据化 + 全量 adv 动作整合（`watergun` task-5）

> 日期：2026-11-09 · owner：watergun（Team Lead: lead）
> 范围：用全量 138 个 `_skel.fbx` 的武器骨动画数据判定「每个动作源里是否真的持枪」，交叉官方实机画面与现有 V1 policy（`src/renderer/src/vrm/watergun-attach.json`），给出数据驱动的持枪规则建议；Phase 2（task-3 产出 `assets/motions/adv` 后）做运行时 preview 证据与握持校准复核。
> **Phase 1（§1–§8 数据/根因/规则建议）+ Phase 2（§9 规则落地与预览证据）均已完成**；规则文件已按 Lead 确认的方案 A 更新。
> 私有游戏资产（miHoYo/HoYoverse）：仅本机开发，禁止上传/二次配布/商用。

---

## 0. TL;DR

1. **数据结论：137 个 clip（task-3 最终 config：原 135 + `standby2`/`skill04-2` 两个变体副本）里只有 7 个源动画把水枪刚性固定在右手**（`skill01`、`mazeattack01`、`skill01readybs`、`skill01readyloop`、`skill01-ready`、`skill01-ready-loop`、`skill02toskill01`）；它们的握持偏移完全一致（**0.0972–0.0973 armature 单位，簇内位置 p90 ≤ 5.3e-3、旋转 p90 ≤ 3.5°**）→ 现有 V1 校准值对这 7 条全部适用。
2. **另有 12 个 clip 的枪刚性固定在「左手」**（attackStandby、idle2/TeamStandBy、standby2、stun、stunLoop、state-stun-recover、hitL/hit-h/hit-stun、die/die-loop、revive，偏移 0.0836–0.1124 且稳定）。这不是「静止假阳性」：全场景 pilot `State_Stun.fbx` 渲染可见角色**左手举着水枪**（§4）。但 runtime 只支持右手挂点 → 本轮建议全部隐藏（它们本来也不是 skill）。
3. **19 个 `skill` tag 的 clip 里，有 12 个源数据里武器骨不跟手**：`skill02`、`skill02readyloop`、`skill02-ready-loop`、`skill03`、`skill03-ready`、`skill04`、`skill04-2`、`skill04-ready`、`skill04-ready-loop`、`skill41`、`mazeSkill`、`skill01toskill02`。官方实机逐帧证据（visual-acceptance）与数据一致：**只有普攻（skill01）全程持枪**；战技前段右手持枪、后段过场无枪；终结技/秘技/欢愉技/强化欢愉技手中都无枪。
4. **「距手 1.8–80m」异常值根因已查清（不是导出损坏/坐标系错）**：这些片段里 (a) 水枪道具骨在源里被放在**世界/舞台静置位**（不跟手），(b) `Bip001` armature **根对象动画**（v3 新增的根运动）在过场技能里幅度巨大（Skill03 pelvis 世界位移 1.15 world ≈ 63 个角色身高）；两者叠加使「armature 空间」的距手数字被放大最多 **2776 倍**。证据：①枪的世界位移很小（Skill03/04/41 ≤ 0.04/0/0.28 world）；②跨 clip 边界帧级连续（`Skill01toSkill02#last ↔ Skill02#first` 枪位差 0.0008、手位差 0.0001）；③全场景 FULL 与 `_skel` 的武器骨指标 **逐位相同**（§1.3），证明 `_skel` 数据保真。
5. **规则已按 Lead 确认的方案 A 落地**（§9）：数据驱动白名单 `holdClipIds` 只留上面 7 条（app catalog id，`adv-` 前缀），`holdTags: ["skill"]` 保留为白名单为空时的兜底；白名单之外一律隐藏（含 03/04/41/maze/战技及全部左手持枪片段）。`shouldHoldHandProp` 改为「白名单非空即独占」；单测 14/14 绿、`pnpm typecheck` 通过；**不加** `skill02`（Lead 决定：官方只有前 ~2.3s 持枪，宠物展示时全程在手比短暂空手更穿帮）。

---

## 1. 方法与数据

### 1.1 探针（可复现）

| 脚本 | 作用 |
|---|---|
| `scripts/props/probe-watergun-hold.py` | Blender headless 遍历 138 个 `*_skel.fbx`：定位主 armature（Bip001, 332 骨）与 6 根武器骨（`Gun_b/c/d/e_01_JNT`、`prop_JNT`、`proptwo_JNT`），按 Biped 曲线帧范围均匀采样 ≤90 帧；逐帧输出武器骨 armature 空间矩阵、相对左右手变换 `T=inv(H_hand)·G_gun`、到左右手距离、矩阵缩放；每文件 JSON → `tests/tmp/props/watergun/data-probe/per-file/` |
| `scripts/props/analyze-watergun-hold.mjs` | 后处理：稳定簇（位置 ≤3cm 且旋转 ≤10° 的最大互近簇）→ 判定 `held_r/held_l/partial/ambiguous/not_held_static/not_held_independent/not_held_hidden_scale0`；与现有 policy 交叉 → `analysis.json` / `analysis-table.md` / `analysis-table.csv` |
| `scripts/props/probe-weapon-hierarchy.py` | 根因排查：逐帧 armature 空间 + world 空间轨迹、`Bip001` 根对象动画、武器骨父级/rest/局部曲线值域；→ `data-probe/hierarchy/` |
| `scripts/props/analyze-watergun-rootcause.mjs` | 根因量化：武器骨 world 位移幅度、角色根 world 位移幅度、world↔armature 放大倍数、跨 clip 边界连续性 → `data-probe/rootcause.json` / `rootcause.md` |

跑法与耗时：全量 138 文件单进程 Blender ≈ 100 秒（每文件 import+90 帧采样 ≈0.7s）。

```bash
BLENDER="/Volumes/4TB外置盘/deepseek-harness/tools/blender/Blender.app/Contents/MacOS/Blender"
"$BLENDER" -b --factory-startup --python scripts/props/probe-watergun-hold.py -- \
  --dir tests/tmp/adv-full-v3/fbx --out tests/tmp/props/watergun/data-probe/per-file --max-samples 90
node scripts/props/analyze-watergun-hold.mjs
node scripts/props/analyze-watergun-rootcause.mjs
```

**单位口径**：armature 空间 1 单位 ≈ 归一化米（项目 `meta.json` 用 bodyHeightSceneUnits 0.017002 → ×99.99 ≈ 1.70m；按 rest 高 0.018254 另一个口径为 ×92.13，两条换算相差约 8%）。本文所有阈值（近手 ≤0.30、稳定簇位置 p90 ≤0.05、旋转 p90 ≤20°、武器自身运动 ≤0.05）在该 ±10% 不确定性下结论不变。

### 1.2 判定规则（阈值）

| 判据 | 值 | 说明 |
|---|---|---|
| 近手 | 武器骨到某手距离中位数 ≤ **0.30** | 持枪时实测 0.083–0.148；不持枪时 0.5–80 |
| 稳定簇 | 位置 ≤3cm 且旋转 ≤10° 的最大互近帧簇，占全片 ≥ **50%** 帧 | 持枪实测 stableFrac 0.79–1.0；不持枪 ≤0.54（且距离远） |
| 刚性 | 簇内位置 p90 ≤ **5cm** 且旋转 p90 ≤ **20°** | 持枪实测 p90 ≤5.3mm / ≤3.5° |
| 武器自身运动 | 武器骨位置 pairwise p90 ≤ **5cm** → 武器骨未被动画 | 区分「静置」 |
| 源里隐藏 | 武器骨 matrix 缩放恒为 **0** | `Idle_Show_01` 专用（见 §2.3） |

注意：每个 `_skel.fbx` 的 **bind/rest pose 是逐文件不同的**（导出时把当时场景姿态写进了 bind pose），所以「相对 rest 的偏差」不可跨文件比较；本文全部用 pose matrix 的绝对/相对量。

### 1.3 数据完整性校验：`_skel` 保留武器骨动画（FULL vs SKEL）

用同一探针对 pilot 的 6 个 **全场景 FULL** FBX 与对应 `_skel` 各跑一次，`Gun_b_01_JNT` 相对右手指标逐位相同：

| clip | FULL stableFrac / clusterOffset / 距手中位 | SKEL 同三项 | 结论 |
|---|---|---|---|
| Skill01 | 0.7879 / 0.09721 / 0.0974 | 0.7879 / 0.09721 / 0.0974 | 一致 |
| StandBy | 0.9882 / 0.8961 / 0.8962 | 0.9882 / 0.8961 / 0.8962 | 一致 |
| State_Stun | 0.4464 / 0.49958 / 0.4972 | 0.4464 / 0.49958 / 0.4972 | 一致 |
| Talk01 | 0.0962 / 0.89629 / 1.1247 | 0.0962 / 0.89629 / 1.1247 | 一致 |
| Walk | 0.0556 / 0.87105 / 1.2782 | 0.0556 / 0.87104 / 1.2782 | 一致 |
| Tpose | 1.0 / 1.02434 / 1.0243 | 1.0 / 1.02434 / 1.0243 | 一致 |

> 证据：`data-probe/full-skel-compare/*.json` vs `data-probe/per-file/*_skel.json`。此前 pilot-v3 报告 §2.3 只验证了 65 根 Biped 身体骨等价，这里补上**武器骨/非人体骨同样等价**，因此全量 138 的 `_skel` 判定可信。

补充：`_skel.fbx` 里其实有 **2 个 armature**：`Bip001`（332 骨，角色，含武器骨）与 `Avatar_AventurineW_00`（7 骨：`CameraRoot/RootPoint/EffectScale/HeadPoint/UltraListener/SelectRoot/motion`，是**相机/特效 rig**）。水枪骨在 `Bip001` 内、无父骨（root-level）；`Avatar_*` 与枪无关。

---

## 2. 数据判定结果（135 clip）

完整机器判定表：`tests/tmp/props/watergun/data-probe/analysis-table.md`（含每个 clip 的 stableFrac/距手/武器自身运动/理由），原始指标：`analysis.json`。

| 判定 | 数量 | clips |
|---|---|---|
| **held_r（右手刚性持枪）** | **7** | skill01, mazeattack01, skill01readybs, skill01readyloop, skill01-ready, skill01-ready-loop, skill02toskill01 |
| **held_l（左手刚性持枪）** | **12** | attackStandby, idle2, standby2, stun, stunLoop, state-stun-recover, hitL, hit-h, hit-stun, die, die-loop, revive |
| not_held_hidden_scale0（源里武器骨缩放为 0） | 1 | idleShow |
| not_held_static（武器骨静置，远手/地面） | 67 | idle、walk 之外的绝大多数社交/待机/loop…（含 skill02readyloop、skill02-ready-loop、skill04-ready-loop） |
| not_held_independent（武器骨自身在动/世界静置，不跟手） | 50 | skill02/03/04/04-2/41、mazeSkill、skill01toskill02、skill03-ready/skill04-ready、locomotion 等 |

未匹配文件仅 `Tpose`（rest 参考，config 不引用）。⚠️ task-3 最终 config 把两个「下载副本」正式纳入为 clip：`standby2`（= `StandBy (2)`，fps/时长与 StandBy 不同，非简单重复）与 `skill04-2`（= `Skill04 (2)` 变体）。数据判定：`standby2` 的武器骨与 `StandBy` **不同**（前者枪在左手静态=held_l 类、后者枪在地面=not_held_static）→ 两者非 skill，均隐藏，不影响持枪规则；`skill04-2` 不持枪（官方欢愉技无枪）→ 白名单外隐藏。

### 2.1 7 个 held_r clip 的握持一致性（V1 校准适用性）

| clip | fps | 帧范围 | stableFrac | 簇内位置 p90 | 簇内旋转 p90 | 握持偏移（arm 单位） |
|---|---|---|---|---|---|---|
| mazeattack01 | 60 | 1–301 | 1.0 | 0.00119 | 0.97° | 0.09733 |
| skill01readybs | 30 | 1–167 | 1.0 | 0.00054 | 0.33° | 0.09728 |
| skill01readyloop | 30 | 1–167 | 1.0 | 0.00008 | 0° | 0.09726 |
| skill01-ready-loop | 60 | 1–121 | 1.0 | 0.00033 | 0.13° | 0.09726 |
| skill01-ready | 60 | 1–117 | 1.0 | 0.00078 | 0.62° | 0.09724 |
| skill01 | 60 | 1–195 | 0.7879 | 0.00530 | 3.50° | 0.09721 |
| skill02toskill01 | 60 | 1–121 | 1.0 | 0.00104 | 1.25° | 0.09725 |

> 7 条偏移差异 < 0.0002（≈0.2mm）→ **同一「右手握把」状态**，`watergun-attach.json` 的 V1 校准（由 Skill01 反推）对全部 7 条有效，无需重标。Skill01 的 21% 帧不在此簇 = 片尾收枪/武器自身挥动（plan §1.2 已记录），不影响固定挂点的近似。

### 2.2 18 个 `skill` tag clip 的数据判定 × 官方实机证据

| clip | 数据判定 | 关键指标（距手/稳定度） | 官方实机（visual-acceptance 逐帧 + 本地抽帧） | 建议 |
|---|---|---|---|---|
| skill01 | held_r | dR 0.097，stable 79% | **A：普攻全程双手持水枪**（W1 + labeled 普攻 0–2.2s；源 FULL 渲染同） | **持枪** |
| mazeattack01 | held_r | dR 0.097，stable 100%，与 skill01 同签名 | B：大世界普攻段（与普攻同类；未逐帧确认） | **持枪** |
| skill01readybs | held_r | dR 0.097，stable 100%；末帧与 Skill01 首帧 Δ0.0002 | C：无独立素材 | **持枪**（数据强） |
| skill01readyloop | held_r | 同上，Δ0.0002 | C | **持枪**（数据强） |
| skill01-ready | held_r | 同上，Δ0.0002 | C | **持枪**（数据强） |
| skill01-ready-loop | held_r | 同上，Δ0.0001 | C | **持枪**（数据强） |
| skill02toskill01 | held_r | stable 100%，末帧与 Skill01 首帧 Δ0.0003 | E | **持枪**（数据强） |
| skill02 | not_held_independent | dR 5.2（枪世界静置在舞台侧）；prop_JNT 仅 0–10% 帧近手 | **B：0–2.3s 右手持枪＋金币；2.3–4.65s 过场无枪** | **隐藏**（可选持枪，见 §6.3） |
| skill01toskill02 | not_held_independent | median dR 0.948（前段持枪→末段 park）；末帧与 Skill02 首帧连续 | E | 隐藏（可选持枪） |
| skill02readyloop | not_held_static | 枪 park 在 dR 1.78 | E | 隐藏 |
| skill02-ready-loop | not_held_static | 同上 | E | 隐藏 |
| skill03 | not_held_independent | 枪世界静置；距手 6.3–80（根运动放大） | **A：手中无枪（卡牌 FX/冲浪过场）** | 隐藏 |
| skill03-ready | not_held_independent | 枪 park 在 dR 4.9 | E | 隐藏 |
| skill04 | not_held_independent | 枪世界静置地面（dR 1.2） | **B：无枪（汽水罐/广告/金色爆发）** | 隐藏 |
| skill04-2 | not_held_independent | 枪世界静置（dR 1.32），非简单重复的 60fps 变体 | B（同 Skill04 对应段） | 隐藏 |
| skill04-ready | not_held_independent | 枪静置（dR 1.2） | E | 隐藏 |
| skill04-ready-loop | not_held_static | 枪静置（dR 1.07） | E | 隐藏 |
| skill41 | not_held_independent | 枪世界静置/舞台位（dR 55，根运动放大） | **B：无枪（面具/扑克/汽水/老虎机）** | 隐藏 |
| mazeSkill | not_held_independent | 枪距手 0.82–1.45、随位移 | **B：无枪（冲浪盘/浪环）** | 隐藏 |

> 官方逐帧证据路径：`work/adv-biped/qa/full-acceptance/official-dense/<clip>/`、`.../compare/phase1/official-storyboard-*.jpg`（visual-acceptance 产出）；本文本地抽帧：`tests/tmp/props/watergun/data-probe/ref-frames/`（含 `hr/seq-*` 高密度拼图与 `standby-hires/`）。

### 2.3 两个特殊数据现象

- **`Idle_Show_01`（idleShow）源里把武器骨 scale 压成 0**（3 条 scale 曲线恒 0，bind 矩阵因此 NaN）= 源动作明确隐藏武器 → 不持枪（且非 skill，policy 本来就隐藏）。
- `StandBy (2)` 副本的武器骨状态与 `StandBy` 不同（枪在左手静态 vs 枪在地面）——两个下载副本导出时场景状态不同；config 排除 `(2)` 副本正确，且官方画面支持「战斗待机空手」。

---

## 3. 根因调查：skill02/03/41/MazeSkill 的「距手 1.8–80m」是什么（Lead Q1）

### 3.1 现象与三层根因

**结论：不是坐标系/父级/缩放/导出损坏，而是「源道具动画 + 根运动」叠加后的 armature 空间假象。**（下表以 Skill02/03/04/41 为代表；同族的 skill03-ready、skill04-ready(-loop)、skill04-2 同层原因。）

1. **武器骨在源里没有跟手**：这些 clip 的水枪道具骨被 key 在**舞台/世界静置位**（不是手边）。证据（`rootcause.json`，world 单位 = Blender 世界，角色高≈0.0183）：
   - Skill03：枪 world 位移幅度 **0.040**、角色 pelvis world 位移 **1.154**（≈63 个角色身高）→ 枪基本留在原地，角色冲浪跑远；枪到右手世界距离 0.063–0.803（≈3.4–44 个身高）→ 永远不在手上。
   - Skill04：枪 world 位移 **0**（完全静置地面），距手 0.0085–0.0138 world（≈0.78–1.27 归一化米）→ 放在脚边。
   - Skill41：枪前 2/3 world 静置（初始在舞台位），后段 world 位移 0.279；角色 pelvis 位移 0.554；距手 0.009–0.55 world（≈0.8–50 米）→ 从"舞台位"被 key 到远处，全程不在手边。
   - Skill02：枪 world 位移 0.007（相对静止）、角色位移 0.076；枪到右手 0.018–0.067 world（≈1.6–6 个身高）→ 枪停在舞台侧。
2. **`Bip001` armature 对象级根运动把这些「世界空间的固定距离」在 armature 空间里放大**：v3 新增的根对象动画在过场技能里幅度很大（Skill03 pelvis 世界位移 1.15、Skill41 0.55、Skill02 0.076），而 armature 空间的 pose matrix 不含对象变换 → `armature 空间距手 / world 空间距手` 比值最高 **2776×**（Skill03）、198×（Skill41）、985×（Skill02）。此前「55m/80m」是 armature 空间数字，换算成世界/真实米后是 0.5–0.8m 级（仍不在手边，但绝非 80m）。
3. **这些武器动画是有效的作者数据，不是导出损坏**——跨 clip 边界帧级连续（`rootcause.md`）：
   - `Skill01toSkill02#last ↔ Skill02#first`：枪位差 **0.0008**、手位差 **0.0001**（精确衔接）；
   - `Skill02toSkill01#last ↔ Skill01#first`：0.0003 / 0.0004；
   - 所有 ready/ready-loop ↔ Skill01#first：0.0001–0.0002；
   - 反例：`Skill02#last ↔ Skill02toSkill01#first` 枪位差 5.35（Skill02 结束时枪在其舞台位、回程 transition 重置到手里）→ 说明 Skill02 的枪轨迹是设计好的"回到舞台位"，不是损坏。
   > `Skill01#last ↔ Skill01toSkill02#first` 枪/手差 0.236/0.428（transition 本身是从中立位起播的独立 take，不是与 Skill01 末帧无缝拼接）。

### 3.2 为什么个别「非枪骨」看起来跟手

`prop_JNT`/`proptwo_JNT` 不是水枪显示骨（水枪网格按 plan §1.1 蒙皮到 `Gun_b/c/d/e_01_JNT` + `Part_c_02~06_JNT`），更像水枪/FX 的**次级道具控制骨**：例如 Skill02 里 `prop_JNT` 在 0–10% 帧距手最近 0.115（战技起手拿枪/金币的 FX 锚点），Skill03 的 `proptwo_JNT` 距手 0.38–1.35。判定「水枪是否跟手」应以 `Gun_b` 为准（本文口径），`proptwo` 近手不代表水枪在手上。

### 3.3 对「源数据 vs 官方画面冲突」的解释

官方实机里战技前段、大招起手能看到角色手上有水枪，但**源 FBX 的武器骨轨迹在这些过场技能里并不跟手**——说明游戏内武器的显示/挂接不完全由这些道具骨动画驱动（过场/演出镜头另有一套显示逻辑，或可见武器是 FX 模型）。因此：
- 对「源里跟手」的 clip（skill01 家族/左手家族）：源数据可直接作为持枪证据；
- 对「源里不跟手」的过场技能：**以官方实机画面为准**决定显示/隐藏，源数据的武器骨轨迹不可用（也无法用固定挂点复刻飞行/收纳轨迹）。
- V1 固定挂点只能表达「手上常驻」这一种状态，无法表达过场里「枪在手上→消失/飞出」。

---

## 4. held_l 真伪核查（Lead Q2）

**结论：是真持枪（左手），不是「整段静止导致相对变换恒定」的假阳性。**

1. **动态片段也是刚性跟左手**：`stun`（body 手部运动 0.40）、`die`（0.63）、`state-stun-recover`（0.60）、`revive`（0.58）这些源动作幅度大的 clip，枪到左手距离仍稳定在 0.092–0.112，稳定簇覆盖 45%–100%。若枪只在地面不动，身体大动时距离必然变化。
2. **全场景 pilot 渲染直接可见**：`State_Stun.fbx`（FULL，含水枪网格）三帧渲染（front/threeQuarter）显示角色**左手举着/握着水枪**，随受击动作摆动；同帧右手空。证据：`data-probe/source-render/state_stun/state-stun-sheet.jpg`。对照 `StandBy.fbx` 渲染：枪在**脚边地面**，手中空（`source-render/standby/standby-sheet.jpg`）；`Skill01.fbx` 渲染：双手持枪（`source-render/skill01/skill01-sheet.jpg`）。渲染命令见 §8。
3. **偏移呈 3 个稳定簇**（0.0836/0.0945/0.1124），对应不同的持枪手姿态，同一簇内跨 clip 一致 → 作者数据里确实存在「左手续枪」的状态。
4. **但本轮仍建议全部隐藏**：这些 clip 都不是 skill（idle/combat/react 类），用户要求「正常的没有枪的动作不持枪」；且 runtime 只有右手 attach（改用左手属于 prop-layer 结构改动，需 Lead 批准，本轮不做）。
5. **attackStandby 重点判定**：源里是**静态 pose take**（body 呼吸幅度 ~mm），枪静态停在左手边（0.0836）；官方「战斗待机」实机（V10 0:00–10.6s、V4 0:00–14s）**双手自然下垂、空手**（本地抽帧 `ref-frames/standby-hires/standby-0.5.jpg` 等 + visual-acceptance `official/standby/*`）→ **隐藏**（现有规则正确）。注意 `attackStandby` 不在 app 槽位（profile B 的 idle 槽是 commonIdle/scratchHead01/idle/think01/worry01），只进 catalog。

---

## 5. 与现有 policy 的差异清单

现有 policy：`holdSets: ["adv"]` + `holdTags: ["skill"]` → **18 条 skill clip 全持枪**；`holdClipIds: []`。

| 类别 | 数量 | clips | 现规则（旧） | 数据/官方建议 |
|---|---|---|---|---|
| 一致：持枪 | 7 | skill01, mazeattack01, skill01readybs, skill01readyloop, skill01-ready, skill01-ready-loop, skill02toskill01 | 持枪 | **保持持枪**（右手，V1 校准有效） |
| 冲突：现规则持枪但源里不跟手 | 12 | mazeSkill, skill01toskill02, skill02readyloop, skill02-ready-loop, skill02, skill03-ready, skill03, skill04-2, skill04-ready-loop, skill04-ready, skill04, skill41 | 持枪 | **改隐藏**（skill02/skill01toskill02 仍不加，Lead 已确认） |
| 数据「左手持枪」但现规则隐藏 | 12 | attackStandby, idle2, standby2, stun 家族 3, hit 家族 3, die/die-loop, revive | 隐藏 | **保持隐藏**（非 skill + runtime 只挂右手；V2 可选） |
| 数据不持枪且现规则隐藏 | 106 | 其余 | 隐藏 | 保持隐藏（含 idleShow 源里 scale0 隐藏武器） |

> HSR/mate 集不受影响：policy 有 `holdSets: ["adv"]`，非 adv 集一律隐藏；新增白名单机制后仍如此。

---

## 6. 建议规则（**待 Lead 确认后实施**，本轮未改 JSON）

### 6.1 推荐方案：数据驱动白名单 + 保留 tag 兜底

`watergun-attach.json` 的 policy：

```json
"policy": {
  "holdSets": ["adv"],
  "holdTags": ["skill"],
  "holdClipIds": [
    "skill01",
    "mazeattack01",
    "skill01readybs",
    "skill01readyloop",
    "skill01-ready",
    "skill01-ready-loop",
    "skill02toskill01"
  ]
}
```

`prop-config.ts` 的 `shouldHoldHandProp` 语义改为：**`clipIds` 非空时，名单独占**（命中 → true，否则 false，set/tags 不参与）；`clipIds` 为空时退回现有 `set+tags` 规则。这样：
- 当前 18 条 skill 中只有 7 条显示，其余（03/04/41/maze/战技等）隐藏；
- 未来新增未知 clip 默认隐藏（失败安全，符合「没有枪的动作不要持枪」）；
- 保留 `holdTags: ["skill"]` 作为「清空白名单后的粗规则」兜底与可读性；`holdSets` 继续限制只在 adv 集生效。

改动面：`src/renderer/src/vrm/prop-config.ts`（~10 行 + 注释）、`tests/vrm-hand-prop.test.ts`（新增：白名单独占、名单为空回退 tag、非 adv 集不误伤、null clip 隐藏）、`watergun-attach.json`（policy 字段）。**不触碰 `prop-layer.ts`/骨骼结构。**

### 6.2 证据强度与风险

- `skill01`：官方 A 级（普攻全程持枪）+ 源数据右手跟手 79% + 全场景渲染确认 → 最强。
- `mazeattack01`：源数据与 skill01 完全同一握持签名（stable 100%、偏移 0.09733）；官方 B 级（大世界普攻段，与普攻同类）→ 强。
- 4 条 ready/ready-loop：源数据 stable 100%、握持偏移一致、且与 Skill01 首帧**帧级连续（Δ≤0.0002）** → 强数据证据；官方 C 级无独立素材 → 数据主导（它们是普攻的起手/待机状态，逻辑上就是持枪状态）。
- `skill02toskill01`：源数据 stable 100%、末帧与 Skill01 首帧连续 → 强数据证据；官方 E 级。
- 风险：若用户/Lead 更希望「宠物展示尽量有道具」，可把 `skill02`（官方前段持枪）加入白名单，接受后半段过场近似；`skill01toskill02` 同理（主要帧不持枪，不建议）。

### 6.3 备选（Lead 可改选）

| 方案 | 做法 | 效果 | 风险 |
|---|---|---|---|
| **A. 白名单 7 条（推荐）** | 见 §6.1 | 数据+官方一致；无「空手动作被塞枪」 | ready 循环无官方直接证据（有强数据证据） |
| B. 白名单 + skill02（8 条） | A + `skill02` | 战技前段持枪 | 后段过场枪在手上（官方无枪） |
| C. 保持现规则 | skill tag 全持枪 18 条 | 展示最多道具 | 03/04/41/maze/战技过场明显穿帮（官方证实无枪） |
| D. tag 规则 + 黑名单 | 保留 tag 规则，新增 `releaseClipIds` 排 11 条 | 等价 A 但逻辑更绕、未来新 skill 默认显示 | 需同样改 prop-config，且失败不安全 |

---

## 7. 限制与已知问题

1. **本轮不做左手 attach**：11 条 held_l 数据上确实左手持枪，但 runtime 只有右手挂点；如未来要展示它们，需 prop-layer 支持 bone 可配置（Lead 批准）。按用户要求本轮这些动作也应空手，故无功能缺口。
2. **V1 固定挂点无法复刻「武器自身动画/飞行/收纳」**：skill01 片尾收枪、战技的枪飞出等都会被近似成「一直在手上」；这是 V1 的设计边界（V2 可选，不在本轮）。
3. **过场技能（03/04/41/maze）官方画面无枪、源道具骨为舞台静置位** → 一律隐藏；若将来想要「技能里道具 FX」需要 V2 数据管线（per-clip 道具轨道 + 可见性），不是固定挂点能解决的。
4. **单位/归一化口径** 有两套（×99.99 与 ×92.13，差 8%），不影响阈值结论；若后续要精确到 cm 级握持偏差，建议统一口径。
5. 判定阈值基于 `Gun_b_01_JNT`（水枪网格实际蒙皮骨），`proptwo/prop_JNT` 属次级道具/FX 骨不参与判定。
6. ready/transition 规则的最终取舍取决于 Lead 产品决策（是否「展示优先」）；数据/官方证据已列全。

---

## 8. 复现命令与证据路径

```bash
# 1) 全量武器骨探针（~100s）
BLENDER -b --factory-startup --python scripts/props/probe-watergun-hold.py -- \
  --dir tests/tmp/adv-full-v3/fbx --out tests/tmp/props/watergun/data-probe/per-file --max-samples 90
# 2) 判定 + policy 交叉
node scripts/props/analyze-watergun-hold.mjs
# 3) 根因（层级/world/边界连续性）
BLENDER -b --factory-startup --python scripts/props/probe-weapon-hierarchy.py -- \
  --dir tests/tmp/adv-full-v3/fbx --files Skill01,Skill02,Skill03,Skill04,Skill41,MazeSkill01,Skill01toSkill02,Skill02toSkill01,AttackStandBy,TeamStandBy,State_Stun,Hit_L,Die,Revive,Tpose,StandBy
node scripts/props/analyze-watergun-rootcause.mjs
# 4) 源 FULL 渲染（确认枪在哪只手/是否在手）
BLENDER -b --factory-startup --python scripts/vrm/motion/render-source-fbx.py -- \
  --fbx tests/tmp/adv-pilot-v3/fbx/State_Stun.fbx --take "Bip001|Take 001|BaseLayer" \
  --clip-id state-stun --frames 0,0.3,0.6 --frame-mode fraction --views front,threeQuarter \
  --res 512x768 --out tests/tmp/props/watergun/data-probe/source-render/state_stun
# 5) 官方视频抽帧（bundle ffmpeg）
work/ref-aventurine/tools/bin/ffmpeg -i <clip>.mp4 -vf "fps=...,scale=...,tile=3x2" -frames:v 1 out.jpg
```

证据路径（均 gitignore）：

| 路径 | 内容 |
|---|---|
| `tests/tmp/props/watergun/data-probe/probe-full.log` | 138 文件探针进度/摘要 |
| `.../data-probe/per-file/*.json` | 每文件全部原始指标 + 逐帧序列（Gun_b/prop_JNT） |
| `.../data-probe/analysis.json` / `analysis-table.md` / `analysis-table.csv` | 135 clip 判定表 + 与 policy 差异 |
| `.../data-probe/rootcause.json` / `rootcause.md` | 根因量化 + 跨 clip 边界连续性 |
| `.../data-probe/hierarchy/*.json` | 逐帧 armature/world 轨迹、父级、局部曲线值域 |
| `.../data-probe/full-skel-compare/*.json` | FULL vs SKEL 武器骨等价性 |
| `.../data-probe/source-render/{skill01,state_stun,standby}/` | 全场景源渲染（枪在哪：右手双手/左手/地面） |
| `.../data-probe/ref-frames/` | 官方实机抽帧/拼图（普攻/战技/大招/欢愉/秘技/战斗待机） |

---

## 9. Phase 2 实现记录：规则落地 + 预览证据（2026-11-09）

> Lead 决策：**方案 A（白名单 7 条，不含 skill02）**；`clipIds` 非空即独占；held_l/attackStandby 保持隐藏（V2 可选）。
> **最终验收版本（2026-11-09 20:24）**：基于 task-3 **全量重跑后**的最终 `assets/motions/adv`（137 clip，task-6 sampler v2；validation PASS 118/WARN 19/FAIL 0）与**真实 `app-catalog.json`（180 clip，其中 adv 137）**复验；见 §9.1/§9.2 末段。

### 9.1 规则改动（最终 diff）

1. **`src/renderer/src/vrm/watergun-attach.json`**：`policy.holdClipIds` 由 `[]` 改为 **7 条 app catalog id（adv- 前缀）**：
   ```json
   "holdClipIds": [
     "adv-skill01", "adv-mazeattack01", "adv-skill01readybs", "adv-skill01readyloop",
     "adv-skill01-ready", "adv-skill01-ready-loop", "adv-skill02toskill01"
   ]
   ```
   并加 `policyNote` 记录依据；`holdSets: ["adv"]` / `holdTags: ["skill"]` **保留为白名单为空时的兜底**（当前不生效）。
2. **`src/renderer/src/vrm/prop-config.ts`**：`shouldHoldHandProp` 语义改为——`clipIds` 非空 → **独占白名单**（`includes(id)` 即结果，不再回落 set+tags）；`clipIds` 为空 → 原 `set+tags` 规则；三者全空 → DEFAULT（adv+skill）。文件头/接口/函数注释同步更新。**未改 `prop-layer.ts`（不触碰挂点/骨骼结构）。**
3. **`tests/vrm-hand-prop.test.ts`**：按新语义重写/新增用例（14 条全绿）：
   - 白名单非空独占：命中 true、`adv-skill03`（不在名单，即使 adv+skill）false；
   - 白名单命中时显式覆盖（`adv-idle`/`hsr-idle` 都可 true）；非 adv/hsr/mate 不在名单 → false；
   - **源 clip id（无 `adv-` 前缀）不误命中**；
   - 内置配置断言：7 条 `adv-*` 白名单精确匹配；11 条过场 skill（`adv-skill02/03/04/41/mazeSkill/...`）全部 false；`adv-idle/walk/stun/attackStandby/idle2`、`hsr-skill01`、`mate-idle` 全部 false；
   - 白名单为空时回退 adv+skill 兜底（原语义不回归）。
4. **回归结果**：`pnpm vitest run tests/vrm-hand-prop.test.ts` → **14 passed**；`pnpm typecheck`（node+web）→ **通过**。
5. **端到端策略校验脚本** `scripts/props/check-watergun-policy.mjs`：
   - 首次（catalog 接入前）对 `assets/motions/adv/index.json`（137 clip）+ 现有 catalog 做 dry-run → PASS；
   - **最终（app-catalog 已接入 adv 137 条后，真实 catalog）** → **POLICY_CHECK PASS**：
     `clips=180（adv=137）holds=7`，白名单命中 7 条、缺 catalog 0、意外命中 0、**非 adv 误伤 0**；
     且 7 条命中 clip **全部不在 app 槽位**（`app-manifest.json` 的 adv 槽位为 `adv-commonIdle/adv-scratchHead01/adv-idle/adv-think01/adv-worry01`（idle）+ `adv-walk`（walk））→ **app 日常 idle/walk 状态一律空手**；7 条持枪 clip 是 catalog-only，只有在被播放时（技能展示场景）才显示水枪。
     证据：`data-probe/policy-check.json`（`source` 字段标明用的是真实 `app-catalog.json`）。

### 9.2 预览证据（`tests/tmp/props/watergun/v3-adv-evidence/`，**最终版**）

> 目录结构：`main/`、`hand/` = **最终重跑版**（最终验收引用）；`archive-first-run/` = 重跑前同参数对照（仅 diff 用）。
> 最终重跑对白名单 7 条 clip 无影响：`skill01-sheet.jpg` 两次渲染 **sha256 相同**（`a2f6aafd…`）；task-6 的 `sourceRootMotion:ignore` 只作用于 skill02/03/41/skill04-2/mazeSkill（空手对照组），最终版这些 clip 在 VRM 里为 in-place（不再有 staging 根运动跳变），规则结论不变。

复现（Electron 预览，userData 与 visual-acceptance 共用 `tests/tmp/electron-userdata-adv`，开工前已与其串行协调）：
```bash
# 主对照：持枪 4 条 + 空手 8 条 × 3 帧 × front/threeQuarter
node scripts/vrm/motion/preview-adv.mjs   --clips skill01,mazeattack01,skill01readyloop,skill02toskill01,idle,walk,stun,skill02,skill03,skill04,skill41,mazeSkill   --clips-dir assets/motions/adv --frames 0.2,0.5,0.8 --views front,threeQuarter   --prop assets/props/watergun/watergun.glb   --prop-transform src/renderer/src/vrm/watergun-attach.json   --prop-hold skill01,mazeattack01,skill01readyloop,skill02toskill01   --out tests/tmp/props/watergun/v3-adv-evidence/main
# 握持/侧视复核（hand,side 两视图）
node scripts/vrm/motion/preview-adv.mjs   --clips skill01,mazeattack01,skill01readyloop,skill02toskill01,skill02,skill03,idle   --clips-dir assets/motions/adv --frames 0.15,0.4,0.7 --views hand,side   --prop assets/props/watergun/watergun.glb   --prop-transform src/renderer/src/vrm/watergun-attach.json   --prop-hold skill01,mazeattack01,skill01readyloop,skill02toskill01   --out tests/tmp/props/watergun/v3-adv-evidence/hand
```

| 证据 | 内容 | 结果 |
|---|---|---|
| `main/skill01-sheet.jpg` | 持枪 clip（本应持枪） | ✅ 右手持枪，握把落在右掌、枪管朝前上方；无穿手/明显穿模 |
| `main/mazeattack01-sheet.jpg` | 持枪 clip（本应持枪） | ✅ 右手持枪，与 skill01 同一握持状态 |
| `main/skill01readyloop-sheet.jpg` | 持枪 clip（本应持枪） | ✅ 双手在枪上（右手握把），姿态与源一致 |
| `main/skill02toskill01-sheet.jpg` | 持枪 clip（本应持枪） | ✅ 右手持枪（transition 段） |
| `main/idle-sheet.jpg`、`walk-sheet.jpg`、`stun-sheet.jpg` | 非 skill 普通动作 | ✅ 空手（规则生效） |
| `main/skill02-sheet.jpg` | 战技（官方前段持枪/后段过场无枪，本轮决定隐藏） | ✅ 空手（接受前半段空手，避免后段穿帮） |
| `main/skill03/skill04/skill41/mazeSkill-sheet.jpg` | 过场技能（官方手中无枪） | ✅ 空手（与官方一致） |
| `hand/*-sheet.jpg` | hand/side 视图握持复核 | ✅ 枪在右手握持区，无骨骼穿透；但工具 `hand` 视图是宽构图，细节判定以 `main` 的 front/threeQuarter 为准 |

**握持校准结论：无需微调。** 4 条持枪 clip 的源握持偏移相同（0.0972–0.0973），V1 校准值（来自 Skill01）在 preview 中全部贴合；任务允许的 position/quaternion 微调本轮不需要。Skill01 片尾 ~21% 帧源里枪离手（收枪/武器挥动），固定挂点会让枪继续留在手里——属 V1 设计边界（V2 才做 per-clip 武器轨道）。

### 9.3 与实机对拍结论

- 持枪白名单 4/7 条已逐帧 preview 确认（剩余 3 条 ready/transition 与 skill01 同握持状态、数据 stable 100%，预览不重复渲染）；空手对照组 8 条确认无枪。
- 官方逐帧证据（visual-acceptance）与数据判定一致：普攻全持、战技前段持/后段无、终结技/秘技/欢愉技/强化欢愉技无枪 → 白名单方案与实机观感一致。

### 9.4 V2 可选（本轮不做，Lead 决策记录）

- **左手持枪的 12 条**（attackStandby/idle2/standby2/stun 家族/hit 家族/die/revive）：源数据确实左手持枪；runtime 只有右手 attach，且用户要求普通动作空手 → 保持隐藏。若将来要展示，需要 prop-layer 支持 per-clip 挂点骨（左手）或双实例，属结构改动，需 Lead 批准。
- **武器自身动画/飞行/收纳轨迹**：源里 Skill01 收枪、战技枪飞出等，V1 固定挂点无法复刻；需要 per-clip 道具轨道（V2 数据管线）。

### 9.5 收尾状态

- [x] 用**最终重跑 clips**（137，task-6 sampler v2）重渲 `main/`+`hand/` 预览证据（2026-11-09 20:24），与 first-run 对照见 `archive-first-run/`；白名单 clip 渲染与 first-run 逐字节相同。
- [x] app-catalog 接入 adv 137 条后，`check-watergun-policy.mjs` 对**真实 catalog** 端到端确认 **PASS**（holds=7、缺 0、意外 0、非 adv 误伤 0，见 §9.1.5）。
- [ ] 最终验收文档由 Lead 汇总，引用本文 §3 根因与 §9 规则/证据。
