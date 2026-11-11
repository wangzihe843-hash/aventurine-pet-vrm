# 调查报告：被拎起后从高处落下，为什么不停在窗口上（2026-11-09）

> 状态：**只读调查，未改任何项目代码**。本文件为新增研究文档。
> 本机取证手段：读源码/文档、跑 `native/winlist` 助手一次、读既有 dev debug 快照、
> 在 `/tmp/petdiag` 用项目物理类跑离线复现（临时脚本不在仓库内）。
> 联网来源：GitHub / B 站 / Unity 官方文档 / Apple 文档 / 少量 StackOverflow、掘金（3 个子代理并行调查）。

## 0. TL;DR

**不是重力/穿透/积分器的 bug。** 落地检测本身是对的（用实机 surfaces 离线复现：只要下落路径上
真的存在一条"够得着的窗口上沿"，宠物会准确停在上面）。

真正的问题是：**用户当前桌面布局下，唯一存在的窗沿在 y=36（贴屏幕顶），而拖拽链路让宠物脚底最高
只能到 270~500px，永远在窗沿下方 → 松手只会落到屏幕底部。** 同时，"把宠物放到窗口上面"这个最
自然的操作在架构上不被承认：代码只认可"自由落体过程中脚底跨越窗口顶边"，不认可"松手时宠物压在
窗口上"。两者叠加 = 用户看到"怎么都不停在窗口上"。

## 1. 本机只读取证（实机证据）

### 1.1 窗口枚举链路正常，权限不是问题

`native/winlist/.build/winlist` 实际运行成功，输出访达 / VS Code / DeepSeek Harness 等窗口
（只读公开元数据，bounds/layer/alpha/onScreen，**不需要录屏权限**；宠物自身 overlay layer=1000 会被过滤）。
`~/Library/Application Support/aventurine-pet/logs/main.log` 中也没有 `winlist helper failed` 记录。
→ H1「表面列表为空/权限缺失」在本机**不成立**（但仍应保留日志/断言防回归，见 §2-H4）。

### 1.2 实机 debug 快照：桌面上一共只有 8 条表面，唯一窗沿贴屏幕顶

取自本机 dev 捕获（`tests/tmp/startup-pose/after-final-readyprobe/startup-debug.json`，
overlay 工作区 1920×963，`workArea.y` 对应全局 y=30）：

| 表面 id | kind | top（overlay 本地 px） | x / width | sittable |
|---|---|---|---|---|
| `win-2179-top` | window-top | **36** | 320 / 1280 | true |
| `win-2179-left/right` | window-side | 36 | — | false |
| `win-61-left/right` | window-side | 110 | — | false |
| `menubar` | menubar | 0 | 0 / 1920 | true |
| `dock-bottom` | dock | 961 | 0 / 1920 | true |
| `screen-bottom` | screen-bottom | 961 | 0 / 1920 | true |

关键点：
- **只有最前台窗口（DSH 窗口，global y=66 → 本地 36）生成了 `window-top` 表面**；
  其它窗口（VS Code 等）的顶边被前台窗口遮挡，按"可见顶边段"裁剪后**一条窗沿都不剩**。
  这是 2026-11-08 为修「虚空坐」专门做的 `createWindowSurfaces → visibleTopEdgeSegments` 策略。
- 于是整屏唯一可落脚的窗沿在 **y=36**（几乎贴菜单栏），而地面在 y=961。

### 1.3 离线复现（真实几何 + 项目里的 `PetPhysics` 类）

在 `/tmp/petdiag` 用上面这份真实 surface 数据 + 真实拖拽操作序列（抓起 → 抬到屏幕顶 → 停住 → 松手）：

| 场景 | 抓取位置 | 松手时 feet.y | 落点 |
|---|---|---|---|
| A | 抓身体中部（偏移 270） | **270** | 屏幕底（dock/screen-bottom 961） |
| B | 抓头部（偏移 500） | **500** | 屏幕底 961 |
| C（对照） | 同上 A，但桌面假设多一条 **y=600 的可见窗沿** | 270 | **稳稳停在 y=600** ✅ |
| D（边界） | 快速向上甩（-4000px/s）越过 y=36 | — | **回落时停在 y=36 窗沿** ✅ |

结论：`findLandingSurface(fromY→toY)` 的下落扫掠、落地吸附、窗口上沿支撑都正常工作。
A/B 落底不是"穿过了窗沿"，而是**松手位置下方根本没有窗沿可穿**。

### 1.4 为什么"拎到最高"也到不了 y=36

`PetPhysics` 的拖拽锚点是**脚底 (feet)**（`feet = pointer + 抓取偏移`），并对 feet 做 workArea clamp：

- 抓身体中部 → 偏移≈270 → 鼠标推到屏幕最上（pointer.y=0）时 feet 最低 **270**；
- 抓头部 → 偏移≈500 → feet 最低 **500**；
- 只有抓脚底（偏移 0）才能把 feet 推到 0~36 —— 但那时宠物整体在屏幕外，用户看不到它。

所以"把宠物拎到高处再松手"这一操作，**物理上永远在 y=36 窗沿的下方**，下落过程中不可能跨越该窗沿。

## 2. 根因候选（按可能性排序）

| # | 假设 | 证据 | 状态 |
|---|---|---|---|
| H1 | **窗沿可达性**：拖拽 feet clamp + 抓取偏移，使最高松手位置（270/500）永远低于唯一窗沿 36 | §1.3/§1.4 复现 | **本机主因** |
| H2 | **可见段裁剪让窗沿极少**：前台大窗遮住其它窗口顶边 → 全屏只剩 1 条窗沿，且贴屏幕顶 | §1.2 实机快照 | **本机主因（叠加）** |
| H3 | **"放到窗口上"语义缺失**：只认"下落跨越顶边"，不认"松手时宠物压在窗口/标题栏上" → 最自然的用户操作必然失败 | 代码路径 + 参考 Desktop Mate / Shimeji 语义 | **设计缺口（最该修）** |
| H4 | 时序/权限/坐标风险：500ms 轮询快照滞后；Space/全屏窗口被 CGWindowList 排除；`kCGWindowName` 需要录屏权限（禁止按标题过滤）；rAF 被 Chromium occlusion/backgroundThrottling 降频 | 外部资料 §3.4/§3.5 | 次要，但应加观测防回归 |
| H5 | 高窗沿被坐姿过滤：`filterDesktopTargetsForPet` 的 headroom 规则会把 y=36 这类高窗沿 `sittable=false`，即便落到那里也不会"坐下" | 代码 | 待实机验证（落到 36 后行为如何） |

## 3. 外部方案与依据

### 3.1 最同构先例：`xiangzi1025/desktop-pet-macos`（Electron + macOS 桌宠）

- <https://github.com/xiangzi1025/desktop-pet-macos>
- README FAQ 明确：**"窗口顶部"功能需要 macOS 辅助功能授权；未授权时表面列表为空，宠物只沿屏幕
  底部/边缘活动**——症状与本 bug 同构，值得逐条对照。
- `main.js`：用 `osascript/System Events`（Accessibility，非 CGWindowList）枚举可见窗口
  pos/size，约 1200ms 轮询 + 缓存，按进程名排除自身，宽<120 或高<80 丢弃。
- `behavior.js`：可直接对照的穿越判定——`candidateY = ledge.y - height + 20`（脚底偏移）、
  中心 x 落在 `[x+18, x+width-18]`、`crosses = prevY <= candidateY+4 && nextY >= candidateY`、
  只接受比地面更高的面、`velocity.y >= 0 && pos.y >= support.y` 才吸附、dt 上限 0.034s。
  → 我们缺的正是 **±4px 容差** 和 **"松手时已压在窗沿带内"的吸附分支**。

### 3.2 行业语义：放上去 = 吸附到窗口边缘，而不是必须下落穿越

- **Desktop Mate**（Steam，官方文案 "they sit on your windows"；项目内 `docs/anim-reference-v2.md`
  有截图参考）与 **Mate Engine** 对比视频：<https://www.bilibili.com/video/BV1cAaRzQEsR/>
- **Ark-Pets**：官方功能"桌宠可以站立在打开的窗口的边缘上"，但窗口句柄 API 依赖 JNA、仅 Windows
  → 该能力天然是平台原生依赖：<https://github.com/isHarryh/Ark-Pets>（[Q&A](https://github.com/isHarryh/Ark-Pets/blob/main/docs/Q%26A.md)）
- **Shimeji 系（`activeIE` = 活动窗口四边框）**：把活动窗口当成有 top/left/right/bottom 边的
  "Interactive Environment"，动作 `FallWithIE` / `WalkWithIE` / `ThrowIE` 允许宠物 cling 到窗口
  边缘再爬上去；只跟踪**活动窗口**（EWMH `_NET_ACTIVE_WINDOW`），多屏地面按共享底边合并。
  - <https://github.com/danhab99/shimeji-rs>（README + `docs/CLEANROOM_REWRITE.md`，含 activeIE/borders 兼容性坑清单）
  - <https://github.com/pixelomer/Shijima-Qt>（跨平台 Shimeji，Platform Notes：macOS 访问前台窗口需辅助功能权限）
  - B 站：LUMI 桌宠（基于 shimeji-ee）官方把"攀爬窗口 / 拎起抛掷跌落"当卖点：
    <https://www.bilibili.com/read/cv52841421>
- 启示：**"扔/放到窗口上"应建模为"命中窗口边缘 → attach/climb → 站/坐在上沿"**，而不是只做
  自由落体穿越检测。macOS 上若要"活动窗口"概念，可用 `NSWorkspace`/AX 获取前台窗口（需授权）。

### 3.3 Unity 2D 物理教训（用户点名 Unity 侧）

- Discrete vs CCD：步末重叠检测会漏掉两步之间的碰撞 → 修法只有"提高物理频率 / 上 CCD"：
  <https://docs.unity3d.com/6000.1/Documentation/Manual/discrete-collision-detection.html>
- Sweep-based CCD：沿本步位移扫掠求 TOI、推进到最早接触时刻再重算速度：
  <https://docs.unity3d.com/6000.1/Documentation/Manual/sweep-based-ccd.html>
  → 我们的 `findLandingSurface(fromY→toY, 取 min top)` 语义等价，**积分器不用改**。
- `CollisionDetectionMode2D.Continuous`：<https://docs.unity3d.com/6000.1/Documentation/ScriptReference/CollisionDetectionMode2D.Continuous.html>
- **移动 collider 必须每帧重匹配**（窗口在 500ms 轮询间会被拖动/切前台 = 移动平台）：
  <https://docs.unity3d.com/6000.1/Documentation/Manual/choose-collision-detection-mode.html>
- `Time.maximumDeltaTime` / FixedUpdate：慢帧钳 dt + 限制单帧物理步数；物理跑固定步长而非 rAF 可变 dt：
  <https://docs.unity3d.com/6000.1/Documentation/ScriptReference/Time-maximumDeltaTime.html>
  <https://docs.unity3d.com/6000.1/Documentation/ScriptReference/MonoBehaviour.FixedUpdate.html>
- 薄碰撞体（我们的窗沿是 1px 线）最容易穿透：把可落面建成"有厚度的区间"更稳。
- Unity 桌宠窗口生态：`UniWindowController` 只控制**自身窗口**（透明/置顶/点透），
  <https://github.com/kirurobo/UniWindowController>；`uWindowCapture` 仅 Windows，
  <https://github.com/hecomi/uWindowCapture> → macOS 读别的窗口只能走 CGWindowList / AX，
  我们的 Swift 助手方向是对的。

### 3.4 macOS 窗口 API 与权限事实（决定方案边界）

- `kCGWindowBounds`：全局 screen space，原点为主显示器左上角，可为负/跨屏 → overlay 局部坐标必须按
  display.bounds 平移，Retina 下不乘 scale：<https://developer.apple.com/documentation/coregraphics/kcgwindowbounds>
- `CGWindowListCopyWindowInfo` + `optionOnScreenOnly`：只返回屏上窗口、front→back 顺序、一次性快照
  （文档称 "relatively expensive"）→ z 序可靠，但几何最多滞后一个轮询周期：
  <https://developer.apple.com/documentation/coregraphics/cgwindowlistcopywindowinfo(_:_:)>、
  <https://developer.apple.com/documentation/coregraphics/cgwindowlistoption/optiononscreenonly>
- `kCGWindowName`：可选键，Catalina 起无录屏权限恒为 nil；**永远不要按窗口名过滤**：
  <https://developer.apple.com/documentation/coregraphics/kcgwindowname>、
  <https://stackoverflow.com/questions/59337022/enabling-screen-recording-api-in-catalina-kcgwindowname>
- 权限表：窗口列表本身不需录屏/AX；窗口 name 需 Screen Recording；全屏/Space 检测需
  `SCShareableContent` 而非 CGWindowList：<https://pub.dev/packages/macos_window_toolkit>；
  另见 <https://github.com/trycua/cua/issues/3502>（bounds 免授权实测）
- CGWindowList 会排除部分窗口（`sharingState=None`）、AX 也取不到别的 Space 的窗口：
  <https://github.com/privateai0/macos-window-privacy-research>（社区研究，非官方）
- Electron：透明/点透 overlay 曾被 macOS occlusion checker 误判为遮挡物，导致下层 renderer
  `visibilityState=hidden` 且 background-throttled；另有 backgroundThrottling 对 rAF 的已知问题
  → 保险起见主窗口可设 `backgroundThrottling:false` / 必要时 `powerSaveBlocker`：
  <https://github.com/electron/electron/pull/52389>、<https://github.com/electron/electron/issues/9567>

### 3.5 B 站 / 中文社区（用户点名 B 站侧）

- **B 站没有"让桌宠站在其他窗口上沿/窗台"的专项教程**（关键词均无对口结果）；"窗口交互"能力集中在
  Shimeji-ee 系（LUMI 桌宠基于它），Electron/Unity/UE 的 VRM/Live2D 桌宠普遍不做窗口碰撞。
- 社区土法印证症状：Coopanion 改造视频"物理引擎改为零重力悬浮，不再受重力影响掉回底部"
  → "只会掉到底"是常见症状，土法是**关重力**而非实现窗台碰撞：
  <https://www.bilibili.com/video/BV18YHV6CE4T/>
- 同栈踩坑（Electron+Vue3+three.js+VRM）：高 DPI 拖动窗口被系统改尺寸、MToon 禁用 toneMapping、
  raycast 把 FPS 60→9：<https://www.bilibili.com/read/cv52249870>
- 窗口透明/点透/置顶教程（Windows 向，可当入门）：
  <https://www.bilibili.com/video/BV1uQaWzmEg8/>、<https://www.bilibili.com/video/BV1wN411q7ys>
- 窗口跟随/吸附（Windows 系思路，mac 需换 CGWindowList）：
  <https://www.bilibili.com/video/BV18c411M7uP/>、<https://www.bilibili.com/video/BV1CFfLYNE2E>
- 全屏透明置顶 Electron 宠物拖垮桌面合成/截屏的翻车案例（架构相关）：
  <https://www.bilibili.com/video/BV12Gx56DEzb/>
- 中文工程长文《桌宠穿透不是一行 SetWindowLong》（40ms 矩形命中、多屏 clamp、置顶是状态不是常量）：
  <https://juejin.cn/post/7705683246910177307>

## 4. 建议修复方向（下一轮实现；本轮不改代码）

优先级 P0 → P2：

1. **P0：增加"放置到窗口上"语义（H3）**。`endDrag` 时用"整窗矩形 + z 序"命中宠物下方的窗口：
   若宠物身体/脚底落在该窗口内（尤其标题栏/上沿 40~60px 带内），直接吸附到该窗口上沿并进 `sit`
   （或先播 0.2s climb 再落地），不再要求"下落穿越顶边"。
   - 需要 B5 额外提供**完整窗口矩形**（当前 `DesktopSurface` 只有 1px 顶边段和侧边），或复用
     `windowId → WindowInfo.bounds` 映射。
   - 参考 §3.1/§3.2 的语义；`activeIE` 思路（只认前台窗口四边框）可作为最小实现，代码量最小。
2. **P0：给落地/支撑与"坐/爬目标"分层（H2/H5）**。遮挡裁剪保留给"坐下目标"（防虚空坐），
   但**落地/支撑不应该被同一套裁剪卡死**；同时明确高窗沿（贴屏幕顶）到达后是站还是坐
   （headroom 规则当前会把 y=36 判 `sittable=false`，可能导致落上去但不坐）。
3. **P1：修拖拽可达性（H1）**。至少允许"放置"语义绕过 feet clamp；或把拖拽锚点改为身体矩形
   （允许宠物部分出屏），使脚底能到 0~36；否则最高的唯一窗沿永远够不到。
4. **P1：加容差与首帧修正**：`±4px` 吸附带；`velocity.y >= 0` 才吸附；松手当帧主动刷新一次
   surfaces；窗口在移动中时每帧重匹配（Unity §3.3 教训）。
5. **P2：时序/性能加固**：拖拽/落地前后提高轮询频率（500ms→100~200ms 或事件驱动）；
   `backgroundThrottling:false`；加"surface 数量/前 3 条/被过滤原因"的 debug 埋点与空列表断言。
6. **P2：可观测性**：debug 面板展示 surfaces + motion（落地瞬间的 fromY/toY），便于 5 分钟复现。

## 5. 5 分钟验证清单（下一轮可照做）

1. 开 dev，抓一只宠物，打开 debug 快照：确认 `desktop.surfaces` 里是否有 `window-top`、
   其 `top` 是多少、`motion.feet.y` 松手瞬间是多少；对比 §1.2 的实机快照。
2. 把宠物拎到最高（看到脚底最高停在 270 或 500 左右即中 H1）→ 松手；
   若落在 961 → 符合本报告结论（不是穿透，是没有窗沿可穿）。
3. 打开一个**上沿在屏幕下半部、且不被前台窗口遮挡**的小窗口，把宠物拎到它上方松手：
   应能停在它的上沿（§1.3-C 的对照）。若此时仍落底 → 再去查 H4（坐标/时序/权限）。
4. 快速向上甩（或抓脚底把 feet 推到 0~36 再松手）：应能停在 y=36 窗沿（§1.3-D）。
5. 若有异常：抓 `main.log`（winlist failed?）+ renderer debug `desktop.surfaces` 数量。

## 6. 调查方法说明

- 本轮**未修改任何项目代码**；仅新增本报告文件。
- 本地验证在 `/tmp/petdiag`（symlink 项目 `node_modules`，vitest 直接 import 项目 `PetPhysics`），
  脚本不入库；用真实 debug 快照的 surfaces 数据复现。
- 联网调查由 3 个子代理并行完成：GitHub 侧、B 站侧、Unity/相关社区侧；所有 URL 由子代理核对过
  可访问性，正文未能打开的条目标注"未验证"。

---

## 7. 后续（2026-11-10 已实施）

按本报告 §4 的 P0/P1 优先级完成修复并实机验证，实现与证据见
[window-landing-fix-2026-11-10.md](./window-landing-fix-2026-11-10.md)：
松手放置（可坐窗沿吸附坐下 / 高窗沿原地站定待机）、±4px 贴沿吸附、winlist 轮询 250ms、dev 放置抓图钩子。
