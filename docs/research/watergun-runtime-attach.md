# 水枪道具运行时挂点调研（three-vrm 3.5.5 / three r171）

> 调研人：research-runtime（Team Lead: lead）｜日期：2026-11-09｜范围：**只做运行时挂点方向**，不含 .max/FBX 水枪网格排查、Blender 烘焙、资产来源判定（其他 lane 负责）。
> 结论面向「砂金·戏浪」VRM 1.0（`assets/vrm/aventurine-tpose.vrm`）+ 138 个 .max 动作转出的 humanoid clip（当前线上是私有 JSON clip 管线；未来若换 VRMA，结论不变，见 §1.4）。
> 所有网页资料访问日期均为 **2026-11-09**；官方文档与社区经验分开标注。模型/动作/贴图为 miHoYo 私有游戏资产，**仅本机开发，禁止上传/再分发**（见文末声明）。

---

## 0. Lead 复核补充（2026-11-09 晚，优先读）

> 本文件写作时假设「水枪网格来源/源手骨变换未定」。Lead 在同期已完成本机实测，结论如下（详见 [`watergun-prop-plan.md`](watergun-prop-plan.md) §1–§3）：
>
> 1. **水枪网格已找到并提取**：`.max` 全场景 FBX（pilot）内含 `0009_Weapon`（4642 顶点/4508 面）+ `Gun_b/c/d/e_01_JNT`/`prop_JNT` 武器骨；贴图与本地 `assets/model/水枪.png` 同一张（UV 渲染验证）。已产出 **`assets/props/watergun/watergun.glb`**（米制/中心在原点/长轴 +Z/上 +Y，2.38 MB 贴图内嵌）+ `meta.json`，无需 Blender 重建。
> 2. **源武器未绑定到手骨**（Tpose/StandBy 场景里枪在原点脚边），但 **Skill01 场景里武器骨跟手**：`inv(H_hand)·G_gun` 跨帧近似常量 `t≈(0.013,0.042,0.087) m`、`q≈(0.66,-0.01,-0.05,0.75)` → 已给出 §3.3 的校准初值（换算到 VRM raw 手骨后先试，再用预览截图微调；不存在"必须另找 T_source 否则阻塞"的问题）。
> 3. **方案决策**：V1 采用本文件的「挂 raw rightHand」方案（见 plan §2–§3）；本文 §1–§3 的 API/坐标系/帧序/生命周期细节全部有效，接入点表 §4 仍按原样执行。

---

## 0. 结论摘要（TL;DR）

1. **可行且成本最低的方案：把水枪 GLB/网格作为子物体 `add()` 到 VRM 右手的 raw 骨节点；不需要每帧同步、不需要 IK、不需要改 SpringBone。** 骨节点被 humanoid 动画驱动 → 子树自动跟随；渲染前 three.js 会自动更新 `matrixWorld`。
2. **挂点用 `vrm.humanoid.getRawBoneNode('rightHand')`（raw），不要挂 `vrm.scene`/hips。** raw 骨是蒙皮实际使用的"最终姿态"骨，本项目 clip 管线（写 normalized → `humanoid.update()` → raw）和 VRMA 管线（mixer 写 normalized）最终都收敛到 raw；挂 normalized 骨也能跟随（两者只差一个**常量** rest 旋转，见 §1.2），但 raw 更语义正确、调试更直观。normalized 是可移植备选（偏移量在 T-pose 空间表达，换模型不用重标）。
3. **校准用 `Object3D.attach()` 一次性烘焙**：加载后先让 VRM 处于 rest/T-pose，把水枪摆到手中正确位置（世界坐标），`rightHand.attach(gun)` 一次，three.js 自动反算局部偏移；把得到的局部 `position/quaternion/scale` 存进 manifest（或代码常量）。**不要用 `add()` 后手算模型特定轴**——raw 手骨的局部轴随 rig 变化。
4. **按片段挂/卸**：在**生成侧**（`scripts/vrm/motion/clips.hsr.json` 的 clip 覆盖项）加 `prop` 元数据 → `build-app-manifest.mjs` 透传进 `app-catalog.json` → 渲染侧新增 `prop-layer.ts` 读当前 clip 条目切状态（`hold`/`support`/`holster`/`hidden`）。V1 只做 `visible` 切换即可，隐藏/出现用 0.1–0.15s 缩放淡入，避免水枪"瞬移"。
5. **双手持握不需要运行时 IK**：原始 .max 动作本来就是"握着枪"编的，双手位置已经在动画里；只要把枪固定挂在持枪手（大概率右手）并校准一次，左手自然落在护木附近。要修正也只应做**很小的左手偏移**，不要上 TwoBoneIK（成本/抖动/膝肘翻转风险都不值，见 §3.6）。
6. 必须注意的坑：`avatar.dispose()` 会 `VRMUtils.deepDispose(vrm.scene)`（`src/renderer/src/vrm/avatar-loader.ts:740-746`），**挂在骨下的道具会被一并 dispose**——道具层必须自己持有引用并在换模型前 detach/重建；道具 GLB 必须按 glTF 米制导出（1 unit = 1 m），并在加载时做 bbox 尺度 sanity check。

---

## 1. 事实基线（API / 坐标系 / 动画目标节点）

### 1.1 raw vs normalized：three-vrm 加载时做了两棵树

three-vrm 3.x 在加载 VRM 1.0 时会为 humanoid **额外构造一棵 normalized rig**：

- raw 骨 = glTF 原始节点，`SkinnedMesh.skin`/`Skeleton` 绑的是它；VRM 1.0 里 raw 是 **T-pose rest**，局部旋转/位置不归一化。
- normalized 骨 = `VRMHumanoidRig` 构造的独立 `Object3D` 树，节点命名 `Normalized_<rawName>`，根节点名 `VRMHumanoidRig`；rest **位置**由 raw 世界位置反推（相对"最近 humanoid 父骨"的偏移），rest **旋转为 identity**（源码只 copy position，不 copy rotation）。根被 `gltf.scene.add(...)` 挂进场景。
  - 源码（本地安装）：`node_modules/@pixiv/three-vrm/lib/three-vrm.module.js:1710`（`VRMHumanoidRig`）、`:1750`（`name = "Normalized_" + boneName`）、`:1751-1758`（position 反推）、`:2135`（`gltf.scene.add(humanoid.normalizedHumanBonesRoot)`）。
  - 官方源码：[`VRMHumanoidRig.ts` L15-L90](https://github.com/pixiv/three-vrm/blob/v3.5.5/packages/three-vrm-core/src/humanoid/VRMHumanoidRig.ts#L15-L90)、[`VRMHumanoidLoaderPlugin.ts` L140-L143](https://github.com/pixiv/three-vrm/blob/v3.5.5/packages/three-vrm-core/src/humanoid/VRMHumanoidLoaderPlugin.ts#L140-L143)。
- API：`getRawBoneNode(name)` / `getNormalizedBoneNode(name)`（bundle `:2011` / `:2019`；官方 [VRMHumanoid API](https://pixiv.github.io/three-vrm/docs/classes/three-vrm.VRMHumanoid.html)）。`getBoneNode()` 已废弃、等价 raw。
- `autoUpdateHumanBones`（默认 `true`）：`humanoid.update()` 会把 normalized 姿态**回写 raw**（bundle `:2026-2031`；官方 [`VRMHumanoid.ts` L292-L297](https://github.com/pixiv/three-vrm/blob/v3.5.5/packages/three-vrm-core/src/humanoid/VRMHumanoid.ts#L292-L297)）。

**回写公式（关键）**：raw 局部四元数 = `inv(parentRawWorldRot) * normalizedQuat * parentRawWorldRot * rawRestLocalRotation`；只有 hips 额外写 location（bundle `:1786-1793`；官方 [`VRMHumanoidRig.ts` L112-L139](https://github.com/pixiv/three-vrm/blob/v3.5.5/packages/three-vrm-core/src/humanoid/VRMHumanoidRig.ts#L112-L139)）。

> 这条公式直接推出一个对本任务很重要的事实：**raw 手骨的世界朝向 = normalized 手骨的世界朝向 × 常量 rest 旋转**。所以：
> - 挂 raw 手和挂 normalized 手，**跟随动画的效果完全等价**（只差一个固定旋转，二者可以互相换算偏移）；
> - 挂 normalized 的偏移量在"模型空间/T-pose 轴"下表达（normalized rest 旋转 = identity），换模型/换 rig 更可移植；
> - 挂 raw 的偏移量在"该模型 raw 手骨的局部轴"下表达，**换模型必须重标**，但 raw 是蒙皮最终姿态、调试直观。
> - 无论挂哪，`humanoid.update()` 之后子树都拿到最终姿态；**不需要每帧复制矩阵**。

### 1.2 本项目的写骨链路（clip JSON，不是 VRMA）

- 冻结契约注释已写明口径：clip `r` 写到 `humanoid.getNormalizedBoneNode(vrmName)` 的 quaternion，`p` 加 normalized hips rest；然后 `humanoid.update()` 自动转 raw —— [`src/renderer/src/vrm/humanoid-map.ts:12-14`](../../src/renderer/src/vrm/humanoid-map.ts#L12-L14)。
- clip-player 每帧写 normalized 骨 + hips，并在写完后调用 `humanoid.update()`：`src/renderer/src/vrm/clip-player.ts:13`、`:1191`（当前帧写姿势）、`:1280`（`humanoid.update()`）。
- animator 帧序：`clipPlayer.update()`（`src/renderer/src/vrm/animator.ts:252-...`，含 `humanoid.update()`）→ 表情 → look-at additive → 必要时再 `humanoid.update()`（`:357-373`）→ `vrm.update(dt)`（`:374-379`）。
- 场景层：`poseDriver.update(input)` 之后才 `renderer.render(scene, camera)` —— `src/renderer/src/vrm/pet-scene-vrm.ts:537-590`。**只要 prop 是手骨的子节点，渲染时它的世界矩阵一定已是最新，零额外代码。**

### 1.3 挂到骨下的子物体为什么会被驱动（含 three.js 语义）

- 骨骼动画只改骨节点的 `local quaternion/position`；`renderer.render()` 前 `scene.updateMatrixWorld()` 递归更新所有后代 → prop 的 `matrixWorld = hand.matrixWorld * prop.matrix`。挂一次，永久跟随。
- 不要用"每帧把 `hand.matrixWorld` copy 给场景里的 prop"：若复制点在 `humanoid.update()` 之前，会慢一帧/抖动；子节点方案天然没有这个顺序问题。
- `Object3D.add` 只 reparent、不保留世界变换；`Object3D.attach` 会保持世界变换并反算局部（r171 源码 [`Object3D.js` L313-L345 (add), L409-L445 (attach)](https://github.com/mrdoob/three.js/blob/r171/src/core/Object3D.js#L313-L345)）。attach 的注意事项：**祖先链不支持非均匀缩放**（源码注释明确写了）——本模型 `modelRoot.scale = 1`（`pet-scene-vrm.ts:740`），VRM humanoid 骨也不允许缩放，满足前提。

### 1.4 如果将来改用 VRMA：目标节点还是 normalized，结论不变

- `@pixiv/three-vrm-animation` 的 `createVRMAnimationClip` 把轨道 target 设为 `humanoid.getNormalizedBoneNode(name).name + '.quaternion'`，hips 位移 target 是 normalized hips 的 `.position`：本地 bundle `node_modules/@pixiv/three-vrm-animation/lib/three-vrm-animation.module.js:1695`、`:1706`、`:1748-1750`；官方源码 [`createVRMAnimationClip.ts` L23-L47](https://github.com/pixiv/three-vrm/blob/v3.5.5/packages/three-vrm-animation/src/createVRMAnimationClip.ts#L23-L47)。
- VRMA 规范限定：humanoid 动画**只有旋转，且只有 hips 有位移，不含 scale** —— [VRMC_vrm_animation-1.0 README（Humanoid 一节）](https://github.com/vrm-c/vrm-specification/blob/master/specification/VRMC_vrm_animation-1.0/README.md#humanoid)。
- 所以「mixer 写 normalized → `humanoid.update()` → raw → 子节点跟随」链路对 JSON clip 和 VRMA **完全一致**；本项目 V1 不需要为道具引入 mixer。

### 1.5 单位 / 坐标系 / 缩放

- VRM 1.0 使用 **glTF 米制**（Cooperative Units）：[VRMC_vrm-1.0 README "Coordinate Units"](https://github.com/vrm-c/vrm-specification/blob/master/specification/VRMC_vrm-1.0/README.md#coordinate-units) → [glTF 2.0 Coordinate System and Units](https://registry.khronos.org/glTF/specs/2.0/glTF-2.0.html#coordinate-system-and-units)。
- 本项目世界就是**米制**：`modelRoot.scale = 1`，视觉大小由正交相机视锥 + `pxPerMeter` 换算（`src/renderer/src/vrm/pet-scene-vrm.ts:716-748`；`VrmAvatar.restHeightMeters` 1.73 m）。宠物总高几十~几百 CSS px，但**世界单位仍是米**。
- 因此道具 GLB 必须**按米导出**（Blender glTF 导出会自动做 +Y-up/米制转换；若源是 .max/FBX 的 cm 单位，上游导出时要乘 0.01，这属于 Lead 的 FBX/Blender lane，运行时不做魔法换算）。
- VRM 1.0 姿态：面向 +Z、左手 +X（manifest `yawOffsetDeg: 0`，见 `src/shared/vrm-manifest.json`；项目 research 已核验 `docs/research/vrm-runtime-research.md:209-...` 一带）。挂点自身是骨局部空间，不需要额外朝向修正。
- MMD/PMX 单位不是米（旧 PMX 路径约 1 unit≈0.08 m），但本任务走 VRM 1.0 米制；**不要**把 PMX 的 `1/0.08` 系数带进 VRM 运行时。

### 1.6 挂点对比（推荐 raw，备选 normalized）

| 维度 | raw 骨（`getRawBoneNode`） | normalized 骨（`getNormalizedBoneNode`） |
|---|---|---|
| 语义 | 蒙皮实际骨，最终姿态 | 姿态代理（proxy），加载时构建 |
| 是否被动画驱动 | 是（`humanoid.update()` 每帧回写） | 是（clip 直接写它） |
| 偏移量坐标系 | 该模型 raw 手骨局部轴（**模型相关**） | 模型空间 / T-pose 轴（rest 旋转 identity，**可移植**） |
| 换模型 | 需重标 | 偏移可直接复用（同 T-pose 约定下） |
| 与其它写骨层关系 | raw 是最终汇合点；foot-lock 经 normalized 写脚（`src/renderer/src/vrm/foot-lock.ts:72-79`），不影响手 | 看不到 raw-only 修改 |
| 调试 | SkeletonHelper/骨骼名直观 | 节点名带 `Normalized_` 前缀，容易混淆 |
| **本项目建议** | **主方案** | 备选（若要跨模型复用偏移） |

> 注意：`autoUpdateHumanBones=false` 时 raw 不会被驱动，挂 raw 会僵死；本项目保持默认 `true`（clip-player 依赖它），不存在该问题。

---

## 2. 方案对比（为什么不用别的做法）

| 方案 | 做法 | 成本 | 风险 | 结论 |
|---|---|---|---|---|
| **A. 挂 raw 手骨（推荐）** | `rightHand.add(gun)` / 校准用 `attach` | 一次性校准；每帧 0 代码 | 偏移模型相关；dispose 需自己管理 | **V1 采用** |
| B. 挂 normalized 手骨 | `getNormalizedBoneNode('rightHand').add(gun)` | 同上 | 与 raw-only 写入不联动；命名混淆 | 备选 |
| C. 场景级 prop + 每帧 copy 手世界矩阵 | 手动同步 | 每帧 1 次矩阵写 | 帧序错就慢一帧/抖动；还要处理 hide | 不采用 |
| D. 把水枪烘进 VRM 网格/骨骼 | Blender 重做模型 | 高（要改资产管线） | 改模型影响 39 材质/表情/spring；不可逆 | 不采用（资产 lane 若拿到 FBX 水枪网格可另议） |
| E. 运行时 IK 让双手贴合 | TwoBoneIK/CCDIK | 高（每帧 IK + 关节限制） | 抖动/翻转/参数标定；桌宠收益低 | 不采用（见 §3.6） |

---

## 3. 推荐实现方案（V1 最小闭环）

### 3.1 资产形态

- **优先 GLB**：Blender 里把水枪网格贴好 `水枪.png`（2048×2048）→ glTF 导出（米制、+Y up、贴图内嵌/`images` bufferView 或同包 PNG 均可；`pet-asset://` 协议能读 `assets/**`，见 `src/main/protocol-path.ts:8-21`）。
- 存放建议：`assets/props/watergun.glb`（assets 根 = `pet-asset://assets/`；已有 `assets/vrm`、`assets/model`、`assets/motions` 等目录，新增 `props/` 不冲突）。**不要在运行时直接拿 `assets/model/水枪.png` 建材质**——PMX 未引用它，贴图 UV 只有网格作者知道；贴图进 GLB 最省事。
- 如果一个 GLB 里同时有"手持"和"收纳"两个形态，优先拆成两个节点/两个 GLB，运行时按需 `visible`（见 §3.5）。
- 尺度基准：加载后 `new Box3().setFromObject(gun)` 量 bbox，合理范围约 **0.2–0.4 m 长**（角色 1.73 m，手长约 0.18 m）。超出 ±50% 时 `console.warn` 并在 manifest 用 `scale` 修正，不要直接改 `avatar` 的 scale（会破坏 SpringBone 物理，见 `pet-scene-vrm.ts:716-748` 注释）。

### 3.2 加载（`GLTFLoader`，不走 VRM 插件）

```ts
// 新增 src/renderer/src/vrm/prop-loader.ts
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import type { LoadingManager } from 'three'

export async function loadHandProp(
  url: string,
  manager?: LoadingManager,
): Promise<{ scene: THREE.Group; bbox: THREE.Box3 }> {
  const loader = new GLTFLoader(manager) // 不需要 VRMLoaderPlugin
  const gltf = await loader.loadAsync(url)
  const scene = gltf.scene
  const bbox = new THREE.Box3().setFromObject(scene)
  return { scene, bbox }
}
```

- 用场景层同一个 `LoadingManager`（`createPetAssetLoadTracker`，`pet-scene-vrm.ts` 已有 `this.tracker.manager`），贴图加载失败/重试可复用现有 handler。
- 若水枪 GLB 由 Blender 用 MToon 材质导出（`VRMC_materials_mtoon`），才需要 `loader.register(p => new MToonMaterialLoaderPlugin(p))`（`MToonMaterialLoaderPlugin.EXTENSION_NAME = 'VRMC_materials_mtoon'`，[官方源码 L45-L46](https://github.com/pixiv/three-vrm/blob/v3.5.5/packages/three-vrm-materials-mtoon/src/MToonMaterialLoaderPlugin.ts#L45-L46)；本项目包已导出该类，`node_modules/@pixiv/three-vrm/lib/three-vrm.module.js:6746`）。**普通 PBR GLB 不需要**，加了也只是惰性生效。
- 纹理语义：GLTFLoader 会把 baseColor 贴图设成 `SRGBColorSpace`（内嵌贴图自动处理）；如果以后自己 `TextureLoader` 加载 `水枪.png`，记得 `texture.colorSpace = THREE.SRGBColorSpace` + `anisotropy`（参考 `pet-scene-vrm.ts:698-712` 对 VRM 贴图开各向异性的做法）。

### 3.3 挂点与校准（一次）

```ts
// prop-layer.ts 内部（示意）：必须在 VRM rest/T-pose、且 vrm.update(0) 之后执行一次
const hand = vrm.humanoid.getRawBoneNode('rightHand')
if (!hand) throw new Error('missing rightHand') // 兜底：降级为隐藏水枪，不抛

// 1) 先按「世界坐标」把水枪摆到正确握持位（T-pose 下手掌前方）
scene.attach(gun)                      // 或 scene.add(gun)
gun.position.copy(desiredWorldPos)     // 单位：米
gun.quaternion.copy(desiredWorldQuat)  // 可用手骨世界旋转推算

// 2) 永久挂到 raw 手骨；attach 保持世界变换，自动反算 local
hand.attach(gun)

// 3) 记录/回填到配置（开发期打印一次，写进 manifest）
console.log(gun.position.toArray(), gun.quaternion.toArray(), gun.scale.toArray())
```

- 校准值来源优先级：
  1. **源资产变换**（最佳）：若 Lead/Blender lane 从 .max/FBX 里找到了水枪网格及其相对手骨的变换 `T_source`，则 `holdOffset` ≈ `T_source`（同 T-pose 约定下语义一致；本项目 clip 数据已按目标 rest 做过 per-bone swing 修正，见 `scripts/vrm/motion/clips.hsr.json` 的 `source.restFixNote`）。
  2. 手工摆一次 + 截图微调（最省事）。桌宠尺寸下 ±1 cm 肉眼几乎不可见。
  3. 若挂 normalized 备选：用 `getNormalizedBoneNode('rightHand')` 做同样的事，偏移量天然在 T-pose 轴下表达。
- 持久化：建议放 `src/shared/vrm-manifest.json` 的 avatar 条目扩展字段（如 `handProps: [{ id: 'watergun', file: 'props/watergun.glb', bone: 'rightHand', position: [...], quaternion: [...], scale: [...] }]`），由 `src/shared/vrm.ts:220` 的 `VrmAvatarAsset` 清洗函数加可选字段；**或者**先放独立常量文件 `src/renderer/src/vrm/prop-config.ts`，V1 更快、不动冻结契约。二选一，Lead 定。
- **不要在 `avatar-loader` 里挂**：avatar-loader 职责是"VRM 资产 → VrmAvatar"，不知道 clip 也不该知道道具；道具是场景/动画层概念，建议由 `pet-scene-vrm` 在 `loadAvatar` 完成后调用 `propLayer.attach(avatar)`，由 animator 每帧驱动状态（见 §5）。

### 3.4 材质 / 渲染 / 剔除

- 推荐 `MeshStandardMaterial`（GLB 默认）即可：场景已有 AmbientLight + 3 个 DirectionalLight（`pet-scene-vrm.ts:678-691`），r171 物理光照下 PBR 能看清；但**风格会和 MToon 角色不一致**（MToon 平涂 vs PBR 高光）。
- 更好的观感（低工作量）：把道具材质在运行时换成 `MeshToonMaterial`，`gradientMap` 复用项目已有的 `assets/model/optimized/toon3.png`（MMD 三阶 toon ramp；`NearestFilter`）。若 Blender 直接导出 MToon 材质则直接对齐角色。
- 透明/描边：水枪本体不要开 `transparent`；若贴图有 alpha 裁切用 `alphaTest`（MASK 语义）。VRM 的 MToon 描边只作用于角色材质，道具不描边即可（桌宠尺寸下差异小）。
- 视锥剔除：**静态道具保持默认 `frustumCulled = true`**（bounding sphere 在局部空间，`matrixWorld` 正确变换，骨动画不影响它）。仅当道具带 SkinnedMesh/morph 动画时才对它关剔除（与 three-vrm 官方示例对角色 SkinnedMesh 的处理同理：[`basic.html` L84-L93](https://github.com/pixiv/three-vrm/blob/v3.5.5/packages/three-vrm/examples/basic.html#L84-L93)）。
- 阴影：本场景未开启 `renderer.shadowMap`（`pet-scene-vrm.ts:251-252` 仅 `alpha:true, antialias:true`），道具无需 castShadow，避免额外成本。
- 性能：+1~2 个 draw call，可忽略；`visible=false` 时整棵子树跳过渲染但仍遍历矩阵（极小开销）。

### 3.5 按片段挂/卸（hold / holster / hidden）

**数据流（推荐，不在运行时猜）**：

1. **生成侧**（源数据）：在 `scripts/vrm/motion/clips.hsr.json` 的 clip 条目上加可选字段，例如：
   ```jsonc
   {
     "id": "skill01",
     "tags": ["show", "skill"],
     "prop": { "state": "hold", "hand": "right", "supportHand": "left" } // 新增
   }
   ```
   默认值按 tag 推断即可：`tags` 含 `skill` → `hold`（当前 hsr 的 skill01/02/03/mazeSkill/passiveSkill 从源动作名 `Ani_Skill01` 等可确定是技能动作，见 `assets/motions/hsr/manifest.json`）；其余 clip → `hidden`。只有"要不要持枪"有争议的 clip 才需要逐条 override。
2. **构建侧**：`scripts/vrm/motion/build-app-manifest.mjs` 目前把 clip 的 `tags/loop/duration/...` 组进 catalog（`build-app-manifest.mjs:345-360`，`mood` 判定在 `:283-290`）。加 3 行把 `prop` 原样透传到 `assets/motions/app-catalog.json`。
3. **运行时**：`AppCatalogClip`（`src/renderer/src/vrm/clip-registry.ts:63-79`）加 `prop?: { state: 'hold'|'support'|'holster'|'hidden'; hand?: 'right'|'left'; supportHand?: 'left'|'right'|null }`；`clip-player` 当前条目已有 `currentClipId`（`src/renderer/src/vrm/clip-player.ts:444`）与 `snapshot().clipId`（`:625-640`）。
4. **道具层**：`prop-layer.update(dt)` 每帧读 `clipPlayer.snapshot().clipId` → 查 registry 的 catalog 条目 → 解析 `prop.state` → 目标 `visible/attachBone`，用 ~0.12 s 的平滑（缩放/位置）过渡；**切换 clip 的淡入淡出期间保持上一次状态**，避免交叉淡入时道具闪。
5. 兜底：catalog 里查不到 `prop` 字段时，用启发式（`tags.includes('skill') || tags.includes('show')`）；再兜底 `hidden`。任何失败只 `console.warn`，不抛（沿用项目"子层失败降级"原则，`animator.ts:57-60`）。

**收纳/挂在背后/腰侧**：
- 最省事：V1 只做 `hidden`（`visible=false`）。桌宠体量小，动作切换时"水枪消失"比"瞬移回背上"更不容易穿帮。
- 要"收在腰侧/背后"再挂：**两套实例**（手里一把、腰侧一把），只切 `visible`。不要运行时 `hand.remove(gun); hipBone.add(gun)` 来回搬——虽然 `attach` 可保持世界变换，但切换瞬间会跟位置平滑打架，且两处偏移都要校准；两实例各校准一次更简单，成本只多 1 个 draw call（隐藏时不计）。
- 状态到骨骼映射建议放配置：`hold → raw rightHand`、`holster → raw hips`（或 spine；具体看收纳位置）、`support → 左手的辅助偏移`。

### 3.6 双手持握 / IK：V1 不做

- **核心论据**：这些动作在源 .max 里本来就是带武器编的（HSR 官方动画），左右手的相对位置已经烘焙在 clip 骨骼旋转里；本项目 clip 数据是 humanoid 全骨（52 骨）逐帧四元数，双手姿态完整。**因此固定挂右手即可让左手落在枪身附近，不需要每帧求解。**
- 残余误差来源：目标模型 1.73 m 与 HSR 源比例不同 + retarget 的手部 swing 修正（`clips.hsr.json` 的 `restFixNote`）→ 左手可能差 1–3 cm 量级；桌宠显示尺寸（几十 cm 高，即 1 cm ≈ 2–4 px）通常不可见。
- 若实机确实明显：优先在**数据侧**给这两条 clip 的左手加常量偏移（比运行时 IK 稳）；其次运行时对 `leftHand` 做一次固定局部 quaternion 微调（成本≈0，但要逐 clip 配置）。
- 不推荐上 TwoBoneIK：three.js 只有 MMD 风 `CCDIKSolver`（`examples/jsm/animation/CCDIKSolver.js`，r171 [`L49`](https://github.com/mrdoob/three.js/blob/r171/examples/jsm/animation/CCDIKSolver.js#L49)），要每帧在 `humanoid.update()` 之后写 raw 上臂/前臂，和现有"normalized 单 writer"原则冲突（会出现 raw 被 IK 覆盖 vs humanoid.update 覆盖的写入顺序问题），且关节极限/翻转需要额外约束。收益（1–3 cm）远小于风险。
- 现成库现状：three-vrm 官方没有 IK/attachment 插件；`VRMC_node_constraint`（roll/twist/aim，[规范](https://github.com/vrm-c/vrm-specification/blob/master/specification/VRMC_node_constraint-1.0/README.md)）是约束不是 IK，对"手贴枪"没有直接帮助；`vrm-c` 也没有官方道具挂点库。**挂骨子节点就是社区标准做法**。

### 3.7 推荐帧序（相对现有 animator）

```ts
// animator.update() 内，在 vrm.update(dt) 之前（visibility/状态没有帧序硬要求，放这最自然）
clipPlayer.update(input)        // 写 normalized + humanoid.update()
expressionLayer.update(input, dt)
lookAtLayer.update(input)
humanoid.update()               // 若 lookAt/footLock 改过骨
propLayer.update(dt)            // 只改 visible / 过渡 scale；不改骨骼
vrm.update(dt)                  // spring / expressions / materials
// pet-scene-vrm: renderer.render(scene, camera)  ← prop 在骨下，矩阵自动最新
```

`propLayer` 不写任何 bone/normalized 数据 → 不违反项目的 single-writer 原则；它唯一写的 `visible/scale` 都在道具自己的子树上。

---

## 4. 与现有代码的接入点（文件:行）

| 位置 | 现状 | 建议改动 | 类型 |
|---|---|---|---|
| `src/renderer/src/vrm/pet-scene-vrm.ts:366-430` | `loadAvatar()` 加载 VRM → `new Group()` 包 `vrm.scene` → `createPoseDriverIfNeeded()` | 在 avatar 就绪后创建 `prop-layer` 并 `await propLayer.attach({ scene, vrm, avatar })`；失败只 warn、水枪隐藏 | 扩展 |
| `src/renderer/src/vrm/pet-scene-vrm.ts:537-590` | `step()`：`poseDriver.update()` 后 `renderer.render` | 无需改（prop 是骨子节点）；若 prop 层独立于 animator，可在 `poseDriver.update()` 前后加 `propLayer.update(dt)` | 不改/微调 |
| `src/renderer/src/vrm/animator.ts:252-379` | 帧序：clip → expression → lookAt → humanoid.update → vrm.update | 在 `humanoid.update()` 之后、`vrm.update()` 之前调 `propLayer.update(dt)`；`VrmPetAnimator` 增 `getPropSnapshot()` 便于调试/验收 | 扩展 |
| `src/renderer/src/vrm/runtime-types.ts:34-71` | `VrmAvatar`（vrm/scene/capabilities） | 不改；prop 层从 `avatar.vrm.humanoid` 取 hand 骨 | 不改 |
| `src/renderer/src/vrm/runtime-types.ts:143-161` | `VrmClipPlayer.snapshot()` 只给 `clipId/slot/...` | 若要按 clip 切道具，需要 catalog 条目（`registry.getPlayableEntry(id)`）或给 snapshot 加 `tags`/`prop` | 扩展（冻结契约，需 Lead 评审） |
| `src/renderer/src/vrm/clip-registry.ts:63-79` | `AppCatalogClip{ id,set,file,loop,duration,tags,mood }` | 加可选 `prop?: { state, hand, supportHand }`（运行时扩展格式，非冻结 JSON 契约） | 扩展 |
| `src/renderer/src/vrm/clip-player.ts:444`、`:625-640` | `currentClipId` / `snapshot()` | 道具层可直接用 `snapshot().clipId` 找当前条目，无需改 player | 不改 |
| `src/shared/animation-contract.ts:86-118` | `AnimationClipEntryInput/Entry`（**冻结契约**） | 若要进 append-only 的 manifest，需要 Lead 评审加 `prop` 可选字段；否则把道具状态留在 catalog 扩展层 | 需评审 |
| `src/shared/vrm.ts:220-250`、`src/shared/vrm-manifest.json` | `VrmAvatarAsset`（id/file/height/...) | 可选加 `handProps` 校准数据（每模型偏移）；V1 也可先写死代码常量 | 扩展 |
| `src/renderer/src/vrm/avatar-loader.ts:562-746` | `loadVrmAvatar()` → `VrmAvatar`；`dispose()` 用 `VRMUtils.deepDispose(scene)`（`:740-746`） | **不改**；但 prop 层必须在 avatar dispose 前 detach（否则道具被 deepDispose 提前释放） | 注意 |
| `src/renderer/src/vrm/avatar-loader.ts:617-690` | 能力探测（humanoid 骨/hipsRestHeight/materialNames/...） | 可加 `handBones: ['leftHand','rightHand']` 是否存在的探测（其实 clip 侧 52 骨已保证；可选） | 可选 |
| `src/shared/assets-manifest.json` | 贴图/PMX 资产清单（`sourceDir: assets/model`） | 若水枪 GLB 放 `assets/props/`，不需要登记；若放 `assets/model` 再走优化管线，需同步生成器 | 可选 |
| `scripts/vrm/motion/build-app-manifest.mjs:345-360` | 组 catalog clip（tags/loop/duration/mood） | 透传 `prop` 字段到 `app-catalog.json` | 扩展 |
| `scripts/vrm/motion/clips.hsr.json`（`clips` 数组） | 源 clip 覆盖表（tags/priority/grounding/timeScale/note） | 加 `prop` override（哪些 clip 持枪），生成器透传 | 扩展 |
| `tests/`（106 个测试文件，含 `vrm-clip-player.test.ts`/`vrm-clip-registry.test.ts`/`vrm-animator.test.ts`） | vitest | 新增 `tests/vrm-prop-layer.test.ts`（纯逻辑：状态解析/默认值/降级、无 three 也可测）+ 可选 `vrm-prop-attach.test.ts`（用伪 humanoid 对象测 attach 伪代码） | 新增 |

### 4.1 新增文件建议

- `src/renderer/src/vrm/prop-layer.ts`：`createVrmPropLayer({ vrm, avatar, entries, fetch... })` → `attach()`/`update(dt)`/`snapshot()`/`dispose()`；内部只用 three + 三-vrm 类型，不碰 Electron。
- `src/renderer/src/vrm/prop-loader.ts`：GLB 加载 + bbox 校验（可并入 prop-layer）。
- `src/renderer/src/vrm/prop-config.ts`（或 vrm-manifest 字段）：校准常量 / 按 clip 的 prop 状态默认规则。
- `tests/vrm-prop-layer.test.ts`：状态解析与降级路径。

---

## 5. 风险与待验证项

1. **校准数据来源未定**：水枪网格来自 .max/FBX 还是 Blender 重建，决定我们能不能拿到 `T_source`（源手骨相对变换）。运行时方案两边都能接：有 `T_source` 就回填，没有就手工摆一次。→ 待 Lead/FBX lane 结论。
2. **可见性穿帮**：动作切换时水枪瞬间出现/消失。缓解：0.1–0.15 s 缩放过渡 + 只在 `skill/show` 类 clip 出现；先在实机录屏看是否可接受。
3. **双手贴合误差**：retarget 后左手可能离枪 1–3 cm。桌宠尺寸下大概率可忽略；若不可接受，按 §3.6 先数据侧修。
4. **头像切换/dispose 生命周期**：挂在骨下的 prop 会被 `VRMUtils.deepDispose` 一起 dispose（`avatar-loader.ts:740-746`）。prop 层必须在 `avatar.dispose()` 前 detach；若未来支持多 avatar，校准数据应 per-avatar 存 manifest。
5. **道具尺度**：glTF 米制 vs .max/FBX cm 是常见错误；加载时 bbox sanity check + `scale` 修正字段兜底。
6. **风格不统一**：PBR 水枪 vs MToon 角色。若明显突兀，切 `MeshToonMaterial`（复用 `assets/model/optimized/toon3.png`）或 Blender 导 MToon。
7. **spring bone 交互**：道具不参与 SpringBone，手骨也不是 spring 驱动骨 → 不会互相拉扯。但若把水枪挂到 `spine/hips`（收纳状态）且角色有衣摆 spring，可能出现穿模；收纳状态用"隐藏"最稳。
8. **性能**：+1~2 draw call + 一个 GLB（贴图 2048²，显存几 MB，可接受）。若后续道具多可做共享实例缓存。
9. **契约变更成本**：往 `src/shared/animation-contract.ts` 加字段属于冻结契约变更（文件头 L11-14 明确要 Lead 评审）。V1 建议先走 catalog 扩展层 + 代码默认规则，零契约改动。
10. **验证顺序**：先最简 demo（`rightHand.add` 一个红盒子）确认跟手 → 再换真水枪 GLB → 再校准 → 最后接片段状态。盒子阶段不需要任何数据管线支持，1 小时内可验证。

---

## 6. 参考链接

**官方文档 / 规范**
- three-vrm v3.5.5 源码：`VRMHumanoidRig`（normalized rig 构造/回写） <https://github.com/pixiv/three-vrm/blob/v3.5.5/packages/three-vrm-core/src/humanoid/VRMHumanoidRig.ts>
- three-vrm v3.5.5 源码：`VRMHumanoid`（autoUpdateHumanBones / getRaw|NormalizedBoneNode） <https://github.com/pixiv/three-vrm/blob/v3.5.5/packages/three-vrm-core/src/humanoid/VRMHumanoid.ts>
- three-vrm v3.5.5 源码：`VRMHumanoidLoaderPlugin`（normalizedHumanBonesRoot 挂进 scene） <https://github.com/pixiv/three-vrm/blob/v3.5.5/packages/three-vrm-core/src/humanoid/VRMHumanoidLoaderPlugin.ts>
- three-vrm API：`VRMHumanoid` 类 <https://pixiv.github.io/three-vrm/docs/classes/three-vrm.VRMHumanoid.html>
- three-vrm-animation v3.5.5：`createVRMAnimationClip`（VRMA → normalized 轨道） <https://github.com/pixiv/three-vrm/blob/v3.5.5/packages/three-vrm-animation/src/createVRMAnimationClip.ts>
- three-vrm 官方 VRMA 示例（loader plugin） <https://github.com/pixiv/three-vrm/blob/v3.5.5/packages/three-vrm-animation/examples/loader-plugin.html>
- three-vrm 官方 basic 示例（VRMUtils 顺序） <https://github.com/pixiv/three-vrm/blob/v3.5.5/packages/three-vrm/examples/basic.html>
- three-vrm PR #889「Humanoid rig」：normalized bone API 的引入与设计说明（`getNormalizedBoneNode`、`autoUpdateHumanBones`） <https://github.com/pixiv/three-vrm/pull/889>
- three-vrm PR #1034：官方示例从 `getBoneNode` 迁到 `getNormalizedBoneNode` <https://github.com/pixiv/three-vrm/pull/1034>
- VRM 1.0 规范：humanoid（骨表、父子关系、不允许缩放） <https://github.com/vrm-c/vrm-specification/blob/master/specification/VRMC_vrm-1.0/humanoid.md>
- VRM 1.0 规范：Coordinate Units（米制）/更新顺序 <https://github.com/vrm-c/vrm-specification/blob/master/specification/VRMC_vrm-1.0/README.md>
- VRM Animation 1.0 规范（humanoid 动画：只有 rotation + hips translation，无 scale） <https://github.com/vrm-c/vrm-specification/blob/master/specification/VRMC_vrm_animation-1.0/README.md>
- VRMC_node_constraint 1.0（约束 ≠ IK） <https://github.com/vrm-c/vrm-specification/blob/master/specification/VRMC_node_constraint-1.0/README.md>
- glTF 2.0：Coordinate System and Units <https://registry.khronos.org/glTF/specs/2.0/glTF-2.0.html#coordinate-system-and-units>
- three.js r171 `Object3D`（`add` L313 / `attach` L409） <https://github.com/mrdoob/three.js/blob/r171/src/core/Object3D.js>
- three.js r171 `SkeletonUtils.clone`（若道具含蒙皮才需要） <https://github.com/mrdoob/three.js/blob/r171/examples/jsm/utils/SkeletonUtils.js>
- three.js r171 `CCDIKSolver`（不推荐用于本任务） <https://github.com/mrdoob/three.js/blob/r171/examples/jsm/animation/CCDIKSolver.js>
- three.js 文档：Object3D <https://threejs.org/docs/#api/en/core/Object3D>；GLTFLoader <https://threejs.org/docs/#examples/en/loaders/GLTFLoader>

**本地既有资料（本项目，避免重复造轮子）**
- `docs/research/vrm-runtime-research.md:150-300`：normalized/raw 边界、`VRMHumanoidRig` 回写公式、帧序与单 writer 原则（本次 §1.2 直接复用）。
- `docs/research/vrm-runtime-research.md:540-680`：VRMA 用法与 `createVRMAnimationClip` 轨道口径、hips 位移缩放。
- `docs/research/vrm-runtime-research.md:560-620`：贴地/脚骨采样（与本任务同一套 raw 骨世界坐标用法）。
- `src/renderer/src/vrm/humanoid-map.ts:2-20`：Unity → VRM normalized 骨映射与本项目写骨口径。
- `src/renderer/src/vrm/clip-player.ts:1-20`：clip-player 职责与帧内写骨/贴地顺序。

> 社区经验说明：本次未检索到 three-vrm 官方对"道具挂点"的专门文档/示例（GitHub issue 搜索无直接结果），§1.3/§1.6/§3.3 的挂点方案是基于 three.js `Object3D` 语义 + three-vrm 公开 API + 源码推导，属于**工程推导结论**而非官方推荐；V1 落地前按 §5 第 10 条的"红盒子 demo"优先验证。

---

## 7. 资产与合规

- `assets/model/水枪.png`（2048×2048）、`assets/vrm/aventurine-tpose.vrm`、`assets/motions/**` 均来自 miHoYo/HoYoverse 游戏资源，仅本机开发/个人使用，**禁止上传、公开分发、商用**（与 `assets/motions/hsr/manifest.json` 的 `license: official-game-asset (private, local-only)` 一致）。
- 本调研不复制任何游戏资产内容；产出的 GLB/贴图路径仅作为本机开发引用。
