# 打包（macOS `.app`）现状与前置清单

> 更新：2026-11-11（Wave 3 / V9 打包骨架已落地；交付报告见 [wave3-packaging-report-2026-11-11.md](wave3-packaging-report-2026-11-11.md)；
> 验收矩阵/DSH 激活步骤见 [wave3-acceptance.md](wave3-acceptance.md)）
> 本文只记录**已核实**的现状。当前已能在本机用 electron-builder 产出 **ad-hoc 签名**的
> `AventurinePet.app`（macOS 27 AMFI 必需；见 §2.6）并通过静态校验（`scripts/package-check.mjs`）；
> 已用该 `.app` 完成真机 DSH HMR 激活（2026-11-11 12:33，见 [wave3-acceptance.md](wave3-acceptance.md) §2.3）。
> **仍不可分发**：无 Developer ID 签名/公证、无应用图标、无 dmg/zip；ad-hoc 只解决「本机 AMFI 拒绝未签名 app」问题。

## 1. 当前状态（2026-11-11 实测）

- **V9 打包链路已实现**（Wave 3 / A5）：
  - `electron-builder@26.18.0`（devDependency，Lead 已加入 `package.json`）；
  - `electron-builder.yml`（appId `com.aventurine.pet`、productName `AventurinePet`、`--mac dir`、
    `identity: null`（跳过 builder 的 Developer ID 签名）、`afterPack` → ad-hoc 签名钩子、
    `electronDist` 复用 `node_modules/electron/dist`、`extraResources` 映射）；
  - `build/after-pack-adhoc-sign.cjs`（electron-builder `afterPack` 钩子：对 `.app` 执行
    `codesign --force --deep --sign -`；**本机自用启动的必要条件**，见 §2.6）；
  - `build/entitlements.mac.plist`（正式 Developer ID 签名/公证占位，ad-hoc 阶段不生效）；
  - `scripts/package-check.mjs`（产物静态校验：bundle id / app.asar / helper 架构 / Resources 路径）；
  - `package.json` scripts：`package:dir`（build + `--mac dir`）、`package:check`（引导 package-check）。
- **本机实测产出**：`dist/mac-arm64/AventurinePet.app`（arm64，约 **601 MB**，**ad-hoc 签名**；
  Electron 44.10.2；`codesign -dv` 实测 `Signature=adhoc`、`flags=0x2(adhoc)`、
  `Identifier=com.aventurine.pet`、`Sealed Resources version=2 rules=13 files=290`）。
  该 `.app` 已被真机 DSH 激活使用（2026-11-11 12:33，桌宠由桥 direct-exec 拉起并进入 PAIRED）。
- **`scripts/package-check.mjs` 实测 PASS**（35 项通过 / 1 项 warning：缺应用图标）。
- **仍然缺失/未验证**：
  - **Developer ID 签名 + 公证未实现**：本机 `0 valid identities found`（2026-11-10 实测）；
    ad-hoc 签名**只够本机启动**，不是 Developer ID、不通过 Gatekeeper、不可分发；dmg/zip/notarize 未启用。
  - **应用图标 .icns 未提供**：当前回退 Electron 默认图标（`electron.icns`）。
  - ~~打包版行为未实机验收~~ → **已由 verifier E2E ④ 覆盖**（资源/VRM/overlay/气泡/winlist/单实例，
    23/23 PASS，证据 `tests/tmp/wave3-e2e/2026-11-10T18-47-15-666Z-packaged/`）；登录项在 dist 运行时
    仍有 `Operation not permitted`（默认关闭、无用户影响，见 §4）。
  - **dmg + zip 分发包**：未配置。
  - 打包产物 `dist/` 已被 `.gitignore` 忽略，不随仓库提交。
- **两条验证路径**：
  1. 未打包生产构建：`pnpm smoke:file`（`pnpm build && electron .`；不是 `.app`，不经过 Gatekeeper/签名）；
  2. 已打包（ad-hoc 签名）`.app`：`pnpm package:dir`（内部已含 `package-check`；等价于
     `pnpm build && pnpm exec electron-builder --mac dir --publish never && node scripts/package-check.mjs`）。

## 2. 打包前置清单

### 2.1 electron-builder 配置（`electron-builder.yml`）

| 项 | 当前实现（已验证） | 正式分发前要求 |
|---|---|---|
| `appId` / `productName` | `com.aventurine.pet` / `AventurinePet` ✅（Info.plist 实测一致） | bundle id 一旦分发不要变更 |
| `directories.output` | `dist` ✅ | — |
| `files` | `out/**` + `package.json` ✅（生产依赖由 electron-builder 按 dependencies 自动收集；实测 `@electron-toolkit/utils` 进 app.asar） | — |
| `electronDist` / `npmRebuild` | `node_modules/electron/dist`（避免打包时下载 Electron）/ `npmRebuild: false` ✅ | — |
| `mac.category` | `public.app-category.entertainment` ✅（Info.plist 实测） | 按产品定位确认 |
| `mac.target` | `dir`（本机自用）✅ | 分发加 `dmg` + `zip` |
| `mac.identity` | `null`（跳过 builder 签名；由 afterPack 做 **ad-hoc**）✅ | Developer ID Application 证书 |
| `afterPack` | `build/after-pack-adhoc-sign.cjs`（`codesign --force --deep --sign -`）✅ | 正式签名时**移除**该钩子，避免 ad-hoc 覆盖 Developer ID 签名 |
| `mac.hardenedRuntime` | `false` ✅ | `true`（公证前提） |
| `mac.notarize` | `false` ✅ | `true`，凭据走环境变量/keychain profile，**不写入仓库** |
| `mac.entitlements` / `entitlementsInherit` | `build/entitlements.mac.plist`（占位：allow-jit/unsigned-executable-memory/disable-library-validation，与 TCC 无关；**ad-hoc 阶段不生效**）✅ | 正式签名时复核；TCC 能力不能靠 entitlements 获得 |
| `extendInfo.LSMinimumSystemVersion` / `mac.minimumSystemVersion` | `"13.0"` ✅（Info.plist 实测 13.0） | 与目标 macOS 最低版本一致 |
| 应用图标（`.icns`） | ❌ 未提供（默认 Electron 图标） | 提供 `.icns` 并 `mac.icon` 指过去 |
| `package.json author` | ❌ 缺失（electron-builder 仅 warning） | 建议 Lead 补 `author`，消除打包警告 |

签名/公证顺序（正式分发时）：先签 `native/winlist/winlist` 等嵌套可执行文件，再签 `.app`，最后公证 + staple。

### 2.2 extraResources（运行时路径已在代码里写死；改布局必须同步改代码与本文）

`electron-builder.yml` 的 `extraResources` 与 packaged 分支逐一对照（2026-11-11 实测产物）：

| `from`（仓库源） | `to`（`Contents/Resources/`） | 消费方（代码） | 实测 |
|---|---|---|---|
| `native/winlist/.build/winlist` | `native/winlist/winlist` | `src/main/desktop/winlist.ts:167-179` | ✅ 210,880B，universal arm64+x86_64，minos 13.0 |
| `assets/model/optimized/` | `model/` | `src/main/protocol.ts:113-125`（`getAssetRoots`） | ✅ 15 MB：PMX + 20 张贴图 |
| `assets/icons/` | `assets/icons/` | `src/main/tray.ts:78-86`（托盘图标回退） | ✅ 托盘 `trayTemplate.png` + @2x |
| `assets/vrm/` | `assets/vrm/` | `pet-asset://assets/**` + `src/shared/vrm-manifest.json` | ✅ 137 MB（含 canary/历史副本/zip，见 §4 体积） |
| `assets/motions/` | `assets/motions/` | `src/renderer/src/vrm/clip-registry.ts`（app-manifest/app-catalog） | ✅ 118 MB；app-manifest 40 clips |
| `assets/expressions/` | `assets/expressions/` | `src/renderer/src/vrm/expression-layer.ts` | ✅ 7.2 MB |
| `assets/props/` | `assets/props/` | `src/renderer/src/vrm/prop-config.ts`（水枪等） | ✅ 3.1 MB |

注意：

- **不要**把原始 `assets/model/` 整棵树打进包；只打包 `optimized/` 产物。
- 私有资产（`assets/{vrm,motions,expressions,props}`）**不进 git**；electron-builder 对缺失的
  `extraResources` 源**只 warn 不失败**（`app-builder-lib/fileMatcher` 行为），干净 clone 能构建出
  `.app` 但不可渲染。打包前必须先有资产，或用 `AVENTURINE_SKIP_ASSETS_CHECK=1 pnpm build` +
  `node scripts/package-check.mjs --skip-private-assets` 明确标注为"仅管线验证产物"。
- 私有资产版权红线：**打包产物仅限本机使用，不得分发**（README 红线）。
- `to` 路径必须与 `protocol.ts` / `winlist.ts` / `tray.ts` 常量一致；改布局要同步改代码与本文。

### 2.3 原生 helper（winlist）

- **必须 universal**：`arm64` + `x86_64`（Intel Mac 上 `Bad CPU type` 会让 `winlist.ts` 静默降级为空窗口列表）。
- **最低系统版本 ≤ 13.0**：每个架构 `-target <arch>-apple-macos13.0` 编译后 `lipo -create`。
- 实测（2026-11-11）：`lipo -archs` = `x86_64 arm64`；`vtool -show-build` 每个 slice `minos 13.0`。
- `scripts/build-native.mjs --check` 管"构建产物"校验；`scripts/package-check.mjs` 管"**打包进 .app 后**"的
  同一组校验（防止 extraResources 拷错/被 strip）。

### 2.4 构建前自动检查（未改动）

`pnpm build` 会经 `prebuild`（`scripts/prebuild.mjs`）自动执行：

1. `node scripts/build-native.mjs`（= `pnpm native:build`；幂等，产出 universal helper）；
2. `node scripts/prepare-assets.mjs --check`（= `pnpm assets:prepare --check`；只读重算 manifest 并校验
   `assets/model/optimized/`）。

干净 clone 没有私有资产时构建会失败并给出指引；仅构建、无需运行资产时可：

```bash
AVENTURINE_SKIP_ASSETS_CHECK=1 pnpm build
```

跳过校验只保证构建能过，不保证 app 能加载模型。

### 2.5 打包命令与验收

**命令**（`package.json` 已提供 `package:dir` / `package:check`）：

```bash
# 1) 生产构建 + ad-hoc 签名 .app（mac dir；不会联网下载 Electron；末尾自动跑 package-check）
pnpm package:dir
#    等价手工：pnpm build && pnpm exec electron-builder --mac dir --publish never && node scripts/package-check.mjs

# 2) 单独静态校验（bundle id / app.asar / Resources / helper 架构 / 签名状态）
pnpm package:check                        # PASS 时 exit 0（期望 35 passed / 1 warning / 0 failed）
node scripts/package-check.mjs --json     # 机器可读

# 干净 clone / 无私有资产的管线验证
AVENTURINE_SKIP_ASSETS_CHECK=1 pnpm build
pnpm exec electron-builder --mac dir --publish never
node scripts/package-check.mjs --skip-private-assets
```

**已验证（自动/半自动）**：

1. `pnpm package:dir` 成功产出 `dist/mac-arm64/AventurinePet.app`（arm64，**ad-hoc 签名**；
   09:50 重建版已用于真机 DSH 激活）；
2. `scripts/package-check.mjs` **PASS**：`CFBundleIdentifier=com.aventurine.pet`、
   `LSMinimumSystemVersion=13.0`、app.asar 含 `out/main/index.js` / preload / renderer（含 settings 入口）/
   `@electron-toolkit/utils`、helper universal+minos 13.0、`Resources/model`（PMX+20 贴图）、
   `Resources/assets`（图标/默认 VRM/动作清单 40 clips/表情）；
3. 可执行加载探针：`ELECTRON_RUN_AS_NODE=1 dist/mac-arm64/AventurinePet.app/Contents/MacOS/AventurinePet -e ...`
   → `electron 44.10.2 / node 24.22.2 / chrome 152 / arm64`（**不开窗口**，验证二进制与 Framework 可加载）；
4. `codesign -dv --verbose=2 dist/mac-arm64/AventurinePet.app` → `Signature=adhoc`、`Identifier=com.aventurine.pet`、
   `Sealed Resources version=2`；`codesign --verify --deep --strict` 通过（ad-hoc 范围内）；`spctl --assess` 仍会拒绝（预期）。

**已验证（verifier 隔离 E2E ④ packaged）**：`.app` 直接 exec 可启动（overlay/透明窗构造）、
VRM/动作/贴图从 `Resources/` 加载（model.loaded、missingTextures=[]）、`native/winlist/winlist` spawn 成功、
`.pet-bubble` 存在且可被桥事件驱动、第二实例被单实例锁合并立即退出（23/23 PASS）。
证据：`tests/tmp/wave3-e2e/2026-11-10T18-47-15-666Z-packaged/`。

**仍需实机/分发前验收**：

1. 托盘图标与设置窗（打包版）目视确认；开机自启开关在打包版真正写入登录项
   （dist 运行的 ad-hoc app 实测 `Operation not permitted`；默认 `launchAtLogin=false`，无用户可见影响）；
2. 分发前（需 Developer ID）：`codesign --verify --deep --strict`、`spctl --assess --type execute`、
   `stapler validate` 通过；
3. 在一台**未安装开发工具链**的 macOS 13+ 机器上冷启动验证（至少 arm64；有 Intel 机补 x86_64）——
   未签名/无公证的包不可用于该场景。

> 打包版启动隔离注意：`applyDevProfile()` 在打包版直接 return（`src/main/index.ts:421-432`），
> 因此 `PET_PROFILE` **不能**隔离打包版 userData；`HOME` 覆盖在 macOS 上也不保证改变
> `app.getPath('userData')`（系统 home 由用户账户决定）。打包版 E2E 隔离方案（`--user-data-dir` 是否生效、
> 或给打包版显式开一个 E2E profile env）需在 V 验证阶段确认——该改动属 `src/main/index.ts`（Lead-only）。

### 2.6 ad-hoc 签名（本机自用必需；2026-11-11 实机修正）

**为什么需要**：`identity: null` 时 electron-builder 完全跳过签名 → 产物是「no CMS blob」的裸 app。
macOS 27 的 **AMFI** 会拒绝 LaunchServices 启动这种 app（统一日志：
`AMFI: ... has no CMS blob? Unrecoverable CT signature issue, bailing out`），用户表现为「点了没反应/拉起即退」。
本机自用场景下 `codesign --sign -`（ad-hoc）即可通过 AMFI 启动。

**实现**：`electron-builder.yml` 的 `mac.afterPack: build/after-pack-adhoc-sign.cjs`，在 builder 完成打包后、
自带签名步骤之前执行 `codesign --force --deep --sign - <AventurinePet.app>`；`identity:null` 时 builder 不再
覆盖签名，因此 ad-hoc 签名保留。签名失败钩子会抛错让构建失败（避免产出「能构建不能启动」的包）。

**验证命令**：

```bash
codesign -dv --verbose=2 dist/mac-arm64/AventurinePet.app
#  期望：Identifier=com.aventurine.pet / Signature=adhoc / flags=0x2(adhoc) /
#        Sealed Resources version=2 rules=13 files=290
codesign --verify --deep --strict --verbose=2 dist/mac-arm64/AventurinePet.app   # ad-hoc 范围内通过
spctl --assess --type execute dist/mac-arm64/AventurinePet.app                    # 预期拒绝（ad-hoc 非 Developer ID）
```

**未签名 → ad-hoc 的差异**：

| 项 | 完全未签名（旧） | ad-hoc 签名（当前） |
|---|---|---|
| 本机 macOS 27 AMFI 启动 | ❌ 被拒绝（no CMS blob） | ✅ 可启动（本次真机激活/打包版 E2E 均通过） |
| Gatekeeper / 分发到其它 Mac | ❌ 拦截 | ❌ 仍拦截（ad-hoc 不是 Developer ID，未公证） |
| TCC/权限身份 | 无稳定签名身份 | 有 ad-hoc 身份，但**不用于申请 TCC 能力** |
| 可否对外分发 | 否 | **否**（仅本机自用） |

**将来启用 Developer ID 签名/公证时**：`mac.identity` 改为证书、`hardenedRuntime: true`、`notarize: true`，
并**删除 `afterPack` 钩子引用**（否则 ad-hoc 会覆盖正式签名）；entitlements 按 `build/entitlements.mac.plist` 复核。
签名/公证顺序：先签 `native/winlist/winlist` 等嵌套可执行文件，再签 `.app`，最后公证 + staple。

## 3. TCC / 系统权限

| 能力 | 是否必需 | 说明 |
|---|---|---|
| Screen Recording | **不需要**（当前实现） | `native/winlist/main.swift` 只读窗口 bounds/owner/pid/layer/alpha，不读 `kCGWindowName`；读窗口名/截图才需要该权限 |
| Accessibility（辅助功能） | **不需要**（核心链路） | 仅在设置面板查询信任状态（`systemPreferences.isTrustedAccessibilityClient(false)`，只查询不弹窗）并提供系统设置深链 |
| 通知 | 不需要 | 通知授权状态当前无法可靠查询；见 [known-issues.md](known-issues.md) |

**红线**：一旦在 `native/winlist` 里读取 `kCGWindowName`（或任何窗口标题/截图能力），必须同时：

1. 更新 entitlements 与 TCC 用途说明；
2. 重新走签名 + 公证；
3. 在设置面板补充授权引导与拒绝后的降级路径；
4. 同步更新本文与 [known-issues.md](known-issues.md)。

签名/公证本身不会自动获得 TCC 权限；需要权限的能力必须由用户在系统设置中显式授权。
`build/entitlements.mac.plist` 里**没有**任何 TCC 相关 key（当前也不需要）。

## 4. 已知限制

- **ad-hoc 签名 + 未公证**：只能本机自用；分发（dmg/zip、换机器）会被 Gatekeeper 拦截。
  ad-hoc（`codesign --sign -`）只解决「macOS 27 AMFI 拒绝无 CMS blob app」的启动问题，**不是** Developer ID；
  正式分发需要 Developer ID Application 证书 + hardenedRuntime + 公证（本机当前 0 身份）。
- **打包产物已被真机激活使用**：当前 `dist/mac-arm64/AventurinePet.app` 为 2026-11-11 **09:50** 重建版
  （`out/` 同为 09:50，含 Wave 3 DSH 集成/气泡代码），并作为 `petAppPath` 被桥 direct-exec 拉起
  （真机激活记录见 [wave3-acceptance.md](wave3-acceptance.md)）。再次修改源码后需重新 `pnpm package:dir`
  （移动/删除 dist 会使 DSH 激活配置失效）。
- **未配置应用图标**：使用 Electron 默认图标。
- **体积 601 MB**（未压缩）：Frameworks 317 MB + Resources 284 MB（assets 265 MB、model 15 MB、
  app.asar 2.7 MB）。其中 `Resources/assets/vrm` 137 MB 含历史副本与一个 `.zip`（当前运行只需
  `aventurine-tpose.vrm` 25 MB，但 `vrm-manifest.json` 还登记了 canary 等资产）；如需瘦身可后续
  把 `extraResources` 收窄为「按 manifest 精确映射文件」，属产品/契约决策（本文记录，不擅自改）。
- **产物是架构相关的**：本机 arm64 → `dist/mac-arm64/AventurinePet.app`；Intel 构建会是
  `dist/mac/`（x64）。下游（如 DSH 桥 `petAppPath`）必须使用实际路径。
- `build/` 目录的 gitignore 已由 Lead 修正（`.gitignore`：`build/*` + `!build/entitlements.mac.plist`），
  entitlements 可随仓库提交；其余 `build/` 产物仍被忽略。
- **DSH 激活依赖 `.app` 绝对路径**：桥 insert 行里的 `petAppPath` 指向 `dist/mac-arm64/AventurinePet.app`；
  移动/删除 `dist/` 会使激活失效（需重新激活或回滚），见 [wave3-acceptance.md](wave3-acceptance.md) §3。
- `Contents/Resources/default_app.asar` 与 `electron.icns` 是 Electron dist 自带残留（无功能影响）；
  如需干净产物可在 `afterPack` 里删除（当前未做）。
- **打包版登录项**：从 dist 运行 ad-hoc app 时 Electron 登录项 API 报
  `Operation not permitted`，而 `src/main/login-item.ts` 的 wrapper 仍记 `applied:true`（Electron API 未抛错）；
  当前默认 `launchAtLogin=false`，无用户可见影响；如未来启用开机自启，建议用 `app.getLoginItemSettings()` 复核真实状态。
- 无自动更新、无 Sparkle/Electron updater 接入。
- 无 Apple Developer 签名身份时不能声称"可分发"。

## 5. 与 `pnpm build` / `pnpm smoke` 的关系

- 打包不改变 `pnpm build` / `pnpm smoke` 语义：`electron-builder.yml` 只被 electron-builder 读取；
- `pnpm build` 仍是唯一生产构建入口（`out/`），打包只消费 `out/` + `package.json`；
- `pnpm smoke:file`（`electron .`）依旧是打包前的快速端到端验证；`.app` 验收见 §2.5。
