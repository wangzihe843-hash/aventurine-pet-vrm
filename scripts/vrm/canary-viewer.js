/**
 * W0-4 canary viewer — three-vrm 3.5.5 in a browser context.
 *
 * Loads a VRM (default: the VRM 0.x canary) with GLTFLoader + VRMLoaderPlugin,
 * normalizes VRM0 orientation with VRMUtils.rotateVRM0, renders with MToon,
 * exposes three fixed camera views, a skeleton helper, a procedural idle
 * animation driven by THREE.AnimationMixer on normalized humanoid bones, and
 * periodic blink / happy expressions through vrm.expressionManager.
 *
 * Public API (used by scripts/vrm/electron-capture.mjs):
 *   window.__aventurineViewer.ready                 -> Promise<diagnostics>
 *   window.__aventurineViewer.diagnostics()         -> diagnostics JSON object
 *   window.__aventurineViewer.setView('front'|'side'|'back'|'threeQuarter')
 *   window.__aventurineViewer.captureAndPost(relPath, view) -> metadata
 *   window.__aventurineViewer.recordAndPost(relPath, durationMs, view) -> metadata
 *   window.__aventurineViewer.collectLogs()         -> {logs, pageErrors}
 *   window.__aventurineViewer.setBackdrop('transparent'|'studio')
 *   window.__aventurineViewer.setSkeletonVisible(bool)
 *
 * Query params:
 *   ?vrm=<path relative to the served repo root>   (default: canary VRM 0.x)
 *   ?view=<front|side|back|threeQuarter>           (initial view, default front)
 *
 * This file is dev-only evidence tooling; it is not part of the app bundle.
 */
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MToonMaterial, VRMLoaderPlugin, VRMUtils } from '@pixiv/three-vrm';

const THREE_VERSION = THREE.REVISION;
const DEFAULT_VRM = 'assets/vrm/canary/砂金石心十人公司制服(0.x).vrm';
const WIDTH = 720;
const HEIGHT = 960;
const VIEW_NAMES = ['front', 'side', 'back', 'threeQuarter'];

const params = new URLSearchParams(window.location.search);
const requestedPath = params.get('vrm') || DEFAULT_VRM;
const initialView = VIEW_NAMES.includes(params.get('view')) ? params.get('view') : 'front';

/* -------------------------------------------------------------------------- */
/* logging                                                                    */
/* -------------------------------------------------------------------------- */

const consoleLogs = [];
const pageErrors = [];

function serializeArg(value) {
  if (typeof value === 'string') return value;
  if (value instanceof Error) return value.stack || String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

for (const level of ['log', 'info', 'warn', 'error', 'debug']) {
  const original = console[level].bind(console);
  console[level] = (...args) => {
    consoleLogs.push({
      t: Math.round(performance.now()),
      level,
      message: args.map(serializeArg).join(' '),
    });
    if (consoleLogs.length > 500) consoleLogs.shift();
    original(...args);
  };
}

window.addEventListener('error', (event) => {
  pageErrors.push({
    t: Math.round(performance.now()),
    kind: 'error',
    message: event.message,
    source: `${event.filename || ''}:${event.lineno || 0}:${event.colno || 0}`,
    stack: event.error?.stack || null,
  });
});
window.addEventListener('unhandledrejection', (event) => {
  pageErrors.push({
    t: Math.round(performance.now()),
    kind: 'unhandledrejection',
    message: String(event.reason?.message || event.reason),
    stack: event.reason?.stack || null,
  });
});

/* -------------------------------------------------------------------------- */
/* three.js boilerplate                                                       */
/* -------------------------------------------------------------------------- */

const canvas = document.getElementById('viewer');
const hud = document.getElementById('hud');
const statusEl = document.getElementById('status');

const renderer = new THREE.WebGLRenderer({
  canvas,
  alpha: true,
  antialias: true,
  preserveDrawingBuffer: true,
  powerPreference: 'high-performance',
});
renderer.setPixelRatio(1);
renderer.setSize(WIDTH, HEIGHT, false);
renderer.setClearColor(0x000000, 0);
renderer.setClearAlpha(0);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.NoToneMapping;

const scene = new THREE.Scene();
scene.background = null;

const camera = new THREE.PerspectiveCamera(30, WIDTH / HEIGHT, 0.01, 100);
camera.position.set(0, 1, 3);
camera.lookAt(0, 0.9, 0);

// MToon is happiest with a single strong key light + ambient. Values are in
// three r155+ physical units (useLegacyLights removed), tuned against the
// canary outfit textures by looking at the rendered luminance.
const keyLight = new THREE.DirectionalLight(0xffffff, 2.0);
keyLight.position.set(1.1, 2.0, 1.7);
scene.add(keyLight);
const fillLight = new THREE.DirectionalLight(0xbfd4ff, 0.5);
fillLight.position.set(-1.8, 0.9, 1.1);
scene.add(fillLight);
const rimLight = new THREE.DirectionalLight(0xffe2c4, 0.7);
rimLight.position.set(-0.4, 1.4, -2.0);
scene.add(rimLight);
scene.add(new THREE.AmbientLight(0xffffff, 0.7));

/* -------------------------------------------------------------------------- */
/* state                                                                      */
/* -------------------------------------------------------------------------- */

/** @type {object|null} */
let vrm = null;
/** @type {THREE.AnimationMixer|null} */
let mixer = null;
/** @type {THREE.AnimationClip|null} */
let idleClip = null;
/** @type {THREE.SkeletonHelper|null} */
let skeletonHelper = null;
/** @type {{center: THREE.Vector3, size: THREE.Vector3, distance: (v: string) => number}|null} */
let framing = null;
const loadErrors = [];
const warnings = [];
let currentView = initialView;
let frameCount = 0;
let fps = 0;
let fpsWindow = { start: performance.now(), frames: 0 };
let clock = new THREE.Clock();
let readyResolve;
let readyReject;
const ready = new Promise((resolve, reject) => {
  readyResolve = resolve;
  readyReject = reject;
});
const modelLoad = {
  startedAt: 0,
  finishedAt: 0,
  durationMs: 0,
};
const runtime = {
  blinkCycles: 0,
  blinkPeak: 0,
  happyCycles: 0,
  happyPeak: 0,
  blinkWindowState: false,
  happyWindowState: false,
};
const animatedBones = [];
const idleMotion = {};
let expressionTest = {};
let facingDiag = {};
let rotateVRM0Applied = false;
let embeddedAnimations = [];
let gltfSource = null;
let loadPatches = [];
let rawGltfStats = null;
let forceOpaqueActive = false;
let forceOpaqueStats = null;

/* -------------------------------------------------------------------------- */
/* loading                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Fetch the .vrm bytes and apply minimal in-memory repairs to the glTF JSON
 * chunk before handing it to GLTFLoader.
 *
 * Known W0 asset defect: aventurine (VRM 1.0) material "珍珠" carries
 * `VRMC_materials_mtoon.shadeMultiplyTexture: {}` (no `index`). three-vrm 3.5.5
 * forwards that to GLTFLoader.assignTexture, which asks `json.textures[undefined]`
 * and throws inside GLTFLoader's KHR_texture_basisu extension hook. Dropping the
 * invalid texture reference keeps the rest of the material intact and does not
 * touch the file on disk.
 */
function patchGlbJson(arrayBuffer, mutate) {
  const input = new DataView(arrayBuffer);
  if (input.getUint32(0, true) !== 0x46546c67) throw new Error('not a GLB file (bad magic)');
  const version = input.getUint32(4, true);
  const declaredTotal = input.getUint32(8, true);
  const jsonLength = input.getUint32(12, true);
  const jsonType = input.getUint32(16, true);
  if (jsonType !== 0x4e4f534a) throw new Error('first GLB chunk is not JSON');
  const jsonText = new TextDecoder().decode(new Uint8Array(arrayBuffer, 20, jsonLength));
  const json = JSON.parse(jsonText);
  const mutation = mutate(json) || {};
  const fixes = mutation.fixes || [];
  const rawStats = mutation.rawStats || null;
  const jsonBytes = new TextEncoder().encode(JSON.stringify(json));
  const paddedJsonLength = Math.ceil(jsonBytes.length / 4) * 4;
  const rest = new Uint8Array(arrayBuffer, 20 + jsonLength, declaredTotal - (20 + jsonLength));
  const output = new ArrayBuffer(12 + 8 + paddedJsonLength + rest.byteLength);
  const out = new DataView(output);
  const outBytes = new Uint8Array(output);
  out.setUint32(0, 0x46546c67, true);
  out.setUint32(4, version, true);
  out.setUint32(8, output.byteLength, true);
  out.setUint32(12, paddedJsonLength, true);
  out.setUint32(16, jsonType, true);
  outBytes.set(jsonBytes, 20);
  outBytes.fill(0x20, 20 + jsonBytes.length, 20 + paddedJsonLength); // glTF JSON padding = spaces
  outBytes.set(rest, 20 + paddedJsonLength);
  return { buffer: output, fixes, rawStats };
}

function summarizeRawGltf(json) {
  const materials = json.materials || [];
  const counts = {
    scenes: json.scenes?.length ?? null,
    nodes: json.nodes?.length ?? null,
    meshes: json.meshes?.length ?? null,
    primitives: (json.meshes || []).reduce((sum, mesh) => sum + (mesh.primitives?.length || 0), 0),
    materials: materials.length,
    textures: json.textures?.length ?? null,
    images: json.images?.length ?? null,
    skins: json.skins?.length ?? null,
    animations: json.animations?.length ?? 0,
  };
  const materialExtensions = {
    VRMC_materials_mtoon: materials.filter((material) => material.extensions?.VRMC_materials_mtoon).length,
    VRM_material: materials.filter((material) => material.extensions?.VRM_material).length,
    KHR_materials_unlit: materials.filter((material) => material.extensions?.KHR_materials_unlit).length,
  };
  const alphaModeCounts = {};
  const blend = [];
  let doubleSided = 0;
  let blendWithZWrite = 0;
  for (const material of materials) {
    const alphaMode = material.alphaMode || 'OPAQUE';
    alphaModeCounts[alphaMode] = (alphaModeCounts[alphaMode] || 0) + 1;
    if (material.doubleSided) doubleSided += 1;
    const mtoon = material.extensions?.VRMC_materials_mtoon;
    if (mtoon?.transparentWithZWrite === true) blendWithZWrite += 1;
    if (alphaMode === 'BLEND') {
      blend.push({
        name: material.name || null,
        baseColorAlpha: material.pbrMetallicRoughness?.baseColorFactor?.[3] ?? 1,
        baseColorTexture: material.pbrMetallicRoughness?.baseColorTexture?.index ?? null,
        doubleSided: Boolean(material.doubleSided),
        transparentWithZWrite: mtoon?.transparentWithZWrite ?? null,
      });
    }
  }
  const vrm0Materials = json.extensions?.VRM?.materialProperties || [];
  const keywordTrue = {};
  const floatValues = {};
  const colorAlphas = {};
  for (const material of vrm0Materials) {
    for (const [key, value] of Object.entries(material.keywordMap || {})) {
      if (value) keywordTrue[key] = (keywordTrue[key] || 0) + 1;
    }
    for (const key of ['_BlendMode', '_ZWrite', '_Cutoff', '_CullMode', '_OutlineWidthMode']) {
      const value = material.floatProperties?.[key];
      if (value !== undefined) floatValues[`${key}:${value}`] = (floatValues[`${key}:${value}`] || 0) + 1;
    }
    const alpha = material.vectorProperties?._Color?.[3];
    if (alpha !== undefined) colorAlphas[String(alpha)] = (colorAlphas[String(alpha)] || 0) + 1;
  }
  return {
    counts,
    materialExtensions,
    materialAlpha: {
      alphaModeCounts,
      blendCount: blend.length,
      blendAlphaOpaqueCount: blend.filter((entry) => entry.baseColorAlpha >= 0.99).length,
      blendAlphaPartialCount: blend.filter((entry) => entry.baseColorAlpha < 0.99).length,
      blendAlphaPartial: blend.filter((entry) => entry.baseColorAlpha < 0.99),
      doubleSidedCount: doubleSided,
      blendWithZWriteCount: blendWithZWrite,
      blendMaterials: blend,
    },
    vrm0MaterialFlags: vrm0Materials.length > 0
      ? {
          materialPropertyCount: vrm0Materials.length,
          keywordTrue,
          floatValues,
          colorAlphas,
          note: 'VRM0 exprs: three-vrm VRMMaterialsV0CompatPlugin rewrites glTF materials from these VRM0 materialProperties; alphaMode above is the on-disk glTF value and can disagree.',
        }
      : null,
  };
}

function sanitizeVrmJson(json) {
  const fixes = [];
  const rawStats = summarizeRawGltf(json);
  const textureCount = json.textures?.length ?? 0;
  for (const [materialIndex, material] of (json.materials || []).entries()) {
    const mtoon = material.extensions?.VRMC_materials_mtoon ?? material.extensions?.VRM_material;
    if (!mtoon) continue;
    for (const [key, value] of Object.entries(mtoon)) {
      if (!/texture/i.test(key)) continue;
      if (value != null && typeof value === 'object' && !(typeof value.index === 'number' && value.index >= 0 && value.index < textureCount)) {
        delete mtoon[key];
        fixes.push({
          materialIndex,
          material: material.name || `material#${materialIndex}`,
          key,
          invalidValue: value,
          patch: 'removed texture reference without a valid index before GLTFLoader.parse',
        });
      }
    }
  }
  return { fixes, rawStats };
}

async function fetchGlbWithPatches(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`fetch ${url} failed: HTTP ${response.status}`);
  const arrayBuffer = await response.arrayBuffer();
  try {
    const { buffer, fixes, rawStats } = patchGlbJson(arrayBuffer, sanitizeVrmJson);
    return { buffer, patches: fixes, rawStats };
  } catch (error) {
    warnings.push(`GLB in-memory patch skipped (${serializeArg(error)}); loading original bytes`);
    return { buffer: arrayBuffer, patches: [], rawStats: null };
  }
}

async function loadModel() {
  statusEl.textContent = 'loading…';
  modelLoad.startedAt = performance.now();
  const loader = new GLTFLoader();
  loader.register((parser) => new VRMLoaderPlugin(parser));
  const resolvedUrl = new URL(encodeURI(requestedPath), window.location.origin).href;

  let gltf;
  try {
    const { buffer, patches, rawStats } = await fetchGlbWithPatches(resolvedUrl);
    loadPatches = patches;
    rawGltfStats = rawStats;
    if (patches.length > 0) {
      warnings.push(
        `in-memory GLB patch applied: ${patches.map((patch) => `${patch.material}[${patch.key}] ${patch.patch}`).join('; ')}`,
      );
    }
    gltf = await loader.parseAsync(buffer, new URL('.', resolvedUrl).href);
  } catch (error) {
    loadErrors.push({ kind: 'load', url: resolvedUrl, message: serializeArg(error) });
    throw error;
  }

  const loadedVrm = gltf.userData.vrm;
  if (!loadedVrm) {
    const error = new Error('GLTFLoader finished but gltf.userData.vrm is missing (not a valid VRM)');
    loadErrors.push({ kind: 'not-a-vrm', url: resolvedUrl, message: error.message });
    throw error;
  }
  vrm = loadedVrm;
  embeddedAnimations = (gltf.animations || []).map((animation) => ({ name: animation.name, duration: animation.duration, tracks: animation.tracks.length }));
  gltfSource = summarizeGltfSource(gltf);
  modelLoad.finishedAt = performance.now();
  modelLoad.durationMs = Math.round(modelLoad.finishedAt - modelLoad.startedAt);

  // VRM 0.x faces -Z; three-vrm's compat helper rotates the whole scene by PI
  // so that both spec versions face +Z (VRM 1.0 convention).
  if (vrm.meta?.metaVersion === '0') {
    VRMUtils.rotateVRM0(vrm);
    rotateVRM0Applied = true;
    warnings.push('VRM 0.x detected: VRMUtils.rotateVRM0(vrm) applied (scene.rotation.y = PI)');
  }

  scene.add(vrm.scene);
  vrm.scene.updateMatrixWorld(true);

  skeletonHelper = new THREE.SkeletonHelper(vrm.scene);
  skeletonHelper.name = 'W0-4 SkeletonHelper';
  skeletonHelper.material.transparent = true;
  skeletonHelper.material.opacity = 0.45;
  skeletonHelper.material.depthTest = false;
  skeletonHelper.material.depthWrite = false;
  skeletonHelper.renderOrder = 999;
  scene.add(skeletonHelper);

  framing = computeFraming(vrm);
  facingDiag = computeFacing(vrm);
  expressionTest = testExpressions(vrm);
  setupIdleAnimation(vrm);
  if (params.get('forceOpaque') === '1' || params.get('forceOpaque') === 'true') {
    const stats = setForceOpaque(true);
    statusEl.dataset.forceOpaque = 'on';
    warnings.push(`forceOpaque=1: ${stats.changed.length} BLEND materials rendered opaque (alpha approx 1)`);
  }
  setView(initialView);
  statusEl.style.display = 'none';
  updateHud();
  return buildDiagnostics(rotateVRM0Applied);
}

function computeFraming(instance) {
  const bbox = new THREE.Box3().setFromObject(instance.scene);
  const center = bbox.getCenter(new THREE.Vector3());
  const size = bbox.getSize(new THREE.Vector3());
  const vFov = THREE.MathUtils.degToRad(camera.fov);
  const hFov = 2 * Math.atan(Math.tan(vFov / 2) * camera.aspect);
  const margin = 1.16;

  const distanceFor = (horizontalExtent, depthExtent) => {
    const distV = ((size.y / 2) * margin) / Math.tan(vFov / 2);
    const distH = ((horizontalExtent / 2) * margin) / Math.tan(hFov / 2);
    return Math.max(distV, distH) + depthExtent / 2 + 0.02;
  };

  return { bbox, center, size, distanceFor };
}

function setView(name) {
  if (!framing) return;
  const views = {
    front: { dir: new THREE.Vector3(0, 0, 1), horizontal: framing.size.x, depth: framing.size.z },
    side: { dir: new THREE.Vector3(1, 0, 0), horizontal: framing.size.z, depth: framing.size.x },
    back: { dir: new THREE.Vector3(0, 0, -1), horizontal: framing.size.x, depth: framing.size.z },
    threeQuarter: {
      dir: new THREE.Vector3(1, 0, 1).normalize(),
      horizontal: Math.max(framing.size.x, framing.size.z) * 0.75,
      depth: Math.max(framing.size.x, framing.size.z),
    },
  };
  const view = views[name];
  if (!view) throw new Error(`unknown view: ${name}`);
  const dist = framing.distanceFor(view.horizontal, view.depth);
  camera.position.copy(framing.center).addScaledVector(view.dir, dist);
  camera.lookAt(framing.center);
  camera.updateProjectionMatrix();
  currentView = name;
  updateHud();
}

/* -------------------------------------------------------------------------- */
/* facing heuristic                                                           */
/* -------------------------------------------------------------------------- */

function worldPosition(node) {
  if (!node) return null;
  return new THREE.Vector3().setFromMatrixPosition(node.matrixWorld);
}

function computeFacing(instance) {
  instance.scene.updateMatrixWorld(true);
  const raw = instance.humanoid?.rawHumanBones || {};
  const get = (name) => worldPosition(raw[name]?.node);

  const head = get('head');
  const leftEye = get('leftEye');
  const rightEye = get('rightEye');
  const eyeForward = head && leftEye && rightEye
    ? leftEye.clone().add(rightEye).multiplyScalar(0.5).sub(head)
    : null;

  const leftFoot = get('leftFoot');
  const rightFoot = get('rightFoot');
  const leftToes = get('leftToes');
  const rightToes = get('rightToes');
  let toeForward = null;
  if (leftFoot && leftToes) toeForward = leftToes.clone().sub(leftFoot);
  if (rightFoot && rightToes) {
    const right = rightToes.clone().sub(rightFoot);
    toeForward = toeForward ? toeForward.add(right).multiplyScalar(0.5) : right;
  }

  const yawDeg = (vec) => (vec ? THREE.MathUtils.radToDeg(Math.atan2(vec.x, vec.z)) : null);
  const eyeYawDeg = yawDeg(eyeForward);
  const toeYawDeg = yawDeg(toeForward);
  const toeHorizontal = toeForward ? Math.hypot(toeForward.x, toeForward.z) : 0;
  const eyeHorizontal = eyeForward ? Math.hypot(eyeForward.x, eyeForward.z) : 0;
  let source = null;
  let yaw = null;
  if (toeHorizontal > 0.01) {
    source = 'toes';
    yaw = toeYawDeg;
  } else if (eyeHorizontal > 0.005) {
    source = 'eyes';
    yaw = eyeYawDeg;
  }
  const cos = yaw == null ? null : Math.cos(THREE.MathUtils.degToRad(yaw));
  return {
    camera: 'front view camera is placed on +Z looking towards -Z',
    source,
    yawDeg: yaw == null ? null : Number(yaw.toFixed(2)),
    eyeForward: eyeForward ? eyeForward.toArray().map((n) => Number(n.toFixed(4))) : null,
    eyeYawDeg: eyeYawDeg == null ? null : Number(eyeYawDeg.toFixed(2)),
    toeForward: toeForward ? toeForward.toArray().map((n) => Number(n.toFixed(4))) : null,
    toeYawDeg: toeYawDeg == null ? null : Number(toeYawDeg.toFixed(2)),
    facesPlusZ: cos != null && cos > 0.7,
    facesMinusZ: cos != null && cos < -0.7,
    conclusion: yaw == null
      ? 'undetermined'
      : Math.abs(yaw) <= 45
        ? 'faces +Z'
        : Math.abs(yaw) >= 135
          ? 'faces -Z'
          : `faces yaw ${yaw.toFixed(1)}°`,
  };
}

/* -------------------------------------------------------------------------- */
/* expressions                                                                */
/* -------------------------------------------------------------------------- */

function morphInfluenceSum(instance) {
  let sum = 0;
  let active = 0;
  instance.scene.traverse((object) => {
    if (object.isMesh && Array.isArray(object.morphTargetInfluences)) {
      for (const influence of object.morphTargetInfluences) {
        if (influence > 0) {
          sum += influence;
          active += 1;
        }
      }
    }
  });
  return { sum, active };
}

/**
 * Prove the expression channel is live: for every registered expression set
 * weight to 1, run a VRM update, and check that morph-target influences move
 * (or that it at least has material/morph binds registered). Restores weights.
 */
function testExpressions(instance) {
  const manager = instance.expressionManager;
  const result = {
    success: false,
    names: [],
    bindCounts: {},
    morphEffects: {},
    failed: [],
  };
  if (!manager) return result;
  try {
    const expressions = manager.expressions || [];
    result.success = true;
    result.names = expressions.map((expression) => expression.expressionName);
    for (const expression of expressions) {
      const name = expression.expressionName;
      result.bindCounts[name] = expression.binds.length;
      const before = morphInfluenceSum(instance);
      manager.setValue(name, 1.0);
      instance.update(0);
      const after = morphInfluenceSum(instance);
      result.morphEffects[name] = {
        morphDelta: Number((after.sum - before.sum).toFixed(4)),
        activeMorphDelta: after.active - before.active,
      };
      manager.setValue(name, 0.0);
      instance.update(0);
      if (expression.binds.length === 0 && (after.sum - before.sum) === 0) {
        result.failed.push(name);
      }
    }
    manager.resetValues();
    instance.update(0);
  } catch (error) {
    result.success = false;
    result.error = serializeArg(error);
    loadErrors.push({ kind: 'expression-test', message: serializeArg(error) });
  }
  return result;
}

/* -------------------------------------------------------------------------- */
/* procedural idle animation (AnimationMixer over normalized humanoid bones)   */
/* -------------------------------------------------------------------------- */

const DEG = THREE.MathUtils.degToRad;

function buildIdleClip(instance) {
  const bones = {};
  for (const name of ['hips', 'spine', 'chest', 'upperChest', 'neck', 'head', 'leftUpperArm', 'rightUpperArm', 'leftLowerArm', 'rightLowerArm']) {
    const node = instance.humanoid.getNormalizedBoneNode(name);
    if (node) {
      node.name = `Norm_${name}`;
      bones[name] = node;
    }
  }
  const duration = 8;
  const steps = 8 * 24;
  const omega = (2 * Math.PI) / duration;
  const rest = {};
  for (const [name, node] of Object.entries(bones)) {
    rest[name] = { position: node.position.clone(), quaternion: node.quaternion.clone() };
  }
  // Small procedural idle layered on the rest pose: breathing bob, spine/neck
  // sway, head turn (the most visible channel), and gentle arm swing.
  const delta = {
    hips: (t) => [DEG(0.7) * Math.sin(omega * t), DEG(1.3) * Math.sin(omega * t), DEG(0.5) * Math.sin(2 * omega * t)],
    spine: (t) => [DEG(1.0) * Math.sin(2 * omega * t + 0.3), DEG(0.5) * Math.sin(omega * t + 0.8), DEG(0.4) * Math.sin(omega * t)],
    chest: (t) => [DEG(1.2) * Math.sin(2 * omega * t + 0.6), DEG(0.4) * Math.sin(omega * t), 0],
    upperChest: (t) => [DEG(1.2) * Math.sin(2 * omega * t + 0.9), DEG(0.4) * Math.sin(omega * t + 0.4), 0],
    neck: (t) => [DEG(0.8) * Math.sin(2 * omega * t + 1.1), DEG(0.8) * Math.sin(omega * t + 0.2), 0],
    head: (t) => [DEG(1.5) * Math.sin(2 * omega * t + 1.3), DEG(8.0) * Math.sin(omega * t), DEG(1.0) * Math.sin(omega * t + 0.5)],
    leftUpperArm: (t) => [DEG(1.5) * Math.sin(omega * t + 0.4), DEG(0.8) * Math.sin(omega * t), DEG(3.2) * Math.sin(2 * omega * t)],
    rightUpperArm: (t) => [DEG(1.5) * Math.sin(omega * t + 0.4 + Math.PI), DEG(0.8) * Math.sin(omega * t), -DEG(3.2) * Math.sin(2 * omega * t)],
    leftLowerArm: (t) => [0, 0, DEG(1.6) * Math.sin(2 * omega * t + 0.7)],
    rightLowerArm: (t) => [0, 0, -DEG(1.6) * Math.sin(2 * omega * t + 0.7)],
  };

  const tracks = [];
  const times = [];
  for (let i = 0; i <= steps; i++) times.push((i * duration) / steps);
  const animated = [];
  for (const [name, node] of Object.entries(bones)) {
    if (!delta[name]) continue;
    const values = [];
    for (const t of times) {
      const [rx, ry, rz] = delta[name](t);
      const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(rx, ry, rz));
      q.premultiply(rest[name].quaternion);
      values.push(q.x, q.y, q.z, q.w);
    }
    tracks.push(new THREE.QuaternionKeyframeTrack(`${node.name}.quaternion`, times, values));
    animated.push(name);
  }
  if (bones.hips) {
    const positions = [];
    for (const t of times) {
      const p = rest.hips.position.clone();
      p.y += 0.0055 * Math.sin(2 * omega * t);
      positions.push(p.x, p.y, p.z);
    }
    tracks.push(new THREE.VectorKeyframeTrack(`${bones.hips.name}.position`, times, positions));
  }
  return {
    clip: new THREE.AnimationClip('w0-4-procedural-idle', duration, tracks),
    animated,
    bones,
    rest,
    duration,
  };
}

function setupIdleAnimation(instance) {
  try {
    const built = buildIdleClip(instance);
    idleClip = built.clip;
    animatedBones.push(...built.animated);
    mixer = new THREE.AnimationMixer(instance.scene);
    const action = mixer.clipAction(idleClip);
    action.setLoop(THREE.LoopRepeat, Infinity);
    action.play();

    // Quantify the idle: rotate the mixer to a mid-cycle time and measure how
    // far the animated normalized bones moved away from their rest pose.
    mixer.setTime(0);
    instance.update(0);
    const sampleAt = 1.6;
    mixer.setTime(sampleAt);
    instance.update(0);
    let maxAngle = 0;
    let maxBone = null;
    const perBone = {};
    for (const name of built.animated) {
      const node = built.bones[name];
      const q = node.quaternion;
      const rest = built.rest[name].quaternion;
      const dot = Math.min(1, Math.abs(q.dot(rest)));
      const angle = THREE.MathUtils.radToDeg(2 * Math.acos(dot));
      perBone[name] = Number(angle.toFixed(2));
      if (angle > maxAngle) {
        maxAngle = angle;
        maxBone = name;
      }
    }

    // Loop continuity: pose at t=duration must match t=0.
    mixer.setTime(0);
    instance.update(0);
    const loopStart = Object.fromEntries(built.animated.map((name) => [name, built.bones[name].quaternion.clone()]));
    mixer.setTime(built.duration);
    instance.update(0);
    let loopGap = 0;
    for (const name of built.animated) {
      const dot = Math.min(1, Math.abs(built.bones[name].quaternion.dot(loopStart[name])));
      loopGap = Math.max(loopGap, THREE.MathUtils.radToDeg(2 * Math.acos(dot)));
    }
    mixer.setTime(0);
    instance.update(0);

    idleMotion.mixerDriven = true;
    idleMotion.clipName = idleClip.name;
    idleMotion.clipDurationSec = idleClip.duration;
    idleMotion.trackCount = idleClip.tracks.length;
    idleMotion.animatedBones = built.animated;
    idleMotion.sampleAtSec = sampleAt;
    idleMotion.perBoneAngleDegAtSample = perBone;
    idleMotion.maxAngleDeg = Number(maxAngle.toFixed(2));
    idleMotion.maxAngleBone = maxBone;
    idleMotion.loopGapDeg = Number(loopGap.toFixed(4));
    idleMotion.playback = 'AnimationMixer.clipAction(...).play() advanced by mixer.update(dt) every frame';
  } catch (error) {
    loadErrors.push({ kind: 'idle-animation', message: serializeArg(error) });
    idleMotion.error = serializeArg(error);
  }
}

/* -------------------------------------------------------------------------- */
/* per-frame expression scheduling + HUD                                      */
/* -------------------------------------------------------------------------- */

let hudAccumulator = 0;
let lastHudText = '';

function applyScheduledExpressions(t) {
  const manager = vrm?.expressionManager;
  if (!manager) return;

  // blink: 160 ms closed window every 3.2 s
  const blinkPeriod = 3.2;
  const blinkWindow = 0.16;
  const blinkPhase = t % blinkPeriod;
  const blinkInWindow = blinkPhase < blinkWindow;
  if (blinkInWindow && !runtime.blinkWindowState) runtime.blinkCycles += 1;
  runtime.blinkWindowState = blinkInWindow;
  const blinkWeight = blinkInWindow ? Math.sin((Math.PI * blinkPhase) / blinkWindow) : 0;
  runtime.blinkPeak = Math.max(runtime.blinkPeak, blinkWeight);
  if (manager.getExpression('blink')) manager.setValue('blink', blinkWeight);

  // happy: smooth 1.2 s smile every 9 s, offset to show up in the 10 s reel
  const happyPeriod = 9;
  const happyPhase = t % happyPeriod;
  const happyInWindow = happyPhase >= 4.0 && happyPhase <= 5.2;
  if (happyInWindow && !runtime.happyWindowState) runtime.happyCycles += 1;
  runtime.happyWindowState = happyInWindow;
  let happyWeight = 0;
  if (happyInWindow) {
    const p = (happyPhase - 4.0) / 1.2;
    happyWeight = Math.sin(Math.PI * p) ** 2;
  }
  runtime.happyPeak = Math.max(runtime.happyPeak, happyWeight);
  if (manager.getExpression('happy')) manager.setValue('happy', happyWeight);
}

function updateHud() {
  if (!vrm) {
    hud.textContent = 'AVENTURINE W0-4 VRM VIEWER\nloading…';
    return;
  }
  const expressions = (vrm.expressionManager?.expressions || []).map((e) => e.expressionName);
  const materials = collectMaterialStats(vrm);
  const textures = collectTextureStats(vrm);
  const lines = [
    'AVENTURINE W0-4 VRM VIEWER  (three r' + THREE_VERSION + ' / three-vrm 3.5.5)',
    `model: ${requestedPath.split('/').pop()}  [VRM ${vrm.meta?.metaVersion === '0' ? '0.x' : '1.0'}]`,
    `bones: ${Object.keys(vrm.humanoid?.normalizedHumanBones || {}).length} normalized / ${Object.keys(vrm.humanoid?.rawHumanBones || {}).length} raw`,
    `expressions (${expressions.length}): ${expressions.join(', ')}`,
    `materials: ${materials.mtoon} MToon / ${materials.total} total | textures: ${textures.images} images / ${textures.total} texture objects (failed ${textures.failed})`,
    `springBone: ${springBoneStats().jointCount} joints | lookAt: ${lookAtStats().present ? lookAtStats().applier : 'none'}`,
    `height: ${(framing?.size.y || 0).toFixed(3)} m | bbox: ${framing ? framing.size.toArray().map((n) => n.toFixed(2)).join(' x ') : '-'}`,
    `facing: ${facingDiag.conclusion || '?'} (${facingDiag.source || '?'}) | view: ${currentView} | fps: ${fps}`,
    `skeleton: ${skeletonHelper?.visible ? 'on' : 'off'} | forceOpaque: ${forceOpaqueActive ? 'on' : 'off'} | blink peaks: ${runtime.blinkPeak.toFixed(2)} | loadErrors: ${loadErrors.length + pageErrors.length}`,
  ];
  const text = lines.join('\n');
  if (text !== lastHudText) {
    hud.textContent = text;
    lastHudText = text;
  }
}

function animate() {
  const dt = Math.min(clock.getDelta(), 0.1);
  frameCount += 1;
  const t = clock.elapsedTime;
  try {
    if (vrm) {
      if (mixer) mixer.update(dt);
      applyScheduledExpressions(t);
      vrm.update(dt);
    }
    renderer.render(scene, camera);
  } catch (error) {
    pageErrors.push({
      t: Math.round(performance.now()),
      kind: 'render-loop',
      message: serializeArg(error),
      stack: error?.stack || null,
    });
    renderer.setAnimationLoop(null);
  }
  fpsWindow.frames += 1;
  const now = performance.now();
  if (now - fpsWindow.start >= 500) {
    fps = Math.round((fpsWindow.frames * 1000) / (now - fpsWindow.start));
    fpsWindow = { start: now, frames: 0 };
    updateHud();
  }
  hudAccumulator += dt;
}

/* -------------------------------------------------------------------------- */
/* stats helpers                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Raw glTF/VRM counts straight from the parsed JSON chunk, so the report can
 * distinguish "embedded texture images" (13/20 in the GLB) from "THREE.Texture
 * objects created by three-vrm material compat" (one clone per MToon slot).
 */
function summarizeGltfSource(gltf) {
  const json = gltf.parser?.json || {};
  const materials = json.materials || [];
  const vrm0 = json.extensions?.VRM;
  const vrm1 = json.extensions?.VRMC_vrm;
  return {
    assetVersion: json.asset?.version ?? null,
    extensionsUsed: json.extensionsUsed || [],
    extensionsRequired: json.extensionsRequired || [],
    counts: {
      scenes: json.scenes?.length ?? null,
      nodes: json.nodes?.length ?? null,
      meshes: json.meshes?.length ?? null,
      primitives: (json.meshes || []).reduce((sum, mesh) => sum + (mesh.primitives?.length || 0), 0),
      materials: materials.length,
      textures: json.textures?.length ?? null,
      images: json.images?.length ?? null,
      skins: json.skins?.length ?? null,
      animations: json.animations?.length ?? 0,
      accessors: json.accessors?.length ?? null,
    },
    materialExtensions: {
      VRMC_materials_mtoon: materials.filter((material) => material.extensions?.VRMC_materials_mtoon).length,
      VRM_material: materials.filter((material) => material.extensions?.VRM_material).length,
      KHR_materials_unlit: materials.filter((material) => material.extensions?.KHR_materials_unlit).length,
    },
    materialAlpha: (() => {
      const alphaModeCounts = {};
      const blend = [];
      let doubleSided = 0;
      for (const material of materials) {
        const alphaMode = material.alphaMode || 'OPAQUE';
        alphaModeCounts[alphaMode] = (alphaModeCounts[alphaMode] || 0) + 1;
        if (material.doubleSided) doubleSided += 1;
        if (alphaMode === 'BLEND') {
          const baseColorAlpha = material.pbrMetallicRoughness?.baseColorFactor?.[3] ?? 1;
          blend.push({
            name: material.name || null,
            baseColorAlpha,
            baseColorTexture: material.pbrMetallicRoughness?.baseColorTexture?.index ?? null,
            doubleSided: Boolean(material.doubleSided),
          });
        }
      }
      return {
        alphaModeCounts,
        blendCount: blend.length,
        blendAlphaOpaqueCount: blend.filter((entry) => entry.baseColorAlpha >= 0.99).length,
        blendAlphaPartialCount: blend.filter((entry) => entry.baseColorAlpha < 0.99).length,
        blendAlphaPartial: blend.filter((entry) => entry.baseColorAlpha < 0.99),
        doubleSidedCount: doubleSided,
        blendMaterials: blend,
      };
    })(),
    imageNames: (json.images || []).map((image) => image.name || null),
    vrm0: vrm0
      ? {
          specVersion: vrm0.specVersion ?? null,
          exporterVersion: vrm0.exporterVersion ?? null,
          title: vrm0.meta?.title ?? null,
          humanBoneCount: (vrm0.humanoid?.humanBones || []).length,
          blendShapeGroupCount: (vrm0.blendShapeMaster?.blendShapeGroups || []).length,
          blendShapePresetNames: [...new Set((vrm0.blendShapeMaster?.blendShapeGroups || []).map((group) => group.presetName))],
          materialPropertyCount: (vrm0.materialProperties || []).length,
          materialShaders: [...new Set((vrm0.materialProperties || []).map((entry) => entry.shader))],
          secondaryAnimation: {
            boneGroups: (vrm0.secondaryAnimation?.boneGroups || []).length,
            colliderGroups: (vrm0.secondaryAnimation?.colliderGroups || []).length,
          },
          lookAtTypeName: vrm0.firstPerson?.lookAtTypeName ?? null,
        }
      : null,
    vrm1: vrm1
      ? {
          specVersion: vrm1.specVersion ?? null,
          name: vrm1.meta?.name ?? null,
          humanBoneCount: Object.keys(vrm1.humanoid?.humanBones || {}).length,
          expressionPresets: Object.keys(vrm1.expressions?.preset || {}),
          customExpressions: Object.keys(vrm1.expressions?.custom || {}),
          lookAtPresent: Boolean(vrm1.lookAt),
          springBonePresent: Boolean(vrm1.springBone),
        }
      : null,
  };
}

function collectMaterialStats(instance) {
  const materials = new Set();
  instance.scene.traverse((object) => {
    if (!object.material) return;
    const list = Array.isArray(object.material) ? object.material : [object.material];
    for (const material of list) materials.add(material);
  });
  let mtoon = 0;
  let withBaseColorTexture = 0;
  let transparent = 0;
  let depthWriteFalse = 0;
  let doubleSided = 0;
  const names = [];
  const blendOpaqueAlpha = [];
  const blendPartialAlpha = [];
  for (const material of materials) {
    const isMToon = material instanceof MToonMaterial || material.isMToonMaterial === true || material.type === 'MToonMaterial';
    if (isMToon) mtoon += 1;
    if (material.map) withBaseColorTexture += 1;
    if (material.transparent === true) {
      transparent += 1;
      if (material.depthWrite === false) depthWriteFalse += 1;
      if ((material.opacity ?? 1) >= 0.99) blendOpaqueAlpha.push(material.name || material.type);
      else blendPartialAlpha.push({ name: material.name || material.type, opacity: material.opacity });
    }
    if (material.side === THREE.DoubleSide) doubleSided += 1;
    names.push(material.name || material.type);
  }
  return {
    total: materials.size,
    mtoon,
    withBaseColorTexture,
    transparent,
    depthWriteFalse,
    doubleSided,
    blendOpaqueAlpha,
    blendPartialAlpha,
    names: names.sort(),
  };
}

/**
 * Debug switch for the W0 "BLEND-mislabelled-as-opaque" problem: mmd/模之屋
 * exports often mark opaque materials as `alphaMode: BLEND` with
 * baseColorFactor[3] === 1. three/MToon then renders them in the transparent
 * pass with depthWrite = false, so overlapping double-sided surfaces blend
 * together (ghostly / washed-out look). This helper flips only BLEND materials
 * whose alpha is ~1 back to opaque+depthWrite, and leaves real translucent
 * overlays (目影 / 颜赤 etc., alpha < 1) untouched.
 *
 * Enabled automatically with `?forceOpaque=1`; also exposed as an API for the
 * capture driver (aventurine/front-force-opaque.png comparison).
 */
function setForceOpaque(enabled) {
  if (!vrm) return null;
  const stats = { enabled: Boolean(enabled), changed: [], keptTransparent: [], alreadyOpaque: 0, restored: 0 };
  const seen = new Set();
  vrm.scene.traverse((object) => {
    if (!object.material) return;
    const list = Array.isArray(object.material) ? object.material : [object.material];
    for (const material of list) {
      if (seen.has(material)) continue;
      seen.add(material);
      const isMToon = material instanceof MToonMaterial || material.isMToonMaterial === true || material.type === 'MToonMaterial';
      if (!isMToon) continue;
      if (!material.userData.__w04OriginalState) {
        material.userData.__w04OriginalState = {
          transparent: material.transparent,
          depthWrite: material.depthWrite,
        };
      }
      if (enabled) {
        if (material.transparent === true && (material.opacity ?? 1) >= 0.99) {
          material.transparent = false;
          material.depthWrite = true;
          material.needsUpdate = true;
          stats.changed.push(material.name || material.type);
        } else if (material.transparent === true) {
          stats.keptTransparent.push({ name: material.name || material.type, opacity: material.opacity });
        } else {
          stats.alreadyOpaque += 1;
        }
      } else {
        const original = material.userData.__w04OriginalState;
        material.transparent = original.transparent;
        material.depthWrite = original.depthWrite;
        material.needsUpdate = true;
        stats.restored += 1;
      }
    }
  });
  forceOpaqueActive = Boolean(enabled);
  forceOpaqueStats = stats;
  return stats;
}

const TEXTURE_SLOTS = [
  'map', 'normalMap', 'emissiveMap', 'aoMap', 'alphaMap', 'bumpMap', 'displacementMap',
  'lightMap', 'metalnessMap', 'roughnessMap', 'envMap', 'shadeColorTexture', 'shadeMultiplyTexture',
  'shadingShiftTexture', 'matcapTexture', 'rimTexture', 'outlineWidthTexture', 'receiveShadowTexture',
];

function collectTextureStats(instance) {
  const textures = new Map();
  instance.scene.traverse((object) => {
    if (!object.material) return;
    const list = Array.isArray(object.material) ? object.material : [object.material];
    for (const material of list) {
      for (const slot of TEXTURE_SLOTS) {
        const value = material[slot];
        if (value && value.isTexture && !textures.has(value.uuid)) {
          textures.set(value.uuid, { texture: value, slots: [] });
        }
        if (value && value.isTexture) textures.get(value.uuid)?.slots.push(`${material.name || material.type}.${slot}`);
      }
    }
  });
  let failed = 0;
  const list = [];
  const images = new Map();
  for (const { texture, slots } of textures.values()) {
    const image = texture.image;
    const width = image?.width ?? image?.videoWidth ?? 0;
    const height = image?.height ?? image?.videoHeight ?? 0;
    if (!width || !height) failed += 1;
    if (image && !images.has(image)) {
      images.set(image, {
        name: texture.name || null,
        colorSpace: texture.colorSpace,
        width,
        height,
        textureSlots: [],
      });
    }
    if (image) images.get(image)?.textureSlots.push(...slots.map((slot) => slot.split('.').slice(-1)[0]));
    list.push({
      name: texture.name || null,
      colorSpace: texture.colorSpace,
      width,
      height,
      slots: [...new Set(slots)],
    });
  }
  return {
    // unique THREE.Texture objects touched by materials
    total: textures.size,
    // unique source images (GLB embedded textures)
    images: images.size,
    failed,
    list,
    imageList: [...images.values()].map((entry) => ({ ...entry, textureSlots: [...new Set(entry.textureSlots)] })),
  };
}

function springBoneStats() {
  const manager = vrm?.springBoneManager;
  if (!manager) return { present: false, jointCount: 0, chainCount: 0 };
  const joints = manager.joints?.size ?? manager.joints?.length ?? 0;
  const chains = manager.springBoneChains?.length ?? 0;
  return { present: joints > 0, jointCount: joints, chainCount: chains };
}

function lookAtStats() {
  const lookAt = vrm?.lookAt;
  if (!lookAt) return { present: false, applier: null, type: null };
  return {
    present: true,
    applier: lookAt.applier?.constructor?.name || 'unknown',
    type: lookAt.applier?.constructor?.name?.includes('Expression') ? 'expression' : 'bone',
    offsetFromHeadBone: lookAt.offsetFromHeadBone?.toArray().map((n) => Number(n.toFixed(4))) || null,
  };
}

function nodeConstraintStats() {
  const manager = vrm?.nodeConstraintManager;
  if (!manager) return { present: false, count: 0 };
  return { present: true, count: manager._constraints?.length ?? 0 };
}

function rendererInfo() {
  const gl = renderer.getContext();
  const debug = gl.getExtension('WEBGL_debug_renderer_info');
  return {
    webglVersion: gl.getParameter(gl.VERSION),
    shadingLanguage: gl.getParameter(gl.SHADING_LANGUAGE_VERSION),
    vendor: debug ? gl.getParameter(debug.UNMASKED_VENDOR_WEBGL) : gl.getParameter(gl.VENDOR),
    renderer: debug ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER),
    outputColorSpace: renderer.outputColorSpace,
    toneMapping: 'NoToneMapping',
    clearAlpha: renderer.getClearAlpha(),
  };
}

function v0RenameProof(instance) {
  const manager = instance.expressionManager;
  if (!manager) return null;
  if (instance.meta?.metaVersion !== '0') return null;
  const names = new Set((manager.expressions || []).map((e) => e.expressionName));
  const expected = {
    joy: 'happy',
    blink_l: 'blinkLeft',
    blink_r: 'blinkRight',
    a: 'aa',
    i: 'ih',
    u: 'ou',
    e: 'ee',
    o: 'oh',
  };
  const proof = {};
  for (const [v0, v1] of Object.entries(expected)) {
    proof[v0] = { v0NameRegistered: names.has(v0), v1NameRegistered: names.has(v1), renamedCorrectly: !names.has(v0) && names.has(v1) };
  }
  return {
    mapping: expected,
    allRenamedCorrectly: Object.values(proof).every((entry) => entry.renamedCorrectly),
    proof,
  };
}

function buildDiagnostics(rotateVRM0Applied) {
  const materials = collectMaterialStats(vrm);
  const textures = collectTextureStats(vrm);
  const spring = springBoneStats();
  const lookAt = lookAtStats();
  const constraints = nodeConstraintStats();
  const normalizedBones = Object.keys(vrm.humanoid?.normalizedHumanBones || {}).sort();
  const rawBones = Object.keys(vrm.humanoid?.rawHumanBones || {}).sort();
  const required = ['hips', 'spine', 'head', 'leftUpperArm', 'leftLowerArm', 'leftHand', 'rightUpperArm', 'rightLowerArm', 'rightHand', 'leftUpperLeg', 'leftLowerLeg', 'leftFoot', 'rightUpperLeg', 'rightLowerLeg', 'rightFoot'];
  const expressionNames = (vrm.expressionManager?.expressions || []).map((e) => e.expressionName);
  const bbox = framing?.bbox;
  return {
    viewer: {
      name: 'W0-4 canary viewer',
      three: `r${THREE_VERSION}`,
      threeVrm: '3.5.5',
      url: window.location.href,
      canvas: { width: canvas.width, height: canvas.height },
      renderer: rendererInfo(),
      generatedAt: new Date().toISOString(),
    },
    model: {
      requestedPath,
      resolvedUrl: new URL(encodeURI(requestedPath), window.location.origin).href,
      fileName: requestedPath.split('/').pop(),
      specVersion: vrm.meta?.metaVersion === '0' ? '0.x' : '1.0',
      metaVersion: vrm.meta?.metaVersion ?? null,
      meta: {
        title: vrm.meta?.title ?? vrm.meta?.name ?? null,
        version: vrm.meta?.version ?? null,
        author: vrm.meta?.author ?? null,
        license: vrm.meta?.licenseName ?? vrm.meta?.licenseUrl ?? null,
        thumbnailTexture: Boolean(vrm.meta?.thumbnailTexture),
      },
      rotateVRM0Applied,
      loadDurationMs: modelLoad.durationMs,
      loadPatch: loadPatches,
      gltfSource,
      gltfSourceRaw: rawGltfStats,
      heightMeters: Number((framing?.size.y ?? 0).toFixed(4)),
      bbox: bbox
        ? {
            min: bbox.min.toArray().map((n) => Number(n.toFixed(4))),
            max: bbox.max.toArray().map((n) => Number(n.toFixed(4))),
            size: bbox.getSize(new THREE.Vector3()).toArray().map((n) => Number(n.toFixed(4))),
            center: bbox.getCenter(new THREE.Vector3()).toArray().map((n) => Number(n.toFixed(4))),
          }
        : null,
      humanoid: {
        normalizedBoneCount: normalizedBones.length,
        rawBoneCount: rawBones.length,
        normalizedBoneNames: normalizedBones,
        missingRequiredBones: required.filter((name) => !normalizedBones.includes(name)),
        autoUpdateHumanBones: vrm.humanoid?.autoUpdateHumanBones ?? null,
      },
      expressions: {
        count: expressionNames.length,
        names: expressionNames,
        v0RenameProof: v0RenameProof(vrm),
        runtimeTest: expressionTest,
      },
      materials: {
        total: materials.total,
        mtoon: materials.mtoon,
        withBaseColorTexture: materials.withBaseColorTexture,
        transparent: materials.transparent,
        depthWriteFalse: materials.depthWriteFalse,
        doubleSided: materials.doubleSided,
        blendOpaqueAlpha: materials.blendOpaqueAlpha,
        blendPartialAlpha: materials.blendPartialAlpha,
        names: materials.names,
      },
      forceOpaque: {
        available: true,
        queryParam: params.get('forceOpaque'),
        active: forceOpaqueActive,
        lastStats: forceOpaqueStats,
      },
      textures: {
        total: textures.total,
        images: textures.images,
        failed: textures.failed,
        list: textures.list,
        imageList: textures.imageList,
      },
      springBone: spring,
      lookAt,
      nodeConstraints: constraints,
      firstPerson: {
        present: Boolean(vrm.firstPerson),
        meshAnnotationCount: vrm.firstPerson?.meshAnnotations?.length ?? 0,
      },
      embeddedAnimations,
      facing: facingDiag,
    },
    idleAnimation: idleMotion,
    expressionRuntime: {
      blinkPeriodSec: 3.2,
      blinkWindowSec: 0.16,
      happyPeriodSec: 9,
      blinkCycles: runtime.blinkCycles,
      blinkPeak: Number(runtime.blinkPeak.toFixed(4)),
      happyCycles: runtime.happyCycles,
      happyPeak: Number(runtime.happyPeak.toFixed(4)),
      driver: 'vrm.expressionManager.setValue() every frame (VRMExpressionManager applies morph/material binds in vrm.update)',
    },
    views: {
      available: VIEW_NAMES,
      current: currentView,
      camera: {
        fov: camera.fov,
        position: camera.position.toArray().map((n) => Number(n.toFixed(4))),
        framedCenter: framing?.center.toArray().map((n) => Number(n.toFixed(4))) ?? null,
      },
    },
    runtime: {
      frameCount,
      fps,
      rendererInfo: renderer.info.render,
      loadErrors,
      pageErrors,
      warnings,
    },
    skeletonHelper: {
      present: Boolean(skeletonHelper),
      visible: skeletonHelper?.visible ?? null,
      opacity: skeletonHelper?.material?.opacity ?? null,
    },
  };
}

/* -------------------------------------------------------------------------- */
/* capture / recording API                                                    */
/* -------------------------------------------------------------------------- */

function dataUrlToBlob(dataUrl) {
  const [header, base64] = dataUrl.split(',');
  const mime = /:(.*?);/.exec(header)?.[1] || 'application/octet-stream';
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: mime });
}

async function postEvidence(relativePath, blob) {
  const response = await fetch(`/__evidence?file=${encodeURIComponent(relativePath)}`, {
    method: 'POST',
    headers: { 'Content-Type': blob.type || 'application/octet-stream' },
    body: blob,
  });
  if (!response.ok) {
    throw new Error(`evidence POST failed (${response.status}): ${await response.text()}`);
  }
  return response.json();
}

function nextFrames(count = 2) {
  return new Promise((resolve) => {
    let remaining = count;
    const step = () => {
      remaining -= 1;
      if (remaining <= 0) resolve();
      else requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  });
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function captureView(viewName) {
  setView(viewName);
  await nextFrames(2);
  renderer.render(scene, camera);
  const t = Math.round(performance.now());
  const dataUrl = canvas.toDataURL('image/png');
  return { dataUrl, t };
}

async function captureAndPost(relativePath, viewName) {
  if (!vrm) throw new Error('captureAndPost called before model ready');
  const { dataUrl, t } = await captureView(viewName);
  const blob = dataUrlToBlob(dataUrl);
  const posted = await postEvidence(relativePath, blob);
  return {
    view: viewName,
    file: relativePath,
    width: canvas.width,
    height: canvas.height,
    bytes: blob.size,
    postedAtMs: t,
    server: posted,
  };
}

function setBackdrop(mode) {
  if (mode === 'studio') {
    scene.background = new THREE.Color(0x1c2635);
    renderer.setClearAlpha(1);
  } else {
    scene.background = null;
    renderer.setClearColor(0x000000, 0);
    renderer.setClearAlpha(0);
  }
}

async function recordAndPost(relativePath, durationMs = 10000, viewName = 'front') {
  if (!vrm) throw new Error('recordAndPost called before model ready');
  setView(viewName);
  setBackdrop('studio');
  await nextFrames(3);

  const mimeCandidates = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'];
  const mimeType = mimeCandidates.find((candidate) => MediaRecorder.isTypeSupported(candidate));
  if (!mimeType) throw new Error('no supported MediaRecorder webm mime type');

  const stream = canvas.captureStream(30);
  const recorder = new MediaRecorder(stream, {
    mimeType,
    videoBitsPerSecond: 6_000_000,
  });
  const chunks = [];
  recorder.ondataavailable = (event) => {
    if (event.data && event.data.size > 0) chunks.push(event.data);
  };
  const startedAt = performance.now();
  const startedFrames = frameCount;
  const stopped = new Promise((resolve, reject) => {
    recorder.onstop = () => resolve(performance.now());
    recorder.onerror = (event) => reject(event.error || new Error('MediaRecorder error'));
  });
  recorder.start(200);
  await sleep(durationMs);
  recorder.requestData();
  recorder.stop();
  const stoppedAt = await stopped;
  const blob = new Blob(chunks, { type: mimeType });
  const posted = await postEvidence(relativePath, blob);
  stream.getTracks().forEach((track) => track.stop());
  setBackdrop('transparent');
  return {
    file: relativePath,
    mimeType,
    requestedDurationMs: durationMs,
    durationMs: Math.round(stoppedAt - startedAt),
    sizeBytes: blob.size,
    frames: frameCount - startedFrames,
    averageFps: Number(((frameCount - startedFrames) / ((stoppedAt - startedAt) / 1000)).toFixed(1)),
    server: posted,
  };
}

function poseSnapshot() {
  const out = {};
  for (const name of animatedBones) {
    const node = vrm?.humanoid?.getNormalizedBoneNode(name);
    if (!node) continue;
    out[name] = {
      quaternion: node.quaternion.toArray().map((n) => Number(n.toFixed(5))),
      position: node.position.toArray().map((n) => Number(n.toFixed(5))),
    };
  }
  return out;
}

/**
 * Capture two canvas frames ~intervalMs apart and measure the normalized-bone
 * pose delta between them. Used as objective proof that the procedural idle is
 * actually animating the humanoid skeleton (and visible in the rendered pixels).
 */
async function captureMotionPair(prefix, intervalMs = 2400) {
  if (!vrm) throw new Error('captureMotionPair called before model ready');
  setView('front');
  await nextFrames(2);
  const poseA = poseSnapshot();
  const startedAt = performance.now();
  const first = await captureAndPost(`${prefix}-a.png`, 'front');
  await sleep(intervalMs);
  const second = await captureAndPost(`${prefix}-b.png`, 'front');
  const poseB = poseSnapshot();
  let maxAngle = 0;
  let maxBone = null;
  const perBone = {};
  for (const [name, a] of Object.entries(poseA)) {
    const b = poseB[name];
    if (!b) continue;
    const qa = new THREE.Quaternion().fromArray(a.quaternion);
    const qb = new THREE.Quaternion().fromArray(b.quaternion);
    const dot = Math.min(1, Math.abs(qa.dot(qb)));
    const angle = THREE.MathUtils.radToDeg(2 * Math.acos(dot));
    perBone[name] = Number(angle.toFixed(2));
    if (angle > maxAngle) {
      maxAngle = angle;
      maxBone = name;
    }
  }
  return {
    firstFile: first.file,
    secondFile: second.file,
    intervalMs,
    actualIntervalMs: Math.round(performance.now() - startedAt),
    maxBoneAngleDeltaDeg: Number(maxAngle.toFixed(2)),
    maxBone,
    perBoneAngleDeltaDeg: perBone,
    poseA,
    poseB,
    framesRendered: frameCount,
  };
}

/* -------------------------------------------------------------------------- */
/* public API                                                                 */
/* -------------------------------------------------------------------------- */

window.__aventurineViewer = {
  ready,
  get version() {
    return { three: `r${THREE_VERSION}`, threeVrm: '3.5.5', viewer: 'w0-4-canary-viewer' };
  },
  diagnostics: () => buildDiagnostics(rotateVRM0Applied),
  setView,
  views: VIEW_NAMES,
  setBackdrop,
  setForceOpaque,
  getForceOpaqueStats: () => ({ active: forceOpaqueActive, stats: forceOpaqueStats }),
  setSkeletonVisible(visible) {
    if (skeletonHelper) skeletonHelper.visible = Boolean(visible);
    updateHud();
    return skeletonHelper?.visible ?? null;
  },
  captureView,
  captureAndPost,
  recordAndPost,
  captureMotionPair,
  poseSnapshot,
  collectLogs() {
    return { consoleLogs, pageErrors, loadErrors, warnings };
  },
  getState() {
    return { loaded: Boolean(vrm), currentView, frameCount, fps };
  },
};

/* -------------------------------------------------------------------------- */
/* boot                                                                       */
/* -------------------------------------------------------------------------- */

updateHud();
loadModel()
  .then((diagnostics) => {
    console.log('[W0-4 viewer] model ready', JSON.stringify({ model: diagnostics.model.fileName, bones: diagnostics.model.humanoid.normalizedBoneCount, expressions: diagnostics.model.expressions.count }));
    readyResolve(diagnostics);
  })
  .catch((error) => {
    statusEl.textContent = `load failed: ${error?.message || error}`;
    statusEl.style.display = 'block';
    updateHud();
    console.error('[W0-4 viewer] load failed', serializeArg(error));
    readyReject(error);
  });

renderer.setAnimationLoop(animate);
