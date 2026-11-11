/**
 * Wave 2 运行时编排层（Lead-owned 集成模块）
 *
 * 把 B1 行为 / B2 物理 / B5 桌面感知 / B7 DSH 反应组合成「每帧一次调用」的纯编排 API，
 * 让 `src/renderer/src/main.ts` 只负责 DOM/场景/几何/调试面，不堆业务逻辑。
 *
 * 职责边界（详见 docs/wave2-integration.md §2）：
 * - 输入：环境（窗口本地 workArea / 宠物尺寸 / overlay 原点 / display）、窗口列表、
 *   B4 交互快照与事件、DSH 事件/状态、配置、当前气泡状态；
 * - 输出：`BehaviorDecision`、本帧 `MotionSnapshot`、宠物摆放矩形 `petRect`、B3 `AnimationDriverInput`；
 * - B3 姿态驱动由 `PetScene` 内部持有（调用方把 animation 输入交给 `scene.setAnimationInput`）；
 * - B4 的拖拽坐标由调用方在事件发生时直接转给本类的 beginDrag/dragTo/endDrag（避免一帧延迟）。
 *
 * 约束：本文件不 import DOM / three / Electron；只引用 `core/wave2-contract` 与 B1/B2/B5/B7 出口。
 */
import type { DisplayInfo, PetConfig, PetMood, Rect, WindowInfo } from '@shared/types'

import { BehaviorDirector } from '../behavior'
import { DesktopSensor } from '../desktop'
import { DRAG_START_FACING, PetPhysics } from '../physics'
import { DshReactionTracker } from '../reactions/dsh'
import type {
  AnimationDriverInput,
  AnimationEvent,
  BehaviorConfigSubset,
  BehaviorDecision,
  BehaviorInput,
  DesktopSnapshot,
  DesktopSurface,
  ExternalReaction,
  Facing,
  InteractionEvent,
  InteractionSnapshot,
  MotionCommand,
  MotionSnapshot,
  Point2D,
  PetSize
} from './wave2-contract'

/** 运行时环境（窗口本地坐标；屏幕/尺寸变化时由 main.ts 更新）。 */
export interface PetRuntimeEnvironment {
  /** overlay 窗口本地工作区（通常 `{x:0,y:0,width,height}`；不要假设原点为 0）。 */
  workArea: Rect
  /** 当前宠物尺寸（CSS px；随 sizePercent / 模型宽高比变化）。 */
  petSize: PetSize
  /** overlay 渲染视口（CSS px）。 */
  viewport: PetSize
  /** overlay 窗口在屏幕全局坐标中的原点（`pet:window-info.bounds` 的 x/y）。 */
  overlayOrigin: Point2D
  /** overlay 所在显示器（来自 `pet:screen-info`，用于菜单栏/Dock 差集）。 */
  display: DisplayInfo
}

/** 每帧输入（main.ts 组装）。 */
export interface PetRuntimeFrameInput {
  /** `performance.now()` 单调时钟 */
  nowMs: number
  /** 距上一帧秒数（已钳制 ≤0.1） */
  dt: number
  /** B4 交互快照 */
  interaction: InteractionSnapshot
  /** 本帧临时事件（B1 消费；同时转换成 B3 动画事件） */
  events: InteractionEvent[]
  /** 当前气泡文本（用于 B3 口型；不可见时 null） */
  bubbleText: string | null
}

/** 每帧输出（main.ts 消费）。 */
export interface PetRuntimeFrameOutput {
  decision: BehaviorDecision
  motion: MotionSnapshot
  /** 宠物摆放矩形（窗口本地 CSS px、y 向下；由 feet + petSize 推出） */
  petRect: Rect
  /** 交给 `scene.setAnimationInput()` 的 B3 输入 */
  animation: AnimationDriverInput
  /** 本帧生效的朝向（main.ts 用它调 `scene.setFacing()` 转身；移动时=运动方向，静止=front） */
  facing: Facing
}

/** 运行时调试快照（`window.__aventurineDebug` 用）。 */
export interface PetRuntimeSnapshot {
  desktop: DesktopSnapshot
  motion: MotionSnapshot
  reaction: ExternalReaction | null
  decision: BehaviorDecision | null
}

/** 运行时选项。 */
export interface PetRuntimeOptions {
  env: PetRuntimeEnvironment
  config: PetConfig
  /** 可注入随机源（测试/复现；默认 Math.random） */
  random?: () => number
  /** 行为初始 mood（默认 idle） */
  initialMood?: BehaviorDecision['mood']
  /** 可选初始脚底点（默认 workArea 右下角；Lead 传当前角落布局以保持启动画面连续）。 */
  initialFeet?: Point2D
}

/** 从 PetConfig 抽取行为所需子集。 */
function toBehaviorConfig(config: PetConfig): BehaviorConfigSubset {
  return {
    autonomous: config.autonomous === true,
    autonomousLevel:
      config.autonomousLevel === 'low' || config.autonomousLevel === 'high'
        ? config.autonomousLevel
        : 'normal',
    mischief: config.mischief === true,
    dshLink: config.dshLink === true
  }
}

/**
 * 松手速度阈值（px/s）：低于它按「放下」处理（走放置语义：吸附窗沿 / 原地站定），
 * 达到它按「甩出」处理（自由落体/抛掷）。与 B1 `THROW_SPEED_THRESHOLD_PX_PER_SEC`（520）对齐，
 * 避免 B1 已进入 fall 状态、物理却走放置、两边状态互相打架。
 */
export const PLACEMENT_MAX_THROW_SPEED_PX_PER_SEC = 520

/** 数值钳制（放置目标计算用；非法值回退 min）。 */
function clampPx(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min
  if (!(max >= min)) return min
  return value < min ? min : value > max ? max : value
}

/** 空交互快照（未接管 B4 时的兜底）。只读共享常量：多处引用，禁止就地修改（02 N-4）。 */
export const EMPTY_INTERACTION: InteractionSnapshot = Object.freeze({
  pointer: null,
  hoveringPet: false,
  dragging: false,
  patProgress: 0
})

/** 由脚底点 + 宠物尺寸推出摆放矩形（x 居中、y 为顶边；窗口本地 y 向下）。 */
export function computePetRectFromFeet(feet: Point2D, petSize: PetSize): Rect {
  const width = Math.max(1, petSize.width)
  const height = Math.max(1, petSize.height)
  return {
    x: feet.x - width / 2,
    y: feet.y - height,
    width,
    height
  }
}

/* ------------------------- Wave 2.5：走路的自然步速（D3） ------------------------- */

/**
 * 真实人类步行速度基准（**体高/秒**）。
 *
 * 与 `assets/model/optimized/motion-walk.vmd` 的 `nominalSpeedPxPerSec` 同一口径：
 * 该 clip 在 540px 高宠物上测得自然步速 470px/s → 470/540 ≈0.8704 体高/秒。
 * 因此把 B1 的「px/s」改成「体高/秒 × 宠物高度」后，VMD 走路速率 =1（不滑步），
 * 且宠物尺寸（sizePercent）变化时步幅/步频观感保持一致。
 */
export const WALK_SPEED_BODY_HEIGHTS_PER_SEC = 470 / 540

/** 自主活动档位对步行速度的系数（保留 low/normal/high 的相对差异）。 */
export const WALK_LEVEL_FACTOR: Readonly<Record<'low' | 'normal' | 'high', number>> = {
  low: 0.8,
  normal: 1,
  high: 1.2
}

/**
 * 自然步行速度（px/s）= 宠物高度 × 0.87 × 档位系数。
 *
 * 例：540px 宠物 normal ≈ 470px/s（与 walk clip 原速一致）、low ≈376、high ≈564；
 * 324px（30%）宠物 normal ≈282px/s。高度非法/缺失时按 540 处理。
 */
export function naturalWalkSpeedPxPerSec(
  petHeightPx: number,
  level: 'low' | 'normal' | 'high'
): number {
  const height =
    typeof petHeightPx === 'number' && Number.isFinite(petHeightPx) && petHeightPx > 0
      ? petHeightPx
      : 540
  const factor = WALK_LEVEL_FACTOR[level] ?? 1
  return height * WALK_SPEED_BODY_HEIGHTS_PER_SEC * factor
}

/**
 * 把 B1 的 `moveTo(walk)` 指令速度替换为「自然步速」；其它指令（climb/hold/sit/…）原样返回。
 *
 * 背景（Wave 2.5 D3 实测）：B1 原速度 62–112px/s 是给程序化姿态调的；换成真实 VMD 走路后
 * 与 clip 的自然步速（≈470px/s@540px）差 4–7 倍，导致必须 0.5× 慢放仍滑步。改成
 * 体高相对速度后 `VMD 播放速率 = 移动速度 / 自然步速 ≈ 档位系数（0.8/1.0/1.2）`，不滑步。
 */
export function withNaturalWalkSpeed(
  command: MotionCommand,
  petHeightPx: number,
  level: 'low' | 'normal' | 'high'
): MotionCommand {
  if (command.kind !== 'moveTo' || command.mode !== 'walk') return command
  const speed = naturalWalkSpeedPxPerSec(petHeightPx, level)
  if (Math.abs(command.speedPxPerSec - speed) < 1e-6) return command
  return { ...command, speedPxPerSec: speed }
}

/* ------------------- Wave 2.5：B2 可达水平区间（H-3b 契约侧） ------------------- */

/**
 * 计算 B2 可达水平区间（H-3b）：B2 会把 feet.x 按宠物半宽钳制在 workArea 内，B1 的
 * walkTo/returnCorner 目标若按 workArea 全宽随机，就会落在不可达带（实测目标 x=1582
 * vs 可达上限 1400.9 → 原地走到超时、活动「完成」但从未到达）。
 *
 * 计算：`halfW = petSize.width / 2`；`minX = workArea.x + halfW`；
 * `maxX = workArea.x + workArea.width - halfW`。
 *
 * 返回 undefined 表示**不要传该字段**（B1 保持旧行为 = 按 workArea 全宽）：
 * - petSize/workArea 非法（非有限值）或 `petSize.width <= 0`；
 * - `minX > maxX`（宠物比 workArea 还宽，B2 会退化为中线，没有有效区间）。
 */
export function computeMotionLimits(
  workArea: Rect,
  petSize: PetSize
): { minX: number; maxX: number } | undefined {
  if (!workArea || !petSize) return undefined
  if (
    !Number.isFinite(workArea.x) ||
    !Number.isFinite(workArea.width) ||
    !Number.isFinite(petSize.width)
  ) {
    return undefined
  }
  if (petSize.width <= 0) return undefined
  const halfW = petSize.width / 2
  const minX = workArea.x + halfW
  const maxX = workArea.x + workArea.width - halfW
  if (minX > maxX) return undefined
  return { minX, maxX }
}

/* ------------------- Wave 2.5：目标表面「可见性」过滤（防止坐/爬到屏幕外） ------------------- */

/** 表面可用性过滤的额外余量（px；留一点头顶空间，避免贴边）。 */
export const SURFACE_HEADROOM_MARGIN_PX = 8

/**
 * 坐姿「髋高」比例：髋关节（臀部）在脚底上方约 0.62×身高
 * （VRM rest 实测 `hipsRestHeight / restHeight = 1.0661 / 1.734 ≈ 0.615`；取 0.62 与历史口径一致）。
 *
 * 窗沿坐 = 臀部（髋）贴窗沿、腿自然垂下：
 * - **头到髋** 只有 `(1 − 0.62) ≈ 0.38×身高` 在窗沿上方，需要 headroom；
 * - 腿在窗沿下方悬垂（约 0.62×身高，不需要 headroom）。
 *
 * ⚠️ 2026-11-10 修正：旧实现把 0.62 当成「上半身在窗沿上方的高度」，坐姿 headroom 多算了
 * `0.24×身高`（540px 宠物多要 ≈130px）→ 50% 尺寸下连 Finder 窗沿（top=324）都被判不可坐，
 * 用户实机反馈「头明明没顶到屏幕顶端，头还是被截掉」（当时还退化成未完成的窗沿躺素材）。
 */
export const SIT_HIPS_ABOVE_FEET_RATIO = 0.62

/** 坐窗沿时「头到髋」占身高的比例（= 1 − {@link SIT_HIPS_ABOVE_FEET_RATIO} ≈ 0.38）。 */
export const SIT_UPPER_BODY_RATIO = 1 - SIT_HIPS_ABOVE_FEET_RATIO

/**
 * 可坐表面的最小可见宽度比例（相对宠物宽度；N-4 / D6a 窄可见条）。
 *
 * 背景：D6a 遮挡裁剪把窗口顶边切成若干**可见段**，只有 40px 宽的段仍带 `sittable=true`
 * （宠宽 ≈398px）→ B1 会选它，宠物身体 90% 压在前层窗口本体上，成为「虚空坐」变体。
 * 阈值取 0.5：与 B5 `findSittableSurface` 的 `minWidth = 0.5 × petWidth` 口径一致，只是
 * B1 目标选择之前没有走那个入口，故在集成层补一道。
 */
export const SITTABLE_MIN_WIDTH_RATIO = 0.5

/** 爬行/站立在表面上所需 headroom 比例（全身高度）。 */
const CLIMBABLE_HEADROOM_RATIO = 1

/**
 * 「窗沿坐姿变体」头部以上竖向占用比例（2026-11-10 实测，**臀部贴沿锚点**下 ≈0.38×身高）：
 * 变体（windowLay8/9/10）本质就是坐姿；按臀部锚点后与标准坐一样只占「头到髋」≈0.38×身高，
 * 所以 50%/70% 尺寸在高窗沿上同样能完整坐下（不再出现“大尺寸只能切成标准坐”的别扭切换）。
 */
export const SIT_VARIANT_UPPER_RATIO = 0.38

/** 窗沿风格判定的额外余量（px）。 */
export const SIT_WINDOW_STYLE_MARGIN_PX = 8

/** 真躺素材 id（dev A/B / 未来随机趴躺用）。 */
export const SIT_LIE_CLIP_ID = 'mate-sitWindow'

/**
 * 窗沿坐姿变体素材 id（固定 `mate-windowLay8`）：
 * windowLay8/9/10 都是坐姿变体，但 9/10 的盘腿/侧倒姿态差异大，随机切换观感不稳 →
 * 固定用预览确认过的正坐姿态（臀部贴沿、腿垂下）；9/10 保留在 catalog 供后续选片。
 */
export const SIT_VARIANT_CLIP_ID = 'mate-windowLay8'

/** 窗沿坐/躺风格选择结果（main.ts 转给 animator）。 */
export interface SitWindowStyleChoice {
  /**
   * - `sit`：标准坐姿（sit1，臀部贴沿）；
   * - `sitVariant`：窗沿坐姿变体（windowLay8/9/10，**臀部贴沿锚点**，腿垂下）；
   * - `lie`：真躺（mate-sitWindow，平面锚点）。
   */
  mode: 'sit' | 'sitVariant' | 'lie'
  /** 指定的素材（null = 让 animator 在对应候选里随机）。 */
  clipId: string | null
  /** lie 模式额外下移（px）。 */
  sinkPx: number
}

/**
 * 选择「窗沿坐」风格（纯函数；2026-11-10 用户反馈修正二）：
 *
 * 用户看到「蹲在窗口上」的其实是**窗沿坐姿变体（windowLay8/9/10）**——素材本身是坐姿，
 * 旧实现按「躺姿」用脚底平面锚点渲染，所以看起来像蹲在窗口上。现在：
 * - 变体与标准坐一样用**臀部贴沿锚点**（腿自然垂下），才是「坐在窗口上」；
 * - 空间够放变体（≥0.38×身高 + margin，等价于「坐下后头不出屏」）→ 固定正坐变体 windowLay8；
 * - 否则 → 标准 sit（sit1 兜底；实际放置层只会在可坐时吸附，两者阈值一致）；
 * - 非上半部窗沿 / 非法输入 → 标准 sit。
 *
 * 真躺（mate-sitWindow）暂不参与自动随机，保留 dev A/B 与后续版本使用。
 */
export function chooseSitWindowStyle(input: {
  /** 窗沿顶边 y（overlay 本地 px）。 */
  surfaceTop: number
  /** workArea 顶边 y（本地 px，通常 0）。 */
  workAreaY: number
  /** workArea 高度（本地 px）。 */
  workAreaHeight: number
  /** 当前宠物高度（px）；非法 → 退化为 sit。 */
  petHeightPx: number
}): SitWindowStyleChoice {
  const sit: SitWindowStyleChoice = { mode: 'sit', clipId: null, sinkPx: 0 }
  const { surfaceTop, workAreaY, workAreaHeight, petHeightPx } = input
  if (
    !Number.isFinite(surfaceTop) ||
    !Number.isFinite(workAreaY) ||
    !Number.isFinite(workAreaHeight)
  ) {
    return sit
  }
  if (!(petHeightPx > 0) || !Number.isFinite(petHeightPx)) return sit
  const headroom = surfaceTop - workAreaY
  const upperHalf = surfaceTop < workAreaY + workAreaHeight / 2
  if (!upperHalf) return sit
  const variantNeed = petHeightPx * SIT_VARIANT_UPPER_RATIO + SIT_WINDOW_STYLE_MARGIN_PX
  if (headroom >= variantNeed) {
    // 固定正坐变体（臀部贴沿锚点在 animator 侧生效，腿自然垂下）。
    return { mode: 'sitVariant', clipId: SIT_VARIANT_CLIP_ID, sinkPx: 0 }
  }
  return sit
}

/* ------------------- Wave 2.5：窗沿坐/躺风格候选与轮换（Bug B） ------------------- */

/**
 * 躺姿竖向占用比例上限（相对身高）。
 *
 * 2026-11-10 抓图实测不同躺姿素材 ≈0.44–0.60×身高（`mate-sitWindow` ≈0.44、
 * `mate-windowLay8` ≈0.60）；取上限 **0.60** 作为「躺姿放得下」的保守门控（Lead 决策 §4.2-B4）。
 */
export const SIT_LIE_HEADROOM_RATIO = 0.60

/**
 * 窗沿坐/躺风格轮换间隔（ms；Lead 决策：约 20–30s 一次，不得连续两段同风格）。
 * 仅影响视觉素材选择，不参与 B1 确定性语义（main.ts 用 `Math.random` 取间隔）。
 */
export const SIT_STYLE_ROTATE_MS = { min: 20_000, max: 30_000 } as const

/**
 * 当前几何下允许的窗沿坐/躺风格候选（纯函数；main.ts 轮换用）。
 *
 * **只允许「窗沿适配」素材，绝不把 floor-sit（地面坐）素材搬上窗沿**（2026-11-11 verifier M-1）：
 * - 高窗（上沿在 workArea 上半部，即 `chooseSitWindowStyle` 基线为 sitVariant）
 *   → 候选 = `[sitVariant]`（windowLay8，臀部贴沿/腿垂下）；**不含标准 sit**——base sit playlist
 *   会随机播 `mate-suwari3` 等盘腿 floor-sit，渲染在窗沿上就是「盘腿/抬脚悬在窗口上」；
 *   headroom ≥ `0.60×身高 + margin` 时再追加 `lie`（mate-sitWindow）。
 *   用户当前场景（540px @ top=324）候选只有 windowLay8 → **不轮换**（M-1/M-2 消失）；
 *   小尺寸（如 20%）且 headroom 足够时仍可 坐↔躺 轮换（均为窗沿适配素材）。
 * - 矮窗（上沿在 workArea 中线及以下）→ 沿用既有已验收策略：只 `[sit]`（sit1 坐姿），不轮换；
 * - 非法输入（NaN / 身高 ≤ 0）→ 只标准 sit（不抛）。
 *
 * 不变量：结果中只要有 sitVariant/lie，就**不会**同时出现标准 sit（防止 floor-sit 混入窗沿）。
 */
export function buildSitWindowStyleCandidates(input: {
  /** 窗沿顶边 y（overlay 本地 px）。 */
  surfaceTop: number
  /** workArea 顶边 y（本地 px，通常 0）。 */
  workAreaY: number
  /** workArea 高度（本地 px；用于高低窗判定）。 */
  workAreaHeight: number
  /** 当前宠物高度（px）；非法 → 只标准坐。 */
  petHeightPx: number
}): SitWindowStyleChoice[] {
  const sit: SitWindowStyleChoice = { mode: 'sit', clipId: null, sinkPx: 0 }
  const { surfaceTop, workAreaY, workAreaHeight, petHeightPx } = input
  if (
    !Number.isFinite(surfaceTop) ||
    !Number.isFinite(workAreaY) ||
    !Number.isFinite(workAreaHeight) ||
    !Number.isFinite(petHeightPx) ||
    !(petHeightPx > 0)
  ) {
    return [sit]
  }
  // 矮窗（上沿在中线及以下）沿用「矮窗坐」策略：只标准坐（与 chooseSitWindowStyle 基线一致），不轮换。
  if (!(surfaceTop < workAreaY + workAreaHeight / 2)) return [sit]
  // 高窗：只用窗沿适配素材（windowLay8 坐姿变体 / mate-sitWindow 真躺），不混标准 sit（M-1）。
  const candidates: SitWindowStyleChoice[] = [
    { mode: 'sitVariant', clipId: SIT_VARIANT_CLIP_ID, sinkPx: 0 }
  ]
  const headroom = surfaceTop - workAreaY
  if (headroom >= petHeightPx * SIT_LIE_HEADROOM_RATIO + SIT_WINDOW_STYLE_MARGIN_PX) {
    // 真躺：平面锚点；headroom 门控已保证头不出屏，无需额外下移（sinkPx=0）。
    candidates.push({ mode: 'lie', clipId: SIT_LIE_CLIP_ID, sinkPx: 0 })
  }
  return candidates
}

/** `random()` 归一化到 [0, 1)（非法/越界值回退 0，保证纯函数不抛）。 */
function normalizeRandom(random: () => number): number {
  const value = random()
  if (!Number.isFinite(value) || value <= 0) return 0
  return value < 1 ? value : 0.999999999
}

/**
 * 轮换选择（纯函数）：从候选里挑「下一个风格下标」，**保证不与 currentIndex 相同**
 *（「不得连续两段同风格」，Lead 决策 §4.3-C1）；random 注入便于测试复现。
 *
 * - 候选 ≤1 个 → 0（无法轮换）；
 * - currentIndex 越界/非法 → 在全部候选里随机（防御性，不抛）；
 * - 其余 → 在「除当前外」的候选里均匀随机。
 */
export function pickNextSitWindowStyle(
  candidates: readonly SitWindowStyleChoice[],
  currentIndex: number,
  random: () => number = Math.random
): number {
  const count = candidates.length
  if (count <= 1) return 0
  const current =
    Number.isInteger(currentIndex) && currentIndex >= 0 && currentIndex < count ? currentIndex : -1
  const roll = normalizeRandom(random)
  if (current === -1) return Math.min(count - 1, Math.floor(roll * count))
  const slot = Math.min(count - 2, Math.floor(roll * (count - 1)))
  return slot < current ? slot : slot + 1
}

/**
 * 只保留「宠物站/坐在该表面顶边时全身仍在视口内」的坐/爬目标。
 *
 * 背景（实机验证发现）：B5 会把屏幕最上方被最大化的窗口顶边也标成 `sittable`；B2 让
 * `feet.y = surface.top` 后，宠物的上半身会跑到 workArea 上方 → 实机画面里「坐下后只剩脚」。
 * 本函数只影响 **B1 的目标选择**（坐/爬），不改变 B2 的物理落点/重力（被甩到高处的行为不变）：
 * - 坐：`headroom = surface.top − workArea.y ≥ (1 − 0.62)×petHeightPx + margin`
 *   （臀部贴沿时**头到髋**约 0.38×身高，见 {@link SIT_UPPER_BODY_RATIO}；保证头不出屏）；
 * - 爬：仍需全身高度（`headroom ≥ petHeightPx + margin`，全身可见才不会被屏幕顶截断）；
 * - 可坐表面还要求可见宽度 ≥ `petWidthPx × SITTABLE_MIN_WIDTH_RATIO`（D6a 窄可见条不可坐）；
 * - 不满足 → 该表面 `sittable` / `climbable` 置 false（B1 换下一个表面或放弃该活动）。
 *
 * 数值示例（margin=8）：540px（50% 档）坐姿阈值 ≈213px、756px（70% 档）≈295px
 * → Finder 类窗沿（top=324）在 50%~79% 尺寸下都能完整坐下；贴屏幕顶的窗沿（如 y=36）仍不可坐。
 *
 * `petWidthPx` 非法/缺失（未传）时不启用宽度过滤（保持旧语义，兼容既有调用方/旧测试）。
 */
export function filterDesktopTargetsForPet(
  snapshot: DesktopSnapshot,
  petHeightPx: number,
  petWidthPx?: number,
  marginPx: number = SURFACE_HEADROOM_MARGIN_PX
): DesktopSnapshot {
  const height = Number.isFinite(petHeightPx) && petHeightPx > 0 ? petHeightPx : 0
  const width =
    typeof petWidthPx === 'number' && Number.isFinite(petWidthPx) && petWidthPx > 0
      ? petWidthPx
      : 0
  const margin = Number.isFinite(marginPx) && marginPx >= 0 ? marginPx : SURFACE_HEADROOM_MARGIN_PX
  // 坐：臀部贴窗沿时「头到髋」约 0.38×H 在窗沿上方 → 需要同样高度的 headroom（+ margin 防贴边）。
  const sitHeadroom = height > 0 ? height * SIT_UPPER_BODY_RATIO + margin : 0
  const climbHeadroom = height > 0 ? height * CLIMBABLE_HEADROOM_RATIO + margin : 0
  const minSittableWidth = width * SITTABLE_MIN_WIDTH_RATIO
  if (height === 0 || snapshot.surfaces.length === 0) return snapshot
  let changed = false
  const surfaces: DesktopSurface[] = snapshot.surfaces.map((surface) => {
    const headroom = surface.top - snapshot.workArea.y
    // 宽度未知（非法 rect）时不做判断（保持旧行为）：只有「宽 < 下限」的确定窄段才过滤。
    const widthOk =
      minSittableWidth <= 0 ||
      !Number.isFinite(surface.rect.width) ||
      surface.rect.width >= minSittableWidth
    // 2026-11-08 用户反馈：没有椅子 → 只在**窗口上沿**坐（Dock/菜单栏/地面不再坐）；
    // 窗沿坐用 hip 锚点（臀部贴沿、腿悬垂）：2026-11-10 起按「至少 70% 可见」放宽（不再要求上半身完整）。
    const sittable =
      surface.sittable &&
      surface.kind === 'window-top' &&
      headroom >= sitHeadroom &&
      widthOk
    const climbable = surface.climbable && headroom >= climbHeadroom
    if (sittable === surface.sittable && climbable === surface.climbable) return surface
    changed = true
    return { ...surface, sittable, climbable }
  })
  return changed ? { ...snapshot, surfaces } : snapshot
}

/* ---------------------- Wave 2.5：坐姿接近阶段的动画 mood ---------------------- */

/**
 * 「窗沿卧姿」安全网认可的动画 mood（2026-11-10 用户设计约束：可坐窗口上沿只允许趴/坐/躺）。
 *
 * - `sit`：标准坐 / 窗沿坐姿变体（windowLay8/9/10）；
 * - `sleep`：躺姿，视觉上同样不是站立，允许保留。
 */
export const WINDOW_TOP_RECUMBENT_MOODS: ReadonlySet<PetMood> = new Set<PetMood>(['sit', 'sleep'])

/**
 * 脚底是否 grounded 在**可坐窗口上沿**（与 B1 同一套 `filterDesktopTargetsForPet` 后快照判定）。
 *
 * 只认 `grounded === true` + 表面 id 命中 + `kind === 'window-top'` + `sittable === true`：
 * 地面/Dock/菜单栏、可站不可坐的高窗沿、空中/拖拽都不算（仍按原动画表现）。
 */
export function isGroundedOnSittableWindowTop(
  motion: MotionSnapshot,
  desktop: DesktopSnapshot
): boolean {
  if (motion.grounded !== true || typeof motion.surfaceId !== 'string') return false
  const surface = desktop.surfaces.find((item) => item.id === motion.surfaceId) ?? null
  return surface !== null && surface.kind === 'window-top' && surface.sittable === true
}

/**
 * 坐姿接近阶段（B2 `sit-approach`：受控滑向坐面，`grounded=false`）的**动画 mood**。
 *
 * 背景：B1 的 sit activity 从接近阶段就下发 `mood='sit'`（行为语义），若动画层照搬，
 * 会出现「保持坐姿滑向窗口顶部」的诡异画面（旧 B3 同样存在）。集成层在这里把**动画** mood
 * 换成移动语义 `walk`（有 VMD walk 时播真实步态）；落座（grounded）后仍用 `sit`（VMD 坐姿）。
 * **B1 的 decision.mood 不变**（只影响动画层）。
 * 2026-11-08 用户反馈「爬窗双臂高举难看」：垂直接近不再用 `climb`（回退 B3 举臂姿态）。
 *
 * 2026-11-10（Bug B / Lead 决策 §4.2-B）追加**动画层安全网**（第 3 参，默认 false 向后兼容）：
 * 即使 B1 因非自主路径（pat/poke/DSH 反应/窗口事件…）在可坐窗沿上产出非 recumbent 的动画 mood，
 * 动画层也强制 `sit`，保证视觉不站。tradeoff：反应被压成坐姿，仅气泡/表情可见（Lead 已批准）。
 * 不含 dragging / airborne / fall：拖拽、空中、落地受击姿态照常播放（物理/交互优先级更高）。
 */
export function animationMoodFor(
  decision: BehaviorDecision,
  motion: MotionSnapshot,
  onSittableWindowTop = false
): PetMood {
  // 顺序：先处理坐姿接近覆盖（保留既有行为），再做窗沿安全网。
  if (decision.motion.kind === 'sit' && !motion.grounded) {
    // 坐姿接近阶段统一用 walk：2026-11-08 用户反馈「爬窗双臂高举」观感差，且已被从计划移除，
    // 垂直接近不再回退 B3 爬行姿态（避免高举双手）。
    return 'walk'
  }
  if (
    onSittableWindowTop &&
    motion.grounded === true &&
    motion.airborne !== true &&
    decision.mood !== 'drag' &&
    decision.mood !== 'fall' &&
    !WINDOW_TOP_RECUMBENT_MOODS.has(decision.mood)
  ) {
    return 'sit'
  }
  return decision.mood
}

/**
 * Wave 2 宠物运行时：所有业务模块的组合根。
 *
 * 使用顺序（main.ts）：
 * 1. 构造后 `updateWindows(await api.getWindows(), now)` 取基线；
 * 2. 每帧 `const out = runtime.frame({...}); scene.setAnimationInput(out.animation); scene.placePet(out.petRect, out.motion.feet.y)`；
 * 3. 配置变化 `runtime.setConfig(next)`；屏幕/尺寸变化 `runtime.updateEnvironment(env)`；
 * 4. DSH `runtime.pushDshEvent(event, now)` + 周期 `runtime.updateDshStatus(status, now)`；
 * 5. 交互事件发生时 `runtime.beginDrag/dragTo/endDrag`（与 B4 的 InteractionController 对接）。
 */
export class PetRuntime {
  readonly physics: PetPhysics
  readonly desktopSensor: DesktopSensor
  readonly behaviorDirector: BehaviorDirector
  readonly dshReactionTracker: DshReactionTracker

  private env: PetRuntimeEnvironment
  private configSubset: BehaviorConfigSubset
  private readonly random: () => number
  private readonly dshEnabled: () => boolean
  private lastMotion: MotionSnapshot
  private lastDecision: BehaviorDecision | null = null
  /** 上一次拖拽结束时保存的甩出速度大小（用于 airborne 瞬间的 thrown 动画事件）。 */
  private pendingThrowSpeed = 0
  /** 上一帧 motion（用于 land/airborne 沿检测）。 */
  private previousMotion: MotionSnapshot | null = null
  /** 最近一帧的单调时钟（调试 teleport/快照用）。 */
  private lastNowMs = 0

  constructor(options: PetRuntimeOptions) {
    this.env = options.env
    this.configSubset = toBehaviorConfig(options.config)
    this.dshEnabled = () => this.configSubset.dshLink
    this.random = typeof options.random === 'function' ? options.random : Math.random

    const fallbackFeet: Point2D = {
      x: this.env.workArea.x + this.env.workArea.width - this.env.petSize.width / 2 - 16,
      y: this.env.workArea.y + this.env.workArea.height
    }
    this.physics = new PetPhysics({
      workArea: this.env.workArea,
      petSize: this.env.petSize,
      initialFeet: options.initialFeet ?? fallbackFeet
    })
    this.desktopSensor = new DesktopSensor()
    this.behaviorDirector = new BehaviorDirector({
      seed: undefined,
      random: this.random,
      initialMood: options.initialMood ?? 'idle',
      initialNowMs: 0
    })
    this.dshReactionTracker = new DshReactionTracker()
    this.lastMotion = this.physics.getSnapshot()
    this.syncDesktopEnvironment()
    this.physics.setEnvironment({
      workArea: this.env.workArea,
      petSize: this.env.petSize,
      surfaces: this.desktopSensor.snapshot(0).surfaces
    })
  }

  /** 配置热更（行为子集 + DSH 开关）。 */
  setConfig(config: PetConfig): void {
    this.configSubset = toBehaviorConfig(config)
  }

  /** 环境更新（workArea / 宠物尺寸 / overlay 原点 / 显示器变化）。 */
  updateEnvironment(env: PetRuntimeEnvironment): void {
    this.env = env
    this.syncDesktopEnvironment()
    this.physics.setEnvironment({
      workArea: this.env.workArea,
      petSize: this.env.petSize,
      surfaces: this.lastDesktopSnapshot?.surfaces ?? []
    })
    // 02-L5：setEnvironment 可能已 clamp 位置 / 吸附表面 / 落地，物理状态已变；
    // 若不同步 lastMotion/previousMotion，下一帧前的 `runtime.motion`、petRect/pointerGate
    // 以及沿检测（landed/thrown）仍会用旧一帧的快照。用物理当前快照刷新。
    const refreshed = this.physics.getSnapshot()
    this.lastMotion = refreshed
    this.previousMotion = refreshed
  }

  /** 窗口列表更新（`pet:windows` 基线 + `windows-updated` 推送）。 */
  updateWindows(windows: WindowInfo[], nowMs: number): void {
    this.desktopSensor.updateWindows(windows, nowMs)
  }

  /** B7：DSH 事件（main 已保证仅 online 时转发）。 */
  pushDshEvent(event: Parameters<DshReactionTracker['pushEvent']>[0], nowMs: number): void {
    if (!this.dshEnabled()) return
    this.dshReactionTracker.pushEvent(event, nowMs)
  }

  /** B7：DSH 状态更新（在线与否；离线时清残留反应）。 */
  updateDshStatus(status: Parameters<DshReactionTracker['pushStatus']>[0], nowMs: number): void {
    this.dshReactionTracker.pushStatus(status, nowMs)
  }

  /** B4 拖拽开始（main.ts 收到 dragStart 事件后立刻调用，不等下一帧）。 */
  beginDrag(pointer: Point2D, nowMs: number): void {
    this.physics.beginDrag(pointer, nowMs)
    this.pendingThrowSpeed = 0
  }

  /** B4 拖拽移动。 */
  dragTo(pointer: Point2D, nowMs: number): void {
    this.physics.dragTo(pointer, nowMs)
  }

  /**
   * B4 拖拽结束：返回甩出速度（main.ts 可广播给调试面/音效）。
   * `throwVelocityOverride` = B4 自己估计的释放速度（优先采用，B2 仍会 clamp 上限）。
   */
  endDrag(nowMs: number, throwVelocityOverride?: Point2D): { throwVelocity: Point2D } {
    const result = this.physics.endDrag(nowMs, throwVelocityOverride)
    const speed = Math.hypot(result.throwVelocity.x, result.throwVelocity.y)
    this.pendingThrowSpeed = Number.isFinite(speed) ? speed : 0
    // P0-1：慢速松手且压在**可坐**窗口上沿 → 吸附上沿并立刻坐下；其余情况走原自由落体。
    this.tryBeginPlacement(nowMs, this.pendingThrowSpeed)
    return result
  }

  /**
   * 松手放置（P0）：慢速松手且宠物压在**可坐**窗口上沿时，直接吸附上沿并请求 B1 立刻坐下
   *（没有"先落地再等 450ms"的站立中间态）。
   *
   * **其余情况一律回退到原有物理**（2026-11-10 用户要求恢复）：
   * - 松手点不在窗口上 / 窗口上沿太高、被遮挡、不可坐 / 吸附失败 → 正常自由落体/甩出；
   * - 高处落地仍走既有 `thrown → landed` 链路播眩晕/受击反应（`hsr-stun` / `hsr-revive`）。
   *
   * 快速甩出（≥ {@link PLACEMENT_MAX_THROW_SPEED_PX_PER_SEC}）同样走普通抛掷物理。
   */
  private tryBeginPlacement(_nowMs: number, releaseSpeedPxPerSec: number): void {
    if (!(releaseSpeedPxPerSec < PLACEMENT_MAX_THROW_SPEED_PX_PER_SEC)) return
    const motion = this.physics.getSnapshot()
    // 松手瞬间已被「贴沿吸附」落到窗沿上（P1 容差）→ 不需要放置。
    if (motion.grounded) return
    const desktop = this.lastDesktopSnapshot
    if (!desktop || desktop.surfaces.length === 0) return
    const petRect = computePetRectFromFeet(motion.feet, this.env.petSize)
    const target = this.desktopSensor.findPlacementTarget(petRect)
    if (!target) return

    const targetSurface = target.topSurface
    if (!targetSurface) return
    const forBehavior = filterDesktopTargetsForPet(
      desktop,
      this.env.petSize.height,
      this.env.petSize.width
    )
    const sittable = forBehavior.surfaces.some(
      (surface) => surface.id === targetSurface.id && surface.sittable === true
    )
    if (!sittable) return

    // 可坐：直接吸附到窗沿 + 立刻坐下（不再走"滑过去→落地→450ms 后坐下"）。
    const halfWidth = this.env.petSize.width / 2
    const rect = targetSurface.rect
    const minCenterX = rect.x + halfWidth
    const maxCenterX = rect.x + rect.width - halfWidth
    const targetX =
      maxCenterX >= minCenterX ? clampPx(motion.feet.x, minCenterX, maxCenterX) : rect.x + rect.width / 2
    const snapped = this.physics.snapOntoSurface(targetSurface.id, targetSurface.top, {
      x: targetX,
      y: targetSurface.top
    })
    if (!snapped) return
    this.behaviorDirector.requestSitOnSurface(targetSurface.id)
    // 放置不是"甩出"：清掉甩出速度，避免 B3 播 thrown 动画。
    this.pendingThrowSpeed = 0
  }

  /** 调试：强制触发行为活动（`window.__aventurineDebug.debugTriggerActivity`）。 */
  debugTriggerActivity(activityId: string, nowMs: number): boolean {
    return this.behaviorDirector.triggerActivity(activityId, nowMs)
  }

  /** 调试/截图：把宠物瞬移到指定脚底点（窗口本地 px；立刻消费 teleport，不等下一帧决策覆盖）。 */
  debugTeleport(feet: Point2D): boolean {
    if (!feet || !Number.isFinite(feet.x) || !Number.isFinite(feet.y)) return false
    this.physics.setCommand({ kind: 'teleport', feet: { x: feet.x, y: feet.y } })
    // teleport 是运动指令：必须在本帧内被 step 消费，否则下一帧 B1 的决策会覆盖它。
    // 注意 step(0) 会跳过 advance（teleport 不生效），必须给一个极小正 dt。
    this.physics.step(0.001, this.lastNowMs)
    this.lastMotion = this.physics.getSnapshot()
    return true
  }

  /**
   * 调试快照（**只读**：不调用 `desktopSensor.snapshot()`，避免把一次性 transitions 取走，
   * 导致 B1 下一帧收不到窗口变化事件）。
   */
  snapshot(nowMs: number): PetRuntimeSnapshot {
    return {
      desktop:
        this.lastDesktopSnapshot ?? {
          surfaces: [],
          transitions: [],
          workArea: { ...this.env.workArea },
          screenBounds: {
            x: 0,
            y: 0,
            width: this.env.viewport.width,
            height: this.env.viewport.height
          }
        },
      motion: this.physics.getSnapshot(),
      reaction: this.dshReactionTracker.reactionAt(nowMs),
      decision: this.lastDecision
    }
  }

  /** 最近一次桌面快照（updateEnvironment 时需要 surfaces，避免提前取走 transitions）。 */
  private lastDesktopSnapshot: DesktopSnapshot | null = null

  /** 每帧主更新（见类注释的使用顺序）。 */
  frame(input: PetRuntimeFrameInput): PetRuntimeFrameOutput {
    const nowMs = Number.isFinite(input.nowMs) ? input.nowMs : 0
    this.lastNowMs = nowMs
    const dt = Number.isFinite(input.dt) ? Math.min(0.1, Math.max(0, input.dt)) : 0

    // 1) 桌面快照（会取走 transitions；先给行为用，再给物理环境）
    const desktop = this.desktopSensor.snapshot(nowMs)
    this.lastDesktopSnapshot = desktop
    this.syncDesktopEnvironment()

    // 2) 外部反应（DSH）：只取未过期且开关开启的
    const external = this.dshEnabled() ? this.dshReactionTracker.reactionAt(nowMs) : null

    // 3) 行为决策
    // 目标表面可见性过滤：只让 B1 选「坐/爬到顶边时全身可见」的表面（B2 物理落点不变）。
    // 传宽度用于 N-4 窄可见条过滤（D6a 遮挡裁剪后 40px 段仍可坐 → 虚空坐变体）。
    const desktopForBehavior = filterDesktopTargetsForPet(
      desktop,
      this.env.petSize.height,
      this.env.petSize.width
    )
    // H-3b 契约侧：把 B2 实际可达的 x 区间告诉 B1（walkTo/returnCorner 目标钳制用）。
    // 宠物尺寸非法时不传字段（B1 保持旧行为 = 按 workArea 全宽）。
    const motionLimits = computeMotionLimits(this.env.workArea, this.env.petSize)
    // 「放在窗口上站定」期间暂停自主活动（用户 2026-11-09：原地待机、不要自己走开；再次拎起即恢复）。
    const placedAnchor = this.physics.isAnchored()
    const behaviorConfig: BehaviorConfigSubset = placedAnchor
      ? { ...this.configSubset, autonomous: false }
      : this.configSubset
    const behaviorInput: BehaviorInput = {
      nowMs,
      dt,
      motion: this.physics.getSnapshot(),
      ...(motionLimits ? { motionLimits } : {}),
      desktop: desktopForBehavior,
      interaction: input.interaction,
      events: input.events,
      external,
      config: behaviorConfig,
      random: this.random
    }
    const decision = this.behaviorDirector.update(behaviorInput)
    // Wave 2.5 D3：走路指令改用「体高相对自然步速」（与 VMD walk clip 同口径，避免滑步）。
    const walkCommand = withNaturalWalkSpeed(
      decision.motion,
      this.env.petSize.height,
      this.configSubset.autonomousLevel
    )
    const runtimeDecision: BehaviorDecision =
      walkCommand === decision.motion ? decision : { ...decision, motion: walkCommand }
    this.lastDecision = runtimeDecision

    // 4) 物理：环境（表面可能刚变）+ 指令 → 步进
    this.physics.setEnvironment({
      workArea: this.env.workArea,
      petSize: this.env.petSize,
      surfaces: desktop.surfaces
    })
    this.physics.setCommand(walkCommand)
    const motion = this.physics.step(dt, nowMs)

    // 5) 组装 B3 输入（沿检测生成 thrown/landed 事件）
    const animationEvents = this.toAnimationEvents(input.events, motion)
    // 朝向：移动类 mood 朝运动方向（侧身走路/爬墙/被拎起），站定/交互时回正面。
    // PetScene 会把 modelRoot 平滑转到 ±90°；B3 的 look-at 局部化按同一 facing 换算。
    // 坐姿接近阶段用 walk/climb 动画（避免「坐着滑过去」）；B1 decision.mood 不变。
    // 窗沿安全网（Bug B）：用**物理 step 后**的 motion + 本帧过滤后的桌面快照判定「是否 grounded 在
    // 可坐窗口上沿」，非 recumbent 动画 mood 压成 sit（O(surfaces) 查找，不新建大对象）。
    const animationMood = animationMoodFor(
      runtimeDecision,
      motion,
      isGroundedOnSittableWindowTop(motion, desktopForBehavior)
    )
    const facing: Facing = facingForAnimation(animationMood, motion, input.interaction.dragging)
    const animation: AnimationDriverInput = {
      mood: animationMood,
      motion,
      facing,
      lookTarget: runtimeDecision.lookTarget,
      dragging: input.interaction.dragging,
      events: animationEvents,
      bubbleText: input.bubbleText
    }

    this.previousMotion = motion
    this.lastMotion = motion

    return {
      decision: runtimeDecision,
      motion,
      petRect: computePetRectFromFeet(motion.feet, this.env.petSize),
      animation,
      facing
    }
  }

  /** 最近一次 motion（未 frame 时为构造时的初始快照）。 */
  get motion(): MotionSnapshot {
    return this.lastMotion
  }

  /** 把 B5 环境同步给 DesktopSensor（overlay 原点 / display / viewport）。 */
  private syncDesktopEnvironment(): void {
    this.desktopSensor.updateEnvironment({
      overlayOrigin: this.env.overlayOrigin,
      display: this.env.display,
      viewport: { width: this.env.viewport.width, height: this.env.viewport.height }
    })
  }

  /**
   * B4 交互事件 → B3 动画事件。
   * - pat/poke 直接透传；dragStart/dragEnd 透传；
   * - 沿检测：本帧从空中落地 → landed；从地面进入空中且最近有甩出 → thrown。
   */
  private toAnimationEvents(
    events: readonly InteractionEvent[],
    motion: MotionSnapshot
  ): AnimationEvent[] {
    const result: AnimationEvent[] = []
    for (const event of events) {
      switch (event.kind) {
        case 'pat':
          result.push({ kind: 'pat' })
          break
        case 'poke':
          result.push({ kind: 'poke', region: event.region })
          break
        case 'dragStart':
          result.push({ kind: 'dragStart' })
          break
        case 'dragEnd':
          result.push({ kind: 'dragEnd' })
          break
        default:
          break
      }
    }

    const previous = this.previousMotion
    if (previous) {
      if (previous.airborne && !motion.airborne) {
        const impact = Math.abs(previous.velocity.y)
        result.push({ kind: 'landed', impactSpeed: Number.isFinite(impact) ? impact : 0 })
        this.pendingThrowSpeed = 0
      } else if (!previous.airborne && motion.airborne && this.pendingThrowSpeed > 0) {
        result.push({ kind: 'thrown', speed: this.pendingThrowSpeed })
        this.pendingThrowSpeed = 0
      }
    }
    // 放置站定完成（anchor 模式没有真实落地沿）→ 给 B3 一个 landed 事件播落地姿态。
    if (this.physics.consumePlacementLanded()) {
      result.push({ kind: 'landed', impactSpeed: 0 })
    }
    return result
  }
}

/**
 * 是否属于「移动中」mood。
 *
 * 这些 mood 下模型会**侧身朝运动方向**（`scene.setFacing(motion.facing)`），并且
 * `vrm/look-at.ts` 会停止鼠标注视（头部随身体朝运动方向，而不是扭头看镜头）。
 * 移动类 mood 清单（V7 用户实机反馈）：
 * walk（走路）/ climb（攀爬）/ fall（坠落）/ drag（被拎起）/ grabWindow（抓窗口移动）。
 */
export function isMovingMood(mood: PetMood): boolean {
  return mood === 'walk' || mood === 'climb' || mood === 'fall' || mood === 'drag' || mood === 'grabWindow'
}

/**
 * 动画/场景朝向（V7）：决定模型 root 是否侧身（`PetView.setFacing`）。
 *
 * - 移动类 mood → 朝运动方向（B2 `motion.facing`）；
 * - 拖拽起手兜底：正常情况下 `PetPhysics.beginDrag` 已把 front 切成侧向，但若事件转发/
 *   step 顺序变化导致本帧仍拿到 front，这里再兜底成 {@link DRAG_START_FACING}，
 *   保证「被拎起来时头/身体朝侧边」不会因时序退化回正面朝镜头；
 * - 其余（idle/sit/pat/sleep/DSH 反应…）→ 'front'，站定/交互时面向镜头；
 *   落地后朝向也靠这里自然回正（B2 自己不会把 facing 重置为 front）。
 */
export function facingForAnimation(
  mood: PetMood,
  motion: MotionSnapshot,
  dragging: boolean
): Facing {
  if (!isMovingMood(mood)) return 'front'
  if (motion.facing !== 'front') return motion.facing
  return dragging ? DRAG_START_FACING : motion.facing
}

/** 朝向工具（main.ts 里朝向调试面/后续音效可用；B2/B3 已各自处理）。 */
export function facingSign(facing: Facing): -1 | 0 | 1 {
  return facing === 'left' ? -1 : facing === 'right' ? 1 : 0
}
