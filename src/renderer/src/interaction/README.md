# B4 交互模块（拖拽 / 摸头 / 戳 / 注视 / 右键菜单）

> Wave 2 B4；scope：`src/renderer/src/interaction/**`。与 `core/wave2-contract.ts`
> 冻结契约、`docs/wave2-integration.md` §3-B4 对齐；纯逻辑（可单测）与 DOM 层严格分离。

## 0. 文件结构

| 文件 | 层 | 职责 |
|---|---|---|
| `controller.ts` | DOM | `InteractionController`：绑 `window` 事件、右键菜单 DOM 渲染/销毁、事件转发。**唯一对外接线入口** |
| `menu-view.ts` | DOM | 右键菜单视图（内联样式 + 原生 DOM，CSP 安全；只做渲染） |
| `interaction-core.ts` | 纯逻辑 | `InteractionCore`：把下面各状态机编排成快照/事件/回调（**可完整单测**） |
| `regions.ts` | 纯逻辑 | 宠物区域命中：head / body / leg（按 `petRect` 比例；头形略收窄） |
| `drag-machine.ts` | 纯逻辑 | 拖拽状态机（click vs drag 阈值、持续跟随、甩出速度估计）+ poke 时长判定 |
| `pat-detector.ts` | 纯逻辑 | 摸头圆形轨迹检测（头中心 + 半径带 + 带符号累积角度 + 冷却 + progress） |
| `look-tracker.ts` | 纯逻辑 | 注视目标跟踪（死区 + τ≈100ms 指数平滑 + 离开窗口 null + 2.5s 回落） |
| `menu-model.ts` | 纯逻辑 | 右键菜单状态机（打开/关闭/外部点击/键盘/动作选中/位置钳制） |
| `pointer-gate.ts` | 纯逻辑 | Wave 1 既有穿透状态机；**B4 仅扩展 `forceIntercept` 字段**（拖动/菜单期间强制拦截），既有语义/测试不变 |
| `index.ts` | — | 公共出口（`InteractionController` + 纯逻辑/常量/类型） |

> 纯逻辑模块（`regions` / `drag-machine` / `pat-detector` / `look-tracker` / `menu-model` /
> `interaction-core` / `pointer-gate`）**不 import DOM/three/electron**，可在 vitest node 环境单测。

## 1. Lead 接线（`main.ts`）

```ts
import { InteractionController } from './interaction'

// boot 时创建一次（闭包读取最新布局/配置，不要传快照值）
const interaction = new InteractionController({
  getPetRect: () => (currentLayout?.renderPet ? currentRect : null),
  getPetHeightPx: () => currentLayout?.petHeightPx ?? 0,
  isEnabled: () => true,                       // 需要时按设置窗/非主屏关闭
  onLookTarget: (target) => { lookTarget = target },   // → B1.input.lookTarget / B3
  onMenuAction: (action) => {
    if (action === 'settings') window.api.openSettings?.()
    else if (action === 'hide') void window.api.setVisible(false)
    else if (action === 'toggleAutonomous') void window.api.setConfig({ autonomous: !config.autonomous })
    else if (action === 'quit') void window.api.quit()
  },
  getAutonomous: () => config.autonomous     // 菜单「自主活动」勾选态
})
interaction.attach(window)   // 与既有 pointer-gate 的 mousemove 监听**并存**（只新增，不删除）

// 每帧（B2/B1 step 之前，事件→行为；顺序见 docs §2）：
const interactionSnapshot = interaction.getSnapshot()
const interactionEvents = interaction.drainEvents()
// 拖动/菜单期间扩大拦截范围（否则指针移出命中区会切回穿透、丢失 mouseup）：
pointerGate.update({ forceIntercept: interactionSnapshot.dragging || interaction.isMenuOpen() })
// 调试面：debug.interaction = interactionSnapshot
// 退出/热重载：interaction.destroy()
```

要点：

- **每帧必须 drain**（否则事件堆积到上限后丢弃最旧）；`getSnapshot()` 可任意次调用。
- `onEvents` 与 `drainEvents` 二选一：若给 `onEvents`，它只在 `drainEvents()` 被调用时收到本帧事件
  （返回值与回调内容相同，**不要重复消费**）。
- `pointerGate.update({ forceIntercept })` 是可选字段（默认 false）。**拖动中/菜单打开时必须置 true**
  ——这是 B4 对 `pointer-gate.ts` 的唯一扩展；`renderPet=false` 的「透明空窗永远穿透」优先级更高。
- 与 Wave 1 既有 `installPointerTracking()` 的关系：控制器自己的 `mousemove`/`mouseleave`
  监听只做交互判定，不 `stopPropagation`（菜单内部事件除外），不影响 PointerGate 的悬停拦截。
- `isEnabled()` 返回 false 时：`tick()`/输入事件会收尾（发 `dragEnd`、`hoverLeave`、注视 null、关菜单），
  之后不再产生交互事件。

## 2. `InteractionController` API

```ts
export interface InteractionControllerOptions {
  getPetRect(): Rect | null
  getPetHeightPx(): number
  isEnabled(): boolean
  onEvents?(events: InteractionEvent[]): void
  onLookTarget(target: Point2D | null): void
  onMenuAction?(action: MenuAction): void
  getAutonomous?(): boolean          // 可选扩展：菜单开关项勾选态
  now?(): number                     // 可选扩展：注入时钟（默认 performance.now）
  tuning?: InteractionTuning         // 可选扩展：调参（见 §4）
}

export class InteractionController {
  constructor(options: InteractionControllerOptions)
  attach(target: Window): void       // 幂等；换 target 自动 detach
  detach(): void                     // 解绑并复位状态（保留菜单 DOM）
  destroy(): void                    // detach + 销毁菜单 DOM（退出/热重载）
  getSnapshot(): InteractionSnapshot // { pointer, hoveringPet, dragging, patProgress }
  drainEvents(): InteractionEvent[]  // 取走并清空本帧事件
  isMenuOpen(): boolean              // 供 pointer-gate forceIntercept / 冒烟断言
}
```

## 3. 事件 / 快照语义

`InteractionEvent`（`core/wave2-contract.ts` 冻结）：

| 事件 | 触发 | Lead 消费建议 |
|---|---|---|
| `hoverEnter` / `hoverLeave` | 指针进入/离开宠物区域（按下即视为进入；开始拖动/打开菜单视为离开） | B1 悬停反应（挑眉/看用户） |
| `dragStart { pointer }` | 左键按下后位移越过阈值（默认 3px） | `PetPhysics.beginDrag(pointer)`；B1/B3 进入 `drag` 姿态 |
| `dragMove { pointer }` | 拖动中每次指针移动（**离开宠物矩形也继续**） | `PetPhysics.dragTo(pointer)` |
| `dragEnd { pointer, throwVelocity }` | 拖动松手；`throwVelocity` = 最近 ~120ms 指针速度（px/s，clamp ±4000） | `PetPhysics.endDrag()`；B3 `thrown{ speed }` |
| `poke { region }` | 短按 <250ms 且位移 < 阈值；`region: 'head'|'body'|'leg'` | B1 立即 pat/poke 反应；B3 按区域表演 |
| `pat` | 头部圆形轨迹累积角 ≥ 1.6π（≈288°）且采样 ≥8，带 1200ms 冷却 | B1 摸头反应（两段式）；B3 `pat` gesture |
| `menuAction { action }` | 菜单项选中（`settings`/`hide`/`toggleAutonomous`/`quit`） | Lead 执行对应动作 |

`InteractionSnapshot`：

- `pointer: Point2D | null`：窗口本地 CSS px（overlay 左上角为原点；与 `petRect` 同口径）；
- `hoveringPet`：当前是否悬停在宠物命中区（菜单打开/拖动中为 false）；
- `dragging`：是否处于拖动中（**只在越过阈值后**为 true；按下未动为 false）；
- `patProgress: 0–1`：摸头圆圈进度（含停手衰减；触发/冷却期间为 0）。

`onLookTarget`：平滑后的注视目标（窗口本地 px，τ≈100ms；死区 1.5px；指针离开窗口/2.5s 无移动 → `null`）。

## 4. 判定参数（可经 `tuning` 覆盖）

| 参数 | 默认值 | 说明 |
|---|---|---|
| 区域分带 | head 顶部 0–30%（水平收窄 28%–72%）；body 30–55%；leg 55–100% | 见 §5 实测依据 |
| 拖动阈值 | 3px | 2–4px 之间取中值，避免单击误判拖动 |
| poke 时长 | ≤250ms 且位移 < 拖动阈值 | 超过 → 长按，不产生 poke |
| 甩出速度窗口 | 最近 120ms；上限 4000px/s | 纯函数 `estimateThrowVelocity()` 可单测 |
| 摸头中心 | petRect 顶部下 13%、水平居中 | 模型 `頭` 骨距顶 11.3%，取面部中心 13% |
| 摸头半径带 | 0.05–0.28 × petRect 高度 | 太近=贴中心抖动，太远=大范围扫桌 |
| 摸头触发/冷却 | 累积 1.6π、≥8 采样、冷却 1200ms；单步角 >1.2rad 视为断裂 | 直线/来回蹭/穿中心不触发 |
| 摸头 progress 衰减 | 停手 350ms 后 900ms 内线性归零 | 停顿不会一直攒进度 |
| 注视 | 死区 1.5px、τ=100ms、dt 上限 100ms、2.5s 无移动回落 null | 30fps/60fps 行为一致 |
| 菜单 | 视口内钳制、安全边距 6px；四项固定顺序 | DOM 实测尺寸后二次钳制 |

```ts
new InteractionController({
  /* ... */
  tuning: {
    drag: { dragThresholdPx: 4, pokeMaxDurationMs: 220 },
    pat: { triggerAngleRad: Math.PI * 1.5, cooldownMs: 1500 },
    look: { timeConstantMs: 80 }
  }
})
```

## 5. 区域划分依据（模型实测）

按 `petRect` 高度归一化（`petRect` = 模型绑定姿势包围盒，高 ≈ 21.681 MMD 单位，见 `model/bounding.ts`）：

- `頭` 骨距顶 **11.3%**、`首` 15.5%、`左肩` 19.6%、`上半身` 37.8%、`左足` 46.1%、`左ひざ` 71.3%；
- 50% 尺寸（540px）实机截图的 alpha 剪影：头部窄段 **0–17%**、肩/手臂最宽 17–44%、腿 44–100%；
- 因此头命中带取 **顶部 0–30%（水平收窄到中间 44%）**：任务书写的「顶部 12–30%」只是头部下半部分，
  若严格只取 12–30%，用户摸头顶（0–12%）会落在区域外，摸头手势的圆心/半径带也会一半失效。
  12–30% 完整包含在 head 内，满足任务书意图。
- body 30–55%（胸/腰/髋）、leg 55–100%（大腿中段以下）。
- 头部带内但水平超出收窄范围的点（肩/手臂）归为 `body`，保证「点在宠物矩形内必有区域」；
  矩形外/非法输入 → `null`（与 pointer-gate 半开区间一致）。

## 6. 反应设计参考（B1/B3 消费；B4 只发事件，不做表演）

来自 `docs/aventurine-character-brief.md`（用户要求按砂金男性角色人设，剔除女性化娇羞卖萌）：

| 事件 | 建议反应（B1/B3） | 参考台词（B1 台词池，避免与其它场景重复） |
|---|---|---|
| `pat` | **两段式**：0.2–0.3s 僵住/头偏 → 闭眼接受、头偷偷回顶 → 意识到后直回去挑眉；连续 >3 次/10s → 招手拍开/后退 | 「喂，发型要乱了。……不过，就这一次。」/「摸头可不在合同里。想加钱？」 |
| `poke head` | 头后仰 8°、皱眉、手背拍开（`びっくり`+`怒り`，0.8–1.2s） | 「戳哪儿呢？这身衣服很贵的。」 |
| `poke body` | 缩身/耸肩、笑出声、退半步（`笑い`+`照れ` 低权重） | 「再戳，我可要收服务费了。」 |
| `poke leg` | 低头看腿、挪脚、抬眼 `じと目` | 「痒。……你故意的吧？」 |
| `dragStart/dragMove` | 被拎起：手臂上举、肩耸、腿自然垂、脚尖绷；头朝拉动方向偏 | 「喂喂，筹码可不是这么拿的。」 |
| `dragEnd`（thrown） | 四肢张开/团身 → 落地单膝撑地；`thrown.speed` 决定幅度 | 「——哈，这才叫刺激。」 |
| 双击/三连戳 | B4 按每次 tap 发多个 `poke` 事件；升级反应由 B1/B3 统计节奏决定（契约无 repeat 字段） | — |

> 不要做：蹦跳庆祝、全身一起弹的戳反应、卖萌挥手/娇羞摇摆、连续赌博黑话刷屏。
> 右键菜单是功能 UI（设置/隐藏/自主活动/退出），不触发宠物表演。

## 7. 右键菜单

- DOM 菜单挂 `document.body`，`position: fixed` + 内联样式（米白纸 + 金棕描边，与 Lead 的
  `.pet-bubble` 同语言；不改 `style.css`，符合文件所有权）；`z-index` 高、`pointer-events:auto`；
- 菜单内部 `mousedown/mouseup/click/contextmenu` 在根节点 `stopPropagation`，避免被宠物手势误判；
- 打开：宠物上右键；宠物外右键不打开；已打开时右键重新定位；
- 关闭：点击菜单外（控制器吞掉这次按下）、ESC、选中任一项；
- 键盘：ESC/↓↑/Enter 空格支持（但 overlay `focusable:false`，生产环境键盘事件通常收不到 —— 见 §9）；
- 菜单项：`设置…` / `隐藏桌宠` / `自主活动：开|关`（✓ 勾选）/ `退出`（危险色 + 分隔线）。

## 8. 测试

```bash
pnpm exec vitest run tests/interaction-      # 7 files / 112 tests
pnpm exec vitest run tests/pointer-gate      # 既有 Wave 1 回归：16 tests（forceIntercept 扩展不破坏语义）
pnpm typecheck 2>&1 | grep interaction/      # 无输出 = 本模块 0 错误
```

| 测试文件 | 覆盖 |
|---|---|
| `tests/interaction-regions.test.ts` | 分带边界（半开区间）、头形收窄、区域矩形、非法输入 |
| `tests/interaction-drag.test.ts` | click vs drag 阈值、拖动持续、甩出速度（合成轨迹/窗口/clamp）、poke 时间窗 |
| `tests/interaction-pat.test.ts` | 圆触发、直线/来回/穿中心/半径带外不触发、冷却、progress 衰减、参数覆盖 |
| `tests/interaction-look.test.ts` | 首次吸附、τ=100ms 指数平滑、死区、离开 null、2.5s 回落、dt 钳制 |
| `tests/interaction-menu.test.ts` | 菜单项/标签/勾选、位置钳制、打开/关闭/外部点击、键盘、动作选中、尺寸回填 |
| `tests/interaction-core.test.ts` | 合成事件序列：hover/poke/drag/pat/menu/禁用收尾/注视/drain 语义 |
| `tests/interaction-pointer-gate-force.test.ts` | `forceIntercept` 优先级与既有语义回归 |

DOM 层（`controller.ts`/`menu-view.ts`）不依赖 jsdom（仓库无该依赖、不新增），由 Lead 实机
验收；菜单点击可用合成 `MouseEvent` 在 renderer 控制台验证。

## 9. 已知限制 / 风险

1. **拖动丢失 mouseup 风险**：Overlay 的点击穿透由 Lead 每帧 `pointerGate.update({ forceIntercept })`
   控制。若 Lead 忘记按 `snapshot.dragging || isMenuOpen()` 强制拦截，指针离开宠物命中区后会切回
   穿透，导致收不到 `mouseup`、宠物卡在拖动。**接线时必须加**。
2. **键盘事件**：overlay 窗口 `focusable:false`（A1 设计，不抢焦点），因此 ESC/方向键在生产环境
   通常不送达 renderer；菜单关闭主路径是「点击外部」。如需 ESC 关闭，需要 Lead 在主进程
   `before-input-event` 或托盘层处理（不在 B4 scope）。
3. **区域比例与任务书数字差异**：见 §5（头 0–30% 而非 12–30%）；若 Lead 坚持 12–30%，
   改 `REGION_RATIOS.headBottom/headXMin/headXMax` 常量即可（单测同步）。
4. **双击/三连戳升级**：契约的 `poke` 无 repeat 字段，B4 按每次 tap 发独立事件；若需要单事件
   携带次数，需要 Lead 契约变更。
5. **菜单打开期间**不更新摸头/悬停/注视（指针事件被菜单接管），关闭后按当前位置补发 `hoverEnter`。
6. **拖拽中离开窗口**（鼠标移到菜单栏/另一块屏）视为松手并发 `dragEnd`（防止卡死）；
   正常情况下 overlay 覆盖整个 `workArea`，只在屏幕边缘发生。
7. 未做像素级 alpha 命中：区域判定基于 `petRect` 比例；pointer-gate 的「躯干中心带」拦截策略
   仍由 Lead 保留（B4 不改变其语义）。
