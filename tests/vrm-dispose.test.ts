/**
 * R-01/R-04：three.js 子树资源释放工具 + 手持道具层 dispose 单测。
 *
 * 环境：node（真实 three 对象，不实例化 WebGLRenderer —— dispose 只是事件通知，不需要 GL 上下文）。
 * 覆盖：
 * - geometry/material/texture 各释放一次；
 * - 共享 geometry/material/texture（同子树/跨材质）只释放一次；
 * - 材质数组、null/undefined 容错；
 * - `createHandPropLayer().dispose()`：先 detach 再释放道具子树；幂等；迟到加载结果也会被释放。
 */
import { BoxGeometry, Group, Mesh, MeshBasicMaterial, Texture } from 'three'
import { describe, expect, it, vi } from 'vitest'

import { disposeMaterialResources, disposeObjectTreeResources } from '../src/renderer/src/vrm/dispose'
import type { HandPropConfig } from '../src/renderer/src/vrm/prop-config'
import { createHandPropLayer } from '../src/renderer/src/vrm/prop-layer'

function makeMesh(
  geometry: BoxGeometry = new BoxGeometry(),
  material: MeshBasicMaterial | MeshBasicMaterial[] = new MeshBasicMaterial()
): Mesh {
  return new Mesh(geometry, material)
}

describe('vrm/dispose：子树 geometry/material/texture 释放', () => {
  it('释放子树内 geometry/material/texture 各一次', () => {
    const geometry = new BoxGeometry()
    const texture = new Texture()
    const material = new MeshBasicMaterial({ map: texture })
    const root = new Group()
    root.add(makeMesh(geometry, material))

    const geometryDispose = vi.spyOn(geometry, 'dispose')
    const materialDispose = vi.spyOn(material, 'dispose')
    const textureDispose = vi.spyOn(texture, 'dispose')

    disposeObjectTreeResources(root)

    expect(geometryDispose).toHaveBeenCalledTimes(1)
    expect(materialDispose).toHaveBeenCalledTimes(1)
    expect(textureDispose).toHaveBeenCalledTimes(1)
  })

  it('共享 geometry/material/texture 只释放一次（Set 去重）', () => {
    const geometry = new BoxGeometry()
    const texture = new Texture()
    const material = new MeshBasicMaterial({ map: texture })
    const root = new Group()
    root.add(makeMesh(geometry, material), makeMesh(geometry, material))

    const geometryDispose = vi.spyOn(geometry, 'dispose')
    const materialDispose = vi.spyOn(material, 'dispose')
    const textureDispose = vi.spyOn(texture, 'dispose')

    disposeObjectTreeResources(root)

    expect(geometryDispose).toHaveBeenCalledTimes(1)
    expect(materialDispose).toHaveBeenCalledTimes(1)
    expect(textureDispose).toHaveBeenCalledTimes(1)
  })

  it('多个根共用一个去重 Set：跨根共享资源也只释放一次', () => {
    const geometry = new BoxGeometry()
    const material = new MeshBasicMaterial()
    const rootA = new Group()
    const rootB = new Group()
    rootA.add(makeMesh(geometry, material))
    rootB.add(makeMesh(geometry, material))
    const geometryDispose = vi.spyOn(geometry, 'dispose')
    const materialDispose = vi.spyOn(material, 'dispose')

    const disposed = new Set<object>()
    disposeObjectTreeResources(rootA, disposed)
    disposeObjectTreeResources(rootB, disposed)

    expect(geometryDispose).toHaveBeenCalledTimes(1)
    expect(materialDispose).toHaveBeenCalledTimes(1)
  })

  it('材质数组：两个材质（及其贴图）都释放', () => {
    const textureA = new Texture()
    const textureB = new Texture()
    const materialA = new MeshBasicMaterial({ map: textureA })
    const materialB = new MeshBasicMaterial({ map: textureB })
    const mesh = makeMesh(new BoxGeometry(), [materialA, materialB])
    const materialADispose = vi.spyOn(materialA, 'dispose')
    const materialBDispose = vi.spyOn(materialB, 'dispose')
    const textureADispose = vi.spyOn(textureA, 'dispose')
    const textureBDispose = vi.spyOn(textureB, 'dispose')

    disposeObjectTreeResources(mesh)

    expect(materialADispose).toHaveBeenCalledTimes(1)
    expect(materialBDispose).toHaveBeenCalledTimes(1)
    expect(textureADispose).toHaveBeenCalledTimes(1)
    expect(textureBDispose).toHaveBeenCalledTimes(1)
  })

  it('null/undefined/空节点不抛（释放路径必须健壮）', () => {
    expect(() => disposeObjectTreeResources(null)).not.toThrow()
    expect(() => disposeObjectTreeResources(undefined)).not.toThrow()
    expect(() => disposeObjectTreeResources(new Group())).not.toThrow()
    expect(() => disposeMaterialResources(null)).not.toThrow()
    expect(() => disposeMaterialResources(undefined)).not.toThrow()
  })
})

/* -------------------------------------------------------------------------- */
/* R-04：手持道具层 dispose                                                     */
/* -------------------------------------------------------------------------- */

function makePropConfig(): HandPropConfig {
  return {
    schemaVersion: 1,
    propId: 'test-prop',
    file: 'props/test/test.glb',
    bone: 'rightHand',
    position: [0, 0, 0],
    quaternion: [0, 0, 0, 1],
    scale: 1,
    bounds: { minLengthMeters: 0.1, maxLengthMeters: 10, expectedLengthMeters: 0.5 },
    policy: { set: ['adv'], tags: ['skill'], clipIds: [] }
  }
}

/** 最小 VRM humanoid 假实现：rightHand 返回给定节点。 */
function makeFakeVrm(hand: Group): Parameters<typeof createHandPropLayer>[0]['vrm'] {
  return {
    humanoid: {
      getNormalizedBoneNode: () => hand,
      getRawBoneNode: () => hand
    }
  } as unknown as Parameters<typeof createHandPropLayer>[0]['vrm']
}

function makePropRoot(): { root: Group; geometry: BoxGeometry; material: MeshBasicMaterial } {
  const geometry = new BoxGeometry()
  const material = new MeshBasicMaterial()
  const root = new Group()
  root.add(new Mesh(geometry, material))
  return { root, geometry, material }
}

describe('vrm/prop-layer：dispose 释放道具子树（R-04）', () => {
  it('先 detach 再释放 geometry/material；重复调用幂等', async () => {
    const hand = new Group()
    const { root, geometry, material } = makePropRoot()
    const layer = createHandPropLayer({
      vrm: makeFakeVrm(hand),
      url: 'pet-asset://assets/props/test/test.glb',
      config: makePropConfig(),
      loadGltf: async () => ({ scene: root }),
      warn: () => undefined
    })
    await layer.ready
    expect(root.parent).toBe(hand)
    expect(layer.snapshot().attached).toBe(true)

    const geometryDispose = vi.spyOn(geometry, 'dispose')
    const materialDispose = vi.spyOn(material, 'dispose')
    layer.dispose()

    expect(root.parent).toBeNull()
    expect(geometryDispose).toHaveBeenCalledTimes(1)
    expect(materialDispose).toHaveBeenCalledTimes(1)
    expect(layer.snapshot().attached).toBe(false)

    // 幂等：第二次不得重复 detach/dispose（spy 计数不变）。
    expect(() => layer.dispose()).not.toThrow()
    expect(geometryDispose).toHaveBeenCalledTimes(1)
    expect(materialDispose).toHaveBeenCalledTimes(1)
  })

  it('dispose 之后才完成的加载：迟到道具被直接释放，不挂回骨架', async () => {
    const hand = new Group()
    const { root, geometry, material } = makePropRoot()
    let resolveLoad: (value: { scene: Group }) => void = () => undefined
    const layer = createHandPropLayer({
      vrm: makeFakeVrm(hand),
      url: 'pet-asset://assets/props/test/test.glb',
      config: makePropConfig(),
      loadGltf: () =>
        new Promise((resolve) => {
          resolveLoad = resolve
        }),
      warn: () => undefined
    })
    layer.dispose()
    const geometryDispose = vi.spyOn(geometry, 'dispose')
    const materialDispose = vi.spyOn(material, 'dispose')
    resolveLoad({ scene: root })
    await layer.ready

    expect(root.parent).toBeNull()
    expect(geometryDispose).toHaveBeenCalledTimes(1)
    expect(materialDispose).toHaveBeenCalledTimes(1)
    expect(layer.snapshot().attached).toBe(false)
  })
})
