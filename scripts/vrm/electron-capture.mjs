/**
 * W0-4 Electron capture driver (main process).
 *
 * Spawned by scripts/vrm/screenshot.mjs. Opens the canary viewer page in a
 * BrowserWindow, waits for `window.__aventurineViewer.ready`, then drives the
 * page API to capture the fixed views + a 10 s MediaRecorder reel + diagnostics
 * and console logs. Evidence PNG/WebM are POSTed by the page to the local
 * evidence server; diagnostics/console files are written here.
 *
 * Configuration is passed via env (W04_*) so no argv parsing is needed:
 *   W04_URL, W04_TAG, W04_EVIDENCE_DIR, W04_VIEWS, W04_RECORD_MS, W04_TIMEOUT_MS
 */
process.env.ELECTRON_DISABLE_SECURITY_WARNINGS = 'true';

import { app, BrowserWindow, session } from 'electron';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const tag = process.env.W04_TAG || 'canary';
const pageUrl = process.env.W04_URL;
const evidenceRoot = process.env.W04_EVIDENCE_DIR;
const views = (process.env.W04_VIEWS || 'front,side,back').split(',').map((s) => s.trim()).filter(Boolean);
const recordMs = Number(process.env.W04_RECORD_MS || '0');
const timeoutMs = Number(process.env.W04_TIMEOUT_MS || '240000');

if (!pageUrl || !evidenceRoot) {
  console.error('electron-capture: W04_URL and W04_EVIDENCE_DIR are required');
  app.exit(2);
}

const outDir = path.join(evidenceRoot, tag);
const diagnosticsPath = path.join(outDir, 'diagnostics.json');
const consolePath = path.join(outDir, 'console.log');
mkdirSync(outDir, { recursive: true });

const consoleLines = [];
const networkRequests = [];
const networkFailures = [];
const mainErrors = [];
let finished = false;

function log(line) {
  consoleLines.push(line);
  console.log(line);
}

const LEVEL_NAMES = ['verbose', 'info', 'warning', 'error'];

function recordConsoleMessage(...args) {
  const first = args[0];
  let level;
  let message;
  let source = '';
  if (first && typeof first === 'object' && typeof first.message === 'string') {
    // Electron >= 37 style: single event object
    level = String(first.level || 'info');
    message = first.message;
    source = `${first.sourceId || ''}:${first.lineNumber || 0}`;
  } else {
    // Legacy positional style: (event, level, message, line, sourceId)
    const numeric = args[1];
    level = LEVEL_NAMES[numeric] || String(numeric);
    message = args[2];
    source = `${args[4] || ''}:${args[3] || 0}`;
  }
  log(`[renderer:${level}] ${message}${source ? `  (${source})` : ''}`);
}

function writeErrorDiagnostics(error, extra = {}) {
  const payload = {
    tag,
    ok: false,
    error: String(error?.stack || error),
    pageUrl,
    generatedAt: new Date().toISOString(),
    main: {
      errors: mainErrors,
      network: { requestCount: networkRequests.length, failures: networkFailures },
      ...extra,
    },
  };
  writeFileSync(diagnosticsPath, `${JSON.stringify(payload, null, 2)}\n`);
  writeFileSync(consolePath, `${consoleLines.join('\n')}\n`);
}

function finish(code, summary) {
  if (finished) return;
  finished = true;
  try {
    if (summary) {
      writeFileSync(diagnosticsPath, `${JSON.stringify(summary, null, 2)}\n`);
    }
    writeFileSync(consolePath, `${consoleLines.join('\n')}\n`);
  } catch (error) {
    console.error('electron-capture: failed writing evidence files', error);
  }
  console.log(`CAPTURE_RESULT ${JSON.stringify({ ok: code === 0, tag, code, ...(summary?.main?.capture || {}) })}`);
  app.exit(code);
}

function countConsoleErrors() {
  return consoleLines.filter((line) => line.startsWith('[renderer:error]')).length;
}

async function run() {
  await app.whenReady();

  session.defaultSession.webRequest.onCompleted((details) => {
    if (!/^https?:/i.test(details.url)) return;
    networkRequests.push({ url: details.url, statusCode: details.statusCode, resourceType: details.resourceType });
    if (details.statusCode >= 400) {
      networkFailures.push({
        kind: 'http',
        url: details.url,
        statusCode: details.statusCode,
        resourceType: details.resourceType,
        method: details.method,
      });
      log(`[network-failure] ${details.statusCode} ${details.method || 'GET'} ${details.url} (${details.resourceType})`);
    }
  });
  session.defaultSession.webRequest.onErrorOccurred((details) => {
    if (!/^https?:/i.test(details.url)) return;
    networkFailures.push({ kind: 'net-error', url: details.url, error: details.error, resourceType: details.resourceType });
    log(`[network-failure] ${details.error} ${details.url} (${details.resourceType})`);
  });

  const win = new BrowserWindow({
    show: false,
    useContentSize: true,
    width: 720,
    height: 960,
    backgroundColor: '#00000000',
    webPreferences: {
      backgroundThrottling: false,
      nodeIntegration: false,
      contextIsolation: true,
      offscreen: false,
      devTools: false,
      spellcheck: false,
    },
  });
  win.setMenuBarVisibility(false);

  win.webContents.on('console-message', recordConsoleMessage);
  win.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
    const message = `did-fail-load code=${errorCode} ${errorDescription} url=${validatedURL} mainFrame=${isMainFrame}`;
    mainErrors.push({ kind: 'did-fail-load', message });
    log(`[main:error] ${message}`);
  });
  win.webContents.on('render-process-gone', (_event, details) => {
    const message = `render-process-gone reason=${details.reason} exitCode=${details.exitCode}`;
    mainErrors.push({ kind: 'render-process-gone', message });
    log(`[main:error] ${message}`);
  });
  win.webContents.on('preload-error', (_event, preloadPath, error) => {
    const message = `preload-error ${preloadPath}: ${error?.stack || error}`;
    mainErrors.push({ kind: 'preload-error', message });
    log(`[main:error] ${message}`);
  });
  win.webContents.on('unresponsive', () => {
    mainErrors.push({ kind: 'unresponsive', message: 'renderer unresponsive' });
    log('[main:error] renderer unresponsive');
  });

  log(`[main] tag=${tag}`);
  log(`[main] url=${pageUrl}`);
  log(`[main] views=${views.join(',')} recordMs=${recordMs}`);
  log(`[main] electron=${process.versions.electron} chrome=${process.versions.chrome}`);

  const startedAt = Date.now();
  await win.loadURL(pageUrl);
  log(`[main] page loaded in ${Date.now() - startedAt} ms`);

  const execute = (source) => win.webContents.executeJavaScript(source, true);

  const ready = await execute(`(async () => {
    if (!window.__aventurineViewer) {
      return { ok: false, error: 'window.__aventurineViewer is missing (module script did not run)' };
    }
    try {
      const diagnostics = await window.__aventurineViewer.ready;
      return { ok: true, diagnostics };
    } catch (error) {
      return { ok: false, error: String(error && (error.stack || error.message || error)) };
    }
  })()`);

  if (!ready?.ok) {
    mainErrors.push({ kind: 'viewer-ready', message: ready?.error || 'unknown' });
    log(`[main:error] viewer never became ready: ${ready?.error || 'unknown'}`);
    writeErrorDiagnostics(new Error(ready?.error || 'viewer not ready'));
    finish(2);
    return;
  }
  log(`[main] viewer ready: model=${ready.diagnostics?.model?.fileName} bones=${ready.diagnostics?.model?.humanoid?.normalizedBoneCount} expressions=${ready.diagnostics?.model?.expressions?.count}`);

  const captures = [];
  for (const view of views) {
    const relativePath = `${tag}/${view}.png`;
    const result = await execute(
      `window.__aventurineViewer.captureAndPost(${JSON.stringify(relativePath)}, ${JSON.stringify(view)})`,
    );
    captures.push(result);
    log(`[main] captured ${view} -> ${relativePath} (${result?.bytes} bytes, ${result?.width}x${result?.height})`);
  }

  // W0 extra evidence: force-opaque comparison for the BLEND-mislabelled
  // materials (see canary-viewer.js setForceOpaque).
  let forceOpaque = null;
  try {
    const stats = await execute('window.__aventurineViewer.setForceOpaque(true)');
    const capture = await execute(
      `window.__aventurineViewer.captureAndPost(${JSON.stringify(`${tag}/front-force-opaque.png`)}, 'front')`,
    );
    await execute('window.__aventurineViewer.setForceOpaque(false)');
    forceOpaque = { stats, capture };
    log(
      `[main] force-opaque -> ${capture?.file} (changed ${stats?.changed?.length ?? '?'} materials, ` +
        `kept transparent ${stats?.keptTransparent?.length ?? '?'})`,
    );
  } catch (error) {
    mainErrors.push({ kind: 'force-opaque', message: String(error?.stack || error) });
    log(`[main:error] force-opaque capture failed: ${error?.stack || error}`);
  }

  let recording = null;
  if (recordMs > 0) {
    const relativePath = `${tag}/recording.webm`;
    try {
      recording = await execute(
        `window.__aventurineViewer.recordAndPost(${JSON.stringify(relativePath)}, ${recordMs}, 'front')`,
      );
      log(`[main] recording -> ${relativePath} (${recording?.sizeBytes} bytes, ${recording?.durationMs} ms, ${recording?.frames} frames)`);
    } catch (error) {
      mainErrors.push({ kind: 'recording', message: String(error?.stack || error) });
      log(`[main:error] recording failed: ${error?.stack || error}`);
    }
  }

  let motionPair = null;
  try {
    motionPair = await execute(
      `window.__aventurineViewer.captureMotionPair(${JSON.stringify(`${tag}/motion`)}, 2400)`,
    );
    log(
      `[main] motion pair -> ${motionPair?.firstFile} / ${motionPair?.secondFile} ` +
        `(${motionPair?.actualIntervalMs} ms, max bone delta ${motionPair?.maxBoneAngleDeltaDeg} deg on ${motionPair?.maxBone})`,
    );
  } catch (error) {
    mainErrors.push({ kind: 'motion-pair', message: String(error?.stack || error) });
    log(`[main:error] motion pair failed: ${error?.stack || error}`);
  }

  const diagnostics = await execute('window.__aventurineViewer.diagnostics()');
  const pageLogs = await execute('window.__aventurineViewer.collectLogs()');
  const state = await execute('window.__aventurineViewer.getState()');

  for (const entry of pageLogs?.consoleLogs || []) {
    // Console messages are already captured by the webContents listener; keep
    // the page-side buffer only for levels the listener may have missed.
    if (entry.level === 'error') continue;
    log(`[page:${entry.level}] ${entry.message}`);
  }
  const pageErrors = pageLogs?.pageErrors || [];
  for (const entry of pageErrors) {
    log(`[pageerror] ${entry.kind}: ${entry.message}`);
  }
  for (const entry of pageLogs?.loadErrors || []) {
    log(`[page:load-error] ${JSON.stringify(entry)}`);
  }
  for (const entry of pageLogs?.warnings || []) {
    log(`[page:warning] ${entry}`);
  }

  const summary = {
    ...diagnostics,
    main: {
      tag,
      pageUrl,
      electron: process.versions.electron,
      chrome: process.versions.chrome,
      node: process.versions.node,
      loadMs: Date.now() - startedAt,
      captures,
      forceOpaque,
      recording,
      motionPair,
      state,
      errors: mainErrors,
      network: {
        requestCount: networkRequests.length,
        failures: networkFailures,
        requests: networkRequests,
      },
      pageErrors,
      pageLoadErrors: pageLogs?.loadErrors || [],
      pageWarnings: pageLogs?.warnings || [],
      consoleErrorCount: countConsoleErrors(),
      consoleErrorLines: consoleLines.filter((line) => line.startsWith('[renderer:error]')),
      consoleLogPath: consolePath,
      diagnosticsPath,
    },
  };
  finish(0, summary);
}

const timeout = setTimeout(() => {
  if (finished) return;
  mainErrors.push({ kind: 'timeout', message: `capture timed out after ${timeoutMs} ms` });
  log(`[main:error] capture timed out after ${timeoutMs} ms`);
  writeErrorDiagnostics(new Error(`capture timed out after ${timeoutMs} ms`));
  finish(3);
}, timeoutMs);

run()
  .catch((error) => {
    mainErrors.push({ kind: 'fatal', message: String(error?.stack || error) });
    console.error('electron-capture fatal:', error);
    log(`[main:error] fatal: ${error?.stack || error}`);
    writeErrorDiagnostics(error);
    finish(4);
  })
  .finally(() => clearTimeout(timeout));
