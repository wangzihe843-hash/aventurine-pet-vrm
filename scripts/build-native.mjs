#!/usr/bin/env node
/**
 * 用途（Purpose）
 * ---------------------------------------------------------------------------
 * 编译原生助手（Wave 1 A4 起）：用本机 `swiftc` 把 Swift 源码编译成
 * `native/<name>/.build/<name>` 的 **universal 二进制（arm64 + x86_64）**。
 *
 * 当前目标：
 *   - winlist：`native/winlist/main.swift` → `native/winlist/.build/winlist`
 *     （CGWindowListCopyWindowInfo 窗口枚举助手，供主进程 `pet:windows` 使用）
 *   - dragwindow：预留（Wave 3 C1 实现后在 TARGETS 里补一条即可）
 *
 * 产物不入库（R-30）
 * ---------------------------------------------------------------------------
 *   `.gitignore` 已包含 `native/<name>/.build/` 忽略规则；历史上误提交的
 *   `native/winlist/.build/{winlist,winlist.stamp}` 已用 `git rm --cached` 移出
 *   index（磁盘文件保留）。干净 clone 后先跑本脚本即可重建。
 *
 * 与 dev/build 的接线（C-02）
 * ---------------------------------------------------------------------------
 *   `pnpm dev` 通过 `predev` 先跑本脚本；`pnpm build` 通过 `prebuild` 先跑
 *   `scripts/prebuild.mjs`（本脚本 + 私有资源校验）。因此正常开发流程无需手动
 *   执行；本脚本保持幂等，up-to-date 时只做一次签名/产物校验就退出。
 *
 * universal + 最低系统版本（C-01 / R-08）
 * ---------------------------------------------------------------------------
 *   Electron 44 的 `LSMinimumSystemVersion` 是 13.0。本机 swiftc 6.4.2 **不支持**
 *   `-arch`（unknown argument），因此每个架构单独编译：
 *     swiftc -O -target arm64-apple-macos13.0  -o .build/<name>.arm64  ...
 *     swiftc -O -target x86_64-apple-macos13.0 -o .build/<name>.x86_64 ...
 *   再用 `lipo -create` 合并成 `.build/<name>`，并删除中间 thin 产物。
 *   x86_64 编译可能出现 `libswiftCompatibilityPacks.a` 只有 arm64 的 linker
 *   warning，属已知且不影响产物（兼容包在 macOS 13+ 不需要）。
 *
 * 用法（Usage）
 * ---------------------------------------------------------------------------
 *   node scripts/build-native.mjs            编译（幂等：build signature 一致且
 *                                            产物架构/minos 校验通过才跳过）
 *   node scripts/build-native.mjs --check    校验：存在 + 可执行 + lipo 架构含
 *                                            arm64/x86_64 + 每个架构 slice 的 minos
 *                                            都 === 13.0（Electron 44 最低系统）
 *                                            + 实际运行 `--json`（5s 超时）输出 JSON 数组
 *   node scripts/build-native.mjs --help     显示本帮助
 *
 * 幂等（A4-F06 / R-08）
 * ---------------------------------------------------------------------------
 *   不再只看源码 mtime。每次构建把「源码 sha256 + 本脚本 sha256 + swiftc 版本 +
 *   每架构目标 flags + 编译宿主 platform/arch + 最低 macOS 版本 + 架构列表 + 输出路径」
 *   算成 build signature，写入 `native/<name>/.build/<name>.stamp`。
 *   仅当 stamp 与当前签名一致、产物可执行、且 lipo/minos 校验通过时跳过；否则重编。
 *
 * 退出码：
 *   0  成功 / 已是最新 / --check 通过
 *   1  失败（非 macOS、swiftc 不存在或被拒绝、编译/lipo 报错、--check 发现架构/
 *      minos/运行/输出问题）
 *
 * 注意（Caveats）
 * ---------------------------------------------------------------------------
 *   - 只允许写 `native/<name>/.build/**`；不联网、不安包、不改 package.json。
 *   - 需要 macOS + Xcode Command Line Tools（`swiftc`、`lipo`、`vtool`/`otool`）。
 *   - `resolveSwiftc` 会解析 realpath：未显式设置 `SWIFTC` 时，PATH 上的 swiftc
 *     realpath 必须位于 `/usr/bin/`、`/Library/Developer/CommandLineTools/` 或
 *     `/Applications/Xcode.app/` 下，否则拒绝执行并提示用 `SWIFTC=` 显式覆盖（R-28）。
 *     stamp 里的 signature 是构建缓存指纹，**不是** codesign 签名。
 *   - `--check` 会真的执行助手（`--json`），因此需要当前用户能枚举窗口；无桌面 CI 上
 *     请用存在性检查之外的替代方案（本仓库当前无 CI）。
 *   - 本脚本只做「构建 + 校验」，不负责打包进 .app；打包产物的 nativeResources
 *     映射由 Wave 3 C4 的 electron-builder 配置消费。
 */

import { spawnSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/* ------------------------------- 常量与路径 ------------------------------- */

const SCRIPT_PATH = fileURLToPath(import.meta.url)
const SCRIPT_DIR = path.dirname(SCRIPT_PATH)
const REPO_ROOT = path.resolve(SCRIPT_DIR, '..')

/** Electron 44 的 LSMinimumSystemVersion；所有切片都必须不低于它（C-01）。 */
const MIN_MACOS_VERSION = '13.0'

/** universal 二进制包含的架构；每个架构单独 `-target` 编译再 lipo 合并。 */
const TARGET_ARCHS = ['arm64', 'x86_64']

/** build stamp 格式版本（改 stamp 结构时递增，旧 stamp 自动失效并重编）。 */
const STAMP_FORMAT_VERSION = 2

/** `--check` 实际运行助手的超时（毫秒）。 */
const CHECK_RUN_TIMEOUT_MS = 5000

/** `--check` 捕获输出的上限（字节；winlist 常规输出只有几 KB）。 */
const CHECK_MAX_BUFFER = 8 * 1024 * 1024

/** swiftc / lipo 等工具输出上限（编译器报错可能较长）。 */
const TOOL_MAX_BUFFER = 16 * 1024 * 1024

/** 未显式设置 SWIFTC 时允许的 swiftc realpath 前缀（R-28）。 */
const ALLOWED_SWIFTC_ROOTS = [
  '/usr/bin/',
  '/Library/Developer/CommandLineTools/',
  '/Applications/Xcode.app/'
]

/**
 * 原生助手目标表。
 * frameworks / compileFlags 与源码 import 强相关：winlist 只用 CoreGraphics
 * （不读窗口标题，因此不需要 AppKit，也不需要录屏权限）。
 */
const TARGETS = [
  {
    name: 'winlist',
    source: 'native/winlist/main.swift',
    output: 'native/winlist/.build/winlist',
    frameworks: ['CoreGraphics'],
    /** `--check` 实际执行时传入的参数（助手接受 `--json`，默认行为也是 JSON）。 */
    checkArgs: ['--json']
  }
]

/* --------------------------------- 工具函数 --------------------------------- */

/** 统一失败出口：stderr 一行原因，返回 exit 1（调用方 return 该值）。 */
function fail(message) {
  console.error(`BUILD_NATIVE_FAIL ${message}`)
  return 1
}

/** 把路径转成相对仓库根的形式（日志更短；仓库外路径原样返回）。 */
function toRel(absolutePath) {
  const relative = path.relative(REPO_ROOT, absolutePath)
  return relative.startsWith('..') ? absolutePath : relative
}

/** 读取文件并计算 sha256（十六进制）。 */
function sha256File(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex')
}

/** 计算字符串 sha256（十六进制）。 */
function sha256Text(text) {
  return crypto.createHash('sha256').update(text).digest('hex')
}

/** 目标三件套的绝对路径。 */
function targetPaths(target) {
  return {
    source: path.join(REPO_ROOT, target.source),
    output: path.join(REPO_ROOT, target.output),
    stamp: path.join(
      REPO_ROOT,
      path.dirname(target.output),
      `${path.basename(target.output)}.stamp`
    )
  }
}

/** 每架构编译 flags（签名与 `swiftc` 实参共用，避免两处漂移）。 */
function compileFlags(target, arch) {
  const targetTriple = `${arch}-apple-macos${MIN_MACOS_VERSION}`
  return [
    '-O',
    '-target',
    targetTriple,
    ...(target.frameworks ?? []).flatMap((framework) => ['-framework', framework])
  ]
}

/** 每架构编译实参（`swiftc` 调用；输出 / 源码路径不参与签名比较）。 */
function compileArgs(target, arch, sourcePath, outputPath) {
  return [...compileFlags(target, arch), '-o', outputPath, sourcePath]
}

/** 运行外部工具（统一编码 / buffer）。 */
function runTool(command, args) {
  return spawnSync(command, args, { encoding: 'utf8', maxBuffer: TOOL_MAX_BUFFER })
}

/** 从 PATH 中解析可执行文件（命令名含 `/` 时原样返回）。 */
function findExecutable(command) {
  if (command.includes('/')) return command
  for (const dir of (process.env['PATH'] || '').split(path.delimiter)) {
    if (!dir) continue
    const candidate = path.join(dir, command)
    try {
      fs.accessSync(candidate, fs.constants.X_OK)
      return candidate
    } catch {
      /* 继续找下一个 PATH 目录 */
    }
  }
  return null
}

/**
 * 检查 swiftc 可用性：返回 { path, realPath, version, overridden } 或 { error }。
 * R-28：显式 `SWIFTC=` 视为用户覆盖（只记录 realpath）；否则 realpath 必须在
 * 系统工具链白名单内，避免 PATH 前置的假 swiftc 被静默执行。
 */
function resolveSwiftc() {
  const overridden = Boolean(process.env['SWIFTC'])
  const command = process.env['SWIFTC'] || 'swiftc'

  // R-28（二次复核补强）：先解析路径 + realpath 白名单，**通过后才执行** `--version`。
  // 旧顺序先 spawn 了一个 PATH 上不可信的 swiftc 再校验，恶意 PATH 前置会获得一次执行。
  const executable = findExecutable(command)
  if (!executable) {
    return { error: `swiftc not found in PATH: ${command}` }
  }
  let realPath
  try {
    realPath = fs.realpathSync(executable)
  } catch (error) {
    return {
      error: `cannot resolve realpath of swiftc ${executable}: ${
        error instanceof Error ? error.message : String(error)
      }`
    }
  }

  if (!overridden) {
    const allowed = ALLOWED_SWIFTC_ROOTS.some(
      (root) => realPath === root.slice(0, -1) || realPath.startsWith(root)
    )
    if (!allowed) {
      return {
        error:
          `refusing swiftc resolved from PATH: ${realPath}` +
          `（允许的前缀: ${ALLOWED_SWIFTC_ROOTS.join(', ')}）。` +
          '如果这是你信任的编译器，请显式设置 SWIFTC=/path/to/swiftc 覆盖。'
      }
    }
  }

  const result = runTool(executable, ['--version'])
  if (result.error || result.status !== 0) {
    return {
      error:
        `swiftc not found（执行 \`${executable} --version\` 失败）。` +
        '请安装 Xcode Command Line Tools（xcode-select --install）后重试；' +
        '也可用 SWIFTC=/path/to/swiftc 指定路径。'
    }
  }

  const firstLine =
    (result.stdout || '').split('\n').find((line) => line.trim().length > 0) || command
  return { path: executable, realPath, version: firstLine.trim(), overridden }
}

/** 解析点分版本号（非法返回 null）。 */
function parseVersionTuple(version) {
  if (!/^\d+(\.\d+)*$/.test(version)) return null
  return version.split('.').map((part) => Number(part))
}

/** 比较点分版本号；left > right 返回正数，相等 0，小于负数。 */
function compareVersions(left, right) {
  const a = parseVersionTuple(left)
  const b = parseVersionTuple(right)
  if (!a || !b) throw new Error(`invalid version string: ${left} / ${right}`)
  const length = Math.max(a.length, b.length)
  for (let index = 0; index < length; index += 1) {
    const diff = (a[index] ?? 0) - (b[index] ?? 0)
    if (diff !== 0) return diff
  }
  return 0
}

/** 本机 macOS 版本（`sw_vers -productVersion`；memory 化）。 */
let cachedHostMacosVersion
function hostMacosVersion() {
  if (cachedHostMacosVersion !== undefined) return cachedHostMacosVersion
  const result = runTool('sw_vers', ['-productVersion'])
  if (result.error || result.status !== 0) {
    throw new Error(
      `cannot determine host macOS version via \`sw_vers -productVersion\`: ${
        result.error?.message || (result.stderr || '').trim() || `exit ${result.status}`
      }`
    )
  }
  const version = (result.stdout || '').trim()
  if (!parseVersionTuple(version)) {
    throw new Error(`unexpected \`sw_vers -productVersion\` output: ${JSON.stringify(version)}`)
  }
  cachedHostMacosVersion = version
  return version
}

/** 读取 Mach-O 架构列表（优先 `lipo -archs`，旧工具链回退 `lipo -info`）。 */
function lipoArchs(filePath) {
  const archsResult = runTool('lipo', ['-archs', filePath])
  if (!archsResult.error && archsResult.status === 0) {
    const archs = (archsResult.stdout || '').trim().split(/\s+/).filter(Boolean)
    if (archs.length > 0) return archs
  }

  const infoResult = runTool('lipo', ['-info', filePath])
  if (infoResult.error) throw new Error(`lipo not available: ${infoResult.error.message}`)
  if (infoResult.status !== 0) {
    throw new Error(`lipo -info failed: ${(infoResult.stderr || '').trim()}`)
  }
  const match = /(?:architecture|are):\s*(.+)$/m.exec(infoResult.stdout || '')
  if (!match) {
    throw new Error(`cannot parse lipo -info output: ${JSON.stringify((infoResult.stdout || '').trim())}`)
  }
  return match[1].trim().split(/\s+/).filter(Boolean)
}

/** 从 vtool / otool 文本中收集 minos（可能多个架构各一段）。 */
function collectMinosVersions(text) {
  const versions = []
  const patterns = [
    /LC_BUILD_VERSION\b[\s\S]*?\n\s*minos\s+(\d+(?:\.\d+)*)/g,
    /LC_VERSION_MIN_MACOSX\b[\s\S]*?\n\s*version\s+(\d+(?:\.\d+)*)/g
  ]
  for (const pattern of patterns) {
    let match
    while ((match = pattern.exec(text)) !== null) versions.push(match[1])
  }
  return [...new Set(versions)]
}

/** 读取二进制的最低 macOS 版本（优先 `vtool -show-build`，回退 `otool -l`）。 */
function readMinos(filePath) {
  const vtoolResult = runTool('vtool', ['-show-build', filePath])
  if (!vtoolResult.error && vtoolResult.status === 0) {
    const versions = collectMinosVersions(vtoolResult.stdout || '')
    if (versions.length > 0) return versions
  }

  const otoolResult = runTool('otool', ['-l', filePath])
  if (otoolResult.error) throw new Error(`otool not available: ${otoolResult.error.message}`)
  if (otoolResult.status !== 0) {
    throw new Error(`otool -l failed: ${(otoolResult.stderr || '').trim()}`)
  }
  const versions = collectMinosVersions(otoolResult.stdout || '')
  if (versions.length === 0) {
    throw new Error('no LC_BUILD_VERSION / LC_VERSION_MIN_MACOSX minos found in Mach-O')
  }
  return versions
}

/**
 * 校验产物是 universal 且**每个架构 slice 的 minos 都等于** `MIN_MACOS_VERSION`（13.0）。
 *
 * 为什么上界也必须卡 13.0（二次复核 P2）：Electron 44 的 `LSMinimumSystemVersion` 是 13.0，
 * helper 必须在 macOS 13 上可执行。若只校验「minos ≤ 本机 macOS」（旧实现），在 macOS 27
 * 开发机上，universal 但 minos 14.0/27.0 的产物会被 --check 误判为通过（假绿），
 * 挡不住 C-01 那类「minos 过高 → 老系统 Bad CPU type / dyld 拒绝」的回归。
 * 本脚本 `compileFlags` 固定 `-target <arch>-apple-macos13.0`，正常构建必然等于 13.0。
 *
 * 失败抛错（调用方决定是重编还是 --check 失败）；成功返回 { archs, minos, hostVersion }。
 */
function inspectArtifact(outputPath) {
  const archs = lipoArchs(outputPath)
  const missingArchs = TARGET_ARCHS.filter((arch) => !archs.includes(arch))
  if (missingArchs.length > 0) {
    throw new Error(
      `missing architecture(s): ${missingArchs.join(', ')}（实际: ${archs.join(', ')}；` +
        '需要 universal arm64+x86_64）'
    )
  }

  const minosVersions = readMinos(outputPath)
  const hostVersion = hostMacosVersion()
  // 注：`readMinos` 返回去重后的 minos 值集合；两 slice 同为 13.0 时只出现一次。
  // mixed-slice（如 arm64 13.0 + x86_64 27.0）会得到两个不同值，27.0 在下面被拒绝；
  // 任一 slice 的 minos ≠ 13.0 都会失败。这里逐值校验即可。
  for (const minos of minosVersions) {
    const comparison = compareVersions(minos, MIN_MACOS_VERSION)
    if (comparison < 0) {
      throw new Error(`minos ${minos} < required ${MIN_MACOS_VERSION}`)
    }
    if (comparison > 0) {
      throw new Error(
        `minos ${minos} > max supported ${MIN_MACOS_VERSION}（每个架构都必须用 ` +
          `-target <arch>-apple-macos${MIN_MACOS_VERSION} 编译；host macOS ${hostVersion} 不能作为上界）`
      )
    }
  }
  return { archs, minos: minosVersions, hostVersion }
}

/** 计算 build signature 及可落盘的明细（A4-F06 / R-08）。 */
function signatureDetails(target, swiftc) {
  const paths = targetPaths(target)
  const sourceSha256 = sha256File(paths.source)
  const scriptSha256 = sha256File(SCRIPT_PATH)
  const archs = [...TARGET_ARCHS].sort()
  const flagsByArch = Object.fromEntries(
    archs.map((arch) => [arch, compileFlags(target, arch)])
  )
  const signature = sha256Text(
    JSON.stringify({
      format: STAMP_FORMAT_VERSION,
      target: target.name,
      sourceSha256,
      scriptSha256,
      swiftc: swiftc.version,
      platform: process.platform,
      processArch: process.arch,
      minMacosVersion: MIN_MACOS_VERSION,
      archs,
      flagsByArch,
      output: target.output
    })
  )
  return { sourceSha256, scriptSha256, archs, flagsByArch, signature }
}

/** 读取 build stamp；不存在 / JSON 损坏 / 版本不符 → null（按需重编）。 */
function readStamp(target) {
  const { stamp } = targetPaths(target)
  try {
    const parsed = JSON.parse(fs.readFileSync(stamp, 'utf8'))
    if (!parsed || typeof parsed !== 'object') return null
    if (parsed.format !== STAMP_FORMAT_VERSION) return null
    if (typeof parsed.signature !== 'string') return null
    return parsed
  } catch {
    return null
  }
}

/** 原子写入 build stamp（临时文件 + rename）；写失败只警告，不让构建失败。 */
function writeStamp(target, details, swiftc) {
  const { stamp } = targetPaths(target)
  const temporary = `${stamp}.tmp-${process.pid}`
  const payload = {
    format: STAMP_FORMAT_VERSION,
    target: target.name,
    signature: details.signature,
    sourceSha256: details.sourceSha256,
    scriptSha256: details.scriptSha256,
    swiftc: swiftc.version,
    swiftcPath: swiftc.realPath,
    platform: process.platform,
    processArch: process.arch,
    minMacosVersion: MIN_MACOS_VERSION,
    archs: details.archs,
    flagsByArch: details.flagsByArch,
    builtAt: new Date().toISOString()
  }
  try {
    fs.mkdirSync(path.dirname(stamp), { recursive: true })
    fs.writeFileSync(temporary, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
    fs.renameSync(temporary, stamp)
  } catch (error) {
    try {
      fs.rmSync(temporary, { force: true })
    } catch {
      /* 清理失败忽略 */
    }
    console.warn(
      `BUILD_NATIVE_WARN ${target.name}: failed to write build stamp (${toRel(stamp)}): ${
        error instanceof Error ? error.message : String(error)
      }`
    )
  }
}

/** 产物是否可执行（幂等判断与 --check 共用）。 */
function isExecutableFile(outputPath) {
  try {
    const stat = fs.statSync(outputPath)
    if (!stat.isFile()) return false
    fs.accessSync(outputPath, fs.constants.X_OK)
    return true
  } catch {
    return false
  }
}

/**
 * 单目标 --check（M-6 / A4-F06 / C-01 增强）：
 * 1. 存在 + 普通文件 + 可执行；
 * 2. universal：`lipo` 架构必须同时包含 arm64 与 x86_64；
 * 3. 最低系统版本：`vtool -show-build`（回退 `otool -l`）**每个架构 slice 的 minos 都 === 13.0**
 *    （Electron 44 最低系统；不得用本机 macOS 作上界，否则 macOS 27 开发机会假绿）；
 * 4. 实际运行 `--json`（5s 超时），退出码必须为 0；
 * 5. stdout 必须是合法 JSON 数组（元素为对象），避免「能执行但早坏了」的假绿。
 */
function checkTarget(target) {
  const { output } = targetPaths(target)
  let stat
  try {
    stat = fs.statSync(output)
  } catch {
    return fail(
      `--check: ${target.name} binary missing: ${target.output}（先运行 node scripts/build-native.mjs）`
    )
  }
  if (!stat.isFile()) return fail(`--check: ${target.output} is not a regular file`)
  try {
    fs.accessSync(output, fs.constants.X_OK)
  } catch {
    return fail(`--check: ${target.output} is not executable`)
  }

  let artifact
  try {
    artifact = inspectArtifact(output)
  } catch (error) {
    return fail(
      `--check: ${target.name} artifact invalid: ${
        error instanceof Error ? error.message : String(error)
      }`
    )
  }

  const checkArgs = target.checkArgs ?? ['--json']
  const startedAt = Date.now()
  const run = spawnSync(output, checkArgs, {
    encoding: 'utf8',
    timeout: CHECK_RUN_TIMEOUT_MS,
    maxBuffer: CHECK_MAX_BUFFER
  })
  const elapsedMs = Date.now() - startedAt

  if (run.error) {
    const timeoutHint =
      run.error.code === 'ETIMEDOUT' || /timed?\s*out/i.test(run.error.message)
        ? `（超时 ${CHECK_RUN_TIMEOUT_MS}ms）`
        : ''
    return fail(
      `--check: ${target.name} failed to run ${target.output} ${checkArgs.join(' ')}: ${
        run.error.message
      }${timeoutHint}`
    )
  }
  if (run.status !== 0) {
    const details = `${run.stderr || ''}`.trim()
    return fail(
      `--check: ${target.name} ${checkArgs.join(' ')} exited with code ${run.status}${
        details ? `\n${details}` : ''
      }`
    )
  }

  let parsed
  try {
    parsed = JSON.parse((run.stdout || '').trim())
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return fail(
      `--check: ${target.name} ${checkArgs.join(' ')} did not output valid JSON: ${message}`
    )
  }
  if (!Array.isArray(parsed)) {
    return fail(`--check: ${target.name} ${checkArgs.join(' ')} must output a JSON array`)
  }
  const invalidIndex = parsed.findIndex(
    (item) => typeof item !== 'object' || item === null || Array.isArray(item)
  )
  if (invalidIndex !== -1) {
    return fail(
      `--check: ${target.name} JSON array item #${invalidIndex} is not an object（输出与 WindowInfo 契约不符）`
    )
  }

  console.log(
    `BUILD_NATIVE_CHECK_OK ${target.name} ${target.output} ` +
      `(${stat.size} bytes, archs=${artifact.archs.join('+')}, ` +
      `minos=${artifact.minos.join('+')} (host ${artifact.hostVersion}), ` +
      `${checkArgs.join(' ')} ok: ${parsed.length} windows, ${elapsedMs}ms)`
  )
  return 0
}

/* ------------------------------- 目标编译流程 ------------------------------- */

/** 编译单个目标；返回 0/1。 */
function buildTarget(target, swiftc) {
  const paths = targetPaths(target)

  if (!fs.existsSync(paths.source)) {
    return fail(`${target.name}: source missing: ${target.source}`)
  }

  // 幂等（A4-F06 / R-08）：签名一致 + 产物架构/minos 校验通过才跳过。
  const details = signatureDetails(target, swiftc)
  if (isExecutableFile(paths.output)) {
    const stamp = readStamp(target)
    if (stamp && stamp.signature === details.signature) {
      try {
        const artifact = inspectArtifact(paths.output)
        console.log(
          `BUILD_NATIVE_OK ${target.name} up-to-date ${target.output} ` +
            `(archs=${artifact.archs.join('+')}, minos=${artifact.minos.join('+')}, ` +
            `signature ${details.signature.slice(0, 12)})`
        )
        return 0
      } catch (error) {
        console.log(
          `BUILD_NATIVE_INFO ${target.name}: stamp matches but artifact is invalid ` +
            `(${error instanceof Error ? error.message : String(error)}); rebuilding`
        )
      }
    }
  }

  fs.mkdirSync(path.dirname(paths.output), { recursive: true })
  const thinPaths = TARGET_ARCHS.map((arch) => `${paths.output}.${arch}`)
  const startedAt = Date.now()
  let lipoStarted = false

  try {
    for (const [index, arch] of TARGET_ARCHS.entries()) {
      const thinPath = thinPaths[index]
      fs.rmSync(thinPath, { force: true })
      const result = runTool(swiftc.path, compileArgs(target, arch, paths.source, thinPath))
      if (result.error) {
        throw new Error(
          `failed to run swiftc for ${arch} (${swiftc.path}): ${result.error.message}`
        )
      }
      if (result.status !== 0) {
        const output = `${result.stderr || ''}${result.stdout || ''}`.trim()
        throw new Error(
          `swiftc ${arch} exited with code ${result.status}${output ? `\n${output}` : ''}`
        )
      }
    }

    // 先移除旧产物再 lipo，避免失败时把「新 thin + 旧 fat」误判为本次结果。
    lipoStarted = true
    fs.rmSync(paths.output, { force: true })
    const lipo = runTool('lipo', ['-create', '-output', paths.output, ...thinPaths])
    if (lipo.error) {
      throw new Error(`failed to run lipo: ${lipo.error.message}`)
    }
    if (lipo.status !== 0) {
      throw new Error(
        `lipo -create exited with code ${lipo.status}${
          `${lipo.stderr || ''}`.trim() ? `\n${`${lipo.stderr || ''}`.trim()}` : ''
        }`
      )
    }

    const artifact = inspectArtifact(paths.output)
    const elapsedMs = Date.now() - startedAt
    writeStamp(target, details, swiftc)
    console.log(
      `BUILD_NATIVE_OK ${target.name} compiled ${toRel(paths.output)} ` +
        `(universal ${artifact.archs.join('+')}, minos=${artifact.minos.join('+')}, ` +
        `${elapsedMs}ms, swiftc: ${swiftc.version}, signature ${details.signature.slice(0, 12)})`
    )
    return 0
  } catch (error) {
    // 只有 lipo 阶段失败才可能留下半成品；编译失败时保留上一次的可用产物。
    if (lipoStarted) fs.rmSync(paths.output, { force: true })
    return fail(
      `${target.name}: ${error instanceof Error ? error.message : String(error)}`
    )
  } finally {
    for (const thinPath of thinPaths) fs.rmSync(thinPath, { force: true })
  }
}

/* ----------------------------------- 入口 ----------------------------------- */

function printHelp() {
  console.log(`用法: node scripts/build-native.mjs [--check] [--help]

  （默认）   编译 native/winlist/main.swift → native/winlist/.build/winlist
             universal（arm64 + x86_64，均 -target ...-apple-macos${MIN_MACOS_VERSION}）
             （幂等：签名一致且产物架构/minos 校验通过才跳过）
  --check    校验二进制存在且可执行、universal 架构含 ${TARGET_ARCHS.join('+')}、
             每个架构 slice 的 minos 都 === ${MIN_MACOS_VERSION}（≤ Electron 44 最低系统），
             并实际运行 \`--json\`（5s 超时）验证输出为 JSON 数组；任一失败 → exit 1
  --help     显示本帮助

环境变量:
  SWIFTC     显式指定 swiftc 可执行文件路径（默认从 PATH 查找；未显式设置时
             realpath 必须位于系统工具链目录，否则拒绝执行）`)
}

function main(argv) {
  const flags = argv.slice(2)

  if (flags.includes('--help') || flags.includes('-h')) {
    printHelp()
    return 0
  }

  const unknown = flags.filter((flag) => flag !== '--check')
  if (unknown.length > 0) return fail(`unknown argument(s): ${unknown.join(', ')}（--help 查看用法）`)

  if (process.platform !== 'darwin') {
    return fail(
      `unsupported platform: ${process.platform}（winlist 是 macOS 原生 helper，需要 macOS + Xcode CLT）`
    )
  }

  const checkOnly = flags.includes('--check')

  if (checkOnly) {
    let exitCode = 0
    for (const target of TARGETS) {
      const result = checkTarget(target)
      if (result !== 0) exitCode = result
    }
    return exitCode
  }

  const swiftc = resolveSwiftc()
  if (swiftc.error) return fail(swiftc.error)
  console.log(
    `BUILD_NATIVE_INFO swiftc ${swiftc.overridden ? '(SWIFTC override) ' : ''}` +
      `${swiftc.path} -> ${swiftc.realPath}`
  )

  for (const target of TARGETS) {
    const result = buildTarget(target, swiftc)
    if (result !== 0) return result
  }

  // 编译成功后顺手跑一遍 --check，保证产物确实可 spawn / 输出合法。
  let exitCode = 0
  for (const target of TARGETS) {
    const result = checkTarget(target)
    if (result !== 0) exitCode = result
  }
  return exitCode
}

process.exitCode = main(process.argv)
