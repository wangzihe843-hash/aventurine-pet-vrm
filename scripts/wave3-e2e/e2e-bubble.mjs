#!/usr/bin/env node
/**
 * E2E ②：气泡同步（核心）—— 隔离 dev 版桌宠 + 临时桥目录，经真实 IPC/状态机链路验证：
 *   思考中占位 → 每段输出（assistant/message text）→ 停留 → 段间隐藏 → 下一段 → 结束消失。
 *
 * 方法：
 * - `HOME=<临时>` + `PET_PROFILE=w3e2e-bubble` + `PET_DSH_DIR=<临时桥目录>` 隔离（不碰真实 ~/.dsh）；
 * - `PET_DSH_COUPLING_DISABLE=1` 关闭强耦合（本用例只测气泡，不测耦合）；
 * - 远程调试（CDP）读 `.pet-bubble` DOM + 截图；事件通过写桥文件（status/control/events）注入。
 *
 * 证据：`tests/tmp/wave3-e2e/<ts>-bubble/`（timeline.jsonl / shots/*.png / result.json / 断言）。
 */
import { join } from 'node:path'

import {
  Assertions,
  Cdp,
  appendDshEvent,
  appendJsonl,
  delay,
  finalizeResult,
  freePort,
  isolatedEnv,
  launchPet,
  makeRunDir,
  readLog,
  tempBridgeDir,
  tempHome,
  waitCdpTarget,
  waitFor,
  waitMainLog,
  writeControl,
  writeJson,
  writeStatus
} from './lib.mjs'

const TEXT_A = '你好呀，我是砂金。今天想看我表演什么？'
const TEXT_B = '第一段看完了？那再给你变个小把戏，别眨眼。'

/** 与实现契约一致的期望值（design §5.1：clamp(2200 + 45*len, 2200, 9000)）。 */
function expectedDwell(text) {
  return Math.min(9000, Math.max(2200, 2200 + 45 * [...text].length))
}

const runDir = makeRunDir('bubble')
const home = tempHome(runDir)
const bridgeDir = tempBridgeDir(runDir)
const debugPort = await freePort()
const profile = 'w3e2e-bubble'
const assertions = new Assertions('bubble-sync')
console.log(`[bubble] runDir=${runDir} bridge=${bridgeDir} port=${debugPort}`)

/** 页面内气泡状态读取（DOM + 计算样式）。 */
const BUBBLE_STATE_EXPR = `(() => {
  const el = document.querySelector('.pet-bubble')
  if (!el) return { exists: false, text: '', visible: false, opacity: '0', visibility: 'hidden', rect: null }
  const style = getComputedStyle(el)
  const rect = el.getBoundingClientRect()
  return {
    exists: true,
    text: el.textContent || '',
    visible: style.visibility !== 'hidden' && Number.parseFloat(style.opacity) > 0.05,
    opacity: style.opacity,
    visibility: style.visibility,
    rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
  }
})()`

const env = isolatedEnv({
  home,
  profile,
  dshDir: bridgeDir,
  extra: { PET_DSH_COUPLING_DISABLE: '1', PET_MODEL_BACKEND: 'vrm' }
})

const pet = launchPet({ runDir, label: 'pet-dev', env, debugPort })
const timeline = []
let cdp = null
let mainLog = null
let currentPhase = 'boot'

/** 记录一次气泡采样（含相对时间）。 */
async function sample(label, extra = {}) {
  const state = await cdp.evaluate(BUBBLE_STATE_EXPR)
  const item = { t: Date.now(), label, ...state, ...extra }
  timeline.push(item)
  appendJsonl(join(runDir, 'timeline.jsonl'), item)
  return state
}

/** 截图（整页 + 气泡裁剪特写）。 */
async function shot(name, state) {
  const full = await cdp.screenshot(join(runDir, 'shots', `${name}-full.png`))
  let close = null
  if (state && state.rect && state.rect.width > 1 && state.rect.height > 1) {
    close = await cdp
      .screenshot(join(runDir, 'shots', `${name}-bubble.png`), { clip: state.rect })
      .catch((error) => ({ error: error instanceof Error ? error.message : String(error) }))
  }
  return { full, close }
}

try {
  // ---- 启动与隔离检查 ----
  const mainLogInfo = await waitMainLog(home, { profile })
  mainLog = mainLogInfo.file
  assertions.check('main-log-exists', Boolean(mainLog), mainLog)
  assertions.check(
    'isolated-userdata',
    mainLogInfo.userDataDir.includes(`aventurine-pet-${profile}`),
    mainLogInfo.userDataDir
  )
  assertions.check(
    'isolated-bridge-dir',
    bridgeDir.startsWith(runDir),
    bridgeDir
  )
  assertionLogNoRealDshTouch(mainLog)

  const target = await waitCdpTarget(debugPort, { timeoutMs: 90000 })
  cdp = await Cdp.connect(target.wsUrl)
  await cdp.send('Runtime.enable').catch(() => {})

  const { value: readyInfo } = await waitFor(
    () =>
      cdp.evaluate(`(() => {
        const debug = window.__aventurineDebug
        if (!debug) return null
        const loaded = !!(debug.model && debug.model.loaded === true)
        if (debug.ready !== true || !loaded) return null
        return { ready: true, loaded, bubbleCount: document.querySelectorAll('.pet-bubble').length }
      })()`),
    { timeoutMs: 120000, intervalMs: 400, label: 'pet ready' }
  )
  assertions.check('pet-ready-vrm-loaded', readyInfo.ready === true && readyInfo.bubbleCount === 1, readyInfo)
  await shot('00-ready', await sample('ready'))

  // ---- 桥上线（status online + control attached）----
  writeStatus(bridgeDir, { running: true })
  writeControl(bridgeDir, 'attached')
  const { value: dshStatus } = await waitFor(
    async () => {
      const status = await cdp.evaluate(`window.api.getDshStatus()`)
      return status && status.online === true ? status : null
    },
    { timeoutMs: 12000, intervalMs: 250, label: 'dsh online' }
  )
  assertions.check('bridge-online-via-ipc', dshStatus.online === true, dshStatus)
  appendJsonl(join(runDir, 'timeline.jsonl'), { t: Date.now(), label: 'bridge-online', dshStatus })

  // ---- 阶段 1：task/start → 思考中... ----
  currentPhase = 'thinking'
  appendDshEvent(bridgeDir, 'task/start', { agent: 'main', status: 'running', turn: 1, step: 1 })
  const { value: thinkingState } = await waitFor(
    async () => {
      const state = await cdp.evaluate(BUBBLE_STATE_EXPR)
      return state.visible && state.text === '思考中...' ? state : null
    },
    { timeoutMs: 10000, intervalMs: 100, label: '思考中气泡' }
  )
  assertions.check('thinking-bubble-shown', thinkingState.visible === true && thinkingState.text === '思考中...', {
    text: thinkingState.text,
    visibility: thinkingState.visibility,
    opacity: thinkingState.opacity
  })
  const thinkingShot = await shot('01-thinking', thinkingState)

  // ---- 阶段 2：assistant/message (text A) → 回复气泡 ----
  currentPhase = 'reply-a'
  const tsA = appendDshEvent(bridgeDir, 'session/event', {
    sessionId: 'w3e2e-session',
    eventType: 'assistant/message',
    turn: 1,
    step: 1,
    seq: 1,
    text: TEXT_A
  })
  const { value: replyA } = await waitFor(
    async () => {
      const state = await cdp.evaluate(BUBBLE_STATE_EXPR)
      if (!state.visible || state.text.length === 0) return null
      return state.text.includes('你好呀') ? { state, t: Date.now() } : null
    },
    { timeoutMs: 12000, intervalMs: 100, label: '回复气泡 A' }
  )
  const dwellAExpected = expectedDwell(replyA.state.text)
  assertions.check('reply-bubble-a-shown', replyA.state.visible === true && replyA.state.text.includes('你好呀'), {
    text: replyA.state.text,
    expectedDwellMs: dwellAExpected,
    sentAt: tsA
  })
  const replyAShot = await shot('02-reply-a', replyA.state)
  // 记录 A 停留起点（以可见采样时间近似）
  const aVisibleStart = replyA.t

  // ---- 阶段 3：段间隐藏（GAP 350ms）→ 思考中再次出现 ----
  currentPhase = 'gap'
  const { value: gapState } = await waitFor(
    async () => {
      const state = await cdp.evaluate(BUBBLE_STATE_EXPR)
      return state.exists && state.visible === false ? { state, t: Date.now() } : null
    },
    { timeoutMs: dwellAExpected + 8000, intervalMs: 40, label: '段间隐藏' }
  )
  const observedDwellA = gapState.t - aVisibleStart
  assertions.check(
    'segment-dwell-within-tolerance',
    observedDwellA >= dwellAExpected - 1000 && observedDwellA <= dwellAExpected + 2000,
    { observedDwellAMs: observedDwellA, expectedDwellMs: dwellAExpected }
  )
  const gapShot = await shot('03-gap', gapState.state)

  currentPhase = 'thinking-again'
  const { value: thinkingAgain } = await waitFor(
    async () => {
      const state = await cdp.evaluate(BUBBLE_STATE_EXPR)
      return state.visible && state.text === '思考中...' ? state : null
    },
    { timeoutMs: 5000, intervalMs: 50, label: '思考中（第二段前）' }
  )
  assertions.check('thinking-again-before-next', thinkingAgain.text === '思考中...', thinkingAgain.text)
  const thinkingAgainShot = await shot('04-thinking-again', thinkingAgain)

  // ---- 阶段 4：assistant/message (text B) → 下一段回复 ----
  currentPhase = 'reply-b'
  appendDshEvent(bridgeDir, 'session/event', {
    sessionId: 'w3e2e-session',
    eventType: 'assistant/message',
    turn: 2,
    step: 1,
    seq: 2,
    text: TEXT_B
  })
  const { value: replyB } = await waitFor(
    async () => {
      const state = await cdp.evaluate(BUBBLE_STATE_EXPR)
      return state.visible && state.text.length > 0 && state.text.includes('第一段看完了') ? state : null
    },
    { timeoutMs: 15000, intervalMs: 100, label: '回复气泡 B' }
  )
  assertions.check('reply-bubble-b-shown', replyB.visible === true && replyB.text.includes('第一段看完了'), replyB.text)
  const replyBShot = await shot('05-reply-b', replyB)

  // ---- 阶段 5：task/end → 队列播完 → 最终消失且保持隐藏 ----
  currentPhase = 'ended'
  appendDshEvent(bridgeDir, 'task/end', { agent: 'main', status: 'idle', turn: 2, step: 1 })
  const { value: hiddenState } = await waitFor(
    async () => {
      const state = await cdp.evaluate(BUBBLE_STATE_EXPR)
      return state.exists && state.visible === false ? { state, t: Date.now() } : null
    },
    { timeoutMs: expectedDwell(TEXT_B) + 10000, intervalMs: 100, label: '结束后隐藏' }
  )
  await delay(1200)
  const afterEnd = await cdp.evaluate(BUBBLE_STATE_EXPR)
  assertions.check('ended-bubble-hidden-persist', afterEnd.visible === false, {
    afterEnd,
    hiddenAt: hiddenState.t
  })
  const endedShot = await shot('06-ended', afterEnd)

  // ---- 渲染错误 / 日志无异常 ----
  const debugErrors = await cdp.evaluate(`window.__aventurineDebug ? window.__aventurineDebug.errors : null`)
  assertions.check(
    'no-new-renderer-errors',
    Array.isArray(debugErrors) ? debugErrors.length === 0 : true,
    Array.isArray(debugErrors) ? debugErrors.slice(-5) : debugErrors
  )
  const logTail = readLog(mainLog)
  assertions.check('no-renderer-crash', !/renderer.*crash|Renderer process.*gone/i.test(logTail), null)

  // ---- 截图证据落盘 ----
  const screenshots = {
    thinking: thinkingShot,
    replyA: replyAShot,
    gap: gapShot,
    thinkingAgain: thinkingAgainShot,
    replyB: replyBShot,
    ended: endedShot
  }
  const screenshotCount = Object.values(screenshots).filter((item) => item.full?.bytes > 0).length
  assertions.check('screenshots-at-least-3', screenshotCount >= 3, { screenshotCount })

  writeJson(join(runDir, 'bubble-evidence.json'), {
    textA: TEXT_A,
    textB: TEXT_B,
    expectedDwellA: dwellAExpected,
    observedDwellAMs: observedDwellA,
    thinking: thinkingState,
    replyA: replyA.state,
    gap: gapState.state,
    thinkingAgain,
    replyB,
    ended: afterEnd,
    mainLog,
    screenshots,
    timelineCount: timeline.length
  })
} catch (error) {
  assertions.check(
    `bubble-exception(${currentPhase})`,
    false,
    error instanceof Error ? error.stack ?? error.message : String(error)
  )
} finally {
  cdp?.close()
  const exit = await pet.close({ graceful: false })
  assertions.check('pet-exited', exit !== null, exit)
}

/** 日志断言：没有出现对真实 ~/.dsh 的写入/真实 DSH 进程操作痕迹（隔离自证）。 */
function assertionLogNoRealDshTouch(logFile) {
  const text = readLog(logFile)
  const touchedRealDsh = /DeepSeek Harness\.app\/Contents\/MacOS\/DeepSeek Harness(?!\/)/.test(text)
  const coupling = /\[dsh-lifecycle\].*(拉起 DSH|终止 DSH|级联退出)/.test(text)
  assertions.check('no-real-dsh-touch-in-log', !touchedRealDsh && !coupling, { touchedRealDsh, coupling })
}

process.exitCode = await finalizeResult(runDir, assertions, {
  mainLog,
  bridgeDir,
  profile,
  screenshotsDir: join(runDir, 'shots')
})
