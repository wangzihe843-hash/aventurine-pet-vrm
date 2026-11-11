# 追加修复报告：已知限制 R1（抬脚释放阈值）+ L2（hipShift 命中区同步）

> 日期：2026-11-11 · 关联：上一轮修复 [fix-report-2026-11-11-ledge-rest-and-leg-ik.md](fix-report-2026-11-11-ledge-rest-and-leg-ik.md)
> 用户要求（2026-11-11 00:40）：「调查一下这个已知限制能不能修，复核结论，能修就派 subagent 修」。
> 调查（只读）：`tests/tmp/inv-limits/REPORT.md`（limits-detective，task-7）；实现记录：`tests/tmp/fix-limits/NOTES.md`；
> 实机验收采集：`tests/tmp/lead-accept/r1-{idle,idle2,l2-verify,window,window2}/`（`tests/tmp/` gitignore）。

## 0. TL;DR

| 已知限制 | 调查结论 | 本轮处理 |
|---|---|---|
| L1 腿形残差（8–20° 膝屈曲 / 两脚不对称 7.8cm / idleShow 21cm 站姿差） | **部分可修**：运行时不能根治（近伸直腿敏感 + 站姿差本身）；**但发现一个真 bug**：`hsr-idleShow` 作者右脚**有意抬升 4.1cm** 被 5cm 接触退出阈值误钉回地面 → 右膝被 IK 拧出 +22° | **已修 R1**：抬脚释放阈值 3/5cm → **1.2/2.0cm**；该脚正常释放、脚随作者动画抬起（不再 IK 拧腿） |
| L2/M-3 命中/气泡未随 hips 横移 | **可修（低风险）**：hipShift 是 scene-local 米，屏幕横移 = `ppm·(cos yaw·shiftX + sin yaw·shiftZ)` | **已修 L2**：`PetView.getHipShiftScreenXPx()` + `pointer-rect` 纯函数 + `main.ts currentPointerRect` 合成（hit/pat/气泡/pointerGate 一处全修） |
| R2 不对称残差锚点慢漂移（可再降膝横向残差 ~50%，代价 ≤6px/s 慢脚漂） | 可修但有产品取舍（与历史「脚滑」投诉冲突） | **本轮不做**，数据保留为可选项（见 §4） |
| R3 micro softKnee 0.8→0.4cm（膝屈曲均值 10→7.4°） | 可修，但改变用户已验收的「腰要会动/软膝」观感 | **本轮不做**，待用户拍板（见 §4） |
| 数据侧 idle 站姿归一化（唯一根治，1–2 人日） | 需改 bake 管线 + 重烘焙 9 条 idle | 另立中期任务（见 §4） |

## 1. 背景：上一轮修复后剩余的已知限制

上一轮（commit `424bacb`）后仍存在：
1. **L1 腿形残差**：foot-lock A（锚点-作者脚位对齐）只做水平平移，两脚不对称残差（最大 7.8cm）无法同时对齐；
   近伸直腿对 1mm 级距离极敏感（≈3.6°）→ 部分 idle 变体膝屈曲仍偏差 8–20°；`hsr-idleShow` 站姿差 21cm >
   0.18m 平移预算。
2. **L2/M-3**：foot-lock 让身体视觉横移 ≤0.18m（≈56px），但 hit/气泡仍按物理 `petRect`（仅补偿竖向 visualOffset）
   → 极端 idle 变体下「看到的身体」与可点击/悬停区横向错开。
3. 另有 micro softKnee 贡献 ~14° 膝弯（用户已验收「腰要会动」，未改）。

## 2. R1：作者抬脚被误钉（真 bug，已修）

### 2.1 根因（调查 §2 / §4-R1）

- `hsr-idleShow` 在作者动画里**有意把右脚抬升 4.1cm**（不是滑步；是表演 idle 的抬脚/重心动作）。
- 旧 contact 退出阈值 `CONTACT_EXIT_LIFT_M = 0.05`：4.1cm < 5cm → 不释放；进入阈值 3cm 也偏松。
- 结果：两骨 IK 把抬起的脚**钉回地面锚点** → 右膝被拧出 **+22.1°**、左腿被反向带弯 −21.1°
  （离线真实 VRM+clip 矩阵，`tests/tmp/inv-limits/results/exp-results.json`）。
- 这是 L1「腿形残差」里最扎眼的单点来源，且是**误判**而不是固有残差。

### 2.2 修复（`src/renderer/src/vrm/foot-lock.ts`）

```ts
const CONTACT_ENTER_LIFT_M = 0.012   // 原 0.03
const CONTACT_EXIT_LIFT_M  = 0.020   // 原 0.05
```

- 保留迟滞（enter<exit）、crossfade 期间 `transitioning` 冻结接触判定；其余接触状态机/朝向/骨盆/平移逻辑零改动。
- 影响面：其余 idle 变体作者踝抬升大多 ≤7mm（调查 authorStance 实测），新阈值不会误释放普通站姿；
  ≥2cm 的有意抬脚现在会正常释放、脚跟随作者动画，落地后按当时姿态重新锚定（不再硬拽）。
- 测试（`tests/vrm-foot-lock.test.ts`）：新增「作者脚抬 4cm → 释放/权重 τout 淡出/脚随动画抬 ≈4cm」、
  「抬 1cm → 保持钉住」、「显式旧阈值 options 可配置」；2 个依赖旧阈值的用例按新语义调整（crossfade/pelvis）。

### 2.3 实机验证

- `tests/tmp/lead-accept/r1-idle2/`（300 帧×400ms，autonomous=false）：捕获到 3 段 `hsr-idleShow`；
  右踝抬升 3.4–4.1cm 时 **`rightPinned=false`、权重 1→0**，左脚继续钉住；脚落地后重新接触。
  修复前同一 clip 的帧（`tests/tmp/lead-accept/post-idle/` 帧 71–74）为 `rightPinned=true` 且 `footError≈0`
  —— 即 IK 把抬起的脚强行拉回地面。
- 视觉对比（legs montage）：`tests/tmp/lead-accept/{preR1-idleShow-legs,postR1-idleShow-legs}.png`；
  重落位帧（84–89）montage 无异常跳变：`tests/tmp/lead-accept/r1-repin-85-88.png`。
- 其他 idle 变体（hsr-idle/idle2/commonIdle/adv-idle 等）在 130s+120s 采集中 released=0~2（均为 clip 切换过渡），
  未出现额外释放/抖动。

## 3. L2/M-3：命中/气泡跟随 hips 横移（已修）

### 3.1 实现（按调查 §5）

1. `src/renderer/src/interaction/pointer-rect.ts`：`HIP_SHIFT_EPSILON_PX=0.5`、`HIP_SHIFT_MAX_PX=96`、
   `resolveHipShiftPx()`、`hipShiftToScreenXPx()`（`ppm·(cos yaw·shiftX + sin yaw·shiftZ)`）；
   `offsetPetRectForVisual(rect, visualOffsetY, shiftXPx = 0)`（第三参默认 0 → 旧调用逐位兼容）。
2. `src/renderer/src/vrm/pet-scene-vrm.ts`：`getHipShiftScreenXPx(snapshot?)`——复用 main.ts 同帧
   `animSnapshot` 的 `footLock.hipShiftXM/ZM` + `modelRoot.rotation.y` + `pxPerMeter`（**不额外构建 debug 快照**）；
   `scene/pet-view.ts` 的 `PetView` 加可选签名（PMX 后端不实现 → 0）。
3. `src/renderer/src/main.ts` `applyRuntimeOutput()`：`currentPointerRect = offsetPetRectForVisual(petRect,
   visualOffset, hipShiftXPx)`；气泡/hit/pat/pointerGate 全部经 `pointerRect` 自动受益；
   `debug.pointerRect` 暴露验收面（`debug.petWorld` 保持物理口径）。

### 3.2 验证

- 单测（`tests/fix-f4-pointer-rect.test.ts`）：NaN/Inf/ε/钳制；yaw 0/π2/π/−π2 换算；默认 0 旧行为逐位兼容；
  visualOffsetY 与 shiftX 正交叠加。
- 实机（`tests/tmp/lead-accept/r1-l2-verify/`，140 帧×400ms）：129 帧 `|shiftX|>0.5px` 时
  `pointerRect.x − petRect.x` 与 `ppm·hipShiftXM` 最大误差 **0.04px**；11 帧零位移时 `pointerRect=null`（旧行为）。
- 窗沿回归（`tests/tmp/lead-accept/r1-window2/`，110 帧×800ms）：100/100 窗沿帧 mood=sit、0 站立/走动；
  sit 的 `pointerRect` 竖向补偿 103/104 帧与 `visualOffset` 一致（≤2.1px，1 帧 hipShift 过渡滞后）。

## 4. 未做的候选（调查结论，留待决策/另立任务）

| 候选 | 量化收益 | 不做的原因 |
|---|---|---|
| R2 不对称残差锚点慢漂移（2cm/s） | 膝相对踝残差均值 8.3→4.0px、最坏 42→17px | 会引入 ≤6px/s 的慢速脚位 creep（与历史「静态动作脚滑」投诉冲突）；用户核心诉求是腿不异常弯，本轮先交付无脚滑方案 |
| R3 micro softKnee 0.8→0.4cm | 膝屈曲均值 10→7.4° | 改变用户已验收的「腰要会动/软膝」观感，需用户拍板 |
| (a) 放宽 `MAX_HIP_SHIFT_M` 0.18→0.22/0.25 | ≈0 | 实测无收益、身体横移变大（L2 恶化） |
| (b) hips yaw 刚体对齐 | ≈0（旋转不改变髋-踝距离→屈曲角不变），横向残差反而变差 | 数学上无效 + 10–15° 身体扭转 |
| (d) 额外骨盆下沉 | 更弯（10→15.7°） | 与诉求相反 |
| (e) 切 clip 重锚 | 脚一帧跳 40–74px | 历史投诉的脚滑原样回归 |
| **(f) 数据侧 idle 站姿归一化** | 唯一根治（两脚残差、近伸直敏感都消失） | 需改 `scripts/vrm/motion/lib/retarget.mjs` + 重烘焙 9 条 idle，**1–2 人日**，另立中期任务 |

## 5. 验证门禁（2026-11-11 01:10）

| 检查 | 结果 |
|---|---|
| `pnpm typecheck` | exit 0（node+web） |
| `pnpm test` | **123 files / 2149 passed / 11 skipped（2160 cases）**（上一轮基线 2131；+18 用例，0 失败） |
| `pnpm build` | exit 0 |
| 实机 idle | R1：idleShow 抬脚正常释放、无额外释放；L2：pointerRect 与 hipShift 最大误差 0.04px |
| 实机 window | 100/100 帧 sit、0 站立/走动；pointerRect 竖向补偿正确 |

## 6. 文件

```
src/renderer/src/vrm/foot-lock.ts                 R1 阈值（1.2/2.0cm）+ 注释
tests/vrm-foot-lock.test.ts                       +3 例，2 例按新语义调整
src/renderer/src/interaction/pointer-rect.ts      L2 纯函数 + offsetPetRectForVisual 第三参
src/renderer/src/vrm/pet-scene-vrm.ts             getHipShiftScreenXPx(snapshot?)
src/renderer/src/scene/pet-view.ts                PetView 可选方法
src/renderer/src/main.ts                          currentPointerRect 合成 + debug.pointerRect
src/renderer/src/debug.ts                         debug.pointerRect 类型
tests/fix-f4-pointer-rect.test.ts                 +3 组纯函数/换算/兼容用例
src/main/index.ts                                 dev-capture 快照增加 pointerRect 字段（验收用）
```

## 7. 回滚

- R1：`foot-lock.ts` 两个常量改回 0.03/0.05（或 `VrmFootLockOptions` 传入旧值，测试已覆盖该配置路径）。
- L2：`main.ts` 第三参/`getHipShiftScreenXPx` 调用去掉即回旧行为（`offsetPetRectForVisual` 默认 shiftXPx=0 逐位兼容）。
