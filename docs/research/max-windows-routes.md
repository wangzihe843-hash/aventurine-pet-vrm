# 在 macOS/云上跑 3ds Max 批量 `.max → FBX`：路线、成本、社区攻略与执行脚本

- 日期：2026-11-09 · 作者：windows-route-researcher（task-2）
- 范围：为 `砂金戏浪.zip` 内 138 个 HSR 砂金官方动作 `.max` 找到最可行的批量导出执行路线（本机 macOS 27.2 arm64 / M5 Max / 36GB / 内盘剩 207GB）。
- 证据标记：【官方】Autodesk/微软/Parallels 官方文档；【实测】有具体机器+版本+日期的一手实测；【论坛】社区帖子/搜索快照；【推断】基于已知事实的分析，未经实测；【本地实测】我在本机的探针结果。
- 说明：Autodesk 官网（`autodesk.com`/`forums.autodesk.com`）对非浏览器抓取返回 403/Cloudflare，部分条目内容来自搜索引擎快照（已标注）；`help.autodesk.com`、`autodesk.com.cn` 可正常抓取，官方技术文档以它们为准。
- **2026-11-09 更新（路线已选定）**：Lead 确认用户**有 Windows 电脑、尚未安装 3ds Max、愿意自行注册 Autodesk 账号** → 采用 **§12「用户自装 3ds Max 2027 试用 + 批量导出」**；§3–§7 的 Mac VM / 云 / Wine 内容降级为备选资料，仍保留作为证据与 Plan B。

---

## 0. TL;DR（给 Lead 的结论）

> **已选定路线（2026-11-09 Lead 确认）**：用户有 Windows 电脑、没装 3ds Max、愿意注册 Autodesk 账号 → **执行 §12**：用户在自己 Windows 上装 **3ds Max 2027 官方 30 天试用**（免费，无需信用卡）→ 用 §12.3 的 batch 脚本把 138 个 `.max` 导出为逐文件 FBX → 回传。预计用户侧 **2–4 小时**（下载 1–2h + 安装 0.5h + 导出 0.5–1.5h），成本 ¥0。§3–§7 的 VM/云/Wine 路线**降级为备选**。
> 用户侧前置唯一硬条件：**Windows 必须是 Windows 11**（3ds Max 2027 只支持 Win11；Win10 需先免费升级）。若用户是 Win10 且无法升级 → 回退 §3（Parallels）或 §6（云）。

**结论：`.max` 只能由 3ds Max 打开/转换，没有任何"不装 Max"的官方或可靠开源替代（任务 1 的离线解析方向也印证 Blender 插件只读 mesh）。所以路线问题 = "在哪台 Windows 上装一次 3ds Max 并用脚本批量导出"。**

| 选项 | 可行性 | 成本 | 预计耗时 | 风险 | 定位 |
|---|---|---|---|---|---|
| **A. 用户自己的 Windows 电脑**（Lead 已确认存在） | 高（唯一"零虚拟化"方案） | Max 2027 官方 30 天试用 ¥0 | 用户侧 2–4h（下载 1–2h + 安装 0.5h + 导出 0.5–1.5h） | 低（唯一硬前置：**必须是 Windows 11**） | **已选定主路线（§12）** |
| **B. 本机 Parallels Desktop + Windows 11 ARM + Max 2027 试用** | 中（Max 2022/2023 有 M1/M2/M4 实测；**2027 无公开实测**） | Parallels ≈$100–120/年 + Win11 Pro 许可（无 key 则 ~$199）；Max 试用 ¥0 | 下载 Win11+Max 共 ~13GB（1.2MB/s ≈ 3h）+ 安装 + 批处理 ≈ **6–9h（半天到一天）** | 中：Prism 模拟 + 2027 新运行时；Autodesk 明确不支持 WoA | **备选 1（自包含、可复用）** |
| **C. 云端 Windows（国内设计云工作站 / AWS·Azure）按时租** | 中高（取决于云镜像是否 Win11 + 能否装软件） | ¥30–300（2–4h） | 1.5–4h（云内下载快） | 中：环境兼容、实名/付费、**官方游戏素材上传第三方云的版权/泄露风险** | **备选 2（最快最省一次性）** |
| **D. 免费 UTM/VMware Fusion + Win11 ARM，只跑 `3dsmaxbatch`** | 未知（无 GPU 3D 加速，但批处理可能不需要视口） | ¥0（Windows 许可另计） | 3–6h | 高（未验证；3ds Max 可能因 D3D 设备创建失败退出码 -7） | 可选 1 小时低成本 POC，不作主路线 |
| **E. Wine/CrossOver** | **不可行** | — | — | 装不上（WineHQ bug 56652：Max 2024 安装无法完成） | 排除 |
| **F. 不装 Max 的替代** | 只有"已有官方 FBX"这条能立刻用 | ¥0 | 0 | — | **兜底** |

**主路线建议（一句话）**：先问用户"能不能搞到一台 Windows 10/11 x64 实体机（哪怕借用 2 小时）+ 一个 Autodesk 账号"，然后在那边装 3ds Max 2027 **完整离线安装包**（在线安装器在模拟环境会挂），用本报告 §8.4 的"单进程循环"MaxScript 批导；这是唯一没有"不支持配置"风险的路线，且成本为 0（30 天试用足够）。

**若用户没有任何 Windows 机器、且不愿买 Parallels**：走 **C 云路线**（国内按时计费设计云桌面成本 ~¥30–200，或 AWS/Azure Windows 实例 ~$5–20），但必须先和用户确认"官方素材上传到云服务商"这件事是否接受（项目约定是"仅本机私有、禁止再分发"）。

**兜底**：`/Volumes/4TB外置盘/百度网盘/砂金.rar` 里已有从游戏资源包提取的官方 `Avatar_Aventurine_00.fbx`（135 take/60fps/236 骨，任务 3 已确认管线用它跑通 14 条 clip）。若只是补现有 14 条 clip，**根本不需要 .max 路线**；先做"动作清单 diff"再决定要不要花半天。

### 需要用户回答的问题（Lead 2026-11-09 已确认 Q1/Q2，其余待补）

1. ~~有没有可用的 Windows 实体机？~~ **已确认：有 Windows 电脑，但未装 3ds Max。** → 待补：**是 Windows 11 还是 Windows 10？**（3ds Max 2027 只支持 Win11；Win10 需先免费升级）、电脑能否装软件/登录 Autodesk 账号、磁盘剩余空间（需 15–20GB）。
2. ~~有没有 Autodesk 账号？~~ **已确认：愿意自行注册/登录。**（2027 试用 30 天、无需信用卡、完整功能，详见 §12.1）
3. **是否接受把官方游戏素材拷到这台 Windows / 通过网盘回传？**（项目约定"仅本机私有"，请确认只传给项目内部、不公开分享。）

---

## 1. 已核实资产盘点（本机实测）

### 1.1 zip 实际构成（与任务描述的差异）

| 项 | 任务描述 | 本机实测（`unzip -l/-Z1`，2026-11-09） |
|---|---|---|
| `.max` 文件 | 141 个 | **138 个**（含 2 个重复命名 `Skill04 (2).max`、`StandBy (2).max` → **136 个唯一动作名**） |
| 贴图 | 32 张 | **35 张 PNG**（Body/Face/Hair/Weapon 的 Color/LightMap/Mask/Ramp 等，HSR 卡通渲染贴图） |
| 文件总数 | — | 173 |
| zip 体积 | 3.3GB（口口相传） | **617,874,244 B ≈ 589 MiB**（压缩后） |
| 解压后 | 3.3GB | **3,267,697,896 B ≈ 3.04 GiB**（其中 `.max` 3.02 GiB） |
| 单个 `.max` | — | 16–30MB（`Tpose.max` 16.3MB 最小，`Skill01.max` 30.4MB 最大），平均 ~22MB |
| 重复项 | — | `Skill04 (2).max`、`StandBy (2).max` 两个带 " (2)" 的疑似重复文件（是否逐字节相同未验证） |

> 文件名覆盖了 HSR 砂金的全部动作族：`StandBy/TeamStandBy/Idle_Show_01-02`、`Skill01–04 (+Skill41/MazeSkill01/MazeAttack01)`、`Hit_L/H/Stun`、`Die/Revive`、locomotion（`Walk/Run/FastRun/Turn_*/RunStop_*/WalkStop_*`）、社交/表演（`Akimbo/Alert/BackWard/Bye01/CoverMouth/HoldArm/HoldHead/Injured/LookAtPhone/PutHand/ScratchHead/Shrug/Talk01-02/Think/UseHeadPhone/UseProp/Worry`）、以及 `Tpose.max`。

### 1.2 `.max` 内部证据（我在 /tmp 解出 `Tpose.max`、`Skill01.max`、`Alert01Loop.max` 等做 strings 探针）

- 文件格式：OLE2 复合文档（`Composite Document File V2`），内嵌字符串 **`3ds Max 版本: 23.00` → 3ds Max 2021 保存**（23.0 = Max 2021；2022=24.0、2023=25.0、2024=26.0、2025=27.0、2026=28.0、2027 对应更高），**中文版（zh-CN，Locale 2052）**、Windows 10 上保存、**未压缩**（场景未勾选压缩保存，加载更快）。
- 骨骼：**标准 3ds Max Biped**。共 67 个 `Bip001*` 节点：`Bip001 Pelvis / Spine / Spine1 / Spine2 / Neck / Head / L,R Clavicle / UpperArm / Forearm / Hand / Finger0–4 (各 3 节 + Nub) / Thigh / Calf / Foot / Toe0 / HeadNub / Footsteps`。
- 模型：根对象名 `Avatar_AventurineW_00`（注意与游戏包里的 `Avatar_Aventurine_00`、Boss 版 `Art_W3_Aventurine_00` 不同名，见 §1.3）；网格对象 `0000_Body`…`0009_Weapon`、`Face/Face_Mask/Hair` 等；**次级骨链**为 HSR 命名 `ClothL/R_a_01_JNT`、`Hair*_JNT`（头发/衣摆，对应游戏里的 Secondary 链）。
- 依赖插件：strings 中只出现 `biped.dlc`、`bonesdef.dlm`、`morpher.dlm`、`ctrl.dlc`、`helpers.dlo`、`prim.dlo`、`prosound.dlc`、`reactor.dlc`、`update1.dlo` 等——**全部是 3ds Max 自带标准插件，无第三方插件依赖**。任意 3ds Max 2021+ 都能直接打开（不需要 V-Ray/Corona 等）。
- 面骨存在 HSR 命名（`brow_M`、`eye_L`、`eyeEnd_L` 等），但**身体骨没有 `Root_M/Hip_L/Spine1_M` 这类游戏骨名**——身体是 Biped 命名。→ 新 FBX 接入现有管线需要一张新的 Biped→VRM humanoid 映射表（§8.5）。

### 1.3 与"已有官方 FBX"的关系（重要，决定要不要折腾）

- `/Volumes/4TB外置盘/百度网盘/砂金.rar`（59.7MB，RAR5，已用 `bsdtar -tf` 列出）内含：
  - `砂金/Animator/Avatar_Aventurine_00/Avatar_Aventurine_00.fbx`（任务 3/`docs/vrm-motion-hsr.md` 记录为 305.1MB、135 take/60fps/236 骨、29 条全身 take）+ 贴图 + 材质 JSON；
  - `砂金/诡异砂金/Animator/Art_W3_Aventurine_00/Art_W3_Aventurine_00.fbx`（Boss 形态的另一套资产）。
- 也就是说：**游戏资源包提取版 FBX 仍在硬盘上、可解压复用**，不需要重新提取。
- `.max` 包（`Avatar_AventurineW_00`）与上述 FBX（`Avatar_Aventurine_00`）**不是同一份导出物**：前者是 138 个逐动作的原始 Biped 场景（每个都含完整角色网格+Biped 关键帧），后者是游戏侧 Unity 动画资产（135 take，其中只有 29 条为全身）。**若 `.max` 里的社交/表演动作是完整全身版，而游戏 FBX 里对应 take 只有次级骨动画（现存已知现象：54 条 Adv locomotion 只有次级骨），那 `.max` 就有真实增量价值**；否则只是同内容的更高精度副本。
- → **第一个决策门槛**：解压 `砂金.rar`，把 135 个 take 名与 136 个 `.max` 文件名做一次并集/差集（脚本见 §8.6）。若差集为空且现有 FBX 的全身 take 已覆盖需求 → 取消 Max 路线；若有 `.max` 独有动作或现有 take 不完整 → 才值得花半天搭 Windows/Max。

---

## 2. 官方口径与授权/费用（逐条给链接）

### 2.1 不装 3ds Max 能否把 `.max` 转 FBX？——官方答案：不能

- Autodesk 社区问题《how to convert a .max file to fbx without 3dsMax?》的结论/社区共识：`.max` 是 3ds Max 私有场景格式，**只有 3ds Max 能完整读取并导出**；官方提供的 **FBX Converter 只做 FBX/OBJ/3DS/DXF/DAE 之间的互转，不读 `.max`**（[FBX Converter 2013 帮助 PDF](https://download.autodesk.com/us/support/files/fbx_converter_20120.pdf)）。
- 帖子链接（Autodesk 论坛对抓取返回 Cloudflare 403，仅能确认标题与上下文）：<https://forums.autodesk.com/t5/3ds-max-forum/how-to-convert-a-max-file-to-fbx-without-3dsmax/m-p/11644441>
- 旁证：Autodesk 官方 3ds Max 与 FBX 帮助对"用命令行批量导出场景"的支持文档全部建立在"本机已安装 3ds Max"前提上（§2.2/§8.2）。
- 结论：**必须有一台能运行 3ds Max 的 Windows**；macOS 无原生版本（Autodesk 从未发布 macOS 版 3ds Max）。

### 2.2 Windows on ARM（含 Parallels 里的 Win11 ARM）——官方"不支持"

- 【官方】Autodesk KBA《Autodesk products are not supported on a Windows device with an ARM processor (WoA)》："**Are Autodesk products supported on ARM-based devices? No.** Although customers report they have Autodesk products successfully running on ARM-based devices, ARM-based devices use a different…"——即 **可以跑但不受支持、不保证**。
  <https://www.autodesk.com/support/technical/article/caas/sfdcarticles/sfdcarticles/Surface-Pro-X-and-Windows-running-on-ARM-processors-WoA.html>
  （同文镜像：<https://help.autodesk.com/view/ACD/2026/ENU/?caas=caas/sfdcarticles/sfdcarticles/Surface-Pro-X-and-Windows-running-on-ARM-processors-WoA.html>）
- 【官方】3ds Max 2027 系统需求：**仅 Microsoft Windows 11**（不再列 Windows 10；无 ARM64 版本）。<https://www.autodesk.com/support/technical/article/caas/sfdcarticles/sfdcarticles/System-requirements-for-Autodesk-3ds-Max-2027.html>
- 【论坛】Autodesk 3ds Max 论坛 2025-04-08 回帖："I haven't personally tried it but I've heard folks are running virtual environments in ARM with 3dsmax just fine."（转述，非本人实测）
  <https://forums.autodesk.com/t5/3ds-max-forum/3ds-max-can-run-windows-11-arm/td-p/13415558>
  另一帖《3ds max on new Windows 11 ARM》：<https://forums.autodesk.com/t5/3ds-max-forum/3ds-max-on-new-windows-11-arm/td-p/12792176>

### 2.3 版本兼容性：3ds Max 2021 的 `.max` 能被新版打开

- 【官方】"3ds Max 2021, for instance, should be able to load any .MAX file created in an earlier version of 3ds Max, but 3ds Max 2020 cannot open a 3ds Max 2021 file. However, 3ds Max can save legacy versions of 3ds Max scene files back three (3) versions by using File > Save As." —— 新版本读旧文件没问题；反向只能回存 3 个版本。
  <https://help.autodesk.com/view/3DSMAX/2024/ENU/?caas=caas/sfdcarticles/sfdcarticles/What-file-formats-does-3ds-Max-import-and-export.html>
- 【官方】场景文件兼容性（很老的文件可能需要中间版本转存，2021→2025/2027 属正常范围）：
  <https://help.autodesk.com/view/3DSMAX/2025/ENU/?caas=caas/sfdcarticles/sfdcarticles/Scene-file-compatibility-between-the-current-and-back-versions-of-3ds-Max.html>
- 本次资产是 **Max 2021 保存、无第三方插件**（§1.2），所以用 **Max 2022–2027 任一新版**都能直接打开；不需要装 2021。

### 2.4 费用/试用/教育/Indie

| 方式 | 费用 | 条件/限制 | 证据 |
|---|---|---|---|
| **30 天免费试用** | ¥0 | 完整功能（批处理/脚本导出都在内），需 Autodesk 账号 + 联网激活；计时从首次启动起 | [autodesk.com/products/3ds-max/free-trial](https://www.autodesk.com/products/3ds-max/free-trial)【官方】 |
| **教育版** | ¥0，1 年，可续 | 合格院校的学生/教师；最多 2 台设备；需学籍/在职验证 | [education overview](https://www.autodesk.com/education/edu-software/overview)、[education home](https://www.autodesk.com/education/home)【官方】 |
| **Indie 订阅** | $330/年（≈¥2,400） | 年收入 <$100k 且项目价值 <$100k 的个人 | [CG Channel 2026-05](https://www.cgchannel.com/2026/05/autodesk-releases-3ds-max-2027-1/)【第三方媒体】 |
| **商业订阅** | $255/月 或 $2,010/年 | — | 同上【第三方媒体】 |
| **安装包** | 免费下载（需账号） | 必须用"**完整/直接下载**"的离线安装包；在线安装器在模拟器/低配环境里容易挂 | [How to download a complete installation package](https://help.autodesk.com/view/3DSMAX/2027/ENU/?caas=caas/sfdcarticles/sfdcarticles/How-to-download-a-complete-Autodesk-software-installation-package.html)【官方】 |

> 结论：**一次性任务用 30 天试用即可，3ds Max 侧成本为 0**。真正的成本在"Windows 环境"（Parallels/Windows 许可/云租金/借机器）。

### 2.5 2027 版本注意点

- 【第三方媒体】3ds Max **2027 于 2026-03-25 发布**，要求 Windows 11；2027.1（2026-05）、2027.2 后续更新。 <https://www.ranchcomputing.com/en/3ds-max-2027-new-features/>
- 【论坛发布帖】2027 更新核心：.NET Core 10、Qt 6.8、C++20、**移除 DirectX 9 支持**、OpenColorIO 2.5.1、USD 0.14。
  <https://forums.autodesk.com/t5/3ds-max-forum/3ds-max-2027-released/td-p/14068396>
- → 纯 CPU 的 FBX 导出不依赖 GPU/DX9，理论上无影响；但 **2027 在 Win11 ARM（Prism 模拟）上没有任何公开实测**（现有实测都停在 2022/2023），这是 B 路线的核心风险（§3.5）。

### 2.6 云端使用的授权注意

- 【官方】Autodesk 有专门的《Deploying 3ds Max Batch on the Cloud》文档（说明官方承认云/VM 上跑 Batch 是常见用法），并给出两条云端清理步骤（**删 `<maxroot>/atf_converter` 目录 + 删 `<maxroot>/stdplugs/IwATFExport.dle`**）：
  <https://help.autodesk.com/cloudhelp/2022/ENU/3DSMax-Batch/files/GUID-820A51F0-FFE6-4ACC-B3C6-18D7EFA32FA7.htm>
- 【官方】订阅的 Cloud Rights FAQ（订阅用户在云上部署的权利；**试用/教育许可的云部署条款未逐字核实**，商务上一般按"自己控制的云主机 BYOL"处理）：
  `<https://knowledge.autodesk.com/support/3ds-max/learn-explore/caas/sfdcarticles/sfdcarticles/Subscription-Benefits-FAQ-Cloud-Rights.html>`（knowledge.autodesk.com 对本机抓取 503，链接保留待核）
- 提示：一次性任务、非生产用途，法律风险低，但**资产版权/保密风险才是重点**（官方游戏素材上传第三方云 = 违反项目"禁止再分发/仅本机私有"约定），须用户拍板。

---

## 3. 路线 A：Parallels Desktop + Windows 11 ARM + 3ds Max（本机自包含）

### 3.1 已有的一手实测（2023–2026，全部为 Max 2022/2023，**没有 2027**）

| 来源 | 机器/系统 | 配置 | 结论 |
|---|---|---|---|
| 【实测】Habr 2025-06-21（俄文，最详细） <https://habr.com/ru/articles/1050156/> | Mac mini M4 32GB / macOS Tahoe 26.5.1 / **Parallels Desktop 26.3.1** / Win11 **Pro ARM**（8 核 24GB 给 VM） | **3ds Max 2022** + Corona 15 | ✅ 能装能跑：建模/材质/灯光/交互渲染都可用；**纯 CPU 渲染**（GPU 0%）；作者结论"作为生产力主站不行，但临时/专项可用" |
| 【实测】Reddit r/3dsmax 2023-07 <https://www.reddit.com/r/3dsmax/comments/15202va/m1_and_m2_macs_and_3dsmax/> | M2 Max MBP | Parallels + **Max 2022** + Corona 10 | "works quite smooth, at least on small scenes…bottleneck will be the RAM" |
| 【实测】Parallels 论坛 <https://forum.parallels.com/threads/3ds-max-on-m1-pro.360633/> | M1 Max 64GB | Parallels + **Max 2023** | "works pretty well in the viewport, but rendering speeds are still massively throttled" |
| 【论坛转述】Autodesk 论坛 2025-04-08（见 §2.2） | — | — | "heard folks are running virtual environments in ARM with 3dsmax just fine" |

### 3.2 Habr 实测总结出的安装顺序与坑（可直接照抄）

1. 全部装 **x64 版**运行时，且**先于** Max 安装器：
   1) Visual C++ 2015–2022 Redistributable (x64)
   2) **Visual C++ 2012 (x64)** ← 不装 Max 直接起不来
   3) Visual C++ 2013 (x64)
   4) **.NET Framework 4.8**（不是 .NET 8）
   5) DirectX End-User Runtime (June 2010)（提供 `d3dcompiler_43.dll`）
2. **3ds Max 必须用完整离线安装包**：在线安装器在 Prism 模拟下会"死机"（Habr 原文：онлайн-инсталлер под эмуляцией намертво виснет）。
3. **AVX2 依赖**：Windows 11 ARM 对 AVX2 的模拟从 **build 26100.6725 / 26200.6725（2025 秋）** 起才可用，低于此版本会报 `Missing instruction sets: AVX2`（Habr 是在 Corona 上撞到的；3ds Max/Arnold 某些组件也吃 SSE4.2/AVX）。→ 装完先 `winver` 确认版本，并跑满 Windows Update。
4. **视口卡顿是 HiDPI 缩放问题**：把 Mac 侧分辨率设 1920×1080、Windows 侧缩放 100%（或两边一致），并把视口驱动设为 **Nitrous Direct3D 11**（Parallels 虚拟 D3D11），视口就流畅了。
5. 纯导出场景**不需要 GPU 渲染器**；Arnold/Corona 的 GPU 模式不可用（无 CUDA/OptiX），但我们只做 FBX 导出，用不到。

### 3.3 Windows 11 ARM 的合法性与许可（Parallels 官方 + 微软）

- 【官方】Parallels Desktop 是**微软授权的**在 Apple Silicon 上跑 Windows 11 Pro/Enterprise ARM 的虚拟化方案；支持 M1–M5（含本机 M5 Max）；虚拟化 DirectX 11/12；**不支持嵌套虚拟化**。
  <https://www.parallels.com/products/desktop/microsoft-authorized-solution-windows-11-arm/>
- 【官方】**Windows 许可不含在 Parallels 里**，每台 Win11 Pro VM 需要一个独立合法许可；Parallels 自身有 **14 天免费试用**，正式购买 Standard/Pro 订阅（官方购买页：<https://www.parallels.com/products/desktop/buy/>；参考价 **Standard ≈$99.99/年、Pro ≈$119.99/年**，以页面为准）。
- 微软官方指引（M1/M2/M3 上 Parallels 跑 Win11 ARM）：
  <https://support.microsoft.com/en-US/Windows/Experience/Platform-variants/options-for-using-windows-11-with-mac-computers-with-apple-m1-m2-and-m3-chips>
- Windows 11 ARM ISO 官方下载页（UTM/手动安装时才需要；Parallels 可自动下载）：
  <https://www.microsoft.com/en-us/software-download/windows11arm64>
- 磁盘：Win11 VM 建议 64GB 起 + 3ds Max 装完 ~10–13GB + 素材 3.4GB + 导出 0.2–3GB → **约 70–85GB**；本机内盘剩 207GB，够用（VM 放内盘性能更好，素材/产物放外盘）。

### 3.4 3ds Max Batch（headless）能否在 ARM VM 里跑？——分析与验证步骤

3ds Max 的批量导出工具是 **`3dsmaxbatch.exe`**（不是渲染专用的 `3dsmaxcmd.exe`）：

- 【官方】`3dsmaxbatch.exe <script_file> [options]`，自动识别 `.ms`/`.py`；**不加载桌面 UI**（启动更快、内存更省）；支持 `-sceneFile`、`-mxsString/-mxsValue` 传参、`-listenerlog`、`-log`、`-dm on`（Dialog Monitor，自动关掉弹窗）、`-safescene on|off`；退出码：`0` 成功、`-7` **无法创建有效图形设备**、`-8` 许可错误、`-130` 脚本执行报错、`-110` 进程起不来。
  <https://help.autodesk.com/cloudhelp/2022/ENU/3DSMax-Batch/files/GUID-48A78515-C24B-4E46-AC5F-884FBCF40D59.htm>
  <https://help.autodesk.com/cloudhelp/2022/ENU/3DSMax-Batch/files/GUID-0968FF0A-5ADD-454D-B8F6-1983E76A4AF9.htm>
- 【官方】批量导出"一系列 .max 文件"的官方示例（Backburner 时代写法，但思路=每个文件跑一次脚本 + `exportFile … #noPrompt`）：
  <https://help.autodesk.com/cloudhelp/2024/ENU/3DSMax-Rendering/files/GUID-F410ECBA-AE25-4812-8375-AB7363E4C777.htm>
- 纯导出是否需要视口/DirectX：3ds Max Batch 不加载 UI，但退出码 `-7` 说明**它仍可能尝试创建图形设备**。Windows 自带 **WARP**（CPU 软件 D3D11），所以即使 VM/云主机无 GPU 通常也能起；在 Parallels 里还有虚拟 D3D11，更稳。【推断，需实测：先跑 `Tpose.max` 单文件 POC】
- **关键坑**：`.max` 场景引用的贴图在 `G:\game_ziyuan\...`（见任务 1 的 FileAssetMetaData 侦察），加载时会弹"Missing External Files"对话框把批处理卡死 → **`-dm on` 必开**，或者先设 `BitmapPaths`/把贴图放回去（导出动画其实不需要贴图，但对话框必须自动关）。

### 3.5 成本 / 时间 / 风险（按 ~1.2MB/s 估算）

| 项 | 量 | 时间@1.2MB/s |
|---|---|---|
| Parallels 安装包（~200–300MB） | 下载 | ~4 分钟 |
| Windows 11 ARM 镜像（Parallels 自动下载，~5–6GB） | 下载+安装 | 70–85 分钟 |
| Windows Update（首轮） | — | 10–30 分钟 |
| **3ds Max 2027 完整离线安装包（约 6–9GB，估）** | 下载 | **85–125 分钟** |
| 3ds Max 安装 | — | 20–40 分钟 |
| 脚本调试 + 单文件 POC | — | 30–60 分钟 |
| 批量导出 138 个（模拟器内单进程循环） | — | 40–100 分钟（原生 ~18–35 分钟，Prism ×2–3） |
| Blender 抽检/验收 | — | 20–30 分钟 |
| **合计** | | **≈6–9 小时**（大半是等待；若实际带宽 >10MB/s 可缩到 2–3 小时） |

- 一次性成本：Parallels 订阅（$100–120/年）+ Windows 11 Pro 许可（无 key 时 ~$199；有零售 key 可按微软转移条款复用）+ Max 试用 ¥0 ≈ **$300 / ¥2,200 左右首年**；若只为一次性任务，**这笔钱不如借一台 Windows 机器**。
- 风险登记：
  1. **Max 2027 在 Prism 下无任何公开实测**（现有实证止于 2022/2023）→ 缓解：先用 14 天 Parallels 试用 + Max 试用跑 `Tpose.max` 单文件 POC，失败就退。
  2. Autodesk 官方不支持 WoA → 出问题无官方支持。
  3. 3ds Max 2027 的 .NET Core 10/Qt 6.8/C++20 新运行时在模拟下可能更重/更脆。
  4. 安装包巨大 + 1.2MB/s 环境下载耗时（见上表）。
  5. Windows 许可合规。

---

## 4. 路线 B（免费替代）：UTM / VMware Fusion + Windows 11 ARM

- 事实：两者都能在 Apple Silicon 上虚拟化 Windows 11 ARM；**都不是微软"授权方案"**（微软只认 Parallels，见 Parallels 页原文："UTM and VMware Fusion can both run Windows 11 ARM on a Mac, and both are legitimate tools, but neither carries Microsoft's authorization"）。
- UTM 走 Apple Hypervisor（ARM 虚拟化，CPU 性能接近原生），但**没有给 Windows 客体的 GPU 3D 加速**（无虚拟 D3D11，只有基础 framebuffer）。对于纯 `3dsmaxbatch` 导出，理论上靠 **WARP 软件 D3D11** 可能能起（未验证）；若要开 GUI 视口则会非常卡。
- Windows 11 ARM 的获取：官方 ISO 页 <https://www.microsoft.com/en-us/software-download/windows11arm64>；许可同 §3.3（需合法 key；90 天评估镜像对 ARM64 的可用性未核实）。
- 成本：¥0（除 Windows 许可）；时间：装 Win11+Max 与路线 A 相当（3–6h）。
- 【推断】判断：**不建议作为主路线**；但如果你愿意先花 1 小时验证"3dsmaxbatch 在无 GPU 的 Win11 ARM 里能否成功导出"（只需装 Max + 跑 Tpose），成功的话可以省下 Parallels/Windows 许可钱。失败则把 VM 删掉，损失只有时间。
- VMware Fusion（个人免费）情况同理，且其 ARM Windows 3D 支持更弱。

---

## 5. 路线 C（排除）：Wine / CrossOver 跑 3ds Max

- 【实测】WineHQ Bugzilla **Bug 56652（2024）**："3DS Max 2024 wasn't launching without pasting bs.odis dlls to system32…After setting dll override setup launched but **could not finish installation**." → 安装器都跑不完。
  <https://bugs.winehq.org/show_bug.cgi?id=56652>
- 【论坛】WineHQ 论坛 2024-03 有人问"How to get 3ds Max working with WINE 9.4"，无解决方案：<https://forum.winehq.org/viewtopic.php?t=38717>
- 【官方】CodeWeavers 兼容库把 3ds Max 归为未支持/未列出（"An unlisted application…may not run correctly or at all"）：
  <https://www.codeweavers.com/compatibility>
  <https://support.codeweavers.com/en_US/troubleshooting/troubleshooting-unlisted-applications-cxmac>
- 结论：**不可行，直接排除**。另注意：CrossOver 在 Apple Silicon 上只能跑 x64 Windows 程序，而 3ds Max 依赖大量 .NET/Win32 组件，成功率极低。

---

## 6. 路线 D：云端 Windows（按时租）

### D1. 国内"设计云工作站"（最贴合，需实名+付费）

| 服务 | 计费 | 说明 | 证据 |
|---|---|---|---|
| **青椒云**（qiaojiao? 实际域名 qingjiaocloud.com） | **套餐机 + 按量计时**（"按量-计时机"） | 设计制作类云桌面，面向 3ds Max/C4D/UE 等；知乎整理包月参考价：CPU 办公版 ¥99/月、32核/64G/12G 显卡高性能版 ~¥480/月 | [价格页](https://www.qingjiaocloud.com/pricing/)、[计费说明](https://www.qingjiaocloud.com/faq/price-page/)、[知乎整理](https://zhuanlan.zhihu.com/p/1906750128187999343)【搜索快照】 |
| **赞奇云工作站**（zanqicloud.com） | 以**包周期（月/季/年）**为主 | 华为云合作的设计师云工作站，机房里有 3ds Max 等设计软件环境 | [价格](https://www.zanqicloud.com/price)、[计费说明](http://help.zanqicloud.com/xdemo/application/cost.html)【搜索快照】 |
| **ToDesk 云电脑** | 按小时/6小时/天/周订阅 | 面向个人，便宜，但主要是游戏/办公场景，装专业软件权限需确认 | 二手对比文（可靠性低）：<https://www.wai-mao.org/xin/青椒云电脑收费标准.html>【推断】 |

- 价格量级（**估算，需以官网价格页为准**）：8 核/16–32GB Windows 云桌面 **¥3–15/小时**；3 小时任务 ≈ **¥10–50**（不含存储）。
- 优点：不用买 Windows/Parallels，云内下载 Max 安装包是数据中心速度（GB 级几分钟），且**可能已有预装 3ds Max 的镜像**（设计云工作站常见卖点，需跟客服确认版本/许可）。
- 坑：①要实名认证 + 充值；②**部分服务商禁止/限制自装软件**，要提前确认"能否装 3ds Max 2027 试用/登录 Autodesk 账号"；③官方游戏素材上传云＝违反项目"仅本机私有"约定（§2.6），需用户书面同意；④计费从开机起算，注意关机不退的套餐陷阱。

### D2. AWS / Azure / 阿里云（国际/通用云）

- 【官方】Autodesk 官方文档明确写了如何在云 VM 上部署 3ds Max Batch（§2.6），说明这条路线在技术上是被认可的。
- 成本量级（**估算**）：Windows Server 实例 8–16 vCPU，按量 **$0.4–1.5/小时**（AWS `g4dn.xlarge`/`m6i.2xlarge` Windows 含许可约 $0.5–0.8/h；Azure D4s/D8s v5 Windows 类似；阿里云 ECS 按量 8c32g ≈ ¥3–6/h）；3 小时 + 磁盘 + 流量 ≈ **¥30–200**。
  - 阿里云按量计费说明：<https://help.aliyun.com/zh/ecs/billing-overview>；价格计算器：<https://www.aliyun.com/price/detail?saleProductCode=ecs>
  - AWS：<https://aws.amazon.com/ec2/pricing/on-demand/>；Azure：<https://azure.microsoft.com/en-us/pricing/details/virtual-machines/windows/>
- **关键兼容问题**：阿里云/AWS 官方镜像只有 **Windows Server**，而 3ds Max 2027 官方要求 **Windows 11**（Server 上能不能装/跑未验证，渲染农场常见但不受支持）；要 Win11 客户端镜像得用 Azure 的 Windows 11 市场镜像/AVD 或自带镜像（复杂）。→ 【推断】通用云路线**风险中高**，不如 D1 的设计云工作站省事。
- 数据传输：zip 589MB 上传（家用上行若 1.2MB/s ≈ 8 分钟；国内宽带上行通常更快）；导出产物若只导"骨骼+动画"约 **0.1–0.3GB**（下载 2–5 分钟），若连网格一起导约 **0.7–2.8GB**（10–40 分钟@1.2MB/s）。

### D3. Windows 365 / AVD / Shadow PC

- Windows 365 Cloud PC（微软托管 Win11 云电脑）：按月订阅（~$20–40/月级别），可装应用，但**服务可用地区不含中国大陆**，且管理员权限/安装限制需确认。【推断】
- Shadow PC（欧美云游戏 PC）：可装软件，但地区限制+月费，不推荐。
- → 除非用户已在海外/有企业账号，否则不优先。

---

## 7. 路线 E（最快）：借一台真实 Windows 实体机

- 这是**唯一没有"不支持配置"风险**的路线：任何 Windows 10/11 x64 机器（近 10 年的都行，导出不需要好显卡）+ 管理员权限 + 你自己的 Autodesk 账号（30 天试用）。
- 需要：机器上能装 6–9GB 安装包（下载时间取决于那边网络；若同一 1.2MB/s ≈1.5–2 小时；若那边宽带快则 15 分钟）；装完关掉杀软弹窗；用 §8.4 脚本跑。
- **最优先确认**：zip 内元数据指向 `F:\3DMAX2021` 和 `G:\game_ziyuan\...\Animator\Avatar_AventurineW_00`（任务 1 侦察）——说明这批 `.max` 原本出自一台装了 **3ds Max 2021 + 游戏资源**的 Windows 机器。如果你就是从那台机器上打包/下载的，**直接用那台机器/联系那个人**是最省事的（Max 2021 也能直接打开这些文件，甚至不需要装新版）。
- 注意：给临时机器登录 Autodesk 账号 = 试用名额会绑定该机器；30 天内足够。导出完成后在 Autodesk 账号里停用/注销该设备即可。

---

## 8. 社区攻略、现成脚本与 Biped→FBX 的坑

### 8.1 中文社区里能直接用的教程/脚本（2023–2026）

| 资源 | 内容 | 对本任务的可用性 |
|---|---|---|
| **CGJOY**《【maxscript】005.动作FBX批量输出》<https://www.cgjoy.com/thread-222112-1-1.html> | 现成 MaxScript：遍历目录下所有 `.max`，自动建 `FBX` 子目录，逐个导出；作者称"输出 30 个 MAX 动作文件，一分钟不到" | **思路与本次完全一致**，可直接借鉴/照抄其目录遍历+导出结构（本报告 §8.4 已基于此重写为 3dsmaxbatch 版） |
| **知乎**《3dsMax FBX批量导出工具》<https://zhuanlan.zhihu.com/p/699044771>（403，搜索快照可读） | 讲 FBX 批量导出工具实现；**Biped 坑**："biped 简直是 Max 开发最坑人的东西，不能直接访问 Pos、Rot、Scale 信息，只能通过文档里的方式 K 帧"；导出前要逐项检查首尾帧关键帧 | Biped 场景的导出前自检清单来源；也说明**不要试图用脚本直接改 Biped 曲线**，交给 FBX 导出器的 bake |
| **CSDN**《3dsmax-骨骼绑定及动作导出流程》<https://blog.csdn.net/yangxuan0261/article/details/80879457> | Max 骨骼绑定→动画→导出 FBX→Unity 的通用流程与导出参数 | 通用 Biped/Skin→FBX 参数参考 |
| **智伤帝博客**《3dsMax FBX导出工具》<https://blog.l0v0.com/posts/f4dcd89b.html> | 解决"每次导出都弹 FBX 选项窗"：`#noPrompt` + 预设；导出时用上次设置 | **批处理必须 `#noPrompt`**，否则每文件弹窗卡死 |
| **B站**《3Dmax如何导入和导出绑定或动画文件》<https://www.bilibili.com/video/av564030016/> | 3ds Max 动画导入导出基础（含 Biped 动作导入） | 入门参考 |
| **B站**《PSK角色动画文件导入max和导出fbx到UE全流程》<https://www.bilibili.com/video/BV1jAoDBCEeQ/> | 第三方动画→Max→FBX→引擎 的完整录屏 | 流程参考（非 HSR 专用） |
| **CGJOY** HSR 模型帖（含 `.max` 交流）<https://www.cgjoy.com/thread-269795-1-1.html>、<https://www.cgjoy.com/thread-279587-1-1.html> | 崩铁角色 `.max` 资产交流；有作者提到"自己 K 过、蒙皮大体没问题""动作文件不包含在内，只有视频" | 说明社区里 HSR `.max` 多为"模型+自己 K 的动画"，**没有找到专门针对 HSR 官方 `.max`→FBX 的逐步公开教程**（本报告结论） |
| **模之屋 PlayBox** <https://www.aplaybox.com/> | 大量 HSR 角色 FBX/PMX 模型下载 | 模型参考；动画源不在这里 |

> 诚实结论：**没有搜到"星穹铁道官方 .max 动作 → FBX"的专门教程**（大概率因为这类官方动作源属于灰色分享、教程不公开）。可复用的是"**通用 Biped → FBX 批量导出**"这一套：CGJOY 脚本 + 官方 `3dsmaxbatch` 文档 + 本报告 §8.4 的成品脚本。

### 8.2 GitHub / ScriptSpot 现成脚本评估

| 脚本 | 功能 | 适配本任务的问题 |
|---|---|---|
| **GitHub `Svilensk/MaxScript_Tools/FBX_Export_Tool.ms`** <https://github.com/Svilensk/MaxScript_Tools/blob/master/FBX_Export_Tool.ms> | 成品 FBX 导出工具，演示了 **`FBXExporterSetParam`** 的正确用法：`SmoothingGroups/NormalsPerPoly/TangentSpaceExport/SmoothMeshExport/Preserveinstances/SelectionSetExport/GeomAsBones/Animation/BakeAnimation/Skin/Shape` + `exportFile … using:FBXEXP` | 只导"当前选中对象"，不遍历文件；单场景/资产用。→ **抄它的参数设置 API**（本报告 §8.4） |
| **GitHub `bugai66/3ds-Max-Batch-Import-Export-Tool`** <https://github.com/bugai66/3ds-Max-Batch-Import-Export-Tool> | 批量导入→改→批量导出（Jos Balcaen Batch Import/Export 的开源化版） | 面向"一批模型文件导入统一场景再导出"，不是"一堆 .max 各导一次"；**不适用** |
| **CGJOY thread-222112** | 见 §8.1，"遍历目录、30 个 max 一分钟" | **最贴合**（但需登录看附件；本报告给了等价实现） |
| **ScriptSpot Batch Export/Import** <https://www.scriptspot.com/3ds-max/scripts/batch-exportimport> | 经典批量导出工具（社区提醒缺 Smoothing Groups 选项） | 同上，偏资产级 |
| **Amir Porat Batch FBX Export** <https://amirporat.com/Batch-FBX-Export-More> | 按 flag/选择集批量导出 FBX，自动建日期目录 | 可参考命名/日志设计 |
| **`miauu's Batch Save/Export`** <https://miauu-maxscript.com/portfolio-item/miauus-batch-save-obj-fbx-3ds-as-max-files/> | 商业脚本，多格式批量 | 付费，不必要 |

### 8.3 Biped → FBX 导出参数坑（逐条）

1. **必须 `#noPrompt`**：`exportFile out #noPrompt using:FBXEXP`，否则每文件弹 FBX 导出对话框，批处理停摆。【官方 FBX 脚本帮助】"use the command #noPrompt to prevent the FBX Exporter/Importer User Interface from appearing"
   <https://download.autodesk.com/us/fbx/3ds_Max_Help/FBX_3dsMax_Online/files/WS1a9193826455f5ff-54f556ca1166ac9ee9-4a80.htm>（会自动跳转到 knowledge.autodesk.com）
2. **fps（60fps 问题）**：HSR 官方 FBX 是 **60fps**（任务 3 记录：`sourceFps:60`，管线按 30fps 采样）。`.max` 场景的 `frameRate` 未知（必须逐文件探，见 §8.4 `survey_max.ms`）。FBX 会把场景帧率写进 GlobalSettings/TimeMode，**不要为了"统一 60fps"直接改场景 frameRate**（会重定时关键帧）；应在导出日志里记录每个文件的真实 fps，再在管线里把 `sourceFps` 配成实际值（管线本身支持 30→30 或 60→30 采样，见 `extract-hsr-anims.py` 的 `--config`/`sourceFps`）。
3. **单位/缩放**：Biped 骨架的"身高"取决于 **System Unit**。导出前打印 `units.SystemType`/`units.SystemScale`（脚本已做）；HSR 角色约 **1.6–1.7m**，若场景单位是 cm，Biped 骨盆高度会在 ~90–100 之间。FBX 导出器单位选 **Automatic**（或显式 cm），Blender/three 侧再按 0.01 缩到米；**在 POC 里用 `Tpose.max` 量一次身高作为基准**，写进验收清单。全 138 文件必须同单位（只有同一套角色，正常情况一致，但探针要确认）。
4. **root motion**：Biped 根是 `Bip001`（另有 `Bip001 Footsteps` 辅助对象）。locomotion 动作（`Walk/Run/FastRun/Turn_*/RunStop_*/WalkStop_*`）通常带根位移；**导出时不要选"bake 成原地"**，保留 `Bip001` 的位移曲线，让下游管线按需用 `grounding/in-place` 策略处理（现有管线已有 `grounding: feet` 机制）。FBX 导出参数保持 `Animation=true` + `BakeAnimation=true` 即可（FBX 导出器会采样 Biped 的动画曲线，这也是为什么**不要用脚本直接读 Biped Pos/Rot/Scale**——见 §8.1 知乎）。
5. **T-pose 与骨骼命名**：`.max` 身体是 **Biped 命名**（§1.2），不是游戏 FBX 的 `Root_M/Hip_L/Spine1_M/...`。→ 接现有管线必须新增 **Biped→VRM humanoid** 映射表（`retarget-hsr.mjs` 里 `HSR_TO_VRM_HUMANOID` 的兄弟表），映射关系见 §8.5。`Tpose.max` 用来确定 rest pose（Biped Figure Mode 的 T-pose）。
6. **次级骨**：`.max` 里次级链是 `ClothL/R_*_JNT`、`Hair*_JNT` 等（HSR 命名），与游戏 FBX 的次级骨同源；现有管线 `rawPolicy=spring`（交给目标 VRM 的 SpringBone），所以新 FBX 的次级骨可以**只保留、不重定向**。
7. **Nub/辅助骨**：Biped 每根手指有 `Finger*Nub`、头有 `HeadNub`、脚有 `Toe0Nub`——FBX 会导出为叶骨/空骨；管线里忽略即可（不要映射到 VRM）。
8. **`Bip001 Footsteps`**：Biped 永远自带这个辅助对象；不影响导出，脚本里排除选择即可。
9. **场景插件/材质缺失**：本批 `.max` 只依赖 Max 自带插件（§1.2），不会弹出"missing plugin"；但**贴图路径指向 `G:\game_ziyuan\...`**，会弹 Missing External Files 对话框 → **`-dm on`**（或把 35 张 PNG 放回原路径/设 `BitmapPaths`）。
10. **文件名有空格/括号/中文**：`Skill04 (2).max` 这类名字直接做输出名会带空格和括号（Blender/three 能读，但建议 `sanitize`）；`.max` 目录中文名（砂金戏浪）在 Windows 上没问题，但**输出目录建议纯 ASCII**。
11. **一键批量 vs 一文件一进程**：**推荐单进程循环**（一个 `3dsmaxbatch` 进程里 `loadMaxFile`→`exportFile`→`resetMaxFile`），省掉每次 3ds Max 启动的 5–15 秒；138 文件原生约 18–35 分钟，模拟器里 40–100 分钟。
12. **批量退出码**：`-130` 脚本错、`-7` 图形设备、`-8` 许可；脚本内部用 `try/catch` 逐文件捕获，**一个文件失败不要中断整批**，最后统计 FAIL 列表。
13. **首次运行**：用 GUI 打开一次 3ds Max 并**登录 Autodesk 账号**（试用/教育授权落盘），确认能正常打开一个 `.max` 后，再关掉用 batch 跑；批处理里若许可未激活会直接 `-8`。
14. **安全场景脚本**：若遇到 `-safescene` 相关拦截（场景内嵌脚本被禁止），加 `-safescene off`（本批官方资产预期不需要）。
15. **导出范围**：只想拿动画时，可只导出骨骼（选择所有 Biped + JNT 骨，`selectedOnly:true`，`Skin=false`），产物小 10–20 倍；但**建议第一版全量导出（含网格）留证据/对拍**，确认真身后再出精简版。

### 8.4 推荐批量方案（成品脚本，直接在 Windows 上跑）

> 目录约定：源 `.max` 放 `D:\sjxl\max\`，输出 `D:\sjxl\fbx\`（纯 ASCII 路径，避免中文/空格问题）。
> 所有 `FBXExporterSetParam` 都用 `try()` 包住——不同 Max 版本参数名略有差异，未识别参数不会中断整批。

**`survey_max.ms`（先探针，不导出；约 1–2 分钟跑完 138 个文件）**

```maxscript
-- survey_max.ms : 遍历目录下所有 .max，记录 fps / 单位 / 帧范围 / Biped 骨数 / 帧数
-- 用法（Windows cmd）:
--   "C:\Program Files\Autodesk\3ds Max 2027\3dsmaxbatch.exe" survey_max.ms ^
--     -mxsString dir:"D:\sjxl\max" -mxsString out:"D:\sjxl\survey.csv" ^
--     -listenerlog "D:\sjxl\survey.log" -log "D:\sjxl\max.log" -dm on
(
    local opts = maxOps.mxsCmdLineArgs
    local srcDir = opts[#dir]
    local outCsv = opts[#out]
    local fs = createFile outCsv
    format "file,fps,unit_type,unit_scale,start,end,ok\n" to:fs

    local files = getFiles (srcDir + "\\*.max")
    format "found % max files\n" files.count

    for f in files do (
        local n = filenameFromPath f
        local fps = 0
        local ut = "?"
        local us = 0.0
        local s0 = 0
        local s1 = 0
        local ok = false
        try (
            loadMaxFile f useFileUnits:true quiet:true
            fps = frameRate
            ut  = units.SystemType as string
            us  = units.SystemScale
            s0  = animationRange.start.frame as integer
            s1  = animationRange.end.frame as integer
            ok  = true
            resetMaxFile #noPrompt
        ) catch (
            format "LOAD FAIL: % -- %\n" n (getCurrentException())
        )
        format "%,%,%,%,%,%,%\n" n fps ut us s0 s1 ok to:fs
        format "survey: % fps=% unit=% ok=%\n" n fps ut ok
    )
    close fs
    format "DONE survey\n"
)
quitMAX quiet:true
```

**`export_max.ms`（单进程循环批量导出）**

```maxscript
-- export_max.ms : 遍历目录下所有 .max → 每个导出一个 FBX（骨架+网格+动画）
-- 用法（Windows cmd）:
--   "C:\Program Files\Autodesk\3ds Max 2027\3dsmaxbatch.exe" export_max.ms ^
--     -mxsString dir:"D:\sjxl\max" -mxsString out:"D:\sjxl\fbx" ^
--     -listenerlog "D:\sjxl\export.log" -log "D:\sjxl\max.log" -dm on
(
    local opts = maxOps.mxsCmdLineArgs
    local srcDir = opts[#dir]
    local outDir = opts[#out]
    makeDir outDir all:true

    fn setParam name val = (
        try ( FBXExporterSetParam name val )
        catch ( format "WARN: FBX param % not set\n" name )
    )

    -- 统一 FBX 导出设置（一次设置，整批复用）
    setParam "Animation" true
    setParam "BakeAnimation" true
    setParam "Skin" true
    setParam "Shape" true
    setParam "SmoothingGroups" false      -- 只要动画时可关；要网格质量可开
    setParam "TangentSpaceExport" false
    setParam "Preserveinstances" false
    setParam "SelectionSetExport" false
    setParam "GeomAsBones" false
    setParam "Cameras" false
    setParam "Lights" false
    setParam "UseSceneName" true
    setParam "InAscii" false              -- binary FBX，体积小
    -- 版本参数按需：setParam "FileVersion" "FBX202000"

    local fs = createFile (outDir + "\\export_log.txt")
    local files = getFiles (srcDir + "\\*.max")
    local okCount = 0
    local failList = #()

    for f in files do (
        local n = filenameFromPath f
        local base = getFilenameFile f
        local outFbx = outDir + "\\" + base + ".fbx"
        try (
            loadMaxFile f useFileUnits:true quiet:true
            local info = "fps=" + (frameRate as string) +
                         " unit=" + (units.SystemType as string) +
                         " range=" + (animationRange.start.frame as string) + "-" +
                                   (animationRange.end.frame as string)
            -- 只导出几何+骨骼（排除灯光/相机/辅助对象）
            local exportObjs = for o in objects where superClassOf o != Helper collect o
            if exportObjs.count > 0 then select exportObjs else clearSelection()
            exportFile outFbx #noPrompt selectedOnly:true using:FBXEXP
            okCount += 1
            format "OK   %  %\n" n info to:fs
            format "OK   %\n" n
            resetMaxFile #noPrompt
        ) catch (
            append failList n
            format "FAIL %  %\n" n (getCurrentException()) to:fs
            format "FAIL %  %\n" n (getCurrentException())
        )
    )
    format "\n=== DONE ok=% fail=% ===\n" okCount failList.count to:fs
    for x in failList do format "failed: %\n" x to:fs
    close fs
)
quitMAX quiet:true
```

**`run_export.bat`**

```bat
@echo off
setlocal
set MAXDIR=C:\Program Files\Autodesk\3ds Max 2027
set SRC=D:\sjxl\max
set OUT=D:\sjxl\fbx
if not exist "%OUT%" mkdir "%OUT%"
"%MAXDIR%\3dsmaxbatch.exe" "D:\sjxl\survey_max.ms" -mxsString dir:"%SRC%" -mxsString out:"D:\sjxl\survey.csv" -dm on -listenerlog "D:\sjxl\survey.log" -log "D:\sjxl\max.log"
echo survey exit=%ERRORLEVEL%
"%MAXDIR%\3dsmaxbatch.exe" "D:\sjxl\export_max.ms" -mxsString dir:"%SRC%" -mxsString out:"%OUT%" -dm on -listenerlog "%OUT%\export_listener.log" -log "%OUT%\max.log"
echo export exit=%ERRORLEVEL%
pause
```

**执行步骤（Windows 上，约 30–60 分钟人力 + 机器时间）**

1. 解压 `砂金戏浪.zip` 到 `D:\sjxl\max\`（138 个 `.max`，3.02GiB）。
2. GUI 打开 3ds Max，登录 Autodesk 账号（试用/教育），确认能打开 `Tpose.max`、不提示缺插件；关闭。
3. **先跑 `survey_max.ms`**：拿到 csv，检查 138 行是否都 `ok=true`、fps/单位是否一致（预期 fps 30 或 60、单位 cm 或 generic）。若个别文件加载失败 → 单独处理。
4. **POC 导出 3 个文件**：手动把 `Tpose.max`、`StandBy.max`、`Skill01.max` 复制到 `D:\sjxl\poc\`，对 poc 目录跑 `export_max.ms`，把 3 个 FBX 拷回 Mac，用 Blender 检查（见下）。
5. POC 通过后对全量跑 `export_max.ms`（预计 20–100 分钟，取决于环境）。
6. 交付：`D:\sjxl\fbx\*.fbx`（138 个）+ `export_log.txt`（逐文件 fps/单位/帧范围）+ 失败清单。

**Mac 端验收（Blender headless，本机已有 Blender）**

```bash
BLENDER=/Volumes/4TB外置盘/deepseek-harness/tools/blender/Blender.app/Contents/MacOS/Blender
"$BLENDER" -b --factory-startup --python-expr "
import bpy
bpy.ops.import_scene.fbx(filepath=r'/tmp/poc/StandBy.fbx')
arm=[o for o in bpy.data.objects if o.type=='ARMATURE']
print('fps', bpy.context.scene.render.fps, 'range', bpy.context.scene.frame_start, bpy.context.scene.frame_end)
print('armatures', len(arm), 'bones', [len(a.data.bones) for a in arm])
print('actions', [(a.name, a.frame_range) for a in bpy.data.actions])
"
```

验收标准：① FBX 能导入不报错；② 至少 1 个 armature，骨数 ≈ 67（Biped）+ 次级 JNT 链；③ 有 action 且帧范围与日志一致；④ 目视动作与原 `.max` 一致（用 3ds Max 视口截一张/或直接信任 FBX 导出器 bake）。

### 8.5 接现有重定向管线要补的东西

- 现有管道（`scripts/vrm/motion/extract-hsr-anims.py`）**输入是单个 FBX + 135 个 take**（游戏提取版），用 take 名筛选；新产物是 **138 个"单动作 FBX 文件"**。两种接法：
  - **接法 1（推荐，改动最小）**：给 `extract-hsr-anims.py` 增加"目录模式"：遍历 `--fbx-dir` 的每个 FBX，把文件名当 action 名，输出同一份 samples JSON schema（每 clip 一个 source）。改动约 50–100 行，不动 retarget/QA。
  - **接法 2**：在 Blender 里把 138 个 FBX 依次 import、把 action 挂到同一骨架的 NLA/每 action 存一个、再导出"单 FBX 多 take"——多一步且易错，不推荐。
- **Biped → VRM humanoid 映射**（新表，参考现有 `HSR_TO_VRM_HUMANOID`）：

| Biped 骨名 | VRM humanoid | 备注 |
|---|---|---|
| `Bip001 Pelvis` | `hips` | |
| `Bip001 Spine` | `spine` | |
| `Bip001 Spine1` | `chest` | 目标 VRM 无 upperChest → 按项目约定 chest←Spine1/Spine2 合并（见 `docs/vrm-motion-hsr.md` §rest 段） |
| `Bip001 Spine2` | （并入 chest 或 upperChest） | 目标缺 upperChest 时写 identity/并入 chest |
| `Bip001 Neck` | `neck` | |
| `Bip001 Head` | `head` | `HeadNub` 忽略 |
| `Bip001 L/R Clavicle` | `left/rightShoulder` | |
| `L/R UpperArm` | `left/rightUpperArm` | |
| `L/R Forearm` | `left/rightLowerArm` | |
| `L/R Hand` | `left/rightHand` | |
| `L/R Finger0`+`Finger0(1|2)` | `thumbMetacarpal`/`thumbProximal`/`thumbDistal` | Biped Finger0 = 拇指 3 节；映射口径需与现有手指 52 骨契约对齐（现有管线补齐 30 根手指） |
| `L/R Finger1..4` + `(1|2)` | `index/middle/ring/little` 的 `Proximal/Intermediate/Distal` | |
| `L/R Thigh` | `left/rightUpperLeg` | |
| `L/R Calf` | `left/rightLowerLeg` | |
| `L/R Foot` | `left/rightFoot` | |
| `L/R Toe0` | `left/rightToes` | |
| `*Nub` / `Footsteps` | 忽略 | 不映射 |
| `Cloth*/Hair*_JNT` | （次级骨，raw/spring） | 与现有策略一致：`rawPolicy=spring` |

- 还需在 `clips.hsr.json`（或新 config）里给 138 个文件名定义 clip id/slot/loop/grounding（可用命名规则批量生成：`*Loop`→loop、`*AS/*BS`→一次性、`StandBy/TeamStandBy`→idle 等）。**建议只重定向项目真正需要的子集**（当前管线只用 14 条；一次全量重定向 138 条的工作量/QA 成本高）。

### 8.6 先做的"动作清单 diff"（决定值不值得折腾）

```bash
# 解压官方 FBX 包（59.7MB）
cd /Volumes/4TB外置盘/百度网盘 && bsdtar -xf 砂金.rar -C /tmp/sandgold-hsr
# 1) 列出 136 个唯一 .max 动作名
unzip -Z1 砂金戏浪.zip | grep '\.max$' | sed 's/ (2)\.max$/.max/' | sort -u > /tmp/max_actions.txt
# 2) 用 Blender 读官方 FBX 的 take 名（或复用 tests/tmp/sandgold-hsr-probe/report.md 已有清单）
"$BLENDER" -b --factory-startup --python-expr "
import bpy; bpy.ops.import_scene.fbx(filepath=r'/tmp/sandgold-hsr/砂金/Animator/Avatar_Aventurine_00/Avatar_Aventurine_00.fbx')
open('/tmp/fbx_takes.txt','w').write('\n'.join(sorted(bpy.data.actions.keys())))
" >/dev/null 2>&1
# 3) diff
comm -23 /tmp/max_actions.txt <(sed 's/^Ani_//' /tmp/fbx_takes.txt | sort -u)
```

> 若差集为空 → 现有 FBX 已覆盖，**不必跑 Max**；若差集里恰好是项目想要的社交/表演动作（`.max` 有全身版）→ 走主路线。

---

## 9. 完全绕开 `.max` 的 fallback

### 9.1 已有官方 FBX（最实用，零成本）

- 见 §1.3：`砂金.rar` 内含 `Avatar_Aventurine_00.fbx`（135 take/60fps/236 骨）；现有管线 `docs/vrm-motion-hsr.md` 已用它跑通 14 条 clip（T-pose VRM、52 骨、QA 全绿）。**若需求只是"补几条现有动作"，这条路已经完成，不需要 Max。**
- 注意 305MB FBX 带 Maya 式 in-between shape keys，Blender 4.2 直接 import 会崩 → 现有 `extract-hsr-anims.py` 已用 monkey-patch 绕过（`docs/vrm-motion-hsr.md` 记录）。重新解压后仍可复用该脚本。

### 9.2 从游戏资源包再提取（工具链，Windows 或 Python 均可）

- **AssetStudio / AssetStudioMod**（Unity 资源浏览+导出，Windows .NET 工具；也可用 UnityPy 在 Mac Python 里写脚本）：可导出模型 FBX + 勾选 AnimationClip 一起导出，FBX 内可带 animation takes。
  - <https://github.com/Perfare/AssetStudio>
  - 用法要点（社区 gist）：`Model → Export Selected objects + Selected Animation Clips` 可把动画一起写进 FBX；"Doesn't work for every AnimationClip type"（humanoid/muscle clip 有风险；HSR 用 generic 骨架，通常可行）<https://gist.github.com/Modder4869/0f5371f8879607eb95b8e63badca227e>
  - 相关问答：<https://archive.vg-resource.com/thread-41094.html>
  - FBX 导出子系统说明（DeepWiki）：<https://deepwiki.com/Perfare/AssetStudio/6.2-fbx-export>
- **但这正是 `砂金.rar` 里已经有的东西**——重新提取不会得到比现有 FBX 更多的信息；且游戏资源包本身需要从游戏安装目录/网盘获取。
- 结论：fallback 只在"现有 FBX 损坏/需要换角色"时有意义，不构成对 `.max` 的替代（`.max` 是原始 Biped 曲线，精度/完整性更高）。

### 9.3 在线 `.max` 转换器 / 查看器（不推荐）

- 搜到 `convert3d.org`（声称"Convert 3ds Max files online — no license needed"）和 `innerscene.com/tools/max-viewer` 等：这类服务典型能力是**只解析网格/做预览，不保留 Biped 骨骼动画**，且**需要把官方游戏素材上传到陌生网站**（版权/泄露风险）。
  - <https://convert3d.org/posts/new-max-importer>、<https://www.innerscene.com/tools/max-viewer>【推断，未验证动画能力；建议不要用】
- 结论：**不可用**（丢动画 + 版权 + 不可控）。

### 9.4 离线 `.max` 解析器（并行任务 1 的调查方向）

- Blender 扩展 `io_scene_max`（NRGSille）只读 mesh/material，Biped 只建成空物体、无动画/蒙皮；详见任务 1（`docs/research/max-importer-capabilities.md`）。
- 结论：**不能**替代 Max 导出（本报告与任务 1 结论一致）。

---

## 10. 决策树

```
Q1 有没有可用 Windows 10/11 x64 实体机（含原打包来源机）？
 ├─ 有 → 【主路线 A】借机器 + Max 2027 试用 + §8.4 脚本（2–4h，¥0，风险最低）★推荐
 └─ 没有
    ├─ Q2 愿意买 Parallels($100–120/年)+Win11 许可($199) 换"本机自包含、以后可复用"吗？
    │   ├─ 愿意 → 【备选 1·B】Parallels + Win11 ARM + Max 2027 试用（4–8h，先 14 天免费 POC）★
    │   └─ 不愿意
    │      ├─ Q3 能接受"官方素材上传云" + 有支付宝/实名/信用卡？
    │      │   ├─ 能 → 【备选 2·C】国内设计云工作站（青椒云按时，¥30–200，1.5–4h）
    │      │   └─ 不能 → 【兜底】用现有官方 FBX（§9.1）；或用户自己找 Windows 机器
    └─ 想白嫖验证 → 【可选】UTM + Win11 ARM 只跑 3dsmaxbatch（1 小时 POC，成功率未知）
```

**我的推荐**：**A（实体 Windows）为主，B（Parallels）为备**；C 云路线作为"B 失败/无预算"的第三选择；F（现有 FBX）作为永远可用的兜底。**不建议** UTM 作为主路线（没 GPU 3D、未验证），**排除** Wine/CrossOver、在线转换器、离线解析器。

**给用户的"需要提供什么"清单**（按路线）：

| 路线 | 需要用户提供/确认 |
|---|---|
| A 实体 Windows | ①一台可用的 Win10/11 x64 机器（2–4 小时使用权 + 管理员权限）②Autodesk 账号（免费注册，30 天试用）③愿意把 3.4GB 素材拷到该机器 ④180 天内该机器可联网激活 |
| B Parallels | ①Parallels Desktop 订阅（或先用 14 天试用做 POC）②Windows 11 Pro 许可（有零售 key 更好）③Autodesk 账号 ④内盘 ~80GB 空间 ⑤~13GB 下载流量（1.2MB/s ≈ 3h） |
| C 云 | ①云服务账号（实名+支付方式）②确认服务商允许装 3ds Max / 有预装镜像 ③**明确同意官方素材上传第三方云**（与"仅本机私有"约定冲突，需书面确认）④预算 ¥30–200 |
| 兜底 F | 无（直接用 `砂金.rar` 现有 FBX） |

**总时间预估**（按 1.2MB/s 保守网络）：A 2.5–4h；B 6–9h（大头是 13GB 下载）；C 1.5–4h；F 0。
**总成本预估**：A ¥0（Max 试用）；B ≈¥2,200 首年（Parallels+Win11，若已有 key 则 ≈¥700）；C ¥30–200；F ¥0。

---

## 11. 证据链接总表（按主题）

**Autodesk 官方**
- 3ds Max 2027 系统需求（仅 Win11）：<https://www.autodesk.com/support/technical/article/caas/sfdcarticles/sfdcarticles/System-requirements-for-Autodesk-3ds-Max-2027.html>
- Autodesk 产品不支持 Windows on ARM（KBA）：<https://www.autodesk.com/support/technical/article/caas/sfdcarticles/sfdcarticles/Surface-Pro-X-and-Windows-running-on-ARM-processors-WoA.html>
- 文件格式/版本兼容 QA：<https://help.autodesk.com/view/3DSMAX/2024/ENU/?caas=caas/sfdcarticles/sfdcarticles/What-file-formats-does-3ds-Max-import-and-export.html>
- 场景文件跨版本兼容：<https://help.autodesk.com/view/3DSMAX/2025/ENU/?caas=caas/sfdcarticles/sfdcarticles/Scene-file-compatibility-between-the-current-and-back-versions-of-3ds-Max.html>
- 3ds Max Batch 总览：<https://help.autodesk.com/cloudhelp/2022/ENU/3DSMax-Batch/files/GUID-0968FF0A-5ADD-454D-B8F6-1983E76A4AF9.htm>
- 3ds Max Batch 用法/参数/退出码：<https://help.autodesk.com/cloudhelp/2022/ENU/3DSMax-Batch/files/GUID-48A78515-C24B-4E46-AC5F-884FBCF40D59.htm>
- 3ds Max Batch 云端部署（删 atf_converter/IwATFExport.dle）：<https://help.autodesk.com/cloudhelp/2022/ENU/3DSMax-Batch/files/GUID-820A51F0-FFE6-4ACC-B3C6-18D7EFA32FA7.htm>
- 批量导出"一系列 MAX 文件"官方示例：<https://help.autodesk.com/cloudhelp/2024/ENU/3DSMax-Rendering/files/GUID-F410ECBA-AE25-4812-8375-AB7363E4C777.htm>
- FBX 插件脚本帮助（#noPrompt）：<https://download.autodesk.com/us/fbx/3ds_Max_Help/FBX_3dsMax_online/files/WS1a9193826455f5ff-54f556ca1166ac9ee9-4a80.htm>
- 3ds Max 免费试用（30 天）：<https://www.autodesk.com/products/3ds-max/free-trial>
- 教育版：<https://www.autodesk.com/education/edu-software/overview>
- 完整离线安装包下载方法：<https://help.autodesk.com/view/3DSMAX/2027/ENU/?caas=caas/sfdcarticles/sfdcarticles/How-to-download-a-complete-Autodesk-software-installation-package.html>
- 3ds Max 2027 发布帖（DX9 移除等）：<https://forums.autodesk.com/t5/3ds-max-forum/3ds-max-2027-released/td-p/14068396>
- `.max` 无 Max 无法转 FBX（论坛帖）：<https://forums.autodesk.com/t5/3ds-max-forum/how-to-convert-a-max-file-to-fbx-without-3dsmax/m-p/11644441>
- 3ds Max 能不能跑 Windows 11 ARM（论坛 2025-04）：<https://forums.autodesk.com/t5/3ds-max-forum/3ds-max-can-run-windows-11-arm/td-p/13415558>、<https://forums.autodesk.com/t5/3ds-max-forum/3ds-max-on-new-windows-11-arm/td-p/12792176>
- 3ds Max on macOS（Parallels 用户讨论）：<https://forums.autodesk.com/t5/3ds-max-forum/3ds-max-on-macos/td-p/12331291>

**Apple Silicon / Parallels / Windows ARM**
- Habr 实测（M4 + PD 26.3.1 + Win11 Pro ARM + Max 2022，2025-06-21）：<https://habr.com/ru/articles/1050156/>
- Reddit r/3dsmax（M2 Max + Parallels + Max 2022，2023-07）：<https://www.reddit.com/r/3dsmax/comments/15202va/m1_and_m2_macs_and_3dsmax/>
- Parallels 论坛（M1 Max + Max 2023）：<https://forum.parallels.com/threads/3ds-max-on-m1-pro.360633/>
- Parallels：微软授权的 Win11 ARM 方案（M1–M5、DX11/12、无嵌套虚拟化、Win 许可另购）：<https://www.parallels.com/products/desktop/microsoft-authorized-solution-windows-11-arm/>
- Parallels 购买页：<https://www.parallels.com/products/desktop/buy/>
- Parallels KB：ARM Win11 限制：<https://kb.parallels.com/en/128914>
- 微软指引：Apple Silicon Mac 上用 Win11：<https://support.microsoft.com/en-US/Windows/Experience/Platform-variants/options-for-using-windows-11-with-mac-computers-with-apple-m1-m2-and-m3-chips>
- Windows 11 ARM ISO 官方下载：<https://www.microsoft.com/en-us/software-download/windows11arm64>
- WineHQ Bug 56652（3ds Max 2024 安装失败）：<https://bugs.winehq.org/show_bug.cgi?id=56652>
- WineHQ 论坛 2024-03 提问（无解）：<https://forum.winehq.org/viewtopic.php?t=38717>
- CodeWeavers 未列出应用说明：<https://support.codeweavers.com/en_US/troubleshooting/troubleshooting-unlisted-applications-cxmac>

**3ds Max 2027 / 价格 / 社区**
- CG Channel 2026-05（2027.1、Win11、$255/月、$2,010/年、Indie $330）：<https://www.cgchannel.com/2026/05/autodesk-releases-3ds-max-2027-1/>
- Ranch Computing 3ds Max 2027 概述（2026-03-25 发布）：<https://www.ranchcomputing.com/en/3ds-max-2027-new-features/>
- CGJOY 动作 FBX 批量输出脚本：<https://www.cgjoy.com/thread-222112-1-1.html>
- 知乎 3dsMax FBX 批量导出工具（含 Biped 坑）：<https://zhuanlan.zhihu.com/p/699044771>
- CSDN 3dsmax 骨骼绑定及动作导出流程：<https://blog.csdn.net/yangxuan0261/article/details/80879457>
- 智伤帝博客 FBX 导出预设/#noPrompt：<https://blog.l0v0.com/posts/f4dcd89b.html>
- GitHub Svilensk FBX_Export_Tool.ms（FBXExporterSetParam 范例）：<https://github.com/Svilensk/MaxScript_Tools/blob/master/FBX_Export_Tool.ms>
- GitHub bugai66 批量导入导出工具：<https://github.com/bugai66/3ds-Max-Batch-Import-Export-Tool>
- ScriptSpot Batch Export/Import：<https://www.scriptspot.com/3ds-max/scripts/batch-exportimport>
- Amir Porat Batch FBX Export：<https://amirporat.com/Batch-FBX-Export-More>
- CGJOY 崩铁 `.max` 模型帖：<https://www.cgjoy.com/thread-269795-1-1.html>、<https://www.cgjoy.com/thread-279587-1-1.html>
- B站 3Dmax 动画导入导出：<https://www.bilibili.com/video/av564030016/>、<https://www.bilibili.com/video/BV1jAoDBCEeQ/>

**云端 / 数据**
- Autodesk 云上 Batch 部署（见上）
- 青椒云价格：<https://www.qingjiaocloud.com/pricing/>、计费说明：<https://www.qingjiaocloud.com/faq/price-page/>
- 赞奇云价格：<https://www.zanqicloud.com/price>、计费：<http://help.zanqicloud.com/xdemo/application/cost.html>
- 阿里云 ECS 计费：<https://help.aliyun.com/zh/ecs/billing-overview>、价格计算器：<https://www.aliyun.com/price/detail?saleProductCode=ecs>
- AWS EC2 按量：<https://aws.amazon.com/ec2/pricing/on-demand/>
- Azure Windows VM 价格：<https://azure.microsoft.com/en-us/pricing/details/virtual-machines/windows/>

**Fallback（游戏资源提取）**
- AssetStudio：<https://github.com/Perfare/AssetStudio>
- AssetStudio 导出动画 FBX 用法 gist：<https://gist.github.com/Modder4869/0f5371f8879607eb95b8e63badca227e>
- AssetStudio FBX 导出子系统（DeepWiki）：<https://deepwiki.com/Perfare/AssetStudio/6.2-fbx-export>
- 问答（动画 FBX 导出限制）：<https://archive.vg-resource.com/thread-41094.html>
- 在线转换器（不推荐）：<https://convert3d.org/posts/new-max-importer>、<https://www.innerscene.com/tools/max-viewer>

---

## 12. 已选定路线（2026-11-09）：用户在自己的 Windows 上装 3ds Max 2027 试用 + 批量导出

> 前提（Lead 已确认）：用户**有 Windows 电脑**、**未装 3ds Max**、**愿意自行注册/登录 Autodesk 账号**。
> 本节所有事实附证据；执行脚本可直接复制使用。

### 12.1 2026-11 时点，Autodesk 官方试用怎么拿

| 问题 | 结论 | 证据 |
|---|---|---|
| 当前最新版本 | **3ds Max 2027**（2026-03-25 发布；后续 2027.1/2027.2 为小版本更新，当前下载到的就是 2027.x） | [Ranch Computing](https://www.ranchcomputing.com/en/3ds-max-2027-new-features/)、[CG Channel 2026-05](https://www.cgchannel.com/2026/05/autodesk-releases-3ds-max-2027-1/)【第三方媒体】 |
| 支持的系统 | **仅 Windows 11 64-bit**（2027 起不再支持 Windows 10） | Autodesk 3ds Max 2027 系统要求（[国际站](https://www.autodesk.com/support/technical/article/caas/sfdcarticles/sfdcarticles/System-requirements-for-Autodesk-3ds-Max-2027.html)、[中国站可抓取](https://www.autodesk.com.cn/support/technical/article/caas/sfdcarticles/sfdcarticles/CHS/System-requirements-for-Autodesk-3ds-Max-2027.html)：软件操作系统 Microsoft® Windows® 11）【官方】 |
| 试用入口 | 国际：<https://www.autodesk.com/products/3ds-max/free-trial>；**中国站（可直连）**：<https://www.autodesk.com.cn/products/3ds-max/free-trial>（页面标题"下载 3ds Max - 3ds Max 免费试用版"）；总入口 <https://www.autodesk.com/free-trials> | 本机实测 `autodesk.com.cn` 返回 200；试用下载"free 30-day trial…full artistic control"来自搜索快照【官方】 |
| 试用期 / 功能 | **30 天，完整功能**（批处理/脚本导出包含在内，没有功能阉割）；需 Autodesk ID 登录，到期自动结束 | [免费试用页](https://www.autodesk.com/products/3ds-max/free-trial)、[如何获取试用](https://www.autodesk.com/support/technical/article/caas/sfdcarticles/sfdcarticles/How-to-get-a-trial-version-of-Autodesk-products.html)、[如何使用试用模式（登录 Autodesk ID → Run Trial）](https://www.autodesk.com/support/technical/article/caas/sfdcarticles/sfdcarticles/How-to-use-Autodesk-products-in-trial-mode.html)【官方】 |
| 是否需要信用卡 | **不需要**（试用 FAQ："Your free trial automatically expires at the end of the trial period. **If you did not enter a payment method at the start**…" → 支付方式非必填；以注册页面实际字段为准，但 3ds Max 试用历来不强制绑卡） | [Autodesk 论坛 Trial FAQ 置顶帖](https://forums.autodesk.com/t5/trial-download-installation-and/quick-answers-to-common-trial-questions/td-p/14119403)【论坛】 |
| 安装包 / 磁盘 | 官方要求 **9GB 安装磁盘空间**；下载包为 6–8GB 量级（多卷时**必须全部下载到同一文件夹**再解压）；装完建议预留 **15–20GB**；场景文件 3.4GB 另计 | [完整安装包下载方法](https://help.autodesk.com/view/3DSMAX/2027/ENU/?caas=caas/sfdcarticles/sfdcarticles/How-to-download-a-complete-Autodesk-software-installation-package.html)、[Autodesk 账号的 4 种下载方式](https://help.autodesk.com/view/3DSMAX/2027/ENU/?caas=caas/sfdcarticles/sfdcarticles/Understanding-the-download-methods-in-Autodesk-Account.html)【官方】；9GB 量级来自第三方汇总【第三方】 |
| 离线安装 | 支持：Autodesk Account 里选 **"Download" 或 "Direct Download"** 拿完整安装包（不要用 "Install/在线安装器"），多卷下载齐全后双击第一个解压安装 | 同上【官方】 |
| 中国区下载通道 | **没有独立的国内镜像/专线**；`autodesk.com.cn` 只是中文门户，下载仍跳转到 Autodesk Account（Akamai 源，国内速度不稳定）。建议：①用浏览器自带下载（支持断点续传），慢就挂机/分时段；②不要用会重打包的 P2P 工具（多卷安装包校验严格）；③若公司网络有代理，优先用代理直连 Autodesk Account | 本机实测中国站可达；官方无"中国镜像"表述【推断+实测】 |

**用户侧先做的一个检查**：Win+R → `winver`。
- 显示 **Windows 11** → 可继续。
- 显示 **Windows 10** → 3ds Max 2027 **装不了**。两条路：①设置 → Windows 更新 → 检查是否可以免费升级 Win11（多数 8 代以上 Intel/AMD 机器符合）；②不能升级就回退备选路线（§3 Parallels / §6 云）。

### 12.2 兼容性：3ds Max 2027 能否直接打开 2021 的 `.max`（含 Biped 动画）？

**结论：能，官方口径是"新版本可以加载旧版本场景"；但官方同时承认旧场景在新版本可能出现个别异常，所以必须"先抽检 3 个文件，再全量跑"。**

| 问题 | 结论/证据 |
|---|---|
| 版本兼容规则 | 【官方】"3ds Max 2021 … should be able to load any .MAX file created in an earlier version… 3ds Max can save legacy versions back three (3) versions" → **2027 打开 2021 文件属正常支持范围**（只升不降；回存只支持前 3 版）。<https://help.autodesk.com/view/3DSMAX/2024/ENU/?caas=caas/sfdcarticles/sfdcarticles/What-file-formats-does-3ds-Max-import-and-export.html> |
| 官方对"旧场景+新版本"的警告 | 【官方】"Opening a scene created in older versions… may cause issues or errors in newer versions. Issues include, but are not limited to: **Material incompatibility. Modifier Stack conflict. Animation corruption. Render crashes.**" <https://help.autodesk.com/view/3DSMAX/2025/ENU/?caas=caas/sfdcarticles/sfdcarticles/Scene-file-compatibility-between-the-current-and-back-versions-of-3ds-Max.html>；另有"**Legacy 场景（2011–2018）打不开**"的专门 KB（我们的 2021 文件不在其列，属正常代际范围）：<https://www.autodesk.com/support/technical/article/caas/sfdcarticles/sfdcarticles/Some-older-3ds-Max-scenes-won-t-open-properly-in-newer-versions-of-3ds-Max.html> |
| Biped 动画跨版本 | Biped 由 Max 自带 `biped.dlc` 维护，2021↔2027 的数据结构属于长期稳定项；**本批文件只依赖 Max 自带插件**（§1.2 探针：biped.dlc/bonesdef.dlm/morpher.dlm 等），不会有第三方插件缺失 → 打开风险显著低于一般旧场景。**没有任何公开记录表明"2021 的 Biped 场景在 2027 会整体爆炸"**；已知问题集中在 `.bip` 动画文件跨版本加载（个别报错）：<https://forums.autodesk.com/t5/3ds-max-programming-forum/error-loading-bip-file-in-3ds-max-quot-an-error-occurred-while/td-p/13114419> |
| 个别文件异常时的兜底 | ①先在 GUI 里打开异常文件，**Biped 面板 → Save（.bip）**，再在 2027 里重新 Load 到 Biped 上（注意 .bip 也偶有跨版本报错，需试）；②用 2027 打开后 **File → Save As → 存成 2024 格式**再导（回存 3 版 → 2024 是下限，不需要 2024 安装）；③若仅个别文件坏，跳过并记录，不影响整体。**注意：官方试用只能拿到 2027 一个版本**，装不到 2021/2024 做中间转换。 |
| 单位（Units） | `.max` 自带场景单位。**GUI 打开**时若弹 "Units Mismatch" 对话框 → 选择 **"Adopt the File's Units"**（不要 Rescale）；**batch** 里用 `loadMaxFile f useFileUnits:true` 等价采用文件单位。本批 HSR 场景预期为 cm 或 Generic（survey 脚本打印后再定导出单位）。 |
| 坐标系 | 3ds Max 是 **Z-up**；FBX 默认 **Y-up**（导出参数 `UpAxis "Y"`），Blender/three 导入时会按文件约定自动换算。**不要为了 Blender 手动改 Z**，否则会多一次旋转。 |
| 帧率 | 场景 fps 会随文件保存。**不要为了"统一 60fps"去改 `frameRate`**（会重定时关键帧）；用 `survey_max.ms` 记录每个文件真实 fps，管线里按实际值配置 `sourceFps`（现有管线支持 60→30 采样；若场景是 30fps 则 30→30）。 |
| 已知会导致"丢失/爆炸"的操作 | 不要用脚本直接读写 Biped 的 Pos/Rot/Scale（知乎实测：Biped 必须走专用接口）→ 只做 `loadMaxFile` + `exportFile`，让 FBX 导出器内部 bake，最安全。 |

### 12.3 批量导出 MaxScript：已查证的参数名 + 可直接用的完整脚本

#### 12.3.1 官方 `FBXExporterSetParam` 参数表（3ds Max 2024–2027 通用）

【官方】`FBXExporterSetParam "<参数>" <值>` 设置导出参数；返回 `OK`/`unsupplied`（参数名不认识就返回 unsupplied，**不会报错**，所以脚本里可以安全地逐项尝试）。官方完整表（3ds Max FBX 插件在线帮助，可从 2024–2027 FBX 导出对话框右上角 **"?"** 打开同一份）：
<https://download.autodesk.com/us/fbx/3ds_Max_Help/FBX_3dsMax_online/files/WS644c7983f449f2df-53d205c5113e574e97c-8000.htm>

| 参数 | 取值 | 本任务用途 |
|---|---|---|
| `ResetExport` | 无值 | 先把导出设置重置为默认，避免上一个文件/上次 GUI 残留设置污染 |
| `Animation` | true/false | **true**（导出动画） |
| `BakeAnimation` | true/false | **true**（把 Biped 的 IK/Footsteps/约束采样成 FK 关键帧，必需） |
| `Bip2FBX` | true/false | **绝对不要设 true（危险）**：2026-11-09 v3 单变量实验证伪——在 3ds Max 2027.2 上设 true 会让 Biped 的烘焙曲线全部归零（67/67→0/67，体积正好少掉烘焙数据）；见 `docs/pilot-v3-comparison-2026-11-09.md` §2/§9 与 `docs/research/v3-bip2fbx-rootcause.md`。默认 false，`ResetExport` 后不要碰；防御性写法只能显式 `false` + 回读 |
| `Skin` | true/false | 要网格蒙皮就 true；只要骨骼可 false（产物小 10–20 倍） |
| `Shape` | true/false | 形变/形态键；纯动作导出可 false |
| `Cameras` / `Lights` | true/false | **false** |
| `EmbedTextures` | true/false | **false**（贴图另存，别埋进 FBX） |
| `ConvertUnit` | "mm"/"cm"/"dm"/"m"/"km"/"in"/"ft"/"yd" | 按 survey 得到的场景单位设置；**默认不设**，先让导出器用场景设置，POC 验证后再定 |
| `ScaleFactor` | float | 缩放系数；默认 1.0，不要乱设 |
| `UpAxis` | "Y" 或 "Z" | **"Y"**（FBX 标准；Blender/three 自动换算） |
| `FilterKeyReducer` | true/false | **false**（不要让导出器删/降关键帧，保留采样精度） |
| `ShowWarnings` | true/false | **false**（批处理时少弹警告） |
| `GeomAsBone` | true/false | false（除非要把辅助几何转骨） |
| `NormalsPerPoly` / `SmoothingGroups` | true/false | 只要动画时无所谓；要网格质量再开 |
| `PointCache` | true/false | false（本批不用点缓存） |
| `Resampling` | float | 重采样步长；**不建议动**（用 BakeAnimation 每帧采样即可） |
| `FileVersion` | 如 "FBX202000" 等 | 默认即可（Blender 4.2 的 ufbx/官方导入器支持到 FBX 2020；老版本值见官方表） |
| `LoadImportPresetFile` / （论坛另有 `LoadExportPresetFile`） | 预设文件路径 | **兜底神器**：在 GUI 里配好一次导出设置 → Save Preset → batch 里加载预设，完全不依赖参数名 |

> **对 Lead 提问里几个参数名的勘误**（以官方表为准）：
> - `"Geometry"` **不是**导出参数（它是 FBX 导出对话框里的 UI 分组名；对应子项是 `Skin/Shape/NormalsPerPoly/SmoothingGroups` 等）。
> - `"ResampleAll"` **不是**导出参数（"Resample All" 是 FBX **导入**侧的选项；导出侧是 `Resampling` 浮点值）。
> - 代表单位的导出参数是 **`ConvertUnit`**（不是 "Units"）；`UpAxis`、`EmbedTextures`、`BakeAnimation`、`Animation` 均存在且有效。
> - 不同版本新增的参数（`Preserveinstances`、`SelectionSetExport`、`SmoothMeshExport`、`TangentSpaceExport`、`InAscii`、`UseSceneName` 等，见 [Svilensk 脚本](https://github.com/Svilensk/MaxScript_Tools/blob/master/FBX_Export_Tool.ms)）在旧参数表里没有 → 本报告脚本**全部用 `try` 包裹**，不认识的参数只会返回 `unsupplied`/被跳过，不会中断。

#### 12.3.2 导出 Biped 骨骼动画的必设项 / 已知坑

1. **`BakeAnimation true` 是 Biped 的生命线**：Biped 的 IK、Footsteps（足迹模式）、约束都在导出时被"烘焙"成 FK 关键帧；关掉就会丢动画或关节解算错误。
2. **`Bip2FBX`：绝对不要设 true（2026-11-09 已证伪本报告早期建议）**。v3 单变量实验：同一场景/路径，最小集 → 67/67 Biped 有曲线；只加 `Bip2Fbx true` → 0/67，文件少 ~0.9MB（烘焙数据消失）；`Bip2Fbx false` 与不写完全一致。官方 2027 参数表只列名字、无任何语义说明；FBX SDK 头文件里它挂在 **Geometry** 组（`EXP_BIP2FBX = EXP_GEOMETRY "|" IOSN_BIP2FBX`），推断是“Biped→普通 FBX 骨骼”的几何阶段转换开关，与 bake 轨道错配导致曲线丢失。结论：**默认 false，不设置；如需防御只允许显式 false + `FBXExporterGetParam` 回读**。详见 `docs/research/v3-bip2fbx-rootcause.md`。
3. **Footsteps 模式**：用足迹做的动作，bake 后与 freeform 无差别；`Bip001 Footsteps` 辅助对象可能出现在 FBX 里，重定向时忽略即可。
4. **BipSlave/控制器**：Biped 动画存在 BipSlave 控制器里，脚本**不要**直接访问 Pos/Rot/Scale（知乎：[3dsMax FBX批量导出工具](https://zhuanlan.zhihu.com/p/699044771)），交给导出器 bake。
5. **Nub 骨**（`HeadNub`/`Toe0Nub`/`Finger*Nub`）：会导出为叶骨/空骨，管线忽略，不映射。
6. **骨骼命名与层级**：FBX 里骨骼名仍是 Max 的 `Bip001 Pelvis / Spine / Spine1 / Spine2 / L UpperArm …`（FBX 不会改名），层级保留；下游需要 **Biped→VRM humanoid** 映射（§8.5）。（与 `Bip2Fbx` 无关；该开关不要碰。）
7. **缩放/Stretch**：Biped 的缩放/拉伸曲线会作为 bone scale 通道导出；现有管线只取旋转+hip 位移 → 采样时丢弃 scale 即可（在 `extract-hsr-anims.py` 侧过滤）。
8. **根位移（root motion）**：`Bip001` 的位移曲线会保留（FBX 导出器没有"烘成原地"选项，天然保留）；locomotion 是否 in-place 由下游 grounding 处理。
9. **60fps**：不改场景 `frameRate`；导出后 FBX 的 TimeMode 与场景一致；管线按 survey 记录配 `sourceFps`。
10. **单位**：先 survey；POC 时用 Tpose 量 Biped 身高 ≈1.6–1.7 单位（若单位 cm 则 ~165），确认后再决定 `ConvertUnit`。
11. **缺贴图弹窗**：场景贴图路径指向 `G:\game_ziyuan\...` → 会弹 Missing External Files；`-dm on` 自动关，或先 `BitmapPaths` 指向解压出的 35 张 PNG 所在目录（动画导出不需要贴图，弹窗关掉即可）。
12. **`#noPrompt` 必须加**：`exportFile out #noPrompt selectedOnly:true using:FBXEXP`，否则每个文件弹 FBX 导出对话框。
13. **单进程循环**，不要"一文件一 3dsmaxbatch 进程"（每次启动 5–15 秒，138 次会多花 20+ 分钟）。
14. **一个文件失败不影响整批**：循环里 `try/catch`，记录 FAIL 清单。
15. **先 GUI 手动打开+登录一次**，确认试用授权已生效（批处理里许可未激活会直接退出码 -8）。

#### 12.3.3 完整脚本（可直接用）

目录约定：`D:\sjxl\max\` = 解压后的 138 个 `.max`；`D:\sjxl\fbx\` = 输出。**路径纯 ASCII，不要中文/空格。**

**`survey_max.ms`（先探针：fps/单位/帧范围，约 1–2 分钟）**

```maxscript
-- survey_max.ms : 批量记录每个 .max 的 fps / 单位 / 动画帧范围（不导出）
-- 命令行用法:
--   "C:\Program Files\Autodesk\3ds Max 2027\3dsmaxbatch.exe" survey_max.ms ^
--     -mxsString dir:"D:\sjxl\max" -mxsString out:"D:\sjxl\survey.csv" ^
--     -dm on -listenerlog "D:\sjxl\survey.log" -log "D:\sjxl\max.log"
(
    local opts = maxOps.mxsCmdLineArgs
    local srcDir = opts[#dir]
    local outCsv = opts[#out]
    local fs = createFile outCsv
    format "file,fps,unit_type,unit_scale,start,end,ok\n" to:fs

    local files = getFiles (srcDir + "\\*.max")
    format "found % max files\n" files.count

    for f in files do (
        local n = filenameFromPath f
        local fps = 0
        local ut = "?"
        local us = 0.0
        local s0 = 0
        local s1 = 0
        local ok = false
        try (
            loadMaxFile f useFileUnits:true quiet:true
            fps = frameRate
            ut  = units.SystemType as string
            us  = units.SystemScale
            s0  = animationRange.start.frame as integer
            s1  = animationRange.end.frame as integer
            ok  = true
            resetMaxFile #noPrompt
        ) catch (
            format "LOAD FAIL: % -- %\n" n (getCurrentException())
        )
        format "%,%,%,%,%,%,%\n" n fps ut us s0 s1 ok to:fs
        format "survey: % fps=% unit=% ok=%\n" n fps ut ok
    )
    close fs
    format "DONE survey\n"
)
quitMAX quiet:true
```

**`export_max.ms`（单进程循环导出，参数已按 §12.3.1 官方表设置）**

```maxscript
-- export_max.ms : 遍历 .max → 每个导出一个 FBX（骨架+蒙皮+动画，Biped 已 bake）
-- 命令行用法:
--   "C:\Program Files\Autodesk\3ds Max 2027\3dsmaxbatch.exe" export_max.ms ^
--     -mxsString dir:"D:\sjxl\max" -mxsString out:"D:\sjxl\fbx" ^
--     -dm on -listenerlog "D:\sjxl\export.log" -log "D:\sjxl\max.log"
-- 可选: -mxsString preset:"D:\sjxl\fbx_export.fbxexportpreset"
(
    local opts = maxOps.mxsCmdLineArgs
    local srcDir = opts[#dir]
    local outDir = opts[#out]
    local presetPath = undefined
    try ( presetPath = opts[#preset] ) catch()
    makeDir outDir all:true

    -- 参数设置助手：未知参数返回 unsupplied，不抛异常；仍用 try 兜底
    fn setParam name val = (
        try ( FBXExporterSetParam name val ) catch ( format "WARN: param % = % failed\n" name val )
    )
    fn setFlag name val = setParam name val

    -- 1) 重置为默认（避免上一次设置残留）
    try ( FBXExporterSetParam "ResetExport" ) catch()

    -- 2) 若有预设（GUI 里 Save Preset 得到），优先整包加载
    if presetPath != undefined do (
        local loaded = false
        try ( FBXExporterSetParam "LoadExportPresetFile" presetPath; loaded = true ) catch()
        if not loaded do try ( FBXExporterSetParam "LoadImportPresetFile" presetPath; loaded = true ) catch()
        format "preset loaded=%\n" loaded
    )

    -- 3) 逐项设置（对 2024–2027 有效；见 §12.3.1）
    setFlag "Animation"   true
    setFlag "BakeAnimation" true   -- Biped 必需：IK/Footsteps/约束 → FK 关键帧
    -- 注意：不要设置 Bip2FBX/Bip2Fbx true（会让 Biped 烘焙曲线全部归零）；默认 false 即可
    -- setFlag "Bip2Fbx" false  -- 如要防御可显式 false + 回读（与不写等价，已验证）
    setFlag "Skin"        true     -- 要网格蒙皮；只要骨骼可改 false
    setFlag "Shape"       false    -- 形态键：本任务不需要
    setFlag "Cameras"     false
    setFlag "Lights"      false
    setFlag "EmbedTextures" false  -- 贴图不埋进 FBX
    setFlag "FilterKeyReducer" false
    setFlag "ShowWarnings" false
    setFlag "GeomAsBone"  false
    setFlag "UpAxis"      "Y"      -- FBX 标准 Y-up；Blender/three 自动换算
    -- 单位/缩放：survey 结果出来后再决定；先保持场景设置
    -- setFlag "ConvertUnit" "cm"
    -- setFlag "ScaleFactor" 1.0

    local fs = createFile (outDir + "\\export_log.txt")
    local files = getFiles (srcDir + "\\*.max")
    local okCount = 0
    local failList = #()

    for f in files do (
        local n = filenameFromPath f
        local base = getFilenameFile f
        local outFbx = outDir + "\\" + base + ".fbx"
        try (
            loadMaxFile f useFileUnits:true quiet:true
            local info = "fps=" + (frameRate as string) +
                         " unit=" + (units.SystemType as string) +
                         " range=" + (animationRange.start.frame as string) + "-" +
                                   (animationRange.end.frame as string)
            -- 导出整场景（排除 Helper；Biped 是 BipedObject/SuperClass 不是 Helper，会被包含）
            local exportObjs = for o in objects where superClassOf o != Helper collect o
            if exportObjs.count > 0 then select exportObjs else clearSelection()
            exportFile outFbx #noPrompt selectedOnly:true using:FBXEXP
            okCount += 1
            format "OK   %  %\n" n info to:fs
            format "OK   %  %\n" n info
            resetMaxFile #noPrompt
        ) catch (
            append failList n
            format "FAIL %  %\n" n (getCurrentException()) to:fs
            format "FAIL %  %\n" n (getCurrentException())
        )
    )
    format "\n=== DONE ok=% fail=% ===\n" okCount failList.count to:fs
    for x in failList do format "failed: %\n" x to:fs
    close fs
)
quitMAX quiet:true
```

**`run_export.bat`**

```bat
@echo off
setlocal
set MAXDIR=C:\Program Files\Autodesk\3ds Max 2027
set SRC=D:\sjxl\max
set OUT=D:\sjxl\fbx
if not exist "%OUT%" mkdir "%OUT%"

echo ===== survey =====
"%MAXDIR%\3dsmaxbatch.exe" "D:\sjxl\survey_max.ms" -mxsString dir:"%SRC%" -mxsString out:"D:\sjxl\survey.csv" -dm on -listenerlog "D:\sjxl\survey.log" -log "D:\sjxl\max.log"
echo survey exit=%ERRORLEVEL%

echo ===== export =====
"%MAXDIR%\3dsmaxbatch.exe" "D:\sjxl\export_max.ms" -mxsString dir:"%SRC%" -mxsString out:"%OUT%" -dm on -listenerlog "%OUT%\export_listener.log" -log "%OUT%\max.log"
echo export exit=%ERRORLEVEL%
pause
```

> 若 `-mxsString` 传参出问题，可直接把两个脚本里的 `local srcDir = opts[#dir]` / `local outDir = opts[#out]` 换成硬编码路径（如 `local srcDir = @"D:\sjxl\max"`），GUI `Scripting → Run Script…` 也能跑（见 §12.4）。

**POC（必做）**：先建 `D:\sjxl\poc\`，只放 `Tpose.max`、`StandBy.max`、`Skill01.max`，把 bat 里 SRC 改成 poc 目录跑一遍；把 3 个 FBX 拷回 Mac 用 Blender 抽检（§8.4 的检查命令），确认：能导入、有 armature、骨数≈67+JNT 链、有 action、动作正常。**POC 通过再跑全量。**

### 12.4 两种跑法：`3dsmaxbatch.exe` 还是 GUI Run Script？

**方式 1（推荐）：`3dsmaxbatch.exe` headless 批量**

- 【官方】`3dsmaxbatch.exe <脚本> [选项]`：不加载桌面 UI、启动快、内存省，专为自动化设计；支持 MAXScript/Python、`-sceneFile`、`-mxsString/-mxsValue`、`-listenerlog`、`-log`、`-dm on`、`-safescene`；退出码 0=成功、-7=图形设备失败、-8=许可、-130=脚本错、-110=进程起不来。
  <https://help.autodesk.com/cloudhelp/2022/ENU/3DSMax-Batch/files/GUID-48A78515-C24B-4E46-AC5F-884FBCF40D59.htm>
- 命令就是 §12.3.3 的 `run_export.bat`（或单条）：
  ```
  "C:\Program Files\Autodesk\3ds Max 2027\3dsmaxbatch.exe" D:\sjxl\export_max.ms -mxsString dir:"D:\sjxl\max" -mxsString out:"D:\sjxl\fbx" -dm on -listenerlog D:\sjxl\export.log -log D:\sjxl\max.log
  ```
- **坑/注意**：①**必须先 GUI 启动一次并登录/激活试用**，否则 batch 直接 -8；②`-dm on` 必开（关缺贴图/警告弹窗）；③若报 `-7 无法创建图形设备`（远程桌面/无显示环境可能），改用 GUI Run Script；④脚本里 `#noPrompt` 必加；⑤失败文件看 `export_log.txt` 的 `FAIL` 行 + `max.log`。
- 官方还给了"批量导出系列 .max"的示例写法（Backburner 时代，思路相同）：<https://help.autodesk.com/cloudhelp/2024/ENU/3DSMax-Rendering/files/GUID-F410ECBA-AE25-4812-8375-AB7363E4C777.htm>
- 官方也有云端部署 Batch 的注意项（如未来走云：删 `atf_converter` 目录和 `stdplugs/IwATFExport.dle`）：<https://help.autodesk.com/cloudhelp/2022/ENU/3DSMax-Batch/files/GUID-820A51F0-FFE6-4ACC-B3C6-18D7EFA32FA7.htm>

**方式 2（备用/更稳）：GUI 里 Run Script**

1. 打开 3ds Max 2027（登录试用）。
2. `Scripting → Run Script…` → 选 `D:\sjxl\export_max.ms`。
3. 先把脚本开头改成硬编码路径（因为 GUI 里没有 `-mxsString` 命令行参数）：
   ```maxscript
   local srcDir = @"D:\sjxl\max"
   local outDir = @"D:\sjxl\fbx"
   local presetPath = undefined
   ```
   并把文件最后的 `quitMAX quiet:true` 删掉（否则跑完自动退出）。
4. 运行时 GUI 会逐文件加载/导出，界面会"卡"但属正常；138 个文件约 **20–60 分钟**（比 batch 略慢但最不容易出问题）。
5. 适合：batch 起不来、许可/弹窗问题、想边跑边看。

### 12.5 用户侧操作步骤（短版，可照抄）

> 预计总耗时 **2–4 小时**（下载 1–2h 取决于网速 + 安装 0.5h + 导出 0.5–1.5h + 回传 10–30min）。

1. **确认系统**：`winver` → 必须 Windows 11（Win10 先免费升级；不能升就告诉我们，改走云/Parallels）。
2. **注册/登录 Autodesk 账号**（免费）：打开 <https://www.autodesk.com.cn/products/3ds-max/free-trial>（或国际站 <https://www.autodesk.com/products/3ds-max/free-trial>）→ 登录/注册 → 选择 **3ds Max** 免费试用。
3. **下载安装包**：在 Autodesk Account 里选 **Download / Direct Download**（完整离线包，多卷要下全，6–8GB，建议浏览器断点续传、挂机下载）。
4. **安装**：解压 → 双击 Setup → 默认选项一路下一步（可取消不需要的附加组件）→ 装完重启。磁盘至少留 **15–20GB**。
5. **激活试用**：首次启动 3ds Max → 登录同一个 Autodesk ID → 选 "Run"（Trial）→ 确认标题栏/欢迎页显示"30 days left"（30 天计时开始）。
6. **放素材**：把 `砂金戏浪.zip` 拷到 Windows 电脑，解压到 `D:\sjxl\max\`（3.0GB，138 个 `.max`；**路径别用中文/空格**）。
7. **放脚本并跑 POC**：把 `survey_max.ms`、`export_max.ms`、`run_export.bat` 放到 `D:\sjxl\`；先用 3 个文件（Tpose/StandBy/Skill01）跑一次 POC，确认 FBX 有效。
8. **全量导出**：双击 `run_export.bat`（或 GUI Run Script）；等完成，检查 `D:\sjxl\fbx\export_log.txt`：`=== DONE ok=138 fail=0 ===`。
9. **回传**：把 `D:\sjxl\fbx\`（预计 0.2–2GB，取决于是否带网格）+ `export_log.txt` + `survey.csv` 打包（网盘/ToDesk/直接拷贝），传回 Mac。
10. 完成后可在 Autodesk 账号里停用该设备（不影响试用剩余天数）。

### 12.6 回传与验收清单（给 Lead/我这边）

- [ ] `survey.csv`：138 行，`ok=true`，fps/单位/帧范围已记录（用于配 `sourceFps`/单位）。
- [ ] `export_log.txt`：`ok=138 fail=0`（或有明确 FAIL 清单）。
- [ ] `D:\sjxl\fbx\*.fbx` 数量 = 138（含 `Skill04 (2).fbx` 等重复名也没关系）。
- [ ] Mac 端 Blender 抽检 ≥3 个 FBX（Tpose/StandBy/Skill01）：能导入、armature 骨数≈67+次级 JNT、有 action、帧范围与 survey 一致。
- [ ] 记录每个 FBX 的文件大小（判断是否带网格/动画完整）。
- [ ] 若 >2GB，优先只回传"骨骼+动画"版（`Skin=false` 重导一次）或分卷。

### 12.7 风险与回退

| 风险 | 概率 | 缓解 |
|---|---|---|
| 用户电脑是 Windows 10 且不能升级 Win11 | 中 | 先 `winver` 确认；不行 → §3 Parallels / §6 云 |
| 2027 打开 2021 文件个别异常 | 低（本批无第三方插件） | 先 GUI 抽检 3 个；异常文件走 `.bip` 兜底或跳过 |
| Autodesk 下载慢/多卷失败 | 中 | 浏览器断点续传、挂机下载；下载页会显示每卷大小，逐个核对 |
| 试用注册被要求绑卡/地区限制 | 低 | 官方 FAQ 表明支付方式非必填；中国站可注册；若被卡换国际站账号 |
| batch 报 -7/-8 | 低 | 先 GUI 登录激活；报 -7 改用 GUI Run Script |
| 用户误改场景 fps/单位 | 低 | 脚本只读不写场景；survey 先记录 |
| 素材版权（上传网盘/传回） | 中 | 仅传给项目内部（lead/我），不公开分享；网盘设提取码+有效期 |

### 12.8 与仓库内 `scripts/max-export/export-fbx.ms`（Lead 已建，GUI 版）的对齐说明

Lead 已在 `scripts/max-export/export-fbx.ms` 写好一版 **GUI 运行**的批量导出脚本（带 PILOT 6 文件模式、逐文件日志、进度条），与本报告 §12.3 的 **batch 版**互补，二者择一即可。按官方参数表核对，建议对该脚本做这几处小改（不改也能跑，`setParamVerbose` 会把不支持的参数记成 WARN）：

1. ~~加一行 `FBXExporterSetParam "Bip2FBX" true`~~ → **已证伪，禁止**：2026-11-09 v3 单变量实验证明该参数会把 Biped 烘焙曲线全部归零（67/67→0/67）。正确做法：不设置（默认 false）；如防御，显式 `Bip2Fbx false` 并回读。
2. **`ResetExport` 按官方表不带值**：脚本里 `setParamVerbose logF "ResetExport" 0` 会因"参数个数不对"返回 `unsupplied`（无害，但日志会有 WARN）；改成 `try (FBXExporterSetParam "ResetExport") catch()` 更干净。
3. `BakeFrameStart/BakeFrameEnd/BakeFrameStep/BakeResampleAnimation` **在 3ds Max 2027 官方 MaxScript 参数表里是有的**（2027 FBX Export Dialog Access 有明确列项，`BakeFrameStart/End` 为整数；旧版 2012 表没有它们，这就是早期误判的来源）。v3 实测这组参数生效且可回读；`BakeAnimation true` 本身会按场景 animationRange 每帧 bake，显式写这几个参数是为了把范围钉死。
4. 脚本用 `selectedOnly:false` 导出**整场景（含完整角色网格）** → 单文件预计 5–20MB。计划 §1 写的是"只导骨架+动画、每个 FBX ≪1MB"：若走精简版，改成 `selectedOnly:true`，先 `select (for o in objects where (matchPattern o.name pattern:"Bip*") or (matchPattern o.name pattern:"*_JNT"))`，并把 `Skin/Shape` 设 false；只导骨骼时 FBX 仍保留骨骼层级+动画（不需要网格）。
5. 建议 `loadMaxFile srcFile useFileUnits:true quiet:true`（默认就是 true，显式更稳）。
6. 想完全绕开"参数名是否有效"的不确定性：在 3ds Max 里手动导出一次 → FBX 导出对话框配好 → **Save Preset** → 脚本开头 `FBXExporterSetParam "LoadExportPresetFile" "<预设路径>"`（见 §12.3.1 兜底条）。
7. 另外两点与计划文档的出入（以本报告实测为准）：`.max` 单文件实测 **16–30MB**（不是 20–75MB）；138 个文件里 `Skill04 (2).max`、`StandBy (2).max` 是 `(2)` 复本，导出后需按曲线/时长对比取一个（计划 §1 已列为待办，正确）。
8. **GUI 版运行**：`Scripting → Run Script…` 选该脚本 → 先保持 `PILOT = true` 跑 6 个试点 → 检查 `D:\aventurine-fbx\pilot\*.fbx` + 日志 → 再改 `PILOT = false` 跑全量。文件里已有缺贴图弹窗的说明（点 Skip All/OK），无需 `-dm`。

**执行口径建议**：让用户先跑 **GUI 版 PILOT（6 文件）**（最不容易卡在许可/弹窗），把 6 个 FBX 回传；我们 Mac 侧 Blender 验证通过后，再让用户改 `PILOT=false` 跑全量（GUI 版约 20–60 分钟）。若想要无人值守/可重跑，则用 §12.3 的 `3dsmaxbatch` 版。

---

## 附录 A：证据等级与未决事项

- **2026-11-09 路线选定后新增 §12**，下列未决项部分已解决：试用入口/期限/是否绑卡（§12.1，【官方】）、2021→2027 兼容规则（§12.2，【官方】）、`FBXExporterSetParam` 参数表与 Biped 必设项（§12.3，【官方】+【论坛】）、`3dsmaxbatch` 与 GUI 两种跑法（§12.4，【官方】）。**仍属估算/未验证**：安装包实际大小（6–8GB 量级，未实机下载）、用户电脑的 Windows 版本（Win10/Win11 未知）。

- 【本地实测】zip 文件数/体积/`.max` 版本 23.00(2021)/中文/未压缩/Biped 67 骨/网格对象/插件依赖/`砂金.rar` 内容清单。
- 【官方】Autodesk/微软/Parallels 文档（含 403 的页面用搜索快照交叉核对，已在文中标注）。
- 【实测】Habr/Reddit/Parallels 论坛（Max 2022/2023，2023–2025）。
- 【推断，未验证】以下必须实测才能确认：
  1. **3ds Max 2027 能否在 Parallels + Win11 ARM(Prism) 下安装/启动/批处理**（现有实证止于 Max 2022/2023）。
  2. 纯 `3dsmaxbatch` 在**无 GPU 3D** 的 UTM/云 Windows 里能否创建图形设备（退出码 -7 风险）。
  3. `.max` 场景的真实 fps / 单位（需 `survey_max.ms` 在 Windows 上跑一遍）。
  4. `.max` 动作与现有官方 FBX take 的差集（需 §8.6 的 diff；决定是否值得折腾）。
  5. 3ds Max 2027 完整安装包实际大小（本文按 6–9GB 估算，下载时间按 1.2MB/s 计算）。
  6. 各云服务商实际价格与"能否自装 3ds Max/是否有预装镜像"（需官网/客服核实）。
- 未决：教育版/试用许可在云 VM 上的条款细节（Cloud Rights FAQ 页面抓取 503，未逐字核实）。
