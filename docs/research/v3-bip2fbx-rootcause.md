# v3 · Bip2Fbx 根因研究：3ds Max FBX 导出器里的 Biped→FBX 开关

- 日期：2026-11-09
- 环境（给定）：Windows 11 + 3ds Max 2027.2（29.2.0.20588，TRIAL），`3dsmaxbatch.exe`；3ds Max 2021 时代 `.max`，标准 Biped 65 骨 + `Bip001` 根 + `Bip001 Footsteps`，共 332 骨（267 个 `*_JNT`/面部骨）
- 研究方式：`web_search` / `web_fetch`（中英文），只引用实际抓到的页面；本地受控实验数字来自本仓库 `tests/tmp/adv-pilot-v3/fbx-pilot-v2-gui/REPORT-v3-rootcause-and-fix.md`
- 结论分级：**【官方】**=Autodesk 文档/帮助/SDK 头文件；**【社区】**=论坛/技术博客/仓库文件（非官方）；**【本地实测】**=本项目的单变量实验；**【推断】**=无直接文档、由名称/分组/行为推得

---

## 0. 执行结论（TL;DR）

`Bip2Fbx` 是 3ds Max FBX 导出器 IOSettings 里的一个布尔开关，内部名 `IOSN_BIP2FBX = "Bip2Fbx"`，属性路径 `Export|IncludeGrp|Geometry|Bip2Fbx`（FBX SDK 头文件）。它在 Autodesk 文档里只出现在 **MaxScript 参数表**（以及 FBX SDK 头文件的宏定义）里（2012 版写作 `Bip2FBX`，2027 版写作 `Bip2Fbx`，取值都只写 `True or False`），官方从未解释它到底改什么；当前 FBX 导出对话框的 Geometry、Animation、Advanced Options 文档里都没有这个选项。从名字（Biped → FBX）与它被放在 **Geometry** 分组而不是 Animation 分组来看，最合理的理解是：它把 Biped 这种“非普通骨骼”转换成普通 FBX 骨骼/节点（官方 Biped 文档确实把“导出 FBX 再导入”描述为把 Biped 变成一套动画骨骼的方法），但“是否写 bind pose、是否重映射轴、是否只管几何”没有官方定义。2027.2 的受控实验表明：只把这一条设为 `true`，67 个 Biped 节点的烘焙曲线全部归零、文件恰好少掉约 0.9 MB 的关键帧数据；设为 `false` 或不写则 67/67 有曲线。机制上最可能的是 Biped→普通骨骼的转换发生在几何导出阶段，烘焙采样写在了被替换/不再承载动画的那套节点上，从而整段轨道没有落地；但这只是推断，Autodesk 没有公开 bug 记录。工程结论很简单：**这是“毒参数”，138 个场景的批处理永远不要把它设为 true**；默认应为 false（`ResetExport` 后最小集可正常导出即为证据），但“默认值”本身官方没有文档化。

---

## 1. 证据表

| # | 主张 / 结论 | 来源类型 | URL | 原文 / 观察（短引） | 置信度 |
|---|---|---|---|---|---|
| 1 | 3ds Max 2027 MaxScript 官方参数表仍列出 `Bip2Fbx`，但只给 True/False，无任何语义说明 | 【官方】 | <https://help.autodesk.com/cloudhelp/2027/ENU/MAXScript-Help/files/MAXScript-Tools-and-Interaction/Interacting-with-the-3ds-Max/FBX-Import-and-Export-Dialog/GUID-54B1F140-B304-48A2-9829-C68B345E2044.html> | 表项：`"Bip2Fbx" \| True or False.`（同一张表里 `BakeAnimation`、`BakeFrameStart/End/Step`、`BakeResampleAnimation` 均有明确名字，仍无解释） | 高 |
| 2 | 2012 版官方参数表把同一开关写作 `Bip2FBX`（大写 FBX），说明它是至少从 2012 就存在的遗留项 | 【官方·旧版】 | <https://download.autodesk.com/us/fbx/3ds_max_help/fbx_3dsmax_online/files/WS644c7983f449f2df-53d205c5113e574e97c-8000.htm> | 表项：`Bip2FBX \| True or false`；同页还写“FBXExporterSetParam returns OK … or unsupplied if it is sent an unrecognized parameter” | 高 |
| 3 | 2024 版官方 MaxScript 参数表**没有** `Bip2Fbx`/`Bip2FBX`（2027 又出现），说明文档覆盖本身不稳定 | 【官方】 | <https://help.autodesk.com/cloudhelp/2024/ENU/MAXScript-Help/files/MAXScript-Tools-and-Interaction/Interacting-with-the-3ds-Max/FBX-Import-and-Export-Dialog/GUID-54B1F140-B304-48A2-9829-C68B345E2044.html> | 2024 表从 `BakeResampleAnimation` 直接跳到 `Cameras`，无 Bip2Fbx | 高 |
| 4 | 该参数的真实内部名与属性路径：`IOSN_BIP2FBX "Bip2Fbx"`；`EXP_BIP2FBX` 挂在 **Geometry** 组下 | 【官方·SDK】 | <https://download.autodesk.com/global/docs/FBXsdk2012/en_us/cpp_ref/kfbxiosettingspath_8h.html>；<http://docs.autodesk.com/FBX/2014/ENU/FBX-SDK-Documentation/cpp_ref/fbxiosettingspath_8h_source.html>；<https://raw.githubusercontent.com/simnalamburt/SoftwareRasterizer/master/FBX/include/fbxsdk/fileio/fbxiosettingspath.h> | SDK 2012：`#define IOSN_BIP2FBX "Bip2Fbx"`；SDK 2014 源码：`#define EXP_BIP2FBX EXP_GEOMETRY \| IOSN_BIP2FBX`（GitHub 上的 SDK 头文件镜像同样给出这一行） | 高 |
| 5 | 当前 FBX 导出对话框的 **Geometry** 页没有 Biped 相关选项（只有 Smoothing Groups / Split Per-Vertex Normals / Tangents / TurboSmooth / Preserve Instances / Selection Sets / Convert Deforming Dummies to Bones / Triangulate / Preserve edge orientation） | 【官方】 | <https://help.autodesk.com/cloudhelp/2024/ENU/3DSMax-Interoperability/files/GUID-249100FE-67BE-43B8-AF12-D20703CDF8D1.htm> | 该页从 Smoothing Groups 讲到 Preserve edge orientation，全文无 “Biped”/“Bip2Fbx” | 高 |
| 6 | **Advanced Options** 页也没有 Biped/Bip2Fbx；只有 Units / Axis Conversion / UI / FBX File Format / Collada | 【官方】 | <https://help.autodesk.com/cloudhelp/2025/ENU/3DSMax-Interoperability/files/GUID-94C10F56-EE1D-45E1-9858-7AA9E99CE25D.htm> | 全页无 Biped/Bip2Fbx | 高 |
| 7 | 官方明确：Bake Animation 会把**包括 3ds Max Biped**在内的不支持控制器重采样成动画曲线 | 【官方】 | <https://help.autodesk.com/cloudhelp/2024/ENU/3DSMax-Interoperability/files/GUID-31EA2A4F-A126-498B-96E8-31811522738A.htm>；中文：<https://help.autodesk.com/cloudhelp/2024/CHS/3DSMax-Interoperability/files/GUID-31EA2A4F-A126-498B-96E8-31811522738A.htm> | “When you activate this option all unsupported constraints and controllers, including the 3ds Max Biped, are resampled into animation curves.”／“激活此选项后，所有不受支持的约束和控制器（包括 3ds Max Biped）都会重采样为动画曲线。” | 高 |
| 8 | “Resample All”= 连受支持的动画元素也强制烘焙；且它依赖 Bake Animation：Bake Animation 关闭时不可用；采样率取宿主帧率 | 【官方】 | 同上（Animation 页） | “Use the Resample all option to bake even supported animated elements… The Resample all option reacts to the state of the Bake animation option. If the Bake Animation option is disabled, the Resample all option is unavailable.” | 高 |
| 9 | Biped 动画层只是“有条件支持”；用 Media & Entertainment 默认预设时只导出高亮那一层 | 【官方】 | <https://help.autodesk.com/cloudhelp/2024/ENU/3DSMax-Interoperability/files/GUID-511AE209-156C-4406-85B1-4266FEA57834.htm>；中文：<https://help.autodesk.com/cloudhelp/2024/CHS/3DSMax-Interoperability/files/GUID-511AE209-156C-4406-85B1-4266FEA57834.htm> | “The 3ds Max FBX plug-in conditionally supports Biped animation layers. If you highlight a layer and export it with the Media & Entertainment default preset, you will only export the animation from that specific layer.” | 高 |
| 10 | Bake 的 Start/End/Step **不能**存进 preset；preset 加载后插件总是回到场景时间线 | 【官方】 | 同上（FBX Limitations → Preset Bake Animation Settings） | “You cannot save Bake Animation settings (Start/End/Step values) in Preset files… the FBX plug-in will always default to the values set for the scene's timeline.” | 高 |
| 11 | `ResetExport` 无参调用 = 恢复出厂默认，3ds Max 下即加载 Autodesk Media & Entertainment 预设 | 【官方】 | 2027 MaxScript 表（同 #1） | “Restores factory defaults. If ResetExport is called without argument for: 3DS Max: Loads the Autodesk Media & Entertainment export preset.” | 高 |
| 12 | Media & Entertainment 是 3ds Max 导出器的默认预设 | 【官方】 | <https://help.autodesk.com/cloudhelp/2021/ENU/3DSMax-Data-Exchange/files/GUID-876CC7E3-A666-46D4-8452-BD0D36C2FB6B.htm> | “Autodesk Media and Entertainment is the default preset for the 3ds Max Exporter.” | 高 |
| 13 | MaxScript 设参数的前提：FBX 导出插件必须已加载；否则先用 `pluginManager.loadClass FbxExporter` 载入 | 【官方】 | 2027 MaxScript 表（同 #1） | “Note: The FBX Export Plugin must be loaded in memory in order to set its properties. If it is not in memory, it can be loaded using pluginManager.loadClass FbxExporter” | 高 |
| 14 | 若导出时 UI 弹出，会采用“上次用过的 preset”，从而忽略脚本刚设的值；必须 `#noPrompt` | 【官方·旧版】 | <https://download.autodesk.com/us/fbx/3ds_max_help/fbx_3dsmax_online/files/WS1a9193826455f5ff-54f556ca1166ac9ee9e-4a80.htm> | “If the UI appears before an export or import command executed through MAXScript, the last used preset is chosen, and effectively ignores any recent scripted changes.” | 高 |
| 15 | `FBXExporterGetParam "FBXProperties"` 可以列出导出分支的全部属性；FBX 脚本人肉查表时名字与 SetParam 名字并不一致（`BakeComplexAnimation` vs `BakeAnimation`） | 【官方】+【社区】 | <https://help.autodesk.com/cloudhelp/2026/ENU/3DSMax-Interoperability/files/GUID-FE043A70-A2DC-4CE6-9F47-7489C2A447FF.htm>；<https://www.tech-artists.org/t/maxscript-fbx-export-option-control/3305> | 官方：“FBXExporterGetParam ‘FBXProperties’ … list all the export properties available with path, type, and the specified value.” 社区帖 #7：“the property names returned … are not the same names you must use with FBXExporterSetParam ‘BakeComplexAnimation’ vs ‘BakeAnimation’ for example…fun!” | 高（官方部分）/中（社区部分） |
| 16 | 社区经验：2012 时代 MaxScript 钩子不可靠，设了也不一定覆盖手动导出时的 GUI；预设/直接改默认 preset 更稳 | 【社区】 | <https://www.tech-artists.org/t/maxscript-fbx-export-option-control/3305>；<https://realtimevfx.com/t/max-fbx-export-gotchas/705> | Tech-Artists #4：“the maxscript hooks for the settings are broken”；RealtimeVFX：“‘Resample All’ is turned off by default and settings are not persistant… The recommended ‘FBXImporterSetParam’ functions … completely don't work.” | 中 |
| 17 | 真实 `.fbxexportpreset` 中：`Animation` 是 Bool 总闸；`BakeComplexAnimation` 的 UI 名是 “Bake Animation”；其子项 `ResampleAnimationCurves` 的 UI 名是 “Resample All”；两个 preset 里都**没有** `Bip2Fbx` 节点 | 【社区·仓库文件】 | <https://raw.githubusercontent.com/Makiah/BotW-SBFRES-to-FBX/master/fbxextraction/BotW%20Export%20Preset.fbxexportpreset>；<https://raw.githubusercontent.com/cmcpasserby/pbUDK/master/scripts/UDKexport/UDK-FBX.fbxexportpreset> | `<Animation … dt="Bool" v="0">`；`<BakeComplexAnimation … lbENU="Bake Animation" dt="Bool" v="0">`；`<ResampleAnimationCurves … lbENU="Resample All" dt="Bool" v="0"/>` | 高（文件本身） |
| 18 | Autodesk 对“Biped→FBX”的唯一概念性描述：把 Biped 变成一套动画骨骼的办法就是导出 FBX 再导入 | 【官方·旧版】 | <https://download.autodesk.com/us/3dsmax/2012help/files/GUID-606356A7-B8CD-434A-A6E3-584419830A2-1500.htm> | “To transform an animated biped into a set of animated bones, export it to FBX and then import your file.” | 高 |
| 19 | 2012 官方帮助的 Bake animation 页同样明确“包括 3ds Max Biped” | 【官方·旧版】 | <https://download.autodesk.com/us/fbx/3ds_max_help/fbx_3dsmax_online/files/WS1a9193826455f5ff-6d855556117c4584e5420a5.htm> | “This bakes all unsupported constraints and controllers, including the 3ds Max Biped, into animation curves.” | 高 |
| 20 | 公开网络上几乎没有对 `Bip2Fbx` 语义的讨论/解释；能搜到的实质来源只有 Autodesk 的 2012 表、2027 表、FBX SDK 头文件 | 【观察】 | 检索结果见 §6 | 精确引号搜索在 Brave/Bing 上只命中上述官方页；论坛/博客/知乎/CSDN 无 “Bip2Fbx 是什么/怎么用”的页面（CSDN 相关页面的脚本里也没实际使用该参数） | 中 |
| 21 | 2025.3 修复了 CAT/Biped 的“Unsupported controller”误报警告；官方口径是“CAT 与 Biped 控制器一直是支持的” | 【官方·检索摘要】 | <https://help.autodesk.com/view/3DSMAX/2025/ENU/?guid=GUID-5A669C78-50B5-4CE6-9C52-FDA08114970B>；第三方转述：<https://www.andvfx.com/3ds-max-2025-3/> | “CAT and Biped controllers have always been supported but now they no longer generate FBX warning messages.”（该页面为 JS 渲染，正文由搜索摘要与第三方转述交叉确认） | 中 |
| 22 | 2027.2 单变量实测：最小集 = 67/67 Biped 有曲线；最小集 + `Bip2Fbx true` = 0/67，文件正好小 ~0.9 MB | 【本地实测】 | 本仓库 `tests/tmp/adv-pilot-v3/fbx-pilot-v2-gui/REPORT-v3-rootcause-and-fix.md` §1 | C（最小集）8,147,040 B / 67/67；F/G（+Bip2Fbx true）7,223,776 B / 0/67；E（+Bip2Fbx false）8,147,040 B / 67/67 | 高（本机） |
| 23 | 旧实验矩阵里 “一次堆 7 个参数也归零（V6/H）” 可能被 `Bip2Fbx` 残留污染：V6 在同一进程里紧跟 V4/V5（二者 set true），而 `ResetExport` 是否会清掉该隐藏项没有验证 | 【本地·疑点】 | `tests/tmp/adv-pilot-v3/fbx-pilot-v2-gui/scripts/exp3.ms`（`goodBase()` 调 ResetExport；`runVariant "V4_BIP2FBX"` → `V5_Bip2Fbx` → `V6_GEOGRP`） | 若 ResetExport 不清 `Bip2Fbx`，V6 的 0/67 就不是“堆参数”造成，而是继承 true；需要干净进程复测 | 待验证 |
| 24 | 2027.2 上 `Bip2Fbx` 的两种拼写都被接受并回读为 true | 【本地实测】 | `tests/tmp/adv-pilot-v3/fbx-pilot-v2-gui/diag/exp1.txt` | `Bip2FBX -> OK`；`Bip2Fbx -> OK`；`get Bip2Fbx -> true` | 高（本机） |
| 25 | SDK 头文件的层级证明：`BakeFrameStart/End/Step` 与 `ResampleAnimationCurves` 都是 `BakeComplexAnimation` 的子项，而 `BakeComplexAnimation` 又在 `Animation` 下；同一 Geometry 组里还放着 `AnimationOnly`（Maya 里叫 “Convert to Null objects”）这类“对象转换”开关 | 【官方·SDK】 | 同 #4（GitHub 镜像可读全文） | `EXP_BAKEFRAMESTART EXP_BAKECOMPLEXANIMATION "\|" IOSN_BAKEFRAMESTART`；`EXP_BAKE_RESAMPLE_ANIMATION_CURVES EXP_BAKECOMPLEXANIMATION "\|" IOSN_RESAMPLE_ANIMATION_CURVES`；`EXP_ANIMATIONONLY EXP_GEOMETRY "\|" IOSN_ANIMATIONONLY` | 高 |

---

## 2. `Bip2Fbx` 到底是什么

### 2.1 官方能确认的（事实）

1. **它是一个真实存在的导出参数**，至少从 2012 到 2027 都在 MaxScript 参数表里；2012 写作 `Bip2FBX`，2027 写作 `Bip2Fbx`，取值都是 `True or False`（证据 #1、#2）。
2. **它的内部实现名是 `Bip2Fbx`，挂在 Geometry 组**：FBX SDK 头文件里 `IOSN_BIP2FBX` 的字符串值是 `"Bip2Fbx"`，`EXP_BIP2FBX` 展开为 `EXP_GEOMETRY "|" IOSN_BIP2FBX`（证据 #4）。这意味着它不是 Animation 组的子项，也不在 “Bake Animation / Resample All” 这一支下面。
3. **它不是当前 UI 的可见选项**：2024/2025 的 Geometry 页、Advanced Options 页都没有它（证据 #5、#6）；2013 版 Geometry 页的目录同样只有 Smoothing Groups / Split Per-Vertex Normals / Tangents / TurboSmooth / Preserve Instances / Selection Sets / Convert Deforming Dummies to Bones / Triangulate / Preserve edge orientation（已抓取 2013 静态页核对）。
4. **官方没有任何一句解释它做什么**：没有 “converts Biped to …”“writes bind pose”“remaps axes” 之类的描述；2027 表只重复 `True or False`。
5. **`Bip2Fbx` 在真实 preset XML 里不存在**（两个不同来源的 2014/2015 用户 preset 都没有该节点，证据 #17），所以它也不像是靠 preset 暴露给用户的常规选项。

### 2.2 只能推断的（明确标注为推断）

- **推断 A（最合理）**：`Bip2Fbx` = “Biped to FBX”，把 Biped 专用对象/控制器转换成普通 FBX 骨骼节点。理由：
  - 名字直译；
  - 它挂在 `Geometry` 组，符合“把特殊对象转换成普通节点”的转换类开关（同组还有 NURB/Patch→mesh、`AnimationOnly`=“Convert to Null objects” 这类转换）；
  - Autodesk 的 Biped 文档把“变成一套动画骨骼”描述为“导出 FBX 再导入”（证据 #18）；
  - 2010 版 FBX 插件指南把 Biped 相关能力放在 “Biped merge-back workflow”（3ds Max ↔ MotionBuilder）语境下。
- **推断 B**：它可能只影响“Biped 如何被写成骨架/几何”，而不直接控制动画；真正让动画消失的是转换后节点与烘焙轨道的错配（见 §3）。
- **没有依据、不要写进管线文档的说法**：它“写 bind pose”、“重映射轴”、“必须打开才能导出 Biped 蒙皮”、“只影响 Biped 显示”等。官方和社区都没有这类说明。

### 2.3 为什么 2027 文档里又出现了

2024 表没有、2027 表有（证据 #1、#3）。这更像文档维护的来回，而不是功能新增：2012 表就有同名项，且 2027.2 的运行时确实接受并回读它（证据 #24）。不能据此推断 “2027 新增了 Bip2Fbx 功能”。

---

## 3. 为什么设为 true 会让烘焙动画消失

### 3.1 已确认的实测事实

- 同一场景、同一机器、同一 `exportFile … using:FBXEXP` 路径：
  - 最小集（`ResetExport` + `Animation` + `BakeAnimation` + `BakeResampleAnimation` + 帧范围/步长）→ 8,147,040 B，`Bip001*` 67/67 有动画；
  - 最小集 + `Bip2Fbx true` → 7,223,776 B，`Bip001*` 0/67；
  - 最小集 + `Bip2Fbx false` → 8,147,040 B，67/67（与不写完全一致）。
- 差的 ~0.9 MB 正好是 67 根骨 × 84 帧的烘焙轨道量级；说明 **Bake 本身跑了，丢的是“Biped 这套节点上的曲线数据”**，不是整个动画阶段没执行。
- 两种拼写（`Bip2FBX` / `Bip2Fbx`）效果相同；不是“参数名写错被忽略”的问题。

### 3.2 可能的机制（按可能性排序，均未被官方证实）

1. **转换发生在几何阶段，替换了烘焙目标**：`Bip2Fbx` 在 Geometry 组，若它把 Biped 对象转换成一套新的普通骨骼节点，而 Bake 采样/曲线写入仍指向原 Biped 成员（或反之），最终 FBX 里那套节点就没有 AnimationCurve 连接。文件体积的减少与“曲线没写进去”一致。
2. **它切换到 Biped 的原生导出路径，绕过了 Resample**：Biped 的动画存在控制器（BipSlave）里，节点自身 TRS 关键帧很少；如果 `Bip2Fbx` 让导出器按“原生 Biped”方式读取节点关键帧而不做重采样，就会得到 0 条曲线。
3. **它让 Biped 以 bind pose/静态骨架写出**：转换时取当前/绑定姿态，动画通道被丢弃。这个说法在社区很常见，但**没有任何官方或可复现的公开记录**支持，只能算猜测。

### 3.3 一次 ASCII 导出即可区分（建议的验证，不需要改仓库）

在 2027.2 上对同一场景导出两份 ASCII FBX（`FBXExporterSetParam "ASCII" true`，官方表支持）：

- A：最小集；
- B：最小集 + `Bip2Fbx true`。

然后比较：
- `Objects` 里 `Model` 节点数量、名字、`LimbNode` 类型是否变化（转换会新增/改名/改类型）；
- `AnimationCurveNode`/`AnimationCurve` 的 `OP` 连接目标 ID：A 应连到 `Bip001*` 的 Model ID，B 看是否连到“另一套”节点或完全没有；
- 是否有 `Pose`/`BindPose` 变化、`Properties70` 里是否多出 Biped 相关 user property；
- 若 B 的节点数/名字与 A 完全一致、只是没有曲线，则更支持机制 2（绕过采样）而不是机制 1（替换节点）。

---

## 4. 138 场景批处理的推荐参数集

> 前提：每台机器/每个 batch 进程只跑一个 3ds Max 实例；所有调用都 **`try` 包裹 + 回读**；导出用 `exportFile ... #noPrompt ... using:FBXEXP`。

### 4.1 REQUIRED（必须设，且要回读）

| 参数 | 值 | 理由 |
|---|---|---|
| `ResetExport` | 无值 | 官方：恢复出厂默认，3ds Max 下加载 M&E 预设（证据 #11）。先清掉上一个文件/上一次 GUI 的残留。 |
| `Animation` | `true` | 动画总闸；Bake 组是 Animation 的子项（preset XML 里 `<Animation>` 包住 `<BakeComplexAnimation>`，证据 #17）。不开它，后面全白设。 |
| `BakeAnimation` | `true` | 官方：把包括 3ds Max Biped 在内的不支持控制器重采样成曲线（证据 #7）。**这是 Biped 动画的生命线。** |
| `BakeResampleAnimation` | `true` | 对应 UI 的 **Resample All**：连受支持的动画元素也按宿主帧率逐帧烘焙（证据 #8、#17）。不开则只有“不支持控制器”被选择性烘焙，无法保证 332 根骨统一逐帧。SDK 头文件还证明它是 `BakeComplexAnimation` 的子项，BakeAnimation 不开它不会生效（证据 #25）。 |
| `BakeFrameStart` / `BakeFrameEnd` / `BakeFrameStep` | 场景范围 / `1` | 官方说这些值 preset 存不住、默认取场景时间线（证据 #10）；脚本里显式设可避免 0–100 之类的默认范围。注意 83.5 → 84 向上取整；`End` 在 2027.2 可回读验证。 |

最小调用序列（与本地已验证的 v3 一致）：

```maxscript
try ( FBXExporterSetParam "ResetExport" ) catch()
try ( FBXExporterSetParam "Animation" true ) catch()
try ( FBXExporterSetParam "BakeAnimation" true ) catch()
try ( FBXExporterSetParam "BakeResampleAnimation" true ) catch()
try ( FBXExporterSetParam "BakeFrameStart" startFrame ) catch()
try ( FBXExporterSetParam "BakeFrameEnd"   endFrame   ) catch()
try ( FBXExporterSetParam "BakeFrameStep"  1          ) catch()
```

### 4.2 DANGEROUS / DO-NOT-SET（会改变结果或引入不确定性）

| 参数 | 不要设的值 | 为什么 |
|---|---|---|
| `Bip2Fbx` / `Bip2FBX` | **绝对不要 `true`** | 本机实测：67/67 → 0/67，文件少 ~0.9 MB（证据 #22）。语义无官方文档，属“打开就丢烘焙”的毒开关。 |
| `FilterKeyReducer` | 不要 `true` | 它会删/降关键帧（UI 的 Key Reducer）。默认 false；批量要保留逐帧采样精度。 |
| `Removesinglekeys` | 不要 `true` | 会移除单关键点对象的关键帧；对“静止骨也应有恒定轨道”的下游采样不利。 |
| `Resampling` | 不要设 | 旧参数（Float），当前文档无语义；Resample All 已经按宿主帧率采样，额外设它只会引入版本差异。 |
| `GeomAsBone` / `MaxBoneAsBone` | 不要为了动画去设 `true` | 这是“Convert Deforming Dummies to Bones”，面向几何/蒙皮互操作，不是 Biped 动画开关；可能改变节点类型。 |
| `ExportAnimationOnly` | 不要设 `true` | 隐藏参数（2019.1+），会把导出限制为纯动画；本管线要骨骼 + 可能的网格，别碰。 |
| `SplitAnimationIntoTakes` | 不要设 | 会按 take 拆动画，破坏单 take 假设。 |
| `PushSettings` / `PopSettings` | 不要混用 | 全局 I/O 设置栈，容易把上一个文件的设置带进来；用 `ResetExport` 就够。 |
| `ConvertUnit` / `ScaleFactor` | 不要乱设 | 2027.2 上这两个参数在旧脚本探针里曾抛 `EXCEPTION`；让导出器按场景单位走（Automatic/1.0）。 |
| `LoadExportPresetFile` | 不要加载来路不明的 preset | preset 会带隐藏状态（且官方说 bake 帧范围存不住）。若必须用，固定 hash、加载后回读关键项。 |
| `Skin` / `Shape` | 动画导出不需要时不要 `true` | 会显著增大文件、拖慢 138 个场景；但这不是 Biped 丢动画的原因。 |

### 4.3 OPTIONAL / DEFENSIVE（可选，但建议做）

| 参数/动作 | 建议 | 说明 |
|---|---|---|
| `Bip2Fbx` 显式 `false` | **可选防御** | 变体 E 证明 false 与“不写”结果完全一致（8,147,040 B / 67/67）。如果 138 个文件在**同一个 batch 进程**里连续导出，而任何历史代码/预设可能把它设成 true，显式 false + 回读是最便宜的保险。若确定每文件干净进程/从未设过，可不写。 |
| 回读 `FBXExporterGetParam "Bip2Fbx"` | **建议每个文件都做** | 2027.2 支持 get；一旦为 true，立刻 `set false` 并记日志。 |
| 回读 `Animation` / `BakeAnimation` / `BakeResampleAnimation` | **建议** | 防止静默归零（本地 v3 已这么做）。 |
| `UpAxis "Y"` | 可设 | M&E 预设默认 Y-up（官方 Advanced Options 页）；设了不改变 Biped 烘焙。 |
| `Cameras false` / `Lights false` / `EmbedTextures false` | 可设 | 减小体积、避免缺贴图弹窗；与根因无关。 |
| `ShowWarnings false` / `GenerateLog true` | 可设 | 批处理少弹窗，但保留日志。 |
| `UseSceneName true` | 可选 | 让 take 名跟场景名走，便于 138 个文件追溯；不影响骨骼。 |

### 4.4 每个文件的自检协议（防止再次“静默 0 曲线”）

1. `ResetExport` → 逐项设 REQUIRED → 逐项 `FBXExporterGetParam` 回读，写进 CSV/日志；
2. 特别检查 `Bip2Fbx`：若为 true，set false，再回读；
3. `exportFile` 带 `#noPrompt`；
4. 导出后二选一验证：
   - 重新导入空场景，统计 `matchPattern o.name "Bip001*"` 的 `isAnimated` 数量（v3 的做法，67/67 为通过）；
   - 或直接解析 FBX（ASCII 或二进制），确认 `Bip001*` 的 Model 节点上挂着 AnimationCurveNode；
5. 出现 `0/67` 立即 `WARN` 并停止该文件，不要静默继续。

### 4.5 关于 `ResetExport` 的一个必须知道的风险

本地 exp3 的顺序是 V4（`Bip2FBX true`）→ V5（`Bip2Fbx true`）→ V6（7 个几何参数，**没有再设 Bip2Fbx**），V6 也是 0/67。如果 `ResetExport` 并不会把这个隐藏属性清回 false，那么 V6 的失败就是“继承 true”，而不是“堆参数”本身——这会直接改变批量脚本的写法。**上线 138 前，用一次干净进程做这个 30 秒实验**：

```maxscript
-- 干净启动 3dsmaxbatch，不加载任何旧脚本
format "default Bip2Fbx = %\n" (FBXExporterGetParam "Bip2Fbx")
FBXExporterSetParam "Bip2Fbx" true
FBXExporterSetParam "ResetExport"
format "after ResetExport = %\n" (FBXExporterGetParam "Bip2Fbx")
```

- 若 `after ResetExport = false`：`ResetExport` 足够，V6 的结论可按“堆参数”解释（但仍建议最小集）；
- 若 `after ResetExport = true`：**必须**在每个文件显式 `Bip2Fbx false`（或每文件独立进程），否则一个文件设过 true 会污染后面全部 138 个。

---

## 5. 未确认 / 开放问题

1. **`Bip2Fbx` 的精确语义**：是“Biped→普通骨骼”、只写 bind pose、还是只改节点类型？Autodesk 没有任何文字说明；FBX SDK 头文件只有宏名，没有注释。
2. **默认值**：官方未文档化。由“`ResetExport` 后最小集 67/67”推断为 false/off（中等偏高），但没有在干净进程里 `get` 过默认值。
3. **`ResetExport` 是否清 `Bip2Fbx`**：未验证；这是 §4.5 的 30 秒实验，直接影响 138 个文件能否在同一进程里安全连跑。
4. **V6/H（7 参数堆叠归零）是否被污染**：见证据 #23；需要干净进程复测，才能判断“参数堆叠”本身是否真的有害。
5. **为什么 true 会丢曲线**：§3.2 的三种机制都未证实；需要 ASCII FBX 节点级对比（§3.3）。
6. **2025.3 及之后版本是否改过 Bip2Fbx 行为**：官方 2025.3 只提到修了 CAT/Biped 的误报警告；没有 Bip2Fbx 相关条目。2027.2 的实测是当前唯一硬证据。
7. **FBX 插件具体版本号**：3ds Max 2027.2 随附的 FBX plug-in 版本未在本次抓取中确认；这不影响“不要设 true”的结论。
8. **中文社区**：没有找到对 `Bip2Fbx` 的实质讨论（CSDN 相关页 521/正文不含该参数；知乎/B 站/ CGJoy 未见）。中文资料只能确认“Biped 必须 Bake”这一层，无法补充 Bip2Fbx 语义。

---

## 6. 抓取记录

### 6.1 实际抓取成功且用于本文的 URL

Autodesk 官方（帮助/文档）：

1. <https://help.autodesk.com/cloudhelp/2027/ENU/MAXScript-Help/files/MAXScript-Tools-and-Interaction/Interacting-with-the-3ds-Max/FBX-Import-and-Export-Dialog/GUID-54B1F140-B304-48A2-9829-C68B345E2044.html>
2. <https://help.autodesk.com/cloudhelp/2024/ENU/MAXScript-Help/files/MAXScript-Tools-and-Interaction/Interacting-with-the-3ds-Max/FBX-Import-and-Export-Dialog/GUID-54B1F140-B304-48A2-9829-C68B345E2044.html>
3. <https://download.autodesk.com/us/fbx/3ds_max_help/fbx_3dsmax_online/files/WS644c7983f449f2df-53d205c5113e574e97c-8000.htm>
4. <https://download.autodesk.com/us/fbx/3ds_max_help/fbx_3dsmax_online/files/WS1a9193826455f5ff-54f556ca1166ac9ee9e-4a80.htm>
5. <https://download.autodesk.com/us/fbx/3ds_max_help/fbx_3dsmax_online/files/WS1a9193826455f5ff-6d855556117c4584e5420a5.htm>
6. <https://help.autodesk.com/cloudhelp/2024/ENU/3DSMax-Interoperability/files/GUID-31EA2A4F-A126-498B-96E8-31811522738A.htm>
7. <https://help.autodesk.com/cloudhelp/2027/ENU/3DSMax-Interoperability/files/GUID-31EA2A4F-A126-498B-96E8-31811522738A.htm>
8. <https://help.autodesk.com/cloudhelp/2024/CHS/3DSMax-Interoperability/files/GUID-31EA2A4F-A126-498B-96E8-31811522738A.htm>
9. <https://help.autodesk.com/cloudhelp/2024/ENU/3DSMax-Interoperability/files/GUID-511AE209-156C-4406-85B1-4266FEA57834.htm>
10. <https://help.autodesk.com/cloudhelp/2024/CHS/3DSMax-Interoperability/files/GUID-511AE209-156C-4406-85B1-4266FEA57834.htm>
11. <https://help.autodesk.com/cloudhelp/2024/ENU/3DSMax-Interoperability/files/GUID-C3389EE9-18A9-47EC-8222-EA94BD665FF8.htm>
12. <https://help.autodesk.com/cloudhelp/2017/ENU/3DSMax/files/GUID-21B5781D-5D3D-40E7-8620-587BEC650C5D.htm>
13. <https://help.autodesk.com/cloudhelp/2024/ENU/3DSMax-Interoperability/files/GUID-249100FE-67BE-43B8-AF12-D20703CDF8D1.htm>
14. <https://help.autodesk.com/cloudhelp/2025/ENU/3DSMax-Interoperability/files/GUID-94C10F56-EE1D-45E1-9858-7AA9E99CE25D.htm>
15. <https://help.autodesk.com/cloudhelp/2025/ENU/3DSMax-Interoperability/files/GUID-EB0F5BB7-2E59-4EF6-8B16-F59CC56A4747.htm>
16. <https://help.autodesk.com/cloudhelp/2021/ENU/3DSMax-Data-Exchange/files/GUID-876CC7E3-A666-46D4-8452-BD0D36C2FB6B.htm>
17. <https://help.autodesk.com/cloudhelp/2026/ENU/3DSMax-Interoperability/files/GUID-FE043A70-A2DC-4CE6-9F47-7489C2A447FF.htm>
18. <https://help.autodesk.com/cloudhelp/2024/ENU/3DSMax-Interoperability/files/GUID-B923385A-16E2-49D3-8CE2-0062DC5B90F7.htm>
19. <https://download.autodesk.com/us/3dsmax/2012help/files/GUID-606356A7-B8CD-434A-A6E3-584419830A2-1500.htm>
20. <https://download.autodesk.com/us/fbx/2013/3ds_Max_FBX_Plug-in_Help/files/GUID-6C4472B1-F5AF-47BA-B1E1-D9AB47E871D8.htm>
21. <https://download.autodesk.com/us/fbx/2013/3ds_Max_FBX_Plug-in_Help/files/GUID-249100FE-67BE-43B8-AF12-D20703CDF8D1.htm>

Autodesk 官方（FBX SDK 头文件/文档）：

22. <https://download.autodesk.com/global/docs/FBXsdk2012/en_us/cpp_ref/kfbxiosettingspath_8h.html>
23. <https://download.autodesk.com/global/docs/FBXsdk2012/en_us/cpp_ref/kfbxiosettingspath_8h_source.html>
24. <http://docs.autodesk.com/FBX/2014/ENU/FBX-SDK-Documentation/cpp_ref/fbxiosettingspath_8h_source.html>
25. <https://download.autodesk.com/global/docs/FBXsdk2012/en_us/files/GUID-50489A8A-457C-4B54-80E1-5572A16F7F1-31.htm>

社区 / 第三方：

26. <https://www.tech-artists.org/t/maxscript-fbx-export-option-control/3305>
27. <https://realtimevfx.com/t/max-fbx-export-gotchas/705>
28. <https://raw.githubusercontent.com/Makiah/BotW-SBFRES-to-FBX/master/fbxextraction/BotW%20Export%20Preset.fbxexportpreset>
29. <https://raw.githubusercontent.com/cmcpasserby/pbUDK/master/scripts/UDKexport/UDK-FBX.fbxexportpreset>
30. <https://silo.tips/download/autodesk-3ds-max-fbx-plug-in-20102-user-guide>（2010.2 指南全文，用于确认当时没有 Bip2Fbx UI 说明）
31. <https://www.andvfx.com/3ds-max-2025-3/>（2025.3 Biped/FBX 修复的第三方转述）
32. <https://help.autodesk.com/view/3DSMAX/2025/ENU/?guid=GUID-5A669C78-50B5-4CE6-9C52-FDA08114970B>（Autodesk “Animation updates”，页面 JS 渲染；引用其索引摘要）
33. <https://raw.githubusercontent.com/simnalamburt/SoftwareRasterizer/master/FBX/include/fbxsdk/fileio/fbxiosettingspath.h>（FBX SDK 头文件镜像，用于读全 `EXP_BIP2FBX`、`EXP_BAKEFRAMESTART` 等定义）

### 6.2 失败/不可用的 URL（如实记录）

- `http://images.autodesk.com/adsk/files/3ds_max_fbx__plugin_2012.pdf` —— `web_fetch` 不支持 PDF（`unsupported content type "application/pdf"`），无法抽取正文。
- `https://r.jina.ai/http://images.autodesk.com/adsk/files/3ds_max_fbx__plugin_2012.pdf` 及 `https://r.jina.ai/https://download.autodesk.com/us/fbx/2013/3ds_Max_FBX_Plug-in_Help/index.html` —— `fetch failed`（代理不可用）。
- `https://forums.autodesk.com/t5/forums/searchpage/tab/message?q=Bip2Fbx` —— HTTP 403（Cloudflare “Just a moment...”），无法站内检索论坛。
- `https://ask.csdn.net/questions/9075879` —— HTTP 521（Cloudflare 源站错误），中文“Bip 批量转 FBX 动作丢失”页未能读取。
- `https://dokumen.tips/documents/user-guide-autodeskimagesautodeskcomadskfiles3dsmaxfbxpluginhelppdfpdf.html` —— `fetch failed`（改用 silo.tips 成功）。
- `https://discussions.unity.com/t/3ds-max-biped-fbx-oddity/413905/3` —— `unsupported content type "unknown"`。
- 搜索入口：`html.duckduckgo.com`（人机挑战）、`mojeek.com`（403）、`yandex.com`（验证码）、`startpage.com`（JS 验证）、`google.com.hk`（JS 空页）、`searx.be`（fetch failed）。
- `https://help.autodesk.com/cloudhelp/2025/ENU/3DSMax-Release-Notes/files/3dsMax_ReleaseNotes_3dsmax_2025_3_releasenotes_html.htm`、`.../3DSMax-WhatsNew/files/GUID-5A669C78-50B5-4CE6-9C52-FDA08114970B.htm` —— 404；2025.3 官方 release notes 的静态 URL 未定位到。
- `https://help.autodesk.com/view/3DSMAX/2027/CHS/?guid=GUID-606356A7-...` —— 返回 JS 壳“Help”，正文不可读；已改用 `cloudhelp/2024/CHS` 与 `download.autodesk.com/.../2012help` 静态页。

---

## 7. 附：与旧文档的冲突提醒

本仓库此前的 `docs/research/max-windows-routes.md` §12.3.1/§12.3.2 曾把 `Bip2FBX true` 写成“Biped 专用关键开关”“强烈建议显式打开”。**该建议已被 2027.2 单变量实验证伪**（本文证据 #22）：它正是导致 Biped 烘焙曲线归零的那一条。后续任何导出脚本都不应再执行 `Bip2Fbx true`；如需防御，只允许显式 `false` + 回读。
