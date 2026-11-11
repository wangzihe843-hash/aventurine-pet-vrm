# 水枪永久挂到右手：Blender 离线烘焙进 VRM 1.0 的可行性与操作方案

> 范围：`砂金·戏浪` PMX→VRM 已转换（只有身体、39 材质、无武器），动作走 VRMA/Unity humanoid 重定向。本文只回答「**如果拿到水枪网格（或自己做一个），如何把它永久烘焙进 VRM，使所有 humanoid 动作播放时跟随右手**」，并给出 VRM 1.0 规范依据、Blender 4.2 + VRM Add-on for Blender 4.10.4 可操作步骤、校验方法、风险。
>
> 私有游戏资产仅本机开发使用，**不上传、不公开、不二次配布**；本文所有链接均为公开文档/规范。
>
> 证据分级：`[official]` = VRM 规范 / Blender 官方 / VRM addon 官方文档；`[source]` = 本机安装的 Blender 4.2.23 与 addon 4.10.4 源码逐行核对；`[local]` = 本仓库资产/文档实测；`[community]` = 社区教程（方法稳定但非权威）。

---

## 0. Lead 复核补充（2026-11-09 晚，优先读）

> 本文件写作时假设「水枪网格需另找/新建」。同期 Lead 已在本机找到并提取：`.max` 全场景 FBX（pilot）内含 `0009_Weapon`（4642 顶点/4508 面）+ `Gun_*`/`prop_JNT` 武器骨，贴图与本地 `assets/model/水枪.png` 同一张；已产出 `assets/props/watergun/watergun.glb`（米制、贴图内嵌）+ `meta.json` + 提取脚本 `scripts/props/extract-watergun.py`（详见 [`watergun-prop-plan.md`](watergun-prop-plan.md) §1）。
>
> **决策变化**：V1 **不采用烘焙**，改用「运行时挂点」（`watergun-runtime-attach.md` / plan §2–§3），原因是空手动作会与永久持枪冲突、且改模型成本高。本文的规范依据（VRM 1.0 允许 humanoid 骨下挂 mesh/子节点、VRMA 不驱动非 humanoid 节点）与 Blender 步骤**仍然有效**，保留作为「永久持枪展示变体 / 将来并进 VRM」的备用方案；§2 流程可直接复用已提取的 GLB。

---

## 0. 一页结论

| 问题 | 结论 |
|---|---|
| VRM 1.0 能否在 `rightHand` 下挂一个**非蒙皮普通 Mesh** 子节点并导出？ | **能，且是官方教程同款做法** `[official]`。VRM Add-on 官方「Create Humanoid VRM」教程就是用 `Parent=Armature / Parent Type=Bone / Parent Bone=hand.L` 把方块挂到手骨上再导出 VRM 的。VRM 1.0 规范**没有**「humanoid 骨节点不能有 mesh/子节点」的限制，唯一硬约束是 T-pose 下**所有节点 scale 必须是正数且均匀**。 |
| 导出后 three-vrm 是否保留该节点、能否被 VRMA 带动？ | **保留，且自动跟随**。three-vrm 把整棵 glTF 场景作为 `vrm.scene`，humanoid 只是对 raw 节点的引用；`humanoid.update()` 每帧把 normalized 骨姿态写回 raw 骨，武器作为 raw `右手首` 节点的子节点随场景图矩阵自动更新。**VRMA 本身不驱动武器**（规范只允许 humanoid 骨轨道），跟随是场景图效应。 |
| 推荐主方案 | **方案 B：水枪作为普通 Mesh（无 armature modifier、无权重）`Parent to Bone = 右手首`，Keep Transform，直接导出 VRM 1.0。** 改动最小、官方文档验证过、无需动 skin。 |
| 更正统的备选 | **方案 A：新增 `weapon_r` 骨（parent = 右手首），水枪 100% 权重到 `weapon_r`。** 等价于 MMD 的「权重到 手首 骨」，适合以后把武器并进身体网格 / 统一 skin / 想用骨名做开关。 |
| 不烘焙的对比 | **方案 C：独立 `watergun.glb` + 运行时 `getRawBoneNode('rightHand').add(gun)`。** 最灵活（可换/可隐藏/不重导 VRM），但不是「永久在 VRM 里」，且 app 不控制时武器消失；不适合本需求的主方案。 |
| 最大风险（产品层） | **永久持枪 = 所有空手动作也会拿枪**。建议节点命名 `Watergun`，运行时按 clip 白名单切 `node.visible`（或出「带枪 / 不带枪」两个 VRM 变体）。其次风险：握持点对齐、尺寸、材质（PMX 未引用 `水枪.png`，武器材质要新建）、两手持枪动作可能穿模。 |

---

## 1. 本机现状（只读核实，作为方案前提）

工具链（已安装并实测，见 `docs/vrm-toolchain.md`）`[local]`：

- Blender **4.2.23 LTS**（`.../tools/blender/Blender.app/Contents/MacOS/Blender`），安装脚本 `scripts/vrm/install-vrm-addon.sh`。
- **VRM Add-on for Blender 4.10.4**（extension `vrm`，module `bl_ext.user_default.vrm`），导出/导入算子 `bpy.ops.export_scene.vrm`、`bpy.ops.import_scene.vrm`。
- **MMD Tools 4.5.14**：`bpy.ops.mmd_tools.import_model(..., scale=0.08, rename_bones=False, clean_model=True)`（**`rename_bones=False` 必须**，否则日文骨名变 `腕.L`）。
- 运行时：`@pixiv/three-vrm 3.5.5` + `@pixiv/three-vrm-animation 3.5.5`、three 0.171。

当前 VRM（`assets/vrm/aventurine-tpose.vrm`）只读解析结果 `[local]`：

| 项 | 值 | 对本任务的意义 |
|---|---|---|
| humanoid 骨 | **53**（含 30 手指、toes、eyes） | 武器骨/节点**不得**映射进 humanoid |
| nodes / meshes / skins | 375 / **3（全部 skinned）** / 1 skin = **336 joints** | 336 joints 里只有 53 个是 humanoid 骨，**说明 283 个非 humanoid 骨节点已被导出器完整保留** → 再加 1 个武器骨不会被剥离 |
| `rightHand` 节点 | node **268**，名 `右手首`，children = `[283..287]`（右手指骨） | 人手骨节点本来就带多个子节点，**再挂一个武器子节点结构上完全同类** |
| 材质 / 表情 / spring | 39 MToon / 95 表达式 / 50 链 175 collider | 重导出时这些必须原样保留（见 §5 断言） |
| 朝向/单位 | VRM 1.0，+Z 面向用户，1.73 m 高 | 武器按米制对齐 |

PMX 源（`assets/model/星穹铁道—砂金·戏浪.pmx`）`[local]`：

- 382 根 PMX 骨 + 26 `_dummy_*` + 26 `_shadow_*`（MMD Tools 导入后 434），存在标准骨 **`右手首`**（以及 `右手捩/右手捩1..3/右手環1..5/指骨`、`左手首` 同理）。
- `水枪.png`（2048×2048，PNG 有效）**不在 PMX 里**：对 PMX 二进制搜 UTF-16LE 的 `水枪`、`水枪.png`、`武器` 均为 -1 命中 → 贴图是用户单独提供的，武器网格/材质/权重都必须**另行获得或新建**。
- 结论：本任务不是「打开开关」，而是「**先拿到网格 → 加进 VRM**」两段式；Lead 正在查 `.max` 全场景 FBX 是否含武器网格（见 §4.4）。

---

## 2. VRM 1.0 规范依据（逐条核实 + URL）

### 2.1 humanoid 骨只是「glTF Node 的映射」，没有「禁止子节点/网格」

`[official]` <https://github.com/vrm-c/vrm-specification/blob/master/specification/VRMC_vrm-1.0/humanoid.md>

- 规范把 humanoid 定义为 `humanBones: { rightHand: { node: <index> } }`，**没有任何一条要求 humanoid 骨节点不能有 mesh、不能有子节点、或必须是 skin joint**。
- 唯一明文的 transform 硬约束（原文）：
  > **Forbidden Transforms** — For transforms of humanoid bones, scale components MUST have positive values (zero is not permitted).
- 允许非 humanoid 骨节点存在（原文）：
  > It is permissible to have non-humanoid bone nodes between humanoid bones (for example, there are non-humanoid bone nodes between Upper Leg and Lower Leg).
- `Humanoid bones must be unique in VRM.` → 武器骨/武器节点**不要**映射进 humanoid，保持普通节点即可。

glTF 2.0 核心本身允许一个 node 同时有 mesh 和 children，也允许任意父子层级 `[official]`：<https://registry.khronos.org/glTF/specs/2.0/glTF-2.0.html#nodes>。

→ 所以「右手首 node 下挂一个 mesh node（或一个非 humanoid 骨 node）」在 VRM 1.0 里**合法**。

### 2.2 导出时真正的硬约束：T-pose + 所有节点正均匀缩放

`[official]` <https://github.com/vrm-c/vrm-specification/blob/master/specification/VRMC_vrm-1.0/tpose.md>

- > **Definition 2.1. All node transforms are on a positive uniform scale.** All node transforms must be in a positive uniform scale. A positive uniform scale means that each value of the scale is the same non-zero positive value.
- 外观定义（1.1–1.8）只针对腿、躯干、头、眼、双臂、手指的 T-pose 观感；**加一把水枪不改变身体 T-pose 的判定**，但武器节点自身必须满足：
  1. 不要在导出时用**负缩放/镜像**（用 Mirror Modifier 后 Apply）；
  2. mesh object 的 scale 尽量 Apply 成 `(1,1,1)`，或至少正且均匀；
  3. 武器在 T-pose（rest）下挂在手边即可，不必强行摆成「射击姿势」——rest 姿态只影响导出静态外观，不影响动画跟随。
- 另注：`[official]` VRMC_vrm README 明确 VRM 使用米制（glTF 坐标单位），且**不使用 animations/cameras** 字段；武器不要带自己的动画。

### 2.3 VRMA 为什么能「带动」武器——其实是场景图跟随

`[official]` <https://github.com/vrm-c/vrm-specification/blob/master/specification/VRMC_vrm_animation-1.0/README.md>

- VRMA 是**独立文件**（原文：`This extension is not expected to be included in VRM models with the VRMC_vrm extension.`），只描述 humanoid 骨动画：
  - 节点必须是 VRM T-pose 的 rest；
  - > The animation data for the Humanoid bone must not include scales for the Humanoid bone. Also, the animation for the Humanoid bone must not include translations for bones other than the Hips bone.
  - 采样率建议 30 fps。
- **VRMA 没有「非 humanoid 骨」轨道**（规范没有这个通道；addon 的 VRMA 导出也只导 humanoid 骨，见 addon issue #584 的讨论 `[community]` <https://github.com/saturday06/VRM-Addon-for-Blender/issues/584>）。因此：
  - ✅ 武器烘焙进 **VRM 模型**（不是 VRMA）后，播放任意 VRMA/自定义 humanoid clip 时，武器 = 右手首节点的子节点 → 世界矩阵随右手首变化 → **自动跟随**；
  - ❌ 不能「用 VRMA 单独给武器做动画」；要按 clip 显示/隐藏或摆动武器，只能在 app 层操作节点（`visible` / 额外 `AnimationMixer` 轨道 / springBone）。

### 2.4 three-vrm 加载行为（源码核对 `[source]`，`@pixiv/three-vrm@3.5.5`）

本机 `node_modules/.pnpm/@pixiv+three-vrm@3.5.5_three@0.171.0/.../three-vrm.module.js`：

- `VRM` 构造里 `this.scene = params.scene`（bundle L3112），`params.scene` 即 `gltf.scene` → **GLTFLoader 加载出的全部节点被原样保留**，three-vrm 不剔除未映射节点、不重建层级。
- `gltf.scene.add(humanoid.normalizedHumanBonesRoot)`（L2135）：normalized humanoid 骨是**额外挂**在场景根下的独立层级，raw humanoid 节点仍在原位置 → 我们挂在 raw `右手首` 下的武器仍在该层级里。
- `VRMHumanoid` 构造函数注释（L1848）：`autoUpdateHumanBones`：`Whether it copies pose from normalizedHumanBones to rawHumanBones on update. true by default.`；`update()` 即 `if (this.autoUpdateHumanBones) this._normalizedHumanBones.update();`（L2024 附近）→ **每帧 normalized→raw 同步**，raw `右手首` 子节点自然跟随。
- 本项目运行时确实调用 `humanoid.update()` / 每帧写 normalized（见 `docs/research/vrm-runtime-research.md` §2.2、`src/renderer/src/vrm/avatar-loader.ts`），并且把模型整体缩放到 CSS px 只影响 **SpringBone**（米制约束），对刚性武器无影响 → 烘焙方案在缩放窗口下也稳。

→ 运行时验证断言见 §5.3。

### 2.5 校验工具与导出期校验

- **VRM Add-on 导出前校验** `[source]`：`exporter/export_scene.py` 在导出前检查 `human_bones.bones_are_correctly_assigned()`（必需骨不齐会弹 `Required VRM Human Bones Assignment` / 拒绝导出）；导出选项有 `ignore_warning`（**不要为了跳过警告而勾它**）。本机 addon 源码：`~/Library/Application Support/Blender/4.2/extensions/user_default/vrm/exporter/export_scene.py`。
- **glTF 核心校验**：Khronos **glTF-Validator** `[official]` <https://github.com/KhronosGroup/glTF-Validator>（在线版 <https://github.khronos.org/glTF-Validator/>）。注意：VRM 扩展（`VRMC_vrm`/`VRMC_springBone`/`VRMC_materials_mtoon`）对它属于未知扩展，**只应关注 errors=0；扩展警告可忽略**。
- **UniVRM VRM10 校验器**（Unity Editor 内，人工终检可选）`[official]`：<https://github.com/vrm-c/UniVRM>。
- **本仓库已有可复用基线**：`scripts/vrm/export-dummy-vrm.py` 展示了「导出 VRM + 解析 GLB JSON chunk 做断言」的完整写法；`scripts/vrm/patch-vrm-gltf.mjs` 展示了只改 GLB JSON 不动 BIN 的先例（方案 D 的技术基础）。

---

## 3. 方案对比（先决策，再动手）

| # | 方案 | 改动 | 是否需重导 VRM | 跟随 humanoid 动作 | 能否按 clip 隐藏 | 维护性/风险 |
|---|---|---|---|---|---|---|
| **B（推荐主）** | 水枪普通 Mesh **Parent to Bone = 右手首**（Keep Transform），无 modifier/无权重 | 最小：1 个 object + 1 材质 | 是（一次） | ✅ 场景图跟随 | ✅ `node.visible` | 官方教程同款；但武器是**独立非蒙皮 mesh**（多 1 draw call）。glTF 导出器对 bone-parent 有专门处理（§4.2 证据），成熟 |
| **A（推荐备选）** | 新增 `weapon_r` 骨（parent=右手首）+ 水枪 100% 权重 | 中：+1 骨、+1 vertex group、armature modifier | 是 | ✅ 骨链跟随 | ✅ 骨节点/网格节点 visible | 最接近 MMD/游戏引擎「socket bone」心智；以后可 join 进身体、统一 skin、给武器加 spring。skin joints 336→337 |
| **C（运行时挂）** | 独立 `watergun.glb`，运行时 `vrm.humanoid.getRawBoneNode('rightHand').add(gun)` | 不改 VRM | 否 | ✅ | ✅ | 最灵活（换武器/热更/隐藏），但**不是永久烘焙**；app 不跑就没有武器；多一次资源加载/内存 |
| **D（直接 patch GLB）** | Node 脚本在 VRM 的 JSON+BIN 里手工插入 node/mesh/accessor/material | 高 | 否（改文件） | ✅ | ✅ | 本仓库有 `patch-vrm-gltf.mjs` 先例，但**手工拼 mesh buffer 容易错**；仅当无法运行 Blender 时的兜底，不建议 |

**取舍一句话**：
- 用户要的是「**永久**挂到右手」→ 选 **B**（最快）或 **A**（最正统）；两者导出结果等价（都是右手首节点的子树）。
- 若产品需要「空手动作不显示枪、持枪动作显示」→ 仍推荐烘焙 + 运行时 `visible` 白名单（**不要**用 `scale=0` 隐藏：违反 T-pose 正缩放约束的心智，且可能被校验器/下游工具标记）；或者干脆出两个 VRM 变体（`aventurine-watergun.vrm` / 现有无枪版）。
- 若 Lead 最终决定武器要能换（水枪/其他道具）→ 选 C。

---

## 4. 可操作 Blender 步骤清单

### 4.0 前置：在哪个工程里做？

两条路，按成本选：

1. **全流程重跑（推荐，一致性最好）**：在现有 PMX→VRM 转换脚本里「导入 PMX → 建 humanoid/T-pose/spring/expression」之后、「导出 VRM」之前插入武器步骤，重跑生成新 VRM。脚本骨架见 `docs/vrm-toolchain.md` §6.2（含 addon API：`vrm_addon_extension.vrm1.humanoid.human_bones`、`export_scene.vrm`）。
2. **现有 VRM 往返（快，30 分钟 spike 用）**：`bpy.ops.import_scene.vrm(filepath='assets/vrm/aventurine-tpose.vrm')` → 加武器 → `bpy.ops.export_scene.vrm(...)`。**风险**：往返可能轻微改动 MToon/expression/spring 数据 → 必须用 §5.2 断言逐项对比（53 humanoid / 95 expression / 50 spring 链 / 175 collider / 39→40 材质）。
   - 建议新文件命名 `assets/vrm/aventurine-watergun.vrm`，**不要覆盖**现有 `aventurine-tpose.vrm`（保持可回滚；manifest 待 Lead 验收后再改）。

通用无头调用（本仓库惯例）：

```bash
BL="/Volumes/4TB外置盘/deepseek-harness/tools/blender/Blender.app/Contents/MacOS/Blender"
"$BL" --background --factory-startup --python scripts/vrm/<your-script>.py
# 注意：Blender 默认吞掉 Python 异常且 exit 0；脚本里必须自己 fail-fast，见 docs/vrm-toolchain.md §4.3
```

### 4.1 拿到水枪网格（两种来源）

**来源 1：`.max` 全场景 FBX（Lead 在查）** → 见 §4.4 提取步骤。
**来源 2：没有网格时**：先做一个**尺寸正确的占位体（blockout）**把流程和运行时验证跑通（长度 ≈ 0.25 m、握把直径 ≈ 0.03 m），真实网格/贴图到位后只换 mesh+材质，不重做对齐（对齐方式见 4.2 第 4 步）。⚠️ 不要把 AI 生成网格/来路不明资产当最终产物；私有资产只在本机。

### 4.2 方案 B（主）：非蒙皮 Mesh 挂到 右手首 骨

对应官方教程步骤（`[official]` <https://vrm-addon-for-blender.info/en-us/create-humanoid-vrm-from-scratch/>，原文：*"set `Parent` to `Armature`, `Parent Type` to `Bone`, and `Parent Bone` to `hand.L`"*）。UI 手工版：

1. **进入工程 / 导入**：全流程重跑或 `import_scene.vrm`；确认 armature 的 humanoid 映射仍是 53 根、rest 是 T-pose（`armature.data.pose_position = 'REST'` 检查，导出前恢复 `'POSE'` 也可以——glTF exporter 会按 rest 处理 bone 父级变换，见下方证据）。
2. **定位右手骨**：选中 armature → Pose Mode → 找到 **`右手首`**（= `rightHand`）。PMX/VRM 往返后名字应保持 `右手首`；若被 sanitize，就用 VRM addon 的 Humanoid 面板反查 raw 骨名，**不要按字符串猜**。
3. **导入水枪 mesh**：FBX 用 `bpy.ops.import_scene.fbx(filepath=..., use_anim=False, automatic_bone_orientation=False, ignore_leaf_bones=False)`；glTF/OBJ 同理。立即做：
   - 删掉多余 object/骨骼/LOD/相机（只留水枪网格）；
   - `Object > Apply > All Transforms`（把 scale 烘进网格，满足 §2.2 正均匀缩放）；
   - `Mesh > Normals > Recalculate Outside`；
   - 记录包围盒（期望：整枪长 0.2–0.35 m、握把直径 ~0.03 m；与身体 1.73 m 同尺度）。
4. **对齐握持点**（两种姿势二选一，结果等价，因为最终存的是「相对右手首骨的不变变换」）：
   - **A. 在 T-pose 下对齐**（简单、可复现）：右手沿 +X 伸出、掌心向下；让握把轴线与手掌/手指方向一致，握把中心落在 `右手首` head 与掌心中点之间（约 0.04–0.06 m 处）。
   - **B. 在某个持枪参考帧对齐**（直观）：导入一段持枪动作 FBX/摆一个持枪 pose，把枪对到手上 → 挂骨 → 之后所有动作都用这个相对偏移。**注意**：不同片段手部角度不同，刚体枪只能取一个「平均握姿」，可能要牺牲部分片段的贴合度（见 §6）。
5. **挂骨（关键）**：
   - UI：选中水枪 mesh → 加选 armature → `Ctrl+P` → **`Bone`**（或 Object Properties > Relations：Parent=Armature、Parent Type=Bone、Parent Bone=`右手首`）。
   - 必须保持世界位置：**`Ctrl+P` 的 `Bone` 默认保持；若用面板改 parent 请先记位置或勾 Keep Transform**；不要手工猜 `matrix_parent_inverse`，glTF 导出器会按 bone matrix 重算相对 TRS（下方源码证据）。
   - Relations 面板复核三件事：`Parent = Armature`、`Parent Type = Bone`、`Parent Bone = 右手首`。
6. **不要给水枪加 Armature Modifier / 不要刷权重**（方案 B 的意义就在此处）。如果模型里已经带 Armature modifier，**删除该 modifier**；否则 Blender glTF 导出器会走 skin 分支（下方源码它会忽略 skin 但保留 bone parenting，行为仍可接受，但不如显式干净）。
7. **材质（必须新建）**：PMX 没引用 `水枪.png`，所以没有现成材质：
   - 新建 **MToon** 材质（VRM addon 的 `VRM Material` 面板 → MToon），`baseColorTexture = 水枪.png`（sRGB）；按贴图 α 选 `OPAQUE / MASK / BLEND`（水枪通常 OPAQUE 或 MASK）；
   - 与现有 39 个 MToon 保持同一 toon 观感：`shadeColor`、`shadingShift`、`outlineWidthMode` 对齐现有材质（现有 39 个全部 `outlineWidthMode="none"`，见 `docs/research/vrm-runtime-research.md` §0.2）；
   - 若走 PBR：用 VRM 允许的 glTF PBR（`KHR_materials_unlit` 也可），但和二次元身体混用会「亮/暗不一致」，不推荐。
8. **命名**：mesh object 命名 **`Watergun`**（glTF node name 会保留，用于运行时 `getObjectByName('Watergun')` 定位/隐藏）。方案 A 的骨命名 **`weapon_r`**（不要含 humanoid 关键字，addon 自动映射不会误选）。
9. **导出 VRM 1.0**：

```python
bpy.ops.export_scene.vrm(
    filepath=str(OUT_VRM),                # e.g. assets/vrm/aventurine-watergun.vrm
    armature_object_name=armature.name,
    export_gltf_animations=False,         # 模型文件带动画没有意义（VRM 规范也不用 animations）
    export_try_sparse_sk=True,            # 现有管线惯例，压体积
    # ignore_warning 保持 False
)
```
   导出前确认：没有选中 `Only Selected`/`Visible` 选项（否则武器/骨骼可能被过滤）；T-pose rest；水枪可见（`hide_viewport/hide_render = False`）。
10. **验证** → §5。

**为什么 B 可靠（本机 Blender 4.2.23 自带 glTF 导出器源码证据）** `[source]`：

- `.../scripts/addons_core/io_scene_gltf2/blender/exp/gltf2_blender_gather_tree.py` L232-234：`Objects parented to bone` → 记 `node.parent_bone_uuid = parent_uuid`（保持为 bone 的子节点，不合并）。
- 同文件 L255-262：rest-pose 导出时对 bone 子对象做 delta 补偿（`gltf_rest_position_armature is True` 时用 rest 矩阵重写 world matrix）→ **T-pose/rest 导出不会把武器位置带歪**。
- `gltf2_blender_gather_nodes.py` L505-515：带 Armature modifier 且 `parent_type == 'BONE'` 的 mesh → **忽略 skin、只保留 bone parenting**（避免递归错误）；`gltf2_blender_gather_primitives_extract.py` L130-140 同样处理 → 即使误留 modifier 也仍是非蒙皮 + 跟随。
- 同文件 L140-175：bone 子对象的相对 TRS 由 `parent_bone.matrix_world.inverted() @ child.matrix_world` 计算 → **导出后武器 node 的 local TRS 就是「相对右手首骨」的正确偏移**，不需要手工修正。

### 4.3 方案 A（备选）：加 `weapon_r` 骨 + 100% 权重

1. 选中 armature → Edit Mode → 在 `右手首` 下端新建骨 `weapon_r`：`parent = 右手首`，`use_connect = False`，`head` 放在握把位置（T-pose 下约在掌心），`tail = head + 0.05 m`。
2. 水枪 mesh：`Ctrl+A` Apply Scale（正均匀）→ 新建 vertex group `weapon_r` → 所有顶点权重 **1.0** → 加 **Armature Modifier**（object = armature，**不要勾 Preserve Volume**）。
3. 挂父级可选：mesh 直接 parent 到 armature（Object 模式，非 bone parent）或作为 armature 子对象；skin 由 modifier 决定。
4. **不要**在 VRM addon 的 Humanoid 面板把 `weapon_r` 映射成任何 humanoid 骨。
5. 若要和身体合并：Join 前注意形态键（95 表达式必须保留）、材质槽、顶点组名冲突；**不要**把武器 join 进带形态键的身体 mesh（Blender join 会丢/错位 shape key），VRM 允许 4 个 mesh（现有 3 个）。
6. 导出同 §4.2 第 9 步；校验时 skin joints 应为 336+1=337，humanoid 仍 53。

### 4.4 从 `.max` 场景 FBX 提取武器的步骤与坑

前提：Lead 从 Windows 的 3ds Max 全场景 FBX 里找到武器网格（可能是独立 object，也可能挂在 Biped 手骨下、或已蒙皮）。步骤：

1. Blender 导入（与本仓库现有 FBX 管线同参，见 `scripts/vrm/motion/extract-hsr-anims.py` / `extract-biped-anims.py`）：

```python
bpy.ops.import_scene.fbx(
    filepath=FBX,
    use_anim=False,                  # 提取网格不需要动画
    ignore_leaf_bones=False,
    automatic_bone_orientation=False,
    use_custom_props=True,
)
```
   单位：Blender 按 FBX 文件单位自动换算，本仓库现有管线**不传 `global_scale`**（即相信文件单位）；若武器明显 100×/0.01×，用「与身体同场景的已知尺寸（1.73 m）」反推，而不是猜 scale 参数。

2. 定位武器 object：按名字/层级（可能是 `Weapon`、`Gun`、`水枪`、`Prop*`，或挂在 `Bip01 R Hand`/`Bone_*` 下），选中后看包围盒与顶点点数；**多 LOD/多子 mesh 时只保留最高模**。
3. 冻结几何：
   - 若是 bone parent：`Object > Parent > Clear Parent and Keep Transformation`（`bpy.ops.object.parent_clear(type='CLEAR_KEEP_TRANSFORM')`）。
   - 若是 skinned：**先确认当前 pose = 期望姿态**（最好切 rest/T-pose，否则会把当前帧姿势烘进网格），`Object > Apply > Visual Geometry to Mesh`（或 `bpy.ops.object.modifier_apply(modifier='Armature')`），然后 `bpy.ops.object.vertex_group_remove(all=True)` 清权重、删掉残留 Armature modifier。
4. 把 mesh 变成「米制、Z-up、无旋转、无缩放」：`Apply All Transforms`；用 §4.1 的尺寸校验。
5. 材质：FBX 里通常是 Standard/Phong + 外部贴图路径。检查 `bpy.data.images` 是否丢图（`images_missing`），把用户给的 `assets/model/水枪.png` 接到 baseColor；**不要**直接沿用 FBX 的 Standard 材质导出 VRM（需转 MToon/PBR）。
6. 重新挂到 VRM 手骨：如果武器是从**同一角色的动画 FBX** 里拿的，它的 FK 绑骨名是 Biped/Unity 名（`Bip01 R Hand`…），**不能**直接复用权重到 PMX 重的骨名（`右手首`）——必须按 §4.2（B）重新 parent，或按 §4.3（A）建新骨刷 100% 权重。
7. 坑清单 `[local]`/`[community]`：
   - `.max` 全场景 FBX 可能每帧都是「身体+武器+场景道具」整包，文件大、导入慢；`use_anim=False` 提速。
   - 武器可能不在 `Bip01` 骨架里而是场景独立 object（那就最简单：直接 Clear Parent Keep Transform）。
   - FBX 里武器可能带 **in-between shapes**（Blender 4.2 导入会抛 `FBX in-between Shapes are not currently supported`，见 `docs/research/wave1-15-pitfalls.md` §?）→ 需要时用 FBX 导出端关闭 shape/或按该文的方法处理。
   - 贴图路径是 Windows 绝对路径 → 手动重链到 `assets/model/水枪.png`。
   - 法线/背面：MMD 模型双面多，FBX 模型可能单面；导入后 `Recalculate Outside` + 检查翻面。

### 4.5 单位 / 坐标 / 缩放对照（一次看懂）

| 项 | 值 | 说明 |
|---|---|---|
| PMX → Blender | `scale=0.08` | 本模型 PMX 原始 21.68 单位高 → 1.734 m，**1 PMX 单位 = 0.08 m**（MMD Tools 导入参数，`rename_bones=False`） |
| Blender → glTF/VRM | 导出器自动 Z-up→Y-up | **不要手工旋转** armature/mesh；VRM 1.0 要求模型面向 +Z、脚底 Y=0 |
| VRM 世界尺寸 | 米 | glTF 2.0 坐标单位；水枪 0.2–0.35 m 合理 |
| node scale | **正数、均匀** | T-pose 规范 Definition 2.1；Apply Scale 后为 (1,1,1) 最稳 |
| 右手骨朝向 | `右手首` 骨局部 Y 沿骨长（wrist→手指方向） | 对齐时可把枪握把轴对到骨局部 Y；但**以渲染观感为准**，Pose 下按住 `Shift` 转枪比算矩阵快 |

### 4.6 运行时隐藏/切换建议（配合烘焙）

- 烘焙后武器 node 名字固定（`Watergun` 或 `weapon_r`）。app 侧：
```ts
const gun = vrm.scene.getObjectByName('Watergun')        // 或 weapon_r 骨节点
gun.visible = clipHasWeapon(currentClipId)               // 按 clip 白名单切换
```
- 不要用 `scale=0` 或移出场景；`visible=false` 不破坏层级、不影响 humanoid/spring 更新。
- 若以后要「枪在手上做小摆动」，在 app 层给武器 node 加自己的 `AnimationMixer` 轨道（VRMA 管不到非 humanoid 节点）；或把它改成方案 A 的骨并挂 VRM spring bone。

---

## 5. 校验方法（按顺序做，全部可脚本化）

### 5.1 Blender 导出期

- 导出前 addon 自动校验必需 humanoid 骨；**不要勾 `ignore_warning`**。
- 导出返回 `{'FINISHED'}` 且文件非空（本仓库 `scripts/vrm/export-dummy-vrm.py` 的 fail-fast 写法可直接抄）。
- 导出后立刻在 Blender 里再读一次：`bpy.ops.import_scene.vrm(filepath=OUT)` 到空场景，确认 `Watergun` 仍在、parent 链对、材质贴图存在。

### 5.2 GLB JSON 断言（Python，只读；照抄 `export-dummy-vrm.py` 的 GLB 解析）

```python
import struct, json
def glb_json(path):
    d = open(path,'rb').read()
    assert d[:4] == b'glTF'
    off = 12
    while off < len(d):
        clen, ctype = struct.unpack_from('<II', d, off); off += 8
        if ctype == 0x4E4F534A:
            return json.loads(d[off:off+clen].rstrip(b'\x00').decode())
        off += clen
g = glb_json(OUT)
nodes = g['nodes']; hb = g['extensions']['VRMC_vrm']['humanoid']['humanBones']
assert len(hb) == 53                                   # humanoid 骨数不变
rh = hb['rightHand']['node']
gun_idx = next(i for i,n in enumerate(nodes) if n.get('name') == 'Watergun')
# 断言 1：武器 node 是右手首节点的后代（直接或经 weapon 骨）
def is_descendant(i, anc):
    n = nodes[i]
    return anc in n.get('children', []) or any(is_descendant(c, anc) for c in n.get('children', []))
assert is_descendant(gun_idx, rh), 'Watergun 不在 rightHand 子树'
# 断言 2：缩放正且均匀
s = nodes[gun_idx].get('scale', [1,1,1]); assert min(s) > 0 and len(set(s)) == 1
# 断言 3：其余数据不变
assert len(g['extensions']['VRMC_springBone']['springs']) == 50
assert len(g['extensions']['VRMC_springBone']['colliders']) == 175
assert len(g['materials']) == 40                        # 39 + 水枪
assert 'VRMC_materials_mtoon' in (g['materials'][-1].get('extensions') or {})
print('GLB_ASSERT_OK nodes=', len(nodes), 'meshes=', len(g['meshes']), 'materials=', len(g['materials']))
```

### 5.3 three-vrm 运行时断言（最接近真实使用）

```ts
const gltf = await loader.loadAsync(vrmUrl)
const vrm = gltf.userData.vrm as VRM
const gun  = vrm.scene.getObjectByName('Watergun')!
const hand = vrm.humanoid.getRawBoneNode('rightHand')!
// 1) 层归属
let p: THREE.Object3D | null = gun
while (p && p !== hand) p = p.parent
console.assert(p === hand, 'Watergun parent chain 未接到 rightHand')
// 2) 动画跟随：播放一个持枪 clip，采样两帧世界坐标应不同
const before = gun.getWorldPosition(new THREE.Vector3())
mixer.update(0.2); vrm.update(0.2); renderer.render(scene, camera)
const after = gun.getWorldPosition(new THREE.Vector3())
console.assert(before.distanceTo(after) > 1e-4, '水枪未随动画移动')
```
仓库已有验证入口可复用：`scripts/vrm/capture-vrm.mjs`、`scripts/vrm/canary-viewer.html`（加载→截图→断言），可加「武器节点存在且世界坐标随帧变化」一条。

### 5.4 Khronos glTF-Validator + 目视验收

- glTF-Validator（在线/JS 版）：关注 **errors = 0**；`VRMC_*` 未知扩展的 warning 属正常。
- 目视三帧截图（放 `tests/tmp/`，不入库）：
  1. T-pose：枪在右手、身体 T-pose 无变化；
  2. 持枪动作中帧：握把贴掌、不悬空；
  3. 空手动作帧：确认「永久持枪」的观感是否可接受（决定是否需要 `visible` 白名单/双变体）。
- 检查清单：无 z-fighting、无翻面、贴图颜色/α 正确、枪不穿袖子/不穿身体、左右手动作不对称时武器不抖。

---

## 6. 风险与限制（按影响排序）

1. **永久持枪 → 空手动作也拿枪**（产品语义风险）。用户明确要「永久挂」，但 138 个动作里有大量非持枪动作。缓解：`Watergun.visible` 按 clip 白名单；或产两个 VRM。**注意 VRMA 无法驱动武器节点**（§2.3），只能 app 层处理。
2. **握持点不唯一**：刚体武器只有一个相对偏移，不能适配所有手部角度；两手持枪/换手动作会穿模或悬空。缓解：选「持枪帧占比最高」的握姿；或做方案 A + 弹簧/约束（成本高）；或接受瑕疵。
3. **尺寸/单位错**：FBX 水枪常见 100× 或 0.01×。必须与 1.73 m 身体同尺度校验（§4.5）；导出后 three-vrm 截图确认。
4. **材质**：`水枪.png` 是外部贴图，PMX 无材质；需新建 MToon 并调 shade/α；若 αMode 错会导致透明排序问题（现有 6 个 BLEND 材质已有类似坑，见 `docs/research/vrm-runtime-research.md` §0.2）。
5. **VRM 往返损耗**：import VRM → export 可能改动表达/spring/MToon 数据。必须 §5.2 断言（53/95/50/175/39）+ 与旧文件逐段对比；**新文件名保留回滚**。全流程重跑虽贵但一致性最好。
6. **规范/兼容**：T-pose 正均匀缩放（不要负缩放/镜像）；不要把武器骨映射进 humanoid；不要给 VRM 文件塞 animation（VRM 规范不使用 animations 字段）。
7. **导出过滤**：addon/glTF 导出若勾 `Visible`/`Selected` 或武器被 hide，会静默丢节点 → 断言兜底。
8. **本机私有资产**：`水枪.png`/`.max`/FBX 只在本机，本文不含任何资产内容；不要上传到任何在线 validator（在线工具只用于无隐私的公开测试文件，或改用本地 CLI）。

---

## 7. MMD/PMX 与 HSR 的武器挂法经验对照

### 7.1 PMX/MMD（`[community]`，方法多年稳定）

- MMD **没有 glTF 式「node 作为骨子节点」的运行时挂载**；武器进模型的标准做法是：**把武器顶点 100% 权重到 `手首` 骨**（PMXEditor 里「权重 → 全选武器顶点 → 指定骨 `右手首` → Go」）。教程（含图）：<https://learnmmd.com/http:/learnmmd.com/attach-an-item-or-accessory-to-a-bone-in-pmdeditor-weighting-in-mmd/>。→ 这正是本方案 A 的 Blender 等价物。
- PMX 标准骨名：`右手首`/`左手首`（本模型确有，见 §1）；还有 `右手捩/右手環/指骨` 等中间骨——**武器不要挂到 `右手捩`**（那是扭转分布骨，动画里常被 grant 驱动），挂 `右手首` 最稳。
- MMD「付属モデル（附属模型）」式：独立 pmx + 外部父级/刚体跟随（nanoem 文档里「右ダミー」等 dummy 骨例子 <https://nanoem.readthedocs.io/>）——对应本方案 C 的独立性，但 MMD 里仍靠「权重/刚体」而非节点父子。
- **刚体（rigidbody）不是武器挂法**：MMD 刚体用于物理（头发/裙摆），武器是刚性跟随，不建刚体、不建关节。
- 对本 VRM 路线的借鉴：①「挂到 `右手首` 而不是手腕/手指」；②握持点（grip pivot）要在建模/对齐时定死；③武器与身体材质分开（独立材质槽）。

### 7.2 HSR / Unity 游戏内做法（`[community]`，具体 bone 名未在本机核实）

- 崩铁角色 prefab 中武器是**独立 mesh**，通过层级父节点/武器 socket（手部骨下的挂点）跟随角色；运行时换武器 = 换挂点下的模型，不是把武器烘进身体。拆包/Mod 工具（如 <https://github.com/Sycamore0/SRStudio>、SSMT 系列）也是「角色模型 + 武器模型」分开 dump → **这解释了为什么 PMX 里没有水枪、贴图却是单独给的**。
- 对本项目的借鉴：游戏内是「运行时挂」，本项目因为要「永久在 VRM 里」→ 离线烘焙等价于把 socket 下的武器**并进 avatar**。若水枪网格只能从全场景 FBX 拿到，FBX 里它很可能就是挂在手骨下的独立节点（§4.4 步骤直接适用）。
- 可靠性：HSR 具体 socket 骨名/资产路径属社区信息，**未在本机验证**，不要写进代码注释当事实；MMD 部分有公开教程可复现。

---

## 8. 参考链接（含可靠性）

| 链接 | 用途 | 可靠性 |
|---|---|---|
| <https://github.com/vrm-c/vrm-specification/blob/master/specification/VRMC_vrm-1.0/humanoid.md> | humanoid 定义、Forbidden Transforms、非 humanoid 骨节点允许 | official |
| <https://github.com/vrm-c/vrm-specification/blob/master/specification/VRMC_vrm-1.0/tpose.md> | T-pose、所有节点正均匀缩放 | official |
| <https://github.com/vrm-c/vrm-specification/blob/master/specification/VRMC_vrm-1.0/README.md> | 米制单位、不使用 animations/cameras、执行顺序 | official |
| <https://github.com/vrm-c/vrm-specification/blob/master/specification/VRMC_vrm_animation-1.0/README.md> | VRMA 只含 humanoid 轨道、禁止 scale/非 hips 平移 | official |
| <https://registry.khronos.org/glTF/specs/2.0/glTF-2.0.html#nodes> | glTF node 可有 mesh + children | official |
| <https://vrm-addon-for-blender.info/en-us/create-humanoid-vrm-from-scratch/> | **官方教程：Parent Type=Bone 挂手骨后导出 VRM** | official |
| <https://vrm-addon-for-blender.info/en-us/ui/export_scene.vrm/> | Export VRM 选项说明 | official |
| <https://github.com/saturday06/VRM-Addon-for-Blender> | addon 4.10.4 源码/issue | official |
| <https://github.com/KhronosGroup/glTF-Validator> | glTF 核心校验 | official |
| <https://github.com/vrm-c/UniVRM> | Unity 侧 VRM10 校验/参考实现（可选终检） | official |
| <https://github.com/MMD-Blender/blender_mmd_tools> | MMD Tools（导入参数、骨名） | official |
| <https://learnmmd.com/http:/learnmmd.com/attach-an-item-or-accessory-to-a-bone-in-pmdeditor-weighting-in-mmd/> | PMX/PMD 武器权重到 手首 骨的做法 | community（2012，方法稳定） |
| <https://nanoem.readthedocs.io/> | nanoem：dummy 骨/附属模型跟随例子 | community |
| <https://github.com/saturday06/VRM-Addon-for-Blender/issues/584> | addon VRMA 导出「非 humanoid 骨没有轨道」的实证 | community/issue |

本仓库内相关文档：`docs/vrm-toolchain.md`（addon 安装/导出 API/MMD 导入参数）、`docs/research/tooling-blender.md`（MMD Tools 实测、四视图渲染）、`docs/research/vrm-runtime-research.md`（three-vrm/VRMA/运行时约束）、`docs/research/v3-fbx-export-bestpractices.md`（Max→FBX 管线）、`scripts/vrm/export-dummy-vrm.py`（导出+GLB 断言样例）、`scripts/vrm/capture-vrm.mjs`（运行时截图/验证）。

---

## 9. 建议的下一步（给 Lead 的决策点）

1. **先决条件**：水枪网格来源。若 Lead 在 `.max` 全场景 FBX 找到 → 按 §4.4 提取；找不到 → 要么用户提供 HSR 官方水枪资产，要么先做 blockout 占位跑通全链路（§4.1 来源 2），**不要卡在素材上**。
2. **30 分钟 spike（低风险验证）**：拿现有 `aventurine-tpose.vrm` → import → 挂一个占位方块到 `右手首`（方案 B）→ 导出 `aventurine-watergun-spike.vrm` → 跑 §5.2 断言 + three-vrm 截图。此步能一次性证伪「导出丢节点 / 运行时不动 / 往返损坏」三类风险。
3. **做成产品**：spike 通过后决定 ① 方案 B 还是 A（建议 B；若以后要并网格/加 spring 再升 A）；② 全流程重跑 vs 往返；③ 「永久持枪」是否配 `visible` 白名单/双 VRM。
4. **文档口径**：现有 `vrm-contract.md` 的资产清单（53 humanoid/39 材质/95 表情）在接入武器后需更新为 40 材质（+1 水枪），并新增一条「武器节点名 = `Watergun` / 骨名 = `weapon_r`」的运行时契约（待 Lead 决定后再改，本文不改其他文件）。
