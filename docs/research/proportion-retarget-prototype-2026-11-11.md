# 比例感知肩/臂重定向原型（B）— 实现与验证报告（2026-11-11）

> 状态：**原型完成，未 commit、未改产品运行时**。产出只写 `tests/tmp/lead-proportion/**`（gitignore）；
> 由 Lead 复核后决定是否采纳/切换 manifest。基线 HEAD 含 upperChest α-fold `83d4d6c`。
>
> 用户决策不变：**保留可爱语义/手势，不做男性化**；目标 = 还原源 Zome 女体的视觉姿态比例，
> 不用任何「男性参考角」。只修真实畸变（肩点位移放大），不碰 walk/walkAlt、HSR/adv、foot-lock/micro-motion/animator。

---

## 0. TL;DR

1. 新增纯 ESM 库 + CLI：`scripts/unity-bake/lib/proportion-retarget.mjs`、`scripts/unity-bake/proportion-retarget.mjs`。
   逐帧：源 Zome canonical FK → torso 系归一化 → 目标期望关节位置 → 锁骨 aim + 两骨手臂 IK；只改
   `Shoulder/UpperArm/LowerArm`，`Hand`/手指 normalized 旋转原样保留。
2. **源姿态坐标系有坑**：不能把 three-vrm 的 VRM0 raw 回放（`rawRest + q` 再 `rotateY(π)`）当作源姿态；
   它会把不对称 clip 左右镜像（sit1 右手被抬到头上，而 Unity GT 源姿态是放下）。正确做法是
   canonical Zome rest（`VRMUtils.rotateVRM0` 后的 normalized rest）+ clip q **直接** FK。
   已用 Unity GT hips-local 验证：`sitWindow` 位置误差 0.43cm；`hideLeft/idle` 的 7cm 来自已知
   baked clip 肩部 fidelity（10–15°），不是本次 FK 错。渲染源参考时 clip 需做 `q'=(-x,y,-z,w)` 共轭
   （新增 `source-canonical-reference.mjs`），否则 preview 里的 Zome 是镜像版。
3. 主结果（absolute 模式，锁骨安全 cap 30°）：10 个 clip 全部 `validateClipData` ok；单位化误差 2.2e-16；
   loopSeam 基本不变（最大 `sit2 4.88→5.44°`）；idle/sit/window 的 socket lift **+3.8–4.4cm**，
   锁骨局部角 **27.9→12.0° / 26.0→6.8° / 30.7→22.1°**；手位误差 idle/windowLay8/sitWindow/hideLeft
   **0.8–1.0cm**；sit2/windowLay9/10/idle4 因臂长不足被 98% reach clamp，误差 4–8cm。
4. A-pose 闸门：idle upperArm 与 torso 水平夹角最大变化 **6.25°（体相对）**，**borderline FAIL**（闸门 ≤5°）；
   世界水平口径 9.3°。没有加硬 guard。
5. 已知病态：`sleep` 躺姿（锁骨 cap 1042/2110 side-frames；手误差 max 9.5cm；frame jump 9.3→16.8°）；
   absolute 模式肩宽误差 ~5cm（源/目标 rest 肩宽 1.79× vs torso 1.43×，固定锁骨长无法同时满足）；
   windowLay/hide 的「手贴脸」语义会因头/颈比例差停在胸/腰附近（需要 head-relative landmark 目标才能完全保留）。
6. 与 Unity GT on 男体：修正前 E_hand 0.2–2.4cm（管线忠实）；修正后 5–10cm（我们主动把手指向源比例位置，
   必然偏离 Unity 的 retarget），E_rot(上臂) 14–26°。这是本方案的预期代价，不是管线回归。

---

## 1. 输入 / 比例

| 项 | 源 Zome | 目标 men | 比例 |
|---|---:|---:|---:|
| hips→head | 33.20cm | 47.45cm | **1.429×** |
| 锁骨 Shoulder→UpperArm | 6.16cm | 12.34cm | **2.001×** |
| 臂 UpperArm→Hand | 36.43cm | 44.34cm | **1.217×** |
| rest 肩点半宽 | 8.89cm | 15.87cm | **1.786×** |

输入：
- 源 rest：`VRMUtils.rotateVRM0(Zome)` 后的 normalized humanoid rest 世界位置（或 `--source-rest` 读 Unity GT rest JSON，x 取反）。
- 目标 rest：`aventurine-tpose.vrm` 的 normalized rest（或 `--target-rest`）。
- clip：`assets/motions/mate/<clip>.json`（normalized rotations + 仅 Hips p）。
- 不依赖 Electron；`three`/`@pixiv/three-vrm` 是仓库已有依赖。

---

## 2. 算法与公式

### 2.1 源/目标 FK（canonical）

对每帧 normalized 旋转 `q_b`：

```text
D_b      = D_parent · q_b                      // world delta
p_b      = p_parent + D_parent · (rest_b − rest_parent)
```

目标/源缺 `upperChest` 时按 α=1 折叠：`q_chest' = q_chest · U`（子骨 world 朝向精确不变，与 §4.1 一致）。
本报告源侧 `q` **直接**作用在 canonical rest 上，不复刻 three-vrm VRM0 的 `rawRest + q + rotateY(π)` 路径
（那会镜像不对称 clip；见 §0.2）。

### 2.2 源 torso 系与归一化

```text
origin = hips
up     = normalize(head − hips)
left   = normalize( (leftShoulder − rightShoulder) − up·dot(...,up) )
forward= left × up
```

源关节归一化：`u = frameLocal(sourceFrame, p_src) / sourceTorsoLen`
（sourceTorsoLen = rest |head−hips| = 33.20cm）。
目标期望绝对位置：`p_exp = frameWorld(targetFrame, u · targetTorsoLen)`（targetTorsoLen=47.45cm）。
`Hips.p` 在相对 hips 的表达里抵消，输出原样保留。

### 2.3 锁骨（Shoulder）aim

设目标 rest 锁骨向量 `v_rest = targetRest[upperArm] − targetRest[shoulder]`，`L = |v_rest|`，
源 clip 的锁骨局部旋转 `R_src = q_shoulder`。我们实现三种 socket 期望：

| mode | 期望 socket | 说明 |
|---|---|---|
| `absolute`（任务 §3 字面） | `p_exp` 的绝对位置 | 源肩窝绝对位置 × torso 比例；会同时补偿源/目标 rest 肩高/肩宽差 |
| `chest-displacement`（推荐备选） | 目标 chest 系：`v_rest_tgt + (R_src − I)·v_rest_src × torsoScale` 的方向 | 只按 torso 比例重定向「锁骨旋转造成的位移」，保留目标自身 rest 肩宽 |
| `displacement`（诊断） | 目标 posed torso 系：`restLocal + (p_src − rest_src) × torsoScale` | 对 torso 系姿态敏感 |

锁骨求解（关键：局部角必须相对 **chest/upperChest** 解，不能对 world swing 直接取局部）：

```text
parent     = chest 或 upperChest（缺 upperChest 时 chest）
parentD    = D_parent
desiredDirW= normalize(expectedUpperArm − shoulderRoot)
desiredDirL= normalize(parentD⁻¹ · desiredDirW)
q_shoulder = quatFromUnitVectors(v_rest/L, desiredDirL)   // 最小 swing，无额外 twist
cap: 若 |q_shoulder| > maxShoulderLocalDeg（默认 30°），
     q_shoulder = slerp(I, q_shoulder, cap/|q_shoulder|)   // 安全 guard，不是男性参考角
D_shoulder = parentD · q_shoulder
socket     = shoulderRoot + (D_shoulder · v_rest)
```

> 早期实现曾用 `D_world = swing(v_rest, desiredDirW)` 再取 `parentD⁻¹·D_world`；躺姿/坐姿 chest 旋转 30–90° 时
> 会把 chest 旋转算进局部锁骨角，导致 `sitWindow` 0→30°、`sleep` 101°。已修正为上面的 chest-local 解，
> 修正后 `sitWindow` 0→0–11.5°、`sleep` 65→30°（仅 cap 帧）。这是本轮最重要的实现修正之一。

### 2.4 两骨手臂 IK

```text
l1 = |lowerArmRest − upperArmRest|, l2 = |handRest − lowerArmRest|
d0 = |expectedHand − socket|
dMax = (d0 > l1+l2) ? min(0.98·(l1+l2), dFromMinFlex(10°)) : dFromMinFlex(10°)
dMin = max(|l1−l2|·1.001, dFromMaxFlex(150°))
d    = clamp(d0, dMin, dMax)
axis = normalize(expectedHand − socket)
a    = (l1²−l2²+d²)/(2d), h = sqrt(l1²−a²)
pole = expectedElbow − socket，去掉 axis 分量；退化时回退 torso up/world 轴
elbow= socket + axis·a + normalize(pole_perp)·h
wrist= socket + axis·d
```

- 可达（`d0 ≤ reach`）时用精确目标；仅真正不可达才退 98% reach。
- 肘屈限制 [10°,150°]；`elbowFlexDegAfter` 在报告中。
- 手/手指 normalized 旋转不变。

### 2.5 手臂 world 旋转（保源 twist）

```text
u_src = normalize(sourceLowerArm − sourceUpperArm), f_src = normalize(sourceHand − sourceLowerArm)
u_tgt = normalize(elbow − socket),                  f_tgt = normalize(wrist − elbow)
D_ua  = swing(u_src → u_tgt) · D_ua_src        // world
D_la  = swing(f_src → f_tgt) · D_la_src
q_ua  = D_shoulder⁻¹ · D_ua
q_la  = D_ua⁻¹ · D_la
q_hand= clip 原值（不改）
```

因此 hand world orientation 只随前臂 swing 变化；`handWorldDeltaDeg` 报告该变化量。

### 2.6 输出与连续性

- 只替换 6 条轨道 `Left/Right{Shoulder,UpperArm,LowerArm}`；Hand/手指/UpperChest/legs/hips 原样。
- 每帧四元数归一化；逐骨符号连续化（相邻 dot ≥0）；loopSeam 用首末帧角差检查。
- 输出 clip 增加 `proportionRetarget` 元数据（mode/比例/参数），不改 `frames/fps/loop/Hips.p`。

---

## 3. 结果（absolute 主模式，`--max-shoulder-local 30`）

### 3.1 逐 clip 关键指标

| clip | 帧 | socket lift | 锁骨局部 before→after (src) | 手位误差 mean/max | 手位移 max | 上臂方向变化 | hand world 变化 | reach clamp | 肩 cap | A-pose 体/世界水平角变化 | loopSeam 前→后 | 单位化 err | 校验 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| sit1 | 95 | 4.4cm | 26.0→6.8° (26.0) | 4.4/7.8cm | 7.3cm | 16.8° | 9.0° | 95/190 | 0 | 8.6/9.1° | 1.89→1.93° | 2.2e-16 | ok |
| sit2 | 194 | 4.0–4.4cm | 27.5→8.5° (27.5) | 4.4/8.1cm | 7.7cm | 18.9° | 13.7° | 212/388 | 0 | 16.2/14.5° | 4.88→5.44° | 2.2e-16 | ok |
| windowLay8 | 72 | 4.1–4.4cm | 30.7→22.1° (30.7) | 0.9/1.1cm | 8.1cm | 20.0° | 14.5° | 0/144 | 0 | 7.2/6.6° | 1.33→1.61° | 2.2e-16 | ok |
| windowLay9 | 62 | 4.4cm | 27.8→20.1° (27.8) | 6.2/6.9cm | 5.5cm | 17.0° | 6.8° | 124/124 | 0 | 16.8/10.3° | 3.21→1.13° | 2.2e-16 | ok |
| windowLay10 | 90 | 3.9–4.6cm | 26.4→15.3° (26.4) | 6.6/6.9cm | 5.5cm | 16.8° | 6.1° | 180/180 | 0 | 12.2/12.3° | 2.69→1.15° | 2.2e-16 | ok |
| sitWindow | 599 | 2.4cm | 0.0→11.5° (0.0) | 0.8/0.9cm | 7.0cm | 14.8° | 5.6° | 0/1198 | 0 | 9.5/14.6° | 0.00→0.00° | 2.2e-16 | ok |
| sleep | 1055 | −5.2–4.5cm | 65.0→30.0° (65.0) | 1.2/9.5cm | 10.1cm | 34.6° | 31.7° | 221/2110 | **1042** | 26.1/33.8° | 0.13→0.16° | 2.2e-16 | ok |
| hideLeft | 240 | 3.3–3.9cm | 22.1→25.8° (22.1) | 0.8/0.9cm | 8.6cm | 21.5° | 10.7° | 0/480 | 0 | 15.2/21.3° | 0.41→0.58° | 2.2e-16 | ok |
| idle | 74 | 3.8–4.1cm | 27.9→12.0° (27.9) | 0.9/1.0cm | 7.8cm | 15.8° | 1.6° | 0/148 | 0 | **6.25/9.3°** | 1.83→1.87° | 2.2e-16 | ok |
| idle4 | 170 | 2.1–3.6cm | 18.8→30.0° (18.8) | 6.5/8.6cm | 5.6cm | 26.2° | 23.4° | 335/340 | 24 | 9.3/14.7° | 0.20→0.22° | 2.2e-16 | ok |

- `socket lift` = 修正后 upperArm 关节点在目标 torso 系里的抬升。
- 锁骨「after」为最大局部角；`cap` = 超过 30° 安全上限的 side-frames。
- 手位误差 = 修正后 Hand 关节 vs 源绝对映射期望；不可达时 98% clamp。
- A-pose 闸门只用 idle：**6.25°（体相对）/9.3°（世界）**，>5°，borderline FAIL（见 §5）。
- `sit2` 的 loopSeam +0.56° 仍在任务 +5° 容差内；其余不增/下降。
- 手-躯干轴距离：**idle 22.6–27.7cm**（R3 正常 22–28cm，A-pose 闸门通过）；windowLay9 30.9–42.1cm、
  sitWindow 34.9–35.8cm、hideLeft 24.1–40.1cm（体侧/体前伸展，>32cm 属 R3 的「过远」区，需视觉 A/B）。

### 3.2 与 Unity GT（hips-local）

| clip | 源 GT E_pos max | 源 GT E_rot mean/max | 男体 before E_hand | 男体 after E_hand | 男体 before E_rot(上臂) | 男体 after E_rot(上臂) |
|---|---:|---:|---:|---:|---:|---:|
| sitWindow | 0.43cm | 1.0/1.7° | 0.2cm | 6.9cm | 0.8° | 14.3° |
| sleep | 7.55cm | 13.6/20.7° | 2.4cm | 10.5cm | 3.7° | 26.4° |
| hideLeft | 6.95cm | 7.6/17.5° | 0.4cm | 8.3cm | 0.7° | 21.0° |
| idle | 7.71cm | 15.1/19.8° | 0.3cm | 7.9cm | 0.6° | 16.2° |
| 其余（无源 GT） | — | — | 0.2–1.8cm | 5.4–8.1cm | 0.7–3.7° | 16–26° |

- **源 GT E_rot 非 0 是已知 baked clip 与 Unity 源 avatar 的肩部 fidelity 差（10–15°）**，不是本次 FK 错；
  源 GT E_pos 才是几何 sanity check（干净 clip 如 sitWindow 0.43cm；肩部差的 clip 会把 7cm 传到手）。
- 男体 `before E_hand` 0.2–2.4cm 说明现有管线在男体上是忠实的；`after E_hand` 5–10cm 是本方案主动把手指向
  源比例位置造成的，不是管线回归。

### 3.3 chest-displacement 对照（recommended fallback）

| clip | socket lift | 锁骨 after (src) | 手位误差 mean/max | 肩宽/高误差 | A-pose 体水平 |
|---|---:|---:|---:|---:|---:|
| idle | 1.1–1.2cm | 19.4° (27.9) | 1.0/1.0cm | 0/0cm | 6.86° |
| sit1 | 0.9–1.4cm | 18.3° (26.0) | 2.7/4.3cm | 0/0cm | 8.94° |
| windowLay8 | 1.0–1.6cm | 21.5° (30.7) | 0.9/1.0cm | 0/0cm | 17.0° |
| sitWindow | 0cm | 0.0° (0.0) | 0.9/0.9cm | 0/0cm | 13.1° |
| sleep | −5.2–1.8cm | 30.0° (65.0), cap 123 | 1.4/11.1cm | 2.0/1.5cm | 35.7° |
| idle4 | −1.3–0.1cm | 12.6° (18.8) | 3.4/5.2cm | 0/0cm | 17.5° |

- 该模式保留目标 rest 肩宽、socket 与期望零误差，但只抬 1–1.6cm（idle/sit/window），对「严重溜肩」修正更保守。
- 若用户要的是「按锁骨位移比例修正、保留男体肩宽」→ 选 chest-displacement；若用户要的是「源绝对视觉高度」→ 选 absolute。
- 两种模式都保留；CLI `--socket-mode` 切换。

---

## 4. 渲染 A/B

- 3 联图（源 Zome canonical | 男体 before | 男体 after）：
  `tests/tmp/lead-proportion/evidence/<clip>-f000-ab.jpg`（10 个 clip）。
- absolute 变体：`tests/tmp/lead-proportion/evidence/`
- chest-displacement 变体（4 clip）：`tests/tmp/lead-proportion/evidence-chest-displacement/`
- 原始/修正 PNG + 4 帧接触表：
  - `tests/tmp/lead-proportion/render-before/`
  - `tests/tmp/lead-proportion/render-after-absolute/`
  - `tests/tmp/lead-proportion/render-source-zome/`
  - `tests/tmp/lead-proportion/render-after-chest-displacement/`
- 目视结论（供 Lead 复核）：idle 双手从「分开/一高一低」更接近源的双手中线；sit1 左手更接近脸，肩线抬升；
  windowLay8/9/10 的手相对脸偏低（头/颈比例差，见风险）；sleep 变化不明显但存在病态帧。

---

## 5. 风险与未决问题

1. **A-pose 闸门 borderline FAIL**：idle 6.25°（体相对）/9.3°（世界）>5°。上臂方向被手腕目标带动；
   若要硬过闸门，需要在 arms-down idle 上做「手腕目标向原手位 soft-blend」的 guard（会牺牲手位精度），
   或把闸门理解为「不是 A-pose 回归」而非「≤5°」。请 Lead 决定。
2. **sleep 躺姿病态**：锁骨 cap 1042/2110 side-frames；socket lift 有负值；手 max 9.5cm；frame jump 9.3→16.8°
   （chest-displacement 达 42.3°）。建议 sleep 单独 A/B 或先不切换；需要时加时域 twist/pole 平滑。
3. **absolute 肩宽误差 ~5cm**：源/目标 rest 肩宽 1.79× 而 torso 1.43×；固定 12.34cm 锁骨无法同时匹配
   源绝对肩高与肩宽。absolute 选择保高度/方向、牺牲宽度；chest-displacement 保宽度、只抬 1–1.6cm。
4. **手不可达/接触漂移**：arm 1.217× vs torso 1.429× → sit2/windowLay9/10/idle4 大量 98% clamp，
   手位误差 4–8cm；若手要贴膝/窗沿/胸，需要 landmark 目标（S4'）而不是纯 torso 比例。
5. **「手贴脸」可爱语义**：windowLay8/9/10/hideLeft 的源手在脸旁；torso-absolute 映射后男体头/颈更长，
   手会停在胸/腰附近。手/手指 normalized 旋转未变（手势保留），但位置相对脸变了。若要完全保留，
   需要 head-relative landmark 目标（本原型未做）。
6. **frame jump 放大**：sleep 9.33→16.76°、idle4 4.16→13.03°、sit2 4.47→9.55°；源本身已有 4–9° 快速帧。
   相邻 dot 连续、validator 不报错，但目视可能有「抖一下」。未加时域滤波。
7. **未做碰撞/穿模**：手-胸/手-脸/袖口/蒙皮拉伸未检查；手 world 朝向最大变化 31.7°（sleep）/14.5°（windowLay8）。
   手/手指 local 未改，wrist 补偿未做（按任务「可选，先报告」）。
8. **源 expected = baked clip 的视觉姿态**，不是 Unity GT on Zome（后者肩部 fidelity 10–15°）。若 Lead 要
   Unity-on-Zome 真值，需要用 GT 源或重烘；本原型的源 FK 已用 GT 位置做过 sanity check（sitWindow 0.43cm）。
9. **30° 锁骨 cap 是解剖安全 guard，不是风格目标**；absolute 下只有 sleep（1042 帧）和 idle4（24 帧）触发。
   `--max-shoulder-local 0` 可关闭（会看到 sleep 101° 的原始解，不建议）。
10. **未切换 manifest、未改产品运行时**；输出只在 tests/tmp。采纳前需要 Lead 跑 app 实机 A/B、脚/蒙皮/穿模回归。

---

## 6. 复现

```bash
# 主结果（absolute）
node scripts/unity-bake/proportion-retarget.mjs \
  --socket-mode absolute \
  --out tests/tmp/lead-proportion/clips-absolute \
  --metrics tests/tmp/lead-proportion/metrics-absolute.json \
  --summary tests/tmp/lead-proportion/summary-absolute.md

# 对照（chest-displacement）
node scripts/unity-bake/proportion-retarget.mjs \
  --socket-mode chest-displacement \
  --out tests/tmp/lead-proportion/clips-chest-displacement \
  --metrics tests/tmp/lead-proportion/metrics-chest-displacement.json \
  --summary tests/tmp/lead-proportion/summary-chest-displacement.md

# 源 canonical 渲染参考（Zome VRM0 必须做 q'=(-x,y,-z,w) 共轭，否则镜像）
node scripts/unity-bake/source-canonical-reference.mjs --clips sit1,sit2,windowLay8,windowLay9,windowLay10,sitWindow,sleep,hideLeft,idle,idle4 \
  --out tests/tmp/lead-proportion/clips-source-canonical
PREVIEW_MOTIONS_REL=tests/tmp/lead-proportion/clips-source-canonical \
  node scripts/unity-bake/preview-clips.mjs --vrm "refs/Mate-Engine/Assets/MATE ENGINE - Avatar/Zome.vrm" --yaw 0 \
  --clips sit1,sit2,windowLay8,windowLay9,windowLay10,sitWindow,sleep,hideLeft,idle,idle4 \
  --out tests/tmp/lead-proportion/render-source-zome --sheet

# 男体 before/after 渲染
PREVIEW_MOTIONS_REL=assets/motions/mate node scripts/unity-bake/preview-clips.mjs \
  --clips sit1,sit2,windowLay8,windowLay9,windowLay10,sitWindow,sleep,hideLeft,idle,idle4 \
  --out tests/tmp/lead-proportion/render-before --metrics tests/tmp/lead-proportion/metrics-render-before --sheet
PREVIEW_MOTIONS_REL=tests/tmp/lead-proportion/clips-absolute node scripts/unity-bake/preview-clips.mjs \
  --clips sit1,sit2,windowLay8,windowLay9,windowLay10,sitWindow,sleep,hideLeft,idle,idle4 \
  --out tests/tmp/lead-proportion/render-after-absolute --metrics tests/tmp/lead-proportion/metrics-render-after-absolute --sheet

# 3 联 A/B
node scripts/unity-bake/compose-proportion-ab.mjs

# 定向测试 + 类型检查（不要跑全量 pnpm test）
pnpm vitest run tests/unity-bake-proportion-retarget.test.ts
pnpm typecheck
```

---

## 7. 文件清单

新增（均未 commit）：
- `scripts/unity-bake/lib/proportion-retarget.mjs` — 纯 ESM 数学库（FK/upperChest fold/torso 系/aim/两骨 IK/clip 级）。
- `scripts/unity-bake/proportion-retarget.mjs` — CLI bake + 指标 + Unity GT hips-local 对比 + Markdown 汇总。
- `scripts/unity-bake/source-canonical-reference.mjs` — 生成 Zome canonical 源参考 clip（VRM0 共轭）。
- `scripts/unity-bake/compose-proportion-ab.mjs` — 3 联 A/B 对照图。
- `tests/unity-bake-proportion-retarget.test.ts` — 17 用例（纯函数 fixture + 真实 rest `skipIf` 集成）。
- `docs/research/proportion-retarget-prototype-2026-11-11.md` — 本报告。

gitignore 输出（`tests/tmp/lead-proportion/**`）：
- `clips-absolute/`、`clips-chest-displacement/`、`clips-source-canonical/`
- `metrics-absolute.json`、`summary-absolute.md`、`metrics-chest-displacement.json`、`summary-chest-displacement.md`
- `render-before/`、`render-after-absolute/`、`render-source-zome/`、`render-after-chest-displacement/` 及 logs
- `evidence/`、`evidence-chest-displacement/` 3 联 JPG

未改：`clip-player.ts`、`animator.ts`、`foot-lock.ts`、`micro-motion.ts`、`app-manifest.json`、`assets/motions/**`、
`assets/vrm/**`、HSR/adv、walk/walkAlt。未跑全量 `pnpm test`。
