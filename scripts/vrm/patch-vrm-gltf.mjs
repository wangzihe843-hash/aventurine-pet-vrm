#!/usr/bin/env node
/**
 * W0-5 小修：VRM/GLB 数据修复工具（本地私有资产，dev-only）
 *
 * 背景（W0-4 实测）：`星穹铁道—砂金·戏浪(1.0).vrm` 的材质 JSON 里有两类数据问题：
 *   1. `珍珠` 材质的 `VRMC_materials_mtoon.shadeMultiplyTexture = {}`（无 texture index）
 *      → three-vrm 3.5.5 透传给 GLTFLoader 时抛 TypeError，**整模型加载失败**；
 *   2. 29/39 材质 `alphaMode: BLEND`，其中 27 个 baseColor alpha≈1
 *      → three-vrm 走透明 pass + 双面 + outline clone 叠加，产生局部 ghost/排序瑕疵。
 *
 * 本工具只改 glTF **JSON chunk**（材质描述），**不动 BIN chunk**（几何/贴图/动画字节），
 * 重新封装 GLB 并做自校验，输出一个修复后的本地副本；原始资产不被修改。
 *
 * 用法：
 *   node scripts/vrm/patch-vrm-gltf.mjs <input.vrm> -o <output.vrm> [选项]
 *
 * 选项：
 *   --force-opaque-alpha1      把「alphaMode=BLEND 且 baseColor alpha≥0.99」的 MToon 材质改为 OPAQUE
 *                              （保留颜赤 α=0、目影 α=0.3 等真正半透明 overlay；不改变贴图/颜色）
 *   --report <path>            修复报告 JSON 输出路径（默认 tests/tmp/w0-5/patch-report.json）
 *   --no-report                不写报告文件
 *   -h, --help                 显示帮助
 *
 * 退出码：0 = 成功；1 = 失败（输入非法/自校验失败）；2 = 参数错误。
 *
 * 说明：`src/shared/vrm-glb.ts` 里有同一修复逻辑的 TS 版本（供 V1 loader 在
 * `GLTFLoader.parseAsync` 前做内存修复）；本脚本是它的 CLI 副本（.mjs 无法 import TS）。
 * 两者职责相同：只删「非法 texture 引用」/只改 alphaMode，不碰二进制数据。
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const DEFAULT_REPORT = path.join(ROOT, 'tests/tmp/w0-5/patch-report.json')

const GLB_MAGIC = 0x46546c67
const GLB_VERSION = 2
const GLB_CHUNK_JSON = 0x4e4f534a
const GLB_HEADER_BYTES = 12
const GLB_CHUNK_HEADER_BYTES = 8
const GLB_ALIGNMENT = 4

/** 打印用法。 */
function printHelp() {
  const text = readFileSync(fileURLToPath(import.meta.url), 'utf8')
  const start = text.indexOf('/**')
  const end = text.indexOf('*/')
  console.log(start >= 0 && end > start ? text.slice(start, end + 2) : 'patch-vrm-gltf.mjs')
}

function fail(message, code = 1) {
  console.error(`[patch-vrm-gltf] ERROR: ${message}`)
  process.exit(code)
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

function readUint32LE(bytes, offset) {
  return (
    (bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16) | (bytes[offset + 3] << 24)) >>>
    0
  )
}

function writeUint32LE(bytes, offset, value) {
  bytes[offset] = value & 0xff
  bytes[offset + 1] = (value >>> 8) & 0xff
  bytes[offset + 2] = (value >>> 16) & 0xff
  bytes[offset + 3] = (value >>> 24) & 0xff
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 解析 GLB 容器 → { json, jsonStart, jsonEnd, chunks }（chunks[0] 恒为 JSON）。 */
function parseGlb(bytes, label) {
  if (bytes.length < GLB_HEADER_BYTES + GLB_CHUNK_HEADER_BYTES) {
    fail(`${label}: 不是合法 GLB（长度不足）`)
  }
  if (readUint32LE(bytes, 0) !== GLB_MAGIC) fail(`${label}: 不是合法 GLB（magic 不是 glTF）`)
  const version = readUint32LE(bytes, 4)
  if (version !== GLB_VERSION) fail(`${label}: 不支持的 GLB 版本 ${version}（期望 2）`)
  const declaredTotal = readUint32LE(bytes, 8)
  if (declaredTotal !== bytes.length) {
    fail(`${label}: GLB 长度不一致（头 ${declaredTotal} vs 实际 ${bytes.length}）`)
  }
  const chunks = []
  let offset = GLB_HEADER_BYTES
  while (offset + GLB_CHUNK_HEADER_BYTES <= bytes.length) {
    const length = readUint32LE(bytes, offset)
    const type = readUint32LE(bytes, offset + 4)
    const start = offset + GLB_CHUNK_HEADER_BYTES
    if (start + length > bytes.length) fail(`${label}: chunk 越界（offset ${offset}）`)
    chunks.push({ type, length, start, bytes: bytes.subarray(start, start + length) })
    offset = start + length
  }
  if (chunks.length === 0 || chunks[0].type !== GLB_CHUNK_JSON) {
    fail(`${label}: 首个 chunk 不是 JSON`)
  }
  let json
  try {
    json = JSON.parse(new TextDecoder().decode(chunks[0].bytes))
  } catch (error) {
    fail(`${label}: JSON chunk 解析失败：${String(error)}`)
  }
  return { json, chunks }
}

/** 与 src/shared/vrm-glb.ts 相同的修复：删除 MToon 材质里没有合法 texture index 的贴图引用。 */
function removeInvalidMtoonTextures(json) {
  const patches = []
  const textureCount = Array.isArray(json.textures) ? json.textures.length : 0
  const materials = Array.isArray(json.materials) ? json.materials : []
  for (let materialIndex = 0; materialIndex < materials.length; materialIndex += 1) {
    const material = materials[materialIndex]
    if (!isRecord(material) || !isRecord(material.extensions)) continue
    const mtoon = material.extensions.VRMC_materials_mtoon
    if (!isRecord(mtoon)) continue
    const materialName =
      typeof material.name === 'string' && material.name.length > 0
        ? material.name
        : `material#${materialIndex}`
    for (const key of Object.keys(mtoon)) {
      if (!/texture/i.test(key)) continue
      const value = mtoon[key]
      if (value === null || value === undefined) continue
      const valid =
        isRecord(value) &&
        typeof value.index === 'number' &&
        Number.isInteger(value.index) &&
        value.index >= 0 &&
        value.index < textureCount
      if (valid) continue
      delete mtoon[key]
      patches.push({
        kind: 'invalid-texture-ref',
        materialIndex,
        material: materialName,
        key,
        invalidValue: value,
        patch: `removed invalid MToon texture ref (valid index range 0..${textureCount - 1})`
      })
    }
  }
  return patches
}

/** 把「BLEND 且 baseColor alpha≈1」的 MToon 材质改为 OPAQUE（保留真半透明 overlay）。 */
function forceOpaqueAlpha1(json) {
  const patches = []
  const materials = Array.isArray(json.materials) ? json.materials : []
  for (let materialIndex = 0; materialIndex < materials.length; materialIndex += 1) {
    const material = materials[materialIndex]
    if (!isRecord(material) || material.alphaMode !== 'BLEND') continue
    if (!isRecord(material.extensions) || !isRecord(material.extensions.VRMC_materials_mtoon)) {
      continue
    }
    const pbr = material.pbrMetallicRoughness
    const alpha =
      isRecord(pbr) && Array.isArray(pbr.baseColorFactor) && typeof pbr.baseColorFactor[3] === 'number'
        ? pbr.baseColorFactor[3]
        : 1
    if (!(alpha >= 0.99)) continue
    material.alphaMode = 'OPAQUE'
    patches.push({
      kind: 'alpha-mode',
      materialIndex,
      material:
        typeof material.name === 'string' && material.name.length > 0
          ? material.name
          : `material#${materialIndex}`,
      key: 'alphaMode',
      from: 'BLEND',
      to: 'OPAQUE',
      baseColorAlpha: alpha,
      patch: 'BLEND with opaque alpha -> OPAQUE (avoid transparent-pass ghosting)'
    })
  }
  return patches
}

/** 用修复后的 JSON 重新封装 GLB（BIN/其它 chunk 原样保留；JSON 4 字节对齐 + 空格填充）。 */
function rebuildGlb(chunks, json) {
  const jsonBytes = new TextEncoder().encode(JSON.stringify(json))
  const paddedJsonLength = Math.ceil(jsonBytes.length / GLB_ALIGNMENT) * GLB_ALIGNMENT
  const restChunks = chunks.slice(1)
  const totalLength =
    GLB_HEADER_BYTES +
    GLB_CHUNK_HEADER_BYTES +
    paddedJsonLength +
    restChunks.reduce((sum, chunk) => sum + GLB_CHUNK_HEADER_BYTES + chunk.length, 0)
  const output = new Uint8Array(totalLength)
  writeUint32LE(output, 0, GLB_MAGIC)
  writeUint32LE(output, 4, GLB_VERSION)
  writeUint32LE(output, 8, totalLength)
  writeUint32LE(output, 12, paddedJsonLength)
  writeUint32LE(output, 16, GLB_CHUNK_JSON)
  output.set(jsonBytes, GLB_HEADER_BYTES + GLB_CHUNK_HEADER_BYTES)
  output.fill(
    0x20,
    GLB_HEADER_BYTES + GLB_CHUNK_HEADER_BYTES + jsonBytes.length,
    GLB_HEADER_BYTES + GLB_CHUNK_HEADER_BYTES + paddedJsonLength
  )
  let offset = GLB_HEADER_BYTES + GLB_CHUNK_HEADER_BYTES + paddedJsonLength
  for (const chunk of restChunks) {
    writeUint32LE(output, offset, chunk.length)
    writeUint32LE(output, offset + 4, chunk.type)
    output.set(chunk.bytes, offset + GLB_CHUNK_HEADER_BYTES)
    offset += GLB_CHUNK_HEADER_BYTES + chunk.length
  }
  return output
}

/** 统计当前文件的材质 alphaMode / 非法 texture 引用，供修复前后对比与自校验。 */
function audit(json) {
  const materials = Array.isArray(json.materials) ? json.materials : []
  const alphaMode = {}
  let mtoonMaterials = 0
  let invalidTextureRefs = 0
  const textureCount = Array.isArray(json.textures) ? json.textures.length : 0
  for (const material of materials) {
    if (!isRecord(material)) continue
    const mode = typeof material.alphaMode === 'string' ? material.alphaMode : 'OPAQUE'
    alphaMode[mode] = (alphaMode[mode] ?? 0) + 1
    const mtoon =
      isRecord(material.extensions) && isRecord(material.extensions.VRMC_materials_mtoon)
        ? material.extensions.VRMC_materials_mtoon
        : null
    if (!mtoon) continue
    mtoonMaterials += 1
    for (const key of Object.keys(mtoon)) {
      if (!/texture/i.test(key)) continue
      const value = mtoon[key]
      if (value === null || value === undefined) continue
      const valid =
        isRecord(value) &&
        typeof value.index === 'number' &&
        Number.isInteger(value.index) &&
        value.index >= 0 &&
        value.index < textureCount
      if (!valid) invalidTextureRefs += 1
    }
  }
  return { materialCount: materials.length, mtoonMaterials, alphaMode, invalidTextureRefs }
}

/* -------------------------------------------------------------------------- */
/* 主流程                                                                      */
/* -------------------------------------------------------------------------- */

function main(argv) {
  if (argv.includes('-h') || argv.includes('--help')) {
    printHelp()
    return
  }
  const positional = []
  let output = null
  let reportPath = DEFAULT_REPORT
  let reportEnabled = true
  let forceOpaque = false
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '-o' || arg === '--out') {
      output = argv[index + 1]
      index += 1
    } else if (arg === '--report') {
      reportPath = argv[index + 1]
      index += 1
    } else if (arg === '--no-report') {
      reportEnabled = false
    } else if (arg === '--force-opaque-alpha1') {
      forceOpaque = true
    } else if (arg.startsWith('-')) {
      fail(`未知参数 ${arg}（--help 查看用法）`, 2)
    } else {
      positional.push(arg)
    }
  }
  if (positional.length !== 1) fail('需要且只需要一个输入 .vrm/.glb 路径（--help 查看用法）', 2)
  const inputPath = path.resolve(positional[0])
  if (!existsSync(inputPath)) fail(`输入文件不存在：${inputPath}`, 2)
  if (output === null) fail('必须用 -o/--out 指定输出路径（不覆盖原始资产）', 2)
  const outputPath = path.resolve(output)
  if (outputPath === inputPath) fail('输出路径不能与输入相同（原始资产只读）', 2)

  const startedAt = Date.now()
  const inputBytes = readFileSync(inputPath)
  const inputSha256 = sha256(inputBytes)
  const { json, chunks } = parseGlb(inputBytes, 'input')
  const before = audit(json)

  const invalidTexturePatches = removeInvalidMtoonTextures(json)
  const alphaPatches = forceOpaque ? forceOpaqueAlpha1(json) : []
  const after = audit(json)

  const outputBytes = rebuildGlb(chunks, json)

  // --- 自校验 ---
  const checks = {}
  const reparsed = parseGlb(outputBytes, 'output')
  checks.outputParsesAsGlb = true
  checks.outputLengthConsistent = readUint32LE(outputBytes, 8) === outputBytes.length
  checks.outputJsonChunkPadded = readUint32LE(outputBytes, 12) % GLB_ALIGNMENT === 0
  checks.materialCountUnchanged = reparsed.json.materials?.length === before.materialCount
  checks.alphaModeMatchesAudit =
    audit(reparsed.json).invalidTextureRefs === 0 && after.invalidTextureRefs === 0
  // BIN/其它 chunk 必须与原文件逐字节一致（除 JSON chunk 长度对齐造成的 offset 变化）
  const outputRest = reparsed.chunks.slice(1)
  const inputRest = chunks.slice(1)
  checks.restChunksIdentical =
    outputRest.length === inputRest.length &&
    outputRest.every(
      (chunk, index) =>
        chunk.type === inputRest[index].type &&
        chunk.length === inputRest[index].length &&
        Buffer.from(chunk.bytes).equals(Buffer.from(inputRest[index].bytes))
    )

  const failed = Object.entries(checks).filter(([, ok]) => !ok)
  mkdirSync(path.dirname(outputPath), { recursive: true })
  writeFileSync(outputPath, outputBytes)

  const report = {
    tool: 'scripts/vrm/patch-vrm-gltf.mjs',
    generatedAt: new Date().toISOString(),
    durationMs: Date.now() - startedAt,
    input: {
      path: path.relative(ROOT, inputPath),
      bytes: inputBytes.length,
      sha256: inputSha256
    },
    output: {
      path: path.relative(ROOT, outputPath),
      bytes: outputBytes.length,
      sha256: sha256(outputBytes)
    },
    options: { forceOpaqueAlpha1: forceOpaque },
    before,
    after,
    patches: {
      invalidTextureRefs: invalidTexturePatches,
      alphaMode: alphaPatches
    },
    checks,
    ok: failed.length === 0
  }
  if (reportEnabled) {
    mkdirSync(path.dirname(reportPath), { recursive: true })
    writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`)
  }

  console.log('==== patch-vrm-gltf ====')
  console.log(`input : ${report.input.path} (${report.input.bytes} B, sha256 ${inputSha256.slice(0, 16)}…)`)
  console.log(`output: ${report.output.path} (${report.output.bytes} B, sha256 ${report.output.sha256.slice(0, 16)}…)`)
  console.log(
    `before: materials=${before.materialCount} mtoon=${before.mtoonMaterials} alphaMode=${JSON.stringify(before.alphaMode)} invalidTextureRefs=${before.invalidTextureRefs}`
  )
  console.log(
    `after : materials=${after.materialCount} mtoon=${after.mtoonMaterials} alphaMode=${JSON.stringify(after.alphaMode)} invalidTextureRefs=${after.invalidTextureRefs}`
  )
  console.log(`patches: invalidTextureRefs=${invalidTexturePatches.length} alphaMode=${alphaPatches.length}`)
  for (const patch of [...invalidTexturePatches, ...alphaPatches]) {
    console.log(`  - [${patch.kind}] ${patch.material}.${patch.key}: ${patch.patch}`)
  }
  console.log(`checks: ${JSON.stringify(checks)}`)
  if (reportEnabled) console.log(`report: ${path.relative(ROOT, reportPath)}`)
  if (failed.length > 0) {
    fail(`自校验失败：${failed.map(([name]) => name).join(', ')}`)
  }
  console.log('PATCH OK')
}

main(process.argv.slice(2))
