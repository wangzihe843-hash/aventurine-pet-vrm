# Wave 2 · V1/V5 VRM 运行时接线设计（Lead-owned，并行实现基线）

> 状态：**2026-11-09 开工**。本文是 Wave 0–1.5 收尾（V1/V4/V2 证据）+ Wave 2（V5–V8）
> 的实现基线。teammate 按本文的接口/文件所有权开发；改接口先向 Lead 提。
>
> 相关：`PLAN.md` §5/§7/§8、`docs/vrm-contract.md`（冻结契约）、`docs/vrm-motion-hsr.md`
> §1–§9（clip 数据/播放约定）、`docs/wave15-report.md`、`docs/expression-mapping.md` §9、
> `src/renderer/src/core/wave2-contract.ts`（B1–B7 冻结接口）。

## 0. 现状与剩余工作

| Wave | 状态 | 说明 |
|---|---|---|
| W0（W0-1…W0-5） | ✅ | 依赖/契约/工具链/canary 查看器/GLB patch 全完成（`docs/wave0-report.md`） |
| W1.5（U0–U3） | ✅ | 29 个 Mate clip + 手指补全；`assets/motions/mate/**` |
| W1-V2（PMX→VRM） | ⚠️ 产出已达标，**证据/文档待补** | 产出 `assets/vrm/aventurine-tpose.vrm`（VRM1.0、95 表情、50 spring 链、T-pose）；实现走了 **VRMify（Python）** 而非 Blender Add-on 管线；需补三维视图/能力证据 + 偏差报告 |
| W1-V3（HSR 动作） | ✅ | `assets/motions/hsr/**` 14 clip（52 骨、rawPolicy=spring） |
| W1-V4（legacy 隔离） | ❌ 未做 | `src/renderer/src/animation/**` 仍是 v1 VMD/程序化实现，未移入 `legacy/`，无后端适配器 |
| W1-V1（three-vrm 渲染进 app） | ❌ 未做 | app 仍强制 PMX/MMDLoader；`src/renderer/src/vrm/` 只有 `expressions.ts` |
| W2-V5–V8 | ⏳ | 全部依赖 V1；V6 表情接线与 V8 验收未做 |

**结论：Wave 0–1.5 还剩 V1、V4、V2 证据三块。** 本文件先给 V1/V4 的实现方案；
V5–V8 在 V1 打通后按 PLAN 继续（V5 主要由 Lead 改配置/接线 + 实机调参）。

## 1. V1 总体架构

```
main 进程
  pet-asset:// 协议新增 host `assets` → <repo>/assets（dev）/ <resources>/assets（packaged）
    URL 例：pet-asset://assets/vrm/aventurine-tpose.vrm
            pet-asset://assets/motions/app-manifest.json
            pet-asset://assets/expressions/manifest.json
  config IPC：返回前做 env 覆盖（PET_MODEL_BACKEND / PET_ANIM_BACKEND > config.json > 默认 vrm）
  smoke：按 effective backend 断言（vrm / legacy-pmx 两套）

renderer
  main.ts
    读 config.modelBackend → 选择场景实现（PetView 接口，见 §3）
    vrm：VrmPetScene + createVrmPetAnimator（本文件 §4）
    legacy-pmx：PetScene + createHybridAnimator（原样，零改动）
  scene/pet-view.ts                 ← Lead 新增：两种场景的公共接口（纯类型）
  vrm/runtime-types.ts              ← Lead 新增：模块间冻结接口（纯类型）
  vrm/avatar-loader.ts              ← vrm-core：GLTFLoader+VRMLoaderPlugin 加载、VRM0 归一化、
                                       能力探测、rest bbox/aspect/hips 高、贴图追踪
  vrm/pet-scene-vrm.ts              ← vrm-core：WebGLRenderer/正交相机/MToon 光照/透明背景/
                                       摆放缩放/朝向平滑/fps/pixelRatio（复用现有小件）
  vrm/clip-data.ts                  ← clip-engine：clip JSON 解析 + 帧间插值采样（纯逻辑）
  vrm/clip-registry.ts              ← clip-engine：app-manifest/catalog 拉取、clip 懒加载缓存
  vrm/clip-player.ts                ← clip-engine：mood→clip 选择/交叉淡入/循环/一次性动作/
                                       normalized 骨写入 + Hips 位移缩放 + 贴地
  vrm/animator.ts                   ← Lead：组合 clip-player + look-at + expression-layer，
                                       写 humanoid.update()/vrm.update(dt)，实现 PoseDriver
  vrm/expression-layer.ts           ← V6：包装既有 VRMExpressionDriver（纯模块已就绪）
  vrm/look-at.ts                    ← V6：procedural 头部/眼球 additive look-at
  animation/index.ts                ← V4/Lead：legacy facade（createHybridAnimator 等导出不变）
  animation/legacy/**               ← V4：v1 的 VMD/程序化实现 git mv 到这里
```

**关键点：legacy PMX 场景/动画一行不删不改（除路径迁移），保证 `PET_MODEL_BACKEND=legacy-pmx`
随时回退。** V1 只新增文件 + 改 `main.ts`/`main` 进程接线。

## 2. 私有资产与 clip 数据约定（实现前必读）

### 2.1 资产路径（私有，gitignore）
- VRM：`assets/vrm/aventurine-tpose.vrm`（manifest 目标）、`assets/vrm/canary/*.vrm`
- 动作：`assets/motions/mate/*.json`（29）、`assets/motions/hsr/*.json`（14）
- 表情：`assets/expressions/{mate,hsr}/*.json`（17）+ `assets/expressions/manifest.json`

运行时新增**生成的 app 层清单**（私有、由脚本生成，不入 git）：
- `assets/motions/app-manifest.json`：**冻结契约** `AnimationClipManifest` 形状（`src/shared/animation-contract.ts`），
  只放 mood/salute 槽位的剪辑（idle×N、walk、sit、sleep、drag、pat…），`file` 相对 `assets/motions/`。
- `assets/motions/app-catalog.json`：运行时扩展格式（本文件 §4.3 定义），列出全部 clip（含
  hide/intro/pose/skill/hit 等一次性片段）供事件/调试按 id 播放。
- 生成脚本：`scripts/vrm/motion/build-app-manifest.mjs`（`--check` 幂等），读 mate/hsr 两套
  `manifest.json`，按 §2.3 规则映射。

### 2.2 clip JSON（`assets/motions/<set>/<clip>.json`）
```jsonc
{ "version":1, "clip":"idle", "mood":"idle", "loop":true, "fps":30,
  "duration":2.45, "frames":74, "sourceHeight":1.7, "sourceHipsHeight":1.0,
  "space":"gltf-rh", "grounding":"feet"|"none", "rawPolicy":"spring",
  "bones": { "Hips": {"r":[[x,y,z,w],...], "p":[[x,y,z],...]}, "Spine": {...}, ... } }
```
- `bones` 键 = Unity HumanBodyBones 名；`r` = **相对 rest 的归一化局部旋转**（逐帧四元数）；
- `p` 仅 Hips：米、已减首帧基准、in-place；**播放时缩放 = `avatar.hipsRestHeight / sourceHipsHeight`**，
  加到 normalized hips 的 rest position 上（口径见 `scripts/unity-bake/clip-viewer.js` L440–470、
  `scripts/vrm/motion/viewer.js` L225–255）；
- Unity→VRM normalized 骨映射：`scripts/unity-bake/lib/humanoid-map.mjs`（52 骨），运行时复制为
  `src/renderer/src/vrm/humanoid-map.ts`，并加测试保证 22+30 映射与契约一致；
- `grounding:'feet'` 的 clip（hsr 全部、mate 待补）由数据烘焙贴地；播放侧取**每 clip 常量残差**
  （首帧最低脚骨世界 y）作为竖直补偿，避免每帧硬钳导致走路脚粘地；
- `rawPolicy=spring`（新模型）：**不写 raw 节点**；头发/衣摆由 three-vrm SpringBone 在
  `vrm.update(delta)` 内驱动，必须传真实 dt（≤0.1s，已由场景钳制）。
- 播放顺序（V5 起固定）：写 normalized 骨 + Hips.p → `humanoid.update()` → 表情 setValue →
  look-at additive（如实现）→ `humanoid.update()`（若改过骨）→ `vrm.update(dt)`（spring/材质/lookAt）。

### 2.3 mate/hsr → app-manifest 映射
- 有效槽位：`slot ∈ ANIMATION_CLIP_MOODS` 且非 null 的 mate clip 直接映射；`pat←happy/laughing/shyPoint`。
- idle 多 clip：hsr `idle`(prio 10) + mate idle 系列（prio 0…-6）；**同 mood 多 clip 用 priority 排序，
  低优先级作为待机变体轮换**（clip-player 每 8–20s 或事件后换一个，避免长期只播一条）。
- `walk`：mate walk(0)/walkAlt(-2)；`sit`：mate sitWindow(0) + windowLay/suwari(负)；`sleep`：mate sleep；
  `drag`：mate drag；`salute`：无（可不提供）。
- 一次性动作（hide/intro/pose/skill/hit…，slot=null）：只进 catalog，不进 app-manifest。

## 3. 场景接口：`scene/pet-view.ts`（Lead 新增，纯类型）

`PetScene`（PMX）与 `VrmPetScene` 都结构化满足该接口，`main.ts` 的 `scene` 变量类型改为
`PetView | null`（不改动 PetScene 实现即可通过 typecheck）：

```ts
export interface PetView {
  readonly modelLoaded: boolean
  readonly modelAspectRatio: number
  readonly petWorldRect: Rect | null
  snapshot(): PetModelSnapshot
  waitForTextures(timeoutMs?: number): Promise<void>
  setViewport(viewport: { width: number; height: number }): void
  setFpsCap(fpsCap: number): void
  readonly fpsCap: number
  setOpacity(opacity: number): void
  setPetVisible(visible: boolean): void
  loadModel(url: string): Promise<void>
  readonly animationActive: boolean
  readonly animationFailureMessage: string | null
  setAnimationInput(input: AnimationDriverInput): void
  setFacing(facing: 'left' | 'right' | 'front'): void
  getAnimationSnapshot(): AnimationDebugSnapshot | null
  debugSetPose(poseId: string, fadeMs?: number): boolean
  debugSetGaze(yawDeg: number, pitchDeg: number): void
  placePet(rect: Rect, feetY: number): void
  step(nowMs: number): boolean
  getRenderStats(nowMs?: number): PetRenderStats
  setMorph(name: string, weight: number): boolean
}
```
- `PetModelSnapshot` 复用 `scene/pet-scene.ts` 的导出（VRM 场景：morphNames = expression 名）。
- `VrmPetScene` 构造参数（`vrm/pet-scene-vrm.ts`）：
  `{ avatar: VrmAvatarAsset, motionSet: string, createPoseDriver?: VrmPoseDriverFactory, fpsCap? }`；
  `loadModel(url)` 里 url = `pet-asset://assets/<avatar.file>`，随后 `await createPoseDriver(...)`（可为 Promise）。
- 世界单位 = CSS px、正交相机、透明背景、像素预算/FPS 上限沿用 PetScene 的 `fps-limiter`/`pixel-ratio`
  小件（直接 import）；摆放语义与 `PetScene.placePet` 完全一致（`restHeightMeters` 替代 PMX bbox。
  `restFeetY` 一般 ≈0，摆放时扣掉）。
- **不做屏幕空间 OutlineEffect**：MToon 自带描边（材质 outlineWidth），V6 调参；`getRenderStats().outlinePx`
  返回 MToon 平均描边 CSS px（无描边返回 0；smoke 对 vrm 后端放宽断言）。

## 4. VRM 动画组合层（`vrm/animator.ts`，Lead）与共享接口（`vrm/runtime-types.ts`）

### 4.1 `VrmAvatar`（avatar-loader 产出）
`{ asset, vrm, scene, capabilities, restHeightMeters, restFeetY, bodyAspectRatio, hipsRestHeight,
   materialNames, expressionNames, textureCount, missingTextures, vertexCount, triangleCount, dispose() }`
- `bodyAspectRatio`：**躯干宽/身高**，不是 T-pose 臂展。用 normalized rest 的肩/髋骨世界坐标估算：
  `width ≈ max(|L upperArm.x − R upperArm.x|, 2×|hips.x − L upperLeg.x|×1.6) + 0.08×height`，
  clamp 到 [0.30, 0.90]；V5 实机截图可再调（影响命中区宽度/物理半宽）。
- VRM 0.x 用 `VRMUtils.rotateVRM0(vrm)` 归一化（canary 验证用）；是否 patch GLB 用
  `src/shared/vrm-glb.ts` 的 `patchVrmGlbJson`（旧戏浪副本需要，tpose 模型不需要：先尝试
  `GLTFLoader.parseAsync`，失败再走 patch 重试）。
- 贴图追踪：沿用 `createPetAssetLoadTracker()`（LoadingManager 派发 itemStart/End）+ 重试 loader。

### 4.2 `VrmClipPlayer`（clip-engine 产出，Lead 组合使用）
```ts
interface VrmClipPlayer {
  init(): Promise<void>                                  // 拉 app-manifest/catalog + 预载常用 clip
  readonly ready: boolean
  update(input: AnimationInput): void                    // 每帧：选 clip/推进/交叉淡入/写骨/贴地
  playClipById(id: string, opts?: {loop?: boolean; fadeSec?: number; hold?: boolean}): boolean
  setMoodOverride(mood: PetMood | null): void
  snapshot(): { clipId, slot, timeSec, weight, fading, playbackRate, bonesApplied,
                missingBones, footErrorPx, groundOffsetPx, ready, loadedClipCount }
  dispose(): void
}
```
- 选择规则：`input.events` 的 pat/poke/dragStart/… 优先一次性 clip（catalog），否则按 `input.mood`
  从 app-manifest 选（同 mood 多 clip：priority 高者 + 待机变体轮换）；clip 缺失 → 保持当前/静态。
- 交叉淡入：默认 0.2s smoothstep；对每根骨做短弧 slerp，Hips 位置线性插值。
- 每帧 `humanoid.update()` 由 player 负责（因为要测脚高/贴地）；animator 在 look-at 后再 update 一次。
- 失败降级：manifest/clip 缺失/坏 JSON 只 warn 一次，`ready=false`，不抛（app 仍渲染 T-pose）。

### 4.3 `app-catalog.json`（运行时扩展格式，clip-engine 定义并写进 README）
```jsonc
{ "version":1, "clips":[ { "id":"hideLeft", "set":"mate", "file":"mate/hideLeft.json",
   "loop":true, "duration":8, "tags":["hiding"], "mood":null } ] }
```

### 4.4 `vrm/animator.ts`（Lead）
`createVrmPetAnimator(options)` 返回 `PoseDriver & { ready(): Promise<void>; snapshot() }`：
1. 构造 clip-player（+ V6 的 expression-layer/look-at，若提供）；
2. `update(input)`：player.update → expressionLayer.update → lookAt.update → humanoid.update → vrm.update(dt)；
3. `getDebugSnapshot()` 映射到冻结的 `AnimationDebugSnapshot`：
   `pose=clipId??'none'`、`poseWeight`、`gesture`（一次性）、`blink/smile/mouthOpen`（V6）、
   `missingBones`、`footErrorPx`、`clipId/clipTimeSec/externalPlaybackRate`、`morphs`（V6）；
4. `setPose(id)` = `playClipById(id)`（未知返回 false）；`setGaze(yaw,pitch)` → V6 look-at override。
5. 红线：**不写 modelRoot 的 position/scale/rotation**（摆放/朝向归场景）；只写 normalized 骨与
   VrmAvatar（vrm.update 内部 spring）。

## 5. V1 验收（自动 + 证据）

1. `pnpm typecheck` 0 error；`pnpm test` 全绿（新增 clip-data/humanoid-map/avatar-pure/protocol 测试）。
2. `PET_MODEL_BACKEND=vrm PET_SMOKE_TEST=1 pnpm smoke`（改造成后端感知）：
   - `debug.ready`、`model.loaded`、humanoid ≥ 15 必需骨、clip 正在播放（`animation.clipId != null`）、
     `footErrorPx < 2`（站/走）、无 `errors` 新增、drawCalls/triangles>0、透明帧不透明像素达标、
     fps 受 capping、悬停拦截端到端通过；
   - 抓图 `tests/tmp/wave2/vrm-smoke-*.png` 作为证据（gitignore）。
3. `PET_MODEL_BACKEND=legacy-pmx ... pnpm smoke` 保持原有 PMX 断言全绿（回退不回归）。
4. 实机隔离：所有实机/冒烟命令使用**临时 HOME**（如 `/tmp/pet-dsh-home`）+ `PET_PROFILE=agent-e2e`，
   不碰真实 `~/.dsh`；如需真实 HOME 必须先备份并给出回滚脚本。

## 6. V4 legacy 隔离方案

- `git mv src/renderer/src/animation/*.ts src/renderer/src/animation/{external,poses,legacy?}` →
  `src/renderer/src/animation/legacy/**`（保留子目录结构）。
- `animation/index.ts` 改为 facade：对既有导出路径改指 `./legacy/...`；导出保持不变
  （`createHybridAnimator` 等），main.ts import 路径不变。
- 更新所有引用（`tests/animation-*.test.ts`、`tests/*.ts`、`scripts` 内 TS 引用）到新路径；
  `pnpm typecheck` + `pnpm test` 全绿。
- D9：legacy 保留到 W3 再决定删除。

## 7. 并行分工（本轮）

| 线 | 负责人 | 只写 |
|---|---|---|
| 设计/接口 + main 接线 + animator + smoke | Lead | `docs/wave2-vrm-runtime-design.md`、`src/renderer/src/vrm/runtime-types.ts`、`vrm/animator.ts`、`scene/pet-view.ts`、`main.ts`、`src/main/ipc/config.ts`、`src/main/index.ts`、`tests/*-vrm-e2e*` |
| protocol-assets | teammate | `src/main/protocol-path.ts`、`src/main/protocol.ts`、`tests/protocol-*.test.ts` |
| vrm-core | teammate | `src/renderer/src/vrm/avatar-loader.ts`、`vrm/pet-scene-vrm.ts`、`vrm/avatar-bounds.ts`、`vrm/humanoid-map.ts`（协同）、`tests/vrm-avatar-*.test.ts` |
| clip-engine | teammate | `src/renderer/src/vrm/clip-data.ts`、`vrm/clip-registry.ts`、`vrm/clip-player.ts`、`vrm/humanoid-map.ts`、`scripts/vrm/motion/build-app-manifest.mjs`、`tests/vrm-clip-*.test.ts` |
| legacy-move（V4） | teammate | `src/renderer/src/animation/legacy/**`、`animation/index.ts`、相关 import/测试路径 |
| V6 expression（V1 后） | teammate | `src/renderer/src/vrm/expression-layer.ts`、`vrm/look-at.ts`、材质/spring 调参、`tests/vrm-expression-*.test.ts` |
| V7 adaptation（V5 后） | teammate | `interaction/**`、`behavior/**`、`desktop/**`、`physics/**` 的 humanoid 适配 + 测试 |
| 证据/验收（V8） | teammate | `scripts/vrm/capture-app.mjs`、`docs/vrm-acceptance.md`、`tests/tmp/**` |

约束（沿用 PLAN §13）：只改自己 scope；不 `git commit`（Lead 统一提交）；不提交 `assets/**`/`refs/**`；
完成后必须 `pnpm typecheck` + 自己相关测试全绿；中文注释；不引新依赖（须先问 Lead）。
