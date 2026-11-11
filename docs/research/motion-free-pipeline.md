# 零成本动作素材 & reze-rig 转换管线（Wave 2.5 / D2 固化报告）

> 任务：task-8（Wave 2.5-D2：零成本动作素材获取 + reze-rig 转换管线固化 + motion-index 清单）。
> 作者：motion-free。日期：2026-11-08。环境：macOS arm64、Node v24.21.0、Blender 4.2.23 LTS（仓库外
> `/Volumes/4TB外置盘/deepseek-harness/tools/blender/`）、有网络、**无预算、不注册账号**。
> 边界：未改 `src/**`、`PLAN.md`、其他 docs、共享契约；未 commit；模型/动作二进制只在
> `assets/model/`（gitignore）与 `tests/tmp/`（gitignore），**不随 app 分发、不进 tracked 路径**。

---

## 0. 一页结论

| 问题 | 结论（本机实测） |
|---|---|
| **reze-rig 管线固化成什么样？** | `scripts/anim-pipeline/reze/`：上游 **MIT**（commit `28a9a9e`）的 `lib/` + `scripts/fbx2vmd.ts` 原样入库，新增最小 `package.json`（`reze-engine@0.68.10` + `pako` + devDep `esbuild@0.25.12`）、`build.sh`、`convert.sh`、`glb2fbx.py`（glTF→FBX 桥）、README（来源/许可/用法）。依赖只装本目录 `node_modules/`（gitignore）。**本机复验 4/4 转换成功，产物与既有 `tests/tmp/motions/converted/` 逐字节一致（sha256 相同）**。 |
| **walk 从哪来、能不能用？** | **能。** 来源 = **three.js r171 官方示例 `Soldier.glb` 的 `Walk` 动画**（Mixamo 角色/动作，示例页注明「model from mixamo.com」）。`Blender 4.2 无头 glb→FBX` → `reze-rig --target-pmx 本模型 --in-place` → `motion-walk.vmd`：**51 条骨轨道 51/51 命中（必需人形骨 17/17）**、帧 0–31（**1.03s 原地循环**）、**首尾帧骨四元数差 0.03° / センター 首尾差 0.000 单位（完美循环、原地）**、侧视接触表走姿自然、**无穿地**（整体浮空 15.4px@540px，交给 app 贴地补偿）。 |
| **idle 从哪来？** | **reze-rig 上游样例 `Idle.fbx`（UE/Unity humanoid Idle）** —— 与既有 `converted/Idle.vmd` 同一来源，本管线**逐字节复现**：54 条骨轨道 54/54 命中、0–90 帧（**3.00s 循环**）、自然站立/呼吸/重心转移、首尾差 0.04°，观感最好，作为 `motion-idle.vmd`。 |
| **还产出了什么？** | `motion-taunt.vmd`（reze 样例 Taunt，Mixamo，54/54，2.83s 一次性反应，预览正常）；备用 `motion-run.vmd`（reze 样例 Run_Lfoot，54/54，0.67s 循环，**manifest 不收（PetMood 无 `run`）**）。另外 three.js Idle/Run 也转出并验证（51/51、循环完美），但 **Soldier 的 "Idle" 是战斗待机**（腿岔开、微蹲），观感不适合作桌宠 idle → 只作测试素材。 |
| **motion-index.json？** | 已按 D1 契约生成 `assets/model/optimized/motion-index.json`（schemaVersion 1）：`idle`（loop, ik on）、`walk`（loop, ik on, `nominalSpeedPxPerSec=470`）、`taunt`（loop false, moods `["pat"]`, crossfade 160）。**用真实解析器 `parseMotionIndex` 校验：0 warnings、3/3 文件存在**。 |
| **walk 的速度匹配有没有坑？** | **有，且需要 D3/Lead 决策（重要）**：本片按默认 50% 尺寸（≈540px 高宠物）换算的自然步速 ≈ **470 px/s**（24.9 px/单位 × 18.8 单位/s）；而 B1/B2 的走路速度是 **62/86/112 px/s**，按 D1 的 `rate = speed / nominal` 会算出 **0.13–0.24**，被 `MIN_PLAYBACK_RATE=0.5` 钳住 → 实际播放 0.5x，仍有约 **2–3.8× 打滑**。要么 D3 下调 `MIN_PLAYBACK_RATE`（≈0.13），要么接受打滑，要么把 B1 走路提速/把宠物渲染尺寸调小。详见 §5。 |
| **还缺什么？** | **sit**（无干净零成本来源；three.js 示例只有 `RobotExpressive.glb`（**CC0**）带 `Sitting`，但骨架命名不在 reze 命名表、机器人比例，需自写改名+重定向；VPD 只能静态）→ **TODO**。反应素材只有 1 个（Taunt）；walk 风格来自军事角色（军步/微前倾），气质偏硬，后续有更好来源可替换。 |

---

## 1. reze-rig 管线固化（`scripts/anim-pipeline/reze/`）

### 1.1 目录与职责

```
scripts/anim-pipeline/reze/
├── LICENSE               上游 MIT 原样（Copyright (c) 2026 Amyang）
├── README.md             来源/许可/用法/参数/已知限制/复验记录
├── package.json          最小依赖：reze-engine@0.68.10, pako@^3.0.3；devDep esbuild@0.25.12
├── package-lock.json     锁定版本（npm ci 可复现）
├── build.sh              npm ci（如需）→ esbuild 打包 CLI → .dist/fbx2vmd.mjs（~1.8MB，gitignore）
├── convert.sh            包装 node .dist/fbx2vmd.mjs "$@"（参数与上游 CLI 完全一致）
├── glb2fbx.py            Blender 4.2 无头 glTF(.glb/.gltf) → 每动画一个 FBX（本次为 three.js 模型新写）
├── lib/                  上游 lib 原样：fbx.ts / retarget.ts / retarget-core.ts / fbx-morph.ts /
│                         fbx-camera.ts / engine-clip.ts / utils.ts / device.ts / uploads.ts
└── scripts/fbx2vmd.ts    上游 node 批处理 CLI 原样
```

- **不上游整仓安装**（Next.js/React 那一套不需要）；依赖只在本目录 `node_modules/`（根 `.gitignore` 的
  `node_modules/` 已覆盖，本目录另有 `.gitignore` 兜底）。
- 只本地个人使用：目录/产物不含模型与动作二进制；转换产物一律写 `tests/tmp/motions/free/` 或
  `assets/model/optimized/`（两者 gitignore）。

### 1.2 来源 / 许可

| 项 | 值 |
|---|---|
| 上游 | https://github.com/AmyangXYZ/reze-rig （MIT，`LICENSE` Copyright (c) 2026 Amyang） |
| commit | `28a9a9e31e33efcd0f5061ab3ffdc20e93541eba`（2026-10-22，「Stage the page in reze-design's demo scene」） |
| 上游版本 | `package.json` `0.3.2` |
| 本目录改动 | **源码零修改**（`lib/`、`scripts/fbx2vmd.ts` 与上游同 hash）；只新增构建/包装/桥接脚本与文档 |

### 1.3 用法

```bash
# 1) 首次构建（装依赖 + esbuild 打包；已存在 node_modules 时只打包）
./scripts/anim-pipeline/reze/build.sh

# 2) FBX → VMD（仓库根目录；参数透传上游 CLI）
./scripts/anim-pipeline/reze/convert.sh \
  "tests/tmp/motions/free/fbx/Walk.fbx" \
  --target-pmx "assets/model/optimized/星穹铁道—砂金·戏浪.pmx" \
  --in-place \
  --out "tests/tmp/motions/free/vmd"
```

关键参数：`--target-pmx`（**必带**，实测目标 PMX 骨骼世界坐标/比例/morph）、`--in-place`（清水平
root motion、保留竖直）、`--no-foot-ik`（默认开脚 IK，走路/坐下必须默认开）、`--bind-ref`（Unity/UE
逐姿态导出时用 idle 锚 bind；Mixamo 形状的 clip 会忽略）。上游 CLI 默认会在输入里找 `Idle.fbx` 当
bind reference（找不到才用 `public/fbx/Idle.fbx`，本仓库不带该二进制）——所以 **输入里有 `Idle.fbx`
即可，或显式 `--bind-ref` / `--no-bind-ref`**。

### 1.4 本机复验（与既有产物逐字节一致）

用上游自带样例 FBX（`/tmp/reze-rig/public/fbx/`，已复制到 `tests/tmp/motions/free/fbx-samples/` 便于
本机复跑）重新转换：

```bash
./scripts/anim-pipeline/reze/convert.sh \
  tests/tmp/motions/free/fbx-samples/{Idle,Taunt,Run_Lfoot,Arms Down}.fbx \
  --target-pmx "assets/model/optimized/星穹铁道—砂金·戏浪.pmx" \
  --in-place --out tests/tmp/motions/free/reverify
```

结果：

| 文件 | 大小 | sha256（前 16） | 与 `tests/tmp/motions/converted/` 比对 |
|---|---:|---|---|
| `Idle.vmd` | 545,621 B | `f6685cbfa4484023` | **IDENTICAL** |
| `Taunt.vmd` | 515,651 B | `6829d53b8c21b286` | **IDENTICAL** |
| `Run_Lfoot.vmd` | 126,041 B | `9c46f7b7b58676fc` | **IDENTICAL** |
| `Arms Down.vmd` | 12,155 B | `eaade16ff8f4e0c7` | **IDENTICAL** |

解析（`tests/tmp/motions/analyze-motions.mjs`，mmd-parser 1.1.4）：4/4 均 **54 骨轨道、54/54 命中本
模型骨名（0 missing）**、含 `左足ＩＫ/右足ＩＫ`、`--in-place` 后 `センター` 首尾差 0。

> 结论：`convert.sh` 在本机可复跑，且与 Lead 既有产物完全一致（同一输入 + 同一 target → 同一字节）。

---

## 2. 零成本来源获取（按任务书优先级）

### 2.1 a) three.js r171 官方示例模型（**walk 采用**）

- **下载**（2026-11-08 实测 200）：
  `https://raw.githubusercontent.com/mrdoob/three.js/r171/examples/models/gltf/Soldier.glb`（2,160,468 B）
- **内容**：glTF 2.0，两条 skin（`vanguard_Mesh` 49 关节、`vanguard_visor` 2 关节），骨架为 **Mixamo
  命名**（`mixamorig:Hips` …），场景 `extras.frames_per_second = 30`；动画 4 条：

  | 动画 | 时长@30fps | 帧数 | 用途 |
  |---|---:|---:|---|
  | `Idle` | 1.97 s | 0–59 | 战斗待机（腿岔开/微蹲）→ **只作测试** |
  | `Walk` | **1.03 s** | 0–31 | **采用**（原地走循环） |
  | `Run` | 0.70 s | 0–21 | 备用（转出验证，manifest 不收） |
  | `TPose` | 0.03 s | 0–1 | 未用 |

- **授权核对**（due diligence）：
  - three.js 仓库**没有**给 `examples/models/gltf/Soldier.glb` 单独的 LICENSE/README（本机 partial
    clone `git ls-tree` + `git show` 核对：`examples/models/fbx/README.md` 只写 `nurbs.fbx`，gltf 目录
    仅个别子目录带 license，Soldier 目录没有）；
  - 但 three.js 示例页 `examples/webgl_animation_skinning_blending.html` 页头**明确写**
    `(model from <a href="https://www.mixamo.com/">mixamo.com</a>)` → 该模型与动画均为 **Mixamo** 素材；
  - 按 Mixamo/Adobe 条款：**可免费用於个人/商业项目，禁止再分发原始动画文件**。本项目只本地自用、
    产物进 gitignore、不随 app 打包 → **合规**；若未来要分发 VMD 必须重做来源（见 §7）。
- **转换步骤**：glTF → FBX 用已装 Blender 4.2 无头（`scripts/anim-pipeline/reze/glb2fbx.py`）：

  ```bash
  BLENDER='/Volumes/4TB外置盘/deepseek-harness/tools/blender/Blender.app/Contents/MacOS/Blender'
  "$BLENDER" --background --python scripts/anim-pipeline/reze/glb2fbx.py -- \
    --glb tests/tmp/motions/free/glb/Soldier.glb \
    --out tests/tmp/motions/free/fbx \
    --actions Idle,Walk,Run
  # → tests/tmp/motions/free/fbx/{Idle,Walk,Run}.fbx（每个动画一个 FBX，输出名=动画名）
  ```

  然后 reze 转换：

  ```bash
  ./scripts/anim-pipeline/reze/convert.sh \
    tests/tmp/motions/free/fbx/{Idle,Walk,Run}.fbx \
    --target-pmx "assets/model/optimized/星穹铁道—砂金·戏浪.pmx" \
    --in-place --out tests/tmp/motions/free/vmd
  # 日志：target skeleton: measured from ...；
  #       bind reference: tests/tmp/motions/free/fbx/Idle.fbx；
  #       [retarget] "Scene": Mixamo, scale=0.1256, 48 mapped (44 aligned), world frame corrected 180°, unmapped tracks: Character
  #       Idle.vmd (332 KB) / Run.vmd (122 KB) / Walk.vmd (177 KB)，3/3 converted
  ```

- **glb→FBX 的关键坑（本次踩到并解决，值得记录）**：
  1. Blender glTF importer 会把每条 animation 拆成多条 action（`Walk_Character` 带全部 490 条
     pose.bones fcurve；`Walk_mixamorig:LeftHandPinky3` 等是末端 EMPTY 的独立 action）→ 每个动画取
     fcurve 最多的那条（`glb2fbx.py` 已按此挑选）。导入前必须把 `scene.render.fps=30`，否则 glTF
     秒→帧按 Blender 默认 24fps 转换，会重采样成 24fps 网格。
  2. **导出 FBX 时必须把「骨架 + 蒙皮网格」一起导出**。只选 armature 导出时，Blender 写出的 FBX
     丢 skin bind/Deformer 数据，reze 读到的 rest pose 是错的：实测日志
     `WORLD FRAME OFF BY 136° — no axis rotation explains it`、`41 aligned`（正常应 44），产物
     表现为**腿常开、手臂外张、idle 也在踏步**。带上两个 skin mesh 后 rest/bind 与 glTF 一致，
     日志变为 `world frame corrected 180°, 44 aligned`，walk/idle 观感恢复正常。
  3. `--in-place` 对 Mixamo 原地动画生效：`センター` 首尾差 0，水平仅在 ±0.7 单位内摆动（app 归零）。

### 2.2 b) GitHub 公开 Mixamo 走路 FBX —— **需账号，未尝试**

任务允许「GitHub 上公开的 Mixamo FBX」。但 Mixamo 官方下载必须 Adobe 账号，且
[Adobe FAQ](https://helpx.adobe.com/creative-cloud/faq/mixamo-faq.html) 明确中国区账号不可用；
GitHub 上的第三方 Mixamo FBX 多为无授权声明转载（默认保留所有权利），不如 three.js 官方示例的
来源清晰。**结论：a 已满足 walk，b 不启动；如需更贴气质的 walk（如 Mixamo「Walking」/「Slow Walk」），
需用户提供 Adobe 账号或指定可用直链 → 列入「需用户操作」。**

### 2.3 c) CMU mocap BVH —— **未启动（a 已满足，时间盒让位）**

CMU（`mocap.cs.cmu.edu`，2605 段，免费可商用不可转售）到 VMD 需 BVH→FBX（本机 Blender 可导 BVH）
+ 骨名映射（CMU 无 Mixamo/UE 命名，reze 命名表不认）。**结论：walk 已由 a 解决，c 只留作后续
「更多步态风格」的备选；本次不投入。**

### 2.4 d) sit —— **TODO（无干净零成本来源）**

- three.js 官方示例里**没有** Mixamo 骨架的 sit 动画；有一个 **CC0** 的候选：
  `examples/models/gltf/RobotExpressive/RobotExpressive.glb`（作者 Tomás Laulhé / Quaternius，**CC0 1.0**，
  有 `Sitting`/`Standing`/`Idle`/`Walking` 等 14 条动画）。**本次已做一次时间盒实验**：
  用 Blender 把机器人骨名改写成 Mixamo 命名（`Hips/Abdomen→Spine/Torso→Spine2/UpperLeg.L→LeftUpLeg/…`，
  31 根骨改名）→ 带蒙皮网格导出 `Sitting.fbx`/`Idle.fbx` → `convert.sh --no-foot-ik --in-place`：
  **20 条骨轨道 20/20 命中本模型、必需骨 17/17**，`Sitting.vmd` 0–12 帧（**0.43s 的「站→坐」过渡**，
  不是坐姿循环；首尾差 66.6°）。预览（`--ik off`）显示姿势能读作「坐在（看不见的）高台/椅上、双腿前伸」，
  但 `センター` 无下沉（重心仍站立高度）、脚骨浮空 ≈121.6px、无趾骨/足 IK、并非循环，
  **质量不足以上线**，故**不入选运行期清单**（证据：`tests/tmp/motions/free/vmd-sit/`、
  `tests/tmp/preview/try-sit/`）。结论：sit 留 **TODO**，优先等 Mixamo `Sitting Idle`（需用户账号）
  或 D4 用 Blender 摆「窗沿坐」bone-only VPD / 自摆 VMD。
- 兜底静态姿势：`tests/tmp/motions/threejs_r171/vpds/{09,10}.vpd`（初音ミク跪/坐姿，60/93 骨命中，
  **只能做静态 pose**，无法循环）→ 按任务书「坐姿若用 VPD 先不做，留 TODO」。
- 付费/账号来源（BOOTH 第 22 弾跪姿 ¥2,000、BowlRoll 登录/下载键、名もなき需 BOOTH 登录）**按边界不尝试**。

### 2.5 e) idle / 反应 —— 已有素材直接复用

- idle：`tests/tmp/motions/converted/Idle.vmd`（reze 样例 `Idle.fbx`，UE/Unity humanoid Idle，
  3.00s 循环，54/54）——本管线**逐字节复现**后作为 `motion-idle.vmd`。
- 反应：`Taunt.vmd`（Mixamo Taunt，2.83s，54/54）→ `motion-taunt.vmd`（manifest `moods=["pat"]`）。
  `Arms Down.vmd`（单帧自然垂臂）保留作「静态基线/过渡帧」测试素材，未进 manifest。

---

## 3. 转换与验收结果（每个 VMD 都过了预览器）

预览器命令（仓库根目录，默认隐藏窗口；帧号=30fps）：

```bash
./scripts/anim-pipeline/preview/run.sh --motion "assets/model/optimized/motion-walk.vmd" \
  --frames 0,4,8,12,16,20,24,28 --angles front,side,45 --out tests/tmp/preview/final-walk
```

| clip | 来源 | 骨轨道（命中/总） | 必需人形骨 | 帧范围/时长 | 循环（首尾骨四元数差 / センター 首尾差） | 脚底（相对 bind） | 预览断言 |
|---|---|---:|---:|---|---|---|---|
| **`motion-walk.vmd`** | three.js `Soldier.glb` → Walk（Mixamo） | **51/51（100%）** | **17/17** | 0–31 / **1.03s** | **0.03° / 0.000**（完美原地循环） | **浮空** max 0.618 单位 ≈ **15.4px@540px**（无穿地） | `PREVIEW_OK` |
| **`motion-idle.vmd`** | reze 样例 Idle.fbx（UE/Unity） | **54/54（100%）** | **17/17** | 0–90 / **3.00s** | **0.04° / 0.000** | **浮空** max 0.808 单位 ≈ **20.1px**（无穿地） | `PREVIEW_OK` |
| **`motion-taunt.vmd`** | reze 样例 Taunt.fbx（Mixamo） | **54/54（100%）** | **17/17** | 0–85 / **2.83s** | 0.04° / 0.000（一次性播放，不循环） | **浮空** max 0.520 单位 ≈ **13.0px** | `PREVIEW_OK` |
| `motion-run.vmd`（备用，不入 manifest） | reze 样例 Run_Lfoot.fbx | 54/54 | 17/17 | 0–20 / 0.67s | 0.03° / 0.000 | 浮空 max 1.38 单位 ≈ 34.4px（跑步腾空正常） | 既有证据 `tests/tmp/preview/Run_Lfoot/` |
| `Idle`（Soldier，测试） | three.js `Soldier.glb` → Idle（Mixamo） | 51/51 | 17/17 | 0–59 / 1.97s | 0.04° / 0.000 | 贴地良好（漂移 max 0.275 单位） | 战斗待机，不适合当桌宠 idle |
| `Run`（Soldier，测试） | three.js `Soldier.glb` → Run（Mixamo） | 51/51 | 17/17 | 0–21 / 0.70s | 0.04° / 0.000 | —（未单独出接触表） | 备用 |

- **センター 位移**（`--in-place` 后，单位=模型单位；1 单位≈24.9px@540px）：
  walk `X -0.115..0.690 / Y -0.916..0.165 / Z -0.060..0.670`（净步态摆动，首尾 0，app 归零即可）；
  idle `X -0.332..0 / Y 0.605..0.692 / Z 0`；taunt `X -0.805..-0.073 / Y -1.446..-0.935 / Z -0.586..0.355`。
- **观感（read_image 人眼复核）**：
  - walk：侧视连续帧可见「支撑脚钉地 → 摆动腿抬起 → 脚掌滚动」，手臂反相摆动、躯干微前倾；
    军事角色步态（挺、幅度偏大），无滑步感（按自然步速看）、无穿模、无膝反关节；
  - idle：自然站立、重心左右微移、手臂放松垂放（比 B3 程序化姿态自然），脚贴地；
  - taunt：挑衅/跺脚手势，幅度大、无撕裂。
- **截图/证据**：`tests/tmp/preview/final-{idle,walk,taunt}/contact-sheet.png`、`frames/*.png`、
  `compatibility.md`、`metadata.json`；three.js 源素材对比渲染：`/tmp/glb-render/SHEET-*`（临时）。

---

## 4. 运行期清单 `assets/model/optimized/motion-index.json`

已按 D1 契约（`src/renderer/src/animation/external/manifest.ts`）生成，并用**真实解析器**验证：

```json
{
  "schemaVersion": 1,
  "clips": [
    { "id": "idle",  "file": "motion-idle.vmd",  "moods": ["idle"], "loop": true,  "ik": "on", "nominalSpeedPxPerSec": null, "crossfadeMs": 200, "source": "reze-rig 样例 Idle.fbx（UE/Unity humanoid Idle，3.00s 循环）→ reze-rig FBX→VMD（--target-pmx 本模型 --in-place）；reze-rig 样例资产仅本地研究用、禁再分发；本地个人自用" },
    { "id": "walk",  "file": "motion-walk.vmd",  "moods": ["walk"], "loop": true,  "ik": "on", "nominalSpeedPxPerSec": 470,  "crossfadeMs": 200, "source": "three.js r171 examples/models/gltf/Soldier.glb 的 Walk（Mixamo 角色动画，three.js 示例注明 model from mixamo.com；1.03s 原地循环）→ Blender 4.2 glb→FBX → reze-rig --target-pmx 本模型 --in-place；Mixamo/Adobe 条款：可免费用於项目、禁再分发原始动画；本地个人自用" },
    { "id": "taunt", "file": "motion-taunt.vmd", "moods": ["pat"],  "loop": false, "ik": "on", "nominalSpeedPxPerSec": null, "crossfadeMs": 160, "source": "reze-rig 样例 Taunt.fbx（Mixamo Taunt，2.83s 一次性反应）→ reze-rig --in-place；禁再分发；本地个人自用" }
  ]
}
```

- **校验**（esbuild 打包 `manifest.ts` 后用 `parseMotionIndex` 跑真实文件）：
  `clips=3，warnings=[]`，三个 `.vmd` 文件均存在。
- `moods` 只用了合法 PetMood：`idle` / `walk` / `pat`（`taunt` 不是 PetMood；按 `docs/anim-strategy.md`
  §3.1「pat/drag → 对应 VMD」映射到摸头反应；`dshDone` 等未占用，避免抢 B3 的语义）。
- **`nominalSpeedPxPerSec=470` 的推导**（walk 静止步态对应的宠物移动速度）：
  - 本模型高 21.681 单位；默认 `sizePercent=50` → 宠物渲染高 ≈540px → **24.9 px/单位**；
  - walk 单步幅：VMD `左足ＩＫ` z 轨迹 -4.75..+6.00（左右反相），双足最大前后分离 ≈ **9.7 单位**；
  - 循环 1.033s（2 步）→ 自然步速 = 2×9.7/1.033 ≈ **18.8 单位/s** → **≈470 px/s**。
  - 该值随渲染尺寸线性缩放：若宠物按 25% 尺寸（≈270px）渲染，nominal 应≈235；
  - **注意（D3 必读）**：B1/B2 走路速度 62/86/112 px/s 代入 `rate=speed/nominal` 得 0.13–0.24，
    会被 D1 的 `MIN_PLAYBACK_RATE=0.5` 钳到 0.5 → 仍约有 2–3.8× 打滑。这是「宠物渲染很大但移动很慢」
    的尺度矛盾，不是 clip 的问题：
    - 方案 A（推荐）：D3 把 `MIN_PLAYBACK_RATE` 降到 ≈0.13（仅对 external walk 生效），按比例慢放；
    - 方案 B：接受 0.5 下限 + 视觉打滑，后续用「步频/步幅重采样」的 VMD 或 B3 混合；
    - 方案 C：把 B1 走路速度提上去或把默认宠物尺寸调小（产品决策，需用户确认）。
- `run` 未入 manifest：PetMood 无 `run`（走路用 `walk` + 播放速率），文件保留在
  `assets/model/optimized/motion-run.vmd` 作后续备用（pet 不会自动加载它）。

---

## 4.5 D3 后续（Lead 已实现，2026-11-08）

本报告的 open item「walk 470px/s 与 B1 62–112px/s 尺度矛盾」已由 Lead 在 Wave 2.5 D3 解决：
- `core/pet-runtime.ts`：把 B1 的 `moveTo(walk)` 速度替换为**体高相对自然步速**
  `petHeightPx × (470/540) × 档位系数(low 0.8 / normal 1.0 / high 1.2)`；
- `animation/external/selection.ts`：新增 `WALK_SPEED_REF_HEIGHT_PX=540` 与
  `effectiveNominalSpeedPxPerSec()`，VMD 层按当前宠物高度换算 manifest nominal；
- 结果：任意 sizePercent 下 `播放速率 = 档位系数`（不滑步）。实机 dev 截图实测：
  walk 时 `velocity=470px/s @540px`、`externalPlaybackRate=1.0`、`clipId=walk`、脚底误差 0。
- 对应单测：`tests/pet-runtime-walk-speed.test.ts`（108/324/540/861px 全覆盖）。

## 5. 预览器结论（每个 clip 的自动断言）

| clip | 模型加载 | 贴图 | 渲染非空白 | 骨架运动量 | 脚底 | 断言总数 |
|---|---|---|---|---|---|---|
| `final-idle` | 382=382 | 20/20 | ✓ | max 0.669 单位 / 10.5° | 浮空 20.1px（站立类→ app 贴地补偿） | **7/7 ✅** |
| `final-walk` | 382=382 | 20/20 | ✓ | max 6.318 单位 / 86.1° | 浮空 15.4px（无穿地） | **7/7 ✅** |
| `final-taunt` | 382=382 | 20/20 | ✓ | max 5.612 单位 / 129.6° | 浮空 13.0px | **7/7 ✅**（含「センター 有可见位移」提示） |

> 三个 clip 的 `PREVIEW_OK` 均 **7/7 自动断言通过**（`physics:false` 下衣发静态属预期）。
> idle/walk 满足任务验收：「必需人形骨全覆盖（17/17）+ 原地（センター 首尾 0）+ 无明显穿地」；
> 整体浮空由 D1 的 grounding 层按脚骨最低点补偿（`src/renderer/src/animation/external/grounding.ts`）。

---

## 6. 授权与合规

| 资产 | 来源 | 本地个人自用 | 改変/转 VMD | 再分发/随 app 分发 |
|---|---|---|---|---|
| reze-rig 代码 | GitHub AmyangXYZ/reze-rig，**MIT** | ✅ | ✅ | ✅（保留版权声明；本目录即副本） |
| reze-rig 样例 FBX（Idle/Taunt/Run_Lfoot/Arms Down） | 上游仓库自带样例；仓库 MIT 仅覆盖代码，资产无单独声明（Taunt 实测识别为 Mixamo 命名） | ✅ | ✅ | ❌（按 Mixamo/样本资产保守处理） |
| three.js r171 `Soldier.glb` 及其动画 | three.js 官方示例；示例页注明 model from mixamo.com（Mixamo 素材） | ✅ | ✅ | ❌（Mixamo/Adobe 禁再分发原始动画；派生 VMD 同样不随 app 分发） |
| 转换产物 `motion-*.vmd` | 上述派生数据 | ✅ | — | ❌（只在 gitignored `assets/model/optimized/`，不提交、不打包发布） |
| `motion-index.json` | 本任务生成（纯元数据） | ✅ | — | 跟随产物策略（本地） |

> 底线与 `docs/anim-strategy.md` §6 一致：**所有外部动作只本机开发/自用，不 commit、不随 app 分发**；
> 若产品未来要公开发布带动作的版本，必须把动作替换为用户自有/MiPo 录制/明确可商用授权的素材。

---

## 7. 还缺什么 / 需要用户或 Lead 操作的事项

1. **sit（坐姿/窗沿坐）缺失** —— 可选项：
   - 用户提供 Mixamo 账号（非中国区）导出 `Sitting`/`Sitting Idle` FBX → 本管线 1 条命令转 VMD；
   - ~~three.js CC0 `RobotExpressive.glb` 的 `Sitting`~~：**已试，质量不足**（0.43s 站→坐过渡、无重心下沉/脚悬空、无趾骨，见 §2.4），不建议上线；
   - 或付费 BOOTH 第 22 弾（¥2,000，含跪姿）/名もなき（BOOTH 登录）——需用户操作。
2. **walk 速度匹配决策**（D3/Lead）：见 §4 方案 A/B/C；当前 manifest 给的是**物理真值 470 px/s**。
3. **walk 风格**：来自军事角色（军步/微前倾），砂金气质更「从容/戏谑」；有 Mixamo 账号后可用
   `Walking`/`Slow Walk`/`Strut` 替换（同管线、分钟级）。
4. **反应/摸头**：目前只有 Taunt（映射到 `pat`）；「被摸头享受/被戳惊讶」等仍由 B3 兜底。
5. **表情 morph**：reze 产出的 VMD **无 morph 轨道**（源 FBX 无 blendshape；three.js Soldier.glb 的
   表情也不在 reze 映射内）→ 表情继续由 app 表情调度器负责（与 D1 设计一致）。
6. **物理**：预览器与 app 均 `physics:false`，衣摆/辫子静态（既有决策，不是素材问题）。

---

## 8. 完整复现命令（本机）

```bash
cd /Volumes/4TB外置盘/deepseek-harness/aventurine-pet
PMX="assets/model/optimized/星穹铁道—砂金·戏浪.pmx"
BLENDER='/Volumes/4TB外置盘/deepseek-harness/tools/blender/Blender.app/Contents/MacOS/Blender'

# 0) 构建转换器（首次）
./scripts/anim-pipeline/reze/build.sh

# 1) 下载 three.js 官方示例模型（Mixamo 角色/动画）
mkdir -p tests/tmp/motions/free/glb
curl -L -o tests/tmp/motions/free/glb/Soldier.glb \
  "https://raw.githubusercontent.com/mrdoob/three.js/r171/examples/models/gltf/Soldier.glb"

# 2) glTF → 每动画一个 FBX（Blender 无头；必须带蒙皮网格，脚本已处理）
"$BLENDER" --background --python scripts/anim-pipeline/reze/glb2fbx.py -- \
  --glb tests/tmp/motions/free/glb/Soldier.glb \
  --out tests/tmp/motions/free/fbx --actions Idle,Walk,Run

# 3) FBX → VMD（以本模型为 target、原地化、默认脚 IK）
./scripts/anim-pipeline/reze/convert.sh \
  tests/tmp/motions/free/fbx/{Idle,Walk,Run}.fbx \
  --target-pmx "$PMX" --in-place --out tests/tmp/motions/free/vmd

# 4) 预览器验证（默认隐藏窗口，勿加 --show）
./scripts/anim-pipeline/preview/run.sh \
  --motion tests/tmp/motions/free/vmd/Walk.vmd \
  --frames 0,4,8,12,16,20,24,28 --angles front,side,45 \
  --out tests/tmp/preview/free-walk

# 5) 放入运行期目录 + 生成清单（本项目本地，gitignore）
cp tests/tmp/motions/free/reverify/Idle.vmd      assets/model/optimized/motion-idle.vmd
cp tests/tmp/motions/free/vmd/Walk.vmd           assets/model/optimized/motion-walk.vmd
cp tests/tmp/motions/free/reverify/Taunt.vmd     assets/model/optimized/motion-taunt.vmd
cp tests/tmp/motions/free/reverify/Run_Lfoot.vmd assets/model/optimized/motion-run.vmd
# motion-index.json 见 §4（已落盘）

# 6) 循环/原地自检（可选工具，tests/tmp）
cd tests/tmp/motions && node check-loop.mjs free/vmd/Walk.vmd converted/Idle.vmd
```

## 9. 证据索引

| 内容 | 路径（全部 gitignored） |
|---|---|
| 转换器（入库） | `scripts/anim-pipeline/reze/**`、本文件 |
| 最终 VMD + 清单 | `assets/model/optimized/motion-{idle,walk,taunt,run}.vmd`、`motion-index.json` |
| 下载/转换中间物 | `tests/tmp/motions/free/{glb,fbx,fbx-samples,vmd,reverify}/` |
| 预览器证据（最终 clip） | `tests/tmp/preview/final-{idle,walk,taunt}/{contact-sheet.png,frames/,compatibility.md,metadata.json}` |
| 预览器证据（源素材测试） | `tests/tmp/preview/free-walk/`、`free-idle/`、`Idle/`、`Taunt/`、`Run_Lfoot/` |
| 解析/骨命中 | `tests/tmp/motions/analysis.json`（`node analyze-motions.mjs` 全量重扫） |
| 循环自检 | `tests/tmp/motions/check-loop.mjs`（首尾帧差异，见 §3） |
| three.js 源素材渲染对照 | `/tmp/glb-render/SHEET-{Idle,Walk,Run}-{front,side}.png`（临时，可重跑） |

---

## 10. 坐姿/反应补充（Wave 2.5 · D4a）

> 追加日期：2026-11-08（task-9）。目标：零成本补 **sit（窗沿坐）** + 1–2 个反应 clip，替换回退中的 B3 程序化坐姿。
> 时间盒 40 min；`tests/tmp/` 下的下载/中间物全部 gitignore，最终 VMD 只进 `assets/model/optimized/`（gitignore，不 commit）。

### 10.1 来源（GitHub 公开 Mixamo FBX 库）

- 仓库：[`nirholas/three.ws`](https://github.com/nirholas/three.ws)（代码 **Apache-2.0**），其中
  [`animation-sources/`](https://github.com/nirholas/three.ws/tree/main/animation-sources) 有 **62 个 Mixamo
  导出 FBX**（30fps，In Place、Without Skin）；本机取用 commit
  `3f9617a859bfc4be43e7ac8ce8dbe2aecb6192d8`（2026-11-07）。
- **授权口径**：仓库 [`public/animations/LICENSES.md`](https://github.com/nirholas/three.ws/blob/main/public/animations/LICENSES.md)
  明确写明这些 clip 是「在已登录的 Adobe Creative Cloud 账号下从 mixamo.com 导出」，并援引 Mixamo 条款
  （§2：可免费用於个人/商业/非营利项目）；**禁止再分发原始动画文件**。本项目只本地自用、产物 gitignore、
  不随 app 分发 → 合规。仓库 Apache-2.0 只覆盖代码，不改变素材本身的 Mixamo 条款。
- 已下载（`tests/tmp/motions/free/sit/fbx/`，可复跑）：

  | 文件 | 大小 | sha256（前 16） | Mixamo 动画名 | 用途 |
  |---|---:|---|---|---|
  | `Sitting Clap.fbx` | 762,064 B | `fe97f4286aac0ba8` | Sitting Clap | **sit 主选** |
  | `Sitting Laughing.fbx` | 977,840 B | `b684e09c753e91a7` | Sitting Laughing | sit 备选（未入清单） |
  | `Salute.fbx` | 754,640 B | `1aadbf3ae2d4dc4e` | Salute | 反应（dshDone） |
  | `Reaction.fbx` | 410,016 B | `463db9590f96b3fb` | Surprised | 反应（dshError） |
  | `Idle.fbx` | 1,576,448 B | `bd156dbc0ae3b38f` | Idle | 仅作 `--bind-ref` 锚点 |

  直链形态：`https://raw.githubusercontent.com/nirholas/three.ws/main/animation-sources/<URL 编码文件名>`
  （如 `Sitting%20Clap.fbx`）。仍走 0 账号/0 付费；下载/转换全程本机。

### 10.2 转换命令（固定 bind-ref；本任务**不改** reze 目录）

```bash
cd /Volumes/4TB外置盘/deepseek-harness/aventurine-pet
cd tests/tmp/motions/free/sit/fbx
for n in "Sitting Clap" "Sitting Laughing" "Salute" "Reaction"; do
  curl -sL -o "$n.fbx" \
    "https://raw.githubusercontent.com/nirholas/three.ws/main/animation-sources/$(python3 -c "import urllib.parse,sys;print(urllib.parse.quote(sys.argv[1]+'.fbx'))" "$n")"
done
cd /Volumes/4TB外置盘/deepseek-harness/aventurine-pet

./scripts/anim-pipeline/reze/convert.sh \
  "tests/tmp/motions/free/sit/fbx/Sitting Clap.fbx" \
  "tests/tmp/motions/free/sit/fbx/Sitting Laughing.fbx" \
  "tests/tmp/motions/free/sit/fbx/Salute.fbx" \
  "tests/tmp/motions/free/sit/fbx/Reaction.fbx" \
  --bind-ref "tests/tmp/motions/free/sit/fbx/Idle.fbx" \
  --target-pmx "assets/model/optimized/星穹铁道—砂金·戏浪.pmx" \
  --in-place --out tests/tmp/motions/free/sit/vmd
# 日志：[retarget] "mixamo.com": Mixamo, scale=0.1278, 51 mapped (47 aligned), unmapped tracks: none
#       Sitting Clap.vmd (1001 KB) / Sitting Laughing.vmd (1469 KB) / Salute.vmd (504 KB) / Reaction.vmd (328 KB)，4/4 converted
```

> ⚠️ 必须带 `--bind-ref`：`convert.sh`/上游 CLI 默认会在输入里找 `Idle.fbx`，找不到时回退
> `scripts/anim-pipeline/reze/public/fbx/Idle.fbx`（本仓库不带该二进制）→ 直接 ENOENT。本次输入里没有
> `Idle.fbx`，所以显式传 `--bind-ref tests/.../three.ws Idle.fbx`（Mixamo 形状的 clip 实际会忽略 bind
> ref，但 CLI 需要能读到文件）。

### 10.3 转换结果与预览器验证（每个 clip 都出接触表）

| clip（最终文件） | 来源 | 骨轨道（命中/总） | 必需骨 | 帧范围/时长 | 循环（首尾骨差 / センター首尾差） | 脚底（相对 bind） | 预览断言 |
|---|---|---:|---:|---|---|---|---|
| **`motion-sit.vmd`** | Mixamo `Sitting Clap` | **54/54（100%）** | **17/17** | 0–170 / **5.67s** | **0.06° / 0.000**（完美循环） | 浮空 max 0.511 单位≈**12.7px**，陷地 0 | **7/7 ✅ PREVIEW_OK** |
| `motion-sit-laugh.vmd`（备选，未入清单） | Mixamo `Sitting Laughing` | 54/54 | 17/17 | 0–250 / 8.33s | 0.04° / 0.000 | 浮空 max 0.521 单位≈13.0px，陷地 0 | `PREVIEW_OK`（7/7） |
| **`motion-salute.vmd`** | Mixamo `Salute` | 54/54 | 17/17 | 0–85 / 2.83s | 0.04° / 0.000（起止回到站姿） | 浮空 max 0.356 单位≈8.9px，陷地 0 | **7/7 ✅ PREVIEW_OK** |
| **`motion-reaction.vmd`** | Mixamo `Surprised` | 54/54 | 17/17 | 0–55 / 1.83s | 0.80° / 0.015（一次性，不循环） | 浮空 max 0.301 单位≈7.5px，陷地 0 | **7/7 ✅ PREVIEW_OK** |

- **sit 观感（read_image 复核）**：角色**坐在（不可见的）高台/椅面上，双腿自然下垂**（膝约 90°），
  手臂放腿上/偶尔抬手拍手；侧视/45° 无穿模、无膝反关节，是很合适的「窗沿坐」底子。
  - `センター` 位移：X −0.032..0.056 / **Y −4.752..−4.699** / Z 0.410..0.502（模型单位；1 单位≈24.9px@540px）。
    **Y≈−4.7 单位 = 坐面比站立低约 4.7 单位（≈0.38m，接近椅子座高）**，且首尾差 0 → 真正「坐定」而不是站→坐过渡。
  - 脚底相对 bind 高 0.51 单位（≈12.7px）——坐姿下脚本来就不该贴地，**不要把它当穿地**。
- **反应观感**：`Salute` 站立→抬手敬礼→向外伸手（回应/致意，适合 `dshDone`）；`Reaction` 惊吓后仰、
  双臂抬起（适合 `dshError`）；两者都是 2–3s 内的一次性动作，起止接近站姿，淡入淡出友好。
- 证据：`tests/tmp/preview/final-sit/`、`final-salute/`、`final-reaction/`
  （`contact-sheet.png` / `frames/` / `compatibility.md` / `metadata.json`）；备选 `try-sit-laugh/`。

### 10.4 `motion-index.json` 变更（3 → 6 clips，已有 3 条原样不动）

追加：

```json
{ "id": "sit",      "file": "motion-sit.vmd",      "moods": ["sit"],      "loop": true,  "ik": "on", "nominalSpeedPxPerSec": null, "crossfadeMs": 200, "source": "…nirholas/three.ws animation-sources/Sitting Clap.fbx（Mixamo 导出，5.67s 坐姿循环）…" },
{ "id": "salute",   "file": "motion-salute.vmd",   "moods": ["dshDone"],  "loop": false, "ik": "on", "nominalSpeedPxPerSec": null, "crossfadeMs": 160, "source": "…Salute.fbx（Mixamo「Salute」，2.83s）…" },
{ "id": "reaction", "file": "motion-reaction.vmd", "moods": ["dshError"], "loop": false, "ik": "on", "nominalSpeedPxPerSec": null, "crossfadeMs": 160, "source": "…Reaction.fbx（Mixamo「Surprised」，1.83s）…" }
```

- 校验：用 D1 的 `parseMotionIndex`（esbuild 打包 `manifest.ts` 后跑真实文件）→ **6 clips、warnings=[]**，
  6 个 `.vmd` 全部存在。
- `motion-sit-laugh.vmd` 只作为**备选**放在同目录、**不写进清单**（代码/Lead 想换风格时改一行 `file` 即可）。
- `taunt` 保持 `pat` 不动；`idle`/`walk`/`run` 不变。

### 10.5 ⚠️ 集成注意（D4 代码侧，供 Lead 转达）

1. **sit 的 grounding 语义不同**：D1 的 `external/grounding` 会按「最低脚骨 → bind pose 脚底」把 `mesh.position.y`
   拉回地面；坐姿 clip 的脚是**悬垂**的（相对 bind +0.51 单位），若照常贴地会整体下移 ~12.7px（影响不大），
   但真正的问题是 **`センター` Y≈−4.7 的坐面高度**：app 在 `sit` 态应把宠物锚在窗沿/坐面上，
   **跳过（或改锚点后跳过）脚底 grounding**，否则「把脚拉回地面」的语义与「腿悬在窗外」冲突。
2. **腿悬垂方向**：本 clip 是「坐面朝前、双腿下垂」，与 D4 计划里的「窗沿坐」一致；若最终坐面在窗口上沿，
   需要把 `modelRoot` 放在坐面高度、并让腿越过窗沿（穿窗/越界遮挡由渲染层决定）。
3. `ik: "on"`：clip 自带 `右足ＩＫ/左足ＩＫ` 轨道（170 帧），预览确认 CCDIK 解算正常；不要额外关 IK。
4. 反应 clip 都是 `loop:false`（播完回退 B3/空闲逻辑）；`Salute` 起止回到站姿，`Reaction` 首尾差 0.8°，
   交互打断/淡出都安全。
5. 表情：仍是 0 morph 轨道（Mixamo 导出不含本模型表情）→ 表情继续由 app 调度器管。

### 10.6 还缺什么

- **真正的「坐定呼吸 idle」**：three.ws 的 canonical 动画库里有 `sitidle`（Mixamo "Sitting Idle"）与
  `sitloop`（"Sitting With Breathing Idle"，4.3s，完美循环，`public/animations/clips/sitloop.json`），
  **但仓库只提交了 canonical JSON（three.js AnimationClip 格式）、没有对应源 FBX**；要做需写「canonical
  JSON + `src/animation-canonical-rest.js` → 合成骨架/动画 → FBX/或直接 VMD」的桥（≈0.5–1 人日，未在本时间盒内做）。
  当前 `Sitting Clap` 已能提供「坐定 + 微动 + 偶发拍手」的可用坐姿。
- 更多反应/待机变体：同为 canonical JSON 的 `wave`/`shrug`/`nod`/`think`/`celebrate`/`facepalm` 等可做同类桥；
  此外若用户愿意提供 Mixamo 账号，可直接按 D2 管线批量导出（1 条命令/个）。
- 表情/物理仍为既有边界（无 morph、physics:false）。

### 10.7 复现命令（D4a）

```bash
cd /Volumes/4TB外置盘/deepseek-harness/aventurine-pet
# 1) 下载（0 账号；见 §10.2 循环）
# 2) 转 VMD（见 §10.2 的 convert.sh 调用）
# 3) 预览
for spec in "Sitting Clap:sit" "Salute:salute" "Reaction:reaction"; do
  src="${spec%%:*}"; id="${spec##*:}"
  ./scripts/anim-pipeline/preview/run.sh \
    --motion "tests/tmp/motions/free/sit/vmd/${src}.vmd" \
    --frames 0,30,60,90,120,150,170 --angles front,side,45 \
    --out "tests/tmp/preview/try-${id}"
done
# 4) 放入运行期目录（gitignore）
cp "tests/tmp/motions/free/sit/vmd/Sitting Clap.vmd"  assets/model/optimized/motion-sit.vmd
cp "tests/tmp/motions/free/sit/vmd/Sitting Laughing.vmd" assets/model/optimized/motion-sit-laugh.vmd
cp "tests/tmp/motions/free/sit/vmd/Salute.vmd"        assets/model/optimized/motion-salute.vmd
cp "tests/tmp/motions/free/sit/vmd/Reaction.vmd"      assets/model/optimized/motion-reaction.vmd
# 5) 更新 motion-index.json（见 §10.4）后校验：
./scripts/anim-pipeline/reze/node_modules/.bin/esbuild \
  src/renderer/src/animation/external/manifest.ts --bundle --platform=node --format=esm \
  --outfile=/tmp/manifest-check.mjs && node -e "…parseMotionIndex…"   # 期望 warnings=[]
```

**D4a 结论**：零成本拿到**干净可用的坐姿循环**（GitHub 公开 Mixamo FBX，来源/条款已记录）+ **2 个一次性反应**
（Salute→dshDone、Surprised→dshError），全部 17/17 必需骨、无穿地、预览器 7/7；`motion-index.json` 扩到 6 clips
并通过真实解析器校验。sit 的 grounding/锚点语义需 D4 代码侧按 §10.5 处理。


## 11. 拖拽反应补充（D4e，摸头/拖拽反应闭环）

任务要求「摸头/拖拽反应」由真实人类动作驱动。摸头已有 `motion-taunt.vmd`（`pat`），
本轮补上 `drag` mood 的 VMD：

- **来源**：GitHub `nirholas/three.ws` → `animation-sources/Shoved Reaction With Spin.fbx`
  （**Mixamo 导出**；仓库 `animation-sources/README.md`/`LICENSES.md` 记录 Mixamo 条款：
  可免费用于项目、禁再分发原始动画）。本地个人自用合规。
- **转换**：`scripts/anim-pipeline/reze/convert.sh <fbx> --bind-ref <three.ws Idle.fbx> \
  --target-pmx "assets/model/optimized/星穹铁道—砂金·戏浪.pmx" --in-place --out ...`
- **结果**：`motion-drag.vmd`，54/54 骨轨道（必需人形骨 17/17）、4.53s 一次性反应
  （被推/被甩的踉跄 + 转身，`loop=false`、`ik=on`、crossfade 160ms），预览器 7/7 PREVIEW_OK，
  接触表 `tests/tmp/preview/drag-Shoved_Reaction_With_Spin/contact-sheet.png`。
- **manifest**：新增 `{ id: "drag", file: "motion-drag.vmd", moods: ["drag"], loop: false }`
  → 清单 6→7 clips。拖拽开始时播一次反应，播完回退 B3 拖拽姿态（`finishedClipId` 机制保证
  同一轮拖拽不重播；松手后 mood 变化即清除标记，下次拖拽可再触发）。
- **备选素材**（已转换但未入清单，`tests/tmp/motions/free/drag/vmd/`）：`Falling`（11.37s）、
  `Defeat`（7.30s）、`Joyful Jump`（1.87s，可作 `pat`/`dshDone` 的备选快乐反应）。
- **仍缺**：真正的「被拎起来持续挣扎循环」动作（Mixamo/公开素材里没找到干净的）；当前方案是
  「一次性被甩反应 + 回退 B3 拖拽姿态」。若用户之后愿意提供原视频，可用 MiPo 录一段拎起挣扎。


## 12. 走路片段替换（D4f，观感优化）

`motion-walk.vmd` 原为 three.js `Soldier.glb` 的 Walk（Mixamo 军事角色步态，偏硬）。本轮用同一授权链路的
更中性版本替换：

- **来源**：GitHub `nirholas/three.ws` → `animation-sources/Walking.fbx`（**Mixamo 标准 Walk**，
  仓库记录 Mixamo 条款：可免费用于项目、禁再分发原始动画）。
- **转换**：`scripts/anim-pipeline/reze/convert.sh ... --bind-ref <Idle.fbx> --target-pmx 本模型 --in-place`。
- **结果**：`motion-walk.vmd`（0.967s 原地循环、**54/54 骨轨道**、loop 首尾差 0.04°、
  脚 IK 站立相实测自然步速 **≈490px/s @540px**）；替换后 app 实测 `externalPlaybackRate=0.959`
  （= 470/490 体高相对步速换算，滑步 <5%）、`velocity=470px/s`、脚底误差 0。
- **观感**：与旧 Soldier 步相比手臂更放松、步幅更自然，更贴角色「从容」气质；旧版留档
  `assets/model/optimized/motion-walk-soldier.vmd`（本地，未入清单）。
- **manifest**：walk 的 `nominalSpeedPxPerSec` 470→490、source 同步更新。
