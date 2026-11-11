# 代码审查复核与修复报告（2026-11-10）

- 对象：`docs/code-review-2026-11-10.md`（豆包只读审查报告，34 条发现）
- 复核基准：HEAD `2399cbb`（该报告声称基于 `ace6c6a`；经核对 `ace6c6a..HEAD` 的 9 个提交
  恰好就是报告审查时那批未提交工作区改动，文件内容一致，行号基本未漂移）
- 方式：4 个独立只读复核 subagent（A 主进程/IPC/安全、B 渲染/VRM/性能、C 构建/原生/依赖、
  D 测试/文档/凭据）+ Lead 抽查；随后按模块 5 个修复 subagent 并行修复
- 修复后验证：`pnpm typecheck` ✓、`pnpm build`（含 prebuild）✓、`pnpm test` **120 files /
  2050 passed + 11 skipped（2061 cases）** ✓、`pnpm test:coverage`（v8，阈值
  20/20/15/20）✓、`pnpm native:check`（universal arm64+x86_64，minos 13.0）✓、
  `pnpm install --frozen-lockfile` ✓

## 1. 对原报告的复核结论

**总判断：方向大体成立，但严重度整体虚高，且存在若干事实/修复建议错误。**

- 原报告标 1 个 P0 + 13 个 P1；复核后**没有一条应保留 P0**，多数应降为 P2，
  R-19 不成立、R-29 应撤回。
- 真正最严重的隐藏缺陷是原报告只在「未决问题 12」提了一句的 **C-01**（见下），
  复核定为 P1。

### 1.1 原报告的错误 / 需降级项

| ID | 复核结论 | 关键更正 |
|---|---|---|
| R-01 | 🟡 部分成立，P0→P2 | 无 `dispose()` 属实；但**全仓无 EffectComposer**、VRM 路径无 AnimationMixer；`main.ts:1278` 注释说的是 legacy `PetScene`；当前单窗进程模型不泄漏，报告自承「用户视角不可见」 |
| R-02 | ✅ 事实成立、**修复建议错误** | `animator.dispose()` 无人调属实；但 `main.ts:202` 的 `vrmAvatar` 是 manifest 资产 `VrmAvatarAsset`，不是 loaded avatar，`vrmAvatar.dispose()` 无法编译；正确路线是 `PetView.dispose` + 场景内部释放 |
| R-03 | ✅ 成立但夸大，P1→P2 | 每脚每帧 ~18–23 个临时对象属实；`tmpA..E` 在其它路径已用，「已存在但没用上」表述不准；未实测 GC/jank |
| R-04 | ✅ 成立（未来-only），P1→P2 | 当前 prop 只加载一次，不泄漏 |
| R-05 | ✅ 代码事实，P1→P2 | 生产态无崩溃恢复属实；视觉「永久空白」是 inferred；`gpu-process-crashed` 已弃用 |
| R-06 | ✅ 代码事实，P1→P2 | 需同用户主动注入 env；capturePage 只截自身窗口，不构成 RCE/权限边界 |
| R-07 | 🟡 缺失事实成立、后果夸大 | 「未签名必然被系统拒」不成立（winlist 只读 bounds 不需要 TCC）；属 Wave 3 V9 已知待办，非当前缺陷 |
| R-08 | 🟡 字段/实测成立，跨机结论是推断 | stamp 缺 arch 属实，但 stamp 含 swiftc 版本，本机因 6.4.0≠6.4.2 会重编；`-arch` 在本机 swiftc 6.4.2 直接报 `unknown argument`，正确做法是 `-target` + lipo |
| R-09 | ✅ 成立（P2） | 已按官方 ≥sha256 清单补 pin；Blender 官方 `download.blender.org` 对 curl 403 是已知事实，报告「改回官方源」不适用 |
| R-11 | 🟡 部分成立 | 「out/ 里无 PMX/贴图」错误——资产从 assets/Resources 读、从不进 out；`.gitignore` 范围应 17–29 |
| R-12 | 🟡 部分成立，P1→P2/P3 | `avatar-loader` 确实无测试；但「`tests/vrm-look-at.test.ts` 唯一 import」错误，且 `patchVrmGlbBuffer` 原语已被 tests/vrm-glb.test.ts 直测 |
| R-13 | 🟡 部分成立，P1→P3 | login-item 无专门测试属实；但**「app-context 无测试」错误**（fix-f1 测试真实覆盖 app-context） |
| R-14 | 🟡 部分成立，P1→P2 | 3 个 `it.skip` 属实；但报告路径 `work/tmp/...` 错误（实际 `tests/tmp/...`），且当前 README 已无 climb 文字 |
| R-15 | 🟡 **前提反了** | 报告称「依赖 backgroundThrottling 默认 true」；实际 `overlay-manager.ts` 显式 `backgroundThrottling:false`，隐藏窗口仍满帧渲染；`document.hidden` 也不可靠（该开关影响 Page Visibility） |
| R-16 | ❌ 场景不成立 | overlay `resizable:false / movable:false`，不存在「窗口边缘拖拽 resize 风暴」 |
| R-18 | 🟡 部分成立、因果不完整 | main.ts 还静态 import `PetScene`（内含 MMDLoader），即使动态化 animation 也抖不掉 MMD 链；未做 bundle analyzer |
| R-19 | ❌ **不成立** | `THREE.Cache.enabled` 默认 false 且全仓未启用，不存在「命中旧纹理」路径 |
| R-20 | 🟡 部分成立 | `registry.dispose` 并非「从未被调用」（clip-player.dispose 会调用），只是最外层 animator.dispose 不可达 |
| R-25 | 🟡 事实成立、**修复建议错误** | Electron 44 **没有** `Notification.getSettings()` / `getNotificationSettings()`；无可靠 API，不伪造状态 |
| R-28 | 🟡 机制成立、定性夸大 | 「参与签名」实为 build stamp hash，不是 codesign；PATH 被控时攻击者已能执行命令 |
| R-29 | ❌ **作为风险项不成立** | 不读 kCGWindowName/错误处理/坐标钳制均正确；「未签名 app 会被拒」无证据 → 撤回 |
| R-30 | ✅ 成立且比报告更严重 | binary 与 stamp **都被 track**；build-native.mjs 与 native README 还谎称已 gitignore |
| R-31 | ✅ 成立（P3） | README 默认后端与测试数字均过时 |
| R-32 | 🟡 部分成立 | 无 coverage 配置属实；「tests/setup.ts 空文件」不准确（注释+export {}） |
| R-33 | 🟡 部分成立、统计错误 | docs tracked 实为 73 个不是 45；「0 个匹配」不成立（已有 wave2-acceptance 等提到打包/权限） |
| R-34 | 🟡 部分成立、证据反向 | settings IPC registrar 实为**零覆盖**（fix-f1 测的是 settings-window 不是 registrar） |

统计/元数据错误另含：P2 标题「21 条」实为 20 个 ID；块 A/B/C/D 小结条数与正文不符；
`ipcMain.handle` 为 12 个非 11；tracked 516 为旧基准（现 521）；测试「122 个」含
`tests/tmp/` 的 10 个（vitest 实收集 112）；`vitest list` 静态 1823 例 ≠ 实测 1973 例；
R-01/R-08/R-28 的「签名」术语混用。

### 1.2 复核新发现（原报告遗漏）

| 新ID | 严重度 | 位置 | 问题 |
|---|---|---|---|
| **C-01** | **P1** | `native/winlist/.build/winlist`、`scripts/build-native.mjs` | tracked helper 为 arm64 thin 且 `LC_BUILD_VERSION minos 27.0`，Electron 44 最低 macOS 13.0 → macOS 13–26 上 helper 无法执行，`winlist.ts` 静默降级为 `[]`（本机 macOS 27 隐藏了该问题） |
| C-02 | P2 | `package.json`、`scripts/build-native.mjs` | `pnpm dev`/`pnpm build` 不构建 native helper，干净 clone 后静默降级 |
| B-01/A-01 | P2 | `overlay-manager.ts:48,227,352-363` | 隐藏窗口仍满帧渲染（即 R-15 的真实版本） |
| B-02 | P2 | `pet-scene-vrm.ts` | 无 WebGL context lost/restored 处理，GPU 崩溃/重置后画布永久空白 |
| A-02 | P2 | `src/main/index.ts`、`package.json` | `PET_SMOKE_TEST` 生产态未门控（但 `smoke:file` 依赖它，故保留并注释） |
| A-03 | P3 | `bridge/.../lib/index.js` | bridge 0600/0700 仅在创建时生效，已存在文件不被修正（父目录 0700 兜底，接受） |
| C-03 | P3 | 多个安装脚本 | 工具链默认路径硬编码 `/Volumes/...`，不可移植（有 env override，文档记录） |
| C-04 | P3 | `scripts/vrm/install-vrm-addon.sh` | legacy ≤4.1 分支把可被 env 覆盖的路径插入 Blender `--python-expr` 三引号字符串，可注入 |
| C-05 | P3 | `scripts/vrm/motion/run-adv-pipeline.sh` | 选项缺值时 `shift 2` 失败 → while 死循环 |
| D-01 | P3 | `docs/unity-bake-report.md:10` | tracked 文档含真实姓名+邮箱（原报告称「邮箱 0 命中」错误） |
| D-02 | P3 | `docs/anim-strategy.md`、`docs/research/motion-assets.md` | tracked 文档 4 处含第三方网盘分享口令（原报告漏） |
| D-03 | P3 | `tests/**` | 条件跳过实为 17 处 `.skipIf(...)`（原报告只提 3 个 climb skip） |
| D-04 | P3 | `src/preload/index.ts` | preload 白名单无独立单测 |
| D-05 | P3 | `.gitignore` | 缺 `*.key/*.pem/*.pmx` 兜底 |

## 2. 本轮修复清单（按模块）

### 渲染 / VRM（R-01/R-02/R-03/R-04/R-20/R-17/B-02）
- `PetView` 增加可选 `dispose()`；`VrmPetScene.dispose()` 幂等释放
  avatar（`VRMUtils.deepDispose`）、子树 geometry/material/texture（共享 Set 去重）、
  renderer/context/canvas，`Cache` 仅在启用时清理；legacy `PetScene` best-effort dispose。
- `main.ts` shutdown 顺序：`vrmAnimator.dispose()` → `vrmHandPropLayer.dispose()` →
  `scene.dispose()`；加载中断/迟到结果也会释放（不挂回场景）。
- `prop-layer.dispose()` 先 detach 再 traverse 释放道具资源（R-04）。
- `foot-lock` 增加可复用 `FootLockScratch`，`solveFoot` 每帧零临时分配（R-03；scratch/无
  scratch 结果一致性有测试）。
- `clip-registry` dispose 后不再回填 in-flight 缓存（R-20）。
- `main.ts` 每帧快照/动画输入改复用容器；`VrmPetScene.step` 复用 `frameAnimationInput`（R-17）。
- WebGL `contextlost`（preventDefault + 1.5s 单次 reload 限流）/`contextrestored` 监听（B-02）。
- 新增 `src/renderer/src/vrm/dispose.ts` + `tests/vrm-dispose.test.ts`（7 条）等 **8 个新增测试文件**。
- **未修**：R-18（legacy 静态 import → bundle 体积，改造风险大于收益，已记录）。

### 行为（R-14）
- 解耦「自主调度」与「debug 显式触发」：climb 仍 `baseWeight:0 + schedulable:false`
  自主永不选中，但 `triggerActivity('climb')` 可调试触发；3 个 `it.skip` 恢复为真测试
  （behavior-director 39/39，0 skipped）；README/注释同步。

### 主进程 / IPC / 安全（R-05/R-06/R-15/R-22/R-23/R-24/R-26/R-27/R-21/R-25）
- 新增 `windows/crash-recovery.ts`：生产态 renderer 崩溃/无响应限流恢复（10min/3 次）、
  GPU 进程崩溃兜底 reload；`PET_SMOKE_TEST` 不挂（冒烟守护优先）。
- R-15：`setVisible()` 时运行时切换 `webContents.setBackgroundThrottling()`——隐藏窗口
  恢复节流、显示前关闭节流（只影响隐藏帧率，构造期仍为 false 保证可见时稳定）。
- R-06：dev capture 链路加 `is.dev` 门控；`PET_SMOKE_TEST` 保留（`smoke:file` 依赖，
  已注释）；A-02 记录。
- R-22：导航拒绝日志只记 protocol/origin（index.ts + settings-window.ts）。
- R-23：新增 `security/renderer-network-guard.ts`，打包态拦截 renderer 全部 http(s) 出站
  （不拦 file/pet-asset/dev）。
- R-24：`bridge-schema` 增加 payload 半白名单清洗（已知 10 字段严格校验/截断，未知
  结构化值丢弃、危险键丢弃；为兼容既有 dsh-watch 夹具保留未知标量）。
- R-26：contextIsolation 关闭时 preload fail-fast 抛错（不再静默挂 window）。
- R-27：config.json 原子写显式 `mode: 0o600`。
- R-21：moveWindow/notify 保持冻结契约（Wave 3 C1/C3 未实现），加注释说明。
- R-25：经查 Electron 44 无通知授权查询 API → 不伪造状态，注释记录限制。
- 新增 4 个测试文件（crash-recovery 23、network-guard 10、bridge-schema-sanitize 16、
  settings-crash-guard 5）+ overlay/config 用例。

### 构建 / 原生 / 脚本（C-01/R-08/C-02/R-09/R-10/R-30/R-11/R-28/C-04/C-05/D-05）
- `build-native.mjs` 重写为 **universal**：每架构 `-target <arch>-apple-macos13.0` 编译 +
  `lipo -create`；stamp(format=2) 含 platform/arch/minMacosVersion/archs/flagsByArch/swiftcPath；
  幂等=签名一致 + lipo 架构 + minos 校验通过；`--check` 校验 universal/minos 并真跑
  `--json`；swiftc realpath 白名单（R-28）。
- 修复 C-01：重建产物实测 `arm64+x86_64`、两 slice `minos 13.0`（原为 arm64 thin/minos 27）。
- 新增 `scripts/prebuild.mjs` + `prebuild`/`predev` 钩子（构建 helper + 私有资产 check；
  `AVENTURINE_SKIP_ASSETS_CHECK=1` 可跳过并提示产物不可运行）。
- R-09：Blender DMG / MMD Tools zip 加 sha256 pin（官方清单/实算值），删除
  `xattr -dr com.apple.quarantine`，改 `codesign --verify --deep --strict`（fresh 严格、
  existing 仅容忍 Blender 自身 `__pycache__` 漂移）。
- R-10：`run-export.sh` 的 `rm -rf` 加绝对路径 + `work/`/`~/.cache/` 白名单 + 5s TTY 倒计时
  + `AVENTURINE_EXPORT_DRY_RUN=1`；临时目录自测 11/11 拦截/放行用例通过。
- R-30/D-05：`.gitignore` 加 `native/**/.build/`、`*.key`、`*.pem`、`*.pmx`；
  `git rm --cached` 两个误提交产物（磁盘文件保留）；native README/脚本注释纠正。
- C-04：legacy Blender addon 分支改 env 传路径，消除 `'''` 注入；C-05：选项缺值报错退出。
- C-02/R-11：`predev`/`prebuild` 接线，干净 clone 不再静默降级/白屏。

### 测试 / 文档 / 凭据（R-12/R-13/R-31/R-32/R-33/R-34/D-01/D-02/D-03）
- 新增 `tests/avatar-loader.test.ts`（13，parse 重试/贴图与 spring 链统计；avatar-loader 最小
  可测化，默认生产路径不变）、`tests/login-item.test.ts`（5）、`tests/settings-ipc.test.ts`（4，
  registrar 从零覆盖到有覆盖）。**残余缺口**：VRM0 `rotateVRM0` / humanoid 必需骨缺失 /
  `missingTextures` 计数仍在 `loadVrmAvatar` 主体内，暂无单测（见 known-issues「R-12 残余」）。
- `vitest.config.mts` 加 v8 coverage（include src/**，排除两个 Electron/渲染入口 main.ts——
  其中 `src/main/index.ts` 是启动/装配逻辑、并非纯入口，node 环境不可测；宽松阈值 20/20/15/20；
  `pnpm test:coverage` 实测通过，All files ≈76.2% stmts / 72.9% branch / 75.4% funcs /
  78.5% lines）。
- README：默认后端改为 VRM、测试基线刷新（补测前 112/1959+14 → 收口后
  120/2050+11）、补 `test:coverage`/native 构建/私有资产说明；Wave 2 历史数字保留语义。
- 新增 `docs/packaging.md`（Wave 3 V9 打包前置：electron-builder/签名/公证/extraResources/
  LSMinimumSystemVersion 13.0/TCC 清单）与 `docs/known-issues.md`（明确本轮不修/接受项）。
- D-01/D-02 脱敏：真实姓名+邮箱、4 处网盘口令 → `[已脱敏]`。

## 3. 验证结果（2026-11-10 22:29 最终态）

```text
pnpm typecheck                     exit 0（node + web）
pnpm test                          120 files / 2050 passed + 11 skipped (2061)  exit 0
pnpm build                          prebuild(native+assets check) + typecheck + electron-vite build  exit 0
pnpm test:coverage                  v8 coverage 阈值 20/20/15/20 通过  exit 0
pnpm native:check                   universal archs=arm64+x86_64, minos=13.0, --json ok(9 windows)
pnpm install --frozen-lockfile      Lockfile is up to date
git diff --cached                   仅两个 native/.build 产物的删除（磁盘保留）
HEAD                               2399cbb（未 commit，所有改动在工作区）
```

## 4. 本轮明确不修 / 延后（理由）

| 项 | 状态 | 理由 |
|---|---|---|
| R-07 打包/签名/公证/entitlements | 延后（Wave 3 V9） | 本机 0 个有效 codesigning identity；PLAN 明确 V9 才做；已补 `docs/packaging.md` 前置清单 |
| R-18 legacy 静态 import → bundle 体积 | 延后 | 动态 import 改造涉及 updateLayout 同步链路与 MMD 链，风险大于收益；需先 bundle analyzer |
| R-21 moveWindow/notify 无 handler | 保留契约 | 冻结契约 + Wave 3 C1/C3 计划内占位，renderer 无调用点；加注释防误删 |
| R-25 通知授权状态 | 不修功能 | Electron 44 无可查询 API，`'unknown'` 是诚实值 |
| R-16 / R-19 / R-29 | 撤回/非缺陷 | 见 §1.1 |
| A-03 / C-03 / D-04 | 记录不修 | 威胁/收益低，已写入 known-issues/packaging |
| x86_64 slice 实机运行 | 未验证 | 仅验证架构+minos；本机 arm64 未在 Rosetta 下运行 |
| `pnpm smoke` / `smoke:file` 真机冒烟 | 未跑 | 会拉起 GUI overlay 窗口，留给用户在本机执行 |

## 5. 说明

- 原报告 `docs/code-review-2026-11-10.md` 未改动；其错误/遗漏以本文件为准。
- 本轮所有改动未 commit；`pnpm install` 后 lockfile 已同步（新增
  `@vitest/coverage-v8@5.1.0`），`scripts/prebuild.mjs`、8 个新测试文件、`docs/packaging.md`、
  `docs/known-issues.md`、`src/main/security/`、`src/main/windows/crash-recovery.ts`、
  `src/renderer/src/vrm/dispose.ts` 为 untracked，commit 时记得 `git add`。

## 6. 提交前二次独立复核（2026-11-10 晚，4 个只读 subagent）

提交前按 4 个模块（主进程/IPC/安全、渲染/VRM/行为、构建/原生/脚本、测试/文档/凭据）做了
独立只读复核（报告在 `work/review-round2/`，gitignore 不入库）。结论：**无 P0/P1 回归，
修复主体成立**；复核发现并处置：

| 项 | 发现 | 处置 |
|---|---|---|
| B-02 生产无效 | `location.reload()` 触发 `will-navigate`，被生产态导航守卫取消（Electron 44 探针实测） | **已修**：新增 `src/main/security/navigation-guard.ts`，`will-navigate` 仅放行「与**最近一次真实提交 URL**（`did-navigate` 记录，不用可被 `history.replaceState` 篡改的 `getURL()`）逐字符相等」的 reload；`will-redirect` 仍全拒；另加跨 reload 限流（sessionStorage 10min/3 次，`vrm/context-loss.ts`）。Electron 44 探针复测：正常 reload 放行；replaceState 到其它 file/https 后 reload 均被拦、无导航提交 |
| R-05 双 reload | unresponsive 定时器未与 render-process-gone/GPU 路径协调，同一事故可能扣 2 次预算 | **已修**：`tryReload` 统一清 pending unresponsive 定时器；GPU 波 `incidentDedupeMs=2s` 去重；GPU `clean-exit` 不恢复；单测 23→28 |
| C-01 `--check` 假绿 | minos 上界用的是本机 macOS，macOS 27 开发机会放过 universal+minos 14/27 | **已修**：每个架构 slice 的 minos 必须 === 13.0（负测：自编 universal minos 14.0 → `BUILD_NATIVE_FAIL`） |
| R-28 先执行后校验 | PATH 上不可信 swiftc 在 realpath 白名单校验前已被执行一次 | **已修**：先解析 realpath + 白名单，通过后才执行 `--version`（负测：假 swiftc marker 未生成） |
| R-12 覆盖缺口 | VRM0/humanoid/missingTextures 分支未单测 | 记录在 `known-issues.md`（不阻塞提交） |
| R-32 口径 | 排除 2 个 main.ts 约 9.4%、阈值偏低 | 记录在 `known-issues.md`（不阻塞提交） |
| A-02 / R-05 unresponsive / R-23 ws-wss / dev 路径 | 非阻塞残余 | 记录在 `known-issues.md` |
| 脱敏补漏 | 4 个历史文档中 8 处 `/Users/<拼音用户名>` 路径 | 主 commit 后追加独立 docs commit 清理 |

复核后全量验证（最终树）：`pnpm typecheck` ✓、`pnpm test` **122 files / 2071 passed + 11 skipped
（2082 cases）** ✓、`pnpm build` ✓、`pnpm native:check`（universal，双 slice minos 13.0）✓。
