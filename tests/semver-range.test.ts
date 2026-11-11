/**
 * 单测：环境中立 SemVer 子集（`src/shared/semver-range.ts`，2026-11-11 兼容性安全 v2）。
 *
 * 语义基准 = DSH 版本闸门：`semver.satisfies(version, range, { includePrerelease: true })`。
 * 本文件所有期望值均已用 node-semver 7.7.4 实测核对过（见 plan
 * `docs/pet-dsh-coupling-safety-plan-2026-11-11.md` §3.5）。
 */
import { describe, expect, it } from 'vitest'

import {
  compareSemverStrings,
  compareSemverVersions,
  parseSemverVersion,
  satisfiesSemverRange
} from '../src/shared/semver-range'

describe('parseSemverVersion', () => {
  it('解析完整版本 / prerelease / build metadata（忽略 build）', () => {
    expect(parseSemverVersion('0.2.2-rc.1')).toMatchObject({
      major: 0,
      minor: 2,
      patch: 2,
      prerelease: ['rc', 1]
    })
    expect(parseSemverVersion('1.2.3+build.5')).toMatchObject({
      major: 1,
      minor: 2,
      patch: 3,
      prerelease: null
    })
    expect(parseSemverVersion('  1.0.0  ')).toMatchObject({ major: 1, minor: 0, patch: 0 })
  })

  it('非法输入 → null（绝不抛）', () => {
    for (const value of [undefined, null, 42, {}, [], '', '1.2', '1.2.3.4', 'v1.2.3', 'abc', '>=1.2.3']) {
      expect(parseSemverVersion(value)).toBeNull()
    }
  })
})

describe('compareSemverVersions', () => {
  it('按 semver 优先级比较（release > prerelease；数字 < 字符串；短前缀更小）', () => {
    const ordered = ['1.0.0-alpha', '1.0.0-alpha.1', '1.0.0-alpha.beta', '1.0.0-beta', '1.0.0-rc.1', '1.0.0']
    for (let index = 0; index < ordered.length - 1; index += 1) {
      const left = parseSemverVersion(ordered[index])
      const right = parseSemverVersion(ordered[index + 1])
      expect(left).not.toBeNull()
      expect(right).not.toBeNull()
      if (!left || !right) return
      expect(compareSemverVersions(left, right)).toBe(-1)
      expect(compareSemverVersions(right, left)).toBe(1)
    }
  })

  it('compareSemverStrings 对非法输入返回 null', () => {
    expect(compareSemverStrings('1.0.0', '1.0.0')).toBe(0)
    expect(compareSemverStrings('bad', '1.0.0')).toBeNull()
  })
})

describe('satisfiesSemverRange：DSH 闸门实况范围', () => {
  const range = '>=0.2.2-rc.1 <0.3.0'
  const cases: [string, boolean][] = [
    ['0.2.2-rc.1', true],
    ['0.2.2', true],
    ['0.2.2-rc.2', true],
    ['0.2.2-alpha', false],
    ['0.2.1', false],
    ['0.2.3', true],
    ['0.3.0', false],
    // includePrerelease=true：裸 `<0.3.0` 不排除 0.3.0 的 prerelease。
    ['0.3.0-rc.1', true],
    ['1.0.0', false]
  ]
  it.each(cases)('%s → %s', (version, expected) => {
    expect(satisfiesSemverRange(version, range)).toBe(expected)
  })
})

describe('satisfiesSemverRange：caret / tilde / 通配 / 部分版本', () => {
  const cases: [string, string, boolean][] = [
    // caret（M>0 下界精确；M==0 下界补 -0；上界恒 -0）
    ['0.2.2-rc.1', '^0.2.2', true],
    ['0.2.9', '^0.2.2', true],
    ['0.3.0', '^0.2.2', false],
    ['0.3.0-rc.1', '^0.2.2', false],
    ['1.3.0-rc.1', '^1.2', true],
    ['2.0.0-rc.1', '^1.2', false],
    ['1.0.0-rc.1', '^1.0.0', false],
    ['0.0.3', '^0.0.3', true],
    ['0.0.4', '^0.0.3', false],
    ['0.0.3-rc.1', '^0.0.3', true],
    // tilde（下界不补 -0）
    ['1.2.3', '~1.2.3', true],
    ['1.2.9', '~1.2.3', true],
    ['1.3.0', '~1.2.3', false],
    ['1.3.0-rc.1', '~1.2.3', false],
    ['1.2.3-rc.1', '~1.2.3', false],
    ['1.2.0', '~1.2', true],
    ['1.3.0-rc.1', '~1.2', false],
    ['1.0.0', '~1', true],
    ['1.9.9', '~1', true],
    ['2.0.0', '~1', false],
    ['0.0.3-rc.1', '~0.0.3', false],
    // 通配 / 部分版本（下界补 -0）
    ['1.0.0', '1', true],
    ['1.9.9', '1', true],
    ['2.0.0-rc.1', '1', false],
    ['1.0.0-rc.1', '1', true],
    ['1.2.0-rc.1', '1.2', true],
    ['1.3.0-rc.1', '1.2', false],
    ['1.2.0-rc.1', '=1.2', true],
    ['1.2.0-rc.1', '1.2.x', true],
    ['1.2.0-rc.1', '1.2.*', true],
    ['1.0.0-rc.1', '1.x', true],
    ['2.0.0-rc.1', '1.x', false],
    // 部分版本比较符（node-semver x-range 语义：`>=1.2` → >=1.2.0-0，`<=1.2` → <1.3.0-0）
    ['1.2.0', '>=1.2', true],
    ['1.2.0-rc.1', '>=1.2', true],
    ['1.2.9', '<=1.2', true],
    ['1.3.0', '<=1.2', false],
    ['1.3.0-rc.1', '<=1.2', false],
    ['1.2.0-rc.1', '<=1.2', true],
    ['1.1.9', '<1.2', true],
    ['1.2.0-rc.1', '<1.2', false],
    ['1.2.0', '<1.2', false],
    ['1.2.9', '>1.2', false],
    ['1.3.0-rc.1', '>1.2', true],
    ['1.3.0', '>1.2', true],
    // 完整版本是精确比较（不带 -0）
    ['1.2.3', '1.2.3', true],
    ['1.2.3-rc.1', '1.2.3', false],
    ['1.2.3-rc.1', '=1.2.3', false],
    ['0.2.2-rc.1', '0.2.2', false],
    ['0.2.2-rc.1', '=0.2.2', false],
    // `*` 在 includePrerelease 下匹配一切（含 prerelease）
    ['0.0.0-alpha', '*', true],
    ['1.0.0-rc.1', '*', true]
  ]
  it.each(cases)('%s 是否满足 %s → %s', (version, range, expected) => {
    expect(satisfiesSemverRange(version, range)).toBe(expected)
  })
})

describe('satisfiesSemverRange：hyphen range 与 ||', () => {
  const cases: [string, string, boolean][] = [
    ['1.2.3-rc.1', '1.2.3 - 2.3.4', true],
    ['1.2.3', '1.2.3 - 2.3.4', true],
    ['2.3.4', '1.2.3 - 2.3.4', true],
    ['2.3.4-rc.1', '1.2.3 - 2.3.4', true],
    ['2.3.5', '1.2.3 - 2.3.4', false],
    ['2.3.5-rc.1', '1.2.3 - 2.3.4', false],
    ['2.3.0-rc.1', '1.2.3 - 2.3', true],
    ['2.3.9', '1.2.3 - 2.3', true],
    ['2.4.0-rc.1', '1.2.3 - 2.3', false],
    ['2.5.0-rc.1', '1.2.3 - 2.4', false],
    ['2.1.0', '^1.0.0 || ^2.0.0', true],
    ['3.0.0', '^1.0.0 || ^2.0.0', false],
    ['1.0.0-rc.1', '^1.0.0 || ^2.0.0', false]
  ]
  it.each(cases)('%s 是否满足 %s → %s', (version, range, expected) => {
    expect(satisfiesSemverRange(version, range)).toBe(expected)
  })
})

describe('satisfiesSemverRange：操作符与版本间空格容忍 + 非法输入 = null（不可验证）', () => {
  it.each([
    ['1.2.3', '>= 1.2.3', true],
    ['1.2.4', '>= 1.2.3', true],
    ['1.2.3', '~ 1.2', true],
    ['1.5.0', '~ 1.2', false],
    ['1.0.0', '^ 1.0.0', true]
  ] as [string, string, boolean][])('%s 是否满足 %s → %s', (version, range, expected) => {
    expect(satisfiesSemverRange(version, range)).toBe(expected)
  })

  it('非法范围/版本 → null（消费方必须降级，不得猜兼容）', () => {
    for (const range of ['', '   ', 'workspace:^', '>=', '1.2.3 -', 'not-a-range', '1.2.3 || ']) {
      expect(satisfiesSemverRange('1.2.3', range)).toBeNull()
    }
    expect(satisfiesSemverRange('abc', '>=0.2.2')).toBeNull()
    expect(satisfiesSemverRange('1.2', '>=0.2.2')).toBeNull()
  })
})
