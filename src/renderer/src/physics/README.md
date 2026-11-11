# physics — B2 运动与物理（`PetPhysics`）

Wave 2 B2。重力 / 地面摩擦 / 边界碰撞 / 窗口上沿（窗口上沿 / 菜单栏 / Dock）落地 /
拖拽平滑跟随 / 甩出速度估计的**纯逻辑**实现。不 import `three` / DOM / Electron / node 内置，
全部数值由注入的 `dt` / `nowMs` 驱动，可在 vitest node 环境直接单测。

Scope：`src/renderer/src/physics/**` + `tests/physics-*.test.ts`（Lead 持有接线与其它模块）。
契约类型见 `src/renderer/src/core/wave2-contract.ts`（`MotionSnapshot` / `MotionCommand` /
`DesktopSurface` / `Point2D` / `PetSize`，冻结，不由本模块修改）。

## 坐标系与单位

| 项 | 口径 |
|---|---|
| 坐标 | **overlay 窗口本地 CSS 像素**：原点 = 窗口左上角，x→右、y→下（与 `model/layout.ts` 的 `petRect` / `feetY` 完全同口径） |
| 位置权威 | `MotionSnapshot.feet`（宠物脚底锚点）唯一权威；Lead 用 `petRect = {x: feet.x - w/2, y: feet.y - h, w, h}` 摆放 |
| 时间 | `step(dt, nowMs)`：dt 单位**秒**（main.ts 已钳制 ≤0.1，本模块再兜底），nowMs 单位**毫秒**（只用于拖拽甩出速度估计） |
| 速度/加速度 | px/s、px/s²（y 向下为正，所以重力 +2400 → 向下加速） |
| 宠物尺寸 | 只用 `petSize.width / 2` 做左右墙与"脚底点 + 宠物半宽"的横向支撑判定；不关心模型宽高比 |

## API

```ts
import { PetPhysics } from './physics'
import type {
  DragEndResult, PhysicsEnvironment, PhysicsOptions, PhysicsDebugSnapshot
} from './physics'

interface PhysicsOptions {
  workArea: Rect                 // overlay 窗口本地工作区（frame=workArea；原点不一定为 0）
  petSize: PetSize               // 当前宠物 CSS px（宽高比已由 Lead 乘好）
  gravityPxPerSec2?: number      // 默认 2400（文档建议 2200–2600）
  initialFeet?: Point2D          // 可选；默认 workArea 底边居中
  surfaces?: DesktopSurface[]    // 可选；通常由 setEnvironment 每帧给
  sitApproachSpeedPxPerSec?: number // 可选；sit 接近速度（默认 520，见 constants.ts 注释）
  dragSmoothingTauMs?: number    // 可选；拖拽平滑 τ（默认 45ms，建议 40–70）
}

class PetPhysics {
  constructor(options: PhysicsOptions)
  setEnvironment(env: PhysicsEnvironment): void
  setCommand(command: MotionCommand): void
  beginDrag(pointer: Point2D, nowMs: number): void
  dragTo(pointer: Point2D, nowMs: number): void
  endDrag(nowMs: number, throwVelocityOverride?: Point2D): DragEndResult // { throwVelocity }
  step(dt: number, nowMs: number): MotionSnapshot // 每帧主更新
  getSnapshot(): MotionSnapshot
  getDebugSnapshot(): PhysicsDebugSnapshot        // 可选调试用（mode/command/dragging/…）
}
```

`MotionSnapshot`：`{ feet, velocity, facing, grounded, surfaceId, airborne }`，全部字段
`step()` 后保持最新，`getSnapshot()`/`step()` 返回**拷贝**（改返回值不影响内部状态）。

## 状态语义（B1/B3 消费要点）

| 状态 | grounded | airborne | surfaceId | 说明 |
|---|---|---|---|---|
| 站立/行走/坐着 | `true` | `false` | 地面/表面 id | 地面 id：B5 提供 `kind='screen-bottom'` 时用其 id，否则为 `'screen-bottom'`（隐式地面 = workArea 底边） |
| 自由落体 / 被甩飞 | `false` | `true` | `null` | 受重力；左右墙小反弹衰减；落地后转站立 |
| 攀爬（`moveTo.mode='climb'`） | `false` | `false` | `null` | 第三种状态：2D 受控位移、不受重力；换指令后松手进入自由落体（`sit` 可直接从攀爬落座） |
| 拖拽中 | `false` | `false` | `null` | 由 B3 的 `AnimationInput.dragging` 表现；**起手若 `facing='front'` 会切到默认侧向**（V7 用户反馈：被拎起应侧身悬挂），拖动中按水平速度方向更新 |
| sit 接近 | `false` | `false` | `null` | 受控 2D 位移到表面正上方，到点后 `grounded=true / surfaceId=表面 id / feet.y=surface.top` |

- **朝向** `facing`：水平速度 > 2px/s 时按速度方向；静止时按 `moveTo`/拖拽目标 x 推导；否则
  **保持上一朝向**（初始 `'front'`）。`'front'`（面向镜头）不会被自动覆盖，**唯一例外是
  `beginDrag`**：起手时若还是 `'front'` 会切到 `DRAG_START_FACING`（默认 `'right'`，侧身悬挂），
  拖动中的水平移动继续按速度方向更新；落地后由行为层（`PetRuntime` 静止时输出 `'front'`）自然回正。
- 落地规则：`window-top` / `menubar` / `dock` 的 `top`；横向用「脚底点 ± 宠物半宽」与
  `surface.rect` 重叠判定（比宠物窄的窗口上沿也能站）；多表面同时穿越时取**最高**（top 最小）
  的一层，同 top 时 Dock > 窗口上沿 > 菜单栏，保证确定性。
- `hold`：地面摩擦让水平速度指数衰减（`exp(-6·dt)`，低于 2px/s 归零）；空中忽略 moveTo/sit。
- `moveTo.walk`：只水平走并钉在当前支撑面 top 上；走出窗口上沿边缘会自然掉落。
- `moveTo.climb`：2D（含竖直）受控位移，clamp 在 workArea 内；空中收到 climb 会忽略。
  爬到目标点若正好是可站表面（B1 的爬窗沿目标 = `{表面中心, surface.top}`）会**自动落到表面**
  （grounded + surfaceId）；B1 的到位判定是 16px，会在最后一段改发 `hold`，此时若脚下 24px 内
  有可站表面会吸附补完（`CLIMB_SETTLE_SNAP_EPS_PX`），否则才松手自由落体。
- `sit.surfaceId`：`surfaceId` 必须存在且 `sittable=true`，否则指令被丢弃（B2 不猜）；接近阶段 2D 移动
  （**窗口在宠物的上方时也允许**，visual 上表现为攀爬/被托起；B1 最好先 climb 再 sit，见"局限"）。
- `drop`：一次性指令（消费即变 hold），从当前支撑落下；地面 drop 无效果。
- `teleport{feet}`：位置/速度/拖拽状态复位，落点正好在支撑上时立即 grounded；非法坐标忽略。
- 表面消失 / 横向移走（窗口关闭/移动）：`setEnvironment` 后**下一帧**失去支撑 → 进入空中（掉落）；
  同一窗口垂直移动时 grounded 的 feet.y 立即吸附新 `top`（跟随窗口）。
- **支撑面 top 必须落在 workArea 垂直范围内**（H-4）：窗口被拖出屏幕 / 全屏应用顶边（本地
  `top=-30` 等）不作为支撑，`refreshSupport` 会让宠物进入空中并最终落到屏幕内地面；
  **不会把 `feet.y` 写成视口外的负值**。`sit` 指令对这类表面同样直接丢弃（不会坐到视口外）。
- **D6a 段 id 抖动重匹配**：B5 遮挡裁剪按可见区间把窗口顶边切成 `win-X-top` / `win-X-top-1`…
  段数变化会让已记录的 `surfaceId` 消失或改指别的段。站立的宠物在 id 失效时先按
  「同 windowId + 同 kind + top 差 ≤1px」确定性重匹配，没有同 top 则退化为「同窗口最近的 top」，
  匹配到就采用新 id 并保持 grounded，匹配不到才掉落（不会从仍可见的窗沿无故踏空）。

## 常量（`constants.ts`，均从 `index.ts` re-export）

| 常量 | 值 | 说明 |
|---|---|---|
| `DEFAULT_GRAVITY_PX_PER_SEC2` | 2400 | 重力 |
| `MAX_STEP_DT_SEC` | 0.1 | dt 兜底上限 |
| `MOVE_ARRIVE_EPS_PX` | 1.5 | moveTo/sit/攀爬到位容差 |
| `GROUND_FRICTION_DAMPING_PER_SEC` | 6 | 地面摩擦指数衰减 |
| `GROUND_STOP_SPEED_PX_PER_SEC` | 2 | 摩擦停止阈值 |
| `WALL_RESTITUTION` | 0.4 | 被甩飞撞左右墙的反弹系数 |
| `WALL_BOUNCE_MIN_SPEED_PX_PER_SEC` | 40 | 低于此反弹速度归零 |
| `THROW_SAMPLE_WINDOW_MS` | 120 | 甩出速度估计窗口（文档 100–150） |
| `THROW_MAX_SPEED_PX_PER_SEC` | 4000 | 甩出速度上限 |
| `THROW_MAX_SAMPLES` | 64 | 指针样本硬上限（O(1) 内存） |
| `DRAG_SMOOTHING_TAU_MS` | 45 | 拖拽指数平滑 τ |
| `DRAG_START_FACING` | `'right'` | 拖拽起手默认侧身朝向（`facing='front'` 时切换；V7 用户反馈） |
| `DEFAULT_SIT_APPROACH_SPEED_PX_PER_SEC` | 520 | sit 接近速度 |
| `TELEPORT_SNAP_EPS_PX` | 2 | teleport 落点是否"正好在表面上"的容差 |
| `CLIMB_SETTLE_SNAP_EPS_PX` | 24 | 攀爬结束吸附容差（B1 16px 到位 + 8px 余量） |
| `IMPLICIT_GROUND_SURFACE_ID` | `'screen-bottom'` | B5 未给 screen-bottom 表面时的地面 id |
| `SUPPORT_REMATCH_TOP_EPS_PX` | 1 | 段 id 抖动后按 top 重匹配支撑面的容差 |

## 拖拽 / 甩出（B4 → main.ts → B2）

1. `beginDrag(pointer, nowMs)`：记录「脚底 − 指针」抓取偏移（不瞬移），清空速度样本；
   **若当前 `facing='front'` 则切到 `DRAG_START_FACING`（默认 `'right'`）**——V7 用户反馈
   「被拎起来时头/身体应朝侧边」，避免正面朝镜头；已有侧向/行走方向保留；
2. `dragTo(pointer, nowMs)`：更新目标（pointer + offset，clamp 在 workArea）+ 记录样本；
3. `step()` 内做**指数平滑**逼近目标（`k = 1 − exp(−dt/τ)`，τ=45ms），velocity 由实际位移差分；
4. `endDrag(nowMs, throwVelocityOverride?)`：用最近 **≤120ms** 指针样本估计速度
   `v = (最后位置 − 窗口内最早位置) / (now − 最早时间)`，视 `now` 时指针停在最后位置
   （先停住再松手 → 速度自然衰减，不会"轻轻放下却飞出去"），模长 clamp 到 4000px/s；
   松手即 `airborne=true`（被甩出/自然落下由重力继续），B4 把 `throwVelocity` 放进
   `InteractionEvent.dragEnd`。若 main.ts 直接复用 B4 事件里的 `throwVelocity`，可作为第二个参数
   传入（B2 仍会 clamp 到 4000px/s），保证运动与 B3 甩出事件用同一初速度。
5. 释放后用同一条指令流继续：撞击左右墙 `vx = −vx·0.4`（<40px/s 归零）；落地竖直速度清零、
   水平速度保留并按地面摩擦滑行；落到窗口上沿等表面则停在该 `top`。

## Lead 接线（docs/wave2-integration.md §2）

```ts
// 启动（几何变化时重建/更新）
const physics = new PetPhysics({
  workArea: desktop.workArea,          // 窗口本地（通常 {0,0,window.innerWidth,innerHeight}）
  petSize: { width: petHeightPx * aspect, height: petHeightPx },
  initialFeet: { x: 1750, y: 961 }     // 可选：Wave 1 右下角位置，避免首帧跳变
})

// 每帧（顺序固定：B4 事件 → B1 决策 → B2 指令 → B2 step → petRect/placePet）
if (dragStart) physics.beginDrag(pointer, now)
if (dragMove) physics.dragTo(pointer, now)
if (dragEnd) physics.endDrag(now)      // throwVelocity → B3 AnimationEvent.thrown
physics.setEnvironment({ workArea: desktop.workArea, petSize, surfaces: desktop.surfaces })
physics.setCommand(decision.motion)
const motion = physics.step(dt, now)   // dt 已钳制 ≤0.1
const petRect = { x: motion.feet.x - width / 2, y: motion.feet.y - height, width, height }
debug.motion = motion                  // 调试面（Lead owned debug.ts）
debug.motionExtra = physics.getDebugSnapshot() // 可选
```

- `setEnvironment` 每帧调用开销 O(1)（不拷贝 surfaces 数组，使用时逐项校验），无需自己 diff；
- 屏幕/尺寸变化：直接下次 `setEnvironment` 传入新值；宠物会 clamp 进新 workArea，地面立即重解；
- 坐下/攀爬的**选择**属于 B1（用 B5 `DesktopSurface.sittable` / `climbable`），B2 只执行；
- B2 不产生 `AnimationEvent`：'landed'(impactSpeed) / 'thrown'(speed) 需要 Lead 用前后两帧
  `motion.velocity.y` / `endDrag` 的 `throwVelocity` 自行生成（B2 快照里已包含所需数值）。

## 局限 / 已知取舍（供 Lead 集成时判断）

1. **sit 接近是受控 2D 位移**：表面在宠物上方时会"浮/爬"上去（速度 520px/s），不是真实跳跃。
   推荐 B1 先 `moveTo(mode:'climb')` 到窗口上沿附近再 `sit`；若维持现状，视觉上表现为攀爬。
2. **攀爬没有独立的表面附着/边缘探测**：B2 只按目标点做 2D 位移（clamp 在 workArea 内）；
   爬哪条边、爬多高由 B1 的目标点决定；爬升途中若被 hold 打断且附近无可站表面，会掉下去。
3. **窗口横向移动不自动跟随**（只吸附垂直 top，横向移走会失去支撑掉落）；横向跟随按 B1 用
   `WindowTransition.moved` 下发的 `moveTo` 执行（docs §3-B5 的设计）。
4. 没有实现与其他宠物的碰撞、风、跳（jump 用 drop/抛物线组合由 B1 表达）；不做 `MMDPhysics`
   （PLAN §11 的 ammo.js 决策不在 B2 范围）。
5. 天花板 clamp 只保证 feet 不离开 workArea（顶部边界）；宠物矩形可能部分超出视口顶部
   （站在高窗口上沿时无法避免，Wave 1 的 `placePet` 允许）。
