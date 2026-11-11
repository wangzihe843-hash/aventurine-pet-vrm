# 数据侧修复报告：静态站立 clip「膝拉直」bake（P2）

> 日期：2026-11-11 · 执行：leg-data-baker（task-3 subagent）· 基线 HEAD `f217521`
> 相关调查：`tests/tmp/inv-leg2/REPORT.md` §13（全站立审计，D 类「作者数据屈膝」）
> **当前状态：✅ 已 apply（2026-11-11 14:22:52 +08:00，Lead 复核批准后执行）**。
> 11 条 baked clip 已写入 `assets/motions/**`，写后自动复验 PASS；原始文件备份在
> `assets/motions-leg-backup-2026-11-11/<相对路径>`（11/11 sha256Before 校验通过），一键回滚命令见 §7。

---

## 0. TL;DR

| 项 | 结果 |
|---|---|
| 最终 bake 清单 | **11 条 clip**（idle 轮换池 5 + IdleOneShotFidget 6；按文件去重，dshBusy 别名共享其中 2 条） |
| 膝角（作者 FK 口径） | **idle 5 条：均值 175.50–175.63°、最差帧 174.10–174.99°**（原逐腿均值 165.9–173.2°、最差帧 165.9–171.1°）；**社交 6 条：均值 173.00–173.77°、最差帧 170.20–172.95°**（原逐腿均值 169.4–173.4°、最差帧 167.2–171.9°） |
| 脚位漂移 | **0**（bake 内部全精度 <1e-9m；产品口径用 6 位小数坐标复算 ≤0.0009mm，门禁 0.5mm） |
| 脚朝向漂移 | **≤0.000003°**（门禁 0.5°） |
| Hips 抬升 δy | **0.17–3.41mm**（门禁 ≤5mm，全部 ≤5mm） |
| Hips 水平修正 δxz | 绝大多数 ≤5.5mm；**2 条例外**：talk02 11.8mm（3.7px）、**think01 28.0mm（8.7px，见 §8 风险 R1）** |
| 膝 range 变化 | **≤0.0003°**（门禁不得增 >0.5°；本方案逐帧 = 作者逐帧 + 常数 Δ，range 原样保留） |
| loop 首尾 | 与作者原 clip 同值（增量 ≤0.002mm）；3 条作者自身首尾 >0.1mm（commonIdle 0.673mm 最大），bake 不劣化（§8 R4） |
| 数值验证 | **11 条 × 15 项 = 165 项全部 PASS**（脚本内 FK 复验） |
| 产品口径验证 | **`parseClipData` + 产品 sampling 逐帧复验 15/15 测试 PASS**（含 apply/rollback 沙盒端到端） |
| 视觉证据 | `tests/tmp/bake-leg/visual/knee-angles-before-after.png`（11 条 before/after 柱状图）+ 3 条代表 clip 的腿部网格 before/after×front/side/overlay 渲染对比（§5.6） |
| 产物 | `tests/tmp/bake-leg/staging/**`（11 个 JSON，+0.82% 体积）、`metrics.json`、`staging-manifest.json`、`diff-stats.json`、`visual/**` |
| 下一步 | Lead 批准 → `node scripts/vrm/motion/straighten-standing-knees.mjs apply --yes` |

---

## 1. 背景与目标

调查（REPORT §13）把「腿弯」拆成三类来源：

- **R（运行时放大）**：foot-lock / micro-motion / 跨变体残差 → 由 task-2（候选 g + IK margin）运行时修复；
- **D（作者数据本身屈膝）**：**110 条站立 clip 里 65 条作者膝角均值 <174°**，其中用户可见池约 14 条；
  这些 clip 在**一次性/manual 路径（foot-lock `allow=false`）**下腿形 = 作者数据，运行时修不了；
- **N（动态动作）**：膝 range ≥20° 的屈膝是动作本身，不修。

本任务做 D 类的 **P2 数据侧 bake**：在**不移动脚位、不改变脚朝向、不破坏上半身**的前提下，
把静态站立 clip 的作者膝角拉到「站直」范围。任务书门禁：

1. 膝角：idle 轮换池 `avg ≥175.5° && 最差 ≥174°`；社交/一次性 `avg ≥172° && 最差 ≥170°`；
2. 脚位变化 <0.5mm、脚朝向 <0.5°、Hips 抬升 ≤5mm、loop 连续性 ≤0.1mm（见 §8 R4 口径说明）；
3. 膝 range 不得增 >0.5°、无 NaN；
4. baked JSON 必须能被产品 `parseClipData` 解析并采样出与预期一致的膝角；
5. **apply 前不得改真实 assets**；apply 后必须可一键回滚。

---

## 2. 目标清单

### 2.1 池定义（用户可见站立路径）

| 池 | 来源 | 条数 | 说明 |
|---|---|---|---|
| idle 轮换池 | `app-manifest.json` 中 `mood=idle` 且 `priority ≥ −9`（= `clip-player.ts:VARIANT_ROTATION_MIN_PRIORITY`） | 9 | hsr-idle / hsr-idle2 / hsr-idleShow / hsr-idleShow2 / hsr-commonIdle / adv-idle / adv-think01 / adv-worry01 / adv-scratchHead01 |
| IdleOneShotFidget | `src/renderer/src/reactions/idle-one-shot-fidget.ts:IDLE_ONE_SHOT_FIDGET_DEFAULTS.clipIds`（脚本内常量同步，不能 import TS） | 8 | adv-talk01/02、bye01、idleShow、idleShow2、lookAtPhone、watchphone01loop、useheadphone01loop |
| DSH 静态反应 | `app-manifest` 的 dshBusy / dshDone / dshError 别名 | 5 别名 / 4 文件 | hsr-commonIdle-dshBusy、adv-think01-dshBusy（与前两池**共享文件**）；adv-snap01loop-dshDone、mate-happy-dshDone、hsr-stun-dshError |
| pat 反应 | `app-manifest` 的 pat | 3 | mate-happy / mate-laughing / mate-shyPoint（动态反应，预期剔除） |

按**文件**去重后共 22 个候选文件；筛选条件（与 §13.2 审计同口径，全帧计算、非采样）：

- `standing`：膝角最小值 >145° && |平均 hips y −1.02|<0.18m && 平均踝 y<0.16m；
- `static`：**逐腿**膝角 range <10°（不是把左右差算进 range）；
- `bent`：作者膝角均值（左右/全帧平均）<174°。

### 2.2 最终 bake 清单（11 条，全部满足筛选条件）

| # | app id | clip 文件（`assets/motions/`） | 所属池 | 类别 | 目标均值/最差下限 |
|---|---|---|---|---|---|
| 1 | `hsr-commonIdle`（+`hsr-commonIdle-dshBusy`） | `hsr/commonIdle.json` | idle + dshBusy | idle | 175.5° / 174° |
| 2 | `adv-idle` | `adv/idle.json` | idle | idle | 175.5° / 174° |
| 3 | `adv-think01`（+`adv-think01-dshBusy`） | `adv/think01.json` | idle + dshBusy | idle | 175.5° / 174° |
| 4 | `adv-worry01` | `adv/worry01.json` | idle | idle | 175.5° / 174° |
| 5 | `adv-scratchHead01` | `adv/scratchHead01.json` | idle | idle | 175.5° / 174° |
| 6 | `adv-talk01` | `adv/talk01.json` | IdleOneShotFidget | social | 173° / 170° |
| 7 | `adv-talk02` | `adv/talk02.json` | IdleOneShotFidget | social | 173° / 170° |
| 8 | `adv-bye01` | `adv/bye01.json` | IdleOneShotFidget | social | 173° / 170° |
| 9 | `adv-lookAtPhone` | `adv/lookAtPhone.json` | IdleOneShotFidget | social | 173° / 170° |
| 10 | `adv-watchphone01loop` | `adv/watchphone01loop.json` | IdleOneShotFidget | social | 173° / 170° |
| 11 | `adv-useheadphone01loop` | `adv/useheadphone01loop.json` | IdleOneShotFidget | social | 173° / 170° |

> **用户可见路径覆盖**：idle 轮换池 9 条中 5 条被拉直（hsr-idle/hsr-idle2 本来就直；hsr-idleShow/hsr-idleShow2 属表演型动态，见剔除表）；
> IdleOneShotFidget 8 条中 6 条被拉直（adv-idleShow 非站立、adv-idleShow2 动态 range 10.65°）；
> dshBusy 2 个别名共享已 baked 文件，同样受益；dshDone 的 adv-snap01loop 已 176.5° 无需处理，mate-happy-dshDone 与 dshError 的 hsr-stun 属动态反应（表 13-C/13-F），不属「站着却弯」。
> 因 app-manifest/app-catalog 未改、文件路径不变，**所有 id/时长/loop/mood 元数据保持不变**。

### 2.3 剔除清单（11 个候选文件，逐条记录原因）

| 文件 | 作者膝角均值 L/R（全帧） | 剔除原因 |
|---|---|---|
| `adv/idleShow.json` | 133.50 / 168.58 | 非站立（standing=false）+ 动态屈膝（range L 55.3°/R 8.9°） |
| `adv/idleShow2.json` | 169.46 / 167.74 | 动态屈膝（逐腿 range L 9.94°/R **10.65°** ≥10°） |
| `hsr/idleShow.json` | 171.89 / 165.92 | 动态屈膝（range L 13.03°/R 24.94°；表演型 idle） |
| `hsr/idleShow2.json` | 172.34 / 172.36 | 动态屈膝（range L 6.86°/R **10.79°** ≥10°） |
| `hsr/idle.json` | 176.28 / 177.61 | 作者已接近伸直（均值 176.95° ≥174°）——任务书预期可跳过 |
| `hsr/idle2.json` | 176.29 / 177.60 | 同上（177.6°） |
| `adv/snap01loop.json`（`adv-snap01loop-dshDone`） | 174.25 / 178.83 | 作者已接近伸直（均值 176.54° ≥174°） |
| `hsr/stun.json`（`hsr-stun-dshError`） | 144.08 / 144.14 | 非站立 + 动态屈膝（受击动作 range L 64.1°/R 70.9°） |
| `mate/happy.json`（`mate-happy-dshDone`） | 142.47 / 146.92 | 非站立 + 动态屈膝（pat 动态反应 range L 36.6°/R 49.1°） |
| `mate/laughing.json` | 135.40 / 136.01 | 非站立 + 动态屈膝（pat 动态反应，range L 53.7°/R 54.5°） |
| `mate/shyPoint.json` | 154.33 / 143.32 | 非站立 + 动态屈膝（pat 动态反应，range L 35.8°/R 28.1°） |

> pat 三条按任务书「pat 将禁用锁脚，腿形=作者」不 bake；且它们作者膝角 135–154°、range 28–55°，
> 属动态反应而非「静态站立却屈膝」，不符合筛选条件。

---

## 3. 算法（含公式）

### 3.1 产品口径复刻（逐帧 FK）

脚本自包含复刻 `src/renderer/src/vrm/clip-player.ts` 的 clip 应用层序（只读参考、不 import TS）：

1. **骨**：clip 的 `r`（`[x,y,z,w]`，相对 rest 的 normalized 局部旋转）**直接写入**
   `vrm.humanoid.getNormalizedBoneNode(...).quaternion`（缺轨道/缺 normalized 骨 → 保持 rest；
   本 VRM 无 normalized `upperChest`，与产品一致地忽略）；
2. **Hips.p**：`hips.position = restHipsPos + p × (hipsRestHeight / sourceHipsHeight)`；
   本模型 `hipsRestHeight = normalizedRestPose.hips.y = 1.0661103621660233m`，hsr clip `sourceHipsHeight≈0.950`、adv≈0.922，
   → 缩放 1.122 / 1.156；
3. **贴地**：`grounding==='feet'` → 首帧（无贴地偏移）脚骨（feet+toes raw 骨）最低点对齐 rest 脚骨
   `restFeetLocalY = 0.05195634309483168m`，得每 clip 常量 `g`（本批 −0.17…−5.38mm），加到 normalized hips y；
4. **FK**：`humanoid.update()` + `scene.updateMatrixWorld(true)` 后，在 `avatar.scene` 局部坐标量
   髋=normalized `*UpperLeg` 原点、膝=`*LowerLeg` 原点、踝=`*Foot` 原点；
   膝角 `θ = ∠(膝→髋, 膝→踝)`（180°=伸直），腿骨长 `L1=435.9219mm`（大腿）、`L2=445.6145mm`（小腿），
   `L1+L2=881.5363mm`。

> 与调查夹具（`tests/tmp/inv-leg2/audit.test.ts` 的 miniPlayer/authorStatFor）对拍：11 条 clip 的
> 作者膝角均值差 **≤0.04°**（测试里有断言，见 §5.4），确认口径一致。

### 3.2 目标膝角（逐帧、只拉直、保留作者差异）

记作者逐腿全帧均值 `a_L/a_R`、最小 `a_min`、最大 `a_max`，类别基值 `base`、最差帧下限 `floor`：

```
diff = a_L − a_R
k    = min(1, 2·(base − floor) / |diff|)          # 左右差异幅度压缩系数（方向不变）
T_L  = base + k·diff/2 ,  T_R = base − k·diff/2   # 平均目标（保留作者左右方向）
Δ_leg = max(0, T_leg − a_leg , floor − a_min_leg)  # 只拉直（Δ≥0），且最差帧不破 floor
逐帧目标 t_leg(f) = a_leg(f) + Δ_leg               # 保留作者逐帧膝角变化 → range 不变
若 a_max + Δ > cap(179.5°) → 下调 Δ（本次未触发）
```

效果（与任务书「逐腿取 min(θ_target,180−1)、保留左右差异方向、不要强行左右均等」一致）：

- **只拉直不掰弯**：Δ_leg ≥0 → 逐帧 bake 后膝角 − 作者膝角最小 +0.95…+4.77°（§5.1 never_bend）；
- **左右差异方向 100% 保留**（`asymmetry_direction` 检查全 PASS）；多数 clip Δ_L≈Δ_R，左右差幅度原样保留；
  仅 3 条因「最差帧下限」需要单侧多拉：think01（ΔL 8.18°/ΔR 3.59°，作者 L−R=−7.39° → 后 −2.80°，方向保留、幅度压缩）、
  talk02（→2.18°）、commonIdle/adv-idle（→2.34°）；
- **逐帧膝角 range 原样保留**（目标 = 作者帧值 + 常数），不引入新的膝部抖动。

### 3.3 髋位移 δ：1 维最小二乘 δy + 极小 x/z 修正

膝角只由**髋→踝距离**唯一决定（余弦定理）：

```
d(θ) = sqrt(L1² + L2² − 2·L1·L2·cos θ)
```

**第一步（任务规定的 1 维最小二乘）**：解 δy 使两条腿的髋→踝距离同时逼近 d(t_leg)：

```
min_δy  Σ_i ( |v_i + δy·ŷ| − d_i )²      v_i = 髋_i − 踝_i（作者帧姿态）
δy clamp 到 [−1mm, +5mm]（本次实测 0.17…3.41mm，全部为正 = 抬髋）
```

**第二步（几何必需的小 x/z 修正，见 §8 R2）**：固定 δy 后，用 2×2 Gauss-Newton 解 (δx,δz) 使两腿距离
**同时精确命中** d_i，`|δxz| clamp ≤30mm`。原因是近伸直时左右膝角差 ↔ 距离差被强放大：
178° 附近 1° 膝角 ≈ 0.3mm 距离；作者左右膝角差 2–7° 对应 1.4–5.2mm 的左右距离差，而**只抬 hips.y 时两条腿的
距离变化几乎相同**（cos≈0.999），无法既保留左右差异又满足「最差帧」门禁（§5.5 实测：只用 δy 时 9/11 条门禁失败、
think01 脚位漂移 1.87mm）。水平修正的物理含义 = 站立时把骨盆移向承重腿（真实站姿本来如此）。

**第三步（IK）**：以髋' = 髋+δ、踝固定为作者踝位，两骨 IK 求新膝位：

```
solveKneePosition(hip', ankle, currentKnee, L1, L2, poleHint)
  u = normalize(ankle − hip'); d = clamp(|ankle−hip'|, |L1−L2|+1e-4, L1+L2−ikMargin)
  pole = (currentKnee−hip') 去掉沿 u 分量（近退化时用作者膝平面兜底）
  a = (L1²−L2²+d²)/(2d); h = sqrt(L1²−a²);  knee = hip' + u·a + pole·h
```

与 `src/renderer/src/vrm/foot-lock.ts:solveKneePosition` 同款算法；唯一差异：IK 距离余量
`ikMargin = 1e-6m`（运行时是 1mm 防抖余量，数据侧姿态自身可达 175.5–179.5°，不需要）。再按 foot-lock 的方式：

```
desiredUpperWorld = rotationFromTo(当前膝方向, 解算膝方向) × 当前UpperWorld
desiredLowerWorld = rotationFromTo(当前foot−膝, 目标踝−膝) × 当前LowerWorld
desiredFootWorld  = 作者脚世界朝向（保持脚掌朝向不变）
→ 逐骨 setLocalFromWorldQuat（parentWorld⁻¹ × desiredWorld）写回 normalized 局部 quaternion
```

### 3.4 写回 clip JSON

只改 7 条轨道：`Hips.p`（x/y/z 全部，按 `sourceHipsHeight/hipsRestHeight` 换算回源单位：`p_new = p_old + δ/scale`）
+ `Left/RightUpperLeg.r`、`Left/RightLowerLeg.r`、`Left/RightFoot.r`。
其余 45 条骨轨道 + 全部顶层字段（version/clip/mood/loop/fps/duration/sourceHeight/sourceHipsHeight/space/frames/
sourceClip/avatar/targetVrm/targetAvatarId/grounding/rawPolicy/rawMeta）**逐值保留**（有自动断言 `untouched_fields`）。
数值按现有数据约定 round 到 **7 位小数**（原数据全部是 7 位小数）；NaN/越界防护：写盘前逐帧检查有限性 + quat 归一化使用。

**贴地常量不变性（重要）**：bake 在「贴地偏移已应用」的姿态空间里解 IK 并保持踝/脚世界位置不变 ⇒ 成品 clip 的
首帧脚骨最低点不变 ⇒ 产品重新计算的 `groundOffset` 与原值相同（实测差 ~1e-8m）。因此产品播放 baked clip 时
贴地行为与原来完全一致，膝角就是我们验证的值。

### 3.5 loop 首尾

逐帧目标 = 作者帧值 + 常数 Δ，且脚位不动 ⇒ 成品首尾帧差 = 作者首尾帧差（不会引入新跳变）。
对作者首尾本身一致（≤0.1mm）的 clip，bake 后仍一致（7 条 loop clip 满足）；3 条作者自身 >0.1mm 见 §8 R4。

### 3.6 与任务书的偏差（Lead 已确认接受，2026-11-11 14:2x）

1. **髋位移在 1 维 δy 之外增加了 x/z 修正（Lead 决策：think01 保留、接受现状）**。
   任务书写「解 hips.y 抬升 δ（1 维最小二乘）」，但 1 维解在近伸直时**几何上无法同时**满足
   「保留作者左右差异方向」+「idle 最差帧 ≥174°」：只用 δy 时 9/11 条 clip 门禁失败（§5.5 有完整对照表，
   think01 还会把脚踝拉离目标 1.87mm，违反脚位门禁）。因此实现为「δy 用 1 维 LS（任务规定）+ 2D x/z 只做
   差分补偿」。Lead 决策：**允许该 x/z 修正（think01 28mm、talk02 11.8mm 均接受；脚不动即可，
   站立 idle 中身体轻微重心偏移可接受）**。

   **重要性质：脚位/脚朝向零漂移，仅骨盆整体微移。** 每条 clip 的髋位移分量（avatar.scene 局部米；px 按
   540px 宠物=311.4px/m、50% 用户尺寸 270px=155.7px/m 两档折算）：

   | clip | δx (mm) | δy (mm，抬升) | δz (mm) | \|δxz\| max (mm) | @540px | @50%（270px） |
   |---|---|---|---|---|---|---|
   | adv/bye01.json | 1.59 … 3.80 | 1.08 … 1.53 | −2.36 … −0.60 | 4.46 | 水平 1.39px / 抬升 0.48px | 水平 0.69px / 抬升 0.24px |
   | adv/idle.json | 4.30 … 5.01 | 1.50 … 1.67 | −2.09 … −1.82 | 5.43 | 水平 1.69px / 抬升 0.52px | 水平 0.85px / 抬升 0.26px |
   | adv/lookAtPhone.json | 0.08 | 0.56 | −0.03 | 0.09 | 水平 0.03px / 抬升 0.17px | 水平 0.01px / 抬升 0.09px |
   | adv/scratchHead01.json | 0.42 … 2.52 | 1.64 … 1.77 | 0.04 … 0.29 | 2.54 | 水平 0.79px / 抬升 0.55px | 水平 0.40px / 抬升 0.28px |
   | adv/talk01.json | 0.43 … 1.13 | 0.47 … 0.49 | −0.44 … −0.20 | 1.21 | 水平 0.38px / 抬升 0.15px | 水平 0.19px / 抬升 0.08px |
   | adv/talk02.json | 5.47 … 10.52 | 1.03 … 1.42 | −5.37 … −2.02 | 11.81 | 水平 3.68px / 抬升 0.44px | 水平 1.84px / 抬升 0.22px |
   | **adv/think01.json** | **−27.24 … −26.30** | 3.31 … 3.41 | −6.55 … −6.31 | **28.01** | **水平 8.72px** / 抬升 1.06px | **水平 4.36px** / 抬升 0.53px |
   | adv/useheadphone01loop.json | −2.23 … −2.13 | 0.17 … 0.18 | −0.14 … −0.09 | 2.23 | 水平 0.70px / 抬升 0.06px | 水平 0.35px / 抬升 0.03px |
   | adv/watchphone01loop.json | −0.09 … 0.09 | 0.61 … 0.62 | −0.03 … 0.03 | 0.10 | 水平 0.03px / 抬升 0.19px | 水平 0.02px / 抬升 0.10px |
   | adv/worry01.json | −3.62 … −2.85 | 2.18 … 2.25 | 0.08 … 0.13 | 3.63 | 水平 1.13px / 抬升 0.70px | 水平 0.56px / 抬升 0.35px |
   | hsr/commonIdle.json | 4.34 … 5.39 | 1.49 … 1.66 | −0.02 … 0.07 | 5.39 | 水平 1.68px / 抬升 0.52px | 水平 0.84px / 抬升 0.26px |

   > 数据源：`diff-stats.json`（δ 分量，源单位 p 差值 × hipsPositionScale 换算为米）与 `metrics.json` 的
   > `bake.horizMaxMm / after.hipsLiftMaxAbsMm`。δx/δz 的逐帧变化 ≤1.5mm（平滑），不会引入身体抖动。
2. **loop 连续性判定为「不劣化」而非绝对值 ≤0.1mm**（Lead 已确认按现状、不算回归）：本批 3 条 loop clip 的
   作者原数据首尾差本身 >0.1mm（commonIdle 0.673mm、think01 0.112mm、useheadphone01loop 0.110mm；≈0.2px 级），
   在「脚位不动、不改上半身」约束下无法修复（见 §8 R4）；其余 7 条 bake 后 ≤0.1mm。测试实现为
   「bake 后 wrap − 作者 wrap ≤0.1mm；若作者 ≤0.1mm 则 bake 后也必须 ≤0.1mm」。

---

## 4. 参数

| 参数 | 值 | 说明 |
|---|---|---|
| idleBaseDeg / idleFloorDeg | 175.5° / 174.1° | idle 目标均值 / 最差帧下限（accepted 174 + 0.1 余量） |
| idleAcceptAvgDeg / idleAcceptWorstDeg | 175.5° / 174° | 验收门禁 |
| socialBaseDeg / socialFloorDeg | 173° / 170.2° | 社交/一次性目标均值 / 最差帧下限（accepted 170 + 0.2 余量） |
| socialAcceptAvgDeg / socialAcceptWorstDeg | 172° / 170° | 验收门禁 |
| capDeg | 179.5° | 逐腿目标上限（min(θ,180−1) 的保守实现） |
| maxLiftMm / minLiftMm | +5mm / −1mm | δy 钳制 |
| maxHorizontalMm | 30mm | δxz 钳制（见 §3.6 偏差 1） |
| ikMarginM | 1e-6m | 数据侧 IK 距离余量（运行时 1mm） |
| kneeRangeGrowthDeg | 0.5° | range 不增门禁 |
| footDriftMm / footOrientationDeg | 0.5mm / 0.5° | 脚位/脚朝向门禁 |
| loopContinuityMm | 0.1mm | loop 不劣化门禁 |
| staticKneeRangeMaxDeg / bentMeanKneeMaxDeg | 10° / 174° | 筛选条件 |
| 写回精度 | 7 位小数 | 与现有 clip 数据一致 |

---

## 5. 验证结果（apply 前全部通过）

### 5.1 门禁总表

| 门禁 | 要求 | 实测（11 条 clip 的最差/最大） | 结论 |
|---|---|---|---|
| idle 膝角均值 | ≥175.5° | 175.50°（think01/worry01/scratchHead 恰 175.5） | PASS |
| idle 最差帧 | ≥174° | 174.10°（commonIdle/adv-idle/think01） | PASS |
| 社交 膝角均值 | ≥172° | 173.00°（talk01/bye01/lookAtPhone/watchphone） | PASS |
| 社交 最差帧 | ≥170° | 170.20°（talk02/useheadphone） | PASS |
| 逐帧命中目标 | max\|after−target\| ≤0.05° | ≤0.0001° | PASS |
| 脚位漂移 | <0.5mm | ≤0.0009mm（≈1e-10m 级） | PASS |
| 脚朝向漂移 | <0.5° | ≤0.000003° | PASS |
| Hips 抬升 | ≤5mm | δy 0.17–3.41mm（全部为正） | PASS |
| Hips 水平修正 | ≤30mm（自设上限） | 最大 28.01mm（think01）；其余 ≤11.8mm | PASS（见 R1/R2） |
| 膝 range 不增 | ≤+0.5° | 最大 +0.0003° | PASS |
| loop 不劣化 | 增量 ≤0.1mm；作者≤0.1 时后≤0.1 | 增量 ≤0.002mm；7 条作者≤0.1 → 后≤0.081mm | PASS（见 R4） |
| 无 NaN | 0 | 0 | PASS |
| 只改允许轨道 | 其他逐位不变 | 45 骨轨道 + 顶层字段不变 | PASS |
| 只拉直不掰弯 | 后−作者 ≥0 | 最小 +0.95°（useheadphone R 因已 176.2° 保持 0） | PASS |
| 左右差异方向 | 符号一致 | 11/11 方向保留 | PASS |
| 求解残差 | ≤0.05mm | 0（<1e-8mm） | PASS |

> 脚本内共 **165 项断言（11×15）全部 PASS**；`metrics.validation.passed=true`。
> （`tests/tmp/bake-leg/metrics.json` 中每条 clip 有 `validation.checks` 明细。）

### 5.2 逐 clip before / after

| # | clip | 类别 | 作者膝角均值 L/R | bake 后 L/R | 作者最差帧 | bake 后最差 | ΔL/ΔR | 左右差（前→后） |
|---|---|---|---|---|---|---|---|---|
| 1 | adv/bye01.json | social | 171.717 / 169.377 | **174.170 / 171.830** | 168.124 | **170.577** | +2.45/+2.45° | 2.34→2.34° |
| 2 | adv/idle.json | idle | 173.188 / 170.597 | **176.796 / 174.459** | 170.238 | **174.100** | +3.61/+3.86° | 2.59→2.34° |
| 3 | adv/lookAtPhone.json | social | 171.960 / 171.854 | **173.053 / 172.947** | 171.854 | **172.947** | +1.09/+1.09° | 0.11→0.11° |
| 4 | adv/scratchHead01.json | idle | 172.050 / 171.171 | **175.940 / 175.060** | 171.095 | **174.985** | +3.89/+3.89° | 0.88→0.88° |
| 5 | adv/talk01.json | social | 173.068 / 171.042 | **174.013 / 171.987** | 170.867 | **171.813** | +0.95/+0.95° | 2.03→2.03° |
| 6 | adv/talk02.json | social | 173.427 / 169.715 | **174.856 / 172.675** | 167.240 | **170.200** | +1.43/+2.96° | 3.71→2.18° |
| 7 | adv/think01.json | idle | 165.925 / 173.314 | **174.100 / 176.900** | 165.925 | **174.100** | +8.18/+3.59° | −7.39→−2.80° |
| 8 | adv/useheadphone01loop.json | social | 169.916 / 176.155 | **170.449 / 176.155** | 169.667 | **170.200** | +0.53/0.00° | −6.24→−5.71° |
| 9 | adv/watchphone01loop.json | social | 171.771 / 171.823 | **172.974 / 173.026** | 171.614 | **172.817** | +1.20/+1.20° | −0.05→−0.05° |
| 10 | adv/worry01.json | idle | 169.959 / 171.497 | **174.731 / 176.269** | 169.769 | **174.541** | +4.77/+4.77° | −1.54→−1.54° |
| 11 | hsr/commonIdle.json | idle | 173.201 / 170.615 | **176.793 / 174.456** | 170.258 | **174.100** | +3.59/+3.84° | 2.59→2.34° |

> 左右差列：多数 clip 方向与幅度原样保留；think01/talk02/useheadphone 因「最差帧下限」单侧多拉而压缩幅度（方向不变），
> 见 `asymmetry_direction` 检查（11/11 PASS）。

### 5.3 位移 / 脚位 / loop / 视觉代价

| clip | δy 范围 (mm) | \|δxz\| max (mm) | 抬升 (px@540) | 水平 (px@540) | 脚位漂移* | 脚朝向漂移 | loop wrap 作者→后 (mm) | Δrange L/R |
|---|---|---|---|---|---|---|---|---|
| adv/bye01.json | 1.09–1.53 | 4.46 | 0.48 | 1.39 | <0.001mm | 3e-6° | 非 loop | 0 / 0 |
| adv/idle.json | 1.50–1.67 | 5.43 | 0.52 | 1.69 | <0.001mm | 2e-6° | 0.0367→0.0366 | 0 / 0 |
| adv/lookAtPhone.json | 0.56 | 0.09 | 0.17 | 0.03 | <0.001mm | 3e-6° | 0.0004→0.0010 | 0 / 0 |
| adv/scratchHead01.json | 1.64–1.77 | 2.54 | 0.55 | 0.79 | <0.001mm | 3e-6° | 0.0398→0.0400 | 0 / 0 |
| adv/talk01.json | 0.47–0.49 | 1.21 | 0.15 | 0.38 | <0.001mm | 3e-6° | 非 loop | 0 / 0 |
| adv/talk02.json | 1.03–1.42 | **11.81** | 0.44 | **3.68** | <0.001mm | 3e-6° | 非 loop | 0 / 0 |
| adv/think01.json | 3.31–3.41 | **28.01** | 1.06 | **8.72** | <0.001mm | 3e-6° | 0.1119→0.1117 | 0 / 0 |
| adv/useheadphone01loop.json | 0.17–0.18 | 2.23 | 0.06 | 0.70 | <0.001mm | 2e-6° | 0.1101→0.1105 | 0 / 0 |
| adv/watchphone01loop.json | 0.61–0.62 | 0.10 | 0.19 | 0.03 | <0.001mm | 3e-6° | 0.0814→0.0810 | 0 / 0 |
| adv/worry01.json | 2.18–2.25 | 3.63 | 0.70 | 1.13 | <0.001mm | 2e-6° | 0.0332→0.0332 | 0 / 0 |
| hsr/commonIdle.json | 1.49–1.66 | 5.39 | 0.52 | 1.68 | <0.001mm | 3e-6° | 0.6729→0.6750 | 0 / 0 |

\* bake 内部全精度踝位漂移 <1e-9m；表中值为「产品口径用 6 位小数坐标复算」的上限（0.0008–0.0009mm 级，来自坐标存储精度）。
px 换算：540px 宠物 / 1.734m 模型 = 311.4 px/m。

### 5.4 产品口径验证（`parseClipData` + sampling）与 no-op 往返

- **`tests/tmp/bake-leg/validate-product-parse.test.ts`：15/15 PASS**（约 2s）：
  - 每个 baked JSON 用**产品** `parseClipData` 解析：`errors=[]`、帧数/fps/loop/sourceHipsHeight 与原文件一致、
    **不引入新 warnings**；腿/hips 轨道齐全；
  - 用产品 `sampleBoneRotation`/`sampleScaledHipsPosition` 在整帧时间采样 → 与写盘 JSON 原值一致
    （唯一差异是 loop clip 整帧时间因浮点落在帧间时产品会 slerp+归一化，~5e-8 量级）；
  - 用产品采样 + 产品贴地口径逐帧复算：**膝角均值/最差达标**、与 bake 内部 FK 的膝角差 **<0.01°**、
    脚位/脚朝向漂移、Hips 位移、range、loop 全部门禁 PASS；
  - **贴地常量不变**：baked clip 重算 groundOffset 与原文件差 <1e-6m（实测 ~1e-8m）；
  - 与 `audit-author.json` 作者 FK 对拍：11 条膝角均值差 **≤0.04°**（口径无漂移）；
  - `apply/rollback 沙盒端到端`：在 `/tmp` 副本上验证 apply 幂等、失败自动回滚、二次 bake 防护、rollback 恢复
    （详见 `run-logs/apply-rollback-sandbox.log`）。
- **no-op 往返自检**（bake 前自动跑，11/11）：原 clip 经「读→写回→重新解析→应用」后，
  全帧膝角/关节位置差 **0**（原数据即 7 位小数，写回路径逐值一致），证明先解析→应用→读回→写盘链路无损。

### 5.5 对照：只用 1 维 δy（`--max-horizontal-mm 0`）会失败

| clip | 1 维 δy 达成 均值 L/R | 1 维最差 | 1 维门禁 | 3-DOF 后 均值 L/R | 3-DOF 最差 |
|---|---|---|---|---|---|
| adv/bye01.json | 174.73/171.48 | 170.18 | FAIL（逐帧目标差 0.95°、range+0.65°） | 174.17/171.83 | 170.58 |
| adv/idle.json | 179.37/173.55 | 173.22 | FAIL（worst<174） | 176.80/174.46 | 174.10 |
| adv/lookAtPhone.json | 173.07/172.93 | 172.94 | PASS（几乎对称） | 173.05/172.95 | 172.95 |
| adv/scratchHead01.json | 176.42/174.73 | 174.44 | FAIL（逐帧目标差 0.94°、range+0.83°） | 175.94/175.06 | 174.99 |
| adv/talk01.json | 174.18/171.87 | 171.66 | FAIL（逐帧目标差 0.24°） | 174.01/171.99 | 171.81 |
| adv/talk02.json | 177.18/171.55 | 169.00 | FAIL（worst<170、range+2.1°） | 174.86/172.68 | 170.20 |
| adv/think01.json | 170.07/**179.83** | 170.02 | **FAIL（avg/worst、脚位漂移 1.87mm）** | 174.10/176.90 | 174.10 |
| adv/useheadphone01loop.json | 170.18/176.91 | 169.93 | FAIL（worst<170） | 170.45/176.16 | 170.20 |
| adv/watchphone01loop.json | 172.97/173.03 | 172.80 | PASS（几乎对称） | 172.97/173.03 | 172.82 |
| adv/worry01.json | 174.09/177.42 | 173.86 | FAIL（worst<174） | 174.73/176.27 | 174.54 |
| hsr/commonIdle.json | 179.34/173.56 | 173.21 | FAIL（worst<174、range+0.55°） | 176.79/174.46 | 174.10 |

> 完整数据：`tests/tmp/bake-leg/yonly-check/metrics.json`（bake 的 `validation.passed=false`）。
> 这正是 §3.6 偏差 1 的量化依据：纯 1 维版本只对 2 条几乎对称的 clip 成立，且会把「较直的那条腿」顶到
> 180° 上限、把脚踝拉离固定点（think01 1.87mm > 0.5mm 门禁）。

### 5.6 视觉证据（离线渲染，不启动 Electron）

复现命令：`node tests/tmp/bake-leg/render-visual-evidence.mjs`（约 0.5s）。实现：Node 内 three.js 加载真实 VRM
（去贴图/材质，只留几何+蒙皮），复刻产品 clip 层序摆姿势，**CPU 蒙皮**（`SkinnedMesh.applyBoneTransform`）后只保留
以腿骨为权重主导的三角形，正交投影 + 自写 z-buffer 光栅化（2× 超采样），sharp 合成 PNG。前后两张图共用同一取景
（before∪after 包围盒），代表帧取「作者膝角最差帧」。

**A. 11 条 clip 的 before/after 膝角柱状图**（含 idle/社交目标线）：

![11 条 clip before/after 膝角柱状图](../tests/tmp/bake-leg/visual/knee-angles-before-after.png)

**B. 代表 clip 的腿部渲染对比**（列：FRONT 正面 / SIDE 侧面 / OVERLAY 差异；行：BEFORE 作者 / AFTER baked；
overlay 中红=仅 before、蓝=仅 after、深灰=两者）：

| clip | 图 | 代表帧 | 膝角 before→after | 膝关节点位移（@540px） |
|---|---|---|---|---|
| adv-think01（最大变化 + 强左右不对称 + 28mm 骨盆侧移） | [legs-adv-think01.png](../tests/tmp/bake-leg/visual/legs-adv-think01.png) | 4/83（作者最差帧 165.9°） | L 165.9→174.1° / R 173.6→177.1° | L 27.5mm=8.6px / R 19.6mm=6.1px |
| hsr-commonIdle（idle 轮换池典型对称站姿） | [legs-hsr-commonIdle.png](../tests/tmp/bake-leg/visual/legs-hsr-commonIdle.png) | 225/250（最差帧 170.3°） | L 173.0→176.6° / R 170.3→174.1° | L 15.3mm=4.8px / R 14.9mm=4.6px |
| adv-talk02（社交一次性，左右差压缩） | [legs-adv-talk02.png](../tests/tmp/bake-leg/visual/legs-adv-talk02.png) | 33/105（最差帧 167.2°） | L 173.2→174.6° / R 167.2→170.2° | L 6.1mm=1.9px / R 8.7mm=2.7px |

> 图中可见：**脚/鞋轮廓在 before/after 完全重合**（脚位/脚朝向零漂移），变化只在膝—小腿段与骨盆（overlay 的红/蓝
> 边界集中在膝部与大腿外侧）；正面图展示左右膝不对称的消除，侧面图展示屈膝向后收直；overlay 直观给出真实位移量级。

![adv-think01 腿部 before/after（front/side/overlay）](../tests/tmp/bake-leg/visual/legs-adv-think01.png)

![hsr-commonIdle 腿部 before/after（front/side/overlay）](../tests/tmp/bake-leg/visual/legs-hsr-commonIdle.png)

![adv-talk02 腿部 before/after（front/side/overlay）](../tests/tmp/bake-leg/visual/legs-adv-talk02.png)

---

## 6. diff 统计

| 项 | 数值 |
|---|---|
| 改动文件 | 11 个 clip JSON（仅内容变化，路径/id/manifest 不变） |
| 改动轨道（每文件） | **7 条**：`Hips.p` + 左/右 `UpperLeg.r`/`LowerLeg.r`/`Foot.r` |
| 未改动轨道 | 其余 45 条骨轨道 + 顶层元数据（自动断言） |
| 改动数值 | 35,823 / 279,997 个数字（12.79%，= 帧数 × 27 个分量） |
| 未改动数值 | 244,174 个（87.21%） |
| Hips 旋转 | **完全不变**（只改 Hips.p 平移） |
| 旋转改变量（跨 clip max） | UpperLeg ≤3.51°、LowerLeg ≤8.48°、Foot ≤5.48°（Foot 变化是保持脚世界朝向的反解） |
| Hips.p 改动 | x 最多 ±27.24mm、y（抬升）0.17–3.41mm、z 最多 ±6.55mm（源单位见 manifest scale） |
| 文件体积 | 2,901,255 → 2,924,933 字节（+0.82%） |
| 视觉代价 | 抬升 ≤1.06px、水平修正 ≤8.72px（仅 think01；其余 ≤3.68px） |
| 完整数据 | `tests/tmp/bake-leg/diff-stats.json` |

---

## 7. apply 与回滚

### 7.0 apply 执行记录（2026-11-11 14:22:52 +08:00）

- 触发：Lead 复核 task-2 运行时代码 gates/acceptance 全绿 + dev-capture PASS 后**明确批准 apply**；
- 命令：`node scripts/vrm/motion/straighten-standing-knees.mjs apply --yes`；
- 结果：**11 条写入 + 写后复验 PASS**（0 条 already-applied、0 条失败、无自动回滚）；耗时 ~0.6s；
- 校验：真实 `assets/motions/**` 逐文件 sha256 == `staging-manifest.sha256After` **11/11**；
  备份目录逐文件 sha256 == `sha256Before` **11/11**；`validate` PASS；apply 后产品口径 vitest **15/15 PASS**
  （原始文件此时自动取自备份目录做 before/after 对比）；
- 记录：`tests/tmp/bake-leg/apply-result.json`（`appliedAt=2026-11-11T06:22:52.630Z`、`restored=false`、
  11 条 `action=written` + backup 路径）；
- 备份目录 `assets/motions-leg-backup-2026-11-11/`（11 个文件）**未被 .gitignore 覆盖**（`git check-ignore` 无命中，
  `git status` 显示为 untracked `?? assets/motions-leg-backup-2026-11-11/`）；本任务**未改 .gitignore、未 commit**，
  commit 时请 Lead 排除该目录；
- 回滚（如需）：`node scripts/vrm/motion/straighten-standing-knees.mjs rollback --yes` → 11 条恢复 + sha 校验；
  回滚前请确认没有其他进程正在读 assets（apply 后 Lead 已用 dev-capture 读 assets 做最终实机核验，本任务不再改数据）。

### 7.1 apply 前检查清单（Lead，已于 apply 前执行）

1. `node scripts/vrm/motion/straighten-standing-knees.mjs validate` → PASS（可选，重新校验 staging sha + 数值）；
2. `./node_modules/.bin/vitest run --config tests/tmp/bake-leg/vitest.config.mts` → 15/15 PASS（产品口径 + 沙盒 apply）；
3. 确认本报告 §8 风险（尤其 R1 think01 的 8.7px 水平位移）可接受；如需剔除某条 clip：apply 前用
   `--exclude think01` 重新 bake（会更新 staging），或直接编辑 `staging-manifest.json`；
4. 确认另一 teammate 的 dev-capture 已结束（避免与真实 assets 写入同时进行）。

### 7.2 命令（apply 会改真实 `assets/motions/**`）

```bash
# 备份 → 原子写入（tmp+rename）→ SHA256 校验 → 写后复验（与 bake 同一套产品口径 FK 门禁）
# 任何一步失败：自动从备份回滚本次写入，exit 1
node scripts/vrm/motion/straighten-standing-knees.mjs apply --yes

# 幂等：再次执行 apply → 0 条写入（全部 already-applied），不会重复备份/写入
# 二次 bake 防护：apply 后再跑 bake 会拒绝（资产 sha == staging sha256After）

# 一键回滚（幂等；staging 清单丢失时可退化扫备份目录恢复）
node scripts/vrm/motion/straighten-standing-knees.mjs rollback --yes

# 仅预览 apply 计划（不写盘）
node scripts/vrm/motion/straighten-standing-knees.mjs apply --dry-run
```

- 备份目录：`assets/motions-leg-backup-2026-11-11/<相对路径>`（11 个原文件，SHA256 与 bake 时一致）；
- **注意**：该备份目录不在 `.gitignore` 覆盖范围内（`assets/motions/` 才是 ignored），apply 后会在 `git status`
  出现为 untracked；**不要 commit**，确认稳定后可删除备份目录（删除前先保留报告/清单，`rollback` 将不可用）；
- 真实 `assets/**` 目前**完全未改**（11/11 sha256Before 校验通过）。

### 7.3 apply/回滚演练证据（离线沙盒，已自动化）

`tests/tmp/bake-leg/run-logs/apply-rollback-sandbox.log` + vitest 用例，覆盖：
首次 apply 11 条写入 + 写后复验 PASS、二次 apply 0 条写入（幂等）、apply 后 bake 拒绝（防二次拉直）、
`--simulate-fail-after-write` 写入后自动回滚（11/11 恢复 sha256Before）、rollback 恢复、rollback 幂等；
并断言真实 `assets/**` 在这套测试中从未被写（sha 不变）。

**回滚校验输出摘要（沙盒，2026-11-11 14:04）：**

```
## 1) 首次 apply --yes          → 已写入 11 个 clip；写后复验：PASS；apply：PASS（11 条写入，全部复验通过）
## 2) 再次 apply --yes（幂等）  → 已写入 0 个 clip（11 个已是目标状态/跳过）；写后复验：PASS
## 3) 二次 bake 防护            → 没有可 bake 的 clip（全部被筛掉）（exit 1）
## 4) rollback --yes            → 11 条恢复（备份目录 …/backup）
## 5) rollback 幂等             → 0 条恢复（11 个已是原文件，跳过）
## 6) 失败自动回滚演练           → apply --simulate-fail-after-write：写入 11 条后自动回滚，
                                   逐个「✓ 已恢复 <file>」；自动回滚完成：assets/** 已恢复原文件
## 7) 回滚后 SHA 校验            → ALL 11 RESTORED OK (sha256Before)
```

安全机制（apply 实现）：
1. **apply 前**：读 `staging-manifest.json`（bake 时记录的 11 个文件 `sha256Before`/`sha256After`）+ 当前资产
   sha 三元分类（pending / already-applied / asset-changed…）；staged 文件 sha 必须 == sha256After，否则拒绝；
   `metrics.validation.passed` 必须为 true；备份若已存在必须 == sha256Before（防覆盖错误备份）；
2. **写入**：先备份（不存在才写）→ 校验备份 sha == sha256Before → 同目录 tmp + rename 原子替换 →
   校验写入后 sha == sha256After；
3. **写后复验**：用真实 `assets` 文件重新跑与 bake 相同的 15 项 FK/数值门禁，任一失败 → **自动回滚本次写入**
   （逐文件从备份恢复并校验 sha）→ exit 1；
4. **幂等**：再次 apply 时资产 sha == sha256After → 全部 already-applied、0 写入；
5. **rollback**：`rollback --yes` 逐文件从备份恢复（已在还原态则跳过），staging manifest 丢失时**直接扫备份目录兜底**。

---

## 8. 风险 / 未决（请 Lead 决策）

**R1｜accept 决策：adv-think01 水平修正 28.0mm（@540px 8.72px、@50% 4.36px）**
- 原因：作者左右膝角差 7.39°（165.93° vs 173.31°），近伸直时对应左右髋→踝距离差 ~5.2mm；要同时满足
  「idle 均值≥175.5° + 最差≥174°」与脚位不动，几何上必须把骨盆向承重侧平移 ~28mm。
- **Lead 决策（2026-11-11）：保留 think01，接受现状**。影响：该 clip（idle 轮换池 priority −7，约 1/9 变体出现）
  身体相对脚位水平偏 ~8.7px（@50% 用户尺寸 ~4.4px），观感是「重心偏向一侧的站姿」；**脚位/脚朝向零漂移，
  仅骨盆整体微移**，无滑步；变体切换时在 0.8–1s crossfade 内平滑过渡。分量/像素见 §3.6 表。
- 备选（已不采用）：移动脚位 2.2mm（违反 0.5mm 门禁）/ 降低目标膝角（违反 idle 门禁）/ 改 Hips 旋转（超出任务边界）。

**R2｜x/z 修正的分布**：除 think01 外，talk02 11.8mm（@540px 3.68px、@50% 1.84px）也超过 1px；其余 9 条
≤5.5mm（@540px ≤1.7px）。Lead 决策：接受。若未来要求严格 1 维，需接受 9/11 条不达标或大幅缩减清单（§5.5）。

**R3｜社交/一次性目标的选择**：任务书要求社交/一次性「≥173°」，同时验收线是 avg≥172°/worst≥170°。本实现取
base=173°（所以最差帧下限 170.2°）。lookAtPhone/watchphone 作者本就 171.8–172°，因此只拉直 ~1.1–1.2°（视觉变化很小）。
若希望社交片更直（如 174–175°），改 `--social-base` 重新 bake 即可，代价是水平/抬升修正增大。

**R4｜loop 首尾（口径说明，Lead 已确认按现状、不算回归）**：3 条 loop clip 作者自身首尾差 >0.1mm
（commonIdle 0.673mm、think01 0.112mm、useheadphone01loop 0.110mm，均是作者数据固有、≈0.2px 级、肉眼不可见）；
bake 保持不劣化（增量 ≤0.002mm），其余 7 条 ≤0.1mm。若未来必须绝对 ≤0.1mm：需移动脚位
（commonIdle 需 0.67mm > 0.5mm 脚位门禁）或改作者数据，不在本任务范围。

**R5｜运行时交互**：baked idle clip 在运行时仍会叠加 micro-motion + foot-lock（task-2 候选 g）。数据侧只保证
「作者姿态」变直；运行时最终腿形由 task-2 修复决定（候选 g 会把运行时额外弯曲压到 ≤2.7°）。一次性 clip 路径
（allow=false）腿形 = 作者 = 本 bake 结果，是本次修复的主要收益路径。**建议 apply 后由 task-2 做一次
dev-capture 目视 QA**（作者渲染与运行时对比：`PET_DEV_CAPTURE_POSES=hsr-commonIdle,adv-idle,adv-think01,adv-worry01,adv-scratchHead01,adv-talk01,adv-lookAtPhone`，
隔离 HOME/PET_PROFILE），确认无「膝盖过伸/腿型僵硬/身体偏移」观感问题（自动化只能保证数值门禁）。

**R6｜备份目录未被 gitignore**：见 §7.2，勿 commit。

**R7｜其他 session 并发**：本任务只新增 `scripts/vrm/motion/straighten-standing-knees.mjs`（untracked）+ 追加
`scripts/vrm/motion/README.md` 说明 + `docs/fix-report-2026-11-11-standing-leg-data-bake.md` + `tests/tmp/bake-leg/**`；
未改 `src/**`、未改被 `pnpm test` 收集的测试、未 commit。工作区其它改动（foot-lock 等）来自 task-2/其它 session。

---

## 9. 复现方式

```bash
cd /Volumes/4TB外置盘/deepseek-harness/aventurine-pet-vrm   # HEAD f217521

# 分析（~1.3s）：目标池全帧 FK 统计 + 筛选 + 剔除原因
node scripts/vrm/motion/straighten-standing-knees.mjs analyze

# bake（~3.5s）：staging + metrics + 165 项数值验证（bake 幂等，重复跑 byte-identical）
node scripts/vrm/motion/straighten-standing-knees.mjs bake

# 产品口径验证（parseClipData + sampling + apply/rollback 沙盒端到端，~2.2s）
./node_modules/.bin/vitest run --config tests/tmp/bake-leg/vitest.config.mts
```

环境：Node v24.21.0、three 0.171、@pixiv/three-vrm 3.5.5（复用仓库 devDependencies；无 Unity 依赖）。
真实 VRM 加载 ~30ms（脚本会去掉贴图/材质只留骨架，FK/IK 不需要材质）。

---

## 10. 证据路径

| 路径 | 内容 |
|---|---|
| `scripts/vrm/motion/straighten-standing-knees.mjs` | 主脚本（analyze/bake/validate/apply/rollback；约 1.6k 行，中文注释含公式） |
| `scripts/vrm/motion/README.md` | 追加「数据侧膝拉直 bake」章节（命令/口径/产物） |
| `docs/fix-report-2026-11-11-standing-leg-data-bake.md` | 本报告 |
| `tests/tmp/bake-leg/staging/<relPath>` | **apply 源**：11 个 baked clip JSON |
| `tests/tmp/bake-leg/metrics.json` | 逐 clip 指标 + 逐帧 before/after/目标/位移/脚位 + 165 项验证明细 |
| `tests/tmp/bake-leg/staging-manifest.json` | apply 清单：sha256Before/After、staging/资产/备份路径、参数 |
| `tests/tmp/bake-leg/diff-stats.json` | 改动轨道/数值 diff 统计 |
| `tests/tmp/bake-leg/validate-product-parse.test.ts` + `vitest.config.mts` | 产品 parseClipData 口径验证 + apply/rollback 沙盒端到端（15 tests） |
| `tests/tmp/bake-leg/run-logs/apply-rollback-sandbox.log` | apply/rollback/失败自动回滚演练日志 |
| `tests/tmp/bake-leg/yonly-check/metrics.json` | 「纯 1 维 δy」对照实验（9/11 门禁失败的证据） |
| `tests/tmp/bake-leg/render-visual-evidence.mjs` | 视觉证据生成脚本（离线 CPU 蒙皮渲染 + 柱状图；~0.5s） |
| `tests/tmp/bake-leg/visual/knee-angles-before-after.png` | 11 条 clip before/after 膝角柱状图（含目标线） |
| `tests/tmp/bake-leg/visual/legs-{adv-think01,hsr-commonIdle,adv-talk02}.png` | 3 条代表 clip 腿部 before/after×front/side/overlay 渲染对比 |
| `tests/tmp/inv-leg2/REPORT.md` §13、`run-logs/audit-author.json` | 上游调查（只读复用，未修改） |

---

## 11. 附：staging 文件 SHA256（前 16 位）

| 文件 | before | after |
|---|---|---|
| adv/bye01.json | `a1bf0eca2eb05525` | `806bbc8e7b758681` |
| adv/idle.json | `d3009cffeea58466` | `89293012bb06bc9b` |
| adv/lookAtPhone.json | `6a15d3c65db8cc80` | `314754caf807c5c0` |
| adv/scratchHead01.json | `b30da521e7a3ff8e` | `32d877f054a29185` |
| adv/talk01.json | `d004d0a0b6087b91` | `8827d3b7341d1671` |
| adv/talk02.json | `9ab480b5ebb98bec` | `e41a6bc8bf88169f` |
| adv/think01.json | `061477acc4f014d7` | `595a0b5e3e1ff567` |
| adv/useheadphone01loop.json | `7cb7ac743f34f771` | `a11f44e03a54e825` |
| adv/watchphone01loop.json | `3e02c710ec92dab2` | `4c055a00f3eb861c` |
| adv/worry01.json | `5fae242162f4f340` | `727f74405c85ceec` |
| hsr/commonIdle.json | `87bab091902a2300` | `75f0698360b78c9c` |

---

## 12. Lead 独立复核（apply 后，2026-11-11 14:24–14:31）

> 复核人：Lead。apply 由 Lead 复核 staging/验证后批准（14:22:52 执行，11/11 写入、写后复验 PASS），
> 随后 Lead 用独立 dev-capture 核验 bake 生效与运行时代码叠加后的最终效果。

### 12.1 独立核验数字（真实 VRM + 当前 assets + 运行时代码 v2）

- 作者姿态渲染（`tests/tmp/lead-verify/final/author/`，真实 app 渲染、manual 槽位）：
  bake 生效后的 idle 轮换池膝角 **174.1–177.7°**（flex ≤5.4°；bake 前 adv-think01 165.9°、adv-idle 170.7° 等）；
  社交一次性池 **171.7–174.6°**（bake 前 167–173°）；与 staging 指标一致（差异在单帧采样波动内）。
- 运行时 idle（240×500ms，静态双足帧 195）：运行时膝角 = 作者膝角（逐帧 max Δ **0.70°**），
  脚位零漂移（footError max 0.0001m、`|hipShiftXZ|` max 0.085m、无 fallback/NaN）。
- 一次性/manual 路径（IdleOneShotFidget 等）：运行时膝角 = 作者（bake 后），转场帧无 >2° 回弹。
- 用户尺寸 50%（270px）idle：目视全帧腿部直立，与用户 12:53 旧版截图对比明显改善
  （本地证据 `/tmp/petcap/user-before-after.png`）。

### 12.2 Lead 决策（已在 §8 标注）

1. `adv-think01` 保留，接受 bake 后骨盆 x/z 偏 28.01mm（8.72px@540 / 4.36px@50%）：脚位/脚朝向零漂移，
   观感为重心偏一侧；不剔除（否则该 clip 保持 14° 作者屈膝）。
2. 3 条 loop clip 作者原数据自身首尾差 0.11–0.67mm（≈0.2px）不计为回归；bake 不劣化。
3. 备份目录 `assets/motions-leg-backup-2026-11-11/` 保留（本地回滚用，不提交）；
   一键回滚：`node scripts/vrm/motion/straighten-standing-knees.mjs rollback --yes`。

### 12.3 结论

数据侧 bake 达标（脚位零漂移、膝角达目标、可回滚），与运行时 v2 叠加后全站立可见路径腿形达标；
本报告与 bake 脚本由 Lead 复核后提交（assets 为本地资产，不进 git）。
