/**
 * VRM 资产加载器（V1）—— 把 `.vrm`（GLB 容器）变成可直接渲染/播放的 `VrmAvatar`。
 *
 * 流程（`docs/wave2-vrm-runtime-design.md` §4.1）：
 * 1. `fetch` 取 ArrayBuffer；
 * 2. `GLTFLoader`（注册 `VRMLoaderPlugin`）`parseAsync`；
 * 3. 解析失败且允许时，用 `@shared/vrm-glb` 的 `patchVrmGlbBuffer` **内存修复**已知资产缺陷
 *    （W0-4：`珍珠` 材质的 MToon 贴图引用无合法 texture index 会让 GLTFLoader 抛 TypeError），
 *    修复后**重试一次**；不改磁盘文件；
 * 4. VRM 0.x 用 `VRMUtils.rotateVRM0()` 归一化到 VRM1 坐标约定（面向 +Z）；
 * 5. 能力探测：humanoid 骨（15 必需骨是否齐全）/ expression 名 / spring 链与 joint 数 /
 *    lookAt / 内嵌 animations；
 * 6. rest 包围盒（米）→ `restHeightMeters` / `restFeetY`；髋高 → `hipsRestHeight`；
 *    肩/髋骨世界坐标 → `bodyAspectRatio`（纯函数见 `avatar-bounds.ts`）；
 * 7. 材质名 / 贴图数 / 缺失贴图 / 顶点 / 三角形。
 *
 * 约定与边界：
 * - `VrmAvatar` / `LoadVrmAvatarOptions` 是 Lead 冻结接口（`runtime-types.ts`），本文件**不修改**；
 * - 冻结接口没有「manifest 资产描述」字段，而 `VrmAvatar.asset` 必有值：本模块在
 *   `LoadVrmAvatarInput`（本地扩展类型）里接受可选 `asset`，由场景层注入真实 manifest 条目；
 *   未注入时从模型文件推导一个占位描述（expression 绑定/朝向修正为空，仅供脚本/单测直接用）；
 * - 加载期一次算好的额外数据（rest 宽/中心、spring 链数等）挂在模块内 `WeakMap`（
 *   `readVrmRuntimeExtras`）上供场景层读取，避免往冻结的 `VrmAvatar` 加字段；
 * - 贴图统计：**以材质里实际可用的 Texture 为准**（`collectVrmTextures` + `texture.image`
 *   非空），不依赖 LoadingManager 事件 —— r171 的 GLTFLoader 用 ImageBitmapLoader 解码 GLB
 *   内嵌贴图，CSP/网络失败不会以可命名的 itemError 形式暴露（只会得到假名/漏计数）。
 *   `missingTextures` 用原始 glTF JSON 里被材质引用的 texture 数做期望值对照，缺解码才报一条。
 */
import { Box3, LoadingManager, Vector3 } from 'three'
import type { BufferGeometry, Material, Mesh, Object3D, Texture } from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import type { GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { VRMLoaderPlugin, VRMUtils } from '@pixiv/three-vrm'
import type { VRM } from '@pixiv/three-vrm'

import {
  HUMANOID_BONES,
  VRM_REQUIRED_HUMANOID_BONES,
  isVrmExpressionPreset,
  type HumanoidBone,
  type VrmAvatarAsset,
  type VrmAvatarCapabilities,
  type VrmAvatarSpecVersion,
  type VrmExpressionPreset,
  type VrmLookAtCapability
} from '@shared/vrm'
import { patchVrmGlbBuffer, type PatchVrmGlbResult } from '@shared/vrm-glb'

import { estimateBodyAspectRatio } from './avatar-bounds'
import type { LoadVrmAvatarOptions, VrmAvatar } from './runtime-types'

/* -------------------------------------------------------------------------- */
/* 常量                                                                        */
/* -------------------------------------------------------------------------- */

/** REST bbox 高度异常/髋高缺失时的髋高兜底比例（成人 hips ≈ 身高 0.55；仅防异常模型）。 */
const FALLBACK_HIPS_HEIGHT_RATIO = 0.55

/** 标准（非 MToon ShaderMaterial）材质的贴图槽名（MToon 走 uniforms，这里兜底通用材质）。 */
const STANDARD_TEXTURE_SLOTS = [
  'map',
  'normalMap',
  'emissiveMap',
  'alphaMap',
  'aoMap',
  'lightMap',
  'bumpMap',
  'displacementMap',
  'envMap',
  'specularMap',
  'roughnessMap',
  'metalnessMap',
  'clearcoatMap',
  'sheenColorMap',
  'transmissionMap',
  'thicknessMap'
] as const

/* -------------------------------------------------------------------------- */
/* 对外扩展类型                                                                */
/* -------------------------------------------------------------------------- */

/**
 * `loadVrmAvatar` 的入参：在冻结的 `LoadVrmAvatarOptions` 上**追加**可选的 manifest 资产描述。
 * 场景层（`pet-scene-vrm.ts`）总是注入；直接调用（脚本/测试）不注入时使用模型推导的占位描述。
 */
export interface LoadVrmAvatarInput extends LoadVrmAvatarOptions {
  /** manifest 里的资产条目（决定 id/表情绑定/lookAt/朝向修正等；缺省 = 从模型推导占位）。 */
  asset?: VrmAvatarAsset
}

/**
 * 加载期算出的、冻结 `VrmAvatar` 接口放不下的运行时数据（场景层通过 `readVrmRuntimeExtras` 读取）。
 * 注意：这是**内部通道**（WeakMap），不进入调试面板/序列化。
 */
export interface VrmRuntimeExtras {
  /** rest 包围盒宽（米；摆放时 `worldRect.width` 与横向居中用）。 */
  readonly restWidthMeters: number
  /** rest 包围盒中心 x（米；相对 `vrm.scene` 原点，横向居中用）。 */
  readonly restCenterX: number
  /** spring bone 链数（VRM1 `VRMC_springBone.springs.length` / VRM0 `secondaryAnimation.boneGroups.length`）。 */
  readonly springChainCount: number
  /** spring bone joint 总数（与 `VrmAvatarCapabilities.springBoneCount` 同口径）。 */
  readonly springJointCount: number
  /** 原始 glTF 内的贴图 image 数（诊断用；不等于实际被材质引用/解码的贴图数）。 */
  readonly imageCount: number
  /** 文件内嵌 animation clip 数（VRM 通常 0）。 */
  readonly animationCount: number
}

/* -------------------------------------------------------------------------- */
/* 模块内状态                                                                  */
/* -------------------------------------------------------------------------- */

/** VRM → 加载期额外数据（WeakMap：不污染冻结接口，VRM 释放后自动回收）。 */
const runtimeExtrasByVrm = new WeakMap<VRM, VrmRuntimeExtras>()

/** 读取 VRM 的加载期额外数据（非本 loader 加载的 VRM 返回 null）。 */
export function readVrmRuntimeExtras(vrm: VRM): VrmRuntimeExtras | null {
  return runtimeExtrasByVrm.get(vrm) ?? null
}

/* -------------------------------------------------------------------------- */
/* 小工具                                                                      */
/* -------------------------------------------------------------------------- */

/** 是否为普通对象（排除 null/数组）。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 错误转可读文本。 */
function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** 是否是贴图对象（three Texture 的 isTexture 标记）。 */
function isTextureLike(value: unknown): value is Texture {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { isTexture?: unknown }).isTexture === true
  )
}

/**
 * 把请求 URL 解析成「绝对 URL + GLTFLoader 基路径」。
 * - 自定义 scheme（`pet-asset://assets/...`）浏览器 `URL` 也能解析；CJK/括号会被自动百分号编码；
 * - 相对路径按 `document.baseURI` 解析（renderer 场景）；解析失败时原样使用、基路径为空。
 */
function resolveRequestUrl(rawUrl: string): { href: string; baseUrl: string } {
  const trimmed = rawUrl.trim()
  const documentBase =
    typeof document !== 'undefined' && typeof document.baseURI === 'string'
      ? document.baseURI
      : undefined
  try {
    const absolute = documentBase !== undefined ? new URL(trimmed, documentBase) : new URL(trimmed)
    return { href: absolute.href, baseUrl: new URL('.', absolute).href }
  } catch {
    return { href: trimmed, baseUrl: '' }
  }
}

/** 创建注册了 `VRMLoaderPlugin` 的加载器（统一注入 LoadingManager；外部贴图重试由场景层 handler 接管）。 */
function createVrmLoader(manager: LoadingManager): GLTFLoader {
  const loader = new GLTFLoader(manager)
  loader.register((parser) => new VRMLoaderPlugin(parser))
  return loader
}

/* -------------------------------------------------------------------------- */
/* 贴图统计（遍历材质，不依赖 LoadingManager 事件）                               */
/* -------------------------------------------------------------------------- */

/**
 * 判断贴图是否真的解码成功。
 *
 * r171 的 GLTFLoader 用 `ImageBitmapLoader` 解码 GLB 内嵌贴图（bufferView → blob URL →
 * `fetch(blob:...)` + `createImageBitmap`），成功后写入 `texture.image`。这条链路**不经过**
 * LoadingManager 的 img 扩展名 handler，失败时也不提供可读文件名（实测 CSP `connect-src`
 * 缺 `blob:` 时全部内嵌贴图失败）。因此贴图统计以「材质里实际可用（image 非空）的 Texture」
 * 为准，而不是 manager 的 itemStart/End 事件。
 */
function isDecodedTexture(texture: Texture): boolean {
  const compressed = texture as { isCompressedTexture?: boolean; mipmaps?: unknown[] }
  if (compressed.isCompressedTexture === true) {
    return Array.isArray(compressed.mipmaps) && compressed.mipmaps.length > 0
  }
  const image = (texture as { image?: unknown }).image
  return image !== null && image !== undefined
}

/**
 * 从原始 glTF JSON 统计「被材质引用的贴图」数量（期望值，仅用于发现漏解码）。
 *
 * 覆盖 VRM1（`materials[*]` 里的 baseColorTexture/MToon 各 *Texture 字段）与
 * VRM0（`extensions.VRM.materialProperties[*].textureProperties` 的 index 值）；
 * 结果按 texture → image source 去重（与 `collectVrmTextures` 按 `texture.source` 去重同口径，
 * 多个 texture 共用同一 image 时不重复计数）。
 */
function countReferencedTextures(gltf: GLTF): number {
  const json = (gltf.parser as unknown as { json?: unknown }).json
  if (!isRecord(json)) return 0
  const used = new Set<number>()
  const addTextureInfo = (value: unknown): void => {
    if (!isRecord(value)) return
    const index = value['index']
    if (typeof index === 'number' && Number.isInteger(index) && index >= 0) used.add(index)
  }
  const walk = (node: unknown, depth: number): void => {
    if (depth > 8 || node === null || typeof node !== 'object') return
    if (Array.isArray(node)) {
      for (const item of node) walk(item, depth + 1)
      return
    }
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      if (/texture/i.test(key)) addTextureInfo(value)
      walk(value, depth + 1)
    }
  }
  walk(json['materials'], 0)

  // VRM 0.x：贴图引用在 extensions.VRM.materialProperties[].textureProperties（值 = texture 下标）。
  const extensions = isRecord(json['extensions']) ? json['extensions'] : {}
  const vrm0 = isRecord(extensions['VRM']) ? extensions['VRM'] : null
  const properties =
    vrm0 !== null && Array.isArray(vrm0['materialProperties']) ? vrm0['materialProperties'] : []
  for (const entry of properties) {
    if (!isRecord(entry) || !isRecord(entry['textureProperties'])) continue
    for (const value of Object.values(entry['textureProperties'])) {
      if (typeof value === 'number' && Number.isInteger(value) && value >= 0) used.add(value)
    }
  }

  // 按 texture → image source 去重（缺 textures 定义的异常数据则按 texture index 计数兜底）。
  const textures = Array.isArray(json['textures']) ? json['textures'] : []
  const sources = new Set<number>()
  for (const index of used) {
    const definition = textures[index]
    const source =
      isRecord(definition) && typeof definition['source'] === 'number' ? definition['source'] : index
    sources.add(source)
  }
  return sources.size
}

/* -------------------------------------------------------------------------- */
/* 材质 / 贴图 / 几何 / 骨骼能力探测                                            */
/* -------------------------------------------------------------------------- */

/** 取单个材质引用的所有贴图（MToon 走 uniforms，通用材质走标准槽名）。 */
function materialTextures(material: Material): Texture[] {
  const result: Texture[] = []
  const uniforms = (material as { uniforms?: Record<string, { value?: unknown }> }).uniforms
  if (uniforms !== undefined) {
    for (const uniform of Object.values(uniforms)) {
      if (isTextureLike(uniform?.value)) result.push(uniform.value)
    }
  }
  const slots = material as unknown as Record<string, unknown>
  for (const slot of STANDARD_TEXTURE_SLOTS) {
    const value = slots[slot]
    if (isTextureLike(value)) result.push(value)
  }
  return result
}

/**
 * 收集 VRM 实际使用的去重贴图（按 texture.source 去重：MToon 的同类贴图/描边材质克隆共享 source）。
 * 场景层用它做各向异性过滤；loader 用它兜底统计贴图数。
 */
export function collectVrmTextures(vrm: VRM): Texture[] {
  const textures: Texture[] = []
  const seenSources = new Set<object>()
  const seenMaterials = new Set<Material>()
  vrm.scene.traverse((object) => {
    const mesh = object as Mesh
    if ((mesh as { isMesh?: unknown }).isMesh !== true) return
    const material = mesh.material
    const materials: Material[] = Array.isArray(material) ? material : material ? [material] : []
    for (const entry of materials) {
      if (!entry || seenMaterials.has(entry)) continue
      seenMaterials.add(entry)
      for (const texture of materialTextures(entry)) {
        const source: object = texture.source ?? texture
        if (seenSources.has(source)) continue
        seenSources.add(source)
        textures.push(texture)
      }
    }
  })
  return textures
}

/** 是否 MToon 描边用的克隆材质（`VRMMaterialsV0CompatPlugin`/MToon loader 生成，调试面不计入材质名）。 */
function isOutlineMaterial(material: Material): boolean {
  return (material as { isOutline?: unknown }).isOutline === true
}

/** 材质名列表（MToon 基础材质；剔除描边克隆。优先用 `vrm.materials`，缺失时遍历场景兜底）。 */
function collectMaterialNames(vrm: VRM): string[] {
  const mtoonMaterials = (vrm.materials ?? []).filter((material) => !isOutlineMaterial(material))
  if (mtoonMaterials.length > 0) return mtoonMaterials.map((material) => material.name ?? '')

  const seen = new Set<Material>()
  const names: string[] = []
  vrm.scene.traverse((object) => {
    const mesh = object as Mesh
    if ((mesh as { isMesh?: unknown }).isMesh !== true) return
    const material = mesh.material
    const materials: Material[] = Array.isArray(material) ? material : material ? [material] : []
    for (const entry of materials) {
      if (!entry || seen.has(entry) || isOutlineMaterial(entry)) continue
      seen.add(entry)
      names.push(entry.name ?? '')
    }
  })
  return names
}

/** 顶点/三角形统计（同一 BufferGeometry 被多个 mesh 共享时只计一次）。 */
function countGeometry(vrm: VRM): { vertexCount: number; triangleCount: number } {
  let vertexCount = 0
  let triangleCount = 0
  const seenGeometries = new Set<BufferGeometry>()
  vrm.scene.traverse((object) => {
    const mesh = object as Mesh
    if ((mesh as { isMesh?: unknown }).isMesh !== true) return
    const geometry = mesh.geometry
    if (!geometry || seenGeometries.has(geometry)) return
    seenGeometries.add(geometry)
    const position = geometry.getAttribute('position')
    const positionCount = position?.count ?? 0
    vertexCount += positionCount
    const index = geometry.getIndex()
    triangleCount += index ? Math.floor(index.count / 3) : Math.floor(positionCount / 3)
  })
  return { vertexCount, triangleCount }
}

/** 从原始 glTF JSON 读 spring bone 链/joint 数（VRM1/VRM0 两种扩展；精确值，不依赖运行时 API）。 */
function readRawSpringBoneStats(gltf: GLTF): { chainCount: number; jointCount: number } {
  const json = (gltf.parser as unknown as { json?: unknown }).json
  if (!isRecord(json)) return { chainCount: 0, jointCount: 0 }
  const extensions = isRecord(json['extensions']) ? json['extensions'] : {}

  // VRM 1.0：extensions.VRMC_springBone.springs[]（每个 spring = 一条链，joints = 骨骼节点列表）。
  const springBone = extensions['VRMC_springBone']
  if (isRecord(springBone) && Array.isArray(springBone['springs'])) {
    let chainCount = 0
    let jointCount = 0
    for (const spring of springBone['springs']) {
      if (!isRecord(spring)) continue
      chainCount += 1
      const joints = spring['joints']
      if (Array.isArray(joints)) jointCount += joints.length
    }
    return { chainCount, jointCount }
  }

  // VRM 0.x：extensions.VRM.secondaryAnimation.boneGroups[]（每个 boneGroup = 一条链）。
  const vrm0 = extensions['VRM']
  const secondary = isRecord(vrm0) && isRecord(vrm0['secondaryAnimation'])
    ? vrm0['secondaryAnimation']
    : null
  if (secondary !== null && Array.isArray(secondary['boneGroups'])) {
    let chainCount = 0
    let jointCount = 0
    for (const group of secondary['boneGroups']) {
      if (!isRecord(group)) continue
      chainCount += 1
      const bones = group['bones']
      if (Array.isArray(bones)) jointCount += bones.length
    }
    return { chainCount, jointCount }
  }

  return { chainCount: 0, jointCount: 0 }
}

/**
 * 从运行时 `VRMSpringBoneManager` 读 spring 统计。
 * three-vrm 3.5.5 **没有** `springBoneChains` API（那是更新版本才有）：链数按「关节骨的祖先里
 * 没有其它关节骨」数链根（每条规范 spring 链是线性骨序列，因此链根数 = 链数）。
 */
function readRuntimeSpringBoneStats(vrm: VRM): { chainCount: number; jointCount: number } {
  const manager = vrm.springBoneManager
  if (!manager) return { chainCount: 0, jointCount: 0 }
  const jointCount = manager.joints.size
  const chains = (manager as unknown as { springBoneChains?: unknown }).springBoneChains
  if (Array.isArray(chains)) return { chainCount: chains.length, jointCount }
  if (jointCount === 0) return { chainCount: 0, jointCount: 0 }

  const bones = new Set<Object3D>()
  for (const joint of manager.joints) bones.add(joint.bone)
  let chainCount = 0
  for (const bone of bones) {
    let parent = bone.parent
    let nested = false
    while (parent !== null) {
      if (bones.has(parent)) {
        nested = true
        break
      }
      parent = parent.parent
    }
    if (!nested) chainCount += 1
  }
  return { chainCount, jointCount }
}

/**
 * spring bone 链数（诊断用）：优先加载期从原始 JSON 读到的精确值，其次运行时链根推导。
 * 目标 tpose 资产 = 50 链/170 joint。
 */
export function countVrmSpringBoneChains(vrm: VRM): number {
  const extras = runtimeExtrasByVrm.get(vrm)
  if (extras !== undefined && extras.springChainCount > 0) return extras.springChainCount
  return readRuntimeSpringBoneStats(vrm).chainCount
}

/**
 * 实测 three-vrm 内建 lookAt 能力（`VRMC_vrm.lookAt` 扩展 → `vrm.lookAt`）。
 * 目标 tpose 资产实测：存在、type=bone、applier=`VRMLookAtBoneApplier`、offset=[0,0.06,0]。
 */
function readLookAtCapability(vrm: VRM): VrmLookAtCapability {
  const lookAt = vrm.lookAt
  if (lookAt === undefined || lookAt === null) {
    return { present: false, type: null, applier: null, offsetFromHeadBone: null }
  }
  const applierName =
    (lookAt.applier as unknown as { constructor?: { name?: string } } | undefined)?.constructor
      ?.name ?? null
  const type: VrmLookAtCapability['type'] =
    applierName !== null && applierName.includes('Expression') ? 'expression' : 'bone'
  const offset = lookAt.offsetFromHeadBone
  const offsetFromHeadBone: readonly [number, number, number] | null =
    offset !== undefined &&
    Number.isFinite(offset.x) &&
    Number.isFinite(offset.y) &&
    Number.isFinite(offset.z)
      ? [offset.x, offset.y, offset.z]
      : null
  return { present: true, type, applier: applierName, offsetFromHeadBone }
}

/* -------------------------------------------------------------------------- */
/* 占位资产描述（未注入 manifest asset 时）                                      */
/* -------------------------------------------------------------------------- */

/** 从请求 URL 推导 assets 相对路径（`pet-asset://assets/vrm/x.vrm` → `vrm/x.vrm`）。 */
function deriveAssetFile(url: string): string {
  try {
    const parsed = new URL(url)
    const path = parsed.pathname.replace(/^\/+/, '')
    if (path.length === 0) return 'vrm/unknown.vrm'
    try {
      return decodeURIComponent(path)
    } catch {
      return path
    }
  } catch {
    return 'vrm/unknown.vrm'
  }
}

/** 未注入 manifest 资产时，从模型实测结果推导占位 `VrmAvatarAsset`（表达式绑定为空）。 */
function deriveFallbackAsset(input: {
  url: string
  specVersion: VrmAvatarSpecVersion
  heightMeters: number
  springChains: number
  hasLookAt: boolean
}): VrmAvatarAsset {
  return {
    id: 'vrm-avatar',
    file: deriveAssetFile(input.url),
    specVersion: input.specVersion,
    heightMeters: Number(input.heightMeters.toFixed(4)),
    humanoid: {},
    expressions: {},
    lookAt: {
      mode: input.hasLookAt ? 'vrm' : 'procedural',
      maxYawDeg: 35,
      maxPitchDeg: 20
    },
    springChains: input.springChains,
    yawOffsetDeg: 0,
    thumbnail: null,
    notes: 'avatar-loader 从模型文件推导的占位资产描述（未注入 manifest asset；表情绑定/朝向修正为空）'
  }
}

/* -------------------------------------------------------------------------- */
/* 解析（含失败后 GLB 修复重试）                                                */
/* -------------------------------------------------------------------------- */

/** 解析 GLB 时可注入的依赖（单测用；默认实现 = 生产路径，行为不变）。 */
export interface ParseVrmGlbDeps {
  /** 创建加载器（生产默认 `createVrmLoader`：GLTFLoader + VRMLoaderPlugin）。 */
  createLoader?: (manager: LoadingManager) => {
    parseAsync(data: ArrayBuffer | string, baseUrl: string): Promise<GLTF>
  }
  /** GLB 内存修复原语（生产默认 `patchVrmGlbBuffer`）。 */
  patchGlb?: (data: ArrayBuffer | Uint8Array) => PatchVrmGlbResult
}

/**
 * 解析 GLB；首轮失败且允许时，用 `patchVrmGlbBuffer` 内存修复后重试一次。
 *
 * `deps` 仅用于单测注入 fake loader/patcher；生产调用不传，保持原路径。
 */
export async function parseVrmGlb(
  data: ArrayBuffer,
  baseUrl: string,
  manager: LoadingManager,
  patchGlbOnDemand: boolean,
  deps: ParseVrmGlbDeps = {}
): Promise<GLTF> {
  const createLoader = deps.createLoader ?? createVrmLoader
  const patchGlb = deps.patchGlb ?? patchVrmGlbBuffer
  const firstLoader = createLoader(manager)
  try {
    return await firstLoader.parseAsync(data, baseUrl)
  } catch (firstError) {
    if (!patchGlbOnDemand) throw firstError

    let patched: ReturnType<typeof patchVrmGlbBuffer>
    try {
      patched = patchGlb(data)
    } catch (patchError) {
      throw new Error(
        `VRM 解析失败，且 GLB 内存修复不可用：解析错误「${describeError(firstError)}」；` +
          `修复错误「${describeError(patchError)}」`
      )
    }
    if (patched.patches.length === 0) {
      // 修复没有命中已知缺陷：保留原始错误（更接近根因），不掩盖。
      throw new Error(
        `VRM 解析失败（未发现可修复的 MToon 贴图引用缺陷）：${describeError(firstError)}`
      )
    }

    const summary = patched.patches
      .slice(0, 8)
      .map((patch) => `${patch.material}[${patch.key}]`)
      .join('、')
    console.warn(
      `[vrm-avatar] 解析失败，已内存修复 ${patched.patches.length} 处 MToon 非法贴图引用后重试：${summary}`
    )

    const retryLoader = createLoader(manager)
    try {
      return await retryLoader.parseAsync(patched.data.buffer as ArrayBuffer, baseUrl)
    } catch (retryError) {
      throw new Error(
        `VRM 解析失败（已尝试 GLB 内存修复重试）：${describeError(retryError)}`
      )
    }
  }
}

/* -------------------------------------------------------------------------- */
/* 主入口                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * 加载 `.vrm` 并构建 `VrmAvatar`（加载完成、可直接交给场景/动画层）。
 *
 * 失败语义：任何一步失败都 reject（网络/HTTP/非 VRM/无可见网格/修复后仍不可解析）；
 * 由场景层决定是否重试（`main.ts` 的 ensureModelLoaded 已有指数退避）。
 *
 * @param options.url 可 fetch 的 VRM URL（`pet-asset://assets/<file>` 或 http(s)）。
 * @param options.manager 场景层 `createPetAssetLoadTracker().manager`（GLTFLoader 外部贴图重试/加载追踪用）。
 * @param options.patchGlbOnDemand 解析失败时是否允许 W0-5 的 GLB 内存修复重试（场景层传 true）。
 * @param options.asset manifest 资产描述（场景层注入；缺省用模型推导占位描述）。
 */
export async function loadVrmAvatar(options: LoadVrmAvatarInput): Promise<VrmAvatar> {
  const request = resolveRequestUrl(options.url)
  const manager = options.manager ?? new LoadingManager()

  const response = await fetch(request.href)
  if (!response.ok) {
    throw new Error(`VRM 下载失败：HTTP ${response.status}（${request.href}）`)
  }
  const data = await response.arrayBuffer()
  const gltf = await parseVrmGlb(
    data,
    request.baseUrl,
    manager,
    options.patchGlbOnDemand === true
  )
  return buildVrmAvatar({
    gltf,
    url: request.href,
    asset: options.asset ?? null
  })
}

/* -------------------------------------------------------------------------- */
/* 构建 VrmAvatar（能力探测 / bbox / 额外数据）                                  */
/* -------------------------------------------------------------------------- */

/** 把解析后的 GLTF 组装成 `VrmAvatar`（含能力探测、rest bbox、髋高、躯干宽高比、资源统计）。 */
function buildVrmAvatar(params: {
  gltf: GLTF
  url: string
  asset: VrmAvatarAsset | null
}): VrmAvatar {
  const { gltf, url } = params
  const vrm = gltf.userData['vrm'] as VRM | undefined
  if (vrm === undefined || vrm === null) {
    throw new Error('GLB 已解析但不是有效 VRM：gltf.userData.vrm 缺失（缺少 VRMC_vrm / VRM 扩展）')
  }

  // 1) VRM 0.x 朝向归一化（面向 +Z、左手 +X），与 spec 版本无关地再更新一次世界矩阵。
  if (vrm.meta?.metaVersion === '0') VRMUtils.rotateVRM0(vrm)
  vrm.scene.updateMatrixWorld(true)

  // 2) rest（T/A-pose）包围盒：VRM 的 rest = 绑定姿势，直接用 setFromObject（只含基础 position）。
  const restBox = new Box3().setFromObject(vrm.scene)
  const restSize = restBox.getSize(new Vector3())
  const restHeightMeters = restSize.y
  if (!Number.isFinite(restHeightMeters) || restHeightMeters <= 0) {
    throw new Error(
      `VRM rest 包围盒高度异常（${String(restSize.y)}）；模型可能缺少可见网格或变换矩阵异常`
    )
  }
  const restFeetY = Number.isFinite(restBox.min.y) ? restBox.min.y : 0
  const restWidthMeters = Number.isFinite(restSize.x) && restSize.x > 0 ? restSize.x : 0.01
  const restCenterX = (restBox.min.x + restBox.max.x) / 2

  // 3) humanoid 骨能力（只统计 normalized rig 里真实存在的 VRM 1.0 标准骨）。
  const humanoid = vrm.humanoid
  const humanoidBones: HumanoidBone[] = []
  for (const bone of HUMANOID_BONES) {
    if (humanoid.getNormalizedBoneNode(bone) !== null) humanoidBones.push(bone)
  }
  const presentBones = new Set<HumanoidBone>(humanoidBones)
  const missingRequiredBones: HumanoidBone[] = VRM_REQUIRED_HUMANOID_BONES.filter(
    (bone) => !presentBones.has(bone)
  )

  // 4) expression 能力：manager 注册的全部名字（含自定义），preset 子集单独给 capabilities。
  const expressionManager = vrm.expressionManager
  const expressionNames: string[] = (expressionManager?.expressions ?? []).map(
    (expression) => expression.expressionName
  )
  const presetExpressions: VrmExpressionPreset[] = []
  for (const name of expressionNames) {
    if (isVrmExpressionPreset(name)) presetExpressions.push(name)
  }

  // 5) spring bone：原始 JSON 精确链数 + 运行时 joint 数（取两者较大值防御插件差异）。
  const rawSpring = readRawSpringBoneStats(gltf)
  const runtimeSpring = readRuntimeSpringBoneStats(vrm)
  const springJointCount = Math.max(rawSpring.jointCount, runtimeSpring.jointCount)
  const springChainCount =
    rawSpring.chainCount > 0 ? rawSpring.chainCount : runtimeSpring.chainCount

  // 6) 髋高：normalized rest 的 hips.position[1]（Hips.p 位移缩放基准，见 clip-viewer.js）。
  const hipsRestPosition = humanoid.normalizedRestPose.hips?.position
  const rawHipsRestHeight = hipsRestPosition?.[1]
  const hipsRestHeight =
    typeof rawHipsRestHeight === 'number' &&
    Number.isFinite(rawHipsRestHeight) &&
    rawHipsRestHeight > 0
      ? rawHipsRestHeight
      : restHeightMeters * FALLBACK_HIPS_HEIGHT_RATIO

  // 7) 躯干宽高比：用 normalized rest 的肩/髋骨**世界**坐标（纯函数估算 + clamp）。
  const worldX = (node: Object3D | null): number | null => {
    if (node === null) return null
    const position = new Vector3()
    node.getWorldPosition(position)
    return Number.isFinite(position.x) ? position.x : null
  }
  const aspectEstimate = estimateBodyAspectRatio({
    heightMeters: restHeightMeters,
    leftUpperArmX: worldX(humanoid.getNormalizedBoneNode('leftUpperArm')),
    rightUpperArmX: worldX(humanoid.getNormalizedBoneNode('rightUpperArm')),
    hipsX: worldX(humanoid.getNormalizedBoneNode('hips')),
    leftUpperLegX: worldX(humanoid.getNormalizedBoneNode('leftUpperLeg'))
  })

  // 8) 材质/贴图/几何统计。贴图数 = 材质里**实际解码成功**的 Texture 数（去重 source），
  //    期望值 = 原始 glTF JSON 中被材质引用的 texture 数（缺解码时才写 missingTextures）。
  const materialNames = collectMaterialNames(vrm)
  const sceneTextures = collectVrmTextures(vrm)
  const decodedTextures = sceneTextures.filter(isDecodedTexture)
  const textureCount = decodedTextures.length
  const expectedTextureCount = countReferencedTextures(gltf)
  const missingTextures: string[] = []
  if (expectedTextureCount > 0 && textureCount < expectedTextureCount) {
    missingTextures.push(`texture:${textureCount}/${expectedTextureCount}`)
  }
  const { vertexCount, triangleCount } = countGeometry(vrm)

  const specVersion: VrmAvatarSpecVersion = vrm.meta?.metaVersion === '0' ? '0.x' : '1.0'
  const capabilities: VrmAvatarCapabilities = {
    specVersion,
    humanoidBones,
    missingRequiredBones,
    expressions: presetExpressions,
    springBoneCount: springJointCount,
    hasLookAt: Boolean(vrm.lookAt),
    lookAt: readLookAtCapability(vrm),
    animationNames: gltf.animations.map((animation) => animation.name),
    heightMeters: restHeightMeters
  }

  const imageCount = (() => {
    const json = (gltf.parser as unknown as { json?: unknown }).json
    if (!isRecord(json)) return 0
    return Array.isArray(json['images']) ? json['images'].length : 0
  })()

  // 9) 冻结接口放不下的加载期数据（WeakMap 通道；场景层摆放/diagnostics 用）。
  runtimeExtrasByVrm.set(vrm, {
    restWidthMeters,
    restCenterX,
    springChainCount,
    springJointCount,
    imageCount,
    animationCount: gltf.animations.length
  })

  const asset =
    params.asset ??
    deriveFallbackAsset({
      url,
      specVersion,
      heightMeters: restHeightMeters,
      springChains: springChainCount,
      hasLookAt: Boolean(vrm.lookAt)
    })

  const scene = vrm.scene
  let disposed = false

  return {
    asset,
    vrm,
    scene,
    capabilities,
    restHeightMeters,
    restFeetY,
    bodyAspectRatio: aspectEstimate.ratio,
    hipsRestHeight,
    materialNames,
    expressionNames,
    textureCount,
    missingTextures,
    vertexCount,
    triangleCount,
    dispose(): void {
      if (disposed) return
      disposed = true
      try {
        scene.removeFromParent()
        VRMUtils.deepDispose(scene)
      } catch (error) {
        console.warn(`[vrm-avatar] 资源释放失败（已忽略）：${describeError(error)}`)
      }
    }
  }
}
