# Wave 2 集成说明（B1–B7；Lead-owned 接口约定）

> 状态：**2026-11-08 开工前置**。本文件是 Wave 2 并行开发的**接线上岗说明**，与
> `src/renderer/src/core/wave2-contract.ts`（冻结类型契约）配套使用；实现细节以各模块
> README/代码为准，本文件冲突时**以 Lead 最新决定为准**（各 teammate 可向 Lead 提契约变更请求）。
>
> 相关章节：PLAN §5 Wave 2、§6 并行矩阵、§7 文件所有权、§11/§11.1、§17.3、§19.6、§19.9。

## 0. 分工与 scope（严格不越界）

| 任务 | 负责人 | 只允许写 | 交付 |
|---|---|---|---|
| B1 状态机 + 随机调度 | behavior teammate | `src/renderer/src/behavior/**`（不含 `mischief.ts`）、`tests/behavior-*.test.ts` | `BehaviorDirector.update(input): BehaviorDecision` |
| B2 运动与物理 | motion teammate | `src/renderer/src/physics/**`、`tests/physics-*.test.ts` | `PetPhysics`（重力/惯性/碰撞/拖拽） |
| B3 动画/姿态/表情 | anim teammate | `src/renderer/src/animation/**`、`tests/animation-*.test.ts` | 姿态库 + 混合器 + 表情调度 + `PetAnimator` |
| B4 交互 | interact teammate | `src/renderer/src/interaction/**`（含既有 `pointer-gate.ts` 的扩展；不改语义除非必要）、`tests/interaction-*.test.ts` | 拖拽/摸头/戳/注视/右键菜单逻辑 + controller |
| B5 桌面感知消费 | desktop teammate | `src/renderer/src/desktop/**`、`tests/desktop-*.test.ts` | 窗口→表面/吸附/跟随/爬行候选 |
| B6 设置面板 | settings teammate | `src/renderer/settings.html`、`src/renderer/src/settings/**`、`tests/settings-*.test.ts` | 设置页 UI（读写 `window.api`） |
| B7 DSH 反应消费 | dsh teammate | `src/main/desktop/dsh-watch.ts`、`src/main/ipc/dsh.ts`（替换占位）、`src/renderer/src/reactions/**`、`tests/dsh-*.test.ts` | 桥文件尾随 + 状态 IPC + 渲染层反应映射 |

**任何 teammate 不得修改（Lead-only 集成文件）**：

- `src/renderer/src/main.ts`、`src/renderer/src/debug.ts`、`src/renderer/src/env.d.ts`、`src/renderer/src/core/**`
- `src/renderer/src/scene/**`、`src/renderer/src/model/**`、`src/renderer/src/assets/**`（A2 既有模块，Lead 集成）
- `src/main/index.ts`、`src/main/app-context.ts`、`src/main/ipc/index.ts`、`src/main/ipc/window.ts`、`src/main/ipc/config.ts`、`src/main/ipc/settings.ts`、`src/main/ipc/desktop.ts`、`src/main/tray.ts`、`src/main/windows/**`、`src/main/login-item.ts`
- `src/shared/**`、`src/preload/**`、`package.json`、`pnpm-lock.yaml`、`electron.vite.config.ts`、`tsconfig*`、`vitest.config.mts`
- `tests/**` 既有测试文件与 `tests/helpers/**`、`tests/setup.ts`（只允许**新增**自己的 `tests/<task>-*.test.ts`）
- `docs/**` 现有文件（Lead 负责文档；teammate 可在自己模块目录内写 README.md）

需要 Lead 改钩子（例如 extra debug 字段、main.ts 接线）→ **发消息给 lead**，说明"哪个文件 + 要什么钩子 + 为什么"；不要自己改。

## 1. 坐标系与时钟（所有模块必须遵守）

- **位置一律是 overlay 窗口本地 CSS 像素**：原点 = overlay 窗口左上角；x→右、y→下。
  overlay frame = 主屏 `display.workArea`（1080p 当前 `{0,30,1920,961}`，**不要硬编码** 30/961）。
- 宠物摆放：`petRect = { x: feet.x - width/2, y: feet.y - height, width, height }`，
  `height = petHeightPx`（= `sizePercent% × display.bounds.height`，100% 受 workArea 高封顶），
  `width = height × 模型宽高比`（模型绑定姿势宽高比来自 `PetScene.modelAspectRatio`，约 0.7373）。
- `feet`（脚底锚点）是**唯一位置权威**：B2 输出 → Lead 换算 `petRect` → `PetScene.placePet`。
- 全局坐标（`WindowInfo.bounds` / `DisplayInfo.bounds|workArea`）是屏幕全局逻辑像素；
  B5 负责减去 overlay 窗口原点换算到本地坐标，**其它模块不要自己猜全局坐标**。
- 时间：行为/调度使用注入的 `nowMs`（main.ts 传 `performance.now()`；单测传假时钟）；
  渲染帧 dt 由 `PetScene.step` 统一钳制 ≤0.1s，再传给 B3。**不要用 `Date.now()` 做行为计时**。
- 随机：B1 的所有随机决策只经注入的 `random()`（[0,1)）；单测注入 seeded RNG 复现。

## 2. 每帧数据流（Lead 在 `main.ts` 实现）

```
DOM mousemove/mousedown/mouseup/wheel/contextmenu
        │（B4 InteractionController：hit/pat/poke/drag/look）
        ▼
InteractionSnapshot + InteractionEvent[]
        │
        ├── desktopSensor.snapshot()（B5；窗口列表来自 pet:windows/windows-updated）
        │
        ├── dshReactionTracker.reactionAt(nowMs)（B7；事件来自 dsh-event / pet:dsh-status）
        │
        ▼
behaviorDirector.update(BehaviorInput)  ──►  BehaviorDecision
        │                     │
        │ motion              │ mood/facing/lookTarget/bubble
        ▼                     ▼
  PetPhysics.setCommand()    PetScene.setAnimationInput(...)
  PetPhysics.step(dt)        PetScene.step(now):
        │                       ├─ animator.update(AnimationInput)（B3）
        ▼                       ├─ 材质 morph 更新（A2）
   MotionSnapshot ────────────►├─ idle fallback（无 animator 时）
        │                       └─ 渲染 + 描边
        ▼
  petRect = f(MotionSnapshot.feet) → PetScene.placePet(petRect, feet.y)
  pointerGate.update({rect: hitRect, forceIntercept: dragging|menuOpen})
  bubble 显示/隐藏 + 调试面快照更新
```

关键顺序约束：
1. B4 在每帧先产事件（B1/B2 消费），`events` 由 main.ts 收集后清空；
2. B1 决策必须先于 B2 的 `setCommand`；
3. B2 `step` 之后才能得到本帧 `MotionSnapshot` → 才能算 `petRect` → 才能 `placePet` + 动画输入；
4. B3 的 `update()` 必须发生在 `PetScene` 渲染前；渲染由 `PetScene.step` 内部完成；
5. `fpsCap` 跳帧时（`step` 返回 false）动画/物理仍应**按累计真实 dt 更新**，不能"卡住"——
   Lead 会在跳帧时也调用 B2/B1（按真实 dt，含 0.1 钳制），只有渲染被跳过。

## 3. 各模块对外 API 建议（Lead 会按此接线；若实现不同，尽早告知）

### B1 behavior

```ts
// src/renderer/src/behavior/index.ts（或 behavior-director.ts）
export class BehaviorDirector {
  constructor(options?: { seed?: number; initialMood?: PetMood })
  update(input: BehaviorInput): BehaviorDecision
  /** B7 反应注入（main.ts 调；也可只通过 input.external 传入） */
  applyExternalReaction(reaction: ExternalReaction): void
  /** 设置当前可注入随机源（单测用；默认 Math.random） */
  setRandom(random: () => number): void
  /** 调试快照（debug.behavior） */
  getDebugSnapshot(): BehaviorDebugSnapshot
  /** 调试强制触发活动（debug.debugTriggerActivity；返 false = 未知/当前不可触发） */
  triggerActivity(activityId: string, nowMs: number): boolean
}
```

- `input.events` 里的拖动/摸头/戳事件应让行为**立即**进入 pat/drag/fall 反应（可打断自主活动）；
- 自主活动开关 `config.autonomous=false` 时只允许交互/外部反应，不允许随机漫游；
- 攀爬/坐/跟随窗口用 `input.desktop.surfaces` / `transitions`，**不要自己读 `pet:windows`**；
- 输出 `bubble` 只在"确实要说话"的帧返回文本，不要每帧重复（main.ts 负责去重与显示时长）；
- 台词池必须**符合砂金人设**（参考 `docs/aventurine-character-brief.md`，由 Lead/调研产出，
  如尚未生成先用模型现有性格：自信、戏谑、赌徒口吻、偶尔自嘲），并带冷却避免刷屏；
- 男角色定位：动作/台词避免"少女系"（娇羞摇摆、卖萌挥小手）；同时**不要娘娘腔化/刻板化**。

### B2 physics

```ts
// src/renderer/src/physics/index.ts
export interface PhysicsOptions {
  workArea: Rect          // 窗口本地坐标（overlay frame）
  petSize: PetSize        // 当前宠物尺寸（CSS px）
  gravityPxPerSec2?: number  // 默认 ~2200–2600
}
export class PetPhysics {
  constructor(options: PhysicsOptions)
  /** 窗口/显示器/尺寸变化时更新环境（surface 列表每帧更新） */
  setEnvironment(env: { workArea: Rect; petSize: PetSize; surfaces: DesktopSurface[] }): void
  setCommand(command: MotionCommand): void
  /** 拖拽（B4 → main.ts → B2）；`dragTo` 内部做平滑跟随并记录速度样本 */
  beginDrag(pointer: Point2D, nowMs: number): void
  dragTo(pointer: Point2D, nowMs: number): void
  endDrag(nowMs: number): { throwVelocity: Point2D }
  /** 主更新：返回本帧 MotionSnapshot（feet 唯一权威） */
  step(dt: number, nowMs: number): MotionSnapshot
  getSnapshot(): MotionSnapshot
}
```

- 边界：不穿出 `workArea`（左右墙、底部地面）；可落在 `DesktopSurface.kind==='window-top'|'menubar'|'dock'` 的 `top`；
- 甩出：`endDrag` 的 throwVelocity 由最近 ~100–150ms 指针速度估计，clamp 上限（如 4000 px/s）；
- 落地：竖直速度清零、`grounded=true`、`surfaceId` 记录；被甩飞撞边墙时水平速度反向衰减（小 bounce）；
- 所有与表面的碰撞使用**脚底点 + 宠物半宽**；坐下时 feet.y = surface.top（腿下垂由 B3 姿态表现）；
- 纯逻辑、可注入时钟；**不要 import three/DOM**。

### B3 animation

**架构（已由技术调研锁定，见 `docs/anim-tech-survey.md` §0）**：自研姿态表 + 分层权重混合（方案 B），
不建 `AnimationMixer`；只驱动约 20 根**有蒙皮权重**的骨；腿写 D 链（`足D/ひざD/足首D`，**不是** IK
链 `足/ひざ/足首`——那三根权重为 0）；眼写 `目先`（**不是** `目/両目`）；不跑 grant、不跑 CCDIK；
脚底贴地用「解析二骨 IK + 髋高补偿」；次级运动只做 7 根发辫 verlet 弹簧（不引 ammo.js）。

```ts
// src/renderer/src/animation/index.ts
export interface CreatePetAnimatorOptions {
  mesh: import('three').SkinnedMesh
  /** 模型根 Group（PetScene.modelRoot；用于 ambient 微动/朝向，可选） */
  root?: import('three').Object3D
  /** 注入时钟（毫秒；默认 performance.now；单测传假时钟） */
  now?: () => number
  /** 注入随机源（眨眼调度；单测 seeded） */
  random?: () => number
}
export interface PetAnimator {
  /** 每帧调用（PetScene.step 内、渲染前；dt 已钳制 ≤0.1s） */
  update(input: AnimationInput): void
  /** 调试/冒烟：当前动画快照（字段见 wave2-contract.ts AnimationDebugSnapshot） */
  getDebugSnapshot(): AnimationDebugSnapshot
  /** 调试/冒烟：强制切姿态（返回 false = 未知姿态 id） */
  setPose(poseId: string, fadeMs?: number): boolean
  /** 调试/冒烟：强制注视角（度） */
  setGaze(yawDeg: number, pitchDeg: number): void
}
export function createPetAnimator(options: CreatePetAnimatorOptions): PetAnimator
```

- 姿态 id 建议：`stand` / `walk` / `climb` / `sit` / `sitEdge` / `sleep` / `pat` / `pokedHead` /
  `pokedBody` / `pokedLeg` / `drag` / `fall` / `land` / `celebrate` / `sad` / `busy`；
  **`PetMood → 姿态` 的映射由 B3 内部完成**（单测穷举 12 个 PetMood 都有对应姿态，未知回 `stand`）；
- 待机变体（4–6 个，`poseHint` 可提示）：由 B3 内部按 `mood==='idle' + random + cooldown` 轮换，
  不要等 B1 给变体 id（B1 只给 `idle`）；**避免女性化/娇羞小动作**（用户明确要求按男角色 + 砂金人设筛选）；
- 表情：B3 内部调度（眨眼/情绪/口型/材质 morph 权重），每帧**全量**写 `morphTargetInfluences`
  （只写非零，其余归零；`照れ/目影消/目影濃` 仍交给 A2 `MaterialMorphController` 从 influences 读取）；
- 引用了不存在的 morph/骨 → 忽略并记录到 `missingBones` / `errors`，不抛；
- 层顺序固定（单测锁死）：`基础姿态 → 呼吸/微动(additive) → 反应 overlay(mask) → look-at(additive) → 弹簧`；
- 过渡 `smoothstep` + 0.25s 默认时长；slerp 走短弧（dot<0 取反）；
- **红线**：不得写 `modelRoot.scale/rotation`（Lead 的 `IdleMotion` 与摆放逻辑在 root 层；
  B3 接入后 Lead 会停用 IdleMotion，但摆放/缩放仍由 PetScene 负责）。B3 只写 `bone.quaternion`
  与 `センター.position`（贴地补偿），不写其它 `bone.position`、不调 `mesh.pose()/bind()`、不调 `helper.update()`。

**Lead 接线**（`PetScene` 内，集成窗口）：PMX 加载完成后 `createPetAnimator({mesh, root})`；
`PetScene.step` 中若 animator 存在：先 `animator.update({...pendingInput, dt, petRect, viewportHeight})`
再 `materialMorphs.update()`，最后 `outlineEffect.render`；随后 `debug.animation = animator.getDebugSnapshot()`、
`debug.debugSetPose` / `debug.debugSetGaze` 直接透传。`helper.update` / `IdleMotion` 在 animator 存在时短路。

**调试面/冒烟**（Lead 实现）：`debug.animation` 字段（`pose/poseWeight/blink/smile/mouthOpen/lookYaw/
morphs/gaze/footErrorPx/missingBones`）+ `debugSetPose/debugSetGaze`；冒烟至少断言：
初始 `pose !== 'stand'` 仍可（idle 变体允许）、`missingBones.length===0`、`footErrorPx<2`（站/走）、
`debugSetPose('sit')` 成功且切回 `stand` 成功、眨眼在 8s 内出现（轮询）、`debugSetGaze(25,0)` 后
`gaze.yaw≈25°`、`errors` 无新增、fps 与 Wave 1 基线相当（B3 不新增 draw call/triangles）。

### B4 interaction

```ts
// src/renderer/src/interaction/index.ts（controller 可依赖 DOM；纯逻辑模块必须可单测）
export interface InteractionControllerOptions {
  getPetRect(): Rect | null
  getPetHeightPx(): number
  isEnabled(): boolean          // 例如设置面板打开时？
  onEvents(events: InteractionEvent[]): void   // 也可提供 drainEvents()
  onLookTarget(target: Point2D | null): void
  onMenuAction?(action: 'settings' | 'hide' | 'toggleAutonomous' | 'quit'): void
}
export class InteractionController {
  constructor(options: InteractionControllerOptions)
  /** 绑定 window 事件；Lead 在 boot 时调用一次（注意与既有 pointer tracking 的替换/共存） */
  attach(target: Window): void
  detach(): void
  getSnapshot(): InteractionSnapshot
  /** 每帧由 main.ts 调用：返回并清空本帧事件 */
  drainEvents(): InteractionEvent[]
  /** 右键菜单是否打开（main.ts 用它保持点击拦截） */
  isMenuOpen(): boolean
}
```

- 必须复用/兼容既有 `pointer-gate.ts`：点击穿透状态机仍由 Lead 的 main.ts 驱动；
  B4 只提供"当前是否按住拖动/菜单打开"等状态供 Lead 扩大拦截范围；
- 拖拽起点可加 2–4px 阈值，避免单击被误判为拖动；拖动中即使指针离开宠物矩形也要持续跟随；
- 摸头：头部区域内的**圆形轨迹**（累积角度，半径带宽）达到阈值触发一次 pat，带冷却；
- 戳：短按（<250ms 且位移小）按区域触发；双击/三连戳可升级反应（可选）；
- 注视：指针位置平滑后作为 lookTarget（窗口本地 px）；离开窗口 → null；
- 右键菜单：DOM 菜单（overlay 页面内），样式与桌宠一致；菜单打开时阻止穿透；
- 可参考 `docs/aventurine-character-brief.md` 的角色反应设计（摸头/戳的部位与反应差异）。

### B5 desktop

```ts
// src/renderer/src/desktop/index.ts（纯逻辑；不 import DOM/electron）
export class DesktopSensor {
  constructor(options?: { sittableGapPx?: number })
  /** 窗口列表更新（来自 pet:windows / windows-updated；屏幕全局坐标） */
  updateWindows(windows: WindowInfo[], nowMs: number): void
  /** 环境更新：overlay 窗口原点 / 显示器 / workArea（窗口本地坐标基准） */
  updateEnvironment(env: {
    overlayOrigin: Point2D          // overlayWindow.bounds.x/y（全局）
    display: DisplayInfo            // 当前 overlay 所在 display
    viewport: PetSize               // overlay 窗口本地尺寸（CSS px）
    ownPid?: number
  }): void
  /** 当前快照（B1/main.ts 消费；transitions 为自上一帧以来事件） */
  snapshot(nowMs: number): DesktopSnapshot
  /** 便利方法（B1 可用）：最近的 sittable 表面、可爬边缘候选 */
  findSittableSurface(feet: Point2D, petSize: PetSize): DesktopSurface | null
  getClimbSurfaces(): DesktopSurface[]
}
```

- 过滤（PLAN §11）：`layer===0`、`alpha>0.01`、`height>80`、`onScreen`；排除自身进程/overlay 窗口；
- 排序按窗口列表顺序（前→后）；`window-top` 表面 `rect.height` 用 1px 占位、`top = bounds.y - origin.y`；
- 菜单栏/Dock：用 `display.bounds` 与 `display.workArea` 差集推导（不硬编码 30/24px）：
  workArea 顶边→`menubar`；底边为 Dock（若 Dock 在底部，`screen-bottom` 与 `dock` 都提供，Dock 优先级更高）；
- transitions：窗口移动 `moved{delta}` / 关闭 `closed` / 新出现 `appeared`；**同一窗口只报一次**；
- 窗口移动后，站/坐在其上的跟随由 B1 用 transitions + surfaces 决策；B5 也可提供
  `getTrackedWindowSurface(windowId)` 帮助 B1；
- 单测需覆盖坐标系换算、过滤合并、去重、排序、Dock/菜单栏差集、跟随/关闭场景。

### B6 settings

- `src/renderer/settings.html`（已存在占位，B6 重写）+ `src/renderer/src/settings/**`；
- 入口必须保留 `#settings-root` 容器（Lead 的 settings-window.ts 已按 `out/renderer/settings.html` 加载）；
- 控件：尺寸 10–100（显示换算 px）、透明度、自主活动开关 + 频率（low/normal/high）、
  捣乱开关、DSH 联动开关、FPS 上限 5–60、开机自启、音效、权限状态（`getAccessibilityStatus()`）、
  DSH 状态（`getDshStatus()`，在线/忙碌）、版本/模型信息（可选）；
- 行为：加载 `window.api.getConfig()` 初始化 → 变更时 `setConfig(partial)`（可 debounce 150–300ms）
  → 用返回值刷新 UI（主进程会 sanitize）；用订阅 `onConfigChanged` 同步外部变化；
  "恢复默认"按钮（可选，用 DEFAULT_CONFIG 的显式字段 set）；
- 纯逻辑（config→ViewModel、form change→Partial<PetConfig>、钳制）放可单测模块（`settings-model.ts`）；
- UI 不要引入新依赖（不引 UI 框架）；使用原生 DOM + CSS（可写 `settings.css`）；
- CSP 已限制：`script-src 'self'`、`style-src 'self' 'unsafe-inline'`；不要内联 `<script>`、不要 eval。

### B7 DSH

- main 侧 `src/main/desktop/dsh-watch.ts`：尾随 `~/.dsh/aventurine-pet/`（可用 `os.homedir()`；
  目录可用 env 覆盖便于测试，如 `PET_DSH_DIR`，但生产默认 `~/.dsh/aventurine-pet`）；
  - `status.json`：轮询（500–1000ms）读文件 + `isDshBridgeStatusFile` + `toDshStatus(file, Date.now())`
    得 `DshStatus`；文件不存在/坏 JSON/权限错误 → 全离线默认值，只 warn 一次，绝不抛；
  - `events.jsonl`：按字节偏移尾随；处理新增行（部分行留到下次）、文件轮转/截断（size < offset → 归零）；
    每行用 `parseDshEventLine`（已含 64KB 上限）；**不要一次性读入整个文件**；
  - 提供 `getStatus(): DshStatus`、`onEvent(cb)`、`onStatusChanged(cb)`、`start()`/`stop()`；时间可注入；
- main 侧 `src/main/ipc/dsh.ts`（替换 Lead 占位，签名不变）：创建 watcher，注册 `pet:dsh-status`，
  watcher 事件 → `ctx.broadcast('dsh-event', event)`（**仅 online 时才转发，避免陈旧事件误触发**）；
  `will-quit` stop；不注册其它 channel；
- renderer 侧 `src/renderer/src/reactions/dsh.ts`：纯逻辑 `DshReactionTracker`：
  `pushEvent(event, nowMs)`、`reactionAt(nowMs): ExternalReaction | null`；映射：
  `task/start` / `agent/status` running → `dshBusy`；`task/end` → `dshDone`；`task/error` → `dshError`；
  注意桥插件实际 emit 的 `task/start`/`task/end` payload 形状（`{status, agent}`，只在变化时）；
  同 turn 去重；持续时间/气泡台词按人设（见 character brief）；`online=false`/`config.dshLink=false` 时静默；
- 接线（Lead 做）：`main.ts` 启动时 `getDshStatus()` 拿基线、订阅 `onDshEvent` 推给 tracker；
  每帧 `tracker.reactionAt(nowMs)` 注入 B1 `input.external`（或 `applyExternalReaction`）；
- 单测：temp dir + 假时钟覆盖 status 新鲜/过期/未来 ts/offline true；events 追加/半行/轮转/超长行；
  反应映射/去重/过期/静默；**不得依赖真实 `~/.dsh`**（测试用 temp dir）。

## 4. 测试与验收（teammate 自测 + Lead 终验）

- 每个任务必须：`pnpm typecheck` 下**自己文件** 0 错误（其他人并行 WIP 的错误不归你管，不要改别人文件）；
  `pnpm exec vitest run tests/<你的前缀>` 全绿；新增测试覆盖验收条款；
- **禁止**运行 `pnpm dev` / `pnpm smoke` / `pnpm smoke:file` / `pnpm build` / `electron` / `git` 提交
  （Lead 统一做集成与实机验收；避免并行 GUI/构建冲突）；
- 依赖真实模型的验证（视觉/姿态）由 Lead 采集截图后反馈；teammate 可用纯函数/假数据做单测；
- 交付时向 Lead 发一条消息：改了什么文件、API 签名、如何接线、测试结果、未完成项/风险。
- 代码注释用中文，风格与既有文件一致；不引入新依赖（必须引入时先问 Lead）。
