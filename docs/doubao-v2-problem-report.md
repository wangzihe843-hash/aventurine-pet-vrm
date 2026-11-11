# 给豆包（Windows 侧）：fbx-pilot-v2 问题报告与改进方案

> 对象：你回传的 `fbx-pilot-v2.zip`（6 动作 × 全场景/`_skel`，共 12 个 FBX）
> 结论：**第二版和第一版在数据上等价，两个问题都还在**；而且这次没有按上一轮要求回传诊断/日志，我们无法判断你改了什么。
> 本轮**不要**再跑 `run_full.bat`、**不要**改 `.max`、**不要**改脚本参数去"试"。只需要按下面做 **2 个 GUI 动作（约 5 分钟）** 并把结果回传，就能一次定位根因。

---

## 0. 一句话版（照这个做就行）

1. **打开 `StandBy.max`，拖时间轴，看人物身体动不动**，录屏 + 截 Motion 面板的 Figure Mode / Biped Layers / 当前模式（Motion Flow / Mixer）状态 → 回传；
2. **用 3ds Max 的 GUI 手动导出** `StandBy_gui.fbx`（勾 `Animation` + `Bake Animation` + `Resample All`，Bake 范围 = 场景范围）→ 自己用"新建空场景 Import 回来播放"自检 → 回传 FBX + 导出设置截图。

下面的分支表告诉你「如果成功/失败分别再做什么」。

---

## 1. 我们这边复核到的事实（证据）

### 1.1 v2 = v1（问题没变）

| 检查 | 结果 |
|---|---|
| 12 个 FBX 里 Biped 骨动画曲线 | **全部 0 条**（65 根 Biped 骨一条都没有；267 根普通骨/次级骨有动画） |
| 6 个 `_skel.fbx` | **和第一版逐字节相同**（sha256 一致，时间戳还是第一轮的 15:13），没有瘦身 |
| 6 个全场景 FBX | 确实重新导出过（文件时间 15:58），但二进制结构、动画曲线数量、Biped 曲线数（0）**与第一版完全一致**，只差文件头/UUID/时间戳 |
| 与官方实机对比 | 官方是连续动作；v2 产物是 5 个时间点完全静止的 T-pose（对比图见网盘 `pilot-v2-结果/`） |

> 关键：**源 `.max` 里确实有 Biped 动画数据**——我们上一轮直接解析了 `.max` 文件：138 个场景的 Biped 控制器块里都有逐帧动画轨道（Tpose 0 帧、Walk 71 帧、Skill01 195 帧），138/138 校验通过。所以不是"场景本来没动画"，是 **FBX 导出时 Biped 动画没有被导出**。

### 1.2 缺失的回传物（这次补上）

上一轮（`PILOT-FINDINGS.md` / `给豆包的操作说明.md` 第 6 节）要求回传：
- `probe-scene-anim.txt`（诊断）
- `D:\sjxl\exp\`（10 个导出设置变体 + `experiments-log.txt`）
- `StandBy_gui.fbx`（GUI 默认设置对照导出）
- `export_log.txt`（`run_pilot.bat` 每次都会生成）

**v2 里一个都没有**（只有 12 个 FBX，且 `_skel` 是上一轮的旧文件）。本次不需要重新跑那些实验，先把 §3 的 2 个 GUI 动作做完即可。

### 1.3 我们上网查到的关键结论（官方文档 + 社区）

| # | 结论 | 出处 |
|---|---|---|
| 1 | 3ds Max Biped 属于 **FBX 不支持的控制器**，**必须勾选 `Bake Animation`** 才会被重采样成动画曲线；官方原文：「所有不支持的约束和控制器（**包括 3ds Max Biped**）都会重采样为动画曲线」 | Autodesk 帮助 · Animation（[EN](https://help.autodesk.com/cloudhelp/2027/ENU/3DSMax-Interoperability/files/GUID-31EA2A4F-A126-498B-96E8-31811522738A.htm) / [中文](https://help.autodesk.com/cloudhelp/2024/CHS/3DSMax-Interoperability/files/GUID-31EA2A4F-A126-498B-96E8-31811522738A.htm)） |
| 2 | Biped 动画层是**有条件支持**：多层动画可能导不出；官方还写「如果高亮某个层再按默认预设导出，只会导出该层动画」 | Autodesk · FBX Limitations → Biped Layers（[链接](https://help.autodesk.com/cloudhelp/2027/ENU/3DSMax-Interoperability/files/GUID-511AE209-156C-4406-85B1-4266FEA57834.htm)） |
| 3 | 动画层排障：**必须处在最上层（top layer）并开 Bake Animation** 才会导出下面所有层；否则只导出顶层；官方建议「导出前把所有层塌陷成一个层」 | Autodesk · Where Are My Animation Layers?（[EN](https://help.autodesk.com/cloudhelp/2017/ENU/3DSMax/files/GUID-21B5781D-5D3D-40E7-8620-587BEC650C5D.htm) / [中文](https://help.autodesk.com/cloudhelp/2020/CHS/3DSMax-Data-Exchange/files/GUID-21B5781D-5D3D-40E7-8620-587BEC650C5D.htm)） |
| 4 | 3ds Max 只播放「当前层及其以下层」的 Biped 动画；Motion 面板 Layers 里有 **Activate All**（激活所有层）和 **Collapse Layers**（把当前层合并到下面最近的层）按钮 | Autodesk · Layers Rollout（[链接](https://help.autodesk.com/cloudhelp/2027/ENU/3DSMax-Character-Animation/files/GUID-1D2FBDE2-55A3-4788-90F8-884A60EEFA6F.htm)） |
| 5 | MaxScript 调 `FbxExporterSetParam` 设参数**有前提**：FBX 导出插件必须已在内存里，否则设置不生效（官方说要先 `pluginManager.loadClass FbxExporter`）；而且它返回 `"OK"`/`"unsupplied"`，参数写错只会静默失败 | Autodesk · FBX Export Dialog Access（[链接](https://help.autodesk.com/cloudhelp/2027/ENU/MAXScript-Help/files/MAXScript-Tools-and-Interaction/Interacting-with-the-3ds-Max/FBX-Import-and-Export-Dialog/GUID-54B1F140-B304-48A2-9829-C68B345E2044.html)） |
| 6 | 社区实测：MaxScript 设 FBX 导出参数并不可靠（设置不持久、可能被预设覆盖），建议**用 GUI/预设确认设置** | Tech-Artists（[链接](https://www.tech-artists.org/t/maxscript-fbx-export-option-control/3305)）、RealtimeVFX（[链接](https://realtimevfx.com/t/max-fbx-export-gotchas/705/1)） |
| 7 | **Motion Flow 模式**：动画来自「脚本+剪辑」，要先执行 **Create Unified Motion（统一运动）** 把脚本转成普通关键帧，退出 Motion Flow 模式后才可用；FBX 导出的是普通（freeform）动画层 | Autodesk · [Motion Flow Mode](https://help.autodesk.com/cloudhelp/2027/ENU/3DSMax-Character-Animation/files/GUID-31A4A769-D55B-4D55-A187-7EA48ACA1E65.htm)（2027 文档）· [Unifying Motion](https://download.autodesk.com/us/3DSmax/2012help/files/GUID-469CCB7E-895B-4BE0-A5B5-C5B6FE48178-1558.htm) |
| 8 | **Motion Mixer 模式**：动画在混合器轨道里，要先用「右键轨道 → **Compute Mixdown** → 选中 Mixdown 轨 → **Bipeds 菜单 → Copy Mixdown to Biped** → 关掉 Mixer Mode」变成 Biped 自己的关键帧；**3ds Max 动画层**（Animation 菜单 → Animation Layers 工具栏）同理需 **Collapse Anim Layer / Disable Anim Layer** 才能回到普通关键帧 | Autodesk · [Exporting Animation to the Biped](https://download.autodesk.com/us/3DSmax/2012help/files/GUID-378E7B9E-581A-4FB0-ADAE-4DD2B9DC414-1262.htm) · [Animation Layers (Layer Controller)](https://download.autodesk.com/us/3dsmax/2012help/files/GUID-ACAD407C-B079-4DAB-9DD0-6C8DC22389E-998.htm) |

> 补充证据：我们解析这批 `.max` 的类表，发现场景里还有 `Anim Layer Control Manager`（3ds Max 动画层管理器）、`Max MotionClip Manager`、`Max 混合器剪辑`（Motion Mixer 剪辑）、`共享运动流`、`Bip001 Footsteps` 等类 —— 说明这些场景很可能把动画放在了 **动画层 / Biped Layers / Motion Mixer / Motion Flow** 这类"要额外摊平（塌陷/Unify/Mixdown）才能被 FBX 带走"的系统里。这也是为什么"直接导出"和"改导出参数"都不一定有 Biped 曲线的原因。

**所以现在剩下这几种可能**，本次用 GUI 手动导出 + 看模式状态就能一刀切开：

- **A. 批量脚本里的 `Bake Animation` 设置没生效** → GUI 手动勾选导出就能出动画（§3）；
- **B. Biped 动画在非当前/未激活的 Biped Layer 上** → `Activate All` / 切到最上层 / `Collapse Layers` 后再导（§4.2-④）；
- **C. 场景里 Biped 本身就不播放**（数据/状态问题）→ 打开播放就能直接看出来（§2）；
- **D. 动画实际在 Motion Flow / Motion Mixer / 3ds Max 动画层里**（Biped 的普通动画层为空）→ 先 Unify / Mixdown / Collapse 成普通关键帧，再导出（§4.2 ①②③）。

---

## 2. 本轮请执行的动作 A：播放验证（约 2 分钟）

1. 3ds Max（2027）里打开 **`D:\sjxl\max\StandBy.max`**。
   - 若弹「缺少外部文件 / Missing External Files」→ 点 **Skip All / 跳过全部**（贴图不影响动作）。
   - **不要保存 .max**（只读查看）。
2. 选中人物任意 Biped 骨骼（比如点骨盆），右侧进入 **Motion 面板**，确认看到 **Biped rollout**。
3. 把时间滑块拖到 0 帧，然后慢慢拖到 20 / 40 / 60 / 80 帧，**观察人物身体是否在动**（手臂、躯干、重心）。
   - 同时录屏一段（10 秒即可）或截 5 张图（0/20/40/60/80 帧）。
4. 在 Motion 面板里截图这几处（很重要）：
   - **Biped rollout**：**Figure Mode（体形模式，小人图标）** 是否高亮（ON）；同时看 **Footstep Mode / Motion Flow Mode / Mixer Mode** 这几个模式按钮哪个是高亮/激活状态；
   - **Layers rollout**（展开）：看 **Layer Number / 一共几层 / 每层有没有关键帧 / 当前是第几层**；
   - **如果 Motion Flow Mode 高亮**：说明动画来自运动流脚本，记下来（见 §4.2 的 Unify 处理）；
   - **如果 Mixer Mode 高亮或 Motion Mixer 里有轨道/剪辑**：记下来（见 §4.2 的 Mixdown 处理）；
   - 打开 **Animation Layers 工具栏**（3ds Max 2027：菜单 **Animation → Animation Layers**；或右键任意工具栏空白处勾选 Animation Layers；不同版本菜单名可能略有差异），选中 Biped 根节点后看层列表：如果显示 `(Enable Layers)` 说明没启用动画层；如果有层（Base Layer 之外的层）就截图。
5. 回传：录屏或 5 张帧截图 + Motion 面板截图（含模式按钮 / Layers / Animation Layers 列表）。

> 这一步的答案直接决定分支：
> - 播放时**身体在动** → 场景没问题，问题在导出设置/层（走 §3 动作 B）。
> - 播放时**身体完全不动** → 场景侧问题（走 §4.2），照样把 §3 的导出也做一遍留证据。

---

## 3. 本轮请执行的动作 B：GUI 手动导出（约 3 分钟，关键）

> 目的：**绕开批量脚本**，用 3ds Max 自己的导出对话框按官方推荐设置导出 1 个文件，判断「脚本设置问题」还是「场景/层问题」。全程不写、不改任何脚本。

### 3.1 导出步骤

1. 保持 `StandBy.max` 打开（不要保存）。
2. 菜单 **File → Export → Export...**（文件 → 导出 → 导出）。
3. 保存类型选 **FBX (*.FBX)**，文件名 **`D:\sjxl\exp-v2\StandBy_gui.fbx`**（没有 `exp-v2` 就新建），保存。
4. 在弹出的 **FBX Export** 对话框里（不同汉化名称略有差异，按下面勾选）：

| 位置 | 设置 |
|---|---|
| 顶部 Preset（预设） | **Autodesk Media & Entertainment**（默认） |
| Include（包含）→ Animation（动画） | **✔ 勾选**（勾上后才展开动画选项） |
| Animation → **Bake Animation（烘焙动画）** | **✔ 勾选** |
| Animation → Bake Start / End | **0 / 84**（保持场景范围，一般会自动填，不要改成 0/0） |
| Animation → Step（步长） | **1** |
| Animation → **Resample All（全部重采样）** | **✔ 勾选** |
| Include → Geometry → **Embed Media（嵌入媒体）** | **不勾** |
| Include → Cameras / Lights | **不勾** |
| 其它 | 全部保持默认 |

5. 点 **OK** 导出。
6. 截图/拍照：把 **FBX Export 对话框的 Animation 页**（能看到 Bake Animation、Resample All 都打勾）截下来。

### 3.2 自检（这一步一定要做，先自己确认成功）

1. 3ds Max 里 **File → Open**（或 Reset）新建一个**空场景**（不需要保存任何东西）。
2. **File → Import → Import...**，选刚导出的 `D:\sjxl\exp-v2\StandBy_gui.fbx`，导入时保持默认、勾选 Animation。
3. 拖时间轴看角色是否**动起来**：
   - **动 → 成功**（说明 GUI 导出没问题，问题就是批量脚本设置/参数没生效）；
   - **不动 / 只有 T-pose → 失败**（走 §4.2）。
4. 录屏或截 3 张导入后不同帧的图。

> 提示：如果不想新建空场景，也可以直接在**同一台机器**上把导出文件拖进一个空白 3ds Max 窗口导入；重点是**不要覆盖原始 .max**。

### 3.3 回传

把下面内容打包（百度网盘 `砂金动作转换/` 目录下，压缩包命名 `fbx-pilot-v2-gui.zip`）：
1. `StandBy_gui.fbx`
2. FBX Export 对话框 Animation 页截图（证明勾选项）
3. 导入自检的录屏/截图（3 帧）
4. 动作 A 的播放录屏/截图 + Motion 面板截图

---

## 4. 结果分支：看到什么现象，就做哪一步

### 4.1 如果动作 B 成功（导入回来能播放身体动画）

说明：**根因 = 批量脚本的 FBX 导出设置没有生效**（官方文档明确 Biped 需要 Bake Animation，MaxScript 设参数有坑）。

请做：
1. 回传 §3.3 的东西；
2. **停在这里，不要再做别的**（不要跑全量、不要继续重导其余文件）；
3. 等 Mac 侧确认后，我们会把正确设置固化进批量工具包（下一轮给你），再让你重跑 6 个 pilot —— 注意：**批量导出仍要保留 `_skel` 瘦身逻辑**，这次 v2 的 `_skel` 还是旧文件，说明新工具包没用上。

### 4.2 如果动作 B 失败（自检导入后也不动；或动作 A 播放时身体就不动）

先判断"动画到底存在哪个系统里"，再按对应方案处理（**每一步都截图，不要覆盖原 .max**）：

**① 如果 Motion Flow Mode 高亮（动画来自运动流）**：
- Motion 面板 → **Motion Flow rollout**（只有 Motion Flow 模式激活时才显示）→ 点 **Create Unified Motion（创建统一运动）**；
- 点 Biped rollout 上的 **Motion Flow Mode** 把它**关掉**；
- 再按 §3.1 用 GUI 导出一次 → 自检是否动起来，截图回传。

**② 如果 Mixer Mode 高亮 / Motion Mixer 里有轨道或剪辑**：
- 打开 **Motion Mixer**（Mixer Mode 或 菜单 Animation → Motion Mixer）；
- 右键 Biped 最上面的轨道 → **Compute Mixdown（计算混合）**；等计算完成，会多出一条 Mixdown 轨道；
- 点选 Mixdown 轨道使其激活 → 菜单 **Bipeds → Copy Mixdown to Biped（将混合复制到 Biped）**；
- 关掉 **Mixer Mode**；
- 再按 §3.1 导出一次 → 自检，截图回传。

**③ 如果 Animation Layers 工具栏里 Biped 有多个动画层**：
- 选中 Biped 根节点 → Animation Layers 工具栏 → 把层列表展开截图；
- 选中最上层后点 **Collapse Anim Layer（塌陷动画层）**，一层层合并到 Base Layer（或直接 **Disable Anim Layer** 收起动画层控制器）；
- 再按 §3.1 导出一次 → 自检，截图回传。

**④ 以上都不适用/都失败**，再按下面顺序试，**每一步都截 Motion 面板 Layers rollout 的图**：

1. **检查 Figure Mode 是否被打开**：Motion 面板 → Biped rollout → 若「体形模式（小人图标）」高亮，点一下关闭 → 重新导出一次（同 §3.1 设置）。
2. **激活所有 Biped 层 + 切到最上层**：
   - Motion 面板 → **Layers rollout**；
   - 点 **Activate All（激活全部）**；
   - 用 **Next Layer / 上一页箭头**把 Layer Number 切到**最大层（最上层）**；
   - 再按 §3.1 导出一次。
3. **塌陷动画层**（官方推荐规避法）：
   - Layers rollout → 点 **Collapse Layers（塌陷层）**；如有多层就重复点到只剩 Layer 0；
   - 再按 §3.1 导出一次。
4. 如果以上都失败：
   - 运行网盘工具包里**已经有的**诊断脚本（不用改内容）：3ds Max 菜单 **Scripting → Run Script...** → 选 `D:\sjxl\probe_scene_anim.ms` → 会生成 `D:\sjxl\probe-scene-anim.txt`（若它默认打开的不是 StandBy.max，脚本开头有一行 `SRC` 指向 StandBy.max 即可，只改路径、别改别的）；
   - 回传：`probe-scene-anim.txt` + 每一步的 Layers 截图 + 每次导出的 `StandBy_gui*.fbx`。

### 4.3 如果动作 A 就发现场景里播放不动

说明场景侧 Biped 状态有问题（数据挖掘机写入的状态在 3ds Max 2027 里没被正确评估）。请：
1. 仍然做一次动作 B（导出 + 回传，留证据）；
2. 先按 §4.2 的 ①②③ 检查（Motion Flow Mode → Create Unified Motion；Mixer Mode → Compute Mixdown → Copy Mixdown to Biped；Animation Layers → Collapse/Disable Anim Layer），再按 ④ 的 1–3 步（Figure Mode / Activate All / Collapse Layers）处理，并回传每一步截图；
3. 把 `probe-scene-anim.txt` 一并回传；
4. 等 Mac 侧判断（必要时改用"逐文件 GUI 导出"或"找素材方要 FBX/.bip"的兜底方案）。

---

## 5. 回传清单（照单勾）

| # | 文件/证据 | 必需 |
|---|---|---|
| 1 | `StandBy_gui.fbx`（GUI 手动导出，按 §3.1 设置） | ✅ |
| 2 | FBX Export 对话框 Animation 页截图（Bake Animation / Resample All 可见打勾） | ✅ |
| 3 | 导入自检录屏/截图（空场景导入后 3 个不同帧） | ✅ |
| 4 | `StandBy.max` 播放录屏/帧截图（0/20/40/60/80） | ✅ |
| 5 | Motion 面板 Biped rollout + Layers rollout 截图 | ✅ |
| 6 | 若失败：各层状态每一步的截图 + `probe-scene-anim.txt` | 条件 |
| 7 | 压缩包命名 `fbx-pilot-v2-gui.zip`，放回网盘 `砂金动作转换/` 并通知 | ✅ |

---

## 6. 红线与注意事项

1. **不要修改/保存 `.max` 场景**（只读打开；Unify/Mixdown/Collapse 等操作用完也不要保存回原文件，导出完直接关掉不保存）。
2. **不要改脚本参数/导出设置去"试"**——按本文档的 GUI 步骤做即可；有异常先回传证据。
3. **不要跑全量 138**：pilot 门禁没通过前跑全量只会浪费时间；本轮只处理 `StandBy` 一个文件（最多加 `Skill01` 做二次确认，等 Mac 回复）。
4. **不要再直接用旧脚本重导**：v2 已经证明同样设置导出来还是一样（0 条 Biped 曲线）。
5. 贴图缺失弹窗点 Skip All；缺插件点 Ignore；不会影响动作。
6. 路径用纯英文、无空格：`D:\sjxl\max`（素材）、`D:\sjxl\exp-v2`（本轮导出）。
7. 如果 3ds Max 试用到期/未登录：先 GUI 登录到 Trial 再操作。
8. 版权：官方游戏资源，仅本机私用，不要公开分享/上传公开链接。

---

## 7. 为什么这次只让做 GUI（背景解释，可跳过）

上一轮以为是"导出参数组合"问题，给了 10 个变体脚本；但 v2 的结果说明：**只要还是走旧的批量脚本路径，导出来就还是 0 条 Biped 曲线**。而现在官方文档已经证实两件事：
- Biped 在 FBX 里**必须靠 Bake Animation** 才能出曲线；
- MaxScript 设 FBX 参数**有"插件未加载就静默失效"的坑**，社区也报告过类似不可靠问题。

所以最省时间的做法是：**用 3ds Max 自己的 GUI 对话框手动导 1 个文件**——GUI 的勾选项一定生效，能立刻区分「脚本设置问题（A/B 成功）」还是「场景/层问题（B 失败）」。确定后再改批量工具包，避免继续盲试。

---

## 8. 参考资料

1. Autodesk · 3ds Max FBX 帮助 · Animation（Bake Animation 必含 Biped）：https://help.autodesk.com/cloudhelp/2027/ENU/3DSMax-Interoperability/files/GUID-31EA2A4F-A126-498B-96E8-31811522738A.htm
2. 中文版同上：https://help.autodesk.com/cloudhelp/2024/CHS/3DSMax-Interoperability/files/GUID-31EA2A4F-A126-498B-96E8-31811522738A.htm
3. Autodesk · FBX Limitations（Biped Layers）：https://help.autodesk.com/cloudhelp/2027/ENU/3DSMax-Interoperability/files/GUID-511AE209-156C-4406-85B1-4266FEA57834.htm
4. Autodesk · Where Are My Animation Layers?：https://help.autodesk.com/cloudhelp/2017/ENU/3DSMax/files/GUID-21B5781D-5D3D-40E7-8620-587BEC650C5D.htm
5. 中文版「动画层怎么不见了？」：https://help.autodesk.com/cloudhelp/2020/CHS/3DSMax-Data-Exchange/files/GUID-21B5781D-5D3D-40E7-8620-587BEC650C5D.htm
6. Autodesk · Biped Layers Rollout：https://help.autodesk.com/cloudhelp/2027/ENU/3DSMax-Character-Animation/files/GUID-1D2FBDE2-55A3-4788-90F8-884A60EEFA6F.htm
7. Autodesk · FBX Export Dialog Access（FbxExporterSetParam 参数表 / 插件需先加载）：https://help.autodesk.com/cloudhelp/2027/ENU/MAXScript-Help/files/MAXScript-Tools-and-Interaction/Interacting-with-the-3ds-Max/FBX-Import-and-Export-Dialog/GUID-54B1F140-B304-48A2-9829-C68B345E2044.html
8. Autodesk · Figure Mode：https://help.autodesk.com/cloudhelp/2027/ENU/3DSMax-Character-Animation/files/GUID-1360F08E-5976-4752-B775-D1571A817A1F.htm
9. Tech-Artists · FBXExporterSetParam 不可靠/参数名坑：https://www.tech-artists.org/t/maxscript-fbx-export-option-control/3305
10. RealtimeVFX · Max FBX Export Gotchas：https://realtimevfx.com/t/max-fbx-export-gotchas/705/1
11. Autodesk · Motion Flow Mode（2027）：https://help.autodesk.com/cloudhelp/2027/ENU/3DSMax-Character-Animation/files/GUID-31A4A769-D55B-4D55-A187-7EA48ACA1E65.htm
12. Autodesk · Unifying Motion（Create Unified Motion 步骤）：https://download.autodesk.com/us/3DSmax/2012help/files/GUID-469CCB7E-895B-4BE0-A5B5-C5B6FE48178-1558.htm
13. Autodesk · Exporting Animation to the Biped（Motion Mixer：Compute Mixdown → Copy Mixdown to Biped）：https://download.autodesk.com/us/3DSmax/2012help/files/GUID-378E7B9E-581A-4FB0-ADAE-4DD2B9DC414-1262.htm
14. Autodesk · Animation Layers (Layer Controller)（Collapse/Disable Anim Layer）：https://download.autodesk.com/us/3dsmax/2012help/files/GUID-ACAD407C-B079-4DAB-9DD0-6C8DC22389E-998.htm
