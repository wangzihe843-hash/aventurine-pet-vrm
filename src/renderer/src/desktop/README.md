# renderer/src/desktop — B5 桌面感知消费（坐窗口 / 跟随 / 关闭掉落 / 爬边缘）

纯逻辑模块：**不 import DOM / Electron / node 内置**，全部可用假数据单测
（`tests/desktop-geometry.test.ts` / `desktop-filter.test.ts` / `desktop-transitions.test.ts` /
`desktop-sensor.test.ts`）。契约类型来自 `src/renderer/src/core/wave2-contract.ts`
（Lead-owned，冻结），窗口/显示器类型来自 `@shared/types`。

## 坐标口径（必须遵守）

- 输入 `WindowInfo.bounds` / `DisplayInfo.bounds|workArea`：**屏幕全局**逻辑像素（macOS 左上原点）；
- 输出 `DesktopSurface.rect/top`、`DesktopSnapshot.workArea/screenBounds`：**overlay 窗口本地**
  CSS 像素，`local = global − overlayOrigin`（overlay frame = `display.workArea`，主屏上
  `overlayOrigin.y` 通常是 30，不是 0；**禁止硬编码 30/24**）；
- DPR 不参与换算；`window-top` 表面 rect 高 1px 占位、`top = 窗口本地 bounds.y`；
- `DesktopSnapshot.workArea` 正常等于 `{0,0,viewport.width,viewport.height}`，但仍显式由
  `display.workArea − overlayOrigin` 推导（显示器/几何变化时跟随）。

## 对外 API（`import ... from './desktop'`）

```ts
class DesktopSensor {
  constructor(options?: {
    sittableGapPx?: number      // 可坐吸附阈值，默认 24px
    closeGraceMs?: number       // 消失→确认关闭宽限期，默认 600ms（0 = 立即）
    minWindowHeightPx?: number  // 默认 80
    minWindowAlpha?: number     // 默认 0.01
  })

  updateEnvironment(env: {
    overlayOrigin: Point2D      // OverlayWindowInfo.bounds.x/y（全局）
    display: DisplayInfo        // pet:window-info.displayId 对应的当前显示器
    viewport: PetSize           // overlay 本地尺寸（#app clientWidth/Height）
    ownPid?: number             // 宠物自身进程 pid（排除 overlay 窗口）
    overlayWindowIds?: number[] // 可选扩展：overlay 窗口 id 第二保险
  }): void

  updateWindows(windows: WindowInfo[], nowMs: number): void
  snapshot(nowMs: number): DesktopSnapshot
  findSittableSurface(feet: Point2D, petSize: PetSize): DesktopSurface | null
  getClimbSurfaces(): DesktopSurface[]
  getTrackedWindowSurface(windowId: number): DesktopSurface | null
}

// 纯函数（单独可测/可复用）
diffWindowLists(previous, next, { emitOnResize? }): WindowTransition[]
coalesceTransitions(events): WindowTransition[]
sanitizeWindows(input: unknown): WindowInfo[]
isEligibleWindow(window, options?): boolean
filterWindows(windows, options?): WindowInfo[]
globalToLocalPoint(point, origin): Point2D
globalToLocalRect(rect, origin): Rect
computeDisplayInsets(bounds, workArea): DisplayInsets        // 菜单栏/Dock 差集
deriveSystemSurfaces(screenBoundsLocal, workAreaLocal): DesktopSurface[]
createWindowSurfaces(window, overlayOrigin): DesktopSurface[]
```

表面 id 约定：`win-<windowId>-top|left|right`、`menubar`、`dock-bottom|left|right`、
`screen-bottom`。`surfaces` 顺序 = 前→后：窗口（CGWindowList 顺序）→ 菜单栏 → Dock → 地面。

## 过滤规则（PLAN §11）

1. `layer === 0`（普通应用窗口；菜单栏/Dock/面板等系统窗口 layer > 0 自然排除）；
2. `alpha > 0.01`；
3. `height > 80`（小工具条/面板不作为站立面）；
4. `onScreen === true`（A4 当前恒 true，保留防御）；
5. `pid === ownPid` 或 id ∈ `overlayWindowIds` → 排除（宠物自身 overlay）；
6. 与当前显示器 `display.bounds` **无正面积交集**的窗口排除（多屏时每个 overlay 只感知自己屏）；
7. 结构非法（字段缺失 / NaN / 宽高 <= 0）的项在 `sanitizeWindows` 丢弃。

## 表面推导（菜单栏 / Dock）

由 `display.bounds` 与 `display.workArea` 的**差集**推导，不硬编码高度：

| 差集 | 表面 | rect | 可坐 | 可爬 |
|---|---|---|---|---|
| 上差 > 0 | `menubar` | workArea 顶边、高 1px | ✅ | — |
| 下差 > 0 | `dock-bottom` | workArea 底边、高 1px | ✅ | — |
| 左差 > 0 | `dock-left` | workArea 左边缘、宽 1px、高 = workArea 高 | ✅ | ✅ |
| 右差 > 0 | `dock-right` | workArea 右边缘、宽 1px | ✅ | ✅ |
| — | `screen-bottom` | workArea 底边（**总是**提供） | ✅ | — |

- 菜单栏自动隐藏：`workArea.y === bounds.y` → 上差 0 → 不生成 `menubar`；
- Dock 自动隐藏：对应差集 0 → 不生成 `dock-*`；
- 底部 Dock 存在时 `dock-bottom` 与 `screen-bottom` 同 y，`dock-bottom` 排序更靠前（Dock 优先）。

## 窗口变化事件（transitions）

- `appeared` / `moved{delta}`（位置或尺寸变化；纯 resize 时 delta = {0,0}）/ `closed`；
- **同一窗口同类事件只报一次**：一帧内多次 `updateWindows` 的 moved delta 相加；`appeared+closed`
  净效果取消；`snapshot()` 返回后清空（main.ts 每帧取走）；
- **首份窗口列表只做基线**，不产生 appeared 噪声（与 A4「首次成功轮询只做基线」对齐）；
- **宽限期去抖**（`closeGraceMs`，默认 600ms）：窗口从列表消失（最小化 / 切 Space /
  显示器分离空间）先保留表面、不立刻 closed；宽限内原样回来 → 无事件；超时才 `closed` +
  移除表面（宠物掉落）。`closeGraceMs: 0` 时下一次 `snapshot` 立即确认（单测用）。
  宽限期内保留的 `window-top` 表面 **`sittable=false`**：几何仍在（B2 支撑/跟随不误掉），
  但窗口已不可见，不作为 B1 的新坐/爬目标（与「被前层窗口挡住的顶边不能坐」一致）。
- 环境（显示器 / workArea / ownPid）变化时静默重建跟踪基线，不把整屏窗口当成 appeared。

## 可坐 / 可爬判定

- `findSittableSurface(feet, petSize)`：`|feet.y − surface.top| < sittableGapPx`（默认 24px）、
  `feet.x ∈ [rect.x, rect.x+rect.width]`、表面宽度 ≥ 宠物宽度一半；按前→后扫描 →
  **重叠时优先前台窗口**，其次菜单栏/Dock/地面。
- `getClimbSurfaces()`：所有 `climbable` 表面（窗口左右边缘 + 侧边 Dock 内边缘）。
- `getTrackedWindowSurface(windowId)`：按 id 取当前 `window-top` 表面（跟随窗口后重新锚定）。

## Lead 接线（`src/renderer/src/main.ts`；B5 不碰这些文件）

```ts
const desktopSensor = new DesktopSensor()

// 1. 环境：overlay 几何 + 当前显示器 + 视口
async function refreshDesktopEnvironment(): Promise<void> {
  const [windowInfo, displays] = await Promise.all([
    window.api.getWindowInfo(),
    window.api.getScreenInfo()
  ])
  const display = displays.find((d) => d.id === windowInfo.displayId)
  if (!display) return
  desktopSensor.updateEnvironment({
    overlayOrigin: { x: windowInfo.bounds.x, y: windowInfo.bounds.y },
    display,
    viewport: { width: app.clientWidth, height: app.clientHeight }
    // ownPid / overlayWindowIds 可选：A4 已在主进程按 process.pid 过滤自身 overlay 窗口，
    // 且 renderer 拿不到主进程 pid / CGWindow number；这两项只是消费侧二重保险（单测用）。
  })
}

// 2. 窗口列表：**先订阅、后 invoke 基线**（A4 首次轮询不广播）
const unsubscribeWindows = window.api.onWindowsUpdated((windows) => {
  desktopSensor.updateWindows(windows, performance.now())
})
void window.api.getWindows().then((windows) => {
  desktopSensor.updateWindows(windows, performance.now())
})

// 3. 显示器变化 / resize → 重算环境（禁止启动快照）
window.api.onScreensUpdated(() => void refreshDesktopEnvironment())
window.addEventListener('resize', () => void refreshDesktopEnvironment())

// 4. 每帧（B1 决策前）：
const desktop = desktopSensor.snapshot(performance.now()) // → BehaviorInput.desktop
// surfaces/transitions/workArea/screenBounds 交给 B1；B2 用 surfaces 落点。
```

顺序建议：`updateEnvironment` 先于首份 `updateWindows`（否则首屏窗口在环境到达后静默重建基线，
仍能正确出表面，只是没有 appeared 事件，属预期降级）。

## 已知限制 / 风险

- `onScreen` 当前恒 true（A4-F12），窗口「关闭」只能靠列表存在性 + 宽限期判断；最小化/切 Space
  在宽限期内不会被误判（但宽限期内的表面位置是旧值）。
- 窗口 z 序顺序即 `CGWindowList` 顺序，不做额外排序；同位置重叠时前者优先（符合 PLAN）。
- 窗口顶边被前层窗口遮挡的部分不生成 `window-top` 表面（按可见区间裁剪、每段一个 id）；
  完全被遮住 → 该窗口不可坐。宽限期窗口保留 `window-top` 几何但 `sittable=false`。
  非顶边的本体遮挡（宠物身体压在前层窗口上）B5 不感知，由 B1/B4 侧判断。
- 跨屏迁移：本模块只感知当前 overlay 所在显示器的窗口；宠物跨屏由 B5/C4 后续决定。
- **显示器 / workArea 变化不产生 `closed`**（环境变化走静默 rebaseline，避免整屏窗口误报）：
  Lead 在 `screens-updated` 后若宠物原本站在窗口上，需要按 `snapshot().workArea` 做一次
  `teleport`/复位（B2 `MotionCommand.teleport`），不要等 B5 的 transition。
- `closeGraceMs` 默认 600ms（> A4 的 500ms 轮询周期）；若 Lead 更希望「最小化立即掉落」，
  构造时传 `closeGraceMs: 0`（则下一次 `snapshot` 即确认，单测已覆盖该路径）。
- `screen-bottom` 在底部 Dock 存在时与 `dock-bottom` 同 y（契约要求两者都提供、Dock 优先）。
