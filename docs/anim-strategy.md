# 动作获取与重建策略（Wave 2.5 调研与决策）

> 日期：2026-11-08 · 状态：**调研完成；用户已拍板「零额外花费」→ Wave 2.5 D1/D2/D3 已落地（见 §11 实施进展）**
> 背景：Wave 2 的 B3 程序化姿态经过 4 轮盲调（v1→v4b）仍未过用户实机验收（僵硬/像猴子/半身不遂）。
> 用户指示：**停止盲调**，先找「能直接拿来用的动作包 / 参考项目」，找不到就找「适合的插件 / skill」；用户没有动捕设备，授权搜索替代方案。
> 本轮**没有改任何 app 动画代码**（`src/**` 零改动）；产物只有调研文档、可复用工具脚本（`scripts/anim-pipeline/`）与 gitignore 的临时证据（`tests/tmp/`）。
>
> 四份一手调研（本机实测，非纯资料）：
> - [repos-audit.md](research/repos-audit.md)：4 个点名仓库 + 生态深度审计（含 Mate-Engine 128 个动画全量实测）
> - [motion-assets.md](research/motion-assets.md)：MMD VMD/VPD 动作包渠道、真实下载与解析、授权口径
> - [mocap-options.md](research/mocap-options.md)：无动捕设备方案（MiPo / reze-rig / 视频动捕服务 / macOS Vision）
> - [tooling-blender.md](research/tooling-blender.md)：Blender 4.2 + MMD Tools 可视化摆姿/渲染/VPD 回路（已实跑）
> - [vmd-preview-tool.md](research/vmd-preview-tool.md)：独立 three.js r171 PMX+VMD/VPD 预览器（已实跑）

---

## 0. 一页结论（先看这张表）

| # | 用户的问题 | 结论 | 证据 |
|---|---|---|---|
| **C1** | 用户点名的 4 个仓库能直接提供动作吗？ | **都不能。** Mate-Engine 是 128 个 Unity Humanoid muscle `.anim`（three 读不了、仓库无 FBX/glTF/VMD）；l2dpet / dsh-live2d-mao 是 Live2D 2D 资源；dsh-blender-plugin 是**工具**不含动作。 | [repos-audit.md](research/repos-audit.md) §0/§2/§3/§4/§5 |
| **C2** | 有没有「能直接拿来用」的动作包？ | **有，但只有 MMD 原生格式（VMD/VPD）能零改引擎直接播**；而免费成品宠物动作包**基本不存在**（现存配布几乎都要登录/下载键/已失效，且以舞蹈为主）。**付费 BOOTH「モーションパッケージ」男性待机包**（¥2,000/20 个，条款明确允许改変+本地个人使用）是授权最干净的一手来源。 | [motion-assets.md](research/motion-assets.md) §0/§2/§6/§8 |
| **C3** | 有没有「已在本机跑通、马上能看」的直接可用动作？ | **有 2 个关键突破**：① `reze-rig`（MIT）把任意 humanoid FBX **自动重定向成 VMD**，以本 PMX 实测骨骼为目标；已转出 `Idle.vmd`（3.00s 循环，**54/54 骨轨道全部命中**）与 `Taunt.vmd`，预览器渲染**观感自然**（见 §1.2 截图路径）。② 独立预览器已能零改动验证任意 VMD/VPD 套本模型。 | `tests/tmp/preview/Idle/`、`tests/tmp/preview/bear_walk/` |
| **C4** | 适合的插件 / skill？ | **`dsh-blender-plugin@3.0.6`（BSD-3）+ Blender 4.2 LTS + MMD Tools（GPL-3）** 是解决「盲调」根因的现实工具链：本机已实测 Blender 无头导入本 PMX（贴图/骨骼正常）、四视图渲染、摆姿前后对比、VPD 导出、three r171 可消费（bone-only）。`dsh-blender-plugin` 已核实源码可用（15 工具/38 命令/无头 worker），**尚未安装**（需用户批准，建议装独立 profile 验收 `doctor kind=ok`）。 | [tooling-blender.md](research/tooling-blender.md) §0/§5/§6 |
| **C5** | 没有动捕设备怎么办？ | **首选 Reze MiPo**（浏览器摄像头/视频 → 直接导出 VMD；0 账号、0 元、0 上传；本机已 `npm ci && build` 通过）。**质量补强走 reze-rig**：Mixamo / Rokoko Create / Plask / DeepMotion / CMU 的 FBX 都能转 VMD（都要账号，部分免费额度够用，测算见 mocap-options §6）。用**官方 PV / 待机 GIF 做动捕不可行**（wiki GIF 是 400×540 半身特写，只有头肩手）。 | [mocap-options.md](research/mocap-options.md) §0/§4/§7 |
| **C6** | Mate-Engine 值得为它装 Unity 吗？ | **只值得为 25–35 个宠物专属片段**（窗沿坐/躲藏/拖拽/摸头）装，约 3–5 人日；**不值得为全部 128 个装**。前提是先用 VMD 路线看观感是否达标。 | [repos-audit.md](research/repos-audit.md) §2.5/§2.8 |
| **C7** | 建议的落地顺序 | **① 先打通 VMD 播放通道（用已转好的 Idle/Taunt，0.5–1 天）→ ② 补走路/坐/反应动作（reze-rig + 用户账号获取，1–2 天）→ ③ 用 Blender 回路做自定义姿态（窗沿坐/摸头等 VPD，并行 0.5–1 天）→ ④ 可选：MiPo 摄像头定制动作 / Mate-Engine Unity 烘焙。** | §3/§8 |

> **一句话**：**「动作」这一层不用再手调了** —— MMD VMD 是 three r171 原生支持的格式，`reze-rig` 解决了「任意人类动作 → VMD（以本 PMX 为目标）」的重定向，`MiPo` 解决了「没有动捕设备」，`Blender+dsh-blender-plugin` 解决了「可视化摆姿」。剩下的是**接线与素材获取**，不是动作设计。

---

## 1. 本轮本机实测（不是查资料）

### 1.1 reze-rig：humanoid FBX → VMD（MIT，已跑通）

- 仓库：[AmyangXYZ/reze-rig](https://github.com/AmyangXYZ/reze-rig)（MIT），浏览器内上传 FBX → 选 PMX → 预览 → 导出 VMD；另有 node 端批处理 `scripts/fbx2vmd.ts`。
- 本机验证方式：最小 npm 目录只装 `reze-engine@0.68.10`（MIT）+ `esbuild` + `pako`，用 `esbuild` 打包 `fbx2vmd.ts` 为单文件 CLI，以**我们的优化版 PMX** 作 `--target-pmx`（CLI 会实测 PMX 骨骼世界坐标/比例/尺度）：
  ```
  target skeleton: measured from .../星穹铁道—砂金·戏浪.pmx
  [retarget] "Mvm_Idle": UE / Unity, scale=0.1360, 51 mapped (47 aligned)
  Idle.vmd  (533 KB)   Taunt.vmd (504 KB)   Run_Lfoot.vmd (123 KB)   Arms Down.vmd (12 KB)
  ```
- **兼容性实测**（mmd-parser 1.1.4，与 r171 MMDLoader 同源）：4 个 VMD 均为 **54 条骨轨道、54/54 命中本模型骨骼名（0 missing）**，含 `左足ＩＫ/右足ＩＫ`（脚 IK 帧）、`センター` 位移在 ±1 模型单位内（`--in-place` 生效）。样例源 FBX 无 blendshape 故无 morph。
- **观感实测**（独立预览器渲染）：`Idle`（3.00s 循环，30fps）正/侧/45° 接触表显示自然站立、重心左右转移、手臂放松、脚贴地；`Taunt`（2.83s）是挑衅/跺脚手势；`bear_walk.vmd`（38s 多段，需裁剪）侧视走路循环有正常的腿摆动/脚掌滚动/手臂反相。
- 截图：`tests/tmp/preview/Idle/contact-sheet.png`、`tests/tmp/preview/bear_walk-side/contact-sheet.png`、`tests/tmp/preview/Taunt/contact-sheet.png`（gitignore）。
- 结论：**「外部动作 → 本模型可直接播放」这条路已在事实层面跑通**（不是方案推演）。

### 1.2 独立预览器（candidate 验证工具，已实跑）

- `scripts/anim-pipeline/preview/`：Electron + three r171，加载 `assets/model/optimized/` 的 PMX（透明背景、贴图正确），可加载任意 VMD/VPD，指定帧号列表与相机角度（front/side/45/back），输出 PNG + 接触表 + `metadata.json` + `compatibility.md`，自动退出。
- 自动断言项：骨骼轨道交集/缺失、帧率/时长、`センター` 位移范围、`足ＩＫ` 轨道、脚底漂移（浮空/陷地帧数）、是否有 IK 开关段、运动量（证明骨架真的在动）。
- 用途：**以后任何动作包先过这个预览器再谈接入 app**，不再用「数值看起来对」当验收。

### 1.3 Blender 可视化回路（已实跑）

- Blender **4.2.23 LTS**（arm64，无 sudo/无 Homebrew，装在仓库外 `/Volumes/4TB外置盘/deepseek-harness/tools/blender/`）+ MMD Tools **v4.5.14**（Blender 扩展）。
- 实测：无头导入本 PMX 成功（434 骨含 dummy/shadow、32,828 顶点、39 材质、83 morph、23 贴图 0 缺失）；**正交四视图 Workbench 渲染 0.2s/张真实出图**；pose JSON（骨旋转/平移/表情）→ 前后对比图；**VPD 导出 roundtrip 最大角误差 0.04°**。
- three r171 消费 VPD 的实测约束：**只吃 bone-only VPD**；含 `Morph` 块或科学计数法数字会让 `parseVpd` 抛错；编码 cp932 → `loadVPD(url, false)`。用真实 three@0.171.0 语义回放与 Blender 姿态最大误差 9.8e-8 m（骨名 5/5 命中）。
- 可复用脚本：`scripts/anim-pipeline/blender/{install-blender.sh, render_views.py, verify_vpd.mjs, make_contact_sheet.py, poses/example-pose.json}`。

### 1.4 无动捕设备方案实测

- **Reze MiPo**（[AmyangXYZ/MiKaPo](https://github.com/AmyangXYZ/MiKaPo)，GPL-3.0）：浏览器 MediaPipe Holistic 实时动捕 → 逐帧 30fps 导出 VMD，驱动 MMD 骨骼 + `まばたき/あ/ワ/ウィンク` morph + 视线；对任意 PMX 自动标定 rest。本机 `npm ci`（561MB）+ `npm run build` 通过、服务可起。**纯 FK 腿、无脚 IK → 走路会滑，不适合走路；适合待机/坐姿/反应**。
- **macOS 原生 Vision 3D body pose**（零安装 Swift 探针）：真人视频 309/313 帧检出、17 关节、无脚趾/手指，可作离线兜底；但半身图也会返回高置信 17 关节（会脑补下半身），**不能盲信**。
- 视频动捕云服务（2026-11 现状）：Rokoko Create/Mixamo/Plask/DeepMotion 都需账号，免费额度测算见 mocap-options §6（4 类动作含重试 ≈74s：Plask 15s/天分 2–3 天够、DeepMotion 60s/月刚好一次、Rokoko Vision 30s/月不够、Move One 不够）；RADiCAL 已被 Autodesk 收购；Cascadeur 无 macOS 版；GVHMR/WHAM/TRAM 在 macOS arm64 上因 CUDA/PyTorch3D/SMPL 注册不可实用。
- **官方 PV/待机 GIF 做动捕 = 否证**：wiki GIF 是 400×540 半身特写，不可用；视频只作「参考素材」（见 [anim-reference-v2.md](anim-reference-v2.md)）。

---

## 2. 可用动作来源全景

| 来源 | 格式 | 质量/适配 | 授权（本地个人用） | 获取门槛 | 推荐度 |
|---|---|---|---|---|---|
| **reze-rig 转 Mixamo** | FBX → VMD | 专业级人类动作；可挑 Idle/Walk/Sit/Taunt | Adobe 条款：可免费用于项目，**禁再分发原始动画** | Adobe 账号（国内可能需要外区） | ★★★★★（走路/坐姿首选） |
| **reze-rig 转 Rokoko Create** | 文本生成 FBX → VMD | 免费 5 clips/月，适合 idle/sit/反应 | 服务条款（需核对） | Rokoko 账号 | ★★★★（0 成本补缺） |
| **BOOTH 第 91/22 弹（デジタルモーション）** | FBX 30fps → VMD | **20 个男性待机/20 个酷男性动作**（含跪姿），最贴角色 | 允许改変+本地个人使用+个人商用（署名），禁可提取形式再配布 | ¥2,000/包；BOOTH(pixiv) 账号+支付 | ★★★★（待机素材最对味） |
| **名もなきモーション（東映ツークン研究所）** | FBX 60fps + BIP → VMD | VICON 采集、首尾平滑循环；含「立っている人③(若者/男性)」「ごあいさつ」 | VN3 模板（需人工读 PDF；通常允许个人/视频、禁再配布） | BOOTH 登录（¥0 样本） | ★★★ |
| **Reze MiPo 摄像头/视频** | VMD（原生） | 可自定任意待机/坐/反应；走路需 FK 腿（滑） | GPL-3.0 代码；产出归自己 | 0（浏览器/本地） | ★★★（定制动作） |
| **MMD 配布（BowlRoll / ニコニ・コモンズ）** | VMD | 走路/待机/坐姿有，但多为女性/舞蹈 | 逐文件作者条款，多数禁再配布 | 账号/下载键，部分已失效 | ★★（需用户登录淘宝） |
| **three.js 官方示例** | VMD/VPD | 舞蹈 + 11 个姿势；骨覆盖 23/29 | 非 MIT；MMD 资产不可再分发 | 0 | ★（只作测试/姿态参考） |
| **bear0830/mmd（GitHub）** | VMD | walk 26/29 标准骨、原地、38s 多段 | 无 LICENSE → 默认保留所有权利，仅本地测试 | 0 | ★（只作验证素材） |
| **Mate-Engine `.anim`** | Unity Humanoid muscle | 109 个非舞蹈宠物片段（窗沿坐/躲藏/拖拽/摸头） | 个人非商用+署名、不再分发 | 需 Unity 烘焙（3–5 人日） | ★★（VMD 不够时启动） |
| **YUI / VRMA** | `.vrma` glTF humanoid | 49 个（idle/walk/sit/head_pat…），但授权链来自 Mate-Engine/Mixamo，**不干净** | 不可搬运 | — | ✗（仅语义参考） |
| **CMU MoCap / AMASS** | BVH/SMPL | 真人质量，风格需调 | 学术许可 | 需 BVH→FBX→reze-rig 或重定向 | ★★（免费走路备选） |
| **砂金官方动作** | 需游戏文件提取 | 最贴角色（idle/walk/待机） | 游戏资产版权 | 需 Windows + HSR 本体 + SRStudio → FBX → reze-rig | ★★（有条件才做） |

**直接可播 vs 需要处理**：
- **零转换可直接播**：`tests/tmp/motions/converted/{Idle,Taunt,Run_Lfoot,Arms Down}.vmd`（54/54 骨命中）；`bear_walk.vmd`（裁一个循环后可用，授权仅本地测试）。
- **需转换**：Mixamo / Rokoko / BOOTH / 名もなき（FBX→VMD，reze-rig 秒级）。
- **需重定向**：Mate-Engine `.anim` / `.vrma` / BVH（≥1 人日/类）。
- **只有静态姿态**：VPD（three 示例 / Blender 导出），只能做一次性 pose 或过渡帧。

---

## 3. 推荐落地路线

### 3.1 路线 A（最先做，0.5–1 天，0 外部依赖）：打通 VMD 播放通道

1. 在 animation 层新增「外部动作源」抽象（VMD/VPD），**不改 B3 的 poses/gestures 数据**：
   - 载入：`MMDLoader.loadVMD` → `AnimationClip`；`MMDLoader.loadVPD` + `MMDAnimationHelper.pose` 做静态姿态。
   - 播放：优先用 r171 自带 `MMDAnimationHelper`（physics:false），或自研轻量采样器（把 VMD 采样成每骨 quat，便于与 B3 的 blend 层统一）。
   - 状态映射：`idle → Idle.vmd`、`walk → Walk.vmd`、`sit → Sit.vmd/VPD`、`pat/drag → 对应 VMD`；**没有对应 VMD 的状态回退 B3 程序化姿态**（climb/sleep/fall 等）。
2. 用已转好的 `Idle.vmd` 先替换当前 idle 站姿（最小可视化验证），跑冒烟（`pnpm smoke`）+ 实机看 10 秒。
3. 关键接线坑（已实测/源码确认）：
   - **互斥**：`MMDAnimationHelper.add(mesh, {animation})` 后每帧会 `_restoreBones`+IK/grant 覆盖全骨；与 B3 直写骨骼**必须二选一**（用开关：有帮助器时不跑 B3 skeleton 写入；否则反向）。
   - **IK 语义**：VMD 的 IK 开关帧 r171 **不消费**。带足ＩＫ轨的 VMD（reze-rig 默认）→ `helper.enable('ik', true)`（CCDIK 解脚、负责落地）；纯 FK VMD（MiPo）→ `helper.enable('ik', false)`（防止 CCDIK 把腿拉坏），grant 都保持 true（D 链腿跟随）。
   - **root/贴地**：VMD `センター` 有可见位移（走路 Y −0.66…−0.04，个别 Z 漂移），要像 B3 一样做「归零/贴地补偿 + 保留竖向 bob」；脚底漂移实测 0.5–1.4 单位（13–34px@540px），需按帧做最小二乘/脚底钳制。
   - **走路速度**：VMD 是原地循环 → B2/B1 移动速度要与步频匹配（按 clip 步幅换算 `timeScale`，或锁移动速度到 clip 速度），否则滑步。
   - **表情**：VMD morph 轨道（若有）会被 helper 写；B3 的眨眼/情绪在 helper 之后写（覆盖优先级需固定），材质 morph 仍由现有 `MaterialMorphController` 处理。
   - **朝向**：B2 的 `facing`（±90°）作用在 `modelRoot`，VMD 在模型局部空间 → 兼容。
4. 验收：`pnpm smoke` + `pnpm smoke:file` + 实机 10s 观感（用户看），预览器三视图留档。

### 3.2 路线 B（1–2 天，需要用户账号/小额付费）：补齐动作素材

按性价比排序（详见 [motion-assets.md](research/motion-assets.md) §7 与 [mocap-options.md](research/mocap-options.md) §6）：
1. **Mixamo（免费，需 Adobe 账号）**：Idle、Walking、Slow Walk、Sitting/Standing Idle、Taunt/Shrug 等 → `reze-rig` 转 VMD（以本 PMX 为目标）。**走路/坐姿质量最高**。
2. **Rokoko Create（免费 5 clips/月）**：文本生成 idle/sit/reaction 的 FBX → reze-rig。
3. **BOOTH 第 91 弹（¥2,000）**：20 个男性待机，挑 3–5 个（待機/腕組み/腰に手/髪型を直す…）→ reze-rig；角色气质最贴（砂金=从容/赌徒/戏谑）。
4. **B 站同人砂金动作（免费/需登录）**：BV1uv421y7v9（微云 `share.weiyun.com/zQxZHodg` 密码 `[已脱敏]`，需 QQ/微信登录）→ 先确认文件格式（疑 VMD/MMD 工程），能下再评估。
5. **备选**：名もなきモーション免费样本（需 BOOTH 登录）、CMU BVH（免费但多一步 Blender→FBX）。

### 3.3 路线 C（并行 0.5–1 天）：Blender 可视化回路常态化

- 用已装好的 Blender 4.2 + MMD Tools + `scripts/anim-pipeline/blender/render_views.py`，把「改一个数字 → 四视图/接触表 → 对比参考」固化成流程；
- **自定义姿态**（VMD 素材没有的）：窗沿坐（按窗口高度调）、摸头反应、被拖拽/甩出、睡觉、爬窗——用 Blender 摆姿 → 导出 **bone-only VPD**（或整段 VMD）→ 回灌 app；
- 若确认要用 `dsh-blender-plugin`：装到**独立 DSH profile**，跑官方验收 `doctor.kind=ok`（GUI）或 `worker start + see`（无头），再用于「AI 驱动 Blender 出图」的迭代（本机 Blender 路径已就绪，需显式配 `DSH_BLENDER_EXE`）。

### 3.4 路线 D（可选）：定制动捕

- **MiPo**：浏览器打开 `mipo.reze.one`（或本机 `npm run dev`）→ 上传 PMX 文件夹 → 摄像头/视频捕捉 → 导出 VMD。适合**待机/坐姿/摸头反应**这类原地短动作（0 账号 0 元）；
- 或 **Rokoko Create / Plask / DeepMotion** 出 FBX → reze-rig → VMD（走路优先走这条）；
- **不推荐**：官方 PV 动捕（素材不合格）、开源 CUDA 系视觉动捕（macOS 不可用）、macOS Vision 自研（17 关节，2–4 天，仅离线兜底）。

---

## 4. 与现有 B3 的接线设计（Wave 2.5 实施要点）

> 原则：**B3 的 poses/gestures 数据一行不改**；新增的「外部动作层」与 B3 并列/互斥，由动画门面调度。

```
PetAnimator（现有对外接口不变）
 ├─ 外部动作层（新）  VMD clip 播放 / VPD 静态姿态
 │    └─ 每帧输出：{ boneQuats, centerOffset, morphWeights?, rootMotion? }
 ├─ B3 程序化层（现有）poses/gestures/micro-motion/IK/spring/表情（缺 VMD 的状态回退）
 └─ 调度：state → source（vmd|procedural），固定混合权重与顺序
```

- **互斥开关**：VMD 播放时关闭 B3 的骨骼写入与解析 IK（避免双写）；表情/眨眼/注视可由 B3 继续叠加（在 VMD 之后写 morph，或 VMD 无 morph 时完全由 B3 管）。
- **贴地补偿**：VMD 的 `センター` 竖向 bob 保留，水平漂移归零；按帧算脚底最低点做整体抬高（参考 B3 的 grounding 思路，纯函数可单测）。
- **动作切换**：用 clip 之间的 120–250ms 交叉淡化（quat slerp），与 B3 现有过渡风格一致。
- **调试面**：`__aventurineDebug` 增加 `animationSource` / `vmdClip` / `footErrorPx`，供冒烟断言。
- **无 VMD 的状态**（climb/sleep/fall/drag 等）保持 B3 程序化，后续逐步用 VPD/VMD 替换。

---

## 5. 验收标准（取代「数值有变化」）

1. 每个新动作在预览器出 **front/side/45° 接触表** + `compatibility.md`（骨骼/IK/脚底漂移）；
2. app 内实机 **10 秒观察**（用户），重点：站立是否自然、走路有无滑步/膝反关节、坐姿是否稳、手臂是否穿插身体；
3. `pnpm typecheck` / `pnpm test` / `pnpm smoke` / `pnpm smoke:file` 全过；
4. 素材/动作进入 `CREDITS`（作者/URL/许可证），不随 app 分发、不提交仓库。

---

## 6. 授权与合规（本地个人自用前提）

| 资产 | 本地个人用 | 改変/转 VMD | 再分发/嵌入分发 | 商用 |
|---|---|---|---|---|
| 本项目 PMX 模型（miHoYo/流云景/Lily0725） | ✅ | ✅ | ❌ | ❌ |
| reze-rig 代码（MIT）/ MiPo（GPL-3.0 代码） | ✅ | ✅ | 按许可证 | 按许可证 |
| Mixamo 动作 | ✅ | ✅ | ❌（禁再分发原始动画） | ✅（Adobe 条款） |
| BOOTH デジタルモーション | ✅ | ✅ | ❌（禁可提取形式再配布） | ✅ 个人商用需署名 |
| 名もなきモーション | ✅（VN3 模板，需人工读 PDF） | ✅ | ❌ | 以 PDF 为准 |
| MMD 配布（BowlRoll 等） | 视各文件规约 | 视规约 | 大多 ❌ | 视规约 |
| Mate-Engine `.anim` | ✅（署名 Shiny） | ✅ | ❌ | ❌ |
| three.js 示例 VMD/VPD | ✅（研究） | ✅ | ❌ | ❌ |

结论：所有外部动作**只本机自用、不提交、不随 app 分发**；用户购买/下载后放 `tests/tmp/motions/`（已 gitignore），README/CREDITS 记录来源。

---

## 7. 风险

| 风险 | 缓解 |
|---|---|
| 下载素材「授权表面 OK、实际作者不许」 | 只本地自用不分享；优先 BOOTH/Mixamo 等条款明确来源；逐文件记录作者/条款 |
| 女性动作包套男性角色气质不符 | 优先男性动作包（BOOTH 91/22、Mixamo male idle）；预览器先看接触表再决定 |
| VMD 脚底漂移/滑步 | 接入时做贴地补偿 + 走路速度匹配（§4）；预览器已能量化漂移 |
| `MMDAnimationHelper` 与 B3 互斥/表情覆盖顺序 | 新动画门面统一调度，开关+单测锁定行为 |
| VPD 导出的兼容坑（Morph 块/科学计数法/cp932） | 只导出 bone-only VPD、`loadVPD(url,false)`；BLENDER 回路已实测 |
| 免费渠道失效/需登录 | 需要用户操作的清单已列；先做不依赖外部账号的路线 A |
| 用户不接受「买动作包/注册账号」 | 至少有 0 账号路线：已转好的 Idle/Taunt + MiPo + Blender 自摆 VPD |

---

## 8. Wave 2.5 任务分解（建议）

| ID | 任务 | 依赖 | Scope | 验收 |
|---|---|---|---|---|
| **D1** | VMD/VPD 动画源接入 + 与 B3 互斥门面 | 无（用已转好的 Idle/Taunt） | `src/renderer/src/animation/**`（新增 `external/` 或 `clip/`）、`src/renderer/src/scene/pet-scene.ts`（接线点）、`core/wave2-contract.ts`（如需扩展调试快照） | idle 换成 Idle.vmd 后实机 10s 观感通过；`pnpm smoke` 断言 `animationSource='vmd'`、脚底误差、骨骼无 NaN |
| **D2** | 动作素材获取与批量转换（reze-rig CLI 固化） | D1（可并行准备） | `scripts/anim-pipeline/reze/`（新增转换脚本/文档/CREDITS 模板） | Idle/Walk/Sit/Taunt 各≥1 个 VMD 通过预览器；授权记录完整 |
| **D3** | 走路循环接入（速度匹配 + 贴地补偿） | D1、D2 | 同上 + B1 步速接口（只读取，不改 B1 逻辑） | 侧视接触表无浮空/陷地；实机走 10s 不滑步/不膝反 |
| **D4** | 坐姿/窗沿坐 + 摸头/拖拽反应（VPD/VMD） | D1、D3 | `animation/external/**` + `scripts/anim-pipeline/blender/**` | 三视图 + 实机场景（窗口上沿）验收 |
| **D5** | Blender 可视化调参回路常态化 + （可选）dsh-blender-plugin 安装验收 | 无 | `scripts/anim-pipeline/blender/**`、独立 DSH profile | `doctor.kind=ok` 或 worker 出帧；自定义姿态→VPD→回灌闭环 |
| **D6** | 参考 beat 表驱动的观感验收 | D3、D4、`docs/anim-reference-v2.md` | 验收文档/截图 | 每姿态三视图 + beat 对照 + 用户实机通过 |
| **D7**（可选） | MiPo 定制动捕 / Mate-Engine Unity 烘焙 | D6 后仍不足时 | 独立 | 补足 VMD 缺失的宠物专属动作 |

> 依赖关系：D1/D2/D5 可并行；D3/D4 在 D1+D2 之后；D6 最后；D7 仅在 VMD 路线仍不足时启动。

---

## 9. 需要用户拍板 / 操作的事项

1. **是否按「路线 A 先打通 VMD 通道」进入 Wave 2.5 编码**（预计 0.5–1 天出可看效果）。
2. **动作素材**（可选其一或多选）：
   - Adobe/Mixamo 账号（免费）→ 下载 Idle/Walking/Sit 等；
   - BOOTH 购买第 91 弹「自然に待機する男性」¥2,000（20 个男性待机）与/或第 22 弹；
   - 登录微云确认 B 站 BV1uv421y7v9 的砂金动作配布内容；
   - Rokoko Create 免费 5 clips/月（文本生成动作）。
3. **是否安装 `dsh-blender-plugin@3.0.6`**（装独立 profile 验收；用于 AI 驱动 Blender 摆姿出图，需批准）。
4. **是否接受**用 Mixamo/BOOTH 等外部动作（本地自用、不再分发）——授权已核对，不会随 app 分发。
5. 是否允许继续使用已安装的 Blender 4.2（仓库外 `/Volumes/4TB外置盘/deepseek-harness/tools/blender/`）与保留 `scripts/anim-pipeline/` 工具脚本。

---

## 11. 实施进展（2026-11-08 凌晨，用户拍板后）

| 项 | 状态 | 关键结果 |
|---|---|---|
| D1 VMD 外部动作层 | ✅ | `animation/external/**` + `createHybridAnimator`；VMD 激活时 B3 仅写 morph；无清单/失败全量回退；调试快照 `source/clipId/clipTimeSec/externalFootErrorPx/externalIk/externalPlaybackRate` |
| D2 零成本素材 + reze-rig 管线 | ✅ | `scripts/anim-pipeline/reze/`（MIT 原样 + build/convert/glb2fbx）；`motion-idle.vmd`（54/54 骨、3s 循环）、`motion-walk.vmd`（51/51、1.03s 原地完美循环）、`motion-taunt.vmd`（54/54、2.83s） |
| D3 走路速度匹配 | ✅ | 体高相对自然步速（540px→470px/s、0.87 体高/秒 × 档位系数）；VMD nominal 按宠物高度换算 → 任意 sizePercent 播放速率=档位系数，不滑步；实机实测 `velocity=470px/s`、`rate=1.0`、脚底误差 0 |
| 实机验收 | ✅（自动+截图） | `pnpm smoke`/`smoke:file` exit 0 且 `source='vmd'`/idle `externalFootErrorPx=0`；`tests/tmp/wave25-idle/idle-strip.png`、`tests/tmp/wave25-walk-after2/walk-strip.png` |
| D4 坐姿/反应 + look-at | ✅ | sit = Mixamo `Sitting Clap`→`motion-sit.vmd`（54/54、5.67s 循环、坐面 Y≈−4.7）；反应 salute→dshDone / surprised→dshError；manifest 3→6；additive look-at（头颈 30%/眼 100%，facing 局部化/±31°/90ms/2.5s 回落）实机 ±25° 对称生效；manifest 新增 `grounding: feet\|none`。**D4c** 修正 sit approach：接近阶段动画层改 walk/climb（`PetRuntime.animationMoodFor`），落座后再 sit（B1 mood 不变）。**D4d** VPD 工具链闭环：`scripts/anim-pipeline/reze/vpd2vmd.mjs`（零依赖，兼容 MMD 单行与 Blender 多行 VPD/cp932/科学计数法）→ 单帧 VMD；实机 Blender VPD→VMD→预览器 5/5 命中。**D4e** 拖拽反应：`motion-drag.vmd`（Mixamo Shoved Reaction With Spin 4.53s，54/54）→ moods `drag`，manifest 6→7 clips；摸头=taunt、拖拽=被甩反应，均真实人类动作。**D4f** 走路换成 Mixamo 标准 Walk（0.967s、更自然，nominal 490、实测滑步<5%）。 |
| D5 Blender 回路 | ✅ 工具就绪 | Blender 4.2.23 + MMD Tools 实测可导入/渲染/VPD；`dsh-blender-plugin` 待用户批准安装 |

> 已知限制（如实记录）：① 发辫/袖摆/布料静态（physics:false，未引入 ammo.js）；② B3 的 6 个 idle 手势在 VMD idle 下不可见（骨骼写入互斥；后续用独立 VMD 反应片段或 additive 层补）；③ 走路 clip 来自 Mixamo 军事角色，气质偏硬、可替换；④ sit approach 已由动画层修正（walk/climb→sit），仍缺真正的「坐下/起身」过渡片段（下次有素材再补）；⑤ look-at 为 additive 近似（头颈仅 30%，大角度不如 B3 自然）；⑥ 动作文件/清单在 gitignore 的 `assets/model/`，干净 clone 无动作素材时自动回退 B3（冒烟跳过相关断言）。

---

## 10. 证据索引

| 内容 | 路径 |
|---|---|
| 4 仓库审计 / Mate-Engine 128 动画清单 | `docs/research/repos-audit.md`、`tests/tmp/repo-audit/` |
| MMD 动作包渠道/解析/授权 | `docs/research/motion-assets.md` |
| 无动捕方案（MiPo/reze-rig/服务矩阵/额度） | `docs/research/mocap-options.md` |
| Blender 回路实测（安装/渲染/VPD/three 兼容） | `docs/research/tooling-blender.md`、`tests/tmp/blender-probe/` |
| 动作预览器（VMD/VPD 兼容性工具） | `docs/research/vmd-preview-tool.md`、`scripts/anim-pipeline/preview/` |
| 官方/真人参考素材与 beat 表 | `docs/anim-reference-v2.md`、`tests/tmp/ref2/` |
| 已转好的 VMD（本地验证用，gitignore） | `tests/tmp/motions/converted/` |
| 预览截图/接触表 | `tests/tmp/preview/` |
| 可直接复用的工具脚本 | `scripts/anim-pipeline/blender/`、`scripts/anim-pipeline/preview/` |
