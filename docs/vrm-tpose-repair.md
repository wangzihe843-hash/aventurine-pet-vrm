# W1.5-Tpose：砂金 VRM 的 T-pose 重制与 clip 坐标约定修复

> 日期：2026-11-08 · 状态：**已修复并验证**（模型 + 数据约定 + GT 复验）
> 触发：用户实机验收发现「手/臂姿势不对、穿模严重，只有 drag 这类手不碰身体的动作正常；腿看起来还好」。
> 相关：`docs/wave15-report.md`（U2/U3 总报告）、`docs/vrm-contract.md`（冻结契约）

---

## 1. 根因（两条，叠加）

### 1.1 砂金旧 VRM 不是 VRM 规范要求的 T-pose（主因）

- 旧资产 `aventurine-waveflair.vrm`（含 legfix 版）的 rest 姿势是 **A-pose**：解析 GLB 得 humanoid 链
  `左腕 → 左ひじ` 方向 ≈ `(-0.771, -0.637, ...)`，即手臂**下斜 39.6°**；Zome/官方角色均为
  标准 T-pose（0°）。
- [VRM T-pose 规范](https://github.com/vrm-c/vrm-specification/blob/master/specification/VRMC_vrm-1.0/tpose.md)
  要求：手臂沿 X 轴水平（定义 1.4）、**手心朝 -Y**（1.6）、四指沿 X 且指甲朝 +Y（1.7）、
  拇指在 X 与 +Z 之间 45°（1.8）；[vrm.dev humanoid 文档](https://vrm.dev/en/univrm/humanoid/humanoid_overview/)
  把 T-pose 列为“接收姿势数据的前提”。
- 播放 normalized 动画 = 每根骨按「相对 T-pose」的旋转叠加；模型 rest 不是 T-pose 时，
  整条手臂会带一个**常量 39.6° 偏转**。后果：手靠近身体的动作（idle 交叉手/walk/happy 等）
  手臂压进躯干/袖子 → 穿模、姿势明显不对；drag 等手伸出去的动作不碰身体 → 看起来“没问题”。
- **腿为什么看着还行**：A-pose 与 T-pose 的差异主要在手臂（肩/上臂抬起），腿在两种姿势里
  都竖直，常量偏转≈0，所以腿正常——与用户观察一致。

### 1.2 旧 clip 数据的坐标反射轴与目标模型朝向不匹配（被 1.1 掩盖）

- 采样骨架在 Unity（左手系；角色面向 +Z 时**左手 = -X**）里搭建，之前用 `convert-clips --axis z`
  转 glTF（反射 Z）。这套数据适合**面向 -Z / 左手 -X** 的旧资产（旧戏浪、Zome/VRM0 风格）。
- 标准 **VRM 1.0 规范模型面向 +Z、左手 = +X**（右手系）。同一份 axis-z 数据直接用于
  标准 VRM1 时左右会镜像 → 手臂朝错误方向运动（实测：新 T-pose 模型上 idle 双手抬到头顶）。
- 做过对照实验：
  - 旧 legfix 资产（面向 -Z/A-pose）+ `--axis z` → 视觉“自然但姿势带 A-pose 常量差”；
  - 新 T-pose 资产（面向 +Z/规范 T-pose）+ `--axis z` → 手臂镜像（抬到头顶）；
  - 新 T-pose 资产 + `--axis x` → **idle 交叉手、walk 摆臂、happy 手势均正确**（见 §3）。

结论：**模型修成规范 T-pose 后，clip 数据也必须按模型朝向用 `--axis x` 重新烘焙**。

---

## 2. 修复内容

### 2.1 模型：PMX → 规范 T-pose VRM 1.0（VRMify）

- 源：`assets/model/星穹铁道—砂金·戏浪.pmx`（PMX，A-pose）
- 工具：[VRMify](https://github.com/JiGuang283/VRMify)（纯 Python，PMX→VRM；默认把 A-pose 手臂抬成
  VRM T-pose：手臂水平/掌心向下/四指伸直/拇指 45°；**合并 足D 等付与骨到所跟随骨+权重**；
  去掉无用控制骨，层级整理为 Root > Hips；MMD 物理转 SpringBone）
- 命令（复跑）：

```bash
# 一次性准备（仓库外，仅工具）
git clone --depth 1 --filter=blob:none --sparse https://github.com/JiGuang283/VRMify.git /tmp/vrmify
cd /tmp/vrmify && git sparse-checkout add formats

cd /Volumes/4TB外置盘/deepseek-harness/aventurine-pet-vrm
python3 /tmp/vrmify/convert/pmx2vrm.py \
  "assets/model/星穹铁道—砂金·戏浪.pmx" \
  -o "assets/vrm/aventurine-tpose.vrm" \
  --spec 1.0 --scale 0.0799777 \
  --title "砂金·戏浪" --author "miHoYo / 用户本地转换"
```

- `--scale 0.0799777`：按 PMX 原始高度 21.681 单位换算，使成品 bbox 高 **1.734 m**（与旧资产一致，
  app 尺寸/布局不变；VRMify 默认 auto 会归一到 1.6 m）。
- 产物元数据：VRM 1.0、54 humanoid 骨（含 30 手指 + toes）、**SpringBone 50 链 / 175 collider**、
  95 表情（含 blink/happy/angry/surprised 等 preset + 78 custom）、39 材质、24.75 MB。
- 保留旧文件用于回滚：`aventurine-waveflair.vrm`（W0-5 修复版）、`aventurine-waveflair-legfix.vrm`
  （W1.5-legfix 腿修复版）。

### 2.2 clip 数据：按目标模型朝向重新烘焙

- `scripts/unity-bake/run-export.sh` 的转换改为 **`--axis x`**（反射 X），并在脚本里写清两者约定：
  - `--axis x`：标准 VRM 1.0（面向 +Z、左手 +X）→ 当前目标；
  - `--axis z`：旧资产/VRM0 风格（面向 -Z、左手 -X）→ canary、Zome、旧 waveflair。
- 重新转换 29 个 clip：`validate-clips` 仍 **29 PASS / 0 WARN / 0 FAIL**；manifest 重建 PASS。
- `src/shared/vrm-manifest.json`：aventurine 条目指向 `vrm/aventurine-tpose.vrm`，
  `yawOffsetDeg: 0`（规范面向 +Z）、`springChains: 50`、`heightMeters: 1.73`，notes 记录来源/回滚/约定。

---

## 3. 验证

### 3.1 Unity·UniVRM ground truth（同模型逐帧）

- 方法：Unity 6000.2.6f2 + Mate-Engine 同款 UniVRM 0.128.3 导入新 VRM，播原始 `.anim` 采样；
  与 three-vrm 回放 axis-x 版 clip 逐帧对比（ΔW = W_pose·W_rest⁻¹，按 body frame；关节相对旋转）。
- 结果（11 clip / 3,657 帧）：

| 指标 | 旧 legfix VRM（A-pose） | **新 T-pose VRM** |
|---|---|---|
| 同模型 ΔW mean（全部骨） | **102.47°**（A-pose 常量差伪影） | **3.44°** |
| Hips ΔW mean | 111.2° | 1.8° |
| 手臂（UpperArm/LowerArm/Hand）ΔW mean | 105–143° | **4.2° / 4.2° / 4.2°** |
| 手臂 normalized 局部旋转 mean | 40–60°（错） | **0.0°** |
| 腿（UpperLeg/Foot）ΔW mean | 65–99° | 1.9° / 2.8° |

→ 新模型 + axis-x 数据与 Unity/Mate-Engine 在同模型上的动作语义一致（此前 A-pose 资产连 Unity
GT 自己都会出现「走路双手过头」伪影，不能作为真值）。

### 3.2 视觉证据（three-vrm 渲染）

- `tests/tmp/wave15/final-tpose/`：29 clip 接触表（0/20/40/60/80% 帧）+ 首帧总览 + 单帧 PNG。
- 与旧模型对比（`work/model-fix/hands-compare.jpg`）：
  - idle：手不再插进胸口/袖子，交叉手位置与 Unity GT/Zome 参考一致；
  - walk：手臂有正常前后摆幅（旧模型几乎贴死在身侧）；
  - happy：手臂自然抬起做手势；
  - drag：保持正常。
- 自然度 metrics（新模型 29 clip）：**PASS 23 / WARN 6 / FAIL 0**（旧 legfix：PASS 22/WARN 5/FAIL 2）。
  WARN 均为动作意图/摆位（hideOnce 侧移 0.414m、idle2 侧移 0.303m、idle4/introLoop/introEnd/introStart
  膝屈或脚部跳变），无结构/穿地 FAIL。

---

## 4. 复跑与回滚

```bash
# 模型（需要 /tmp/vrmify；见 §2.1）
python3 /tmp/vrmify/convert/pmx2vrm.py "assets/model/星穹铁道—砂金·戏浪.pmx" \
  -o "assets/vrm/aventurine-tpose.vrm" --spec 1.0 --scale 0.0799777

# clip 重烘焙 + 转换（run-export.sh 已固定 --axis x）
bash scripts/unity-bake/run-export.sh

# 校验
node scripts/unity-bake/validate-clips.mjs
node scripts/unity-bake/build-motion-manifest.mjs --check

# 预览（新模型 yaw 由 manifest 自动 = 0）
node scripts/unity-bake/preview-clips.mjs --all \
  --vrm assets/vrm/aventurine-tpose.vrm \
  --out tests/tmp/wave15/final-tpose \
  --metrics tests/tmp/wave15/final-tpose-metrics --sheet
```

回滚：把 `src/shared/vrm-manifest.json` 的 aventurine `file` 改回 `vrm/aventurine-waveflair-legfix.vrm`，
并把 `run-export.sh` 的 `--axis x` 改回 `--axis z`，重跑导出即可（旧文件都还在）。

---

## 5. 已知限制 / 后续

1. **VRM0 / 面向 -Z 的旧模型（canary）与 axis-x 数据不兼容**：VRM0 的规范/朝向是 -Z，
   同一份新数据在它上面会左右镜像（实测 canary idle 手臂朝向不对）。处理：V5 clip player
   按模型 `specVersion`/朝向做 180° 约定换算（把 normalized 旋转做绕 Y 共轭），或为 VRM0
   单独生成 axis-z 数据；当前 app 目标是砂金 VRM1，不影响主线。
2. **HSR 动作 lane**：其 14 条 clip 的原型是针对旧 legfix VRM 的节点/rest 就绪数据，
   模型切到 aventurine-tpose.vrm 后需按新 VRM 重新 retarget（节点名/层级/权重有变化，
   raw 次级骨通道尤其需要重跑）。已在交付说明里标注，需另一会话刷新。
3. **宽袖 + 交叉手**：即使姿势规范，宽袖模型做双手抱胸仍可能轻微穿模（VRM 社区共识：
   衣装决定部分姿势做不出来；见 zenn 文章）。若用户实机仍不满意，可改选不交叉手的 idle
   变体（idle2–idle7）或做 arm-clearance 后处理。
4. **外观/材质重转差异**：新 VRM 由 PMX 重新转换，MToon/描边/半透明与旧资产可能略有差异；
   旧资产保留可回滚。表情有 95 个（含 78 custom），V6 接线时按 preset 映射即可。

---

## 6. 初始姿态微调（introStart 起始站立段，2026-11-08）

**反馈**：「初始姿态双手距离身体略远、接近 A-pose；注意别调成穿模」。
**定位**：指 `introStart`（宠物出现动画）第 0 帧的站姿——测量该帧上臂/前臂与竖直方向夹角 13.1°/13.5°、
手距身体中线 0.149×身高；虽然这已是 Mate-Engine 源动画的原始姿态，但在宽袖/大衣上视觉偏外。

**做法**（可复跑、可调）：

- 新增 `scripts/unity-bake/tune-pose.json`：对 `introStart` 第 0–8 帧，给左右上臂叠加
  **内收 5°（绕模型 +Z，左负右正）+ 略前摆 5°（绕 +X 负角）**，第 8 帧线性淡出到 0，
  不影响第 10 帧开始的蹲伏/躺下。
- 新增 `scripts/unity-bake/tune-pose.mjs` + `lib/pose-tune.mjs`：把偏移写进 normalized 旋转
  （`N' = slerp(I,E,w)·N`），CLI 带配置指纹幂等标记（同配置重跑 = 跳过；换配置要求先重跑
  convert，避免偏移叠加）。`run-export.sh` 已在 convert 之后自动调用。
- 效果（同帧实测）：上臂/前臂相对竖直夹角 13.1°/13.5° → **8.0°/8.2°**，手距身体中线
  0.149→**0.128**×身高（约 −3.7cm），手略前移；多角度渲染检查袖口/大衣无穿插。
- **不是重定向错误**：源动画该帧本来就是 A-pose 偏外的站姿；这是按产品观感做的显式微调，
  Unity GT 对比中 `introStart` 前 9 帧会因此偏离源数据（其余 28 clip 与后续帧不受影响）。
- 调整方式：改 `pose-tune.json` 的 `deg`/`frames` 后重跑 `run-export.sh`（或
  `node scripts/unity-bake/convert-clips.mjs ... --axis x` 后 `node scripts/unity-bake/tune-pose.mjs`）。
  若后续觉得还要更收/更松，只改这一份配置即可；注意别超过约 8–10°（宽袖会贴到大衣）。
