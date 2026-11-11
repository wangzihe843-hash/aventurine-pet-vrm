/**
 * B3 每帧动画管线（**纯逻辑，不 import three/DOM/Electron**）。
 *
 * 输入：`AnimationInput`（Lead 冻结契约）+ 注入时钟毫秒；输出：受控骨局部四元数 +
 * センター平移/翻滚 + morph 权重 + `AnimationDebugSnapshot`。
 * `scene-bridge.ts` 只负责把 three 的 Bone/SkinnedMesh 适配进来并写回，便于 Node 单测整条链路。
 *
 * 每帧顺序（锁死，单测断言）：
 * 1. 时间/事件推进（反应/待机变体/表情计时）；
 * 2. 基础姿态（姿态表 + 程序化步态）→ PoseMachine（smoothstep 过渡、短弧 slerp、可打断）；
 * 3. 呼吸/微动 additive 层；
 * 4. 反应/待机手势 overlay 层（bone mask + 权重包络）；
 * 5. look-at additive 层（首/頭），眼球（目先）单独覆盖；
 * 6. 接地：解析二骨 IK + 髋高补偿 + 脚掌贴平（只覆盖腿 D 链）；
 * 7. 发辫 verlet 弹簧（最后写，只写四元数）；
 * 8. 表情调度：情绪（眼/眉/嘴/材质）→ 眨眼 → 口型 → 全量输出非零 morph；
 * 9. 组装调试快照。
 */
import type { AnimationDebugSnapshot, AnimationEvent, AnimationInput } from '../../core/wave2-contract'
import type { PetMood } from '@shared/types'

import {
  DEFAULT_POSE_FADE_SEC,
  MAX_DT_SEC,
  type GestureDef,
  type GazeTarget,
  type PoseQuats,
  type Quat,
  type Vec3
} from './types'
import {
  clamp,
  conjugateQuat,
  damp,
  degToRad,
  eulerToQuat,
  multiplyQuat,
  normalizeQuat,
  quatToRotationVector,
  smoothstep
} from './quat'
import { blendLayers, type PoseLayer } from './blend'
import { PoseMachine } from './pose-machine'
import { createGroundingRig, solveGrounding, type GroundingRig } from './grounding'
import { createGaitState, advanceGait, computeClimbOffsets, computeSitEdgeOffsets, computeWalkOffsets, type GaitState } from './gait'
import { GazeController } from './look-at'
import {
  computeIdleHeadDrift,
  computeMicroMotion,
  GESTURE_FINGER_CURL_BOOST,
  microScaleFor,
  type MicroMotionScale
} from './micro-motion'
import { createBlinkState, stepBlink, type BlinkState } from './blink'
import {
  laughingEyeWeightOf,
  mergeMorphsMax,
  mixEmotions,
  mouthOpenOf,
  nonZeroMorphs,
  smileWeightOf,
  type EmotionEntry
} from './emotion'
import { stepViseme, textToVisemes, visemeMorph, visemeSequenceDurationMs, type VisemeStep } from './viseme'
import { SPRING_CHAINS } from './skeleton'
import {
  computeRestDirections,
  createSpringChainState,
  DEFAULT_SPRING_PARAMS,
  stepSpringChain,
  type SpringChainConfig,
  type SpringChainState
} from './spring'
import {
  BASE_POSE_META,
  BASE_POSES,
  BASE_POSE_IDS,
  addEulerDegrees,
  degreesToQuats,
  findGesture,
  gestureEmotionAt,
  gestureGazeAt,
  sampleGesture
} from './poses'
import { IdleDirector, moodTransitionGesture, pickReaction, resolveBasePoseId } from './state-map'

/** 管线所需骨架信息（scene-bridge 从 three 骨架一次性读出）。 */
export interface PipelineRig {
  /** 骨名 → rest 模型空间位置（y 向上；由骨骼 `position` 沿父链累加得到）。 */
  restPositions: Readonly<Record<string, Vec3>>
  /** 模型 bind 姿势高度（模型单位；px 换算用）。 */
  modelHeight: number
  /** 启动自检缺失的骨名（scene-bridge 汇总；进调试快照）。 */
  missingBones: readonly string[]
  /**
   * 骨名 → 父骨名（用于把弹簧链根父骨的世界四元数沿可控骨链累乘出来）。
   * 可选：缺省时用内置 fallback（上半身/头部/手臂链），单测可省略。
   */
  boneParents?: Readonly<Record<string, string | null>>
}

/** 管线选项（随机源/初始姿态）。 */
export interface PipelineOptions {
  /** 随机源（眨眼/待机变体；默认 Math.random；单测注入 seeded）。 */
  random?: () => number
  /** 初始基础姿态 id（默认 stand）。 */
  initialPose?: string
}

/** 一帧输出（scene-bridge 写回 three 用）。 */
export interface AnimationFrameOutput {
  /** 受控骨最终局部四元数（含 目先 与弹簧骨；缺骨不出现）。 */
  boneQuaternions: PoseQuats
  /** `センター.position.y` 偏移（模型单位）。 */
  centerOffsetY: number
  /** `センター.position.x` 偏移（模型单位；正 = 角色左侧；contrapposto/换重心）。 */
  centerOffsetX: number
  /** `センター.quaternion`（仅睡姿翻滚；其余恒等）。 */
  centerQuaternion: Quat
  /** 本帧 morph 权重（morph 名 → 0..1；**全量**，未列出的由 scene-bridge 归零）。 */
  morphWeights: Map<string, number>
  /** 调试快照（`updateMs` 由 scene-bridge 填）。 */
  debug: AnimationDebugSnapshot
}

/** 反应/待机手势的运行时状态。 */
interface ActiveGesture {
  def: GestureDef
  kind: 'idle' | 'reaction' | 'mood'
  startMs: number
  elapsed: number
  /** 重心下沉脉冲基准（模型单位；落地按冲击速度覆盖）。 */
  pulse: number
}

/** 姿态切换的过渡时长表（不同姿态观感不同；默认 0.25s）。 */
const FADE_BY_POSE: Readonly<Record<string, number>> = {
  stand: 0.3,
  walk: 0.35,
  climb: 0.42,
  sit: 0.55,
  sitEdge: 0.55,
  sleep: 0.75,
  pat: 0.25,
  drag: 0.2,
  fall: 0.15,
  celebrate: 0.3,
  sad: 0.55,
  busy: 0.45
}

/** 姿态切换的「预备动作」时长（秒）：先反向蓄力再到位，避免所有切换都是匀速滑过去。 */
const ANTICIPATION_SEC = 0.14

/** 睡姿翻滚平滑时间常数（秒）。 */
const CENTER_ROLL_TAU_SEC = 0.12
/** 3/4 侧身（センター Y 旋转）平滑时间常数（秒）。 */
const CENTER_YAW_TAU_SEC = 0.18
/** 承重脚慢层：换脚间隔 8–15s、过渡 1.1s。 */
const WEIGHT_SHIFT_MIN_MS = 8000
const WEIGHT_SHIFT_RANGE_MS = 7000
const WEIGHT_SHIFT_RAMP_MS = 1100

/** 表情层优先级。 */
const PRIORITY_BASE_EMOTION = 10
const PRIORITY_GESTURE_EMOTION = 30

/** 眼睛骨。 */
const EYE_BONE_LEFT = '左目先'
const EYE_BONE_RIGHT = '右目先'

/**
 * 动画管线：无 three 依赖，可直接在 Node 单测里喂 `AnimationInput` 假数据跑完整帧。
 */
export class AnimationPipeline {
  private readonly rig: PipelineRig
  private readonly random: () => number
  private readonly poseMachine = new PoseMachine({ stagger: POSE_STAGGER })
  private readonly idleDirector: IdleDirector
  private readonly gaze = new GazeController()
  private readonly gait: GaitState = createGaitState()

  private groundingRig: GroundingRig | null = null
  private readonly springConfigs: SpringChainConfig[] = []
  private springStates: SpringChainState[] = []
  private readonly prevParentWorldQuats = new Map<string, Quat>()

  private timeSec = 0
  private manualPoseId: string | null = null
  private pendingFadeSec: number | null = null
  private previousMood: PetMood | null = null
  private activeGesture: ActiveGesture | null = null
  private wasDragging = false
  private wasAirborne = false
  private idleResetNeeded = true

  private blinkState: BlinkState | null = null
  private visemeSteps: VisemeStep[] = []
  private visemeText: string | null = null
  private visemeStartMs = 0
  private lastVisemeWeight = 0

  private lastNowMs = 0
  private currentCenterOffset = 0
  private currentCenterRollDeg = 0
  private currentCenterYawDeg = 0
  private currentCenterX = 0
  private currentCenterQuat: Quat = { x: 0, y: 0, z: 0, w: 1 }
  private centerSmoothPoseId: string | null = null
  private anticipationRemaining = 0
  private anticipationTotal = ANTICIPATION_SEC
  private lastPoseIdForAnticipation = ''
  private centerFrom = 0
  private centerXFrom = 0
  // 慢层「承重脚」：每 8–15s 换一次重心，1.1s smoothstep 过渡。
  private weightShiftX = 0
  private weightShiftTargetX = 0
  private weightShiftFromX = 0
  private weightShiftStartMs = 0
  private weightShiftSwitchAtMs = 0
  private weightShiftInitialized = false
  private blendedPose: PoseQuats = new Map()
  private lastDebug: AnimationDebugSnapshot = {
    pose: 'stand',
    poseWeight: 0,
    activeLayers: 1,
    gesture: null,
    blink: 0,
    smile: 0,
    mouthOpen: 0,
    lookYaw: null,
    missingBones: []
  }
  private lastFootErrorPx: number | null = null
  private lastSpringAngles: Record<string, number> = {}

  constructor(rig: PipelineRig, options: PipelineOptions = {}) {
    this.rig = rig
    this.random = options.random ?? Math.random
    this.idleDirector = new IdleDirector({ random: this.random })
    this.groundingRig = createGroundingRig(rig.restPositions)
    this.buildSpringConfigs()
    this.buildSpringStates()
    const initialPose = options.initialPose && BASE_POSES[options.initialPose] ? options.initialPose : 'stand'
    // 初始姿态立即生效（无过渡）；不锁 manualPoseId，之后跟随 B1 mood。
    this.manualPoseId = null
    this.poseMachine.setTarget(initialPose, degreesToQuats(BASE_POSES[initialPose]!), 0, true)
    this.poseMachine.update(0, initialPose, degreesToQuats(BASE_POSES[initialPose]!))
  }

  /** 当前基础姿态 id（调试面）。 */
  get poseId(): string {
    return this.poseMachine.poseId
  }

  /** 当前活动手势 id（调试面）。 */
  get gestureId(): string | null {
    return this.activeGesture?.def.id ?? null
  }

  /**
   * 调试强制姿态。返回 false = 未知姿态 id。
   * `setPose('auto')` 清除强制、回到跟随 mood。
   */
  setPose(poseId: string, fadeMs?: number): boolean {
    if (poseId === 'auto') {
      this.manualPoseId = null
      this.pendingFadeSec = fadeMs !== undefined ? fadeMs / 1000 : null
      return true
    }
    // 调试支持：`gesture:<id>` 直接播放一次待机/反应手势（dev 连拍验证轴向用）。
    if (poseId.startsWith('gesture:')) {
      const gestureId = poseId.slice('gesture:'.length)
      const def = findGesture(gestureId)
      if (!def) return false
      if (this.activeGesture?.def.id !== def.id) {
        this.startGesture(def, 'mood', this.lastNowMs, def.crouchPulse ?? 0)
      }
      return true
    }
    if (!BASE_POSES[poseId]) return false
    this.manualPoseId = poseId
    this.pendingFadeSec = fadeMs !== undefined ? Math.max(0, fadeMs) / 1000 : null
    // 调试切换时取消一次性手势，避免和强制姿态打架。
    this.activeGesture = null
    this.idleDirector.reset(this.timeSec)
    return true
  }

  /** 调试强制注视（度；NaN/Infinity 清除）。 */
  setGaze(yawDeg: number, pitchDeg: number): void {
    this.gaze.setForced(yawDeg, pitchDeg)
  }

  /** 当前注视（调试/单测）。 */
  get currentGaze(): GazeTarget {
    return this.gaze.gaze
  }

  /** 当前调试快照（最近一帧）。 */
  getDebugSnapshot(): AnimationDebugSnapshot {
    return this.lastDebug
  }

  /** 重置（模型重载/场景重建）。 */
  reset(): void {
    this.timeSec = 0
    this.lastNowMs = 0
    this.poseMachine.reset()
    this.activeGesture = null
    this.idleResetNeeded = true
    this.gaze.reset()
    this.blinkState = null
    this.visemeSteps = []
    this.visemeText = null
    this.currentCenterOffset = 0
    this.currentCenterRollDeg = 0
    this.currentCenterYawDeg = 0
    this.currentCenterX = 0
    this.centerSmoothPoseId = null
    this.weightShiftX = 0
    this.weightShiftTargetX = 0
    this.weightShiftFromX = 0
    this.weightShiftStartMs = 0
    this.weightShiftSwitchAtMs = 0
    this.weightShiftInitialized = false
    this.currentCenterQuat = { x: 0, y: 0, z: 0, w: 1 }
    this.prevParentWorldQuats.clear()
    this.buildSpringStates()
  }

  /* ------------------------------ 主更新 ------------------------------ */

  /**
   * 每帧更新。
   * @param input Lead 注入的动画输入（dt 已钳制 ≤0.1）
   * @param nowMs 注入时钟（毫秒；眨眼/手势计时；单测传假时钟）
   */
  update(input: AnimationInput, nowMs: number): AnimationFrameOutput {
    const dt = clamp(input.dt, 0, MAX_DT_SEC)
    this.timeSec += dt
    this.lastNowMs = nowMs
    if (this.blinkState === null) {
      this.blinkState = createBlinkState(nowMs, this.random)
    }

    /* 1) 事件/心情推进 */
    this.processEvents(input, nowMs)
    this.advanceGesture(dt)

    /* 2) 基础姿态 */
    const pxPerUnit = this.rig.modelHeight > 1e-6 ? input.petRect.height / this.rig.modelHeight : 0
    const poseId = resolveBasePoseId({
      mood: input.mood,
      dragging: input.dragging,
      airborne: input.motion.airborne,
      manualPoseId: this.manualPoseId
    })
    this.maybeStartIdleVariant(poseId, input, nowMs)
    const gaitOffsets = this.advanceProcedural(poseId, input, dt, pxPerUnit)
    const baseDegrees = addEulerDegrees(BASE_POSES[poseId] ?? BASE_POSES.stand!, gaitOffsets.poseDegrees)
    const baseTarget = degreesToQuats(baseDegrees)
    const fadeSec = this.pendingFadeSec ?? FADE_BY_POSE[poseId] ?? DEFAULT_POSE_FADE_SEC
    if (poseId !== this.poseMachine.poseId) {
      this.poseMachine.setTarget(poseId, baseTarget, fadeSec, true)
    }
    const basePose = this.poseMachine.update(dt, poseId, baseTarget)
    if (this.pendingFadeSec !== null) this.pendingFadeSec = null

    const meta = BASE_POSE_META[poseId] ?? BASE_POSE_META.stand!
    const groundedTarget = Boolean(meta.grounded) && !input.motion.airborne && !input.dragging
    const weightShift = this.advanceWeightShift(meta, groundedTarget, nowMs)

    /* 4) 手势 overlay 层 */
    const gestureResult = this.evaluateGesture()
    const gestureMask = gestureResult.gesture?.mask ? new Set(gestureResult.gesture.mask) : undefined

    /* 3) 连续微动 additive 层（呼吸/重心/头颈延迟/手臂 follow/手指；永不静止） */
    const hasGazeIntent =
      Boolean(input.lookTarget) || this.gaze.isForced || Boolean(gestureResult.gaze)
    const anticipation = this.advanceAnticipation(poseId, dt)
    const gestureFingerCurl = this.activeGesture
      ? (GESTURE_FINGER_CURL_BOOST[this.activeGesture.def.id] ?? 0)
      : 0
    const microPose = this.computeMicroPose(
      poseId,
      meta,
      hasGazeIntent,
      anticipation,
      weightShift,
      gestureFingerCurl
    )

    /* 5) look-at */
    const headCenter = {
      x: input.petRect.x + input.petRect.width / 2,
      y: input.petRect.y + input.petRect.height * 0.1
    }
    // 手势的强制视线（例如看手里的「硬币」）优先于鼠标，但低于 setGaze 调试强制。
    const gestureGaze = gestureResult.gaze
    const gazeResult = this.gaze.update({
      lookTarget: input.lookTarget,
      headCenter,
      depthPx: Math.max(60, input.petRect.height * 0.9),
      facing: input.facing ?? input.motion.facing ?? 'front',
      dt,
      nowMs,
      bodyYawRad: degToRad(this.currentCenterYawDeg || (meta.centerYawDeg ?? 0)),
      forced: gestureGaze
    })
    const lookPose = new Map<string, Quat>()
    if (gazeResult.active) {
      lookPose.set('首', eulerToQuat(gazeResult.distribution.neck))
      lookPose.set('頭', eulerToQuat(gazeResult.distribution.head))
    }

    /* 层顺序固定：基础 → 呼吸(additive) → 手势 overlay(mask) → look-at(additive) */
    const layers: PoseLayer[] = [
      { id: 'base', pose: basePose, weight: 1 },
      { id: 'breath', pose: microPose, weight: 1, additive: true },
      {
        id: 'overlay',
        pose: gestureResult.pose,
        weight: gestureResult.weight,
        mask: gestureMask,
        additive: false
      },
      { id: 'lookAt', pose: lookPose, weight: 1, additive: true }
    ]
    blendLayers(layers, this.blendedPose)

    /* 6) 接地（只覆盖腿 D 链） */
    const pelvisQuat = this.blendedPose.get('下半身') ?? { x: 0, y: 0, z: 0, w: 1 }
    const grounded = groundedTarget
    const targetCenter = grounded
      ? -(meta.crouch ?? 0) - gaitOffsets.crouch
      : (meta.centerY ?? 0)
    // センター 的 3/4 侧身（Y）与睡姿翻滚（Z）先在接地前定好（髋位置/脚尖朝向都依赖它）。
    const targetYaw = meta.centerYawDeg ?? 0
    const targetRoll = meta.centerRollDeg ?? 0
    this.currentCenterYawDeg = damp(this.currentCenterYawDeg, targetYaw, dt, CENTER_YAW_TAU_SEC)
    this.currentCenterRollDeg = damp(this.currentCenterRollDeg, targetRoll, dt, CENTER_ROLL_TAU_SEC)
    const centerQuaternion = eulerToQuat({
      x: 0,
      y: degToRad(this.currentCenterYawDeg),
      z: degToRad(this.currentCenterRollDeg)
    })
    this.currentCenterQuat = centerQuaternion

    if (this.centerSmoothPoseId !== poseId) {
      this.centerFrom = this.currentCenterOffset
      this.centerXFrom = this.currentCenterX
      this.centerSmoothPoseId = poseId
    }
    const centerProgress = smoothstep(this.poseMachine.progress)
    const centerBase = this.centerFrom + (targetCenter - this.centerFrom) * centerProgress
    // 横向重心 = 姿态基准 + 慢层承重脚（非接地姿态不换重心）
    const targetCenterX = (meta.centerX ?? 0) + (grounded ? weightShift.x : 0)
    const centerXBase = this.centerXFrom + (targetCenterX - this.centerXFrom) * centerProgress
    let footErrorPx: number | null = null
    let centerOffset = centerBase
    let centerXOffset = centerXBase
    if (grounded && this.groundingRig) {
      const pulse = gestureResult.crouchPulse + anticipation * 0.06
      const grounding = solveGrounding({
        rig: this.groundingRig,
        pelvisQuat,
        centerYOffset: centerBase,
        centerXOffset: centerXBase,
        centerQuat: centerQuaternion,
        crouchPulse: pulse,
        bodyYawDeg: this.currentCenterYawDeg,
        // 脚默认朝镜头（人站着时脚尖朝前，即使上身 3/4 侧转）
        footYawBaseDeg: 0,
        leftFoot: mergeFoot(meta.foot?.left, gaitOffsets.feet.left),
        rightFoot: mergeFoot(meta.foot?.right, gaitOffsets.feet.right),
        pxPerUnit
      })
      for (const [bone, quat] of grounding.rotations) this.blendedPose.set(bone, quat)
      centerOffset = grounding.centerYOffset
      centerXOffset = grounding.centerXOffset
      footErrorPx = grounding.footErrorPx
    }
    this.currentCenterOffset = centerOffset
    this.currentCenterX = centerXOffset
    this.lastFootErrorPx = footErrorPx

    /* 7) 发辫弹簧（最后写，只写四元数） */
    this.stepSprings(dt)

    /* 8) 表情调度 */
    const emotionEntries: EmotionEntry[] = [
      {
        emotion: ((this.activeGesture ? gestureResult.emotion : null) ?? 'neutral') as EmotionEntry['emotion'],
        weight: this.activeGesture ? gestureResult.emotionWeight : 0,
        priority: PRIORITY_GESTURE_EMOTION
      },
      {
        emotion: (meta.baseEmotion as EmotionEntry['emotion']) ?? 'neutral',
        weight: 1,
        priority: PRIORITY_BASE_EMOTION
      }
    ]
    const speaking = Boolean(input.bubbleText && input.bubbleText.trim().length > 0)
    const baseMorphs = mixEmotions(emotionEntries, { speaking })
    const laughing = laughingEyeWeightOf(baseMorphs) > 0.35
    const blink = stepBlink(this.blinkState!, nowMs, this.random, laughing)
    this.blinkState = blink.state
    if (blink.weight > 0) {
      const extra = new Map<string, number>()
      extra.set(blink.morph, blink.weight)
      mergeMorphsMax(baseMorphs, extra)
    }
    // 口型（气泡文本变化时重建序列）。
    this.updateVisemes(input.bubbleText, nowMs)
    if (this.visemeSteps.length > 0) {
      const viseme = stepViseme(this.visemeSteps, nowMs - this.visemeStartMs)
      this.lastVisemeWeight = viseme.weight
      if (viseme.viseme && viseme.weight > 0.001) {
        const extra = new Map<string, number>()
        extra.set(visemeMorph(viseme.viseme), viseme.weight)
        mergeMorphsMax(baseMorphs, extra)
      }
    } else {
      this.lastVisemeWeight = 0
    }
    // 眼球 look-at（覆盖式；没有注视时归零 —— 由 scene-bridge 的「全量写」保证）。
    const eyeQuat = eulerToQuat(gazeResult.distribution.eye)
    this.blendedPose.set(EYE_BONE_LEFT, eyeQuat)
    this.blendedPose.set(EYE_BONE_RIGHT, eyeQuat)

    /* 9) 调试快照 */
    this.lastDebug = this.buildDebugSnapshot({
      poseId,
      gestureResult,
      blinkWeight: blink.active ? blink.weight : 0,
      morphs: baseMorphs,
      lookYaw: gazeResult.lookYaw,
      gaze: gazeResult.active ? gazeResult.gaze : null,
      footErrorPx
    })

    return {
      boneQuaternions: this.blendedPose,
      centerOffsetY: centerOffset,
      centerOffsetX: centerXOffset,
      centerQuaternion,
      morphWeights: baseMorphs,
      debug: this.lastDebug
    }
  }

  /* ------------------------------ 内部：事件 ------------------------------ */

  private processEvents(input: AnimationInput, nowMs: number): void {
    const reaction = pickReaction(input.events)
    const dragStarted = input.dragging && !this.wasDragging
    const dragEnded = !input.dragging && this.wasDragging
    this.wasDragging = input.dragging

    // 落地事件：反应优先级高于待机变体，直接开。
    if (reaction) {
      const def = findGesture(reaction.gestureId)
      if (def) {
        let pulse = def.crouchPulse ?? 0
        if (reaction.event?.kind === 'landed') {
          pulse = clamp(0.25 + reaction.event.impactSpeed / 6000, 0.25, 1.0)
        }
        this.startGesture(def, 'reaction', nowMs, pulse)
        this.idleDirector.notifyInterrupted(this.timeSec)
      }
    } else {
      const transitionGestureId = moodTransitionGesture(input.mood, this.previousMood)
      if (transitionGestureId && !this.activeGesture) {
        const def = findGesture(transitionGestureId)
        if (def) this.startGesture(def, 'mood', nowMs, def.crouchPulse ?? 0)
      }
    }

    if (dragStarted) {
      // 拖拽打断待机变体（不打断反应）。
      if (this.activeGesture?.kind === 'idle') {
        this.activeGesture = null
        this.idleDirector.notifyInterrupted(this.timeSec)
      }
    }
    if (dragEnded) {
      this.idleDirector.notifyInterrupted(this.timeSec)
    }
    // 从空中回到地面：若没有 landed 事件，也给一个短的反应（防御性）。
    if (this.wasAirborne && !input.motion.airborne && !reaction) {
      const def = findGesture('landed')
      if (def) this.startGesture(def, 'reaction', nowMs, 0.35)
    }
    this.wasAirborne = input.motion.airborne
    this.previousMood = input.mood
  }

  private startGesture(
    def: GestureDef,
    kind: ActiveGesture['kind'],
    nowMs: number,
    pulse = 0
  ): void {
    this.activeGesture = { def, kind, startMs: nowMs, elapsed: 0, pulse }
    // 反应开始时取消同类的待机变体（reaction 优先）。
    if (kind === 'reaction' && this.activeGesture.def.reaction) {
      this.idleDirector.notifyInterrupted(this.timeSec)
    }
  }

  private advanceGesture(dt: number): void {
    if (!this.activeGesture) return
    const gesture = this.activeGesture
    gesture.elapsed += dt
    if (gesture.elapsed >= gesture.def.duration) {
      this.activeGesture = null
    }
  }

  /** 待机变体调度：仅 mood=idle + 站姿 + 无手势/交互时随机播放（4–6 个变体轮换）。 */
  private maybeStartIdleVariant(poseId: string, input: AnimationInput, nowMs: number): void {
    const allowed =
      poseId === 'stand' &&
      this.manualPoseId === null &&
      !input.dragging &&
      !input.motion.airborne &&
      this.activeGesture === null &&
      input.mood === 'idle'
    if (this.idleResetNeeded) {
      this.idleDirector.reset(this.timeSec)
      this.idleResetNeeded = false
    }
    const variantId = this.idleDirector.update(this.timeSec, allowed)
    if (!variantId) return
    const def = findGesture(variantId)
    if (def) this.startGesture(def, 'idle', nowMs, 0)
  }

  /** 采样当前手势（姿态/权重包络/表情/视线/重心脉冲）。 */
  private evaluateGesture(): {
    gesture: GestureDef | null
    pose: PoseQuats
    weight: number
    emotion: string | null
    emotionWeight: number
    gaze: { yawDeg: number; pitchDeg: number } | null
    crouchPulse: number
  } {
    const active = this.activeGesture
    if (!active) {
      return {
        gesture: null,
        pose: EMPTY_QUATS,
        weight: 0,
        emotion: null,
        emotionWeight: 0,
        gaze: null,
        crouchPulse: 0
      }
    }
    const def = active.def
    const elapsed = clamp(active.elapsed, 0, def.duration)
    const fadeIn = def.fadeIn ?? 0.12
    const fadeOut = def.fadeOut ?? 0.2
    const fadeInWeight = fadeIn <= 0 ? 1 : smoothstep(elapsed / fadeIn)
    const fadeOutWeight = fadeOut <= 0 ? 1 : smoothstep((def.duration - elapsed) / fadeOut)
    const weight = Math.min(fadeInWeight, fadeOutWeight)
    const pose = sampleGesture(def, elapsed)
    const emotion = gestureEmotionAt(def, elapsed)
    // 只有手势真正开始后才把表情推出来（避免一触发就变脸）。
    const emotionWeight = smoothstep(elapsed / Math.max(0.01, fadeIn)) * weight
    // 重心脉冲：落地冲击线性衰减。
    const pulseProgress = def.duration > 0 ? clamp(1 - elapsed / def.duration, 0, 1) : 0
    const crouchPulse = active.pulse * Math.pow(pulseProgress, 1.5)
    return {
      gesture: def,
      pose,
      weight,
      emotion,
      emotionWeight,
      gaze: gestureGazeAt(def, elapsed),
      crouchPulse
    }
  }

  /* ------------------------------ 内部：步态 ------------------------------ */

  private advanceProcedural(
    poseId: string,
    input: AnimationInput,
    dt: number,
    pxPerUnit: number
  ): { poseDegrees: Record<string, { x?: number; y?: number; z?: number }>; feet: { left: { forward?: number; lift?: number; yawDeg?: number }; right: { forward?: number; lift?: number; yawDeg?: number } }; crouch: number } {
    const speed = Math.hypot(input.motion.velocity.x, input.motion.velocity.y)
    if (poseId === 'walk') {
      advanceGait(this.gait, dt, speed, pxPerUnit, 'walk')
      return computeWalkOffsets(this.gait.walkPhase, this.gait.walkStride)
    }
    if (poseId === 'climb') {
      advanceGait(this.gait, dt, speed, pxPerUnit, 'climb')
      return computeClimbOffsets(this.gait.climbPhase)
    }
    if (poseId === 'sitEdge') {
      return {
        poseDegrees: computeSitEdgeOffsets(this.timeSec),
        feet: { left: {}, right: {} },
        crouch: 0
      }
    }
    return { poseDegrees: {}, feet: { left: {}, right: {} }, crouch: 0 }
  }

  /* ------------------------------ 内部：呼吸 ------------------------------ */

  /**
   * 慢层「承重脚换重心」：站/坐等安静姿态每 8–15s 随机换一次重心（1.1s smoothstep 过渡）。
   * 返回当前横向重心偏移（模型单位，正 = 角色左侧）。
   */
  private advanceWeightShift(
    meta: { grounded?: boolean; centerX?: number },
    grounded: boolean,
    nowMs: number
  ): { x: number } {
    const allowed = grounded && this.poseMachine.poseId !== 'climb'
    if (!allowed) {
      this.weightShiftX = 0
      this.weightShiftInitialized = false
      return { x: 0 }
    }
    if (!this.weightShiftInitialized) {
      this.weightShiftInitialized = true
      // 初始就压向 stand 的承重侧（+），避免开局重心在中间像「坐空气」；之后随机换脚。
      this.weightShiftTargetX = 1.3 + this.random() * 0.5
      this.weightShiftFromX = this.weightShiftTargetX
      this.weightShiftX = this.weightShiftTargetX
      this.weightShiftStartMs = nowMs - WEIGHT_SHIFT_RAMP_MS
      this.weightShiftSwitchAtMs = nowMs + 6000 + this.random() * 4000
    }
    if (nowMs >= this.weightShiftSwitchAtMs) {
      this.weightShiftFromX = this.weightShiftX
      this.weightShiftTargetX = (this.random() < 0.5 ? -1 : 1) * (1.2 + this.random() * 0.7)
      this.weightShiftStartMs = nowMs
      this.weightShiftSwitchAtMs = nowMs + WEIGHT_SHIFT_MIN_MS + this.random() * WEIGHT_SHIFT_RANGE_MS
    }
    const t = clamp((nowMs - this.weightShiftStartMs) / WEIGHT_SHIFT_RAMP_MS, 0, 1)
    this.weightShiftX =
      this.weightShiftFromX + (this.weightShiftTargetX - this.weightShiftFromX) * smoothstep(t)
    // 不同姿态的慢层幅度：站姿最大；走路/坐类减小，避免和步态/贴地打架。
    const scaleByPose: Record<string, number> = {
      stand: 1,
      walk: 0.35,
      pat: 0.6,
      busy: 0.6,
      sad: 0.5,
      celebrate: 0.4
    }
    const scale = scaleByPose[this.poseMachine.poseId] ?? 0.5
    void meta
    return { x: this.weightShiftX * scale }
  }

  /**
   * 姿态切换的预备动作包络（0..1）：切换后 0.14s 内先反向蓄力。
   * 返回 sin(π·进度)：开始/结束为 0、中段最大，连续无跳变。
   */
  private advanceAnticipation(poseId: string, dt: number): number {
    if (poseId !== this.lastPoseIdForAnticipation) {
      this.lastPoseIdForAnticipation = poseId
      this.anticipationRemaining = this.anticipationTotal
    }
    if (this.anticipationRemaining <= 0) return 0
    this.anticipationRemaining = Math.max(0, this.anticipationRemaining - dt)
    const progress = 1 - this.anticipationRemaining / Math.max(1e-6, this.anticipationTotal)
    return Math.sin(Math.PI * clamp(progress, 0, 1))
  }

  /**
   * 连续微动 additive 层（v2「活人感」核心）：
   * 呼吸 + 重心摆动 + 头/颈延迟跟随 + 手臂/手腕 follow-through + 手指收放；
   * 无外部注视时再叠一层极慢的头漂移（人不会一直盯正前方）。
   */
  private computeMicroPose(
    poseId: string,
    meta: { breathScale?: number; breathRate?: number },
    hasGazeIntent: boolean,
    anticipation = 0,
    weightShift: { x: number } = { x: 0 },
    fingerCurlExtraDeg = 0
  ): PoseQuats {
    const baseScale: MicroMotionScale = microScaleFor(poseId)
    const breathScale = clamp(meta.breathScale ?? 1, 0, 1.5)
    const rate = clamp(meta.breathRate ?? 1, 0.3, 1.8)
    const scale: MicroMotionScale = {
      breath: baseScale.breath * breathScale,
      sway: baseScale.sway,
      headLag: baseScale.headLag * (hasGazeIntent ? 0.55 : 1),
      arm: baseScale.arm,
      finger: baseScale.finger
    }
    const timeSec = this.timeSec * rate
    const degrees = computeMicroMotion(timeSec, scale, {
      weightShift: clamp(weightShift.x / 1.8, -1.2, 1.2),
      fingerCurlExtraDeg
    })
    if (anticipation > 0.001) {
      // 预备动作：切姿态瞬间身体先反向「蓄一下」（胸腔后收、下巴微收），再被目标姿态带走。
      const env = anticipation
      const upper = degrees['上半身'] ?? {}
      degrees['上半身'] = { x: (upper.x ?? 0) - 1.8 * env, y: upper.y ?? 0, z: upper.z ?? 0 }
      const head = degrees['頭'] ?? {}
      degrees['頭'] = { x: (head.x ?? 0) + 1.1 * env, y: head.y ?? 0, z: head.z ?? 0 }
    }
    if (!hasGazeIntent) {
      const drift = computeIdleHeadDrift(timeSec, 1)
      for (const bone of Object.keys(drift)) {
        const current = degrees[bone] ?? {}
        const extra = drift[bone] ?? {}
        degrees[bone] = {
          x: (current.x ?? 0) + (extra.x ?? 0),
          y: (current.y ?? 0) + (extra.y ?? 0),
          z: (current.z ?? 0) + (extra.z ?? 0)
        }
      }
    }
    return degreesToQuats(degrees)
  }

  /* ------------------------------ 内部：弹簧 ------------------------------ */

  private buildSpringConfigs(): void {
    this.springConfigs.length = 0
    for (const chain of SPRING_CHAINS) {
      const restPositions = this.rig.restPositions
      const missing = chain.joints.some((joint) => !restPositions[joint])
      if (missing) continue
      const restDirs = computeRestDirections(chain.joints, restPositions, chain.rootParent)
      this.springConfigs.push({
        id: chain.id,
        rootParent: chain.rootParent,
        joints: chain.joints.map((bone, index) => ({ bone, restDir: restDirs[index]! })),
        ...DEFAULT_SPRING_PARAMS,
        ...(chain.params ?? {})
      })
    }
  }

  private buildSpringStates(): void {
    this.springStates = this.springConfigs.map((config) => createSpringChainState(config))
  }

  private stepSprings(dt: number): void {
    if (this.springConfigs.length === 0) return
    this.lastSpringAngles = {}
    for (const config of this.springConfigs) {
      const state = this.springStates.find((item) => item.id === config.id)
      if (!state) continue
      // 链根父骨的世界四元数（沿骨架父子链把可控骨的局部旋转全部累乘）。
      const rootParentWorld = this.computeWorldQuat(config.rootParent)
      // 父骨角速度：用世界四元数差分估计（头/手臂一动，发辫/袖子被甩起来）。
      const previous = this.prevParentWorldQuats.get(config.rootParent)
      let rootOmega: Vec3 = { x: 0, y: 0, z: 0 }
      if (previous && dt > 1e-6) {
        const delta = multiplyQuat(rootParentWorld, conjugateQuat(previous))
        const rv = quatToRotationVector(delta)
        rootOmega = {
          x: clamp(rv.x / dt, -20, 20),
          y: clamp(rv.y / dt, -20, 20),
          z: clamp(rv.z / dt, -20, 20)
        }
      }
      this.prevParentWorldQuats.set(config.rootParent, rootParentWorld)
      const result = stepSpringChain(state, config, {
        dt,
        rootParentWorld,
        rootParentAngularVelocity: rootOmega
      })
      const stateIndex = this.springStates.findIndex((item) => item.id === config.id)
      if (stateIndex >= 0) this.springStates[stateIndex] = result.state
      for (let index = 0; index < config.joints.length; index += 1) {
        const bone = config.joints[index]!.bone
        this.blendedPose.set(bone, result.localQuats[index]!)
        const rv = quatToRotationVector(result.localQuats[index]!)
        this.lastSpringAngles[bone] =
          Math.round(Math.hypot(rv.x, rv.y, rv.z) * (180 / Math.PI) * 10) / 10
      }
    }
  }

  /**
   * 由最终姿态四元数链式累加某骨的模型空间世界四元数。
   * 模型所有骨的 rest 局部旋转都是恒等（PMX 无 rest rotation），所以世界旋转 =
   * 祖先链上「B3 写过的骨」的局部四元数依次乘积；未写过的骨（肩C/腕捩/腰等）恒等跳过。
   */
  private computeWorldQuat(boneName: string): Quat {
    const chain = this.ancestorChain(boneName)
    let world: Quat = this.currentCenterQuat
    for (const name of chain) {
      world = multiplyQuat(world, this.blendedPose.get(name) ?? { x: 0, y: 0, z: 0, w: 1 })
    }
    return normalizeQuat(world)
  }

  /** 骨名 → 祖先链（含自身；根到叶）。优先用 rig.boneParents，缺省用内置 fallback。 */
  private ancestorChain(boneName: string): readonly string[] {
    const parents = this.rig.boneParents
    if (parents) {
      const path: string[] = []
      let current: string | null | undefined = boneName
      for (let guard = 0; guard < 64 && current; guard += 1) {
        path.unshift(current)
        current = parents[current] ?? null
      }
      return path
    }
    return FALLBACK_ANCESTORS[boneName] ?? [boneName]
  }

  /* ------------------------------ 内部：口型/口型序列 ------------------------------ */

  private updateVisemes(bubbleText: string | null, nowMs: number): void {
    const text = bubbleText && bubbleText.trim().length > 0 ? bubbleText : null
    if (text === this.visemeText) return
    this.visemeText = text
    if (!text) {
      this.visemeSteps = []
      this.lastVisemeWeight = 0
      return
    }
    this.visemeSteps = textToVisemes(text)
    this.visemeStartMs = nowMs
    // 文本过长时截断（避免气泡显示时口型还在动很久；单条气泡 ≤ 100 字）。
    const duration = visemeSequenceDurationMs(this.visemeSteps)
    if (duration > 12_000) {
      this.visemeSteps = this.visemeSteps.slice(0, Math.max(1, Math.floor(this.visemeSteps.length / 2)))
    }
  }

  /* ------------------------------ 内部：调试快照 ------------------------------ */

  private buildDebugSnapshot(context: {
    poseId: string
    gestureResult: {
      gesture: GestureDef | null
      weight: number
    }
    blinkWeight: number
    morphs: Map<string, number>
    lookYaw: number | null
    gaze: GazeTarget | null
    footErrorPx: number | null
  }): AnimationDebugSnapshot {
    const transitioning = this.poseMachine.progress < 1
    const hasGesture = context.gestureResult.weight > 0.01
    const hasGaze = context.lookYaw !== null
    const activeLayers = 1 + (transitioning ? 1 : 0) + (hasGesture ? 1 : 0) + (hasGaze ? 1 : 0)
    const snapshot: AnimationDebugSnapshot = {
      pose: this.poseMachine.poseId,
      poseWeight: Math.round(this.poseMachine.progress * 1000) / 1000,
      activeLayers,
      gesture: context.gestureResult.gesture?.id ?? null,
      blink: Math.round(context.blinkWeight * 1000) / 1000,
      smile: Math.round(smileWeightOf(context.morphs) * 1000) / 1000,
      mouthOpen: Math.round(Math.max(mouthOpenOf(context.morphs), this.lastVisemeWeight) * 1000) / 1000,
      lookYaw: context.lookYaw === null ? null : Math.round(context.lookYaw * 1000) / 1000,
      missingBones: [...this.rig.missingBones],
      morphs: nonZeroMorphs(context.morphs),
      gaze: context.gaze ? { yaw: context.gaze.yaw, pitch: context.gaze.pitch } : null,
      footErrorPx: this.lastFootErrorPx,
      spring: { ...this.lastSpringAngles }
    }
    return snapshot
  }
}

/** 无 boneParents 时的祖先链 fallback（单测夹具/最小 rig）。 */
const FALLBACK_ANCESTORS: Readonly<Record<string, readonly string[]>> = {
  頭: ['上半身', '上半身2', '首', '頭'],
  首: ['上半身', '上半身2', '首'],
  左肩: ['上半身', '上半身2', '左肩'],
  右肩: ['上半身', '上半身2', '右肩'],
  左腕: ['上半身', '上半身2', '左肩', '左腕'],
  右腕: ['上半身', '上半身2', '右肩', '右腕'],
  左ひじ: ['上半身', '上半身2', '左肩', '左腕', '左ひじ'],
  右ひじ: ['上半身', '上半身2', '右肩', '右腕', '右ひじ'],
  左手首: ['上半身', '上半身2', '左肩', '左腕', '左ひじ', '左手首'],
  右手首: ['上半身', '上半身2', '右肩', '右腕', '右ひじ', '右手首']
}

/**
 * 姿态过渡的逐骨延迟（秒；v2 生动性）：
 * 骨盆/腿先动 → 躯干 → 肩 → 大臂/前臂 → 手/手指，形成「身体带动手臂」的错峰感，
 * 而不是所有骨同时到位（用户反馈的「木偶/僵尸」感主要来自同步到达）。
 */
const POSE_STAGGER = (bone: string): number => {
  if (bone === '下半身' || bone.includes('足') || bone.includes('ひざ')) return 0
  if (bone === '上半身' || bone === '上半身2') return 0.02
  if (bone === '左肩' || bone === '右肩') return 0.035
  if (bone === '左腕' || bone === '右腕') return 0.05
  if (bone === '左ひじ' || bone === '右ひじ') return 0.065
  if (bone === '首') return 0.055
  if (bone === '頭') return 0.075
  return 0.08
}

/** 空姿态（no-op 手势用；避免每帧 new Map）。 */
const EMPTY_QUATS: PoseQuats = new Map()

/** 合并姿态 meta 的脚目标与步态脚目标（forward/lift/yaw 相加）。 */
function mergeFoot(
  metaFoot: { forward?: number; lift?: number; yawDeg?: number; spread?: number; pitchDeg?: number } | undefined,
  gaitFoot: { forward?: number; lift?: number; yawDeg?: number; spread?: number; pitchDeg?: number } | undefined
): { forward?: number; lift?: number; yawDeg?: number; spread?: number; pitchDeg?: number } {
  return {
    forward: (metaFoot?.forward ?? 0) + (gaitFoot?.forward ?? 0),
    lift: (metaFoot?.lift ?? 0) + (gaitFoot?.lift ?? 0),
    yawDeg: (metaFoot?.yawDeg ?? 0) + (gaitFoot?.yawDeg ?? 0),
    spread: (metaFoot?.spread ?? 0) + (gaitFoot?.spread ?? 0),
    pitchDeg: (metaFoot?.pitchDeg ?? 0) + (gaitFoot?.pitchDeg ?? 0)
  }
}

/** 供 scene-bridge 复用的姿态 id 列表（合法 setPose 集合）。 */
export const ANIMATION_POSE_IDS: readonly string[] = BASE_POSE_IDS

/** 事件类型（scene-bridge/测试用）。 */
export type { AnimationEvent }
