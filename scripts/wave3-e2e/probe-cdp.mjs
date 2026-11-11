#!/usr/bin/env node
/**
 * CDP 探针（自检用）：隔离启动 dev 版桌宠 → 等 CDP → 读 debug.ready / 模型 / 气泡 DOM → 截屏 → 退出。
 * 仅验证「隔离启动 + 远程调试 + 断言基础设施」可用；完整气泡 E2E 见 e2e-bubble.mjs。
 *
 * 用法：node scripts/wave3-e2e/probe-cdp.mjs
 */
import { join } from 'node:path'

import {
  Assertions,
  Cdp,
  delay,
  finalizeResult,
  freePort,
  isolatedEnv,
  launchPet,
  makeRunDir,
  tempBridgeDir,
  tempHome,
  waitCdpTarget,
  waitFor,
  waitMainLog,
  writeJson
} from './lib.mjs'

const runDir = makeRunDir('probe-cdp')
const home = tempHome(runDir)
const bridgeDir = tempBridgeDir(runDir)
const debugPort = await freePort()
const assertions = new Assertions('probe-cdp')
console.log(`[probe] runDir=${runDir} port=${debugPort}`)

const env = isolatedEnv({
  home,
  profile: 'w3e2e-probe',
  dshDir: bridgeDir,
  extra: { PET_DSH_COUPLING_DISABLE: '1' }
})
const pet = launchPet({ runDir, label: 'pet-dev', env, debugPort })
let cdp = null
try {
  const mainLogInfo = await waitMainLog(home, { profile: 'w3e2e-probe' })
  assertions.check('main-log-exists', Boolean(mainLogInfo?.file), mainLogInfo)
  const target = await waitCdpTarget(debugPort, { timeoutMs: 90000 })
  assertions.check('cdp-target', Boolean(target.wsUrl), target.url)
  cdp = await Cdp.connect(target.wsUrl)
  await cdp.send('Runtime.enable').catch(() => {})

  const { value: debugInfo } = await waitFor(
    () =>
      cdp.evaluate(`(() => {
        const debug = window.__aventurineDebug
        if (!debug) return null
        const loaded = !!(debug.model && debug.model.loaded === true)
        if (debug.ready !== true || !loaded) return null
        return {
          ready: true,
          loaded,
          bubbleCount: document.querySelectorAll('.pet-bubble').length,
          appChildren: document.getElementById('app') ? document.getElementById('app').children.length : -1
        }
      })()`),
    { timeoutMs: 120000, intervalMs: 500, label: 'pet ready' }
  )
  assertions.check('debug-exposed', debugInfo.ready === true && debugInfo.loaded === true, debugInfo)

  const shot = await cdp.screenshot(join(runDir, 'shots', 'probe-ready.png'))
  assertions.check('screenshot', shot.bytes > 0, shot)
  writeJson(join(runDir, 'probe.json'), { debugInfo, shot, targets: target.url, mainLogInfo })
} catch (error) {
  assertions.check('probe-exception', false, error instanceof Error ? error.stack ?? error.message : String(error))
} finally {
  cdp?.close()
  const exit = await pet.close({ graceful: false })
  assertions.check('pet-exited', exit !== null, exit)
}

process.exitCode = await finalizeResult(runDir, assertions)
