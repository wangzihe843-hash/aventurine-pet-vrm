# Blender 可视化姿态调参 / 渲染对照 / VPD 导出回路（实测报告）

> 任务：Wave 2 程序化姿态观感失败的根因是「缺参考 + 缺可视化调参工具」。本报告记录**实际搭起并验证**的
> Blender → 渲染对照 → VPD → three.js 回灌回路，不是方案推演。
>
> 环境：macOS 27.0.1 (26A434) / Apple Silicon arm64 / 磁盘 3.4 TiB 可用 / Node v24.21.0 / pnpm 10.20.0。
> 实测日期：2026-11-08。模型：`assets/model/optimized/星穹铁道—砂金·戏浪.pmx`（私有、gitignore，仅本地）。
> 所有工具安装在仓库外 `/Volumes/4TB外置盘/deepseek-harness/tools/`，未使用 sudo / Homebrew。

## 0. 一页结论

| 项 | 结论 | 证据 |
|---|---|---|
| Blender 安装 | ✅ **Blender 4.2.23 LTS macOS arm64**，命令行 `--background` 可用；dmg 从官方镜像下载（download.blender.org 直连 403） | `tests/tmp/blender-probe/env.txt` |
| MMD Tools | ✅ **v4.5.14（release 资产 `-bl4.2`）**，作为 extension 安装并启用；`blender_version_min = 4.2.0` | `env.txt`、扩展列表 |
| PMX 导入 | ✅ 无头导入成功：**434 骨**（PMX 382 + 26 根附加 `_dummy_*` 辅助骨 + 26 根 `_shadow_*` 影子骨）、32,828 顶点、39 材质、83 个形态键、23 张贴图 **0 缺失** | `report.json` |
| 四视图渲染 | ✅ Workbench 正交四视图（front/side/3-4/back）在 macOS `--background` **真实出图**，约 0.2 s/张；贴图/材质正常 | `front.png`…`back.png`、`contact-sheet.png` |
| Cycles CPU 兜底 | ✅ 可出图（1.2 s @512×768/32spp），但**必须先 `mmd_tools.convert_materials_for_cycles`**，否则材质近黑；面部 overlay（目影/颜赤）仍与视口不同 | `cycles-test/front.png` |
| 摆姿闭环 | ✅ pose JSON（骨旋转+平移+表情权重）→ 同机位前后对比图；VPD 导出后 roundtrip 最大角误差 **0.04°**、平移误差 **0** | `posed-*.png`、`report.json` |
| **VPD ↔ three r171** | ✅ **可消费**（bone-only VPD）：真实 `three@0.171.0` 的 `parseVpd` 解析成功、5 根骨名全部命中 PMX、按 `helper.pose` 数学回放与 Blender 姿态最大误差 **9.8e-8 m** | `vpd-compat-check.json` |
| VPD 三坑（实测） | ① 含 `Morph` 块 → `parseVpd` 抛 `the file seems not vpd file.`；② 科学计数法（`8.7e-05`）同样会抛；③ 编码是 cp932，`loadVPD` 必须 `isUnicode=false` | `vpd-compat-check.json` |
| dsh-blender-plugin | ⚠️ 理论可用（要求正是 Blender 4.2 LTS；无头模式只需可执行文件），**未安装**（需用户批准）；须显式配 `blenderExe` | 见 §7 |
| SekaiBlender | ❌ 不适用：仅 Windows x64 构建，Blender 5.3 分支，无 macOS 产物 | 见 §8 |

可复用脚本：`scripts/anim-pipeline/blender/`；渲染/校验证据：`tests/tmp/blender-probe/`（gitignore）。

## 1. 安装 Blender 4.2 LTS（无 sudo、无 Homebrew）

一次性安装脚本：`scripts/anim-pipeline/blender/install-blender.sh`。实际执行过的命令与踩坑如下。

### 1.1 下载源：download.blender.org 直连 403

`https://download.blender.org/release/Blender4.2/` 与具体文件都返回 **HTTP 403 + Cloudflare challenge**
（`cf-mitigated: challenge`），换浏览器 UA 无效。改用官方镜像（同一份字节）：

```bash
# 当前 4.2 LTS 最新 = 4.2.23（镜像目录列出 4.2.0 … 4.2.23）
curl -L --fail -o blender-4.2.23-macos-arm64.dmg \
  https://mirrors.dotsrc.org/blender/release/Blender4.2/blender-4.2.23-macos-arm64.dmg
# 备选镜像 https://ftp.nluug.nl/pub/graphics/blender/release/Blender4.2/...
shasum -a 256 blender-4.2.23-macos-arm64.dmg
#  8b6bc5fafd4773e94bb863ca19ba1c9a54d096eecbbc4375eae7dbc3b49fab40
```

> 经验：单连接从 nluug 拉 300 MB 会被限速到 ~0.1 MB/s；dotsrc 分段并发（6 段 range + cat 拼接）约 1 分钟。
> hdiutil 挂载后 CRC32 验证通过（`已验证CRC32 $9689EE50`）。

### 1.2 挂载与安装（hdiutil 的坑）

```bash
# ❌ 失败：把 mountpoint 指到外置盘目录会 “attach failed - 权限被拒绝”
hdiutil attach -nobrowse -readonly -mountpoint /Volumes/4TB外置盘/.../mnt-blender xxx.dmg
# ✅ 自动挂载到默认 /Volumes/Blender（或 diskutil image attach --mountPoint /tmp/... 也可）
hdiutil attach -nobrowse -readonly blender-4.2.23-macos-arm64.dmg
ditto /Volumes/Blender/Blender.app /Volumes/4TB外置盘/deepseek-harness/tools/blender/Blender.app
hdiutil detach /Volumes/Blender -force
```

- 安装位置：`/Volumes/4TB外置盘/deepseek-harness/tools/blender/Blender.app`（815 MB），可执行文件
  `.../Contents/MacOS/Blender`。
- Gatekeeper：curl 下载无 quarantine 位，只有 `com.apple.provenance`；`xattr -dr com.apple.quarantine`
  作为保险（no-op），未触发弹窗/被杀。
- 验证：`"$BL" --version` → `Blender 4.2.23 LTS, build hash d0cbe84903e8, branch blender-v4.2-release`。

## 2. MMD Tools 安装与 PMX 导入验证

### 2.1 版本与来源

- GitHub API 配额已耗尽（HTTP 403 rate limit），改用 **releases 页面 HTML + 直链**，无需 API：
  `https://github.com/MMD-Blender/blender_mmd_tools/releases/download/v4.5.14/mmd_tools-v4.5.14-bl4.2.zip`
  （仓库已迁移到 **MMD-Blender** 组织；资产名后缀 `-bl4.2` 即适配 Blender 4.2）。
- 该 zip 是 **extension 包**（含 `blender_manifest.toml`，`blender_version_min = "4.2.0"`，带 opencc wheel），
  用 Blender 官方 CLI 安装（会正确处理 wheels）：

```bash
BL="/Volumes/4TB外置盘/deepseek-harness/tools/blender/Blender.app/Contents/MacOS/Blender"
"$BL" --command extension install-file -r user_default -e mmd_tools-v4.5.14-bl4.2.zip
# STATUS Installed "mmd_tools" / Info: Preferences saved
"$BL" --command extension list   # → mmd_tools [installed]
```

- 安装目录：`~/Library/Application Support/Blender/4.2/extensions/user_default/mmd_tools`。
  **注意**：`BLENDER_USER_CONFIG` / `BLENDER_USER_SCRIPTS` 不能把这层 extension repo 搬到别处（实测仍写用户目录）；
  脚本运行时用 `--factory-startup` + `bpy.ops.preferences.addon_enable(module="bl_ext.user_default.mmd_tools")`
  显式启用即可，不依赖用户 preferences 状态（已验证去掉两个环境变量也能跑）。
- 无头脚本里的启用写法（两个候选名兜底）：

```python
try:    bpy.ops.preferences.addon_enable(module="bl_ext.user_default.mmd_tools")
except: bpy.ops.preferences.addon_enable(module="mmd_tools")
```

### 2.2 导入参数（关键：保住 PMX 日文骨名）

```python
bpy.ops.mmd_tools.import_model(
    filepath=PMX, types={"MESH", "ARMATURE", "MORPHS", "DISPLAY"},
    scale=0.08, rename_bones=False, clean_model=True)
```

- **`rename_bones=False` 必须**：默认 True 会把 L/R 骨改名成 `腕.L` 等，VPD 骨名就对不上 PMX/three 了。
  MMD Tools 的 `mmd_bone.name_j` 保存原始日文名，VPD 导出用它。
- `types` 不含 `PHYSICS`（284 刚体/318 关节对本回路无意义，跳过可提速；需要时加 `--with-physics`）。
- 导入耗时 ~0.7 s。

### 2.3 实测数据（证明「贴图/材质/骨骼正常」）

| 项 | 数值 |
|---|---|
| 骨骼 | **434** = PMX 382 根 + MMD Tools 附加 **26 根 `_dummy_*`**（D 链/捩骨/眼控辅助骨）+ **26 根 `_shadow_*`**（影子骨，VPD/VMD 导出时按 `is_mmd_shadow_bone` 自动跳过）；PMX 内重名骨 `后碎髮9` 在 Blender 里第二根被改名为 `后碎髮9.001` |
| 顶点 / 面 | 32,828 / 51,829 |
| 材质 | 39 |
| 形态键（morph） | 83（PMX 85 个表情里 82 顶点 morph + 3 材质 morph，材质 morph 不成形态键） |
| 图片 | 23 张（20 张模型贴图 + 模型自带 toon3/4；另有 3 张 MMD Tools 内置 toon01/05/07.bmp），`images_missing = 0` |
| 包围盒 | 1.279 × 0.348 × 1.734 m（按 0.08 缩放；PMX 原始 21.68 单位高） |
| 朝向 | 模型面朝 **-Y**（Blender 前视图方向），与 MMD Tools 的坐标转换一致 |

关键骨骼抽查：`頭`、`センター`、`左腕`、`左足ＩＫ`、`全ての親` 全部存在且名字与 PMX 一致。

## 3. 无头四视图渲染（macOS `--background` 真正出图）

脚本：`scripts/anim-pipeline/blender/render_views.py`。

```bash
"$BL" -b --factory-startup --python scripts/anim-pipeline/blender/render_views.py -- \
  --pmx "$PWD/assets/model/optimized/星穹铁道—砂金·戏浪.pmx" \
  --out "$PWD/tests/tmp/blender-probe" \
  --views front,side,three-quarter,back
```

实现要点：

- **Workbench**：`scene.render.engine='BLENDER_WORKBENCH'`，`shading.color_type='TEXTURE'`（直接显示 MMD 漫反射贴图）、
  `light='STUDIO'`、开 cavity/shadows；正交相机按包围盒自动取景（`ortho_scale = 1.18 × max(size)`）。
- **方向定义**（模型面朝 -Y）：`front` 相机在 -Y；`side` 在 +X（角色左侧）；`three-quarter` 在
  (+sin45, -cos45)；`back` 在 +Y。
- **实测性能**：768×1024 PNG，首张 0.52 s、后续 **0.18–0.21 s/张**；整条回路（导入+4 视图+摆姿 2 视图+VPD+roundtrip）**2.6 s**。
- 结论：**macOS 背景下 Workbench 真能出图**，不是黑图/空图（已用 `read_image` 逐张自检；模型完整、贴图正确、
  A-pose 站姿正常）。证据：`front.png`、`side.png`、`three-quarter.png`、`back.png`、`contact-sheet.png`。

### 3.1 坑：渲染背景是黑的

`scene.display.shading.background_type='VIEWPORT'` + `background_color` 在 `--background` 下不够，
最终渲染会吃 world 颜色。同时设置：

```python
world = scene.world or bpy.data.worlds.new("World"); scene.world = world
world.use_nodes = False; world.color = (0.22, 0.23, 0.26)   # → 深灰背景
```

### 3.2 Cycles CPU 兜底（`--engine cycles`）

- 默认 MMD 卡通材质在 Cycles 下**近黑**；必须先 `bpy.ops.mmd_tools.convert_materials_for_cycles(use_principled=True,
  clean_nodes=True)`（脚本已自动调用），并开降噪。
- 转换后 39 个材质可用，512×768 / 32spp / CPU 约 **1.2 s**（user 9 s，多核并行）。
- 局限：面部叠加片（`目影`、`颜赤` 等半透明 overlay）与视口/游戏内观感不同，**姿态迭代仍以 Workbench 为准**，
  Cycles 仅用于光照/材质 QA。证据：`tests/tmp/blender-probe/cycles-test/front.png`。

## 4. 摆姿闭环（改数字 → 出图）

```bash
"$BL" -b --factory-startup --python scripts/anim-pipeline/blender/render_views.py -- \
  --pmx "$PWD/assets/model/optimized/星穹铁道—砂金·戏浪.pmx" \
  --out "$PWD/tests/tmp/blender-probe" \
  --views front,side,three-quarter,back \
  --pose scripts/anim-pipeline/blender/poses/example-pose.json \
  --pose-views front,three-quarter \
  --vpd-out "$PWD/tests/tmp/blender-probe/pose-test.vpd" \
  --vpd-strip-morphs --dump "$PWD/tests/tmp/blender-probe/pose-dump.json" \
  --report "$PWD/tests/tmp/blender-probe/report.json"
```

示例 `poses/example-pose.json`：

```json
{
  "bones": {
    "頭": { "rot": [5, 12, 0] },
    "左腕": { "rot": [40, 0, 20] },
    "左ひじ": { "rot": [30, 0, 0] },
    "右腕": { "rot": [-25, 0, -10] },
    "センター": { "loc": [0, -0.06, 0] }
  },
  "morphs": { "笑い": 0.45 }
}
```

- `rot` = 度、XYZ 欧拉、Blender 骨骼局部空间；`loc` = 米、骨骼局部平移；`morphs` = PMX 表情权重（按名匹配）。
- 效果：`posed-front.png` / `posed-three-quarter.png` 与 rest 图同机位对比，手臂/头部/重心变化清晰可见
  （见 `contact-sheet.png` 第 5、6 格）。
- 建议工作流：**先用本回路粗摆**出 8–10 个核心姿态的「视觉基准」，再回填 app 的 PoseDef 数字；
  每改一轮用 contact sheet 对照。Blender 姿态与 app 内程序化姿态的坐标系换算见 §6.3。

## 5. VPD 导出格式与 three.js r171 兼容性（核心）

### 5.1 MMD Tools 实际导出的格式（实测）

`bpy.ops.mmd_tools.export_vpd(filepath, scale=12.5, pose_type='CURRENT')`：

- `scale` 默认 12.5 = `1 / import_scale(0.08)`：把 Blender 米制换算回 MMD 单位。
  **导入/导出 scale 必须互为倒数**，否则姿态位置整体缩放错。
- 只导出 `matrix_basis != identity` 的骨（本例 5 根）；骨名取 `pose_bone.mmd_bone.name_j or name`，即 **PMX 原名**。
- 有非零表情权重时，文件尾部追加 MikuMikuMoving 的 `Morph` 块。
- 编码 **cp932（Shift-JIS 超集）**、CRLF、注释形如 `// trans x,y,z`。实测文件（节选）：

```
Vocaloid Pose Data file

星穹?道?砂金??浪.osm;		// 親ファイル名
5;				// 総ポーズボーン数

Bone0{センター
  0.0,0.75,0.0;				// trans x,y,z
  0.0,0.0,0.0,1.0;		// Quaternion x,y,z,w
}

Bone3{左腕
  0.0,0.0,0.0;				// trans x,y,z
  -0.147500678896904,-0.08975551277399063,0.3373301327228546,0.9254165887832642;		// Quaternion x,y,z,w
}
...
Morph0{笑い
  0.45;				// weight
}
```

> 注：第 3 行的模型名是中文「星穹铁道—砂金·戏浪」，cp932 无法编码 → 被替换为 `?`（MMD Tools 用
> `errors="replace"`）。该行只是 parentFile 元数据，three 不使用，不影响姿态。

### 5.2 three r171 的消费路径（源码）

- `MMDLoader.loadVPD(url, isUnicode, onLoad)`：`isUnicode=false` 时 `mimeType='text/plain; charset=shift_jis'` →
  `parser.parseVpd(text, true)`（**第二个参数恒为 true**：leftToRight 坐标转换在 parser 内完成）。
- `MMDParser.parseVpd(text, true)`：
  - 第 1 行必须严格等于 `Vocaloid Pose Data file`；
  - 第 3/4 行是 parentFile / boneCount；
  - 骨块 `Bone<N>{<骨名>` / `tx,ty,tz;` / `qx,qy,qz,qw;` / `}`；
  - 数值正则 **只接受普通小数**：`-?[0-9]+\.[0-9]+`（正负号可选，必须含小数点且前后都有数字）；
  - `leftToRightVpd`：`translation.z *= -1`；`quaternion.x *= -1; quaternion.y *= -1`（z/w 不变）。
- `MMDAnimationHelper.pose(mesh, vpd, params)`：
  - 默认先 `mesh.pose()` 重置为 bind pose（`resetPose:false` 可关）；
  - **`bone.position.add(vpd.translation)`、`bone.quaternion.multiply(vpd.quaternion)`**——translation 是相对
    rest 的**偏移**，quaternion 是**乘算**；
  - 默认 `ik:true, grant:true`：随后会跑 CCD IK 与 grant 解算（会把 VPD 没写的 IK 链/捩骨再算一遍）。
    要与 Blender 姿态 **1:1 对齐**，用 `helper.pose(mesh, vpd, { ik: false, grant: false })`。
  - 注意：app 的 `MMDAnimationHelper` 在每帧 `helper.update()` 里会 `_restoreBones + IK + grant` 覆盖手工姿态
    （`src/renderer/src/scene/pet-scene.ts` 的注释也记录了这个事实），见 §6.2 的接线建议。
- 骨名匹配是 **name → bone index 字典**，VPD 里不存在的名字**静默跳过**（不报错）——所以「骨名对不上」只会
  表现为「某截没动」，必须用校验脚本兜住。

### 5.3 本项目的实测结论（`verify_vpd.mjs`，用真实 three@0.171.0）

| 检查 | 结果 |
|---|---|
| 编码识别 | `shift_jis`（cp932）→ 对应 `loadVPD(url, /* isUnicode */ false)` |
| 原始 VPD（含 Morph 块）`parseVpd` | ❌ 抛 `the file seems not vpd file.`（Morph 块的 `}` 触发解析器抛错） |
| `-boneonly.vpd`（去掉 Morph 块）`parseVpd` | ✅ 成功，5 根骨 |
| 骨名覆盖 | ✅ 5/5 命中 PMX 骨表（`unknownNames: []`） |
| **语义回放**（复刻 `MMDLoader` 骨架构建 + `helper.pose` 的 add/multiply，与 Blender 世界骨头位置对比） | ✅ 最大误差 **9.76e-8 m**（相对 1.73 m 高模型 = 浮点级一致） |
| 科学计数法陷阱（注入 `1e-05` 做合成测试） | ❌ 同样抛 `the file seems not vpd file.`（正则拒绝 `e` 记数法） |
| CRLF 头字段 | `parseVpd` 因 `\r\n` 被拆成 `\r`/`\n` 两个分隔，parentFile/boneCount 解析成 `""`/`NaN`；**只影响 metadata，不影响骨块应用** |

→ **结论：MMD Tools 导出的 bone-only VPD 可以被 three r171 的 `MMDLoader.loadVPD` + `helper.pose` 直接消费，
姿态语义与 Blender 完全一致。** 但必须绕开 Morph 块与科学计数法两个格式坑。

### 5.4 回灌建议（app 侧，未改代码）

三个可选接法，按侵入性从小到大：

1. **（推荐）离线 VPD → PoseDef JSON 烘焙**：在开发期用本目录的 Node 校验脚本把 VPD 解析成
   `Map<骨名, {x,y,z} 度>`，人工/脚本挑出 `CONTROLLED_BONES` 白名单内的骨，写成
   `src/renderer/src/animation/poses/*.ts` 里的 `PoseDef`（契约见 `animation/types.ts`：
   骨名 → 局部欧拉偏移，单位度）。运行期零解析/零依赖，可 diff、可单测，符合 survey §4.2 的 W1+W5 主路线。
   转换要点：`parseVpd(text, true)` 之后四元数已在 three 骨骼局部空间（PMX 骨无 rest rotation，局部轴 = 世界轴），
   取 `THREE.Euler`（注意 B3 使用的旋转顺序/符号）即可；`translation` 对应 `センター` 等根的局部偏移。
2. **运行期 `loadVPD`**：`pet-asset://` 协议已能服务任意 `assets/model/optimized/**` 文件（加一个 `.vpd` 文件即可，
   注意 gitignore 与打包 extraResources 白名单）；`loader.loadVPD(url, false, vpd => helper.pose(mesh, vpd, {ik:false, grant:false}))`。
   但必须在 B3 `poseDriver.update()` 写骨之后、或在与 `helper.update()` 互斥的分支里执行，否则会被每帧
   `_restoreBones` 覆盖；更稳的做法是把它作为「base pose」并在 B3 混合前写入。
3. **VPD → 极小 VMD/AnimationClip**（若能接受转一道格式）：交给 `MMDAnimationHelper` 作为动画播放，
   天然兼容 helper 的每帧流程；但会多一层转换工具，暂不推荐。

表情：VPD 的 `Morph` 块 three 不认，且本模型材质 morph（`照れ`/`目影消`/`目影濃`）本来就需要
app 侧 `MaterialMorphController` 处理 → **表情继续走 app 内 morph 通道**，VPD 只管骨骼。

## 6. dsh-blender-plugin 接入评估（未安装，只给结论）

仓库：`sixtysevenlf/dsh-blender-plugin`（BSD-3，README 自述；已 `git clone --depth 1` 到仓库外 `tools/dsh-blender-plugin` 评估）。
版本：plugin **3.0.6**（`node >= 24.9`，本机 24.21 ✅）；自带 Blender addon **`addon/dsh_blender_bridge.zip`**
（legacy addon，`bl_info.blender = (4, 2, 0)`，v1.11 / protocol 11，端口 `127.0.0.1:9876`，HTTP `9877`）。

结论：**与这份 Blender 4.2.23 兼容，可以接入，分两条路：**

- **无头路线（不装 addon）**：插件文档明确「无头模式只需要能找到 Blender 可执行文件」；
  验收判据是 `blender_rt_worker(op="start")` + `op="see"` 返回一帧。这正是本报告 §3 已验证的
  Workbench 背景出帧能力。
  - 配置方式（三选一，按 `docs/配置参考.md`）：环境变量 `DSH_BLENDER_EXE=<Blender 可执行路径>`、
    `blenderExe` 字段（`dsh-blender.config.json`）、或自动探测。
  - **注意**：插件自动探测只覆盖 `/Applications/Blender*.app`、`~/Applications/...`、`/Volumes/*/Applications/...`，
    我们的 Blender 在 `/Volumes/4TB外置盘/deepseek-harness/tools/blender/Blender.app` **不在探测范围**，
    必须显式配置：`export DSH_BLENDER_EXE="/Volumes/4TB外置盘/deepseek-harness/tools/blender/Blender.app/Contents/MacOS/Blender"`。
- **GUI 路线**：把 `addon/dsh_blender_bridge.zip` 装进 Blender 并启用，再 `dsh plugin add dsh-blender-plugin@3.0.6`
  （需要用户批准；本任务未执行）。装好后 `curl -sS http://127.0.0.1:9877/doctor` 必须 `kind=ok` 才算成功。
  风险：该 addon 上游是 `ahujasid/blender-mcp` 的改名版（MIT），macOS 上未实测；端口 9876 与其他 Blender MCP 类
  addon 冲突（不要同时装 `MCP for Blender` / `blender_mcp`）。

**价值判断**：它能给的是「持久无头 worker + 回帧 + 长任务」，与本目录脚本互补——
脚本适合确定性批处理（四视图/摆姿/VPD 一次性命令），插件适合「边看边改」的交互式调参。
建议 Wave 3 若要做 GUI 摆姿面板，先走无头路线 + 本目录脚本，暂不引入插件依赖。

## 7. SekaiBlender 对比（用户点名评估）

`ShiJieWorld/SekaiBlender`：MMD 特化 **Blender 源码分支**（原生 PMX/VMD、CCD IK V8、物理、渲染），
最新 release `SekaiBlender-v1.0`，README 明确 **Prebuilt Windows x64 包**（`...-windows64.zip`，~329 MB），
Blender 版本为 **5.3**，无 macOS 构建。

→ 对本机（macOS arm64）**不可用**：要么从源码在 macOS 编译整套 Blender 5.3 分支（小时级 + 依赖 Xcode，
远超本任务预算，且 5.3 与我们已验证的工具链/插件（4.2 LTS）不兼容），要么接受 Windows 虚拟机（无）。
**保持 vanilla Blender 4.2 + MMD Tools（已验证）** 是当前唯一稳妥路线；SekaiBlender 可作为「如果将来有 Windows
机器」的备选，不阻塞。

## 8. 长期用法与验收流程

### 8.1 推荐工作流

1. **姿态生产**：`poses/*.json` 手写/脚本生成 → `render_views.py` 出四视图 + 前后对比（~3 s/轮）。
2. **视觉验收**：`make_contact_sheet.py` 拼 contact sheet → AI/human `read_image` 一次看完；
   与「角色设定三视图/参考图」对照，检查轮廓、比例、穿模、重心、脚底贴地（本模型 A-pose 脚底 z≈0）。
3. **数据回填**：满足观感后导出 bone-only VPD（或直接用 pose JSON 数值）；
   用 `verify_vpd.mjs` 过一遍（骨名/解析/语义），确认 three r171 能消费。
4. **app 侧落地**：按 §5.4 转成 `PoseDef`（推荐）或运行期 `loadVPD`；表情/材质 morph 仍走 app 通道。
5. **回归**：每次改 pose 数字后重跑 `verify_vpd.mjs`，把 contact sheet 作为证据留在 `tests/tmp/`（不提交模型/VPD）。

### 8.2 「参考图三视图对照 + 接触表」验收清单

- [ ] 四视图齐（front/side/three-quarter/back），模型完整、无黑图/空图/贴图缺失；
- [ ] 与角色参考三视图并排：头身比、肩宽/腰线、手脚长度、发饰/衣摆位置对得上；
- [ ] 摆姿前后对比图：目标关节确实转动、无异常扭曲/翻转（尤其父骨旋转后的子骨）；
- [ ] 脚底贴地（站姿）或明确的支撑/悬空关系；
- [ ] 接触表标注了 pose 版本/参数，能与 `poses/*.json` 对应；
- [ ] VPD 校验 `pass: true`，骨名 100% 命中 PMX，roundtrip/语义回放误差在容差内。

## 9. 风险、未覆盖与后续建议

| 风险/未覆盖 | 说明与缓解 |
|---|---|
| 私有资产授权 | 模型/贴图属 miHoYo，仅本地自用，禁止进 git/二次分发；VPD/PNG 同为派生产物，只放 `tests/tmp/`（已 gitignore） |
| three r171 VPD 的 Morph 块 | 已实测不兼容；用 `--vpd-strip-morphs` 生成 bone-only，表情单独走 app |
| 科学计数法 | MMD Tools 写原始 float，极小值（<1e-4）可能写成 `8.7e-05` → three 正则拒绝；校验脚本会数并可用合成用例复现；出现时对 VPD 做十进制格式化（或直接转 PoseDef JSON，不受该限制） |
| 骨名歧义 | PMX 内存在重名骨（本例 `后碎髮9` 有 2 根）；VPD 按名匹配，three 取最后一个 → 避免直接摆这类骨 |
| `_dummy_*` / `_shadow_*` 骨 | MMD Tools 附加的辅助骨（26+26 根），VPD 里这些名字不在 PMX → three 静默跳过；只摆 PMX 原名骨（`_shadow_*` 导出时会被 MMD Tools 自动跳过） |
| helper 覆盖 | `helper.update()` 每帧 restore/IK/grant；VPD 姿态必须并入 B3 poseDriver 或每帧在 helper 之后应用 |
| Blender 用户扩展目录 | MMD Tools 扩展装在 `~/Library/Application Support/Blender/4.2/extensions/`（不在仓库、无法用环境变量搬走）；团队复现需各自跑 `install-blender.sh` |
| 物理 | 本回路不导入刚体/关节（`--with-physics` 可选）；头发/衣摆物理仍待 B2/后续，VPD 只存骨骼姿态 |
| dsh-blender-plugin | 未安装（需用户批准）；macOS 上的 GUI addon 未实测，无头路线依赖 `DSH_BLENDER_EXE` 显式配置 |

后续可做（不阻塞）：① 把 `render_views.py` 的 pose JSON 扩展成「与 app `PoseDef` 同构」的格式，做到
「Blender 里调 → 直接生成 `poses/*.ts`」的一步回填；② 给 contact sheet 增加参考图列（三视图）对比模式；
③ 若要动画而不只是静姿，评估 MMD Tools 的 VMD 导出/导入（three 原生支持 VMD）作为次级运动通道。

## 10. 证据索引与命令速查

```bash
TOOLS=/Volumes/4TB外置盘/deepseek-harness/tools
BL="$TOOLS/blender/Blender.app/Contents/MacOS/Blender"
cd /Volumes/4TB外置盘/deepseek-harness/aventurine-pet

# 1) 四视图
"$BL" -b --factory-startup --python scripts/anim-pipeline/blender/render_views.py -- \
  --pmx "$PWD/assets/model/optimized/星穹铁道—砂金·戏浪.pmx" --out "$PWD/tests/tmp/blender-probe" \
  --views front,side,three-quarter,back
# 2) 摆姿 + VPD（含 bone-only）
"$BL" -b --factory-startup --python scripts/anim-pipeline/blender/render_views.py -- \
  --pmx "$PWD/assets/model/optimized/星穹铁道—砂金·戏浪.pmx" --out "$PWD/tests/tmp/blender-probe" \
  --views front,side,three-quarter,back \
  --pose scripts/anim-pipeline/blender/poses/example-pose.json --pose-views front,three-quarter \
  --vpd-out "$PWD/tests/tmp/blender-probe/pose-test.vpd" --vpd-strip-morphs \
  --dump "$PWD/tests/tmp/blender-probe/pose-dump.json" --report "$PWD/tests/tmp/blender-probe/report.json"
# 3) three r171 兼容性校验
node scripts/anim-pipeline/blender/verify_vpd.mjs \
  --pmx "$PWD/assets/model/optimized/星穹铁道—砂金·戏浪.pmx" \
  --vpd "$PWD/tests/tmp/blender-probe/pose-test.vpd" \
  --vpd-boneonly "$PWD/tests/tmp/blender-probe/pose-test-boneonly.vpd" \
  --dump "$PWD/tests/tmp/blender-probe/pose-dump.json" \
  --out "$PWD/tests/tmp/blender-probe/vpd-compat-check.json"
# 4) 接触表
python3 scripts/anim-pipeline/blender/make_contact_sheet.py \
  --dir tests/tmp/blender-probe --out tests/tmp/blender-probe/contact-sheet.png
```

证据文件（均在 `tests/tmp/blender-probe/`，gitignore）：

- `env.txt` — 版本/路径/sha256/安装命令/扩展状态
- `report.json` — 导入+渲染+VPD+roundtrip 结构化结果
- `vpd-compat-check.json` — three r171 兼容性（编码/骨名/Morph/科学计数法/语义回放误差）
- `front.png` `side.png` `three-quarter.png` `back.png` — 四视图
- `posed-front.png` `posed-three-quarter.png` — 摆姿前后对比
- `contact-sheet.png` — 6 格接触表
- `pose-test.vpd` / `pose-test-boneonly.vpd` / `pose-dump.json`
- `cycles-test/front.png` — Cycles CPU 兜底出图
