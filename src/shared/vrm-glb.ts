/**
 * 冻结共享契约扩展 —— VRM/GLB 数据修复（W0-5 小修，Lead）
 *
 * 背景（W0-4 实测）：用户用模之屋转好的 `星穹铁道—砂金·戏浪(1.0).vrm` 里，
 * `珍珠` 材质的 `VRMC_materials_mtoon.shadeMultiplyTexture` 是空对象 `{}`（没有 `index`）。
 * three-vrm 3.5.5 会把这个值透传给 GLTFLoader 的 texture 分配逻辑（`json.textures[undefined]`），
 * 在 `GLTFLoader` 内抛 TypeError → **整个模型加载失败**。
 *
 * 本模块提供纯函数修复（不依赖 DOM / three / electron / node）：
 * - `patchVrmGltfJson`：移除 MToon 材质里**没有合法 texture index** 的贴图引用（保留材质其余字段）；
 * - `patchVrmGlbBuffer`：对 GLB 容器做「解析 JSON chunk → 修复 → 重新封装」，
 *   BIN chunk 原样保留，JSON chunk 按 glTF 规范 4 字节对齐（空格填充）。
 *
 * 使用方：
 * - V1 的 avatar loader 在 `GLTFLoader.parseAsync` 之前调用 `patchVrmGlbBuffer`（内存修复，不改磁盘文件）；
 * - `scripts/vrm/patch-vrm-gltf.mjs` 用它生成修复后的本地资产副本（私有、gitignore）。
 *
 * 规则（与 `src/shared/**` 相同）：环境中立纯 TS；不得 import electron / node:* / three / 第三方依赖。
 * 注意：本文件是 W0-3 冻结契约的**追加**（Lead 在 W0 收口小修中批准），既有导出语义不变。
 */

/** 一条 GLB/glTF JSON 修复记录（供日志/诊断/验收断言）。 */
export interface VrmGltfPatch {
  /** 材质在 `json.materials` 中的索引。 */
  materialIndex: number
  /** 材质名（缺失时回退 `material#<index>`）。 */
  material: string
  /** 被移除的 MToon 贴图引用字段名（如 `shadeMultiplyTexture`）。 */
  key: string
  /** 原始非法值（通常是 `{}` 或越界 index）。 */
  invalidValue: unknown
  /** 人类可读原因。 */
  reason: string
}

/** `patchVrmGltfJson` 的结果：**输入对象被原地修改**（调用方传解析后的 JSON 即可）。 */
export interface PatchVrmGltfJsonResult {
  /** 传入的 glTF JSON（原地修改后返回，便于链式使用）。 */
  json: Record<string, unknown>
  /** 应用的修复列表（空 = 无需修复）。 */
  patches: VrmGltfPatch[]
}

/** `patchVrmGlbBuffer` 的结果。 */
export interface PatchVrmGlbResult {
  /** 修复后的新 GLB 字节（输入 buffer 不被修改）。 */
  data: Uint8Array
  /** 应用的修复列表。 */
  patches: VrmGltfPatch[]
}

/** GLB magic（`glTF` 小端）。 */
const GLB_MAGIC = 0x46546c67
/** 支持的 GLB 容器版本。 */
export const GLB_VERSION = 2
/** JSON chunk 类型（`JSON` 小端）。 */
const GLB_CHUNK_JSON = 0x4e4f534a
/** GLB 头长度（12 字节）。 */
const GLB_HEADER_BYTES = 12
/** chunk 头长度（8 字节）。 */
const GLB_CHUNK_HEADER_BYTES = 8
/** glTF JSON chunk 对齐单位。 */
const GLB_ALIGNMENT = 4

/** 读取 32 位小端无符号整数。 */
function readUint32LE(bytes: Uint8Array, offset: number): number {
  return (
    (bytes[offset]! |
      (bytes[offset + 1]! << 8) |
      (bytes[offset + 2]! << 16) |
      (bytes[offset + 3]! << 24)) >>>
    0
  )
}

/** 写入 32 位小端无符号整数。 */
function writeUint32LE(bytes: Uint8Array, offset: number, value: number): void {
  bytes[offset] = value & 0xff
  bytes[offset + 1] = (value >>> 8) & 0xff
  bytes[offset + 2] = (value >>> 16) & 0xff
  bytes[offset + 3] = (value >>> 24) & 0xff
}

/** 是否为普通对象（排除 null/数组）。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * 判断 MToon 贴图引用是否合法：glTF 的 textureInfo 必须是 `{ index: <合法 texture 下标> }`。
 * `index` 必须是 [0, textureCount) 的整数；空对象 `{}`、字符串、null、越界 index 都非法。
 */
function isValidTextureInfo(value: unknown, textureCount: number): boolean {
  if (!isRecord(value)) return false
  const index = value['index']
  return typeof index === 'number' && Number.isInteger(index) && index >= 0 && index < textureCount
}

/**
 * 修复 glTF JSON 中 MToon 材质的非法贴图引用。
 *
 * 只处理 `extensions.VRMC_materials_mtoon` 下**键名含 `texture`** 的字段
 * （如 `shadeMultiplyTexture` / `shadingShiftTexture` / `matcapTexture` / `rimMultiplyTexture` 等）；
 * 值不是合法 `{ index }` 的引用会被**删除**（材质其余字段保持不变），避免 loader 抛错。
 *
 * @param input `JSON.parse` 后的 glTF JSON（会被原地修改）
 * @returns `{ json, patches }`；非对象输入返回 `{ json: {}, patches: [] }` 且不抛异常
 */
export function patchVrmGltfJson(input: unknown): PatchVrmGltfJsonResult {
  const patches: VrmGltfPatch[] = []
  if (!isRecord(input)) return { json: {}, patches }

  const textures = Array.isArray(input['textures']) ? input['textures'] : []
  const textureCount = textures.length
  const materials = Array.isArray(input['materials']) ? input['materials'] : []

  for (let materialIndex = 0; materialIndex < materials.length; materialIndex += 1) {
    const material = materials[materialIndex]
    if (!isRecord(material)) continue
    const extensions = material['extensions']
    if (!isRecord(extensions)) continue
    const mtoon = extensions['VRMC_materials_mtoon']
    if (!isRecord(mtoon)) continue
    const materialName =
      typeof material['name'] === 'string' && material['name'].length > 0
        ? material['name']
        : `material#${materialIndex}`

    for (const key of Object.keys(mtoon)) {
      if (!/texture/i.test(key)) continue
      const value = mtoon[key]
      if (isValidTextureInfo(value, textureCount)) continue
      // 只清理「看起来是贴图引用但非法」的值；null/undefined 语义上是可选字段默认值，保留。
      if (value === null || value === undefined) continue
      delete mtoon[key]
      patches.push({
        materialIndex,
        material: materialName,
        key,
        invalidValue: value,
        reason: `MToon 贴图引用无合法 texture index（期望 0..${textureCount - 1} 的整数）`
      })
    }
  }

  return { json: input, patches }
}

/**
 * 对 GLB 容器做 JSON chunk 修复并重新封装：
 * - 校验 magic = `glTF`、version = 2、长度一致；
 * - 第一个 chunk 必须是 JSON（glTF 规范），其余 chunk（BIN 等）**原样保留**；
 * - 修改后的 JSON 按 4 字节对齐、以空格（0x20）填充（glTF 规范）；
 * - 更新头部 total length。
 *
 * BIN chunk 中 accessor/animation/贴图字节不会被改动（只动材质 JSON 描述），
 * 因此修复不改变模型几何/动画/贴图内容。
 *
 * @param buffer 原始 GLB 字节（`ArrayBuffer` 或 `Uint8Array`；不会被修改）
 * @throws 输入不是合法 GLB v2 时抛错（错误信息含原因；调用方可选择跳过修复直接用原始数据）
 */
export function patchVrmGlbBuffer(buffer: ArrayBuffer | Uint8Array): PatchVrmGlbResult {
  const input = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer)
  if (input.byteLength < GLB_HEADER_BYTES + GLB_CHUNK_HEADER_BYTES) {
    throw new Error('不是合法 GLB：文件长度不足以容纳 GLB 头与 JSON chunk')
  }
  if (readUint32LE(input, 0) !== GLB_MAGIC) {
    throw new Error('不是合法 GLB：magic 不是 "glTF"')
  }
  const version = readUint32LE(input, 4)
  if (version !== GLB_VERSION) {
    throw new Error(`不支持的 GLB 版本：${version}（期望 ${GLB_VERSION}）`)
  }
  const declaredTotal = readUint32LE(input, 8)
  if (declaredTotal !== input.byteLength) {
    throw new Error(`GLB 长度不一致：头声明 ${declaredTotal}，实际 ${input.byteLength}`)
  }

  const jsonChunkLength = readUint32LE(input, 12)
  const jsonChunkType = readUint32LE(input, 16)
  if (jsonChunkType !== GLB_CHUNK_JSON) {
    throw new Error('不是合法 GLB：首个 chunk 不是 JSON')
  }
  const jsonStart = GLB_HEADER_BYTES + GLB_CHUNK_HEADER_BYTES
  const jsonEnd = jsonStart + jsonChunkLength
  if (jsonEnd > input.byteLength) {
    throw new Error('不是合法 GLB：JSON chunk 越界')
  }

  const decoder = new TextDecoder('utf-8')
  const encoder = new TextEncoder()
  let parsed: unknown
  try {
    // glTF JSON chunk 尾部用空格（0x20）填充，JSON.parse 容忍尾随空白。
    parsed = JSON.parse(decoder.decode(input.subarray(jsonStart, jsonEnd)))
  } catch (error) {
    throw new Error(`GLB JSON chunk 解析失败：${String(error)}`)
  }

  const { patches } = patchVrmGltfJson(parsed)
  const jsonBytes = encoder.encode(JSON.stringify(parsed))
  const paddedJsonLength = Math.ceil(jsonBytes.length / GLB_ALIGNMENT) * GLB_ALIGNMENT
  const rest = input.subarray(jsonEnd) // 其余 chunk（BIN 等）原样保留
  const totalLength =
    GLB_HEADER_BYTES + GLB_CHUNK_HEADER_BYTES + paddedJsonLength + rest.byteLength

  const output = new Uint8Array(totalLength)
  writeUint32LE(output, 0, GLB_MAGIC)
  writeUint32LE(output, 4, GLB_VERSION)
  writeUint32LE(output, 8, totalLength)
  writeUint32LE(output, 12, paddedJsonLength)
  writeUint32LE(output, 16, GLB_CHUNK_JSON)
  output.set(jsonBytes, jsonStart)
  output.fill(0x20, jsonStart + jsonBytes.length, jsonStart + paddedJsonLength) // glTF JSON 填充 = 空格
  output.set(rest, jsonStart + paddedJsonLength)

  return { data: output, patches }
}
