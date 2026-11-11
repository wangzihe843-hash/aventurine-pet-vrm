# Wave 3 / V9 打包链路交付报告（A5 packaging）

> 日期：2026-11-11 02:2x（+08:00） · 任务：`task-10` A5 V9 打包 · 执行者：packaging-worker
> 工作区：`/Volumes/4TB外置盘/deepseek-harness/aventurine-pet-vrm`（HEAD `3893943` + 其他 worker 的未提交改动）
> 依据：[docs/wave3-dsh-integration-design.md](wave3-dsh-integration-design.md) §9.1、[docs/packaging.md](packaging.md)、R1 审计报告 §5
> 性质：本任务只改打包相关文件（见下"改动清单"）；**不改 package.json、不改 out/、不签名/不公证、不改 Gatekeeper、不 git commit、不碰真实 DSH/~/.dsh**。
> 结论：**打包管线已跑通**——本机产出未签名 `dist/mac-arm64/AventurinePet.app`，`scripts/package-check.mjs` **PASS（35 passed / 1 warning / 0 failed）**；二进制可加载探针通过；GUI 实机启动验收按设计 §13.5 留给 Lead 的隔离 E2E。

---

## 1. 交付物清单

| # | 文件 | 状态 | 说明 |
|---|---|---|---|
| 1 | `electron-builder.yml` | ✅ 新增 | appId `com.aventurine.pet`、productName `AventurinePet`、`dist` 输出、`files: out/** + package.json`、`electronDist: node_modules/electron/dist`、`npmRebuild: false`、`mac.target: dir`、`identity: null`、`hardenedRuntime: false`、`notarize: false`、entitlements 占位、`minimumSystemVersion: 13.0`、`category: public.app-category.entertainment`、`extraResources` 7 条映射 |
| 2 | `build/entitlements.mac.plist` | ✅ 新增 | 签名/公证占位：`allow-jit` / `allow-unsigned-executable-memory` / `disable-library-validation`；**无 TCC key**（当前不需要） |
| 3 | `scripts/package-check.mjs` | ✅ 新增 | 未签名 `.app` 静态校验 CLI：bundle 结构 / Info.plist / 可执行架构 / app.asar 入口与运行时依赖 / helper universal+minos / `Resources/model`（PMX+贴图）/ `Resources/assets`（图标+私有资产+40 clips）/ 签名状态（仅 info）。支持 `--app`、`--json`、`--skip-private-assets`、`--help`；退出码 0/1/2。只读，不启动 GUI。 |
| 4 | `docs/packaging.md` | ✅ 更新 | 现状（已实现/未实现/签名缺失）、命令、验收、TCC、未签名限制、资源路径对照、体积/图标/隔离等已知限制 |
| 5 | `docs/wave3-packaging-report-2026-11-11.md` | ✅ 新增 | 本报告 |

**未改动**：`package.json`、`pnpm-lock.yaml`、`out/**`、`src/**`、`tests/**`、桥目录/真实 `~/.dsh`。产物 `dist/` 已被 `.gitignore:3` 忽略（实测 `git check-ignore` 命中）。

---

## 2. 构建结果（本机实测）

### 2.1 构建命令与日志要点

```bash
cd /Volumes/4TB外置盘/deepseek-harness/aventurine-pet-vrm
CSC_IDENTITY_AUTO_DISCOVERY=false pnpm exec electron-builder --mac dir --publish never
```

关键日志（首次构建）：

```
• electron-builder  version=26.18.0 os=27.2.0
• loaded configuration  file=.../electron-builder.yml
• author is missed in the package.json  appPackageFile=.../package.json        ← 仅 warning（见 §5）
• skipped dependencies rebuild  reason=npmRebuild is set to false
• packaging       platform=darwin arch=arm64 electron=44.10.2 appOutDir=dist/mac-arm64
• using custom unpacked Electron distribution  electronDist=node_modules/electron/dist
• copying unpacked Electron  source=.../node_modules/electron/dist/Electron.app destination=.../dist/mac-arm64/Electron.app
• searching for node modules  pm=pnpm searchDir=.../aventurine-pet-vrm
• default Electron icon is used  reason=application icon is not set              ← 已知待办（§5）
• skipped macOS code signing  reason=identity explicitly is set to null          ← 预期：未签名
```

二次重跑实测 **2.1s**（`real 2.10`；文件系统 clonefile 加速，非完整冷拷贝；不含 `pnpm build`）。**注意**：本次使用的
`out/` 是集成前的生产构建（mtime 2026-11-11 01:13，R1 审计基线），仅用于验证打包管线——
Wave 3 功能改动合入后必须由 Lead/收口窗口重新 `pnpm build` + `--mac dir` 产出正式自用包。

### 2.2 产物

| 项 | 值 |
|---|---|
| 产物路径 | **`dist/mac-arm64/AventurinePet.app`**（arm64；Intel 构建目录会是 `dist/mac/`） |
| 总大小 | **601 MB**（Frameworks 317 MB + Resources 284 MB + MacOS 36 KB） |
| bundle id / 产品名 | `com.aventurine.pet` / `AventurinePet`（Info.plist 实测） |
| 版本 / 最低系统 | `CFBundleShortVersionString 0.1.0` / `LSMinimumSystemVersion 13.0` |
| 分类 / 高分辨率 | `LSApplicationCategoryType=public.app-category.entertainment` / `NSHighResolutionCapable=true` |
| 主可执行 | `Contents/MacOS/AventurinePet` 33,968 B，thin `arm64`，`minos 13.0` |
| app.asar | `Contents/Resources/app.asar` 2,809,893 B；16 entries（`out/main` / `out/preload` / renderer 3 JS chunk + 2 html / `package.json` / `@electron-toolkit/utils`） |
| Resources 明细 | `assets` 265 MB（vrm 137 MB / motions 118 MB / expressions 7.2 MB / props 3.1 MB / icons 156 KB）、`model` 15 MB（PMX+20 贴图）、`native` 256 KB、`default_app.asar` 128 KB（Electron dist 残留）、`electron.icns` 320 KB |
| helper | `Contents/Resources/native/winlist/winlist` 210,880 B，`lipo -archs` = **x86_64 arm64**，每 slice `minos 13.0` |
| 签名 | **未签名**（electron-builder identity:null 跳过 codesign；主二进制保留 Electron dist 自带 `adhoc,linker-signed`，`Info.plist=not bound`、`Sealed Resources=none`） |

### 2.3 package-check 输出（实跑）

```
[package-check] .../dist/mac-arm64/AventurinePet.app
  PASS  bundle 存在 / Contents/Info.plist / Contents/Resources/app.asar
  PASS  CFBundleIdentifier = com.aventurine.pet
  PASS  CFBundleExecutable = AventurinePet / CFBundleName = AventurinePet
  PASS  LSMinimumSystemVersion = 13.0
  PASS  主可执行 存在且可执行 / 架构 arm64 / minos 13.0
  PASS  app.asar 可解析（16 entries）
  PASS  app.asar 包含 out/main/index.js、out/preload/index.js、out/renderer/index.html、out/renderer/settings.html、package.json
  PASS  app.asar/package.json main = ./out/main/index.js
  PASS  app.asar 含运行时生产依赖 @electron-toolkit/utils
  PASS  app.asar 含 3 个 renderer JS chunk / 设置窗入口
  PASS  native/winlist/winlist universal（x86_64+arm64）/ minos 13.0
  PASS  Resources/model 含 PMX：星穹铁道—砂金·戏浪.pmx + 20 张优化贴图
  PASS  Resources/assets/icons/trayTemplate.png
  PASS  Resources/assets 含默认 VRM（assets/vrm/aventurine-tpose.vrm）/ app-manifest / app-catalog / expressions manifest
  PASS  app-manifest.json 含 40 条 clip（VRM 动画可播放）
  PASS  签名状态：adhoc/未签名（identity: null，符合本机自用目标）
  WARN  未配置应用图标（.icns），使用 Electron 默认图标
[package-check] PASS —— 35 passed / 1 warnings / 0 failed     (exit 0)
```

`--json` 摘要：`{"ok":true,"passes":35,"warnings":1,"failures":0,"bundleId":"com.aventurine.pet","minimumSystemVersion":"13.0"}`

CLI 边界实测：缺 `.app` → exit 2；未知参数 → exit 2；`--help` 正常；`--skip-private-assets` 同样 PASS；
`--json` 输出可被 `JSON.parse`。

### 2.4 可执行加载探针（不开窗口）

```bash
ELECTRON_RUN_AS_NODE=1 dist/mac-arm64/AventurinePet.app/Contents/MacOS/AventurinePet -e \
  'console.log(JSON.stringify({electron:process.versions.electron,node:process.versions.node,chrome:process.versions.chrome,arch:process.arch}))'
# → {"electron":"44.10.2","node":"24.22.2","chrome":"152.0.7977.169","arch":"arm64"}   exit=0
```

证明：打包后的主二进制 + Electron Framework 可被内核加载（ad-hoc 签名足够本机执行），不是"文件存在但跑不起来"。
**GUI 启动/透明 overlay/点击穿透/托盘/设置窗/资源加载的实机验收**留给 Lead 的隔离 E2E
（设计 §13.5），本任务未 `open` `.app`、未产生真实桌宠窗口。

---

## 3. 与运行时路径契约的对照（关键验收点）

| 运行时消费方 | 代码常量（基线 `3893943`） | 打包目标 | 实测 |
|---|---|---|---|
| winlist helper | `src/main/desktop/winlist.ts:167-179` → `<resourcesPath>/native/winlist/winlist` | `Contents/Resources/native/winlist/winlist` | ✅ |
| PMX 回退模型 | `src/main/protocol.ts:113-125` → `Resources/model`（兼容 `optimized/`） | `Contents/Resources/model/` | ✅ PMX+20 贴图 |
| 私有资产/托盘 | `src/main/protocol.ts:127-140` → `Resources/assets`；`src/main/tray.ts:78-86` | `Contents/Resources/assets/**` | ✅ |
| VRM 默认头像 | `src/shared/vrm-manifest.json` → `defaultAvatarId=aventurine-waveflair` → `vrm/aventurine-tpose.vrm` | `Resources/assets/vrm/aventurine-tpose.vrm` | ✅ |
| 动作清单 | `src/renderer/src/vrm/clip-registry.ts:1-16` → `assets/motions/app-manifest.json` | `Resources/assets/motions/app-manifest.json` | ✅ 40 clips |
| 设置窗入口 | `electron.vite.config.ts` 第二入口 settings.html | `app.asar/out/renderer/settings.html` | ✅ |

---

## 4. 需 Lead 添加的 scripts（本任务不动 package.json）

建议在 `package.json` 的 `scripts` 增加（不改现有 `build`/`smoke` 语义）：

```json
"package:dir": "pnpm build && pnpm exec electron-builder --mac dir --publish never",
"package:check": "node scripts/package-check.mjs",
"package:check:json": "node scripts/package-check.mjs --json"
```

可选补充（干净 clone / CI 管线验证，不参与默认构建）：

```json
"package:dir:no-assets": "AVENTURINE_SKIP_ASSETS_CHECK=1 pnpm build && pnpm exec electron-builder --mac dir --publish never && node scripts/package-check.mjs --skip-private-assets"
```

建议同时：
1. `package.json` 补 `"author"`（electron-builder 会 warning；当前缺）；
2. `.gitignore` 处理 `build/`（见 §5 阻塞项 B-3）。

---

## 5. 阻塞项 / 风险 / 待办

### 5.1 阻塞与阻塞级风险

| # | 项 | 影响 | 建议 |
|---|---|---|---|
| B-1 | **未签名/未公证**（本机 0 codesigning identity；`identity: null`） | `.app` 仅本机自用；拷到其它 Mac / dmg 分发会被 Gatekeeper 拦截；TCC 身份不可验证 | 分发前需用户提供 Developer ID Application 证书；`mac.identity/hardenedRuntime/notarize` 按 `docs/packaging.md` §2.1 打开（本任务已把配置项/entitlements 骨架留好） |
| B-2 | **应用图标缺失**（`electron.icns` 默认图标） | Dock/Finder 图标是 Electron 默认图标；`package-check` 只 WARN | 需要 `.icns` 素材（用户/美术提供），`mac.icon` 指向即可；属 V9-5 |
| B-3 | **`build/` 被 `.gitignore:5` 忽略** | `build/entitlements.mac.plist` **不会**被 `git add`（`git check-ignore` 实测命中），Lead 统一提交时会静默漏掉，导致签名阶段缺 entitlements | Lead 二选一：`.gitignore` 加 `!build/entitlements.mac.plist`（推荐），或 `git add -f build/entitlements.mac.plist` |
| B-4 | **当前 `out/` 是集成前构建** | 本次 `.app` 不含 Wave 3 新功能；不可作为最终交付包 | 功能合入后 Lead 重新 `pnpm build` + `--mac dir`；本报告 §2 数据仅用于管线验证 |
| B-5 | **打包版 E2E 隔离方案未定** | `applyDevProfile()` 在打包版直接 return（`src/main/index.ts:421-432`）；`PET_PROFILE` 不能隔离打包版 userData，`HOME` 覆盖在 macOS 不保证改变 `app.getPath('userData')` | V 验证阶段确认 `--user-data-dir` 是否生效，或由 Lead 在 `src/main/index.ts` 加"打包版 E2E profile env"（Lead-only 文件） |

### 5.2 非阻塞风险 / 后续优化

- **体积 601 MB**：`Resources/assets/vrm` 137 MB 含 4 个完整 VRM + 1 个 `.zip`（23 MB）+ canary，当前运行只需
  `aventurine-tpose.vrm`（25 MB）；`vrm-manifest.json` 仍登记 canary 等资产，收窄映射属契约/产品决策（未擅自改）。
  可选优化：`extraResources` 用 `filter` 排除 `*.zip`；或按 manifest 精确映射（需 Lead 决定）。
- **`default_app.asar` / `electron.icns`** 是 Electron dist 自带残留（无功能影响）；如需干净产物可在 `afterPack` 删除（未做）。
- **`author` 缺失**产生 electron-builder warning；补 package.json 即可。
- **arm64-only**：`dist/mac-arm64/`；DSH 桥激活配置里的 `petAppPath` 必须用实际路径（若在 Intel 上构建是 `dist/mac/`）。
- **无 dmg/zip/updater**：分发/自动更新未实现（PLAN V9 只要求本机自用，登记为后续）。
- **未验证**：GUI 启动、透明 overlay、点击穿透、helper spawn、资源实际加载、托盘、登录项、设置窗——
  全部需要 Lead 的隔离 E2E（设计 §13.5）+ 用户在场；本任务只交付"可产出 + 静态结构正确 + 可执行加载"。

### 5.3 复跑命令（完整）

```bash
cd /Volumes/4TB外置盘/deepseek-harness/aventurine-pet-vrm
# 前置：pnpm install（electron 44.10.2 + electron-builder 26.18.0 已装）
pnpm build                                                   # 生产构建 out/（私有资产检查；干净 clone 用 AVENTURINE_SKIP_ASSETS_CHECK=1）
CSC_IDENTITY_AUTO_DISCOVERY=false pnpm exec electron-builder --mac dir --publish never
node scripts/package-check.mjs                               # 期望 PASS（35 passed / 1 warning）
ELECTRON_RUN_AS_NODE=1 dist/mac-arm64/AventurinePet.app/Contents/MacOS/AventurinePet -e 'console.log(process.versions.electron)'  # 期望 44.10.2
# 清理：rm -rf dist
```

---

## 6. 结论

- **V9 打包链路骨架已完成并可复跑**：配置文件 + entitlements 占位 + 产物校验脚本 + 文档；
  `electron-builder --mac dir` 在本机产出未签名 `AventurinePet.app`，静态契约（bundle id/资源/helper）
  与 `scripts/package-check.mjs` 全部对齐；
- **剩余工作不在本任务范围**：正式签名/公证（需证书）、应用图标、dmg/zip 分发、打包版实机验收、
  以及"合入 Wave 3 功能后重新打包"（Lead 收口）；
- **无网络/资产/env 阻塞**：本次一次跑通（私有资产齐备；`electronDist` 复用本地 Electron 未触发下载）；
  唯一 warning 是应用图标缺失（已知 V9-5）。

---

> **后续更新（2026-11-11 12:33，Lead）**：本报告记录的是 V9 第一版「完全未签名」`--dir` 打包。
> 真机激活时发现无签名 app 会被 macOS 27 AMFI 拒绝（`no CMS blob? Unrecoverable CT signature issue`），
> 已在打包管线加入 `afterPack` ad-hoc 签名钩子（`build/after-pack-adhoc-sign.cjs`，见
> `docs/packaging.md` §2.6）；当前产物 `dist/mac-arm64/AventurinePet.app` 为 ad-hoc 签名版，
> `package-check` 35 passed / 1 warning（图标缺失）/ 0 failed。本报告其余数据（资源映射/体积/helper）
> 仍有效。
