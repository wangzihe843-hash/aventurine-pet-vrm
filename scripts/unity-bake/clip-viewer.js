/**
 * U2 动作预览/度量器（dev-only）：three-vrm 加载 VRM，把 clip JSON
 * （归一化 humanoid 旋转 + Hips 位移）应用到 normalized humanoid 骨骼，渲染静帧并度量天然度。
 *
 * 用法（由 preview-clips.mjs 用 Electron 驱动）：
 *   /scripts/unity-bake/clip-viewer.html?vrm=assets/vrm/aventurine-waveflair.vrm
 *
 * 骨骼映射来自 `lib/humanoid-map.mjs`（浏览器原生 ESM，preview server 直接服务 .mjs）。
 *
 * window.__clipViewer:
 *   ready                       Promise<info>
 *   loadClip(url)               Promise<{clip, frames, fps, duration}>
 *   captureAt(tSec)             dataURL（PNG，带帧间 slerp）
 *   metrics()                   Promise<Object> 全 clip 逐帧度量（世界空间骨位置 + 自然度指标）
 *   resetPose()                 全部 normalized 骨恢复 rest（并 humanoid.update()）
 *   setView('front'|'side'|'threeQuarter')
 *   probe() / info()
 */
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { VRMLoaderPlugin, VRMUtils } from '@pixiv/three-vrm';
import { UNITY_TO_VRM_BONE } from './lib/humanoid-map.mjs';
import { computeRotationMetrics } from './lib/clip-validation.mjs';

const params = new URLSearchParams(location.search);
const asRootUrl = (p) => (/^https?:/i.test(p) ? p : '/' + String(p).replace(/^\/+/, ''));
const vrmPath = params.get('vrm') || 'assets/vrm/aventurine-waveflair.vrm';
// 朝向修正（度；与 src/shared/vrm.ts 的 `yawOffsetDeg` 同语义）：
// 载入并 rotateVRM0 归一化后，模型按 +Z 面向；填 180 表示该资产实测面向 -Z，
// 需要绕 Y 转 180° 统一到 +Z 面朝相机（相机在 +Z 侧取景）。
const yawDeg = Number(params.get('yaw') || '0') || 0;
const W = 600;
const H = 800;

/** Unity HumanBodyBones 名 → three-vrm normalized humanoid 骨骼名（与 lib 共用同一份映射）。 */
const BONE_MAP = UNITY_TO_VRM_BONE;

/** metrics() 输出的世界空间骨骼（另有膝/髋辅助骨只用于计算，不全部导出）。 */
const METRIC_POSITION_BONES = [
  'hips',
  'head',
  'leftFoot',
  'rightFoot',
  'leftToes',
  'rightToes',
  'leftLowerLeg',
  'rightLowerLeg',
  'leftHand',
  'rightHand'
];
/** 计算 kneeFlex 需要的大腿骨世界位置（不写进 positions，避免文件过大）。 */
const THIGH_BONES = { left: 'leftUpperLeg', right: 'rightUpperLeg' };
const ALL_RAW_READ_BONES = [...METRIC_POSITION_BONES, ...Object.values(THIGH_BONES)];

const canvas = document.getElementById('viewer');
const renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true, preserveDrawingBuffer: true });
renderer.setPixelRatio(1);
renderer.setSize(W, H, false);
renderer.outputColorSpace = THREE.SRGBColorSpace;

const scene = new THREE.Scene();
scene.add(new THREE.HemisphereLight(0xffffff, 0x445566, 2.2));
const dir = new THREE.DirectionalLight(0xffffff, 2.0);
dir.position.set(2, 3, 4);
scene.add(dir);
const fill = new THREE.DirectionalLight(0xffffff, 0.8);
fill.position.set(-3, 1, 2);
scene.add(fill);

const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.01, 100);
let vrm = null;
let clip = null;
let rest = new Map(); // vrmBoneName -> { q: Quaternion, p: Vector3 }
let targetHeight = 1.7;
let scale = 1.0;
/** 源合成 rig 的 hips 高度（米）：ClipExporter 的合成骨架 hips localPosition=(0,1,0)。 */
const CLIP_SOURCE_HIPS_HEIGHT = 1.0;
/** 本模型的 hips 高度（normalized rest，米）；用于 Hips 位移按 hips 高比的官方缩放。 */
let modelHipsHeight = 1.0;
let viewName = 'front';
let center = new THREE.Vector3();
let bboxSize = new THREE.Vector3(1, 1.8, 0.4);

const round6 = (value) => Number(value.toFixed(6));
const round5 = (value) => Number(value.toFixed(5));

function slerp(a, b, t) {
  const qa = new THREE.Quaternion(a[0], a[1], a[2], a[3]);
  const qb = new THREE.Quaternion(b[0], b[1], b[2], b[3]);
  qa.slerp(qb, t);
  return qa;
}
function lerpVec(a, b, t) {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

/** 读取第 f 帧四元数；兼容 nested `[[x,y,z,w],...]` 与 flat `[x,y,z,w,...]` 两种 r 形状。 */
function readQuatAt(track, f) {
  const r = track?.r;
  if (!Array.isArray(r) || r.length === 0) return null;
  if (Array.isArray(r[0])) return Array.isArray(r[f]) && r[f].length === 4 ? r[f] : null;
  const i = f * 4;
  return i + 3 < r.length ? [r[i], r[i + 1], r[i + 2], r[i + 3]] : null;
}

/** 读取第 f 帧位移；兼容 nested `[[dx,dy,dz],...]` 与 flat `[dx,dy,dz,...]` 两种 p 形状。 */
function readVecAt(track, f) {
  const p = track?.p;
  if (!Array.isArray(p) || p.length === 0) return null;
  if (Array.isArray(p[0])) return Array.isArray(p[f]) && p[f].length === 3 ? p[f] : null;
  const i = f * 3;
  return i + 2 < p.length ? [p[i], p[i + 1], p[i + 2]] : null;
}

function setView(name) {
  viewName = name;
  const s = bboxSize;
  const h = Math.max(s.y * 1.15, 1.2);
  const w = h * (W / H);
  camera.left = -w / 2;
  camera.right = w / 2;
  camera.top = h / 2;
  camera.bottom = -h / 2;
  // 朝向统一（yaw 修正）后模型面向 +Z，所以相机放在 +Z 侧看向 -Z 才能看到正面。
  if (name === 'front') {
    camera.position.set(center.x, center.y, center.z + s.z + 3);
  } else if (name === 'threeQuarter') {
    camera.position.set(center.x + s.x + 2, center.y + 0.1, center.z + s.z + 3);
  } else {
    camera.position.set(center.x + s.x + 3, center.y, center.z);
  }
  camera.lookAt(center.x, center.y, center.z);
  camera.updateProjectionMatrix();
}

/**
 * 手部特写相机（验收手指用）：以 raw hand 骨与中指指节中点为视野中心，正交视野 span 米。
 * 调用前需先 applyPose + vrm.update；调用方负责随后 setView(viewName) 恢复。
 * @param {'left'|'right'} side
 * @param {number} spanMeters 视野高度（米），默认 0.22（约一只手）
 */
function setHandView(side = 'left', spanMeters = null) {
  if (!vrm) return false;
  const humanoid = vrm.humanoid;
  const hand = humanoid.getRawBoneNode(`${side}Hand`);
  if (!hand) return false;
  const prefix = side === 'left' ? 'Left' : 'Right';
  const names = [`${prefix}Hand`];
  for (const finger of ['Thumb', 'Index', 'Middle', 'Ring', 'Little']) {
    for (const seg of ['Proximal', 'Intermediate', 'Distal']) names.push(`${prefix}${finger}${seg}`);
  }
  const box = new THREE.Box3();
  let found = false;
  for (const n of names) {
    const node = humanoid.getRawBoneNode(n.replace(/^Left/, 'left').replace(/^Right/, 'right'));
    if (!node) continue;
    const p = new THREE.Vector3();
    node.getWorldPosition(p);
    box.expandByPoint(p);
    found = true;
  }
  if (!found) return false;
  const c = new THREE.Vector3();
  box.getCenter(c);
  const size = new THREE.Vector3();
  box.getSize(size);
  const h = Math.max(spanMeters ?? Math.max(size.x, size.y, size.z) * 1.8 + 0.03, 0.06);
  const w = h * (W / H);
  camera.left = -w / 2;
  camera.right = w / 2;
  camera.top = h / 2;
  camera.bottom = -h / 2;
  // 3/4 视角（+Z 正面 + 侧向偏移 + 略高），避免手掌正对镜头/手指互相遮挡。
  const dx = (side === 'left' ? -1 : 1) * h * 0.85;
  camera.position.set(c.x + dx, c.y + h * 0.45, c.z + 3);
  camera.lookAt(c.x, c.y, c.z);
  camera.updateProjectionMatrix();
  return true;
}

function frameIndex(tSec) {
  const n = clip.frames;
  const fps = clip.fps;
  const dur = n / fps;
  let ft = clip.loop ? ((tSec % dur) + dur) % dur : Math.min(Math.max(tSec, 0), (n - 1) / fps);
  const f = ft * fps;
  let f0 = Math.floor(f);
  let f1 = Math.min(f0 + 1, n - 1);
  return { f0, f1, a: f - f0 };
}

/**
 * 目标模型缺 upperChest 时的 α-fold 参数（与 `src/renderer/src/vrm/upper-chest-fold.ts` 同步；
 * 预览器是普通浏览器 ESM，不能 import src TS，故同公式本地实现）。
 *
 * 公式（VRMA how_to_transform_human_pose 的连续化）：
 *   q_chest' = q_chest · U^α；q_child' = U^(1-α) · q_child（neck/leftShoulder/rightShoulder）
 *   U^α = slerp(I, U, α)
 * 任意 α 下子骨世界朝向精确恢复；α=1（默认）= chest 吸收全部 U、子骨不变（HSR 管线风格）。
 */
const UPPER_CHEST_FOLD_ALPHA = 1;
const UPPER_CHEST_FOLD_CHILD_BONES = new Set(['Neck', 'LeftShoulder', 'RightShoulder']);

/**
 * 把 clip 第 f0/f1 帧按 a 插值应用到 normalized humanoid 骨骼（p 加到 rest position）。
 * 只设 clip 里出现的骨；其余骨应先用 resetPose() 归位。
 * 目标缺 upperChest 时把 UpperChest 轨道按 α-fold 折叠进 chest/子骨（与 app 运行时一致）。
 */
function applyPose(f0, f1, a) {
  const humanoid = vrm.humanoid;
  // upperChest 兼容折叠：U 先按帧间 slerp 求出，再在写骨时乘进 chest/子骨。
  const upperChestNode = humanoid.getNormalizedBoneNode('upperChest');
  const chestNode = humanoid.getNormalizedBoneNode('chest');
  const upperChestTrack = clip.bones.UpperChest;
  let chestMultiplier = null;
  let childMultiplier = null;
  if (!upperChestNode && chestNode && upperChestTrack) {
    const u0 = readQuatAt(upperChestTrack, f0);
    if (u0 !== null) {
      const u1 = a > 0 ? readQuatAt(upperChestTrack, f1) ?? u0 : u0;
      const u = a > 0 ? slerp(u0, u1, a) : new THREE.Quaternion(u0[0], u0[1], u0[2], u0[3]);
      chestMultiplier = new THREE.Quaternion().slerp(u, UPPER_CHEST_FOLD_ALPHA);
      childMultiplier = new THREE.Quaternion().slerp(u, 1 - UPPER_CHEST_FOLD_ALPHA);
    }
  }
  for (const [unityName, data] of Object.entries(clip.bones)) {
    const vrmName = BONE_MAP[unityName];
    if (!vrmName) continue;
    const node = humanoid.getNormalizedBoneNode(vrmName);
    if (!node) continue;
    const r = rest.get(vrmName);
    if (!r) continue;
    const q0 = readQuatAt(data, f0);
    if (q0 === null) continue;
    const q1 = a > 0 ? readQuatAt(data, f1) ?? q0 : q0;
    const q = a > 0 ? slerp(q0, q1, a) : new THREE.Quaternion(q0[0], q0[1], q0[2], q0[3]);
    if (chestMultiplier !== null) {
      // chest' = chest · U^α；child' = U^(1-α) · child。
      if (unityName === 'Chest') q.multiply(chestMultiplier);
      else if (UPPER_CHEST_FOLD_CHILD_BONES.has(unityName)) q.premultiply(childMultiplier);
    }
    node.quaternion.copy(q);
    const p0 = readVecAt(data, f0);
    if (p0 !== null) {
      const p1 = a > 0 ? readVecAt(data, f1) ?? p0 : p0;
      const d = a > 0 ? lerpVec(p0, p1, a) : p0;
      node.position.set(
        r.p.x + d[0] * scale,
        r.p.y + d[1] * scale,
        r.p.z + d[2] * scale
      );
    }
  }
  humanoid.update();
  vrm.scene.updateMatrixWorld(true);
}

/** 全部 normalized humanoid 骨恢复 rest 姿势（并同步 raw 骨骼/世界矩阵）。 */
function resetPose() {
  if (!vrm) return;
  const humanoid = vrm.humanoid;
  for (const [vrmName, r] of rest) {
    const node = humanoid.getNormalizedBoneNode(vrmName);
    if (!node) continue;
    node.quaternion.copy(r.q);
    node.position.copy(r.p);
  }
  humanoid.update();
  vrm.scene.updateMatrixWorld(true);
}

function worldPosition(rawName, out) {
  const node = vrm.humanoid.getRawBoneNode(rawName);
  if (!node) return null;
  node.getWorldPosition(out);
  return out;
}

/** 读一组 raw 骨的世界位置（米）。缺失骨为 null。 */
function readRawPositions(names) {
  const result = {};
  const tmp = new THREE.Vector3();
  for (const name of names) {
    const pos = worldPosition(name, tmp);
    result[name] = pos === null ? null : [pos.x, pos.y, pos.z];
  }
  return result;
}

function dist3(a, b) {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

/** 两向量夹角（度，0–180）。 */
function angleBetweenDeg(a, b) {
  const dot = a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const na = Math.hypot(a[0], a[1], a[2]);
  const nb = Math.hypot(b[0], b[1], b[2]);
  if (na === 0 || nb === 0) return NaN;
  return (Math.acos(Math.min(1, Math.max(-1, dot / (na * nb)))) * 180) / Math.PI;
}

/**
 * 全 clip 逐帧度量（会逐帧驱动 normalized 骨骼 → raw，耗时 ~ 帧数 × 1ms）。
 * 返回世界空间骨位置（米）+ 自然度指标；不改动调用方的 clip 状态（结束后 resetPose）。
 */
function metrics() {
  if (!clip || !vrm) throw new Error('clip/vrm not ready');
  const startedAt = performance.now();
  const frames = clip.frames;
  const rotation = computeRotationMetrics(clip.bones, frames);

  /** @type {Record<string, Array<[number, number, number] | null>>} */
  const positions = {};
  for (const name of METRIC_POSITION_BONES) positions[name] = [];

  resetPose();
  const restPositions = readRawPositions(METRIC_POSITION_BONES);
  const restFeet = ['leftFoot', 'rightFoot', 'leftToes', 'rightToes']
    .map((name) => restPositions[name]?.[1])
    .filter((value) => typeof value === 'number');
  const restGroundY = restFeet.length > 0 ? Math.min(...restFeet) : 0;

  let minFootY = Infinity;
  let footYMaxJump = 0;
  let prevFootY = null;
  let hipsTravel = 0;
  let hipsMaxStep = 0;
  let hipsLateralDrift = 0;
  let hipsHeightMin = Infinity;
  let hipsHeightMax = -Infinity;
  let headHeightMin = Infinity;
  let headHeightMax = -Infinity;
  let kneeFlexMin = Infinity;
  let kneeFlexMax = -Infinity;
  let firstHips = null;
  let prevHips = null;
  let lastHips = null;

  try {
    for (let f = 0; f < frames; f += 1) {
      applyPose(f, f, 0);
      const raw = readRawPositions(ALL_RAW_READ_BONES);

      for (const name of METRIC_POSITION_BONES) {
        const p = raw[name];
        positions[name].push(p === null ? null : p.map(round5));
      }

      const feet = ['leftFoot', 'rightFoot', 'leftToes', 'rightToes']
        .map((name) => raw[name]?.[1])
        .filter((value) => typeof value === 'number');
      const footY = feet.length > 0 ? Math.min(...feet) : null;
      if (footY !== null) {
        minFootY = Math.min(minFootY, footY);
        if (prevFootY !== null) footYMaxJump = Math.max(footYMaxJump, Math.abs(footY - prevFootY));
        prevFootY = footY;
      }

      const hips = raw.hips;
      if (hips !== null) {
        if (firstHips === null) firstHips = hips;
        if (prevHips !== null) {
          hipsTravel += Math.hypot(hips[0] - prevHips[0], hips[2] - prevHips[2]);
          hipsMaxStep = Math.max(hipsMaxStep, dist3(hips, prevHips));
        }
        hipsLateralDrift = Math.max(
          hipsLateralDrift,
          Math.hypot(hips[0] - firstHips[0], hips[2] - firstHips[2])
        );
        hipsHeightMin = Math.min(hipsHeightMin, hips[1]);
        hipsHeightMax = Math.max(hipsHeightMax, hips[1]);
        prevHips = hips;
        lastHips = hips;
      }

      const head = raw.head;
      if (head !== null) {
        headHeightMin = Math.min(headHeightMin, head[1]);
        headHeightMax = Math.max(headHeightMax, head[1]);
      }

      // 膝盖屈曲角 = 大腿方向与小腿方向的夹角（伸直 = 0°，深蹲/坐 = 大角度）。
      for (const side of ['left', 'right']) {
        const thighBone = THIGH_BONES[side];
        const knee = raw[`${side}LowerLeg`];
        const foot = raw[`${side}Foot`];
        const hip = raw[thighBone];
        if (!knee || !foot || !hip) continue;
        const thigh = [knee[0] - hip[0], knee[1] - hip[1], knee[2] - hip[2]];
        const shin = [foot[0] - knee[0], foot[1] - knee[1], foot[2] - knee[2]];
        const flex = angleBetweenDeg(thigh, shin);
        if (Number.isFinite(flex)) {
          kneeFlexMin = Math.min(kneeFlexMin, flex);
          kneeFlexMax = Math.max(kneeFlexMax, flex);
        }
      }
    }

    const finiteOrNull = (value) => (Number.isFinite(value) ? round5(value) : null);
    const hipsNetDrift =
      firstHips !== null && lastHips !== null
        ? Math.hypot(lastHips[0] - firstHips[0], lastHips[2] - firstHips[2])
        : null;
    return {
      clip: clip.clip ?? null,
      fps: clip.fps,
      frames,
      duration: clip.duration,
      loop: Boolean(clip.loop),
      sourceHeight: clip.sourceHeight ?? null,
      modelHeight: round5(targetHeight),
      scale: round6(scale),
      metricBones: METRIC_POSITION_BONES,
      positions,
      restPositions,
      restGroundY: round5(restGroundY),
      minFootY: finiteOrNull(minFootY),
      maxGroundPenetration:
        minFootY === Infinity ? null : round5(Math.max(0, restGroundY - minFootY)),
      footYMaxJump: finiteOrNull(footYMaxJump),
      hipsTravel: finiteOrNull(hipsTravel),
      hipsMaxStep: finiteOrNull(hipsMaxStep),
      hipsLateralDrift: finiteOrNull(hipsLateralDrift),
      hipsNetDrift: finiteOrNull(hipsNetDrift),
      hipsHeightMin: finiteOrNull(hipsHeightMin),
      hipsHeightMax: finiteOrNull(hipsHeightMax),
      headHeightMin: finiteOrNull(headHeightMin),
      headHeightMax: finiteOrNull(headHeightMax),
      kneeFlexMin: finiteOrNull(kneeFlexMin),
      kneeFlexMax: finiteOrNull(kneeFlexMax),
      maxFrameJumpDeg: finiteOrNull(rotation.maxFrameJumpDeg),
      maxFrameJumpBone: rotation.maxFrameJumpBone,
      loopSeamMaxAngleDeg: clip.loop ? finiteOrNull(rotation.firstLastMaxAngleDeg) : null,
      loopSeamBone: clip.loop ? rotation.firstLastBone : null,
      computationMs: Math.round(performance.now() - startedAt)
    };
  } finally {
    resetPose();
  }
}

let restProbeCache = null;
function restProbe() {
  if (restProbeCache) return restProbeCache;
  const out = {};
  for (const n of ['hips', 'leftUpperArm', 'leftLowerArm', 'rightUpperArm', 'rightLowerArm', 'leftUpperLeg', 'leftLowerLeg', 'rightUpperLeg', 'rightLowerLeg']) {
    const node = vrm.humanoid.getNormalizedBoneNode(n);
    if (!node) continue;
    const v = new THREE.Vector3();
    node.getWorldPosition(v);
    out[n] = [Number(v.x.toFixed(3)), Number(v.y.toFixed(3)), Number(v.z.toFixed(3))];
  }
  restProbeCache = out;
  return out;
}

window.__clipViewer = {
  ready: (async () => {
    const loader = new GLTFLoader();
    loader.register((parser) => new VRMLoaderPlugin(parser));
    const gltf = await loader.loadAsync(asRootUrl(vrmPath));
    vrm = gltf.userData.vrm;
    if (!vrm) throw new Error('no vrm in gltf.userData');
    if (vrm.meta?.metaVersion === '0') VRMUtils.rotateVRM0(vrm);
    vrm.scene.traverse((o) => { if (o.isMesh) o.frustumCulled = false; });
    scene.add(vrm.scene);
    // 朝向修正：统一到 +Z 面向相机（契约同 yawOffsetDeg）；0 = 无需修正。
    if (yawDeg !== 0) vrm.scene.rotation.y = THREE.MathUtils.degToRad(yawDeg);
    vrm.scene.updateMatrixWorld(true);

    // rest pose：动画作用在 normalized 骨骼上，humanoid.update() 会转成 raw
    for (const vrmName of Object.values(BONE_MAP)) {
      const node = vrm.humanoid.getNormalizedBoneNode(vrmName);
      if (!node) continue;
      rest.set(vrmName, { q: node.quaternion.clone(), p: node.position.clone() });
    }

    const box = new THREE.Box3().setFromObject(vrm.scene);
    box.getCenter(center);
    box.getSize(bboxSize);
    targetHeight = bboxSize.y || 1.7;
    // Hips 位移缩放基准（与官方 three-vrm Mixamo 例子 / UniVRM Vrm10Retarget 一致）：
    // 用 normalized rest 的 hips 高度比，不用模型 bbox 高（bbox 含头发/衣物，会把位移放大）。
    modelHipsHeight =
      vrm.humanoid.normalizedRestPose?.hips?.position?.[1] ?? CLIP_SOURCE_HIPS_HEIGHT;
    setView('front');

    return {
      vrm: vrmPath,
      boneCount: rest.size,
      height: targetHeight,
      yawDeg,
      expressions: Object.keys(vrm.expressionManager?.expressionMap || {}).length
    };
  })(),

  loadClip: async (url) => {
    const res = await fetch(asRootUrl(url), { cache: 'no-store' });
    if (!res.ok) throw new Error(`clip fetch ${res.status}: ${url}`);
    clip = await res.json();
    // Hips 位移按 hips 高比缩放（官方 three-vrm/UniVRM 口径；见 ready() 注释）。
    scale = modelHipsHeight / (clip.sourceHipsHeight ?? CLIP_SOURCE_HIPS_HEIGHT);
    // 换 clip 前先把上一 clip 残留的骨骼归位，避免缺骨 clip 带着旧姿势。
    resetPose();
    return { clip: clip.clip, frames: clip.frames, fps: clip.fps, duration: clip.duration, loop: clip.loop, bones: Object.keys(clip.bones).length };
  },

  captureAt: (tSec) => {
    if (!clip || !vrm) throw new Error('clip/vrm not ready');
    const { f0, f1, a } = frameIndex(tSec);
    applyPose(f0, f1, a);
    vrm.update(0);
    renderer.render(scene, camera);
    return canvas.toDataURL('image/png');
  },

  /** 手部特写抓帧（先应用该时刻姿势，再切手部相机；返回 dataURL，并恢复主相机）。 */
  captureHandAt: (tSec, side = 'left', spanMeters = 0.22) => {
    if (!clip || !vrm) throw new Error('clip/vrm not ready');
    const { f0, f1, a } = frameIndex(tSec);
    applyPose(f0, f1, a);
    vrm.update(0);
    if (!setHandView(side, spanMeters)) return null;
    renderer.render(scene, camera);
    const dataUrl = canvas.toDataURL('image/png');
    setView(viewName);
    return dataUrl;
  },

  metrics,

  resetPose,

  probe: () => {
    if (!vrm) return null;
    vrm.scene.updateMatrixWorld(true);
    const g = (name) => {
      const node = vrm.humanoid.getRawBoneNode(name);
      if (!node) return null;
      const v = new THREE.Vector3();
      node.getWorldPosition(v);
      return [Number(v.x.toFixed(3)), Number(v.y.toFixed(3)), Number(v.z.toFixed(3))];
    };
    return {
      rest: restProbe(),
      posed: {
        hips: g('hips'), head: g('head'),
        leftUpperArm: g('leftUpperArm'), leftLowerArm: g('leftLowerArm'), leftHand: g('leftHand'),
        rightUpperArm: g('rightUpperArm'), rightLowerArm: g('rightLowerArm'), rightHand: g('rightHand'),
        leftUpperLeg: g('leftUpperLeg'), leftLowerLeg: g('leftLowerLeg'), leftFoot: g('leftFoot'),
        rightUpperLeg: g('rightUpperLeg'), rightLowerLeg: g('rightLowerLeg'), rightFoot: g('rightFoot')
      }
    };
  },
  setView,
  info: () => ({ vrm: vrmPath, view: viewName, clip: clip?.clip || null, height: targetHeight, yawDeg })
};
