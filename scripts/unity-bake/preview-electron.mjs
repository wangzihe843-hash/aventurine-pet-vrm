/**
 * U2 clip preview — Electron main（dev-only）
 * 由 preview-clips.mjs 启动；加载 clip-viewer.html，对每个 clip：
 *   1) 抓若干帧 PNG 写 PREVIEW_OUT；
 *   2) 若设置 PREVIEW_METRICS_DIR，跑 viewer 的 metrics() 写 <clip>.metrics.json。
 */
import { app, BrowserWindow } from 'electron';
import fs from 'node:fs';
import path from 'node:path';

const BASE = process.env.PREVIEW_BASE;
const OUT = process.env.PREVIEW_OUT;
const METRICS_DIR = process.env.PREVIEW_METRICS_DIR ? path.resolve(process.env.PREVIEW_METRICS_DIR) : null;
const VRM = process.env.PREVIEW_VRM || 'assets/vrm/aventurine-waveflair.vrm';
const YAW = process.env.PREVIEW_YAW || '0';
const CLIPS = (process.env.PREVIEW_CLIPS || 'idle').split(',').map((s) => s.trim()).filter(Boolean);
const FRAMES = (process.env.PREVIEW_FRAMES || '0,0.25,0.5,0.75')
  .split(',')
  .map((s) => Number(s))
  .filter((n) => Number.isFinite(n));
/** clip JSON 所在目录（仓库根相对），默认 assets/motions/mate；试跑/试验数据可指向私有目录。 */
const MOTIONS_REL = process.env.PREVIEW_MOTIONS_REL || 'assets/motions/mate';
/** PREVIEW_HANDS=1 时额外抓左右手特写（字段名 -hand-left/-hand-right.png），用于手指验收。 */
const HANDS = process.env.PREVIEW_HANDS === '1';

async function main() {
  if (!BASE || !OUT) throw new Error('missing PREVIEW_BASE / PREVIEW_OUT');
  fs.mkdirSync(OUT, { recursive: true });
  if (METRICS_DIR) fs.mkdirSync(METRICS_DIR, { recursive: true });

  const win = new BrowserWindow({
    width: 600,
    height: 800,
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false
    }
  });
  win.webContents.on('console-message', (_event, level, message) => {
    console.log(`[page:${level}] ${message}`);
  });

  const pageUrl = `${BASE}/scripts/unity-bake/clip-viewer.html?vrm=${encodeURIComponent(VRM)}&yaw=${encodeURIComponent(YAW)}`;
  await win.loadURL(pageUrl);
  const exec = (source) => win.webContents.executeJavaScript(source, true);

  const info = await exec(`(async () => {
    try { return await window.__clipViewer.ready; }
    catch (e) { return { error: String(e && e.stack || e) }; }
  })()`);
  console.log('[preview] model:', JSON.stringify(info));
  if (!info || info.error) throw new Error(`viewer not ready: ${info?.error || 'unknown'}`);

  const results = [];
  const metricsResults = [];
  for (const clipName of CLIPS) {
    const clipUrl = `${MOTIONS_REL}/${clipName}.json`;
    const meta = await exec(`(async () => {
      try { return await window.__clipViewer.loadClip(${JSON.stringify(clipUrl)}); }
      catch (e) { return { error: String(e && e.stack || e) }; }
    })()`);
    console.log('[preview] clip:', clipName, JSON.stringify(meta));
    if (!meta || meta.error) { console.error('[preview] skip', clipName, meta?.error); continue; }

    if (METRICS_DIR) {
      const startedAt = Date.now();
      const metrics = await exec(`(async () => {
        try { return await window.__clipViewer.metrics(); }
        catch (e) { return { error: String(e && e.stack || e) }; }
      })()`);
      if (!metrics || metrics.error) {
        console.error('[preview] metrics FAIL', clipName, metrics?.error);
        metricsResults.push({ clip: clipName, error: metrics?.error ?? 'unknown' });
      } else {
        const payload = {
          generatedAt: new Date().toISOString(),
          clip: clipName,
          vrm: VRM,
          ...metrics
        };
        const file = path.join(METRICS_DIR, `${clipName}.metrics.json`);
        fs.writeFileSync(file, JSON.stringify(payload, null, 2));
        metricsResults.push({ clip: clipName, file, frames: metrics.frames, computationMs: metrics.computationMs });
        console.log(
          `[preview] metrics ${clipName}: ${metrics.frames}f in ${Date.now() - startedAt}ms` +
            ` (groundPen=${metrics.maxGroundPenetration}, footJump=${metrics.footYMaxJump}, ` +
            `loopSeam=${metrics.loopSeamMaxAngleDeg}, kneeFlex=${metrics.kneeFlexMin}–${metrics.kneeFlexMax})`
        );
      }
    }

    for (const frac of FRAMES) {
      const t = Math.max(0, (meta.duration || 1) * frac);
      const dataUrl = await exec(`window.__clipViewer.captureAt(${t})`);
      if (!dataUrl || !dataUrl.startsWith('data:image/png;base64,')) {
        console.error('[preview] bad capture', clipName, frac);
        continue;
      }
      const pct = String(Math.round(frac * 100)).padStart(3, '0');
      const file = path.join(OUT, `${clipName}-${pct}.png`);
      fs.writeFileSync(file, Buffer.from(dataUrl.split(',')[1], 'base64'));
      results.push({ clip: clipName, frac, file });
      if (HANDS) {
        for (const side of ['left', 'right']) {
          const handUrl = await exec(
            `window.__clipViewer.captureHandAt(${t}, ${JSON.stringify(side)})`
          );
          if (handUrl && handUrl.startsWith('data:image/png;base64,')) {
            const handFile = path.join(OUT, `${clipName}-${pct}-hand-${side}.png`);
            fs.writeFileSync(handFile, Buffer.from(handUrl.split(',')[1], 'base64'));
            results.push({ clip: clipName, frac, hand: side, file: handFile });
          }
        }
      }
      const probe = await exec(`window.__clipViewer.probe()`);
      console.log('[preview] probe', clipName, frac, JSON.stringify(probe.posed));
    }
  }

  fs.writeFileSync(
    path.join(OUT, 'preview.json'),
    JSON.stringify({ vrm: VRM, info, results, metrics: metricsResults }, null, 2)
  );
  console.log('[preview] done:', results.length, 'frames ->', OUT);
  if (METRICS_DIR) console.log('[preview] metrics:', metricsResults.length, '->', METRICS_DIR);
  app.exit(0);
}

app.whenReady().then(main).catch((e) => {
  console.error('[preview] FAIL:', e);
  app.exit(1);
});
