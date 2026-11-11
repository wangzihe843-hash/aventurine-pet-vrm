/**
 * 带指数退避重试的贴图加载器（F04 修复）。
 *
 * 背景：MMDLoader 内部用 `TextureLoader` 按 PMX 材质引用加载贴图（`MaterialBuilder._loadTexture`），
 * ImageLoader 失败时只 `manager.itemError` + `console`，没有任何重试；启动期一次瞬时失败
 * （协议/磁盘抖动、解码竞争）就会让对应材质永久缺图。这里通过
 * `LoadingManager.addHandler(图像扩展名, 本类实例)` 接管贴图加载：
 *
 * - 每张贴图最多重试 `maxRetries` 次（默认 3），退避 `baseDelayMs * 2^n`（250ms/500ms/1000ms）；
 * - 重试复用同一个 `Texture` 对象（MMDLoader 已把该对象塞进材质 params），成功后按
 *   TextureLoader 语义写入 `image` / `needsUpdate`，不会出现「换了 texture 但材质没换」；
 * - 重试是**串行**的（同一 URL 上一次结束才排下一次），不会并发重入；
 * - 退避期间通过 `holdPending` 占住加载追踪器的 pending 名额，避免 `whenIdle` 在两次
 *   尝试之间提前 resolve（配合 F06 的 pending 计数一致性）。
 *
 * 只接管 `png/jpg/jpeg/bmp/gif/webp`；`.tga` 仍走 MMDLoader 自己的 TGALoader。
 * 该 loader 由 `PetScene.loadModel` 在首次加载前安装到 tracker 的 LoadingManager 上。
 */
import { ImageLoader, Texture, TextureLoader } from 'three'
import type { LoadingManager } from 'three'

/** 单张贴图默认最大重试次数（不含首次尝试）。 */
export const DEFAULT_TEXTURE_MAX_RETRIES = 3

/** 首次重试延迟；之后按 2 的幂退避（250/500/1000ms）。 */
export const DEFAULT_TEXTURE_RETRY_BASE_MS = 250

/** 匹配贴图扩展名（与 pet-asset.ts 的 TEXTURE_EXTENSIONS 保持一致，避免误接管 PMX）。 */
export const TEXTURE_URL_PATTERN = /\.(?:png|jpe?g|bmp|gif|webp)(?:[?#].*)?$/i

/** 重试加载器选项（全部可注入，便于测试/调参）。 */
export interface RetryingTextureLoaderOptions {
  /** 最大重试次数（不含首次），默认 3。 */
  maxRetries?: number
  /** 首次重试延迟（毫秒），默认 250；之后指数退避。 */
  baseDelayMs?: number
  /** 退避期间占住追踪器 pending 名额的回调；返回幂等释放函数。 */
  holdPending?: () => () => void
  /** 调度器（默认 setTimeout；测试可注入同步执行）。 */
  schedule?: (fn: () => void, delayMs: number) => void
}

/** 把「一次贴图加载」的重试策略套在 TextureLoader 上（返回与 three 相同的 Texture）。 */
export class RetryingTextureLoader extends TextureLoader {
  private readonly maxRetries: number
  private readonly baseDelayMs: number
  private readonly holdPending?: () => () => void
  private readonly schedule: (fn: () => void, delayMs: number) => void

  constructor(manager: LoadingManager, options: RetryingTextureLoaderOptions = {}) {
    super(manager)
    this.maxRetries = Math.max(0, Math.trunc(options.maxRetries ?? DEFAULT_TEXTURE_MAX_RETRIES))
    this.baseDelayMs = Math.max(0, options.baseDelayMs ?? DEFAULT_TEXTURE_RETRY_BASE_MS)
    this.holdPending = options.holdPending
    this.schedule = options.schedule ?? ((fn, delayMs) => setTimeout(fn, delayMs))
    // MMDLoader 的 MaterialBuilder 默认用 anonymous 跨源（否则 custom protocol 贴图会 taint canvas，
    // `_checkImageTransparency` 的 getImageData 会抛错；冒烟也要求贴图不 taint）。
    this.crossOrigin = 'anonymous'
  }

  /**
   * 与 `TextureLoader.load` 同签名：同步返回 Texture，图片加载/重试在后台完成。
   * 重试全部失败时调用一次 `onError`（manager.itemError/itemEnd 由 ImageLoader 自己维护）。
   */
  override load(
    url: string,
    onLoad?: (texture: Texture) => void,
    onProgress?: (event: ProgressEvent) => void,
    onError?: (event: unknown) => void
  ): Texture {
    const texture = new Texture()

    const attempt = (attemptIndex: number, releasePending?: () => void): void => {
      const imageLoader = new ImageLoader(this.manager)
      imageLoader.setCrossOrigin(this.crossOrigin)
      imageLoader.setPath(this.path)
      imageLoader.load(
        url,
        (image) => {
          texture.image = image
          texture.needsUpdate = true
          onLoad?.(texture)
        },
        onProgress,
        (event) => {
          if (attemptIndex >= this.maxRetries) {
            onError?.(event)
            return
          }
          // 先占住 pending 名额（ImageLoader 随后 itemError/itemEnd 会让 pending 归零），
          // 保证 whenIdle 不会在退避窗口内提前 resolve。
          const release = this.holdPending?.()
          const delay = this.baseDelayMs * 2 ** attemptIndex
          this.schedule(() => attempt(attemptIndex + 1, release), delay)
        }
      )
      // 新一次 ImageLoader.load 已同步 itemStart（pending +1）：此刻再释放上一轮退避占位，
      // pending 全程 >0，且允许 whenIdle 在最终失败/成功后正确归零。
      releasePending?.()
    }

    attempt(0)
    return texture
  }
}

/**
 * 在 LoadingManager 上安装贴图重试（幂等由调用方保证：每个 PetScene 只装一次）。
 * MMDLoader 的 `MaterialBuilder._loadTexture` 会先查 `manager.getHandler(url)`，命中本 loader。
 */
export function installRetryingTextureLoader(
  manager: LoadingManager,
  options: RetryingTextureLoaderOptions = {}
): RetryingTextureLoader {
  const loader = new RetryingTextureLoader(manager, options)
  manager.addHandler(TEXTURE_URL_PATTERN, loader)
  return loader
}
