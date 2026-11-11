#!/usr/bin/env node
/**
 * DSH 桌面版桥插件「免重启」激活 / 定向替换 / 定向移除 / 回滚脚本（安全加固版）。
 *
 * 原理（依据 R2 源码审计 + HMR 隔离实测，见 docs/wave3-hmr-activation-verification-2026-11-11.md）：
 * DSH 桌面版默认开启 HMR，profile 的 `cordis.patch.yml` 变化会触发「旧插件 dispose → 新配置
 * apply」，因此追加一条 `insert` 行（name 写插件入口**绝对路径**，无需 pnpm 安装）即可在
 * **不重启 DSH** 的情况下激活桥插件。
 *
 * 2026-11-11 兼容性安全加固（docs/pet-dsh-coupling-safety-plan-2026-11-11.md §5 / 评审 E9/E13/E14）：
 * 1. **live 副本带 engines**：`work/live-bridge/<rev>/package.json` 复制源包 `name`（固定
 *    `dsh-aventurine-bridge`，保证 DSH 版本豁免键稳定）、`version`、`engines`、`type`、`main`。
 *    缺失 `engines.dsh` 视为错误（否则 DSH 的版本闸门在真实安装形态下完全不生效，未来 DSH
 *    升级会把不兼容的旧桥照装不误 —— 评审 E1）。
 * 2. **安装清单**：写 `~/.dsh/aventurine-pet/install.json`（原子 tmp→rename，0600；形状按共享
 *    契约 `DshBridgeInstallManifest`），桥被版本闸门禁用时桌宠仍能静态解释原因（评审 E6）。
 * 3. **YAML 校验 fail-closed**：PyYAML 可用则严格 `yaml.safe_load`（顶层必须是数组）+ 逐项
 *    语义校验；不可用默认**拒绝写入**，`--skip-yaml-check` 才降级为结构自检（评审 E9）。
 * 4. **定向操作**：`--remove` 只删本脚本写入的桥 insert 块（保留固定端口等其它 patch，评审 E14）、
 *    `--replace` = 备份 → 删旧块 → 追加新块 → 两次校验；保留 `--rollback`（整份备份恢复）。
 * 5. **激活前预检**：读 DSH app 版本（Info.plist）+ 桥 `engines.dsh`，不匹配打印醒目 WARNING
 *    （仍允许激活：DSH 会禁用该行继续启动，桌宠 DEGRADED）。
 * 6. **激活后验证**（DSH 在运行时）：轮询 control.json ≤10s，核对 attached / bridgeVersion /
 *    `compat.dshRange`，打印 PASS 或可操作诊断。
 * 7. `--remove`/`--rollback` 会删除 install.json（不留假清单）。
 *
 * 安全设计（保持）：
 * - 默认只操作 `~/.dsh/profiles/<profile>/cordis.patch.yml`（可用 --profile/--home 覆盖）；
 * - 写前强制备份（`cordis.patch.yml.bak-wave3-<ts>`），写后校验失败自动恢复；
 * - `--dry-run` 只打印，不写 profile / 不建 live 副本 / 不写 install.json；
 * - 不重启 / 不终止 DSH，不修改 DSH 安装目录，不安装 npm 包。
 *
 * 用法：
 *   node scripts/activate-dsh-bridge.mjs --pet-app "/abs/Dist/AventurinePet.app"
 *   node scripts/activate-dsh-bridge.mjs --replace --pet-app "/abs/Dist/AventurinePet.app"
 *   node scripts/activate-dsh-bridge.mjs --remove
 *   node scripts/activate-dsh-bridge.mjs --rollback [--backup <path>]
 *   node scripts/activate-dsh-bridge.mjs --dry-run --replace --pet-app …  # 只打印
 *
 * 退出码：0 成功；1 失败（参数/校验/写入）；2 用法错误。
 */
import { spawnSync } from 'node:child_process'
import {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
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
} from './dsh-patch-lib.mjs'
import { parseInstallManifest } from './dsh-canary-lib.mjs'

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = dirname(SCRIPT_DIR)
const SOURCE_BRIDGE_DIR = join(REPO_ROOT, 'bridge', 'dsh-aventurine-bridge')
const SOURCE_BRIDGE_PACKAGE = join(SOURCE_BRIDGE_DIR, 'package.json')
const SOURCE_LIB_DIR = join(SOURCE_BRIDGE_DIR, 'lib')
const LIVE_BRIDGE_ROOT = join(REPO_ROOT, 'work', 'live-bridge')

/** 稳定包名：DSH 版本豁免键（`dsh plugin allow-version <name>@<version>`）依赖它不随 rev 变化。 */
const SOURCE_PACKAGE_NAME = 'dsh-aventurine-bridge'

/** 桌宠 bundle id（写进 patch config 与 install.json）。 */
const PET_BUNDLE_ID = 'com.aventurine.pet'

/** 桥目录默认字面值（写入 patch；桥插件负责展开 `~/`）。 */
const DEFAULT_BRIDGE_DIR_LITERAL = '~/.dsh/aventurine-pet'

/** 备份文件名后缀（与旧脚本兼容：`--rollback` 能找到历史备份）。 */
const BACKUP_SUFFIX = 'bak-wave3-'

/** macOS DeepSeek Harness app 默认位置。 */
const DEFAULT_DSH_APP = '/Applications/DeepSeek Harness.app'

/** 激活后验证轮询上限（毫秒）。 */
const VERIFY_TIMEOUT_MS = 10_000

/** 激活后验证轮询周期（毫秒）。 */
const VERIFY_POLL_MS = 250

/** 激活前预检 / 清单读取 DSH 版本的超时（毫秒）。 */
const DETECT_TIMEOUT_MS = 10_000

/** `python3 -c` 脚本：严格 YAML 解析（保留 `!!js`/`!js` 自定义 tag 不报错），输出 JSON 条目。 */
const PYYAML_LOAD_SCRIPT = `
import sys, json
try:
    import yaml
except Exception as exc:
    sys.stdout.write(json.dumps({"unavailable": True, "error": "PyYAML 不可用: %s" % exc}))
    sys.exit(3)

class BridgePatchLoader(yaml.SafeLoader):
    pass

def _js_tag(loader, tag_suffix, node):
    # DSH profile 允许 !!js 表达式；canary 只需要结构校验，标量直接当字符串，复杂节点给字符串占位。
    try:
        return loader.construct_scalar(node)
    except Exception:
        return "<js-expression>"

BridgePatchLoader.add_multi_constructor("tag:yaml.org,2002:js", _js_tag)
BridgePatchLoader.add_multi_constructor("!js", _js_tag)

text = sys.stdin.read()
try:
    data = yaml.load(text, Loader=BridgePatchLoader)
except Exception as exc:
    sys.stdout.write(json.dumps({"ok": False, "error": "%s: %s" % (type(exc).__name__, exc)}))
    sys.exit(1)
if not isinstance(data, list):
    sys.stdout.write(json.dumps({"ok": False, "error": "YAML 顶层必须是数组（实际得到 %s）" % type(data).__name__}))
    sys.exit(1)
sys.stdout.write(json.dumps({"ok": True, "entries": data}, ensure_ascii=False, default=str))
`

const HELP = `DSH 桌面版桥插件「免重启」激活 / 定向替换 / 移除 / 回滚

用法:
  node scripts/activate-dsh-bridge.mjs --pet-app <path> [--dry-run]
  node scripts/activate-dsh-bridge.mjs --replace --pet-app <path> [--dry-run]
  node scripts/activate-dsh-bridge.mjs --remove [--dry-run]
  node scripts/activate-dsh-bridge.mjs --rollback [--backup <path>] [--dry-run]

模式（互斥；默认 = 首次激活，已存在桥块时会拒绝并提示改用 --replace）:
  --replace           备份 → 定向删除旧桥块 → 追加新块 → 两次 YAML 校验（可重复执行）
  --remove            只删除本脚本写入的桥 insert 块（保留其它 patch），并删除 install.json
  --rollback          用最近一次整份备份恢复 patch（并删除 install.json；备份含桥行时需再 --remove）

选项:
  --pet-app <path>    桌宠 .app 绝对路径（激活/替换必填；不存在则拒绝）
  --profile <name>    DSH profile（默认 desktop）
  --home <path>       DSH_HOME（默认 ~/.dsh）
  --bridge-entry <p>  桥插件入口（默认自动生成 live 副本：<repo>/work/live-bridge/<rev>/lib/index.js）
  --bridge-dir <p>    桥目录（默认 ~/.dsh/aventurine-pet；支持 ~/，相对路径拒绝）
  --dsh-app <path>    预检/清单用的 DSH app 路径（默认 $PET_DSH_APP_PATH 或 /Applications/…）
  --backup <path>     配合 --rollback 指定备份文件
  --skip-yaml-check   PyYAML 不可用时允许降级为结构自检（默认 fail-closed 拒绝写入）
  --dry-run           只打印将要做的事，不写任何文件（含 profile/live 副本/install.json）
  -h, --help

说明:
  - live 副本 package.json 会复制源包 engines.dsh（DSH 版本闸门在真实安装形态下才生效）；
  - 激活后会写 <bridge-dir>/install.json（桌宠在桥被禁用时据此解释原因）；
  - --remove/--rollback 会删除 install.json，避免"桥已不在、清单还在"的假象；
  - HMR 生效需要 ~1-2s；激活后脚本会在 DSH 运行时轮询 control.json ≤10s 验证。
`

/**
 * 解析命令行参数（未知参数直接报错，避免静默跑错模式）。
 * @param {string[]} argv
 */
function parseArgs(argv) {
  const options = {
    petApp: null,
    profile: 'desktop',
    home: null,
    bridgeEntry: null,
    bridgeDir: null,
    dshApp: null,
    rollback: false,
    remove: false,
    replace: false,
    backup: null,
    dryRun: false,
    skipYamlCheck: false,
    help: false
  }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '-h' || arg === '--help') options.help = true
    else if (arg === '--rollback') options.rollback = true
    else if (arg === '--remove') options.remove = true
    else if (arg === '--replace') options.replace = true
    else if (arg === '--dry-run') options.dryRun = true
    else if (arg === '--skip-yaml-check') options.skipYamlCheck = true
    else if (arg.startsWith('-')) {
      const value = argv[index + 1]
      if (value === undefined || value.startsWith('-')) {
        throw new Error(`${arg} 需要一个参数`)
      }
      index += 1
      if (arg === '--pet-app') options.petApp = value
      else if (arg === '--profile') options.profile = value
      else if (arg === '--home') options.home = value
      else if (arg === '--bridge-entry') options.bridgeEntry = value
      else if (arg === '--bridge-dir') options.bridgeDir = value
      else if (arg === '--dsh-app') options.dshApp = value
      else if (arg === '--backup') options.backup = value
      else throw new Error(`未知参数：${arg}`)
    } else {
      throw new Error(`未知参数：${arg}`)
    }
  }
  return options
}

/** 展开 `~` / `~/` 前缀（不 resolve 相对路径）。 */
function expandHome(value) {
  if (typeof value !== 'string') return value
  if (value === '~') return homedir()
  if (value.startsWith('~/')) return join(homedir(), value.slice(2))
  return value
}

/** profile patch 路径。 */
function resolvePatchPath(options) {
  const home = options.home ? expandHome(options.home) : join(homedir(), '.dsh')
  return join(home, 'profiles', options.profile, 'cordis.patch.yml')
}

/** 最近一次备份（按 mtime 倒序；兼容旧版 `bak-wave3-` 命名）。 */
function findLatestBackup(patchPath) {
  const dir = dirname(patchPath)
  const base = patchPath.slice(dir.length + 1)
  const candidates = readdirSync(dir)
    .filter((name) => name.startsWith(`${base}.${BACKUP_SUFFIX}`))
    .map((name) => join(dir, name))
    .filter((path) => {
      try {
        return statSync(path).isFile()
      } catch {
        return false
      }
    })
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)
  return candidates[0] ?? null
}

/** 同步 sleep（Node 无 sleepSync；用 Atomics.wait 阻塞当前线程）。 */
function sleepSync(ms) {
  const shared = new Int32Array(new SharedArrayBuffer(4))
  Atomics.wait(shared, 0, 0, ms)
}

/* ---------------------------------------------------------------------------
 * 严格 YAML 校验（fail-closed）
 * ------------------------------------------------------------------------- */

/** PyYAML 探测结果缓存（一次进程只探一次）。 */
let pyYamlProbeCache = null

/** 「PyYAML 不可用已提示过」标记（同一次运行只提示一次，避免 3 次校验刷屏）。 */
let pyYamlUnavailableWarned = false

/** 探测 python3 + PyYAML 是否可用。 */
function probePyYaml() {
  if (pyYamlProbeCache !== null) return pyYamlProbeCache
  const probe = spawnSync('python3', ['-c', 'import yaml, sys; sys.stdout.write(yaml.__version__)'], {
    encoding: 'utf8',
    timeout: DETECT_TIMEOUT_MS
  })
  if (probe.error || probe.status !== 0) {
    pyYamlProbeCache = {
      available: false,
      version: null,
      error: probe.error ? String(probe.error.message ?? probe.error) : (probe.stderr ?? '').trim() || `python3 退出码 ${probe.status}`
    }
  } else {
    pyYamlProbeCache = { available: true, version: (probe.stdout ?? '').trim(), error: null }
  }
  return pyYamlProbeCache
}

/**
 * 用 PyYAML 严格解析 patch 文本（顶层必须是数组）。
 * @param {string} text
 * @returns {{ available: false, error: string } | { available: true, ok: false, error: string } | { available: true, ok: true, entries: unknown[] }}
 */
function loadPatchYaml(text) {
  const probe = probePyYaml()
  if (!probe.available) return { available: false, error: probe.error }
  const result = spawnSync('python3', ['-c', PYYAML_LOAD_SCRIPT], {
    input: text,
    encoding: 'utf8',
    timeout: 30_000,
    maxBuffer: 32 * 1024 * 1024
  })
  if (result.error) {
    return { available: false, error: String(result.error.message ?? result.error) }
  }
  const stdout = (result.stdout ?? '').trim()
  let parsed = null
  try {
    parsed = stdout === '' ? null : JSON.parse(stdout)
  } catch {
    parsed = null
  }
  if (result.status === 3 || (parsed !== null && parsed.unavailable === true)) {
    return { available: false, error: parsed?.error ?? 'PyYAML 不可用' }
  }
  if (result.status !== 0 || parsed === null || parsed.ok !== true) {
    return {
      available: true,
      ok: false,
      error: parsed?.error ?? ((result.stderr ?? '').trim() || `python3 退出码 ${result.status}`)
    }
  }
  const entries = parsed.entries
  if (!Array.isArray(entries)) return { available: true, ok: false, error: 'PyYAML 解析结果不是数组' }
  return { available: true, ok: true, entries }
}

/**
 * 校验 patch 文本（结构自检 + 严格 YAML + 桥行期望 + 可选其它条目不变断言）。
 *
 * @param {string} text
 * @param {string} label
 * @param {{
 *   requireBridge?: boolean | null,
 *   expectedRow?: { name: string, bridgeDir: string, petAppPath: string, petBundleId: string, launchPet?: boolean } | null,
 *   compareEntries?: unknown[] | null,
 *   skipYamlCheck: boolean,
 *   log?: (line: string) => void
 * }} options
 * @returns {{
 *   ok: boolean,
 *   entries: unknown[] | null,
 *   degraded: boolean,
 *   errors: string[],
 *   bridgeEntry: Record<string, unknown> | null
 * }}
 */
function validatePatchText(text, label, options) {
  const errors = []
  const log = options.log ?? ((line) => console.log(line))
  const structure = checkPatchStructure(text)
  for (const warning of structure.warnings) log(`[activate] 结构提示：${label}：${warning}`)
  if (!structure.ok) {
    return { ok: false, entries: null, degraded: false, errors: structure.errors, bridgeEntry: null }
  }

  const yaml = loadPatchYaml(text)
  if (!yaml.available) {
    if (options.skipYamlCheck) {
      if (!pyYamlUnavailableWarned) {
        pyYamlUnavailableWarned = true
        log(
          `[activate] WARN PyYAML 不可用（${yaml.error}）；按 --skip-yaml-check 降级为结构自检。` +
            '这无法发现缩进/流式语法错误，风险自负。'
        )
      }
      if (typeof options.requireBridge === 'boolean' && options.requireBridge !== structure.bridge.present) {
        errors.push(
          options.requireBridge
            ? `${label} 中未找到桥 insert 块（结构自检）`
            : `${label} 中仍检测到桥 insert 块（结构自检）`
        )
      }
      return { ok: errors.length === 0, entries: null, degraded: true, errors, bridgeEntry: null }
    }
    return {
      ok: false,
      entries: null,
      degraded: false,
      errors: [
        `PyYAML 不可用（${yaml.error}），按 fail-closed 拒绝写入 ${label}。`,
        '  修复方式：安装 PyYAML（如 `python3 -m pip install --user pyyaml`），或加 --skip-yaml-check 明确承担风险。'
      ],
      bridgeEntry: null
    }
  }
  if (!yaml.ok) {
    return {
      ok: false,
      entries: null,
      degraded: false,
      errors: [`${label} YAML 语法/结构校验失败：${yaml.error}`],
      bridgeEntry: null
    }
  }

  const entries = yaml.entries
  const bridgeEntry = findBridgeInsertEntry(entries)
  if (options.requireBridge === true && bridgeEntry === null) {
    errors.push(`${label} 中未找到 id: ${BRIDGE_ROW_ID} 的 insert 行`)
  }
  if (options.requireBridge === false && bridgeEntry !== null) {
    errors.push(`${label} 中仍存在 id: ${BRIDGE_ROW_ID} 的 insert 行（定向删除失败）`)
  }
  if (options.expectedRow !== null && options.expectedRow !== undefined) {
    if (bridgeEntry === null) {
      errors.push(`${label} 中未找到桥 insert 行，无法核对字段`)
    } else {
      errors.push(...checkExpectedRow(bridgeEntry, options.expectedRow))
    }
  }
  if (options.compareEntries !== null && options.compareEntries !== undefined) {
    const before = removeBridgeInsertEntries(options.compareEntries).entries
    const after = removeBridgeInsertEntries(entries).entries
    if (JSON.stringify(before) !== JSON.stringify(after)) {
      errors.push(`${label} 中除桥 insert 行以外的 patch 条目发生了变化（定向操作绝不能改用户其它行）`)
    }
  }
  return { ok: errors.length === 0, entries, degraded: false, errors, bridgeEntry }
}

/** 核对桥 insert 行的字段是否与本次写入值一致。 */
function checkExpectedRow(bridgeEntry, expected) {
  const errors = []
  const insert = bridgeEntry.insert
  const rows = Array.isArray(insert)
    ? insert.filter((row) => row !== null && typeof row === 'object' && row.id === BRIDGE_ROW_ID)
    : []
  if (rows.length !== 1) {
    errors.push(`桥 insert 数组里 id: ${BRIDGE_ROW_ID} 的行数为 ${rows.length}（应为 1）`)
    return errors
  }
  const row = rows[0]
  if (row.name !== expected.name) {
    errors.push(`桥 insert 行 name 应为 ${JSON.stringify(expected.name)}，实际 ${JSON.stringify(row.name)}`)
  }
  const config = row.config !== null && typeof row.config === 'object' ? row.config : {}
  if (config.dir !== expected.bridgeDir) {
    errors.push(`桥 insert 行 config.dir 应为 ${JSON.stringify(expected.bridgeDir)}，实际 ${JSON.stringify(config.dir)}`)
  }
  if (config.petAppPath !== expected.petAppPath) {
    errors.push(
      `桥 insert 行 config.petAppPath 应为 ${JSON.stringify(expected.petAppPath)}，实际 ${JSON.stringify(config.petAppPath)}`
    )
  }
  if (config.petBundleId !== expected.petBundleId) {
    errors.push(
      `桥 insert 行 config.petBundleId 应为 ${JSON.stringify(expected.petBundleId)}，实际 ${JSON.stringify(config.petBundleId)}`
    )
  }
  const expectedLaunch = expected.launchPet !== false
  if (config.launchPet !== expectedLaunch) {
    errors.push(`桥 insert 行 config.launchPet 应为 ${expectedLaunch}，实际 ${JSON.stringify(config.launchPet)}`)
  }
  return errors
}

/* ---------------------------------------------------------------------------
 * 源桥包 / live 副本
 * ------------------------------------------------------------------------- */

/** 读取并校验源桥 `package.json`（engines.dsh 缺失视为错误）。 */
function readSourceBridgePackage() {
  if (!existsSync(SOURCE_BRIDGE_PACKAGE)) {
    throw new Error(`找不到源桥 package.json：${SOURCE_BRIDGE_PACKAGE}`)
  }
  let manifest
  try {
    manifest = JSON.parse(readFileSync(SOURCE_BRIDGE_PACKAGE, 'utf8'))
  } catch (error) {
    throw new Error(`源桥 package.json 不是合法 JSON：${error instanceof Error ? error.message : String(error)}`)
  }
  const engines = manifest.engines
  const dshRange = engines !== null && typeof engines === 'object' ? engines.dsh : undefined
  if (typeof dshRange !== 'string' || dshRange.trim() === '') {
    throw new Error(
      '源桥 package.json 缺少 engines.dsh —— live 副本会丢失 DSH 版本闸门（未来 DSH 升级会禁用/误装旧桥）。' +
        '请先在 bridge/dsh-aventurine-bridge/package.json 补上 engines.dsh。'
    )
  }
  if (typeof manifest.version !== 'string' || manifest.version.trim() === '') {
    throw new Error('源桥 package.json 缺少 version')
  }
  if (manifest.name !== SOURCE_PACKAGE_NAME) {
    console.warn(
      `[activate] WARN 源桥包名 ${JSON.stringify(manifest.name)} 与固定身份 ${JSON.stringify(SOURCE_PACKAGE_NAME)} 不同；` +
        'live 副本将使用固定包名（DSH 版本豁免键稳定），请确认这是有意的。'
    )
  }
  return {
    name: SOURCE_PACKAGE_NAME,
    sourceName: manifest.name,
    version: manifest.version.trim(),
    type: typeof manifest.type === 'string' && manifest.type !== '' ? manifest.type : 'module',
    main: typeof manifest.main === 'string' && manifest.main !== '' ? manifest.main : './lib/index.js',
    engines: { ...engines, dsh: dshRange.trim() },
    dshRange: dshRange.trim()
  }
}

/** 从 constants.js 文本解析桥插件版本 / 控制帧 schema 版本。 */
function parseBridgeConstants(text, label) {
  const versionMatch = /BRIDGE_PLUGIN_VERSION\s*=\s*(\d+)/.exec(text)
  const schemaMatch = /BRIDGE_CONTROL_SCHEMA_VERSION\s*=\s*(\d+)/.exec(text)
  const bridgeVersion = versionMatch ? Number.parseInt(versionMatch[1], 10) : null
  const controlSchema = schemaMatch ? Number.parseInt(schemaMatch[1], 10) : null
  if (bridgeVersion === null || controlSchema === null) {
    throw new Error(`无法从 ${label} 解析 BRIDGE_PLUGIN_VERSION / BRIDGE_CONTROL_SCHEMA_VERSION`)
  }
  return { bridgeVersion, controlSchema }
}

/** 读取源桥 constants.js 的版本（dry-run / --bridge-entry 场景用）。 */
function readSourceBridgeConstants() {
  return parseBridgeConstants(readFileSync(join(SOURCE_LIB_DIR, 'constants.js'), 'utf8'), '源桥 lib/constants.js')
}

/**
 * 清理旧 live 副本（按 mtime 保留最近 keep 个；失败只 warn）。
 *
 * 只应在**新的 patch 写入成功之后**调用：写入前删除旧副本会让"旧 patch 仍指向的入口"
 * 短暂消失（运行中的 DSH HMR 重新加载旧行会 import 失败）。
 *
 * @param {number} keep 保留数量（默认 5）
 * @param {Set<string>} protectedRevs 永不删除的 rev 目录名（当前 patch 引用 + 新入口）
 */
function pruneLiveBridgeCopies(keep = 5, protectedRevs = new Set()) {
  try {
    if (!existsSync(LIVE_BRIDGE_ROOT)) return
    const revs = readdirSync(LIVE_BRIDGE_ROOT)
      .map((name) => join(LIVE_BRIDGE_ROOT, name))
      .filter((path) => {
        try {
          return statSync(path).isDirectory()
        } catch {
          return false
        }
      })
      .filter((path) => !protectedRevs.has(path.slice(LIVE_BRIDGE_ROOT.length + 1)))
      .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)
    for (const stale of revs.slice(keep)) {
      try {
        rmSync(stale, { recursive: true, force: true })
      } catch {
        // 单目录清理失败不影响激活。
      }
    }
  } catch {
    // 清理是尽力而为。
  }
}

/**
 * 生成一份「新模块路径」的桥插件 live 副本（HMR 不会重新求值同一模块路径，必须换路径）。
 *
 * package.json 复制源包的 name/version/engines/type/main（engines.dsh 是 DSH 版本闸门在
 * 真实安装形态下生效的唯一来源；评审 E1），lib/ 目录整份复制。
 *
 * @param {ReturnType<typeof readSourceBridgePackage>} sourcePackage
 * @returns {{
 *   entry: string,
 *   dir: string,
 *   bridgePackageVersion: string,
 *   bridgeVersion: number,
 *   controlSchema: number,
 *   dshRange: string
 * }}
 */
function createLiveBridgeCopy(sourcePackage) {
  const rev = `rev-${Date.now()}`
  const destRoot = join(LIVE_BRIDGE_ROOT, rev)
  const destLibDir = join(destRoot, 'lib')
  mkdirSync(destLibDir, { recursive: true })
  cpSync(SOURCE_LIB_DIR, destLibDir, { recursive: true })
  const destPackage = {
    name: sourcePackage.name,
    version: sourcePackage.version,
    private: true,
    type: sourcePackage.type,
    main: sourcePackage.main,
    engines: sourcePackage.engines
  }
  writeFileSync(join(destRoot, 'package.json'), `${JSON.stringify(destPackage, null, 2)}\n`, 'utf8')
  const constants = parseBridgeConstants(
    readFileSync(join(destLibDir, 'constants.js'), 'utf8'),
    `${destRoot}/lib/constants.js`
  )
  return {
    entry: join(destLibDir, 'index.js'),
    dir: destRoot,
    bridgePackageVersion: sourcePackage.version,
    bridgeVersion: constants.bridgeVersion,
    controlSchema: constants.controlSchema,
    dshRange: sourcePackage.dshRange
  }
}

/**
 * 读取显式 `--bridge-entry` 的桥版本（从入口旁的 constants.js 推断）。
 * @param {string} entry
 * @returns {{ bridgeVersion: number, controlSchema: number }}
 */
function readConstantsNearEntry(entry) {
  const candidates = [
    join(dirname(entry), 'constants.js'),
    join(dirname(dirname(entry)), 'lib', 'constants.js')
  ]
  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue
    try {
      return parseBridgeConstants(readFileSync(candidate, 'utf8'), candidate)
    } catch {
      // 尝试下一个候选。
    }
  }
  throw new Error(
    `无法从 --bridge-entry 推断桥版本：入口旁没有可解析的 lib/constants.js（${entry}）。` +
      '请使用默认 live 副本模式（省略 --bridge-entry）。'
  )
}

/* ---------------------------------------------------------------------------
 * DSH app 版本探测 / 运行状态
 * ------------------------------------------------------------------------- */

/** 从 Info.plist 读取 CFBundleShortVersionString（XML 文本解析；二进制用 plutil 兜底）。 */
function readInfoPlistVersion(plistPath) {
  const raw = readFileSync(plistPath)
  const head = raw.subarray(0, 8).toString('latin1')
  if (!head.startsWith('bplist')) {
    const text = raw.toString('utf8')
    const match = /<key>CFBundleShortVersionString<\/key>\s*<string>([^<]+)<\/string>/.exec(text)
    if (match) return match[1].trim()
    return null
  }
  const result = spawnSync(
    'plutil',
    ['-extract', 'CFBundleShortVersionString', 'raw', '-o', '-', plistPath],
    { encoding: 'utf8', timeout: DETECT_TIMEOUT_MS }
  )
  if (result.error || result.status !== 0) return null
  const version = (result.stdout ?? '').trim()
  return version === '' ? null : version
}

/** 通过 lsappinfo 找到运行中的 DSH app 的 bundle path。 */
function findDshAppFromLsappinfo() {
  const found = spawnSync('lsappinfo', ['find', 'bundleID=com.deepseek.dsh'], {
    encoding: 'utf8',
    timeout: DETECT_TIMEOUT_MS
  })
  const asn = (found.stdout ?? '').trim()
  if (found.error || found.status !== 0 || !asn.startsWith('ASN:')) return null
  const info = spawnSync('lsappinfo', ['info', '-only', 'bundlepath', asn], {
    encoding: 'utf8',
    timeout: DETECT_TIMEOUT_MS
  })
  const match = /bundle path="([^"]+)"/.exec(info.stdout ?? '')
  return match ? match[1] : null
}

/** 通过 mdfind 找 DSH app 路径。 */
function findDshAppFromMdfind() {
  const result = spawnSync('mdfind', ["kMDItemCFBundleIdentifier == 'com.deepseek.dsh'"], {
    encoding: 'utf8',
    timeout: DETECT_TIMEOUT_MS
  })
  if (result.error || result.status !== 0) return null
  const first = (result.stdout ?? '').split('\n').find((line) => line.trim() !== '')
  return first ? first.trim() : null
}

/**
 * 探测 DSH app 版本（Info.plist；失败返回 version:null 不抛）。
 * @param {string | null} explicitApp
 * @returns {{ version: string | null, appPath: string | null, source: string, error?: string }}
 */
function detectDshVersion(explicitApp) {
  const candidates = []
  const push = (value) => {
    if (typeof value === 'string' && value.trim() !== '' && !candidates.includes(value)) candidates.push(value)
  }
  push(explicitApp)
  push(process.env.PET_DSH_APP_PATH)
  push(DEFAULT_DSH_APP)
  push(findDshAppFromLsappinfo())
  push(findDshAppFromMdfind())
  for (const appPath of candidates) {
    const plist = join(appPath, 'Contents', 'Info.plist')
    if (!existsSync(plist)) continue
    try {
      const version = readInfoPlistVersion(plist)
      if (version !== null) {
        return { version, appPath, source: explicitApp === appPath ? 'override' : 'info-plist' }
      }
    } catch {
      // 继续下一个候选。
    }
  }
  return {
    version: null,
    appPath: candidates[0] ?? null,
    source: 'unknown',
    error: '无法从 Info.plist / lsappinfo / mdfind 读取 DSH 版本'
  }
}

/** 读 control.json（半截/脏文件返回 null）。 */
function readControlSnapshot(bridgeDirAbs) {
  try {
    const text = readFileSync(join(bridgeDirAbs, 'control.json'), 'utf8')
    const parsed = JSON.parse(text)
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null
  } catch {
    return null
  }
}

/** 进程是否存活（EPERM 视为存活）。 */
function isPidAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error?.code === 'EPERM'
  }
}

/** DSH 是否在运行（control.dshPid 存活，或 lsappinfo 能找到运行中的 app）。 */
function isDshRunning(bridgeDirAbs) {
  const control = readControlSnapshot(bridgeDirAbs)
  if (control !== null && control.action === 'attached' && isPidAlive(control.dshPid)) return true
  const found = spawnSync('lsappinfo', ['find', 'bundleID=com.deepseek.dsh'], {
    encoding: 'utf8',
    timeout: DETECT_TIMEOUT_MS
  })
  return !found.error && found.status === 0 && (found.stdout ?? '').trim().startsWith('ASN:')
}

/**
 * 激活前预检：DSH 版本 vs 桥 engines.dsh。不匹配只打印醒目 WARNING（仍允许激活）。
 * @param {string | null} dshApp
 * @param {string} dshRange
 * @returns {{ version: string | null, appPath: string | null }}
 */
function precheckDshVersion(dshApp, dshRange) {
  const detected = detectDshVersion(dshApp)
  if (detected.version === null) {
    console.warn('[activate] ⚠️ WARNING 无法读取 DSH app 版本，跳过「桥 engines.dsh」预检。')
    console.warn('[activate]    这不阻止激活；DSH 启动时会用自己的 semver 闸门判定 insert 行是否可用。')
    return { version: null, appPath: detected.appPath }
  }
  const satisfied = satisfiesDshRangeApprox(detected.version, dshRange)
  if (satisfied === true) {
    console.log(
      `[activate] 预检 PASS：DSH ${detected.version}（${detected.appPath ?? '?'}）在桥声明范围 ${dshRange} 内`
    )
  } else if (satisfied === false) {
    console.warn('')
    console.warn('[activate] ⚠️⚠️ WARNING：DSH 版本与桥 engines.dsh 不匹配！')
    console.warn(`[activate]    DSH 当前版本：${detected.version}（${detected.appPath ?? '?'}）`)
    console.warn(`[activate]    桥 engines.dsh：${dshRange}`)
    console.warn('[activate]    后果：DSH 启动时会 disable 该 insert 行（宿主仍可正常打开），')
    console.warn('[activate]          桌宠会进入 DEGRADED（详见 docs/pet-dsh-coupling-runbook.md）。')
    console.warn('[activate]    仍继续本次写入（便于先用新桌宠 + install.json 诊断）；')
    console.warn('[activate]    如需撤销：--remove（只删桥行）或 --rollback。')
    console.warn('')
  } else {
    console.warn(
      `[activate] ⚠️ WARNING 桥声明范围 ${JSON.stringify(dshRange)} 语法超出预检器能力（无法本地判断）；` +
        '继续激活，实际以 DSH 闸门为准。'
    )
  }
  return { version: detected.version, appPath: detected.appPath }
}

/* ---------------------------------------------------------------------------
 * install.json 安装清单
 * ------------------------------------------------------------------------- */

/** 原子写 install.json（0600；目录 0700）。返回最终路径。 */
function writeInstallManifest(bridgeDirAbs, manifest) {
  mkdirSync(bridgeDirAbs, { recursive: true, mode: 0o700 })
  try {
    // 已存在目录不强行 chmod（桥/旧脚本可能已建好），但尽力保持 0700。
    chmodSync(bridgeDirAbs, 0o700)
  } catch {
    // 权限修正失败不影响写清单（目录权限可能由用户管理）。
  }
  const installPath = join(bridgeDirAbs, 'install.json')
  const tmpPath = join(bridgeDirAbs, `.install.json.${process.pid}.${Date.now()}.tmp`)
  const text = `${JSON.stringify(manifest, null, 2)}\n`
  try {
    writeFileSync(tmpPath, text, { encoding: 'utf8', mode: 0o600 })
    renameSync(tmpPath, installPath)
  } catch (error) {
    try {
      unlinkSync(tmpPath)
    } catch {
      // tmp 可能未创建成功。
    }
    throw new Error(`写 install.json 失败：${error instanceof Error ? error.message : String(error)}`)
  }
  const written = parseInstallManifest(readFileSync(installPath, 'utf8'))
  if (written === null) {
    throw new Error(`install.json 写入后自检失败（形状不符合共享契约 DshBridgeInstallManifest）：${installPath}`)
  }
  return installPath
}

/** 删除 install.json（不留假清单；失败返回错误）。 */
function removeInstallManifest(bridgeDirAbs) {
  const installPath = join(bridgeDirAbs, 'install.json')
  if (!existsSync(installPath)) return { removed: false, path: installPath, error: null }
  try {
    unlinkSync(installPath)
    return { removed: true, path: installPath, error: null }
  } catch (error) {
    return {
      removed: false,
      path: installPath,
      error: `删除 install.json 失败：${error instanceof Error ? error.message : String(error)}（请手工删除，避免假清单）`
    }
  }
}

/* ---------------------------------------------------------------------------
 * 激活后验证
 * ------------------------------------------------------------------------- */

/**
 * DSH 在跑时轮询 control.json ≤10s，核对 HMR 是否加载了新桥。
 * @param {{
 *   bridgeDirAbs: string,
 *   baselineTs: number,
 *   expectedBridgeVersion: number,
 *   expectedControlSchema: number,
 *   expectedDshRange: string,
 *   log: (line: string) => void
 * }} input
 * @returns {'pass' | 'warn' | 'skipped'}
 */
function verifyActivation(input) {
  const { bridgeDirAbs, baselineTs, expectedBridgeVersion, expectedControlSchema, expectedDshRange, log } = input
  if (!isDshRunning(bridgeDirAbs)) {
    log('[activate] DSH 未在运行：跳过激活后验证（下次 DSH 启动时按 engines 闸门加载；install.json 已写）。')
    return 'skipped'
  }
  log(`[activate] DSH 在运行：轮询 control.json（≤${Math.round(VERIFY_TIMEOUT_MS / 1000)}s）验证 HMR 生效…`)
  const startedAt = Date.now()
  while (Date.now() - startedAt <= VERIFY_TIMEOUT_MS) {
    const control = readControlSnapshot(bridgeDirAbs)
    const ts = control !== null && typeof control.ts === 'number' ? control.ts : 0
    if (control !== null && control.action === 'attached' && ts > baselineTs) {
      const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1)
      const problems = []
      if (control.schemaVersion !== 1) problems.push(`schemaVersion=${JSON.stringify(control.schemaVersion)}（应为 1）`)
      if (control.bridgeVersion !== expectedBridgeVersion) {
        problems.push(
          `bridgeVersion=${JSON.stringify(control.bridgeVersion)}（期望 ${expectedBridgeVersion}；可能 HMR 仍在加载或入口/副本版本不对）`
        )
      }
      if (!isPidAlive(control.dshPid)) problems.push(`control.dshPid=${JSON.stringify(control.dshPid)} 进程不存活`)
      const compat = control.compat !== null && typeof control.compat === 'object' ? control.compat : null
      if (expectedBridgeVersion >= 4) {
        if (compat === null) {
          problems.push('缺少 compat 块（v4 桥应每帧自述 bridgeVersion/controlSchema/dshRange）')
        } else {
          if (compat.bridgeVersion !== expectedBridgeVersion) {
            problems.push(`compat.bridgeVersion=${JSON.stringify(compat.bridgeVersion)}（期望 ${expectedBridgeVersion}）`)
          }
          if (compat.controlSchema !== expectedControlSchema) {
            problems.push(`compat.controlSchema=${JSON.stringify(compat.controlSchema)}（期望 ${expectedControlSchema}）`)
          }
          if (compat.dshRange !== expectedDshRange) {
            problems.push(`compat.dshRange=${JSON.stringify(compat.dshRange)}（期望 ${JSON.stringify(expectedDshRange)}）`)
          }
        }
      }
      if (problems.length === 0) {
        log(
          `[activate] PASS 桥已 attached（${elapsed}s）：bridgeVersion=${expectedBridgeVersion}，` +
            `compat.dshRange=${JSON.stringify(compat?.dshRange ?? null)}`
        )
        return 'pass'
      }
      log(`[activate] ⚠️ WARN 桥已 attached（${elapsed}s），但验证项未全部通过：`)
      for (const problem of problems) log(`[activate]     - ${problem}`)
      return 'warn'
    }
    sleepSync(VERIFY_POLL_MS)
  }
  log(`[activate] ⚠️ WARN 激活后 ${Math.round(VERIFY_TIMEOUT_MS / 1000)}s 内未观察到新的 attached 帧（control.json）。可能原因：`)
  log('[activate]    1) HMR 时机：再等 1-2s 观察 ' + join(bridgeDirAbs, 'control.json'))
  log('[activate]    2) 被 DSH 版本闸门禁用：DSH 日志应含 `disabling profile plugin row "aventurine-bridge"` 或 `engines.dsh`')
  log('[activate]    3) 桥入口不存在/import 失败；4) DSH 进程刚启动，尚未 apply profile')
  log('[activate]    本次写入已完成（install.json 已写）；如需撤销：--remove 或 --rollback')
  return 'warn'
}

/* ---------------------------------------------------------------------------
 * 主流程
 * ------------------------------------------------------------------------- */

/** 打印错误并返回退出码。 */
function fail(error, code = 1) {
  console.error(`[activate] ERROR ${error instanceof Error ? error.message : String(error)}`)
  return code
}

/** 打印激活成功摘要。 */
function printActivationSummary({ patchPath, backupPath, bridgeEntry, liveCopy, petApp, bridgeDirLiteral, installPath, dryRun }) {
  console.log(
    `${dryRun ? '[activate] DRY-RUN 将追加桥插件 insert 行（未写入）' : '[activate] OK 已追加桥插件 insert 行'}：${patchPath}`
  )
  if (backupPath !== null) console.log(`[activate] 备份：${backupPath}`)
  console.log(`[activate] 桥入口：${bridgeEntry}`)
  if (liveCopy !== null) {
    console.log(`[activate] live 副本：${liveCopy.dir}`)
    console.log(
      `[activate] live package.json：name=${SOURCE_PACKAGE_NAME} version=${liveCopy.bridgePackageVersion} engines.dsh=${JSON.stringify(liveCopy.dshRange)}`
    )
    console.log(`[activate] 桥插件版本：BRIDGE_PLUGIN_VERSION=${liveCopy.bridgeVersion}（control schema=${liveCopy.controlSchema}）`)
  }
  console.log(`[activate] 桌宠 app：${petApp}`)
  console.log(`[activate] 桥目录：${bridgeDirLiteral}${installPath !== null ? `（清单 install.json：${installPath}）` : ''}`)
  if (!dryRun) {
    console.log('[activate] 等待 HMR 生效：旧桥 dispose（detached）→ 新桥 apply（attached），约 1-2s。')
  }
}

/** 主流程。 */
function main() {
  let options
  try {
    options = parseArgs(process.argv.slice(2))
  } catch (error) {
    console.error(`[activate] ${error instanceof Error ? error.message : String(error)}`)
    console.error(HELP)
    return 2
  }
  if (options.help) {
    console.log(HELP)
    return 0
  }

  const modeCount = [options.rollback, options.remove, options.replace].filter(Boolean).length
  if (modeCount > 1) {
    console.error('[activate] ERROR --rollback / --remove / --replace 互斥，只能选一个')
    return 2
  }
  if (options.backup !== null && !options.rollback) {
    console.error('[activate] ERROR --backup 只能与 --rollback 一起使用')
    return 2
  }

  const patchPath = resolvePatchPath(options)
  if (!existsSync(patchPath)) {
    console.error(`[activate] ERROR 找不到 profile patch：${patchPath}`)
    console.error('[activate] 提示：先用 DSH 初始化该 profile（`dsh --profile <name> --from-default-profile headless --dump-config`）。')
    return 1
  }

  /* ---------- 回滚：整份备份恢复 ---------- */
  if (options.rollback) {
    const backup = options.backup ? resolve(expandHome(options.backup)) : findLatestBackup(patchPath)
    if (!backup || !existsSync(backup)) {
      console.error('[activate] ERROR 找不到可回滚的备份（--backup 或先执行 activation）')
      return 1
    }
    const backupText = readFileSync(backup, 'utf8')
    const validation = validatePatchText(backupText, `备份 ${backup}`, {
      requireBridge: null,
      expectedRow: null,
      compareEntries: null,
      skipYamlCheck: options.skipYamlCheck
    })
    if (!validation.ok) {
      console.error('[activate] ERROR 备份文件本身未通过 YAML 校验，拒绝恢复：')
      for (const error of validation.errors) console.error(`  - ${error}`)
      return 1
    }
    if (options.dryRun) {
      console.log(`[activate] DRY-RUN 将用备份恢复：${backup} -> ${patchPath}`)
      const bridgeDirExpanded = expandHome(options.bridgeDir ?? DEFAULT_BRIDGE_DIR_LITERAL)
      const installPath = join(bridgeDirExpanded, 'install.json')
      console.log(`[activate] DRY-RUN 将删除清单（如存在）：${installPath}`)
      return 0
    }
    const backupOfCurrent = `${patchPath}.${BACKUP_SUFFIX}${Date.now()}`
    copyFileSync(patchPath, backupOfCurrent)
    try {
      writeFileSync(patchPath, backupText, 'utf8')
    } catch (error) {
      copyFileSync(backupOfCurrent, patchPath)
      return fail(`写入失败，已恢复原文件：${error instanceof Error ? error.message : String(error)}`)
    }
    const reread = readFileSync(patchPath, 'utf8')
    const recheck = validatePatchText(reread, `${patchPath}（回滚后）`, {
      requireBridge: null,
      expectedRow: null,
      compareEntries: null,
      skipYamlCheck: options.skipYamlCheck
    })
    if (!recheck.ok) {
      copyFileSync(backupOfCurrent, patchPath)
      for (const error of recheck.errors) console.error(`  - ${error}`)
      return fail('回滚后校验失败，已恢复回滚前内容')
    }
    const bridgeDirExpanded = expandHome(options.bridgeDir ?? DEFAULT_BRIDGE_DIR_LITERAL)
    const removed = removeInstallManifest(bridgeDirExpanded)
    console.log(`[activate] OK 已回滚：${patchPath}（来源 ${backup}）`)
    console.log(`[activate] 回滚前备份：${backupOfCurrent}`)
    if (removed.removed) console.log(`[activate] 已删除安装清单：${removed.path}`)
    if (removed.error !== null) return fail(removed.error)
    if (hasBridgeBlock(backupText)) {
      console.warn('[activate] ⚠️ WARN 该备份文件本身含桥 insert 行；install.json 已删除（不留假清单）。')
      console.warn('[activate]    若旧桥仍被加载，请再执行 --remove 定向删除桥行。')
    }
    console.log('[activate] HMR 会 dispose 桥插件并写 detached 控制帧；桌宠随后按强耦合退出。')
    return 0
  }

  /* ---------- 定向移除 ---------- */
  if (options.remove) {
    const current = readFileSync(patchPath, 'utf8')
    const inspected = inspectBridgeBlock(current)
    if (inspected.errors.length > 0) {
      console.error('[activate] ERROR 桥块 marker 异常，拒绝盲删：')
      for (const error of inspected.errors) console.error(`  - ${error}`)
      return 1
    }
    const bridgeDirLiteral = options.bridgeDir ?? DEFAULT_BRIDGE_DIR_LITERAL
    if (!isAbsolute(expandHome(bridgeDirLiteral))) {
      console.error('[activate] ERROR --bridge-dir 必须是绝对路径或以 ~/ 开头')
      return 1
    }
    const bridgeDirExpanded = resolve(expandHome(bridgeDirLiteral))
    const installPath = join(bridgeDirExpanded, 'install.json')
    if (!inspected.present) {
      console.log(`[activate] 未发现桥 insert 块，无需移除：${patchPath}`)
      if (options.dryRun) {
        console.log(`[activate] DRY-RUN 将删除清单（如存在）：${installPath}`)
        return 0
      }
      const removed = removeInstallManifest(bridgeDirExpanded)
      if (removed.removed) console.log(`[activate] 已删除安装清单：${removed.path}`)
      if (removed.error !== null) return fail(removed.error)
      return 0
    }

    const before = validatePatchText(current, `${patchPath}（移除前）`, {
      requireBridge: true,
      expectedRow: null,
      compareEntries: null,
      skipYamlCheck: options.skipYamlCheck
    })
    if (!before.ok) {
      console.error('[activate] ERROR 当前 patch 未通过严格校验，拒绝写入：')
      for (const error of before.errors) console.error(`  - ${error}`)
      return 1
    }
    const stripped = stripBridgeBlock(current)
    if (stripped.errors.length > 0) {
      for (const error of stripped.errors) console.error(`  - ${error}`)
      return fail('定向删除桥块失败（未写入任何文件）')
    }
    const after = validatePatchText(stripped.text, `${patchPath}（移除后）`, {
      requireBridge: false,
      expectedRow: null,
      compareEntries: before.entries,
      skipYamlCheck: options.skipYamlCheck
    })
    if (!after.ok) {
      console.error('[activate] ERROR 移除后校验失败，拒绝写入：')
      for (const error of after.errors) console.error(`  - ${error}`)
      return 1
    }
    const blockText = buildBridgeBlock({
      bridgeEntry: '/placeholder/lib/index.js',
      bridgeDir: bridgeDirLiteral,
      petAppPath: '/placeholder.app'
    })
    const changedLines = blockText.split('\n').length + 1
    if (options.dryRun) {
      console.log(`[activate] DRY-RUN 目标：${patchPath}`)
      console.log(`[activate] 将定向删除桥块（${stripped.styles.join(' + ')}，约 ${changedLines} 行），保留其它 patch 行。`)
      console.log(`[activate] DRY-RUN 将删除清单（如存在）：${installPath}`)
      return 0
    }
    const backupPath = `${patchPath}.${BACKUP_SUFFIX}${Date.now()}`
    copyFileSync(patchPath, backupPath)
    try {
      writeFileSync(patchPath, stripped.text, 'utf8')
    } catch (error) {
      copyFileSync(backupPath, patchPath)
      return fail(`写入失败，已恢复原文件：${error instanceof Error ? error.message : String(error)}`)
    }
    const reread = readFileSync(patchPath, 'utf8')
    const recheck = validatePatchText(reread, `${patchPath}（移除后复核）`, {
      requireBridge: false,
      expectedRow: null,
      compareEntries: before.entries,
      skipYamlCheck: options.skipYamlCheck
    })
    if (!recheck.ok) {
      copyFileSync(backupPath, patchPath)
      for (const error of recheck.errors) console.error(`  - ${error}`)
      return fail('移除后复核失败，已恢复备份')
    }
    const removed = removeInstallManifest(bridgeDirExpanded)
    console.log(`[activate] OK 已定向删除桥 insert 块（${stripped.styles.join(' + ')}）：${patchPath}`)
    console.log(`[activate] 备份：${backupPath}`)
    if (removed.removed) console.log(`[activate] 已删除安装清单：${removed.path}`)
    if (removed.error !== null) return fail(removed.error)
    console.log('[activate] HMR 会 dispose 桥插件并写 detached 控制帧；桌宠随后按强耦合退出。')
    return 0
  }

  /* ---------- 激活 / 定向替换 ---------- */
  const current = readFileSync(patchPath, 'utf8')
  const inspected = inspectBridgeBlock(current)
  if (inspected.errors.length > 0) {
    console.error('[activate] ERROR 桥块 marker 异常，拒绝操作（请人工检查 patch）：')
    for (const error of inspected.errors) console.error(`  - ${error}`)
    return 1
  }
  if (!options.replace && inspected.present) {
    console.error(
      `[activate] ERROR ${patchPath} 已包含 id: ${BRIDGE_ROW_ID}。\n` +
        '  如需更新桥入口：用 --replace（定向替换，保留其它 patch）；\n' +
        '  如需撤销：用 --remove（只删桥行）或 --rollback（整份备份恢复）。'
    )
    return 1
  }
  if (options.replace && !inspected.present) {
    console.log('[activate] 未发现旧桥块，--replace 按首次安装处理。')
  }
  if (!options.petApp) {
    console.error('[activate] ERROR 激活/替换需要 --pet-app <桌宠 .app 绝对路径>')
    return 1
  }
  const petApp = resolve(expandHome(options.petApp))
  if (!existsSync(petApp)) {
    console.error(`[activate] ERROR 桌宠 .app 不存在：${petApp}`)
    return 1
  }

  // 源包校验（engines.dsh 缺失视为错误：live 副本没有它 DSH 闸门在真实形态下不生效）。
  let sourcePackage
  try {
    sourcePackage = readSourceBridgePackage()
  } catch (error) {
    return fail(error)
  }
  const dshRange = sourcePackage.dshRange

  // 桥目录（写进 patch 的字面值；install.json 落到展开后的绝对路径）。
  const bridgeDirLiteral = options.bridgeDir ?? DEFAULT_BRIDGE_DIR_LITERAL
  if (!isAbsolute(expandHome(bridgeDirLiteral))) {
    console.error('[activate] ERROR --bridge-dir 必须是绝对路径或以 ~/ 开头（桥插件按 DSH 进程 cwd 解析相对路径，不可靠）')
    return 1
  }
  const bridgeDirExpanded = resolve(expandHome(bridgeDirLiteral))

  // 预检 DSH 版本 vs 桥 engines.dsh（不匹配只 WARNING，仍允许激活）。
  const precheck = precheckDshVersion(options.dshApp, dshRange)

  let bridgeEntry
  let liveCopy = null
  let bridgeVersion
  let controlSchema
  if (options.bridgeEntry) {
    bridgeEntry = resolve(expandHome(options.bridgeEntry))
    if (!existsSync(bridgeEntry)) {
      console.error(`[activate] ERROR 桥插件入口不存在：${bridgeEntry}`)
      return 1
    }
    try {
      const constants = readConstantsNearEntry(bridgeEntry)
      bridgeVersion = constants.bridgeVersion
      controlSchema = constants.controlSchema
    } catch (error) {
      return fail(error)
    }
  } else if (options.dryRun) {
    // dry-run：不建副本，用源 constants 与一个示意路径做校验/打印。
    const constants = readSourceBridgeConstants()
    bridgeVersion = constants.bridgeVersion
    controlSchema = constants.controlSchema
    bridgeEntry = join(LIVE_BRIDGE_ROOT, `rev-${Date.now()}`, 'lib', 'index.js')
  } else {
    try {
      liveCopy = createLiveBridgeCopy(sourcePackage)
    } catch (error) {
      return fail(error)
    }
    bridgeEntry = liveCopy.entry
    bridgeVersion = liveCopy.bridgeVersion
    controlSchema = liveCopy.controlSchema
    if (!existsSync(bridgeEntry)) {
      return fail(`live 副本入口不存在（可能复制失败）：${bridgeEntry}`)
    }
  }

  const nextText = appendBridgeBlock(current, {
    bridgeEntry,
    bridgeDir: bridgeDirLiteral,
    petAppPath: petApp,
    petBundleId: PET_BUNDLE_ID
  })
  const expectedRow = {
    name: bridgeEntry,
    bridgeDir: bridgeDirLiteral,
    petAppPath: petApp,
    petBundleId: PET_BUNDLE_ID,
    launchPet: true
  }

  const before = validatePatchText(current, `${patchPath}（当前）`, {
    requireBridge: inspected.present,
    expectedRow: null,
    compareEntries: null,
    skipYamlCheck: options.skipYamlCheck
  })
  if (!before.ok) {
    console.error('[activate] ERROR 当前 patch 未通过严格校验，拒绝写入：')
    for (const error of before.errors) console.error(`  - ${error}`)
    return 1
  }
  const after = validatePatchText(nextText, `${patchPath}（追加后）`, {
    requireBridge: true,
    expectedRow,
    compareEntries: before.entries,
    skipYamlCheck: options.skipYamlCheck
  })
  if (!after.ok) {
    console.error('[activate] ERROR 追加后 YAML 校验失败，拒绝写入：')
    for (const error of after.errors) console.error(`  - ${error}`)
    printActivationSummary({
      patchPath,
      backupPath: null,
      bridgeEntry,
      liveCopy,
      petApp,
      bridgeDirLiteral,
      installPath: null,
      dryRun: true
    })
    return 1
  }

  const baselineControl = readControlSnapshot(bridgeDirExpanded)
  const baselineTs = baselineControl !== null && typeof baselineControl.ts === 'number' ? baselineControl.ts : 0

  const installManifest = {
    schemaVersion: 1,
    installedAt: Date.now(),
    installMethod: 'live-copy-insert',
    bridgeEntry,
    bridgePackageName: SOURCE_PACKAGE_NAME,
    bridgePackageVersion: liveCopy !== null ? liveCopy.bridgePackageVersion : sourcePackage.version,
    bridgeVersion,
    controlSchema,
    dshRange,
    dshVersionAtInstall: precheck.version,
    petAppPath: petApp,
    petBundleId: PET_BUNDLE_ID
  }
  if (parseInstallManifest(JSON.stringify(installManifest)) === null) {
    return fail('内部错误：构造的 install.json 不符合共享契约 DshBridgeInstallManifest（不写任何文件）')
  }

  if (options.dryRun) {
    console.log(`[activate] DRY-RUN 目标：${patchPath}`)
    console.log('[activate] 将追加（替换旧块后）：')
    console.log(buildBridgeBlock({ bridgeEntry, bridgeDir: bridgeDirLiteral, petAppPath: petApp, petBundleId: PET_BUNDLE_ID }))
    console.log(`[activate] DRY-RUN 将写入安装清单：${join(bridgeDirExpanded, 'install.json')}`)
    console.log(`[activate] DRY-RUN 将写入内容：${JSON.stringify(installManifest)}`)
    printActivationSummary({
      patchPath,
      backupPath: null,
      bridgeEntry,
      liveCopy,
      petApp,
      bridgeDirLiteral,
      installPath: null,
      dryRun: true
    })
    return 0
  }

  const backupPath = `${patchPath}.${BACKUP_SUFFIX}${Date.now()}`
  copyFileSync(patchPath, backupPath)
  try {
    writeFileSync(patchPath, nextText, 'utf8')
  } catch (error) {
    copyFileSync(backupPath, patchPath)
    return fail(`写入失败，已恢复备份：${error instanceof Error ? error.message : String(error)}`)
  }
  const reread = readFileSync(patchPath, 'utf8')
  const recheck = validatePatchText(reread, `${patchPath}（写入后复核）`, {
    requireBridge: true,
    expectedRow,
    compareEntries: before.entries,
    skipYamlCheck: options.skipYamlCheck
  })
  if (!recheck.ok) {
    copyFileSync(backupPath, patchPath)
    console.error('[activate] ERROR 写入后复核失败，已恢复备份：')
    for (const error of recheck.errors) console.error(`  - ${error}`)
    return 1
  }

  // 写入成功后修剪旧 live 副本（保留最近 5 个；当前新入口永不删除）。
  const protectedRevs = new Set()
  if (bridgeEntry.startsWith(`${LIVE_BRIDGE_ROOT}/`)) {
    const relative = bridgeEntry.slice(LIVE_BRIDGE_ROOT.length + 1)
    protectedRevs.add(relative.split('/')[0])
  }
  pruneLiveBridgeCopies(5, protectedRevs)

  let installPath
  try {
    installPath = writeInstallManifest(bridgeDirExpanded, installManifest)
  } catch (error) {
    console.error(`[activate] ERROR ${error instanceof Error ? error.message : String(error)}`)
    console.error(`[activate] patch 已写入，但安装清单失败；如需撤销：--remove。备份：${backupPath}`)
    return 1
  }

  printActivationSummary({
    patchPath,
    backupPath,
    bridgeEntry,
    liveCopy,
    petApp,
    bridgeDirLiteral,
    installPath,
    dryRun: false
  })
  verifyActivation({
    bridgeDirAbs: bridgeDirExpanded,
    baselineTs,
    expectedBridgeVersion: bridgeVersion,
    expectedControlSchema: controlSchema,
    expectedDshRange: dshRange,
    log: (line) => console.log(line)
  })
  return 0
}

process.exitCode = main()
