/**
 * V3 HSR motion preview — three-vrm viewer（dev-only）
 *
 * 加载目标 VRM（当前 = 规范 T-pose 戏浪，面向 +Z/左手 +X/带 SpringBone）+ `assets/motions/hsr/<clip>.json`：
 * 1. humanoid 52 骨：写 normalized bone quaternion（UpperChest 缺失时跳过；Hips 额外写 position，
 *    按 `modelHipsHeight / sourceHipsHeight` 缩放，与 Wave 1.5 P0 修复口径一致）；
 * 2. 目标有 SpringBone 时（rawPolicy=spring）由 three-vrm 物理驱动头发/衣摆；播放器按 delta 逐帧步进
 *    才能让 spring 收敛（静帧抓图时由 captureAt 内部从 0 帧步进到目标帧）；
 * 3. 旧资产（no spring）若 clip 带 `raw` 通道，则在 humanoid.update() 之后按节点名写局部 quaternion；
 * 4. 视图：front / side / threeQuarter / hand / feet（相机统一在 +Z 侧，模型 yaw 由 manifest 决定）。
 *
 * 由 `preview-hsr.mjs` 用 Electron 驱动；window.__clipViewer 接口见文件末尾。
 */
import * as THREE from 'three'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { VRMLoaderPlugin, VRMUtils } from '@pixiv/three-vrm'

import { UNITY_NAME_BY_VRM } from './lib/humanoid-hsr.mjs'

const UNITY_TO_VRM = Object.freeze(
  Object.fromEntries(Object.entries(UNITY_NAME_BY_VRM).map(([vrm, unity]) => [unity, vrm]))
)

const params = new URLSearchParams(location.search)
const asRootUrl = (p) => (/^https?:/i.test(p) ? p : '/' + String(p).replace(/^\/+/, ''))
const vrmPath = params.get('vrm') || 'assets/vrm/aventurine-tpose.vrm'
const yawDeg = Number(params.get('yaw') || '0') || 0
const rawEnabled = params.get('raw') !== '0'
/** 道具（watergun）预览：可选 GLB（repo 根相对路径，如 assets/props/watergun/watergun.glb） */
const propPath = params.get('prop') || ''
/** 道具挂点骨（默认 rightHand；dev 预览可传 leftHand 等做挂点对比） */
const propBoneName = params.get('propBone') || 'rightHand'
const W = 600
const H = 800

const canvas = document.getElementById('viewer')
const renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true, preserveDrawingBuffer: true })
renderer.setPixelRatio(1)
renderer.setSize(W, H, false)
renderer.outputColorSpace = THREE.SRGBColorSpace

const scene = new THREE.Scene()
scene.add(new THREE.HemisphereLight(0xffffff, 0x445566, 2.2))
const dir = new THREE.DirectionalLight(0xffffff, 2.0)
dir.position.set(2, 3, 4)
scene.add(dir)
const fill = new THREE.DirectionalLight(0xffffff, 0.8)
fill.position.set(-3, 1, 2)
scene.add(fill)

const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.01, 100)
let vrm = null
let clip = null
const restByVrmName = new Map()
const nodeByName = new Map()
let targetHeight = 1.7
let hipsRestY = 1
let scale = 1
let viewName = 'front'
let simFrame = -1
let propRoot = null
const propState = {
  visible: false,
  transform: { position: [0, 0, 0], quaternion: [0, 0, 0, 1], scale: 1 },
  calibration: null
}
const center = new THREE.Vector3()
const bboxSize = new THREE.Vector3(1, 1.8, 0.4)

function slerp(a, b, t) {
  const qa = new THREE.Quaternion(a[0], a[1], a[2], a[3])
  const qb = new THREE.Quaternion(b[0], b[1], b[2], b[3])
  qa.slerp(qb, t)
  return qa
}

function lerpVec(a, b, t) {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]
}

function setView(name) {
  viewName = name
  const s = bboxSize
  if (name === 'hand' || name === 'feet') {
    const boneName = name === 'hand' ? 'leftHand' : 'leftFoot'
    const node = vrm.humanoid.getRawBoneNode(boneName) ?? vrm.humanoid.getNormalizedBoneNode(boneName)
    const c = new THREE.Vector3()
    if (node) node.getWorldPosition(c)
    else c.copy(center)
    if (name === 'feet') c.y = 0.12
    const h = 0.24
    camera.left = -h * (W / H)
    camera.right = h * (W / H)
    camera.top = h / 2
    camera.bottom = -h / 2
    camera.position.set(c.x, c.y, c.z + 1.2)
    camera.lookAt(c.x, c.y, c.z)
    camera.updateProjectionMatrix()
    return
  }
  const h = Math.max(s.y * 1.15, 1.2)
  const w = h * (W / H)
  camera.left = -w / 2
  camera.right = w / 2
  camera.top = h / 2
  camera.bottom = -h / 2
  // 朝向统一（yaw 修正）后模型面向 +Z，所以正面相机放在 +Z 侧看向 -Z。
  if (name === 'front') camera.position.set(center.x, center.y, center.z + s.z + 3)
  else if (name === 'threeQuarter') camera.position.set(center.x + s.x + 2, center.y + 0.1, center.z + s.z + 3)
  else camera.position.set(center.x + s.x + 3, center.y, center.z)
  camera.lookAt(center.x, center.y, center.z)
  camera.updateProjectionMatrix()
}

function frameIndex(tSec) {
  const n = clip.frames
  const fps = clip.fps
  const dur = n / fps
  const ft = clip.loop ? ((tSec % dur) + dur) % dur : Math.min(Math.max(tSec, 0), (n - 1) / fps)
  const f = ft * fps
  const f0 = Math.floor(f)
  const f1 = Math.min(f0 + 1, n - 1)
  return { f0, f1, a: f - f0 }
}

/** 把 clip 的第 f0/f1 帧（可 slerp）写到 normalized humanoid 骨。 */
function applyHumanoidPose(f0, f1, a) {
  const humanoid = vrm.humanoid
  for (const [unityName, data] of Object.entries(clip.bones || {})) {
    const vrmName = UNITY_TO_VRM[unityName]
    if (!vrmName) continue
    const node = humanoid.getNormalizedBoneNode(vrmName)
    if (!node) continue
    const rest = restByVrmName.get(vrmName)
    if (!rest) continue
    const q0 = data.r[f0]
    const q1 = data.r[f1]
    const q = a > 0 ? slerp(q0, q1, a) : new THREE.Quaternion(q0[0], q0[1], q0[2], q0[3])
    node.quaternion.copy(q)
    if (data.p) {
      const p0 = data.p[f0]
      const p1 = data.p[f1]
      const d = a > 0 ? lerpVec(p0, p1, a) : p0
      node.position.set(rest.p.x + d[0] * scale, rest.p.y + d[1] * scale, rest.p.z + d[2] * scale)
    }
  }
}

/** 旧资产 raw 通道：humanoid.update() 之后写非 humanoid 节点（新资产 rawPolicy=spring 时为空）。 */
function applyRawPose(f0, f1, a) {
  if (!rawEnabled || !clip.raw) return 0
  let applied = 0
  for (const [nodeName, data] of Object.entries(clip.raw)) {
    const node = nodeByName.get(nodeName)
    if (!node) continue
    const q0 = data.r[f0]
    const q1 = data.r[f1]
    if (!q0) continue
    const q = a > 0 ? slerp(q0, q1, a) : new THREE.Quaternion(q0[0], q0[1], q0[2], q0[3])
    node.quaternion.copy(q)
    applied += 1
  }
  return applied
}

/* ------------------------------------------------------------------ 道具（水枪）预览 */

function propHandNode() {
  return vrm ? vrm.humanoid.getNormalizedBoneNode(propBoneName) : null
}

function applyPropTransform() {
  if (!propRoot) return
  propRoot.position.fromArray(propState.transform.position)
  propRoot.quaternion.fromArray(propState.transform.quaternion)
  propRoot.scale.setScalar(propState.transform.scale ?? 1)
  propRoot.visible = propState.visible
}

function attachPropRoot() {
  const hand = propHandNode()
  if (!hand || !propRoot) return false
  hand.add(propRoot)
  applyPropTransform()
  propRoot.traverse((object) => {
    if (object.isMesh) object.frustumCulled = false
  })
  vrm.scene.updateMatrixWorld(true)
  return true
}

async function loadProp(path) {
  const loader = new GLTFLoader()
  const gltf = await loader.loadAsync(asRootUrl(path))
  propRoot = gltf.scene
  propRoot.name = 'hand-prop'
  const attached = attachPropRoot()
  return { path, attached, meshes: propRoot.children.length }
}

function averageQuaternion(list) {
  const reference = list[0]
  const acc = new THREE.Quaternion(0, 0, 0, 0)
  for (const q of list) {
    const sign = q.dot(reference) < 0 ? -1 : 1
    acc.x += q.x * sign
    acc.y += q.y * sign
    acc.z += q.z * sign
    acc.w += q.w * sign
  }
  return acc.normalize()
}

/**
 * 用「源动画里水枪的世界变换 W」反推挂载局部变换：
 * T_i = inv(H_v(帧 i)) · W_i；多帧取平均并报告一致性。
 */
function calibratePropFromSamples(samplesDocument) {
  if (!clip || !vrm) throw new Error('clip/vrm not ready')
  if (!propRoot) throw new Error('prop not loaded')
  const doc = typeof samplesDocument === 'string' ? JSON.parse(samplesDocument) : samplesDocument
  const hand = propHandNode()
  if (!hand) throw new Error('missing normalized rightHand')
  const results = []
  for (const sample of doc.samples || []) {
    const frame = Math.max(0, Math.min(sample.clipIndex, clip.frames - 1))
    stepToFrame(frame)
    applyHumanoidPose(frame, frame, 0)
    vrm.humanoid.update()
    vrm.scene.updateMatrixWorld(true)
    const H = hand.matrixWorld.clone()
    // calib JSON 里 W 是行主序（Blender/Node 导出），THREE.Matrix4.fromArray 需要列主序 → 转置一次
    const W = new THREE.Matrix4().fromArray(sample.W).transpose()
    const T = H.invert().multiply(W)
    const position = new THREE.Vector3()
    const quaternion = new THREE.Quaternion()
    const scale = new THREE.Vector3()
    T.decompose(position, quaternion, scale)
    results.push({
      clipIndex: sample.clipIndex,
      sourceFrame: sample.sourceFrame,
      position: position.toArray().map((v) => Number(v.toFixed(6))),
      quaternion: quaternion.toArray().map((v) => Number(v.toFixed(6))),
      scale: scale.toArray().map((v) => Number(v.toFixed(4)))
    })
  }
  if (results.length === 0) throw new Error('no calibration samples applied')
  const positions = results.map((r) => new THREE.Vector3().fromArray(r.position))
  const quats = results.map((r) => new THREE.Quaternion().fromArray(r.quaternion))
  const meanPosition = new THREE.Vector3()
  for (const position of positions) meanPosition.add(position)
  meanPosition.divideScalar(positions.length)
  const meanQuaternion = averageQuaternion(quats)
  let maxAngle = 0
  for (const quaternion of quats) {
    const dot = Math.min(1, Math.abs(quaternion.dot(meanQuaternion)))
    maxAngle = Math.max(maxAngle, THREE.MathUtils.radToDeg(2 * Math.acos(dot)))
  }
  const spread = [0, 1, 2].map((axis) => {
    const values = positions.map((position) => position.getComponent(axis))
    return Math.max(...values) - Math.min(...values)
  })
  propState.transform = {
    position: meanPosition.toArray(),
    quaternion: meanQuaternion.toArray(),
    scale: 1
  }
  propState.calibration = {
    samples: results,
    consistency: {
      meanPosition: meanPosition.toArray(),
      meanQuaternion: meanQuaternion.toArray(),
      maxAngleDeviationDeg: Number(maxAngle.toFixed(2)),
      positionSpreadMeters: spread.map((v) => Number(v.toFixed(4)))
    }
  }
  applyPropTransform()
  return propState.calibration
}

function restoreRestPose() {
  for (const [vrmName, rest] of restByVrmName) {
    const node = vrm.humanoid.getNormalizedBoneNode(vrmName)
    if (!node) continue
    node.quaternion.copy(rest.q)
    node.position.copy(rest.p)
  }
  vrm.humanoid.update()
  vrm.scene.updateMatrixWorld(true)
}

/** SpringBone 需要按 delta 逐帧积分；抓静帧前从 0 帧步进到目标帧。 */
function stepToFrame(targetFrame) {
  if (!clip) return
  const desired = Math.max(0, Math.min(targetFrame, clip.frames - 1))
  if (simFrame > desired || simFrame < 0) {
    restoreRestPose()
    vrm.springBoneManager?.reset()
    simFrame = -1
  }
  const dt = 1 / clip.fps
  for (let frame = simFrame + 1; frame <= desired; frame += 1) {
    applyHumanoidPose(frame, frame, 0)
    vrm.update(dt)
    simFrame = frame
  }
}

function captureAt(tSec) {
  if (!clip || !vrm) throw new Error('clip/vrm not ready')
  const { f0, f1, a } = frameIndex(tSec)
  stepToFrame(f0)
  applyHumanoidPose(f0, f1, a)
  vrm.humanoid.update()
  if (a === 0 && f0 === simFrame) {
    // 精确落在步进帧：spring 状态已是该帧（无需再写 raw；新资产由 spring 驱动）
  } else {
    // 插值帧：spring 不额外推进，仅保持上一帧状态
  }
  applyRawPose(f0, f1, a)
  vrm.scene.updateMatrixWorld(true)
  renderer.render(scene, camera)
  return canvas.toDataURL('image/png')
}

window.__clipViewer = {
  ready: (async () => {
    const loader = new GLTFLoader()
    loader.register((parser) => new VRMLoaderPlugin(parser))
    const gltf = await loader.loadAsync(asRootUrl(vrmPath))
    vrm = gltf.userData.vrm
    if (!vrm) throw new Error('no vrm in gltf.userData')
    if (vrm.meta?.metaVersion === '0') VRMUtils.rotateVRM0(vrm)
    if (yawDeg !== 0) vrm.scene.rotation.y = THREE.MathUtils.degToRad(yawDeg)
    vrm.scene.traverse((object) => {
      if (object.isMesh) object.frustumCulled = false
      if (object.name && !nodeByName.has(object.name)) nodeByName.set(object.name, object)
    })
    scene.add(vrm.scene)
    vrm.scene.updateMatrixWorld(true)
    for (const [vrmName] of Object.entries(UNITY_NAME_BY_VRM)) {
      const node = vrm.humanoid.getNormalizedBoneNode(vrmName)
      if (!node) continue
      restByVrmName.set(vrmName, { p: node.position.clone(), q: node.quaternion.clone() })
    }
    hipsRestY = restByVrmName.get('hips')?.p.y ?? 1
    const box = new THREE.Box3().setFromObject(vrm.scene)
    box.getCenter(center)
    box.getSize(bboxSize)
    targetHeight = bboxSize.y || 1.7
    setView('front')
    if (propPath) {
      try {
        await loadProp(propPath)
      } catch (error) {
        console.error('[viewer] prop load failed:', error)
      }
    }
    return {
      vrm: vrmPath,
      prop: propRoot ? { path: propPath, attached: propRoot.parent !== null } : null,
      yawDeg,
      boneCount: restByVrmName.size,
      height: targetHeight,
      hipsRestY,
      nodes: nodeByName.size,
      springJoints: vrm.springBoneManager?.joints?.size ?? 0,
      rawEnabled
    }
  })(),
  loadClip: async (url) => {
    const response = await fetch(asRootUrl(url), { cache: 'no-store' })
    if (!response.ok) throw new Error(`clip fetch ${response.status}: ${url}`)
    clip = await response.json()
    scale = hipsRestY / (clip.sourceHipsHeight || 1)
    simFrame = -1
    return {
      clip: clip.clip,
      frames: clip.frames,
      fps: clip.fps,
      duration: clip.duration,
      loop: clip.loop,
      humanoid: Object.keys(clip.bones || {}).length,
      raw: Object.keys(clip.raw || {}).length,
      rawPolicy: clip.rawPolicy ?? (clip.raw ? 'baked' : null),
      scale
    }
  },
  captureAt,
  setView,
  loadProp,
  setPropVisible: (value) => {
    propState.visible = value === true
    if (propRoot) propRoot.visible = propState.visible
    return propState.visible
  },
  setPropTransform: (transform) => {
    if (transform && Array.isArray(transform.position)) {
      propState.transform.position = transform.position
    }
    if (transform && Array.isArray(transform.quaternion)) {
      propState.transform.quaternion = transform.quaternion
    }
    if (transform && Number.isFinite(transform.scale)) {
      propState.transform.scale = transform.scale
    }
    applyPropTransform()
    return { ...propState.transform }
  },
  calibratePropFromSamples,
  propInfo: () => ({ ...propState, attached: propRoot ? propRoot.parent !== null : false }),
  resetPose: () => {
    if (!vrm) return
    restoreRestPose()
    vrm.springBoneManager?.reset()
    simFrame = -1
  },
  setRawEnabled: (value) => {
    rawEnabled = value
  },
  info: () => ({
    vrm: vrmPath,
    view: viewName,
    clip: clip?.clip || null,
    height: targetHeight,
    yawDeg,
    rawEnabled,
    springJoints: vrm?.springBoneManager?.joints?.size ?? 0
  })
}
