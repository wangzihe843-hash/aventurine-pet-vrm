#!/usr/bin/env node
/**
 * E2E ⑤：激活脚本 dry-run / 实际写入 / 幂等拒绝 / 回滚（指向临时 fake DSH_HOME，绝不碰真实 ~/.dsh）。
 *
 * 覆盖（task-13 第 5 条）：
 *   - `--dry-run`：不写文件、打印将追加的 insert 块；
 *   - 实际写入：备份 + 追加 + YAML 可解析 + 字段正确；
 *   - 幂等：已存在 `id: aventurine-bridge` 时拒绝（exit 1）；
 *   - 回滚：默认回滚（自动找备份）与显式 `--backup` 回滚；校验恢复后内容与原始一致。
 *
 * 证据：`tests/tmp/wave3-e2e/<ts>-activate/`（fake-home/、*.log、result.json）。
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import {
  Assertions,
  PACKAGED_APP,
  ROOT,
  finalizeResult,
  makeRunDir,
  sha256File,
  snapshotRealDshState,
  writeJson
} from './lib.mjs'

const script = join(ROOT, 'scripts/activate-dsh-bridge.mjs')
const runDir = makeRunDir('activate')
const fakeHome = join(runDir, 'fake-dsh-home')
const profileDir = join(fakeHome, 'profiles/desktop')
const patchPath = join(profileDir, 'cordis.patch.yml')
const fakeBridgeDir = join(runDir, 'fake-bridge-dir')
const assertions = new Assertions('activate')
const realBefore = snapshotRealDshState()
console.log(`[activate] runDir=${runDir} fakeHome=${fakeHome}`)

const ORIGINAL_PATCH = `# fake DSH profile patch（activate dry-run 测试用；非真实 profile）
- id: fake-base
  name: fake-base
- id: fake-config
  name: fake-config
  config:
    keep: true
`

mkdirSync(profileDir, { recursive: true })
mkdirSync(fakeBridgeDir, { recursive: true })
writeFileSync(patchPath, ORIGINAL_PATCH)
const originalHash = sha256File(patchPath)

/** 运行激活脚本。 */
function runActivate(args) {
  const result = spawnSync(process.execPath, [script, ...args], {
    cwd: ROOT,
    env: { ...process.env },
    encoding: 'utf8',
    timeout: 60000
  })
  const record = {
    args,
    code: result.status,
    signal: result.signal,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? ''
  }
  writeFileSync(join(runDir, `activate-${args.join('_').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 80) || 'run'}.log`), `${JSON.stringify(record, null, 2)}\n`)
  console.log(`  $ activate ${args.join(' ')} → exit ${record.code}`)
  if (record.stderr.trim().length > 0) console.log(`    stderr: ${record.stderr.trim().split('\n').slice(-3).join(' | ')}`)
  return record
}

/** 用 PyYAML 校验文本可解析（激活脚本本身也依赖它；这里独立复验）。 */
function parseYaml(text) {
  const result = spawnSync('python3', ['-c', 'import sys,json,yaml; print(json.dumps(yaml.safe_load(sys.stdin.read()), ensure_ascii=False))'], {
    input: text,
    encoding: 'utf8',
    timeout: 30000
  })
  if (result.status !== 0) return { ok: false, error: (result.stderr ?? '').trim() }
  try {
    return { ok: true, value: JSON.parse(result.stdout) }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

/** 目录内 bak-wave3 备份文件名列表。 */
function backups() {
  try {
    return readdirSync(profileDir).filter((name) => name.includes('bak-wave3'))
  } catch {
    return []
  }
}

const baseArgs = [
  '--pet-app',
  PACKAGED_APP,
  '--home',
  fakeHome,
  '--profile',
  'desktop',
  '--bridge-dir',
  fakeBridgeDir
]

try {
  // ---- 1) dry-run：不写文件、打印追加块 ----
  const dry = runActivate([...baseArgs, '--dry-run'])
  assertions.check('dry-run-exit-0', dry.code === 0, dry.code)
  assertions.check('dry-run-prints-target', dry.stdout.includes('DRY-RUN') && dry.stdout.includes(patchPath), dry.stdout.split('\n').slice(0, 4))
  assertions.check('dry-run-includes-bridge-entry', dry.stdout.includes('id: aventurine-bridge') && dry.stdout.includes('launchPet: true'), null)
  assertions.check('dry-run-does-not-write', sha256File(patchPath) === originalHash, { hash: sha256File(patchPath) })
  assertions.check('dry-run-no-backup', backups().length === 0, backups())

  // ---- 2) 实际写入：备份 + 追加 + YAML/字段 ----
  const write = runActivate(baseArgs)
  assertions.check('write-exit-0', write.code === 0, write.code)
  const patchedText = readFileSync(patchPath, 'utf8')
  assertions.check('write-changed-file', sha256File(patchPath) !== originalHash, null)
  const parsed = parseYaml(patchedText)
  assertions.check('patched-yaml-parses', parsed.ok === true, parsed.ok ? null : parsed.error)
  if (parsed.ok && Array.isArray(parsed.value)) {
    const insertEntry = parsed.value.find((entry) => entry && Array.isArray(entry.insert))
    const row = insertEntry?.insert?.find?.((item) => item && item.id === 'aventurine-bridge')
    assertions.check('patched-has-insert-row', Boolean(row), insertEntry ?? null)
    assertions.check(
      'patched-row-fields',
      Boolean(row && row.name === join(ROOT, 'bridge/dsh-aventurine-bridge/lib/index.js') && row.config?.launchPet === true && row.config?.petBundleId === 'com.aventurine.pet' && row.config?.petAppPath === PACKAGED_APP),
      row ?? null
    )
    assertions.check('patched-preserves-original-entries', Boolean(parsed.value.find((entry) => entry && entry.id === 'fake-base')), parsed.value.map((entry) => entry?.id ?? 'insert'))
  }
  const backupNames = backups()
  assertions.check('write-creates-backup', backupNames.length === 1, backupNames)
  const backupPath = backupNames[0] ? join(profileDir, backupNames[0]) : null
  assertions.check(
    'backup-content-equals-original',
    backupPath !== null && sha256File(backupPath) === originalHash,
    { backupPath, backupHash: backupPath ? sha256File(backupPath) : null, originalHash }
  )

  // ---- 3) 幂等：重复激活被拒绝 ----
  const again = runActivate(baseArgs)
  assertions.check('idempotent-refusal-exit-1', again.code === 1, again.code)
  assertions.check(
    'idempotent-refusal-message',
    /已包含 id: aventurine-bridge/.test(again.stderr) || /已包含 id: aventurine-bridge/.test(again.stdout),
    (again.stderr || again.stdout).split('\n').slice(-2)
  )

  // ---- 4) 回滚：默认（自动找备份）与显式 --backup ----
  const rollbackDefault = runActivate(['--home', fakeHome, '--profile', 'desktop', '--rollback'])
  const defaultRollbackOk = rollbackDefault.code === 0 && sha256File(patchPath) === originalHash
  assertions.check('rollback-auto-finds-backup', defaultRollbackOk, {
    code: rollbackDefault.code,
    stderr: rollbackDefault.stderr.trim().split('\n').slice(-2),
    restoredHash: sha256File(patchPath),
    backupNames
  })

  if (!defaultRollbackOk) {
    // 若默认回滚失败（备份命名与查找规则不一致），用显式 --backup 验证回滚能力本身。
    if (backupPath === null) {
      assertions.check('rollback-explicit-backup', false, '没有备份文件可用')
    } else {
      const rollbackExplicit = runActivate(['--home', fakeHome, '--profile', 'desktop', '--rollback', '--backup', backupPath])
      assertions.check('rollback-explicit-backup', rollbackExplicit.code === 0 && sha256File(patchPath) === originalHash, {
        code: rollbackExplicit.code,
        restoredHash: sha256File(patchPath)
      })
    }
  }

  // ---- 5) dry-run 回滚：不写文件 ----
  // 先再次激活以便有备份可回滚
  const rewrite = runActivate(baseArgs)
  assertions.check('rewrite-for-rollback-dryrun', rewrite.code === 0, rewrite.code)
  const beforeDryRollback = sha256File(patchPath)
  const dryRollback = runActivate(['--home', fakeHome, '--profile', 'desktop', '--rollback', '--dry-run'])
  assertions.check('rollback-dry-run-exit-0', dryRollback.code === 0, dryRollback.code)
  assertions.check('rollback-dry-run-does-not-write', sha256File(patchPath) === beforeDryRollback, null)

  // 收尾：显式备份回滚到原始内容（避免留下半激活 fake profile 影响后续）。
  const finalBackup = backups().map((name) => join(profileDir, name)).find((file) => sha256File(file) === originalHash)
  if (finalBackup) {
    runActivate(['--home', fakeHome, '--profile', 'desktop', '--rollback', '--backup', finalBackup])
  } else {
    writeFileSync(patchPath, ORIGINAL_PATCH)
  }

  writeJson(join(runDir, 'activate-evidence.json'), {
    fakeHome,
    patchPath,
    originalHash,
    backupNames,
    defaultRollbackOk,
    finalHash: sha256File(patchPath)
  })
} catch (error) {
  assertions.check('activate-exception', false, error instanceof Error ? error.stack ?? error.message : String(error))
}

// 隔离自证：真实 ~/.dsh 未被改动。
const realAfter = snapshotRealDshState()
assertions.check('real-desktop-patch-unchanged', realAfter.desktopPatch === realBefore.desktopPatch, {
  before: realBefore.desktopPatch,
  after: realAfter.desktopPatch
})
assertions.check(
  'real-bridge-dir-unchanged',
  JSON.stringify(realAfter.bridgeDir) === JSON.stringify(realBefore.bridgeDir),
  { before: realBefore.bridgeDir, after: realAfter.bridgeDir }
)
assertions.check('fake-home-inside-run-dir', fakeHome.startsWith(runDir), fakeHome)

process.exitCode = await finalizeResult(runDir, assertions, { fakeHome, patchPath })
