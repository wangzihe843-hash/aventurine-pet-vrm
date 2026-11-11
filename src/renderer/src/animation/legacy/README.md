# B3 动画 / 姿态 / 表情系统（`src/renderer/src/animation/**`）

> Wave 2 核心模块。方案依据 **`docs/anim-tech-survey.md`**（已锁定：方案 B 自研姿态表 + 分层权重混合），
> 动作设计依据 **`docs/aventurine-character-brief.md`**（砂金人设：外松内紧、赌徒/从容/戏谑；
> **剔除女性化动作**、无道具、只复用现有 85 morph、0 新依赖）。
>
> 对外入口：`createPetAnimator({ mesh, root?, now?, random? }) → PetAnimator`
> （`update / getDebugSnapshot / setPose / setGaze`，与 `core/wave2-contract.ts` 的
> `AnimationInput` / `AnimationDebugSnapshot` / Lead 的 `PoseDriver` 完全对齐）。

---

## 1. 文件结构与「three 只出现一次」

| 文件 | 职责 | import three? |
|---|---|---|
| `types.ts` | 纯数据类型：`Quat` / `Vec3` / `EulerDeg` / `PoseDef` / `PoseMeta` / `GestureDef` | ❌ |
| `quat.ts` | 四元数/向量数学：YXZ 欧拉角、slerp 短弧、旋转向量 exp/log、smoothstep、指数平滑 | ❌ |
| `blend.ts` | 分层混合器 `blendLayers` + 层顺序常量 `LAYER_ORDER` | ❌ |
| `pose-machine.ts` | 姿态过渡状态机（smoothstep + 可打断） | ❌ |
| `skeleton.ts` | 骨骼白名单/禁用骨/必需骨/弹簧链/腿链常量 + 姿态数据自检 | ❌ |
| `poses/base.ts` | **12 个基础姿态表**（以「度」书写、骨名寻址）+ 元数据（贴地/重心/呼吸） | ❌ |
| `poses/gestures.ts` | **6 个待机变体 + 6 个反应 + 1 个庆祝**的 keyframe 手势表 | ❌ |
| `poses/index.ts` | 姿态数据入口：采样关键帧、度数→四元数、自检 re-export | ❌ |
| `leg-ik.ts` | 解析二骨 IK（矢状面，rest 角度校准）+ 余弦定理 + 退化钳制 | ❌ |
| `grounding.ts` | 接地组装：髋位置、髋高补偿（压低/抬升）、脚掌贴平、脚底误差 | ❌ |
| `gait.ts` | 程序化步态：走路/爬行相位、脚目标、臂反摆、重心起伏、坐窗沿晃腿 | ❌ |
| `look-at.ts` | 注视：鼠标→角度、死区、上限、首/頭/目先 分配、90ms 平滑、2.5s 回落、朝向换算 | ❌ |
| `blink.ts` | 眨眼状态机：指数间隔 2.2–6.5s、15% 双眨、110–160ms、笑眼冲突裁决、惊讶反射 | ❌ |
| `emotion.ts` | 情绪组合：眉/嘴/眼/材质四组、同组互斥、同 morph 取 max、优先级衰减、权重钳制 | ❌ |
| `viseme.ts` | 口型：文本→あいうえおん 序列、90–140ms/字、30ms 交叉淡化、`ん` 收尾 | ❌ |
| `spring.ts` | 发辫 verlet/角速度弹簧：固定子步 1/120、每帧 ≤4 步、只写四元数 | ❌ |
| `state-map.ts` | `PetMood → 姿态` 穷举、事件优先级、心情切换手势、待机变体调度（随机+冷却） | ❌ |
| `micro-motion.ts` | **连续微动层**（v2）：呼吸/重心摆动/头颈延迟/手臂 follow/手指收放/视线漂移 | ❌ |
| `pipeline.ts` | **每帧纯逻辑管线**（Node 可单测）：事件→姿态→层→IK→弹簧→表情→调试快照 | ❌ |
| `scene-bridge.ts` | three 适配：启动自检、读 rest 骨位置/morph 索引、写骨/センター/morph | ✅ **唯一** |
| `index.ts` | 对外导出（`createPetAnimator` 等） | ❌（只 re-export） |

**骨骼写入权单一所有者**：Wave 2 中 `mesh.skeleton.bones[*].quaternion` 只允许本模块写；
`modelRoot` 的 position/scale/rotation 属于 Lead 的 `PetScene`/`IdleMotion`/B2，B3 **不写**。
将来接 VMD/MMDPhysics 时必须先关掉 B3 的骨骼写入（互斥开关）。

---

## 2. 每帧管线与固定层顺序

```
AnimationInput ──► pipeline.update(input, nowMs)
 1. 事件/心情：反应优先级 thrown > landed > dragStart > pat > dragEnd > poke；pat/dshDone 切换手势
 2. 基础姿态：姿态表 + 程序化步态（走/爬/坐窗沿晃腿）→ PoseMachine（smoothstep 0.25s 默认，可打断）
 3. 呼吸/微动 additive 层（0.24/0.16Hz，幅度 <1°）
 4. 反应/待机手势 overlay 层（bone mask + 120ms 淡入 / 200ms 淡出包络）
 5. look-at additive 层（首/頭；目先 单独覆盖）
 6. 接地：解析二骨 IK + 髋高补偿 + 脚掌贴平（只覆盖 6 根腿 D 链）
 7. 发辫弹簧（最后写，只写 6 根发骨 quaternion）
 8. 表情：情绪 → 眨眼 → 口型 → morph 全量输出
 9. 调试快照
```

层顺序由 `blend.ts` 的 `LAYER_ORDER = ['base','breath','overlay','lookAt','spring']` 锁死，单测断言「顺序改变结果改变」。

### 只驱动有蒙皮权重的骨（survey §2.4 实测）

- 躯干/头：`上半身/上半身2/首/頭`；肩/臂/手：`左肩/右肩/左腕/右腕/左ひじ/右ひじ/左手首/右手首`；
- 骨盆/腿：`下半身` + **D 链** `左足D/右足D/左ひざD/右ひざD/左足首D/右足首D`；
  **绝不写** IK 链 `足/ひざ/足首`（权重 0，写了不动）与 `足ＩＫ/つま先ＩＫ`；
- 眼：**`左目先/右目先`**（权重 502/502）；**绝不写** `目/両目`（0 权重，`両目` 有效增益仅 0.3）；
- 不写 `肩P/肩C/捩骨/腰/腰キャンセル`（grant 链，会破坏抵消关系）；不跑 grant/CCDIK/helper；
- `センター` 只写 `position`（接地补偿）与睡姿 `quaternion`（翻滚），不写 `modelRoot`。

---

## 3. 姿态作者指南（改数字只改 `poses/`）

### 3.1 坐标与轴符号（survey §2.3 实测，父骨未旋转时成立）

| 轴 | 指向 | 正角效果 | 常用写法 |
|---|---|---|---|
| **X** | 角色左（屏幕右） | 前倾/低头；腿向后摆 | 腿前摆 = X **负**；低头 = X **正**；手臂前摆（自然下垂时）= X **负** |
| **Y** | 上 | 转向角色左侧（屏幕右） | 转头看屏幕右 = Y **正**；脚尖外八：左脚 = Y 正、右脚 = Y 负 |
| **Z** | 前（朝镜头） | 脊柱向角色右侧弯 | 左臂放下 = Z **负**；右臂放下 = Z **正**；抬左臂 = Z 正、抬右臂 = Z 负 |

- 单位：角度写「度」，`deg()`/`eulerDegToQuat` 内部转弧度；**不要再给 z 取反**（MMDLoader 已完成 leftToRight）。
- 模型是 **A-pose**（手臂下垂 39.6°），自然站姿只需再压 ~24–30°。
- 位移单位 = **模型单位**（模型高 21.681；540px 宠物 1 单位 ≈ 24.9px）。
- 脚目标：`forward` 正 = 朝镜头/前；`lift` 正 = 抬脚；`yawDeg` 正 = 外八（左右自动镜像）。

### 3.2 新增/修改一个基础姿态

1. 在 `poses/base.ts` 的 `BASE_POSES` 加一条（骨名必须是 `skeleton.ts` 的 `POSE_CONTROLLED_BONES`）；
2. 在 `BASE_POSE_META` 加对应 meta：
   - `grounded: true` → 脚由 IK 钉在地面（写 `crouch` 蹲深，腿角不用写）；
   - `centerY`：非接地姿态需要整体升降时用（单位模型单位，负数往下）；
   - `centerRollDeg`：睡姿翻滚（绕 Z，正 = 右肩下沉/头朝屏幕左）；
   - `foot`：左右脚目标（前后/外八）；`breathScale/breathRate`：呼吸幅度/频率；
   - `baseEmotion`：该姿态的基线表情 id（见 `emotion.ts` 的 `EmotionId`）；
3. 若此姿态会被 `mood` 使用：在 `state-map.ts` 的 `MOOD_TO_POSE` 里改映射；
4. `pnpm exec vitest run tests/animation-math` —— 姿态数据自检（白名单/禁用骨/±170°）会抓错；
5. 视觉校准：Lead 的 dev 截图回环（`PET_DEV_CAPTURE_POSES=...`），改数字 → 30–60s 看结果。

### 3.3 新增一个待机变体 / 反应

在 `poses/gestures.ts` 加 `GestureDef`：

```ts
const MY_GESTURE: GestureDef = {
  id: 'myVariant', label: '中文标签', duration: 3.0,
  fadeIn: 0.2, fadeOut: 0.25,
  mask: UPPER_BODY_MASK,          // 只动上半身，腿交给基础姿态/IK
  keyframes: [
    { at: 0, pose: {} },          // 首帧回基础姿态
    { at: 0.8, pose: { 右腕: { z: 20, x: -20 }, 首: { x: 6 } }, gaze: { yawDeg: -5, pitchDeg: 15 } },
    { at: 1.6, pose: { ... }, emotion: 'smirk' },
    { at: 3.0, pose: {} }         // 末帧回基础姿态
  ]
}
```

- 待机变体：加进 `IDLE_VARIANTS`（`weight` 合计 100、`cooldownSec`），只在 `mood=idle + stand + 无交互` 时随机播放；
- 反应：加进 `REACTIONS`，`reaction: true` 会打断待机变体；`crouchPulse` 在 grounded 时由 IK 转成屈膝；
- 关键帧可带 `emotion`（表情切换点）与 `gaze`（强制视线，例如看手里的「硬币」）；
- 节奏遵循 brief：「慢—快—停半拍」，接住后的半拍比幅度更重要；**不要**做娇羞摇摆/卖萌挥手/假道具。

### 3.4 常见坑（survey §2.8，代码里已有单测防线）

- 写 `足/ひざ/足首/目/両目` → 网格不动（权重 0）→ 自检直接报错；
- 接地姿态写腿角 → 被 IK 覆盖（脚目标/meta 才是权威）；想要腿型改 `crouch`/`foot`/`grounded`；
- 中心平移量级：`centerY = -12.226` 是「髋坐到 bind 地面高度」的坐姿基准（`feet.y = surface.top` 口径），
  睡觉 `centerRollDeg=80` 是侧躺；这两个姿态的视觉细节需要截图回环校准；
- 宠物朝向：B3 不写 root；注视层假设 Lead 在 root 层用 ±90° Y 旋转表达 facing，`look-at.ts` 会做局部化换算。

---

## 4. 表情调度（复用现有 85 morph，禁新资产）

- **情绪** = 眉 / 嘴 / 眼 / 材质 四组，同组互斥、组间可叠；**同 morph 取 max（不求和）**；
  同组多源按优先级（反应 30 > 姿态基线 10）先选、低优先级 × `1−高权重` 衰减；最终钳制 [0,1]；
- **砂金五种笑**（`emotion.ts`）：`business` 营业笑（`にやり`，眼不笑，**默认待机**）、
  `smirk` 玩味（`にやり２`+`じと目`）、`realSmile` 真笑（`笑い`+`口角上げ`）、
  `tired` 疲惫（`にやり`+`目影濃`）、`wry` 自嘲（`悲しい`+低权重`にやり`+`目影濃`）；
- **眨眼**：指数间隔 2.2–6.5s、15% 双眨（+180ms）、闭 45–55ms/开 65–75ms、smoothstep；
  笑眼权重 >0.35 时改用 `ウィンク` 且权重 ×0.5（避免「闭两次」）；
- **口型**：`bubbleText` → 6 viseme 序列（90–140ms/字、30ms 交叉淡化、结尾 `ん` 收口）；
  说话时嘴型类情绪 ×0.3（独立通道，不参与归一化）；
- **材质 morph**（`照れ/目影消/目影濃`）只写 `morphTargetInfluences`，由 A2 `MaterialMorphController` 读取后改材质 alpha（K13）；
- 每帧**全量**写受管 morph（先归零再写非零），不增量，避免残留。

---

## 5. 接地（脚底贴地）与弹簧

### 5.1 解析二骨 IK + 髋高补偿

- 腿在矢状面（y,z）解：由 rest 关节位置推大腿/小腿长度与 rest 方向角（本模型大腿近竖直、小腿略向后），
  返回**相对 rest 的附加角**，rest 目标解出的附加角 ≈ 0（单测锁死）；
- 脚目标 = bind 踝位置 + `forward/lift/yaw`（站/走支撑相 lift=0 → 脚底贴地）；
- 髋高补偿：够不着 → 压低 `センター`；目标过近（膝盖会反折）→ 抬高；落地 `crouchPulse` 也在这里转成屈膝；
- 脚掌贴平：`足首D` 局部俯仰 = −软系数(0.7) ×（大腿+膝）附加俯仰，保证鞋底水平、脚背不反折；
- 调试面 `footErrorPx` = 解算角度回推踝 y 与目标 y 之差（CSS px）。站/走 < 2px；坐/睡/爬/腾空为 `null`。

### 5.2 发辫弹簧（自研，不引 ammo.js / MMDPhysics）

- 参与积分 6 根：`辮子1-2..1-5`（主辫 4）、`辮子2-1`（副辫）、`辮碎髮`；`辮子1-1` 是挂点不积分
  （任务书「7 根」把挂点也算上了；按 survey D9 定为 6 根参与 + 1 根挂点）；
- 角速度弹簧：刚度回拉 rest + 父骨角速度惯性 + 重力扭矩 + 阻尼；固定子步 1/120s、每帧 ≤4 步；
- **不写 `bone.position`**，只写四元数；不做碰撞；袖子弹簧（`左袖帶1-3..1-5`）默认关闭（留开关未启用）。

---

## 6. 对外 API（Lead 接线）

```ts
import { createPetAnimator, type PetAnimator } from '../animation'

// PMX 加载完成后（Lead 的 createPoseDriver 工厂里）：
const animator: PetAnimator = createPetAnimator({
  mesh,                       // three SkinnedMesh（必填）
  root,                       // 可选；B3 不写它
  now,                        // 可选：注入时钟（毫秒；默认 performance.now；单测假时钟）
  random                      // 可选：随机源（眨眼/待机变体；默认 Math.random）
})

// PetScene.step 内、materialMorphs.update() 与渲染之前：
animator.update({
  dt, mood, motion, facing, lookTarget, petRect, viewportHeight, dragging, events, bubbleText
})
debug.animation = animator.getDebugSnapshot()
// 调试透传：
animator.setPose('sit', 300)    // true；'auto' 清除强制；未知 id 返回 false
animator.setGaze(25, 0)         // 度；NaN 清除
```

- `getDebugSnapshot()` 字段与契约一致：`pose/poseWeight/activeLayers/gesture/blink/smile/mouthOpen/lookYaw/
  missingBones/morphs/gaze/footErrorPx/spring/updateMs`；
- 启动自检：必需骨/姿态引用骨缺失 → `missingBones` + `console.warn`（不抛、降级写）；
  morph 缺失 → `console.warn`（不写进 `missingBones`，该字段语义是骨骼；本模型 85 morph 全在）；
- `setPose` 是**调试强制**：会一直锁住该姿态直到 `setPose('auto')`（或再次 setPose）；
  进入拖拽/腾空时基础姿态仍按 B2 状态覆盖（安全优先）。

---

## 7. 自测

```bash
pnpm exec vitest run tests/animation-        # 6 文件 / 102 用例全绿（quat/blend/pose-machine/
                                             # leg-ik/grounding/blink/emotion/viseme/look-at/spring/
                                             # state-map/完整 pipeline）
pnpm typecheck                               # 自己文件 0 错误（其余 teammate WIP 错误不归本模块）
```

覆盖要点：slerp 短弧/端点、层顺序/mask/additive、pose-machine 打断后视觉连续、IK 精度与退化输入、
髋高补偿、脚底误差 <2px、眨眼序列/双眨/笑眼裁决、情绪 max/衰减/钳制、口型序列与收尾、
注视死区/钳制/分配守恒/平滑收敛/回落、弹簧收敛/确定性/dτ=0.1 不爆炸、12 个 mood 穷举、事件优先级、
待机变体权重/冷却/不重复、完整管线 600 帧无 NaN。

性能预算（survey §7.3）：混合 ~20 骨 × 4 层 + 6 腿骨 IK + 6 发骨 × ≤4 子步 + ~15 morph 写值，
估算 <0.1ms/帧；`debug.updateMs` 由 scene-bridge 用注入时钟实测（30fps 预算 <0.5ms）。不新增 draw call。

---

## 8. 已知限制 / 待视觉校准项（Lead 截图回环）

1. **第一批数值是设计起点**：12 姿态 + 6 待机变体 + 6 反应的肩/肘/腕角度需要按实机截图微调
   （尤其「手戏」：捻筹码/抛接/整理衣领的可读性）；节奏（慢—快—停半拍）已按 brief 排好；
2. **坐/睡重心**：`sit/sitEdge.centerY = -12.226`（髋坐到 bind 地面高度）、`sleep.centerRollDeg = 80`+`centerY = 0.5`
   是解析估算，可能需 ±0.5 单位微调；侧躺翻滚是写 `センター.quaternion`（B3 允许的 bone 旋转）；
3. **facing**：B3 不写 root；注视层假设 Lead 在 root 层用 ±90° Y 旋转表达 `left/right`，若 Lead 不旋转 root，
   则 facing='left/right' 时注视角会被钳到边界（README 已注明换算公式）；
4. **注视回落语义**：鼠标目标消失后注视按 τ=90ms 平滑归零（<1s 回到 0，满足冒烟），
   `GAZE_TIMEOUT_MS=2500` 用于「2.5s 后彻底清空 active 状态」——两者是同一回落曲线的不同阶段；
5. **口型中文**：无拼音库，汉字按码点确定性映射到 5 个元音（视觉上随机开合）；日文假名/英文元音是精确映射；
   若后续接 TTS/拼音表，只需替换 `viseme.ts` 的 `textToVisemes`；
6. 弹簧只做 6 根发骨（无碰撞、无袖子）；若截图发现辫子穿模，再加头部球体碰撞/袖子链；
7. `footErrorPx` 是「解算角度回推 vs 目标」的内部一致性误差，不是屏幕像素测量（屏幕像素由 Lead 冒烟/截图断言）。

---

## 9. v2「生动性」改造（用户实机反馈后，2026-11-08）

> 用户反馈原话：「动作太僵硬了，僵尸都比这个像活人」「横着往上走很诡异」。
> v2 的目标：**宁可幅度小但一直在动**，任何姿态都不再是定格；爬/走不再像摆拍。

### 9.1 做了什么

1. **连续微动层 `micro-motion.ts`**（所有姿态每帧叠加，永不静止）：
   - 呼吸：胸腔/肩 0.7–1.5°、0.23Hz；
   - 重心缓慢摆动：骨盆 roll/yaw ±2°、0.11Hz + 0.075Hz 不可通约叠加；
   - 头/颈延迟跟随：相位比躯干滞后 0.5–1.0 rad（身体先动、头后到）；
   - 手臂/手腕 follow-through：大臂→肘→腕依次滞后，左右相位错开（不对称）；
   - 手指收放：每只手 2–3 根（人指 1–2、中指 1–2、小指 1），±2–3°，`MICRO_BONES`；
   - 无 look-at 目标时叠加极慢头漂移（0.035/0.021Hz，≤1.5°），人不会一直盯正前方；
   - 幅度按姿态缩放（睡眠 0.45、拖拽/下落 sway 1.6–1.8、走路手臂 1.2）。
2. **姿态过渡错峰 + 预备动作**：
   - `blendPoseMapsStaggered`：骨盆/腿先到 → 躯干 0.02s → 肩 0.035s → 大臂 0.05s →
     肘 0.065s → 手/手指 0.08s，**不再所有骨同时到达**（木偶感主因）；
   - 切姿态后 0.14s 的「反向蓄力」预备动作（胸腔后收 + 下巴微收 + 轻微下蹲），再被目标姿态带走；
   - 过渡时长整体加长（站 0.3s / 走 0.35s / 坐 0.55s / 睡 0.75s）。
3. **自然走路**（`gait.ts`）：脚跟着地（脚尖上翘 12°）→ 全掌 → 脚尖蹬离（下压 18°），
   摆动相抬脚 1.1 单位、膝屈由 IK 自动产生；骨盆旋转 4.5°、胸腔反向、头稳定；
   左臂摆 17° / 右臂 11° 的**不对称**反摆 + 肘/腕延迟；重心双峰起伏。
4. **爬行重做**：身体保持**竖直贴墙**（前倾仅 6°），双手交替上抓（肩抬 4.5°、肘 38° 交替伸缩）、
   对侧膝盖抬起 34°、脚背下压；躯干只有 ±2–3° 侧摆——修正「横着往上走」的观感。
5. **注视分层 lag**：目先 τ=50ms、首 τ=120ms、頭 τ=170ms（眼睛先看到、头慢慢跟过去）。
6. **弹簧 v2**：参数更软更响应（发辫 stiffness 12/damping 5.2/gravity 2.8/inertia 0.75），
   新增**袖子弹簧**（左右各 5 根，`左袖帶1-1..1-5` 权重 360 最显眼）；
   修正了 rest 方向按「下一关节 − 父骨」计算的错位 bug；链式父角速度封顶防「袖子甩飞」。

### 9.2 v2 证据（可复跑）

```bash
PET_PROFILE=anim PET_DEV_CAPTURE_DIR=tests/tmp/anim-caps-v2 \
PET_DEV_CAPTURE_POSES=stand,stand,stand,stand,walk,walk,walk,climb,climb,climb,celebrate,sleep \
PET_DEV_CAPTURE_HOLD_MS=420 PET_DEV_CAPTURE_IDLE=1 PET_DEV_CAPTURE_CENTER=1 pnpm dev
```

- `tests/tmp/anim-caps-v2/sheet.png`：12 张姿态/动作接触表；
- `tests/tmp/anim-caps-v2/micro-motion.gif`：同一 stand 连续 4 帧（0.42s 间隔）→ 可见呼吸/重心/头漂移/发丝在动；
- `tests/tmp/anim-caps-v2/micro-diff.png`：两帧差分放大 6 倍（全身轮廓 + 头发/袖子/手指区域都有位移）；
- 站姿连续帧像素差：约 **17–21/255 均值、2.5 万+ 像素发生变化**（此前静态姿态为 0）；
- `animation.spring` 调试字段：发辫 2–24°、袖子 0.1–52°（站立 <2°、动作中摆动），不再失控。

### 9.3 仍需视觉校准/协作的点

1. **坐姿（sit/sitEdge）截图受限**：dev 截图把宠物放在屏幕底部，坐姿腿垂到屏幕外；
   需要 Lead 在「窗口上沿」场景截图（或行为触发 sit）才能验收坐窗沿效果；
2. **walk 侧面观感**：宠物始终面向镜头，前后摆腿在正面投影下不明显；已用抬脚/骨盆摆动/不对称摆臂增强可读性，
   建议 Lead 用行为 walk 连续截图（`PET_DEV_CAPTURE_ACTIVITY=walkTo` 或 warmup 后连拍）确认；
3. **climb 行为截图**：已按「竖直贴墙 + 四肢交替」重做姿态，需 Lead 用 `PET_DEV_CAPTURE_ACTIVITY=climb`
   抓行为中的实际移动方向，若 B2 是沿窗口侧边竖向移动应已正常；
4. 微动幅度可继续按用户主观反馈增减（当前单骨 ≤3°，集中在头/肩/手腕/手指/衣摆）。

---

## 10. v3「自然度」改造（用户第 2 轮实机反馈：默认站姿像人偶）

> 用户反馈：「默认动作还是很诡异/僵硬，没有优化感」。根因不是「没有微动」，而是**姿态本身像人偶**：
> 对称正面站、五指张开、腿直、没有重心。v3 逐项重做（全部在 animation/ scope 内，API 不变）：

1. **contrapposto 默认站姿**：`centerX=+1.1`（重心压左腿）+ 慢层「承重脚」每 8–15s 换一次（±1.2~1.9 模型单位、
   1.1s smoothstep）；骨盆 roll 3.5°/yaw −1.5°、肩线 +3/−1、上半身反扭 −2.5°、双脚前后差 + 外八、
   `crouch=0.3` 软膝。
2. **手不再五指大张**：28 根指骨**静态半握**（人指/中指/薬指/小指/親指 ×1–3 节，绕 Z 18–40°，左右镜像）
   + 手腕内旋；右臂「插兜预备」（Z+32 / Y−22 / 肘−58）让手落在胯侧；左臂自然垂 + 肘微屈。
3. **腿/贴地**：软膝 + 站距/前后脚；髋高补偿把「重心侧移 → 腿竖向投影 ×cos」纳入计算，
   实机 `footErrorPx` 由 1.2–5.8px 降到 **0.0**（此前重心侧移会把脚抬高几像素，看起来「坐空气」）。
4. **idle 变体轴向修正**：手臂前摆 = **Y**（左负/右正）、抬举 = **Z**（左正/右负）、肘 = X；
   伸懒腰 Z±122 举过头顶；整理衣领改 Y 前摆 + 肘深屈（手到胸前而非侧平举）；两指敬礼 Z−34/Y+52+肘−112；
   抛接硬币改向前/胸前；伸懒腰收臂加前下方中间帧（避免 slerp 扫过 T-pose）。
5. **微动放大**：呼吸胸 1.2–1.5°、骨盆摆 ±3°、头/颈延迟 1.0–2.4°、极慢头漂移 ≤4°、手指收放，
   5 个不可通约频率（0.23/0.17/0.11/0.075/0.19Hz）。
6. **3/4 侧身**：`センター` 绕 Y +8°（头局部回 −4.5° 朝向镜头），walk/pat/busy/sad/celebrate 同样带 3/4 朝向；
   注视层按身体 yaw 补偿鼠标角度（鼠标注视扣掉身体 yaw，调试 setGaze/手势 gaze 按身体局部角）。

调试辅助：`setPose('gesture:<id>')` 可直接播放一次待机/反应手势（dev 连拍逐个变体验证轴向用），
例如 `PET_DEV_CAPTURE_POSES=gesture:adjustCuff,gesture:adjustCuff,gesture:stretch,...` 配合 HOLD 采样手势中段。

v3 证据：`tests/tmp/anim-v3-final2/sheet.png`（12 帧 idle）、`tests/tmp/anim-v3-gest2/sheet.png`
（各变体多帧轴向验证）、`tests/tmp/anim-v3-walk/sheet.png`（行为触发截图，当前 activity 未真正移动，待 Lead 抓连拍）。

已知限制：dev 截图里低头是因为 capture 鼠标停在左下、look-at 生效（实机会跟随用户鼠标）；
walk 行为连拍、sit/sitEdge 抬高场景截图仍需 Lead 协助采集后继续微调。
