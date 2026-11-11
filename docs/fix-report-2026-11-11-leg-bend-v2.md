# 修复报告：全站立姿势腿部异常弯曲（运行时候选 g · v2）

> 日期：2026-11-11 · 执行：leg-fixer2（task-2 subagent）· 基线 HEAD `f217521`
> 相关调查：`tests/tmp/inv-leg2/REPORT.md` §12（候选 g）与 §13（全站立审计）
> 关联任务：task-1（调查，已完成）、task-3（数据侧 bake，见
> [fix-report-2026-11-11-standing-leg-data-bake.md](fix-report-2026-11-11-standing-leg-data-bake.md)）
> **状态：✅ Lead 已复核并提交（2026-11-11，见 git log）；数据侧 bake 已 apply 并与本修复叠加验收。**

---

## 0. TL;DR

用户反馈「桌宠站着时腿是弯的，很多动作都有」。调查（REPORT §2/§13）把它拆成三类来源：

| 类 | 来源 | 占比/规模 | 本任务是否修 |
|---|---|---|---|
| **R（运行时放大）** | micro-motion 程序化骨盆平移被 IK 吸收（62%）+ 旧 A 跨变体均值对齐的固有距离残差（38%） | idle 平均 Δ膝 −15°/−4°、最差 −28° | ✅ 运行时候选 g 修复 |
| **D（作者数据本身屈膝）** | 110 条站立 clip 中 65 条作者膝角均值 <174°（用户可见池约 14 条，adv 社交/展示片为主） | 6–22° 作者屈膝 | ❌ 运行时只能保证「= 作者」；由 task-3 数据侧 bake 单独处理 |
| **N / X（正常动作/非站立）** | 动态站立动作（膝 range ≥20°）、sit/lie/sleep/drag/fall/climb 等禁锁路径 | 设计姿态 | 不修 |

本任务把 foot-lock 的旧 A（「锚点−作者踝位」均值水平平移）替换为**候选 g：3-DOF 骨盆距离保持解**，
并配套 IK 腿长钳制余量 1mm→0.2mm、pat 动态反应禁锁、平滑后约束投影。实测（真实 VRM + 真实 clip +
真实产品代码）：

| 指标 | 现状（旧 A，同夹具 mean 回退） | v2 候选 g |
|---|---|---|
| idle 9 条稳态 Δ膝（相对作者，平均） | **4.2–16.9°**（多数 −12° 左右） | **0.00–0.41°**（逐帧 max ≤0.74°） |
| 左右不对称（相对作者） | 最高超出作者 +15.6° | 逐帧超出 ≤0.3° |
| 髋→踝距离残差 | 4.3–11.4mm | **<0.5mm（钳制后目标残差≈0）** |
| 脚钉住误差 / 脚像素漂移 | 0 / 0（A 也钉住，问题是膝形） | 0–0.0001m / ≤0.02px（零脚滑） |
| 身体侧移 δxz | 0.018–0.180m | ≤0.093m（9 条 idle），钳制上限 0.10m |
| 骨盆升降 δy | 0（旧 A 只走 pelvisDrop） | −0.012…+0.010m（实测需求上界 −0.020…0） |
| 转场（one-shot→idle 回归）运行时造成的 Δ膝 | 7.78° | **0.44°** |
| pat 动态反应 | 触地帧重锚把腿拉直 +20° | **禁锁：全程 pinned=false、腿形=作者** |
| 单帧 foot-lock.update 耗时 | — | **0.008ms 平均 / 0.011ms p95（目标 ≤0.3ms）** |
| 门禁 | — | typecheck 全绿；`pnpm test` 135 files / 2712 passed / 11 skipped；`pnpm build` 全绿（见 §7） |

---

## 1. 根因（为什么上一轮 A+B 还不够）

上一轮修了 A（锚点-作者脚位均值对齐）与 B（脚朝向软跟随），消掉了「脚滑」「横向扭曲/外八」，
但用户仍看到弯腿。REPORT §2 表 B 的贡献分解（9 条 idle，相对作者膝角）：

1. **micro×IK（约 62%）**：`micro-motion`（用户要求保留的「腰会动/软膝」层）每帧把骨盆平移
   （横向 ±1.5cm、竖向 −0.8cm 软膝）与旋转写进 normalized hips。旧 A 只按**水平脚位残差**对齐，
   不处理「髋→踝距离」；微动的骨盆下沉被两骨 IK 吸收 → 膝被压弯 **−8.6° 量级**。
2. **旧 A 跨变体残差（约 38%）**：两骨腿的膝角由 `|髋−踝目标|` 距离**唯一决定**（余弦定理）。
   旧 A 用「均值平移」让脚位对齐，但平移后的 `|髋−锚点|` 不等于本帧作者距离 `d_author`：
   - 跨 idle 变体站姿差 11–21cm，一个均值平移无法同时满足两脚（实测两脚残差最大差 7.8cm）；
   - 腿接近伸直时对距离极敏感（**1mm ≈ 2–3.6°**），几毫米距离差就是几度膝弯；
   - `solveKneePosition` 的腿长钳制余量 1mm 又把 hsr-idle/idle2（作者 d=881.1/881.4mm，
     腿长 881.535mm）额外压弯 −1.9°/−3.4°。

把这两项在**骨盆层**消掉，IK 就不需要拧腿：g 解 hips 偏移 δ 使每条 pinned 腿的
`|hip+δ−pin| = d_author`，膝角自动回到作者值，而脚仍钉在锚点（零脚滑）。

---

## 2. 方案：候选 g（3-DOF 骨盆距离保持解）

### 2.1 原���

对每条 `contact && pinPosition != null` 的腿，取本帧 **IK 前**（clip + micro 已写）作者姿态：

- `hip_i` = upperLeg 骨世界位置 → avatar.scene 局部；
- `ankle_i` = foot（踝）骨世界位置 → scene 局部；
- `d_i = |hip_i − ankle_i|`（作者本帧的髋→踝距离，**旋转不变**）；
- `p_i = pinPosition`（scene 局部锚点）。

解 hips 偏移 `δ=(dx,dy,dz)` 满足 `|hip_i + δ − p_i| = d_i`：

- **两脚**：Gauss–Newton（`JᵀJ + λI`，λ=3e-4，warm start 上一帧目标解，≤16 iter，
  残差 <1e-6 提前退出；2 约束 3 未知量 → ridge 取最小范数族稳定点）；
- **单脚**：解析最小范数解 `δ = (d/|hip−p| − 1)·(hip−p)`；
- **0 脚**：目标 0（平滑归零）。

细节（实现中踩到并修正的两点）：

1. **ridge 只加在步长上**（标准 Levenberg）：若把 `λ·δ` 放进右端（调查原型的写法），
   大位移 + 近相切几何下会停在「残差 ±0.7mm 互相抵消、`Jᵀr` 与 `λδ` 精确抵消」的伪驻点，
   残差不再下降（离线复现过）。改为 `(JᵀJ+λI)·step = −Jᵀr` 后 16 iter 内收敛到 <1e-6。
2. **平滑后再投影回约束流形**：τ=0.2s 的平滑对**移动中的作者姿态**有 τ 量级滞后（1–3mm）；
   本模型腿接近伸直，1mm 距离误差会放大成 2–5° 逐帧膝尖峰（表演型 idle `hsr-idleShow2`
   实测会到 5.0°）。写入前把平滑后的 δ 用同一组约束做 1–4 次 GN 投影（单脚解析），
   等价于「最近可行解」：身体轨迹仍平滑，逐帧膝角贴回作者（见 §4 表）。
   投影只改已平滑值、不改 warm start。

### 2.2 钳制 / 平滑 / 回退

| 参数 | 值 | 依据 |
|---|---|---|
| 水平偏移上限 `|δxz|` | **0.10m** | 实测 9 条 idle 需求上界 0.088m（hsr-idleShow2），留余量；钳制后残差 <10mm 不回退 |
| 垂直偏移 `δy` | **[−0.03, +0.02]m** | 实测只下沉、上界 −0.020m |
| deadband | **0.0005m（0.5mm）** | 旧 A 的 5mm 会吃掉必要校正（实测最小必要 δ ≈1mm）；0.5mm 只滤像素级微差 |
| 平滑 τ | **0.2s**（复用 `smoothingAlpha`） | REPORT §12.4 推荐；切换期身体速度 ≤46px/s |
| fallback 判据 | 解后/钳制后距离残差 **>10mm** 或 NaN → 本帧回退旧 A | 保留 v1 行为与再兜底 |
| 回退路径 | 旧 A 均值平移（≤0.18m、5mm deadband、τ0.3s）+ 原 pelvisDrop | `stanceAlignMode:'mean'` 强制回退（回滚通道） |
| 可达性 | g 生效时 reachability 的 `targetDrop` 固定 0（δy 即骨盆升降），保留 `required > reach−margin → release` 兜底 | 避免 pelvisDrop 再压 1–2mm 造成膝差 |
| 写入 | 每帧 `hips.position.x/y/z += 平滑(δ)`（非累积，基准值由 clip/micro 每帧重写），`hips.updateMatrixWorld(true)`；**不写 avatar.scene/root** | 与旧 A 同口径 |
| 离场 | `!eligible`（walk/sit/climb/fall/drag/grabWindow/sleep/pat/空中）时 δx/y/z 按同 τ 平滑归零；`reset()/dispose()` 立即清零 | 不残留身体侧移 |
| 性能 | 零每帧分配：预分配约束数组 2 个、3 个 Vector3、标量 GN 内联；无 `new`、无数组增长 | 见 §4.3 |

### 2.3 IK 腿长钳制余量

`solveKneePosition` 的 `maxDistance = L1+L2−1mm` → **`L1+L2−0.2mm`**（0.2mm）。
作者数据最伸直帧 d=881.4mm vs 腿长 881.535mm（余量仅 0.135mm），旧 1mm 余量把
hsr-idle/idle2 额外压弯 −1.9°/−3.4°；0.2mm 解析残余仅 −0.4°。近伸直极向量退化由既有
`lastPole`/`poleHint` 兜底（单测覆盖）。

### 2.4 pat 动态反应禁锁

`pat` 加入 `FOOT_LOCK_DISABLED_MOODS`。pat 是动态反应 clip：约 19% 的「脚短暂触地」帧会被重新
锚定，随后作者把脚带远 → IK 把腿**拉直**（`mate-shyPoint` 左膝 +19.8°，g 后 +24.3°，比作者还直）。
动态反应本就不该锁脚；禁锁后腿形 = 作者（实测 pat 3 条 pinned=0、运行时膝角=作者）。

### 2.5 调试/验收字段（可选字段，旧消费方不填也通过类型检查）

`VrmFootLockDebugSnapshot` / `AnimationDebugSnapshot.footLock` 新增（dev-capture JSON 自动透出）：

- `hipShiftYM`（米；g 的骨盆升降；`hipShiftXM/ZM` 语义不变，L2 pointer-rect 不回归）
- `stanceSolveResidualM`（米；钳制后最大距离残差，>10mm/NaN 即回退）
- `stanceAlignMode`（`'3d' | 'mean'`）
- `stanceSolveIterations`（GN 迭代数，性能/调参）
- `kneeFlexDegL/R`（IK 后运行时膝屈曲角，度；髋-膝-踝三点夹角，180°=伸直）
- `authorKneeFlexDegL/R`（本帧 IK 前、micro 后的作者膝角，度；与上面对比即「运行时把腿弯了多少」）

### 2.6 改动文件

| 文件 | 改动 |
|---|---|
| `src/renderer/src/vrm/foot-lock.ts` | 主改：候选 g、平滑投影、fallback、IK margin 0.2mm、pat 禁锁、膝角测量、调试字段、`stanceAlignMode` option |
| `src/renderer/src/vrm/runtime-types.ts` | `VrmFootLockOptions.stanceAlignMode` + 调试快照字段 |
| `src/renderer/src/core/wave2-contract.ts` | `AnimationDebugSnapshot.footLock` 内联类型同步新增字段 |
| `tests/vrm-foot-lock.test.ts` | 旧 A 用例改为 `stanceAlignMode:'mean'` 回退通道覆盖；新增 g 用例 8 组 + 投影用例 |
| `tests/vrm-micro-motion.test.ts` | micro×foot-lock 集成用例按新语义更新（3d 保持作者腿形 / mean 保留旧弯膝） |
| `tests/tmp/fix-leg2/**` | 验收脚本（真实 VRM/产品代码）、性能脚本、dev-capture 断言脚本、证据 |
| `docs/known-issues.md` | 对应段落更新（见 §7） |

**未改**：`micro-motion.ts`（用户要求的「腰会动」观感保持）、B 脚朝向软跟随、R1 接触阈值、
walk/sit/climb/drag 路径、clip-player、`assets/**`。

---

## 3. 影响面（覆盖矩阵）

| 路径 | foot-lock 是否生效 | v2 行为 |
|---|---|---|
| idle 轮换池 9 条（hsr-idle/idle2/commonIdle/idleShow/idleShow2、adv-idle/think01/worry01/scratchHead01） | ✅（mood=idle、slot=idle、grounded） | g 生效：运行时 Δ膝 ≤0.74°（逐帧）、平均 ≤0.22°；脚零滑；身体 δ ≤0.093m/δy ≤0.02m |
| dshBusy / dshDone（静态）/ dshError 站立反应 | ✅（slot=dsh*） | g 生效：Δ膝 ≤0.26°；动态帧照旧按 R1 释放 |
| pat 动态反应（3 条） | ❌ **v2 起禁锁** | pinned=0、腿形=作者（不再有 +20° 拉直） |
| idle↔one-shot（IdleOneShotFidget / DSH skill / intro） | 一次性段 allow=false | 转场回归运行时造成的 Δ膝 7.78°→0.44°；进入段无回归（2.61→2.66°） |
| walk / climb / sit / sleep / drag / grabWindow / fall | ❌ 禁锁（不变） | 行为不变；回归确认 pinned=false/weight=0（dev-capture place/walk 场景） |
| 数据侧 D 类（作者数据屈膝） | — | **本任务不修**；运行时保证「腿形=作者」，剩余 6–14° 由 task-3 数据 bake 处理 |
| 全 19 条 idle-mood 片（含非轮换池 mate-*） | ✅ | 轮换池 9 条全部 g 生效、无回退/无钳制；旧 priority<−9 的 mate-idle 有 5 条几何近退化 → 自动回退旧 A（位移 ≤0.142m，与 v1 同级，膝形不回归） |

---

## 4. 离线验收（真实 VRM + 真实 clip + 真实产品代码，无 monkeypatch）

脚本：`tests/tmp/fix-leg2/acceptance.g.test.ts`（真实 `VrmFootLock`/`VrmMicroMotion` + 真实
`aventurine-tpose.vrm` + 真实 clip JSON，复刻 animator 层序 clip→micro→foot-lock→humanoid.update）；
输出：`tests/tmp/fix-leg2/acceptance-g-results.json`。
运行：`./node_modules/.bin/vitest run --config tests/tmp/fix-leg2/vitest.config.mts tests/tmp/fix-leg2/acceptance.g.test.ts`（约 8s）。

### 4.1 idle 9 条（锚点=hsr-idle，切换后 2s 稳态窗口 1s；旧 A=mean 回退通道 vs g=3d）

| clip | 旧 A Δ膝相对作者 L/R（°） | g Δ膝相对作者 L/R（°） | g 运行时自身逐帧 max（°） | g 不对称（运行时/作者） | g 脚误差 max | g δxz max | g δy 范围 |
|---|---|---|---|---|---|---|---|
| hsr-idle | +11.77/+11.45 | 0.00/+0.41 | 0.74 | 1.04/1.44 | 0.0001m | 0.021m | 0.000…+0.010 |
| hsr-idle2 | +11.78/+11.43 | 0.00/+0.39 | 0.64 | 1.03/1.42 | 0.0001m | 0.021m | 0.000…+0.010 |
| hsr-commonIdle | +10.69/+6.22 | 0.00/−0.00 | 0.05 | 2.73/2.74 | 0 | 0.090m | −0.006…+0.010 |
| hsr-idleShow | +6.02/0.00 | 0.00/0.00 | 0.05 | 20.02/20.03 | 0 | 0.044m | −0.016…+0.010 |
| hsr-idleShow2 | +8.66/−0.31 | −0.00/0.00 | 0.05 | 0.30/0.30 | 0 | 0.091m | −0.010…+0.010 |
| adv-idle | +16.90/−2.69 | 0.00/−0.00 | 0.05 | 2.73/2.73 | 0 | 0.049m | −0.012…+0.010 |
| adv-think01 | +4.23/+2.88 | 0.00/−0.00 | 0.05 | 7.20/7.21 | 0 | 0.076m | −0.010…+0.010 |
| adv-worry01 | +8.68/+2.48 | 0.00/−0.00 | 0.05 | 1.66/1.68 | 0 | 0.060m | −0.008…+0.010 |
| adv-scratchHead01 | +13.94/−1.80 | 0.00/−0.00 | 0.05 | 1.19/1.20 | 0 | 0.052m | −0.009…+0.010 |

> 读法：「Δ膝相对作者」= 运行时膝角 − 纯作者 FK（REPORT 表 13-A 口径；作者数据本身的 6–14° 弯
> 包含在内，这段 g 修不了、也不是它造成的）。「运行时自身逐帧 max」= 逐帧 |运行时 − 本帧 IK 前作者|，
> 即 v2 运行时**新造成**的弯腿量（目标 ≤5°，实测 ≤0.74°）。
g 生效时两脚 100% pinned（hsr-idleShow 按 R1 预期释放右脚 → pinnedAny 100%）；脚像素漂移 ≤0.02px；
`stanceSolveResidualM` 全场 ≤0.5mm（9 条均 <0.0001m）；9 条全部 `stanceAlignMode='3d'`，无 fallback。

### 4.2 dsh 反应 / pat / 转场

| 场景 | 旧 A | g |
|---|---|---|
| dshBusy/hsr-commonIdle（静态） | Δ膝 +2.89/+0.70、残差 1.6mm | Δ膝 0.00/−0.00、残差 <0.5mm、pinned 100% |
| dshBusy/adv-think01（静态） | +1.66/+0.70、3.6mm | 0.00/0.00、<0.5mm、pinned 100% |
| dshError/hsr-stun（静态） | −2.62/+2.18、5.2mm | 0.00/0.00、<0.5mm、pinned 100% |
| dshDone/mate-happy、adv-snap01loop（动态） | pinned 30%/0%、footError 43.7mm | 与旧 A 同级（42.5mm）——动态触地帧释放，不回归 |
| pat 3 条（mate-happy/laughing/shyPoint） | 触地帧重锚：shyPoint 左膝 +19.8° | **pinned=0、运行时膝角=作者（Δ=0.00°）** |
| idle→one-shot→idle 回归转场 | 运行时造成的 Δ膝 max 7.78° | **0.44°** |
| idle→one-shot 进入转场 | 2.61° | 2.66°（无回归） |
| walk→idle 帧间膝跳变 | 1.36°（作者动作本身） | 1.36°（不变）；回 idle 后 pinned 恢复、δ 有界无突跳 |
| 全 19 条 idle-mood 片扫描 | — | 轮换池 9 条全部 3d/残差 <0.5mm/δ≤0.10m；旧 mate-idle*（priority<−9，非轮换池）5 条近退化几何自动回退旧 A（δ≤0.142m、膝形不回归） |

### 4.3 性能

`tests/tmp/fix-leg2/perf.g.test.ts`（5000 帧，非对称作者姿态 + 双足 pinned + 投影）：
`VrmFootLock.update` **平均 0.0078ms、p95 0.0102ms、max 0.109ms**（目标 ≤0.3ms）；
旧 A 路径 0.0068ms → g 的求解+投影开销约 +0.001ms/帧。零每帧分配由实现保证
（预分配 2 条约束 + 3 个 Vector3，GN 内联标量）。结果：`tests/tmp/fix-leg2/perf-result.json`。

### 4.4 单测

- `tests/vrm-foot-lock.test.ts`：68 tests（v1 为 50），新增/更新：
  ① 双约束精确性（15/21cm 跨站姿：距离残差 <0.5mm、|Δ膝|<2°、脚不滑、δ 不越界）；
  ② 单脚解析解精确生效（与解析公式逐分量 <0.5mm）；③ 水平钳制/deadband/不抖；④ fallback
  （δy 需 +5cm 被钳 → 回退 mean、无 >0.18m 位移）；⑤ 非累积/200 帧稳定/30-60-144Hz 收敛一致；
  ⑥ 离 idle（walk/sit/sleep/fall/drag/空中）δx/y/z 归零；⑦ 与 B 脚朝向软跟随共存；
  ⑧ pat 禁锁（mood=pat + allow=true 也不锁）；⑨ 移动作者姿态下平滑投影保持逐帧膝角（≤0.5°）；
  ⑩ 异常骨骼矩阵注入 NaN 时不写 NaN 到 hips、恢复后继续锁定；
  旧 A 行为全部用 `stanceAlignMode:'mean'` 保留覆盖。
- `tests/vrm-micro-motion.test.ts`：3d 模式「微动只动腰、膝角保持作者（±1°）」；mean 模式保留
  「微动让膝明显更弯（>+2°）」旧行为。

---

## 5. 实机自检（dev-capture，隔离 HOME/PROFILE，未影响用户正在运行的 app）

环境：`env -u ELECTRON_RUN_AS_NODE HOME=/tmp/pet-dsh-home-leg5 PET_PROFILE=agent-fix-leg2
PET_DSH_DIR=/tmp/pet-dsh-home-leg5/.dsh/aventurine-pet PET_MODEL_BACKEND=vrm`；
产物 `tests/tmp/fix-leg2/run-*/`；自动断言脚本 `tests/tmp/fix-leg2/assert-captures.mjs`
（读取每帧 JSON 的 `animation.footLock` 新字段）。

| # | 场景 | 命令要点 | 结果（`assert-captures.mjs` 自动断言，全部 PASS） |
|---|---|---|---|
| 1 | idle 轮换（240 帧 × 500ms = 120s） | `PET_DEV_CAPTURE_IDLE=1 PET_DEV_CAPTURE_FRAMES=240 PET_DEV_CAPTURE_INTERVAL_MS=500` | `run-idle/`：240 帧 / 静态站立 212 帧；逐帧 `|kneeFlex−authorKneeFlex|` **max 0.70°**（门禁 5°）；不对称超出作者 **0.10°**（门禁 2°）；footError max **0.0001m**；`|hipShiftXZ|` max **0.096m**（≤0.10m）；`δy` 范围 **−0.012…+0.008m**；相邻 500ms 身体位移 max **0.063m**（≈39px/s，无量级突跳）；NaN 0；`stanceAlignMode` 全 3d |
| 2 | dshBusy/dshDone/dshError（4 个 mood 段） | `PET_DEV_CAPTURE_MOOD_SEQUENCE='dshBusy:6000,dshDone:6000,dshError:6000,idle:1500'` | `run-mood/`：dshBusy 段（adv-think01-dshBusy）双足 pinned、footError 0、knee=author（Δ0.00°）；dshDone(snap clip)/dshError(倒地 clip)/idle(revive) 为动态段，按设计 pinned=false、腿形=作者（knee=author 全帧）。注：本命令按任务书执行，取到的是 dshDone/dshError 的动态 clip；**静态 dsh clip 的完整覆盖在 §4.2 离线验收（5 条 dsh clip）** |
| 3 | pat 动态反应（验证禁锁） | `PET_DEV_CAPTURE_MOOD_SEQUENCE='pat:2500,pat:2500,pat:2500,idle:1500'` | `run-pat/`：3 帧 pat 全部 `pinned=false`、`kneeFlexDeg=authorKneeFlexDeg`（Δ0.00°）、无 NaN |
| 4 | 窗沿 sit 回归 | `PET_DEV_CAPTURE_PLACE=1670,600` | `run-place/`：3 帧 mood=sit（mate-windowLay8）全部 pinned=false、无 NaN，腿形=设计姿态（膝角 140.7/143.7°，与作者一致） |
| 5 | walk 活动回归 | `PET_DEV_CAPTURE_ACTIVITY=walkTo PET_DEV_CAPTURE_FRAMES=120 PET_DEV_CAPTURE_INTERVAL_MS=250` | `run-walk/`：walk 段 7 帧 pinned=false（腿形=作者）；随后 idle 段 113 帧中 108 帧静态站立：双足 pinned 恢复、knee=author（max 0.70°）、footError ≤0.0001m、`δ≤0.056m`；NaN 0 |

另：用 `sharp` 生成修复前/后 idle 同 clip 渲染对比图（腿局部 2× 放大）：
`tests/tmp/fix-leg2/evidence-idle-legs-before-after.png`（BEFORE=旧 A 实机帧，AFTER=v2 实机帧；可见膝盖轮廓变直、
脚位不变）。完整 figure：`evidence-idle-before-after.png`。

**最终 build 复跑 smoke**（`pnpm build` 全绿后用同一命令复跑）：`run-idle-final/` 60 帧 → 58 静态站立帧、
`|kneeFlex−authorKneeFlex|` max **0.70°**、footError max **0.0001m**、`|δxz| max 0.054m`、NaN 0；
`run-pat-final/` 3 帧 pat → pinned=0、knee=author（Δ0.00°）。`assert-captures.mjs` PASS。

> 说明：dev-capture 每帧 JSON 已含 `kneeFlexDegL/R` 与 `authorKneeFlexDegL/R`（本任务新增），
> Lead 可用同一 `assert-captures.mjs` 复核；PNG 与 `tests/tmp/inv-leg2/run-idle`（修复前）对比
> 可看脚位不变、膝盖变直。作者数据本身的屈膝（D 类）在「运行时=作者」后仍会显示，需数据 bake。

---

## 6. 风险 / 回滚

1. **身体侧移/升降观感**：g 的 δ 让骨盆相对脚移动。9 条 idle 实测水平 ≤0.093m（27px@540）、
   垂直 ≤0.020m（6px@540），比旧 A 实测 0–0.18m 更小；切换期身体速度 ≤46px/s（旧 A ≤56px/s）。
   若用户对「换动作时重心平移」敏感，可叠加数据侧站姿归一化（task-3/P2）。
2. **回退通道**：`new VrmFootLock(avatar, { stanceAlignMode: 'mean' })` 一键回到旧 A 行为
   （所有 v1 单测保留在该模式下覆盖）；不新增配置项、不改 animator 调用。
3. **自动 fallback**：解/钳制后距离残差 >10mm 或 NaN 的单帧回退旧 A + 原 pelvisDrop（保留 v1 行为
   与可达性 release 兜底）。旧 priority<−9 的 mate-idle* 5 条几何近退化会整段回退（δ≤0.142m，
   与旧 A 同级，非用户实际轮换池）。
4. **IK margin 0.2mm**：腿部完全伸直时极向量退化依赖既有 `lastPole`/`poleHint` 兜底（单测覆盖）；
   0.2mm 对全伸直姿态的数值稳定性已被 9 条 idle 实机采集确认。
5. **pat 禁锁**：pat 期间脚不再被钉住（本来多数帧就释放）→ 反应动作更接近作者；无「直腿 pop」。
6. **未修（作者数据 D 类）**：idle 轮换池 7 条 author 本身屈膝 6–14°；一次性池 5 条静态屈膝 8–9.4°。
   运行时保证「腿形=作者」，这部分需 task-3 数据侧 bake（[数据侧报告](fix-report-2026-11-11-standing-leg-data-bake.md)）。
7. **并发 session**：本仓库当前有另一 session 在改 `dsh-*`/bridge 等 tracked 文件，导致
   `pnpm build` 的 typecheck 与 `tests/bridge-plugin.test.ts` 全量门禁暂时失败（与 foot-lock 无关，
   详见 §7）。本任务**未 commit**，等 Lead 复核后统一提交。

---

## 7. 门禁数字（本任务执行时）

| 门禁 | 结果 |
|---|---|
| `pnpm typecheck` | ✅ 全绿 |
| `tests/vrm-foot-lock.test.ts` | ✅ **68 tests**（v1 为 50；含 8 组新增 g 用例 + 投影 + NaN 防御） |
| `tests/vrm-micro-motion.test.ts` | ✅ 7 tests |
| `pnpm test` | ✅ **135 files / 2712 passed / 11 skipped**（全绿；基线开工时 129 files / 2424 passed / 11 skipped） |
| `pnpm build` | ✅ 全绿（含 typecheck + electron-vite build） |
| 离体验收脚本 | ✅ 6 组全 PASS（9 idle + dsh + pat + 转场 + 全 idle 池扫描，见 §4） |
| 性能 | ✅ 0.0078ms/frame 平均（目标 ≤0.3ms） |
| dev-capture | ✅ 5 场景 + 最终 build 复跑 smoke（`run-idle-final/` 60 帧、`run-pat-final/`），`assert-captures.mjs` 全 PASS |

> 注：开发过程中另一 session 的 dsh/bridge tracked 改动曾使 `pnpm build` typecheck 与全量测试短暂失败
> （与本任务无关）；其收尾后最终门禁全绿，以上为最终数字。本任务**未 commit**，等 Lead 复核后统一提交。

---

## 8. 证据路径

| 内容 | 路径 |
|---|---|
| 离体验收脚本/结果 | `tests/tmp/fix-leg2/acceptance.g.test.ts`、`acceptance-g-results.json` |
| 性能脚本/结果 | `tests/tmp/fix-leg2/perf.g.test.ts`、`perf-result.json` |
| dev-capture 断言 | `tests/tmp/fix-leg2/assert-captures.mjs`、`assert-captures-result.json` |
| dev-capture 证据 | `tests/tmp/fix-leg2/run-idle/`、`run-mood/`、`run-pat/`、`run-place/`、`run-walk/` + 对应 `run-*.log` |
| 调查/候选 g 数据 | `tests/tmp/inv-leg2/REPORT.md` §12/§13、`run-logs/rows-g4.json`、`audit-*.json` |
| 数据侧 bake（task-3） | `docs/fix-report-2026-11-11-standing-leg-data-bake.md`、`tests/tmp/bake-leg/` |

---

## 9. Lead 独立复核与实机验收（2026-11-11 14:21–14:31）

> 复核人：Lead。以下数字均为 Lead **独立复跑**（未复用 fixer 的断言结果）；证据在
> `tests/tmp/lead-verify/final/**`（本地证据目录，gitignore，不随仓库分发）与 `/tmp/petcap/**`。

### 9.1 门禁复跑（14:21）

| 门禁 | 结果 |
|---|---|
| `pnpm typecheck` | ✅ |
| `pnpm test` | ✅ **135 files / 2712 passed / 11 skipped（0 fail）** |
| `pnpm build` | ✅ |
| `tests/tmp/fix-leg2/acceptance.g.test.ts`（真实产品代码重跑） | ✅ **6/6 PASS**（约 8s） |

### 9.2 独立实机 dev-capture（隔离 HOME/PROFILE；当前代码 + 数据 bake 已生效）

| 场景 | 结果 |
|---|---|
| idle 240×500ms | 静态双足帧 **195**；逐帧 `|kneeFlex−authorKneeFlex|` **max 0.70°**（门禁 5°）；不对称超出作者 **max 0.20°**；footError **max 0.0001m**；`|hipShiftXZ|` **max 0.085m**；fallback **0**、NaN **0**；覆盖 adv-idle / hsr-commonIdle / hsr-idle / hsr-idleShow / adv-worry01 等变体 |
| mood `dshBusy→dshDone→dshError→idle` | dshBusy 静态段（adv-think01-dshBusy）双足 pinned、Δ膝 0；dshDone 动态段 Δ≤0.5° 且按设计释放；dshError 倒地/breve 非站立 pinned=false（设计） |
| pat（3 段） | **pinned=false 全帧**（禁锁生效）、运行时膝角=作者（Δ0.00°）、无「直腿 pop」 |
| 窗沿 place（top=354） | mood=sit（mate-windowLay8）pinned=false、膝 140.7/143.7°=设计坐姿，无站立帧 |
| walkTo | walk 段 pinned=false（腿形=作者 walk）；回 idle 后 66/67 帧双足 pinned 恢复、Δ膝 ≤0.70° |
| 用户尺寸 50%（270px）idle | 全帧腿部目视直立、无膝折/左右不对称；与用户 12:53 旧版截图同一视角对比：`/tmp/petcap/user-before-after.png`（本地证据） |

### 9.3 可视化证据（本地）

- `tests/tmp/lead-verify/final/author/`：18 条作者姿态渲染（bake 后；idle 轮换池膝角已拉直到 174.1–177.7°、社交 171.7–174.6°；未 bake 的 `hsr-idleShow` 保持作者表演屈膝，属 N 类）。
- `tests/tmp/lead-verify/final/idle/`：240 帧运行时 PNG+JSON（含新增 `kneeFlexDeg*`/`authorKneeFlexDeg*` 断言面）。
- `/tmp/petcap/author-before-after.png`：作者姿态 bake 前/后腿部对比（baked 的 5 条 idle 明显变直，hsr-idle 未 bake 对照不变）。
- `/tmp/petcap/same-clip-before-after.png`：同 clip hsr-idle 旧代码（运行时弯腿）vs v2（运行时=作者）vs 作者参考。
- `/tmp/petcap/user-before-after.png`：用户 12:53 截图 vs 修复后 50% 尺寸 idle。

### 9.4 结论与遗留

- **通过**：运行时代码 + 数据侧 bake 叠加后，idle/dsh 静态站立、pat、转场、window/walk 回归全部达标；
  用户可见的「站立弯腿」主因（运行时放大 + 作者数据屈膝）均已消除或按预期回落。
- **接受的取舍**（Lead 决策）：① `adv-think01` bake 后骨盆水平偏 28mm（8.72px@540 / 4.36px@50%），脚不动，
  观感为重心偏一侧，接受；② 3 条 loop clip 作者原数据首尾差 0.11–0.67mm 未被 bake 劣化，接受；
  ③ `hsr-idleShow/idleShow2` 等动态表演型 idle 的作者屈膝属动作本身（N 类），不修。
- 本次修复由 Lead 复核后提交（见 git log）；数据侧 bake 为本地资产改动（`assets/**` gitignore），
  仓库内保留可复跑脚本与报告，回滚方式见数据侧报告 §7。
