/**
 * F-08：Wave 0 脚本的 CLI 边界/错误路径回归（**只读**）。
 *
 * 背景：`scripts/prepare-assets.mjs`、`scripts/worktree-setup.sh` 之前只有人工探针，
 * `--max-edge` 非法值、未知参数、worktree 拒绝路径等错误分支没有自动化护栏
 * （历史上 MED-1 正是人工审计才发现的）。本文件用 `spawnSync` 只调用：
 *   - `prepare-assets.mjs --help` / 非法参数（都在读模型/写盘之前返回）；
 *   - `print-profile.sh <系统临时目录>`（纯计算，不写文件）；
 *   - `worktree-setup.sh --help` / 无参 / 主工作树与子目录/非 git 拒绝路径
 *     （均在创建软链之前 die）。
 *
 * 纪律：不创建 git worktree、不写 tracked 文件、不运行 assets write 模式；
 * 临时目录一律 `mkdtempSync(os.tmpdir())` 并在 afterAll 清理。
 */
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterAll, describe, expect, it } from 'vitest'

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url))
const PREPARE_ASSETS = join(REPO_ROOT, 'scripts', 'prepare-assets.mjs')
const PRINT_PROFILE = join(REPO_ROOT, 'scripts', 'print-profile.sh')
const WORKTREE_SETUP = join(REPO_ROOT, 'scripts', 'worktree-setup.sh')

/** 与 app 侧 src/main/index.ts 的 DEV_PROFILE_PATTERN 完全一致（M-4 的验收基准）。 */
const DEV_PROFILE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/
const CLI_TIMEOUT_MS = 120_000

/** 主工作树根 `.git` 是目录；linked worktree 的 `.git` 是文件。 */
const IS_MAIN_WORKTREE = (() => {
  try {
    return statSync(join(REPO_ROOT, '.git')).isDirectory()
  } catch {
    return false
  }
})()

const tempDirs: string[] = []
function makeTempDir(prefix = 'pet-scripts-test-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

afterAll(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

interface CliResult {
  status: number | null
  stdout: string
  stderr: string
  error: string | undefined
}

function run(command: string, args: string[], cwd = REPO_ROOT): CliResult {
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: CLI_TIMEOUT_MS
  })
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    error: result.error ? String(result.error.message ?? result.error) : undefined
  }
}

function expectFailure(result: CliResult, label: string): void {
  const detail = `${label}\nstatus=${String(result.status)}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`
  expect(result.error, detail).toBeUndefined()
  expect(result.status, detail).not.toBeNull()
  expect(result.status, detail).not.toBe(0)
}

describe('scripts/prepare-assets.mjs：CLI 参数校验（只读，不依赖私有模型）', () => {
  it('--help 退出码 0，输出包含 --check 与 .pmx 说明', () => {
    const result = run(process.execPath, [PREPARE_ASSETS, '--help'])
    expect(result.error).toBeUndefined()
    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toContain('--check')
    expect(result.stdout).toContain('.pmx')
  })

  it.each([
    ['--max-edge=0', '--max-edge'],
    ['--max-edge=abc', '--max-edge'],
    ['--bogus', '未知参数']
  ])('%s 非法参数退出码非 0（参数校验在读资产/写盘之前失败）', (arg, expectedText) => {
    const result = run(process.execPath, [PREPARE_ASSETS, arg])
    expectFailure(result, `prepare-assets.mjs ${arg}`)
    expect(result.stderr).toContain(expectedText)
  })
})

describe('scripts/print-profile.sh：目录名 → PET_PROFILE 规范化（纯计算）', () => {
  it('合法目录名 wt-a2 原样输出（带/不带尾斜杠一致）', () => {
    const root = makeTempDir()
    const dir = join(root, 'wt-a2')
    mkdirSync(dir)

    const plain = run('bash', [PRINT_PROFILE, dir])
    expect(plain.error).toBeUndefined()
    expect(plain.status, plain.stderr).toBe(0)
    expect(plain.stdout).toBe('wt-a2\n')
    expect(plain.stdout.trim()).toMatch(DEV_PROFILE_PATTERN)

    const withSlash = run('bash', [PRINT_PROFILE, `${dir}/`])
    expect(withSlash.status, withSlash.stderr).toBe(0)
    expect(withSlash.stdout).toBe(plain.stdout)
  })

  it('首字符非法 _wt → wt-_wt（与 worktree-setup.sh 打印值同一规则）', () => {
    const root = makeTempDir()
    const dir = join(root, '_wt')
    mkdirSync(dir)

    const result = run('bash', [PRINT_PROFILE, dir])
    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toBe('wt-_wt\n')
    expect(result.stdout.trim()).toMatch(DEV_PROFILE_PATTERN)
  })

  it('含空格/中文的目录名：匹配 app 正则且两次输出稳定', () => {
    const root = makeTempDir()
    const dir = join(root, '水 枪')
    mkdirSync(dir)

    const first = run('bash', [PRINT_PROFILE, dir])
    const second = run('bash', [PRINT_PROFILE, dir])
    expect(first.status, first.stderr).toBe(0)
    expect(second.status, second.stderr).toBe(0)

    const profile = first.stdout.trim()
    expect(profile).toBe(second.stdout.trim())
    expect(profile).toMatch(DEV_PROFILE_PATTERN)
    // 全为非 ASCII/非法字符 → 确定性 checksum 形式
    expect(profile).toMatch(/^wt-\d+$/)
  })

  it('超长目录名截断为 64 字符（app 正则上限）', () => {
    const root = makeTempDir()
    const dir = join(root, 'a'.repeat(80))
    mkdirSync(dir)

    const result = run('bash', [PRINT_PROFILE, dir])
    expect(result.status, result.stderr).toBe(0)
    const profile = result.stdout.trim()
    expect(profile).toHaveLength(64)
    expect(profile).toBe('a'.repeat(64))
    expect(profile).toMatch(DEV_PROFILE_PATTERN)
  })

  it('无参数退出码非 0（用法错误），stdout 不输出 profile', () => {
    const result = run('bash', [PRINT_PROFILE])
    expectFailure(result, 'print-profile.sh（无参数）')
    expect(result.status).toBe(2)
    expect(result.stdout).toBe('')
  })

  it('目录不存在退出码非 0', () => {
    const root = makeTempDir()
    const result = run('bash', [PRINT_PROFILE, join(root, 'not-created')])
    expectFailure(result, 'print-profile.sh（目录不存在）')
  })
})

describe('scripts/worktree-setup.sh：用法与只读拒绝路径（不创建 worktree）', () => {
  it('--help 退出码 0 并打印用法', () => {
    const result = run('bash', [WORKTREE_SETUP, '--help'])
    expect(result.error).toBeUndefined()
    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toContain('worktree-setup.sh <worktree-path>')
  })

  it('无参数退出码 2', () => {
    const result = run('bash', [WORKTREE_SETUP])
    expectFailure(result, 'worktree-setup.sh（无参数）')
    expect(result.status).toBe(2)
  })

  // 从 linked worktree 跑测试时 '.' 不是主工作树，脚本会进入软链逻辑（本测试要求只读）→ 只在主工作树运行。
  it.skipIf(!IS_MAIN_WORKTREE)('传入主工作树根 . 被拒绝（在创建软链之前 die）', () => {
    const result = run('bash', [WORKTREE_SETUP, '.'])
    expectFailure(result, 'worktree-setup.sh .')
    expect(result.stderr).toContain('目标是主工作树')
  })

  it('传入主工作树子目录 scripts/ 被拒绝（目标不是 worktree 根）', () => {
    const result = run('bash', [WORKTREE_SETUP, 'scripts'])
    expectFailure(result, 'worktree-setup.sh scripts')
    expect(result.stderr).toContain('目标不是 worktree 根')
  })

  it('传入非 git 的系统临时目录被拒绝', () => {
    const dir = makeTempDir()
    const result = run('bash', [WORKTREE_SETUP, dir])
    expectFailure(result, 'worktree-setup.sh <非 git 临时目录>')
    expect(result.stderr).toContain('目标不是 git worktree')
  })
})
