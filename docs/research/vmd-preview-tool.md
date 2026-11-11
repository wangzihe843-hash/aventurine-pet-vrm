# 外部 MMD 动作包（VMD/VPD）× 本 PMX 的独立预览验证 + 工具报告

> 任务：task-5（团队「动作预览器」）。作者：vmd-viewer。日期：2026-11-08。
> 模型：`assets/model/optimized/星穹铁道—砂金·戏浪.pmx`（PMX 2.0，382 骨 / 85 morph / 4 根 IK / 26 根 grant / 32,966 顶点 / 39 材质 / 20 贴图，bind pose 高 **21.681 单位**，gitignore 私有资产）。
> 运行时：macOS（Apple Silicon）+ Electron **44.10.2**（内置 Node 24.22.2）+ three.js **r171（精确 pin 0.171.0）** `MMDLoader` / `MMDAnimationHelper`。
> 交付物：
> - 工具：`scripts/anim-pipeline/preview/`（脚本 + README + 内置自造动作生成器 + 批量证据脚本）
> - 证据：`tests/tmp/preview/`（**gitignore，不入库**；13 个 case、198 张透明背景 PNG + 13 张接触表 + metadata.json/compatibility.md）
> - 本文档
>
> 边界：**未修改** `src/**`、`package.json`、`PLAN.md` 与其他 docs；未 commit；未把模型/动作二进制放进 tracked 路径。动作文件仅本机自用（来源与授权见 `docs/research/motion-assets.md`）。

---

## 0. 一页结论

| 问题 | 结论（本机实测） |
|---|---|
| **外部 VMD 能不能直接套到本 PMX 上播？** | **运动学层面：能。** reze-rig 从 humanoid FBX 转出的 4 个 VMD（`Idle`/`Taunt`/`Run_Lfoot`/`Arms Down`）都是 **54/54 骨骼轨道 100% 命中**本模型、**动作本体必需 17 根人形骨 17/17**；接触表视觉正常（无撕裂/无错位/无穿模），腿脚由模型自带 CCDIK 正确解算。第三方 VMD `bear_walk`（bear 骨架）骨骼轨道仅命中 **70/262**，但 17/17 必需骨全命中，走路循环视觉成立——缺失的 192 条全是**非标准骨**（bear 的发型/裙摆/尾巴/表情），在本模型上只是「这些部位保持静止」。three.js 官方 `wavefile_v2.vmd`（初音ミク舞蹈，93.6s）：140 轨命中 81、17/17 必需骨，同样可播。 |
| **「直接用」还需要什么适配？** | **5 项**：① **root motion**（センター 位移）归零/映射策略；② **贴地补偿**（脚骨世界高度漂移 20–34px@540px 宠物）；③ **IK 策略**（r171 不解析 VMD 的 IK on/off 段、模型自带 4 根足ＩＫ 始终开）；④ **与 Wave2 B3 程序化姿态互斥**（同一批骨骼不能双驱动）；⑤ **表情单独驱动**（转换的 VMD 无 morph；外部 VMD 的 morph 与本模型基本不匹配）。详见 §4。 |
| **IK 到底是必需还是负担？** | 对 **IK 驱动**的动作（典型 MMD：只给 足ＩＫ 目标位置）它是**必需**的：`bear_walk` 的 FK 腿只有 2 帧关键帧，实测 `--ik off` 后**双腿完全冻结**且 9/11 帧穿地更深；r171 helper 默认开 CCDIK，行为与 MMD 一致。对 **FK 驱动**的动作（只写 足/ひざ/足首 旋转、不给 IK 轨道），模型自带 IK 可能把腿拉回——本批 reze-rig 产物都同时带 IK 轨道，未发现冲突，但适配外部动作包时要逐包验证（工具提供 `--ik off` 对照组）。 |
| **脚底贴地如何？** | 站立/待机类会**整体浮空**：`Idle` 脚骨比 bind pose 高 **0.81 单位 ≈20.1px@540px**、`Taunt` 13.2px、`Run_Lfoot` 34.4px（跑步腾空属正常）；`bear_walk` 局部**穿地 14.9px**（1/11 帧）；VPD `01` 穿地 12.7px。app 若沿用「bind pose 包围盒底边贴 workArea」会看到明显浮空/插桌，需要按「最低脚骨/包围盒」做**动态贴地补偿**。 |
| **センター 位移（root motion）多大？** | `Idle`：X −0.33..0 / Y +0.605..0.692（≈17px 垂直）——**站立时整体上浮**；`Taunt`：X −0.805..−0.073 / Y −1.446..−0.935 / Z −0.586..0.355（≈20px 水平漂移 + 36px 垂直）；`Run_Lfoot`：Y −1.553..−0.896（≈39px）；`bear_walk`：Z +3.375..3.465（≈**86px 水平 root motion**，未原地化）；`wavefile_v2`：X −5.45..3.7 / Y −2.4..1.53 / Z −8.9..5.9（≈222px 水平，舞蹈走位）。app 集成时必须决定「归零 / 只取 Y / 映射为宠物位移」。 |
| **VPD 能用吗？** | **通道可用**（r171 原生 `loadVPD`→`helper.pose`，本工具已跑通）：内置自造 UTF-8 VPD 5/5 命中、姿势正确应用。外部 VPD（three.js 官方初音ミク `01/05/09.vpd`）**93 骨只命中 60（64.5%）**，缺 33 根（发型/裙摆/领带/目光）；应用后 52–60 根骨偏离 rest、视觉上人体姿势成立，但**衣服/头发保持静止**、脚底浮/穿 2–14px。VPD 只能做**静态姿势**、应用时 `resetPose` 会清掉其他驱动 → 与 B3 互斥。 |
| **表情 / 物理？** | reze-rig 转换的 VMD **morph 轨道 = 0**（不转表情）；`bear_walk` 225 条 morph 轨道只命中 30（其它角色表情）；`wavefile_v2` 31 条命中 22。→ **表情必须由 app 表情系统单独驱动**，不能用外部动作包替代。`physics:false`（不引入 ammo.js）下裙摆/辫子/袖带**静态**；本模型 284 刚体/318 关节不参与——观感评估时不要误判为动作包问题。 |
| **技术可行性** | three r171 的 MMD 全链路在本机可用：`file://` + `webPreferences.webSecurity:false` + `MMDLoader`→PMX（20/20 贴图成功、透明背景、WebGL2、`getImageData` 不 taint）→ `MMDAnimationHelper`（VMD）→ `helper.pose`（VPD）→ `webContents.capturePage()` 透明 PNG。**注意 r171 是最后带 `MMDLoader` 的版本**（r172 移除，模块已打 deprecated 警告）——必须继续精确 pin `three@0.171.0`。 |

**一句话结论**：外部 MMD 动作包（尤其 reze-rig 转换的 humanoid VMD）**可以直接套到这只 PMX 上播放**，运动学层面无需重定向；真正的工作量在 app 集成适配——**root motion 归零、动态贴地、IK 策略、与 B3 程序化姿态互斥、表情单独驱动**——而不是模型/动作包本身。

---

## 1. 工具：`scripts/anim-pipeline/preview/`

### 1.1 它是什么

独立 Electron 预览器（**不 import app 的 `src/**`**，不改 `package.json`）：一个隐藏窗口里用 three r171 `MMDLoader` 加载本 PMX（`file://` 直读 `assets/model/optimized/`，贴图按 PMX URL 的 base 解析），可选加载 VMD 播放（`MMDAnimationHelper`，`physics:false`）或 VPD 静态姿势（`helper.pose`），按「帧号 × 相机角度」调用 `webContents.capturePage()` 输出透明 PNG，并在渲染进程 2D canvas 合成带棋盘格/标签的接触表；同时 main 侧用与 three 内 vendored parser 同源的 `mmd-parser@1.1.4` 做**独立静态体检**，输出骨骼交集/缺失、帧率/时长、IK 轨道与 IK on/off 段、センター 位移、脚底漂移等兼容性元数据。

### 1.2 快速开始（仓库根目录）

```bash
# 无参数：自动扫描 tests/tmp/motions/**（含 converted/、threejs_r171/ 子目录）找 VMD/VPD；
# 找不到就用内置自造最小 VMD（真实二进制格式）验证管线。
./scripts/anim-pipeline/preview/run.sh

# 指定 VMD + 采样帧（30fps 帧号）+ 相机角度
./scripts/anim-pipeline/preview/run.sh \
  --motion "tests/tmp/motions/converted/Idle.vmd" \
  --frames 0,10,20,30,40,50,60,70,80,90 \
  --angles front,side,45,back

# VPD 静态姿势
./scripts/anim-pipeline/preview/run.sh --vpd tests/tmp/motions/threejs_r171/vpds/01.vpd \
  --angles front,side,45

# 对照实验：关掉 CCDIK（判断模型自带足ＩＫ 对动作的影响）
./scripts/anim-pipeline/preview/run.sh --motion tests/tmp/motions/bear_walk.vmd \
  --frames 0,8,16,24,32 --angles side --ik off --out tests/tmp/preview/bear_walk-ik-off

# 一键复现全部证据（12 个 case）
./scripts/anim-pipeline/preview/gen-evidence.sh
```

输出（缺省 `tests/tmp/preview/<动作名>/`）：

```
<case>/
├── frames/f0000-front.png …           逐帧逐角度透明 PNG（capturePage）
├── contact-sheet.png                  接触表（行=帧、列=角度；单角度多帧自动 4 列网格）
├── metadata.json                      全量元数据（模型/动作/兼容性/采样/断言/结论）
├── compatibility.md                   兼容性检查清单（人/agent 直接读）
├── index.md                           截图索引
└── run.log                            运行日志
```

成功退出码 0、stdout 最后一行 `PREVIEW_OK`；失败 `PREVIEW_FAIL`；参数/环境错误 2；看门狗超时 3。

### 1.3 参数（完整表见工具目录 `README.md`）

| 参数 | 等价环境变量 | 说明 |
|---|---|---|
| `--pmx <path>` | `PREVIEW_PMX` | 默认在 `assets/model/optimized/` 自动发现 |
| `--motion <path>` / `--vpd <path>` | `PREVIEW_MOTION` / `PREVIEW_VPD` | VMD 动作 / VPD 静态姿势 |
| `--frames <list>` | `PREVIEW_FRAMES` | VMD 采样帧号（30fps）；默认按时长均匀取 4 帧 |
| `--angles <list>` | `PREVIEW_ANGLES` | `front`/`side`/`45`/`back` 或任意度数；默认 `front,side,45,back` |
| `--out <dir>` | `PREVIEW_OUT` | 输出目录 |
| `--size <w>x<h>` | `PREVIEW_SIZE` | 默认 `480x720`（本机 dpr=1，PNG 即 480×720） |
| `--sheet-cell <w>x<h>` | — | 接触表单格像素，默认 `300x450` |
| `--ik <on\|off>` | `PREVIEW_IK` | CCDIK 开关，默认 on；off 用于对比实验 |
| `--synthetic` / `--synthetic-vpd` | — | 内置自造 VMD / VPD（不依赖外部下载，验证管线/回归） |
| `--show` | `PREVIEW_SHOW=1` | 显示预览窗口（默认**不可见**，见 §1.4） |
| `--no-sheet` / `--no-verify` / `--json` / `--debug-info` / `--timeout <s>` | — | 见 README |

内置自造动作（`lib/synthetic-motion.cjs`）：
- **VMD**：真实二进制 `Vocaloid Motion Data 0002`，61 帧 / 2s，含 センター 上下位移、上半身/腕/ひじ/頭 旋转、左足 FK、左足ＩＫ 位移，以及 VMD 末尾 IK on/off 段；
- **VPD**：UTF-8 文本、5 根真实骨名（左腕/右腕/上半身/頭/左ひじ）——分别验证「VMD 二进制解析+播放」和「VPD 文本解析+应用」两条链路，不依赖任何外部文件。

### 1.4 窗口可见性（重要）

- **默认不显示给用户**：窗口仍 `show: true`（macOS 合成器保持渲染，`capturePage` 才稳定），但 `opacity: 0` + `focusable: false` + `setIgnoreMouseEvents(true)` + `app.dock.hide()`，用户屏幕上**看不到**预览窗口/模型。
- 只有显式 `--show`（或 `PREVIEW_SHOW=1`）才显示窗口。早期版本默认可见，循环切换 front/side/45/back 时桌面上看起来像「模型在 360° 转圈」，曾被误认为 app bug——**日常出证据一律用默认（不加 `--show`）**。
- 后台跑完自动 `app.exit()`；本工具不常驻、无守护进程。

### 1.5 为什么证据可信（自动断言）

每次运行在 `metadata.json`/`compatibility.md` 里写合并自动判定（本批 13 个 case 全部 `PREVIEW_OK`）：

| 断言 | 判定方式 |
|---|---|
| 模型加载 | renderer `mesh.skeleton.bones.length` vs main 侧独立 PMX 解析的 `boneCount`（382=382） |
| 贴图加载 | LoadingManager 统计：成功 **20/20**、失败 0；渲染后 `getImageData` 不 taint |
| 渲染非空白 | 逐帧读回 GL canvas：非透明像素占比（本批 front/side/45 约 11–18%）+ 2D 包围盒 |
| 骨架运动量 | 跨帧全部骨骼世界位移/旋转最大值（证明「时间在走且骨架确实在动」，不是静止渲染） |
| 脚底不穿地 | 脚骨（足首D/足先EX/つま先等）世界高度相对 bind pose 的漂移量，穿地为失败、浮空为提示 |
| 截图数量 | 帧数 × 角度数 |

---

## 2. 验证矩阵（本批 13 个 case 全部有接触表）

| # | case | 动作文件（来源） | 类型 | 帧范围 / 时长 | 动作骨骼轨道 | 命中（必需骨） | IK 控制轨 / IK on/off 段 | センター位移范围（模型单位） | 脚底漂移 | 骨架运动量 | 断言 |
|---|---|---|---|---|---:|---|---|---|---|---|---|
| 1 | `Idle` | `converted/Idle.vmd`（Lead 用 reze-rig 从 UE/Unity humanoid Idle 转出，--in-place） | VMD | 0–90 / **3.00s** | 54 | **54/54（17/17）** | 右/左足ＩＫ；1 条 f0 **on**（4 骨） | X −0.332..0，Y **+0.605..0.692**，Z 0 | 浮空 **0.81 单位 / 20.1px**（10/10 帧） | max 0.669 单位 / **10.5°** | 7/7 ✅ |
| 2 | `Taunt` | `converted/Taunt.vmd`（Mixamo 挑衅 → VMD） | VMD | 0–85 / **2.83s** | 54 | **54/54（17/17）** | 右/左足ＩＫ；1 条 f0 on | X −0.805..−0.073，Y −1.446..−0.935，Z −0.586..0.355（水平≈20px、垂直≈36px） | 浮空 0.53 单位 / 13.2px（10/10） | max 5.64 单位 / **127.0°** | 7/7 ✅ |
| 3 | `Run_Lfoot` | `converted/Run_Lfoot.vmd`（跑步段） | VMD | 0–20 / **0.67s** | 54 | **54/54（17/17）** | 右/左足ＩＫ；1 条 f0 on | Y −1.553..−0.896（≈39px 垂直） | 浮空 1.38 单位 / **34.4px**（11/11；跑步腾空属正常） | max 15.88 单位 / **137.0°** | 7/7 ✅ |
| 4 | `ArmsDown` | `converted/Arms Down.vmd`（静态 A-pose 姿势） | VMD（单帧） | 0–1 / 0.03s | 54 | **54/54（17/17）** | 右/左足ＩＫ；1 条 f0 on | Y +0.331（≈8px） | 浮空 0.51 单位 / 12.7px | 静态→跳过断言 | 6/6 ✅ |
| 5 | `bear_walk` | `motions/bear_walk.vmd`（motion-hunt 下载的第三方真实 walk，bear 骨架） | VMD | 0–1145 / **38.17s** | **262** | 70/262（**17/17 必需骨**；缺 192 条非标准骨） | 右/左足ＩＫ + 左右つま先ＩＫ；IK 段存在但 **0 条记录** | Z **+3.375..3.465**（≈**86px 水平 root motion**），Y −0.66..−0.044 | **穿地 0.60 单位 / 14.9px**（1/11 帧） | max 10.36 单位 / 83.0° | 6/7 ⚠（穿地） |
| 6 | `bear_walk-side` | 同上，**16 帧连续 side** | VMD | 同上 | 262 | 70/262（17/17） | 同上 | 同上 | 穿地 15.3px（3/16 帧） | 同上 | 6/7 ⚠ |
| 7 | `bear_walk-ik-off` | 同上，11 帧 side，**`--ik off` 对照** | VMD | 同上 | 262 | 70/262（17/17） | 同上（CCDIK 关闭） | 同上 | 穿地 17.8px（**9/11 帧**） | 同上（但**腿完全冻结**） | 6/7 ⚠ |
| 8 | `wavefile_v2` | `threejs_r171/wavefile_v2.vmd`（three.js 官方示例舞蹈 93.6s） | VMD | 0–2809 / **93.63s** | 140 | 81/140（**17/17**；morph 31 轨命中 22） | 左右足/つま先/髪/ネクタイＩＫ；无 IK 段 | X −5.45..3.7，Y −2.4..1.53，Z −8.9..5.9（水平≈222px） | 浮空 6.0px | max 13.75 单位 / **179.2°** | 7/7 ✅ |
| 9 | `vpd-01` | `threejs_r171/vpds/01.vpd`（初音ミク Shift-JIS VPD） | VPD | 静态 | 93 | 60/93（64.5%） | — | — | 穿地 12.7px | 52/382 骨偏离 rest | 6/7 ⚠（穿地） |
| 10 | `vpd-05` | `…/05.vpd` | VPD | 静态 | 93 | 60/93 | — | — | 2.3px | 57/382 骨偏离 rest | 7/7 ✅ |
| 11 | `vpd-09` | `…/09.vpd` | VPD | 静态 | 93 | 60/93 | — | — | 浮空 13.8px | 60/382 骨偏离 rest | 7/7 ✅ |
| 12 | `synthetic-vpd` | 工具内置自造（UTF-8、真实骨名） | VPD | 静态 | 5 | 5/5（100%） | — | — | 0px | 6/382 骨偏离 rest | 7/7 ✅ |
| 13 | `synthetic-vmd` | 工具内置自造最小 VMD（真实二进制） | VMD | 0–60 / 2s | 8 | 8/8（必需 7/17，自测用） | 左足ＩＫ；IK 段 3 条（含 on/off 切换） | Y −0.9..0.35（≈22px） | 1.4px | max 9.79 单位 / 89.9° | 7/7 ✅ |

> 说明：`命中（必需骨）`= VMD 骨骼轨道与模型 382 骨的交集 / 动作本体必需的 17 根人形骨（センター、上半身、首、頭、下半身、左右腕/ひじ/手首、左右足/ひざ/足首）。全部 13 个 case 的接触表与元数据在 `tests/tmp/preview/<case>/`；总计 **198 张逐帧 PNG + 13 张接触表**，无失败运行。
> 表 5–8 的 `-side`/`-ik-off` 是为「脚掌滚动/滑步/IK 必要性」专门加跑的对照证据。

### 2.1 证据怎么查看

```bash
# 接触表（人/AI 直接看图；AI 用 read_image 读）
tests/tmp/preview/<case>/contact-sheet.png
# 单帧原图（透明背景，480×720）
tests/tmp/preview/<case>/frames/f<帧号>-<角度>.png
# 兼容性清单（含骨骼交集/缺失、センター、IK、脚底、断言、结论）
tests/tmp/preview/<case>/compatibility.md
# 全量机器可读
tests/tmp/preview/<case>/metadata.json
```

---

## 3. 逐个动作的观感结论（接触表人工复核）

- **`Idle.vmd`（3s 循环，最优先采用）**：站姿自然、重心转移与手臂微摆成立；**脚部由 CCDIK 正确贴住 IK 目标**，步态无滑步；但整段**整体比 bind pose 高约 20px@540**（センター Y +0.6 单位 + 腿部姿态），app 需要贴地补偿。头/颈/肩/手指有动画；**无表情 morph**。
- **`Taunt.vmd`（2.83s 挑衅）**：躯干+手臂动作幅度大（max 127°）、接触表未见撕裂/穿模，侧/45° 可见自然屈膝；センター 有 20px 水平 + 36px 垂直位移（挑逗时前后/上下晃动），集成时需要归零。同样是 54/54 骨、无 morph。
- **`Run_Lfoot.vmd`（0.67s 跑步段）**：跑步循环成立，side 接触表可见腾空/落地相位与屈膝；整段浮空 34.4px 属跑步正常，若在桌面上跑仍需按支撑脚动态贴地。
- **`Arms Down.vmd`（单帧静态）**：把 A-pose（rest 手臂下垂 39.6°）压成**自然垂臂站姿**，正面/侧面/45° 均正常，指仍张开（桌宠尺度不可辨）；单帧动作没有时间轴，工具自动跳过运动量断言。适合做「静止基线 / 与 B3 姿态混合前的对照」。
- **`bear_walk.vmd`（38s，第三方真实 walk）**：虽然骨名覆盖率只有 26.7%（262 轨命中 70），但 17/17 必需骨齐全，**走路循环视觉完全成立**（contact-sheet 与 side 连续 16 帧可见脚掌抬起→落地滚动→支撑腿伸展），说明「骨名覆盖率」不能单独作为可用性判定——**必需骨覆盖才是关键**；未命中的都是 bear 角色的发型/裙摆/尾巴/表情骨（本模型自然静止）。**风险**：センター 有 +3.4 单位（≈86px）水平 root motion（未原地化）→ app 里会走路漂移；局部 1–3 帧脚底穿地 15px（bear 腿长/踝高与砂金不同）→ 需要贴地。**IK 必要性对照**：`--ik off` 后双腿完全冻结（该 VMD 的腿动作只在足ＩＫ轨道里，FK 腿仅 2 帧），且 9/11 帧穿地更深——**IK 驱动的动作必须保持 CCDIK 开启**。
- **`wavefile_v2.vmd`（93.6s，three.js 官方 Miku 舞蹈）**：舞蹈可播、morph 22/31 命中；但 59 条缺失骨（发型/裙摆/领带/目光）以及 222px 水平 root motion，只适合做「兼容性上限样本」，不适合直接用于桌宠。
- **VPD `01/05/09`（初音ミク姿势）**：`loadVPD → helper.pose` 链路正常，人体姿势能套上来（52–60 根骨偏离 rest），但 33 根缺失骨（发型/裙摆/领带/目光）导致**衣发静止**、脚底浮/穿 2–14px；VPD 无时间轴，只能当静态姿势/表情参考，不能替代动作。
- **内置自造 VMD/VPD**：证明「VMD 二进制解析→播放→IK/grant→截图」与「VPD 文本解析→pose→截图」两条链路在无外部素材时也可回归（`--synthetic` / `--synthetic-vpd`）。

---

## 4. 「VMD 直接套用」判断与 app 集成适配清单

### 4.1 可以直接套用的条件（本机已满足）

1. **必需人形骨 17/17 有轨道**（本批 reze-rig 产物、bear_walk、wavefile 全部满足）——决定动作本体是否成立；
2. **骨骼名与本模型交集足够**：reze-rig 产物 54/54；第三方需看 `compatibility.md` 的「必需骨覆盖」而非总覆盖率；
3. **足部驱动方式被 r171 helper 支持**：IK 轨道 → 模型自带 CCDIK 解算；FK 腿 + grant → 模型 26 根 grant 把 足/ひざ/足首 抄到 D 链蒙皮骨（本工具默认开 grant 已验证）；两者混合时 IK 优先（与 MMD 语义一致，但 r171 无法按帧关 IK，见 §5-K2）。

### 4.2 必须做的 5 项适配（app 侧建议；本文不改 `src/**`）

| # | 适配 | 实测依据 | 建议做法 |
|---|---|---|---|
| A1 | **动态贴地** | Idle 浮空 20.1px、Taunt 13.2px、Run 34.4px、bear_walk 穿地 14.9px、VPD 穿地 12.7px（@540px 宠物） | 每帧按「脚骨/足先EX/つま先 世界最低点」或蒙皮包围盒把 `modelRoot.y` 补偿到地面；与现有 `IdleMotion`（以脚底为支点）兼容；切换动作时按平滑过渡避免弹跳 |
| A2 | **root motion 归零/映射** | センター 位移：Idle 垂直 17px、Taunt 水平 20px+垂直 36px、bear_walk 水平 86px、wavefile 水平 222px | 读取 VMD `センター`（必要时 `グルーブ`/`全ての親`）位移曲线：站立/反应类**归零或只保留 Y**；走路类把水平量映射为宠物实际 `x` 位移（与 B1/B2 运动系统合成），不要让它穿透桌面边缘 |
| A3 | **IK 策略** | bear_walk `--ik off` 腿冻结；模型自带 4 根足ＩＫ 始终开；r171 忽略 VMD IK on/off 段 | 默认保持 CCDIK on（r171 默认）；对「纯 FK 腿 + 关闭 IK」的 VMD，集成时需提供「关闭 helper IK / 只跑 grant」的分支（本工具 `--ik off` 用来预验证）；把两腿脚底 IK 目标与贴地补偿统一到同一个「脚底高度」来源，避免 IK 与贴地打架 |
| A4 | **与 B3 程序化姿态互斥** | r171 `MMDAnimationHelper._animateMesh` 每帧 `_restoreBones`+mixer 覆盖骨骼；B3 直写骨骼会与其冲突（`docs/anim-tech-survey.md` §2.5） | 引入独立的 VMD 播放分支：启用时**停写 B3 的受控骨**（或让 helper 空转/移除 mesh）；切换用 slerp 淡入淡出；不要同帧双驱动（表情/材质 morph 除外） |
| A5 | **表情 / 物理单独决策** | 转换 VMD morph=0；外部 VMD morph 命中率低；`physics:false` 下衣发静态 | 表情继续由 app 表情调度器驱动（外部 morph 轨道命中时才叠加并做冲突裁决）；物理维持 `physics:false`（不引入 ammo.js），衣摆/辫子的次级运动仍走 Wave2 自研弹簧或接受静态 |

### 4.3 不建议直接用的情形

- **骨骼名/必需骨不匹配**（例如给其它角色特化骨架的 VMD，必需骨缺失）→ 必须先重定向（Lead 的 reze-rig 路线已证明可行）。
- **需要逐帧关闭 IK 的动作**（依靠 VMD IK on/off 段切 FK 的舞蹈）→ r171 无法按帧开关，观感会与 MMD 官方播放器不一致；需要关 IK 时只能在 app 侧整段开关或自写「按 VMD IK 段驱动 CCDIK」的封装（r171 内部 solver 可用，但需要绕过 helper 的默认每帧 update）。
- **强依赖物理/衣发摆动的动作**（裙摆、长发、尾巴）→ 本模型自带衣发骨骼与静态网格，且 physics:false；直接套用会「身体在动、衣服不动」。
- **需要表情表演的动作**（外部 morph 名称/索引与模型不匹配）→ 表情必须由 app 表情系统补。

---

## 5. 坑与源码级解释（本机实测，编号 K1–K16）

- **K1（本工具最大的坑）`mixer.setTime(t)` + `helper.update(0)` 会「时间在走、骨架不动」**。
  r171 `PropertyMixer.apply` 有「累计 buffer 与上一累加槽相同则跳过 `binding.setValue`」的优化；而 `MMDAnimationHelper._animateMesh` 每帧先 `_restoreBones` 把骨骼复位到上一帧备份。当 delta=0 且要应用的姿势与上次相同时，setValue 被跳过 → 骨骼停留在 restore 后的 rest 姿势。表现为「mixer.time 在变、骨骼 quaternion 一直 identity」。
  **正确做法**：从第 0 帧开始 `helper.update(1/30)` 逐帧步进；需要回退时 `helper.remove(mesh)` + `mesh.pose()` + 重新 `helper.add` 再从 0 重放。本工具采样路径已按此实现（`renderer.js` 的 `seekFrame`/`resetPlayback`）。
- **K2（IK 开关）r171 不消费 VMD 的 IK on/off 段**。`mmd-parser` 只解析到 camera 段（另有 light/selfShadow/IK 三段未解析），`MMDAnimationHelper` 也没有按帧/按骨开关 IK 的接口；模型自带的 4 根足ＩＫ **始终**每帧 CCDIK。实测 reze-rig 产物的 IK 段只有 1 条 f0 **show=on**（与 helper 默认一致，无实际影响）；若动作包用 show=off 切 FK，则直接套用会与 MMD 不一致。
  - 该段布局还存在**变体**：规范常见 `[show u8][count u8][20B 名]`，而 reze-rig 实测为 `[show u8][count u32][21B 名]`；本工具用「能完整消费到文件尾 + 骨名可解码」的候选布局打分做容错解析（否则 IK 记录会被读成空骨名）。
- **K3（IK 驱动 vs FK）**：`bear_walk` 的腿动作只存在于 足ＩＫ 轨道（FK 腿仅 2 帧），`--ik off` 实测双腿冻结、穿地 9/11 帧 → IK 驱动的外部 VMD 必须保持 CCDIK 开启。反过来，纯 FK 动作可能被模型自带 IK 拉回，需要用 `--ik off` 对照确认。
- **K4（模型自带 IK 始终开）**：模型 4 根 IK（左右足ＩＫ→足首 iter 40、左右つま先ＩＫ→つま先 iter 3，限角 link）由 r171 CCDIK 每帧解算；「VMD 无 IK 轨道」≠「IK 不生效」。
- **K5（センター 语义）**：VMD 的 position 是**相对 rest 的偏移**（MMDLoader 会加 `basePosition`），不是世界坐标；センター/グルーブ 的位移直接让模型整体平移（root motion），要归零或映射（§4 A2）。MMD 中 センター 高度也常被用来做重心起伏，不能简单全丢弃。
- **K6（脚底贴地）**：模型 bind pose 包围盒 Y∈[0.008, 21.689]；工具用脚骨（足首D/足先EX/つま先/足首）**世界高度相对 bind pose 的漂移**来量化浮空/穿地（`footProbe`）。浮空可用整体下移补偿；穿地（负值）直接插桌面，必须补偿。
- **K7（物理）**：`helper.add(mesh, { physics: false })` 避免 `MMDPhysics`（需要全局 Ammo → 本机无）；结果是 284 刚体/318 关节不参与，裙摆/辫子/袖带**静态**。这是 app Wave 1/2 既定决策，不是动作包缺陷。
- **K8（插值/帧率）**：r171 `MMDLoader` **支持** VMD 的 64 字节贝塞尔插值（`CubicBezierInterpolation`），不是线性近似；时间 = `frameNum/30`（MMD 固定 30fps），app 30fps 渲染可直接对齐。
- **K9（坐标系/全角）**：PMX/VMD/VPD 解析均做 `leftToRight`（位置 z 取反；四元数 x/y 取反）；模型最终面向 +Z，`front` 相机在 +Z。骨名是**日文原文**，`左足ＩＫ` 的 `ＩＫ` 是**全角**（≠ `左足IK`）；PMX 内还有半角 `右足IK親`。
- **K10（骨名缺失/重名）**：`MMDLoader` 对模型不存在的骨骼轨道**静默丢弃**（`buildSkeletalAnimation` 用 boneNameDictionary 过滤）——所以「动作看起来少了一半」时要看 `compatibility.md` 的缺失列表；模型有 1 组重名骨 `后碎髮9`×2（骨骼轨道按名字匹配只命中首个）。
- **K11（VMD 尾部段）**：不同导出器写不写 light/selfShadow/IK 段不一（three.js 官方 wavefile 完全没有；reze-rig 有 1 条 IK 记录；bear_walk 有空的 IK 段）。工具做了越界保护与容错，但这些段 r171 播放时**不受影响**（只用 motion/morph 段）。
- **K12（VPD）**：编码通常是 **Shift-JIS / Windows 代码页 CP932**（本工具 UTF-8 fatal 探测失败则回退 Shift-JIS 解码），也有 UTF-8 变体；`parseVpd` 的正则要求数字带小数点（`0.000000`）；`helper.pose` 是 `mesh.pose()` 复位 + 按骨名 `quaternion.multiply`/`position.add` + IK + grant，**每次应用都会重置**；缺骨静默跳过；VPD 无时间轴，只能静态。
- **K13（file:// 加载）**：窗口 `webSecurity:false` + `MMDLoader.setCrossOrigin(undefined)` 才能让 PMX 内 20 张贴图按 `file://` base 加载并且 WebGL 不 taint；`getImageData` 读回同时充当 taint 检测。
- **K14（环境/窗口）**：本机 shell 环境带 `ELECTRON_RUN_AS_NODE=1`，直接 `electron` 会退化为纯 Node → 必须用 `run.sh`（内部 `env -u ELECTRON_RUN_AS_NODE`）。窗口默认 `opacity:0` 不可见（见 §1.4），但必须保持 `show:true` 才能让 macOS 合成器持续出帧、`capturePage` 稳定。
- **K15（采样性能）**：逐帧 `helper.update(1/30)` 是 O(帧号)，93.6s 的 wavefile 采样到 f2800 也只是秒级（每 case 端到端约 1.5–5s，含 PMX 加载）；不要图省事用 `setTime` 快进（K1）。
- **K16（版本 pin）**：r171 的 `MMDLoader`/`MMDAnimationHelper`/`MMDPhysics` 模块已打 deprecation 警告、**r172 移除**（迁移到 `three-mmd-loader`）——app 必须继续精确 pin `three@0.171.0`，升级 three 会直接断掉 MMD 支持。

---

## 6. 对 app 集成的最小设计建议（供 Lead 决策；不改 `src/**`）

1. **独立 VMD 播放分支**：新建 `VmdPlayback`（渲染层，复用 `MMDLoader`/`MMDAnimationHelper`），与现有 B3 `PoseDriver` **互斥**：VMD 激活时 B3 停写受控骨（`helper.update` 会覆盖全部骨骼）。切换用 0.2–0.4s slerp 淡入淡出，或「先停 helper、B3 从当前姿态接管」。
2. **PMX 只加载一次**：VMD 只需再 `loadAnimation`，不要重复加载 PMX/贴图（本工具实测单次 PMX 加载 ~0.8s，贴图 20/20）。
3. **关键参数**：`helper.add(mesh, { animation: clip, physics: false })`；`helper.update(dt)` 用真实帧时间（30fps 渲染下 dt=1/30）；**不要**混用 `setTime` 跳帧（K1）。
4. **运动学后处理（每帧，按序）**：`helper.update` → 根位移归零/映射（センター）→ 贴地补偿（脚骨最低点）→ 表情写入（morphTargetInfluences）→ 材质 morph/描边（现有 A2 管线）。
5. **状态与素材建议**：Idle（3s 循环，观感最好）、Arms Down（静态自然站姿）优先；Taunt/Run 作为反应/移动候选；bear_walk 仅作「第三方动作可用性」参考（骨名覆盖低 + root motion + 穿地，需较多适配）；VPD 仅作静态姿势导入通道。
6. **验证闭环**：继续用本工具 + `gen-evidence.sh` 出接触表/兼容性清单做回归；每次换动作包先看 `compatibility.md` 的「动作本体必需骨覆盖」与「脚底/センター」，再看 4 视角接触表。

---

## 7. 复现与证据索引

- 一键复现（12 case）：`./scripts/anim-pipeline/preview/gen-evidence.sh`
- 工具自测（不依赖外部素材）：`./scripts/anim-pipeline/preview/run.sh --synthetic`、`--synthetic-vpd`
- 证据目录：`tests/tmp/preview/<case>/`（gitignore；本批 13 case：Idle、Taunt、Run_Lfoot、ArmsDown、bear_walk、bear_walk-side、bear_walk-ik-off、vpd-01、vpd-05、vpd-09、synthetic-vpd、synthetic-vmd、wavefile_v2）
- 每个 case 含 `contact-sheet.png` / `frames/*.png` / `metadata.json` / `compatibility.md` / `index.md` / `run.log`；
- 全部运行 `PREVIEW_OK`（无失败），合计 **198 张逐帧透明 PNG + 13 张接触表**；
- 关键示例：`tests/tmp/preview/Idle/contact-sheet.png`（10 帧 × front/side/45）、`tests/tmp/preview/bear_walk-side/contact-sheet.png`（16 帧连续 side，脚掌滚动）、`tests/tmp/preview/bear_walk-ik-off/contact-sheet.png`（IK 关闭后腿冻结的对照）、《compatibility.md》里每 case 的自动结论。

---

## 8. 边界与已知限制

- **只写**：`scripts/anim-pipeline/preview/`、`docs/research/vmd-preview-tool.md`、`tests/tmp/preview/`；未改 `src/**`、`package.json`、`PLAN.md`、其他 docs；未 commit。
- 模型/动作二进制只在 `tests/tmp/`（gitignore）与 `assets/model/`（gitignore）中，未进入 tracked 路径。
- 动作文件授权：只本机个人自用、不得再分发（见 `docs/research/motion-assets.md`）；reze-rig 转换产物是 Mixamo/UE/Unity 样例动作的派生数据，同样只本机验证用。
- 预览器与 app 的**观感差异**（用于评估动作本身，不用于像素级验收）：预览器**无描边**（app 有屏幕空间自适应描边）、**透视 30°** 相机（app 是正交）、固定三向光（非 app 灯位）、无背景/无桌面合成、30fps 采样逐帧截图。
- 未验证：MMDPhysics（本工具显式 `physics:false`）、MMD 相机/灯光帧播放（与本工具无关）、VMD IK 段的「逐帧开关 IK」实现（r171 需自研封装）。
