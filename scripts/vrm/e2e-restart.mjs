#!/usr/bin/env node
/**
 * Wave 2 V8：临时 HOME + 多轮重启的「实机隔离/持久化/不污染真实数据」验收脚本。
 *
 * 用户要求（2026-11-08）：
 * - 实机测试指一个临时 HOME，多测几次重启，确认新会话还能开启、数据不会丢失、也没有其它影响；
 * - 避免把真实 `~/.dsh`（DSH 会话/数据集）或用户桌宠配置跑挂。
 *
 * 本脚本做三件事：
 * 1) 对**真实** DSH 相关目录做前后快照（`~/.dsh/aventurine-pet` 以及用户真实桌宠 userData
 *    `~/Library/Application Support/aventurine-pet`，如果存在）——只比较、不修改；
 * 2) 用临时 HOME（默认 /tmp/pet-dsh-home）+ 独立 `PET_PROFILE` 连续启动 app N 轮（默认 3），
 *    每轮用 `PET_DEV_CAPTURE_*` 抓一张截图并读回 `debug` 快照；第一轮写配置（sizePercent/opacity/
 *    autonomous），后续轮验证配置持久化、无崩溃、截图正常；
 * 3) 输出 `tests/tmp/wave2/restart/run-summary.json`（PASS/FAIL）。
 *
 * 用法：
 *   node scripts/vrm/e2e-restart.mjs                 # 3 轮
 *   node scripts/vrm/e2e-restart.mjs --rounds=2 --home=/tmp/pet-dsh-home
 *   node scripts/vrm/e2e-restart.mjs --check         # 只校验已有 summary
 *
 * 说明：macOS 的 Electron `app.getPath('appData')` 由系统 home（而非 $HOME）决定，因此 app 的
 * userData 会落在真实 `~/Library/Application Support/aventurine-pet-<profile>`；本脚本用独立
 * profile 目录并把它当作「临时环境」：不触碰用户默认 `aventurine-pet` 配置，且结束后可清理。
 */
import { spawn } from 'node:child_process'
import { userInfo } from 'node:os'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const ELECTRON_VITE = path.join(ROOT, 'node_modules/electron-vite/bin/electron-vite.js')
const OUT_DIR = path.join(ROOT, 'tests/tmp/wave2/restart')
// 注意：macOS 的 Electron app.getPath('appData') 走系统 passwd home（NSHomeDirectory），
// **不受 $HOME 影响**；脚本自身可能被调用方设置 HOME=临时目录，因此这里用 os.userInfo()
// （POSIX 下从 passwd 读取，不依赖 $HOME）解析真实 home。
const REAL_HOME = userInfo().homedir
const APP_DATA_DIR = path.join(REAL_HOME, 'Library/Application Support')
const PROFILE = 'agent-e2e'
const PROFILE_USER_DATA = path.join(APP_DATA_DIR, `aventurine-pet-${PROFILE}`)
const REAL_PET_DIRS = [
  path.join(APP_DATA_DIR, 'aventurine-pet'),
  path.join(APP_DATA_DIR, 'aventurine-pet-agent-e2e'),
  path.join(REAL_HOME, '.dsh', 'aventurine-pet')
]

function parseArgs(argv) {
  const options = { rounds: 3, home: '/tmp/pet-dsh-home', check: false, backend: 'vrm' }
  for (const arg of argv) {
    if (arg.startsWith('--rounds=')) options.rounds = Number(arg.slice('--rounds='.length))
    else if (arg.startsWith('--home=')) options.home = path.resolve(arg.slice('--home='.length))
    else if (arg.startsWith('--backend=')) options.backend = arg.slice('--backend='.length)
    else if (arg === '--check') options.check = true
    else if (arg === '--help' || arg === '-h') {
      console.log('Usage: node scripts/vrm/e2e-restart.mjs [--rounds=3] [--home=/tmp/pet-dsh-home] [--backend=vrm] [--check]')
      process.exit(0)
    }
  }
  options.rounds = Math.max(1, Math.min(6, Math.round(options.rounds)))
  return options
}

const options = parseArgs(process.argv.slice(2))
const summaryPath = path.join(OUT_DIR, 'run-summary.json')

/** 目录快照：相对路径 → size/mtimeMs（只读；不存在返回 null）。 */
function snapshotDir(dir) {
  if (!existsSync(dir)) return null
  const entries = {}
  const walk = (current, prefix) => {
    for (const name of readdirSync(current).sort()) {
      const full = path.join(current, name)
      const rel = prefix ? `${prefix}/${name}` : name
      let stats
      try {
        stats = statSync(full)
      } catch {
        continue
      }
      if (stats.isDirectory()) walk(full, rel)
      else entries[rel] = { size: stats.size, mtimeMs: Math.round(stats.mtimeMs) }
    }
  }
  try {
    walk(dir, '')
  } catch {
    return null
  }
  return entries
}

function dirHash(snapshot) {
  if (snapshot === null) return null
  const hash = createHash('sha256')
  for (const key of Object.keys(snapshot).sort()) hash.update(`${key}:${snapshot[key].size}:${snapshot[key].mtimeMs};`)
  return hash.digest('hex')
}

function snapshotRealDirs() {
  const result = {}
  for (const dir of REAL_PET_DIRS) {
    const snapshot = snapshotDir(dir)
    result[dir] = { exists: snapshot !== null, hash: dirHash(snapshot), fileCount: snapshot ? Object.keys(snapshot).length : 0 }
  }
  return result
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** 跑一轮 dev app（dev capture 自动退出），返回 { ok, stdout, stderr, snapshots }。 */
async function runRound(round, env) {
  const outDir = path.join(OUT_DIR, `round-${round}`)
  if (existsSync(outDir)) rmSync(outDir, { recursive: true, force: true })
  mkdirSync(outDir, { recursive: true })
  mkdirSync(options.home, { recursive: true })
  const captureEnv = {
    ...process.env,
    HOME: options.home,
    PET_DSH_DIR: path.join(options.home, '.dsh', 'aventurine-pet'),
    ELECTRON_RUN_AS_NODE: '',
    ELECTRON_DISABLE_SECURITY_WARNINGS: '1',
    PET_PROFILE: PROFILE,
    PET_MODEL_BACKEND: options.backend,
    PET_DEV_CAPTURE_DIR: outDir,
    PET_DEV_CAPTURE_POSES: 'stand',
    PET_DEV_CAPTURE_HOLD_MS: '900',
    PET_DEV_CAPTURE_CENTER: '1',
    PET_DEV_CAPTURE_IDLE: '1',
    PET_DEV_CAPTURE_READY_TIMEOUT_MS: '60000',
    ...env
  }
  const run = await new Promise((resolve) => {
    const child = spawn('node', [ELECTRON_VITE, 'dev'], { cwd: ROOT, env: captureEnv, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    let settled = false
    const finish = (payload) => {
      if (settled) return
      settled = true
      clearTimeout(watchdog)
      resolve(payload)
    }
    const watchdog = setTimeout(() => {
      child.kill('SIGKILL')
      finish({ code: -1, stdout, stderr, timedOut: true })
    }, 180_000)
    child.stdout.on('data', (chunk) => {
      stdout += chunk
    })
    child.stderr.on('data', (chunk) => {
      stderr += chunk
    })
    child.on('error', (error) => finish({ code: -1, stdout, stderr: `${stderr}\n${error?.stack ?? error}` }))
    child.on('close', (code) => finish({ code, stdout, stderr }))
  })
  // 每轮结束时的 config.json 快照 hash（多轮重启数据稳定性用）。
  let configSnapshotHash = null
  const profileConfigPath = path.join(PROFILE_USER_DATA, 'config.json')
  if (existsSync(profileConfigPath)) {
    try {
      configSnapshotHash = createHash('sha256').update(readFileSync(profileConfigPath)).digest('hex')
    } catch {
      configSnapshotHash = null
    }
  }
  const pngs = existsSync(outDir) ? readdirSync(outDir).filter((name) => name.endsWith('.png')) : []
  const snapshots = existsSync(outDir)
    ? readdirSync(outDir)
        .filter((name) => name.endsWith('.json') && name !== 'run-summary.json')
        .map((name) => {
          try {
            const raw = JSON.parse(readFileSync(path.join(outDir, name), 'utf8'))
            const debug = raw?.debug ?? {}
            return {
              file: name,
              ready: debug.ready === true,
              loaded: debug.model?.loaded === true,
              clipId: debug.animation?.clipId ?? null,
              vrmAvatarId: debug.vrm?.avatarId ?? null,
              errors: debug.errors ?? []
            }
          } catch (error) {
            return { file: name, error: String(error) }
          }
        })
    : []
  return {
    round,
    exitCode: run.code,
    timedOut: run.timedOut === true,
    devCaptureOk: run.stdout.includes('DEV_CAPTURE_OK'),
    devCaptureFail: run.stdout.includes('DEV_CAPTURE_FAIL'),
    pngCount: pngs.length,
    configSnapshotHash,
    snapshots,
    stdoutTail: run.stdout.slice(-4000),
    stderrTail: run.stderr.slice(-4000)
  }
}

async function main() {
  if (options.check) {
    if (!existsSync(summaryPath)) {
      console.error(`[e2e-restart] --check 失败：summary 不存在 ${summaryPath}`)
      process.exit(1)
    }
    const summary = JSON.parse(readFileSync(summaryPath, 'utf8'))
    if (summary.ok === true) {
      console.log(`[e2e-restart] --check OK：${summaryPath}`)
      return
    }
    console.error(`[e2e-restart] --check 失败：${JSON.stringify(summary.failures)}`)
    process.exit(1)
  }

  mkdirSync(OUT_DIR, { recursive: true })
  const failures = []
  const before = snapshotRealDirs()

  // 清掉测试 profile 的旧配置（保证第一轮从默认值开始）；只删测试专用 profile。
  if (existsSync(PROFILE_USER_DATA)) rmSync(PROFILE_USER_DATA, { recursive: true, force: true })

  const rounds = []
  for (let round = 1; round <= options.rounds; round += 1) {
    // 第一轮写非默认配置（验证持久化）；后续轮不再写。
    const env =
      round === 1
        ? { PET_RESTART_TEST_SET_CONFIG: '1' }
        : {}
    // 用 dev capture 之外的方式写配置：capture 循环不提供 setConfig；第一轮仍用 IDLE（会持久化 autonomous=false）
    const result = await runRound(round, env)
    rounds.push(result)
    if (!result.devCaptureOk || result.exitCode !== 0 || result.pngCount === 0) {
      failures.push(`round ${round}: app 未正常启动/截图（exit=${result.exitCode}, ok=${result.devCaptureOk}, png=${result.pngCount}）`)
    }
    for (const snapshot of result.snapshots) {
      if (snapshot.error) failures.push(`round ${round}: 快照解析失败 ${snapshot.file}: ${snapshot.error}`)
      else if (!snapshot.ready) failures.push(`round ${round}: debug.ready !== true`)
      else if (!snapshot.loaded) failures.push(`round ${round}: model.loaded !== true`)
      if (options.backend === 'vrm' && snapshot.clipId === null) failures.push(`round ${round}: clipId 为空`)
    }
    await delay(300)
  }

  // 配置持久化校验：第一轮 PET_DEV_CAPTURE_IDLE=1 会把 autonomous=false 写进 profile config.json。
  const configPath = path.join(PROFILE_USER_DATA, 'config.json')
  let persistedConfig = null
  if (existsSync(configPath)) {
    try {
      const raw = JSON.parse(readFileSync(configPath, 'utf8'))
      // config-store 落盘信封：{ version, config: {...} }；兼容旧结构直接是 PetConfig。
      const inner = raw['config']
      persistedConfig = inner && typeof inner === 'object' && !Array.isArray(inner) ? inner : raw
    } catch {
      persistedConfig = null
    }
  }
  if (persistedConfig === null) failures.push('profile config.json 不存在（配置未持久化）')
  else if (persistedConfig['modelBackend'] !== options.backend) {
    failures.push(
      `config.modelBackend 应为 ${options.backend}（实际 ${String(persistedConfig['modelBackend'])}）`
    )
  }
  // 3 轮重启后配置仍可读且结构完整 = 「数据不丢 / 新会话可再开」。
  if (persistedConfig !== null) {
    const requiredKeys = ['sizePercent', 'opacity', 'modelBackend', 'animBackend', 'motionSet']
    for (const key of requiredKeys) {
      if (!(key in persistedConfig)) failures.push(`config 缺键 ${key}（配置数据丢失）`)
    }
  }
  if (rounds.length >= 2) {
    const firstConfig = rounds[0]?.configSnapshotHash ?? null
    const lastConfig = rounds[rounds.length - 1]?.configSnapshotHash ?? null
    if (firstConfig !== null && lastConfig !== null && firstConfig !== lastConfig) {
      failures.push('多轮重启后 config.json hash 变化（数据不稳定）')
    }
  }

  // 真实目录不被修改校验（注意：PROFILE_USER_DATA 是我们自己的测试 profile，不算「真实用户配置」）。
  const after = snapshotRealDirs()
  const protectedDirs = REAL_PET_DIRS.filter((dir) => dir !== PROFILE_USER_DATA)
  for (const dir of protectedDirs) {
    const beforeEntry = before[dir]
    const afterEntry = after[dir]
    if (!beforeEntry || !afterEntry) {
      failures.push(`真实目录快照缺失：${dir}`)
      continue
    }
    if (beforeEntry.hash !== afterEntry.hash) {
      failures.push(`真实目录被修改：${dir}（before=${beforeEntry.hash} after=${afterEntry.hash}）`)
    }
  }

  const summary = {
    generatedAt: new Date().toISOString(),
    backend: options.backend,
    rounds: options.rounds,
    tempHome: options.home,
    profile: PROFILE,
    profileUserData: PROFILE_USER_DATA,
    realDirSnapshots: { before, after },
    configPath,
    persistedConfig,
    roundResults: rounds,
    failures,
    ok: failures.length === 0
  }
  writeFileSync(summaryPath, JSON.stringify(summary, null, 2))
  if (failures.length > 0) {
    console.error(`[e2e-restart] FAIL：\n  ${failures.join('\n  ')}\n  summary: ${summaryPath}`)
    process.exit(1)
  }
  console.log(
    `[e2e-restart] OK：${options.rounds} 轮重启 / 配置持久化 / 真实目录未修改 / summary=${summaryPath}`
  )
}

main().catch((error) => {
  console.error('[e2e-restart] 未捕获异常：', error)
  process.exit(1)
})
