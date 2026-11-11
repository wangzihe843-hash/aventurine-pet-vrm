# 砂金·戏浪 全局桌宠（Phase 3 · VRM 工作区）

macOS 透明悬浮桌宠。Phase 3 从 v1（PMX/VMD 路线）迁移到 **VRM + three-vrm**：
模型用 Blender 本地转换（私有、不分发），动作走 humanoid 标准管线（Mixamo/FBX → Blender 重定向 → glTF/VRMA），
窗口层/行为/物理/桌面感知/交互/DSH 桥全部复用 v1 实现。

- 实施计划：**[PLAN.md](PLAN.md)**（Wave 0–3 已完成，2026-11-11）
- **Wave 3 验收矩阵 / DSH 集成激活与回滚：[docs/wave3-acceptance.md](docs/wave3-acceptance.md)**
- Wave 3 + DSH 双向集成实施设计（冻结契约 v2）：**[docs/wave3-dsh-integration-design.md](docs/wave3-dsh-integration-design.md)**
- V9 打包交付报告：**[docs/wave3-packaging-report-2026-11-11.md](docs/wave3-packaging-report-2026-11-11.md)**
- HMR 激活验证 / live 副本 / 拉起 env 修复：**[docs/wave3-hmr-activation-verification-2026-11-11.md](docs/wave3-hmr-activation-verification-2026-11-11.md)**
- 独立隔离 E2E 验证（桥/气泡/强耦合/打包版/smoke）：**[docs/wave3-e2e-report-2026-11-11.md](docs/wave3-e2e-report-2026-11-11.md)**
- V9 性能基线（fps/RSS/CPU/启动关停）：**[docs/wave3-perf-baseline-2026-11-11.md](docs/wave3-perf-baseline-2026-11-11.md)**
- 窥屏互动接口预留（未接线/默认关闭）：**[docs/peek-interface.md](docs/peek-interface.md)**
- 屏幕感知/隐私/聚焦模式设计 v2（修正版；本轮仅设计、未实施）：**[docs/screen-awareness-design-v2-2026-11-11.md](docs/screen-awareness-design-v2-2026-11-11.md)**
- 打包现状 / 前置清单 / TCC：**[docs/packaging.md](docs/packaging.md)**
- 已知问题（已接受 / 延后）：**[docs/known-issues.md](docs/known-issues.md)**
- 窗沿卧姿 / 静态脚固定腿形修复（2026-11-11）：**[docs/fix-report-2026-11-11-ledge-rest-and-leg-ik.md](docs/fix-report-2026-11-11-ledge-rest-and-leg-ik.md)**
- 已知限制 R1/L2 修复（2026-11-11，抬脚释放阈值 + hipShift 命中区同步）：**[docs/fix-report-2026-11-11-limits-r1-l2.md](docs/fix-report-2026-11-11-limits-r1-l2.md)**
- **Wave 2 验收报告（V5–V8）：[docs/wave2-acceptance.md](docs/wave2-acceptance.md)**
- V1/V5 VRM 运行时接线设计：**[docs/wave2-vrm-runtime-design.md](docs/wave2-vrm-runtime-design.md)**
- V2（PMX→VRM 产出）验收证据：[docs/v2-report.md](docs/v2-report.md)
- Wave 0 完成报告：**[docs/wave0-report.md](docs/wave0-report.md)**
- **Wave 1.5（Unity 烘焙动作 U2/U3）完成报告：[docs/wave15-report.md](docs/wave15-report.md)**
- **Wave 1.5 手指补全（22 骨 → 52 骨）报告：[docs/wave15-fingers-report.md](docs/wave15-fingers-report.md)**
- **V3（HSR 官方动作 → VRM 全骨重定向）报告：[docs/vrm-motion-hsr.md](docs/vrm-motion-hsr.md)**
- 冻结契约（W0-3）：**[docs/vrm-contract.md](docs/vrm-contract.md)**
- Blender 工具链：**[docs/vrm-toolchain.md](docs/vrm-toolchain.md)**
- v1 复用审计：**[docs/reuse-audit.md](docs/reuse-audit.md)**
- v1 计划归档：`docs/archive/PLAN-v1.md`
- 私有资产（不进 git）：`assets/model/`（PMX 回退）、`assets/vrm/`（canary + 目标 VRM）、`assets/motions/`
- 参考项目（不进 git）：`refs/`（Mate-Engine / reze-rig / dsh-blender-plugin）

## 红线

- 模型版权归 miHoYo；作者规则**禁止二次配布、禁止商用**。app 与资产只限本机使用，任何公开仓库/分享包必须排除 `assets/model`、`assets/vrm`、`assets/motions`。
- 不要提交 `refs/`；不要修改 v1 归档工作区 `/Volumes/4TB外置盘/deepseek-harness/aventurine-pet`。
- 打包产物 `dist/` 已 gitignore；`.app` 内含私有资产，**仅限本机使用，不得分发**（ad-hoc 签名/未公证 + 版权红线）。

## 环境与依赖

| 项 | 版本 | 说明 |
|---|---|---|
| Node / pnpm | v24.21.0 / pnpm 10.20.0 | `packageManager` 固定 pnpm@10.20.0 |
| Electron | 44.x | 保留的桌面壳（透明 overlay / 点击穿透 / 托盘 / DSH 桥） |
| three | **0.171.0** | 渲染基础，与 `@types/three` 0.171.0 对齐 |
| @pixiv/three-vrm | **3.5.5** | VRM 加载/MToon/humanoid/expression/spring bone（devDependencies，随 renderer 打包） |
| @pixiv/three-vrm-animation | **3.5.5** | VRMA/glTF humanoid clip 加载（同上） |
| Blender | 4.2.23 LTS | `/Volumes/4TB外置盘/deepseek-harness/tools/blender`；MMD Tools 4.5.14 + VRM Add-on（工具链见 `docs/vrm-toolchain.md`） |

> `three` / `three-vrm` 放在 devDependencies 是沿用 v1 的既有约定：renderer 由 electron-vite 打包，
> 运行时不从 `node_modules` 直接 require。

## 开发

```bash
pnpm install
pnpm native:build   # 编译 native/winlist helper（predev/prebuild 自动执行；幂等）
pnpm typecheck      # tsconfig.node + tsconfig.web
pnpm test           # vitest（tests/**/*.test.ts，tests/tmp 不收集）
pnpm test:coverage  # v8 coverage（阈值见 vitest.config.mts）
pnpm dsh:canary     # DSH 桥契约 canary v2（离线失败回合 + 本地 mock 成功回合；临时 DSH_HOME，不碰真实 ~/.dsh；详见 bridge README）
pnpm package:dir    # V9：pnpm build + electron-builder --mac dir + package-check → dist/mac-arm64/AventurinePet.app（ad-hoc 签名，仅本机自用）
pnpm package:check  # V9：校验打包产物 bundle id / app.asar / Resources / helper 架构（期望 35 passed + 1 warning）
pnpm dev            # 默认 VRM 后端；legacy-pmx 仅在 PET_MODEL_BACKEND=legacy-pmx / PET_ANIM_BACKEND=legacy-pmx（或 settings 显式设置）时启用
pnpm smoke          # 端到端冒烟（需要私有 assets/model 与 native helper）
```

> 测试基线：2026-11-10 复核（补测前）112 files / 1959 passed + 14 skipped（1973 cases）；
> 全部模块收口后 120 files / 2050 passed + 11 skipped（2061 cases）；提交前二次独立复核
> 又补了 B-02/R-05/构建门禁的补丁与原有用例；2026-11-10 最终实测 **122 files / 2071 passed
> + 11 skipped（2082 cases）**；2026-11-11 窗沿卧姿 + foot-lock 腿形修复后为
> **123 files / 2131 passed + 11 skipped（2142 cases）**（报告见
> [fix-report-2026-11-11](docs/fix-report-2026-11-11-ledge-rest-and-leg-ik.md)）；同日已知限制 R1/L2 修复后为
> **123 files / 2149 passed + 11 skipped（2160 cases）**。
> **2026-11-11 Wave 3（V9 + V10 + DSH 双向集成）最终实测：129 files / 2419 passed + 11 skipped（2430 cases）**，
> `pnpm typecheck` 0 error；桥 canary PASS；详见 [docs/wave3-acceptance.md](docs/wave3-acceptance.md)。
> 17 处 `.skipIf(...)` 中大部分依赖私有资产 / `tests/tmp` fixtures（干净 clone 会条件跳过，属预期），
> 另有平台/工作树条件（如 win32、`IS_MAIN_WORKTREE`）。

私有资产 / 模板：

```bash
pnpm assets:prepare --check              # 只读校验 PMX 优化产物与 manifest
bash scripts/vrm/install-vrm-addon.sh     # W0-2：安装官方 VRM Add-on for Blender（幂等，pin v4.10.4）
node scripts/vrm/screenshot.mjs           # W0-4：three-vrm canary/戏浪 3 视图 + 10s 录屏 + 诊断（需私有 assets/vrm）
node scripts/vrm/patch-vrm-gltf.mjs "assets/vrm/星穹铁道—砂金·戏浪(1.0).vrm" \
  -o "assets/vrm/aventurine-waveflair.vrm" --force-opaque-alpha1   # W0-5：戏浪 VRM 数据修复副本（旧，仅回滚）
node scripts/vrm/fix-vrm-humanoid-legs.mjs \
  -i assets/vrm/aventurine-waveflair.vrm \
  -o assets/vrm/aventurine-waveflair-legfix.vrm                    # W1.5-legfix：腿骨→MMD 形变骨 + 腿根重挂 hips（旧，仅回滚）

# W1.5-Tpose（当前 manifest 目标）：PMX 源 → 规范 T-pose VRM 1.0（VRMify，纯 Python）
#   工具一次性准备：git clone --depth 1 https://github.com/JiGuang283/VRMify.git /tmp/vrmify \
#     && (cd /tmp/vrmify && git sparse-checkout add formats)
python3 /tmp/vrmify/convert/pmx2vrm.py "assets/model/星穹铁道—砂金·戏浪.pmx" \
  -o "assets/vrm/aventurine-tpose.vrm" \
  --spec 1.0 --scale 0.0799777 --title "砂金·戏浪" --author "miHoYo / 用户本地转换"
# 详见 docs/vrm-tpose-repair.md（含 T-pose 检查、回滚、GT 复验）
```

Wave 0-4 的渲染证据（3 视图 / 录屏 / diagnostics / report）输出到 `tests/tmp/w0-4/`（gitignore）；
Blender 工具链证据在 `tests/tmp/w0-2/`。

> 私有资产（PMX/VRM/动作/表情）因版权**不进 git，需要单独发放**。`pnpm assets:prepare` 生成
> `assets/model/optimized/`（20 张贴图 + 1 个 PMX 副本 + manifest）；`pnpm build` 的 `prebuild`
> 会自动跑 `prepare-assets.mjs --check`。没有私有资产时可用
> `AVENTURINE_SKIP_ASSETS_CHECK=1 pnpm build` 跳过校验（只跳过检查，不会生成资产，产物不可运行）。

## Wave 0（基线）状态：✅ 完成（2026-11-08）

| 任务 | 状态 | 交付 |
|---|---|---|
| W0-1 依赖与基线 | ✅ | three-vrm 3.5.5 / three-vrm-animation 3.5.5；`typecheck`/`test`/`build` 全绿 |
| W0-2 Blender VRM 工具链 | ✅ | VRM Add-on for Blender 4.10.4 幂等安装 + dummy VRM 1.0 无头导出/校验 |
| W0-3 冻结 VRM 契约 | ✅ | `src/shared/vrm.ts`、`animation-contract.ts`、`vrm-manifest.json`、`motion-manifest.json`、配置扩展 |
| W0-4 canary 查看器 | ✅ | `scripts/vrm/screenshot.mjs`；canary + 戏浪 双模型加载/MToon/骨骼/表情/录屏证据 |

详见 **[docs/wave0-report.md](docs/wave0-report.md)**。Wave 1 起按 `PLAN.md` §5 的 V1–V4 四条泳道并行；
本 Wave 已冻结契约，V1–V8 遇到契约缺口须先向 Lead 提变更请求（`docs/vrm-contract.md` §4）。

## Wave 1.5（Unity 烘焙动作）状态：✅ U0–U3 完成（2026-11-08）

Mate-Engine 的 128 个 Unity Humanoid `.anim` 经 Unity 采样烘焙为 **29 个宠物专属 clip**
（待机 7 / 走路 2 / 坐窗沿 7 / 互动反应 4 / 睡觉 1 / 躲藏 2 / 入场 3 / pose 3），
**2026-11-08 追加手指补全：每 clip 从 22 核心骨扩到 52 骨（+30 手指）**，含数据校验、自然度指标、manifest 与
「原角色/官方演示/引擎 ground truth」姿态对拍；数据与报告私有（`assets/motions/**` gitignore），
完整结论见 **[docs/wave15-report.md](docs/wave15-report.md)** 与 **[docs/wave15-fingers-report.md](docs/wave15-fingers-report.md)**。

```bash
bash scripts/unity-bake/run-export.sh          # Unity CLI 导出 + 转换（需 Unity 6000.2.6f2 + license）
node scripts/unity-bake/validate-clips.mjs     # 数据校验（PASS/WARN/FAIL + JSON 报告）
node scripts/unity-bake/build-motion-manifest.mjs --check
node scripts/unity-bake/preview-clips.mjs --all --vrm assets/vrm/aventurine-tpose.vrm \
  --out tests/tmp/wave15/aventurine --metrics tests/tmp/wave15/metrics --sheet

# 手指补全（22 骨 → 52 骨）：Unity 真实 avatar 手指探针 + 合并（详见 docs/wave15-fingers-report.md）
#   GT 探针需 Unity + work/UnityGroundTruthProj（dev-only，私有）；合并工具已提交：
node scripts/unity-bake/merge-finger-tracks.mjs \
  --gt work/finger-probe/full-aventurine/unity --model aventurine \
  --in assets/motions/mate --out assets/motions/mate \
  --report work/finger-probe/full-merge-report.json
PREVIEW_HANDS=1 node scripts/unity-bake/preview-clips.mjs --all --vrm assets/vrm/aventurine-tpose.vrm \
  --out tests/tmp/fingers/preview --metrics tests/tmp/fingers/metrics   # 额外抓手部特写
```

## Wave 1 · V3（HSR 官方动作）状态：✅ V3.1 已按 T-pose VRM 重跑（2026-11-08）

用户提供的 HSR 官方砂金 FBX（135 个 60fps take）经 Blender 全骨采样 → **rest 方向修正的**
world-delta 重定向为 VRM clip（**52 humanoid 骨含 30 手指**，目标 = 规范 T-pose 的
`aventurine-tpose.vrm`；缺 upperChest 时 chest←HSR Chest_M 并保留 identity 轨道）。
产出 14 条 `assets/motions/hsr/**`（私有 gitignore：idle×5 / 破韧 / 技能×5 / 反应×3）；
次级骨交给新模型自带 **SpringBone 50 链/175 collider**（rawPolicy=spring，raw 留空）。
本管线 QA **PASS 11 / WARN 3 / FAIL 0**（WARN 均为源动画本身快速手势），Wave 1.5 的 22 骨
validator 复核 **0 errors**；与 HSR 官方源渲染逐帧对拍，上一轮报告的「手离身体/膝盖/头、
手指怪」4 个问题全部修复（A-pose 常量偏转根因消除）。
工具链：`scripts/vrm/motion/**`（提交），完整设计/数据/限制/回滚见
**[docs/vrm-motion-hsr.md](docs/vrm-motion-hsr.md)**。旧 A-pose 版 14 条 clip 归档在
`assets/motions/hsr-apose-legacy/`（gitignore，回滚用）。

> HSR 包的 Adv_Ani 走路/跑步等 54 条 take 只有次级动画、无身体骨骼 → walk/run 仍由 Wave 1.5
> 的 Mate-Engine clip 承担；两套动作集并列（`assets/motions/mate` 与 `assets/motions/hsr`）。
> V5 接入注意：新模型无 humanoid `upperChest`（播放器跳过该骨即可）、spring 需真实 delta、
> 相机按 yawOffset=0（面向 +Z）；rawPolicy=spring 时无 raw 通道。

## Wave 1 · V1（three-vrm 渲染接线）/ V4（legacy 隔离）状态：✅ 完成（2026-11-09）

- **V1**：`PET_MODEL_BACKEND=vrm` 时 renderer 走 `VrmPetScene`（three-vrm + 正交米制相机 + 透明 overlay），
  `legacy-pmx` 回退路径零改动；`pet-asset://assets/**` 新协议 host 读取私有 VRM/动作/表情 JSON；
  CSP 修复 `blob:`（GLB 内嵌贴图解码必需）。核心模块：`src/renderer/src/vrm/`（loader/scene/clip/animator/
  expression/look-at）、`src/renderer/src/scene/pet-view.ts`、`src/main/backend-flags.ts`。
- **V4**：v1 动画实现迁入 `src/renderer/src/animation/legacy/**`，顶层 `animation/index.ts` 为 facade
  （导出集合不变）；回退 `PET_MODEL_BACKEND=legacy-pmx` smoke 仍全绿。
- 实机抓图/多轮重启/真实数据隔离证据与复跑命令见 [Wave 2 验收报告](docs/wave2-acceptance.md)。

## Wave 2（V5–V8）状态：✅ 完成（2026-11-09）

戏浪 VRM 主链接入（53 骨/95 表情/50 spring 链/17 贴图）、29 条 app 动作清单 + 43 条 catalog（Wave 2 当时口径；
> **Wave 3 后当前口径：app-manifest 40 条 / catalog 181 条**，含 adv 与 DSH 槽位别名）、
humanoid clip 播放（站/走/坐/睡/拖拽/摸头）+ 表情/眨眼/口型/look-at + DSH 联动动作映射；
`pnpm typecheck` / `pnpm test`（当时 101 files / 1736 passed；2026-11-10 复核基线 112 files / 1959 passed + 14 skipped，1973 cases）/ `pnpm smoke`（vrm + legacy 双后端）全绿，
3 轮临时 HOME 重启与真实 `~/.dsh` 未修改校验通过。细节：[docs/wave2-acceptance.md](docs/wave2-acceptance.md)。

## Wave 3（V9 / V10 + DSH 双向集成）状态：✅ 完成（2026-11-11，**已真机激活**）

> **2026-11-11 12:33 真机 HMR 激活成功**（desktop profile、不重启 DSH）：`control.json` attached +
> `bridgeVersion=3` + `dshPid=18937`；桌宠 `.app` 被桥 direct-exec 拉起（父进程=DSH Host）并进入
> `PAIRED（startup-detected）`；用户确认屏幕可见。详见 [docs/wave3-acceptance.md](docs/wave3-acceptance.md) §2.3。
> 验收矩阵（实机证据 + 用户待办）：**[docs/wave3-acceptance.md](docs/wave3-acceptance.md)**；
> 实施设计（冻结契约 v2）：**[docs/wave3-dsh-integration-design.md](docs/wave3-dsh-integration-design.md)**。

### V9 清理 / 性能 / 打包

- 打包：`electron-builder.yml`（appId `com.aventurine.pet`、productName `AventurinePet`、`--mac dir`、
  `identity: null` + afterPack **ad-hoc 签名**、`electronDist` 复用本地 Electron、`extraResources` 映射 helper/model/assets）+
  `build/after-pack-adhoc-sign.cjs` + `build/entitlements.mac.plist` 占位 + `scripts/package-check.mjs`；
  本机实测产出 `dist/mac-arm64/AventurinePet.app`（601 MB，**ad-hoc 签名，仅本机自用**；
  macOS 27 AMFI 要求签名，完全未签名的 app 会被拒绝启动），
  `pnpm package:check` **35 passed / 1 warning / 0 failed**（唯一 warning：缺 `.icns` 应用图标）。
  Developer ID 签名/公证未实现（本机 0 证书）、dmg/zip 分发未配置 → 详见 [docs/packaging.md](docs/packaging.md)。
- 性能：`scripts/vrm/measure-runtime.mjs` 已就绪（隔离 `HOME`/`PET_PROFILE`/`PET_DSH_DIR`，
  CDP 读 fps/drawCalls + `ps` 采样 RSS/CPU）；基线已产出（[wave3-perf-baseline](docs/wave3-perf-baseline-2026-11-11.md)）：
  idle fps **28.1–28.3**@fpsCap30、drawCalls 39、tri 51,829、整树 RSS 964–993 MB、CPU 14.7%、
  启动 ready 0.78–0.80 s——默认 30fps 是合理能效上限（cap60 fps+93% 但 CPU +37.5%）。
- legacy 去留：按 D9 **保留** `animation/legacy/**` 与 `legacy-pmx` 回退，不随本 Wave 删除。

### V10 烘焙动作收口

数据接线在 Wave 2 已完成，本 Wave 只做最终验收与口径收口：运行时 `assets/motions/app-manifest.json`
**40 clips** / `app-catalog.json` **181**（源：mate 30 / hsr 14 / adv 137），
`node scripts/vrm/motion/build-app-manifest.mjs --check` PASS；mate 实际 **30 条**
（Wave 1.5 报告 29 条 + 2026-11-09 男性适配新增 `dragFemale`）；动作观感待用户按
[PLAN.md](PLAN.md) §10 实机勾选。`src/shared/motion-manifest.json` 为空是 W0-3 冻结占位（私有资产不进 git），
不是缺陷。

### DSH 双向集成（4 项能力）

1. **状态反应**（Wave 2 已就绪，Wave 3 真正接通）：桥插件 v2 把 DSH busy/done/error 事件写入桥文件，
   桌宠 `ExternalReaction` 驱动动作 + 官方台词。
2. **气泡同步回复**：`src/renderer/src/reactions/dsh-dialogue.ts`（纯逻辑）——`思考中...` →
   每个 `assistant/message` 段 → 96 字切块 → 停留后消失 → 下一段；队列 8 / 单 turn 4000 字预算 /
   去重；`main.ts` 仲裁（DSH 对话气泡优先于行为层台词）。开关：设置页「头顶气泡同步 DSH 回复」
   （`dshBubbleSync`，默认开）。
3. **强耦合（互保活）**：`src/main/desktop/dsh-process.ts` + `dsh-lifecycle.ts`：
   - 任一方启动 → 另一方不在则拉起（`open -b com.deepseek.dsh` / `.app`）；
   - **显式退出**：桌宠退出 → SIGTERM DSH（≤5s 后 SIGKILL）再退出；DSH 显式退出
     （`control.json` detached + 1.5s grace 无重新 attached + 进程已不在）→ 桌宠跟随退出、**不重启**；
   - **意外崩溃**（进程消失且无 detached 信号）→ 重启 ≤2 次（5s 间隔），仍失败 → 跟随退出；
   - 防互杀环（quitReason / dshTerminatedByPet / grace），**dev（未打包）须 `PET_DSH_COUPLING=1`**
     才生效（防误杀真实 DSH）；`PET_DSH_COUPLING_DISABLE=1` 任何构建下强制关闭。
   - 开关：设置页「与 DeepSeek Harness 同生共死（双向保活）」（`dshCoupling`，默认开）。
4. **窥屏互动接口预留**：`src/shared/peek.ts` + `src/main/peek/**` 只落类型/权限/fail-closed gate/stub
   （默认关闭、恒不可用、零采集、零 TCC），未接线、设置页不显示；未来接线清单见
   [docs/peek-interface.md](docs/peek-interface.md)。

### DSH 集成激活（HMR，免重启；已激活；维护者/Lead 操作）

DSH 0.2.2-rc.1 桌面版默认开启 HMR：向运行中 desktop profile 的 `cordis.patch.yml` 追加一条桥
insert 行后，约 1–2s 内自动「旧插件 dispose → 新实例 apply」，**无需重启 DSH**。
**HMR 不会重新求值同一模块路径**（Node ESM 缓存），所以激活脚本每次自动生成新的 live 副本
`work/live-bridge/rev-<ts>/`（gitignored，自动保留最近 5 个 rev），patch 的 `name` 指向副本；
**激活后必须核对 `control.json.bridgeVersion` = 脚本打印的副本版本**。升级 = 先回滚、再重新激活（新 rev）。

```bash
cd /Volumes/4TB外置盘/deepseek-harness/aventurine-pet-vrm
APP="$PWD/dist/mac-arm64/AventurinePet.app"

# 激活（自动 live 副本 + 备份 + YAML 校验 + 幂等拒绝重复 insert）
node scripts/activate-dsh-bridge.mjs --pet-app "$APP" --dry-run   # 预演
node scripts/activate-dsh-bridge.mjs --pet-app "$APP"            # 实际激活

# 升级桥代码：先回滚 → 再激活（自动生成新 rev）
node scripts/activate-dsh-bridge.mjs --rollback
node scripts/activate-dsh-bridge.mjs --pet-app "$APP"

# 回滚（恢复最近 cordis.patch.yml.bak-wave3-<ts>）
node scripts/activate-dsh-bridge.mjs --rollback
```

激活后核对清单：`control.json`（attached + `bridgeVersion` + `dshPid`=Host pid）、`status.json` 心跳、
桌宠 direct-exec（`ps -axo pid,ppid,args` 中 ppid=DSH Host）、`main.log` `[dsh-lifecycle] 进入 PAIRED`、
设置页「已连接」、下一次 turn 的 `events.jsonl(text)` 与气泡。**回滚顺序：先回滚 profile（HMR detach）→
再手动退出桌宠 → 桥目录保留为证据**。完整步骤/常见问题/用户待办见
[docs/wave3-acceptance.md](docs/wave3-acceptance.md) §3–§4；维护边界（HMR 同路径/`work/live-bridge` 清理/
`ELECTRON_RUN_AS_NODE` 继承）见 [docs/known-issues.md](docs/known-issues.md) W3-L10~L13。

---

## Wave 1 剩余项 · 表情层（HSR Emo_ + Mate-Engine「表情对应」）状态：✅ 数据+运行时+预览完成（2026-11-08）

补齐 Wave 1.0 HSR 动作包唯一遗留的 **`Emo_*` 表情动画（17 条脸骨 take）** 和 Wave 1.5
Mate-Engine 动作包的 **face 表情层**，统一映射到目标模型自带的 VRM 1.0 preset（用户指定）：

- **数据**：`assets/expressions/{mate,hsr}/**` + `manifest.json`（私有 gitignore）共 **17 条表情 clip**
  （mate 7：待机眨眼/摸头/拖拽/顺毛/口型/重置/孤儿开心；hsr 10：PhotoGraph 五姿态 + 闭眼/笑眼 +
  眩晕/受击 + IdleShow 待机眨眼循环）；`validate-expression-clips` **17 PASS / 0 WARN / 0 FAIL**；
- **工具链**：`scripts/vrm/expression/**`（Mate .anim 解析 + Unity Hermite 采样；HSR Blender 脸骨采样 +
  OMP+NNLS 解码；manifest/校验/预览；均可 `--check` 幂等）；
- **运行时**：`src/renderer/src/vrm/expressions.ts`（纯函数，无 three 依赖）——情绪/一次性反应/
  表情 clip（含 crossfade/随机相位/源 blink 让位）/程序化眨眼/文本口型 五层合成，V6 接线即用；
- **契约**：`src/shared/expression-contract.ts`（加法式新增，不改既有冻结契约）；
- **预览**：13 preset + neutral 基线脸特写、17 条 clip 接触表、6 个运行时组合
  （`tests/tmp/expression/preview/**`，gitignore）。

完整设计/映射/限制/复跑见 **[docs/expression-mapping.md](docs/expression-mapping.md)** 与
`scripts/vrm/expression/README.md`。**app 实机表情需等 V1/V5 接线（V6）**，本轮是数据+可接线模块+证据。
