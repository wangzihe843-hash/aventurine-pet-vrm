#!/usr/bin/env node
/**
 * Verify that a .vpd exported by Blender + MMD Tools can be consumed by the
 * three.js r171 MMD pipeline used by this project (three@0.171.0).
 *
 * It does three things, all with the *actual* three.js r171 code, not a re-implementation:
 *   1. Decodes the VPD the way MMDLoader.loadVPD does (Shift-JIS when isUnicode=false)
 *      and feeds it to three's bundled MMDParser.parseVpd(text, true).
 *   2. Cross-checks every VPD bone name against the PMX bone table parsed by the same
 *      MMDParser (helper.pose silently skips unknown names, so this is the real risk).
 *   3. Simulates MMDLoader's PMX skeleton construction (relative bone positions, identity
 *      rest rotation) + MMDAnimationHelper.pose() (`bone.position.add(vpd.translation)`,
 *      `bone.quaternion.multiply(vpd.quaternion)`, ik/grant disabled) and compares the
 *      resulting world-space bone heads with the ones Blender produced. If they agree,
 *      the exported VPD really does reproduce the authored pose in three.js.
 *
 * Usage:
 *   node scripts/anim-pipeline/blender/verify_vpd.mjs \
 *     --pmx "assets/model/optimized/星穹铁道—砂金·戏浪.pmx" \
 *     --vpd tests/tmp/blender-probe/pose-test.vpd \
 *     --vpd-boneonly tests/tmp/blender-probe/pose-test-boneonly.vpd \
 *     --dump tests/tmp/blender-probe/pose-dump.json \
 *     --out tests/tmp/blender-probe/vpd-compat-check.json
 *
 * Exit code 0 = all required checks passed.
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(HERE, '../../..')

function parseArgs(argv) {
  const args = {}
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i]
    if (!key.startsWith('--')) continue
    args[key.slice(2)] = argv[i + 1]
  }
  return args
}

function loadThreeModule() {
  // The repo pins three@0.171.0; import its own copies so we test the shipped code.
  const mmdParserPath = resolve(REPO_ROOT, 'node_modules/three/examples/jsm/libs/mmdparser.module.js')
  const threePath = resolve(REPO_ROOT, 'node_modules/three/build/three.module.js')
  return Promise.all([import(pathToFileURL(mmdParserPath).href), import(pathToFileURL(threePath).href)]).then(
    ([mmd, three]) => ({ MMDParser: mmd.MMDParser, three })
  )
}

function decodeVpd(buffer, mode) {
  const errors = []
  for (const encoding of mode === 'utf8' ? ['utf-8'] : ['shift_jis', 'utf-8']) {
    try {
      return { text: new TextDecoder(encoding, { fatal: true }).decode(buffer), encoding, errors }
    } catch (error) {
      errors.push(`${encoding}: ${error.message}`)
    }
  }
  return { text: new TextDecoder('shift_jis').decode(buffer), encoding: 'shift_jis(replace)', errors }
}

/** three r171's parseVpd regexes only accept plain decimal floats; "1e-05" breaks them. */
function countExponentNumbers(vpdText) {
  return (vpdText.match(/(?<![\d.])-?\d+(?:\.\d+)?e[+-]?\d+/gi) ?? []).length
}

function testExponentPitfall(parser, vpdText) {
  const synthetic = vpdText.replace(/(^\s*)(-?\d+\.\d+)(,)/m, '$1 1e-05$3')
  if (synthetic === vpdText) return { injected: false }
  try {
    parser.parseVpd(synthetic, true)
    return { injected: true, parseOk: true, note: 'scientific notation parsed (unexpected)' }
  } catch (error) {
    return {
      injected: true,
      parseOk: false,
      parseError: String(error),
      note: 'scientific notation in a bone vector/quaternion breaks three r171 parseVpd'
    }
  }
}

function restLocalPositions(data) {
  return data.bones.map((bone, index) => {
    const pos = bone.position.slice(0, 3)
    if (bone.parentIndex >= 0) {
      const parent = data.bones[bone.parentIndex].position
      return [pos[0] - parent[0], pos[1] - parent[1], pos[2] - parent[2]]
    }
    return pos
  })
}

/** Simulate MMDAnimationHelper.pose() on the PMX skeleton and return world head positions. */
function simulatePose(data, vpd, three) {
  const { Vector3, Quaternion, Matrix4 } = three
  const count = data.metadata.boneCount
  const local = restLocalPositions(data)
  const positions = local.map((p) => new Vector3(p[0], p[1], p[2]))
  const quaternions = data.bones.map(() => new Quaternion())
  const applied = []
  const missingInPmx = []

  const nameToIndex = new Map()
  data.bones.forEach((bone, index) => nameToIndex.set(bone.name, index))

  for (const bone of vpd.bones) {
    const index = nameToIndex.get(bone.name)
    if (index === undefined) {
      missingInPmx.push(bone.name)
      continue
    }
    // exactly what MMDAnimationHelper.pose() does:
    positions[index].add(new Vector3(bone.translation[0], bone.translation[1], bone.translation[2]))
    quaternions[index].multiply(
      new Quaternion(bone.quaternion[0], bone.quaternion[1], bone.quaternion[2], bone.quaternion[3])
    )
    applied.push(bone.name)
  }

  const localMatrices = data.bones.map((_, i) =>
    new Matrix4().compose(positions[i], quaternions[i], new Vector3(1, 1, 1))
  )
  const world = new Array(count)
  const worldOf = (index) => {
    if (world[index]) return world[index]
    const parent = data.bones[index].parentIndex
    const matrix = localMatrices[index].clone()
    if (parent >= 0) matrix.premultiply(worldOf(parent))
    world[index] = matrix
    return world[index]
  }
  const heads = new Map()
  for (let i = 0; i < count; i += 1) {
    const m = worldOf(i)
    heads.set(data.bones[i].name, [m.elements[12], m.elements[13], m.elements[14]])
  }
  return { heads, applied, missingInPmx, positionOf: (name) => heads.get(name) ?? null }
}

function main() {
  const args = parseArgs(process.argv.slice(2))
  for (const key of ['pmx', 'vpd', 'dump', 'out']) {
    if (!args[key]) {
      console.error(`missing --${key}`)
      process.exit(2)
    }
  }
  const pmxPath = resolve(args.pmx)
  const vpdPath = resolve(args.vpd)
  const dumpPath = resolve(args.dump)
  const report = { tool: 'verify_vpd.mjs', three_version: null, checks: {}, pass: false }

  const pmxBuffer = readFileSync(pmxPath)
  const dump = JSON.parse(readFileSync(dumpPath, 'utf-8'))
  const importScale = dump.import_scale ?? 0.08

  loadThreeModule().then(({ MMDParser, three }) => {
    report.three_version = '0.171.0 (node_modules/three)'
    const parser = new MMDParser.Parser()
    const pmxArrayBuffer = pmxBuffer.buffer.slice(pmxBuffer.byteOffset, pmxBuffer.byteOffset + pmxBuffer.byteLength)
    const model = parser.parsePmx(pmxArrayBuffer, true)
    report.checks.pmx = {
      format: model.metadata.format,
      boneCount: model.metadata.boneCount,
      vertexCount: model.metadata.vertexCount,
      morphCount: model.metadata.morphCount,
      coordinateSystem: model.metadata.coordinateSystem
    }
    const pmxBoneNames = new Set(model.bones.map((b) => b.name))

    // ---------- 1+2: decode & parse the raw VPD exactly like MMDLoader.loadVPD ----------
    const rawBuffer = readFileSync(vpdPath)
    const decoded = decodeVpd(rawBuffer, 'auto')
    report.checks.encoding = {
      detected: decoded.encoding,
      fallbackErrors: decoded.errors,
      note: 'MMDLoader.loadVPD(url, false) requests charset=shift_jis; MMD Tools writes cp932 (=Shift-JIS superset)'
    }
    let parsed = null
    let parseError = null
    try {
      parsed = parser.parseVpd(decoded.text, true)
    } catch (error) {
      parseError = String(error)
    }
    const exponentPitfall = testExponentPitfall(parser, decoded.text)
    report.checks.rawVpd = {
      path: vpdPath,
      bytes: rawBuffer.length,
      hasMorphBlocks: /^Morph\d+\{/m.test(decoded.text),
      exponentFormattedNumbers: countExponentNumbers(decoded.text),
      exponentPitfall,
      parseOk: parsed !== null,
      parseError,
      boneCountField: parsed?.metadata?.boneCount ?? null,
      parsedBoneCount: parsed?.bones?.length ?? null,
      coordinateSystem: parsed?.metadata?.coordinateSystem ?? null,
      parentFile: parsed?.metadata?.parentFile ?? null
    }

    // ---------- bone-only variant (the file recommended for loadVPD) ----------
    let boneOnly = null
    let usableParsed = parsed
    let usableSource = 'raw'
    if (args['vpd-boneonly']) {
      const boneOnlyPath = resolve(args['vpd-boneonly'])
      const boBuffer = readFileSync(boneOnlyPath)
      const boDecoded = decodeVpd(boBuffer, 'auto')
      let boParsed = null
      let boError = null
      try {
        boParsed = parser.parseVpd(boDecoded.text, true)
      } catch (error) {
        boError = String(error)
      }
      boneOnly = {
        path: boneOnlyPath,
        bytes: boBuffer.length,
        hasMorphBlocks: /^Morph\d+\{/m.test(boDecoded.text),
        exponentFormattedNumbers: countExponentNumbers(boDecoded.text),
        exponentPitfall: testExponentPitfall(parser, boDecoded.text),
        parseOk: boParsed !== null,
        parseError: boError,
        boneCountField: boParsed?.metadata?.boneCount ?? null,
        parsedBoneCount: boParsed?.bones?.length ?? null,
        coordinateSystem: boParsed?.metadata?.coordinateSystem ?? null,
        parentFile: boParsed?.metadata?.parentFile ?? null
      }
      if (boParsed) {
        usableParsed = boParsed
        usableSource = 'boneonly'
        const boSim = simulatePose(model, boParsed, three)
        boneOnly.applied = boSim.applied.length
        boneOnly.missingInPmx = boSim.missingInPmx
      }
    }
    report.checks.boneOnlyVpd = boneOnly
    report.checks.sourceOfTruth = usableSource

    // ---------- bone-name coverage (helper.pose silently skips unknown names) ----------
    let names = null
    if (usableParsed) {
      const vpdNames = usableParsed.bones.map((b) => b.name)
      const unknown = vpdNames.filter((n) => !pmxBoneNames.has(n))
      names = {
        source: usableSource,
        vpdBones: vpdNames.length,
        pmxBones: pmxBoneNames.size,
        unknownNames: unknown,
        allKnown: unknown.length === 0
      }
    }
    report.checks.boneNames = names

    // ---------- 3: semantic cross-check against Blender's own pose ----------
    const changedBones = Object.keys(dump.bones ?? {})
    let semantic = { compared: 0, skipped: [], maxErrorMeters: null, pass: false, source: usableSource }
    if (usableParsed) {
      const sim = simulatePose(model, usableParsed, three)
      const errors = []
      const restErrors = []
      for (const boneName of changedBones) {
        const blender = dump.bones[boneName]
        // Blender imports MMD coords as (x, z, y)*scale; three's leftToRight gives (x, y, -z).
        // So expected three position = (bx, bz, -by) / importScale.
        const b = blender.head_world
        const expected = [b[0] / importScale, b[2] / importScale, -b[1] / importScale]
        const actual = sim.positionOf(boneName)
        if (!actual) {
          semantic.skipped.push(boneName)
          continue
        }
        const diff = Math.hypot(actual[0] - expected[0], actual[1] - expected[1], actual[2] - expected[2])
        errors.push({ bone: boneName, diffMmdUnits: diff, diffMeters: diff * importScale, expected, actual })
        // rest-pose sanity: rest_matrix_local translation -> three coords (validates the mapping)
        const rest = blender.rest_matrix_local
        const bt = [rest[0][3], rest[1][3], rest[2][3]]
        const restExpected = [bt[0] / importScale, bt[2] / importScale, -bt[1] / importScale]
        const pmxBone = model.bones.find((x) => x.name === boneName)
        if (pmxBone) {
          const rdiff = Math.hypot(
            pmxBone.position[0] - restExpected[0],
            pmxBone.position[1] - restExpected[1],
            pmxBone.position[2] - restExpected[2]
          )
          restErrors.push({ bone: boneName, diffMmdUnits: rdiff, restActual: pmxBone.position, restExpected })
        }
      }
      const maxError = errors.length ? Math.max(...errors.map((e) => e.diffMeters)) : null
      semantic = {
        source: usableSource,
        compared: errors.length,
        skipped: semantic.skipped,
        maxErrorMeters: maxError,
        toleranceMeters: 1e-4,
        pass: errors.length > 0 && maxError !== null && maxError < 1e-4 && semantic.skipped.length === 0,
        details: errors,
        restPositionCheck: {
          compared: restErrors.length,
          maxErrorMmdUnits: restErrors.length ? Math.max(...restErrors.map((e) => e.diffMmdUnits)) : null
        }
      }
    }
    report.checks.semanticReplay = semantic

    report.conclusion = {
      loadVpdCompatible: usableParsed !== null,
      sourceOfTruth: usableSource,
      rawVpdParseOk: report.checks.rawVpd.parseOk,
      rawVpdHasMorphBlocks: report.checks.rawVpd.hasMorphBlocks,
      morphBlocksBreakThreeParser: report.checks.rawVpd.hasMorphBlocks && !report.checks.rawVpd.parseOk,
      boneNamesAllKnown: report.checks.boneNames?.allKnown ?? false,
      semanticReplayPass: report.checks.semanticReplay?.pass ?? false,
      recommendedCall: 'MMDLoader.loadVPD(url, false, onLoad) then helper.pose(mesh, vpd, { ik: false, grant: false }) for exact authored pose (defaults run CCD IK + grant)',
      threeCompatibility: 'three@0.171.0 MMDParser.parseVpd(text, true) + MMDAnimationHelper.pose()'
    }
    report.pass =
      usableParsed !== null &&
      (report.checks.boneNames?.allKnown ?? false) &&
      (report.checks.semanticReplay?.pass ?? false)

    writeFileSync(resolve(args.out), JSON.stringify(report, null, 2))
    console.log(JSON.stringify({ pass: report.pass, conclusion: report.conclusion, checks: {
      encoding: report.checks.encoding.detected,
      rawVpd: report.checks.rawVpd,
      boneOnlyVpd: report.checks.boneOnlyVpd,
      boneNames: report.checks.boneNames,
      semanticReplay: report.checks.semanticReplay && {
        compared: report.checks.semanticReplay.compared,
        maxErrorMeters: report.checks.semanticReplay.maxErrorMeters,
        pass: report.checks.semanticReplay.pass
      }
    } }, null, 2))
    process.exit(report.pass ? 0 : 1)
  }).catch((error) => {
    report.error = String(error?.stack ?? error)
    writeFileSync(resolve(args.out), JSON.stringify(report, null, 2))
    console.error(report.error)
    process.exit(1)
  })
}

main()
