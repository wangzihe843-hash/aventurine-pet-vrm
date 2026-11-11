'use strict'

/**
 * 自造最小测试动作（不依赖任何外部下载）：
 * - `buildSyntheticVmd()`：真实 VMD 二进制（Vocaloid Motion Data 0002），
 *   含 センター 位移、上半身/腕/ひじ/頭 旋转、左足 FK 旋转、左足ＩＫ 位移，以及
 *   VMD 末尾的 IK on/off 段（MMDAnimationHelper 不消费，但我们的兼容性检查器会报告）。
 * - `buildSyntheticVpd()`：UTF-8 VPD 静态姿势（真实骨名，走 MMDLoader/parseVpd 真实路径）。
 *
 * 骨名用 Shift-JIS 硬编码字节（Node 原生无 Shift-JIS 编码器；这些字节已用 Python/iconv 校验）。
 * 用途：motion-hunt / Lead 的真实 VMD 到位前，先证明「PMX→VMD 解析→MMDAnimationHelper→IK/grant→截图」
 * 全链路可用；也用于工具的自动回归。
 */

const FPS = 30

/** 常用 MMD 骨名的 Shift-JIS 字节（PMX 内骨名同编码）。 */
const SHIFT_JIS_BONE_NAMES = {
  センター: [0x83, 0x5a, 0x83, 0x93, 0x83, 0x5e, 0x81, 0x5b],
  上半身: [0x8f, 0xe3, 0x94, 0xbc, 0x90, 0x67],
  左腕: [0x8d, 0xb6, 0x98, 0x72],
  右腕: [0x89, 0x45, 0x98, 0x72],
  左ひじ: [0x8d, 0xb6, 0x82, 0xd0, 0x82, 0xb6],
  頭: [0x93, 0xaa],
  左足: [0x8d, 0xb6, 0x91, 0xab],
  左足ＩＫ: [0x8d, 0xb6, 0x91, 0xab, 0x82, 0x68, 0x82, 0x6a],
  右足ＩＫ: [0x89, 0x45, 0x91, 0xab, 0x82, 0x68, 0x82, 0x6a],
  全ての親: [0x91, 0x53, 0x82, 0xc4, 0x82, 0xcc, 0x90, 0x65],
}

const DEFAULT_INTERPOLATION = 0x14 // 20/127 ≈ MMD 默认近线性贝塞尔控制点

function padName(nameBytes, width) {
  const out = Buffer.alloc(width, 0)
  Buffer.from(nameBytes).copy(out, 0, 0, Math.min(nameBytes.length, width))
  return out
}

/** 轴角 → 四元数 [x,y,z,w]。 */
function axisAngle(axis, radians) {
  const half = radians / 2
  const s = Math.sin(half)
  const cos = Math.cos(half)
  if (axis === 'x') return [s, 0, 0, cos]
  if (axis === 'y') return [0, s, 0, cos]
  if (axis === 'z') return [0, 0, s, cos]
  throw new Error(`bad axis ${axis}`)
}

/**
 * 构造一条 VMD 骨骼关键帧记录（111 字节）。
 * @param {string} boneName 日文骨名（必须在 SHIFT_JIS_BONE_NAMES 表里）
 * @param {number} frameNum 帧号（30fps）
 * @param {number[]} position MMD 左手系下的位移（相对 rest）
 * @param {number[]} rotation 四元数 [x,y,z,w]（MMD 左手系，parseVmd 会做 leftToRight）
 */
function motionRecord(boneName, frameNum, position = [0, 0, 0], rotation = [0, 0, 0, 1]) {
  const bytes = SHIFT_JIS_BONE_NAMES[boneName]
  if (!bytes) throw new Error(`synthetic VMD 没有骨名 Shift-JIS 字节: ${boneName}`)
  const buffer = Buffer.alloc(111)
  padName(bytes, 15).copy(buffer, 0)
  buffer.writeUInt32LE(frameNum, 15)
  for (let i = 0; i < 3; i++) buffer.writeFloatLE(position[i] || 0, 19 + i * 4)
  for (let i = 0; i < 4; i++) buffer.writeFloatLE(rotation[i] === undefined ? 0 : rotation[i], 31 + i * 4)
  buffer.fill(DEFAULT_INTERPOLATION, 47, 47 + 64)
  return buffer
}

/** 构造 VMD 末尾的 IK on/off 段（record: 帧号 + show + 骨名列表）。 */
function ikSection(records) {
  const head = Buffer.alloc(4)
  head.writeUInt32LE(records.length, 0)
  const chunks = [head]
  for (const record of records) {
    const names = record.bones.map((name) => {
      const bytes = SHIFT_JIS_BONE_NAMES[name]
      if (!bytes) throw new Error(`synthetic IK 段没有骨名字节: ${name}`)
      return padName(bytes, 20)
    })
    const header = Buffer.alloc(6)
    header.writeUInt32LE(record.frame, 0)
    header.writeUInt8(record.show ? 1 : 0, 4)
    header.writeUInt8(names.length, 5)
    chunks.push(header, ...names)
  }
  return Buffer.concat(chunks)
}

/**
 * 造一段 60 帧的测试动作：
 * - センター 上下起伏（f0 0 / f20 -0.9 / f40 +0.35 / f60 0，模型单位）
 * - 上半身 前倾/后仰；左/右腕 抬臂；左ひじ 屈肘；頭 转头
 * - 左足 FK 前后摆（用于对比 IK on/off 的干涉）
 * - 左足ＩＫ 在 f40 抬高 2 单位（IK 驱动路径）
 * - IK on/off 段：f0 IK 开、f20 IK 关、f40 IK 开（r171 helper 不消费，检查器会报告）
 */
function buildSyntheticVmd() {
  const motions = [
    // センター：整体 y 位移（MMD 坐标；leftToRight 只翻 z，所以 y 不变）
    motionRecord('センター', 0, [0, 0, 0]),
    motionRecord('センター', 20, [0, -0.9, 0]),
    motionRecord('センター', 40, [0, 0.35, 0]),
    motionRecord('センター', 60, [0, 0, 0]),

    // 上半身：绕 X 前倾/后仰
    motionRecord('上半身', 0, [0, 0, 0], [0, 0, 0, 1]),
    motionRecord('上半身', 20, [0, 0, 0], axisAngle('x', 0.3)),
    motionRecord('上半身', 40, [0, 0, 0], axisAngle('x', -0.18)),
    motionRecord('上半身', 60, [0, 0, 0], [0, 0, 0, 1]),

    // 左腕：绕 Z 抬臂（左臂指向 +X，+Z 正转 = 抬）
    motionRecord('左腕', 0, [0, 0, 0], [0, 0, 0, 1]),
    motionRecord('左腕', 20, [0, 0, 0], axisAngle('z', 0.6)),
    motionRecord('左腕', 40, [0, 0, 0], axisAngle('z', 1.2)),
    motionRecord('左腕', 60, [0, 0, 0], axisAngle('z', 0.2)),

    // 右腕：镜像（-Z）
    motionRecord('右腕', 0, [0, 0, 0], [0, 0, 0, 1]),
    motionRecord('右腕', 20, [0, 0, 0], axisAngle('z', -0.6)),
    motionRecord('右腕', 40, [0, 0, 0], axisAngle('z', -1.2)),
    motionRecord('右腕', 60, [0, 0, 0], axisAngle('z', -0.2)),

    // 左ひじ：屈肘（绕 X 前摆）
    motionRecord('左ひじ', 0, [0, 0, 0], [0, 0, 0, 1]),
    motionRecord('左ひじ', 20, [0, 0, 0], axisAngle('x', -0.5)),
    motionRecord('左ひじ', 40, [0, 0, 0], axisAngle('x', -0.9)),
    motionRecord('左ひじ', 60, [0, 0, 0], axisAngle('x', -0.2)),

    // 頭：左右转头
    motionRecord('頭', 0, [0, 0, 0], [0, 0, 0, 1]),
    motionRecord('頭', 20, [0, 0, 0], axisAngle('y', 0.25)),
    motionRecord('頭', 40, [0, 0, 0], axisAngle('y', -0.25)),
    motionRecord('頭', 60, [0, 0, 0], [0, 0, 0, 1]),

    // 左足 FK（标准骨，非 D 链）：前后摆——用于验证「PMX 的足ＩＫ 会不会把 FK 腿拉回去」
    motionRecord('左足', 0, [0, 0, 0], [0, 0, 0, 1]),
    motionRecord('左足', 20, [0, 0, 0], axisAngle('x', -0.5)),
    motionRecord('左足', 40, [0, 0, 0], axisAngle('x', 0.3)),
    motionRecord('左足', 60, [0, 0, 0], [0, 0, 0, 1]),

    // 左足ＩＫ 目标位移：MMD 坐标 y 向上抬 2 单位（leftToRight 不翻 y）
    motionRecord('左足ＩＫ', 0, [0, 0, 0]),
    motionRecord('左足ＩＫ', 40, [0, 2, 0]),
    motionRecord('左足ＩＫ', 60, [0, 0, 0]),
  ]

  const body = Buffer.concat(motions)
  const header = Buffer.alloc(30, 0)
  header.write('Vocaloid Motion Data 0002', 0, 'ascii')
  const modelName = Buffer.alloc(20, 0)
  modelName.write('synthetic preview', 0, 'ascii')

  const motionCount = Buffer.alloc(4)
  motionCount.writeUInt32LE(motions.length, 0)
  const morphCount = Buffer.alloc(4) // 0
  const cameraCount = Buffer.alloc(4) // 0
  const lightCount = Buffer.alloc(4) // 0
  const selfShadowCount = Buffer.alloc(4) // 0

  return Buffer.concat([
    header,
    modelName,
    motionCount,
    body,
    morphCount,
    cameraCount,
    lightCount,
    selfShadowCount,
    ikSection([
      { frame: 0, show: true, bones: ['左足ＩＫ', '右足ＩＫ'] },
      { frame: 20, show: false, bones: ['左足ＩＫ', '右足ＩＫ'] },
      { frame: 40, show: true, bones: ['左足ＩＫ', '右足ＩＫ'] },
    ]),
  ])
}

/**
 * 造一个 5 骨的 UTF-8 VPD 静态姿势（真实骨名）：
 * 左腕 +0.6rad Z 抬臂、右腕 -0.6rad Z、上半身前倾 0.2rad X、頭 左转 0.3rad Y、左ひじ 屈肘 0.6rad X。
 * VPD 是 MMD 左手系文本；parseVpd(text, true) 会做 leftToRight（x/y 取反、z 位移取反）。
 */
function buildSyntheticVpd() {
  const bones = [
    { name: '左腕', rotation: axisAngle('z', 0.6) },
    { name: '右腕', rotation: axisAngle('z', -0.6) },
    { name: '上半身', rotation: axisAngle('x', 0.2) },
    { name: '頭', rotation: axisAngle('y', 0.3) },
    { name: '左ひじ', rotation: axisAngle('x', -0.6) },
  ]
  const lines = ['Vocaloid Pose Data file', 'synthetic preview (utf-8)', 'synthetic.pmx', String(bones.length)]
  bones.forEach((bone, index) => {
    lines.push(`Bone${index}{${bone.name}`)
    lines.push('0.000000,0.000000,0.000000;')
    lines.push(
      `${bone.rotation[0].toFixed(6)},${bone.rotation[1].toFixed(6)},${bone.rotation[2].toFixed(6)},${bone.rotation[3].toFixed(6)};`
    )
    lines.push('}')
  })
  lines.push('')
  return lines.join('\r\n')
}

module.exports = {
  FPS,
  SHIFT_JIS_BONE_NAMES,
  buildSyntheticVmd,
  buildSyntheticVpd,
}
