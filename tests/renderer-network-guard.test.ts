/**
 * 单测：renderer 出站网络兜底 + URL 日志脱敏（R-22 / R-23）。
 *
 * `src/main/security/renderer-network-guard.ts` 不 import electron，因此这里直接用
 * 文件内 fake session，不 mock Electron：
 * - R-22 `maskUrl`：只记 protocol/origin、非法 URL 占位、绝不抛异常；
 * - R-23 `installRendererNetworkGuard`：仅打包版注册；filter 只含 http(s)；
 *   http(s) 请求一律 `{ cancel: true }` 且日志不含完整 URL（query token 不落盘）。
 */
import { describe, expect, it, vi } from 'vitest'

import {
  INVALID_URL_PLACEHOLDER,
  RENDERER_NETWORK_FILTER,
  installRendererNetworkGuard,
  maskUrl
} from '../src/main/security/renderer-network-guard'
import type {
  BeforeRequestCallback,
  BeforeRequestDetails,
  RendererNetworkGuardSession
} from '../src/main/security/renderer-network-guard'

/* --------------------------------- 脱敏 helper --------------------------------- */

describe('R-22 maskUrl：只记 protocol/origin，不泄露 query/path', () => {
  it('http(s) URL 只保留 protocol + host（含端口）', () => {
    expect(maskUrl('https://evil.example/steal?sessionToken=SECRET#frag')).toBe(
      'https://evil.example'
    )
    expect(maskUrl('http://127.0.0.1:5173/index.html?x=1')).toBe('http://127.0.0.1:5173')
    expect(maskUrl('https://user:pass@example.com/a/b?token=t')).toBe('https://example.com')
  })

  it('自定义协议保留 protocol + host；无 host 的 scheme 只保留 protocol', () => {
    expect(maskUrl('pet-asset://textures/optimized/face.png')).toBe('pet-asset://textures')
    expect(maskUrl('file:///Users/someone/secret/index.html?x=1')).toBe('file:')
    expect(maskUrl('about:blank')).toBe('about:')
  })

  it('非法 / 空 / 非字符串 → <invalid-url>（绝不抛异常）', () => {
    expect(maskUrl('not a url')).toBe(INVALID_URL_PLACEHOLDER)
    expect(maskUrl('')).toBe(INVALID_URL_PLACEHOLDER)
    expect(maskUrl(undefined)).toBe(INVALID_URL_PLACEHOLDER)
    expect(maskUrl(null)).toBe(INVALID_URL_PLACEHOLDER)
    expect(maskUrl(42)).toBe(INVALID_URL_PLACEHOLDER)
    expect(maskUrl({ href: 'https://evil.example' })).toBe(INVALID_URL_PLACEHOLDER)
    expect(() => maskUrl(Symbol('x'))).not.toThrow()
  })

  it('脱敏结果不含 query 敏感值（日志落盘安全）', () => {
    const masked = maskUrl('https://evil.example/cb?access_token=TOP_SECRET')
    expect(masked).not.toContain('TOP_SECRET')
    expect(masked).not.toContain('access_token')
  })
})

/* --------------------------------- 网络 guard --------------------------------- */

interface RecordedRegistration {
  filter: { urls: string[] }
  listener: (details: BeforeRequestDetails, callback: BeforeRequestCallback) => void
}

interface FakeSessionHarness {
  session: RendererNetworkGuardSession
  registrations: RecordedRegistration[]
}

function createFakeSession(): FakeSessionHarness {
  const registrations: RecordedRegistration[] = []
  const session: RendererNetworkGuardSession = {
    webRequest: {
      onBeforeRequest(filter, listener): void {
        registrations.push({ filter, listener })
      }
    }
  }
  return { session, registrations }
}

describe('R-23 installRendererNetworkGuard：仅打包版注册、只拦 http(s)', () => {
  it('非打包版（dev）不注册任何 webRequest 拦截', () => {
    const { session, registrations } = createFakeSession()
    const logger = { warn: vi.fn() }

    expect(installRendererNetworkGuard(session, { isPackaged: false, logger })).toBe(false)
    expect(registrations).toHaveLength(0)
    expect(logger.warn).not.toHaveBeenCalled()
  })

  it('打包版注册一次，filter 只含 http(s)（不拦 file/pet-asset/dev server）', () => {
    const { session, registrations } = createFakeSession()
    installRendererNetworkGuard(session, { isPackaged: true })

    expect(registrations).toHaveLength(1)
    expect(registrations[0]?.filter.urls).toEqual(['http://*/*', 'https://*/*'])
    expect(RENDERER_NETWORK_FILTER.urls).toEqual(['http://*/*', 'https://*/*'])
    // 断言 filter 覆盖不到自身页面 / 素材协议 / dev server scheme。
    const filterText = JSON.stringify(registrations[0]?.filter)
    expect(filterText).not.toContain('file')
    expect(filterText).not.toContain('pet-asset')
    expect(filterText).not.toContain('ws://')
  })

  it('命中 http(s)：cancel:true，日志只含脱敏 URL（query token 不落盘）', () => {
    const { session, registrations } = createFakeSession()
    const logger = { warn: vi.fn() }
    installRendererNetworkGuard(session, { isPackaged: true, logger })

    const listener = registrations[0]?.listener
    expect(listener).toBeTypeOf('function')

    const callback = vi.fn()
    listener?.(
      { url: 'https://evil.example/steal?sessionToken=TOP_SECRET', resourceType: 'xhr' },
      callback
    )

    expect(callback).toHaveBeenCalledWith({ cancel: true })
    expect(logger.warn).toHaveBeenCalledTimes(1)
    const message = String(logger.warn.mock.calls[0]?.[0] ?? '')
    expect(message).toContain('https://evil.example')
    expect(message).not.toContain('TOP_SECRET')
    expect(message).not.toContain('sessionToken')
  })

  it('坏 URL / 缺 url 字段也只记 <invalid-url> 并取消（不抛异常）', () => {
    const { session, registrations } = createFakeSession()
    const logger = { warn: vi.fn() }
    installRendererNetworkGuard(session, { isPackaged: true, logger })

    const callback = vi.fn()
    expect(() => registrations[0]?.listener({}, callback)).not.toThrow()
    expect(callback).toHaveBeenCalledWith({ cancel: true })
    expect(String(logger.warn.mock.calls[0]?.[0] ?? '')).toContain(INVALID_URL_PLACEHOLDER)
  })

  it('可注入自定义 maskUrl（排障/测试旁路）', () => {
    const { session, registrations } = createFakeSession()
    const logger = { warn: vi.fn() }
    installRendererNetworkGuard(session, {
      isPackaged: true,
      logger,
      maskUrl: () => '<masked>'
    })

    registrations[0]?.listener({ url: 'https://evil.example/' }, vi.fn())
    expect(String(logger.warn.mock.calls[0]?.[0] ?? '')).toContain('<masked>')
  })

  it('打包版但未注入 logger：仍取消请求（guard 不依赖日志）', () => {
    const { session, registrations } = createFakeSession()
    installRendererNetworkGuard(session, { isPackaged: true })

    const callback = vi.fn()
    expect(() =>
      registrations[0]?.listener({ url: 'https://evil.example/' }, callback)
    ).not.toThrow()
    expect(callback).toHaveBeenCalledWith({ cancel: true })
  })
})
