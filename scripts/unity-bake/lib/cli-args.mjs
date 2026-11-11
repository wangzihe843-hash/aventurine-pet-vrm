/**
 * 极简 CLI 参数解析（scripts/unity-bake/* CLI 共用）。
 *
 * 纯 ESM、无第三方依赖。支持：
 *   --name value
 *   --name=value
 *   --flag            （boolean 选项）
 *   --flag=false      （boolean 选项显式赋值）
 *   -h                （显式声明的 alias）
 *
 * 约定：未知参数 / 缺少取值 / 重复参数 / boolean 取非法值 → 写入 errors（不抛异常），
 * 由 CLI 打印 usage 后以非 0 退出。
 */

/**
 * @typedef {'string' | 'boolean'} OptionType
 * @typedef {{
 *   type: OptionType,
 *   default?: string | boolean,
 *   alias?: string,
 *   description?: string,
 *   valueHint?: string
 * }} OptionSpec
 */

/**
 * 把 `process.argv.slice(2)` 解析为选项值。
 *
 * @param {readonly string[]} argv
 * @param {Record<string, OptionSpec>} optionSpec
 * @returns {{
 *   values: Record<string, string | boolean>,
 *   errors: string[],
 *   sawHelp: boolean,
 *   provided: Set<string>
 * }}
 */
export function parseCliArgs(argv, optionSpec) {
  /** @type {Record<string, string | boolean>} */
  const values = {}
  /** @type {string[]} */
  const errors = []
  /** @type {Set<string>} */
  const provided = new Set()
  let sawHelp = false

  /** @type {Map<string, string>} */
  const aliasToName = new Map()
  for (const [name, spec] of Object.entries(optionSpec)) {
    if (spec.alias) aliasToName.set(spec.alias, name)
    if (spec.default !== undefined) values[name] = spec.default
  }

  const seen = new Set()
  for (let i = 0; i < argv.length; i += 1) {
    const raw = argv[i]
    if (raw === '--') {
      if (i < argv.length - 1) errors.push(`不支持位置参数：${argv.slice(i + 1).join(' ')}`)
      break
    }
    if (raw === '--help') {
      sawHelp = true
      continue
    }
    let token = null
    if (raw.startsWith('--')) token = raw.slice(2)
    else if (/^-[A-Za-z]$/.test(raw)) token = aliasToName.get(raw.slice(1)) ?? null
    if (token === null) {
      errors.push(`未知参数：${raw}`)
      continue
    }
    if (token === '' || token.startsWith('-')) {
      errors.push(`未知参数：${raw}`)
      continue
    }
    let name = token
    let inlineValue
    const eq = token.indexOf('=')
    if (eq >= 0) {
      name = token.slice(0, eq)
      inlineValue = token.slice(eq + 1)
    }
    const spec = optionSpec[name]
    if (!spec) {
      errors.push(`未知参数：--${name}`)
      continue
    }
    if (seen.has(name)) {
      errors.push(`参数重复：--${name}`)
      continue
    }
    seen.add(name)
    provided.add(name)

    if (spec.type === 'boolean') {
      if (inlineValue !== undefined) {
        if (inlineValue === 'true') values[name] = true
        else if (inlineValue === 'false') values[name] = false
        else errors.push(`参数 --${name} 只接受 true/false（收到 ${inlineValue}）`)
      } else {
        values[name] = true
      }
      continue
    }

    if (inlineValue !== undefined) {
      values[name] = inlineValue
      continue
    }
    const next = argv[i + 1]
    if (next === undefined || next.startsWith('--') || /^-[A-Za-z]$/.test(next)) {
      errors.push(`参数 --${name} 缺少取值`)
      continue
    }
    values[name] = next
    i += 1
  }

  return { values, errors, sawHelp, provided }
}

/**
 * 生成 `--help` 文本。
 *
 * @param {{
 *   command: string,
 *   description: string,
 *   usage?: string,
 *   options: Record<string, OptionSpec>,
 *   footer?: string
 * }} config
 * @returns {string}
 */
export function formatHelp(config) {
  const lines = [config.description, '']
  lines.push(`用法：${config.usage ?? config.command}`)
  lines.push('')
  lines.push('选项：')
  for (const [name, spec] of Object.entries(config.options)) {
    const flags = spec.alias ? `--${name}, -${spec.alias}` : `--${name}`
    const value = spec.type === 'string' ? ` <${spec.valueHint ?? 'value'}>` : ''
    const def =
      spec.default === undefined || spec.default === false
        ? ''
        : `（默认：${spec.default === true ? '开启' : spec.default}）`
    const desc = spec.description ?? ''
    lines.push(`  ${flags}${value}`.padEnd(30) + `${desc}${def}`.trimEnd())
  }
  lines.push(`  --help`.padEnd(30) + '显示本帮助并退出')
  if (config.footer) {
    lines.push('')
    lines.push(config.footer)
  }
  return lines.join('\n') + '\n'
}
