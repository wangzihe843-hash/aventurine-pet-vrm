/**
 * V6 表情预览 — Electron main（dev-only）
 *
 * 由 `preview-expressions.mjs` 启动；加载 preview-viewer.html，按 plan（JSON 文件）逐项：
 *   setWeights(weights) → setView(view) → capture() → 写 PNG。
 *
 * 环境变量：
 * - EXPR_BASE   静态服务 base URL（必填）
 * - EXPR_OUT    输出目录（必填）
 * - EXPR_VRM    assets 相对 VRM 路径（必填）
 * - EXPR_PLAN   plan JSON 路径（必填；[{ id, view, weights }]）
 * - EXPR_YAW    朝向修正角（度；默认 0）
 */
import { app, BrowserWindow } from 'electron'
import fs from 'node:fs'
import path from 'node:path'

const BASE = process.env.EXPR_BASE
const OUT = process.env.EXPR_OUT
const VRM = process.env.EXPR_VRM
const PLAN_PATH = process.env.EXPR_PLAN
const YAW = process.env.EXPR_YAW || '0'

async function main() {
  if (!BASE || !OUT || !VRM || !PLAN_PATH) throw new Error('missing EXPR_BASE/EXPR_OUT/EXPR_VRM/EXPR_PLAN')
  fs.mkdirSync(OUT, { recursive: true })
  const plan = JSON.parse(fs.readFileSync(PLAN_PATH, 'utf8'))
  if (!Array.isArray(plan) || plan.length === 0) throw new Error('plan 为空')

  const win = new BrowserWindow({
    width: 640,
    height: 800,
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false
    }
  })
  win.webContents.on('console-message', (_event, level, message) => {
    console.log(`[page:${level}] ${message}`)
  })

  const pageUrl = `${BASE}/scripts/vrm/expression/preview-viewer.html?vrm=${encodeURIComponent(VRM)}&yaw=${encodeURIComponent(YAW)}`
  await win.loadURL(pageUrl)
  const exec = (source) => win.webContents.executeJavaScript(source, true)

  const info = await exec(`(async () => {
    try { return await window.__exprViewer.ready; }
    catch (e) { return { error: String(e && e.stack || e) }; }
  })()`)
  console.log('[preview-expressions] model:', JSON.stringify({ height: info?.height, expressions: info?.expressionCount, presets: info?.presets?.length, customs: info?.customs?.length }))
  if (!info || info.error) throw new Error(`viewer not ready: ${info?.error || 'unknown'}`)

  const captured = []
  for (const item of plan) {
    const view = item.view || 'full'
    const weights = item.weights || {}
    const result = await exec(`(() => {
      try { return window.__exprViewer.setWeights(${JSON.stringify(weights)}) }
      catch (e) { return { error: String(e && e.stack || e) } }
    })()`)
    if (!result || result.error) {
      console.error('[preview-expressions] setWeights FAIL', item.id, result?.error)
      continue
    }
    if (Array.isArray(result.missing) && result.missing.length > 0) {
      console.error('[preview-expressions] missing expression:', item.id, result.missing.join(','))
    }
    await exec(`window.__exprViewer.setView(${JSON.stringify(view)})`)
    const dataUrl = await exec(`window.__exprViewer.capture()`)
    if (typeof dataUrl !== 'string' || !dataUrl.startsWith('data:image/png;base64,')) {
      console.error('[preview-expressions] capture FAIL', item.id)
      continue
    }
    const file = path.join(OUT, `${item.id}.png`)
    fs.writeFileSync(file, Buffer.from(dataUrl.slice('data:image/png;base64,'.length), 'base64'))
    captured.push({ id: item.id, view, file: path.basename(file), weights: Object.keys(weights) })
    console.log(`[preview-expressions] ${item.id} (${view}) -> ${path.basename(file)}`)
  }
  console.log(`[preview-expressions] done: ${captured.length}/${plan.length} frames`)
  fs.writeFileSync(path.join(OUT, 'capture-report.json'), JSON.stringify({ info, captured }, null, 2) + '\n')
  app.quit()
}

app.whenReady().then(main).catch((error) => {
  console.error('[preview-expressions] FAIL', error instanceof Error ? error.stack ?? error.message : String(error))
  app.exit(1)
})
