# B3 技术调研：程序化姿态库 + 表情系统 + 轻量次级运动

> 目标读者：B3 实现者、Lead（接线与验收）、B2（物理）/B4（交互）/B5（桌面感知）的对接人。
> 调研日期：2026-11-07。适用版本：Electron 44 + **three r171（精确 pin）** + `assets/model/星穹铁道—砂金·戏浪.pmx`。
> 调研方法：① 直接读 r171 `node_modules/three` 源码（`MMDLoader.js` / `MMDAnimationHelper.js` / `CCDIKSolver.js` / `Skeleton.js` / `WebGLObjects.js`）；② 用 `mmd-parser@1.1.4`（与 r171 MMDLoader 内 vendored parser 同源）**实测解析本模型 382 根骨骼**（产出 `tests/tmp/bones.json`）；③ 用纯数学脚本实测旋转轴符号；④ 外部资料仅作佐证（链接见 §8）。
> 本文件只描述方案，不改任何源码。文中「实测」= 本轮在本机对该 PMX / 该 three 版本跑出来的结论；「源码」= 指到 r171 具体文件/行。

---

## 目录

- [0. 一页结论（决策表）](#0-一页结论决策表)
- [1. 现状、约束与关键实测数据](#1-现状约束与关键实测数据)
- [2. MMD 骨骼在 three.js 中程序化摆放的正确姿势](#2-mmd-骨骼在-threejs-中程序化摆放的正确姿势)
  - [2.1 骨骼命名、索引与层级（实测）](#21-骨骼命名索引与层级实测)
  - [2.2 四条「特殊链」：肩P/肩C、捩骨、腰キャンセル、D 链](#22-四条特殊链肩p肩c捩骨腰キャンセルd-链)
  - [2.3 坐标系、旋转轴符号与单位（实测）](#23-坐标系旋转轴符号与单位实测)
  - [2.4 权重真相：腿和眼都不在「标准骨」上](#24-权重真相腿和眼都不在标准骨上)
  - [2.5 与 MMDAnimationHelper / IK / grant 的相互作用（源码级）](#25-与-mmdanimationhelper--ik--grant-的相互作用源码级)
  - [2.6 每帧正确调用顺序（B3 契约）](#26-每帧正确调用顺序b3-契约)
  - [2.7 站姿校正与脚底贴地](#27-站姿校正与脚底贴地)
  - [2.8 常见坑清单（含证据）](#28-常见坑清单含证据)
- [3. 姿态表示与混合：A / B / C 对比与推荐](#3-姿态表示与混合-a--b--c-对比与推荐)
- [4. 姿态作者工作流（含 VPD）](#4-姿态作者工作流含-vpd)
- [5. 表情系统](#5-表情系统)
- [6. 注视与次级运动](#6-注视与次级运动)
- [7. 验证与调试面](#7-验证与调试面)
- [8. 参考与出处](#8-参考与出处)
- [附录 A. 关键骨骼清单（B3 直接可用）](#附录-a-关键骨骼清单b3-直接可用)
- [附录 B. bones.json 与解析脚本](#附录-b-bonesjson-与解析脚本)
- [附录 C. 数值常量表](#附录-c-数值常量表)
- [附录 D. 风险登记（实现 B3 时最关键的 5 个）](#附录-d-风险登记实现-b3-时最关键的-5-个)

---

## 0. 一页结论（决策表）

| # | 决策点 | 结论 | 一句话理由 |
|---|---|---|---|
| D1 | 姿态表示/混合 | **方案 B：自研姿态表 + 分层权重混合**（pure TS，不建 `AnimationMixer`） | 需要「走路 + 摸头 + 呼吸 + 注视 + 眨眼」同时叠加；three 的 mixer 没有骨骼 mask，分层要靠拆 clip + 多 mixer，反而更复杂且不可单测 |
| D2 | 驱动哪些骨 | **只驱动「被蒙皮权重实际引用的骨」+ 少量控制骨**：`上半身/上半身2/首/頭/肩/腕/ひじ/手首/下半身/足D/ひざD/足首D/目先`（约 20 根），其余 360+ 根保持恒等 | 382 根全量混合是浪费；且腿/眼的**可见网格权重全在 D 骨与 目先 上**（§2.4），驱动标准骨看不到效果 |
| D3 | 与 `MMDAnimationHelper` 的关系 | **Wave 2 让 helper 保持「空转」**，B3 不依赖它；`helper.update` 无 mixer 时是 no-op（源码证据 §2.5）。B3 自带一个 26 骨的 **grant 最小实现**（可选） | 一旦给 helper 加 VMD，它会每帧 `_restoreBones` + IK + grant 覆盖我们的姿态；两套驱动源不能同时写同一批骨 |
| D4 | IK 足骨 | **不用 `CCDIKSolver`/不用 `足ＩＫ`**；腿走 **D 链 FK**，需要贴地时用 **解析二骨 IK（纯函数）** 或 **髋高补偿** | CCDIK 迭代 40×2 链、依赖上一帧、结果不可单测；D 链才是蒙皮骨，直接写它是确定性的 |
| D5 | 姿态作者工作流 | **主路线：TS/JSON 姿态表（以「度」书写、以骨骼名寻址）+ 姿态契约自检 + Electron 九宫格 contact sheet 截图回看**；**VPD 作为可选导入**（r171 原生支持 `loadVPD`+`helper.pose`，但本机无 PMXEditor/Blender） | 团队是 AI agent、无美术：必须让「改一个数字 → 30 秒后看到图」闭环，且姿态数据可 diff、可单测 |
| D6 | 表情 | 纯函数**表情调度器**（层：blink / emotion / viseme / material-morph），每帧输出 `Map<morphName, weight>`，再由 scene 写入 `morphTargetInfluences` | 调度逻辑与 three 解耦 → Node 里可单测；冲突（笑眼 vs 眨眼）在纯函数里显式裁决 |
| D7 | 眨眼 | 随机间隔 + 15% 双眨 + 与「笑眼」互斥降权（笑眼权重高时改眨「まばたき」而非「ウィンク」） | 本模型 22 个目 morph 里有 5 个是闭眼系，冲突真实存在（§5.2） |
| D8 | 注视 | **1 根骨**：`左目先/右目先`（直接写到眼球骨，等效 MMD `両目` 的 30% 增益）；头/颈只做 30% 的缓慢跟随 | 眼骨权重全在 `目先` 上（§2.4），写 `両目` 还得再跑 grant；写 `目先` 一步到位 |
| D9 | 次级运动 | **自研 verlet 弹簧 6 根骨**：`辮子1-2..1-5`（4 根）+ `辮子2-1`（1 根）+ `辮碎髮`（1 根）；**不引入 ammo.js / MMDPhysics**；衣摆不做 | 6 根骨 = 6 次积分/帧，CPU 可忽略；284 刚体 + 318 关节的 MMDPhysics 与「程序化姿态写同一批骨」直接冲突，且 ammo.js 包体 + 初始化成本高 |
| D10 | 新依赖 | **0 个**。不装 lil-gui、不装 ammo.js、不装 three-vrm | 姿态编辑用「JSON + 截图」就够；弹簧 30 行自写；阈值见 §7.3 |
| D11 | 单测 | 姿态数据合法性 / 混合权重 / 表情调度 / 状态映射 / 二骨 IK / 弹簧积分 全部做成**不 import three 的纯函数**（或只 import 纯数学类） | vitest 跑在 Node、无 DOM/WebGL；`three` 的数学类在 Node 可用，但为避免拖入渲染依赖，纯函数用 `{x,y,z,w}` 结构体 |
| D12 | 对外形状 | **完全按 Lead 冻结的 `src/renderer/src/core/wave2-contract.ts`**：入口 `update(input: AnimationInput)`，出口 `getAnimationSnapshot(): AnimationDebugSnapshot` + `debugSetPose(id)` | 契约已定义 B3 的输入/调试快照/一次性事件；B3 只填实现，不自造 API、不改契约文件（§1.3） |

---

## 1. 现状、约束与关键实测数据

### 1.1 A2 已经给了 B3 什么

`src/renderer/src/scene/pet-scene.ts`（592 行，已合入 main）：

- `MMDLoader` 载入 PMX，`this.helper.add(mesh, { physics: false })`（L453）。
- `step(nowMs)` 里：`helper.update(deltaSeconds)` → `materialMorphs.update()` → `idleMotion.update/apply` → `outlineEffect.render`（L488–L504）。
- `deltaSeconds` 已钳制到 `MAX_FRAME_DELTA_SECONDS = 0.1`（L92），B3 直接复用这个时间步。
- `setMorph(name, weight)`（L534）是唯一的表情入口，写 `mesh.morphTargetInfluences[i]`。
- `MaterialMorphController` 每帧从 `morphTargetInfluences` 读 `照れ/目影消/目影濃` 再改材质（`material-morphs.ts`）。
- `IdleMotion` 改的是 **`modelRoot`** 的 scale/rotation（脚底为支点），**不是骨骼**——B3 接管骨骼后它仍可共存（root 级呼吸 vs 骨骼级姿态，互不冲突），但要注意 `modelRoot.scale` 会缩放整个骨架，`IdleMotion` 的 ±0.4% 呼吸对「脚底贴地」无影响（支点在脚底），可以保留。

> **B3 的接入点**：`PetScene.step()` 中 `helper.update()` 之前（或替换掉它）。`PetScene` 由 Lead/A2 持有，B3 只提供 `AnimationSystem.update(dt)` 与 `attach(mesh, root)`。

### 1.2 模型实测数据（本轮亲自解析，与 PLAN 一致）

| 项 | 实测值 | 备注 |
|---|---|---|
| 顶点 / 三角 / 材质 | 32,966 / 51,829 / 39 | 与 PLAN 一致 |
| 骨骼 | **382**（layer0 348 / layer1 30 / layer2 4） | `transformationClass` 即 PMX 变形层级 |
| IK | **4 根**：`左足ＩＫ`(9) `右足ＩＫ`(6) `左つま先ＩＫ`(10) `右つま先ＩＫ`(7) | 变形层级 1 |
| IK 链 | `左足ＩＫ`→effector `左足首`，links = `左足`(83)、`左ひざ`(84，**限角**)，iteration **40**；`左つま先ＩＫ`→`左つま先`(86)，links=`左足首`(85)，iteration 3 | 右腿对称 |
| grant（付与） | **26 根** | 含 `肩C`(−1)、`腕捩1..3`(0.25/0.5/0.75)、`手捩1..3`、`腰キャンセル`(−1)、`目/目先`、`足D/ひざD/足首D`(=1) |
| morph | 85（82 顶点 + 3 材质） | 详见 `docs/model-morphs.md` |
| 刚体 / 关节 | 284 / 318 | Wave 2 不用（D9） |
| 包围盒 | Y: 0.008 → 21.689（**高 21.681 单位**）；X: ±7.99；Z: −2.37 → 1.98 | leftToRight 之后（与运行时一致） |
| 关键高度 | 踝 1.229 / 膝 6.784 / 髋 12.234 / センター 8.93 / 首 18.321 / 頭 19.244 | 模型单位 |
| 单位换算 | 540px 宠物：**1 单位 ≈ 24.9px**；324px 宠物：1 单位 ≈ 14.95px | `petHeightPx / 21.681` |
| 手臂 rest | 上臂 (2.223, −1.839, 0.025) 长 2.885；前臂 (2.043, −1.692, 0.198) 长 2.660；**下垂角 39.6°**，肘几乎伸直（夹角 3.8°） | 所以本模型是 **A-pose**，不是 T-pose |

> 这修正了任务书里「模型默认 A/T-pose」的说法：**实际是 A-pose（手臂下垂 39.6°）**。这很重要——自然站姿只需要再压 ~30°，而不是从水平压 70–80°，姿态作者的工作量大幅下降。

### 1.3 与 Lead 冻结契约的对齐（**开工必读**）

Lead 已在 Wave 2 开工前冻结 `src/renderer/src/core/wave2-contract.ts`（**只读，B3 不得修改**）。B3 的对外形状**已由它定义**，本文其余章节的方案都在这个形状内实现：

| 契约 | 形状 | B3 的义务 |
|---|---|---|
| `AnimationInput` | `{ dt, mood: PetMood, motion: MotionSnapshot, facing, lookTarget, petRect, viewportHeight, dragging, events: AnimationEvent[], bubbleText }` | 每帧 `update(input)` 消费；**不要**自己读鼠标/DOM/IPC（由 Lead 注入） |
| `AnimationEvent` | `pat` / `poke{region}` / `thrown{speed}` / `landed{impactSpeed}` / `dragStart` / `dragEnd` | 一次性表演（reaction/gesture）的触发源；同帧多个事件时按「thrown > landed > pat > poke」优先级排队 |
| `AnimationDebugSnapshot` | `{ pose, poseWeight, activeLayers, gesture, blink, smile, mouthOpen, lookYaw, missingBones, updateMs? }` | `getAnimationSnapshot()` 返回；`debugSetPose` 的返回值由 B3 提供 |
| `PetMood` | `idle / walk / climb / sit / sleep / drag / fall / pat / grabWindow / dshBusy / dshDone / dshError` | 姿态 id 的**语义来源**；`BehaviorDecision.poseHint?` 可细化（如 `'idle:coin'`） |

**因此本文的命名统一为**（与契约示例一致）：`stand`（mood=idle 的基础站姿）、`walk`、`climb`、`sit`、`sitEdge`（坐窗口上沿）、`sleep`、`pat`、`drag`、`fall`、`land`、`celebrate`、`grabWindow`、`dshBusy/dshDone/dshError`（反应层，不换基础姿态）。
`missingBones` 正是 §2.4/附录 A.6 的「姿态里引用了模型没有的骨」自检输出——**这个字段必须实现**，它是 R1 风险的唯一自动化防线。

**契约缺口（需要向 Lead 提「契约变更请求」，不要自己改文件）**：
1. 没有「脚底误差」字段 → 想把「贴地」纳入冒烟断言，需要在 `AnimationDebugSnapshot` 加 `footErrorPx?: number`。
2. 没有「表情非零权重明细」→ 冒烟只能断言 `smile/blink` 两个标量；要验证 `照れ/星目` 等需要 `morphs?: Record<string, number>`。
3. `debugSetPose(poseId)` 已够用；若要做 contact sheet 批量出图，建议再加 `debugSetMorph(name, weight)`（`setMorph` 已存在，可复用）。

---

## 2. MMD 骨骼在 three.js 中程序化摆放的正确姿势

### 2.1 骨骼命名、索引与层级（实测）

- **命名**：r171 `MMDLoader` 把 PMX 的日文骨名原样写进 `bone.name`（`initBones()`：`bone.name = gbone.name`，`MMDLoader.js` L508）。`englishName` 不参与命名（本模型多数为空）。**中文环境下没有本地化，代码里写 `'左ひじ'`（半角 `ひじ`）**——注意不是「左肘」。`足ＩＫ` 的 `ＩＫ` 是**全角**字符（U+FF29 U+FF2B），`左足ＩＫ` ≠ `左足IK`，复制粘贴时最容易错。
- **索引**：`mesh.skeleton.bones[i]` **严格等于 PMX 的骨骼索引 i**（`MMDLoader` 按文件顺序 push，不排序；`skinIndex` 也直接用 PMX 索引）。附录 A 的索引可直接当 `bones[i]` 用。**但不要硬编码索引**——用 `name → index` 建一次 Map（`createBoneLookup`），索引只用于调试/断言。
- **重名**：本模型有 **1 组重名**——`后碎髮9` 同时是 `bones[156]` 与 `bones[167]`（都是 `頭` 的子骨，头发）。`createBoneLookup` 必须定义策略（建议「首个命中 + `console.warn` 一次」），否则 `Map` 后写覆盖前者，行为随实现而变。B3 受控骨集合内**无重名**。
- **层级主干**（实测）：

```
全ての親(1)
└─ センター(2)            ← 平移 = 整体上下/左右位移；旋转 = 整体转向
   └─ グルーブ(3)         ← 「groove」= 整体节奏位移（MMD 惯例）
      └─ 腰(4)            ← 上半身+下半身共同的父；旋转会同时影响两者
         ├─ 上半身(12) → 上半身1(13) → 上半身2(14) → 首(15) → 頭(16)
         │                                   ├─ 右肩P(17) → 右肩(18) → 右肩C(19) → 右腕(20) → 右腕捩(21) → 右ひじ(25) → 右手捩(26) → 右手首(30)
         │                                   └─ 左肩P(47) → 左肩(48) → 左肩C(49) → 左腕(50) → 左腕捩(51) → 左ひじ(55) → 左手捩(56) → 左手首(60)
         └─ 下半身(11)
            ├─ 腰キャンセル右(77) → 右足(78) → 右ひざ(79) → 右足首(80) → 右つま先(81)   [IK 链，0 权重]
            │                    └─ 右足D(99) → 右ひざD(100) → 右足首D(101) → 右足先EX(102)  [蒙皮链]
            └─ 腰キャンセル左(82) → 左足(83) → 左ひざ(84) → 左足首(85) → 左つま先(86)
                                 └─ 左足D(103) → 左ひざD(104) → 左足首D(105) → 左足先EX(106)
足ＩＫ 族：
全ての親 → 右足IK親(5) → 右足ＩＫ(6) → 右つま先ＩＫ(7)      （左 8/9/10）
頭 → 両目(91) → 両目先(92)；頭 → 右目(87) → 右目先(88)；頭 → 左目(89) → 左目先(90)
```

### 2.2 四条「特殊链」：肩P/肩C、捩骨、腰キャンセル、D 链

这四条是 MMD 骨架的「约定俗成技巧」，不理解就会遇到「我明明转了骨，网格没动/动反了」。

| 链 | 结构 | grant 语义 | B3 怎么用 |
|---|---|---|---|
| **肩 P / 肩 C** | `肩P` → `肩` → `肩C` → `腕` | `肩C` 复制 `肩P` 的旋转 **ratio = −1**（源码 `addGrantRotation`：`slerp(identity, q, −1)`） | 转 `肩P` → 只有肩部网格动、手臂**反向抵消**（耸肩不抬臂）；转 `肩` → 手臂跟着摆。**B3 只写 `肩`**，不写 `肩P` |
| **捩骨（ねじれ）** | `腕` → `腕捩` → `ひじ`；`ひじ` → `手捩` → `手首`；另有 `腕捩1..3` / `手捩1..3` 用 0.25/0.5/0.75 分摊扭转 | 把「前臂扭转」均匀摊到 3 根中间骨，避免蒙皮拧成麻花 | **B3 只写 `腕`/`ひじ`/`手首`**，`捩`/`捩1..3` 全部保持恒等；这样等价于「无扭转」的干净姿态 |
| **腰キャンセル** | `下半身` → `腰キャンセル左/右` → 腿链 | 复制 `腰` 的旋转 **ratio = −1**，抵消腰对腿的影响 | **B3 不写 `腰`**（改用 `上半身`/`下半身`），所以 `腰キャンセル` 恒等，腿不会被腰带着转 |
| **D 链** | `足D/ひざD/足首D`（layer1）复制 `足/ひざ/足首` 的旋转 **ratio = 1**，parent 是 `腰キャンセル` | 给物理/IK 用的「影子骨」，**蒙皮权重全在 D 链**（§2.4） | **B3 直接写 D 链**（跳过 IK+grant），或在跑 grant 的路径里写 `足/ひざ/足首` 让 D 链跟随 |

### 2.3 坐标系、旋转轴符号与单位（实测）

**转换发生在 parser 层，不在渲染层**：`MMDLoader` 调 `parser.parsePmx(buffer, true)`（`MMDLoader.js` L159/L285），`true` = `leftToRight`。`mmd-parser` 的实现（`DataCreationHelper`）：

- 位置：`v[2] = -v[2]`（z 取反）
- 四元数：`q[0] = -q[0]; q[1] = -q[1]`（x、y 取反，z/w 不变）——数学上等于「绕 z 轴镜像」对旋转的正确变换（`R' = M R M`，轴 `(x,y,z) → (−x,−y,z)`，角度不变）
- 三角面：`p[0] ⇄ p[2]`（翻绕序，保持正面朝外）

结果：**模型从 MMD 的「−Z 朝前 / 左手系」变成 three 的「+Z 朝前 / 右手系」**。实测佐证：`左足ＩＫ` z = +1.939（脚趾朝 +Z）、`左腕` x = +1.984（角色左臂在 +X）。相机在 +Z 看 −Z，所以模型正对相机。

**骨骼局部轴 = 世界轴**：PMX 骨骼没有 rest rotation（`bone.quaternion` 初始化恒等），所以每根骨在静止时的局部轴与模型世界轴对齐：

| 轴 | 指向 | 正角旋转的效果（右手法则） | 实测佐证 |
|---|---|---|---|
| **+X** | 角色**左**（看屏幕的右） | 绕 X 正转：`+Y` 倒向 `+Z` → **前倾/低头**；对腿（指向 −Y）→ 膝/脚**向后**（−Z） | 足 绕 X +0.3 → 膝偏移 z 从 −0.015 变 **−1.62**（向后）✔ |
| **+Y** | 上 | 绕 Y 正转：`+Z` 倒向 `+X` → **转向角色左侧**（yaw 左） | 足 绕 Y +0.3 → 膝几乎不动（腿近竖直，符合） |
| **+Z** | 前（朝相机） | 绕 Z 正转：`+X` 倒向 `+Y` → **脊柱向角色右侧弯**；对左臂（指向 +X）正转 = **抬臂**，负转 = **落臂** | 左腕 绕 Z **−0.4** → 肘从 (2.22, −1.84) 变 (1.33, −2.56)（下垂）✔ |

**姿态作者必须记住的三句话**：
1. **腿向前摆 = 绕 X 负角**；腿向外张 = 左腿绕 Z 正角、右腿绕 Z 负角。
2. **手臂放下 = 左臂绕 Z 负角、右臂绕 Z 正角**；手臂前摆 = 绕 X 负角（两臂相同）。
3. **低头 = 绕 X 正角**；转头看角色左侧 = 绕 Y 正角。

> ⚠️ 这三条只在「父骨未旋转」时成立。一旦父骨（如 `腕`）转了，`ひじ` 的局部轴跟着转，「前臂再弯 30°」在数值上就不再是绕 X −30°。**这就是为什么姿态必须用工具/截图回看，而不能纯手算**（→ §4 工作流）。

**单位**：骨骼位置、`センター` 平移都是 **模型单位**（本模型 21.681 单位高）。540px 宠物下 **1 单位 = 24.9 CSS px**；一个自然的下蹲 5cm ≈ 0.62 单位 ≈ 15px。别把米/厘米直接写进姿态表，用「模型单位」或「相对身高比例」。

### 2.4 权重真相：腿和眼都不在「标准骨」上

本轮对 32,966 个顶点做了逐骨权重统计（`skinIndices` + `skinWeights`），结论**颠覆直觉**：

| 骨 | 权重和 | 主权重顶点数 | 结论 |
|---|---:|---:|---|
| `頭`(16) | 6,493 | 6,378 | 头部网格 |
| `下半身`(11) | 1,766 | 1,855 | 躯干下 |
| `上半身2`(14) | 1,556 | 1,227 | 躯干上 |
| **`左足D`(103) / `右足D`(99)** | 498 / 446 | 428 / 386 | 大腿 |
| **`左ひざD`(104) / `右ひざD`(100)** | 256 / 518 | 235 / 500 | 小腿 |
| **`左足首D`(105) / `右足首D`(101)** | 929 / 932 | 944 / 944 | 脚/鞋（最大单一部位） |
| **`左足先EX`(106) / `右足先EX`(102)** | 387 / 387 | 399 / 399 | 脚尖鞋尖 |
| **`左足`(83) / `左ひざ`(84) / `左足首`(85) / `左つま先`(86)** | **0 / 0 / 0 / 0** | 0 | **IK 链完全无蒙皮** |
| **`左目先`(90) / `右目先`(88)** | 502 / 502 | 502 / 502 | 眼球（全部） |
| **`左目`(89) / `右目`(87) / `両目`(91)** | **0 / 0 / 0** | 0 | **眼控骨无蒙皮** |
| `左腕`(50) / `左腕捩`(51) / `左ひじ`(55) / `左手首`(60) | 518 / 148 / 247 / 192 | 563 / 88 / 299 / 159 | 手臂（捩骨有真实权重！） |
| `左袖帶1-1`(212) | 360 | 358 | 左袖（大摆袖，最显眼） |
| `辮子1-2`(202) | 239 | 149 | 辫子 |

**推论（B3 的架构就此定型）**：
1. **摆 `足/ひざ/足首` 不会让腿动一分一毫**——除非同时跑 grant 把旋转抄到 D 链。
2. **摆 `目/両目` 不会让眼动**——眼球网格在 `目先` 上，且 `目先` 只拿 `目` 的 **−0.7** 倍。所以 `両目` 转 θ ⇒ 眼球实际只转 **θ − 0.7θ = 0.3θ**（这就是模型的「眼部减速」设计）。**B3 直接写 `目先` 最省事**（D8）。
3. **不写 `腕捩` 会丢掉 148 的权重**（前臂扭转形变），但自然站姿不需要扭转，忽略即可；将来要「手臂内旋」再加。
4. `足先EX`（脚尖 399 顶点）是**鞋尖**，`足首D` 绕 X 转动会带着它，脚尖单独上翘需要写 `足先EX`。

### 2.5 与 MMDAnimationHelper / IK / grant 的相互作用（源码级）

以下全部有源码行号（r171），可直接复核：

| 事实 | 证据 | 对 B3 的含义 |
|---|---|---|
| **没有 animation 时 `helper.update(dt)` 是彻底的空操作** | `_animateMesh()` 全文包在 `if (mixer && this.enabled.animation) { ... ik/grant ... }` 里（`MMDAnimationHelper.js` L518–L567）；`_addMesh` 只在 `params.animation !== undefined` 时建 mixer（L440+） | PLAN §18.2「无 VMD 时 helper.update 会跑 IK/grant」**不准确**。B3 可以放心先挂 helper，它不会覆盖任何东西 |
| **一旦加了 VMD，helper 每帧会覆盖所有骨** | mixer 路径：`_restoreBones(mesh)` → `mixer.update(delta)` → `_saveBones(mesh)` → IK → grant（L536–L566） | 将来接 VMD 必须**停掉 B3 的骨骼写入**（互斥开关，不能混跑） |
| **`helper.update()` 不调 `mesh.pose()`** | 只有 `helper.pose()`（L185）第一行 `mesh.pose()`（默认 `resetPose:true`） | 手动摆骨后不要指望 helper 帮你归零；归零要自己 `skeleton.pose()` |
| **`helper.pose(mesh, vpd)` 是现成的 VPD 应用器** | L185–L241：`mesh.pose()` → 按**骨名**查表 → `bone.position.add(translation)` + `bone.quaternion.multiply(q)` → `mesh.updateMatrixWorld(true)` → 新建 CCDIK + GrantSolver 并 update | VPD 导入几乎零成本；但注意它是 **multiply**（叠加在 rest 上）且**每次都会重置** |
| **grant 是「乘算」，不幂等** | `GrantSolver.addGrantRotation()`：`_q.slerp(identity, parentQuat, ratio); bone.quaternion.multiply(_q)`（L1197–L1205）；`updateOne` 不做任何重置 | **同一帧跑两次 grant = 转两倍**。自研 grant 必须每帧先把 grant 骨重置为恒等，或只跑一次 |
| **CCDIK 依赖 `matrixWorld`，且每帧从上一帧结果继续** | `CCDIKSolver.updateOne()` 用 `link.matrixWorld`/`effector.matrixWorld`（L101/L124），迭代 `iteration`（本模型 40）次 | 结果**不是**「目标位置的纯函数」；换帧率/跳帧会漂。不适合确定性单测 |
| **`Skeleton.pose()` 恢复到 bind pose（位置+旋转+缩放）** | `Skeleton.js` L84–L124：从 `boneInverses` 反推 `matrixWorld`，再 decompose 回 `position/quaternion/scale` | 这是 B3「归零」的正确 API；比手动遍历 382 根骨写 identity 更可靠（也恢复了骨骼位置） |
| **`skeleton.update()` 由渲染器自动调** | `WebGLObjects.js` L52 `skeleton.update()`（渲染时）；`SkinnedMesh.updateMatrixWorld` 只更新 `bindMatrixInverse`（`SkinnedMesh.js` L203–L214） | 写完骨**不需要**手动 `skeleton.update()`；但**读世界坐标前**必须 `mesh.updateMatrixWorld(true)`（或自己 FK 算） |
| **`SkinnedMesh.bind()` 只在初始化时用** | `bind()` 会 `skeleton.calculateInverses()` 并覆盖 `bindMatrix`（L150–L167） | **B3 绝对不要调 `bind()`/`bindMode`**；`MMDLoader` 已完成绑定 |

**三种可选驱动路径（B3 只能选一种）**：

| 路径 | 写法 | 代价 | 何时用 |
|---|---|---|---|
| **P1 直写 D 链（推荐）** | `足D/ひざD/足首D + 上半身/…`，不碰 IK、不跑 grant | 0 求解器；确定性 | Wave 2 全部姿态 |
| P2 IK 驱动 | 写 `足ＩＫ`/`つま先ＩＫ` 的 `position`，跑 `CCDIKSolver`，再跑 grant 抄到 D 链 | 40 迭代 ×2 链 ×2 腿 + 26 骨 grant；非确定性 | 将来要「真实接地/被推」 |
| P3 VMD | 交给 helper（mixer + IK + grant） | B3 停写 | B8 外部动画 |

### 2.6 每帧正确调用顺序（B3 契约）

```ts
// 由 PetScene.step(deltaSeconds) 调用，顺序不可颠倒
function updateAnimation(input: AnimationInput): void {
  // 0) 计时开始（写进 snapshot.updateMs，性能诊断）
  // 1) 时间/状态推进（纯数据，不碰 three）
  const frame = mixers.tick(input)             // input: AnimationInput（契约）→ 姿态权重/表情/注视/弹簧目标

  // 2) 姿态层 → 每根受控骨的目标四元数（局部偏移，相对 bind pose）
  const pose = blendPose(frame.poseWeights)     // 纯函数：Record<boneName, Quat>
  const look = computeLookAt(frame.gaze)        // 纯函数 → 目先 四元数
  const spring = springs.step(dtSeconds)        // verlet → 6 根发骨四元数

  // 3) 写骨（只写受控骨；其余永不动）
  for (const [boneName, q] of pose) bones[boneName].quaternion.copy(q)
  bones['左目先'].quaternion.copy(look); bones['右目先'].quaternion.copy(look)
  for (const s of spring.chains) s.writeTo(bones)

  // 4) grant 最小实现（只有用到 腰/肩P/両目/标准腿 时才需要；P1 路径可省）
  applyGrants(bones, GRANTS)   // 先重置 grant 骨 → 再 multiply(slerp(id,parent,ratio))

  // 5) 让世界矩阵生效（供同帧的贴地/注视/弹簧读世界坐标；渲染器本来也会做）
  mesh.updateMatrixWorld(true)

  // 6) 表情：纯调度器输出 morph 权重 → 写入 influences（必须在 materialMorphs.update 之前）
  for (const [name, w] of frame.morphs) mesh.morphTargetInfluences![indexOf(name)] = w
  // 7) 材质 morph 由 MaterialMorphController 在随后读 influences（A2 已有）
}
```

要点：
- **不要**在 step 里调 `skeleton.pose()`（会重置所有骨，包括弹簧）；只在「切到新姿态前需要干净基线」或「调试重置」时调一次。
- **不要**调 `helper.update()` 与自研系统同时写骨。Wave 2 可以让 `helper.update(dt)` 留一行（no-op），但**一旦 B3 上线，建议 PetScene 删掉/短路它**，避免将来误加 VMD 时双重驱动。
- `mesh.updateMatrixWorld(true)` 每帧一次（382 矩阵），成本 < 0.1ms，可接受；只在「需要读世界坐标」的帧需要（贴地/注视/弹簧）。纯 FK 姿态帧可省略，让渲染器统一做。

### 2.7 站姿校正与脚底贴地

#### 2.7.1 A-pose → 自然站姿

实测 rest：上臂下垂 **39.6°**，肘角仅 **3.8°**（几乎直臂）。目标站姿（参考 Mate-Engine 的 `PET_IDLE` 观感、以及 540px 桌宠的观感）：

| 骨 | 目标角（相对 rest） | 说明 |
|---|---|---|
| `左腕` | Z **−0.42 rad (−24°)**，X **−0.05**，Y **+0.06** | 上臂压到 ~64° 下垂；Y 让手臂略向前内收 |
| `右腕` | Z **+0.42**，X **−0.05**，Y **−0.06** | 镜像（Z、Y 取反） |
| `左ひじ` | **局部** X **−0.12 rad (−7°)**；Y +0.04 | 肘微屈，避免「木棍臂」；注意这是**在已旋转的腕局部系**里 |
| `左手首` | Z **−0.10**，X **+0.10** | 手腕自然内旋、微微内扣 |
| `左肩` | Z **−0.03**（下沉一点点） | 肩线放松 |
| `上半身`/`上半身2` | X **+0.02** / X **−0.01** | 极轻微挺胸（抵消 A-pose 的僵硬） |
| `首`/`頭` | X **−0.03** / X **+0.01** | 下巴微收 |

> 这些数只是**起点**，必须靠 §4 的截图回环调。但方向已由 §2.3 的符号表锁定，不会出现「越调越歪」。

**关于 rest 姿态的另一个坑**：模型 rest 的**手指**是张开的（`左人指１` 等有 171+ 权重）。桌宠尺度（脸 30–50px）下手指不可辨，**Wave 2 不摆手指**；若要「握拳/比心」再说（每只手 5 指 × 3 节 × 2 = 30 根，代价大、收益低）。

#### 2.7.2 脚底贴地：四种方案对比（推荐 ②+① 组合）

前提数据：rest 踝高 **1.229 单位**（≈30.6px @540）；膝 6.784；髋 12.234；大腿长 5.453、小腿长 5.557；地面 y≈0.008。

| 方案 | 做法 | 精度 | 成本 | 确定性/可单测 | 结论 |
|---|---|---|---|---|---|
| ① **髋高补偿** | 算两脚「支撑脚」的最低点抬升量 `dy`，把 `センター.position.y -= dy` | 中（脚**位置**对，但脚**朝向**不随之调整，蹲深了脚会「斜插」） | O(1) | ✅ 纯函数 | **必做**（所有方案的兜底层） |
| ② **解析二骨 IK** | 给定踝目标（世界/模型坐标），用余弦定理求髋、膝的 X 角；膝盖 pole 朝 +Z | 高（脚精确落在目标点，膝弯方向可控） | O(1)，每腿 ~20 行 | ✅ 纯函数（输入输出都是 `{x,y,z}`） | **推荐主方案**（站/坐/蹲/走支撑相） |
| ③ **CCDIK（`足ＩＫ`）** | 写 IK 目标位置 → `CCDIKSolver.update()` → grant 到 D 链 | 高 | 40×2×2 迭代 + 26 骨 grant + 每帧 `matrixWorld` | ❌ 迭代、依赖上一帧 | 不用（P2 备选） |
| ④ **包围盒回溯** | 每次姿态后算蒙皮包围盒（`computeBoundingBox` 对 morph 有坑，见 pet-scene L422 注释），整体上移 | 低（包围盒含头发/衣摆，最低点未必是脚） | O(n) 顶点 | 半 | **不用** |

**推荐实现（①+②）**：

```ts
// animation/leg-ik.ts —— 纯函数，不 import three
export interface Vec3 { x: number; y: number; z: number }

/** 二骨 IK：已知髋关节世界位置、踝目标、骨长，求髋/膝绕 X 的角（矢状面近似）。 */
export function solveLegSagittal(
  hip: Vec3, ankleTarget: Vec3, thighLen: number, shinLen: number
): { hipPitch: number; kneePitch: number } {
  const dy = hip.y - ankleTarget.y
  const dz = ankleTarget.z - hip.z
  const dist = Math.hypot(dy, dz)
  const d = Math.min(Math.max(dist, 1e-4), thighLen + shinLen - 1e-4)
  // 余弦定理：膝内角 → 膝屈曲（负 = 向后弯，MMD 腿的膝盖朝前，屈曲是绕 X 正/负见 §2.3）
  const cosKnee = (thighLen ** 2 + shinLen ** 2 - d ** 2) / (2 * thighLen * shinLen)
  const kneeFlex = Math.PI - Math.acos(Math.min(1, Math.max(-1, cosKnee)))
  const cosA = (thighLen ** 2 + d ** 2 - shinLen ** 2) / (2 * thighLen * d)
  const a = Math.acos(Math.min(1, Math.max(-1, cosA)))
  const base = Math.atan2(dz, dy)          // 髋→踝 相对「正下方」的偏角
  return { hipPitch: -(base + a), kneePitch: kneeFlex }  // 具体符号在实机用 1 个姿态校准
}
```

> 符号必须**实机校准一次**（用 `足D` 绕 X 转 ±0.2 看膝往哪走）。校准后用单测锁死（`solveLegSagittal` 的输入输出是纯数学，可断言 `dist ≈ 目标距离`、`kneeFlex ∈ [0, π]`、退化输入不 NaN）。
>
> **注意**：D 链的父是 `腰キャンセル`，其世界朝向 ≈ 模型世界朝向（因为 B3 不写 `腰`）。所以「世界角 ≈ 局部角」在本模型成立——这是选 D 链 FK 的又一好处。

**配套的「脚掌贴平」**：脚踝绕 X 的补偿角 = `-(hipPitch + kneePitch)`，让鞋底保持水平；再乘一个 0.7 的软系数避免脚背反折。

#### 2.7.3 「支撑脚」判定

- 站/坐/蹲：两脚都算支撑 → `dy = max(左dy, 右dy)`（谁被抬得高就用谁，保证不穿地）。
- 走/爬：抬脚相（`footLift > 0`）不进 `dy` 计算；支撑相进。
- 从「站着」到「坐着」的过渡：`dy` 用 `smoothstep` 渐入渐出，不要突变（否则脚会弹一下）。

### 2.8 常见坑清单（含证据）

| # | 坑 | 现象 | 证据 | 规避 |
|---|---|---|---|---|
| K1 | 摆 `足/ひざ/足首` 腿不动 | 姿态里腿完全没反应 | 这三根骨权重 = **0**（§2.4 实测） | 写 D 链 `足D/ひざD/足首D` |
| K2 | 摆 `目/両目` 眼不动 | 眼球纹丝不动 | 眼骨权重 = 0，眼球在 `目先`（§2.4） | 写 `左目先/右目先` |
| K3 | 加了 VMD 后程序化姿态「抽搐」 | 每帧被 mixer 覆盖/叠加 | `_animateMesh` 先 `_restoreBones` 再 mixer（L536） | 互斥开关；B3 停写 |
| K4 | 自己跑 grant 越跑越歪 | 骨旋转累积放大 | `addGrantRotation` 是 `multiply`，不重置（L1197） | 每帧先 `quaternion.identity()` 再 grant，或全程不碰 grant 骨 |
| K5 | 以为 `helper.update` 在跑 IK | 改了 IK 目标没反应 | 无 mixer 时 `_animateMesh` 整段跳过（L518） | 别依赖 helper；要么自己调 `CCDIKSolver` |
| K6 | 在 `step()` 里调 `mesh.pose()` | 所有骨（含弹簧/表情）被重置 | `Skeleton.pose()` 恢复 bind pose（L84） | 只在显式 reset 时调 |
| K7 | 手动改 `bone.position` 摆姿态 | 骨骼错位、蒙皮撕裂 | MMD 骨骼位置是 bind 数据，姿态只该改 rotation | 只写 `quaternion`（`センター` 平移除外） |
| K8 | 用 `computeBoundingBox()` 做贴地 | 最低点是头发/衣摆 | r171 会把 85 个 morph 并入包围盒（pet-scene L422 注释） | 用踝/趾骨世界坐标算 |
| K9 | 全角/半角骨名不匹配 | `bones['左足IK']` undefined | 模型里是 `左足ＩＫ`（全角） | 建 name→bone Map + 启动时断言附录 A.6 的关键骨存在，缺失即 `errors.push` |
| K9b | 骨名重名 | Map 后写覆盖前者，姿态写到错的骨 | 实测 `后碎髮9` = `bones[156]` 与 `bones[167]` | lookup 用「首个命中 + warn」；B3 受控骨无重名 |
| K10 | 30fps 下用 rAF 的 dt 直接积分弹簧 | 掉帧时弹簧爆炸/抖动 | `MAX_FRAME_DELTA_SECONDS=0.1` 已有，但弹簧还要子步 | 弹簧内部固定子步 `1/120s`，一帧最多 4 步 |
| K11 | 姿态之间直接 `copy` 四元数 | 转身瞬间「啪」一下 | 无插值 | 所有姿态切换走 `slerp` + easing（§3） |
| K12 | 四元数符号翻转导致「转远路」 | 过渡时手臂绕大圈 | `q` 与 `−q` 是同一朝向 | slerp 前统一半球：`if (dot<0) negate`（§3 代码里做了） |
| K13 | 直接改 `material.opacity` 做表情 | 与 `MaterialMorphController` 每帧重算打架 | A2 每帧按 baseline 重算（`material-morphs.ts`） | 表情只写 `morphTargetInfluences`，材质交给 A2 控制器 |
| K14 | 表情 morph 同时开两组 | 嘴型/眉毛互相拉扯变形 | MMD 表情是加算权重（`docs/model-morphs.md`） | 状态机保证同组互斥 + 归一化（§5.3） |

---

## 3. 姿态表示与混合：A / B / C 对比与推荐

### 3.1 需求拆解（决定选型的真正约束）

一个桌宠同时要叠加的层（缺一不可）：

1. **基础姿态层**：站/走/爬/坐/睡/被摸/被甩/注视/庆祝 —— 互斥，带过渡。
2. **呼吸/微动层**：正弦，幅度极小，**additive**。
3. **注视层**：头/颈/眼跟随鼠标，**additive 且带角度上限**，不能覆盖基础姿态的头部朝向。
4. **反应层（overlay）**：摸头时「头往手的方向偏 + 上半身微转」，但腿还在走。
5. **表情层**：与姿态解耦（morph，不是骨骼）。
6. **弹簧层**：发/袖，**在骨骼世界矩阵之后**，写的是「最终旋转」，优先级最高。

→ 需要**骨骼级 mask + additive + 优先级**。这三样恰好是 `AnimationMixer` 的弱项。

### 3.2 对比表

| 维度 | A：`AnimationClip` + `AnimationMixer` | B：自研姿态表 + 分层 slerp | C：A 做基础 + B 做 overlay |
|---|---|---|---|
| 可打断性 | 中：`crossFadeTo` 有 duration，打断需 `stopFading` 管理；快速连续打断容易留残影 | **高**：权重是纯数据，任一帧可改 | 高（同 B） |
| 分层叠加（走+摸头+呼吸+注视） | **差**：three 无 bone mask API；只能「拆 clip + 多 mixer + 每层一个 AnimationObjectGroup」，或手写 `PropertyMixer` 权重；additive 需 `AdditiveAnimationBlendMode` 且 clip 必须相对参考姿势预烘焙 | **好**：每层一个 `BoneMask`（骨名集合）+ 权重，逐骨加权 slerp | 中：基础层仍是 clip，overlay 好 |
| 姿态数量扩展成本 | 低（加 clip）但要为每个 clip 生成 382 条 track | 低（加一条 JSON） | 低 |
| 性能（30fps） | mixer 全量绑定 382 骨 × N clip：每帧 ~N×382 次插值 + 权重累加；3 层 = ~1150 次，仍 <0.3ms | **只混合受控 ~20 骨 × 层数（3–4）= 60–80 次 slerp**，<0.02ms | 中 |
| 确定性 / 可单测 | 差：`AnimationMixer` 依赖 `Clock`/`timeScale`，Node 里可跑但断言混合结果是「近似」的 | **好**：`blendPoses(weights) → Record<bone, quat>` 纯函数，输入输出可断言 | 中 |
| 与 IK/物理兼容 | 差：mixer 每帧 `_restoreBones` 覆盖一切（K3） | **好**：写骨顺序完全可控 | 中 |
| 代码复杂度 | 低（用现成） | 中（~300 行：姿态表、混合、层、easing） | 高（两套心智模型） |
| 循环/时长/事件 | **好**：`LoopRepeat`、`finished` 事件现成 | 自己写（20 行） | 好 |
| 与未来 VMD 共存 | **好**（VMD→clip 天然） | 需适配层 | 好 |
| 适合本项目的程度 | 只适合「一次性播放作者动作」 | **最适合 Wave 2** | 过度设计 |

### 3.3 推荐：**方案 B**（并预留 C 的接缝）

**理由（按重要性排序）**：
1. 我们的核心诉求是**分层叠加**（走+摸头+呼吸+注视），B 是唯一不别扭的写法。
2. 只需驱动 ~20 根骨，mixer 的 382 轨绑定纯属浪费；B 的性能优势在 30fps 省电目标下有实际意义（桌宠常驻，CPU <8% 是硬指标）。
3. **可单测**：姿态数据、权重归一化、easing、mask 求交都能在 Node 里断言；这直接决定 AI agent 团队能否并行开发。
4. 未来若接 VMD（B8），只需新增 `ClipLayer`（内部用 mixer，输出 per-bone quat），与 B 的混合器对接 —— 即方案 C 的接缝，**现在不做**。

### 3.4 关键数据结构与代码草图

```ts
// animation/types.ts —— 全部是纯数据，不 import three
export interface Quat { x: number; y: number; z: number; w: number }
export interface Euler3 { x: number; y: number; z: number }   // 弧度，作者用「度」书写后转换

/** 一个姿态 = 一组骨名 → 局部旋转偏移（相对 bind pose）。未列出的骨 = 恒等。 */
export type PoseDef = Readonly<Record<string, Euler3>>

/** 姿态库：id → PoseDef。id 与 B1 状态机共用（单一来源，见 §7.4）。 */
export type PoseTable = Readonly<Record<string, PoseDef>>
```

```ts
// animation/quat.ts —— 纯数学，30 行，避免 import three（单测零依赖）
export const IDENTITY: Quat = { x: 0, y: 0, z: 0, w: 1 }

export function eulerToQuat(e: Euler3): Quat {   // 顺序 YXZ（先 yaw 再 pitch 再 roll），MMD 习惯
  const cx = Math.cos(e.x / 2), sx = Math.sin(e.x / 2)
  const cy = Math.cos(e.y / 2), sy = Math.sin(e.y / 2)
  const cz = Math.cos(e.z / 2), sz = Math.sin(e.z / 2)
  return {
    x: sx * cy * cz + cx * sy * sz,
    y: cx * sy * cz - sx * cy * sz,
    z: cx * cy * sz - sx * sy * cz,
    w: cx * cy * cz + sx * sy * sz
  }
}

export function slerp(a: Quat, b: Quat, t: number): Quat {
  let { x, y, z, w } = b
  let cos = a.x * x + a.y * y + a.z * z + a.w * w
  if (cos < 0) { x = -x; y = -y; z = -z; w = -w; cos = -cos }   // 走短弧（K12）
  if (cos > 0.9995) {                                            // 近似线性，避免除零
    const r = 1 / Math.hypot(a.x + t * (x - a.x), a.y + t * (y - a.y), a.z + t * (z - a.z), a.w + t * (w - a.w))
    return { x: (a.x + t * (x - a.x)) * r, y: (a.y + t * (y - a.y)) * r, z: (a.z + t * (z - a.z)) * r, w: (a.w + t * (w - a.w)) * r }
  }
  const theta = Math.acos(cos) * t, sin = Math.sin(theta), sinA = Math.sin(Math.acos(cos))
  return {
    x: a.x * Math.cos(theta) + (x / sinA) * sin,
    y: a.y * Math.cos(theta) + (y / sinA) * sin,
    z: a.z * Math.cos(theta) + (z / sinA) * sin,
    w: a.w * Math.cos(theta) + (w / sinA) * sin
  }
}

export function normalizeWeightStack(entries: Array<{ w: number }>): number[] { /* 钳制 [0,1] → 归一化 */ }
```

```ts
// animation/blend.ts —— 分层混合器（核心，纯函数）
export interface PoseLayer {
  id: string
  /** 骨名 → 该层的旋转（局部偏移） */
  pose: ReadonlyMap<string, Quat>
  /** 层权重 0..1（由 B1/B4 驱动，带 easing） */
  weight: number
  /** 只影响这些骨（undefined = 全部）。用于「上半身层」不碰腿。 */
  mask?: ReadonlySet<string>
  /** additive：结果为 base * layer（乘算），否则与 base 做 slerp（覆盖式） */
  additive?: boolean
}

/** 输出：受控骨名 → 最终局部旋转。未出现的骨 = 恒等（调用方保持 rest）。 */
export function blendLayers(layers: readonly PoseLayer[]): Map<string, Quat> {
  const accum = new Map<string, Quat>()
  for (const layer of layers) {                    // 顺序 = 优先级：先基础，后 additive，最后注视
    if (layer.weight <= 0) continue
    for (const [bone, q] of layer.pose) {
      if (layer.mask && !layer.mask.has(bone)) continue
      const base = accum.get(bone) ?? IDENTITY
      const w = Math.min(1, Math.max(0, layer.weight))
      const next = layer.additive ? multiply(base, scaleQuatAngle(q, w)) : slerp(base, q, w)
      accum.set(bone, next)
    }
  }
  return accum
}
```

设计细节（都是「必须这样」而不是「可以这样」）：

- **层顺序固定**：`base(1) → additive 微动(0.2–0.4) → overlay 反应(0–1) → lookAt(0–1) → spring(1，最后)**。顺序变了观感就变，所以写进常量并单测。
- **覆盖 vs additive**：基础姿态之间用覆盖（slerp），呼吸/注视/弹簧用 additive。overlay（摸头）用覆盖式但 **mask 只含上半身+头**，腿由 base 决定。
- **mask 求交**：`mask = poseKeySet ∩ layerMask`，未列出的骨不写 → 保持 rest。这样「坐姿」只需写 8 根骨，其余（手指、裙摆）自动落回 A-pose 的 rest，不会出现「腿还站着但人坐下了」。
- **过渡**：B1 只管「目标姿态 id + 过渡时长」，B3 内部维护 `fromPose / toPose / t`，`t` 用 `smoothstep`（`3t²−2t³`）而不是线性——观感差别很大，且零成本。

```ts
// animation/pose-machine.ts —— 姿态过渡（可单测：时间 → 输出纯函数）
export class PoseMachine {
  private from: Map<string, Quat> = new Map()
  private to: Map<string, Quat> = new Map()
  private elapsed = 0
  private duration = 0.25
  setTarget(pose: Map<string, Quat>, durationSec: number, now: number): void { /* 记录 from=当前输出, to=目标 */ }
  /** 纯函数式：给定时间返回当前姿态（不依赖 three、不依赖 rAF） */
  sample(nowSec: number): Map<string, Quat> { /* t = smoothstep(elapsed/duration) */ }
}
```

**姿态数据格式（作者可读）**：

```ts
// animation/poses/standing.ts
import { deg } from '../authoring'
export const STANDING = {
  '左腕':   deg({ z: -24, x: -3, y: 3 }),
  '右腕':   deg({ z:  24, x: -3, y: -3 }),
  '左ひじ': deg({ x: -7,  y: 2 }),
  '右ひじ': deg({ x: -7,  y: -2 }),
  '左手首': deg({ z: -6,  x: 6 }),
  '右手首': deg({ z:  6,  x: 6 }),
  '左肩':   deg({ z: -2 }),
  '右肩':   deg({ z:  2 }),
  '上半身': deg({ x:  1 }),
  '上半身2': deg({ x: -1 }),
  '首':     deg({ x: -2 }),
  '頭':     deg({ x:  1 })
} as const
```

> `deg()` 只做「度 → 弧度」，**不**做轴变换（坐标系转换已由 MMDLoader 完成，B3 面对的就是 three 右手系）。这是最容易搞错的地方：**不要**再给 z 取反。

---

## 4. 姿态作者工作流（含 VPD）

### 4.1 候选方案对比

| 方案 | 如何产出姿态 | 迭代闭环 | 工具依赖 | 授权风险 | 适配本团队（AI agent、无美术、macOS） |
|---|---|---|---|---|---|
| **W1 TS/JSON 手写旋转表** | 直接写 `deg({...})` | 改文件 → 热更/重启 → 看截图（30–60s） | 无 | 无 | **高**：可 diff、可 code review、可单测 |
| **W2 PMXEditor 摆姿 → 导出 VPD → 转 JSON** | 图形界面拖骨 | 秒级（但需人眼操作） | **Windows + PMXEditor**（本机 macOS 无） | 中（VPD 若来自他人=衍生作品，不可再分发；自摆自用 OK） | 低：无 Windows、AI 无法操作 GUI |
| **W3 Blender + MMD Tools 摆姿 → VPD/JSON** | Blender 里摆 → 脚本导出 | 分钟级 | **Blender 未安装**（`which blender` 为空） | 无（自制） | 中低：可脚本化，但引入 300MB 工具链 |
| **W4 app 内 debug pose editor** | 自制滑块/输入框，实时看 | 秒级（人在看） | 需 lil-gui（**新依赖，需 Lead 批准**）或自制 DOM 面板 | 无 | 中：AI 无法「拖滑块」，但**人**（用户/Lead）可以微调 |
| **W5 截图回环（contact sheet）** | AI 写 JSON → Electron 批量渲染 9 宫格 → AI 读图 | **30–60s 全自动** | 无（复用 `tests/tmp/capture.cjs`） | 无 | **最高**：这是唯一能让 AI agent 自己「看见」的闭环 |

### 4.2 推荐路线（三段式）

**主路线 = W1 + W5**：

1. **W1**：姿态写成 TS 常量（`deg()` 作者友好），每骨一个 key；由 `animation/poses/` 目录组织，便于并行。
2. **W5（关键）**：`scripts/pose-contact-sheet.mjs`（B3 自己加，或放 `tests/tmp/` 先跑通）——用 Electron 启动现有渲染页，通过 `window.__aventurineDebug.debugSetPose(id)`（契约已有）+ `setMorph(name,w)` 注入姿态/表情，然后 `capturePage()` 9 张图拼一张 contact sheet。AI 用 `read_image` 看，逐轮调数字。
   - 复用 `tests/tmp/capture.cjs` 的**自迁移技巧**（脚本不在 cwd 根时复制自身再 exec，否则 `pet-asset://` 根目录错，PMX 全 404 —— 这是 A2 踩过的坑）。
   - 注入方式：`webContents.executeJavaScript("__aventurineDebug.debugSetPose('sit')")` + `setMorph('笑い',0.6)`。
3. **兜底 W4**：若用户/Lead 想手动微调，再加一个**零依赖**的 DOM 面板（`<input type=range>` × 12 骨，`document.body.appendChild`），**不装 lil-gui**（D10）。这个面板只在 dev 构建挂载，且不写入 config。

**VPD 作为可选导入（W2 的降级路径）**：

- **r171 原生支持**：`MMDLoader.loadVPD(url, isUnicode, onLoad)` → `parser.parseVpd(text, true)` → `helper.pose(mesh, vpd)`。**不需要自己写 parser**。
- **VPD 格式规范**（从 `mmd-parser` 的 `parseVpd` 实现反推，这是最权威的可执行规范）：
  - 纯文本，MMD 惯例 **Shift-JIS**（`MMDLoader.loadVPD` 在 `isUnicode=false` 时设 `mimeType = 'text/plain; charset=shift_jis'`）。
  - 第 1 行必须是 `Vocaloid Pose Data file`；第 3 行 = 父模型文件名（如 `砂金.pmx`）；第 4 行 = 骨骼块数量。
  - 每块：
    ```
    Bone0{左腕
    0.000000,0.000000,0.000000;
    -0.000000,0.000000,-0.382683,0.923880;
    }
    ```
    即 `Bone<N>{<骨名>` / `tx,ty,tz;` / `qx,qy,qz,qw;` / `}`。骨名**必须与 PMX 完全一致**（含全角 `ＩＫ`）。
  - 坐标：VPD 是 MMD 左手系；`parseVpd(text, true)` 会做与模型相同的 leftToRight（z 取反、q 的 x/y 取反）。**转换后与我们的骨骼局部轴语义一致**。
  - 与 PMX 的差异：VPD 的 `translation` 是**相对 rest 的偏移**（`helper.pose` 用 `bone.position.add()`），`quaternion` 是**乘算**（`bone.quaternion.multiply()`）。
- **风险**：网上 VPD 多为「某模型专用姿势」，骨名/比例不同，套到砂金上会穿模；且**版权随原模型**，不可再分发。→ 只作为「用户自己在 PMXEditor 里摆的 VPD」的导入通道，不做默认。
- **工作量**：`loadVpdFromText(text) → PoseDef`（用 `mmd-parser.parseVpd` 在构建期 Node 里跑，输出 JSON）≈ 半人日；运行期不需要 parser。

### 4.3 为什么不是「PMXEditor 一键」或「Blender」

- 本机 `which blender` 为空、`/Applications` 无 Blender/Unity/MMD 工具 → 任何 GUI 方案都会把「姿态生产」变成人工瓶颈，与「7 个 AI agent 并行」的开发模式冲突。
- 但 **VPD 通道要留着**：一旦用户愿意用 PMXEditor 摆几个关键姿势（尤其「坐窗沿」「睡」「被摸头」这类难摆的），我们能 5 分钟内吃进来。这也是 §11.1 里 B8 的低成本替代。

---

## 5. 表情系统

### 5.1 可用 morph（实测，`docs/model-morphs.md` 全表）

| 层 | 主用 morph | 备选 | 备注 |
|---|---|---|---|
| 眨眼 | `まばたき`(10) | `ウィンク`(14) `ウィンク２`(11) `ウィンク右`(15) `ｳｨﾝｸ２右`(12) | 闭眼系 5 个，**同组互斥** |
| 笑眼 | `笑い`(13) `笑い2`(26) `笑目`(27) `笑`(28) | `にやり`(54) `ワ`(57) | 与眨眼**冲突**（半闭眼） |
| 眉（情绪） | `怒り`(0) `悲しい`(7) `困る`(3) `真面目`(2) `上`(9) `下`(8) | `手前`(4) `やっかい`(6) | |
| 嘴（情绪） | `口角上げ`(40) `口角下げ`(39) `ムッ`(35) `大口`(44) `∧`(58) | `にやり２`(52) `にやり３`(53) | |
| 口型 | `あ`(29) `い`(30) `う`(31) `え`(32) `お`(33) `ん`(34) | `い2`(41) `え2`(42) | 6 个够用 |
| 害羞 | **`照れ`(68，材质 morph)** | `脸红`(75) | 材质 morph 由 A2 的 `MaterialMorphController` 消费，B3 只写 influence |
| 眼影 | `目影消`(66) `目影濃`(67)（材质） | — | 同上 |
| 好感 | `星目 `(73，带尾随空格) `はぁと`(72) | `はぅ`(69) `なごみ`(71) | 驱动 bq 面片 |
| 漫画符号 | `！`(81) `？`(82) `汗`(84) `怒`(80) | `！！`(83) `汗颜`(76) | 4–8 顶点小面片，**可做「惊讶/问号」气泡感** |

> `星目 ` 必须 `trim()` 后匹配（A2 的 `createMorphLookup` 已按 trim 建索引）。占位 morph `111/1111/11+` 永不使用。

### 5.2 眨眼调度（纯函数状态机）

要点：
- 随机间隔 `2.2–6.5s`，**指数分布**（`-ln(u) * mean`）比均匀分布更像真人（均匀分布会让用户潜意识预测）。
- **15%** 概率双眨（间隔 0.18s）。
- 单次眨眼时长 **110–160ms**（闭 45ms / 开 65ms），用 `smoothstep` 而不是线性。
- **冲突裁决**：`笑い/笑い2/笑目/笑` 权重 > 0.35 时，眨眼 morph 改用 `ウィンク`（半闭）并把权重乘 0.5；否则用 `まばたき`。理由：笑眼本身就是半闭眼，再叠 `まばたき` 会「闭两次」。
- 情绪切换（惊讶）时**立即**触发一次眨眼（人类的惊讶反射）。

```ts
// animation/emotion/blink.ts —— 纯函数，输入 now/随机数，输出 { morph, weight }
export interface BlinkState { nextAt: number; phase: 'idle'|'closing'|'opening'; t0: number; second: boolean }
export function stepBlink(s: BlinkState, now: number, rng: () => number, laughing: boolean): { state: BlinkState; weight: number; morph: string } {
  // 1) 到点 → 进入 closing；2) closing 45ms → opening；3) opening 65ms → idle + 排下一次
  // 4) 双眨：opening 结束时若 second=false 且 rng()<0.15 → 0.18s 后再来一次
  // 5) morph 选择：laughing ? 'ウィンク' : 'まばたき'
}
```

单测：给定固定 `rng` 序列，断言「0–10s 内眨眼次数 ∈ [2,5]」「双眨率≈15%」「任何时刻 weight ∈ [0,1]」「laughing=true 时 morph 名正确」。

### 5.3 情绪表情组合与归一化

情绪 = **眉 + 嘴 + 眼 + 材质** 四组的组合，每组**内部互斥**、组间可叠：

```ts
export interface EmotionDef {
  brow?: { morph: string; weight: number }     // 只允许一个主眉 + 一个弱辅
  mouth?: { morph: string; weight: number }
  eye?:   { morph: string; weight: number }    // 笑眼/星星眼/闭眼
  material?: { morph: string; weight: number } // 照れ / 目影消 / 目影濃
}
export const EMOTIONS = {
  neutral: {},
  smile:   { eye: { morph: '笑い', weight: 0.55 }, mouth: { morph: '口角上げ', weight: 0.5 } },
  shy:     { material: { morph: '照れ', weight: 0.85 }, brow: { morph: '困る', weight: 0.4 }, mouth: { morph: '口角上げ', weight: 0.25 } },
  angry:   { brow: { morph: '怒り', weight: 0.8 }, mouth: { morph: 'ムッ', weight: 0.7 } },
  sad:     { brow: { morph: '悲しい', weight: 0.7 }, mouth: { morph: '口角下げ', weight: 0.6 } },
  surprise:{ brow: { morph: '手前', weight: 0.8 }, mouth: { morph: '大口', weight: 0.6 }, eye: { morph: 'びっくり', weight: 0.5 } },
  love:    { eye: { morph: '星目', weight: 0.9 }, material: { morph: '照れ', weight: 0.6 } }
} as const
```

**归一化规则（关键，否则脸会「融化」）**：
1. 同一 morph 被多层写到 → 取 **max**（不是求和）。MMD 表情是加算，求和会过冲变形。
2. 同组（brow/mouth/eye/material）多源冲突 → 按**优先级**（反应层 > 情绪层 > 待机层），低优先级乘 `1 - 高优先级权重` 衰减。
3. 最终每个 weight 钳制 `[0,1]`。
4. **口型层不参与归一化**（它是「说话」独立通道），但要与情绪嘴型互斥：说话时嘴型类情绪 weight 乘 0.3。

### 5.4 口型同步（说话气泡）

- 6 个 viseme：`あ/い/う/え/お/ん`；按文本假名/拼音映射（B7 的 DSH 消息文本 → 音素近似）。
- 不用真音频分析（本 Wave 无 TTS）。节奏：每字 90–140ms，静音 200ms 闭嘴。
- **开口幅度** `0.35–0.8`（不要 1.0，MMD 大口会露牙床）。
- 与眨眼/情绪平滑叠加（口型只写 6 个 morph，优先级最低但**不被衰减**）。

```ts
// animation/emotion/viseme.ts
export function textToVisemes(text: string, lang: 'zh'|'ja'|'en'): Array<{ v: Viseme; ms: number }>
export function stepViseme(seq, elapsedMs): { morph: Viseme | null; weight: number }  // 交叉淡化 30ms
```

### 5.5 表情优先级 / 淡入淡出

```
优先级（高→低）：眨眼(硬) > 表情反应(被摸/被甩) > 情绪 > 口型 > 待机微表情
淡入：120ms；淡出：200ms（表情比姿态快，符合观感）
```

- 所有表情走同一个 `EmotionMixer`，输出 `Map<string, number>`；**每帧全量重算**（不要增量写 `influences`，否则残留 —— 与 `material-morphs.ts` 的 baseline 重算思路一致）。
- `照れ/目影消/目影濃` 必须写进 `morphTargetInfluences`（A2 的控制器读它），**不要**直接改材质（K13）。

### 5.6 单测清单（§7.1 会汇总）

- 同 morph 多源 → max；同组冲突 → 衰减；权重 ∈ [0,1]；未知 morph 名 → 忽略且不抛。
- 眨眼：固定 rng 的序列可复现；laughing 时换 `ウィンク`；双眨率。
- 情绪→morph 映射：`shy` 必含 `照れ`、`love` 必含 `星目`（trim）；`neutral` 输出空 Map。
- 口型：中文文本 → viseme 序列非空、总时长与字数匹配、`ん` 收尾。

---

## 6. 注视与次级运动

### 6.1 注视（look-at）

**层级**：`首`(15) 承担 **≤12°**、`頭`(16) 承担 **≤18°**、`左目先/右目先` 承担 **≤25°**（合计可达 55°，够用且不「翻白眼」）。

**为什么写 `目先` 而不是 `両目`**：眼球网格 100% 权重在 `目先`（§2.4）；`両目` 的有效增益只有 **0.3**（`目` 拿 +1、`目先` 拿 −0.7，净 0.3）。写 `目先` 的好处：一根骨、一步到位、无需 grant；坏处：与「MMD 标准 eye control」不兼容（若将来播 VMD，VMD 会写 `両目`，B3 的注视层必须关掉）。

```ts
// animation/look-at.ts —— 纯函数
export interface GazeTarget { yaw: number; pitch: number }   // 弧度，已钳制
/** 由鼠标屏幕坐标（CSS px）→ yaw/pitch（相对模型面向 +Z） */
export function gazeFromPointer(px: number, py: number, petRect: Rect, headWorld: Vec3): GazeTarget
/** 每层平滑（指数平滑，时间常数 90ms；避免抖动） */
export function smoothGaze(prev: GazeTarget, next: GazeTarget, dt: number, tau = 0.09): GazeTarget
/** 分配给 首/頭/目先 的角度（带各自上限） */
export function distributeGaze(g: GazeTarget): { neck: Euler3; head: Euler3; eye: Euler3 }
```

- 角度限制：`yaw ∈ [−0.55, 0.55]`（±31°）实际只用到 ±25°，`pitch ∈ [−0.35, 0.45]`（低头少、抬头多）。
- **死区**：鼠标在宠物中心 ±40px 内不转（避免「盯着你」的诡异感），超出后按比例。
- **超时回落**：鼠标离开窗口 2.5s 后 `smoothGaze` 回 `(0,0)`。
- 与姿态层的叠加：注视层是 **additive**，加到 `首/頭` 的基础姿态上；`目先` 是覆盖式（眼只有注视，没有别的层）。

### 6.2 次级运动：自研弹簧 vs MMDPhysics + ammo.js

| 维度 | 自研 verlet 弹簧（推荐） | `MMDPhysics` + ammo.js |
|---|---|---|
| 覆盖范围 | 手选 6–8 根（辫子/袖） | 全部 284 刚体 + 318 关节（含 14 条外衣链 ×4 节、腰穗、项链…） |
| 新增依赖 | **0** | `ammo.js`（~1.5MB wasm/js）+ 初始化 ~50–200ms |
| 30fps CPU | 6 骨 × 120Hz 子步 ≈ 0.02ms | 284 刚体 × 子步 `1/65` × `maxStepNum 3` → 实测社区反馈 3–8ms，与描边 pass 叠加后逼近预算 |
| 与程序化姿态兼容 | **好**（读父骨世界矩阵，写自身 quaternion） | **差**：刚体挂在 D 骨/衣摆骨上，物理结果直接覆盖骨骼 → B3 的姿态会被物理「拉回去」；且 `MMDPhysics` 会把骨骼设为 `matrixAutoUpdate=false`（源码 `MMDPhysics.js` 会接管） |
| 确定性 | **好**（固定子步，纯函数） | 差 |
| 观感 | 6 根骨能做出「辫子甩动 + 袖子摆动」的 80% 效果 | 完整但本项目 540px 下多数衣摆细节不可辨 |
| 风险 | 需要自己调 stiffness/damping/重力 | ammo 初始化失败/版本不匹配会黑屏；与 OutlineEffect 的 pass 交互未验证 |

**结论：Wave 2 只做自研弹簧，不做 MMDPhysics。** 具体：

- 链：`辮子1-1(201)` 是**挂点**（父=頭，不参与弹簧），其下 `辮子1-2(202) → 1-3(203) → 1-4(204) → 1-5(205)` = **4 根参与弹簧**；另有 `辮子2-1(206)`（1 根，挂在 1-4）与 `辮碎髮(207)`（1 根）。共 **6 根弹簧骨 + 1 根挂点**，权重合计 ~465 + 136。
- **袖子（`左袖帶1-1..1-5`，权重 360/34/40/59/61）观感收益更大**，但它是 `左腕` 的子链，手臂摆动本身已经带动它；如果预算允许，加 3 根（1-3/1-4/1-5）。**建议 Wave 2 先做辫子，袖子留开关**（`enableSleeveSpring: false`）。
- 算法（three-vrm 同款思路，简化版）：

```ts
// animation/spring.ts —— 纯函数 verlet，不 import three
// 每根骨：目标 = 父骨世界旋转 * rest 偏移；实际 = 上一帧世界位置 + 惯性 + 重力 + 刚度回拉
export interface SpringBoneCfg { bone: string; stiffness: number; drag: number; gravity: number; radius: number; parent: string }
export function stepSpringChain(
  chain: SpringChainState, cfg: readonly SpringBoneCfg[], dt: number, wind: Vec3
): SpringChainState {
  const h = 1 / 120                      // 固定子步
  let remaining = Math.min(dt, 0.1)
  while (remaining > 0) { const step = Math.min(h, remaining); /* 积分 + 长度约束 + 刚度回拉 */ remaining -= step }
  return chain
}
```

- 参数起点：`stiffness 0.6–1.2`、`drag 0.3–0.5`、`gravity 0.02`（模型单位/帧²）、`radius 0.15`。
- **不写 `bone.position`**：只把「目标方向 → 当前方向」的旋转差写到 `quaternion`，长度守恒由骨骼层级保证（这是最省事、最不容易穿模的做法）。
- **碰撞**：Wave 2 不做（头是球体，辫子挂点在头后，穿模概率低；截图验证后再加 1 个头部球体碰撞体）。

**参考**：three-vrm 的 spring bone（`VRMSpringBoneJoint`：`stiffness / gravityPower / gravityDir / dragForce / hitRadius`）是业界最成熟的 three 生态实现，参数语义可直接借用（[three-vrm](https://github.com/pixiv/three-vrm)、[VRM spec](https://github.com/vrm-c/vrm-specification)）。学术源头是 O'Brien 等的「主动+被动混合」次级运动（[PDF](https://people.computing.clemson.edu/~vbz/papers/obrien_1997_CAP.pdf)）——核心思想「被动积分 + 主动刚度回拉」正是上面的算法。

---

## 7. 验证与调试面

### 7.1 纯函数单测清单（Node/vitest，无 DOM/WebGL）

| 模块 | 断言 | 为什么值得测 |
|---|---|---|
| `quat.ts` | `eulerToQuat` 与已知值比对（如 z=90° → (0,0,0.7071,0.7071)）；`slerp` 端点、t=0.5 单位长度、短弧（dot<0 取反）；`normalize` 输入 0 权重不 NaN | 一切混合的地基，错了全歪 |
| `poses/*.ts` | 每姿态：骨名必须在 `BONE_NAMES` 白名单；角度 ∈ [−π, π]；不含 `足/ひざ/足首/目/両目`（K1/K2 防回归）；必含 `左腕/右腕`（否则手会保持 A-pose 水平） | 防手滑写错骨名/写错骨 |
| `blend.ts` | 两层 0.5 权重的结果 = 中点；mask 外骨不出现；additive 层权重 0 = 不变；层顺序改变结果改变（锁死顺序） | 分层是核心逻辑 |
| `pose-machine.ts` | `t=0` 输出 from、`t=1` 输出 to、`t` 单调；过渡中不出现 NaN；打断后 from = 当前 sample | 可打断性 |
| `leg-ik.ts` | 解出的膝角使 `|hip-ankle|` 等于目标距离（误差 <1e-3）；距离 > 腿长时钳制不 NaN；`kneeFlex ∈ [0, π]` | 贴地数学 |
| `blink.ts` | 固定 rng 的序列；双眨率；laughing 时 morph 切换 | 表情调度 |
| `emotion.ts` | 同 morph max；同组冲突衰减；权重范围；`neutral` 为空 | 表情组合 |
| `viseme.ts` | 文本 → 序列、总时长、`ん` 收尾、空文本 | 口型 |
| `look-at.ts` | 死区；角度钳制；平滑收敛（τ=90ms 时 3τ 后误差 <5%）；超时回落 | 注视 |
| `spring.ts` | 静止时收敛（10s 后角度 <0.01）；固定 dt 的确定性（同输入同输出）；`dt=0.1` 不爆炸 | 次级运动 |
| `state-map.ts` | B1 状态 id → 姿态 id 的映射全覆盖（无 undefined）；未知状态回落 `idle` | 与 B1 的契约 |

> 建议目录：`src/renderer/src/animation/**`（实现）+ `tests/animation/**`（测试）。纯函数模块**不 import `three`**，three 只在 `scene-bridge.ts` 一个文件里出现（减小 Node 测试负担，也便于将来换渲染后端）。

### 7.2 Electron 实机验证

现有能力（A2 已交付，`tests/tmp/capture.cjs`）：

- `PET_CAPTURE_TIMES` 多时刻抓图；`PET_CAPTURE_MORPHS` 设 morph 后抓图；输出 `cap-*.png/.json` + `summary.json`。
- 断言面：`window.__aventurineDebug` 的 `ready/model/stats()/setMorph/geometryRefreshCount/pointerIntercepting/errors`。
- 已有冒烟断言：不透明像素数（`capturedOpaquePixels`）、fps、petRect。

**调试字段：契约已定义，B3 只负责填**（`AnimationDebugSnapshot`，见 §1.3）：

```ts
// src/renderer/src/core/wave2-contract.ts（Lead 冻结，逐字）
interface AnimationDebugSnapshot {
  pose: string            // 当前主要姿态 id（stand/walk/sit/sitEdge/sleep/pat/drag/fall…）
  poseWeight: number      // 0–1
  activeLayers: number    // >1 表示正在过渡/叠加
  gesture: string | null  // 一次性表演
  blink: number           // 0–1
  smile: number           // 0–1
  mouthOpen: number       // 0–1
  lookYaw: number | null  // -1..1（左负右正）
  missingBones: string[]  // 姿态引用但模型没有的骨（必须为空）
  updateMs?: number       // 性能诊断
}
```

> 本文原本建议的 `footErrorPx / morphs / spring` **不在契约里**。若要用于冒烟，走「契约变更请求」加**可选字段**（`footErrorPx?: number; morphs?: Record<string, number>`），不要私自在 `debug.ts` 加字段。在 Lead 批准前，用**截图 + 像素断言**替代（见下面第 2、7 条）。

**冒烟断言建议**（追加到 `pnpm smoke`，不改变现有语义；字段名按契约）：

1. `__aventurineDebug.animation.pose === 'stand'` 且 `poseWeight ≥ 0.99`（启动即有待机姿态，不是 A-pose）。
2. `debugSetPose('sit'|'walk'|'sleep')` → 每次返回 true，`animation.pose` 跟随变化，`missingBones.length === 0`，`errors` 为空。
3. **A-pose 回归（无需新字段）**：`debugSetPose('stand')` 后截图，断言「宠物包围盒顶部以下 12% 高度带内的不透明像素数」显著少于 A-pose 基线（手臂放下后肩部两侧变窄）；或直接对 `stand` 截图与 Wave 1 A-pose 基线做像素差 > 阈值。
4. `setMorph('照れ', 1)` → 截图不透明像素/平均色变化 > 0（证明材质 morph 链路通；`smile` 字段此时应为 0，互不影响）。
5. 眨眼：轮询 8s，`animation.blink` 的最大值 > 0.5 至少出现 1 次（不必等待精确时刻）。
6. 口型：`bubbleText` 非 null 期间轮询，`animation.mouthOpen` 最大值 > 0.2 且回落 < 0.05。
7. 注视：`lookTarget` 指向宠物右侧远处 → `animation.lookYaw > 0.3`（契约是 −1..1 归一化，不是角度）；`lookTarget = null` 后 1s 内回到 0。
8. 性能：`fps ≥ 25`（30 上限）、`drawCalls`/`triangles` 与 Wave 1 基线一致（B3 不新增 draw call、不改材质）、`updateMs < 0.5`。

### 7.3 依赖与预算

| 项 | 预算 | B3 实测/估算 |
|---|---|---|
| 新增依赖 | 0 | 0（不装 lil-gui/ammo/three-vrm） |
| 每帧额外 CPU | <1ms | 混合 20 骨 × 4 层 ≈ 80 slerp ≈ 0.02ms；弹簧 6 骨 × 4 子步 ≈ 0.02ms；表情 ~10 morph 写值 ≈ 0.005ms |
| 每帧额外分配 | 0（热路径） | 复用 `Map`/临时 `Quat` 对象池；`blendLayers` 返回复用 Map |
| 内存 | +<2MB | 姿态表 <20KB；无新增纹理 |
| draw call | 不变 | B3 不建 mesh |

### 7.4 与其它 Wave 2 任务的契约（按 `wave2-contract.ts`）

B3 的**唯一入口**是 `update(input: AnimationInput)`，**唯一出口**是 `getAnimationSnapshot()` + `debugSetPose()`。
不直接 import B1/B2/B4/B5 的任何模块（避免循环依赖），全部经由 `wave2-contract` 的类型。

| 对方 | B3 消费/提供 | 说明 |
|---|---|---|
| Lead（`main.ts`/`pet-runtime.ts`） | 调 `animation.update(input)`；把 `animation` 挂到 `__aventurineDebug`；把 `debugSetPose` 透传 | B3 只实现 `update`/`snapshot`/`setPose`/`setMorph`，不碰 DOM/IPC |
| B1 状态机 | 消费 `input.mood`、`input.facing`、`poseHint?` | **姿态 id 由 `mood` 唯一决定**（§1.3 映射），`poseHint` 只做细化（如 `'idle:coin'` 触发一次性手势）；B3 不反向依赖 B1 |
| B2 运动 | 消费 `input.motion`（`feet/velocity/facing/grounded/airborne/surfaceId`）、`input.dragging` | `airborne` → `fall` 姿态；`velocity` → 走路步频/被甩 lean；**B3 不写 root 位置**（脚底 y 由 B2 的 `feet` 决定） |
| B4 交互 | 消费 `input.lookTarget`、`input.events`（`pat`/`poke`/`dragStart`/`dragEnd`） | 摸头/戳的即时表演由 B3 的 reaction 层做；命中检测在 B4 |
| B5 桌面感知 | 消费 `mood=sit`（含 `sitEdge` 由 surfaceId 细化） | 坐姿高度微调用 `input.viewportHeight` + `petRect`，不直接读 surface |
| B7 DSH | 消费 `mood=dshBusy/dshDone/dshError` | 只换表情/气泡，不换基础姿态（避免打断走路） |
| 所有人 | 提供 `getFootAnchors()`（可选，B2 落地用） | 纯查询，不改变状态 |

**「骨骼写入权」单一所有者原则（写进 B3 的 README/注释）**：Wave 2 中 `mesh.skeleton.bones[*].quaternion` 只允许 B3 写；B2 只写 `modelRoot.position/rotation`（root 级物理）；A2 的 `IdleMotion` 只写 `modelRoot.scale/rotation.z`。三方写不同层级，互不覆盖。将来接入 VMD/MMDPhysics 时，必须先关掉 B3 的对应层。

---

## 8. 参考与出处

> 全部链接为外部资料，仅作参考；实现以本仓库源码与本文实测为准。

### 8.1 three.js / MMD（源码级）

| 参考 | URL | 一句话结论（能借什么） |
|---|---|---|
| r171 `MMDLoader.js` | https://github.com/mrdoob/three.js/blob/r171/examples/jsm/loaders/MMDLoader.js | `parsePmx(buf, true)` 完成 leftToRight；`loadVPD` 原生可读 VPD；`physics:false` 时不建物理 |
| r171 `MMDAnimationHelper.js` | https://github.com/mrdoob/three.js/blob/r171/examples/jsm/animation/MMDAnimationHelper.js | **无 mixer 时 `update()` 不跑 IK/grant**；`pose()` 会 `mesh.pose()`；grant 是乘算且不幂等 |
| r171 `CCDIKSolver.js` | https://github.com/mrdoob/three.js/blob/r171/examples/jsm/animation/CCDIKSolver.js | IK 每次 40 迭代、依赖 `matrixWorld` 与上一帧 → 不适合作为姿态主驱动 |
| r171 `Skeleton.js` `pose()` | https://github.com/mrdoob/three.js/blob/r171/src/objects/Skeleton.js | 归零的正确 API 是 `skeleton.pose()`（恢复 bind pose） |
| `webgl_animation_skinning_blending` | https://github.com/mrdoob/three.js/blob/r171/examples/webgl_animation_skinning_blending.html | crossFade/setEffectiveWeight 的标准用法；证明 mixer 适合「整身 clip 过渡」，不适合分层 |
| `webgl_animation_skinning_additive_blending` | https://github.com/mrdoob/three.js/blob/r171/examples/webgl_animation_skinning_additive_blending.html | additive 需要「相对参考姿势预烘焙的 clip + 多 mixer」，成本比自研 additive 层高 |
| three.js Animation 常量文档 | https://threejs.org/docs/#api/en/constants/Animation | `AdditiveAnimationBlendMode` 的语义与限制 |
| `mmd-parser`（VPD 解析） | https://github.com/takahirox/mmd-parser | `parseVpd(text, true)` 是可执行的 VPD 规范；`leftToRight*` 的数学可直接抄 |
| babylon-mmd: VMD/VPD 介绍 | https://github.com/noname0310/babylon-mmd/blob/master/docs/docs/reference/understanding-mmd-behaviour/introduction-to-vmd-and-vpd/index.mdx | 第三方对 VPD/VMD 的权威梳理（可用作交叉验证） |
| three-mmd-loader（r172+ 替代） | https://github.com/takahirox/three-mmd-loader | 若未来必须升级 three，这是官方点名的迁移目标（本次不采用） |

### 8.2 弹簧 / 次级运动 / 分层

| 参考 | URL | 一句话结论 |
|---|---|---|
| three-vrm | https://github.com/pixiv/three-vrm | 生产级 SpringBone 实现：`stiffness/gravityPower/dragForce/hitRadius`，参数语义可直接借用 |
| VRM spring bone 规范 | https://github.com/vrm-c/vrm-specification | 每节 joint 的「惯性 + 刚度 + 重力 + 碰撞」定义，是自研弹簧的对照表 |
| VRM 摆动物件配置指南 | https://wiki.virtualcast.jp/wiki/en/vrm/setting/spring | 实操参数区间（刚度/阻力/重力），调参起点 |
| O'Brien et al., *Combining Active and Passive Simulations for Secondary Motion*, IEEE CG&A 1997 | https://people.computing.clemson.edu/~vbz/papers/obrien_1997_CAP.pdf | 「被动积分 + 主动回拉」的源头；解释了为什么少量弹簧骨就能有 80% 观感 |
| *Splicing of Concurrent Upper-body Motion Spaces with Locomotion* (2013) | https://www.sciencedirect.com/science/article/pii/S1877050913012477 | 上下半身分层/拼接的经典做法，佐证 §3 的「mask + 分层」设计 |
| Unreal Engine: Blend Masks and Blend Profiles | https://dev.epicgames.com/documentation/en-us/unreal-engine/blend-masks-and-blend-profiles-in-unreal-engine | 工业界「per-bone mask + 分层」的标准语义；B3 的 `PoseLayer.mask` 就是它的轻量版 |

### 8.3 HCI / 桌宠观感

| 参考 | URL | 一句话结论 |
|---|---|---|
| *Presence You Can Ignore*（Zenodo, DOI 10.5281/zenodo.22806803） | https://zenodo.org/records/22806803 | 待机微动取 **0.15–0.42Hz**；未经请求的话语「送达即完整、定时过期」；显眼行为用 variable-time 调度 → B3 待机动作的频率与幅度上限 |
| CHI 2024: *Evaluating How Desktop Companion Robot Behaviors Influence Work Experience and Robot Perception* | https://dl.acm.org/doi/10.1145/3613905.3651027 | 行为频率/侵入性与用户感知的量化关系 → 决定「摸头反应」「自主摆姿」的冷却时长 |
| Mate-Engine（动画清单参考，不复制资产） | https://github.com/shinyflvre/Mate-Engine | 109 个非舞蹈片段的分类/时长可作**节奏参考**；其 `.anim` 是 Unity Humanoid muscle clip，three 不能直接读（PLAN §11.1 已论证） |
| desktop-pet-macos（Electron 桌宠） | https://github.com/xiangzi1025/desktop-pet-macos | 行为状态机与渲染分离的模块划分；可参考其「状态 → 动画」的映射粒度 |

### 8.4 视频教程（B 站，中文）

| BV | URL | 一句话结论 |
|---|---|---|
| BV1psR2YyEwJ | https://www.bilibili.com/video/BV1psR2YyEwJ/ | three.js + MMD 数字人：加载/骨骼/姿态控制的完整流程，适合对照本文 §2 验证术语 |
| BV14u411c7TB | https://www.bilibili.com/video/BV14u411c7TB/ | three.js 基础 + 动画循环（PLAN §18.1 已收录） |
| BV1Se4y1u7Ag | https://www.bilibili.com/video/BV1Se4y1u7Ag/ | MMD 模型在 Web 端的加载/材质/描边（PLAN §18.1 已收录） |
| BV1Aw411j7NW | https://www.bilibili.com/video/BV1Aw411j7NW/ | Electron 桌宠工程结构（PLAN §18.1 已收录） |

> 说明：B 站视频未逐帧核验，只作学习路径；本文的技术结论均以 r171 源码 + 本模型实测为准。**未找到**专门讲「three.js 程序化 MMD 姿态分层」的高质量中文视频，故不虚构 BV 号。

### 8.5 明确「未确认」的项（诚实标注）

- **SIGGRAPH/TOG 专门讲「程序化姿态分层 + 桌宠」的论文**：本轮未检索到直接命中（检索到的多为离线角色动画）。本文的分层设计来自工业实践（UE Blend Mask）+ three 源码，不依赖某篇论文。
- **DesktopMate / MateEngine 的动画架构文章**：只有 Steam 页面与仓库，未找到官方技术博客；其动画清单结论沿用 `docs/anim-reference.md`（已核验文件树）。
- **VPD 格式的官方规范文档**：不存在公开规范；本文以 `mmd-parser` 的实现为准（这是事实标准）。

---

## 附录 A. 关键骨骼清单（B3 直接可用）

> 索引 = PMX 索引 = `mesh.skeleton.bones` 下标（实测）。**代码里用名字查，索引只用于调试**。
> 完整 382 根（含父级/层级/IK/grant/位置）见 `tests/tmp/bones.json`（gitignored，可随时重建，见附录 B）。

### A.1 根 / 躯干 / 头

| idx | 名称 | 父 | 层级 | 备注 |
|---:|---|---|---:|---|
| 0 | `操作中心` | — | 0 | MMD 编辑器用，忽略 |
| 1 | `全ての親` | — | 0 | 全体根 |
| 2 | `センター` | 全ての親 | 0 | **整体平移/旋转**（上下、左右、转身） |
| 3 | `グルーブ` | センター | 0 | 节奏位移（MMD 惯例） |
| 4 | `腰` | グルーブ | 0 | ⚠️ 会同时影响上下半身（且被 `腰キャンセル` 抵消腿部）→ **B3 不写** |
| 11 | `下半身` | 腰 | 0 | 腿的父；转它 = 两腿一起摆 |
| 12 | `上半身` | 腰 | 0 | 躯干 |
| 13 | `上半身1` | 上半身 | 0 | 躯干中间（`上半身` 与 `上半身2` 之间的辅助节） |
| 14 | `上半身2` | 上半身1 | 0 | 胸 |
| 15 | `首` | 上半身2 | 0 | 颈（注视层用） |
| 16 | `頭` | 首 | 0 | 头（注视层用；**6493 权重，最大**） |

### A.2 手臂（左右对称，左 = 右 + 30 左右偏移，无严格规律，按名字查）

| idx | 名称 | 父 | 备注 |
|---:|---|---|---|
| 17 / 47 | `右肩P` / `左肩P` | 上半身2 | 只动肩部网格（手臂被 `肩C` 抵消）→ 不写 |
| 18 / 48 | `右肩` / `左肩` | 肩P | 耸肩+手臂跟随 → 可用（小角度） |
| 19 / 49 | `右肩C` / `左肩C` | 肩 | grant −1，**永不由 B3 写** |
| 20 / 50 | `右腕` / `左腕` | 肩C | **上臂主控**（自然站姿：左 Z−24°、右 Z+24°） |
| 21 / 51 | `右腕捩` / `左腕捩` | 腕 | 前臂扭转（有 148/179 权重）→ Wave 2 不写 |
| 22–24 / 52–54 | `腕捩1..3` | 腕 | grant 0.25/0.5/0.75 → 不写 |
| 25 / 55 | `右ひじ` / `左ひじ` | 腕捩 | **肘**（微屈 X −7°） |
| 26 / 56 | `右手捩` / `左手捩` | ひじ | 手腕扭转 → 不写 |
| 27–29 / 57–59 | `手捩1..3` | 手捩 | grant → 不写 |
| 30 / 60 | `右手首` / `左手首` | 手捩 | **手腕** |
| 121 / 211 | `右袖帶親` / `左袖帶1-0` | ひじ / 腕 | 袖子根 |
| 122–126 / 212–216 | `右袖帶1-1..1-5` / `左袖帶1-1..1-5` | 袖帶親 / 1-1 | **左袖权重 360/34/40/59/61（显眼）**，弹簧备选 |

### A.3 腿（**B3 写 D 链，不写 IK 链**）

| idx | 名称 | 父 | 层级 | 权重 | 说明 |
|---:|---|---|---:|---:|---|
| 77 / 82 | `腰キャンセル右` / `左` | 下半身 | 0 | 0 | grant −1（抵消腰），不写 |
| 78 / 83 | `右足` / `左足` | 腰キャンセル | 0 | **0** | IK link，**写了也不动** |
| 79 / 84 | `右ひざ` / `左ひざ` | 足 | 0 | **0** | IK link（限角） |
| 80 / 85 | `右足首` / `左足首` | ひざ | 0 | **0** | IK effector |
| 81 / 86 | `右つま先` / `左つま先` | 足首 | 0 | 0 | |
| 99 / 103 | `右足D` / `左足D` | 腰キャンセル | 1 | 446 / 498 | **大腿（写它）** |
| 100 / 104 | `右ひざD` / `左ひざD` | 足D | 1 | 518 / 256 | **小腿（写它）** |
| 101 / 105 | `右足首D` / `左足首D` | ひざD | 1 | 932 / 929 | **脚/鞋（写它；最大权重部位）** |
| 102 / 106 | `右足先EX` / `左足先EX` | 足首D | 1 | 387 / 387 | 鞋尖（可选：脚尖上翘） |
| 6 / 9 | `右足ＩＫ` / `左足ＩＫ` | 足IK親 | 1 | 0 | **全角 ＩＫ**；Wave 2 不动 |
| 7 / 10 | `右つま先ＩＫ` / `左つま先ＩＫ` | 足ＩＫ | 1 | 0 | 脚掌朝向；Wave 2 不动 |
| 5 / 8 | `右足IK親` / `左足IK親` | 全ての親 | 0 | 0 | |

### A.4 眼 / 表情辅助

| idx | 名称 | 父 | 层级 | 权重 | 说明 |
|---:|---|---|---:|---:|---|
| 87 / 89 | `右目` / `左目` | 頭 | 2 | 0 | 眼控（grant 给 `目先` +1） |
| 88 / 90 | `右目先` / `左目先` | 目 | 2 | **502 / 502** | **眼球（写它）**；grant 自 `目` −0.7 |
| 91 | `両目` | 頭 | 0 | 0 | MMD 标准眼控（有效增益 0.3）；VMD 会写它 → 与 B3 互斥 |
| 92 | `両目先` | 両目 | 0 | 0 | |

### A.5 次级运动候选（弹簧）

| idx | 名称 | 父 | 权重 | 建议 |
|---:|---|---|---:|---|
| 201 | `辮子1-1` | 頭 | 0 | 链根（挂点，不参与弹簧） |
| 202–205 | `辮子1-2..1-5` | 1-1.. | 239/125/66/21 | **主弹簧链（4 根）** |
| 206 | `辮子2-1` | 辮子1-4 | 14 | 副链（1 根） |
| 207 | `辮碎髮` | 頭 | 136 | 碎发（1 根） |
| 249–255 | `後腰帶1..7` | 下半身 | 196/0/89/0/91/0/261 | 腰后飘带（7 根；Wave 2 不做） |
| 256–258 | `後腰帶穗1..3` | 後腰帶7 | 107×3 | 穗（不做） |
| 259–261 | `前腰帶0..2` | 下半身 | 0/88/168 | 腰前带（不做） |
| 272–375 | `外衣_*`（14 链 × 最多 10 节） | 上半身2 / 上级 | 多为 0–140 | 外套（不做；MMDPhysics 才需要） |

### A.6 启动自检（建议 B3 在 `attach()` 时跑）

```ts
const REQUIRED_BONES = [
  'センター','上半身','上半身2','首','頭',
  '左肩','右肩','左腕','右腕','左ひじ','右ひじ','左手首','右手首',
  '下半身','左足D','右足D','左ひざD','右ひざD','左足首D','右足首D',
  '左目先','右目先','辮子1-2'
] as const
// 任一缺失 → console.warn + debug.errors.push('[animation] missing bone: X')，并降级（跳过该层）
```

---

## 附录 B. bones.json 与解析脚本

- 产物：`tests/tmp/bones.json`（gitignored）。内容：`metadata`（PMX 头、计数）、`counts`、`iks`（4 根 IK 的 effector/iteration/links/限角）、`bones[382]`（index/name/englishName/parentIndex/parentName/transformationClass/kind/position/ik/controlledByIk/grant/grantedBy）。
- 生成脚本：`tests/tmp/dump-bones.mjs`（临时文件，不入库）。核心 6 行：

```js
const { Parser } = require('mmd-parser')
const buf = readFileSync('assets/model/星穹铁道—砂金·戏浪.pmx')
const pmx = new Parser().parsePmx(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), true) // true = leftToRight，与 MMDLoader 一致
pmx.bones.forEach((b, i) => console.log(i, b.name, b.parentIndex, b.transformationClass, b.ik ? 'IK' : ''))
```

- 若 PMX 被替换/改名，重跑脚本并更新附录 A。

---

## 附录 C. 数值常量表

| 常量 | 值 | 来源 |
|---|---:|---|
| 模型高度 | 21.681 单位 | 实测 bbox（bind pose，顶点 position） |
| 1 单位 → px @540 | 24.9 px | 540 / 21.681 |
| 1 单位 → px @324 | 14.95 px | 324 / 21.681 |
| 踝高 / 膝高 / 髋高 | 1.229 / 6.784 / 12.234 | 骨骼 position |
| 大腿长 / 小腿长 | 5.453 / 5.557 | 骨长 |
| 脚趾（つま先）高度 | 0.36 | |
| 上臂长 / 前臂长 | 2.885 / 2.660 | |
| A-pose 下垂角 / 肘角 | 39.6° / 3.8° | 实测 |
| 自然站姿目标下垂角 | 63–66° | 经验（需截图校准） |
| 眨眼间隔 | 2.2–6.5 s（指数） | 人因经验 |
| 眨眼时长 | 110–160 ms | 同上 |
| 呼吸 / 重心频率 | 0.24 / 0.16 Hz | A2 `IdleMotion`（PLAN 论文结论 0.15–0.42Hz） |
| 注视角度上限（首/头/眼） | 12° / 18° / 25° | 经验 |
| 注视平滑 τ | 90 ms | 经验 |
| 弹簧子步 | 1/120 s，最多 4 步/帧 | 稳定性 |
| 姿态过渡默认时长 | 0.25 s（smoothstep） | 观感 |
| 表情淡入/淡出 | 120 / 200 ms | 观感 |

---

## 附录 D. 风险登记（实现 B3 时最关键的 5 个）

| # | 风险 | 影响 | 概率 | 缓解 |
|---|---|---|---|---|
| R1 | **姿态「看不见」**：写了 `足/ひざ/目`，网格不动（K1/K2） | 高（浪费 1–2 天） | 高（已实测确认会发生） | 本文 §2.4 + 附录 A 已给出正确骨；`attach()` 自检；单测断言姿态里禁用这些骨 |
| R2 | **与 B2 物理/未来 VMD 抢骨** | 高（抽搐/穿模/回滚） | 中 | 明确「骨骼写入权」单一所有者：Wave 2 = B3；B2 只做 root 级物理（位置/惯性），不写骨；VMD 接入时 B3 停写（互斥开关 + 文档） |
| R3 | **姿态质量无法验收**（没有美术、无法肉眼调） | 高（做出来丑但「能跑」） | 高 | W5 contact sheet 截图回环 + 客观指标（脚底误差、手不穿裙、头不歪超过 N°）+ 用户/Lead 一次性人工校准 |
| R4 | **分层权重调不好导致「抖动/抽搐」** | 中 | 中 | 固定层顺序、权重平滑（`smoothDamp`）、所有层权重钳制、层间不共享骨（除注视） |
| R5 | **30fps 下弹簧/表情抖动或耗电** | 中（性能目标 <8% CPU） | 低 | 固定子步 + 每帧最多 4 步；表情全量重算但只有 ~10 个 morph；`stats()` 里加 `poseMs` 计时，超 0.5ms 报警 |

补充风险（不阻塞，但要知道）：
- **`IdleMotion` 改的是 `modelRoot`**：B3 接管骨骼后，root 级呼吸仍会让「脚底贴地」的像素级断言抖动 ±0.4%，冒烟阈值要留 1–2px 余量。
- **描边 pass 与骨骼无关**，但弹簧让发丝出轮廓时，`OutlineEffect` 的屏幕空间描边可能在新姿态下出现「断线」——Wave 1 的 `outlinePx` 已按材质处理，B3 不改。
