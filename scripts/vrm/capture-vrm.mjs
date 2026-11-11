#!/usr/bin/env node
/**
 * V2 evidence capture — generic VRM load / fixed-view screenshot / diagnostics tool.
 *
 * W0-4 的 `screenshot.mjs` 是「canary + aventurine 两个固定模型 + 严格 per-model 期望」
 * 的专用验收脚本；本工具是它的**通用版**：任意 `--vrm` 路径都能跑，只做与模型无关的
 * 通用校验（加载成功、fileName 匹配、humanoid 骨数 > 0、视图 PNG 尺寸正确且非全透明）。
 *
 *   node scripts/vrm/capture-vrm.mjs \
 *     --vrm assets/vrm/aventurine-tpose.vrm \
 *     --tag tpose \
 *     --views front,side,threeQuarter \
 *     --record-ms 6000
 *
 * 实现要点（复用 W0-4 现有工具，不重复造轮子）：
 *   1. `serve-evidence.mjs` 起本地静态服务器（服务仓库根：node_modules/、assets/、
 *      scripts/），页面截图像素经 POST /__evidence 写进 `--out`；
 *   2. `electron-capture.mjs` 在 Electron 里打开
 *      `scripts/vrm/canary-viewer.html?vrm=<相对仓库根路径>`，驱动查看器 API 抓
 *      `front/side/threeQuarter/back` 固定视图 + motion pair + force-opaque 对照，
 *      并写 `diagnostics.json` / `console.log`；
 *   3. 本脚本收集子进程退出码，用 sharp 做像素统计（沿用 screenshot.mjs 的口径），
 *      写 `<out>/<tag>/run-summary.json` 并合并到 `<out>/run-summary.json`。
 *
 * `--check`：不启动 Electron/服务器，只校验已有产物（幂等，适合 CI）；不写任何文件。
 *
 * 产物布局（`--out` 默认 `tests/tmp/v2-evidence`，已 gitignore）：
 *   <out>/<tag>/
 *     front.png / side.png / threeQuarter.png / back.png（按 --views）
 *     front-force-opaque.png / motion-a.png / motion-b.png（electron-capture 附带证据）
 *     recording.webm（仅在 --record-ms > 0 时）
 *     diagnostics.json / console.log / run-summary.json
 *   <out>/run-summary.json（多次运行的合并总览）
 *
 * 边界：只读仓库内 VRM 资产（serve-evidence 只允许 /assets/、/scripts/ 等前缀），
 * 不复制、不改动 assets/**；dev-only 工具，不进入 app bundle。
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { createEvidenceServer } from './serve-evidence.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DEFAULT_OUT = 'tests/tmp/v2-evidence';
const ELECTRON_BIN = path.join(ROOT, 'node_modules/.bin/electron');
const CAPTURE_ENTRY = path.join(ROOT, 'scripts/vrm/electron-capture.mjs');
const VIEW_NAMES = ['front', 'side', 'threeQuarter', 'back'];
const DEFAULT_VIEWS = ['front', 'side', 'threeQuarter'];
// serve-evidence.mjs 的 STATIC_PREFIXES：VRM 必须以这些前缀之一对外暴露，否则页面 403。
const SERVED_PREFIXES = ['assets/', 'scripts/', 'tests/tmp/w0-4/'];
const ELECTRON_TIMEOUT_MS = 300_000;
const SPAWN_WATCHDOG_MS = 330_000;
const LOCK_FILE = '.capture-vrm.lock';

/* -------------------------------------------------------------------------- */
/* CLI                                                                        */
/* -------------------------------------------------------------------------- */

function usage() {
  return [
    'Usage:',
    '  node scripts/vrm/capture-vrm.mjs --vrm <path> [options]',
    '',
    'Required:',
    '  --vrm <path>           VRM file, absolute or relative to the repo root',
    '                         (must live under assets/, scripts/ or tests/tmp/w0-4/)',
    '',
    'Options:',
    `  --tag <name>           evidence subdir / file prefix (default: derived from --vrm)`,
    `  --views <list>         comma separated, from ${VIEW_NAMES.join('|')}`,
    `                         (default: ${DEFAULT_VIEWS.join(',')})`,
    '  --record-ms <ms>       also record a webm of N ms (default 0 = no recording)',
    `  --out <dir>            evidence root (default: ${DEFAULT_OUT})`,
    '  --check                validate existing evidence only (no Electron, no writes)',
    '  --help, -h             show this message',
    '',
    'Examples:',
    '  node scripts/vrm/capture-vrm.mjs --vrm assets/vrm/aventurine-tpose.vrm \\',
    '    --tag tpose --views front,side,threeQuarter --record-ms 6000',
    '  node scripts/vrm/capture-vrm.mjs --vrm assets/vrm/aventurine-tpose.vrm --tag tpose --check',
  ].join('\n');
}

function readOptionValue(argv, index, name) {
  const arg = argv[index];
  const prefix = `${name}=`;
  if (arg.startsWith(prefix)) return { value: arg.slice(prefix.length), next: index + 1 };
  const next = argv[index + 1];
  if (next == null || next.startsWith('--')) throw new Error(`${name} requires a value`);
  return { value: next, next: index + 2 };
}

function parseArgs(argv) {
  const options = {
    vrm: null,
    tag: null,
    views: [...DEFAULT_VIEWS],
    recordMs: 0,
    recordMsExplicit: false,
    out: DEFAULT_OUT,
    check: false,
    help: false,
  };
  let i = 0;
  while (i < argv.length) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      options.help = true;
      i += 1;
    } else if (arg === '--check') {
      options.check = true;
      i += 1;
    } else if (arg === '--vrm' || arg.startsWith('--vrm=')) {
      const parsed = readOptionValue(argv, i, '--vrm');
      options.vrm = parsed.value;
      i = parsed.next;
    } else if (arg === '--tag' || arg.startsWith('--tag=')) {
      const parsed = readOptionValue(argv, i, '--tag');
      options.tag = parsed.value;
      i = parsed.next;
    } else if (arg === '--views' || arg.startsWith('--views=')) {
      const parsed = readOptionValue(argv, i, '--views');
      options.views = parsed.value.split(',').map((s) => s.trim()).filter(Boolean);
      i = parsed.next;
    } else if (arg === '--record-ms' || arg.startsWith('--record-ms=')) {
      const parsed = readOptionValue(argv, i, '--record-ms');
      options.recordMs = Number(parsed.value);
      options.recordMsExplicit = true;
      i = parsed.next;
    } else if (arg === '--out' || arg.startsWith('--out=')) {
      const parsed = readOptionValue(argv, i, '--out');
      options.out = parsed.value;
      i = parsed.next;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  if (options.help) return options;
  if (!options.vrm) throw new Error('--vrm is required');
  if (!Number.isFinite(options.recordMs) || options.recordMs < 0) throw new Error(`invalid --record-ms: ${options.recordMs}`);
  if (options.views.length === 0) throw new Error('--views is empty');
  const unknown = options.views.filter((view) => !VIEW_NAMES.includes(view));
  if (unknown.length > 0) throw new Error(`unknown view(s): ${unknown.join(',')} (allowed: ${VIEW_NAMES.join(',')})`);
  return options;
}

function deriveTag(vrmRelative) {
  const base = vrmRelative.split('/').pop() || 'vrm';
  const withoutExt = base.replace(/\.[^.]+$/, '');
  const tag = withoutExt.replace(/[\\/\s]+/g, '-').replace(/^[.-]+|[.-]+$/g, '');
  return tag || 'vrm';
}

function normalizeTag(tag) {
  if (!tag || tag === '.' || tag === '..' || /[\\/]/.test(tag)) {
    throw new Error(`invalid --tag: ${JSON.stringify(tag)} (must be a single path segment)`);
  }
  return tag;
}

/* -------------------------------------------------------------------------- */
/* paths                                                                      */
/* -------------------------------------------------------------------------- */

function resolveVrm(vrmArg) {
  const absolute = path.isAbsolute(vrmArg) ? path.resolve(vrmArg) : path.resolve(ROOT, vrmArg);
  if (!existsSync(absolute) || !statSync(absolute).isFile()) throw new Error(`VRM not found: ${vrmArg} -> ${absolute}`);
  const relative = path.relative(ROOT, absolute);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`VRM is outside the repo root, cannot serve it: ${absolute}`);
  }
  const servedPath = relative.split(path.sep).join('/');
  if (!SERVED_PREFIXES.some((prefix) => servedPath.startsWith(prefix))) {
    throw new Error(
      `VRM path ${servedPath} is not served by serve-evidence.mjs ` +
        `(allowed prefixes: ${SERVED_PREFIXES.join(', ')})`,
    );
  }
  return { absolute, servedPath, fileName: path.basename(absolute) };
}

function resolveOut(outArg) {
  return path.isAbsolute(outArg) ? path.resolve(outArg) : path.resolve(ROOT, outArg);
}

/* -------------------------------------------------------------------------- */
/* electron capture driver                                                    */
/* -------------------------------------------------------------------------- */

function runElectronCapture({ pageUrl, tag, views, recordMs, evidenceRoot }) {
  const env = { ...process.env };
  // 本会话可能导出 ELECTRON_RUN_AS_NODE（DSH）；capture 必须以 Electron 主进程跑。
  delete env.ELECTRON_RUN_AS_NODE;
  env.W04_URL = pageUrl;
  env.W04_TAG = tag;
  env.W04_EVIDENCE_DIR = evidenceRoot;
  env.W04_VIEWS = views.join(',');
  env.W04_RECORD_MS = String(recordMs);
  env.W04_TIMEOUT_MS = String(ELECTRON_TIMEOUT_MS);

  return new Promise((resolve) => {
    const child = spawn(ELECTRON_BIN, [CAPTURE_ENTRY], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let killed = false;
    const watchdog = setTimeout(() => {
      killed = true;
      child.kill('SIGKILL');
    }, SPAWN_WATCHDOG_MS);
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      process.stdout.write(chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
      process.stderr.write(chunk);
    });
    child.on('close', (code) => {
      clearTimeout(watchdog);
      resolve({ code, killed, stdout, stderr });
    });
    child.on('error', (error) => {
      clearTimeout(watchdog);
      resolve({ code: -1, killed, stdout, stderr: `${stderr}\nspawn error: ${error?.stack || error}` });
    });
  });
}

/* -------------------------------------------------------------------------- */
/* pixel helpers (same metrics as screenshot.mjs)                             */
/* -------------------------------------------------------------------------- */

async function inspectPng(filePath, evidenceRoot) {
  const image = sharp(filePath);
  const metadata = await image.metadata();
  const { data, info } = await image.ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const { width, height, channels } = info;
  const total = width * height;
  let nonTransparent = 0;
  let sumLumNonTransparent = 0;
  for (let i = 0; i < data.length; i += channels) {
    const a = data[i + 3];
    if (a > 16) {
      nonTransparent += 1;
      sumLumNonTransparent += 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2];
    }
  }
  return {
    file: path.relative(evidenceRoot, filePath).split(path.sep).join('/'),
    width,
    height,
    channels,
    hasAlpha: metadata.hasAlpha,
    bytes: statSync(filePath).size,
    totalPixels: total,
    nonTransparentPixels: nonTransparent,
    nonTransparentRatio: Number((nonTransparent / total).toFixed(4)),
    meanLuminanceNonTransparent: Number((sumLumNonTransparent / Math.max(1, nonTransparent)).toFixed(2)),
  };
}

function inspectWebm(filePath, evidenceRoot) {
  const buffer = readFileSync(filePath);
  const magic = buffer.subarray(0, 4);
  return {
    file: path.relative(evidenceRoot, filePath).split(path.sep).join('/'),
    bytes: buffer.length,
    ebmlHeaderOk: magic[0] === 0x1a && magic[1] === 0x45 && magic[2] === 0xdf && magic[3] === 0xa3,
    magicHex: magic.toString('hex'),
  };
}

function readJsonIfPresent(filePath) {
  try {
    return JSON.parse(readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

/* -------------------------------------------------------------------------- */
/* GLB / VRM extension inspection (authoritative asset-side numbers)          */
/* -------------------------------------------------------------------------- */

/**
 * Read the JSON chunk of a GLB container (VRM is a GLB with `VRMC_vrm` / `VRM`
 * extensions). The viewer diagnostics only expose a subset of asset properties,
 * so for the V2 report we additionally measure the asset itself — same generic
 * code path for VRM 0.x and VRM 1.0, no per-model expectations.
 */
function readGlbJson(filePath) {
  const buffer = readFileSync(filePath);
  if (buffer.length < 20) throw new Error('file is too small to be a GLB');
  const magic = buffer.readUInt32LE(0);
  if (magic !== 0x46546c67) throw new Error(`bad GLB magic 0x${magic.toString(16)}`);
  const version = buffer.readUInt32LE(4);
  const declaredLength = buffer.readUInt32LE(8);
  let offset = 12;
  while (offset + 8 <= Math.min(declaredLength, buffer.length)) {
    const chunkLength = buffer.readUInt32LE(offset);
    const chunkType = buffer.readUInt32LE(offset + 4);
    offset += 8;
    if (chunkType === 0x4e4f534a) {
      // JSON chunk
      return { json: JSON.parse(buffer.subarray(offset, offset + chunkLength).toString('utf8')), version, fileBytes: buffer.length };
    }
    offset += chunkLength;
  }
  throw new Error('GLB JSON chunk not found');
}

function inspectVrmGlb(filePath) {
  try {
    const { json, version: glbVersion, fileBytes } = readGlbJson(filePath);
    const extensions = json.extensions || {};
    const vrm1 = extensions.VRMC_vrm || null;
    const vrm0 = extensions.VRM || null;
    const accessors = json.accessors || [];
    const countAccessor = (index) => (Number.isInteger(index) && accessors[index] ? accessors[index].count ?? 0 : 0);

    let primitives = 0;
    let vertexCountSum = 0;
    let triangleCountSum = 0;
    for (const mesh of json.meshes || []) {
      for (const primitive of mesh.primitives || []) {
        primitives += 1;
        const positionAccessor = primitive.attributes?.POSITION;
        vertexCountSum += countAccessor(positionAccessor);
        const indexAccessor = primitive.indices;
        if (Number.isInteger(indexAccessor)) triangleCountSum += Math.floor(countAccessor(indexAccessor) / 3);
        else triangleCountSum += Math.floor(countAccessor(positionAccessor) / 3);
      }
    }

    const alphaModeCounts = {};
    let mtoonMaterialCount = 0;
    for (const material of json.materials || []) {
      const mode = material.alphaMode || 'OPAQUE';
      alphaModeCounts[mode] = (alphaModeCounts[mode] || 0) + 1;
      if (material.extensions?.VRMC_materials_mtoon) mtoonMaterialCount += 1;
    }

    let humanoidBoneCount = null;
    let expressionCount = null;
    let springBone = null;
    let metaTitle = null;
    let specVersion = null;
    if (vrm1) {
      specVersion = vrm1.specVersion ?? '1.0';
      humanoidBoneCount = Object.keys(vrm1.humanoid?.humanBones || {}).length;
      const preset = Object.keys(vrm1.expressions?.preset || {}).length;
      const custom = Object.keys(vrm1.expressions?.custom || {}).length;
      expressionCount = preset + custom;
      metaTitle = vrm1.meta?.name ?? null;
      const spring = extensions.VRMC_springBone || null;
      springBone = spring
        ? {
            chainCount: (spring.springs || []).length,
            jointCount: (spring.springs || []).reduce((sum, chain) => sum + (chain.joints || []).length, 0),
            colliderGroupCount: (spring.colliderGroups || []).length,
            colliderCount: (spring.colliderGroups || []).reduce((sum, group) => sum + (group.colliders || []).length, 0),
          }
        : { chainCount: 0, jointCount: 0, colliderGroupCount: 0, colliderCount: 0 };
    } else if (vrm0) {
      specVersion = '0.x';
      humanoidBoneCount = (vrm0.humanoid?.humanBones || []).length;
      expressionCount = (vrm0.blendShapeMaster?.blendShapeGroups || []).length;
      metaTitle = vrm0.meta?.title ?? null;
      mtoonMaterialCount = (vrm0.materialProperties || []).filter((entry) => (entry.shader || '').includes('MToon')).length;
      springBone = {
        chainCount: (vrm0.secondaryAnimation?.boneGroups || []).length,
        jointCount: (vrm0.secondaryAnimation?.boneGroups || []).reduce((sum, group) => sum + (group.bones || []).length, 0),
        colliderGroupCount: (vrm0.secondaryAnimation?.colliderGroups || []).length,
        colliderCount: (vrm0.secondaryAnimation?.colliderGroups || []).reduce(
          (sum, group) => sum + (group.colliders || []).length,
          0,
        ),
      };
    }

    return {
      ok: true,
      file: path.relative(ROOT, filePath).split(path.sep).join('/'),
      fileBytes,
      glbVersion,
      asset: json.asset ?? null,
      specVersion,
      metaTitle,
      generator: json.asset?.generator ?? null,
      humanoidBoneCount,
      expressionCount,
      springBone,
      mesh: {
        meshes: (json.meshes || []).length,
        primitives,
        vertexCountSum,
        triangleCountSum,
        note: 'vertexCountSum sums POSITION accessor counts per primitive (split vertices counted per primitive)',
      },
      materials: { count: (json.materials || []).length, mtoon: mtoonMaterialCount, alphaModeCounts },
      textures: (json.textures || []).length,
      images: (json.images || []).length,
      nodes: (json.nodes || []).length,
      skins: (json.skins || []).length,
      embeddedAnimations: (json.animations || []).length,
    };
  } catch (error) {
    return { ok: false, error: String(error?.message || error) };
  }
}

/** Cross-check viewer-side diagnostics against the asset-side GLB numbers (warn only — no per-model expectations). */
function crossCheckGlb(glb, diagnostics, checks) {
  if (!glb?.ok) {
    checks.warn.push(`GLB inspection failed: ${glb?.error ?? 'unknown'}`);
    return;
  }
  if (glb.humanoidBoneCount != null && diagnostics?.model?.humanoid?.normalizedBoneCount !== glb.humanoidBoneCount) {
    checks.warn.push(
      `humanoid bone count differs: viewer normalized=${diagnostics?.model?.humanoid?.normalizedBoneCount} ` +
        `vs GLB humanBones=${glb.humanoidBoneCount}`,
    );
  }
  if (glb.mesh.triangleCountSum > 0) {
    const rendered = diagnostics?.runtime?.rendererInfo?.triangles;
    if (rendered != null && rendered !== glb.mesh.triangleCountSum) {
      checks.warn.push(`rendered triangles ${rendered} != GLB triangle sum ${glb.mesh.triangleCountSum} (outline/multi-pass?)`);
    }
  }
  if (glb.springBone && glb.springBone.chainCount > 0) {
    const viewerSpring = diagnostics?.model?.springBone || null;
    if (viewerSpring && viewerSpring.chainCount !== glb.springBone.chainCount) {
      checks.warn.push(
        `viewer springBone chainCount=${viewerSpring.chainCount} vs GLB chains=${glb.springBone.chainCount} ` +
          `(three-vrm manager API only exposes joints=${viewerSpring.jointCount}; GLB joints=${glb.springBone.jointCount})`,
      );
    }
  }
}

function printGlbSummary(glb) {
  if (!glb?.ok) {
    console.log(`[glb] inspection failed: ${glb?.error ?? 'unknown'}`);
    return;
  }
  const spring = glb.springBone
    ? `${glb.springBone.chainCount} chains / ${glb.springBone.jointCount} joints / ${glb.springBone.colliderCount} colliders`
    : 'n/a';
  console.log(
    `[glb] spec=${glb.specVersion ?? '?'} generator=${glb.generator ?? '?'} bytes=${glb.fileBytes} ` +
      `humanBones=${glb.humanoidBoneCount ?? '?'} exprs=${glb.expressionCount ?? '?'} springBone=${spring} ` +
      `verts=${glb.mesh.vertexCountSum} tris=${glb.mesh.triangleCountSum} materials=${glb.materials.count} ` +
      `(mtoon=${glb.materials.mtoon}) textures=${glb.textures} images=${glb.images}`,
  );
}

function writeJson(filePath, payload) {
  writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`);
}

/* -------------------------------------------------------------------------- */
/* validation (generic — no per-model expectations)                           */
/* -------------------------------------------------------------------------- */

async function validateArtifacts({ evidenceDir, evidenceRoot, expectedFileName, views, recordMs, electronExitCode, requireRecording }) {
  const checks = { pass: [], fail: [], warn: [] };
  const ok = (message) => checks.pass.push(message);
  const warn = (message) => checks.warn.push(message);
  const fail = (message) => checks.fail.push(message);

  const diagnosticsPath = path.join(evidenceDir, 'diagnostics.json');
  const consolePath = path.join(evidenceDir, 'console.log');
  const diagnostics = readJsonIfPresent(diagnosticsPath);

  if (electronExitCode != null) {
    if (electronExitCode === 0) ok(`electron-capture exited 0`);
    else fail(`electron-capture exited with code ${electronExitCode}`);
  }
  if (!diagnostics) fail(`missing/unparsable ${path.relative(ROOT, diagnosticsPath)}`);
  if (!existsSync(consolePath)) fail(`missing ${path.relative(ROOT, consolePath)}`);

  const model = diagnostics?.model || null;
  const main = diagnostics?.main || null;
  const pixels = [];

  if (diagnostics && !main) fail('diagnostics.main missing (capture did not finish cleanly)');
  if (main) {
    const mainErrors = main.errors || [];
    if (mainErrors.length > 0) fail(`main process errors: ${mainErrors.map((e) => e.message).join(' | ')}`);
    else ok('no Electron main-process errors');
    const pageErrors = main.pageErrors || [];
    if (pageErrors.length > 0) fail(`${pageErrors.length} pageerror(s): ${pageErrors.map((e) => `${e.kind}:${e.message}`).join(' | ')}`);
    else ok('no renderer page errors');
    const networkFailures = main.network?.failures || [];
    if (networkFailures.length > 0) {
      fail(`${networkFailures.length} network failure(s): ${networkFailures.map((n) => `${n.statusCode ?? n.error} ${n.url}`).join(' | ')}`);
    } else ok('no network failures');
    if ((main.consoleErrorCount ?? 0) > 0) {
      fail(`${main.consoleErrorCount} renderer console error line(s): ${(main.consoleErrorLines || []).slice(0, 5).join(' | ')}`);
    } else ok('no renderer console errors');
  }

  // ready 成功 + fileName 匹配（viewport 尺寸也从这里取）
  const expectedCanvas = diagnostics?.viewer?.canvas || { width: 720, height: 960 };
  if (diagnostics) {
    if (model?.fileName === expectedFileName) ok(`model.fileName matches (${expectedFileName})`);
    else fail(`model.fileName mismatch: diagnostics=${JSON.stringify(model?.fileName)} expected=${JSON.stringify(expectedFileName)}`);
    if (model?.specVersion) ok(`VRM specVersion=${model.specVersion}`);
    else warn('model.specVersion missing');
    const boneCount = model?.humanoid?.normalizedBoneCount;
    if (typeof boneCount === 'number' && boneCount > 0) ok(`humanoid normalizedBoneCount=${boneCount} > 0`);
    else fail(`humanoid normalizedBoneCount invalid: ${JSON.stringify(boneCount)}`);
    const missingRequired = model?.humanoid?.missingRequiredBones || [];
    if (missingRequired.length === 0) ok('all required humanoid bones present');
    else fail(`missing required humanoid bones: ${missingRequired.join(',')}`);
    const height = model?.heightMeters;
    if (typeof height === 'number' && height > 0.3 && height < 3) ok(`heightMeters=${height}`);
    else warn(`heightMeters implausible: ${JSON.stringify(height)}`);
    const expressionCount = model?.expressions?.count ?? 0;
    if (expressionCount > 0) ok(`expressions=${expressionCount}`);
    else warn('expression count is 0 (model has no expressions)');
    if (model?.facing?.conclusion) ok(`facing=${model.facing.conclusion}`);
    else warn('facing heuristic produced no conclusion');
  }

  // 视图 PNG：存在、尺寸正确、非全透明
  for (const view of views) {
    const filePath = path.join(evidenceDir, `${view}.png`);
    if (!existsSync(filePath)) {
      fail(`missing ${view}.png`);
      continue;
    }
    const metrics = await inspectPng(filePath, evidenceRoot);
    pixels.push(metrics);
    if (metrics.width !== expectedCanvas.width || metrics.height !== expectedCanvas.height) {
      fail(`${view}.png size ${metrics.width}x${metrics.height} != expected ${expectedCanvas.width}x${expectedCanvas.height}`);
    }
    if (metrics.nonTransparentRatio < 0.02) fail(`${view}.png is fully transparent (nonTransparentRatio=${metrics.nonTransparentRatio})`);
    else ok(`${view}.png ${metrics.width}x${metrics.height} nonTransparentRatio=${metrics.nonTransparentRatio}`);
    if (metrics.meanLuminanceNonTransparent < 10) {
      fail(`${view}.png too dark (mean luminance ${metrics.meanLuminanceNonTransparent})`);
    }
    if (metrics.nonTransparentRatio < 0.05) warn(`${view}.png covers <5% of the frame (${metrics.nonTransparentRatio})`);
    if (metrics.nonTransparentRatio > 0.95) warn(`${view}.png covers >95% of the frame (${metrics.nonTransparentRatio})`);
  }

  // 附带证据（electron-capture 固定产出）：motion pair / force-opaque
  if (main?.motionPair) ok(`motion pair captured (max bone delta ${main.motionPair.maxBoneAngleDeltaDeg} deg)`);
  else warn('no motion pair evidence (viewer idle animation may be absent)');
  if (existsSync(path.join(evidenceDir, 'front-force-opaque.png'))) ok('force-opaque comparison captured');
  else warn('no front-force-opaque.png');

  // 录屏：run 模式按 CLI 期望，check 模式按 argparse 显式值或已存在产物
  let recording = null;
  const wantsRecording = requireRecording || (recordMs > 0 && recordMs != null);
  const webmPath = path.join(evidenceDir, 'recording.webm');
  if (wantsRecording) {
    if (!existsSync(webmPath)) {
      fail(`missing recording.webm (expected --record-ms ${recordMs})`);
    } else {
      recording = { ...inspectWebm(webmPath, evidenceRoot), durationMs: main?.recording?.durationMs ?? null, frames: main?.recording?.frames ?? null };
      if (!recording.ebmlHeaderOk) fail('recording.webm does not start with an EBML header');
      if (recording.bytes < 50_000) fail(`recording.webm suspiciously small (${recording.bytes} bytes)`);
      const expectedDuration = recordMs > 0 ? recordMs : null;
      if (recording.durationMs == null) warn('recording duration missing from diagnostics');
      else if (expectedDuration != null && Math.abs(recording.durationMs - expectedDuration) > expectedDuration * 0.3) {
        fail(`recording duration ${recording.durationMs} ms not ~${expectedDuration} ms`);
      } else ok(`recording.webm ${recording.bytes} bytes, ${recording.durationMs} ms, ${recording.frames} frames`);
    }
  } else if (existsSync(webmPath)) {
    recording = { ...inspectWebm(webmPath, evidenceRoot), durationMs: main?.recording?.durationMs ?? null, frames: main?.recording?.frames ?? null };
    ok(`recording.webm present (${recording.durationMs ?? '?'} ms) — not required by this invocation`);
  }

  return { ok: checks.fail.length === 0, checks, pixels, recording, diagnostics, diagnosticsPath, consolePath };
}

function summarizeDiagnostics(diagnostics) {
  const model = diagnostics?.model;
  if (!model) return null;
  return {
    fileName: model.fileName,
    specVersion: model.specVersion,
    meta: model.meta,
    heightMeters: model.heightMeters,
    bbox: model.bbox,
    humanoid: {
      normalizedBoneCount: model.humanoid?.normalizedBoneCount,
      rawBoneCount: model.humanoid?.rawBoneCount,
      missingRequiredBones: model.humanoid?.missingRequiredBones,
      autoUpdateHumanBones: model.humanoid?.autoUpdateHumanBones,
    },
    expressions: { count: model.expressions?.count, names: model.expressions?.names },
    materials: model.materials,
    textures: model.textures
      ? { total: model.textures.total, images: model.textures.images, failed: model.textures.failed }
      : null,
    springBone: model.springBone,
    lookAt: model.lookAt,
    firstPerson: model.firstPerson,
    facing: model.facing,
    embeddedAnimations: model.embeddedAnimations,
    gltfCounts: model.gltfSource?.counts ?? null,
    gltfMaterialExtensions: model.gltfSource?.materialExtensions ?? null,
    idleAnimation: diagnostics.idleAnimation,
    expressionRuntime: diagnostics.expressionRuntime,
    viewer: diagnostics.viewer ? { three: diagnostics.viewer.three, threeVrm: diagnostics.viewer.threeVrm, renderer: diagnostics.viewer.renderer } : null,
    loadDurationMs: model.loadDurationMs,
    electron: diagnostics.main ? { electron: diagnostics.main.electron, chrome: diagnostics.main.chrome, node: diagnostics.main.node, loadMs: diagnostics.main.loadMs } : null,
    motionPair: diagnostics.main?.motionPair
      ? {
          maxBoneAngleDeltaDeg: diagnostics.main.motionPair.maxBoneAngleDeltaDeg,
          maxBone: diagnostics.main.motionPair.maxBone,
          actualIntervalMs: diagnostics.main.motionPair.actualIntervalMs,
        }
      : null,
  };
}

/* -------------------------------------------------------------------------- */
/* run-summary aggregation                                                    */
/* -------------------------------------------------------------------------- */

function mergeRunSummary(evidenceRoot, run) {
  const summaryPath = path.join(evidenceRoot, 'run-summary.json');
  const previous = readJsonIfPresent(summaryPath);
  const runs = Array.isArray(previous?.runs) ? previous.runs.filter((entry) => entry.tag !== run.tag) : [];
  runs.push(run);
  writeJson(summaryPath, {
    generatedAt: new Date().toISOString(),
    repoRoot: ROOT,
    evidenceRoot,
    runs,
  });
  return summaryPath;
}

function printResult(result, evidenceDir) {
  for (const message of result.checks.pass) console.log(`[check:ok] ${message}`);
  for (const message of result.checks.warn) console.log(`[check:warn] ${message}`);
  for (const message of result.checks.fail) console.log(`[check:fail] ${message}`);
  for (const pixel of result.pixels) {
    console.log(
      `[pixel] ${pixel.file}: ${pixel.width}x${pixel.height} ` +
        `nonTransparent=${pixel.nonTransparentRatio} meanLum(alpha)=${pixel.meanLuminanceNonTransparent} bytes=${pixel.bytes}`,
    );
  }
  console.log(`[evidence] ${path.relative(ROOT, evidenceDir) || evidenceDir}`);
}

/* -------------------------------------------------------------------------- */
/* --check mode                                                               */
/* -------------------------------------------------------------------------- */

async function runCheck(options, vrm, evidenceDir, evidenceRoot) {
  console.log(`[check] tag=${options.tag} evidence=${path.relative(ROOT, evidenceDir)}`);
  const glb = inspectVrmGlb(vrm.absolute);
  const result = await validateArtifacts({
    evidenceDir,
    evidenceRoot,
    expectedFileName: vrm.fileName,
    views: options.views,
    recordMs: options.recordMs,
    requireRecording: options.recordMsExplicit && options.recordMs > 0,
  });
  crossCheckGlb(glb, result.diagnostics, result.checks);
  printResult(result, evidenceDir);
  printGlbSummary(glb);
  const summary = summarizeDiagnostics(result.diagnostics);
  if (summary) {
    console.log(
      `[summary] spec=${summary.specVersion ?? '?'} bones=${summary.humanoid?.normalizedBoneCount ?? '?'} ` +
        `exprs=${summary.expressions?.count ?? '?'} springChains=${summary.springBone?.chainCount ?? '?'} ` +
        `springJoints=${summary.springBone?.jointCount ?? '?'} mtoon=${summary.materials?.mtoon ?? '?'} ` +
        `gltfTex=${summary.gltfCounts?.textures ?? '?'} h=${summary.heightMeters ?? '?'} facing=${summary.facing?.conclusion ?? '?'}`,
    );
  }
  const status = result.ok ? 'PASS' : 'FAIL';
  console.log(`CHECK ${status}  tag=${options.tag} (existing evidence only, nothing written)`);
  return result.ok ? 0 : 1;
}

/* -------------------------------------------------------------------------- */
/* lock (one Electron capture at a time)                                      */
/* -------------------------------------------------------------------------- */

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function acquireLock(evidenceRoot) {
  const lockPath = path.join(evidenceRoot, LOCK_FILE);
  if (existsSync(lockPath)) {
    const payload = readJsonIfPresent(lockPath);
    const pid = payload?.pid;
    if (typeof pid === 'number' && isProcessAlive(pid)) {
      throw new Error(
        `another capture-vrm run seems active (pid ${pid}, lock ${path.relative(ROOT, lockPath)}); ` +
          'Electron capture must run one at a time. Remove the lock only if that process is gone.',
      );
    }
    rmSync(lockPath, { force: true });
  }
  writeJson(lockPath, { pid: process.pid, startedAt: new Date().toISOString() });
  return () => rmSync(lockPath, { force: true });
}

/* -------------------------------------------------------------------------- */
/* run mode                                                                   */
/* -------------------------------------------------------------------------- */

async function runCapture(options, vrm, evidenceRoot, evidenceDir) {
  if (!existsSync(ELECTRON_BIN)) throw new Error(`missing electron binary: ${ELECTRON_BIN}`);
  if (!existsSync(CAPTURE_ENTRY)) throw new Error(`missing capture entry: ${CAPTURE_ENTRY}`);

  mkdirSync(evidenceRoot, { recursive: true });
  mkdirSync(evidenceDir, { recursive: true });
  const releaseLock = acquireLock(evidenceRoot);

  const server = await createEvidenceServer({ root: ROOT, evidenceRoot });
  console.log(`[server] ${server.url} (root ${ROOT})`);
  console.log(`[server] evidence root ${path.relative(ROOT, evidenceRoot)}`);
  console.log(
    `[run] vrm=${vrm.servedPath} tag=${options.tag} views=${options.views.join(',')} ` +
      `recordMs=${options.recordMs} out=${path.relative(ROOT, evidenceRoot)}`,
  );

  const pageUrl = `${server.url}/scripts/vrm/canary-viewer.html?vrm=${encodeURIComponent(vrm.servedPath)}`;
  const startedAt = Date.now();
  let capture;
  try {
    capture = await runElectronCapture({
      pageUrl,
      tag: options.tag,
      views: options.views,
      recordMs: options.recordMs,
      evidenceRoot,
    });
  } finally {
    await server.close();
    releaseLock();
  }
  const wallMs = Date.now() - startedAt;

  const result = await validateArtifacts({
    evidenceDir,
    evidenceRoot,
    expectedFileName: vrm.fileName,
    views: options.views,
    recordMs: options.recordMs,
    electronExitCode: capture.code,
    requireRecording: options.recordMs > 0,
  });
  if (capture.killed) result.checks.fail.push('electron-capture was killed by the watchdog');
  if (capture.stderr.trim()) result.checks.warn.push(`electron stderr not empty (${capture.stderr.split('\n').length} lines)`);

  const glb = inspectVrmGlb(vrm.absolute);
  crossCheckGlb(glb, result.diagnostics, result.checks);
  printResult(result, evidenceDir);
  printGlbSummary(glb);

  const diagnosticsSummary = summarizeDiagnostics(result.diagnostics);
  if (diagnosticsSummary) {
    console.log(
      `[summary] spec=${diagnosticsSummary.specVersion ?? '?'} bones=${diagnosticsSummary.humanoid?.normalizedBoneCount ?? '?'} ` +
        `exprs=${diagnosticsSummary.expressions?.count ?? '?'} springChains=${diagnosticsSummary.springBone?.chainCount ?? '?'} ` +
        `springJoints=${diagnosticsSummary.springBone?.jointCount ?? '?'} mtoon=${diagnosticsSummary.materials?.mtoon ?? '?'} ` +
        `gltfTex=${diagnosticsSummary.gltfCounts?.textures ?? '?'} h=${diagnosticsSummary.heightMeters ?? '?'} ` +
        `facing=${diagnosticsSummary.facing?.conclusion ?? '?'}`,
    );
  }

  const runSummary = {
    tag: options.tag,
    vrm: vrm.servedPath,
    fileName: vrm.fileName,
    views: options.views,
    recordMs: options.recordMs,
    ok: result.ok,
    generatedAt: new Date().toISOString(),
    electronExitCode: capture.code,
    wallMs,
    electronPath: ELECTRON_BIN,
    pageUrl,
    checks: result.checks,
    pixels: result.pixels,
    recording: result.recording,
    diagnostics: diagnosticsSummary,
    glb,
    sourceDiagnosticsPath: path.relative(ROOT, result.diagnosticsPath),
    consolePath: path.relative(ROOT, result.consolePath),
    server: { failures: server.stats.failures, evidenceWrites: server.stats.evidenceWrites },
    stderrLines: capture.stderr.trim() ? capture.stderr.trim().split('\n').length : 0,
  };
  writeJson(path.join(evidenceDir, 'run-summary.json'), runSummary);
  const mergedPath = mergeRunSummary(evidenceRoot, runSummary);

  const status = result.ok ? 'PASS' : 'FAIL';
  console.log(`CAPTURE ${status}  tag=${options.tag}  ${vrm.servedPath}  (${wallMs} ms)`);
  console.log(`[summary-file] ${path.relative(ROOT, path.join(evidenceDir, 'run-summary.json'))}`);
  console.log(`[summary-file] ${path.relative(ROOT, mergedPath)} (merged)`);
  return result.ok ? 0 : 1;
}

/* -------------------------------------------------------------------------- */
/* main                                                                       */
/* -------------------------------------------------------------------------- */

async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`capture-vrm: ${error.message}`);
    console.error(usage());
    return 2;
  }
  if (options.help) {
    console.log(usage());
    return 0;
  }

  let vrm;
  try {
    vrm = resolveVrm(options.vrm);
  } catch (error) {
    console.error(`capture-vrm: ${error.message}`);
    return 2;
  }
  try {
    options.tag = normalizeTag(options.tag || deriveTag(vrm.servedPath));
  } catch (error) {
    console.error(`capture-vrm: ${error.message}`);
    return 2;
  }
  const evidenceRoot = resolveOut(options.out);
  const evidenceDir = path.join(evidenceRoot, options.tag);

  if (options.check) {
    if (!existsSync(evidenceDir)) {
      console.error(`capture-vrm: no existing evidence at ${path.relative(ROOT, evidenceDir)} (run without --check first)`);
      return 2;
    }
    return runCheck(options, vrm, evidenceDir, evidenceRoot);
  }

  try {
    return await runCapture(options, vrm, evidenceRoot, evidenceDir);
  } catch (error) {
    console.error(`capture-vrm: ${error?.stack || error}`);
    return 2;
  }
}

main()
  .then((code) => process.exit(code))
  .catch((error) => {
    console.error('capture-vrm fatal:', error);
    process.exit(2);
  });
