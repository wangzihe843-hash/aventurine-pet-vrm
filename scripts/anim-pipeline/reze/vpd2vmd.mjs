#!/usr/bin/env node
/**
 * VPD（MMD 静态姿势）→ VMD（单帧静态动作）转换器 —— 零依赖单文件实现
 *
 * 用途：把 Blender+MMD Tools 摆好导出的 `.vpd` 姿势，转成 app 的「VMD 外部动作层」
 * 可直接加载的单帧 VMD（`MMDLoader.loadVMD` 读取），作为一次性静态姿势/过渡帧使用。
 * 这样「Blender 摆姿 → VPD → app」的 VPD 工具链在运行期也闭环（不需要另写 VPD 加载器）。
 *
 * 实现要点：
 * - VPD 是 **Shift-JIS（cp932）** 文本（Blender/MMD 工具默认）；也兼容 UTF-8 手写文件。
 *   自动检测：先 UTF-8 strict 解码，失败再 Shift-JIS；可用 `--encoding` 强制。
 * - VPD 数字可能带科学计数法（`8.7e-05`）——直接 `Number()` 支持（three r171 的
 *   `parseVpd` 反而不支持，会抛 "the file seems not vpd file."）。
 * - **只转骨骼块**：VPD 里的 `Morph{}` 块不转（本 app 表情由 B3 表情系统单独驱动，
 *   外部 VMD 的 morph 名/索引与本模型不保证匹配）。
 * - VMD 是二进制：骨名/模型名用 Shift-JIS 15/20 字节。Node 只能解码不能编码 Shift-JIS，
 *   这里用「TextDecoder 反查表」生成编码表（思路与 reze-engine 的 MIT 实现一致）：
 *   枚举 1/2 字节序列 → 解码 → 反查，一次性建表后缓存。
 * - 插值沿用 MMD 标准线性 (20,20)-(107,107)；单帧姿势插值无实际影响，但写标准值保证
 *   各家读取器行为一致。
 *
 * 用法（无需 npm install）：
 *   node scripts/anim-pipeline/reze/vpd2vmd.mjs <input.vpd> [--out <output.vmd>]
 *        [--frame N] [--encoding auto|shift_jis|utf-8]
 * 退出码：0 成功；2 参数/输入错误；1 内部错误。
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, dirname, extname, join } from 'node:path'
import { pathToFileURL } from 'node:url'

const VMD_HEADER = 'Vocaloid Motion Data 0002'
const HEADER_SIZE = 30
const MODEL_NAME_SIZE = 20
const BONE_NAME_SIZE = 15
const MMD_FPS = 30

/**
 * MMD 骨骼帧标准线性插值 64 字节。
 *
 * 取自本机真实 VMD（reze-rig 产物 `motion-idle.vmd` 的骨帧）逐字节 dump，
 * 对应 (20,20)-(107,107) 的标准线性贝塞尔；单帧姿势插值无实际影响，写标准值即可。
 */
const LINEAR_INTERPOLATION = Uint8Array.from([
  20, 20, 0, 0, 20, 20, 20, 20, 107, 107, 107, 107, 107, 107, 107, 107,
  20, 20, 20, 20, 20, 20, 20, 107, 107, 107, 107, 107, 107, 107, 107, 0,
  20, 20, 20, 20, 20, 20, 107, 107, 107, 107, 107, 107, 107, 107, 0, 0,
  20, 20, 20, 20, 20, 107, 107, 107, 107, 107, 107, 107, 107, 0, 0, 0
])

function fail(code, message) {
  console.error(`[vpd2vmd] ERROR: ${message}`)
  process.exit(code)
}

function parseArgs(argv) {
  const options = {}
  const inputs = []
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]
    if (token === '-h' || token === '--help') {
      options.help = true
      continue
    }
    if (!token.startsWith('--')) {
      inputs.push(token)
      continue
    }
    const eq = token.indexOf('=')
    const name = eq >= 0 ? token.slice(0, eq) : token
    const inline = eq >= 0 ? token.slice(eq + 1) : undefined
    const value = inline !== undefined ? inline : argv[++i]
    if (value === undefined) fail(2, `参数 ${name} 缺少值`)
    switch (name) {
      case '--out':
        options.out = value
        break
      case '--frame':
        options.frame = Number(value)
        break
      case '--encoding':
        options.encoding = value
        break
      default:
        fail(2, `未知参数: ${name}`)
    }
  }
  if (options.help) return options
  if (inputs.length !== 1) {
    fail(2, '用法: node vpd2vmd.mjs <input.vpd> [--out <output.vmd>] [--frame N] [--encoding auto|shift_jis|utf-8]')
  }
  options.input = inputs[0]
  if (options.encoding !== undefined) {
    const allowed = ['auto', 'shift_jis', 'shift-jis', 'utf-8', 'utf8']
    if (!allowed.includes(String(options.encoding).toLowerCase())) {
      fail(2, `--encoding 只能是 auto/shift_jis/utf-8（收到 ${options.encoding}）`)
    }
  }
  if (options.frame !== undefined && (!Number.isInteger(options.frame) || options.frame < 0)) {
    fail(2, '--frame 必须是非负整数')
  }
  return options
}

/** 生成 Shift-JIS 编码表（字符 → 字节序列）；Node 的 TextDecoder 支持 shift_jis 反查。 */
let shiftJisEncodeTable = null
function getShiftJisEncodeTable() {
  if (shiftJisEncodeTable) return shiftJisEncodeTable
  const decoder = new TextDecoder('shift_jis')
  const table = new Map()
  for (let i = 0; i < 256; i += 1) {
    const char = decoder.decode(Uint8Array.from([i]))
    if (char !== '\ufffd' && !table.has(char)) table.set(char, Uint8Array.from([i]))
  }
  for (let hi = 0x81; hi <= 0xfc; hi += 1) {
    if (hi >= 0xa0 && hi <= 0xdf) continue
    for (let lo = 0x40; lo <= 0xfc; lo += 1) {
      if (lo === 0x7f) continue
      const char = decoder.decode(Uint8Array.from([hi, lo]))
      if (char !== '\ufffd' && !table.has(char)) table.set(char, Uint8Array.from([hi, lo]))
    }
  }
  shiftJisEncodeTable = table
  return table
}

/** UTF-8 字符串 → Shift-JIS 字节（不可编码字符替换为 '?'，与常见 MMD 工具行为一致）。 */
function encodeShiftJis(text, maxBytes) {
  const table = getShiftJisEncodeTable()
  const bytes = []
  for (const char of text) {
    const encoded = table.get(char)
    if (encoded) bytes.push(...encoded)
    else bytes.push(0x3f) // '?'
    if (maxBytes !== undefined && bytes.length >= maxBytes) break
  }
  const out = new Uint8Array(Math.min(bytes.length, maxBytes ?? bytes.length))
  out.set(bytes.slice(0, out.length))
  return out
}

/** 把 UTF-8 文本编码为 Shift-JIS 字节（测试/工具用；VPD fixture 生成、边界调试）。 */
export function encodeTextToShiftJis(text) {
  return encodeShiftJis(text)
}

/** 定长写入（不足补 0；超出截断）。area 为 DataView 之外的整体 buffer+offset。 */
function writeFixedBytes(buffer, offset, bytes, size) {
  const view = new Uint8Array(buffer, offset, size)
  view.fill(0)
  view.set(bytes.subarray(0, size))
  return offset + size
}

/** 写单帧静态 VMD。返回 Buffer。 */
function buildVmd({ parentModel, bones, frame = 0 }) {
  const boneNameBytes = bones.map((bone) => encodeShiftJis(bone.name, BONE_NAME_SIZE))
  const size =
    HEADER_SIZE +
    MODEL_NAME_SIZE +
    4 +
    bones.length * (BONE_NAME_SIZE + 4 + 12 + 16 + 64) +
    4 + // morph 帧数
    4 * 4 // camera / light / self-shadow / IK 帧数（恒写，保证 VMD 分段完整）
  const arrayBuffer = new ArrayBuffer(size)
  const view = new DataView(arrayBuffer)
  let offset = 0

  // 头部：30 字节 ASCII 定长
  offset = writeFixedBytes(arrayBuffer, offset, new TextEncoder().encode(VMD_HEADER), HEADER_SIZE)
  // 模型名：20 字节 Shift-JIS
  offset = writeFixedBytes(arrayBuffer, offset, encodeShiftJis(parentModel, MODEL_NAME_SIZE), MODEL_NAME_SIZE)
  // 骨骼帧数
  view.setUint32(offset, bones.length, true)
  offset += 4
  // 骨骼帧
  for (let index = 0; index < bones.length; index += 1) {
    const bone = bones[index]
    offset = writeFixedBytes(arrayBuffer, offset, boneNameBytes[index], BONE_NAME_SIZE)
    view.setUint32(offset, frame, true)
    offset += 4
    // 位移 xyz
    for (const value of bone.position) {
      view.setFloat32(offset, value, true)
      offset += 4
    }
    // 旋转 xyzw
    for (const value of bone.rotation) {
      view.setFloat32(offset, value, true)
      offset += 4
    }
    new Uint8Array(arrayBuffer, offset, 64).set(LINEAR_INTERPOLATION)
    offset += 64
  }
  // morph 帧数 = 0
  view.setUint32(offset, 0, true)
  offset += 4
  // camera / light / self-shadow / IK 帧数 = 0
  for (let i = 0; i < 4; i += 1) {
    view.setUint32(offset, 0, true)
    offset += 4
  }
  return Buffer.from(arrayBuffer)
}

/**
 * 解码 VPD 文本：auto = 先 UTF-8 strict，失败再 Shift-JIS（全量 ICU）。
 * 返回 { text, encoding }；失败抛错。
 */
function decodeVpd(buffer, encoding = 'auto') {
  const normalized = String(encoding).toLowerCase()
  const modes =
    normalized === 'auto'
      ? ['utf-8', 'shift_jis']
      : [normalized === 'utf-8' || normalized === 'utf8' ? 'utf-8' : 'shift_jis']
  const errors = []
  for (const mode of modes) {
    try {
      const decoder = new TextDecoder(mode, { fatal: mode === 'utf-8' })
      const text = decoder.decode(buffer)
      const cleaned = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
      if (/Vocaloid Pose Data file/i.test(cleaned.slice(0, 200))) {
        return { text: cleaned, encoding: mode }
      }
      errors.push(`${mode}: 头部不是 VPD（Vocaloid Pose Data file）`)
    } catch (error) {
      errors.push(`${mode}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  throw new Error(`无法解码 VPD（${errors.join('；')}）`)
}

/**
 * 解析 VPD 文本 → { parentModel, bones }。
 *
 * 结构：首行 "Vocaloid Pose Data file"；随后 parentModel.osm; / 骨骼总数;；
 * 然后逐块 `BoneN{...}`（忽略 `Morph{}` 块）。块内兼容两种写法：
 * ① MMD/PMXEditor 单行 CSV：`Bone0{センター,0.0,0.0,0.0,0.0,0.0,0.0,1.0}`
 * ② Blender MMD Tools 多行变体：`Bone0{センター\n 0.0,0.0,0.0; // trans\n 0,0,0,1; // quat\n}`
 */
export function parseVpdText(text) {
  const lines = text.split(/\r?\n/)
  let index = 0
  while (index < lines.length && lines[index].trim() === '') index += 1
  if (!/^\s*Vocaloid Pose Data file/i.test(lines[index] ?? '')) {
    throw new Error('不是 VPD 文件（首行应为 "Vocaloid Pose Data file"）')
  }
  index += 1
  while (index < lines.length && lines[index].trim() === '') index += 1

  const parentLine = (lines[index] ?? '').split('//')[0].trim()
  const parentModel = parentLine.replace(/;+\s*$/, '').replace(/\.osm$/i, '').trim()
  index += 1
  while (index < lines.length && lines[index].trim() === '') index += 1

  const countText = (lines[index] ?? '').split('//')[0].trim().replace(/;+\s*$/, '')
  const declaredCount = Number(countText)
  if (!Number.isInteger(declaredCount) || declaredCount < 0) {
    throw new Error(`VPD 骨骼数量行非法: ${JSON.stringify(countText)}`)
  }
  index += 1

  const body = lines.slice(index).join('\n')
  const bones = []
  const seen = new Map()
  const re = /(?:^|[\r\n])\s*(Bone\s*\d*)\s*\{([^}]*)\}/g
  let match
  while ((match = re.exec(body)) !== null) {
    // 兼容两种 VPD 变体：
    // ① MMD/PMXEditor 单行 CSV：`Bone0{センター,0.0,0.0,0.0,0.0,0.0,0.0,1.0}`
    // ② Blender MMD Tools 多行变体：Bone0{名称 换行 pos 行(; 与 // 注释) 换行 quat 行 换行 }\n
    // 统一处理：去掉 `//` 行注释 → `;` 视作分隔符 → 按逗号/空白切 token。
    const cleaned = match[2]
      .replace(/\/\/.*$/gm, ' ')
      .replace(/;/g, ',')
      .replace(/[\r\n\t]+/g, ' ')
    const tokens = cleaned
      .split(/[,\s]+/)
      .map((token) => token.trim())
      .filter((token) => token.length > 0)
    if (tokens.length < 8) {
      throw new Error(`${match[1]} 字段不足（需要 名称 + 7 个数字）: ${match[2].replace(/\s+/g, ' ').trim()}`)
    }
    const name = tokens[0]
    if (name.length === 0) throw new Error(`${match[1]} 骨骼名为空`)
    const numbers = tokens.slice(1, 8).map((part) => Number(part))
    if (numbers.some((value) => !Number.isFinite(value))) {
      throw new Error(`${match[1]}（${name}）包含非法数字: ${tokens.slice(1, 8).join(',')}`)
    }
    const [px, py, pz, rqx, rqy, rqz, rqw] = numbers
    const length = Math.hypot(rqx, rqy, rqz, rqw)
    const rotation =
      length > 1e-8
        ? [rqx / length, rqy / length, rqz / length, rqw / length]
        : [0, 0, 0, 1]
    const bone = { name, position: [px, py, pz], rotation }
    if (seen.has(name)) {
      console.warn(`[vpd2vmd] 警告：骨骼 ${name} 重复出现，保留最后一个`)
      bones[seen.get(name)] = bone
    } else {
      seen.set(name, bones.length)
      bones.push(bone)
    }
  }

  if (bones.length === 0) throw new Error('VPD 中没有解析到任何 Bone{} 块')
  if (bones.length !== declaredCount) {
    console.warn(
      `[vpd2vmd] 警告：声明 ${declaredCount} 根骨，实际解析 ${bones.length} 根（忽略 Morph 块属正常）`
    )
  }
  return { parentModel, bones }
}

export function convertVpdBuffer(buffer, options = {}) {
  const { text, encoding } = decodeVpd(buffer, options.encoding ?? 'auto')
  const parsed = parseVpdText(text)
  const frame = options.frame ?? 0
  const vmd = buildVmd({ ...parsed, frame })
  return { vmd, encoding, parentModel: parsed.parentModel, boneCount: parsed.bones.length, frame }
}

export function convertVpdFile(inputPath, outputPath, options = {}) {
  if (!existsSync(inputPath)) throw new Error(`输入文件不存在: ${inputPath}`)
  const buffer = readFileSync(inputPath)
  const result = convertVpdBuffer(buffer, options)
  writeFileSync(outputPath, result.vmd)
  return { ...result, inputPath, outputPath, bytes: result.vmd.length }
}

const isMain =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href
if (isMain) {
  try {
    const options = parseArgs(process.argv.slice(2))
    if (options.help) {
      console.log(
        '用法: node vpd2vmd.mjs <input.vpd> [--out <output.vmd>] [--frame N] [--encoding auto|shift_jis|utf-8]'
      )
      process.exit(0)
    }
    const out = options.out ?? join(dirname(options.input), `${basename(options.input, extname(options.input))}.vmd`)
    const result = convertVpdFile(options.input, out, options)
    console.log(
      `[vpd2vmd] OK ${result.inputPath} → ${result.outputPath}（encoding=${result.encoding}, ` +
        `bones=${result.boneCount}, frame=${result.frame}, ${result.bytes} bytes, ${MMD_FPS}fps）`
    )
  } catch (error) {
    fail(2, error instanceof Error ? error.message : String(error))
  }
}
