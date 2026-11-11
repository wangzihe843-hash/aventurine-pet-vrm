#!/usr/bin/env node
/**
 * 用途（Purpose）
 * ---------------------------------------------------------------------------
 * 砂金·戏浪（aventurine-pet）桌面宠物的资源管线（Wave 0 / M0-3）：
 *
 *   1. 自动发现 assets/model 顶层唯一的 *.pmx，并用 mmd-parser 完整解析；
 *   2. 校验 PMX：metadata.textureCount 与 textures.length 一致；每个 texture 引用在
 *      assets/model 下按大小写敏感方式存在；materials 的 textureIndex / envTextureIndex /
 *      toonIndex（toonFlag===1 时）为 -1 或合法贴图索引；被引用贴图必须是 PNG；
 *   3. 把 PMX 按字节原样拷贝到 assets/model/optimized/（与源同 sha256/大小），作为打包
 *      payload 的一部分（electron-builder extraResources 只取 optimized/，原始 assets/model
 *      不入包；PMX 的 sha256/大小同时记录在 manifest.pmx）；
 *   4. 把最大边超过阈值的贴图等比降采样（默认 2048，sharp，fit=inside，不放大）写入
 *      assets/model/optimized/；未超阈值的贴图按字节原样拷贝（保证像素与哈希一致）；
 *   5. 清理 assets/model/optimized/ 中不再被引用的陈旧图片与陈旧 .pmx 副本；
 *   6. 生成 src/shared/assets-manifest.json（字段与 src/shared/types.ts 的
 *      AssetsManifest 冻结契约一致）。
 *
 *   产物总数：20 张贴图 + 1 个 PMX 字节副本 = 21 个文件（均在 optimized/ 下）。
 *
 * 用法（Usage）
 * ---------------------------------------------------------------------------
 *   node scripts/prepare-assets.mjs                  默认 max-edge=2048，生成产物 + manifest
 *   node scripts/prepare-assets.mjs --max-edge=1024  指定最大边阈值
 *   node scripts/prepare-assets.mjs --check          只检查不写入：重算并与现有 manifest 比对
 *                                                    （忽略 generatedAt），同时校验 optimized/ 落盘
 *                                                    产物（20 贴图 + 1 PMX 副本）的存在/大小/hash/
 *                                                    多余受管产物（仅图片与 .pmx）
 *   node scripts/prepare-assets.mjs --help           显示帮助
 *   pnpm assets:prepare                              package.json 中的快捷入口
 *
 * 所有权（Ownership）
 * ---------------------------------------------------------------------------
 *   Wave 0 / M0-3 交付物，负责人：assets。本脚本只允许写：
 *     - scripts/prepare-assets.mjs（本文件）
 *     - assets/model/optimized/**（产物，已被 .gitignore 忽略）
 *     - src/shared/assets-manifest.json（清单）
 *
 * 注意事项（Caveats）
 * ---------------------------------------------------------------------------
 *   - assets/model/ 是私有模型（版权 miHoYo，作者禁止二次配布/商用），已被 .gitignore
 *     忽略；禁止把原始 PMX / 贴图提交进 git，也不要移动、删除或改写原始文件。
 *   - 输出按 basename 展平到 optimized/ 顶层；若两个不同源贴图映射到同一输出名，脚本会
 *     显式报错而不是静默覆盖。
 *   - 缩放贴图会重新编码 PNG（compressionLevel=9, adaptiveFiltering）；未缩放贴图直接
 *     拷贝原始字节，不重新编码。
 *   - --check 需要重新编码缩放图以计算哈希（只在内存中，不落盘），耗时与普通运行接近。
 *   - --check 额外校验 optimized/ 内的 PMX 字节副本：文件存在、是普通文件、大小与 sha256
 *     与 manifest.pmx 一致；optimized/ 内出现当前 manifest 不期望的 *.pmx 也会报“多余产物”。
 *   - generatedAt 幂等：write 模式下若重新计算结果与现有 manifest 去掉 generatedAt 后深相等，
 *     则保留旧 generatedAt 且**不重写** src/shared/assets-manifest.json（日志标注“manifest 未变化”），
 *     因此重复执行 `pnpm assets:prepare` 不会弄脏被 git 跟踪的 manifest。
 *   - 受管产物范围：cleanup / --check 的“多余产物”只覆盖**受管扩展名**（图片 + .pmx，
 *     MANAGED_OUTPUT_EXTENSIONS）；optimized/ 里的 .txt、无扩展名、子目录等其它文件按设计保留，
 *     不视为产物（独立复验 LOW-8）。
 *   - 非事务：write 模式按「贴图 → PMX 副本 → 清理陈旧 → manifest」顺序落盘，任一步失败可能留下
 *     中间态；重跑一次即可自愈，`--check` 可发现中间态（独立复验 LOW-9）。不要与 `--check`
 *     在同一工作树并发运行（独立复验 LOW-12）。
 */

import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { Parser } from 'mmd-parser'
import sharp from 'sharp'

/* ------------------------------- 常量与路径 ------------------------------- */

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(SCRIPT_DIR, '..')
const MODEL_DIR = path.join(REPO_ROOT, 'assets', 'model')
const OPTIMIZED_DIR = path.join(MODEL_DIR, 'optimized')
const MANIFEST_PATH = path.join(REPO_ROOT, 'src', 'shared', 'assets-manifest.json')

const SOURCE_DIR_REL = 'assets/model'
const OUTPUT_DIR_REL = 'assets/model/optimized'
const MANIFEST_REL = 'src/shared/assets-manifest.json'

const SCHEMA_VERSION = 1
const DEFAULT_MAX_EDGE = 2048
const IMAGE_EXTENSIONS = new Set(['.png', '.bmp', '.jpg', '.jpeg', '.tga', '.dds', '.gif'])
const PMX_EXTENSION = '.pmx'
/** optimized/ 下由本脚本托管、可被清理/检查的产物扩展名（图片 + PMX 副本）。 */
const MANAGED_OUTPUT_EXTENSIONS = new Set([...IMAGE_EXTENSIONS, PMX_EXTENSION])
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

class PipelineError extends Error {
  constructor(message) {
    super(message)
    this.name = 'PipelineError'
  }
}

/* --------------------------------- CLI ---------------------------------- */

function usage() {
  return [
    '资源管线脚本（Wave 0 / M0-3）',
    '',
    '用法：',
    '  node scripts/prepare-assets.mjs [选项]',
    '  pnpm assets:prepare',
    '',
    '选项：',
    '  --max-edge=<n>   贴图最大边阈值（默认 2048）；最大边超过该值的贴图按 fit=inside 等比缩小',
    '  --check          只检查不写入：重算并比对现有 manifest（忽略 generatedAt），并校验 optimized/ 落盘产物',
    '                   （含 20 张贴图 + 1 个 PMX 副本的存在/大小/hash/多余受管产物）',
    '  -h, --help       显示本帮助',
    '',
    '输出：',
    `  ${OUTPUT_DIR_REL}/*.png`.padEnd(48) + ' 优化后的贴图（已被 .gitignore 忽略）',
    `  ${OUTPUT_DIR_REL}/<模型文件名>.pmx`.padEnd(48) + ' PMX 字节副本（打包 payload，已被 .gitignore 忽略）',
    `  ${MANIFEST_REL}`.padEnd(48) + ' 资源清单（AssetsManifest 冻结契约）',
  ].join('\n')
}

function parseMaxEdge(raw) {
  const text = String(raw).trim()
  if (!/^\d+$/.test(text)) {
    throw new PipelineError(`--max-edge 必须是正整数，收到：${JSON.stringify(raw)}`)
  }
  const value = Number(text)
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new PipelineError(`--max-edge 必须是正整数，收到：${JSON.stringify(raw)}`)
  }
  return value
}

function parseArgs(argv) {
  const options = { maxEdge: DEFAULT_MAX_EDGE, check: false, help: false }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--help' || arg === '-h') {
      options.help = true
      continue
    }
    if (arg === '--check') {
      options.check = true
      continue
    }
    if (arg === '--max-edge') {
      if (index + 1 >= argv.length) {
        throw new PipelineError(`--max-edge 缺少取值\n\n${usage()}`)
      }
      index += 1
      options.maxEdge = parseMaxEdge(argv[index])
      continue
    }
    if (arg.startsWith('--max-edge=')) {
      options.maxEdge = parseMaxEdge(arg.slice('--max-edge='.length))
      continue
    }
    throw new PipelineError(`未知参数：${arg}\n\n${usage()}`)
  }
  return options
}

/* -------------------------------- 通用工具 -------------------------------- */

function normalizeSlashes(raw) {
  return String(raw).replace(/\\/g, '/')
}

/** 去掉全部前导 './'，得到相对 assets/model 的 POSIX 路径。 */
function stripLeadingDotSlash(value) {
  let result = value
  while (result.startsWith('./')) {
    result = result.slice(2)
  }
  return result
}

function sha256Buffer(buffer) {
  return createHash('sha256').update(buffer).digest('hex')
}

function sha256File(filePath) {
  return sha256Buffer(fs.readFileSync(filePath))
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) {
    return 'n/a'
  }
  if (bytes < 1024) {
    return `${bytes} B`
  }
  const units = ['KiB', 'MiB', 'GiB']
  let value = bytes / 1024
  let unitIndex = 0
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024
    unitIndex += 1
  }
  return `${bytes.toLocaleString('en-US')} B (${value.toFixed(2)} ${units[unitIndex]})`
}

function formatChangeRatio(before, after) {
  if (!Number.isFinite(before) || before === 0) {
    return 'n/a'
  }
  const percent = ((after - before) / before) * 100
  return `${percent >= 0 ? '+' : ''}${percent.toFixed(1)}%`
}

function readFileHead(filePath, length) {
  const fd = fs.openSync(filePath, 'r')
  try {
    const buffer = Buffer.alloc(length)
    const read = fs.readSync(fd, buffer, 0, length, 0)
    return buffer.subarray(0, read)
  } finally {
    fs.closeSync(fd)
  }
}

/**
 * 按目录逐段做“大小写敏感”的文件存在性解析。
 * macOS 默认文件系统大小写不敏感，fs.existsSync('a.png') 对 A.png 也会返回 true，
 * 因此这里显式对比 readdir 返回的真实条目名。路径包含 '..' / 绝对路径 / 非法字符时返回 null。
 */
function resolveCaseSensitive(baseDir, relativePosixPath) {
  if (typeof relativePosixPath !== 'string' || relativePosixPath.length === 0) {
    return null
  }
  if (path.posix.isAbsolute(relativePosixPath) || /^[A-Za-z]:/.test(relativePosixPath)) {
    return null
  }
  const parts = relativePosixPath.split('/').filter((part) => part !== '' && part !== '.')
  if (parts.length === 0 || parts.some((part) => part === '..')) {
    return null
  }

  let current = baseDir
  for (const part of parts) {
    let entries
    try {
      entries = fs.readdirSync(current, { withFileTypes: true })
    } catch {
      return null
    }
    const hit = entries.find((entry) => entry.name === part)
    if (hit === undefined) {
      return null
    }
    current = path.join(current, part)
  }

  let stat
  try {
    stat = fs.statSync(current)
  } catch {
    return null
  }
  return stat.isFile() ? current : null
}

/* ------------------------------ 模型发现/解析 ------------------------------ */

function discoverPmx() {
  let entries
  try {
    entries = fs.readdirSync(MODEL_DIR, { withFileTypes: true })
  } catch (error) {
    throw new PipelineError(`无法读取模型目录 ${SOURCE_DIR_REL}：${error.message}`)
  }
  const candidates = entries
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.pmx'))
    .map((entry) => entry.name)
    .sort()

  if (candidates.length === 0) {
    throw new PipelineError(`在 ${SOURCE_DIR_REL} 顶层未找到任何 *.pmx 文件`)
  }
  if (candidates.length > 1) {
    throw new PipelineError(
      `在 ${SOURCE_DIR_REL} 顶层找到多个 *.pmx，无法自动确定唯一模型：\n` +
        candidates.map((name) => `  - ${name}`).join('\n'),
    )
  }

  const file = candidates[0]
  return { file, absPath: path.join(MODEL_DIR, file) }
}

function readPmx(pmxFile, pmxPath) {
  const buffer = fs.readFileSync(pmxPath)
  // 只把 Buffer 自己的那一段字节交给 parser，避免共享底层 ArrayBuffer 的越界问题。
  const arrayBuffer = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength)

  let pmx
  try {
    pmx = new Parser().parsePmx(arrayBuffer, true)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new PipelineError(`PMX 解析失败（${pmxFile}）：${message}`)
  }
  if (pmx === null || typeof pmx !== 'object' || pmx.metadata === undefined) {
    throw new PipelineError(`PMX 解析结果异常（${pmxFile}）：缺少 metadata`)
  }
  return { buffer, pmx }
}

/**
 * 校验 PMX 的贴图引用与材质贴图索引。
 * 返回 { refs, sources, resolved, missing }：
 *   refs     = PMX texture 表中原样引用（仅把反斜杠规范成 /）
 *   sources  = 相对 assets/model 的 POSIX 路径（去掉前导 './'）
 *   resolved = Map<source, 绝对路径>
 *   missing  = 缺失引用列表（校验失败时不为空，但不会走到写产物）
 */
function validatePmx(pmx, pmxFile) {
  const issues = []
  const metadata = pmx.metadata
  const textureCount = metadata.textureCount
  const textures = Array.isArray(pmx.textures) ? pmx.textures : []

  if (metadata.format !== 'pmx') {
    issues.push(`metadata.format 应为 'pmx'，实际为 ${JSON.stringify(metadata.format)}`)
  }
  if (textureCount !== textures.length) {
    issues.push(
      `metadata.textureCount(${JSON.stringify(textureCount)}) 与 textures.length(${textures.length}) 不一致`,
    )
  }

  const refs = []
  const sources = []
  const resolved = new Map()
  const missing = []

  for (let index = 0; index < textures.length; index += 1) {
    const rawRef = textures[index]
    if (typeof rawRef !== 'string') {
      issues.push(`texture #${index} 不是字符串：${JSON.stringify(rawRef)}`)
      refs.push(String(rawRef))
      sources.push(String(rawRef))
      continue
    }

    const ref = normalizeSlashes(rawRef)
    const source = stripLeadingDotSlash(ref)
    refs.push(ref)
    sources.push(source)

    if (resolved.has(source) && resolved.get(source) !== null) {
      continue
    }

    const absPath = resolveCaseSensitive(MODEL_DIR, source)
    if (absPath === null) {
      missing.push(ref)
      resolved.set(source, null)
      continue
    }
    resolved.set(source, absPath)

    // 被引用的贴图必须是 PNG：扩展名 + 文件头双重确认，绝不静默转换。
    const extension = path.posix.extname(source).toLowerCase()
    if (extension !== '.png') {
      issues.push(
        `texture #${index}（${JSON.stringify(ref)}）不是 PNG（扩展名 ${extension || '(无)'}）；` +
          '当前资源管线只接受 PNG，未来如需其它格式请显式扩展转换逻辑，不要静默转换。',
      )
      continue
    }
    const head = readFileHead(absPath, PNG_MAGIC.length)
    if (!head.equals(PNG_MAGIC)) {
      issues.push(`texture #${index}（${JSON.stringify(ref)}）扩展名为 .png，但文件头不是 PNG 魔数`)
    }
  }

  if (missing.length > 0) {
    issues.push(
      `以下 ${missing.length} 个 texture 引用在 ${SOURCE_DIR_REL} 下不存在（大小写敏感）：\n` +
        missing.map((ref) => `    - ${JSON.stringify(ref)}`).join('\n'),
    )
  }

  const materialCount = Array.isArray(pmx.materials) ? pmx.materials.length : 0
  for (let index = 0; index < materialCount; index += 1) {
    const material = pmx.materials[index]
    const label = `材质 #${index}（${JSON.stringify(material.name ?? '?')}）`
    checkTextureIndex(material.textureIndex, `${label}.textureIndex`, textures.length, issues)
    checkTextureIndex(material.envTextureIndex, `${label}.envTextureIndex`, textures.length, issues)
    if (material.toonFlag === 1) {
      checkTextureIndex(material.toonIndex, `${label}.toonIndex`, textures.length, issues)
    }
  }

  if (issues.length > 0) {
    const limit = 40
    const lines = issues.slice(0, limit).map((issue) => `  - ${issue}`)
    if (issues.length > limit) {
      lines.push(`  - …… 其余 ${issues.length - limit} 条省略`)
    }
    throw new PipelineError(`PMX 校验失败（${pmxFile}）：\n${lines.join('\n')}`)
  }

  return { refs, sources, resolved, missing }
}

function checkTextureIndex(value, label, textureCount, issues) {
  if (value === -1) {
    return
  }
  if (!Number.isInteger(value) || value < 0 || value >= textureCount) {
    issues.push(`${label}=${JSON.stringify(value)} 越界（合法值：-1 或 0..${textureCount - 1}）`)
  }
}

/* ------------------------------- 贴图处理 -------------------------------- */

/**
 * 生成唯一源贴图列表并检查输出名冲突（大小写不敏感，兼容 macOS 默认文件系统）。
 * @returns {Map<string, { source: string, optimized: string, sourceAbs: string }>}
 */
function planTextures(sources, resolved) {
  const plan = new Map()
  const optimizedByLowerName = new Map()

  for (const source of sources) {
    if (plan.has(source)) {
      continue
    }
    const optimized = path.posix.basename(source)
    const lowerName = optimized.toLowerCase()
    const conflict = optimizedByLowerName.get(lowerName)
    if (conflict !== undefined) {
      throw new PipelineError(
        `贴图输出文件名冲突（大小写不敏感）：${JSON.stringify(conflict)} 与 ${JSON.stringify(source)} ` +
          `都会输出为 ${JSON.stringify(optimized)}；请先调整 PMX 内的贴图引用。`,
      )
    }
    optimizedByLowerName.set(lowerName, source)
    plan.set(source, { source, optimized, sourceAbs: resolved.get(source) })
  }
  return plan
}

async function buildTextureArtifact(entry, maxEdge) {
  const { source, sourceAbs, optimized } = entry
  let stat
  try {
    stat = fs.statSync(sourceAbs)
  } catch (error) {
    throw new PipelineError(`无法读取贴图 ${JSON.stringify(source)}：${error.message}`)
  }
  const sourceBytes = stat.size
  const sourceSha256 = sha256File(sourceAbs)

  let metadata
  try {
    metadata = await sharp(sourceAbs).metadata()
  } catch (error) {
    throw new PipelineError(`无法读取贴图尺寸 ${JSON.stringify(source)}：${error.message}`)
  }
  const sourceWidth = metadata.width
  const sourceHeight = metadata.height
  if (!Number.isInteger(sourceWidth) || !Number.isInteger(sourceHeight) || sourceWidth <= 0 || sourceHeight <= 0) {
    throw new PipelineError(`贴图尺寸异常 ${JSON.stringify(source)}：${sourceWidth}x${sourceHeight}`)
  }

  const resized = Math.max(sourceWidth, sourceHeight) > maxEdge
  if (!resized) {
    // 未超过阈值：按字节原样拷贝，像素/哈希与源文件完全一致。
    return {
      source,
      sourceAbs,
      optimized,
      resized: false,
      sourceWidth,
      sourceHeight,
      width: sourceWidth,
      height: sourceHeight,
      sourceBytes,
      bytes: sourceBytes,
      sourceSha256,
      sha256: sourceSha256,
      buffer: null,
    }
  }

  let encoded
  try {
    encoded = await sharp(sourceAbs)
      .resize({ width: maxEdge, height: maxEdge, fit: 'inside', withoutEnlargement: true })
      .png({ compressionLevel: 9, adaptiveFiltering: true })
      .toBuffer({ resolveWithObject: true })
  } catch (error) {
    throw new PipelineError(`缩放贴图失败 ${JSON.stringify(source)}：${error.message}`)
  }
  const { data, info } = encoded
  if (info.width > maxEdge || info.height > maxEdge) {
    throw new PipelineError(
      `缩放结果仍超过阈值 ${JSON.stringify(source)}：${info.width}x${info.height} > maxEdge=${maxEdge}`,
    )
  }
  return {
    source,
    sourceAbs,
    optimized,
    resized: true,
    sourceWidth,
    sourceHeight,
    width: info.width,
    height: info.height,
    sourceBytes,
    bytes: data.length,
    sourceSha256,
    sha256: sha256Buffer(data),
    buffer: data,
  }
}

async function buildArtifacts(sources, resolved, maxEdge) {
  const plan = planTextures(sources, resolved)
  const artifacts = new Map()
  for (const entry of plan.values()) {
    artifacts.set(entry.source, await buildTextureArtifact(entry, maxEdge))
  }
  return artifacts
}

/* ------------------------------ 输出目录/清单 ------------------------------ */

function ensureOptimizedDir() {
  if (fs.existsSync(OPTIMIZED_DIR)) {
    const stat = fs.lstatSync(OPTIMIZED_DIR)
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new PipelineError(`输出路径异常（不是普通目录）：${OUTPUT_DIR_REL}`)
    }
    return
  }
  fs.mkdirSync(OPTIMIZED_DIR, { recursive: true })
}

function writeArtifacts(artifacts) {
  for (const artifact of artifacts.values()) {
    const outputPath = path.join(OPTIMIZED_DIR, artifact.optimized)
    if (artifact.resized) {
      fs.writeFileSync(outputPath, artifact.buffer)
      const outputSha256 = sha256File(outputPath)
      if (outputSha256 !== artifact.sha256) {
        throw new PipelineError(
          `缩放输出写入后哈希不一致（${artifact.optimized}）：期望 ${artifact.sha256}，实际 ${outputSha256}`,
        )
      }
    } else {
      fs.copyFileSync(artifact.sourceAbs, outputPath)
      const outputSha256 = sha256File(outputPath)
      if (outputSha256 !== artifact.sourceSha256) {
        throw new PipelineError(
          `拷贝输出与源文件哈希不一致（${artifact.optimized}）：期望 ${artifact.sourceSha256}，实际 ${outputSha256}`,
        )
      }
    }
  }
}

/**
 * 构造 optimized/ 内 PMX 字节副本的产物描述。
 * 原始 PMX 的 file/bytes/sha256 已记录在 manifest.pmx，因此该副本不扩展 manifest schema。
 */
function buildPmxArtifact({ pmxFile, pmxPath, pmxBytes, pmxSha256 }) {
  return {
    optimized: pmxFile,
    sourceAbs: pmxPath,
    bytes: pmxBytes,
    sha256: pmxSha256,
  }
}

/** write 模式：把 PMX 按字节原样拷贝进 optimized/；写后自查大小/sha256（绝不碰源文件）。 */
function writePmxCopy(pmxArtifact) {
  const relativePath = `${OUTPUT_DIR_REL}/${pmxArtifact.optimized}`
  const outputPath = path.join(OPTIMIZED_DIR, pmxArtifact.optimized)
  fs.copyFileSync(pmxArtifact.sourceAbs, outputPath)
  const stat = fs.statSync(outputPath)
  if (!stat.isFile() || stat.size !== pmxArtifact.bytes) {
    throw new PipelineError(
      `PMX 副本写入后大小不一致（${relativePath}）：期望 ${pmxArtifact.bytes}，实际 ${stat.size}`,
    )
  }
  const outputSha256 = sha256File(outputPath)
  if (outputSha256 !== pmxArtifact.sha256) {
    throw new PipelineError(
      `PMX 副本写入后哈希不一致（${relativePath}）：期望 ${pmxArtifact.sha256}，实际 ${outputSha256}`,
    )
  }
}

/** --check 专用（只读）：校验 optimized/ 内 PMX 副本存在/普通文件/大小/sha256。 */
function inspectPmxCopyOnDisk(pmxArtifact) {
  const relativePath = `${OUTPUT_DIR_REL}/${pmxArtifact.optimized}`
  const outputPath = path.join(OPTIMIZED_DIR, pmxArtifact.optimized)
  let stat
  try {
    stat = fs.statSync(outputPath)
  } catch (error) {
    return [`缺失 PMX 副本：${relativePath}（${error.code ?? error.message}）`]
  }
  if (!stat.isFile()) {
    return [`PMX 副本不是普通文件：${relativePath}`]
  }
  if (stat.size !== pmxArtifact.bytes) {
    return [`PMX 副本大小不一致：${relativePath} 期望 ${pmxArtifact.bytes}，实际 ${stat.size}`]
  }
  const actualSha256 = sha256File(outputPath)
  if (actualSha256 !== pmxArtifact.sha256) {
    return [`PMX 副本 sha256 不一致：${relativePath} 期望 ${pmxArtifact.sha256}，实际 ${actualSha256}`]
  }
  return []
}

/**
 * 清理 optimized/ 中不再被引用的陈旧产物（贴图与陈旧 .pmx 副本）。
 * 只删该目录内普通文件，不碰 assets/model 源文件；符号链接等一律不删除。
 * 返回被删除的相对路径列表（POSIX，排序）。
 */
function cleanupStaleOutputs(artifacts, pmxArtifact) {
  const expected = new Set()
  for (const artifact of artifacts.values()) {
    expected.add(artifact.optimized.toLowerCase())
  }
  expected.add(pmxArtifact.optimized.toLowerCase())

  const removed = []
  const walk = (directory) => {
    let entries
    try {
      entries = fs.readdirSync(directory, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const absPath = path.join(directory, entry.name)
      if (entry.isDirectory()) {
        walk(absPath)
        continue
      }
      // 只处理普通文件；符号链接等一律不删除，避免误伤目录外内容。
      if (!entry.isFile()) {
        continue
      }
      const extension = path.extname(entry.name).toLowerCase()
      if (!MANAGED_OUTPUT_EXTENSIONS.has(extension)) {
        continue
      }
      const relativePath = path.relative(OPTIMIZED_DIR, absPath).split(path.sep).join('/')
      if (expected.has(relativePath.toLowerCase())) {
        continue
      }
      fs.rmSync(absPath, { force: true })
      removed.push(relativePath)
    }
  }
  walk(OPTIMIZED_DIR)
  return removed.sort()
}

/**
 * `--check` 专用（只读，不写盘）：校验 optimized/ 落盘产物与本次重算期望一致：
 *  - 20 张贴图产物存在、是普通文件、字节数与 sha256 与 artifacts 一致（缩放图也会重编码比对）；
 *  - PMX 字节副本存在、是普通文件、大小与 sha256 与 manifest.pmx 一致；
 *  - optimized/ 内没有当前 manifest 不期望的图片 / .pmx 文件（陈旧或多余产物）。
 * 返回问题描述列表（空数组 = 全部一致）。
 */
function inspectOutputsOnDisk(artifacts, pmxArtifact) {
  const issues = []
  const expected = new Map()
  for (const artifact of artifacts.values()) {
    expected.set(artifact.optimized.toLowerCase(), artifact)
  }
  expected.set(pmxArtifact.optimized.toLowerCase(), pmxArtifact)
  issues.push(...inspectPmxCopyOnDisk(pmxArtifact))

  for (const artifact of artifacts.values()) {
    const relativePath = `${OUTPUT_DIR_REL}/${artifact.optimized}`
    const outputPath = path.join(OPTIMIZED_DIR, artifact.optimized)
    let stat
    try {
      stat = fs.statSync(outputPath)
    } catch (error) {
      issues.push(`缺失产物：${relativePath}（${error.code ?? error.message}）`)
      continue
    }
    if (!stat.isFile()) {
      issues.push(`产物不是普通文件：${relativePath}`)
      continue
    }
    if (stat.size !== artifact.bytes) {
      issues.push(`产物大小不一致：${relativePath} 期望 ${artifact.bytes}，实际 ${stat.size}`)
      continue
    }
    const actualSha256 = sha256File(outputPath)
    if (actualSha256 !== artifact.sha256) {
      issues.push(
        `产物 sha256 不一致：${relativePath} 期望 ${artifact.sha256}，实际 ${actualSha256}`,
      )
    }
  }

  if (fs.existsSync(OPTIMIZED_DIR)) {
    const walkForStale = (directory) => {
      let entries
      try {
        entries = fs.readdirSync(directory, { withFileTypes: true })
      } catch {
        return
      }
      for (const entry of entries) {
        const absPath = path.join(directory, entry.name)
        if (entry.isDirectory()) {
          walkForStale(absPath)
          continue
        }
        // 与 cleanupStaleOutputs 保持一致：只把普通图片 / .pmx 文件视为产物。
        if (!entry.isFile()) {
          continue
        }
        if (!MANAGED_OUTPUT_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
          continue
        }
        const relativePath = path.relative(OPTIMIZED_DIR, absPath).split(path.sep).join('/')
        if (!expected.has(relativePath.toLowerCase())) {
          issues.push(`多余产物：${OUTPUT_DIR_REL}/${relativePath}（当前 manifest 不期望该文件）`)
        }
      }
    }
    walkForStale(OPTIMIZED_DIR)
  }

  return issues
}

function buildTextureManifest(refs, sources, artifacts) {
  return refs.map((ref, index) => {
    const source = sources[index]
    const artifact = artifacts.get(source)
    if (artifact === undefined) {
      throw new PipelineError(`内部错误：贴图 ${JSON.stringify(source)} 没有对应的处理结果`)
    }
    return {
      index,
      name: ref,
      source,
      optimized: artifact.optimized,
      resized: artifact.resized,
      sourceWidth: artifact.sourceWidth,
      sourceHeight: artifact.sourceHeight,
      width: artifact.width,
      height: artifact.height,
      sourceBytes: artifact.sourceBytes,
      bytes: artifact.bytes,
      sourceSha256: artifact.sourceSha256,
      sha256: artifact.sha256,
    }
  })
}

/** assets/model 顶层未被 PMX 引用的图片文件（排序）。 */
function findUnreferencedFiles(sources) {
  const referencedTopLevel = new Set()
  for (const source of sources) {
    if (!source.includes('/')) {
      referencedTopLevel.add(source)
    }
  }

  const unreferenced = []
  for (const entry of fs.readdirSync(MODEL_DIR, { withFileTypes: true })) {
    if (!entry.isFile()) {
      continue
    }
    const extension = path.extname(entry.name).toLowerCase()
    if (!IMAGE_EXTENSIONS.has(extension)) {
      continue
    }
    if (referencedTopLevel.has(entry.name)) {
      continue
    }
    unreferenced.push(entry.name)
  }
  return unreferenced.sort()
}

function buildManifest({ pmxFile, pmxBytes, pmxSha256, pmx, refs, missing, textures, unreferencedFiles, maxEdge }) {
  const metadata = pmx.metadata
  return {
    schemaVersion: SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    sourceDir: SOURCE_DIR_REL,
    outputDir: OUTPUT_DIR_REL,
    maxEdge,
    pmx: {
      file: pmxFile,
      bytes: pmxBytes,
      sha256: pmxSha256,
      version: metadata.version,
      modelName: metadata.modelName,
      counts: {
        vertices: pmx.vertices.length,
        faces: pmx.faces.length,
        materials: pmx.materials.length,
        bones: pmx.bones.length,
        morphs: pmx.morphs.length,
        rigidBodies: pmx.rigidBodies.length,
        constraints: pmx.constraints.length,
        textures: pmx.textures.length,
      },
      textureReferences: refs,
      missingTextures: missing,
    },
    textures,
    unreferencedFiles,
  }
}

/* ------------------------------ --check 比对 ------------------------------ */

function stripGeneratedAt(manifest) {
  const { generatedAt: _generatedAt, ...rest } = manifest
  return rest
}

function shortJson(value) {
  const text = JSON.stringify(value)
  if (text === undefined) {
    return String(value)
  }
  return text.length > 120 ? `${text.slice(0, 117)}...` : text
}

function diffDeep(expected, actual, at, diffs) {
  if (Object.is(expected, actual)) {
    return
  }
  const expectedType = typeof expected
  const actualType = typeof actual
  if (expectedType !== actualType) {
    diffs.push(`${at}: 期望 ${expectedType} ${shortJson(expected)}，实际 ${actualType} ${shortJson(actual)}`)
    return
  }
  if (Array.isArray(expected) || Array.isArray(actual)) {
    if (!Array.isArray(expected) || !Array.isArray(actual)) {
      diffs.push(`${at}: 期望 ${shortJson(expected)}，实际 ${shortJson(actual)}`)
      return
    }
    if (expected.length !== actual.length) {
      diffs.push(`${at}.length: 期望 ${expected.length}，实际 ${actual.length}`)
    }
    const common = Math.min(expected.length, actual.length)
    for (let index = 0; index < common; index += 1) {
      diffDeep(expected[index], actual[index], `${at}[${index}]`, diffs)
    }
    return
  }
  if (expected !== null && actual !== null && expectedType === 'object') {
    const keys = new Set([...Object.keys(expected), ...Object.keys(actual)])
    for (const key of [...keys].sort()) {
      if (!(key in expected)) {
        diffs.push(`${at}.${key}: 期望不存在，实际=${shortJson(actual[key])}`)
        continue
      }
      if (!(key in actual)) {
        diffs.push(`${at}.${key}: 期望=${shortJson(expected[key])}，实际不存在`)
        continue
      }
      diffDeep(expected[key], actual[key], `${at}.${key}`, diffs)
    }
    return
  }
  diffs.push(`${at}: 期望 ${shortJson(expected)}，实际 ${shortJson(actual)}`)
}

function readExistingManifest() {
  try {
    const raw = fs.readFileSync(MANIFEST_PATH, 'utf8')
    return { ok: true, manifest: JSON.parse(raw) }
  } catch (error) {
    if (error.code === 'ENOENT') {
      return { ok: false, error: `${MANIFEST_REL} 不存在` }
    }
    return { ok: false, error: `读取/解析 ${MANIFEST_REL} 失败：${error.message}` }
  }
}

/** 结构深相等（忽略对象键顺序，用于 generatedAt 幂等判断）。 */
function deepEqual(left, right) {
  if (Object.is(left, right)) {
    return true
  }
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) {
      return false
    }
    return left.every((item, index) => deepEqual(item, right[index]))
  }
  if (typeof left !== 'object' || typeof right !== 'object' || left === null || right === null) {
    return false
  }
  const leftKeys = Object.keys(left)
  const rightKeys = Object.keys(right)
  if (leftKeys.length !== rightKeys.length) {
    return false
  }
  return leftKeys.every((key) => key in right && deepEqual(left[key], right[key]))
}

/**
 * write 模式幂等写 manifest：
 * 若现有 manifest 存在且“去掉 generatedAt 后与新结果深相等”，保留旧 generatedAt 且不写文件
 * （避免每次运行都改 tracked manifest 的 generatedAt 弄脏工作树）；否则才落盘新内容。
 * @returns {{ written: boolean, keptGeneratedAt: string | null }}
 */
function writeManifestIfChanged(manifest) {
  const existing = readExistingManifest()
  if (existing.ok && deepEqual(stripGeneratedAt(manifest), stripGeneratedAt(existing.manifest))) {
    const keptGeneratedAt =
      typeof existing.manifest.generatedAt === 'string' ? existing.manifest.generatedAt : null
    if (keptGeneratedAt !== null) {
      manifest.generatedAt = keptGeneratedAt
    }
    return { written: false, keptGeneratedAt }
  }
  fs.mkdirSync(path.dirname(MANIFEST_PATH), { recursive: true })
  fs.writeFileSync(MANIFEST_PATH, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
  return { written: true, keptGeneratedAt: null }
}

function runCheck(manifest, artifacts, pmxArtifact) {
  const existing = readExistingManifest()
  if (!existing.ok) {
    console.error(`\n✖ --check 失败：${existing.error}`)
    return 1
  }
  const diffs = []
  diffDeep(stripGeneratedAt(manifest), stripGeneratedAt(existing.manifest), '$', diffs)
  const outputIssues = inspectOutputsOnDisk(artifacts, pmxArtifact)
  const resizedCount = manifest.textures.filter((entry) => entry.resized).length
  if (diffs.length === 0 && outputIssues.length === 0) {
    console.log(
      `\n[assets] --check 通过：${MANIFEST_REL} 与重新计算结果一致（已忽略 generatedAt），` +
        `且 ${OUTPUT_DIR_REL}/ 落盘产物（${manifest.textures.length} 张贴图 + 1 个 PMX 副本）完整一致`,
    )
    console.log(
      `CHECK OK manifest=${MANIFEST_REL} textures=${manifest.textures.length} resized=${resizedCount} ` +
        `pmxCopy=1`,
    )
    return 0
  }
  const allIssues = [...diffs, ...outputIssues]
  console.error(
    `\n✖ --check 失败：共 ${allIssues.length} 处问题（${diffs.length} 处 manifest 不一致 / ` +
      `${outputIssues.length} 处落盘产物问题）：`,
  )
  const limit = 50
  for (const issue of allIssues.slice(0, limit)) {
    console.error(`  - ${issue}`)
  }
  if (allIssues.length > limit) {
    console.error(`  - …… 其余 ${allIssues.length - limit} 处省略`)
  }
  return 1
}

/* --------------------------------- 摘要输出 -------------------------------- */

function printSummary({ manifest, artifacts, pmxArtifact, mode }) {
  const counts = manifest.pmx.counts
  const resizedCount = manifest.textures.filter((entry) => entry.resized).length
  const copiedCount = manifest.textures.length - resizedCount
  const optimizedFileCount = artifacts.size + 1

  let totalSourceBytes = 0
  let totalOutputBytes = 0
  for (const artifact of artifacts.values()) {
    totalSourceBytes += artifact.sourceBytes
    totalOutputBytes += artifact.bytes
  }

  console.log('')
  console.log(`[assets] 模式：${mode}`)
  console.log(`[assets] PMX：${SOURCE_DIR_REL}/${manifest.pmx.file}`)
  console.log(`[assets]   字节=${manifest.pmx.bytes.toLocaleString('en-US')} sha256=${manifest.pmx.sha256}`)
  console.log(`[assets]   version=${manifest.pmx.version} modelName=${JSON.stringify(manifest.pmx.modelName)}`)
  console.log(
    `[assets] PMX 字节副本：${OUTPUT_DIR_REL}/${pmxArtifact.optimized}（${formatBytes(pmxArtifact.bytes)}，` +
      '大小/sha256 与 manifest.pmx 一致，供打包 payload 使用）',
  )
  console.log(`[assets] counts：${Object.entries(counts).map(([key, value]) => `${key}=${value}`).join(' ')}`)
  console.log(
    `[assets] 贴图：共 ${manifest.textures.length} 张（resized=${resizedCount}，copied=${copiedCount}），` +
      `missing=${manifest.pmx.missingTextures.length}`,
  )
  for (const entry of manifest.textures) {
    if (!entry.resized) {
      continue
    }
    console.log(
      `[assets]   resize ${entry.source}：${entry.sourceWidth}x${entry.sourceHeight} ${formatBytes(entry.sourceBytes)}` +
        ` -> ${entry.width}x${entry.height} ${formatBytes(entry.bytes)}`,
    )
  }
  console.log(
    `[assets] 未引用图片（${manifest.unreferencedFiles.length}）：${manifest.unreferencedFiles.join(', ') || '无'}`,
  )
  console.log(
    `[assets] optimized/ 产物构成：${manifest.textures.length} 张贴图 + 1 个 PMX 字节副本 = ` +
      `${optimizedFileCount} 个文件（供 electron-builder extraResources 打包）`,
  )
  console.log(
    `[assets] 贴图字节合计（去重后 ${artifacts.size} 张）：${formatBytes(totalSourceBytes)} -> ${formatBytes(totalOutputBytes)}` +
      `（${formatChangeRatio(totalSourceBytes, totalOutputBytes)}）`,
  )
  console.log(`[assets] manifest：${MANIFEST_REL}`)
}

/* ---------------------------------- 主流程 --------------------------------- */

async function main(argv) {
  const options = parseArgs(argv)
  if (options.help) {
    console.log(usage())
    return 0
  }

  console.log(`[assets] 仓库根目录：${REPO_ROOT}`)
  console.log(`[assets] max-edge=${options.maxEdge}${options.check ? '（--check：不写入任何文件）' : ''}`)

  const { file: pmxFile, absPath: pmxPath } = discoverPmx()
  const { buffer: pmxBuffer, pmx } = readPmx(pmxFile, pmxPath)
  const pmxBytes = pmxBuffer.length
  const pmxSha256 = sha256Buffer(pmxBuffer)

  const { refs, sources, resolved, missing } = validatePmx(pmx, pmxFile)
  const artifacts = await buildArtifacts(sources, resolved, options.maxEdge)
  const textures = buildTextureManifest(refs, sources, artifacts)
  const unreferencedFiles = findUnreferencedFiles(sources)

  const manifest = buildManifest({
    pmxFile,
    pmxBytes,
    pmxSha256,
    pmx,
    refs,
    missing,
    textures,
    unreferencedFiles,
    maxEdge: options.maxEdge,
  })
  const pmxArtifact = buildPmxArtifact({ pmxFile, pmxPath, pmxBytes, pmxSha256 })

  if (options.check) {
    printSummary({ manifest, artifacts, pmxArtifact, mode: '--check（只检查，未写入）' })
    return runCheck(manifest, artifacts, pmxArtifact)
  }

  ensureOptimizedDir()
  writeArtifacts(artifacts)
  writePmxCopy(pmxArtifact)
  const removed = cleanupStaleOutputs(artifacts, pmxArtifact)
  const manifestWrite = writeManifestIfChanged(manifest)

  printSummary({ manifest, artifacts, pmxArtifact, mode: 'write（生成 optimized/ + manifest）' })
  console.log(`[assets] PMX 字节副本已写入并自检：${OUTPUT_DIR_REL}/${pmxArtifact.optimized}`)
  if (removed.length > 0) {
    console.log(`[assets] 清理陈旧产物（${removed.length}）：${removed.join(', ')}`)
  } else {
    console.log('[assets] 清理陈旧产物：无')
  }
  if (manifestWrite.written) {
    console.log(`[assets] manifest 已更新（内容有变化）：${MANIFEST_REL}`)
  } else {
    console.log(
      `[assets] manifest 未变化（保留旧 generatedAt=${manifestWrite.keptGeneratedAt ?? 'n/a'}），` +
        '不重写文件',
    )
  }
  const resizedCount = textures.filter((entry) => entry.resized).length
  console.log(
    `DONE manifest=${MANIFEST_REL} manifestChanged=${manifestWrite.written} textures=${textures.length} ` +
      `resized=${resizedCount} pmxCopy=1`,
  )
  return 0
}

main(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code
  })
  .catch((error) => {
    if (error instanceof PipelineError) {
      console.error(`\n✖ ${error.message}`)
    } else {
      console.error(`\n✖ 未预期错误：${error instanceof Error ? error.stack ?? error.message : String(error)}`)
    }
    process.exitCode = 1
  })
