/**
 * 单测：`pet-asset://` 路径解析 / 安全校验（`src/main/protocol-path.ts`）。
 *
 * 覆盖独立复验指出的安全关键覆盖缺口（LOW-7）：目录穿越（`..`、编码斜杠、NUL、反斜杠、
 * 双编码、绝对路径）、host/port 校验、合法 CJK/空格文件名；以及 LOW-2 的 port 校验。
 * A3 修复补充：M-2「单段文件名」契约（解码后含 `/` 一律拒绝）与 F8 userinfo 拒绝。
 * Wave 2 V1 补充：host `assets` 的多段相对路径契约（`parseSafeAssetSegments`）——
 * 逐段解码、点段/编码斜杠/空段/盘符/NUL/超深/超长拒绝，以及双 host URL 校验与 URL 构造。
 * 纯函数模块不依赖 Electron，可直接在 node 环境跑。
 */
import { describe, expect, it } from 'vitest'

import {
  isAllowedPetAssetUrl,
  isInsideRoot,
  parseSafeAssetSegments,
  parseSafeRelativePath,
  petAssetHostOf,
  petAssetsUrl,
  petAssetUrl,
  PET_ASSET_ASSETS_HOST,
  PET_ASSET_ASSETS_MAX_PATH_LENGTH,
  PET_ASSET_ASSETS_MAX_SEGMENTS,
  PET_ASSET_ASSETS_MAX_SEGMENT_LENGTH,
  PET_ASSET_HOST,
  PET_ASSET_HOSTS,
  PET_ASSET_SCHEME
} from '../src/main/protocol-path'

/** 用 WHATWG URL 解析请求 URL，再跑与 protocol handler 相同的路径校验。 */
function segmentsFor(rawUrl: string): string[] | null {
  return parseSafeRelativePath(new URL(rawUrl).pathname)
}

/** 用 WHATWG URL 解析请求 URL，再跑 assets host 的多段路径校验（与 handler 同链路）。 */
function assetSegmentsFor(rawUrl: string): string[] | null {
  const url = new URL(rawUrl)
  if (petAssetHostOf(url) !== PET_ASSET_ASSETS_HOST) return null
  return parseSafeAssetSegments(url.pathname)
}

describe('parseSafeRelativePath：恶意 URL 必须拒绝', () => {
  it.each([
    ['编码的 ../..：%2e%2e%2f', 'pet-asset://model/%2e%2e%2f%2e%2e%2fetc%2fpasswd'],
    ['编码的 ..%2f', 'pet-asset://model/..%2f..%2fetc%2fpasswd'],
    ['编码的绝对路径 %2F', 'pet-asset://model/%2Fetc%2Fpasswd'],
    ['空段 //', 'pet-asset://model//etc/passwd'],
    ['NUL', 'pet-asset://model/a%00b.png'],
    ['反斜杠 %5c', 'pet-asset://model/..%5c..%5cwin.ini'],
    ['Windows 盘符冒号', 'pet-asset://model/C:%5cWindows%5cwin.ini'],
    ['解码后出现 .. 段', 'pet-asset://model/a%2F..%2Fb.png'],
    ['无 pathname', 'pet-asset://model'],
    ['尾斜杠空相对路径', 'pet-asset://model/'],
    ['仅编码斜杠', 'pet-asset://model/%2f%2f']
  ])('%s → null', (_label, url) => {
    expect(segmentsFor(url)).toBeNull()
  })

  it('../../../../etc/passwd：URL 归一后变成多段路径 → 拒绝（单段契约）', () => {
    // WHATWG URL 会先把点段归一化掉，handler 拿到的 pathname 已是 /etc/passwd；
    // 即使它不会逃出 root，多段路径本身也违反 §8.1「单段文件名」契约（M-2）。
    expect(segmentsFor('pet-asset://model/../../../../etc/passwd')).toBeNull()
  })

  it('双编码 %252e 不会被二次解码（只剩字面量，读不到根外文件）', () => {
    const segments = segmentsFor('pet-asset://model/%252e%252e%252fetc')
    expect(segments).toEqual(['%2e%2e%2fetc'])
    expect(segments?.some((segment) => segment === '..')).toBe(false)
  })
})

describe('parseSafeRelativePath：单段文件名契约（§8.1 / M-2）', () => {
  it('裸多段路径 / 编码斜杠 / 混合编码全部拒绝', () => {
    // `pet-asset://model/sub/nested.png`：即使根内真有 sub/nested.png 也不能放行。
    expect(segmentsFor('pet-asset://model/sub/nested.png')).toBeNull()
    expect(segmentsFor('pet-asset://model/sub%2Fnested.png')).toBeNull()
    expect(segmentsFor('pet-asset://model/a%2Fb.png')).toBeNull()
    expect(segmentsFor('pet-asset://model/a%2fb.png')).toBeNull()
    expect(segmentsFor('pet-asset://model/%2Fetc%2Fpasswd')).toBeNull()
  })

  it('直接调用纯函数同样拒绝解码后的路径分隔符（不依赖 URL 解析）', () => {
    expect(parseSafeRelativePath('/sub/nested.png')).toBeNull()
    expect(parseSafeRelativePath('/sub%2Fnested.png')).toBeNull()
    expect(parseSafeRelativePath('/a/b')).toBeNull()
  })

  it('文件名内部允许字面量 %（只做一次 decodeURIComponent）', () => {
    expect(segmentsFor('pet-asset://model/100%25.png')).toEqual(['100%.png'])
    expect(segmentsFor('pet-asset://model/%252e%252e%252fetc')).toEqual(['%2e%2e%2fetc'])
  })
})

describe('parseSafeRelativePath：合法文件名', () => {
  it('CJK 文件名解码正确（asset / PMX）', () => {
    expect(segmentsFor('pet-asset://model/%E9%A2%9C.png')).toEqual(['颜.png'])
    expect(
      segmentsFor(
        'pet-asset://model/%E6%98%9F%E7%A9%B9%E9%93%81%E9%81%93%E2%80%94%E7%A0%82%E9%87%91%C2%B7%E6%88%8F%E6%B5%AA.pmx'
      )
    ).toEqual(['星穹铁道—砂金·戏浪.pmx'])
  })

  it('空格 / 括号 / 百分号编码的文件名可解析', () => {
    expect(segmentsFor('pet-asset://model/a%20b%28x%29.png')).toEqual(['a b(x).png'])
    expect(segmentsFor('pet-asset://model/100%25.png')).toEqual(['100%.png'])
  })

  it('query / hash 不影响 pathname 校验', () => {
    expect(segmentsFor('pet-asset://model/x.png?a=1#frag')).toEqual(['x.png'])
  })
})

describe('isAllowedPetAssetUrl：scheme / host / port 三重校验（LOW-2）', () => {
  it('合法请求：pet-asset://model/... 且不带 port', () => {
    expect(isAllowedPetAssetUrl(new URL('pet-asset://model/x.png'))).toBe(true)
    expect(isAllowedPetAssetUrl(new URL(`pet-asset://${PET_ASSET_HOST}/%E9%A2%9C.png`))).toBe(true)
  })

  it('带 port 一律拒绝（§8.1 host 固定 model、无 port）', () => {
    expect(isAllowedPetAssetUrl(new URL('pet-asset://model:1337/x.png'))).toBe(false)
  })

  it('其它 host / 其它 scheme / 空 host 拒绝', () => {
    expect(isAllowedPetAssetUrl(new URL('pet-asset://evil/x.png'))).toBe(false)
    expect(isAllowedPetAssetUrl(new URL('http://model/x.png'))).toBe(false)
    expect(isAllowedPetAssetUrl(new URL('pet-asset:///x.png'))).toBe(false)
  })

  it('带 userinfo 一律拒绝（F8：不依赖 upstream Request 构造器兜底）', () => {
    expect(isAllowedPetAssetUrl(new URL('pet-asset://evil@model/x.png'))).toBe(false)
    expect(isAllowedPetAssetUrl(new URL('pet-asset://user:pass@model/x.png'))).toBe(false)
    // host 仍为 model 时也必须拒绝：userinfo 非空即非法。
    expect(new URL('pet-asset://evil@model/x.png').hostname).toBe(PET_ASSET_HOST)
  })

  it('scheme/host 常量与 PLAN §8.1 冻结值一致', () => {
    expect(PET_ASSET_SCHEME).toBe('pet-asset')
    expect(PET_ASSET_HOST).toBe('model')
  })
})

describe('isInsideRoot：路径边界校验', () => {
  const root = '/repo/assets/model/optimized'

  it('根内路径通过（含根自身）', () => {
    expect(isInsideRoot(root, root)).toBe(true)
    expect(isInsideRoot(root, `${root}/颜.png`)).toBe(true)
    expect(isInsideRoot(root, `${root}/sub/dir/a.png`)).toBe(true)
  })

  it('前缀相似的兄弟目录拒绝（不是简单 startsWith）', () => {
    expect(isInsideRoot(root, `${root}-evil/a.png`)).toBe(false)
    expect(isInsideRoot(root, '/repo/assets/model/optimized2/a.png')).toBe(false)
  })

  it('上级路径 / 绝对路径拒绝', () => {
    expect(isInsideRoot(root, '/repo/assets/model/secret.png')).toBe(false)
    expect(isInsideRoot(root, `${root}/../secret.png`)).toBe(false)
    expect(isInsideRoot(root, '/etc/passwd')).toBe(false)
  })
})

describe('parseSafeAssetSegments：assets host 合法多段相对路径', () => {
  it('典型 VRM / 动作 / 表情路径逐段解析', () => {
    expect(assetSegmentsFor('pet-asset://assets/vrm/aventurine-tpose.vrm')).toEqual([
      'vrm',
      'aventurine-tpose.vrm'
    ])
    expect(assetSegmentsFor('pet-asset://assets/motions/mate/idle.json')).toEqual([
      'motions',
      'mate',
      'idle.json'
    ])
    expect(assetSegmentsFor('pet-asset://assets/expressions/hsr/idleShowFace.json')).toEqual([
      'expressions',
      'hsr',
      'idleShowFace.json'
    ])
  })

  it('CJK / 空格 / 括号 / em-dash 段名逐段 decode', () => {
    expect(
      assetSegmentsFor(
        'pet-asset://assets/vrm/%E6%98%9F%E7%A9%B9%E9%93%81%E9%81%93%E2%80%94%E7%A0%82%E9%87%91%C2%B7%E6%88%8F%E6%B5%AA.pmx'
      )
    ).toEqual(['vrm', '星穹铁道—砂金·戏浪.pmx'])
    expect(
      assetSegmentsFor('pet-asset://assets/motions/%E8%A1%A8%E6%83%85/idle%20show%20(1).json')
    ).toEqual(['motions', '表情', 'idle show (1).json'])
  })

  it(`段数上限：${PET_ASSET_ASSETS_MAX_SEGMENTS} 段放行、多一段拒绝`, () => {
    const dirs = Array.from({ length: PET_ASSET_ASSETS_MAX_SEGMENTS }, (_, index) => `d${index}`)
    expect(parseSafeAssetSegments(`/${dirs.join('/')}`)).toEqual(dirs)
    expect(parseSafeAssetSegments(`/${dirs.join('/')}/extra`)).toBeNull()
  })

  it(`单段长度上限：${PET_ASSET_ASSETS_MAX_SEGMENT_LENGTH} 字符放行、超一字符拒绝`, () => {
    const maxSegment = 'x'.repeat(PET_ASSET_ASSETS_MAX_SEGMENT_LENGTH)
    expect(parseSafeAssetSegments(`/vrm/${maxSegment}`)).toEqual(['vrm', maxSegment])
    expect(parseSafeAssetSegments(`/vrm/${maxSegment}x`)).toBeNull()
  })

  it(`解码后总长上限：${PET_ASSET_ASSETS_MAX_PATH_LENGTH} 字符`, () => {
    // 8×255+1 = 2041 ≤ 上限；9×255 = 2295 > 上限（9 段仍在段数上限内，确保命中总长限制）。
    const maxSegment = 'y'.repeat(PET_ASSET_ASSETS_MAX_SEGMENT_LENGTH)
    const within = [...Array.from({ length: 8 }, () => maxSegment), 'z']
    expect(parseSafeAssetSegments(`/${within.join('/')}`)).not.toBeNull()
    const over = Array.from({ length: 9 }, () => maxSegment)
    expect(parseSafeAssetSegments(`/${over.join('/')}`)).toBeNull()
  })
})

describe('parseSafeAssetSegments：编码 / 穿越攻击必须拒绝', () => {
  it.each([
    ['段内编码的 ../..%2F', 'pet-asset://assets/vrm/%2e%2e%2f%2e%2e%2fetc%2fpasswd'],
    ['编码的 ..%2f', 'pet-asset://assets/..%2f..%2fetc%2fpasswd'],
    ['编码的绝对路径 %2F', 'pet-asset://assets/%2Fetc%2Fpasswd'],
    ['编码反斜杠 %5c', 'pet-asset://assets/vrm/%5c..%5cwin.ini'],
    ['NUL', 'pet-asset://assets/vrm/a%00b.json'],
    ['空段 //', 'pet-asset://assets//etc/passwd'],
    ['尾斜杠空段', 'pet-asset://assets/vrm/'],
    ['无 pathname', 'pet-asset://assets'],
    ['只有根路径', 'pet-asset://assets/'],
    ['Windows 盘符冒号', 'pet-asset://assets/C:%5cWindows%5cwin.ini'],
    ['非法百分号编码', 'pet-asset://assets/vrm/%zz.json'],
    ['非法 UTF-8', 'pet-asset://assets/vrm/%c0%ae%c0%ae'],
    ['段内编码斜杠', 'pet-asset://assets/a%2Fb.json'],
    ['超深（13 段）', `pet-asset://assets/${Array.from({ length: 13 }, (_, i) => `d${i}`).join('/')}`],
    ['超长单段（256）', `pet-asset://assets/vrm/${'x'.repeat(256)}`]
  ])('%s → null', (_label, url) => {
    expect(assetSegmentsFor(url)).toBeNull()
  })

  it('直接调用纯函数同样拒绝点段 / 空段 / 无前导斜杠（防上游未归一化 pathname）', () => {
    expect(parseSafeAssetSegments('/vrm/../x.json')).toBeNull()
    expect(parseSafeAssetSegments('/vrm/%2e%2e/x.json')).toBeNull()
    expect(parseSafeAssetSegments('/%2e/x.json')).toBeNull()
    expect(parseSafeAssetSegments('/vrm/./x.json')).toBeNull()
    expect(parseSafeAssetSegments('/vrm//x.json')).toBeNull()
    expect(parseSafeAssetSegments('vrm/x.json')).toBeNull()
    expect(parseSafeAssetSegments('')).toBeNull()
    expect(parseSafeAssetSegments('/')).toBeNull()
  })

  it('WHATWG URL 会先归一化点段：裸 ../ 折叠为根相对路径，不残留 .. 段', () => {
    // URL 规范化发生在本函数之前；`../../etc/passwd` 到 handler 时已是 `/etc/passwd`。
    // 真正防逃逸由 handler 的 join + isInsideRoot + realpath 二次校验兜底（handler 测试覆盖）。
    expect(assetSegmentsFor('pet-asset://assets/vrm/../motions/idle.json')).toEqual([
      'motions',
      'idle.json'
    ])
    expect(assetSegmentsFor('pet-asset://assets/../../etc/passwd')).toEqual(['etc', 'passwd'])
  })

  it('双编码 %25 只解一次 → 字面量段名，不构成穿越', () => {
    expect(assetSegmentsFor('pet-asset://assets/motions/%252e%252e%252fetc')).toEqual([
      'motions',
      '%2e%2e%2fetc'
    ])
  })
})

describe('petAssetHostOf / isAllowedPetAssetUrl：双 host 校验', () => {
  it('model / assets 两个 host 都放行，host 大小写不敏感', () => {
    expect(petAssetHostOf(new URL('pet-asset://model/x.png'))).toBe(PET_ASSET_HOST)
    expect(petAssetHostOf(new URL('pet-asset://assets/vrm/x.vrm'))).toBe(PET_ASSET_ASSETS_HOST)
    expect(petAssetHostOf(new URL('pet-asset://ASSETS/vrm/x.vrm'))).toBe(PET_ASSET_ASSETS_HOST)
    expect(isAllowedPetAssetUrl(new URL('pet-asset://assets/vrm/x.vrm'))).toBe(true)
  })

  it('其它 host / 带 port / userinfo / 其它 scheme 一律拒绝', () => {
    expect(petAssetHostOf(new URL('pet-asset://evil/x.png'))).toBeNull()
    expect(petAssetHostOf(new URL('pet-asset://assets:1337/x'))).toBeNull()
    expect(petAssetHostOf(new URL('pet-asset://user@assets/x'))).toBeNull()
    expect(petAssetHostOf(new URL('http://assets/x'))).toBeNull()
    expect(isAllowedPetAssetUrl(new URL('pet-asset://evil/assets/x'))).toBe(false)
  })

  it('host 常量与冻结契约一致', () => {
    expect(PET_ASSET_HOST).toBe('model')
    expect(PET_ASSET_ASSETS_HOST).toBe('assets')
    expect(PET_ASSET_HOSTS).toEqual(['model', 'assets'])
  })

  it('petAssetsUrl：多段 / CJK / 空格按段编码；petAssetUrl 旧 host 行为不变', () => {
    expect(petAssetsUrl('vrm/aventurine-tpose.vrm')).toBe(
      'pet-asset://assets/vrm/aventurine-tpose.vrm'
    )
    expect(petAssetsUrl('motions/mate/idle.json')).toBe(
      'pet-asset://assets/motions/mate/idle.json'
    )
    expect(petAssetsUrl('vrm/星穹铁道—砂金·戏浪.pmx')).toBe(
      'pet-asset://assets/vrm/%E6%98%9F%E7%A9%B9%E9%93%81%E9%81%93%E2%80%94%E7%A0%82%E9%87%91%C2%B7%E6%88%8F%E6%B5%AA.pmx'
    )
    expect(petAssetsUrl('')).toBe('pet-asset://assets/')
    // 回归：旧 host 单段文件名构造保持原样。
    expect(petAssetUrl('颜.png')).toBe('pet-asset://model/%E9%A2%9C.png')
  })
})
