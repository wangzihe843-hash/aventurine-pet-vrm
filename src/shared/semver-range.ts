/**
 * 环境中立 SemVer 子集 —— 桌宠侧兼容判定用（2026-11-11 兼容性安全 v2）。
 *
 * 为什么自己实现而不是引 semver 依赖：
 * - `src/shared/**` 是环境中立纯 TS（不得 import 第三方运行时依赖），且桌宠是独立 Electron 应用，
 *   为一个小用途增加依赖面不划算；
 * - 只需要「判断某个 DSH 版本是否落在桥声明的 `engines.dsh` 范围内」，范围来自我们自己的
 *   bridge 包（已知语法：比较符 / ^ / ~ / 通配 / hyphen），不需要 semver 的全部功能。
 *
 * **语义必须与 DSH 版本闸门一致**：DSH 用
 * `semver.satisfies(runtimeVersion, range, { includePrerelease: true })`
 * （见 dsh-app-boot/lib/index.js 的 `satisfies`）。因此：
 * - prerelease 版本**不排除**，只按 semver 优先级比较（如 `0.3.0-rc.1` 满足裸比较符 `<0.3.0`）；
 * - `^` / `~` / 通配 / 部分版本（`1`、`1.2`）的上界带 `-0` 预发布后缀，且（除 `~` 外）
 *   下界也按需补 `-0`（如 `^0.2.2` → `>=0.2.2-0 <0.3.0-0`，`1.2` → `>=1.2.0-0 <1.3.0-0`），
 *   这样下一版本的 prerelease（`0.3.0-rc.1`）不会误落入 `^0.2.2`，而当前版本的 prerelease
 *   （`0.2.2-rc.1`）能落入 `^0.2.2` —— 与 node-semver `includePrerelease:true` 一致。
 *
 * **适用范围（2026-11-11 verifier D1 收口）**：桥的 `package.json.engines.dsh` 契约上**只允许
 * 裸比较符**（`>= > <= < =` + 完整 semver，如 `>=0.2.2-rc.1 <0.3.0`，由
 * `tests/bridge-plugin.test.ts` 的守卫用例与 README 维护规则约束）。裸比较符在 node-semver
 * 7.x 各小版本间语义稳定；`^` / `~` / 通配 / hyphen 仅作为防御性兜底解析，其边界语义可能随
 * DSH 内嵌 semver 版本变化（例如 7.8.6 的 caret 下界 `-0` 规则与 7.7.x 不同），**不要**把
 * 它们用于桥的 engines 声明。
 *
 * 规则：
 * - 任何解析失败（非法版本 / 非法范围 / 未知语法）→ `null`，表示**不可验证**；
 *   消费方必须降级（不得猜"兼容"或"不兼容"）；具体归为 incompatible 还是 unverified 由
 *   `src/main/desktop/dsh-compat.ts` 决定。
 * - 本文件纯函数、无 IO、无异常（对任意输入返回 null/boolean，绝不 throw）。
 */

/** 解析后的 semver 版本。 */
export interface SemverVersion {
  major: number
  minor: number
  patch: number
  /** 预发布标识（数字标识转 number；无预发布为 null）。 */
  prerelease: (string | number)[] | null
  /** 原始文本（排障用）。 */
  raw: string
}

/** 完整 semver（允许 build metadata `+...`，忽略）。 */
const FULL_VERSION_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/

/** 范围里的部分版本（`1`、`1.2`、`1.2.3`，可带 prerelease；prerelease 只允许完整版本）。 */
const PARTIAL_VERSION_PATTERN = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:-([0-9A-Za-z.-]+))?$/

/** 把 `-` 分隔的 prerelease 文本拆成数字/字符串标识。 */
function parsePrereleaseIdentifiers(text: string): (string | number)[] | null {
  const parts = text.split('.')
  if (parts.length === 0) return null
  const identifiers: (string | number)[] = []
  for (const part of parts) {
    if (part.length === 0) return null
    if (/^\d+$/.test(part)) {
      // semver 数字标识不允许前导零（"01" 非法）；这里宽松处理为数字但保留可比较性。
      identifiers.push(Number(part))
    } else {
      identifiers.push(part)
    }
  }
  return identifiers
}

/** 解析完整 semver 字符串；非法 → null。 */
export function parseSemverVersion(text: unknown): SemverVersion | null {
  if (typeof text !== 'string') return null
  const trimmed = text.trim()
  if (trimmed.length === 0) return null
  const match = FULL_VERSION_PATTERN.exec(trimmed)
  if (!match) return null
  const major = Number(match[1])
  const minor = Number(match[2])
  const patch = Number(match[3])
  if (!Number.isSafeInteger(major) || !Number.isSafeInteger(minor) || !Number.isSafeInteger(patch)) {
    return null
  }
  let prerelease: (string | number)[] | null = null
  if (match[4] !== undefined) {
    prerelease = parsePrereleaseIdentifiers(match[4])
    if (prerelease === null) return null
  }
  return { major, minor, patch, prerelease, raw: trimmed }
}

/** 比较两个已解析版本（semver 优先级）：a<b → 负数，a>b → 正数，相等 → 0。 */
export function compareSemverVersions(a: SemverVersion, b: SemverVersion): number {
  if (a.major !== b.major) return a.major < b.major ? -1 : 1
  if (a.minor !== b.minor) return a.minor < b.minor ? -1 : 1
  if (a.patch !== b.patch) return a.patch < b.patch ? -1 : 1
  const left = a.prerelease
  const right = b.prerelease
  // 无预发布 > 有预发布（1.0.0 > 1.0.0-rc.1）。
  if (left === null && right === null) return 0
  if (left === null) return 1
  if (right === null) return -1
  const length = Math.max(left.length, right.length)
  for (let index = 0; index < length; index += 1) {
    const l = left[index]
    const r = right[index]
    // 短列表是长列表的前缀时，短列表更小（1.0.0-alpha < 1.0.0-alpha.1）。
    if (l === undefined) return -1
    if (r === undefined) return 1
    if (l === r) continue
    if (typeof l === 'number' && typeof r === 'number') return l < r ? -1 : 1
    if (typeof l === 'number') return -1
    if (typeof r === 'number') return 1
    return l < r ? -1 : 1
  }
  return 0
}

/** 便捷比较两个版本字符串；任一非法 → null。 */
export function compareSemverStrings(a: string, b: string): number | null {
  const left = parseSemverVersion(a)
  const right = parseSemverVersion(b)
  if (!left || !right) return null
  return compareSemverVersions(left, right)
}

/** 构造版本对象（内部用；parts 不合法时由调用方保证）。 */
function makeVersion(
  major: number,
  minor: number,
  patch: number,
  prerelease: (string | number)[] | null = null
): SemverVersion {
  return {
    major,
    minor,
    patch,
    prerelease,
    raw: prerelease === null ? `${major}.${minor}.${patch}` : `${major}.${minor}.${patch}-${prerelease.join('.')}`
  }
}

/** `-0` 上界（排除下一版本自身的 prerelease）。 */
const ZERO_PRERELEASE: (string | number)[] = [0]

/** 比较符（内部表示）。 */
interface Comparator {
  op: '>' | '>=' | '<' | '<=' | '='
  version: SemverVersion
}

/** 部分版本解析结果：missingParts 指明省略到哪一级（1=只有 major，2=有 minor，3=完整）。 */
interface PartialVersion {
  version: SemverVersion
  parts: 1 | 2 | 3
}

/** 解析范围中的部分版本（允许前导 v；prerelease 仅完整版本允许）。 */
function parsePartialVersion(text: string): PartialVersion | null {
  const match = PARTIAL_VERSION_PATTERN.exec(text)
  if (!match) return null
  const major = Number(match[1])
  const minor = match[2] === undefined ? null : Number(match[2])
  const patch = match[3] === undefined ? null : Number(match[3])
  if (!Number.isSafeInteger(major)) return null
  if (minor !== null && !Number.isSafeInteger(minor)) return null
  if (patch !== null && !Number.isSafeInteger(patch)) return null
  const prereleaseText = match[4]
  const parts: 1 | 2 | 3 = patch !== null ? 3 : minor !== null ? 2 : 1
  if (prereleaseText !== undefined) {
    if (parts !== 3) return null
    const prerelease = parsePrereleaseIdentifiers(prereleaseText)
    if (prerelease === null) return null
    return { version: makeVersion(major, minor ?? 0, patch ?? 0, prerelease), parts }
  }
  return { version: makeVersion(major, minor ?? 0, patch ?? 0), parts }
}

/** 部分版本的「下一个边界」（用于 x-range / caret / tilde 的上界）。 */
function nextBoundary(partial: PartialVersion, level: 'major' | 'minor'): SemverVersion {
  const { major, minor } = partial.version
  if (level === 'major') return makeVersion(major + 1, 0, 0, ZERO_PRERELEASE)
  return makeVersion(major, minor + 1, 0, ZERO_PRERELEASE)
}

/**
 * 把版本对象的 prerelease 换成 `-0`（includePrerelease 语义下 x-range 下界的"最低预发布"）。
 * 已有 prerelease 的版本原样返回（显式 prerelease 精确匹配）。
 */
function withZeroPrerelease(version: SemverVersion): SemverVersion {
  if (version.prerelease !== null) return version
  return makeVersion(version.major, version.minor, version.patch, ZERO_PRERELEASE)
}

/**
 * 展开单个「不带操作符」的 token：`*` / `1` / `1.2` / `1.2.3` / `1.x` / `1.2.x`。
 *
 * 对齐 node-semver `replaceXRange`（includePrerelease=true）：x-range 的下界补 `-0`、
 * 上界恒为 `-0`；完整版本（3 段）是精确比较。
 */
function expandBareVersionToken(token: string): Comparator[] | null {
  // `*` 在 node-semver 里被移除 → 该分支恒真（includePrerelease 下连 prerelease 都匹配）。
  if (token === '*' || token === 'x' || token === 'X') return []
  // 通配形式：1.x / 1.2.x / 1.*
  const wildcard = /^v?(\d+)(?:\.(\d+|[xX*]))?(?:\.(\d+|[xX*]))?$/.exec(token)
  if (wildcard && /[xX*]/.test(token)) {
    const major = Number(wildcard[1])
    if (!Number.isSafeInteger(major)) return null
    const minorRaw = wildcard[2]
    const patchRaw = wildcard[3]
    const minorWild = minorRaw === undefined || /[xX*]/.test(minorRaw)
    const patchWild = patchRaw === undefined || /[xX*]/.test(patchRaw)
    if (minorWild) {
      // 1.x → >=1.0.0-0 <2.0.0-0
      return [
        { op: '>=', version: makeVersion(major, 0, 0, ZERO_PRERELEASE) },
        { op: '<', version: makeVersion(major + 1, 0, 0, ZERO_PRERELEASE) }
      ]
    }
    const minor = Number(minorRaw)
    if (!Number.isSafeInteger(minor)) return null
    if (patchWild) {
      // 1.2.x → >=1.2.0-0 <1.3.0-0
      return [
        { op: '>=', version: makeVersion(major, minor, 0, ZERO_PRERELEASE) },
        { op: '<', version: makeVersion(major, minor + 1, 0, ZERO_PRERELEASE) }
      ]
    }
    return null
  }
  const partial = parsePartialVersion(token)
  if (!partial) return null
  if (partial.parts === 3) return [{ op: '=', version: partial.version }]
  // 1 / 1.2 → >=1.0.0-0 <2.0.0-0 / >=1.2.0-0 <1.3.0-0
  return [
    { op: '>=', version: withZeroPrerelease(partial.version) },
    { op: '<', version: nextBoundary(partial, partial.parts === 1 ? 'major' : 'minor') }
  ]
}

/**
 * 展开 `^`（caret），对齐 node-semver `replaceCaret`：
 * - `^M` / `^M.m` 的下界在 includePrerelease 下补 `-0`；
 * - `^M.m.p`：M>0 时下界是精确版本（不补 -0），M===0 时下界补 `-0`；
 * - 上界恒为「下一个 breaking 版本」并带 `-0`。
 */
function expandCaretToken(token: string): Comparator[] | null {
  const partial = parsePartialVersion(token)
  if (!partial) return null
  const { major, minor, patch } = partial.version
  if (partial.parts === 1) {
    // ^1 → >=1.0.0-0 <2.0.0-0
    return [
      { op: '>=', version: makeVersion(major, 0, 0, ZERO_PRERELEASE) },
      { op: '<', version: makeVersion(major + 1, 0, 0, ZERO_PRERELEASE) }
    ]
  }
  if (partial.parts === 2) {
    const lower: Comparator = {
      op: '>=',
      version: makeVersion(major, minor, 0, ZERO_PRERELEASE)
    }
    const upper =
      major > 0
        ? makeVersion(major + 1, 0, 0, ZERO_PRERELEASE)
        : makeVersion(0, minor + 1, 0, ZERO_PRERELEASE)
    return [lower, { op: '<', version: upper }]
  }
  // 完整版本：下界保留（有 prerelease 时精确匹配；无 prerelease 时 M===0 才补 -0）。
  const lower: Comparator = {
    op: '>=',
    version:
      partial.version.prerelease === null && major === 0 ? withZeroPrerelease(partial.version) : partial.version
  }
  let upper: SemverVersion
  if (major > 0) upper = makeVersion(major + 1, 0, 0, ZERO_PRERELEASE)
  else if (minor > 0) upper = makeVersion(0, minor + 1, 0, ZERO_PRERELEASE)
  else upper = makeVersion(0, 0, patch + 1, ZERO_PRERELEASE)
  return [lower, { op: '<', version: upper }]
}

/** 展开 `~`（tilde）。 */
function expandTildeToken(token: string): Comparator[] | null {
  const partial = parsePartialVersion(token)
  if (!partial) return null
  const { major, minor } = partial.version
  const lower: Comparator = { op: '>=', version: partial.version }
  if (partial.parts === 1) {
    // ~1 → >=1.0.0 <2.0.0-0
    return [lower, { op: '<', version: makeVersion(major + 1, 0, 0, ZERO_PRERELEASE) }]
  }
  // ~1.2 / ~1.2.3 → >=… <1.3.0-0
  return [lower, { op: '<', version: makeVersion(major, minor + 1, 0, ZERO_PRERELEASE) }]
}

/** 展开带比较符的 token（`>=` / `>` / `<=` / `<` / `=`）。 */
function expandComparatorToken(operator: '>' | '>=' | '<' | '<=' | '=', rest: string): Comparator[] | null {
  const partial = parsePartialVersion(rest)
  if (!partial) return null
  const full = partial.parts === 3
  switch (operator) {
    case '=':
      return full
        ? [{ op: '=', version: partial.version }]
        : [
            { op: '>=', version: withZeroPrerelease(partial.version) },
            { op: '<', version: nextBoundary(partial, partial.parts === 1 ? 'major' : 'minor') }
          ]
    case '>=':
      // >=1.2（部分版本）→ >=1.2.0-0；>=1.2.3（完整）→ 精确比较。
      return [{ op: '>=', version: full ? partial.version : withZeroPrerelease(partial.version) }]
    case '>':
      if (full) return [{ op: '>', version: partial.version }]
      // >1.2 → >=1.3.0-0；>1 → >=2.0.0-0
      return [
        {
          op: '>=',
          version:
            partial.parts === 1
              ? makeVersion(partial.version.major + 1, 0, 0, ZERO_PRERELEASE)
              : makeVersion(partial.version.major, partial.version.minor + 1, 0, ZERO_PRERELEASE)
        }
      ]
    case '<':
      if (full) return [{ op: '<', version: partial.version }]
      // <1.2 → <1.2.0-0；<1 → <1.0.0-0
      return [
        {
          op: '<',
          version:
            partial.parts === 1
              ? makeVersion(partial.version.major, 0, 0, ZERO_PRERELEASE)
              : makeVersion(partial.version.major, partial.version.minor, 0, ZERO_PRERELEASE)
        }
      ]
    case '<=':
      if (full) return [{ op: '<=', version: partial.version }]
      // <=1.2 → <1.3.0-0；<=1 → <2.0.0-0
      return [
        {
          op: '<',
          version: nextBoundary(partial, partial.parts === 1 ? 'major' : 'minor')
        }
      ]
    default:
      return null
  }
}

/** 解析单个比较 token（含操作符 / 裸版本 / 通配）。 */
function expandToken(token: string): Comparator[] | null {
  if (token.length === 0) return null
  if (token === '*' || token === 'x' || token === 'X') return expandBareVersionToken(token)
  if (token.startsWith('^')) return expandCaretToken(token.slice(1))
  if (token.startsWith('~')) return expandTildeToken(token.slice(1))
  // 注意顺序：先长后短，避免 `>=` 被当成 `>` + `=`。
  if (token.startsWith('>=')) return expandComparatorToken('>=', token.slice(2))
  if (token.startsWith('<=')) return expandComparatorToken('<=', token.slice(2))
  if (token.startsWith('>')) return expandComparatorToken('>', token.slice(1))
  if (token.startsWith('<')) return expandComparatorToken('<', token.slice(1))
  if (token.startsWith('=')) return expandComparatorToken('=', token.slice(1))
  return expandBareVersionToken(token)
}

/**
 * hyphen range：`a - b`，对齐 node-semver `hyphenReplace`（includePrerelease=true）：
 * - 下界：无 prerelease 时补 `-0`（1.2.3 → >=1.2.3-0），有 prerelease 时精确；
 * - 上界：完整版本 → `<p+1-0`（2.3.4 → <2.3.5-0）；部分版本 → 下一个边界；有 prerelease → `<=精确`。
 */
function expandHyphenRange(text: string): Comparator[] | null {
  const match = /^(\S+)\s+-\s+(\S+)$/.exec(text)
  if (!match) return null
  const lower = parsePartialVersion(match[1])
  const upper = parsePartialVersion(match[2])
  if (!lower || !upper) return null
  const comparators: Comparator[] = [
    {
      op: '>=',
      version: lower.version.prerelease === null ? withZeroPrerelease(lower.version) : lower.version
    }
  ]
  if (upper.parts === 3) {
    if (upper.version.prerelease !== null) {
      comparators.push({ op: '<=', version: upper.version })
    } else {
      comparators.push({
        op: '<',
        version: makeVersion(upper.version.major, upper.version.minor, upper.version.patch + 1, ZERO_PRERELEASE)
      })
    }
  } else {
    comparators.push({
      op: '<',
      version: nextBoundary(upper, upper.parts === 1 ? 'major' : 'minor')
    })
  }
  return comparators
}

/** 解析一个 `||` 分支；非法 → null。 */
function parseRangeAlternative(text: string): Comparator[] | null {
  const hyphen = expandHyphenRange(text)
  if (hyphen) return hyphen
  // node-semver 容忍操作符与版本之间的空格（`>= 1.2.3`、`~ 1.2`）；先归一化再切 token。
  const normalized = text.replace(/(>=|<=|>|<|=|~|\^)\s+/g, '$1').trim()
  const tokens = normalized.split(/\s+/).filter((token) => token.length > 0)
  if (tokens.length === 0) return null
  const comparators: Comparator[] = []
  for (const token of tokens) {
    const expanded = expandToken(token)
    if (!expanded) return null
    comparators.push(...expanded)
  }
  return comparators
}

/** 单个比较符求值。 */
function testComparator(version: SemverVersion, comparator: Comparator): boolean {
  const delta = compareSemverVersions(version, comparator.version)
  switch (comparator.op) {
    case '>':
      return delta > 0
    case '>=':
      return delta >= 0
    case '<':
      return delta < 0
    case '<=':
      return delta <= 0
    case '=':
      return delta === 0
    default:
      return false
  }
}

/**
 * 判断 `version` 是否满足 `range`。
 *
 * 语义对齐 DSH 闸门：`semver.satisfies(version, range, { includePrerelease: true })`。
 * 支持：`||`、空白分隔比较符集合、比较符（`>` `>=` `<` `<=` `=`）、裸版本 / 部分版本、
 * `*`/`x` 通配、`^`、`~`、hyphen range（`a - b`）。
 *
 * @returns true/false；**null = 版本或范围无法解析（不可验证）**，调用方必须降级。
 */
export function satisfiesSemverRange(version: string, range: string): boolean | null {
  const parsedVersion = parseSemverVersion(version)
  if (!parsedVersion) return null
  if (typeof range !== 'string') return null
  const trimmedRange = range.trim()
  if (trimmedRange.length === 0) return null
  const alternatives = trimmedRange.split('||')
  const parsedAlternatives: Comparator[][] = []
  for (const alternativeText of alternatives) {
    const comparators = parseRangeAlternative(alternativeText.trim())
    if (comparators === null) return null
    parsedAlternatives.push(comparators)
  }
  if (parsedAlternatives.length === 0) return null
  return parsedAlternatives.some((comparators) =>
    comparators.every((comparator) => testComparator(parsedVersion, comparator))
  )
}
