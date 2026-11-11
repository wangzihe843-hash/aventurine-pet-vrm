# 砂金·戏浪水枪「安回手上」— 可行性与落地方案（Lead 综合，2026-11-09）

> 用户问题：砂金戏浪的动作模型里有大量「持武器」动作，现在 VRM 空手播放像无实物表演；`aventurine-pet/assets` 下有水枪贴图 —— 能不能把水枪给他安回去？
>
> **结论：能，而且水枪不用再找、不用重建 —— 它就在 Windows 侧 `.max` 导出的「全场景 FBX」里（pilot 版已回传，Mac 侧已提取成功）。** 推荐用**运行时挂点**（不烘焙进 VRM）：把已提取的 `assets/props/watergun/watergun.glb` 挂到 VRM 右手 raw 骨，跟随所有 humanoid 动作；按动作片段决定显示/隐藏。工作量约 **0.5–1 天**（含校准与测试），不改 Doubao 正在跑的全量导出计划。
>
> **2026-11-09 晚更新：V1 已实现并通过 typecheck/全量测试，预览证据见 §10（持枪规则：只有 `adv` 动作集里的 `skill` 类动作持枪，idle/walk/talk/stun 等普通动作一律空手）。**
>
> 本文只做**综合与决策**；三份分 lane 调研详见：
> [`watergun-runtime-attach.md`](watergun-runtime-attach.md)（运行时挂点，three-vrm 源码级）、[`watergun-bake-vrm.md`](watergun-bake-vrm.md)（Blender 烘焙进 VRM 1.0）、[`watergun-asset-sourcing.md`](watergun-asset-sourcing.md)（资产来源）。
> 私有游戏资产：仅本机开发，**禁止上传/二次配布/商用**（作者「流云景」使用规则 + miHoYo 版权）。

---

## 0. TL;DR

1. **水枪已找到**：`.max` 全场景 FBX（`pilot/Tpose.fbx` 等）内含游戏角色模型 + 独立水枪网格 **`0009_Weapon`**（4642 顶点 / 4508 面）与专用武器骨 `Gun_b/c/d/e_01_JNT` / `prop_JNT`；武器材质贴图引用 `Avatar_AventurineW_00_Weapon_Color.png`，与本地 `assets/model/水枪.png` 是同一把枪的 2K UV 贴图（已用 UV 渲染验证吻合）。
2. **资产已提取**：`scripts/props/extract-watergun.py` → **`assets/props/watergun/watergun.glb`**（2.38 MB，贴图内嵌；米制；中心在原点；长轴 +Z、上 +Y、宽 X；真实尺寸 **0.574 × 0.249 × 0.123 m**）+ `meta.json`（尺寸/来源/校验）。渲染确认见 `tests/tmp/props/watergun/glb_*.png`。
3. **推荐路线：运行时挂点（V1，已实现）**——GLB 挂到 VRM **normalized** `rightHand` 子节点（校准更可移植；raw 等价可选），一次校准、零每帧同步、零 IK；按 clip 规则切 `visible`。**不推荐把枪烘进 VRM**：永久持枪会让空手动作穿帮，且每次改模型/换动作都要重导 VRM。
4. **校准有源数据可依**：源 `Skill01` 场景里武器骨跟随右手（手骨→枪相对变换跨帧近似常量），可量出「握持偏移」作初值；实施时用现有预览管线截图迭代到 ±1 cm。
5. **对豆包无新增要求**：全量 138 继续导出 **skeleton-only**（`run_full.bat`，现状即正确）；pilot 的 6 个 full FBX 已足够提取武器，**不要再导全量 full-scene**（体积大）。只有将来想复刻「技能里武器自身的动画（后坐/举枪）」时才需要 subset 模式补导对应片段（见 §6）。

---

## 1. 证据链（本机实测，2026-11-09 晚）

### 1.1 逐层排查：水枪到底在哪

| 资产 | 结论 | 证据 |
|---|---|---|
| `assets/model/星穹铁道—砂金·戏浪.pmx` | **无武器**：39 材质全为身体/服装/饰品；20 张被引用贴图里没有 `水枪.png`；382 骨里只有 `右手首/左手首`，无武器骨 | Lead 二进制解析（PMX 2.0，32966 顶点 / 155487 面 / 39 材质 / 20 贴图）；`脚本 scripts/props/extract-watergun.py` 头部注释 |
| 4 个派生 VRM | 同 PMX：39 材质、无武器 | glTF JSON 材质表比对（与 PMX 材质名一一对应） |
| `assets/model/水枪.png` | 是**水枪的 2K UV 贴图**（青蓝装甲 + 金饰 + 小黄鸭挂件 + 郁金香 + 羽饰 + 横幅字样），不是图标 | 直接查看 + UV 渲染吻合（`tests/tmp/props/watergun/glb_hero.png`） |
| **`.max` 全场景 FBX（pilot）** | **水枪在这里**：`0000~0003_Body`、`0004~0006_Face`、`0007_Face_Mask`、`0008_Hair`、**`0009_Weapon`** | Blender 4.2.23 导入 `pilot/Tpose.fbx` 实测：10 个 mesh / 2 个 armature |
| `0009_Weapon` 细节 | 4642 顶点 / 4508 面；材质 `Material #30` 贴图 `Avatar_AventurineW_00_Weapon_Color.png`（相对 `../max/`）；UV：`DiffuseUV` + `LightmapUV`；蒙皮权重到 `Gun_b/c/d/e_01_JNT` + `Part_c_02~06_JNT` | Blender 检查报告 `/tmp/fbx_family_report.json`（Lead 生成） |
| 武器骨 | `Bip001` 骨架 332 骨，额外含独立根骨 **`Gun_b_01_JNT`、`Gun_c_01_JNT`、`Gun_d_01_JNT`、`Gun_e_01_JNT`、`prop_JNT`、`proptwo_JNT`**；每个都带 10 条动画通道 | 同上 + action fcurve 目标统计 |
| 尺寸/单位 | 角色 bbox 高 0.017002 场景单位；按「角色身高 1.70 m」归一化 **×99.99** → 水枪真实尺寸 **0.574 × 0.249 × 0.123 m**（约 57 cm 长，符合 HSR 夸张水枪造型） | `assets/props/watergun/meta.json` |

### 1.2 源场景里枪是怎么「拿」的（决定校准数据从哪来）

对 pilot 全场景 FBX 逐帧算「右手骨 → Gun_b_01_JNT」相对变换（`inv(H_hand) @ G_gun`，单位换算后≈米）：

| 场景 | 结果 | 解读 |
|---|---|---|
| `Tpose.fbx` / `StandBy.fbx` | 枪网格位于世界原点（脚边） | 源 `.max` 里武器是**独立物体、未绑定到手骨**（CGJOY 帖原话"无武器道具绑定，武器等东西在脑袋里面，大家可以自己拿出来绑一下"与实测一致） |
| `Skill01.fbx` | 相对变换**跨帧近似常量**：`rel_t ≈ (0.013, 0.042, 0.087)` m，`rel_q ≈ (0.66, -0.01, -0.05, 0.75)`；跨帧漂移约 **1–2 cm / 1–2°**（40 帧附近有 ~0.5 cm 抖动） | 技能动作里**武器骨被动画到手边**（游戏内表现），这段「手骨→枪」关系就是**握持校准初值**；漂移部分=武器自身动画（后坐/举枪） |

> 由此：**V1 固定挂点**用 §1.2 的常量足够（桌宠尺寸 ±1 cm 不可见）；**V2 若想复刻武器自身动画**，可把这 1–2 cm 漂移采成 per-clip 道具轨道（见 §6）。注意：源里武器未绑手，因此**不存在**可直接复用的"源武器绑定矩阵"；校准要过一道「游戏手骨坐标系 ↔ VRM raw 手骨坐标系」的换算（rest 约定 + 预览截图微调，见 §3.3）。

### 1.3 已产出的资产

```
assets/props/watergun/
├─ watergun.glb     # 2.38 MB，贴图内嵌（2K），米制，中心在原点；three.js 空间：长轴 +Z / 上 +Y / 宽 X
└─ meta.json        # 来源 FBX/帧/网格统计、归一化比例、bbox、挂点与尺度 sanity 提示
scripts/props/extract-watergun.py   # 可复现提取脚本（Blender 无头运行）
tests/tmp/props/watergun/glb_*.png   # GLB 回读渲染（side/top/hero），确认贴图与几何正确
```

复现命令：
```bash
tools/blender/Blender.app/Contents/MacOS/Blender -b --factory-startup \
  --python scripts/props/extract-watergun.py -- \
  --fbx tests/tmp/adv-pilot-v3/fbx-pilot-v2-gui/pilot/Tpose.fbx
```

---

## 2. 方案对比与决策

| 方案 | 做法 | 成本 | 优点 | 风险/缺点 | 决策 |
|---|---|---|---|---|---|
| **A. 运行时挂点（V1 推荐）** | `rightHand.add(gun)` / `attach` 一次校准；按 clip 切 `visible` | **0.5–1 天** | 零每帧同步、零 IK；可随 clip 显示/隐藏/收纳；不重导 VRM；调试直观 | 需一次坐标系换算+微调；`avatar.dispose()` 前要 detach | **采用** |
| B. 烘焙进 VRM | Blender：水枪普通 Mesh → Parent to Bone = 右手首 → 导出 VRM 1.0 | 1–2 天 | 资产自包含、不依赖 app 逻辑 | **永久持枪**（空手动作穿帮）；每改一次要重导；VRMA 无法驱动道具开关；改资产影响 39 材质/spring 校验 | 备选（若要做"永远持枪"的展示变体） |
| C. 每帧同步世界矩阵 | 场景级 prop，每帧 copy 手世界矩阵 | 低 | 不挂骨 | 帧序错就慢一帧/抖动；可见性更麻烦 | 不采用 |
| D. 运行时 IK 让双手贴合 | TwoBoneIK / CCDIK | 高 | 理论更准 | 抖动/翻转/参数标定；收益仅 1–3 cm | 不采用（先靠源姿态，必要时数据侧微调左手） |

依据：`watergun-runtime-attach.md` §1–§3（three-vrm 源码/官方 URL 逐条核实）、`watergun-bake-vrm.md` §0–§2（VRM 1.0 规范与 addon 官方教程）。

---

## 3. V1 实施方案（运行时挂点）

### 3.1 资产与加载

- 资产：`assets/props/watergun/watergun.glb`（`assets/**` 已 gitignore；`pet-asset://` 可读 `assets/**`，见 `src/main/protocol-path.ts`）。
- 加载：新增 `src/renderer/src/vrm/prop-loader.ts`（`GLTFLoader`，不用 VRM 插件；复用场景 `LoadingManager`）；加载后 `Box3` sanity：长边应在 **0.45–0.75 m**，否则 warn + 用 manifest `scale` 兜底。
- 材质：GLB 自带 PBR + 内嵌贴图可直接用（`tests/tmp/props/watergun/glb_hero.png` 已确认观感）。若要和角色 MToon 统一，运行时换 `MeshToonMaterial`（复用 `assets/model/optimized/toon3.png` 渐变），成本 ≈ 30 行。

### 3.2 挂点

- 挂 **`vrm.humanoid.getRawBoneNode('rightHand')`**（蒙皮最终骨；`humanoid.update()` 每帧回写 → 子树自动跟随；与未来 VRMA 管线结论一致）。备选 normalized 骨（偏移可移植）见 runtime 文档 §1.6。
- **不要在 `avatar-loader` 里挂**；由场景/动画层（建议新增 `prop-layer.ts`）在 avatar 就绪后 `attach`、在 `dispose` 前 `detach`（`VRMUtils.deepDispose` 会连子节点一起释放，`avatar-loader.ts` §dispose）。

### 3.3 校准（关键且唯一有手感的环节）

目标：握把/扳机护圈落在右掌内，枪管沿前臂前向、略上扬；`meta.json` 已给尺寸基准。步骤：

1. 初值：取 §1.2 的 `Gun_b_01_JNT` 相对右手骨变换 `O_g`（`rel_t=(0.0129,0.0431,0.0862)`、`rel_q=(0.657,-0.013,-0.049,0.752)`，Skill01 f100），再按 VRM raw 手骨 rest 约定换算为 `O_v`；换算不确定时先按 `O_g` 直接试。
2. 在 VRM rest/T-pose 下 `rightHand.attach(gun)` 烘焙一次局部偏移（`Object3D.attach` 会反算局部，祖先无非均匀缩放的要求满足，`pet-scene-vrm.ts` `modelRoot.scale=1`）。
3. 用现有预览工具截图 4 视图迭代：`node scripts/vrm/motion/preview-adv.mjs --clips skill01 --frames 0,0.25,0.5,0.75 --views front,side,threeQuarter,hand`（也可用 `capture-vrm.mjs`）；每次只调 `position/quaternion` 中的一项，记录到 `prop-config.ts`。
4. 验收：Skill01 的举枪/射击帧枪口朝前不穿手；idle 时枪不穿身体/衣服；左右手交叉帧不穿模。
5. 校准值持久化：V1 放 `src/renderer/src/vrm/prop-config.ts`（不动冻结契约）；后续若要 per-avatar 再进 `vrm-manifest.json` 的 `handProps`（见 runtime 文档 §4）。

### 3.4 按动作片段显示/隐藏

数据流（不在运行时猜）：`scripts/vrm/motion/clips.hsr.json`（源 clip 覆盖表）→ 加可选 `prop` 字段 → `build-app-manifest.mjs` 透传到 `assets/motions/app-catalog.json` → `AppCatalogClip` 加可选 `prop` → `prop-layer.update()` 每帧读当前 clip 状态切 `visible`。

V1 判定规则（初版，待用户按实机视频校准）：
- `tags` 含 `skill` / 动作名 `Skill*` / `MazeSkill*` / `PassiveSkill*` → `hold`（持枪）；
- 其余 idle/walk/talk/sit/sleep/stun 等 → **先按「隐藏」实现，可一键改回常显**（人设/官方演示里闲时是否持枪未被核实，避免先入为主）；
- 过渡 0.1–0.15 s 缩放淡入，避免瞬移；`holster`（收在腰侧/背后）先不做，隐藏更稳。

### 3.5 帧序与生命周期

```
clipPlayer.update() → expression → lookAt → humanoid.update() → propLayer.update(dt)（只改 visible/过渡）→ vrm.update(dt) → render
```
- prop 在骨下 → 渲染前 `matrixWorld` 自动最新，无需每帧复制；
- 换模型/退出前 `propLayer.detach()`，否则 `deepDispose` 连带释放；
- 失败降级：任何加载/校准异常只 warn、隐藏水枪，不黑屏（沿用项目子层降级原则）。

### 3.6 工作量与验收

| 项 | 估计 |
|---|---|
| prop-loader + prop-layer（含 catalog 透传） | 0.5 天 |
| 校准迭代（预览截图） | 1–2 h |
| 单测（状态解析/降级、bbox sanity）+ 实机冒烟 | 0.5 天 |
| **合计** | **约 0.5–1 天** |

验收：Skill01/Skill02 类动作 = 持枪且枪不穿手；idle = 按决策显/隐；切换无闪烁；`pnpm typecheck` + 现有测试通过；私有资产不进入任何导出/公开产物。

---

## 4. 为什么不烘焙进 VRM（决策理由）

1. **永久持枪 = 空手动作穿帮**：VRM 里的武器节点不受 VRMA/JSON clip 控制（VRMA 规范只允许 humanoid 骨轨道），只能靠 app 运行时切 `visible`——既然最终仍要运行时控制，就不如直接运行时挂点（少一次资产往返）。
2. **改模型成本**：烘焙要动 PMX→VRM 管线（39 材质 → 40、材质/spring 校验、回归）；以后换枪/改握姿都要重导。
3. **烘焙的合理用途**：做一个「永久持枪」的展示/导出变体（如给别人的场景用）时才值得；步骤已备（`watergun-bake-vrm.md`）。

---

## 5. 对 Windows 侧（豆包）的增量指令

**结论：保持现状，不新增任务。**

1. 全量 138 继续用 **skeleton-only**（`run_full.bat` / `mode:all`）导出，体积小、正好是 Mac 侧转动作所需；**不要**改成全场景导出（138×≈11 MB 没必要）。
2. **保留 pilot 的 6 个 full-scene FBX**（`Skill01.fbx` 等，11 MB/个）——水枪网格与武器骨动画只在这些全场景文件里；已回传，无需重导。
3. 可选（低优先级）：若 `D:\sjxl\max\` 里能看到 `Avatar_AventurineW_00_Weapon_Color.png` 等游戏贴图，可单独打包回传一张水枪贴图用于与本地 `水枪.png` 对比分辨率/色彩；不传也不影响（本地贴图 UV 已吻合）。
4. **只有 V2 想做「技能里武器自身动画」时**才需要 subset 模式补导：按 `run_subset.bat` 的 ~14 个关键片段（或技能清单 8–12 个）导出 full-scene FBX；届时由 Mac 侧给具体文件名清单，**本轮不要动**。

---

## 6. V2 可选增强（先不做，留接口）

- **武器自身动画**：Skill01 的「手骨→枪」相对变换有 1–2 cm/1–2° 漂移（= 游戏里的举枪/后坐）。若 V1 观感不足，可从对应 full-scene FBX 采 `Gun_b_01_JNT` 相对右手骨的 per-frame 轨道（四元数+位移），与 body clip 同帧播放，实现「枪跟着技能抖动」。需要 subset 补导 + pipeline 增加一个采样输出（约 0.5–1 天），数据很小（250 帧 × 7 float）。
- **左手贴合**：V1 用源动作自带的双手持枪姿态；若 retarget 后左手明显离枪（预计 1–3 cm），优先在数据侧给个别 clip 的 `LeftHand` 加常量偏移，不上 IK。
- **收纳位**：腰侧/背后第二把实例 + `holster` 状态（`visible` 切换，不改挂点）。
- **风格统一**：把 GLB 材质换成 MToon 或 `MeshToonMaterial`（toon3.png）。

---

## 7. 风险与待确认

| 风险 | 影响 | 缓解 |
|---|---|---|
| 校准初值方向不对（游戏手骨 ↔ VRM raw 手骨 rest 约定差异） | 枪歪/穿手 | 用 preview 截图迭代 2–3 次；`meta.json` 有尺寸基准；runtime 文档 §3.3 有换算备选 |
| 哪些 clip 该持枪未核实（官方实机画面未看） | 待机/社交动作可能本应持枪 | V1 先技能持枪、其余隐藏，可一键切常显；**建议用户提供 1–2 个实机视频/截图确认** |
| 双手动作左手离枪 1–3 cm | 轻微不贴合 | 数据侧常量修正（不做 IK） |
| PBR 水枪 vs MToon 角色风格差异 | 观感突兀 | 换 MeshToonMaterial（复用 toon3.png） |
| `deepDispose` 连带释放道具 | 换模型后报错 | prop 层持有引用并在 dispose 前 detach |
| 版权 | 合规 | 仅本机私有；`assets/**` 已 gitignore；不发布/不二次配布 |

---

## 8. 下一步清单

1. [Lead/开发] 实现 `prop-loader.ts` + `prop-layer.ts` + catalog `prop` 透传，按 §3.3 校准，出 4 视图截图 + 实机冒烟。
2. [用户] 若方便，提供 1–2 个「戏浪」实机/技能视频或截图，用于确认「哪些动作持枪 / 待机是否持枪」；或直接在验收时口头指定。
3. [豆包/Windows] 维持全量 skeleton-only 导出；本轮不新增任务（见 §5）。
4. [后续] 视观感决定是否做 V2 武器自身动画（需 subset 补导）。

---

## 9. 相关文档与产出

- `docs/research/watergun-runtime-attach.md` — 运行时挂点 API/坐标系/校准/接入点（291 行）
- `docs/research/watergun-bake-vrm.md` — Blender 烘焙进 VRM 1.0 的规范依据与步骤（387 行）
- `docs/research/watergun-asset-sourcing.md` — 资产来源/授权/兜底（195 行）
- `assets/props/watergun/watergun.glb` + `meta.json` — 已提取资产（私有，gitignore）
- `scripts/props/extract-watergun.py` — 可复现提取脚本
- `tests/tmp/props/watergun/glb_*.png` — GLB 渲染证据
- `tests/tmp/adv-pilot-v3/pipeline/preview/skill01-front-050.png` — 现状对照（VRM 空手举枪）


---

## 10. V1 实现记录（2026-11-09 晚，已交付）

### 10.1 行为

- **持枪规则（用户要求：正常的、没有枪的动作都不要持枪）**：只有 `set = adv`（砂金·戏浪动作集）且 tags 含 `skill` 的 clip 显示水枪；`idle / walk / sit / talk / stun / hit / break / revive / 交互` 等**一律空手**。
  - 规则在 `src/renderer/src/vrm/watergun-attach.json` 的 `policy`（`holdSets: ["adv"]`、`holdTags: ["skill"]`、`holdClipIds: []` 逐条覆盖）里；该 JSON 由 renderer 直接 import，改完在 `pnpm dev` 下热更新、打包时随 renderer bundle 生效（无需重跑 assets 管线）。
  - 当前 app 的动作目录只有 `hsr` / `mate` 集（没有 `adv`），因此**现有 app 界面不会出现水枪**；等 138 条戏浪动作进 app catalog（`adv` 集）后自动生效。
- 显隐只切道具 `visible`，不写任何骨骼；道具是 hand 骨子节点，随 humanoid 动画（JSON clip 或未来 VRMA）自动跟随。
- 失败降级：GLB 缺失/损坏、VRM 缺 hand 骨、bbox 尺度异常 → 只 warn + 隐藏水枪，动画主链路不受影响。

### 10.2 代码/资产清单

| 文件 | 说明 |
|---|---|
| `assets/props/watergun/watergun.glb` + `meta.json` | 提取的水枪（私有，gitignore；2.38 MB、贴图内嵌） |
| `scripts/props/extract-watergun.py` | 从全场景 FBX 可复现提取（Blender 无头） |
| `scripts/props/calibrate-watergun-from-fbx.py` | 从 Tpose/Skill01 FBX 导出枪世界变换采样（标定用） |
| `scripts/props/calibrate-watergun.mjs` | 由 VRM FK + 采样反推挂载局部变换，输出一致性报告 |
| `src/renderer/src/vrm/watergun-attach.json` | **校准值 + 持枪规则**（见 §10.3） |
| `src/renderer/src/vrm/prop-config.ts` | 配置清洗 / 持枪规则纯函数 / catalog 解析（新增） |
| `src/renderer/src/vrm/prop-layer.ts` | GLB 加载、挂 hand 骨、显隐、bbox 尺度校验、dispose detach（新增） |
| `src/renderer/src/vrm/animator.ts` | 每帧 `handProp.update(resolveClipMeta(currentClipId))`（在 `humanoid.update()` 之后、`vrm.update()` 之前）；dispose 时先 detach |
| `src/renderer/src/main.ts` | 创建 prop 层、异步加载 catalog 元信息、调试面 `handProp` 快照 + `debugSetHandPropVisible()` |
| `src/renderer/src/vrm/runtime-types.ts` | animator 选项新增可选 `handProp` / `resolveHandPropClipMeta`（只增不改） |
| `src/renderer/src/debug.ts` | `window.__aventurineDebug.handProp` / `debugSetHandPropVisible` |
| `tests/vrm-hand-prop.test.ts` | 12 条纯逻辑单测（规则/清洗/catalog 容错） |

预览工具（dev-only）新增道具能力：`viewer.js` 加载 GLB + 校准/固定变换 + `setPropVisible`；`preview-electron.mjs` / `preview-adv.mjs` 新增 `--prop` / `--prop-calib` / `--prop-transform` / `--prop-hold`。

### 10.3 校准值（`watergun-attach.json`）

挂到 `vrm.humanoid.getNormalizedBoneNode('rightHand')` 的局部变换：

```
position   = [-0.072608, 0.010108, 0.031722]   # 米
quaternion = [ 0.545381, -0.533414, -0.499501, 0.410521]
scale      = 1
```

推导：源 `Skill01.fbx`（全场景，武器骨已跟手）→ 取动画中段 4 帧（clip frame 30/40/50/60，对应 source frame 61/81/101/121）→ 用「VRM rightHand normalized 世界矩阵 FK」反推 `T = inv(H_v) · W_gun` → 4 帧一致性 **max 0.36°、位置 spread ≤2.4 cm**（中段持枪稳定；开头/结尾帧有武器自身挥动动画，属预期）。复现：
```bash
Blender -b --factory-startup --python scripts/props/calibrate-watergun-from-fbx.py
node scripts/props/calibrate-watergun.mjs
```

### 10.4 预览/验收证据（`tests/tmp/props/watergun/v1-evidence/`，gitignore）

| 文件 | 内容 |
|---|---|
| `skill01-sheet.jpg` | skill01（持枪）3 视图 × 5 帧接触表 |
| `idle-sheet.jpg` / `walk-sheet.jpg` / `talk01-sheet.jpg` / `stun-sheet.jpg` | 普通动作：**空手**（规则生效） |
| `hero-grid.jpg` | 持枪 3 帧 + idle 空手 1 帧拼图 |
| `before-after-skill01-050.jpg` | 修复前（空手举枪）vs 修复后（手持水枪） |

复现命令：
```bash
node scripts/vrm/motion/preview-adv.mjs   --clips skill01,idle,walk,talk01,stun   --clips-dir tests/tmp/adv-pilot-v3/pipeline/clips   --frames 0.1,0.3,0.5,0.7,0.9 --views front,side,threeQuarter   --prop assets/props/watergun/watergun.glb   --prop-transform src/renderer/src/vrm/watergun-attach.json   --prop-hold skill01   --out tests/tmp/props/watergun/v1-evidence
```

### 10.5 自动化验证

- `pnpm typecheck`（node + web）：通过。
- `pnpm test`：107 文件 / **1838 passed** / 14 skipped（含新增 `tests/vrm-hand-prop.test.ts` 12 条）。
- app 内验证接口：`window.__aventurineDebug.handProp`（`ready/attached/visible/clipId/error/lengthMeters`）；`debugSetHandPropVisible(true/false/null)` 可强制显隐做截图/冒烟。
- 实机（Electron dev）验证（2026-11-09）：`node scripts/vrm/capture-app.mjs --poses stand,pat,drag` → 三个姿态 `handProp={ready:true,attached:true,visible:false}`（普通/交互动作不持枪，规则生效）；加 `--prop-visible 1` 强制显示用于验证挂点渲染（`tests/tmp/props/watergun/app-capture-rule/rule-vs-debug.jpg` 左=规则模式空手、右=调试强制显示）。⚠️ 该开关仅调试用，会在屏幕上打开真实 app 窗口；验收普通行为时不要加。

### 10.6 已知限制 / 下一步

1. **实机观感待验收**：预览管线是 600×800 固定视图；app 里宠物尺寸小、相机正交，需实机看一次握持位置（若想更贴手可微调 position ±1–2 cm）。
2. **左手贴合**：V1 固定挂右手，源动作若双手持枪，左手可能差 1–3 cm（桌宠尺寸基本不可见）；如需要再按 plan §6 数据侧修。
3. **V2 武器自身动画**：源 skill 动画里枪有相对手的挥动（本次只校准了中段静止握持）；要完全还原需 subset 补导 + 按 clip 采样 Gun 骨局部轨道（见 §6）。
4. **风格**：当前 GLB 是 PBR 材质；若与 MToon 角色不搭，运行时换 `MeshToonMaterial`（toon3.png）即可。
5. 画面里水枪贴图偏亮/高光明显——GLB 直出 PBR；实机若太亮可降 `roughness`/改 toon。
