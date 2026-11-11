/**
 * V3 HSR motion preview — Electron main（dev-only，由 preview-hsr.mjs 启动）。
 * 加载 viewer.html，把 `assets/motions/hsr/<clip>.json` 应用到目标 VRM，逐视图/帧抓 PNG。
 */
import { app, BrowserWindow } from 'electron'
import fs from 'node:fs'
import path from 'node:path'

const BASE = process.env.PREVIEW_BASE
const OUT = process.env.PREVIEW_OUT
const VRM = process.env.PREVIEW_VRM || 'assets/vrm/aventurine-waveflair-legfix.vrm'
const CLIPS = (process.env.PREVIEW_CLIPS || '').split(',').map((s) => s.trim()).filter(Boolean)
const VIEWS = (process.env.PREVIEW_VIEWS || 'front').split(',').map((s) => s.trim()).filter(Boolean)
const FRACTIONS = (process.env.PREVIEW_FRAMES || '0,0.25,0.5,0.75')
  .split(',')
  .map((s) => Number(s))
  .filter((n) => Number.isFinite(n))
const RAW = process.env.PREVIEW_RAW !== '0'
const YAW = Number(process.env.PREVIEW_YAW || '0') || 0
const CLIP_PREFIX = process.env.PREVIEW_CLIP_PREFIX || 'assets/motions/hsr'
/** 手持道具预览（可选）：GLB repo 路径 / 标定数据文件 / 持道具的 clip 列表 */
const PROP = process.env.PREVIEW_PROP || ''
const PROP_CALIB = process.env.PREVIEW_PROP_CALIB || ''
const PROP_CALIB_CLIP = process.env.PREVIEW_PROP_CALIB_CLIP || ''
const PROP_HOLD = new Set(
  (process.env.PREVIEW_PROP_HOLD || '').split(',').map((value) => value.trim()).filter(Boolean)
)
const PROP_TRANSFORM = process.env.PREVIEW_PROP_TRANSFORM || ''
/** 挂点骨名（dev 预览用；默认 rightHand，可传 leftHand 等） */
const PROP_BONE = (process.env.PREVIEW_PROP_BONE || '').trim()

async function main() {
  if (!BASE || !OUT) throw new Error('missing PREVIEW_BASE / PREVIEW_OUT')
  fs.mkdirSync(OUT, { recursive: true })

  const win = new BrowserWindow({
    width: 600,
    height: 800,
    show: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling: false }
  })
  win.webContents.on('console-message', (_event, _level, message) => console.log(`[page] ${message}`))

  const propParam = PROP ? `&prop=${encodeURIComponent(PROP)}` : ''
  const boneParam = PROP_BONE ? `&propBone=${encodeURIComponent(PROP_BONE)}` : ''
  const pageUrl = `${BASE}/scripts/vrm/motion/viewer.html?vrm=${encodeURIComponent(VRM)}&raw=${RAW ? '1' : '0'}&yaw=${YAW}${propParam}${boneParam}`
  await win.loadURL(pageUrl)
  const exec = (source) => win.webContents.executeJavaScript(source, true)

  const info = await exec(`(async () => {
    try { return await window.__clipViewer.ready }
    catch (error) { return { error: String((error && error.stack) || error) } }
  })()`)
  console.log('[preview] model:', JSON.stringify(info))
  if (!info || info.error) throw new Error(`viewer not ready: ${info?.error || 'unknown'}`)

  if (PROP && PROP_TRANSFORM) {
    try {
      const transform = JSON.parse(
        fs.readFileSync(path.resolve(process.env.PREVIEW_ROOT || process.cwd(), PROP_TRANSFORM), 'utf8')
      )
      const payload = {
        position: transform.position,
        quaternion: transform.quaternion,
        scale: transform.scale ?? 1
      }
      const applied = await exec(`window.__clipViewer.setPropTransform(${JSON.stringify(payload)})`)
      console.log('[preview] prop transform:', JSON.stringify(applied))
    } catch (error) {
      console.error('[preview] prop transform 读取/应用失败：', error)
    }
  }

  let propCalibrated = !PROP
  for (const clipName of CLIPS) {
    const clipUrl = `${CLIP_PREFIX}/${clipName}.json`
    const meta = await exec(`(async () => {
      try { return await window.__clipViewer.loadClip(${JSON.stringify(clipUrl)}) }
      catch (error) { return { error: String((error && error.stack) || error) } }
    })()`)
    console.log('[preview] clip:', clipName, JSON.stringify(meta))
    if (!meta || meta.error) continue
    if (PROP && PROP_CALIB && !propCalibrated && (!PROP_CALIB_CLIP || PROP_CALIB_CLIP === clipName)) {
      const calibJson = fs.readFileSync(path.resolve(process.env.PREVIEW_ROOT || process.cwd(), PROP_CALIB), 'utf8')
      const calibration = await exec(`(() => {
        try { return window.__clipViewer.calibratePropFromSamples(${JSON.stringify(calibJson)}) }
        catch (error) { return { error: String((error && error.stack) || error) } }
      })()`)
      console.log('[preview] prop calibration:', JSON.stringify(calibration))
      if (!calibration || calibration.error) console.error('[preview] prop calibration FAILED')
      propCalibrated = true
    }
    if (PROP) {
      const hold = PROP_HOLD.has(clipName)
      await exec(`window.__clipViewer.setPropVisible(${hold ? 'true' : 'false'})`)
      console.log('[preview] prop visible for', clipName, '=', hold)
    }
    for (const view of VIEWS) {
      await exec(`window.__clipViewer.setView(${JSON.stringify(view)})`)
      for (const fraction of FRACTIONS) {
        const t = Math.max(0, (meta.duration || 1) * fraction)
        const dataUrl = await exec(`window.__clipViewer.captureAt(${t})`)
        if (!dataUrl || !dataUrl.startsWith('data:image/png;base64,')) {
          console.error('[preview] bad capture', clipName, view, fraction)
          continue
        }
        const suffix = String(Math.round(fraction * 100)).padStart(3, '0')
        fs.writeFileSync(path.join(OUT, `${clipName}-${view}-${suffix}.png`), Buffer.from(dataUrl.split(',')[1], 'base64'))
      }
    }
  }
  app.exit(0)
}

app.whenReady().then(main).catch((error) => {
  console.error('[preview] FAIL:', error)
  app.exit(1)
})
