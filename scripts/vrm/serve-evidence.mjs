/**
 * W0-4 evidence server — tiny static HTTP server for the canary viewer plus a
 * POST endpoint that lets the page persist capture evidence (PNG/WebM) to
 * tests/tmp/w0-4/.
 *
 * Dev-only tooling: not imported by the app.
 */
import http from 'node:http';
import { createReadStream, mkdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.webm': 'video/webm',
  '.glb': 'model/gltf-binary',
  '.gltf': 'model/gltf+json',
  '.vrm': 'application/octet-stream',
  '.bin': 'application/octet-stream',
  '.wasm': 'application/wasm',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain; charset=utf-8',
};

const STATIC_PREFIXES = ['/node_modules/', '/assets/', '/scripts/', '/tests/tmp/w0-4/'];
const MAX_EVIDENCE_BYTES = 96 * 1024 * 1024;

function sendJson(response, statusCode, payload) {
  const body = JSON.stringify(payload);
  response.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  response.end(body);
}

/**
 * @param {{root: string, evidenceRoot: string, quiet?: boolean}} options
 */
export async function createEvidenceServer({ root, evidenceRoot, quiet = false }) {
  const stats = {
    requests: [],
    failures: [],
    evidenceWrites: [],
  };
  const rootResolved = path.resolve(root);
  const evidenceResolved = path.resolve(evidenceRoot);

  const server = http.createServer((request, response) => {
    try {
      handleRequest(request, response).catch((error) => {
        stats.failures.push({ kind: 'handler', url: request.url, message: String(error) });
        if (!response.headersSent) sendJson(response, 500, { ok: false, error: String(error) });
        else response.destroy(error);
      });
    } catch (error) {
      stats.failures.push({ kind: 'sync-handler', url: request.url, message: String(error) });
      if (!response.headersSent) sendJson(response, 500, { ok: false, error: String(error) });
      else response.destroy(error);
    }
  });

  async function handleRequest(request, response) {
    const url = new URL(request.url || '/', 'http://127.0.0.1');

    if (request.method === 'POST' && url.pathname === '/__evidence') {
      await handleEvidence(request, response, url);
      return;
    }
    if (url.pathname === '/__health') {
      sendJson(response, 200, { ok: true, evidenceRoot: evidenceResolved });
      return;
    }
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      sendJson(response, 405, { ok: false, error: 'method not allowed' });
      return;
    }
    await handleStatic(request, response, url);
  }

  async function handleEvidence(request, response, url) {
    const relativePath = url.searchParams.get('file');
    if (!relativePath) {
      sendJson(response, 400, { ok: false, error: 'missing ?file=' });
      return;
    }
    const target = path.resolve(evidenceResolved, relativePath);
    if (target !== evidenceResolved && !target.startsWith(evidenceResolved + path.sep)) {
      stats.failures.push({ kind: 'evidence-path', file: relativePath, message: 'path escapes evidence root' });
      sendJson(response, 400, { ok: false, error: 'invalid evidence path' });
      return;
    }
    const chunks = [];
    let received = 0;
    for await (const chunk of request) {
      received += chunk.length;
      if (received > MAX_EVIDENCE_BYTES) {
        sendJson(response, 413, { ok: false, error: 'evidence body too large' });
        return;
      }
      chunks.push(chunk);
    }
    const buffer = Buffer.concat(chunks);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, buffer);
    const entry = { file: relativePath, bytes: buffer.length, at: new Date().toISOString() };
    stats.evidenceWrites.push(entry);
    if (!quiet) console.log(`[server] evidence written: ${relativePath} (${buffer.length} bytes)`);
    sendJson(response, 200, { ok: true, ...entry });
  }

  async function handleStatic(request, response, url) {
    const pathname = decodeURIComponent(url.pathname);
    if (!STATIC_PREFIXES.some((prefix) => pathname.startsWith(prefix))) {
      stats.failures.push({ kind: 'static-forbidden', url: pathname, message: 'path prefix not allowed' });
      sendJson(response, 403, { ok: false, error: 'forbidden' });
      return;
    }
    const target = path.resolve(rootResolved, `.${pathname}`);
    if (target !== rootResolved && !target.startsWith(rootResolved + path.sep)) {
      stats.failures.push({ kind: 'static-traversal', url: pathname, message: 'path escapes repo root' });
      sendJson(response, 403, { ok: false, error: 'forbidden' });
      return;
    }
    let fileStat;
    try {
      fileStat = statSync(target);
    } catch {
      stats.failures.push({ kind: 'static-404', url: pathname, message: 'not found' });
      if (!quiet) console.log(`[server] 404 ${pathname}`);
      sendJson(response, 404, { ok: false, error: 'not found', url: pathname });
      return;
    }
    if (!fileStat.isFile()) {
      stats.failures.push({ kind: 'static-not-file', url: pathname, message: 'not a file' });
      sendJson(response, 404, { ok: false, error: 'not found', url: pathname });
      return;
    }
    const extension = path.extname(target).toLowerCase();
    const headers = {
      'Content-Type': MIME_TYPES[extension] || 'application/octet-stream',
      'Content-Length': fileStat.size,
      'Cache-Control': 'no-store',
      'Cross-Origin-Resource-Policy': 'cross-origin',
    };
    stats.requests.push({ url: pathname, bytes: fileStat.size });
    response.writeHead(200, headers);
    if (request.method === 'HEAD') {
      response.end();
      return;
    }
    createReadStream(target).pipe(response);
  }

  const port = await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });

  return {
    port,
    url: `http://127.0.0.1:${port}`,
    stats,
    close: () =>
      new Promise((resolve) => {
        server.close(() => resolve());
      }),
  };
}

/* Manual use: `node scripts/vrm/serve-evidence.mjs [port]` then open
 *   http://127.0.0.1:<port>/scripts/vrm/canary-viewer.html?vrm=<urlencoded assets path>
 * e.g. ...?vrm=assets/vrm/aventurine... and add &forceOpaque=1 to inspect the
 * BLEND/alpha debug view manually. */
const isDirectRun = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectRun) {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
  const port = Number(process.argv[2] || 8080);
  createEvidenceServer({ root: repoRoot, evidenceRoot: path.join(repoRoot, 'tests/tmp/w0-4') })
    .then((server) => {
      console.log(`[serve-evidence] serving ${repoRoot}`);
      console.log(`[serve-evidence] viewer: ${server.url}/scripts/vrm/canary-viewer.html?vrm=assets%2Fvrm%2Fcanary%2F%E7%A0%82%E9%87%91%E7%9F%B3%E5%BF%83%E5%8D%81%E4%BA%BA%E5%85%AC%E5%8F%B8%E5%88%B6%E6%9C%8D(0.x).vrm`);
      console.log('[serve-evidence] Ctrl+C to stop');
    })
    .catch((error) => {
      console.error('[serve-evidence] failed to start', error);
      process.exit(1);
    });
}
