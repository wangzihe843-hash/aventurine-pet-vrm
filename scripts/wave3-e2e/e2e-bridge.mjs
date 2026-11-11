#!/usr/bin/env node
/**
 * E2E ①：桥隔离（真实 DSH 内置 CLI + 临时 DSH_HOME + mock LLM）。
 *
 * 做法（安全）：
 * - 复用 `scripts/dsh-canary.mjs --keep`（其内部：临时 DSH_HOME + 临时 profile + 本地 mock LLM；
 *   `AVENTURINE_BRIDGE_DISABLE_LAUNCH=1` 保证不会拉起桌宠；不触碰运行中的真实 DSH）；
 * - 本脚本做**独立二次断言**：直接读 canary 保留的桥产物（events.jsonl / control.json / status.json），
 *   不依赖 canary 自己的断言结论；
 * - 前后快照真实 `~/.dsh`（桥目录 + desktop patch 签名）+ 真实 DSH 进程 pid，自证隔离。
 *
 * 证据：`tests/tmp/wave3-e2e/<ts>-bridge/`（canary.stdout.log / artifacts/ / result.json）。
 */
import { spawn } from 'node:child_process'
import { appendFileSync, copyFileSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import {
  Assertions,
  ROOT,
  delay,
  finalizeResult,
  makeRunDir,
  readJson,
  snapshotRealDshState,
  writeJson
} from './lib.mjs'

const MOCK_ASSISTANT_TEXT = 'canary-mock: 桥文本透传 OK。'
const MOCK_REASONING_SENTINEL = 'canary-mock-reasoning-sentinel'
const SUCCESS_TASK_SENTINEL = 'canary-success-sentinel'
const FAIL_TASK_SENTINEL = 'canary-fail-sentinel'

const runDir = makeRunDir('bridge')
const assertions = new Assertions('bridge-isolation')
const realBefore = snapshotRealDshState()
console.log(`[bridge] runDir=${runDir} 真实 DSH pids=${JSON.stringify(realBefore.realDshPids)}`)

/** 运行 canary 并收集 stdout/stderr。 */
function runCanary(timeoutMs) {
  return new Promise((resolveRun) => {
    const child = spawn(process.execPath, [join(ROOT, 'scripts/dsh-canary.mjs'), '--keep'], {
      cwd: ROOT,
      env: { ...process.env, AVENTURINE_BRIDGE_DISABLE_LAUNCH: '1' },
      stdio: ['ignore', 'pipe', 'pipe']
    })
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
    }, timeoutMs)
    child.stdout.on('data', (chunk) => (stdout += String(chunk)))
    child.stderr.on('data', (chunk) => (stderr += String(chunk)))
    child.on('close', (code, signal) => {
      clearTimeout(timer)
      resolveRun({ code, signal, stdout, stderr })
    })
  })
}

/** 在目录树里按文件名查找（只用于 canary 保留目录）。 */
function findFiles(root, name) {
  const out = []
  const walk = (dir) => {
    let entries
    try {
      entries = readdirSync(dir)
    } catch {
      return
    }
    for (const entry of entries) {
      const file = join(dir, entry)
      let stats
      try {
        stats = statSync(file)
      } catch {
        continue
      }
      if (stats.isDirectory()) walk(file)
      else if (entry === name) out.push(file)
    }
  }
  walk(root)
  return out.sort()
}

/** 解析 NDJSON。 */
function parseJsonl(text) {
  return text
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => {
      try {
        return JSON.parse(line)
      } catch {
        return null
      }
    })
    .filter(Boolean)
}

try {
  console.log('[bridge] 运行 pnpm dsh:canary --keep（离线失败回合 + 本地 mock 成功回合，约 40-90s）…')
  const result = await runCanary(300000)
  writeFileSync(join(runDir, 'canary.stdout.log'), result.stdout)
  writeFileSync(join(runDir, 'canary.stderr.log'), result.stderr)
  const combined = `${result.stdout}\n${result.stderr}`
  assertions.check('canary-exit-0', result.code === 0, { code: result.code, signal: result.signal })
  assertions.check('canary-pass-line', combined.includes('[dsh-canary] PASS'), combined.split('\n').filter((line) => line.includes('PASS')).slice(-2))

  const keptMatch = /临时目录保留在：(.*)$/m.exec(combined)
  const keptDir = keptMatch?.[1]?.trim() ?? null
  assertions.check('canary-kept-artifacts', Boolean(keptDir) && Boolean(keptDir && statSync(keptDir).isDirectory()), keptDir)

  if (keptDir) {
    // 独立复制证据（保留目录可能在下一次 canary 运行时变化，这里固化快照）。
    const artifacts = join(runDir, 'artifacts')
    mkdirSync(artifacts, { recursive: true })
    const eventFiles = findFiles(keptDir, 'events.jsonl')
    const controlFiles = findFiles(keptDir, 'control.json')
    const statusFiles = findFiles(keptDir, 'status.json')
    const copies = { events: [], controls: [], statuses: [] }
    for (const [kind, files] of [
      ['events', eventFiles],
      ['controls', controlFiles],
      ['statuses', statusFiles]
    ]) {
      for (const file of files) {
        const rel = file.slice(keptDir.length + 1).replace(/[\\/]/g, '_')
        const target = join(artifacts, `${kind}-${rel.slice(-80)}`)
        copyFileSync(file, target)
        copies[kind].push({ source: file, target })
      }
    }
    assertions.check('artifacts-found', copies.events.length >= 2 && copies.controls.length >= 1, {
      events: copies.events.length,
      controls: copies.controls.length,
      statuses: copies.statuses.length
    })

    // 独立断言 1：成功回合 events 里有 assistant/message 的非空 text（且等于 mock 文本）。
    let assistantTexts = []
    let sawAssistantEvent = false
    let userInputLeaked = false
    let reasoningLeaked = false
    let failTurnHasError = false
    let successTurnHasError = false
    for (const copy of copies.events) {
      const file = copy.source
      const events = parseJsonl(readFileSync(file, 'utf8'))
      const textPayloads = []
      for (const event of events) {
        const payload = event.payload ?? {}
        const text = typeof payload.text === 'string' ? payload.text : null
        if (payload.eventType === 'assistant/message' && typeof text === 'string') {
          sawAssistantEvent = true
          textPayloads.push(text)
          assistantTexts.push(text)
        }
        if (typeof text === 'string') {
          if (text.includes(SUCCESS_TASK_SENTINEL) || text.includes(FAIL_TASK_SENTINEL)) userInputLeaked = true
          if (text.includes(MOCK_REASONING_SENTINEL)) reasoningLeaked = true
        }
        if (event.type === 'task/error') {
          // 失败回合的 events 文件（目录名含 bridge-fail）应有 task/error；成功回合不应有。
          if (file.includes('fail')) failTurnHasError = true
          if (file.includes('bridge-ok')) successTurnHasError = true
        }
      }
      writeJson(join(artifacts, `${copy.target.split('/').pop()}.parsed.json`), { eventCount: events.length, textPayloads })
    }
    assertions.check('success-turn-assistant-text', sawAssistantEvent && assistantTexts.some((text) => text.includes('桥文本透传')), assistantTexts)
    assertions.check('assistant-text-matches-mock', assistantTexts.some((text) => text === MOCK_ASSISTANT_TEXT), { expected: MOCK_ASSISTANT_TEXT, got: assistantTexts })
    assertions.check('no-user-input-in-payload', !userInputLeaked, { userInputLeaked })
    assertions.check('no-reasoning-in-payload', !reasoningLeaked, { reasoningLeaked })
    assertions.check('fail-turn-has-task-error', failTurnHasError, { failTurnHasError })
    assertions.check('success-turn-no-task-error', !successTurnHasError, { successTurnHasError })

    // 独立断言 2：control 终态 detached + canary 观察到 attached→detached。
    const controlStates = copies.controls.map((copy) => readJson(copy.source)).filter(Boolean)
    assertions.check(
      'control-final-detached',
      controlStates.some((control) => control.action === 'detached' && control.schemaVersion === 1),
      controlStates.map((control) => ({ action: control.action, ts: control.ts, dshPid: control.dshPid }))
    )
    assertions.check(
      'control-attached-to-detached-observed',
      /control[^\n]*attached\s*→\s*detached/.test(combined) || combined.includes('attached → detached'),
      combined.split('\n').filter((line) => line.includes('control')).slice(-3)
    )

    // 独立断言 3：失败回合 status 有离线帧（offline:true）或 canary 已断言。
    const failStatus = copies.statuses
      .filter((copy) => copy.source.includes('fail'))
      .map((copy) => readJson(copy.source))
      .filter(Boolean)
    assertions.check(
      'fail-turn-offline-frame',
      failStatus.some((status) => status.offline === true) || /offline=true/.test(combined),
      failStatus.map((status) => ({ offline: status.offline, running: status.running }))
    )

    writeJson(join(runDir, 'bridge-evidence.json'), {
      keptDir,
      canaryExit: result.code,
      assistantTexts,
      controlStates,
      failStatus
    })
  }
} catch (error) {
  assertions.check('bridge-exception', false, error instanceof Error ? error.stack ?? error.message : String(error))
}

// 隔离自证：真实 ~/.dsh 桥目录 / desktop patch / 真实 DSH 进程 pid 均未变化。
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

process.exitCode = await finalizeResult(runDir, assertions, {
  canaryStdout: join(runDir, 'canary.stdout.log'),
  artifacts: join(runDir, 'artifacts')
})
