# 砂金·戏浪 全局桌宠 — Phase 3（VRM 迁移）实施计划

> 工作区：`/Volumes/4TB外置盘/deepseek-harness/aventurine-pet-vrm`（从 v1 工作区 fork，保留全部可复用实现）
> v1 归档：`/Volumes/4TB外置盘/deepseek-harness/aventurine-pet`（只读参考，**不要修改**）
> 日期：2026-11-08（2026-11-09 / 2026-11-11 更新） · 状态：**Wave 0–3 已完成**（V5–V8 见 `docs/wave2-acceptance.md`；V9/V10 + DSH 双向集成见 `docs/wave3-acceptance.md`，2026-11-11）
> 目标平台：macOS（本机 macOS 27.0.1 / arm64）
> 模型：砂金·戏浪（PMX→VRM 本地转换，**私有，禁止二次配布/商用，不发布**）

---

## 0. 背景与结论

- v1 的 Wave 1/2 已完成，但 **Wave 2.5 的 VMD 成品动作路线观感不通过**（用户实机验收「诡异、没眼看」）。
- 根因不是"还差几个参数"，而是路线本身：VMD 是**为特定 MMD 骨架写死**的动作，跨模型用要逐项修 IK 语义/センター位移/贴地/步频/比例，补丁没有终点。
- 决策：**切换到 VRM 路线**——PMX 本地转 VRM（Blender），渲染换 `three-vrm`，动作换 **humanoid 标准动画（Mixamo/FBX → Blender 重定向 → glTF/VRMA）**；spring bone 解决头发/衣摆僵硬；MToon 保持质感。v1 的窗口层/行为/物理/桌面感知/交互/DSH 全部复用。
- **不改造 Mate-Engine 引擎**：它是 Unity 6 + Windows 工程；非官方 macOS 移植仍是 pre-alpha（透明窗口/置顶/点击穿透/CGWindow 窗口探测/Dock 交互未完成），许可证为 MateEngine Pro License v2.1（衍生需同许可公开源码、禁止商业/二进制分发）。它真正值钱的是 VRM+动作，可用 three-vrm + Unity 烘焙动作获得（详见 `docs/research/mate-engine-vrm-eval.md`）。
- **现有实现有约 55% 可直接复用**（见 §3），所以本工作区是 **v1 代码基线 + VRM 渲染/动画替换**，不是从零开始。

---

## 1. 已确认决策（D1–D9）

| ID | 决策 |
|---|---|
| D1 | 渲染/动画层切 **three-vrm 3.5.5 + three 0.171 + @pixiv/three-vrm-animation**；保留 Electron 壳 |
| D2 | **不移植 Mate-Engine 引擎**；但用 Unity 6 **烘焙它的动作**（25–35 个宠物专属片段：窗沿坐/躲藏/拖拽/摸头）→ FBX→Blender→glTF/VRMA。U0/U1（装 Unity + 导出脚本）可与 Wave 1 并行，U2/U3 等 V2 产出目标 VRM 后执行；**不阻塞主线**，见 Wave 1.5 |
| D3 | 先做 **canary**：用现成 `assets/vrm/canary/砂金石心十人公司制服(0.x).vrm` 验证 three-vrm 加载/动作/观感，再转戏浪 VRM |
| D4 | PMX 旧路径保留为 **feature flag**（`PET_MODEL_BACKEND=vrm \| legacy-pmx`），随时回退 |
| D5 | 动作来源：Mixamo / 公开 FBX → Blender 重定向到 VRM humanoid → glTF/VRMA；缺失姿态（爬/扒窗/推窗等）用 Blender 摆姿成 clip 或程序化 additive 层 |
| D6 | 模型资产**私有**：`assets/model`、`assets/vrm`、`assets/motions`、`refs/` 全部 gitignore，不发布、不随 app 分发 |
| D7 | Blender 用已装好的 `/Volumes/4TB外置盘/deepseek-harness/tools/blender`（4.2.23 LTS + MMD Tools 4.5.14）；VRM 导出加装 **VRM Add-on for Blender** |
| D8 | 验收以**实机观感**为准：待机/走路/坐/摸头/拖拽/注视六项自然度清单（§10），不再以"数值有变化/测试通过"代替 |
| D9 | 旧 v1 的 VMD/程序化动画代码不删，移入 `src/renderer/src/animation/legacy/` 或保留分支引用；W3 之后决定是否移除。**2026-11-09 用户决策更新**：旧项目带来的**自定义动作资产**（`assets/model/optimized/motion-*.vmd` 13 个 + `motion-index.json`）已删除；**代码全部保留**（`animation/**`、`scripts/anim-pipeline/**`、旧动画测试），legacy-pmx 后端默认只做 PMX 静态渲染，只有 `PET_ANIM_BACKEND=legacy-pmx` 时接回 v1 程序化驱动。台词/文本全部保留并继续映射当前状态 |

---

## 2. 工作区现状（已就位）

```
aventurine-pet-vrm/
├─ PLAN.md                    # 本文件
├─ README.md                  # 快速开始
├─ docs/
│  ├─ reuse-audit.md          # v1 复用/替换审计（本 Phase 依据）
│  ├─ archive/PLAN-v1.md      # v1 计划归档
│  └─ …（v1 的 anim-tech-survey / anim-strategy / mate-engine-vrm-eval 等全部带入）
├─ assets/                    # 私有（gitignore）
│  ├─ model/                  # PMX + 贴图 + v1 legacy VMD（回退用）
│  └─ vrm/canary/…vrm         # canary VRM（制服款，14MB）
├─ refs/                      # 私有参考项目（gitignore）
│  ├─ Mate-Engine/            # 浅克隆（动作清单/未来 Unity 烘焙参考）
│  ├─ reze-rig/               # v1 VMD 路线参考（MIT）
│  └─ dsh-blender-plugin/     # Blender 自动化工具参考
├─ src/ tests/ scripts/ native/ bridge/ …  # v1 代码基线（含 Wave 2.5 未提交改动快照）
├─ electron.vite.config.ts / package.json / tsconfig*
└─ 外部工具（不复制）：tools/blender（815MB）、VRM addon（W0 安装）
```

---

## 3. 复用/替换矩阵（v1 审计结论）

| 模块 | 行数 | 处置 | 说明 |
|---|---|---|---|
| `src/main/**`（窗口/overlay/点击穿透/winlist/drag/DSH watcher/config/日志/tray） | 5,067 | ✅ 直接复用 | 与模型格式无关；最多改配置字段 |
| `src/preload/**` | 93 | ✅ 直接复用 | IPC 白名单 |
| `src/shared/**` | 637 | ✅ 扩展 | 新增 `vrm.ts`/`animation-contract.ts`；删 PMX 专属 manifest 前先冻结新契约 |
| `renderer/behavior/**` | 3,121 | ✅ 直接复用 | 状态机/活动/随机调度；只改动画回调接线 |
| `renderer/physics/**` | 1,221 | ✅ 直接复用 | 拖拽/惯性/重力/碰撞；模型高度从 VRM bbox 取 |
| `renderer/desktop/**` | 1,152 | ✅ 直接复用 | 窗口探测消费/坐窗/爬行/跟随 |
| `renderer/interaction/**` | 2,508 | ✅ 直接复用 | 指针/拖拽/摸头/触摸区/菜单；头部骨骼换 VRM humanoid head |
| `renderer/settings/**` | 825 | ✅ 复用+扩展 | 增加动画后端/模型切换 |
| `renderer/reactions/**` | 260 | ✅ 复用 | DSH 反应映射；动作 clip 名重映射 |
| `renderer/core/**` | 1,341 | ⚠️ 部分复用 | bubble/voicelines/contracts 保留；运行时动画适配改写 |
| `renderer/assets/**` | 366 | ⚠️ 部分复用 | `pet-asset://`/重试加载保留；PMX manifest 换 VRM manifest |
| `renderer/scene/**` | 1,742 | 🔁 替换 | three-vrm 场景；仅保留 fps-limiter/pixel-ratio 等小件 |
| `renderer/model/**` | 476 | 🔁 替换 | PMX layout/bounding/morph-map → VRM 对应实现 |
| `renderer/animation/**` | 8,526 | 🔁 替换（D9 保留 legacy） | VMD/程序化 → humanoid clip + spring bone + expression 层 |
| `native/winlist`、`bridge/**` | 195 / 726 | ✅ 直接复用 | 与模型无关 |
| `scripts/**` | — | ⚠️ 部分保留 | 构建/资源脚本保留；PMX/VMD 转接脚本移到 `scripts/legacy/` |
| `tests/**` | 59 文件 / 21,900 行 | ⚠️ 部分保留 | 11 个 animation 专属测试随实现替换；其余（desktop/behavior/physics/interaction/bridge/main）保留并适配 |

**结论：约 1.5 万行（≈55%）直接复用；替换渲染/动画/模型层约 1.1 万行。** 详见 `docs/reuse-audit.md`。

---

## 4. 目标架构

```
Electron main（不变）
  windows/overlay/click-through/winlist/drag/config/tray/DSH watcher
preload（不变，新增 vrm 配置读取）
renderer
  core/pet-runtime（适配）
  behavior / physics / desktop / interaction / settings / reactions（复用）
  vrm/                     ← 新增
    avatar-loader.ts       three-vrm 加载 VRM、humanoid bone 映射、MToon
    custom-spring.ts       若需要自控 spring bone（做花/衣摆链）
    expressions.ts         VRM expressionManager 驱动（眨眼/情绪）
    clip-player.ts         AnimationMixer 播 glTF/VRMA clip（idle/walk/sit/…）
    scene-vrm.ts           WebGLRenderer + 正交相机 + 光照 + 透明背景
  animation/               ← 改为适配器（保留 v1 接口名）
    index.ts               createPetAnimator → 内部调 vrm/clip-player（feature flag 决定后端）
    legacy/                ← v1 PMX/VMD 实现（D9，保留回退）
  assets/                  协议扩展 pet-asset:// 支持 .vrm/.glb/.vrma
```

- 动画后端切换：`PET_MODEL_BACKEND=vrm`（默认）/`legacy-pmx`；`PET_ANIM_BACKEND` 可单测。
- 保留 `PetMood` 与行为状态机契约，动作 manifest 把 mood → clip 文件映射，缺 clip 回退程序化/legacy。

---

## 5. 任务分解（含并行标记）

> `⚡` = 可与其他同 Wave 任务并行（scope 不重叠）；`🔗` = 依赖（等前序 merge 到 main）。

### Wave 0 — 基线（串行/小并行，先由一个窗口完成）

| ID | 任务 | 并行 | 依赖 | Scope | 验收 |
|---|---|---|---|---|---|
| W0-1 | 依赖与基线自检 | — | — | `package.json`、`pnpm-lock.yaml`、`README.md`、`.gitignore` | `pnpm install`；加 `@pixiv/three-vrm@3.5.5`、`@pixiv/three-vrm-animation@3.5.5`、`three`（沿用）；`pnpm typecheck` 通过；首个 commit |
| W0-2 | Blender VRM 工具链 | ⚡ | W0-1 | `scripts/vrm/install-vrm-addon.sh`、`docs/vrm-toolchain.md` | 在本机 Blender 4.2 装上 VRM Add-on，开启成功；用立方体+骨架导出一次 dummy VRM 成功（日志留档） |
| W0-3 | **冻结 VRM 契约** | ⚡ | W0-1 | `src/shared/vrm.ts`、`src/shared/animation-contract.ts`、`src/shared/assets-manifest` 扩展 | 类型评审通过并 commit；后续任务不得擅改 |
| W0-4 | canary 查看器 | ⚡ | W0-1、W0-3 | `scripts/vrm/canary-viewer.html`（或 dev-only route）、`scripts/vrm/screenshot.mjs` | 用 three-vrm 打开 canary VRM，截 3 视图 + 10 秒录屏；证明加载/MToon/骨骼正常 |

### Wave 1 — 四条并行泳道（4 个窗口）

| ID | 任务 | 并行 | 依赖 | Scope | 验收 |
|---|---|---|---|---|---|
| V1 | three-vrm 渲染路径进 app | ⚡ | W0-1/3/4 | `src/renderer/src/vrm/**`、`src/renderer/src/assets/**` 协议扩展、`src/renderer/src/scene` 接线 | app 内切 `PET_MODEL_BACKEND=vrm` 能加载 canary VRM；透明背景、MToon、humanoid 骨骼可访问；legacy 路径不回归 |
| V2 | PMX→VRM 转换管线（Blender） | ⚡ | W0-2 | `scripts/vrm/**`（import/mapping/cleanup/materials/spring/expressions/export/render-check） | 产出 `assets/vrm/aventurine.vrm`（VRM 1.0）；Blender 四视图 + three-vrm 查看器观感通过；20+ 表情、spring 链、贴图无缺失；PMX 29k 顶点不爆 |
| V3 | 动作资产管线（humanoid） | ⚡ | W0-2（可先用 canary 验证） | `scripts/vrm/motion/**`、`assets/motions/**`（私有）、manifest | Mixamo/FBX → Blender 重定向到 VRM humanoid → glTF/VRMA；至少 idle/walk/sit/pat/drag/salute 6 条；在 canary 上播放自然（无滑步/反关节） |
| V4 | legacy 隔离与迁移 | ⚡ | W0-3 | `src/renderer/src/animation/legacy/**`、feature flag、删/移 PMX 专属代码、测试更新 | `PetAnimator` 适配器可切换；`legacy-pmx` 仍可跑；v1 未提交改动入库；相关测试改绿 |

### Wave 2 — 戏浪接入与调优（4 个窗口）✅ 2026-11-09 完成

> 完成状态：V5 戏浪 VRM 主链（尺寸/朝向/贴地/站走坐睡拖拽）✅、V6 表情/眨眼/口型/look-at/spring/MToon ✅、
> V7 行为/物理/交互 humanoid 适配 + 用户反馈（拖拽侧身、走路头朝运动方向、DSH 动作映射）✅、
> V8 验收证据 + 临时 HOME 3 轮重启 + 真实数据隔离校验 ✅。详见 `docs/wave2-acceptance.md`。
> 自动化：typecheck 0 error、vitest 103 files/1775 passed、smoke(vrm) 与 smoke(legacy-pmx) 双绿。
> **2026-11-09 追加（用户决策）**：多动作状态随机播放/自然切换；旧 PMX 自定义动作资产（VMD）删除、代码与文本全保留；
> DSH 状态化编排（dshError 长时间倒地 hold→revive、工作小动作 skill01/02 随机 30–60s、启动入场序列、pose1-3 idle 稀有变体）；
> 推荐文档 `docs/vrm-motion-mapping-recommendations.md`（hide/windowLay 留 Wave 3）。

| ID | 任务 | 并行 | 依赖 | Scope | 验收 |
|---|---|---|---|---|---|
| V5 | 戏浪 VRM 接入主链 | ⚡ | V1、V2 | `src/renderer/src/vrm/avatar-*.ts`、`src/shared/vrm.ts` 配置、`assets/vrm/aventurine.vrm`（本地） | 新模型尺寸/朝向/贴地正确；站/走/坐窗口/拖拽基础动作可用；PMX fallback 仍在 |
| V6 | 材质/表情/spring bone 调优 | ⚡ | V5 | `src/renderer/src/vrm/expressions.ts`、`custom-spring.ts`、材质 override | 眨眼/笑/害羞等映射可用；头发/衣摆有 spring；MToon 观感接近参考；无大面积穿模/黑面 |
| V7 | 行为/交互/桌面层适配 humanoid | ⚡ | V5、V3 | `src/renderer/src/interaction/**`、`desktop/**`、`behavior/**` 的骨骼/高度引用 | 摸头命中的 head 骨正确；坐窗/爬/跟随/抛掷与新模型比例匹配；DSH 反应映射新 clip |
| V8 | 验收与实机录像 | ⚡ | V5–V7 | `docs/vrm-acceptance.md`、`tests/tmp/**`（gitignore） | 六项实机观感全部通过（§10）；截图/录屏留档；用户确认 |

### Wave 1.5 — Unity 烘焙 Mate-Engine 动作（可选，条件触发，不阻塞主线）

> 为什么单独成段：它**能做，但没法在 Wave 1 直接产出可用动作**——Unity `.anim` 是 humanoid muscle 数据，必须过 Unity/Avatar 才能导出；而且最好等 V2 的戏浪 VRM 出来再做最终重定向。U0/U1 不占主线窗口，可先跑。

| ID | 任务 | 并行 | 依赖 | Scope | 验收 |
|---|---|---|---|---|---|
| U0 | Unity 环境就绪（**需用户操作**） | ⚡ 可与 Wave1 同时 | 用户安装 | `scripts/unity-bake/environment.md`（文档） | Unity Hub + Unity 6000.2.6f2 安装并登录激活（Personal 免费）；能打开 Mate-Engine 工程；安装 FBX Exporter 包 |
| U1 | Clip 导出脚本 + 3 个试烧 | ⚡ | U0 | `scripts/unity-bake/ExportClips.cs`、`run-export.sh` | 批量导出 `idle/sit/drag` 等 3 个 clip 为 FBX（或采样 JSON）；骨架动画正确可回放 |
| U2 | Blender 重定向到目标 VRM | 🔗 | U1、目标 VRM（当前已存在 `aventurine-waveflair.vrm`；V2 补 spring/表情后重跑） | `scripts/unity-bake/retarget.py`、`assets/motions/mate/**` | 3 个 clip 在 canary/戏浪 VRM 上播放自然（无滑步/反关节） |
| U3 | 批量 25–35 个宠物专属片段 | 🔗 | U2 | `assets/motions/mate/**`、`assets/motions/manifest.json` | 覆盖窗沿坐/躲藏/拖拽/摸头/待机/走路等；三条清单验收通过 |

**触发条件**：U0/U1 随时可开（尤其 U0 需要你装 Unity）；U2/U3 在 V2 产出 `assets/vrm/aventurine.vrm` 后执行。
**成本**：Unity ~10GB + 工程导入较慢；U0–U3 合计约 3–5 人日（v1 审计结论）。

**当前状态（2026-11-08 晚更新）**：**U0/U1/U2/U3 已完成**。Unity 6000.2.6f2 + Hub `unity` CLI 跑通 batchmode（license preflight）；采用「合成 humanoid 骨架采样 → 归一化旋转 JSON → three-vrm normalized 骨骼回放」路线，**不需要 Blender retarget**（`retarget.py` 取消）。期间 GT 对拍定位并修复了 P0 合成骨架左右手性 bug（重烘焙后手臂误差 40–60°→~1°）、hips 缩放口径 bug，并把砂金 VRM 的腿部 humanoid 映射/层级修成 legfix 版（`assets/vrm/aventurine-waveflair-legfix.vrm`）。最终交付 **29 个宠物专属 clip**（8/8 类覆盖：待机 7 / 走路 2 / 坐窗沿 7 / 互动 4 / 睡觉 1 / 躲藏 2 / 入场 3 / pose 3），`assets/motions/mate/**` + manifest（canonical/mirror）；数据校验 29 PASS/0 WARN/0 FAIL，三份验收清单与对拍结论见 **`docs/wave15-report.md`**。W1.5-Tpose 已修：PMX 源经 VRMify 重转为规范 T-pose VRM 1.0（`assets/vrm/aventurine-tpose.vrm`，manifest 目标），clip 数据按标准 VRM1 朝向用 `--axis x` 重烘焙；Unity GT 同模型 ΔW 102°→3.44°，详见 `docs/vrm-tpose-repair.md`。U0 唯一用户侧步骤（装 Unity + 激活）已完成；授权有效期至 2026-11-18。**2026-11-08 追加手指补全**：查清 Mate-Engine 源 `.anim` 有 40 条手指 muscle 曲线但 U2 只采了 22 骨，已用 Unity+UniVRM 真实 VRM avatar 探针补回 30 根手指（每 clip 52 骨），Unity GT/视觉/参考视频验证通过，见 `docs/wave15-fingers-report.md`。

### Wave 3 — 收口 ✅ 完成（2026-11-11，含 DSH 双向集成扩展）

> 验收矩阵 / 激活与回滚步骤：[docs/wave3-acceptance.md](docs/wave3-acceptance.md)；
> 实施设计（冻结契约 v2）：[docs/wave3-dsh-integration-design.md](docs/wave3-dsh-integration-design.md)。

| ID | 任务 | 依赖 | 状态 | 说明 |
|---|---|---|---|---|
| V9 | 清理/性能/打包 | V8 | ✅ 已实现（ad-hoc 签名 dir 包） | electron-builder `--mac dir` 骨架 + afterPack **ad-hoc 签名**（macOS 27 AMFI 必需）+ extraResources + entitlements 占位 + `scripts/package-check.mjs` + 性能测量脚本；产物 `dist/mac-arm64/AventurinePet.app`（601 MB，ad-hoc 签名，仅本机自用，09:50 重建版已用于真机激活）；Developer ID/公证仍缺（本机 0 证书）；legacy 保留（D9）。详见 [wave3-packaging-report](docs/wave3-packaging-report-2026-11-11.md)、[packaging.md](docs/packaging.md) |
| V10 | 并入 Wave 1.5 烘焙结果（如执行） | U3、V8 | ✅ 数据接线完成 + 文档收口；⏳ 用户实机勾选 | 运行时 `app-manifest` **40 clips** / `catalog` **181**（mate 30 / hsr 14 / adv 137），`build-app-manifest --check` PASS；本 Wave 只做收口验收（数据接线在 Wave 2 已完成）；动作观感待用户按 §10 勾选 |

### DSH 双向集成（Wave 3+，2026-11-11）

> 用户 2026-11-11 拍板：**① 强耦合（一方显式退出另一方跟着退）② 只认桌面版 `DeepSeek Harness.app`
> （bundle id `com.deepseek.dsh`）③ 气泡按「每段输出」同步 ④ 扩展桥装进 desktop profile、不重启 DSH（HMR）**。
> 实施设计（冻结契约 v2）：[docs/wave3-dsh-integration-design.md](docs/wave3-dsh-integration-design.md)；
> 验收矩阵：[docs/wave3-acceptance.md](docs/wave3-acceptance.md)。

| 能力 | 实现要点 | 关键决策 | 状态 |
|---|---|---|---|
| 状态反应 | 现有 `ExternalReaction` 映射（busy/done/error）链路；桥真正安装后由 DSH 事件驱动 | 不新增事件类型；复用 `session/event` | ✅ 自动化；⏳ 实机 |
| 气泡同步 | renderer 纯逻辑 `DshDialogue`（`思考中...` → 96 字切块 → 停留 → 下一段；队列 8 / 单 turn 4000 字预算 / 去重）；Lead 在 `main.ts` 仲裁（`ownsBubble` 优先于行为层台词） | 不逐 token；每段输出；不改 `bubble.ts` 语义 | ✅ 自动化；⏳ 实机 |
| 强耦合（互保活） | `dsh-process`（lsappinfo/pgrep、`open -b`、SIGTERM→SIGKILL）+ `dsh-lifecycle` 状态机（60s 冷却 / 3 次 90s / 崩溃重启 ≤2 次 / detached 1.5s grace / 防互杀环） | 用户选择强耦合；**detached + 进程消失 → 跟随退出、不重启；无 detached 的进程消失 → 重启 ≤2 次再跟随退出**；dev 须 `PET_DSH_COUPLING=1` | ✅ 自动化；⏳ 实机 |
| 桥 v2 | assistant 文本 `payload.text`（8000 上限 + 隐私白名单）+ `control.json`（attached/detached）+ `launchPet`；canary 含本地 mock 成功回合 | 加法式契约；只写 assistant 输出，不写 user/reasoning/tool 正文 | ✅ canary PASS |
| 窥屏接口预留 | `src/shared/peek.ts` + `src/main/peek/**`；默认关闭 / fail-closed / stub 恒不可用；未接线、零 TCC | 本轮只落接口；设置页不显示 | ✅ |
| 激活方式 | desktop profile 追加桥 insert 行 → HMR dispose/apply（无需重启 DSH）；`scripts/activate-dsh-bridge.mjs` 自动生成 `work/live-bridge/<rev>` 新路径副本（规避 HMR 同路径 ESM 缓存）+ 备份 + YAML 校验 + 回滚；激活后核对 `control.json.bridgeVersion` | 用户已同意 HMR 激活；升级 = 回滚 + 重新激活（新 rev）；回滚 = 恢复备份 | ✅ 已激活（2026-11-11 12:33，bridgeVersion=3/dshPid=18937；桌宠 direct-exec 拉起并进入 PAIRED） |

> **历史备注（2026-11-08 深夜追加，Wave 1 剩余项 · 表情层）**：Wave 1 剩余项的**表情层**已完成（用户要求的「wave 1.0 hsr 动作包剩余部分
> = Emo_ 表情」+「wave 1.5 mate engine 表情对应」）：`assets/expressions/{mate,hsr}/**` 17 条表情 clip
> （VRM1 preset 权重）+ `scripts/vrm/expression/**` 管线 + `src/renderer/src/vrm/expressions.ts` 运行时纯模块
> + `src/shared/expression-contract.ts` 加法式契约 + three-vrm 预览证据 + 6 个测试文件；校验
> 17 PASS/0 WARN/0 FAIL。**仍未做**：V6 实机接线（等 V1/V5）、custom expression 增强（照れ/目影/やっかい 等）、
> `petTalking` 之外的语音口型细节。详见 `docs/expression-mapping.md` 与
> `docs/expression-mapping.md` §9（V6 接线清单）。

---

## 6. 并行执行矩阵（开窗口建议）

| Wave | 窗口数 | 任务 |
|---|---|---|
| 0 | 1 | W0-1（先做）→ 完成后 W0-2/W0-3/W0-4 可同窗口或 3 窗口并行 |
| 1 | **4** | V1、V2、V3、V4 |
| 1.5（可选） | 1–2 | U0 → U1（可与 Wave 1 同时）；U2/U3 等 V2 后 |
| 2 | **4** | V5、V6、V7、V8 |
| 3 | 1–2 | V9；V10；DSH 双向集成（Wave 3+，2026-11-11 完成） |

Worktree：
```bash
cd /Volumes/4TB外置盘/deepseek-harness/aventurine-pet-vrm
git worktree add ../wt-v1 -b feat/v1-three-vrm
# 新窗口打开 ../wt-v1，读本 PLAN 的 V1 行
```

---

## 7. 文件所有权（防冲突）

| 文件/目录 | Owner |
|---|---|
| `package.json`、`pnpm-lock.yaml`、`README.md` | W0-1 / Lead |
| `src/shared/vrm.ts`、`animation-contract.ts` | W0-3（冻结后禁止擅改） |
| `src/renderer/src/vrm/**`（loader/scene/expressions） | V1 / V6 |
| `src/renderer/src/vrm/clip-player.ts`、`assets/motions/**` manifest | V3 / V5 |
| `src/renderer/src/animation/**`（legacy/适配器） | V4（V5 只接线不改 legacy） |
| `scripts/vrm/**` | V2 / V3（分文件：`convert/` vs `motion/`） |
| `src/main/**`、`native/**`、`bridge/**`、`preload/**` | 默认不动；需要改由 Lead 批准 |
| `behavior/**`、`physics/**`、`desktop/**`、`interaction/**`、`settings/**` | V7（只改骨骼/高度引用） |
| `docs/**`、`tests/**` | 各任务保留自己新增；公共文档 Lead |

---

## 8. 接口契约（W0-3 冻结）

`src/shared/vrm.ts`（示意）：
```ts
export type HumanoidBone = 'hips'|'spine'|'chest'|'upperChest'|'neck'|'head'
  |'leftShoulder'|'leftUpperArm'|'leftLowerArm'|'leftHand'
  |'rightShoulder'|'rightUpperArm'|'rightLowerArm'|'rightHand'
  |'leftUpperLeg'|'leftLowerLeg'|'leftFoot'|'leftToes'
  |'rightUpperLeg'|'rightLowerLeg'|'rightFoot'|'rightToes'

export interface VrmAvatarAsset {
  id: 'aventurine-waveflair' | 'canary-outfit'
  file: string            // pet-asset://… 或 resources 相对路径
  humanoid?: Partial<Record<HumanoidBone, string>>  // 标准名不需写
  heightMeters: number
  expressions: Partial<Record<'blink'|'happy'|'sad'|'angry'|'relaxed'|'surprised'|'lookAtX'|'lookAtY', string>>
  springChains?: number
}

export type AnimationBackend = 'vrm' | 'legacy-pmx'

export interface AnimationClipEntry {
  mood: string            // PetMood 子集/idle/walk/sit/pat/drag/salute/sleep/…
  file: string            // assets/motions/…glb|vrma
  loop: boolean
  timeScale?: number
  fadeInSec?: number
  fadeOutSec?: number
  rootMotion?: 'inPlace'
}
```

- `assets-manifest` 扩展 `vrm` 与 `motions` 条目。
- `config` 新增：`modelBackend`、`animBackend`、`motionSet`（default）。
- `pet-asset://` 支持 `.vrm`、`.glb`、`.vrma`。

---

## 9. canary 验证计划（先于戏浪转换）

- 资产：`assets/vrm/canary/砂金石心十人公司制服(0.x).vrm`（VRM 0.x，51 humanoid 骨，13 贴图、31 材质全贴图）。
- 步骤：
  1. `scripts/vrm/canary-viewer.html` 用 three-vrm 加载，正交/透视各一，截图三视图；
  2. 用一个 glTF/VRMA idle+walk clip（V3 产出前可先用临时 Mixamo 素材）播放，确认 humanoid 重定向正确；
  3. 录 10 秒屏，检查 MToon、透明背景、骨骼动画。
- 成功标准：加载无错、贴图正确、humanoid 动作无明显反关节/滑步；**观感先过用户眼**，再投入 V2 转换。

---

## 10. 验收清单（实机观感，用户勾选）

- [ ] 待机：自然呼吸/重心转移，不木偶
- [ ] 走路：手臂反相、脚掌落地、不滑步、不反膝关节、面朝运动方向
- [ ] 坐（含窗沿）：坐下自然、腿在窗沿外、不穿窗
- [ ] 摸头：圆形轨迹触发反应，动作顺滑
- [ ] 拖拽/甩出：被抓住/甩出的反应自然，落地正常
- [ ] 注视：头/眼跟随鼠标，不僵
- [ ] 材质：MToon 观感贴近参考；发/衣 spring 有微动，无大面积穿模
- [ ] 表情：眨眼/笑/害羞可触发，不崩脸
- [ ] 桌面交互回归：窗口探测/点击穿透/坐窗/爬窗/DSH 联动不退化
- [ ] 性能：1080p 下 CPU/GPU/内存可接受（记 VS v1）

---

## 11. 风险与缓解

| 风险 | 缓解 |
|---|---|
| PMX→VRM 材质转换观感差（39 材质） | V2 先用 MMD 原贴图 + MToon 近似；允许 app 侧 override 材质；Blender 四视图对比 |
| 表情/材质 morph 丢失（85 morph） | 优先映射常用表情；材质 morph（照れ/目影）用 VRM expression + 材质 override 重做 |
| 骨骼 mapping 出错（382 骨含 IK/辅助骨） | 先映射标准 humanoid 骨，其余忽略/作为 spring 链；用 canary 与 Blender 渲染对比验证 |
| Mixamo 素材授权/账号 | 用公开 FBX 源 + Mixamo（Adobe 免费账号）；产出 glTF 仅本地用 |
| 动画 clip 与行为状态机不匹配 | 保留 `PetMood` 契约；clip manifest 缺失回退 legacy/程序化 |
| 工作量比预期大 | canary 先行，V2/V3/V1 并行；每阶段可停 |

---

## 12. 资产/参考项目来源与授权

- 戏浪 PMX：模之屋（流云景/Lily0725，版权 miHoYo；**禁止二次配布/商用**；本地改造允许）。
- canary VRM（制服款）：用户下载，同样禁止再分发。
- Mate-Engine 参考：shinyflvre/Mate-Engine，MateEngine Pro License v2.1（私有修改允许；衍生需同许可公开源码；素材不得单独再分发）；**只作参考/未来烘焙，不复制进 app**。
- reze-rig：MIT，仅历史路线参考。
- dsh-blender-plugin、Blender/MMD Tools、VRM Add-on：各自许可证，仅本地工具链。
- Mixamo 动作：Adobe 授权，产出仅本地个人使用。

---

## 13. 给并行 Agent 的通用规则

1. 只改自己任务 Scope 内文件；`src/shared/**`、`package.json`、`src/main/index.ts` 为集成文件，改动先经 Lead。
2. 完成必须 `pnpm typecheck` + 相关测试；提交信息 `feat(V1): …`。
3. **不得提交** `assets/**`（除 icons）、`refs/**`；提交前 `git status` 复查。
4. 旧 v1 工作区只读；不删、不改。
5. 遇到契约变更先在任务描述里标注，由 Lead 统一合并。

---

## 14. 开工顺序

1. 窗口 1：W0-1（依赖 + 基线提交）→ 再 W0-2 / W0-3 / W0-4（可同窗口）。
2. 并行 4 窗口：V1 / V2 / V3 / V4。
2.5 （可选，不占 V1–V4 write scope）另开 1 窗口：U0（你装 Unity）→ U1（导出脚本 + 3 个试烧）；U2/U3 等 V2 完成后再做。
3. 并行 4 窗口：V5 / V6 / V7 / V8。
4. 收口：V9 + V10 文档收口 + DSH 双向集成（2026-11-11）。

---

## 15. 2026-11-11 完成记录（Wave 3 + DSH 集成）

- [x] T0 契约 v2（`bridge-schema` / `types` / `config` + 契约测试）
- [x] A1 桥插件 v2（assistant 文本 / `control.json` / `launchPet` / canary / README）
- [x] A2 气泡状态机（`dsh-dialogue` 纯逻辑 + 单测）
- [x] A3 强耦合生命周期（`dsh-process` / `dsh-lifecycle` / `dsh-watch` / `ipc-dsh` + 单测）
- [x] A4 设置页（双向保活 + 气泡同步开关 + 状态文案）
- [x] A5 V9 打包（electron-builder dir + package-check + 文档）
- [x] A6 V9 性能基线（`docs/wave3-perf-baseline-2026-11-11.md` 已产出：idle fps 28.1–28.3@cap30、drawCalls 39、RSS 964–993 MB、CPU 14.7%、启动 ready 0.78–0.80 s）
- [x] A7 窥屏接口预留（`peek.ts` + `main/peek` + 单测 + `docs/peek-interface.md`）
- [x] T1 Lead 接线（renderer 气泡仲裁 / main `before-quit` 强耦合 / 配置热更）
- [x] 真实 desktop profile HMR 激活 + 实机验证（**2026-11-11 12:33 成功**：control attached/bridgeVersion=3/dshPid=18937；
      桌宠 direct-exec 拉起并进入 `PAIRED（startup-detected）`；用户确认屏幕可见；DSH 未重启）—— 证据 `docs/wave3-acceptance.md` §2.3
- [x] 全量测试 + typecheck + canary PASS（**129 files / 2419 passed + 11 skipped**，2026-11-11 最终）
- [ ] 用户实机观感勾选（气泡逐段/状态反应/V10 动作六项，见 `docs/wave3-acceptance.md` §4）
- [ ] Lead 统一提交（当前 HEAD `3893943` + 工作树未提交改动）

> 报告链接：[docs/wave3-acceptance.md](docs/wave3-acceptance.md)、[docs/wave3-packaging-report-2026-11-11.md](docs/wave3-packaging-report-2026-11-11.md)、[docs/wave3-e2e-report-2026-11-11.md](docs/wave3-e2e-report-2026-11-11.md)、[docs/wave3-perf-baseline-2026-11-11.md](docs/wave3-perf-baseline-2026-11-11.md)、[docs/wave3-hmr-activation-verification-2026-11-11.md](docs/wave3-hmr-activation-verification-2026-11-11.md)、[docs/peek-interface.md](docs/peek-interface.md)、调研报告 `docs/research/*-2026-11-11.md`。
> 动作口径备忘：Wave 1.5 报告写 29 条 mate clip，实际当前 **30 条**（2026-11-09 男性适配 step2 增加 `dragFemale`）；运行时 app 清单 40 条。
