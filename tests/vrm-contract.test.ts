/**
 * W0-3 契约单测：VRM 模型资产契约（`src/shared/vrm.ts` + `src/shared/vrm-manifest.json`）。
 *
 * 冻结护栏：
 * - 共享契约必须是环境中立纯 TS（不得 import electron / node: / three / 第三方）；
 * - humanoid 骨名/表达式 preset/业务表情枚举冻结；
 * - `sanitizeVrmAssetManifest` 对任意脏输入不抛异常、非法条目丢弃且给 warning；
 * - 工作区里提交的 `vrm-manifest.json` 必须零 warning 通过清洗，且引用的私有资产（存在时）真实存在；
 * - 本地可选的 `yawOffsetDeg`/`lookAt`/`springChains` 默认值冻结。
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { sanitizeConfig } from '@shared/config'
import {
  DEFAULT_VRM_LOOK_AT,
  EMPTY_VRM_ASSET_MANIFEST,
  HUMANOID_BONES,
  KNOWN_AVATAR_IDS,
  MODEL_BACKEND_ENV,
  MODEL_BACKENDS,
  PET_EXPRESSIONS,
  VRM_AVATAR_SPEC_VERSIONS,
  VRM_EXPRESSION_PRESETS,
  VRM_MANIFEST_SCHEMA_VERSION,
  VRM_REQUIRED_HUMANOID_BONES,
  isHumanoidBone,
  isPetExpression,
  isSafeAssetReference,
  isVrmExpressionPreset,
  parseModelBackend,
  resolveAvatarAsset,
  resolveModelBackend,
  sanitizeVrmAssetManifest
} from '@shared/vrm'
import type { VrmAssetManifestInput } from '@shared/vrm'

const SHARED_DIR = fileURLToPath(new URL('../src/shared', import.meta.url))
const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url))
const VRM_MANIFEST_PATH = fileURLToPath(new URL('../src/shared/vrm-manifest.json', import.meta.url))

/** 读工作区里已提交的 vrm-manifest（按 JSON 解析；后续用契约清洗）。 */
function readCommittedVrmManifest(): unknown {
  return JSON.parse(readFileSync(VRM_MANIFEST_PATH, 'utf8'))
}

/** assets/ 目录是否存在（私有资产可能不在新 clone 里；存在时做真实文件断言）。 */
function hasPrivateAssets(): boolean {
  return existsSync(`${REPO_ROOT}/assets/vrm`)
}

describe('src/shared 环境中立（禁止 electron/node:/three/第三方 import）', () => {
  const files = readdirSync(SHARED_DIR).filter((name) => name.endsWith('.ts'))
  const IMPORT_RE = /(?:from\s+|import\s*\(\s*|require\s*\(\s*)['"]([^'"]+)['"]/g

  it('src/shared/*.ts 至少包含 W0-3 契约文件', () => {
    expect(files).toContain('vrm.ts')
    expect(files).toContain('animation-contract.ts')
  })

  it.each(files)('%s 只 import 相对路径模块', (file) => {
    const source = readFileSync(`${SHARED_DIR}/${file}`, 'utf8')
    for (const match of source.matchAll(IMPORT_RE)) {
      const specifier = match[1]
      expect(
        specifier.startsWith('./') || specifier.startsWith('../'),
        `${file} 违规 import: ${specifier}`
      ).toBe(true)
    }
  })
})

describe('humanoid 骨名契约（VRM 1.0 标准名，55 根）', () => {
  it('55 根、唯一、全部小驼峰且无重复', () => {
    expect(HUMANOID_BONES).toHaveLength(55)
    expect(new Set(HUMANOID_BONES).size).toBe(55)
    for (const bone of HUMANOID_BONES) expect(bone).toMatch(/^[a-z][A-Za-z]*$/)
  })

  it('规范必需骨是全集子集（15 根核心人形骨）', () => {
    expect(VRM_REQUIRED_HUMANOID_BONES).toHaveLength(15)
    for (const bone of VRM_REQUIRED_HUMANOID_BONES) {
      expect(HUMANOID_BONES).toContain(bone)
    }
    expect(VRM_REQUIRED_HUMANOID_BONES).toContain('hips')
    expect(VRM_REQUIRED_HUMANOID_BONES).toContain('head')
    expect(VRM_REQUIRED_HUMANOID_BONES).not.toContain('jaw')
    expect(VRM_REQUIRED_HUMANOID_BONES).not.toContain('leftToes')
  })

  it('isHumanoidBone 只接受白名单；大小写敏感', () => {
    expect(isHumanoidBone('leftUpperArm')).toBe(true)
    expect(isHumanoidBone('head')).toBe(true)
    expect(isHumanoidBone('Head')).toBe(false)
    expect(isHumanoidBone('頭')).toBe(false)
    expect(isHumanoidBone(null)).toBe(false)
  })
})

describe('表情枚举契约', () => {
  it('VRM 1.0 preset 18 个、唯一', () => {
    expect(VRM_EXPRESSION_PRESETS).toHaveLength(18)
    expect(new Set(VRM_EXPRESSION_PRESETS).size).toBe(18)
    expect(VRM_EXPRESSION_PRESETS).toContain('blinkLeft')
    expect(VRM_EXPRESSION_PRESETS).toContain('lookUp')
    for (const preset of VRM_EXPRESSION_PRESETS) expect(isVrmExpressionPreset(preset)).toBe(true)
    expect(isVrmExpressionPreset('joy')).toBe(false) // VRM0 名不是 VRM1 preset（由 three-vrm 归一化）
  })

  it('业务表情（9 个）是 preset 的子集，且不含注视通道', () => {
    expect(PET_EXPRESSIONS).toHaveLength(9)
    for (const expression of PET_EXPRESSIONS) {
      expect(VRM_EXPRESSION_PRESETS).toContain(expression)
      expect(isPetExpression(expression)).toBe(true)
    }
    expect(PET_EXPRESSIONS).not.toContain('lookAtX')
    expect(PET_EXPRESSIONS).not.toContain('aa')
  })
})

describe('模型后端 flag 解析（env > config > 默认 vrm）', () => {
  it(`MODEL_BACKENDS 与 ${MODEL_BACKEND_ENV} 常量冻结`, () => {
    expect(MODEL_BACKENDS).toEqual(['vrm', 'legacy-pmx'])
    expect(MODEL_BACKEND_ENV).toBe('PET_MODEL_BACKEND')
  })

  it('parseModelBackend：trim/大小写/非法输入', () => {
    expect(parseModelBackend('vrm')).toBe('vrm')
    expect(parseModelBackend(' legacy-pmx ')).toBe('legacy-pmx')
    expect(parseModelBackend('VRM')).toBeNull()
    expect(parseModelBackend('')).toBeNull()
    expect(parseModelBackend(undefined)).toBeNull()
    expect(parseModelBackend(null)).toBeNull()
    expect(parseModelBackend(3)).toBeNull()
  })

  it('resolveModelBackend：env 覆盖配置，非法 env 回退配置，非法配置回退 vrm', () => {
    expect(resolveModelBackend('legacy-pmx', 'vrm')).toBe('legacy-pmx')
    expect(resolveModelBackend('vrm', 'legacy-pmx')).toBe('vrm')
    expect(resolveModelBackend(undefined, 'legacy-pmx')).toBe('legacy-pmx')
    expect(resolveModelBackend('bogus', 'legacy-pmx')).toBe('legacy-pmx')
    expect(resolveModelBackend(undefined, 'bogus' as never)).toBe('vrm')
    // 与 sanitizeConfig 联动：默认配置 → vrm；legacy 配置在 env 缺失时生效
    expect(resolveModelBackend(undefined, sanitizeConfig({}).modelBackend)).toBe('vrm')
    expect(
      resolveModelBackend(undefined, sanitizeConfig({ modelBackend: 'legacy-pmx' }).modelBackend)
    ).toBe('legacy-pmx')
  })
})

describe('isSafeAssetReference（assets 相对路径 / pet-asset URL）', () => {
  it('合法：CJK/空格/破折号的相对路径、两层目录、pet-asset URL', () => {
    expect(isSafeAssetReference('vrm/aventurine.vrm')).toBe(true)
    expect(isSafeAssetReference('vrm/canary/砂金石心十人公司制服(0.x).vrm')).toBe(true)
    expect(isSafeAssetReference('motions/default/motion-idle.glb')).toBe(true)
    expect(isSafeAssetReference('my motion.vrma')).toBe(true)
    expect(isSafeAssetReference('pet-asset://model/%E9%A2%9C.png')).toBe(true)
    expect(isSafeAssetReference('pet-asset://vrm/a.vrm')).toBe(true)
  })

  it('非法：空/空白/绝对路径/穿越/反斜杠/NUL/控制字符/冒号/协议注入/尾斜杠/超长', () => {
    for (const bad of [
      '',
      '   ',
      '/etc/passwd',
      '../a.vrm',
      'vrm/../../a.vrm',
      'vrm/./a.vrm',
      'vrm//a.vrm',
      'vrm/a.vrm/',
      'vrm\\a.vrm',
      'vrm/a\u0000.vrm',
      'vrm/a\u001b.vrm',
      'vrm/a.vrm:123',
      'http://evil/a.vrm',
      'pet-asset:///a.vrm',
      'pet-asset://model/a.vrm?x=1',
      'x'.repeat(513),
      null,
      42
    ]) {
      expect(isSafeAssetReference(bad), `应拒绝: ${String(bad)}`).toBe(false)
    }
  })
})

describe('sanitizeVrmAssetManifest：提交的 vrm-manifest.json', () => {
  it('零 warning 通过清洗，2 个 avatar 且 default=aventurine（V5 起主链切目标模型）', () => {
    const result = sanitizeVrmAssetManifest(readCommittedVrmManifest())
    expect(result.warnings).toEqual([])
    expect(result.value.schemaVersion).toBe(VRM_MANIFEST_SCHEMA_VERSION)
    expect(result.value.avatars.map((avatar) => avatar.id)).toEqual([
      KNOWN_AVATAR_IDS.canary,
      KNOWN_AVATAR_IDS.aventurine
    ])
    // V5：主链接入目标模型（aventurine）；canary 保留为对照/回退条目。
    expect(result.value.defaultAvatarId).toBe(KNOWN_AVATAR_IDS.aventurine)
  })

  it('canary 条目：VRM 0.x、1.76m、7 个表情、VRM lookAt（VRM0 firstPerson.lookAtTypeName=Bone）、无 spring', () => {
    const manifest = sanitizeVrmAssetManifest(readCommittedVrmManifest()).value
    const canary = resolveAvatarAsset(manifest, KNOWN_AVATAR_IDS.canary)
    expect(canary).not.toBeNull()
    expect(canary?.specVersion).toBe('0.x')
    expect(canary?.heightMeters).toBe(1.76)
    expect(canary?.file).toBe('vrm/canary/砂金石心十人公司制服(0.x).vrm')
    expect(Object.keys(canary?.expressions ?? {})).toEqual([
      'blink',
      'blinkLeft',
      'blinkRight',
      'happy',
      'angry',
      'surprised',
      'neutral'
    ])
    // W0-4 实测：canary 是 VRM 0.x，lookAt 定义在 firstPerson.lookAtTypeName="Bone"（three-vrm 归一化为 VRM lookAt）
    expect(canary?.lookAt).toEqual({ mode: 'vrm', maxYawDeg: 35, maxPitchDeg: 20 })
    expect(canary?.springChains).toBe(0)
    expect(canary?.yawOffsetDeg).toBe(0)
  })

  it('aventurine 条目：VRM 1.0、1.73m、T-pose 重制版（面向 +Z，yawOffsetDeg=0）、procedural 注视', () => {
    const manifest = sanitizeVrmAssetManifest(readCommittedVrmManifest()).value
    const aventurine = resolveAvatarAsset(manifest, KNOWN_AVATAR_IDS.aventurine)
    expect(aventurine?.specVersion).toBe('1.0')
    expect(aventurine?.heightMeters).toBe(1.73)
    // W0-5/W1.5：manifest 指向数据修复后的本地副本（原始文件只读保留）
    expect(aventurine?.file).toBe('vrm/aventurine-tpose.vrm')
    // W0-4 实测：戏浪 VRM1 面向 -Z（front 取景看到后脑）→ manifest 修正
    expect(aventurine?.yawOffsetDeg).toBe(0)
    expect(aventurine?.lookAt.mode).toBe('procedural')
    expect(aventurine?.notes).toContain('禁止二次配布')
    // W1.5-Tpose：PMX 源经 VRMify 转规范 T-pose（A-pose 手臂抬高/付与骨合并/SpringBone）
    expect(aventurine?.notes).toContain('W1.5-Tpose')
    expect(aventurine?.notes).toContain('T-pose')
    expect(aventurine?.notes).toContain('付与骨')
    expect(aventurine?.notes).toContain('--axis x')
    // T-pose 重制版带 SpringBone（50 链）与标准 VRM1 朝向（面向 +Z）
    expect(aventurine?.springChains).toBe(50)
  })

  it('私有资产存在时，manifest 引用的文件真实存在（不存在则跳过）', () => {
    const manifest = sanitizeVrmAssetManifest(readCommittedVrmManifest()).value
    for (const avatar of manifest.avatars) {
      if (avatar.file.startsWith('pet-asset://')) continue
      if (!hasPrivateAssets()) return
      expect(existsSync(`${REPO_ROOT}/assets/${avatar.file}`), avatar.file).toBe(true)
    }
  })
})

describe('sanitizeVrmAssetManifest：脏输入与默认值', () => {
  it('非对象 / schemaVersion 非 1 → 空 manifest + warning，永不抛异常', () => {
    for (const bad of [undefined, null, 42, 'x', [], { schemaVersion: 2, avatars: [] }]) {
      const result = sanitizeVrmAssetManifest(bad)
      expect(result.value).toEqual(EMPTY_VRM_ASSET_MANIFEST)
      expect(result.warnings.length).toBeGreaterThan(0)
    }
  })

  it('空 avatars 数组 → defaultAvatarId 为空串（调用方回退 legacy）', () => {
    const result = sanitizeVrmAssetManifest({ schemaVersion: 1, avatars: [] })
    expect(result.value.avatars).toEqual([])
    expect(result.value.defaultAvatarId).toBe('')
    expect(resolveAvatarAsset(result.value)).toBeNull()
  })

  it('最小合法条目：省略字段回填默认（height 1.7 需 warning 提示人工核对）', () => {
    const result = sanitizeVrmAssetManifest({
      schemaVersion: 1,
      avatars: [{ id: 'test-avatar', file: 'vrm/test.vrm' }]
    })
    const avatar = result.value.avatars[0]
    expect(avatar.specVersion).toBe('1.0')
    expect(avatar.heightMeters).toBe(1.7)
    expect(avatar.humanoid).toEqual({})
    expect(avatar.expressions).toEqual({})
    expect(avatar.lookAt).toEqual(DEFAULT_VRM_LOOK_AT)
    expect(avatar.springChains).toBe(0)
    expect(avatar.yawOffsetDeg).toBe(0)
    expect(avatar.thumbnail).toBeNull()
    expect(avatar.notes).toBe('')
    expect(result.value.defaultAvatarId).toBe('test-avatar')
    expect(result.warnings.some((warning) => warning.includes('heightMeters'))).toBe(true)
  })

  it('非法 avatar（坏 id / 不安全 file / 非对象）丢弃，其余保留', () => {
    const result = sanitizeVrmAssetManifest({
      schemaVersion: 1,
      avatars: [
        null,
        { id: '../evil', file: 'vrm/a.vrm' },
        { id: 'ok', file: '../../etc/passwd' },
        { id: 'good', file: 'vrm/good.vrm', heightMeters: 1.6 }
      ]
    })
    expect(result.value.avatars.map((avatar) => avatar.id)).toEqual(['good'])
    expect(result.warnings.length).toBeGreaterThanOrEqual(3)
  })

  it('重复 id 只保留第一个；defaultAvatarId 不存在时回退第一个', () => {
    const result = sanitizeVrmAssetManifest({
      schemaVersion: 1,
      defaultAvatarId: 'nope',
      avatars: [
        { id: 'a', file: 'vrm/a.vrm' },
        { id: 'a', file: 'vrm/a2.vrm' },
        { id: 'b', file: 'vrm/b.vrm' }
      ]
    })
    expect(result.value.avatars.map((avatar) => avatar.id)).toEqual(['a', 'b'])
    expect(result.value.avatars[0].file).toBe('vrm/a.vrm')
    expect(result.value.defaultAvatarId).toBe('a')
    expect(result.warnings.some((warning) => warning.includes('重复'))).toBe(true)
  })

  it('数值越界钳制：height [0.2,10]、yaw [-360,360]、lookAt 角度 [0,90]', () => {
    const result = sanitizeVrmAssetManifest({
      schemaVersion: 1,
      avatars: [
        {
          id: 'clamp',
          file: 'vrm/c.vrm',
          heightMeters: 99,
          yawOffsetDeg: -720,
          lookAt: { mode: 'procedural', maxYawDeg: 999, maxPitchDeg: -5 }
        }
      ]
    })
    const avatar = result.value.avatars[0]
    expect(avatar.heightMeters).toBe(10)
    expect(avatar.yawOffsetDeg).toBe(-360)
    expect(avatar.lookAt.maxYawDeg).toBe(90)
    expect(avatar.lookAt.maxPitchDeg).toBe(0)
    expect(result.warnings.length).toBeGreaterThanOrEqual(3)
  })

  it('humanoid/expressions 绑定：过滤未知键与非法值，保留合法绑定', () => {
    const result = sanitizeVrmAssetManifest({
      schemaVersion: 1,
      avatars: [
        {
          id: 'bind',
          file: 'vrm/b.vrm',
          humanoid: { head: '頭', bogus: 'x', spine: '', hips: 42 },
          expressions: { blink: 'blink', joy: 'happy', sad: '   ' }
        }
      ]
    })
    const avatar = result.value.avatars[0]
    expect(avatar.humanoid).toEqual({ head: '頭' })
    expect(avatar.expressions).toEqual({ blink: 'blink' })
  })

  it('未知 specVersion / 非法 lookAt.mode 回退并 warning', () => {
    const result = sanitizeVrmAssetManifest({
      schemaVersion: 1,
      avatars: [
        {
          id: 'x',
          file: 'vrm/x.vrm',
          specVersion: '2.0',
          lookAt: 'nope'
        }
      ]
    })
    const avatar = result.value.avatars[0]
    expect(avatar.specVersion).toBe('1.0')
    expect(avatar.lookAt).toEqual(DEFAULT_VRM_LOOK_AT)
    expect(result.warnings.length).toBeGreaterThanOrEqual(2)
  })

  it('任意 JSON 垃圾输入不抛异常（fuzz 级抽查）', () => {
    const samples: VrmAssetManifestInput[] = [
      { schemaVersion: 1, avatars: [] },
      { schemaVersion: 1, avatars: [{ id: 'a', file: 'vrm/a.vrm' }] }
    ]
    expect(() => sanitizeVrmAssetManifest(samples)).not.toThrow()
    expect(() => sanitizeVrmAssetManifest(JSON.parse('{"avatars":[1,2,3]}'))).not.toThrow()
  })
})

describe('resolveAvatarAsset：显式 id > defaultAvatarId > 第一个', () => {
  const manifest = sanitizeVrmAssetManifest(readCommittedVrmManifest()).value

  it('显式 id 命中', () => {
    expect(resolveAvatarAsset(manifest, KNOWN_AVATAR_IDS.aventurine)?.id).toBe(
      KNOWN_AVATAR_IDS.aventurine
    )
  })

  it('显式 id 未命中 → defaultAvatarId；空 id/null → default', () => {
    expect(resolveAvatarAsset(manifest, 'not-exist')?.id).toBe(manifest.defaultAvatarId)
    expect(resolveAvatarAsset(manifest, null)?.id).toBe(manifest.defaultAvatarId)
    expect(resolveAvatarAsset(manifest)?.id).toBe(manifest.defaultAvatarId)
  })

  it('空 manifest → null', () => {
    expect(resolveAvatarAsset(EMPTY_VRM_ASSET_MANIFEST)).toBeNull()
  })
})

describe('VRM_AVATAR_SPEC_VERSIONS 常量', () => {
  it("只剩 '0.x' | '1.0' 两种规范版本", () => {
    expect(VRM_AVATAR_SPEC_VERSIONS).toEqual(['0.x', '1.0'])
  })
})
