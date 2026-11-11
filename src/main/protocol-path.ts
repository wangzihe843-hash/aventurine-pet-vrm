/**
 * `pet-asset://` URL 常量与路径解析/安全校验 —— 纯函数模块（无 Electron / 无 fs 依赖）。
 *
 * 从 `protocol.ts` 抽出，供 protocol handler 与 `tests/protocol-path.test.ts` 复用，
 * 让防目录穿越逻辑可被单测覆盖（独立复验 LOW-7 覆盖缺口）。
 *
 * 两个 host 契约（PLAN §8.1 + `docs/wave2-vrm-runtime-design.md` §1/§2）：
 * - 旧 host `model`（PMX 资源，冻结契约）：`pet-asset://model/<文件名>`，`<文件名>` 是
 *   **单段**文件名（POSIX，可含 CJK/空格/em-dash，调用方 `encodeURIComponent`），
 *   handler 侧 `decodeURIComponent`；只接受 `assets/model/optimized/` 下的文件；
 * - 新 host `assets`（Wave 2 V1 前置）：`pet-asset://assets/<相对路径>`，支持最多
 *   {@link PET_ASSET_ASSETS_MAX_SEGMENTS} 段的多段相对路径（VRM/动作/表情 JSON 等私有
 *   资产树），逐段 decode 后逐段校验；任何越界由 handler 映射 403。
 *
 * 两个 host 共用同一套 URL 前置校验（scheme/host/port/userinfo），路径段校验分开：
 * `parseSafeRelativePath` 保持「单段」冻结语义不动，`parseSafeAssetSegments` 是多段版本。
 */
import { resolve, sep } from 'node:path'

/** 自定义协议 scheme 名（CSP / renderer 侧引用同一常量语义）。 */
export const PET_ASSET_SCHEME = 'pet-asset'

/** 旧 host：PMX 资源（单段文件名契约，PLAN §8.1 冻结）。 */
export const PET_ASSET_HOST = 'model'

/** 新 host：私有资产树（Wave 2 V1，多段相对路径；VRM/动作/表情 JSON）。 */
export const PET_ASSET_ASSETS_HOST = 'assets'

/** handler 接受的全部 host；顺序固定为旧 host 在前（兼容既有调用方按 host 分支）。 */
export const PET_ASSET_HOSTS: readonly string[] = [PET_ASSET_HOST, PET_ASSET_ASSETS_HOST]

/** `assets` host 单条 URL 的最大路径段数（当前最深 `motions/mate/<file>`，留足余量）。 */
export const PET_ASSET_ASSETS_MAX_SEGMENTS = 12

/** `assets` host 单段解码后的最大字符数（fs 的 255 字节上限另有 ENAMETOOLONG → 403 兜底）。 */
export const PET_ASSET_ASSETS_MAX_SEGMENT_LENGTH = 255

/** `assets` host 解码后总字符数上限（防超长 URL 拖慢校验/日志）。 */
export const PET_ASSET_ASSETS_MAX_PATH_LENGTH = 2048

/**
 * 解析 URL 命中的 pet-asset host（小写规范化）；不是合法 pet-asset 请求时返回 null。
 *
 * 与 {@link isAllowedPetAssetUrl} 同一套前置校验：scheme 必须 `pet-asset:`、host 必须是
 * 已知 host、不带 port、不带 userinfo。host 单独返回供 handler 按 host 选根目录/解析器。
 * 注意：非 special scheme 的 WHATWG URL **不会**把 hostname 转小写（`ASSETS` 原样保留），
 * 这里统一 `toLowerCase()` 后比较，handler 不再各自处理。
 */
export function petAssetHostOf(url: URL): string | null {
  if (
    url.protocol !== `${PET_ASSET_SCHEME}:` ||
    url.port !== '' ||
    url.username !== '' ||
    url.password !== ''
  ) {
    return null
  }
  const hostname = url.hostname.toLowerCase()
  return PET_ASSET_HOSTS.includes(hostname) ? hostname : null
}

/**
 * URL 是否满足 `pet-asset:` scheme + 已知 host（`model` / `assets`）+ 不带 port + 不带 userinfo。
 *
 * userinfo（`pet-asset://user:pass@model/x`）在解析层就拒绝（F8）：当前 `new Request()`
 * 会拒绝带 credentials 的 URL，但不应依赖上游行为，未来 URL 来源变化时这是纵深防御。
 *
 * 历史说明：Wave 1 时该函数只接受 host `model`；Wave 2 新增 host `assets` 后扩展为
 * 接受两个 host（按 host 再做路径契约分支见 handler），旧 host 的判定语义不变。
 */
export function isAllowedPetAssetUrl(url: URL): boolean {
  return petAssetHostOf(url) !== null
}

/**
 * 把 URL pathname 解码 / 校验为**单段**文件名；非法返回 null（旧 host `model` 专用）。
 * 拒绝：解码失败、NUL、反斜杠、绝对路径、`/` 路径分隔符（含 `%2F` 编码）、
 * `.`/`..`、空段（`//` 或尾 `/`）、含 `:` 的名字。
 *
 * §8.1 契约：`<文件名>` 是 `assets/model/optimized/` 下的单段文件名。此处刻意**不做**
 * 多段目录支持（M-2）：解码后出现 `/` 直接拒绝，而不是按段放行——否则
 * `pet-asset://model/sub/nested.png` / `sub%2Fnested.png` 会被当作根内子目录读取，
 * 与「拒绝路径分隔符」的冻结契约不符（即使 realpath 兜底不会逃逸根目录）。
 */
export function parseSafeRelativePath(pathname: string): string[] | null {
  let decoded: string
  try {
    decoded = decodeURIComponent(pathname)
  } catch {
    return null
  }
  if (decoded.length === 0 || decoded.includes('\0') || decoded.includes('\\')) return null
  // URL pathname 恒以单个 '/' 开头；去掉后不允许再出现绝对路径形态。
  if (!decoded.startsWith('/')) return null
  const relative = decoded.slice(1)
  if (relative.length === 0) return null
  // 单段契约：解码后仍含路径分隔符（`/`，含原本 `%2F` 编码的斜杠）→ 非法。
  if (relative.includes('/')) return null

  const segment = relative
  if (segment === '.' || segment === '..') return null
  if (segment.includes(':')) return null
  return [segment]
}

/**
 * 把 URL pathname 逐段 decode / 校验为**多段**相对路径；非法返回 null（新 host `assets` 专用）。
 *
 * 与旧 host 的差异：允许 `/vrm/aventurine-tpose.vrm`、`motions/mate/idle.json` 这类多段路径，
 * 但每段仍按单段规则严格校验。**逐段 decode**（而不是整体 decode 后再 split）是关键：
 * 这样 `a%2Fb.vrm` 解码出的 `/` 只会作为「段内字符」被拒绝，不会变成新的目录层级。
 *
 * 拒绝规则（任何一条命中 → null，handler 统一 403）：
 * - pathname 为空 / 不以 `/` 开头（非绝对 URL 形态）/ 只有 `/`（无资源路径）；
 * - 空段（`//`、尾 `/`），即 URL 解析后仍出现的多余分隔符；
 * - 段数超过 {@link PET_ASSET_ASSETS_MAX_SEGMENTS}，或解码后总长超过
 *   {@link PET_ASSET_ASSETS_MAX_PATH_LENGTH}；
 * - 单段解码失败（非法 UTF-8 / 非法百分号编码）、解码后为空、超过
 *   {@link PET_ASSET_ASSETS_MAX_SEGMENT_LENGTH} 字符；
 * - 解码后为 `.` / `..`，含 NUL、反斜杠、`/`（含 `%2F`/`%2f` 编码）、`:`（盘符/ADS）。
 *
 * 注意：WHATWG URL 会先把 pathname 里的点段（含整段 `%2e%2e` 这类编码点段）归一化，
 * 所以 `../../etc/passwd` 到 handler 时已是根相对路径；本函数仍拒绝直接调用时出现的
 * `.`/`..` 段，handler 侧另有 `join` + `isInsideRoot` + realpath 二次校验兜底。
 */
export function parseSafeAssetSegments(pathname: string): string[] | null {
  if (typeof pathname !== 'string' || pathname.length === 0) return null
  // URL pathname 恒以单个 '/' 开头；去掉后按 '/' 切段，切完不允许再出现绝对路径形态。
  if (!pathname.startsWith('/')) return null
  const relative = pathname.slice(1)
  if (relative.length === 0) return null

  const rawSegments = relative.split('/')
  if (rawSegments.length > PET_ASSET_ASSETS_MAX_SEGMENTS) return null

  const segments: string[] = []
  let totalLength = 0
  for (const rawSegment of rawSegments) {
    // 空段 = `//` 或尾 `/`：不允许，避免路径语义歧义（也防「空段被 join 吞掉」的绕过）。
    if (rawSegment.length === 0) return null
    let decoded: string
    try {
      decoded = decodeURIComponent(rawSegment)
    } catch {
      return null
    }
    if (decoded.length === 0 || decoded.length > PET_ASSET_ASSETS_MAX_SEGMENT_LENGTH) return null
    if (decoded === '.' || decoded === '..') return null
    // 段内出现路径分隔符/字符串终止符/盘符冒号一律非法（`%2F` 解码后同样落在这里）。
    if (
      decoded.includes('\0') ||
      decoded.includes('\\') ||
      decoded.includes('/') ||
      decoded.includes(':')
    ) {
      return null
    }
    totalLength += decoded.length
    if (totalLength > PET_ASSET_ASSETS_MAX_PATH_LENGTH) return null
    segments.push(decoded)
  }
  return segments
}

/** 按 host + POSIX 相对路径拼 `pet-asset://` URL；各段 `encodeURIComponent`（中文/空格/括号安全）。 */
function buildPetAssetUrl(host: string, relativePath: string): string {
  const encodedPath = relativePath
    .split('/')
    .filter((segment) => segment.length > 0)
    .map((segment) => encodeURIComponent(segment))
    .join('/')
  return `${PET_ASSET_SCHEME}://${host}/${encodedPath}`
}

/** 构造旧 host（PMX 单段文件名）的协议 URL；行为与 Wave 1 完全一致。 */
export function petAssetUrl(fileName: string): string {
  return buildPetAssetUrl(PET_ASSET_HOST, fileName)
}

/** 构造新 host（`assets` 多段相对路径）的协议 URL，如 `pet-asset://assets/vrm/x.vrm`。 */
export function petAssetsUrl(relativePath: string): string {
  return buildPetAssetUrl(PET_ASSET_ASSETS_HOST, relativePath)
}

/** 校验候选绝对路径确实位于允许根目录内（resolve 后按路径分隔符边界比较）。 */
export function isInsideRoot(root: string, candidate: string): boolean {
  const resolvedRoot = resolve(root)
  const resolvedCandidate = resolve(candidate)
  return resolvedCandidate === resolvedRoot || resolvedCandidate.startsWith(resolvedRoot + sep)
}
