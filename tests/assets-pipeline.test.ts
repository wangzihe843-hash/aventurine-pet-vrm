/**
 * A6 集成测试：资源管线 scripts/prepare-assets.mjs 的 --check 模式（M0-3 回归护栏）。
 *
 * - 需要私有 `assets/model/`（不在 git 中）；新 clone / CI 上自动 skip。
 * - --check 只读：不应修改被 git 跟踪的 src/shared/assets-manifest.json。
 * - optimized/ 内应有 20 张贴图 + 1 个 PMX 字节副本；PMX 副本 sha256/大小 === manifest.pmx。
 *
 * 并发注意（独立复验 LOW-12）：本文件的 `--check` 虽然是只读，但会读 manifest 与 optimized/；
 * 不要与 `pnpm assets:prepare`（write 模式）在**同一工作树**并发运行，否则可能瞬时不一致。
 * CI / `pnpm test` 单进程执行不受影响。
 */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import type { AssetsManifest } from '@shared/types'

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url))
const SCRIPT_PATH = join(REPO_ROOT, 'scripts', 'prepare-assets.mjs')
const MODEL_DIR = join(REPO_ROOT, 'assets', 'model')
const OPTIMIZED_DIR = join(MODEL_DIR, 'optimized')
const MANIFEST_PATH = join(REPO_ROOT, 'src', 'shared', 'assets-manifest.json')

const hasPrivateModel = existsSync(MODEL_DIR)
const CLI_TIMEOUT_MS = 180_000

interface CliResult {
  code: number
  stdout: string
  stderr: string
}

function runCli(args: string[]): CliResult {
  try {
    const stdout = execFileSync(process.execPath, [SCRIPT_PATH, ...args], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: CLI_TIMEOUT_MS
    })
    return { code: 0, stdout, stderr: '' }
  } catch (error) {
    const failure = error as { status?: number | null; stdout?: string; stderr?: string }
    return {
      code: typeof failure.status === 'number' ? failure.status : -1,
      stdout: failure.stdout ?? '',
      stderr: failure.stderr ?? ''
    }
  }
}

function readManifest(): AssetsManifest {
  return JSON.parse(readFileSync(MANIFEST_PATH, 'utf8')) as AssetsManifest
}

function sha256File(filePath: string): string {
  return createHash('sha256').update(readFileSync(filePath)).digest('hex')
}

describe('assets pipeline：--help（不依赖私有模型）', () => {
  it('退出码 0，帮助包含 --check 与 PMX 副本说明', () => {
    const result = runCli(['--help'])
    expect(result.code, result.stderr).toBe(0)
    expect(result.stdout).toContain('--check')
    expect(result.stdout).toContain('.pmx')
  })
})

describe.skipIf(!hasPrivateModel)('assets pipeline：--check（需要私有 assets/model）', () => {
  it('--check 退出码 0，输出 CHECK OK 且包含 PMX 副本校验结果', () => {
    const result = runCli(['--check'])
    expect(result.code, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`).toBe(0)
    expect(result.stdout).toContain('CHECK OK')
    expect(result.stdout).toContain('pmxCopy=1')
  }, CLI_TIMEOUT_MS)

  it('--check 只读：不修改 tracked manifest', () => {
    const before = readFileSync(MANIFEST_PATH)
    const result = runCli(['--check'])
    expect(result.code, result.stderr).toBe(0)
    const after = readFileSync(MANIFEST_PATH)
    expect(after.equals(before)).toBe(true)
  }, CLI_TIMEOUT_MS)

  it('optimized/ 内 PMX 字节副本存在、是普通文件、大小/sha256 与 manifest.pmx 一致', () => {
    const manifest = readManifest()
    const pmxCopyPath = join(OPTIMIZED_DIR, manifest.pmx.file)
    expect(existsSync(pmxCopyPath)).toBe(true)

    const stat = statSync(pmxCopyPath)
    expect(stat.isFile()).toBe(true)
    expect(stat.size).toBe(manifest.pmx.bytes)
    expect(sha256File(pmxCopyPath)).toBe(manifest.pmx.sha256)

    // 源 PMX 也必须与 manifest 一致（管线只读源文件，绝不改写）
    const sourcePath = join(MODEL_DIR, manifest.pmx.file)
    expect(existsSync(sourcePath)).toBe(true)
    const sourceStat = statSync(sourcePath)
    expect(sourceStat.size).toBe(manifest.pmx.bytes)
    expect(sha256File(sourcePath)).toBe(manifest.pmx.sha256)
  })

  it('optimized/ 恰好 21 个受管产物（20 贴图 + 1 PMX 副本）', () => {
    const manifest = readManifest()
    const managedExtensions = new Set([
      '.png',
      '.bmp',
      '.jpg',
      '.jpeg',
      '.tga',
      '.dds',
      '.gif',
      '.pmx'
    ])
    const managed = readdirSync(OPTIMIZED_DIR).filter((name) => {
      const dot = name.lastIndexOf('.')
      return dot >= 0 && managedExtensions.has(name.slice(dot).toLowerCase())
    })
    expect(managed).toHaveLength(manifest.textures.length + 1)
    expect(managed).toContain(manifest.pmx.file)
  })
})
