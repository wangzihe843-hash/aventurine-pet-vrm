/**
 * upperChest α-fold 单测：`src/renderer/src/vrm/upper-chest-fold.ts`
 *
 * 覆盖（`docs/research/mate-female-to-male-joint-plan-2026-11-11.md` §4.1）：
 * 1. 虚拟 upperChest 链恒等式：任意 α 下折叠结果与 `D_chest · U · q_child` 一致（<1e-6）；
 * 2. α=0：chest 不变、子骨吸收 U；α=0.5：两半；α=1：chest 吸收 U、子骨不变；
 * 3. `upperChest === null` / U = identity 时不折叠（输出即输入副本）。
 *
 * 集成用例（私有资产存在时运行；仿 `tests/tmp/lead-shoulder/sim-fold.test.ts` 的只读
 * GLB 解析方式，但不依赖/修改 tests/tmp）：真实 `aventurine-tpose.vrm`（无 upperChest）
 * + mate `sleep/laughing` 的 UpperChest 轨道，验证 folded 世界朝向与虚拟链一致，
 * 并确认未折叠时误差恰为 |U|。
 */
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { Quaternion } from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { VRMLoaderPlugin } from '@pixiv/three-vrm'
import { describe, expect, it } from 'vitest'

import type { AnimationInput } from '../src/renderer/src/core/wave2-contract'
import { VrmClipPlayer } from '../src/renderer/src/vrm/clip-player'
import {
  parseClipData,
  sampleBoneRotation,
  slerpQuat,
  smoothstep,
  type ParsedClip,
  type Quat4
} from '../src/renderer/src/vrm/clip-data'
import { CLIP_BONE_NAMES, UNITY_TO_VRM_BONE } from '../src/renderer/src/vrm/humanoid-map'
import {
  UPPER_CHEST_FOLD_ALPHA,
  foldUpperChest,
  isIdentityQuat,
  multiplyQuat,
  quatAngleRad
} from '../src/renderer/src/vrm/upper-chest-fold'
import {
  identityQuat,
  makeClipJson,
  makeFakeAvatar,
  pitchQuat,
  trackNested,
  yawQuat
} from './fixtures/vrm-motion/clip-fixtures'

/* -------------------------------------------------------------------------- */
/* 四元数小工具（[x,y,z,w]）                                                    */
/* -------------------------------------------------------------------------- */

const DEG = Math.PI / 180
const IDENTITY: Quat4 = [0, 0, 0, 1]

/** 轴角 → 单位四元数（axis 不必预先归一）。 */
function axisAngle(axis: readonly number[], deg: number): Quat4 {
  const length = Math.hypot(axis[0], axis[1], axis[2])
  const half = (deg * DEG) / 2
  const s = Math.sin(half) / length
  return [axis[0] * s, axis[1] * s, axis[2] * s, Math.cos(half)]
}

/** 两个旋转之间的夹角（弧度；q/-q 等价）。 */
function rotationDistanceRad(a: readonly number[], b: readonly number[]): number {
  const aLength = Math.hypot(a[0], a[1], a[2], a[3])
  const bLength = Math.hypot(b[0], b[1], b[2], b[3])
  const dot = Math.abs(
    (a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3]) / (aLength * bLength)
  )
  return 2 * Math.acos(Math.min(1, Math.max(0, dot)))
}

/** 四元数逐分量近似相等（把 -0 与 0 视为相同）。 */
function expectQuatClose(actual: readonly number[], expected: readonly number[], eps = 1e-15): void {
  expect(actual).toHaveLength(4)
  for (let index = 0; index < 4; index += 1) {
    expect(Math.abs(actual[index] - expected[index])).toBeLessThan(eps)
  }
}

/** 折叠后的子骨旋转：`child' = childMultiplier · child`。 */
function foldedChild(fold: ReturnType<typeof foldUpperChest>, child: readonly number[]): Quat4 {
  return multiplyQuat(fold.childMultiplier, child)
}

/* -------------------------------------------------------------------------- */
/* 1) 虚拟 upperChest 链恒等式（α = 0 / 0.5 / 1）                                */
/* -------------------------------------------------------------------------- */

describe('upper-chest-fold：虚拟 upperChest 链恒等式', () => {
  // 接近真实数据的量级：U ≈ 23.7°（laughing 最大值），chest/neck/shoulder/head 各自偏离。
  const chest = axisAngle([1, 0.2, 0.1], 18)
  const upper = axisAngle([0.3, 1, 0.2], 23.7)
  const neck = axisAngle([0, 0, 1], 12)
  const leftShoulder = axisAngle([1, 0, 0], -14)
  const rightShoulder = axisAngle([0, 1, 0], 9)
  const head = axisAngle([1, 0, 0], 6)

  /** 虚拟 upperChest 链 reference：world_child = D_chest · U · q_child。 */
  const referenceWorld = (child: readonly number[]): Quat4 =>
    multiplyQuat(multiplyQuat(chest, upper), child)

  it.each([0, 0.5, 1])('α=%s：neck/左右 shoulder/head 世界朝向误差 < 1e-6', (alpha) => {
    const fold = foldUpperChest(chest, upper, alpha)
    expect(fold.applied).toBe(true)

    // chest' · child' 必须等于 chest · U · child（任意 α）。
    const foldedChestWorld = fold.chest
    for (const child of [neck, leftShoulder, rightShoulder]) {
      const actual = multiplyQuat(foldedChestWorld, foldedChild(fold, child))
      expect(rotationDistanceRad(actual, referenceWorld(child))).toBeLessThan(1e-6)
    }
    // head 的父链是 neck：多乘一层 head 局部旋转仍成立。
    const foldedNeckWorld = multiplyQuat(foldedChestWorld, foldedChild(fold, neck))
    const foldedHeadWorld = multiplyQuat(foldedNeckWorld, head)
    const referenceHeadWorld = multiplyQuat(referenceWorld(neck), head)
    expect(rotationDistanceRad(foldedHeadWorld, referenceHeadWorld)).toBeLessThan(1e-6)
  })

  it('α=1：chest 吸收全部 U，子骨乘子为 identity（子骨旋转不变）', () => {
    const fold = foldUpperChest(chest, upper, 1)
    expect(fold.applied).toBe(true)
    expectQuatClose(fold.childMultiplier, IDENTITY)
    // chest' = chest · U（q/-q 等价，用旋转距离比较）。
    const expectedChest = multiplyQuat(chest, upper)
    expect(rotationDistanceRad(fold.chest, expectedChest)).toBeLessThan(1e-12)
    // 子骨乘 identity 后不变。
    for (const child of [neck, leftShoulder, rightShoulder]) {
      expectQuatClose(foldedChild(fold, child), child)
    }
  })

  it('α=0：chest 不变，子骨乘子 = U（规范推荐的 child absorb）', () => {
    const fold = foldUpperChest(chest, upper, 0)
    expect(fold.applied).toBe(true)
    expectQuatClose(fold.chest, chest)
    expect(rotationDistanceRad(fold.childMultiplier, upper)).toBeLessThan(1e-12)
    // 子骨世界朝向仍精确恢复。
    expect(
      rotationDistanceRad(
        multiplyQuat(fold.chest, foldedChild(fold, neck)),
        referenceWorld(neck)
      )
    ).toBeLessThan(1e-6)
  })

  it('α=0.5 时 U 在 chest 与子骨之间各分一半（两乘子夹角 = |U|/2，乘积 = U）', () => {
    const fold = foldUpperChest(chest, upper, 0.5)
    expect(Math.abs(rotationDistanceRad(fold.childMultiplier, IDENTITY) - quatAngleRad(upper) / 2)).toBeLessThan(1e-9)
    const combined = multiplyQuat(fold.childMultiplier, fold.childMultiplier)
    expect(rotationDistanceRad(combined, upper)).toBeLessThan(1e-9)
  })
})

/* -------------------------------------------------------------------------- */
/* 2) 无轨道 / identity 时不折叠                                                */
/* -------------------------------------------------------------------------- */

describe('upper-chest-fold：不折叠的退化情况', () => {
  const chest = axisAngle([0.5, 1, 0.25], 21)

  it('upperChest = null：原样返回 chest，子骨乘子 identity，applied=false', () => {
    const fold = foldUpperChest(chest, null, UPPER_CHEST_FOLD_ALPHA)
    expect(fold.applied).toBe(false)
    expectQuatClose(fold.chest, chest)
    expectQuatClose(fold.childMultiplier, IDENTITY)
  })

  it('U = identity：原样返回 chest（任意 α），applied=false', () => {
    for (const alpha of [0, 0.5, 1]) {
      const fold = foldUpperChest(chest, IDENTITY, alpha)
      expect(fold.applied).toBe(false)
      expectQuatClose(fold.chest, chest)
      expectQuatClose(fold.childMultiplier, IDENTITY)
    }
    // q 与 -q 等价：identity 的负表示同样视为 identity。
    const foldNegative = foldUpperChest(chest, [0, 0, 0, -1], 0.5)
    expect(foldNegative.applied).toBe(false)
  })

  it('纯函数：不修改入参，alpha 非法/越界安全钳制', () => {
    const chestBefore = [...chest] as Quat4
    const upper = axisAngle([1, 0, 0], 10)
    const upperBefore = [...upper] as Quat4
    foldUpperChest(chest, upper, 0.5)
    expect(chest).toEqual(chestBefore)
    expect(upper).toEqual(upperBefore)

    // 越界钳制到 [0,1]；NaN 回退默认 α。
    const below = foldUpperChest(chest, upper, -1)
    expectQuatClose(below.chest, chest)
    const above = foldUpperChest(chest, upper, 2)
    expect(rotationDistanceRad(above.childMultiplier, IDENTITY)).toBeLessThan(1e-12)
    const nan = foldUpperChest(chest, upper, Number.NaN)
    expect(rotationDistanceRad(nan.childMultiplier, IDENTITY)).toBeLessThan(1e-12)
  })

  it('isIdentityQuat / quatAngleRad：q 与 -q 等价、未归一化输入安全', () => {
    expect(isIdentityQuat([0, 0, 0, 2])).toBe(true)
    expect(isIdentityQuat([0, 0, 0, 0])).toBe(true)
    expect(quatAngleRad([0, 0, 0, -1])).toBe(0)
    expect(quatAngleRad([0, 0, 0, 0])).toBe(0)
    const q = axisAngle([0, 1, 0], 30)
    expect(Math.abs(quatAngleRad(q) - 30 * DEG)).toBeLessThan(1e-12)
  })
})

/* -------------------------------------------------------------------------- */
/* 2.5) clip-player.applyFrame 集成（fake avatar 模拟缺 upperChest）             */
/* -------------------------------------------------------------------------- */

/** 本组用例：chest 基础旋转 8°、UpperChest 20°，便于区分「丢 U / 折叠」。 */
const PLAYER_CHEST = pitchQuat(8)
const PLAYER_UPPER = yawQuat(20)

/** 构造只含一根 sleep clip 的假清单（file 路径与 fetchText 映射一致）。 */
function makePlayerFiles(): Record<string, unknown> {
  const clip = makeClipJson({
    clip: 'sleep',
    fps: 1,
    frames: 2,
    loop: true,
    grounding: 'none',
    bones: {
      Hips: trackNested([identityQuat(), identityQuat()]),
      Chest: trackNested([PLAYER_CHEST, PLAYER_CHEST]),
      UpperChest: trackNested([PLAYER_UPPER, PLAYER_UPPER]),
      Neck: trackNested([identityQuat(), identityQuat()]),
      Head: trackNested([identityQuat(), identityQuat()]),
      LeftShoulder: trackNested([identityQuat(), identityQuat()]),
      RightShoulder: trackNested([identityQuat(), identityQuat()])
    }
  })
  return {
    'app-manifest.json': {
      schemaVersion: 1,
      clips: [
        {
          id: 'mate-sleep',
          mood: 'sleep',
          file: 'mate/sleep.json',
          loop: true,
          priority: 0,
          fadeInSec: 0,
          fadeOutSec: 0
        }
      ]
    },
    'app-catalog.json': {
      version: 1,
      clips: [
        {
          id: 'mate-sleep',
          set: 'mate',
          file: 'mate/sleep.json',
          loop: true,
          duration: 2,
          tags: ['sleep'],
          mood: 'sleep'
        }
      ]
    },
    'mate/sleep.json': clip
  }
}

/** 假 fetchText（与 tests/vrm-clip-player.test.ts 同口径）。 */
function makeFetchText(files: Record<string, unknown>): (url: string) => Promise<string> {
  return async (url: string): Promise<string> => {
    const relative = url.replace(/^pet-asset:\/\/assets\/motions\//, '')
    if (!(relative in files)) throw new Error(`404 ${url}`)
    const value = files[relative]
    return typeof value === 'string' ? value : JSON.stringify(value)
  }
}

/** 一帧最小 AnimationInput（sleep / 静止 / 不拖拽）。 */
function playerInput(): AnimationInput {
  return {
    dt: 0.1,
    mood: 'sleep',
    motion: {
      feet: { x: 500, y: 400 },
      velocity: { x: 0, y: 0 },
      facing: 'right',
      grounded: true,
      surfaceId: 'screen-bottom',
      airborne: false
    },
    facing: 'right',
    lookTarget: null,
    petRect: { x: 400, y: 100, width: 200, height: 540 },
    viewportHeight: 540,
    dragging: false,
    events: [],
    bubbleText: null
  }
}

describe('clip-player：applyFrame upperChest 折叠', () => {
  it('目标缺 upperChest：UpperChest 轨道折叠进 chest，不再静默丢弃', async () => {
    const avatar = makeFakeAvatar({ missingVrmBones: ['upperChest'] })
    expect(avatar.nodes.has('upperChest')).toBe(false)
    const player = new VrmClipPlayer({
      avatar: avatar.avatar,
      fetchText: makeFetchText(makePlayerFiles())
    })
    await player.init()
    expect(player.ready).toBe(true)
    player.update(playerInput())
    expect(player.snapshot().clipId).toBe('mate-sleep')
    // 已折叠的 UpperChest 不再进 missingBones 误报（非 identity 轨道也不误报）。
    expect(player.snapshot().missingBones).toEqual([])

    const chestNode = avatar.nodes.get('chest')!
    const expectedChest = foldUpperChest(PLAYER_CHEST, PLAYER_UPPER, UPPER_CHEST_FOLD_ALPHA)
    expect(expectedChest.applied).toBe(true)
    expectQuatClose(
      [chestNode.quaternion.x, chestNode.quaternion.y, chestNode.quaternion.z, chestNode.quaternion.w],
      expectedChest.chest,
      1e-6
    )
    // α=1：子骨保持 clip 的 identity 本地旋转（U 全部由 chest 吸收）。
    for (const bone of ['neck', 'leftShoulder', 'rightShoulder']) {
      const node = avatar.nodes.get(bone)!
      expectQuatClose([node.quaternion.x, node.quaternion.y, node.quaternion.z, node.quaternion.w], IDENTITY, 1e-6)
    }
    player.dispose()
  })

  it('目标有 upperChest：不折叠（轨道照常写到 upperChest 节点）', async () => {
    const avatar = makeFakeAvatar()
    expect(avatar.nodes.has('upperChest')).toBe(true)
    const player = new VrmClipPlayer({
      avatar: avatar.avatar,
      fetchText: makeFetchText(makePlayerFiles())
    })
    await player.init()
    player.update(playerInput())

    const chestNode = avatar.nodes.get('chest')!
    const upperNode = avatar.nodes.get('upperChest')!
    expectQuatClose(
      [chestNode.quaternion.x, chestNode.quaternion.y, chestNode.quaternion.z, chestNode.quaternion.w],
      PLAYER_CHEST,
      1e-6
    )
    expectQuatClose(
      [upperNode.quaternion.x, upperNode.quaternion.y, upperNode.quaternion.z, upperNode.quaternion.w],
      PLAYER_UPPER,
      1e-6
    )
    player.dispose()
  })

  it('crossfade：U 用混合后的 upperChest 旋转（与其它骨同 weight）再折叠', async () => {
    // 两条 clip 的 chest / UpperChest 都不同：验证切换瞬间不会只取新 clip 的 U。
    const chestA = pitchQuat(8)
    const upperA = yawQuat(20)
    const chestB = yawQuat(-12)
    const upperB = pitchQuat(30)
    const makeClip = (chest: Quat4, upper: Quat4): Record<string, unknown> =>
      makeClipJson({
        clip: 'sleep',
        fps: 1,
        frames: 2,
        loop: true,
        grounding: 'none',
        bones: {
          Hips: trackNested([identityQuat(), identityQuat()]),
          Chest: trackNested([chest, chest]),
          UpperChest: trackNested([upper, upper]),
          Neck: trackNested([identityQuat(), identityQuat()])
        }
      })
    const manifestClips = [
      { id: 'mate-sleep', mood: 'sleep', file: 'mate/sleep.json', loop: true, priority: 10, fadeInSec: 1, fadeOutSec: 1 },
      { id: 'mate-sleep2', mood: 'sleep', file: 'mate/sleep2.json', loop: true, priority: 0, fadeInSec: 1, fadeOutSec: 1 }
    ]
    const files: Record<string, unknown> = {
      'app-manifest.json': { schemaVersion: 1, clips: manifestClips },
      'app-catalog.json': {
        version: 1,
        clips: manifestClips.map((entry) => ({ ...entry, set: 'mate', duration: 2, tags: ['sleep'], mood: 'sleep' }))
      },
      'mate/sleep.json': makeClip(chestA, upperA),
      'mate/sleep2.json': makeClip(chestB, upperB)
    }
    const avatar = makeFakeAvatar({ missingVrmBones: ['upperChest'] })
    const player = new VrmClipPlayer({ avatar: avatar.avatar, fetchText: makeFetchText(files) })
    await player.init()
    player.update(playerInput()) // 稳定播放 sleep A（首帧无 fade）
    const chestNode = avatar.nodes.get('chest')!
    const first = foldUpperChest(chestA, upperA, UPPER_CHEST_FOLD_ALPHA).chest
    expectQuatClose(
      [chestNode.quaternion.x, chestNode.quaternion.y, chestNode.quaternion.z, chestNode.quaternion.w],
      first,
      1e-6
    )

    // 切到 sleep B 并推进一帧 crossfade（elapsed = 0.1s / duration 1s）。
    await player.clipRegistry.loadClip('mate-sleep2')
    expect(player.playClipById('mate-sleep2', { fadeSec: 1 })).toBe(true)
    player.update(playerInput())
    const weight = smoothstep(0.1)
    const blendedChest: Quat4 = [0, 0, 0, 1]
    slerpQuat(chestA, chestB, weight, blendedChest)
    const blendedUpper: Quat4 = [0, 0, 0, 1]
    slerpQuat(upperA, upperB, weight, blendedUpper)
    const expected = foldUpperChest(blendedChest, blendedUpper, UPPER_CHEST_FOLD_ALPHA).chest
    expectQuatClose(
      [chestNode.quaternion.x, chestNode.quaternion.y, chestNode.quaternion.z, chestNode.quaternion.w],
      expected,
      1e-6
    )
    // 若错误地只取新 clip 的 U（未混合），结果会明显偏离；这里确认没有跳变。
    const wrong = foldUpperChest(blendedChest, upperB, UPPER_CHEST_FOLD_ALPHA).chest
    expect(rotationDistanceRad(
      [chestNode.quaternion.x, chestNode.quaternion.y, chestNode.quaternion.z, chestNode.quaternion.w],
      wrong
    )).toBeGreaterThan(1e-3)
    player.dispose()
  })
})

/* -------------------------------------------------------------------------- */
/* 3) 真实 VRM + mate clip 集成（私有资产；缺失时跳过）                          */
/* -------------------------------------------------------------------------- */

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url))
const VRM_PATH = `${REPO_ROOT}/assets/vrm/aventurine-tpose.vrm`
const CLIP_PATHS = ['assets/motions/mate/sleep.json', 'assets/motions/mate/laughing.json']
const HAS_REAL_ASSETS =
  existsSync(VRM_PATH) && CLIP_PATHS.every((rel) => existsSync(`${REPO_ROOT}/${rel}`))

/**
 * 读 VRM（GLB）并只保留 humanoid 所需数据（去掉贴图/材质，避免测试加载图片）。
 * 与 `tests/tmp/lead-shoulder/sim-fold.test.ts` 的只读解析方式一致。
 */
async function loadVrm(vrmPath: string): Promise<{ humanoid: any }> {
  const buf = readFileSync(vrmPath)
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
  const jsonLen = view.getUint32(12, true)
  const json = JSON.parse(
    new TextDecoder().decode(buf.subarray(20, 20 + jsonLen)).replace(/\u0000+$/g, '').trim()
  )
  delete json.images
  delete json.textures
  delete json.samplers
  for (const mesh of json.meshes ?? []) for (const primitive of mesh.primitives ?? []) delete primitive.material
  const binLenPos = 12 + 8 + jsonLen
  const binLen = view.getUint32(binLenPos, true)
  const binStart = binLenPos + 8
  const bin = buf.subarray(binStart, binStart + binLen)
  const textBytes = new TextEncoder().encode(JSON.stringify(json))
  const pad4 = (n: number): number => Math.ceil(n / 4) * 4
  const paddedText = pad4(textBytes.length)
  const paddedBin = pad4(bin.length)
  const total = 12 + 8 + paddedText + 8 + paddedBin
  const out = new Uint8Array(total)
  const dv = new DataView(out.buffer)
  dv.setUint32(0, 0x46546c67, true)
  dv.setUint32(4, 2, true)
  dv.setUint32(8, total, true)
  dv.setUint32(12, paddedText, true)
  dv.setUint32(16, 0x4e4f534a, true)
  out.set(textBytes, 20)
  out.fill(0x20, 20 + textBytes.length, 20 + paddedText)
  const binOff = 20 + paddedText
  dv.setUint32(binOff, paddedBin, true)
  dv.setUint32(binOff + 4, 0x004e4942, true)
  out.set(bin, binOff + 8)
  return await new Promise((resolve, reject) => {
    const loader = new GLTFLoader()
    loader.register((parser) => new VRMLoaderPlugin(parser))
    loader.parse(out.buffer, `${REPO_ROOT}/`, (gltf) => resolve(gltf.userData.vrm), reject)
  })
}

function loadClip(rel: string): ParsedClip {
  const raw = JSON.parse(readFileSync(`${REPO_ROOT}/${rel}`, 'utf8'))
  const parsed = parseClipData(raw)
  if (parsed.value === null) throw new Error(`clip parse failed: ${rel}: ${parsed.errors.join('; ')}`)
  return parsed.value
}

describe.skipIf(!HAS_REAL_ASSETS)('upper-chest-fold：真实 VRM 集成（无 upperChest）', () => {
  it(
    'sleep/laughing：折叠后 neck/shoulder/head 世界朝向 = 虚拟 upperChest 链（α=0/0.5/1）',
    async () => {
      const vrm = await loadVrm(VRM_PATH)
      const humanoid = vrm.humanoid
      // 目标模型确实没有 upperChest（本修复的前提）。
      expect(humanoid.getNormalizedBoneNode('upperChest')).toBeNull()
      const nodes = new Map<string, { quaternion: Quaternion }>()
      for (const bone of CLIP_BONE_NAMES) {
        const node = humanoid.getNormalizedBoneNode(UNITY_TO_VRM_BONE[bone])
        if (node) nodes.set(bone, node)
      }
      for (const bone of ['Chest', 'Neck', 'Head', 'LeftShoulder', 'RightShoulder']) {
        expect(nodes.has(bone)).toBe(true)
      }

      const sampleLocal = (clip: ParsedClip, bone: string, timeSec: number): Quat4 => {
        const out: Quat4 = [0, 0, 0, 1]
        return sampleBoneRotation(clip, bone, timeSec, out) ? out : [0, 0, 0, 1]
      }
      // Spine/Hips 的 normalized 世界旋转（chest 的父链）；本模型两个骨都存在。
      const spineWorld = (clip: ParsedClip, timeSec: number): Quat4 =>
        multiplyQuat(sampleLocal(clip, 'Hips', timeSec), sampleLocal(clip, 'Spine', timeSec))

      for (const rel of CLIP_PATHS) {
        const clip = loadClip(rel)
        const duration = clip.frames / clip.fps
        const times = [0, duration * 0.25, duration * 0.5, duration * 0.75]
        let sawNonIdentityUpperChest = false
        for (const timeSec of times) {
          const u = sampleLocal(clip, 'UpperChest', timeSec)
          if (!isIdentityQuat(u)) sawNonIdentityUpperChest = true
          const chest = sampleLocal(clip, 'Chest', timeSec)
          const neck = sampleLocal(clip, 'Neck', timeSec)
          const head = sampleLocal(clip, 'Head', timeSec)
          const shoulders = [
            sampleLocal(clip, 'LeftShoulder', timeSec),
            sampleLocal(clip, 'RightShoulder', timeSec)
          ]
          const base = spineWorld(clip, timeSec)
          // 虚拟 upperChest 链 reference。
          const chestWithUpperWorld = multiplyQuat(multiplyQuat(base, chest), u)
          const referenceNeckWorld = multiplyQuat(chestWithUpperWorld, neck)
          const referenceHeadWorld = multiplyQuat(referenceNeckWorld, head)

          // 当前（丢 U）实现：neck/head 世界朝向误差应恰为 |U|。
          const currentNeckWorld = multiplyQuat(multiplyQuat(base, chest), neck)
          const currentHeadWorld = multiplyQuat(currentNeckWorld, head)
          expect(
            Math.abs(rotationDistanceRad(currentNeckWorld, referenceNeckWorld) - quatAngleRad(u))
          ).toBeLessThan(1e-6)
          expect(
            Math.abs(rotationDistanceRad(currentHeadWorld, referenceHeadWorld) - quatAngleRad(u))
          ).toBeLessThan(1e-6)

          for (const alpha of [0, 0.5, 1]) {
            const fold = foldUpperChest(chest, u, alpha)
            if (isIdentityQuat(u)) {
              expect(fold.applied).toBe(false)
              continue
            }
            expect(fold.applied).toBe(true)
            const foldedChestWorld = multiplyQuat(base, fold.chest)
            // neck + 左右 shoulder（左乘 U^(1-α)）。
            const foldedNeckWorld = multiplyQuat(
              foldedChestWorld,
              multiplyQuat(fold.childMultiplier, neck)
            )
            expect(rotationDistanceRad(foldedNeckWorld, referenceNeckWorld)).toBeLessThan(1e-6)
            for (let index = 0; index < shoulders.length; index += 1) {
              const child = shoulders[index]
              const folded = multiplyQuat(
                foldedChestWorld,
                multiplyQuat(fold.childMultiplier, child)
              )
              expect(rotationDistanceRad(folded, multiplyQuat(chestWithUpperWorld, child))).toBeLessThan(1e-6)
            }
            // head：父链是折叠后的 neck。
            const foldedHeadWorld = multiplyQuat(foldedNeckWorld, head)
            expect(rotationDistanceRad(foldedHeadWorld, referenceHeadWorld)).toBeLessThan(1e-6)
          }
        }
        expect(sawNonIdentityUpperChest).toBe(true)
      }
    },
    120000
  )
})
