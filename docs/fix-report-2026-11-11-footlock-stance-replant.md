# 修复报告：换 idle 姿势时脚部重踏重锚（foot-lock stance replant）

> 日期：2026-11-11
> 角色：实现 subagent（I1）
> 基线：HEAD `11d73fe`（含 foot-lock v2 `2b9340a`、数据侧膝拉直 bake `fb21e61`、upperChest α-fold `83d4d6c`）
> 关联调查：[`tests/tmp/footlock-replant/root-cause.md`](../tests/tmp/footlock-replant/root-cause.md)（根因/量化）、
> [`tests/tmp/footlock-replant/web-research.md`](../tests/tmp/footlock-replant/web-research.md)（外部调研/参数区间）

---

## ① TL;DR

用户反馈「锁脚过度：换姿势脚不动、各站姿脚位/张开幅度几乎一样」。根因是 foot-lock 的 `pinPosition`
**跨 clip 永久保持**，而普通 idle 作者踝抬升 ≤0.4mm、水平速度≈0，永远达不到释放阈值（2cm/0.9m/s），
于是脚被钉在当天第一次的锚点；3-DOF 骨盆解只能把新站姿差吸收成**腿方向偏转 + 身体侧移**。

本次按已复核方案实现 **stance replant**：animator 把 `clipId` 传给 foot-lock；检测到 clip 变化后先
`pendingReplant`（crossfade 期间冻结接触），fade 结束第一帧采样**新 clip 作者踝位/脚朝向**，用
**单脚错峰抬脚弧线**（水平 smoothstep + 正弦抬脚，同一时刻最多一脚离地）把 pin 搬到新作者站姿；
重踏期间 3-DOF 骨盆解让位（δ 按进度衰减到 0），全部落地后保持 δ=0 0.2s 再恢复。稳态仍刚性锁脚。

**关键结果（真实 VRM + 真实 idle clip + 产品代码，540px 口径）**：

| 指标 | 旧行为（`poseReplant:false`） | 新行为 |
|---|---|---|
| 稳态脚位 vs 作者（非表演 idle，最大均值误差） | **173.4mm**（adv-idle） | **17.4mm** |
| 稳态站姿宽 vs 作者（最大误差） | **36.5mm**（且 5 段恒为 31.2cm） | **1.3mm** |
| 稳态膝角差 | 0.36° | 0.36° |
| 切换接地滑移（8mm 弧线阈值，累计） | 0px | **5.7px**（≤6px） |
| 单帧最大脚位移 | 0px | **9.15px**（≤10px） |
| 同时离地帧（非 idleShow） | 0 | **0** |
| contact 抖动 / NaN | 0 / 0 | **0 / 0** |

新增 7 个单测（`tests/vrm-foot-lock.test.ts`，共 75 个）全部通过；`pnpm test` 全量 136 files /
2734 passed / 11 skipped；`pnpm typecheck` 通过。离线验收见 `tests/tmp/footlock-impl/acceptance-results.json`。

**已知未达标项**：稳态 `hipShift` 水平 19–45mm > 任务单 20mm 门禁。这是 **micro-motion + g 的既有行为**
（连锚点 clip `hsr-idle` 本身 21.3mm；旧行为 adv-think 57mm/common 72mm），不是 replant 引入的；
要压到 20mm 内需改 g 的 idle 水平预算或 micro-motion 层（本任务明确不动），详见 §⑦。

---

## ② 根因（详见调查报告）

1. `foot-lock.update()` 只收到 `transitioning`/`allow`，**不知道换了哪条 clip**，无法主动规划落点。
2. `pinPosition` 只在「进入接触」那一帧写入，之后跨 clip 保持（`foot-lock.ts` 旧版 §3）。
3. crossfade 期间接触状态机冻结（`transitioning`）→ 混合位移不参与判定，pin 也不换。
4. 普通 idle 作者踝抬升 ≤0.4mm、水平速度≈0 → 永远不满足 `lift>2cm` / `speed>0.9m/s` 释放条件。
5. 3-DOF 骨盆解只约束 `|hip+δ−pin| = d_author`（距离），不约束脚位方向；新站姿差被吸收成
   腿相对髋方向偏转（实测最大 47.4°）、身体侧移（hipShift）与横向伸出距离差（11.7cm）。
6. 结果：脚位/站姿宽被抹平；表演型 idle 还会「一脚旧站姿、一脚新站姿」拉宽（旧行为 50.1cm）。

---

## ③ 方案（产品实现）

代码：`src/renderer/src/vrm/foot-lock.ts`；animator 只增加一个 context 字段。

### 3.1 触发

- `update(input, context)` 新增 `context.clipId?: string | null`；`animator.ts` 传
  `clipId: lastClipSnapshot?.clipId ?? null`。
- 每帧更新 `lastClipId`（含 ineligible 帧；`clipId=null` 时由 animator 的 `reset()` 清空）。
- 仅当 `poseReplant !== false`、`stanceAlignMode !== 'mean'`、`eligible`、`lastClipId != null &&
  clipId != lastClipId` 时进入 `pendingReplant`；crossfade 期间继续冻结接触/pin 保持。
- 新 clip 在重踏中再次切换：先 `finishReplantNow()` 把脚停在当前插值位，再 pending 等待新 fade。
- 进入 ineligible（walk/sit/drag/pat/空中等）：立即结束重踏，走原有释放路径。

### 3.2 目标采样（只一次）

`pendingReplant && transitioning !== true` 的第一帧调用 `startReplant()`：对每只
`contact && pinPosition != null` 的脚，读取**本帧 IK 前**（clip+micro 已写、未 IK）的踝位
（`avatar.scene` 局部）+ 脚世界朝向转 scene 局部，作为目标。此刻 crossfade 已结束，姿态=纯目标 clip。
重踏中不重采样。作者此刻抬着脚（目标踝高于 `contactEnterLiftM`）时不把 pin 重锚到空中，
释放该脚跟随作者（表演型 idle 边界；旧行为）。

### 3.3 单脚错峰轨迹

- `d = |target − pin|_xz`；`d < replantMinMoveM (0.012m)` → 迷你混合：0.15s、`lift=0`、
  smoothstep 平滑搬 pin，避免瞬移。
- 其余按 `d` 降序排队；同一时刻最多一只脚离地：
  - `T = clamp(d / 0.45mps, 0.30s, 0.45s)`；
  - 后一脚在前一脚完成 + `gap=0.08s` 后开始（`delaySec` 累积）。
- 单脚轨迹 `u=clamp(local/T,0,1)`：
  - 水平：`hp=clamp((u−0.12)/0.76,0,1)`，`e=smoothstep(hp)`；水平只在 `u∈[0.12,0.88]` 内移动
    （先抬后走、先停后落，无过冲）；
  - 抬脚：`lift=clamp(0.15·d, 0.012m, 0.030m)·sin(πu)`（下限见 §④ 的 2mm 偏差说明）；
  - pin = `lerp(from,to,e)` + 抬脚 y；朝向与水平同进度最短弧 slerp（同半球）。
- 重踏期间 `contact` 保持 true，接触状态机冻结（脚本抬脚不被自家阈值判成离地）；落地后
  `pin=目标`、`previousLocal=null`，恢复刚性锁定。

### 3.4 与 3-DOF 骨盆解（g）互斥

- `startReplant()` 记录当前 `hipShift` 为 `replantAlignFrom`；
- 重踏期间**不跑常规 g 求解**；目标 = `alignFrom · (1 − smoothstep(progress))`，
  `progress` = 已开始脚的平均 phase → 全体进度平滑衰减到 0；
- 全部脚落地后保持 δ=0 一段 `settle=0.2s`（settle 期同样跳过常规解/fallback/projection）；
- settle 结束：清零 `stanceWarmStart`（非累积、最小范数解，避免把 fade 期间的大位移解带进新站姿），
  恢复常规 g；
- 重踏/衰减期间跳过 `projectStanceShift` 与 fallback 求解（pin 在动，投影/回退会把 δ 猛推回旧流形）。

### 3.5 稳态

重踏结束后 `pin = 新 clip 作者站姿`，g 正常求解；防滑、膝形、脚朝向软跟随、R1 释放阈值、pat 禁锁、
walk/sit 等既有行为不变。

---

## ④ 参数与门禁

| option | 默认 | 说明 |
|---|---|---|
| `poseReplant` | `true` | `false` = 完全旧行为（跨 clip 保持锚点），A/B 与一键回滚 |
| `replantMinMoveM` | `0.012` m | 小于该值走迷你混合（不抬脚） |
| `replantLiftMinM` | **`0.012`** m | 抬脚弧线下限；**设计初值 0.010**，见下 |
| `replantLiftMaxM` | `0.030` m | 抬脚弧线上限 |
| `replantMaxSpeedMps` | `0.45` m/s | `T=clamp(d/本值, min, max)` |
| `replantMinDurationSec` | `0.30` s | 单脚最短换步时长 |
| `replantMaxDurationSec` | `0.45` s | 单脚最长换步时长 |
| `replantStepGapSec` | `0.08` s | 两脚间隔（后脚 = 前脚完成 + gap） |
| `stanceAlignMode` | `'3d'` | `'mean'` 时 replant 自动关闭（旧 A 回滚通道） |

常量（`foot-lock.ts`）：`REPLANT_HORIZONTAL_LEAD=0.12`、`REPLANT_SETTLE_SEC=0.2`、
`REPLANT_MINI_DURATION_SEC=0.15`、`REPLANT_LIFT_FACTOR=0.15`。

**与设计的 2mm 偏差（已复核替代）**：抬脚下限由 `0.010` 提高到 `0.012`。原因：离线验收用 8mm
弧线接地阈值时，`0.010` 下小步（d≈3.6cm）在 30fps 的起/落各有一帧水平移动落在 8mm 内 →
接地滑移 **8.7px@540**，超 6px 门禁；`0.012` 下 **5.7px**。视觉差异 2mm≈0.6px@540；
需要严格复现设计初值时传 `replantLiftMinM: 0.01` 即可 A/B。

---

## ⑤ 改动文件

| 文件 | 改动 |
|---|---|
| `src/renderer/src/vrm/foot-lock.ts` | 主实现：clipId 检测、pending、`startReplant`/`advanceReplant`/`finishReplantNow`/settle、g 让位、快照字段、reset；文件头新增 replant 设计说明 |
| `src/renderer/src/vrm/animator.ts` | foot-lock context 增加 `clipId: lastClipSnapshot.clipId ?? null`（仅此一行语义） |
| `src/renderer/src/vrm/runtime-types.ts` | `VrmFootLockOptions` 新增 replant options；`VrmFootLockDebugSnapshot` 新增 8 个可选字段 |
| `src/renderer/src/core/wave2-contract.ts` | `AnimationDebugSnapshot.footLock` 内联类型同步新增 8 个可选字段（旧消费方不填也通过类型检查） |
| `tests/vrm-foot-lock.test.ts` | 新增 7 个 replant 用例（15cm 基本、迷你混合、打断、ineligible、false/mean、不传 clipId、reset） |
| `docs/fix-report-2026-11-11-footlock-stance-replant.md` | 本报告 |
| `docs/known-issues.md` | 更新 foot-lock 条目（站姿抹平已修 + 新权衡） |

**未改**：`clip-player.ts`、`micro-motion.ts`、`assets/**`、其他 tracked 文件；不依赖 clip-player 新字段。

---

## ⑥ 验收

### 6.1 单元测试（fake rig，真实比例）

命令：`./node_modules/.bin/vitest run tests/vrm-foot-lock.test.ts tests/vrm-micro-motion.test.ts`
结果：**82 passed**（foot-lock 75 + micro 7）。

新增用例覆盖：
- 15cm 站姿差 A→B（含 20 帧 `transitioning:true` fade）：fade 后单脚抬脚（弧线峰值 >1cm）、
  两脚均离开旧锚点 >12cm、落地后残差 <2mm、稳态 45 帧脚漂 <2mm、contact/weight 不释放、
  hipShift <5mm、膝角差 <1°；
- 任意重踏帧 `max(liftL,liftR)>0.01`、两脚 lift 不同时 >2mm（单脚离地）；
- 8mm 小站姿差走迷你混合：`lift=0`、单帧位移 <6mm、首帧位移 <3mm（无瞬移）、到位；
- 重踏中 B→C 再次换 clip：pending 期脚位冻结（<1cm，不跳回旧锚点）、从当前脚位重起弧、
  单帧 <3.5cm、无 NaN、最终落到 C 作者站姿（<2mm）；
- mood=walk + clipId 变化：不触发、pinned=false、权重淡出；
- `poseReplant:false` / `stanceAlignMode:'mean'`：不触发、脚保持旧锚点（A/B 回滚通道）；
- 不传 `clipId`：跨 clip 站姿变化保持旧锚点（旧行为兼容）；
- `reset()`：清空 pending/active/lift，lastClipId 置空，不误触发。

### 6.2 离线验收（真实 VRM + 真实 idle clip + `VrmMicroMotion` + 产品 `VrmFootLock`）

夹具：`tests/tmp/footlock-impl/harness.ts`（复制并改造调查 harness；真实
`assets/vrm/aventurine-tpose.vrm` + `assets/motions/**`）。
序列：`hsr-idle → adv-idle → adv-think01 → adv-worry01 → hsr-commonIdle → hsr-idleShow`，
fade 0.9s，每段 hold 3.2s，30fps，context 传真实 `clipId`。
脚本/结果：`tests/tmp/footlock-impl/acceptance.test.ts` / `acceptance-results.json`。

**稳态（尾 1s，540px；非表演 idle）**

| clip | 新行为 脚位均值误差 | 旧行为 脚位均值误差 | 新 站姿宽误差 | 旧 站姿宽误差 | 新 knee Δ | 新 hipShift(max) |
|---|---|---|---|---|---|---|
| hsr-idle | 3.4mm | 3.4mm | 1.3mm | 1.3mm | 0.36° | 21.3mm |
| adv-idle | **17.4mm** | **173.4mm** | **0.0mm** | 27.3mm | 0° | 45.0mm |
| adv-think01 | 16.8mm | 136.3mm | 0.1mm | 31.6mm | 0° | 30.4mm |
| adv-worry01 | 5.3mm | 148.4mm | 0.7mm | 29.0mm | 0° | 19.4mm |
| hsr-commonIdle | 15.7mm | 133.0mm | −1.0mm | 36.5mm | 0° | 28.3mm |
| hsr-idleShow（表演型，释放脚） | 67.0mm | 239.9mm | 64.7mm | 233.1mm | 0° | — |

旧行为 5 段站姿宽恒为 **31.2cm**（作者 27.5–31.0cm），复现「所有站姿一样」；新行为宽度跟作者
（误差 ≤1.3mm）。脚漂移（尾 1s）新行为 **≤0.02mm**，contact 100% 刚性钉住。

**切换（窗 = 2 帧前 ~ fade+1.6s）**

| switch | replant 帧 | 接地滑移(8mm) | 单帧最大脚位移 | 同时离地 | 抬脚峰值 | 目标水平残差(起点) |
|---|---|---|---|---|---|---|
| hsr-idle→adv-idle | 38 | 0.4px | 9.15px | 0 | 27.6mm | 184.2mm |
| adv-idle→adv-think01 | 28 | 5.1px | 2.86px | 0 | 12.0mm | 42.1mm |
| adv-think01→adv-worry01 | 23 | 5.7px | 1.87px | 0 | 11.8mm | 27.6mm |
| adv-worry01→hsr-commonIdle | 28 | 3.6px | 2.36px | 0 | 12.0mm | 34.8mm |
| hsr-commonIdle→hsr-idleShow | 8 | 44.1px* | 4.61px | 3* | 52.1mm | 68.0mm |

\* 表演型 idle：右脚作者抬 4.2cm → 按设计释放跟随作者；左脚重踏。该行不计入普通 idle 门禁
（同时离地 3 帧为「左脚重踏 + 右脚作者抬脚」的预期重叠），单独记录。旧行为该段 50.1cm 宽、
新行为 33.3cm（仍比作者 26.8cm 宽 6.5cm，见 §⑦）。

**对照/门禁**：
- NaN 0 帧、contact 抖动（pinned 翻转）0 次（非表演段）；
- 接地滑移 5.7px ≤ 6px、单帧 9.15px ≤ 10px、同时离地 0；
- 稳态脚位 17.4mm ≤ 20mm、站姿宽 1.3mm ≤ 10mm、膝差 0.36° ≤ 1°、脚漂 0.02mm < 1mm；
- **未达标**：hipShift 45.0mm > 20mm（详见 §⑦）。

### 6.3 性能

真实 VRM、3000 帧稳态 `update()`（`tests/tmp/footlock-impl/perf.json`）：多次运行
avg **0.215–0.229ms** / p95 **0.266–0.276ms** / max 0.59–0.65ms（目标 avg ≤0.3ms 达标；
机器负载下另一次分相运行 p95 0.27–0.34ms）。
完整 6 段序列分相（`perf-replant.json`）：稳态 avg 0.234–0.241ms；pending 0.224–0.232ms；
重踏 0.226–0.241ms；settle 0.227–0.238ms；单帧 max ≤0.50ms（稳态偶发 GC 1.0ms）。
稳态路径无每帧分配（沿用预分配 scratch；重踏 start 一次性分配候选/状态/目标四元数）。

### 6.4 门禁

```
./node_modules/.bin/vitest run tests/vrm-foot-lock.test.ts tests/vrm-micro-motion.test.ts
# 82 passed

pnpm typecheck
# typecheck:node + typecheck:web 通过

pnpm test
# Test Files 136 passed (136)
# Tests 2734 passed | 11 skipped (2745)
# Duration 4.12s
```

---

## ⑦ 风险 / 已知限制 / 回滚

1. **稳态 hipShift 19–45mm > 任务单 20mm**（最大 adv-idle 45mm）。
   - 这是 **micro-motion + g 的既有行为**：即使锚点 clip `hsr-idle` 稳态也 21.3mm；旧行为
     adv-think 57.3mm / common 72.1mm。replant 把脚 pin 到 fade 结束帧的作者站姿后，micro 继续
     呼吸/重心摆动，g 为保持「膝角=作者」需要持续解距离约束，2 条腿 3 未知量 → 1 参数族，
     本实现取最小范数解后仍可能落在 3–5cm 水平。
   - 要压到 20mm 内需要降低 g 的 idle 水平预算（web research 建议 2–3cm）或把 micro 的 hips
     平移改成旋转/从 `d_author` 剔除——本任务明确**不动** micro-motion/g 语义，故记录为遗留项。
   - 膝角/脚位/站姿宽均达标，用户可见的「站姿被抹平」已修；hipShift 是身体侧移量，已有
     pointer-rect 同步（known-issues L2/M-3）。
2. **表演型 idle（`hsr-idleShow*`）**：作者抬脚/转身，右脚释放跟随作者、左脚重踏；稳态站姿宽
   33.3cm vs 作者 26.8cm（仍宽 6.5cm），比旧行为 50.1cm 好。该类 clip 的作者意图是表演动作，
   本方案不强行把释放脚拉回站姿；后续若要更贴作者，可对表演型 clip 关闭 replant 或加软锚点。
   同时离地 3 帧是「左脚重踏 + 右脚作者抬脚」的预期重叠，不计入普通 idle 门禁。
3. **8mm 接地阈值 / 30fps**：接地滑移按「重踏弧线 <8mm 时的水平位移累计」统计，30fps 下
   起/落各可能采到一帧临界帧（5.7px）；60fps 会更小，10–15fps 下单帧位移会放大（`dt` 上限 0.1s，
   非本轮验收口径）。设计初值 `liftMin=0.010` 时该指标 8.7px（超 6px），故默认 0.012（§④）。
4. **打断**：重踏中再换 clip 会从当前 pin 重规划；fade 期间脚位冻结，但 g 重新接管会有 mm 级
   IK 残差（单测容差 1cm），不是跳变。
5. **目标不可达**：重踏期间沿用既有「腿长 + 4cm 骨盆下沉」释放兜底；若目标超出，脚会释放跟随
   动画，重踏状态结束（不会硬拽）。
6. **回滚**：
   - 完全旧行为：`new VrmFootLock(avatar, { poseReplant: false })`；
   - 旧 A 骨盆解 + 无重踏：`{ stanceAlignMode: 'mean' }`（replant 自动关闭）；
   - 只调轨迹：`replantLiftMinM/replantLiftMaxM/replantMaxSpeedMps/replantMinDurationSec/
     replantMaxDurationSec/replantStepGapSec`；
   - 无 clipId 的旧调用方（不传 context.clipId）自动保持旧行为。

---

## ⑧ 证据路径

- 单测：`tests/vrm-foot-lock.test.ts`（`VrmFootLock v3：换姿势重锚` 7 个用例）
- 离线验收：`tests/tmp/footlock-impl/acceptance.test.ts`、`tests/tmp/footlock-impl/harness.ts`
- 验收 JSON：`tests/tmp/footlock-impl/acceptance-results.json`
- 性能 JSON：`tests/tmp/footlock-impl/perf.json`、`tests/tmp/footlock-impl/perf-replant.json`
- 调查根因/调研：`tests/tmp/footlock-replant/root-cause.md`、`tests/tmp/footlock-replant/web-research.md`
- 原型 A/B/C/D：`tests/tmp/footlock-replant/replant.test.ts`、`run/variants.json`
- 已知问题：`docs/known-issues.md`（foot-lock 条目）

---

## ⑨ Lead 复核与实机验收（2026-11-11 15:20–15:45，独立复跑）

> 复核人：Lead。实现 subagent 交付后，Lead 逐项复核 diff，并做了 4 处修正/增强后独立验收：

### 9.1 Lead 对实现的复核修正

| # | 修正 | 原因 / 证据 |
|---|---|---|
| 1 | **3-DOF 解从 0 出发（不再用上一帧 warm start）** | 两脚 2 约束在双腿近伸直时接近相切，exact 解是一条一维流形；带 warm start 会被 micro-motion 逐帧推着沿流形漂移。离线逐帧诊断：站稳后 hipShift 从 0 缓慢漂到 **65mm**（`tests/tmp/lead-verify-replant/diag-*`）。从 0 出发收敛到近最小范数解后不再漂移。 |
| 2 | settle 0.2s → **0.4s**，并新增 **0.5s 投影渐入期**（`REPLANT_PROJECTION_GRACE_SEC`：settle 结束后先跳过 `projectStanceShift` 0.5s） | 原实现 settle 结束后立刻恢复投影：换步刚结束约束流形仍在动，一次投影把 τ 滞后猛推回，Lead 离线验收实测**单帧身体跳 8.7px@540**；加渐入后降到 **1.7px**。 |
| 3 | replant **mood 白名单 v1 只开 `idle`**（`REPLANT_ALLOWED_MOODS`） | 用户诉求与 R1 调查结论一致；dsh/pat/一次性片段避免在 breaked/revive 等动态段误重锚（P1 再评估）。 |
| 4 | 调试快照新增 **scene-local 踝位** `leftFootX/Z`、`rightFootX/Z`（`FootRig.lastFootX/Z`，无每帧额外开销） | dev-capture JSON 只有误差没有绝对脚位，无法断言「各站姿=作者」；补充后实机断言可跑（`runtime-types.ts`/`wave2-contract.ts` 可选字段，旧消费方不回归）。 |
| 5 | `deactivate()` 顺手清 `rig.replant`；文件头同步 v3 设计/回滚说明 | 状态清理完整性。 |

### 9.2 Lead 独立离线验收（真实 VRM + 真实 idle clip + 产品代码；不是实现方的断言）

脚本：`tests/tmp/lead-verify-replant/acceptance.test.ts`（复用 R1 夹具，独立阈值/断言），序列
`hsr-idle→adv-idle→adv-think01→adv-worry01→hsr-commonIdle→hsr-idleShow`，fade 0.9s/hold 3.2s/30fps。
结果（`lead-acceptance.json`）：

| 检查 | 新行为 | 对照 `poseReplant:false`（旧行为） |
|---|---|---|
| 稳态脚位 vs 作者（非表演段） | **≤5.4px@540**（micro 相位残差） | 41.4–54.0px |
| 稳态站姿宽 vs 作者 | **≤0.4px** | 8.5–11.4px（5 段恒 31.2cm） |
| 换姿势脚位移（hsr→adv） | **57.4px**（单脚先后抬脚换踏） | ~0（脚被钉死） |
| 同时离地帧（非表演 idle） | **0** | 0 |
| 换步后膝角 vs 作者（grace 后稳态） | **≤1.5°** | 0°（脚不动→膝=作者，但脚位错） |
| 单帧身体位移（含换步/settle） | **≤2.12px@540** | 0.79px |
| 触地滑移累计 / 单帧 | ≤15.5px / ≤2.86px（小抬脚阶段口径）；见 §7-3 | 0 |

### 9.3 Lead 实机 dev-capture（隔离 HOME/PROFILE，当前 build）

`tests/tmp/lead-verify-replant/run-idle/`：360 帧 × 250ms（90s），`PET_DEV_CAPTURE_IDLE=1`。
断言脚本 `tests/tmp/lead-verify-replant/assert-captures.mjs` → **0 FAIL**：

| clip（实机稳态） | 运行时站姿宽 | 作者站姿宽 | 宽差 | 脚位 vs 作者 |
|---|---|---|---|---|
| hsr-idle | 97.1px | 96.7px | +0.4px | 4.1/4.0px |
| hsr-idle2 | 96.0px | 96.7px | −0.7px | 6.3/4.9px |
| hsr-commonIdle | 86.5px | 85.7px | +0.8px | 6.3/7.2px |
| hsr-idleShow（表演型） | 76.4px | 79.1px | −2.7px | 12.6/16.6px |
| hsr-idleShow2 | 78.4px | 80.6px | −2.2px | 12.7/10.5px |

- 换踏帧 13 帧、抬脚峰值 9.0px@540（2.9cm）、**双脚同时离地 0 帧**、无 NaN；
- 视觉证据 `tests/tmp/lead-verify-replant/stance-montage.png`（各姿势脚位/张开幅度明显不同，不再全部一样）。

### 9.4 门禁与打包

| 门禁 | 结果 |
|---|---|
| `pnpm typecheck` | ✅ |
| `pnpm test` | ✅ **137 files / 2751 passed / 11 skipped**（含新增 7 个 replant 单测） |
| `pnpm build` | ✅ |
| `pnpm package:dir` + `package:check` | ✅ 35 passed / 1 warnings（缺 .icns，既有 R-07） |

### 9.5 遗留：idle 稳态 hipShift 摆动 / 走路起步的身体侧移（**用户 2026-11-11 15:1x 报「走路会漂移」**）

- 复现：idle 稳态 `hipShift` 会随 micro-motion 缓慢摆动（离线 6 段实测 19–45mm；实机旧构建更大）。
  这是 micro-motion 的 hips 旋转（sway/weightShift ±2°）+ 两脚 pinned 时 g 为保持膝角=作者做的
  骨盆补偿——**既有行为**（v2 起就有；旧 A 更大），不是 replant 引入。
- 影响：开始走路时（foot-lock 进入 `!eligible`，hipShift 按 τ=0.2s 归零）会在 0.2–0.4s 内产生
  **≤4.5cm（14px@540 / 7px@270）的身体侧移**；旧构建（13:28）可能更大或有中间版本 bug。
- 已确认 **walk 期间 foot-lock 一律不锁**（`pinned=false`，见单测/旧验收）；「整段走路都在滑/漂」
  不存在于当前 HEAD 代码路径，更像旧构建（见下）。彻底消除起步侧移需要 R3′（把 micro 的 hips
  旋转改到 spine/chest，`tests/tmp/inv-leg2/REPORT.md` §7）或把 g 的 idle 水平预算降到 2–3cm
  （需重跑膝角验收），属独立后续项。
- **构建时间线**：用户当前运行进程启动于 13:28，加载的是当时打包的中间构建（DSH 退出耦合修复
  打包时混入了当时尚未完成的腿部修复代码）；14:32 最终腿部修复构建、以及本报告的 v3 重踏修复
  均未被加载。Lead 已重新 `package:dir`（dist 含本修复），重启桌宠即生效。

