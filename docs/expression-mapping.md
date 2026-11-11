# V6 表情层：HSR Emo_ / Mate-Engine 表情 → 目标 VRM 预设表情（「表情对应」）

- 日期：2026-11-08 · 状态：**数据管线 + 可接线运行时模块 + 预览证据完成**（app 实机接线属 V6，未在本轮）
- 范围（用户 2026-11-08 指定）：
  1. **Wave 1.0 HSR 动作包还没做完的部分** = HSR 官方 FBX 的 `Emo_*` 表情动画（17 条脸骨 take，
     当时结论「不能直接驱动 VRM expression，走 V6 表情层」）；
  2. **Wave 1.5 Mate-Engine 里的表情对应** = `FACE_LAYER/` 等 face 动画（VRM 0.x 表达名 blendshape）；
  3. 两者统一**映射到模型自带的预置表情**（目标 VRM 的 VRM 1.0 preset），并交付
     「数据 + 工具 + 可接线的纯运行时模块 + 预览证据 + 回归测试」。
- 交付入口：
  - 契约：`src/shared/expression-contract.ts`（新增，加法式；不改 `vrm.ts` / `animation-contract.ts` 既有语义）
  - 运行时：`src/renderer/src/vrm/expressions.ts`（纯函数，无 three/DOM 依赖，V6 接线即用）
  - 管线：`scripts/vrm/expression/**`（README 见 `scripts/vrm/expression/README.md`）
  - 数据：`assets/expressions/{mate,hsr}/**` + `manifest.json`（**私有，gitignore**）
  - 测试：`tests/expression-*.test.ts`（6 个文件 / 100 用例）
  - 证据：`tests/tmp/expression/preview/**`（93 帧 + 21 张接触表）、`tests/tmp/expression/hsr-decode-report.json`

---

## 0. 一页结论

| 项 | 结果 |
|---|---|
| 数据 | **17 条表情 clip**：Mate-Engine 7（faceIdle/Drag/Smile/HairStroke/Reset/petHappy/petTalking）+ HSR 10（5 个 PhotoGraph 姿态 + 闭眼/笑眼 + 眩晕/受击 + IdleShow） |
| 映射 | Mate-Engine：`VRM0 → VRM1 preset` 1:1（`Joy→happy / Sorrow→sad / Fun→relaxed / A·I·U·E·O→aa·ih·ou·ee·oh / Blink*→blink* / Neutral→全零`）；HSR：73 根脸骨 → 眉/眼/口三层强度 → preset 组合 |
| 目标模型 | `aventurine-tpose.vrm` 17 preset（无 neutral、有 sad/relaxed）+ 78 custom；`happy/relaxed` 自带 `overrideBlink=blend` |
| 缓存/时长 | Mate 过渡照抄 Unity 状态机固定秒数（0.5 / 1.0 / 0.2 / 0.25 / 0.05s）；HSR 静态姿态 0.2s 淡入淡出、受击 0.1/0.25s |
| 校验 | `validate-expression-clips --vrm aventurine-tpose.vrm`：**17 PASS / 0 WARN / 0 FAIL**（含轨道名在目标模型真实存在） |
| 跨实现对拍 | Mate：与 lane A 独立 Python 解析（Unity Hermite）逐帧最大差 **0.0001**；HSR：与 lane B 独立 Python 解码（OMP+NNLS）逐 clip preset 均值 **完全一致**（差 0.000；gentle/shy 的 -0.2 是配置的 preset 上限 0.8） |
| 预览 | `tests/tmp/expression/preview/presets-face.jpg`（13 preset + neutral 基线）、`presets-full.jpg`、17 张 `clip-*-sheet.jpg`、`combos.jpg`（运行时组合） |
| 回归 | `pnpm test` 从 baseline **87 files / 1422 passed / 14 skipped** → 终态 **93 files / 1531 passed / 14 skipped**；`pnpm typecheck` exit 0；v1 legacy PMX/VMD 路径零改动 |

---

## 1. 研究结论（先调查再动手）

三条并行研究 lane 的产物（gitignore）：`tests/tmp/expr-web/NOTES.md`（20 条引用）、
`tests/tmp/expr-mate/REPORT.md`（Mate-Engine 控制器/逐通道）、`tests/tmp/expr-hsr/`（HSR 采样/解码/图表）。

### 1.1 规范/实现事实（verified，含出处见 `tests/tmp/expr-web/NOTES.md` §6）

1. **VRM 1.0 preset 全集 18 个**，全部可选；`neutral` 不是 preset（morph 绑定为 0）→ 业务 neutral
   必须实现为「expression 全清 0」。`fun` 在 VRM0→1.0 迁移中归一到 `relaxed`（VRM 规范/UniVRM/
   three-vrm v0compat/Mate-Engine C# 四源一致）。
2. **override 语义**：`multiplier = max(0, 1 − Σ overrideAmount)`；`block` 取 0/1、`blend` 取权重。
   three-vrm 每帧 `clearAppliedWeight()` + 全量重算。**目标模型只有 `happy`/`relaxed` 带
   `overrideBlink=blend`**（自动压眨眼）；78 个 custom 全无 override（若将来驱动 `笑い/慈愛` 等
   闭眼 custom，应用层必须手动压 blink）。
3. **three-vrm 3.5.5**：`setValue` 会 clamp 到 0..1、未知 expression 静默无效；
   `VRM.update` 顺序 humanoid→lookAt→expression→constraint→spring→materials；
   表情应用逻辑必须写在 `vrm.update(dt)` **之前**。目标模型 `lookAt.type=bone`，
   `look*` preset 实际绑的是虹膜/高光位移 morph → **不驱动**，视线走骨骼/lookAt。
4. **MMD 属性是加算的** → 必须做「通道预算」：情绪互斥、口型单主、符号/材质表情限幅。
5. HSR 73 骨 → VRM expression **没有公开成品**；可行路线 = 自写特征解码（参照 ARKitMapper 的组合子
   范式 + StarRailMotionCapture 的骨→blendshape 烘焙思路）。本项目的实现见 §3.3。

### 1.2 Mate-Engine 控制器事实（lane A 全库扫描 + 控制器 YAML 解析）

- 全库 **128 条 `.anim` 只有 9 条含 face blendshape**；去重后 **6 个唯一表情程序 + 1 个口型程序**：
  `FACE_IDLE_1`(10.03s, blink+ee)、`FACE_SMILE`(4s, happy+aa)、`FACE_DRAG = FACE_INTIME`(10.03s, sad+oh)、
  `FACE_HAIR_STROKE`(10.03s, happy+oh)、`FACE_RESET`(1.98s, 全零)、`PET_HAPPY`(1s 孤儿)、
  `PET_TALKING`(1s, aa/ee/oh)。13 个源通道实际只用到 6 个。
- 出货控制器 = `AvatarAnimatorControllerV2 1.controller`；Face Layer Override 权重 1、无 AvatarMask、
  **Write Defaults=1（整脸由当前 clip 全权定义）**；固定过渡：0.5s（idle↔）、**1.0s（摸头）**、
  0.2s（拖拽/亲密）、0.25s（顺毛）、0.05s（说话）；优先级 Drag > Intime > HairStroke > HeadPat > idle。
- 触发门槛：摸头/亲密 hover 只在 Base Layer state=`Idle` 时生效；摸头还需画圈/来回蹭手势。
- 语义：`FACE_SMILE` = **Head Pat（摸头）**；`FACE_HAIR_STROKE` = 大屏顺毛；`FACE_RESET` 是默认态
  （全零）；`PET_HAPPY` 是无控制器引用的孤儿素材。

### 1.3 HSR `Emo_*` take（lane B 实测）

17 条 take = 73 根脸骨动画（不是 blendshape），按游戏的脸部三层组织：
**眉 13 骨 / 眼 19 骨 / 口 30 骨**（另有 10 根注视骨 + `joint_face` 根）。其中 5 条 PhotoGraph 静态姿态
（Angry/Gentle/Shy/Surprise/Trouble）、3 条 Close 眼型、Blink、CloseEye、Default/Brow/Eye/Mouth、
Idleshow（8.35s 动态）、Battle_Hit（1s 一次性）、Battle_Stun（0.33s 闭眼紧皱）。

### 1.4 目标模型 expression 事实（GLB 解析 + 实机预览）

- 17 preset（**无 neutral**、有 `sad`/`relaxed`）+ 78 custom（其中 `照れ/目影消/目影濃` 只有材质绑定）；
  `happy = 上 0.3 + 笑い 1.0`（闭眼笑）、`relaxed = 上 0.2 + 慈愛 1.0`、`sad = 困る + 心配する`、
  `angry = 怒り 0.5 + ｷﾘｯ 0.3`、`surprised = 上 0.7 + びっくり 1.0`；口型 5 preset 绑 MMD あ/い/う/え/お。
- 预览确认 13 preset 全部可用（`presets-face.jpg`）；`look*` 是虹膜/高光位移，不进表情层。

---

## 2. 数据管线

```
Mate-Engine .anim (60fps YAML) ──parse/Hermite/30fps──▶ ExpressionClip ─┐
                                                                        ├─▶ assets/expressions/manifest.json
HSR FBX Emo_* (60fps 脸骨) ──Blender 采样──▶ 采样 JSON ──OMP+NNLS──▶ ────┘        │
                                                                                 ▼
                                                preview-expressions.mjs（three-vrm 渲染证据）
                                                V6 接线：VRMExpressionDriver（纯模块）
```

文件与命令见 `scripts/vrm/expression/README.md`。关键设计：

- **统一数据形状** `ExpressionClip`（`src/shared/expression-contract.ts`）：逐帧、按 VRM expression 名
  存 0..1 权重；帧数约定 loop = `round(duration*fps)`、non-loop = `round+1`；`fadeInSec/fadeOutSec`
  记录播放过渡（Mate 来自 Unity 状态机固定秒数）。
- **私有数据**：`assets/expressions/**` gitignore；仓库只提交脚本/配置/测试/文档。
- 所有 CLI 支持 `--check` 幂等对比、`--json` 报告、exit code 0/1/2 约定。

### 2.1 Mate-Engine 映射（`config/mate-face.json`）

| 源 VRM0 表达 | 目标 VRM1 preset | 说明 |
|---|---|---|
| Joy | happy | 目标 happy 内含 笑い（闭眼笑），自带 overrideBlink=blend |
| Sorrow | sad | |
| Angry | angry | |
| Fun | relaxed | VRM0→1.0 官方归一化 |
| Neutral | —（全零） | 无 neutral preset；`FACE_RESET` 导出为空 tracks clip 供数据完整性 |
| Blink / Blink_L / Blink_R | blink / blinkLeft / blinkRight | 源 face clip 自带眨眼图案 |
| A / I / U / E / O | aa / ih / ou / ee / oh | 口型；I/U 在源里恒 0 |
| LookUp/Down/Left/Right | 不映射 | 视线走 lookAt（目标 look* 是虹膜 morph） |

导出的 7 条 clip（id / 源 / loop / fade / 轨道）见 `docs/expression-mapping.md` §2.3 或
`assets/expressions/manifest.json`。**Unity 曲线用三次 Hermite（存盘 inSlope/outSlope）重采样**，
与 Unity 运行时一致（与 lane A 的独立实现逐帧最大差 0.0001）。

trim 决策：`FACE_INTIME` 与 `FACE_DRAG` 逐键位相同 → 同一份数据挂在 `['drag','intime']` 两个触发；
`FACE_SMILE 1` 与 `FACE_SMILE` 相同 → 不重复导出；`HoverFace.anim` 是全身姿态不含 blendshape → 不导出；
`PET_HAPPY` 是孤儿素材 → 作为一次性「开心」候选。

### 2.2 HSR Emo_ 映射（`config/hsr-emo.json`）

导出 10 条（17 条 take 中剔除中性基线/单次眨眼/重复眼型）：

| clip id | 源 take | 输出轨道（max） | loop | 用途/说明 |
|---|---|---|---|---|
| photoAngry | PhotoGraph_Angry | angry 0.92 | Y | 生气姿态（0.2s 淡入淡出，常值保持） |
| photoGentle | PhotoGraph_Gentle | relaxed 0.80 | Y | 温柔（上限 0.8：目标 relaxed 偏强） |
| photoSurprised | PhotoGraph_Surprise | surprised 1.00 | Y | 惊讶 |
| photoShy | PhotoGraph_Shy | sad 0.80 | Y | 害羞（preset 近似；高保真需 custom 笑い+困る） |
| photoTrouble | PhotoGraph_Trouble | angry 0.20 | Y | 困扰（preset 近似；custom やっかい 才是精确解） |
| eyesClosed | Close01_Eye | blink 1.00 | Y | 静态闭眼保持 |
| smileEyes | Close02_Eye | happy 1.00 | Y | 笑眼 |
| stunFace | Battle_Stun | blink 1.00 + angry 0.60 | Y | 眩晕/受击闭眼紧皱 |
| hitFace | Battle_Hit | angry→1.00, blink→1.00 | N | 1s 受击：闭眼→怒视 |
| idleShowFace | Idleshow | angry/relaxed/surprised ≤0.11 + blink 1.00 | Y | 8.35s 待机脸部循环（眨眼时序为主） |

未导出：`emo_default`/`Default_Brow/Eye/Mouth`（中性基线）、`emo_blink`（程序化眨眼已覆盖）、
`emo_close_eye`（与 Close01 相同）、`emo_close03_eye`（preset 输出与 Close02 相同，只有 custom 差异）。

### 2.3 数据规模

| set | clip 数 | 数据体积 | fps | 帧数范围 | 轨道 |
|---|---|---|---|---|---|
| mate | 7 | 40 KB | 30 | 30–301 | blink/ee/sad/oh/happy/aa |
| hsr | 10 | 48 KB | 30 | 1–251 | angry/relaxed/surprised/sad/happy/blink |
| 合计 | **17** | ~88 KB | 30 | — | 仅 VRM1 preset（无 custom 轨道） |

---

## 3. 运行时模块：`src/renderer/src/vrm/expressions.ts`

> 纯逻辑，不 import three / DOM / Electron；随机源与时钟注入，Node 单测全覆盖；V6 接线层只做
> 「清零 + `setValue` 转发」。**这是 V6/V10 表情层可直接接线的核心交付。**

### 3.1 分层架构（对齐 Unity Face/Speak Layer + 规范加算语义）

```
情绪层（mood → PET_EXPRESSIONS → avatar manifest bindings，0.15s 交叉淡化）
  ↑ 一次性反应层（pat/poke/thrown/landed → happy/surprised…，1.2s 包络）
  ↑ 表情 clip 层（drag/pet/talk… → ExpressionClip 采样；支持两 clip 线性 crossfade、随机相位、
                   clip 自带 blink 轨道时程序化眨眼让位）
  ↑ 眨眼层（2.2–6.5s 随机间隔 + 15% 双眨 + 强制眨眼；拖拽/摸头/顺毛期间压制；笑眼权重高时 ×0.5）
  ↑ 口型层（气泡文本 → あいうえお → aa/ih/ou/ee/oh；单主口型 + 30ms 交叉淡化）
合成：同 expression 取 max；说话时情绪层 ×0.85；全部 clamp 0..1
```

### 3.2 API（V6 接线 3 步）

```ts
const driver = new VRMExpressionDriver({
  bindings: avatar.expressions,                    // vrm-manifest 的业务表情绑定（已补 sad/relaxed）
  clipLookup: (trigger) => expressionClipRegistry.get(trigger) ?? null,
  random: Math.random
})

// 每帧（vrm.update(dt) 之前）：
const snapshot = driver.update(dt, { mood, events, dragging, bubbleText })
applyExpressionWeights(vrm.expressionManager, snapshot.weights, vrm.expressionManager.expressionMap 的键)

// 事件：driver.forceBlink()；一次性 clip：driver.playClip(clip)；停止：driver.stopClip()
```

- `snapshot.weights` 可直接逐项 `expressionManager.setValue(name, weight)`；
  `applyExpressionWeights()` 先对已知 expression 清零再写入（three-vrm 每帧清权重，不能"设一次忘了"）。
- `snapshot` 还提供 `baseExpression / trigger / clipId / clipBlending / blinkWeight / blinking /
  viseme / speaking` 供调试面板（V6 可接 `window.__aventurineDebug` 风格）。
- 缺绑定/目标模型没有的 expression 自动跳过（不崩）；业务 `neutral` = 全零。
- `happy`/`relaxed` 的 `overrideBlink=blend` 由 three-vrm 自动处理（无需应用层再压）。

### 3.3 与 Mate-Engine 源语义的对应

- 触发映射：`pat→faceSmile`（Head Pat，1.0s 淡入是观感关键）、`drag→faceDrag`（0.2s，
  拖拽时压制程序化眨眼 = 源 Blink=0）、`talk→petTalking`（0.05s；默认仍用文本口型，clip 为
  Mate 同款备选）、`happy→petHappy`（一次性）、`hairStroke/intime` 为手动/未来触发。
- 随机相位：loop clip 从随机相位起播（避免 10s 眨眼图案每圈一样）。
- 过渡：clip 层按 clip 自带 `fadeInSec/fadeOutSec` 在两 clip 间线性 crossfade（等价 Unity
  固定秒数过渡），不是 max 硬切。

### 3.4 HSR 解码器（`scripts/vrm/expression/lib/hsr-face.mjs`）

1. 中性 = `emo_default` 首帧；每骨 local 四元数增量 × rest 朝向 → armature 空间旋转向量，按层拼特征；
2. 每层以校准姿态为基：**OMP 选 ≤3 个基 + NNLS（权重上限 1.5）** → 层强度（稀疏、可解释；
   普通 NNLS 在共线基上会摊开权重，故用 OMP）；
3. 层强度 → preset：按目标模型 preset 的 morph 组合加权（如 `angry = 0.5·brow_angry + 0.3·eye_angry +
   0.12·mouth_angry + …`），带互斥门控（怒眉下不判 happy/surprised/relaxed）与 blink 特殊处理
   （笑眼闭眼只在 happy 未成立时计入 blink）；每条 clip 可配 `presetCaps`（如 gentle 的 relaxed ≤0.8）。
4. 采样帧数归一：源含首末两端 → loop clip 去掉末帧、duration = frames/fps。

---

## 4. 验收 / 证据

| 项 | 结果 | 位置 |
|---|---|---|
| 数据校验 | **17 PASS / 0 WARN / 0 FAIL**（schema/帧数/轨道/权重/loop 接缝 + 轨道名真实存在） | `validate-expression-clips --vrm ` 输出；`tests/tmp/expression/validation-report.json` |
| manifest | 17 条、无 missing/多余、元数据与 clip 一致、`--check` PASS | `assets/expressions/manifest.json` |
| Mate 采样对拍 | 与 lane A 独立 Unity-Hermite 实现逐帧最大差 **0.0001**（idle blink），其余 0 | §1 说明；lane A REPORT §10 |
| HSR 解码对拍 | 与 lane B 独立 Python OMP+NNLS 解码：10/10 clip preset 均值一致（差 0.000；两处 -0.2 为配置上限） | `tests/tmp/expression/hsr-decode-report.json` |
| 预览 | 13 preset + neutral 基线脸特写 + 5 个全身；17 clip × 4 帧接触表；6 个运行时组合 | `tests/tmp/expression/preview/**`（93 帧 + 21 sheet） |
| 运行时单测 | 23 用例：表一致性/眨眼调度/文本口型/clip 层 crossfade+相位/驱动分层/拖拽压制 blink/接线写入 | `tests/expression-runtime.test.ts` |
| 契约单测 | 30 用例：sanitize/采样/帧数/manifest/绑定/淡入淡出 | `tests/expression-contract.test.ts` |
| 管线单测 | Mate 解析/Hermite/映射/配置（14）、clip 工具/QA（16）、HSR 解码（11）、CLI e2e（8） | `tests/expression-{mate-parse,clip-validation,hsr-decode,cli}.test.ts` |

预览图（私有证据，gitignore）：
`tests/tmp/expression/preview/presets-face.jpg`、`clip-hsr-photoAngry-sheet.jpg`、
`clip-mate-faceSmile-sheet.jpg`、`combos.jpg`。

---

## 5. 与目标的偏差 / 实现取舍

1. **不搬源面部 rig**（用户要求「可以用我们模型自带的预制表情包」）：所有输出都是目标模型**已有**
   preset 的权重组合；HSR 的 73 骨/牙齿/舌头、Mate 的 VRM0 blendshape 原始通道不进入播放层。
2. **只输出 preset 轨道**（未用 78 个 custom）：跨模型安全、运行时简单、观感可预期；custom 增强
   （照れ/目影/涙/にやり 等）留作后续可选项（`mapping-draft.json` 里有完整配方）。
3. **HSR happy 只能近似**：Emo_ take 里没有嘴角上扬通道 → happy 取「笑眼（Close02/03）」；
   HSR Shy（笑眼+嘴角下压）与 Trouble（困扰）preset 置信度低，已用 `presetCaps` 限幅并写入数据 note。
4. **口型双轨**：默认运行时用气泡文本驱动口型（观感更好）；`petTalking` clip 作为 Mate 同款备选
   （`talk` 触发，可显式 `playClip`）。
5. **睡眠**：Mate 原版睡觉时 Face Layer 不变（仍播待机眨眼）；本模块按 mood=`sleep` 给 blink 0.95
   闭眼（我们自行决定的合理修正，非源行为）。

---

## 6. 已知限制 / 风险

| # | 限制 | 影响 | 后续 |
|---|---|---|---|
| 1 | 目标模型无 `neutral` preset | 业务 neutral = expression 全清 0（已实现 fallback） | — |
| 2 | `happy` preset 是闭眼笑（笑い） | 长时间 happy 会一直闭眼；已在默认强度 0.55 限幅 | 需要睁眼笑时用 custom `笑い2/喜び`（V6 调优） |
| 3 | HSR 解码是**近似**：preset 组合是 3 层离散姿态的加权 | Shy/Trouble 语义偏差最大 | custom 增强（已具备配方/解码数据） |
| 4 | 眨眼双驱动 | 程序化 blink vs clip blink（faceIdle/idleShowFace）→ 运行时已实现「clip 含 blink 轨道则程序化让位」 | V6 实机确认观感 |
| 5 | 目标模型没有 jaw 骨、无 neutral、无舌头 morph | 张闭口/舌头细节无法 1:1 | 可补 expression 或接受近似 |
| 6 | 数据是私有游戏/参考资产 | 不进 git，不随 app 分发 | 红线不变 |
| 7 | app 仍是 legacy PMX 运行时（V1/V5 未接线） | 本轮交付是**数据 + 可接线模块 + 预览**，实机效果需 V6 接线 | V6/V10 |

---

## 7. 回归与提交

- baseline（本轮开工前）：`pnpm test` **87 files / 1422 passed / 14 skipped**；`pnpm typecheck` exit 0。
- 本轮改动**只新增**文件 + 两个数据/配置小改：
  - 新增 `src/shared/expression-contract.ts`、`src/renderer/src/vrm/expressions.ts`、
    `scripts/vrm/expression/**`、`tests/expression-*.test.ts`、`tests/fixtures/expression/**`；
  - 修改 `.gitignore`（+`assets/expressions/`）；
  - 修改 `src/shared/vrm-manifest.json`：目标模型补 `sad`/`relaxed` 绑定、移除无效的 `neutral` 绑定
    （W0-3 备注里预留的 V6 修正；canary 条目未动）。
  - v1 legacy 动画/PMX/VMD 代码零改动。
- 终态（`tests/tmp/expression/test-after.log`）：**93 files / 1531 passed / 14 skipped**（+6 files/+109 tests，全部为新增表情层用例）；`pnpm typecheck` exit 0；数据校验 **17 PASS / 0 WARN / 0 FAIL**。

## 8. 复跑与回滚

```bash
# 数据全链路（需要 refs/Mate-Engine + HSR FBX + 目标 VRM，均私有）
node scripts/vrm/expression/extract-mate-face.mjs
"$BLENDER" -b --factory-startup --python scripts/vrm/expression/sample-hsr-emo.py -- \
  --fbx "$HSR_FBX" --config scripts/vrm/expression/config/hsr-emo.json --out assets/expressions/_samples
node scripts/vrm/expression/decode-hsr-emo.mjs
node scripts/vrm/expression/build-expression-manifest.mjs \
  --configs scripts/vrm/expression/config/mate-face.json,scripts/vrm/expression/config/hsr-emo.json
node scripts/vrm/expression/validate-expression-clips.mjs --vrm assets/vrm/aventurine-tpose.vrm
node scripts/vrm/expression/preview-expressions.mjs --mode all --out tests/tmp/expression/preview

# 幂等检查
node scripts/vrm/expression/extract-mate-face.mjs --check
node scripts/vrm/expression/decode-hsr-emo.mjs --check
node scripts/vrm/expression/build-expression-manifest.mjs --check
```

**回滚**：本 lane 全部是加法式改动——`git revert <commit>` 即可回到 baseline；私有数据删
`assets/expressions/` 重新生成。`src/shared/vrm-manifest.json` 的绑定回退：恢复 `neutral: "neutral"`、
删除 `sad/relaxed`（不影响运行时：缺绑定即跳过）。

## 9. 下一步（V6 接线清单）

1. V1/V5 落地后，在 three-vrm 的 `vrm.update(dt)` **之前**调用 `VRMExpressionDriver.update()`，
   并用 `applyExpressionWeights()` 写 `expressionManager`；
2. 用 `petFetch`/`pet-asset://` 加载私有 `expressions/manifest.json` + 所需 clip（按触发键懒加载）；
3. 事件接线：`pat→faceSmile`、`dragStart/End→faceDrag`、`bubbleText→口型`、`DSH done/error→happy/sad`；
4. 调试面板暴露 snapshot（blink/clip/viseme/weights）；
5. 实机验收通过后，再决定是否启用 custom 增强（照れ/目影/にやり/やっかい 等，配方在 lane A 报告）。
