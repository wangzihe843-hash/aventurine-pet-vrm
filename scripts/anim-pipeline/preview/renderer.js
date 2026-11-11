/**
 * 动作预览器 —— 渲染页（浏览器端 ES module）。
 *
 * 由 main.cjs 通过 webContents.executeJavaScript 驱动，对外暴露 `window.__preview`：
 *   init(config)           加载 PMX（+可选 VMD/VPD），返回模型/动作运行时信息
 *   setAngle(angle)        切换相机方位（front/side/45/back 或任意角度度数）
 *   seekFrame(frame)       把 VMD 采样到指定帧（30fps 帧号；可非单调）
 *   prepareFrame({...})    采样 + 渲染 + 等待合成一帧（截图前调用）
 *   boneSnapshot()         全部骨骼的模型空间位置/四元数（用于「骨架确实在动」断言）
 *   frameStats()           当前 GL 画布 alpha 覆盖率/包围盒（证明渲染非空白、未 taint）
 *   composeSheet(spec)     多帧网格接触表（返回 PNG dataURL）
 *
 * 设计约束（与任务书一致）：
 * - 不 import app 的 src/**；只复用 node_modules/three r171 的 MMDLoader / MMDAnimationHelper；
 * - 透明背景（alpha:true + clearColor alpha 0）；
 * - physics:false —— 不加载 ammo.js，MMDPhysics 完全关闭；
 * - 贴图从 file:// 直接按 PMX URL 的 base 解析（webSecurity:false，main 侧开启）。
 */

import * as THREE from 'three'
import { MMDLoader } from 'three/addons/loaders/MMDLoader.js'
import { MMDAnimationHelper } from 'three/addons/animation/MMDAnimationHelper.js'

const MMD_FPS = 30
const TOOL_VERSION = '1.0.0'

/** @type {Record<string, any>} */
const state = {
  config: null,
  renderer: null,
  scene: null,
  camera: null,
  mesh: null,
  helper: null,
  clip: null,
  modelInfo: null,
  bindBBox: null,
  center: new THREE.Vector3(),
  currentFrame: 0,
  stepsSinceReset: 0,
  currentAngle: 'front',
  angles: [],
  frames: [],
  textureStats: { started: 0, pending: 0, loaded: [], failed: [] },
  restBones: null,
  vpdCheck: null,
  renderCount: 0,
  lastRenderMs: 0,
}

const errors = []
window.__previewErrors = errors

function log(...args) {
  console.log('[preview-renderer]', ...args)
}

function fail(message) {
  const text = String(message && message.stack ? message.stack : message)
  errors.push(text)
  console.error('[preview-renderer] ERROR', text)
  return { ok: false, error: text }
}

/* ------------------------------------------------------------------ 场景初始化 */

function setupScene(config) {
  const stage = document.getElementById('stage')

  const renderer = new THREE.WebGLRenderer({
    alpha: true,
    antialias: true,
    // capturePage 之外还允许 renderer.domElement.toDataURL()/drawImage 取帧
    preserveDrawingBuffer: true,
  })
  renderer.setClearColor(0x000000, 0)
  renderer.setPixelRatio(window.devicePixelRatio || 1)
  renderer.setSize(window.innerWidth, window.innerHeight, false)
  renderer.outputColorSpace = THREE.SRGBColorSpace
  renderer.domElement.style.width = '100%'
  renderer.domElement.style.height = '100%'
  renderer.domElement.id = 'gl-canvas'
  stage.appendChild(renderer.domElement)

  const scene = new THREE.Scene()
  scene.background = null

  const camera = new THREE.PerspectiveCamera(30, window.innerWidth / window.innerHeight, 0.1, 5000)

  // 光照与 app 的 PetScene 同源强度（ambient + key/fill/rim），MMDToonMaterial 需要 directional。
  scene.add(new THREE.AmbientLight(0xffffff, 0.55))
  const keyLight = new THREE.DirectionalLight(0xffffff, 0.9)
  keyLight.position.set(8, 16, 18)
  scene.add(keyLight)
  const fillLight = new THREE.DirectionalLight(0xffffff, 0.45)
  fillLight.position.set(-12, 8, 10)
  scene.add(fillLight)
  const rimLight = new THREE.DirectionalLight(0xffffff, 0.35)
  rimLight.position.set(-3, 14, -14)
  scene.add(rimLight)

  state.renderer = renderer
  state.scene = scene
  state.camera = camera

  window.addEventListener('resize', () => {
    const w = window.innerWidth
    const h = window.innerHeight
    state.renderer.setPixelRatio(window.devicePixelRatio || 1)
    state.renderer.setSize(w, h, false)
    state.camera.aspect = w / h
    state.camera.updateProjectionMatrix()
    if (state.mesh) setAngle(state.currentAngle)
    renderNow()
  })
}

/* ------------------------------------------------------------- 贴图加载统计/等待 */

function installTextureTracker(manager) {
  const stats = state.textureStats
  const isTextureUrl = (url) => /\.(png|jpe?g|bmp|tga|gif|webp)(\?|$)/i.test(String(url))

  const originalStart = manager.itemStart.bind(manager)
  const originalEnd = manager.itemEnd.bind(manager)
  manager.itemStart = (url) => {
    if (isTextureUrl(url)) {
      stats.started += 1
      stats.pending += 1
    }
    originalStart(url)
  }
  manager.itemEnd = (url) => {
    if (isTextureUrl(url)) {
      stats.pending = Math.max(0, stats.pending - 1)
      stats.loaded.push(shortName(url))
    }
    originalEnd(url)
  }
  manager.onError = (url) => {
    if (isTextureUrl(url)) stats.failed.push(shortName(url))
  }
  return stats
}

function shortName(url) {
  const text = String(url)
  const index = text.lastIndexOf('/')
  return index >= 0 ? decodeURIComponent(text.slice(index + 1)) : text
}

function decodeMaybe(url) {
  try {
    return decodeURIComponent(url)
  } catch {
    return url
  }
}

/** 等待贴图加载队列空闲（LoadingManager 的 pending 计数 + 静默窗口）。 */
async function waitTexturesIdle(timeoutMs) {
  const startedAt = Date.now()
  let lastChange = Date.now()
  let lastPending = state.textureStats.pending
  while (Date.now() - startedAt < timeoutMs) {
    const pending = state.textureStats.pending
    if (pending !== lastPending) {
      lastPending = pending
      lastChange = Date.now()
    }
    if (pending === 0 && Date.now() - lastChange > 250) return true
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  log(`waitTexturesIdle timeout: pending=${state.textureStats.pending}`)
  return false
}

/* ------------------------------------------------------------------ 模型与包围盒 */

function computeBindPoseBBox(mesh) {
  const position = mesh.geometry.getAttribute('position')
  const min = new THREE.Vector3(Infinity, Infinity, Infinity)
  const max = new THREE.Vector3(-Infinity, -Infinity, -Infinity)
  const v = new THREE.Vector3()
  for (let i = 0; i < position.count; i++) {
    v.fromBufferAttribute(position, i)
    min.min(v)
    max.max(v)
  }
  return { min, max, size: new THREE.Vector3().subVectors(max, min) }
}

function collectModelInfo(mesh) {
  const geometry = mesh.geometry
  const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material]
  const bones = mesh.skeleton.bones
  const boneNames = bones.map((bone) => bone.name)
  const meshData = geometry.userData.MMD || {}
  const morphDictionary = mesh.morphTargetDictionary || {}
  return {
    name: mesh.name || '',
    vertices: geometry.getAttribute('position')?.count ?? 0,
    triangles: geometry.getIndex() ? Math.floor(geometry.getIndex().count / 3) : 0,
    materials: materials.length,
    materialNames: materials.map((material) => material.name ?? ''),
    boneCount: bones.length,
    boneNames,
    morphCount: Object.keys(morphDictionary).length,
    morphNames: Object.values(morphDictionary)
      .sort((a, b) => a - b)
      .map((index) => Object.keys(morphDictionary).find((key) => morphDictionary[key] === index)),
    ikBones: (meshData.bones || []).filter((bone) => bone && bone.ik).map((bone) => bone.name),
    grantCount: Array.isArray(meshData.grants) ? meshData.grants.length : 0,
    format: meshData.format || '',
    bbox: state.bindBBox
      ? {
          min: state.bindBBox.min.toArray(),
          max: state.bindBBox.max.toArray(),
          size: state.bindBBox.size.toArray(),
        }
      : null,
  }
}

/* ---------------------------------------------------------------------- 相机方位 */

const ANGLE_ALIASES = {
  front: 0,
  side: Math.PI / 2,
  45: Math.PI / 4,
  back: Math.PI,
  '3/4': Math.PI / 4,
}

function parseAngle(angle) {
  if (typeof angle === 'number' && Number.isFinite(angle)) return THREE.MathUtils.degToRad(angle)
  const text = String(angle).trim().toLowerCase()
  if (ANGLE_ALIASES[text] !== undefined) return ANGLE_ALIASES[text]
  const asNumber = Number(text)
  if (Number.isFinite(asNumber)) return THREE.MathUtils.degToRad(asNumber)
  throw new Error(`未知相机角度: ${angle}（支持 front/side/45/back 或角度度数）`)
}

function setAngle(angle) {
  if (!state.renderer) return
  const azimuth = parseAngle(angle)
  state.currentAngle = angle

  const bb = state.bindBBox
  if (!bb) return
  const center = new THREE.Vector3().addVectors(bb.min, bb.max).multiplyScalar(0.5)
  const half = new THREE.Vector3().copy(bb.size).multiplyScalar(0.5)
  state.center.copy(center)

  const camera = state.camera
  const vFov = THREE.MathUtils.degToRad(camera.fov)
  const hFov = 2 * Math.atan(Math.tan(vFov / 2) * camera.aspect)
  // 绕 Y 旋转 azimuth 后，模型在屏幕横向的投影半宽（X/Z 两个方向贡献之和）。
  const projectedHalfWidth =
    Math.abs(half.x * Math.cos(azimuth)) + Math.abs(half.z * Math.sin(azimuth))
  // 安全边距：动作会抬手/蹲下，留 18% 余量，避免裁切。
  const margin = 1.18
  const distanceForHeight = (half.y * margin) / Math.tan(vFov / 2)
  const distanceForWidth = (projectedHalfWidth * margin) / Math.tan(hFov / 2)
  const distance = Math.max(distanceForHeight, distanceForWidth, 1)

  camera.position.set(
    center.x + Math.sin(azimuth) * distance,
    center.y,
    center.z + Math.cos(azimuth) * distance
  )
  camera.lookAt(center)
  camera.updateProjectionMatrix()
}

/* ------------------------------------------------------------------- 播放/采样 */

function frameToSeconds(frame) {
  return Number(frame) / MMD_FPS
}

/**
 * 重新从第 0 帧开始播放（清掉 IK/grant 的上一帧状态）。
 * 说明：不能用 mixer.setTime(t) + helper.update(0) 的「快速定位」——
 * r171 的 PropertyMixer.apply 有「buffer 与上一累加槽相同则跳过 setValue」的优化，
 * 而 MMDAnimationHelper._restoreBones 每帧先把骨骼复位；当 delta=0 且姿势与此前
 * 完全相同时 setValue 被跳过 → 骨骼停留在 restore 后的 rest 姿势（实测 bug）。
 * 结论：采样必须走与真实播放完全一致的逐帧 helper.update(1/30) 路径。
 */
function resetPlayback() {
  if (!state.clip) return
  try {
    state.helper.remove(state.mesh)
  } catch (error) {
    log(`resetPlayback: helper.remove 失败（忽略）: ${String(error)}`)
  }
  // 先把所有骨骼恢复到 bind pose，再重新挂上 clip，保证从 0 帧是一条干净时间线。
  state.mesh.pose()
  state.mesh.updateMatrixWorld(true)
  state.helper.add(state.mesh, { animation: state.clip, physics: false })
  state.helper.update(0)
  state.currentFrame = 0
  state.stepsSinceReset = 0
}

/**
 * 采样到指定 VMD 帧号（30fps）。只支持「向前步进」；需要回退时自动 reset 后重放。
 * 返回实际步进信息（含总步数，便于观察慢动作包）。
 */
function seekFrame(frame) {
  if (!state.clip) return { frame: 0, seconds: 0, clipDuration: 0 }
  const target = Math.max(0, Math.round(Number(frame) || 0))
  if (target < state.currentFrame) resetPlayback()
  const from = state.currentFrame
  const totalSteps = target - from
  // 按 1/30s 逐步 update：与 MMD 播放器/helper 的标准用法完全一致（IK/grant 逐帧收敛）。
  for (let i = 0; i < totalSteps; i++) {
    state.helper.update(1 / MMD_FPS)
    state.stepsSinceReset = (state.stepsSinceReset || 0) + 1
  }
  state.currentFrame = target
  state.mesh.updateMatrixWorld(true)
  const clipDuration = state.clip.duration
  const objects = state.helper && state.helper.objects ? state.helper.objects.get(state.mesh) : null
  const mixer = objects && objects.mixer
  return {
    frame: target,
    seconds: frameToSeconds(target),
    clipDuration,
    looped: frameToSeconds(target) > clipDuration + 1e-6,
    steppedFromFrame: from,
    steps: totalSteps,
    actionTimeSec: mixer ? Math.round(mixer.time * 10000) / 10000 : null,
  }
}

function renderNow() {
  if (!state.renderer || !state.scene || !state.camera) return
  const startedAt = performance.now()
  state.renderer.render(state.scene, state.camera)
  state.lastRenderMs = performance.now() - startedAt
  state.renderCount += 1
}

/** 等两帧 rAF，确保 WebGL 渲染结果已经提交给合成器（capturePage 前用）。 */
async function nextPaint() {
  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
  await new Promise((resolve) => setTimeout(resolve, 0))
}

async function prepareFrame(options = {}) {
  try {
    if (options.angle !== undefined) setAngle(options.angle)
    const seekResult =
      options.frame !== undefined && options.frame !== null
        ? seekFrame(options.frame)
        : { frame: null, seconds: null, clipDuration: state.clip ? state.clip.duration : 0 }
    renderNow()
    await nextPaint()
    return {
      ok: true,
      angle: state.currentAngle,
      seek: seekResult,
      stats: frameStats(),
      renderMs: Math.round(state.lastRenderMs * 100) / 100,
    }
  } catch (error) {
    return fail(error)
  }
}

/* ------------------------------------------------------------------ 帧统计/快照 */

/** 当前 GL 画布 alpha 覆盖率 + 非透明包围盒（同时兼作 WebGL taint 检测）。 */
function frameStats() {
  try {
    const gl = state.renderer.domElement
    const w = Math.max(1, Math.min(240, Math.floor(gl.width / 4)))
    const h = Math.max(1, Math.min(360, Math.floor(gl.height / 4)))
    const canvas = document.createElement('canvas')
    canvas.width = w
    canvas.height = h
    const ctx = canvas.getContext('2d', { willReadFrequently: true })
    ctx.clearRect(0, 0, w, h)
    ctx.drawImage(gl, 0, 0, w, h)
    const data = ctx.getImageData(0, 0, w, h).data
    let nonTransparent = 0
    let minX = w
    let minY = h
    let maxX = -1
    let maxY = -1
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const alpha = data[(y * w + x) * 4 + 3]
        if (alpha > 8) {
          nonTransparent += 1
          if (x < minX) minX = x
          if (x > maxX) maxX = x
          if (y < minY) minY = y
          if (y > maxY) maxY = y
        }
      }
    }
    return {
      width: gl.width,
      height: gl.height,
      sampleWidth: w,
      sampleHeight: h,
      nonTransparentRatio: Math.round((nonTransparent / (w * h)) * 10000) / 10000,
      bbox2d: maxX >= 0 ? { minX, minY, maxX, maxY } : null,
      tainted: false,
    }
  } catch (error) {
    return { tainted: true, error: String(error) }
  }
}

/** 全部骨骼（模型空间）位置/四元数快照；用于跨帧/跨姿势的移动量断言。 */
function boneSnapshot() {
  if (!state.mesh) return null
  state.mesh.updateMatrixWorld(true)
  const bones = state.mesh.skeleton.bones
  const positions = new Float32Array(bones.length * 3)
  const quaternions = new Float32Array(bones.length * 4)
  const worldPosition = new THREE.Vector3()
  const worldQuaternion = new THREE.Quaternion()
  for (let i = 0; i < bones.length; i++) {
    const bone = bones[i]
    bone.getWorldPosition(worldPosition)
    bone.getWorldQuaternion(worldQuaternion)
    positions[i * 3] = worldPosition.x
    positions[i * 3 + 1] = worldPosition.y
    positions[i * 3 + 2] = worldPosition.z
    quaternions[i * 4] = worldQuaternion.x
    quaternions[i * 4 + 1] = worldQuaternion.y
    quaternions[i * 4 + 2] = worldQuaternion.z
    quaternions[i * 4 + 3] = worldQuaternion.w
  }
  return {
    boneNames: bones.map((bone) => bone.name),
    positions: Array.from(positions),
    quaternions: Array.from(quaternions),
  }
}

/* ---------------------------------------------------------------------- 接触表 */

function drawCheckerboard(ctx, x, y, width, height, cellSize = 12) {
  ctx.save()
  ctx.beginPath()
  ctx.rect(x, y, width, height)
  ctx.clip()
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(x, y, width, height)
  ctx.fillStyle = '#e2e2e6'
  for (let row = 0; row * cellSize < height; row++) {
    for (let col = 0; col * cellSize < width; col++) {
      if ((row + col) % 2 === 0) {
        ctx.fillRect(x + col * cellSize, y + row * cellSize, cellSize, cellSize)
      }
    }
  }
  ctx.restore()
}

async function composeSheet(spec = {}) {
  try {
    const frames = spec.frames && spec.frames.length > 0 ? spec.frames : [null]
    const angles = spec.angles && spec.angles.length > 0 ? spec.angles : ['front']
    const cellWidth = Math.max(120, Number(spec.cellWidth) || 300)
    const cellHeight = Math.max(160, Number(spec.cellHeight) || 450)
    // 单角度 + 多帧（例如走路循环的 side 连续帧）时按网格换行排布，避免超长条状图。
    const useGrid = angles.length === 1 && frames.length > 6
    const cols = useGrid ? Math.min(Math.max(2, Number(spec.gridColumns) || 4), frames.length) : angles.length
    const rows = useGrid ? Math.ceil(frames.length / cols) : frames.length
    const cellAt = (row, col) =>
      useGrid
        ? { frame: frames[row * cols + col], angle: angles[0] }
        : { frame: frames[row], angle: angles[col] }

    const canvas = document.getElementById('sheet')
    canvas.width = cols * cellWidth
    canvas.height = rows * cellHeight
    canvas.style.width = `${canvas.width}px`
    canvas.style.height = `${canvas.height}px`
    const ctx = canvas.getContext('2d')
    ctx.clearRect(0, 0, canvas.width, canvas.height)

    const glCanvas = state.renderer.domElement
    const sheetScale = Math.max(0.05, Math.min(1, cellWidth / window.innerWidth))
    const cells = []

    for (let row = 0; row < rows; row++) {
      for (let col = 0; col < cols; col++) {
        const cell = cellAt(row, col)
        if (cell.frame === undefined) continue
        const frame = cell.frame
        const angle = cell.angle
        const x = col * cellWidth
        const y = row * cellHeight
        drawCheckerboard(ctx, x, y, cellWidth, cellHeight)

        // 采样 + 渲染（该函数自身会 setAngle/seek/render/等一帧）
        if (frame !== null && frame !== undefined) seekFrame(frame)
        setAngle(angle)
        renderNow()
        await nextPaint()

        ctx.drawImage(glCanvas, x, y, cellWidth, cellHeight)

        // 单元格边框 + 标签
        ctx.strokeStyle = 'rgba(0,0,0,0.28)'
        ctx.lineWidth = 1
        ctx.strokeRect(x + 0.5, y + 0.5, cellWidth - 1, cellHeight - 1)

        const label = frame === null || frame === undefined
          ? `${angle}`
          : `f${frame} · ${(frame / MMD_FPS).toFixed(2)}s · ${angle}`
        ctx.font = `500 ${Math.max(11, Math.round(cellWidth / 22))}px -apple-system, "PingFang SC", sans-serif`
        const labelWidth = ctx.measureText(label).width
        ctx.fillStyle = 'rgba(255,255,255,0.82)'
        ctx.fillRect(x + 4, y + cellHeight - 24, Math.min(cellWidth - 8, labelWidth + 10), 20)
        ctx.fillStyle = '#1b1b22'
        ctx.fillText(label, x + 9, y + cellHeight - 9)

        const stats = { frame, angle, renderMs: Math.round(state.lastRenderMs * 100) / 100 }
        if (spec.stats) stats.stats = frameStats()
        cells.push(stats)
      }
    }

    const dataUrl = canvas.toDataURL('image/png')
    const base64 = dataUrl.slice(dataUrl.indexOf(',') + 1)
    return {
      ok: true,
      width: canvas.width,
      height: canvas.height,
      scale: sheetScale,
      rows,
      cols,
      base64,
      cells,
    }
  } catch (error) {
    return fail(error)
  }
}

/* -------------------------------------------------------------- 对外 API 实现 */

function applyVpd(vpd) {
  // helper.pose：mesh.pose() 复位 → 按骨名乘算四元数/加算位移 → IK → grant（r171 现成实现）。
  const ikEnabled = !(state.config && state.config.ik === false)
  state.helper.pose(state.mesh, vpd, { resetPose: true, ik: ikEnabled, grant: true })
  state.mesh.updateMatrixWorld(true)
  log(`VPD applied: ${vpd.bones.length} bones`)
}

function collectFootWorldY() {
  if (!state.mesh) return null
  state.mesh.updateMatrixWorld(true)
  const worldPosition = new THREE.Vector3()
  const bones = {}
  let minY = Infinity
  let minName = null
  for (const name of state.footBoneNames || []) {
    const bone = state.mesh.skeleton.getBoneByName(name)
    if (!bone) continue
    bone.getWorldPosition(worldPosition)
    bones[name] = Math.round(worldPosition.y * 10000) / 10000
    if (worldPosition.y < minY) {
      minY = worldPosition.y
      minName = name
    }
  }
  return { bones, minY: Math.round(minY * 10000) / 10000, minBone: minName }
}

/** 脚骨世界高度探针（判断 VMD 是否让角色浮空/陷地；与 bind pose 的同一批骨对比）。 */
function footProbe() {
  if (!state.mesh) return null
  const current = collectFootWorldY()
  const rest = state.restFootWorldY
  const delta = rest && current ? Math.round((current.minY - rest.minY) * 10000) / 10000 : null
  return { rest, current, minYDelta: delta }
}

function snapshotRestBones() {
  const snapshot = {}
  for (const bone of state.mesh.skeleton.bones) {
    snapshot[bone.name] = {
      position: bone.position.toArray(),
      quaternion: bone.quaternion.toArray(),
    }
  }
  return snapshot
}

function compareVpd(rest, applied) {
  let changed = 0
  const sample = []
  for (const bone of state.mesh.skeleton.bones) {
    const before = rest[bone.name]
    if (!before) continue
    const positionDelta = Math.hypot(
      bone.position.x - before.position[0],
      bone.position.y - before.position[1],
      bone.position.z - before.position[2]
    )
    const dot = Math.abs(
      bone.quaternion.x * before.quaternion[0] +
        bone.quaternion.y * before.quaternion[1] +
        bone.quaternion.z * before.quaternion[2] +
        bone.quaternion.w * before.quaternion[3]
    )
    const angleDeg = (2 * Math.acos(Math.min(1, dot)) * 180) / Math.PI
    const delta = Math.max(positionDelta, angleDeg / 10)
    if (delta > 1e-3) {
      changed += 1
      if (sample.length < 12) sample.push({ bone: bone.name, positionDelta, angleDeg })
    }
  }
  return { changedBones: changed, totalBones: state.mesh.skeleton.bones.length, sample }
}

async function init(config) {
  try {
    state.config = config
    state.angles = Array.isArray(config.angles) && config.angles.length > 0 ? config.angles : ['front']
    state.frames = Array.isArray(config.frames) ? config.frames : []

    setupScene(config)

    const manager = new THREE.LoadingManager()
    manager.onStart = (url) => log('LoadingManager start:', decodeMaybe(url))
    manager.onError = (url) => console.error('[preview-renderer] LoadingManager error:', decodeMaybe(url))
    installTextureTracker(manager)

    const loader = new MMDLoader(manager)
    // file:// 场景下不强制 CORS 模式（否则 Chromium 会把 file:// 图片计入跨域纹理 → WebGL 上传失败）。
    loader.setCrossOrigin(undefined)

    log(`loading PMX: ${decodeMaybe(config.pmxUrl)}`)
    const loadedAt = performance.now()
    const mesh = await new Promise((resolve, reject) => {
      loader.load(config.pmxUrl, resolve, undefined, reject)
    })
    const loadMs = performance.now() - loadedAt
    state.mesh = mesh
    await waitTexturesIdle(config.textureTimeoutMs || 90000)
    state.scene.add(mesh)
    state.mesh.updateMatrixWorld(true)

    state.bindBBox = computeBindPoseBBox(mesh)
    state.modelInfo = collectModelInfo(mesh)
    state.restBones = snapshotRestBones()
    state.footBoneNames = [
      '左足首D', '右足首D', '左足先EX', '右足先EX',
      '左つま先', '右つま先', '左足首', '右足首',
      '左足D', '右足D',
    ].filter((name) => mesh.skeleton.getBoneByName(name) !== undefined)
    state.restFootWorldY = collectFootWorldY()

    // physics:false —— 不 new MMDPhysics（本机无 ammo.js）；不传 animation 时 helper 空转。
    state.helper = new MMDAnimationHelper({ afterglow: 0 })
    state.helper.enable('physics', false)

    let clip = null
    let vpd = null
    let vpdCheck = null

    if (config.motion && config.motion.kind === 'vmd') {
      log(`loading VMD: ${decodeMaybe(config.motion.url)}`)
      clip = await new Promise((resolve, reject) => {
        loader.loadAnimation(config.motion.url, mesh, resolve, undefined, reject)
      })
      state.clip = clip
      // 先 update(0) 让 helper 用 bind pose 建立 backupBones 基线（见源码 _saveBones）。
      state.helper.add(mesh, { animation: clip, physics: false })
      if (config.ik === false) {
        // 对照组：关闭 CCDIK（用于判断模型自带 4 根足ＩＫ 对 FK 腿/IK 轨道的覆盖程度）。
        state.helper.enable('ik', false)
        log('CCDIK 已关闭（--ik off）')
      }
      state.helper.update(0)
      state.currentFrame = 0
      state.stepsSinceReset = 0
      log(`VMD clip: duration=${clip.duration.toFixed(3)}s tracks=${clip.tracks.length}（采样走逐帧 update 路径）`)
    } else if (config.motion && config.motion.kind === 'vpd') {
      state.helper.add(mesh, { physics: false })
      applyVpd(config.motion.vpd)
      vpd = { boneCount: config.motion.vpd.bones.length }
      vpdCheck = compareVpd(state.restBones, snapshotRestBones())
      state.vpdCheck = vpdCheck
    } else {
      state.helper.add(mesh, { physics: false })
      state.helper.update(0)
    }

    setAngle(state.angles[0])
    renderNow()
    await nextPaint()

    return {
      ok: true,
      model: state.modelInfo,
      textureStats: {
        started: state.textureStats.started,
        loaded: state.textureStats.loaded.slice(),
        failed: state.textureStats.failed.slice(),
      },
      motion: clip
        ? {
            kind: 'vmd',
            duration: clip.duration,
            trackCount: clip.tracks.length,
            frameRate: MMD_FPS,
            maxFrame: Math.round(clip.duration * MMD_FPS),
          }
        : vpd
          ? { kind: 'vpd', ...vpd, vpdCheck }
          : null,
      loadMs: Math.round(loadMs),
      ikEnabled: !(config.ik === false),
      renderer: {
        webglVersion: state.renderer.capabilities.isWebGL2 ? 2 : 1,
        devicePixelRatio: window.devicePixelRatio || 1,
        viewport: { width: window.innerWidth, height: window.innerHeight },
      },
    }
  } catch (error) {
    return fail(error)
  }
}

window.__previewDebug = state

window.__preview = {
  toolVersion: TOOL_VERSION,
  init,
  setAngle,
  seekFrame,
  prepareFrame,
  boneSnapshot,
  footProbe,
  frameStats,
  composeSheet,
  debugInfo: () => {
    if (!state.mesh || !state.helper) return { ready: false }
    const objects = state.helper.objects ? state.helper.objects.get(state.mesh) : null
    const mixer = objects && objects.mixer
    const probe = ['センター', '上半身', '左腕', '頭', '左足', '左足ＩＫ']
    return {
      ready: true,
      currentFrame: state.currentFrame,
      currentAngle: state.currentAngle,
      hasMixer: Boolean(mixer),
      mixerTime: mixer ? mixer.time : null,
      mixerTimeScale: mixer ? mixer.timeScale : null,
      actionCount: mixer && mixer._actions ? mixer._actions.length : 0,
      actionTimes: mixer && mixer._actions ? mixer._actions.map((action) => action.time) : [],
      clipDuration: state.clip ? state.clip.duration : null,
      clipTrackNames: state.clip ? state.clip.tracks.slice(0, 20).map((track) => track.name) : [],
      helperEnabled: state.helper.enabled,
      bones: probe.map((name) => {
        const bone = state.mesh.skeleton.getBoneByName(name)
        return bone
          ? { name, position: bone.position.toArray().map((value) => Math.round(value * 1000) / 1000), quaternion: bone.quaternion.toArray().map((value) => Math.round(value * 10000) / 10000) }
          : { name, missing: true }
      }),
      bindings: mixer && mixer._bindings
        ? mixer._bindings.slice(0, 4).map((propertyMixer) => {
            const binding = propertyMixer.binding
            return {
              path: binding.path,
              nodeName: binding.node ? binding.node.name : null,
              target: binding.targetObject ? (binding.targetObject.name || binding.targetObject.type) : null,
              bound: binding.getValue !== binding._getValue_unbound,
            }
          })
        : [],
    }
  },
  getState: () => ({
    ready: Boolean(state.modelInfo),
    currentFrame: state.currentFrame,
    currentAngle: state.currentAngle,
    model: state.modelInfo,
    vpdCheck: state.vpdCheck,
    errors: errors.slice(),
  }),
}

log(`renderer loaded (three r${THREE.REVISION})`)
