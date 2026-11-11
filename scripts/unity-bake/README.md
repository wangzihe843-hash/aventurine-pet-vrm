# Unity 烘焙导出（U1/U2）

> 目标：把 Mate-Engine 的 Unity Humanoid `.anim`（idle / 窗沿坐 / 被拖拽 / 睡 …）导出成 app 能播的 clip 数据。
> 状态：**U1 已跑通（2026-11-08）**，首批 8 个 clip 已导出并在 canary/戏浪 VRM 上渲染验证；
> **U2 工具链已完成**（clip 校验 / motion manifest / 预览度量 / 接触表，见下文）；U3 扩到 25–35 个片段的
> selection 与导出由 B lane + Lead 负责（`clips.json` 为最终清单）。

## 结论（先看这个）

- **不需要导入 2.4GB 的 Mate-Engine 工程**：建一个最小 Unity 工程，只拷 128 个 `.anim`，用 `AvatarBuilder.BuildHumanAvatar` 合成标准 humanoid 骨架采样即可。
- **旋转坐标转换反射轴由目标模型朝向决定**：`--axis z` 用于面向 -Z / VRM0 风格资产（canary、Zome、旧 waveflair）；`--axis x` 用于标准 VRM 1.0（面向 +Z、左手 +X，当前 `aventurine-tpose.vrm`）。两者差一个绕 Y 的 180° 约定，选错会左右镜像（手臂朝上/扭曲）。见 `docs/vrm-tpose-repair.md`。
- **Hips 位移使用 `--hips-mode relative`**：Unity humanoid 重定向到合成骨架会带一个约 0.2–0.4m 的常驻偏移，减去首帧后 idle/walk 才居中；坐/躺 clip 的整体高度交给 app 摆放。
- 采样结果：22 核心骨（U2 合成骨架）+ **30 手指（2026-11-08 追加，来自 Unity+UniVRM 真实 VRM avatar 手指探针 + normalized 合并）**，
  共 52 骨、30fps、四元数单位化；见 `assets/motions/mate/*.json`（gitignore 私有）与 `docs/wave15-fingers-report.md`。

## 文件

| 文件 | 作用 |
|---|---|
| `Editor/ClipExporter.cs` | Unity Editor 脚本：最小工程 → 合成 humanoid 骨架 → `AnimationMode` 逐帧采样 → `out/*.json` |
| `clips.json` | 配置：clipsRoot、8 个 clip 清单（已排除舞蹈）、syntheticAvatar |
| `run-export.sh` | 一键：创建/复用 `work/AventurineBakeProj` → 拷 `.anim` → 注入脚本 → batchmode 导出 → 转 glTF clip |
| `convert-clips.mjs` | Unity(左手) → glTF(右手) 转换：`--axis x`（标准 VRM1，当前）/`--axis z`（-Z 朝向旧资产）、hips relative、四元数连续性 |
| `tune-pose.mjs` + `lib/pose-tune.mjs` + `pose-tune.json` | 初始姿态微调：对指定 clip 的帧区间叠加骨骼轴角偏移（线性淡出），只动 introStart 起始站立段的手臂；`run-export.sh` 在 convert 之后自动调用；幂等标记防叠加 |
| `clip-viewer.html` / `clip-viewer.js` | 预览页：three-vrm 加载 VRM，把 clip 应用到 normalized humanoid 骨骼并渲染；`captureHandAt` 提供手部特写相机（手指验收） |
| `merge-finger-tracks.mjs` | 把 Unity GT 手指探针（全部 humanoid 骨 worldRot）换算成 three-vrm normalized 手指 `r`，合并进已烘焙 22 骨 clip → 52 骨（含 22 骨护栏校验） |
| `preview-clips.mjs` / `preview-electron.mjs` | 无头 Electron 批量抓帧（+ 可选逐帧自然度度量）→ `tests/tmp/clip-preview/` |
| `contact-sheets.mjs` | 把预览 PNG 组成每 clip 4 帧接触表 JPG + 全 clip 首帧总览 JPG（依赖 sharp） |
| `validate-clips.mjs` | clip 数据校验 CLI：PASS/WARN/FAIL 表 + JSON 报告 |
| `build-motion-manifest.mjs` | 由 `clips.json` selection + clip 数据生成/校验 motion manifest |
| `lib/humanoid-map.mjs` | Unity Humanoid ↔ VRM normalized 骨骼映射 + 契约槽位（纯 ESM，浏览器/Node 共用） |
| `lib/clip-validation.mjs` | clip 数据校验/统计纯函数（结构与天然度规则） |
| `lib/motion-manifest.mjs` | motion manifest 构建/一致性校验纯函数 |
| `lib/cli-args.mjs` | 工具用极简 CLI 参数解析（--help/非法参数约定） |
| `out/` | 原始导出（临时，gitignore） |
| `logs/` | Unity 日志（临时，gitignore） |

## 运行

```bash
cd /Volumes/4TB外置盘/deepseek-harness/aventurine-pet-vrm

# 导出 + 转换（需要 Unity 6000.2.6f2 + 已激活 license）
bash scripts/unity-bake/run-export.sh
# 导出执行器（2026-11-08 起，B lane 改）：
#   - 首选 Unity Hub 自带 CLI `unity run <project> --timeout … --no-tail -- -executeMethod … -logFile …`
#     （CLI 从 PATH 或 ~/.unity/bin/unity 发现；batchmode/quit 由 CLI 自动加，参数经 `--` 转发）；
#     运行前先 `unity license --json` 做授权 preflight，无有效 Unity 授权直接报错退出；
#   - CLI 不可用时回退直接调用 Unity 二进制（$UNITY_EDITOR 或 Hub 默认安装路径）。
#   可选环境变量：UNITY_RUN_TIMEOUT（默认 900s）、PROJECT/CFG/OUT/UNITY_EDITOR。
# 导出完成后可复跑校验/manifest（见下文「U2 工具链」）：
node scripts/unity-bake/validate-clips.mjs
node scripts/unity-bake/build-motion-manifest.mjs && node scripts/unity-bake/build-motion-manifest.mjs --check

# 预览（默认戏浪 VRM；也可以换 canary）
node scripts/unity-bake/preview-clips.mjs --clips idle,walk,sitWindow,drag,sleep,happy,hideLeft,introLoop --vrm assets/vrm/aventurine-tpose.vrm
# 输出：tests/tmp/clip-preview/<clip>-<pct>.png
```

首次跑若找不到 Unity：设 `UNITY_EDITOR=/Applications/Unity/Hub/Editor/6000.2.6f2/Unity.app/Contents/MacOS/Unity`。
Unity 安装/环境记录见 `environment.md`，U1 报告见 `docs/unity-bake-report.md`。

## 手指补全（2026-11-08 追加，22 骨 → 52 骨）

> 背景/公式/验证见 `docs/wave15-fingers-report.md`。源 `.anim` 有 40 条手指 muscle 曲线，
> 但 U2 的合成骨架只采 22 骨；这里用 **Unity+UniVRM 真实 VRM avatar**（work/UnityGroundTruthProj，dev-only）
> 逐帧采样全部 humanoid 骨 worldRot，再按 three-vrm normalized 语义换算/合并手指轨道。

```bash
# 1) Unity GT 手指探针（目标模型；GT_ALL_HUMANOID_BONES=1 导出全部 humanoid 骨 worldRot）
GT_CONFIG="$PWD/work/gt-finger-probe-full.json" GT_MODE=full \
GT_OUT="$PWD/work/finger-probe/full-aventurine" GT_RENDER=0 GT_ALL_HUMANOID_BONES=1 \
  ~/.unity/bin/unity run "$PWD/work/UnityGroundTruthProj" --no-tail --timeout 1800 \
  -l "$PWD/work/finger-probe/run-full.log" -- -executeMethod GroundTruth.Exporter.Run

# 2) 合并手指轨道（先备份 assets/motions/mate；工具会重算 22 骨做护栏校验）
node scripts/unity-bake/merge-finger-tracks.mjs \
  --gt work/finger-probe/full-aventurine/unity --model aventurine \
  --in assets/motions/mate --out assets/motions/mate \
  --report work/finger-probe/full-merge-report.json

# 3) 校验 / 预览（手部特写）
node scripts/unity-bake/validate-clips.mjs
PREVIEW_HANDS=1 node scripts/unity-bake/preview-clips.mjs --all --vrm assets/vrm/aventurine-tpose.vrm \
  --out tests/tmp/fingers/preview --metrics tests/tmp/fingers/metrics
```

- `PREVIEW_MOTIONS_REL=work/xxx/clips` 可让预览读取试跑数据目录（默认 `assets/motions/mate`）；
- 手部特写相机在 `clip-viewer.js#captureHandAt`（3/4 视角 + 自动取景 hand/finger bbox）。

## 输出 schema（`assets/motions/mate/*.json`）

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

- `r`：相对静止姿势的归一化局部旋转（已转到 glTF 右手系，反射 Z）；
- `p`：仅 Hips，已减去首帧基准的位移（米）；
- 播放（three-vrm）：把 `r` 直接设到 **normalized bone node** 的四元数上，然后 `vrm.humanoid.update()`，它会自动转到 raw 骨骼；Hips 位移加到 normalized hips 的 rest 位置上；
- **手指（可选）**：2026-11-08 起 29 clip 额外含 30 条手指轨道（Unity 名 `LeftThumbProximal`…）；
  `lib/humanoid-map.mjs` 会把它们映射到 VRM normalized 手指骨（拇指错位一节：Unity Proximal/Intermediate/Distal ↔ VRM ThumbMetacarpal/Proximal/Distal）。

## U2 工具链：校验 / motion manifest / 预览度量（Wave 1.5）

> 纯 ESM lib（`scripts/unity-bake/lib/*.mjs`）不 import three/node-only 模块，浏览器
> （`clip-viewer.js`）与 Node CLI/单测共用同一份骨骼映射与校验逻辑。
> `assets/**` 全部私有（gitignore），工具只读 clip 数据，产物写 assets 下 gitignore 的报告/manifest。

### 1) clip 数据校验 `validate-clips.mjs`

```bash
node scripts/unity-bake/validate-clips.mjs            # 默认 assets/motions/mate + clips.json
node scripts/unity-bake/validate-clips.mjs \
  --dir assets/motions/mate \
  --config scripts/unity-bake/clips.json \
  --json assets/motions/validation-report.json
```

- 扫描 `--dir` 下所有 clip JSON（跳过 index/manifest/非 clip JSON），逐条打印 PASS/WARN/FAIL
  表（frames / duration / maxJump / hipsTravel / loopSeam / warn 数）并写 JSON 报告；
- 有 error → exit 1；只有 warning → exit 0；`--help` exit 0，非法参数 exit 2；
- `--config` 存在时交叉检查 selection 与磁盘的登记关系（缺/多 = warning）。

**校验规则**（`lib/clip-validation.mjs`，每条都有正反例单测）：

| 类别 | 规则 | 级别 |
|---|---|---|
| 顶层 | `version===1`、`space==='gltf-rh'`、`loop` 布尔、`fps>0`、`frames` 正整数、`duration>0` | error |
| 时长一致 | loop: `frames≈round(duration*fps)`；非 loop: `≈round(duration*fps)+1`；容差 ±1 帧（吸收 Unity `Mathf.RoundToInt` 与 JS `Math.round` 在 .5 边界的差异） | error |
| 骨骼 | 22 个必需骨缺一（`Hips/Spine/Chest/UpperChest/Neck/Head/Left\|Right …`）；未知骨忽略 | error / warning |
| 旋转 `r` | 支持 nested `[[x,y,z,w],…]`（convert-clips 实际输出）与 flat `[x,y,z,w,…]`；长度/元素合法、全有限、模长 ≈1（±1e-3） | error |
| 连续性 | 相邻帧四元数 dot ≥ 0（符号翻转） | error |
| 跳变 | 相邻帧夹角 > 60°/帧 | warning |
| Hips 位移 `p` | 仅 Hips 允许；长度=帧数（nested）/frames*3（flat）、全有限、首帧 ≈0（±1e-3m，relative 模式） | error |
| Hips 位移 | 单帧位移 >0.1m、总位移 >25m、loop 首末水平漂移 >0.1m | warning |
| loop 首末 | 全部骨首末差 <0.01°（疑似重复帧）、>45°（循环接缝顿挫） | warning |
| 非 loop 首末 | 最后两帧几乎相同（<0.01°，结尾僵住） | warning |

stats 输出：四元数模长 min/max/mean、`maxFrameJumpDeg`(骨/帧)、`loopSeamMaxAngleDeg`、
`hipsTravel/hipsMaxStep/hipsLateralDrift/hipsHeightRange/hipsNetDrift` 等，供 CLI 报告与 C lane 判定。

### 2) motion manifest `build-motion-manifest.mjs`

```bash
# 构建并写盘（canonical + 镜像两份同内容）
node scripts/unity-bake/build-motion-manifest.mjs
#   -> assets/motions/mate/manifest.json（canonical）
#   -> assets/motions/manifest.json      （PLAN U3/U10 宽路径镜像）

# 只校验磁盘 manifest 与当前 selection/clips 一致（不写盘）
node scripts/unity-bake/build-motion-manifest.mjs --check
```

- 输入：`clips.json`（selection：fps/motionSet/requirements/`clips[]`）+ `assets/motions/mate/<name>.json`；
- 输出形状：`{schemaVersion:1, set, generatedAt, source:{name/attribution/license/redistribution},
  defaults:{loop,timeScale,fadeInSec,fadeOutSec,rootMotion}, clips:[{id,file,slot,tags,loop,
  timeScale,priority,duration,fps,frames,sourcePath}], coverage:{tag:count}, checks:{ok,errors,warnings}}`；
- `slot` 来自 selection 的 `mood`：合法契约槽位（`PET_MOODS + salute`）原样写入，`mood:''` 的事件类
  片段 = `null`；非空非法 mood = error；
- 校验：id 唯一/合法、clip 文件存在且通过 clip 校验、slot 合法或 null、tag ⊆ requirements 键、
  coverage 达到 requirements 下限（不足 = error）、priority ∈ [-100,100] 整数、timeScale ∈ [0.1,4]；
- 有 error 时**不写盘**并 exit 1；`--check` 不一致 exit 1；非法参数 exit 2。

### 3) 预览 + 自然度度量 + 接触表

```bash
# 指定 clip
node scripts/unity-bake/preview-clips.mjs \
  --clips idle,walk,sitWindow,drag \
  --vrm assets/vrm/aventurine-waveflair.vrm \
  --out tests/tmp/clip-preview \
  --metrics tests/tmp/clip-preview/metrics \
  --sheet

# 全部 clip（读 assets/motions/mate/index.json）+ 度量 + 接触表
node scripts/unity-bake/preview-clips.mjs --all \
  --vrm assets/vrm/aventurine-waveflair.vrm \
  --out tests/tmp/wave15/aventurine \
  --metrics tests/tmp/wave15/metrics --sheet

# 也可以只对已有 PNG 重生成接触表
node scripts/unity-bake/contact-sheets.mjs --dir tests/tmp/clip-preview --out tests/tmp/clip-preview

# 任意其他 VRM（如 Mate-Engine 原角色 Zome / DLC 角色）；--yaw 不填时按
# src/shared/vrm-manifest.json 的 yawOffsetDeg 自动匹配（相机在 +Z 侧取正面）
node scripts/unity-bake/preview-clips.mjs --clips idle,walk \
  --vrm "refs/Mate-Engine/Assets/MATE ENGINE - Avatar/Zome.vrm" \
  --out tests/tmp/zome --frames 0,0.25,0.5,0.75
```

- Electron 启动参数已内置本机 DSH 沙箱要求：`--no-sandbox` + `--user-data-dir=<repo>/tests/tmp/electron-userdata`；
- **朝向修正**（`--yaw <deg>`，默认按 vrm-manifest 自动匹配）：VRM 规范约定模型面向 +Z
  （VRM0 已由 `VRMUtils.rotateVRM0` 归一化），预览相机在 +Z 侧取景，所以 `yawOffsetDeg=180`
  的资产（如戏浪）会先绕 Y 转 180° 再渲染正面；数值只影响展示，不影响 clip 姿势与 metrics；
- `--metrics DIR` 时每 clip 写 `<clip>.metrics.json`：世界空间骨位置（hips/head/feet/toes/knees/hands，
  逐帧）+ 指标：`restGroundY`（rest 足底最低点）、`minFootY`、`maxGroundPenetration`、
  `footYMaxJump`、`hipsTravel`（水平路径长）、`hipsLateralDrift`、`hipsNetDrift`、`hipsHeightRange`、
  `headHeightMin/Max`、`kneeFlexMin/Max`（大腿-小腿夹角，伸直≈0°）、`maxFrameJumpDeg`、
  `loopSeamMaxAngleDeg`；每次 metrics 前后都会把全部 normalized 骨 reset 回 rest；
- `contact-sheets.mjs` 用 sharp 生成每 clip 4 帧横向接触表 `<clip>-sheet.jpg` 与全 clip 首帧总览
  `contact-firstframes.jpg`。

### 4) 单测

```bash
pnpm vitest run tests/unity-bake-*.test.ts
```

- `tests/unity-bake-humanoid-map.test.ts`：22 骨映射 ↔ `src/shared/vrm.ts`、槽位 ↔ `animation-contract.ts` 同步；
- `tests/unity-bake-clip-validation.test.ts`：上表每条规则正反例（nested/flat 形状都覆盖）；
- `tests/unity-bake-motion-manifest.test.ts`：manifest 构建/slot/coverage/--check 一致性；
- `tests/unity-bake-cli.test.ts`：3 个 CLI 的 `--help`/非法参数/临时 fixture 全流程（不读私有 assets）；
- `tests/unity-bake-assets.test.ts`：真实 `assets/motions/mate/**` 集成（`index.json` 不存在或
  导出进行中自动 skip，导出完成后启用 25–35 clip / manifest 一致性断言）。

## 已知问题 / 下一步

- Hips 位移来自 Unity 重定向，含骨架比例带来的常驻偏移；`relative` 已处理大部分，但坐/躺动作的高度需要 app 侧按情景摆放；
- 首批只导了 8 个代表性 clip；U3 已按 `clips.json` 扩到 25–35 个宠物片段（最终清单以 B lane 的 `clips.json` 为准）；
- clip 数据的结构与天然度由 `validate-clips.mjs`（可复跑）+ C lane 的双 VRM 预览度量把关；
- HSR 解包 FBX 明天到：可走 Blender → VRM 重定向，和本管线并行；如果 HSR 动作质量更好，可作为主动作源；
- V-lane 需要：clip player（normalized 骨骼 + Hips 位移）、动作状态机映射（idle/walk/sit/sleep/drag…）、循环/过渡。
