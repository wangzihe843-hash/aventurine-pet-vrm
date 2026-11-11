'use strict'

/**
 * main 侧（Node）的 PMX / VMD / VPD 元数据 + 兼容性检查器。
 *
 * 复用仓库 devDependency `mmd-parser@1.1.4`（与 three r171 MMDLoader 内 vendored
 * mmdparser.module.js 同源、同 leftToRight 转换），因此这里得到的骨名/坐标语义
 * 与渲染端 MMDLoader 完全一致，但可以独立于渲染器先做「静态体检」：
 *   - PMX：骨名清单 / IK 骨 / grant 骨 / 重名骨 / morph 清单
 *   - VMD：帧率、帧范围/时长、骨骼轨道名（交集/缺失）、センター位移范围、morph、
 *          相机/灯光帧、以及 **VMD 末尾 IK on/off 段**（r171 helper 不消费，但必须报告）
 *   - VPD：编码探测（UTF-8 / Shift-JIS）、骨名清单、与模型骨交集
 *
 * VMD 二进制结构（v2，little-endian）：
 *   header 30B "Vocaloid Motion Data 0002" + modelName 20B
 *   uint32 motionCount + N×111B  (boneName 15B SJIS + frame u32 + pos 3f + quat 4f + interpolation 64B)
 *   uint32 morphCount + N×23B   (morphName 15B SJIS + frame u32 + weight f32)
 *   uint32 cameraCount + N×61B
 *   uint32 lightCount + N×28B
 *   uint32 selfShadowCount + N×9B
 *   uint32 ikCount + N×(frame u32 + show u8 + count u8 + count×20B SJIS names)
 */

const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const { Parser } = require('mmd-parser')

const MMD_FPS = 30
const shiftJisDecoder = new TextDecoder('shift_jis')
const utf8FatalDecoder = new TextDecoder('utf-8', { fatal: true })

const MODEL_UNIT_TO_PET_PX_540 = 540 / 21.681 // PLAN/anim-tech-survey §1.2：540px 宠物 1 单位 ≈ 24.9px

/**
 * MMD 标准人形骨架（决定「动作本体能不能直接用」的那批骨）。
 * 缺失列表里真正致命的只有这些；发型/裙摆/饰品等非标准骨缺失只会让对应部位静止。
 */
/**
 * 「动作本体」必需的 17 根人形骨——全身体动作的躯干/四肢必含这批；
 * 它们全有轨道即代表动作本体可以完整套用（其余标准骨多为习惯性不动的控制骨）。
 */
const REQUIRED_HUMANOID_BONES = [
  'センター', '上半身', '首', '頭', '下半身',
  '右腕', '左腕', '右ひじ', '左ひじ', '右手首', '左手首',
  '右足', '左足', '右ひざ', '左ひざ', '右足首', '左足首',
]

const STANDARD_HUMANOID_BONES = [
  '全ての親', 'センター', 'グルーブ', '腰',
  '上半身', '上半身2', '首', '頭',
  '右肩', '左肩', '右腕', '左腕', '右ひじ', '左ひじ', '右手首', '左手首',
  '下半身', '右足', '左足', '右ひざ', '左ひざ', '右足首', '左足首',
  '右つま先', '左つま先',
  '右足ＩＫ', '左足ＩＫ', '右つま先ＩＫ', '左つま先ＩＫ',
  '右足IK親', '左足IK親', '右目', '左目', '両目',
]

/* --------------------------------------------------------------------- 工具 */

function toArrayBuffer(buffer) {
  return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength)
}

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex')
}

function decodeSjisFixed(bytes) {
  return shiftJisDecoder
    .decode(bytes)
    .replace(/\0[\s\S]*$/, '')
    .trim()
}

function statFile(filePath) {
  const stat = fs.statSync(filePath)
  return { bytes: stat.size, mtimeMs: stat.mtimeMs }
}

function round(value, digits = 4) {
  const factor = 10 ** digits
  return Math.round(value * factor) / factor
}

/* ----------------------------------------------------------------------- PMX */

function inspectPmx(pmxPath) {
  const buffer = fs.readFileSync(pmxPath)
  const parser = new Parser()
  const pmx = parser.parsePmx(toArrayBuffer(buffer), true)

  const bones = pmx.bones || []
  const morphs = pmx.morphs || []
  const boneNames = bones.map((bone) => bone.name)
  const counts = {}
  for (const name of boneNames) counts[name] = (counts[name] || 0) + 1
  const duplicateBoneNames = Object.entries(counts)
    .filter(([, count]) => count > 1)
    .map(([name, count]) => ({ name, count }))

  const ikBones = bones
    .filter((bone) => bone.ik)
    .map((bone) => ({
      name: bone.name,
      effector: bones[bone.ik.effector] ? bones[bone.ik.effector].name : null,
      iteration: bone.ik.iteration,
      maxAngle: round(threeToDeg(bone.ik.maxAngle), 2),
      links: bone.ik.links.map((link) => ({
        name: bones[link.index] ? bones[link.index].name : null,
        angleLimitation: Boolean(link.angleLimitation),
      })),
    }))

  const grantBones = bones.filter((bone) => bone.grant).map((bone) => ({
    name: bone.name,
    parent: bones[bone.grant.parentIndex] ? bones[bone.grant.parentIndex].name : null,
    ratio: round(bone.grant.ratio, 4),
    affectRotation: Boolean(bone.grant.affectRotation),
    affectPosition: Boolean(bone.grant.affectPosition),
  }))

  const metadata = pmx.metadata || {}
  return {
    type: 'pmx',
    file: path.basename(pmxPath),
    path: pmxPath,
    bytes: buffer.length,
    sha256: sha256(buffer),
    metadata: {
      format: metadata.format,
      version: metadata.version,
      modelName: metadata.modelName,
      coordinateSystem: metadata.coordinateSystem,
      encoding: metadata.encoding,
    },
    counts: {
      vertices: metadata.vertexCount,
      faces: metadata.faceCount,
      materials: metadata.materialCount,
      bones: metadata.boneCount,
      morphs: metadata.morphCount,
      rigidBodies: metadata.rigidBodyCount,
      constraints: metadata.constraintCount,
      textures: Array.isArray(pmx.textures) ? pmx.textures.length : null,
    },
    boneNames,
    boneCount: bones.length,
    duplicateBoneNames,
    morphNames: morphs.map((morph) => morph.name),
    morphCount: morphs.length,
    ikBones,
    grantBones,
    grantCount: grantBones.length,
    textureRefs: Array.isArray(pmx.textures) ? pmx.textures.slice() : [],
  }
}

function threeToDeg(value) {
  // PMX IK maxAngle 单位是弧度（MMD 中实际以弧度存储）；转成度仅用于展示。
  return (Number(value) || 0) * (180 / Math.PI)
}

/* ----------------------------------------------------------------------- VMD */

/**
 * 解析 VMD 末尾的 light / selfShadow / IK on-off 段（mmd-parser 在 camera 段后就停了）。
 * 返回 null 表示文件在 camera 段后没有更多数据（老工具导出的精简 VMD 很常见）。
 */
/**
 * 在若干候选布局中识别 VMD IK on/off 段：
 *   A. [show u8][count u8] + count×20B 名（规范常见写法）
 *   B. [show u8][count u32] + count×21B 名（reze-rig 实测变体）
 *   C. [show u8][count u32] + count×20B 名
 *   D. [show u8][count u8] + count×21B 名
 * 打分：骨名全部可解码且非空（+5）、恰好消费到文件尾（+3）、帧号递增（+1）。
 */
function detectIkLayout(dv, arrayBuffer, offset, ikCount) {
  const byteLength = arrayBuffer.byteLength
  const candidates = [
    { tag: 'u8+stride20', countSize: 1, stride: 20 },
    { tag: 'u32+stride21', countSize: 4, stride: 21 },
    { tag: 'u32+stride20', countSize: 4, stride: 20 },
    { tag: 'u8+stride21', countSize: 1, stride: 21 },
  ]
  let best = null
  for (const candidate of candidates) {
    let pos = offset
    const records = []
    let ok = true
    let lastFrame = -1
    let nonDecreasing = true
    let namedCount = 0
    for (let i = 0; i < ikCount; i++) {
      if (pos + 5 + candidate.countSize > byteLength) {
        ok = false
        break
      }
      const frame = dv.getUint32(pos, true)
      pos += 4
      const show = dv.getUint8(pos)
      pos += 1
      let count
      if (candidate.countSize === 1) {
        count = dv.getUint8(pos)
        pos += 1
      } else {
        if (pos + 4 > byteLength) {
          ok = false
          break
        }
        count = dv.getUint32(pos, true)
        pos += 4
      }
      if (count > 64 || pos + count * candidate.stride > byteLength) {
        ok = false
        break
      }
      const bones = []
      let recordNamed = 0
      for (let j = 0; j < count; j++) {
        const name = decodeSjisFixed(new Uint8Array(arrayBuffer, pos, candidate.stride))
        pos += candidate.stride
        bones.push(name)
        const valid = name.length > 0 && !name.includes('\uFFFD')
        if (valid) recordNamed += 1
      }
      namedCount += recordNamed
      if (frame < lastFrame) nonDecreasing = false
      lastFrame = frame
      records.push({ frame, show: show === 1, boneCount: count, bones })
    }
    if (!ok) continue
    let score = 0
    const totalNames = records.reduce((sum, record) => sum + record.boneCount, 0)
    if (totalNames > 0 && namedCount === totalNames) score += 5
    else if (namedCount > 0) score += 1
    const consumedToEnd = pos === byteLength
    if (consumedToEnd) score += 3
    else if (pos < byteLength) score += 0
    else continue
    if (nonDecreasing) score += 1
    if (!best || score > best.score) {
      best = { score, layout: candidate.tag, records, namedCount, consumedToEnd, endOffset: pos }
    }
  }
  return best
}

function parseVmdTrailingSections(rawBuffer, parsed) {
  const result = {
    present: false,
    lightCount: 0,
    selfShadowCount: 0,
    ik: { present: false, count: 0, records: [] },
    trailingBytes: 0,
    warnings: [],
  }
  try {
    const arrayBuffer = toArrayBuffer(rawBuffer)
    const dv = new DataView(arrayBuffer)
    const byteLength = arrayBuffer.byteLength
    const metadata = parsed.metadata || {}
    let offset = 50
    offset += 4 + (metadata.motionCount || 0) * 111
    offset += 4 + (metadata.morphCount || 0) * 23
    offset += 4 + (metadata.cameraCount || 0) * 61
    if (offset > byteLength) {
      result.warnings.push('VMD 长度不足以覆盖 motion/morph/camera 段，跳过后缀解析')
      return result
    }
    result.present = true

    if (offset + 4 <= byteLength) {
      const lightCount = dv.getUint32(offset, true)
      offset += 4
      if (offset + lightCount * 28 > byteLength) {
        result.warnings.push('VMD light 段越界（文件可能被截断），停止后缀解析')
        return result
      }
      result.lightCount = lightCount
      offset += lightCount * 28
    }
    if (offset + 4 <= byteLength) {
      const selfShadowCount = dv.getUint32(offset, true)
      offset += 4
      if (offset + selfShadowCount * 9 > byteLength) {
        result.warnings.push('VMD selfShadow 段越界（文件可能被截断），停止后缀解析')
        return result
      }
      result.selfShadowCount = selfShadowCount
      offset += selfShadowCount * 9
    }
    if (offset + 4 <= byteLength) {
      const ikCount = dv.getUint32(offset, true)
      offset += 4
      result.ik.present = true
      result.ik.count = ikCount
      if (ikCount > 0) {
        // VMD IK 段的记录布局存在变体（规范写作 20 字节骨名，但实测 reze-rig 产物
        // 是 [show u8][count u32][21 字节 × 骨名]）。用「能完整消费到文件尾 + 骨名可解码」
        // 做候选布局打分，避免把 IK 记录读成空骨名。
        const layout = detectIkLayout(dv, arrayBuffer, offset, ikCount)
        if (layout) {
          result.ik.records = layout.records
          result.ik.layout = layout.layout
          result.ik.bonesNamed = layout.namedCount
          result.ik.consumedToEnd = layout.consumedToEnd
          offset = layout.endOffset
          if (!layout.consumedToEnd) {
            result.warnings.push('VMD IK 段解析后仍有剩余字节（布局变体未完全识别）')
          }
        } else {
          result.warnings.push('VMD IK 段布局无法识别（骨名解码失败/越界），仅报告记录数')
        }
      }
      result.trailingBytes = Math.max(0, byteLength - offset)
    }
  } catch (error) {
    result.warnings.push(`VMD 后缀段解析失败: ${String(error && error.message ? error.message : error)}`)
  }
  return result
}

function collectPositionRange(motions) {
  const range = { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] }
  for (const motion of motions) {
    for (let axis = 0; axis < 3; axis++) {
      range.min[axis] = Math.min(range.min[axis], motion.position[axis])
      range.max[axis] = Math.max(range.max[axis], motion.position[axis])
    }
  }
  const size = range.max.map((value, axis) => round(value - range.min[axis], 4))
  const maxAbs = Math.max(...range.min.map((value) => Math.abs(value)), ...range.max.map((value) => Math.abs(value)))
  const horizontalMaxAbs = Math.max(Math.abs(range.min[0]), Math.abs(range.max[0]), Math.abs(range.min[2]), Math.abs(range.max[2]))
  const verticalMaxAbs = Math.max(Math.abs(range.min[1]), Math.abs(range.max[1]))
  return {
    min: range.min.map((value) => round(value, 4)),
    max: range.max.map((value) => round(value, 4)),
    size,
    maxAbs: round(maxAbs, 4),
    maxAbsPetPx540: round(maxAbs * MODEL_UNIT_TO_PET_PX_540, 2),
    // 水平漂移 = root motion（X/Z），垂直 = 下沉/上浮（Y）；单位均为模型单位。
    horizontalMaxAbs: round(horizontalMaxAbs, 4),
    horizontalMaxAbsPetPx540: round(horizontalMaxAbs * MODEL_UNIT_TO_PET_PX_540, 2),
    verticalMaxAbs: round(verticalMaxAbs, 4),
    verticalMaxAbsPetPx540: round(verticalMaxAbs * MODEL_UNIT_TO_PET_PX_540, 2),
  }
}

/**
 * 解析 VMD 并输出兼容性元数据。
 * @param {string} vmdPath
 * @param {{boneNames?:string[], morphNames?:string[], ikBoneNames?:string[]}} [model]
 */
function inspectVmd(vmdPath, model) {
  const fileStat = statFile(vmdPath)
  const buffer = fs.readFileSync(vmdPath)
  const parser = new Parser()
  const vmd = parser.parseVmd(toArrayBuffer(buffer), true)
  const metadata = vmd.metadata || {}
  const motions = vmd.motions || []
  const morphs = vmd.morphs || []
  const cameras = vmd.cameras || []

  const perBone = new Map()
  for (const motion of motions) {
    let entry = perBone.get(motion.boneName)
    if (!entry) {
      entry = { name: motion.boneName, keyframeCount: 0, frames: [], motions: [] }
      perBone.set(motion.boneName, entry)
    }
    entry.keyframeCount += 1
    entry.frames.push(motion.frameNum)
    entry.motions.push(motion)
  }

  const perMorph = new Map()
  for (const morph of morphs) {
    let entry = perMorph.get(morph.morphName)
    if (!entry) {
      entry = { name: morph.morphName, keyframeCount: 0, frames: [] }
      perMorph.set(morph.morphName, entry)
    }
    entry.keyframeCount += 1
    entry.frames.push(morph.frameNum)
  }

  const allFrames = [
    ...motions.map((motion) => motion.frameNum),
    ...morphs.map((morph) => morph.frameNum),
    ...cameras.map((camera) => camera.frameNum),
  ]
  const minFrame = allFrames.length > 0 ? Math.min(...allFrames) : 0
  const maxFrame = allFrames.length > 0 ? Math.max(...allFrames) : 0
  const durationSec = round(maxFrame / MMD_FPS, 4)

  const trackedBones = Array.from(perBone.keys()).sort()
  const trackedMorphs = Array.from(perMorph.keys()).sort()

  const centerBoneNames = ['センター', 'グルーブ', '全ての親']
  const centerDisplacement = []
  for (const name of centerBoneNames) {
    const entry = perBone.get(name)
    if (!entry) continue
    centerDisplacement.push({
      bone: name,
      keyframeCount: entry.keyframeCount,
      frameRange: [Math.min(...entry.frames), Math.max(...entry.frames)],
      // VMD 的 position 是「相对 rest 的偏移」；leftToRight 转换后 z 取反，单位=模型单位。
      translation: collectPositionRange(entry.motions),
    })
  }

  const ikModelBones = Array.isArray(model && model.ikBoneNames) ? model.ikBoneNames : []
  const standardIkControlBones = ['左足ＩＫ', '右足ＩＫ', '左つま先ＩＫ', '右つま先ＩＫ']
  const ikControlTracks = trackedBones
    .filter((name) => standardIkControlBones.includes(name) || /ＩＫ$/.test(name))
    .map((name) => {
      const entry = perBone.get(name)
      return {
        bone: name,
        keyframeCount: entry.keyframeCount,
        frameRange: [Math.min(...entry.frames), Math.max(...entry.frames)],
        translation: collectPositionRange(entry.motions),
      }
    })

  const legFkBones = ['左足', '右足', '左ひざ', '右ひざ', '左足首', '右足首', '左つま先', '右つま先', '左足D', '右足D', '左ひざD', '右ひざD', '左足首D', '右足首D']
  const legFkTracks = trackedBones.filter((name) => legFkBones.includes(name))

  const trailing = parseVmdTrailingSections(buffer, vmd)

  const modelBones = new Set((model && model.boneNames) || [])
  const modelMorphs = new Set((model && model.morphNames) || [])
  const boneMatched = trackedBones.filter((name) => modelBones.has(name))
  const boneMissing = trackedBones.filter((name) => !modelBones.has(name))
  const morphMatched = trackedMorphs.filter((name) => modelMorphs.has(name))
  const morphMissing = trackedMorphs.filter((name) => !modelMorphs.has(name))

  const standardInModel = STANDARD_HUMANOID_BONES.filter((name) => modelBones.has(name))
  const standardTracked = standardInModel.filter((name) => trackedBones.includes(name))
  const standardNotTracked = standardInModel.filter((name) => !trackedBones.includes(name))
  const standardMissingFromModel = STANDARD_HUMANOID_BONES.filter((name) => !modelBones.has(name))
  const standardCoverage = standardInModel.length > 0 ? round(standardTracked.length / standardInModel.length, 4) : 0
  const requiredInModel = REQUIRED_HUMANOID_BONES.filter((name) => modelBones.has(name))
  const requiredTracked = requiredInModel.filter((name) => trackedBones.includes(name))
  const requiredUntracked = requiredInModel.filter((name) => !trackedBones.includes(name))
  const requiredCoverage = requiredInModel.length > 0 ? round(requiredTracked.length / requiredInModel.length, 4) : 0

  const warnings = []
  if (metadata.magic !== 'Vocaloid Motion Data 0002') {
    warnings.push(`VMD magic 非 0002: ${metadata.magic}`)
  }
  if (maxFrame <= 0) warnings.push('VMD 没有任何帧号 > 0 的关键帧（时长≈0）')
  if (boneMissing.length > 0) {
    warnings.push(`VMD 有 ${boneMissing.length}/${trackedBones.length} 个骨骼轨道名在本 PMX 中不存在（MMDLoader 会静默丢弃这些轨道）`)
  }
  if (trailing.ik.present && trailing.ik.records.some((record) => record.show === false)) {
    warnings.push('VMD 在部分帧关闭了 IK，但 r171 MMDAnimationHelper 完全不解析 IK on/off 段、仍会每帧跑 CCDIK → 这些帧与 MMD 官方播放器不一致（可用 --ik off 对比验证）')
  }
  if (legFkTracks.length > 0 && ikModelBones.length > 0 && ikControlTracks.length === 0) {
    warnings.push('VMD 只动 FK 腿（足/ひざ/足首）而没有任何 IK 控制骨轨道：模型自带 4 根 IK 会持续生效，可能把腿拉回 rest 位（用 --ik off 对比）')
  }

  return {
    type: 'vmd',
    file: path.basename(vmdPath),
    path: vmdPath,
    bytes: fileStat.bytes,
    sha256: sha256(buffer),
    mtimeMs: fileStat.mtimeMs,
    metadata: {
      magic: metadata.magic,
      name: (metadata.name || '').trim(),
      coordinateSystem: metadata.coordinateSystem,
      motionCount: metadata.motionCount,
      morphCount: metadata.morphCount,
      cameraCount: metadata.cameraCount,
    },
    frameRate: MMD_FPS,
    frameRateNote: 'MMD VMD 固定 30fps（MMDLoader 用 frameNum/30 作为秒）',
    minFrame,
    maxFrame,
    durationSec,
    trackedBoneCount: trackedBones.length,
    trackedBones,
    trackedMorphCount: trackedMorphs.length,
    trackedMorphs,
    perBone: trackedBones.map((name) => {
      const entry = perBone.get(name)
      return { name, keyframeCount: entry.keyframeCount, frames: [Math.min(...entry.frames), Math.max(...entry.frames)] }
    }),
    centerDisplacement,
    ikControlTracks,
    legFkTracks,
    hasCameraFrames: cameras.length > 0,
    cameraFrameCount: cameras.length,
    lightFrames: trailing.lightCount,
    selfShadowFrames: trailing.selfShadowCount,
    ikSection: trailing.ik,
    trailingWarnings: trailing.warnings,
    compatibility: {
      modelBoneCount: modelBones.size,
      modelMorphCount: modelMorphs.size,
      modelIkBones: ikModelBones,
      boneMatchedCount: boneMatched.length,
      boneMatched,
      boneMissingCount: boneMissing.length,
      boneMissing,
      boneCoverage: trackedBones.length > 0 ? round(boneMatched.length / trackedBones.length, 4) : 0,
      morphMatchedCount: morphMatched.length,
      morphMatched,
      morphMissingCount: morphMissing.length,
      morphMissing,
      standardBoneCount: standardInModel.length,
      standardTrackedCount: standardTracked.length,
      standardCoverage,
      standardTracked,
      standardNotTracked,
      standardMissingFromModel,
      requiredBoneCount: requiredInModel.length,
      requiredTrackedCount: requiredTracked.length,
      requiredUntracked,
      requiredCoverage,
      ikControlTracked: ikControlTracks.map((track) => track.bone),
      modelIkBonesNotTracked: ikModelBones.filter((name) => !trackedBones.includes(name)),
      hasIkControlFrames: ikControlTracks.length > 0,
      hasIkEnableSection: trailing.ik.present,
      helperHonorsIkEnableSection: false,
    },
    warnings,
  }
}

/* ----------------------------------------------------------------------- VPD */

function decodeVpdText(buffer) {
  let body = buffer
  // 去 UTF-8 BOM
  if (body.length >= 3 && body[0] === 0xef && body[1] === 0xbb && body[2] === 0xbf) body = body.subarray(3)
  try {
    return { text: utf8FatalDecoder.decode(body), encoding: 'utf-8' }
  } catch {
    return { text: shiftJisDecoder.decode(body), encoding: 'shift_jis' }
  }
}

/**
 * @param {string} vpdPath
 * @param {{boneNames?:string[]}} [model]
 */
function inspectVpd(vpdPath, model) {
  const fileStat = statFile(vpdPath)
  const buffer = fs.readFileSync(vpdPath)
  const { text, encoding } = decodeVpdText(buffer)
  const parser = new Parser()
  const vpd = parser.parseVpd(text, true)
  const metadata = vpd.metadata || {}
  const bones = vpd.bones || []
  const names = bones.map((bone) => bone.name)
  const modelBones = new Set((model && model.boneNames) || [])
  const matched = names.filter((name) => modelBones.has(name))
  const missing = names.filter((name) => !modelBones.has(name))

  const warnings = []
  if (missing.length > 0) {
    warnings.push(`VPD 有 ${missing.length}/${names.length} 个骨名在本 PMX 中不存在（helper.pose 会按骨名查表、静默跳过）`)
  }
  if (metadata.boneCount !== bones.length) {
    warnings.push(`VPD 头部声明 ${metadata.boneCount} 骨，实际解析 ${bones.length} 骨`)
  }

  return {
    type: 'vpd',
    file: path.basename(vpdPath),
    path: vpdPath,
    bytes: fileStat.bytes,
    sha256: sha256(buffer),
    mtimeMs: fileStat.mtimeMs,
    encoding,
    metadata: {
      parentFile: (metadata.parentFile || '').trim(),
      boneCount: metadata.boneCount,
      coordinateSystem: metadata.coordinateSystem,
    },
    boneCount: bones.length,
    boneNames: names,
    bones: bones.map((bone) => ({
      name: bone.name,
      translation: bone.translation.map((value) => round(value, 4)),
      quaternion: bone.quaternion.map((value) => round(value, 6)),
      rotationDeg: round(2 * Math.acos(Math.min(1, Math.abs(bone.quaternion[3]))) * (180 / Math.PI), 2),
    })),
    compatibility: {
      modelBoneCount: modelBones.size,
      boneMatchedCount: matched.length,
      boneMatched: matched,
      boneMissingCount: missing.length,
      boneMissing: missing,
      boneCoverage: names.length > 0 ? round(matched.length / names.length, 4) : 0,
      standardBoneCount: STANDARD_HUMANOID_BONES.filter((name) => modelBones.has(name)).length,
      standardMatched: STANDARD_HUMANOID_BONES.filter((name) => names.includes(name)).length,
    },
    warnings,
  }
}

/* ----------------------------------------------------- 动作文件发现（自动模式） */

/**
 * 递归扫描动作目录（tests/tmp/motions/ 及 motion-hunt / Lead 的子目录）。
 * 返回 { vmd: [...], vpd: [...] }，按 mtime 从新到旧排序。
 */
function findMotionCandidates(motionsDir, options = {}) {
  const maxDepth = options.maxDepth || 4
  const result = { vmd: [], vpd: [], scanned: 0 }
  if (!motionsDir || !fs.existsSync(motionsDir)) return result

  const walk = (dir, depth) => {
    if (depth > maxDepth) return
    let entries
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue
      const fullPath = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules') continue
        walk(fullPath, depth + 1)
      } else if (entry.isFile()) {
        result.scanned += 1
        const lower = entry.name.toLowerCase()
        if (lower.endsWith('.vmd')) {
          result.vmd.push({ path: fullPath, mtimeMs: fs.statSync(fullPath).mtimeMs, bytes: fs.statSync(fullPath).size })
        } else if (lower.endsWith('.vpd')) {
          result.vpd.push({ path: fullPath, mtimeMs: fs.statSync(fullPath).mtimeMs, bytes: fs.statSync(fullPath).size })
        }
      }
    }
  }
  walk(motionsDir, 0)
  result.vmd.sort((a, b) => b.mtimeMs - a.mtimeMs)
  result.vpd.sort((a, b) => b.mtimeMs - a.mtimeMs)
  return result
}

/* ------------------------------------------------------- 兼容性清单 markdown */

function formatSeconds(value) {
  return `${Number(value).toFixed(2)}s`
}

function renderCompatibilityMarkdown(metadata) {
  const lines = []
  const push = (...items) => lines.push(...items)
  const model = metadata.model
  const runtime = metadata.runtime || {}
  const motion = metadata.motion

  push('# 动作兼容性检查清单（自动生成）', '')
  push(`- 生成时间：${metadata.timings.startedAtIso}`)
  push(`- 工具：\`${metadata.tool.name}\` v${metadata.tool.version}（three r${metadata.tool.threeRevision}，Electron ${metadata.tool.electronVersion}）`)
  push(`- 模型：\`${model.file}\`（${model.bytes} B，sha256 \`${model.sha256.slice(0, 16)}…\`）`)
  if (motion) push(`- 动作：\`${motion.file}\`（${motion.type.toUpperCase()}，${motion.bytes} B，sha256 \`${motion.sha256.slice(0, 16)}…\`）`)
  else push('- 动作：无（只加载模型做静态检查）')
  push('')

  push('## 1. 模型静态信息', '')
  push('| 项 | 值 |', '|---|---|')
  push(`| 顶点 / 三角 / 材质 | ${model.counts.vertices} / ${model.counts.faces} / ${model.counts.materials} |`)
  push(`| 骨骼 / morph | ${model.counts.bones} / ${model.counts.morphs} |`)
  push(`| IK 骨 | ${model.ikBones.map((ik) => `\`${ik.name}\`→\`${ik.effector}\`(iter ${ik.iteration})`).join('、')} |`)
  push(`| grant 骨 | ${model.grantCount} |`)
  push(`| 重名骨 | ${model.duplicateBoneNames.length === 0 ? '无' : model.duplicateBoneNames.map((item) => `\`${item.name}\`×${item.count}`).join('、')} |`)
  push(`| 模型高度（bind pose） | ${runtime.bbox ? round(runtime.bbox.size[1], 3) : '?'} 单位 |`)
  push('')

  if (motion && motion.type === 'vmd') {
    const compat = motion.compatibility
    push('## 2. VMD 动作信息', '')
    push('| 项 | 值 |', '|---|---|')
    push(`| VMD 名称 | ${motion.metadata.name || '(空)'} |`)
    push(`| 骨骼关键帧 / morph 关键帧 / 相机帧 | ${motion.metadata.motionCount} / ${motion.metadata.morphCount} / ${motion.metadata.cameraCount} |`)
    push(`| 帧率 / 帧范围 / 时长 | ${motion.frameRate}fps / ${motion.minFrame}–${motion.maxFrame} / ${formatSeconds(motion.durationSec)} |`)
    push(`| 有骨骼轨道的骨数 | ${motion.trackedBoneCount}（模型 382 骨中命中 ${compat.boneMatchedCount}） |`)
    push(`| IK 控制骨轨道 | ${motion.ikControlTracks.length === 0 ? '无' : motion.ikControlTracks.map((track) => `\`${track.bone}\`(${track.keyframeCount} 帧, 位移 maxAbs ${track.translation.maxAbs} 单位)`).join('、')} |`)
    push(`| FK 腿轨道 | ${motion.legFkTracks.length === 0 ? '无' : motion.legFkTracks.map((name) => `\`${name}\``).join('、')} |`)
    const ikSectionRecords = motion.ikSection.records || []
    const ikRecordSummary = ikSectionRecords.length === 0
      ? '无'
      : `${motion.ikSection.count} 条记录（show=false ${ikSectionRecords.filter((record) => !record.show).length} 条；${ikSectionRecords.slice(0, 3).map((record) => `f${record.frame}:${record.show ? 'on' : 'off'}(${(record.bones || []).filter(Boolean).join('/') || '?'})`).join('，')}${ikSectionRecords.length > 3 ? ' …' : ''}）`
    push(`| VMD IK on/off 段 | ${motion.ikSection.present ? ikRecordSummary : '无'} |`)
    push(`| 灯光帧 / 自阴影帧 | ${motion.lightFrames} / ${motion.selfShadowFrames} |`)
    push('')

    push('### 2.1 センター / グルーブ 位移范围（模型单位；VMD 相对 rest 偏移）', '')
    if (motion.centerDisplacement.length === 0) {
      push('无（该 VMD 没有 センター/グルーブ/全ての親 的位移关键帧；模型根骨骼保持 rest 位置）')
    } else {
      push('| 骨 | 关键帧 | 帧范围 | X[min,max] | Y[min,max] | Z[min,max] | maxAbs(单位) | 540px 宠物约 |', '|---|---:|---|---|---|---|---:|---:|')
      for (const item of motion.centerDisplacement) {
        const translation = item.translation
        push(`| \`${item.bone}\` | ${item.keyframeCount} | ${item.frameRange[0]}–${item.frameRange[1]} | ${translation.min[0]}..${translation.max[0]} | ${translation.min[1]}..${translation.max[1]} | ${translation.min[2]}..${translation.max[2]} | ${translation.maxAbs} | ${translation.maxAbsPetPx540}px |`)
      }
      push('', '> 判断「原地动作」：センター 的 X/Z 位移大 = 角色会整体漂移（需在 app 里做 root motion 归零或忽略 X/Z）；Y 负值大 = 下沉/可能需要贴地校正。')
    }
    push('')

    push('### 2.2 骨骼名交集 / 缺失', '')
    push(`- **动作本体必需骨覆盖：${compat.requiredTrackedCount}/${compat.requiredBoneCount}（${Math.round(compat.requiredCoverage * 1000) / 10}%）**${compat.requiredUntracked.length > 0 ? `；未动到：${compat.requiredUntracked.map((name) => `\`${name}\``).join('、')}` : '（躯干/四肢/足首齐全）'}`)
    push(`- 模型标准人形骨（含控制骨）有轨道的：${compat.standardTrackedCount}/${compat.standardBoneCount}（${Math.round(compat.standardCoverage * 1000) / 10}%）${compat.standardNotTracked.length === 0 ? '' : `；未动到：${compat.standardNotTracked.map((name) => `\`${name}\``).join('、')}`}`)
    push(`- 命中（全部 ${compat.boneMatchedCount}）：${compat.boneMatched.length === 0 ? '无' : compat.boneMatched.map((name) => `\`${name}\``).join('、')}`)
    push(`- 缺失（${compat.boneMissingCount}）：${compat.boneMissing.length === 0 ? '无' : compat.boneMissing.map((name) => `\`${name}\``).join('、')}`)
    push(`- 模型有 IK 但 VMD 未给控制骨轨道的骨：${compat.modelIkBonesNotTracked.length === 0 ? '无' : compat.modelIkBonesNotTracked.map((name) => `\`${name}\``).join('、')}`)
    if (motion.trackedMorphCount > 0) {
      push(`- morph 命中（${compat.morphMatchedCount}/${motion.trackedMorphCount}）：${compat.morphMatched.length === 0 ? '无' : compat.morphMatched.map((name) => `\`${name}\``).join('、')}`)
      if (compat.morphMissing.length > 0) {
        push(`- morph 缺失（${compat.morphMissingCount}）：${compat.morphMissing.map((name) => `\`${name}\``).join('、')}`)
      }
    }
    push('')

    push('### 2.3 已知运动学差异 / 风险', '')
    const bullet = (text) => push(`- ${text}`)
    if (motion.ikControlTracks.length > 0) {
      bullet('VMD 含足ＩＫ 轨道：three r171 `MMDAnimationHelper` 会跑 CCDIK（iteration 40）把脚拉到 IK 目标；观感与 MMD 官方播放器可能有细微差异（迭代解算 vs MMD 原生解算）。')
    } else {
      bullet('VMD 不含足ＩＫ 轨道：模型自带的 4 根足ＩＫ 仍会每帧解算，可能覆盖 VMD 的 FK 腿轨道（本工具可用 `--ik off` 对比）。')
    }
    if (motion.ikSection.present) {
      bullet('VMD 的 IK on/off 段（末尾段）**不会**被 r171 helper 消费：无法按帧开关 IK。')
    }
    bullet('センター/グルーブ 的位移会被直接应用（模型整体平移）：需要 root motion 归零时在 app 侧处理。')
    bullet('模型是 PMX layer1 的 D 链蒙皮（`足D/ひざD/足首D`），VMD 写的 `足/ひざ/足首` 需要 grant 才能带到蒙皮骨；helper 默认开启 grant，本工具已启用。')
    bullet('VMD 的相机/灯光帧与本预览器无关（本工具用固定正交观感相机；灯光固定三向光 + ambient）。')
    if (motion.warnings.length > 0) {
      push('', '**Warnings**：')
      for (const warning of motion.warnings) bullet(`⚠ ${warning}`)
    }
    push('')
  }

  if (motion && motion.type === 'vpd') {
    push('## 2. VPD 静态姿势信息', '')
    push(`| 项 | 值 |`, '|---|---|')
    push(`| 文本编码 | ${motion.encoding} |`)
    push(`| 声明父模型 | ${motion.metadata.parentFile || '(空)'} |`)
    push(`| 骨骼数（声明/解析） | ${motion.metadata.boneCount} / ${motion.boneCount} |`)
    push(`| 骨名命中 | ${motion.compatibility.boneMatchedCount}/${motion.boneCount} |`)
    push(`| 标准人形骨命中 | ${motion.compatibility.standardMatched}/${motion.compatibility.standardBoneCount} |`)
    push(`| 缺失骨名 | ${motion.compatibility.boneMissing.length === 0 ? '无' : motion.compatibility.boneMissing.map((name) => `\`${name}\``).join('、')} |`)
    push('')
    push('应用方式：`MMDLoader.loadVPD/parseVpd(text, true)` → `helper.pose(mesh, vpd)`（resetPose → 按骨名乘算四元数/加算位移 → CCDIK → grant）。')
    for (const warning of motion.warnings) push(`- ⚠ ${warning}`)
    push('')
  }

  push('## 3. 采样与截图', '')
  push('| 帧 | 角度 | 文件 | 非透明像素占比 | 渲染耗时 |', '|---|---|---|---:|---:|')
  for (const sample of metadata.samples) {
    const ratio = sample.stats && typeof sample.stats.nonTransparentRatio === 'number'
      ? `${(sample.stats.nonTransparentRatio * 100).toFixed(2)}%`
      : '?'
    push(`| ${sample.frame === null ? '静止' : sample.frame} | ${sample.angle} | \`${sample.file}\` | ${ratio} | ${sample.renderMs ?? '?'}ms |`)
  }
  push('')
  if (metadata.contactSheet) {
    push(`接触表：\`${metadata.contactSheet.file}\`（${metadata.contactSheet.width}×${metadata.contactSheet.height}，${metadata.contactSheet.rows} 行 × ${metadata.contactSheet.cols} 列）`)
    push('')
  }

  push('## 4. 自动化断言', '')
  for (const check of metadata.checks) {
    push(`- ${check.ok ? '✅' : '❌'} ${check.name}：${check.detail}`)
  }
  push('')

  push('## 5. 结论（自动判定，供人工复核）', '')
  for (const line of metadata.conclusion.lines) push(`- ${line}`)
  push('')
  return lines.join('\n')
}

module.exports = {
  MMD_FPS,
  inspectPmx,
  inspectVmd,
  inspectVpd,
  inspectVmdTextSections: parseVmdTrailingSections,
  findMotionCandidates,
  renderCompatibilityMarkdown,
  decodeVpdText,
}
