/**
 * V6 表情预览渲染页（dev-only，Electron 内运行）
 *
 * 职责：three-vrm 加载目标 VRM → 设置 expression 权重 → 渲染静帧（脸/半身/全身）。
 * 由 `preview-expressions.mjs` 通过静态服务 + Electron 驱动：
 *   /scripts/vrm/expression/preview-viewer.html?vrm=<assets相对路径>&yaw=<度>
 *
 * window.__exprViewer:
 *   ready                 Promise<info>
 *   info()                { expressionNames, presets, customs, height }
 *   setWeights(weights)   设置 VRM expression 权重（先全清再写；vrm.update 步进）
 *   setView('face'|'faceThreeQuarter'|'faceSide'|'full')
 *   capture()             dataURL（PNG）
 */
import * as THREE from 'three'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { VRMLoaderPlugin, VRMUtils } from '@pixiv/three-vrm'

const params = new URLSearchParams(location.search)
const asRootUrl = (p) => (/^https?:/i.test(p) ? p : '/' + String(p).replace(/^\/+/, ''))
const vrmPath = params.get('vrm') || 'assets/vrm/aventurine-tpose.vrm'
const yawDeg = Number(params.get('yaw') || '0') || 0
const W = 640
const H = 800

const canvas = document.getElementById('viewer')
const renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true, preserveDrawingBuffer: true })
renderer.setPixelRatio(1)
renderer.setSize(W, H, false)
renderer.outputColorSpace = THREE.SRGBColorSpace

const scene = new THREE.Scene()
scene.add(new THREE.HemisphereLight(0xffffff, 0x445566, 2.4))
const key = new THREE.DirectionalLight(0xffffff, 2.2)
key.position.set(2, 3, 4)
scene.add(key)
const fill = new THREE.DirectionalLight(0xffffff, 0.9)
fill.position.set(-3, 1, 2)
scene.add(fill)
const rim = new THREE.DirectionalLight(0x88aaff, 0.6)
rim.position.set(0, 2, -4)
scene.add(rim)

const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.001, 100)

let vrm = null
let center = new THREE.Vector3()
let bboxSize = new THREE.Vector3(1, 1.8, 0.4)
let heightMeters = 1.73
let viewMode = 'full'
let headCenter = new THREE.Vector3(0, 1.5, 0)
let headQuat = new THREE.Quaternion()

const round3 = (value) => Math.round(value * 1000) / 1000

/** 等 spring bone / morph 稳定：步进若干帧（静帧抓图也体现物理与表情）。 */
function settle(frames = 6) {
  for (let index = 0; index < frames; index += 1) {
    vrm.update(1 / 60)
  }
  vrm.scene.updateMatrixWorld(true)
}

/** 由包围盒 + 宽高比设置正交相机（`frameHeight` 米）。 */
function frameAt(target, frameHeight, view) {
  const aspect = W / H
  camera.left = (-frameHeight * aspect) / 2
  camera.right = (frameHeight * aspect) / 2
  camera.top = frameHeight / 2
  camera.bottom = -frameHeight / 2
  const distance = 6
  let dir
  if (view === 'faceSide') dir = new THREE.Vector3(1, 0, 0.08).normalize()
  else if (view === 'faceThreeQuarter') dir = new THREE.Vector3(0.6, 0.02, 1).normalize()
  else if (view === 'full') dir = new THREE.Vector3(0.25, 0.02, 1).normalize()
  else dir = new THREE.Vector3(0, 0, 1)
  camera.position.copy(target).addScaledVector(dir, distance)
  camera.lookAt(target)
  camera.updateProjectionMatrix()
}

function applyView(mode) {
  viewMode = mode
  if (mode === 'full') {
    const frameHeight = bboxSize.y * 1.12
    const target = center.clone()
    frameAt(target, frameHeight, 'full')
    return
  }
  // 面部特写：按头部世界位置 + 模型身高比例取景（0.46m 竖构图，含发顶/下巴/肩线）
  const frameHeight = 0.46 * Math.max(0.6, heightMeters / 1.73)
  const forward = new THREE.Vector3(0, 0, 1).applyQuaternion(headQuat)
  const up = new THREE.Vector3(0, 1, 0).applyQuaternion(headQuat)
  const target = headCenter.clone().addScaledVector(up, 0.02).addScaledVector(forward, 0.04)
  frameAt(target, frameHeight, mode)
}

/** 设置 expression 权重：先全清，再 setValue；然后 vrm.update 稳定。 */
function applyWeights(weights) {
  const manager = vrm.expressionManager
  if (!manager) return { applied: [], missing: [] }
  manager.resetValues()
  const applied = []
  const missing = []
  for (const [name, weight] of Object.entries(weights || {})) {
    if (!Number.isFinite(weight)) continue
    const expression = manager.getExpression(name)
    if (!expression) {
      missing.push(name)
      continue
    }
    manager.setValue(name, Math.max(0, Math.min(1, weight)))
    if (weight > 0.0001) applied.push(name)
  }
  settle()
  return { applied, missing }
}

function fitCameraToModel() {
  const box = new THREE.Box3().setFromObject(vrm.scene)
  box.getCenter(center)
  box.getSize(bboxSize)
  const head = vrm.humanoid?.getNormalizedBoneNode('head') ?? vrm.humanoid?.getRawBoneNode('head')
  if (head) {
    head.updateWorldMatrix(true, false)
    headCenter.setFromMatrixPosition(head.matrixWorld)
    head.getWorldQuaternion(headQuat)
  } else {
    headCenter = center.clone().add(new THREE.Vector3(0, bboxSize.y * 0.38, 0))
  }
  applyView('full')
}

async function boot() {
  const loader = new GLTFLoader()
  loader.register((parser) => new VRMLoaderPlugin(parser))
  const gltf = await loader.loadAsync(asRootUrl(vrmPath))
  vrm = gltf.userData.vrm
  if (!vrm) throw new Error('VRM 扩展缺失（不是 VRM 文件？）')
  if (vrm.meta?.metaVersion === '0') {
    VRMUtils.rotateVRM0(vrm)
  }
  if (yawDeg !== 0) vrm.scene.rotation.y += (yawDeg * Math.PI) / 180
  vrm.scene.traverse((object) => {
    object.frustumCulled = false
  })
  scene.add(vrm.scene)
  const box = new THREE.Box3().setFromObject(vrm.scene)
  const size = box.getSize(new THREE.Vector3())
  heightMeters = size.y > 0.1 ? size.y : 1.73
  fitCameraToModel()
  settle(12)
  renderer.render(scene, camera)
  const manager = vrm.expressionManager
  const presetNames = manager ? Object.keys(manager.presetExpressionMap ?? {}) : []
  const customNames = manager ? Object.keys(manager.customExpressionMap ?? {}) : []
  const info = {
    specVersion: vrm.meta?.metaVersion ?? '1',
    height: round3(heightMeters),
    cameraHeight: round3(bboxSize.y),
    expressionCount: presetNames.length + customNames.length,
    presets: presetNames,
    customs: customNames,
    hasSpringBone: Boolean(vrm.springBoneManager)
  }
  console.log('[expr-viewer] ready', JSON.stringify({ height: info.height, expressions: info.expressionCount }))
  return info
}

window.__exprViewer = {
  ready: boot(),
  info: () => {
    const manager = vrm?.expressionManager
    return {
      expressionNames: manager ? manager.expressions.map((expression) => expression.expressionName) : [],
      presets: manager ? Object.keys(manager.presetExpressionMap ?? {}) : [],
      customs: manager ? Object.keys(manager.customExpressionMap ?? {}) : [],
      height: heightMeters,
      view: viewMode
    }
  },
  setWeights: (weights) => {
    const result = applyWeights(weights)
    renderer.render(scene, camera)
    return result
  },
  setView: (mode) => {
    applyView(mode)
    settle(2)
    renderer.render(scene, camera)
    return viewMode
  },
  capture: () => {
    renderer.render(scene, camera)
    return canvas.toDataURL('image/png')
  }
}
