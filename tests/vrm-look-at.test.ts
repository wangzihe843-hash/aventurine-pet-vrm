/**
 * V6/V7 procedural look-at 层单测：头/颈/眼 additive 旋转 + 调试覆盖 + 非 procedural 模式 no-op，
 * 以及 V7 humanoid 适配的两条用户反馈：
 * 1. 移动类 mood（walk/climb/fall/drag/grabWindow）不追鼠标（目标 yaw≈0，头随身体朝运动方向）；
 * 2. 静止注视按 facing 做模型局部换算（yaw_local = yaw_world − facingYaw，clamp ±maxYaw）。
 *
 * 用真实 three 的 Object3D 作为 normalized 骨节点（Node 环境无 GL 也能跑）。
 */
import { Group } from 'three'
import { describe, expect, it } from 'vitest'

import type { AnimationInput, Facing } from '../src/renderer/src/core/wave2-contract'
import {
  createVrmLookAtLayer,
  FACING_YAW_DEG,
  facingYawDeg,
  pointerWorldYawDeg,
  shouldSuppressMouseLook
} from '../src/renderer/src/vrm/look-at'
import type { VrmAvatar } from '../src/renderer/src/vrm/runtime-types'

function makeAvatar(mode: 'procedural' | 'vrm' | 'none' = 'procedural'): {
  avatar: VrmAvatar
  nodes: Record<string, Group>
} {
  const nodes: Record<string, Group> = {
    neck: new Group(),
    head: new Group(),
    leftEye: new Group(),
    rightEye: new Group()
  }
  const humanoid = {
    getNormalizedBoneNode: (name: string) => nodes[name] ?? null
  }
  const avatar = {
    asset: {
      id: 'test',
      file: 'vrm/test.vrm',
      heightMeters: 1.7,
      expressions: {},
      lookAt: { mode, maxYawDeg: 35, maxPitchDeg: 20 }
    },
    vrm: { humanoid },
    expressionNames: [],
    materialNames: [],
    capabilities: {},
    restHeightMeters: 1.7,
    restFeetY: 0,
    bodyAspectRatio: 0.5,
    hipsRestHeight: 1,
    textureCount: 0,
    missingTextures: [],
    vertexCount: 0,
    triangleCount: 0,
    dispose: () => undefined
  } as unknown as VrmAvatar
  return { avatar, nodes }
}

function makeInput(overrides: Partial<AnimationInput> = {}): AnimationInput {
  return {
    dt: 0.1,
    mood: 'idle',
    motion: {
      feet: { x: 0, y: 0 },
      velocity: { x: 0, y: 0 },
      facing: 'front',
      grounded: true,
      surfaceId: null,
      airborne: false
    },
    facing: 'front',
    lookTarget: { x: 400, y: 100 },
    petRect: { x: 0, y: 0, width: 200, height: 600 },
    viewportHeight: 900,
    dragging: false,
    events: [],
    bubbleText: null,
    ...overrides
  }
}

/** 连续喂 count 帧同一输入（让指数平滑收敛）。 */
function settle(
  layer: ReturnType<typeof createVrmLookAtLayer>,
  input: AnimationInput,
  count = 40
): { yaw: number; pitch: number } {
  for (let index = 0; index < count; index += 1) layer.update(input)
  const snapshot = layer.snapshot()
  return { yaw: snapshot.yaw as number, pitch: snapshot.pitch as number }
}

/** 侧视：宠物矩形宽 200、头部锚点 x=100，指针 x=400 → dx=300。 */
const POINTER_FAR_RIGHT = { x: 400, y: 100 }

describe('pointerWorldYawDeg / facingYawDeg：角度口径', () => {
  it('dx=0.55×宽 时世界角正好 = maxYaw（与 V1 线性映射饱和点一致）', () => {
    expect(pointerWorldYawDeg(110, 200, 35)).toBeCloseTo(35, 6)
    expect(pointerWorldYawDeg(-110, 200, 35)).toBeCloseTo(-35, 6)
    expect(pointerWorldYawDeg(0, 200, 35)).toBeCloseTo(0, 6)
  })

  it('世界角随偏移单调增大、不会超过 ±90°；非法输入安全归零', () => {
    const values = [0, 50, 110, 300, 1000].map((dx) => pointerWorldYawDeg(dx, 200, 35))
    for (let index = 1; index < values.length; index += 1) {
      expect(values[index]).toBeGreaterThan(values[index - 1])
      expect(values[index]).toBeLessThan(90)
    }
    expect(pointerWorldYawDeg(Number.NaN, 200, 35)).toBe(0)
    // 非法宽度按 1 兜底，角度仍有限且在 (−90, 90) 内（调用方随后还会 clamp）。
    const tinyWidth = pointerWorldYawDeg(100, 0, 35)
    expect(Number.isFinite(tinyWidth)).toBe(true)
    expect(tinyWidth).toBeLessThan(90)
  })

  it('facingYawDeg 与 pet-scene-vrm 的 MOVING_FACING_YAW_RAD 同号同值（left=−90/right=+90）', () => {
    expect(FACING_YAW_DEG).toEqual({ front: 0, left: -90, right: 90 })
    expect(facingYawDeg('left')).toBe(-90)
    expect(facingYawDeg('right')).toBe(90)
    expect(facingYawDeg('front')).toBe(0)
    expect(facingYawDeg(null)).toBe(0)
  })

  it('shouldSuppressMouseLook：移动类 mood 或 dragging=true 时抑制鼠标注视', () => {
    expect(shouldSuppressMouseLook('idle', false)).toBe(false)
    expect(shouldSuppressMouseLook('sit', false)).toBe(false)
    expect(shouldSuppressMouseLook('pat', false)).toBe(false)
    for (const mood of ['walk', 'climb', 'fall', 'drag', 'grabWindow'] as const) {
      expect(shouldSuppressMouseLook(mood, false)).toBe(true)
    }
    expect(shouldSuppressMouseLook('idle', true)).toBe(true)
  })
})

describe('createVrmLookAtLayer（procedural）', () => {
  it('指针在右侧 → 头/颈/眼出现正 yaw 旋转，snapshot 收敛到正角度', () => {
    const { avatar, nodes } = makeAvatar('procedural')
    const layer = createVrmLookAtLayer({ avatar })
    // 指针在宠物右侧（像素 x=400 > 中心 100）。
    const settled = settle(layer, makeInput())
    expect(settled.yaw).toBeGreaterThan(5)
    // head/neck 的局部 quaternion 不再是 identity（有 additive 旋转）。
    expect(nodes.head.quaternion.w).toBeLessThan(0.999)
    expect(nodes.neck.quaternion.w).toBeLessThan(0.999)
    // 平滑收敛不会超过 maxYaw。
    expect(Math.abs(settled.yaw)).toBeLessThanOrEqual(35.0001)
  })

  it('setOverride(25,0) → snapshot 精确 25°，并覆盖指针输入', () => {
    const { avatar } = makeAvatar('procedural')
    const layer = createVrmLookAtLayer({ avatar })
    layer.setOverride(25, 0)
    layer.update(makeInput({ lookTarget: null }))
    expect(layer.snapshot().yaw).toBeCloseTo(25, 5)
    // 清除覆盖（NaN）后回到输入驱动/回正。
    layer.setOverride(Number.NaN, Number.NaN)
    expect(layer.snapshot().yaw).toBeCloseTo(25, 5) // 尚未 update，仍保留上一帧
  })

  it('上下俯仰方向：指针在上方 → 头骨局部 X 旋转为负（抬头），指针下方为正（低头）', () => {
    // 指针在头顶上方（y 小于头部锚点）→ snapshot.pitch > 0（向上），头局部 quaternion.x < 0。
    const up = makeAvatar('procedural')
    const upLayer = createVrmLookAtLayer({ avatar: up.avatar })
    for (let index = 0; index < 40; index += 1) {
      upLayer.update(makeInput({ lookTarget: { x: 100, y: 10 } }))
    }
    expect(upLayer.snapshot().pitch as number).toBeGreaterThan(1)
    expect(up.nodes.head.quaternion.x).toBeLessThan(0)

    // 指针在头部下方 → snapshot.pitch < 0（向下），头局部 quaternion.x > 0。
    const down = makeAvatar('procedural')
    const downLayer = createVrmLookAtLayer({ avatar: down.avatar })
    for (let index = 0; index < 40; index += 1) {
      downLayer.update(makeInput({ lookTarget: { x: 100, y: 500 } }))
    }
    expect(downLayer.snapshot().pitch as number).toBeLessThan(-1)
    expect(down.nodes.head.quaternion.x).toBeGreaterThan(0)
  })

  it('lookTarget=null → 角度指数回正（不瞬间跳变）', () => {
    const { avatar } = makeAvatar('procedural')
    const layer = createVrmLookAtLayer({ avatar })
    for (let index = 0; index < 40; index += 1) layer.update(makeInput())
    const before = layer.snapshot().yaw as number
    expect(before).toBeGreaterThan(5)
    for (let index = 0; index < 200; index += 1) layer.update(makeInput({ lookTarget: null }))
    expect(Math.abs(layer.snapshot().yaw as number)).toBeLessThan(0.01)
  })

  it('mode=vrm（内建 lookAt）：no-op，不改骨骼、snapshot 为 null', () => {
    const { avatar, nodes } = makeAvatar('vrm')
    const layer = createVrmLookAtLayer({ avatar })
    for (let index = 0; index < 10; index += 1) layer.update(makeInput())
    expect(layer.snapshot()).toEqual({ yaw: null, pitch: null })
    expect(nodes.head.quaternion.w).toBeCloseTo(1, 6)
  })
})

/* ========================================================================== */
/* V7 规则 1：移动类 mood 不追鼠标（走路时头朝走路方向）                        */
/* ========================================================================== */

describe('V7：移动类 mood 不追鼠标（头随身体朝运动方向）', () => {
  it('walk/climb/fall/drag/grabWindow + 指针在侧边 → 目标 yaw≈0（不扭头看镜头）', () => {
    for (const mood of ['walk', 'climb', 'fall', 'drag', 'grabWindow'] as const) {
      const { avatar } = makeAvatar('procedural')
      const layer = createVrmLookAtLayer({ avatar })
      const settled = settle(
        layer,
        makeInput({ mood, facing: 'right', lookTarget: POINTER_FAR_RIGHT }),
        60
      )
      expect(Math.abs(settled.yaw)).toBeLessThan(0.2)
      expect(Math.abs(settled.pitch)).toBeLessThan(0.2)
    }
  })

  it('从静止注视（yaw≈35）切到 walk → 平滑衰减到 0（不瞬间甩头）', () => {
    const { avatar } = makeAvatar('procedural')
    const layer = createVrmLookAtLayer({ avatar })
    const idleYaw = settle(layer, makeInput(), 40).yaw
    expect(idleYaw).toBeGreaterThan(30)
    // 切 walk 的第一帧仍在平滑过渡中（不是瞬间归零）。
    layer.update(makeInput({ mood: 'walk', facing: 'right' }))
    const firstWalk = layer.snapshot().yaw as number
    expect(firstWalk).toBeLessThan(idleYaw)
    expect(firstWalk).toBeGreaterThan(0)
    // 足够多帧后收敛到 0。
    const settled = settle(layer, makeInput({ mood: 'walk', facing: 'right' }), 60)
    expect(Math.abs(settled.yaw)).toBeLessThan(0.2)
  })

  it('dragging=true 兜底：即使 mood 仍是 idle 也不追鼠标', () => {
    const { avatar } = makeAvatar('procedural')
    const layer = createVrmLookAtLayer({ avatar })
    const settled = settle(
      layer,
      makeInput({ mood: 'idle', dragging: true, lookTarget: POINTER_FAR_RIGHT }),
      40
    )
    expect(Math.abs(settled.yaw)).toBeLessThan(0.2)
  })

  it('调试覆盖（setOverride）优先于移动抑制：冒烟强制角口径不变', () => {
    const { avatar } = makeAvatar('procedural')
    const layer = createVrmLookAtLayer({ avatar })
    layer.setOverride(25, 0)
    layer.update(makeInput({ mood: 'walk', dragging: true, lookTarget: POINTER_FAR_RIGHT }))
    expect(layer.snapshot().yaw).toBeCloseTo(25, 5)
  })
})

/* ========================================================================== */
/* V7 规则 2：静止注视按 facing 做模型局部换算                                  */
/* ========================================================================== */

describe('V7：静止注视的 facing 局部化（yaw_local = yaw_world − facingYaw）', () => {
  /** dx=300、rect 宽 200 → 世界 yaw≈62.4°（见 pointerWorldYawDeg）。 */
  const worldYaw = pointerWorldYawDeg(300, 200, 35)

  it('front：直接用世界角（指针远右 → clamp 到 maxYaw=35）', () => {
    const { avatar } = makeAvatar('procedural')
    const layer = createVrmLookAtLayer({ avatar })
    const settled = settle(layer, makeInput({ facing: 'front' }), 40)
    expect(worldYaw).toBeGreaterThan(60)
    expect(settled.yaw).toBeCloseTo(35, 1)
  })

  it('facing=right：世界角减 90° → 局部约 −27.6°（不是把世界角直接加到已转 90° 的头上）', () => {
    const { avatar } = makeAvatar('procedural')
    const layer = createVrmLookAtLayer({ avatar })
    const settled = settle(layer, makeInput({ facing: 'right' }), 40)
    const expected = Math.max(-35, Math.min(35, worldYaw - FACING_YAW_DEG.right))
    expect(expected).toBeLessThan(-20)
    expect(settled.yaw).toBeCloseTo(expected, 1)
    // 与 front 的“世界角”明显不同：若忘记局部化会得到 +35。
    expect(settled.yaw).toBeLessThan(0)
  })

  it('facing=left：世界角减 −90° 后超上限 → clamp 到 +35（左右对称）', () => {
    const { avatar } = makeAvatar('procedural')
    const layer = createVrmLookAtLayer({ avatar })
    const settled = settle(layer, makeInput({ facing: 'left' }), 40)
    const expected = Math.max(-35, Math.min(35, worldYaw - FACING_YAW_DEG.left))
    expect(expected).toBe(35) // 62.4 + 90 = 152.4 → clamp
    expect(settled.yaw).toBeCloseTo(35, 1)
  })

  it('facing=right + 指针远到接近运动方向 → 局部 yaw 接近 0（朝前方看，不扭向镜头）', () => {
    const { avatar } = makeAvatar('procedural')
    const layer = createVrmLookAtLayer({ avatar })
    // dx=900（指针 x=1000）→ 世界角 ≈ 80.1°；减 90° 后 ≈ −9.9°。
    const far = pointerWorldYawDeg(900, 200, 35)
    const settled = settle(layer, makeInput({ facing: 'right', lookTarget: { x: 1000, y: 100 } }), 40)
    expect(far).toBeGreaterThan(75)
    expect(settled.yaw).toBeCloseTo(Math.max(-35, Math.min(35, far - 90)), 1)
    expect(Math.abs(settled.yaw)).toBeLessThan(20)
  })

  it('局部化后钳制：任何 facing 下 |yaw| 不超过 maxYaw', () => {
    const facings: Facing[] = ['front', 'left', 'right']
    for (const facing of facings) {
      const { avatar } = makeAvatar('procedural')
      const layer = createVrmLookAtLayer({ avatar })
      for (const lookTarget of [
        { x: -1000, y: 100 },
        { x: 1000, y: 100 },
        { x: 400, y: -500 },
        { x: 400, y: 900 }
      ]) {
        const settled = settle(layer, makeInput({ facing, lookTarget }), 60)
        expect(Math.abs(settled.yaw)).toBeLessThanOrEqual(35.0001)
        expect(Math.abs(settled.pitch)).toBeLessThanOrEqual(20.0001)
        expect(Number.isFinite(settled.yaw)).toBe(true)
      }
    }
  })
})
