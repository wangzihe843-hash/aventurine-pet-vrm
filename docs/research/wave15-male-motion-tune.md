# Wave 1.5 男性适配 · 女体动作微调可行性调查报告

> 日期：2026-11-09 ｜ 范围：Mate-Engine 女体动作（Wave 1.5）套在男性角色「砂金·戏浪」上「诡异/女性化」的问题，
> 调查**不重做全套男性动作、只微调女体动作**能把观感救到什么程度。
> 方法：① 本地数据/指标实测（`tests/tmp/wave15/final-tpose-metrics`、`tests/tmp/husbando/**`）；② 本地原型（female walk 男性化探针）；
> ③ 网络调研（Unity/Unreal 官方文档、B站/模之屋/VRCD/知乎/CSDN、GitHub、SIGGRAPH/ICCV/arXiv 论文）。
> 证据图/脚本在 `work/wave15-male-adapt/`、`work/proto-motions/`（私有，模型渲染禁止再分发）。
>
> **一句话结论：可行，但只能救“比例/接触/姿态基座”这一层（约 60–80% 的“诡异感”），救不了“动作语汇/表演意图”这一层。**
> 对本项目最划算的路线是：**男角色优先用男性动作源（HSR 官方 / Husbando）+ 对无法替换的女体 clip 做“幅度阻尼 + 姿态偏移 + IK 接触修正”**，
> 而不是指望一套全局参数把所有女体动作都变成男性动作。

---

## 0. TL;DR

| 问题类型 | 例子 | 微调能救吗 | 推荐手段 |
|---|---|---|---|
| 比例/几何 | 脚滑/悬空、膝盖内扣、手够不到、穿模、肩宽比例 | ✅ 能救 60–90% | 重定向基线修正 + 局部 FK offset + 脚 IK/接触修正 |
| 幅度/姿态基座 | 髋部左右摆过大、头部横移、含胸、脚距太窄、摆臂小 | ✅ 能救 50–80% | 常量 offset + 幅度缩放（本报告原型：髋摆 −50%、头摆 −60%、脚距 10.1→12.7cm） |
| 节奏/速度 | 女 idle 比原版快 2.5×、动作碎 | ✅ 基本能救 | per-clip timeScale、重采样 |
| 动作语汇 | 双手抬在胸前、掩口/抚脸、内八小碎步、塌腰翘臀、头颈侧倾 | ❌ 修不干净（最多压到 60–70%） | 换男体动作源 / 逐段重 K；全局 offset 会得到“一个做女性动作的男角色” |
| 发力质感 | female mocap 的弹性、follow-through 相位 | ❌ 基本救不了 | 重做/风格迁移研究 |

**给本项目的最简结论**：
- idle / walk / drag / 交互反应这些**有男性源**（HSR 官方、Mate-Engine Husbando）的槽位，直接用男性源，微调只做“接地 + 幅度”兜底；
- sit / sleep / hide / pose 这些**没有男性源**的女体 clip，做“幅度阻尼 + 脚 IK + 局部 offset”后观感会明显正常，但不要期待它们变成“砂金本人的动作”。

---

## 1. 现状：到底哪里“诡异”？（本地实测）

先把“诡异感”拆成可测量的四层，全部基于同一 VRM（`assets/vrm/aventurine-tpose.vrm`，1.734m）与同一渲染管线（`scripts/unity-bake/preview-clips.mjs`）。

### 1.1 风格指标：女走 vs HSR 官方男走

| 指标 | mate walk（女体） | adv-walk（HSR 官方男体） | 差异 |
|---|---:|---:|---|
| 髋部横向漂移 `hipsLateralDrift` | **5.27 cm** | 0.00 cm | 女体明显左右摆胯 |
| 头部横向摆幅 | **6.17 cm** | 1.20 cm | 女体头随胯摆 |
| 双脚平均间距 | **10.1 cm** | 12.7 cm | 女体站距偏窄 |
| 摆臂前后幅度（手 z-span） | 0.23 m | 0.31–0.36 m | 女体摆臂偏小 |
| 膝屈最大值 | 68.4° | 62.3° | 接近 |
| 髋部上下起伏 | 3.0 cm | 3.9 cm | 男体步态弹跳更大 |

数据来源：`tests/tmp/wave15/final-tpose-metrics/walk.metrics.json`、`tests/tmp/husbando/metrics-adv/walk.metrics.json`。
结论：**女体走路的“女性化”主要不在腿部关节角度，而在“胯/头左右摆 + 站距窄 + 摆臂小”这三个可量化通道**——这正好是全局幅度微调能救的部分。

### 1.2 骨骼比例差异（为什么旋转重定向会“看起来不对”）

| 项 | Wave 1.5 烘焙用合成骨架 | Aventurine 目标模型 | 差值 |
|---|---:|---:|---:|
| hips 高度 | 1.000 m | 1.066 m | **+6.6%** |
| 腿根（upperLeg）到脚 | 0.900 m | 0.881 m | −2.1% |
| hips → 腿根间隙 | 0.020 m | 0.088 m | **+6.8 cm**（髋骨语义不同） |
| 上臂+前臂 | 0.530 m | 0.443 m | **−16.3%**（手臂明显偏短） |
| 双 upperArm 间距（肩宽） | 0.340 m | 0.317 m | −6.6% |
| head 骨高度 | 1.580 m | 1.539 m | −4.1 cm |

数据来源：`scripts/unity-bake/Editor/ClipExporter.cs`（合成骨架定义）+ 目标 VRM GLB 节点层级实测（归一化 rest 世界坐标）。
结论：
- **手臂短 16%** 是所有“手放胸前/掩口/手够不到”类姿势在男角色上违和的几何根源之一；
- **髋骨语义差 6.8cm**（MMD `下半身` 映射到 VRM hips 的层级差异）会放大脚部接触误差，是“走起来脚浮/滑”的隐性因素之一；
- VRM 规范的 hips 平移缩放只用 **hips 高度比**（本模型 1.066）([VRMA 规范: how_to_transform_human_pose](https://github.com/vrm-c/vrm-specification/blob/master/specification/VRMC_vrm_animation-1.0/how_to_transform_human_pose.md)）；
  它无法同时补偿肢体长度差，所以接触点一定需要 IK/贴地后处理。

### 1.3 接触/贴地：Wave 1.5 没有脚部 IK

- preview 原始姿态下，**mate walk 最低脚趾仍离地 +2.15cm**；HUS 男性 idle 系列普遍浮空 **1.2–4.4cm**（见 `tests/tmp/husbando/metrics-av`）。
- app 已有 `clip-player` 的 per-clip pose grounding（每 clip 常量、≤16 帧采样）+ `foot-lock.ts` 接触期 IK，可缓解大部分悬空；
  但 `CONTACT_EPSILON_M=0.02` 对“浮 2cm 以上”的 clip 处于临界，且逐帧接触并不精确。
- HSR 官方动作路线在数据侧就做了逐帧脚部 grounding（残差 0.4–2.2cm，见 `docs/wave15-report.md` §5），这是 HSR 动作看起来更“落地”的原因之一。

### 1.4 节奏/动作集来源（背景，报告不展开）

- Mate-Engine 原版 controller 每个 clip 有独立 `timeScale`：女性 `PET_IDLE` = 0.4×、男 Husbando idle = 0.65×、dance 0.6–1.25×；
  Wave 1.5 烘焙时统一按 1.0× 播放 → 部分女 idle 比原版**快 2.5×**，会放大“碎/急/轻浮”的观感。
- 原版 2.4.0 起提供 **Husbando 男性动作集**（仅 idle/drag/dance），其余（walk/sit/sleep/hide/交互）没有男性版本；所以“女体动作微调”最终只对**没有男性替代的槽位**有意义。

---

## 2. 微调到底能救什么、救不了什么

### 2.1 能救（有确定解的几何/幅度问题，ROI 高）

1. **脚滑/悬空/站姿内八**：脚 IK + 接触判定 + 膝盖 hint 朝外 + hips 高度补偿；
2. **髋摆/头摆过大**：对 Hips 的 yaw/roll、Spine/Chest 侧弯、Head 倾斜做**幅度缩放**（本报告原型实测 −50%~−60%）；
3. **站距/摆臂**：upperLeg 微外旋 1–2°（4° 会过度，实测脚距会到 24cm）、摆臂前后 ×1.1–1.3；
4. **含胸/塌腰**：Chest 后伸 +2–4°、Hips 前倾少量 offset；
5. **节奏/速度**：按原版 timeScale 重设或重采样；
6. **手臂长度/肩宽造成的够不到**：两骨 IK 目标修正 + 局部 FK offset（手部接触类动作可救“不穿模”，但救不了“手势意图”）。

### 2.2 救不了/代价高（语义/表演意图问题）

- **双手抬在胸前、掩口、抚脸、拨发、兰花指、内八碎步、塌腰翘臀、头颈侧倾**——这些是关键帧意图，不是比例误差；
  全局常量 offset 会把所有帧一起推歪，结果常见是“一个做女性动作的男角色”，比原来更怪；
- **发力/节奏质感**（female mocap 的弹性、follow-through 相位）——放慢/缩放改不了；
- **手部精细姿态/手指**——收益小、易僵；表情/物理另属表情层与 SpringBone 范畴。

> 业界/官方文档里的同款结论：
> Unity 的 humanoid 重定向在肌肉空间做**旋转映射**，对比例不同只能做到近似（[Unity Retarget Humanoid animations](https://docs.unity3d.com/6000.1/Documentation/Manual/Retargeting.html)、[Muscle & Settings](https://docs.unity.com/en-us/engine/6000.0/manual/animation-section/animation-mecanim/avatar-creationand-setup/muscle-definitions)）；
> Unreal 的 IK Retargeter 专门提供 Retarget Pose offset、Speed Planting 等“对不同体型做微调”的工具
> （[IK Rig Retargeting](https://dev.epicgames.com/documentation/en-us/unreal-engine/ik-rig-animation-retargeting-in-unreal-engine)、
> [Fix Foot Sliding / Speed Planting](https://dev.epicgames.com/documentation/en-us/unreal-engine/fix-foot-sliding-with-ik-retargeter-in-unreal-engine)、
> [Retargeting Bipeds（含 Embellishing Motion 幅度微调）](https://dev.epicgames.com/documentation/unreal-engine/retargeting-bipeds-with-ik-rig-in-unreal-engine)），
> 但没有“把女性表演意图转成男性表演意图”的现成功能。

---

## 3. 七条可落地的技术路线（按 ROI 排序）

> 术语：FK offset = 在已有动作上叠加固定的骨骼局部旋转/位移；Additive layer = 引擎里的附加修正动画层；IK = 反向动力学修正接触点。

### R1｜重定向基线 + 逐肌肉限位（0.5 天，先做）

- 在男角色 Avatar 的 **Muscle & Settings** 里逐肌肉收窄/偏移限位：hips 的 yaw/roll、spine 侧弯、head tilt；对 Chest/UpperChest/Neck/双 UpperLeg/双 Shoulder 打开 Translate DoF。
- 原理：同一个 humanoid clip 的 muscle 值在不同 Avatar 上展开成不同世界角度；改限位=不改动画数据也能改观感（全局生效，无法按 clip 区分）。
- 参考：[Unity Muscle & Settings 中文](https://docs.unity3d.com/cn/6000.0/Manual/MuscleDefinitions.html)、[Avatar Mapping](https://docs.unity3d.com/cn/6000.0/Manual/class-Avatar.html)、[Unity Humanoid Avatar](https://docs.unity.com/en-us/engine/6000.0/manual/animation-section/animation-mecanim/avatar-creationand-setup)。

### R2｜全局 per-bone FK 旋转 offset（主力，2–5 天）

- 对 hips / spine / chest / shoulder.L/R / upperArm / forearm / hand 各加**常量四元数偏置**，典型男化参数：
  - Hips：yaw/roll 幅度 ×0.5–0.7、横向平移 ×0.5；
  - Spine/Chest：侧摆 ×0.5–0.7、Chest 后伸 +2–4°；
  - Shoulder：下沉/后展 1–2°；UpperArm：外旋/外张 5–10°（避免手臂贴胸）；
  - Head/Neck：侧倾 ×0.4；Forearm/Hand：收腕、手指半握。
- Unity 入口：`HumanPoseHandler.GetHumanPose/SetHumanPose`（运行时叠加修复）([docs](https://docs.unity3d.com/6000.1/Documentation/ScriptReference/HumanPoseHandler.html))；
  three-vrm 入口：`humanoid.getNormalizedPose()/setNormalizedPose()`（验证过的 normalized 空间，比例无关，见 [VRMHumanoid API](https://pixiv.github.io/three-vrm/docs/classes/three-vrm-core.VRMHumanoid.html)、[官方 humanoid 示例](https://raw.githubusercontent.com/pixiv/three-vrm/dev/packages/three-vrm-core/examples/humanoid.html)）；
- Unreal 对应：IK Retargeter 的 **Retarget Pose per-bone rotation offset delta**（root 才支持平移），可用 Retarget Pose Blend 滑杆调，Python 可批量写（[Python IK Retargeter](https://dev.epicgames.com/documentation/en-us/unreal-engine/using-python-to-create-and-edit-ik-retargeter-assets-in-unreal-engine)）。
- GitHub 可直接借：`pixiv/three-vrm` 的 `VRMHumanoid.ts`、`saori-eth/vrm-mixamo-retargeter`（逐骨映射 + 比例缩放）。

### R3｜Additive 修正层 + AvatarMask（3–5 天，可与 R2 叠加）

- Unity 建 additive 层（髋-躯干 / 肩臂 / 头颈三层，AvatarMask 按部位），base 层正常播女体动作，上层叠“男化修正”clip，权重可调、可只在 idle 时压肩。
- 参考：[Animation Layers](https://docs.unity3d.com/6000.1/Documentation/Manual/AnimationLayers.html)、[Apply Additive（团结引擎）](https://docs.unity.cn/cn/tuanjiemanual/Manual/AnimGraphAnimationNodeBlendApplyAdditive.html)。
- 注意：Unity 的 **Bidirectional Motion Transfer 明确不支持 Humanoid**（[官方限制](https://docs.unity3d.com/Packages/com.unity.animation.rigging@1.4/manual/BidirectionalMotionTransfer.html)），
  所以“用 Animation Rigging 修完 bake 回 humanoid clip”不通，必须走 HumanPoseHandler 自采样或 Unreal/Blender 离线管道。

### R4｜脚 IK / 接触后处理（2–4 天，是“看得下去”的前提）

- 两骨 IK 锁脚 + 接触帧 foot pinning + 髋高补偿 + 膝盖 hint 朝外。
- Unity：`OnAnimatorIK` / `TwoBoneIKConstraint`（[IK 手册](https://docs.unity3d.com/6000.1/Documentation/Manual/InverseKinematics.html)、[Animation Rigging](https://docs.unity3d.com/Packages/com.unity.animation.rigging@1.4/manual/index.html)、[TwoBoneIKConstraint](https://docs.unity3d.com/Packages/com.unity.animation.rigging@1.4/api/UnityEngine.Animations.Rigging.TwoBoneIKConstraint.html)）；
  我们项目已有 `src/renderer/src/vrm/foot-lock.ts` 可扩展（当前接触容差 2cm / 只在接地状态启用）。
- Unreal：FBIK + Speed Planting（先提取脚速曲线，再按阈值钉脚）+ 腿骨 Preferred Angles（治膝盖内扣）。
- 业内/教程：MMD 足 IK（[B站教程 BV1FdNPeSELN](https://www.bilibili.com/video/BV1FdNPeSELN/)）、iClone 修脚滑（[BV1icbMejE3J](https://www.bilibili.com/video/BV1icbMejE3J/)）、Unity 工程参考 [NinjaFootIkRig](https://github.com/studentutu/NinjaFootIkRig)。

### R5｜离线批量 bake 修正（1–2 周，一次性投入、运行时零成本）

- 把 R2/R6 的参数按帧写进 clip JSON（我们的 `assets/motions/{mate,hsr,adv}/*.json` 已经是 normalized 局部旋转 + hips 平移，正好是修正层的最小数据面）。
- 工具参考：Unreal **Animation Modifier**（Blueprint 批量改 Sequence，[docs](https://dev.epicgames.com/documentation/en-us/unreal-engine/animation-modifiers-in-unreal-engine)）；
  Blender **Retarget 扩展的 AnimOffset / Apply Scale**（[extensions.blender.org](https://extensions.blender.org/add-ons/retarget/)）；
  中文跨骨架复制插件 [blender_BoneAnimCopy](https://github.com/mayloglog/blender_BoneAnimCopy)；VRM 动画编辑 [vrma-lab](https://github.com/YuBan834/vrma-lab)。
- 约束：VRMA/我们的 clip 格式合法通道只有“骨骼旋转 + hips 平移”（[VRMC_vrm_animation-1.0](https://github.com/vrm-c/vrm-specification/blob/master/specification/VRMC_vrm_animation-1.0/README.md)），所以任何修正在数据层都写这两个通道即可。

### R6｜节奏/幅度时间域修整（0.5–1 天）

- 按原项目 timeScale 重设（本仓库数据已支持 per-clip `timeScale`），只做整体 speed 0.9–0.95 与 hips 幅度衰减，别轻易动脊柱以上幅度。
- Unreal 官方“Embellishing Motion”：Retarget Root 的 Scale Horizontal/Vertical + Translation Offset Z 直接改弹跳
  （[Retargeting Bipeds with IK Rig](https://dev.epicgames.com/documentation/unreal-engine/retargeting-bipeds-with-ik-rig-in-unreal-engine)）；
  Unity/团结引擎的 Stride Warping 可参考（[StrideWarping 文档](https://docs.unity.cn/cn/tuanjiemanual/Manual/AnimGraphAnimationNodeStrideWarping.html)、[FootPlacement](https://docs.unity.cn/cn/tuanjiemanual/Manual/AnimGraphAnimationNodeFootPlacement.html)）。
- 风险：改步频会破坏根运动/脚锁一致性，必须与 R4 同调。

### R7｜神经 retarget / motion style transfer（研究向，1–3 月 + GPU）

- 比例/骨架差异：Skeleton-Aware Networks（[SIGGRAPH/TOG 2020, arXiv:2005.05732](https://arxiv.org/abs/2005.05732)）；
- 接触保持：Contact-Aware Retargeting（[ICCV 2021, arXiv:2109.07431](https://arxiv.org/abs/2109.07431)）；
- 去性别/去风格：Unpaired Motion Style Transfer（[SIGGRAPH 2020, arXiv:2005.05751](https://arxiv.org/abs/2005.05751)，代码 [DeepMotionEditing](https://github.com/DeepMotionEditing/deep-motion-editing)）、D-LORD（[IEEE TSMC 2024, arXiv:2412.04097](https://arxiv.org/abs/2412.04097)）；
- 语义保持：Semantics-aware Motion Retargeting（[CVPR 2024, arXiv:2312.01964](https://arxiv.org/abs/2312.01964)）。
- 现实评估：论文证明“在已有动作上做骨骼级风格修正”可行，但**没有现成的“性别风格”checkpoint**；需要自备男/女同内容动作对训练，短期 ROI 低，不建议作为第一步。

---

## 4. 本地原型验证：female walk 男性化（只改幅度，不重 K）

**做法**（脚本：`work/proto-motions/` 一次性探针，未提交）：对 mate 女走 clip 做三件事——
① Hips 平移横向 ×0.5；② Hips 旋转幅度 ×0.72；③ Spine/Chest/Neck/Head 旋转幅度 ×0.65（对四元数向 identity slerp，保持方向/相位，只压幅度）。

| 指标 | mate walk（原） | 微调原型 | 目标 HSR 男走 |
|---|---:|---:|---:|
| 髋部横向漂移 | 5.27 cm | **2.64 cm（−50%）** | 0 cm |
| 头部横向摆幅 | 6.17 cm | **2.44 cm（−60%）** | 1.2 cm |
| 双脚平均间距 | 10.1 cm | **12.7 cm（+26%）** | 12.7 cm |
| 膝屈最大值 | 68.4° | 68.4°（不变） | 62.3° |
| 髋部起伏 | 3.0 cm | 3.0 cm（不变） | 3.9 cm |

![female walk 男性化原型对比](../../work/wave15-male-adapt/04-female-walk-masculinize-proto.jpg)

观察与结论：
- **三个最“女性化”的可测通道（胯摆/头摆/站距）一次调整即接近 HSR 男走水平**，步频与膝屈保留，说明“幅度基座”层面的微调确实有效；
- 但静态图观感差异有限，真正的说服力需要在 app 连续播放里看；且它**无法改变“手的位置/动作意图”**；
- 脚部悬空 +2.15cm 仍需要 R4 修，幅度微调不解决接触。

---

## 5. 给本项目的落地建议（分阶段）

> 前提：当前 app 的 idle 主选是 HSR（priority 10），Mate idle 是 priority 0..-6 的变体（轮换间隔 12–20s）；
> 所以「HUS_IDLE 系列没出现在屏幕上」通常是 **优先级 + 轮换间隔 + app 未重启/未热加载 manifest** 三件事叠加，不是 bug。

### 阶段 1（已完成 / 本轮）
- drag：男女两版同 priority，进入拖拽时随机二选一（本次已实现并验证 `mate-drag`/`mate-dragFemale` 都会出现）；
- walk：Mate 女走降到 catalog-only（priority −10/−11），app 主走路改为今天新做的 **HSR 官方 `adv-walk`**（实机 `clipId=adv-walk` 已验证）；
- idle：HUS 男性候选 01–09 已渲染给用户验收，结论是**都不符合砂金人设**（直臂下垂/手外伸观感接近 A-pose）；
  已回滚为 **idle 自动池只保留 HSR/adv 男性 idle**，Mate 女 idle/pose 全部降到 −10 以下仅 catalog 可回放；
  HUS 男性 idle 数据归档 `assets/motions/mate-husbando-idle-legacy/`（后续如做 male profile 可再用）。
  说明：这不是“A-pose rest 偏移回归”——目标仍是 T-pose VRM，HUS 的 upperArm 实测 18–30° 属正常下垂幅度，
  只是 HUS 动作语汇/直臂观感在砂金身上读起来像 A-pose。

### 阶段 2（建议下一步，先做这个）
- 给 **无男性源的女体 clip**（sit/sleep/hide/pose/交互）跑一个离线“男性化后处理”原型：
  - 输入所有 mate clip → FK 幅度阻尼 + 局部 offset（R2/R6）→ 写回新 clip 集（保留 originals 回滚）；
  - 先覆盖 **sit / sleep / walkAlt** 这类“姿态可救”的 clip；`happy/laughing/shyPoint` 这类手势语义 clip 不建议硬救；
  - 用本报告指标做 A/B：髋/头横摆、脚距、脚接触误差、膝内扣；再人工看 3 个循环。
- 实现位置：新增 `scripts/unity-bake/masculinize-clips.mjs`（纯数据后处理，不依赖 Unity），产出 `assets/motions/mate-male-tuned/**`；
  跑 `validate-clips` + 逐 clip A/B 渲染后，再决定是否替换 mate 原数据。

### 阶段 3
- 运行时 **male profile**：按 avatar/模型（或手动开关）选择 idle/sit/walk 候选池，避免女性模型也被套男性动作；
- app 内保留“男性化强度”调试滑杆（先内部用，验收后再决定是否暴露给用户）。

### 验收指标（建议冻结）
| 指标 | 目标 |
|---|---|
| 髋部横向漂移 | ≤ 3cm（女走现状 5.3cm；HSR 男走 0cm） |
| 头部横向摆幅 | ≤ 3cm（现状 6.2cm） |
| 双脚平均间距 | 12–13.5cm（现状 10.1cm） |
| 脚部最低点离地 | ≤ 1cm（逐帧；现状 preview 2.15cm） |
| 膝内扣/反关节 | 无（IK pole + 限位） |
| 视觉验收 | 同一相机 4 帧/2 循环 A/B + app 实机 3 分钟 |

### 风险/回滚
- 全局 offset 会让**所有 clip 同时变**：必须保留每 clip 开关 + 原数据归档（参考 `assets/motions/mate-female-legacy/`）；
- 改幅度会掩盖原动作意图（尤其 sit/suwari3、pose），宁可不改也不要硬救；
- B站/模之屋教程链接多为页面/视频，部分站反爬需站内打开；论文无现成 checkpoint。

---

## 6. 参考链接（分类）

### 6.1 官方文档（Unity / Unreal / VRM）
- Unity：[Retarget Humanoid animations](https://docs.unity3d.com/6000.1/Documentation/Manual/Retargeting.html)、[Muscle & Settings](https://docs.unity.com/en-us/engine/6000.0/manual/animation-section/animation-mecanim/avatar-creationand-setup/muscle-definitions)、[Animation Layers](https://docs.unity3d.com/6000.1/Documentation/Manual/AnimationLayers.html)、[HumanPoseHandler](https://docs.unity3d.com/6000.1/Documentation/ScriptReference/HumanPoseHandler.html)、[Inverse Kinematics](https://docs.unity3d.com/6000.1/Documentation/Manual/InverseKinematics.html)、[Animation Rigging](https://docs.unity3d.com/Packages/com.unity.animation.rigging@1.4/manual/index.html)、[Bidirectional Motion Transfer（Humanoid 不支持）](https://docs.unity3d.com/Packages/com.unity.animation.rigging@1.4/manual/BidirectionalMotionTransfer.html)、[TwoBoneIKConstraint](https://docs.unity3d.com/Packages/com.unity.animation.rigging@1.4/api/UnityEngine.Animations.Rigging.TwoBoneIKConstraint.html)、[中文 Muscle & Settings](https://docs.unity3d.com/cn/6000.0/Manual/MuscleDefinitions.html)、[Avatar Mapping](https://docs.unity3d.com/cn/6000.0/Manual/class-Avatar.html)
- Unreal：[IK Rig Animation Retargeting](https://dev.epicgames.com/documentation/en-us/unreal-engine/ik-rig-animation-retargeting-in-unreal-engine)、[Retargeting Bipeds with IK Rig](https://dev.epicgames.com/documentation/unreal-engine/retargeting-bipeds-with-ik-rig-in-unreal-engine)、[Fix Foot Sliding（Speed Planting）](https://dev.epicgames.com/documentation/en-us/unreal-engine/fix-foot-sliding-with-ik-retargeter-in-unreal-engine)、[IK Rig](https://dev.epicgames.com/documentation/unreal-engine/ik-rig-in-unreal-engine)、[Python IK Retargeter](https://dev.epicgames.com/documentation/en-us/unreal-engine/using-python-to-create-and-edit-ik-retargeter-assets-in-unreal-engine)、[Animation Modifiers](https://dev.epicgames.com/documentation/en-us/unreal-engine/animation-modifiers-in-unreal-engine)、[Retarget Operation Stack](https://dev.epicgames.com/documentation/en-us/unreal-engine/retargeting-operation-stack-in-unreal-engine)
- VRM：[VRM 1.0 humanoid spec](https://github.com/vrm-c/vrm-specification/blob/master/specification/VRMC_vrm-1.0/humanoid.md)、[VRMA spec](https://github.com/vrm-c/vrm-specification/blob/master/specification/VRMC_vrm_animation-1.0/README.md)、[pose 兼容/hips 缩放](https://github.com/vrm-c/vrm-specification/blob/master/specification/VRMC_vrm_animation-1.0/how_to_transform_human_pose.md)、[three-vrm VRMHumanoid API](https://pixiv.github.io/three-vrm/docs/classes/three-vrm-core.VRMHumanoid.html)、[three-vrm humanoid 示例](https://raw.githubusercontent.com/pixiv/three-vrm/dev/packages/three-vrm-core/examples/humanoid.html)、[three-vrm hips 沉地 issue #1643](https://github.com/pixiv/three-vrm/issues/1643)、[VRCD 中文 VRM Humanoid](https://docs.vrcd.org.cn/books/vrm-univrm/page/humanoid)、[VRCD 初始姿态差异](https://docs.vrcd.org.cn/books/vrm-vrm/page/c9e10)、[VRCD VRM Animation](https://docs.vrcd.org.cn/books/vrm-vrm/chapter/vrm-animation)

### 6.2 实战教程（B站/模之屋/知乎/CSDN）
- B站：[vmd2vrma（VMD→VRMA）](https://www.bilibili.com/video/BV1k4ei6FEQr/)、[VmdSizing 一键适配身高/腿长](https://www.bilibili.com/opus/1102907465195847688)、[跨模型动作/镜头套用实验笔记](https://www.bilibili.com/opus/524308411832540153)、[MMD 足 IK 使用](https://www.bilibili.com/video/BV1FdNPeSELN/)、[MMD 动作修复/调整](https://www.bilibili.com/video/BV1j8h16uEQy/)、[iClone 修脚滑](https://www.bilibili.com/video/BV1icbMejE3J/)、[任意动画→人形骨骼重定向](https://www.bilibili.com/video/BV1qY79z3EBY/)、[Animation Rigging 官方直播](https://www.bilibili.com/video/av61671904/)
- 模之屋/VRCD：[PE 骨骼面板详解](https://www.aplaybox.com/article/details/848169460)
- 知乎/CSDN：[男生跳女生舞如何帅气不妖娆](https://www.zhihu.com/question/575023468)、[程序化动画（知乎）](https://zhuanlan.zhihu.com/p/135877690)、[动画重定向：骨骼映射与空间转换](https://blog.csdn.net/qq_33060405/article/details/148819567)、[Blender BVH 重定向后关节错位](https://ask.csdn.net/questions/9378483)
- 男角色做女动作案例（B站）：[艾尔海森女团舞](https://www.bilibili.com/video/BV1E24y1T73d/)、[风系少年 STEP](https://www.bilibili.com/video/BV1RU4y1g7uH/)、[八个男生跳成八个女生](https://www.bilibili.com/video/BV1Hv421y7bz/)

### 6.3 GitHub / 工具
- [pixiv/three-vrm](https://github.com/pixiv/three-vrm)（`normalizedHumanBones` / `getNormalizedPose` / `setNormalizedPose`）
- [saori-eth/vrm-mixamo-retargeter](https://github.com/saori-eth/vrm-mixamo-retargeter)（逐骨映射 + 比例缩放）
- [KBSBAUDRICE/Retarget](https://github.com/KBSBAUDRICE/Retarget)（Blender Retarget 扩展：AnimOffset、Bake Constrained Actions）
- [TREE-Ind/animation_retargeting](https://github.com/TREE-Ind/animation_retargeting)
- [blender_BoneAnimCopy](https://github.com/mayloglog/blender_BoneAnimCopy)
- [vrma-lab](https://github.com/YuBan834/vrma-lab)（浏览器 VRM 动画编辑，FBX→VRMA）
- [NinjaFootIkRig](https://github.com/studentutu/NinjaFootIkRig)（Unity 足 IK + 髋下沉参考实现）
- [DeepMotionEditing](https://github.com/DeepMotionEditing/deep-motion-editing)（SIGGRAPH 2020 retarget / style transfer 官方代码）
- [Semantic-Motion-Retargeting](https://github.com/chenzhike110/Semantic-Motion-Retargeting)（CVPR 2024 语义保持 retarget 代码）
- [Rokoko Studio Retargeting Guide](https://support.rokoko.com/hc/en-us/articles/14843726304657-Rokoko-Studio-Retargeting-Guide)（商业工具内建的 Adjust shoulders/neck 等比例修正项）
- [Blender IK 约束](https://docs.blender.org/manual/en/latest/animation/constraints/tracking/ik_solver.html)

### 6.4 论文
- [Skeleton-Aware Networks for Deep Motion Retargeting（SIGGRAPH/TOG 2020）](https://arxiv.org/abs/2005.05732)
- [Contact-Aware Retargeting of Skinned Motion（ICCV 2021）](https://arxiv.org/abs/2109.07431)
- [Unpaired Motion Style Transfer from Video to Animation（SIGGRAPH 2020）](https://arxiv.org/abs/2005.05751)
- [D-LORD for Motion Stylization（IEEE TSMC 2024）](https://arxiv.org/abs/2412.04097)
- [Semantics-aware Motion Retargeting with VLMs（CVPR 2024）](https://arxiv.org/abs/2312.01964)
- [Retargeting Matters: General Motion Retargeting for Humanoid Motion Tracking](https://arxiv.org/html/2510.02252v1)
- [Sparse Motion Semantics for Contact-Aware Retargeting（MIG 2023 poster）](https://project.inria.fr/mig2023/files/2023/11/poster_11.pdf)

### 6.5 本项目内相关文档/证据
- [Wave 1.5 完成报告](../wave15-report.md)（§5 姿态一致性、§7 已知限制、脚部 grounding 口径）
- [Wave 1/1.5 管线踩坑清单](wave1-15-pitfalls.md)（hips 缩放、贴地分工、源路线选择）
- [V3 HSR 官方动作报告](../vrm-motion-hsr.md)（grounding、rest 修正、rawPolicy）
- 证据目录：`tests/tmp/wave15/final-tpose-metrics`（native walk/idle 指标）、`tests/tmp/husbando/proto-metrics`（原型指标）、`tests/tmp/husbando/preview-*`（对比渲染）
- 本报告对比图：`work/wave15-male-adapt/04-female-walk-masculinize-proto.jpg`

---

## 7. 附录：测量与复现

```bash
# 1) 女走 vs HSR 男走指标（已有证据；重跑 preview 即可）
node scripts/unity-bake/preview-clips.mjs --clips walk \
  --vrm assets/vrm/aventurine-tpose.vrm \
  --frames 0,0.2,0.4,0.6,0.8,0.95 \
  --out tests/tmp/wave15/final-tpose --metrics tests/tmp/wave15/final-tpose-metrics --sheet
PREVIEW_MOTIONS_REL=assets/motions/adv node scripts/unity-bake/preview-clips.mjs --clips walk \
  --vrm assets/vrm/aventurine-tpose.vrm --frames 0,0.2,0.4,0.6,0.8,0.95 \
  --out tests/tmp/husbando/preview-adv --metrics tests/tmp/husbando/metrics-adv --sheet

# 2) 原型（幅度阻尼）生成 + 渲染
#    work/proto-motions/walkProtoA.json = 原 mate walk 的 Hips.p.x*0.5、Hips 旋转*0.72、Spine/Chest/Neck/Head 旋转*0.65
PREVIEW_MOTIONS_REL=work/proto-motions node scripts/unity-bake/preview-clips.mjs \
  --clips walkProtoA --vrm assets/vrm/aventurine-tpose.vrm \
  --frames 0,0.2,0.4,0.6 --out tests/tmp/husbando/proto --metrics tests/tmp/husbando/proto-metrics --sheet

# 3) 指标读取：hipsLateralDrift / head x-span / foot separation 已包含在 preview metrics JSON
```

> 授权/红线：本报告引用的模型与动作资产版权归 miHoYo / 模型作者 / Mate-Engine(Shiny)，仅本机私有研究，不随 app 分发；
> 所有渲染图/原型数据均在 gitignore 目录（`work/`、`tests/tmp/`、`assets/motions/**`）。
