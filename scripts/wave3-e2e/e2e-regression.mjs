#!/usr/bin/env node
/**
 * E2E ⑥：回归（`pnpm smoke`，vrm + legacy-pmx 双后端；隔离 PET_PROFILE + 强制关闭强耦合）。
 *
 * 说明：smoke 会先跑 `node scripts/build-native.mjs`（仓库内构建产物 native/winlist/.build），
 * 再以 `PET_SMOKE_TEST=1` 启动 dev app；本脚本只负责隔离 env、采集 stdout、解析 `SMOKE_OK` JSON。
 *
 * 证据：`tests/tmp/wave3-e2e/<ts>-regression/`（smoke-vrm.log / smoke-legacy.log / result.json）。
 */
import { spawn } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

import {
  Assertions,
  ROOT,
  finalizeResult,
  makeRunDir,
  snapshotRealDshState,
  writeJson
} from './lib.mjs'

const runDir = makeRunDir('regression')
const assertions = new Assertions('regression-smoke')
const realBefore = snapshotRealDshState()
console.log(`[regression] runDir=${runDir}`)

/** 运行一次 smoke（超时杀进程树）。 */
function runSmoke(label, extraEnv, timeoutMs) {
  return new Promise((resolveRun) => {
    const env = { ...process.env, ELECTRON_RUN_AS_NODE: '', ...extraEnv }
    delete env.PET_DSH_COUPLING
    const child = spawn('pnpm', ['run', 'smoke'], {
      cwd: ROOT,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true
    })
    let stdout = ''
    let stderr = ''
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      try {
        process.kill(-child.pid, 'SIGKILL')
      } catch {
        try {
          child.kill('SIGKILL')
        } catch {
          // 已退出
        }
      }
    }, timeoutMs)
    child.stdout.on('data', (chunk) => {
      stdout += String(chunk)
      process.stdout.write(`[${label}] ${chunk}`)
    })
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk)
      process.stderr.write(`[${label}] ${chunk}`)
    })
    child.on('close', (code, signal) => {
      clearTimeout(timer)
      resolveRun({ label, code, signal, timedOut, stdout, stderr })
    })
    child.on('error', (error) => {
      clearTimeout(timer)
      resolveRun({ label, code: null, signal: null, timedOut, stdout, stderr: `${stderr}\nspawn error: ${error.message}` })
    })
  })
}

/** 从 stdout 提取 SMOKE_OK/SMOKE_FAIL JSON。 */
function extractMarker(stdout) {
  const ok = /^SMOKE_OK (.+)$/m.exec(stdout)
  const fail = /^SMOKE_FAIL (.+)$/m.exec(stdout)
  const parse = (match) => {
    if (!match) return null
    try {
      return JSON.parse(match[1])
    } catch {
      return { raw: match[1] }
    }
  }
  return { ok: parse(ok), fail: parse(fail) }
}

try {
  const runs = [
    {
      label: 'vrm',
      extraEnv: { PET_PROFILE: 'w3e2e-smoke-vrm', PET_DSH_COUPLING_DISABLE: '1' },
      timeoutMs: 240000
    },
    {
      label: 'legacy',
      extraEnv: {
        PET_PROFILE: 'w3e2e-smoke-legacy',
        PET_DSH_COUPLING_DISABLE: '1',
        PET_MODEL_BACKEND: 'legacy-pmx',
        PET_ANIM_BACKEND: 'legacy-pmx'
      },
      timeoutMs: 240000
    }
  ]
  const results = []
  for (const item of runs) {
    console.log(`\n[regression] 运行 pnpm smoke（${item.label}，隔离 PET_PROFILE=${item.extraEnv.PET_PROFILE}）…`)
    const result = await runSmoke(item.label, item.extraEnv, item.timeoutMs)
    writeFileSync(join(runDir, `smoke-${item.label}.stdout.log`), result.stdout)
    writeFileSync(join(runDir, `smoke-${item.label}.stderr.log`), result.stderr)
    const markers = extractMarker(result.stdout)
    assertions.check(`smoke-${item.label}-exit-0`, result.code === 0 && !result.timedOut, {
      code: result.code,
      signal: result.signal,
      timedOut: result.timedOut
    })
    assertions.check(`smoke-${item.label}-SMOKE_OK`, Boolean(markers.ok), markers.fail ?? null)
    if (markers.ok) {
      assertions.check(`smoke-${item.label}-render-ready`, markers.ok.wave1?.render?.ready === true, markers.ok.wave1?.render)
      assertions.check(
        `smoke-${item.label}-model-loaded`,
        markers.ok.wave1?.render?.model?.loaded === true,
        markers.ok.wave1?.render?.model
      )
    }
    results.push({ label: item.label, code: result.code, timedOut: result.timedOut, ok: Boolean(markers.ok), fail: markers.fail ?? null })
    writeJson(join(runDir, `smoke-${item.label}.json`), {
      label: item.label,
      extraEnv: item.extraEnv,
      code: result.code,
      timedOut: result.timedOut,
      markers
    })
  }
  writeJson(join(runDir, 'regression-evidence.json'), { runs: results })
} catch (error) {
  assertions.check('regression-exception', false, error instanceof Error ? error.stack ?? error.message : String(error))
}

const realAfter = snapshotRealDshState()
assertions.check(
  'real-dsh-pids-unchanged',
  JSON.stringify(realAfter.realDshPids) === JSON.stringify(realBefore.realDshPids),
  { before: realBefore.realDshPids, after: realAfter.realDshPids }
)
assertions.check('real-desktop-patch-unchanged', realAfter.desktopPatch === realBefore.desktopPatch, {
  before: realBefore.desktopPatch,
  after: realAfter.desktopPatch
})
assertions.check(
  'real-bridge-dir-unchanged',
  JSON.stringify(realAfter.bridgeDir) === JSON.stringify(realBefore.bridgeDir),
  { before: realBefore.bridgeDir, after: realAfter.bridgeDir }
)

process.exitCode = await finalizeResult(runDir, assertions, { runs: join(runDir, 'regression-evidence.json') })
