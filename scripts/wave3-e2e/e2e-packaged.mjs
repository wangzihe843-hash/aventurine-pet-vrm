#!/usr/bin/env node
/**
 * E2E ④：打包版冷启动（dist/mac-arm64/AventurinePet.app，隔离环境，绝不耦合真实 DSH）。
 *
 * 覆盖（task-13 第 4 条）：
 *   - 打包产物资源齐全（app.asar / model / assets/{vrm,motions,expressions,props} / native/winlist）；
 *   - 隔离启动（`HOME=<tmp>` 不影响 Electron appData → 记录实际 userData；`PET_PROFILE` 打包版忽略）；
 *   - `PET_DSH_COUPLING_DISABLE=1` 强制关闭强耦合（并自证 main.log 无耦合动作）；
 *   - 透明 overlay 创建（main.log）、VRM 加载（debug.ready + model.loaded + 无资源错误）、
 *     `.pet-bubble` DOM 存在、fake 桥事件 → 气泡显示、截图；
 *   - 单实例锁（打包版）：启动第二实例应立即退出、第一实例存活；
 *   - winlist helper（Resources/native/winlist/winlist）被真实 spawn（高频采样 ps）。
 *
 * 证据：`tests/tmp/wave3-e2e/<ts>-packaged/`。
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import {
  Assertions,
  Cdp,
  PACKAGED_APP,
  PACKAGED_APP_BIN,
  appendDshEvent,
  delay,
  finalizeResult,
  freePort,
  isolatedEnv,
  launchPet,
  makeRunDir,
  readLog,
  snapshotRealDshState,
  tempBridgeDir,
  tempHome,
  waitCdpTarget,
  waitFor,
  waitLog,
  waitMainLog,
  writeControl,
  writeJson,
  writeStatus
} from './lib.mjs'

const runDir = makeRunDir('packaged')
const home = tempHome(runDir)
const bridgeDir = tempBridgeDir(runDir)
const debugPort = await freePort()
const assertions = new Assertions('packaged-coldstart')
const realBefore = snapshotRealDshState()
console.log(`[packaged] runDir=${runDir} app=${PACKAGED_APP} port=${debugPort}`)

const BUBBLE_STATE_EXPR = `(() => {
  const el = document.querySelector('.pet-bubble')
  if (!el) return { exists: false, text: '', visible: false }
  const style = getComputedStyle(el)
  const rect = el.getBoundingClientRect()
  return {
    exists: true,
    text: el.textContent || '',
    visible: style.visibility !== 'hidden' && Number.parseFloat(style.opacity) > 0.05,
    rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
  }
})()`

/** 轮询 ps，捕捉 winlist helper 的短命进程。 */
async function watchWinlistSpawn(timeoutMs = 20000) {
  const hits = []
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    const out = spawnSync('/usr/bin/pgrep', ['-f', 'Resources/native/winlist/winlist'], { encoding: 'utf8' })
    for (const line of (out.stdout ?? '').split('\n')) {
      const pid = Number(line.trim())
      if (Number.isInteger(pid) && pid > 0 && !hits.includes(pid)) hits.push(pid)
    }
    if (hits.length > 0) break
    await delay(80)
  }
  return hits
}

let cdp = null
let pet = null
let mainLog = null
try {
  // ---- 打包资源检查 ----
  const resources = join(PACKAGED_APP, 'Contents/Resources')
  const expectedPaths = [
    PACKAGED_APP_BIN,
    join(resources, 'app.asar'),
    join(resources, 'model'),
    join(resources, 'assets/vrm'),
    join(resources, 'assets/motions'),
    join(resources, 'native/winlist/winlist')
  ]
  const missing = expectedPaths.filter((file) => !existsSync(file))
  assertions.check('packaged-resources-present', missing.length === 0, { missing, expectedPaths })
  const vrmFiles = existsSync(join(resources, 'assets/vrm'))
    ? (await import('node:fs')).readdirSync(join(resources, 'assets/vrm')).filter((name) => name.endsWith('.vrm'))
    : []
  assertions.check('packaged-has-vrm-asset', vrmFiles.length > 0, vrmFiles.slice(0, 5))

  // ---- 前置：没有已运行的打包版（避免单实例锁干扰）----
  const beforePids = spawnSync('/usr/bin/pgrep', ['-f', 'AventurinePet.app/Contents/MacOS/AventurinePet'], { encoding: 'utf8' })
  assertions.check('no-previous-packaged-instance', (beforePids.stdout ?? '').trim().length === 0, (beforePids.stdout ?? '').trim())

  // ---- 启动打包版（耦合强制关闭 + 隔离桥目录）----
  const env = isolatedEnv({
    home,
    profile: 'w3e2e-packaged', // 打包版忽略；保留以证明「忽略也不影响隔离」
    dshDir: bridgeDir,
    extra: { PET_DSH_COUPLING_DISABLE: '1' }
  })
  const launchIso = new Date().toISOString()
  pet = launchPet({ runDir, label: 'pet-packaged', env, debugPort, packaged: true })
  const mainLogInfo = await waitMainLog(home, { packaged: true, timeoutMs: 60000 })
  mainLog = mainLogInfo.file
  assertions.check('packaged-main-log', Boolean(mainLog), { mainLog, userDataDir: mainLogInfo.userDataDir })
  assertions.check(
    'packaged-userdata-default-not-isolated',
    mainLogInfo.userDataDir.endsWith('/aventurine-pet') || mainLogInfo.userDataDir.endsWith('/AventurinePet'),
    mainLogInfo.userDataDir
  )
  /** 只看本次启动之后的日志行（main.log 可能含历史记录）。 */
  const newLogText = () => {
    const lines = readLog(mainLog).split('\n')
    const after = []
    for (const line of lines) {
      const match = /^(\d{4}-\d{2}-\d{2}T[\d:.]+Z)/.exec(line)
      if (!match) continue
      if (match[1] >= launchIso) after.push(line)
    }
    return after.join('\n')
  }
  writeFileSync(join(runDir, 'launch-iso.txt'), launchIso)

  // 注：`[main] … overlays created` 是 console.log（stdout），不进 main.log；透明 overlay 创建以 stdout 为准。
  await waitFor(() => readLog(pet.logFile).includes('overlays created on workArea'), {
    timeoutMs: 90000,
    label: 'overlay created (stdout)'
  })
  assertions.check('overlay-window-created-log', readLog(pet.logFile).includes('overlays created on workArea'), 'overlays created on workArea')
  assertions.check(
    'main-process-config-registered',
    newLogText().includes('[config] 配置 IPC 已注册'),
    newLogText().split('\n').filter((line) => line.includes('[config]')).slice(-2)
  )

  // ---- CDP：ready / 模型 / 气泡 DOM ----
  const target = await waitCdpTarget(debugPort, { timeoutMs: 120000 })
  cdp = await Cdp.connect(target.wsUrl)
  await cdp.send('Runtime.enable').catch(() => {})
  const { value: readyInfo } = await waitFor(
    () =>
      cdp.evaluate(`(() => {
        const debug = window.__aventurineDebug
        if (!debug) return null
        const loaded = !!(debug.model && debug.model.loaded === true)
        if (debug.ready !== true || !loaded) return null
        return {
          ready: true,
          loaded,
          vrmLoaded: !!debug.vrm,
          humanoidBoneCount: debug.vrm?.humanoidBoneCount ?? null,
          animationClip: debug.animation?.clipId ?? null,
          bubbleCount: document.querySelectorAll('.pet-bubble').length,
          errors: Array.isArray(debug.errors) ? debug.errors.slice(-5) : []
        }
      })()`),
    { timeoutMs: 150000, intervalMs: 500, label: 'packaged pet ready' }
  )
  assertions.check('packaged-vrm-loaded', readyInfo.ready === true && readyInfo.loaded === true, readyInfo)
  assertions.check('packaged-bubble-dom-exists', readyInfo.bubbleCount === 1, readyInfo.bubbleCount)
  assertions.check('packaged-no-renderer-errors', readyInfo.errors.length === 0, readyInfo.errors)
  const readyShot = await cdp.screenshot(join(runDir, 'shots', 'packaged-ready.png'))
  assertions.check('packaged-screenshot', readyShot.bytes > 0, readyShot)

  // ---- 桥事件 → 气泡（验证打包版 dsh-watch + dialogue 链路）----
  writeStatus(bridgeDir, { running: true })
  writeControl(bridgeDir, 'attached')
  await waitFor(
    async () => {
      const status = await cdp.evaluate(`window.api.getDshStatus()`)
      return status && status.online === true ? status : null
    },
    { timeoutMs: 15000, intervalMs: 250, label: 'packaged dsh online' }
  )
  appendDshEvent(bridgeDir, 'task/start', { agent: 'main', status: 'running', turn: 1, step: 1 })
  const { value: thinking } = await waitFor(
    async () => {
      const state = await cdp.evaluate(BUBBLE_STATE_EXPR)
      return state.exists && state.visible && state.text === '思考中...' ? state : null
    },
    { timeoutMs: 15000, intervalMs: 100, label: 'packaged 思考中气泡' }
  )
  assertions.check('packaged-bubble-thinking', thinking.text === '思考中...', thinking)
  appendDshEvent(bridgeDir, 'session/event', {
    sessionId: 'w3e2e-packaged',
    eventType: 'assistant/message',
    turn: 1,
    step: 1,
    seq: 1,
    text: '打包版气泡同步验证：这是一句来自 DSH 桥的回复文本。'
  })
  const { value: reply } = await waitFor(
    async () => {
      const state = await cdp.evaluate(BUBBLE_STATE_EXPR)
      return state.exists && state.visible && state.text.includes('打包版气泡同步验证') ? state : null
    },
    { timeoutMs: 15000, intervalMs: 100, label: 'packaged 回复气泡' }
  )
  const thinkingShot = await cdp.screenshot(join(runDir, 'shots', 'packaged-thinking.png')).catch(() => null)
  const replyShot = await cdp.screenshot(join(runDir, 'shots', 'packaged-reply.png'), {
    clip: reply.rect.width > 1 ? reply.rect : null
  }).catch(() => null)
  assertions.check('packaged-bubble-reply', reply.visible === true && reply.text.includes('打包版'), reply.text)

  // ---- winlist helper spawn（高频采样）----
  const winlistHits = await watchWinlistSpawn(20000)
  assertions.check('winlist-helper-spawned', winlistHits.length > 0, winlistHits)

  // ---- 单实例锁：第二实例应立即退出、第一实例存活 ----
  const envSecond = isolatedEnv({
    home,
    profile: 'w3e2e-packaged-2',
    dshDir: bridgeDir,
    extra: { PET_DSH_COUPLING_DISABLE: '1' }
  })
  const second = launchPet({ runDir, label: 'pet-packaged-second', env: envSecond, debugPort: null, packaged: true })
  const secondExit = await waitFor(() => (second.exitInfo !== null ? second.exitInfo : null), {
    timeoutMs: 30000,
    intervalMs: 100,
    label: '第二实例退出'
  }).catch(() => null)
  assertions.check(
    'packaged-single-instance-second-exits',
    Boolean(secondExit) && secondExit.value.code === 0,
    secondExit?.value ?? second.exitInfo
  )
  await second.close({ graceful: false, deadlineMs: 5000 })
  assertions.check('packaged-first-instance-alive', pet.exitInfo === null, pet.exitInfo)
  const aliveProbe = await cdp.evaluate(`document.querySelectorAll('.pet-bubble').length >= 0`).catch(() => null)
  assertions.check('packaged-first-instance-cdp-responsive', aliveProbe !== null, aliveProbe)

  // ---- 本次日志：无资源错误 / 无耦合动作（隔离自证）----
  const tailText = newLogText()
  const tailLines = tailText.split('\n')
  const assetErrorPattern = /模型加载失败|贴图加载失败|加载失败|ENOENT|ERR_FILE_NOT_FOUND|Failed to load|asset .*missing/i
  const assetErrors = tailLines.filter((line) => assetErrorPattern.test(line))
  assertions.check('packaged-no-asset-errors', assetErrors.length === 0, assetErrors.slice(-5))
  const couplingLines = tailLines.filter((line) => /\[dsh-lifecycle\].*(拉起 DSH|终止 DSH|级联退出)/.test(line))
  assertions.check('packaged-coupling-disabled-no-actions', couplingLines.length === 0, couplingLines.slice(-5))
  assertions.check(
    'packaged-no-real-open',
    !tailText.includes('open -b com.deepseek.dsh') && !tailText.includes('launch via test hook'),
    null
  )

  writeJson(join(runDir, 'packaged-evidence.json'), {
    app: PACKAGED_APP,
    mainLog,
    userDataDir: mainLogInfo.userDataDir,
    readyInfo,
    thinking,
    reply,
    winlistHits,
    secondExit: secondExit?.value ?? second.exitInfo,
    shots: { ready: readyShot, thinking: thinkingShot, reply: replyShot }
  })
} catch (error) {
  assertions.check('packaged-exception', false, error instanceof Error ? error.stack ?? error.message : String(error))
} finally {
  fatalCleanup()
}

/** 清理：确保打包版实例全部退出（耦合已禁用，安全）。 */
function fatalCleanup() {
  const pids = (spawnSync('/usr/bin/pgrep', ['-f', 'AventurinePet.app/Contents/MacOS/AventurinePet'], { encoding: 'utf8' }).stdout ?? '')
    .split('\n')
    .map((line) => Number(line.trim()))
    .filter((pid) => Number.isInteger(pid) && pid > 0)
  // 只清理本 run 启动的实例：校验命令行包含本 app 路径（即 dist 内打包版；不是用户安装的其它 app）。
  const ourPids = pids.filter((pid) => {
    const ps = spawnSync('/bin/ps', ['-p', String(pid), '-o', 'command=', '-ww'], { encoding: 'utf8' })
    return (ps.stdout ?? '').includes(join(PACKAGED_APP, 'Contents/MacOS/AventurinePet'))
  })
  for (const pid of ourPids) {
    try {
      process.kill(pid, 'SIGKILL')
    } catch {
      // 已退出
    }
  }
}

// 隔离自证：真实 DSH 进程/~/.dsh 关键文件未变。
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

process.exitCode = await finalizeResult(runDir, assertions, { mainLog, bridgeDir, debugPort })
