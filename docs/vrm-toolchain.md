# VRM 工具链（Blender + VRM Add-on for Blender）— W0-2

> 状态：**✅ 已完成并实测**（2026-11-08，macOS 27 arm64，Blender 4.2.23 LTS 无头模式）。
> 适用：Phase 3 的 V2（PMX→VRM 转换）、V3（动作管线）、V5（戏浪接入）以及后续任何无头 VRM 导入/导出。
> 本文只记录工具链安装与无头导出；**模型渲染/观感验证归 W0-4 / Wave 1**，不在本文范围。

---

## 0. TL;DR

| 事项 | 结论 |
|---|---|
| VRM 导出插件 | **VRM Add-on for Blender（扩展名 "VRM format"）v4.10.4**，extension 形式装在 Blender 4.2 |
| 一键安装（幂等） | `scripts/vrm/install-vrm-addon.sh` |
| 无头导出 dummy VRM | `scripts/vrm/export-dummy-vrm.py` → `tests/tmp/w0-2/dummy.vrm` |
| 证据 | `tests/tmp/w0-2/`（gitignored，含安装日志、导出日志、GLB 校验报告） |
| 关键结论 | Blender 4.2 用 **extension**（不是 legacy addon）安装方式；VRM 1.0 由 armature 的 `spec_version` 决定；无头脚本内必须显式 `addon_enable` |

复跑（在仓库根目录）：

```bash
BL="/Volumes/4TB外置盘/deepseek-harness/tools/blender/Blender.app/Contents/MacOS/Blender"

scripts/vrm/install-vrm-addon.sh                       # 幂等安装/校验 addon
"$BL" --background --factory-startup --python scripts/vrm/export-dummy-vrm.py   # 导出 + 自校验
```

---

## 1. 版本与路径表

| 组件 | 版本 / 标识 | 位置 | 许可（上游 manifest SPDX） |
|---|---|---|---|
| Blender | **4.2.23 LTS**（build hash `d0cbe84903e8`，branch `blender-v4.2-release`，build date 2026-07-21） | `.../tools/blender/Blender.app/Contents/MacOS/Blender` | GPL（Blender 本体） |
| Blender 内置 Python | 3.11.7 | Blender.app/Contents/Resources/4.2/python | — |
| MMD Tools | **4.5.14**（extension，id `mmd_tools`，`blender_version_min = 4.2.0`） | `~/Library/Application Support/Blender/4.2/extensions/user_default/mmd_tools` | `SPDX:GPL-3.0-or-later` |
| **VRM Add-on for Blender（VRM format）** | **4.10.4**（extension，id `vrm`，module `bl_ext.user_default.vrm`，`blender_version_min = 4.2.0` / `blender_version_max = 5.3.0`） | `~/Library/Application Support/Blender/4.2/extensions/user_default/vrm` | `SPDX:MIT` + `SPDX:GPL-3.0-or-later` |
| VRM addon 版本来源 | 官方仓库 [saturday06/VRM-Addon-for-Blender](https://github.com/saturday06/VRM-Addon-for-Blender) release `v4.10.4`（2026-11-04） | — | — |
| VRM addon 安装包 | `VRM_Addon_for_Blender-Extension-4_10_4.zip`（1,649,935 B） | 下载缓存 `~/Library/Caches/aventurine-vrm-tools/`（仓库外） | — |
| **sha256（已 pin）** | `a711da721878d319a76eaaf9dc72c40de6b96d4ed95766f30666ecf7ae492f5b` | 同上 | — |
| Node / pnpm | v24.21.0 / 10.20.0 | PATH | 用于 GLB 校验（无新增依赖） |

> 交叉核对：GitHub release 资产与 [extensions.blender.org 的 VRM format 4.10.4](https://extensions.blender.org/add-ons/vrm/versions/)
> 下载的是**同一个文件**（size 与 sha256 完全一致），两条来源均可用；安装脚本默认走 GitHub release（可 pin 直链）。

legacy 资产（仅 Blender ≤4.1 用，本机不用）：

| 资产 | 大小 | sha256 |
|---|---|---|
| `VRM_Addon_for_Blender-4_10_4.zip`（legacy addon，module `io_scene_vrm`） | 1,652,510 B | `51bbf2725d5f52d9f8cc6d85323b5a4bec285679925f61f5ac5cc1353424325f` |

---

## 2. 安装（幂等）——`scripts/vrm/install-vrm-addon.sh`

### 2.1 行为

1. 定位 Blender：`BLENDER_BIN` 环境变量 > 默认路径 > PATH 里的 `blender`；找不到时给出清晰报错。
2. 判断 Blender 是否支持 `--command extension`（≥4.2）：
   - **支持** → 下载并校验 extension zip → `--command extension install-file -r user_default -e <zip>`；
   - **不支持**（≤4.1）→ 自动 fallback 到 legacy 资产 + `bpy.ops.preferences.addon_install/addon_enable(module="io_scene_vrm")`。
3. 下载缓存在仓库外：`~/Library/Caches/aventurine-vrm-tools/`（可用 `VRM_ADDON_CACHE_DIR` 覆盖）；先写 `.part`，**sha256 校验通过才落位**。
4. 已安装且 manifest 版本 == pin 版本时**跳过下载与安装**（幂等，第二次运行约 2 s、退出码 0）。
5. 每次都验证：`extension list` 中 `vrm [installed]`，以及无头 `--factory-startup` 下真实 `addon_enable` 并打印版本 / 导入导出算子是否存在。
6. 日志追加写 `tests/tmp/w0-2/install-vrm-addon.log`。

### 2.2 复跑命令

```bash
BL="/Volumes/4TB外置盘/deepseek-harness/tools/blender/Blender.app/Contents/MacOS/Blender"

scripts/vrm/install-vrm-addon.sh                                  # 默认路径
BLENDER_BIN="$BL" scripts/vrm/install-vrm-addon.sh                # 显式指定
scripts/vrm/install-vrm-addon.sh 2>&1 | tee tests/tmp/w0-2/install-run.log
```

首次运行关键输出（实测）：

```
[download] OK size=1649935 bytes sha256=a711da721878d319a76eaaf9dc72c40de6b96d4ed95766f30666ecf7ae492f5b
STATUS Installed "vrm"
  mmd_tools [installed]: "MMD Tools", ...
  vrm [installed]: "VRM format", VRM import, export and editing capabilities
VRM_ADDON_MODULE=bl_ext.user_default.vrm
VRM_ADDON_VERSION=4.10.4
VRM_ADDON_EXPORT_OP=export_scene.vrm
VRM_ADDON_IMPORT_OP=import_scene.vrm
VRM_ADDON_ENABLE=OK
```

第二次运行（实测，幂等）：

```
[skip] v4.10.4 已安装 (manifest: .../extensions/user_default/vrm/blender_manifest.toml), 跳过下载与安装
VRM_ADDON_ENABLE=OK
```

### 2.3 检查扩展列表 / 手动排查

```bash
BL="/Volumes/4TB外置盘/deepseek-harness/tools/blender/Blender.app/Contents/MacOS/Blender"

"$BL" --command extension list        # 应看到 vrm [installed] 与 mmd_tools [installed]
"$BL" --command extension remove vrm  # 卸载（重装用；注意会同时禁用）
```

> `extension list` 会先打印一行 `[Errno 2] .../extensions/blender_org not found, sync required!`——
> 这是官方 registry 尚未 sync 的提示，**不影响** `user_default` 扩展，退出码仍为 0。

---

## 3. 无头导出 dummy VRM ——`scripts/vrm/export-dummy-vrm.py`

### 3.1 行为

1. 显式启用 addon（`bl_ext.user_default.vrm`，legacy 名 `io_scene_vrm` 兜底），因此 `--factory-startup` 也能跑。
2. 清空默认场景 → 建 15 根骨的简化 **T-pose** humanoid 骨架（hips/spine/head、左右 upper/lower arm+hand、左右 upper/lower leg+foot）。
3. `armature.data.vrm_addon_extension.spec_version = "1.0"`（**VRM 1.0 的唯一开关**），映射 15 个 humanoid 骨，写 VRM 1.0 meta。
4. cube 用 `Armature modifier + 顶点组 spine(weight=1.0)` 蒙皮，并 **parent 到 armature object**。
5. `bpy.ops.export_scene.vrm(filepath=..., armature_object_name=...)` 导出。
6. 导出后立即解析 GLB JSON 自校验（magic=glTF、`extensionsUsed` 含 `VRMC_vrm`、`specVersion=="1.0"`、`humanBones>=5`），报告写 `tests/tmp/w0-2/dummy-vrm-check.json`；失败退出码非 0。

### 3.2 复跑命令

```bash
BL="/Volumes/4TB外置盘/deepseek-harness/tools/blender/Blender.app/Contents/MacOS/Blender"

# 文档要求的直接运行方式：
"$BL" --background --factory-startup --python scripts/vrm/export-dummy-vrm.py

# 更严格（Blender 默认吞掉 Python 异常仍然 exit 0；加 flag 保证失败可见）：
"$BL" --background --factory-startup --python-exit-code 1 --python scripts/vrm/export-dummy-vrm.py

# 留档：
"$BL" --background --factory-startup --python scripts/vrm/export-dummy-vrm.py 2>&1 \
  | tee tests/tmp/w0-2/export-dummy-vrm.log
```

可选环境变量：`DUMMY_VRM_OUT_DIR`、`DUMMY_VRM_OUT`、`DUMMY_VRM_CHECK`（默认都落在 `tests/tmp/w0-2/`）。

### 3.3 实测输出（2026-11-08）

```
[dummy-vrm] addon_enable(bl_ext.user_default.vrm) OK
[dummy-vrm] armature: 15 bones
[dummy-vrm] humanoid: 已映射 15 根骨 (spec_version=1.0)
[dummy-vrm] cube: 已蒙皮到 spine 骨 (...)
[dummy-vrm] export OK size=8740 bytes
[dummy-vrm] check magic_is_gltf: OK
[dummy-vrm] check extensions_used_has_vrmc_vrm: OK
[dummy-vrm] check spec_version_is_1_0: OK
[dummy-vrm] check human_bones_ge_min: OK
[dummy-vrm] humanBones: 15
[dummy-vrm] DUMMY_VRM_CHECK=OK
```

产物：`tests/tmp/w0-2/dummy.vrm`（8,740 B，GLB；`extensionsUsed=["VRMC_vrm"]`、`specVersion="1.0"`、
15 humanoid bones、1 mesh、1 skin、1 material、0 animation）。
（文件小是正常的：无贴图/无动画。模型带贴图时体积主要来自内嵌 PNG。）

### 3.4 独立的 Node 校验（无新增依赖，可粘进任何 CI）

```bash
node -e '
const fs=require("fs");
const b=fs.readFileSync(process.argv[1]);
const magic=b.toString("ascii",0,4);
const g=JSON.parse(b.toString("utf8",20,20+b.readUInt32LE(12)));
const vrm=g.extensions?.VRMC_vrm;
const hb=Object.keys(vrm?.humanoid?.humanBones??{});
console.log(JSON.stringify({magic,extensionsUsed:g.extensionsUsed,specVersion:vrm?.specVersion,humanBones:hb.length}));
if(magic!=="glTF") throw new Error("magic != glTF");
if(!(g.extensionsUsed||[]).includes("VRMC_vrm")) throw new Error("extensionsUsed 缺 VRMC_vrm");
if(vrm?.specVersion!=="1.0") throw new Error("specVersion != 1.0");
if(hb.length<5) throw new Error("humanBones < 5");
console.log("DUMMY_VRM_NODE_CHECK=OK");
' tests/tmp/w0-2/dummy.vrm
```

输出：`magic="glTF"`、`extensionsUsed=["VRMC_vrm"]`、`specVersion="1.0"`、`humanBones=15`、`DUMMY_VRM_NODE_CHECK=OK`。

---

## 4. 已知坑（实测踩过/验证过）

### 4.1 Blender 4.2：extension 与 legacy addon 是两条路

- v4.10.4 release 同时提供两个资产：
  - `VRM_Addon_for_Blender-Extension-4_10_4.zip`：**extension 包**（含 `blender_manifest.toml`，`id = "vrm"`，module `bl_ext.user_default.vrm`）。**Blender ≥4.2 用这个**，安装命令：
    `"$BL" --command extension install-file -r user_default -e <zip>`
  - `VRM_Addon_for_Blender-4_10_4.zip`：legacy addon（`io_scene_vrm`），给 Blender 2.93–4.1，用
    `bpy.ops.preferences.addon_install(filepath=...)` + `addon_enable(module="io_scene_vrm")`。
- 在 4.2 上装 legacy 包会落到 `scripts/addons/`，与 extension 体系并存且能用 `--command extension` 管理不了，容易双份启用冲突 → **4.2 明确只装 Extension 包**。
- module 名不同：extension = `bl_ext.user_default.vrm`；legacy = `io_scene_vrm`。无头脚本里两个候选名依次 try 最稳。

### 4.2 `--factory-startup` 不加载用户的启用状态

`--factory-startup` 会跳过用户 preferences，即使 GUI 里已启用，脚本里也**必须**显式：

```python
bpy.ops.preferences.addon_enable(module="bl_ext.user_default.vrm")   # extension
# legacy fallback: bpy.ops.preferences.addon_enable(module="io_scene_vrm")
```

### 4.3 Blender 默认吞掉 Python 异常，退出码仍是 0 ⚠️

实测：`--python-expr "raise RuntimeError('boom')"` 在不加参数时 **exit 0**；加 `--python-exit-code 1` 才是 1。
（`SystemExit(1)` 例外，它本身能带出退出码——本仓库 `export-dummy-vrm.py` 已把未捕获异常统一转成 `SystemExit(1)`。）
**所有 CI/脚本里跑 Blender 无头任务，建议一律加 `--python-exit-code 1`。**

### 4.4 extension registry 未 sync 的 warning

`--command extension list` 首行会报 `.../extensions/blender_org not found, sync required!`，但命令 exit 0、
`user_default` 的扩展照常列出。**不要**为了消 warning 去跑 `extension sync`（本方案不需要在线 registry）；
安装走 `install-file` + 本地/缓存 zip，完全绕开 registry 状态。

### 4.5 用户扩展目录不能靠环境变量搬走

v1 已实测：`BLENDER_USER_CONFIG` / `BLENDER_USER_SCRIPTS` 不能把 extension repo 挪到别处（仍写用户目录）。
所以脚本按平台探测 `~/Library/Application Support/Blender/<4.2>/extensions/user_default`（Linux 为
`~/.config/blender/<ver>/extensions/user_default`），并支持用 `VRM_ADDON_LOG_DIR`/`VRM_ADDON_CACHE_DIR` 控制日志与缓存。

### 4.6 `install-file` 没有 `--force`

同 id 换版本时若直接 install-file 可能冲突：脚本在检测到已装版本 ≠ pin 版本时，先
`"$BL" --command extension remove vrm` 再装。

### 4.7 VRM 1.0 vs VRM 0.x：由 armature 的 `spec_version` 决定，**没有** `vrm_version` 导出参数

```python
armature.data.vrm_addon_extension.spec_version = "1.0"   # "0.0" / "1.0" / "KHR_character"
```

导出算子 `bpy.ops.export_scene.vrm` 只读 armature 扩展的 `spec_version` 选 `Vrm1Exporter` / `Vrm0Exporter`。
新建 armature 默认就是 `"1.0"`，但**显式设置**能避免导入/迁移资产时的意外。

### 4.8 VRM 1.0 导出前的**最低要求**（dummy 已逐条验证）

| 要求 | 说明 |
|---|---|
| 1 个 Armature（object 在场景中） | 导出对象收集默认导出可见对象；可显式传 `armature_object_name` |
| humanoid 骨映射 | VRM 1.0 必需骨：hips、spine、head、左右 upper/lower arm、左右 upper/lower leg（本 dummy 映射 15 根） |
| 至少 1 个 mesh 蒙皮到该骨架 | `Armature modifier` + 顶点组名=骨名；**mesh 必须是 armature 的子物体**，否则 glTF 导出会 warning：`Armature must be the parent of skinned mesh...`（仍会导出，但按名字猜骨架，多骨架/实例场景不可靠） |
| 至少 1 个材质 | Principled BSDF 即可；要 MToon 需显式 `material.vrm_addon_extension.mtoon1.enabled = True` |
| VRM 1.0 meta | 至少 `vrm_name` / `version` / `authors`（不填会落默认值，建议显式写全 avatar_permission / allow_redistribution 等，因为这是私有资产） |
| T-pose | VRM 1.0 规范要求 humanoid 静止姿态为 T-pose；非 T-pose 资产可用 `bpy.ops.vrm.make_estimated_humanoid_t_pose(armature_object_name=...)` 估计或 `apply_humanoid_t_pose` 应用 |
| 贴图 | 导出时内嵌进 GLB；贴图路径失效会丢图（V2 要检查 `images_missing`） |

### 4.9 导出算子常用参数（默认全 False）

`export_invisibles` / `export_only_selections` / `export_all_influences` / `export_lights` /
`export_gltf_animations` / `export_try_sparse_sk` / `enable_advanced_preferences`。
无头模型导出建议：`export_gltf_animations=False`（动作由 V3 单独产出 VRMA/glTF）、
`export_try_sparse_sk=True`（29k 顶点模型减小体积）、`armature_object_name=<骨架对象名>`（避免歧义）。

### 4.10 无头不需要 GUI/GPU

`--background` 下导入/导出/建骨都是纯 CPU 操作（本 W0-2 全部实测通过）。只有**渲染**（四视图/截图）才涉及
渲染引擎设置；macOS 上 `--background` 渲染 v1 已实测可出图（见 `docs/research/tooling-blender.md` §3）。

### 4.11 缓存/版本策略

- 版本 **pin 在脚本里**（`VRM_ADDON_VERSION` + `VRM_ADDON_EXT_SHA256`），升级需改两处并重跑实测。
- 下载缓存在 `~/Library/Caches/aventurine-vrm-tools/`（仓库外，不入 git）；`tests/tmp/w0-2/` 里保留一份
  安装包 + `SHA256SUMS.txt` 作为证据（gitignored，可随时删）。

---

## 5. 现有 VRM 资产清单（仅元数据，未做渲染验证）

> 数据来源：直接解析 `.vrm`（GLB）的 JSON chunk，解析脚本见 `tests/tmp/w0-2/parse-vrm-assets.py`。
> **渲染/观感验证由 W0-4 负责**；本节只作为 V1/V2/V5 的输入事实。

### 5.1 canary（v1 遗留、下载的制服款）

| 项 | 值 |
|---|---|
| 路径 | `assets/vrm/canary/砂金石心十人公司制服(0.x).vrm`（gitignored，私有） |
| 大小 | 14,661,668 B ≈ 13.98 MiB（≈14.7 MB 十进制） |
| VRM 版本 | **VRM 0.x**（`extensionsUsed = ["KHR_materials_unlit", "VRM"]`，`exporterVersion = "Playbox"`） |
| humanoid 骨 | **51** |
| 材质 / 贴图 | **31 材质**（KHR_materials_unlit）/ **13 textures / 13 images** |
| 表情 | blendShapeGroups **24** |
| 物理 | `extensions.VRM.secondaryAnimation` 扩展块存在，但 `boneGroups=[]`、`colliderGroups=[]` —— **实际没有弹簧骨**（与戏浪一致：头发/衣摆需要 W2/V6 补 spring） |
| lookAt | **有**（VRM 0.x 的 `extensions.VRM.firstPerson.lookAtTypeName="Bone"`；three-vrm 归一化为 `VRMLookAtBoneApplier`）→ manifest `lookAt.mode='vrm'` |
| 朝向 | **面向 +Z**（W0-4 实测；VRM0 经 `VRMUtils.rotateVRM0` 归一后正确） |
| 动画 | animations **0** |
| 许可字段 | `allowedUserName=OnlyAuthor`、`licenseName=Redistribution_Prohibited` |
| 用途 | **W0-4 canary 查看器 / V1 渲染路径验证**（three-vrm 加载 MToon/unlit + 骨骼 + 动作） |

### 5.2 戏浪（用户 2026-11-08 新增，VRM 1.0）

| 项 | 值 |
|---|---|
| 路径 | 原始：`assets/vrm/星穹铁道—砂金·戏浪(1.0).vrm`（只读保留）；**W1.5-Tpose 重制版 `assets/vrm/aventurine-tpose.vrm`（manifest 当前引用）**；旧 W0-5/legfix 副本保留只读回滚（gitignored，私有）；重制流程/命令见 `docs/vrm-tpose-repair.md` |
| 大小 | 25,910,532 B ≈ 24.71 MiB（≈25.9 MB 十进制） |
| VRM 版本 | **VRM 1.0**（`extensionsUsed = ["VRMC_materials_mtoon", "KHR_materials_unlit", "VRMC_vrm"]`，`specVersion = "1.0"`） |
| humanoid 骨 | **52** |
| 材质 | **39**，全部带 `VRMC_materials_mtoon`（MToon 卡通材质） |
| 材质缺陷 | **29/39 `alphaMode=BLEND`**（27 个 baseColor alpha≈1、颜赤 alpha=0、目影 alpha=0.3）、39/39 `doubleSided=true`、29/29 BLEND 带 `transparentWithZWrite=true` → 透明 pass + outline clone 叠加产生局部 ghost/排序瑕疵（W0-4 `?forceOpaque=1` 实测仅 3.75% 像素变化；**发白主因是贴图/光照，不是 alphaMode**）。V2 重导建议 α≈1 材质设 OPAQUE，V6 做材质/光照调优 |
| 朝向 | **面向 -Z**（W0-4 实测；VRM 1.0 约定 +Z）→ manifest 已设 `yawOffsetDeg=180` |
| 加载坑 | `珍珠` 材质的 `shadeMultiplyTexture` 是非法空引用 `{}`，直接 GLTFLoader.parse 会抛错。**W0-5 已修**：`scripts/vrm/patch-vrm-gltf.mjs` 生成修复副本（删非法引用 + 27 个 α≈1 BLEND→OPAQUE，39=37+2），three-vrm 实测直接加载 0 patch；V1 loader 仍应内置 `patchVrmGlbBuffer` 防御 |
| 贴图 | textures **20** / images **20** |
| 表情 | expression preset **12**：`aa/angry/blink/blinkLeft/blinkRight/ee/happy/ih/neutral/oh/ou/surprised` |
| 物理 | **无 `VRMC_springBone`**（头发/衣摆无弹簧物理） |
| lookAt | **无**（`VRMC_vrm.lookAt` 缺失） |
| 动画 | animations **0** |
| 场景结构 | nodes 383 / meshes 1 / skins 1 / materials 39 |
| meta | `name=星穹铁道—砂金·戏浪`、`version=2.000000`、`avatarPermission=everyone`、`commercialUsage=personalNonProfit`、`allowRedistribution=false`、`modification=allowModificationRedistribution`、`creditNotation=unnecessary`、`licenseUrl=https://vrm.dev/licenses/1.0/` |
| 附注 | 同目录有源包 `星穹铁道—砂金·戏浪(1.0) (1).zip`（23,142,027 B），仅备份，不随 app 分发 |

**对后续 Wave 的影响（V2/V5/V6 需评估）**：

1. **无 springBone**：头发/衣摆不会随动作摆动。V2 转换管线应为 aventurine.vrm 生成 spring 链；若先用戏浪直接上主链（V5），需 three-vrm 侧程序化摆动兜底（V6）。
2. **无 lookAt**：three-vrm 不会自动眼睛跟随；注视行为（§10 验收项之一）需手动驱动眼骨/或用 expression，或在 V2 补 `VRMC_vrm.lookAt`。
3. **无 animations**：所有动作（idle/walk/sit/pat/drag/salute）都依赖 V3 产出的 glTF/VRMA + `@pixiv/three-vrm-animation` 播放，不能指望模型自带。
4. **MToon 齐全**：39 个材质全部 MToon，three-vrm 3.5.5 可直接渲染，无需材质转换。
5. **许可/私有**：`allowRedistribution=false`，且版权归 miHoYo；仅本地使用，遵守 D6 私有资产策略。

---

## 6. 给 V2（PMX→VRM 转换）的无头命令骨架

> 目标：`assets/vrm/aventurine.vrm`（VRM 1.0，29k 顶点不爆、20+ 表情、spring 链、贴图 0 缺失）。
> 下面是 W0-2 已验证事实 + addon API 推导出的骨架；V2 需在此基础上实测/调参。

### 6.1 调用方式

```bash
BL="/Volumes/4TB外置盘/deepseek-harness/tools/blender/Blender.app/Contents/MacOS/Blender"

"$BL" --background --factory-startup --python-exit-code 1 \
  --python scripts/vrm/convert-pmx-to-vrm.py -- \
  --pmx assets/model/<模型>.pmx --out assets/vrm/aventurine.vrm \
  2>&1 | tee tests/tmp/v2-convert.log
```

### 6.2 脚本骨架（伪代码，基于 v4.10.4 实测 API）

```python
import bpy

# 0) 启用两个 extension（--factory-startup 下必须显式 enable）
for module in ("bl_ext.user_default.vrm", "bl_ext.user_default.mmd_tools"):
    bpy.ops.preferences.addon_enable(module=module)

# 1) 清空场景
for obj in list(bpy.data.objects):
    bpy.data.objects.remove(obj, do_unlink=True)

# 2) MMD Tools 导入 PMX（参数与 v1 实测一致，见 docs/research/tooling-blender.md §2.2）
bpy.ops.mmd_tools.import_model(
    filepath=str(PMX),
    types={"MESH", "ARMATURE", "MORPHS", "DISPLAY"},   # 不需要 PHYSICS/MORPHS? 需要表情则保留 MORPHS
    scale=0.08,                 # PMX 21.68 单位 → ~1.73 m
    rename_bones=False,         # 必须: 保住 PMX 日文/原名，VPD/VMD 与 three 才对应
    clean_model=True,
    remove_doubles=False,
)

armature = next(o for o in bpy.context.scene.objects if o.type == "ARMATURE")
armature_data = armature.data

# 3) VRM 1.0 + humanoid 映射
armature_data.vrm_addon_extension.spec_version = "1.0"
bpy.ops.vrm.assign_vrm1_humanoid_human_bones_automatically(
    armature_object_name=armature.name
)
# addon 内置 MMD 日文骨名词典 (common/human_bone_mapper/mmd_mapping.py):
#   センター→hips, 上半身→spine, 上半身2→chest, 頭→head,
#   左/右腕→upper arm, ひじ→lower arm, 手/手首→hand,
#   足→upper leg, ひざ→lower leg, 足首→foot, つま先/足先EX→toes, 手指骨等
# 仍需逐骨检查 required bones 是否齐全；未命中时手动补:
#   hb = armature_data.vrm_addon_extension.vrm1.humanoid.human_bones
#   hb.left_upper_arm.node.bone_name = "左腕"      # 手填 PMX 骨名
#   hb.hips.node.bone_name = "センター"
#   ... 注: _dummy_* / _shadow_* 辅助骨不在词典, 自动映射不会选中

# 4) T-pose（VRM 1.0 规范要求；PMX 静止姿态可能非 T）
bpy.ops.vrm.make_estimated_humanoid_t_pose(armature_object_name=armature.name)
bpy.ops.vrm.apply_humanoid_t_pose(armature_object_name=armature.name)  # 需按实际观感决定是否调用

# 5) spring 链（addon 无 MMD 物理→VRM spring 直接转换器；VRM0 资产才可用
#    bpy.ops.vrm.assign_spring_bone1_from_vrm0）
sb = armature_data.vrm_addon_extension.spring_bone1
spring = sb.springs.add()
spring.vrm_name = "hair_L"
joint = spring.joints.add()
joint.node.bone_name = "左髪1"        # 逐节 add() 成链；joint.node 是 BonePropertyGroup
joint.stiffness = 1.5
joint.gravity_power = 0.1
joint.gravity_dir = (0.0, 0.0, -1.0)  # Blender 坐标, 默认朝下
joint.drag_force = 0.5
joint.hit_radius = 0.02
# 碰撞体: sb.colliders.add() / sb.collider_groups.add()，可从 PMX 刚体
# (MMD Tools types 里加 "PHYSICS" 导入) 映射 sphere/capsule

# 6) 表情: MMD morph → VRM1 expression
bpy.ops.vrm.assign_vrm1_expressions_from_mmd(armature_object_name=armature.name)
# 自定义表情（20+ 目标）:
#   bpy.ops.vrm.add_vrm1_expressions_custom_expression(armature_object_name=..., expression_name="...")
#   bpy.ops.vrm.add_vrm1_expression_morph_target_bind(...)

# 7) meta
meta = armature_data.vrm_addon_extension.vrm1.meta
meta.vrm_name = "Aventurine"
meta.version = "1.0.0"
meta.authors.add().value = "..."

# 8) 导出 VRM 1.0（spec_version=1.0 已决定 VRM1）
bpy.ops.export_scene.vrm(
    filepath=str(OUT_VRM),
    armature_object_name=armature.name,
    export_gltf_animations=False,
    export_try_sparse_sk=True,
)
```

### 6.3 V2 必须自测/注意的点

1. **骨数**：v1 实测 PMX 导入后 **434 骨**（382 PMX + 26 `_dummy_*` + 26 `_shadow_*`）。humanoid 只需 ~54 根，别把辅助骨映射进去；`assign_vrm1_humanoid_human_bones_automatically` 后再人工核对。
2. **朝向/尺寸**：PMX 导入后面朝 **-Y**（Blender 前视图），包围盒约 1.28×0.35×1.73 m（scale=0.08）；导出后 three-vrm 的朝向/贴地由 V5 再校。
3. **顶点/材质**：32,828 顶点、39 材质、83 morph、23 贴图（v1 数据）；`export_try_sparse_sk=True` 可压体积；导出后检查贴图 0 缺失。
4. **T-pose**：VRM1 规范硬要求；估计的 T-pose 会改静止姿态，**先渲染四视图确认观感**再做（W0-4/V2 的 Blender 四视图流程见 v1 文档 §3）。
5. **spring**：MMD 物理模型（刚体/关节）在 `types` 里加 `"PHYSICS"` 才导入；从刚体链生成 VRM spring 是 V2 的主要工作量之一。
6. **表情**：`assign_vrm1_expressions_from_mmd` 之后检查 12 个 preset 是否齐 + 自定义 20+ 绑定到 morph target。
7. **导出校验**：复用 W0-2 的 GLB JSON 校验思路（specVersion、humanBones 数、`VRMC_springBone` 是否存在、`VRMC_materials_mtoon` 材质数、animations 应为 0），并检查文件体积/贴图嵌入。

---

## 7. 证据与复跑清单

`tests/tmp/w0-2/`（gitignored，验收留档）：

| 文件 | 说明 |
|---|---|
| `install-run1.log` | 从零安装全流程（下载 + sha256 + install-file + 无头启用） |
| `install-run2-idempotent.log` | 第二次运行，跳过下载/安装、exit 0 |
| `install-vrm-addon.log` | 安装脚本内部追加日志（两次运行累计） |
| `export-dummy-vrm.log` | 无头导出 dummy VRM 全流程日志 |
| `dummy.vrm` | 导出的 VRM 1.0（8,740 B） |
| `dummy-vrm-check.json` | 内嵌 GLB 校验报告（magic/extensionsUsed/specVersion/humanBones counts） |
| `verify-dummy-vrm-node.log` | 独立 Node 解析校验输出（`DUMMY_VRM_NODE_CHECK=OK`） |
| `acceptance.log` | 最终验收三连跑（install → export → node verify）合并日志，三个步骤 exit 0 |
| `VRM_Addon_for_Blender-Extension-4_10_4.zip` + `SHA256SUMS.txt` | pinned 安装包与校验和（两份来源交叉核对） |
| `parse-vrm-assets.py` | 第 5 节资产元数据的解析脚本（只读 GLB JSON） |

复跑顺序（任一台机器上，需 Blender 4.2.23 + 网络）：

```bash
BL="/Volumes/4TB外置盘/deepseek-harness/tools/blender/Blender.app/Contents/MacOS/Blender"
scripts/vrm/install-vrm-addon.sh
"$BL" --command extension list
"$BL" --background --factory-startup --python scripts/vrm/export-dummy-vrm.py
node -e '/* 见 §3.4，或直接看 tests/tmp/w0-2/verify-dummy-vrm-node.log */'
```

---

## 8. 遗留 / 风险

| 项 | 说明 | 归属 |
|---|---|---|
| 资产渲染验证 | 本文只有 GLB JSON 元数据，没有打开模型看观感/材质/骨骼 | **W0-4**（canary 查看器） |
| 戏浪缺 spring/lookAt/animations | 见 §5.2，需在 V5/V6 决定「直接可用 or 补」 | V5/V6（W0-4 数据支撑） |
| T-pose 估计效果 | `make_estimated_humanoid_t_pose` 对 PMX 的实际效果未在 W0-2 验证 | V2 |
| MMD 物理→VRM spring | addon 无直接转换器；需从 PMX 刚体/关节映射 | V2 |
| addon 升级 | 版本 sha256 pin 在脚本里；升级需改 `VRM_ADDON_VERSION`/`VRM_ADDON_EXT_SHA256` 并重跑 smoke | 后续维护 |
| registry 未 sync | `--command extension list` 首行 warning 属正常；不影响 `user_default` | 无需处理 |
| 戏浪 VRM 腿部/rest/T-pose（W1.5 实测） | ① 腿骨原映射到控制骨而权重在 MMD 形变骨、腿链父链经 spine → 已用 `fix-vrm-humanoid-legs.mjs` 修（legfix 版）；② 旧资产 rest 是 A-pose（手臂下斜 39.6°）且面向 -Z → 阻断了手/臂动画。W1.5-Tpose 用 VRMify 从 PMX 重转规范 T-pose（面向 +Z，付与骨合并、MMD 物理→SpringBone），GT 同模型 ΔW 102°→3.44°；详见 `docs/vrm-tpose-repair.md` | 已修（W1.5-Tpose）；manifest 已切到新资产 |
