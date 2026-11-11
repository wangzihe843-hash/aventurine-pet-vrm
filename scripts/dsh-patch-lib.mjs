/**
 * DSH profile `cordis.patch.yml` 的桥块纯函数库（无 IO、无子进程、无第三方依赖）。
 *
 * 背景（docs/pet-dsh-coupling-safety-plan-2026-11-11.md §5 + 评审 E9/E14）：
 * 激活脚本会向 DSH profile 的 patch 末尾追加一条 `- insert:` 行（absolute path 形式的桥插件）。
 * 旧实现只能整份备份/恢复（`--rollback`），没有"只删桥行、保留其它自定义 patch（如固定端口行）"
 * 的能力；而 DSH 桌面版内置的"禁用第三方插件并恢复"会把整份 patch 备份、bundles 还原成官方模板，
 * 顺带丢掉固定端口等自定义行（E14）。
 *
 * 本库提供**定向**操作所需的纯函数：
 * - `inspectBridgeBlock(text)`：定位本脚本写入的桥块（新版 managed marker 或旧版 legacy 形态）；
 * - `stripBridgeBlock(text)`：只删除桥块（保留其它行、幂等、注释/空行恢复为合法 YAML 根）；
 * - `appendBridgeBlock(text, options)`：先定向删除旧块再追加新块（幂等，`--replace` 直接复用）；
 * - `checkPatchStructure(text)`：不依赖 PyYAML 的结构自检（`--skip-yaml-check` 降级路径用）；
 * - `findBridgeInsertEntry(entries)`：在 PyYAML 解析出的顶层条目里找桥 insert 行（CLI 复核用）；
 * - `satisfiesDshRangeApprox(version, range)`：激活前预检用的**近似** SemVer 范围判断
 *   （仅支持 `>= <= > < =` 空格 AND；`null` = 无法判断，调用方必须降级为 WARNING）。
 *
 * 块形态（激活脚本写入）：
 * ```yaml
 * # >>> aventurine-pet bridge (managed by scripts/activate-dsh-bridge.mjs; do not edit) >>>
 * - insert:
 *     - id: aventurine-bridge
 *       name: "/abs/path/to/work/live-bridge/rev-<ts>/lib/index.js"
 *       config:
 *         dir: "~/.dsh/aventurine-pet"
 *         launchPet: true
 *         petAppPath: "/abs/path/AventurinePet.app"
 *         petBundleId: "com.aventurine.pet"
 * # <<< aventurine-pet bridge (managed by scripts/activate-dsh-bridge.mjs) <<<
 * ```
 * 旧版（12:33 真实激活写入）没有 begin/end marker，只有 `# ── Wave 3：…桥（activation by …）──`
 * 注释 + `- insert:` 块；`inspectBridgeBlock` 同时兼容两种形态（`--replace` 会把旧块升级为新形态）。
 */

/** 桥插件在 profile patch 里的行 id（insert row 的 id；DSH 用它做行级配置覆盖/禁用）。 */
export const BRIDGE_ROW_ID = 'aventurine-bridge'

/** 新版 managed 块起始 marker（行首 `#`，块内第一个顶层条目是 `- insert:`）。 */
export const BRIDGE_BLOCK_BEGIN =
  '# >>> aventurine-pet bridge (managed by scripts/activate-dsh-bridge.mjs; do not edit) >>>'

/** 新版 managed 块结束 marker（必须与 begin 成对出现；缺失则拒绝 strip，避免误删用户 patch）。 */
export const BRIDGE_BLOCK_END =
  '# <<< aventurine-pet bridge (managed by scripts/activate-dsh-bridge.mjs) <<<'

/** 空 patch 的哨兵行（`--from-default-profile` 初始化的 cordis.patch.yml 是注释 + `[]`）。 */
export const EMPTY_ROOT_SENTINEL = '[]'

/** 旧版激活块的 marker 特征（12:33 真实激活写入；同时含脚本名与"桥"字样才认）。 */
const LEGACY_MARKER_HINT = 'activate-dsh-bridge.mjs'

/** 桥行 id 的行内匹配（insert 块里的孩子行：`    - id: aventurine-bridge`）。 */
const BRIDGE_ROW_LINE_RE = new RegExp(`^\\s*-\\s+id:\\s*['"]?${BRIDGE_ROW_ID}['"]?\\s*$`)

/** 顶层 insert 项（YAML 顶层数组的一个元素，必须从列 0 开始）。 */
const TOP_LEVEL_INSERT_RE = /^- insert:\s*$/

/** 顶层数组元素（列 0 的 `- `；用于确定旧版块边界）。 */
const TOP_LEVEL_ITEM_RE = /^- /

/** 顶层 `[]` 哨兵行。 */
const EMPTY_ROOT_LINE_RE = /^\[\]\s*$/

/**
 * 把一个 patch 文本拆成「行数组 + 是否以换行结尾」。
 * 只按 `\n` 拆分；`\r\n` 会被保留在原行尾（strip/append 都不改其它行的换行风格）。
 * @param {string} text
 * @returns {{ lines: string[], finalNewline: boolean }}
 */
function splitPatchLines(text) {
  const finalNewline = text.endsWith('\n')
  const lines = text.split('\n')
  if (finalNewline) lines.pop()
  return { lines, finalNewline }
}

/**
 * 把行数组还原成文本（保留原始是否以换行结尾）。
 * @param {string[]} lines
 * @param {boolean} finalNewline
 * @returns {string}
 */
function joinPatchLines(lines, finalNewline) {
  const body = lines.join('\n')
  if (!finalNewline) return body
  return body.endsWith('\n') ? body : `${body}\n`
}

/** 是否空行（含只有空白字符的行）。 */
function isBlankLine(line) {
  return line.trim() === ''
}

/** 是否 YAML 注释行（列 0 或缩进均可）。 */
function isCommentLine(line) {
  return line.trim().startsWith('#')
}

/** 是否顶层内容行（非空、非注释）。 */
function isTopLevelContentLine(line) {
  return !isBlankLine(line) && !isCommentLine(line) && !/^[ \t]/.test(line)
}

/** 是否旧版激活 marker 注释行（`# ── Wave 3：…桌宠桥（activation by …）──`）。 */
function isLegacyMarkerLine(line) {
  if (!isCommentLine(line)) return false
  const trimmed = line.trim()
  return trimmed.includes(LEGACY_MARKER_HINT) && trimmed.includes('桥')
}

/** 行区间 [from, to) 内是否包含桥 insert 孩子行。 */
function hasBridgeRowLine(lines, from, to) {
  for (let index = from; index < to; index += 1) {
    if (BRIDGE_ROW_LINE_RE.test(lines[index])) return true
  }
  return false
}

/**
 * 定位**旧版**桥块（无 begin/end marker 的 12:33 形态）。
 * 规则：找到顶层 `- insert:` 行 → 向后吞掉缩进/空行 → 内容里必须出现 `- id: aventurine-bridge`；
 * 命中后把标记注释（及它前面一个空行）并入删除范围。
 * @param {string[]} lines
 * @returns {{ style: 'legacy', start: number, endExclusive: number } | null}
 */
function findLegacySpan(lines) {
  for (let index = 0; index < lines.length; index += 1) {
    if (!TOP_LEVEL_INSERT_RE.test(lines[index])) continue
    let cursor = index + 1
    while (cursor < lines.length) {
      const line = lines[cursor]
      if (isBlankLine(line) || /^[ \t]/.test(line)) {
        cursor += 1
        continue
      }
      break
    }
    // cursor 之前的行都属于这个顶层条目（缩进行/空行）。
    if (!hasBridgeRowLine(lines, index + 1, cursor)) {
      index = cursor - 1
      continue
    }
    let start = index
    if (start > 0 && isLegacyMarkerLine(lines[start - 1])) {
      start -= 1
    } else if (start > 1 && isBlankLine(lines[start - 1]) && isLegacyMarkerLine(lines[start - 2])) {
      start -= 2
    }
    return { style: 'legacy', start, endExclusive: cursor }
  }
  return null
}

/**
 * 定位**新版 managed**桥块（begin/end marker）。
 * @param {string[]} lines
 * @returns {{ span: { style: 'managed', start: number, endExclusive: number } | null, errors: string[] }}
 */
function findManagedSpan(lines) {
  const errors = []
  const beginIndex = lines.findIndex((line) => line.trim() === BRIDGE_BLOCK_BEGIN)
  const endIndex = lines.findIndex((line) => line.trim() === BRIDGE_BLOCK_END)
  if (beginIndex < 0 && endIndex < 0) return { span: null, errors }
  if (beginIndex < 0) {
    errors.push(`发现桥块结束 marker（第 ${endIndex + 1} 行）但缺少起始 marker，拒绝定向操作（请人工检查 patch）`)
    return { span: null, errors }
  }
  if (endIndex < 0) {
    errors.push(`桥块起始 marker 存在（第 ${beginIndex + 1} 行）但缺少结束 marker，拒绝定向操作（请人工检查 patch）`)
    return { span: null, errors }
  }
  if (endIndex < beginIndex) {
    errors.push('桥块 marker 顺序颠倒（结束 marker 在起始 marker 之前），拒绝定向操作')
    return { span: null, errors }
  }
  if (!hasBridgeRowLine(lines, beginIndex + 1, endIndex)) {
    errors.push('managed 桥块内没有找到 `- id: aventurine-bridge` 行，拒绝定向操作（块可能被手动改坏）')
  }
  return { span: { style: 'managed', start: beginIndex, endExclusive: endIndex + 1 }, errors }
}

/** 一行是否顶层空数组哨兵。 */
function isEmptyRootLine(line) {
  return EMPTY_ROOT_LINE_RE.test(line)
}

/** 文档里是否还有顶层内容行（注释/空行不算）。 */
function hasTopLevelContent(lines) {
  return lines.some((line) => isTopLevelContentLine(line))
}

/**
 * 在 text 中定位本脚本写入的桥块（新版 managed 优先，其次旧版 legacy）。
 *
 * @param {string} text
 * @returns {{
 *   present: boolean,
 *   style: 'managed' | 'legacy' | null,
 *   startLine: number | null, // 0-based，含
 *   endLine: number | null,   // 0-based，含
 *   errors: string[]
 * }}
 */
export function inspectBridgeBlock(text) {
  const empty = { present: false, style: null, startLine: null, endLine: null, errors: [] }
  if (typeof text !== 'string') {
    return { ...empty, errors: ['patch 内容必须是字符串'] }
  }
  const { lines } = splitPatchLines(text)
  const managed = findManagedSpan(lines)
  const errors = [...managed.errors]
  if (managed.span !== null) {
    return {
      present: true,
      style: 'managed',
      startLine: managed.span.start,
      endLine: managed.span.endExclusive - 1,
      errors
    }
  }
  const legacy = findLegacySpan(lines)
  if (legacy !== null) {
    // 同时存在 managed 缺 end 的坏 marker + legacy 块时，上面 errors 非空；仍然报告 legacy 存在，
    // 让调用方（--remove/--replace）因 errors 拒绝执行，避免"删一半"。
    return {
      present: true,
      style: 'legacy',
      startLine: legacy.start,
      endLine: legacy.endExclusive - 1,
      errors
    }
  }
  return { ...empty, errors }
}

/**
 * 是否包含（可识别的）桥块。坏 marker 一律返回 false（调用方应改用 `inspectBridgeBlock`）。
 * @param {string} text
 * @returns {boolean}
 */
export function hasBridgeBlock(text) {
  const inspected = inspectBridgeBlock(text)
  return inspected.present && inspected.errors.length === 0
}

/**
 * 定向删除桥块（只删本脚本写入的 insert 块，保留其它 patch 行）。
 *
 * 行为：
 * - 旧版/新版形态都能删；同时存在多个可识别块时会全部删除（最多 4 个，防御异常输入死循环）；
 * - 删除块时顺带删除块前的一个空行（避免留下连续空行；幂等）；
 * - 删完后若文档没有任何顶层内容行，补一个 `[]` 哨兵，保证 patch 仍是合法 YAML 数组；
 * - 遇到坏 marker（begin 无 end / end 无 begin / marker 顺序颠倒）→ 不删任何内容，返回 errors。
 *
 * @param {string} text
 * @returns {{ text: string, removed: boolean, styles: string[], errors: string[] }}
 */
export function stripBridgeBlock(text) {
  if (typeof text !== 'string') {
    return { text: '', removed: false, styles: [], errors: ['patch 内容必须是字符串'] }
  }
  let { lines, finalNewline } = splitPatchLines(text)
  const styles = []
  const errors = []

  for (let round = 0; round < 4; round += 1) {
    const managed = findManagedSpan(lines)
    if (managed.errors.length > 0) {
      errors.push(...managed.errors)
      break
    }
    let span = managed.span
    if (span === null) span = findLegacySpan(lines)
    if (span === null) break

    let start = span.start
    if (start > 0 && isBlankLine(lines[start - 1]) && hasTopLevelContent(lines.slice(0, start - 1))) {
      start -= 1
    }
    lines = [...lines.slice(0, start), ...lines.slice(span.endExclusive)]
    styles.push(span.style)
  }

  if (errors.length > 0) {
    return { text, removed: false, styles: [], errors }
  }

  // 删除后没有顶层内容 → 恢复空数组哨兵（`--from-default-profile` 的合法初始形态）。
  if (!hasTopLevelContent(lines)) {
    lines = lines.filter((line) => !isTopLevelContentLine(line) || !isEmptyRootLine(line))
    if (!lines.some((line) => isEmptyRootLine(line))) lines.push(EMPTY_ROOT_SENTINEL)
  }

  const nextText = joinPatchLines(lines, finalNewline)
  return { text: nextText, removed: styles.length > 0, styles, errors: [] }
}

/**
 * 生成桥插件 insert 块文本（不含末尾换行）。
 *
 * @param {{
 *   bridgeEntry: string,
 *   bridgeDir: string,
 *   petAppPath: string,
 *   petBundleId?: string,
 *   launchPet?: boolean
 * }} options
 * @returns {string}
 */
export function buildBridgeBlock(options) {
  const {
    bridgeEntry,
    bridgeDir,
    petAppPath,
    petBundleId = 'com.aventurine.pet',
    launchPet = true
  } = options ?? {}
  const problems = []
  if (typeof bridgeEntry !== 'string' || bridgeEntry.trim() === '') problems.push('bridgeEntry')
  if (typeof bridgeDir !== 'string' || bridgeDir.trim() === '') problems.push('bridgeDir')
  if (typeof petAppPath !== 'string' || petAppPath.trim() === '') problems.push('petAppPath')
  if (typeof petBundleId !== 'string' || petBundleId.trim() === '') problems.push('petBundleId')
  if (problems.length > 0) {
    throw new Error(`buildBridgeBlock 缺少必填字段：${problems.join(', ')}`)
  }
  const yamlString = (value) => JSON.stringify(String(value))
  return [
    BRIDGE_BLOCK_BEGIN,
    '- insert:',
    `    - id: ${BRIDGE_ROW_ID}`,
    `      name: ${yamlString(bridgeEntry)}`,
    '      config:',
    `        dir: ${yamlString(bridgeDir)}`,
    `        launchPet: ${launchPet === false ? 'false' : 'true'}`,
    `        petAppPath: ${yamlString(petAppPath)}`,
    `        petBundleId: ${yamlString(petBundleId)}`,
    BRIDGE_BLOCK_END
  ].join('\n')
}

/**
 * 在 patch 末尾追加桥块（幂等：先定向删除任何旧块/旧版块，再追加新块）。
 *
 * 幂等性：`appendBridgeBlock(appendBridgeBlock(x, o), o) === appendBridgeBlock(x, o)`。
 * 旧 `[]` 空数组哨兵会被移除（否则 `[]` 后接 `- insert:` 是非法 YAML）；注释保留。
 *
 * @param {string} text 现有 patch 文本（可为空）
 * @param {{
 *   bridgeEntry: string,
 *   bridgeDir: string,
 *   petAppPath: string,
 *   petBundleId?: string,
 *   launchPet?: boolean
 * }} options
 * @returns {string} 追加后的完整 patch 文本（以换行结尾）
 */
export function appendBridgeBlock(text, options) {
  const baseText = typeof text === 'string' ? text : ''
  const stripped = stripBridgeBlock(baseText)
  if (stripped.errors.length > 0) {
    throw new Error(`appendBridgeBlock 拒绝在坏 patch 上追加：${stripped.errors.join('；')}`)
  }
  const { lines } = splitPatchLines(stripped.text)
  const kept = lines.filter((line) => !(isTopLevelContentLine(line) && isEmptyRootLine(line)))
  const block = buildBridgeBlock(options)
  const keptText = kept.join('\n')
  if (keptText.trim() === '') {
    return `${block}\n`
  }
  const separator = keptText.endsWith('\n') ? '\n' : '\n\n'
  return `${keptText}${separator}${block}\n`
}

/**
 * 不依赖 PyYAML 的 patch 结构自检（`--skip-yaml-check` 或 PyYAML 不可用时的降级路径）。
 *
 * 只做"明显坏掉"的检查，不替代严格 YAML 解析：
 * - 顶层必须是 YAML 数组（内容行以 `- ` 开头；空文档需 `[]` 哨兵）；
 * - begin/end marker 必须成对；块内必须有桥行；
 * - 不能同时出现 `[]` 哨兵与普通顶层条目；
 * - 桥行不得重复（一个 patch 只允许一个桥 insert）。
 *
 * @param {string} text
 * @returns {{ ok: boolean, errors: string[], warnings: string[], bridge: ReturnType<typeof inspectBridgeBlock> }}
 */
export function checkPatchStructure(text) {
  const errors = []
  const warnings = []
  const bridge = inspectBridgeBlock(text)
  errors.push(...bridge.errors)

  if (typeof text !== 'string') {
    return { ok: false, errors, warnings, bridge }
  }
  const { lines } = splitPatchLines(text)
  const contentLines = lines.filter((line) => isTopLevelContentLine(line))
  const sentinelCount = contentLines.filter((line) => isEmptyRootLine(line)).length
  const itemLines = contentLines.filter((line) => TOP_LEVEL_ITEM_RE.test(line))
  const otherLines = contentLines.filter(
    (line) => !TOP_LEVEL_ITEM_RE.test(line) && !isEmptyRootLine(line)
  )

  if (otherLines.length > 0) {
    const sample = otherLines[0]
    errors.push(`顶层内容行必须以 \`- \` 开头（YAML 数组）或为 \`[]\`：${JSON.stringify(sample.slice(0, 80))}`)
  }
  if (sentinelCount > 0 && itemLines.length > 0) {
    errors.push('patch 同时包含 `[]` 哨兵与顶层条目，不是合法 YAML 数组')
  }
  if (itemLines.length === 0 && sentinelCount === 0) {
    errors.push('patch 没有顶层数组条目也没有 `[]` 哨兵（空文档不是合法 patch 数组）')
  }
  if (itemLines.length === 0 && sentinelCount > 1) {
    errors.push('patch 包含多个 `[]` 哨兵行')
  }
  if (bridge.style === 'legacy') {
    warnings.push('检测到旧版（无 begin/end marker）桥块；建议 --replace 升级为新版 managed 形态')
  } else if (!bridge.present) {
    const orphanMarkers = lines.filter((line) => isLegacyMarkerLine(line)).length
    if (orphanMarkers > 0) {
      warnings.push(
        `发现 ${orphanMarkers} 行旧版激活标记注释，但下方没有可识别的 \`- insert:\` 桥块（可能被手工改坏）`
      )
    }
  }
  if (bridge.present && bridge.errors.length === 0) {
    // 新版/旧版块都要求块内含 insert 桥行（inspect 已查）；这里再校验块首行是顶层 `- insert:`。
    const { lines: inspectLines } = splitPatchLines(text)
    const blockStart = inspectLines[bridge.startLine]
    if (bridge.style === 'managed') {
      const insertLine = inspectLines[bridge.startLine + 1]
      if (insertLine === undefined || !TOP_LEVEL_INSERT_RE.test(insertLine)) {
        errors.push('managed 桥块内第一行必须是顶层 `- insert:`')
      }
    } else if (blockStart !== undefined && isLegacyMarkerLine(blockStart)) {
      const insertLine = inspectLines[bridge.startLine + 1]
      if (insertLine === undefined || !TOP_LEVEL_INSERT_RE.test(insertLine)) {
        errors.push('旧版桥块 marker 之后必须是顶层 `- insert:`')
      }
    }
  }

  const bridgeRowCount = lines.filter((line) => BRIDGE_ROW_LINE_RE.test(line)).length
  if (bridgeRowCount > 1) {
    errors.push(`patch 中桥行 id: ${BRIDGE_ROW_ID} 出现 ${bridgeRowCount} 次（只允许一个 insert 行）`)
  }

  return { ok: errors.length === 0, errors, warnings, bridge }
}

/**
 * 在 PyYAML 解析出的顶层条目（已 JSON 化）里找桥 insert 行。
 * @param {unknown} entries
 * @returns {Record<string, unknown> | null} 含 insert 数组且其中有 id=aventurine-bridge 的**顶层条目**
 */
export function findBridgeInsertEntry(entries) {
  if (!Array.isArray(entries)) return null
  for (const entry of entries) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) continue
    const insert = entry.insert
    if (!Array.isArray(insert)) continue
    for (const row of insert) {
      if (typeof row !== 'object' || row === null || Array.isArray(row)) continue
      if (row.id === BRIDGE_ROW_ID) return entry
    }
  }
  return null
}

/**
 * 从顶层条目里过滤掉桥 insert 行（保留其它 patch 条目原样）。
 * @param {unknown} entries
 * @returns {{ entries: unknown[], removed: number }}
 */
export function removeBridgeInsertEntries(entries) {
  if (!Array.isArray(entries)) return { entries: [], removed: 0 }
  const kept = []
  let removed = 0
  for (const entry of entries) {
    const bridgeEntry = findBridgeInsertEntry([entry])
    if (bridgeEntry !== null) {
      removed += 1
      // 同一个 insert 数组里除桥行外若还有其它 row（手工合并过），只删桥行、保留其余。
      const insertRows = entry.insert.filter(
        (row) => !(typeof row === 'object' && row !== null && !Array.isArray(row) && row.id === BRIDGE_ROW_ID)
      )
      if (insertRows.length > 0) kept.push({ ...entry, insert: insertRows })
      continue
    }
    kept.push(entry)
  }
  return { entries: kept, removed }
}

// ---------------------------------------------------------------------------
// 激活前预检：近似 SemVer 范围判断（只用于打印 WARNING；精确闸门在 DSH 宿主侧）。
// ---------------------------------------------------------------------------

/** 解析 `X.Y.Z[-prerelease]`（不接受 build metadata 之外的宽松语法；失败 null）。 */
function parseVersionApprox(text) {
  if (typeof text !== 'string') return null
  const match = text.trim().match(/^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/)
  if (!match) return null
  return {
    major: Number.parseInt(match[1], 10),
    minor: Number.parseInt(match[2], 10),
    patch: Number.parseInt(match[3], 10),
    prerelease: match[4] ? match[4].split('.') : []
  }
}

/** SemVer prerelease 标识比较（数字按数值、字母按字典序；数字段优先于字母段）。 */
function comparePrereleaseIdentifiers(a, b) {
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const left = a[index]
    const right = b[index]
    if (left === undefined) return -1
    if (right === undefined) return 1
    const leftNumeric = /^\d+$/.test(left)
    const rightNumeric = /^\d+$/.test(right)
    if (leftNumeric && rightNumeric) {
      const diff = Number.parseInt(left, 10) - Number.parseInt(right, 10)
      if (diff !== 0) return diff < 0 ? -1 : 1
    } else if (leftNumeric !== rightNumeric) {
      return leftNumeric ? -1 : 1
    } else if (left !== right) {
      return left < right ? -1 : 1
    }
  }
  return 0
}

/** 比较两个已解析版本（SemVer 2.0 语义，含 prerelease）。 */
function compareVersionsApprox(a, b) {
  for (const key of ['major', 'minor', 'patch']) {
    if (a[key] !== b[key]) return a[key] < b[key] ? -1 : 1
  }
  const aPre = a.prerelease
  const bPre = b.prerelease
  if (aPre.length === 0 && bPre.length === 0) return 0
  if (aPre.length === 0) return 1
  if (bPre.length === 0) return -1
  return comparePrereleaseIdentifiers(aPre, bPre)
}

/**
 * 近似判断 `version` 是否满足空格 AND 的比较符范围（`>= <= > < =` + 裸版本）。
 *
 * **这不是 DSH 闸门的完整实现**：不支持 `||`、`^`、`~`、`*`、hyphen range（遇到返回 null）。
 * 返回 `null` 表示"无法判断"——调用方必须降级为 WARNING，不得据此拒绝激活
 * （精确判定以 DSH 宿主 `semver.satisfies(..., {includePrerelease:true})` 为准）。
 *
 * @param {string} version 版本文本（如 `0.2.2-rc.1`）
 * @param {string} range 范围文本（如 `>=0.2.2-rc.1 <0.3.0`）
 * @returns {boolean | null}
 */
export function satisfiesDshRangeApprox(version, range) {
  const parsedVersion = parseVersionApprox(version)
  if (parsedVersion === null || typeof range !== 'string') return null
  const tokens = range.trim().split(/\s+/).filter((token) => token !== '')
  if (tokens.length === 0) return null
  for (const token of tokens) {
    if (token.includes('||') || token.includes('^') || token.includes('~') || token.includes('*')) {
      return null
    }
    const match = token.match(/^(>=|<=|>|<|=)?(.+)$/)
    if (!match) return null
    const operator = match[1] ?? '='
    const target = parseVersionApprox(match[2])
    if (target === null) return null
    const diff = compareVersionsApprox(parsedVersion, target)
    const ok =
      operator === '>=' ? diff >= 0
        : operator === '<=' ? diff <= 0
          : operator === '>' ? diff > 0
            : operator === '<' ? diff < 0
              : diff === 0
    if (!ok) return false
  }
  return true
}
