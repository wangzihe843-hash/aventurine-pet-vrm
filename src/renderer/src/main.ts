/**
 * renderer 入口 —— Wave 1 A2：three.js 宠物渲染 + 透明 overlay bootstrap（唯一入口）。
 *
 * 职责划分：
 * - `model/layout.ts`（纯函数）：尺寸/位置/视口换算，单测覆盖；
 * - `model/bounding.ts`（纯函数）：绑定姿势包围盒（M-1：不能把 morph target 当缩放基准）；
 * - `model/morph-map.ts`（纯函数）：morph/材质名称映射，单测覆盖；
 * - `interaction/pointer-gate.ts`（纯逻辑）：悬停命中 → 点击穿透状态机（M-3）；
 * - `assets/pet-asset.ts`：`pet-asset://` URL + 贴图加载追踪（F06）；
 * - `assets/retrying-texture-loader.ts`：贴图加载失败指数退避重试（F04）；
 * - `scene/pet-scene.ts`：WebGLRenderer / 正交相机 / PMX / MMDAnimationHelper / 微动；
 * - 本文件：bootstrap、配置读取（A3 未合并时 DEFAULT_CONFIG 兜底 + 延迟重试）、
 *   显示器/窗口几何刷新（H-1：每次重新 invoke `pet:window-info`，不用启动快照）、
 *   `window.__aventurineDebug`。
 *
 * F07：非主屏 overlay 页面**不创建** WebGLRenderer / 不跑渲染 rAF —— 先确认
 * `renderPet=true` 再惰性创建 PetScene；调试面（`window.__aventurineDebug`）始终在
 * 任何异步之前挂上，`stats()`/`setMorph()` 在 scene 未创建时也能安全调用。
 *
 * 约束：不直接使用 Node API（sandbox:true + contextIsolation:true）；只通过 `window.api`（preload）。
 */
import assetsManifest from '@shared/assets-manifest.json'
import { DEFAULT_CONFIG, sanitizeConfig } from '@shared/config'
import type {
  DisplayInfo,
  DshStatus,
  OverlayWindowInfo,
  PetConfig,
  PetMood,
  Rect,
  WindowInfo
} from '@shared/types'
import { resolveAvatarAsset, sanitizeVrmAssetManifest } from '@shared/vrm'
import type { VrmAvatarAsset } from '@shared/vrm'
import vrmManifestJson from '@shared/vrm-manifest.json'

import { createHybridAnimator } from './animation'
import { buildAssetsAssetUrl, resolveMotionAssetUrl, resolvePmxUrl, resolveVrmAssetUrl } from './assets/pet-asset'
import { BubbleView } from './core/bubble'
import {
  computePetRectFromFeet,
  PetRuntime,
  type PetRuntimeEnvironment,
  type PetRuntimeFrameOutput,
  buildSitWindowStyleCandidates,
  chooseSitWindowStyle,
  pickNextSitWindowStyle,
  SIT_LIE_CLIP_ID,
  SIT_STYLE_ROTATE_MS,
  type SitWindowStyleChoice
} from './core/pet-runtime'
import type {
  AnimationDebugSnapshot,
  AnimationDriverInput,
  InteractionEvent,
  InteractionSnapshot,
  Point2D
} from './core/wave2-contract'
import type { AventurineDebug, AventurineDebugModel, AventurineDebugStats } from './debug'
import { InteractionController } from './interaction'
import { DshDialogue } from './reactions/dsh-dialogue'
import { DshWorkFidget } from './reactions/dsh-work-fidget'
import { IdleOneShotFidget } from './reactions/idle-one-shot-fidget'
import { computePointerHitRect, PointerGate } from './interaction/pointer-gate'
import { offsetPetRectForVisual, resolveHipShiftPx, resolveVisualOffsetPx } from './interaction/pointer-rect'
import { nextRenderErrorCount, shouldReportAnimationFailure } from './interaction/render-health'
import {
  computePetLayout,
  computePetRect,
  FALLBACK_MODEL_ASPECT,
  type PetLayout,
  type Size2D
} from './model/layout'
import type { PetView } from './scene/pet-view'
import { PetScene } from './scene/pet-scene'
import { createVrmPetAnimator } from './vrm/animator'
import { APP_CATALOG_FILE } from './vrm/clip-registry'
import { createVrmClipPlayer } from './vrm/clip-player'
import { createVrmExpressionLayer } from './vrm/expression-layer'
import { createVrmLookAtLayer } from './vrm/look-at'
import { VrmPetScene } from './vrm/pet-scene-vrm'
import {
  loadHandPropClipCatalog,
  WATERGUN_PROP_CONFIG,
  type HandPropClipMetaResolver
} from './vrm/prop-config'
import { createHandPropLayer, type HandPropLayer } from './vrm/prop-layer'
import type { VrmPetAnimator, VrmPoseDriverContext } from './vrm/runtime-types'

/** `pet:get-config` 未注册（A3 未合并）时的重试间隔与最大次数。 */
const CONFIG_RETRY_DELAY_MS = 2000
const CONFIG_RETRY_MAX_ATTEMPTS = 15

/** 初始配置获取的兜底超时（preload/IPC 异常时不让 boot 永远等不到首次布局；F05）。 */
const INITIAL_CONFIG_TIMEOUT_MS = 3000

/** 等待 20 张贴图加载结束的超时（防止异常导致 ready 永远为 false；超时也置 ready）。 */
const TEXTURE_WAIT_TIMEOUT_MS = 5000

/**
 * 宣告 `debug.ready` 前等待的渲染帧数与超时（用户 2026-11-09 启动姿势修复配套）。
 * `debug.ready` 语义 = 「首帧 clip 姿势已应用、模型已显示」：VrmPetScene 会在启动姿势完整应用后
 * 才显示模型（晚于 `loadModel` resolve 一帧），若 ready 抢在显示前，dev-capture 在 ready 后
 * 立即截图可能截到隐藏模型（透明 PNG）。
 */
const READY_POSE_WAIT_FRAMES = 2
const READY_POSE_WAIT_TIMEOUT_MS = 500

/** 视口尺寸轮询间隔（resize 事件之外的兜底；防止 dev 布局时序问题）。 */
const VIEWPORT_CHECK_INTERVAL_MS = 500

/** 渲染循环异常容忍次数（连续抛错时停掉渲染但保留页面，便于采集器读调试面）。 */
const MAX_RENDER_ERRORS = 3

/** PMX 加载失败后的指数退避重试（F04）：最多 3 次，延迟 1s / 2s / 4s。 */
const MODEL_LOAD_MAX_RETRIES = 3
const MODEL_LOAD_RETRY_BASE_MS = 1000

const appRoot = document.getElementById('app')

/** 运行期错误（调试面暴露；最多保留 20 条）。 */
const errors: string[] = []

/** 调试面模型信息（原地更新，引用稳定）。 */
const debugModel: AventurineDebugModel = {
  loaded: false,
  morphNames: [],
  materialNames: [],
  textureCount: 0,
  missingTextures: []
}

/** 运行状态。 */
let config: PetConfig = DEFAULT_CONFIG
/** 初始配置是否已应用（F05：拿到配置前不首次布局，避免默认尺寸闪变）。 */
let initialConfigReady = false
let scene: PetView | null = null
let viewport: Size2D = { width: 1, height: 1 }
let displays: DisplayInfo[] = []
let overlayWindow: OverlayWindowInfo | null = null
let currentLayout: PetLayout | null = null
let currentRect: Rect = { x: 0, y: 0, width: 0, height: 0 }
let modelLoading = false
let modelLoadFailures = 0
let modelRetryTimer: number | null = null
let renderErrorCount = 0
let lastViewportCheckMs = 0
let renderLoopHandle: number | null = null
/** 成功的窗口+显示器几何刷新次数（调试面 `geometryRefreshCount`，H-1）。 */
let geometryRefreshCount = 0
/** 进行中的几何刷新 Promise 与排队标记（H-1：并发合并 in-flight + queued）。 */
let refreshInFlight: Promise<void> | null = null
let refreshQueued = false

/* ------------------------------ Wave 2 运行时状态 ------------------------------ */

/** Wave 2 运行时（B1 行为 + B2 物理 + B5 桌面 + B7 DSH 组合；主屏 scene 就绪后创建）。 */
let runtime: PetRuntime | null = null
/** B4 交互控制器（DOM 事件；boot 后 attach） */
let interactionController: InteractionController | null = null
/** 台词气泡视图 */
let bubbleView: BubbleView | null = null
/**
 * Wave 3：DSH 回复气泡状态机（Lead 接线）。
 * 事件来自 main 的 `dsh-event` IPC（仅 online 时转发）；每帧 tick 后优先于行为层台词显示。
 * 模块为纯逻辑（无 DOM/定时器），生命周期跟着 bubbleView 创建/销毁。
 */
let dshDialogue: DshDialogue | null = null
/** 最近一次窗口列表（B5 基线；windows-updated 推送到这里） */
let latestWindows: WindowInfo[] = []
/** 上一帧的时间戳（runtime 物理 dt；null = 首帧）。 */
let lastFrameNowMs: number | null = null
/** DSH 状态轮询定时器（5s；B7 的 status 新鲜度由 B1/B7 内部判定）。 */
let dshStatusTimer: number | null = null
/** 最近一次 DSH 桥状态（工作小动作调度用；null = 未取到/离线）。 */
let latestDshStatus: DshStatus | null = null
/**
 * DSH 工作小动作（用户 2026-11-09 决策；2026-11-10 扩充 adv 技能）：DSH online && running 期间随机
 * 30–60s 播一次技能展示动作；拖拽/摸头/菜单/DSH 反应进行中时跳过。纯逻辑，见 reactions/dsh-work-fidget.ts。
 * 技能池 = hsr-skill01/02 + adv-skill01（普攻，持水枪）+ adv-mazeattack01（大世界普攻，持水枪）：
 * adv 只接不依赖缺失配件、不切镜的两条；skill02/skill03/skill04/skill41/skill04-2/mazeSkill 依赖
 * 缺失的滑板/苏乐达道具或 P9 切镜，用户 2026-11-10 明确要求不接，故不加入候选。
 */
const dshWorkFidget = new DshWorkFidget({
  clipIds: ['hsr-skill01', 'hsr-skill02', 'adv-skill01', 'adv-mazeattack01']
})
/**
 * 闲时一次性小动作（2026-11-10 用户要求）：mood=idle 且无交互/无 DSH 反应时，每 2–5 分钟
 * 随机播一条 adv 展示/社交动作（talk01/talk02/bye01、抛硬币 Idle_Show 01/02、看手机/看表/耳机的
 * loop 段各播一轮）；缺大件道具的 build02/forerake02/useprop 与受伤语义动作不接（用户 2026-11-10）。
 * 与 DSH 工作小动作互斥（同一帧只允许一个 one-shot）。
 */
const idleOneShotFidget = new IdleOneShotFidget()
/**
 * R-17：每帧复用的交互快照容器（只写字段，不重建对象）。
 * 消费方（B1 `BehaviorDirector` 每帧 `normalizeInteraction` 复制、调试面读取）都不长期持有历史引用；
 * 使用可变容器避免 60fps 下每帧 spread 出新的 InteractionSnapshot/pointer 包装对象。
 */
const interactionSnapshotScratch: InteractionSnapshot = {
  pointer: null,
  hoveringPet: false,
  dragging: false,
  patProgress: 0,
  lookTarget: null
}
/** 最近一次由 B4 产出的交互快照（调试面用；无控制器时为空快照）。 */
let lastInteractionSnapshot: InteractionSnapshot = interactionSnapshotScratch
/** M-11：B4 LookTracker 平滑后的注视目标（缺省 null；仅用于 B1 gaze，物理 pointer 不受影响）。 */
let currentLookTarget: Point2D | null = null
/** 调试/截图：临时覆盖动画层 mood（null = 不覆盖；只影响 B3 动画输入，不影响行为/物理）。 */
let animationMoodOverride: PetMood | null = null
/** 视觉命中矩形（屏幕 y = petRect.y − visualOffsetYPx、x += hips 横移补偿，见 `pointer-rect.ts`；null = 跟随 currentRect）。 */
let currentPointerRect: Rect | null = null
/** 最近一次已上报的动画驱动失败（M-7：只报首次/内容变化，避免每帧刷屏 debug.errors）。 */
let lastAnimationFailure: string | null = null
/* ------------------------------ V1：VRM 后端状态 ------------------------------ */
/** 已解析的 VRM manifest（`sanitizeVrmAssetManifest` 清洗后；legacy 路径不读）。 */
const vrmManifestResult = sanitizeVrmAssetManifest(vrmManifestJson)
const vrmManifest = vrmManifestResult.value
if (vrmManifestResult.warnings.length > 0) {
  console.warn('[renderer] vrm-manifest 清洗警告：', vrmManifestResult.warnings)
}
/** 当前 VRM 资产（modelBackend=vrm 时由 ensureScene 解析；legacy 为 null）。 */
let vrmAvatar: VrmAvatarAsset | null = null
/** 当前 VRM 动画驱动（调试/冒烟；legacy 为 null）。 */
let vrmAnimator: VrmPetAnimator | null = null
/** V1 手持道具（水枪）层；未接线/legacy 为 null。 */
let vrmHandPropLayer: HandPropLayer | null = null
/** clip id → 道具判定元信息（catalog 异步加载；未就绪恒 null = 道具隐藏）。 */
let handPropClipMetaResolver: HandPropClipMetaResolver = () => null
/** 创建场景时使用的模型后端（用于检测「运行期切 backend 需重启」）。 */
let appliedModelBackend: PetConfig['modelBackend'] | null = null
/** 已上报过「切换后端需重启」错误（避免每帧刷屏）。 */
let backendSwitchWarned = false

/** VRM 启动入场序列（catalog clip；app 启动后播一次，玩家第一次交互即打断）。 */
const VRM_INTRO_SEQUENCE = {
  steps: [
    { clipId: 'mate-introStart', seconds: 2.1 },
    { clipId: 'mate-introLoop', seconds: 4.5, loop: true },
    { clipId: 'mate-introEnd', seconds: 1.6 }
  ]
} as const

/**
 * VRM mood 进出场一次性过渡 clip（用户 2026-11-09「长时间 error、倒地不动、revive 只在倒地后」；
 * 2026-11-10 加入 adv-die，与 hsr-breaked 随机倒地）：
 * - 进入 dshError：在 `hsr-breaked` / `adv-die` 之间等概率随机一条（非循环）并**停在末帧**——
 *   两者都是倒地姿态，比 `hsr-stun`（站立眩晕摆动）更符合「倒地不动」的严重程度表达；保持到 error 结束。
 * - 离开 dshError：播 `hsr-revive`（其首帧就是跪伏姿态，正好接上倒地末帧）→ 起身后回当前 mood。
 * 备注：`hsr-stun` 仍保留在 app-manifest 作为兜底（若倒地 clip 不可用则显示眩晕待机）。
 */
const VRM_MOOD_TRANSITION_CLIPS = {
  dshError: {
    enterClip: ['hsr-breaked', 'adv-die'],
    enterHold: true,
    exitClip: 'hsr-revive',
    exitHold: false
  }
} as const
/** 初始配置重试定时器（02-L7：beforeunload 需清理）。 */
let configRetryTimer: number | null = null
/** 页面卸载清理回调（事件订阅 / window 监听；02-L7）。 */
const cleanupCallbacks: Array<() => void> = []
/** 上一次记录的 devicePixelRatio（02-L9：CSS 尺寸不变但 DPR 变化时也要重算像素比）。 */
let lastDevicePixelRatio = 1

/** 记录一条运行期错误（console + 调试面）。 */
function recordError(message: string, error?: unknown): void {
  const detail =
    error instanceof Error ? error.message : error === undefined ? '' : String(error)
  const text = detail.length > 0 ? `${message}: ${detail}` : message
  // eslint-disable-next-line no-console
  console.error('[renderer]', text, error ?? '')
  if (errors.length >= 20) errors.shift()
  errors.push(text)
}

/** 保留 1 位小数的数字（避免调试面出现长浮点）。 */
function roundTo(value: number, digits = 1): number {
  if (!Number.isFinite(value)) return 0
  const factor = 10 ** digits
  return Math.round(value * factor) / factor
}

/** 读取 #app 的 CSS 像素尺寸（= 渲染视口）。 */
function readViewport(): Size2D {
  const root = appRoot
  if (!root) return { width: 1, height: 1 }
  return { width: Math.max(1, root.clientWidth), height: Math.max(1, root.clientHeight) }
}

/** 读取当前 devicePixelRatio（非法/缺失 → 1）。 */
function readDevicePixelRatio(): number {
  const dpr = typeof window === 'undefined' ? 1 : window.devicePixelRatio
  return Number.isFinite(dpr) && dpr > 0 ? dpr : 1
}

/** 当前布局是否允许渲染宠物（仅主屏）。 */
function shouldRenderPet(): boolean {
  return currentLayout?.renderPet === true
}

/**
 * 等待 `frames` 个 rAF（带超时兜底，防 rAF 停摆/隐藏窗口把启动卡住）。
 * 用于让 `debug.ready` 覆盖「启动姿势已应用并显示」的那一帧（见 READY_POSE_WAIT_FRAMES）。
 */
function waitAnimationFrames(frames: number, timeoutMs: number): Promise<void> {
  return new Promise((resolve) => {
    let remaining = Math.max(0, Math.floor(frames))
    let settled = false
    const finish = (): void => {
      if (settled) return
      settled = true
      window.clearTimeout(timer)
      resolve()
    }
    const timer = window.setTimeout(finish, Math.max(0, timeoutMs))
    const tick = (): void => {
      remaining -= 1
      if (remaining <= 0) finish()
      else window.requestAnimationFrame(tick)
    }
    if (remaining <= 0) finish()
    else window.requestAnimationFrame(tick)
  })
}

/** 同步调试面的模型快照（贴图计数实时读取）。 */
function syncDebugModel(): void {
  if (!scene) return
  const snapshot = scene.snapshot()
  debugModel.loaded = snapshot.loaded
  debugModel.morphNames = snapshot.morphNames
  debugModel.materialNames = snapshot.materialNames
  debugModel.textureCount = snapshot.textureCount
  debugModel.missingTextures = snapshot.missingTextures
  if (snapshot.vertexCount !== undefined) debugModel.vertexCount = snapshot.vertexCount
  if (snapshot.triangleCount !== undefined) debugModel.triangleCount = snapshot.triangleCount
  // V1：VRM 场景诊断（冒烟/验收断言 humanoid/expression/spring/clip 状态）。
  const diagnostics = scene.getVrmDiagnostics?.()
  if (diagnostics) debug.vrm = { ...diagnostics, avatarFile: vrmAvatar?.file }
}

/** 实时统计（调试面 `stats()`；scene 未创建时返回布局值 + 0 渲染统计）。 */
function readStats(): AventurineDebugStats {
  syncDebugModel()
  const renderStats = scene
    ? scene.getRenderStats()
    : { fps: 0, drawCalls: 0, triangles: 0, outlinePx: 0 }
  const layout = currentLayout
  return {
    fps: renderStats.fps,
    drawCalls: renderStats.drawCalls,
    triangles: renderStats.triangles,
    petHeightPx: layout ? roundTo(layout.petHeightPx) : 0,
    outlinePx: renderStats.outlinePx,
    petRect: {
      x: roundTo(currentRect.x),
      y: roundTo(currentRect.y),
      width: roundTo(currentRect.width),
      height: roundTo(currentRect.height)
    },
    displayId: layout?.display?.id ?? null,
    isPrimaryDisplay: layout?.isPrimaryDisplay === true
  }
}

/* ------------------------------ 调试面（先挂上） ------------------------------ */

/** 真正下发 ignore-mouse 状态（IPC；失败只记录，不打断布局/渲染）。 */
function applyIgnoreMouse(ignore: boolean): void {
  const api = window.api
  if (!api) return
  void api.setIgnoreMouse(ignore).catch((error: unknown) => {
    recordError('pet:set-ignore-mouse 失败', error)
  })
}

/** 悬停命中 → 点击穿透状态机（M-3；主进程 mouse-gate 已有 16ms 去抖，renderer 不再延迟）。 */
const pointerGate = new PointerGate(applyIgnoreMouse, {
  rect: null,
  clickThrough: config.clickThrough,
  renderPet: false
})

const debug: AventurineDebug = {
  ready: false,
  model: debugModel,
  stats: readStats,
  setMorph: (name: string, weight: number) => scene?.setMorph(name, weight) ?? false,
  get geometryRefreshCount(): number {
    return geometryRefreshCount
  },
  get pointerIntercepting(): boolean {
    return pointerGate.intercepting
  },
  errors,
  // ---- Wave 2（运行时接入后由 applyRuntimeOutput 每帧更新；未接入时为 undefined）----
  animation: undefined,
  behavior: undefined,
  motion: undefined,
  desktop: undefined,
  interaction: undefined,
  reaction: null,
  debugSetPose: (poseId: string): boolean => scene?.debugSetPose(poseId) === true,
  debugSetGaze: (yawDeg: number, pitchDeg: number): void => {
    scene?.debugSetGaze(yawDeg, pitchDeg)
  },
  debugTriggerActivity: (activityId: string): boolean =>
    runtime?.debugTriggerActivity(activityId, performance.now()) === true,
  debugSetAnimationMood: (mood: PetMood | null): void => {
    animationMoodOverride = mood ?? null
    // V1：VRM animator 也直接记录覆盖（input.mood 覆盖已生效；这里让 setPose 槽位覆盖一致）。
    vrmAnimator?.setMoodOverride(null)
  },
  debugTeleport: (feet: { x: number; y: number }): boolean =>
    runtime?.debugTeleport(feet) === true,
  // V1 手持道具（水枪）：调试面快照 + 强制显隐（截图/冒烟用；不影响正常 clip 规则）。
  handProp: undefined,
  debugSetHandPropVisible: (visible: boolean | null): void => {
    vrmHandPropLayer?.debugSetVisible(visible)
    if (vrmHandPropLayer) debug.handProp = vrmHandPropLayer.snapshot()
  }
}

if (typeof window !== 'undefined') {
  window.__aventurineDebug = debug
}

/* ------------------------------ 布局 / 场景 ------------------------------ */

/**
 * 创建 legacy PMX 场景（v1 回退路径）。
 *
 * 2026-11-09 用户决策：**旧项目带来的自定义动作资产（VMD）已删除**，默认不再启用 v1 动画驱动；
 * 但动画实现代码全部保留（可复用；见 `docs/wave2-acceptance.md` §5）。
 * 只有显式设置 `PET_ANIM_BACKEND=legacy-pmx`（或 settings animBackend）时才接回 v1 程序化
 * PoseDriver，供回退/对照使用；默认 `animBackend='vrm'` → 仅 PMX 渲染 + IdleMotion 微动。
 * 台词/文本不受影响（`core/voicelines.ts`，映射见 behavior/dialogue.ts）。
 */
function createLegacyScene(): PetView {
  if (!appRoot) throw new Error('#app 容器不存在')
  if (config.animBackend !== 'legacy-pmx') return new PetScene(appRoot, config.fpsCap)
  return new PetScene(appRoot, config.fpsCap, {
    createPoseDriver: (context) =>
      createHybridAnimator({
        mesh: context.mesh,
        root: context.root,
        helper: context.helper
      })
  })
}

/**
 * VRM 动画驱动工厂（V1）：clip player + （V6）表情/look-at 层组合成 PoseDriver。
 * 返回 Promise：`VrmPetScene.loadModel` 会等 clip manifest 初始化后再宣告模型 ready。
 */
async function createVrmPoseDriver(
  context: VrmPoseDriverContext
): Promise<VrmPetAnimator | null> {
  try {
    // 2026-11-10 用户要求：进入/回归 idle 时在 hsr-idle / adv-idle（app-manifest 同 priority 10 同级）
    // 之间随机，由 clip-player 的同分随机 + 一次性 clip 播完回 mood 的「初始选片」实现；
    // **idle 的定时变体轮换保持默认（12–20s），不在这里覆盖 tuning。**
    const clipPlayer = createVrmClipPlayer({
      avatar: context.avatar,
      motionSet: context.motionSet,
      // VrmPetScene 米制世界（root.scale=1）；每次摆放把 CSS px/m 写到 root.userData。
      getPixelsPerMeter: () => Number(context.root.userData.pixelsPerMeter ?? 1)
    })
    // V6 表情层（HSR Emo_ / Mate face clip + 眨眼/口型）与 procedural look-at 层。
    const expressionLayer = createVrmExpressionLayer({ avatar: context.avatar })
    const lookAtLayer = createVrmLookAtLayer({ avatar: context.avatar })
    // V1 手持道具（水枪）：GLB 缺失/加载失败只 warn + 隐藏，不影响动画主链路。
    const handProp = WATERGUN_PROP_CONFIG
      ? createHandPropLayer({
          vrm: context.avatar.vrm,
          url: buildAssetsAssetUrl(WATERGUN_PROP_CONFIG.file),
          config: WATERGUN_PROP_CONFIG
        })
      : null
    vrmHandPropLayer = handProp
    // 规则元信息（clip set/tags）异步加载；加载完成前道具保持隐藏（普通动作绝不举枪）。
    void loadHandPropClipCatalog({ url: resolveMotionAssetUrl(APP_CATALOG_FILE) }).then((resolver) => {
      handPropClipMetaResolver = resolver
    })
    void handProp?.ready.then(() => {
      const snapshot = handProp.snapshot()
      if (snapshot.error) recordError('手持道具（水枪）降级为不显示', snapshot.error)
      debug.handProp = snapshot
    })
    const animator = createVrmPetAnimator({
      avatar: context.avatar,
      root: context.root,
      motionSet: context.motionSet,
      clipPlayer,
      expressionLayer,
      lookAtLayer,
      // 用户 2026-11-09：启动应直接进入待机姿势，不再播开场序列（避免任何非待机画面）。
      // 入场序列代码/素材保留，想启用把 enabled 改 true 即可。
      introSequence: { steps: VRM_INTRO_SEQUENCE.steps, enabled: false },
      moodTransitionClips: VRM_MOOD_TRANSITION_CLIPS,
      handProp: handProp ?? undefined,
      resolveHandPropClipMeta: (clipId) => handPropClipMetaResolver(clipId)
    })
    vrmAnimator = animator
    debug.vrmDrivers = {
      clips: true,
      expressions: true,
      lookAt: (context.avatar.asset.lookAt?.mode ?? 'none') === 'procedural'
    }
    await animator.ready
    return animator
  } catch (error) {
    recordError('VRM 动画驱动创建失败（降级为静态 rest）', error)
    return null
  }
}

/** 创建 VRM 场景（V1 主路径）：解析 manifest 默认资产，交给 VrmPetScene 渲染。 */
function createVrmScene(): PetView {
  if (!appRoot) throw new Error('#app 容器不存在')
  const avatar = resolveAvatarAsset(vrmManifest)
  if (!avatar) throw new Error('vrm-manifest.json 没有可用资产（assets/vrm/** 缺失？）')
  vrmAvatar = avatar
  return new VrmPetScene(appRoot, {
    avatar,
    motionSet: config.motionSet,
    fpsCap: config.fpsCap,
    createPoseDriver: createVrmPoseDriver
  })
}

/**
 * 惰性创建场景（F07）：只有确认「该窗口要渲染宠物」后才创建 WebGLRenderer/场景；
 * 非主屏 overlay 页面全程不建 GL 上下文、不跑渲染 rAF。
 *
 * V1：按 `config.modelBackend`（主进程已套用 PET_MODEL_BACKEND env 覆盖）选择
 * `vrm`（VrmPetScene）或 `legacy-pmx`（PetScene）；两者都实现 `PetView`。
 */
function ensureScene(): PetView | null {
  if (scene) return scene
  if (!appRoot) return null
  appliedModelBackend = config.modelBackend
  try {
    scene = config.modelBackend === 'vrm' ? createVrmScene() : createLegacyScene()
  } catch (error) {
    recordError('WebGL / three.js 初始化失败', error)
    return null
  }
  scene.setViewport(viewport)
  scene.setFpsCap(config.fpsCap)
  scene.setOpacity(config.opacity)
  startRenderLoop()
  return scene
}

/**
 * 把当前布局/命中矩形同步给穿透状态机（仅在状态变化时发 IPC）。
 *
 * 02-L1：`modelLoaded` 必须是「模型真正加载完成」，不能用 `scene !== null`——否则
 * 启动后模型就绪前的数百 ms 内，桌面上会有一块不可点的透明拦截带。
 */
function syncPointerGate(layout: PetLayout | null, rect: Rect, modelLoaded: boolean): void {
  const renderPet = layout?.renderPet === true && modelLoaded === true
  // B4：拖动中 / 右键菜单打开时强制拦截（即使指针已离开宠物矩形，保证 mouseup 能收到）。
  const forceIntercept =
    interactionController !== null &&
    (interactionController.isMenuOpen() || interactionController.getSnapshot().dragging)
  // 命中区 = 躯干带（不是整个渲染包围盒）：避免 T-pose 包围盒把两侧透明区域的
  // 桌面图标/窗口整片拦截（B4 已按区域命中提供像素级判定，这里保留躯干带作为命中矩形）。
  pointerGate.update({
    rect: renderPet ? computePointerHitRect(rect) : null,
    clickThrough: config.clickThrough,
    renderPet,
    forceIntercept
  })
}

/** 丢弃排队中的模型加载重试（模型已加载成功时调用）。 */
function clearModelLoadRetry(): void {
  if (modelRetryTimer === null) return
  window.clearTimeout(modelRetryTimer)
  modelRetryTimer = null
}

/* ------------------------------ Wave 2 运行时（B1/B2/B5/B7 组合） ------------------------------ */

/** 由当前布局构造运行时环境（窗口本地坐标口径，见 docs/wave2-integration.md §1）。 */
function buildRuntimeEnvironment(layout: PetLayout, rect: Rect): PetRuntimeEnvironment {
  if (!layout.display) throw new Error('buildRuntimeEnvironment 需要已解析的 display')
  return {
    // overlay 窗口本地坐标系：origin 恒为 (0,0)，尺寸 = 渲染视口（CSS px）。
    workArea: { x: 0, y: 0, width: viewport.width, height: viewport.height },
    petSize: { width: Math.max(1, rect.width), height: Math.max(1, rect.height) },
    viewport: { width: viewport.width, height: viewport.height },
    overlayOrigin: {
      x: overlayWindow?.bounds.x ?? 0,
      y: overlayWindow?.bounds.y ?? 0
    },
    display: layout.display
  }
}

/** 窗口列表基线：订阅前先 invoke 取一次（A4 首份列表不广播，见 native/winlist/README）。 */
async function refreshWindowsBaseline(): Promise<void> {
  const api = window.api
  if (!api) return
  try {
    const windows = await api.getWindows()
    if (!Array.isArray(windows)) return
    latestWindows = windows
    runtime?.updateWindows(windows, performance.now())
  } catch (error) {
    // 未注册/失败不阻断（B5 会用空表面 + 地面兜底）
    recordError('pet:windows 基线获取失败', error)
  }
}

/** DSH 状态刷新（B7：`pet:dsh-status`；离线时 tracker 清残留反应）。 */
async function refreshDshStatus(): Promise<void> {
  const api = window.api
  if (!api) return
  try {
    const status = await api.getDshStatus()
    latestDshStatus = status ?? null
    // Wave 3：DSH 离线（退出/桥卸载）时清空气泡状态机，避免「思考中...」永久悬挂。
    if (status?.online !== true) dshDialogue?.reset()
    runtime?.updateDshStatus(status, performance.now())
  } catch {
    // DSH 未运行/未注册都视为离线（静默）
    latestDshStatus = null
  }
}

/** 右键菜单动作（B4 DOM 菜单 → 主进程能力）。 */
function handleMenuAction(action: 'settings' | 'hide' | 'toggleAutonomous' | 'quit'): void {
  const api = window.api
  if (!api) return
  switch (action) {
    case 'settings':
      void api.showSettings().catch((error: unknown) => recordError('showSettings 失败', error))
      break
    case 'hide':
      void api.setVisible(false).catch((error: unknown) => recordError('set-visible 失败', error))
      break
    case 'toggleAutonomous':
      void api
        .setConfig({ autonomous: !config.autonomous })
        .catch((error: unknown) => recordError('set-config 失败', error))
      break
    case 'quit':
      void api.quit().catch((error: unknown) => recordError('quit 失败', error))
      break
  }
}

/**
 * 创建 Wave 2 运行时（仅主屏、scene 就绪后一次）。
 * 初始脚底 = 当前布局的角落位置（保持 Wave 1 启动画面连续），之后由 B1/B2 接管。
 */
function ensureRuntime(layout: PetLayout): PetRuntime | null {
  if (runtime) return runtime
  if (!layout.display) return null
  const env = buildRuntimeEnvironment(layout, currentRect)
  runtime = new PetRuntime({
    env,
    config,
    initialFeet: {
      x: currentRect.x + currentRect.width / 2,
      y: currentRect.y + currentRect.height
    }
  })
  if (latestWindows.length > 0) {
    runtime.updateWindows(latestWindows, performance.now())
  } else {
    void refreshWindowsBaseline()
  }
  void refreshDshStatus()
  if (dshStatusTimer === null) {
    dshStatusTimer = window.setInterval(() => {
      void refreshDshStatus()
    }, 5000)
  }
  return runtime
}

/** 把 B4 交互事件中的拖拽相关事件即时转发给 B2（不等下一帧，保证跟手与甩出速度）。 */
function forwardDragEvents(events: readonly InteractionEvent[], nowMs: number): void {
  if (!runtime) return
  for (const event of events) {
    switch (event.kind) {
      case 'dragStart':
        runtime.beginDrag(event.pointer, nowMs)
        break
      case 'dragMove':
        runtime.dragTo(event.pointer, nowMs)
        break
      case 'dragEnd':
        runtime.endDrag(nowMs, event.throwVelocity)
        break
      default:
        break
    }
  }
}

/**
 * DSH 工作小动作：每帧推进调度器，命中时让 VRM animator 播一条一次性技能展示动作。
 * 只在 VRM 动画驱动存在且 dshLink 开启时生效；阻塞条件见 dsh-work-fidget 设计。
 * 返回本帧是否命中并播放（false = 未播放；供闲时一次性小动作做同帧互斥）。
 */
function updateDshWorkFidget(nowMs: number): boolean {
  if (!vrmAnimator || !config.dshLink) return false
  const runtimeSnapshot = runtime?.snapshot(nowMs) ?? null
  const mood = runtime?.behaviorDirector.getDebugSnapshot().mood ?? null
  const blocked =
    lastInteractionSnapshot.dragging ||
    (interactionController?.isMenuOpen() ?? false) ||
    (runtimeSnapshot?.reaction ?? null) !== null ||
    mood === 'pat' ||
    mood === 'drag' ||
    mood === 'sleep' ||
    // Bug B（Lead 决策 §4.3-C2）：坐着时禁止插播装饰性 one-shot 站立技能 clip（反应动作视觉上不站）。
    mood === 'sit'
  const clipId = dshWorkFidget.update({ nowMs, status: latestDshStatus, blocked })
  if (clipId !== null) {
    vrmAnimator.playOneShotClip(clipId, { loop: false, fadeSec: 0.2 })
  }
  return clipId !== null
}

/**
 * 闲时一次性小动作：每帧推进调度器；mood=idle 且不阻塞时命中就播一条一次性动作（播完回 idle）。
 * blocked：拖拽/菜单/DSH 反应/pat/drag/sleep、以及有一次性/手动 clip 正在播（animSnapshot.gesture 非空）、
 * 或同一帧 DSH 工作小动作已触发。
 */
function updateIdleOneShotFidget(
  nowMs: number,
  animSnapshot: AnimationDebugSnapshot | null,
  dshFired: boolean
): void {
  if (!vrmAnimator) return
  const runtimeSnapshot = runtime?.snapshot(nowMs) ?? null
  const mood = runtime?.behaviorDirector.getDebugSnapshot().mood ?? null
  const blocked =
    dshFired ||
    animSnapshot?.gesture != null ||
    lastInteractionSnapshot.dragging ||
    (interactionController?.isMenuOpen() ?? false) ||
    (runtimeSnapshot?.reaction ?? null) !== null ||
    mood === 'pat' ||
    mood === 'drag' ||
    mood === 'sleep'
  const clipId = idleOneShotFidget.update({ nowMs, idle: mood === 'idle', blocked })
  if (clipId !== null) {
    vrmAnimator.playOneShotClip(clipId, { loop: false, fadeSec: 0.25 })
  }
}

/**
 * 「高窗躺/趴」素材开关（当前启用；需要按尺寸/可用空间自动选择，见下方 `resolveSitWindowStyle`）。
 *
 * `mate-sitWindow` / `mate-windowLay8/9/10` 是 Mate-Engine 的窗沿躺素材（小比例下观感正常）。
 * 2026-11-10 排查：真机上「趴下时头被截」的根因不是素材，而是**气泡压住宠物**（`computeBubblePosition`
 * 在宠物矩形超出屏幕顶时回落到窗口顶，正好盖住头，已修）；另外躺姿竖向占用比坐姿大（不同素材
 * 0.44×~0.60×身高），大尺寸 + 高窗沿会贴/出屏幕顶 → 由 `chooseSitWindowStyle` 按 headroom 选 sit/lie。
 */
const SIT_WINDOW_LIE_ENABLED = true

/** dev 抓图覆盖：主进程 `PET_DEV_CAPTURE_SIT_STYLE=sit|lie` → `window.__petDevSitStyle`。 */
function readDevSitStyleOverride(): 'sit' | 'lie' | null {
  const value = (window as unknown as { __petDevSitStyle?: unknown }).__petDevSitStyle
  return value === 'sit' || value === 'lie' ? value : null
}

/**
 * 窗沿坐姿轮换状态（Bug B / Lead 决策 §4.3-C1）：每 20–30s 在候选风格间切换，且不得连续两段同风格；
 * 首段用既有 `chooseSitWindowStyle` 基线（保留「高窗固定 windowLay8 窗沿坐变体」观感）。
 *
 * 重置时机：surface 变化 / 几何变化（窗口移动、换沿、尺寸变化）、非 sit mood、表面消失、
 * dev override、autonomous=false —— 避免旧状态残留到下一个窗沿。
 */
interface SitStyleRotationState {
  surfaceId: string
  /** 几何键（表面 id/top/workArea 顶/宠物高）：窗口移动或尺寸变化后候选集可能变化 → 重建。 */
  geometryKey: string
  candidates: SitWindowStyleChoice[]
  index: number
  /** 上一次切换时刻（ms）。 */
  rotatedAtMs: number
  /** 本轮轮换间隔（`SIT_STYLE_ROTATE_MS` 内随机；只在切换时生成一次，避免每帧抖动）。 */
  intervalMs: number
}

let sitStyleRotation: SitStyleRotationState | null = null

/** 本轮轮换间隔（仅视觉随机，不参与 B1 确定性语义）。 */
function nextSitStyleRotateInterval(): number {
  const { min, max } = SIT_STYLE_ROTATE_MS
  return min + Math.random() * (max - min)
}

/**
 * 坐窗口风格（含轮换）：
 * - 候选只含**窗沿适配素材**（`buildSitWindowStyleCandidates`）：高窗 = windowLay8 坐姿变体
 *   （headroom 足够时再加 mate-sitWindow 真躺），**绝不混入标准 sit**（其 base playlist 会随机播
 *   `mate-suwari3` 等盘腿 floor-sit 素材，窗沿上观感是「盘腿/抬脚悬在窗口上」——verifier M-1）；
 * - 首段 = 既有基线 `chooseSitWindowStyle`（高窗 windowLay8 / 矮窗标准坐）；
 * - 之后每 20–30s 在候选内切换，且不得连续两段同风格；候选 ≤1 时自然不轮换
 *   （用户当前 50% @ top=324 只有 windowLay8 单候选 → 不再每 20–30s 切风格，避免姿态差横移 M-2）；
 * - dev A/B 抓图覆盖（`PET_DEV_CAPTURE_SIT_STYLE`，可强制 sit/lie）保持最高优先；
 * - `autonomous=false` 不轮换（固定基线）；非 sit mood / 无表面 → 清状态返回 null。
 */
function resolveSitWindowStyle(
  output: PetRuntimeFrameOutput,
  nowMs: number
): SitWindowStyleChoice | null {
  if (!vrmAnimator || output.animation.mood !== 'sit') {
    sitStyleRotation = null
    return null
  }
  const decisionMotion = output.decision.motion
  const surfaceId =
    output.motion.surfaceId ??
    (decisionMotion.kind === 'sit' ? decisionMotion.surfaceId : null)
  if (surfaceId === null) {
    sitStyleRotation = null
    return null
  }
  const desktop = runtime?.snapshot(nowMs).desktop ?? null
  const surface = desktop?.surfaces.find((item) => item.id === surfaceId) ?? null
  if (!surface || desktop === null) {
    // 表面消失（窗口关闭/换沿/坐姿空档）→ 清轮换状态，不残留到下一个窗沿。
    sitStyleRotation = null
    return null
  }
  // dev A/B 抓图覆盖（主进程 PET_DEV_CAPTURE_SIT_STYLE=sit|lie → window.__petDevSitStyle）。
  const devOverride = readDevSitStyleOverride()
  if (devOverride === 'sit' || devOverride === 'lie') {
    sitStyleRotation = null
    return devOverride === 'sit'
      ? { mode: 'sit', clipId: null, sinkPx: 0 }
      : { mode: 'lie', clipId: SIT_LIE_CLIP_ID, sinkPx: 0 }
  }
  if (!SIT_WINDOW_LIE_ENABLED) {
    sitStyleRotation = null
    return null
  }
  const styleInput = {
    surfaceTop: surface.top,
    workAreaY: desktop.workArea.y,
    workAreaHeight: desktop.workArea.height,
    petHeightPx: currentRect.height
  }
  // 首段基线沿用既有选择（高窗 windowLay8 / 矮窗标准坐），轮换只在候选集内换素材、观感不突变。
  const baseline = chooseSitWindowStyle(styleInput)
  if (config.autonomous !== true) {
    // 非自主：维持卧姿但固定基线风格，不随机换风格（Lead 决策 §4.4）。
    sitStyleRotation = null
    return baseline
  }
  const geometryKey = `${surface.id}:${surface.top}:${desktop.workArea.y}:${currentRect.height}`
  let state = sitStyleRotation
  if (state === null || state.surfaceId !== surface.id || state.geometryKey !== geometryKey) {
    const candidates = buildSitWindowStyleCandidates(styleInput)
    const baselineIndex = candidates.findIndex((candidate) => candidate.mode === baseline.mode)
    state = {
      surfaceId: surface.id,
      geometryKey,
      candidates,
      index: baselineIndex >= 0 ? baselineIndex : 0,
      rotatedAtMs: nowMs,
      intervalMs: nextSitStyleRotateInterval()
    }
    sitStyleRotation = state
  }
  // 到点轮换：候选里挑一个与当前不同的风格（不得连续两段同风格）。
  if (state.candidates.length > 1 && nowMs - state.rotatedAtMs >= state.intervalMs) {
    state.index = pickNextSitWindowStyle(state.candidates, state.index, Math.random)
    state.rotatedAtMs = nowMs
    state.intervalMs = nextSitStyleRotateInterval()
  }
  return state.candidates[state.index] ?? baseline
}

/**
 * R-17：每帧复用的动画驱动输入容器（只写字段，不重建对象）。
 *
 * 安全性：`scene.setAnimationInput()` 只保存引用，`PetScene/VrmPetScene.step()` 在同一帧内同步读取
 * 并把字段拷贝进自己的渲染输入（poseDriver/animator/clip-player 均不跨帧持有该对象），
 * 因此下一帧覆盖前不会被其他消费方读到旧值。
 */
let animationInputScratch: AnimationDriverInput | null = null

/** 把本帧 runtime 输出写进复用容器（含调试 mood 覆盖）；返回的引用下一帧会被覆盖。 */
function writeAnimationInput(
  source: AnimationDriverInput,
  bubbleText: string | null
): AnimationDriverInput {
  const moodOverride = animationMoodOverride
  if (animationInputScratch === null) {
    animationInputScratch = {
      ...source,
      mood: moodOverride ?? source.mood,
      bubbleText
    }
    return animationInputScratch
  }
  animationInputScratch.mood = moodOverride ?? source.mood
  animationInputScratch.motion = source.motion
  animationInputScratch.facing = source.facing
  animationInputScratch.lookTarget = source.lookTarget
  animationInputScratch.dragging = source.dragging
  animationInputScratch.events = source.events
  animationInputScratch.bubbleText = bubbleText
  return animationInputScratch
}

/** 把运行时输出落到场景/命中/气泡/调试面（每帧调用）。 */
function applyRuntimeOutput(output: PetRuntimeFrameOutput, nowMs: number): void {
  currentRect = { ...output.petRect }
  // NEW-1：`visualOffsetYPx` 是 three 世界 Y 增量（正=视觉向上、负=视觉向下），
  // 屏幕 y 向下 → 命中/气泡矩形 = petRect.y − offset（旧实现写成 +，方向相反）。
  // 放置本身仍用 petRect，物理口径不变；仅命中/气泡跟随视觉位置。
  const animSnapshot = scene?.getAnimationSnapshot() ?? null
  const visualOffset = resolveVisualOffsetPx(animSnapshot?.visualOffsetYPx)
  // L2（M-3）：foot-lock 的 hips 水平对齐（A）会让身体视觉横移（≤0.18m≈56px），命中/气泡必须
  // 同步跟随；换算（scene 局部米 → 屏幕 px，含 modelRoot yaw 与 px/m）在 VRM 场景内完成。
  // 传入 animSnapshot 复用本帧已取的快照，避免每帧二次构建 debug 快照。
  // PMX 后端没有 foot-lock 层 → 可选方法，取不到即 0（行为与旧版一致）。
  const hipShiftXPx = resolveHipShiftPx(scene?.getHipShiftScreenXPx?.(animSnapshot) ?? 0)
  // VRM：sit 时 hips 贴窗沿的视觉锚点（renderer 场景下移），命中/气泡跟随（同一 offset）。
  scene?.setVisualOffsetYPx?.(visualOffset)
  currentPointerRect =
    visualOffset === 0 && hipShiftXPx === 0
      ? null
      : offsetPetRectForVisual(output.petRect, visualOffset, hipShiftXPx)
  const pointerRect = currentPointerRect ?? output.petRect

  // 02-N-3：先落气泡（show/update 后 text 才是本帧口型文本），再把最终文本写进动画输入，
  // 避免 lip-sync 比气泡晚一帧启动/结束。
  const bubble = bubbleView
  if (bubble) {
    bubble.place(pointerRect, viewport)
    // Wave 3 气泡仲裁：DSH 对话层（思考中/分段回复/段间 gap）优先于行为层台词；
    // ownsBubble=false 时才回落到 Wave 2 的 `output.decision.bubble`。
    const dialogueOutput = dshDialogue?.tick(nowMs) ?? null
    if (dialogueOutput !== null && dialogueOutput.text !== null) {
      bubble.show(dialogueOutput.text, nowMs, dialogueOutput.lifetimeMs)
    } else if (dialogueOutput !== null && dialogueOutput.ownsBubble) {
      bubble.hide()
    } else if (output.decision.bubble) {
      bubble.show(output.decision.bubble, nowMs)
    }
    bubble.update(nowMs)
  }
  const bubbleText = bubble && bubble.text.length > 0 ? bubble.text : null
  // B3 动画输入（dt/petRect/viewportHeight 由 PetScene 在 step 内补齐）
  // 调试覆盖：仅替换动画 mood（用于实机检查 pat/drag 等外部 VMD），normal 路径零影响。
  scene?.setAnimationInput(writeAnimationInput(output.animation, bubbleText))
  scene?.setFacing(output.facing)
  // 高窗躺/矮窗坐（VRM）：按当前 sit 目标表面位置切换风格。
  const sitWindowStyle = resolveSitWindowStyle(output, nowMs)
  if (sitWindowStyle) {
    vrmAnimator?.setSitWindowStyle(sitWindowStyle.mode, {
      clipId: sitWindowStyle.clipId,
      sinkPx: sitWindowStyle.sinkPx
    })
  } else {
    vrmAnimator?.setSitWindowStyle(null)
  }
  scene?.placePet(output.petRect, output.motion.feet.y)
  debug.petWorld = scene?.petWorldRect ?? undefined
  // L2（M-3）验收面：当前视觉命中矩形（物理 petRect + visualOffsetY + hips 横移补偿；
  // null = 与 petRect 相同）。只读调试用，不改变交互路径（交互仍经 currentPointerRect）。
  debug.pointerRect = currentPointerRect
  syncPointerGate(currentLayout, pointerRect, scene?.modelLoaded === true)

  // 调试面（Wave 2）
  debug.motion = output.motion
  debug.interaction = lastInteractionSnapshot
  debug.behavior = runtime?.behaviorDirector.getDebugSnapshot()
  if (runtime) {
    const snapshot = runtime.snapshot(nowMs)
    debug.desktop = snapshot.desktop
    debug.reaction = snapshot.reaction
  } else {
    debug.desktop = undefined
    debug.reaction = null
  }
  // 复用本帧已取的快照（NEW-9：避免每帧两次 getAnimationSnapshot）。
  debug.animation = animSnapshot ?? undefined
  if (vrmHandPropLayer) debug.handProp = vrmHandPropLayer.snapshot()
  // DSH 工作小动作 + 闲时一次性小动作（技能池 hsr-skill01/02 + adv-skill01/adv-mazeattack01 随机展示；
  // 空闲时每 2–5 分钟随机一条 adv 展示/社交动作；DSH 离线/非空闲时调度器自身不触发；同一帧只允许一个 one-shot）。
  const dshFired = updateDshWorkFidget(nowMs)
  updateIdleOneShotFidget(nowMs, animSnapshot, dshFired)
}

/** 重新计算布局并摆放宠物；屏幕/视口/配置变化时调用（幂等）。 */
function updateLayout(): void {
  // F05：初始配置 + 窗口/显示器信息都就绪后再首次布局，避免先按默认尺寸渲染再被纠正。
  if (!initialConfigReady || !overlayWindow || displays.length === 0) return
  const layout = computePetLayout({
    sizePercent: config.sizePercent,
    position: config.position,
    windowInfo: { bounds: overlayWindow.bounds, displayId: overlayWindow.displayId },
    displays,
    viewport
  })
  currentLayout = layout
  if (!layout.renderPet) {
    currentRect = { x: 0, y: 0, width: 0, height: 0 }
    debug.petWorld = undefined
    scene?.setPetVisible(false)
    syncPointerGate(layout, currentRect, scene?.modelLoaded === true)
    return
  }

  const activeScene = ensureScene()
  const aspect = activeScene?.modelLoaded ? activeScene.modelAspectRatio : FALLBACK_MODEL_ASPECT
  currentRect = computePetRect(layout, aspect)
  // 02-L1：scene 存在 ≠ 模型就绪；加载完成前保持穿透（renderPet=false）。
  syncPointerGate(layout, currentRect, activeScene?.modelLoaded === true)
  if (!activeScene) return

  activeScene.setPetVisible(true)

  // Wave 2：B1/B2 接管位置。布局尺寸/显示器变化时同步环境，宠物继续使用 B2 的 feet（不瞬移回角落）。
  const activeRuntime = ensureRuntime(layout)
  if (!activeRuntime) return
  activeRuntime.setConfig(config)
  const env = buildRuntimeEnvironment(layout, currentRect)
  activeRuntime.updateEnvironment(env)
  const motion = activeRuntime.motion
  currentRect = computePetRectFromFeet(motion.feet, env.petSize)
  syncPointerGate(layout, currentRect, activeScene.modelLoaded)
  if (activeScene.modelLoaded) {
    activeScene.placePet(currentRect, motion.feet.y)
    debug.petWorld = activeScene.petWorldRect ?? undefined
  }
  void ensureModelLoaded()
}

/* ------------------------------ 模型加载（F04 重试） ------------------------------ */

/** 模型加载失败后的指数退避重试调度（避免并发重入：已有定时器/正在加载时直接返回）。 */
function scheduleModelLoadRetry(): void {
  if (modelRetryTimer !== null) return
  if (modelLoadFailures > MODEL_LOAD_MAX_RETRIES) return
  const delay = MODEL_LOAD_RETRY_BASE_MS * 2 ** (modelLoadFailures - 1)
  modelRetryTimer = window.setTimeout(() => {
    modelRetryTimer = null
    void ensureModelLoaded()
  }, delay)
}

/** 首次加载模型（仅主屏窗口；PMX 或 VRM，加载后按真实包围盒重新摆放）。 */
async function ensureModelLoaded(): Promise<void> {
  if (!scene || modelLoading || scene.modelLoaded || !shouldRenderPet()) return
  modelLoading = true
  try {
    const modelUrl =
      vrmAvatar !== null && appliedModelBackend === 'vrm'
        ? resolveVrmAssetUrl(vrmAvatar)
        : resolvePmxUrl(assetsManifest)
    await scene.loadModel(modelUrl)
    clearModelLoadRetry()
    modelLoadFailures = 0
    syncDebugModel()
    updateLayout()
    await scene.waitForTextures(TEXTURE_WAIT_TIMEOUT_MS)
    syncDebugModel()
    const missing = scene.snapshot().missingTextures
    if (missing.length > 0) {
      // 贴图级重试已在 retrying-texture-loader 内做过（每张 3 次）；仍缺失说明不是瞬时失败，
      // 记录到调试面/console，模型以缺图状态渲染（不做整模型重载，避免抖动）。
      recordError(`贴图加载失败（${missing.length} 张）：${missing.join('、')}`)
    }
    // 启动姿势修复配套：等首帧动画姿势应用/模型显示后再置 ready（语义：ready ⇒ 可见宠物已就绪）。
    await waitAnimationFrames(READY_POSE_WAIT_FRAMES, READY_POSE_WAIT_TIMEOUT_MS)
    debug.ready = true
  } catch (error) {
    modelLoadFailures += 1
    recordError(`模型加载失败（第 ${modelLoadFailures} 次）`, error)
    scheduleModelLoadRetry()
  } finally {
    modelLoading = false
  }
}

/* ------------------------------ 配置 ------------------------------ */

/** 应用配置（sanitize 后热更 FPS / 透明度 / 尺寸 / 停靠方式 / 穿透）。 */
function applyConfig(input: unknown): void {
  config = sanitizeConfig(input)
  initialConfigReady = true
  // Wave 3：关闭气泡同步时立即释放对话状态机（已显示文本由 bubble 自然过期）。
  if (config.dshBubbleSync === false) dshDialogue?.reset()
  // V1：模型/动画后端在场景创建时固定；运行期修改需要重启应用（设置面板会提示）。
  if (appliedModelBackend !== null && config.modelBackend !== appliedModelBackend && !backendSwitchWarned) {
    backendSwitchWarned = true
    recordError('模型后端切换需要重启应用（当前仍在运行旧后端）')
  }
  scene?.setFpsCap(config.fpsCap)
  scene?.setOpacity(config.opacity)
  // clickThrough 热更不依赖布局是否就绪：立即更新穿透状态机。
  pointerGate.update({ clickThrough: config.clickThrough })
  updateLayout()
}

/**
 * 读取初始配置。
 * A3 未合并时 `pet:get-config` handler 未注册 → invoke reject；此时用 DEFAULT_CONFIG 兜底，
 * 并按固定间隔延迟重试（A3 合并后同一进程内若注册成功也能自动生效）。
 * 返回的 Promise 在**首次尝试**结束后即 resolve（失败重试在后台继续，不阻塞启动）。
 */
async function loadInitialConfig(attempt = 1): Promise<void> {
  const api = window.api
  if (!api) {
    applyConfig(DEFAULT_CONFIG)
    return
  }
  try {
    applyConfig(await api.getConfig())
  } catch (error) {
    if (attempt === 1) {
      console.warn(
        '[renderer] pet:get-config 不可用（A3 未合并时预期如此），使用 DEFAULT_CONFIG 兜底',
        error
      )
    }
    applyConfig(DEFAULT_CONFIG)
    if (attempt < CONFIG_RETRY_MAX_ATTEMPTS) {
      if (configRetryTimer !== null) window.clearTimeout(configRetryTimer)
      configRetryTimer = window.setTimeout(() => {
        configRetryTimer = null
        void loadInitialConfig(attempt + 1)
      }, CONFIG_RETRY_DELAY_MS)
    }
  }
}

/** 初始配置获取 + 超时兜底（防止 IPC 异常时 boot 永远等不到首次布局）。 */
function loadInitialConfigWithTimeout(): Promise<void> {
  return new Promise<void>((resolve) => {
    let settled = false
    const finish = (): void => {
      if (settled) return
      settled = true
      window.clearTimeout(timer)
      resolve()
    }
    const timer = window.setTimeout(() => {
      if (!initialConfigReady) applyConfig(DEFAULT_CONFIG)
      finish()
    }, INITIAL_CONFIG_TIMEOUT_MS)
    void loadInitialConfig().then(finish, finish)
  })
}

/* ------------------------------ 窗口 / 显示器（H-1） ------------------------------ */

/**
 * 单次几何刷新：并行拉取 overlay 窗口自身信息 + 全部显示器信息，然后重算布局。
 *
 * H-1：screens-updated / window resize 后**必须重新 invoke `pet:window-info`** ——
 * A1 对已有窗口在 display-metrics-changed 时只 `setBounds` 不重建页面，workArea 原点变化
 * （菜单栏自动隐藏等）时旧 bounds 会让 `localBottom = workArea 底边 − 旧窗口原点` 算错
 * （典型错位 30px）。二者缺一时：显示器信息缺失不渲染；window-info 缺失时退回
 * 「主屏 workArea 为窗口」的兜底（保证采集器/无 handler 环境下也能统计）。
 */
async function refreshGeometryOnce(): Promise<void> {
  const api = window.api
  if (!api) {
    updateLayout()
    return
  }

  const [windowResult, screensResult] = await Promise.allSettled([
    api.getWindowInfo(),
    api.getScreenInfo()
  ])

  let refreshedOk = true
  if (windowResult.status === 'fulfilled') {
    overlayWindow = windowResult.value
  } else {
    refreshedOk = false
    recordError('pet:window-info 不可用', windowResult.reason)
  }

  if (screensResult.status === 'fulfilled' && screensResult.value.length > 0) {
    displays = screensResult.value
  } else {
    refreshedOk = false
    recordError(
      'pet:screen-info 不可用',
      screensResult.status === 'rejected' ? screensResult.reason : '返回空显示器列表'
    )
  }

  // 兜底：window-info 不可用但能拿到显示器时，按主屏 workArea 假定窗口几何。
  if (!overlayWindow && displays.length > 0) {
    const primary = displays.find((display) => display.isPrimary) ?? displays[0]
    overlayWindow = {
      id: -1,
      bounds: { ...primary.workArea },
      displayId: primary.id
    }
  }

  // 「成功 refresh」= window-info + screen-info 都拉取成功（调试面/冒烟断言口径）。
  if (refreshedOk && overlayWindow) geometryRefreshCount += 1

  // resize 事件可能晚于 setBounds 一帧到达：刷新几何时顺带同步一次视口 CSS 尺寸/DPR，
  // 保证本次 updateLayout 用的 viewport 与刚取到的 window.bounds 是同一时刻的（02-L9）。
  const nextViewport = readViewport()
  const dpr = readDevicePixelRatio()
  const sizeChanged =
    nextViewport.width !== viewport.width || nextViewport.height !== viewport.height
  const dprChanged = dpr !== lastDevicePixelRatio
  if (sizeChanged || dprChanged) {
    lastDevicePixelRatio = dpr
    if (sizeChanged) viewport = nextViewport
    scene?.setViewport(viewport)
  }

  updateLayout()
}

/**
 * 请求一次几何刷新（H-1 并发合并）：in-flight 期间到来的新请求只置排队标记，
 * 当前刷新结束后立即补跑一次 —— screens-updated 与 resize 连续触发时既不会并发
 * invoke，也保证最终一定用上最新几何。
 * 返回的 Promise 在「本次调用之后至少完成一次刷新」时 resolve。
 */
function requestGeometryRefresh(): Promise<void> {
  if (refreshInFlight) {
    refreshQueued = true
    return refreshInFlight
  }
  const pending = (async (): Promise<void> => {
    try {
      do {
        refreshQueued = false
        await refreshGeometryOnce()
      } while (refreshQueued)
    } catch (error) {
      recordError('窗口/显示器几何刷新失败', error)
    } finally {
      refreshInFlight = null
    }
  })()
  refreshInFlight = pending
  return pending
}

/**
 * window resize：更新 canvas backing store/相机视锥，再重新取窗口几何后重算布局。
 *
 * 02-L9：显示器缩放/换屏导致 devicePixelRatio 变化但 CSS 视口尺寸不变时，
 * `resize` 事件可能不触发或早退；这里同时比较 DPR，变化时也调用 `setViewport`
 * 让 PetScene 重算 pixelRatio（像素预算）。
 */
function handleResize(): boolean {
  const next = readViewport()
  const dpr = readDevicePixelRatio()
  const sizeChanged = next.width !== viewport.width || next.height !== viewport.height
  const dprChanged = dpr !== lastDevicePixelRatio
  if (!sizeChanged && !dprChanged) return false
  lastDevicePixelRatio = dpr
  if (sizeChanged) viewport = next
  scene?.setViewport(viewport)
  if (sizeChanged) {
    // H-1：resize 往往与 workArea/bounds 变化同时发生，不能只用旧 windowInfo 重算。
    void requestGeometryRefresh()
  }
  return true
}

/* ------------------------------ 渲染循环 ------------------------------ */

/** 启动 rAF 渲染循环（每个窗口最多一个；只在 scene 存在时运行，F07）。 */
function startRenderLoop(): void {
  if (renderLoopHandle !== null) return
  lastViewportCheckMs = 0
  renderLoopHandle = window.requestAnimationFrame(frame)
}

/** 读取并上报动画驱动失败（M-7：只报首次/内容变化，避免每帧刷屏 debug.errors）。 */
function reportAnimationFailureIfNeeded(): void {
  const message = scene?.animationFailureMessage ?? null
  if (shouldReportAnimationFailure(lastAnimationFailure, message)) {
    recordError('动画驱动失败', message)
  }
  lastAnimationFailure = message
}

/** 渲染循环：每帧询问 scene 是否应渲染（fpsCap 跳帧在 scene 内处理）。 */
function frame(nowMs: number): void {
  renderLoopHandle = null
  try {
    const deltaSeconds =
      lastFrameNowMs === null ? 0 : Math.min(0.1, Math.max(0, (nowMs - lastFrameNowMs) / 1000))
    lastFrameNowMs = nowMs
    // M-7：动画驱动失败必须进调试面（渲染因连续错误停更时仍继续诊断）。
    reportAnimationFailureIfNeeded()
    if (scene && shouldRenderPet() && renderErrorCount < MAX_RENDER_ERRORS) {
      try {
        if (runtime && interactionController && bubbleView) {
          // B4：先推进交互时钟并取走本帧事件，再取快照（拖拽事件立即转发给 B2，保证跟手）
          const events = interactionController.drainEvents()
          // M-11：把 LookTracker 平滑目标并入快照（B1 仅用于 gaze；缺省字段=回退 pointer）。
          // R-17：写入复用容器，避免每帧 spread 新对象（消费方都不长期持有该引用）。
          const interactionSnapshot = interactionController.getSnapshot()
          interactionSnapshotScratch.pointer = interactionSnapshot.pointer
          interactionSnapshotScratch.hoveringPet = interactionSnapshot.hoveringPet
          interactionSnapshotScratch.dragging = interactionSnapshot.dragging
          interactionSnapshotScratch.patProgress = interactionSnapshot.patProgress
          interactionSnapshotScratch.lookTarget = currentLookTarget
          lastInteractionSnapshot = interactionSnapshotScratch
          forwardDragEvents(events, nowMs)
          const output = runtime.frame({
            nowMs,
            dt: deltaSeconds,
            interaction: lastInteractionSnapshot,
            events,
            bubbleText: bubbleView.text.length > 0 ? bubbleView.text : null
          })
          applyRuntimeOutput(output, nowMs)
        }
        scene.step(nowMs)
        // M-3：本帧正常执行完（含 fpsCap 跳帧但 step 正常返回）→ 连续错误计数清零。
        renderErrorCount = nextRenderErrorCount(renderErrorCount, false)
      } catch (error) {
        renderErrorCount = nextRenderErrorCount(renderErrorCount, true)
        recordError(`渲染帧异常（连续 ${renderErrorCount}/${MAX_RENDER_ERRORS}）`, error)
        if (renderErrorCount >= MAX_RENDER_ERRORS) {
          recordError(
            `渲染连续异常 ${MAX_RENDER_ERRORS} 次，已停止更新场景（保留 rAF 以便读取调试面）`
          )
        }
      }
    }
    // 兜底检查视口尺寸（window resize 事件之外，覆盖 dev 首帧/布局时序问题）。
    if (scene && nowMs - lastViewportCheckMs >= VIEWPORT_CHECK_INTERVAL_MS) {
      lastViewportCheckMs = nowMs
      handleResize()
    }
  } catch (error) {
    // 02-L4：外层兜底（handleResize / 气泡 / 调试面等易抛路径），异常不得让循环永久停摆。
    renderErrorCount = nextRenderErrorCount(renderErrorCount, true)
    recordError('渲染循环异常', error)
  } finally {
    // 非主屏不创建 scene → 不续订 rAF；scene 存在时持续渲染（拓扑翻转回主屏可恢复）。
    // 02-L4：即使上面任何路径抛错也保证续订，避免单次异常永久停循环（旧实现无 finally）。
    if (scene) startRenderLoop()
  }
}

/* ------------------------------ 事件订阅 ------------------------------ */

/** 鼠标移动 → 命中检测（M-3；窗口坐标 = CSS px，主进程 forward 模式会把 mousemove 转进来）。 */
function installPointerTracking(): void {
  const onMouseMove = (event: MouseEvent): void => {
    pointerGate.pointerMove(event.clientX, event.clientY)
  }
  const onMouseLeave = (): void => {
    pointerGate.pointerLeave()
  }
  window.addEventListener('mousemove', onMouseMove)
  window.addEventListener('mouseleave', onMouseLeave)
  // 02-L7：卸载时移除 window 监听（旧实现用匿名函数，无法移除）。
  cleanupCallbacks.push(() => {
    window.removeEventListener('mousemove', onMouseMove)
    window.removeEventListener('mouseleave', onMouseLeave)
  })
}

/** 事件订阅：配置变更 + 显示器/工作区变更（PLAN §17.5 P1-6 双保险的另一半）。 */
function subscribeEvents(): void {
  const api = window.api
  if (!api) {
    recordError('window.api 不可用（preload 未加载）')
    return
  }
  const unsubscribes = [
    api.onConfigChanged((next) => {
      try {
        applyConfig(next)
      } catch (error) {
        recordError('config-changed 应用失败', error)
      }
    }),
    api.onScreensUpdated((next) => {
      if (!Array.isArray(next) || next.length === 0) return
      // 先记录最新显示器快照（即使随后 invoke 失败也能用于降级布局），再重新取窗口几何。
      displays = next
      // H-1：A1 只 setBounds 不重建页面，必须重新 invoke pet:window-info 后再重算布局。
      void requestGeometryRefresh()
    }),
    // Wave 2 B5：其他应用窗口列表变化 → DesktopSensor（订阅后 ensureRuntime 会 invoke 基线）
    api.onWindowsUpdated((next) => {
      if (!Array.isArray(next)) return
      latestWindows = next
      try {
        runtime?.updateWindows(next, performance.now())
      } catch (error) {
        recordError('windows-updated 应用失败', error)
      }
    }),
    // Wave 2 B7：DSH 桥事件（主进程只在 online 时推送）→ 反应 tracker
    // Wave 3：同一事件也喂给回复气泡状态机（dshBubbleSync=false 时跳过并清空）
    api.onDshEvent((event) => {
      try {
        const nowMs = performance.now()
        runtime?.pushDshEvent(event, nowMs)
        if (config.dshBubbleSync !== false) dshDialogue?.pushEvent(event, nowMs)
      } catch (error) {
        recordError('dsh-event 应用失败', error)
      }
    })
  ]
  // 02-L7：卸载时退订（旧实现丢弃全部 Unsubscribe）。
  cleanupCallbacks.push(() => {
    for (const unsubscribe of unsubscribes) unsubscribe()
  })
}

/* ------------------------------ bootstrap ------------------------------ */

/**
 * 页面卸载清理（02-L7）：停 rAF / 定时器 / 事件订阅，销毁交互与气泡 DOM。
 *
 * R-01/R-02：在 `beforeunload` 里显式释放 three/VRM 资源（旧实现只靠进程退出回收）：
 * 1. `vrmAnimator.dispose()`：停各动画层（含 handProp detach，见 animator.ts 的顺序注释）；
 * 2. `vrmHandPropLayer.dispose()`：兜底重复调用（幂等）；
 * 3. `scene?.dispose?.()`：VrmPetScene 释放 avatar/renderer/context/canvas；legacy PetScene best-effort。
 *
 * ⚠️ `vrmAvatar` 是 manifest 资产（`VrmAvatarAsset`，无 `dispose()`），其 loaded 模型由场景内部
 * `VrmAvatar.dispose()` 释放，这里只置空引用。
 */
function shutdown(): void {
  for (const dispose of cleanupCallbacks.splice(0)) {
    try {
      dispose()
    } catch (error) {
      recordError('卸载清理回调失败', error)
    }
  }
  if (renderLoopHandle !== null) {
    window.cancelAnimationFrame(renderLoopHandle)
    renderLoopHandle = null
  }
  clearModelLoadRetry()
  if (configRetryTimer !== null) {
    window.clearTimeout(configRetryTimer)
    configRetryTimer = null
  }
  if (dshStatusTimer !== null) {
    window.clearInterval(dshStatusTimer)
    dshStatusTimer = null
  }
  interactionController?.destroy()
  interactionController = null
  dshDialogue?.reset()
  dshDialogue = null
  bubbleView?.destroy()
  bubbleView = null
  scene?.setPetVisible(false)
  debug.ready = false
  debug.animation = undefined
  debug.handProp = undefined

  // R-02：animator 必须先于场景 dispose（它持有 foot-lock/clip-player/handProp 等子层）。
  try {
    vrmAnimator?.dispose()
  } catch (error) {
    recordError('VRM 动画驱动释放失败', error)
  }
  vrmAnimator = null
  try {
    vrmHandPropLayer?.dispose()
  } catch (error) {
    recordError('手持道具释放失败', error)
  }
  vrmHandPropLayer = null
  handPropClipMetaResolver = () => null

  // R-01：场景释放（canvas/renderer/WebGL context/avatar deepDispose）。
  try {
    scene?.dispose?.()
  } catch (error) {
    recordError('WebGL 场景释放失败', error)
  }
  scene = null
  vrmAvatar = null
}

async function boot(): Promise<void> {
  if (!appRoot) {
    recordError('缺少 #app 容器')
    return
  }

  viewport = readViewport()
  lastDevicePixelRatio = readDevicePixelRatio()
  // Wave 2：台词气泡 + B4 交互控制器（DOM 事件；与 pointer-gate 的 mousemove 追踪共存）
  bubbleView = new BubbleView({ container: appRoot })
  // Wave 3：DSH 回复气泡状态机（思考中 → 每段输出 → 停留 → 下一段）
  dshDialogue = new DshDialogue()
  interactionController = new InteractionController({
    getPetRect: (): Rect | null =>
      shouldRenderPet() ? { ...(currentPointerRect ?? currentRect) } : null,
    getPetHeightPx: (): number => currentLayout?.petHeightPx ?? currentRect.height,
    isEnabled: (): boolean => shouldRenderPet() && initialConfigReady,
    onLookTarget: (target): void => {
      // M-11：LookTracker 平滑输出（死区 1.5px / τ≈100ms / 指针离开或 2.5s 无移动 → null）。
      // 只接到 B1 gaze；pointerNear / mouseAway / 朝向仍用原始 pointer（避免平滑造成避让/唤醒迟钝）。
      currentLookTarget = target ? { x: target.x, y: target.y } : null
    },
    onMenuAction: handleMenuAction,
    getAutonomous: (): boolean => config.autonomous
  })
  interactionController.attach(window)
  window.addEventListener('resize', handleResize)
  cleanupCallbacks.push(() => window.removeEventListener('resize', handleResize))
  // 02-L7：beforeunload 统一走 shutdown（rAF/定时器/订阅/DOM 清理）。
  window.addEventListener('beforeunload', shutdown)
  installPointerTracking()
  subscribeEvents()

  // F05：配置与窗口/显示器信息并行取齐后再首次布局/加载（避免默认尺寸闪变）；
  // F07：场景创建被推迟到 updateLayout() 内确认 renderPet 之后。
  await Promise.all([loadInitialConfigWithTimeout(), requestGeometryRefresh()])
  updateLayout()
}

void boot()
