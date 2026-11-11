# 参考仓库 & 生态深度审计：我们能不能直接拿到可用动作？

> 审计对象（用户点名的 4 个仓库）：`shinyflvre/Mate-Engine`、`jinsc123654/l2dpet`、`sixtysevenlf/dsh-blender-plugin`、`xkk6663/dsh-live2d-mao`，以及围绕它们可复用的动作/工具生态。
> 审计目标：回答「能不能直接给本项目 PMX（three.js r171 `MMDLoader`）提供可播放动画/可复用工具链」，并给出**不模棱两可**的判定、证据与工作量估计。
> 审计日期：2026-11-08。工作目录：`/Volumes/4TB外置盘/deepseek-harness/aventurine-pet`。
> 关联文档：`PLAN.md` §11.1 / §20.3 / §20.7、`docs/anim-reference.md`（109 个非舞蹈片段清单）、`docs/anim-tech-survey.md`（B3 技术调研与 VMD 互斥结论）。

---

## 0. 一页结论（先看这张表）

| 仓库 / 生态 | 真实技术栈（实测） | 自带动作/动画资产 | 能否直接给我们的 PMX 提供可播放动画 | 我们能直接复用什么 | 一句话判定 |
|---|---|---|---|---|---|
| [shinyflvre/Mate-Engine](https://github.com/shinyflvre/Mate-Engine) | Unity **6000.2.6f2**（Unity 6.2）桌宠，VRM 模型，Windows/Steam | `Assets/MATE ENGINE - Animations/` 下 **128 个 `.anim`，748 MB**，全部是 **Unity Humanoid muscle clip**（YAML） | **不能直接**：three 读不了 Unity YAML/肌肉空间；仓库内**没有任何**动作 FBX/glTF/VMD | ①动作清单/状态机/节奏参考；②**经 Unity 烘焙+重定向后**的动作数据（仅本地个人非商用、需署名 Shiny、不得再分发） | **需转换**；值得为「宠物专属片段」装 Unity，但不值得为全部 128 个装 |
| [jinsc123654/l2dpet](https://github.com/jinsc123654/l2dpet) | C++17 + Live2D **Cubism Native SDK 5-r.5** + EUI-NEO；Windows/Linux/macOS（macOS 未实机验证） | Live2D **2D** 资源：`.moc3/.model3.json/.motion3.json/.physics3.json/.exp3.json`；**无任何 3D 骨架动作** | **不能**（2D 参数动画，与 PMX 骨骼无关） | 行为调度设计：生命状态机 / VAD 连续情绪 / 躯体通道增量层 / 动作槽位 / 气泡队列 | **仅设计参考**，资产与技术栈不可移植 |
| [sixtysevenlf/dsh-blender-plugin](https://github.com/sixtysevenlf/dsh-blender-plugin) | DSH 宿主插件（TypeScript）+ Blender addon（Python）+ 本地 backend（Node/Python） | **无动作资产**（它是工具，不是素材库） | **不提供**动作（这点必须先说清） | **✅ 可视化调参/渲染回路**：15 个工具 + 38 个 addon 命令；配合 Blender 4.2 LTS + MMD Tools 后可载 PMX/摆骨/三视图/导出 VPD/FBX | **唯一可直接上手的工具类可复用项** |
| [xkk6663/dsh-live2d-mao](https://github.com/xkk6663/dsh-live2d-mao) | Electron + Vue + FastAPI + Live2D（pixi-live2d-display，Cubism 4）；**Windows 10/11 x64 only** | Live2D **2D** 资源：7 个模型 / 75 个 `.motion3.json`；**无 3D 动作** | **不能**（2D；且 Windows-only，macOS 跑不起来） | 12 态 phase 总线（优先级/节流/心跳）、动作与表情**槽位绑定**、三通路解耦（phase/stream/bubble）设计 | **仅设计参考**，与 B7 现有实现可对照，但不能用于 PMX |

**最重要的一句话**：**4 个仓库里没有任何一个能不经转换地给本项目的 PMX 提供动作资产。** 用户想要的「可直接复用的动作包」需要从别的地方拿（MMD VMD/VPD、VRMA 等），或走 Mate-Engine 的 Unity 烘焙管线。

**生态结论速览（第 6 节展开）**：
- 直接可用路线（先做）：**MMD 原生 VMD/VPD**（`MMDLoader` r171 原生支持），成本最低；
- 高价值补充（次选）：**把 Mate-Engine 的 `.anim` 用 Unity 烘焙成每帧骨骼 JSON，再用 TS 重定向到 PMX 骨骼**（约 3–5 人日，见 §2.5(f) 与 §7 路线 B）；
- 并行工具（解决「盲调」根因）：**dsh-blender-plugin + Blender 4.2 LTS + MMD Tools** 三视图/调参回路（约 0.5–1 人日）；
- 本次检索**没有发现** Mate-Engine 动画的公开 FBX/MMD 导出，也**没有发现**可用的「Unity humanoid `.anim` 纯离线解码器」——想转就必须装 Unity。

---

## 1. 审计方法与环境（可复核）

### 1.1 环境

| 项 | 值 |
|---|---|
| 机器 | macOS，Apple **M5 Max**，36 GB 内存，arm64 |
| 磁盘 | 根分区可用 226 GB；外置盘 3.4 TB 可用 |
| 已装工具 | Node v24.21.0、git；**未安装 Unity、未安装 Blender、无 Homebrew** |
| 项目 HEAD | `7e8ebe191c38e62e73d54eb6860933bef1a9956f`（2026-11-08 01:20） |
| DSH | DeepSeek Harness.app `CFBundleShortVersionString = 0.2.2-rc.1` |
| 网络 | github.com 可达；`api.github.com` **配额耗尽（remaining=0）**，全程未使用 REST API |

### 1.2 抓取方式（证据可复现）

> 因 api.github.com 配额已耗尽（Lead 环境提示），全部改为不消耗 API 的方式；报告内所有「仓库内证据」均来自本地 clone。

```bash
# 4 个仓库：depth-1 + blob:none 克隆到 /tmp（不落工作区）
git clone --depth 1 --filter=blob:none https://github.com/<owner>/<repo>.git /tmp/repo-audit/<owner>_<repo>
# Mate-Engine 的 128 个 .anim 逐个取内容（promisor 按需取 blob，不消耗 API）
git -C /tmp/repo-audit/shinyflvre_Mate-Engine show "HEAD:Assets/MATE ENGINE - Animations/<...>.anim"
```

| 仓库 | 审计 commit | commit 时间 |
|---|---|---|
| shinyflvre/Mate-Engine | `2c5ea6b8f4cf5e1773a0816b46d9267cda5174d4` | 2026-01-20 19:46 +0100 |
| jinsc123654/l2dpet | `c8a7bbc9109ba4cee8ee4332c191a37cce93c8d1` | 2026-10-13 21:27 +0800 |
| sixtysevenlf/dsh-blender-plugin | `5904cf8be4fd1a789924e1b07b4633bf2714fb5b` | 2026-11-07 22:37 +0800 |
| xkk6663/dsh-live2d-mao | `21b9db21d0abfc974fe88b155517563d155e9c51` | 2026-11-01 21:48 +0800 |

外部资料抓取方式（raw.githubusercontent.com / github.com HTML / npm registry / web_search）逐条记录在 `tests/tmp/repo-audit/external-sources.md`；Steam 新闻页与 stereoarts.jp 直连抓取失败（见 §9），相关结论只采用仓库内 README 或可复核的二手来源。

### 1.3 证据产物（不入库，供复核）

全部放在 `tests/tmp/repo-audit/`（按团队约定临时产物目录）：

| 文件 | 内容 |
|---|---|
| `mate-engine-anim-summary.md` | 128 个动画的分类/时长/采样率/循环/静态 pose 汇总（实测） |
| `mate-engine-anim-manifest.csv` / `.json` | 128 行完整清单：文件名、clip 名、时长、fps、loop、曲线类型、属性数、关键帧数、字节数、sha1 |
| `scripts/parse_mate_engine_anims.py` | 上述清单的生成脚本（可重跑） |
| `dsh-blender-plugin-notes.md` | 15 工具 / 38 addon 命令 / 版本 / 版本兼容 / macOS 支持证据 |
| `live2d-repos-notes.md` | l2dpet 与 dsh-live2d-mao 的资产格式、行为调度代码证据 |
| `external-sources.md` | 外部链接、抓取方式/日期、失败项 |

---

## 2. Mate-Engine（重点）

### 2.1 仓库事实

| 项 | 实测 |
|---|---|
| 定位 | 「免费版 Desktop Mate」：VRM 桌宠，Windows/Steam，支持自定义 VRM、Steam Workshop、动画 Mod |
| Unity 版本 | `ProjectSettings/ProjectVersion.txt`：`m_EditorVersion: 6000.2.6f2`（Unity 6.2） |
| 规模 | 约 10,041 个文件；`1457 .cs`、`162 .anim`（其中动画目录 128）、`535 png`、`285 shader` |
| 结构 | `Assets/MATE ENGINE - Animations/`、`Assets/MATE ENGINE - Scripts/`、`AssetBundles/`、`ExportedMods/`、`Packages/`、`ProjectSettings/` |
| 动画控制 | 3 层 Animator Controller：**Base Layer / Face Layer / Speak Layer**，17 个参数（见 §2.3） |
| 动画 Mod 能力 | `Assets/Editor/ModExporterWindow.cs`（`BuildPipeline.BuildAssetBundles`）+ `Assets/MATE ENGINE - Scripts/Tools/MEDanceModCreator.cs`；Mod 容器 `.me` 实测是 zip |
| Linux 移植 | 官方 README 第 2 行指向非官方 Linux 移植 [Marksonthegamer/Mate-Engine-Linux-Port](https://github.com/Marksonthegamer/Mate-Engine-Linux-Port)（**仍是 Unity 构建**，构建需 Unity 6000.2.6f2） |

### 2.2 动画资产实测清单（核心）

实测方式：对 `Assets/MATE ENGINE - Animations/` 下 **128 个 `.anim` 全量下载并解析**（748 MB，3,193,418 条关键帧条目）。完整清单见 `tests/tmp/repo-audit/mate-engine-anim-manifest.csv`；汇总如下：

| 分类 | 数量 | 数据量(MB) | 时长 min/中位/max (s) | 采样率 | loop=1 | 用途/备注 |
|---|---|---|---|---|---|---|
| PET_IDLE | 35 | 206.0 | 2.45 / 7.00 / 17.02 | 30/60/120 | 35 | 待机/呼吸/随机小动作；含 11 个男角色 `HUS_*`（drag/idle/sitting）与 6 个 120fps 新版 |
| PET_SITTING | 26 | 120.8 | 0.00 / 2.36 / 19.96 | 24/30/60 | 25 | 坐姿，含窗沿坐 `BETA_PET_WINDOW_LAY*` / `WINDOW_LAY_8-10` |
| PET_DANCING | 17 | 94.3 | 1.33 / 6.33 / 27.35 | 60 | 17 | 舞蹈（用户已排除，不作参考） |
| PET_HIDING | 6 | 49.1 | 1.00 / 8.00 / 13.98 | 60 | 4 | 躲藏/探头/窗边隐藏 |
| PET_POSE | 4 | 42.2 | 5.00 / 6.80 / 6.80 | 30/60 | 4 | 摆 pose |
| PET_MISC | 9 | 29.8 | 2.45 / 4.00 / 12.78 | 24/30/60 | 8 | 拖拽/开心/大笑/害羞/悬停/占位 |
| UPDATE_2 | 5 | 23.3 | 1.00 / 11.98 / 16.50 | 60 | 5 | 待机补充 + 说话口型 |
| PET_LOCOMOTION | 7 | 12.1 | 1.42 / 1.42 / 1.42 | 24 | 7 | 走路循环（左右 + walk_cycle_sexy 系列） |
| PET_INTRO | 4 | 7.0 | 1.53 / 6.09 / 13.33 | 30/60 | 1 | 开屏/入场 |
| PET_SLEEPING | 1 | 5.4 | 35.17 | 60 | 1 | 睡觉长循环 |
| PET_BIG_SCREEN | 5 | 75.4 | 3.73 / 13.33 / 16.73 | 30/60 | 5 | 大屏/屏保模式 |
| FACE_LAYER | 6 | 0.1 | 1.00 / 10.03 / 10.03 | 60 | 6 | 表情/口型叠加（blendshape 曲线，不是骨骼） |
| U_MOTIONS | 3 | 82.5 | 1.00 / 26.04 / 45.00 | 25/60 | 3 | 浮动/长待机，偏工具 |
| **合计** | **128** | **748.0** | — | 24/25/30/60/120 | **121** | — |

**格式实证（关键，反驳「能不能直接读」的核心证据）**：

- 128 个片段**全部** `m_RotationCurves: []`、`m_PositionCurves: []`、`m_HasGenericRootTransform: 0`，骨骼数据全部在 **muscle float curves** 里：
  - `Assets/MATE ENGINE - Animations/PET_IDLE/PET_IDLE.anim` L117 `attribute: RootT.x`、L378 `attribute: RootQ.x`、L1173 `attribute: LeftFootT.x`；L17088 `m_SampleRate: 60`；`m_AnimationClipSettings` 中 `m_StopTime: 2.4500122`、`m_LoopTime: 1`。
  - `PET_SLEEPING/PET_SLEEPING.anim`：`m_SampleRate: 60`、`m_StopTime: 35.166668`。
  - `PET_LOCOMOTION/PET_WALK_LEFT.anim`：`m_SampleRate: 24`、`m_StopTime: 1.4166666`、`m_LoopTime: 1`。
  - `PET_SITTING/BETA_PET_WINDOW_LAY.anim`：`m_SampleRate: 24`、`m_StopTime: 19.958334`。
- 曲线属性名是 **Unity Humanoid 肌肉空间**（`RootT/RootQ/LeftFootT/LeftFootQ/...`），**`path` 全为空、没有任何骨骼名**——这不是 FBX/glTF 的骨骼 transform 曲线，three.js 无法按骨骼名消费（与 `PLAN.md` §11.1 结论一致，本次用全量数据再次证实）。
- **9 个片段**是 `classID: 114` 的 **blendshape 曲线**（6 个 FACE_LAYER + 2 个 `FACE_SMILE` + `UPDATE_2/PET_TALKING`），引用 `Assets/MATE ENGINE - Scripts/AvatarHandlers/UniversalBlendshapes.cs.meta`（GUID `11e9eb032e6bd2f4aa91f9c1ff666c1b`）；这些是表情/口型，同样不是骨骼动画。
- **10 个坐姿片段是「单帧/近零时长」静态 pose clip**：`BETA_PET_WINDOW_LAY_2..7`、`PET_SITTING_DEMO`、`PET_SITTING_DEMO_2`、`sippose39`、`sipposeC06`（`m_StopTime` 0–0.03s）。它们是**姿态参考**，当动画播放必须自己做过渡/混合。
- 121/128 循环；无重复内容（128 个 sha1 两两不同）。
- 仓库内 **没有任何动作 FBX/glTF/VMD**：24 个 `.fbx` 全是道具/模型（如 `Assets/MATE ENGINE - Props/...`、`Assets/Tools/...`），没有一个是 `PET_*`/`HUS_*` 动画。

**AssetBundle 里是什么**：`AssetBundles/dragging_animation.manifest` 明确写着构建源是 `Assets/__TempBuild/PET_DRAGGING_MOD.anim`（Unity 6000.0.23f1 构建，UnityFS 包）。也就是说 **AssetBundle 里的动画还是同一个 humanoid clip**，用 AssetStudio/AssetRipper 解包后仍是 `.anim`，并不能绕开格式问题。

### 2.3 可参考的状态机（我们的 B1/B3 可对照）

`Assets/MATE ENGINE - Animations/AvatarAnimatorController.controller` 实测：

- **3 层**：`Base Layer`（L1216）、`Face Layer`（L1228）、`Speak Layer`（L1240）。
- **17 个参数**（L1112–L1213）：`isIdle`、`isDragging`、`isDancing`、`Blend`、`IdleIndex`、`HoverTrigger`、`isSitting`、`HoverFaceTrigger`、`DanceIndex`、`isWindowSit`、`isBigScreen`、`isBigScreenSaver`、`isBigScreenAlarm`、`WindowSitIndex`、`IsSleeping`、`BigScreenBlend`、`isTalking`。
- **状态**（部分，行号）：`Idle`(L185)、`HoverReaction`(L217)、`Cry`(L346)、`Big Screen`(L422)、`Happy`(L452)、`Alarm`(L478)、`Sitting`(L706)、`HoverFace`(L1033)、`Intro`(L1555)、`WindowSit`(L1653)、`Fear`(L1730)、`Drag`(L1756)、`PET_TALKING`(L1858)、`Dance`(L2165)、`Sleeping`(L2194)、`Talk`(L2222)、`Screen Saver`(L2332)、`None`(L2305)。
- 这正对应 `PLAN.md` §11.1 想借的「姿态/状态清单」；`docs/anim-reference.md` 已把 109 个非舞蹈片段映射到 B3 姿态，本轮不再重复，只补充**时长/采样率/静态 pose** 三类新证据（上表）。

### 2.4 许可证原文要点（能不能本地用）

来源：`LICENSE.md`（commit `2c5ea6b`）。

| 条款 | 原文要点 | 对我们的含义 |
|---|---|---|
| 代码许可（L1） | `MateEngine Pro License (v2.1)`：允许私下使用/研究/修改；修改或衍生作品须以同许可证公开源码；**禁止商业化**（L39–41：`Commercial use ... strictly prohibited`）；分发只能发布在开源代码托管平台 | 我们**不需要**其代码，不受影响 |
| 资产许可（L78–L92） | 「All assets included in this project, including ... **animations** ... are © 2025 **Shiny** and are strictly COPYRIGHTED.」；`NOT licensed for commercial use in any form`；`You may NOT use them in commercial projects, redistribute them separately, or resell them`；`Personal, educational, or non-commercial use is allowed, but attribution to the original author ("Shiny") is required.` | **本地个人非商用 + 署名 Shiny = 允许**；**不得把动画或转换产物单独再分发**；与「本项目因模型授权不公开/不分发」现状一致 |
| 注意 | README 首部写 `App License: Mixed — GNU AGPL v3 & MateProv2 License`，与 `LICENSE.md` 标题 `MateEngine Pro License (v2.1)` 口径略有出入 | 保守按更严格者理解；反正我们只取**资产**且仅本地个人用 |

> 合规建议：若采用转换后的动作数据，在 `CREDITS`/README 的「致谢」里写明 `Animations © 2025 Shiny (Mate-Engine)`，并在 `.gitignore` 层面保证转换产物不进入任何公开分发物；商业用途需另行取得作者书面许可。

### 2.5 转换路线调研：`Unity humanoid .anim` → 骨骼关键帧/FBX/glTF

#### (a) 纯离线开源解码：本次检索未发现可用方案

- `.anim` 的骨骼数据是 **muscle 值**（`RootT/RootQ/...`），要和具体 Humanoid Avatar 的肌肉轴/限角结合才能反算骨骼旋转；这套映射在 **Unity 运行时内部**，官方只暴露 `HumanPoseHandler`/`AvatarBuilder` 等 Unity API，不在开源代码里。
- 本次检索到的相关工具全部是 **Unity 内工具**：
  - Unity 官方 `HumanPoseHandler` / `AvatarBuilder.BuildHumanAvatar`（[Unity Scripting API](https://docs.unity3d.com/ScriptReference/HumanPoseHandler.html)、[AvatarBuilder](https://docs.unity3d.com/ScriptReference/AvatarBuilder.BuildHumanAvatar.html)）；
  - 第三方 [elvneko/HumanPoseUtility](https://github.com/elvneko/HumanPoseUtility)（HumanPose 的 JSON 导入/导出，**Unity 包**，解决的是「pose」不是「muscle clip 批量转骨骼」）。
- AssetStudio/AssetRipper 一类工具能把 AssetBundle 解成 `.anim`，**但解完还是 humanoid clip**，仍需 Unity 重定向。
- **判定：想转就必须装 Unity，不存在「纯 Node/Python 离线解码」的现成便宜路线。**

#### (b) 推荐路线：Unity 烘焙成「每帧骨骼 JSON」，再在 TS 里重定向到 PMX（约 3–5 人日）

要点：**不需要打开 Mate-Engine 整个工程**（它有 1 万文件 + 一堆第三方包，首次导入极慢）。`.anim` 是自包含 YAML，直接拷进一个**全新空 Unity 工程**即可导入；body clip 只引用 `classID:95`，不依赖任何自定义脚本（只有 9 个 blendshape 片段引用 `UniversalBlendshapes` 脚本，缺脚本只是警告，且我们主要不需要它们）。

推荐流程：

1. **装 Unity**（Personal 免费，需 Unity ID 登录激活；建议 Unity 6 LTS 或 2022.3 LTS，Apple Silicon 原生）。估算：Hub+Editor 下载/安装约 1 小时、数 GB 磁盘（以官方下载页为准）。
2. 新建空工程 → 把 128 个 `.anim` 拷入 `Assets/MateAnim/`（不拷 `.meta` 也可，让 Unity 重新生成）。
3. 用 `AvatarBuilder.BuildHumanAvatar(GameObject, HumanDescription)` **程序化创建一个 humanoid 假人**（只需 20 根骨骼：Hips/Spine/Chest/Neck/Head/Shoulders/UpperArms/LowerArms/Hands/UpperLegs/LowerLegs/Feet/Toes），给它挂 `Animator`。
4. Editor 脚本（约 150–250 行）遍历每个 `AnimationClip`：`PlayableGraph.Create()` + `AnimationClipPlayable`，按 30fps（或 60fps）`graph.Evaluate(dt)` 逐帧采样，把每根骨骼的 `localRotation/localPosition` 写成 JSON；输出形如
   `{clip, fps, frames, bones:{Hips:{q:[[x,y,z,w]...], t:[[x,y,z]...]}, ...}}`。
   - 体积估算：30 个片段 × 60fps × 55 骨 × 平均 6s ≈ 60 万四元数；json 约 20–40 MB。可只保留 20 根 MMD 会用到的骨、30fps、并剔除恒等帧，压到 5 MB 级。
5. **TS 重定向**（不依赖 Unity）：把 Unity humanoid 骨名映射到本模型骨骼（`Hips→センター`、`Spine→上半身`、`Chest→上半身2`、`Neck→首`、`Head→頭`、`LeftUpperArm→左腕`、`LeftLowerArm→左ひじ`、`LeftHand→左手首`、`LeftUpperLeg→左足`、`LeftLowerLeg→左ひざ`、`LeftFoot→左足首`、`LeftToes→左つま先`…），按 **rest-pose 相对旋转**重定向：
   `q_target = q_rest_target · (q_rest_source⁻¹ · q_anim_source)`，根位移按身高比缩放（模型高 21.681 单位；可用 8.93 的センター高度或包围盒比值算比例），并把坐标 handness 转换做一次单测锁定。
6. 挂进现有 B3 的「分层姿态混合」：新增 `ClipLayer`（内部只输出 per-bone quat），与 `AnimationSystem` 混合；**与 `MMDAnimationHelper` 互斥**（`docs/anim-tech-survey.md` §2.5 已论证：加 VMD 后 helper 每帧会覆盖所有骨）。
7. 质量验收：每片段正/侧/45° 三视图 + 实机 10 秒；重点看足部贴地/滑步、手型、坐窗高度。

**高保真变体（可选，+0.5–1 人日）**：不在假人上采样，而是**先把 PMX 放进 Unity**，再在真实骨架上采样：
- 开源 [CandidumGames/UnityMMDTools (UMT)](https://github.com/CandidumGames/UnityMMDTools)（**MIT**，Unity 2022.3+，支持 PMX 2.0 导入、**可选生成 humanoid Avatar**、VMD→AnimationClip）；
- 注意其 README 的 TODO 写明「iOS, Mac OS and Linux support」未提供预编译插件（物理求解需要原生插件），但**只做「导入模型 + 生成 humanoid Avatar + 采样 Unity Animator」不需要物理**，macOS 上大概率可行（需实机验证）。
- 好处：直接在 PMX 骨架上读出 MMD 骨名对应的局部旋转，**省掉 TS 重定向的 rest 校正风险**。

**备选：官方 FBX Exporter 路线（不推荐）**：Unity 官方 [com.unity.formats.fbx](https://github.com/needle-mirror/com.unity.formats.fbx) 可以把 Unity 动画导 FBX，但之后还要在 Blender 里对 MMD 骨架做重定向（MMD Tools 无「FBX→MMD 骨架」一键，需要约束/烘焙），步骤比 JSON 采样多 2 步且更难自动化，故不选。

#### (c) AssetBundles 路线

- 结论同上：`dragging_animation` 等 AssetBundle 里是同一个 humanoid clip；解包只改变容器，不改变格式，仍需 Unity。**没有价值**。

#### (d) Steam Workshop / 社区是否已有导出的 FBX/MMD 版本？

- 仓库内没有；本次检索也**未发现** Mate-Engine 动画的公开 FBX/glTF/MMD 导出。
- 社区工具走的是**反方向**：
  - [maoxig/MateEngine-CustomDancePlayer](https://github.com/maoxig/MateEngine-CustomDancePlayer)：Mate-Engine 的 BepInEx 舞蹈播放 Mod，支持 `.unity3d`、`.me`、**`.vmd`、`.vmdance`**（VMD 连表情/口型/相机一起播）；
  - [maoxig/UnityMMDConverter](https://github.com/maoxig/UnityMMDConverter)：在 Unity 里把 **VMD → `.anim`**（基于 MMD4Mecanim）并打包 `.unity3d`，README 提到约 300 个已转换舞曲。
  - 这说明「MMD VMD 是 Mate-Engine 生态自己也认的动作来源」，但它**不产出 Mate-Engine 官方动画的导出**。
- 结论：**不能指望 Workshop 里现成有 FBX/MMD 版**；要么自己转，要么直接用 VMD。

#### (e) 是否有 Mate-Engine Web/Linux 移植版可复用？

- **Linux 移植存在**（非官方）：[Marksonthegamer/Mate-Engine-Linux-Port](https://github.com/Marksonthegamer/Mate-Engine-Linux-Port)。实测 README：Unity **6000.2.6f2** 构建、删掉 Steam API/UniWindowController、**Mod 不能正常加载**、维护暂停（2026-09-01 → 2027-06）。它是「能跑 Mate-Engine 的 Linux 构建」，对**提取动画**没有帮助。
- **未发现 Web/WebGL 移植版**；本项目是 macOS Electron，也不需要它。

#### (f) 结论：值不值得为 128 个动画装 Unity？

| 问题 | 结论 |
|---|---|
| 技术上可行吗？ | **可行**。纯采样不需要 Mate-Engine 工程；`AvatarBuilder + PlayableGraph` 是 Unity 官方能力，输出 JSON 后 three 侧只做重定向 |
| 值不值得为**全部 128 个**装？ | **不值得**。①17 个舞蹈已被用户排除；②15 个 `HUS_*` 男角色片段（11 idle/drag/sitting + 4 舞蹈）基本用不上，5 个大屏/屏保、3 个 U_MOTIONS 也基本用不上；③10 个坐姿是静态 pose；④表情层 9 个是 blendshape。真正值得的是 **约 25–35 个**（待机 6–8、走路 2、坐姿/窗沿 6–8、拖拽/开心/害羞 4、睡觉 1、躲藏 2、入场 2、说话 1） |
| 值得为**目标子集**装吗？ | **值得，但有前提**：先跑通「VMD/VPD 原生路线」（§7 路线 A）看观感是否达标；若窗口坐/摸头/躲藏这类**宠物专属动作**仍缺，再启动本路线（§7 路线 B） |
| 工作量估计 | 固定成本：Unity 安装+激活 0.5–1 人日；烘焙脚本 0.5–1 人日；TS 重定向+单测 1–2 人日；30 片段质量调优 1–2 人日。**合计约 3–5 人日**（不含 VMD 路线） |
| 主要风险 | ①Unity Personal 激活需账号（自动化 batchmode 也要先激活）；②假人采样→PMX 比例/足滑/手型需调；③如果换用 UMT 真机采样，macOS 支持未验证；④**许可证**：转换产物只能本地个人使用、需署名、绝不能再分发 |

---

## 3. l2dpet（jinsc123654/l2dpet）

### 3.1 仓库事实

| 项 | 实测 |
|---|---|
| 定位 | Live2D 桌面宠物（C++17），可选 LLM/记忆/天气/互动；Windows/Linux 已构建，macOS「提供构建支持，尚未完成实机验证」（README L94/L161） |
| 技术栈 | **Live2D Cubism Native SDK 5-r.5**（需自备官方 SDK；仓库带 Cubism Core 头文件/预编译库）+ EUI-NEO + GLFW/OpenGL；`l2dtest`（桌宠）+ `l2dpet-ui`（面板），本机 `127.0.0.1:23333` JSON Lines 通信 |
| 资产格式 | `.moc3`、`.model3.json`、`motion3.json`、`physics3.json`、`exp3.json`（纯 2D 参数动画） |
| 内置示例模型 | Hiyori（Live2D 官方免费示例，原样未修改）：`live2d/bundled-models/Hiyori/Hiyori.model3.json` L14 `"Idle"` 9 个动作 / L61 `"TapBody"` 1 个动作 |
| 3D 资产 | **无**：全仓库 `find` 无 `.fbx/.glb/.gltf/.pmx/.vmd/.bvh` |

### 3.2 能不能给 PMX 提供动作？

**❌ 不能。** 理由（都是硬事实）：

1. Live2D 的动作是 **2D 参数关键帧**（`motion3.json` 里对 `ParamAngleX` 等参数打帧），驱动的是 Cubism 参数，不是 3D 骨骼；与 PMX 的 382 根骨骼没有任何映射可能。
2. 渲染管线是 Cubism 专用（SoftRenderer/OpenGL），不能加载 PMX。
3. 仓库里**没有任何 3D 动作资产**可复用。

### 3.3 可借鉴的行为调度设计（真正有价值的部分）

| 设计 | 证据（路径:行号） | 可映射到我们 |
|---|---|---|
| **生命状态机**（4 态：醒/困/睡/生闷气）+ 状态迁移由精力/亲密/恼火/寂寞驱动 | `live2d/player/src/L2DPlayer.h` L2530 `enum LifeState { LS_AWAKE, LS_DROWSY, LS_ASLEEP, LS_SULK }`；L2623 `LifeStateKey` | B1 的 mood/activity 可补一层「慢状态机」（睡眠/无聊/兴奋），与一次性行为分开 |
| **连续情绪 VAD 叠加层**（Valence/Arousal/Dominance 带漂移与回落） | `L2DPlayer.h` L2516–2517（`EmotionTick` 注释）；`PlayerLife.cpp` 中 `EmotionTick` 实现（VAD 基线/漂移/衰减） | B3 的表情层可换成「连续情绪场」驱动，而不是离散 mood 直切 |
| **躯体通道（BODY）增量叠加层**：语义通道→模型参数（带系数），叠加在呼吸/视线等自动行为之上，一阶平滑/弹簧 | `L2DPlayer.h` L91–L116（`BodyChannel`）、L567–L595（BODY 注释与建通道）；`PlayerBody.cpp` L43 同注释 | 我们 B3 的「分层权重混合」思路一致；可借「通道名统一 + 模型缺通道自动降级」的跨模型兼容设计 |
| **动作片段（ACTION）以通道空间写关键帧**，手势/演出可叠加，新动作接管同通道时淡出 | `L2DPlayer.h` L122–L146（`ActionClip`/`ActionTrack`，`fadeAt`） | 对应我们后续的 VMD/ClipLayer 与手势叠加：**同通道互斥 + 淡入淡出** |
| **动作槽位**：按 Motion 组随机/优先播放（Idle 组随机；`StartMotionByGroupIndex` priority 3 强占） | `PlayerLife.cpp` L839（`NextRand() % MotionCount(g)`）；`L2DPlayer.h` L430–L442 | 我们的「Idle 变体随机 + 反应动作强占」可直接照此实现 |
| **气泡队列**：排队、最长保持、爆发时丢弃最旧普通台词但保留问题 | `live2d/player/src/PetBubbleQueue.h`（`Hold`/`Offer`/`_pending` 上限 8） | B1 气泡/DSH 反应气泡可对齐这套优先级 |
| **交互刺激累积**：连击 combo、5 秒窗口、衰减、友好度软化 | `live2d/player/src/PetLifeBalance.h` | 摸头/戳脸的冷却与耐受度可参考 |
| **跨模型能力 profile**（Natori/shuflle/yumi 等，模型缺参数时整条通道不建） | `live2d/player/profiles/`；`ModelImport.cpp` | 我们只有 1 个 PMX，暂不需要，但「missingBones 自检」是同一思路 |

### 3.4 许可证要点

| 部分 | 许可 | 对我们要点 |
|---|---|---|
| 自有代码 | **MIT**（`LICENSE` L1） | 若抄代码逻辑需保留版权声明（我们只借鉴设计，不抄代码） |
| Cubism Core / Native SDK | **Live2D 专有许可**（`live2d/3rd/CubismCore/LICENSE.md`：年营收 >1000 万日元需 Cubism SDK Release License） | 与 PMX/three 无关，不使用 |
| 随包 Hiyori 模型 | **Live2D Free Material License**（`live2d/bundled-models/README.md` L9–L15：个人/小规模可用；**不得把素材本身单独再分发**） | 不能拿它的 2D 素材；也没有 3D 素材 |

**判定：❌ 不能给 PMX 提供动作资产；✅ 行为调度设计值得对照借鉴（不抄资产/代码）。**

---

## 4. dsh-live2d-mao（xkk6663/dsh-live2d-mao）

### 4.1 仓库事实

| 项 | 实测 |
|---|---|
| 定位 | 「DSH 专用 Live2D 桌宠」：Electron 桌宠壳 + Vue 管理窗 + FastAPI 后端 + Live2D 渲染；另含 npm 插件 `dsh-live2d-mao`（v1.4.0，只推事件） |
| 平台 | **Windows 10/11 x64 only**（README L142；后端依赖 `dxcam==0.0.5`、`mss==10.2.0`，requirements.txt L13–L14） |
| 技术栈 | Electron + PixiJS + pixi-live2d-display（Cubism 4）+ Vue + FastAPI + WebSocket；`私人AI日记系统/backend/app/kernel/agent_bus_service.py` 为 12 态总线 |
| 资产格式 | Live2D 2D：仓库内 7 个 `.moc3` / 7 个 `.model3.json` / 75 个 `.motion3.json`（`澪Agent应用/dist/live2d-pet/models/`）；**无任何 3D 格式**（无 fbx/pmx/glb） |

### 4.2 能不能给 PMX 提供动作？

**❌ 不能，且本机跑不起来**：

1. 资产是 Live2D 2D 参数动作（`motion3.json`），与 PMX 骨骼无关；
2. 桌宠实现 **Windows-only**（PowerShell 安装脚本、DXCam 抓屏、快速启动项），macOS 无法直接运行（我们不需要运行它，但也不能指望拿它的代码跑）。

### 4.3 可借鉴的调度设计（对 B7 尤其有用）

| 设计 | 证据（路径:行号） | 可映射到我们 |
|---|---|---|
| **12 态 phase 词表**：`idle/planning/thinking/executing_tool/streaming/waiting_input/voice/complete/error/paused/awaiting_approval/heartbeat` | `packages/dsh-live2d-mao/lib/phases.js` L14–L30；后端权威版 `私人AI日记系统/backend/app/kernel/agent_bus_service.py` L47–L60 | 我们 B7 已有类似状态；可对齐「审批态/暂停/心跳」三种 |
| **活跃聚焦优先级**（voice 1 > executing_tool/awaiting_approval 2 > thinking/planning 3 > streaming/waiting 4 > complete/error/paused/heartbeat 5 > idle 6） | `phases.js` L36–L49；`agent_bus_service.py` L63–L76 | B7 的 DSH 状态抢占逻辑可直接对齐（同一时刻只有一个「身体」） |
| **节流/防抖/心跳超时/完成保持**（THROTTLE_MS=300、STALE_MS=8000、HEARTBEAT_TIMEOUT_MS=30000、ACTIVE_HOLD_MS=1500） | `agent_bus_service.py` L79–L89 | 防止 DSH 高频事件刷爆渲染端；值得抄数值思路 |
| **动作槽位绑定 + 正则兜底 + 试听**：每个模型可逐槽位绑定动作组（idle/touch/think/speak/observe/cheerful/concerned/alert/attention/shy），也支持按名字正则猜 | `澪Agent应用/dist/live2d-pet/live2d-pet.js` L21–L31（motionSlots）、L1359（MOTION_SLOT_ALIAS）、L1374（MOTION_SLOT_PATTERNS）、L1388（motionForSlot） | **这正是本项目缺的「动作槽位」概念**：等我们有了 VMD 片段后，可按槽位绑定而不是硬编码 |
| **表情槽位**（2026-10-19 补） | `live2d-pet.js` L196–L263（expressionSlots） | 对应我们的 85 个 morph，可按「自然/开心/认真/温柔/担心/害羞」绑槽位 |
| **三通路解耦**：`agent_phase`（动画/徽标）/`agent_stream`（流式横条）/`agent_bubble`（工具气泡）相互独立 | README §技术架构；`dsh-live2d-mao` 插件只推事件 | 和 PLAN §8 的事件通道设计一致，可复核我们的 `onDshEvent` 分层是否足够 |

### 4.4 许可证要点

| 部分 | 许可 | 要点 |
|---|---|---|
| 代码 | **MIT**（`LICENSE` L1；`packages/dsh-live2d-mao/package.json` L3 v1.4.0 + `license: MIT`） | 可借鉴/复用代码，保留版权声明 |
| 内置模型 | 各自许可：大肥鱼「免费公皮，**非商业**，禁止盗用与出售」；DS 鲸鱼娘 **CC BY-NC-SA 4.0**（署名·非商业·相同方式共享）；Live2D 官方 6 款为免费示例模型 | **资产不可复用**；moc3/动作绑定不能给 PMX |
| 运行时 | Live2D Cubism Core 专有 | 与 PMX 无关 |

**判定：❌ 不能给 PMX 提供动作；✅ 12 态总线/槽位绑定/优先级设计值得对照（B7 已有可再对齐）。**

---

## 5. dsh-blender-plugin（sixtysevenlf/dsh-blender-plugin）

### 5.1 仓库事实

| 项 | 实测 |
|---|---|
| 定位 | **DSH 宿主插件**（不是独立 Blender 插件）：DSH → 工具 → backend HTTP（`127.0.0.1:9877`）→ Blender addon（`127.0.0.1:9876`）→ `bpy` |
| 版本 | `package.json` L3 `"version": "3.0.6"`；npm registry 实测 `npm view dsh-blender-plugin version` → **3.0.6**，`license` → **BSD-3-Clause** |
| 许可 | **BSD-3-Clause**（`LICENSE` L1–L3，Copyright (c) 2026, sixtyseven67）；bundled modeling skill 为 MIT；Blender 商标归 Blender Foundation |
| 依赖 | Node **≥24.9.0**（engines）；peerDeps：`@deepseek-ai/cordis >=4.0.0-rc <5`、`@deepseek-ai/dsh-tools >=0.0.1-rc <2`、`@deepseek-ai/dsh-llm`、`schemastery`/`cordis` |
| 规模（官方口径） | **15 个模型工具、34 个 plan family / 228 个 op、38 个 addon 命令（+ping = 39 wire commands）、29 条 HTTP 路由、protocol 11**（`docs/architecture.md` L26 与 L171 明确写死） |

### 5.2 15 个工具（源码逐一核对）

| # | 工具 | 作用 | 证据 |
|---|---|---|---|
| 1 | `blender_rt_see` | 出视口/自定义视角帧（约 55–160ms）；`from`/`look_at` 自建矩阵离屏，**不建相机不改视口**；GUI 不在时自动降级到无头 worker 的 Workbench 离屏 | `src/tools/see/register.ts` L11、L30–L63 |
| 2 | `blender_rt_do` | 在 Blender 持久内核里跑 Python，可顺带返回一帧 | `src/tools/do/register.ts` L11 |
| 3 | `blender_rt_watch` | 采样时间窗/帧区间，报告画面是否变化 | `src/tools/watch/register.ts` L13 |
| 4 | `blender_rt_worker` | 常驻 `blender -b` 热会话：start/exec/see/watch/reset/status/stop/restart/list；`op=see` 支持 `from/look_at/lens/ortho/view_size` | `src/tools/worker/register.ts` L11–L44 |
| 5 | `blender_rt_plan` | 34 family/228 op 的契约层（catalog/判定/验收/造型/装配/白模/导出） | `src/plan/tool.ts` L17；`runtime/catalog/data.ts` |
| 6 | `blender_viewport` | 通道健康、doctor、launch、写租约 | `src/tools/viewport/register.ts` L10 |
| 7 | `blender_rt_headless` | 一次性 `blender -b` 跑脚本（可多视角 `shots`、attach_images、as_job） | `src/tools/headless/register.ts` L11 |
| 8 | `blender_rt_job` | 长任务后台作业层 | `src/tools/job/register.ts` L11 |
| 9 | `blender_rt_loop` | 参数搜索循环 | `src/tools/loop/register.ts` L13 |
| 10 | `blender_rt_txn` | 文件级快照 / 对象级 mark 回滚 | `src/tools/txn/register.ts` L13 |
| 11 | `blender_rt_preset` | 参数预设保存/列表/应用/导出 | `src/tools/preset/register.ts` L13 |
| 12 | `blender_rt_perf` | 渲染性能诊断/预设 | `src/tools/perf.ts` L16 |
| 13 | `blender_rt_opt` | 安全合并对象降开销 | `src/tools/opt.ts` L16 |
| 14 | `blender_rt_cmd` | 直接调用任意 addon 命令 | `src/tools/cmd.ts` L16 |
| 15 | `blender_rt_commands` | 列出 addon 命令（**19 常驻 + 15 集成门控**）与集成状态 | `src/tools/commands.ts` L18 |

### 5.3 addon 命令注册表（38 个，可当 bpy 快捷入口）

- `addon/dsh_blender_bridge/command_registry.py` L1–L30 定义「38 registered commands / 39 wire commands」，L69 注释为「22 base + 16 gated」；L93 有 **`export_scene`**（参数 `filepath, format, object_names, selection_only, apply_modifiers`）。<br>（注：`blender_rt_commands` 工具描述里的「19 常驻 + 15 集成门控」与 registry 的 22+16 口径不一致，**以 registry 的 38 为准**，工具描述可能是旧文案。）
- 命令实现：`addon/dsh_blender_bridge/commands/scene/export.py` L8 `def export_scene(...)`，支持 **GLB / FBX**（GLB 带材质/蒙皮/形态键/动画；FBX 作为 Unity 内置导入器的 fallback）。
- 38 个命令分 6 组：base（22 个，含 `get_scene_info`/`execute_code`/`get_viewport_screenshot`/`export_scene`…）、polyhaven、hyper3d、sketchfab、polypizza、hunyuan 等门控集成（`command_registry.py` L60 起）。
- **注意：没有 PMX/MMD/VMD/VPD 专用命令**——唯一出现 `mmd_tools` 的地方是 `commands/scene/world.py` L21 的注释：提醒第三方扩展（如 mmd_tools）会装 F-curve 兼容 shim，所以不能用 `hasattr(action,"fcurves")` 判断 Blender 版本。这说明作者知道 MMD Tools 生态存在，但插件**不自带** MMD 能力。

### 5.4 关键问题：能否支撑「加载 PMX → 摆骨 → 三视图渲染 → 导出 VPD/FBX → 无头 worker」回路？

| 回路环节 | 结论 | 证据/说明 |
|---|---|---|
| 加载 PMX | **✅ 能（需另装 MMD Tools）** | 插件用 `blender_rt_do`/`worker op=exec`/`headless script` 跑任意 `bpy`；Blender [MMD Tools](https://github.com/MMD-Blender/blender_mmd_tools)（**GPLv3**，Blender 4.2–5.2，**import/export pmx/vmd/vpd**）提供 PMX 导入/姿态导出 operator（如 `bpy.ops.mmd_tools.import_model`，具体名称以所装版本为准） |
| 摆骨骼 | **✅ 能** | `blender_rt_do` 持久内核跑 Python 直接写 `pose_bone.rotation_quaternion`；`rt_txn` 可快照回滚；`rt_watch`/`see` 实时回看 |
| 渲染正/侧/45° | **✅ 能** | `blender_rt_see` 的 `from`/`look_at`（世界坐标）+ `lens`/`ortho`/`ortho_scale`/`view_size`/`shading`，可自定义任意机位离屏出图；`blender_rt_headless` 的 `shots` 支持一次多视角；无头 worker `op=see` 同样支持 `from/look_at` |
| 导出 VPD | **✅ 能（经 MMD Tools，需实机验证 operator 名）** | 插件本身无 VPD 命令；MMD Tools README 明确「Exporting ... pose data (.vpd) are supported」；用 `blender_rt_cmd`/`rt_do` 调其 operator 即可。具体 operator 名以所装 MMD Tools 版本为准，**本次未实机验证** |
| 导出 FBX/GLB | **✅ 能（内置）** | addon `export_scene`（GLB/FBX）见上；plan catalog 亦有 export 系列 op |
| 无头 worker | **✅ 设计支持，未实机验证** | `blender_rt_worker`（常驻 `blender -b`，`see` 出 Workbench 离屏帧）+ `blender_rt_headless`（一次性）；README L67/L145–L146 给出无头验收：`worker start` + `see` 能回帧即通过；`runtime/blender-detect.ts` L229–L244 已支持 macOS `.app` 探测，`docs/配置参考.md` L85 给出 macOS Blender 路径 |

**结论：✅ 可以作为「可视化调参/渲染回路」直接使用，但它只是**工具**，动作数据仍要另外找（PMX 载入/姿势/导出能力来自 Blender MMD Tools，不是插件自带）。

### 5.5 安装与版本门槛（如实说明）

- **npm 安装**（官方支持路径）：`dsh plugin --profile <profile> add dsh-blender-plugin@3.0.6`（DSH Web/TUI 需重启；DSH Desktop 在 Plugins 页装 bundle 不用重启）。仓库也给了源码构建路径（`npm run setup:dev && npm run build`）。
- **Blender 版本**：README L39：**Blender 4.2 LTS 是测试版本**；4.x 可能可用；**Blender 5.x 未验证**。GUI 模式必须先装仓库自带的 `addon/dsh_blender_bridge.zip`（唯一受支持的桥，占 9876 端口；与 MCP-for-Blender 类插件冲突需停用）。
- **本机现状**：未安装 Blender（`/Applications` 无 Blender/Unity；无 brew）。Blender 4.2 LTS 安装包约数百 MB，MMD Tools 通过 Blender「Get Extensions」在线安装（需开 `Allow Online Access`）。
- **DSH 宿主兼容**：插件 peerDeps 要求 `@deepseek-ai/cordis >=4.0.0-rc <5` 等；本机 DSH app 版本 **0.2.2-rc.1**。**本次未实装验证**（避免改动共享 profile 影响并行队友）；Lead 若要用，建议在独立 profile 安装并跑官方验收：GUI 路线 `curl 127.0.0.1:9877/doctor` → `kind=ok`；无头路线 `worker op=start` + `op=see` 回帧。
- **导入本模型注意**：模型 85 个 morph 中材质 morph（`照れ` 等）和带尾随空格的名称（`星目 `）需要 MMD Tools 导入后按名精确处理；PMX 2.0 支持 MMD Tools 已有；`assets/model/**` 只读，建议在 `/tmp` 或 `tests/tmp/` 复制副本操作（注意模型授权，不得提交）。

---

## 6. 横向对比：我们到底能拿到什么？

| 需求 | Mate-Engine | l2dpet | dsh-blender-plugin | dsh-live2d-mao | 结论 |
|---|---|---|---|---|---|
| 可直接播放的 PMX 动作（VMD/VPD） | ❌ | ❌ | ❌（工具） | ❌ | **4 仓库都没有** |
| 可转换的动作数据（本地个人用） | ✅ `.anim` → 需 Unity | ❌ | ❌ | ❌ | Mate-Engine 独家 |
| 动作/姿态清单参考 | ✅ 128 个（时长/fps/循环已实测） | ◐ 设计参考 | ❌ | ◐ 12 态语义 | 已有 docs/anim-reference.md |
| 行为/状态调度设计 | ✅ 3 层 Animator + 17 参数 | ✅ 生命状态机/通道/槽位/气泡 | ❌ | ✅ 12 态总线/优先级/槽位 | 可对照 B1/B3/B7 |
| 可视化调参工具 | ❌（其代码是 Unity，不能拆） | ❌ | ✅（需 Blender+MMD Tools） | ❌ | 唯一工具项 |
| 许可证允许本地个人用 | ✅ 资产（需署名、不可分发） | ✅ 设计；资产另行 | ✅ BSD-3 | ✅ 代码 MIT；资产不可 | 合规可行 |
| macOS 可用 | ◐ 仓库可读；Unity 需装（macOS 版可） | ◐ C++ 可构建（未验证） | ✅ 宿主插件跨平台（Blender 需装） | ❌ Windows-only | 工具链以 dsh-blender-plugin 为主 |

### 6.1 可直接复用清单（按优先级）

1. **✅ 工具链（可直接上手）**：`dsh-blender-plugin` v3.0.6（BSD-3）→ 驱动 Blender 4.2 LTS + MMD Tools，实现「加载 PMX / 摆骨 / 正侧 45° 渲染 / 导出 VPD / 无头 worker」。**这是解决「盲调」根因的现实手段。**
2. **✅ 设计参考（可借鉴，不抄资产）**：l2dpet 的四层调度（生命状态机 / VAD 连续情绪 / 躯体通道 / 动作槽位 / 气泡队列）+ dsh-live2d-mao 的 12 态总线和槽位绑定。
3. **✅ 动作参考（只读清单）**：Mate-Engine 128 个片段的分类/时长/采样率/循环/静态 pose（本轮已全量实测，见 `mate-engine-anim-summary.md`）；**不要**把 `.anim` 直接拷进本项目仓库。
4. **◐ 动作数据（需转换 + 仅本地个人用）**：Mate-Engine 子集 → Unity 烘焙 → JSON → TS 重定向（§2.5）。
5. **❌ 现成的 3D 动作包**：4 个仓库都没有。需要外部获取（§7 路线 A/D）。

### 6.2 工作量汇总（估算，含依据）

| 路线 | 内容 | 估算 | 风险 |
|---|---|---|---|
| A. MMD VMD/VPD 原生 | 找授权动作包 + `MMDLoader`/`loadVPD` 接入 + 互斥开关 | **0.5–1.5 人日**（不含找素材/谈授权时间） | 宠物专属动作少；授权逐个确认 |
| B. Unity 烘焙 Mate-Engine 子集 | Unity 安装/烘焙脚本/TS 重定向/质量调 | **3–5 人日**（30 片段以内） | 比例/足滑/手型；Unity 账号激活 |
| C. Blender 可视化调参回路 | Blender 4.2 + MMD Tools + dsh-blender-plugin + 三视图截图流程 | **0.5–1 人日** | 需实机验证 MMD Tools 无头导入/导出 VPD |
| D. VRMA（glTF 动画）离线重定向 | 解析 VRMA humanoid 四元数 → MMD 骨骼（无需 Unity） | **0.5–1 人日**（若素材可用） | 免费/授权 VRMA 多以 idle/舞蹈为主，宠物专属仍缺 |
| E. 继续纯程序化调参 | 已被用户否决 | 不可取 | 收益递减（PLAN §20.7） |

---

## 7. 推荐下一步（Wave 2.5「动作参考与姿态重做」）

> 原则：先「**拿现成动作**」、再「**可视化调参**」、最后才「**重定向/自研**」；不再以数值自证通过。

### 路线 A（先做，0.5–1.5 人日）：MMD 原生 VMD/VPD

- **VPD 静态姿态**（最快解决「姿态僵硬/手像鸡爪」）：`three r171` 的 `MMDLoader.loadVPD` + `MMDAnimationHelper.pose` 原生可用（`docs/anim-tech-survey.md` D5 已评估）；先给「站/坐/窗沿坐/手部放松」各找 1–2 个 VPD，或由 Blender 摆好后导出 VPD。
- **VMD 循环动作**（待机/走路）：`MMDLoader` 原生支持 VMD + `AnimationMixer`；适合补「呼吸/待机/走路循环」。
- **注意互斥**：一旦挂 VMD，`MMDAnimationHelper` 每帧会 `_restoreBones` + IK/grant 覆盖所有骨骼（`docs/anim-tech-survey.md` §2.5 源码级结论）；必须与 B3 的骨骼写入二选一（互斥开关）。
- **授权**：逐个动作确认作者条款（BowlRoll / ニコニ・コモンズ / BOOTH / 模之屋 / MMD 配布页）；与模型一样「不公开/不分发」，只本地使用；记录作者/来源到 CREDITS。

### 路线 B（A 不达标时启动，3–5 人日）：Unity 烘焙 Mate-Engine 子集

- 只选 **25–35 个**片段：待机 6–8、走路 2、坐/窗沿 6–8、拖拽/开心/害羞 4、睡觉 1、躲藏 2、入场 2、说话 1（清晰清单见 `docs/anim-reference.md` + 本轮实测时长表）。
- 产物：每帧骨骼 JSON（不入库）+ TS 侧 `ClipLayer` 重定向；**仅在本地个人使用，署名 Shiny，绝不再分发**。
- 与路线 A 的取舍：VMD 能覆盖的（待机/走路）不要重复烘焙；Mate-Engine 独有价值在**窗口坐/躲藏/拖拽/摸头**等宠物专属片段。

### 路线 C（与 A/B 并行，0.5–1 人日）：可视化调参回路（dsh-blender-plugin）

- 装 Blender 4.2 LTS + MMD Tools（Blender 扩展）+ `dsh-blender-plugin@3.0.6`（独立 DSH profile 验收 `doctor kind=ok`）。
- 固化一套脚本（放 `scripts/anim-pipeline/**`，该目录已有并行任务在动，注意协调）：载入 PMX → 按姿态表摆骨 → `rt_see` 出正/侧/45° 三图 → `rt_watch` 比对 → MMD Tools 导出 VPD → 回灌 three。
- 这一步直接对症 PLAN §20.7 的根因判断（「缺少可视化调参工具」）。

### 路线 D（可选补充，0.5–1 人日）：VRMA 等 glTF 动画离线重定向

- [VRMC_vrm_animation 1.0 规范](https://github.com/vrm-c/vrm-specification/tree/master/specification/VRMC_vrm_animation-1.0)：动画是**普通 glTF 四元数关键帧**（humanoid 骨名，T-pose rest，仅 Hips 有位移），**不需要 Unity 就能解析**；用 Node 读取后按 rest 差重定向到 MMD 骨骼（与路线 B 的 TS 重定向器复用）。
- 素材：BOOTH 等有免费/限期免费 `.vrma` 包（如 [福猫堂 .vrma 詰め合わせ](https://booth.pm/ja/items/8944977)，授权需逐个确认）；以 idle/舞蹈为主，宠物专属动作仍缺。
- 价值：如果只想快速补「呼吸/待机/走路」，这是 **0 Unity 成本**的路；可与 A 并行试。

### 验收方式（沿用 PLAN §20.7）

- 每个姿态/动作：**正/侧/45° 三视图截图** + 用户实机 10 秒观察；
- 不再用「数值有变化/自动化指标通过」当验收；
- 所有外部动作/素材进入 CREDITS 并标注许可证。

---

## 8. 许可证与合规总表

| 对象 | 许可证原文要点 | 我们能做什么 | 必须做什么 / 禁止 |
|---|---|---|---|
| Mate-Engine 代码 | MateEngine Pro License v2.1：非商业、copyleft、仅开源平台分发 | 不需要其代码 | 不用即可 |
| Mate-Engine 动画资产（含 `.anim`） | `ASSETS ... © 2025 Shiny ... NOT licensed for commercial use ... may NOT ... redistribute them separately ... Personal, educational, or non-commercial use is allowed, but attribution ... required`（`LICENSE.md` L78–L92） | 本地个人非商用；可转换后在本项目本地使用 | 署名 Shiny；**不得再分发**（含格式转换产物、AssetBundle、烘焙 JSON）；商业需作者书面许可 |
| l2dpet 代码 | MIT | 可借鉴设计/代码（保留版权声明） | Cubism Core/SDK 另行；Hiyori 模型不得单独再分发 |
| l2dpet 的 Hiyori 资产 | Live2D Free Material License | 不可用于本项目（且是 2D） | 不得单独再分发 |
| dsh-blender-plugin | BSD-3-Clause | 可安装/使用/修改/再分发（保留版权与免责声明） | 保留 copyright/disclaimer；不得用作者名义背书 |
| Blender MMD Tools | GPLv3 | 本地安装为 Blender 扩展使用（工具，不并入我们的 App 代码） | 若把其代码打包进分发物需遵守 GPLv3；本地工具链不涉及 |
| dsh-live2d-mao 代码 | MIT | 可借鉴/复用（保留版权） | 内置模型各自许可（大肥鱼非商业、DS 鲸鱼娘 CC BY-NC-SA 4.0、Live2D 官方示例）不可混用 |
| 本项目模型 | 用户自备、禁止二次配布（PLAN） | 本地渲染/截图 | 不入库、不公开、不分发 |

**总原则**：本项目不公开仓库、不分发模型/动画资产；所有外部动作仅本地个人非商用，逐项署名并记录来源。

---

## 9. 未验证项、风险与诚实声明

1. **Unity / Blender 均未安装**：§2.5 路线 B 和 §5 路线 C 的所有「能跑」结论均为**静态证据 + 官方文档/验收口径**，**未经本机实机验证**；工作量是工程经验估算（±50%）。
2. **Mate-Engine 动画未实际在 Unity 中导入过**：`serializedVersion: 7` 的 2022+ 片段理论上可被 Unity 6 导入，但「拷贝到新工程即可」需首次实跑确认（尤其是 9 个 blendshape 片段缺脚本）。
3. **未审计 Steam Workshop 实际内容**（需登录/客户端）：Workshop Mod 是 AssetBundle 格式、仍是 humanoid clip 的结论来自其 SDK/Mod 导出代码（`ModExporterWindow.cs`）与社区文档，**未逐个开箱验证**。
4. **外部资料抓取限制**：`api.github.com` 配额耗尽；Steam 新闻页与 `stereoarts.jp` 直连抓取失败；`docs/anim-reference.md` 之前用 Trees API 抓的文件树本报告未重复（其数量 128 与本轮 git 实测一致，可信）。
5. **MMD Tools 的 VPD 导出 operator 名未核实**：本报告只确认其 README 声明支持 `.vpd` 导入/导出；实机需跑 `bpy.ops.mmd_tools.*` 确认。
6. **Mate-Engine 资产权属细节**：`LICENSE.md` 声明全部资产 © Shiny，但个别片段命名（`HUS_*`、`walk_cycle_sexy_*`）可能来自第三方/付费资产源；严格复用前建议向作者确认或只取明确属于官方的片段。
7. **Unity Personal 授权**：免费但需 Unity ID 登录激活（batchmode 亦需先激活）；商业用途限制以 Unity 官方条款为准。
8. **重定向质量**：humanoid→MMD 是「近似重定向」，比例/足滑/手型需按本模型（A-pose、脚踝 1.229/膝 6.784/髋 12.234 单位）实测调参；不做过度承诺。

---

## 10. 附录

### A. Mate-Engine 128 个动画完整清单

见 `tests/tmp/repo-audit/mate-engine-anim-manifest.csv`（128 行，含分类/文件名/时长/fps/loop/曲线类型/关键帧数/字节数/sha1）与 `tests/tmp/repo-audit/mate-engine-anim-summary.md`（分类汇总 + 静态 pose 清单 + YAML 行号）。与 B3 姿态的映射仍以 `docs/anim-reference.md` 为准（109 个非舞蹈片段，已排除舞蹈 19 个）。

### B. 关键证据索引（仓库内路径:行号 / 外部链接）

**Mate-Engine**（commit `2c5ea6b`）：
- `ProjectSettings/ProjectVersion.txt`（Unity 6000.2.6f2）
- `Assets/MATE ENGINE - Animations/PET_IDLE/PET_IDLE.anim` L117/L378/L17088（muscle 曲线与 sampleRate/stopTime）
- `Assets/MATE ENGINE - Animations/AvatarAnimatorController.controller` L1112–L1214（参数）、L1216/L1228/L1240（3 层）、L185/L422/L706/L1653/L2194 等（状态）
- `Assets/MATE ENGINE - Animations/FACE_LAYER/*.anim`（9 个 blendshape 片段，引用 `UniversalBlendshapes.cs.meta`）
- `AssetBundles/dragging_animation.manifest`（`Assets/__TempBuild/PET_DRAGGING_MOD.anim`）
- `LICENSE.md` L1、L39–L41、L44–L46、L78–L92
- `README.md` L2（Linux 移植）、L140（「MMD Music Animation Player」只出现在功能对比表）
- 实测汇总：`tests/tmp/repo-audit/mate-engine-anim-summary.md`

**l2dpet**（commit `c8a7bbc`）：
- `live2d/player/src/L2DPlayer.h` L91–L146（BodyChannel/ActionTrack）、L430–L442（StartMotionByGroupIndex）、L567–L595（BODY 层）、L2516–L2517（EmotionTick）、L2530（LifeState）
- `live2d/player/src/PlayerLife.cpp` L839（随机动作组）
- `live2d/player/src/PlayerBody.cpp` L2/L43
- `live2d/player/src/PetBubbleQueue.h`（气泡队列）
- `live2d/player/src/PetLifeBalance.h`（触摸 combo/衰减）
- `live2d/bundled-models/Hiyori/Hiyori.model3.json` L14/L61；`live2d/bundled-models/README.md` L9–L15
- `LICENSE` L1（MIT）；`live2d/3rd/CubismCore/LICENSE.md`；README L94/L161（macOS 未实机验证）

**dsh-blender-plugin**（commit `5904cf8`）：
- `package.json` L3（v3.0.6）、L53（BSD-3-Clause）、engines/peerDeps
- `LICENSE` L1–L3
- `README.md` L39（Blender 4.2 LTS）、L152（15 工具）、L158–L192（工具表）、L67/L145–L146（无头验收）
- `src/tools/see/register.ts` L11/L30–L63（自定义视角）；`src/tools/worker/register.ts` L11–L44；`src/tools/headless/register.ts` L11；`src/tools/commands.ts` L18
- `addon/dsh_blender_bridge/command_registry.py` L17–L30、L93（export_scene）；`commands/scene/export.py` L8（GLB/FBX）
- `addon/dsh_blender_bridge/commands/scene/world.py` L21（mmd_tools shim 注释）
- `docs/architecture.md` L26/L171（15/34/228/38/29 的官方口径）；`runtime/blender-detect.ts` L229–L244（macOS）；`docs/配置参考.md` L85
- npm registry：`npm view dsh-blender-plugin version license` → 3.0.6 / BSD-3-Clause

**dsh-live2d-mao**（commit `21b9db2`）：
- `packages/dsh-live2d-mao/lib/phases.js` L14–L30（12 态）、L36–L49（优先级）；`lib/phase-map.js`（facts→phase 纯函数）
- `私人AI日记系统/backend/app/kernel/agent_bus_service.py` L47–L60、L63–L76、L79–L89
- `澪Agent应用/dist/live2d-pet/live2d-pet.js` L21–L31（motionSlots）、L196–L263（expressionSlots）、L1359/L1374/L1388（槽位选动作）
- `packages/dsh-live2d-mao/package.json` L3（v1.4.0）、license MIT；`LICENSE` L1
- README L142（Windows only）、L358（MIT）、L367–L368（模型许可）；`私人AI日记系统/backend/requirements.txt` L13–L14（dxcam/mss）

**外部来源**（详见 `tests/tmp/repo-audit/external-sources.md`）：
- [UnityMMDTools (UMT)](https://github.com/CandidumGames/UnityMMDTools)（MIT，PMX 导入 + humanoid Avatar + VMD→AnimationClip；macOS 未提供原生插件，TODO 列明）
- [UnityMMDConverter](https://github.com/maoxig/UnityMMDConverter)（VMD→`.anim`/`.unity3d`，基于 MMD4Mecanim）
- [MateEngine-CustomDancePlayer](https://github.com/maoxig/MateEngine-CustomDancePlayer)（`.vmd`/`.vmdance`/`.unity3d` 播放）
- [Mate-Engine-Linux-Port](https://github.com/Marksonthegamer/Mate-Engine-Linux-Port)（Unity 6000.2.6f2 构建；Mod 不加载）
- [MMD Tools (Blender)](https://github.com/MMD-Blender/blender_mmd_tools)（GPLv3，Blender 4.2–5.2，pmx/vmd/vpd 导入导出）
- [HumanPoseUtility](https://github.com/elvneko/HumanPoseUtility)（Unity 包，HumanPose JSON 导入导出）
- [Unity HumanPoseHandler](https://docs.unity3d.com/ScriptReference/HumanPoseHandler.html)、[AvatarBuilder.BuildHumanAvatar](https://docs.unity3d.com/ScriptReference/AvatarBuilder.BuildHumanAvatar.html)、[FBX Exporter](https://github.com/needle-mirror/com.unity.formats.fbx)
- [VRMC_vrm_animation 1.0](https://github.com/vrm-c/vrm-specification/tree/master/specification/VRMC_vrm_animation-1.0)（glTF humanoid 动画规范）、[BOOTH .vrma 免费包示例](https://booth.pm/ja/items/8944977)

### C. 任务书要求对照

| 任务书要求 | 本报告位置 |
|---|---|
| 每个仓库：技术栈/目录/资源格式/动画清单/许可证/能否直接给 PMX 用/可复用什么 | §2、§3、§4、§5、§6 |
| Mate-Engine 重点：转换路径调研（开源解码器/Unity 烘焙/AssetBundles/Workshop/Linux 移植） | §2.5（a)–(f) |
| 「值不值得为 128 个动画装 Unity」 | §2.5(f)（结论：为子集值得，为全部不值得） |
| dsh-blender-plugin：15 工具/命令注册表/可视化调参回路/许可证/npm/Blender 4.2/headless | §5 全节 |
| l2dpet / dsh-live2d-mao：确认 2D-only、提炼调度设计 | §3.2/§3.3、§4.2/§4.3 |
| 结论带证据（文件路径/行号/链接）、明确判定 | §0、§2–§6、§10.B |
| 交付 `docs/research/repos-audit.md`、证据在 `tests/tmp/repo-audit/` | 本文件 + §1.3 |
