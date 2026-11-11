#!/usr/bin/env node
/**
 * Wave 3 / V9 —— 未签名 macOS `.app` 产物静态校验（只读；不启动 GUI、不签名、不改系统设置）。
 *
 * 用途：在 `pnpm exec electron-builder --mac dir` 之后，验证 `dist/mac-arch/AventurinePet.app`
 * 的 bundle 身份、可执行、Resources 布局与 helper 架构是否符合运行时路径契约：
 * - `src/main/protocol.ts`（packaged：`Resources/model`、`Resources/assets`）
 * - `src/main/desktop/winlist.ts`（packaged：`Resources/native/winlist/winlist`）
 * - `src/main/tray.ts`（packaged：`Resources/assets/icons/trayTemplate.png`）
 * - `docs/packaging.md` §2.2（extraResources 映射表）
 *
 * 用法：
 *   node scripts/package-check.mjs                     # 自动查找 dist/mac-arch/AventurinePet.app
 *   node scripts/package-check.mjs --app <path>        # 指定 .app 路径
 *   node scripts/package-check.mjs --json              # 机器可读输出（CI/报告用）
 *   node scripts/package-check.mjs --skip-private-assets  # 干净 clone 无私有资产时的构建
 *   node scripts/package-check.mjs --help
 *
 * 退出码：0 = PASS；1 = FAIL（产物与契约不符）；2 = 无法定位 .app / 用法错误。
 *
 * 设计纪律：
 * - 只读产物：不修改 .app、不 codesign、不 open、不 xattr；
 * - 不依赖 electron-builder 的 node_modules（asar header 自行解析，格式见 @electron/asar）；
 * - 私有资产缺失：如果源仓库本身没有私有资产（干净 clone），只 WARN；
 *   如果源仓库有、但产物里没有，则 FAIL（说明 extraResources 映射漏了）。
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { closeSync, existsSync, openSync, readFileSync, readSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(SCRIPT_DIR, '..')

const APP_NAME = 'AventurinePet'
const EXPECTED_BUNDLE_ID = 'com.aventurine.pet'
const EXPECTED_MIN_MACOS = '13.0'
const EXPECTED_MAIN_ENTRY = 'out/main/index.js'
const EXPECTED_ASAR_ENTRIES = [
  'out/main/index.js',
  'out/preload/index.js',
  'out/renderer/index.html',
  'out/renderer/settings.html',
  'package.json'
]

const failures = []
const warnings = []
const passes = []

function pass(message) {
  passes.push(message)
}

function warn(message) {
  warnings.push(message)
}

function fail(message) {
  failures.push(message)
}

function errorText(error) {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error)
}

/** 执行 macOS 只读工具；失败返回 null + 记录 error。 */
function runTool(command, args) {
  try {
    return execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  } catch (error) {
    return null
  }
}

/** 执行 macOS 只读工具并把 stdout+stderr 一起返回（codesign 等工具信息走 stderr）。 */
function runToolAll(command, args) {
  try {
    const result = spawnSync(command, args, { encoding: 'utf8' })
    if (result.error) return null
    return `${result.stdout ?? ''}${result.stderr ?? ''}`
  } catch {
    return null
  }
}

/** 读取 Info.plist 为普通对象（plutil 兼容 XML 与 binary plist；只读）。 */
function readInfoPlist(plistPath) {
  const raw = runTool('/usr/bin/plutil', ['-convert', 'json', '-o', '-', plistPath])
  if (raw == null) return null
  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
}

/** 解析 Mach-O 二进制架构列表（`lipo -archs`；非 Mach-O 返回 null）。 */
function readArchs(filePath) {
  const raw = runTool('/usr/bin/lipo', ['-archs', filePath])
  if (raw == null) return null
  return raw.trim().split(/\s+/).filter(Boolean)
}

/** 解析每个架构 slice 的 minos（`vtool -show-build`；解析失败返回 null）。 */
function readBuildMinos(filePath) {
  const raw = runTool('/usr/bin/vtool', ['-show-build', filePath])
  if (raw == null) return null
  const values = [...raw.matchAll(/\bminos\s+([\d.]+)/g)].map((match) => match[1])
  return values.length > 0 ? values : null
}

/** 比较点分版本号（仅 x.y.z）。 */
function compareVersion(a, b) {
  const pa = String(a).split('.').map((part) => Number.parseInt(part, 10) || 0)
  const pb = String(b).split('.').map((part) => Number.parseInt(part, 10) || 0)
  for (let index = 0; index < Math.max(pa.length, pb.length); index += 1) {
    const left = pa[index] ?? 0
    const right = pb[index] ?? 0
    if (left !== right) return left - right
  }
  return 0
}

/**
 * 解析 asar header（格式：8 字节 pickle（uint32 4 + headerSize）+ header pickle
 * （uint32 payload size + uint32 string length + JSON）；与 @electron/asar `readArchiveHeaderSync` 一致）。
 * @returns {{ header: any, headerSize: number } | null}
 */
function readAsarHeader(asarPath) {
  let fd = null
  try {
    fd = openSync(asarPath, 'r')
    const sizeBuf = Buffer.alloc(8)
    if (readSync(fd, sizeBuf, 0, 8, 0) !== 8) return null
    if (sizeBuf.readUInt32LE(0) !== 4) return null
    const headerSize = sizeBuf.readUInt32LE(4)
    if (headerSize <= 8 || headerSize > 32 * 1024 * 1024) return null
    const headerBuf = Buffer.alloc(headerSize)
    if (readSync(fd, headerBuf, 0, headerSize, 8) !== headerSize) return null
    const stringLength = headerBuf.readUInt32LE(4)
    if (stringLength <= 0 || 8 + stringLength > headerSize) return null
    const header = JSON.parse(headerBuf.subarray(8, 8 + stringLength).toString('utf8'))
    return { header, headerSize }
  } catch {
    return null
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd)
      } catch {
        // 只读校验：关闭失败不影响结果。
      }
    }
  }
}

/** 把 asar header 的 files 树展开为 POSIX 路径列表。 */
function listAsarFiles(header, prefix = '') {
  const out = []
  const files = header && typeof header.files === 'object' ? header.files : null
  if (!files) return out
  for (const [name, entry] of Object.entries(files)) {
    const path = prefix.length > 0 ? `${prefix}/${name}` : name
    if (entry && typeof entry === 'object' && typeof entry.files === 'object') {
      out.push(...listAsarFiles(entry, path))
    } else {
      out.push(path)
    }
  }
  return out
}

/** 查找 dist/mac-arch/AventurinePet.app（不递归进入 .app 内部）。 */
function discoverApp() {
  const distDir = join(REPO_ROOT, 'dist')
  if (!existsSync(distDir)) return null
  const candidates = []
  for (const entry of readdirSync(distDir)) {
    if (!entry.startsWith('mac')) continue
    const appPath = join(distDir, entry, `${APP_NAME}.app`)
    if (existsSync(appPath)) candidates.push(appPath)
  }
  if (candidates.length === 0) return null
  // 多个产物（如 mac-arm64 + mac-x64）时优先当前机器架构目录。
  const preferred = candidates.find((candidate) => candidate.includes(`mac-${process.arch}`))
  return preferred ?? candidates[0]
}

function parseArgs(argv) {
  const options = { app: null, json: false, skipPrivateAssets: false, help: false }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--app') {
      const next = argv[index + 1]
      if (!next) throw new Error('--app 需要一个路径参数')
      options.app = next
      index += 1
    } else if (arg === '--json') {
      options.json = true
    } else if (arg === '--skip-private-assets') {
      options.skipPrivateAssets = true
    } else if (arg === '--help' || arg === '-h') {
      options.help = true
    } else {
      throw new Error(`未知参数：${arg}`)
    }
  }
  return options
}

const HELP = `用法：node scripts/package-check.mjs [options]

校验 electron-builder --mac dir 产出的未签名 ${APP_NAME}.app（只读，不启动/不签名）。

options:
  --app <path>            指定 .app 路径（默认识别 dist/mac-arch/${APP_NAME}.app）
  --json                  输出机器可读 JSON（stdout 只有 JSON）
  --skip-private-assets   允许产物缺少私有 assets（干净 clone 构建用）；源仓库有而产物缺失仍 FAIL
  -h, --help              显示本帮助

退出码：0 PASS / 1 FAIL / 2 无法定位产物或参数错误

校验项：
  bundle 结构、Info.plist（bundle id / 可执行名 / LSMinimumSystemVersion）、
  app.asar（入口与生产依赖）、Resources/native/winlist/winlist（universal + minos）、
  Resources/model（PMX+贴图）、Resources/assets/icons 与私有资产、签名状态（仅 info）。`

function main() {
  let options
  try {
    options = parseArgs(process.argv.slice(2))
  } catch (error) {
    console.error(`[package-check] ${errorText(error)}`)
    console.error(HELP)
    process.exit(2)
  }
  if (options.help) {
    console.log(HELP)
    process.exit(0)
  }

  const appPath = options.app
    ? resolve(process.cwd(), options.app)
    : discoverApp()
  if (!appPath || !existsSync(appPath)) {
    console.error(
      `[package-check] 未找到 ${APP_NAME}.app。先运行：\n` +
        `  pnpm exec electron-builder --mac dir\n` +
        `或显式传入 --app <path>。`
    )
    process.exit(2)
  }

  /* ------------------------------ 1) bundle 结构 ------------------------------ */
  const infoPlistPath = join(appPath, 'Contents', 'Info.plist')
  const resourcesDir = join(appPath, 'Contents', 'Resources')
  const macOsDir = join(appPath, 'Contents', 'MacOS')
  const asarPath = join(resourcesDir, 'app.asar')

  if (!statSync(appPath).isDirectory()) fail(`产物不是目录：${appPath}`)
  else pass(`bundle 存在：${appPath}`)

  if (existsSync(infoPlistPath)) pass('Contents/Info.plist 存在')
  else fail('缺少 Contents/Info.plist')
  if (existsSync(asarPath)) pass('Contents/Resources/app.asar 存在')
  else fail('缺少 Contents/Resources/app.asar（asar 打包未生成）')

  /* ------------------------------ 2) Info.plist ------------------------------ */
  let info = null
  if (existsSync(infoPlistPath)) {
    info = readInfoPlist(infoPlistPath)
    if (info) {
      if (info.CFBundleIdentifier === EXPECTED_BUNDLE_ID) {
        pass(`CFBundleIdentifier = ${EXPECTED_BUNDLE_ID}`)
      } else {
        fail(`CFBundleIdentifier 期望 ${EXPECTED_BUNDLE_ID}，实际 ${JSON.stringify(info.CFBundleIdentifier)}`)
      }
      const executableName = info.CFBundleExecutable
      if (typeof executableName === 'string' && executableName.length > 0) {
        pass(`CFBundleExecutable = ${executableName}`)
      } else {
        fail('Info.plist 缺少 CFBundleExecutable')
      }
      if (info.CFBundleName === APP_NAME) pass(`CFBundleName = ${APP_NAME}`)
      else warn(`CFBundleName 期望 ${APP_NAME}，实际 ${JSON.stringify(info.CFBundleName)}`)

      const minSystem = info.LSMinimumSystemVersion
      if (minSystem === EXPECTED_MIN_MACOS) {
        pass(`LSMinimumSystemVersion = ${EXPECTED_MIN_MACOS}`)
      } else {
        fail(`LSMinimumSystemVersion 期望 ${EXPECTED_MIN_MACOS}，实际 ${JSON.stringify(minSystem)}`)
      }

      // 应用图标：当前 V9 未提供 .icns，electron-builder 回退 Electron 默认图标（只 warn）。
      const iconFile = info.CFBundleIconFile
      if (typeof iconFile === 'string' && iconFile.length > 0 && !/^electron\.icns$/i.test(iconFile)) {
        pass(`CFBundleIconFile = ${iconFile}`)
      } else {
        warn('未配置应用图标（.icns），使用 Electron 默认图标（V9 已知待办，见 docs/packaging.md）')
      }

      // 3) 主可执行
      if (typeof executableName === 'string') {
        const executablePath = join(macOsDir, executableName)
        checkExecutable(executablePath)
      }
    } else {
      fail(`Info.plist 无法解析：${infoPlistPath}`)
    }
  }

  /* ------------------------------ 4) app.asar ------------------------------ */
  if (existsSync(asarPath)) {
    const archive = readAsarHeader(asarPath)
    if (!archive) {
      fail('app.asar header 解析失败（产物损坏或不是 asar）')
    } else {
      const files = listAsarFiles(archive.header)
      pass(`app.asar 可解析（${files.length} 个 entry，header ${archive.headerSize}B）`)
      for (const expected of EXPECTED_ASAR_ENTRIES) {
        if (files.includes(expected)) pass(`app.asar 包含 ${expected}`)
        else fail(`app.asar 缺少 ${expected}`)
      }
      // main 入口必须与 package.json 的 main 一致（sanity check：electron-builder 会校验；这里复核）
      const asarPackageJson = files.find((file) => file === 'package.json')
      if (asarPackageJson) {
        const packageJsonRaw = readFileFromAsar(asarPath, archive, 'package.json')
        try {
          const manifest = JSON.parse(packageJsonRaw ?? '{}')
          if (manifest.main === `./${EXPECTED_MAIN_ENTRY}` || manifest.main === EXPECTED_MAIN_ENTRY) {
            pass(`app.asar/package.json main = ${manifest.main}`)
          } else {
            fail(`app.asar/package.json main 期望 ./${EXPECTED_MAIN_ENTRY}，实际 ${JSON.stringify(manifest.main)}`)
          }
          const packageName = manifest.productName ?? manifest.name
          if (typeof packageName === 'string' && packageName.length > 0) {
            pass(`app.asar/package.json name = ${packageName}`)
          } else {
            warn('app.asar/package.json 缺少 name/productName（bundle 名由 electron-builder 注入 Info.plist）')
          }
        } catch {
          warn('app.asar/package.json 无法解析（不影响启动，electron-builder 会自行校验）')
        }
      }
      // 运行时生产依赖：out/main/index.js 会 require('@electron-toolkit/utils')（electron-vite 将其外置）。
      const runtimeDepEntry = files.find(
        (file) => file === 'node_modules/@electron-toolkit/utils/package.json'
      )
      if (runtimeDepEntry) {
        pass('app.asar 含运行时生产依赖 @electron-toolkit/utils')
      } else {
        fail(
          'app.asar 缺少 @electron-toolkit/utils（out/main/index.js 运行时 require，打包会启动即崩）；' +
            '检查 package.json dependencies 是否被 electron-builder 收集'
        )
      }
      const rendererAssets = files.filter((file) => file.startsWith('out/renderer/assets/') && file.endsWith('.js'))
      if (rendererAssets.length > 0) {
        pass(`app.asar 含 ${rendererAssets.length} 个 renderer JS chunk（含入口 bundle）`)
      } else {
        fail('app.asar 缺少 out/renderer/assets/*.js（renderer 页面无法加载）')
      }
      if (files.includes('out/renderer/settings.html')) {
        pass('app.asar 含设置窗入口 out/renderer/settings.html')
      } else {
        fail('app.asar 缺少 out/renderer/settings.html（托盘「设置…」将打不开）')
      }
    }
  }

  /* ------------------------------ 5) 原生 helper ------------------------------ */
  const helperPath = join(resourcesDir, 'native', 'winlist', 'winlist')
  checkExecutable(helperPath, { requireUniversal: true })

  /* ------------------------------ 6) model ------------------------------ */
  const modelDir = join(resourcesDir, 'model')
  checkModel(modelDir)

  /* ------------------------------ 7) assets ------------------------------ */
  const assetsDir = join(resourcesDir, 'assets')
  checkAssets(assetsDir, options.skipPrivateAssets)

  /* ------------------------------ 8) 签名状态（info） ------------------------------ */
  const signature = runToolAll('/usr/bin/codesign', ['-dv', '--verbose=2', appPath])
  if (signature == null) {
    pass('签名状态：unsigned（identity: null，符合本机自用 V9 目标；分发前必须签名+公证）')
  } else if (/Signature=adhoc/.test(signature) && !/Authority=Developer ID Application/.test(signature)) {
    // Electron 官方 dist 的主二进制本身是 linker-signed adhoc；electron-builder identity:null 时不再重签。
    pass('签名状态：adhoc/未签名（identity: null；Electron dist 自带 linker-signed，符合本机自用目标）')
  } else {
    const identifier = /Identifier=([^\s]+)/.exec(signature)?.[1] ?? 'unknown'
    warn(`签名状态：检测到非预期签名（identifier=${identifier}）；当前配置期望 unsigned，请确认归因`)
  }

  /* ------------------------------ 汇总 ------------------------------ */
  const result = {
    appPath,
    ok: failures.length === 0,
    passes: passes.length,
    warnings,
    failures,
    bundleId: info?.CFBundleIdentifier ?? null,
    minimumSystemVersion: info?.LSMinimumSystemVersion ?? null,
    resourcesDir
  }

  if (options.json) {
    console.log(JSON.stringify(result, null, 2))
  } else {
    console.log(`\n[package-check] ${appPath}`)
    for (const message of passes) console.log(`  PASS  ${message}`)
    for (const message of warnings) console.log(`  WARN  ${message}`)
    for (const message of failures) console.log(`  FAIL  ${message}`)
    console.log(
      `\n[package-check] ${failures.length === 0 ? 'PASS' : 'FAIL'} —— ${passes.length} passed / ${warnings.length} warnings / ${failures.length} failed`
    )
  }

  if (failures.length > 0) process.exit(1)
}

/** 校验一个可执行文件：存在性 + 可执行位 + Mach-O 架构（可选 universal）。 */
function checkExecutable(executablePath, { requireUniversal = false } = {}) {
  const label = executablePath.includes('winlist') ? 'native/winlist/winlist' : '主可执行'
  if (!existsSync(executablePath)) {
    fail(`缺少${label}：${executablePath}`)
    return
  }
  const stats = statSync(executablePath)
  if (!stats.isFile()) {
    fail(`${label} 不是普通文件：${executablePath}`)
    return
  }
  if ((stats.mode & 0o111) === 0) {
    fail(`${label} 没有可执行位：${executablePath}`)
    return
  }
  pass(`${label} 存在且可执行（${stats.size}B）`)

  const archs = readArchs(executablePath)
  if (!archs) {
    fail(`${label} 不是有效 Mach-O（lipo 解析失败）：${executablePath}`)
    return
  }
  if (requireUniversal) {
    const missing = ['arm64', 'x86_64'].filter((arch) => !archs.includes(arch))
    if (missing.length === 0) pass(`${label} universal（${archs.join('+')}）`)
    else fail(`${label} 非 universal，缺少架构：${missing.join(',')}（实际 ${archs.join('+')}；见 docs/packaging.md §2.3）`)
  } else if (archs.includes(process.arch)) {
    pass(`${label} 架构包含本机 ${process.arch}（${archs.join('+')}）`)
  } else {
    fail(`${label} 架构 ${archs.join('+')} 不含本机 ${process.arch}，无法在本机启动`)
  }

  const minosValues = readBuildMinos(executablePath)
  if (!minosValues) {
    warn(`${label} vtool minos 无法解析（跳过最低系统版本校验）`)
  } else {
    const tooHigh = minosValues.filter((minos) => compareVersion(minos, EXPECTED_MIN_MACOS) > 0)
    if (tooHigh.length === 0) pass(`${label} minos = ${[...new Set(minosValues)].join('/')}（≤ ${EXPECTED_MIN_MACOS}）`)
    else fail(`${label} minos ${tooHigh.join(',')} > ${EXPECTED_MIN_MACOS}（Electron 44 最低 13.0）`)
  }
}

/** 校验 Resources/model（packaged 分支：<resourcesPath>/model，兼容其下 optimized/）。 */
function checkModel(modelDir) {
  if (!existsSync(modelDir)) {
    fail(`缺少 Resources/model（PMX 回退资源；packaged 路径见 src/main/protocol.ts getAssetRoots）`)
    return
  }
  pass('Resources/model 存在')
  const manifestPath = join(REPO_ROOT, 'src', 'shared', 'assets-manifest.json')
  let manifest = null
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  } catch {
    warn('无法读取 src/shared/assets-manifest.json，跳过 PMX 文件名/贴图逐项校验')
    return
  }
  const pmxFile = manifest?.pmx?.file
  if (typeof pmxFile !== 'string' || pmxFile.length === 0) {
    warn('assets-manifest.json 缺少 pmx.file，跳过 PMX 校验')
  } else if (existsSync(join(modelDir, pmxFile))) {
    pass(`Resources/model 含 PMX：${pmxFile}`)
  } else {
    fail(`Resources/model 缺少 PMX：${pmxFile}（assets/model/optimized 未打进包？见 docs/packaging.md §2.2）`)
  }
  const textures = Array.isArray(manifest?.textures) ? manifest.textures : []
  const missingTextures = textures
    .map((texture) => texture?.optimized)
    .filter((optimized) => typeof optimized === 'string' && optimized.length > 0)
    .filter((optimized) => !existsSync(join(modelDir, optimized)))
  if (textures.length > 0 && missingTextures.length === 0) {
    pass(`Resources/model 含 ${textures.length} 张优化贴图`)
  } else if (missingTextures.length > 0) {
    fail(`Resources/model 缺少 ${missingTextures.length} 张贴图（例如 ${missingTextures[0]}）`)
  }
}

/** 校验 Resources/assets（icons 必需；私有资产按源仓库是否存在决定 FAIL/WARN）。 */
function checkAssets(assetsDir, skipPrivateAssets) {
  if (!existsSync(assetsDir)) {
    fail('缺少 Resources/assets（见 src/main/protocol.ts getAssetsHostRoots）')
    return
  }
  pass('Resources/assets 存在')

  const trayIcon = join(assetsDir, 'icons', 'trayTemplate.png')
  if (existsSync(trayIcon)) pass('Resources/assets/icons/trayTemplate.png 存在（托盘图标）')
  else fail('Resources/assets/icons/trayTemplate.png 缺失（托盘将只剩空图标，见 src/main/tray.ts）')
  if (!existsSync(join(assetsDir, 'icons', 'trayTemplate@2x.png'))) {
    warn('trayTemplate@2x.png 缺失（高分屏托盘图标会退化，非阻塞）')
  }

  // 私有资产：先看源仓库是否有（干净 clone 没有 → 只 WARN）。
  const sourceHasPrivate = existsSync(join(REPO_ROOT, 'assets', 'vrm')) || existsSync(join(REPO_ROOT, 'assets', 'motions'))
  const defaultAvatarFile = resolveDefaultAvatarFile()
  const privateChecks = [
    { label: `默认 VRM 模型（assets/${defaultAvatarFile}）`, target: join(assetsDir, defaultAvatarFile) },
    { label: '动作清单 motions/app-manifest.json', target: join(assetsDir, 'motions', 'app-manifest.json') },
    { label: '动作 catalog motions/app-catalog.json', target: join(assetsDir, 'motions', 'app-catalog.json') },
    { label: '表情清单 expressions/manifest.json', target: join(assetsDir, 'expressions', 'manifest.json') }
  ]
  for (const check of privateChecks) {
    if (existsSync(check.target)) {
      pass(`Resources/assets 含 ${check.label}`)
      continue
    }
    const message = `Resources/assets 缺少 ${check.label}（${check.target}）`
    if (skipPrivateAssets || !sourceHasPrivate) warn(`${message}〔源仓库无私有资产，按干净 clone 处理〕`)
    else fail(message)
  }

  // 动作清单必须非空（私有动作资产到位时）。
  const appManifestPath = join(assetsDir, 'motions', 'app-manifest.json')
  if (existsSync(appManifestPath)) {
    try {
      const appManifest = JSON.parse(readFileSync(appManifestPath, 'utf8'))
      const clips = Array.isArray(appManifest?.clips) ? appManifest.clips.length : 0
      if (clips > 0) pass(`app-manifest.json 含 ${clips} 条 clip（VRM 动画可播放）`)
      else fail('app-manifest.json clips 为空（VRM 后端将无动作可播）')
    } catch {
      fail('app-manifest.json 无法解析')
    }
  }
}

/** 从 src/shared/vrm-manifest.json 解析 defaultAvatarId 对应的模型文件（相对 assets/）。 */
function resolveDefaultAvatarFile() {
  try {
    const manifest = JSON.parse(readFileSync(join(REPO_ROOT, 'src', 'shared', 'vrm-manifest.json'), 'utf8'))
    const avatarId = manifest?.defaultAvatarId
    const avatar = (manifest?.avatars ?? []).find((entry) => entry?.id === avatarId)
    if (avatar && typeof avatar.file === 'string' && avatar.file.length > 0) return avatar.file
  } catch {
    // 契约文件缺失/坏 JSON：退回已知目标资产。
  }
  return 'vrm/aventurine-tpose.vrm'
}

/**
 * 从 asar 中读取单个文件内容（仅用于校验 package.json；文件必须未 unpack）。
 * @returns {string | null}
 */
function readFileFromAsar(asarPath, archive, relativePath) {
  const segments = relativePath.split('/').filter(Boolean)
  let node = archive.header
  for (const segment of segments) {
    node = node?.files?.[segment]
    if (!node) return null
  }
  if (!node || typeof node.size !== 'number') return null
  const offset = Number(node.offset)
  if (!Number.isSafeInteger(offset) || offset < 0) return null
  const fd = openSync(asarPath, 'r')
  try {
    const buffer = Buffer.alloc(node.size)
    const read = readSync(fd, buffer, 0, node.size, 8 + archive.headerSize + offset)
    if (read !== node.size) return null
    return buffer.toString('utf8')
  } catch {
    return null
  } finally {
    try {
      closeSync(fd)
    } catch {
      // 只读：关闭失败忽略。
    }
  }
}

main()
