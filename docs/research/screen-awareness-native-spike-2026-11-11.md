# 屏幕感知原生能力真机探针报告（macOS 27.2 / Electron 44）

> 日期：2026-11-11
> 探针执行者：teammate `native-probe`
> 结论性质：**本机实测**（macOS 27.2 build 26B123，Mac Studio，arm64）+ 官方/可靠来源查证；凡「推断」均显式标注。
> 关联方案：`docs/research/screen-awareness-privacy-focus-feasibility-2026-11-11.md`（下称「豆包报告」）
> 仓库基线：`main` @ `4a2d8b3`（注意：豆包报告头部写的 `3893943` 是旧基线；当前 HEAD 已前进）
> 探针代码 / 二进制 / 日志 / 截图证据全部在 **`/tmp/screen-spike/**`**，本报告是唯一写入仓库的文件。

---

## 0. 一页结论（P0–P3 总裁定）

| 层 | 是否需要 TCC | 本机是否可行 | 关键坑 | 失败/拒绝时降级 |
|---|---|---|---|---|
| **P0 元数据**（前台 app、窗口几何、空闲、全屏、电源） | **不需要** | ✅ 全部实测通过 | ①`kCGWindowName` 无录屏权限时**键缺失**（不是空串）→ 标题规则引擎不能建在 P0；②全屏判定必须过滤 `layer==0`，否则 Dock/壁纸/通知中心全被误判；③本机无麦克风硬件，`IsRunningSomewhere` 只验证了 false 分支 | 无权限也无损；标题/内容规则全部判「未知→按 deny 处理内容级」（P0 本来无内容） |
| **P1 氛围（160×90 采样）** | **需要屏幕录制** | ✅ API 与处理腿实测可行（旧 API 整链 16–20ms；SCK 单次区域 35ms） | SCK 需 AppKit 初始化（CLI 直接跑会 `CGS_REQUIRE_INIT` SIGABRT）；连续采样应走 `SCStream` 而非每帧截图（本次未测连续流） | 无权限→纯 P0；**绝不可**「降级整屏」 |
| **P2 本地 OCR** | **需要屏幕录制**；Vision 本身**不需要**网络 | ✅ 可行；warm accurate 82–98ms / fast 8–15ms | **每进程首次 Vision 请求冷启动 12.7s**（模型加载）→ helper 必须常驻/预热，不能每次 spawn；`VNRecognizeTextRequest` 在 SDK 27.2 **未废弃**（只有 Revision2 废弃） | 无权限→`metadata`；连续失败→退避；OCR 失败→本次跳过（不回退整屏） |
| **P3 视觉 VLM** | 屏幕录制 + 网络（仅发送端） | ✅ 图像处理腿可行（长边 1280 + q0.7 ≈ 1.5ms、47–64KB）；VLM 端到端本次未验 | ①同一「每进程冷启动」问题不涉及（纯 CoreGraphics）；②adhoc 身份下 TCC 授权极不稳定 → 不能默认开 P3 | 拒绝→P2/P1/P0；网络失败→沉默；无 provider→关闭 |

**最关键的三个「报告需要修正/补强」的判定**

1. **`CGWindowListCreateImage` 不是「deprecated 但仍可随便用」**：SDK 27.2 里它已是 `obsoleted=15.0`（`SCREEN_CAPTURE_OBSOLETE(10.5,14.0,15.0)`），以默认部署目标编译会**直接编译失败**；只有把部署目标压到 ≤14（我用 13.0）才能编出来，运行期在 27.2 **仍然可用**（实测抓到 1920×1080）。这决定了「macOS 13.0 回退路径」的存在性与代价。
2. **TCC 归责是「responsible process」而不是「可执行文件所在 bundle」**：同一个 helper 二进制（`dist/.../Resources/native/winlist/winlist`）在 tccd 日志里的归责主体是 **`com.deepseek.dsh`（DeepSeek Harness）**，因为它是由 DSH 的 shell 派生的子进程；而通过 LaunchServices（`open`）启动的临时 .app 归责给它**自己的 bundle id**。开发版 `electron .` 同理：从本会话 shell 起来 → 继承 DSH 的录屏/辅助功能授权（实测 `getMediaAccessStatus('screen')='granted'`、`isTrustedAccessibilityClient=true`），**这会造成假绿**。
3. **adhoc 打包版（当前 `dist/mac-arm64/AventurinePet.app`）没有稳定 TCC 身份**：`codesign` 显示 `flags=0x2(adhoc)`、`TeamIdentifier=not set`、`Internal requirements count=0`；TCC 身份 = bundle id + 代码签名要求（adhoc 即 cdhash），**任何重新打包都会让旧授权失效**（重装/重建后需要用户重新授权）。这直接决定「默认 ocr」在分发前的风险等级。

---

## 1. 环境与证据清单

### 1.1 实测环境

| 项 | 值 | 证据 |
|---|---|---|
| macOS | 27.2（26B123） | `sw_vers` |
| 硬件 | Mac Studio（arm64）；**单显示器** 1920×1080 @1x（main display id 6），无刘海（`safeAreaInsets=0`）；**无电池**（AC only）；**无音频输入设备**（仅内置扬声器） | `p0_shell2.json`、`system_profiler SPAudioDataType`、`pmset -g batt` |
| 工具链 | CLT（无完整 Xcode），`swiftc` 6.4.2，SDK **27.2**，默认 target `arm64-apple-macosx27.2.0` | `swiftc --version`、`xcrun --show-sdk-version` |
| Electron | **44.10.2**（Chrome 152，Node 24.22.2）；dev 依赖声明 `^44.7.2` | `node_modules/electron/dist` Info.plist、Electron 探针 `process.versions` |
| 打包目标 | `dist/mac-arm64/AventurinePet.app`：`CFBundleIdentifier=com.aventurine.pet`、`LSMinimumSystemVersion=13.0`、**adhoc 签名**、无 entitlements | `plutil -p`、`codesign -dv` |
| 本机 TCC 现状 | **DeepSeek Harness（`com.deepseek.dsh`）已获屏幕录制 + 辅助功能 + 事件投递/监听授权**；这是本会话所有 shell 子进程继承的授权（见 §2） | `probe_tcc` 输出、`getMediaAccessStatus('screen')='granted'`、tccd 日志 |

> ⚠️ 读法提醒：本报告里「有权限」的运行结果，都是**以 DeepSeek Harness 为 responsible process** 得到的（DSH 已被授权）。它**不等于**「打包后的 `com.aventurine.pet` 已获授权」——后者在 Finder 启动时归责自身，本机未授予（无法读 TCC.db 直接枚举，见 §2.4，只能由归责机制 + 实测授权矩阵推断）。

### 1.2 探针程序（全部 `/tmp/screen-spike/src/**`，二进制 `/tmp/screen-spike/out/**`）

| 探针 | 用途 | 编译目标 |
|---|---|---|
| `probe_tcc.swift` | `CGPreflightScreenCaptureAccess` / `CGPreflightPostEventAccess` / `CGPreflightListenEventAccess` / `AXIsProcessTrusted` + 父进程链/NSRunningApplication 身份 | macos13.0 |
| `probe_ctx.swift` | 上下文对照矩阵（shell vs `open` vs launchd）+ 窗口标题可用性 | macos13.0 |
| `probe_p0.swift` | 空闲秒数、电源、屏幕、`CGWindowListCopyWindowInfo` 全字段（含 `kCGWindowName`）、`.optionAll` 对比 | macos13.0 |
| `probe_ax.swift` | AX 取前台窗口标题 + 错误码 | macos13.0 |
| `probe_audio.swift` | CoreAudio 全设备 + `kAudioDevicePropertyDeviceIsRunningSomewhere` | macos13.0 |
| `probe_sck.swift` / `sck_unguarded.swift` | SCK 各 API 的编译期版本门槛 | 12.3 / 13.0 / 14.0 / 27.2 |
| `probe_sck_runtime.swift` | SCK 运行时：`SCShareableContent.current`、`SCContentFilter(desktopIndependentWindow:)`、`SCStreamConfiguration`、`SCScreenshotManager.captureImage(in:)` | macos15.2 |
| `probe_cgwindowimage.swift` | 旧 API 编译期/运行期、`dlsym` 符号存在性 | 13.0（+默认 27.2 负对照） |
| `probe_vision.swift` / `probe_vision2.swift` | 位图生成 → `VNRecognizeTextRequest` accurate/fast + 冷/热耗时 | macos13.0 |
| `probe_pipeline.swift` / `probe_cap_timing.swift` | 缩放 160×90 / 长边 1280 + JPEG 编码耗时；旧 API 全链路 | macos13.0 |
| `electron_probe.js` | Electron 只读查询（不建窗、不申请权限） | — |
| `out/*.app`（TccProbe/NoPermProbe/OpenCtx/NoPermDetail/NoPermAX） | 零权限对照 app bundle（adhoc 自签，`LSUIElement`，不窗口不抢焦点） | — |

日志索引：`/tmp/screen-spike/logs/**`（关键文件在正文各节引用，§10 有清单）。

---

## 2. 条目 1：屏幕录制 TCC 现状与归责（实测）

### 2.1 验证方法

用同一份 `probe_tcc`，分别在 5 种上下文执行；**只调用 preflight 查询 API，不调用任何会弹窗的 request 路径**：

1. 本会话 shell（DSH 子进程）直接执行裸二进制；
2. 打包/自建 `.app`（有 `CFBundleIdentifier`）经 LaunchServices `open` 启动；
3. 同一 app 二进制经 `launchctl submit` 由 launchd 启动；
4. 临时 Electron（`node_modules/.bin/electron`）跑只读脚本，查 `systemPreferences.getMediaAccessStatus('screen')` 与 `isTrustedAccessibilityClient(false)`；
5. 静态检查 `dist/mac-arm64/AventurinePet.app` 的 Info.plist / codesign，并读 tccd 系统日志的归责三元组。

### 2.2 实际输出（摘录）

**A. shell 上下文（归责 DeepSeek Harness）** — `/tmp/screen-spike/logs/tcc_shell.json`

```json
{
  "AXIsProcessTrusted" : true,
  "bundleIdentifier" : "<nil>",
  "CGPreflightListenEventAccess" : true,
  "CGPreflightPostEventAccess" : true,
  "CGPreflightScreenCaptureAccess" : true,
  "parentChain" : [
    { "execPath" : "/bin/bash", "pid" : 72263 },
    { "execPath" : "/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness", "pid" : 98123 },
    { "bundleId" : "com.deepseek.dsh", "bundleURL" : "/Applications/DeepSeek Harness.app", "pid" : 98113 }
  ]
}
```

**B. LaunchServices 启动的临时 app（自带 bundle id，归责自身）** — `logs/ctx_com-spike-openctx-probe.json`

```json
{
  "bundleIdentifier" : "com.spike.openctx-probe",
  "executable" : "/tmp/screen-spike/out/OpenCtx.app/Contents/MacOS/OpenCtx",
  "CGPreflightScreenCaptureAccess" : false,
  "AXIsProcessTrusted" : false,
  "CGPreflightPostEventAccess" : false,
  "layer0_windows" : 5,
  "layer0_with_nonEmpty_name" : 0,
  "windows_total" : 14,
  "windows_with_nonEmpty_name" : 3
}
```

**C. launchd 独立归责（裸二进制）** — `logs/ctx_plain-exec.json`：`CGPreflightScreenCaptureAccess=false`、`AXIsProcessTrusted=false`、`layer0_with_nonEmpty_name=0/5`。

**D. 临时 Electron（dev 语义）** — `logs/electron_probe.log`

```json
{
  "versions": { "electron": "44.10.2", "chrome": "152.0.7977.169", "node": "24.22.2" },
  "appName": "Electron",
  "packaged": false,
  "mediaAccess": { "screen": "granted", "microphone": "not-determined", "camera": "not-determined" },
  "isTrustedAccessibilityClient": true,
  "powerMonitor": { "getSystemIdleTime": 0, "isOnBatteryPower": false, "idleState": "active" }
}
```

> 注意：dev Electron 是**本会话 shell 的子进程**（`ELECTRON_RUN_AS_NODE=1` 等 DSH 环境变量可见），因此就绪环境里它的 `screen="granted"` 来自 DSH 的归责继承，不是 Electron.app 自己获批。`node_modules/electron/dist/Electron.app` 自身是 `CFBundleIdentifier=com.github.Electron`、`flags=0x2(adhoc,linker-signed)`、`TeamIdentifier=not set`。

**E. 打包 app 静态身份** — `codesign -dv --verbose=4 dist/mac-arm64/AventurinePet.app`

```
Identifier=com.aventurine.pet
CodeDirectory v=20400 size=299 flags=0x2(adhoc) hashes=3+3 location=embedded
TeamIdentifier=not set
Internal requirements count=0 size=12
Total signatures=1
```

Info.plist：`CFBundleIdentifier=com.aventurine.pet`、`LSMinimumSystemVersion=13.0`、`DTSDKName=macosx15.5`、含 `ElectronAsarIntegrity`；`codesign -d --entitlements` 无任何 TCC 相关 key（与 `docs/packaging.md` §3 一致）。

**F. tccd 归责三元组（运行时日志证据）** — `logs/tcc_attribution_evidence.txt`

```
2026-11-11 16:40:21.662 Df tccd[179] [com.apple.TCC:access] AUTHREQ_ATTRIBUTION: msgID=177.407175,
attribution={
  responsible={TCCDProcess: identifier=com.deepseek.dsh, pid=98113, responsible_path=/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness},
  accessing={TCCDProcess: identifier=winlist.arm64, pid=77264, binary_path=/Volumes/4TB外置盘/.../dist/mac-arm64/AventurinePet.app/Contents/Resources/native/winlist/winlist},
  requesting={TCCDProcess: identifier=com.apple.WindowServer, pid=177}
}
```

这条日志同时证明三件事：①**TCC 判定主体是 responsible process**；②本机正在运行的打包版 pet 是由 DSH shell 派生启动的（其 helper 归责到 DSH，因此**测试时**拿得到 DSH 的录屏授权）；③helper 可执行文件位于打包 app 的 `Resources` 内也没用，`accessing` 只是「谁在访问」，`responsible` 才决定授不授权。

### 2.3 TCC 归责规则（本机验证 + 文档一致）

| 启动方式 | responsible process | 屏幕录制授权来源 | 本机实测 |
|---|---|---|---|
| 从 DSH shell `spawn` 的裸二进制（含 winlist helper、dev `electron .`） | **调用链上的 GUI app（DSH）** | DSH 的 TCC 授权 | preflight=true、AX=true、标题可见 |
| `open /path/to/X.app`（LaunchServices） | **X.app 自身** | X 自己的 TCC 记录（首次需要用户授权） | preflight=false、AX=false、标题缺失 |
| `launchctl submit`（launchd 直接拉起） | 自身（无 GUI 归责 app） | 自身/无 → 默认拒绝 | preflight=false、AX=false、标题缺失 |
| Finder 双击 / Spotlight 打开打包 app | **`com.aventurine.pet` 自身** | 自身 TCC 记录；adhoc 身份随 cdhash 变化 | 本次未执行（不启动真实 pet），按上述机制推断；静态身份见 2.2E |

**对设计的影响**

- 生产代码里：**helper 必须由主进程 `spawn`**（现有 `native/winlist` 模式正确），不要用 `launchctl`/独立 helper.app；子进程自动继承 app 的归责与授权，不需要给 helper 单独申请权限。
- **开发/测试纪律**：从 DSH/终端集成 shell 里启动的 app 会继承该 shell 宿主 app 的授权，**测试结果对最终用户不成立**。验证 TCC 行为必须用 Finder/`open` 独立启动（或用 `open` 的临时 app 复现「无授权用户」路径）。本报告 §4/§7 的「无权限」数据都是这样取得的。
- 文档里 `docs/packaging.md` §3 的「TCC 能力不能靠 entitlements 获得」正确；但应补一条：**adhoc 身份下授权随重建失效**，默认开启内容级能力前必须先有 Developer ID 稳定签名。

### 2.4 macOS 27 是否仍有「周期性重新授权屏幕录制」

**本机无法直接验证**：`tccutil` 只能 reset 不能查；`~/Library/Application Support/com.apple.TCC/TCC.db` 在本机不存在（macOS 27 路径已变化），`/Library/Application Support/com.apple.TCC/TCC.db` 只读打开被拒（`authorization denied`）。API 层也没有「授权到期时间」查询接口（`CGPreflightScreenCaptureAccess` 只返回 Bool）。

**查证结果（外部来源）**：

- macOS Sequoia（15）首次引入「按月重新确认屏幕录制」：周提示在 beta 中改为**每月**，弹窗文案为「…is requesting to bypass the system private window picker…」，选项含 **Allow For One Month**；重启后重复授权的要求被移除。—— MacRumors，**2024-08-15**，https://www.macrumors.com/2024/08/15/macos-sequoia-screen-recording-app-permissions/ （同题 9to5Mac，2024-08-14：https://9to5mac.com/2024/08/14/macos-sequoia-screen-recording-prompt-monthly/ ）
- 2026-09-28 的开发者向指南仍把「每月被再问一次」归因为 **macOS Sequoia 的周期性屏幕捕获确认**（并说明该弹窗「没有任何 app 能替用户回答」）：https://favtray.com/blog/macos-permissions-after-update
- **macOS 27（Golden Gate，2026-09-14 发布）**：第三方 MDM 厂商 2026-11-05 更新的文档明确「macOS 27 中 **Screen Recording 仍必须由用户授权**，DDM 尚不能静默授予屏幕录制，也不能抑制授权通知；升级后旧授权不会自动延续」——https://support.activtrak.com/hc/en-us/articles/56996204379803-macOS-27-Golden-Gate-s-Impact-on-ActivTrak-Deployments
- Apple 开发者论坛（macOS 26.1，2026）仍在讨论「**纯可执行文件不出现在 Screen & System Audio Recording 列表里**」：https://developer.apple.com/forums/thread/807898 —— 说明系统把「屏幕录制」归属到 app bundle 身份上，而非裸二进制。

**结论**：macOS 15 起的「周期性再确认」有可靠证据；**macOS 27.2 是否仍按月再确认，本次没有找到可引用的官方说明，也无法在本机读取授权到期时间**。设计上必须按「可能随时被撤销/需要再确认」处理：
1. 启动时 + 每次观察前用 `CGPreflightScreenCaptureAccess()`（不弹窗）或 `systemPreferences.getMediaAccessStatus('screen')` 查询；
2. 从 `granted` 变 `false` 时**立即降级 `metadata`** 并记录一次原因，不重试申请、不弹二次窗；
3. 提供设置页深链 + 「重新授权后自动恢复」的即时探测（见 §9）。

---

## 3. 条目 2：ScreenCaptureKit 可用性与最低版本（编译期 + 运行期）

### 3.1 验证方法

1. 直接读 SDK 头文件里的 availability 标注（权威）；
2. 用 `swiftc -typecheck` 在多个部署目标编译「带 guard 版」与「不带 guard 版」探针，用编译器报错反证最低版本；
3. 运行期只做**元数据读取**（`SCShareableContent.current`），并且**只**在 `CGPreflightScreenCaptureAccess()==true` 时才做一次 64×28 的极小区域截图（`captureImage(in:)`），像素立即丢弃、不落盘；全程不触碰前台窗口内容。

### 3.2 编译期输出

**SDK 头文件 availability（`ScreenCaptureKit.framework/Headers/`）**

| API | 最低 macOS | 头文件位置 |
|---|---|---|
| `SCShareableContent` | **12.3** | `SCShareableContent.h:145` `API_AVAILABLE(macos(12.3), macCatalyst(18.2))` |
| `SCShareableContent.currentProcess`（无 consent 元数据） | 14.4 | 同上:159 |
| `SCContentFilter` | 12.3 | `SCStream.h:106` |
| `SCContentFilter(desktopIndependentWindow:)` | **12.3** | `SCStream.h:152` `initWithDesktopIndependentWindow:` |
| `SCStreamConfiguration` | 12.3 | `SCStream.h`（`SCStreamConfiguration` 类） |
| `SCScreenshotManager` | **14.0** | `SCScreenshotManager.h:134` `API_AVAILABLE(macos(14.0), macCatalyst(18.2))` |
| `SCScreenshotManager.captureImage(contentFilter:configuration:)` | **14.0** | `SCScreenshotManager.h:153` |
| `SCScreenshotManager.captureImage(in:)` | **15.2** | `SCScreenshotManager.h:161` |
| 新 `SCScreenshotConfiguration` / `captureScreenshot(...)` | **26.0** | `SCScreenshotManager.h:165+`（macOS 26 新增，未使用） |
| SCK 错误码新增 `-3822 insufficientStorage` / `-3823 notSupported` | **27.0** | `SCError.h:36-37`（说明 SCK 在 macOS 27 仍在演进） |

**带 guard 的探针**：`swiftc -typecheck -target arm64-apple-macos{12.3,13.0,14.0} probe_sck.swift -framework ScreenCaptureKit` → 全部 `rc=0`（只有一处我故意写错 `SCDisplay.self as! SCDisplay` 的测试代码 warning，可忽略）。

**不带 guard 的反证**：`swiftc -typecheck -target arm64-apple-macos13.0 sck_unguarded.swift` →

```
error: 'SCScreenshotManager' is only available in macOS 14.0 or newer
note: add 'if #available' version check
```

同一文件在 `-target arm64-apple-macos14.0` 和默认 27.2 目标下均 `rc=0`，**无任何 deprecation 警告** → SCK 全套 API 在 SDK 27.2 中是推荐路径，未被废弃。

### 3.3 运行期输出（`logs/sck_runtime2.log`，有 DSH 录屏授权）

```
preflight=true at 2026-11-11T08:39:19Z
SCShareableContent.current ok: windows=78 displays=1 apps=27 (23.4ms)
display id=6 frame=(0.0, 0.0, 1920.0, 1080.0) width=1920x1080
SCContentFilter(desktopIndependentWindow:) ok: contentRect=(320.0, 65.0, 1280.0, 820.0) pointPixelScale=1.0
SCStreamConfiguration ok: width=160 height=90 minFrameInterval=0.016666666666666666s
SCScreenshotManager.captureImage(in:) ok: 64x28 in 35.1ms (pixels discarded)
done=true
```

**关键坑（务必写进实现）**：直接在 CLI 里起 `Task {}` 调 SCK，会先打印
`Assertion failed: (did_initialize), function CGS_REQUIRE_INIT, file CGInitialization.c, line 44.` 然后 **SIGABRT（exit 134）**。修法是先 `_ = NSApplication.shared`（初始化 CGS/AppKit）并在主线程 runloop 上等待异步结果（本探针第二次运行改为 `Task { @MainActor in ... }` + `RunLoop.main.run(until:)` 后正常）。对 helper 的启示：**SCK 采集 helper 需要 AppKit 初始化**；如果走「长期驻留 helper」方案，应显式 `NSApplication.shared`（`LSUIElement` 或 `NSApplicationActivationPolicy.prohibited` 避免 Dock 图标），或在主进程内直接采集（Electron 主进程本身就是 app，无此问题）。

### 3.4 对设计的影响

- `LSMinimumSystemVersion=13.0` 与 `SCScreenshotManager`（14.0）存在冲突：**macOS 13 上没有 SCK 截图**。方案有三种：
  a) 内容级能力最低支持 14.0，13.x 自动 `metadata`（推荐）；
  b) macOS 13 用 `CGWindowListCreateImage` 回退（见 §4，能编能跑但 SDK 已 obsoleted，需部署目标 ≤14）；
  c) 放弃 13.x 内容级能力。
- `SCScreenshotManager` 单次截图 ≈ 35ms（含固定开销，区域越小越接近固定值），`SCShareableContent.current` ≈ 23–33ms。**低频（90–180s）单窗口截图完全可接受**；P1 若要做 10Hz 氛围采样，应改用 `SCStream`（本次未测，标注为 `未验证`）。
- 不要依赖 `SCShareableContent.current` 的「无 consent」变体（14.4+）来做权限判断——它给的是**redacted**信息，不能替代 preflight。

---

## 4. 条目 3：`CGWindowListCreateImage` 在 macOS 27.2 的真实状态

### 4.1 验证方法

读 SDK 头文件宏展开 → 用默认目标（27.2）编译（预期失败）→ 用 `-target arm64-apple-macos13.0` 编译（预期成功）→ 运行期 `dlsym` 检查符号 + 仅在 preflight=true 时实际调用一次（抓 1920×1080，像素不落盘）→ 计时。

### 4.2 实际输出

**头文件（SDK 27.2）** `CoreGraphics.framework/Headers/CGWindow.h`：

```c
#define SCREEN_CAPTURE_OBSOLETE(x,y,z) \
    __attribute__((availability(macos,introduced=x,deprecated=y,obsoleted=z,message="Please use ScreenCaptureKit instead.")));

CG_EXTERN CGImageRef __nullable CGWindowListCreateImage(...)
    SCREEN_CAPTURE_OBSOLETE(10.5,14.0,15.0);   // 行 271-274
CG_EXTERN CGImageRef __nullable CGWindowListCreateImageFromArray(...)
    SCREEN_CAPTURE_OBSOLETE(10.5,14.0,15.0);   // 行 280-283
```

**用默认部署目标 27.2 编译**（`swiftc -typecheck probe_cgwindowimage.swift`）→ **失败**：

```
error: 'CGWindowListCreateImage' is unavailable in macOS: Please use ScreenCaptureKit instead.
note: 'CGWindowListCreateImage' was obsoleted in macOS 15.0
```

**用 `-target arm64-apple-macos13.0` 编译** → `rc=0`（无 warning）。

**运行期（macOS 27.2，preflight=true）** — `logs/cgwi_run.log`：

```
CGPreflightScreenCaptureAccess=true
dlsym(CGWindowListCreateImage)=present
dlsym(CGWindowListCreateImageFromArray)=present
CGWindowListCreateImage=captured 1920x1080
```

**全链路耗时（`logs/cap_timing.log`，5 次）**：

```
run0: capture(full 1920x1080)=71.84ms resize160x90+jpeg=6.22ms total=78.06ms jpeg=6009B
run1: capture=11.98ms resize+jpeg=7.73ms total=19.71ms
run2: capture=9.62ms  resize+jpeg=7.76ms total=17.38ms
run3: capture=9.48ms  resize+jpeg=7.79ms total=17.27ms
run4: capture=9.37ms  resize+jpeg=6.84ms total=16.21ms
```

### 4.3 结论

- 豆包报告「macOS 14+ 标记 deprecated，但仍可用」**不完整**：在 SDK 27.2 中它已 **obsoleted=15.0**（比 deprecated 更重），**以 macOS 15+ 为部署目标编译会直接失败**；只有部署目标 ≤14 才能编译。
- 运行期 macOS 27.2 的 CoreGraphics 仍导出并可用（实测成功、9–12ms/全屏）；Apple 尚未在运行时移除符号，但这是「随时可能消失」的遗留路径。
- **对设计的影响**：不要把它当主路径；若必须支持 macOS 13.x 的 P2/P3，把它放进 `@available(macOS 13, *)` + 部署目标 13.0 的独立编译分支，并加 feature flag 与运行时 `dlsym` 探测（可为 nil）。`native/winlist` 使用的 `CGWindowListCopyWindowInfo` **不受影响**（它不是截图 API，SDK 27.2 无 availability 变化）。

---

## 5. 条目 4：窗口标题与辅助功能（AX）

### 5.1 验证方法

同一 `probe_p0`（复刻 winlist 的 `CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements])`）分别在有录屏权限（DSH 归责 shell）与**无录屏权限**（LaunchServices 启动的临时 app `com.spike.noperm-detail`）上下文运行，比较 `kCGWindowName` 的**键是否存在**与值；AX 用 `probe_ax` 在两种权限上下文分别读取前台窗口标题，记录 `AXError`。

### 5.2 实际输出

**有录屏权限（shell，DSH 归责）** — `logs/p0_shell2.json`：14 个在屏窗口，**14/14 有 `kCGWindowName`**：

```
4495 Google Chrome      '微信文件传输助手网页版'
1511 访达               'deepseek-harness'
4186 豆包               '桌宠移动异常问题分析与修复建议 - 豆包'
2442 DeepSeek Harness   '调查并修复坐窗姿势骨骼拉伸 — DeepSeek Harness'
45   Visual Studio Code 'PLAN.md'
```

**无录屏权限（临时 app `com.spike.noperm-detail`）** — `logs/p0_noperm_true.json`：`kCGWindowName` **键直接缺失**（不是空字符串）：

```
layer=2147483630 Window Server    nameKeyPresent=True  name='StatusIndicator'
layer=2147483630 Window Server    nameKeyPresent=True  name='StatusIndicator'
layer=        1000 AventurinePet  nameKeyPresent=False name=None
layer=          24 Window Server  nameKeyPresent=True  name='Menubar'
layer=          20 程序坞          nameKeyPresent=False name=None
layer=           0 DeepSeek Harness nameKeyPresent=False name=None
layer=           0 豆包             nameKeyPresent=False name=None
layer=           0 Google Chrome   nameKeyPresent=False name=None
layer=           0 访达             nameKeyPresent=False name=None
layer=           0 Visual Studio Code nameKeyPresent=False name=None
...
named: 3 / 14
```

即：**没有屏幕录制权限时，只有 WindowServer 自己的系统窗口（StatusIndicator、Menubar）仍有名字，所有第三方 app 的标题消失且键不存在**。豆包报告 / `native/winlist/README.md` 的判断成立，且比「为空」更严格——**不能靠「存在但空」来判断敏感标题**。

**AX（有辅助功能权限，DSH 归责）** — `logs/ax_shell.json`：

```json
{
  "AXIsProcessTrusted": true,
  "focusedWindow_copy_rc": "success",
  "focusedWindow_role": "AXWindow",
  "focusedWindow_title": "微信文件传输助手网页版 - Google Chrome",
  "focusedWindow_titleLength": 27,
  "app_windows_count": 1,
  "systemWide_focusedUIElement_rc": "cannotComplete(-25204)"
}
```

**AX（无辅助功能权限，`com.spike.noperm-ax`）** — `logs/ax_noperm.json`：

```json
{
  "AXIsProcessTrusted": false,
  "focusedWindow_copy_rc": "apiDisabled(-25211)",
  "app_windows_rc": "apiDisabled(-25211)",
  "systemWide_focusedUIElement_rc": "cannotComplete(-25204)"
}
```

### 5.3 结论与设计影响

- **标题有两条路，权限不同**：
  - `CGWindowListCopyWindowInfo` 的 `kCGWindowName`：需**屏幕录制**（实测）；
  - `AXUIElementCopyAttributeValue(kAXFocusedWindow, kAXTitle)`：需**辅助功能**（实测 `apiDisabled`），且 `AXIsProcessTrusted=false` 时全部 AX 读调用失败。
- **当前项目实现安全**：`native/winlist/main.swift` 只读 owner/pid/layer/alpha/bounds，不读标题，所以不需要 TCC——本次实测再次确认。
- **新发现**：即便辅助功能已授权，`AXUIElementCreateSystemWide()` 的 `kAXFocusedUIElement` 在本机返回 `cannotComplete(-25204)`，**系统级十字准星路径不可靠**；应始终走 `AXUIElementCreateApplication(frontPid)` → `kAXFocusedWindow` → `kAXTitle`。
- **SCK 也能给标题**：`SCWindow.title` 在有录屏权限时可用（实测 `"调查并修复坐窗姿势骨骼拉伸 — DeepSeek Harness"`）。所以 P2 路径里**拿到窗口标题不需要辅助功能**，只需要已有屏幕录制授权；**不要为了标题去申请辅助功能**（额外弹窗、额外信任成本）。
- **规则引擎影响**：`denyTitleKeywords` 只在 P2/P3（已有录屏授权）时才可信；P0 阶段标题恒缺失，`App::Title` 规则的求值结果必须按「未知 → 内容级 deny」处理；豆包报告默认档 `ocr` 恰好在线，但必须确保**P0/P1 不使用标题做安全判定**，否则会在无权限时把「无标题」误判为「安全」。

---

## 6. 条目 5：零权限 P0 信号实测

### 6.1 空闲时长（`CGEventSourceSecondsSinceLastEventType`）

**验证方法**：Swift 探针直读；与 Electron `powerMonitor.getSystemIdleTime()`、`ioreg` 三条路径互校。

**实际输出（`logs/p0_shell2.json`，同一时刻）**：

```
idle_anyInputEventTypeMax = 0.7 s     ← 用 CGEventType(rawValue: UInt32.max)（kCGAnyInputEventType）
idle_mouseMoved = 0.7 s
idle_keyDown = 3.7 s
idle_leftMouseDown = 4.2 s
idle_scrollWheel = 1.7 s
idle_flagsChanged = 11.7 s
idle_rightMouseDown = 109064.74 s
```

Electron `powerMonitor`：`getSystemIdleTime: 0`、`idleState: "active"`（`logs/electron_probe.log`）；`ioreg -c IOHIDSystem -d 4`：`"HIDIdleTime" = 1124819166`（纳秒 ⇒ **1.125s**，`logs/ioreg_idle.log`）。三条独立路径一致（用户当时活跃）。

**编译期坑（必须写进实现）**：C 函数 `CGEventSourceSecondsSinceLastEventType` 在 Swift 里已 **obsoleted in Swift 3**：

```
error: 'CGEventSourceSecondsSinceLastEventType' has been replaced by
'CGEventSource.secondsSinceLastEventType(_:eventType:)'
```

正确写法：`CGEventSource.secondsSinceLastEventType(.combinedSessionState, eventType: type)`。
**第二个坑**：传 `.null`（rawValue 0）不是「任意输入」，会得到无意义值（我第一版拿到 108815s ≈ 30 小时）；「任意输入」要用 `CGEventType(rawValue: UInt32.max)!`（= `kCGAnyInputEventType`）。Electron `getSystemIdleTime()` 内部用的是后者，所以能给 0。

**结论**：空闲探测**零权限**、毫秒级、可 5s 轮询；但 `CGEventSource` 只给「会话级」输入时间，不区分窗口，也不含具体按键内容（隐私友好，符合 P0 定位）。

### 6.2 电源状态

| 通道 | 输出 | 说明 |
|---|---|---|
| `pmset -g batt` | `Now drawing from 'AC Power'` | 本机 Mac Studio 无电池 |
| `IOPSCopyPowerSourcesInfo` | `sources: []`；`IOPSGetTimeRemainingEstimate=-2`；`externalAdapter.watts=-1` | 台上机/无电池 |
| Electron `powerMonitor.isOnBatteryPower` | `false`；`idleState: "active"` | 实测 |

**结论**：电源 API 零权限可用；但**「电池供电时间隔翻倍」在本机无法验证**（无电池）。设计上按「电池路径未在本机验证」标注，保留开关；真机验证需在 MacBook 上做（`IOPS`/`powerMonitor` 两条路都支持）。

### 6.3 麦克风占用（CoreAudio `kAudioDevicePropertyDeviceIsRunningSomewhere`）

**实际输出（`logs/audio_shell.json`）**：

```json
{
  "defaultInputDevice": 0,
  "defaultInputIsRunningSomewhere": false,
  "devices": [
    { "id": 70, "name": "Mac Studio扬声器", "transport": "bltn",
      "inputStreams": 0, "outputStreams": 1,
      "deviceIsAlive": true, "deviceIsRunningSomewhere": false }
  ],
  "micBusyAnyInput": false
}
```

`system_profiler SPAudioDataType` 同样只有「Mac Studio扬声器」一个输出设备，**本机没有麦克风硬件**（Mac Studio 无内置麦克风，也未接外置输入设备）。

**权限问题**：读这个属性**不需要麦克风 TCC**——它是「设备是否在运行」的只读布尔，而不是打开输入流。第三方工具（如 FavTray）明确说明「读设备是否在用不需要相机/麦克风权限」（https://favtray.com/blog/mac-mic-camera-in-use-which-app ，2026-09-28）；macOS 14.2+ CoreAudio 还能进一步给出占用进程名（我们未用）。

**结论**：API 路径、权限、只读语义都成立；**但本机无法验证 true 分支**（没硬件）。降级方案：
1. 用「前台 app ∈ 会议名单」作硬闸门（P0 零权限，本机已验证 app 名可读）；
2. `IsRunningSomewhere` 留在代码里，在带麦克风的机器上单独验证；
3. 不要用 `kAudioDevicePropertyDeviceIsRunningSomewhere` 去读音频内容——设计中只取布尔。

### 6.4 P0 汇总

| 信号 | 权限 | 本机实测 | 备注 |
|---|---|---|---|
| 前台 app / 窗口几何 | 无 | ✅ 14 窗口全字段 | 250ms 轮询可行 |
| 空闲秒数 | 无 | ✅ 三条路径互校 | 注意 anyInput 事件类型 |
| 麦克风占用布尔 | 无 TCC | ⚠️ 只验 false（无硬件） | 需会议 app 名单兜底 |
| 电源/电池 | 无 | ⚠️ 只验 AC（台上机） | 电池路径另测 |
| 全屏判定 | 无 | ✅ 几何规则可判（见 §7） | 必须滤 layer |
| 窗口标题 | **需屏幕录制** | ✅ 有/无权限对照 | P0 不能用标题 |

---

## 7. 条目 6：全屏判定与 winlist 语义（实测）

### 7.1 winlist 复刻实测

**验证方法**：完整复刻 `native/winlist` 的调用（`.optionOnScreenOnly, .excludeDesktopElements`），同时再跑一次 `.optionAll` 与 `.optionAll, .excludeDesktopElements` 对比；输出全字段（含 `kCGWindowName`、`kCGWindowLayer`、`isOnscreen`、z 序）。**注意**：为不打扰用户，本次**没有切换 Space / 没有让 app 进入全屏**，因此「其他 Space 的窗口」只能由 `optionOnScreenOnly` 语义 + `isOnscreen` 字段 + 列表差异推断。

**实际输出（`logs/p0_shell2.json`，有录屏权限）**：

```
onScreenOnly_count          = 14
optionAll_count             = 77
optionAll_excludeDesktop    = 73
```

`.optionAll` 里出现但 `.optionOnScreenOnly` 里没有的 63 个窗口，全部 `.optionOnScreenOnly` 语义外的（`onScreen=false`、尺寸 0 或 1、辅助窗、其他 app 的隐藏窗）。**结论：winlist 的 `.optionOnScreenOnly` 列表不含其他 Space / 最小化 / 离屏窗口**（与 README A4-F08 一致）；反过来「列表中消失 ≠ 窗口关闭」也再次确认。

**layer 分布（当前屏幕）**：

| layer | owner | 窗口 | bounds |
|---|---|---|---|
| 2147483630 | Window Server | StatusIndicator ×2 | 28×28 |
| **1000** | AventurinePet（宠物 overlay） | `aventurine-pet` | (0,30,1920,967) |
| 27 | 豆包浏览器 | 悬浮球 | 52×52 |
| 24 | Window Server | Menubar | (0,0,1920,30) |
| 20 | 程序坞 | Dock | **(0,0,1920,1080)** |
| 0 | 豆包 / Chrome / 访达 / DSH / VSCode | 5 个普通窗口 | 均未铺满屏 |
| -2147483601 | 通知中心 | 精选/天气预报/月 | 小窗 |

### 7.2 全屏判定：规则与误差

**推荐的判定（本机数据直接支持）**：

```
isFullscreen(window) =
    window.layer == 0
 && window.onScreen == true
 && |window.bounds.x - disp.x| ≤ 2
 && |window.bounds.y - disp.y| ≤ 2
 && |window.bounds.w - disp.w| ≤ 2
 && |window.bounds.h - disp.h| ≤ 2
 && window.area / disp.area ≥ 0.95       // 双保险（贴边但未铺满）
 && window.pid != 自身 pid               // 排除宠物 overlay
```

其中 `disp` 用 **`CGDisplayBounds(displayID)`**（左上原点、全局坐标，与 `kCGWindowBounds` 同一坐标系），**不要**混用 `NSScreen.frame`（Cocoa 左下原点，数值差 = 屏高，是最大坑）。

**实测误差素材**：

- 本机主屏 `CGDisplayBounds` = (0,0,1920,1080)；`NSScreen.frame`=(0,0,1920,1080)（单屏时巧合相同），`visibleFrame`=(0,83,1920,967) —— 若用 `visibleFrame` 做基准，会把「最大化（zoom）窗口」误判为全屏（该机菜单栏 30px + Dock 83px，差 113px）。
- 本机所有 `kCGWindowBounds` 坐标/尺寸都是整数点（scale=1），**单显示器下 2px 容差足够**；Retina（scale=2）时 bounds 仍是 points，四舍五入误差 ≤1px，2px 仍成立（标注：本机只有 scale=1 的外接屏，Retina 分支为推断）。
- **不过滤 layer 会 100% 误判**：本机用「bounds≈display」扫全部 77 个窗口，命中 5 个：

```
fullscreen-match: -2147483603 访达 ''            onScreen True    ← 桌面
fullscreen-match:  23        通知中心 'Notification Center' onScreen False
fullscreen-match: -2147483624 WindowManager 'Wallpaper' onScreen True
fullscreen-match:  20        程序坞 'Dock' onScreen True
fullscreen-match: -2147483626 Window Server 'Display 6 Backstop' onScreen True
```

全部 `layer != 0`。因此规则引擎里**必须先 `layer==0` 再比几何**，否则「全屏自动静音」会在正常桌面下常亮。
- 其他误差来源（需在实现里处理）：①多显示器时要用「窗口与哪个显示器的重叠面积最大」匹配，且各屏原点可能为负；②刘海/安全区域（`NSScreen.safeAreaInsets`，本机 0）不影响 `kCGWindowBounds` 与 display 全等，但影响内容区；③全屏切换有 ~0.3s 动画，bounds 会逐帧变化 → 需连续 2 次采样一致；④本机未观察到真实全屏窗口（没有普通 layer0 窗口铺满屏），**「真全屏 = bounds 与 display 完全相等」为推断，需在真机把某个 app 全屏后复核一次**（为避免抢焦点，本次未执行）。

### 7.3 对设计的影响

- 全屏检测**零权限**可行，但必须：`layer==0` + `onScreen` + 与 `CGDisplayBounds` 比 + ≤2px + 面积比 + 连续采样；**不要**用 `visibleFrame`，也**不要**只看面积比（Dock 就是满屏面积）。
- `winlist` 输出的 `onScreen` 当前恒 `true`（README A4-F12），消费侧无法区分「其他 Space」；若 P0 需要「全屏自动静音」，建议在 `winlist` 里**保留现有字段不动**，由主进程额外读 `NSScreen`/`CGDisplayBounds` 做几何判定——不需要改 helper 的 TCC 面。
- 建议给 winlist 增加一个**可选**的 `displayID` 字段（纯几何，不加权限）供多屏匹配；这是后续 B5/全屏判定的低成本改进，但不属于本次任务。

---

## 8. 条目 7：Vision OCR 离线实测

### 8.1 验证方法

用 CoreGraphics/CoreText **程序生成**一张 1600×900 位图（中英混排 + 故意混入假敏感串），保存到 `/tmp/screen-spike/evidence/vision-input.png`，再用 `VNRecognizeTextRequest`（`.accurate` / `.fast`，revision3，`zh-Hans`+`en-US`）识别；记录冷/热耗时、识别文本、SDK deprecation 警告。

### 8.2 实际输出

**编译期（SDK 27.2，默认目标）**：只有一处与「macOS 27 是否 deprecated」相关的警告：

```
warning: 'VNRecognizeTextRequestRevision2' was deprecated in macOS 15.0: renamed to 'VNRecognizeTextRequestRevision3'
```

**`VNRecognizeTextRequest` / `VNImageRequestHandler` 本身在 SDK 27.2 未被废弃**（用 revision3 无警告）。另：SDK 里有 Swift-only 新版 `Vision.RecognizeTextRequest`（`Vision.swiftmodule`，macOS 26+ 新接口，`_Vision_FoundationModels.framework` 也存在）；旧 Objective-C `VNRecognizeTextRequest` 仍是可用且非 deprecated 的稳定 API——迁移到新 Swift API 可选、非必须。

**运行期（`logs/vision_run.log` / `logs/vision_warm.log`）**：

```
[accurate 首次] time=12994.40ms lines=4
  | Aventurine Pet screen awareness spike 2026-11-11
  | 前台窗口标题：终端— npm run dev
  | 验证码 123456 请勿泄露 password: hunter2
  | ScreenCaptureKit SCScreenshotManager macOS 14+

[fast]        time=38.80ms lines=4
[accurate 第二次] time=108.92ms

同进程基准（probe_vision2）：
fast     runs=5 times(ms)=56.8, 9.3, 14.6, 9.3, 8.4
accurate runs=5 times(ms)=12723.7, 83.8, 97.5, 86.7, 82.0   ← 第 1 次即冷启动
VNRecognizeTextRequest default supported revisions: 3
```

**识别质量**：4/4 行全部识别；中文、英文、数字、冒号、`—` 都正确；`验证码 123456 password: hunter2` 这种「敏感串」被原样识别——**证明 OCR 层必须配脱敏**（与豆包报告 §4.3 的七条不变量一致）。

**离线**：探针全程没有任何网络 API 调用；Vision 文本识别按 Apple 文档在设备端执行。本机未断网做隔离实验（不想影响用户网络/DSH），但 `zh-Hans`/`en-US` 在「冷启动 12.7s 后立即 82–98ms」的表现符合**本地模型加载**而非网络下载（12.7s 是一次性模型/图编译成本；若走网络，后续每次都会受网络影响而不稳定）。标注：**离线性质为文档 + 行为推断，未做断网对照**。

### 8.3 对设计的影响（重要）

- **冷启动 12.7s/进程** 是最大坑：如果「每次观察 spawn 一个 helper」做 OCR，每次都会付 12.7s（完全不可用）。必须：
  a) **长期驻留 OCR helper**（首次调用前预 warm，或启动后空闲热一次）；
  b) 或把 OCR 放主进程/渲染以外的常驻子进程，`spawn` 一次、多次 IPC；
  c) 或者用 `.fast`（8–15ms 热）做「氛围/变化检测」，仅在确认要读内容时用 `.accurate`。
- P2 的「单次 50–150ms」在 hot 状态成立（accurate 82–98ms），但**默认档 `ocr` 必须按「首次 12.7s」设计超时与降级**（超时 1.5s → 本次跳过，不阻塞）。
- 输出脱敏必须在 helper 内做（`验证码/password/token` 行级丢弃 + 长数字/邮箱/URL 过滤），因为原文已经进过内存。

---

## 9. 条目 8：单窗口捕获 → 160×90 → JPEG 的耗时与降级语义

### 9.1 已实测的处理腿

| 路径 | 实测（本机） | 证据 |
|---|---|---|
| `CGWindowListCreateImage`（旧 API，全屏 1920×1080） | 首次 71.8ms；热 9.4–12.0ms | `logs/cap_timing.log` |
| → 缩放 160×90 + JPEG q0.7 | 6.2–7.8ms；产物 ≈ 6.0KB | 同上 |
| 旧 API 全链路（含捕获） | 首次 78ms；热 **16–20ms** | 同上 |
| 合成 CGImage → 160×90 + JPEG q0.7 | 0.05–0.1ms（热，合成源） | `logs/pipeline_run.log` |
| 合成 CGImage → 长边 1280 + JPEG q0.7 | **1.4–1.6ms**，47–64KB | 同上 |
| `SCShareableContent.current`（SCK） | 23.4–33.3ms | `logs/sck_runtime2.log` |
| `SCScreenshotManager.captureImage(in: 64×28)`（SCK） | **35.1ms**（固定开销为主） | 同上 |

> 注：合成源 0.05ms 与真实源 6–8ms 的差异来自「从 WindowServer/IOSurface 拷出像素」的隐式成本；实现时应按 **6–8ms** 估 160×90+JPEG，按 **35ms** 估 SCK 单次截图，不要用合成源数字。

### 9.2 预期耗时模型（P1/P2/P3）

| 动作 | 估算 | 依据 |
|---|---|---|
| SCK 单窗口截图（含 filter 构造） | **30–60ms** | 35ms 实测（小区域） + filter 构造成本 |
| 160×90 缩放 + 四边带 HSV + JPEG（可选） | **<10ms** | 实测 6–8ms |
| 文本 OCR（warm accurate） | 80–100ms | 实测 |
| 文本 OCR（进程冷启动） | **~12.7s** | 实测，必须预热/常驻 |
| 1280 长边 JPEG（P3 出图） | ~1.5ms / 47–64KB | 实测 |
| 失败降级 | 见 9.4 | — |

**P1「氛围」单次总成本**（截图 + 160×90 + HSV）≈ **40–70ms**；在 90–180s 抽样下可忽略，在 10Hz 连续下不可用（应走 `SCStream`，未验证）。

### 9.3 授权后的验证脚本骨架（供 W-C 复用）

```swift
// /tmp/screen-spike/src/probe_sck_runtime.swift 的裁剪版；只在 preflight==true 时运行
guard CGPreflightScreenCaptureAccess() else { /* -> metadata 降级，不申请 */ exit(0) }
let content = try await SCShareableContent.current
guard let win = content.windows.first(where: { $0.windowLayer == 0 && $0.isOnScreen && $0.frame.width > 200 }) else {
  /* window-unavailable -> 本次跳过，不退整屏 */ exit(0)
}
let filter = SCContentFilter(desktopIndependentWindow: win)
let cfg = SCStreamConfiguration()
cfg.width = 160; cfg.height = 90; cfg.showsCursor = false; cfg.scalesToFit = true
let t0 = CFAbsoluteTimeGetCurrent()
let img = try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: cfg)
let t1 = CFAbsoluteTimeGetCurrent()            // 记录 capture ms
// 若目标尺寸是 160x90，SCK 已缩放；若要 dHash，则再取 9x8 灰度
// 像素只在内存 -> JPEG Data -> stdout JSON；不写临时文件
```

**测量口径**：连续 20 次、忽略第 1 次（冷）；报告 p50/p90/max；同时校验 `img.width/height`、JPEG 字节数、`SCStreamError` code；不要打印窗口标题/内容（日志只留 id/耗时/字节数）。
**预期误差**：单窗口尺寸在 1512×982 与 3024×1964（Retina）时处理腿差异 <2ms；SCK 截图时间主要受窗口是否被遮挡/是否在屏影响，p90 可能到 2×p50；若窗口在其他 Space/最小化，`SCShareableContent` 里可能仍出现（`isOnScreen=false`，本机 78 个里 63 个 offscreen），**capture 会失败或返回空**——按 window-unavailable 跳过。

### 9.4 连续失败 / 授权撤销的退避语义（依据）

- **错误码**（SDK 27.2 `SCError.h` 实测枚举）：`SCStreamErrorUserDeclined = -3801`（用户拒绝）、`SCStreamErrorFailedToStart=-3802`、`SCStreamErrorMissingEntitlements=-3803`、`SCStreamErrorNoWindowList=-3813`、`SCStreamErrorNoCaptureSource=-3815`、`SCStreamErrorUserStopped=-3817`；macOS 27 新增 `-3822`/`-3823`。
- **判据分离**：
  - `CGPreflightScreenCaptureAccess()==false` 或 `getMediaAccessStatus('screen') ∈ {denied, restricted, not-determined}` → **权限类失败**：立即停采样、只 warn 一次、设置页显示降级与深链；**永不重试申请**（`CGRequestScreenCaptureAccess` / 首次 `SCShareableContent` 会弹窗，本设计禁止）。
  - `-3801/-3803` → 同上（用户拒绝/缺权限）。
  - `-3813/-3815`/窗口不可得 → **瞬时失败**：本次跳过，计数 +1；连续 3 次 → 退避（1min → 5min → 15min，上限 15min），成功一次即清零（Miru 的做法）。
  - 授权恢复探测：每次轮询（低频）只做 preflight 查询（不弹窗）；从 false→true 时清零退避、恢复 `ocr`；用户点「去系统设置」深链回来后 5s 内重查。
- **日志纪律**：同一原因只记录一次（带 nextRetryAt），不刷屏；失败不写截图/不写 OCR 文本。

---

## 10. 与豆包报告的差异（需要回写修正的判定）

| # | 豆包报告原文 | 本次实测/查证 | 建议动作 |
|---|---|---|---|
| 1 | 基线 `main @ 3893943` | 当前 `main @ 4a2d8b3` | 更新基线 |
| 2 | `CGWindowListCreateImage` macOS 14+ deprecated 仍可用 | SDK 27.2 中 **obsoleted=15.0**；默认目标**编译失败**；仅部署目标 ≤14 可编译；运行期 27.2 仍可用（实测） | 改为「仅 macOS 13.x 回退，需单独编译目标 + 运行时 dlsym 探测」 |
| 3 | 「macOS 15 起系统周期性复核录屏授权」 | Sequoia 每月再确认有可靠来源（MacRumors 2024-08-15）；**macOS 27.2 是否按月无法查证**（TCC.db 读不了，无到期查询 API）；macOS 27 仍要求用户授权屏幕录制（ActivTrak 2026-11-05） | 保留「随时可能失效」的工程假设，但把「15 起每月」限定为 Sequoia 事实；27 标注 `unknown` |
| 4 | `SCScreenshotManager` 14.0+；SCK 12.3+ | 确认；补充：`captureImage(in:)` 15.2+；macOS 26 新增 `SCScreenshotConfiguration/captureScreenshot` | 补全版本表 |
| 5 | 「读窗口名/截图才需要录屏权限」 | 确认且更强：无权限时 `kCGWindowName` **键缺失**；SCK `SCWindow.title` 也需同权限 | 补「键缺失 vs 空串」 |
| 6 | AX 只查询不申请 | 查询 API 本身不弹窗；但 **AX 读标题需要辅助功能授权**，无权限时 `apiDisabled(-25211)`；`systemWide` 元素 `cannotComplete` | 规则引擎标题走录屏（CGWindowList/SCK），不要为标题申请 AX |
| 7 | 全屏判定「bounds 与 display 误差 ≤2px」 | 方向正确，但**必须 `layer==0`**（否则 Dock/壁纸/通知中心全命中）+ 与 `CGDisplayBounds` 比（勿用 `NSScreen.visibleFrame`）+ 面积比；本机未测真实全屏窗口 | 写入实现规则与「待真机复核」项 |
| 8 | OCR 50–150ms | warm 82–98ms（accurate）/8–15ms（fast）成立；**每进程首次 12.7s** | 补冷启动与常驻/预热设计 |
| 9 | `askForMediaAccess` 不支持 screen | Electron 类型定义实测：`askForMediaAccess(mediaType: 'microphone' \| 'camera')`——**确认 screen 不在支持列表**（API 类型层面） | 结论正确，可标注证据 |
| 10 | 默认档 `ocr` 的 TCC 稳定性风险 | adhoc 签名（`flags=0x2(adhoc)`、无 Team ID、无 designated requirement）→ 授权随重建失效；且开发期从终端/DSH 启动会**继承宿主 app 授权造成假绿** | 分发前必须先有 Developer ID；默认档在 adhoc 阶段建议仍为 `metadata`（或明确「仅自用测试」） |

---

## 11. 未执行项与原因（合规声明）

| 未执行 | 原因 |
|---|---|
| `CGRequestScreenCaptureAccess()` / 首次 `SCShareableContent` 在**无权限**上下文 | 会触发系统授权弹窗（任务硬约束禁止）；无权限上下文只调 preflight |
| TCC 授权弹窗 | 同上，全程 0 弹窗 |
| 修改系统设置 / 重启 / 杀 DSH / 碰 `~/.dsh` | 硬约束；探针全部只读 |
| 切换 Space / 让 app 进入全屏 / 抢焦点 | 会打扰用户桌面；「其他 Space 窗口是否出现在 winlist」按 `.optionOnScreenOnly` 语义 + `isOnScreen` + 77 vs 14 差异推断 |
| 读取 `TCC.db` 枚举授权 | 无完全磁盘访问：user TCC.db 路径在 macOS 27 不存在，system TCC.db 只读 `authorization denied` |
| 连续 `SCStream`（10Hz）采集 | 会持续显示录屏指示器 + 持续读用户画面；本次只验证单次截图与处理腿 |
| 启动/退出真实 `dist/mac-arm64/AventurinePet.app` | 会弹宠物窗口/打扰桌面；只做静态检查 + 观察已在运行的实例日志（未杀/未改） |
| 断网跑 Vision | 会影响用户网络；离线性质用文档 + 冷/热行为推断标注 |
| 麦克风 busy=true / 电池供电 | 本机无输入设备、无电池，硬件不支持验证 |
| 真实全屏窗口几何 | 需把 app 全屏（抢焦点），改为标注「待真机复核」 |

---

## 12. 证据文件索引（`/tmp/screen-spike/**`）

**源码** `src/probe_tcc.swift`、`probe_ctx.swift`、`probe_p0.swift`、`probe_p0_noperm.swift`、`probe_ax.swift`、`probe_ax_noperm.swift`、`probe_audio.swift`、`probe_sck.swift`、`sck_unguarded.swift`、`probe_sck_runtime.swift`、`probe_cgwindowimage.swift`、`probe_vision.swift`、`probe_vision2.swift`、`probe_pipeline.swift`、`probe_cap_timing.swift`、`electron_probe.js`

**二进制** `out/probe_*`；对照 app：`out/TccProbe.app`、`out/NoPermProbe.app`、`out/OpenCtx.app`、`out/NoPermDetail.app`、`out/NoPermAX.app`

**关键日志（`logs/`）**
- TCC/归责：`tcc_shell.json`、`ctx_com-spike-openctx-probe.json`、`ctx_plain-exec.json`、`tcc_log_40m.txt`、`tcc_attribution_evidence.txt`
- P0：`p0_shell2.json`、`p0_noperm_true.json`、`ax_shell.json`、`ax_noperm.json`、`audio_shell.json`、`ioreg_idle.log`、`pmset_batt.log`、`audio_profile.log`
- SCK：`sck13.log`、`sck14.log`、`sck27.log`、`sck_runtime2.log`
- 旧 API：`cgwi_build13.log`、`cgwi27.log`、`cgwi_run.log`、`cap_timing.log`
- Vision/处理腿：`vision_run.log`、`vision_warm.log`、`vision27.log`、`pipeline_run.log`
- Electron：`electron_probe.log`
- 编译日志：`build_*.log`

**截图/位图**：`evidence/vision-input.png`（OCR 输入，程序生成，非用户屏幕）

---

## 13. 外部来源（含日期，均 2026-11-11 访问）

1. MacRumors，2024-08-15：macOS Sequoia 按月重新授权屏幕录制（Allow For One Month）— https://www.macrumors.com/2024/08/15/macos-sequoia-screen-recording-app-permissions/
2. 9to5Mac，2024-08-14：周提示改月提示 — https://9to5mac.com/2024/08/14/macos-sequoia-screen-recording-prompt-monthly/
3. FavTray，2026-09-28：权限身份 = bundle id + 代码签名；Screen Recording 在启动时生效；每月再问是 macOS Sequoia 的机制 — https://favtray.com/blog/macos-permissions-after-update
4. FavTray，2026-09-28：读「麦克风/相机是否在用」不需要麦克风/相机权限；macOS 14.2+ CoreAudio 可给占用进程名 — https://favtray.com/blog/mac-mic-camera-in-use-which-app
5. ActivTrak，2026-11-05 更新：macOS 27（Golden Gate，2026-09-14 发布）DDM 不能静默授予 Screen Recording；升级后旧授权不延续 — https://support.activtrak.com/hc/en-us/articles/56996204379803-macOS-27-Golden-Gate-s-Impact-on-ActivTrak-Deployments
6. Apple Developer Forums（macOS 26.1，2026）：纯可执行文件不出现在 Screen & System Audio Recording 列表 — https://developer.apple.com/forums/thread/807898
7. Electron 类型定义（本机 `node_modules/electron/electron.d.ts`）：`askForMediaAccess(mediaType: 'microphone' | 'camera')`；`systemPreferences.getMediaAccessStatus` 支持 `screen`（Electron 44.10.2 实测返回 `granted`）
8. 本机 SDK 头文件：`/Library/Developer/CommandLineTools/SDKs/MacOSX.sdk/System/Library/Frameworks/{ScreenCaptureKit,CoreGraphics,Vision}.framework/Headers/**`（SDK 27.2，原文已在 §3/§4/§8 引用）

---

## 14. 给 W-A/W-B/W-C 的落地建议（结论化）

1. **W-A/W-B 不受阻**：P0 全部零权限、本机可行；全屏判定按 §7.2 规则实现并加「待真机复核」标记；麦克风/电池按「未在本机验证」写测试占位。
2. **P0 规则引擎不要依赖标题**：无权限时标题键缺失；标题规则只在 P2+（有录屏）求值，未知策略保持「内容级 deny」。
3. **W-C helper 形态**：单进程常驻或由主进程 spawn；SCK 路径必须先 `NSApplication.shared`；OCR 必须预热（否则首调 12.7s）；全部像素/文本内存态，stdout JSON。
4. **权限探测只查不申请**：`CGPreflightScreenCaptureAccess()`/`getMediaAccessStatus('screen')`；shallow 深链到系统设置；绝不 `CGRequestScreenCaptureAccess`。
5. **退避**：权限类失败 → 停采样 + 一次日志 + 深链；瞬时失败 → 3 次退避 1/5/15min，成功清零；授权恢复 false→true 自动恢复。
6. **发布前**：先拿 Developer ID + 公证，验证「重建后授权是否保留」；adhoc 阶段默认档建议仍 `metadata`，demo 用 `ocr` 时明确「仅本机自用」。
7. **待真机复核清单**：真实全屏窗口 bounds（§7.2）、多显示器/Retina/刘海、麦克风 busy=true、电池供电、连续 `SCStream` 10Hz 成本、macOS 27 按月再确认是否存在。
