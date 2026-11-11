# Wave 1 · V2 验收证据与偏差报告（PMX→VRM 产出）

> 日期：2026-11-08 · 状态：**PASS（含 2 项已记录偏差）** · 证据目录：`tests/tmp/v2-evidence/`（gitignore）
> 工具：`scripts/vrm/capture-vrm.mjs`（新增，通用 VRM 抓图/诊断 CLI） · 关联：`PLAN.md` §5 V2 行、
> `docs/wave2-vrm-runtime-design.md` §0（W1-V2 缺口）、`docs/vrm-tpose-repair.md`、`docs/wave15-report.md`
> 目标：为 W1-V2（PMX→VRM 转换产出）补「three-vrm 加载 + 三视图 + 能力 + 贴图」的正式证据与偏差报告。

---

## 1. 验收目标与实际实现路线

原 PLAN 验收口径（`PLAN.md` §5 Wave 1 V2）：产出 `assets/vrm/aventurine.vrm`（VRM 1.0）；**Blender 四视图
+ three-vrm 查看器观感通过**；20+ 表情、spring 链、贴图无缺失；PMX 29k 顶点不爆。

实际实现（见 `docs/vrm-tpose-repair.md` §2.1）：源 PMX `assets/model/星穹铁道—砂金·戏浪.pmx`（A-pose）经
**VRMify（纯 Python PMX→VRM）** 重转为规范 T-pose VRM 1.0 → 当前产物 **`assets/vrm/aventurine-tpose.vrm`**
（manifest 目标）。**未走** W0-2 装好的 Blender VRM Add-on 管线。

**为什么可以等价替代**：
1. V2 验收的实质是「产物是合规 VRM1.0 + three-vrm 可完整加载渲染 + 表情/spring/贴图/蒙皮不缺失」，本报告
   §3/§4 用 three-vrm 3.5.5 的实测逐项证明；Blender Add-on 只是**转换手段**之一，非验收对象。
2. VRMify 恰好覆盖了本项目最痛的 MMD 差异：A-pose→规范 T-pose 自动修正、**付与骨（足D 等）合并进所跟随骨+权重**、
   MMD 物理→SpringBone、MMD 骨骼控制骨清理；Blender Add-on 路线这些都要手写脚本，风险更高。
3. 唯一无法替代的是「Blender 四视图」这一**渲染证据形式**——已用 three-vrm 三视图（front/side/threeQuarter）
   + 既有 Blender PMX v1 预览能力证据替代，见 §5 偏差 D1。

复跑（在仓库根目录；详细准备见 `docs/vrm-tpose-repair.md` §2.1）：

```bash
python3 /tmp/vrmify/convert/pmx2vrm.py "assets/model/星穹铁道—砂金·戏浪.pmx" \
  -o "assets/vrm/aventurine-tpose.vrm" --spec 1.0 --scale 0.0799777 \
  --title "砂金·戏浪" --author "miHoYo / 用户本地转换"
```

---

## 2. 本次证据工具（新增 `scripts/vrm/capture-vrm.mjs`）

通用版 W0-4 抓图工具（无 per-model 严格期望）：`--vrm` 必填，可选 `--tag/--views/--record-ms/--out/--check`；
复用 `serve-evidence.mjs`（静态服务器 + `/__evidence` POST）与 `electron-capture.mjs`（Electron 打开
`canary-viewer.html?vrm=...` 驱动抓图），另用 sharp 做像素统计、直接解析 GLB JSON chunk 做资产侧实测；
`--check` 只校验已有产物（幂等、不启动 Electron、不写文件，CI 可用）。内置 lockfile 保证一次只跑一个
Electron 抓图进程；本机运行用 `HOME=/tmp/pet-dsh-home` 隔离。

```bash
# 主证据（本报告数据来源）
node scripts/vrm/capture-vrm.mjs --vrm assets/vrm/aventurine-tpose.vrm --tag tpose \
  --views front,side,threeQuarter --record-ms 6000
# 幂等校验（CI/复跑）
node scripts/vrm/capture-vrm.mjs --vrm assets/vrm/aventurine-tpose.vrm --tag tpose \
  --views front,side,threeQuarter --record-ms 6000 --check
# 对照（旧 VRM0 canary，验证工具通用性与旧资产仍可加载）
node scripts/vrm/capture-vrm.mjs --vrm "assets/vrm/canary/砂金石心十人公司制服(0.x).vrm" --tag canary
```

结果：**tpose PASS（18 pass / 0 fail / 1 warn）、canary PASS（17 pass / 0 fail / 0 warn）**；两次均
`electron-capture` exit 0、0 pageerror / 0 console error / 0 network failure / 0 main error。

---

## 3. 产出资产属性（全部为本次实测值，非文档转抄）

来源：`tests/tmp/v2-evidence/tpose/diagnostics.json`（three-vrm 3.5.5 运行时）+ GLB JSON chunk 直读
（`run-summary.json.glb`）。环境：Electron 44.10.2 / Chrome 152 / three r171 / three-vrm 3.5.5。

| 项 | 实测值 | 来源 |
|---|---|---|
| 文件 | `assets/vrm/aventurine-tpose.vrm`，**25,957,256 B（24.75 MiB）**，GLB v2，generator=`VRMify` | GLB |
| VRM 规范 | **VRM 1.0**（`VRMC_vrm.specVersion=1.0`；meta title=`砂金·戏浪`，license=`vrm.dev/licenses/1.0`） | GLB + diagnostics |
| humanoid | **53 骨**（normalized 53 / raw 53；必需 15 骨齐全、`autoUpdateHumanBones=true`；含 30 手指 + toes） | diagnostics |
| 表情 | **95 个** = 17 preset（aa/ih/ou/ee/oh、blink/blinkLeft/blinkRight、lookLeft/Right/Up/Down、happy/angry/sad/relaxed/surprised）+ 78 custom；**无 neutral preset** | GLB + diagnostics |
| SpringBone | **50 条链 / 170 joints / 21 collider group / 600 colliders**（GLB 权威口径）；three-vrm 3.5.5 `springBoneManager` 只暴露 joints=**120**（API 口径差异，见 D2） | GLB + diagnostics |
| 材质 | **39 个，全部 MToon**（`VRMC_materials_mtoon` 39/39）；glTF alphaMode = **21 OPAQUE + 12 MASK + 6 BLEND**，doubleSided 1；viewer transparent=6、depthWrite=false=6；BLEND 中 alpha≈1 有 4 个（目光/褲金/衣2金/鏡片）、真半透明 2 个（颜赤 alpha=0、目影 0.3） | GLB + diagnostics |
| 贴图 | **17 textures / 17 images，加载 17/17、失败 0**；38/39 材质带 baseColorTexture | diagnostics |
| 网格 | 3 meshes / 39 primitives / 375 nodes / 1 skin；**POSITION 顶点合计 37,196**（按 primitive 计，拆分顶点重复统计）、**三角 51,829**（与 `renderer.info.render.triangles=51,829` 完全一致）；内嵌动画 0 | GLB + diagnostics |
| 尺寸/朝向 | bbox 高 **1.7347 m**（脚底 y=0.0007）、宽 1.575 m、厚 0.348 m；**面向 +Z**（toes 启发式 yaw=0°，与 manifest `yawOffsetDeg:0` 一致） | diagnostics |
| lookAt | 有（`VRMLookAtBoneApplier`，offsetFromHeadBone `[0,0.06,0]`） | diagnostics |
| 加载 | 页面 53 ms、模型解析 **115 ms**、渲染 60 fps（本机 ANGLE Metal / Apple M5 Max）；0 loadError / 0 warning | diagnostics |

> 与旧资产对照（`tests/tmp/w0-4/aventurine/diagnostics.json`，W0-4 时代）：旧 `aventurine-waveflair` 52 骨、
> 12 表情、20 贴图、**无 springBone**、**面向 -Z**；新 T-pose 版在骨数/表情/贴图/物理/朝向上全面达标。

---

## 4. 三视图 / 录屏 / 附件证据

| 证据 | 路径（`tests/tmp/v2-evidence/`，gitignore） | 关键指标 |
|---|---|---|
| 三视图 | `tpose/front.png`、`tpose/side.png`、`tpose/threeQuarter.png` | 均 720×960；非透明像素占比 **0.1064 / 0.0706 / 0.1076**，非透明区平均亮度 223.33 / 214.37 / 222.06；无黑面/丢贴图 |
| 录屏（6s） | `tpose/recording.webm` | 2,047,716 B、**6,002 ms / 360 帧**（60fps）；EBML 头正确 |
| idle 动画证明 | `tpose/motion-a.png`、`tpose/motion-b.png` | 间隔 2,474 ms 两帧；骨骼最大角差 **12.81°（head）**，AnimationMixer 驱动 |
| 材质对照 | `tpose/front-force-opaque.png` + `diagnostics.main.forceOpaque` | forceOpaque 只改 **4** 个 alpha≈1 BLEND 材质（目光/褲金/衣2金/鏡片），保留 2 个真半透明；画面差异小（旧资产 W0-4 需改 54 材质，本资产 alpha 状态已大幅改善） |
| 机器可读 | `tpose/diagnostics.json`、`tpose/console.log`、`tpose/run-summary.json`、`run-summary.json`（两模型合并） | 含全部校验项与 pixels/glb/diagnostics 摘要 |
| 对照模型 | `canary/front.png`、`canary/side.png`、`canary/threeQuarter.png`、`canary/diagnostics.json` | VRM0：51 骨 / 13 表情（GLB 24 blendShapeGroups 经 v0compat 归一）/ 31 材质 / 13 贴图 / 无 spring，加载 PASS |

既有补充证据（不重复生产，引用现路径）：
- 模型动作观感/接触表（T-pose 版 29 clip）：`tests/tmp/wave15/final-tpose/`（145 PNG + 29 clip 接触表 +
  `contact-firstframes.jpg`）、逐帧 metrics `tests/tmp/wave15/final-tpose-metrics/`（29 个 metrics json）。
- 旧/新模型对比与手部特写：`tests/tmp/tpose-review/compare/*-full-before-after.jpg`、`tests/tmp/tpose-review/hands/`。
- 旧资产 W0-4 三视图/录屏（历史对照）：`tests/tmp/w0-4/aventurine/`、`tests/tmp/w0-4/canary/`。
- 表情预览（V6 表情层，17 条 clip）：`tests/tmp/expression/preview/**`（93 帧 + 21 张接触表，见
  `docs/expression-mapping.md` §0「预览」行 / §4 验收证据）、`tests/tmp/expr-hsr/renders/**`、`tests/tmp/expr-mate/`。

---

## 5. 与 V1.5-Tpose / GT 报告的一致性

- **姿态 ground truth**：Unity 6000.2.6f2 + UniVRM 同模型逐帧对比（11 clip / 3,657 帧）**ΔW mean 3.44°**
  （Hips 1.8°、手臂 4.2°、腿 1.9–2.8°；旧 A-pose 资产同一测试 102.47°），引用
  `docs/vrm-tpose-repair.md` §3.1、`docs/wave15-report.md` §5.5。本次独立测得「面向 +Z（yaw 0°）、
  身高 1.7347 m、50 spring 链」，与 GT 报告所用模型/朝向不矛盾。
- **自然度**：T-pose 版 29 clip metrics **PASS 23 / WARN 6 / FAIL 0**（WARN 均为动作意图/摆位，无结构 FAIL），
  引用 `docs/wave15-report.md` §4.3；证据 `tests/tmp/wave15/final-tpose-metrics/`、`final-tpose/`。
- **manifest 一致性**：`src/shared/vrm-manifest.json` aventurine 条目指向 `vrm/aventurine-tpose.vrm`、
  `yawOffsetDeg:0`、`springChains:50`、`heightMeters:1.73`；本次实测 yaw=0°/spring 50 链/height=1.7347
  与之一致（1.73 vs 1.7347 为 manifest 两位小数取整）。

---

## 6. 已知偏差与风险

| # | 偏差/风险 | 实测/依据 | 影响与处置 |
|---|---|---|---|
| D1 | **实现路线偏差**：VRMify 替代 PLAN 的 Blender Add-on 管线；**Blender 四视图未对最终 VRM 执行** | 产物全项达标（§3/§4），three-vrm 三视图替代；Blender 4.2 + MMD Tools 的无头 PMX 四视图能力已在 v1 实测（`docs/research/tooling-blender.md` §3，`scripts/anim-pipeline/blender/render_views.py`，0.2s/张） | 判定等价替代；若验收严格要求 Blender 四视图，可在有 Blender+VRM Add-on 的会话复跑（需 `assets/model/*.pmx` 与渲染权限），非阻塞项 |
| D2 | **文档数字漂移**：`docs/vrm-tpose-repair.md` §2.1 写「54 humanoid 骨 / 175 collider」，`docs/vrm-contract.md` 写「50 链/175 collider」 | 本次实测 **53 骨**（与 `vrm-contract.md` 表格/wave15-report 的 53 一致；54 为旧说法）、**50 链 / 170 joints / 21 collider groups / 600 colliders** | 建议 Lead 以本报告实测值更新契约文档；不影响资产使用。viewer 的 `chainCount=0` 是 three-vrm 3.5.5 不暴露 `springBoneChains` 的查看器 API 口径（非资产缺 spring）；`joints=120` vs GLB 170 为 three-vrm 内部 joint 管理口径，V5/V6 以实际摆动效果验收 |
| D3 | **spring 性能未在 app 内实测**：50 链 / 170 joint / 600 collider 的每帧模拟成本 | 本证据为静态三视图 + idle（60fps） | V5/V6 接入后用真实 app 场景实测 FPS/掉帧；必要时减 collider（600 个偏多）或降 stiffness 采样 |
| D4 | **材质 alpha/BLEND 状态**：6 个 BLEND（4 个 alpha≈1 + 颜赤 alpha=0 / 目影 0.3）；viewer 6 个 transparent 且 depthWrite=false | 三视图观感完整、无黑面；forceOpaque 仅 4 材质变化（旧资产 54） | 旧资产 W0-5 的「BLEND-mislabelled」问题已大幅收敛；仍建议 V6 材质/光照调优时按 `transparentWithZWrite` 决定 OPAQUE/BLEND，避免局部排序/轻薄观感 |
| D5 | **贴图数量差异**：PMX 源 23 贴图（v1 文档）→ VRM 17 images；未逐张核对是否为 VRMify 合并/复用 | 17/17 加载成功、0 失败，三视图贴图观感正常 | V6 观感确认无丢图；如需严格资产比对可加「贴图 sha/尺寸清单」工具 |
| D6 | 无 neutral 表情 preset（95 个中不含 neutral） | 与 `vrm-contract.md` 记录一致 | V6 已按「业务 neutral = 全 expression 清 0」处理，不设无效绑定 |
| D7 | 本证据为**离线查看器**证据（Electron 抓真图），非 app 实机渲染；四视图只抓了 3 个标准视图（工具支持 `--views back`） | `--views front,side,threeQuarter`（按 V2 验收要求） | app 实机（V1/V5）与 back 视图可在后续会话补；不影响 V2 资产验收结论 |

---

## 7. 验收结论：**PASS**（含 D1/D2 两项已记录偏差）

| # | V2 原验收项 | 结论 | 证据 |
|---|---|---|---|
| 1 | 产出 `assets/vrm/aventurine.vrm`（VRM 1.0） | ✅ PASS（实际文件名 `aventurine-tpose.vrm`，manifest 目标） | §3 GLB `specVersion=1.0`、25,957,256 B |
| 2 | Blender 四视图 + three-vrm 查看器观感通过 | ⚠️ **PASS（替代）**：three-vrm 三视图 PASS；Blender 四视图缺（D1） | §4 三视图 + `tests/tmp/wave15/final-tpose/` |
| 3 | 20+ 表情 | ✅ PASS（95 = 17 preset + 78 custom） | §3 diagnostics 表情名列表 |
| 4 | spring 链 | ✅ PASS（50 链/170 joints/600 colliders；实际运行 three-vrm joints=120） | §3 GLB/diagnostics |
| 5 | 贴图无缺失 | ✅ PASS（17/17 加载，failed 0） | §3/§4 |
| 6 | PMX 29k 顶点不爆 | ✅ PASS（POSITION 37,196 / 三角 51,829，60fps 渲染） | §3 diagnostics+GLB |

**遗留待办（不阻塞 V5）**：① Lead 更新 `docs/vrm-contract.md` 的 spring/collider/骨数实测值（D2）；
② V5/V6 实机 spring 性能与材质观感确认（D3/D4）；③ 需要时补 back 视图与 Blender 四视图（D1/D7）。
