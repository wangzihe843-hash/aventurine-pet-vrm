/**
 * B3 动画系统的 three 适配层 —— **本目录唯一 import three 的文件**。
 *
 * 职责（越薄越好）：
 * 1. 启动自检：收集骨骼 rest 位置（模型空间）、morph 索引、缺失骨/morph（console.warn，不抛）；
 * 2. 每帧把 `AnimationInput` 交给纯逻辑 `AnimationPipeline`（Node 可单测）；
 * 3. 把管线输出的四元数/センター平移/morph 权重写回 three 对象。
 *
 * 红线（`docs/wave2-integration.md` §3-B3）：
 * - **只写** `bone.quaternion` + `センター.position`（以及睡姿的 `センター.quaternion`）；
 * - **不写** `modelRoot` 的 position/scale/rotation（Lead 的 PetScene 摆放 + IdleMotion 负责）；
 * - **不写**其它 `bone.position`；不调 `mesh.pose()/bind()`、不调 `helper.update()/CCDIK`；
 * - 只驱动受控骨（约 20 根 + 6 根发辫），其余 360+ 根保持恒等。
 */
import type { Bone, Object3D, SkinnedMesh } from 'three'

import type { AnimationDebugSnapshot, AnimationInput, AnimationEvent } from '../../core/wave2-contract'
import { MAX_DT_SEC, type Vec3 } from './types'
import { AnimationPipeline, type AnimationFrameOutput, type PipelineRig } from './pipeline'
import {
  EYE_BONES,
  MICRO_BONES,
  POSE_CONTROLLED_BONES,
  REQUIRED_BONES,
  SPRING_BONES,
  validatePoseTable
} from './skeleton'
import { ALL_GESTURES, BASE_POSES, BASE_POSE_META } from './poses'
import { EMOTION_DEFS, EYE_SMILE_MORPHS, SMILE_MORPHS } from './emotion'
import { BLINK_MORPH, BLINK_MORPH_LAUGHING } from './blink'

/** `createPetAnimator` 选项（与 Lead 的接线约定一致）。 */
export interface CreatePetAnimatorOptions {
  mesh: SkinnedMesh
  /** 模型根 Group（PetScene.modelRoot；B3 不写它，保留给未来环境层/朝向；可选）。 */
  root?: Object3D
  /** 注入时钟（毫秒；默认 performance.now；单测传假时钟）。 */
  now?: () => number
  /** 注入随机源（眨眼/待机变体调度；单测 seeded）。 */
  random?: () => number
}

/** B3 对外接口（Lead 接线用）。 */
export interface PetAnimator {
  /** 每帧调用（`PetScene.step` 内、渲染前；dt 已钳制 ≤0.1s）。 */
  update(input: AnimationInput): void
  /** 调试/冒烟：当前动画快照（`window.__aventurineDebug.animation`）。 */
  getDebugSnapshot(): AnimationDebugSnapshot
  /** 调试/冒烟：强制切姿态（返回 false = 未知姿态 id；`'auto'` 清除强制）。 */
  setPose(poseId: string, fadeMs?: number): boolean
  /** 调试/冒烟：强制注视角（度；NaN 清除）。 */
  setGaze(yawDeg: number, pitchDeg: number): void
  /**
   * 骨骼写入开关（Wave 2.5 混合驱动用）：
   * `false` = B3 **只写表情 morph、不写骨骼/センター**（VMD 外部动作层接管骨骼），
   * `true` = 恢复现状（B3 拥有骨骼写入权）。默认 true；切换后下一帧全量写回，无需手动清姿态。
   */
  setBoneWriteEnabled(enabled: boolean): void
}

/** 默认时钟（渲染进程 performance.now；Node 单测应显式注入）。 */
function defaultNow(): number {
  if (typeof performance !== 'undefined' && typeof performance.now === 'function') {
    return performance.now()
  }
  return Date.now()
}

/** 从骨架 rest 数据累加出每根骨的模型空间位置（骨骼 `position` 是相对父骨的 bind 偏移）。 */
function computeRestPositions(bones: readonly Bone[]): Record<string, Vec3> {
  const result: Record<string, Vec3> = {}
  const boneSet = new Set<Object3D>(bones)
  const cache = new Map<Object3D, Vec3>()
  const resolve = (bone: Object3D): Vec3 => {
    const cached = cache.get(bone)
    if (cached) return cached
    const position = (bone as Bone).position
    const parent = bone.parent
    let value: Vec3
    if (parent && boneSet.has(parent)) {
      const parentPos = resolve(parent)
      value = {
        x: parentPos.x + position.x,
        y: parentPos.y + position.y,
        z: parentPos.z + position.z
      }
    } else {
      value = { x: position.x, y: position.y, z: position.z }
    }
    cache.set(bone, value)
    return value
  }
  for (const bone of bones) result[bone.name] = resolve(bone)
  return result
}

/** 从 position attribute 计算 bind 姿势包围盒高度（**不能用** geometry.computeBoundingBox，会把 85 个 morph 并进去）。 */
function computeBindHeight(mesh: SkinnedMesh): number {
  const attribute = mesh.geometry?.getAttribute?.('position')
  if (!attribute || !attribute.array || attribute.count === 0) return 1
  let minY = Number.POSITIVE_INFINITY
  let maxY = Number.NEGATIVE_INFINITY
  for (let index = 0; index < attribute.count; index += 1) {
    const y = attribute.getY(index)
    if (!Number.isFinite(y)) continue
    if (y < minY) minY = y
    if (y > maxY) maxY = y
  }
  if (!Number.isFinite(minY) || !Number.isFinite(maxY) || maxY - minY < 1e-6) return 1
  return maxY - minY
}

/** 收集「姿态/手势/表情可能引用到的 morph 名」（用于启动自检与每帧全量写）。 */
function collectManagedMorphNames(): string[] {
  const names = new Set<string>()
  for (const def of Object.values(EMOTION_DEFS)) {
    for (const part of Object.values(def)) {
      if (part) names.add(part.morph)
    }
  }
  for (const morph of [...SMILE_MORPHS, ...EYE_SMILE_MORPHS]) names.add(morph)
  names.add(BLINK_MORPH)
  names.add(BLINK_MORPH_LAUGHING)
  for (const viseme of ['あ', 'い', 'う', 'え', 'お', 'ん']) names.add(viseme)
  // 材质 morph（由 A2 MaterialMorphController 从 influences 读取）：
  for (const materialMorph of ['照れ', '目影消', '目影濃']) names.add(materialMorph)
  return [...names]
}

/** 归一化 morph 名（PMX 里 `星目 ` 带尾随空格）。 */
function normalizeName(name: string): string {
  return typeof name === 'string' ? name.normalize('NFC').trim() : ''
}

/** 汇总「姿态表/手势/必需骨」里引用的全部骨名（缺失自检用）。 */
function collectRequiredBoneNames(): string[] {
  const names = new Set<string>(REQUIRED_BONES)
  for (const bone of POSE_CONTROLLED_BONES) names.add(bone)
  for (const bone of SPRING_BONES) names.add(bone)
  for (const def of Object.values(BASE_POSES)) {
    for (const bone of Object.keys(def)) names.add(bone)
  }
  for (const gesture of ALL_GESTURES) {
    for (const frame of gesture.keyframes) {
      for (const bone of Object.keys(frame.pose)) names.add(bone)
    }
    if (gesture.mask) for (const bone of gesture.mask) names.add(bone)
  }
  return [...names]
}

/**
 * 创建动画器（Lead 在 PMX 加载完成后调用一次）。
 *
 * 启动自检：必需骨/姿态引用骨缺失 → `missingBones`（调试快照）+ console.warn 一次，不抛。
 */
export function createPetAnimator(options: CreatePetAnimatorOptions): PetAnimator {
  const { mesh } = options
  const now = options.now ?? defaultNow
  const skeleton = mesh.skeleton
  const warnings: string[] = []

  // 1) 骨骼表 & rest 位置
  const boneByName = new Map<string, Bone>()
  for (const bone of skeleton?.bones ?? []) {
    if (!bone) continue
    const normalized = normalizeName(bone.name)
    if (!boneByName.has(normalized)) boneByName.set(normalized, bone)
  }
  if ((skeleton?.bones?.length ?? 0) === 0) {
    console.warn('[animation] SkinnedMesh 没有骨骼，B3 动画降级为 no-op')
  }
  const restPositions = skeleton ? computeRestPositions(skeleton.bones) : {}
  // 骨名 → 父骨名（null = 根）；用于弹簧链根父骨的世界四元数累乘。
  const boneParents: Record<string, string | null> = {}
  for (const bone of skeleton?.bones ?? []) {
    if (!bone) continue
    const name = normalizeName(bone.name)
    const parent = bone.parent
    boneParents[name] =
      parent && (parent as { isBone?: boolean }).isBone === true
        ? normalizeName((parent as Bone).name)
        : null
  }
  const modelHeight = computeBindHeight(mesh)

  // 2) 缺失骨自检（只 warn 一次，不抛）
  const requiredBoneNames = collectRequiredBoneNames()
  const missingBones = requiredBoneNames
    .filter((name) => !boneByName.has(normalizeName(name)))
    .sort()

  // 3) 姿态数据自检（启动一次；错误只 warn）
  const poseValidation = validatePoseTable(BASE_POSES, BASE_POSE_META, ALL_GESTURES)
  if (!poseValidation.ok) {
    for (const error of poseValidation.errors) warnings.push(`[animation] pose 数据问题：${error}`)
  }

  // 4) morph 索引表（name → influence index）
  const dictionary = (mesh.morphTargetDictionary ?? {}) as Record<string, number>
  const morphIndexByName = new Map<string, number>()
  for (const [name, index] of Object.entries(dictionary)) {
    if (!Number.isInteger(index) || index < 0) continue
    const normalized = normalizeName(name)
    if (!morphIndexByName.has(normalized)) morphIndexByName.set(normalized, index)
  }
  const managedMorphNames = collectManagedMorphNames()
  const managedMorphIndices: number[] = []
  const missingMorphs: string[] = []
  for (const name of managedMorphNames) {
    const index = morphIndexByName.get(normalizeName(name))
    if (index === undefined) {
      missingMorphs.push(name)
      continue
    }
    managedMorphIndices.push(index)
  }
  if (missingMorphs.length > 0) {
    warnings.push(`[animation] 模型缺少表情 morph（忽略）：${missingMorphs.join('、')}`)
  }
  const influences = mesh.morphTargetInfluences ?? null
  if (!influences) {
    warnings.push('[animation] morphTargetInfluences 不存在，表情调度降级为 no-op')
  }

  // 5) 受控骨引用表（只写这些骨的 quaternion）
  const ownedBones: Bone[] = []
  const ownedBoneRefs: Array<{ bone: Bone; name: string }> = []
  const seenOwned = new Set<string>()
  for (const name of [
    ...POSE_CONTROLLED_BONES,
    ...SPRING_BONES,
    ...EYE_BONES,
    ...MICRO_BONES,
    'センター'
  ]) {
    const normalized = normalizeName(name)
    if (seenOwned.has(normalized)) continue
    seenOwned.add(normalized)
    const bone = boneByName.get(normalized)
    if (bone) {
      ownedBones.push(bone)
      ownedBoneRefs.push({ bone, name: normalized })
    }
  }
  const centerBone = boneByName.get('センター') ?? null
  const centerRestPosition = centerBone
    ? { x: centerBone.position.x, y: centerBone.position.y, z: centerBone.position.z }
    : null
  // 受控骨数量（粗略自检：本模型应 ≥ 20 根 + 6 发骨）
  if (ownedBones.length < 20) {
    warnings.push(`[animation] 受控骨只有 ${ownedBones.length} 根（预期 ≥ 20），姿态可能不完整`)
  }

  const rig: PipelineRig = {
    restPositions,
    modelHeight,
    missingBones,
    boneParents
  }
  const pipeline = new AnimationPipeline(rig, { random: options.random, initialPose: 'stand' })
  // 保留 root 参数以符合契约；B3 明确**不写**它（Lead 的摆放/IdleMotion 负责）。
  void options.root
  // Wave 2.5：VMD 外部动作激活时 B3 只写 morph（表情/眨眼/口型），骨骼写入权交给 helper。
  let boneWriteEnabled = true
  for (const message of warnings) console.warn(message)

  /** 每帧把管线输出写回 three（只写受控骨 + センター；外部动作激活时跳过①/②）。 */
  const applyFrame = (frame: AnimationFrameOutput): void => {
    if (boneWriteEnabled) {
      // ① 受控骨：全量写（缺失/本帧没有的归零为 bind pose，避免上一帧残留）。
      for (const { bone, name } of ownedBoneRefs) {
        if (name === 'センター') continue
        const quat = frame.boneQuaternions.get(name)
        if (quat) {
          bone.quaternion.set(quat.x, quat.y, quat.z, quat.w)
        } else {
          bone.quaternion.set(0, 0, 0, 1)
        }
      }
      // ② センター：位置平移（贴地补偿 + contrapposto 横向重心）+ 3/4 侧身/翻滚四元数。
      if (centerBone && centerRestPosition) {
        centerBone.position.y = centerRestPosition.y + frame.centerOffsetY
        centerBone.position.x = centerRestPosition.x + frame.centerOffsetX
        const quat = frame.centerQuaternion
        centerBone.quaternion.set(quat.x, quat.y, quat.z, quat.w)
      }
    }
    // ③ 表情：先把受管 morph 全部归零，再写非零（每帧全量，不增量）。
    //    外部 VMD 激活时这一层仍然生效（VMD 只负责骨骼/位移；表情/眨眼/口型由 B3 驱动）。
    if (influences) {
      for (const index of managedMorphIndices) influences[index] = 0
      for (const [name, weight] of frame.morphWeights) {
        const index = morphIndexByName.get(normalizeName(name))
        if (index === undefined || !(weight > 0)) continue
        influences[index] = Math.min(1, Math.max(0, weight))
      }
    }
  }

  return {
    update(input: AnimationInput): void {
      const start = now()
      const safeInput = sanitizeInput(input)
      const frame = pipeline.update(safeInput, now())
      applyFrame(frame)
      // 性能诊断（注入假时钟时为 0；真实时钟下为实际耗时）。
      const elapsed = now() - start
      frame.debug.updateMs = Math.round(elapsed * 1000) / 1000
    },
    getDebugSnapshot(): AnimationDebugSnapshot {
      return pipeline.getDebugSnapshot()
    },
    setPose(poseId: string, fadeMs?: number): boolean {
      return pipeline.setPose(poseId, fadeMs)
    },
    setGaze(yawDeg: number, pitchDeg: number): void {
      pipeline.setGaze(yawDeg, pitchDeg)
    },
    setBoneWriteEnabled(enabled: boolean): void {
      boneWriteEnabled = enabled === true
    }
  }
}

/** 防御性清洗输入（dt 钳制；字段缺失时给安全默认值，避免 Lead 半接线时崩）。 */
function sanitizeInput(input: AnimationInput): AnimationInput {
  const dt = Number.isFinite(input?.dt) ? Math.min(MAX_DT_SEC, Math.max(0, input.dt)) : 0
  const petRect = input?.petRect ?? { x: 0, y: 0, width: 1, height: 1 }
  const motion = input?.motion ?? {
    feet: { x: 0, y: 0 },
    velocity: { x: 0, y: 0 },
    facing: 'front' as const,
    grounded: true,
    surfaceId: null,
    airborne: false
  }
  return {
    dt,
    mood: input?.mood ?? 'idle',
    motion,
    facing: input?.facing ?? motion.facing ?? 'front',
    lookTarget: input?.lookTarget ?? null,
    petRect: {
      x: Number.isFinite(petRect.x) ? petRect.x : 0,
      y: Number.isFinite(petRect.y) ? petRect.y : 0,
      width: Number.isFinite(petRect.width) ? Math.max(1, petRect.width) : 1,
      height: Number.isFinite(petRect.height) ? Math.max(1, petRect.height) : 1
    },
    viewportHeight: Number.isFinite(input?.viewportHeight) ? input.viewportHeight : 1080,
    dragging: Boolean(input?.dragging),
    events: Array.isArray(input?.events) ? (input.events as AnimationEvent[]) : [],
    bubbleText: typeof input?.bubbleText === 'string' ? input.bubbleText : null
  }
}
