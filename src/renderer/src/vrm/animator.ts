/**
 * VRM 动画组合层 —— 把 `VrmClipPlayer`（humanoid clip）+ 表情层（V6）+ look-at 层（V6）
 * 组合成 `PoseDriver`（`VrmPetScene` 每帧调用）。
 *
 * 关键顺序（three-vrm 3.x；见 `docs/wave2-vrm-runtime-design.md` §2.2/§4.4）：
 * ```
 * clip-player.update()      // 写 normalized humanoid 骨（含 Hips.p）+ 贴地 + humanoid.update()
 * expression-layer.update() // expressionManager.setValue（在 vrm.update 前）
 * look-at.update()          // 头/眼 additive（在 humanoid.update 前）
 * humanoid.update()         // look-at 改过骨后同步 raw 骨
 * vrm.update(dt)            // spring bone / 表情材质 / 内建 lookAt（真实 dt，≤0.1s）
 * ```
 *
 * 红线：本层只写 normalized humanoid 骨 / expression 通道，不改 `root`（摆放/缩放/朝向归场景）。
 * 所有子层初始化/更新失败都降级为 warn（不抛），保证 app 不因动画数据缺失而黑屏。
 */
import { isAnimationClipMood } from '@shared/animation-contract'
import type { PetMood } from '@shared/types'

import type { AnimationDebugSnapshot, AnimationInput } from '../core/wave2-contract'
import { VrmFootLock } from './foot-lock'
import { VrmMicroMotion } from './micro-motion'
import type {
  CreateVrmPetAnimatorOptions,
  VrmClipPlayer,
  VrmExpressionDebugSnapshot,
  VrmFootLockDebugSnapshot,
  VrmPetAnimator
} from './runtime-types'

/** 单帧 dt 上限（与场景层一致；睡眠/遮挡恢复后的首帧可能极大）。 */
const MAX_FRAME_DELTA_SEC = 0.1

/** 注视角 → 调试面 lookYaw（-1..1）的归一化基准（与 manifest `maxYawDeg` 默认 35° 对齐）。 */
const LOOK_YAW_REFERENCE_DEG = 35

/** 姿态 id 别名 → 动作槽位（调试 `debugSetPose('stand')` / 冒烟脚本兼容）。 */
const POSE_ALIASES: Readonly<Record<string, PetMood>> = {
  stand: 'idle',
  idle: 'idle',
  walk: 'walk',
  run: 'walk',
  sit: 'sit',
  sitEdge: 'sit',
  sleep: 'sleep',
  pat: 'pat',
  pokedHead: 'pat',
  drag: 'drag',
  grabbed: 'drag',
  fall: 'fall',
  land: 'fall',
  climb: 'walk',
  celebrate: 'dshDone',
  sad: 'dshError',
  busy: 'dshBusy'
}

/** 记录一次子层失败（只 warn，不抛）。 */
function warnOnce(scope: string, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error)
  console.warn(`[vrm-animator] ${scope} 失败，已降级：${message}`)
}

/** 把角度差归一化到 [-180,180]。 */
function normalizeDeg(deg: number): number {
  if (!Number.isFinite(deg)) return 0
  let value = deg % 360
  if (value > 180) value -= 360
  if (value < -180) value += 360
  return value
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

function emptyExpressionSnapshot(): VrmExpressionDebugSnapshot {
  return {
    ready: false,
    blink: 0,
    smile: 0,
    mouthOpen: 0,
    trigger: null,
    clipId: null,
    weights: {}
  }
}

/**
 * 创建 VRM 宠物动画驱动（`PoseDriver` 实现）。
 *
 * `ready` Promise 在 clip/表情 manifest 初始化后 resolve（失败也 resolve，内部降级）；
 * 场景层可 `await` 它再宣告模型就绪，冒烟/验收也可据此断言 clip 已可用。
 */
export function createVrmPetAnimator(
  options: CreateVrmPetAnimatorOptions
): VrmPetAnimator & { setMoodOverride(mood: PetMood | null): void } {
  const { avatar, clipPlayer, expressionLayer, lookAtLayer, handProp, resolveHandPropClipMeta } = options
  const clipsEnabled = options.clipsEnabled !== false
  const vrm = avatar.vrm
  const humanoid = vrm.humanoid

  let disposed = false
  /** clip 播放器是否已成功初始化（look-at additive 依赖 clip 每帧重写骨骼，未就绪时禁用）。 */
  let clipsReady = false
  let lastClipId: string | null = null
  /** 最近一帧完整输入（调试快照用）。 */
  let lastInput: AnimationInput | null = null
  /** 调试覆盖的 mood（`debugSetPose` 槽位/`setMoodOverride`；null = 正常）。 */
  let moodOverride: PetMood | null = null
  /** 注入时钟（入场序列计时；默认 performance.now）。 */
  const now = options.now ?? ((): number => (typeof performance === 'undefined' ? Date.now() : performance.now()))
  const transitionClips = options.moodTransitionClips ?? {}
  const introSequence = options.introSequence
  const footLock = options.footLock === false ? null : new VrmFootLock(avatar)
  /**
   * 待机程序化微动层（2026-11-10 用户反馈「待机看起来脚固定、腰也不动」）：
   * 只对「基础选片 = idle」启用；在 foot-lock IK 之前叠加呼吸/重心/头部微动，
   * 脚仍由 IK 钉在锚点，腰/躯干自然摆动。`options.microMotion === false` 可整体关闭。
   */
  const microMotion =
    options.microMotion === false || footLock === null
      ? null
      : new VrmMicroMotion(
          avatar,
          typeof options.microMotion === 'object' ? options.microMotion : undefined
        )
  const randomSource = typeof options.random === 'function' ? options.random : Math.random
  const randomSafely = (): number => {
    try {
      const value = randomSource()
      return Number.isFinite(value) ? value : Math.random()
    } catch {
      return Math.random()
    }
  }
  /** 解析 mood 过渡 clip：字符串直接返回；数组等概率随机取一条（空/非法 → null）。 */
  const pickTransitionClip = (clip: string | readonly string[] | undefined): string | null => {
    if (typeof clip === 'string') return clip.length > 0 ? clip : null
    if (!Array.isArray(clip)) return null
    const candidates = clip.filter((id): id is string => typeof id === 'string' && id.length > 0)
    if (candidates.length === 0) return null
    const index = Math.floor(clamp(randomSafely(), 0, 0.999) * candidates.length)
    return candidates[index] ?? candidates[0]
  }
  /**
   * 坐窗口风格（main.ts 注入；null = 非坐姿）：
   * - `sit`：标准坐姿（manifest sit 槽，sit1，臀部贴沿锚点）；
   * - `sitVariant`：窗沿坐姿变体（windowLay8/9/10，**同样用臀部贴沿锚点**，腿垂下）；
   * - `lie`：真躺（mate-sitWindow，平面锚点 + 可选下移）。
   */
  type SitWindowStyleMode = 'sit' | 'sitVariant' | 'lie'
  let sitWindowStyle: SitWindowStyleMode | null = null
  /** 当前为 lie 风格而手动播放的窗沿坐/躺 clip id（null = 未启用）。 */
  let sitLieClipId: string | null = null
  /** lie 素材覆盖（main.ts 选择真躺 `mate-sitWindow`；null = 在窗沿坐姿变体里随机）。 */
  let sitLieClipOverride: string | null = null
  /** lie 模式额外下移（px，正=向下；躺姿差几像素就出屏时保证头可见）。 */
  let sitLieSinkPx = 0
  /** 真躺候选（mate-sitWindow：源 BETA_PET_WINDOW_LAY，仰躺翘腿）。 */
  const sitLieClipCandidates = ['mate-sitWindow'] as const
  /** 窗沿坐姿变体候选（windowLay8/9/10；原始素材标注为“窗沿坐姿变体”）。 */
  const sitVariantClipCandidates = ['mate-windowLay8', 'mate-windowLay9', 'mate-windowLay10'] as const
  /** 入场序列状态（app 启动后播一次；被交互/调试/SMOKE 打断后不再重播）。 */
  let introActive = false
  let introFinished = false
  let introStepIndex = 0
  let introStepStartedAtMs = 0
  /** 上一帧生效 mood（进出场过渡 clip 用）。 */
  let lastMood: PetMood | null = null
  /**
   * 空中被推迟的 mood 过场 clip（dshError 进入 breaked / 离开 revive 这类**地面接触语义**的
   * 一次性过场）。腾空瞬间直接播会在半空跪伏/蜷缩；先记下，落地后补播一次。
   * 新的 mood 变化会覆盖旧值（避免落地后补播已经过期的过场）。
   */
  let pendingGroundedTransitionClip: {
    clipId: string
    hold: boolean
    fadeSec: number
  } | null = null
  /** 最近一帧 clip 快照（坐姿锚点/步幅校准用；getDebugSnapshot 复用）。 */
  let lastClipSnapshot: ReturnType<VrmClipPlayer['snapshot']> | null = null
  /**
   * 视觉竖直偏移（CSS px；正 = 视觉向上）。用于「sit 时 hips 贴窗沿」：
   * 当前实现把模型整体下移姿态中 hips 高出最低点的高度，让臀部落在窗沿、腿自然垂下。
   */
  let visualOffsetPx = 0

  const ready = (async (): Promise<void> => {
    if (clipsEnabled && clipPlayer) {
      try {
        await clipPlayer.init()
        clipsReady = clipPlayer.ready
      } catch (error) {
        clipsReady = false
        warnOnce('clip-player.init', error)
      }
    }
    if (expressionLayer) {
      try {
        await expressionLayer.init()
      } catch (error) {
        warnOnce('expression-layer.init', error)
      }
    }
  })()

  /** 取消入场序列（交互/调试/拖拽打断；不再重播）。 */
  const cancelIntro = (): void => {
    if (!introActive && introFinished) return
    introActive = false
    introFinished = true
    try {
      clipPlayer?.stopManualClip?.(0.2)
    } catch (error) {
      warnOnce('clip-player.stopManualClip', error)
    }
  }

  /** 播放一条 catalog/manifest clip（一次性/循环）；打断入场序列。 */
  const playOneShotClip: VrmPetAnimator['playOneShotClip'] = (id, playOptions = {}) => {
    if (disposed || !clipsEnabled || !clipPlayer || typeof id !== 'string' || id.length === 0) {
      return false
    }
    try {
      const ok = clipPlayer.playClipById(id, playOptions)
      if (ok) cancelIntro()
      return ok
    } catch (error) {
      warnOnce('clip-player.playOneShotClip', error)
      return false
    }
  }

  /** 播放入场序列第 index 步（catalog clip；loop 步骤由下一步替换）。 */
  const playIntroStep = (index: number, startedAtMs: number): void => {
    if (!introSequence || !clipPlayer) {
      introActive = false
      introFinished = true
      return
    }
    const step = introSequence.steps[index]
    if (!step) {
      introActive = false
      introFinished = true
      return
    }
    const ok = (() => {
      try {
        return clipPlayer.playClipById(step.clipId, { loop: step.loop === true, fadeSec: 0.3 })
      } catch (error) {
        warnOnce('clip-player.playIntroStep', error)
        return false
      }
    })()
    if (!ok) {
      // clip 未知/未就绪：跳过该步；最后一步失败则结束序列。
      const next = index + 1
      if (next >= introSequence.steps.length) {
        introActive = false
        introFinished = true
        return
      }
      playIntroStep(next, startedAtMs)
      return
    }
    introActive = true
    introStepIndex = index
    introStepStartedAtMs = startedAtMs
  }

  /** 入场序列推进（每帧；被打断即取消）。 */
  const updateIntroSequence = (input: AnimationInput, effectiveMood: PetMood): void => {
    if (!introSequence || introSequence.enabled === false || !clipsReady || !clipPlayer) return
    if (introFinished) return
    const interrupted =
      input.dragging || (Array.isArray(input.events) && input.events.length > 0) || effectiveMood !== 'idle'
    if (interrupted) {
      cancelIntro()
      return
    }
    const nowMs = now()
    if (!introActive) {
      playIntroStep(0, nowMs)
      return
    }
    const step = introSequence.steps[introStepIndex]
    if (step && nowMs - introStepStartedAtMs >= Math.max(0, step.seconds) * 1000) {
      const next = introStepIndex + 1
      if (next >= introSequence.steps.length) {
        introActive = false
        introFinished = true
        return
      }
      playIntroStep(next, nowMs)
    }
  }

  const update = (input: AnimationInput): void => {
    if (disposed || !humanoid) return
    const dt = clamp(Number.isFinite(input.dt) ? input.dt : 0, 0, MAX_FRAME_DELTA_SEC)
    lastInput = input

    const effectiveMood: PetMood = moodOverride ?? input.mood

    // 1) clip：写 normalized 骨 + Hips.p + 贴地，并内部 humanoid.update()
    if (clipsEnabled && clipPlayer) {
      // 1a) mood 进出场一次性过渡（如 dshError: 进入播 breaked、离开播 revive；播完自动回 mood）
      if (clipsReady && lastMood !== effectiveMood) {
        const previous = lastMood
        lastMood = effectiveMood
        // 新的 mood 变化覆盖尚未补播的空中过场（旧过场已过期，不补播）。
        pendingGroundedTransitionClip = null
        const airborne = input.motion.airborne === true
        const requestGroundedTransition = (clipId: string, hold: boolean, fadeSec: number): void => {
          if (airborne) {
            pendingGroundedTransitionClip = { clipId, hold, fadeSec }
            return
          }
          playOneShotClip(clipId, { loop: false, hold, fadeSec })
        }
        if (previous !== null) {
          const transition = transitionClips[previous]
          const exitClip = pickTransitionClip(transition?.exitClip)
          if (exitClip !== null) {
            requestGroundedTransition(exitClip, transition?.exitHold === true, 0.2)
          }
        }
        const enterTransition = transitionClips[effectiveMood]
        const enterClip = pickTransitionClip(enterTransition?.enterClip)
        if (enterClip !== null) {
          requestGroundedTransition(enterClip, enterTransition?.enterHold === true, 0.15)
        }
      }
      // 1a2) 落地后补播空中推迟的地面过场（breaked/revive）。只补一次；若期间又换 mood 已在 1a 清空。
      if (pendingGroundedTransitionClip !== null && input.motion.airborne !== true) {
        const pending = pendingGroundedTransitionClip
        pendingGroundedTransitionClip = null
        playOneShotClip(pending.clipId, { loop: false, hold: pending.hold, fadeSec: pending.fadeSec })
      }
      // 1b) app 启动入场序列（introStart→introLoop→introEnd；交互/拖拽/调试打断）
      updateIntroSequence(input, effectiveMood)
      try {
        clipPlayer.update(moodOverride !== null ? { ...input, mood: moodOverride } : input)
        lastClipSnapshot = clipPlayer.snapshot()
        lastClipId = lastClipSnapshot.clipId
      } catch (error) {
        warnOnce('clip-player.update', error)
      }

      // 1b2) 坐窗口风格：高窗（上沿在屏幕上半部）→ 躺/趴在窗沿（catalog 窗沿躺 clip 循环）；
      //      矮窗 → 继续用 app-manifest 的 sit 坐姿（sit1）。离开 sit 时清掉手动窗沿躺 clip。
      const moodIsSit = effectiveMood === 'sit'
      const manualSitStyle =
        sitWindowStyle === 'sitVariant' || sitWindowStyle === 'lie' ? sitWindowStyle : null
      if (moodIsSit && manualSitStyle !== null) {
        const currentLie = sitLieClipId !== null && lastClipSnapshot?.clipId === sitLieClipId
        if (!currentLie) {
          const candidates =
            sitLieClipOverride !== null
              ? [sitLieClipOverride]
              : manualSitStyle === 'lie'
                ? [...sitLieClipCandidates]
                : [...sitVariantClipCandidates]
          const index = Math.min(
            candidates.length - 1,
            Math.floor(clamp(randomSafely(), 0, 0.999) * candidates.length)
          )
          const candidate = candidates[index]!
          try {
            if (clipPlayer.playClipById(candidate, { loop: true, fadeSec: 0.3 })) {
              sitLieClipId = candidate
            }
          } catch (error) {
            warnOnce('clip-player.playSitLieClip', error)
          }
        }
      } else if (sitLieClipId !== null) {
        sitLieClipId = null
        try {
          clipPlayer.stopManualClip?.(0.25)
        } catch (error) {
          warnOnce('clip-player.stopManualClip', error)
        }
      }

      // 1b2b) 待机程序化微动（呼吸/重心/头部漂移，2026-11-10 用户要求「腰要会动」）：
      //       在 foot-lock IK 之前施加，脚被 IK 钉住的同时骨盆/躯干有自然微动。
      if (microMotion !== null) {
        const idleBaseActive =
          lastClipSnapshot?.slot != null &&
          lastClipSnapshot.slot === effectiveMood &&
          effectiveMood === 'idle' &&
          input.dragging !== true &&
          input.motion?.grounded !== false
        // crossfade 期间保持相位、幅度略收（research：不要归零，否则过渡会“抽一下”）；
        // 表演型 idle（Idle_Show 等本身已是大动作）把程序化微动压到 0.3，避免叠过头。
        const isShowcaseIdle = /idleShow/i.test(lastClipSnapshot?.clipId ?? '')
        const scaleMultiplier = isShowcaseIdle ? 0.3 : lastClipSnapshot?.fading === true ? 0.85 : 1
        try {
          microMotion.update(dt, idleBaseActive, scaleMultiplier)
        } catch (error) {
          warnOnce('micro-motion.update', error)
        }
      }

      // 1b3) 静态脚部固定（foot planting）：待机/反应等静止动作时把接触脚钉在锚点，
      //      消除 idle 变体 crossfade 期间「腰不动、脚在地面滑」。walk/climb/fall/drag/
      //      grabWindow/sit/sleep 由模块内部禁用（走路滑步走步幅地速校准，本轮不改）。
      //      clip 未就绪（rest T-pose）时不参与，避免把锚点记在 T-pose 脚位上。
      if (footLock !== null) {
        try {
          if (lastClipSnapshot?.clipId == null) footLock.reset()
          else
            footLock.update(
              { ...input, mood: effectiveMood },
              {
                // crossfade 期间冻结接触状态：混合姿态的脚速不是作者的抬脚（见 foot-lock.ts）。
                transitioning: lastClipSnapshot.fading === true,
                // 只锁「基础选片」（槽位==mood）；一次性事件 clip / 手动 clip（intro、DSH 工作小动作、
                // error 过场等，slot 为事件名或 'manual'）不锁，避免把表演动作误当静态待机。
                allow: lastClipSnapshot.slot !== null && lastClipSnapshot.slot === effectiveMood,
                // 换姿势重锚：clip 身份变化检测（crossfade 结束后把脚 pin 搬到新 clip 作者站姿）。
                clipId: lastClipSnapshot.clipId ?? null
              }
            )
        } catch (error) {
          warnOnce('foot-lock.update', error)
        }
      }

      // 1c) 坐姿视觉锚点：sitting 时 hips 应贴表面（窗口沿/Dock），而不是最低点贴表面。
      //     把模型整体下移「姿态中 hips 高出最低点的高度」，腿自然垂下；离开 sit 平滑回 0。
      let targetOffsetPx = 0
      const seatHeightM = lastClipSnapshot?.poseHipsAboveLowestM ?? null
      if (effectiveMood === 'sit') {
        if (sitWindowStyle === 'lie') {
          // 真躺：平面锚点 + 可选微调下移（保证头不出屏幕顶）。
          targetOffsetPx = -sitLieSinkPx
        } else if (seatHeightM !== null && seatHeightM > 0) {
          // 坐 / 坐姿变体：臀部（hips）贴窗沿、腿自然垂下（2026-11-10 修复变体被当成“蹲在窗口上”）。
          const rawPpm = options.root.userData['pixelsPerMeter']
          const pixelsPerMeter = typeof rawPpm === 'number' && Number.isFinite(rawPpm) && rawPpm > 0 ? rawPpm : 1
          targetOffsetPx = -seatHeightM * pixelsPerMeter
        }
      }
      const offsetAlpha = 1 - Math.exp(-dt / 0.15)
      visualOffsetPx += (targetOffsetPx - visualOffsetPx) * Math.min(1, Math.max(0, offsetAlpha))
      if (Math.abs(targetOffsetPx - visualOffsetPx) < 0.25) visualOffsetPx = targetOffsetPx
    }

    // 2) 表情：写 expressionManager（必须在 vrm.update 前）
    if (expressionLayer) {
      try {
        expressionLayer.update(input, dt)
      } catch (error) {
        warnOnce('expression-layer.update', error)
      }
    }

    // 3) look-at additive（改 normalized 头/眼后需再 humanoid.update() 同步 raw 骨）。
    // 注意：additive 依赖 clip 每帧把骨骼重写为绝对姿态；clip 未就绪时必须禁用，否则逐帧累加会转头。
    let needsRawSync = (footLock !== null || microMotion !== null) && clipsEnabled
    if (lookAtLayer && clipsReady) {
      try {
        lookAtLayer.update(input)
        needsRawSync = true
      } catch (error) {
        warnOnce('look-at.update', error)
      }
    }
    if (needsRawSync) {
      try {
        humanoid.update()
      } catch (error) {
        warnOnce('humanoid.update', error)
      }
    }

    // 3.5) 手持道具（V1 水枪）：只按当前 clip 切 visible；道具是 hand 骨子节点，无需写骨。
    if (handProp) {
      try {
        handProp.update(resolveHandPropClipMeta ? resolveHandPropClipMeta(lastClipId) : null)
      } catch (error) {
        warnOnce('hand-prop.update', error)
      }
    }

    // 4) three-vrm 统一更新：spring bone / 表情材质 / 内建 lookAt；spring 必须用真实 dt。
    try {
      vrm.update(dt)
    } catch (error) {
      warnOnce('vrm.update', error)
    }
  }

  const getDebugSnapshot = (): AnimationDebugSnapshot => {
    const clip = clipsEnabled && clipPlayer ? (lastClipSnapshot ?? clipPlayer.snapshot()) : null
    const expression = expressionLayer ? expressionLayer.snapshot() : emptyExpressionSnapshot()
    const lookAt = lookAtLayer ? lookAtLayer.snapshot() : { yaw: null, pitch: null }
    const yawDeg = lookAt.yaw === null ? null : normalizeDeg(lookAt.yaw)
    const pitchDeg = lookAt.pitch === null ? null : normalizeDeg(lookAt.pitch)
    const mood = moodOverride ?? lastInput?.mood ?? null
    const slot = clip?.slot ?? null
    return {
      pose: clip?.clipId ?? 'rest',
      poseWeight: clip?.weight ?? 0,
      activeLayers: clip === null ? 0 : clip.fading ? 2 : 1,
      gesture: slot !== null && mood !== null && slot !== mood ? slot : null,
      blink: expression.blink,
      smile: expression.smile,
      mouthOpen: expression.mouthOpen,
      lookYaw: yawDeg === null ? null : clamp(yawDeg / LOOK_YAW_REFERENCE_DEG, -1, 1),
      missingBones: clip ? [...clip.missingBones] : [],
      morphs: expression.weights,
      gaze:
        yawDeg === null && pitchDeg === null
          ? null
          : {
              yaw: ((yawDeg ?? 0) * Math.PI) / 180,
              pitch: ((pitchDeg ?? 0) * Math.PI) / 180
            },
      footErrorPx: clip?.footErrorPx ?? null,
      clipId: clip?.clipId ?? null,
      clipTimeSec: clip?.timeSec ?? null,
      externalFootErrorPx: clip?.footErrorPx ?? null,
      // 脚部固定（静态动作）运行时状态：验收时用它断言「真的钉住了/误差≈0」。
      footLock: getFootLockSnapshot(),
      spring: {},
      updateMs: undefined,
      visualOffsetYPx: Math.round(visualOffsetPx * 100) / 100
    }
  }

  const setPose = (poseId: string, _fadeMs?: number): boolean => {
    if (disposed || typeof poseId !== 'string') return false
    cancelIntro()
    if (clipsEnabled && clipPlayer) {
      try {
        if (clipPlayer.playClipById(poseId)) return true
      } catch (error) {
        warnOnce('clip-player.playClipById', error)
      }
    }
    const alias = POSE_ALIASES[poseId]
    if (alias !== undefined) {
      moodOverride = alias
      return true
    }
    if (isAnimationClipMood(poseId) && poseId !== 'salute') {
      moodOverride = poseId
      return true
    }
    return false
  }

  const setGaze = (yawDeg: number, pitchDeg: number): void => {
    if (typeof lookAtLayer === 'undefined') return
    try {
      lookAtLayer?.setOverride(
        Number.isFinite(yawDeg) ? yawDeg : null,
        Number.isFinite(pitchDeg) ? pitchDeg : null
      )
    } catch (error) {
      warnOnce('look-at.setOverride', error)
    }
  }

  const setMoodOverride = (mood: PetMood | null): void => {
    if (mood !== null) cancelIntro()
    moodOverride = mood
  }

  const setSitWindowStyle = (
    mode: SitWindowStyleMode | null,
    options?: { clipId?: string | null; sinkPx?: number }
  ): void => {
    if (mode !== 'sit' && mode !== 'sitVariant' && mode !== 'lie' && mode !== null) return
    const nextClip =
      typeof options?.clipId === 'string' && options.clipId.length > 0 ? options.clipId : null
    const nextSink =
      mode === 'lie' && typeof options?.sinkPx === 'number' && Number.isFinite(options.sinkPx)
        ? Math.max(0, Math.min(200, options.sinkPx))
        : 0
    // 素材覆盖变化（真躺 ↔ 变体随机）→ 重播当前手动 lie clip。
    if (nextClip !== sitLieClipOverride) {
      sitLieClipOverride = nextClip
      if (mode === 'lie') sitLieClipId = null
    }
    sitLieSinkPx = nextSink
    sitWindowStyle = mode
  }

  const getFootLockSnapshot = (): VrmFootLockDebugSnapshot | null => {
    if (footLock === null) return null
    return footLock.getSnapshot()
  }

  const dispose = (): void => {
    if (disposed) return
    disposed = true
    try {
      footLock?.dispose()
    } catch (error) {
      warnOnce('foot-lock.dispose', error)
    }
    try {
      microMotion?.dispose()
    } catch (error) {
      warnOnce('micro-motion.dispose', error)
    }
    try {
      expressionLayer?.dispose()
    } catch (error) {
      warnOnce('expression-layer.dispose', error)
    }
    try {
      lookAtLayer?.dispose()
    } catch (error) {
      warnOnce('look-at.dispose', error)
    }
    try {
      clipPlayer?.dispose()
    } catch (error) {
      warnOnce('clip-player.dispose', error)
    }
    try {
      // 必须先从 hand detach，再让 avatar.dispose 的 VRMUtils.deepDispose 处理模型资源。
      handProp?.dispose()
    } catch (error) {
      warnOnce('hand-prop.dispose', error)
    }
  }

  return {
    update,
    getDebugSnapshot,
    setPose,
    setGaze,
    setMoodOverride,
    playOneShotClip,
    setSitWindowStyle,
    getFootLockSnapshot,
    dispose,
    ready,
    get currentClipId(): string | null {
      return lastClipId
    },
    get introActive(): boolean {
      return introActive
    }
  }
}
