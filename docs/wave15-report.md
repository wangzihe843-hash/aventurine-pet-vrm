# Wave 1.5 完成报告：Unity 烘焙 Mate-Engine 动作（U2/U3）

> 日期：2026-11-08（Asia/Shanghai） · 状态：**U2/U3 已完成**（待用户实机/观感确认）
> 目标：把 Mate-Engine 的 Unity Humanoid `.anim`（128 个）批量烘焙为 25–35 个宠物专属 clip，产出可复跑管线 + 冻结数据契约 + 三份验收清单证据，并接入 app 私有的 `assets/motions/mate/**`。
> 证据目录：`tests/tmp/wave15/`（gitignore，不提交） · 工具：`scripts/unity-bake/**`
> 关联文档：`docs/unity-bake-report.md`（U0/U1 环境与首批导出）、`docs/anim-acceptance.md`（v1 时代验收清单）、`PLAN.md` §5 Wave 1.5。
> **2026-11-08 追加：手指补全** —— 本报告描述的 U2/U3 原数据只含 **22 根核心骨**，源 `.anim` 里 40 条手指 muscle 曲线被裁掉；
> 现已用 Unity+UniVRM 真实 VRM avatar 手指探针补回 **30 根手指**（每 clip 52 骨），并通过 Unity GT 数值对拍、参考视频对比与手部特写视觉验收。
> 完整调查/方案/证据见 **[docs/wave15-fingers-report.md](wave15-fingers-report.md)**。

---

## 0. 摘要

| 项 | 结果 |
|---|---|
| 环境 | Unity **6000.2.6f2** + Hub 自带 `unity` CLI（license 有效至 2026-11-18）；Electron 无头预览；无需 Blender 重定向 |
| 管线 | Unity 合成 humanoid 骨架采样 `.anim` → 归一化旋转 JSON（22 骨 + Hips 位移）→ three-vrm normalized 骨骼回放 |
| clip 交付 | **29 个**（要求 25–35），8/8 类别覆盖达标；`assets/motions/mate/**` + `index.json` + `manifest.json`（canonical/mirror），私有 gitignore |
| 手指补全（追加） | 29 clip 全部补 **30 根手指**（22 核心 + 30 手指 = 52 骨/clip）；`validate-clips` 29 PASS；GT 手指段方向误差典型 1.8–2.5°；详见 [docs/wave15-fingers-report.md](wave15-fingers-report.md) |
| 数据完整性 | `validate-clips` **29 PASS / 0 WARN / 0 FAIL**（errors 0/warnings 0）；manifest `--check` PASS |
| 自然度 | **W1.5-Tpose 重制版**（`aventurine-tpose.vrm`）全 29 clip 逐帧 metrics：**PASS 23 / WARN 6 / FAIL 0**；WARN 均为动作意图/摆位（侧移/膝屈/脚部跳变），无结构 FAIL（§4.3） |
| 姿态一致性 | 「原角色 Zome / 官方演示参考帧 / Unity+UniVRM 引擎 ground truth」三方对拍（§5）：**动作数据转换判定忠实**；期间定位并修复 **P0 合成骨架左右手性 bug**（重烘焙后手臂关节误差 40–60°→~1°）、hips 缩放 bug、腿部蒙皮/层级问题（legfix），以及 **T-pose 模型 + clip 坐标约定问题**（PMX→VRMify 重转规范 T-pose，GT 同模型 ΔW 102°→**3.44°**；见 §5.4/5.5、`docs/vrm-tpose-repair.md`） |
| 测试 | `pnpm test` **82 files / 1383 passed / 14 skipped**（基线 75/1263/14，新增 7 文件/120 测试）；`pnpm typecheck` exit 0；**无回归** |
| 去重 | 删除源数据重复的 hover*/walkRight/hideRight；补入真正不同的 walkAlt / hideOnce（§3.2） |

---

## 1. 环境与管线（相对 PLAN 的调整）

### 1.1 环境

- Unity **6000.2.6f2**（Apple Silicon）已装并激活 Unity Personal（`unity license --json` 可查，expires 2026-11-18）；
- 采用 Unity Hub 自带 **`unity` CLI** 驱动 batchmode：`unity run <project> --timeout 900 --no-tail -- -executeMethod … -logFile …`（batchmode/quit 由 CLI 自动加）；CLI 不可用时回退直接调用 Unity 二进制（`scripts/unity-bake/run-export.sh` 已实现两条路径 + `unity license --json` 授权 preflight）；
- 预览用 Electron 无头抓帧：内置 `--no-sandbox` + 工作区 `--user-data-dir`（本机 DSH 沙盒下必需）。
- 权限说明：Unity 需要写工作区外的许可证/缓存目录（`~/Library/Application Support/Unity`），在受限沙盒下会报 "Project folder or disk is read only"；本次执行在放开文件权限的会话中运行。

### 1.2 与 PLAN 的差异（为什么不需要 Blender retarget）

PLAN 原定 U2 = «Blender 重定向到目标 VRM»。实际路线改为 **Unity humanoid 归一化空间直采**：

- 原始 `.anim` 是 **Unity Humanoid muscle clip**（不是骨骼局部旋转），只能在 Unity/Unity Avatar 里求值；
- U1 已证明：在最小 Unity 工程里用 `AvatarBuilder.BuildHumanAvatar` 合成标准 T-pose 骨架 + `AnimationMode.SampleAnimationClip` 逐帧采样，可得到**与具体模型无关的归一化局部旋转**（相对 rest 的四元数）+ Hips 位移；
- three-vrm 的 normalized humanoid 骨骼就是 VRM 规范的同一类归一化 T-pose 空间，`humanoid.update()` 负责 normalized→raw。因此**不需要 Blender 中转**，采样 JSON 可直接回放到任意 VRM（戏浪/canary/Zome/DLC 角色）。
- 这一路线下 U2 的「重定向」实质 = **数据契约 + 归一化映射 + 回放验证**；`retarget.py` 不再需要，改由 `scripts/unity-bake/lib/humanoid-map.mjs`（22 骨映射）+ 验证工具承担。
- 说明：PLAN D9 的「legacy/VRMA」选项仍保留；本 wave 不产出 `.vrma`，`V10` 接入时由 V-lane 的 clip player 直接消费本 JSON（或在需要时再转 VRMA）。

### 1.3 坐标系与校准（U1 结论沿用）

- Unity 左手系 → glTF 右手系：**反射一个轴**，反射轴由目标模型朝向决定：`--axis z` 适配**面向 -Z / VRM0 风格**的旧模型（canary、Zome、旧 waveflair），`--axis x` 适配**标准 VRM 1.0**（面向 +Z、左手 +X，当前 `aventurine-tpose.vrm`）。两者相差一个绕 Y 的 180° 约定；早前只试过 z 并把 x 判为「手臂翻转」，实为模型朝向不同（见 §5.4、`docs/vrm-tpose-repair.md`）；
- Hips 位移用 **`--hips-mode relative`**：Unity humanoid 重定向到合成骨架会带 0.2–0.4m 常驻偏移，减去首帧基准后 idle/walk 才居中；坐/躺/悬空的绝对高度交给 app 场景摆放；
- 循环 clip 不重复末帧，交给 player loop；
- **左右手性**：Unity 左手系（X 右 / Y 上 / Z 前），角色面向 +Z 时 **Left 在 -X、Right 在 +X**；初版合成骨架把 Left 放在 +X（左右镜像），导致手臂 normalized 旋转手性错误（GT 实测手臂差异 166°）；已修正并重烘焙（见 §5.3/§5.4）。

---

## 2. U2 交付：clip 数据契约与工具链

### 2.1 数据格式（`assets/motions/mate/<clip>.json`，私有 gitignore）

```json
{
  "version": 1,
  "clip": "idle",
  "mood": "idle",
  "loop": true,
  "fps": 30,
  "duration": 2.45,
  "sourceHeight": 1.7,
  "space": "gltf-rh",
  "frames": 74,
  "bones": {
    "Hips":  { "r": [[x,y,z,w], ...], "p": [[dx,dy,dz], ...] },
    "Spine": { "r": [[x,y,z,w], ...] }
  }
}
```

- `r`：相对归一化 rest 姿势的旋转（已经 glTF 右手系、反射 Z、连续性修正、单位化）；**播放侧直接写到 three-vrm normalized bone node 的 quaternion**，再 `humanoid.update()`；
- `p`：仅 Hips，已减去首帧基准（米）；播放时加到 normalized hips 的 rest 位置，按 `modelHeight/sourceHeight` 缩放；
- 22 核心骨：Hips/Spine/Chest/UpperChest/Neck/Head/左右肩/上臂/前臂/手/大腿/小腿/脚/趾（Unity `HumanBodyBones` 标准子集）；
- **30 手指（2026-11-08 追加）**：左右各 15 根（Thumb 3 + Index/Middle/Ring/Little 各 3），来自 Unity 真实 avatar 手指探针 +
  normalized 公式合并；clip JSON 里是可选骨（有则回放），详见 [docs/wave15-fingers-report.md](wave15-fingers-report.md)。

### 2.2 新增工具（全部在 `scripts/unity-bake/`，dev-only）

| 工具 | 作用 |
|---|---|
| `lib/humanoid-map.mjs` | Unity `HumanBodyBones` ↔ VRM normalized 骨名 **52 映射**（22 核心 + 30 手指；纯 ESM，浏览器/Node 共用；单测与 `src/shared` 契约同步断言） |
| `lib/clip-validation.mjs` | clip 数据校验/统计纯函数（结构、四元数单位化/连续性、frames↔duration、Hips 位移、循环接缝、帧跳变） |
| `lib/motion-manifest.mjs` | 由 selection（`clips.json`）+ clip 数据构建 motion manifest；覆盖率/槽位/去重/`--check` 一致性 |
| `validate-clips.mjs` | PASS/WARN/FAIL 表 + JSON 报告（默认 `assets/motions/validation-report.json`） |
| `build-motion-manifest.mjs` | 写 canonical `assets/motions/mate/manifest.json` + mirror `assets/motions/manifest.json`；`--check` 只校验 |
| `preview-clips.mjs` / `preview-electron.mjs` / `clip-viewer.js` | 无头 Electron 把 clip 应用到 VRM 抓帧；`--all/--out/--metrics/--yaw/--sheet`；逐帧自然度 metrics（世界空间骨位置 + 贴地/脚跳/接缝/帧跳变/膝屈/Hips 位移等） |
| `contact-sheets.mjs` | sharp 拼接触表（每 clip 4 帧）+ 全 clip 首帧总览 |
| `run-export.sh` | 一键导出：Unity CLI 优先 + license preflight + 回退二进制 + 转换（`convert-clips.mjs`） |

manifest 形状（`schemaVersion:1`）：`{set, generatedAt, source{name/attribution/license/redistribution}, defaults{loop/timeScale/fadeIn/fadeOut/rootMotion}, clips[{id,file,slot,tags,loop,timeScale,priority,duration,fps,frames,sourcePath}], coverage{tag:count}, checks{ok,errors,warnings}}`。`slot` = `PET_MOODS + salute` 契约槽位；事件类片段（intro/hiding/pose）为 `null`，由 app 事件驱动。

---

## 3. U3 交付：29 个宠物专属 clip

### 3.1 选择原则

- 来源：`refs/Mate-Engine/Assets/MATE ENGINE - Animations/`（128 个，只读参考；版权 © Shiny，仅本地个人非商用、不再分发，见 §7 授权）；
- 覆盖要求（来自 `docs/research/repos-audit.md` §6.2 + 本项目状态机需要）：待机、走路、坐/窗沿、互动反应（拖拽/摸头/开心/害羞）、睡觉、躲藏、入场、随机 pose；总数 25–35；
- 排除：全部舞蹈（PET_DANCING/HUS_DANCE/CUSTOM_DANCE/AnkhaZone）、HUS_* 男性专用、TEST_*/PLACE_HOLDER、FACE_LAYER/FACE_SMILE（blendshape-only 无骨骼曲线）、PET_BIG_SCREEN/SCREEN_SAVER、U_MOTIONS/Float，以及 `m_StopTime≈0` 的静态 pose；
- 每条 clip 静态预检：路径存在、`classID 95` 骨骼曲线 >0（排除 blendshape-only）、loop 与源 `m_LoopTime` 一致、时长与源 `m_StopTime` 一致。

### 3.2 覆盖清单（8/8 类别达标，29 ∈ [25,35]）

| 类别 | 下限 | 实际 | clip |
|---|---:|---:|---|
| idle | 6 | 7 | idle, idle2, idle3, idle4, idle5, idle6, idle7 |
| walk | 2 | 2 | walk, walkAlt |
| sit | 6 | 7 | sitWindow, windowLay8, windowLay9, windowLay10, sit2, suwari3, sit1 |
| interaction | 4 | 4 | drag, happy, laughing, shyPoint |
| sleep | 1 | 1 | sleep |
| hiding | 2 | 2 | hideLeft, hideOnce |
| intro | 2 | 3 | introLoop, introStart, introEnd |
| pose | 2 | 3 | pose1, pose2, pose3 |

### 3.3 重复数据处置（重要）

对 128 个源 clip 抽样比对时发现 Mate-Engine 的**左右镜像对在源数据里是逐帧相同的**（Animator 用 mirror flag 做镜像，直接采样无法还原），另有 blendshape-only 片段。处置如下：

| 原条目 | 发现 | 处置 |
|---|---|---|
| `hoverReaction` / `hoverFace` | 骨骼数据与 `idle` **逐帧完全一致**（hover 反馈在 blendshape/表情层） | 不烘焙；requirements 移除 `hover`。悬停/摸头表情由 VRM expression 层负责（V6/V10） |
| `walkRight` | 源 mirror flag，与 `walk` 逐帧相同 | 删除；补 **walkAlt**（`walk_cycle_sexy_02_light`，与 walk 非重复：腿/臂一致、头颈/躯干风格不同，priority=-2 默认不启用） |
| `hideRight` | 源 mirror flag，与 `hideLeft` 逐帧相同 | 删除；补 **hideOnce**（`PET_HIDE.anim`，13.98s 一次性躲藏，与 8s 循环探头互补，data distinct） |
| `talking` | `UPDATE_2/PET_TALKING` 为 **blendshape 口型层**（classID 114，骨骼曲线 0 条） | 不烘焙、requirements 不设 talking；真实口型由 VRM expression 层负责 |

### 3.4 全量 selection 表

| clip | 源 .anim | tags | slot | loop | 帧/时长 | priority |
|---|---|---|---|---|---:|---:|
| idle | PET_IDLE/PET_IDLE.anim | idle | idle | ✓ | 74 / 2.45s | 0 |
| idle2 | PET_IDLE/PET_IDLE_2.anim | idle | idle | ✓ | 400 / 13.33s | -1 |
| idle3 | PET_IDLE/PET_IDLE_3.anim | idle | idle | ✓ | 112 / 3.73s | -2 |
| idle4 | PET_IDLE/PET_IDLE_6.anim | idle | idle | ✓ | 170 / 5.67s | -3 |
| idle5 | PET_IDLE/PET_IDLE_8.anim | idle | idle | ✓ | 180 / 6.00s | -4 |
| idle6 | UPDATE_2/PET_IDLE_UPDATE2_01.anim | idle | idle | ✓ | 495 / 16.50s | -5 |
| idle7 | PET_IDLE/PET_IDLE_12.anim | idle | idle | ✓ | 104 / 3.47s | -6 |
| walk | PET_LOCOMOTION/PET_WALK_LEFT.anim | walk | walk | ✓ | 42 / 1.42s | 0 |
| walkAlt | PET_LOCOMOTION/walk_cycle_sexy_02_light.anim | walk | walk | ✓ | 43 / 1.42s | -2 |
| sitWindow | PET_SITTING/BETA_PET_WINDOW_LAY.anim | sit | sit | ✓ | 599 / 19.96s | 0 |
| windowLay8 | ME_02/WINDOW_LAY_8.anim | sit | sit | ✓ | 72 / 2.40s | -1 |
| windowLay9 | ME_02/WINDOW_LAY_9.anim | sit | sit | ✓ | 62 / 2.05s | -2 |
| windowLay10 | ME_02/WINDOW_LAY_10.anim | sit | sit | ✓ | 90 / 3.02s | -3 |
| sit2 | ME_02/PET_SIT_02.anim | sit | sit | ✓ | 194 / 6.47s | -4 |
| suwari3 | ME_02/suwari3.anim | sit | sit | ✓ | 86 / 2.85s | -5 |
| sit1 | ME_02/PET_SIT_01.anim | sit | sit | ✓ | 95 / 3.17s | -6 |
| drag | PET_MISC/PET_DRAGGING.anim | interaction | drag | — | 385 / 12.78s | 0 |
| happy | PET_MISC/PET_HAPPY.anim | interaction | pat | — | 197 / 6.55s | 0 |
| laughing | PET_MISC/PET_LAUGHING.anim | interaction | pat | — | 251 / 8.33s | -1 |
| shyPoint | PET_MISC/PET_SHY_POINT.anim | interaction | pat | — | 331 / 11.00s | -2 |
| sleep | PET_SLEEPING/PET_SLEEPING.anim | sleep | sleep | ✓ | 1055 / 35.17s | 0 |
| hideLeft | PET_HIDING/PET_HIDE_SHOW_LOOP_LEFT.anim | hiding | null | ✓ | 240 / 8.00s | 0 |
| hideOnce | PET_HIDING/PET_HIDE.anim | hiding | null | — | 421 / 13.98s | 0 |
| introLoop | PET_INTRO/PET_INTRO_LOOP.anim | intro | null | ✓ | 400 / 13.33s | 0 |
| introStart | PET_INTRO/PET_INTRO_START.anim | intro | null | — | 61 / 2.00s | -1 |
| introEnd | PET_INTRO/PET_INTRO_END.anim | intro | null | — | 47 / 1.53s | -2 |
| pose1 | PET_POSE/PET_POSE_1.anim | pose | null | ✓ | 204 / 6.80s | 0 |
| pose2 | PET_POSE/PET_POSE_2.anim | pose | null | ✓ | 204 / 6.80s | -1 |
| pose3 | PET_POSE/PET_POSE_3.anim | pose | null | ✓ | 150 / 5.00s | -2 |

合计 **6,764 帧 / 225.5s / 20.03MB**（私有 gitignore）。完整选择与规则写在 `scripts/unity-bake/clips.json`（含顶层 `notes` 记录的排除依据）。

---

## 4. 三份验收清单

### 4.1 覆盖清单 ✅

见 §3.2：8/8 类别达标，29 ∈ [25,35]；事件类 slot=null，状态机槽位映射合法（`PET_MOODS + salute`），去重确认无逐帧重复组残留。

### 4.2 数据完整性清单 ✅

`validate-clips` 规则（每条均有正反例单测）：

- version/space/fps/frames/duration 一致性（loop: frames≈round(duration*fps)；非 loop: frames+1）；
- 22 必需骨齐全；`r` 长度 frames*4、无 NaN、四元数模长 1±1e-3、相邻帧 dot≥0（连续性）、相邻帧夹角 >60° warning；
- 仅 Hips 允许 `p`；长度 frames*3、首帧≈0、单帧/总位移上限 warning；
- 循环 clip 末帧≠首帧（防重复帧）、首末接缝 warning；非 loop 末两帧不同。

最终结果：**29 PASS / 0 WARN / 0 FAIL（errors 0, warnings 0）**；29 文件与 selection/index/manifest 一一对应（0 缺失/多余）；manifest `--check` PASS；canonical 与 mirror 字节一致。

### 4.3 自然度清单 ✅（PASS 23 / WARN 6 / FAIL 0，WARN 均为动作意图/摆位）

> 说明：本节 metrics 在 **W1.5-Tpose 重制版**（`aventurine-tpose.vrm`，规范 T-pose + 等价 D 骨合并）上重跑；证据在 `tests/tmp/wave15/final-tpose-metrics/`。旧 legfix A-pose 版数字（PASS 22/WARN 5/FAIL 2、drag 穿地 0.217m）保留在 `tests/tmp/wave15/final/metrics/` 作为历史对照：drag/introStart 的「贴地穿模」主要来自 A-pose 腿链常量偏转，T-pose 重制后降到 0.0147m/0.000m（<1.2% WARN 线）。位置类阈值按身高/hips 高归一化。

| clip | 命中 | 实测 | 视觉/情景判定 |
|---|---|---|---|
| hideOnce | hipsLateralDrift | 0.414m | 躲藏横移语义；非缺陷 |
| idle2 | hipsLateralDrift | 0.303m | 待机变体侧移；非缺陷 |
| idle4 | kneeFlex | max 127.4° | 下蹲 idle 变体，非反关节 |
| introLoop | kneeFlex | max 130.3° | 斜倚式入场循环，非反关节 |
| introEnd | footYMaxJump + kneeFlex | 0.147m/帧；139.9° | 1.53s 内躺→站收尾 + 弧线姿势，过渡语义 |
| introStart | footYMaxJump + kneeFlex | 0.129m/帧；129.2° | 入场空中→落地过渡 |

其余 23 clip 全规则 PASS（T-pose 数据下：最大帧跳变 37.3°<60°、循环接缝 14.28°<15°、归一化 Hips 路径 1.94m<2m、头高最低 1.02m；drag 贴地 0.0147m=0.85% 身高，在 1.2% WARN 线内）。重点 clip 双模型接触表抽检：无反关节/穿模/破面。

> **初始姿态微调**（2026-11-08 用户反馈「手略远/A-pose 感」）：`introStart` 第 0–8 帧手臂内收 5°/前摆 5° 并淡出到 0（`scripts/unity-bake/pose-tune.json` + `tune-pose.mjs`，`run-export.sh` 自动执行；效果见 `tests/tmp/tpose-review/tune-intro-start/`：上臂/前臂相对竖直 13.1°/13.5°→8.0°/8.2°，手距中线 0.149→0.128×身高）。只影响该 clip 前 8 帧的观感（第 8 帧淡出为 0），源数据其余部分不变。

> 口径决定（Lead）：`maxGroundPenetration` 的 FAIL 按「情景依赖 → 降级不评」处理，数据接受；坐/躺/窗沿类豁免贴地判定（脚抬高属正常）。若 app 实机需要拖拽贴地/入场落地更贴近地面，在 Wave 2 交互/场景层做根位移补偿，不改 clip 数据。

---

## 5. 姿态一致性验证（与原角色 / 官方演示 / 引擎 ground truth 对拍）

> 本节回应「不能只是能跑，要确认动作在砂金身上的效果跟 Mate-Engine 在它原角色身上一致；有区别要查清楚」。
> **历史说明**：5.1–5.4 部分跨模型数值基于旧 legfix/A-pose 资产 + `--axis z` 数据，保留为问题定位历史；**最终判定以 §5.5 的 T-pose 重制版同模型 GT 为准**（以及 `docs/vrm-tpose-repair.md`）。
> 结论：**动作数据（muscle→normalized JSON）的转换是忠实的**；看到的差异全部来自**模型资产本身**与**一个播放器缩放 bug**，其中阻塞项已修复。

### 5.1 验证方法（三条独立证据链）

1. **参考媒体**（`tests/tmp/wave15/reference/`）：Steam appdetails API 官方截图 10 张 + 官方 trailer（1080p 2:56，HLS→mkv 后抽帧 352 张）；B站 4 个视频（yt-dlp 下载/抽帧）；GitHub README 官方素材。逐帧用 `read_image` 目检并标注姿态类别/时间戳。
2. **同引擎 ground truth**（`tests/tmp/wave15/groundtruth/`，Unity 6000.2.6f2 + refs 里的 UniVRM 包）：把 Zome.vrm 与戏浪.vrm 导入 Unity，按 Mate-Engine 的方式（Humanoid Avatar + Animator + 原始 `.anim`）采样，导出每帧每骨 raw localRotation / worldPosition 与渲染截图，和我们 three-vrm 回放同一 clip 的结果逐骨对比。
3. **同数据跨模型不变性**（`tests/tmp/wave15/compare/`）：同一份 clip JSON 分别回放到 Zome 与戏浪，比较世界轴旋转 delta `ΔW = W_pose · W_rest⁻¹`（消除模型 rest/比例差异后的「纯动作」量）。

### 5.2 核心结论（数据转换忠实）

| 判据 | 结果 | 结论 |
|---|---|---|
| 跨模型世界旋转 delta ΔW（躯干/头/手臂） | 差 **0.04–0.2°**（全 clip 全帧） | 同一 normalized 旋转被等价应用到两个模型，**无轴/镜像/符号错误** |
| Unity GT（同模型 Zome）vs three-vrm 回放：关节相对旋转 | 躯干/腿 **0.0–0.5°**；手臂 mean **~1.0°**（max ~3.3°）；世界 ΔW mean 8–9°/骨（全局 root 常量差主导） | 采样与回放路径一致（手性修复 + 重烘焙后；修复前手臂关节误差 40–60°） |
| 跨模型 ΔW 的腿差 | 精确等于 N_spine 角度（idle 8.0/8.75°、sitWindow 24.57/24.57°、walk 14.6/15.06°） | 归因：戏浪腿链父链经过 spine（模型层级不合规，见 5.3） |
| 跨模型 ΔW 的手臂/头差（部分 clip） | 精确等于 N_UpperChest 角度（laughing 23.2/23.7°、sleep 14.3/16.9°、happy 6.7/7.6°） | 归因：Zome 无 upperChest 可选骨（见 5.3） |
| 单骨探针（坐标/朝向真值） | 世界轴已知旋转（right +90°）Unity vs three-vrm ΔW 误差 **0.00°**（两模型） | `--axis z` 反射 + VRM0/VRM1 yaw **无镜像/翻转错误** |
| hips 位移缩放 | 旧实现 bbox 身高比 → 砂金幅度 **+43%**；已修 | 播放器 bug（已修复，见 5.4） |

**数据侧不需要改 clip / 不需要重跑 Unity 导出。**

### 5.3 已定位的差异（模型资产问题 + 1 个已修的转换 bug）

| # | 差异 | 证据 | 影响 | 处置 |
|---|---|---|---|---|
| 1 | **戏浪腿部蒙皮不跟随**：下半身网格权重在 MMD 形变骨（`左足D/左ひざD/左足首D/左足先EX`，裤腿/鞋穗等也挂在 D 链下），而 VRM humanoid 映射到控制骨（`左足/左ひざ/左足首`） | 权重聚合（`右足D` 5.36%、`右足先EX` 4.72%…而 `右足` 等控制骨合计 <0.2%）；旋转 humanoid 腿骨画面零变化、旋转 D 骨腿抬起（`compare/sheets/skinning-evidence-av-legs.jpg`）；Unity GT 里戏浪所有 clip 截图相同（同源） | **阻塞级**：walk/sit/sleep 腿部动画完全不可见 | **已修**（legfix VRM，见 5.4）；原始资产保留 |
| 2 | **腿链父链经过 spine（腰）**：`左足D ← 腰キャンセル左 ← 下半身 ← 腰(spine) ← グルーブ ← センター(hips)`，不符合 VRM humanoid「upperLeg 最近 humanoid 祖先 = hips」规范 | ΔW 腿差精确 = N_spine（sitWindow 24.57°、sleep 29–31°） | sit/躺时腿跟着腰转（与 Unity/原角色不一致） | **已修**（重挂腿根到 hips 下，保持世界 rest） |
| 3 | **戏浪 rest 是 A-pose**（上臂/前臂 rest 俯角 −39.6°/−39.5°），Zome/DLC 官方角色/公开参考均为 T-pose（0°/0°） | `compare/sheets/rest-zome-vs-av.jpg`；同数据下手臂段方向恒差 **39.7°** | 砂金手臂在动作里比原角色「低 40°」；这是模型 rest 差异，Mate-Engine 载入非 T-pose 模型也会有同源偏移（Unity Avatar 按该 rest 配置） | **记录不阻塞**（见 §7 下一步：如要对齐原角色观感，可在 Blender 做 T-pose 归一化重导） |
| 4 | **Zome 缺 upperChest** 可选骨（官方 DLC 角色有） | ΔW 手臂/头差 = N_UpperChest（6–23°） | Zome 上胸段动作被丢弃（只能在与 Zome 对比时看到；砂金本身没问题） | 记录；可选骨策略待 V-lane 定 |
| 5 | **hips 位移缩放用了 bbox 身高**（含头发/衣物），官方 three-vrm Mixamo 例子 / UniVRM `Vrm10Retarget` 都用 **hips/COM 高度比** | 砂金 hips 0.714m / Zome 0.831m；旧 `scale=modelHeight/1.7` 对砂金 1.02（应 0.714）→ 位移幅度 +43% | 位移类动作（走路起伏/坐/躺）幅度偏大 | **已修**（`clip-viewer.js`：`scale = normalizedRestPose.hips.y / sourceHipsHeight`；`convert-clips` 输出 `sourceHipsHeight=1.0`） |
| 6 | **归一化前提未守护**：`qNorm = inverse(rest)·localRotation` 只有合成骨架 rest=identity 时才等于 VRM normalized 旋转 | 调研 + 现有 out/ 实测 rest 全 identity | 若将来用真实 avatar 采样会静默输出错误空间数据 | **已加护栏**（`convert-clips`：rest 非 identity 时中止；`--allow-non-identity-rest` 显式放行；新增单测） |
| 7 | **P0：合成骨架左右手性装反**：`BuildSyntheticHumanoid()` 把 Left 骨放在 +X（Unity 左手系面向 +Z 时 Left 应在 -X） | GT 参考 rig 对照：镜像版 vs Zome GT 手臂 ΔW **166°**、修正版 **17.6°**；修复前同模型 Zome 手臂关节误差 40–60° | 手臂 normalized 旋转左右手性错误（躯干/腿不受影响） | **已修 + 重烘焙**（Left 骨 +X→-X；重烘焙后手臂关节误差 ~1.0°，整个 walk/idle 等 clip 数据更新） |

参考媒体核验的额外事实：**Steam 官方截图/trailer 里的角色不是默认 Zome**，而是黑发/白T/颈挂耳机的自定义 workshop 模型（trailer 也有多模型切换段）；Zome 的公开参考只有 GitHub README 官方首图（站立 idle）+ B站 BV14yT4zXEVq 开头 0–5.3s 的默认 Zome 站立待机。**因此「同角色视频对拍」只能覆盖站立待机**；坐/躺/拖拽/走路/舞蹈只能用「动作语义参考帧 + Unity 引擎 ground truth + 跨模型不变性」三条证据综合判定。参考帧索引见 `reference/README.md`（idle/drag/dance/sit/lie/walk/A-Tpose/bow/reach 等，含时间戳）。

### 5.4 已落地的修复（代码 + 资产）

| 修复 | 位置 | 验证 |
|---|---|---|
| hips 位移按 hips 高比缩放 | `scripts/unity-bake/clip-viewer.js`（`normalizedRestPose.hips.position[1] / sourceHipsHeight`）；`convert-clips.mjs` 输出 `sourceHipsHeight` | 砂金 scale 1.02→0.714、Zome 0.856→0.831；重跑 17 clip 双模型渲染 |
| convert 归一化前提护栏 | `scripts/unity-bake/convert-clips.mjs` + `tests/unity-bake-convert.test.ts`（3 测试） | rest 非 identity → exit 1；正常转换 → 输出 `sourceHipsHeight` |
| **legfix VRM 资产修复** | 脚本 `scripts/vrm/fix-vrm-humanoid-legs.mjs`（算法库 `scripts/vrm/lib/humanoid-leg-fix.mjs` + 单测 `tests/vrm-humanoid-leg-fix.test.ts`）；产物 `assets/vrm/aventurine-waveflair-legfix.vrm`；`src/shared/vrm-manifest.json` 的 aventurine 条目指向 legfix 版（原 `aventurine-waveflair.vrm` 只读保留） | remap 8 处（左右 upper/lower/foot/toes）+ 腿根重挂 2 处；世界 rest 位移 4.7e-7m；BIN chunk 未改动；自校验 + 幂等；渲染 walk/sitWindow/sleep/windowLay8 腿部恢复动画（`tests/tmp/wave15/legfix/`）；VRM contract 测试更新通过 |
| **T-pose VRM 重制** | PMX 源 `assets/model/星穹铁道—砂金·戏浪.pmx` 经 VRMify（`python convert/pmx2vrm.py … --spec 1.0 --scale 0.0799777`）转规范 T-pose VRM 1.0；产物 `assets/vrm/aventurine-tpose.vrm`（53 humanoid 骨/50 SpringBone 链/95 表情），manifest 指向之，旧 legfix/waveflair 保留回滚 | 手臂 rest 俯角 39.6°→0°；掌心向下/四指伸直/拇指 45°；足D 等付与骨权重合并；见 `docs/vrm-tpose-repair.md` |
| **clip 坐标约定轴（axis x）** | `scripts/unity-bake/run-export.sh` 转换改 `--axis x`（标准 VRM1：面向 +Z、左手 +X）；`--axis z` 仅保留给面向 -Z/VRM0 风格资产 | 29 clip 重转换；新模型 idle/walk/happy/drag 渲染正确（不再镜像到头顶）；Unity GT 同模型 ΔW 3.44° |
| 朝向修正（预览工具） | `--yaw`（默认按 manifest yawOffsetDeg）；相机移到 +Z 侧看正面 | Zome（yaw 0）/旧戏浪（yaw 180）/T-pose 新资产（yaw 0）均正面渲染 |
| **P0 合成骨架手性修复 + 重烘焙** | `scripts/unity-bake/Editor/ClipExporter.cs`：Left 骨 X 取负/Right 取正 + 注释说明 | GT 对拍：手臂关节误差 40–60°→**~1.0°**；29 clip 重导出 + validate/demo 证据重跑（`tests/tmp/wave15/final/`） |

### 5.5 引擎 ground truth（最终结果）

- Unity 6000.2.6f2 + Mate-Engine 同款 UniVRM 0.128.3 运行时导入两模型，播原始 `.anim`，逐帧导出 22 骨 raw local/world 姿态与渲染（batchmode 下 VRM1 GPU 蒙皮不刷新，改用 `SkinnedMeshRenderer.BakeMesh` CPU 蒙皮后截图可靠）。
- **GT 采样管线自证**：与烘焙脚本同款合成骨架重采原始 `.anim` vs baked `r` = **mean 0.004° / max 0.046°**。
- **同模型 Zome（手性修复 + 重烘焙后）**：躯干/腿关节相对旋转 **0.0–0.5°**；手臂关节相对旋转 **mean ~1.0°**（max ~3.3°）；世界 ΔW mean 8–9°/骨（主要是全局 root/hips 朝向常量差，非关节错误）。→ 我们的回放与 Unity/Mate-Engine 在同模型上的动作语义一致。
- **坐标/朝向真值（单骨探针）**：绕物理 right 轴 +90° 的已知旋转，Unity vs three-vrm ΔW 误差 **0.00°**（Zome 与戏浪两模型）→ 坐标反射/yaw 无镜像/翻转错误。
- **戏浪（legfix，A-pose 时代）同模型对比（历史）**：Unity 侧 `AvatarBuilder` 把 A-pose rest 当 T-pose 标定，产生 ~10–18° 常量旋转差；Unity GT 渲染出现「走路双手举过头顶」的典型伪影 → **该资产不宜当理想真值**，已由 T-pose 重制版取代。
- **T-pose 重制版（`aventurine-tpose.vrm`）+ `--axis x` 数据（最终）**：Unity+UniVRM 按规范 T-pose 正确建立 Avatar；同模型逐帧对比（11 clip / 3,657 帧）：**ΔW mean 3.44°**（Hips 1.8°、手臂 4.2°、腿 1.9–2.8°），**手臂 normalized 局部旋转 mean 0.0°**；此前 legfix A-pose 版同一测试为 102.47°。→ 新目标模型上的动作语义与 Unity/Mate-Engine 一致。
- **跨模型注意（Zome/VRM0）**：Zome 是 VRM 0.x / 面向 -Z 约定；切到 axis-x 后，Zome 需 axis-z 副本才能做跨模型数值对比（否则 ΔW ~94° 为整体镜像）。T-pose 重制版最终验证以「同模型 Unity GT」为准（更严格，不依赖跨模型 rest 对齐）；Zome 参考帧仍用于 idle/站立语义对照（§5.1）。
- **hips 缩放复核**：旧 bbox 公式会使戏浪位移放大 **2.43×**（1.734/0.714）、Zome 1.75×；修复后用 hips 高比，归一化 Hips 位移幅值差 idle 0.013 / walk 0.011 / introStart 0.021（单位=hips 高），足底高度差 idle 0.023 / walk 0.006。
- 完整报告：`tests/tmp/wave15/groundtruth/REPORT.md`；数值 `groundtruth/compare/metrics.json`；截图 `groundtruth/compare/sheets/{zome,aventurine}-{front,side}.jpg`。

### 5.6 对拍证据索引

| 路径 | 内容 |
|---|---|
| `tests/tmp/wave15/reference/` | Steam 截图/trailer 抽帧/B站视频抽帧 + 姿态标注 + `best/` 精选对拍帧（含 Zome 官方站立图） |
| `tests/tmp/wave15/compare/REPORT.md` | 对拍 lane 完整报告（判定表、差异归因、复跑命令） |
| `tests/tmp/wave15/compare/sheets/` | 17 张 `clip-<clip>-zome-vs-av.jpg`（6 帧 ×2 模型）、`rest-zome-vs-av.jpg`、`skinning-evidence-av-legs.jpg`、参考帧对比图 |
| `tests/tmp/wave15/groundtruth/` | Unity+UniVRM ground truth：`unity/*.json`（逐帧 raw localRotation/worldPosition）、`unity-frames/`（渲染 PNG）、`REPORT.md` |
| `tests/tmp/wave15/legfix/` | legfix VRM 的 walk/sitWindow/sleep/windowLay8 渲染证据 + metrics |
| `tests/tmp/wave15/final/` | **最终证据**（手性修复重烘焙 + legfix）：戏浪全 29 clip 渲染/接触表/metrics + Zome 关键 clip 渲染 |
| `tests/tmp/wave15/groundtruth/` | Unity+UniVRM ground truth：`unity/*.json`（逐帧 raw 姿态）、`threevrm/`（回放）、`compare/metrics.json`、对比截图、`REPORT.md` |
| `tests/tmp/wave15/vrm-leg-fix-report.json` | legfix 脚本报告（remap/重挂/rest delta/BIN 校验） |

---

## 6. 自动化测试与回归结论

| 检查 | 基线（Wave 0 后） | 本次（Wave 1.5 后） | 结论 |
|---|---|---|---|
| `pnpm test` | 75 files / 1263 passed / 14 skipped | **82 files / 1383 passed / 14 skipped** | +7 文件 / +120 测试，全绿 |
| `pnpm typecheck` | exit 0 | **exit 0** | 无回归 |
| unity-bake 专项 | — | 5 files / 113 passed / 0 skip（真实 29 clip + manifest 集成断言） | 全绿 |
| `validate-clips` | — | 29 PASS / 0 WARN / 0 FAIL | 全绿 |
| `build-motion-manifest --check` | — | PASS | 全绿 |

**回归处理**：本次改动只新增 `scripts/unity-bake/**` 工具/数据/文档与测试，未触碰 `src/**`、`package.json`、既有测试；全量测试与 typecheck 均无回归。期间唯一一次环境级问题（沙盒下 Unity/Electron 无法写用户目录）通过「Unity 用 CLI+授权/放开权限会话、Electron 加 `--no-sandbox`+工作区 `--user-data-dir`」解决，不属于代码回滚范畴。

新增测试文件：`tests/unity-bake-{humanoid-map,clip-validation,motion-manifest,cli,assets,convert}.test.ts`、`tests/vrm-humanoid-leg-fix.test.ts` + `tests/fixtures/unity-bake/fixtures.ts`。

---

## 7. 已知限制与下一步

1. **V10 接线（Wave 2/3）**：`manifest.json` 的 `file` 指向 `mate/*.json`（normalized 骨骼数据），V-lane 的 clip player 需实现该格式回放（normalized 骨骼 + Hips 位移缩放），或按需转 VRMA；contract 槽位（idle/walk/sit/drag/pat/sleep）可直接映射，事件类（intro/hiding/pose）由行为层事件驱动。
2. **镜像**：Mate-Engine 的左右镜像对在源数据相同（Animator mirror flag），本轮只保留单侧；如需左右分明，需在回放层做镜像（sagittal mirror：normalized 旋转 `(x,-y,-z,w)` + 左右骨互换）或另找源。
3. **表情/口型**：hover/talking/面部反应在 Mate-Engine 是 blendshape 层；本项目由 VRM expression 层负责（V6/V10），不在骨骼 clip 内。
4. **场景摆放依赖**：坐/窗沿/躺/躲藏/拖拽的绝对高度与贴地由 app 场景层（窗沿/床/躲藏位/拖拽根位移）负责；预览空白场景中的悬空/贴地不代表数据错误（§4.3）。
5. **Hips 位移**：来自 Unity 重定向，含合成骨架比例带来的常驻偏移；`relative` 已处理大部分，坐/躺绝对高度交 app。
6. **walkAlt**：与主步态腿部/手臂一致、上身风格不同（priority=-2 默认不启用）；如需真正不同步态需另找源。
7. **授权（红线）**：Mate-Engine 动画资产 © Shiny，个人非商用、需署名、**不得再分发**（含格式转换产物）；本 wave 产物全部在 gitignore 的 `assets/motions/` 内，仅本机使用。Zome/DLC 角色模型版权归 Yorshka Shop，仅本地研究对比，不随 app 分发。
8. **HSR 解包 FBX**（若有）可作为并列动作源，走 Blender→VRM 重定向与本管线对比。
9. **T-pose 重制已落地**（§5.3 #3 的后续）：`assets/vrm/aventurine-tpose.vrm` 为规范 T-pose（手臂水平/掌心向下等），manifest 已指向；复跑/回滚见 `docs/vrm-tpose-repair.md`。
10. **私有资产准备**：`src/shared/vrm-manifest.json` 的 aventurine 条目指向 `assets/vrm/aventurine-tpose.vrm`；准备流程见 `docs/vrm-tpose-repair.md` §2.1（PMX→VRMify；或从本机备份取产物）。未准备时 V-lane 应回退 canary/default 并记录告警。旧 legfix/waveflair 资产保留用于回滚与历史对比。
11. **Unity GT 的最终数值**（T-pose 重制版同模型 + 单骨探针）见 `tests/tmp/wave15/groundtruth/compare/metrics.json` 与本文 §5.5。
12. **P1（可选，进一步逼近 Mate-Engine 原版）**：在**目标 VRM 的 UniVRM Humanoid Avatar** 上直接采样烘焙（而非通用合成骨架），可消除剩余 ~8° 的全局 root 朝向常量差与 ~1° 手臂残差；代价是动作数据与目标模型 T-pose 标定绑定。当前合成骨架方案已满足「动作语义一致」，是否切换留待 V-lane 决定。
13. **VRM0/面向 -Z 模型（canary）与 axis-x 数据**：同一份 clip 在 VRM0 上会左右镜像；V5 clip player 需按模型 `specVersion`/朝向做 180° 约定换算（normalized 旋转绕 Y 共轭），或为 VRM0 单独导出 axis-z 数据。当前 app 目标是砂金 VRM1，不影响主线（详见 `docs/vrm-tpose-repair.md` §5）。
14. **HSR 动作 lane（另一会话）**：其初稿数据面向旧 legfix VRM（节点/rest 标定）；模型切到 `aventurine-tpose.vrm` 后需按新 VRM 重新 retarget（raw 次级骨通道尤其），由该 lane owner 刷新，勿与 U-lane 数据混用。
15. **手指补全的边界（2026-11-08 追加）**：只补了 30 根手指；**眼/颌/尾巴**未补（眼睛归 VRM lookAt/表情层，intro 系源里的 5 条
    `Manuka_tail` 非人形曲线对戏浪无意义）。手指上限 = Unity Humanoid 维度（每手 20 muscle：每指 3 单轴弯曲 + 1 开合），
    低于 HSR 的 30 骨 × 3 轴；6/29 clip 手指是恒定手型。详见 [docs/wave15-fingers-report.md](wave15-fingers-report.md) §7。

---

## 8. 复跑命令

```bash
# 1) 导出 + 转换（Unity CLI 路径；license preflight 自动）
bash scripts/unity-bake/run-export.sh

# 2) 数据校验 + manifest 构建/校验
node scripts/unity-bake/validate-clips.mjs
node scripts/unity-bake/build-motion-manifest.mjs
node scripts/unity-bake/build-motion-manifest.mjs --check

# 3) 全量预览 + 自然度 metrics + 接触表（T-pose 重制版）
node scripts/unity-bake/preview-clips.mjs --all \
  --vrm assets/vrm/aventurine-tpose.vrm \
  --out tests/tmp/wave15/final-tpose \
  --metrics tests/tmp/wave15/final-tpose-metrics --sheet

# 4) canary（VRM 0.x）重点 clip
node scripts/unity-bake/preview-clips.mjs \
  --clips idle,walk,walkAlt,sitWindow,drag,happy,hideLeft,introLoop \
  --vrm "assets/vrm/canary/砂金石心十人公司制服(0.x).vrm" \
  --out tests/tmp/wave15/canary --metrics tests/tmp/wave15/canary-metrics --sheet

# 5) 原角色/其他 VRM 对拍（自动 yaw：戏浪 180、VRM0 默认 0）
node scripts/unity-bake/preview-clips.mjs --clips idle,walk,sitWindow,drag \
  --vrm "refs/Mate-Engine/Assets/MATE ENGINE - Avatar/Zome.vrm" \
  --out tests/tmp/wave15/zome --frames 0,0.2,0.4,0.6,0.8,0.95 --sheet

# 6) 测试
pnpm test && pnpm typecheck
```

---

## 9. 证据索引（`tests/tmp/wave15/`，gitignore）

| 路径 | 内容 |
|---|---|
| `REPORT-DRAFT.md` | motion-qa（task-3）产出的完整验收草稿（三份清单全表、逐 clip 指标、阈值、置信度、复跑命令） |
| `analysis.json` / `tables.md` | 逐 clip 规则判定明细 / 报告表格源 |
| `validation-report.json` / `manifest.json` | 校验报告副本 / manifest 副本 |
| `aventurine/` | 戏浪全 29 clip 渲染：116 PNG + 29 接触表 + 首帧总览 |
| `canary/` | canary VRM0：32 PNG + 8 接触表 |
| `metrics/`、`canary-metrics/` | 29 + 8 份逐帧 metrics JSON 与摘要 |
| `reference/` | Steam 官方截图/预告片抽帧、B站演示抽帧与姿态标注（D1 lane） |
| `zome/`、`aventurine-front/`、`compare/` | 原角色 vs 砂金 对拍渲染与判定报告（D2 lane） |
| `groundtruth/` | Unity+UniVRM 引擎侧 ground truth 数值/截图对照（D3 lane） |
| `legfix/`、`legfix-metrics/` | legfix VRM 渲染证据（历史；walk/sitWindow/sleep/windowLay8 等）与 metrics |
| `final-tpose/`、`final-tpose-metrics/` | **最终证据（T-pose 重制版 + axis-x）**：29 clip 渲染/接触表 + 逐帧 metrics（PASS 23/WARN 6/FAIL 0） |
| `tpose-review/` | 验收图包：29 clip 旧/新对比、手部特写、`introStart` 初始姿态微调前后对比 |
| `docs/vrm-tpose-repair.md`（仓库内） | T-pose 重制 + clip 坐标约定修复完整报告（根因/命令/GT 复验/回滚/限制） |
| `vrm-leg-fix-report.json` | legfix 脚本报告（8 处 remap / 2 处重挂 / rest 世界位移 / BIN 校验） |
| `reference/` | Steam 截图/trailer/B站抽帧、姿态标注、`best/` 精选对拍帧（D1 lane） |

> 所有证据目录均在 `tests/tmp/**`（gitignore）与 `assets/**`（gitignore，私有）内，不提交、不发布。
