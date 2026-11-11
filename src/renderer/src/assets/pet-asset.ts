/**
 * `pet-asset://` 资源 URL 构造 + 加载体贴追踪（A2 消费；协议契约见 PLAN §8.1）。
 *
 * - PMX 与贴图都在 `assets/model/optimized/`（dev 根 = optimized，无回退）；
 *   URL 形式 `pet-asset://model/<单段文件名>`，CJK/空格/em-dash 需百分号编码。
 * - PMX 内贴图引用是相对文件名，MMDLoader 用 PMX URL 的 base（`pet-asset://model/`）拼接；
 *   浏览器会对非 ASCII 自动编码，但为了「不重复编码 / 统一形式」仍用 LoadingManager
 *   `setURLModifier` 逐段规范化（幂等）。
 * - 通过包装 `LoadingManager.itemStart/itemEnd/itemError` 统计 20 张贴图加载结果，
 *   供 `window.__aventurineDebug.model.{textureCount,missingTextures}` 与验收使用。
 */
import { LoadingManager } from 'three'

import type { AssetsManifest } from '@shared/types'

/** `pet-asset://` 协议 scheme 与固定 host（契约 §8.1）。 */
export const PET_ASSET_SCHEME = 'pet-asset'
export const PET_ASSET_HOST = 'model'
/**
 * V1 新增 host：`pet-asset://assets/<assets 根相对路径>`。
 * 用于私有 VRM / 动作 JSON / 表情 JSON（V1 后协议 handler 支持多段路径）。
 */
export const PET_ASSET_ASSETS_HOST = 'assets'

/** 贴图扩展名（用于从加载 URL 中区分贴图 / PMX 等二进制资产）。 */
const TEXTURE_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.bmp', '.tga', '.gif', '.webp'] as const

/** 逐段百分号编码文件名（CJK / 空格 / em-dash 安全）；空段（首尾 `/`）忽略。 */
export function encodePetAssetFileName(fileName: string): string {
  return fileName
    .split('/')
    .filter((segment) => segment.length > 0)
    .map((segment) => encodeURIComponent(segment))
    .join('/')
}

/** 构造 `pet-asset://model/<encoded>` URL。 */
export function buildPetAssetUrl(fileName: string): string {
  return `${PET_ASSET_SCHEME}://${PET_ASSET_HOST}/${encodePetAssetFileName(fileName)}`
}

/** 由资产清单得到 PMX 的加载 URL（清单里的 `pmx.file` 是 optimized 内副本文件名）。 */
export function resolvePmxUrl(manifest: Pick<AssetsManifest, 'pmx'>): string {
  return buildPetAssetUrl(manifest.pmx.file)
}

/**
 * 构造 `pet-asset://assets/<encodeURIComponent 分段)>` URL（V1：VRM/动作/表情私有资产）。
 * `relativePath` 是 **assets 根相对路径**（如 `vrm/aventurine-tpose.vrm`、`motions/mate/idle.json`）。
 */
export function buildAssetsAssetUrl(relativePath: string): string {
  return `${PET_ASSET_SCHEME}://${PET_ASSET_ASSETS_HOST}/${encodePetAssetFileName(relativePath)}`
}

/** VRM manifest 条目（`file` = assets 根相对路径）→ 加载 URL。 */
export function resolveVrmAssetUrl(asset: { file: string }): string {
  return buildAssetsAssetUrl(asset.file)
}

/** 动作集清单/clip 文件（相对 `assets/motions/`）→ 加载 URL。 */
export function resolveMotionAssetUrl(file: string): string {
  return buildAssetsAssetUrl(`motions/${file}`)
}

/** 表情清单/clip 文件（相对 `assets/`）→ 加载 URL。 */
export function resolveExpressionAssetUrl(file: string): string {
  return buildAssetsAssetUrl(file)
}

/** 单段路径规范化：先解码再编码（对「原始 CJK」与「已编码」两种输入都幂等）。 */
function normalizePathSegment(segment: string): string {
  if (segment.length === 0) return segment
  let decoded = segment
  try {
    decoded = decodeURIComponent(segment)
  } catch {
    // 非法百分号序列（如文件名里真的有 `%`）：保留原段，交给 encodeURIComponent 转义。
  }
  return encodeURIComponent(decoded)
}

/**
 * 把 `pet-asset:` URL 规范化为逐段百分号编码形式（幂等，不会把 `%E9` 二次编码成 `%25E9`）。
 * 非 pet-asset URL（`data:` / 相对路径等）原样返回。
 */
export function normalizePetAssetUrl(url: string): string {
  if (typeof url !== 'string' || !url.startsWith(`${PET_ASSET_SCHEME}:`)) return url
  try {
    const parsed = new URL(url)
    if (parsed.host !== PET_ASSET_HOST) return url
    const normalizedPath = parsed.pathname.split('/').map(normalizePathSegment).join('/')
    return `${PET_ASSET_SCHEME}://${PET_ASSET_HOST}${normalizedPath}${parsed.search}${parsed.hash}`
  } catch {
    return url
  }
}

/** 从 pet-asset URL 提取文件名（decode 后）；非 pet-asset URL 返回 null。 */
export function extractPetAssetFileName(url: string): string | null {
  if (typeof url !== 'string' || !url.startsWith(`${PET_ASSET_SCHEME}:`)) return null
  try {
    const parsed = new URL(url)
    const segments = parsed.pathname.split('/').filter((segment) => segment.length > 0)
    if (segments.length === 0) return null
    const last = segments[segments.length - 1]
    try {
      return decodeURIComponent(last)
    } catch {
      return last
    }
  } catch {
    return null
  }
}

/** 是否贴图 URL（用于统计 20 张贴图；PMX / 其它二进制不算）。 */
export function isTextureUrl(url: string): boolean {
  const fileName = extractPetAssetFileName(url)
  if (fileName === null) return false
  const lower = fileName.toLowerCase()
  return TEXTURE_EXTENSIONS.some((extension) => lower.endsWith(extension))
}

/** 加载管理器 + 贴图加载统计（给 PetScene 消费）。 */
export interface PetAssetLoadTracker {
  readonly manager: LoadingManager
  /** 已成功加载的贴图文件名（去重，按完成顺序）。 */
  readonly loadedTextures: readonly string[]
  /** 加载失败/缺失的贴图文件名。 */
  readonly missingTextures: readonly string[]
  /** 成功加载贴图数（验收期望 20）。 */
  readonly textureCount: number
  /** 尚未结束的贴图数（含重试退避期间的占位；`whenIdle` 依据它判断空闲）。 */
  readonly pendingTextureCount: number
  /**
   * 占用一个 pending 名额（供贴图重试调度使用：退避窗口内保持 pending>0，
   * 避免 `whenIdle` 在两次尝试之间提前 resolve）。返回幂等的释放函数。
   */
  holdPending(): () => void
  /**
   * 等所有已开始的贴图结束（成功或失败）；超时兜底（防止 tainted canvas 等异常
   * 导致 `itemEnd` 不触发时永远等待）。已空闲时立即 resolve。
   */
  whenIdle(timeoutMs?: number): Promise<void>
}

/** 从贴图 URL 取「按文件名」的追踪 key；非贴图返回 null。 */
function textureTrackingKey(url: string): string | null {
  if (!isTextureUrl(url)) return null
  return extractPetAssetFileName(url)
}

/**
 * 创建带 URL 规范化 + 贴图追踪的 LoadingManager。
 * 追踪实现：包装 `itemStart/itemEnd/itemError`（LoadingManager 的公开方法），
 * 不改动 MMDLoader 内部逻辑，也不会吞掉错误。
 *
 * F06 修复：pending 计数与按 name 的在途计数（`inFlight`）配对——
 * - 每个 itemStart 都 +1（同名重复 URL 不丢计数）；
 * - 每个 itemEnd 只对「确实 start 过」的 name 递减（不因去重而提前归零 / 下溢）；
 * - `itemError → itemEnd` 同一次尝试按失败记入 missing；重试成功后从 missing 移到 loaded。
 * 这样 `whenIdle` 不会在还有在途贴图（或重试退避占位）时提前 resolve。
 */
export function createPetAssetLoadTracker(): PetAssetLoadTracker {
  const manager = new LoadingManager()
  manager.setURLModifier(normalizePetAssetUrl)

  const loaded = new Set<string>()
  const missing = new Set<string>()
  /** 每个贴图文件名当前在途的加载数（重试/重复 URL 时按计数配对）。 */
  const inFlight = new Map<string, number>()
  /** 本轮（一次加载尝试）内是否出现过 itemError；重试开始时清除。 */
  const errored = new Set<string>()
  let pending = 0
  let idleResolvers: Array<() => void> = []

  const notifyIfIdle = (): void => {
    if (pending > 0) return
    const resolvers = idleResolvers
    idleResolvers = []
    for (const resolve of resolvers) resolve()
  }

  const beginTexture = (name: string): void => {
    inFlight.set(name, (inFlight.get(name) ?? 0) + 1)
    // 新一次尝试（含重试）清除上一轮的失败标记：重试成功后会从 missing 移回 loaded。
    errored.delete(name)
    pending += 1
  }

  const endTexture = (name: string): void => {
    const count = inFlight.get(name) ?? 0
    // 未配对的 itemEnd（异常回调/重复通知）：不递减，避免 pending 下溢导致 whenIdle 提前 resolve。
    if (count <= 0) return
    if (count === 1) inFlight.delete(name)
    else inFlight.set(name, count - 1)
    pending = Math.max(0, pending - 1)

    if (errored.has(name)) {
      missing.add(name)
      loaded.delete(name)
      return
    }
    // 本轮成功：重试场景下把 name 从 missing 移回 loaded。
    missing.delete(name)
    loaded.add(name)
  }

  const baseStart = manager.itemStart.bind(manager)
  const baseEnd = manager.itemEnd.bind(manager)
  const baseError = manager.itemError.bind(manager)

  manager.itemStart = (url: string): void => {
    const name = textureTrackingKey(url)
    if (name !== null) beginTexture(name)
    baseStart(url)
  }

  manager.itemEnd = (url: string): void => {
    const name = textureTrackingKey(url)
    if (name !== null) endTexture(name)
    baseEnd(url)
    notifyIfIdle()
  }

  manager.itemError = (url: string): void => {
    const name = textureTrackingKey(url)
    if (name !== null) {
      errored.add(name)
      missing.add(name)
      loaded.delete(name)
    }
    baseError(url)
  }

  return {
    manager,
    get loadedTextures() {
      return [...loaded]
    },
    get missingTextures() {
      return [...missing]
    },
    get textureCount() {
      return loaded.size
    },
    get pendingTextureCount() {
      return pending
    },
    holdPending(): () => void {
      pending += 1
      let released = false
      return () => {
        if (released) return
        released = true
        pending = Math.max(0, pending - 1)
        if (pending <= 0) notifyIfIdle()
      }
    },
    whenIdle(timeoutMs = 4000): Promise<void> {
      if (pending <= 0) return Promise.resolve()
      return new Promise<void>((resolve) => {
        let finished = false
        const finish = (): void => {
          if (finished) return
          finished = true
          clearTimeout(timer)
          idleResolvers = idleResolvers.filter((candidate) => candidate !== finish)
          resolve()
        }
        const timer = setTimeout(finish, timeoutMs)
        idleResolvers.push(finish)
      })
    }
  }
}
