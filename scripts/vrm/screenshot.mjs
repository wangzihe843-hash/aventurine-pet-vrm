#!/usr/bin/env node
/**
 * W0-4 one-command canary VRM capture.
 *
 *   node scripts/vrm/screenshot.mjs                 # canary + aventurine, 10 s reel each
 *   node scripts/vrm/screenshot.mjs --record=none   # quick smoke run, stills only
 *   node scripts/vrm/screenshot.mjs --only=canary
 *
 * What it does:
 *   1. starts a local static HTTP server for the repo root (node_modules/,
 *      assets/, scripts/) plus a POST /__evidence endpoint writing into
 *      tests/tmp/w0-4/;
 *   2. runs scripts/vrm/electron-capture.mjs under Electron (with
 *      ELECTRON_RUN_AS_NODE cleared) for each VRM, which loads
 *      scripts/vrm/canary-viewer.html and drives its capture API;
 *   3. validates the evidence with sharp (pixel metrics) and checks the
 *      diagnostics/console/webm constraints;
 *   4. writes tests/tmp/w0-4/<tag>/{front,side,back}.png, recording.webm,
 *      diagnostics.json, console.log, pixel-check.json and a run-summary.json.
 *
 * Dev-only tooling. Private VRM assets are read in place and never copied.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { createEvidenceServer } from './serve-evidence.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const EVIDENCE_ROOT = path.join(ROOT, 'tests/tmp/w0-4');
const ELECTRON_BIN = path.join(ROOT, 'node_modules/.bin/electron');
const CAPTURE_ENTRY = path.join(ROOT, 'scripts/vrm/electron-capture.mjs');
const VIEWS = ['front', 'side', 'back'];

const MODELS = [
  {
    tag: 'canary',
    label: 'canary outfit (VRM 0.x)',
    file: 'assets/vrm/canary/砂金石心十人公司制服(0.x).vrm',
    expect: {
      specVersion: '0.x',
      normalizedBones: 51,
      // 12 standard VRM 1.0 preset names + 1 case-variant custom expression
      // ("Surprised", from the asset's duplicated capitalised blendShape group).
      expressions: 13,
      businessPresets: ['blink', 'blinkLeft', 'blinkRight', 'happy', 'angry', 'surprised', 'neutral'],
      mtoonMaterials: 31,
      gltfTextures: 13,
      gltfImages: 13,
      alphaStats: {
        OPAQUE: 9,
        BLEND: 22,
        blendOpaqueAlpha: 20,
        blendPartial: 2,
        doubleSided: 31,
        viewerTransparent: 0,
        viewerDepthWriteFalse: 0,
        viewerBlendOpaqueAlpha: 0,
        forceOpaqueChanged: 0,
        // VRM0 materialProperties override the on-disk glTF alphaMode: all 31
        // have keywordMap._ALPHATEST_ON -> three-vrm synthesizes MASK (opaque).
        compatAlphaMode: { MASK: 31 },
        hasAlphaTestOn: 31,
      },
      heightMeters: [1.70, 1.82],
      springBoneJoints: 0,
      facing: 'faces +Z', // measured W0-4: VRM0 -Z rotated by VRMUtils.rotateVRM0 -> +Z
    },
  },
  {
    tag: 'aventurine',
    label: 'aventurine waveflair (VRM 1.0)',
    file: 'assets/vrm/星穹铁道—砂金·戏浪(1.0).vrm',
    expect: {
      specVersion: '1.0',
      normalizedBones: 52,
      expressions: 12,
      businessPresets: ['blink', 'blinkLeft', 'blinkRight', 'happy', 'angry', 'surprised', 'neutral'],
      mtoonMaterials: 39,
      gltfTextures: 20,
      gltfImages: 20,
      alphaStats: {
        OPAQUE: 10,
        BLEND: 29,
        blendOpaqueAlpha: 27,
        blendPartial: 2,
        doubleSided: 39,
        // 29 transparent MToon materials + 29 outline clones
        viewerTransparent: 58,
        // three-vrm honors VRMC_materials_mtoon.transparentWithZWrite=true (29/29)
        // -> depthWrite stays true even in the transparent pass.
        viewerDepthWriteFalse: 0,
        viewerBlendOpaqueAlpha: 54,
        forceOpaqueChanged: 54,
        blendWithZWrite: 29,
      },
      heightMeters: [1.68, 1.80],
      springBoneJoints: 0,
      // measured W0-4: the VRM 1.0 asset faces -Z (eye-heuristic yaw 180 deg and
      // the +Z front camera sees the character's back) -> manifest needs yawOffsetDeg: 180.
      facing: 'faces -Z',
    },
  },
];

/* -------------------------------------------------------------------------- */
/* CLI                                                                        */
/* -------------------------------------------------------------------------- */

function parseArgs(argv) {
  const options = { only: new Set(MODELS.map((m) => m.tag)), record: 'all' };
  for (const arg of argv) {
    if (arg.startsWith('--only=')) {
      const tags = arg.slice('--only='.length).split(',').map((s) => s.trim()).filter(Boolean);
      options.only = new Set(tags);
    } else if (arg.startsWith('--record=')) {
      options.record = arg.slice('--record='.length).trim();
    } else if (arg === '--help' || arg === '-h') {
      console.log(
        [
          'Usage: node scripts/vrm/screenshot.mjs [--only=canary,aventurine] [--record=all|canary|aventurine|none]',
          '',
          'Evidence is written to tests/tmp/w0-4/<tag>/. Re-running overwrites the same files.',
        ].join('\n'),
      );
      process.exit(0);
    } else {
      console.warn(`unknown argument ignored: ${arg}`);
    }
  }
  if (!['all', 'none', 'canary', 'aventurine'].includes(options.record)) {
    console.error(`invalid --record=${options.record} (expected all|none|canary|aventurine)`);
    process.exit(2);
  }
  return options;
}

function recordMsFor(options, tag) {
  if (options.record === 'none') return 0;
  if (options.record === 'all') return 10_000;
  return options.record === tag ? 10_000 : 0;
}

/* -------------------------------------------------------------------------- */
/* helpers                                                                    */
/* -------------------------------------------------------------------------- */

function runElectronCapture({ pageUrl, tag, recordMs }) {
  const env = { ...process.env };
  // Electron must not run as plain Node in this session (DSH exports this).
  delete env.ELECTRON_RUN_AS_NODE;
  env.W04_URL = pageUrl;
  env.W04_TAG = tag;
  env.W04_EVIDENCE_DIR = EVIDENCE_ROOT;
  env.W04_VIEWS = VIEWS.join(',');
  env.W04_RECORD_MS = String(recordMs);
  env.W04_TIMEOUT_MS = '300000';

  return new Promise((resolve) => {
    const child = spawn(ELECTRON_BIN, [CAPTURE_ENTRY], {
      cwd: ROOT,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let killed = false;
    const watchdog = setTimeout(() => {
      killed = true;
      child.kill('SIGKILL');
    }, 330_000);
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

async function inspectPng(filePath) {
  const image = sharp(filePath);
  const metadata = await image.metadata();
  const { data, info } = await image.ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const { width, height, channels } = info;
  const total = width * height;
  let nonTransparent = 0;
  let opaque = 0;
  let sumLumAll = 0;
  let sumLumNonTransparent = 0;
  let minL = 255;
  let maxL = 0;
  for (let i = 0; i < data.length; i += channels) {
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    const a = data[i + 3];
    const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    sumLumAll += luminance;
    if (luminance < minL) minL = luminance;
    if (luminance > maxL) maxL = luminance;
    if (a > 16) {
      nonTransparent += 1;
      sumLumNonTransparent += luminance;
      if (a > 250) opaque += 1;
    }
  }
  return {
    file: path.relative(EVIDENCE_ROOT, filePath),
    width,
    height,
    channels,
    hasAlpha: metadata.hasAlpha,
    bytes: statSync(filePath).size,
    totalPixels: total,
    nonTransparentPixels: nonTransparent,
    nonTransparentRatio: Number((nonTransparent / total).toFixed(4)),
    opaqueRatio: Number((opaque / total).toFixed(4)),
    meanLuminanceAllPixels: Number((sumLumAll / total).toFixed(2)),
    meanLuminanceNonTransparent: Number((sumLumNonTransparent / Math.max(1, nonTransparent)).toFixed(2)),
    minLuminance: Number(minL.toFixed(2)),
    maxLuminance: Number(maxL.toFixed(2)),
  };
}

async function inspectDiff(beforePath, afterPath) {
  const [before, after] = await Promise.all([
    sharp(beforePath).ensureAlpha().raw().toBuffer({ resolveWithObject: true }),
    sharp(afterPath).ensureAlpha().raw().toBuffer({ resolveWithObject: true }),
  ]);
  const { width, height, channels } = before.info;
  const total = width * height;
  let changed = 0;
  let sumBefore = 0;
  let sumAfter = 0;
  let visible = 0;
  for (let i = 0; i < before.data.length; i += channels) {
    const alpha = Math.max(before.data[i + 3], after.data[i + 3]);
    if (alpha > 16) {
      visible += 1;
      sumBefore += 0.2126 * before.data[i] + 0.7152 * before.data[i + 1] + 0.0722 * before.data[i + 2];
      sumAfter += 0.2126 * after.data[i] + 0.7152 * after.data[i + 1] + 0.0722 * after.data[i + 2];
    }
    const lumaBefore = 0.2126 * before.data[i] + 0.7152 * before.data[i + 1] + 0.0722 * before.data[i + 2];
    const lumaAfter = 0.2126 * after.data[i] + 0.7152 * after.data[i + 1] + 0.0722 * after.data[i + 2];
    if (Math.abs(lumaBefore - lumaAfter) > 8) changed += 1;
  }
  return {
    before: path.basename(beforePath),
    after: path.basename(afterPath),
    width,
    height,
    changedPixels: changed,
    changedRatioOfFrame: Number((changed / total).toFixed(4)),
    meanLuminanceBefore: Number((sumBefore / Math.max(1, visible)).toFixed(2)),
    meanLuminanceAfter: Number((sumAfter / Math.max(1, visible)).toFixed(2)),
  };
}

async function inspectMotionPair(evidenceDir, motionPair) {
  const firstPath = path.join(evidenceDir, 'motion-a.png');
  const secondPath = path.join(evidenceDir, 'motion-b.png');
  if (!existsSync(firstPath) || !existsSync(secondPath)) {
    return { ok: false, error: 'missing motion-a.png / motion-b.png' };
  }
  const [first, second] = await Promise.all([
    sharp(firstPath).ensureAlpha().raw().toBuffer({ resolveWithObject: true }),
    sharp(secondPath).ensureAlpha().raw().toBuffer({ resolveWithObject: true }),
  ]);
  const { width, height, channels } = first.info;
  if (second.info.width !== width || second.info.height !== height) {
    return { ok: false, error: 'motion frames differ in size' };
  }
  const total = width * height;
  let changed = 0;
  let visible = 0;
  let sumAbsDiff = 0;
  for (let i = 0; i < first.data.length; i += channels) {
    const alpha = Math.max(first.data[i + 3], second.data[i + 3]);
    if (alpha <= 16) continue;
    visible += 1;
    const lumaA = 0.2126 * first.data[i] + 0.7152 * first.data[i + 1] + 0.0722 * first.data[i + 2];
    const lumaB = 0.2126 * second.data[i] + 0.7152 * second.data[i + 1] + 0.0722 * second.data[i + 2];
    const diff = Math.abs(lumaA - lumaB);
    sumAbsDiff += diff;
    if (diff > 8) changed += 1;
  }
  return {
    ok: true,
    first: path.basename(firstPath),
    second: path.basename(secondPath),
    width,
    height,
    visiblePixels: visible,
    changedPixels: changed,
    changedRatioOfFrame: Number((changed / total).toFixed(4)),
    changedRatioOfVisible: Number((changed / Math.max(1, visible)).toFixed(4)),
    meanAbsLuminanceDiff: Number((sumAbsDiff / Math.max(1, visible)).toFixed(3)),
    actualIntervalMs: motionPair?.actualIntervalMs ?? null,
    bone: {
      maxAngleDeltaDeg: motionPair?.maxBoneAngleDeltaDeg ?? null,
      maxBone: motionPair?.maxBone ?? null,
      perBone: motionPair?.perBoneAngleDeltaDeg ?? null,
    },
  };
}

function inspectWebm(filePath) {
  const buffer = readFileSync(filePath);
  const magic = buffer.subarray(0, 4);
  const ebml = magic[0] === 0x1a && magic[1] === 0x45 && magic[2] === 0xdf && magic[3] === 0xa3;
  return {
    file: path.relative(EVIDENCE_ROOT, filePath),
    bytes: buffer.length,
    ebmlHeaderOk: ebml,
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

function fail(collection, message) {
  collection.push(message);
}

/* -------------------------------------------------------------------------- */
/* model run                                                                  */
/* -------------------------------------------------------------------------- */

async function runModel(model, server, options) {
  const evidenceDir = path.join(EVIDENCE_ROOT, model.tag);
  mkdirSync(evidenceDir, { recursive: true });
  const recordMs = recordMsFor(options, model.tag);
  const pageUrl = `${server.url}/scripts/vrm/canary-viewer.html?vrm=${encodeURIComponent(model.file)}`;

  console.log('');
  console.log('='.repeat(78));
  console.log(`[run] ${model.tag} — ${model.label}`);
  console.log(`[run] ${model.file}`);
  console.log(`[run] recordMs=${recordMs}`);
  console.log('='.repeat(78));

  const result = await runElectronCapture({ pageUrl, tag: model.tag, recordMs });

  const checks = { pass: [], fail: [], warn: [] };
  const diagnosticsPath = path.join(evidenceDir, 'diagnostics.json');
  const consolePath = path.join(evidenceDir, 'console.log');
  const diagnostics = readJsonIfPresent(diagnosticsPath);

  if (!diagnostics) fail(checks.fail, `missing/unparsable diagnostics.json (electron exit code ${result.code})`);
  if (!existsSync(consolePath)) fail(checks.fail, 'missing console.log');
  if (result.code !== 0) fail(checks.fail, `electron-capture exited with code ${result.code}${result.killed ? ' (watchdog kill)' : ''}`);
  if (result.stderr.trim()) checks.warn.push(`electron stderr not empty (${result.stderr.split('\n').length} lines)`);

  const pixelChecks = [];
  for (const view of VIEWS) {
    const filePath = path.join(evidenceDir, `${view}.png`);
    if (!existsSync(filePath)) {
      fail(checks.fail, `missing ${view}.png`);
      continue;
    }
    const metrics = await inspectPng(filePath);
    pixelChecks.push(metrics);
    if (metrics.nonTransparentRatio < 0.05) fail(checks.fail, `${view}.png non-transparent pixel ratio too low (${metrics.nonTransparentRatio})`);
    if (metrics.meanLuminanceNonTransparent < 20) fail(checks.fail, `${view}.png too dark (mean luminance ${metrics.meanLuminanceNonTransparent})`);
    if (metrics.nonTransparentRatio > 0.95) checks.warn.push(`${view}.png covers >95% of the frame (${metrics.nonTransparentRatio})`);
  }

  let recordingCheck = null;
  if (recordMs > 0) {
    const webmPath = path.join(evidenceDir, 'recording.webm');
    if (!existsSync(webmPath)) {
      fail(checks.fail, 'missing recording.webm');
    } else {
      const webmInfo = inspectWebm(webmPath);
      const bytes = statSync(webmPath).size;
      const metadata = diagnostics?.main?.recording || null;
      const durationMs = metadata?.durationMs ?? null;
      const frames = metadata?.frames ?? null;
      recordingCheck = {
        ...webmInfo,
        durationMs,
        frames,
        mimeType: metadata?.mimeType ?? null,
        averageFps: metadata?.averageFps ?? null,
      };
      if (!webmInfo.ebmlHeaderOk) fail(checks.fail, 'recording.webm does not start with an EBML header');
      if (bytes < 50_000) fail(checks.fail, `recording.webm suspiciously small (${bytes} bytes)`);
      if (durationMs == null) fail(checks.fail, 'recording metadata missing from diagnostics');
      else if (durationMs < 9_000 || durationMs > 12_500) fail(checks.fail, `recording duration ${durationMs} ms not ~10 s`);
      if (frames != null && frames < 150) fail(checks.fail, `recording only ${frames} frames`);
    }
  }

  const expect = model.expect;
  const modelDiagPre = diagnostics?.model || null;
  // force-opaque debug comparison (Lead request: root-cause reference for V5/V6)
  let forceOpaqueCheck = null;
  const forceOpaqueInfo = diagnostics?.main?.forceOpaque || null;
  const forceOpaquePath = path.join(evidenceDir, 'front-force-opaque.png');
  if (existsSync(forceOpaquePath)) {
    const forceOpaquePixels = await inspectPng(forceOpaquePath);
    const frontPath = path.join(evidenceDir, 'front.png');
    const diff = existsSync(frontPath) ? await inspectDiff(frontPath, forceOpaquePath) : null;
    forceOpaqueCheck = {
      file: path.relative(EVIDENCE_ROOT, forceOpaquePath),
      pixels: forceOpaquePixels,
      diff,
      applied: forceOpaqueInfo?.stats?.changed?.length ?? null,
      keptTransparent: forceOpaqueInfo?.stats?.keptTransparent ?? null,
      failIfNoChange: model.tag === 'aventurine',
    };
    if (model.tag === 'aventurine' && diff && diff.changedRatioOfFrame < 0.01) {
      checks.warn.push('force-opaque only changed <1% of the frame (does the debug switch work?)');
    }
    if (model.tag === 'aventurine' && forceOpaqueInfo && (forceOpaqueInfo.stats?.changed?.length ?? 0) < 20) {
      fail(checks.fail, `force-opaque changed only ${forceOpaqueInfo.stats?.changed?.length} materials, expected the ${expect.alphaStats.forceOpaqueChanged} opacity~1 BLEND materials`);
    }
  } else if (model.tag === 'aventurine') {
    fail(checks.fail, 'missing aventurine/front-force-opaque.png comparison evidence');
  } else {
    checks.warn.push('front-force-opaque.png not captured');
  }

  // BLEND/material alpha statistics (raw glTF JSON) + viewer-side transparency state
  if (modelDiagPre) {
    const rawAlpha = modelDiagPre.gltfSourceRaw?.materialAlpha || modelDiagPre.gltfSource?.materialAlpha || null;
    const compatAlpha = modelDiagPre.gltfSource?.materialAlpha || null;
    const materialAlpha = rawAlpha;
    if (!materialAlpha) {
      fail(checks.fail, 'missing raw glTF material alpha diagnostics');
    } else {
      const expected = expect.alphaStats;
      if (materialAlpha.alphaModeCounts?.OPAQUE !== expected.OPAQUE) {
        fail(checks.fail, `OPAQUE material count ${materialAlpha.alphaModeCounts?.OPAQUE} != expected ${expected.OPAQUE}`);
      }
      if (materialAlpha.alphaModeCounts?.BLEND !== expected.BLEND) {
        fail(checks.fail, `BLEND material count ${materialAlpha.alphaModeCounts?.BLEND} != expected ${expected.BLEND}`);
      }
      if (materialAlpha.blendAlphaOpaqueCount !== expected.blendOpaqueAlpha) {
        fail(checks.fail, `BLEND-with-alpha~1 count ${materialAlpha.blendAlphaOpaqueCount} != expected ${expected.blendOpaqueAlpha}`);
      }
      if (materialAlpha.blendAlphaPartialCount !== expected.blendPartial) {
        fail(checks.fail, `BLEND-with-real-alpha count ${materialAlpha.blendAlphaPartialCount} != expected ${expected.blendPartial}`);
      }
      if (materialAlpha.doubleSidedCount !== expected.doubleSided) {
        fail(checks.fail, `doubleSided material count ${materialAlpha.doubleSidedCount} != expected ${expected.doubleSided}`);
      }
      const materials = modelDiagPre.materials || {};
      if (materials.transparent !== expected.viewerTransparent) {
        fail(
          checks.fail,
          `viewer transparent material count ${materials.transparent} != expected ${expected.viewerTransparent}` +
            ` (raw glTF BLEND = ${expected.BLEND})`,
        );
      }
      if (materials.depthWriteFalse !== expected.viewerDepthWriteFalse) {
        fail(checks.fail, `viewer depthWrite=false count ${materials.depthWriteFalse} != expected ${expected.viewerDepthWriteFalse}`);
      }
      if ((materials.blendOpaqueAlpha?.length ?? -1) !== expected.viewerBlendOpaqueAlpha) {
        fail(checks.fail, `viewer transparent-with-alpha~1 count ${materials.blendOpaqueAlpha?.length} != expected ${expected.viewerBlendOpaqueAlpha}`);
      }
      if ((forceOpaqueInfo?.stats?.changed?.length ?? -1) !== expected.forceOpaqueChanged) {
        fail(checks.fail, `forceOpaque changed ${forceOpaqueInfo?.stats?.changed?.length} materials != expected ${expected.forceOpaqueChanged}`);
      }
      if (expected.compatAlphaMode) {
        for (const [mode, count] of Object.entries(expected.compatAlphaMode)) {
          if (compatAlpha?.alphaModeCounts?.[mode] !== count) {
            fail(checks.fail, `post-VRM0-compat alphaMode ${mode} count ${compatAlpha?.alphaModeCounts?.[mode]} != expected ${count}`);
          }
        }
      }
      if (expected.hasAlphaTestOn != null) {
        const alphaTestOn = modelDiagPre.gltfSourceRaw?.vrm0MaterialFlags?.keywordTrue?._ALPHATEST_ON ?? null;
        if (alphaTestOn !== expected.hasAlphaTestOn) {
          fail(checks.fail, `VRM0 _ALPHATEST_ON material count ${alphaTestOn} != expected ${expected.hasAlphaTestOn}`);
        }
      }
      if (expected.blendWithZWrite != null) {
        if (materialAlpha.blendWithZWriteCount !== expected.blendWithZWrite) {
          fail(checks.fail, `BLEND materials with transparentWithZWrite=${materialAlpha.blendWithZWriteCount} != expected ${expected.blendWithZWrite}`);
        }
      }
    }
  }

  let motionCheck = null;
  const motionPair = diagnostics?.main?.motionPair || null;
  if (motionPair) {
    motionCheck = await inspectMotionPair(evidenceDir, motionPair);
    if (!motionCheck.ok) {
      fail(checks.fail, `motion frame pair invalid: ${motionCheck.error}`);
    } else {
      if (motionCheck.changedRatioOfFrame < 0.003) {
        fail(checks.fail, `motion frames barely differ (changedRatio=${motionCheck.changedRatioOfFrame}); idle animation not visible`);
      }
      if (!(motionCheck.bone.maxAngleDeltaDeg >= 2.0)) {
        fail(checks.fail, `skeleton pose delta too small (${motionCheck.bone.maxAngleDeltaDeg} deg)`);
      }
    }
  } else {
    fail(checks.fail, 'missing motion pair evidence (idle animation not proven)');
  }

  const modelDiag = diagnostics?.model;
  if (modelDiag) {
    const humanoid = modelDiag.humanoid || {};
    if (humanoid.normalizedBoneCount !== expect.normalizedBones) {
      fail(checks.fail, `normalizedBoneCount ${humanoid.normalizedBoneCount} != expected ${expect.normalizedBones}`);
    }
    const missingRequired = humanoid.missingRequiredBones || [];
    if (missingRequired.length > 0) fail(checks.fail, `missing required humanoid bones: ${missingRequired.join(',')}`);
    if ((modelDiag.expressions?.count ?? -1) !== expect.expressions) {
      fail(checks.fail, `expression count ${modelDiag.expressions?.count} != expected ${expect.expressions}`);
    }
    const mtoon = modelDiag.materials?.mtoon ?? -1;
    const gltfMtoon = modelDiag.gltfSource?.materialExtensions?.VRMC_materials_mtoon
      ?? ((modelDiag.gltfSource?.vrm0?.materialShaders || []).includes('VRM/MToon') ? modelDiag.gltfSource?.counts?.materials : 0)
      ?? 0;
    if (mtoon < expect.mtoonMaterials) fail(checks.fail, `MToon material count ${mtoon} < expected ${expect.mtoonMaterials}`);
    if (gltfMtoon !== expect.mtoonMaterials && modelDiag.gltfSource?.vrm0 == null) {
      fail(checks.fail, `glTF MToon extension material count ${gltfMtoon} != expected ${expect.mtoonMaterials}`);
    }
    if (mtoon > gltfMtoon) checks.warn.push(`viewer MToonMaterial instances ${mtoon} > glTF MToon materials ${gltfMtoon} (outline material clones)`);
    const gltfCounts = modelDiag.gltfSource?.counts || {};
    if (gltfCounts.textures !== expect.gltfTextures) {
      fail(checks.fail, `embedded glTF texture count ${gltfCounts.textures} != expected ${expect.gltfTextures}`);
    }
    if (gltfCounts.images !== expect.gltfImages) {
      fail(checks.fail, `embedded glTF image count ${gltfCounts.images} != expected ${expect.gltfImages}`);
    }
    if (gltfCounts.materials !== expect.mtoonMaterials) {
      fail(checks.fail, `glTF material count ${gltfCounts.materials} != expected ${expect.mtoonMaterials}`);
    }
    if ((modelDiag.textures?.failed ?? 1) !== 0) fail(checks.fail, `${modelDiag.textures?.failed} textures failed to load`);
    if ((modelDiag.textures?.images ?? 0) <= 0) fail(checks.fail, 'no material source images resolved');
    const expressionNames = new Set(modelDiag.expressions?.names || []);
    const missingPresets = (expect.businessPresets || []).filter((name) => !expressionNames.has(name));
    if (missingPresets.length > 0) fail(checks.fail, `business expression presets missing from model: ${missingPresets.join(',')}`);
    if (!modelDiag.expressions?.v0RenameProof && expect.specVersion === '0.x') fail(checks.fail, 'missing VRM0 expression rename proof');
    if (modelDiag.expressions?.v0RenameProof && modelDiag.expressions.v0RenameProof.allRenamedCorrectly !== true) {
      fail(checks.fail, 'VRM0 expression preset normalization (joy/blink_l/a..o) failed');
    }
    const height = modelDiag.heightMeters ?? -1;
    if (height < expect.heightMeters[0] || height > expect.heightMeters[1]) {
      fail(checks.fail, `height ${height} m outside expected [${expect.heightMeters.join(', ')}]`);
    }
    if (modelDiag.springBone?.jointCount !== expect.springBoneJoints) {
      checks.warn.push(`springBone joints ${modelDiag.springBone?.jointCount} != expected ${expect.springBoneJoints} (expected 0 in W0)`);
    }
    if (!modelDiag.facing?.conclusion) fail(checks.fail, 'facing heuristic did not produce a conclusion');
    else if (modelDiag.facing.conclusion !== expect.facing) checks.warn.push(`facing: ${JSON.stringify(modelDiag.facing)}`);
    if (modelDiag.humanoid?.autoUpdateHumanBones !== true) checks.warn.push('autoUpdateHumanBones is not true');
    if (!diagnostics.idleAnimation?.mixerDriven) fail(checks.fail, 'idle animation is not AnimationMixer-driven');
    if ((modelDiag.expressions?.runtimeTest?.failed?.length ?? 0) > 0) {
      fail(checks.fail, `expressions with no bind/effect: ${modelDiag.expressions.runtimeTest.failed.join(',')}`);
    }
    if (!modelDiag.expressions?.runtimeTest?.success) fail(checks.fail, 'expression runtime test did not run');
    if ((modelDiag.expressions?.runtimeTest?.morphEffects?.blink?.morphDelta ?? 0) <= 0) {
      checks.warn.push('blink expression produced no morph delta (may be material-only)');
    }
  }

  // console / network / page errors
  const mainInfo = diagnostics?.main || {};
  const pageErrors = mainInfo.pageErrors || [];
  if (pageErrors.length > 0) fail(checks.fail, `${pageErrors.length} pageerror(s): ${pageErrors.map((e) => `${e.kind}:${e.message}`).join(' | ')}`);
  const networkFailures = mainInfo.network?.failures || [];
  if (networkFailures.length > 0) fail(checks.fail, `${networkFailures.length} network failure(s): ${networkFailures.map((n) => `${n.statusCode ?? n.error} ${n.url}`).join(' | ')}`);
  if ((mainInfo.consoleErrorCount ?? 0) > 0) {
    fail(checks.fail, `${mainInfo.consoleErrorCount} renderer console error line(s): ${(mainInfo.consoleErrorLines || []).slice(0, 5).join(' | ')}`);
  }
  const mainErrors = mainInfo.errors || [];
  if (mainErrors.length > 0) fail(checks.fail, `main process errors: ${mainErrors.map((e) => e.message).join(' | ')}`);

  // capture metadata
  const captures = mainInfo.captures || [];
  if (captures.length !== VIEWS.length) fail(checks.fail, `only ${captures.length}/${VIEWS.length} views captured`);
  for (const capture of captures) {
    if (!capture?.server?.ok) fail(checks.fail, `view ${capture?.view} was not persisted`);
  }

  const pixelCheckPath = path.join(evidenceDir, 'pixel-check.json');
  writeFileSync(
    pixelCheckPath,
    `${JSON.stringify(
      {
        tag: model.tag,
        generatedAt: new Date().toISOString(),
        views: pixelChecks,
        recording: recordingCheck,
        motionTest: motionCheck,
        forceOpaqueTest: forceOpaqueCheck,
        summary: {
          pass: checks.pass,
          warnings: checks.warn,
          failures: checks.fail,
          consoleErrorCount: mainInfo.consoleErrorCount ?? null,
          pageErrorCount: pageErrors.length,
          networkFailureCount: networkFailures.length,
        },
      },
      null,
      2,
    )}\n`,
  );

  for (const message of checks.pass) console.log(`[check:ok] ${message}`);
  for (const message of checks.warn) console.log(`[check:warn] ${message}`);
  for (const message of checks.fail) console.log(`[check:fail] ${message}`);

  return {
    tag: model.tag,
    label: model.label,
    file: model.file,
    electronExitCode: result.code,
    ok: checks.fail.length === 0,
    checks,
    pixelChecks,
    recording: recordingCheck,
    motionTest: motionCheck,
    forceOpaqueTest: forceOpaqueCheck,
    summary: diagnostics
      ? {
          specVersion: diagnostics.model?.specVersion,
          humanoidBones: diagnostics.model?.humanoid?.normalizedBoneCount,
          expressions: diagnostics.model?.expressions?.names,
          expressionCount: diagnostics.model?.expressions?.count,
          v0RenameProof: diagnostics.model?.expressions?.v0RenameProof,
          materials: diagnostics.model?.materials?.mtoon,
          gltfMtoonMaterials: diagnostics.model?.gltfSource?.materialExtensions?.VRMC_materials_mtoon
            ?? (diagnostics.model?.gltfSource?.vrm0 ? diagnostics.model.gltfSource.vrm0.materialPropertyCount : null),
          facingConclusion: diagnostics.model?.facing?.conclusion,
          materialAlpha: diagnostics.model?.gltfSourceRaw?.materialAlpha ?? null,
          materialAlphaCompat: diagnostics.model?.gltfSource?.materialAlpha ?? null,
          vrm0MaterialFlags: diagnostics.model?.gltfSourceRaw?.vrm0MaterialFlags ?? null,
          materialTotal: diagnostics.model?.materials?.total,
          textures: diagnostics.model?.textures?.total,
          heightMeters: diagnostics.model?.heightMeters,
          facing: diagnostics.model?.facing,
          springBone: diagnostics.model?.springBone,
          idleAnimation: diagnostics.idleAnimation,
          expressionRuntime: diagnostics.expressionRuntime,
          embeddedAnimations: diagnostics.model?.embeddedAnimations,
          lookAt: diagnostics.model?.lookAt,
          textures: diagnostics.model?.gltfSource?.counts?.textures ?? null,
          materialSourceImages: diagnostics.model?.textures?.images ?? null,
          textureObjects: diagnostics.model?.textures?.total ?? null,
          gltfSource: diagnostics.model?.gltfSource ?? null,
          networkFailureCount: networkFailures.length,
          pageErrorCount: pageErrors.length,
          consoleErrorCount: mainInfo.consoleErrorCount ?? null,
        }
      : null,
    diagnosticsPath,
    consolePath,
  };
}

/* -------------------------------------------------------------------------- */
/* main                                                                       */
/* -------------------------------------------------------------------------- */

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const models = MODELS.filter((model) => options.only.has(model.tag));
  if (models.length === 0) {
    console.error(`no models selected (--only=${[...options.only].join(',')})`);
    process.exit(2);
  }
  for (const model of models) {
    if (!existsSync(path.join(ROOT, model.file))) {
      console.error(`missing private asset: ${model.file}`);
      process.exit(2);
    }
  }
  if (!existsSync(ELECTRON_BIN)) {
    console.error(`missing electron binary: ${ELECTRON_BIN}`);
    process.exit(2);
  }

  mkdirSync(EVIDENCE_ROOT, { recursive: true });
  const server = await createEvidenceServer({ root: ROOT, evidenceRoot: EVIDENCE_ROOT });
  console.log(`[server] ${server.url} (root ${ROOT})`);
  console.log(`[server] evidence root ${EVIDENCE_ROOT}`);

  const results = [];
  let error = null;
  try {
    for (const model of models) {
      results.push(await runModel(model, server, options));
    }
  } catch (caught) {
    error = caught;
  } finally {
    await server.close();
  }

  const summary = {
    generatedAt: new Date().toISOString(),
    repoRoot: ROOT,
    evidenceRoot: EVIDENCE_ROOT,
    electron: ELECTRON_BIN,
    options: { only: [...options.only], record: options.record },
    server: { url: server.url, failures: server.stats.failures, evidenceWrites: server.stats.evidenceWrites },
    results,
    error: error ? String(error?.stack || error) : null,
  };
  writeFileSync(path.join(EVIDENCE_ROOT, 'run-summary.json'), `${JSON.stringify(summary, null, 2)}\n`);

  console.log('');
  console.log('='.repeat(78));
  console.log('SUMMARY');
  for (const result of results) {
    console.log(
      `${result.ok ? 'PASS' : 'FAIL'}  ${result.tag.padEnd(11)} ` +
        `bones=${result.summary?.humanoidBones ?? '?'} exprs=${result.summary?.expressionCount ?? '?'} ` +
        `mtoon=${result.summary?.materials ?? '?'} gltfTex=${result.summary?.textures ?? '?'} srcImg=${result.summary?.materialSourceImages ?? '?'} texObj=${result.summary?.textureObjects ?? '?'} ` +
        `h=${result.summary?.heightMeters ?? '?'} facing=${result.summary?.facing?.conclusion ?? '?'} ` +
        `errs(page/console/net)=${result.summary?.pageErrorCount ?? '?'}/${result.summary?.consoleErrorCount ?? '?'}/${result.summary?.networkFailureCount ?? '?'}`,
    );
    for (const pixel of result.pixelChecks) {
      console.log(
        `      ${pixel.file}: ${pixel.width}x${pixel.height} nonTransparent=${pixel.nonTransparentRatio} ` +
          `meanLum(alpha)=${pixel.meanLuminanceNonTransparent}`,
      );
    }
    if (result.motionTest?.ok) {
      console.log(
        `      motion pair: changedPixelRatio=${result.motionTest.changedRatioOfFrame} ` +
          `meanLumDiff=${result.motionTest.meanAbsLuminanceDiff} maxBoneDelta=${result.motionTest.bone.maxAngleDeltaDeg}deg`,
      );
    }
    if (result.forceOpaqueTest) {
      console.log(
        `      force-opaque: changedRatio=${result.forceOpaqueTest.diff?.changedRatioOfFrame ?? '?'} ` +
          `meanLum ${result.forceOpaqueTest.diff?.meanLuminanceBefore ?? '?'} -> ${result.forceOpaqueTest.diff?.meanLuminanceAfter ?? '?'} ` +
          `applied=${result.forceOpaqueTest.applied ?? '?'}`,
      );
    }
    if (result.recording) {
      console.log(
        `      recording.webm: ${result.recording.bytes} bytes, ${result.recording.durationMs} ms, ${result.recording.frames} frames`,
      );
    }
  }
  console.log(`evidence: ${EVIDENCE_ROOT}`);
  console.log(`summary:  ${path.join(EVIDENCE_ROOT, 'run-summary.json')}`);
  console.log('='.repeat(78));

  if (error) {
    console.error(error);
    process.exit(1);
  }
  const failed = results.filter((result) => !result.ok);
  if (failed.length > 0) {
    console.error(`FAILED: ${failed.map((result) => result.tag).join(', ')}`);
    process.exit(1);
  }
  console.log('ALL CHECKS PASSED');
}

main().catch((error) => {
  console.error('screenshot.mjs fatal:', error);
  process.exit(1);
});
