/**
 * V6 表情层：把 `src/shared/expression-contract` 的私有表情 clip（HSR Emo_ / Mate face 层）
 * + 既有纯逻辑 `VRMExpressionDriver` 接到 three-vrm 的 `expressionManager` 上。
 *
 * 数据流（设计见 `docs/expression-mapping.md` §9）：
 * ```
 * pet-asset://assets/expressions/manifest.json   →  sanitizeExpressionClipManifest
 * pet-asset://assets/expressions/<file>          →  sanitizeExpressionClip（懒加载/后台预载）
 * VRMExpressionDriver.update(dt, AnimationInput) →  weights（expression 名 → 0..1）
 * expressionManager.setValue(name, weight)        →  vrm.update(dt) 内应用到 morph/材质
 * ```
 *
 * 触发来源：`AnimationInput.mood`（情绪/睡眠）、`input.events`（pat/thrown/…）、`input.dragging`
 * 与 `input.bubbleText`（口型）——全部由 `VRMExpressionDriver` 内部合成，本层只做「加载 + 清零 + 写入」。
 *
 * 失败降级：manifest/clip 缺失、坏 JSON、表达式名为模型所未有时只 warn，不抛；`ready=false`
 * 时仍保留程序化眨眼（不依赖 clip）。
 */
import {
  sanitizeExpressionClip,
  sanitizeExpressionClipManifest,
  type ExpressionClip,
  type ExpressionClipEntry
} from '@shared/expression-contract'

import type { AnimationInput } from '../core/wave2-contract'
import { VRMExpressionDriver } from './expressions'
import type {
  CreateVrmExpressionLayerOptions,
  VrmExpressionDebugSnapshot,
  VrmExpressionLayer
} from './runtime-types'

/**
 * V6 自定义表情增强（模型自带 custom expression，不在 VRM 1.0 preset 契约里）：
 * 触发键 → 额外写入的 expression 权重。当前只做保守的「害羞（照れ）/ 阴影（目影消）」，
 * 数值来自 `docs/expression-mapping.md` §6.5 的增强清单；模型缺该 expression 时自动跳过。
 */
const CUSTOM_EXPRESSION_TARGETS: Readonly<Record<string, Readonly<Record<string, number>>>> = {
  // 被摸头：脸红（照れ）
  pet: { 照れ: 0.4 },
  // 被拎起：轻微脸红 + 眼睛阴影（委屈）
  drag: { 照れ: 0.28, 目影消: 0.25 },
  // 出错/受挫：眼睛阴影
  sad: { 目影消: 0.45 },
  // 睡觉：闭眼由 preset blink 模拟，附一点放松眼影
  sleep: { 目影消: 0.3 }
}

/** 自定义表情权重平滑时间常数（秒）。 */
const CUSTOM_EXPRESSION_TAU_SEC = 0.12

/** 表情清单/clip 相对 assets 根的位置（与 `src/shared/expression-contract.ts` 约定一致）。 */
const EXPRESSION_MANIFEST_FILE = 'expressions/manifest.json'
/** manifest 条目的 `file` 相对 `assets/expressions/`；加载 URL 需补该前缀。 */
const EXPRESSION_ASSET_PREFIX = 'expressions/'

/** 默认 fetch 实现：`pet-asset://` 或 http(s)；失败抛错由调用方降级。 */
async function defaultFetchText(url: string): Promise<string> {
  const response = await fetch(url, { cache: 'no-store' })
  if (!response.ok) throw new Error(`fetch ${url} failed: HTTP ${response.status}`)
  return await response.text()
}

/** 把相对 assets 根的路径转成 `pet-asset://assets/<逐段编码>` URL。 */
function buildAssetsUrl(relativePath: string): string {
  const encoded = relativePath
    .split('/')
    .filter((segment) => segment.length > 0)
    .map((segment) => encodeURIComponent(segment))
    .join('/')
  return `pet-asset://assets/${encoded}`
}

/** 只 warn 一次（按 scope）。 */
function createWarnOnce(): (scope: string, error: unknown) => void {
  const seen = new Set<string>()
  return (scope, error) => {
    if (seen.has(scope)) return
    seen.add(scope)
    const message = error instanceof Error ? error.message : String(error)
    console.warn(`[vrm-expression] ${scope} 失败，已降级：${message}`)
  }
}

/** 从 manifest 条目按 trigger 建索引（同 trigger 多 clip：priority 高者优先，同优先级取靠前）。 */
function buildTriggerIndex(
  entries: readonly ExpressionClipEntry[]
): Map<string, ExpressionClipEntry> {
  const index = new Map<string, ExpressionClipEntry>()
  for (const entry of entries) {
    for (const trigger of entry.triggers) {
      const existing = index.get(trigger)
      if (!existing || entry.priority > existing.priority) index.set(trigger, entry)
    }
  }
  return index
}

/** 创建 V6 表情层（`animator.ts` 组合；未接线时 app 无表情驱动）。 */
export function createVrmExpressionLayer(
  options: CreateVrmExpressionLayerOptions
): VrmExpressionLayer {
  const { avatar } = options
  const enabled = options.enabled !== false
  const fetchText = options.fetchText ?? defaultFetchText
  const warnOnce = createWarnOnce()
  const manager = avatar.vrm.expressionManager ?? null
  /** 模型实际可用的 expression 名（避免对未知名 setValue 刷 console.warn）。 */
  const availableNames = new Set(avatar.expressionNames)
  const bindings = avatar.asset.expressions

  let ready = false
  let disposed = false
  let driver: VRMExpressionDriver | null = null
  let triggerIndex = new Map<string, ExpressionClipEntry>()
  /** 已解析的 clip（trigger → clip）。 */
  const clipsByTrigger = new Map<string, ExpressionClip>()
  /** 上一帧写入的 expression 名（用于把回零项清零）。 */
  let writtenNames = new Set<string>()
  let lastWeights: Record<string, number> = {}
  /** 自定义 expression 的当前平滑权重（name → 0..1）。 */
  const customWeights = new Map<string, number>()
  let lastSnapshot: VrmExpressionDebugSnapshot = {
    ready: false,
    blink: 0,
    smile: 0,
    mouthOpen: 0,
    trigger: null,
    clipId: null,
    weights: {}
  }

  /** 后台加载一个 manifest 条目对应的 clip（幂等；失败只 warn）。 */
  const loadEntry = async (entry: ExpressionClipEntry): Promise<ExpressionClip | null> => {
    const existing = clipsByTrigger.get(entry.id)
    if (existing) return existing
    try {
      const text = await fetchText(buildAssetsUrl(`${EXPRESSION_ASSET_PREFIX}${entry.file}`))
      const result = sanitizeExpressionClip(JSON.parse(text) as unknown, `expression:${entry.id}`)
      if (result.clip === null) {
        warnOnce(`clip ${entry.id}`, new Error(result.warnings.join('; ') || 'invalid'))
        return null
      }
      const clip = result.clip
      clipsByTrigger.set(entry.id, clip)
      // 触发键 → clip（触发时同步命中；同 trigger 多 clip 由 manifest priority 决定）。
      for (const trigger of entry.triggers) clipsByTrigger.set(trigger, clip)
      return clip
    } catch (error) {
      warnOnce(`clip ${entry.id}`, error)
      return null
    }
  }

  const init = async (): Promise<void> => {
    if (!enabled) return
    if (!manager) return
    try {
      const text = await fetchText(buildAssetsUrl(EXPRESSION_MANIFEST_FILE))
      const result = sanitizeExpressionClipManifest(JSON.parse(text) as unknown)
      if (result.warnings.length > 0) {
        console.warn('[vrm-expression] manifest 警告：', result.warnings.slice(0, 5))
      }
      triggerIndex = buildTriggerIndex(result.manifest.clips)
      driver = new VRMExpressionDriver({
        bindings,
        random: options.random,
        clipLookup: (trigger) => {
          const clip = clipsByTrigger.get(trigger) ?? null
          if (clip === null) {
            // 未加载：后台补载，本次先走 preset 情绪兜底（不阻塞帧）。
            const entry = triggerIndex.get(trigger)
            if (entry) void loadEntry(entry)
          }
          return clip
        }
      })
      ready = true
      // 后台按 priority 预载（drag/pat/sleep 等反应优先），不阻塞 init。
      const prefetch = result.manifest.clips
        .slice()
        .sort((a, b) => b.priority - a.priority)
        .slice(0, 8)
      void Promise.all(prefetch.map((entry) => loadEntry(entry))).catch(() => undefined)
      console.log(
        `[vrm-expression] ready：${result.manifest.clips.length} 条 clip / ${triggerIndex.size} 个 trigger / ${availableNames.size} 个模型 expression`
      )
    } catch (error) {
      ready = false
      warnOnce('init', error)
    }
  }

  const update = (input: AnimationInput, dtSec: number): void => {
    if (!enabled || disposed || !manager) return
    if (!driver) {
      // 未就绪：只保留程序化眨眼会更好？此处不产生任何写入（黑脸风险为零）。
      return
    }
    try {
      const snapshot = driver.update(dtSec, {
        mood: input.mood,
        events: input.events,
        dragging: input.dragging,
        bubbleText: input.bubbleText
      })
      const target: Record<string, number> = {}
      for (const [name, weight] of Object.entries(snapshot.weights)) {
        if (!availableNames.has(name)) continue
        const value = Math.min(1, Math.max(0, weight))
        if (value <= 1e-4) continue
        target[name] = value
      }

      // V6：自定义表情增强（照れ/目影消）——按 trigger 平滑叠加，模型缺通道自动跳过。
      const triggerKey = snapshot.trigger
      const customTargets = triggerKey !== null ? (CUSTOM_EXPRESSION_TARGETS[triggerKey] ?? {}) : {}
      for (const [name, targetValue] of Object.entries(customTargets)) {
        if (!availableNames.has(name)) continue
        const current = customWeights.get(name) ?? 0
        const alpha = 1 - Math.exp(-dtSec / CUSTOM_EXPRESSION_TAU_SEC)
        const next = current + (targetValue - current) * alpha
        if (next > 1e-4) {
          customWeights.set(name, next)
          target[name] = Math.max(target[name] ?? 0, next)
        } else {
          customWeights.delete(name)
        }
      }
      // 没有自定义目标时，把已有自定义权重平滑回 0。
      for (const [name, current] of [...customWeights]) {
        if (name in customTargets) continue
        const next = current * Math.exp(-dtSec / CUSTOM_EXPRESSION_TAU_SEC)
        if (next > 1e-4) {
          customWeights.set(name, next)
          target[name] = Math.max(target[name] ?? 0, next)
        } else {
          customWeights.delete(name)
        }
      }
      // 清零上一帧写入但本帧归零的通道（只动自己写过的 name，避免影响外部调试 setMorph）。
      for (const name of writtenNames) {
        if (!(name in target)) manager.setValue(name, 0)
      }
      for (const [name, value] of Object.entries(target)) manager.setValue(name, value)
      writtenNames = new Set(Object.keys(target))
      lastWeights = target

      const happyName = driver.resolveBinding('happy')
      const smile = happyName !== null ? (target[happyName] ?? 0) : 0
      let mouthOpen = 0
      for (const preset of ['aa', 'ih', 'ou', 'ee', 'oh']) {
        mouthOpen = Math.max(mouthOpen, target[preset] ?? 0)
      }
      lastSnapshot = {
        ready,
        blink: snapshot.blinkWeight,
        smile,
        mouthOpen,
        trigger: snapshot.trigger,
        clipId: snapshot.clipId,
        weights: target
      }
    } catch (error) {
      warnOnce('update', error)
    }
  }

  return {
    init,
    get ready(): boolean {
      return ready
    },
    update,
    forceBlink(): void {
      driver?.forceBlink()
    },
    snapshot(): VrmExpressionDebugSnapshot {
      return { ...lastSnapshot, ready, weights: { ...lastWeights } }
    },
    dispose(): void {
      if (disposed) return
      disposed = true
      if (manager) {
        for (const name of writtenNames) {
          try {
            manager.setValue(name, 0)
          } catch {
            /* 忽略 */
          }
        }
      }
      writtenNames = new Set()
      lastWeights = {}
      driver = null
    }
  }
}
