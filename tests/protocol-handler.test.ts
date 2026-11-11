/**
 * handler 级安全/协议测试：用 `vi.mock('electron')` 驱动**真实** `src/main/protocol.ts`，
 * 捕获 `protocol.handle` 注册的 handler，对真实临时目录（`assets/model/optimized` 与
 * Wave 2 新增的 `assets/` 资产树）发起 Request。
 *
 * 覆盖独立审查 A3 的 F1 缺口与 M-2/F3/F6/F7/F8 修复：
 * - 200：Content-Type / Content-Length / ACAO / Cache-Control / 字节内容（PNG、PMX、未知扩展名）；
 * - 403：host/port/scheme 伪造、`..%2F`、单段契约（裸/编码多段）、NUL、反斜杠、非法 UTF-8、超长名；
 * - 404：不存在、目录、双编码字面名（只解码一次）、根外符号链接、无回退根；
 * - 405：POST / HEAD / PUT；
 * - 符号链接：根外目标 → 404；根内目标 → 200（§8.1 既有语义）；根目录本身是符号链接 → 200；
 *   TOCTOU：realpath/lstat 通过后把文件换成根外符号链接 → O_NOFOLLOW 拒绝，绝不 200；
 * - packaged 根映射（`process.resourcesPath` 注入）与 `optimized/` 兼容根；
 * - F6 logger 注入（意外错误走注入 logger，而非只 console.error）。
 *
 * Wave 2 V1 追加（host `assets`，多段相对路径）：
 * - 200：`vrm/*.vrm`、`motions/mate/*.json`、`expressions/hsr/*.json` 嵌套读取，
 *   .vrm/.glb/.gltf/.vrma/.json MIME 与响应头、CJK/空格/括号/em-dash 段名；
 * - 403：编码穿越（`%2e%2e%2f`、`%2F`、`..%2f`）、空段、NUL、反斜杠、盘符、非法编码、
 *   超深/超长路径、根外符号链接（assets host 越界一律 403）与嵌套 TOCTOU；
 * - 404：不存在、目录、双编码字面名、URL 归一化后的根相对路径；
 * - 405：assets host 同样只允许 GET（HEAD → 405）；
 * - packaged：`resources/assets` 优先，不存在时退 `resourcesPath`；
 * - CORS：非法/不存在响应同样带 ACAO（renderer fetch 错误可读）。
 *
 * `node:fs/promises.open` 被包装一层 `fsHooks.beforeOpen`，仅用于确定性复现 TOCTOU 竞态；
 * 其余 fs 行为仍是真实实现。
 */
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const electronState = vi.hoisted(() => ({
  appPath: '',
  isPackaged: false,
  throwOnGetAppPath: false,
  scheme: '',
  privileged: [] as unknown[],
  handler: null as ((request: Request) => Promise<Response>) | null
}))

/** 测试注入点：真实 open 之前执行一次（用于把目标文件换成符号链接）。 */
const fsHooks = vi.hoisted(() => ({
  beforeOpen: undefined as (() => void) | undefined
}))

vi.mock('electron', () => ({
  app: {
    get isPackaged(): boolean {
      return electronState.isPackaged
    },
    getAppPath(): string {
      if (electronState.throwOnGetAppPath) throw new Error('getAppPath boom')
      return electronState.appPath
    }
  },
  protocol: {
    registerSchemesAsPrivileged(entries: unknown[]): void {
      electronState.privileged = entries
    },
    handle(scheme: string, handler: (request: Request) => Promise<Response>): void {
      electronState.scheme = scheme
      electronState.handler = handler
    }
  }
}))

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    open: async (...args: Parameters<typeof actual.open>) => {
      fsHooks.beforeOpen?.()
      fsHooks.beforeOpen = undefined
      return actual.open(...args)
    }
  }
})

import {
  getAssetRoots,
  getAssetsHostRoots,
  petAssetUrl,
  petAssetsUrl,
  registerPetAssetProtocol,
  registerPetAssetScheme
} from '../src/main/protocol'

const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3])
const PMX_BYTES = Buffer.from([0x50, 0x4d, 0x58, 0x20, 0x32, 0x2e, 0x30, 9, 9])
const SPACE_BYTES = Buffer.from([1, 2])
const NO_EXT_BYTES = Buffer.from([5])
const UNICODE_FILE = '星穹铁道—砂金·戏浪.pmx'
/** Wave 2 资产树夹具：不同扩展名各一份小字节，断言 MIME/字节透传。 */
const VRM_BYTES = Buffer.from([0x67, 0x6c, 0x54, 0x46, 0x01])
const GLB_BYTES = Buffer.from([0x67, 0x6c, 0x54, 0x46, 0x02])
const GLTF_BYTES = Buffer.from('{"asset":{"version":"2.0"}}')
const VRMA_BYTES = Buffer.from([0x67, 0x6c, 0x54, 0x46, 0x03])
const JSON_BYTES = Buffer.from('{"version":1,"clip":"idle"}')
const ASSETS_UNICODE_FILE = '星穹铁道—砂金·戏浪(1.0) v2.vrm'

const logger = { error: vi.fn() }

let baseDir: string
let appRoot: string
let symlinkAppRoot: string
let assetsRoot: string
let assetsHostRoot: string
let outsideDir: string
let resourcesRoot: string
let resourcesFallbackRoot: string

/** 捕获的 handler（未注册时抛错，避免用例静默通过）。 */
function currentHandler(): (request: Request) => Promise<Response> {
  const handler = electronState.handler
  if (!handler) throw new Error('protocol.handle 未注册 handler')
  return handler
}

async function request(url: string, method = 'GET'): Promise<Response> {
  return currentHandler()(new Request(url, { method }))
}

async function requestText(url: string, method = 'GET'): Promise<{ status: number; text: string }> {
  const response = await request(url, method)
  return { status: response.status, text: await response.text() }
}

beforeAll(() => {
  baseDir = mkdtempSync(join(tmpdir(), 'pet-protocol-handler-'))
  appRoot = join(baseDir, 'app')
  assetsRoot = join(appRoot, 'assets', 'model', 'optimized')
  assetsHostRoot = join(appRoot, 'assets')
  outsideDir = join(baseDir, 'outside')
  resourcesRoot = join(baseDir, 'resources')
  resourcesFallbackRoot = join(baseDir, 'resources-fallback')

  mkdirSync(join(assetsRoot, 'sub'), { recursive: true })
  mkdirSync(outsideDir, { recursive: true })
  mkdirSync(join(assetsRoot, 'a-directory'), { recursive: true })
  writeFileSync(join(assetsRoot, '颜.png'), PNG_BYTES)
  writeFileSync(join(assetsRoot, UNICODE_FILE), PMX_BYTES)
  writeFileSync(join(assetsRoot, 'space name(1).png'), SPACE_BYTES)
  writeFileSync(join(assetsRoot, 'no-ext.bin'), NO_EXT_BYTES)
  writeFileSync(join(assetsRoot, 'sub', 'nested.png'), Buffer.from([3, 4]))
  writeFileSync(join(assetsRoot, 'race.png'), 'RACE-INSIDE')
  writeFileSync(join(outsideDir, 'secret.png'), 'TOPSECRET-OUTSIDE')
  symlinkSync(join(outsideDir, 'secret.png'), join(assetsRoot, 'evil-link.png'))
  symlinkSync(join(assetsRoot, '颜.png'), join(assetsRoot, 'inner-link.png'))

  // 无回退：dev 根是 optimized，兄弟目录 assets/model 下的同名文件不可读。
  writeFileSync(join(appRoot, 'assets', 'model', 'fallback.png'), 'MUST-NOT-BE-SERVED')

  // --- Wave 2：host `assets` 的多段资产树（dev 根 = <appPath>/assets） ---
  mkdirSync(join(assetsHostRoot, 'vrm', 'a-directory'), { recursive: true })
  mkdirSync(join(assetsHostRoot, 'motions', 'mate'), { recursive: true })
  mkdirSync(join(assetsHostRoot, 'expressions', 'hsr'), { recursive: true })
  writeFileSync(join(assetsHostRoot, 'vrm', 'aventurine-tpose.vrm'), VRM_BYTES)
  writeFileSync(join(assetsHostRoot, 'vrm', ASSETS_UNICODE_FILE), VRM_BYTES)
  writeFileSync(join(assetsHostRoot, 'vrm', 'canary.glb'), GLB_BYTES)
  writeFileSync(join(assetsHostRoot, 'vrm', 'canary.gltf'), GLTF_BYTES)
  writeFileSync(join(assetsHostRoot, 'vrm', 'idle.vrma'), VRMA_BYTES)
  writeFileSync(join(assetsHostRoot, 'motions', 'mate', 'idle.json'), JSON_BYTES)
  writeFileSync(join(assetsHostRoot, 'expressions', 'hsr', 'idleShowFace.json'), JSON_BYTES)
  writeFileSync(join(assetsHostRoot, 'vrm', 'race.json'), 'RACE-INSIDE')
  writeFileSync(join(outsideDir, 'outside-asset.vrm'), 'TOPSECRET-ASSET')
  symlinkSync(join(outsideDir, 'outside-asset.vrm'), join(assetsHostRoot, 'vrm', 'evil-link.vrm'))

  // 根目录本身是符号链接（worktree 场景）：应正常读取根内文件。
  symlinkAppRoot = join(baseDir, 'app-symlink')
  mkdirSync(join(symlinkAppRoot, 'assets', 'model'), { recursive: true })
  symlinkSync(assetsRoot, join(symlinkAppRoot, 'assets', 'model', 'optimized'))

  // packaged 根：resources/model + 兼容 resources/model/optimized。
  mkdirSync(join(resourcesRoot, 'model', 'optimized'), { recursive: true })
  writeFileSync(join(resourcesRoot, 'model', 'prod.png'), Buffer.from([7, 7, 7]))
  writeFileSync(join(resourcesRoot, 'model', 'optimized', 'opt.png'), Buffer.from([8, 8]))
  // packaged assets host 根：resources/assets（存在时优先）。
  mkdirSync(join(resourcesRoot, 'assets', 'vrm'), { recursive: true })
  writeFileSync(join(resourcesRoot, 'assets', 'vrm', 'prod.vrm'), Buffer.from([11, 12]))
  // resources/assets 不存在时的回退根 resourcesPath（文件直接铺在 resources 根下）。
  mkdirSync(join(resourcesFallbackRoot, 'vrm'), { recursive: true })
  writeFileSync(join(resourcesFallbackRoot, 'vrm', 'legacy.vrm'), Buffer.from([21, 22]))
  Object.defineProperty(process, 'resourcesPath', {
    value: resourcesRoot,
    configurable: true,
    writable: true
  })

  electronState.appPath = appRoot
  registerPetAssetScheme()
  registerPetAssetProtocol(logger)
})

beforeEach(() => {
  electronState.isPackaged = false
  electronState.throwOnGetAppPath = false
  electronState.appPath = appRoot
  fsHooks.beforeOpen = undefined
  logger.error.mockClear()
  rmSync(join(assetsRoot, 'race.png'), { force: true })
  writeFileSync(join(assetsRoot, 'race.png'), 'RACE-INSIDE')
  rmSync(join(assetsHostRoot, 'vrm', 'race.json'), { force: true })
  writeFileSync(join(assetsHostRoot, 'vrm', 'race.json'), 'RACE-INSIDE')
})

afterAll(() => {
  delete (process as unknown as { resourcesPath?: string }).resourcesPath
  rmSync(baseDir, { recursive: true, force: true })
})

describe('scheme 注册（ready 前 registerSchemesAsPrivileged）', () => {
  it('pet-asset scheme 与 §8.1 冻结的 privileges 五元组一致', () => {
    expect(electronState.privileged).toEqual([
      {
        scheme: 'pet-asset',
        privileges: {
          standard: true,
          secure: true,
          supportFetchAPI: true,
          corsEnabled: true,
          stream: true
        }
      }
    ])
    expect(electronState.scheme).toBe('pet-asset')
  })
})

describe('dev 根映射', () => {
  it('dev 唯一合法根是 <appPath>/assets/model/optimized（无回退）', () => {
    expect(getAssetRoots()).toEqual([assetsRoot])
  })

  it('兄弟目录 assets/model 下的文件不会被服务（404，证明无回退根）', async () => {
    expect((await requestText('pet-asset://model/fallback.png')).status).toBe(404)
  })
})

describe('200：合法资源 + 完整响应头', () => {
  it('PNG：Content-Type image/png、Content-Length 精确、ACAO/Cache-Control、字节一致', async () => {
    const response = await request(petAssetUrl('颜.png'))
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('image/png')
    expect(response.headers.get('content-length')).toBe(String(PNG_BYTES.length))
    expect(response.headers.get('access-control-allow-origin')).toBe('*')
    expect(response.headers.get('cache-control')).toBe('no-cache')
    expect(Buffer.from(await response.arrayBuffer())).toEqual(PNG_BYTES)
  })

  it('PMX（CJK/em-dash）：application/octet-stream + 字节一致', async () => {
    const response = await request(petAssetUrl(UNICODE_FILE))
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('application/octet-stream')
    expect(response.headers.get('content-length')).toBe(String(PMX_BYTES.length))
    expect(Buffer.from(await response.arrayBuffer())).toEqual(PMX_BYTES)
  })

  it('空格/括号文件名与未知扩展名（octet-stream 兜底）都能读取', async () => {
    const spaced = await request(petAssetUrl('space name(1).png'))
    expect(spaced.status).toBe(200)
    expect(spaced.headers.get('content-type')).toBe('image/png')
    expect(Buffer.from(await spaced.arrayBuffer())).toEqual(SPACE_BYTES)

    const unknown = await request('pet-asset://model/no-ext.bin')
    expect(unknown.status).toBe(200)
    expect(unknown.headers.get('content-type')).toBe('application/octet-stream')
    expect(Buffer.from(await unknown.arrayBuffer())).toEqual(NO_EXT_BYTES)
  })
})

describe('403：非法 URL / 非法路径（§8.1 契约）', () => {
  it.each([
    ['host 非 model', 'pet-asset://evil/颜.png'],
    ['带 port', 'pet-asset://model:1337/颜.png'],
    ['scheme 非 pet-asset', 'http://model/颜.png'],
    ['编码的 ..%2F 穿越', 'pet-asset://model/%2e%2e%2f%2e%2e%2fetc%2fpasswd'],
    ['裸多段路径（单段契约 M-2）', 'pet-asset://model/sub/nested.png'],
    ['编码斜杠多段（单段契约 M-2）', 'pet-asset://model/sub%2Fnested.png'],
    ['NUL', 'pet-asset://model/a%00b.png'],
    ['反斜杠', 'pet-asset://model/..%5c..%5cwin.ini'],
    ['overlong / 非法 UTF-8', 'pet-asset://model/%c0%ae%c0%ae'],
    ['非法百分号编码', 'pet-asset://model/%zz.png']
  ])('%s → 403', async (_label, url) => {
    const response = await request(url)
    expect(response.status).toBe(403)
    expect(response.headers.get('access-control-allow-origin')).toBe('*')
    expect(await response.text()).toBe('Forbidden')
  })

  it('超长文件名：ENAMETOOLONG 按契约映射 403（不是 500）', async () => {
    const url = `pet-asset://model/${'x'.repeat(300)}.png`
    const { status, text } = await requestText(url)
    expect(status).toBe(403)
    expect(text).toBe('Forbidden')
  })
})

describe('404：不存在 / 目录 / 不逃逸的双编码 / 根外符号链接', () => {
  it.each([
    ['不存在', 'pet-asset://model/missing.png'],
    ['目录不是普通文件', 'pet-asset://model/a-directory'],
    ['双编码只解码一次 → 字面文件名（404，不逃逸）', 'pet-asset://model/%252e%252e%252fetc'],
    ['根外符号链接 → 根外文件', 'pet-asset://model/evil-link.png']
  ])('%s → 404', async (_label, url) => {
    const response = await request(url)
    expect(response.status).toBe(404)
    expect(await response.text()).toBe('Not Found')
  })
})

describe('405：仅允许 GET', () => {
  it.each(['POST', 'HEAD', 'PUT'])('%s → 405', async (method) => {
    const response = await request(petAssetUrl('颜.png'), method)
    expect(response.status).toBe(405)
  })

  it.each(['POST', 'HEAD', 'PUT'])('assets host %s → 405（新旧 host 同一方法约束）', async (method) => {
    const response = await request(petAssetsUrl('vrm/aventurine-tpose.vrm'), method)
    expect(response.status).toBe(405)
  })
})

describe('符号链接边界（realpath + O_NOFOLLOW）', () => {
  it('根目录本身是符号链接（worktree 场景）仍可读取根内文件 → 200', async () => {
    electronState.appPath = symlinkAppRoot
    const response = await request(petAssetUrl('颜.png'))
    expect(response.status).toBe(200)
    expect(Buffer.from(await response.arrayBuffer())).toEqual(PNG_BYTES)
  })

  it('最终段是指向根内的符号链接 → 200（§8.1 既有语义：根内目标允许读取）', async () => {
    const response = await request('pet-asset://model/inner-link.png')
    expect(response.status).toBe(200)
    expect(Buffer.from(await response.arrayBuffer())).toEqual(PNG_BYTES)
  })

  it('TOCTOU：校验通过后最终段被换成根外符号链接 → O_NOFOLLOW 拒绝（403，绝不 200）', async () => {
    const racePath = join(assetsRoot, 'race.png')
    const outsideSecret = join(outsideDir, 'secret.png')
    // 真实的 open 之前把已通过 lstat 的普通文件替换为根外符号链接；
    // 旧实现（lstat 后 readFile(resolved)）会在这里读到 TOPSECRET。
    fsHooks.beforeOpen = (): void => {
      rmSync(racePath, { force: true })
      symlinkSync(outsideSecret, racePath)
    }

    const { status, text } = await requestText('pet-asset://model/race.png')
    expect(status).toBe(403)
    expect(text).not.toContain('TOPSECRET')
  })
})

describe('packaged 根映射（app.isPackaged=true + 注入 process.resourcesPath）', () => {
  it('根 = resources/model + resources/model/optimized，两个根都能读取', async () => {
    electronState.isPackaged = true
    expect(getAssetRoots()).toEqual([join(resourcesRoot, 'model'), join(resourcesRoot, 'model', 'optimized')])

    const prod = await request('pet-asset://model/prod.png')
    expect(prod.status).toBe(200)
    expect(Buffer.from(await prod.arrayBuffer())).toEqual(Buffer.from([7, 7, 7]))

    const opt = await request('pet-asset://model/opt.png')
    expect(opt.status).toBe(200)
    expect(Buffer.from(await opt.arrayBuffer())).toEqual(Buffer.from([8, 8]))
  })

  it('兼容根下的多段 URL（optimized/opt.png）仍按单段契约 403（M-2）', async () => {
    electronState.isPackaged = true
    expect((await request('pet-asset://model/optimized/opt.png')).status).toBe(403)
  })

  it('packaged 模式下不存在 → 404', async () => {
    electronState.isPackaged = true
    expect((await request('pet-asset://model/missing.png')).status).toBe(404)
  })
})

describe('assets host：dev 根映射与 200 读取', () => {
  it('dev 根 = <appPath>/assets（多段资产树唯一来源）', () => {
    expect(getAssetsHostRoots()).toEqual([assetsHostRoot])
  })

  it('VRM 多段路径：200、model/gltf-binary、字节/长度/CORS 头齐全', async () => {
    const response = await request(petAssetsUrl('vrm/aventurine-tpose.vrm'))
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('model/gltf-binary')
    expect(response.headers.get('content-length')).toBe(String(VRM_BYTES.length))
    expect(response.headers.get('access-control-allow-origin')).toBe('*')
    expect(response.headers.get('cache-control')).toBe('no-cache')
    expect(Buffer.from(await response.arrayBuffer())).toEqual(VRM_BYTES)
  })

  it('动作 / 表情 JSON：多段路径 → application/json + 字节一致', async () => {
    const motion = await request(petAssetsUrl('motions/mate/idle.json'))
    expect(motion.status).toBe(200)
    expect(motion.headers.get('content-type')).toBe('application/json')
    expect(Buffer.from(await motion.arrayBuffer())).toEqual(JSON_BYTES)

    const expression = await request(petAssetsUrl('expressions/hsr/idleShowFace.json'))
    expect(expression.status).toBe(200)
    expect(expression.headers.get('content-type')).toBe('application/json')
    expect(Buffer.from(await expression.arrayBuffer())).toEqual(JSON_BYTES)
  })

  it('.glb / .gltf / .vrma MIME 与字节透传（不影响 fetch arrayBuffer）', async () => {
    const glb = await request(petAssetsUrl('vrm/canary.glb'))
    expect(glb.status).toBe(200)
    expect(glb.headers.get('content-type')).toBe('model/gltf-binary')
    expect(Buffer.from(await glb.arrayBuffer())).toEqual(GLB_BYTES)

    const gltf = await request(petAssetsUrl('vrm/canary.gltf'))
    expect(gltf.status).toBe(200)
    expect(gltf.headers.get('content-type')).toBe('model/gltf+json')
    expect(Buffer.from(await gltf.arrayBuffer())).toEqual(GLTF_BYTES)

    const vrma = await request(petAssetsUrl('vrm/idle.vrma'))
    expect(vrma.status).toBe(200)
    expect(vrma.headers.get('content-type')).toBe('model/gltf-binary')
    expect(Buffer.from(await vrma.arrayBuffer())).toEqual(VRMA_BYTES)
  })

  it('CJK / 空格 / 括号 / em-dash 段名与文件名可读取', async () => {
    const viaBuilder = await request(petAssetsUrl(`vrm/${ASSETS_UNICODE_FILE}`))
    expect(viaBuilder.status).toBe(200)
    expect(Buffer.from(await viaBuilder.arrayBuffer())).toEqual(VRM_BYTES)

    // 手写编码 URL 亦同（不依赖 petAssetsUrl；空格由 URL 解析自动编码）。
    const rawEncoded = await request(
      'pet-asset://assets/vrm/%E6%98%9F%E7%A9%B9%E9%93%81%E9%81%93%E2%80%94%E7%A0%82%E9%87%91%C2%B7%E6%88%8F%E6%B5%AA(1.0) v2.vrm'
    )
    expect(rawEncoded.status).toBe(200)
  })

  it('旧 host model 的单段契约不受影响：裸 / 编码多段仍 403（M-2）', async () => {
    expect((await request('pet-asset://model/vrm/aventurine-tpose.vrm')).status).toBe(403)
    expect((await request('pet-asset://model/sub%2Fnested.png')).status).toBe(403)
  })
})

describe('assets host：403 非法 URL / 路径穿越 / 根外越界', () => {
  it.each([
    ['host 非 model/assets', 'pet-asset://evil/vrm/aventurine-tpose.vrm'],
    ['带 port', 'pet-asset://assets:1337/vrm/aventurine-tpose.vrm'],
    ['scheme 非 pet-asset', 'http://assets/vrm/aventurine-tpose.vrm'],
    ['编码的 ../..%2F 穿越', 'pet-asset://assets/vrm/%2e%2e%2f%2e%2e%2fetc%2fpasswd'],
    ['编码的 ..%2f', 'pet-asset://assets/..%2f..%2fetc%2fpasswd'],
    ['编码的绝对路径 %2F', 'pet-asset://assets/%2Fetc%2Fpasswd'],
    ['空段 //', 'pet-asset://assets//etc/passwd'],
    ['尾斜杠空段', 'pet-asset://assets/vrm/'],
    ['无 pathname', 'pet-asset://assets'],
    ['只有根路径', 'pet-asset://assets/'],
    ['NUL', 'pet-asset://assets/vrm/a%00b.vrm'],
    ['反斜杠', 'pet-asset://assets/vrm/%5c..%5cwin.ini'],
    ['Windows 盘符冒号', 'pet-asset://assets/C:%5cWindows%5cwin.ini'],
    ['非法 UTF-8', 'pet-asset://assets/vrm/%c0%ae%c0%ae'],
    ['非法百分号编码', 'pet-asset://assets/vrm/%zz.vrm'],
    ['超深（13 段）', `pet-asset://assets/${Array.from({ length: 13 }, (_, i) => `d${i}`).join('/')}`],
    ['超长单段（300 字符）', `pet-asset://assets/vrm/${'x'.repeat(300)}`]
  ])('%s → 403 + CORS 头 + Forbidden 文案', async (_label, url) => {
    const response = await request(url)
    expect(response.status).toBe(403)
    expect(response.headers.get('access-control-allow-origin')).toBe('*')
    expect(await response.text()).toBe('Forbidden')
  })

  it('根外符号链接：assets host 越界一律 403（旧 host 的 404 语义不受影响）', async () => {
    const { status, text } = await requestText('pet-asset://assets/vrm/evil-link.vrm')
    expect(status).toBe(403)
    expect(text).not.toContain('TOPSECRET')
  })

  it('嵌套目录 TOCTOU：realpath/lstat 后被换成根外符号链接 → O_NOFOLLOW 拒绝（403）', async () => {
    const racePath = join(assetsHostRoot, 'vrm', 'race.json')
    // 真实的 open 之前把已通过 lstat 的普通文件替换为根外符号链接。
    fsHooks.beforeOpen = (): void => {
      rmSync(racePath, { force: true })
      symlinkSync(join(outsideDir, 'outside-asset.vrm'), racePath)
    }

    const { status, text } = await requestText('pet-asset://assets/vrm/race.json')
    expect(status).toBe(403)
    expect(text).not.toContain('TOPSECRET')
  })
})

describe('assets host：404 不存在 / 目录 / 不逃逸的编码', () => {
  it.each([
    ['不存在', 'pet-asset://assets/vrm/missing.vrm'],
    ['目录不是普通文件', 'pet-asset://assets/vrm/a-directory'],
    ['双编码只解码一次 → 字面文件名（不逃逸）', 'pet-asset://assets/vrm/%252e%252e%252fetc'],
    ['URL 归一化后的根相对路径（根内不存在）', 'pet-asset://assets/../../etc/passwd']
  ])('%s → 404', async (_label, url) => {
    const response = await request(url)
    expect(response.status).toBe(404)
    expect(response.headers.get('access-control-allow-origin')).toBe('*')
    expect(await response.text()).toBe('Not Found')
  })
})

describe('assets host：packaged 根映射（resources/assets，缺省退 resourcesPath）', () => {
  it('resources/assets 存在时根 = <resourcesPath>/assets，且可读取', async () => {
    electronState.isPackaged = true
    expect(getAssetsHostRoots()).toEqual([join(resourcesRoot, 'assets')])

    const response = await request('pet-asset://assets/vrm/prod.vrm')
    expect(response.status).toBe(200)
    expect(Buffer.from(await response.arrayBuffer())).toEqual(Buffer.from([11, 12]))
  })

  it('resources/assets 不存在时退 <resourcesPath> 根', async () => {
    const previousResourcesPath = (process as unknown as { resourcesPath: string }).resourcesPath
    Object.defineProperty(process, 'resourcesPath', {
      value: resourcesFallbackRoot,
      configurable: true,
      writable: true
    })
    try {
      electronState.isPackaged = true
      expect(getAssetsHostRoots()).toEqual([resourcesFallbackRoot])

      const response = await request('pet-asset://assets/vrm/legacy.vrm')
      expect(response.status).toBe(200)
      expect(Buffer.from(await response.arrayBuffer())).toEqual(Buffer.from([21, 22]))
    } finally {
      Object.defineProperty(process, 'resourcesPath', {
        value: previousResourcesPath,
        configurable: true,
        writable: true
      })
    }
  })
})

describe('F6：可选注入 logger', () => {
  it('正常请求不调用注入的 logger.error', async () => {
    await request(petAssetUrl('颜.png'))
    expect(logger.error).not.toHaveBeenCalled()
  })

  it('真正意外错误（getAppPath 抛错）→ 500 且走注入 logger.error', async () => {
    electronState.throwOnGetAppPath = true
    const response = await request(petAssetUrl('颜.png'))
    expect(response.status).toBe(500)
    expect(logger.error).toHaveBeenCalledTimes(1)
    expect(logger.error.mock.calls[0]?.[0]).toBe('[protocol] pet-asset read failed:')
  })
})
