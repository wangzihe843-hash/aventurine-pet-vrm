#!/usr/bin/env node
/**
 * Wave 1.5 资产修复 CLI：修复 VRM 腿部 humanoid 映射（控制骨 → MMD 形变骨 *D/*先EX）
 * + 把腿根从 spine 下重挂到 hips 下（保持世界 rest 变换不变）。
 *
 * 背景与算法见纯函数库 `scripts/vrm/lib/humanoid-leg-fix.mjs` 文件头。
 * 目标问题（2026-11-08 对拍实测）：
 *   - 戏浪 VRM 的 humanoid 腿骨映射到控制骨（左足/左ひざ/左足首），但网格权重在形变骨
 *     （左足D/左ひざD/左足首D/左足先EX；裤腿等也挂在 D 链下）→ three-vrm/Unity 播动画时腿不动；
 *   - 腿链父链经过 spine（腰），不符合 VRM humanoid 规范 → spine 旋转泄漏到腿（sit/sleep 24–31°）。
 *
 * 用法：
 *   node scripts/vrm/fix-vrm-humanoid-legs.mjs -i <input.vrm> -o <output.vrm> [选项]
 *
 * 选项：
 *   -i, --in <path>          输入 VRM（VRM 1.0 GLB；私有资产）
 *   -o, --out <path>         输出 VRM（不动输入文件）
 *   --no-reparent            只修 humanoid 映射，不做腿根重挂（调试/保守模式）
 *   --report <path>          报告 JSON 输出（默认 tests/tmp/wave15/vrm-leg-fix-report.json）
 *   --check                  只分析/打印计划，不写文件
 *   -h, --help               显示帮助
 *
 * 退出码：0 = 成功；1 = 失败（输入非法/自校验失败）；2 = 参数错误。
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { buildParents, fixHumanoidLegs, readLegMapping } from './lib/humanoid-leg-fix.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const DEFAULT_REPORT = path.join(ROOT, 'tests/tmp/wave15/vrm-leg-fix-report.json')
const GLB_MAGIC = 'glTF'
const GLB_CHUNK_JSON = 0x4e4f534a
const GLB_CHUNK_BIN = 0x004e4942

function printHelp() {
  const text = readFileSync(fileURLToPath(import.meta.url), 'utf8')
  const start = text.indexOf('/**')
  const end = text.indexOf('*/')
  console.log(start >= 0 && end > start ? text.slice(start, end + 2) : 'fix-vrm-humanoid-legs.mjs')
}

function fail(message, code = 1) {
  console.error(`[vrm-leg-fix] ERROR: ${message}`)
  process.exit(code)
}

function parseArgs(argv) {
  const options = { reparent: true, check: false, report: DEFAULT_REPORT }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    const takeValue = (name) => {
      const value = argv[i + 1]
      if (value === undefined || value.startsWith('-')) fail(`参数 ${name} 缺少取值`, 2)
      i += 1
      return value
    }
    switch (arg) {
      case '-h':
      case '--help':
        options.help = true
        break
      case '-i':
      case '--in':
        options.input = takeValue(arg)
        break
      case '-o':
      case '--out':
        options.output = takeValue(arg)
        break
      case '--report':
        options.report = takeValue(arg)
        break
      case '--no-reparent':
        options.reparent = false
        break
      case '--check':
        options.check = true
        break
      default:
        fail(`未知参数：${arg}`, 2)
    }
  }
  return options
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

/** 解析 GLB → { json, jsonBytes, binBytes }（只支持单 JSON + 单 BIN chunk）。 */
function parseGlb(bytes, label) {
  if (bytes.length < 20 || bytes.toString('latin1', 0, 4) !== GLB_MAGIC) {
    fail(`${label}: 不是 GLB（magic 非 glTF）`)
  }
  const version = bytes.readUInt32LE(4)
  if (version !== 2) fail(`${label}: 只支持 GLB v2（实际 v${version}）`)
  const totalLength = bytes.readUInt32LE(8)
  if (totalLength !== bytes.length) fail(`${label}: GLB 长度字段与文件大小不一致`)
  const jsonLength = bytes.readUInt32LE(12)
  const jsonType = bytes.readUInt32LE(16)
  if (jsonType !== GLB_CHUNK_JSON) fail(`${label}: 第一个 chunk 不是 JSON`)
  const jsonBytes = bytes.subarray(20, 20 + jsonLength)
  let json
  try {
    json = JSON.parse(jsonBytes.toString('utf8'))
  } catch (error) {
    fail(`${label}: JSON chunk 解析失败：${error instanceof Error ? error.message : String(error)}`)
  }
  const binOffset = 20 + jsonLength
  let binBytes = Buffer.alloc(0)
  if (binOffset + 8 <= bytes.length) {
    const binLength = bytes.readUInt32LE(binOffset)
    const binType = bytes.readUInt32LE(binOffset + 4)
    if (binType === GLB_CHUNK_BIN && binOffset + 8 + binLength <= bytes.length) {
      binBytes = bytes.subarray(binOffset + 8, binOffset + 8 + binLength)
    }
  }
  return { json, jsonBytes, binBytes }
}

/** 序列化 GLB（JSON 补空格对齐 4 字节；BIN chunk 原样复用）。 */
function writeGlb(json, binBytes) {
  let jsonText = JSON.stringify(json)
  while (Buffer.byteLength(jsonText) % 4 !== 0) jsonText += ' '
  const jsonBytes = Buffer.from(jsonText, 'utf8')
  const alignedBin = binBytes.length % 4 === 0 ? binBytes : Buffer.concat([binBytes, Buffer.alloc(4 - (binBytes.length % 4))])
  const total = 12 + 8 + jsonBytes.length + (alignedBin.length > 0 ? 8 + alignedBin.length : 0)
  const out = Buffer.alloc(total)
  out.write(GLB_MAGIC, 0, 'latin1')
  out.writeUInt32LE(2, 4)
  out.writeUInt32LE(total, 8)
  out.writeUInt32LE(jsonBytes.length, 12)
  out.writeUInt32LE(GLB_CHUNK_JSON, 16)
  jsonBytes.copy(out, 20)
  if (alignedBin.length > 0) {
    const binOffset = 20 + jsonBytes.length
    out.writeUInt32LE(alignedBin.length, binOffset)
    out.writeUInt32LE(GLB_CHUNK_BIN, binOffset + 4)
    alignedBin.copy(out, binOffset + 8)
  }
  return out
}

/** 自校验：解析输出，确认 humanoid 腿骨指向 *D/先EX、最近 humanoid 祖先为 hips、rest world delta 可忽略。 */
function validateFixed(gltf, reparentReport) {
  const problems = []
  const state = readLegMapping(gltf)
  if (!state) return ['输出缺少 VRMC_vrm.humanoid 腿骨映射']
  const humanBones = gltf.extensions.VRMC_vrm.humanoid.humanBones
  const nodes = gltf.nodes || []
  const parents = buildParents(nodes)
  const hipsNode = humanBones.hips?.node
  for (const side of ['left', 'right']) {
    for (const bone of [`${side}UpperLeg`, `${side}LowerLeg`, `${side}Foot`]) {
      const nodeIndex = humanBones[bone]?.node
      const name = typeof nodeIndex === 'number' ? nodes[nodeIndex]?.name : undefined
      if (typeof name !== 'string' || !/D$/.test(name)) problems.push(`${bone} 未指向形变骨（当前 ${String(name)}）`)
    }
    const toesNode = humanBones[`${side}Toes`]?.node
    if (typeof toesNode === 'number') {
      const toesName = nodes[toesNode]?.name
      if (typeof toesName !== 'string' || !/先EX$/.test(toesName)) {
        problems.push(`${side}Toes 未指向足先EX（当前 ${String(toesName)}）`)
      }
    }
    // 最近 humanoid 祖先必须是 hips
    let cursor = parents[humanBones[`${side}UpperLeg`]?.node]
    while (cursor >= 0 && cursor !== hipsNode) {
      const isHumanoid = Object.values(humanBones).some((entry) => entry?.node === cursor)
      if (isHumanoid) {
        problems.push(`${side}UpperLeg 最近 humanoid 祖先仍是 ${nodes[cursor]?.name}（应为 hips）`)
        break
      }
      cursor = parents[cursor]
    }
    if (cursor !== hipsNode) problems.push(`${side}UpperLeg 腿链未连到 hips`)
  }
  for (const change of reparentReport?.changes || []) {
    if (!(change.restWorldDelta < 1e-3)) {
      problems.push(`重挂 ${change.nodeName} 的世界 rest 位移 ${change.restWorldDelta} 超阈值`)
    }
  }
  return problems
}

function main() {
  const options = parseArgs(process.argv.slice(2))
  if (options.help) {
    printHelp()
    process.exit(0)
  }
  if (!options.input || !options.output) fail('必须指定 -i <input.vrm> 和 -o <output.vrm>', 2)
  const inputPath = path.resolve(options.input)
  const outputPath = path.resolve(options.output)
  if (!existsSync(inputPath)) fail(`输入不存在：inputPath=${inputPath}`)
  if (path.resolve(inputPath) === path.resolve(outputPath)) fail('输出不能覆盖输入（请另存副本）')

  const inputBytes = readFileSync(inputPath)
  const { json, binBytes } = parseGlb(inputBytes, 'input')
  if (!json?.extensions?.VRMC_vrm) fail('输入不是 VRM 1.0（缺少 VRMC_vrm 扩展）；VRM0 修复暂未支持')

  const before = readLegMapping(json)
  if (!before) fail('humanoid 缺腿骨映射，无法修复')

  let result
  try {
    result = fixHumanoidLegs(json, { reparent: options.reparent })
  } catch (error) {
    fail(`修复算法失败：${error instanceof Error ? error.message : String(error)}`)
  }

  const problems = validateFixed(json, result.reparent)
  const report = {
    generatedAt: new Date().toISOString(),
    input: { path: inputPath, sha256: sha256(inputBytes), bytes: inputBytes.length },
    output: { path: outputPath, bytes: 0, sha256: null },
    binChunkPreserved: true,
    remap: result.remap,
    reparent: result.reparent,
    validationProblems: problems
  }

  console.log(`[vrm-leg-fix] 输入：${path.relative(ROOT, inputPath)} (${(inputBytes.length / 1024 / 1024).toFixed(2)}MB)`)
  console.log(`[vrm-leg-fix] remap 腿骨映射：${result.remap.changes.length} 处`)
  for (const change of result.remap.changes) {
    console.log(`  ${change.bone}: ${change.fromName}(${change.fromNode}) → ${change.toName}(${change.toNode})`)
  }
  console.log(
    `[vrm-leg-fix] 腿根重挂：${result.reparent.changes.length} 处` +
      (result.reparent.skipped?.length ? `（跳过 ${result.reparent.skipped.length}）` : '')
  )
  for (const change of result.reparent.changes) {
    console.log(
      `  ${change.nodeName}(${change.node}): ${change.fromParentName} → ${change.toParentName}` +
        `，rest 世界位移 ${change.restWorldDelta.toExponential(2)}m`
    )
  }
  for (const problem of problems) console.error(`[vrm-leg-fix] 校验问题：${problem}`)

  if (options.check) {
    console.log('[vrm-leg-fix] --check：只分析未写文件。')
    writeReport(options.report, report)
    process.exit(problems.length > 0 ? 1 : 0)
  }
  if (problems.length > 0) fail(`自校验失败（${problems.length} 项），未写输出文件`)

  const outputBytes = writeGlb(json, binBytes)
  mkdirSync(path.dirname(outputPath), { recursive: true })
  writeFileSync(outputPath, outputBytes)
  report.output.bytes = outputBytes.length
  report.output.sha256 = sha256(outputBytes)

  // 回读校验（确保写出的文件可解析且修复生效）
  const reread = parseGlb(readFileSync(outputPath), 'output')
  const rereadProblems = validateFixed(reread.json, result.reparent)
  if (rereadProblems.length > 0) fail(`回读校验失败：${rereadProblems.join('；')}`)
  const binPreserved =
    reread.binBytes.length === binBytes.length && sha256(reread.binBytes) === sha256(binBytes)
  report.binChunkPreserved = binPreserved
  if (!binPreserved) fail('回读 BIN chunk 与输入不一致（不应改动几何数据）')

  writeReport(options.report, report)
  console.log(`[vrm-leg-fix] 写出：${path.relative(ROOT, outputPath)} (${(outputBytes.length / 1024 / 1024).toFixed(2)}MB)`)
  console.log('[vrm-leg-fix] 自校验通过：腿骨→形变骨、腿根→hips、世界 rest 不变、BIN chunk 未改动。')
}

function writeReport(reportPath, report) {
  if (!reportPath) return
  mkdirSync(path.dirname(path.resolve(reportPath)), { recursive: true })
  writeFileSync(path.resolve(reportPath), JSON.stringify(report, null, 2) + '\n')
  console.log(`[vrm-leg-fix] 报告：${path.relative(ROOT, path.resolve(reportPath))}`)
}

main()
