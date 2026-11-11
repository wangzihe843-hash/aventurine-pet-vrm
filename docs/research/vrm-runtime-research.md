# VRM 运行时实现前调研（Electron + three 0.171 + @pixiv/three-vrm 3.5.5）

- 日期：2026-11-08（Asia/Shanghai）
- 范围：只做调研与文档；不写运行时代码、不改其它文件。
- 方法：读官方规范/官方源码/固定 tag 的 GitHub 源码、three.js r171 源码与文档、Electron 文档；对本仓库 `assets/vrm/aventurine-tpose.vrm` 做只读 GLB JSON 解析；用社区项目做交叉验证。
- 版本锚点：`three@0.171.0`、`@pixiv/three-vrm@3.5.5`、`@pixiv/three-vrm-animation@3.5.5`（`package.json` 已锁定）。
- 可信度：**A**=官方规范/官方源码/官方示例；**B**=官方 API 文档/官方 issue/release note；**C**=可复核的第三方源码/实测注释；**D**=二手概述/AIGC/仅标题（只作线索，不作为实现依据）。
- 所有网络来源的访问日期均为 **2026-11-08**；标注「本地资产解析」的条目是直接读取本仓库 `assets/vrm/aventurine-tpose.vrm` 的只读结果（不是网络来源），解析方法见附录 A。

---

## 0. 先看：四条会改变实现的实测发现

### 0.1 目标模型实际带 `VRMC_vrm.lookAt.type="bone"`

任务描述写的是「无 VRM lookAt 扩展」，但本地只读解析 `assets/vrm/aventurine-tpose.vrm` 的 JSON chunk 得到：

```json
"lookAt": {
  "type": "bone",
  "offsetFromHeadBone": [0, 0.06, 0],
  "rangeMapHorizontalInner": { "inputMaxValue": 90, "outputScale": 9.617992187087125 },
  "rangeMapHorizontalOuter": { "inputMaxValue": 90, "outputScale": 9.617992187087125 },
  "rangeMapVerticalDown":    { "inputMaxValue": 90, "outputScale": 6.73 },
  "rangeMapVerticalUp":      { "inputMaxValue": 90, "outputScale": 4.81 }
}
```

也就是说，three-vrm 3.5.5 加载后 `vrm.lookAt` **非空**，`vrm.lookAt.applier` 是 `VRMLookAtBoneApplier`；眼球会由 `vrm.update(dt)` 自动驱动。任务里「无 lookAt 时如何程序化」仍要回答，但**实现必须先做能力探测**，不能按「一定没有」写死。

> 证据：本地资产解析（非网络来源）；three-vrm 的 VRM 1.0 lookAt 导入逻辑见 [`VRMLookAtLoaderPlugin.ts`](https://github.com/pixiv/three-vrm/blob/v3.5.5/packages/three-vrm-core/src/lookAt/VRMLookAtLoaderPlugin.ts)（`type !== "expression"` 时构造 `VRMLookAtBoneApplier`）。规范允许 `bone` 类型：[VRMC_vrm lookAt](https://github.com/vrm-c/vrm-specification/blob/master/specification/VRMC_vrm-1.0/lookAt.md)。

### 0.2 39 个 MToon 材质全部 `outlineWidthMode = "none"`

解析同一模型：39 个材质全部是 MToon，其中 **21 OPAQUE / 12 MASK / 6 BLEND**，但 **没有任何一个材质配置描边**（`outlineWidthMode` 全为 `"none"`）。three-vrm 的 loader 只在 `outlineWidthMode !== "none" && outlineWidthFactor > 0` 时生成 outline 子材质；所以加载后**没有描边 pass**，`outlinePx` 应为 0。

设计文档里「MToon 自带描边，V6 调参」在当前资产上不成立。要显示描边，必须先在 GLB JSON 里把材质的 MToon 扩展改成 `worldCoordinates`（或 `screenCoordinates`）并给正 `outlineWidthFactor`，再让 loader 生成；运行时直接改材质不会自动补几何分组。透明（BLEND）材质的描边在 MToon 文档里明确「不能正确绘制」，本模型有 6 个 BLEND，需逐材质确认。

> 证据：本地资产解析；[MToon 规范 Outline Width](https://github.com/vrm-c/vrm-specification/blob/master/specification/VRMC_materials_mtoon-1.0/README.md#outline-width)；[three-vrm `_shouldGenerateOutline` 源码](https://github.com/pixiv/three-vrm/blob/v3.5.5/packages/three-vrm-materials-mtoon/src/MToonMaterialLoaderPlugin.ts)；[VRM MToon 文档（Transparent 描边不正确）](https://vrm.dev/en/univrm/shaders/shader_mtoon/)。

### 0.3 把模型从米缩放到 CSS px 会破坏 SpringBone

我们计划用正交相机、世界单位 = CSS px。模型高 1.73 m，若桌宠高 540 px，则 `scale ≈ 312`。three-vrm 官方 guide 明确：**缩放模型后必须按 scale 改 SpringBone 参数**，否则头发/裙摆会「反应过快/过慢、碰撞体错误」：

```js
const scale = 2.0;
vrm.scene.scale.setScalar(scale);
for (const joint of vrm.springBoneManager.joints) {
  joint.settings.stiffness *= scale;
  joint.settings.hitRadius *= scale;
}
for (const collider of vrm.springBoneManager.colliders) {
  const shape = collider.shape;
  if (shape instanceof VRMSpringBoneColliderShapeCapsule) {
    shape.radius *= scale;
    shape.tail.multiplyScalar(scale);
  } else if (shape instanceof VRMSpringBoneColliderShapeSphere) {
    shape.radius *= scale;
  }
}
```

源码里 `stiffness`、`gravityPower` 都是**世界空间位移/秒**（`addScaledVector(worldSpaceBoneAxis, stiffness * delta)`、`addScaledVector(gravityDir, gravityPower * delta)`）。guide 只列了 stiffness / hitRadius / collider，**没有列 gravityPower**；按同一逻辑 gravityPower 大概率也要乘 scale，但官方未写，必须实机验证。更稳的做法是让 VRM 场景保持米制、正交相机 frustum 用米，只在摆放/命中边界把 CSS px 换算成米，这样 SpringBone 永远在 scale=1 下工作。

> 证据：[官方 guide `spring-bones-on-scaled-models.md`](https://github.com/pixiv/three-vrm/blob/v3.5.5/guides/spring-bones-on-scaled-models.md)；[`VRMSpringBoneJoint.ts` 力计算](https://github.com/pixiv/three-vrm/blob/v3.5.5/packages/three-vrm-springbone/src/VRMSpringBoneJoint.ts#L230-L252)。

### 0.4 `vrm.update(dt)` 不能省：它决定 alphaTest、材质 uniform、约束和弹簧

`VRM.update(delta)` 依次做：`humanoid.update()` → `lookAt.update(delta)` → `expressionManager.update()` → `nodeConstraintManager.update()` → `springBoneManager.update(delta)` → 每个 `material.update(delta)`。`MToonMaterial.update()` 里会把 `this.alphaTest` 写进 `uniforms.alphaTest.value`；不调用 `vrm.update` 时，MASK/BLEND 材质的 `alphaTest` 可能停在 0，alpha=0 的纹素（这些贴图里通常是黑色）会被当成不透明画出来。社区项目有实测记录：VRoid 衣服的透明部分变纯黑，补上 `material.update(delta)` 后恢复。

> 证据：[`VRM.ts` L49-L67](https://github.com/pixiv/three-vrm/blob/v3.5.5/packages/three-vrm/src/VRM.ts#L49-L67)；[`MToonMaterial.ts` L486-L489、L538-L543](https://github.com/pixiv/three-vrm/blob/v3.5.5/packages/three-vrm-materials-mtoon/src/MToonMaterial.ts#L486-L543)；社区实测注释见 [`dsh-plugin-vrmpet3d/lib/scene.js`](https://github.com/drliuhuan/dsh-plugin-vrmpet3d/blob/main/lib/scene.js)（`updatePhysics` 注释）。

---

## 一、结论速览

| # | 结论（1 行） | 来源 | 级别 |
|---|---|---|---|
| 1 | 加载 = `GLTFLoader.register(parser => new VRMLoaderPlugin(parser))`，成功后取 `gltf.userData.vrm`。 | [官方 README](https://github.com/pixiv/three-vrm/blob/v3.5.5/packages/three-vrm/README.md) | A |
| 2 | 自定义协议/重试场景用 `fetch → arrayBuffer → loader.parseAsync(buf, basePath)`；VRM 通常自包含，`basePath` 用 URL 目录即可。 | [GLTFLoader r171 `parseAsync`](https://github.com/mrdoob/three.js/blob/r171/examples/jsm/loaders/GLTFLoader.js#L431-L439) | A |
| 3 | VRM 0.x 用 `VRMUtils.rotateVRM0(vrm)`；它只在 `meta.metaVersion === '0'` 时把 `vrm.scene.rotation.y = Math.PI`。 | [`rotateVRM0.ts`](https://github.com/pixiv/three-vrm/blob/v3.5.5/packages/three-vrm/src/VRMUtils/rotateVRM0.ts#L10-L13) | A |
| 4 | 优化 API：`removeUnnecessaryVertices(gltf.scene)`、`combineSkeletons(gltf.scene)`、`combineMorphs(vrm)`；`removeUnnecessaryJoints` 已 deprecated。 | [官方 basic 示例 L84-L86](https://github.com/pixiv/three-vrm/blob/v3.5.5/packages/three-vrm/examples/basic.html#L84-L86)；[`removeUnnecessaryJoints.d.ts`](https://github.com/pixiv/three-vrm/blob/v3.5.5/packages/three-vrm/types/VRMUtils/removeUnnecessaryJoints.d.ts) | A |
| 5 | 释放用 `VRMUtils.deepDispose(vrm.scene)`；它 traverse 释放 geometry、skeleton、material 及其贴图。 | [`deepDispose.ts` L29-L51](https://github.com/pixiv/three-vrm/blob/v3.5.5/packages/three-vrm/src/VRMUtils/deepDispose.ts#L29-L51) | A |
| 6 | `autoUpdateHumanBones` 默认 `true`：`humanoid.update()` 把 normalized 骨骼姿态拷到 raw；设 false 后 normalized 写入不会到蒙皮骨，**不要为了「避免 raw 冲突」关掉它**。 | [`VRMHumanoid.ts` L294-L297](https://github.com/pixiv/three-vrm/blob/v3.5.5/packages/three-vrm-core/src/humanoid/VRMHumanoid.ts#L294-L297) | A |
| 7 | `humanoid.update()` 对**所有** humanoid 骨拷贝 rotation，但**只对 hips 拷贝 position**；写 normalized 的胸/脚 position 会被丢弃。 | [`VRMHumanoidRig.ts` L112-L139](https://github.com/pixiv/three-vrm/blob/v3.5.5/packages/three-vrm-core/src/humanoid/VRMHumanoidRig.ts#L112-L139) | A |
| 8 | 推荐帧序：写 normalized（含 hips position）→ `humanoid.update()`（测脚/贴地）→ 表情 `setValue` → look-at/head additive → `vrm.update(clampedDt)` → render。 | [VRMCore L72-L82](https://github.com/pixiv/three-vrm/blob/v3.5.5/packages/three-vrm-core/src/VRMCore.ts#L72-L82)；[VRM L49-L67](https://github.com/pixiv/three-vrm/blob/v3.5.5/packages/three-vrm/src/VRM.ts#L49-L67) | A |
| 9 | SpringBone 直接吃秒级 `delta`，无内部 clamp/substep；大 dt 会爆炸，必须外部钳制（建议 ≤0.1s，或固定 1/60 步长）。 | [`VRMSpringBoneJoint.ts` L230-L252](https://github.com/pixiv/three-vrm/blob/v3.5.5/packages/three-vrm-springbone/src/VRMSpringBoneJoint.ts#L230-L252) | A |
| 10 | three r155+ 物理光照不再内部乘 π；Directional/Ambient/Hemisphere 要恢复旧观感应乘 π；r171 已没有 `useLegacyLights`。 | [three.js r155 光照说明](https://discourse.threejs.org/t/updates-to-lighting-in-three-js-r155/53733)；[Migration Guide](https://github.com/mrdoob/three.js/wiki/Migration-Guide) | A |
| 11 | MToon 的直接光用 `BRDF_Lambert`（1/π），所以官方示例给 DirectionalLight 强度 `Math.PI`；MToon 的 `postCorrection` 会走 tone mapping / color space。 | [MToon `mtoon.frag` L96-L100、L147](https://github.com/pixiv/three-vrm/blob/v3.5.5/packages/three-vrm-materials-mtoon/src/shaders/mtoon.frag#L96-L147)；[basic.html L58](https://github.com/pixiv/three-vrm/blob/v3.5.5/packages/three-vrm/examples/basic.html#L58) | A |
| 12 | MToon 推荐起点：`NoToneMapping`、`outputColorSpace = SRGBColorSpace`、Directional π 左右 + Hemisphere 0.6–1.6 + 可选 fill；环境贴图对 MToon 无效。 | [basic 示例](https://github.com/pixiv/three-vrm/blob/v3.5.5/packages/three-vrm/examples/basic.html)；[`mtoon.frag` envmap 被注释](https://github.com/pixiv/three-vrm/blob/v3.5.5/packages/three-vrm-materials-mtoon/src/shaders/mtoon.frag#L90-L91) | A |
| 13 | 描边 `outlineWidthMode`：`none` / `worldCoordinates`（规范按米定义，前提是世界单位=米）/ `screenCoordinates`（factor 是屏幕高度比例）。缩放场景下的实际单位见 2.3.4。 | [MToon 规范](https://github.com/vrm-c/vrm-specification/blob/master/specification/VRMC_materials_mtoon-1.0/README.md#outline-width) | A |
| 14 | 目标模型 39 材质全 `outlineWidthMode = "none"`，当前不会有描边；要描边需先 patch VRM 再加载。 | 本地资产解析；[MToon loader `_shouldGenerateOutline`](https://github.com/pixiv/three-vrm/blob/v3.5.5/packages/three-vrm-materials-mtoon/src/MToonMaterialLoaderPlugin.ts) | A/C |
| 15 | `expressionManager.setValue(name, w)` 只写 weight、clamp 0..1，未知名字静默无效；真正写 morph/材质的是 `vrm.update()` 内的 `expressionManager.update()`。 | [`VRMExpressionManager.ts` L164-L171、L214-L245](https://github.com/pixiv/three-vrm/blob/v3.5.5/packages/three-vrm-core/src/expressions/VRMExpressionManager.ts#L164-L245) | A |
| 16 | VRM 1.0 preset 共 18 个（含 `neutral`，规范注明它只是向后兼容保留）；本模型 17 preset（无 neutral）+ 78 custom = 95。 | [expressions 规范](https://github.com/vrm-c/vrm-specification/blob/master/specification/VRMC_vrm-1.0/expressions.md#other)；[preset 源码](https://github.com/pixiv/three-vrm/blob/v3.5.5/packages/three-vrm-core/src/expressions/VRMExpressionPresetName.ts) | A |
| 17 | override 规则：`multiplier = max(0, 1 - Σ overrideAmount)`；`happy`/`relaxed` 带 `overrideBlink="blend"` 会压眨眼；本模型无 `overrideMouth`，口型安全。 | [`VRMExpressionManager.ts` L247-L260](https://github.com/pixiv/three-vrm/blob/v3.5.5/packages/three-vrm-core/src/expressions/VRMExpressionManager.ts#L247-L260)；本地资产解析 | A/C |
| 18 | 目标模型有 bone 型 lookAt，优先用 `vrm.lookAt`（可设 `target`/`yaw`/`pitch`）；头部 additive 仍要自己写。 | 本地资产解析；[`VRMLookAt` L280-L289](https://github.com/pixiv/three-vrm/blob/v3.5.5/packages/three-vrm-core/src/lookAt/VRMLookAt.ts#L280-L289) | A/C |
| 19 | three-vrm 没有 `VRMLookAtProceduralApplier` 这个类；程序化的是 `VRMLookAtBoneApplier`，可手动 `new VRMLookAt(humanoid, new VRMLookAtBoneApplier(...))`，但模型要有 leftEye/rightEye。 | [lookAt 类型导出](https://github.com/pixiv/three-vrm/blob/v3.5.5/packages/three-vrm-core/src/lookAt/VRMLookAtBoneApplier.ts#L127-L190) | A |
| 20 | 眨眼用 `setValue("blink", w)`；不要直接写 morph target，否则会和表情/口型/override 抢同一批权重。 | [`VRMExpressionManager.ts`](https://github.com/pixiv/three-vrm/blob/v3.5.5/packages/three-vrm-core/src/expressions/VRMExpressionManager.ts#L164-L171) | A |
| 21 | VRMA 是标准 glTF 扩展：humanoid 骨 rotation、**只允许 hips translation**、表情用节点 translation.x、lookAt 用节点 rotation；30fps 是规范建议值。 | [VRMA 规范](https://github.com/vrm-c/vrm-specification/blob/master/specification/VRMC_vrm_animation-1.0/README.md) | A |
| 22 | three-vrm 的 `createVRMAnimationClip` 把 hips translation 按 `humanoid.normalizedRestPose.hips.position[1] / animation.restHipsPosition.y` 缩放；这正是我们 `hipsRestHeight / sourceHipsHeight` 的口径。 | [`createVRMAnimationClip.ts` L12-L45](https://github.com/pixiv/three-vrm/blob/v3.5.5/packages/three-vrm-animation/src/createVRMAnimationClip.ts#L12-L45) | A |
| 23 | 自定义 JSON normalized 动画与 VRMA 的取舍：本项目现有 52 骨、逐帧 quaternion、每 clip 贴地元数据，**V1 继续用 JSON 更直接**；VRMA 适合导入外部动作或对外交换。 | [VRMA 示例](https://github.com/pixiv/three-vrm/blob/v3.5.5/packages/three-vrm-animation/examples/loader-plugin.html)；本仓库 clip schema | A/C |
| 24 | 贴地：静态 bbox 只保证 rest pose；动画 clip 用「每 clip 常量残差（最低脚骨世界 y）」，不要每帧硬钳根节点，否则走路会上下抖。 | 本仓库 `docs/wave2-vrm-runtime-design.md` §2.2；社区静态 bbox 做法见 [`core.js`](https://github.com/drliuhuan/dsh-plugin-vrmpet3d/blob/main/lib/core.js) | C |
| 25 | 透明窗口：`transparent:true` + `frame:false` + `hasShadow:false` + `backgroundColor:'#00000000'`；WebGL 用 `alpha:true`、`setClearColor(0,0)`、`premultipliedAlpha:true`。 | [Electron BaseWindow](https://www.electronjs.org/docs/latest/api/base-window)；[three.js WebGLRenderer 参数](https://github.com/mrdoob/three.js/blob/r171/docs/api/en/renderers/WebGLRenderer.html#L39-L60) | A |
| 26 | 浏览器合成器**假定 drawing buffer 是预乘 alpha**；默认 `premultipliedAlpha:true` 不要关，否则边缘会发黑/发白。 | [MDN getContext](https://developer.mozilla.org/en-US/docs/Web/API/HTMLCanvasElement/getContext)；[WebGL and Alpha](https://webglfundamentals.org/webgl/lessons/webgl-and-alpha.html) | A |
| 27 | `preserveDrawingBuffer` 默认 false；只有需要 `toDataURL`/`readPixels` 跨帧读取时才开，代价是每帧一次拷贝。 | [WebGLRenderer 文档 L54-L55](https://github.com/mrdoob/three.js/blob/r171/docs/api/en/renderers/WebGLRenderer.html#L54-L55) | A |
| 28 | DPR：`setPixelRatio(min(devicePixelRatio, cap))` + `setSize(cssW, cssH, false)`；正交相机 frustum 用 CSS px（或米），**不要**把相机尺寸乘 DPR。 | [setSize 文档 L639-L646](https://github.com/mrdoob/three.js/blob/r171/docs/api/en/renderers/WebGLRenderer.html#L639-L646) | A |
| 29 | 每个 overlay 窗口只建一个 `WebGLRenderer`，模型切换只 `deepDispose` 旧模型，不重建 renderer；窗口关闭才 `dispose()`/`forceContextLoss()`。 | 工程建议（基于 WebGL 上下文成本）；[`WebGLRenderer.dispose`](https://github.com/mrdoob/three.js/blob/r171/docs/api/en/renderers/WebGLRenderer.html) | C |
| 30 | `capturePage()` 对透明置顶窗口可能返回全透明（社区实测）；证据抓帧优先从 renderer `readPixels`，或接受 `capturePage` 的已知不确定性。 | [DSH 插件 `desktop/main.js` 注释](https://github.com/drliuhuan/dsh-plugin-vrmpet3d/blob/main/desktop/main.js) | C |

---

## 二、逐条参考做法与代码片段

### 2.1 加载、VRM 0.x、优化与释放

#### 2.1.1 最小加载流程

```ts
import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { VRMLoaderPlugin } from '@pixiv/three-vrm'

const loader = new GLTFLoader()
loader.register((parser) => new VRMLoaderPlugin(parser))

const gltf = await loader.loadAsync(vrmUrl)
const vrm = gltf.userData.vrm
if (!vrm) throw new Error('not a VRM')
scene.add(vrm.scene)
```

官方 README 的写法就是 `loader.register` + `gltf.userData.vrm`；插件在 `afterRoot` 里组装 `VRMCore`/`VRM`。参考：[README](https://github.com/pixiv/three-vrm/blob/v3.5.5/packages/three-vrm/README.md)、[`VRMLoaderPlugin.ts`](https://github.com/pixiv/three-vrm/blob/v3.5.5/packages/three-vrm/src/VRMLoaderPlugin.ts)。

#### 2.1.2 fetch arrayBuffer + parseAsync（项目协议/重试路径）

`GLTFLoader.loadAsync` 内部也是 `fetch` + `parse`，但我们要接 `pet-asset://`、重试 loader、贴图追踪，所以显式拿 buffer 更可控：

```ts
const res = await fetch(vrmUrl)
if (!res.ok) throw new Error(`VRM fetch ${res.status}`)
let buf: ArrayBuffer = await res.arrayBuffer()

// 本仓库已有：修掉 MToon 非法贴图引用（如 shadeMultiplyTexture: {}）
// 纯函数，不依赖 DOM；返回新的 Uint8Array
const patched = patchVrmGlbBuffer(new Uint8Array(buf))
buf = patched.data.buffer.slice(patched.data.byteOffset, patched.data.byteOffset + patched.data.byteLength)

const gltf = await loader.parseAsync(buf, new URL('.', vrmUrl).href)
```

注意：

- `parseAsync(data, path)` 的 `path` 是**资源基准目录**，不是文件 URL；VRM 一般内嵌贴图，传 URL 目录即可。签名见 [GLTFLoader r171 L431-L439](https://github.com/mrdoob/three.js/blob/r171/examples/jsm/loaders/GLTFLoader.js#L431-L439)。
- 如果 `fetch` 走自定义协议，`Content-Type` 不重要，`arrayBuffer()` 即可；但要保证返回完整 GLB（`glTF` magic + version 2）。
- 本仓库的 `patchVrmGlbBuffer` 是 W0-5 为「空 MToon 贴图对象导致 GLTFLoader TypeError」加的；位置见 [`src/shared/vrm-glb.ts`](../../src/shared/vrm-glb.ts)。打补丁后再 parse，失败时再考虑「不 patch 重试」或反向。
- 贴图加载追踪：给 `GLTFLoader` 传同一个 `LoadingManager`（项目已有 `createPetAssetLoadTracker`），否则 `waitForTextures` 统计不到 VRM 内部贴图。

#### 2.1.3 VRM 0.x 朝向

```ts
import { VRMUtils } from '@pixiv/three-vrm'
VRMUtils.rotateVRM0(vrm) // metaVersion==='0' 时 scene.rotation.y = Math.PI
```

源码只有这一行判断：[`rotateVRM0.ts` L10-L13](https://github.com/pixiv/three-vrm/blob/v3.5.5/packages/three-vrm/src/VRMUtils/rotateVRM0.ts#L10-L13)。

- 它改的是 `vrm.scene.rotation.y`，不是网格/骨骼；调用一次即可，重复调用结果相同但会覆盖你自己对 `vrm.scene.rotation` 的其他设置。
- 目标模型是 VRM 1.0，调用是 no-op；canary 0.x 仍要调用。
- 调用后再算 rest bbox、朝向/`faceFront`、摆放；不要在调用前缓存 bbox。

#### 2.1.4 官方示例的优化顺序

```ts
VRMUtils.removeUnnecessaryVertices(gltf.scene)
VRMUtils.combineSkeletons(gltf.scene)
VRMUtils.combineMorphs(vrm)
vrm.scene.traverse((obj) => { obj.frustumCulled = false })
```

- 官方 basic 示例顺序：[basic.html L84-L93](https://github.com/pixiv/three-vrm/blob/v3.5.5/packages/three-vrm/examples/basic.html#L84-L93)。
- `removeUnnecessaryVertices` 只处理有 index 的 geometry；它会重写 morph attributes，降低 morph texture 的 VRAM（95 表情模型值得试）。见 [`removeUnnecessaryVertices.ts` L345](https://github.com/pixiv/three-vrm/blob/v3.5.5/packages/three-vrm/src/VRMUtils/removeUnnecessaryVertices.ts#L345)。
- `combineSkeletons` 合并多个 skinned mesh 的 skeleton，减少每帧骨骼矩阵计算；`combineMorphs` 按 VRM expression 合并 morph target，降低 morph texture 数量。
- `removeUnnecessaryJoints` 已 deprecated，官方 VRMA 示例里还在用（旧示例），新代码用 `combineSkeletons`；类型注释明确写了「next major version 会移除」：[`removeUnnecessaryJoints.d.ts`](https://github.com/pixiv/three-vrm/blob/v3.5.5/packages/three-vrm/types/VRMUtils/removeUnnecessaryJoints.d.ts)。
- **风险**：社区项目 `dsh-plugin-vrmpet3d` 实测 `removeUnnecessaryVertices` + `combineSkeletons` 两者同时开启会让部分模型（HatsuneMikuNT、蓝色小肥鱼）裙摆/刘海变形；他们最终两个都关掉。结论：这两个 API 不是「无条件安全」，必须对 `aventurine-tpose.vrm` 做 A/B 截图（T-pose、idle、走路、摸头各一张），确认无变形再保留。参考：[`scene.js` `wrapVRM` 注释](https://github.com/drliuhuan/dsh-plugin-vrmpet3d/blob/main/lib/scene.js)。
- `frustumCulled = false` 对 skinned mesh 很重要：three.js 的 bounding sphere 不随骨骼更新，动画后可能整只宠物被视锥剔除。官方示例明确这么做。

#### 2.1.5 释放

```ts
scene.remove(vrm.scene)
vrm.scene.removeFromParent()
VRMUtils.deepDispose(vrm.scene) // geometry / skeleton / material / texture
// 如用过 AnimationMixer：
// mixer.stopAllAction(); mixer.uncacheRoot(vrm.scene)
```

- `deepDispose` 的实现是 traverse 每个 node，`geometry.dispose()`、`skeleton.dispose()`、`material.dispose()`，并递归释放 material 上的 texture 与 ShaderMaterial uniforms 里的 texture：[`deepDispose.ts` L29-L51](https://github.com/pixiv/three-vrm/blob/v3.5.5/packages/three-vrm/src/VRMUtils/deepDispose.ts#L29-L51)。
- 它不会自动停掉 `AnimationMixer`、不会清 `renderer.renderLists`；如果加载过 VRMA/AnimationClip，先 `stopAllAction()` + `uncacheRoot()`，否则 mixer 的 binding table 会继续引用骨骼（社区项目也踩过）。参考：[`scene.js` `dispose`](https://github.com/drliuhuan/dsh-plugin-vrmpet3d/blob/main/lib/scene.js)。
- 释放后把 `vrm`/`gltf`/`avatar` 的引用置空；否则 JS 侧仍持有 scene graph。

### 2.2 normalized humanoid 的写入顺序、autoUpdate 与 spring

#### 2.2.1 normalized 与 raw 的边界

three-vrm 在加载时构造一个**独立的 normalized rig**（`VRMHumanoidRig`），并把它加到 `gltf.scene`：

- raw 骨 = 原模型的蒙皮骨；mesh 的 `skin`/`skeleton` 绑的是 raw。
- normalized 骨 = 另一棵 `Object3D` 树，名字是 `Normalized_<rawName>`；它的 rest position 是从 raw 世界位置反推的偏移，rest rotation 是 identity。
- `humanoid.getNormalizedBoneNode(name)` 拿到的是 normalized 树里的节点；`getRawBoneNode(name)` 拿到 raw。
- `humanoid.update()` 把 normalized 的 **rotation 全部**、**position 仅 hips** 写回 raw；其他骨的位置写入会被丢弃。

证据：[`VRMHumanoidLoaderPlugin.ts` L140-L143](https://github.com/pixiv/three-vrm/blob/v3.5.5/packages/three-vrm-core/src/humanoid/VRMHumanoidLoaderPlugin.ts#L140-L143)（`gltf.scene.add(humanoid.normalizedHumanBonesRoot)`）、[`VRMHumanoidRig.ts` L112-L139](https://github.com/pixiv/three-vrm/blob/v3.5.5/packages/three-vrm-core/src/humanoid/VRMHumanoidRig.ts#L112-L139)。

因此：

- 我们写 normalized 的 quaternion（相对 rest）是正确口径；normalized rest rotation = identity，直接写 clip 的局部旋转即可。
- Hips 的 position 要写**绝对 normalized 位置**：`restHipsPosition + scaledClipOffset`，不能只写 offset，也不能每帧累加。
- 不要写 normalized 的 chest/neck/head position；只有 rotation 会生效（呼吸用 rotation，不要用 chest 位移）。
- 不要写 raw humanoid 骨：`autoUpdateHumanBones` 为 true 时，下一次 `humanoid.update()` 会覆盖它；`rawPolicy=spring` 的本意就是「raw 只让 SpringBone 写，humanoid raw 由 normalized 驱动」。

#### 2.2.2 推荐帧序（单 writer 原则）

```ts
function frame(dtSeconds: number) {
  const dt = Math.min(Math.max(dtSeconds, 0), 0.1) // 1) 先钳制 dt

  // 2) 选 clip / 交叉淡入 / 采样，写 normalized 骨
  clipPlayer.update(dt)

  // 3) 表情/口型/眨眼：只 setValue，不手动 update
  expressionLayer.update(dt)

  // 4) 头部 additive（写 normalized head）——必须在同步 raw 之前
  lookAt.applyHeadAdditive(dt)

  // 5) 同步 raw + 更新世界矩阵（测脚 / lookAt 需要）
  vrm.humanoid.update()
  vrm.scene.updateMatrixWorld(true)

  // 6) 每 clip 常量贴地；如果改的是 stage/root，改完再更新一次世界矩阵
  clipPlayer.applyGrounding()
  // 若 grounding 改了 root：vrm.scene.updateMatrixWorld(true)

  // 7) 眼球 lookAt 参数（用本帧 head world 计算）
  lookAt.updateEyes(dt) // 设置 vrm.lookAt.target / yaw / pitch，或手动 applier

  // 8) 一次 vrm.update：humanoid → lookAt → expressions → constraints → spring → materials
  vrm.update(dt)

  renderer.render(scene, camera)
}
```

为什么这样排：

- `VRMCore.update()` 的顺序是 `humanoid.update()` → `lookAt.update(delta)` → `expressionManager.update()`；`VRM.update()` 再 `nodeConstraintManager.update()` → `springBoneManager.update(delta)` → `material.update(delta)`。见 [VRMCore L72-L82](https://github.com/pixiv/three-vrm/blob/v3.5.5/packages/three-vrm-core/src/VRMCore.ts#L72-L82) 与 [VRM L49-L67](https://github.com/pixiv/three-vrm/blob/v3.5.5/packages/three-vrm/src/VRM.ts#L49-L67)。
- 因此在 `vrm.update` 之前写 normalized 和 `setValue`，同帧就能生效；如果把 `setValue` 放在 `vrm.update` 之后，表情会晚一帧。
- **头部 additive 必须在「同步 raw + 更新世界矩阵」之前**；否则 `vrm.update` 内部 `lookAt.update` 读到的 `head.matrixWorld` 还是 additive 之前的，眼睛会慢一帧/算错。第 5 步的 `humanoid.update()` 把 additive 后的 normalized head 拷到 raw，`updateMatrixWorld(true)` 让 lookAt 看到它。
- 如果 clip player 为了测脚已经手动 `humanoid.update()`，第 5 步再调一次没问题；关键是顺序：**先写完所有 normalized，再 humanoid.update + updateMatrixWorld，再让 lookAt 读世界矩阵**。
- 如果使用 `vrm.lookAt`，第 7 步只设 `target`/`yaw`/`pitch`，不要手动 `lookAt.update`；`vrm.update` 会按正确顺序调用。若没有 `vrm.lookAt`，第 7 步用 `VRMLookAtBoneApplier.applyYawPitch` 手动写 eye（它同时写 raw/normalized；随后 `vrm.update` 的 humanoid.update 会再同步一次，幂等）。
- SpringBone manager 自己会更新 ancestors 的 world matrix；所以 spring 不依赖你提前 `updateMatrixWorld`，但 lookAt 和测脚依赖。

#### 2.2.3 `autoUpdateHumanBones` 语义

- 默认 `true`；`humanoid.update()` 里 `if (autoUpdateHumanBones) this._normalizedHumanBones.update()`。
- `false` 时 `humanoid.update()` 什么都不做；normalized 写入不会到 raw，mesh 会保持 raw 的当前姿态（通常是 T-pose），但 SpringBone 仍会动 raw 的头发/衣摆。**我们的 rawPolicy=spring 不需要 false**。
- 只有在「直接写 raw 骨」的 MMD/自定义 rig 路线才考虑 false；three-vrm 的 VRM1.0 normal workflow 保持 true。
- 证据：[`VRMHumanoid.ts` L294-L297](https://github.com/pixiv/three-vrm/blob/v3.5.5/packages/three-vrm-core/src/humanoid/VRMHumanoid.ts#L294-L297)、[`VRMLoaderPluginOptions.d.ts`](https://github.com/pixiv/three-vrm/blob/v3.5.5/packages/three-vrm/types/VRMLoaderPluginOptions.d.ts)。

#### 2.2.4 SpringBone 对 dt 的要求

```ts
// 方案 A（V1 推荐）：一次 vrm.update，弹簧跟 rAF 的 dt
const dt = Math.min(Math.max(clock.getDelta(), 0), 0.1)
vrm.update(dt)

// 方案 B（要确定性/固定步长）：不要同时再调 vrm.update，否则 spring 会走两次
const FIXED = 1 / 60
acc += Math.min(dt, 0.1)
let steps = 0
while (acc >= FIXED && steps++ < 5) {
  vrm.springBoneManager?.update(FIXED)
  acc -= FIXED
}
if (vrm.nodeConstraintManager) vrm.nodeConstraintManager.update()
for (const m of vrm.materials ?? []) m.update(dt)
```

- `VRMSpringBoneJoint.update(delta)` 在 `delta <= 0` 时直接 return；`stiffness * delta`、`gravityPower * delta` 都是秒级积分，没有内部 substep/clamp。大 dt（切后台、窗口被遮挡、DevTools 暂停）会让弹簧「跳」甚至爆炸。源码：[`VRMSpringBoneJoint.ts` L230-L252](https://github.com/pixiv/three-vrm/blob/v3.5.5/packages/three-vrm-springbone/src/VRMSpringBoneJoint.ts#L230-L252)。
- 社区项目用固定 `1/60` 累加器，并限制每帧最多 5 步，避免长卡顿后追帧爆炸；可复用这个思路：[`scene.js` `stepPhysics`](https://github.com/drliuhuan/dsh-plugin-vrmpet3d/blob/main/lib/scene.js)。
- 如果模型被缩放（我们的 CSS px 场景），还必须按 0.3 的 guide 缩放 `stiffness` / `hitRadius` / collider 的 radius & tail；`gravityPower` 按源码也应缩放，但 guide 未写，需实机确认。
- 缩放参数的时机：应在**最终 scale 确定后**设置一次；如果窗口 resize/宠物大小变化会改 scale，必须保存 joint/collider 的初始参数，按新 scale 重算，不能反复 `*= scale`（会累积）。官方 guide 也提醒动态缩放要建初始参数 Map。
- 如果采用「米制模型 + 米制正交 frustum」的方案，则 scale=1，以上参数都不用改，这是更稳的选择。

### 2.3 MToon 在 three r155+ 物理光照下的配置

#### 2.3.1 为什么是 π

three.js r155 起 `useLegacyLights` 默认 false：光照强度不再在内部乘 π。要恢复旧观感，Ambient/Hemisphere/Directional/LightMap 的强度要乘 π：

> "The intensities for ambient, hemisphere, directional lights and light maps can be restored by multiplying PI with the existing light intensity values."

来源：[three.js 官方论坛 r155 光照说明](https://discourse.threejs.org/t/updates-to-lighting-in-three-js-r155/53733)；迁移指南：[Migration Guide](https://github.com/mrdoob/three.js/wiki/Migration-Guide)（154→155）。

MToon 的直接光漫反射是：

```glsl
vec3 col = lightColor * BRDF_Lambert(mix(shadeColor, diffuseColor, shading));
// BRDF_Lambert = diffuseColor / PI
```

所以 DirectionalLight 强度 π、NdotL=1、shading=1 时，输出约等于 `diffuseColor`。官方 three-vrm 示例正是 `new THREE.DirectionalLight(0xffffff, Math.PI)`：[basic.html L58](https://github.com/pixiv/three-vrm/blob/v3.5.5/packages/three-vrm/examples/basic.html#L58)。

r171 的 `WebGLRenderer` 源码里已经没有 `useLegacyLights` 属性；不要再写 `renderer.useLegacyLights = true`（TypeScript 会报错，运行时也不存在）。r155 默认 false、r165 移除，见论坛与迁移指南。

#### 2.3.2 推荐起点（透明 overlay、二次元角色）

```ts
renderer.outputColorSpace = THREE.SRGBColorSpace // r171 默认也是
renderer.toneMapping = THREE.NoToneMapping       // 默认；MToon 的 toon 色不被 ACES 压暗/去饱和
renderer.toneMappingExposure = 1

const key = new THREE.DirectionalLight(0xffffff, Math.PI) // 3.14
key.position.set(1, 2, 2).normalize()
scene.add(key)

const fill = new THREE.DirectionalLight(0xbcd4ff, 0.6)
fill.position.set(-2, 1, 1).normalize()
scene.add(fill)

const hemi = new THREE.HemisphereLight(0xdfeaff, 0x2a3350, 0.8)
scene.add(hemi)
```

- 这是**起点**，不是唯一解。社区项目 `dsh-plugin-vrmpet3d` 用 `HemisphereLight(0xdfeaff, 0x2a3350, 1.6)` + key `2.1` + fill `0.7`，NoToneMapping；可作为第二个参考点：[`scene.js` L1608-L1623](https://github.com/drliuhuan/dsh-plugin-vrmpet3d/blob/main/lib/scene.js)。
- MToon 的间接光也是 `irradiance * BRDF_Lambert(diffuseColor)`（1/π），所以 Ambient/Hemisphere 的 π 强度约等于「满 diffuses 填充」。key π + hemi 1.6 已经接近/超过 1，容易过曝；建议 key 2.2–3.14、hemi 0.6–1.2 起步，按截图调。
- MToon 的环境贴图代码在 shader 里被注释掉了（`// #include <envmap_fragment>`），`scene.environment` 对 MToon **无效**；不要为 MToon 加 HDR 环境来救暗部，应该加 Ambient/Hemisphere。源码：[`mtoon.frag` L90-L91、L800](https://github.com/pixiv/three-vrm/blob/v3.5.5/packages/three-vrm-materials-mtoon/src/shaders/mtoon.frag#L90-L91)。
- 不要开阴影作为默认：透明 overlay 上阴影贴图容易在头发/脸部产生脏边，成本也高；要「脚底接地感」用一张 soft blob 或烘焙阴影即可。若开阴影，MToon 的 shadow 是乘在 shading 上（不是简单压暗），参数要单独调。
- ACES/AgX 会改变 MToon 的目标色，尤其是高饱和的砂金/青色；如果非要用 tone mapping，先固定 `toneMappingExposure` 为 1.0–1.3，再用同一张脸部特写对比 NoToneMapping，确认没有「灰脸」。官方示例未设置 toneMapping（默认 NoToneMapping），这是最保守的基准。

#### 2.3.3 「黑面/过曝」排查顺序

按优先级：

1. **`vrm.update(dt)` 是否每帧调用**：不调用 → `material.update(delta)` 不执行 → `uniforms.alphaTest` 可能为 0 → MASK/BLEND 的 alpha=0 纹素被画成不透明黑色。本模型 12 MASK + 6 BLEND，最容易命中的是衣服/发饰。检查 `material.alphaTest` 与 `material.uniforms.alphaTest.value` 是否一致。
2. **光照强度是否还是旧值 1**：r171 物理光照下 Directional 1 只有 π 分之一的亮度；模型会整体暗，暗部接近黑。把 key 提到 2.2–3.14。
3. **是否有 Ambient/Hemisphere**：只有 Directional 时，背光面直接落到 `shadeColorFactor`；如果 shade 本身近黑，就是黑脸/黑背。加 hemi 0.6–1.2。
4. **`shadeColorFactor` / `litFactor` 是否近黑**：模型 39 个 MToon 材质的 shade 颜色可能本来就深；用调试面板打印 `material.shadeColorFactor.getHexString()`、`litFactor`、`outlineColorFactor`（社区项目的诊断代码可参考：[`desktop-page.js` `materials()`](https://github.com/drliuhuan/dsh-plugin-vrmpet3d/blob/main/lib/desktop-page.js)）。
5. **颜色空间**：`renderer.outputColorSpace` 必须是 `SRGBColorSpace`；贴图 `map.colorSpace` 必须是 `SRGBColorSpace`（GLTFLoader 会设置，手动换贴图时要设）。如果设成 Linear，整体会暗/灰。
6. **过曝**：key π + hemi 1.6 + ambient 再加、或 emissive 高、或 ACES exposure >1，都会把白衣服/脸部推到 1.0 截断。先降 hemi/ambient，再降 key；不要用 tone mapping 去救过曝，先让直接光+间接光总和 ≤1。
7. **法线/缩放**：负 scale 会翻转 winding，MToon 双面/背面法线可能变黑；不要用负 scale 镜像模型。`doubleSided` 材质由 shader 翻法线，但 outline/背面仍可能异常。
8. **描边**：如果启用了 outline，`outlineColorFactor` 默认黑、`outlineLightingMixFactor` 可能让描边在暗部更黑；全黑描边贴着头发/脸会像「黑边」。本模型当前没有 outline，先排除这一项。

#### 2.3.4 MToon 描边的单位与启用方式

规范：

- `outlineWidthMode = "none"`：不画。
- `"worldCoordinates"`：宽度是世界坐标距离；`outlineWidthFactor` 按规范单位是**米**（前提：场景世界单位也是米）。
- `"screenCoordinates"`：宽度依赖屏幕坐标，离相机远近不影响粗细；`outlineWidthFactor` 是**屏幕高度比例**。

来源：[MToon 规范 Outline Width](https://github.com/vrm-c/vrm-specification/blob/master/specification/VRMC_materials_mtoon-1.0/README.md#outline-width)；VRM 文档（Width Mode 说明 + Transparent 描边不正确）：[vrm.dev MToon](https://vrm.dev/en/univrm/shaders/shader_mtoon/)。

three-vrm 的实现细节：

```glsl
// mtoon.vert
float worldNormalLength = length(transformedNormal);
vec3 outlineOffset = outlineWidthFactor * worldNormalLength * objectNormal;
#ifdef OUTLINE_WIDTH_SCREEN
  outlineOffset *= vViewPosition.z / projectionMatrix[1].y;
#endif
gl_Position = projectionMatrix * modelViewMatrix * vec4(outlineOffset + transformed, 1.0);
```

来源：[`mtoon.vert` L97-L109](https://github.com/pixiv/three-vrm/blob/v3.5.5/packages/three-vrm-materials-mtoon/src/shaders/mtoon.vert#L97-L109)。

- `worldCoordinates` 的实际宽度要按 shader 推导（以下为源码推导，需实拍确认），不能直接套「米 ×模型 scale」：
  - shader 里 `worldNormalLength = length(transformedNormal)`。模型均匀缩放 S 时，view-space 法线长度约为 `1/S`；`outlineOffset` 在 object space 是 `factor/S`，再经 modelView 乘 S，最终 view-space 偏移约为 `factor`。也就是说 **factor 实际是场景世界单位**，不会随模型 scale 放大。
  - 如果场景世界单位是**米**（模型 scale=1）：`factor = 期望像素 / pxPerMeter`。例：312 px/m、2 px → `factor≈0.0064`（米）。
  - 如果场景世界单位是**CSS px**（模型 scale≈312）：`factor` 直接就是 CSS px，2 px → `factor=2`；写成 0.0064 会得到 0.0064 px，几乎不可见。
  - 如果模型在固定场景里改 scale，描边宽度会保持「场景世界单位」不变，不会跟着模型相对变粗/变细；官方 issue #1199 明确说这是 spec 未定义行为，应用需按需求自己调 `outlineWidthFactor`：[pixiv/three-vrm#1199](https://github.com/pixiv/three-vrm/issues/1199)。
- 本模型 39 个材质全是 `none`。如果 V6 一定要描边，推荐在**加载前 patch GLB JSON**：
  ```jsonc
  "VRMC_materials_mtoon": {
    "outlineWidthMode": "worldCoordinates",
    // 场景单位=米时：2px / 312 px每米 ≈ 0.0064；场景单位=CSS px 时：直接写 2
    "outlineWidthFactor": 0.0064
  }
  ```
  让 `MToonMaterialLoaderPlugin` 生成 outline 子材质（`isOutline=true`、`side=BackSide`、geometry 加两组 draw group）。不要在运行时直接 new 一个 `MToonMaterial` 克隆，否则 geometry 没分组、也不会被 loader 的 material set 管理。
- 6 个 BLEND 材质的描边按官方文档「不能正确绘制」；如果 patch 后衣服边缘出现黑边/破面，按材质把 BLEND 的 outline 关掉（单独设 `none`），只给 OPAQUE/MASK 开。
- 备选：不用 MToon outline，用屏幕空间 OutlineEffect（项目 legacy PMX 有 `outline-effect-screen.ts`）。但设计文档已决定不做屏幕空间描边，且它对透明背景的 alpha 边缘更敏感；V1 建议不做描边。

### 2.4 表情、口型、眨眼与注视

#### 2.4.1 VRM 1.0 preset 与 override

18 个 preset（全部可选）：

```text
happy angry sad relaxed surprised
aa ih ou ee oh
blink blinkLeft blinkRight
lookUp lookDown lookLeft lookRight
neutral
```

- `neutral` 在规范里是「left for backwards compatibility」，不是「不存在」；本模型没有定义 neutral，所以业务 neutral 仍应实现为「所有 expression 清零」。
- 本模型：17 preset（无 neutral）+ 78 custom = 95；`happy`/`relaxed` 有 `overrideBlink: "blend"`，其余 preset 和 custom 没有 override；无 `overrideMouth`。
- override 算法：manager 每帧先算 `multiplier = max(0, 1 - Σ overrideAmount)`，再对 blink/lookAt/mouth 三类 expression 乘 multiplier；`block` 是 0/1，`blend` 按权重线性衰减。源码：[`VRMExpressionManager.ts` L214-L260](https://github.com/pixiv/three-vrm/blob/v3.5.5/packages/three-vrm-core/src/expressions/VRMExpressionManager.ts#L214-L260)；规范：[expressions.md](https://github.com/vrm-c/vrm-specification/blob/master/specification/VRMC_vrm-1.0/expressions.md)。
- 因此 `happy=1` 时 `blink` 会被压到 0 附近；这是模型作者的设计，不要绕过 manager 直接写 morph 去「强行眨眼」。如果策划要求「笑着也能眨」，要么降低 happy 权重，要么改用 custom 的眨眼通道（本模型 78 custom 里可能有），要么接受闭眼笑。
- `setValue` 对未知名字静默无效，返回 void；先 `getExpression(name) != null` 或 `expressionMap` 做能力探测。`setValue` 内部 `saturate(weight)`，不会抛错。源码：[L164-L171](https://github.com/pixiv/three-vrm/blob/v3.5.5/packages/three-vrm-core/src/expressions/VRMExpressionManager.ts#L164-L171)。

#### 2.4.2 应用时机

```ts
// 每帧：只设置目标权重
for (const [name, w] of Object.entries(targets)) {
  vrm.expressionManager?.setValue(name, w)
}

// 然后让 vrm.update 内部的 expressionManager.update() 真正写 morph
vrm.update(dt)
```

- `setValue` 只改 `VRMExpression.weight`；`expressionManager.update()` 才 `clearAppliedWeight()` + `applyWeight()` 到 morph/material/UV。见 [L214-L245](https://github.com/pixiv/three-vrm/blob/v3.5.5/packages/three-vrm-core/src/expressions/VRMExpressionManager.ts#L214-L245)。
- 所以 `setValue` 必须在 `vrm.update` **之前**；不要在 `vrm.update` 后再 `expressionManager.update()` 一次（会重复 clear/apply，虽不致命但浪费，且容易和下一帧的 setValue 顺序打架）。
- 如果因为性能/固定步长手动调了 `humanoid.update` / `expressionManager.update`，就不要再调 `vrm.update` 的同一部分；要么全手动，要么全交给 `vrm.update`。

#### 2.4.3 眨眼

推荐参数（可按观感调）：

- 间隔：2–5 s 随机；不要固定 4 s。
- 闭合 0.06–0.10 s，保持 0.02–0.05 s，张开 0.10–0.16 s；用 smoothstep 或 ease-in-out。
- 双眨：10–20% 概率在张开后 0.15–0.25 s 再眨一次。
- 睡眠：`blink` 0.9–1.0 常闭；不要和 `sleep` 表情的闭眼 custom 叠加（会双重压眼睑）。
- 单眼眨：本模型有 `blinkLeft/Right`，但随机单眼会像 bug；只在明确的 wink 动作/表情里用。
- `happy/relaxed` 的 overrideBlink 会自动压眨眼；如果策划要「笑眼+眨眼」，先把 happy 降到 ≤0.5 或改用 custom。

代码形态：

```ts
const blink = blinkScheduler.sample(dt) // 0..1
vrm.expressionManager?.setValue('blink', blink)
// 如果模型没有 blink，但有 blinkLeft/Right：
// setValue('blinkLeft', blink); setValue('blinkRight', blink)
```

不要直接写 `mesh.morphTargetInfluences[blinkIndex] = w`：会绕过 override、和表情 clip/口型抢同一批 morph，且模型换名就失效。

#### 2.4.4 口型

- VRM 1.0 的 5 个 viseme：`aa / ih / ou / ee / oh`；本模型都有，且无 `overrideMouth`，可以安全驱动。
- 每帧写 5 个权重，建议「一个主 viseme + 相邻两个小权重」而不是五个都 0.5；总和不必等于 1（morph 是加算），但不要让嘴部形变叠加到破面。
- 文本 → viseme 的时序用音频包络或音素时长；项目已有 `viseme.ts`/`expression-layer`，运行时只负责把最终权重 `setValue`。
- 如果当前播放的 expression clip 也带嘴部轨道（本模型表情 clip 只有 preset，可能带 aa/oh），需要「一个通道一个 writer」：clip 的嘴部轨道与 TTS 口型二选一，或做权重上限（`max` 而不是相加）。

#### 2.4.5 注视：有 VRM lookAt 时优先用，没才程序化

**目标模型（有 bone 型 lookAt）**：

```ts
// 每帧：把 pointer 投到模型所在平面，得到 world target
const target = pointerWorldOnZ0 // THREE.Vector3
vrm.lookAt?.lookAt(target)       // 立即算 yaw/pitch，下一次 vrm.update 应用
// 或：vrm.lookAt.target = targetObject; // autoUpdate=true 时 vrm.update 内部自动 lookAt
vrm.update(dt)
```

- `VRMLookAt.update(delta)` 在 `vrm.update` 内部被调用，顺序在 `humanoid.update()` 之后；所以它看到的是本帧头部姿态（前提是矩阵已更新，见 2.2.2）。
- `lookAt(target)` 用 `restHeadWorld * inv(currentHeadWorld)` 把目标方向转到 head-rest 空间，再算 yaw/pitch；`VRMLookAtBoneApplier.applyYawPitch` 写 raw 和 normalized 的 eye 骨。源码：[`VRMLookAt.ts` L253-L289](https://github.com/pixiv/three-vrm/blob/v3.5.5/packages/three-vrm-core/src/lookAt/VRMLookAt.ts#L253-L289)、[`VRMLookAtBoneApplier.ts` L127-L190](https://github.com/pixiv/three-vrm/blob/v3.5.5/packages/three-vrm-core/src/lookAt/VRMLookAtBoneApplier.ts#L127-L190)。
- 本模型的 lookAt outputScale 只有约 9.62°（水平）/ 6.73°（下）/4.81°（上）；眼球活动范围很小，**必须配合头部 additive**，否则看起来「头不动、眼神死」。
- 如果 `vrm.lookAt` 存在，不要再手动写 `leftEye/rightEye` 的 normalized quaternion；两套 writer 会互相覆盖，且 `VRMCore.update` 里 lookAt 在 humanoid.update 之后，最终赢的是 lookAt。

**没有 lookAt 扩展时（或要更强的程序化控制）**：

1. 优先检查 `humanoid.getNormalizedBoneNode('leftEye'/'rightEye')` 是否存在；有则可用 `VRMLookAtBoneApplier`：
   ```ts
   import { VRMLookAt, VRMLookAtBoneApplier, VRMLookAtRangeMap } from '@pixiv/three-vrm'
   const applier = new VRMLookAtBoneApplier(
     vrm.humanoid,
     new VRMLookAtRangeMap(90, 10), // inner
     new VRMLookAtRangeMap(90, 10), // outer
     new VRMLookAtRangeMap(90, 6),  // down
     new VRMLookAtRangeMap(90, 5),  // up
   )
   const lookAt = new VRMLookAt(vrm.humanoid, applier)
   // 每帧：在 humanoid.update() 之后调用；它会写 raw + normalized eye
   lookAt.lookAt(target)
   lookAt.update(0)
   ```
   `VRMLookAtBoneApplier` 构造时缓存 raw eye 的 rest quaternion 和 parent world quaternion，必须在模型 rest pose、且**尚未施加 stage 位移/旋转/缩放**时构造；之后每帧 `lookAt.lookAt(target); lookAt.update(0)`。它不是 `VRMLookAtProceduralApplier`——three-vrm 没有这个类名。若模型自带 `vrm.lookAt`，不要重复构造/写入，交给 `vrm.update`。
2. 没有 eye 骨 / 不想用 applier：只做头部 additive，眼球保持 clip 的默认；对桌宠通常够用。

**头部 additive（有/无 lookAt 都要）**：

```ts
// head 是 normalized head；clip 已经写过 head.quaternion
// 1) 在 head 的局部空间里构造 yaw/pitch 旋转
const yawQ = new THREE.Quaternion().setFromAxisAngle(yawAxis, yawRad)
const pitchQ = new THREE.Quaternion().setFromAxisAngle(pitchAxis, pitchRad)

// 2) post-multiply：clip pose * gaze delta
head.quaternion.multiply(yawQ).multiply(pitchQ)

// 3) 限制「clip 自身转头 + gaze」的总量，避免脖子反关节
// 社区做法：HEAD_LAYER_LIMIT=70°，budget = max(0, 70° - clipTurn)
```

- 轴不要假设一定是 local X/Y。VRM 的 head rest 朝向可能带旋转；社区项目在加载时从 stage/head world quaternion 反算 yaw/pitch 轴并缓存，值得复用：[`scene.js` `gazeAxesFor`](https://github.com/drliuhuan/dsh-plugin-vrmpet3d/blob/main/lib/scene.js)。
- 参考限值：yaw ±30–40°、pitch 上 20°/下 15°（桌宠不需要真人 80°）；如果和 clip 叠加，总转头 ≤60–70°。社区项目用 80° yaw / 60° pitch / 70° 总预算，是偏大的值，可作上限参考。
- 混合用指数平滑：`alpha = 1 - exp(-dt / tau)`，tau 0.15–0.3 s；不要每帧直接 snap 到目标。
- 头部 additive 写的是 normalized head，必须在 `humanoid.update()` / `vrm.update` 之前；`vrm.update` 会把它拷到 raw，lookAt 再在 raw 眼睛上叠加。
- 如果使用 `vrm.lookAt.target` + 头部 additive：head 先转一部分，lookAt 用当前 head 姿态算剩余角度，眼睛自然补偿；这是最推荐的分层。

#### 2.4.6 眨眼/表情/注视的冲突清单

| 冲突 | 处理 |
|---|---|
| `happy`/`relaxed` 的 `overrideBlink=blend` 压眨眼 | 接受；或降 happy；或改 custom 眨眼通道。不要绕过 manager。 |
| 表情 clip 带 blink 轨道 + 程序化 blink | 一个通道一个 writer：clip 有 blink 轨道时，程序化 blink 让位（或只保留较低权重）。 |
| 表情 clip 带嘴部轨道 + TTS 口型 | 口型优先时过滤 clip 的 aa/ih/ou/ee/oh 轨道；否则做 `max`/加权。 |
| lookAt 是 expression 型，同时手动写 look* | 只让 `vrm.lookAt` 写 look*；不要手动 `setValue('lookLeft', ...)`。 |
| 有 bone lookAt，同时手动写 eye 骨 | 只留一个 writer；优先 `vrm.lookAt`。 |
| 头部 additive 与 clip 转头叠加过大 | 用「总转头预算」限制，或按 clip 是否含 head 轨道决定是否降低 gaze 权重。 |
| 眨眼与睡眠闭眼 custom 叠加 | 睡眠时程序化 blink 降到 0.9 以下，或直接让 custom 接管。 |

### 2.5 VRMA / glTF animation 与自定义 JSON 的取舍

#### 2.5.1 VRMA 规范要点

- VRMA 是 glTF 2.0 + `VRMC_vrm_animation` 扩展；一个文件可以有多段 animation，一般取第一段。
- humanoid 骨：rotation 轨道；**只允许 hips 有 translation**，其他骨的 translation 被规范禁止（three-vrm 会 warn 并忽略）。
- 表情：节点 translation.x 当作 weight（0..1，越界 clamp）；`lookUp/Down/Left/Right` 不能出现在 VRMA 表情轨道里，由 lookAt 处理。
- lookAt：节点 rotation 转成 yaw/pitch；rest 是 VRM T-pose；30fps 是规范建议的采样率。
- glTF 线性距离单位是米；VRMA 的 hips translation 也是米（相对 T-pose rest）。

来源：[VRMA 规范](https://github.com/vrm-c/vrm-specification/blob/master/specification/VRMC_vrm_animation-1.0/README.md)；glTF 单位：[glTF 2.0 spec](https://registry.khronos.org/glTF/specs/2.0/glTF-2.0.html#coordinate-system-and-units)。

#### 2.5.2 three-vrm 的 VRMA 用法

```ts
import { VRMAnimationLoaderPlugin, createVRMAnimationClip } from '@pixiv/three-vrm-animation'

loader.register((parser) => new VRMAnimationLoaderPlugin(parser))

const gltfVrma = await loader.loadAsync(vrmaUrl)
const vrmAnimation = gltfVrma.userData.vrmAnimations[0]
const clip = createVRMAnimationClip(vrmAnimation, vrm)

const mixer = new THREE.AnimationMixer(vrm.scene)
mixer.clipAction(clip).play()

// 每帧
mixer.update(dt)
vrm.update(dt)
renderer.render(scene, camera)
```

- 官方示例：[`loader-plugin.html` L111-L136](https://github.com/pixiv/three-vrm/blob/v3.5.5/packages/three-vrm-animation/examples/loader-plugin.html#L111-L136)。
- `createVRMAnimationClip` 把 rotation 轨道 target 设为 `humanoid.getNormalizedBoneNode(name).name + '.quaternion'`，所以 mixer 写在 normalized 骨上；hips translation 也是 normalized hips 的 `.position`。源码：[`createVRMAnimationClip.ts` L12-L45](https://github.com/pixiv/three-vrm/blob/v3.5.5/packages/three-vrm-animation/src/createVRMAnimationClip.ts#L12-L45)。
- hips translation 缩放：`scale = humanoid.normalizedRestPose.hips.position[1] / vrmAnimation.restHipsPosition.y`；VRM0 还会对 x/z 取反。和我们 `avatar.hipsRestHeight / clip.sourceHipsHeight` 完全同口径，可直接借鉴。
- 如果模型有 `vrm.lookAt` 且 VRMA 带 lookAt 轨道，需要 `VRMLookAtQuaternionProxy`；没有 lookAt 的模型不要创建（`new VRMLookAtQuaternionProxy(null)` 会出错）。官方示例只对 `vrm.lookAt` 非空的模型创建。
- 如果 VRMA 带表情轨道，`createVRMAnimationClip` 会生成 expression track；它会和程序化 blink/口型抢同一批 expression，必须过滤或分层。

#### 2.5.3 取舍表

| 维度 | 自定义 JSON（现状） | VRMA |
|---|---|---|
| 数据来源 | Unity Humanoid 采样 → 52 骨逐帧 quaternion + Hips p | 需要把 JSON 包成 glTF + `VRMC_vrm_animation` |
| 运行时 | 自己采样/插值/交叉淡入；直接写 normalized | `AnimationMixer` + `createVRMAnimationClip`；mixer 写 normalized |
| 骨骼范围 | 52 个 humanoid 骨；可带自定义元数据 | 只能 humanoid 骨；非 humanoid 轨道不能用 |
| Hips 位移 | 每 clip `sourceHipsHeight` + `grounding` 元数据 | 只有 hips translation；按 rest hips 比例缩放；无 grounding 字段 |
| 表情/lookAt | 现有 expression clip 独立层 | VRMA 可带 expression/lookAt 轨道，但会与程序化层冲突 |
| 交叉淡入 | 自己做 short-arc slerp + Hips lerp，完全可控 | `AnimationMixer` 内置 crossFade；但和自定义层混用时要小心 |
| 工具/交换 | 私有 JSON，外部工具不认 | 标准，Blender/VRMA 工具链可预览、可交换 |
| 体积/解析 | 43 个 clip 约几 MB，解析简单 | 每个 clip 一个 GLB，体积更大；要处理 glTF 解析 |
| 适用 | **V1 主路径**、私有资产、需要每 clip 贴地/rawPolicy | 外部动作导入、跨应用交换、未来编辑器 |

**建议**：V1 继续用自定义 JSON 作为唯一运行时 pose 源；把「导出 VRMA」作为离线工具/未来能力，不要现在把 43 个 clip 全转成 VRMA。若将来要导入外部 VRMA（舞蹈/打招呼），让它走独立的 `VrmaPoseSource`，与 JSON clip player 做「当前只有一个 writer」的仲裁，避免 mixer 和手动写骨同时改同一根骨。

#### 2.5.4 Hips 位移、单位与坐标

- 我们的 clip `p` 是「米、已减首帧基准、in-place」；播放时：
  ```ts
  const scale = avatar.hipsRestHeight / clip.sourceHipsHeight
  const rest = avatar.normalizedHipsRestPosition // 从 normalizedRestPose.hips.position 取
  hips.position.set(
    rest.x + clip.hips[i].x * scale,
    rest.y + clip.hips[i].y * scale,
    rest.z + clip.hips[i].z * scale,
  )
  ```
  注意这是**绝对** normalized hips 位置；不要 `hips.position.add(...)` 累加。`scale` 用 hips 高度比，不要用总身高比；three-vrm 的 VRMA 实现也是这个口径。
- 如果世界单位是 CSS px（模型 scale≈312），上面的米制 offset 会在 `humanoid.update` 里经 world matrix 变成 px；不要在写 normalized 时再乘一次 312。
- 如果世界单位是米（推荐给 SpringBone），上面的 offset 直接是米；摆放/命中在边界把 CSS px 除以 `pxPerMeter`。
- `sourceHeight` 只用于 UI/比例参考；Hips 位移用 `sourceHipsHeight`。
- 目标模型面向 +Z；如果将来接 VRM0（面向 -Z），`rotateVRM0` 只转 scene，动画数据仍要按 VRM0 约定处理（three-vrm-animation 会翻 quaternion 分量）。

#### 2.5.5 贴地（feet grounding）

现状/设计：`grounding:'feet'` 的 clip 由数据烘焙贴地；播放侧取「每 clip 常量残差（首帧最低脚骨世界 y）」作为竖直补偿，避免每帧硬钳导致走路脚粘地。这个方向是对的，补充：

- **不要每帧把 root 钳到最低脚**：走路时最低脚在左右脚之间切换，每帧钳会让整个身体上下抖；跑步/跳跃更糟。
- **每 clip 常量 offset** 的计算：
  ```ts
  humanoid.update()
  scene.updateMatrixWorld(true)
  const footY = Math.min(...['leftFoot', 'rightFoot', 'leftToes', 'rightToes']
    .map((n) => humanoid.getRawBoneNode(n))
    .filter(Boolean)
    .map((b) => b.getWorldPosition(new THREE.Vector3()).y))
  const offset = targetGroundY - footY
  ```
  离线对 clip 的每一帧采样，取 `min` 或首帧值；存进 clip 元数据，播放时只加一次。切换 clip 时对 offset 做 0.1–0.2s 插值，避免跳变。
- **脚骨 ≠ 鞋底**：`leftFoot` 是踝关节，鞋底/脚尖还有厚度；用 `leftToes` 或离线测一次「rest pose 下脚骨到 mesh 最低点」的常量，再加到 offset。不要用 `Box3.setFromObject` 每帧算 skinned mesh（它默认用 rest bounding box，不会跟着骨骼）。
- **每帧 IK**：three-vrm 没有内置 IK；要做两骨 IK + hips 下沉，工作量和膝盖翻转风险都高。桌宠尺寸小、动作幅度有限，V1 不建议；如果走路脚滑明显，先在数据侧修（重烘焙 foot contact），再考虑运行时 IK。
- 社区项目用「静态 bbox min.y 对齐地面」：[`core.js` `computeFraming`](https://github.com/drliuhuan/dsh-plugin-vrmpet3d/blob/main/lib/core.js)。这只能保证 rest pose，动画 clip 仍要用每 clip 残差；可作为「没有 clip 元数据时的 fallback」。
- 如果模型 scale 改变，offset 也要按 scale 重算/缩放；用世界 px 记录 offset 时，scale 变化后 px 不变但米制 pose 变了，必须重算。

### 2.6 透明窗口 + WebGL 的坑

#### 2.6.1 Electron 窗口

本仓库 `overlay-manager.ts` 已经是正确方向：`transparent:true`、`frame:false`、`hasShadow:false`、`backgroundColor:'#00000000'`、`focusable:false`、`backgroundThrottling:false`。对照 Electron 文档：

- `transparent` 在 Windows 必须 frameless；macOS 用 `frame:false` + `transparent:true`。
- `backgroundColor` 支持 `#AARRGGBB`（`transparent:true` 时）；默认是 `#FFF`，不设透明会白底。
- `hasShadow:false` 避免透明窗口投下矩形阴影；macOS 透明窗口有时会留下 artifacts，Electron 提供 `win.invalidateShadow()` 清理（动画/形状变化后）。
- 参考：[BaseWindow API](https://www.electronjs.org/docs/latest/api/base-window)、[Custom Window Styles](https://www.electronjs.org/docs/latest/tutorial/custom-window-styles)。

CSS 侧：

```css
html, body, #app { background: transparent; margin: 0; }
canvas { display: block; background: transparent; }
```

不要给 body/canvas 设 `background:#000` 或 `background:#fff`；否则窗口透明但页面自己画了底色。

#### 2.6.2 WebGLRenderer 配置

```ts
const renderer = new THREE.WebGLRenderer({
  canvas,
  alpha: true,                 // 默认 clear alpha = 0
  premultipliedAlpha: true,    // 默认 true；与浏览器合成器一致
  antialias: true,             // 透明边缘更平滑；有性能成本，可 A/B
  preserveDrawingBuffer: false // 只有 readPixels/toDataURL 时才 true
})
renderer.setClearColor(0x000000, 0)
renderer.setClearAlpha(0)
renderer.outputColorSpace = THREE.SRGBColorSpace
renderer.toneMapping = THREE.NoToneMapping
```

- 三个参数的默认值/语义：[WebGLRenderer 文档 L39-L60](https://github.com/mrdoob/three.js/blob/r171/docs/api/en/renderers/WebGLRenderer.html#L39-L60)。
- `alpha:true` 时默认 clear alpha 是 0；`setClearColor(0x000000, 0)` 再显式清零，避免上一个模型/场景的残留。
- 不要在透明 canvas 上开 `renderer.autoClear = false` 除非你明确自己清屏；否则上一帧会残留。
- 如果场景有 `scene.background = new THREE.Color(...)`，它会覆盖 clear alpha，导致不透明；透明背景必须 `scene.background = null`。

#### 2.6.3 预乘 alpha、黑边/白边

浏览器合成器**假定 drawing buffer 是预乘 alpha**：

> "premultipliedAlpha: A boolean value that indicates that the page compositor will assume the drawing buffer contains colors with pre-multiplied alpha."

来源：[MDN getContext](https://developer.mozilla.org/en-US/docs/Web/API/HTMLCanvasElement/getContext)；更通俗的解释：[WebGL and Alpha](https://webglfundamentals.org/webgl/lessons/webgl-and-alpha.html)。

- 保持 `premultipliedAlpha:true`（three.js 默认）。如果设 false，合成器会把已经预乘的颜色再当直通 alpha 处理，边缘容易出现亮/暗圈。
- three.js 的标准 alpha blending 在「清成 (0,0,0,0) 的 buffer」上得到的结果本身就是预乘的：`RGB_out = RGB_src * A_src`，`A_out = A_src`；这与 `premultipliedAlpha:true` 的合成假设一致。不要手动在 shader 里再乘一次 alpha，除非你把 `material.premultipliedAlpha` 和 blending 也一起改对。
- MToon 的 `postCorrection()` 包含 `<premultiplied_alpha_fragment>`；是否乘 alpha 取决于 material 的 `premultipliedAlpha` 标志。three-vrm loader 默认 `premultipliedAlpha=false`，走标准 blend；不要随便改。
- **黑边/白边常见来源**（按概率）：
  1. 贴图 alpha=0 的像素 RGB 是黑色，线性过滤把黑色带到边缘 → 深色描边/黑边。MASK 材质用 alphaTest 裁掉，问题小；BLEND 材质会明显。离线做 texture bleed（把边缘颜色扩散到透明像素）或用 premultiplied texture 可解。社区项目实测 VRoid 衣服贴图 77% 是 alpha=0 + RGB 黑，透明部分变黑就是这类问题：[`desktop-page.js` `materials()` 注释](https://github.com/drliuhuan/dsh-plugin-vrmpet3d/blob/main/lib/desktop-page.js)。
  2. `vrm.update` 没调用 → `alphaTest` 没更新 → alpha=0 的纹素被画成不透明黑（见 2.3.3 #1）。
  3. 透明材质 `depthWrite=true` / renderOrder 不对 → 前后层互相遮挡，边缘出现黑块。three-vrm 对 MToon BLEND 会按 `transparentWithZWrite` 设 renderOrder 19，不要全局覆盖。
  4. 描边 pass 在透明材质上绘制 → 官方文档明确「Transparent 材质描边不正确」；本模型当前无描边，先排除。
  5. 页面/CSS 有白底或黑底；或 `backgroundColor` 不是 `#00000000`。
  6. `antialias:true` 的 MSAA 边缘与预乘 alpha 的交互；如果看到 1px 白边，先试 `antialias:false` 对照，确认是 MSAA 还是贴图（未证实，需实机）。
- 诊断方法：把 canvas 临时叠在**中灰**背景上（或把 renderer 清屏改成灰色 alpha=1）截图；「透明」和「黑」在中灰上能区分。社区项目就是这么做的：[`desktop-page.js` `snapshot()`](https://github.com/drliuhuan/dsh-plugin-vrmpet3d/blob/main/lib/desktop-page.js)。

#### 2.6.4 preserveDrawingBuffer 与证据抓帧

- `preserveDrawingBuffer:false` 是默认，性能最好；浏览器可以在合成后清空 drawing buffer。需要 `canvas.toDataURL()`、`gl.readPixels()` 跨帧读取、或「鼠标命中测试读像素」时才设 true。代价是每帧一次 buffer 拷贝。
- 社区项目在独立悬浮窗里设 `preserveDrawingBuffer:true`，因为它的 hit-test 在**帧与帧之间**读 framebuffer；不开的话第二次读会得到「全透明」，导致所有点击穿透。参考：[`desktop-page.js` L428-L436](https://github.com/drliuhuan/dsh-plugin-vrmpet3d/blob/main/lib/desktop-page.js)。
- 我们的命中测试如果走几何/矩形（现有 PMX 路线），不需要读像素 → 生产设 false；只有 smoke/证据截图需要时，通过 env 切换 true，或改用 `webContents.capturePage()`。
- **`capturePage()` 对透明置顶窗口可能返回全透明/空图**：社区项目实测 353,430 像素全透明，而 canvas 里有 58,938 个已绘制像素；它最终改用页面内 `gl.readPixels()` 做视觉证据。参考：[`desktop/main.js` `finishSelfTest` 注释](https://github.com/drliuhuan/dsh-plugin-vrmpet3d/blob/main/desktop/main.js)。我们的 smoke 如果只断言 `opaquePixels>0`，要准备好 fallback，否则会得到「窗口透明但截图全透明」的假失败/假通过。
- `capturePage` 走窗口合成，`readPixels` 走 renderer 自己的 buffer；两者不一致时，先判断是合成问题还是渲染问题。

#### 2.6.5 devicePixelRatio 与 CSS px 正交相机

```ts
const cssW = viewport.width
const cssH = viewport.height
const dpr = Math.min(window.devicePixelRatio || 1, 2) // 或按像素预算
renderer.setPixelRatio(dpr)
renderer.setSize(cssW, cssH, false) // 不修改 canvas 的 CSS 样式

camera.left = 0
camera.right = cssW
camera.top = cssH
camera.bottom = 0
camera.near = 0.1
camera.far = 2000
camera.position.set(cssW / 2, cssH / 2, 1000)
camera.lookAt(cssW / 2, cssH / 2, 0)
camera.updateProjectionMatrix()
```

- `setSize(w,h,false)` 会按 DPR 设置 drawing buffer，并把 viewport 设为该尺寸；`false` 表示不改 canvas 的行内 CSS 宽高。文档：[L639-L646](https://github.com/mrdoob/three.js/blob/r171/docs/api/en/renderers/WebGLRenderer.html#L639-L646)。
- 相机 frustum 用 **CSS px**，不要用 `canvas.width`（那是 CSS×DPR）；否则模型会缩小/放大 DPR 倍。
- 指针坐标也用 CSS px：`x = clientX - rect.left`，`y = rect.height - (clientY - rect.top)`（如果相机 bottom=0/top=H）。不要乘 DPR。
- 如果采用米制场景：`camera.left=0; right=cssW/pxPerMeter; top=cssH/pxPerMeter; bottom=0`，相机位置也除以 `pxPerMeter`；指针世界坐标 = CSS px / `pxPerMeter`。所有布局/命中在边界换算。
- `devicePixelRatio` 会在窗口移动到不同 DPI 屏幕时变化；overlay 每屏一个窗口，监听 resize/display change，重新 `setPixelRatio` + `setSize` + `camera.updateProjectionMatrix()`。
- 像素预算：`dpr = min(devicePixelRatio, sqrt(budget / (cssW*cssH)))`，下限 1；项目已有 `computePixelRatio`，VRM 场景复用即可。

#### 2.6.6 renderer 单例与资源生命周期

- 每个 overlay 窗口一个 `WebGLRenderer`；`VrmPetScene` 构造时创建，窗口关闭时 `renderer.dispose()` + `forceContextLoss()`，并取消 rAF。不要在每个模型加载时 new 一个 renderer（WebGL 上下文创建/丢失成本高，且旧 canvas 可能还挂在 DOM）。
- 模型切换：`scene.remove(oldVrm.scene)` → `deepDispose(oldVrm.scene)` → 清 mixer → 加载新模型 → `scene.add(newVrm.scene)`；renderer、camera、lights 不变。
- 多显示器：每个 overlay 窗口各一个 context；Chromium 的 WebGL context 数量有限，桌宠一般 1–2 个窗口，没问题；不要在同一窗口叠多个 canvas。
- 如果实现「渲染到纹理/后处理」，注意 render target 的 alpha：`WebGLRenderTarget` 默认 alpha，但清屏色和 material alpha 要单独处理；本项目 V1 不做后处理，避免这条链。

---

## 三、与本项目对接建议

### 3.1 模块分工

| 模块 | 该做什么 | 关键顺序/参数 |
|---|---|---|
| `vrm/avatar-loader.ts` | fetch + patch + `parseAsync`；`rotateVRM0`；能力探测（humanoid/expression/spring/lookAt）；优化 A/B；rest bbox/hips 高；贴图追踪；`dispose()` | 解析后先 `rotateVRM0` 再算 bbox；`normalizedRestPose.hips.position[1]` 存为 `hipsRestHeight`；记录 `lookAt` 是否存在及 `applier.type`；记录 39 材质 outline 状态 |
| `vrm/pet-scene-vrm.ts` | renderer/camera/正交/透明/光照/DPR/像素预算；世界单位选择（CSS px 或米） | 推荐**米制场景 + 米制正交 frustum**（SpringBone scale=1）；如果坚持 CSS px，必须缩放 spring 参数。`NoToneMapping` + `SRGBColorSpace` + `setClearColor(0,0)` |
| `vrm/clip-data.ts` | 解析 JSON、30fps 采样、四元数 slerp、Hips lerp、loop 回绕 | 每帧从 rest 重算 Hips 绝对位置；不要累加 |
| `vrm/clip-player.ts` | mood→clip、交叉淡入、写 normalized、每 clip 贴地残差、`humanoid.update()` 测脚 | 写骨后 `humanoid.update()` + `scene.updateMatrixWorld(true)`；不要写 raw；clip 切换时 offset 也插值 |
| `vrm/expression-layer.ts` | 表情 clip 层 + 眨眼 + 口型；最终权重 `setValue` | 每通道一个 writer；`happy/relaxed` overrideBlink 要接受；clip 有 blink/嘴轨时程序化层让位 |
| `vrm/look-at.ts` | 有 `vrm.lookAt` 时设 target/yaw/pitch；无时程序化 eye/head；头部 additive | 头部限幅 + 总转头预算；先写 head additive，再 `humanoid.update()` + `scene.updateMatrixWorld(true)`，再设 lookAt；不要在 bone lookAt 上再手动写 eye |
| `vrm/animator.ts` | 组合以上；固定帧序；`vrm.update(clampedDt)`；render 前完成所有写 | 见 3.2；`vrm.update` 只调一次 |
| smoke/证据 | `readPixels` fallback；透明像素/不透明像素统计；材质 alphaTest 断言 | `capturePage` 可能全透明；记录 `material.alphaTest` vs uniform、`outlinePx=0`、`lookAt` 类型 |

### 3.2 建议固定下来的帧序

```ts
// 每帧（dt 已按 fps cap 后的真实秒数，clamp 到 [0, 0.1]）
const dt = clamp(rawDt, 0, 0.1)

// 1) 位置/朝向（stage 的位移、拖拽惯性、facing）——必须在 spring 之前
stage.position.copy(placement.positionPxToScene(...))
stage.rotation.y = facingYaw

// 2) clip 采样 + 写 normalized
clipPlayer.update(dt) // quaternion + hips absolute position

// 3) 表情目标（不 update）
expressionLayer.update(dt) // setValue(blink/viseme/emotion)

// 4) 头部 additive（写 normalized head）——必须在同步 raw 之前
lookAt.applyHeadAdditive(dt)

// 5) 同步 raw + 世界矩阵（测脚 / lookAt 需要）
vrm.humanoid.update()
vrm.scene.updateMatrixWorld(true)

// 6) 每 clip 常量贴地；如果改 stage/root，再更新一次世界矩阵
clipPlayer.applyGroundingOffset()
// 若 grounding 改了 root：vrm.scene.updateMatrixWorld(true)

// 7) 眼球 lookAt 参数（用本帧 head world 计算）
lookAt.updateEyes(dt) // 设置 vrm.lookAt.target/yaw/pitch，或手动 applier

// 8) 一次性更新所有 VRM 组件
vrm.update(dt) // humanoid→lookAt→expressions→constraints→spring→materials

// 9) 渲染
renderer.render(scene, camera)
```

- 如果 `clipPlayer.update` 内部已经调了 `humanoid.update()`（为了测脚），第 5 步再调一次没问题；关键是**先写完 normalized（含 head additive），再 humanoid.update + updateMatrixWorld，再设置 lookAt 参数**。
- 如果使用 `vrm.lookAt.target`，第 7 步设置 target 后，`vrm.update` 内部会调用 `lookAt.update(delta)`；它会用第 5 步的世界矩阵（已包含头部 additive），所以顺序正确。
- 如果使用程序化 eye applier（没有 `vrm.lookAt`），在第 7 步 `applyYawPitch` 后，第 8 步的 `humanoid.update` 会把 normalized eye 拷到 raw；不要在第 8 步之后再写 eye。
- 如果使用固定步长 spring，把第 8 步拆成手动调用（见 2.2.4 方案 B），不要再调 `vrm.update`，否则 spring 双步。

### 3.3 参数起点

| 项 | 建议起点 | 备注 |
|---|---|---|
| Directional key | `Math.PI`（3.14），白，front-top-right | 官方示例值；可按截图 2.2–3.14 调 |
| Directional fill | 0.4–0.8，冷色 | 可关；不要和 key 同方向 |
| Hemisphere | sky `0xdfeaff` / ground `0x2a3350`，0.6–1.2 | 给暗部颜色；社区用 1.6 偏亮 |
| Ambient | 0–0.4 | 与 Hemisphere 二选一，避免双重填充 |
| toneMapping | `NoToneMapping` | 保 toon 色；ACES 需另调 |
| toneMappingExposure | 1.0 | 仅 toneMapping 非 None 时有效 |
| outputColorSpace | `SRGBColorSpace` | r171 默认 |
| 阴影 | 默认关 | 要接地感用 blob/烘焙 |
| 模型方向 | +Z 面向相机 | 目标 VRM1.0；VRM0 先 rotateVRM0 |
| 世界单位 | 米制场景（推荐）或 CSS px | 米制避免 spring 缩放；CSS px 复用现有布局但要缩放 spring |
| `pxPerMeter` | 宠物高 px / 1.73 | 例：540/1.73≈312 |
| dt clamp | 0.1 s | 与现有场景一致 |
| spring | `vrm.update(dt)` 或固定 1/60 | 固定步长时不要双调 |
| gaze yaw | ±30–40° | 头部；眼球由 lookAt 补 |
| gaze pitch | 上 20° / 下 15° | 不要超过脖子舒适区 |
| gaze blend | tau 0.15–0.3 s | 或 0.3–1 s 线性 |
| blink | 2–5 s 随机，0.06–0.16 s 曲线 | 双眼为主 |
| 交叉淡入 | 0.2 s smoothstep | 与设计文档一致 |
| `preserveDrawingBuffer` | 生产 false；证据/读像素时 true | 代价是每帧拷贝 |
| DPR cap | 2 或按像素预算 | 复用现有 `computePixelRatio` |

### 3.4 验收时要特别看的点

1. `vrm.update(dt)` 每帧调用；`material.uniforms.alphaTest.value === material.alphaTest`（至少抽查 MASK/BLEND 材质）。
2. 模型朝向正确（+Z 面向相机），`rotateVRM0` 后 canary 也正确；没有 double-rotate。
3. T-pose 下手臂/手指无变形；开/关 `removeUnnecessaryVertices` + `combineSkeletons` 各截一张同角度图对比。
4. 走路 clip：脚没有明显穿地/悬浮；`footErrorPx` 在阈值内；root 没有每帧上下抖。
5. 头发/裙摆：静止时有微小摆动；快速拖拽时不被拉直/爆炸；缩放宠物大小后 spring 仍正常（若用 CSS px 场景）。
6. 眨眼：`happy`/`relaxed` 下被 override 压制是预期；不出现「闭眼后不睁开」。
7. 注视：头转 + 眼球转的组合自然；快速移动指针没有眼睛滞后一帧的明显感觉；没有反关节。
8. 透明：窗口边缘无白底/黑底；模型轮廓无黑边；把 canvas 叠在中灰上截图确认。
9. 证据抓帧：`capturePage` 为空时有 `readPixels` fallback；不要用「全透明截图」当通过。
10. 性能：39 材质/95 表情/50 spring 链下，draw calls、triangles、GPU 内存可接受；DPR cap 生效。

---

## 四、未证实 / 风险清单

| # | 风险/未证实点 | 影响 | 验证方法 |
|---|---|---|---|
| 1 | 任务说「无 lookAt」，但 tpose 资产实际有 bone lookAt | 高：决定 eye 驱动方式 | 以 loader 探测为准；加载后打印 `vrm.lookAt?.applier.constructor.name` 与 `type`；若资产会替换，必须重测 |
| 2 | SpringBone 缩放时 `gravityPower` 是否也要 ×scale | 高：头发/裙摆可能僵死或下坠异常 | 按 guide 先 scale stiffness/hitRadius/collider；再对 gravityPower 做 ×S / 不×S 两组截图对比 |
| 3 | 39 材质全 outline none；运行时启用 outline 的可行性未实测 | 中：设计文档的 outline 验收会落空 | 先接受 `outlinePx=0`；如要描边，patch GLB 后只对 OPAQUE/MASK 开，BLEND 保持 none |
| 4 | `removeUnnecessaryVertices` + `combineSkeletons` 可能让该模型变形 | 高：影响外观/蒙皮 | 四组 A/B：全开、只开 vertices、只开 skeletons、全关；同角度 T-pose/idle/走路截图 |
| 5 | `capturePage` 对透明置顶窗口可能全透明 | 中：smoke 假失败/假通过 | 同时跑 `capturePage` 和页面内 `gl.readPixels`，对比 painted 像素数 |
| 6 | `antialias:true` + 预乘 alpha 的边缘是否会有白边 | 低-中：观感 | 同场景 `antialias` true/false 各截一张，叠中灰对比 |
| 7 | `screenCoordinates` outline 的 factor 与实际像素是否差 2× | 低（当前不用描边） | 如果启用，画 1px 竖线/圆环，按公式 `px ≈ factor*H/2` 标定 |
| 8 | three 0.171 + three-vrm 3.5.5 的 shader 编译/行为 | 中：官方示例已用 r180 | 本机 `renderer.debug.checkShaderErrors=true` 跑一次；看 console 有无 shader 警告；对比 r171 与示例截图 |
| 9 | 项目文档说「neutral 不是 preset」 | 低：契约注释可能误导 | 规范里 neutral 是 preset（向后兼容）；本模型没有 neutral，业务 neutral=全清 0 仍正确；改注释即可 |
| 10 | 95 表情 / 39 材质 / 50 spring 链的性能 | 中：低端 GPU 掉帧 | 在目标 Mac 上测 draw calls、triangles、GPU 内存、fps；必要时 combineMorphs / 降低 DPR |
| 11 | `preserveDrawingBuffer:true` 的每帧拷贝成本 | 低-中：笔记本功耗 | 生产 false；只有读像素/截图时开，测 fps 差异 |
| 12 | MToon 透明材质 + outline 的兼容性 | 中：如果将来开描边 | 按官方文档，BLEND 材质 outline 不正确；逐材质关闭 |
| 13 | 目标模型 `lookAt` 的 outputScale 很小（约 9.6°/6.7°/4.8°） | 中：眼球看起来不动 | 头部 additive 必须做；实拍确认「头动+眼动」比例 |
| 14 | 世界单位选 CSS px 时，MToon worldCoordinates 的 factor 实际是场景 px，不是米；写成 VRM 里的米制值会几乎不可见 | 低（当前无描边） | 如果启用，按 2.3.4 的换算：px 场景直接写 px，米场景写 px/pxPerMeter；并参考 issue #1199 |
| 15 | 社区项目 `dsh-plugin-vrmpet3d` 的测量只在其环境成立 | 中：不能当官方结论 | 只把它当线索；关键参数/行为在本仓库实机复现 |

---

## 五、参考链接总表

> 访问日期均为 2026-11-08。级别：A 官方规范/源码/示例；B 官方文档/issue/release note；C 可复核第三方源码/实测注释；D 二手/AIGC/仅标题。

### 5.1 官方（three-vrm / VRM 规范 / three.js / Electron）

| # | 标题 | URL | 级别 |
|---|---|---|---|
| 1 | three-vrm README（加载流程） | https://github.com/pixiv/three-vrm/blob/v3.5.5/packages/three-vrm/README.md | A |
| 2 | three-vrm `VRM.update`（组件更新顺序） | https://github.com/pixiv/three-vrm/blob/v3.5.5/packages/three-vrm/src/VRM.ts#L49-L67 | A |
| 3 | three-vrm `VRMCore.update`（humanoid/lookAt/expression） | https://github.com/pixiv/three-vrm/blob/v3.5.5/packages/three-vrm-core/src/VRMCore.ts#L72-L82 | A |
| 4 | `VRMHumanoid.update`（autoUpdateHumanBones） | https://github.com/pixiv/three-vrm/blob/v3.5.5/packages/three-vrm-core/src/humanoid/VRMHumanoid.ts#L294-L297 | A |
| 5 | `VRMHumanoidRig.update`（rotation 全部 / position 仅 hips） | https://github.com/pixiv/three-vrm/blob/v3.5.5/packages/three-vrm-core/src/humanoid/VRMHumanoidRig.ts#L112-L139 | A |
| 6 | normalized rig 加入 scene | https://github.com/pixiv/three-vrm/blob/v3.5.5/packages/three-vrm-core/src/humanoid/VRMHumanoidLoaderPlugin.ts#L140-L143 | A |
| 7 | `VRMExpressionManager`（setValue/update/override） | https://github.com/pixiv/three-vrm/blob/v3.5.5/packages/three-vrm-core/src/expressions/VRMExpressionManager.ts#L164-L260 | A |
| 8 | VRM 1.0 preset 列表（源码） | https://github.com/pixiv/three-vrm/blob/v3.5.5/packages/three-vrm-core/src/expressions/VRMExpressionPresetName.ts | A |
| 9 | `VRMLookAt`（lookAt/target/update） | https://github.com/pixiv/three-vrm/blob/v3.5.5/packages/three-vrm-core/src/lookAt/VRMLookAt.ts#L253-L289 | A |
| 10 | `VRMLookAtBoneApplier`（eye 骨写入） | https://github.com/pixiv/three-vrm/blob/v3.5.5/packages/three-vrm-core/src/lookAt/VRMLookAtBoneApplier.ts#L127-L190 | A |
| 11 | `VRMUtils.rotateVRM0` | https://github.com/pixiv/three-vrm/blob/v3.5.5/packages/three-vrm/src/VRMUtils/rotateVRM0.ts#L10-L13 | A |
| 12 | `VRMUtils.removeUnnecessaryVertices` | https://github.com/pixiv/three-vrm/blob/v3.5.5/packages/three-vrm/src/VRMUtils/removeUnnecessaryVertices.ts#L345 | A |
| 13 | `VRMUtils.deepDispose` | https://github.com/pixiv/three-vrm/blob/v3.5.5/packages/three-vrm/src/VRMUtils/deepDispose.ts#L29-L51 | A |
| 14 | 官方 basic 示例（π 光照、优化、frustumCulled） | https://github.com/pixiv/three-vrm/blob/v3.5.5/packages/three-vrm/examples/basic.html | A |
| 15 | 官方 VRMA 示例（mixer → vrm.update） | https://github.com/pixiv/three-vrm/blob/v3.5.5/packages/three-vrm-animation/examples/loader-plugin.html | A |
| 16 | `createVRMAnimationClip`（hips 高度缩放） | https://github.com/pixiv/three-vrm/blob/v3.5.5/packages/three-vrm-animation/src/createVRMAnimationClip.ts#L12-L45 | A |
| 17 | MToon 材质 `update`（alphaTest） | https://github.com/pixiv/three-vrm/blob/v3.5.5/packages/three-vrm-materials-mtoon/src/MToonMaterial.ts#L486-L543 | A |
| 18 | MToon fragment shader（BRDF/光照/后期） | https://github.com/pixiv/three-vrm/blob/v3.5.5/packages/three-vrm-materials-mtoon/src/shaders/mtoon.frag#L96-L303 | A |
| 19 | MToon vertex shader（描边宽度） | https://github.com/pixiv/three-vrm/blob/v3.5.5/packages/three-vrm-materials-mtoon/src/shaders/mtoon.vert#L97-L109 | A |
| 20 | SpringBone 缩放 guide | https://github.com/pixiv/three-vrm/blob/v3.5.5/guides/spring-bones-on-scaled-models.md | A |
| 21 | SpringBone 力计算（dt/gravity） | https://github.com/pixiv/three-vrm/blob/v3.5.5/packages/three-vrm-springbone/src/VRMSpringBoneJoint.ts#L230-L252 | A |
| 22 | VRM 1.0 expressions 规范（preset/override） | https://github.com/vrm-c/vrm-specification/blob/master/specification/VRMC_vrm-1.0/expressions.md | A |
| 23 | VRM 1.0 lookAt 规范（bone/expression） | https://github.com/vrm-c/vrm-specification/blob/master/specification/VRMC_vrm-1.0/lookAt.md | A |
| 24 | MToon 1.0 规范（outline 单位） | https://github.com/vrm-c/vrm-specification/blob/master/specification/VRMC_materials_mtoon-1.0/README.md#outline-width | A |
| 25 | VRMA 1.0 规范（hips/30fps/expression） | https://github.com/vrm-c/vrm-specification/blob/master/specification/VRMC_vrm_animation-1.0/README.md | A |
| 26 | VRM MToon 文档（Width Mode/Transparent 描边） | https://vrm.dev/en/univrm/shaders/shader_mtoon/ | A |
| 27 | three.js r155 光照变更（π 缩放） | https://discourse.threejs.org/t/updates-to-lighting-in-three-js-r155/53733 | A |
| 28 | three.js Migration Guide（r155/r165） | https://github.com/mrdoob/three.js/wiki/Migration-Guide | A |
| 29 | three.js r171 WebGLRenderer 文档源码（alpha/DPR/toneMapping） | https://github.com/mrdoob/three.js/blob/r171/docs/api/en/renderers/WebGLRenderer.html#L39-L60 | A |
| 30 | three.js r171 GLTFLoader `parseAsync` | https://github.com/mrdoob/three.js/blob/r171/examples/jsm/loaders/GLTFLoader.js#L431-L439 | A |
| 31 | glTF 2.0 规范（米制单位） | https://registry.khronos.org/glTF/specs/2.0/glTF-2.0.html#coordinate-system-and-units | A |
| 32 | MDN `getContext`（premultipliedAlpha/preserveDrawingBuffer） | https://developer.mozilla.org/en-US/docs/Web/API/HTMLCanvasElement/getContext | A |
| 33 | WebGL and Alpha（预乘 alpha 解释） | https://webglfundamentals.org/webgl/lessons/webgl-and-alpha.html | B/C |
| 34 | Electron BaseWindow（transparent/backgroundColor/hasShadow） | https://www.electronjs.org/docs/latest/api/base-window | A |
| 35 | Electron 透明窗口示例（Custom Window Styles） | https://www.electronjs.org/docs/latest/tutorial/custom-window-styles | A |
| 36 | three-vrm 官方 API：VRMLoaderPlugin | https://pixiv.github.io/three-vrm/docs/classes/three-vrm.VRMLoaderPlugin.html | B |
| 37 | three-vrm 官方 API：VRM | https://pixiv.github.io/three-vrm/docs/classes/three-vrm.VRM.html | B |
| 38 | three-vrm 官方 API：VRMLookAtBoneApplier | https://pixiv.github.io/three-vrm/docs/classes/three-vrm-core.VRMLookAtBoneApplier.html | B |
| 39 | three-vrm issue #1199（缩放下描边不跟随） | https://github.com/pixiv/three-vrm/issues/1199 | B |

### 5.2 中文社区 / 第三方项目（只作线索，需实机复核）

| # | 标题 | URL | 级别 | 可复用点 |
|---|---|---|---|---|
| 1 | `dsh-plugin-vrmpet3d`（DSH 的 VRM 3D 桌宠插件，中文） | https://github.com/drliuhuan/dsh-plugin-vrmpet3d | C | 透明悬浮窗、`preserveDrawingBuffer` 读像素、固定 60Hz spring、`material.update` 导致黑衣的实测、逐帧 lookAt/头部 gaze、`capturePage` 空图问题；代码注释可复核，但不是官方实现 |
| 2 | `GI-Engine`（中文 VRM 桌面伙伴，Unity） | https://github.com/Nekoluna-dot/GI-Engine | C | 产品级功能/贴地/模型商店参考；**不是 Electron/three.js 技术栈**，不能直接复用代码 |
| 3 | ClawBody：基于 Tauri 与 Three.js 的 AI 智能体 3D 桌面可视化实践（CSDN） | https://blog.csdn.net/weixin_42561249/article/details/160873870 | D | Tauri + three-vrm + 透明置顶 + 点击穿透的架构描述；页面标注 AIGC 生成，参数/结论需自行验证 |
| 4 | pixiv/three-vrm 调研：把「虚拟形象」做成 Web 标准件（中文博客） | https://blog.mushroom.cv/blog/avatar-vrm-threejs-pixiv-three-vrm-mtoon-webgpu/ | C/D | three-vrm 包结构/版本/能力的概述；适合入门，不包含可落地的参数 |
| 5 | B 站「3D电子宠物」/ three-vrm 桌宠搜索 | https://www.bilibili.com/video/BV1qrcye2E3E/ ；https://search.bilibili.com/all?keyword=three-vrm%20%E6%A1%8C%E5%AE%A0 | D | 仅标题/搜索页；未能抓取正文，不引用其中任何技术结论 |

> 注：中文社区里能直接落到「Electron + three-vrm + 透明窗口」代码层的，目前只找到 `dsh-plugin-vrmpet3d` 这一份可复核源码；其余多为产品展示、Unity 实现或 AIGC 概述。建议把它当「线索 + 对照实验」，不要当规范。

---

## 附录 A：目标模型只读解析结果

文件：[`assets/vrm/aventurine-tpose.vrm`](../../assets/vrm/aventurine-tpose.vrm)（本地私有资产，不再分发）。

| 项 | 值 |
|---|---|
| 格式 | GLB，`VRMC_vrm` specVersion `1.0` |
| extensionsUsed | `VRMC_vrm`、`VRMC_materials_mtoon`、`VRMC_springBone` |
| humanoid 骨数 | 53（含 leftEye/rightEye、toes、30 手指） |
| expressions | 17 preset + 78 custom = 95；**无 neutral**；`happy`/`relaxed` 有 `overrideBlink="blend"`；无 `overrideMouth` |
| lookAt | `type="bone"`，offset `[0,0.06,0]`，outputScale 横 9.618 / 下 6.73 / 上 4.81 |
| SpringBone | 50 链、175 collider、21 colliderGroup；第一条链 center=node 374 |
| MToon | 39 材质：21 OPAQUE、12 MASK、6 BLEND；**39 个 outlineWidthMode 全为 `none`** |
| 角色朝向 | +Z 面向相机（VRM 1.0） |

复现方式（只读，不写文件）：

```bash
python3 - <<'PY'
import struct, json
p = 'assets/vrm/aventurine-tpose.vrm'
data = open(p, 'rb').read()
length = struct.unpack_from('<III', data, 0)[2]
off = 12
while off < length:
    clen, ctype = struct.unpack_from('<II', data, off); off += 8
    if ctype == 0x4E4F534A:  # 'JSON'
        j = json.loads(data[off:off+clen].rstrip(b'\x00').decode('utf-8')); break
    off += clen
vrm = j['extensions']['VRMC_vrm']
print(len(vrm['humanoid']['humanBones']), len(vrm['expressions']['preset']), len(vrm['expressions'].get('custom', {})))
print(vrm.get('lookAt'))
print(len(j['extensions']['VRMC_springBone']['springs']), len(j['extensions']['VRMC_springBone']['colliders']))
print(sum(1 for m in j['materials'] if m.get('extensions', {}).get('VRMC_materials_mtoon', {}).get('outlineWidthMode') != 'none'))
PY
```

## 附录 B：与本仓库现有设计文档的差异（需要 Lead 确认）

| 设计文档说法 | 本次调研/实测 | 建议 |
|---|---|---|
| 任务背景：「无 VRM lookAt 扩展」 | tpose 资产实际有 `lookAt.type="bone"` | 以 loader 能力探测为准；有则用 `vrm.lookAt`，无则程序化 |
| 设计文档：「MToon 自带描边，V6 调参」 | 39 材质 outline 全 none，当前没有描边 pass | V1 接受 `outlinePx=0`；要描边先 patch GLB，且 BLEND 材质慎用 |
| `docs/expression-mapping.md`：「neutral 不是 preset」 | 规范中 neutral 是 preset（向后兼容）；本模型没有定义 | 业务 neutral=全清 0 仍正确；修正注释/契约措辞 |
| 设计文档：世界单位=CSS px，模型直接缩放 | SpringBone 在缩放模型上必须改 stiffness/hitRadius/collider；gravityPower 可能也要 | 优先米制场景；或按 guide 缩放 spring 参数并做 resize 重算 |
| 设计文档：`rawPolicy=spring` 不写 raw | 正确；但 `autoUpdateHumanBones` 必须保持 true，否则 normalized 不会到 mesh | 保持 true；只避免手写 raw humanoid 骨 |
| 设计文档：clip 播放后 `humanoid.update()` | 正确；还要在测脚/ lookAt 前 `scene.updateMatrixWorld(true)` | 固定帧序见 3.2 |
| 设计文档：表情在 `vrm.update(dt)` 前 setValue | 正确；`vrm.update` 内部会 expressionManager.update | 不要手动再 update 一次 |
| 设计文档：每 clip 常量贴地残差 | 正确；脚骨≠鞋底，需加 rest 脚底偏移 | 离线采样 + 脚底常量 + clip 切换插值 |
| 设计文档：不做屏幕空间 OutlineEffect | 当前资产没有 MToon outline，正好 | V1 不做；要描边再评估 patch vs 后处理 |

---

## 六、一句话结论

**V1 的运行时核心不是「把 VRM 加到 scene」，而是三件事：保持 `autoUpdateHumanBones=true` 并每帧按固定顺序写 normalized → humanoid.update → expressions/lookAt → vrm.update；把 SpringBone 的缩放问题解决掉（优先米制场景）；把透明背景的 alpha/材质更新/证据抓帧当成一等公民。** 目标模型实际有 bone lookAt、没有 MToon 描边，这两点必须先改设计假设，再写代码。
