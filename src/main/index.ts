/**
 * 主进程入口 —— Wave 0 集成骨架（M0-1 smoke 守护 HIGH 缺陷修复 + Wave 1 开工前置）
 *
 * 本文件只保留「app 生命周期 + 集成接线」，业务实现按领域拆分：
 * - `src/main/app-context.ts`：overlay 注册表 + 类型安全 broadcast；
 * - `src/main/protocol.ts`：`pet-asset://` 自定义协议（PMX / 优化贴图资源）；
 * - `src/main/ipc/index.ts` + `window/config/desktop.ts`：invoke handler 聚合注册；
 * - 窗口创建仍内联在本文件（A1 是否迁入 `src/main/windows/**` 由 PLAN §7 决定）。
 *
 * Wave 1 开工前置已实现：
 * 1. overlay 几何 = `display.workArea`（不覆盖菜单栏 / Dock，见 PLAN §17.3-2）；
 * 2. 焦点 / 激活：`focusable:false` + `acceptFirstMouse` + `showInactive()`；
 *    macOS 用 accessory 激活策略并隐藏 Dock 图标（桌宠不抢前台、不进 Cmd+Tab）；
 * 3. 生命周期 / 安全：打包版单实例锁、dev `PET_PROFILE` userData 隔离、
 *    will-navigate / will-redirect / window.open / 权限请求全拒（dev 只放行 dev server 同源）；
 * 4. `pet-asset://` 接线（`registerSchemesAsPrivileged` 在 whenReady 之前调用）；
 * 5. 显示器拓扑 / workArea 变化 → 同步 overlay bounds + 广播 `screens-updated`；
 * 6. 冒烟守护**只在** `PET_SMOKE_TEST=1` 时挂载，加载 watchdog 在 did-finish-load 成功后清除，
 *    `failSmoke` 带 SMOKE_TEST 门禁 —— 正常 `pnpm dev` / `start` / `electron .` 不会被守护误杀。
 *
 * 冒烟模式（`PET_SMOKE_TEST=1`，见 package.json scripts）：
 * 加载完成后做端到端断言（workArea 几何 / 焦点 / preload 白名单 / 协议 PMX 字节 /
 * 贴图 CORS 不 taint / windows-updated & screens-updated 事件 / window-info），
 * 成功打印一行 `SMOKE_OK {...}` 并 `app.exit(0)`；任何失败打印 `SMOKE_FAIL {...}` 并 `app.exit(1)`。
 */
import { app, BrowserWindow, screen, session } from 'electron'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { is } from '@electron-toolkit/utils'
import { DEFAULT_CONFIG } from '@shared/config'
import { IPC_EVENTS } from '@shared/ipc'
import type { OverlayWindowInfo, PetConfig } from '@shared/types'
import assetsManifest from '@shared/assets-manifest.json'
import { createAppContext } from './app-context'
import { resolveBackendFlags } from './backend-flags'
import { decideDevCaptureExit } from './dev-capture-exit'
import { registerIpcHandlers } from './ipc'
import { getDisplayInfos, getIgnoreMouseAppliedState } from './ipc/window'
import {
  getAssetRoots,
  petAssetUrl,
  registerPetAssetProtocol,
  registerPetAssetScheme
} from './protocol'
import { createLogger } from './logger'
import type { Logger } from './logger'
import { createCommittedUrlTracker } from './security/navigation-guard'
import { installRendererNetworkGuard, maskUrl } from './security/renderer-network-guard'
import { createTray, getActiveTray } from './tray'
import { createCrashRecovery } from './windows/crash-recovery'
import type { CrashRecovery } from './windows/crash-recovery'
import {
  destroySettingsWindow,
  getSettingsWindow,
  openSettingsWindow
} from './windows/settings-window'
import {
  createOverlayWindowsManager,
  getActiveOverlayWindowsManager,
  getOverlayConstructOnlySnapshot
} from './windows/overlay-manager'

/**
 * 冒烟模式开关：`PET_SMOKE_TEST=1 pnpm smoke`。
 *
 * 注意（A-02）：该开关在**生产态也可达** —— `pnpm smoke:file`（package.json）就是
 * `pnpm build` 后以 `PET_SMOKE_TEST=1` 运行打包产物。因此**不要**给它加 `is.dev` 门控；
 * 需要开发态门控的是 dev capture（`PET_DEV_CAPTURE_*`，见 R-06）。
 */
const SMOKE_TEST = process.env['PET_SMOKE_TEST'] === '1'

/** 冒烟模式加载 watchdog（did-finish-load 成功后清除，避免正常模式/成功路径误报） */
const SMOKE_TIMEOUT_MS = 60_000

/** 冒烟报告阶段独立 watchdog（加载已完成，防止 executeJavaScript 卡死导致 CI 永挂） */
const SMOKE_REPORT_TIMEOUT_MS = 35_000

/** 加载完成后等待首帧渲染再做冒烟断言的时间 */
const SMOKE_REPORT_DELAY_MS = 500

/** 主进程广播事件后，等待 renderer 收到的稳定窗口 */
const SMOKE_EVENT_SETTLE_MS = 200

/** dev 专用 userData profile 名白名单（只允许安全字符，防路径穿越 / 注入） */
const DEV_PROFILE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/

/* ------------------------------ dev 姿态截图回环（Lead/anim 自用） ------------------------------ */

/**
 * Dev 截图回环：设置 `PET_DEV_CAPTURE_DIR` 后，在非冒烟模式下等 renderer ready，
 * 依次调 `window.__aventurineDebug.debugSetPose(<id>)` 截图写盘后退出。
 *
 * 用途：B3 姿态库没有美术、AI 无法"看"屏幕 —— 用这个闭环让 anim teammate 自己读写图调姿态：
 *   PET_DEV_CAPTURE_DIR=tests/tmp/anim-caps \
 *   PET_DEV_CAPTURE_POSES=stand,sit,sitEdge,sleep,pat,drag,fall \
 *   PET_PROFILE=anim pnpm dev
 *
 * 可选环境变量：
 * - `PET_DEV_CAPTURE_POSES` 逗号分隔姿态 id（空 = 只抓当前 idle 一帧）
 * - `PET_DEV_CAPTURE_MORPHS` 可选 JSON，如 `{"照れ":1}`，每张截图前设置、截后清零
 * - `PET_DEV_CAPTURE_READY_TIMEOUT_MS`（默认 25000）
 * - `PET_DEV_CAPTURE_HOLD_MS`（默认 500；姿态过渡后等待稳定再截）
 * 输出：`<dir>/01-stand.png` + 同名 `.json`（debug 快照），最后打印 `DEV_CAPTURE_OK`。
 * 仅本地开发工具；不影响正常启动（未设置 env 时零成本）。
 */
const DEV_CAPTURE_DIR = process.env['PET_DEV_CAPTURE_DIR']
const DEV_CAPTURE_POSES = (process.env['PET_DEV_CAPTURE_POSES'] ?? '')
  .split(',')
  .map((value) => value.trim())
  .filter((value) => value.length > 0)
const DEV_CAPTURE_MORPHS = process.env['PET_DEV_CAPTURE_MORPHS'] ?? ''
const DEV_CAPTURE_READY_TIMEOUT_MS = Number(process.env['PET_DEV_CAPTURE_READY_TIMEOUT_MS'] ?? 25000)
const DEV_CAPTURE_HOLD_MS = Number(process.env['PET_DEV_CAPTURE_HOLD_MS'] ?? 500)
/** `PET_DEV_CAPTURE_SETTINGS=1` 时额外打开设置窗截图（B6 视觉验收）。 */
const DEV_CAPTURE_SETTINGS = process.env['PET_DEV_CAPTURE_SETTINGS'] === '1'
/**
 * `PET_DEV_CAPTURE_PROP_VISIBLE=1|0`：截图前强制显示/隐藏手持道具（水枪）用于验收；
 * 未设置 = 按 clip 规则（正常行为）。默认空字符串 = 不干预。
 */
const DEV_CAPTURE_PROP_VISIBLE = process.env['PET_DEV_CAPTURE_PROP_VISIBLE'] ?? ''
/** 首张截图前的预热等待（ms；观察自主行为/走路/气泡时用，默认 0）。 */
const DEV_CAPTURE_WARMUP_MS = Number(process.env['PET_DEV_CAPTURE_WARMUP_MS'] ?? 0)
/** 无姿态列表时连续抓帧数（观察行为/气泡；默认 1）。 */
const DEV_CAPTURE_FRAMES = Math.max(1, Number(process.env['PET_DEV_CAPTURE_FRAMES'] ?? 1))
/** 连续抓帧间隔（ms；默认 1500）。 */
const DEV_CAPTURE_INTERVAL_MS = Math.max(200, Number(process.env['PET_DEV_CAPTURE_INTERVAL_MS'] ?? 1500))
/** 每张截图前把宠物瞬移到视口底部居中（姿态 contact sheet 用；1 = 开）。 */
const DEV_CAPTURE_CENTER = process.env['PET_DEV_CAPTURE_CENTER'] === '1'
/** 可选：截图前强制触发一次行为活动（B1 activity id，如 sit/walkTo/sleep/coin）。 */
const DEV_CAPTURE_ACTIVITY = process.env['PET_DEV_CAPTURE_ACTIVITY'] ?? ''
/** 截图前设置 autonomous=false / dshLink=false（姿态 contact sheet 用，避免宠物走开）。 */
const DEV_CAPTURE_IDLE = process.env['PET_DEV_CAPTURE_IDLE'] === '1'
/** 可选：`PET_DEV_CAPTURE_GAZE=25,0` 强制注视并打印收敛读数（调试 look-at 用）。 */
const DEV_CAPTURE_GAZE = process.env['PET_DEV_CAPTURE_GAZE'] ?? ''
/** 可选：`PET_DEV_CAPTURE_MOOD=pat|drag|...` 临时覆盖动画层 mood（实机检查外部 VMD 用）。 */
const DEV_CAPTURE_MOOD = process.env['PET_DEV_CAPTURE_MOOD'] ?? ''
/**
 * 可选：`PET_DEV_CAPTURE_CONFIG='{"sizePercent":100,"opacity":1}'` 截图前临时 setConfig
 * （V5/V6 近景验收：面部表情/材质细节目录）。结束后恢复改前原值。
 */
const DEV_CAPTURE_CONFIG = process.env['PET_DEV_CAPTURE_CONFIG'] ?? ''
/**
 * 可选：拖拽实机抓图（V7 用户反馈：被拎起应侧身）。
 * 值：`right` / `left` / `both`（默认空 = 不抓）。流程：悬停 → mousedown → 分步拖动 →
 * 抓 `drag-<dir>-dragging.png` → mouseup → 抓 `drag-<dir>-released.png`。
 */
const DEV_CAPTURE_DRAG = process.env['PET_DEV_CAPTURE_DRAG'] ?? ''
/**
 * 可选：放置实机验证（2026-11-09「松手停在窗口上」修复）。
 * 值：`<cx>,<cy>` = 目标「宠物身体中心」的 overlay 本地 CSS 坐标。
 * 流程：悬停宠物 → mousedown → 分 14 步拖到目标点 → 停 ~320ms（松手速度归零）→ mouseup
 * （慢速松手走「放置」语义：可坐窗沿吸附 / 沿太高原地站定）→ 等 1.2s 抓 `place-after.png`。
 */
const DEV_CAPTURE_PLACE = process.env['PET_DEV_CAPTURE_PLACE'] ?? ''
/** 可选：走路实机抓图（V7：走路头朝运动方向）。1 = 触发 walkTo 后连续抓 3 帧。 */
const DEV_CAPTURE_WALK = process.env['PET_DEV_CAPTURE_WALK'] === '1'
/**
 * 可选：mood 序列抓图（error 倒地/起身等状态机实机证据）。
 * 格式 `mood:ms,mood:ms,...`，如 `dshError:900,dshError:3200,idle:400`：
 * 依次 `debugSetAnimationMood(mood)` → 等待 ms → 抓一帧。
 */
const DEV_CAPTURE_MOOD_SEQUENCE = process.env['PET_DEV_CAPTURE_MOOD_SEQUENCE'] ?? ''
/**
 * 可选：强制「窗沿坐风格」（dev A/B 抓图用）：`sit` / `lie`；空 = 按自动规则。
 * 2026-11-10 用于逐尺寸对比「坐/趴躺」渲染包围盒，确认各尺寸下头是否完整可见。
 */
const DEV_CAPTURE_SIT_STYLE = process.env['PET_DEV_CAPTURE_SIT_STYLE'] ?? ''
/** 抓图动作的动态等待（ms；拖拽/走路用）。 */
const DEV_CAPTURE_ACTION_HOLD_MS = Math.max(100, Number(process.env['PET_DEV_CAPTURE_ACTION_HOLD_MS'] ?? 600))
/**
 * dev 启动逐帧捕获：`PET_DEV_CAPTURE_STARTUP_FRAMES=N`（N>0 启用）。
 * 在 renderer `did-finish-load` 后立即用 `webContents.beginFrameSubscription` 抓前 N 个呈现帧，
 * 逐帧缩到 `PET_DEV_CAPTURE_STARTUP_WIDTH` 宽写 PNG（`startup-001.png`…）并采样 debug 快照，
 * 抓完打印 `DEV_CAPTURE_STARTUP_OK` 后按现有 dev-capture 流程退出。用于「启动到 idle 稳定」
 * 的逐帧证据（透明帧 = 模型未显示；宽 bbox = rest T-pose；窄 bbox = idle）。
 * 未设置 env 时零成本，不影响普通 `runDevCapture`。
 */
const DEV_CAPTURE_STARTUP_FRAMES = Math.max(
  0,
  Math.floor(Number(process.env['PET_DEV_CAPTURE_STARTUP_FRAMES'] ?? 0))
)
/** 启动逐帧捕获时长上限（ms；模型加载慢时到点即停，避免无限抓帧）。 */
const DEV_CAPTURE_STARTUP_MAX_MS = Math.max(
  500,
  Number(process.env['PET_DEV_CAPTURE_STARTUP_MAX_MS'] ?? 14000)
)
/** 启动逐帧捕获落盘 PNG 宽度（px；缩小以降低主进程编码开销，alpha 保留供 bbox 分析）。 */
const DEV_CAPTURE_STARTUP_WIDTH = Math.max(
  160,
  Math.round(Number(process.env['PET_DEV_CAPTURE_STARTUP_WIDTH'] ?? 512))
)
/** 启动逐帧捕获期间 renderer debug 快照采样间隔（ms）。 */
const DEV_CAPTURE_STARTUP_DEBUG_INTERVAL_MS = Math.max(
  50,
  Number(process.env['PET_DEV_CAPTURE_STARTUP_DEBUG_INTERVAL_MS'] ?? 100)
)
/** 帧订阅兜底宽限（ms）：超过 `MAX_MS + 本值` 仍无帧 = 窗口不可见 / 合成器暂停。 */
const DEV_CAPTURE_STARTUP_FRAME_GRACE_MS = 8000

/** 进程级单例上下文：overlay 注册表 + 事件广播。 */
const appContext = createAppContext()

/** 进程级 logger（bootstrap 内创建；创建前的日志走 console 兜底）。 */
let appLogger: Logger | null = null

/**
 * R-05：生产态崩溃恢复策略（bootstrap 内创建；冒烟模式下保持 null）。
 * `hardenWebContents` 与 `app.on('child-process-gone')` 共用同一实例（限流状态按 webContents 共享）。
 */
let crashRecovery: CrashRecovery | null = null

/* ------------------------------ 冒烟模式状态 ------------------------------ */

let smokeProcessGuardsAttached = false
let smokeLoadWatchdog: ReturnType<typeof setTimeout> | null = null
let smokeReportWatchdog: ReturnType<typeof setTimeout> | null = null
let smokeReportTimer: ReturnType<typeof setTimeout> | null = null
let smokeReporting = false
let smokeReported = false
let smokeFailed = false

/** 把任意错误转成可序列化的短字符串。 */
function toErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === 'string') return error
  try {
    return JSON.stringify(error)
  } catch {
    return String(error)
  }
}

/** 冒烟断言失败时中断后续报告流程的内部信号（真正输出由 failSmoke 负责）。 */
class SmokeAssertionError extends Error {}

/* ------------------------------ 冒烟：失败 / 守护 ------------------------------ */

/**
 * 冒烟失败：打印 SMOKE_FAIL 并以非 0 退出。
 * **必须带 SMOKE_TEST 门禁**：任何调用点（含进程级异常守护）在正常模式下都是空操作，
 * 这是 M0-1 复核 HIGH 缺陷的直接修复点之一。
 */
function failSmoke(reason: string, error?: unknown): void {
  if (!SMOKE_TEST || smokeFailed || smokeReported) return
  smokeFailed = true
  clearSmokeLoadWatchdog()
  clearSmokeReportWatchdog()
  clearSmokeReportTimer()
  console.error(
    `SMOKE_FAIL ${JSON.stringify({
      reason,
      error: error === undefined ? null : toErrorMessage(error)
    })}`
  )
  app.exit(1)
}

/** 内部断言：失败即 failSmoke 后抛出中断（避免在已退出流程里继续执行）。 */
function assertSmoke(condition: boolean, name: string, detail?: unknown): void {
  if (condition) return
  failSmoke(`assertion failed: ${name}`, detail)
  throw new SmokeAssertionError(name)
}

function clearSmokeLoadWatchdog(): void {
  if (!smokeLoadWatchdog) return
  clearTimeout(smokeLoadWatchdog)
  smokeLoadWatchdog = null
}

function clearSmokeReportWatchdog(): void {
  if (!smokeReportWatchdog) return
  clearTimeout(smokeReportWatchdog)
  smokeReportWatchdog = null
}

function clearSmokeReportTimer(): void {
  if (!smokeReportTimer) return
  clearTimeout(smokeReportTimer)
  smokeReportTimer = null
}

/** 进程级守护只注册一次（SMOKE_TEST 时才挂载，正常模式完全没有副作用）。 */
function attachSmokeProcessGuards(): void {
  if (!SMOKE_TEST || smokeProcessGuardsAttached) return
  smokeProcessGuardsAttached = true
  process.once('uncaughtException', (error) => failSmoke('uncaughtException', error))
  process.once('unhandledRejection', (reason) => failSmoke('unhandledRejection', reason))
}

/** 窗口级加载 watchdog + 加载/渲染进程崩溃守护（仅冒烟模式；每次重建窗口重新挂载）。 */
function attachSmokeWindowGuards(win: BrowserWindow): void {
  if (!SMOKE_TEST) return
  attachSmokeProcessGuards()

  clearSmokeLoadWatchdog()
  smokeLoadWatchdog = setTimeout(() => {
    failSmoke(`watchdog timeout: renderer did not finish loading within ${SMOKE_TIMEOUT_MS}ms`)
  }, SMOKE_TIMEOUT_MS)

  win.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL) => {
    clearSmokeLoadWatchdog()
    failSmoke('did-fail-load', { errorCode, errorDescription, validatedURL })
  })

  win.webContents.on('render-process-gone', (_event, details) => {
    clearSmokeLoadWatchdog()
    failSmoke('render-process-gone', details)
  })
}

/* ------------------------------ 窗口创建 / 显示 ------------------------------ */

/*
 * Wave 1（A1 合并）：overlay 窗口创建已迁入 `src/main/windows/overlay-manager.ts`
 * （每 display 一个窗口，frame = 该 display.workArea；选项 / 层级 / 焦点 / 穿透策略见该文件）。
 * 本文件只通过 deps 注入 `loadContents` / `hardenWebContents` / 冒烟生命周期回调。
 */

/* ------------------------------ 生命周期 / 安全 ------------------------------ */

/** dev 是否允许导航到指定 URL：仅放行 dev server（ELECTRON_RENDERER_URL）同源。 */
function isAllowedNavigation(targetUrl: string): boolean {
  if (!is.dev) return false
  const devServerUrl = process.env['ELECTRON_RENDERER_URL']
  if (!devServerUrl) return false
  try {
    return new URL(targetUrl).origin === new URL(devServerUrl).origin
  } catch {
    return false
  }
}

/**
 * R-05：为单个 overlay 的 webContents 挂崩溃 / 无响应恢复监听。
 *
 * 策略本身在 `src/main/windows/crash-recovery.ts`（可注入时钟 / 重载函数，纯单测覆盖限流），
 * 这里只做 Electron 事件 → 策略调用的适配。设置窗不走本函数：它在 `settings-window.ts`
 * 里只记日志、不自动 reload（避免清空用户正在编辑的表单，见该文件注释）。
 */
function attachCrashRecoveryHandlers(win: BrowserWindow): void {
  const recovery = crashRecovery
  if (!recovery) return
  const contents = win.webContents
  contents.on('render-process-gone', (_event, details) => {
    recovery.handleRenderProcessGone(contents, details)
  })
  contents.on('unresponsive', () => {
    recovery.handleUnresponsive(contents)
  })
  contents.on('responsive', () => {
    recovery.handleResponsive(contents)
  })
}

/** 硬性拒绝页面导航与新窗口；本项目没有外链页面（生产模式下全拒）。 */
function hardenWebContents(win: BrowserWindow): void {
  // B-02：放行判定必须用「真实提交过的 URL」（did-navigate），不能用 `getURL()`：
  // 后者是 renderer 可写的 visible URL（replaceState 可篡改），曾实测可借此放行真实导航。
  const committedUrl = createCommittedUrlTracker(win.webContents.getURL())
  win.webContents.on('did-navigate', (_event, url) => {
    committedUrl.noteCommitted(url)
  })

  const blockNavigation = (
    event: { preventDefault: () => void },
    url: string,
    allowSameUrlReload: boolean
  ): void => {
    if (isAllowedNavigation(url)) return
    // B-02：WebGL context 丢失后 renderer 用 `location.reload()` 恢复，而 renderer 发起的
    // reload 会触发 will-navigate。生产态页面是 file://，不满足 isAllowedNavigation → 旧实现
    // 会把恢复 reload 一并拦掉，使 B-02 在生产态无效（二次复核用 Electron 44 探针实测）。
    // 这里只放行「目标 URL 与最近一次真实提交 URL 逐字符完全相等」的 will-navigate（= reload，
    // 不加载新文档/不改变来源）；will-redirect 不享受该例外，仍然全拒。
    // 见 security/navigation-guard.ts（含 replaceState 绕过说明）。
    if (allowSameUrlReload && committedUrl.isSameUrlReload(url)) {
      appLogger?.info('[main] allowed same-url reload:', maskUrl(url))
      return
    }
    event.preventDefault()
    // R-22：只记 protocol/origin。被拒绝的 URL 可能带 query token，不能整段写进 console/main.log。
    console.warn('[main] blocked navigation:', maskUrl(url))
    appLogger?.warn('[main] blocked navigation:', maskUrl(url))
  }

  win.webContents.on('will-navigate', (event, url) => blockNavigation(event, url, true))
  win.webContents.on('will-redirect', (event, url) => blockNavigation(event, url, false))
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))

  // R-05：生产态崩溃恢复。冒烟模式不挂（`attachSmokeWindowGuards` 需要 crash 立即
  // SMOKE_FAIL 并退出；额外 reload 会干扰加载 watchdog 与退出码）。
  if (!SMOKE_TEST) attachCrashRecoveryHandlers(win)
}

/** session 级权限请求 / 检查全部拒绝（桌宠不需要摄像头、通知、剪贴板等任何权限）。 */
function hardenSession(): void {
  const ses = session.defaultSession
  ses.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false))
  ses.setPermissionCheckHandler(() => false)
  // R-23：打包版拦截 renderer 的全部 http(s) 出站（生产页面是 file://、素材是 pet-asset://，
  // 都不受 filter 影响；dev 下整条 guard 不注册，保留 http dev server / HMR ws）。
  // logger 用惰性代理：本函数可能早于 appLogger 创建（见 bootstrap 顺序），调用时再取当前实例。
  installRendererNetworkGuard(ses, {
    isPackaged: app.isPackaged,
    logger: {
      warn(message: string, meta?: unknown): void {
        if (meta === undefined) appLogger?.warn(message)
        else appLogger?.warn(message, meta)
      }
    },
    maskUrl
  })
}

/**
 * dev 多实例隔离：`PET_PROFILE=<name>` 时把 userData 改到
 * `appData/aventurine-pet-<name>`，避免多个 worktree 并行 `pnpm dev` 互相覆盖配置 / 日志。
 * 打包版不启用（固定使用默认 userData）。
 */
function applyDevProfile(): void {
  if (app.isPackaged) return
  const profile = process.env['PET_PROFILE']
  if (!profile) return
  if (!DEV_PROFILE_PATTERN.test(profile)) {
    console.warn(`[main] ignoring invalid PET_PROFILE: ${JSON.stringify(profile)}`)
    return
  }
  const target = join(app.getPath('appData'), `aventurine-pet-${profile}`)
  app.setPath('userData', target)
  console.log(`[main] dev userData isolated for PET_PROFILE="${profile}": ${target}`)
}

/** 开发模式加载 electron-vite dev server；生产模式加载打包后的 index.html（惯例保持不变）。 */
function loadRenderer(win: BrowserWindow): void {
  const devRendererUrl = process.env['ELECTRON_RENDERER_URL']
  const loading =
    is.dev && devRendererUrl
      ? win.loadURL(devRendererUrl)
      : win.loadFile(join(__dirname, '../renderer/index.html'))

  void loading.catch((error: unknown) => {
    if (SMOKE_TEST) failSmoke('renderer load rejected', error)
    else {
      console.error('[main] failed to load renderer:', error)
      appLogger?.error('[main] failed to load renderer:', error)
    }
  })
}

/* ------------------------------ dev 姿态截图回环 ------------------------------ */

/** 读取 renderer 调试面快照（Wave 2 起含 animation/behavior/motion/desktop 等可选字段）。 */
async function readRendererDebugSnapshot(win: BrowserWindow): Promise<Record<string, unknown>> {
  const script = `(() => {
    const debug = window.__aventurineDebug
    if (!debug) return { present: false }
    const pick = (value) => { try { return JSON.parse(JSON.stringify(value)) } catch { return String(value) } }
    let stats = null
    try { stats = typeof debug.stats === 'function' ? debug.stats() : null } catch (error) { stats = { error: String(error) } }
    return pick({
      present: true,
      ready: debug.ready === true,
      model: debug.model || null,
      stats,
      petWorld: debug.petWorld || null,
      // L2（M-3）验收：视觉命中矩形（含 foot-lock hips 横移 / sit visualOffset 补偿；null = 与 petRect 相同）。
      pointerRect: debug.pointerRect || null,
      animation: debug.animation || null,
      behavior: debug.behavior || null,
      motion: debug.motion || null,
      desktop: debug.desktop ? { surfaces: debug.desktop.surfaces, workArea: debug.desktop.workArea } : null,
      interaction: debug.interaction || null,
      reaction: debug.reaction || null,
      vrm: debug.vrm || null,
      vrmDrivers: debug.vrmDrivers || null,
      handProp: debug.handProp || null,
      errors: debug.errors || []
    })
  })()`
  return (await win.webContents.executeJavaScript(script)) as Record<string, unknown>
}

/** 等待 renderer ready（或超时）；返回最后一次快照。 */
async function waitForRendererReady(
  win: BrowserWindow,
  timeoutMs: number
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs
  let snapshot: Record<string, unknown> = { present: false }
  while (Date.now() < deadline) {
    if (win.isDestroyed()) return { present: false, error: 'window destroyed' }
    snapshot = await readRendererDebugSnapshot(win).catch(() => ({ present: false }))
    if (snapshot['present'] === true && snapshot['ready'] === true) return snapshot
    await delay(250)
  }
  return snapshot
}

/**
 * dev-capture 专用 renderer 执行兜底（NB-1）：
 * 窗口已销毁时**不访问** `win.webContents`（销毁后访问会抛）；执行失败也只返回 null。
 * 用于 finally 恢复/清理等「即使失败也必须走到 app.exit」的路径。
 */
async function executeDevCaptureScript<T>(win: BrowserWindow, script: string): Promise<T | null> {
  if (win.isDestroyed()) return null
  try {
    return (await win.webContents.executeJavaScript(script)) as T
  } catch {
    return null
  }
}

/** 读取 dev-capture 需要恢复的配置子集（L-1：改前先存原值；读不到 → null）。 */
async function readDevCaptureConfigForRestore(
  win: BrowserWindow
): Promise<Partial<PetConfig> | null> {
  const config = await executeDevCaptureScript<PetConfig>(win, 'window.api.getConfig()')
  if (!config || typeof config !== 'object') return null
  return { autonomous: config.autonomous === true, dshLink: config.dshLink === true }
}

/** 把 dev-capture 临时改动的配置恢复为原值（窗口销毁/执行失败都吞掉，不阻断退出）。 */
async function restoreDevCaptureConfig(
  win: BrowserWindow,
  original: Partial<PetConfig>
): Promise<void> {
  const patch = JSON.stringify({
    autonomous: original.autonomous === true,
    dshLink: original.dshLink === true
  })
  const restored = await executeDevCaptureScript<boolean>(
    win,
    `window.api.setConfig(${patch}).then(() => true)`
  )
  if (restored !== true) {
    // 窗口已销毁 / renderer 不可用：至少把恢复目标打进日志，便于手工核对。
    console.warn(`DEV_CAPTURE_CONFIG_RESTORE_FAILED ${JSON.stringify({ patch })}`)
  }
}

/** dev-capture：按 `PET_DEV_CAPTURE_PROP_VISIBLE` 强制手持道具显隐（截图前调用；未设置 = no-op）。 */
async function applyDevCapturePropVisibility(win: BrowserWindow): Promise<void> {
  if (DEV_CAPTURE_PROP_VISIBLE !== '1' && DEV_CAPTURE_PROP_VISIBLE !== '0') return
  const visible = DEV_CAPTURE_PROP_VISIBLE === '1'
  const forced = await executeDevCaptureScript(
    win,
    `(() => { const d = window.__aventurineDebug; if (!d) return 'no-debug'; if (typeof d.debugSetHandPropVisible !== 'function') return 'no-method'; d.debugSetHandPropVisible(${visible}); return 'ok' })()`
  )
  console.log(`DEV_CAPTURE_PROP ${JSON.stringify({ visible, forced })}`)
}

/** 单次抓图（png + debug 快照 + 计数/日志）—— 动态动作抓图与姿态循环共用。 */
async function captureDevShot(
  win: BrowserWindow,
  outDir: string,
  stats: { captured: number },
  tag: string,
  pose: string | null
): Promise<void> {
  await applyDevCapturePropVisibility(win)
  const image = await win.webContents.capturePage()
  const pngPath = join(outDir, `${tag}.png`)
  writeFileSync(pngPath, image.toPNG())
  const debug = await readRendererDebugSnapshot(win).catch(() => ({ present: false }))
  writeFileSync(join(outDir, `${tag}.json`), JSON.stringify({ pose, tag, debug }, null, 2))
  stats.captured += 1
  console.log(`DEV_CAPTURE_SHOT ${JSON.stringify({ pose, tag, png: pngPath, size: image.getSize() })}`)
}

/**
 * 动态动作抓图（V7 用户反馈验证）：
 * - 拖拽：合成 mousedown/mousemove 走真实 B4 交互 → B2 拖拽状态，抓「拖拽中/松手后」两帧；
 * - 走路：debugTriggerActivity('walkTo') → 抓 3 帧（应看到侧身朝运动方向、头不追鼠标）。
 */
async function runDevCaptureDynamicShots(
  win: BrowserWindow,
  outDir: string,
  stats: { captured: number }
): Promise<void> {
  const directions = DEV_CAPTURE_DRAG === 'both' ? ['right', 'left'] : DEV_CAPTURE_DRAG ? [DEV_CAPTURE_DRAG] : []
  for (const direction of directions) {
    if (direction !== 'right' && direction !== 'left') continue
    const dx = direction === 'right' ? 150 : -150
    await win.webContents.executeJavaScript(`(async () => {
      const debug = window.__aventurineDebug
      if (!debug || typeof debug.stats !== 'function') return { ok: false, reason: 'no debug.stats' }
      const rect = debug.stats().petRect
      if (!rect || !(rect.width > 0) || !(rect.height > 0)) return { ok: false, reason: 'no petRect' }
      const cx = rect.x + rect.width / 2
      const cy = rect.y + rect.height * 0.5
      const fire = (type, x, y, buttons, button = 0) => window.dispatchEvent(new MouseEvent(type, { clientX: x, clientY: y, button, buttons, bubbles: true, cancelable: true, view: window }))
      fire('mousemove', cx, cy, 0)
      await new Promise((resolve) => setTimeout(resolve, 140))
      fire('mousedown', cx, cy, 1)
      await new Promise((resolve) => setTimeout(resolve, 80))
      for (let step = 1; step <= 8; step += 1) {
        fire('mousemove', cx + (${dx} * step) / 8, cy - (40 * step) / 8, 1)
        await new Promise((resolve) => setTimeout(resolve, 35))
      }
      return { ok: true, rect }
    })()`)
    await delay(DEV_CAPTURE_ACTION_HOLD_MS)
    await captureDevShot(win, outDir, stats, `drag-${direction}-dragging`, 'drag')
    await win.webContents.executeJavaScript(`(() => {
      const debug = window.__aventurineDebug
      const rect = debug && typeof debug.stats === 'function' ? debug.stats().petRect : null
      const cx = rect ? rect.x + rect.width / 2 : 0
      const cy = rect ? rect.y + rect.height * 0.5 : 0
      window.dispatchEvent(new MouseEvent('mouseup', { clientX: cx + ${dx}, clientY: cy - 40, button: 0, buttons: 0, bubbles: true, cancelable: true, view: window }))
      return true
    })()`)
    await delay(DEV_CAPTURE_ACTION_HOLD_MS + 300)
    await captureDevShot(win, outDir, stats, `drag-${direction}-released`, null)
  }

  if (DEV_CAPTURE_PLACE.length > 0) {
    const [rawX, rawY] = DEV_CAPTURE_PLACE.split(',').map((value) => Number(value))
    if (Number.isFinite(rawX) && Number.isFinite(rawY)) {
      // dev A/B：强制窗沿坐风格（sit / lie），供逐尺寸对比抓图。
      if (DEV_CAPTURE_SIT_STYLE === 'sit' || DEV_CAPTURE_SIT_STYLE === 'lie') {
        await win.webContents.executeJavaScript(
          `window.__petDevSitStyle = ${JSON.stringify(DEV_CAPTURE_SIT_STYLE)}; true`
        )
      }
      const result = await win.webContents.executeJavaScript(`(async () => {
        const debug = window.__aventurineDebug
        if (!debug || typeof debug.stats !== 'function') return { ok: false, reason: 'no debug.stats' }
        const rect = debug.stats().petRect
        if (!rect || !(rect.width > 0) || !(rect.height > 0)) return { ok: false, reason: 'no petRect' }
        const fire = (type, x, y, buttons, button = 0) => window.dispatchEvent(new MouseEvent(type, { clientX: x, clientY: y, button, buttons, bubbles: true, cancelable: true, view: window }))
        const startX = rect.x + rect.width / 2
        const startY = rect.y + rect.height * 0.5
        const targetX = ${rawX}
        const targetY = ${rawY}
        fire('mousemove', startX, startY, 0)
        await new Promise((resolve) => setTimeout(resolve, 160))
        fire('mousedown', startX, startY, 1)
        await new Promise((resolve) => setTimeout(resolve, 80))
        const steps = 14
        for (let step = 1; step <= steps; step += 1) {
          fire('mousemove', startX + ((targetX - startX) * step) / steps, startY + ((targetY - startY) * step) / steps, 1)
          await new Promise((resolve) => setTimeout(resolve, 30))
        }
        // 停住 ~320ms：让甩出速度估计归零 → 走「放置」而不是「甩出」。
        await new Promise((resolve) => setTimeout(resolve, 320))
        fire('mouseup', targetX, targetY, 0)
        // 指针移开：避免 hover 气泡挡住宠物（气泡会在 4.2s 后过期，下面等待更久）。
        await new Promise((resolve) => setTimeout(resolve, 120))
        fire('mousemove', 4, 4, 0)
        return { ok: true, from: { x: Math.round(startX), y: Math.round(startY) }, to: { x: targetX, y: targetY } }
      })()`)
      console.log(`DEV_CAPTURE_PLACE ${JSON.stringify(result)}`)
      // 放置后 250ms 先抓一帧「第一时间」：验证不再有“先站在窗口上”的中间态（应已坐/躺）。
      await delay(250)
      await captureDevShot(win, outDir, stats, 'place-immediate', null)
      // 再等 hover 气泡过期（4.2s + 淡出）抓稳定帧。
      await delay(DEV_CAPTURE_ACTION_HOLD_MS + 4750)
      await captureDevShot(win, outDir, stats, 'place-after', null)
    }
  }

  if (DEV_CAPTURE_WALK) {
    await win.webContents.executeJavaScript(`(() => {
      const debug = window.__aventurineDebug
      if (!debug) return { ok: false }
      if (typeof debug.debugTeleport === 'function') debug.debugTeleport({ x: Math.round(window.innerWidth / 2), y: window.innerHeight })
      return { ok: true }
    })()`)
    await win.webContents.executeJavaScript(`window.api.setConfig({ autonomous: true }).then(() => true)`).catch(() => false)
    await delay(300)
    const triggered = (await win.webContents
      .executeJavaScript(`(() => { const d = window.__aventurineDebug; if (!d || typeof d.debugTriggerActivity !== 'function') return false; try { return d.debugTriggerActivity('walkTo') === true } catch { return false } })()`)
      .catch(() => false)) as boolean
    console.log(`DEV_CAPTURE_WALK ${JSON.stringify({ triggered })}`)
    for (let frame = 1; frame <= 3; frame += 1) {
      await delay(450)
      await captureDevShot(win, outDir, stats, `walk-${frame}`, 'walk')
    }
  }
}

/** dev 截图回环主流程（非冒烟模式专用；退出码由实测统计决定，`app.exit` 唯一在最外层）。 */
async function runDevCapture(win: BrowserWindow): Promise<void> {
  const outDir = resolve(DEV_CAPTURE_DIR as string)
  /** 实测统计（M-9）：ready/captured/skipped/failed 全部来自真实执行结果，不再无条件打 OK。 */
  const stats = { ready: false, captured: 0, skipped: 0, failed: 0, error: null as string | null }
  /** DEV_CAPTURE_CONFIG 改前原值（finally 恢复；null = 未改）。 */
  let devCaptureConfigRestore: Record<string, unknown> | null = null
  /** IDLE 模式改配置前读到的原值（L-1：finally 恢复原值，不再硬编码 true）。 */
  let idleConfigBefore: Partial<PetConfig> | null = null
  /** 是否真的尝试过把 autonomous/dshLink 改成静置态（只有改过才需要恢复）。 */
  let idleConfigChanged = false

  try {
    mkdirSync(outDir, { recursive: true })
    const ready = await waitForRendererReady(win, DEV_CAPTURE_READY_TIMEOUT_MS)
    stats.ready = ready['present'] === true && ready['ready'] === true
    console.log(
      `DEV_CAPTURE_READY ${JSON.stringify({ outDir, present: ready['present'], ready: ready['ready'] })}`
    )

    if (DEV_CAPTURE_IDLE) {
      idleConfigBefore = await readDevCaptureConfigForRestore(win)
      if (idleConfigBefore) {
        // 先置恢复标记再执行：即使 setConfig 承诺中途 reject，finally 仍会尝试恢复原值。
        idleConfigChanged = true
        await executeDevCaptureScript(
          win,
          'window.api.setConfig({ autonomous: false, dshLink: false }).then(() => true)'
        )
      } else {
        // 读不到原值 → 不改配置，避免把用户配置永久改成静置态（无法恢复）。
        console.warn('DEV_CAPTURE_IDLE skipped: cannot read original config for restore')
      }
      await delay(300)
    }
    if (DEV_CAPTURE_WARMUP_MS > 0) await delay(DEV_CAPTURE_WARMUP_MS)

    // 可选：临时配置覆盖（近景/表情截图用；finally 恢复原值）。
    if (DEV_CAPTURE_CONFIG.trim().length > 0) {
      let patch: Record<string, unknown> | null = null
      try {
        const parsed = JSON.parse(DEV_CAPTURE_CONFIG) as unknown
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          patch = parsed as Record<string, unknown>
        }
      } catch (error) {
        console.warn('DEV_CAPTURE_CONFIG JSON invalid:', toErrorMessage(error))
      }
      if (patch) {
        try {
          const current = (await win.webContents.executeJavaScript(
            'window.api.getConfig()'
          )) as PetConfig
          const restore: Record<string, unknown> = {}
          for (const key of Object.keys(patch)) {
            restore[key] = (current as unknown as Record<string, unknown>)[key]
          }
          devCaptureConfigRestore = restore
          await win.webContents.executeJavaScript(
            `window.api.setConfig(${JSON.stringify(patch)}).then(() => true)`
          )
          console.log(`DEV_CAPTURE_CONFIG ${JSON.stringify({ patch, restore })}`)
          await delay(400)
        } catch (error) {
          console.warn('DEV_CAPTURE_CONFIG apply failed:', toErrorMessage(error))
        }
      }
    }

    let morphs: Record<string, number> | null = null
    if (DEV_CAPTURE_MORPHS.trim().length > 0) {
      try {
        morphs = JSON.parse(DEV_CAPTURE_MORPHS) as Record<string, number>
      } catch (error) {
        console.warn('DEV_CAPTURE morphs JSON invalid:', toErrorMessage(error))
      }
    }

    // mood 序列抓图（dshError → breaked → 倒地保持 → idle → revive 等状态机证据）
    if (DEV_CAPTURE_MOOD_SEQUENCE.trim().length > 0) {
      if (DEV_CAPTURE_CENTER) {
        await win.webContents
          .executeJavaScript(
            `(() => {
              const debug = window.__aventurineDebug
              if (!debug || typeof debug.debugTeleport !== 'function') return false
              return debug.debugTeleport({ x: Math.round(window.innerWidth / 2), y: window.innerHeight })
            })()`
          )
          .catch(() => false)
        await delay(300)
      }
      const items = DEV_CAPTURE_MOOD_SEQUENCE.split(',')
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0)
      let index = 0
      for (const item of items) {
        const [moodRaw, msRaw] = item.split(':')
        const mood = (moodRaw ?? '').trim()
        if (mood.length === 0) continue
        const waitMs = Math.max(60, Number.parseInt(msRaw ?? '', 10) || DEV_CAPTURE_HOLD_MS)
        await executeDevCaptureScript(
          win,
          `window.__aventurineDebug?.debugSetAnimationMood?.(${JSON.stringify(mood)})`
        )
        await delay(waitMs)
        index += 1
        await captureDevShot(win, outDir, stats, `${String(index).padStart(2, '0')}-mood-${mood}`, mood)
      }
    }

    // V7 动态动作抓图（拖拽/走路；在静态姿态循环之前）
    if (DEV_CAPTURE_DRAG.length > 0 || DEV_CAPTURE_PLACE.length > 0 || DEV_CAPTURE_WALK) {
      await runDevCaptureDynamicShots(win, outDir, stats)
    }

    const poseList = DEV_CAPTURE_POSES.length > 0 ? DEV_CAPTURE_POSES : [null]
    const captureCount =
      DEV_CAPTURE_POSES.length > 0 ? poseList.length : DEV_CAPTURE_FRAMES
    const poses = Array.from({ length: captureCount }, (_, index) => poseList[index % poseList.length])
    // 可选：强制注视并采样读数（调试 look-at）
    if (DEV_CAPTURE_GAZE.trim().length > 0) {
      const [gazeYaw, gazePitch] = DEV_CAPTURE_GAZE.split(',').map((value) => Number(value.trim()))
      await win.webContents
        .executeJavaScript(
          `(() => { const d = window.__aventurineDebug; if (!d || typeof d.debugSetGaze !== 'function') return false; d.debugSetGaze(${Number.isFinite(gazeYaw) ? gazeYaw : 25}, ${Number.isFinite(gazePitch) ? gazePitch : 0}); return true })()`
        )
        .catch(() => undefined)
      const readings: unknown[] = []
      for (const wait of [120, 300, 600]) {
        await delay(wait)
        readings.push(
          await win.webContents
            .executeJavaScript(
              `(() => {
                const d = window.__aventurineDebug
                const a = d && d.animation
                return { gaze: a && a.gaze, lookYaw: a && a.lookYaw, facing: d && d.motion && d.motion.facing, mood: d && d.behavior && d.behavior.mood, activity: d && d.behavior && d.behavior.activity }
              })()`
            )
            .catch(() => null)
        )
      }
      console.log(`DEV_CAPTURE_GAZE ${JSON.stringify({ requested: [gazeYaw, gazePitch], readings })}`)
    }

    // 可选：先触发一次行为活动（如 sit/walkTo/sleep/coin），等它稳定后再截图
    if (DEV_CAPTURE_ACTIVITY.length > 0) {
      const triggered = await win.webContents
        .executeJavaScript(
          `(() => {
            const debug = window.__aventurineDebug
            if (!debug || typeof debug.debugTriggerActivity !== 'function') return { ok: false, reason: 'no debugTriggerActivity' }
            try { return { ok: debug.debugTriggerActivity(${JSON.stringify(DEV_CAPTURE_ACTIVITY)}) === true } } catch (error) { return { ok: false, reason: String(error) } }
          })()`
        )
        .catch((error: unknown) => ({ ok: false, reason: toErrorMessage(error) })) as {
        ok?: boolean
        reason?: string
      }
      console.log(`DEV_CAPTURE_ACTIVITY ${JSON.stringify({ activity: DEV_CAPTURE_ACTIVITY, triggered })}`)
      await delay(DEV_CAPTURE_HOLD_MS * 2)
    }

    // 可选：临时覆盖动画层 mood（只影响 B3 动画输入；用于实机检查 pat/drag 等外部 VMD）
    if (DEV_CAPTURE_MOOD.length > 0) {
      const applied = await win.webContents
        .executeJavaScript(
          `(() => {
            const debug = window.__aventurineDebug
            if (!debug || typeof debug.debugSetAnimationMood !== 'function') return { ok: false, reason: 'no debugSetAnimationMood' }
            try { debug.debugSetAnimationMood(${JSON.stringify(DEV_CAPTURE_MOOD)}) ; return { ok: true } } catch (error) { return { ok: false, reason: String(error) } }
          })()`
        )
        .catch((error: unknown) => ({ ok: false, reason: toErrorMessage(error) }))
      console.log(`DEV_CAPTURE_MOOD ${JSON.stringify({ mood: DEV_CAPTURE_MOOD, applied })}`)
      await delay(DEV_CAPTURE_HOLD_MS)
    }

    for (let index = 0; index < poses.length; index += 1) {
      const pose = poses[index]
      if (DEV_CAPTURE_CENTER) {
        await win.webContents
          .executeJavaScript(
            `(() => {
              const debug = window.__aventurineDebug
              if (!debug || typeof debug.debugTeleport !== 'function') return false
              return debug.debugTeleport({ x: Math.round(window.innerWidth / 2), y: window.innerHeight })
            })()`
          )
          .catch(() => false)
        await delay(300)
      }
      if (pose) {
        const applied = (await win.webContents
          .executeJavaScript(
            `(() => {
              const debug = window.__aventurineDebug
              if (!debug || typeof debug.debugSetPose !== 'function') return { ok: false, reason: 'no debugSetPose' }
              try { return { ok: debug.debugSetPose(${JSON.stringify(pose)}) === true } } catch (error) { return { ok: false, reason: String(error) } }
            })()`
          )
          .catch((error: unknown) => ({ ok: false, reason: toErrorMessage(error) }))) as {
          ok?: boolean
          reason?: string
        }
        await delay(DEV_CAPTURE_HOLD_MS)
        if (!applied.ok) {
          // M-9：姿态未应用不是「成功截图」——计数后由退出码决策判失败。
          stats.skipped += 1
          console.warn(
            `DEV_CAPTURE_POSE_SKIPPED ${JSON.stringify({ pose, reason: applied.reason ?? 'setPose false' })}`
          )
        }
      }

      if (morphs) {
        await win.webContents
          .executeJavaScript(
            `(() => {
              const debug = window.__aventurineDebug
              if (!debug || typeof debug.setMorph !== 'function') return false
              for (const [name, weight] of Object.entries(${JSON.stringify(morphs)})) debug.setMorph(name, weight)
              return true
            })()`
          )
          .catch(() => false)
        await delay(200)
      }

      if (index > 0 && DEV_CAPTURE_POSES.length === 0) await delay(DEV_CAPTURE_INTERVAL_MS)
      const tag = `${String(index + 1).padStart(2, '0')}-${pose ?? 'idle'}`
      await applyDevCapturePropVisibility(win)
      const image = await win.webContents.capturePage()
      const pngPath = join(outDir, `${tag}.png`)
      writeFileSync(pngPath, image.toPNG())
      const debug = await readRendererDebugSnapshot(win).catch(() => ({ present: false }))
      writeFileSync(join(outDir, `${tag}.json`), JSON.stringify({ pose, debug }, null, 2))
      stats.captured += 1
      console.log(`DEV_CAPTURE_SHOT ${JSON.stringify({ pose, png: pngPath, size: image.getSize() })}`)
    }
  } catch (error) {
    // M-9：异常路径不再由 finally 覆盖为 exit 0 —— 统一在函数末尾按统计决定退出码。
    stats.failed += 1
    stats.error = toErrorMessage(error)
  } finally {
    // L-1：IDLE 截图会临时改 autonomous/dshLink 并**持久化到该 profile 的 config**；
    // 退出前恢复**改前读到的原值**，避免改写用户配置（不再硬编码 {true,true}）。
    // NB-1：窗口可能已销毁 —— executeDevCaptureScript 内部 isDestroyed 守卫 + try/catch，
    // 恢复失败也不得跳过下面的 app.exit。
    if (idleConfigChanged && idleConfigBefore) {
      await restoreDevCaptureConfig(win, idleConfigBefore)
    }
    if (DEV_CAPTURE_MOOD.length > 0) {
      await executeDevCaptureScript(
        win,
        'window.__aventurineDebug?.debugSetAnimationMood?.(null)'
      )
    }
    if (devCaptureConfigRestore) {
      const patch = JSON.stringify(devCaptureConfigRestore)
      await executeDevCaptureScript(win, `window.api.setConfig(${patch}).then(() => true)`)
      devCaptureConfigRestore = null
    }
    // 可选：设置窗截图（B6 视觉验收；设置窗是普通可聚焦窗口，capturePage 即可）。
    if (DEV_CAPTURE_SETTINGS) {
      try {
        await captureSettingsWindowScreenshot(resolve(DEV_CAPTURE_DIR as string))
      } catch (error) {
        stats.failed += 1
        if (stats.error === null) stats.error = `settings capture failed: ${toErrorMessage(error)}`
        console.error(`DEV_CAPTURE_SETTINGS_FAIL ${JSON.stringify({ error: toErrorMessage(error) })}`)
      }
    }
  }

  const decision = decideDevCaptureExit(stats)
  const payload = {
    outDir,
    ready: stats.ready,
    captured: stats.captured,
    skipped: stats.skipped,
    failed: stats.failed,
    error: stats.error,
    reason: decision.reason
  }
  if (decision.ok) console.log(`DEV_CAPTURE_OK ${JSON.stringify(payload)}`)
  else console.error(`DEV_CAPTURE_FAIL ${JSON.stringify(payload)}`)
  // NB-1：app.exit 只在这里调用一次（最外层）。finally 已全部走 isDestroyed 守卫，
  // 窗口销毁/恢复异常都不会跳过退出导致进程挂住。
  app.exit(decision.exitCode)
}

/* ------------------------------ dev 启动逐帧捕获 ------------------------------ */

/**
 * dev 启动逐帧捕获主流程（`PET_DEV_CAPTURE_STARTUP_FRAMES>0` 时由 did-finish-load 触发）。
 *
 * 背景：VRM rest = T-pose，「模型已可见但首帧 idle 动画尚未应用」的窗口期会在桌面上闪 T-pose。
 * 本函数把这个窗口期逐帧录下来（PNG 证据 + debug 时间线），供 `scripts/vrm/capture-startup.mjs`
 * 做非透明像素数 / 内容 bbox 宽高比分析（透明帧 = 未显示；宽 bbox = T-pose；窄 bbox = idle）。
 *
 * 实现要点：
 * - `beginFrameSubscription(false, cb)`：onlyDirty=false → 该窗口每个呈现帧都回调；
 * - 回调里同步 `resize → toPNG → writeFileSync`（缩小到 CAPTURE_STARTUP_WIDTH，编码开销可控）；
 * - 并行按固定间隔采样 `window.__aventurineDebug`（clipId/ready/model 等），写 `startup-debug.json`；
 * - 到达帧数/时长上限，或 watchdog 兜底（窗口不可见时永远收不到帧）→ 写 `startup-frames.json`
 *   并打印 `DEV_CAPTURE_STARTUP_OK`/`DEV_CAPTURE_STARTUP_FAIL`，最后唯一 `app.exit` 在最外层。
 */
async function runDevCaptureStartup(win: BrowserWindow): Promise<void> {
  const outDir = resolve(DEV_CAPTURE_DIR as string)
  mkdirSync(outDir, { recursive: true })
  const startedAt = Date.now()
  const frames: Array<{
    index: number
    tMs: number
    png: string
    size: { width: number; height: number }
    windowVisible: boolean
  }> = []
  const debugTimeline: Array<{ tMs: number; snapshot: Record<string, unknown> }> = []
  let finished = false
  let debugTimer: ReturnType<typeof setInterval> | null = null
  let watchdog: ReturnType<typeof setTimeout> | null = null

  const sampleDebug = (): void => {
    if (finished || win.isDestroyed()) return
    const tMs = Date.now() - startedAt
    readRendererDebugSnapshot(win)
      .then((snapshot) => {
        if (!finished) debugTimeline.push({ tMs, snapshot })
      })
      .catch(() => undefined)
  }

  const finish = (kind: 'limit' | 'watchdog', error: string | null): void => {
    if (finished) return
    finished = true
    if (debugTimer !== null) {
      clearInterval(debugTimer)
      debugTimer = null
    }
    if (watchdog !== null) {
      clearTimeout(watchdog)
      watchdog = null
    }
    if (!win.isDestroyed()) {
      try {
        win.webContents.endFrameSubscription()
      } catch {
        // 订阅可能未建立 / webContents 已销毁：退出流程不受影响。
      }
    }
    const elapsedMs = Date.now() - startedAt
    const meta = {
      generatedAt: new Date().toISOString(),
      startedAtEpochMs: startedAt,
      elapsedMs,
      outDir,
      finishedBy: kind,
      error,
      maxFrames: DEV_CAPTURE_STARTUP_FRAMES,
      maxMs: DEV_CAPTURE_STARTUP_MAX_MS,
      pngWidth: DEV_CAPTURE_STARTUP_WIDTH,
      windowSize: win.isDestroyed() ? null : win.getContentSize(),
      frameCount: frames.length,
      frames
    }
    writeFileSync(join(outDir, 'startup-frames.json'), JSON.stringify(meta, null, 2))
    void (async () => {
      // 抓完后额外取一次 renderer 快照（capture 末尾的 animation/model 状态）。
      const finalSnapshot = win.isDestroyed()
        ? { present: false, error: 'window destroyed' }
        : await readRendererDebugSnapshot(win).catch((snapshotError: unknown) => ({
            present: false,
            error: toErrorMessage(snapshotError)
          }))
      writeFileSync(
        join(outDir, 'startup-debug.json'),
        JSON.stringify({ outDir, elapsedMs, finishedBy: kind, timeline: debugTimeline, final: finalSnapshot }, null, 2)
      )
      const ok = frames.length > 0 && error === null
      const payload = {
        outDir,
        elapsedMs,
        captured: frames.length,
        finishedBy: kind,
        error,
        firstFrameTMs: frames[0]?.tMs ?? null,
        lastFrameTMs: frames[frames.length - 1]?.tMs ?? null
      }
      if (ok) console.log(`DEV_CAPTURE_STARTUP_OK ${JSON.stringify(payload)}`)
      else console.error(`DEV_CAPTURE_STARTUP_FAIL ${JSON.stringify(payload)}`)
      app.exit(ok ? 0 : 1)
    })()
  }

  console.log(
    `DEV_CAPTURE_STARTUP_BEGIN ${JSON.stringify({
      outDir,
      maxFrames: DEV_CAPTURE_STARTUP_FRAMES,
      maxMs: DEV_CAPTURE_STARTUP_MAX_MS,
      pngWidth: DEV_CAPTURE_STARTUP_WIDTH
    })}`
  )
  sampleDebug()
  debugTimer = setInterval(sampleDebug, DEV_CAPTURE_STARTUP_DEBUG_INTERVAL_MS)
  try {
    win.webContents.beginFrameSubscription(false, (image) => {
      if (finished) return
      const index = frames.length + 1
      const tMs = Date.now() - startedAt
      const originalSize = image.getSize()
      const pngPath = join(outDir, `startup-${String(index).padStart(3, '0')}.png`)
      try {
        const resized =
          originalSize.width > DEV_CAPTURE_STARTUP_WIDTH
            ? image.resize({ width: DEV_CAPTURE_STARTUP_WIDTH, quality: 'good' })
            : image
        writeFileSync(pngPath, resized.toPNG())
        frames.push({ index, tMs, png: pngPath, size: originalSize, windowVisible: win.isVisible() })
        console.log(
          `DEV_CAPTURE_STARTUP_FRAME ${JSON.stringify({ index, tMs, size: originalSize })}`
        )
      } catch (error) {
        console.warn(
          `DEV_CAPTURE_STARTUP_FRAME_WRITE_FAIL ${JSON.stringify({ index, error: toErrorMessage(error) })}`
        )
      }
      if (frames.length >= DEV_CAPTURE_STARTUP_FRAMES || tMs >= DEV_CAPTURE_STARTUP_MAX_MS) {
        finish('limit', null)
      }
    })
  } catch (error) {
    finish('watchdog', `beginFrameSubscription failed: ${toErrorMessage(error)}`)
    return
  }
  watchdog = setTimeout(() => {
    if (finished) return
    finish(
      'watchdog',
      frames.length === 0
        ? 'no frames delivered (window not visible / compositor paused?)'
        : `no more frames after last one (last t=${frames[frames.length - 1]?.tMs ?? 0}ms)`
    )
  }, DEV_CAPTURE_STARTUP_MAX_MS + DEV_CAPTURE_STARTUP_FRAME_GRACE_MS)
}

/** 打开设置窗、截图并写调试信息后销毁（dev 截图回环的可选步骤）。 */
async function captureSettingsWindowScreenshot(outDir: string): Promise<void> {
  const overlay = getActiveOverlayWindowsManager()?.getPrimaryWindow() ?? null
  if (!overlay) throw new Error('overlay window missing for settings capture')
  await overlay.webContents.executeJavaScript('window.api.showSettings()')

  let settingsWin: BrowserWindow | null = null
  const deadline = Date.now() + 8000
  while (Date.now() < deadline) {
    await delay(200)
    settingsWin = getSettingsWindow()
    if (settingsWin && !settingsWin.isDestroyed() && !settingsWin.webContents.isLoading()) break
  }
  if (!settingsWin) throw new Error('settings window not created')
  await delay(500)

  const image = await settingsWin.webContents.capturePage()
  const pngPath = join(outDir, 'settings.png')
  writeFileSync(pngPath, image.toPNG())
  const info = (await settingsWin.webContents.executeJavaScript(`({
    title: document.title,
    text: (document.getElementById('settings-root') || {}).innerText || '',
    url: location.href
  })`)) as { title?: string; text?: string; url?: string }
  writeFileSync(join(outDir, 'settings.json'), JSON.stringify(info, null, 2))
  console.log(`DEV_CAPTURE_SETTINGS_OK ${JSON.stringify({ png: pngPath, title: info.title })}`)
  destroySettingsWindow()
}

/* ------------------------------ 显示器变化 ------------------------------ */

/*
 * Wave 1（A1 合并）：显示器拓扑 / workArea 变化监听已迁入 overlay-manager
 * （`startDisplayWatchers()`：display-* debounce 200ms → 重建/改几何 + 广播 `screens-updated`）。
 */

/* ------------------------------ 冒烟：报告 ------------------------------ */

interface RendererApiProbe {
  ok: boolean
  error?: string
  electronUndefined?: boolean
  apiMethodCount?: number
  hasOnScreensUpdated?: boolean
  windowInfo?: OverlayWindowInfo
  pmx?: { status: number; bytes: number }
  texture?: {
    ok: boolean
    error?: string
    name?: string
    naturalWidth?: number
    naturalHeight?: number
    pixel?: number[]
  }
}

interface RendererEventsProbe {
  windowsUpdated: number
  screensUpdated: number
  /** H-1 回归：screens-updated 广播前/后 renderer 的 geometryRefreshCount（必须递增）。 */
  geometryRefreshBefore: number
  geometryRefreshAfter: number
}

function rectEquals(
  left: { x: number; y: number; width: number; height: number },
  right: { x: number; y: number; width: number; height: number }
): boolean {
  return (
    left.x === right.x &&
    left.y === right.y &&
    left.width === right.width &&
    left.height === right.height
  )
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

/**
 * renderer 侧端到端探测（在页面主世界执行，等价于 A2 的真实使用方式）：
 * - contextBridge 白名单面（`window.electron` 不存在、`window.api` 18 个方法、onScreensUpdated）；
 * - `pet:window-info` invoke；
 * - `pet-asset://` fetch PMX（200 + 字节数）；
 * - crossOrigin='anonymous' Image 加载贴图 → canvas drawImage + getImageData 不抛（CORS 不 taint）。
 */
async function runRendererApiProbe(win: BrowserWindow): Promise<RendererApiProbe> {
  const pmxUrl = petAssetUrl(assetsManifest.pmx.file)
  const textureEntry = assetsManifest.textures[0]
  const textureUrl = petAssetUrl(textureEntry.optimized)

  const script = `(async () => {
    const result = { ok: true }
    try {
      result.electronUndefined = typeof window.electron === 'undefined'
      const api = window.api
      result.apiMethodCount = api
        ? Object.keys(api).filter((key) => typeof api[key] === 'function').length
        : 0
      result.hasOnScreensUpdated = typeof api?.onScreensUpdated === 'function'
      result.windowInfo = await api.getWindowInfo()

      const pmxResponse = await fetch(${JSON.stringify(pmxUrl)})
      const pmxBuffer = await pmxResponse.arrayBuffer()
      result.pmx = { status: pmxResponse.status, bytes: pmxBuffer.byteLength }

      result.texture = await new Promise((resolve) => {
        const image = new Image()
        image.crossOrigin = 'anonymous'
        image.onload = () => {
          try {
            const canvas = document.createElement('canvas')
            canvas.width = image.naturalWidth
            canvas.height = image.naturalHeight
            const context = canvas.getContext('2d')
            if (!context) {
              resolve({ ok: false, error: 'canvas 2d context unavailable' })
              return
            }
            context.drawImage(image, 0, 0)
            const pixel = context.getImageData(0, 0, 1, 1).data
            resolve({
              ok: true,
              name: ${JSON.stringify(textureEntry.optimized)},
              naturalWidth: image.naturalWidth,
              naturalHeight: image.naturalHeight,
              pixel: [pixel[0], pixel[1], pixel[2], pixel[3]]
            })
          } catch (error) {
            resolve({
              ok: false,
              error: String((error && error.message) || error),
              name: error && error.name
            })
          }
        }
        image.onerror = () => resolve({ ok: false, error: 'image load failed (CORS/CSP?)' })
        image.src = ${JSON.stringify(textureUrl)}
      })

      return result
    } catch (error) {
      return { ok: false, error: String((error && error.message) || error) }
    }
  })()`

  return (await win.webContents.executeJavaScript(script)) as RendererApiProbe
}

/** V1：VRM 资产/动作清单协议探针（renderer 真实 fetch `pet-asset://assets/**`）。 */
interface VrmAssetProbe {
  ok: boolean
  error?: string
  asset?: { status: number; bytes: number; url: string }
  manifest?: { status: number; clips: number; url: string }
}

async function runVrmAssetProbe(win: BrowserWindow, avatarFile: string): Promise<VrmAssetProbe> {
  const assetUrl = `pet-asset://assets/${avatarFile
    .split('/')
    .filter((segment) => segment.length > 0)
    .map((segment) => encodeURIComponent(segment))
    .join('/')}`
  const manifestUrl = 'pet-asset://assets/motions/app-manifest.json'
  const script = `(async () => {
    try {
      const assetResponse = await fetch(${JSON.stringify(assetUrl)})
      const assetBuffer = await assetResponse.arrayBuffer()
      const manifestResponse = await fetch(${JSON.stringify(manifestUrl)}, { cache: 'no-store' })
      const manifestText = await manifestResponse.text()
      let clips = -1
      try {
        const parsed = JSON.parse(manifestText)
        clips = Array.isArray(parsed?.clips) ? parsed.clips.length : -1
      } catch (error) {
        return { ok: false, error: 'app-manifest.json 解析失败: ' + String(error), asset: { status: assetResponse.status, bytes: assetBuffer.byteLength, url: ${JSON.stringify(assetUrl)} }, manifest: { status: manifestResponse.status, clips, url: ${JSON.stringify(manifestUrl)} } }
      }
      return {
        ok: assetResponse.status === 200 && assetBuffer.byteLength > 0 && manifestResponse.status === 200 && clips > 0,
        asset: { status: assetResponse.status, bytes: assetBuffer.byteLength, url: ${JSON.stringify(assetUrl)} },
        manifest: { status: manifestResponse.status, clips, url: ${JSON.stringify(manifestUrl)} }
      }
    } catch (error) {
      return { ok: false, error: String((error && error.message) || error) }
    }
  })()`
  return (await win.webContents.executeJavaScript(script)) as VrmAssetProbe
}

/** 事件端到端：renderer 先订阅 → 主进程广播 windows-updated / screens-updated → 读回计数。 */
async function readGeometryRefreshCount(win: BrowserWindow): Promise<number> {
  const value = (await win.webContents.executeJavaScript(
    `(window.__aventurineDebug && typeof window.__aventurineDebug.geometryRefreshCount === 'number') ? window.__aventurineDebug.geometryRefreshCount : -1`
  )) as number
  return typeof value === 'number' ? value : -1
}

async function runRendererEventsProbe(win: BrowserWindow): Promise<RendererEventsProbe> {
  const geometryRefreshBefore = await readGeometryRefreshCount(win)
  const subscribeResult = (await win.webContents.executeJavaScript(`(() => {
    window.__petSmokeEvents = { windowsUpdated: 0, screensUpdated: 0 }
    window.__petSmokeUnsubscribe = [
      window.api.onWindowsUpdated(() => { window.__petSmokeEvents.windowsUpdated += 1 }),
      window.api.onScreensUpdated(() => { window.__petSmokeEvents.screensUpdated += 1 })
    ]
    return { subscribed: window.__petSmokeUnsubscribe.length === 2 }
  })()`)) as { subscribed?: boolean }

  assertSmoke(subscribeResult?.subscribed === true, 'renderer event subscription failed', subscribeResult)

  appContext.broadcast(IPC_EVENTS.windowsUpdated, [])
  appContext.broadcast(IPC_EVENTS.screensUpdated, getDisplayInfos())
  await delay(SMOKE_EVENT_SETTLE_MS)

  const counts = (await win.webContents.executeJavaScript(`(() => {
    const events = window.__petSmokeEvents || { windowsUpdated: -1, screensUpdated: -1 }
    if (window.__petSmokeUnsubscribe) {
      window.__petSmokeUnsubscribe.forEach((unsubscribe) => unsubscribe())
      delete window.__petSmokeUnsubscribe
    }
    return { windowsUpdated: events.windowsUpdated, screensUpdated: events.screensUpdated }
  })()`)) as { windowsUpdated?: number; screensUpdated?: number }
  const geometryRefreshAfter = await readGeometryRefreshCount(win)

  return {
    windowsUpdated: counts?.windowsUpdated ?? -1,
    screensUpdated: counts?.screensUpdated ?? -1,
    geometryRefreshBefore,
    geometryRefreshAfter
  }
}

/** Wave 2 动画/行为/物理/桌面端到端探针结果（B1–B5 集成断言）。 */
interface Wave2Probe {
  ok: boolean
  error?: string
  initial?: {
    animation: {
      pose?: unknown
      poseWeight?: unknown
      missingBones?: unknown
      morphs?: unknown
      footErrorPx?: unknown
      blink?: unknown
      /** Wave 2.5：外部 VMD 动作源字段（无 motion-index 时为 undefined/procedural） */
      source?: unknown
      clipId?: unknown
      externalIk?: unknown
      externalFootErrorPx?: unknown
    } | null
    behavior: { mood?: unknown; activity?: unknown; autonomous?: unknown } | null
    motion: { feet?: { x?: unknown; y?: unknown }; grounded?: unknown; airborne?: unknown } | null
    desktop: { surfaces?: unknown; kinds?: unknown } | null
    interaction: { hoveringPet?: unknown; dragging?: unknown } | null
    errors?: unknown
  }
  blinkSeen?: boolean
  blinkMs?: number
  poseSwitch?: {
    sitApplied?: boolean
    sitPose?: string | null
    standApplied?: boolean
    standPose?: string | null
    footErrorPx?: number | null
  }
  gaze?: {
    requestedDeg: number
    actualDeg: number | null
    lookYaw: number | null
    facing?: 'left' | 'right' | 'front' | null
  }
}

/**
 * Wave 2 集成探针（B1 行为 / B2 物理 / B3 动画 / B5 桌面）：
 * 1. 读初始调试快照（动画姿态/行为 mood/物理 feet/桌面 surfaces）；
 * 2. 等待眨眼出现（8s 内至少一次，证明表情调度在跑）；
 * 3. `debugSetPose('sit'→'stand')` 验证姿态切换与脚底贴地误差；
 * 4. `debugSetGaze(25,0)` 验证 look-at 生效（快照 gaze 为弧度）；
 * 5. 结束前清强制姿态/注视，恢复自主活动。
 */
interface Wave2ProbeOptions {
  /**
   * 场景是否接入了「角色动画驱动」（PoseDriver）：
   * - VRM 后端 = true（clip/表情/look-at）；
   * - legacy-pmx 后端 = false（2026-11-09 用户决策：v1 PMX 自定义动作已删除，仅静态渲染 + IdleMotion）。
   * 为 false 时跳过姿态/眨眼/注视/贴地相关断言（`debug.animation` 为 undefined 是预期）。
   */
  expectAnimation: boolean
  /** 是否要求 8s 内出现眨眼（依赖动画驱动）。 */
  expectBlink: boolean
  /** 是否要求强制注视能收敛（依赖动画驱动）。 */
  expectLookAt: boolean
}

async function runWave2Probe(
  win: BrowserWindow,
  options: Wave2ProbeOptions
): Promise<Wave2Probe> {
  const execute = async <T>(script: string, fallback: T): Promise<T> => {
    try {
      return (await win.webContents.executeJavaScript(script)) as T
    } catch (error) {
      return { ...(fallback as object), error: toErrorMessage(error) } as T
    }
  }

  const snapshotScript = `(() => {
    const debug = window.__aventurineDebug
    if (!debug) return { present: false }
    const pick = (value) => { try { return JSON.parse(JSON.stringify(value)) } catch { return null } }
    const animation = pick(debug.animation) || null
    const behavior = pick(debug.behavior) || null
    const motion = pick(debug.motion) || null
    const desktop = debug.desktop ? { surfaces: Array.isArray(debug.desktop.surfaces) ? debug.desktop.surfaces.length : -1, kinds: (debug.desktop.surfaces || []).map((surface) => surface.kind) } : null
    const interaction = pick(debug.interaction) || null
    return { present: true, animation, behavior, motion, desktop, interaction, errors: pick(debug.errors) || [] }
  })()`

  /** L-1：本探针会临时关闭自主活动；改前先存原值，finally 恢复（异常/提前 return 也恢复）。 */
  let configBeforeProbe: { autonomous: boolean; dshLink: boolean } | null = null
  let configChangedByProbe = false

  try {
    // 稳定环境：关闭自主活动，宠物静置在底部中央（不打断既有断言）。
    // L-1：先读原配置，finally 恢复原值（不再硬编码 autonomous:true 改写用户配置）。
    try {
      const config = (await win.webContents.executeJavaScript(
        `(async () => { const cfg = await window.api.getConfig(); return { autonomous: cfg && cfg.autonomous === true, dshLink: cfg && cfg.dshLink === true } })()`
      )) as { autonomous?: boolean; dshLink?: boolean } | null
      if (config) {
        configBeforeProbe = {
          autonomous: config.autonomous === true,
          dshLink: config.dshLink === true
        }
      }
    } catch {
      // 读不到原配置：照常跑探针，但结束时不恢复（不写「猜的值」）。
    }
    // 先置标记再改：即使 setConfig 承诺中途 reject，finally 仍会尝试恢复原值。
    configChangedByProbe = configBeforeProbe !== null
    if (configChangedByProbe) {
      await win.webContents.executeJavaScript('window.api.setConfig({ autonomous: false })')
    }
    await delay(250)
    await win.webContents.executeJavaScript(
      `(() => { const d = window.__aventurineDebug; if (d && typeof d.debugTeleport === 'function') d.debugTeleport({ x: Math.round(window.innerWidth / 2), y: window.innerHeight }) })()`
    )
    await delay(350)

    const initial = await execute<Wave2Probe['initial']>(snapshotScript, {} as Wave2Probe['initial'])
    if (!initial || (initial as unknown as { present?: boolean }).present === false) {
      return { ok: false, error: 'window.__aventurineDebug missing / animation not integrated' }
    }

    // 眨眼：8s 内至少一次（B3 表情调度；VRM 未接表情层时跳过）
    let blinkSeen = false
    let blinkMs = 0
    const blinkStart = Date.now()
    while (options.expectBlink && Date.now() - blinkStart < 8000) {
      const probe = await execute<{ blink?: number; morph?: number } | null>(
        `(() => {
          const animation = window.__aventurineDebug && window.__aventurineDebug.animation
          if (!animation) return null
          const morphs = animation.morphs || {}
          return { blink: Number(animation.blink) || 0, morph: Number(morphs['まばたき']) || 0 }
        })()`,
        null
      )
      if (probe && ((probe.blink ?? 0) > 0 || (probe.morph ?? 0) > 0)) {
        blinkSeen = true
        blinkMs = Date.now() - blinkStart
        break
      }
      await delay(120)
    }

    // 姿态切换 + 脚底贴地
    const sitApplied = (await execute<boolean>(
      `(() => { const d = window.__aventurineDebug; return !!(d && typeof d.debugSetPose === 'function' && d.debugSetPose('sit')) })()`,
      false
    )) === true
    await delay(700)
    const sitPose = await execute<string | null>(
      `(() => { const a = window.__aventurineDebug && window.__aventurineDebug.animation; return a ? String(a.pose) : null })()`,
      null
    )
    const standApplied = (await execute<boolean>(
      `(() => { const d = window.__aventurineDebug; return !!(d && typeof d.debugSetPose === 'function' && d.debugSetPose('stand')) })()`,
      false
    )) === true
    await delay(700)
    const standProbe = await execute<{ pose: string | null; footErrorPx: number | null }>(
      `(() => {
        const a = window.__aventurineDebug && window.__aventurineDebug.animation
        if (!a) return { pose: null, footErrorPx: null }
        return { pose: String(a.pose), footErrorPx: typeof a.footErrorPx === 'number' ? a.footErrorPx : null }
      })()`,
      { pose: null, footErrorPx: null }
    )

    // look-at：强制 25° → 快照 gaze（弧度）换算回度（VRM 未接 look-at 层时跳过）
    if (options.expectLookAt) {
      await execute<boolean>(
        `(() => { const d = window.__aventurineDebug; if (!d || typeof d.debugSetGaze !== 'function') return false; d.debugSetGaze(25, 0); return true })()`,
        false
      )
      await delay(500)
    }
    const gazeProbe = await execute<{
      yaw: number | null
      lookYaw: number | null
      facing: string | null
    }>(
      `(() => {
        const debug = window.__aventurineDebug
        const a = debug && debug.animation
        if (!a) return { yaw: null, lookYaw: null, facing: null }
        const yaw = a.gaze && typeof a.gaze.yaw === 'number' ? a.gaze.yaw : null
        const facing = debug.motion && typeof debug.motion.facing === 'string' ? debug.motion.facing : null
        return { yaw, lookYaw: typeof a.lookYaw === 'number' ? a.lookYaw : null, facing }
      })()`,
      { yaw: null, lookYaw: null, facing: null }
    )

    // 清理强制姿态/注视与恢复自主活动统一放到 finally（L-1：异常/提前 return 也恢复）。
    return {
      ok: true,
      initial,
      blinkSeen,
      blinkMs,
      poseSwitch: {
        sitApplied,
        sitPose,
        standApplied,
        standPose: standProbe?.pose ?? null,
        footErrorPx: standProbe?.footErrorPx ?? null
      },
      gaze: {
        requestedDeg: 25,
        actualDeg: gazeProbe?.yaw === null ? null : ((gazeProbe?.yaw ?? 0) * 180) / Math.PI,
        lookYaw: gazeProbe?.lookYaw ?? null,
        facing: (gazeProbe?.facing as 'left' | 'right' | 'front' | null) ?? null
      }
    }
  } catch (error) {
    return { ok: false, error: toErrorMessage(error) }
  } finally {
    // 清理强制姿态/注视（只影响本次会话，不落盘）。
    await execute<boolean>(
      `(() => { const d = window.__aventurineDebug; if (d && typeof d.debugSetPose === 'function') d.debugSetPose('auto'); if (d && typeof d.debugSetGaze === 'function') d.debugSetGaze(NaN, NaN); return true })()`,
      false
    )
    // L-1：恢复探针临时关闭的自主活动为**改前原值**（异常/提前 return 路径也恢复）。
    if (configChangedByProbe && configBeforeProbe) {
      const patch = JSON.stringify({
        autonomous: configBeforeProbe.autonomous,
        dshLink: configBeforeProbe.dshLink
      })
      await execute<boolean>(`window.api.setConfig(${patch}).then(() => true)`, false)
    }
  }
}

/** 设置窗端到端探针结果（Wave 2 开工前置；`pet:show-settings` + 第二入口）。 */
interface SettingsWindowProbe {
  ok: boolean
  error?: string
  url?: string
  title?: string
  focusable?: boolean
  hasRoot?: boolean
  apiOk?: boolean
  electronHidden?: boolean
  windowCountAfterDestroy?: number
  overlayCount?: number
}

/**
 * 设置窗冒烟探针：从 overlay renderer invoke `window.api.showSettings()`（真实用户路径），
 * 断言设置窗被创建、加载第二入口 `settings.html`、普通可聚焦、preload 白名单可用，然后销毁。
 */
async function runSettingsWindowProbe(win: BrowserWindow): Promise<SettingsWindowProbe> {
  try {
    const invoked = (await win.webContents.executeJavaScript(`(async () => {
      try { await window.api.showSettings(); return { ok: true } } catch (error) { return { ok: false, error: String((error && error.message) || error) } }
    })()`)) as { ok?: boolean; error?: string }
    if (invoked?.ok !== true) return { ok: false, error: invoked?.error ?? 'showSettings failed' }

    let settingsWin: BrowserWindow | null = null
    const deadline = Date.now() + 8000
    while (Date.now() < deadline) {
      await delay(150)
      settingsWin = getSettingsWindow()
      if (settingsWin && !settingsWin.isDestroyed() && !settingsWin.webContents.isLoading()) break
    }
    if (!settingsWin) return { ok: false, error: 'settings window not created' }

    const url = settingsWin.webContents.getURL()
    const title = settingsWin.webContents.getTitle()
    const dom = (await settingsWin.webContents.executeJavaScript(`({
      hasRoot: !!document.getElementById('settings-root'),
      apiOk: typeof window.api === 'object' && window.api !== null && typeof window.api.getConfig === 'function',
      electron: typeof window.electron
    })`)) as { hasRoot?: boolean; apiOk?: boolean; electron?: string }

    const focusable = settingsWin.isFocusable()
    destroySettingsWindow()
    await delay(200)

    return {
      ok: true,
      url,
      title,
      focusable,
      hasRoot: dom?.hasRoot === true,
      apiOk: dom?.apiOk === true,
      electronHidden: dom?.electron === 'undefined',
      windowCountAfterDestroy: BrowserWindow.getAllWindows().length
    }
  } catch (error) {
    return { ok: false, error: toErrorMessage(error) }
  }
}

/** 冒烟模式下打印机器可读结果并退出；所有断言失败都会先打印 SMOKE_FAIL。 */
async function reportSmokeAndExit(win: BrowserWindow): Promise<void> {
  if (!SMOKE_TEST || smokeReporting || smokeReported || smokeFailed) return
  smokeReporting = true

  clearSmokeReportWatchdog()
  smokeReportWatchdog = setTimeout(() => {
    failSmoke(`smoke report timeout after ${SMOKE_REPORT_TIMEOUT_MS}ms`)
  }, SMOKE_REPORT_TIMEOUT_MS)

  try {
    assertSmoke(!win.isDestroyed(), 'window destroyed before smoke report')

    const display = screen.getPrimaryDisplay()
    const displayInfos = getDisplayInfos()
    const bounds = win.getBounds()

    // V1：按**生效后端**分流断言（主进程 config IPC 已套用 PET_MODEL_BACKEND/PET_ANIM_BACKEND env 覆盖）。
    const effectiveConfig = (await win.webContents.executeJavaScript(
      'window.api.getConfig()'
    )) as PetConfig
    const effectiveBackends = resolveBackendFlags(effectiveConfig)
    const isVrmBackend = effectiveBackends.modelBackend === 'vrm'
    appLogger?.info('[smoke] effective backends', effectiveBackends)

    // --- 窗口几何 / 焦点 / 置顶（主进程侧） ---
    assertSmoke(
      rectEquals(bounds, display.workArea),
      'window bounds must equal display.workArea',
      { bounds, workArea: display.workArea }
    )
    assertSmoke(win.isVisible(), 'window should be visible after load')
    assertSmoke(win.isFocusable() === false, 'window must not be focusable')
    assertSmoke(win.isFocused() === false, 'window must not be focused')
    assertSmoke(win.isAlwaysOnTop(), 'window should be alwaysOnTop')
    assertSmoke(win.isVisibleOnAllWorkspaces(), 'window should be visibleOnAllWorkspaces')
    assertSmoke(
      displayInfos.length === screen.getAllDisplays().length,
      'display info count mismatch',
      { displayInfos, allDisplays: screen.getAllDisplays().length }
    )

    // --- renderer 侧：preload 白名单 / window-info / pet-asset 协议 / CORS 不 taint ---
    const apiProbe = await runRendererApiProbe(win)
    if (!apiProbe || apiProbe.ok !== true) {
      failSmoke('renderer api/asset probe failed', apiProbe)
      throw new SmokeAssertionError('renderer api/asset probe failed')
    }
    assertSmoke(apiProbe.electronUndefined === true, 'window.electron must be undefined')
    assertSmoke(
      apiProbe.apiMethodCount === 18,
      'window.api must expose exactly 18 methods',
      { actual: apiProbe.apiMethodCount }
    )
    assertSmoke(apiProbe.hasOnScreensUpdated === true, 'window.api.onScreensUpdated must exist')

    const windowInfo = apiProbe.windowInfo
    if (!windowInfo) {
      failSmoke('pet:window-info returned no payload')
      throw new SmokeAssertionError('pet:window-info missing')
    }
    assertSmoke(windowInfo.id === win.id, 'pet:window-info id mismatch', {
      actual: windowInfo.id,
      expected: win.id
    })
    assertSmoke(windowInfo.displayId === display.id, 'pet:window-info displayId mismatch', {
      actual: windowInfo.displayId,
      expected: display.id
    })
    assertSmoke(windowInfo.bounds && rectEquals(windowInfo.bounds, bounds), 'pet:window-info bounds mismatch', {
      actual: windowInfo.bounds,
      expected: bounds
    })

    // --- legacy-pmx 后端：PMX 协议字节 / 优化产物 / 贴图 CORS（vrm 后端跳过，改断 VRM 资产）---
    const assetRoots = getAssetRoots()
    const primaryAssetRoot = assetRoots[0]
    let pmxProbe: RendererApiProbe['pmx'] = undefined
    let textureProbe: RendererApiProbe['texture'] = undefined
    const textureEntry = assetsManifest.textures[0]
    if (!isVrmBackend) {
    pmxProbe = apiProbe.pmx
    if (!pmxProbe || pmxProbe.status !== 200) {
      failSmoke('pet-asset PMX fetch must return 200', pmxProbe)
      throw new SmokeAssertionError('pmx fetch failed')
    }
    assertSmoke(
      pmxProbe.bytes === assetsManifest.pmx.bytes,
      'pet-asset PMX byteLength mismatch',
      {
        file: assetsManifest.pmx.file,
        actual: pmxProbe.bytes,
        expected: assetsManifest.pmx.bytes
      }
    )

    // --- 资产根：PMX 副本 / 贴图必须实际位于 pet-asset 主根（dev = optimized/） ---
    // 否则 dev 回退根会让上面的 200 + 字节数断言失真（独立复验 MED-2）；此处从
    // 主进程直接检查主根目录内容，是「PMX/贴图已进 optimized/」的独立证据。
    assertSmoke(
      existsSync(join(primaryAssetRoot, assetsManifest.pmx.file)),
      'PMX copy must exist in primary pet-asset root',
      { root: primaryAssetRoot, file: assetsManifest.pmx.file, roots: assetRoots }
    )

    assertSmoke(
      existsSync(join(primaryAssetRoot, textureEntry.optimized)),
      'manifest texture must exist in primary pet-asset root',
      { root: primaryAssetRoot, file: textureEntry.optimized, roots: assetRoots }
    )
    textureProbe = apiProbe.texture
    if (!textureProbe || textureProbe.ok !== true) {
      failSmoke('pet-asset texture CORS/canvas getImageData failed', textureProbe)
      throw new SmokeAssertionError('texture probe failed')
    }
    assertSmoke(
      textureProbe.naturalWidth === textureEntry.width &&
        textureProbe.naturalHeight === textureEntry.height,
      'texture dimensions mismatch',
      {
        name: textureEntry.optimized,
        actual: { width: textureProbe.naturalWidth, height: textureProbe.naturalHeight },
        expected: { width: textureEntry.width, height: textureEntry.height }
      }
    )
    assertSmoke(
      Array.isArray(textureProbe.pixel) && textureProbe.pixel.length === 4,
      'texture pixel readback failed',
      textureProbe
    )
    } // end if (!isVrmBackend)

    // --- 事件端到端：windows-updated / screens-updated ---
    // windows-updated 由 A4 poller 在窗口列表变化时也会广播，故只断言「至少 1 次到达」；
    // screens-updated 由本冒烟显式广播一次，但运行期显示器事件也可能额外广播，故只断言「至少 1 次」。
    const events = await runRendererEventsProbe(win)
    assertSmoke(events.windowsUpdated >= 1, 'windows-updated must reach renderer at least once', events)
    assertSmoke(events.screensUpdated >= 1, 'screens-updated must reach renderer at least once', events)
    // H-1 回归：screens-updated 必须触发 renderer 重新 invoke pet:window-info（不能用启动快照）。
    assertSmoke(
      events.geometryRefreshAfter > events.geometryRefreshBefore,
      'screens-updated must trigger window-info refresh (H-1)',
      events
    )

    // --- Wave 1 集成断言（A1 多屏 overlay/托盘 + A3 config + A4 windows + 显隐语义） ---
    const manager = getActiveOverlayWindowsManager()
    assertSmoke(manager !== null, 'overlay windows manager must be active')

    const allDisplays = screen.getAllDisplays()
    const overlays = manager?.getWindows() ?? []
    assertSmoke(
      overlays.length === allDisplays.length,
      'one overlay window per display',
      { overlays: overlays.length, displays: allDisplays.length }
    )

    // 显示器 workArea 可能在冒烟报告期间变化（Dock/菜单栏自动隐藏等系统指标抖动，观测过 961↔963）：
    // A1 的 display-* watcher 有 200ms debounce，若 report 恰好抢在重建前读到新 workArea 会误报。
    // 这里做最多 ~2s 的「重新取显示器 + 重算 overlay 几何」轮询，仍要求**精确相等**（不放宽断言）。
    let overlayGeometry = allDisplays.map((entry) => {
      const overlayWin = manager?.getWindowForDisplay(entry.id) ?? null
      return {
        displayId: entry.id,
        workArea: entry.workArea,
        bounds: overlayWin ? overlayWin.getBounds() : null,
        focusable: overlayWin ? overlayWin.isFocusable() : null,
        visible: overlayWin ? overlayWin.isVisible() : false
      }
    })
    const overlayMatches = (): boolean =>
      overlayGeometry.every(
        (entry) => entry.bounds !== null && rectEquals(entry.bounds, entry.workArea)
      )
    const overlayDeadline = Date.now() + 2000
    while (!overlayMatches() && Date.now() < overlayDeadline) {
      await delay(150)
      // 重新取当前显示器快照（Electron Display）并与 A1 已重建的 overlay 几何对齐
      const currentDisplays = screen.getAllDisplays()
      overlayGeometry = currentDisplays.map((entry) => {
        const overlayWin = manager?.getWindowForDisplay(entry.id) ?? null
        return {
          displayId: entry.id,
          workArea: entry.workArea,
          bounds: overlayWin ? overlayWin.getBounds() : null,
          focusable: overlayWin ? overlayWin.isFocusable() : null,
          visible: overlayWin ? overlayWin.isVisible() : false
        }
      })
    }
    assertSmoke(
      overlayMatches(),
      'every overlay bounds must equal its display.workArea',
      overlayGeometry
    )
    assertSmoke(
      overlayGeometry.every((entry) => entry.focusable === false),
      'every overlay must be non-focusable',
      overlayGeometry
    )

    // 托盘（A1）：macOS template image，getBounds() 非空即证明图标已进菜单栏
    const tray = getActiveTray()
    const trayBounds = tray ? tray.getBounds() : null
    assertSmoke(tray !== null, 'tray must be created')
    assertSmoke(
      trayBounds !== null && trayBounds.width > 0 && trayBounds.height > 0,
      'tray icon should have non-empty bounds',
      trayBounds
    )

    // renderer 侧真实 invoke：config / windows / accessibility / ignore-mouse
    const wave1Probe = (await win.webContents.executeJavaScript(`(async () => {
      const api = window.api
      const result = { ok: true }
      try {
        result.config = await api.getConfig()
        const changed = []
        const unsubscribe = api.onConfigChanged((next) => changed.push(next))
        const target = result.config.sizePercent === 45 ? 40 : 45
        result.setConfig = await api.setConfig({ sizePercent: target, opacity: 9 })
        await new Promise((resolve) => setTimeout(resolve, 150))
        result.configEvents = changed.length
        result.configEventPayload = changed[changed.length - 1] || null
        result.restored = await api.setConfig({
          sizePercent: result.config.sizePercent,
          opacity: result.config.opacity
        })
        unsubscribe()
        result.windows = await api.getWindows()
        result.accessibility = await api.getAccessibilityStatus()
        // Wave 2 B7：DSH 状态 IPC（DSH 未运行时应返回离线默认值而非抛错）
        result.dshStatus = await api.getDshStatus()
        try {
          await api.setIgnoreMouse(false)
          await api.setIgnoreMouse(true)
          result.ignoreMouseOk = true
        } catch (error) {
          result.ignoreMouseOk = String((error && error.message) || error)
        }
      } catch (error) {
        return { ok: false, error: String((error && error.message) || error) }
      }
      return result
    })()`)) as {
      ok?: boolean
      error?: string
      config?: Record<string, unknown>
      setConfig?: { sizePercent?: number; opacity?: number }
      configEvents?: number
      configEventPayload?: { sizePercent?: number; opacity?: number } | null
      restored?: { sizePercent?: number; opacity?: number }
      windows?: unknown
      accessibility?: { accessibility?: unknown; notifications?: unknown }
      dshStatus?: { online?: unknown; running?: unknown; lastEventAt?: unknown; lastType?: unknown }
      ignoreMouseOk?: boolean | string
    }
    if (!wave1Probe || wave1Probe.ok !== true) {
      failSmoke('wave1 renderer probe failed', wave1Probe)
      throw new SmokeAssertionError('wave1 renderer probe failed')
    }
    assertSmoke(
      wave1Probe.dshStatus !== undefined &&
        typeof wave1Probe.dshStatus.online === 'boolean' &&
        typeof wave1Probe.dshStatus.running === 'boolean' &&
        typeof wave1Probe.dshStatus.lastEventAt === 'number' &&
        (wave1Probe.dshStatus.lastType === null || typeof wave1Probe.dshStatus.lastType === 'string'),
      'pet:dsh-status must return DshStatus shape (B7)',
      wave1Probe.dshStatus
    )
    // W0-3 起 DEFAULT_CONFIG 扩到 14 键（modelBackend/animBackend/motionSet）：期望键数
    // 从 @shared/config 单源派生，契约扩键时 smoke 不再假失败（旧硬编码 11 会必失败）。
    const expectedConfigKeys = Object.keys(DEFAULT_CONFIG).length
    assertSmoke(
      wave1Probe.config !== undefined &&
        Object.keys(wave1Probe.config).length === expectedConfigKeys,
      `pet:get-config must return a complete PetConfig (${expectedConfigKeys} keys)`,
      wave1Probe.config
    )
    assertSmoke(
      typeof wave1Probe.config?.sizePercent === 'number' &&
        wave1Probe.setConfig?.sizePercent !== undefined,
      'pet:set-config must clamp/apply sizePercent',
      { config: wave1Probe.config, setConfig: wave1Probe.setConfig }
    )
    assertSmoke(
      wave1Probe.setConfig?.opacity === 1,
      'pet:set-config must clamp opacity 9 -> 1',
      wave1Probe.setConfig
    )
    assertSmoke(
      wave1Probe.configEvents === 1,
      'config-changed must reach renderer exactly once',
      { events: wave1Probe.configEvents }
    )
    assertSmoke(
      wave1Probe.configEventPayload?.sizePercent === wave1Probe.setConfig?.sizePercent,
      'config-changed payload must match saved config',
      wave1Probe.configEventPayload
    )
    assertSmoke(
      wave1Probe.restored?.sizePercent === wave1Probe.config?.sizePercent,
      'pet:set-config restore must persist original sizePercent',
      { restored: wave1Probe.restored, original: wave1Probe.config?.sizePercent }
    )
    assertSmoke(Array.isArray(wave1Probe.windows), 'pet:windows must return an array', wave1Probe.windows)
    const winList = wave1Probe.windows as Array<Record<string, unknown>>
    // native helper 门禁（M-6/A4-F02）：helper 缺失/构建失败时 poller 降级为 []，
    // 下面 `winList.every(...)` 对空数组会真空通过。这里断言至少枚举到一个窗口，
    // 保证「A4 真实工作」而不是「安静降级」。
    assertSmoke(
      winList.length > 0,
      'pet:windows must enumerate at least one window (native winlist helper gate)',
      { count: winList.length }
    )
    assertSmoke(
      winList.every((entry) => {
        const boundsValue = entry['bounds'] as Record<string, unknown> | undefined
        return (
          typeof entry['id'] === 'number' &&
          typeof entry['pid'] === 'number' &&
          typeof entry['owner'] === 'string' &&
          typeof entry['layer'] === 'number' &&
          typeof entry['alpha'] === 'number' &&
          typeof entry['onScreen'] === 'boolean' &&
          boundsValue !== undefined &&
          typeof boundsValue['x'] === 'number' &&
          typeof boundsValue['y'] === 'number' &&
          typeof boundsValue['width'] === 'number' &&
          typeof boundsValue['height'] === 'number'
        )
      }),
      'pet:windows entries must match WindowInfo shape',
      winList.slice(0, 3)
    )
    assertSmoke(
      typeof wave1Probe.accessibility?.accessibility === 'boolean' &&
        typeof wave1Probe.accessibility?.notifications === 'string',
      'pet:accessibility-status must return AccessibilityStatus',
      wave1Probe.accessibility
    )
    assertSmoke(
      wave1Probe.ignoreMouseOk === true,
      'pet:set-ignore-mouse must not throw',
      wave1Probe.ignoreMouseOk
    )

    // --- 渲染结果断言（A2 合并后）：debug 面 + 实际帧 alpha 覆盖 ---
    const renderDebug = (await win.webContents.executeJavaScript(`(() => {
      const debug = window.__aventurineDebug
      if (!debug) return { present: false }
      let stats = null
      try { stats = typeof debug.stats === 'function' ? debug.stats() : null } catch (error) { stats = { error: String(error) } }
      const pick = (value) => { try { return JSON.parse(JSON.stringify(value)) } catch { return null } }
      return {
        present: true,
        ready: debug.ready === true,
        model: debug.model ? JSON.parse(JSON.stringify(debug.model)) : null,
        stats,
        vrm: debug.vrm ? pick(debug.vrm) : null,
        vrmDrivers: debug.vrmDrivers ? pick(debug.vrmDrivers) : null,
        animation: debug.animation ? pick(debug.animation) : null
      }
    })()`)) as {
      present?: boolean
      ready?: boolean
      model?: {
        loaded?: boolean
        morphNames?: string[]
        materialNames?: string[]
        textureCount?: number
        missingTextures?: string[]
        vertexCount?: number
        triangleCount?: number
      } | null
      stats?: {
        fps?: number
        drawCalls?: number
        triangles?: number
        petHeightPx?: number
        outlinePx?: number
        petRect?: { x: number; y: number; width: number; height: number }
        displayId?: number | null
        isPrimaryDisplay?: boolean
      } | null
      vrm?: {
        avatarId?: string
        avatarFile?: string
        specVersion?: string
        humanoidBoneCount?: number
        requiredMissingBones?: string[]
        expressionCount?: number
        springChainCount?: number
        lookAtMode?: string | null
        bodyAspectRatio?: number
        restHeightMeters?: number
        hipsRestHeight?: number
        materialCount?: number
        yawOffsetDeg?: number
      } | null
      vrmDrivers?: { clips?: boolean; expressions?: boolean; lookAt?: boolean } | null
      animation?: { clipId?: string | null; pose?: string; source?: string | null } | null
    }
    let vrmAssetProbe: VrmAssetProbe | null = null
    assertSmoke(renderDebug.present === true, 'window.__aventurineDebug must exist')
    assertSmoke(renderDebug.ready === true, 'renderer must report ready (model + textures loaded)')
    assertSmoke(renderDebug.model?.loaded === true, 'model must be loaded')

    if (isVrmBackend) {
      // --- VRM 后端（V1/V5）：humanoid/expression/spring/clip + 私有资产协议 ---
      const vrm = renderDebug.vrm
      if (!vrm) {
        failSmoke('debug.vrm 缺失：VRM 场景未加载或诊断未接线', renderDebug.model)
        throw new SmokeAssertionError('debug.vrm missing')
      }
      assertSmoke(
        typeof vrm.avatarId === 'string' && vrm.avatarId.length > 0,
        'VRM avatar id must be present',
        vrm
      )
      assertSmoke(
        typeof vrm.humanoidBoneCount === 'number' && vrm.humanoidBoneCount >= 15,
        'VRM humanoid normalized bones must be >= 15 (required core)',
        vrm
      )
      assertSmoke(
        Array.isArray(vrm.requiredMissingBones) && vrm.requiredMissingBones.length === 0,
        'VRM required humanoid bones must all be mapped (requiredMissingBones empty)',
        vrm
      )
      assertSmoke(
        typeof vrm.expressionCount === 'number' && vrm.expressionCount >= 9,
        'VRM expression manager must expose presets (>= 9)',
        vrm
      )
      assertSmoke(
        typeof vrm.springChainCount === 'number' && vrm.springChainCount > 0,
        'target VRM must have spring bone chains (hair/cloth)',
        vrm
      )
      assertSmoke(
        (renderDebug.model?.materialNames?.length ?? 0) > 0 &&
          (renderDebug.model?.textureCount ?? 0) > 0 &&
          (renderDebug.model?.missingTextures?.length ?? -1) === 0,
        'VRM materials/textures must load (missingTextures empty)',
        renderDebug.model
      )
      assertSmoke(
        (renderDebug.model?.vertexCount ?? 0) > 5000 && (renderDebug.model?.triangleCount ?? 0) > 5000,
        'VRM mesh should have expected complexity (not a placeholder)',
        { vertexCount: renderDebug.model?.vertexCount, triangleCount: renderDebug.model?.triangleCount }
      )
      assertSmoke(
        renderDebug.animation?.clipId !== null &&
          typeof renderDebug.animation?.clipId === 'string' &&
          String(renderDebug.animation?.clipId).length > 0,
        'VRM clip player must be playing a clip (animation.clipId non-empty)',
        renderDebug.animation
      )
      vrmAssetProbe = await runVrmAssetProbe(win, String(vrm.avatarFile ?? ''))
      assertSmoke(vrmAssetProbe.ok === true, 'pet-asset://assets VRM/动作清单 fetch 失败', vrmAssetProbe)
    } else {
      // --- legacy-pmx 后端（v1 回退路径）：morph/material/texture 精确断言 ---
      assertSmoke(
        renderDebug.model?.morphNames?.length === 85,
        'PMX morph count must be 85',
        { actual: renderDebug.model?.morphNames?.length }
      )
      assertSmoke(
        renderDebug.model?.materialNames?.length === 39,
        'PMX material count must be 39',
        { actual: renderDebug.model?.materialNames?.length }
      )
      assertSmoke(
        renderDebug.model?.textureCount === 20 && (renderDebug.model?.missingTextures?.length ?? -1) === 0,
        'all 20 textures must load (missingTextures empty)',
        renderDebug.model
      )
    }
    assertSmoke(
      (renderDebug.stats?.drawCalls ?? 0) > 0 && (renderDebug.stats?.triangles ?? 0) > 1000,
      'renderer must draw the model',
      renderDebug.stats
    )
    // 尺寸按当前配置动态计算（sizePercent% × bounds.height，100% 时受 workArea.height 封顶；
    // 不再硬编码 324/540）
    const configuredSizePercent = Number(wave1Probe.config?.['sizePercent'] ?? NaN)
    const expectedPetHeightPx = Number.isFinite(configuredSizePercent)
      ? Math.round(
          Math.min(
            (configuredSizePercent / 100) * display.bounds.height,
            display.workArea.height
          )
        )
      : NaN
    assertSmoke(
      Number.isFinite(expectedPetHeightPx) &&
        Math.abs((renderDebug.stats?.petHeightPx ?? 0) - expectedPetHeightPx) <= 2,
      `pet height must equal min(sizePercent% × bounds.height, workArea.height) (${expectedPetHeightPx}px)`,
      { stats: renderDebug.stats, configuredSizePercent, expectedPetHeightPx }
    )
    assertSmoke(
      renderDebug.stats?.isPrimaryDisplay === true,
      'pet must render on the primary display only',
      renderDebug.stats
    )
    // 描边方案 B（PLAN §19.11）：屏幕空间恒定 CSS 像素、随宠物高度自适应（0.45–1.6px）
    const outlinePx = renderDebug.stats?.outlinePx ?? 0
    if (isVrmBackend) {
      // VRM 走 MToon 内建描边（宽度以材质参数为准；V6 调参），此处只做上界防御。
      assertSmoke(
        outlinePx >= 0 && outlinePx <= 3,
        `VRM MToon outline width must be sane (0–3 CSS px, actual ${outlinePx})`,
        { outlinePx, stats: renderDebug.stats }
      )
    } else {
      assertSmoke(
        outlinePx >= 0.45 && outlinePx <= 1.6,
        `outline width must be screen-space adaptive (0.45–1.6 CSS px, actual ${outlinePx})`,
        { outlinePx, stats: renderDebug.stats }
      )
    }
    const smokeFps = renderDebug.stats?.fps ?? 0
    const configuredFpsCap = Number(wave1Probe.config?.['fpsCap'] ?? NaN)
    const fpsUpperBound = Math.max(35, (Number.isFinite(configuredFpsCap) ? configuredFpsCap : 30) + 10)
    assertSmoke(
      smokeFps > 5 && smokeFps <= fpsUpperBound,
      `fps must be capped (fpsCap=${configuredFpsCap})`,
      { fps: smokeFps, upper: fpsUpperBound }
    )

    // 实际帧 alpha 覆盖：透明窗合成结果里必须有足够多不透明像素（宠物真的画出来了）
    const smokeShot = await win.webContents.capturePage()
    const smokeBitmap = smokeShot.toBitmap()
    const smokeShotSize = smokeShot.getSize()
    let renderedOpaquePixels = 0
    for (let index = 3; index < smokeBitmap.length; index += 4) {
      if (smokeBitmap[index] > 8) renderedOpaquePixels += 1
    }
    // 阈值按当前配置的宠物高度推导（10% 配置下 ~108px 高，固定 15000 会假失败；1080p/50% 时实际约 5 万）。
    const minOpaquePixels = Math.max(300, Math.round(expectedPetHeightPx * 3))
    assertSmoke(
      renderedOpaquePixels > minOpaquePixels,
      'captured frame must contain the rendered pet (opaque pixels)',
      {
        opaquePixels: renderedOpaquePixels,
        minOpaquePixels,
        petHeightPx: expectedPetHeightPx,
        size: smokeShotSize,
        bytes: smokeBitmap.length
      }
    )

    // --- 悬停拦截端到端（M-3）：合成 mousemove 命中宠物矩形 → renderer 请求拦截、主进程生效；移出 → 穿透 ---
    // 稳定性：先关闭自主活动，避免宠物在「读 petRect → 派发合成 mousemove」之间走动导致偶发 miss
    // （2026-11-08 一次 dev smoke 偶失败复现）。
    // L-1：本段会临时改配置 —— 记录原值并在 finally 恢复（异常路径也恢复），不再依赖
    // wave2 探针「顺手」把 autonomous 改回 true（那会抹掉用户原本 autonomous=false 的配置）。
    // 探针结果在 try 外声明、try 内赋值：payload 汇总在 try/finally 之后仍需引用它们。
    let clickThroughEnabled = false
    let pointerInsideProbe: {
      ok?: boolean
      reason?: string
      rect?: { x: number; y: number; width: number; height: number }
      hitCenter?: { x: number; y: number }
      intercepting?: boolean
    } | null = null
    let mainIgnoredInside: boolean | null = null
    let pointerOutsideState: boolean | null = null
    let mainIgnoredOutside: boolean | null = null
    const autonomousBeforeHover = wave1Probe.config?.['autonomous'] === true
    try {
      await win.webContents.executeJavaScript('window.api.setConfig({ autonomous: false })')
      await delay(200)
      clickThroughEnabled = wave1Probe.config?.['clickThrough'] !== false
      pointerInsideProbe = (await win.webContents.executeJavaScript(`(async () => {
        const debug = window.__aventurineDebug
        const stats = debug && typeof debug.stats === 'function' ? debug.stats() : null
        const rect = stats && stats.petRect ? stats.petRect : null
        if (!rect || !(rect.width > 0) || !(rect.height > 0)) return { ok: false, reason: 'no petRect', rect }
        const centerX = rect.x + rect.width / 2
        const centerY = rect.y + rect.height / 2
        window.dispatchEvent(new MouseEvent('mousemove', { clientX: centerX, clientY: centerY, bubbles: true }))
        await new Promise((resolve) => setTimeout(resolve, 180))
        return {
          ok: true,
          rect,
          hitCenter: { x: centerX, y: centerY },
          intercepting: debug.pointerIntercepting === true
        }
      })()`)) as {
        ok?: boolean
        reason?: string
        rect?: { x: number; y: number; width: number; height: number }
        hitCenter?: { x: number; y: number }
        intercepting?: boolean
      }
      assertSmoke(pointerInsideProbe?.ok === true, 'pointer hover probe failed (no petRect)', pointerInsideProbe)
      assertSmoke(
        pointerInsideProbe?.intercepting === true,
        'mousemove over pet must request mouse interception (M-3)',
        pointerInsideProbe
      )
      await delay(80)
      mainIgnoredInside = getIgnoreMouseAppliedState(win)
      assertSmoke(
        mainIgnoredInside === false,
        'main process must apply setIgnoreMouseEvents(false) while hovering pet',
        { mainIgnoredInside }
      )
      await win.webContents.executeJavaScript(
        `window.dispatchEvent(new MouseEvent('mousemove', { clientX: 1, clientY: 1, bubbles: true }))`
      )
      await delay(260)
      pointerOutsideState = (await win.webContents.executeJavaScript(
        `(window.__aventurineDebug && window.__aventurineDebug.pointerIntercepting === true)`
      )) as boolean
      mainIgnoredOutside = getIgnoreMouseAppliedState(win)
      if (clickThroughEnabled) {
        assertSmoke(
          pointerOutsideState === false,
          'mousemove outside pet must request pass-through (M-3)',
          { pointerOutsideState }
        )
        assertSmoke(
          mainIgnoredOutside === true,
          'main process must apply setIgnoreMouseEvents(true) after leaving pet',
          { mainIgnoredOutside }
        )
      }
    } finally {
      // L-1：恢复 hover 探针改动的自主活动原值（断言失败/窗口异常也走这里）。
      await win.webContents
        .executeJavaScript(
          `window.api.setConfig({ autonomous: ${autonomousBeforeHover} }).catch(() => undefined)`
        )
        .catch(() => undefined)
    }

    // 显隐语义（A1）：hide 生效、showInactive 恢复且仍不抢焦点
    await win.webContents.executeJavaScript('window.api.setVisible(false)')
    await delay(150)
    const hiddenAfterSetVisible = win.isVisible() === false
    await win.webContents.executeJavaScript('window.api.setVisible(true)')
    await delay(200)
    const shownAfterSetVisible = win.isVisible() === true
    assertSmoke(hiddenAfterSetVisible, 'pet:set-visible(false) must hide overlays')
    assertSmoke(shownAfterSetVisible, 'pet:set-visible(true) must show overlays')
    assertSmoke(win.isFocused() === false, 'overlay must stay unfocused after showInactive')

    // Wave 2（B1–B5）端到端：动画姿态/行为/物理/桌面/眨眼/姿态切换/注视
    // V1：VRM 后端在表情/look-at 层接线前跳过对应两项（V6 接线后自动恢复断言）。
    // legacy-pmx 后端已删除 v1 自定义动作（用户决策）：不再要求动画驱动，只验证静态渲染 + 行为/物理/桌面。
    const expectSceneAnimation = isVrmBackend
    const wave2Probe = await runWave2Probe(win, {
      expectAnimation: expectSceneAnimation,
      expectBlink: expectSceneAnimation && renderDebug.vrmDrivers?.expressions === true,
      expectLookAt: expectSceneAnimation && renderDebug.vrmDrivers?.lookAt === true
    })
    assertSmoke(wave2Probe.ok === true, 'wave2 animation/behavior probe failed', wave2Probe)
    if (expectSceneAnimation) {
      assertSmoke(
        typeof wave2Probe.initial?.animation?.pose === 'string' &&
          String(wave2Probe.initial?.animation?.pose).length > 0,
        'B3 animation pose must be a non-empty id',
        wave2Probe.initial?.animation
      )
      assertSmoke(
        Array.isArray(wave2Probe.initial?.animation?.missingBones) &&
          (wave2Probe.initial?.animation?.missingBones as unknown[]).length === 0,
        'B3 animator must resolve all required bones (missingBones empty)',
        wave2Probe.initial?.animation
      )
    }
    assertSmoke(
      wave2Probe.initial?.behavior !== null &&
        typeof wave2Probe.initial?.behavior?.mood === 'string' &&
        typeof wave2Probe.initial?.behavior?.activity === 'string',
      'B1 behavior snapshot must expose mood/activity',
      wave2Probe.initial?.behavior
    )
    assertSmoke(
      Number.isFinite(wave2Probe.initial?.motion?.feet?.x) &&
        Number.isFinite(wave2Probe.initial?.motion?.feet?.y),
      'B2 motion snapshot must expose finite feet',
      wave2Probe.initial?.motion
    )
    assertSmoke(
      typeof wave2Probe.initial?.desktop?.surfaces === 'number' &&
        (wave2Probe.initial?.desktop?.surfaces as number) >= 1 &&
        Array.isArray(wave2Probe.initial?.desktop?.kinds) &&
        (wave2Probe.initial?.desktop?.kinds as string[]).includes('screen-bottom'),
      'B5 desktop snapshot must expose surfaces (incl. screen-bottom)',
      wave2Probe.initial?.desktop
    )
    if (expectSceneAnimation && renderDebug.vrmDrivers?.expressions === true) {
      assertSmoke(wave2Probe.blinkSeen === true, 'B3 blink must occur within 8s', {
        blinkSeen: wave2Probe.blinkSeen,
        blinkMs: wave2Probe.blinkMs
      })
    }
    if (expectSceneAnimation) {
    const poseSwitchOk = isVrmBackend
      ? wave2Probe.poseSwitch?.sitApplied === true &&
        wave2Probe.poseSwitch?.standApplied === true &&
        typeof wave2Probe.poseSwitch?.sitPose === 'string' &&
        (wave2Probe.poseSwitch?.sitPose as string).length > 0 &&
        typeof wave2Probe.poseSwitch?.standPose === 'string' &&
        (wave2Probe.poseSwitch?.standPose as string).length > 0 &&
        wave2Probe.poseSwitch?.sitPose !== wave2Probe.poseSwitch?.standPose
      : wave2Probe.poseSwitch?.sitApplied === true &&
        wave2Probe.poseSwitch?.sitPose === 'sit' &&
        wave2Probe.poseSwitch?.standApplied === true &&
        wave2Probe.poseSwitch?.standPose === 'stand'
    assertSmoke(poseSwitchOk, 'B3/V1 debugSetPose must switch sit/stand', wave2Probe.poseSwitch)
    }
    // VRM 贴地由 clip-player 的每 clip 常量补偿保证；未接地 clip（grounding=none）为 null。
    if (!expectSceneAnimation) {
      // legacy：无动画驱动，跳过贴地断言（静态 rest 由 PMX 渲染层摆放）。
    } else if (isVrmBackend) {
      assertSmoke(
        wave2Probe.poseSwitch?.footErrorPx === null ||
          (typeof wave2Probe.poseSwitch?.footErrorPx === 'number' &&
            (wave2Probe.poseSwitch?.footErrorPx as number) < 4),
        'VRM clip pose must keep feet on ground (footErrorPx < 4 or null)',
        wave2Probe.poseSwitch
      )
    } else {
      assertSmoke(
        typeof wave2Probe.poseSwitch?.footErrorPx === 'number' &&
          (wave2Probe.poseSwitch?.footErrorPx as number) < 2.5,
        'B3 stand pose must keep feet on ground (footErrorPx < 2.5)',
        wave2Probe.poseSwitch
      )
    }
    // 注视强制角会被「朝向局部化 + ±31° 钳制」影响：front → 25°、left → clamp(115°)=31°、right → clamp(-65°)=-31°。
    // V7 起 VRM look-at 层：override（debugSetGaze）按模型局部角且优先级最高（恒为请求值 25°）；
    // 非 override 的鼠标注视在侧身（facing≠front）时做模型局部换算、移动类 mood 抑制——不影响本断言。
    const facingForGaze = wave2Probe.gaze?.facing ?? 'front'
    const expectedGazeDeg = isVrmBackend
      ? 25
      : facingForGaze === 'front'
        ? 25
        : facingForGaze === 'left'
          ? 31
          : -31
    if (expectSceneAnimation && renderDebug.vrmDrivers?.lookAt === true) {
      assertSmoke(
        typeof wave2Probe.gaze?.actualDeg === 'number' &&
          Math.abs((wave2Probe.gaze?.actualDeg as number) - expectedGazeDeg) <= 2.5,
        `B3 look-at must track forced gaze (facing=${facingForGaze}, expected ${expectedGazeDeg}° ± 2.5°)`,
        wave2Probe.gaze
      )
    }

    // Wave 2 开工前置：设置窗第二入口 + `pet:show-settings` 端到端（真实 renderer invoke）
    const overlayCountNow = manager ? manager.getWindows().length : 0
    const settingsProbe = await runSettingsWindowProbe(win)
    assertSmoke(settingsProbe.ok === true, 'pet:show-settings / settings window failed', settingsProbe)
    assertSmoke(
      typeof settingsProbe.url === 'string' && settingsProbe.url.includes('settings.html'),
      'settings window must load the settings.html second entry',
      settingsProbe
    )
    assertSmoke(settingsProbe.title === '砂金·戏浪 — 设置', 'settings window title mismatch', settingsProbe)
    assertSmoke(settingsProbe.focusable === true, 'settings window must be focusable', settingsProbe)
    assertSmoke(settingsProbe.hasRoot === true, 'settings page must have #settings-root', settingsProbe)
    assertSmoke(settingsProbe.apiOk === true, 'settings page must expose window.api', settingsProbe)
    assertSmoke(settingsProbe.electronHidden === true, 'settings page must not expose window.electron', settingsProbe)
    assertSmoke(
      settingsProbe.windowCountAfterDestroy === overlayCountNow,
      'settings window must be destroyed after probe (overlay count restored)',
      { settingsProbe, overlayCountNow }
    )

    const payload = {
      backends: effectiveBackends,
      vrm: isVrmBackend
        ? {
            diagnostics: renderDebug.vrm ?? null,
            drivers: renderDebug.vrmDrivers ?? null,
            animation: renderDebug.animation ?? null,
            assetProbe: vrmAssetProbe,
            clipPlayer: {
              clipId: renderDebug.animation?.clipId ?? null
            }
          }
        : null,
      smoke: {
        mode: 'PET_SMOKE_TEST=1',
        // 运行时状态（非字面量）：加载 watchdog 已在 did-finish-load 清除；报告 watchdog 仍在计时
        loadWatchdogCleared: smokeLoadWatchdog === null,
        reportWatchdogArmed: smokeReportWatchdog !== null,
        failed: smokeFailed
      },
      displays: displayInfos,
      dispatch: {
        primaryDisplayId: display.id,
        displayCount: displayInfos.length
      },
      window: {
        bounds,
        workArea: display.workArea,
        // 由实际 getBounds()/workArea 计算，不是写死的 true
        boundsEqualsWorkArea: rectEquals(bounds, display.workArea),
        visible: win.isVisible(),
        isFocusable: win.isFocusable(),
        isFocused: win.isFocused(),
        alwaysOnTop: win.isAlwaysOnTop(),
        visibleOnAllWorkspaces: win.isVisibleOnAllWorkspaces()
      },
      wave1: {
        overlays: overlayGeometry,
        overlayCount: overlays.length,
        tray: { created: tray !== null, bounds: trayBounds },
        config: {
          initial: wave1Probe.config,
          setResult: wave1Probe.setConfig,
          events: wave1Probe.configEvents,
          eventPayload: wave1Probe.configEventPayload,
          restored: wave1Probe.restored
        },
        windows: { count: winList.length, sample: winList.slice(0, 3) },
        accessibility: wave1Probe.accessibility,
        ignoreMouseOk: wave1Probe.ignoreMouseOk,
        pointerGate: {
          clickThroughEnabled,
          inside: pointerInsideProbe,
          outsideIntercepting: pointerOutsideState,
          mainIgnoredInside,
          mainIgnoredOutside
        },
        geometryRefresh: {
          before: events.geometryRefreshBefore,
          after: events.geometryRefreshAfter
        },
        render: {
          present: renderDebug.present,
          ready: renderDebug.ready,
          model: renderDebug.model,
          stats: renderDebug.stats,
          outlinePx,
          capturedOpaquePixels: renderedOpaquePixels,
          captureSize: smokeShotSize
        },
        visibilityToggle: {
          hiddenAfterSetVisible,
          shownAfterSetVisible,
          focusedAfterShow: win.isFocused()
        }
      },
      // Wave 2：设置窗第二入口 + pet:show-settings（后续 B1-B7 集成断言继续加在这里）
      wave2: {
        settings: settingsProbe,
        dsh: wave1Probe.dshStatus ?? null,
        animation: wave2Probe.initial?.animation ?? null,
        behavior: wave2Probe.initial?.behavior ?? null,
        motion: wave2Probe.initial?.motion ?? null,
        desktop: wave2Probe.initial?.desktop ?? null,
        interaction: wave2Probe.initial?.interaction ?? null,
        blink: { seen: wave2Probe.blinkSeen, ms: wave2Probe.blinkMs },
        poseSwitch: wave2Probe.poseSwitch ?? null,
        gaze: wave2Probe.gaze ?? null
      },
      // Wave 2.5：外部动作清单（可选素材；不存在时 manifestExists=false，断言按跳过处理）
      // Electron 无公开 getter 的构造期配置：集中到 constructOnly，不混入运行时断言结果
      // （独立复验 MED-4；M-10 修复：值来自 overlay-manager 的窗口构造共享常量，单源派生，
      // 不再是 index.ts 里的字面量；PLAN §17.3-9 已披露全部字段，排障以源码为准）。
      constructOnly: {
        note: 'Electron 无公开 getter，以下为构造期配置值（由 overlay-manager 单源常量派生）',
        ...getOverlayConstructOnlySnapshot()
      },
      preload: {
        electronUndefined: apiProbe.electronUndefined,
        apiMethodCount: apiProbe.apiMethodCount,
        onScreensUpdated: apiProbe.hasOnScreensUpdated
      },
      windowInfo,
      protocol: {
        pmx: {
          url: petAssetUrl(assetsManifest.pmx.file),
          file: assetsManifest.pmx.file,
          status: pmxProbe?.status ?? null,
          bytes: pmxProbe?.bytes ?? null,
          expectedBytes: assetsManifest.pmx.bytes
        },
        texture: {
          url: petAssetUrl(textureEntry.optimized),
          name: textureEntry.optimized,
          naturalWidth: textureProbe?.naturalWidth ?? null,
          naturalHeight: textureProbe?.naturalHeight ?? null,
          expectedWidth: textureEntry.width,
          expectedHeight: textureEntry.height
        }
      },
      assetRoots: {
        roots: assetRoots,
        pmxCopyInPrimaryRoot: existsSync(join(primaryAssetRoot, assetsManifest.pmx.file)),
        textureInPrimaryRoot: existsSync(join(primaryAssetRoot, textureEntry.optimized))
      },
      taint: {
        // 运行时结果：图片加载 + canvas getImageData 成功（失败会在上面 failSmoke）
        imageLoadOk: textureProbe?.ok === true,
        pixel: textureProbe?.pixel ?? null
      },
      events,
      electron: process.versions.electron,
      chrome: process.versions.chrome
    }

    smokeReported = true
    clearSmokeLoadWatchdog()
    clearSmokeReportWatchdog()
    clearSmokeReportTimer()
    console.log(`SMOKE_OK ${JSON.stringify(payload)}`)
    app.exit(0)
  } catch (error) {
    if (!smokeFailed) failSmoke('smoke report failed', error)
  } finally {
    smokeReporting = false
  }
}

/* ------------------------------ 启动接线 ------------------------------ */

/**
 * ready 后的一次性初始化。
 *
 * Wave 1（A1 合并）接线：
 * 1. overlay 窗口交给 `overlay-manager`（每 display 一个；显示器变化 debounce 重建 + `screens-updated`）；
 * 2. 托盘交给 `tray.ts`（显示/隐藏/设置占位/退出；模块内持有强引用防 GC）；
 * 3. 退出语义（LOW-13）：托盘常驻时窗口隐藏/关闭**不退出 app**，退出只走托盘「退出」/`pet:quit`。
 */
function bootstrap(): void {
  try {
    if (process.platform === 'darwin') {
      // accessory：无 Dock 图标、不进入 Cmd+Tab、不抢前台（桌宠语义）。
      app.setActivationPolicy('accessory')
      app.dock?.hide()
    }

    hardenSession()
    // 进程级日志（F6）：userData/logs/main.log；目录不可写时 logger 内部降级 console，不阻断启动。
    appLogger = createLogger({ dir: join(app.getPath('userData'), 'logs') })
    // R-05：生产态崩溃恢复策略（与 `hardenWebContents` 共用；冒烟模式保持 null 不挂）。
    if (!SMOKE_TEST) {
      crashRecovery = createCrashRecovery({
        now: () => Date.now(),
        logger: appLogger ?? undefined
      })
    }
    registerPetAssetProtocol(appLogger)
    // L-3：把进程级 logger 注入各领域 registrar / 窗口模块（同一实例写同一 main.log，
    // 不再由 ipc/config.ts 另建一个 Logger；未注入时各模块回退 console）。
    registerIpcHandlers(appContext, appLogger)

    // ---- overlay 多屏窗口（A1）----
    const manager = createOverlayWindowsManager({
      ctx: appContext,
      getDisplays: getDisplayInfos,
      loadContents: loadRenderer,
      hardenWebContents,
      onWindowCreated: (win): void => {
        attachSmokeWindowGuards(win)
        win.on('closed', () => {
          if (SMOKE_TEST && !smokeReported && !smokeFailed) {
            failSmoke('window closed before smoke report')
          }
        })
      },
      onDidFinishLoad: (win): void => {
        // 冒烟报告只对主屏窗调度一次（每个 display 都有一个 overlay）
        if (!SMOKE_TEST) {
          // dev 姿态截图回环（PET_DEV_CAPTURE_DIR；B3 视觉调参用）只挂主屏窗一次。
          // R-06 / A-02：整条 dev capture 链路（姿态截图 + `PET_DEV_CAPTURE_STARTUP_FRAMES`
          // 启动逐帧捕获）必须 `is.dev` 门控 —— 打包版即使被注入 PET_DEV_CAPTURE_* 环境变量，
          // 也不得截屏 / 写盘 / `app.exit()`。`PET_SMOKE_TEST` 不在此门控：smoke:file 依赖
          // 生产态冒烟模式（见 `SMOKE_TEST` 注释与 package.json）。
          if (
            is.dev &&
            DEV_CAPTURE_DIR &&
            getActiveOverlayWindowsManager()?.getPrimaryWindow() === win
          ) {
            // 启动逐帧捕获（PET_DEV_CAPTURE_STARTUP_FRAMES>0）优先于姿态截图回环：
            // 两者都要写同一 outDir 且互斥退出，启动捕获期间不做姿态循环。
            if (DEV_CAPTURE_STARTUP_FRAMES > 0) void runDevCaptureStartup(win)
            else void runDevCapture(win)
          }
          return
        }
        if (getActiveOverlayWindowsManager()?.getPrimaryWindow() !== win) return
        // 成功路径：清掉加载 watchdog —— 这是 M0-1 HIGH 缺陷（60s 后误报 SMOKE_FAIL）的直接修复点。
        clearSmokeLoadWatchdog()
        if (smokeReported || smokeReporting || smokeFailed) return

        clearSmokeReportTimer()
        smokeReportTimer = setTimeout(() => {
          smokeReportTimer = null
          void reportSmokeAndExit(win)
        }, SMOKE_REPORT_DELAY_MS)
      }
    })
    manager.sync(getDisplayInfos())
    manager.startDisplayWatchers()

    // ---- R-05：GPU / 子进程崩溃兜底 ----
    // Electron 44 用 `app.on('child-process-gone')`（`gpu-process-crashed` 已弃用）。
    // 冒烟模式不挂：冒烟的 render-process-gone 断言已覆盖 crash 路径，恢复 reload 会干扰退出码。
    if (!SMOKE_TEST) {
      app.on('child-process-gone', (_event, details) => {
        const type = details?.type ?? 'Unknown'
        const reason = details?.reason ?? 'unknown'
        const exitCode = details?.exitCode ?? -1
        if (type !== 'GPU') {
          // Utility / Zygote 等子进程消失：Chromium 会自行重建，这里只记 warn，不重载 renderer。
          appLogger?.warn(
            `[main] child process gone: type=${type} reason=${reason} exitCode=${exitCode}`
          )
          return
        }
        if (reason === 'clean-exit') {
          // GPU 进程正常退出（Chromium 重建 GPU 进程等）不需要 reload overlay；
          // 与 render-process-gone 的 clean-exit 语义对齐（二次复核 P2-2）。
          appLogger?.info?.('[main] GPU process exited cleanly; no overlay recovery needed')
          return
        }
        appLogger?.error(
          `[main] GPU process gone: reason=${reason} exitCode=${exitCode}; ` +
            'scheduling overlay recovery reload'
        )
        // 延迟与限流由 crash-recovery 统一处理（约 1s 后对存活 overlay 各触发一次限流 reload；
        // 同一事故内 renderer 侧已 reload 过的窗口按 incidentDedupeMs 跳过）。
        crashRecovery?.handleGpuProcessGone(
          manager.getWindows().map((win) => win.webContents),
          { reason }
        )
      })
    }

    // ---- 菜单栏托盘（A1；macOS template image）----
    createTray({
      ctx: appContext,
      logger: appLogger ?? undefined,
      isVisible: () => manager.isVisible(),
      onToggleVisible: () => {
        manager.setVisible(!manager.isVisible())
      },
      // Wave 2 集成：托盘「设置…」→ 普通设置窗（B6 页面；第二入口由 electron.vite.config.ts 提供）。
      // M-2：传入 appContext，设置窗登记为 config-changed 广播目标；L-4：注入共享 logger。
      onShowSettings: () => {
        openSettingsWindow(appContext, appLogger ?? undefined)
      },
      onQuit: () => {
        app.quit()
      }
    })

    app.once('will-quit', () => {
      // R-05：先清恢复策略的延迟定时器（避免退出过程中还排着 reload）
      crashRecovery?.dispose()
      crashRecovery = null
      destroySettingsWindow()
      manager.destroy()
    })

    console.log(
      `[main] aventurine-pet overlays created on workArea x${manager.getWindows().length} display(s) ` +
        `(electron ${process.versions.electron}, smoke=${SMOKE_TEST})`
    )

    app.on('activate', () => {
      // macOS：Dock 图标点击且无窗口时重建（accessory 策略下基本不会触发，仅作兜底）。
      if (BrowserWindow.getAllWindows().length === 0) manager.sync(getDisplayInfos())
    })
  } catch (error) {
    if (SMOKE_TEST) {
      failSmoke('bootstrap failed', error)
    } else {
      console.error('[main] bootstrap failed:', error)
      appLogger?.error('[main] bootstrap failed:', error)
      app.exit(1)
    }
  }
}

// 单实例锁：只在打包版启用（dev 需要多 worktree / PET_PROFILE 并行调试）。
// 第二实例不创建窗口、不注册协议，直接退出。
const hasSingleInstanceLock = !app.isPackaged || app.requestSingleInstanceLock()

if (!hasSingleInstanceLock) {
  console.log('[main] another instance is already running; quitting second instance')
  app.quit()
} else {
  // 以下两步都必须在 app ready 之前完成：
  // - PET_PROFILE 改 userData（session / 配置初始化前生效）；
  // - registerSchemesAsPrivileged（Electron 硬性要求，否则 protocol.handle 无效）。
  applyDevProfile()
  registerPetAssetScheme()

  // 进程级冒烟守护在入口处只注册一次（SMOKE_TEST 门禁，正常模式零副作用）。
  attachSmokeProcessGuards()

  void app
    .whenReady()
    .then(() => bootstrap())
    .catch((error: unknown) => {
      if (SMOKE_TEST) {
        failSmoke('bootstrap rejected', error)
      } else {
        console.error('[main] bootstrap rejected:', error)
        app.exit(1)
      }
    })

  app.on('second-instance', () => {
    // 打包版第二次启动：把已有 overlay 再显示一次（不激活、不抢焦点）。
    // L-2：不得绕过 overlay-manager 的显隐状态机 —— 用户从托盘隐藏后再次启动 app 时，
    // 直接 showInactive() 会让宠物重新出现但 manager.isVisible() 仍为 false（托盘勾选错乱）。
    // 这里只在「窗口本来就可见」时做一次置顶式 showInactive；隐藏状态保持不变。
    const win = appContext.getPrimaryOverlay()
    if (!win || win.isDestroyed() || !win.isVisible()) return
    win.showInactive()
  })

  // 退出语义（PLAN §17.5 P1-10 LOW-13）：托盘常驻后，overlay 被隐藏/关闭不退出 app
  // （隐藏是 hide 不是 close；只有托盘「退出」/ pet:quit / 无托盘兜底才退出）。
  app.on('window-all-closed', () => {
    if (!getActiveTray()) app.quit()
  })
}
