# W0-3 冻结契约：VRM 模型 / 动画（humanoid clip）/ 配置扩展

> 状态：**W0-3 冻结（2026-11-08）**。Wave 1 起（V1–V4、V5–V8）不得擅改本文件涉及的
> `src/shared/` 契约；需要变更先向 Lead 提「契约变更请求」（PLAN §7/§8/§13）。
> 交付物：`src/shared/vrm.ts`、`src/shared/animation-contract.ts`、
> `src/shared/vrm-manifest.json`、`src/shared/motion-manifest.json`、`src/shared/types.ts` /
> `config.ts` 的扩展、`tests/vrm-contract.test.ts`、`tests/animation-contract.test.ts`。

## 0. 一页结论

| 契约 | 内容 | 冻结要点 |
|---|---|---|
| 模型资产 | `VrmAvatarAsset` + `VrmAssetManifest`（`vrm-manifest.json`） | `file` 是 assets 根相对路径或 `pet-asset://` URL；`heightMeters`（米）；`expressions` 业务名→VRM expression 名；`lookAt` mode=`vrm`/`procedural`/`none` |
| humanoid | `HUMANOID_BONES`（55 个 VRM 1.0 标准名）+ `VRM_REQUIRED_HUMANOID_BONES`（15 个必需） | 用 three-vrm **归一化后的 VRM 1.0 骨名**（VRM 0.x 的 `joy/blink_l` 等不进入契约） |
| 表情 | `VRM_EXPRESSION_PRESETS`（18）给资产能力诊断；`PET_EXPRESSIONS`（9）给业务语义 | 业务表情不含 viseme/注视通道；缺映射 = 不可用（跳过，不崩） |
| 动画 | `AnimationClipEntry` + `AnimationClipManifest`（`motion-manifest.json`） | 槽位 = `PetMood` 全集 + `salute`；同槽位多 clip 用 `priority`；文件缺失 = 回退 |
| 后端 flag | `ModelBackend` / `AnimationBackend`（`vrm` \| `legacy-pmx`） | 优先级 **env（`PET_MODEL_BACKEND`/`PET_ANIM_BACKEND`）> 配置 > 默认 `vrm`** |
| 配置 | `PetConfig` 新增 `modelBackend` / `animBackend` / `motionSet` | 三键**缺省可回填**，故 `CONFIG_VERSION` 仍为 1（旧 config.json 自动兼容） |

清洗函数（`sanitizeVrmAssetManifest` / `sanitizeAnimationClipManifest`）**永不抛异常**：
非法条目丢弃、数值越界钳制、重复 id 保留第一个，全部写入 `warnings`（供 loader 日志）。

## 1. 与 PLAN §8 的映射与有意偏差（Lead 决策）

PLAN §8 是「示意」，W0-3 冻结时做了 4 个明确决策：

1. **不把 `vrm`/`motions` 塞进 `src/shared/assets-manifest.json`**。
   该文件是 PMX 优化管线的**生成物**（`scripts/prepare-assets.mjs`），且
   `tests/assets-manifest.test.ts` 明确冻结「顶层键集合、schema 不扩展」。V4 之前 legacy PMX
   路径仍需它保持原样；VRM/motions 资产又是**私有/可选**的（`assets/vrm`/`assets/motions` gitignore，
   新 clone 可能没有）。因此 W0-3 采用**独立 manifest 家族**：
   `vrm-manifest.json`（模型注册表）+ `motion-manifest.json`（动作集）。
   `AssetsManifest` 契约（PMX 遗留）本 Wave **零改动**；V4 决定删/留 legacy 时再统一。
2. **`lookAtX/lookAtY` 不放进 `expressions`**（PLAN 示意里有）。VRM 的 lookAt 是独立扩展/骨骼驱动，
   不是 expression；契约改为独立的 `lookAt: { mode, maxYawDeg, maxPitchDeg }`。
   业务表情只保留 9 个真正走 expression 通道的语义。
3. **新增 `yawOffsetDeg` / `thumbnail` / `notes` / `VrmAvatarCapabilities`**。
   W0 实测两个现有 VRM 都**没有** `springBone`、也没有 `lookAt`；朝向也需实机验证（W0-4），
   因此给 manifest 留了按资产修正朝向的字段；capabilities 供调试面板/验收脚本判断「模型能做什么」。
4. **manifest 的 `file` 不是绝对路径/文件 URL**，而是 assets 根相对路径（如
   `vrm/canary/砂金石心十人公司制服(0.x).vrm`）或 `pet-asset://<host>/<path>`。
   这样契约层不做协议假设；V1 负责扩展 `pet-asset://`（新增 `vrm`/`motions` host 或根目录）
   并在 loader 里把相对路径转成可 fetch 的 URL。路径穿越在契约层先拒（`isSafeAssetReference`），
   协议 handler 的 realpath + `O_NOFOLLOW` 仍是最终安全边界（纵深防御）。

## 2. 文件与导出总览

### `src/shared/vrm.ts`

| 导出 | 说明 |
|---|---|
| `HUMANOID_BONES` / `HumanoidBone` | VRM 1.0 标准骨名全集（55：躯干/眼/颌/腿/肩臂手/30 指骨） |
| `VRM_REQUIRED_HUMANOID_BONES` | 规范必需核心骨（15：hips, spine, head, 双臂/双手/双腿/双脚） |
| `VRM_EXPRESSION_PRESETS` / `VrmExpressionPreset` | VRM 1.0 preset（18） |
| `PET_EXPRESSIONS` / `PetExpression` | 业务表情（9：blink/blinkLeft/blinkRight/happy/sad/angry/relaxed/surprised/neutral） |
| `VrmExpressionBindings` | `Partial<Record<PetExpression, string>>`；值 = VRM expression 名（preset 或自定义） |
| `VrmAvatarAsset` / `VrmAvatarAssetInput` | 归一化资产 / JSON 手写形状 |
| `VrmAssetManifest` / `VrmAssetManifestInput` / `EMPTY_VRM_ASSET_MANIFEST` | 模型注册表 |
| `KNOWN_AVATAR_IDS` | `{ aventurine: 'aventurine-waveflair', canary: 'canary-outfit' }` |
| `sanitizeVrmAssetManifest` | 清洗（**永不抛**） |
| `resolveAvatarAsset(manifest, id?)` | 显式 id > `defaultAvatarId` > 第一个；空 manifest → null |
| `isSafeAssetReference` / `isHumanoidBone` / `isPetExpression` / `isVrmExpressionPreset` | 纯校验 |
| `MODEL_BACKEND_ENV` / `parseModelBackend` / `resolveModelBackend` | 后端 flag（env > config > `vrm`） |
| `VrmAvatarCapabilities` | loader 实测能力（骨/表情/spring/lookAt/animations/height），纯数据 |
| （配套）`src/shared/vrm-glb.ts` | W0-5 追加：`patchVrmGltfJson` / `patchVrmGlbBuffer` —— 加载前修复 GLB 内非法 MToon 贴图引用（纯函数，V1 loader 使用） |
| `DEFAULT_VRM_LOOK_AT` | `{ mode:'procedural', maxYawDeg:35, maxPitchDeg:20 }` |

### `src/shared/animation-contract.ts`

| 导出 | 说明 |
|---|---|
| `ANIMATION_CLIP_MOODS` / `AnimationClipMood` | 槽位 = `PET_MOODS` + `salute`（13） |
| `ANIMATION_CLIP_DEFAULTS` | `{ loop:true, timeScale:1, fadeInSec:0.15, fadeOutSec:0.2, priority:0 }` |
| `ANIMATION_CLIP_TIME_SCALE_RANGE` / `ANIMATION_CLIP_FADE_RANGE` | timeScale [0.1,4]；fade [0,2] 秒 |
| `AnimationClipEntry` / `AnimationClipEntryInput` | clip 条目（`file` 同上；`rootMotion:'inPlace'\|null`；`priority`） |
| `AnimationClipManifest` / `AnimationClipManifestInput` / `EMPTY_ANIMATION_CLIP_MANIFEST` | 动作集 manifest |
| `sanitizeAnimationClipManifest` | 清洗（**永不抛**） |
| `findAnimationClip` / `hasAnimationClip` | mood 选择：priority 高者优先，同优先级取靠前者；无 → null（回退） |
| `DEFAULT_MOTION_SET_ID` / `MOTION_SET_ID_MAX_LENGTH` | `default` / 64 |
| `ANIMATION_BACKEND_ENV` / `parseAnimationBackend` / `resolveAnimationBackend` | 后端 flag（env > config > `vrm`） |

### `src/shared/vrm-manifest.json`（提交的默认注册表）

W0 阶段两个 avatar（**注意：canary 为默认**，V1 先用它验证管线，V5 接入戏浪后把
`defaultAvatarId` 切到 `aventurine-waveflair`——只改数据不改契约）：

| id | file | spec | height | 备注 |
|---|---|---|---|---|
| `canary-outfit` | `vrm/canary/砂金石心十人公司制服(0.x).vrm` | 0.x | 1.76 m | 用户下载的制服 canary；31 材质/13 贴图；rotateVRM0 后面向 **+Z**；有 VRM0 lookAt（Bone，`lookAt.mode='vrm'`）；无 springBone |
| `aventurine-waveflair` | `vrm/aventurine-tpose.vrm`（**W1.5-Tpose 重制**；旧 `waveflair`/`legfix` 只读保留回滚） | 1.0 | 1.73 m | PMX 源经 VRMify 转规范 **T-pose**（手臂水平/掌心向下/四指伸直/拇指 45°，详见 `docs/vrm-tpose-repair.md`）；53 humanoid 骨（含 30 手指 + toes）；39 MToon 材质 = 21 OPAQUE + 12 MASK + 6 BLEND（1 个 doubleSided）；**面向 +Z**（`yawOffsetDeg=0`）；SpringBone 50 链/175 collider；95 表情（含 sad/relaxed，无 neutral） |

两个条目的 `expressions` 都映射了 7 个业务表情
（`blink`/`blinkLeft`/`blinkRight`/`happy`/`angry`/`surprised`/`neutral`）。
注意：新版 aventurine（T-pose 重制）**有 `sad`/`relaxed`、没有 `neutral`**；canary（VRM0）只有 `joy`。
V6 接线时 `neutral` 应做缺省/fallback（或补 custom expression），不要当缺失报错。W0-4 会实测
three-vrm 归一化后的真实 preset 列表并回报（数据修正不改契约）。

### `src/shared/motion-manifest.json`（提交的默认动作集）

W0 阶段 `clips: []`（**空集 = 全部回退 legacy/程序化**，可独立跑通）。V3 产出 glTF/VRMA 后
按契约填充（文件缺失时 loader 跳过该 clip 并回退，不阻塞其它动作）。示意：

```json
{
  "schemaVersion": 1,
  "clips": [
    {
      "id": "idle-soft",
      "mood": "idle",
      "file": "motions/default/idle.glb",
      "loop": true,
      "timeScale": 1.0,
      "fadeInSec": 0.2,
      "fadeOutSec": 0.25,
      "rootMotion": "inPlace",
      "priority": 0
    },
    { "id": "salute-a", "mood": "salute", "file": "motions/default/salute.vrma", "loop": false }
  ]
}
```

> `motionSet` 配置选择动作集：运行时加载 `assets/motions/<motionSet>/manifest.json`；
> 缺失/非法时回退提交的默认 `motion-manifest.json`（空集）→ 再回退 legacy。

## 3. 配置扩展（`src/shared/types.ts` + `config.ts`）

```ts
// PetConfig 新增（DEFAULT_CONFIG）
modelBackend: 'vrm'   // 'vrm' | 'legacy-pmx'
animBackend: 'vrm'    // 'vrm' | 'legacy-pmx'
motionSet: 'default'  // 动作集 id：^[A-Za-z0-9_-][A-Za-z0-9._-]*$，≤64 字符
```

- `sanitizeConfig` 对三项做枚举/字符集校验，非法回退默认；`motionSet` trim 后校验
  （拒绝 `../`、`/`、`\`、空、超长、`.` 开头）。
- **`CONFIG_VERSION` 保持 1**：三项都是「缺失可回填」的追加字段，旧版 `config.json` 读入后
  `sanitizeConfig` 自动补默认值，不需要不兼容迁移；未来出现真正不兼容变更再递增。
- 后端 flag 解析实现放在各自契约模块（`resolveModelBackend` / `resolveAnimationBackend`），
  优先级 env > 配置 > 默认。**V1/V4 接线时必须使用这两个函数**，不要在别处重写优先级逻辑。

## 4. 消费方指引（Wave 1 起）

| 任务 | 要做 | 不要做 |
|---|---|---|
| **V1**（three-vrm 进 app） | 用 `sanitizeVrmAssetManifest` 读 manifest → `resolveAvatarAsset(manifest)`；扩展 `pet-asset://` 支持 `assets/vrm`（及后续 `assets/motions`）；加载后用 `VrmAvatarCapabilities` 填调试面；`resolveModelBackend(process.env.PET_MODEL_BACKEND, config.modelBackend)` 选后端 | 不要在别处硬编码 avatar 文件路径/height；不要改契约类型；不要动 `assets-manifest.json` |
| **V2**（PMX→VRM） | 产出资产后更新 `vrm-manifest.json` 条目（数据）；用 `VrmAvatarCapabilities` 记录 spring/lookAt/height | 不要新增契约字段（需要就先提请求） |
| **V3**（动作管线） | 填 `motion-manifest.json` + `assets/motions/<set>/manifest.json`；用 `findAnimationClip` 选 clip；缺失文件回退 | 不要改 `PetMood`/槽位；`salute` 已预留 |
| **V4**（legacy 隔离） | 用 `resolveAnimationBackend` / `resolveModelBackend` 切后端；legacy 代码移入 `animation/legacy/` | 不要删 `assets-manifest.json` 的冻结测试 |
| **V5**（戏浪接入） | 把 `defaultAvatarId` 切到 `aventurine-waveflair`（数据改动）；当前资产为规范 T-pose、面向 +Z，`yawOffsetDeg: 0`；clip 数据须用 `--axis x`（见 `docs/vrm-tpose-repair.md`） | 不要改 manifest schema |
| **V6**（材质/表情/spring） | 用 `expressions` 绑定驱动 `VRMExpressionManager`；`lookAt.mode=procedural` 时驱动 head/eye 骨；spring 由 three-vrm `VRMSpringBoneManager` 自动更新 | 不要把注视塞进 expressions |

## 5. 已知缺口（W0-4 已实测，2026-11-08）

证据：`tests/tmp/w0-4/`（两模型 3 视图截图 + 10s 录屏 + diagnostics/pixel-check + `report.md`，
gitignored）；逐项结论如下，均已回填 `vrm-manifest.json` 数据（契约类型未变）。

- **spring bone：两个资产都没有**。canary 的 VRM0 `secondaryAnimation` 扩展块存在但
  `boneGroups=[]/colliderGroups=[]`；戏浪没有 `VRMC_vrm.springBone`。→ V6 需要 Blender 补链
  （W0-2 的 VRM Add-on 可写 `VRMC_springBone`）或自研 additive 弹簧（legacy `animation/spring.ts` 可参考）。
- **lookAt：canary 有、戏浪没有**。canary 的 VRM 0.x 把 lookAt 放在
  `extensions.VRM.firstPerson.lookAtTypeName="Bone"`，three-vrm 归一化为 `VRMLookAtBoneApplier`
  → manifest `lookAt.mode='vrm'`（注意：VRM0 的 4 条 `LookAtDegreeMap` 是曲线，three-vrm 3.5.5 不支持，
  会 warn 并忽略，`offsetFromHeadBone=[0,0,0]`；角度上限用默认 35°/20°）。戏浪 `VRMC_vrm.lookAt` 缺失
  → `procedural`（V6 驱动 head/eye 骨）。
- **朝向**：canary（VRM0 + `VRMUtils.rotateVRM0`）面向 **+Z**（正确）；戏浪 VRM 1.0 文件面向 **-Z**
  （front 取景看到后脑、back 看到正脸）→ manifest 已设 `yawOffsetDeg=180`（V1 loader 必须应用该字段）。
- **表情绑定**：canary 的 `joy/blink_l/blink_r/a/i/u/e/o` → `happy/blinkLeft/blinkRight/aa/ih/ou/ee/oh`
  映射实测全部成立（`v0RenameProof.allRenamedCorrectly=true`）；canary 归一化后还有大写 `Surprised`
  与 `surprised` 并存（原资产命名问题，不影响 manifest 用小写 `surprised`）。
- **材质缺陷（戏浪，V5/V6 需修但非「发白」主因）**：39 个材质 = OPAQUE 10 + **BLEND 29**
  （其中 27 个 `baseColorFactor[3]≈1`；真半透明只有 `颜赤` alpha=0、`目影` alpha=0.3），39/39 `doubleSided=true`，
  且 29/29 BLEND 都带 `transparentWithZWrite:true`。机制：VRM 1.0 loader 按 glTF `alphaMode=BLEND` 设
  `transparent=true`，但 three-vrm 又因 `transparentWithZWrite` 强制 `depthWrite=true` 并设
  `renderOrder=19+`，于是 27 个本该不透明的材质被送进透明 pass，双面 + 39 个 outline clone（材质数 39→78）
  互相叠加、深度写入与透明排序竞争 → **局部 ghost/排序瑕疵**。
  W0-4 的 `?forceOpaque=1` 对比实测：命中 54 个材质、**仅 3.75% 像素变化、非透明区平均亮度 208.22→208.23
  （基本不变）** → force-opaque **不是整体发白的解**；发白主要来自资产贴图本身的白/淡青色调 + 光照
  （NoToneMapping，同光源 canary 亮度 121 vs 戏浪 211）。canary 的 22/31 BLEND 之所以不 ghost，是因为
  VRM0 兼容层按 `VRM.materialProperties.keywordMap._ALPHATEST_ON` 把 31/31 材质重推为 MASK。
  修复路径：V2 Blender 重导把 α≈1 材质设 OPAQUE / 关 `transparentWithZWrite`（保留颜赤/目影为 BLEND），
  V1/V6 可按「`transparent && opacity≥0.99` → force opaque」白名单兜底（viewer `setForceOpaque` 即原型），
  观感调优放 V6（贴图/光照/tone mapping）。
- **加载兼容性（戏浪，已做数据修复 + 代码防御）**：`珍珠` 材质的 `VRMC_materials_mtoon.shadeMultiplyTexture`
  是非法引用（`{}` 而非 texture index），直接 `GLTFLoader.parse` 会抛错。
  W1.5-Tpose 重制后当前资产 `assets/vrm/aventurine-tpose.vrm` 已无该非法引用（VRMify 输出干净，
  three-vrm 可直接加载、0 pre-parse patch）；W0-5 的两层修复保留给旧资产回滚：
  ① `scripts/vrm/patch-vrm-gltf.mjs` 生成 `assets/vrm/aventurine-waveflair.vrm`；
  ② `src/shared/vrm-glb.ts` 的 `patchVrmGlbBuffer` 纯函数，**V1 的 avatar loader 仍应在
  `GLTFLoader.parseAsync` 前调用它做内存防御**（防止未来替换资产再踩同类坑）。

## 6. 复跑

```bash
cd /Volumes/4TB外置盘/deepseek-harness/aventurine-pet-vrm
pnpm typecheck
npx vitest run tests/vrm-contract.test.ts tests/animation-contract.test.ts tests/shared-contract.test.ts
```


## 8. 追加契约（V6 表情层，2026-11-08，Lead 已批准）

> 本节为**加法式**契约扩展：不改 `vrm.ts` / `animation-contract.ts` 既有语义与字段，只新增文件。

| 文件 | 内容 |
|---|---|
| `src/shared/expression-contract.ts` | `ExpressionClip`（逐帧 VRM expression 权重轨道，0..1；loop=round(duration*fps)/non-loop=+1；可选 `fadeInSec/fadeOutSec`）+ `ExpressionClipManifest`（`assets/expressions/manifest.json` 消费形状）+ 清洗/采样/选择/绑定纯函数 + `VRM0_EXPRESSION_ALIASES`（joy→happy、fun→relaxed、neutral→null…）+ 口型映射（あいうえお→aa/ih/ou/ee/oh） |

- 数据仍遵守本文件 §1 的资产引用规则（`isSafeAssetReference`），并且**私有**（`assets/expressions/**` gitignore）。
- 运行时消费方：`src/renderer/src/vrm/expressions.ts`（V6）；细节/验收见 `docs/expression-mapping.md`。
- `src/shared/vrm-manifest.json` 数据修正：目标 `aventurine-waveflair` 补 `sad`/`relaxed` 绑定、移除
  无效的 `neutral` 绑定（目标模型无 neutral preset；W0-3 §2 已预留「V6 接线时缺省/fallback」的修正口径）。
