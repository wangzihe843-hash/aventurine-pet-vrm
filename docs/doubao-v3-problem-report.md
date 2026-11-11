# 给豆包（Windows 侧）：fbx-pilot-v3 复核通过 + 全量 138 导出指令与改进方案

> 对象：你回传的 `fbx-pilot-v2-gui.zip`（包内实际是**第三版 v3** 产物：12 个 pilot FBX + `StandBy_gui.fbx` + 日志/诊断/源码/源场景渲染帧）
> 日期：2026-11-09 · 对照：你的 `REPORT-v3-rootcause-and-fix.md` + `export_log.txt` + 本机 Blender 4.2/管线独立复核
> **一句话：v3 通过了。P1（Biped 0 曲线）和 P2（`_skel` 不瘦身）都修好了，12/12 数据自检通过，可以开始全量 138 的 `_skel`。**
> **本轮不需要你做任何 GUI 动作、不需要改任何设置、不需要再写/改脚本。** 下面 §3 是全量执行清单，§4 是**增强自检**（必须加，防止同样的问题再隐蔽出现），§9 是这次根因的完整技术说明（含官方文档依据）。

---

## 0. 复核结论（你可以直接相信的部分）

| # | 检查项 | 结果 |
|---|---|---|
| P1 | Biped 身体动画 | ✅ 修复。12 个文件（除 Tpose 本身静止）**65/65 根 Biped 骨、每骨 10 通道共 650 条曲线**；每通道 **= 帧数**（85 帧 = 85 keys），**LINEAR 插值**，不是稀疏/减键 |
| P2 | `_skel` 瘦身 | ✅ 修复。`deletedMeshes=10`，体积降 27–49%（StandBy 8.15MB→5.13MB） |
| 等价性 | `_skel` 是否保真 | ✅ 已用本机采样器逐帧逐骨比对 5 个动作：FULL vs SKEL 非 Nub 骨差异 **< 0.001°**（Nub 是叶子标记骨，不参与变形，差异正常） |
| 根因定位 | `Bip2Fbx` | ✅ 接受你的单变量实验结论（F/G 归零、C/D/E 恢复、体积差 = 烘焙数据）。本机复核与官方文档一致（见 §9） |
| 回传物 | 日志/诊断/源码 | ✅ 齐全可复核：`export_log.txt`、`diag/exp1..exp5`、`sha256.txt`（13/13 一致）、`export_max_v3.ms`（源码已核对：无 `Bip2Fbx`、最小参数集、`selectedOnly:false`） |
| 新增能力 | `Bip001` 根对象动画 | ✅ 你这一版把 **Biped 根对象（`Bip001`）的动画也 bake 出来了**（9 条对象级通道，v2 是 0 条）——这是加分项，但**请务必保留**（见 §3.3 红线 2） |
| 转换验证 | 12 个 FBX 跑采样+重定向+VRM | ✅ 5 个动作全部能转、动作连续：`idle maxFrameJump 0.19° / loopSeam 0.07°`（v2 是全 0°）、`skill01 43.75°`、`walk 9.52°`、`talk01 8.30°`、`stun 90.7°`（首帧受击 snap，源动画如此） |

> 说明：`State_Stun` 你这一版还暴露出**我们 Mac 侧一个旧 bug**（首帧被误裁，已在本机修好），与你的导出无关。另外我们确认了 v3 的根对象动画目前还没被我们的转换链用上（Mac 侧待办），**也不影响你现在跑全量**——数据先完整拿回来，Mac 侧修好后一起用。

---

## 1. 你之前提的 4 个下一步，逐条回复

1. **“先拿 12 个 FBX 跑一遍采样+重定向+VRM”** → ✅ 已跑，通过（数据级 + 视觉级都做了，效果图见用户侧网盘 `砂金动作转换/pilot-v3-结果/`）。预期中的 `maxJump≠0 / loopSeam≠0 / 不再是 T-pose` 全部成立。
2. **“全量 138 的 `_skel`，预计 50–70 分钟”** → ✅ 批准执行。按 `D:\18133\sjxl\fbx-all-v3\` 输出、同一套 v3 设置、同一日志格式（另加 §4 的增强字段）。
3. **“全量前用 2–3 个非 pilot 文件抽查长帧 60fps / 帧范围 >200”** → ✅ 必须做，抽查要求见 §5。
4. **“要不要再加一档只留 Biped 的超瘦身变体”** → 暂不需要。先把全量跑完（`_skel` 保留 332 骨没问题，我们采样器只取 65 根 Biped 骨）；传输/转换如果确实太慢，下一轮再试点超瘦身（见 §10 可选优化）。
5. **§8 #7 网盘账号问题** → 先把全量产物在 D 盘生成 + 本地自检完成；回传通道按用户后续指示（分卷/本机账号上传都行），**不要因为网盘账号问题卡住导出**。
6. **§6 你说明“动作 A/B 没按字面做 GUI”** → ✅ 接受。根因已用单变量矩阵定死到一条参数，GUI 对照不再是必要判别环节；`StandBy_gui.fbx` 与 `pilot/StandBy.fbx` **sha256 完全相同**也符合你的说明。本轮不再要求任何 GUI 截图/录屏。

---

## 2. 全量前的一句话状态

**你不需要再证明什么，直接按现有 `export_max_v3.ms` 跑 `mode=all`（138 个 `.max` 的 `_skel`）。唯一新增要求 = §4 增强自检 + §5 抽查 + §3.3 红线。**

---

## 3. 全量 138 执行清单（严格照做）

### 3.0 全量前先做 2 个 30 秒实验（很重要，决定 138 个文件能否在同一个进程里安全连跑）

**实验 A（`ResetExport` 是否会清掉 `Bip2Fbx`）**：干净启动一次 `3dsmaxbatch`（不加载任何旧脚本），执行：
```maxscript
format "default Bip2Fbx = %\n" (FBXExporterGetParam "Bip2Fbx")
FBXExporterSetParam "Bip2Fbx" true
FBXExporterSetParam "ResetExport"
format "after ResetExport = %\n" (FBXExporterGetParam "Bip2Fbx")
```
- 若 `after ResetExport = false`：`ResetExport` 足够，现有 v3 写法（不写 `Bip2Fbx`）安全；
- 若 `after ResetExport = true`：**必须在每个文件显式 `FBXExporterSetParam "Bip2Fbx" false`**（否则一个文件设过 true 会污染后面所有文件）——这也是为什么建议干脆每文件都显式 false + 回读（见 §3.3 改进 1）。
- 把两行输出贴进本轮日志头部（`# defaultBip2Fbx=… afterReset=…`）。

**实验 B（防御性回读）**：在 v3 脚本每文件 `ResetExport` 之后加 4 行回读并写日志：
```maxscript
FBXExporterSetParam "Bip2Fbx" false        -- 显式防御（实验 E 已证与不写结果完全一致：8,147,040B / 67/67）
format "readbackBip2Fbx=%\n" (FBXExporterGetParam "Bip2Fbx")
```
- 若哪天回读到 true → 立刻 `set false` 再回读，并在日志里 `WARN,BIP2FBX-TRUE`。
- 这不属于“堆参数”（只加一条已被证明安全的显式 false），不会破坏烘焙。

> 背景：我们复核了 FBX SDK 头文件，`Bip2Fbx` 的真实内部名是 `IOSN_BIP2FBX "Bip2Fbx"`，且在 SDK 里挂在 **Geometry** 组（`EXP_BIP2FBX = EXP_GEOMETRY "|" IOSN_BIP2FBX`），不是 Animation 组；官方 2027/2012 参数表都只有名字、没有任何语义说明，当前导出对话框里也没有这个选项。所以你 exp3 的“同进程 V4→V5→V6 全归零”有可能一部分是 **Bip2Fbx=true 的残留污染**（如果 ResetExport 不清它），而不是“堆参数本身有害”。实验 A 能把这一点一次定死。详见 `docs/research/v3-bip2fbx-rootcause.md`。

### 3.1 前置检查

- [ ] `D:\18133\sjxl\max\` 里 **138 个 `.max`** 齐全（`dir` 数一遍；含 `Tpose.max`）。
- [ ] 3ds Max 2027.2 仍是登录 Trial 状态（`3dsmaxbatch.exe` 能正常起）。
- [ ] D 盘剩余空间 **≥ 25GB**（138 × 平均 ~5.5MB 的 `_skel` ≈ 0.75GB，但批处理临时文件/日志/重导出余量留足；你之前留 10GB 的说法偏紧）。
- [ ] 同一台机器、同一份 `export_max_v3.ms`（**不要用旧脚本、不要用 GUI 预设覆盖**）。
- [ ] 关掉一切会弹窗的东西（Autodesk Privacy 已同意过、缺贴图/缺插件弹窗的处理方式沿用 last round：Skip All / Ignore）。

### 3.2 跑什么、输出到哪

| 项 | 要求 |
|---|---|
| 输入 | `D:\18133\sjxl\max\`（138 个 `.max`，只读打开，**不保存**） |
| 输出 | `D:\18133\sjxl\fbx-all-v3\`（**只导 `_skel`**；全场景 FULL 本轮不需要——我们的采样器优先用 `_skel`，已实测与 FULL 等价，见 §0） |
| 文件数 | 期望 **138 个 `<take>_skel.fbx`**（+ 允许失败后补跑） |
| 脚本 | `export_max_v3.ms`，`mode=all`（沿用你现有入口 `run_full.bat` 也行，只要它调的是 v3 脚本） |
| 日志 | 同一 `export_log.txt` 格式 + §4 增强字段（每个文件一行，绝不能只写汇总） |
| 耗时 | 单文件 20–25s → 预计 **50–70 分钟**；建议一次性跑完，中途不要动鼠标/不要开 GUI 场景 |
| 命名 | **保持原文件名**（包括空格/括号，如 `StandBy (2).max` 不要改名/去重；我们的配置按精确文件名匹配） |

### 3.3 红线（4 条，全部是实测踩过的坑）

1. **绝不写 `Bip2Fbx` / `Bip2FBX` 为 true**（任何情况下）。默认就是 false，`ResetExport` 之后**不要碰它**；唯一允许的写法是**显式 `false` + `FBXExporterGetParam` 回读**（见 §3.0 实验 B；实验 E 已证 false 与不写结果完全一致）。也不要从 GUI 预设里“载入 Media & Entertainment 预设”来覆盖——那会把参数块换掉。你的 v3 脚本已经是对的：最小集 + 只留 `ResetExport`/`Animation`/`BakeAnimation`/`BakeResampleAnimation`/`BakeFrameStart/End/Step`。
2. **不要改成 `Export Selected`（只选骨骼）**，也不要删除 `Bip001`/`Bip001 Footsteps`/`Root` 对象。v3 的 `_skel` 做法是“删 10 个网格 → 整场景 `selectedOnly:false` 导出”，这个做法是对的：**它把 `Bip001` 根对象动画一起带出去了**（我们后面要用）。改成 Export Selected 很可能把根对象/父级丢掉。
3. **不要加任何“看起来无害”的额外参数**（`FilterKeyReducer`、`RemoveSingleKeys`、`GeomAsBone`、`Triangulate`、`SmoothingGroups`、`ShowWarnings`…）。你的 exp H 已经实测：一次堆 7 个几何/日志参数也会让 Biped 归零；单独加没事（exp I/J），**但规则就是只写最小集，其余一律不碰**。
4. **不要修改/保存 `.max`**；不要跑旧 `run_full.bat`（如果它指向旧脚本就改指向 v3 脚本，或直接用 v3 脚本）；贴图缺失 Skip All、缺插件 Ignore。

### 3.4 帧范围/fps 的处理（照你 v3 脚本现有逻辑，但请补 4 个日志字段）

- `BakeFrameStart = floor(scene.animationRange.start)`、`BakeFrameEnd = ceil(scene.animationRange.end)`、`Step = 1`（官方文档：Bake Start/End 只接受整数，所以 83.5 → 84 是正确做法，保留最后半帧）。
- **不要**手动统一成 30fps 或 60fps；场景 fps 原样保留（我们按 per-clip fps 处理混用）。
- 每个文件除了现在的 `frames=`，请补 4 个字段（便于我们对账，尤其 StandBy 这种 83.5 非整数范围）：
  `rawRange = <animationRange.start.frame>..<animationRange.end.frame>`（浮点原值，如 `0.0..83.5`）
  `rawTicks = <animationRange.start.ticks>..<animationRange.end.ticks>`
  `bakeRangeInt = <BakeFrameStart读到值>..<BakeFrameEnd读到值>`（导出前 `FBXExporterGetParam` 回读）
  `expectedKeys = bakeRangeInt[1]-bakeRangeInt[0]+1`（每个被烘焙通道应有的 key 数）
- 如果某个文件 `animationRange` 是 0（无动画）或 >1200 帧，**单独在日志里标 `WARN`** 并继续（不要停批）。

---

## 4. 增强自检（本轮新增，必须做）

你 v3 的自检已经比前两版强很多（`bipedAnimated/total;pelvisDelta;posKeys;rotKeys` + 回读 `readbackBake/readbackResample`）。全量请在 `verdict` 里**再补 4 项**，这样任何回归都能在日志里一眼看到：

| 字段 | 期望/判据 | 为什么 |
|---|---|---|
| `bipedAnimated` | `65/65` 或 `67/67`（含 Bip001/Footsteps）；**出现 `<65` 立刻 `WARN,FULL-NO-BIPED-ANIM` 并把该文件列出** | P1 回归哨兵 |
| `bipKeyCount` | 每根 Biped 骨：`posKeys ≈ 帧数`、`rotKeys ≈ 帧数`（允许 ±1）；或记录“总 keys = 65 × 10 × 帧数” | 防“有 isAnimated 但是空/稀疏曲线”、防 key reduction |
| `rootObjAnimated` | **`.max` 里 `Bip001` 对象 isAnimated=true 的文件，重导后 `Bip001` 也必须 animated=true**（location/rotation 有 key） | 保根运动（v3 新能力，下阶段要用来做转身/位移/竖直起伏） |
| `nonBipAnimated` | 期望 ≈ 286–287（次级骨/面部骨）；若突然为 0 说明导出走了别的路径，标 `WARN` | 交叉校验“还是同一条导出路径” |
| `deletedMeshes` | `_skel` 期望 **10**（你 v3 已做到）；不是 10 就标 `WARN,SKEL-NOT-SLIMMED` + 打印类名直方图 | P2 回归哨兵 |
| `bytes` | `_skel` 期望 **≥ 2.5MB**（pilot 最小 Tpose 3.19MB）；明显偏小（如 <1MB）标 `WARN,SMALL` | 体积是“有没有烘焙数据”的最快旁证（v2 的坑） |

另外在日志头部加两行（便于复现）：
```
# fbxPluginVersion = <FBX 插件版本，如 FBX 2020.3.4 / 2027 自带版本>
# exportPreset = Autodesk Media & Entertainment (factory default) 或 None
```

**关键：自检用的“导入”也要显式设参数**（否则 3ds Max 导入侧的 Resample/Key Reducer 会把曲线悄悄减掉，自检就不可信）。在 `importFile` 之前加：
```maxscript
FBXImporterSetParam "ResetImport"
FBXImporterSetParam "Mode" #create
FBXImporterSetParam "Animation" true
FBXImporterSetParam "TakeIndex" 1
FBXImporterSetParam "Resampling" 1.0
FBXImporterSetParam "PostSamplingKeyReducer" false
FBXImporterSetParam "KeepFrameRate" true
FBXImporterSetParam "FillTimeline" true
importFile dst #noPrompt using:FBXIMP
```
> 依据：Autodesk 帮助明确 Constant Key Reducer 会删除“连续相同值的关键帧”，而且**动画末尾的 key 也可能被清掉**（"If you are missing keyframes at the end of your animation in an exported FBX file, they may have been cleaned by the 3ds Max FBX plug-in Constant Key Reducer filter."）。所以自检环境必须是“不重采样、不减键、保留帧率”的。

> 自检仍是“导出后把该 FBX 导入空场景，用 `isAnimated` + 关键帧数 + posDelta 判据”，和 v3 一样，不需要外部 DCC。**Tpose 除外**（Tpose 本来就是静止的，`bipedAnimated` 可以是 0/65，不要因此判失败；用 `isTpose=1` 标识跳过）。—— 注意：你 v3 的 Tpose 自检是 67/67 有恒定关键帧，这也行，只要**全量脚本别把 Tpose 的静态判成 FAIL**（你的日志里 Tpose 已 OK，保持即可）。

---

## 5. 全量前抽查（2–3 个非 pilot 文件，必须）

在跑全量之前，挑 **2–3 个不在 pilot 6 文件里的场景**，单独导一次 `_skel` 到 `D:\18133\sjxl\spotcheck-v3\`，重点覆盖：

1. **60fps + 长帧范围**（如某个 `Skill0x`/过场类，>200 帧，甚至 >300 帧）：确认 `BakeFrameEnd` 不溢出、导出时间正常、`bipedAnimated=65/65`。
2. **30fps + 长帧范围**（>150 帧）：确认 30fps 场景同样 OK。
3. **一个 `animationRange.end` 非整数的场景**（如果有；像 StandBy 的 83.5）：确认 `ceil` 后正常、日志记录到 `frames=x.5-...`。
4. 如果 138 里有**名字带空格/括号的复本**（如 `StandBy (2).max`）：抽一个确认输出文件名保留原名、能正常出 FBX。

抽查结果（3 行日志 + 每个文件的自检 verdict）随全量日志一起回传；发现问题先停、把日志发回，不要自己改设置。

---

## 6. 异常处理（全量过程中）

> 可靠性补充（社区经验，非 Autodesk 明文）：3ds Max 长时间批处理可能内存持续增长/单文件卡死。如果单进程跑 138 个出现内存上升或崩溃：**按 30–40 个文件分 3–4 段跑**（每段之间重启一次 3dsmaxbatch，导出设置完全不变，只是传不同文件列表），或崩溃后只对剩余文件重跑；每段结束检查 `export_log.txt` 与内存占用。**不建议 138 个并行**（每进程都加载整场景 + FBX 插件，内存/IO/许可都可能打架）。

1. 单文件 `FAIL`：记录到日志（文件名 + 异常原文），**跳过继续**；全量结束后对 FAIL 列表**原样重试一次**（不改设置），仍失败就单独列出。
2. 连续 3 个 `FAIL` 或批处理崩溃：**停**，保存当前 `export_log.txt` + `listener.log`/`max.log`，把最后成功/失败的文件名发回；重跑时从头跑（脚本是确定性的，重复导出同目录覆盖即可，不需要清理）。
3. 电脑重启/3ds Max 试用弹窗：先 GUI 登录 Trial，再重跑；重启后先跑 §5 的一个抽查确认环境正常。
4. 任何“某个文件导出来特别小/特别大”的异常：单独记录 `bytes` + `bipedAnimated`，不要自己调参数。

---

## 7. 回传清单（全量）

| # | 内容 | 必需 |
|---|---|---|
| 1 | `D:\18133\sjxl\fbx-all-v3\` 全部 `_skel.fbx`（期望 138 个） | ✅ |
| 2 | `export_log.txt`（含 §4 增强字段 + 头部两行版本信息 + 末行 `=== DONE mode=all ok=? fail=? ===`） | ✅ |
| 3 | `sha256.txt`（全量每个 FBX） | ✅ |
| 4 | §5 抽查的 3 个文件 + 日志 | ✅ |
| 5 | `listener.log` / `max.log`（若过程中有 WARN/异常） | 条件 |
| 6 | 压缩包命名建议 `fbx-all-v3.zip`（或按用户指定分卷），传回通道按用户指示 | ✅ |
| 7 | 全量过程中的 **FAIL 名单 + 原因**（没有就写 `none`） | ✅ |

> 不用回传 `.max`、不用截 GUI 图、不用再导 FULL。

---

## 8. 为什么这么设置（一句话版，详细见 §9）

- 官方文档明确：**3ds Max Biped 是 FBX 不支持的控制器，必须靠 Bake Animation 重采样成曲线**；你 v3 的最小集正好是“只做这件事”，所以 67/67 都有曲线。
- `Bip2Fbx` 是官方参数表里存在、但**官方帮助没有语义说明**的布尔参数；在这台 2027.2 上它的实际行为是“把 Biped 切到另一种转换路径，烘焙曲线不再写出”（你 exp3/exp5 已证死）。**批量脚本永远不要设置它**。
- `BakeFrameStart/End` 官方只接受整数，且 Bake Start/End/Step 不能存 preset（永远取场景时间轴）——所以你的 `floor/ceil + 读场景区间` 逻辑就是官方推荐做法。
- `Resample All` 按宿主帧率重采样；勾上它 + Bake 才能保证“支持的动画也逐帧写”，这也是我们逐帧采样的前提。

---

## 9. 根因技术说明（给以后接手的人/留档）

**现象**：v1/v2 导出的 FBX 里，267 根次级/面部骨有动画、65 根 Biped 骨 0 曲线 → 下游只能得到静止 T-pose。

**定位（你的单变量矩阵，本机复核认可）**：
1. 最小参数集（`ResetExport` + `Animation` + `BakeAnimation` + `BakeResampleAnimation` + `BakeFrameStart/End/Step`）→ 67/67 有烘焙曲线（8,147,040B）。
2. 只加一条 `Bip2FBX true`（或 `Bip2Fbx true`）→ 0/67（7,223,776B）。体积正好少了 ~0.92MB = `65 骨 × 84 帧` 的烘焙数据。
3. 只加别的单参数（UpAxis/Triangulate/SmoothingGroups/…）→ 仍是 67/67；但**一次堆 7 个** → 归零。注意：这个“堆叠归零”的结论可能是**同进程里 `Bip2Fbx=true` 的残留污染**（如果 `ResetExport` 不清它），§3.0 实验 A 会一次定死；在定死之前，规则仍然是**只写最小集**。
4. 官方文档确认：Biped 必须 Bake；`Bip2Fbx` 在官方参数表里只有名字；社区也没有可靠用法/说明 → **结论：不碰**。

**为什么 v2 会“修了等于没修”**：v2 仍是旧参数块路径（含 `Bip2FBX true`），有效导出设置没变，所以 0/67。

**`Bip001` 根对象动画**：v3 去掉 `Bip2Fbx` 之后，Biped 根对象（`Bip001`）自己的 location/rotation/scale 动画也被 bake 出来（v2 为 0）。这是好数据，请保留——我们下阶段用它做技能/受击/走路的转身、位移、上下起伏（Mac 侧采样器要补采对象级动画，属于我们的活）。

**官方/社区依据**：
1. Autodesk 3ds Max 2027 FBX 帮助 · Animation（Bake Animation 会把**包括 3ds Max Biped 在内**的不支持控制器重采样成曲线；Bake Start/End/Step 不能存 preset，永远取场景时间轴；Resample All 按宿主帧率重采样）：https://help.autodesk.com/cloudhelp/2027/ENU/3DSMax-Interoperability/files/GUID-31EA2A4F-A126-498B-96E8-31811522738A.htm
2. Autodesk 3ds Max 2027 MaxScript 帮助 · FBX Export Dialog Access（`FbxExporterSetParam` 官方参数表，含 `BakeAnimation` / `BakeFrameStart` / `BakeFrameEnd` / `BakeFrameStep` / `BakeResampleAnimation` / `Bip2Fbx`；BakeFrameStart/End 为整数；插件需先加载）：https://help.autodesk.com/cloudhelp/2027/ENU/MAXScript-Help/files/MAXScript-Tools-and-Interaction/Interacting-with-the-3ds-Max/FBX-Import-and-Export-Dialog/GUID-54B1F140-B304-48A2-9829-C68B345E2044.html
3. Autodesk · FBX Limitations（Biped Layers 只条件支持；控制器时间范围未定义时自动取场景区间）：https://help.autodesk.com/cloudhelp/2027/ENU/3DSMax-Interoperability/files/GUID-511AE209-156C-4406-85B1-4266FEA57834.htm
4. Autodesk（旧版 FBX 插件帮助）· FBXExporterSetParam 参数表（`Bip2FBX` 同样只有名字）：https://download.autodesk.com/us/fbx/3ds_max_help/fbx_3dsmax_online/files/WS644c7983f449f2df-53d205c5113e574e97c-8000.htm
5. **FBX SDK 头文件**（关键证据：`Bip2Fbx` 内部名 `IOSN_BIP2FBX "Bip2Fbx"`，且 `EXP_BIP2FBX = EXP_GEOMETRY "|" IOSN_BIP2FBX` → 挂在 **Geometry** 组，不是 Animation 组）：https://download.autodesk.com/global/docs/FBXsdk2012/en_us/cpp_ref/kfbxiosettingspath_8h.html
6. 官方 3ds Max 2024/2025 · Geometry / Advanced Options 页（当前导出对话框里没有 Biped/Bip2Fbx 选项）：https://help.autodesk.com/cloudhelp/2024/ENU/3DSMax-Interoperability/files/GUID-249100FE-67BE-43B8-AF12-D20703CDF8D1.htm
7. 真实 `.fbxexportpreset` 样本（preset 里没有 Bip2Fbx 节点；`BakeComplexAnimation`=Bake Animation、`ResampleAnimationCurves`=Resample All）：https://raw.githubusercontent.com/Makiah/BotW-SBFRES-to-FBX/master/fbxextraction/BotW%20Export%20Preset.fbxexportpreset
8. 补充：我们已把上一轮 `docs/research/max-windows-routes.md` 里“强烈建议 `Bip2FBX true`”的旧建议**标注为已证伪/禁止**，不会再误导下一轮。
9. 社区 · Tech-Artists「[maxScript] FBX export option control」：https://www.tech-artists.org/t/maxscript-fbx-export-option-control/3305
10. 社区 · RealtimeVFX「MAX - FBX Export Gotchas!」：https://realtimevfx.com/t/max-fbx-export-gotchas/705/1

---

## 10. 可选优化（**本轮不做**，等全量回来再定）

1. **超瘦身 `_biped` 变体**（按“风险从低到高”试）：① `ExportAnimationOnly=true`（官方 2019.1+ 隐藏参数，语义未文档化，先试点）；② 当前做法（删 10 个网格 → 整场景导出，已验证）；③ `selectedOnly:true` 只选 `Bip*` 层级（最可能丢 `Bip001` 根对象/父级 `Root`，最后考虑）。目标 ≈1MB/文件、全量 ≈150MB（现在 ~750MB）。**每个候选都要先做 1 个文件试点 + 与 `_skel` 采样结果逐帧比对（非 Nub 骨差异 <0.001° 才放行）**，且确认根对象动画仍在。
2. **Tpose 不导动画**：Tpose 只用来取 rest，301 帧的静态烘焙纯属浪费（6.2MB）。可在 Tpose.max 单独把 `Animation` 关掉导出（不影响 rest）。同样是可选，不阻塞全量。
3. **`ExportAnimationOnly` 参数**（官方 2019.1+ 的 MAXScript-only 参数）：可能进一步减小体积，但语义/后果未验证，不建议在 138 全量上试。

---

## 11. 本轮不需要做的事

- 不需要 GUI 截图/录屏（Motion 面板、导出对话框等都不用了）。
- 不需要再导 `StandBy_gui.fbx`（已证明与 pilot 版同 sha）。
- 不需要再导 FULL 场景（全量只要 `_skel`）。
- 不需要改 `.max`、不需要改导出设置、不需要写新脚本。
