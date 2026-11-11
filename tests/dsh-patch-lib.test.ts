/**
 * `scripts/dsh-patch-lib.mjs` 的单测（计划 §5.1 C7 / E14）。
 *
 * 这组纯函数决定"激活脚本能不能只删自己的桥行、保留用户其它 patch（如 webserver 固定端口行）"，
 * 因此重点覆盖：追加/删除/幂等、保留其它行、旧版 legacy 块兼容、坏 marker 边界、空 patch 哨兵 `[]`。
 */
import { describe, expect, it } from 'vitest'

import {
  BRIDGE_BLOCK_BEGIN,
  BRIDGE_BLOCK_END,
  BRIDGE_ROW_ID,
  appendBridgeBlock,
  buildBridgeBlock,
  checkPatchStructure,
  findBridgeInsertEntry,
  hasBridgeBlock,
  inspectBridgeBlock,
  removeBridgeInsertEntries,
  satisfiesDshRangeApprox,
  stripBridgeBlock
} from '../scripts/dsh-patch-lib.mjs'

/** 与真实 profile 相同的"其它 patch"（固定端口行等），用于断言删除桥块后原样保留。 */
const OTHER_PATCH = [
  '# Your patch layer for this dsh profile, applied after every bundle layer:',
  '- id: webserver',
  '  name: "@deepseek-ai/dsh-host-webserver"',
  '  inject: [ webStartup ]',
  '  config:',
  '    host: 127.0.0.1',
  '    port: 38765'
].join('\n')

/** 12:33 真实激活写入的旧版 legacy 块（无 begin/end marker）。 */
const LEGACY_BLOCK = [
  '',
  '# ── Wave 3：砂金·戏浪 桌宠桥（activation by scripts/activate-dsh-bridge.mjs）──',
  '- insert:',
  `    - id: ${BRIDGE_ROW_ID}`,
  '      name: "/repo/work/live-bridge/rev-1794371618691/lib/index.js"',
  '      config:',
  '        dir: "~/.dsh/aventurine-pet"',
  '        launchPet: true',
  '        petAppPath: "/repo/dist/mac-arm64/AventurinePet.app"',
  '        petBundleId: "com.aventurine.pet"'
].join('\n')

/** 激活参数（路径只是示例字符串，纯函数不检查存在性）。 */
const OPTIONS = {
  bridgeEntry: '/repo/work/live-bridge/rev-2000000000000/lib/index.js',
  bridgeDir: '~/.dsh/aventurine-pet',
  petAppPath: '/repo/dist/mac-arm64/AventurinePet.app'
}

/** 从 `--from-default-profile` 初始化出来的 patch（注释 + `[]` 哨兵）。 */
const EMPTY_PROFILE_PATCH = [
  '# Your patch layer for this dsh profile, applied after every bundle layer:',
  '# a top-level YAML array of loader patch entries (id-targeted config',
  '# overrides, disables, and insert lists; `!!js` expressions allowed).',
  '[]'
].join('\n')

describe('inspectBridgeBlock：定位 managed / legacy 块', () => {
  it('空 patch 没有桥块', () => {
    const inspected = inspectBridgeBlock(EMPTY_PROFILE_PATCH)
    expect(inspected.present).toBe(false)
    expect(inspected.style).toBeNull()
    expect(inspected.errors).toEqual([])
    expect(hasBridgeBlock(EMPTY_PROFILE_PATCH)).toBe(false)
  })

  it('识别新版 managed 块（begin/end marker）并给出起止行', () => {
    const text = appendBridgeBlock(OTHER_PATCH, OPTIONS)
    const inspected = inspectBridgeBlock(text)
    expect(inspected.present).toBe(true)
    expect(inspected.style).toBe('managed')
    expect(inspected.errors).toEqual([])
    expect(inspected.startLine).not.toBeNull()
    expect(inspected.endLine).not.toBeNull()
    expect(hasBridgeBlock(text)).toBe(true)
  })

  it('识别 12:33 真实 legacy 块（marker 注释 + insert 块，无 end marker）', () => {
    const inspected = inspectBridgeBlock(`${OTHER_PATCH}\n${LEGACY_BLOCK}`)
    expect(inspected.present).toBe(true)
    expect(inspected.style).toBe('legacy')
    expect(inspected.errors).toEqual([])
    expect(hasBridgeBlock(`${OTHER_PATCH}\n${LEGACY_BLOCK}`)).toBe(true)
  })

  it('坏 marker 边界：begin 无 end / end 无 begin / 顺序颠倒都报错且不算"有桥块"', () => {
    const beginOnly = `${BRIDGE_BLOCK_BEGIN}\n- insert:\n    - id: ${BRIDGE_ROW_ID}\n`
    const beginOnlyResult = inspectBridgeBlock(beginOnly)
    expect(beginOnlyResult.errors.length).toBeGreaterThan(0)
    expect(hasBridgeBlock(beginOnly)).toBe(false)

    const endOnly = `${BRIDGE_BLOCK_END}\n`
    expect(inspectBridgeBlock(endOnly).errors.length).toBeGreaterThan(0)

    const reversed = `${BRIDGE_BLOCK_END}\n- insert:\n    - id: ${BRIDGE_ROW_ID}\n${BRIDGE_BLOCK_BEGIN}\n`
    expect(inspectBridgeBlock(reversed).errors.length).toBeGreaterThan(0)
  })

  it('managed marker 内没有桥行 → 报错（拒绝盲删）', () => {
    const text = `${BRIDGE_BLOCK_BEGIN}\n- insert:\n    - id: other-plugin\n${BRIDGE_BLOCK_END}\n`
    const inspected = inspectBridgeBlock(text)
    expect(inspected.present).toBe(true)
    expect(inspected.errors.some((error: string) => error.includes(BRIDGE_ROW_ID))).toBe(true)
  })
})

describe('appendBridgeBlock：追加 / 替换 / 幂等 / 保留其它行', () => {
  it('空 patch 直接追加：块含 insert/id/name/config 且以换行结尾', () => {
    const text = appendBridgeBlock('', OPTIONS)
    expect(text.startsWith(BRIDGE_BLOCK_BEGIN)).toBe(true)
    expect(text.endsWith(`${BRIDGE_BLOCK_END}\n`)).toBe(true)
    expect(text).toContain('- insert:')
    expect(text).toContain(`- id: ${BRIDGE_ROW_ID}`)
    expect(text).toContain(`name: "${OPTIONS.bridgeEntry}"`)
    expect(text).toContain('      config:')
    expect(text).toContain(`        dir: "${OPTIONS.bridgeDir}"`)
    expect(text).toContain('        launchPet: true')
    expect(text).toContain(`        petAppPath: "${OPTIONS.petAppPath}"`)
    expect(text).toContain('        petBundleId: "com.aventurine.pet"')
  })

  it('`--from-default-profile` 的注释 + `[]` 哨兵：不会把 `[]` 留在数组前面（否则 YAML 非法）', () => {
    const text = appendBridgeBlock(EMPTY_PROFILE_PATCH, OPTIONS)
    expect(text).not.toMatch(/^\[\]\s*$/m)
    // 注释保留、顶层只有一个数组元素
    expect(text).toContain('# Your patch layer for this dsh profile')
    expect(text.match(/^- insert:/gm)).toHaveLength(1)
  })

  it('保留其它 patch 行（webserver 固定端口行逐字保留）', () => {
    const text = appendBridgeBlock(OTHER_PATCH, OPTIONS)
    for (const line of OTHER_PATCH.split('\n')) {
      expect(text).toContain(line)
    }
  })

  it('幂等：append 两次结果完全相同', () => {
    const once = appendBridgeBlock(OTHER_PATCH, OPTIONS)
    const twice = appendBridgeBlock(once, OPTIONS)
    expect(twice).toBe(once)
    expect(once.match(new RegExp(`- id: ${BRIDGE_ROW_ID}`, 'g'))).toHaveLength(1)
  })

  it('传入 legacy 块时被替换为新版 managed 块（不残留旧注释/旧行）', () => {
    const input = `${OTHER_PATCH}\n${LEGACY_BLOCK}\n`
    const text = appendBridgeBlock(input, OPTIONS)
    expect(text).toContain(BRIDGE_BLOCK_BEGIN)
    expect(text).not.toContain('Wave 3：砂金·戏浪')
    expect(text).not.toContain('/repo/work/live-bridge/rev-1794371618691')
    expect(text.match(new RegExp(`- id: ${BRIDGE_ROW_ID}`, 'g'))).toHaveLength(1)
    for (const line of OTHER_PATCH.split('\n')) expect(text).toContain(line)
  })

  it('缺必填字段抛错；特殊字符路径用 JSON 双引号转义（合法 YAML）', () => {
    expect(() => buildBridgeBlock({ bridgeDir: '~/x', petAppPath: '/a' } as never)).toThrow('bridgeEntry')
    const weird = buildBridgeBlock({
      ...OPTIONS,
      bridgeEntry: '/tmp/a "b"\\c/lib/index.js'
    })
    expect(weird).toContain('name: "/tmp/a \\"b\\"\\\\c/lib/index.js"')
  })
})

describe('stripBridgeBlock：只删桥块、保留其它 patch、幂等', () => {
  it('删除新版 managed 块后其它行逐字保留、且不再 hasBridgeBlock', () => {
    const withBridge = appendBridgeBlock(OTHER_PATCH, OPTIONS)
    const stripped = stripBridgeBlock(withBridge)
    expect(stripped.errors).toEqual([])
    expect(stripped.removed).toBe(true)
    expect(stripped.styles).toEqual(['managed'])
    expect(stripped.text).toBe(`${OTHER_PATCH}\n`)
    expect(hasBridgeBlock(stripped.text)).toBe(false)
  })

  it('删除 12:33 legacy 块（marker + 块）后其它行保留', () => {
    const withBridge = `${OTHER_PATCH}\n${LEGACY_BLOCK}\n`
    const stripped = stripBridgeBlock(withBridge)
    expect(stripped.errors).toEqual([])
    expect(stripped.removed).toBe(true)
    expect(stripped.styles).toEqual(['legacy'])
    expect(stripped.text).toBe(`${OTHER_PATCH}\n`)
    expect(stripped.text).not.toContain('Wave 3：砂金·戏浪')
    expect(stripped.text).not.toContain(BRIDGE_ROW_ID)
  })

  it('幂等：重复 strip 不报错、不再变化', () => {
    const once = stripBridgeBlock(`${OTHER_PATCH}\n${LEGACY_BLOCK}\n`).text
    const twice = stripBridgeBlock(once)
    expect(twice.removed).toBe(false)
    expect(twice.text).toBe(once)
  })

  it('只剩桥块时删除后恢复 `[]` 哨兵（patch 仍是合法 YAML 数组）', () => {
    const onlyBridge = `${appendBridgeBlock('', OPTIONS)}`
    const stripped = stripBridgeBlock(onlyBridge)
    expect(stripped.errors).toEqual([])
    expect(stripped.text).toBe('[]\n')

    const withComments = stripBridgeBlock(appendBridgeBlock(EMPTY_PROFILE_PATCH, OPTIONS))
    expect(withComments.text).toContain('# Your patch layer for this dsh profile')
    expect(withComments.text).toContain('[]')
    expect(withComments.text).not.toContain(BRIDGE_ROW_ID)
  })

  it('坏 marker：拒绝删除、原样返回（绝不误删用户 patch）', () => {
    const broken = `${OTHER_PATCH}\n${BRIDGE_BLOCK_BEGIN}\n- insert:\n    - id: ${BRIDGE_ROW_ID}\n`
    const stripped = stripBridgeBlock(broken)
    expect(stripped.errors.length).toBeGreaterThan(0)
    expect(stripped.removed).toBe(false)
    expect(stripped.text).toBe(broken)
  })

  it('无桥块时幂等返回原文本', () => {
    const stripped = stripBridgeBlock(OTHER_PATCH)
    expect(stripped.removed).toBe(false)
    expect(stripped.text).toBe(OTHER_PATCH)
  })

  it('非字符串输入返回结构化错误而不是抛异常', () => {
    expect(() => stripBridgeBlock(null as never)).not.toThrow()
    expect(stripBridgeBlock(null as never).errors.length).toBeGreaterThan(0)
    expect(inspectBridgeBlock(undefined as never).errors.length).toBeGreaterThan(0)
  })
})

describe('checkPatchStructure：PyYAML 不可用时的结构自检（fail-closed）', () => {
  it('正常 patch（其它行 + managed 桥块）通过，legacy 只给 warning', () => {
    const ok = checkPatchStructure(appendBridgeBlock(OTHER_PATCH, OPTIONS))
    expect(ok.ok).toBe(true)
    expect(ok.bridge.style).toBe('managed')

    const legacy = checkPatchStructure(`${OTHER_PATCH}\n${LEGACY_BLOCK}\n`)
    expect(legacy.ok).toBe(true)
    expect(legacy.warnings.some((warning: string) => warning.includes('旧版'))).toBe(true)
  })

  it('空文档 / `[]` 与顶层条目混用 / 顶层不是数组 → 报错', () => {
    expect(checkPatchStructure('').ok).toBe(false)
    expect(checkPatchStructure('# only comments\n').ok).toBe(false)
    expect(checkPatchStructure('[]\n- id: webserver\n').ok).toBe(false)
    expect(checkPatchStructure('name: not-an-array\n').ok).toBe(false)
    expect(checkPatchStructure('[]\n').ok).toBe(true)
  })

  it('桥块重复 / 坏 marker → 报错', () => {
    const duplicated = `${appendBridgeBlock(OTHER_PATCH, OPTIONS)}${appendBridgeBlock('', OPTIONS)}`
    const result = checkPatchStructure(duplicated)
    expect(result.ok).toBe(false)

    const broken = `${OTHER_PATCH}\n${BRIDGE_BLOCK_BEGIN}\n- insert:\n    - id: ${BRIDGE_ROW_ID}\n`
    expect(checkPatchStructure(broken).ok).toBe(false)
  })

  it('孤儿旧版 marker 注释（无 insert 块）只给 warning，不阻断', () => {
    const text = `${OTHER_PATCH}\n# ── Wave 3：砂金·戏浪 桌宠桥（activation by scripts/activate-dsh-bridge.mjs）──\n`
    const result = checkPatchStructure(text)
    expect(result.ok).toBe(true)
    expect(result.warnings.some((warning: string) => warning.includes('标记'))).toBe(true)
  })
})

describe('findBridgeInsertEntry / removeBridgeInsertEntries：YAML 条目级定向操作', () => {
  const bridgeEntry = {
    insert: [{ id: BRIDGE_ROW_ID, name: '/repo/live/lib/index.js', config: { dir: '~/x', launchPet: true } }]
  }
  const entries = [
    { id: 'webserver', name: '@deepseek-ai/dsh-host-webserver', config: { port: 38765 } },
    bridgeEntry,
    { id: 'ui-chat', name: '@deepseek-ai/dsh-client-ui-chat' }
  ]

  it('找到含桥行的顶层 insert 条目', () => {
    expect(findBridgeInsertEntry(entries)).toBe(bridgeEntry)
    expect(findBridgeInsertEntry([{ id: 'x' }, { insert: [{ id: 'other' }] }])).toBeNull()
    expect(findBridgeInsertEntry(null)).toBeNull()
  })

  it('移除桥条目、保留其它条目；如果同一 insert 数组还有其它 row 则保留剩余', () => {
    const removed = removeBridgeInsertEntries(entries)
    expect(removed.removed).toBe(1)
    expect(removed.entries).toEqual([entries[0], entries[2]])

    const mixed = removeBridgeInsertEntries([{ insert: [{ id: BRIDGE_ROW_ID }, { id: 'other' }] }])
    expect(mixed.entries).toEqual([{ insert: [{ id: 'other' }] }])
  })
})

describe('satisfiesDshRangeApprox：激活前预检（只用于 WARNING，null=无法判断）', () => {
  it('支持空格 AND 的比较符范围', () => {
    expect(satisfiesDshRangeApprox('0.2.2-rc.1', '>=0.2.2-rc.1 <0.3.0')).toBe(true)
    expect(satisfiesDshRangeApprox('0.2.2', '>=0.2.2-rc.1 <0.3.0')).toBe(true)
    expect(satisfiesDshRangeApprox('0.2.1', '>=0.2.2-rc.1 <0.3.0')).toBe(false)
    expect(satisfiesDshRangeApprox('0.3.0', '>=0.2.2-rc.1 <0.3.0')).toBe(false)
    // E7：includePrerelease 语义下 0.3.0-rc.1 < 0.3.0 → 满足。
    expect(satisfiesDshRangeApprox('0.3.0-rc.1', '<0.3.0')).toBe(true)
    expect(satisfiesDshRangeApprox('0.2.2-rc.2', '>0.2.2-rc.1')).toBe(true)
  })

  it('不支持的语法/坏版本返回 null（调用方必须降级为 WARNING，不得拒绝激活）', () => {
    expect(satisfiesDshRangeApprox('0.2.2', '^0.2.2')).toBeNull()
    expect(satisfiesDshRangeApprox('0.2.2', '~0.2.2')).toBeNull()
    expect(satisfiesDshRangeApprox('0.2.2', '>=0.2.0 || <0.1.0')).toBeNull()
    expect(satisfiesDshRangeApprox('not-a-version', '>=0.2.2')).toBeNull()
    expect(satisfiesDshRangeApprox('0.2.2', 'banana')).toBeNull()
  })
})
