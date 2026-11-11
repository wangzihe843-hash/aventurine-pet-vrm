/**
 * 设置页 HTML 契约（Wave 3 A4）—— 只读静态文件，不启动 DOM/Electron。
 *
 * 背景：`src/renderer/src/settings/main.ts` 用 `mustElement(id)` 抓取固定 id，控件缺失会在
 * 运行时白屏。这里锁定「DSH 联动」分区新增的两个 Wave 3 开关及其 aria/class 约定，
 * 让 HTML 改名/漏写在校验阶段暴露，而不是要打开设置窗才能发现。
 */
import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

const html = readFileSync(
  new URL('../src/renderer/settings.html', import.meta.url),
  'utf8'
)

/** 断言某个 id 恰好出现一次（id 重复同样是契约破坏）。 */
function countId(id: string): number {
  return html.split(`id="${id}"`).length - 1
}

describe('settings.html · DSH 联动分区（Wave 3 A4）', () => {
  it('保留既有 Wave 2 控件 id（不得改名/移除）', () => {
    for (const id of [
      'settings-root',
      'dshlink-toggle',
      'dsh-status-line',
      'dsh-status-dot',
      'dsh-status-text',
      'restore-defaults',
      'save-state'
    ]) {
      expect(countId(id), `缺少或重复 #${id}`).toBe(1)
    }
  })

  it('新增两个 Wave 3 开关 id：dshCoupling / dshBubbleSync', () => {
    expect(countId('dsh-coupling-toggle')).toBe(1)
    expect(countId('dsh-bubble-sync-toggle')).toBe(1)
  })

  it('两个新开关沿用现有 switch + sr-only 无障碍模式', () => {
    for (const id of ['dsh-coupling-toggle', 'dsh-bubble-sync-toggle']) {
      const index = html.indexOf(`id="${id}"`)
      expect(index).toBeGreaterThan(0)
      // checkbox 位于 <label class="switch"> 内，并配一个 sr-only 可读名称。
      const before = html.slice(Math.max(0, index - 400), index)
      expect(before).toContain('<label class="switch">')
      const around = html.slice(Math.max(0, index - 200), index + 400)
      expect(around).toContain('type="checkbox"')
      expect(around).toContain('switch-track')
      expect(around).toContain('sr-only')
    }
  })

  it('文案使用 §7 冻结口径（双向保活 / 气泡同步）', () => {
    expect(html).toContain('与 DeepSeek Harness 同生共死（双向保活）')
    expect(html).toContain('头顶气泡同步 DSH 回复')
    expect(html).toContain('DSH 联动')
  })

  it('状态行位于「DSH 联动」分区内，且不新增 IPC/内联脚本', () => {
    const sectionStart = html.indexOf('aria-labelledby="dsh-title"')
    const sectionEnd = html.indexOf('</section>', sectionStart)
    expect(sectionStart).toBeGreaterThan(0)
    expect(sectionEnd).toBeGreaterThan(sectionStart)
    const section = html.slice(sectionStart, sectionEnd)
    expect(section).toContain('dsh-status-line')
    expect(section).toContain('dsh-coupling-toggle')
    expect(section).toContain('dsh-bubble-sync-toggle')
    // CSP 禁止内联脚本：去掉 HTML 注释后，全页只有一个带 src 的 module 入口。
    const markup = html.replace(/<!--[\s\S]*?-->/g, '')
    const scriptTags = markup.match(/<script\b[^>]*>/g) ?? []
    expect(scriptTags).toHaveLength(1)
    expect(scriptTags[0]).toContain('type="module"')
    expect(scriptTags[0]).toContain('src="./src/settings/main.ts"')
  })
})
