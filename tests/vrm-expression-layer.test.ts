/**
 * V6 表情层单测：manifest/clip 加载 → VRMExpressionDriver 合成 → expressionManager 写入。
 *
 * 用最小 fake `VrmAvatar`（不构造真 VRM/GL）；只验证「加载/触发/写入/降级」链路。
 */
import { describe, expect, it, vi } from 'vitest'

import type { AnimationInput } from '../src/renderer/src/core/wave2-contract'
import type { VrmAvatar } from '../src/renderer/src/vrm/runtime-types'
import { createVrmExpressionLayer } from '../src/renderer/src/vrm/expression-layer'

const MANIFEST = {
  schemaVersion: 1,
  clips: [
    {
      id: 'faceSmile',
      set: 'mate',
      file: 'mate/faceSmile.json',
      loop: true,
      fps: 30,
      frames: 3,
      duration: 0.1,
      priority: 1,
      triggers: ['pet'],
      tags: ['face'],
      note: 'test'
    }
  ]
}

const CLIP = {
  schemaVersion: 1,
  id: 'faceSmile',
  source: 'mate',
  fps: 30,
  frames: 3,
  duration: 0.1,
  loop: true,
  tracks: { aa: [0.5, 0.5, 0.5] }
}

function makeAvatar(): {
  avatar: VrmAvatar
  setValue: ReturnType<typeof vi.fn>
  expressionNames: string[]
} {
  const expressionNames = ['blink', 'happy', 'aa', 'ih', 'ou', 'ee', 'oh', 'sad']
  const setValue = vi.fn()
  const avatar = {
    asset: {
      id: 'test',
      file: 'vrm/test.vrm',
      heightMeters: 1.7,
      expressions: { blink: 'blink', happy: 'happy' },
      lookAt: { mode: 'procedural', maxYawDeg: 35, maxPitchDeg: 20 }
    },
    vrm: { expressionManager: { setValue } },
    expressionNames,
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
  return { avatar, setValue, expressionNames }
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
    lookTarget: null,
    petRect: { x: 0, y: 0, width: 200, height: 600 },
    viewportHeight: 900,
    dragging: false,
    events: [],
    bubbleText: null,
    ...overrides
  }
}

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 20))

describe('createVrmExpressionLayer', () => {
  it('加载 manifest + clip，pat 事件触发写入表达式权重', async () => {
    const { avatar, setValue } = makeAvatar()
    const fetchText = vi.fn(async (url: string) => {
      if (url.endsWith('expressions/manifest.json')) return JSON.stringify(MANIFEST)
      if (url.endsWith('expressions/mate/faceSmile.json')) return JSON.stringify(CLIP)
      throw new Error(`unexpected url: ${url}`)
    })
    const layer = createVrmExpressionLayer({ avatar, fetchText, random: () => 0.5 })
    await layer.init()
    await flush()
    expect(layer.ready).toBe(true)

    layer.update(makeInput({ events: [{ kind: 'pat' }] }), 0.1)
    expect(setValue).toHaveBeenCalled()
    const snapshot = layer.snapshot()
    expect(snapshot.ready).toBe(true)
    expect(snapshot.weights.aa).toBeGreaterThan(0)
    expect(snapshot.clipId).not.toBeNull()
  })

  it('眨眼（forceBlink）写入 blink 通道且 snapshot.blink > 0', async () => {
    const { avatar, setValue } = makeAvatar()
    const fetchText = async (url: string): Promise<string> => {
      if (url.endsWith('manifest.json')) return JSON.stringify(MANIFEST)
      return JSON.stringify(CLIP)
    }
    const layer = createVrmExpressionLayer({ avatar, fetchText, random: () => 0.5 })
    await layer.init()
    await flush()
    layer.forceBlink()
    // 眨眼有 closing/opening 相位：连续推进几帧后应出现非零权重。
    let seen = 0
    for (let index = 0; index < 8; index += 1) {
      layer.update(makeInput({ events: [] }), 0.033)
      seen = Math.max(seen, layer.snapshot().blink)
    }
    expect(seen).toBeGreaterThan(0)
    const blinkWrites = setValue.mock.calls.filter((call) => call[0] === 'blink' && Number(call[1]) > 0)
    expect(blinkWrites.length).toBeGreaterThan(0)
  })

  it('manifest 不可用：ready=false、update 不抛且不写 expression', async () => {
    const { avatar, setValue } = makeAvatar()
    const fetchText = async (): Promise<string> => {
      throw new Error('offline')
    }
    const layer = createVrmExpressionLayer({ avatar, fetchText })
    await layer.init()
    expect(layer.ready).toBe(false)
    expect(() => layer.update(makeInput(), 0.016)).not.toThrow()
    expect(setValue).not.toHaveBeenCalled()
  })

  it('enabled=false：不加载、不写', async () => {
    const { avatar, setValue } = makeAvatar()
    const fetchText = vi.fn(async () => JSON.stringify(MANIFEST))
    const layer = createVrmExpressionLayer({ avatar, fetchText, enabled: false })
    await layer.init()
    expect(fetchText).not.toHaveBeenCalled()
    expect(layer.ready).toBe(false)
    layer.update(makeInput(), 0.016)
    expect(setValue).not.toHaveBeenCalled()
  })

  it('自定义表情增强：pat(pet) 触发照れ，且模型缺该通道时跳过', async () => {
    const { avatar, setValue } = makeAvatar()
    // 模拟目标模型：含 custom expression「照れ」。
    avatar.expressionNames = ['blink', 'happy', 'aa', '照れ'] as unknown as readonly string[]
    const fetchText = async (url: string): Promise<string> => {
      if (url.endsWith('manifest.json')) return JSON.stringify(MANIFEST)
      return JSON.stringify(CLIP)
    }
    const layer = createVrmExpressionLayer({ avatar, fetchText, random: () => 0.5 })
    await layer.init()
    await flush()
    // 连续推进若干帧，让自定义权重平滑到目标值。
    for (let index = 0; index < 20; index += 1) {
      layer.update(makeInput({ events: [{ kind: 'pat' }] }), 0.05)
    }
    expect(layer.snapshot().weights['照れ'] ?? 0).toBeGreaterThan(0.2)
    const writes = setValue.mock.calls.filter((call) => call[0] === '照れ' && Number(call[1]) > 0)
    expect(writes.length).toBeGreaterThan(0)
  })

  it('不认识的表达式名不写入（避免对模型未定义通道 setValue）', async () => {
    const { avatar, setValue } = makeAvatar()
    avatar.expressionNames = ['blink'] as unknown as readonly string[]
    // 重新用裁剪过可用名的 avatar 不可变（readonly），这里只验证清空后不会写 aa。
    const fetchText = async (url: string): Promise<string> => {
      if (url.endsWith('manifest.json')) return JSON.stringify(MANIFEST)
      return JSON.stringify(CLIP)
    }
    const layer = createVrmExpressionLayer({ avatar, fetchText, random: () => 0.5 })
    await layer.init()
    await flush()
    layer.update(makeInput({ events: [{ kind: 'pat' }] }), 0.1)
    const aaWrites = setValue.mock.calls.filter((call) => call[0] === 'aa' && Number(call[1]) > 0)
    expect(aaWrites).toHaveLength(0)
  })
})
