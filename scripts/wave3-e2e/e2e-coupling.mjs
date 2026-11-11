#!/usr/bin/env node
/**
 * E2E ③：强耦合（fake DSH，绝不碰真实 DeepSeek Harness）。
 *
 * 覆盖（design §4.1 / task-13 第 3 条）：
 *   A. pet 启动 → 拉起 fake；status online → PAIRED；fake 被 SIGKILL → 恢复流程重启成功；
 *      pet 显式退出（`window.api.quit()`）→ fake 收到 SIGTERM 并退出 → pet 退出。
 *   B. HMR 竞态：control detached → 1.5s grace 内 attached → 取消退出（不重启、不级联）。
 *   C. fake 消失且重启失败（一次性拉起 wrapper）→ 重启上限后 **DEGRADED 常驻**
 *      （2026-11-11 兼容性安全 v2：不再 cascade 自杀，保证用户能打开 DSH 修桌宠）。
 *   D. control detached + fake 消失 → 级联退出（dsh-exit 或 dsh-gone，记录实际原因）。
 *   E. 显式退出回归（2026-11-11 实机 bug）：detached + fake 消失 → 跟随退出，
 *      **绝不重启 fake**（旧实现会被 3s tick 抢跑误判为崩溃并重新拉起 DSH）。
 *   F. 兼容性安全 v2：v4 compat 不兼容（dshRange 不含当前 DSH 版本）→ 立即 DEGRADED
 *      （不杀/不重启 fake）；fake 消失 → 跟随退出 `dsh-degraded`（0 次重启）。
 *
 * 可选场景过滤：`node scripts/wave3-e2e/e2e-coupling.mjs e`（排障/快速回归，默认跑全部；
 * 可选 a/b/c/d/e/f）。
 *
 * 安全闸门（任一失败立即 SIGKILL pet，不进入任何退出流程）：
 *   1. `PET_DSH_TEST_HOOKS=1` + 唯一模式 `w3e2e-fake-dsh` + 拉起命令指向本 run 的 fake 脚本；
 *   2. PATH 前置 shim `open`（若实现被破坏回退到真实 `open -b com.deepseek.dsh`，只会被记录、不执行）；
 *   3. 只有观测到 main.log `launch via test hook` + fake 启动日志后，才允许后续操作；
 *   4. 对 fake 发信号前用 `ps -p <pid> -o command=` 校验命令行含本 run 的 fake 脚本路径。
 *
 * 证据：`tests/tmp/wave3-e2e/<ts>-coupling/`（scenarios/{a,b,c,d,e}/* + result.json）。
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import {
  Assertions,
  Cdp,
  delay,
  finalizeResult,
  freePort,
  isolatedEnv,
  isPidAlive,
  launchPet,
  makeRunDir,
  readFakeLog,
  readLog,
  readPidFile,
  snapshotRealDshState,
  waitCdpTarget,
  waitFakeLog,
  waitFor,
  waitLog,
  waitMainLog,
  waitPetExit,
  writeControl,
  writeFakeDshScript,
  writeJson,
  writeStatus
} from './lib.mjs'

const PATTERN = 'w3e2e-fake-dsh'
const SYSTEM_PATH = process.env.PATH ?? '/usr/bin:/bin'
const runDir = makeRunDir('coupling')
const shimDir = join(runDir, 'shim')
const scenariosRoot = join(runDir, 'scenarios')
const openShimLog = join(runDir, 'open-shim.log')
const assertions = new Assertions('coupling')
console.log(`[coupling] runDir=${runDir}`)

/* ------------------------------- 安全基础设施 ------------------------------ */

// PATH 前置 shim：若实现契约被破坏而回退到真实 `open -b com.deepseek.dsh`，这里只记录、不执行。
mkdirSync(shimDir, { recursive: true })
writeFileSync(
  join(shimDir, 'open'),
  `#!/bin/sh\necho "$(date +%s) $*" >> ${JSON.stringify(openShimLog)}\nexit 0\n`,
  { mode: 0o755 }
)

const realDshBefore = snapshotRealDshState()
console.log(`[coupling] 真实 DSH pids（只读快照）：${JSON.stringify(realDshBefore.realDshPids)}`)

/** shell 单引号转义。 */
function sh(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`
}

/** 读进程命令行（安全校验用）。 */
function commandOf(pid) {
  const result = spawnSync('/bin/ps', ['-p', String(pid), '-o', 'command=', '-ww'], { encoding: 'utf8' })
  return (result.stdout ?? '').trim()
}

/** 只对「确认属于本 run 的 fake 进程」发信号（红线：绝不碰真实 DSH）。 */
function safeKillFake(pid, scenarioPath, signal = 'SIGKILL') {
  if (!Number.isInteger(pid) || pid <= 0) return { ok: false, reason: 'invalid-pid' }
  const command = commandOf(pid)
  const expected = join(scenarioPath, `${PATTERN}.mjs`)
  if (!command.includes(expected)) return { ok: false, reason: 'command-mismatch', command, expected }
  try {
    process.kill(pid, signal)
    return { ok: true, command }
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error), command }
  }
}

/** 每个场景目录（dirs: bridge/home/shots）。 */
async function prepareScenarioDir(id) {
  const dir = join(scenariosRoot, id)
  for (const sub of ['', 'bridge', 'home']) mkdirSync(join(dir, sub), { recursive: true })
  return dir
}

/** 写拉起脚本：direct = 每次 exec fake；once = 仅第一次启动 fake（后续调用静默成功）。 */
function writeLaunchScript(dir, fakeScript, { once = false } = {}) {
  const script = join(dir, once ? 'launch-once.sh' : 'launch-direct.sh')
  const fakeLog = join(dir, 'fake.log')
  const fakePid = join(dir, 'fake.pid')
  const countFile = join(dir, 'launch-count.txt')
  const direct = `#!/bin/sh\nexec ${sh(process.execPath)} ${sh(fakeScript)} --log ${sh(fakeLog)} --pidfile ${sh(fakePid)}\n`
  const onceScript = `#!/bin/sh\nCOUNT=$(cat ${sh(countFile)} 2>/dev/null || echo 0)\nCOUNT=$((COUNT + 1))\necho "$COUNT" > ${sh(countFile)}\nif [ "$COUNT" -eq 1 ]; then\n  exec ${sh(process.execPath)} ${sh(fakeScript)} --log ${sh(fakeLog)} --pidfile ${sh(fakePid)}\nfi\nexit 0\n`
  writeFileSync(script, once ? onceScript : direct, { mode: 0o755 })
  return { script, fakeLog, fakePid }
}

/**
 * 启动隔离 pet（强耦合开启）并通过安全闸门。
 * @returns {Promise<{pet:any, dir:string, mainLog:string, fakeLog:string, fakePid:string, debugPort:number, profile:string, bridgeDir:string}>}
 */
async function startCoupledPet(scenario, { launchOnce = false } = {}) {
  const profile = `w3e2e-cpl-${scenario}`
  // dev 版 userData 在真实 appData 下（macOS Electron 不认子进程 HOME），用 PET_PROFILE 后缀隔离。
  // 每次启动前删掉上次 run 的 profile 目录：否则 main.log 是追加的，waitLog/readLog 会命中历史
  // 日志（假 PASS / 假 FAIL）。只删本脚本自己的测试 profile，不碰真实桌宠 userData。
  rmSync(join(homedir(), 'Library/Application Support', `aventurine-pet-${profile}`), {
    recursive: true,
    force: true
  })
  const dir = await prepareScenarioDir(scenario)
  const bridgeDir = join(dir, 'bridge')
  // fake 脚本路径必须唯一且含 pattern（pgrep -f 匹配 + 安全信号校验都依赖它）。
  const templateFake = writeFakeDshScript(runDir)
  const fakeScript = join(dir, `${PATTERN}.mjs`)
  writeFileSync(fakeScript, readFileSync(templateFake, 'utf8'))
  const { script: launchScript, fakeLog, fakePid } = writeLaunchScript(dir, fakeScript, { once: launchOnce })
  const debugPort = await freePort()
  const env = isolatedEnv({
    home: join(dir, 'home'),
    profile,
    dshDir: bridgeDir,
    extra: {
      PET_DSH_COUPLING: '1',
      PET_DSH_TEST_HOOKS: '1',
      PET_DSH_TEST_PROCESS_PATTERN: PATTERN,
      PET_DSH_TEST_LAUNCH_CMD: launchScript,
      PET_DSH_TEST_QUIT_DELAY_MS: '1500',
      PATH: `${shimDir}:${SYSTEM_PATH}`
    }
  })
  const pet = launchPet({ runDir: dir, label: 'pet-dev', env, debugPort })
  const mainLogInfo = await waitMainLog(join(dir, 'home'), { profile })
  const mainLog = mainLogInfo.file
  try {
    // 安全闸门 1：测试钩子的拉起命令被真实调用。
    const hookLine = await waitLog(mainLog, '[dsh-process] launch via test hook', { timeoutMs: 15000 })
    assertions.check(`safety-hook-effective-${scenario}`, Boolean(hookLine), hookLine)
    // 安全闸门 2：fake 进程真的被拉起。
    await waitFakeLog(fakeLog, (entry) => entry.event === 'start', {
      timeoutMs: 15000,
      label: `fake start ${scenario}`
    })
    const pid = readPidFile(fakePid)
    assertions.check(`safety-fake-started-${scenario}`, pid !== null && isPidAlive(pid), { pid })
    // 安全闸门 3：真实 `open` 未被调用（PATH shim 无记录）。
    assertions.check(`no-real-open-${scenario}`, !existsSync(openShimLog), existsSync(openShimLog) ? readFileSync(openShimLog, 'utf8') : 'shim 未被调用')
    return { pet, dir, mainLog, fakeLog, fakePid, debugPort, profile, bridgeDir }
  } catch (error) {
    // 安全闸门失败：立即 SIGKILL（不触发 before-quit），绝不进入退出流程。
    await pet.close({ graceful: false, deadlineMs: 5000 })
    throw error
  }
}

/** 等 PAIRED（status online 或 attached 触发）。 */
async function waitPaired(mainLog) {
  await waitLog(mainLog, '进入 PAIRED', { timeoutMs: 15000 })
  return readLog(mainLog)
    .split('\n')
    .find((line) => line.includes('进入 PAIRED')) ?? null
}

/** 通过 CDP 触发桌宠显式退出（等价用户点「退出」）；连接可能随退出立即断开。 */
async function quitViaCdp(debugPort) {
  const target = await waitCdpTarget(debugPort, { timeoutMs: 60000 })
  const cdp = await Cdp.connect(target.wsUrl)
  try {
    await cdp.evaluate(`window.api && typeof window.api.quit === 'function' ? window.api.quit() : null`).catch(() => {})
  } finally {
    cdp.close()
  }
}

/** 读 fake 启动次数。 */
function fakeStartCount(fakeLog) {
  return readFakeLog(fakeLog).filter((entry) => entry.event === 'start').length
}

/* --------------------------- 场景 A：拉起/重启/退出 ------------------------- */

async function scenarioA() {
  console.log('\n[scenario A] 拉起 → fake 被杀后重启恢复 → pet 退出 SIGTERM fake')
  const ctx = await startCoupledPet('a')
  try {
    await writeStatus(ctx.bridgeDir, { running: true })
    writeControl(ctx.bridgeDir, 'attached')
    const paired = await waitPaired(ctx.mainLog)
    assertions.check('A-paired', Boolean(paired), paired)

    const pid1 = readPidFile(ctx.fakePid)
    assertions.check('A-fake-pid-1', pid1 !== null && isPidAlive(pid1), { pid1 })

    const killResult = safeKillFake(pid1, ctx.dir, 'SIGKILL')
    assertions.check('A-safe-kill-fake', killResult.ok, killResult)
    await waitFakeLog(ctx.fakeLog, (entry) => entry.event === 'start', {
      timeoutMs: 25000,
      label: 'fake restart'
    })
    await waitFor(() => fakeStartCount(ctx.fakeLog) >= 2, { timeoutMs: 25000, label: 'fake 启动次数≥2' })
    const pid2 = readPidFile(ctx.fakePid)
    assertions.check('A-fake-restarted', pid2 !== null && pid2 !== pid1 && isPidAlive(pid2), { pid1, pid2 })
    await waitLog(ctx.mainLog, 'DSH 已恢复', { timeoutMs: 25000 })
    assertions.check('A-recovery-logged', true, 'DSH 已恢复')
    assertions.check('A-pet-alive-after-recovery', ctx.pet.exitInfo === null, ctx.pet.exitInfo)

    // pet 显式退出 → before-quit 终止 fake（SIGTERM）→ pet 退出
    await quitViaCdp(ctx.debugPort)
    await waitFakeLog(ctx.fakeLog, (entry) => entry.event === 'sigterm', { timeoutMs: 15000 })
    assertions.check('A-fake-got-sigterm', true, 'sigterm')
    const exit = await waitPetExit(ctx.pet, { timeoutMs: 20000 })
    assertions.check('A-pet-exited-after-terminating-fake', exit !== null, exit)
    await waitLog(ctx.mainLog, '已终止 DSH', { timeoutMs: 20000 })
    assertions.check('A-terminate-logged', true, '已终止 DSH')
    await waitFor(() => !isPidAlive(readPidFile(ctx.fakePid) ?? 0), { timeoutMs: 8000, label: 'fake 退出' })
    assertions.check('A-fake-exited', true, readPidFile(ctx.fakePid))
    writeJson(join(ctx.dir, 'scenario.json'), { result: 'PASS', pid1, pid2, exit })
  } catch (error) {
    assertions.check('A-exception', false, error instanceof Error ? error.stack ?? error.message : String(error))
  } finally {
    await ctx.pet.close({ graceful: false, deadlineMs: 5000 })
  }
}

/* --------------------- 场景 B：detached→grace 内 attached ------------------- */

async function scenarioB() {
  console.log('\n[scenario B] detached → grace 内 attached → 取消级联')
  const ctx = await startCoupledPet('b')
  try {
    await writeStatus(ctx.bridgeDir, { running: true })
    writeControl(ctx.bridgeDir, 'attached')
    await waitPaired(ctx.mainLog)

    writeControl(ctx.bridgeDir, 'detached')
    await waitLog(ctx.mainLog, '收到 detached', { timeoutMs: 10000 })
    await delay(400)
    writeControl(ctx.bridgeDir, 'attached')
    await delay(2600)

    const log = readLog(ctx.mainLog)
    assertions.check('B-detached-observed', log.includes('收到 detached'), '收到 detached')
    assertions.check('B-no-cascade', !/级联退出/.test(log), '无级联退出')
    assertions.check('B-pet-alive', ctx.pet.exitInfo === null, ctx.pet.exitInfo)
    assertions.check('B-no-restart', fakeStartCount(ctx.fakeLog) === 1, { startCount: fakeStartCount(ctx.fakeLog) })
    writeJson(join(ctx.dir, 'scenario.json'), { result: 'PASS', startCount: fakeStartCount(ctx.fakeLog) })

    await quitViaCdp(ctx.debugPort)
    const exit = await waitPetExit(ctx.pet, { timeoutMs: 20000 })
    assertions.check('B-cleanup-exit', exit !== null, exit)
  } catch (error) {
    assertions.check('B-exception', false, error instanceof Error ? error.stack ?? error.message : String(error))
  } finally {
    await ctx.pet.close({ graceful: false, deadlineMs: 5000 })
  }
}

/* ------------- 场景 C：重启失败 → DEGRADED 常驻（v2，不再 cascade） ------------- */

async function scenarioC() {
  console.log('\n[scenario C] fake 消失 + 重启不成功 → DEGRADED(crash-recovery-failed) 常驻、不自杀')
  const ctx = await startCoupledPet('c', { launchOnce: true })
  try {
    await writeStatus(ctx.bridgeDir, { running: true })
    writeControl(ctx.bridgeDir, 'attached')
    await waitPaired(ctx.mainLog)

    const pid = readPidFile(ctx.fakePid)
    const killResult = safeKillFake(pid, ctx.dir, 'SIGKILL')
    assertions.check('C-safe-kill-fake', killResult.ok, killResult)

    // v2：重启 ≤2 次仍失败 → DEGRADED 常驻（不再 cascade 退出；用户可打开 DSH 修桌宠）。
    await waitLog(ctx.mainLog, '进入 DEGRADED', { timeoutMs: 45000 })
    const log = readLog(ctx.mainLog)
    assertions.check('C-degraded', log.includes('进入 DEGRADED'), '进入 DEGRADED')
    assertions.check('C-degraded-reason', /crash-recovery-failed/.test(log), 'crash-recovery-failed')
    assertions.check('C-no-cascade', !/级联退出/.test(log), '不应级联退出')
    assertions.check('C-pet-alive', ctx.pet.exitInfo === null, ctx.pet.exitInfo)
    assertions.check('C-no-successful-restart', fakeStartCount(ctx.fakeLog) === 1, {
      startCount: fakeStartCount(ctx.fakeLog)
    })
    // DEGRADED 下 before-quit 放行（不杀 DSH）→ 可正常清理退出。
    await quitViaCdp(ctx.debugPort)
    const exit = await waitPetExit(ctx.pet, { timeoutMs: 20000 })
    assertions.check('C-cleanup-exit', exit !== null, exit)
    writeJson(join(ctx.dir, 'scenario.json'), {
      result: 'PASS',
      degraded: true,
      startCount: fakeStartCount(ctx.fakeLog)
    })
  } catch (error) {
    assertions.check('C-exception', false, error instanceof Error ? error.stack ?? error.message : String(error))
  } finally {
    await ctx.pet.close({ graceful: false, deadlineMs: 5000 })
  }
}

/* -------------- 场景 D：detached + fake 消失 → 级联退出（任一原因） --------- */

async function scenarioD() {
  console.log('\n[scenario D] detached + fake 消失 → 级联退出')
  const ctx = await startCoupledPet('d', { launchOnce: true })
  try {
    await writeStatus(ctx.bridgeDir, { running: true })
    writeControl(ctx.bridgeDir, 'attached')
    await waitPaired(ctx.mainLog)

    writeControl(ctx.bridgeDir, 'detached')
    await waitLog(ctx.mainLog, '收到 detached', { timeoutMs: 10000 })
    const pid = readPidFile(ctx.fakePid)
    const killResult = safeKillFake(pid, ctx.dir, 'SIGKILL')
    assertions.check('D-safe-kill-fake', killResult.ok, killResult)

    const exit = await waitPetExit(ctx.pet, { timeoutMs: 35000 })
    assertions.check('D-pet-cascaded-exit', exit !== null, exit)
    await waitLog(ctx.mainLog, '级联退出', { timeoutMs: 30000 })
    const log = readLog(ctx.mainLog)
    const cascadeLine = log.split('\n').find((line) => line.includes('级联退出'))
    assertions.check('D-cascade-logged', Boolean(cascadeLine), cascadeLine)
    writeJson(join(ctx.dir, 'scenario.json'), { result: 'PASS', exit, cascadeLine })
  } catch (error) {
    assertions.check('D-exception', false, error instanceof Error ? error.stack ?? error.message : String(error))
  } finally {
    await ctx.pet.close({ graceful: false, deadlineMs: 5000 })
  }
}

/* -------- 场景 E：显式退出（detached + 进程消失）→ 跟随退出且绝不重启 DSH -------- */
/*
 * 2026-11-11 实机 bug 回归：用户关闭 DSH 后，旧实现的 3s tick 抢在 1.5s detached grace
 * 之前判「进程消失 = 崩溃」并 open 重启 DSH（桌宠没退出、DSH 反而被重新拉起）。
 * 本场景用 launch-direct（错误重启会真的启动第 2 个 fake）断言：进程退出 + 0 次重启。
 */

async function scenarioE() {
  console.log('\n[scenario E] detached + fake 消失 → 跟随退出，且绝不重启 fake')
  const ctx = await startCoupledPet('e')
  try {
    await writeStatus(ctx.bridgeDir, { running: true })
    writeControl(ctx.bridgeDir, 'attached')
    await waitPaired(ctx.mainLog)

    writeControl(ctx.bridgeDir, 'detached')
    await waitLog(ctx.mainLog, '收到 detached', { timeoutMs: 10000 })
    const pid = readPidFile(ctx.fakePid)
    const killResult = safeKillFake(pid, ctx.dir, 'SIGKILL')
    assertions.check('E-safe-kill-fake', killResult.ok, killResult)

    // 新实现：grace 到期探测到进程已不在 → 直接级联退出（不重启）。
    const exit = await waitPetExit(ctx.pet, { timeoutMs: 20000 })
    assertions.check('E-pet-exited', exit !== null, exit)
    await waitLog(ctx.mainLog, '级联退出', { timeoutMs: 20000 })
    const log = readLog(ctx.mainLog)
    const cascadeLine = log.split('\n').find((line) => line.includes('级联退出'))
    assertions.check('E-cascade-dsh-exit', /级联退出（dsh-exit/.test(log), cascadeLine)
    assertions.check('E-no-restart', fakeStartCount(ctx.fakeLog) === 1, {
      startCount: fakeStartCount(ctx.fakeLog)
    })
    assertions.check('E-no-recovery-attempt', !log.includes('尝试重启 DSH'), '不应出现重启恢复日志')
    writeJson(join(ctx.dir, 'scenario.json'), {
      result: 'PASS',
      exit,
      cascadeLine,
      startCount: fakeStartCount(ctx.fakeLog)
    })
  } catch (error) {
    assertions.check('E-exception', false, error instanceof Error ? error.stack ?? error.message : String(error))
  } finally {
    await ctx.pet.close({ graceful: false, deadlineMs: 5000 })
  }
}

/* ---------- 场景 F：v4 compat 不兼容 → DEGRADED；不杀/不重启；消失则跟随退出 ---------- */

async function scenarioF() {
  console.log('\n[scenario F] v4 compat 不兼容 → 立即 DEGRADED；不杀/不重启；fake 消失 → 跟随退出 dsh-degraded')
  const ctx = await startCoupledPet('f')
  try {
    await writeStatus(ctx.bridgeDir, { running: true })
    // v4 桥自述一个不包含当前 DSH（0.2.2-rc.1）的范围 → 兼容判定 incompatible。
    writeControl(ctx.bridgeDir, 'attached', {
      bridgeVersion: 4,
      compat: { bridgeVersion: 4, controlSchema: 1, dshRange: '>=9.0.0 <10.0.0' }
    })
    await waitLog(ctx.mainLog, '进入 DEGRADED', { timeoutMs: 20000 })
    const log1 = readLog(ctx.mainLog)
    assertions.check('F-degraded', /进入 DEGRADED（compat-incompatible/.test(log1), 'compat-incompatible')
    assertions.check('F-pet-alive', ctx.pet.exitInfo === null, ctx.pet.exitInfo)
    assertions.check('F-start-count-1', fakeStartCount(ctx.fakeLog) === 1, {
      startCount: fakeStartCount(ctx.fakeLog)
    })
    // 等 1 个 tick 以上：DEGRADED 下不得杀 fake、不得重启 fake。
    await delay(4500)
    const pid = readPidFile(ctx.fakePid)
    assertions.check('F-fake-still-alive', pid !== null && isPidAlive(pid), { pid })
    assertions.check('F-no-restart', fakeStartCount(ctx.fakeLog) === 1, {
      startCount: fakeStartCount(ctx.fakeLog)
    })
    // fake 消失（模拟 DSH 退出）→ 降级期单向跟随退出（dsh-degraded，不重启、不发信号）。
    const killResult = safeKillFake(pid, ctx.dir, 'SIGKILL')
    assertions.check('F-safe-kill-fake', killResult.ok, killResult)
    const exit = await waitPetExit(ctx.pet, { timeoutMs: 20000 })
    assertions.check('F-pet-exited', exit !== null, exit)
    await waitLog(ctx.mainLog, '级联退出', { timeoutMs: 15000 })
    const log2 = readLog(ctx.mainLog)
    const cascadeLine = log2.split('\n').find((line) => line.includes('级联退出'))
    assertions.check('F-cascade-dsh-degraded', /级联退出（dsh-degraded/.test(log2), cascadeLine)
    assertions.check('F-no-restart-after-exit', fakeStartCount(ctx.fakeLog) === 1, {
      startCount: fakeStartCount(ctx.fakeLog)
    })
    writeJson(join(ctx.dir, 'scenario.json'), {
      result: 'PASS',
      cascadeLine,
      startCount: fakeStartCount(ctx.fakeLog)
    })
  } catch (error) {
    assertions.check('F-exception', false, error instanceof Error ? error.stack ?? error.message : String(error))
  } finally {
    await ctx.pet.close({ graceful: false, deadlineMs: 5000 })
  }
}

/* --------------------------------- 主流程 --------------------------------- */

// 可选场景过滤（排障/快速回归）：`node scripts/wave3-e2e/e2e-coupling.mjs e`
const ONLY_SCENARIO = (process.argv[2] ?? '').trim().toLowerCase()

try {
  if (ONLY_SCENARIO) {
    const selected = {
      a: scenarioA,
      b: scenarioB,
      c: scenarioC,
      d: scenarioD,
      e: scenarioE,
      f: scenarioF
    }[ONLY_SCENARIO]
    if (!selected) throw new Error(`unknown scenario: ${ONLY_SCENARIO}（可选 a/b/c/d/e/f）`)
    await selected()
  } else {
    await scenarioA()
    await scenarioB()
    await scenarioC()
    await scenarioD()
    await scenarioE()
    await scenarioF()
  }
} catch (error) {
  assertions.check('coupling-exception', false, error instanceof Error ? error.stack ?? error.message : String(error))
} finally {
  // 清理本 run 可能残留的 fake 进程（严格校验命令行属于本 run，绝不误杀真实进程）。
  for (const pidLine of spawnSync('/usr/bin/pgrep', ['-f', PATTERN], { encoding: 'utf8' }).stdout.split('\n')) {
    const pid = Number(pidLine.trim())
    if (!Number.isInteger(pid) || pid <= 0) continue
    const command = commandOf(pid)
    if (command.includes(join(runDir, 'scenarios')) && command.includes(`${PATTERN}.mjs`)) {
      try {
        process.kill(pid, 'SIGKILL')
      } catch {
        // 已退出
      }
    }
  }

  // 隔离自证：真实 DSH 进程仍在、~/.dsh 关键文件未变、real `open` 未被调用。
  const realAfter = snapshotRealDshState()
  assertions.check(
    'real-dsh-pids-unchanged',
    JSON.stringify(realAfter.realDshPids) === JSON.stringify(realDshBefore.realDshPids),
    { before: realDshBefore.realDshPids, after: realAfter.realDshPids }
  )
  assertions.check('real-desktop-patch-unchanged', realAfter.desktopPatch === realDshBefore.desktopPatch, {
    before: realDshBefore.desktopPatch,
    after: realAfter.desktopPatch
  })
  // 真实 DSH 运行期间会持续写 status.json（5s 心跳）与 events.jsonl（会话事件）——那是宿主自身
  // 活动，不是本 E2E 的副作用。隔离自证只校验：本 E2E 未改真实桥的 control.json、未新增文件。
  const controlSig = (snapshot) => snapshot.bridgeDir['control.json'] ?? null
  const bridgeFiles = (snapshot) => Object.keys(snapshot.bridgeDir).sort()
  assertions.check(
    'real-bridge-control-unchanged',
    controlSig(realAfter) === controlSig(realDshBefore),
    { before: controlSig(realDshBefore), after: controlSig(realAfter) }
  )
  assertions.check(
    'real-bridge-files-unchanged',
    JSON.stringify(bridgeFiles(realAfter)) === JSON.stringify(bridgeFiles(realDshBefore)),
    { before: bridgeFiles(realDshBefore), after: bridgeFiles(realAfter) }
  )
  assertions.check(
    'open-shim-not-invoked',
    !existsSync(openShimLog),
    existsSync(openShimLog) ? readFileSync(openShimLog, 'utf8') : 'shim 未被调用'
  )
}

process.exitCode = await finalizeResult(runDir, assertions, {
  scenariosRoot,
  realDshBefore: { pids: realDshBefore.realDshPids, desktopPatch: realDshBefore.desktopPatch },
  openShimLog
})
