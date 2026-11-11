# Wave 1 / Wave 1.5 动作管线：新动作源接入前必读（踩坑清单 + 管线地图）

> 产出：`wave-pitfalls-researcher`（task-3）· 2026-11-09 · 范围：**Wave 1（HSR 官方 FBX → VRM 重定向）** 与
> **Wave 1.5（Unity `.anim` → VRM 归一化烘焙）** 两波，以及它们的 app 消费侧（Wave 2 V5–V8）。
> 用途：接下来要接一套**全新格式（3ds Max Biped `.max`）**的官方动作，本文把前两波已经踩过的坑、
> 数据契约、校验门禁、app 接线规则提炼成一份可照做的 checklist，避免重蹈覆辙。
>
> 标注约定：**〔文〕** = 只出现在文档里的结论；**〔码〕** = 本次实读代码确认；**〔数〕** = 本次实测
> 磁盘数据/报告确认；**〔推〕** = 对新动作源的推断/待验证项。第 7 节有完整的「文档 vs 实读」对照表。
> 证据日期：2026-11-08 ~ 11-09（本机 Asia/Shanghai）。

---

## 0. TL;DR（10 条）

1. **两条已验证的源路线**：① world-rotation-delta 重定向（源侧任意骨架，Blender 采 236 骨世界四元数 →
   对目标 VRM 做 `D=R_pose·R_rest⁻¹`，HSR 用）；② normalized-space 直采（源是 Unity Humanoid muscle clip，
   在 Unity 里对 T-pose 骨架逐帧采样后换算成 normalized 局部旋转，Mate-Engine 用）。新源先决定走哪条，
   **不要混用**。
2. **目标 VRM 的 rest 姿势是全局前提**：A-pose 资产上做世界 delta 会留一个常量偏转（旧戏浪上臂 39.6°，
   修正后仍差 15°，手腕差 11–12cm）。必须先把目标修成规范 T-pose（VRMify 重转，`aventurine-tpose.vrm`），
   或做 per-bone rest 方向修正；两者都做才稳。
3. **目标缺 `upperChest` 是常态**（VRMify 产物）：映射必须 target-aware——`spine←Spine1_M`、
   **`chest←Chest_M`**（把上胸整段旋转并进 chest），clip 里 `UpperChest` 写 identity 满足 22 骨契约，
   播放器按 normalized 名取不到节点时**跳过**（不报缺骨）。三骨近似会丢一部分躯干扭转（Spine2 局部 mean 7.9°/max 33°）。
4. **Hips 缩放基准是 `目标 normalizedRestPose.hips.y / clip.sourceHipsHeight`，不是 bbox 身高**。
   旧公式使戏浪位移放大 2.43×（+43%）。HSR 新目标：hips 1.0661 / sourceHips 0.9502 = **1.122**。
   `sourceHipsHeight` 必须由采样侧真实量出（HSR = `Root_M.head[1]`）；合成 Unity 骨架恒为 1.0。
5. **raw 次级骨 vs SpringBone**：目标自带 SpringBone 时 `rawPolicy='spring'`、raw 留空，头发/衣摆由
   `vrm.update(delta)` 物理驱动；**必须按真实帧率传 delta**（`clip-player` 单帧 clamp 0.1s），否则物理不收敛。
   目标无 spring 的旧资产才走 `rawPolicy='baked'`（旧 A-pose clip 有 186 条 raw 轨道，留作回滚）。
6. **坐标/朝向/手性双坑**：Unity 是左手系（面向 +Z 时左手 −X）；标准 VRM 1.0 面向 +Z、左手 +X →
   `--axis x`（反射 X）；旧 VRM0/面向 −Z 资产才用 `--axis z`，两者差一个绕 Y 180°。**合成骨架左右手性曾装反
   （Left 放 +X），导致手臂 normalized 旋转 40–60° 误差**，GT 对拍才暴露；写采样器时必须用「同模型逐帧 GT」
   验证，不能只看渲染好不好看。
7. **Blender 导入 HSR FBX 会直接崩**：Maya 式 in-between shape keys → monkey-patch `blen_read_shapes`
   过滤 `len(entry[3]) > 1` 的条目再导入；take 名被截断到 63 字符，用 `takeMatch` 前缀 + 帧数 ±2 匹配。
   60fps → 30fps 用整数步长 2 抽帧（不要用重采样器）。
8. **位移/贴地是数据与场景层的分工**：数据侧只保证「Hips.p 首帧=0、水平 in-place」，`grounding:'feet'`
   只施加**相对首帧**的竖直补偿 → 会留常量贴地残差（HSR idle 组 2.18cm）；mate 集全未标注 grounding，
   app 用「姿态最低骨」pose-grounding 兜底（每 clip 常量，≤16 帧采样）；**`grounding:'none'` 的 hsr 技能
   不兜底、drag 槽位排除**；坐/躺/窗沿类动作绝不能依赖地面兜底（会被吸到地面/悬空）。
9. **校验门禁分两层且都硬性**：源侧 `validate-hsr-clips`（结构/指标/贴地/spring 策略）+ U 侧
   `validate-clips`（22 骨 + duration/frames/四元数/连续性/Hips/接缝，每条都有正反例单测）；数据 → manifest
   必须走 `build-*-manifest` 脚本、`--check` 幂等，**绝不手改生成物**；app 清单由
   `build-app-manifest.mjs` 统一生成（app-manifest=`mood 候选池`，app-catalog=`全部 clip 索引`）。
10. **app 接线规则**：mood 只能取契约白名单（`PET_MOODS + salute`，13 个）；同槽位多 clip 靠 `priority` 选主选 +
    随机变体轮换，**轮换池准入 priority ≥ −9**（窗沿躺 −10…−13 只按 id 播），**稀有变体阈值 ≤ −7 权重 0.3**；
    一次性/表演动作进 catalog 用 `playClipById(id,{loop,hold})` 事件驱动；一次性动作播完回 mood，
    `hold=true` 停末帧（dshError 的 breaked≈9s 倒地就靠这个）。失败永远只降级不抛。

---

## 1. 管线全图

### 1.1 两条源路线（选型先于实现）

| | 路线 A：world-delta 重定向（Wave 1 / HSR） | 路线 B：normalized-space 直采（Wave 1.5 / Mate-Engine） |
|---|---|---|
| 适用源 | 任意带骨架+动画的 FBX/自定义格式（HSR 是 236 骨 60fps，135 take） | 只能是**已在 Unity Humanoid 空间求值**的 clip（`.anim` muscle 曲线） |
| 采样方式 | Blender headless：逐帧采全骨 **armature-space 世界四元数 + 骨 head**，存 `samples.json` | Unity Editor：`AnimationMode.SampleAnimationClip` 逐帧采全部 humanoid 骨 `localRotation`/`localPosition` |
| 重定向数学 | `D=R_pose·R_rest⁻¹` → `R_align·D·R_alignᵀ` → per-bone rest 修正 → `q=D_parentᵀ·D_bone` | 合成 T-pose 骨架 rest≈identity 时 `qNorm=restLocal⁻¹·localRotation`；真实 avatar 用 `N=ΔW_parent⁻¹·ΔW_bone` |
| 需要目标动画 SDK | 否（纯数学） | 是（Unity 6000 + UniVRM，本机已装） |
| 本仓库入口 | `scripts/vrm/motion/extract-hsr-anims.py` → `retarget-hsr.mjs` | `scripts/unity-bake/run-export.sh` → `convert-clips.mjs` |
| 产物 | `assets/motions/hsr/<clip>.json`（14 条，52 骨，`rawPolicy=spring`） | `assets/motions/mate/<clip>.json`（29 条，52 骨含手指） |

> **针对 3ds Max Biped**：Blender/Unity 都不能直接读 `.max`，所以新源第一步必然要落到「可采样骨架」上——
> 要么在 3ds Max 内用脚本/插件导出 FBX（再走路线 A 的采样），要么在 3ds Max 内直接吐出与
> `samples.json` 相同 schema 的 JSON（推荐：省掉一次格式转换损失）。**Biped 的 `.bip` 动作要先套到 rig 上再采样**；
> 具体待实测项见 §3 Step 0。〔推〕

### 1.2 数据流（两条路线 + app 消费）

```
【Wave 1: HSR】
HSR 官方 FBX（约 305MB / 135 take / 60fps / 236 骨）
  └─ extract-hsr-anims.py（Blender 4.2 headless；in-between shape patch；takeMatch 匹配；60→30 整数抽帧）
       └─ tests/tmp/hsr-motion/samples.json  （rest{quat,head,parent} + children + 14 clip 的逐帧 q/h）
            └─ retarget-hsr.mjs（lib/vrm-rest.mjs 解析目标 GLB → R_align/effectiveParent/spring）
                 ├─ lib/humanoid-hsr.mjs      HSR↔VRM 52 骨映射 + target-aware 躯干映射
                 ├─ lib/rest-direction-fix.mjs per-bone swing 修正（36 骨）
                 ├─ lib/retarget.mjs          D→局部 normalized q / Hips 位移 / in-place / grounding / 参考帧裁剪
                 └─ lib/qa.mjs                PASS/WARN/FAIL
                      └─ assets/motions/hsr/<id>.json（14）
                           ├─ validate-hsr-clips.mjs（+ U 侧 clip-validation 双保险）
                           ├─ preview-hsr.mjs（三视角+手脚特写、spring 按 delta 步进）
                           └─ build-hsr-manifest.mjs → assets/motions/hsr/{manifest,index}.json

【Wave 1.5: Mate-Engine】
refs/Mate-Engine/.../MATE ENGINE - Animations/**（128 个 Unity Humanoid .anim，仓库内 2.4G 只读克隆）
  └─ run-export.sh（建 work/AventurineBakeProj 空工程，只拷 .anim，注入 Editor/ClipExporter.cs）
       └─ ClipExporter.cs（合成 T-pose humanoid 骨架：AvatarBuilder；22 骨逐帧采样；
            Left=-X/Right=+X 手性；qNorm=inv(restLocal)·localRot；Hips.localPosition 相对 rest）
            └─ scripts/unity-bake/out/<clip>.json（unity-lh，22 骨，raw 采样）
                 └─ convert-clips.mjs（左→右：--axis x 反射 X；连续性；Hips relative 首帧归零；rest≈identity 护栏）
                      ├─（可选）merge-finger-tracks.mjs（Unity GT 探针 30 手指；ΔW 公式；body22 重算护栏）
                      └─ assets/motions/mate/<id>.json（29）
                           ├─ validate-clips.mjs（lib/clip-validation.mjs）
                           └─ build-motion-manifest.mjs → assets/motions/mate/manifest.json（+ assets/motions/manifest.json 镜像）

【app 运行时（Wave 2）】
assets/motions/{mate,hsr}/manifest.json（源集清单，私有）
  └─ build-app-manifest.mjs（只由源 manifest 生成，不手改）
       ├─ assets/motions/app-manifest.json   （冻结契约 AnimationClipManifest 形状；mood/salute 槽位候选池，32 条）
       └─ assets/motions/app-catalog.json    （全部 clip 索引，43 条；一次性/表演可用 id 手动播）
            └─ src/renderer/src/vrm/clip-registry.ts（pet-asset:// 拉取 + sanitize + 预载 + groundingDeclared）
                 └─ src/renderer/src/vrm/clip-player.ts（选片/变体/事件/淡入/写 normalized 骨+Hips.p/贴地测量）
                      └─ src/renderer/src/vrm/animator.ts（mood 进出场 one-shot、入场序列、坐窗风格、foot-lock）
                           └─ src/renderer/src/vrm/pet-scene-vrm.ts → three-vrm VRM.update(dt)（spring/lookAt 统一更新）
```

### 1.3 clip JSON 字段逐个解释（两波共用同一格式）

磁盘实测（`assets/motions/hsr/idle.json`、`assets/motions/mate/idle.json`）〔数〕：

```jsonc
{
  "version": 1,                      // 固定 1；校验硬性
  "clip": "idle",                    // 源集内 id（app 层会加 "<set>-" 前缀）
  "mood": "idle",                    // 源 manifest 的 slot；一次性片段 = null
  "loop": true,                      // 循环 clip 帧数 = round(duration*fps)；非 loop = +1（末帧包含）
  "fps": 30,                         // 目标采样率（HSR/Unity 都是 60fps 源 → 30fps 数据）
  "duration": 2,                     // 秒；loop = frames/fps；非 loop = (frames-1)/fps
  "sourceHeight": 1.839,             // 源骨架身高（HSR 由 bone head/tail bbox 得；仅参考，不用于缩放）
  "sourceHipsHeight": 0.950175,      // **Hips 位移缩放基准**（源 rest hips 世界高度，米）；U 侧合成骨架=1.0
  "space": "gltf-rh",                // 固定：glTF 右手系（校验硬性）
  "frames": 60,                      // 帧数
  "sourceClip": "…Ani_StandBy…",     // 来源 take 名（可追溯）
  "avatar": "HSR-Avatar_Aventurine_00",
  "targetVrm": "assets/vrm/aventurine-tpose.vrm",  // HSR 集记录目标资产（mate 集无此字段）
  "targetAvatarId": "aventurine-waveflair",        // HSR 集记录 manifest avatar id
  "grounding": "feet",               // feet | none；**缺失 = 未标注**（app 用 pose grounding 兜底，见 §4-D）
  "rawPolicy": "spring",             // spring（目标自带 SpringBone，raw 留空）| baked（旧资产 raw 通道）
  "bones": {                         // 键 = Unity 风格 humanoid 名（52 = 22 核心 + 30 手指）
    "Hips":    { "r": [[x,y,z,w], …], "p": [[dx,dy,dz], …] },  // p 仅 Hips；米；已减首帧基准；水平 in-place
    "Spine":   { "r": [[x,y,z,w], …] },
    "LeftThumbMetacarpal": { "r": … }                          // 30 手指（可选骨；目标有则驱动，无则忽略）
  },
  "rawMeta": { "mapped": 0, "mode": null, "policy": "spring" }, // HSR 集：raw 为空的原因/策略
  "fingerSource": { "tool": "merge-finger-tracks.mjs", "model": "aventurine", "gtFrames": 74 } // mate 集：手指轨道来源
}
```

约定（lib 已处理，新源必须遵守）：

- `r` 是**相对 rest 的归一化局部旋转**，单位化、逐帧连续（相邻 dot ≥ 0），`[x,y,z,w]`；nested/flat 两种形状都合法
  （U 侧 validator 都支持，实际产物是 nested）。
- `p` 只允许出现在 `Hips`；首帧必须 ≈0（±1e-3m）；水平位移已归零（in-place）；竖直位移是相对首帧的增量。
- 循环 clip **不重复末帧**（交给 player loop + 随机相位）；非 loop 保留末帧（`frames = round(dur*fps)+1`）。
- 「缺 upperChest 的目标」：clip 仍写满 22 骨契约，但 `UpperChest` 轨道必须全 identity（HSR 实测 max 偏差 0.0000°〔数〕），
  播放器按 normalized 名找不到节点时应跳过；上胸旋转折进 `Chest`。
- `grounding` 的语义是「数据作者声明」：`feet` = 只有首帧脚骨对齐 rest 基准；`none` = 明确不贴地；
  **字段缺失 ≠ none**（app 会 pose-grounding 兜底）。这是 §4-D / app 接线最容易踩的语义坑。

### 1.4 每步脚本入口与典型命令（本机可复跑）

```bash
ROOT=/Volumes/4TB外置盘/deepseek-harness/aventurine-pet-vrm

# ===== Wave 1（HSR）=====
BLENDER=/Volumes/4TB外置盘/deepseek-harness/tools/blender/Blender.app/Contents/MacOS/Blender
# 1) 采样（源 FBX 现已不在磁盘！/tmp/sandgold-probe 已删；只剩 samples.json，见 §4）
"$BLENDER" -b --factory-startup --python scripts/vrm/motion/extract-hsr-anims.py -- \
  --fbx "/path/to/Avatar_Aventurine_00.fbx" \
  --config scripts/vrm/motion/clips.hsr.json --out tests/tmp/hsr-motion/samples.json
# 2) 重定向（自动读 src/shared/vrm-manifest.json → aventurine-tpose.vrm；raw auto=spring）
node scripts/vrm/motion/retarget-hsr.mjs \
  --samples tests/tmp/hsr-motion/samples.json --out assets/motions/hsr --report-dir tests/tmp/hsr-motion
# 3) QA + manifest
node scripts/vrm/motion/validate-hsr-clips.mjs --dir assets/motions/hsr \
  --json tests/tmp/hsr-motion/validation-report.json
node scripts/vrm/motion/build-hsr-manifest.mjs --dir assets/motions/hsr --config scripts/vrm/motion/clips.hsr.json
# 4) 预览（三视角+手脚特写；spring 按 delta 步进才看得到物理）
node scripts/vrm/motion/preview-hsr.mjs --all --out tests/tmp/hsr-motion/preview-tpose \
  --frames 0,0.2,0.4,0.6,0.8 --views front,side,threeQuarter,hand,feet

# ===== Wave 1.5（Mate-Engine）=====
bash scripts/unity-bake/run-export.sh        # Unity CLI 优先 + license preflight + 回退二进制
node scripts/unity-bake/validate-clips.mjs   # 默认 assets/motions/mate + scripts/unity-bake/clips.json
node scripts/unity-bake/build-motion-manifest.mjs && node scripts/unity-bake/build-motion-manifest.mjs --check
# 手指补全（一次性；GT 工程 + 探针）
node scripts/unity-bake/merge-finger-tracks.mjs \
  --gt work/finger-probe/full-aventurine/unity --model aventurine \
  --in assets/motions/mate --out assets/motions/mate --report work/finger-probe/full-merge-report.json
# 预览 + 自然度 metrics + 接触表（默认目标 VRM；--yaw 默认按 manifest）
node scripts/unity-bake/preview-clips.mjs --all \
  --vrm assets/vrm/aventurine-tpose.vrm \
  --out tests/tmp/wave15/final-tpose --metrics tests/tmp/wave15/final-tpose-metrics --sheet

# ===== app 层清单（唯一入口，勿手改生成物）=====
node scripts/vrm/motion/build-app-manifest.mjs
node scripts/vrm/motion/build-app-manifest.mjs --check   # 幂等：逐字节比较
```

工具职责速查：

| 脚本 | 作用 | 关键开关/约定 |
|---|---|---|
| `scripts/vrm/motion/extract-hsr-anims.py` | Blender headless 采样；in-between patch；take 匹配；60→30 | `--fbx/--config/--out`；action 名 63 字符截断 → 前缀匹配；帧数 ±2 容差 |
| `scripts/vrm/motion/retarget-hsr.mjs` | 重定向 CLI；目标=manifest 的 avatar | `--raw auto\|off\|map`；`--vrm-asset-id`；输出 report/secondary-mapping |
| `scripts/vrm/motion/lib/*.mjs` | 纯函数：rest 解析/对齐/映射/rest 修正/grounding/QA | 无 IO 依赖，可单测 |
| `scripts/vrm/motion/validate-hsr-clips.mjs` | 源侧 QA（PASS/WARN/FAIL + JSON 报告） | 默认同时跑 U 侧 22 骨 validator（`--unity-validator`） |
| `scripts/vrm/motion/build-hsr-manifest.mjs` | 源集 manifest + index | `--check` 只校验不写盘 |
| `scripts/vrm/motion/preview-hsr.mjs` | 无头 Electron 渲染 + 接触表 | `--views front,side,threeQuarter,hand,feet`；`--yaw auto`；spring 按 delta 步进 |
| `scripts/vrm/motion/build-app-manifest.mjs` | 生成 app-manifest/app-catalog | `--check` 幂等；`MOOD_CLIP_ALIASES`/`PRIORITY_OVERRIDES` 在脚本内 |
| `scripts/unity-bake/run-export.sh` | U 侧一键：建工程/拷 .anim/注入/采样/转换/pose-tune | 环境变量 `PROJECT/CFG/OUT/UNITY_EDITOR/UNITY_RUN_TIMEOUT` |
| `scripts/unity-bake/convert-clips.mjs` | unity-lh → gltf-rh | `--axis x\|z`、`--hips-mode relative`、rest≈identity 护栏 |
| `scripts/unity-bake/validate-clips.mjs` | U 侧 22 骨校验 CLI | 有 error exit 1；warn 不阻塞 |
| `scripts/unity-bake/build-motion-manifest.mjs` | U 侧 manifest（canonical+mirror） | `--check`；error 时不写盘 |
| `scripts/unity-bake/merge-finger-tracks.mjs` | 22→52 手指合并 | 帧数不一致跳过；body22 重算护栏 |
| `scripts/unity-bake/preview-clips.mjs` | 无头 Electron + metrics + 接触表 | `--all/--vrm/--metrics/--sheet/--yaw`；`PREVIEW_HANDS=1` 手部特写 |
| `scripts/vrm/fix-vrm-humanoid-legs.mjs` | VRM 腿骨 remap/重挂（历史 legfix） | 旧资产回滚用；新 T-pose 资产已由 VRMify 解决 |

### 1.5 manifest 家族（三层，别混）

| 层 | 文件 | 生成者 | 形状/用途 |
|---|---|---|---|
| 源集清单 | `assets/motions/hsr/manifest.json`、`assets/motions/mate/manifest.json` | `build-hsr-manifest.mjs` / `build-motion-manifest.mjs` | `schemaVersion:1, set, source{name,attribution,license,redistribution}, defaults{loop,timeScale,fadeInSec,fadeOutSec,rootMotion}, clips[], coverage{tag:count}, checks{ok,errors,warnings}`；`file` 相对 `assets/motions/`；`slot` = 契约槽位或 null |
| app 候选池 | `assets/motions/app-manifest.json` | `build-app-manifest.mjs` | **冻结契约** `AnimationClipManifest`：只有 mood/salute 槽位（32 条 = idle15/walk2/sit7/drag1/pat3/sleep1/dshBusy1/dshDone1/dshError1〔数〕）；同槽位多条目按 `priority` 排序；含 `fadeInSec/fadeOutSec/timeScale/rootMotion/loop` |
| app 全量索引 | `assets/motions/app-catalog.json` | `build-app-manifest.mjs` | 运行时扩展：全部 clip（43 条 = mate29+hsr14〔数〕），含 `mood:null` 一次性片段（17 条〔数〕）；供事件/调试 `playClipById(id)`；**catalog 条目无 priority** |
| 冻结默认清单（入 git） | `src/shared/motion-manifest.json` | W0-3 冻结 | 默认 `clips: []`（空集 → 回退 legacy/程序化）；运行时实际读私有 app 清单 |
| 模型注册表 | `src/shared/vrm-manifest.json` | 数据维护 | `defaultAvatarId=aventurine-waveflair`、`file=vrm/aventurine-tpose.vrm`、`yawOffsetDeg=0`、`springChains=50`、`heightMeters=1.73`、`lookAt.mode=procedural` |

规则（脚本内硬编码，改契约要同步）：合法 slot 列表在 `scripts/unity-bake/lib/humanoid-map.mjs` 的
`CONTRACT_CLIP_SLOTS` 与 `scripts/vrm/motion/build-app-manifest.mjs` 的 `CLIP_SLOT_MOODS` 各有一份
（脚本不能 import TS 契约），与 `src/shared/animation-contract.ts` 的 `ANIMATION_CLIP_MOODS`（13 个）
由测试断言同步〔码〕；`build-app-manifest.mjs --check` 是**逐字节**幂等校验（产物不含时间戳）。

### 1.6 运行时回放链路（app 侧规则，数据合格的最后一公里）

`clip-registry.ts`〔码〕：从 `pet-asset://assets/motions/` 拉取 app-manifest + app-catalog → sanitize（永不抛，
非法条目丢弃并 warn 一次）→ 预载常用槽位 → 打开 clip 时 `parseClipData`（单位化/连续性/长度校验，坏数据降级）
并记录 `ClipMeta.groundingDeclared`（`'feet'|'none'` 显式出现才算声明）。

`clip-player.ts`〔码〕：
- 每帧：按 `input.events`/`input.mood`/`dragging` 选片 → 交叉淡入（per-bone slerp + Hips lerp，权重 smoothstep，
  时长取新 clip `fadeInSec` / 旧 clip `fadeOutSec`，默认 0.2s）→ 写 **normalized humanoid 骨** quaternion +
  `hips.position = rest + p·(hipsRestHeight/sourceHipsHeight)` → `humanoid.update()` → 贴地测量。
- 贴地三模式：`feet`（clip 显式 feet：首帧最低脚骨对齐 rest 脚骨，per-clip 常量）/ `pose`（**未标注** grounding：
  均匀采 ≤16 帧全 raw humanoid 骨最低点，常量平移）/ `none`（显式 none 或 `slot==='drag'`）；**不做每帧硬钳**
  （避免走路脚粘地）；`footErrorPx` 只测量。
- 一次性事件：`EVENT_CLIP_IDS`（pat→mate-happy/laughing/shyPoint、poke→hsr-hitL、thrown→hsr-stun、
  landed→hsr-revive/hitL）+ tag 回退（`interaction`/`react` 且 loop=false、mood=null）；`hold=true` 停末帧；
  事件优先级 thrown 50 > landed 40 > dragStart 30 > pat 20 > dragEnd 15 > poke 10。
- 多动作变体：轮换池 `priority ≥ -9`；间隔 idle 12–20s / sit 15–30s / walk 10–18s / sleep 不轮换；`avoidRecent`
  idle/sit=2、walk=1；循环 clip 随机起始相位；**稀有权重** `priority ≤ -7 → 0.3`（普通=1）→ idle 池里 pose 每轮换 ≈7%。
- walk/climb 的 `playbackRate` 按「步幅地速」校准（FK 采样测支撑相地速，0.5–1.6 钳制）→ 减少滑步。

`animator.ts`〔码〕：每帧顺序 = clip-player（含贴地）→ 表情层 → look-at additive（头/颈）→ 再次
`humanoid.update()` → `vrm.update(dt)`（spring + 表情材质 + 内建 lookAt；**必须真实 dt**）。
- mood 进出场 one-shot：配置在 `main.ts` 的 `VRM_MOOD_TRANSITION_CLIPS`——进入 `dshError` 播 `hsr-breaked`
  （非循环，`hold` 末帧 ≈9s 倒地）→ 离开播 `hsr-revive`（首帧跪伏接上）→ 回当前 mood；`hsr-stun` 只做 app-manifest 兜底。
- 入场序列：`mate-introStart(2.1s) → introLoop(4.5s/loop) → introEnd(1.6s)`，**默认 `enabled:false`**（用户 11-09 决策：
  启动直接 idle，避免 T-pose 闪现；`pet-scene-vrm` 首帧动画应用前隐藏模型）。
- 坐窗：`setSitWindowStyle('sit'|'lie')`；`sit` 用 `snapshot.poseHipsAboveLowestM` 把模型整体下移让 hips 贴窗沿；
  `lie` 手动 `playClipById(mate-sitWindow/windowLay8/9/10,{loop:true})`（这些 clip priority −10…−13，不参与 sa 变体池）。
- foot planting（2026-11-09 重做）：**仅静止动作**（idle/pat/dsh* 等）把接触脚钉在 scene 局部锚点
  （位置+朝向，跨 clip crossfade 保持），两骨 IK + 有界骨盆下沉（≤4cm）；walk/climb/fall/drag/grabWindow/
  sit/sleep 不锁（走路滑步另由 clip-player 步幅地速校准）；详见 `docs/foot-slide-fix-report.md`。
- 失败降级：所有子层 try/catch，只 `warnOnce` 不抛；`ready` Promise 失败也 resolve。

---

## 2. 两波踩坑目录（症状 → 根因 → 修法 → 新动作源如何规避）

> 每条都尽量给出**实测数字**。标注说明见文首。§3 checklist 会反向引用这里的编号。

### A. 目标 rest / 骨架差异

#### A1. A-pose vs T-pose 目标导致世界 delta 常量偏转
- **症状**：旧 A-pose 戏浪 VRM 上，动作「大体能播」，但垂手姿势接近 A-pose、**手离身体/膝盖/头 11–12cm**，
  `commonIdle` 垂手外张、`breaked` 手搭不到膝盖、`stun` 手掌盖不住脸、`passiveSkill` 手指/手位反向张开〔文/数〕。
- **根因**：世界 delta 法 `target_pose = D_target·target_rest` 只在「源/目标 rest 方向一致（对齐后）」时精确。
  HSR 源 rest A-pose 上臂下斜 **54.6°**，旧目标 A-pose **39.6°** → 常量差 15°（前臂同、手 19.9°、手指 20–38°）；
  改为规范 T-pose 目标后差**扩大到 54.6°**，不做修正时手腕偏差 **0.37–0.45m**〔文/数：retarget-report〕。
- **修法**：`lib/rest-direction-fix.mjs` 对每根骨求 `C_b = swing(v_target_rest, R_align·u_source_rest)`，
  `D_fixed = D_target·C_b`；只应用到 upperArm/lowerArm/hand + 30 手指（阈值 0.5°）。
  实测修正 **36 骨**：上臂 54.6°/前臂 54.76°/手 51.13°/手指 mean 76.80° max 88.41°；
  修正后手腕相对躯干误差 **1.0–1.3cm**、掌心法线 3–6.6°（修正前 0.37–0.45m / 28–35°）〔数〕。
  **不修躯干**（差异 ≤0.6°）与**脚/脚趾**（14° 是 `足先EX` 语义差异，修了会穿地）〔码〕。
- **新源规避**：采样后先做 **dry-run 报告**：逐骨算 rest 方向差（按 group 统计 count/corrected/max/mean），
  差异 >0.5° 的手臂/手指组必须进修正表；若躯干差 >2° 说明映射错了，回去改映射而不是硬修。

#### A2. 目标缺 `upperChest` + 骨骼层级合并（VRMify）
- **症状**：新 T-pose VRM 只有 53 humanoid 骨（无 upperChest、无 jaw；有 30 指 + toes + 2 eyes）〔数〕；
  若沿用旧映射（chest←Spine2_M、upperChest←Chest_M）→ 肩/臂世界朝向最多差 **47°**（HSR Chest_M vs Spine2 局部
  mean 11.5°/max 47.1°）〔文：tpose-impact SCOPE〕。
- **根因**：① VRM 1.0 的 upperChest 是可选骨，VRMify 产物没有；② 旧 legfix 资产是 54 骨（有 upperChest），
  模型换代后骨架语义变了；③ VRMify 会把 MMD 付与骨（足D 等）**合并进所跟随骨+权重**、去掉控制骨、层级整理为
  Root > Hips，raw 层级 ≠ humanoid 层级。
- **修法**：`resolveHumanoidMapping(vrmRest)`（target-aware）：目标有 upperChest 时 1:1；没有时
  `spine←Spine1_M`、**`chest←Chest_M`**（把整段上胸世界旋转并进 chest，避免肩/臂丢 Chest_M 的旋转），
  clip 里 `UpperChest` 轨道写 identity；播放器按 normalized 名找不到节点时跳过。`buildAlignment` 的 up 轴
  在缺 upperChest 时 fallback 用 chest 位置（实测 R_align=identity、0.000°）〔码/数〕。
- **代价/已知限制**：**躯干 3 骨近似**——HSR `Spine2_M` 的局部旋转并入 chest 的绝对旋转（Spine2 局部 mean 7.9°/max 33°），
  视觉未见问题但扭转分布不精确〔文〕。
- **新源规避**：先读目标 GLB 的 `VRMC_vrm.humanoid.humanBones`（`buildVrmRest`），**以目标实际骨集为准**生成映射；
  新源比目标多 spine 骨时，决定「合并到 chest / 丢 / 新增 raw」并写进报告；把「契约 22 骨」与「目标实际骨」
  分开对待（契约骨轨道容忍 identity）。

#### A3. `spine/chest` 语义（Unity/HSR/VRM 三方不一致）
- **症状**：跨模型对比时躯干差「精确等于某个 N 骨角度」（idle 8.0°/sitWindow 24.57°/walk 14.6°），
  一度被误判为转换错误〔文〕。
- **根因**：Unity Humanoid 的 `Spine/Chest/UpperChest` 是**归一化语义层级**，与模型 raw 父子链不同；
  HSR 是 `Spine1_M/Spine2_M/Chest_M` 三节；目标 VRMify 后 raw 上还有 `上半身1` 这类 MMD 中间骨。
- **修法**：所有映射以「normalized humanoid 名」为键、以 `effectiveParent`（沿 raw parent 链找最近 humanoid 祖先）
  为归一化父级，**不假设 raw 层级形状**（`vrm-rest.mjs` 的 `effectiveParent`，legfix 前后资产都适用）〔码〕。
- **新源规避**：不要用同名/同位置猜父子关系；必须显式建「源骨→VRM normalized 名」表，并让播放侧用
  `effectiveParent` 而不是 raw parent。

#### A4. Hips 缩放基准口径（bbox 身高 vs hips 高）
- **症状**：位移类动作（走路起伏/坐/躺）幅度偏大：旧 `scale=modelHeight/1.7` 对戏浪 **+43%**；
  bbox 公式会让戏浪位移放大 **2.43×**（1.734/0.714），Zome 1.75×〔文/数〕。
- **根因**：初始实现用 bbox 身高（含头发/衣服）缩放 Hips.p；官方 three-vrm Mixamo 示例 / UniVRM `Vrm10Retarget`
  都用 **hips/COM 高度比**。
- **修法**：`scale = avatar.hipsRestHeight / clip.sourceHipsHeight`（`clip-data.ts#hipsPositionScale`、`clip-player`、
  `clip-viewer.js` 同一公式）；`convert-clips` 写入 `sourceHipsHeight=raw.sourceHipsHeight||1.0`（合成骨架 hips=(0,1,0)米 → 1.0）；
  当前目标：hips rest **1.0661m** / source 0.950175 → **1.122**（旧 A-pose 资产是 0.714/0.950=0.752）〔数〕。
- **新源规避**：采样时**必须单独量 source hips 高度**（HSR 用 `rest["Root_M"].head[1]`；Unity 合成骨架取 hips.rest；
  3ds Max Biped 取 hip 骨 rest 世界高度，米制，不要用 bbox/身高）并写进 clip JSON；播放器只认这个字段。

#### A5. 目标模型的腿链/蒙皮（legfix 历史，仍有参考价值）
- **症状**：walk/sit/sleep 腿部动画完全不可见；旋转 humanoid 腿骨画面零变化，旋转 `足D` 形变骨才抬腿〔文〕。
- **根因**：① 戏浪 PMX 的网格权重挂在 MMD 形变骨（`左足D/左ひざD/左足首D/左足先EX`），humanoid 映射到控制骨
  （`左足/左ひざ/左足首`）；② 腿链父链经过 spine（`左足D ← 腰キャンセル左 ← 下半身 ← 腰(spine)`），不符
  VRM humanoid「upperLeg 最近 humanoid 祖先=hips」规范〔文〕。
- **修法**：`scripts/vrm/fix-vrm-humanoid-legs.mjs`（`lib/humanoid-leg-fix.mjs`）remap 8 处 + 腿根重挂 2 处 +
  世界 rest 位移 4.7e-7m + BIN 未改动 + 幂等自校验 → `aventurine-waveflair-legfix.vrm`；新 T-pose 资产由 VRMify
  重转后腿部已正常（GT 同模型腿 ΔW 1.9–2.8°）〔文/数〕。
- **新源规避**：换目标模型时先跑「旋转腿骨看网格是否跟随」的探针 + humanoid 父链检查；新动作数据本身不必重烘，
  但**目标资产变更必须重跑全部 clip 的 rest/缩放/对齐标定**。

### B. 坐标 / 朝向 / 左右手性

#### B1. `--axis z` → `--axis x`：模型朝向变了，数据坐标约定必须跟着变
- **症状**：T-pose 新资产 + 旧 axis-z 数据 → **idle 双手抬到头顶（左右镜像）**；换 `--axis x` 后 idle 交叉手、
  walk 摆臂、happy 手势全部正确〔文〕。
- **根因**：Unity 左手系（X 右/Y 上/Z 前；面向 +Z 时**左手 = −X**）；glTF 右手系。反射哪个轴由**目标模型朝向**决定：
  `--axis z` 适配面向 −Z / VRM0 风格旧资产（canary、Zome、旧 waveflair）；`--axis x` 适配标准 VRM 1.0
  （面向 +Z、左手 +X）。早期 U1 文档写「反射轴用 Z，X 会让手臂翻转」**是当时旧资产下的结论，已被 W1.5-Tpose 覆盖**
  〔码/对照表 §7〕。
- **修法**：`convert-clips.mjs` 默认 `--axis x`；`run-export.sh` 固定 `--axis x`；`unity-bake-report/README` 的旧说法
  是历史；回滚旧资产时把 axis 改 z 并重烘。`clip-viewer`/`preview-*` 的 `--yaw` 默认按 manifest `yawOffsetDeg`
  （新资产 0，旧戏浪 180），相机在 +Z 侧取正面。
- **新源规避**：**在源侧坐标转换前先确认目标 VRM 的朝向**（读 manifest `yawOffsetDeg` + 实测 front/back 截图），
  再选反射轴；转换后必须做「单骨已知旋转探针」验证（见 B3）。

#### B2. 合成骨架左右手性装反（P0）
- **症状**：手臂 normalized 旋转左右手性错误（躯干/腿不受影响）；Unity GT 对拍手臂 ΔW **166°**（镜像版）vs
  修正版 17.6°；修复前同模型 Zome 手臂关节误差 **40–60°**〔文〕。
- **根因**：`BuildSyntheticHumanoid()` 初版把 Left 骨放在 **+X**；Unity 左手系面向 +Z 时 Left 应在 **−X**。
- **修法**：Left X 取负 / Right 取正；**重烘焙全部 29 clip**；GT 对拍验证手臂关节相对旋转 mean~1.0°（max 3.3°）〔文/数〕。
- **新源规避**：任何「合成/中间骨架」都必须先用 GT 或镜像探针验证左右；**只看渲染意图不够**（镜像后的动作
  有时看起来也「像在动」）。验证法：同一动作分别用 GT 和你的管线跑，逐骨算 ΔW；>20° 先怀疑手性/轴/映射。

#### B3. GT（ground truth）对拍法
- **做法**（Wave 1.5 最终证据，11 clip / 3657 帧）：Unity 6000.2.6f2 + Mate-Engine 同款 **UniVRM 0.128.3**
  导入**目标 VRM**，播原始 `.anim`，逐帧导出 22 骨 raw local/world 姿态 → 与 three-vrm 回放同一 clip 对齐比较：
  `ΔW = W_pose·W_rest⁻¹`（消模型比例/rest 差异），看关节相对旋转与方向。
- **结果**：T-pose 重制版同模型 **ΔW mean 3.44°**（Hips 1.8°、手臂 4.2°、腿 1.9–2.8°），手臂 normalized 局部旋转
  **mean 0.0°**；A-pose 旧版同一测试 **102.47°**。单骨已知旋转（right +90°）探针 ΔW 误差 **0.00°**（两模型）
  → 坐标反射/yaw 无镜像错误〔文/数〕。
- **新源规避**：把「同模型 Unity+UniVRM GT 对拍」列为**必须项**（尤其新格式 exporter 的坐标/缩放/骨架）；同时保留
  「单骨探针」和「跨模型 ΔW 不变性」两条独立证据。注意 Unity batchmode 下 VRM1 GPU 蒙皮不刷新，GT 截图要用
  `SkinnedMeshRenderer.BakeMesh` CPU 蒙皮。

#### B4. VRM0 / 面向 −Z 模型与 axis-x 数据不兼容
- **症状**：同一份 axis-x clip 在 canary（VRM0）上左右镜像〔文〕。
- **根因**：VRM0 约定面向 −Z；数据约定与模型约定绑死。
- **修法**：当前 app 目标固定 VRM1 砂金，不影响主线；若换 VRM0 目标，按 `specVersion` 做 normalized 旋转绕 Y 共轭
  （180°）或单独导出 axis-z 数据〔文〕。
- **新源规避**：clip 的 `space:'gltf-rh'` 只说明右手系，**不说明与哪个朝向模型匹配**；新源必须明确记录
  「目标朝向 + 转换轴 + yawOffset」三件套（HSR clip 用 `targetVrm/targetAvatarId` 记录）。

### C. 采样 / 导入 / 帧率

#### C1. Blender 导入 HSR FBX 直接崩溃（in-between shape keys）
- **症状**：`bpy.ops.import_scene.fbx` 抛 `RuntimeError("FBX in-between Shapes are not currently supported")`，
  整个导入中止。
- **根因**：该 FBX 带 Maya 式 in-between shapes；Blender 4.2 legacy FBX importer 不支持。
- **修法**：导入前 monkey-patch `io_scene_fbx.import_fbx.blen_read_shapes`：把 `fbx_data` 里 `len(entry[3]) <= 1`
  的条目留下（过滤 in-between），再调原函数；形态键丢失、骨架/动画完整（纯动画采样可接受）。Blender 4.5+ ufbx 原生支持〔文/码〕。
- **新源规避**：新格式导出 FBX 前确认是否带 in-between/blend shape；采样脚本里保留这个 patch（幂等无害），
  并记录「形态键是否丢失」——如果新源动作依赖 morph（口型/表情），必须另走 expression 层（本仓库 V6 已有）。

#### C2. take 命名截断 / 选错 action
- **症状**：按名字找 action 找不到/选错；HSR 135 个 take 里 54 条 Adv locomotion **只有 182 根次级骨曲线、无身体动画**，
  不能当独立动作；还有 17 条 `Emo_*`（脸骨）、33 条 `Monster_W3_*`（Boss 形态）〔文〕。
- **根因**：Blender action 名截断到 **63 字符**；take 名带 `|` 后缀（`...|Base `）；同名/近似 take 多。
- **修法**：`pick_action` 用 `takeMatch` 子串前缀 + `len(fcurves) >= 2000` + 帧数 ±2 容差筛；返回最近候选；
  `clips.hsr.json` 里逐条写 `takeMatch/srcFrames/note`；选片文档写清排除原因〔码〕。
- **新源规避**：新源采样也做「静态预检表」：take 名/帧数/时长/loop/曲线数/是否含身体骨/是否仅 blendshape；
  把「源里有哪些 take、选了哪些、为什么排除」写进 report（本仓库 `work/u3-precheck-report.txt` 是范例）。

#### C3. 60fps → 30fps 抽帧与帧数约定
- **症状**：帧数对不上（action 121 帧 vs 期望 60）；循环 clip 末帧重复 1 帧停顿。
- **根因**：HSR 源 60fps，数据侧统一 30fps；loop 与非 loop 的帧数约定不同（loop=round(dur*fps)，非 loop=+1）。
- **修法**：`step = int(round(sourceFps/fps))`（HSR=2）整数抽帧；非 loop 若末帧没落在 end 上则补末帧；
  retarget 端 `clipFrameCount()` 再算一遍并 slice；Unity 端 `frames = round(length*fps)`，非 loop +1。
- **新源规避**：**先确定源 fps 再定抽帧策略**（60→30 整数抽；24/25/48fps 源不要硬套 2）；统一 30fps 输出；
  用「非 loop 末帧包含」语义；对「循环 clip 首末帧是否重复」写 warning 规则（见 §2-G）。

#### C4. 首帧参考 T-pose 帧污染
- **症状**：部分 HSR 战斗 take 首帧是 T-pose 参考帧（首→次帧多数骨 45°+ 跳变），直接烘会有一段怪姿势。
- **根因**：导出/剪辑产物，不是动作内容。
- **修法**：非 loop clip 自动丢首帧：若「>15% 的骨首→次帧转角 >45°」则丢，最多 2 帧；丢后重算 duration/frames
  （`trimmedReferenceFrames` 写进 report）〔码〕。
- **新源规避**：采样后先扫「首帧/末帧异常跳变」并报告；对 3ds Max Biped 的 "T-pose first key" 尤其常见〔推〕。

### D. 位移 / in-place / grounding

#### D1. Hips 常驻偏移与相对首帧
- **症状**：idle 整体横向漂移 0.3–0.4m；sitWindow/sleep「悬空」〔文〕。
- **根因**：Unity humanoid 重定向到合成骨架会带常驻偏移；HSR 源也有 staging 位移。
- **修法**：`--hips-mode relative` 减首帧基准（U 侧）；HSR 侧 `rawHipsP = h.Root_M − rest.Root_M.head` 再减首帧，
  再经 R_align；水平归零（in-place）；**竖直位移范围 >0.5m 视为过场 staging，整段置零**（skill03 16m/passiveSkill 7.4m）
  〔码〕。
- **新源规避**：先统计 Hips 位移的「水平路径/竖直范围/单帧步长」；in-place 动作一律水平归零；staging 判定阈值
  写进配置而不是散落代码；坐/躺/空中动作的绝对高度交 app 场景层（不要把绝对高度写进 clip）。

#### D2. `grounding:'feet'` 的常量残差（首帧 p=0 契约）
- **症状**：HSR idle 组首帧悬空 **~2.2cm**（新 hips=下半身 1.066m vs 旧 A-pose hips 0.714m，髋旋转下脚骨高度不同）；
  `validation-report` 显示 idle 组贴地误差 **+0.0218m**，`idleShow/idleShow2/commonIdle` 约 +0.0053/0.0054m〔数〕。
- **根因**：grounding 用归一化骨架 FK 逐帧算脚骨世界高度并平移 hips，但为保持「Hips.p 首帧=0」契约，只施加
  **相对首帧**的补偿 → 残差是常量〔码〕。
- **修法**：接受常量残差，由 app 场景层整体贴地；若必须严格贴地，可给 grounded clip 写首帧非零 p（破坏契约，需评审）
  〔文〕。`maxGroundShiftMeters=0.2` 防异常大补偿；clampedFrames 写 report。
- **新源规避**：grounding 只能「相对首帧」；把残差写进 QA 报告并给 app 一个「整体竖直偏移」字段/约定；
  **非站立动作不要标 feet**。

#### D3. 非站立动作的 grounding 陷阱（跪/趴/坐/躺/窗沿）
- **症状**：`breaked`（趴跪循环）`grounding:'none'` 直接播会悬空；mate 坐/躺 clip 未标注 grounding，早期实机整体悬空；
  `sitWindow/windowLay*` 若被 pose-grounding 会被吸到地面（本应贴窗沿）〔文/码〕。
- **根因**：grounding 语义只有 feet/none/未标注三态；「非站立姿势贴地基准」不能简单用脚骨；窗沿/座位是场景锚点。
- **修法**：app 侧 `groundModeFor`：显式 feet → feet；显式 none → none；**未标注 → pose grounding**（16 帧采全 raw 骨最低点，
  常量平移）；`drag` 槽位强制 none。`sit` 用 `poseHipsAboveLowestM` 做窗口上沿锚点（hips 贴沿、腿垂下）；
  `lie` 手动播窗沿躺 clip 且 priority < −9 不进变体池〔码〕。
- **新源规避**：新源非站立 clip **必须显式标注**（`feet`/`none`/或扩字段）；接入前先决定它是「地面姿势」还是
  「场景锚点姿势」；后者只进 catalog、别绑 mood（或由场景层接管竖直位置）。

### E. raw 次级骨 vs SpringBone

#### E1. rawPolicy=spring 的原因与运行时顺序
- **症状**：旧 V3.0 给目标写了 raw 通道后，头发/衣摆「不按 raw 动」或互相打架；新 T-pose 资产上旧 chain 映射只覆盖
  73/256 节点〔文〕。
- **根因**：新目标自带 SpringBone（50 链/175 collider/170 joints〔数〕）；VRMify 把 MMD 物理链折叠成 `root→…_tail`
  （`_tail` 是工具产物、无 HSR 对应骨），旧 chain→chain 算法不再适用；且 three-vrm `VRM.update()` 顺序是
  humanoid → spring，**在之前写 raw 会被 spring 覆盖**〔文/码〕。
- **修法**：`--raw auto`：目标有 spring → `rawPolicy=spring`、raw 留空；无 spring → 回退旧 chain raw（`rawPolicy=baked`，
  旧 A-pose clip 有 186 条 raw 轨道，归档在 `assets/motions/hsr-apose-legacy/`）。播放器不写 raw；**
  必须每帧 `vrm.update(真实 dt)`**（clip-player 单帧 clamp 0.1s；预览静帧也要按 delta 从 0 步进才能看到物理状态）〔码〕。
- **新源规避**：拿到目标先跑 `springBoneInfo(json)`：`present/chains/colliders/joints`；策略二选一写进 clip 元数据
  （rawPolicy）；**若选择 baked raw，必须改播放器顺序（raw 在 `vrm.update` 之后写或禁用 spring）并做 A/B 视觉验证**。
  若新源本身次级骨动画（头发/衣摆/裙摆）是卖点，优先考虑方案 B（逐节点最近骨映射 + 播放器 raw 覆盖），但那是
  播放器契约变更，需要 Lead 评审〔文：SCOPE 方案 B〕。

#### E2. raw 相对首帧模式与增益
- **症状**：raw 通道首帧非 identity 会导致静止时头发「绷着」。
- **根因**：raw 直接搬源世界 delta 会带 rest 姿态差常量。
- **修法**：`rawMode='relative-to-first-frame'`（减首帧逆，只叠加摆动）；`hairGain/clothGain` 按节点名
  （`褲腿|外衣|腰|內襯` → cloth）缩放；QA 检查 raw 首帧 |angle| ≤0.5°〔码〕。
- **新源规避**：次级骨若走 raw，一律 relative-to-first-frame + 增益可配；QA 加首帧 identity 检查。

### F. 手指补全（22 → 52 骨）

#### F1. 手指细节「丢了一半」
- **症状**：用户实机观感「动作末端（尤其手指）不细致」；6/29 clip 手是平摊/半握，不是源里的手型〔文〕。
- **根因**：源 `.anim` **每条 clip 都有 40 条手指 muscle 曲线**（每手 20：Thumb/Index/Middle/Ring/Little × {1/2/3 Stretched, Spread}），
  但 U2 管线是 **22 骨契约 + 合成骨架**：`includeFingers` 开关存在但从未启用，且合成骨架没有手指骨
  （`GetBoneTransform` 返回 null，开了也采不到）；下游 map/validator/preview/GT 全按 22 骨〔文/码〕。
- **修法**：Unity + UniVRM 导入**目标 VRM**（53 humanoid 骨含 30 手指）做逐帧 GT 探针（`GT_ALL_HUMANOID_BONES=1`），
  按 `ΔW_b=W_pose·W_rest⁻¹`、`N_b=ΔW_parent⁻¹·ΔW_b`、`r=unityToGltf(N)`（axis x）换算手指 normalized 旋转，
  用 `merge-finger-tracks.mjs` 只追加 30 指轨道（保留原 22 骨/帧数/Hips.p 不动），并**重算 body22 对比已烘焙 r 做护栏**
  （29 clip 平均 0.29–1.02°；>5° warn）；帧数不一致跳过并报警〔文/码〕。校验：`validate-clips` 29 PASS；
  GT 手指段方向误差 idle 1.8°/walk 2.5°/drag 1.8°/sitWindow 2.4°（sleep 6.6°，误差来自躺姿 body 链）〔文〕。
- **坑**：拇指三节的 Unity↔VRM 名称**错位一位**：Unity `ThumbProximal/Intermediate/Distal` ↔ VRM
  `ThumbMetacarpal/Proximal/Distal`（已用 rest worldPos 逐骨核验）〔文/码：humanoid-map.mjs 注释〕。
  上限 = Unity Humanoid 手指维度（每手 20 muscle，不是 HSR 的 30 骨 × 3 轴）；源里有 |muscle|>1 的作者值，Unity 不 clamp，
  本方案保真保留、不 clamp〔文〕。
- **新源规避**：**采样阶段就决定骨集**，不要先 22 骨再补（补的成本高且容易漏下游）；如果新源有手指，采样器直接采
  52 骨；如果目标是 3ds Max Biped（默认每指 3 节 + 拇指 3 节），先确认目标 VRM 是否 52 骨、并把拇指映射写进映射表
  与测试。眼/颌/尾不要混进骨骼 clip：目标无 jaw 骨、口型属 expression 层；眼动归 lookAt/表情层〔文〕。

### G. 校验工具体系（哪些是硬性门禁）

#### G1. 源侧 `validate-hsr-clips`（`lib/qa.mjs`）〔码〕
| 检查 | 级别 | 阈值 |
|---|---|---|
| version/space/loop/fps/frames/duration/sourceHipsHeight 字段 | **error** | 固定值/正数 |
| frames 与 duration*fps 一致（loop=round；非 loop+1） | **error** | 精确 |
| 22 核心骨齐全（含 UpperChest） | **error** | 缺一即错 |
| `r` 帧数、有限值、四元数模长 | **error** | 容忍 ±1e-3 |
| `Hips.p` 帧数、有限值、首帧归零 | **error** | 首帧 \|p0\| ≤1e-3m |
| 目标缺 upperChest 时 UpperChest 非 identity | **WARN** | — |
| raw 帧数/有限值/单位化 | **error** | — |
| 相邻帧 dot<0（符号翻转） | **WARN** | — |
| 循环接缝 | WARN >2° / **FAIL >6°** | — |
| 帧跳变 | WARN >75° / **FAIL >150°** | — |
| 贴地（仅 grounding=feet） | WARN | 穿地 >0.03m / 悬空 >0.06m |
| raw 相对首帧非 identity | WARN | >0.5° |
| clip 无 raw 且 rawPolicy≠spring | WARN | — |

#### G2. U 侧 `lib/clip-validation.mjs`（`validate-clips`）〔码〕
- **error**：version/space/loop/fps/frames/duration；frames↔duration*fps（容差 ±1 帧，吸收 Unity banker's rounding）；
  22 必需骨缺失；`r` 长度/元素/有限/模长 ±1e-3；相邻帧 dot<0；仅 Hips 允许 `p`；`p` 长度/有限/首帧 ≈0（±1e-3m）。
- **warning**：未知骨（播放忽略）；可选骨缺失（CLI 显式传 `CLIP_OPTIONAL_BONES` 才检查手指）；帧跳变 >60°；
  Hips 单帧 >0.1m/总位移 >25m/loop 首末水平漂移 >0.1m；loop 首末几乎相同（<0.01°，重复帧）或接缝 >45°；
  非 loop 末两帧几乎相同（<0.01°，结尾僵住）。
- 两个 CLI 都是「有 error exit 1；只有 warn exit 0」；`validate-hsr-clips` 默认同时跑 U 侧 22 骨 validator 做双保险
  （HSR 52 骨会产生 430 warnings，全部来自扩展手指骨，属预期）〔数〕。

#### G3. manifest 构建门禁
- `build-motion-manifest.mjs`：id 唯一/合法/≤64、path 存在、slot ∈ 契约或 null、tag ⊆ requirements、coverage 下限、
  priority ∈ [−100,100] 整数、timeScale ∈ [0.1,4]、clip 文件必须存在且过校验；**有 error 时不写盘**；`--check` 比对。
- `build-hsr-manifest.mjs`：额外记录 `channels`（humanoid/raw 骨数）、`grounding`、`source.targetVrm/rawPolicy/restFixNote`；
  `--check` 只校验不写盘〔码〕。
- `build-app-manifest.mjs`：校验源 manifest → 生成 app-manifest/catalog；同一 clip 可同时在 catalog（原 id）与
  app-manifest（alias id）出现（预期）；`--check` **逐字节**幂等；源 clip 缺失 → error（防漂移）；**不要手改生成物**。
- 契约同步测试：`tests/unity-bake-humanoid-map.test.ts` 断言 22 骨映射 ↔ `src/shared/vrm.ts`、槽位 ↔
  `animation-contract.ts`；`tests/animation-contract.test.ts` 冻结默认值（loop=true/timeScale=1/fade 0.15/0.2/priority=0，
  priority 越界钳制 [−100,100]，fade [0,2]）〔码/数〕。**新源接清单时，这些硬编码列表（`CONTRACT_CLIP_SLOTS`/
  `CLIP_SLOT_MOODS`/22 骨/52 映射）必须跟着改并跑测试**。

#### G4. 数据实测基线（新管线要对齐的「已知好数据」）
| 指标 | 当前值（实读） |
|---|---|
| hsr clips | 14；52 骨；`rawPolicy=spring`、无 raw；`sourceHipsHeight=0.950175`；`grounding` feet×5/none×9 |
| mate clips | 29；52 骨（含手指）；无 `grounding` 字段；`sourceHipsHeight=1` |
| hsr-apose-legacy | 14；52 骨；**186 条 raw 轨道**、无 rawPolicy 字段（回滚用） |
| QA | `tests/tmp/hsr-motion/validation-report.json`：PASS 11 / WARN 3 / FAIL 0；U validator 0 errors / 430 warnings |
| restFix | 36 骨；maxMismatch 88.41°；upperArm 54.6/lowerArm 54.76/hand 51.13/fingers mean 76.8 max 88.41 |
| grounding | scale 1.122015；idle 组 maxShift 0.0219m、残差 0.02182m |
| manifest | hsr/manifest.json（14 clips, set=hsr, checks.ok=true）；mate/manifest.json（29, set=mate, ok）；app-manifest 32；app-catalog 43 |

### H. app 侧接线规则（Wave 2 踩坑）

#### H1. mood/clip 槽位与优先级
- 合法 mood 只有 13 个：`idle/walk/climb/sit/sleep/drag/fall/pat/grabWindow/dshBusy/dshDone/dshError/salute`
  〔码：`animation-contract.ts`/`CLIP_SLOT_MOODS`〕。新源 clip 的 `slot` 必须落在这个集合或 `null`，
  否则 manifest 构建直接 error（防漂移）。
- 同槽位多 clip：按 `priority` 降序；首个进入该状态播最高 priority 主选，之后在变体池随机。
  **轮换池准入 = priority ≥ −9**；**稀有变体 = priority ≤ −7，权重 0.3**。窗沿躺 `sitWindow/windowLay8/9/10`
  被 `PRIORITY_OVERRIDES` 降到 −10…−13（只保留在 app-manifest 供按 id 播，不参与轮换）〔码/数〕。
- 一次性别绑 mood：进 catalog（`mood:null`），事件层 `playClipById('<set>-<clip>', { loop, hold, fadeSec })` 播；
  播完（非 hold）回当前 mood。需要 mood 驱动时用 `MOOD_CLIP_ALIASES` 起别名（dshBusy←hsr commonIdle、dshDone←mate happy、
  dshError←hsr stun 兜底、idle 稀有←mate pose1/2/3），**不动 catalog、不复制文件**；alias id 固定
  `<set>-<clip>-<mood>`〔码〕。
- 坑：**priority 只作准入/排序，不会让低优先级更稀有**（V7 变体池是均匀随机）；真稀有要用 `rareVariant` 权重
  （已实现，priority ≤ −7 → 0.3）或行为层概率门〔文/码〕。

#### H2. grounding 兜底行为（数据未标注 = pose grounding）
- 三态见 D3：显式 feet / 显式 none / **未标注 → pose**。mate 集全部未标注 → app 对每个 clip 采样 16 帧算
  「全 raw 骨最低点」常量偏移；实测 offset：sit1 −0.414m、sleep −0.884m、walk −0.022m、drag 0（排除）〔文/数〕。
- 坐/睡残差 ≤8cm（≈42px）；smoke 只对 stand 断言 <2.5px。坐窗沿另用 `poseHipsAboveLowestM` 锚 hips。
- 新源注意：**不要指望 pose grounding 能救「空中技能/跪趴/躺」**——数据要显式标；catalog-only 动作若被事件播放，
  grounding 也会按同一规则算，非站立动作必须自己确认竖直位置。

#### H3. 一次性事件与状态机契约
- 事件映射与优先级见 §1.6；新源动作若要做事件反应，优先加进 `EVENT_CLIP_IDS`（id 优先）或靠 `tags`（catalog tag
  回退只接受 `loop:false` 且 `mood:null`），不要改行为状态机。
- `dshError` 案例是「进入/离开 mood 的 one-shot + hold」范式：`enterClip:'hsr-breaked'`, `enterHold:true`,
  `exitClip:'hsr-revive'`；`hsr-stun` 只做兜底。新源若要接类似「倒地/起身」序列，照抄该模式（进/出各一条 + hold），
  不要指望单条 loop clip。
- 入场序列是「播放列表」：`introStart→introLoop→introEnd`，默认关；player 只有单条 `playClipById`，序列编排在
  `animator.ts`/`main.ts`，不在 player 扩〔文/码〕。

#### H4. 降级与失败策略（红线）
- 清单/clip 缺失、坏 JSON、坏轨道：registry/player 只 warn 一次、保持当前动作或静态 rest、**不抛**；
  animator 所有子层 try/catch。新源接入必须保持这个性质（新源数据损坏不能让宠物崩溃）。
- 红线：player **不写 `avatar.scene`/场景 root 的 position/rotation/scale**（摆放/朝向归场景层）；米制世界单位
  `modelRoot.scale=1`（spring 物理不能被 ~312× 缩放破坏）；`pet-asset://` 只读 `assets/**`，CSP `connect-src` 需 `blob:`
  （GLTFLoader 的 ImageBitmapLoader 会 fetch(blobURL)，否则 MToon 贴图全白）〔文/码〕。

### I. 视觉 QA 方法（两波都验证过）

1. **三视角 + 手脚特写接触表**：`preview-hsr.mjs --views front,side,threeQuarter,hand,feet`（HSR）/`preview-clips.mjs
   --sheet` + `PREVIEW_HANDS=1`（U 侧）；每 clip 0/20/40/60/80% 帧 + 全 clip 首帧总览；证据在
   `tests/tmp/hsr-motion/preview-tpose*`、`tests/tmp/wave15/final-tpose`、`tests/tmp/fingers/{preview,montages}`〔数：目录存在〕。
2. **与官方源逐帧对拍**：HSR 用官方 FBX 渲染的同帧 vs 新 T-pose 输出（`verify-official-pose-tpose.jpg`、
   `verify-4issues-tpose.jpg`、`before-after-apose-vs-tpose.jpg`），重点核对「动作语义」（手搭膝盖/盖脸/垂手方向），
   不是像素级〔文/数：文件存在〕。
3. **三方 GT 对比**：Unity+UniVRM（同引擎 GT，最严格）> Blender 参考渲染 > three-vrm 回放；数值用 ΔW/关节相对旋转，
   视觉用三视角；参考视频只能到「手势级」（官方 trailer/B站素材手指 10–25px、被大袖遮挡，无法逐关节）〔文〕。
4. **自然度 metrics**：`preview-clips --metrics` 输出每 clip 世界空间骨位置与 `maxGroundPenetration/footYMaxJump/
   hipsLateralDrift/kneeFlex/loopSeam/frameJump` 等；T-pose 版 29 clip = PASS 23/WARN 6/FAIL 0，WARN 全是动作意图
   （侧移/膝屈/脚部跳变），无结构 FAIL；旧 A-pose 版是 PASS 22/WARN 5/FAIL 2（drag 穿地 0.217m）→ 说明**模型 rest
   错了 metrics 也会骗人**〔文/数〕。
5. **A/B 对照**：改动前后同帧拼图（旧/新资产、raw vs spring、axis x vs z、修 fingers 前后），一张图说明问题。

---

## 3. 新动作源接入 checklist（3ds Max Biped `.max` 版，可直接照做）

> 原则：**先采样、再 dry-run、再全量**；每一步留可复跑命令 + 报告 + 证据；任何「文档说可以」都先用代码/小样本验证。
> 下面的 `[门禁]` = 不通过不许进下一步。

### Step 0 · 前置决策（写成一页 SCOPE，先拍板再动手）
- [ ] **路线选择**：3ds Max 不能直接被 Blender/Unity 读 → 必须先在 Max 侧/导出侧落到可采样骨架。两条落点：
  - **0a** 导出 FBX（含骨架+动画，不需要蒙皮权重）→ 复用路线 A 的 Blender 采样器（推荐，已验证）；
  - **0b** 在 3ds Max 内用 MaxScript/Python 直接吐 `samples.json` 同 schema（推荐省一次转换，但要自己保证坐标系/单位）。
- [ ] **目标契约**：读 `src/shared/vrm-manifest.json` → 目标 `aventurine-tpose.vrm`；用
  `node --input-type=module -e 'import {...} from "./scripts/vrm/motion/lib/vrm-rest.mjs"…'` 或 `validate-hsr-clips` 的
  report 确认：humanoid 骨数（53）、有无 upperChest/jaw/eyes、SpringBone（50/175/170）、hips rest（1.0661m）、
  feet rest y、yawOffsetDeg（0）〔门禁〕。
- [ ] **数据契约**：新 clip 必须遵守 §1.3；`space:'gltf-rh'`、`fps:30`、`sourceHipsHeight`=源 rest hips 世界高度（米）、
  `grounding` 显式声明、`rawPolicy` 显式声明。
- [ ] **授权/红线**：`.max` 动作如果是官方游戏资源 → 仅本机私有；产物进 `assets/motions/<set>/`（gitignore）；
  不改现有文件；不提交 git。
- [ ] **未知项清单**（Biped 特有，先列出来待实测，不要假设）：Biped 骨架的 rest 是 T/A-pose？脊柱节数？
  锁骨/肩/手指/脚趾命名与节数？单位（Max 系统单位 vs 米）？是否有非均匀缩放/拉伸？`.bip` 还是逐帧烘焙？
  动作是否 in-place？动作帧率？〔推〕

### Step 1 · 采样（源侧，一次性）
- [ ] 在 3ds Max 侧导出/采样，产出与 `tests/tmp/hsr-motion/samples.json` **同 schema** 的中间文件：
  `rest{bone:{quat[x,y,z,w], head[x,y,z], parent}} + children + clips{id:{action,takeMatch,srcFrames,frames,
  data:[{f, q:{bone:quat}, h:{bone:head}}]}} + sourceFps/fps/sourceHeightMeters/sourceHipsHeightMeters`〔门禁〕。
- [ ] 采样规则：统一 30fps（源 60fps 用整数步长 2）；非 loop 补末帧；全骨采样（不预筛，映射在 retarget 做）；
  记录源 take 名（Max 的 "Bip01 ..." 层名/动作名）。
- [ ] **量 sourceHipsHeightMeters**：源 rest hips 骨 head 的世界高度（米），不是 bbox 身高、不是身高。
- [ ] 检查/记录：单位换算（Max 1 unit = ? m）、左右手性（Max 是 Z 向上右手系，导出 FBX 时注意 up-axis 设置）、
  朝向（角色面向 +Y 还是 +Z）、缩放（Biped 常有 stretch，检查 rest 骨长是否一致）〔推，必须实测〕。
- [ ] 证据：`samples.json`（gitignored）、extract 日志（含 take/帧数/height 打印）、源文件路径（若源文件不在仓库，写进 doc）。

### Step 2 · 映射 + dry-run（不写最终 clip）
- [ ] 建 `sourceBone↔VRM normalized` 映射表（覆盖 52 骨：22 核心 + 30 手指；缺的骨明确列表）。
  参考 `scripts/vrm/motion/lib/humanoid-hsr.mjs` 的 22/52 结构与 `UNITY_NAME_BY_VRM` 输出键。
- [ ] 用 `lib/vrm-rest.mjs#buildAlignment` 算 R_align（源 rest 骨几何 → 目标 rest 骨几何；目标缺 upperChest 时
  up 轴 fallback chest）〔门禁：R_align 应能解释朝向，否则说明映射/轴错〕。
- [ ] 用 `lib/rest-direction-fix.mjs#buildRestDirectionFix` 跑逐骨 rest 方向差：输出 group count/corrected/max/mean
  〔门禁：手臂/手/手指组 max 差 >0.5° 必须进修正表；躯干组差 >2–3° 先查映射；脚/趾的已知语义差不要修〕。
- [ ] 干跑指标（对齐 `retarget-report.json` 的字段）：每 clip frames/humanoidBones/upperChestFallback/restFix/rawPolicy/
  grounding/groundStats/trimmedReferenceFrames/translation；**手腕相对躯干误差目标 ≤~2cm、掌心法线 ≤~10°**〔文基线〕。
- [ ] `[门禁]` dry-run 报告通过再全量；不通过先改映射/修正，不要开始写 manifest。

### Step 3 · 重定向实现（复用 vs 新脚本）
- [ ] 推荐：复制 `scripts/vrm/motion/lib/retarget.mjs` 的语义，把 HSR 专属部分参数化：
  `worldDelta`/`applyAlignment`/`localNormalizedQuat`/`clipFrameCount`/`simulateNormalizedHumanoid`/`applyFootGrounding`
  可直接复用；HSR 映射表换成新映射；`secondary-map` 视 rawPolicy 决定是否启用。
- [ ] 必须实现的顺序（缺一不可）：① 每帧源世界 delta（`R_pose·R_rest⁻¹`）；② `R_align·D·R_alignᵀ`；③ rest 修正
  （手臂/手/手指）；④ 目标 normalized 局部 q（`effectiveParent` 链）+ 连续性；⑤ UpperChest identity（目标缺失时）；
  ⑥ Hips 位移（减首帧→R_align→in-place→staging 归零）；⑦ grounding（仅 feet）；⑧ `rawPolicy`。
- [ ] 输出 clip JSON（§1.3 全字段）+ `retarget-report.json`（每 clip 报告 + warnings）。
- [ ] `[门禁]` 单 clip 先跑通（idle），再全量；全量后跑 Step 4。

### Step 4 · 数据门禁（不通过不许 build manifest）
- [ ] `node scripts/vrm/motion/validate-hsr-clips.mjs --dir assets/motions/<set>`（或复用其 lib 写新 CLI）
  → **FAIL=0**；WARN 逐条人工判定（快速手指/源数据跳变可接受，接缝/贴地/结构不可接受）〔门禁〕。
- [ ] U 侧双保险：`node scripts/unity-bake/validate-clips.mjs --dir assets/motions/<set>`（注意它默认 22 必需骨；
  52 骨数据会把手指当 unknown → 传/改 `CLIP_OPTIONAL_BONES` 或在你的 CLI 里复用 `validateClipData`）〔门禁〕。
- [ ] 检查硬指标：frames↔duration*fps；四元数单位化/连续性；Hips.p 首帧 0；UpperChest identity；52 骨/22 核心齐全；
  循环接缝 ≤6°（WARN>2°）；帧跳变 ≤150°（WARN>75°）；grounding=feet 的穿地≤3cm/悬空≤6cm 或明确记录残差〔门禁〕。
- [ ] 证据：`validation-report.json`（写进 tests/tmp）+ 逐条 WARN 的处置说明。

### Step 5 · 源集清单 → app 清单
- [ ] 写/扩展源集 selection：`<set>/clips.json`（id/path/takeMatch/srcFrames/loop/slot/tags/priority/grounding/note），
  与 clip 数据一一对应（`validate-clips --config` 的交叉检查会抓缺/多）〔门禁〕。
- [ ] `build-<set>-manifest`（或复用 `build-motion-manifest.mjs` 的形状）→ `<set>/manifest.json`（+ 需要的 mirror），
  检查 `checks.ok=true`、`coverage` 达到 requirements。
- [ ] `node scripts/vrm/motion/build-app-manifest.mjs --check`：**先确认新 set 已加进 `SOURCE_SETS` 或产物会被重生成**
  （当前脚本固定 `['mate','hsr']`；新 set 要改脚本并同步测试）〔码：build-app-manifest.mjs `SOURCE_SETS`〕〔门禁〕。
- [ ] 定 mood 绑定策略：循环/站立/可长期保持的 → app-manifest（slot+priority）；一次性/表演/特殊锚点 → catalog-only；
  需要 DSH 事件 → `MOOD_CLIP_ALIASES`；special 姿态 priority 放 < −9 或只进 catalog。
- [ ] 不手改 `app-manifest.json`/`app-catalog.json`；重跑生成后 `--check` 幂等〔门禁〕。
- [ ] 证据：manifest 报告、app-manifest diff、`--check` exit 0 的日志。

### Step 6 · 预览 + 视觉/GT 验收
- [ ] 三视角 + 手脚特写接触表（复用 `preview-hsr.mjs` / `preview-clips.mjs`；新 set 需要改 preview 的目录参数或
  `PREVIEW_MOTIONS_REL`）；检查：无穿模/反关节/破面/脚滑/悬空、手指手型、朝向正面。
- [ ] GT 对拍（**必须**）：Unity+UniVRM 或 Blender 对**同一目标 VRM** 逐帧采姿态 vs three-vrm 回放同一 clip，
  算 ΔW/关节相对旋转；目标量级参考：同模型 ΔW mean ~3.4°（T-pose 版）、手臂 normalized mean ~0°〔门禁〕。
- [ ] 单骨探针：已知旋转（如 right +90°）走一遍 exporter→retarget→player，ΔW 应为 0.00°〔门禁：轴/反射/手性无错〕。
- [ ] 跨模型不变性（可选）：同一 clip 换另一个 VRM（Zome/canary）回放，ΔW 应只差 rest/父链语义（本仓库有案例）。
- [ ] 自然度 metrics（如有）：穿地/接缝/膝屈/侧移/帧跳变；WARN 逐条给语义解释。
- [ ] 证据：接触表 jpg、GT metrics json、对拍拼图、preview 日志。

### Step 7 · app 接线（按 §1.6/H 规则）
- [ ] 只改「数据 + 生成脚本 + 测试」，不改冻结契约（`src/shared/vrm.ts`/`animation-contract.ts` 需契约变更评审）；
- [ ] mood 槽位合法（13 个之一或 null）；priority 符合准入（轮换 ≥ −9；稀有 ≤ −7 权重 0.3）；一次性只用 catalog；
- [ ] grounding 声明正确（非站立必须 none 或由场景锚点接管）；drag 类自动 none；
- [ ] 改完后跑：`pnpm typecheck && pnpm test`、`node scripts/vrm/motion/build-app-manifest.mjs --check`、
  smoke（`PET_MODEL_BACKEND=vrm PET_SMOKE_TEST=1 pnpm smoke`，证据 tests/tmp/wave2 系列命令）〔门禁〕。
- [ ] 实机验收项（沿用 Wave 2 §3 清单）：待机/走路/坐/摸头/拖拽/注视/材质 spring/性能；新动作加截图为证。

### Step 8 · 回归与清理
- [ ] `pnpm test` 全绿 + `pnpm typecheck` 0；旧的 vrm-motion / unity-bake 单测不能回归；
- [ ] 更新测试里的硬编码列表（22 骨/52 映射/槽位/coverage/manifest 计数），新增 fixture（不要读私有 assets 的单测）；
- [ ] 清理：临时 out/、日志不进 git；私有资产全部 gitignore；旧数据归档目录命名（参考 `hsr-apose-legacy`）。

### Step 9 · 证据与交接
- [ ] 写 `docs/<新源>-report.md`（管线/根因/数字/命令/限制/授权），风格对齐 `docs/vrm-motion-hsr.md`；
- [ ] 保留：samples.json、retarget-report.json、validation-report.json、manifest-report.json、preview 接触表、GT metrics、
  对拍 jpg、app `--check` 日志；全部在 tests/tmp 或 assets（gitignore）；
- [ ] 交接说明里写清「哪些是实测、哪些是待验证」，以及回滚方式（旧数据/旧 manifest/旧 axis 约定）。

### 附：3ds Max Biped 特定的高风险点（先验证再写代码）〔推〕
1. **rest 姿势**：Biped 常见 T-pose/A-pose 混合（手臂 45°），且 Figure Mode 的 rest 与导出 FBX 的 rest 可能不同——
   必须采「导出后实际 rest」，不能采编辑界面姿势；
2. **脊柱节数**：Biped 可配置多节脊椎（Spine/Spine1/...），可能比目标多；映射必须显式「合并到 chest / 丢弃 / 加 raw」；
3. **单位/缩放**：Max 场景单位、FBX 导入 scale、Biped "Height" 都可能引入 0.01/0.1 缩放；用 hips 高度对账
   （目标 1.0661m、HSR 源 0.9502m 是参考量级；人形角色 hips 通常 0.9–1.1m）；
4. **朝向/轴**：Max Z-up 右手系；FBX 导出 up-axis 与 forward-axis 设置会改变四元数；导出后先做「单骨探针」再信任数据；
5. **Biped 的脚/趾**：Biped 脚部结构（Foot/Toe）与 VRM toes 语义可能不同，rest 方向差 14° 是已知 HSR 案例，
   **不要盲目修正**（会穿地），用 grounding 兜底或显式声明语义；
6. **动作层**：如果动作是 `.bip`/BIPED 层而非逐帧烘焙，先「Bake to keyframes」再采样；loop 动作确认首末帧循环性
   （Biped 的循环动作常带首末重复帧 → 对应我们的「循环不重复末帧」约定要截掉）。

---

## 4. 现成可复用数据/工具盘点（2026-11-09 本机实测）

### 4.1 clip 数据（都在 `assets/motions/`，gitignore，私有）

| 路径 | 内容 | 磁盘实测 |
|---|---|---|
| `assets/motions/hsr/**` | 14 clip × 52 骨（22+30 指），`rawPolicy=spring`（无 raw），`targetVrm=assets/vrm/aventurine-tpose.vrm`，grounding feet×5/none×9 | 3.9 MB；manifest 14 clips / checks.ok=true / coverage idle5 show8 react3 pose1 weak1 skill5 |
| `assets/motions/mate/**` | 29 clip × 52 骨（含 fingerSource），无 grounding 字段（app pose grounding），sourceHipsHeight=1 | 38 MB；manifest 29 / ok / coverage idle7 walk2 sit7 interaction4 sleep1 hiding2 intro3 pose3 |
| `assets/motions/hsr-apose-legacy/**` | 旧 A-pose 目标下重定向的 14 clip × 52 骨 + **186 条 raw 轨道**（回滚用） | 13 MB；manifest 14 / set=hsr |
| `assets/motions/app-manifest.json` | 32 条 mood 候选（idle15/walk2/sit7/drag1/pat3/sleep1/dshBusy1/dshDone1/dshError1） | 8 KB |
| `assets/motions/app-catalog.json` | 43 条全量索引（mate29+hsr14；17 条 mood:null 一次性） | 12 KB |
| `assets/motions/validation-report.json` | mate 29 PASS 的报告（历史） | 36 KB |
| `assets/motions/manifest.json` | mate 的宽路径镜像（与 mate/manifest.json 同内容） | 12 KB |

### 4.2 源资产

| 源 | 是否还在磁盘 | 说明 |
|---|---|---|
| HSR 官方 FBX `Avatar_Aventurine_00.fbx` | **不在**（/tmp/sandgold-probe 已删） | 但 **采样结果在**：`tests/tmp/hsr-motion/samples.json`（53.7 MB，236 骨 rest + 14 clip 逐帧 q/h，`fbx` 字段仍记录原路径）。**再重定向不需要 FBX**，只需 samples.json + clips.hsr.json；重新采样才需要 FBX |
| Mate-Engine Unity `.anim` | **在**（`refs/Mate-Engine/Assets/MATE ENGINE - Animations/`，128 个 `.anim`，仓库 2.4G 只读克隆） | 重新导出需要 Unity 6000.2.6f2 + 授权（`unity license --json`，当时有效期至 2026-11-18） |
| 3ds Max Biped 新源 | **不在**（待用户提供） | 新任务的核心输入；先按 §3 Step 0 列未知项 |
| PMX 源 | 在：`assets/model/optimized/星穹铁道—砂金·戏浪.pmx`（3.1M）等 | 用于 VRMify 重转 T-pose VRM |
| VRM 资产 | 在：`assets/vrm/aventurine-tpose.vrm`（25.9M，当前目标）、`aventurine-waveflair.vrm`、`aventurine-waveflair-legfix.vrm`、`canary/…`、zip/原始 VRM | 全部 gitignore |
| Unity GT 工程 | 在：`work/UnityGroundTruthProj`（Assets/Clips/Editor）、`work/AventurineBakeProj`、`work/finger-probe/**`、`work/gt-*.mjs` | dev-only，gitignore |
| Blender | 在：`/Volumes/4TB外置盘/deepseek-harness/tools/blender/Blender.app`（4.2.23 LTS） | 采样脚本依赖 |
| Unity CLI | 在：`~/.unity/bin/unity` | license 有有效期，过期要重激活 |

### 4.3 现成证据（可复看/复跑；`tests/tmp/**` gitignore）

- `tests/tmp/hsr-motion/`：`samples.json`、`retarget-report.json`（含 restFix/grounding 全数字）、`validation-report.json`
  （PASS 11/WARN 3/FAIL 0 + U validator 430 warnings）、`evidence-tpose/*.jpg`（官方源对拍/4 问题修复）、
  `preview-tpose*`（接触表）、`tpose-impact/SCOPE.md`（T-pose 切换影响面/raw 方案 A/B）。
- `tests/tmp/wave15/`：`validation-report.json`、`tables.md`/`analysis.json`、`final-tpose/` + `final-tpose-metrics/`
  （29 clip 接触表与 metrics，PASS23/WARN6/FAIL0）、`groundtruth/`（Unity GT 数值/截图/REPORT.md）、`compare/`（跨模型对拍）、
  `reference/`（官方媒体抽帧索引）。
- `tests/tmp/fingers/`：348 PNG 手部/全身预览、29 份 metrics、`montages/{HANDS,FULLBODY,BEFORE-AFTER}.jpg`、
  `representative-frames.json`。
- `tests/tmp/wave2/`：实机 overlay 截图（待机/走路/坐/摸头/拖拽/error 序列/startup 首帧）、smoke 日志、重启 3 轮摘要。
- `work/`：GT 脚本（`gt-*.mjs`）、finger probe/analysis、`backup/mate-pre-finger/`（22 骨回滚备份）、
  `u3-validation-report-final.json`（29 PASS）、`u3-precheck-report.txt`（选片静态预检）、
  `scripts/unity-bake/logs/`（Unity 导出日志）。

### 4.4 工具/文档索引

| 类型 | 入口 |
|---|---|
| HSR 管线文档 | `docs/vrm-motion-hsr.md`（V3.1 报告）、`docs/vrm-tpose-repair.md`（T-pose+axis 修复） |
| U 管线文档 | `docs/unity-bake-report.md`（U1 环境/首批）、`docs/wave15-report.md`（U2/U3 总报告）、`docs/wave15-fingers-report.md`、`scripts/unity-bake/README.md` |
| 契约 | `docs/vrm-contract.md`、`src/shared/vrm.ts`、`src/shared/animation-contract.ts`、`src/shared/{vrm-manifest,motion-manifest}.json` |
| app 接线 | `docs/wave2-acceptance.md`、`docs/wave2-vrm-runtime-design.md`、`docs/vrm-motion-mapping-recommendations.md` |
| 并行 lane（历史/勿混） | `docs/anim-acceptance.md`（Wave 2.5 **legacy PMX+VMD** 验收，VMD 资产已在 Wave 2 删除、代码保留）、`docs/research/motion-assets.md`（MMD/VMD 源调研，pre-VRM lane） |
| 测试 | `tests/vrm-motion-{retarget,qa,secondary}.test.ts`、`tests/unity-bake-*.test.ts`、`tests/vrm-clip-player.test.ts`（67KB，覆盖变体/事件/grounding/降级）、`tests/animation-contract.test.ts` |

---

## 5. 本次「文档 vs 实读代码/数据」核对结论

> 结论与实现/数据不一致时，**以代码/数据为准**；下表列出本次实读发现的偏差与已验证事实（便于新任务引用时不被旧文档误导）。

### 5.1 发现的文档偏差（建议后续修订，本文不修改现有文件）

| # | 文档说法 | 实读结果 | 判定 |
|---|---|---|---|
| 1 | `docs/unity-bake-report.md` §3：「坐标反射轴用 **Z**，不是 X；X 反射下手臂翻转」 | 当前 `run-export.sh` 固定 `--axis x`、`convert-clips.mjs` 默认 x；`docs/vrm-tpose-repair.md` 解释 axis z 只适配旧 −Z 资产 | **历史结论已被覆盖**（旧 A-pose 资产时代）。以代码 x 为准 |
| 2 | `docs/wave2-acceptance.md` §2：「app-manifest **29 clips**」 | 磁盘 `assets/motions/app-manifest.json` = **32**（15 idle 等）；README/build-app-manifest 也写 32 | **文档过期**（写在 V7/V11 alias 之前）。以磁盘 32 为准 |
| 3 | `docs/wave2-acceptance.md` §2：「50 spring 链 / 170 joints / **600 colliders**」 | GLB 实读 `VRMC_springBone`：50 链 / 175 colliders / 170 joints；`vrm-tpose-repair`/`vrm-motion-hsr` 也写 175 collider | **600 属误记**（或其口径不同）。以 175 为准 |
| 4 | `docs/vrm-tpose-repair.md` §2.1：「54 humanoid 骨（含 30 手指 + toes）」 | `buildVrmRest` 实读 = **53**（无 upperChest；21 核心+30 指+2 eyes）；同文 §5/vrm-motion-hsr 也写 53；旧 legfix 才是 54 | **笔误**。以 53 为准 |
| 5 | `scripts/unity-bake/README.md` §输出 schema：「r 已转 glTF 右手系，**反射 Z**」 | 当前 `--axis x`（反射 X）产物 | **文档过期**（同 #1） |
| 6 | `docs/vrm-motion-hsr.md`：「135 take / 236 骨 / 29 条全身 take / 54 条 locomotion 无身体动画…」 | 无法复验（FBX 已不在磁盘）；但 `samples.json` 实读 **236 骨 rest、14 clip**、源 fps 60→30、sourceHeight 1.839132、sourceHipsHeight 0.950175 | take 统计**仅文档**；采样事实已验 |
| 7 | `docs/vrm-motion-mapping-recommendations.md`：「sit1(prio 10) > sit2(9) > suwari3(8)」 | app-manifest 实读一致；`sitWindow/windowLay8/9/10` = −10/−11/−12/−13 | ✅ 一致 |
| 8 | Wave 1.5 文档称「29 clip 全部 52 骨」 | 磁盘 mate 29 clip 全部 52 骨、带 `fingerSource` | ✅ 一致 |
| 9 | HSR 文档称「PASS 11/WARN 3/FAIL 0；U validator 0 errors/430 warnings」 | `tests/tmp/hsr-motion/validation-report.json` 实读一致 | ✅ 一致 |
| 10 | HSR 文档称 restFix 36 骨/上臂 54.6° 等 | `retarget-report.json` 实读一致（max 88.41） | ✅ 一致 |
| 11 | HSR 文档称新目标 hips 1.066m、scale 1.122 | GLB 解析 hips rest = 1.066110；report scale 1.122015 | ✅ 一致 |
| 12 | HSR 文档称「rawPolicy=spring、raw 空」 | 14 clip 实读：`rawPolicy=spring`、无 `raw` 键、`rawMeta.mapped=0` | ✅ 一致 |
| 13 | HSR 文档称「UpperChest 轨道 identity」 | `hsr/idle.json` 实读 max 偏差 0.0000° | ✅ 一致 |

### 5.2 本次实读验证的关键事实（可直接引用）

- 目标 VRM（`assets/vrm/aventurine-tpose.vrm`）〔数〕：53 humanoid 骨；**无 upperChest / 无 jaw**；有 eyes；
  hips rest `[0, 1.066110, −0.005640]`；chest y=1.26117、spine y=1.07966；脚 rest y≈0.0983（leftFoot）/0.0520（leftToes）；
  `effectiveParent` hips=null、spine=hips、leftUpperLeg=hips；SpringBone 50 链/175 collider/170 joints。
- HSR samples.json〔数〕：236 骨 rest；14 clip；sourceFps 60 / fps 30；sourceHeight 1.839132；sourceHipsHeight 0.950175；
  原 FBX 路径 `/tmp/sandgold-probe/砂金/Animator/Avatar_Aventurine_00/Avatar_Aventurine_00.fbx`（已不存在）。
- hsr clip〔数〕：52 骨（22 核心齐全 + 30 手指）、`UpperChest` identity、`Hips.p[0]=[0,0,0]`、无 `raw`、
  `grounding` feet(5)/none(9)、`targetVrm/targetAvatarId` 有记录。
- mate clip〔数〕：52 骨、`grounding` 字段缺失（→ app pose grounding）、`sourceHipsHeight=1`、带 `fingerSource`。
- legacy clip〔数〕：52 骨 + 186 raw 轨、无 rawPolicy（旧管线）。
- app 清单〔数〕：app-manifest 32（idle15/walk2/sit7/drag1/pat3/sleep1/dshBusy1/dshDone1/dshError1）；
  app-catalog 43（mate29+hsr14，mood:null 17）；`build-app-manifest.mjs --check` 幂等设计。
- code 常量〔码〕：夹层 `MAX_FRAME_DT_SEC=0.1`；`VARIANT_ROTATION_MIN_PRIORITY=−9`；
  `RARE_VARIANT_PRIORITY_THRESHOLD=−7`/`WEIGHT=0.3`；`POSE_GROUND_MAX_SAMPLES=16`；
  `GROUND_EXCLUDED_SLOTS={'drag'}`；变体间隔 idle 12–20s / sit 15–30s / walk 10–18s / sleep none；
  事件优先级 thrown50>landed40>dragStart30>pat20>dragEnd15>poke10；`ANIMATION_CLIP_DEFAULTS={loop:true,timeScale:1,
  fadeInSec:0.15,fadeOutSec:0.2,priority:0}`；`timeScale∈[0.1,4]`、`priority∈[−100,100]`（manifest 侧）。
- 校验门禁〔码〕：见 §2-G 表（loop seam WARN>2°/FAIL>6°、frame jump WARN>75°/FAIL>150°、
  ground penetration WARN>0.03m/float WARN>0.06m、Hips first frame 1e-3m、quat norm 1e-3、dot<0 为 error…）。
- 环境〔文/数〕：Unity 6000.2.6f2 + Hub CLI `unity license --json` preflight；Blender 4.2.23 LTS；
  Electron 无头需 `--no-sandbox` + workspace `--user-data-dir`；Unity 需写 `~/Library/Application Support/Unity`
  （受限沙盒下会报 "Project folder or disk is read only"）。

### 5.3 只存在于文档、未在本次实读中复验的结论（引用时标注）

- HSR FBX 的 135 take / 29 全身 take / 54 locomotion / 17 Emo / 33 Monster 的统计（FBX 已删，只有 samples 的 14 clip）。
- 「官网视频/Steam 截图里角色不是 Zome，而是自定义 workshop 模型」等参考媒体结论（媒体素材在 tests/tmp/wave15/reference）。
- `docs/anim-acceptance.md` 与 `docs/research/motion-assets.md` 的 VMD/MMD 结论属于 **pre-VRM legacy lane**；
  Wave 2 已删除 VMD 动作资产（`wave2-acceptance` §5.6），当前主链是 VRM clip，不要把两套契约混用。

---

## 6. 附录：阈值与路径速查

### 6.1 「硬性」门禁速查（发版前必须全绿）

1. `validate-hsr-clips --dir <set>`：**FAIL=0**；`validate-clips --dir <set>`：**error=0**；
   `build-motion-manifest --check` / `build-hsr-manifest --check`：**exit 0**；
   `build-app-manifest --check`：**exit 0**。
2. `pnpm typecheck` exit 0；`pnpm test` 全绿；`tests/unity-bake-humanoid-map.test.ts`/`animation-contract.test.ts`
   （契约同步）全绿。
3. 视觉：目标模型上三视角+手脚特写无穿模/反关节/破面；GT 同模型 ΔW mean 与历史基线同量级（≈3–4°）；
   单骨探针 ΔW≈0°。
4. 数据红线：52 骨（或目标实际骨集）齐全；22 核心骨在任何 target 下都能满足契约（缺的用 identity）；
   `Hips.p` 首帧=0；循环接缝/帧跳变/贴地在阈值内或已书面豁免。

### 6.2 常踩的「看起来没问题其实错了」

- 镜像/手性错误：渲染还在动，但左右反了 → 必须 GT/探针。
- grounding 语义误用：mate 未标注→pose 兜底；hsr 显式 none→不兜底；`drag` 排除；非站立别标 feet。
- priority 当稀有权重：轮换池均匀随机，稀有要用 rareVariant 权重（≤−7→0.3）。
- 手改 app 清单：下次 `build-app-manifest` 会覆盖；`--check` 会失败。
- 重烘数据后忘了重建 manifest：`--check` 报「字段与现状不一致」。
- 换目标 VRM 不重标定：rest/hips/yaw/upperChest/spring 全变，旧 clip 全部作废（参考 `hsr-apose-legacy` 归档做法）。
- 采样侧用了 bbox 身高做 Hips 缩放：位移幅度错 1.4–2.4×。
- 预览静帧没按 delta 步进 spring：误判「头发/衣摆不动」。

### 6.3 关键路径

```
脚本：scripts/vrm/motion/{extract-hsr-anims.py,retarget-hsr.mjs,validate-hsr-clips.mjs,build-hsr-manifest.mjs,
      preview-hsr.mjs,build-app-manifest.mjs,lib/*.mjs}
脚本：scripts/unity-bake/{run-export.sh,convert-clips.mjs,validate-clips.mjs,build-motion-manifest.mjs,
      merge-finger-tracks.mjs,preview-clips.mjs,tune-pose.mjs,Editor/ClipExporter.cs,lib/*.mjs}
数据：assets/motions/{hsr,mate,hsr-apose-legacy}/**、assets/motions/{app-manifest,app-catalog,manifest}.json
契约：src/shared/{vrm.ts,animation-contract.ts,vrm-manifest.json,motion-manifest.json}
运行时：src/renderer/src/vrm/{clip-registry.ts,clip-data.ts,clip-player.ts,animator.ts,humanoid-map.ts,
        foot-lock.ts,look-at.ts,expression-layer.ts,pet-scene-vrm.ts}
证据：tests/tmp/{hsr-motion,wave15,fingers,wave2}/**（gitignore）
```

---

## 7. 一句话给下一个接 3ds Max Biped 的人

**先把「源采样 JSON + 目标 VRM rest 实测 + R_align/rest 修正 dry-run」三件事做对，再谈重定向代码；数据格式照抄
§1.3、门禁照跑 §6.1、app 接线照 §1.6/H——前两波 90% 的返工都发生在「跳过 dry-run/GT 对拍」和「把文档旧结论
（axis z / 22 骨 / 29 clip）当现状」这两件事上。**
