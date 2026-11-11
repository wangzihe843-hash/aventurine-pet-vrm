/**
 * avatar-loader 单测（R-12）：解析失败 → GLB 内存修复 → 重试一次 的多分支，
 * 以及 `collectVrmTextures` / `countVrmSpringBoneChains` 的纯逻辑。
 *
 * 不触网、不加载真实 GLB：`parseVrmGlb` 通过 `deps` 注入 fake loader / fake patcher；
 * 贴图与 spring bone 用 three 最小对象 + fake VRM 结构覆盖。
 */
import {
  BufferGeometry,
  LoadingManager,
  Mesh,
  MeshBasicMaterial,
  Object3D,
  Scene,
  Source,
  Texture,
  type Material
} from 'three'
import type { GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js'
import type { VRM } from '@pixiv/three-vrm'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { VrmGltfPatch } from '@shared/vrm-glb'

import {
  collectVrmTextures,
  countVrmSpringBoneChains,
  loadVrmAvatar,
  parseVrmGlb
} from '../src/renderer/src/vrm/avatar-loader'

const MANAGER = new LoadingManager()
const BASE_URL = 'pet-asset://assets/vrm/'

/** 造一个只用于身份比较的 GLTF 占位对象（parseVrmGlb 只透传不读取）。 */
function gltfStub(tag: string): GLTF {
  return { tag } as unknown as GLTF
}

/** 造一条修复记录。 */
function patchRecord(material: string, key: string): VrmGltfPatch {
  return { materialIndex: 0, material, key, invalidValue: {}, reason: 'test fixture' }
}

/** 读取 mock 第 index 次调用的第一个参数（ArrayBuffer）。 */
function callBuffer(
  parseAsync: { mock: { calls: unknown[][] } },
  index: number
): ArrayBuffer {
  return parseAsync.mock.calls[index]?.[0] as ArrayBuffer
}

describe('parseVrmGlb：首轮解析 / 失败后 GLB 修复重试', () => {
  it('首轮成功：只创建 1 个 loader、不调用 patch', async () => {
    const first = gltfStub('first')
    const parseAsync = vi.fn(async (): Promise<GLTF> => first)
    const createLoader = vi.fn(() => ({ parseAsync }))
    const patchGlb = vi.fn()
    const data = new ArrayBuffer(8)

    await expect(
      parseVrmGlb(data, BASE_URL, MANAGER, true, { createLoader, patchGlb })
    ).resolves.toBe(first)

    expect(createLoader).toHaveBeenCalledTimes(1)
    expect(createLoader).toHaveBeenCalledWith(MANAGER)
    expect(parseAsync).toHaveBeenCalledTimes(1)
    expect(parseAsync).toHaveBeenCalledWith(data, BASE_URL)
    expect(patchGlb).not.toHaveBeenCalled()
  })

  it('首轮失败 + patch 命中 + 重试成功：patch 收到原 buffer，重试收到修复后字节', async () => {
    const retried = gltfStub('retried')
    const parseAsync = vi
      .fn<(data: ArrayBuffer | string, baseUrl: string) => Promise<GLTF>>()
      .mockRejectedValueOnce(new Error('mtoon bad texture'))
      .mockResolvedValueOnce(retried)
    const createLoader = vi.fn(() => ({ parseAsync }))
    const patchGlb = vi.fn(() => ({
      data: new Uint8Array([1, 2, 3, 4]),
      patches: [patchRecord('珍珠', 'shadeMultiplyTexture')]
    }))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const data = new ArrayBuffer(8)

    await expect(
      parseVrmGlb(data, BASE_URL, MANAGER, true, { createLoader, patchGlb })
    ).resolves.toBe(retried)

    expect(createLoader).toHaveBeenCalledTimes(2)
    expect(parseAsync).toHaveBeenCalledTimes(2)
    expect(patchGlb).toHaveBeenCalledTimes(1)
    expect(patchGlb).toHaveBeenCalledWith(data)
    expect(Array.from(new Uint8Array(callBuffer(parseAsync, 1)))).toEqual([1, 2, 3, 4])
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('已内存修复 1 处 MToon 非法贴图引用')
    )
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('珍珠[shadeMultiplyTexture]'))
  })

  it('首轮失败 + patch 无命中：保留原始错误、不重试', async () => {
    const parseAsync = vi.fn(async (): Promise<GLTF> => {
      throw new Error('first boom')
    })
    const createLoader = vi.fn(() => ({ parseAsync }))
    const patchGlb = vi.fn(() => ({ data: new Uint8Array([9]), patches: [] }))

    const error = await parseVrmGlb(new ArrayBuffer(8), BASE_URL, MANAGER, true, {
      createLoader,
      patchGlb
    }).catch((caught: unknown) => caught)

    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toContain('未发现可修复的 MToon 贴图引用缺陷')
    expect((error as Error).message).toContain('first boom')
    expect(createLoader).toHaveBeenCalledTimes(1)
    expect(parseAsync).toHaveBeenCalledTimes(1)
    expect(patchGlb).toHaveBeenCalledTimes(1)
  })

  it('patch 抛错：错误信息同时保留解析错误与修复错误', async () => {
    const parseAsync = vi.fn(async (): Promise<GLTF> => {
      throw new Error('first boom')
    })
    const patchGlb = vi.fn((): { data: Uint8Array; patches: VrmGltfPatch[] } => {
      throw new Error('patch exploded')
    })

    const error = await parseVrmGlb(new ArrayBuffer(8), BASE_URL, MANAGER, true, {
      createLoader: () => ({ parseAsync }),
      patchGlb
    }).catch((caught: unknown) => caught)

    expect(error).toBeInstanceOf(Error)
    const message = (error as Error).message
    expect(message).toContain('GLB 内存修复不可用')
    expect(message).toContain('first boom')
    expect(message).toContain('patch exploded')
    expect(parseAsync).toHaveBeenCalledTimes(1)
  })

  it('patch 命中但重试仍失败：错误信息标注已重试并保留重试错误', async () => {
    const parseAsync = vi
      .fn<(data: ArrayBuffer | string, baseUrl: string) => Promise<GLTF>>()
      .mockRejectedValueOnce(new Error('first boom'))
      .mockRejectedValueOnce(new Error('retry boom'))
    vi.spyOn(console, 'warn').mockImplementation(() => {})

    const error = await parseVrmGlb(new ArrayBuffer(8), BASE_URL, MANAGER, true, {
      createLoader: () => ({ parseAsync }),
      patchGlb: () => ({
        data: new Uint8Array([7]),
        patches: [patchRecord('珍珠', 'shadeMultiplyTexture')]
      })
    }).catch((caught: unknown) => caught)

    expect(error).toBeInstanceOf(Error)
    const message = (error as Error).message
    expect(message).toContain('已尝试 GLB 内存修复重试')
    expect(message).toContain('retry boom')
    expect(parseAsync).toHaveBeenCalledTimes(2)
  })

  it('patchGlbOnDemand=false：直接抛首轮错误，不调用 patch / 不重试', async () => {
    const firstError = new Error('no patch allowed')
    const parseAsync = vi.fn(async (): Promise<GLTF> => {
      throw firstError
    })
    const patchGlb = vi.fn(() => ({ data: new Uint8Array([1]), patches: [] }))

    const error = await parseVrmGlb(new ArrayBuffer(8), BASE_URL, MANAGER, false, {
      createLoader: () => ({ parseAsync }),
      patchGlb
    }).catch((caught: unknown) => caught)

    expect(error).toBe(firstError)
    expect(patchGlb).not.toHaveBeenCalled()
    expect(parseAsync).toHaveBeenCalledTimes(1)
  })
})

/* -------------------------------------------------------------------------- */
/* 主入口下载失败                                                              */
/* -------------------------------------------------------------------------- */

describe('loadVrmAvatar：下载失败', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('HTTP 非 2xx：抛带状态码与 URL 的错误，不进入解析', async () => {
    const fetchMock = vi.fn(async () => ({ ok: false, status: 404 }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(
      loadVrmAvatar({
        url: 'pet-asset://assets/vrm/missing.vrm',
        patchGlbOnDemand: true
      })
    ).rejects.toThrow(
      'VRM 下载失败：HTTP 404（pet-asset://assets/vrm/missing.vrm）'
    )
    expect(fetchMock).toHaveBeenCalledWith('pet-asset://assets/vrm/missing.vrm')
  })
})

/* -------------------------------------------------------------------------- */
/* 贴图收集                                                                    */
/* -------------------------------------------------------------------------- */

/** 构造只带 scene（+ 可选 springBoneManager）的 fake VRM。 */
function fakeVrm(scene: Object3D, springBoneManager?: unknown): VRM {
  return { scene, springBoneManager } as unknown as VRM
}

describe('collectVrmTextures：材质贴图收集与去重', () => {
  it('覆盖标准贴图槽 / MToon uniforms / material 数组，按 source 去重', () => {
    const scene = new Scene()

    // 两张不同 Texture 共享同一个 Source：应按 source 去重。
    const sharedSource = new Source()
    const mapTexture = new Texture()
    mapTexture.source = sharedSource
    const sharedSourceTexture = new Texture()
    sharedSourceTexture.source = sharedSource

    const normalTexture = new Texture()
    const uniformTexture = new Texture()
    const mtoonLike = {
      uniforms: {
        shadeMultiplyTexture: { value: sharedSourceTexture },
        matcapTexture: { value: uniformTexture },
        someScalar: { value: 1 }
      }
    } as unknown as Material

    const standard = new MeshBasicMaterial({ map: mapTexture })
    const multiMaterial = new MeshBasicMaterial({ map: normalTexture })

    const meshA = new Mesh(new BufferGeometry(), standard)
    const meshB = new Mesh(new BufferGeometry(), [multiMaterial, mtoonLike])
    // 同一材质再次出现：不应重复收集。
    const meshC = new Mesh(new BufferGeometry(), standard)
    scene.add(meshA, meshB, meshC)

    expect(collectVrmTextures(fakeVrm(scene))).toEqual([
      mapTexture,
      normalTexture,
      uniformTexture
    ])
  })

  it('无 source 的贴图按对象身份去重；非 Mesh 对象被忽略', () => {
    const scene = new Scene()
    const fakeTexture = { isTexture: true } as unknown as Texture
    const meshLike = new Mesh(new BufferGeometry(), {
      uniforms: {
        a: { value: fakeTexture },
        b: { value: fakeTexture }
      }
    } as unknown as Material)
    const group = new Object3D()
    group.add(meshLike)
    group.add(new Object3D())
    scene.add(group)

    expect(collectVrmTextures(fakeVrm(scene))).toEqual([fakeTexture])
  })
})

/* -------------------------------------------------------------------------- */
/* spring bone 链数                                                            */
/* -------------------------------------------------------------------------- */

describe('countVrmSpringBoneChains：运行时 springBoneManager 结构', () => {
  function bones(...items: Object3D[]): Set<{ bone: Object3D }> {
    return new Set(items.map((bone) => ({ bone })))
  }

  it('无 springBoneManager / 空 joints → 0', () => {
    expect(countVrmSpringBoneChains(fakeVrm(new Object3D()))).toBe(0)
    expect(
      countVrmSpringBoneChains(fakeVrm(new Object3D(), { joints: new Set() }))
    ).toBe(0)
  })

  it('优先使用显式 springBoneChains 数组长度', () => {
    const vrm = fakeVrm(new Object3D(), {
      joints: bones(new Object3D()),
      springBoneChains: [{}, {}]
    })
    expect(countVrmSpringBoneChains(vrm)).toBe(2)
  })

  it('无显式 API 时按关节骨链根计数（线性链 = 1，多个根 = 多链）', () => {
    const root = new Object3D()
    const mid = new Object3D()
    const leaf = new Object3D()
    root.add(mid)
    mid.add(leaf)

    const otherRoot = new Object3D()
    const otherChild = new Object3D()
    otherRoot.add(otherChild)

    const vrm = fakeVrm(new Object3D(), {
      joints: bones(root, mid, leaf, otherRoot, otherChild)
    })
    expect(countVrmSpringBoneChains(vrm)).toBe(2)
  })

  it('链根不是关节骨的祖先时仍正确计为 1 条链', () => {
    const staticRoot = new Object3D()
    const joint = new Object3D()
    staticRoot.add(joint)
    const vrm = fakeVrm(new Object3D(), { joints: bones(joint) })
    expect(countVrmSpringBoneChains(vrm)).toBe(1)
  })
})
