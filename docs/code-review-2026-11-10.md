# aventurine-pet-vrm 只读代码审查报告

- 审查日期：2026-11-10
- HEAD：`ace6c6ad11c9e3acd994369a354bdd3aa06a0336`（工作区另有 15 个 modified + 5 个 untracked 文件，本报告基于当前工作区状态）
- 范围：4 个并行 subagent 分块只读审查（主进程/IPC、渲染/VRM/性能、原生/构建/依赖、测试/凭据/docs）
- 纪律：每条发现均带 `文件:行号` literal locator；证据类型 `confirmed`/`inferred`/`unknown`；关键风险已联网核实并附 URL；**未修改任何源码**。

## 1. 项目身份卡

| 项 | 值 |
|---|---|
| 名称 | aventurine-pet（砂金·戏浪 macOS 3D 桌面宠物） |
| 技术栈 | Electron 44.10.2（lockfile 实锁；package.json spec `^44.7.2`）+ electron-vite 6 + three 0.171 + @pixiv/three-vrm 3.5.5 + TypeScript 5.9 + Node ≥22.12 + pnpm 10.20 + sharp 0.35.5（仅构建期）+ mmd-parser 1.1.4（仅构建期）+ vitest 5 |
| 入口链 | `out/main/index.js`（由 `src/main/index.ts` 构建）→ `bootstrap()` → `hardenSession()` → 注册 `pet-asset://` 协议 → 注册 5 个 IPC registrar → `createOverlayWindowsManager`（每屏一个透明置顶 `BrowserWindow`，`sandbox+contextIsolation+nodeIntegration:false`）→ 托盘 |
| 渲染链 | `src/renderer/index.html` → `src/renderer/src/main.ts` 手写 `requestAnimationFrame` 驱动 `VrmPetScene.step(nowMs)`，delta clamp 0.1s → GLTFLoader + `@pixiv/three-vrm` 加载 `pet-asset://` VRM GLB，装配 animator / clip-player / foot-lock / micro-motion / expression-layer / prop-layer |
| 原生助手 | `native/winlist/main.swift`（`CGWindowListCopyWindowInfo` 枚举窗口 bounds/pid/owner/layer/alpha，**不读窗口名**），由 `src/main/desktop/winlist.ts` 每 250ms spawn `--json` |
| 测试 | 122 个 `*.test.ts`，vitest node 环境，无 coverage 阈值 |
| 打包 | **无 electron-builder 配置、无签名、无公证、无 entitlements**（Wave 3 C4 未接线） |

## 2. 风险清单（按严重度排序）

> 字段：`ID | 严重度 | 模块 | 位置(file:line) | 风险描述 | 证据 | 联网核实 | 修复建议 | 工作量`
> 工作量：S≤0.5d / M≈1-2d / L≈3d+

### P0（1 条）

| ID | 严重度 | 模块 | 位置 | 风险描述 | 证据 | 联网核实 | 修复建议 | 工作量 |
|---|---|---|---|---|---|---|---|---|
| R-01 | **P0** | 渲染 | `src/renderer/src/vrm/pet-scene-vrm.ts:192-863`（类无 `dispose` 方法）；`src/renderer/src/main.ts:1278`（注释自承"PetScene 目前没有 dispose()"） | `VrmPetScene` 无 `dispose()`：`WebGLRenderer`、Scene、Camera、灯光、AnimationMixer、EffectComposer 全部无释放路径。`shutdown()` 只 `setPetVisible(false)`，不调 `renderer.dispose()`/`forceContextLoss()`，不 traverse dispose geometry/material/texture，不清 `THREE.Cache`。当前单窗单 avatar 进程模型下关窗即退出，运行时不泄漏；但一旦未来支持 avatar 热切换或 renderer 进程复用，旧 GPU 资源（VRM 骨架/蒙皮/纹理）全部驻留。`loadModel()` 在 `pet-scene-vrm.ts:393` 硬编码只允许加载一次，与热切换预期冲突。 | confirmed | three.js 官方 Cleanup 手册要求顺序：traverse `geometry.dispose()` → `material.dispose()` → `texture.dispose()` → `renderer.dispose()` → `renderer.forceContextLoss()`（https://threejs.org/manual/pages/cleanup.html ；https://threejs.org/docs/pages/WebGLRenderer.html ） | 给 `VrmPetScene` 加 `dispose()`：traverse 释放 geometry/material/texture → `renderer.dispose()` → `renderer.forceContextLoss()` → `THREE.Cache.clear()`；`shutdown()` 末尾调用。 | M |

### P1（13 条）

| ID | 严重度 | 模块 | 位置 | 风险描述 | 证据 | 联网核实 | 修复建议 | 工作量 |
|---|---|---|---|---|---|---|---|---|
| R-02 | P1 | 渲染 | `src/renderer/src/main.ts:1301-1311`（shutdown 调用清单）；对照 `src/renderer/src/vrm/animator.ts:597`（`dispose()` 存在）、`src/renderer/src/vrm/avatar-loader.ts:740`（内部调 `VRMUtils.deepDispose`） | 两条**已写但无人调用**的 dispose 路径：(a) `vrmAnimator?.dispose()` 无人调（持有 AnimationMixer/全部 AnimationClip/expression/look-at/foot-lock/micro-motion）；(b) `vrmAvatar.dispose()`（内部 `VRMUtils.deepDispose(scene)`）无人调。shutdown 只调了 `vrmHandPropLayer?.dispose()`。与 R-01 同源：Electron 热重载 / 多窗共享 renderer 时泄漏。 | confirmed（grep 全仓无调用点） | @pixiv/three-vrm 1.0 migration guide 明确：`vrm.dispose()` 已移除，必须手动调 `VRMUtils.deepDispose(vrm.scene)`（https://pixiv.github.io/three-vrm/docs/documents/migration-guide-1.0.html ） | shutdown() 末尾补 `vrmAnimator?.dispose(); vrmAvatar?.dispose();`，顺序：animator 停 mixer → avatar deepDispose → renderer。 | S |
| R-03 | P1 | 渲染 | `src/renderer/src/vrm/foot-lock.ts:183-215,221-233,236-248,610-660` | 每帧堆分配热点：idle 时每帧对左右脚各调一次 `solveFoot`，内部 `toTarget.clone()` / `hipToKnee.clone()` / `pole.clone()` / `u.clone()` / `hint.clone()` / `new Vector3(0,-1,0)` / `new Vector3(0,0,1)` 等 15–20 个临时 Vector3/Quaternion。对比：`clip-player.ts:417`、`micro-motion.ts:331-332`、`look-at.ts:113-116` 都正确复用了模块级 tmp 对象，foot-lock 是唯一没做的。 | confirmed（源码逐行） | —（静态可证伪点，建议 Chrome DevTools Memory allocation sampler 实测 pause） | 把 `solveKneePosition` / `computeUpper/LowerDesiredWorldQuat` 改成接受 `out` 参数的纯函数，复用 `this.tmpA..tmpE` / `this.tmpQuatA..C`（line 268-276 已存在但没用上）。 | M |
| R-04 | P1 | 渲染 | `src/renderer/src/vrm/prop-layer.ts:173-182` | prop 道具 GLB 卸载时 `dispose()` 只 `removeFromParent()`，**没有 traverse dispose prop 自己的 geometry/material/texture**。文件头注释（line 11-12）暗示应独立 dispose，但实现漏了。当前 prop 只加载一次不换，故不泄漏；未来支持手持道具切换则泄漏。 | confirmed（代码与注释不一致） | three.js GLTF 重载需手动 dispose 子树 geometry/material（https://threejs.org/manual/pages/cleanup.html ） | `dispose()` 里 traverse `this.propRoot`，对 Mesh.geometry/material/texture 单独 dispose（避开 VRM 主模型资源）。 | S |
| R-05 | P1 | 主进程 | `src/main/index.ts:276-294`（`attachSmokeWindowGuards`）；唯一 `render-process-gone` 挂载点在冒烟守护里 | 生产模式完全无 renderer/GPU/子进程崩溃恢复：`render-process-gone` 只在 `PET_SMOKE_TEST=1` 挂；全仓 grep 不到 `gpu-process-crashed` / `child-process-gone` / `unresponsive`。桌宠是透明置顶窗，WebGL renderer 崩溃后窗口变空白，托盘还在、app 还在跑，宠物永久消失，用户只能从托盘退出。 | confirmed | Electron 官方 Crash Reporting 指南：应在 `app.on('render-process-gone')` 或 `webContents.on('render-process-gone')` 处理并 reload/重建（https://www.electronjs.org/docs/latest/tutorial/crash-reporting ；https://www.electronjs.org/docs/latest/api/app ） | 对每个 overlay `win.webContents` 挂生产态 `render-process-gone`/`unresponsive`：记日志、延迟 N 秒后 `win.reload()` 或重建该屏 overlay；`app.on('gpu-process-crashed')` 兜底。 | M |
| R-06 | P1 | 主进程 | `src/main/index.ts:96`（`DEV_CAPTURE_DIR = process.env['PET_DEV_CAPTURE_DIR']`）；`:2545-2552`（触发分支只判 `!SMOKE_TEST && DEV_CAPTURE_DIR`，无 `is.dev` 门控）；主体 `:605-895`（`runDevCapture`） | dev 姿态截图回环在打包版未被 `is.dev` / `app.isPackaged` 门禁：只要启动环境带 `PET_DEV_CAPTURE_DIR=<任意路径>`，主进程就会在主屏 `did-finish-load` 后 `mkdirSync`、`capturePage()` 截屏、写 PNG + debug JSON 到该路径，并 `app.exit()`。环境变量拼进 `executeJavaScript` 全部走 `JSON.stringify`（line 757/803/826），字符串字面量转义完整，**不能跳出 JS 上下文，不构成 RCE**；但同用户攻击者可借环境变量让生产 app 截屏+写文件+自退出。 | confirmed | — | 在 `onDidFinishLoad` 的 `if (DEV_CAPTURE_DIR ...)` 外层再加 `&& is.dev`（或 `&& !app.isPackaged`），让 dev-capture 整条链路只在开发模式可达。 | S |
| R-07 | P1 | 构建/打包 | `package.json:1`（全仓 grep `electron-builder` 仅命中注释/README） | 完全缺失打包/签名/公证/沙盒配置：无 `electron-builder.yml`、无 `build` 字段、无 `afterSign`/`notarize`/`entitlements.mac.plist`。脚本注释（`scripts/build-native.mjs:40`、`scripts/prepare-assets.mjs:12`、`src/main/desktop/winlist.ts:169`）都假设未来会有 electron-builder `extraResources`，但从未落地。后果：①分发到别的 Mac 被 Gatekeeper 拦（无签名/无公证）；②`native/winlist` 二进制与 `assets/model/optimized/` 根本不进 .app；③桌宠要枚举其它窗口、跟窗口移动，未签名+未公证+未声明 entitlements 必然被系统拒。 | confirmed | electron-builder 官方：公证必须 `hardenedRuntime: true` + 对应 entitlements；unsigned app 分发到别人 Mac 会触发"App is damaged and can't be opened"（https://www.electron.build/docs/notarization/ ；https://www.electron.build/docs/mac/ ；https://www.electron.build/v26/docs/troubleshooting/ ） | 新增 `electron-builder.yml`，至少：`mac.category`、`mac.identity`、`hardenedRuntime: true`、`entitlements`、`entitlementsInherit`、`notarize`、`extraResources` 把 `native/winlist/.build/winlist` 与 `assets/model/optimized/` 打进 `Contents/Resources/`；同步 `winlist.ts` 的 `process.resourcesPath` 路径常量。 | L |
| R-08 | P1 | 构建 | `scripts/build-native.mjs:118-126`（compileFlags）；`:138-155`（signatureDetails）；实测 `file native/winlist/.build/winlist` → `Mach-O 64-bit executable arm64`、`lipo -info` → `Non-fat file ... arm64` | 原生助手只编本机架构，无 universal binary，且 build signature 不含 arch/os。`compileFlags` 只有 `['-O','-framework','CoreGraphics']`，没有 `-arch arm64 -arch x86_64`。`signatureDetails` 算 hash 含 swiftc.version/flags，但**不含 `process.arch`/`process.platform`/`os.arch()`**——arm64 机器上编的 stamp，把产物拷到 Intel Mac 上跑，脚本仍判 up-to-date，实际执行 `Bad CPU type`。`--check` 跑本机刚编的二进制，不可能发现跨架构问题。 | confirmed | —（Swift universal binary 标准做法：`swiftc -arch arm64 -arch x86_64`） | ① `compileFlags` 加 `['-arch','arm64','-arch','x86_64']`（或按最低 macOS 版本加 `-target` 对）；② `signatureDetails` 把 `process.arch`/`process.platform` 写进签名 JSON；③ `--check` 加 `lipo -info` 解析架构列表。 | M |
| R-09 | P1 | 脚本 | `scripts/anim-pipeline/blender/install-blender.sh:49-55,78`；`:69`（`xattr -dr com.apple.quarantine`） | Blender DMG 与 MMD Tools zip 下载后**未做 sha256 pin**：`install-vrm-addon.sh:35-37` 正确 pin 了，但这个脚本：① DMG 从镜像站拉，只在 line 55 `shasum` 打印不比对；② MMD Tools zip 同样无校验；③ line 69 `xattr -dr com.apple.quarantine "$BLENDER_APP"` 主动剥离 Gatekeeper 隔离位——把一个未校验哈希的第三方 DMG 解出的 .app 直接变成"已信任"，MITM / 镜像被替换即等同在本机跑任意代码。 | confirmed | `xattr -dr com.apple.quarantine` 是合法 dev workaround，但在 install 脚本里对未校验哈希的下载物执行，等于绕过 Gatekeeper（https://hometechops.com/mac/app-is-damaged-cant-be-opened-mac ："Do not remove quarantine to force damaged/malware-flagged software open"） | ① 顶部常量 pin `BLENDER_DMG_SHA256`/`MMD_ZIP_SHA256`，下载后 `shasum -a 256` 比对失败即 `die`；② 删除或注释 `xattr -dr com.apple.quarantine`；③ 镜像 URL 改 HTTPS + 官方 `download.blender.org`。 | S |
| R-10 | P1 | 脚本 | `scripts/unity-bake/run-export.sh:106`（`rm -rf "$PROJECT"`） | `rm -rf "$PROJECT"` 前无白名单校验。默认值 `$ROOT/work/AventurineBakeProj`，但 `PROJECT=/anything` 环境变量可覆盖。line 103 判断 `if [ ! -f "$PROJECT/ProjectSettings/ProjectVersion.txt" ]` 才走到 `rm -rf`——若把 `PROJECT` 指到一个已存在但无 ProjectVersion.txt 的目录（如 `/Users/x/Documents`、`/`、`$HOME`），脚本会 `mkdir -p $(dirname)` 然后 `rm -rf "$PROJECT"`。开发者本机脚本，非分发路径，但典型"环境变量即武器"。 | confirmed | — | `rm -rf` 前加守卫：只接受绝对路径；要求 dirname 在 `$ROOT/work/` 或 `$HOME/.cache/` 白名单下；至少 `echo "About to rm -rf $PROJECT, Ctrl-C within 5s" && sleep 5`。 | S |
| R-11 | P1 | 构建/资源 | `package.json:24`（`"assets:prepare": "node scripts/prepare-assets.mjs"`）；`.gitignore:17-25`（assets/model/、assets/vrm/、assets/motions/、assets/expressions/、assets/props/、assets/*.zip|vrm|glb|vrma 全忽略） | 生产资源来源断链：模型/动作/表情全部被 .gitignore 排除，但 `package.json` 无 `prepare`/`prebuild`/`postinstall` 钩子去生成 `assets/model/optimized/`（`scripts/prepare-assets.mjs:543-599` 产物）。干净 clone → `pnpm install` → `pnpm build` 不触发 `assets:prepare`，`out/` 里既无 PMX 也无贴图。且 `.gitignore` 已把整个 `assets/model/` 排除，仓库里没有任何 PMX 源文件——CI / 其他开发者完全无法复现。 | confirmed | — | ① `package.json` 加 `"prebuild": "node scripts/build-native.mjs && node scripts/prepare-assets.mjs --check"`，README 明确"PMX 源文件需单独发放"；② 或换 CC0/自有版权占位 VRM 入库让 CI 可跑；③ `pnpm build` 失败路径检查 `assets/model/optimized/` 是否存在。 | M |
| R-12 | P1 | 测试 | `src/renderer/src/vrm/avatar-loader.ts:1-30`（对照 `tests/vrm-look-at.test.ts` 唯一 import） | VRM 加载主链路无单测：`fetch → GLTFLoader parseAsync → patchVrmGlbBuffer 内存修复重试一次 → VRM0 旋转 → humanoid 15 必需骨探测 → 包围盒/贴图缺失计数` 多分支均无断言；GLB 修复失败重试、缺失贴图计数、VRM0/VRM1 坐标分支一旦回归只能靠 `pnpm smoke` 手动发现。 | confirmed | — | 用 node 环境 + 合成 ArrayBuffer/fixture GLB（或 mock GLTFLoader）补 loader 纯函数分支：patch 失败重试一次、VRM0 rotateVRM0、humanoid 骨缺项、missingTextures 计数。 | M |
| R-13 | P1 | 测试 | `src/main/login-item.ts`（全文无对应 test） | 开机自启 IPC / 系统偏好写入无测试；macOS `setLoginItemSettings` 失败分支、可执行路径变化、沙箱签名变化时行为不可回归。`src/main/app-context.ts` 同样无测试。 | confirmed | — | 用 electron 主进程单测（或 node 环境 fake `app.setLoginItemSettings`）覆盖 enable/disable/isEnabled 三态。 | S |
| R-14 | P1 | 测试 | `tests/behavior-director.test.ts:905,971,1009` | 3 个 `it.skip('爬窗沿…')` 与 climb 禁用同份快照引入；`work/tmp/review-w2vrm/behavior/REPORT-behavior.md:48` 已标"死代码 + README 矛盾"，绿测显示 "3 skipped" 掩盖未收口的迁移债。 | confirmed | — | 二选一：删除 climb 实现 + 这 3 个测试 + README 行；或恢复测试并让 debug trigger 与 `activities.ts:189` 注释一致。 | S |

### P2（21 条）

| ID | 严重度 | 模块 | 位置 | 风险描述 | 证据 | 联网核实 | 修复建议 | 工作量 |
|---|---|---|---|---|---|---|---|---|
| R-15 | P2 | 渲染 | `src/renderer/src/main.ts:1137`（RAF 链）；全文件无 `visibilitychange` | RAF 链在 overlay 窗口 `setVisible(false)` 隐藏时是否自动暂停，代码层未处理。依赖 Electron `backgroundThrottling`（默认 true）。**联网核实**：默认 `backgroundThrottling: true` 时窗口隐藏/最小化/被遮挡，Chromium 会降 RAF 频率；但若有人误改 false，VRM 每帧 `humanoid.update()`/foot-lock IK 会空跑 GPU。 | inferred | Electron BrowserWindow 文档：`backgroundThrottling` 默认 true；若 false 则窗口隐藏时 visibility 仍为 visible（https://www.electronjs.org/docs/latest/api/browser-window ；https://dev.to/mp3sss31/electron-performance-playbook-diagnose-slow-startup-and-fix-runtime-jank-5ao4 ） | 在 `frame()` 开头检查 `document.hidden` 或主进程上报的 visible 状态，不可见时跳过 `scene.step()` 但保留 rAF 续约定。 | S |
| R-16 | P2 | 渲染 | `src/renderer/src/main.ts:1338`（resize listener）；`:1194`（500ms 兜底） | resize handler 无 debounce。内部有 `sizeChanged` 短路，但窗口边缘拖拽连续 resize 时会连续 `requestGeometryRefresh()` → IPC 往返主进程。叠加 500ms 兜底，resize 风暴期 IPC 频率偏高。 | confirmed | — | 加 100–150ms debounce，或在 `requestGeometryRefresh` 侧加 leading-edge 去抖。 | S |
| R-17 | P2 | 渲染 | `src/renderer/src/main.ts:1164-1167`；`src/renderer/src/vrm/pet-scene-vrm.ts:648-655` | 每帧 spread 分配新对象（`lastInteractionSnapshot = {...getSnapshot(), lookTarget}`；`pendingAnimationInput = {...pending, dt, petRect: {...rect}}`）。60fps 下小对象恒定分配。 | confirmed | — | 复用闭包对象直接写字段。收益小。 | S |
| R-18 | P2 | 渲染 | `src/renderer/src/animation/index.ts`（全量 re-export）；`src/renderer/src/main.ts:37`（静态 import `createHybridAnimator`） | legacy 目录"活 import、死运行"：main.ts:37 静态 import → 整个 `animation/index.ts` → legacy 模块图进 bundle；实际只在 `config.animBackend === 'legacy-pmx'` 分支（main.ts:425 附近）才实例化，默认 `vrm`。grep 全仓无其它文件 import legacy 内部模块。Vite/Rollup tree-shaking 是否抖掉未使用 re-export 不确定。 | confirmed（grep 反查） | — | 把 main.ts:37 改动态 `import('./animation').then(m => m.createHybridAnimator)` 仅在 legacy-pmx 分支加载；或加注释说明 legacy 体积成本。 | S |
| R-19 | P2 | 渲染 | `src/renderer/src/vrm/avatar-loader.ts:167`（`new GLTFLoader(manager)`）；全仓无 `THREE.Cache.clear()` | GLTFLoader 内部 TextureLoader 走 `THREE.Cache` 单例。当前只加载一次 VRM + 一次 prop，缓存命中正确；但 R-01/R-02 修复后若支持 avatar 热切换，同名 URL GLB 会命中旧纹理缓存。 | inferred（依赖 R-01 未来场景） | three.js 文档：Cache 按 url 做 key | 热切换 avatar 时 dispose 后调 `THREE.Cache.clear()`，或给 GLTFLoader 传独立 LoadingManager。 | S |
| R-20 | P2 | 渲染 | `src/renderer/src/vrm/clip-registry.ts:250`（`clipCache = new Map`）；`:483`（只增不清） | clip 缓存只增不减：每个 clip id 解析一次后永久驻留（Float64Array 轨道数据）。当前 catalog ~几十条，总量可控；`brokenIds` 同理只增。`dispose()`（line 578）会 clear 但从未被外部调用（同 R-02 模式）。 | confirmed | — | app 生命周期内可接受；未来 avatar 热切换导致 clip 集也变时，切换时 `clipRegistry.dispose()` + 重建。 | S |
| R-21 | P2 | IPC/preload | `src/preload/index.ts:58,60`（`moveWindow`/`notify`）；`src/shared/ipc.ts:32,34,79,81,117,119`；全仓 `ipcMain.handle` 11 处未注册这两个 channel | preload 把 `moveWindow(payload)`/`notify(title, body)` 暴露给 renderer，但 main 进程无 handler（`src/main/ipc/desktop.ts:13` 注释写明归 Wave3 C1/C3 未做）。renderer 一旦调用会 reject `No handler registered`。 | confirmed | — | 二选一：(a) 在对应 Wave 任务补 handler；(b) preload 里把这两个方法标 deprecated 或不暴露。 | S |
| R-22 | P2 | 主进程 | `src/main/index.ts:320-325`（`blockNavigation`） | 拒绝导航时把整段 URL `console.warn` 并写 `appLogger`（main.log，1MB 轮转）。若 renderer 被 XSS/异常逻辑导航到 `https://evil.example/?sessionToken=...`，完整 URL（含 query）持久化到用户磁盘日志。 | confirmed | — | 日志只记 origin/host，不记完整 URL；或 query string mask。 | S |
| R-23 | P2 | 主进程 | `src/main/index.ts:333-337`（`hardenSession` 只调权限 handler） | 无 `session.webRequest.onBeforeRequest`/`onHeadersReceived` 限制 renderer 出站，也无 session 层强制 CSP。renderer 侧 HTML meta CSP 是唯一网络出口防线；一旦 renderer 被注入或 meta CSP 被绕过，可向任意外网发请求。 | confirmed（main 侧无 webRequest；renderer HTML 是 inferred） | Electron session webRequest CSP hardening 是标准做法 | 在 `hardenSession` 加 `onHeadersReceived` 强制回写 CSP（与 renderer meta 对齐），按需 `onBeforeRequest` 只放行 `pet-asset://` + dev server origin。 | M |
| R-24 | P2 | IPC | `src/shared/bridge-schema.ts:80-86`；`src/main/ipc/dsh.ts:42-46` | DSH 桥插件写入 `events.jsonl` 的 `payload` 内部字段（agent/turn/step/message/sessionId…）主进程不做 schema 校验就透传给所有 overlay renderer。桥插件侧已只挑安全标量写入，但读侧对 payload 形状零信任假设不足。 | confirmed（读侧不校验 payload 内部）；inferred（payload 大小已有 64KB 行长上限） | — | `parseDshEventLine` 或 `ipc/dsh.ts` 转发前对已知事件类型做最小 payload 字段白名单。 | S |
| R-25 | P2 | IPC | `src/main/ipc/window.ts:181-183` | `accessibilityStatus` 返回 `notifications: Notification.isSupported() ? 'unknown' : 'unsupported'`。`Notification.isSupported()` 在 macOS 恒 true，UI 永远看到 `'unknown'`，从未真正反映通知授权状态（应用 `Notification.getSettings()`）。功能 bug，非安全漏洞。 | confirmed | Electron `Notification.getSettings().permission` 是正解 | 改用 `Notification.getSettings().permission` 映射 granted/denied/unknown。 | S |
| R-26 | P2 | preload | `src/preload/index.ts:73-82` | contextIsolation 关闭时 fallback `window.api = petApi` 直接挂 window。两个 BrowserWindow 都硬编码 `contextIsolation:true`，fallback 实际不可达；但作为防御性代码，一旦未来误关 contextIsolation，preload 会**静默退化**为全局对象。 | confirmed | — | fallback 改 `console.error` 并抛错（或直接删 fallback），让误关在 dev 启动就炸出来。 | S |
| R-27 | P2 | 主进程 | `src/main/config-store.ts:102-122`（`writeConfigAtomically`） | config.json 若被同用户换成符号链接，`readFileSync` 会跟随、`renameSync` 会替换链接本身（作者已记录接受）。config 字段全是 UI 偏好（sizePercent/opacity/autonomous…），无 token/凭据。但 `writeFileSync` 未传 mode，默认 0644（macOS userData 目录默认 0700，故同机其它用户不可读，残余风险低）。 | confirmed（字段列表）；inferred（目录权限） | — | 写 config.json 时显式 `mode:0o600`；如需防御 symlink 开 `O_NOFOLLOW`。 | S |
| R-28 | P2 | 构建 | `scripts/build-native.mjs:129-135`（`resolveSwiftc`） | 用 `process.env['SWIFTC'] \|\| 'swiftc'` 走 PATH，未 hardcode `/usr/bin/swiftc`。但 `spawnSync(swiftc, ['--version'])` 不校验 PATH 解析出的绝对路径，若用户 PATH 前置恶意 `swiftc` 会被直接调用并参与签名。开发机本地风险。 | confirmed | — | 解析后 `fs.realpathSync(swiftc)`，要求路径在 `/usr/bin/`、Xcode.app 或 `$SWIFTC` 白名单内，不在就 die。 | S |
| R-29 | P2 | 原生 | `native/winlist/main.swift:155-160`（`CGWindowListCopyWindowInfo`） | 助手枚举窗口 bounds/pid/owner/layer/alpha/onScreen，**不读 `kCGWindowName`**——与 macOS TCC 规则一致（不读窗口名/截图确实不需要 Screen Recording 权限）。但一旦后续加 `kCGWindowName`，TCC 立刻弹框且未签名 app 会被拒。错误处理（`fail()` stderr JSON + exit 2）与坐标 Int32 钳制正确。 | confirmed | WWDC19 Advances in macOS Security：window name/sharing state 需要 Screen Recording 权限，bounds/position/windowID/owner pid 不需要（https://developer.apple.com/videos/play/wwdc2019/701/ ） | 在 C-01 的 entitlements 里加代码注释守卫：**任何对 `kCGWindowName` 的引用都必须同时改 entitlements + 公证流程**。 | S |
| R-30 | P2 | git | `native/winlist/.build/winlist`（112,584 B Mach-O）+ `native/winlist/.build/winlist.stamp` | 编译产物二进制被 git track：`.build/` 通常应 gitignore；多平台/多架构协作者机器会脏 diff，二进制随 clone 分发。 | confirmed | — | `.gitignore` 追加 `native/**/.build/`，`git rm --cached` 这两个文件；预编译 helper 改走 release asset。 | S |
| R-31 | P2 | 文档 | `README.md:146`；`README.md:48` | ① README 写 "101 files / 1736 passed"，当前 HEAD 顶层 `.test.ts` 已 112 个，数字过时；② README 写 "pnpm dev 当前默认 legacy-pmx 路径，直到 V1 切换"——但 Wave 1/V1、Wave 2/V5–V8 已完成，默认后端描述与现状脱节。 | confirmed | — | 跑一次 `pnpm test` 刷新数字；更新默认后端描述。 | S |
| R-32 | P2 | 测试 | `vitest.config.mts:11-21` | 无 `test.coverage` 配置、无阈值；`tests/setup.ts` 空文件；`environment: 'node'` 意味着 renderer 侧 DOM/WebGL 路径无任何集成测试兜底（avatar-loader 这类需 fetch+GLTFLoader 真实解码的模块只能测纯函数层）。 | confirmed | — | 至少加 `test.coverage.provider='v8'` + 行/分支阈值（先宽松）；renderer 重 DOM 模块后续切 `environment: 'happy-dom'` 或 jsdom。 | M |
| R-33 | P2 | 文档 | `docs/`（45 个 md，0 个匹配 安全/权限/TCC/打包/known-issue） | 仓库完全没有"安全/权限/TCC/打包/已知问题"主题文档；PLAN.md Wave 3 V9 含"打包 .app 仅本机使用；权限引导回归"，但 Wave 3 未开始、无 TCC 申请与失败指引文档。与 R-07 同源。 | confirmed | — | Wave 3 V9 落地时同步补 `docs/packaging.md`、`docs/known-issues.md`，列出 macOS TCC 权限清单与降级路径。 | M |
| R-34 | P2 | 测试 | `src/main/ipc/settings.ts`（32 行） | settings handler 仅被 `tests/fix-f1-settings-broadcast.test.ts` 间接覆盖，无独立用例；写盘 + 广播失败分支未直接断言。 | inferred | — | 补 settings-ipc 单测：写盘成功/失败、广播 payload 形状、默认值兜底。 | S |

### 已核查无问题（记录在案）

- 两个 BrowserWindow 都硬编码 `sandbox:true + contextIsolation:true + nodeIntegration:false`，未触碰 `webSecurity`/`allowRunningInsecureContent`/`webviewTag`（`overlay-manager.ts:221-228`、`settings-window.ts:141-147`）。
- `setWindowOpenHandler(() => ({action:'deny'}))` 两个窗口都挂了；`will-navigate`/`will-redirect` 硬拒（dev 只放行 dev server 同源）。
- `shell.openExternal` 全仓仅 1 处（`ipc/window.ts:187`），URL 硬编码常量 `x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility`，无 renderer 可控参数。
- `session.defaultSession` 权限请求/检查 handler 全拒。
- `pet-asset://` 协议做了 host 白名单 + 逐段 decode 拒绝 `..`/`\`/`:`/NUL + `realpath` 二次根内校验 + `O_NOFOLLOW` fd 读（`protocol.ts:189-220`、`protocol-path.ts:49-163`），TOCTOU 已缓解。
- `PET_PROFILE` userData 隔离有正则白名单 `/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/`。
- `config-store` 原子写（tmp+rename）、`sanitizeConfig` 严格校验、未知键丢弃。
- `winlist` spawn 无 shell、参数硬编码 `['--json']`、2s SIGKILL、stdout 4MB 上限、promise 永不 reject。
- `dsh-watch` 按字节偏移增量读、单行长 64KB、单次 256KB、启动以 EOF 为基线不回放历史、事件类型白名单。
- bridge 插件写文件 `mode:0o600`、目录 `mode:0o700`；bridge 包 `private:true`、`files` 白名单精确、无 install 脚本。
- shell 脚本普遍 `set -euo pipefail` + 全引号引用，无 `eval`/`curl|bash`；`print-profile.sh`/`profile-lib.sh`/`worktree-setup.sh` 已审通过。
- `sharp`/`mmd-parser` 仅在 `scripts/`/`tests/`/`assets/icons/generate.mjs` 用，**不进 main/renderer bundle**（sharp 是原生模块不能跑浏览器，风险解除）。
- `postinstall=install-electron` 是 electron 官方 CLI，未被改。
- **凭据扫描**：`work/`/`docs/`/`bridge/`/`scripts/` 文本类文件扫 `sk-`/`AKIA`/`Bearer `/`-----BEGIN PRIVATE KEY-----`/`sessionid`/邮箱/手机号——0 真实命中；唯一字面量 `scripts/dsh-canary.mjs:315` 的 `dsh-canary-invalid-key` 是 canary 测试**故意**写入的无效占位 key；6 处 11 位手机号正则命中是 `work/finger-probe/out/unity/zome-rest.json` 里骨骼浮点数组子串误报，且该文件未被 git track。
- `.gitignore` 干净：`work/`/`assets/vrm/`/`.env`/`.vrm`/`.pmx`/`.zip`/`.log`/`.key`/`.pem` 全部 0 track；仓库 tracked 文件 516 个，无 >5MB 模型/二进制误提交。
- BubbleView 单 DOM 节点复用 textContent、timer 在 destroy 里 clear；DesktopSensor 每次重建 Map 不存历史；InteractionController attach/detach/destroy 闭环；IPC 4 个 unsubscribe 在 shutdown 统一调用。
- `refs/`（Mate-Engine AGPL / reze-rig MIT / dsh-blender-plugin）已被 .gitignore 排除，scripts/src 无 import 指向。

## 3. 分块小结

### 块 A（主进程 / IPC / preload / 安全）— 11 条
- 安全基线扎实：sandbox+contextIsolation+nodeIntegration:false、setWindowOpenHandler 全拒、openExternal 硬编码、pet-asset:// 双重防穿越、config-store 原子写+严格 sanitize。
- 两个 P1：生产模式无 renderer/GPU 崩溃恢复（R-05）；dev 截图回环在打包版缺 `is.dev` 门禁（R-06，非 RCE 但同用户可借环境变量截屏+写盘+自退出）。
- 9 个 P2：两个 IPC channel 契约暴露但 main 无 handler、日志记完整 URL、session 层无 CSP/webRequest 兜底、DshEvent payload 内部字段未白名单、Notification.isSupported 误报、preload fallback 静默退化、config.json 0644。
- 无 P0。

### 块 B（渲染 / three.js/VRM / 性能）— 15 条
- 核心问题：`VrmPetScene` 无 dispose 方法（R-01 P0），`animator.dispose()`/`avatar.dispose()` 已实现但全仓无人调用（R-02 P1）——当前单窗进程退出靠 OS 回收，热切换/热重载场景会泄漏。
- foot-lock.ts 在 idle 时每脚每帧 ~15-20 个临时 Vector3/Quaternion 未复用（R-03 P1）；prop-layer dispose 漏 traverse dispose prop GLB（R-04 P1）。
- RAF 后台空跑（R-15）经联网核实：Electron `backgroundThrottling` 默认 true，窗口隐藏会节流，已从 P1 降为 P2。
- 事件解绑、bubble DOM、sensor Map、IPC unsubscribe 均闭环无泄漏。
- legacy 目录是"活 import、死运行"——main.ts:37 静态引用导致整链进 bundle（R-18），建议改动态 import。

### 块 C（原生模块 / 构建脚本 / 依赖）— 16 条
- 最关键四条 P1：①全仓无 electron-builder 配置、无公证/entitlements（R-07）；②winlist 只编 arm64 thin binary 且 stamp 不含 arch（R-08）；③`install-blender.sh` 下载 Blender DMG/MMD Tools zip 未 pin sha256 还主动 `xattr -dr com.apple.quarantine`（R-09）；④`run-export.sh:106` `rm -rf "$PROJECT"` 接受任意环境变量路径无白名单（R-10）。
- 生产资源断链（R-11）：`.gitignore` 排除 assets/model/ 但无 prepare 钩子，干净 clone 必白屏。
- `postinstall=install-electron` 未被改、sharp/mmd-parser 仅构建期用不进 runtime bundle、shell 脚本普遍 `set -euo pipefail` + 全引号引用、路径遍历已防护。
- 依赖版本整体很新（lockfile 实锁 electron 44.10.2 / chromium 152.0.7977.169，2026-11-04 发布，是 44 分支最新补丁；package.json spec `^44.7.2` 允许 patch 升级），未发现 lodash@3/minimist<1.2.6/cross-spawn<7.0.5 等老传递依赖。

### 块 D（测试 / work 卫生 / 凭据 / docs）— 10 条
- 122 个测试，IPC/config-store/winlist/dsh-watch/clip-player/animator 均有专门测试；主要真空：avatar-loader 加载与 dispose（R-12）、login-item（R-13）、app-context。
- 3 个 `it.skip` 在 behavior-director.test.ts:905/971/1009（climb 死代码，R-14）。
- 凭据扫描零真实命中；.gitignore 干净；唯一漏网是 `native/winlist/.build/winlist` Mach-O 二进制被 track（R-30）。
- README "101 files/1736 passed" 与 legacy-pmx 默认描述均已过时（R-31）；docs/ 缺安全/权限/TCC/打包专门文档（R-33，与 R-07 同源）。

## 4. 责任闭合卡（跨进程/跨模块强主张）

| 对象/范围 | 触发者 | 当前装配 | 实际执行者 | 成功副作用 | 失败是否被检查 | 不能覆盖的对象 | status |
|---|---|---|---|---|---|---|---|
| `pet:set-config` → 开机自启 | renderer `window.api.setConfig` | `ipc/config.ts:88-99` handler | `toConfigPartial` → `sanitizeConfig` → 原子写 `userData/config.json`；`launchAtLogin` 变化时 `login-item.ts:30-47` 调 `app.setLoginItemSettings` | broadcast `configChanged` | fs 写失败只 warn 不阻塞；launchAtLogin 失败不阻塞配置保存 | 不写系统其它位置、不发网络、不 spawn | **closed** |
| preload 暴露面 | 加载 `out/preload/index.js` | 两个窗口硬编码 `contextIsolation:true` | `contextBridge.exposeInMainWorld('api', petApi)`，14 invoke + 4 subscribe 白名单 | 不暴露 ipcRenderer 原始对象/process.env | N/A | renderer 想调未在 IPC 表里的 channel 必须绕过 preload（做不到） | **closed** |
| `pet-asset://` 读文件 | renderer 请求 GLB/贴图 | `protocol.ts:252-294` | host 白名单 → path 逐段 decode 拒绝 `..`/`\`/`:`/NUL → realpath 二次根内校验 → O_NOFOLLOW fd 读 | 固定 AORS:* + Cache-Control:no-cache | ENOENT→404、根外→403/404、fs 错→500 | 不写文件、不执行代码、不 openExternal | **closed**（同用户对父目录并发替换是作者已接受残余风险） |
| winlist 子进程 | 主进程 250ms 定时器 | `desktop.ts:140` | `winlist.ts:198-284` spawn `binPath --json` | binPath 来自 `defaultWinlistPath()`，不读 env/配置；stdout 4MB kill；2s SIGKILL | promise 永不 reject，错误记 `lastError()` 保留旧缓存 | 无 untrusted 字符串进 shell | **closed** |
| VRM GPU 资源释放 | beforeunload / 未来 avatar 热切换 | `avatar-loader.ts:740` 定义 dispose 内部调 `VRMUtils.deepDispose` | **无人调用**（grep 全仓无 `vrmAvatar.dispose()` 调用点） | 无 | N/A | 当前依赖 OS 进程退出回收；热重载/多窗共享 renderer 时不释放 | **未闭合 / 代码已写但未接线**（R-02） |
| WebGLRenderer 上下文销毁 | 窗口关闭 | `pet-scene-vrm.ts` 无 `dispose()` 方法 | **无** | 无 | N/A | 同上 | **未闭合**（R-01） |
| RAF 链自动停止 | 窗口隐藏/关闭 | main.ts:1203 `finally { if (scene) startRenderLoop() }` 无条件续约定 | Chromium `backgroundThrottling:true`（外部行为，非本仓代码） | 窗口隐藏后 RAF 被 Chromium 节流（默认 true） | N/A | overlay 窗 `backgroundThrottling` 由 BrowserWindow 配置决定，代码层未显式处理 | **mostly closed（依赖 Electron 默认；建议加 visibilitychange 短路，R-15）** |
| Clip 切换时旧 AnimationClip 释放 | clip-player beginClip | `clip-player.ts:1211` 重建 Map/数组 | GC 自动回收 JS 侧；AnimationClip 本身不含 GPU 资源（纯轨道数据） | 旧 clip Float64Array 在 `clipCache` 常驻（R-20） | N/A | VRM 主模型骨架不依赖 AnimationClip 生命周期 | **closed（无需手动 dispose）** |

## 5. 未决问题（静态读不出来，需跑起来复现）

1. **R-05 崩溃频率**：WebGL renderer 在 macOS 崩溃后 Electron 是否自动恢复？需真机 `chrome://gpucrash` 或 SIGTERM renderer 复现，看透明窗变白还是自动重绘。
2. **R-06 真实可达性**：打包版 `.app` 在用户日常是否真的会被设置 `PET_DEV_CAPTURE_DIR`？需打包产物 `PET_DEV_CAPTURE_DIR=/tmp/foo open aventurine-pet.app` 实测。
3. **R-15 RAF 后台空跑量级**：macOS 上 `setVisible(false)` 隐藏 overlay 后，用 Chrome DevTools Performance 录 10s 看 FPS 是否跌到 0/1fps/仍 60fps。联网已确认 `backgroundThrottling` 默认 true，但桌宠 overlay 的实际节流行为需实测。
4. **R-03 foot-lock 分配实测**：idle 状态 Chrome DevTools Memory allocation sampler 录 10s，量化每秒 GC 次数与临时对象数。代码层已确认分配点，未测 pause 时长。
5. **R-01/R-02 实际影响**：当前单窗单 avatar 进程模型下用户视角完全不可见。只有当未来 (a) avatar 热切换、(b) renderer 进程复用 / `--in-process-gpu`、(c) 主进程重启 overlay 窗而 renderer 不退出 时才显现——需和产品确认 roadmap。
6. **R-18 legacy tree-shaking 实际效果**：`vite build` 后 bundle analyzer 确认 legacy 是否真进主 bundle。
7. **VRM 0.x vs 1.0 兼容路径**：`avatar-loader.ts` 用 `VRMUtils.createVrmFromLoadedBinary`（3.5.x API），仓库 manifest 只引用单一 .vrm，未测 VRM 0.x 兜底分支。需补 0.x 测试包复现加载错误路径。
8. **macOS 辅助功能权限**：桌宠需要 `CGWindowListCopyWindowInfo`（winlist）和 `setIgnoreMouseEvents`，打包版首次启动系统是否真弹授权？授权被拒后 winlist 返回空还是抛？需真机点拒后看 `cachedWindows` 是否永远 `[]`。
9. **`session.defaultSession` 在多 PET_PROFILE 下的隔离**：`applyDevProfile` 改了 userData 路径，但 `session.defaultSession` 是否真跟着换？dev 多 worktree 并行跑时 cookie/cache 是否串？（dev 场景，非生产问题。）
10. **`pet-asset://` 在 Gatekeeper 公证后的行为**：`registerSchemesAsPrivileged` 标了 `secure:true`，公证后 `pet-asset://` 加载本地 VRM 是否被 App Translocation 干扰？需打包公证后真机跑。
11. **R-09 sha256 期望值**：需 Lead 从官方 Blender release 页 / MMD Tools GitHub release 页核对后填进脚本，本报告不代填。
12. **最低 macOS 版本**：`build-native.mjs` 没有 `-target arm64-apple-macos12.0` 标志，若在 macOS 14+ 编的二进制分发到 macOS 12 老机器可能 dyld 报 `LC_VERSION_MIN_MACOSX` 不对。未实测。
13. **工作区脏状态**：15 个 M + 5 个 ?? 文件（`micro-motion.ts`、`idle-one-shot-fidget.ts`、对应测试、`docs/adv-action-add-plan.md` 等）未提交，本报告基于当前工作区；提交前需 Lead 确认这些 Wave 2.5 增量。

## 6. 修复优先级建议（给 Lead 的下一步）

| 优先级 | 条目 | 理由 |
|---|---|---|
| 立即（本周） | R-02、R-06、R-14、R-30 | 都是 S 工作量，低风险高收益：接线已有 dispose、封死 dev-capture 打包面、收口 climb 死代码、gitignore 掉编译产物 |
| 本迭代 | R-01、R-03、R-04、R-05、R-15 | P0/P1 性能与崩溃恢复闭环，桌宠长期运行的稳定性基础 |
| Wave 3 打包前必须 | R-07、R-08、R-11、R-33 | 分发硬阻塞：不解决 .app 出不了这台 Mac |
| 开发机卫生 | R-09、R-10、R-28 | 本机脚本安全加固，S 工作量 |
| 测试补强 | R-12、R-13、R-32、R-34 | 关键路径单测补齐，M/S 工作量 |
| 低优先 | R-16..R-27、R-29、R-31 | P2 打磨项，随日常迭代顺手改 |

---

**审查方式说明**：4 个 subagent 并行只读（Read/Grep/Glob/Bash 只读命令），未修改任何源码、配置、package.json、lockfile；联网核实集中在汇总层，覆盖 Electron 44 发行说明、three.js cleanup 手册、@pixiv/three-vrm migration guide、Electron render-process-gone 文档、electron-builder notarization 文档、WWDC19 TCC 演讲、sharp/mmd-parser npm 页面。所有 URL 已附在对应行。
