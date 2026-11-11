# 抛掷 → 空中 → 落地：Mate-Engine 调研与无动捕方案评估（2026-11-09）

> 状态：**只读调研完成；本轮不新增动作素材，保留现有动作**（用户要求：没有把握就别做「像突发恶疾一样」的半成品动作）。
> 已落地的最小改进见 §4（空中不播地面受击、落地补播眩晕；数据侧 bug 见
> `docs/research/stun-break-hips-fix.md`）。

## 0. 结论

1. **Mate-Engine 没有可复用的「抓起/抛出/空中/落地/受击/眩晕/布娃娃」实现或素材**：
   - 抓取 = 拖 Unity 透明窗口本身（`AvatarWindowHandler.cs`）；角色只切 `isDragging → Drag`
     一个动画状态，鼠标松开后窗口停在原处/吸附窗沿，**无重力下落、无落地动画、无 ragdoll**；
   - 角色恒在窗口原点，root/hips 不被物理驱动；`AvatarGravityController.cs` 只是把窗口位移映射成
     VRM SpringBone 外力；`DynamicBone` 只管头发/衣摆；控制器无 Fall/Throw/Land/Hit/Stun 状态；
   - `AssetBundles/dragging_animation` 是 Unity 6 示例包，唯一资产 `PET_DRAGGING_MOD.anim`；
   - 许可：AGPL v3 + MatePro v2.1 混合，`LICENSE.md` 禁商用/二进制平台再分发，动画素材亦不可搬
     （本项目 `assets/motions/mate/*` 是其转换产物，仅本地私有使用；对外分发需先解决授权）。
2. **同栈最接近的可借鉴实现是 YUI**（Tauri + three-vrm 3.5，PolyForm Noncommercial）：
   `falling.vrma`（Mixamo Falling_2 循环）+ `landing.vrma`（Mixamo Falling_and_landing 7.18s）；
   角色留在原点播就地 clip，**OS 窗口做下落积分**，落地后交还站/坐。drag 用的正是 Mate-Engine
   `PET_DRAGGING` 转 VRMA。—— 即「物理驱动 root + 两条现成 Mixamo 就地 clip」，无需动捕、非手 K。
3. 本轮**不新增动作**，只做时序修正（§4）。理由：用户明确宁缺毋滥；现有 `PetPhysics` + fall 状态机
   已能承载「空中/落地」物理，缺的只是空中姿态素材；而新增素材需要下载 Mixamo FBX/VRMA 并走转换管线，
   属于独立一轮的观感升级，不应和 bug 修复混在一起。
4. 若将来要把「被扔出去」当卖点，**唯一低风险高上限方案 = YUI 式两条 Mixamo 就地 clip**（0.5–1 人日）；
   程序化叠加易翻车、rapier/cannon-es 全 ragdoll 成本 3–5 人日且桌面尺寸收益低、移植 Mate-Engine 不可行。

## 1. Mate-Engine 证据（clone 到 /tmp，commit `2c5ea6b`）

| 文件 | 结论 |
|---|---|
| `LICENSE.md` | AGPL v3 + MatePro 2.1；禁止商用/二进制平台分发（含动画） |
| `Assets/MATE ENGINE - Scripts/AvatarHandlers/AvatarWindowHandler.cs` | 拖拽 = 拖透明窗口；松手停在原处/吸附 |
| `.../AvatarAnimatorController*.cs` + `AvatarAnimatorControllerV2.controller` | 状态只有 Idle/Drag 等，无 Fall/Throw/Land/Hit/Stun |
| `.../AvatarGravityController.cs` | 窗口位移 → SpringBone 外力（不是刚体/ragdoll） |
| `Assets/MATE ENGINE - Animations/PET_DRAGGING.anim` | 唯一拖拽动画；`AssetBundles/dragging_animation` 为 Unity 6 示例包 |
| DynamicBone 脚本 | 只驱动头发/衣摆 |

→ 结论：**没有能直接用/直接对拍的抛掷-落地实现与素材**。

## 2. 同类实现对比

| 项目/产品 | 拿起/扔下 | 说明 |
|---|---|---|
| **YUI**（yw0nam/YUI，Tauri + three-vrm 3.5） | ✅ Mixamo `falling`(循环) + `landing`(7.18s) 就地 clip；窗口做下落积分 | 同栈、有单测、最值得对拍 |
| uDesktopMascot（Apache-2.0） | ❌ 纯 clip 状态机，无抓/扔/ragdoll | 可参考工程结构 |
| Desktop Mate（Steam） | 脚本动画（拖到窗口上/窗口间跳），无物理 | 闭源，不可借鉴实现 |
| ChatdollKit | ❌ 对话/动画框架 | 无关 |
| DanceXR（VR Storm Lab） | XPBD ragdoll/主动布娃娃 | 闭源商业、非 three 栈，不可移植 |
| Mate-Engine | ❌ 见 §1 | 不可复用（实现/素材/许可） |

## 3. 方案对比（three.js + three-vrm 语境，无动捕）

| 方案 | 成本 | 观感上限 | 风险/依赖 | 结论 |
|---|---|---|---|---|
| **A. 保留现有动作 + 修 bug + 时序修正** | ≈0 | 低（空中沿用 drag/fall 姿态） | 无新依赖 | ✅ 本轮落地 |
| **B. YUI 式两条 Mixamo 就地 clip**（fall 循环 + landing 起身）接 `fall`/`landed` 槽 | 0.5–1 人日 | 高（≈YUI 上线水平） | Mixamo 条款：可用于项目、不可单独转售素材；需转 clip + hips 归零 + 贴地 + 时长对齐 | 推荐作为后续观感升级 |
| C. 程序化空中姿态（按速度收腿/张手/落地屈膝） | 0.5 人日 | 低-中，极易「突发恶疾」 | 需大量实机调参，只宜作 B 的微调 | 不建议单独做 |
| D. rapier/cannon-es 全 ragdoll / PD 回拉 | 3–5 人日+ | 高但抖动/穿模/性能风险 | 新增 wasm、逐模型 collider/joint 调参、换模型风险；540px 桌面尺寸收益低 | 不推荐 |
| E. 移植 Mate-Engine | — | — | 无对应功能 + 许可 + Unity→three 重写 | 不可行 |

**未采纳的本地现成素材**（后续可选）：HSR 官方 FBX 里已有 `Hit_H`（重击，侧视可见明显后仰/离地）、
`Die`/`Die_Loop`（跪倒/倒地）、`Revive`（起身）这类 clip，已在 `assets/motions/adv/` 与 app-catalog
中；但它们的 Hips 竖直语义同样需要按 `docs/research/stun-break-hips-fix.md` 的 `hipsBase` 思路修一遍，
且 `Die` 序列（die→die-loop→revive）需要状态机分三段，超出「只修 bug」范围。若做 B 方案可同时评估这条
「官方素材路线」（优点：同角色/同画风，无需外部下载；缺点：落地/起身段需要重标数据与串接）。

## 4. 本轮已落地的最小改进（不改素材）

1. **数据 bug 修复**：`stun`/`hitL`/`breaked`/`revive` 的 Hips 竖直语义修正（见
   `docs/research/stun-break-hips-fix.md`）——这是「起跳/蜷缩」的真正根因。
2. **空中不播地面受击**（`vrm/clip-player.ts`）：`thrown` 事件在 `motion.airborne === true` 时不再
   立刻播 `hsr-stun`（地面受击语义），而是记下，落地 `landed` 时补播 `hsr-stun`；重新拖拽会清掉记录。
   → 从高处扔下：空中保持现有 fall/drag 姿态（物理下落），落地后才出现眩晕反应。
3. **mood 过场同理延迟**（`vrm/animator.ts`）：`dshError` 进入的 `hsr-breaked` / 离开的 `hsr-revive`
   如果在腾空瞬间触发，推迟到落地补播一次（新 mood 变化会覆盖旧 pending，避免过期过场）。
4. 单测：`tests/vrm-clip-player.test.ts`（空中 thrown 延迟/落地补播/重新拖拽清理）、
   `tests/vrm-animator.test.ts`（空中 dshError 延迟、落地补播一次）全绿。

## 5. 若后续做 B 方案（建议顺序）

1. 获取两条 Mixamo 动画（`Falling` 循环 / `Falling_and_landing`）→ FBX 或 VRMA；
2. 走现有转换管线转成本项目 clip JSON（仅 humanoid 旋转 + 归一化 Hips；落地 clip 用
   `hipsBase:"rest"` 或落地首帧归零，确保贴地）；校验：脚底/膝接触、无 1 帧 snap；
3. registry 增加 `fall` 槽（循环）与 `landed` 播 landing 段（一次性 → 回 mood）；
4. 实机对比 A/B 两版截图+录像，确认后再切换；混用会互相打架，不做默认开启。

## 6. 引用

- Mate-Engine: https://github.com/shinyflvre/Mate-Engine（commit `2c5ea6b`；LICENSE.md / AvatarHandlers）
- YUI: https://github.com/yw0nam/YUI （`docs/guide/motions.md`、`src/ambient/locomotion/fall/faller.ts`）
- uDesktopMascot: https://github.com/MidraLab/uDesktopMascot
- DanceXR: https://vrstormlab.com/zh/dancexr/releases/2026.9
- Unity Humanoid Root Motion（root/hips 分工参考）：https://docs.unity3d.com/2022.3/Documentation/Manual/RootMotion.html
- three-vrm 相关：https://github.com/pixiv/three-vrm/pull/1649 、https://github.com/pixiv/three-vrm/issues/1643
