# 静态动作脚滑（foot planting）修复报告

> 日期：2026-11-09 · 范围：VRM 后端运行时（`src/renderer/src/vrm/foot-lock.ts` + animator 接线）
> 用户问题：「静态动作固定腰部导致桌宠的脚会滑来滑去」——之前修过（commit `235430e` 加的 foot-lock IK），
> 但问题仍在（本次确认：**旧实现从未真正触发过**，不是被后来改坏）。
> 调研参考：[research/foot-slide-static-planting.md](research/foot-slide-static-planting.md)。
> 证据目录（gitignore）：`tests/tmp/foot-slide/`。

---

## 0. TL;DR

| 项 | 结论 |
|---|---|
| 根因 1（**foot-lock 等于没生效**） | 旧接触判据是「bbox 脚底 y（`avatar.restFeetY` ≈ **0.7mm**）+ 2cm」，却拿去比较**踝骨世界 y**（本模型 rest 踝高 ≈ **9.83cm**）→ `footY <= restFeetY + 0.02` 在站立/待机时永远不成立；旧单测的假 rig 恰好把脚骨放在 y=0（= restFeetY），把缺陷掩盖了 |
| 根因 2（**观感来源**） | idle 池跨来源（HSR/adv/mate）站姿脚位差约 15–20cm；播放器每 **12–20s** 随机换一条 idle、以 **0.8–1.0s crossfade** 过渡——混合期间腰/hips 基本不动（clip 的 `Hips.p` 实测 ≈0.1mm、贴地是常量），脚却在地面滑 |
| 量化（修复前） | 540px 宠物高、实机截图像素：一次 idle 变体切换，**左脚横向滑 36px、右脚 49px**（≈12–16cm） |
| 修法 | foot-lock 重写：rest 踝高接触基准 + 抬升/速度迟滞；**scene 局部踝锚点（位置+朝向）跨 clip 保持**；两骨闭式 IK；有界骨盆下沉（≤4cm）；不可达/抬脚释放；进入移动/拖拽/坐/睡时 IK 权重平滑淡出；**只对静止动作启用**（walk/climb/fall/drag/grabWindow/sit/sleep 不锁） |
| 量化（修复后） | 同一场景 50s / **4 次** idle 变体切换（`hsr-idle → adv-idle → hsr-idleShow → adv-worry01`）：脚部像素 x **左脚 1681 恒定（0px 漂移）、右脚 1794→1795（≤1px）**；所有快照 `leftPinned/rightPinned=true`、`weight=1`（0 帧掉锁）、`leftFootErrorM` ≤ 0.0024m；fps 28.5–30（无回归） |
| 回归 | `pnpm test`：**109 文件 / 1893 passed / 14 skipped**（基线 1885 passed，foot-lock 用例 19→27）；`pnpm typecheck` 0；`pnpm build` 0；walk mood / 拖拽 / 坐 / 睡 实测 `pinned=false` |

---

## 1. 复现与根因证据

### 1.1 旧 foot-lock 的接触判据（静态分析）

`foot-lock.ts`（旧）：

```ts
const contact = footLocalY(rig.foot) <= this.avatar.restFeetY + this.contactEpsilonM // 0.02
```

而 `avatar.restFeetY` 来自 `avatar-loader` 的 **rest 包围盒最低点**（本模型 bbox 脚底 y≈0.0007m），
`rig.foot` 是 `humanoid.getNormalizedBoneNode('leftFoot')`（**踝骨**）。用三-vrm normalized rig 的实测：
rest 踝高 ≈ **0.0983m**（`aventurine-tpose.vrm`：hips 1.0661 / upperLeg 0.9784 / lowerLeg 0.5426 / foot 0.0983）。

→ 站立/待机时 `footLocalY ≈ 0.0983 ≫ 0.0007 + 0.02 = 0.0207`，**接触判定永远为 false**，foot-lock 从未运行。
旧单测的假 rig 把踝骨放在 y=0（= restFeetY），因此 5 个单测全绿但掩盖了真实模型上的失效。

### 1.2 为什么「腰部固定」时脚会滑（实机量化）

- idle 池 20 条：HSR 官方 5 + adv（3ds Max→Biped）5 + Mate-Engine 10。用预览器逐帧量测站姿踝锚点
  （`tests/tmp/foot-slide/all-idle/*.metrics.json`），不同来源站姿脚位差很大，例如：
  - `hsr-idle`：左踝 (x=0.273, z=-0.033)、右踝 (x=-0.039, z=-0.180)；
  - `adv-idle`：左踝 (x=0.111, z=-0.091)、右踝 (x=-0.174, z=-0.084)；
  - 左右脚单脚横向差 **~17cm**。
- 播放器 idle 变体轮换间隔 **12–20s**、crossfade **0.8–1.0s**（`VARIANT_SWITCH_CONFIG.idle`）：
  混合期间两条 clip 的腿局部旋转按权重插值 → 踝位置在模型空间里滑过中间姿态；hips 平移几乎为 0
  （`assets/motions/{hsr,adv}/*idle*.json` 的 `Hips.p` 首帧后只有 1e-4 量级的竖直微动），贴地补偿又是 per-clip 常量
  → 视觉上就是**腰不动、双脚在地面上滑**。
- 修复前实机截图像素量测（`tests/tmp/foot-slide/idle-caps/`，540px 宠物）：

| 帧 | clip | 左脚像素 x | 右脚像素 x |
|---|---|---|---|
| 13–17 | hsr-idle（稳定） | 1681 | 1794 |
| 18–24 | adv-idle（crossfade 后） | **1645（−36px）** | **1745（−49px）** |

---

## 2. 修复方案（`vrm/foot-lock.ts` 重写）

参考：Orange Duck《Inverse Kinematics and Foot Locking》（foot sliding = 速度不匹配；IK 是对现有姿势的
最小修改；宁可少量滑步也不要把腿拉畸形）、rabfulton/VRM `docs/foot-planting.md`（VRM 运行时脚部固定：
rest 踝高/脚底平面、接触迟滞、位置+朝向锚点、有界骨盆下沉、跨 transition 的接触判定、释放条件）。
完整来源清单见 [research/foot-slide-static-planting.md](research/foot-slide-static-planting.md)。

### 2.1 关键行为

1. **接触基准 = 本模型 rest 踝高**：构造时从 normalized rest 骨实测（本模型 ≈9.83cm；测量失败回退
   `身高 × 0.057`），不再用 bbox 脚底。
2. **接触判定 = 抬升 + 水平速度双条件 + 迟滞**（默认：进入 `lift ≤ 3cm && speed ≤ 0.25m/s`；
   保持 `lift ≤ 5cm && speed ≤ 0.9m/s`）。crossfade 造成的混合位移（≈0.17–0.19m/s）不会被误判成抬脚，
   而 clip 里真正的抬脚/走步（>5cm 或 >0.9m/s）会释放。
3. **锚点 = scene 局部空间**（位置 + 朝向），**跨 clip 切换保持**：idle 变体换动作时脚不挪窝；
   朝向锚定避免脚掌随混合/小腿扭转而原地打滑（可 `anchorOrientation:false` 关闭）。
4. **两骨闭式 IK**（余弦定理 + 当前腿形极向量；段长用 rest 层级距离，rotation-invariant），
   只改 normalized `upperLeg/lowerLeg` 旋转，属于「最小修改」。
5. **有界骨盆下沉**：目标略超腿长时把 normalized hips 的 y 压低（默认 **≤4cm**，时间常数 0.12s，
   每帧基于 clip-player 刚写回的基准值计算，不累积）；仍不可达（站姿差 >~26cm，如稀有 `mate-pose1/2`）
   则释放该脚跟随动画——不硬拽腿。
6. **释放/重锁**：抬脚/超速/不可达 → 权重 0.15s 淡出后清 pin；落地静止后重新锁定（迟滞避免抖动）。
7. **过渡平滑**：进入移动/拖拽/坐/睡/悬空时，不瞬间清 pin，而是 IK 权重按 0.15s 淡出
   ——避免「待机→开始走路/拖拽起手」时脚从锚点瞬间弹回 clip 位（否则是新的跳变）。
8. **作用范围**：只在静止动作启用（`idle/pat/dsh*` 等）；`walk/climb/fall/drag/grabWindow/sit/sleep`
   一律不锁。**走路不改**（滑步仍由 clip-player V13 步幅地速校准负责），拖拽/坐/睡沿用原行为。
9. **只锁基础选片**：animator 额外要求「当前 clip 槽位 == 当前 mood」才允许（`context.allow`）：
   一次性事件 clip / 手动 clip（`slot='manual'`：intro、DSH 工作小动作、error 过场、debugSetPose 等）
   不锁，避免把表演动作误当静态待机。
10. **crossfade 期间冻结接触判定**（`context.transitioning = snapshot.fading`）：混合姿态的脚水平速度
    是两条 clip 站姿插值的**合成速度**，不是作者画的抬脚；冻结进入/退出判定但照常更新位置历史
    （否则 fade 结束第一帧会速度尖峰误释放）。这是 rabfulton/VRM「接触分类要用未混合目标动画」的
    最小实现。
11. **转身/换脚释放**：目标动画的脚朝向相对锚点偏转 >35° 且持续 >0.25s → 释放并按新朝向重锚，
    防表演型 idle（`hsr-idleShow*` 等）里硬拧脚踝；<35° 的普通 idle 变体 yaw 差不受影响。
12. **近伸直腿防膝翻**：`solveKneePosition` 增加可选 `poleHint`；foot-lock 在腿接近伸直、
    当前膝平面退化时沿用上一帧极向量（rabfulton/VRM 做法）。
13. **clip 未就绪不锁**：animator 只在 `clipPlayer` 已产出 clip 姿势时调用（否则会把锚点记在 startup
    rest T-pose 的脚位上）；未就绪时 `reset()`。
10. 失败/异常全部内部消化（不抛）；`getSnapshot()` 暴露 `animation.footLock`
    （pinned/weight/pelvisDropM/脚踝误差/抬升，米），供实机验收与排障。

### 2.2 参数（`VrmFootLockOptions`，均有默认值）

| 参数 | 默认 | 含义 |
|---|---|---|
| `contactEnterLiftM` / `contactExitLiftM` | 0.03 / 0.05 | 进入/退出接触的踝抬升（迟滞） |
| `contactEnterSpeedMps` / `contactHoldSpeedMps` | 0.25 / 0.9 | 进入/保持接触的水平速度上限 |
| `weightTauInSec` / `weightTauOutSec` | 0.08 / 0.15 | IK 权重淡入/淡出 |
| `maxPelvisDropM` / `pelvisDropTauSec` | 0.04 / 0.12 | 骨盆下沉上限/平滑 |
| `anchorOrientation` | true | 是否同时锚定脚朝向（>35° 持续 0.25s 触发转身释放+重锚） |

---

## 3. 验证

### 3.1 单测（`tests/vrm-foot-lock.test.ts`，27 用例，重写）

用**本模型真实比例**的假 rig（踝 0.0983 / bbox 脚底 0.0007 / 大腿 0.4358 / 小腿 0.4456）覆盖：

- 旧根因回归：真实比例站立时必须锁定（旧判据永远 false）；
- 跨 clip crossfade 站姿变化 15cm：脚留在锚点（漂移 <3cm，且把原本会移动的脚拉回）；
- 脚朝向锚定不随小腿旋转；身体缓慢移动时世界位置保持；骨盆下沉有界（≤4cm）且脚仍钉住；
- 拖拽 / 走路 / 攀爬 / 坠落 / 抓窗 / 坐 / 睡 / 未接地 均不锁；拖拽起手权重平滑淡出（不瞬间弹回）；
- `allow=false`（一次性/手动 clip）不锁；
- crossfade 冻结：transitioning=true 时快速混合不释放、过渡后仍钉住；对照组不冻结会释放；
- 抬脚超迟滞 → 释放；目标超出可达 → 释放（不硬拽）；落地后重新锁定；
- 转身释放：脚朝向偏 60° 持续 >0.25s → 释放并重锚（脚跟随作者转身）；短暂偏转/20° 偏转保持锁定；
- 近伸直腿 poleHint 保持膝平面（朝 hint 侧，不默认翻转）、当前膝平面明确时不覆盖；
- `solveKneePosition` 腿长钳制不 NaN。

`pnpm test`：**109 files / 1893 passed / 14 skipped**（foot-lock 27 个全部通过）；`pnpm typecheck` exit 0；`pnpm build` exit 0。

### 3.2 实机 A/B（Electron 真 app、私有 VRM、540px 宠物）

用 `tests/tmp/foot-slide/run-idle-caps-final.sh` 录制 idle（70 帧 ×700ms ≈ 50s），期间发生 **4 次** idle
变体切换（`hsr-idle → adv-idle → hsr-idleShow → adv-worry01`，每帧 debug 快照可查；
`hsr-idleShow` 是带转身的表演型 idle，用于验证新增的「转身释放」不会误触发）。

| 指标 | 修复前（`idle-caps/`） | 修复后（`idle-caps-final/`） |
|---|---|---|
| 脚部像素 x（左脚） | 1681 → **1645（滑 36px）** | **1681 恒定（0px）** |
| 脚部像素 x（右脚） | 1794 → **1745（滑 49px）** | 1794 → 1795（≤1px） |
| `animation.footLock` | 无该字段（旧实现从不触发） | 全部 70 帧 `leftPinned/rightPinned=true`、`weight=1`，`leftFootErrorM≤0.0024` |
| 骨盆下沉 | — | 0 ~ 0.0202m（≤4cm 上限，随站姿差变化） |
| fps | 29–30 | 28.5–30（无回归） |

回归实机快照（`tests/tmp/foot-slide/regression/`，`scripts/vrm/capture-app.mjs`）：
`stand`（idle）`pinned=true`；`sit` / `sleep` / `drag` `pinned=false`；`--mood walk` 强制的走路 clip
`pinned=false`（走路路径与修复前完全一致）。

### 3.3 独立验证（verifier teammate，task-2；非复用 Lead 证据）

独立 teammate 在**同一冻结版**（foot-lock md5 `dd36a5d…`，跑前跑后一致；0 次 HMR reload 的干净 run）上完成：

- `pnpm run typecheck` exit 0；`pnpm test` 109 files / **1893 passed** / 14 skipped，foot-lock 27/27；
- 实机 70 帧/50.35s（间隔 stdev 5.5ms）：**70/70 帧双脚 pinned、weight=1.0**，`footErrorM≤0.0019m`，
  `pelvisDropM` 0.0018–0.0252m（同 clip 段恒定 → 不累积）；PNG 脚部像素 x 波动 **≤0.5px**
  （左脚 1680.5–1681.0、右脚 1795.5–1796.0），两脚底边行恒 960；3 次切换（含 3 个 crossfade 帧）脚像素不变；
- 用同脚本复算修复前旧代码证据：单帧跳变 **左 36.5px / 右 47.0px**（全片 38.5/51.5px）→ A/B 成立；
- 附加 mood 门控实机：walk/sit/drag/sleep → `pinned=false/weight=0`；idle → `pinned=true/weight=1`；
- 审查结论：**建议合并，无 Blocker/High**；逐项核查 NaN/除零、首帧、骨盆不累积、release 后重锁、
  scene 局部锚点、walk/drag/sit/sleep 不误锁、foot-lock→lookAt→humanoid.update→vrm.update 顺序均通过。
- 证据：`tests/tmp/foot-slide/verify-run/REPORT.md` 与同目录 capture/分析产物。

---

## 4. 已知限制 / 后续（明确不做的事）

1. **走路没有一起锁**（用户明确要求不要把走路/拖拽修坏）：walk 的滑步继续走 `clip-player` 的步幅地速
   校准（V13）。若以后要治走路滑步，应单独 A/B，并考虑用「未混合目标动画 + 脚趾速度」做接触标注
   （见调研文档），不要和本次静态方案混在一起。
2. **极端站姿差会释放**：骨盆下沉上限 4cm，站姿差 >~26cm（如稀有 `mate-pose1/2` 变体）时释放该脚，
   让作者动画接管（可能仍有一次滑动）——这是「宁可少量滑步，不把腿拉畸形」的取舍。
3. idle 池里带小幅抬脚的表演 clip（如 `hsr-idleShow2`、`mate-happy`，抬脚 <5cm）会被钉住，可能轻微改变
   其原始的脚部微动；如观感不接受，可调 `contactExitLiftM` 或对特定 mood 关闭。
4. 目前用「踝高 + 水平速度」分类接触，没有做离线 contact 标注/脚趾速度曲线；在当前 idle 数据
   （脚速 ≤0.03m/s、抬升 ≤2.6cm）足够。加更多动作源时建议按调研文档升级为「未混合目标 + 脚趾速度 +
   中值滤波」的接触标注。
5. 脚部朝向锚定在脚 yaw 差异很大时可能让脚踝轻微扭转（实机 idle 组未见明显问题）；可
   `anchorOrientation:false` 只锁位置。超过 35° 持续 0.25s 会释放并按新朝向重锚（防表演转身硬拧）。
6. **独立验证发现的 Low 级边缘项**（均未在 70 帧 ×2 次实机 idle 里触发，记录备查）：
   - release 淡出期（~0.7s）内重锚是瞬时的（1–2 帧切到新站姿）；两次长录 5 个 idle 变体 **0 次 release**，
     未触发。若要更稳可要求「重锚前 weight≈0」。
   - 5cm 退出迟滞会压住 idle 中 ≤5cm 的有意抬脚（`hsr-idleShow` 右脚 clip 抬升 4.05cm 仍 pinned）；
     如观感不接受可调 `contactExitLiftM` 或按 clip tag 排除。
   - 骨盆下沉实测最大 2.52cm（切 idle 变体时上半身 ~5–8px 平滑起伏）——这是「脚钉住」的固有代价。
   - `reset()`（clip 变 null 的降级路径）不撤销已经写进 hips 的下沉，新 clip 懒加载期间可能短暂
     ≤2.5cm 下沉，下一 clip 立即恢复（正常 idle 流程不出现）。
   - 一次性/手动 clip 结束回 idle 的 crossfade 期间，若该 clip 内脚已被释放（allow=false），
     该段 ~0.8–1s 不锁、fade 结束后重新获取；属于过渡期行为，不影响 idle 变体互切。

## 5. 回滚

- 代码回滚：`git checkout <修复前 commit> -- src/renderer/src/vrm/foot-lock.ts` 等 5 个文件；
- 运行时关闭：`CreateVrmPetAnimatorOptions.footLock = false`（main.ts 组装 animator 处传参），
  行为回到修复前（等于旧实现，注意旧实现本来也不生效）。

## 6. 主要参考

- Orange Duck《Inverse Kinematics and Foot Locking》<https://theorangeduck.com/page/inverse-kinematics-foot-locking>，
  代码 <https://github.com/orangeduck/GenoView-InverseKinematics>
- rabfulton/VRM `docs/foot-planting.md` <https://github.com/rabfulton/VRM/blob/master/docs/foot-planting.md>
- pixiv/three-vrm issue #1643（hips position offset / 下陷）<https://github.com/pixiv/three-vrm/issues/1643>
- Unity：`OnAnimatorIK`、`TwoBoneIKConstraint`、`FootPlacement` 节点、Unity Discussions
  “固定一只脚在一点让 idle 动画围绕它工作”；MMD 足 IK / iClone 修脚滑（B 站）。
  完整清单与中文教程链接见 [research/foot-slide-static-planting.md](research/foot-slide-static-planting.md)。
