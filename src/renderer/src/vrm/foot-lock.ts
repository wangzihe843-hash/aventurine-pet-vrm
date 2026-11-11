/**
 * 静态脚部固定（foot planting / foot lock）—— 2026-11-09 重做（用户反馈「静态动作固定腰部
 * 导致桌宠的脚会滑来滑去」）。
 *
 * ## 旧实现为什么等于没生效（本次根因）
 * 1. 接触判据是「bbox 脚底 y（`avatar.restFeetY` ≈ 0）+ 2cm」，但比较的却是**踝骨（foot 骨）**
 *    的世界 y。本模型 rest 踝高 ≈ 9.8cm（`aventurine-tpose.vrm`，bbox 脚底 ≈ 0.7mm）→
 *    `footY <= restFeetY + 0.02` 在站立/待机时**永远不成立**，foot-lock 从未触发；
 *    旧单测的假 rig 恰好把脚骨放在 y=0（= restFeetY），把该缺陷掩盖了。
 * 2. idle 池里有多个来源的待机（HSR/adv/mate），站姿脚位相差约 15–20cm；播放器每 12–20s
 *    随机换一条、以 0.8–1.0s crossfade → 混合期间腰/身体位置固定、脚在地面滑 36–49px
 *    （540px 宠物高实测，见 `docs/research/foot-slide-static-planting.md`）。
 *
 * ## 本次方案（参考 Orange Duck「IK & Foot Locking」、rabfulton/VRM `docs/foot-planting.md`）
 * 1. **接触判定以本模型 rest 踝高为基准**（构造时从 normalized rest 骨实测，不写死 bbox/比例），
 *    并带「抬高 + 水平速度」双条件与进入/退出迟滞——避免把 crossfade 的混合位移误判成抬脚；
 * 2. 接触时在 **avatar.scene 局部空间**记录踝锚点（位置；默认同时锚定朝向），**跨 clip 切换保持**
 *    （idle 变体之间换动作时脚不挪窝）；
 * 3. 两骨闭式 IK（余弦定理 + 极向量）把踝拉回锚点，是「对现有姿势的最小修改」而不是重摆姿势；
 * 4. 目标超出腿长时允许**有界骨盆下沉**（默认 ≤4cm，阻尼平滑）保证可达；仍不可达则释放锚点，
 *    避免把腿拉成畸形——宁可少量滑步，也不改坏源动画（Orange Duck 的取舍）；
 * 5. **只在静止动作启用**：walk/climb/fall/drag/grabWindow/sit/sleep/pat 一律不锁。走路滑步由
 *    clip-player 的步幅地速校准（V13）负责；拖拽/悬空/坐/睡由姿态本身决定——本轮不碰，
 *    避免回归用户已验收的走路/拖拽观感；pat 是动态反应（触地帧重锚会把腿拉直 +20°，见
 *    `docs/fix-report-2026-11-11-leg-bend-v2.md`），锁脚有害无益。
 *
 * ## 2026-11-11 腿形修复 v2：候选 g（3-DOF 骨盆距离保持解），替代旧 A 的均值水平平移
 *
 * 旧 A 只按「作者踝位 − 锚点」的**均值**平移 hips 水平位置；它对齐了脚位，但**不保证**
 * `|hip − pin|` 等于作者本帧的髋→踝距离 `d_author`——跨变体站姿差、程序化微动的骨盆平移、
 * IK 腿长钳制都会让 IK 把膝盖多弯几度（实测 idle 平均 −15°/−4°，用户截图“弯腿”主因）。
 *
 * 候选 g：两骨腿的膝屈曲角由 `|髋 − 踝目标|` 距离唯一决定（余弦定理、骨长固定）。每帧对每条
 * `contact && pinPosition != null` 的腿取本帧 IK 前（clip+micro 已写）作者姿态的
 * `hip_i`（upperLeg 世界位置→scene local）、`pin_i`、`d_i = |hip_i − ankle_i|`，解 hips 偏移
 * `δ=(dx,dy,dz)` 满足 `|hip_i + δ − pin_i| = d_i`：
 * - 双脚：Gauss-Newton（JᵀJ + λI，λ=3e-4，≤16 iter，残差 <1e-6 提前退出，warm start 上一帧 δ）；
 * - 单脚：解析最小范数解 `δ = (d/|hip−pin| − 1)·(hip−pin)`；0 脚：目标 0；
 * - 钳制 `|δxz| ≤ 0.10m`、`δy ∈ [−0.03,+0.02]m`；deadband ≤0.5mm；平滑 τ=0.2s；非累积
 *   （每帧叠加在 clip+micro 刚写回的 hips 上）；
 * - g 生效时可达性循环的 `targetDrop` 固定 0（δy 即骨盆升降），保留「required > reach−margin →
 *   release」兜底；NaN / 钳制后距离残差 >10mm → 回退旧 A + 原 pelvisDrop（`stanceAlignMode='mean'`
 *   可强制回退，作为一键回滚通道）。
 *
 * 求解细节/离线 A/B 数字见 `docs/fix-report-2026-11-11-leg-bend-v2.md` 与
 * `tests/tmp/inv-leg2/REPORT.md` §12/§13。
 *
 * ## 2026-11-11 换姿势重锚（stance replant）：修「锁脚过度 → 换 idle 脚不动 / 各站姿被抹平」
 *
 * 根因：pin 被设计为跨 clip 永久保持；crossfade 期间接触状态冻结；普通 idle 作者踝抬升
 * ≤0.4mm、水平速度≈0，永远到不了 2cm/0.9m/s 的释放阈值 → 换变体后脚仍钉在当天第一次的锚点，
 * 3-DOF 骨盆解只能把差异吸收成腿方向偏转 + 身体侧移（见 `tests/tmp/footlock-replant/root-cause.md`）。
 *
 * 方案（`poseReplant`，默认开启）：animator 把当前 `clipId` 传进来；检测到 clipId 变化后先
 * `pendingReplant`（crossfade 期间继续冻结接触/pin 保持），fade 结束的第一帧读取**本帧 IK 前**
 * 新 clip 作者踝位（clip+micro 已写，此刻姿态=纯目标 clip）+ 脚朝向作为目标，用单脚错峰的
 * 抬脚弧线把 pin 搬过去；落地后 pin=目标、恢复刚性锁定与 g 求解。要点：
 * - **只采样一次**目标（重踏中不追混合姿态，避免抖）；两只脚同一时刻最多一只离地：按水平距离
 *   降序排队，后一脚在前一脚完成 + `replantStepGapSec` 后开始；
 * - 单脚轨迹：`u=clamp(local/T,0,1)`；T=clamp(d/0.45mps, 0.30s, 0.45s)；水平只在
 *   `u∈[0.12,0.88]` 内 smoothstep（先抬后走/先停后落，无过冲）；抬脚
 *   `h=clamp(0.15·d, 0.012m, 0.030m)·sin(πu)`（下限比设计初值 0.010 高 2mm，见常量注释）；
 *   朝向与水平同进度最短弧 slerp；
 * - `d < replantMinMoveM (0.012m)`：迷你混合（0.15s、不抬脚）平滑搬 pin，避免瞬移；
 * - 重踏期间该脚 `contact` 保持 true 并冻结接触状态机（脚本抬脚不被自家阈值判成离地）；
 * - 重踏/衰减期间 **g 让位**：`replantAlignFrom = 当前 hipShift`，目标按全体换步进度 smoothstep
 *   衰减到 0；全部落地后保持 δ=0 一段 `REPLANT_SETTLE_SEC=0.4s`，再恢复常规 g；期间跳过
 *   `projectStanceShift` 与 fallback 求解（pin 在动，投影/回退会把 δ 猛推回旧流形）；settle 后
 *   再给 `projectStanceShift` 一个 0.5s 渐入期（避免 τ 滞后被一次性投影成单帧身体跳）；
 * - **g 的 2 脚解从 0 出发（不用回退 warm start）**：双腿近伸直时 2 约束接近相切、解是一条
 *   一维流形；带 warm start 会被 micro-motion 逐帧推着沿流形漂移（实测站稳后 hipShift 从 0
 *   漂到 6.5cm → 站立/起步身体侧向漂移），从 0 出发收敛到近最小范数解才稳定；
 * - v1 只对 `idle` mood 启用（`REPLANT_ALLOWED_MOODS`）；表演型 idle 走作者抬脚/朝向释放，
 *   dsh/一次性片段留待 P1；
 * - 新 clip 在重踏中再次切换：`finishReplantNow()` 把脚停在当前插值位，再从当前位置重新规划；
 *   进入 walk/sit/drag/pat/空中等 ineligible 状态：立即结束重踏，走原有释放路径。
 *
 * 回滚/AB：`poseReplant:false` = 旧行为（跨 clip 保持锚点）；`stanceAlignMode:'mean'` 时本功能
 * 自动关闭（保持旧 A 回滚通道纯净）。参数均为构造 option（见 `runtime-types.ts`）。
 *
 * 调用顺序：clip-player.update()（写 normalized 骨 + hips）之后、animator 的 `humanoid.update()`
 * 之前；本模块内部按需刷新世界矩阵，最后统一由 animator `humanoid.update()` 同步 raw 骨。
 *
 * 另外：本模块**不写** `avatar.scene` 的 position/rotation/scale（摆放/朝向归场景层），
 * 只在有界范围内改 normalized hips 的 y（骨盆下沉）与 normalized 腿/脚旋转。
 */
import { Matrix4, Quaternion, Vector3, type Object3D } from 'three'

import type { AnimationInput } from '../core/wave2-contract'
import type { HumanoidBone } from '@shared/vrm'
import type {
  VrmAvatar,
  VrmFootLockDebugSnapshot,
  VrmFootLockOptions
} from './runtime-types'

/* -------------------------------------------------------------------------- */
/* 常量                                                                        */
/* -------------------------------------------------------------------------- */

/** 不参与脚部固定的 mood（移动/拖拽/坐/睡/悬空由动作或物理决定姿态）。 */
const FOOT_LOCK_DISABLED_MOODS: ReadonlySet<string> = new Set([
  'walk',
  'climb',
  'fall',
  'drag',
  'grabWindow',
  'sit',
  'sleep',
  // pat（2026-11-11 v2）：动态反应 clip 的「触地帧」会被重新锚定，随后作者把脚带远时 IK 会把腿
  // 拉直（mate-shyPoint 左膝 +19.8°/g 后 +24.3°，REPORT §13.3 表 13-C）——动态反应本就不该锁脚。
  'pat'
])

/**
 * 接触判定：踝骨相对 rest 踝高的抬升容差（米；进入接触 = 脚真的落地才钉）。
 *
 * 2026-11-11 R1：0.03 → 0.012（退出 0.05 → 0.020，见下）。依据
 * `tests/tmp/inv-limits/REPORT.md` §2/§4-R1：作者动画 `hsr-idleShow` 的右踝**有意抬升 4.1cm**，
 * 旧的退出阈值 5cm 不释放 → 两骨 IK 把抬起的脚钉回地面锚点 → 右膝屈曲被拧出 +22.1°
 * （左腿被反向带弯 −21.1°）——这是 L1 已知限制里最扎眼的来源。把退出阈值降到 2cm 后该脚
 * 正常释放、随作者动画抬起（偏差 0.0°，不是脚滑）。
 *
 * 影响面（同报告 `authorStance`/`exp-results.json`）：其余 idle 变体作者踝抬升大多 ≤7mm，
 * 1.2cm 进入 / 2.0cm 退出的迟滞不会误释放普通站姿；crossfade 期间仍由 `transitioning`
 * 冻结接触状态（混合位移不参与判定）。测量基准未变（仍以构造时实测 rest 踝高为 0）。
 */
const CONTACT_ENTER_LIFT_M = 0.012
/** 接触判定：抬升超过该值视为离地（米；退出接触，迟滞避免抖动）。R1：0.05 → 0.020。 */
const CONTACT_EXIT_LIFT_M = 0.02
/** 接触判定：进入所需的最大水平速度（米/秒；避免抬脚/落脚的瞬间就钉住）。 */
const CONTACT_ENTER_SPEED_MPS = 0.25
/** 接触判定：保持接触允许的最大水平速度（米/秒；有意的快速换脚/转身时释放）。 */
const CONTACT_HOLD_SPEED_MPS = 0.9

/** 接触权重平滑时间常数（秒）：进入快、退出稍慢。 */
const WEIGHT_TAU_IN_SEC = 0.08
const WEIGHT_TAU_OUT_SEC = 0.15
/** 权重低于该值视为完全释放（清掉 pin）。 */
const RELEASE_WEIGHT_EPSILON = 0.01

/** 骨盆下沉上限（米；保证脚可达的同时避免明显下蹲/T-rex 观感）。 */
const MAX_PELVIS_DROP_M = 0.04
/** 骨盆下沉平滑时间常数（秒）。 */
const PELVIS_DROP_TAU_SEC = 0.12
/** IK 目标距离的腿长余量（米；让膝盖始终保留一点点弯曲）。 */
const REACH_MARGIN_M = 0.002

/**
 * A（旧，回退通道）：hips 水平平移上限（米；对目标向量做长度钳制、方向保持）。
 * 跨 idle 变体的作者站姿差 11–21cm（REPORT §3）；超出预算的部分仍由 IK 兜底。
 * 2026-11-11 v2 起只在 fallback / `stanceAlignMode='mean'` 时使用。
 */
const MAX_HIP_SHIFT_M = 0.18
/** A：hips 水平平移平滑时间常数（秒；比 pelvisDrop 慢 → 观感是重心缓慢转移）。 */
const STANCE_ALIGN_MEAN_TAU_SEC = 0.3
/** A：残差小于该值不做对齐（米；旧口径 5mm deadband，只在 mean 回退路径保留）。 */
const STANCE_ALIGN_MEAN_DEADBAND_M = 0.005

/**
 * g（默认，`stanceAlignMode='3d'`）：hips 3-DOF 偏移钳制与平滑。
 *
 * 离线实测（REPORT §12.3）：9 条 idle × 6s 需求上界 = 水平 0.088m（hsr-idleShow2）、
 * `dy ∈ [−0.020, 0]`，从未触发钳制 → 取 0.10m / [−0.03,+0.02]m 留 20–50% 余量。
 */
const MAX_HIP_SHIFT_HORIZ_M = 0.1
/** g：hips 垂直偏移下限（米；负 = 下沉；实测只下沉，最多 −2cm）。 */
const HIP_SHIFT_Y_MIN_M = -0.03
/** g：hips 垂直偏移上限（米；正 = 抬升，留给未来 clip）。 */
const HIP_SHIFT_Y_MAX_M = 0.02
/**
 * g：目标偏移 deadband（米）。**必须 ≤0.5mm**：实测必要校正最小约 1mm（REPORT §12.4），
 * 旧 A 口径 5mm 会吃掉它、让膝差回不去。
 */
const STANCE_ALIGN_DEADBAND_M = 0.0005
/** g：hips 3-DOF 偏移平滑时间常数（秒；与 REPORT §12.4 推荐一致，观感是重心缓慢转移）。 */
const STANCE_ALIGN_TAU_SEC = 0.2
/** g：求解/钳制后仍存在的最大距离残差（米）；超过 → 本帧回退旧 A + 原 pelvisDrop。 */
const STANCE_ALIGN_FALLBACK_RESIDUAL_M = 0.01
/** g：Gauss-Newton 迭代上限（3 未知量 2 约束；实测 16 内收敛，残差容差见下）。 */
const STANCE_SOLVE_MAX_ITER = 16
/** g：Gauss-Newton 提前退出残差容差（米）。 */
const STANCE_SOLVE_RESIDUAL_TOL = 1e-6
/** g：JᵀJ 的 ridge 系数（把解拉向最小范数族，近相切几何下保持数值稳定）。 */
const STANCE_SOLVE_RIDGE = 3e-4

/**
 * 转身/脚朝向释放：脚（目标动画）相对锚点朝向偏转超过该角度并持续一段时间 → 释放。
 * 用于表演型 idle（如 `hsr-idleShow*`）里作者画的转身/换脚：不硬拧脚踝。
 * B（脚朝向软跟随）后：普通变体 8.8°–31° 的脚 yaw 差先被软跟随吸收，硬释放只在
 * 「本帧跟随前」偏差 ≥ ~66° 时才会攒满 0.25s（安全网，不回归）。
 */
const ORIENTATION_RELEASE_RAD = (35 * Math.PI) / 180
const ORIENTATION_RELEASE_SEC = 0.25

/** B：脚朝向软跟随阈值（弧度；偏差小于该值保持刚性锚定，避免无谓抖动）。 */
const ORIENTATION_SOFT_FOLLOW_RAD = (9 * Math.PI) / 180
/** B：脚朝向软跟随时间常数（秒）。 */
const ORIENTATION_SOFT_FOLLOW_TAU_SEC = 0.4

/** 单帧 dt 上限（与 clip-player/B3 同口径）。 */
const MAX_DELTA_SEC = 0.1

/* ------------------------- replant（换姿势重锚）参数 ------------------------- */
/** 目标水平位移小于该值（米）→ 迷你混合，不抬脚（同站姿变体/数据微差）。 */
const REPLANT_MIN_MOVE_M = 0.012
/** 抬脚弧线高度 = clamp(0.15·d, min, max)（米）。 */
const REPLANT_LIFT_FACTOR = 0.15
/**
 * 抬脚下限 0.012m（设计初值 0.010；离线验收实测：0.010 时小步（d≈3.6cm）在 30fps 下
 * 起/落各有一帧水平移动落在 8mm 接地阈值内 → 接地滑移 8.7px@540，超过 6px 门禁；
 * 抬到 0.012 后 5.7px。视觉差异 2mm≈0.6px@540，可通过 option 回到 0.010 做 A/B）。
 */
const REPLANT_LIFT_MIN_M = 0.012
const REPLANT_LIFT_MAX_M = 0.03
/** 单脚水平速度上限（米/秒）；T = clamp(d/本值, minDuration, maxDuration)。 */
const REPLANT_MAX_SPEED_MPS = 0.45
const REPLANT_DURATION_MIN_SEC = 0.3
const REPLANT_DURATION_MAX_SEC = 0.45
/** 两脚换步间隔（秒）：后一脚在前一脚完成 + 本值后开始（同一时刻最多一只脚离地）。 */
const REPLANT_STEP_GAP_SEC = 0.08
/** 迷你混合时长（秒；不抬脚，smoothstep 平滑搬 pin，避免瞬移）。 */
const REPLANT_MINI_DURATION_SEC = 0.15
/**
 * 水平移动的领先/滞后比例：单脚换步的前/后各 12% 时长只做抬脚/落地、不水平移动，
 * 避免「脚还在地面就横移」；水平移动集中在中间 76% 时长（smoothstep 峰值 ≈1.64× 均值）。
 */
const REPLANT_HORIZONTAL_LEAD = 0.12
/** 全部脚落地后的「δ=0」保持时长（秒），之后才恢复常规 g 求解。 */
const REPLANT_SETTLE_SEC = 0.4
/**
 * settle 结束后投影（`projectStanceShift`）的渐入期（秒）：换步刚结束时约束流形仍在随
 * micro-motion 缓慢变化，立即做投影会把 τ 滞后一次性推回、造成单帧身体跳（实测 ~2.8cm）；
 * 该窗口内跳过投影，等 δ 已由常规 g 平滑收敛后再恢复。
 */
const REPLANT_PROJECTION_GRACE_SEC = 0.5
/**
 * replant 启用的 mood 白名单（v1 仅基础待机 `idle`）：表演型 idle 仍走作者抬脚/朝向释放；
 * dsh 静态/动态反应与一次性过场留待 P1 评估，避免在 breaked/revive 等动态片段重锚。
 */
const REPLANT_ALLOWED_MOODS: ReadonlySet<string> = new Set(['idle'])

/** `solveKneePosition` 在目标方向退化时使用的兜底方向（模块常量，只 copy 不修改）。 */
const FALLBACK_DIRECTION = new Vector3(0, -1, 0)
/** `solveKneePosition` 膝平面退化时使用的兜底轴（模块常量，只 copy 不修改）。 */
const FALLBACK_POLE_AXIS = new Vector3(0, 0, 1)

/* -------------------------------------------------------------------------- */
/* 类型                                                                        */
/* -------------------------------------------------------------------------- */

/** replant：构造 option 中由 `replantTuning` 单独承接的键（不放进 Required options）。 */
type ReplantOptionKey =
  | 'poseReplant'
  | 'replantMinMoveM'
  | 'replantLiftMinM'
  | 'replantLiftMaxM'
  | 'replantMaxSpeedMps'
  | 'replantMinDurationSec'
  | 'replantMaxDurationSec'
  | 'replantStepGapSec'

/** replant：可调参数（构造时一次性解析，默认值来自本文件常量）。 */
interface ReplantTuning {
  minMoveM: number
  liftMinM: number
  liftMaxM: number
  maxSpeedMps: number
  minDurationSec: number
  maxDurationSec: number
  stepGapSec: number
}

/**
 * replant：单脚换步轨迹（clip 切换后的 fade 结束帧创建一次；重踏中不重采样目标）。
 * 位置存标量（避免每帧 Vector3 解引用）；from/to 四元数为一次性分配（允许的换步期分配）。
 */
interface ReplantState {
  /** 本脚换步的实际开始时刻（秒，相对 replant 起点；含错峰等待）。 */
  delaySec: number
  durationSec: number
  elapsedSec: number
  /** 抬脚弧线峰值（米；迷你混合 = 0）。 */
  liftM: number
  /** 本帧抬脚弧线高度（米，调试/验收用）。 */
  liftNowM: number
  fromX: number
  fromY: number
  fromZ: number
  toX: number
  toY: number
  toZ: number
  fromQuat: Quaternion | null
  toQuat: Quaternion | null
  /** 轨迹进度 0–1（等待错峰时为 0；落地 = 1）。 */
  phase: number
  /** pin 到目标的水平残差（米；调试/验收用）。 */
  targetErrM: number
}

interface FootRig {
  upper: Object3D | null
  lower: Object3D | null
  foot: Object3D | null
  /** 构造时（rest）踝骨在 avatar.scene 局部坐标的 y（米；接触判定基准）。 */
  restFootLocalY: number | null
  /** rest 腿段长度（米；层级距离与旋转无关，构造时算一次即可）。 */
  upperLength: number
  lowerLength: number
  /** scene 局部空间的锚点位置（null = 未钉住）。 */
  pinPosition: Vector3 | null
  /** scene 局部空间的锚点朝向（null = 不锚定朝向）。 */
  pinQuaternion: Quaternion | null
  /** 当前接触权重（0–1）。 */
  weight: number
  /** 是否处于接触状态（含释放淡出期：pin 保留到 weight 归零）。 */
  contact: boolean
  /** 上一帧脚在 scene 局部的世界位置（水平速度估计用；null = 无历史）。 */
  previousLocal: Vector3 | null
  /** 最近一帧的踝锚点误差（米；调试/验收用）。 */
  lastErrorM: number | null
  /** 最近一帧的踝骨相对 rest 踝高的抬升（米；调试/验收用）。 */
  lastLiftM: number | null
  /**
   * 最近一帧 IK 后踝骨在 avatar.scene 局部坐标的 x/z（米；dev-capture 验收「各站姿=作者」用）。
   * null = 本帧未锁/未解算。仅调试快照消费，不影响求解。
   */
  lastFootX: number | null
  lastFootZ: number | null
  /** 上一帧的膝平面（世界空间极向量；近伸直时防膝盖翻转用；null = 无历史）。 */
  lastPole: Vector3 | null
  /** 目标动画脚朝向相对锚点的偏转持续时间（秒；转身/换脚释放用）。 */
  orientationOffSec: number
  /**
   * 最近一帧「跟随前」的脚朝向偏差（弧度；B 软跟随 + 调试快照用；null = 未测量）。
   * 硬释放判定仍用本帧跟随前的角度，避免被软跟随拖住而永远不释放。
   */
  lastOrientationErrRad: number | null
  /**
   * 最近一帧 IK 后的运行时膝屈曲角（度；180° = 完全伸直；null = 无数据）。
   * 髋-膝-踝三点夹角口径；调试验收（dev-capture JSON）用。
   */
  lastKneeFlexDeg: number | null
  /**
   * 本帧 IK 前（clip+micro 已写）作者姿态的膝屈曲角（度；null = 无数据）。
   * 与 `lastKneeFlexDeg` 对比可量化「运行时把腿弯了多少度」。
   */
  authorKneeFlexDeg: number | null
  /** replant：当前换步轨迹（null = 本脚没在换步）。 */
  replant: ReplantState | null
}

/**
 * g：单帧求解用的一条「pinned 腿距离约束」（预分配，零每帧分配）。
 *
 * 约束：`|hip + δ − pin| = d`，其中 d 是本帧 IK 前作者姿态的髋→踝距离。
 */
interface StanceConstraint {
  hx: number
  hy: number
  hz: number
  px: number
  py: number
  pz: number
  d: number
}

/* -------------------------------------------------------------------------- */
/* 纯函数（可单测）                                                             */
/* -------------------------------------------------------------------------- */

/**
 * 预分配 scratch（R-03）：给 `solveKneePosition` / 期望旋转纯函数复用临时 Vector3/Quaternion，
 * 消除每脚每帧 ~18–23 个临时对象。传 scratch 时函数**不会**再分配临时对象；
 * 返回的 `knee`/`quat` 是 scratch 内部对象，**只可立即消费，不可跨调用保留**。
 */
export interface FootLockScratch {
  /** `solveKneePosition` 的返回对象（每次调用覆写）。 */
  knee: Vector3
  /** 临时向量：目标方向/单位向量（`u`）。 */
  u: Vector3
  /** 临时向量：膝盖弯曲平面（极向量）。 */
  pole: Vector3
  /** 临时向量：poleHint 退化兜底。 */
  hint: Vector3
  /** 临时四元数：旋转增量（from→to）。 */
  delta: Quaternion
  /** 临时四元数：期望世界旋转输出（`computeUpper/LowerDesiredWorldQuat`）。 */
  quat: Quaternion
}

/** 创建一组 scratch（在 `VrmFootLock` 构造期一次性分配；之后每帧零分配）。 */
export function createFootLockScratch(): FootLockScratch {
  return {
    knee: new Vector3(),
    u: new Vector3(),
    pole: new Vector3(),
    hint: new Vector3(),
    delta: new Quaternion(),
    quat: new Quaternion()
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

/** 0–1 smoothstep（C1，无过冲）；输入先 clamp。 */
function smoothstep01(value: number): number {
  const x = clamp(value, 0, 1)
  return x * x * (3 - 2 * x)
}

function smoothingAlpha(dtSec: number, tauSec: number): number {
  if (!(dtSec > 0) || !(tauSec > 0)) return 0
  return 1 - Math.exp(-dtSec / tauSec)
}

/** 弧度 → 度（调试/验收字段用）。 */
const RAD_TO_DEG = 180 / Math.PI

/**
 * 髋-膝-踝三点夹角的膝**屈曲**角（度；180 = 完全伸直，越小越弯）。
 *
 * 与 REPORT / `tests/tmp/inv-leg2` 的测量口径一致（膝内角 = ∠(髋−膝, 踝−膝)，flex = 180 − 内角）。
 * 用两个 scratch 向量避免每帧分配；退化（点重合）返回 null。
 */
function kneeFlexDeg(
  hip: Vector3,
  knee: Vector3,
  ankle: Vector3,
  scratchA: Vector3,
  scratchB: Vector3
): number | null {
  scratchA.copy(hip).sub(knee)
  scratchB.copy(ankle).sub(knee)
  const lengthA = scratchA.lengthSq()
  const lengthB = scratchB.lengthSq()
  if (!(lengthA > 1e-12) || !(lengthB > 1e-12)) return null
  const interior = scratchA.angleTo(scratchB) * RAD_TO_DEG
  return 180 - interior
}

/** 由节点世界矩阵取世界四元数（必要时先刷新祖先矩阵）。 */
function getWorldQuat(node: Object3D, out: Quaternion): Quaternion {
  node.updateWorldMatrix(true, false)
  return node.getWorldQuaternion(out)
}

/** 把「期望的世界旋转」写成 normalized 骨的局部 quaternion。 */
function setLocalFromWorldQuat(node: Object3D, desiredWorld: Quaternion, tmp: Quaternion): void {
  if (node.parent === null) {
    node.quaternion.copy(desiredWorld)
    return
  }
  const parentWorld = node.parent.getWorldQuaternion(tmp)
  node.quaternion.copy(parentWorld.invert().multiply(desiredWorld))
}

/** 世界四元数/位置 → avatar.scene 局部空间。 */
function worldToSceneLocalQuat(
  scene: Object3D,
  world: Quaternion,
  tmpSceneQuat: Quaternion,
  out: Quaternion
): Quaternion {
  scene.getWorldQuaternion(tmpSceneQuat)
  return out.copy(tmpSceneQuat).invert().multiply(world)
}

function sceneLocalQuatToWorld(
  scene: Object3D,
  local: Quaternion,
  tmpSceneQuat: Quaternion,
  out: Quaternion
): Quaternion {
  scene.getWorldQuaternion(tmpSceneQuat)
  return out.copy(tmpSceneQuat).multiply(local)
}

/**
 * 解析两骨 IK：返回膝的世界位置。
 *
 * @param hip 大腿根世界位置
 * @param targetFoot 目标踝位置
 * @param currentKnee 当前膝位置（决定弯曲平面/极向量）
 * @param length1 大腿长度
 * @param length2 小腿长度
 * @param poleHint 近伸直（当前膝平面退化）时的兜底膝平面方向（世界空间；通常传上一帧极向量，
 *   避免膝盖在腿接近伸直时突然翻转）。
 */
export function solveKneePosition(
  hip: Vector3,
  targetFoot: Vector3,
  currentKnee: Vector3,
  length1: number,
  length2: number,
  poleHint?: Vector3,
  scratch?: FootLockScratch
): Vector3 {
  // R-03：传 scratch 时所有临时向量都复用（u/pole/hint/knee），不传时保持原分配路径。
  const u = scratch === undefined ? targetFoot.clone().sub(hip) : scratch.u.copy(targetFoot).sub(hip)
  const rawDistance = u.length()
  const minDistance = Math.abs(length1 - length2) + 1e-4
  // 2026-11-11 v2：硬钳制余量 1mm → 0.2mm。作者数据最伸直帧 d=881.4mm vs 腿长 881.535mm
  // （余量仅 0.135mm），旧 1mm 余量会把 hsr-idle/idle2 的腿额外压弯 −1.9°/−3.4°（REPORT §12.3-4）；
  // 0.2mm 解析残余仅 −0.4°。近伸直时极向量可能退化——below 的 poleHint/lastPole 兜底已覆盖。
  const maxDistance = Math.max(minDistance, length1 + length2 - 2e-4)
  const distance = clamp(rawDistance, minDistance, maxDistance)
  if (rawDistance > 1e-6) u.divideScalar(rawDistance)
  else u.copy(FALLBACK_DIRECTION)

  const pole = scratch === undefined ? currentKnee.clone().sub(hip) : scratch.pole.copy(currentKnee).sub(hip)
  // pole = (knee-hip) 去掉沿 u 分量（与旧实现 `sub(u.clone().multiplyScalar(dot))` 数值等价）。
  pole.addScaledVector(u, -pole.dot(u))
  if (pole.lengthSq() < 1e-6 && poleHint !== undefined && poleHint !== null) {
    // 腿接近伸直：当前 (knee-hip) 与目标方向几乎共线，极向量退化 → 沿用上一帧极向量。
    const hint = scratch === undefined ? poleHint.clone() : scratch.hint.copy(poleHint)
    hint.addScaledVector(u, -hint.dot(u))
    if (hint.lengthSq() > 1e-8) pole.copy(hint)
  }
  if (pole.lengthSq() < 1e-8) {
    pole.copy(FALLBACK_POLE_AXIS).addScaledVector(u, -FALLBACK_POLE_AXIS.dot(u))
    if (pole.lengthSq() < 1e-8) pole.set(0, 1, 0)
  }
  pole.normalize()

  const a = (length1 * length1 - length2 * length2 + distance * distance) / (2 * distance)
  const h = Math.sqrt(Math.max(0, length1 * length1 - a * a))
  const out = scratch === undefined ? hip.clone() : scratch.knee
  return out.copy(hip).add(u.multiplyScalar(a)).add(pole.multiplyScalar(h))
}

/**
 * 由两骨 IK 目标计算上段期望世界旋转（只旋转、不缩放；最小修改方向）。
 * 下肢的期望旋转在应用完上段后单独计算（见 `computeLowerDesiredWorldQuat`）。
 *
 * R-03：传 scratch 时 `from/to` 复用 scratch.u/pole、输出复用 scratch.quat（不分配）；
 * 不传时保持原分配路径。
 */
function computeUpperDesiredWorldQuat(
  hip: Vector3,
  currentKnee: Vector3,
  solvedKnee: Vector3,
  upperWorld: Quaternion,
  scratch?: FootLockScratch
): Quaternion {
  const out = scratch === undefined ? new Quaternion() : scratch.quat
  const from = scratch === undefined ? currentKnee.clone().sub(hip) : scratch.u.copy(currentKnee).sub(hip)
  const to = scratch === undefined ? solvedKnee.clone().sub(hip) : scratch.pole.copy(solvedKnee).sub(hip)
  if (from.lengthSq() < 1e-10 || to.lengthSq() < 1e-10) return out.copy(upperWorld)
  const delta = scratch === undefined ? new Quaternion() : scratch.delta
  delta.setFromUnitVectors(from.normalize(), to.normalize())
  return out.copy(delta).multiply(upperWorld)
}

/**
 * 小腿：把当前 (foot-knee) 方向旋到 (target-knee) 方向（R-03 scratch 口径同上）。
 */
function computeLowerDesiredWorldQuat(
  knee: Vector3,
  foot: Vector3,
  targetFoot: Vector3,
  lowerWorld: Quaternion,
  scratch?: FootLockScratch
): Quaternion {
  const out = scratch === undefined ? new Quaternion() : scratch.quat
  const from = scratch === undefined ? foot.clone().sub(knee) : scratch.u.copy(foot).sub(knee)
  const to = scratch === undefined ? targetFoot.clone().sub(knee) : scratch.pole.copy(targetFoot).sub(knee)
  if (from.lengthSq() < 1e-10 || to.lengthSq() < 1e-10) return out.copy(lowerWorld)
  const delta = scratch === undefined ? new Quaternion() : scratch.delta
  delta.setFromUnitVectors(from.normalize(), to.normalize())
  return out.copy(delta).multiply(lowerWorld)
}

/* -------------------------------------------------------------------------- */
/* 脚部固定器                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * 脚部固定器：每个 VRM 宠物一个实例；animator 在 clip-player.update 之后每帧调用 update()。
 */
export class VrmFootLock {
  private readonly avatar: VrmAvatar
  private readonly enabled: boolean
  private readonly options: Required<
    Omit<VrmFootLockOptions, 'stanceAlignMode' | ReplantOptionKey>
  > & {
    stanceAlignMode: '3d' | 'mean'
  }
  private readonly left: FootRig
  private readonly right: FootRig
  /** 预分配的两脚数组（每帧遍历零临时对象，R-03 口径）。 */
  private readonly rigs: readonly FootRig[]
  private readonly hips: Object3D | null
  /** 当前应用的骨盆下沉（米；平滑状态）。g 生效时恒为 0（δy 接管骨盆升降）。 */
  private pelvisDropM = 0
  /**
   * g / A：当前施加的 hips 偏移（米；g 为 x/y/z 三轴，A 回退时 y 恒 0）。非累积——每帧叠加在
   * clip-player（+micro-motion）刚写回的 normalized hips 基准值上，非静止时平滑归零。
   * `hipShiftXM/ZM` 语义与旧 A 一致（L2 pointer-rect 消费方不回归），`y` 为 v2 新增（调试）。
   */
  private readonly hipShift = new Vector3()
  /** g：本帧生效的对齐模式（'3d' = 距离保持解；'mean' = 旧 A 回退/强制回退）。 */
  private stanceMode: '3d' | 'mean' = '3d'
  /** g：上一帧求解目标（warm start；平滑前、钳制后；零每帧分配）。 */
  private readonly stanceWarmStart = new Vector3()
  /** g：当前帧求解输出（预分配）。 */
  private readonly stanceTarget = new Vector3()
  /** g：预分配的约束数组（最多两脚；每帧只改字段、不分配）。 */
  private readonly stanceConstraints: StanceConstraint[] = [
    { hx: 0, hy: 0, hz: 0, px: 0, py: 0, pz: 0, d: 0 },
    { hx: 0, hy: 0, hz: 0, px: 0, py: 0, pz: 0, d: 0 }
  ]
  /** g：最近一帧钳制后的距离残差（米；无 pinned 脚 = null；调试/验收用）。 */
  private lastStanceResidualM: number | null = null
  /** g：最近一帧 GN 迭代数（性能/调参用，不进快照）。 */
  private lastStanceIterations = 0
  private disposed = false

  /* ------------------------- replant（换姿势重锚）状态 ------------------------- */
  /** 是否启用换步重锚（`poseReplant !== false` 且 `stanceAlignMode !== 'mean'`）。 */
  private readonly replantEnabled: boolean
  /** replant 参数（构造时解析）。 */
  private readonly replantTuning: ReplantTuning
  /** 最近一帧见到的 clipId（跨 clip 变化检测；ineligible 帧也更新）。 */
  private lastClipId: string | null = null
  /** 已检测到 clip 变化，等待 crossfade 结束再取新作者站姿（期间接触状态冻结）。 */
  private pendingReplant = false
  /** replant 换步期：g 让位（目标按进度平滑衰减到 0），落地后 settle，再恢复常规解。 */
  private replantAlignActive = false
  /** 全体换步进度 0–1（按已开始脚的平均 phase；用于 g 衰减）。 */
  private replantAlignProgress = 0
  /** 全部脚落地后的 δ=0 保持期。 */
  private replantSettleActive = false
  private replantSettleElapsed = 0
  /** 本帧是否还有脚在换步/等待错峰（settle 判定用）。 */
  private replantStepActive = false
  /** settle 结束后跳过约束投影的剩余时间（秒；见 REPLANT_PROJECTION_GRACE_SEC）。 */
  private projectionGraceSec = 0
  /** 记录换步开始时的 hipShift（g 目标从这里衰减到 0）。 */
  private readonly replantAlignFrom = new Vector3()
  /** 两脚各自换步进度（0–1；未开始 0、完成 1）。 */
  private readonly replantPhase: [number, number] = [0, 0]
  /** 该脚本轮是否参与了换步（平均进度只统计参与的脚）。 */
  private readonly replantStarted: [boolean, boolean] = [false, false]

  private readonly tmpA = new Vector3()
  private readonly tmpB = new Vector3()
  private readonly tmpC = new Vector3()
  private readonly tmpD = new Vector3()
  private readonly tmpE = new Vector3()
  private readonly tmpQuatA = new Quaternion()
  private readonly tmpQuatB = new Quaternion()
  private readonly tmpQuatC = new Quaternion()
  private readonly tmpMatA = new Matrix4()
  /**
   * R-03：IK 纯函数的预分配 scratch（构造期一次分配，之后每帧零临时对象）。
   *
   * 为什么不直接复用上面的 tmpA..E：`solveFoot` 执行 IK 时 tmpA(hip)/tmpB(targetWorld)/
   * tmpC(currentKnee) 都在被占用，纯函数内部还需要 4 个独立临时向量 + 2 个四元数，
   * 直接别名会互相覆写、改变数学结果；scratch 独立一组最稳妥（只占 6 个小对象）。
   */
  private readonly ikScratch = createFootLockScratch()

  constructor(avatar: VrmAvatar, options: VrmFootLockOptions = {}) {
    this.avatar = avatar
    this.enabled = options.enabled !== false
    this.options = {
      enabled: this.enabled,
      contactEnterLiftM: options.contactEnterLiftM ?? CONTACT_ENTER_LIFT_M,
      contactExitLiftM: options.contactExitLiftM ?? CONTACT_EXIT_LIFT_M,
      contactEnterSpeedMps: options.contactEnterSpeedMps ?? CONTACT_ENTER_SPEED_MPS,
      contactHoldSpeedMps: options.contactHoldSpeedMps ?? CONTACT_HOLD_SPEED_MPS,
      weightTauInSec: options.weightTauInSec ?? WEIGHT_TAU_IN_SEC,
      weightTauOutSec: options.weightTauOutSec ?? WEIGHT_TAU_OUT_SEC,
      maxPelvisDropM: options.maxPelvisDropM ?? MAX_PELVIS_DROP_M,
      pelvisDropTauSec: options.pelvisDropTauSec ?? PELVIS_DROP_TAU_SEC,
      anchorOrientation: options.anchorOrientation !== false,
      // g：默认 '3d'（距离保持解）；'mean' = 一键回滚旧 A 行为（真机 A/B / 回滚通道）。
      stanceAlignMode: options.stanceAlignMode === 'mean' ? 'mean' : '3d'
    }
    this.stanceMode = this.options.stanceAlignMode

    // replant：`stanceAlignMode:'mean'` 时自动关闭（旧 A 回滚通道保持纯旧行为）。
    this.replantEnabled =
      options.poseReplant !== false && this.options.stanceAlignMode !== 'mean'
    const minDurationSec = Math.max(
      0.05,
      options.replantMinDurationSec ?? REPLANT_DURATION_MIN_SEC
    )
    this.replantTuning = {
      minMoveM: clamp(options.replantMinMoveM ?? REPLANT_MIN_MOVE_M, 0, 0.2),
      liftMinM: clamp(options.replantLiftMinM ?? REPLANT_LIFT_MIN_M, 0, 0.1),
      liftMaxM: clamp(options.replantLiftMaxM ?? REPLANT_LIFT_MAX_M, 0, 0.1),
      maxSpeedMps: Math.max(0.05, options.replantMaxSpeedMps ?? REPLANT_MAX_SPEED_MPS),
      minDurationSec,
      maxDurationSec: Math.max(
        minDurationSec,
        options.replantMaxDurationSec ?? REPLANT_DURATION_MAX_SEC
      ),
      stepGapSec: Math.max(0, options.replantStepGapSec ?? REPLANT_STEP_GAP_SEC)
    }

    const humanoid = avatar.vrm.humanoid
    const get = (name: HumanoidBone): Object3D | null =>
      humanoid !== undefined && typeof humanoid.getNormalizedBoneNode === 'function'
        ? (humanoid.getNormalizedBoneNode(name) ?? null)
        : null

    this.hips = get('hips')
    this.left = this.createRig(get, 'left')
    this.right = this.createRig(get, 'right')
    this.rigs = [this.left, this.right]
  }

  /** 构造单个脚 rig：读 rest 踝高 + 腿段长度（rotation-invariant）。 */
  private createRig(
    get: (name: HumanoidBone) => Object3D | null,
    side: 'left' | 'right'
  ): FootRig {
    const upper = get(side === 'left' ? 'leftUpperLeg' : 'rightUpperLeg')
    const lower = get(side === 'left' ? 'leftLowerLeg' : 'rightLowerLeg')
    const foot = get(side === 'left' ? 'leftFoot' : 'rightFoot')
    const rig: FootRig = {
      upper,
      lower,
      foot,
      restFootLocalY: null,
      upperLength: 0,
      lowerLength: 0,
      pinPosition: null,
      pinQuaternion: null,
      weight: 0,
      contact: false,
      previousLocal: null,
      lastErrorM: null,
      lastLiftM: null,
      lastFootX: null,
      lastFootZ: null,
      lastPole: null,
      orientationOffSec: 0,
      lastOrientationErrRad: null,
      lastKneeFlexDeg: null,
      authorKneeFlexDeg: null,
      replant: null
    }
    if (upper === null || lower === null || foot === null) return rig

    const scene = this.avatar.scene
    if (scene === null || scene === undefined) return rig
    try {
      scene.updateMatrixWorld(true)
      const sceneInverse = this.tmpMatA.copy(scene.matrixWorld).invert()

      upper.updateWorldMatrix(true, false)
      lower.updateWorldMatrix(true, false)
      foot.updateWorldMatrix(true, false)
      const upperWorld = upper.getWorldPosition(new Vector3())
      const lowerWorld = lower.getWorldPosition(new Vector3())
      const footWorld = foot.getWorldPosition(new Vector3())
      rig.upperLength = upperWorld.distanceTo(lowerWorld)
      rig.lowerLength = lowerWorld.distanceTo(footWorld)
      if (!(rig.upperLength > 0) || !(rig.lowerLength > 0)) {
        rig.upperLength = 0
        rig.lowerLength = 0
      }
      const footLocal = footWorld.clone().applyMatrix4(sceneInverse)
      if (Number.isFinite(footLocal.y)) {
        rig.restFootLocalY = footLocal.y
      } else {
        // 兜底：rest 踝高 ≈ 身高的 5.7%（本模型 9.83cm / 1.734m）；只在构造时姿态异常时用。
        rig.restFootLocalY = this.avatar.restHeightMeters * 0.057
      }
    } catch {
      // 构造期测量失败：回退到身高比例，保证接触判定有可用基准而不是永远 false。
      rig.restFootLocalY = this.avatar.restHeightMeters * 0.057
    }
    return rig
  }

  /**
   * 每帧调用：clip 姿态已应用（normalized 骨 + hips）之后、`humanoid.update()` 之前。
   *
   * @param context.transitioning clip 播放器正在 crossfade（`snapshot.fading`）：此时混合姿态的脚
   *   「速度」是两条 clip 站姿插值的合成速度、不是作者画的抬脚（rabfulton/VRM 的经验：
   *   接触分类要用未混合的目标动画，或至少在 transition 期间冻结接触状态机）。冻结后，
   *   idle 变体 0.8–1.0s crossfade 期间不会因合成速度误释放锚点。
   * @param context.allow 是否允许参与（animator 用「当前 clip 槽位 == 当前 mood」判定：一次性事件
   *   clip / 手动 clip（`slot='manual'`，如 intro、DSH 工作小动作、error 过场）不锁，避免误锁表演）。
   * @param context.clipId 当前主 clip id（replant 变化检测用；null = 未播放/未就绪）。不传时本模块
   *   保持旧行为（跨 clip 保持锚点），作为兼容/回滚通道。
   */
  update(
    input: AnimationInput,
    context?: { transitioning?: boolean; allow?: boolean; clipId?: string | null }
  ): void {
    if (!this.enabled || this.disposed) return
    if (input === null || typeof input !== 'object') return
    const scene = this.avatar.scene
    if (scene === null || scene === undefined) return
    if (typeof scene.updateMatrixWorld !== 'function') return
    if (
      this.left.upper === null &&
      this.right.upper === null
    ) {
      return
    }

    const dt = clamp(Number.isFinite(input.dt) ? input.dt : 0, 0, MAX_DELTA_SEC)
    const eligible =
      context?.allow !== false &&
      input.motion.grounded === true &&
      input.dragging !== true &&
      !FOOT_LOCK_DISABLED_MOODS.has(input.mood) &&
      this.avatar.vrm.humanoid !== undefined

    // 世界矩阵按 clip-player 本帧写入后的状态刷新一次。
    scene.updateMatrixWorld(true)
    // v2：记录本帧 IK 前（clip+micro 已写）作者膝角，供快照/实机验收对比（IK 后回填运行时膝角）。
    this.measureAuthorKneeFlex()

    // ---- 0) replant：clip 变化检测（lastClipId 每帧更新，含 ineligible 帧） ----
    // 只在 eligible 的基础 idle 上触发；一次性/manual clip（allow=false）与 walk/sit/drag 等不触发。
    const clipId = context?.clipId ?? null
    if (clipId !== null) {
      if (
        this.replantEnabled &&
        eligible &&
        REPLANT_ALLOWED_MOODS.has(input.mood) &&
        this.lastClipId !== null &&
        clipId !== this.lastClipId
      ) {
        // R3：上一轮换步未完成又换姿势：立即结束当前 replant（落地版 finish 会让空中脚先落地、
        // 不悬空），再标记 pending，等新 fade 结束后从地面重新规划。
        this.finishReplantNow()
        this.pendingReplant = true
      }
      this.lastClipId = clipId
    }

    if (!eligible) {
      // 进入移动/拖拽/坐/睡/悬空/pat：立即结束换步（脚停在当前插值位），并走原有释放路径。
      this.pendingReplant = false
      this.finishReplantNow()
      this.projectionGraceSec = 0
      // 不立刻清 pin，而是让 IK 权重按 tauOut 平滑淡出
      // （否则脚会从锚点瞬间弹回 clip 位——待机→走路/拖拽起手时会看到跳变）。
      this.beginTransitionRelease(this.left)
      this.beginTransitionRelease(this.right)
      // g：contact 已清 → 对齐目标 = 0，按同 τ 平滑归零（离开 idle 不残留身体侧移/升降）。
      this.applyStanceAlign(scene, dt)
      this.applyPelvisDrop(0, dt)
      this.solveFoot(this.left, scene, dt)
      this.solveFoot(this.right, scene, dt)
      this.fillUnmeasuredKneeFlex()
      return
    }

    // ---- 1) 每只脚：测抬升/水平速度 → 接触状态机 ----
    // crossfade / replant pending / 换步期间冻结状态（脚本抬脚不能被自家阈值判成作者抬脚）。
    const freezeBase = context?.transitioning === true
    const freezeLeft =
      freezeBase || ((this.pendingReplant || this.left.replant !== null) && this.left.contact)
    const freezeRight =
      freezeBase || ((this.pendingReplant || this.right.replant !== null) && this.right.contact)
    this.updateContact(this.left, scene, dt, freezeLeft)
    this.updateContact(this.right, scene, dt, freezeRight)

    // ---- 1.1) fade 已结束：一次性采样新 clip 作者站姿并开始换步 ----
    if (this.pendingReplant && context?.transitioning !== true) {
      this.pendingReplant = false
      this.startReplant(scene)
    }
    // 推进换步轨迹（改 pinPosition/pinQuaternion；之后 g/IK 都基于移动中的锚点）。
    this.advanceReplant(dt)

    if (this.projectionGraceSec > 0) {
      this.projectionGraceSec = Math.max(0, this.projectionGraceSec - dt)
    }
    // ---- 1.5) g：锚点-作者姿态对齐（replant 期间让位，见 applyStanceAlign） ----
    const stanceMode = this.applyStanceAlign(scene, dt)
    // 换步结束后的 settle：保持 δ=0 一段 REPLANT_SETTLE_SEC，再恢复常规 g 求解。
    this.updateReplantSettle(dt)

    // ---- 2) 目标可达性：g 生效时 targetDrop=0（δy 接管）；回退旧 A 时保持原 pelvisDrop 语义 ----
    let targetDrop = 0
    for (const rig of this.rigs) {
      if (rig.pinPosition === null) continue
      // pin 保留到释放淡出结束（weight 归零）；刚接触、weight 还为 0 时不能清。
      if (!rig.contact && rig.weight <= RELEASE_WEIGHT_EPSILON) {
        rig.pinPosition = null
        rig.pinQuaternion = null
        rig.lastOrientationErrRad = null
        continue
      }
      const reach = rig.upperLength + rig.lowerLength
      if (!(reach > 0)) continue
      const hip = this.worldPositionOf(rig.upper, this.tmpA)
      const targetWorld = scene.localToWorld(this.tmpB.copy(rig.pinPosition))
      const required = hip.distanceTo(targetWorld)
      const needed = required - (reach - REACH_MARGIN_M)
      if (needed > this.options.maxPelvisDropM + 1e-4) {
        // 目标超出「腿长 + 允许下沉」→ 释放，跟随动画（不硬拽腿）。
        this.releaseContact(rig)
        continue
      }
      // g 生效：δy 就是骨盆升降，不再额外下沉（保留上面的 release 兜底）。
      if (stanceMode === 'mean' && needed > targetDrop) targetDrop = needed
    }
    targetDrop = clamp(targetDrop, 0, this.options.maxPelvisDropM)
    this.applyPelvisDrop(targetDrop, dt)

    // ---- 4) 逐腿 IK：把接触脚拉回锚点 + 保持锚定朝向 ----
    this.solveFoot(this.left, scene, dt)
    this.solveFoot(this.right, scene, dt)
    this.fillUnmeasuredKneeFlex()
  }

  /**
   * g：锚点-作者姿态对齐（2026-11-11 v2）——把旧 A 的「均值水平平移」升级为
   * **3-DOF 骨盆距离保持解**（详见文件头）。
   *
   * 目标：两骨腿的膝屈曲角由 `|髋−踝目标|` 距离唯一决定；让每条 pinned 腿的
   * `|hip+δ−pin|` 等于作者本帧距离 `d`，IK 解出的膝角就等于作者，同时脚零滑移。
   * - 每帧基于 clip-player（+micro-motion）刚写回的姿势重新计算 → **不累积**（下一帧被重写）；
   * - 只写 `normalized hips.position`（x/y/z；不写 `avatar.scene`/root）；
   * - 钳制 `|δxz|≤0.10m`、`δy∈[−0.03,+0.02]m`、deadband 0.5mm、τ=0.2s；
   * - 0 脚 pinned → 目标 0 平滑归零；NaN/钳制后残差 >10mm → 本帧回退旧 A + 原 pelvisDrop；
   *   强制回退通道：构造 option `stanceAlignMode:'mean'`。
   *
   * @returns 本帧生效的对齐模式（'3d' = g；'mean' = 旧 A 回退/强制）
   */
  private applyStanceAlign(scene: Object3D, dtSec: number): '3d' | 'mean' {
    if (this.hips === null) {
      this.hipShift.set(0, 0, 0)
      this.lastStanceResidualM = null
      this.stanceMode = this.options.stanceAlignMode
      return this.stanceMode
    }

    // ---- 1) 收集 pinned 腿约束（本帧 IK 前作者姿态）+ 旧 A 的均值残差 ----
    let count = 0
    let meanResidualX = 0
    let meanResidualZ = 0
    for (const rig of this.rigs) {
      if (!rig.contact || rig.pinPosition === null || rig.upper === null || rig.foot === null) continue
      const hip = this.worldPositionOf(rig.upper, this.tmpA)
      scene.worldToLocal(hip)
      const ankle = this.worldPositionOf(rig.foot, this.tmpB)
      scene.worldToLocal(ankle)
      const constraint = this.stanceConstraints[count]
      constraint.hx = hip.x
      constraint.hy = hip.y
      constraint.hz = hip.z
      constraint.px = rig.pinPosition.x
      constraint.py = rig.pinPosition.y
      constraint.pz = rig.pinPosition.z
      constraint.d = Math.hypot(hip.x - ankle.x, hip.y - ankle.y, hip.z - ankle.z)
      // 防御：异常资源/骨骼矩阵可能给出 NaN；跳过该脚（本帧其约束不参与，不把 NaN 传进求解/hips）。
      if (
        !Number.isFinite(constraint.hx + constraint.hy + constraint.hz) ||
        !Number.isFinite(constraint.px + constraint.py + constraint.pz) ||
        !Number.isFinite(constraint.d)
      ) {
        continue
      }
      meanResidualX += rig.pinPosition.x - ankle.x
      meanResidualZ += rig.pinPosition.z - ankle.z
      count += 1
    }
    // 旧 A 目标（fallback / 'mean' 回滚通道；口径与 v1 完全一致：≤0.18m、5mm deadband）
    let meanX = 0
    let meanZ = 0
    if (count > 0) {
      meanX = meanResidualX / count
      meanZ = meanResidualZ / count
      const meanLength = Math.hypot(meanX, meanZ)
      if (meanLength > MAX_HIP_SHIFT_M) {
        const scale = MAX_HIP_SHIFT_M / meanLength
        meanX *= scale
        meanZ *= scale
      } else if (meanLength < STANCE_ALIGN_MEAN_DEADBAND_M) {
        meanX = 0
        meanZ = 0
      }
    }

    // ---- 2) g：解 3-DOF 偏移（钳制 → deadband → 残差评估 → 必要时回退） ----
    // replant 期间 g 让位：目标 = 换步开始时的 hipShift 按全体进度 smoothstep 衰减到 0
    // （settle 期进度=1 → 目标 0）；不做常规解/fallback（pin 在动，回退会把 δ 推回旧流形）。
    let useMean = this.options.stanceAlignMode === 'mean'
    const replantOverride = this.replantAlignActive
    let targetX = 0
    let targetY = 0
    let targetZ = 0
    let residual = 0
    if (replantOverride) {
      if (count > 0) {
        const decay = 1 - smoothstep01(this.replantAlignProgress)
        targetX = this.replantAlignFrom.x * decay
        targetY = clamp(this.replantAlignFrom.y * decay, HIP_SHIFT_Y_MIN_M, HIP_SHIFT_Y_MAX_M)
        targetZ = this.replantAlignFrom.z * decay
        const horizontalLength = Math.hypot(targetX, targetZ)
        if (horizontalLength > MAX_HIP_SHIFT_HORIZ_M) {
          const scale = MAX_HIP_SHIFT_HORIZ_M / horizontalLength
          targetX *= scale
          targetZ *= scale
        }
        residual = this.computeStanceResidual(count, targetX, targetY, targetZ)
      }
      useMean = false
      this.lastStanceIterations = 0
    } else if (!useMean && count > 0) {
      this.solveStanceTarget(count)
      targetX = this.stanceTarget.x
      targetY = clamp(this.stanceTarget.y, HIP_SHIFT_Y_MIN_M, HIP_SHIFT_Y_MAX_M)
      targetZ = this.stanceTarget.z
      const horizontalLength = Math.hypot(targetX, targetZ)
      if (horizontalLength > MAX_HIP_SHIFT_HORIZ_M) {
        const scale = MAX_HIP_SHIFT_HORIZ_M / horizontalLength
        targetX *= scale
        targetZ *= scale
      }
      if (Math.hypot(targetX, targetY, targetZ) < STANCE_ALIGN_DEADBAND_M) {
        targetX = 0
        targetY = 0
        targetZ = 0
      }
      residual = this.computeStanceResidual(count, targetX, targetY, targetZ)
      if (!Number.isFinite(residual) || residual > STANCE_ALIGN_FALLBACK_RESIDUAL_M) {
        // 不可达/数值异常：本帧回退旧 A（保留旧 pelvisDrop 路径），不产生越界位移。
        useMean = true
      }
    }
    if (useMean) {
      targetX = meanX
      targetY = 0
      targetZ = meanZ
      residual = count > 0 ? this.computeStanceResidual(count, targetX, targetY, targetZ) : 0
    }
    // 防御：任何非有限目标（含 fallback 均值里的 NaN）→ 本帧目标 0，绝不写 NaN 到 hips。
    if (!Number.isFinite(targetX) || !Number.isFinite(targetY) || !Number.isFinite(targetZ)) {
      targetX = 0
      targetY = 0
      targetZ = 0
      residual = 0
    }
    this.stanceMode = useMean ? 'mean' : '3d'
    this.lastStanceResidualM = count > 0 && Number.isFinite(residual) ? residual : null
    if (!useMean && !replantOverride && Number.isFinite(targetX + targetY + targetZ)) {
      this.stanceWarmStart.set(targetX, targetY, targetZ)
    }

    // ---- 3) 平滑（非累积）：叠加在 clip+micro 刚写回的 hips 基准值上 ----
    const tau = useMean ? STANCE_ALIGN_MEAN_TAU_SEC : STANCE_ALIGN_TAU_SEC
    const alpha = smoothingAlpha(dtSec, tau)
    if (alpha > 0) {
      this.hipShift.x += (targetX - this.hipShift.x) * alpha
      this.hipShift.y += (targetY - this.hipShift.y) * alpha
      this.hipShift.z += (targetZ - this.hipShift.z) * alpha
    }
    // 3d 生效时：把平滑值投影回距离约束流形，消掉 τ 滞后在近伸直腿上的逐帧膝尖峰。
    // replant/settle 期间跳过（pin 在移动，约束本身在变，投影会把平滑后的 δ 猛推回旧流形）；
    // settle 后的 projection grace 窗口内也跳过（避免 τ 滞后被一次性投影成单帧身体跳）。
    if (!useMean && !replantOverride && this.projectionGraceSec <= 0 && count > 0 && alpha > 0) {
      this.projectStanceShift(count)
      // 投影后再做一次钳制（投影量 mm 级，正常不会越界；保证异常输入下仍有界）。
      this.hipShift.y = clamp(this.hipShift.y, HIP_SHIFT_Y_MIN_M, HIP_SHIFT_Y_MAX_M)
      const projectedHoriz = Math.hypot(this.hipShift.x, this.hipShift.z)
      if (projectedHoriz > MAX_HIP_SHIFT_HORIZ_M) {
        const scale = MAX_HIP_SHIFT_HORIZ_M / projectedHoriz
        this.hipShift.x *= scale
        this.hipShift.z *= scale
      }
    }
    if (
      !Number.isFinite(this.hipShift.x) ||
      !Number.isFinite(this.hipShift.y) ||
      !Number.isFinite(this.hipShift.z)
    ) {
      this.hipShift.set(0, 0, 0)
    }
    if (Math.abs(this.hipShift.x) < 1e-4) this.hipShift.x = 0
    if (Math.abs(this.hipShift.y) < 1e-4) this.hipShift.y = 0
    if (Math.abs(this.hipShift.z) < 1e-4) this.hipShift.z = 0
    if (this.hipShift.x !== 0 || this.hipShift.y !== 0 || this.hipShift.z !== 0) {
      this.hips.position.x += this.hipShift.x
      this.hips.position.y += this.hipShift.y
      this.hips.position.z += this.hipShift.z
      this.hips.updateMatrixWorld(true)
    }
    return this.stanceMode
  }

  /**
   * g：解 3-DOF hips 偏移，写 `this.stanceTarget`（未钳制）与 `this.lastStanceIterations`。
   *
   * - 2 脚：Gauss-Newton（JᵀJ+λI，λ=3e-4；warm start 上一帧目标；≤16 iter；残差 <1e-6 提前退出）。
   *   2 约束 3 未知量 → 1 参数族，ridge 项把解拉在 warm start 附近的最小范数解。
   * - 1 脚：解析最小范数解 `δ = (d/|hip−pin| − 1)·(hip−pin)`。
   * - 0 脚：0。
   *
   * 零每帧分配：只用预分配 `stanceConstraints`/`stanceTarget`/`stanceWarmStart` 与标量。
   */
  private solveStanceTarget(count: number): void {
    const out = this.stanceTarget
    this.lastStanceIterations = 0
    if (count <= 0) {
      out.set(0, 0, 0)
      return
    }
    if (count === 1) {
      const c = this.stanceConstraints[0]
      const vx = c.hx - c.px
      const vy = c.hy - c.py
      const vz = c.hz - c.pz
      const distance = Math.sqrt(vx * vx + vy * vy + vz * vz)
      if (!(distance > 1e-9)) {
        out.set(0, 0, 0)
      } else {
        const scale = c.d / distance - 1
        out.set(vx * scale, vy * scale, vz * scale)
      }
      return
    }
    // 2 脚：Gauss-Newton（内联标量，避免每帧临时对象）。
    // 从 0 出发（不用上一帧 warm start）：两脚 2 约束在双腿近伸直时接近相切，解是一条
    // 近似圆的一维流形；带 warm start 会沿着流形被 micro-motion 逐帧推着漂移（实测
    // 稳态 hipShift 从 0 漂到 6.5cm，导致「站立/起步时身体侧向漂移」）。从 0 出发的 GN
    // 收敛到靠近最小范数的解，逐帧稳定。
    out.set(0, 0, 0)
    let iterations = 0
    for (let iter = 0; iter < STANCE_SOLVE_MAX_ITER; iter += 1) {
      iterations = iter + 1
      let a00 = 0
      let a01 = 0
      let a02 = 0
      let a11 = 0
      let a12 = 0
      let a22 = 0
      let b0 = 0
      let b1 = 0
      let b2 = 0
      let worst = 0
      for (let index = 0; index < count; index += 1) {
        const c = this.stanceConstraints[index]
        const vx = c.hx + out.x - c.px
        const vy = c.hy + out.y - c.py
        const vz = c.hz + out.z - c.pz
        const length = Math.sqrt(vx * vx + vy * vy + vz * vz) || 1e-9
        const r = length - c.d
        const absR = Math.abs(r)
        if (absR > worst) worst = absR
        const jx = vx / length
        const jy = vy / length
        const jz = vz / length
        a00 += jx * jx
        a01 += jx * jy
        a02 += jx * jz
        a11 += jy * jy
        a12 += jy * jz
        a22 += jz * jz
        b0 += jx * r
        b1 += jy * r
        b2 += jz * r
      }
      if (worst < STANCE_SOLVE_RESIDUAL_TOL) break
      const lambda = STANCE_SOLVE_RIDGE
      a00 += lambda
      a11 += lambda
      a22 += lambda
      // 解 (JᵀJ+λI)·step = −Jᵀr：λ 只阻尼步长（标准 Levenberg），**不**把解拉向原点——
      // 若把 λ·out 放进右端（旧原型写法），大位移 + 近相切几何下会停在
      // 「残差 ±0.7mm 互相抵消、Jᵀr 与 λ·out 精确抵消」的伪驻点（离线复现过），解不再收敛。
      const c0 = b0
      const c1 = b1
      const c2 = b2
      const det =
        a00 * (a11 * a22 - a12 * a12) -
        a01 * (a01 * a22 - a12 * a02) +
        a02 * (a01 * a12 - a11 * a02)
      if (!(Math.abs(det) > 1e-18)) break
      const inv00 = (a11 * a22 - a12 * a12) / det
      const inv01 = (a02 * a12 - a01 * a22) / det
      const inv02 = (a01 * a12 - a02 * a11) / det
      const inv11 = (a00 * a22 - a02 * a02) / det
      const inv12 = (a02 * a01 - a00 * a12) / det
      const inv22 = (a00 * a11 - a01 * a01) / det
      out.x += -(inv00 * c0 + inv01 * c1 + inv02 * c2)
      out.y += -(inv01 * c0 + inv11 * c1 + inv12 * c2)
      out.z += -(inv02 * c0 + inv12 * c1 + inv22 * c2)
      if (!(Number.isFinite(out.x) && Number.isFinite(out.y) && Number.isFinite(out.z))) {
        break
      }
    }
    this.lastStanceIterations = iterations
    if (!(Number.isFinite(out.x) && Number.isFinite(out.y) && Number.isFinite(out.z))) {
      out.set(0, 0, 0)
    }
  }

  /**
   * g：把「已平滑的 hipShift」投影回距离约束流形（近 1–3 次 GN；零分配）。
   *
   * 为什么需要：τ 平滑对**移动中的作者姿态/骨盆**有 τ 量级的滞后（1–3mm）；本模型腿接近伸直，
   * 逐帧距离误差 1mm 在膝角上会放大成 2–5°（sqrt 敏感区，REPORT §12.3-3）。目标解本身是精确的，
   * 滞后只发生在平滑后的实际写入值上，因此写入前把平滑值投影回约束流形（等价于「平滑后的最近
   * 可行解」）——脚位/膝角逐帧回到作者值，身体轨迹仍是平滑的（投影是连续映射）。
   *
   * 只投影已平滑值、不改 warm start（warm start 仍用目标解，保证下一帧求解精度）。
   */
  private projectStanceShift(count: number): void {
    if (count <= 0) return
    const shift = this.hipShift
    if (count === 1) {
      const c = this.stanceConstraints[0]
      const vx = c.hx + shift.x - c.px
      const vy = c.hy + shift.y - c.py
      const vz = c.hz + shift.z - c.pz
      const distance = Math.sqrt(vx * vx + vy * vy + vz * vz)
      if (!(distance > 1e-9)) return
      const scale = c.d / distance - 1
      shift.x += vx * scale
      shift.y += vy * scale
      shift.z += vz * scale
      return
    }
    // 2 脚：从已平滑值出发做 GN（最多 4 iter；线性收敛足够，残差 <1e-6 提前退出）。
    for (let iter = 0; iter < 4; iter += 1) {
      let a00 = 0
      let a01 = 0
      let a02 = 0
      let a11 = 0
      let a12 = 0
      let a22 = 0
      let b0 = 0
      let b1 = 0
      let b2 = 0
      let worst = 0
      for (let index = 0; index < count; index += 1) {
        const c = this.stanceConstraints[index]
        const vx = c.hx + shift.x - c.px
        const vy = c.hy + shift.y - c.py
        const vz = c.hz + shift.z - c.pz
        const length = Math.sqrt(vx * vx + vy * vy + vz * vz) || 1e-9
        const r = length - c.d
        const absR = Math.abs(r)
        if (absR > worst) worst = absR
        const jx = vx / length
        const jy = vy / length
        const jz = vz / length
        a00 += jx * jx
        a01 += jx * jy
        a02 += jx * jz
        a11 += jy * jy
        a12 += jy * jz
        a22 += jz * jz
        b0 += jx * r
        b1 += jy * r
        b2 += jz * r
      }
      if (worst < 1e-6) return
      const lambda = STANCE_SOLVE_RIDGE
      a00 += lambda
      a11 += lambda
      a22 += lambda
      const det =
        a00 * (a11 * a22 - a12 * a12) -
        a01 * (a01 * a22 - a12 * a02) +
        a02 * (a01 * a12 - a11 * a02)
      if (!(Math.abs(det) > 1e-18)) return
      const inv00 = (a11 * a22 - a12 * a12) / det
      const inv01 = (a02 * a12 - a01 * a22) / det
      const inv02 = (a01 * a12 - a02 * a11) / det
      const inv11 = (a00 * a22 - a02 * a02) / det
      const inv12 = (a02 * a01 - a00 * a12) / det
      const inv22 = (a00 * a11 - a01 * a01) / det
      shift.x += -(inv00 * b0 + inv01 * b1 + inv02 * b2)
      shift.y += -(inv01 * b0 + inv11 * b1 + inv12 * b2)
      shift.z += -(inv02 * b0 + inv12 * b1 + inv22 * b2)
      if (!(Number.isFinite(shift.x) && Number.isFinite(shift.y) && Number.isFinite(shift.z))) return
    }
  }

  /** g：给定 hips 偏移下，各约束的最大距离残差（米；NaN = 输入非法）。 */
  private computeStanceResidual(count: number, offsetX: number, offsetY: number, offsetZ: number): number {
    let worst = 0
    for (let index = 0; index < count; index += 1) {
      const c = this.stanceConstraints[index]
      const vx = c.hx + offsetX - c.px
      const vy = c.hy + offsetY - c.py
      const vz = c.hz + offsetZ - c.pz
      const length = Math.sqrt(vx * vx + vy * vy + vz * vz)
      if (!Number.isFinite(length)) return Number.NaN
      const absR = Math.abs(length - c.d)
      if (absR > worst) worst = absR
    }
    return worst
  }

  /** 本帧 IK 前（clip+micro 已写）作者膝角（度）；同时清空上一帧运行时膝角待回填。 */
  private measureAuthorKneeFlex(): void {
    for (const rig of this.rigs) {
      if (rig.upper === null || rig.lower === null || rig.foot === null) {
        rig.authorKneeFlexDeg = null
        rig.lastKneeFlexDeg = null
        continue
      }
      const hip = this.worldPositionOf(rig.upper, this.tmpA)
      const knee = this.worldPositionOf(rig.lower, this.tmpB)
      const ankle = this.worldPositionOf(rig.foot, this.tmpC)
      rig.authorKneeFlexDeg = kneeFlexDeg(hip, knee, ankle, this.tmpD, this.tmpE)
      rig.lastKneeFlexDeg = null
    }
  }

  /** IK 未执行（未 pinned / 骨骼缺失）时，运行时膝角 = 作者膝角。 */
  private fillUnmeasuredKneeFlex(): void {
    for (const rig of this.rigs) {
      if (rig.lastKneeFlexDeg === null) rig.lastKneeFlexDeg = rig.authorKneeFlexDeg
    }
  }

  /**
   * 骨盆下沉：阻尼平滑后加到 normalized hips 的 y 上（每帧量 = clip-player 刚写回的基准值，
   * 不累积）。目标为 0 时平滑回正（用于离开静止状态）。
   */
  private applyPelvisDrop(targetDrop: number, dtSec: number): void {
    const dropAlpha = smoothingAlpha(dtSec, this.options.pelvisDropTauSec)
    if (dropAlpha > 0) {
      this.pelvisDropM += (targetDrop - this.pelvisDropM) * dropAlpha
    }
    if (Math.abs(this.pelvisDropM) < 1e-4) this.pelvisDropM = 0
    if (this.pelvisDropM > this.options.maxPelvisDropM) {
      this.pelvisDropM = this.options.maxPelvisDropM
    }
    if (this.pelvisDropM < 0) this.pelvisDropM = 0
    if (this.hips !== null && this.pelvisDropM !== 0) {
      this.hips.position.y -= this.pelvisDropM
      this.hips.updateMatrixWorld(true)
    }
  }

  /* ------------------------------ replant（换姿势重锚） ------------------------------ */

  /**
   * fade 结束后一次性采样新 clip 的作者站姿并规划换步。
   *
   * 目标来源：这一帧 `clip-player` 已写入新 clip 的绝对作者姿势（+micro），本函数在
   * `applyStanceAlign` / `solveFoot` 之前读取踝位，因此**不需要改 clip-player**。
   * 两只脚按水平距离降序排队（同一时刻最多一只离地）：水平时长 T=clamp(d/0.45, 0.30, 0.45)s，
   * 后一脚在前一脚完成 + gap 后开始；d < minMove 的脚走 0.15s 迷你混合（不抬脚）。
   * 作者此刻抬着脚（表演型 idle）时不把 pin 重锚到空中，释放该脚跟随作者（旧行为）。
   */
  private startReplant(scene: Object3D): void {
    // R3 兜底：fade 结束时上一轮 replant 仍未完成（fade 短于 duration），先让空中脚落地，
    // 再从地面位置重新规划，避免从半空起跳。
    if (this.left.replant !== null || this.right.replant !== null) {
      this.finishReplantNow()
    }
    interface Candidate {
      rig: FootRig
      index: number
      targetX: number
      targetY: number
      targetZ: number
      targetQuat: Quaternion | null
      moveM: number
    }
    const candidates: Candidate[] = []
    for (let index = 0; index < this.rigs.length; index += 1) {
      const rig = this.rigs[index]!
      if (!rig.contact || rig.pinPosition === null || rig.foot === null) continue
      // 本帧 IK 前作者踝位（clip+micro 已写；此刻姿态 = 纯目标 clip）。
      const target = this.sceneLocalPositionOf(rig.foot, scene, this.tmpD)
      const authorLift = rig.restFootLocalY === null ? 0 : target.y - rig.restFootLocalY
      if (authorLift > this.options.contactEnterLiftM + 1e-4) {
        // 作者此刻抬着这只脚（表演型 idle 的抬脚/换步）：不能把 pin 重锚到空中。
        // 释放该脚，让它跟随作者；落地后由正常接触判定重新锚定。
        this.releaseContact(rig)
        rig.orientationOffSec = 0
        continue
      }
      const moveM = Math.hypot(target.x - rig.pinPosition.x, target.z - rig.pinPosition.z)
      if (!Number.isFinite(moveM) || !Number.isFinite(target.x + target.y + target.z)) continue
      let targetQuat: Quaternion | null = null
      if (this.options.anchorOrientation) {
        rig.foot.updateWorldMatrix(true, false)
        const world = rig.foot.getWorldQuaternion(this.tmpQuatA)
        targetQuat = worldToSceneLocalQuat(scene, world, this.tmpQuatB, new Quaternion())
      }
      candidates.push({
        rig,
        index,
        targetX: target.x,
        targetY: target.y,
        targetZ: target.z,
        targetQuat,
        moveM
      })
    }
    if (candidates.length === 0) return

    // g 让位：记录当前 hipShift，换步期间按进度衰减到 0；settle 后再交还给常规解。
    this.replantAlignActive = true
    this.replantAlignProgress = 0
    this.replantSettleActive = false
    this.replantSettleElapsed = 0
    this.replantStepActive = true
    this.replantAlignFrom.copy(this.hipShift)
    this.replantStarted[0] = false
    this.replantStarted[1] = false
    this.replantPhase[0] = 0
    this.replantPhase[1] = 0

    candidates.sort((a, b) => b.moveM - a.moveM)
    // R1：两脚都参与换步时改为同步换步（delay 都为 0）。错峰换步会让先动脚先到目标、后动脚
    // 仍留旧位，中间帧站姿宽被拉出两端之外（实测 adv-idle→hsr-idle 峰值 42cm vs 作者 31cm）；
    // 同步换步两脚同进度插值，宽度始终在起止宽度之间，峰值 = max(起始宽, 目标宽)。离线数据
    // 同步/错峰的地面擦动与身体位移差异很小（2.3 vs 2.9px、1.12 vs 1.12）。
    const syncSteps = candidates.length >= 2
    let cursorSec = 0
    for (const candidate of candidates) {
      const { rig, index, moveM } = candidate
      const mini = moveM < this.replantTuning.minMoveM
      const durationSec = mini
        ? REPLANT_MINI_DURATION_SEC
        : clamp(
            moveM / this.replantTuning.maxSpeedMps,
            this.replantTuning.minDurationSec,
            this.replantTuning.maxDurationSec
          )
      const liftPeak = mini
        ? 0
        : clamp(
            moveM * REPLANT_LIFT_FACTOR,
            Math.min(this.replantTuning.liftMinM, this.replantTuning.liftMaxM),
            this.replantTuning.liftMaxM
          )
      const pin = rig.pinPosition!
      rig.replant = {
        delaySec: syncSteps ? 0 : cursorSec,
        durationSec,
        elapsedSec: 0,
        liftM: liftPeak,
        liftNowM: 0,
        fromX: pin.x,
        fromY: pin.y,
        fromZ: pin.z,
        toX: candidate.targetX,
        toY: candidate.targetY,
        toZ: candidate.targetZ,
        fromQuat:
          this.options.anchorOrientation && rig.pinQuaternion !== null
            ? rig.pinQuaternion.clone()
            : null,
        toQuat: candidate.targetQuat,
        phase: 0,
        targetErrM: moveM
      }
      // 换步期间保持 contact=true，避免 updateContact 把「脚本抬脚」误判成作者抬脚而释放。
      rig.contact = true
      rig.previousLocal = null
      rig.orientationOffSec = 0
      this.replantStarted[index] = true
      this.replantPhase[index] = 0
      // 同步换步：两脚同时开始（delay 都为 0），不推进错峰游标。
      if (!syncSteps) cursorSec += durationSec + this.replantTuning.stepGapSec
    }
  }

  /**
   * 推进换步轨迹：水平 smoothstep + 正弦抬脚弧线；朝向与水平同进度最短弧 slerp。
   * 落地时 pin=目标、previousLocal=null，下一帧起恢复刚性锚定。
   */
  private advanceReplant(dtSec: number): void {
    let anyActive = false
    for (let index = 0; index < this.rigs.length; index += 1) {
      const rig = this.rigs[index]!
      const state = rig.replant
      if (state === null) {
        if (this.replantStarted[index]) this.replantPhase[index] = 1
        continue
      }
      if (rig.pinPosition === null) {
        rig.replant = null
        if (this.replantStarted[index]) this.replantPhase[index] = 1
        continue
      }
      anyActive = true
      state.elapsedSec += dtSec
      const localSec = state.elapsedSec - state.delaySec
      if (localSec < 0) {
        // 错峰等待：pin 保持原位、不抬脚。
        state.liftNowM = 0
        state.phase = 0
        continue
      }
      const u = clamp(localSec / state.durationSec, 0, 1)
      // 水平只在中间 (1−2·lead) 时长内移动；抬脚弧线覆盖整段 → 先抬后走、先停后落。
      const hp = clamp(
        (u - REPLANT_HORIZONTAL_LEAD) / (1 - 2 * REPLANT_HORIZONTAL_LEAD),
        0,
        1
      )
      const e = smoothstep01(hp)
      const pin = rig.pinPosition
      pin.x = state.fromX + (state.toX - state.fromX) * e
      pin.y = state.fromY + (state.toY - state.fromY) * e + state.liftM * Math.sin(Math.PI * u)
      pin.z = state.fromZ + (state.toZ - state.fromZ) * e
      state.liftNowM = state.liftM * Math.sin(Math.PI * u)
      state.phase = u
      state.targetErrM = Math.hypot(pin.x - state.toX, pin.z - state.toZ)
      if (state.fromQuat !== null && state.toQuat !== null && rig.pinQuaternion !== null) {
        // 最短弧：q 与 −q 表示同一旋转，先取同半球再 slerp。
        const target = this.tmpQuatA.copy(state.toQuat)
        if (target.dot(state.fromQuat) < 0) {
          target.set(-target.x, -target.y, -target.z, -target.w)
        }
        rig.pinQuaternion.copy(state.fromQuat).slerp(target, e)
      }
      if (u >= 1) {
        pin.set(state.toX, state.toY, state.toZ)
        if (state.fromQuat !== null && state.toQuat !== null && rig.pinQuaternion !== null) {
          rig.pinQuaternion.copy(state.toQuat)
        }
        rig.replant = null
        rig.previousLocal = null
        this.replantPhase[index] = 1
      } else {
        this.replantPhase[index] = u
      }
      // 数值防御：异常资源/骨骼矩阵不应把 NaN 写进 pin（本帧停用该脚换步）。
      if (!Number.isFinite(pin.x + pin.y + pin.z)) {
        rig.replant = null
        this.replantPhase[index] = 1
      }
    }
    this.replantStepActive = anyActive
    if (this.replantAlignActive) {
      let sum = 0
      let count = 0
      for (let index = 0; index < 2; index += 1) {
        if (!this.replantStarted[index]) continue
        count += 1
        sum += this.replantPhase[index]!
      }
      this.replantAlignProgress = count > 0 ? sum / count : 1
    }
  }

  /**
   * 换步全部落地后：保持 δ=0 一段 `REPLANT_SETTLE_SEC`，再交还常规 g 求解。
   * （settle 期由 `applyStanceAlign` 跳过常规解/fallback/projection，目标自然为 0。）
   */
  private updateReplantSettle(dtSec: number): void {
    if (!this.replantAlignActive) return
    if (this.replantStepActive) {
      this.replantSettleActive = false
      this.replantSettleElapsed = 0
      return
    }
    if (!this.replantSettleActive) {
      this.replantSettleActive = true
      this.replantSettleElapsed = 0
      return
    }
    this.replantSettleElapsed += dtSec
    if (this.replantSettleElapsed >= REPLANT_SETTLE_SEC) {
      this.replantSettleActive = false
      this.replantSettleElapsed = 0
      this.replantAlignActive = false
      // 恢复常规 g 时从零 warm start 重新解（非累积，最小范数解；避免把 fade 期间的
      // 大位移解带进新站姿，导致稳态 δ 偏大/身体侧移）。
      this.stanceWarmStart.set(0, 0, 0)
      this.projectionGraceSec = REPLANT_PROJECTION_GRACE_SEC
    }
  }

  /**
   * 立即结束换步：脚停在当前插值位置（不清 pin/contact），用于离场/再次换姿势。
   * 调用方决定后续是释放（ineligible）还是重新规划（新 clip 的 pendingReplant）。
   */
  private finishReplantNow(): void {
    for (const rig of this.rigs) {
      if (rig.replant === null) continue
      const state = rig.replant
      // R3：被打断时若脚还抬着，先把 pin 落到当前水平插值的地面投影（pin.y = 地面 + liftNow），
      // 避免空中脚被清空后一直悬在半空、下一轮从半空起跳而反复打断无法落地（快速切换抽搐）。
      if (rig.pinPosition !== null && state.liftNowM > 0) {
        rig.pinPosition.y -= state.liftNowM
      }
      state.liftNowM = 0
      rig.replant = null
      rig.previousLocal = null
    }
    this.replantAlignActive = false
    this.replantAlignProgress = 0
    this.replantSettleActive = false
    this.replantSettleElapsed = 0
    this.replantStepActive = false
    this.projectionGraceSec = 0
    this.replantStarted[0] = false
    this.replantStarted[1] = false
    this.replantPhase[0] = 0
    this.replantPhase[1] = 0
  }

  /** 本帧是否有脚在换步（含等待错峰/迷你混合；调试快照用）。 */
  private isReplantActive(): boolean {
    return this.left.replant !== null || this.right.replant !== null
  }

  /**
   * 进入非静止状态时的释放：停止接触判定、清速度历史，但保留 pin 让 solveFoot 平滑淡出。
   */
  private beginTransitionRelease(rig: FootRig): void {
    rig.contact = false
    rig.previousLocal = null
    rig.orientationOffSec = 0
  }

  /**
   * 接触状态机：抬升 + 水平速度双条件（带迟滞），跨 clip 切换保持 pin。
   * `freeze === true`（crossfade 期间）只测量、不改变接触状态，避免把混合合成速度误判成抬脚。
   */
  private updateContact(
    rig: FootRig,
    scene: Object3D,
    dtSec: number,
    freeze: boolean
  ): void {
    if (rig.foot === null || rig.restFootLocalY === null) {
      this.releaseContact(rig)
      return
    }
    const local = this.sceneLocalPositionOf(rig.foot, scene, this.tmpD)
    const lift = local.y - rig.restFootLocalY
    rig.lastLiftM = lift

    let speed = 0
    if (rig.previousLocal !== null && dtSec > 0) {
      const dx = local.x - rig.previousLocal.x
      const dz = local.z - rig.previousLocal.z
      speed = Math.hypot(dx, dz) / dtSec
    } else {
      rig.previousLocal = new Vector3()
    }
    if (rig.previousLocal === null) rig.previousLocal = new Vector3()
    rig.previousLocal.set(local.x, local.y, local.z)

    if (freeze) return

    if (!rig.contact) {
      const enter =
        lift <= this.options.contactEnterLiftM && speed <= this.options.contactEnterSpeedMps
      if (enter) {
        rig.contact = true
        // 锚点 = 当前踝位置/朝向（scene 局部空间；跨 clip 切换保持不换锚）。
        rig.pinPosition = local.clone()
        if (this.options.anchorOrientation) {
          rig.foot.updateWorldMatrix(true, false)
          const world = rig.foot.getWorldQuaternion(this.tmpQuatA)
          rig.pinQuaternion = worldToSceneLocalQuat(scene, world, this.tmpQuatB, new Quaternion())
        } else {
          rig.pinQuaternion = null
        }
      }
      return
    }

    // 已在接触：超过退出迟滞或速度过快 → 释放（pin 保留到权重淡出结束）。
    const liftOut = lift > this.options.contactExitLiftM
    const speedOut = speed > this.options.contactHoldSpeedMps
    if (liftOut || speedOut) {
      this.releaseContact(rig)
      rig.orientationOffSec = 0
      return
    }

    // 转身/换脚 + B 软跟随：
    // - 普通变体间脚 yaw 差 8.8°–31°（REPORT §3）：>9° 时把锚点朝向按 τ=0.4s 缓慢转向
    //   当前作者脚朝向（位置仍钉住），消掉「脚掌被硬保持旧 yaw」的踝扭转/外八；
    // - 硬释放（>35° 持续 0.25s）保留为安全网，判定**用本帧跟随前**的角度——否则跟随会
    //   把偏差一直拖在阈值下、永不释放；实际上只有 ≥~66° 的突变才会走到硬释放。
    if (this.options.anchorOrientation && rig.pinQuaternion !== null) {
      rig.foot.updateWorldMatrix(true, false)
      const currentLocal = worldToSceneLocalQuat(
        scene,
        rig.foot.getWorldQuaternion(this.tmpQuatA),
        this.tmpQuatB,
        this.tmpQuatC
      )
      const dot = Math.min(1, Math.abs(currentLocal.dot(rig.pinQuaternion)))
      const angle = 2 * Math.acos(dot)
      rig.lastOrientationErrRad = angle
      if (angle > ORIENTATION_SOFT_FOLLOW_RAD) {
        // 同半球 slerp（避免绕远路）：把锚点朝向慢速转向当前作者朝向。
        const target = this.tmpQuatA.copy(currentLocal)
        if (target.dot(rig.pinQuaternion) < 0) {
          // three.js 没有 Quaternion.negate：手动取同半球（q 与 −q 表示同一旋转，slerp 走短弧）。
          target.set(-target.x, -target.y, -target.z, -target.w)
        }
        rig.pinQuaternion.slerp(target, smoothingAlpha(dtSec, ORIENTATION_SOFT_FOLLOW_TAU_SEC))
      }
      if (angle > ORIENTATION_RELEASE_RAD) {
        rig.orientationOffSec += dtSec
        if (rig.orientationOffSec >= ORIENTATION_RELEASE_SEC) {
          this.releaseContact(rig)
          rig.orientationOffSec = 0
        }
      } else {
        rig.orientationOffSec = 0
      }
    }
  }

  /** 释放接触（pin 保留到权重淡出归零，避免瞬间弹回）。 */
  private releaseContact(rig: FootRig): void {
    rig.contact = false
    rig.lastOrientationErrRad = null
  }

  /** 不参与固定时立刻清状态（拖拽/坐/空中/移动不残留）。 */
  private deactivate(rig: FootRig): void {
    rig.contact = false
    rig.pinPosition = null
    rig.pinQuaternion = null
    rig.weight = 0
    rig.previousLocal = null
    rig.lastErrorM = null
    rig.lastLiftM = null
    rig.lastFootX = null
    rig.lastFootZ = null
    rig.lastPole = null
    rig.orientationOffSec = 0
    rig.lastOrientationErrRad = null
    rig.lastKneeFlexDeg = null
    rig.authorKneeFlexDeg = null
  }

  /** 单腿：权重平滑 → 两骨 IK → 脚朝向锚定。 */
  private solveFoot(rig: FootRig, scene: Object3D, dtSec: number): void {
    if (rig.upper === null || rig.lower === null || rig.foot === null) return
    if (rig.pinPosition === null) {
      rig.weight = 0
      rig.lastFootX = null
      rig.lastFootZ = null
      return
    }
    const reach = rig.upperLength + rig.lowerLength
    if (!(reach > 1e-6)) {
      rig.weight = 0
      rig.pinPosition = null
      rig.pinQuaternion = null
      return
    }

    const tau = rig.contact ? this.options.weightTauInSec : this.options.weightTauOutSec
    const alpha = smoothingAlpha(dtSec, tau)
    const target = rig.contact ? 1 : 0
    rig.weight += (target - rig.weight) * alpha
    if (rig.weight < RELEASE_WEIGHT_EPSILON) {
      rig.weight = 0
      rig.pinPosition = null
      rig.pinQuaternion = null
      rig.lastErrorM = null
      rig.lastLiftM = null
      rig.lastFootX = null
      rig.lastFootZ = null
      rig.lastOrientationErrRad = null
      return
    }
    rig.weight = clamp(rig.weight, 0, 1)
    if (rig.weight <= 0) return

    // R-03：IK 全程复用 this.ikScratch + tmpA..E/tmpQuatA..C，不再每脚每帧新建临时对象。
    const scratch = this.ikScratch
    const targetWorld = scene.localToWorld(this.tmpB.copy(rig.pinPosition))
    const hip = this.worldPositionOf(rig.upper, this.tmpA)
    const currentKnee = this.worldPositionOf(rig.lower, this.tmpC)
    // 近伸直时当前膝平面退化：把上一帧极向量作为兜底，避免膝盖瞬间翻转（rabfulton/VRM 做法）。
    const solvedKnee = solveKneePosition(
      hip,
      targetWorld,
      currentKnee,
      rig.upperLength,
      rig.lowerLength,
      rig.lastPole ?? undefined,
      scratch
    )
    // 上段：当前膝 → 解算膝的世界旋转增量，再按接触权重 slerp（只旋转、不缩放）。
    const upperWorld = getWorldQuat(rig.upper, this.tmpQuatA)
    const desiredUpper = computeUpperDesiredWorldQuat(hip, currentKnee, solvedKnee, upperWorld, scratch)
    const upperTarget = this.tmpQuatC.copy(upperWorld).slerp(desiredUpper, rig.weight)
    setLocalFromWorldQuat(rig.upper, upperTarget, this.tmpQuatA)
    rig.upper.updateMatrixWorld(true)

    // 极向量历史（近伸直时下一帧兜底）：solvedKnee 已消费完，复用 tmpD 计算，避免每帧新建 Vector3。
    const targetDir = this.tmpE.copy(targetWorld).sub(hip)
    if (targetDir.lengthSq() > 1e-10) {
      targetDir.normalize()
      const solvedDir = this.tmpD.copy(solvedKnee).sub(hip)
      const newPole = solvedDir.addScaledVector(targetDir, -solvedDir.dot(targetDir))
      if (newPole.lengthSq() > 1e-8) {
        if (rig.lastPole === null) rig.lastPole = new Vector3()
        rig.lastPole.copy(newPole.normalize())
      }
    }

    // 上段旋转后重新取膝/踝世界位置，再解小腿（对齐到「当前膝 → 目标踝」）。
    const knee = this.worldPositionOf(rig.lower, this.tmpC)
    const foot = this.worldPositionOf(rig.foot, this.tmpD)
    const lowerWorld = getWorldQuat(rig.lower, this.tmpQuatA)
    const desiredLower = computeLowerDesiredWorldQuat(knee, foot, targetWorld, lowerWorld, scratch)
    const lowerTarget = this.tmpQuatC.copy(lowerWorld).slerp(desiredLower, rig.weight)
    setLocalFromWorldQuat(rig.lower, lowerTarget, this.tmpQuatA)
    rig.lower.updateMatrixWorld(true)

    // 脚：默认保持锚定朝向（脚掌不随混合/小腿扭转而滑动）。
    if (this.options.anchorOrientation && rig.pinQuaternion !== null) {
      const currentWorld = getWorldQuat(rig.foot, this.tmpQuatA)
      const pinWorld = sceneLocalQuatToWorld(scene, rig.pinQuaternion, this.tmpQuatC, this.tmpQuatB)
      const footTarget = this.tmpQuatC.copy(currentWorld).slerp(pinWorld, rig.weight)
      setLocalFromWorldQuat(rig.foot, footTarget, this.tmpQuatA)
      rig.foot.updateMatrixWorld(true)
    }

    // 锚点残差（验收指标；米）。
    const finalFoot = this.worldPositionOf(rig.foot, this.tmpE)
    rig.lastErrorM = finalFoot.distanceTo(targetWorld)
    // v2：运行时膝屈曲角（IK 后；髋-膝-踝三点夹角，度）——调试验收字段，
    // 与 `authorKneeFlexDeg`（本帧 IK 前）对比可量化「运行时把腿弯了多少度」。
    const runtimeHip = this.worldPositionOf(rig.upper, this.tmpA)
    const runtimeKnee = this.worldPositionOf(rig.lower, this.tmpB)
    rig.lastKneeFlexDeg = kneeFlexDeg(runtimeHip, runtimeKnee, finalFoot, this.tmpC, this.tmpD)
    // dev-capture 验收：记录踝位 scene 局部 x/z（只读快照消费；finalFoot 已消费完，可原位转局部）。
    const footLocal = scene.worldToLocal(this.tmpB.copy(finalFoot))
    rig.lastFootX = Number.isFinite(footLocal.x) ? footLocal.x : null
    rig.lastFootZ = Number.isFinite(footLocal.z) ? footLocal.z : null
  }

  /** 取节点世界位置（tmp；会按需刷新祖先矩阵）。 */
  private worldPositionOf(node: Object3D | null, out: Vector3): Vector3 {
    if (node === null) return out.set(0, 0, 0)
    node.updateWorldMatrix(true, false)
    return node.getWorldPosition(out)
  }

  /** 取节点在 avatar.scene 局部坐标的位置。 */
  private sceneLocalPositionOf(node: Object3D, scene: Object3D, out: Vector3): Vector3 {
    node.updateWorldMatrix(true, false)
    node.getWorldPosition(out)
    return scene.worldToLocal(out)
  }

  /**
   * 调试快照（`window.__aventurineDebug.animation.footLock` 来源）。
   * 误差/抬升单位米；weight 四舍五入到 2 位。
   */
  getSnapshot(): VrmFootLockDebugSnapshot {
    const round = (value: number): number => Math.round(value * 100) / 100
    const roundM = (value: number | null): number | null =>
      value === null || !Number.isFinite(value) ? null : Math.round(value * 10000) / 10000
    const roundDeg = (value: number | null): number | null =>
      value === null || !Number.isFinite(value)
        ? null
        : Math.round((value * 1800) / Math.PI) / 10
    /** 已是「度」的值（膝角）：只做 0.1° 取整。 */
    const roundDegValue = (value: number | null): number | null =>
      value === null || !Number.isFinite(value) ? null : Math.round(value * 10) / 10
    return {
      enabled: this.enabled,
      leftPinned: this.left.pinPosition !== null && this.left.weight > 0,
      rightPinned: this.right.pinPosition !== null && this.right.weight > 0,
      leftWeight: round(this.left.weight),
      rightWeight: round(this.right.weight),
      pelvisDropM: roundM(this.pelvisDropM),
      leftFootErrorM: roundM(this.left.lastErrorM),
      rightFootErrorM: roundM(this.right.lastErrorM),
      leftFootLiftM: roundM(this.left.lastLiftM),
      rightFootLiftM: roundM(this.right.lastLiftM),
      // scene 局部踝位（米；dev-capture 断言「各 idle 站姿 = 作者站姿」用）。
      leftFootX: roundM(this.left.lastFootX),
      leftFootZ: roundM(this.left.lastFootZ),
      rightFootX: roundM(this.right.lastFootX),
      rightFootZ: roundM(this.right.lastFootZ),
      hipShiftXM: roundM(this.hipShift.x),
      hipShiftYM: roundM(this.hipShift.y),
      hipShiftZM: roundM(this.hipShift.z),
      stanceSolveResidualM: roundM(this.lastStanceResidualM),
      stanceAlignMode: this.stanceMode,
      stanceSolveIterations: this.lastStanceIterations,
      leftFootOrientationErrDeg: roundDeg(this.left.lastOrientationErrRad),
      rightFootOrientationErrDeg: roundDeg(this.right.lastOrientationErrRad),
      kneeFlexDegL: roundDegValue(this.left.lastKneeFlexDeg),
      kneeFlexDegR: roundDegValue(this.right.lastKneeFlexDeg),
      authorKneeFlexDegL: roundDegValue(this.left.authorKneeFlexDeg),
      authorKneeFlexDegR: roundDegValue(this.right.authorKneeFlexDeg),
      // replant：换姿势重锚状态（旧消费方可忽略；全部可选）。
      replantPending: this.pendingReplant,
      replantActive: this.isReplantActive(),
      leftReplantActive: this.left.replant !== null,
      rightReplantActive: this.right.replant !== null,
      leftReplantLiftM: roundM(this.left.replant?.liftNowM ?? null),
      rightReplantLiftM: roundM(this.right.replant?.liftNowM ?? null),
      leftReplantTargetErrM: roundM(this.left.replant?.targetErrM ?? null),
      rightReplantTargetErrM: roundM(this.right.replant?.targetErrM ?? null)
    }
  }

  /** 立即清空状态（clip 未就绪/模型降级时用；不改变 enabled 配置，可重复调用）。 */
  reset(): void {
    this.finishReplantNow()
    this.pendingReplant = false
    this.lastClipId = null
    this.deactivate(this.left)
    this.deactivate(this.right)
    this.pelvisDropM = 0
    // g/A：不保留上一轮的 hips 对齐（重新锁定从 0 开始累计）。
    this.hipShift.set(0, 0, 0)
    this.stanceWarmStart.set(0, 0, 0)
    this.stanceTarget.set(0, 0, 0)
    this.lastStanceResidualM = null
    this.lastStanceIterations = 0
    this.stanceMode = this.options.stanceAlignMode
    this.left.lastKneeFlexDeg = null
    this.right.lastKneeFlexDeg = null
    this.left.authorKneeFlexDeg = null
    this.right.authorKneeFlexDeg = null
  }

  dispose(): void {
    this.disposed = true
    this.reset()
  }
}
