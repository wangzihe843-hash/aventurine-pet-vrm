/**
 * `pet-asset://` 自定义协议 —— 集成骨架（Wave 1 开工前置；A2 消费，A3 继续加固；
 * Wave 2 V1 新增 host `assets`）。
 *
 * 两个 host，按 host 分支（URL 前置校验见 `./protocol-path`）：
 * - `pet-asset://model/<文件名>`（旧，A2/PMX，契约冻结）：
 *   `<文件名>` 是**单段**文件名，契约见 PLAN §8.1 / `parseSafeRelativePath`。
 *   dev（`!app.isPackaged`）根：`<repo>/assets/model/optimized`（20 张贴图 + PMX 副本）。
 *   **不回退**到 `assets/model` 根：优化产物是唯一合法来源。这样冒烟里
 *   `pet-asset://model/<pmx>` 返回 200 才能证明 PMX 副本确实进了 optimized/，
 *   否则回退根会让 P0-3 的 smoke 证据失真（独立复验 MED-2/LOW-3）。
 *   packaged 根：`<process.resourcesPath>/model`（C4 extraResources 目标）；
 *   同时兼容其下 `optimized/` 子目录布局。
 * - `pet-asset://assets/<相对路径>`（Wave 2 V1 前置；VRM/动作/表情 JSON）：
 *   支持最多 12 段的多段相对路径（`vrm/x.vrm`、`motions/mate/idle.json`、
 *   `expressions/hsr/idleShowFace.json`…）。dev 根：`<app.getAppPath()>/assets`；
 *   packaged 根：`<process.resourcesPath>/assets`，不存在时退 `<process.resourcesPath>`
 *   （兼容旧打包布局把资源直接铺在 resources 根下的情况）。
 *
 * 安全约束（URL/路径解析抽到无 Electron 依赖的 `./protocol-path`，可单测）：
 * - 只处理 GET；scheme 必须 `pet-asset:`、host 必须 `model`/`assets`、不得带 port/userinfo；
 * - model host：pathname 经 `decodeURIComponent` 后拒绝 `..`、`/`（路径分隔符，含 `%2F`）、
 *   `\`、空段、绝对路径与 `:` —— **只接受单段文件名**（M-2）；
 * - assets host：pathname **逐段** `decodeURIComponent` 后拒绝空段、`.`/`..`、NUL、
 *   反斜杠、段内 `/`（含 `%2F` 编码）、绝对路径与 `:`，并限制段数/单段长度/总长度
 *   （`parseSafeAssetSegments`）；
 * - 落盘路径必须是允许根内的**普通文件**：先 `isInsideRoot`，再 `realpath(root)`，
 *   再 `realpath(candidate)`（静态符号链接跟随并做根内二次校验），再
 *   `realpath(dirname(resolved))` 后拼回 `basename`；最终段用
 *   `O_RDONLY | O_NOFOLLOW | O_NONBLOCK` 打开并 `fstat().isFile()`，按 fd 读取 ——
 *   校验通过后即使最终段被替换为符号链接/目录/FIFO，也不会读到根外内容或阻塞
 *   （F3：静态根内符号链接维持 200 契约，竞态符号链接被 O_NOFOLLOW 拒绝 → 403）。
 * - 越界映射：旧 host `model` 的「根外符号链接 → 404（不泄露）」语义保持不变（A3/F3 冻结）；
 *   新 host `assets` 的任何越界（含根外符号链接）→ 403（Wave 2 §1/§2 安全要求）。
 * - 文件名本身非法（`ENAMETOOLONG`）与符号链接环/竞态（`ELOOP`）→ 403（F7，契约「非法→403」）；
 *   不存在/目录/非普通文件 → 404；只有真正的意外 fs 错误才 500。
 *
 * 威胁模型：本进程与资源根目录同属一个 macOS 用户。realpath 二次校验 + O_NOFOLLOW 能阻止
 * 「校验后被换成符号链接」的竞态读到根外，但无法消除同用户对父目录本身的并发替换
 * （攻击者已具备同等文件权限，非跨权限边界；F3/F11 记录接受该残余风险）。
 *
 * 统一响应头 `Access-Control-Allow-Origin: *` + `Cache-Control: no-cache`：
 * renderer（dev 是 http://localhost:5173，生产是 file://）跨源 fetch/Image 需要 CORS；
 * A2 的 WebGL 贴图用 `crossOrigin='anonymous'` 后 canvas 不被 taint 才能 `getImageData`
 * （本文件也在冒烟里被端到端验证）。Wave 2 的 VRM/JSON 走 fetch arrayBuffer/json 同样受益。
 *
 * 注意：`registerPetAssetScheme()` 必须在 `app.whenReady()` 之前调用（Electron 硬性要求）。
 */
import { app, protocol } from 'electron'
import { constants, existsSync } from 'node:fs'
import { lstat, open, realpath } from 'node:fs/promises'
import { basename, dirname, extname, join } from 'node:path'
import {
  isInsideRoot,
  parseSafeAssetSegments,
  parseSafeRelativePath,
  petAssetHostOf,
  PET_ASSET_HOST,
  PET_ASSET_SCHEME
} from './protocol-path'

// 兼容既有 import 路径：index.ts / 后续任务仍可从 `main/protocol` 引用常量。
export {
  PET_ASSET_ASSETS_HOST,
  PET_ASSET_HOST,
  PET_ASSET_SCHEME,
  petAssetsUrl,
  petAssetUrl
} from './protocol-path'

/** ready 之前调用：把 scheme 注册为 standard/secure/CORS/fetch 能力齐备的协议。 */
export function registerPetAssetScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: PET_ASSET_SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        corsEnabled: true,
        stream: true
      }
    }
  ])
}

/** 扩展名 → MIME；未列出的统一 application/octet-stream（PMX 等二进制）。 */
const MIME_BY_EXTENSION: Readonly<Record<string, string>> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.bmp': 'image/bmp',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.pmx': 'application/octet-stream',
  '.vmd': 'application/octet-stream',
  // Wave 2：VRM/glTF 资产（fetch/GLTFLoader 走 arrayBuffer，MIME 只影响可读性/调试）。
  '.vrm': 'model/gltf-binary',
  '.glb': 'model/gltf-binary',
  '.gltf': 'model/gltf+json',
  '.vrma': 'model/gltf-binary',
  '.json': 'application/json'
}

/** 所有响应共用的头（CORS + 不缓存，保证资源更新后 renderer 立即读到）。 */
const COMMON_HEADERS: Readonly<Record<string, string>> = {
  'Access-Control-Allow-Origin': '*',
  'Cache-Control': 'no-cache'
}

/**
 * 允许读取的旧 host（`model`）资源根目录（按顺序尝试）。
 * - dev：只有 `assets/model/optimized`（唯一合法来源，无回退）
 * - packaged：`<resourcesPath>/model`，并兼容其下 `optimized/` 子目录布局
 *
 * 导出供冒烟断言 `getAssetRoots()[0]` 内确实存在 PMX 副本（MED-2）。
 */
export function getAssetRoots(): string[] {
  if (app.isPackaged) {
    const packagedRoot = join(process.resourcesPath, 'model')
    return [packagedRoot, join(packagedRoot, 'optimized')]
  }
  return [join(app.getAppPath(), 'assets', 'model', 'optimized')]
}

/**
 * 允许读取的新 host（`assets`）资源根目录。
 * - dev：`<app.getAppPath()>/assets`（仓库私有资产树；`assets/**` 整体 gitignore）
 * - packaged：`<process.resourcesPath>/assets`；该目录不存在时退 `<process.resourcesPath>`
 *   （兼容旧打包布局把资源直接铺在 resources 根下的情况）
 *
 * 导出供冒烟/集成测试断言根映射。
 */
export function getAssetsHostRoots(): string[] {
  if (app.isPackaged) {
    const packagedAssetsRoot = join(process.resourcesPath, 'assets')
    return existsSync(packagedAssetsRoot) ? [packagedAssetsRoot] : [process.resourcesPath]
  }
  return [join(app.getAppPath(), 'assets')]
}

/** `Response` 构造体的类型别名（避免直接引用全局 BodyInit，node/undici 类型下的 Uint8Array 需要显式收窄）。 */
type ResponseBody = ConstructorParameters<typeof Response>[0]

function createResponse(
  status: number,
  body: Uint8Array | string | null,
  headers: Record<string, string>
): Response {
  return new Response(body as ResponseBody, { status, headers })
}

function errorResponse(status: number, message: string): Response {
  return createResponse(status, message, {
    ...COMMON_HEADERS,
    'Content-Type': 'text/plain; charset=utf-8'
  })
}

/** `readAsset` 的三态结果：200 / 404 / 403 分别映射到 handler。 */
type AssetReadResult =
  | { kind: 'ok'; bytes: Uint8Array; mime: string }
  | { kind: 'missing' }
  | { kind: 'forbidden' }

/**
 * 根内校验失败时的结果：旧 host `model` 按「不泄露」返回 missing（404，F3 冻结语义），
 * 新 host `assets` 按「越界一律 403」返回 forbidden（Wave 2 §1/§2）。
 */
function outsideRootResult(outsideRootIsForbidden: boolean): AssetReadResult {
  return outsideRootIsForbidden ? { kind: 'forbidden' } : { kind: 'missing' }
}

/**
 * 在单个根内读取资源。
 *
 * 安全步骤（PLAN §8.1 + 审查 F3；Wave 2 host `assets` 复用同一套链）：
 * 1. 字符串级 root 校验（防 `..`/绝对路径拼接）；
 * 2. `realpath(root)`（允许根目录本身是符号链接，如 worktree 场景）；
 * 3. `realpath(candidate)` 跟随静态符号链接并做根内二次校验：根外目标 → 按 host 策略
 *    （model→404 不泄露 / assets→403），根内目标 → 继续（维持 §8.1 既有「根内符号链接可读」语义）；
 * 4. `realpath(dirname(resolved))` 后再拼 `basename(resolved)`，对最终段做带 `O_NOFOLLOW`
 *    的 open —— 校验通过后最终段被替换成符号链接（TOCTOU）会被拒绝，而不是读到根外；
 * 5. `open(O_RDONLY|O_NOFOLLOW|O_NONBLOCK)` + `fstat().isFile()` + 按 fd 读取：
 *    目录/FIFO/设备/竞态替换成符号链接都拒绝；不阻塞。
 *
 * 残余风险：父目录在步骤 3-5 之间被同用户替换无法完全消除（同一权限边界，见文件头威胁模型）。
 */
async function readAssetFromRoot(
  root: string,
  segments: string[],
  outsideRootIsForbidden: boolean
): Promise<AssetReadResult> {
  const candidate = join(root, ...segments)
  if (!isInsideRoot(root, candidate)) return outsideRootResult(outsideRootIsForbidden)

  const realRoot = await realpath(root)
  // 静态符号链接（含最终段）先 realpath 并做根内二次校验：根内→放行，根外→按 host 策略处理。
  const realCandidate = await realpath(candidate)
  if (!isInsideRoot(realRoot, realCandidate)) return outsideRootResult(outsideRootIsForbidden)
  const realParent = await realpath(dirname(realCandidate))
  if (!isInsideRoot(realRoot, realParent)) return outsideRootResult(outsideRootIsForbidden)
  const resolved = join(realParent, basename(realCandidate))
  if (!isInsideRoot(realRoot, resolved)) return outsideRootResult(outsideRootIsForbidden)

  const entry = await lstat(resolved)
  if (!entry.isFile()) return { kind: 'missing' }

  const handle = await open(resolved, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const stat = await handle.stat()
    if (!stat.isFile()) return { kind: 'missing' }
    const bytes = await handle.readFile()
    const mime = MIME_BY_EXTENSION[extname(resolved).toLowerCase()] ?? 'application/octet-stream'
    return { kind: 'ok', bytes: new Uint8Array(bytes), mime }
  } finally {
    // close 失败不影响已经读到的内容。
    await handle.close().catch(() => undefined)
  }
}

/**
 * 按根目录顺序读取资源；三态结果（ok / missing / forbidden）。
 * 根目录依赖 Electron `app`/`process.resourcesPath`，由 handler 按 host 传入。
 */
async function readAsset(
  segments: string[],
  roots: readonly string[],
  outsideRootIsForbidden: boolean
): Promise<AssetReadResult> {
  for (const root of roots) {
    try {
      const result = await readAssetFromRoot(root, segments, outsideRootIsForbidden)
      if (result.kind !== 'missing') return result
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'ENOENT' || code === 'ENOTDIR' || code === 'EISDIR') continue
      // 契约「非法 → 403」：超长文件名 / 符号链接环或最终段竞态不落 500（F7）。
      if (code === 'ENAMETOOLONG' || code === 'ELOOP') return { kind: 'forbidden' }
      throw error
    }
  }
  return { kind: 'missing' }
}

/** 协议错误日志的最小接口（与 `./logger` 的 Logger 结构兼容）：只用于 500 意外错误。 */
export interface PetAssetProtocolLogger {
  error(message: string, meta?: unknown): void
}

/** `app.whenReady()` 之后调用：接管 `pet-asset://` 请求。 */
export function registerPetAssetProtocol(logger?: PetAssetProtocolLogger): void {
  // 可选注入 logger（F6）：index.ts 的接线由 Lead 完成；无参调用保持向后兼容。
  protocol.handle(PET_ASSET_SCHEME, async (request): Promise<Response> => {
    if (request.method !== 'GET') return errorResponse(405, 'Method Not Allowed')

    let url: URL
    try {
      url = new URL(request.url)
    } catch {
      return errorResponse(400, 'Bad Request')
    }
    const host = petAssetHostOf(url)
    if (!host) return errorResponse(403, 'Forbidden')

    // host 分支：model 走冻结的单段契约；assets 走多段相对路径契约（逐段 decode/校验）。
    const isModelHost = host === PET_ASSET_HOST
    const segments = isModelHost
      ? parseSafeRelativePath(url.pathname)
      : parseSafeAssetSegments(url.pathname)
    if (!segments) return errorResponse(403, 'Forbidden')

    try {
      const asset = await readAsset(
        segments,
        isModelHost ? getAssetRoots() : getAssetsHostRoots(),
        // 旧 host 保持「根外符号链接 → 404」；新 host 越界一律 403。
        !isModelHost
      )
      if (asset.kind === 'forbidden') return errorResponse(403, 'Forbidden')
      if (asset.kind === 'missing') return errorResponse(404, 'Not Found')
      return createResponse(200, asset.bytes, {
        ...COMMON_HEADERS,
        'Content-Type': asset.mime,
        'Content-Length': String(asset.bytes.byteLength)
      })
    } catch (error) {
      // 只有真正意外的 fs 错误（EACCES/EIO…）才 500；非法名字/符号链接已在 readAsset 内映射。
      const message = '[protocol] pet-asset read failed:'
      if (logger) logger.error(message, error)
      else console.error(message, error)
      return errorResponse(500, 'Internal Server Error')
    }
  })
}
