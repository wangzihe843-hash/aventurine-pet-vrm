# native/winlist — Swift 窗口枚举助手（A4）

macOS 端的极小 Swift 命令行工具：调用 `CGWindowListCopyWindowInfo` 枚举**屏幕内窗口**，
以 JSON 输出窗口 id / pid / owner / layer / alpha / bounds / onScreen，供主进程
`pet:windows` IPC（`src/main/desktop/winlist.ts` → `src/main/ipc/desktop.ts`）每 500ms 轮询，
再推送给渲染进程做桌面感知（B5 坐窗口上沿 / 跟随移动 / 关闭落下；C1 真实拖窗）。

## 权限：不需要录屏权限

只读取窗口的**公开元数据**（`kCGWindowNumber` / `kCGWindowOwnerPID` / `kCGWindowOwnerName` /
`kCGWindowLayer` / `kCGWindowAlpha` / `kCGWindowBounds` / `kCGWindowIsOnscreen`）。

> macOS 上需要「屏幕录制」权限的是**窗口标题**（`kCGWindowName`）与画面内容；本助手
> **不读取标题、不截图**，因此首次运行不会弹权限申请，也不会被 TCC 拒绝
> （PLAN §10 / §18.1 已实测）。

## 编译：universal（arm64 + x86_64），最低 macOS 13.0

Electron 44 的 `LSMinimumSystemVersion` 是 13.0；helper 必须能在 macOS 13 及以上执行，
因此产物是 universal 二进制。本机 `swiftc` 6.4 不支持 `-arch`，`scripts/build-native.mjs`
对每个架构分别用 `-target` 编译，再 `lipo -create` 合并（中间 thin 产物会删除）：

```bash
swiftc -O -target arm64-apple-macos13.0  -o .build/winlist.arm64  main.swift -framework CoreGraphics
swiftc -O -target x86_64-apple-macos13.0 -o .build/winlist.x86_64 main.swift -framework CoreGraphics
lipo -create -output .build/winlist .build/winlist.arm64 .build/winlist.x86_64
```

需要 macOS + Xcode Command Line Tools（自带 `swiftc` / `lipo` / `vtool`；缺失时
`xcode-select --install`）。日常使用脚本即可：

```bash
# 在仓库根目录（或任一 worktree 根目录）执行
node scripts/build-native.mjs          # 编译 universal → native/winlist/.build/winlist（幂等）
node scripts/build-native.mjs --check  # 架构 + minos + 实际运行 --json 校验
pnpm native:build                      # 同上（package.json 脚本别名）
pnpm native:check
```

- `pnpm dev` 的 `predev` 与 `pnpm build` 的 `prebuild`（`scripts/prebuild.mjs`）已自动接线：
  正常开发流程不需要手动构建（C-02）。
- **预编译产物不入库**：`.gitignore` 的 `native/**/.build/` 已忽略；历史上误 track 的
  `winlist` / `winlist.stamp` 已 `git rm --cached`（磁盘文件保留），干净 clone 后由
  predev/prebuild 自动重建（R-30）。
- **幂等判据是 build signature**：源码 sha256 + 构建脚本 sha256 + `swiftc` 版本 + 每架构
  `-target` flags + 宿主 platform/arch + `minMacosVersion` + 架构列表 + 输出路径，写入
  `native/winlist/.build/winlist.stamp`。改源码 / flags / 换 toolchain / 改脚本 / 换机器
  都会触发重编；且只有产物通过 `lipo` 架构与 `vtool` minos 校验才会被判为 up-to-date。
  注意 signature 是构建缓存指纹，**不是** codesign 签名。
- `--check` 用于 CI / 启动前置校验：缺失、不可执行、非 universal（缺 arm64/x86_64）、
  **任一架构 slice 的 `minos !== 13.0`**（每个 slice 都必须等于 Electron 44 最低系统 13.0；
  旧实现用「本机 macOS」当上界，在 macOS 27 开发机上会放过 minos 14/27 的产物 = 假绿）、
  **运行 `--json` 失败 / 超时（5s）/ 输出不是
  JSON 数组** → exit 1 并打印 `BUILD_NATIVE_FAIL`。
- 可用 `SWIFTC=/path/to/swiftc node scripts/build-native.mjs` 显式指定编译器；未显式设置时，
  PATH 解析出的 swiftc realpath 必须位于 `/usr/bin/`、`/Library/Developer/CommandLineTools/`
  或 `/Applications/Xcode.app/` 之一，否则拒绝执行（R-28）。
- 已知 x86_64 编译会出现 `libswiftCompatibilityPacks.a` 只有 arm64 的 linker warning
  （兼容包在 macOS 13+ 不需要），不影响产物。

## 用法

```bash
native/winlist/.build/winlist --json    # 输出 JSON 数组（默认行为；--json 可省略）
native/winlist/.build/winlist --help    # 用法
```

参数错误 / `CGWindowListCopyWindowInfo` 失败：stderr 输出 `{"error":"..."}`，exit 2；
成功 exit 0。

## 输出格式

stdout 是**单个 JSON 数组**（`JSONEncoder.sortedKeys`，单行），字段与冻结契约
`src/shared/types.ts` 的 `WindowInfo` 一致：

```json
[
  {
    "alpha": 1,
    "bounds": { "height": 820, "width": 1280, "x": 323, "y": 89 },
    "id": 857,
    "layer": 0,
    "onScreen": true,
    "owner": "访达",
    "pid": 526
  }
]
```

| 字段 | 来源 | 说明 |
|---|---|---|
| `id` | `kCGWindowNumber` | 窗口 id（C1 拖窗时使用） |
| `pid` | `kCGWindowOwnerPID` | 所属进程；主进程会过滤自身 pid（宠物 overlay 不算桌面窗口） |
| `owner` | `kCGWindowOwnerName` | 应用名（可能是中文 / 空格） |
| `layer` | `kCGWindowLayer` | 层；普通应用窗口为 `0`（B5 吸附首选 `layer==0`） |
| `alpha` | `kCGWindowAlpha` | 不透明度，缺省 `1.0` |
| `bounds` | `kCGWindowBounds` | 屏幕全局逻辑像素（左上原点），四舍五入为整数；异常超大坐标钳制到 Int32 范围 |
| `onScreen` | `kCGWindowIsOnscreen` | 是否在屏，缺省 `true`；当前因 `.optionOnScreenOnly` **恒为 true**（见下） |

行为约定：

- 只枚举 `.optionOnScreenOnly`（在屏）+ `.excludeDesktopElements`（排除桌面元素）；
- 顺序即 `CGWindowList` 的前后顺序（**前面的窗口在前**，z 序有意义，消费侧不得排序后再比较）；
- 跳过 `width <= 0 || height <= 0` 的窗口（隐藏辅助窗）；
- 最多输出 2000 个窗口（异常环境下防御性上限）；
- 不读取窗口标题 —— 因此无需录屏权限。

## 消费方注意（B5 桌面感知 / C1 拖窗必读）

1. **`pet:windows` 首次成功轮询只做基线、不广播 `windows-updated`**（A4-F03/F06 设计保留，
   避免启动期把「首次拿到列表」误当成窗口变化）。消费方订阅 `windows-updated` 后，必须先
   `invoke('pet:windows')` 取首份列表作为基线；之后才依赖事件增量。
2. **`.optionOnScreenOnly` 的「消失」不等于「关闭」**（A4-F08）：窗口最小化、切到其它 Space /
   显示器分离空间时都会从列表消失。B5 不要把它直接当成「窗口关闭 → 宠物落下」，
   建议用窗口 `id` 短期记忆 + 多次确认（去抖）区分「暂时不可见」与「真正关闭」。
3. **`onScreen` 当前恒为 `true`**（A4-F12）：该字段保留给未来枚举隐藏窗口的实现，
   当前不能用它区分「在屏 / 离屏」；列表存在性才是唯一信号。
4. **`windows-updated` payload 是完整列表**（顺序即 z 序），不是 diff。

## 相关文件

- `main.swift`：本助手的全部实现（无第三方依赖）；
- `scripts/build-native.mjs`：编译 / `--check` 脚本；
- `src/main/desktop/winlist.ts`：TS 封装（JSON 校验、spawn 超时、自身 pid 过滤、变化检测）；
- `src/main/ipc/desktop.ts`：`pet:windows` handler + 500ms 轮询 → `windows-updated` 广播；
- `tests/winlist.test.ts`：解析 / 变化检测 / 注入 fake spawn 的降级路径单测（不需要本二进制）。

## 打包（留给 Wave 3 C4）

`.build/` 不入库，打包时需要把**本机重建的 universal 二进制**放进
`Contents/Resources/native/winlist/winlist`（`defaultWinlistPath()` 在 `app.isPackaged`
时读取该路径）。打包前应校验 `lipo -info` 含 `arm64`/`x86_64`、`vtool -show-build`
的 `minos ≥ 13.0`（直接跑 `node scripts/build-native.mjs --check` 即可）。C4 未接线前，
打包版助手 spawn 失败会在主进程降级为 `[]` 并只 warn 一次，不影响 app 启动。
