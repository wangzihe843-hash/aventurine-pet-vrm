/**
 * 单测：overlay 导航同 URL reload 放行判定（B-02 生产态恢复补丁）。
 *
 * 纯函数测试，不启动 Electron。安全边界：只有「目标 URL 与当前文档 URL 原始字符串完全相等」
 * 才放行；任何不同 URL / 非法输入都返回 false（主进程继续 preventDefault）。
 */
import { describe, expect, it } from 'vitest'

import {
  createCommittedUrlTracker,
  isSameUrlReload
} from '../src/main/security/navigation-guard'

describe('isSameUrlReload：仅放行当前文档的 reload', () => {
  it('file:// 生产路径：完全相等 → true', () => {
    const url = 'file:///Volumes/4TB%E5%A4%96%E7%BD%AE%E7%9B%98/app/out/renderer/index.html'
    expect(isSameUrlReload(url, url)).toBe(true)
  })

  it('dev server / query / hash：完全相等 → true', () => {
    const dev = 'http://localhost:5173/index.html?pet=1#debug'
    expect(isSameUrlReload(dev, dev)).toBe(true)
  })

  it('不同路径 / 不同 origin / 外链 → false', () => {
    expect(
      isSameUrlReload(
        'file:///Users/x/app/out/renderer/index.html',
        'file:///Users/x/app/out/renderer/other.html'
      )
    ).toBe(false)
    expect(
      isSameUrlReload(
        'file:///Users/x/app/out/renderer/index.html',
        'https://evil.example/index.html'
      )
    ).toBe(false)
    expect(
      isSameUrlReload('http://localhost:5173/index.html', 'http://localhost:5174/index.html')
    ).toBe(false)
  })

  it('query/hash 不同 → false（不做归一化，安全边界=逐字符相等）', () => {
    expect(
      isSameUrlReload('file:///a/index.html', 'file:///a/index.html#injected')
    ).toBe(false)
    expect(
      isSameUrlReload('file:///a/index.html', 'file:///a/index.html?token=evil')
    ).toBe(false)
  })

  it('末尾斜杠 / 大小写 / 百分号编码差异 → false（不替浏览器猜同一资源）', () => {
    expect(isSameUrlReload('http://localhost:5173/', 'http://localhost:5173')).toBe(false)
    expect(isSameUrlReload('file:///A/index.html', 'file:///a/index.html')).toBe(false)
    expect(
      isSameUrlReload('file:///a/%E7%A0%82%E9%87%91.html', 'file:///a/砂金.html')
    ).toBe(false)
  })

  it('非字符串 / 空串 / 特殊 scheme → false', () => {
    expect(isSameUrlReload(undefined, undefined)).toBe(false)
    expect(isSameUrlReload(null, 'file:///a/index.html')).toBe(false)
    expect(isSameUrlReload('file:///a/index.html', 42)).toBe(false)
    expect(isSameUrlReload('', '')).toBe(false)
    expect(isSameUrlReload('about:blank', 'about:blank')).toBe(true) // 与当前文档相同也等价于 reload，无新内容
    expect(isSameUrlReload('data:text/html,x', 'data:text/html,y')).toBe(false)
  })
})

describe('createCommittedUrlTracker：放行依据只认「真实提交 URL」', () => {
  it('初始值可作起点，noteCommitted 后更新为真实提交 URL', () => {
    const tracker = createCommittedUrlTracker('file:///a/index.html')
    expect(tracker.committed()).toBe('file:///a/index.html')
    expect(tracker.isSameUrlReload('file:///a/index.html')).toBe(true)

    tracker.noteCommitted('file:///a/next.html')
    expect(tracker.committed()).toBe('file:///a/next.html')
    expect(tracker.isSameUrlReload('file:///a/next.html')).toBe(true)
    expect(tracker.isSameUrlReload('file:///a/index.html')).toBe(false)
  })

  it('replaceState 篡改 getURL 后 reload：target=被篡改 URL 必须拒绝（B 复核实测的绕过点）', () => {
    // 真实提交的是 index.html；renderer 用 history.replaceState 把 visible URL 改成 evil 页面
    // 后 location.reload() 的 will-navigate target 会等于被篡改的 visible URL。
    const tracker = createCommittedUrlTracker('file:///a/index.html')
    tracker.noteCommitted('file:///a/index.html')

    const taintedVisibleUrl = 'https://evil.example/index.html'
    // 旧实现用 getURL() 比较 → 会误放行；修好后用 committed URL 比较 → 必须拒绝。
    expect(isSameUrlReload(taintedVisibleUrl, taintedVisibleUrl)).toBe(true) // 说明旧判据为何危险
    expect(tracker.isSameUrlReload(taintedVisibleUrl)).toBe(false)

    const taintedFileUrl = 'file:///a/other-page.html'
    expect(tracker.isSameUrlReload(taintedFileUrl)).toBe(false)
  })

  it('noteCommitted 忽略非字符串 / 空串；初始值为非字符串时回退空串', () => {
    const tracker = createCommittedUrlTracker(undefined)
    expect(tracker.committed()).toBe('')
    tracker.noteCommitted('file:///a/index.html')
    tracker.noteCommitted(42)
    tracker.noteCommitted('')
    tracker.noteCommitted(null)
    expect(tracker.committed()).toBe('file:///a/index.html')
    expect(tracker.isSameUrlReload('')).toBe(false)
  })

  it('正常 reload：target 与最近真实提交 URL 相等 → 放行', () => {
    const tracker = createCommittedUrlTracker()
    tracker.noteCommitted('file:///Volumes/%E5%A4%96%E7%BD%AE%E7%9B%98/app/index.html')
    expect(
      tracker.isSameUrlReload('file:///Volumes/%E5%A4%96%E7%BD%AE%E7%9B%98/app/index.html')
    ).toBe(true)
  })
})
