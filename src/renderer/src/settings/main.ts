/**
 * 设置窗入口（Wave 2 B6）—— 原生 DOM + 自写 CSS，不引 UI 框架/依赖。
 *
 * 职责（PLAN §5 B6 / docs/wave2-integration.md §3-B6）：
 * - 读取 `window.api.getConfig()` 初始化全部控件；
 * - 控件变更 debounce 200ms → `window.api.setConfig(partial)` → 用主进程返回的
 *   sanitize 后配置刷新 UI；`onConfigChanged` 同步外部（托盘/其它页面）改动；
 * - 权限状态（`getAccessibilityStatus`）与 DSH 状态（`getDshStatus`，每 5s 轮询）；
 * - 「恢复默认」= 显式 `DEFAULT_CONFIG` 全字段 setConfig；
 * - IPC 失败只在底部状态条提示，不崩、不白屏。
 *
 * 纯逻辑全部在 `settings-model.ts`（可单测）；本文件只做 DOM 绑定/渲染。
 * CSP：`script-src 'self'`，本文件由 settings.html 的 module script 入口加载，无内联脚本/eval。
 */
import { DEFAULT_CONFIG } from '@shared/config'
import type { AccessibilityStatus, DshStatus, PetConfig } from '@shared/types'

import {
  DEFAULT_SCREEN_METRICS,
  clampFpsCap,
  clampOpacity,
  clampSizePercent,
  defaultsPatch,
  describeDshStatus,
  describePermissions,
  describeSize,
  formatErrorText,
  formatFps,
  formatOpacityPercent,
  formStateFromConfig,
  normalizeAutonomousLevel,
  patchForField,
  screenMetricsFromDisplays
} from './settings-model'
import type { ScreenMetrics, SettingsFormState } from './settings-model'

/** 变更合并窗口（契约建议 150–300ms；200ms 兼顾即时感与 IPC 次数）。 */
const SAVE_DEBOUNCE_MS = 200

/** DSH 状态轮询周期（设置窗打开时；主进程 watcher 自身 750ms 轮询桥文件）。 */
const DSH_STATUS_POLL_MS = 5000

/** 底部状态条状态样式 class（空字符串 = 普通文案）。 */
type SaveStateClass = '' | 'is-saving' | 'is-saved' | 'is-error'

/** 页面元素集合（一次性抓取，缺失即初始化失败）。 */
interface SettingsElements {
  sizeRange: HTMLInputElement
  sizeValue: HTMLElement
  sizePx: HTMLElement
  sizeHint: HTMLElement
  opacityRange: HTMLInputElement
  opacityValue: HTMLElement
  autonomousToggle: HTMLInputElement
  autonomousLevelField: HTMLElement
  autonomousLevelButtons: HTMLButtonElement[]
  mischiefToggle: HTMLInputElement
  dshLinkToggle: HTMLInputElement
  dshCouplingToggle: HTMLInputElement
  dshBubbleSyncToggle: HTMLInputElement
  fpsRange: HTMLInputElement
  fpsValue: HTMLElement
  launchAtLoginToggle: HTMLInputElement
  soundToggle: HTMLInputElement
  permissionAccessibility: HTMLElement
  permissionNotifications: HTMLElement
  dshStatusLine: HTMLElement
  dshStatusDot: HTMLElement
  dshStatusText: HTMLElement
  refreshStatus: HTMLButtonElement
  restoreDefaults: HTMLButtonElement
  saveState: HTMLElement
}

/* ---------------------------------- 状态 ---------------------------------- */

let elements: SettingsElements | null = null
/** 当前表单状态（UI 权威值；保存后用主进程返回值回填）。 */
let form: SettingsFormState = formStateFromConfig(DEFAULT_CONFIG)
/** 尺寸换算用的屏幕高度基准（拿不到屏幕信息时用 1080p 兜底展示）。 */
let metrics: ScreenMetrics = { ...DEFAULT_SCREEN_METRICS }
/** 尚未提交的变更（debounce 合并）。 */
let pendingPatch: Partial<PetConfig> = {}
let saveTimer: ReturnType<typeof setTimeout> | null = null
let saveInFlight = false
let dshPollTimer: ReturnType<typeof setInterval> | null = null
let unsubscribeConfig: (() => void) | null = null
let disposed = false

/* --------------------------------- 工具函数 --------------------------------- */

/** 取必需元素；缺失直接抛（由 boot 统一兜底成页面错误文案）。 */
function mustElement<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id)
  if (!element) throw new Error(`设置页缺少元素 #${id}`)
  return element as T
}

/** 取 preload 桥（settings-window 一定带 preload；防御式检查避免白屏）。 */
function requireApi(): Window['api'] {
  if (!window.api) throw new Error('preload 未就绪（window.api 不可用）')
  return window.api
}

/** 抓取页面元素（settings.html 契约；缺失 → 初始化失败）。 */
function collectElements(): SettingsElements {
  const buttons = Array.from(
    document.querySelectorAll<HTMLButtonElement>('button[data-autonomous-level]')
  )
  if (buttons.length === 0) throw new Error('设置页缺少活动频率按钮')

  return {
    sizeRange: mustElement<HTMLInputElement>('size-range'),
    sizeValue: mustElement<HTMLElement>('size-value'),
    sizePx: mustElement<HTMLElement>('size-px'),
    sizeHint: mustElement<HTMLElement>('size-hint'),
    opacityRange: mustElement<HTMLInputElement>('opacity-range'),
    opacityValue: mustElement<HTMLElement>('opacity-value'),
    autonomousToggle: mustElement<HTMLInputElement>('autonomous-toggle'),
    autonomousLevelField: mustElement<HTMLElement>('autonomous-level-field'),
    autonomousLevelButtons: buttons,
    mischiefToggle: mustElement<HTMLInputElement>('mischief-toggle'),
    dshLinkToggle: mustElement<HTMLInputElement>('dshlink-toggle'),
    dshCouplingToggle: mustElement<HTMLInputElement>('dsh-coupling-toggle'),
    dshBubbleSyncToggle: mustElement<HTMLInputElement>('dsh-bubble-sync-toggle'),
    fpsRange: mustElement<HTMLInputElement>('fps-range'),
    fpsValue: mustElement<HTMLElement>('fps-value'),
    launchAtLoginToggle: mustElement<HTMLInputElement>('launch-at-login-toggle'),
    soundToggle: mustElement<HTMLInputElement>('sound-toggle'),
    permissionAccessibility: mustElement<HTMLElement>('permission-accessibility'),
    permissionNotifications: mustElement<HTMLElement>('permission-notifications'),
    dshStatusLine: mustElement<HTMLElement>('dsh-status-line'),
    dshStatusDot: mustElement<HTMLElement>('dsh-status-dot'),
    dshStatusText: mustElement<HTMLElement>('dsh-status-text'),
    refreshStatus: mustElement<HTMLButtonElement>('refresh-status'),
    restoreDefaults: mustElement<HTMLButtonElement>('restore-defaults'),
    saveState: mustElement<HTMLElement>('save-state')
  }
}

/** 底部状态条（role=status / aria-live=polite，覆盖成功/失败/保存中）。 */
function setSaveState(text: string, state: SaveStateClass = ''): void {
  if (!elements) return
  elements.saveState.textContent = text
  elements.saveState.classList.remove('is-saving', 'is-saved', 'is-error')
  if (state.length > 0) elements.saveState.classList.add(state)
}

/* ------------------------------- 渲染（只读 UI） ----------------------------- */

/** 同步 range 的 value；skipActive 时跳过用户正在操作的元素（防止拖动被回顶）。 */
function syncRange(input: HTMLInputElement, value: string, skipActive: boolean): void {
  if (skipActive && document.activeElement === input) return
  if (input.value !== value) input.value = value
}

/** 同步 checkbox；同样跳过正在操作的控件。 */
function syncCheckbox(input: HTMLInputElement, checked: boolean, skipActive: boolean): void {
  if (skipActive && document.activeElement === input) return
  if (input.checked !== checked) input.checked = checked
}

/** 尺寸区文案（百分比 / 换算 px / 近景与上限提示）。 */
function renderSize(): void {
  if (!elements) return
  const size = describeSize(form.sizePercent, metrics)
  elements.sizeValue.textContent = size.label
  elements.sizePx.textContent = `约 ${size.petHeightPx} px 高`
  elements.sizeHint.textContent = size.hint
}

/** 不透明度 / FPS 文案。 */
function renderOpacity(): void {
  if (!elements) return
  elements.opacityValue.textContent = formatOpacityPercent(form.opacity)
}

function renderFps(): void {
  if (!elements) return
  elements.fpsValue.textContent = formatFps(form.fpsCap)
}

/** 活动频率分段按钮的选中态 + 自主活动关闭时的置灰。 */
function renderAutonomousLevel(): void {
  if (!elements) return
  for (const button of elements.autonomousLevelButtons) {
    const active = button.dataset['autonomousLevel'] === form.autonomousLevel
    button.classList.toggle('is-active', active)
    button.setAttribute('aria-pressed', active ? 'true' : 'false')
  }
  elements.autonomousLevelField.classList.toggle('is-muted', !form.autonomous)
}

/** 全部控件渲染（skipActive：跳过用户正在操作的控件，避免保存回包/外部广播回顶）。 */
function renderControls(skipActive: boolean): void {
  if (!elements) return
  syncRange(elements.sizeRange, String(form.sizePercent), skipActive)
  syncRange(elements.opacityRange, String(form.opacity), skipActive)
  syncRange(elements.fpsRange, String(form.fpsCap), skipActive)
  syncCheckbox(elements.autonomousToggle, form.autonomous, skipActive)
  syncCheckbox(elements.mischiefToggle, form.mischief, skipActive)
  syncCheckbox(elements.dshLinkToggle, form.dshLink, skipActive)
  syncCheckbox(elements.dshCouplingToggle, form.dshCoupling, skipActive)
  syncCheckbox(elements.dshBubbleSyncToggle, form.dshBubbleSync, skipActive)
  syncCheckbox(elements.launchAtLoginToggle, form.launchAtLogin, skipActive)
  syncCheckbox(elements.soundToggle, form.sound, skipActive)

  renderSize()
  renderOpacity()
  renderFps()
  renderAutonomousLevel()
}

/** 写入配置 → 表单状态 + UI（主进程返回 sanitize 后的配置）。 */
function applyConfig(config: PetConfig): void {
  form = formStateFromConfig(config)
  renderControls(true)
}

/** 权限状态渲染（辅助功能 + 通知）。 */
function renderPermissions(status: AccessibilityStatus | null): void {
  if (!elements) return
  const permissions = describePermissions(status)
  elements.permissionAccessibility.textContent = permissions.accessibilityText
  elements.permissionNotifications.textContent = permissions.notificationsText
  elements.permissionAccessibility.classList.toggle('is-ok', permissions.accessibilityOk)
  elements.permissionAccessibility.classList.toggle('is-warn', !permissions.accessibilityOk)
  elements.permissionNotifications.classList.toggle('is-ok', permissions.notificationsOk)
  elements.permissionNotifications.classList.toggle('is-warn', !permissions.notificationsOk)
}

/** DSH 状态渲染（文案 + 圆点 tone）。 */
function renderDshStatus(status: DshStatus | null): void {
  if (!elements) return
  const description = describeDshStatus(status)
  elements.dshStatusText.textContent = description.text
  const toneClasses = [
    'is-tone-online-busy',
    'is-tone-online-idle',
    'is-tone-offline',
    'is-tone-unknown'
  ]
  elements.dshStatusDot.classList.remove(...toneClasses)
  elements.dshStatusDot.classList.add(`is-tone-${description.tone}`)
  elements.dshStatusLine.dataset['tone'] = description.tone
}

/* ------------------------------- 保存（debounce） ---------------------------- */

/** 排队一次变更；多个控件变更在 debounce 窗口内合并成一次 setConfig。 */
function scheduleSave(patch: Partial<PetConfig>): void {
  if (disposed) return
  pendingPatch = { ...pendingPatch, ...patch }
  if (saveTimer !== null) clearTimeout(saveTimer)
  saveTimer = setTimeout(() => {
    saveTimer = null
    void flushSave()
  }, SAVE_DEBOUNCE_MS)
}

/** 保存失败后回读真实配置（避免 UI 与磁盘长期不一致）；回读也失败则保留本地状态。 */
async function reloadConfigAfterFailure(): Promise<void> {
  try {
    applyConfig(await requireApi().getConfig())
  } catch {
    // 主进程完全不可用时保持当前 UI，等待用户再次操作/刷新。
  }
}

/** 提交挂起变更；串行化，避免并发 setConfig 乱序回包。 */
async function flushSave(): Promise<void> {
  if (disposed || saveInFlight) return
  const patch = pendingPatch
  pendingPatch = {}
  if (Object.keys(patch).length === 0) return

  saveInFlight = true
  setSaveState('保存中…', 'is-saving')
  try {
    const saved = await requireApi().setConfig(patch)
    applyConfig(saved)
    setSaveState('已保存', 'is-saved')
  } catch (error) {
    setSaveState(`保存失败：${formatErrorText(error)}`, 'is-error')
    await reloadConfigAfterFailure()
  } finally {
    saveInFlight = false
    if (Object.keys(pendingPatch).length > 0) scheduleSave({})
  }
}

/** 「恢复默认」：显式 DEFAULT_CONFIG 全字段写入（并清掉尚未提交的变更）。 */
async function restoreDefaults(): Promise<void> {
  if (disposed) return
  pendingPatch = {}
  if (saveTimer !== null) {
    clearTimeout(saveTimer)
    saveTimer = null
  }
  setSaveState('正在恢复默认…', 'is-saving')
  try {
    applyConfig(await requireApi().setConfig(defaultsPatch()))
    setSaveState('已恢复默认', 'is-saved')
  } catch (error) {
    setSaveState(`恢复默认失败：${formatErrorText(error)}`, 'is-error')
    await reloadConfigAfterFailure()
  }
}

/* ------------------------------- 状态刷新 -------------------------------- */

/** 拉取一次 DSH 状态（失败 → 未知文案，不打断配置编辑）。 */
async function refreshDshStatus(): Promise<void> {
  if (disposed) return
  try {
    renderDshStatus(await requireApi().getDshStatus())
  } catch (error) {
    console.warn('[settings] getDshStatus failed:', error)
    renderDshStatus(null)
  }
}

/** 手动「重新检测」按钮：权限 + DSH 状态。 */
async function refreshAllStatuses(): Promise<void> {
  if (!elements || disposed) return
  elements.refreshStatus.disabled = true
  setSaveState('正在重新检测…', 'is-saving')
  try {
    const api = requireApi()
    const [permissionsResult, dshResult] = await Promise.allSettled([
      api.getAccessibilityStatus(),
      api.getDshStatus()
    ])
    renderPermissions(permissionsResult.status === 'fulfilled' ? permissionsResult.value : null)
    renderDshStatus(dshResult.status === 'fulfilled' ? dshResult.value : null)
    setSaveState('已重新检测')
  } catch (error) {
    setSaveState(`检测失败：${formatErrorText(error)}`, 'is-error')
  } finally {
    elements.refreshStatus.disabled = false
  }
}

/* ------------------------------- 事件绑定 -------------------------------- */

/** 布尔开关绑定：change → 更新表单状态 → 排队保存。 */
function bindToggle(
  input: HTMLInputElement,
  onChange: (checked: boolean) => Partial<PetConfig>
): void {
  input.addEventListener('change', () => {
    scheduleSave(onChange(input.checked))
  })
}

function bindControls(): void {
  if (!elements) return
  const els = elements

  // 尺寸
  els.sizeRange.addEventListener('input', () => {
    form.sizePercent = clampSizePercent(Number.parseFloat(els.sizeRange.value))
    renderSize()
    scheduleSave(patchForField('sizePercent', form.sizePercent))
  })

  // 不透明度
  els.opacityRange.addEventListener('input', () => {
    form.opacity = clampOpacity(Number.parseFloat(els.opacityRange.value))
    renderOpacity()
    scheduleSave(patchForField('opacity', form.opacity))
  })

  // FPS 上限
  els.fpsRange.addEventListener('input', () => {
    form.fpsCap = clampFpsCap(Number.parseFloat(els.fpsRange.value))
    renderFps()
    scheduleSave(patchForField('fpsCap', form.fpsCap))
  })

  // 活动频率分段
  for (const button of els.autonomousLevelButtons) {
    button.addEventListener('click', () => {
      form.autonomousLevel = normalizeAutonomousLevel(button.dataset['autonomousLevel'])
      renderAutonomousLevel()
      scheduleSave(patchForField('autonomousLevel', form.autonomousLevel))
    })
  }

  // 开关
  bindToggle(els.autonomousToggle, (checked) => {
    form.autonomous = checked
    renderAutonomousLevel()
    return patchForField('autonomous', checked)
  })
  bindToggle(els.mischiefToggle, (checked) => {
    form.mischief = checked
    return patchForField('mischief', checked)
  })
  bindToggle(els.dshLinkToggle, (checked) => {
    form.dshLink = checked
    return patchForField('dshLink', checked)
  })
  bindToggle(els.dshCouplingToggle, (checked) => {
    form.dshCoupling = checked
    return patchForField('dshCoupling', checked)
  })
  bindToggle(els.dshBubbleSyncToggle, (checked) => {
    form.dshBubbleSync = checked
    return patchForField('dshBubbleSync', checked)
  })
  bindToggle(els.launchAtLoginToggle, (checked) => {
    form.launchAtLogin = checked
    return patchForField('launchAtLogin', checked)
  })
  bindToggle(els.soundToggle, (checked) => {
    form.sound = checked
    return patchForField('sound', checked)
  })

  els.refreshStatus.addEventListener('click', () => {
    void refreshAllStatuses()
  })
  els.restoreDefaults.addEventListener('click', () => {
    void restoreDefaults()
  })
}

/* -------------------------------- 初始化 -------------------------------- */

/** 拉取初始配置/屏幕/权限/DSH 状态并渲染。 */
async function loadInitialState(): Promise<void> {
  const api = requireApi()
  const [configResult, screensResult, permissionsResult, dshResult] = await Promise.allSettled([
    api.getConfig(),
    api.getScreenInfo(),
    api.getAccessibilityStatus(),
    api.getDshStatus()
  ])

  if (configResult.status === 'fulfilled') {
    applyConfig(configResult.value)
    setSaveState('已加载')
  } else {
    setSaveState(`配置读取失败：${formatErrorText(configResult.reason)}`, 'is-error')
  }

  metrics =
    screensResult.status === 'fulfilled'
      ? screenMetricsFromDisplays(screensResult.value)
      : { ...DEFAULT_SCREEN_METRICS }
  renderSize() // 屏幕信息到手后重算 px 提示

  renderPermissions(permissionsResult.status === 'fulfilled' ? permissionsResult.value : null)
  renderDshStatus(dshResult.status === 'fulfilled' ? dshResult.value : null)

  // 外部变化（托盘菜单切换自主活动、overlay 侧设置等）同步到本页。
  unsubscribeConfig = api.onConfigChanged((config) => {
    applyConfig(config)
  })

  // DSH 状态周期刷新（设置窗可见时才有效，隐藏窗会被 backgroundThrottling 降频）。
  dshPollTimer = setInterval(() => {
    void refreshDshStatus()
  }, DSH_STATUS_POLL_MS)

  window.addEventListener('beforeunload', dispose)
}

/**
 * M-10：关窗/卸载前把 debounce 窗口内尚未提交的改动 **fire-and-forget** 提交。
 *
 * 背景：控件变更 200ms debounce 合并；用户改完立刻关设置窗时 `dispose()` 原本直接
 * `clearTimeout`，最后一次改动既没落盘也收不到主进程的 sanitize 回包（永久丢失）。
 * 这里不 await（关闭流程不能被网络/IPC 阻塞，窗口销毁后 promise 也可能无法 resolve），
 * 失败静默 —— 主进程 `pet:set-config` handler 是同步写盘，正常情况下调用即生效。
 */
function flushPendingPatchOnDispose(): void {
  if (saveTimer !== null) {
    clearTimeout(saveTimer)
    saveTimer = null
  }
  const patch = pendingPatch
  pendingPatch = {}
  if (Object.keys(patch).length === 0) return
  try {
    void requireApi().setConfig(patch).catch(() => undefined)
  } catch (error) {
    // preload 不可用等极端情况：窗口正在关闭，没有 UI 可提示，只留 console 证据。
    console.warn('[settings] flush pending config failed:', error)
  }
}

/** 卸载：先 flush 最后一次改动，再清定时器 + 退订（beforeunload 时调用）。 */
function dispose(): void {
  disposed = true
  // M-10：不得先 clearTimeout 丢掉 pending 改动 —— 先把它发出去（不阻塞关闭）。
  flushPendingPatchOnDispose()
  if (saveTimer !== null) {
    clearTimeout(saveTimer)
    saveTimer = null
  }
  if (dshPollTimer !== null) {
    clearInterval(dshPollTimer)
    dshPollTimer = null
  }
  unsubscribeConfig?.()
  unsubscribeConfig = null
}

/** 入口：任何初始化异常都转成页面错误文案，绝不白屏/抛到控制台中断。 */
async function boot(): Promise<void> {
  try {
    elements = collectElements()
  } catch (error) {
    const root = document.getElementById('settings-root')
    if (root) root.textContent = `设置页初始化失败：${formatErrorText(error)}`
    return
  }

  bindControls()
  renderControls(false) // 先用默认配置渲染，避免加载期间空白/跳动

  try {
    await loadInitialState()
  } catch (error) {
    setSaveState(`加载失败：${formatErrorText(error)}`, 'is-error')
  }
}

void boot()
