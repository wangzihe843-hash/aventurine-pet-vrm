# .max 骨骼动画离线提取能力核查（macOS/Linux，不装 3ds Max）

> 任务：`task-1`（Lead=lead，本文件由研究队友 max-importer-researcher 产出）
> 日期：2026-11-09；适用素材：`/Volumes/4TB外置盘/百度网盘/砂金戏浪.zip`
> 证据口径：**实测**＝本轮在本机跑出的结果（命令与脚本见 §7）；**源码**＝指到具体文件/行；**未验证**＝未取得一手证据，只作线索。
> 本文件为新增文件；未改动其它文件、未提交 git、未动 `assets/`。

---

## 0. 一页结论

| # | 路线 | 能否拿到「骨骼动画关键帧」 | 结论 |
|---|---|---|---|
| A | **Windows + 3ds Max（试用）+ MaxScript 批量导出 FBX** | ✅ 能（Biped 关键帧完整） | **推荐主路线**。Lead 已确认有 Windows 机器可装试用；这是唯一无逆向风险、可批量（138 个）的路线 |
| B | Blender 官方扩展 `io_scene_max` 1.9.2（macOS/Linux 原生） | ❌ 不能（只有 mesh/material；Biped → 空物体） | 只能用来核对网格/材质/骨骼命名层级，不能用于动画 |
| C | FreeCAD `Importer3D`（io_scene_max 上游） | ❌ 不能（同源解析器，无动画） | 未单独审计源码（未验证），但插件 README 明确其代码即来自该上游；能力不会更强 |
| D | Assimp / Autodesk FBX Converter / Noesis / Okino PolyTrans / Deep Exploration / Max2Blender | ❌ 不能 / 未知 | Assimp 官方格式表**根本没有 .max**（已抓取）；其余未取得一手证据（未验证），无可推荐的 macOS 原生方案 |
| E | **自研 .max Biped chunk 解析器** | ⚠️ 数据「可解性」比预期高，但语义逆向无底洞 | **不建议作为备选**。理由见 §5：无公开规范/无 prior art/无 ground truth/还要额外解蒙皮，成功率和验证性都差 |
| F | 向素材方索取 FBX / .bip | ✅ 能（若可得） | 最优捷径，建议先问，成本最低 |
| G | 放弃素材，走现成动作库/程序化动作（项目已有 `docs/anim-tech-survey.md` 方案） | ❌ 与该 .max 素材无关 | 兜底 |

**一句话**：想在不装 3ds Max 的 macOS 上从这批 `.max` 里拿 Biped 关键帧，**目前没有任何已核实的现成工具**；唯一公开的 `.max` 解析器 `io_scene_max` 只做网格/材质，Biped 只建成空物体；自己写解析器在数据层面可行（动画是**定长逐帧数组**，非加密/压缩），但轨道语义、骨骼索引、静置姿态、蒙皮都无公开资料，且没有 3ds Max 就没有 ground truth —— 不建议。

**语料修正**：zip 内实测 **138 个 `.max` + 35 个 `.png`**（共 173 条目，无 FBX/无 .bip/无其它 3D 格式）。此前记的「141 个 .max」与本轮实测不符，请以 138 为准（证据：§7 的 zip 扫描输出）。

---

## 1. 素材基线（实测）

| 项 | 值 |
|---|---|
| 源 zip | `/Volumes/4TB外置盘/百度网盘/砂金戏浪.zip`（617,874,244 B） |
| 内容 | 138 × `.max` + 35 × `.png`；**没有** FBX、DAE、glTF、.bip、.bik、Unity 资产 |
| .max 格式 | OLE/CFB 容器（magic `D0CF11E0A1B11AE1`），Scene 流 + ClassDirectory3 + DllDirectory 等 11 个流 |
| 场景类 | 3ds Max 2021（DllDirectory 含 `biped.dlc`「Biped Controller (Autodesk)」；另有 ctrl.dlc/bonesdef.dlm/morpher.dlm/peopleorch.dlc 等） |
| 采样 | `Tpose.max`（16,252,928 B）、`Walk.max`（19,120,128 B，本轮从 zip 解出）、`Skill01.max`（30,441,472 B） |

---

## 2. `io_scene_max`（Blender 官方扩展）能力边界（源码 + 实测）

**版本信息（源码）**：`source/blender_manifest.toml` → `version = "1.9.2"`、`blender_version_min = "4.2.0"`、`tags = ["Import-Export", "Mesh", "Material"]`、`website = https://github.com/nrgsille76/io_scene_max`；维护者 NRG Sille。本机实测环境 Blender **4.2.23 LTS**，扩展源码取自 `/tmp/io_scene_max-main`（2311 行 `import_max.py` + 153 行 UI）。

### 2.1 源码证据

| 证据 | 位置 | 含义 |
|---|---|---|
| `BIPED_OBJ = 0x…9125`、`BIPED_ANIM = 0x78C6B2A6B147369` | `source/import_max.py` L60–61 | 认出了 Biped 类 GUID |
| `elif (uid == BIPED_OBJ and 'ARMATURE' in settings[1]): created = [create_dummy_object(context, node, uid)]` | L2181–2182 | **UI 里那个「Armature」过滤器名不副实**：开启后 Biped 只是被建成 Empty |
| `def create_dummy_object(...): dummy = bpy.data.objects.new(name, None); dummy.empty_display_type = 'SINGLE_ARROW' if uid == BIPED_OBJ else 'PLAIN_AXES'` | L1890–1893 | Biped 骨架 → 空物体（无 armature、无骨长/朝向） |
| `create_matrix()` 只有两个分支：`0x2005 位置/旋转/缩放` 与 `0x9154 BipSlave 控制`；后者读 `BIPED_ANIM` 引用里的**静态** `TCB Position/Rotation/Scale` 值 | L1787–1804（`get_position/get_rotation/get_scale` L1725–1785） | 只尝试读「静态当前值」，**从不读关键帧** |
| `object_filter` 的 `ARMATURE` 选项 | `source/__init__.py` L63、默认值 L66 | 该选项只决定是否创建 Biped 空物体，不生成 armature |
| `SKIPPABLE` 里的 `0x2ECCA84028BF6E8D: 'Bone'`（即 3ds Max 的 Bone 对象） | `import_max.py` L95 | 普通 Bone 对象被直接跳过 |

**全文件 API 检索**（`grep -c -E 'keyframe|animation_data|fcurve|armature|vertex_group|ob_groups' source/import_max.py`）：**0 命中**。即源码中不存在任何动画/骨骼/蒙皮写入逻辑。

### 2.2 实测（Blender 4.2.23 无头模式导入 Tpose/Walk/Skill01）

```
每个文件 → 78 objects = 10 MESH + 68 EMPTY
armature objects = 0；armature datablocks = 0；actions = 0；fcurves = 0
vertex groups = 0；armature modifiers = 0；constraints = 0；shape keys = 0
materials = 9（材质能进）
68 个 Empty 中 54 个 empty_display_type=SINGLE_ARROW（= Biped 对象节点），14 个 PLAIN_AXES（= 各 Nub/末端）
骨架层级正确（Bip001 → Pelvis → Spine/Spine1/Spine2 → Neck/Head、L/R Clavicle→UpperArm→Forearm→Hand→Finger0..4、Thigh→Calf→Foot→Toe0），但所有骨骼 empty 的局部矩阵均为单位矩阵、world 平移全为 0（只有根节点被全局轴转换矩阵带了 90° 旋转）
```

**结论**：`io_scene_max` 能拿 **mesh + UV + 材质 + 空物体层级/命名**；**拿不到 armature、蒙皮权重、动画关键帧**，连 Biped 的**静置姿态/骨长**都拿不到（骨骼全部叠在原点）。另外 3 个采样文件导入结果完全同构（动作/静置无差异），说明 Walk/Skill 的动画确实没被读入。

**GitHub issue 旁证**（GitHub Search API，`repo:nrgsille76/io_scene_max animation`，`total_count=3`，已抓取）：
- **#1「Armature is imported as empties rather than an actual armature.」**（2024-06-02，state=closed，labels=`good first issue`、`solved`）——正是本结论：骨架只进空物体；https://github.com/nrgsille76/io_scene_max/issues/1 （维护者回复正文未读到，**未验证**其具体说法）。
- #28（UV/材质问题）、#31（泛泛的 transform 丢失）与 Biped 动画无关。**仓库 issue 中未见「Biped 动画导入」需求或实现**。

**Blender 4.5**：manifest 只要求 ≥4.2；**4.5 未实测（未验证）**。但即便 4.5 能装，能力仍由上述源码决定，不会有动画。

---

## 3. 其它「离线 .max 解析器/转换器」核查

| 工具 | 读取 .max？ | 动画/骨骼？ | 证据 / 说明 |
|---|---|---|---|
| **Blender `io_scene_max` 1.9.2** | ✅ | ❌ | §2；唯一活跃维护的开源 .max 导入器 |
| FreeCAD `Importer3D`（jmplonka） | ✅（上游） | ❌ | io_scene_max README 明言代码来自该上游；本轮未单独审计上游源码（**未验证**），但同源代码不可能多出 Biped 动画解码 |
| **Assimp** | ❌ | — | 官方格式表（已抓取 https://github.com/assimp/assimp/blob/master/doc/Fileformats.md ）Importers 列表有 3DS/FBX/DAE/PMX…，**没有 MAX/.max** |
| Autodesk FBX Converter | ❌ | — | 只做 FBX/DAE/OBJ 互转；本轮未抓官方页面（**未验证** exact 支持列表） |
| Noesis | 未验证 | 未验证 | 未取得官方格式表证据，不作为「能」的依据 |
| Okino PolyTrans / Deep Exploration | 未验证 | 未验证 | 商业、历史上 Windows 形态；未核实其 .max 读取是否依赖本机 3ds Max。Deep Exploration 已停售（**未验证**） |
| 「Max2Blender」付费插件 | 未找到可靠来源 | 未验证 | 搜索只命中 Blender 自带导入/导出与 io_scene_max，**未找到**可信的「原生读 .max 且支持 Biped 动画」插件（**未验证为不存在**，只证明本轮检索没找到） |
| 3ds Max 本体 | ✅（唯一权威） | ✅ | Autodesk 官方系统需求页只列 Windows（https://help.autodesk.com/view/3DSMAX/2026/ENU/?caas=caas/sfdcarticles/sfdcarticles/System-requirements-for-Autodesk-3ds-Max-2026.html ，正文未抓取，**未验证**具体条目）；**3ds Max 无 macOS 版本**（业界常识级，未验证链接）。Lead 已确认有 Windows 机器 → 路线 A 可行 |

**关于「公开 .max 格式文档」**：社区只有几何/材质向的逆向资料（如 Ryzom wiki `max_geometry_formats`：https://github.com/ryzom/ryzomcore/wiki/max_geometry_formats ，本轮未逐条核对），**没有任何关于 Biped 动画 chunk 的公开规范/解析器**（**未验证为「不存在」，只是本轮检索未找到**）。3ds Max 的 `.max` 容器与 Biped 数据由 Autodesk 闭源 DLC 读写，官方 SDK 不公开该二进制布局。

---

## 4. 实证：Biped 动画数据在 .max 里长什么样（自写 CFB/chunk 探针）

工具：`/tmp/maxparse.py`（纯 Python + olefile，规则与 `io_scene_max.ChunkReader` 一致：`u16 type + i32 size`，`size==0` 时读 `i64`；负值=容器；`chunksize = size & 0x7FFF…`）。先解析 `ClassDirectory3`（**75 个类**）得到类名/GUID，再遍历 Scene 流（Tpose 的 Scene 流 15,727,026 B，顶层 chunk 9,455 个）。

### 4.1 关键类（ClassDirectory3，实测）

`Node(0x1)`、`位置/旋转/缩放(0x2005)`、`Biped 对象(0x9125)`、`BipSlave 控制(0x9154)`、`Biped 子动画(0x078C6B2A6B147369)`、`Biped(0x9155)`、`Vertical/Horizontal/Turn(0x9156)`、`位置列表(0x4B4B1002)`、`旋转列表(0x4B4B1003)`、`缩放列表(0x4B4B1004)`、`蒙皮(0x0156660095C723)`、`可编辑网格(0xE44F10B3)` …

### 4.2 动画数据的真实位置与形态（**本轮最重要的实证**）

Scene 流里有**恰好一个** class=`Biped` 的顶层 chunk（GUID `0x9155`，即 biped.dlc 的控制器对象）。它的子 chunk 里：

- `0x0102`：逐帧数据，长度 `74 + 20·n` 字节；
- `0x012C … 0x013F`：**20 条动画轨道**。每条第 1 个 `u32` = **关键帧数 n**；payload 精确满足 `payload = header + n × stride`：

| chunk | header | stride(B/帧) | Tpose(n=0) | Walk(n=71) | Skill01(n=195) |
|---|---|---|---|---|---|
| 0x012C | 4 | 40 | 4 | 2,844 | 7,804 |
| 0x012D | 40 | 40 | 40 | 2,880 | 7,840 |
| 0x012E | 12 | 52 | 12 | 3,704 | 10,152 |
| 0x012F | 40 | 40 | 40 | 2,880 | 7,840 |
| 0x0130 | 8 | 104 | 8 | 7,392 | 20,288 |
| 0x0131 | 40 | 40 | 40 | 2,880 | 7,840 |
| 0x0132 | 12 | 28 | 12 | 2,000 | 5,472 |
| 0x0133 | 40 | 40 | 40 | 2,880 | 7,840 |
| 0x0134 | 24 | 1,160 | 24 | 82,384 | 226,224 |
| 0x0135 | 40 | 40 | 40 | 2,880 | 7,840 |
| 0x0136 | 24 | 1,160 | 24 | 82,384 | 226,224 |
| 0x0137 | 40 | 40 | 40 | 2,880 | 7,840 |
| 0x0138 | 24 | 480 | 24 | 34,104 | 93,624 |
| 0x0139 | 40 | 40 | 40 | 2,880 | 7,840 |
| 0x013A | 24 | 480 | 24 | 34,104 | 93,624 |
| 0x013B | 40 | 40 | 40 | 2,880 | 7,840 |
| 0x013C | 16 | 56 | 16 | 3,992 | 10,936 |
| 0x013D | 40 | 40 | 40 | 2,880 | 7,840 |
| 0x013E | 12 | 64 | 12 | 4,556 | 12,492 |
| 0x013F | 40 | 40 | 40 | 2,880 | 7,840 |

- **每帧合计**：20 条轨道 stride 之和 = **4,024 B/帧**；加上 `0x0102` 的 20 B/帧 = **4,044 B/帧**。
- **`Biped` 节点总长**（实测）：Tpose 11,847 B；Walk 298,979 B；Skill01 800,435 B。完全可被下式解释：
  `byte 长度 = 11,847 + 4,044 × n + δ`（δ 来自引用表微差，0/8/16 B）。
- **全包 138 个文件验证**：`node_len − (11,847 + 4,044·n)` 的残差 ∈ **[0, 16] 字节**，138/138 通过；每个文件的 20 条轨道帧数一致；帧数分布 0–502（71 个不同取值，中位约 121）；**唯一 0 帧＝`Tpose.max`**，其余 137 个都有帧（`Common_IdleShow.max` 最多 502 帧）。

**这意味着**：
1. 动画数据**不是加密/压缩 blob**，而是**定长逐帧数组**（每条轨道 stride 固定、帧数可读）；理论上**可解析**，比预期乐观。
2. 但 10 对轨道的**语义**（40/52/104/28/1160/480/56/64 B 每帧记录里各字段是什么、四元数/位移/IK/Footsteps 怎么编码）、**Biped 内部骨骼索引 ↔ Scene 节点（`Bip001 L Thigh` …）的映射**、以及**静置姿态（figure mode）**都没有公开资料；`0x0102` 也未见文档。
3. 即便解出关键帧，**蒙皮**是另一个私有类（`蒙皮 0x0156660095C723`，10 个 mesh 各一个），同样无公开解析器 → 拿不到权重就仍无法直接绑到我们的 PMX/VRM 骨架。
4. `.max` 里的 Biped 骨骼节点在 `BipSlave 控制` 的 PRS 数组里**不存静态 TCB 值**（实测 `create_matrix()` 对 65/65 个 BipSlave 都返回单位矩阵），因此连「Tpose 静置姿态」也要从动画数组或 figure 数据里反推。

---

## 5. 「自己写解析器」可行性评估（结论：不建议）

**有利**
- 帧数可读、stride 固定、20 条轨道结构在 138/138 文件上稳定；`0x0102` 逐帧 20 B 也稳定。
- 有 `Tpose.max`（0 帧）作参照；Walk(71)/Skill01(195) 帧数不同，可交叉验证。
- 只要拿到「每帧 × 每骨」的局部变换，重定向到项目 PMX 骨架是成熟问题（项目已有 PMX 骨骼表与重定向经验）。

**不利 / 风险**
1. **零公开规范、零 prior art**：Biped 数据由闭源 `biped.dlc` 读写；唯一公开的 `.max` 解析器（io_scene_max / Importer3D 世系）完全没碰 Biped 动画（§2、§3）。
2. **4,024+20 B/帧的语义要纯逆向**：10 对轨道、各不相同 stride；涉及四元数/位移编码、IK/Footsteps/锁骨等特殊轨，错一个轨道动作就会崩。没有已知的字段边界，只能靠试。
3. **还需要额外解两件事**：Biped 内部骨骼索引↔节点层级映射、静置姿态；以及 **Skin 蒙皮权重**（另一个私有类）。
4. **没有 ground truth**：不装 3ds Max 就无法独立验证解出来的关键帧是否正确；只能用「动起来像不像」判断，而错误是静默的（错轴/错骨/漏轨都能像）。若已有 Windows + Max，导出 FBX 是**分钟级**工作，逆向投入完全不成比例。
5. **工程量/成功率（估计，未验证）**：顺利情形 3–8 人周；成功率中等偏低（<50%）。作为「备选」性价比极低，优先级应排在 路线 A / F 之后。

**建议**：
- 主路线：**Windows + 3ds Max 试用 + MaxScript 批处理**（读每个 `.max` 的 Biped，`exportFile` 成 FBX，再进 Blender/重定向）。这正是 Lead 已确认可用的路线。
- 兜底优先级：① 向素材方索取 FBX/`.bip`（若原始工程有）；② 放弃该包动画，按 `docs/anim-tech-survey.md` 走现成/程序化动作；③ 只有在 Windows Max 路线彻底不可行、且接受「数周逆向 + 无法保证正确性」时才考虑自研解析器。

---

## 6. 结论矩阵（详细版）

| 路线 | macOS/Linux 离线？ | 网格 | 材质/UV | 骨骼层级 | 静置姿态 | **动画关键帧** | 推荐 |
|---|---|---|---|---|---|---|---|
| io_scene_max 1.9.2（Blender） | ✅ | ✅ | ✅ | ⚠️ 仅空物体层级+命名（无臂长/朝向） | ❌（全部叠在原点） | ❌ | 仅用于网格/材质核对 |
| FreeCAD Importer3D | ✅（上游） | ✅ | 部分 | ❌ | ❌ | ❌（未验证，但同源） | 无新增能力 |
| Assimp | ✅ | — | — | — | — | ❌（不支持 .max） | 不可用 |
| Autodesk FBX Converter / Noesis / Okino / Deep Exploration / Max2Blender | — | — | — | — | — | ❌/未验证 | 不作为依据 |
| 自研 chunk 解析器 | ✅ | ✅（已可） | ✅ | ⚠️ 可解层级，索引映射未知 | 需逆向 | ⚠️ 数据可解、语义未解；不建议 | 不建议 |
| **Windows + 3ds Max 试用 + MaxScript→FBX** | ❌（需 Windows） | ✅ | ✅ | ✅ | ✅ | ✅ | **推荐主路线** |
| 向素材方索取 FBX/.bip | — | ✅ | ✅ | ✅ | ✅ | ✅（若有） | 先问一句 |

---

## 7. 复现材料（本轮脚本/日志，均在 /tmp，未入库）

| 文件 | 作用 |
|---|---|
| `/tmp/maxparse.py` | 纯 Python `.max` CFB/chunk 解析器（ClassDirectory3 类名映射 + Scene 树 + payload 切片） |
| `/tmp/scan_zip.py` | 直接扫 zip 内 138 个 `.max`：定位 `Biped` 节点、读 20 条轨道帧数/长度；输出 `/tmp/zip_scan.json`、`/tmp/zip_scan.log` |
| `/tmp/probe_import.py`、`/tmp/probe_import3.py` | Blender 4.2.23 无头导入探针（对象/动作/顶点组/修改器统计） |
| `/tmp/probe_biped.py`、`/tmp/probe_create_matrix.py` | 用 addon 内部函数实测 `create_matrix` 对 65/65 个 BipSlave 返回单位矩阵 |
| `/tmp/maxprobe/{Tpose,Walk,Skill01}.max` | 采样文件（Walk.max 为本轮从 zip 解出） |
| 关键命令 | `"/Volumes/4TB外置盘/deepseek-harness/tools/blender/Blender.app/Contents/MacOS/Blender" --background --factory-startup --python /tmp/probe_import3.py -- /tmp/maxprobe/Tpose.max`；`python3 /tmp/scan_zip.py "$ZIP"` |

---

## 8. 未验证项（明确列出，避免被当作结论）

1. `io_scene_max` 在 **Blender 4.5** 的兼容性（本轮只实测 4.2.23；manifest 要求 ≥4.2）。
2. FreeCAD `Importer3D` 上游源码是否另有分支支持动画（本轮结论基于「同源代码 + Blender 分支全量 grep」推断）。
3. Noesis / Okino PolyTrans / Deep Exploration / Autodesk FBX Converter 对 `.max` 的具体支持（未抓官方文档）。
4. 「Max2Blender」是否存在且支持 Biped 动画（检索未找到，不能断言不存在）。
5. 是否存在暗网/小众开源 Biped 解析器（本轮检索未找到；不构成「不存在」的证明）。
6. GitHub issue #1 维护者回复的具体措辞（只取到标题/状态/labels）。
7. 自研工程量/成功率是**主观估计**（未做原型验证）；若有人愿意先花 1–2 天做「单轨道试解 + 与 3ds Max 导出 FBX 对比」的小原型，可把估计变实。
