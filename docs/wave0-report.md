# Phase 3 · Wave 0 完成报告（W0-1 ~ W0-4）

> 工作区：`/Volumes/4TB外置盘/deepseek-harness/aventurine-pet-vrm`
> 日期：2026-11-08 · 状态：**Wave 0 完成，可进入 Wave 1（V1–V4 四条泳道）**
> 依据：`PLAN.md` §5 Wave 0 / §8 接口契约 / §9 canary 验证计划
> 交付提交：`d44fddb`（W0-1）· `80b049d`（W0-3）· `df85770`（W0-2）· W0-4 与文档见同 Wave 收口提交
> 证据目录（gitignore，不提交）：`tests/tmp/w0-2/`、`tests/tmp/w0-4/`

## 0. 一页结论

| 任务 | 结论 | 关键交付物 / 证据 |
|---|---|---|
| **W0-1** 依赖与基线自检 | ✅ | `@pixiv/three-vrm@3.5.5`、`@pixiv/three-vrm-animation@3.5.5`（devDeps，与 three 0.171.0 同层）；`.gitignore` 私有资产兜底；`pnpm typecheck` / `pnpm test` / `pnpm build` 全绿 |
| **W0-2** Blender VRM 工具链 | ✅ | VRM Add-on for Blender **v4.10.4**（extension，pin sha256）+ 幂等安装脚本 + 无头 dummy VRM 1.0 导出/自校验（15 骨、`specVersion=1.0`）；`docs/vrm-toolchain.md` |
| **W0-3** 冻结 VRM 契约 | ✅ | `src/shared/vrm.ts`、`animation-contract.ts`、`vrm-manifest.json`、`motion-manifest.json`；`PetConfig` 新增 `modelBackend/animBackend/motionSet`；新契约测试 86 条；`docs/vrm-contract.md` |
| **W0-4** canary 查看器 | ✅ | 一条命令 `node scripts/vrm/screenshot.mjs`：两模型各 3 视图 + 10s 录屏（VP9/600 帧）+ 骨骼动画/表情定量验证 + 像素自检；`ALL CHECKS PASSED`；`tests/tmp/w0-4/report.md` |
| **回归** | **0 个** | 基线 59 文件 / 1086 通过 → 收口 61 文件 / 1144 通过 / 14 skip；**无需回退或打补丁**（见 §5） |

**用户新增资产已接入 W0 验证**：`assets/vrm/星穹铁道—砂金·戏浪(1.0).vrm`（模之屋转好的 VRM 1.0）已解压入库
（`assets/vrm/`，gitignore），W0-4 与 canary 同链路验证通过；其朝向/材质缺陷已写入 manifest 与交接清单（§4.3）。

## 1. W0-1：依赖与基线自检

- `pnpm install --frozen-lockfile`：102 包，全部命中本机 store；`pnpm install` 可复现。
- 新增依赖（`devDependencies`，沿用 v1 把 three 放 devDeps 的约定：renderer 由 electron-vite 打包）：

  | 包 | 版本 | 作用 |
  |---|---|---|
  | `@pixiv/three-vrm` | 3.5.5 | VRM 1.0/0.x 加载、MToon、humanoid、expression、spring bone |
  | `@pixiv/three-vrm-animation` | 3.5.5 | VRMA / glTF humanoid clip（V3 起使用） |

  Node ESM 冒烟：`three-vrm` 暴露 53 个导出（含 `VRMLoaderPlugin`/`VRMUtils`/`MToonMaterialLoaderPlugin`），
  `three-vrm-animation` 暴露 `VRMAnimationLoaderPlugin`/`createVRMAnimationClip` 等，peer `three>=0.137` 与 0.171 兼容。
- `.gitignore` 增加 `assets/*.zip`、`assets/*.vrm`、`assets/*.glb`、`assets/*.vrma`（assets 根兜底）与
  `__pycache__/`、`*.pyc`；`git check-ignore` 验证用户新 VRM/zip 全部被忽略。
- `README.md` 更新环境/依赖/命令与 Wave 0 指引。
- 验证：`pnpm typecheck` ✅、`pnpm test` ✅（基线）、`pnpm build` ✅（main/preload/renderer 三端打包）。
- 私有资产处理：用户 2026-11-08 提供的 `星穹铁道—砂金·戏浪(1.0) (1).zip` 解压为
  `assets/vrm/星穹铁道—砂金·戏浪(1.0).vrm`，zip 移入 `assets/vrm/`（二者均 gitignore）；未提交任何模型二进制。

## 2. W0-2：Blender VRM 工具链（委派 vrm-toolchain）

- **VRM Add-on for Blender（“VRM format”）v4.10.4**：官方 `saturday06/VRM-Addon-for-Blender` release
  （2026-11-04），sha256 `a711da72…42f5b`，与 extensions.blender.org 官方 registry 同版本 zip 交叉核对为同一文件。
  Blender 4.2 用 **extension** 方式安装（`--command extension install-file -r user_default -e`），
  module `bl_ext.user_default.vrm`，无头 `--factory-startup` 下 `addon_enable` 可用（`export_scene.vrm`/`import_scene.vrm` 存在）。
- 交付：`scripts/vrm/install-vrm-addon.sh`（幂等、pin 版本+sha256、下载缓存 `~/Library/Caches/aventurine-vrm-tools/`、
  legacy addon fallback、无 sudo/Homebrew）、`scripts/vrm/export-dummy-vrm.py`（cube+15 骨 → VRM 1.0 + 内嵌 GLB 校验，
  失败退出码 1）、`docs/vrm-toolchain.md`（版本表/复跑命令/11 条已知坑/资产元数据/V2 无头转换骨架）。
- 证据：`tests/tmp/w0-2/`（install run1/run2 幂等日志、export log、`dummy.vrm` 8,740 B、
  `dummy-vrm-check.json`：magic=glTF、`VRMC_vrm`、`specVersion=1.0`、humanBones=15、skins=1；Node 独立复验通过）。
- 关键工具链结论（供 V2）：Blender 4.2 必须用 extension 资产；VRM 1.0 由 armature `spec_version` 决定；
  addon 内含 MMD 日文骨名词典与 `bpy.ops.vrm.assign_vrm1_expressions_from_mmd`、`make_estimated_humanoid_t_pose` 可复用；
  MMD 物理 → VRM spring 无直接转换器（V2 主要工作量之一）。

## 3. W0-3：冻结 VRM 契约（Lead）

- 新增 `src/shared/vrm.ts`：`HUMANOID_BONES`（VRM 1.0 标准 55 骨）、`VRM_REQUIRED_HUMANOID_BONES`（15）、
  `VRM_EXPRESSION_PRESETS`（18）/`PET_EXPRESSIONS`（9）、`VrmAvatarAsset`/`VrmAssetManifest` + 清洗
  `sanitizeVrmAssetManifest`（永不抛）、`resolveAvatarAsset`、`isSafeAssetReference`、
  `VrmAvatarCapabilities`、`resolveModelBackend`（env > config > vrm）。
- 新增 `src/shared/animation-contract.ts`：槽位 = `PetMood` 全集 + `salute`；`AnimationClipEntry`/
  `AnimationClipManifest` + `sanitizeAnimationClipManifest`；`findAnimationClip`（priority 高者优先）；
  `resolveAnimationBackend`；默认参数 loop=true / timeScale=1 / fade 0.15,0.2 / priority=0。
- 配置扩展：`PetConfig` 新增 `modelBackend`/`animBackend`/`motionSet`（默认 `vrm`/`vrm`/`default`），
  `sanitizeConfig` 做枚举/字符集校验（`motionSet` 拒绝路径穿越、`.` 开头、超长）；
  **`CONFIG_VERSION` 保持 1**（追加字段缺省可回填，旧 config.json 自动兼容）。
- 数据：`vrm-manifest.json`（canary + 戏浪两条，canary 为默认；`defaultAvatarId` 由 V5 切戏浪）、
  `motion-manifest.json`（空集 = 全回退 legacy/程序化，V3 填充）。
- 有意偏差（详见 `docs/vrm-contract.md` §1）：不改 PMX 生成物 `assets-manifest.json`（schema 冻结测试零回归），
  VRM/motions 用独立 manifest；`lookAt` 从 expressions 拆出；新增 `yawOffsetDeg`/`thumbnail`/`notes`/capabilities。
- 测试：新增 `tests/vrm-contract.test.ts`（34）、`tests/animation-contract.test.ts`（20），更新 `tests/shared-contract.test.ts`
  （32，含 W0-3 新配置项）；覆盖环境中立 import 白名单、清洗/钳制/去重/默认值、脏输入 fuzz、提交 manifest 零 warning、
  真实私有资产存在性（资产生成时校验）。
- 冻结声明与消费方指引（V1/V2/V3/V4/V5/V6 各自该做什么）：`docs/vrm-contract.md`。

## 4. W0-4：canary 查看器与实机证据（委派 canary-viewer）

### 4.1 一条命令复跑

```bash
cd /Volumes/4TB外置盘/deepseek-harness/aventurine-pet-vrm
node scripts/vrm/screenshot.mjs                 # canary + 戏浪：3 视图 + force-opaque 对比 + motion pair + 10s 录屏 + 诊断 + 像素自检
node scripts/vrm/screenshot.mjs --record=none   # 快速冒烟（不录屏）
node scripts/vrm/screenshot.mjs --only=canary   # 只跑 canary
```

Lead 已独立复跑：`ALL CHECKS PASSED`，退出码 0（Electron 44.10.2 / Chromium 152 / WebGL2 / ANGLE Metal，硬件 GPU）。
交付脚本：`scripts/vrm/{canary-viewer.html,canary-viewer.js,serve-evidence.mjs,electron-capture.mjs,screenshot.mjs}`
（dev-only：importmap + 本地静态 server，未纳入 electron-vite 构建；私有 VRM 原地只读）。

### 4.2 实测结论（`tests/tmp/w0-4/report.md` 全文）

| 项 | canary VRM 0.x | 戏浪 VRM 1.0 |
|---|---|---|
| 加载 | ✅ 110 ms，0 pageerror / 0 console error / 0 网络失败 | ✅ 149 ms，同上（含 1 处内存 pre-parse patch） |
| humanoid | 51 骨，15 必需骨 0 缺失 | 52 骨，0 缺失 |
| MToon / 贴图 | 31 材质全 MToon、13 内嵌贴图全解码 | 39 glTF MToon（viewer 78 含 outline clone）、20 内嵌贴图全解码 |
| 高度 bbox | **1.7586 m** | **1.7345 m** |
| 朝向 | `rotateVRM0` 后 **+Z**（正脸在 +Z 相机下） | **−Z**（+Z 相机看到后脑）→ manifest `yawOffsetDeg:180` |
| spring | 无（`secondaryAnimation` 空） | 无（无 `VRMC_vrm.springBone`） |
| lookAt | **有**（VRM0 `firstPerson.lookAtTypeName="Bone"` → `VRMLookAtBoneApplier`）；VRM0 LookAtDegreeMap 曲线 three-vrm 不支持（忽略，用默认角度） | 无（`VRMC_vrm.lookAt` 缺失）→ procedural |
| 表情 | 13 个注册名（12 标准 + 大写 `Surprised` 大小写变体）；VRM0 `joy→happy`、`blink_l/r→blinkLeft/Right`、`a/i/u/e/o→aa/ih/ou/ee/oh` **逐项实测成立**；7 个业务映射全部有效 | 12 个标准 preset；7 个业务映射全部有效；无 sad/relaxed |
| 骨骼动画 | AnimationMixer 8s 循环（10 tracks/9 骨）；motion pair max bone Δ **12.93°**（head），画面变化 11.6% | 11 tracks/10 骨；max Δ **13.05°**（head），画面变化 10.9% |
| 表情运行时 | blink 4 周期 peak 0.997、happy 2 次 peak 0.9996 | blink 4 周期 peak 0.998、happy 2 次 peak 0.9997 |
| 截图 | 720×960 RGBA 透明底；front 非透明像素 19.6%、非透明区亮度 121 | 同尺寸；front 非透明 15.9%、非透明区亮度 211 |

- 录屏：`canary/recording.webm` **3,603,166 B / 10,001 ms / 600 帧 60fps VP9**；
  `aventurine/recording.webm` **3,650,462 B / 10,002 ms / 600 帧**（EBML 头 + 页内 `performance.now()` 双证）。
  录屏时临时切深色 studio 背景保证 webm 可读，截图保持透明背景。
- 证据：`tests/tmp/w0-4/{canary,aventurine}/{front,side,back}.png`、`front-force-opaque.png`、`motion-a/b.png`、
  `recording.webm`、`diagnostics.json`、`console.log`、`pixel-check.json` + `run-summary.json` + `report.md`。

### 4.3 对 Wave 1/2 的关键交接（已写进 `docs/vrm-contract.md` §5 / 各 manifest notes）

1. **V1 loader 必须内置「非法 texture 引用」pre-parse patch**：戏浪 `珍珠` 材质
   `VRMC_materials_mtoon.shadeMultiplyTexture = {}`（无 texture index）会让 `GLTFLoader.parse` 抛 TypeError 导致整模型加载失败；
   W0-4 viewer 已实现内存 patch（不写盘），V1 需同样防御（或 V2 重导修数据）。
2. **V1 必须应用 `yawOffsetDeg`**（戏浪 180°）与 `lookAt.mode='vrm'`（canary 用 three-vrm lookAt；戏浪 procedural）。
3. **戏浪材质「发白」根因已量化**：29/39 材质误标 BLEND（27 个 α≈1）+ 全部 doubleSided + `transparentWithZWrite:true`
   → 透明 pass/outline 叠加产生局部 ghost；但 `?forceOpaque=1` 实测仅改变 3.75% 像素、平均亮度不变 →
   **发白主因是资产贴图色调 + 光照**（同光源 canary 亮度 121 vs 戏浪 211）。V2 重导把 α≈1 材质设 OPAQUE 可消局部瑕疵，
   整体观感调优归 V6（材质/光照/tone mapping）。
4. `defaultAvatarId` 保持 canary；V5 接入戏浪后改为 `aventurine-waveflair`（数据改动，不改契约）。
5. `blinkLeft/blinkRight` 骨骼/表情名、finger 骨（canary 无 `thumbMetacarpal`、戏浪无 toes）差异已在 diagnostics 留档；
   V7 的摸头命中 head 骨、V6 的表情驱动可直接消费。

## 5. 测试、回归与处理决策

| 阶段 | 命令 | 结果 |
|---|---|---|
| 基线（改动前） | `pnpm typecheck` / `pnpm test` | ✅ / **59 文件 / 1086 passed / 14 skipped** |
| W0-1 后 | `pnpm typecheck` / `pnpm test` / `pnpm build` | ✅ / ✅ / ✅ |
| W0-3 后 | `pnpm typecheck` / `pnpm test` | ✅ / **61 文件 / 1144 passed / 14 skipped**（新增契约测试，PMX 冻结测试零回归） |
| 收口（本次） | `pnpm typecheck` / `pnpm test` / `pnpm build` / `node scripts/vrm/screenshot.mjs` | ✅ / ✅ / ✅ / ✅ `ALL CHECKS PASSED` |

**回归评估（按用户要求）**：Wave 0 全程**没有出现回归**，因此不存在「回退拆小步骤重做 vs 打补丁」的取舍。
若出现回归，本次采用的判据是：
1. **契约级改动（src/shared、config、manifest schema）** → 优先回退/拆小步，因为冻结契约会影响 4 个并行泳道；
2. **数据级改动（manifest 数据、docs、私有资产）** → 在现有实现上打补丁即可，不动契约；
3. **legacy 路径（PMX/VMD）** → 任何测试失败先回退到「legacy 默认 + VRM 可选」，保证 v1 可用性不被 Wave 1 阻塞。
本次 W0-3 的 `assets-manifest.json` 冲突正是按此判据处理的：**不扩冻结的 PMX 生成物 schema**，VRM/motions 另立
manifest（契约评审记录在 `docs/vrm-contract.md` §1），从而零回归进入 Wave 1。

## 6. 复跑清单

```bash
cd /Volumes/4TB外置盘/deepseek-harness/aventurine-pet-vrm
pnpm install
pnpm typecheck && pnpm test && pnpm build        # 代码/契约
bash scripts/vrm/install-vrm-addon.sh             # W0-2 工具链（幂等）
node scripts/vrm/screenshot.mjs                   # W0-4 canary/戏浪 渲染证据（需私有 assets/vrm）
npx vitest run tests/vrm-contract.test.ts tests/animation-contract.test.ts tests/shared-contract.test.ts
```

## 7. 遗留 / 风险（不阻塞 Wave 1）

1. `assets/**` 私有资产不进 git，新 clone/CI 只能跑契约单测与跳过私有资产集成用例（已有 `skipIf` 先例）；
   W0-4 viewer 是 dev-only，需要本机私有 VRM 才能复跑。
2. 表情 `sad/relaxed` 两个现有资产都不存在；V6 决定是否 Blender 补 blended expression。
3. spring/lookAt 补全、戏浪材质重导/覆盖、`珍珠` 数据修复：分别归 V2/V6/V1（见 §4.3）。
4. W0-4 的程序化 idle 仅为通路验证占位，真实动作观感由 V3 资产管线 + V8 实机验收负责。
5. `test/tmp/**` 证据不提交；如需长期留档由 V8/V9 决定是否复制关键帧到 `docs/`（需评估私有资产红线）。

## 8. W0-5 收口小修（2026-11-08 追加，用户要求）

针对 W0-4 暴露的戏浪资产数据缺陷 + V1 的前置防御，做了三项小修（只动 dev 工具/私有资产副本/共享纯函数，
不改 W0-3 冻结契约语义）：

| # | 问题 | 修复 | 交付 |
|---|---|---|---|
| 1 | `珍珠` 材质的 `VRMC_materials_mtoon.shadeMultiplyTexture = {}`（无 texture index）→ three-vrm 加载抛 TypeError、整模失败 | 新增 `scripts/vrm/patch-vrm-gltf.mjs`：只改 glTF JSON chunk、BIN 原样，生成修复副本 `assets/vrm/aventurine-waveflair.vrm`（原始文件只读保留）；`vrm-manifest.json` 改指向修复副本 | 脚本 + 修复资产（gitignore）+ 修复报告 `tests/tmp/w0-5/patch-report.json` |
| 2 | 27 个「α≈1 但 `alphaMode=BLEND`」的 MToon 材质 → 透明 pass + outline clone 叠加产生局部 ghost | 同一脚本 `--force-opaque-alpha1`：这批材质改 OPAQUE；真正半透明 overlay（颜赤 α=0、目影 α=0.3）保留。结果 39 = **37 OPAQUE + 2 BLEND** | 与 #1 同一次生成 |
| 3 | pre-parse patch 之前只存在 viewer（JS）里，V1 无法复用 | 新增纯函数模块 `src/shared/vrm-glb.ts`（`patchVrmGltfJson` / `patchVrmGlbBuffer`，环境中立、无依赖）+ `tests/vrm-glb.test.ts`（非法引用/越界/幂等/GLB 封装/BIN 逐字节不变/真实资产 skipIf 共 10 条） | 共享模块 + 测试；`docs/vrm-contract.md` §5 指引 V1 loader 调用 |

**验证（`tests/tmp/w0-5/`）**：

- 修复报告：before = 39 材质（29 BLEND / 10 OPAQUE）、invalid texture refs **1**；after = **37 OPAQUE / 2 BLEND**、
  invalid texture refs **0**；6 项自校验全过（含「其余 chunk 与原始逐字节一致」）。
- three-vrm 实测（复用 W0-4 viewer + electron-capture，`tests/tmp/w0-5/verify-patched.mjs`）：修复副本直接加载
  **0 pre-parse patch**、`specVersion=1.0`、52 骨、39 材质、12 表情、**0 pageerror / 0 console error / 0 网络失败**；
  forceOpaque 调试统计 `changed=0 / keptTransparent=4`（说明 alphaMode 修复已生效）。
- 修复后 GLB 25,368,436 B（比原始 25,910,532 B 小 ~0.54MB，来自 JSON 紧凑重序列化；BIN chunk 未变）。
- 注意：W0-4 结论不变 —— alphaMode 修复只消除局部 ghost（~3.7% 像素），**整体发白仍是贴图/光照问题**，归 V6 调优。

**复跑**：

```bash
node scripts/vrm/patch-vrm-gltf.mjs "assets/vrm/星穹铁道—砂金·戏浪(1.0).vrm" \
  -o "assets/vrm/aventurine-waveflair.vrm" --force-opaque-alpha1
node tests/tmp/w0-5/verify-patched.mjs   # 需先有 W0-4 脚本与私有资产；dev-only
npx vitest run tests/vrm-glb.test.ts tests/vrm-contract.test.ts
```
