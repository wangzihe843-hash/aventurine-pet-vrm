/**
 * 手持道具层（V1 水枪）—— 把外部 GLB 挂到 VRM 手骨，并按当前 clip 切显隐。
 *
 * 设计（见 `docs/research/watergun-prop-plan.md` §3）：
 * - 挂点：`vrm.humanoid.getNormalizedBoneNode('rightHand')` 的**子节点**；一次校准、
 *   零每帧写骨——humanoid 动画驱动 hand 的世界矩阵，子树自动跟随（与 VRMA 管线兼容）。
 *   校准值在 `watergun-attach.json`（从源 .max 的枪位反推，2026-11-09 实测）。
 * - 显隐：`update(clipMeta)` 每帧只看 `shouldHoldHandProp()` 的结果切 `visible`；
 *   **不写任何骨骼**，不违反项目的 single-writer 原则。
 * - 失败降级：GLB 缺失/挂点缺失/bbox 异常都只 warn + 保持隐藏，不抛、不黑屏。
 * - 生命周期：`dispose()` 先从 hand detach 再释放（避免 `VRMUtils.deepDispose` 连带释放）。
 *
 * 私有资产：`assets/props/watergun/watergun.glb` 仅本机开发，禁止二次配布/商用。
 */
import { Box3, Vector3 } from 'three'
import type { LoadingManager, Object3D } from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import type { VRM, VRMHumanBoneName } from '@pixiv/three-vrm'

import { disposeObjectTreeResources } from './dispose'
import { shouldHoldHandProp, type HandPropClipMeta, type HandPropConfig } from './prop-config'

/** 调试/验收快照（`window.__aventurineDebug.handProp`）。 */
export interface HandPropSnapshot {
  id: string
  ready: boolean
  attached: boolean
  visible: boolean
  clipId: string | null
  /** 轨道/挂点失败原因（null = 正常）。 */
  error: string | null
  /** GLB 实测最长边（米；用于尺度 sanity check）。 */
  lengthMeters: number | null
  /** 调试强制显隐是否生效（null = 未强制）。 */
  forcedVisible: boolean | null
}

/** 手持道具层（animator 每帧调用 `update`，可降级为空实现）。 */
export interface HandPropLayer {
  /** 加载 + 挂载完成（失败也 resolve，`snapshot().error` 记录原因）。 */
  readonly ready: Promise<void>
  /** 每帧：按 clip 元信息切显隐（不写骨）。 */
  update(clip: HandPropClipMeta | null): void
  /** 调试：强制显示/隐藏（null = 恢复按 clip 规则）。 */
  debugSetVisible(visible: boolean | null): void
  snapshot(): HandPropSnapshot
  /** 先从 hand 移除再释放（可重复调用）。 */
  dispose(): void
}

export interface CreateHandPropLayerOptions {
  vrm: Pick<VRM, 'humanoid'>
  /** 道具 GLB URL（`pet-asset://assets/props/watergun/watergun.glb`）。 */
  url: string
  config: HandPropConfig
  manager?: LoadingManager
  /** 单测注入（默认 GLTFLoader）。 */
  loadGltf?: (url: string) => Promise<{ scene: Object3D }>
  /** 单测注入（默认 console.warn）。 */
  warn?: (message: string, error?: unknown) => void
}

/** 最长边（米）：用道具自身包围盒做尺度 sanity check。 */
function measureLongestEdge(object: Object3D): number | null {
  const box = new Box3().setFromObject(object)
  if (box.isEmpty()) return null
  const size = new Vector3()
  box.getSize(size)
  return Math.max(size.x, size.y, size.z)
}

function defaultLoadGltf(url: string, manager?: LoadingManager): Promise<{ scene: Object3D }> {
  const loader = new GLTFLoader(manager)
  return loader.loadAsync(url).then((gltf) => ({ scene: gltf.scene }))
}

/**
 * 创建手持道具层。返回对象立即可用（`ready` resolve 前 `update` 为 no-op、道具隐藏）。
 */
export function createHandPropLayer(options: CreateHandPropLayerOptions): HandPropLayer {
  const { vrm, config } = options
  const warn = options.warn ?? ((message: string, error?: unknown) => console.warn(`[hand-prop] ${message}`, error ?? ''))
  const loadGltf = options.loadGltf ?? ((url: string) => defaultLoadGltf(url, options.manager))

  const state = {
    ready: false,
    attached: false,
    visible: false,
    clipId: null as string | null,
    error: null as string | null,
    lengthMeters: null as number | null,
    forcedVisible: null as boolean | null
  }
  let propRoot: Object3D | null = null
  let handNode: Object3D | null = null
  /** 是否已 dispose（R-04：幂等；也拦住 dispose 之后才完成的异步加载，避免再挂回骨架）。 */
  let disposed = false

  const attach = (scene: Object3D): void => {
    const humanoid = vrm.humanoid
    const boneName = config.bone as VRMHumanBoneName
    const normalized = humanoid.getNormalizedBoneNode(boneName)
    const fallback = normalized ?? humanoid.getRawBoneNode(boneName)
    if (fallback === null) {
      state.error = `VRM 缺 hand 骨 ${config.bone}`
      warn(state.error)
      return
    }
    handNode = fallback
    propRoot = scene
    propRoot.name = `hand-prop-${config.propId}`
    propRoot.position.set(config.position[0], config.position[1], config.position[2])
    propRoot.quaternion.set(config.quaternion[0], config.quaternion[1], config.quaternion[2], config.quaternion[3])
    propRoot.scale.setScalar(config.scale)
    propRoot.visible = false
    propRoot.traverse((object) => {
      // 骨下子节点：matrixWorld 由 hand 驱动；静态道具保持默认剔除即可。
      if ((object as { isMesh?: boolean }).isMesh === true) object.frustumCulled = false
    })
    handNode.add(propRoot)
    state.attached = true

    const edge = measureLongestEdge(propRoot)
    state.lengthMeters = edge
    if (edge !== null) {
      const { minLengthMeters, maxLengthMeters } = config.bounds
      if (edge < minLengthMeters || edge > maxLengthMeters) {
        warn(
          `水枪 bbox 最长边 ${edge.toFixed(3)} m 超出预期 [${minLengthMeters}, ${maxLengthMeters}] m；`
            + `检查 GLB 单位/缩放（期望 ≈ ${config.bounds.expectedLengthMeters.toFixed(3)} m）`
        )
      }
    }
  }

  const ready = (async () => {
    try {
      const gltf = await loadGltf(options.url)
      if (disposed) {
        // 页面卸载/animator 先 dispose 了：迟到加载结果直接释放，绝不能再挂回骨架（否则会漏资源）。
        disposeObjectTreeResources(gltf.scene)
        return
      }
      attach(gltf.scene)
    } catch (error) {
      state.error = error instanceof Error ? error.message : String(error)
      warn(`水枪 GLB 加载失败（保持隐藏）：${options.url}`, error)
    } finally {
      state.ready = true
    }
  })()

  return {
    ready,
    update(clip: HandPropClipMeta | null): void {
      state.clipId = clip?.id ?? null
      if (!state.ready || !state.attached) return
      const shouldHold = shouldHoldHandProp(clip, config.policy)
      const target = state.forcedVisible ?? shouldHold
      state.visible = target
      if (propRoot) propRoot.visible = target
    },
    debugSetVisible(visible: boolean | null): void {
      state.forcedVisible = visible
      if (visible === null || !state.attached || !propRoot) return
      state.visible = visible
      propRoot.visible = visible
    },
    snapshot(): HandPropSnapshot {
      return {
        id: config.propId,
        ready: state.ready,
        attached: state.attached,
        visible: state.visible,
        clipId: state.clipId,
        error: state.error,
        lengthMeters: state.lengthMeters,
        forcedVisible: state.forcedVisible
      }
    },
    dispose(): void {
      if (disposed) return
      disposed = true
      const root = propRoot
      propRoot = null
      handNode = null
      state.attached = false
      state.visible = false
      if (root === null) return
      try {
        // 先 detach 再释放：保证 animator.dispose 之后 avatar 的 VRMUtils.deepDispose
        // 不会再遍历到已释放的道具子树（道具资源必须由本层自己释放，见 animator.ts 注释）。
        root.removeFromParent()
      } catch (error) {
        warn('道具 detach 失败（继续释放资源）', error)
      }
      disposeObjectTreeResources(root)
    }
  }
}
