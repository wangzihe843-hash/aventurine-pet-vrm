# behavior —— B1 状态机 + 随机调度

> Scope：B1（`src/renderer/src/behavior/**`，不含 `mischief.ts`——那是 C2）。
> 契约：`src/renderer/src/core/wave2-contract.ts`（Lead 冻结）；接线说明：
> `docs/wave2-integration.md` §0/§1/§2/§3-B1；人设：`docs/aventurine-character-brief.md`。
>
> **纯 TS，不 import three / DOM / Electron / Node 内置，不新增依赖。**
> 桌面信息全部来自 `BehaviorInput.desktop`（B5 产出），时间来自 `input.nowMs`，
> 所有随机只经 `input.random`（单测注入 seeded RNG → 序列可复现）。

## 1. 状态机与优先级

**优先级（高 → 低）**：`drag > pat/poke 即时反应 > fall > DSH 外部反应 > 自主活动 > idle`。
（`update()` 分支顺序即此顺序；M-14 已把 pat/poke 分支移到 fall 之前，与本节口径一致。）

```
拖拽中（interaction.dragging / dragStart） ──► drag（hold，无注视）
        │ 松手（dragEnd）
        ▼
摸头/戳即时反应（events.pat / events.poke；空中/掉落中也立即表演） ──► pat（hold，有注视；1.7–2.4s / 0.9–1.4s）
连续摸头 10s 内 ≥3 次 → poseHint `pat:annoyed`（嘴硬，不卖萌）
        │ 反应到期（fallState 不被清掉，继续跟踪）
        ▼
被甩出/空中（throw 速度 ≥520px/s 或 motion.airborne） ──► fall（hold，物理接管）
窗口关闭（transitions.closed 且宠物靠该窗口支撑） ──────► fall（首帧 drop 后 hold）
        │ 落地（grounded）/ 2.5s 兜底 → finishFall（落在可坐窗沿则 450ms 后优先坐下，N-2 绑定落地表面）
        ▼
DSH 外部反应（input.external / applyExternalReaction，未过期且 config.dshLink）
        │ 到期
        ▼
自主活动（加权随机 + 最短持续 + 冷却；可被上述任意交互/事件打断）
        │ 结束
        ▼
idle 基线（variable-time 调度下一次活动）
```

- 例外记录：**同帧「窗口关闭 + 摸头」时 fall 优先**（窗口事件让物理立即接管、首帧发 drop，
  `startFall` 会清掉刚建立的 reaction）；M-14 的口径针对「已经在 fall 中收到 pat/poke」，
  此时当帧即表演反应、物理与 fallState 继续。

- **`config.autonomous=false`**：不抽任何自主活动，只 idle + 响应交互/外部反应；
  `getDebugSnapshot().nextActivityInMs === null`。
- **最短持续**：实际时长 = `random(minDurationMs..maxDurationMs)`，到点前不会被自主调度替换；
  `minDurationMs` 同时是下限。
- **冷却**：每个活动有独立 `cooldownMs`；冷却中权重为 0（`triggerActivity` 也返回 false）。
- **鼠标回来会避让**：`hoverEnter` 时延后下一次自主活动 2.5s，并唤醒睡觉/望呆的活动。
- 同一时刻最多一个自主活动（单活动槽 + variable-time 间隔，避免 variable-ratio 式刷屏）。

## 2. 活动表（权重 / 时长 / 冷却）

权重还会乘以下文 §3 的上下文系数；`followWindow` 不参与随机（事件驱动，权重 0），
`climb` 也不参与随机（debug-only，`schedulable=false` + 权重 0）。

| id | debugId | 中文 | 权重 | 时长 ms | 冷却 ms | mood | poseHint | 注视 | 要求 |
|---|---|---|---|---|---|---|---|---|---|
| `idle` | idle | 站立待机 | 10 | 4000–9000 | 5s | idle | — | pointer | grounded |
| `idleCoin` | idle | 空手捻筹码 | 25 | 3200–4000 | 25s | idle | `idle:coin` | none | grounded |
| `idleToss` | idle | 抛接硬币看结果 | 18 | 2800–3500 | 30s | idle | `idle:toss` | none | grounded |
| `idleTidy` | idle | 整理衣领/袖口 | 22 | 2500–3500 | 20s | idle | `idle:tidy` | pointer | grounded |
| `idleStretch` | idle | 伸懒腰 | 15 | 3500–4500 | 45s | idle | `idle:stretch` | none | grounded |
| `idleGaze` | idle | 望远处发呆 | 12 | 6000–8000 | 60s | idle | `idle:gaze` | randomFar | grounded（可能说 idle 台词） |
| `idleSalute` | idle | 两指敬礼/招手 | 8 | 1500–2500 | 40s | idle | `idle:salute` | pointer | grounded + 鼠标靠近 |
| `lookAround` | lookAround | 四处看 | 12 | 2500–4500 | 18s | idle | `idle:scan` | randomFar | grounded |
| `walkTo` | walkTo | 走上/走下 | 20 | 2600–5200 | 12s | walk | `walk:stroll` | none | grounded（在当前表面横向走） |
| `returnCorner` | walkTo | 回到角落 | 10 | 3000–6000 | 30s | walk | `walk:home` | none | grounded |
| `climb` | climb | 爬窗沿（两段式，**仅 debug 显式触发**：自主已禁用，baseWeight=0/schedulable=false） | 0 | 4000–10000（按路径动态续期） | 30s | climb | `climb:window`（walk 段 `climb:approach`） | none | 有可爬/上方窗口（**不含 menubar**） |
| `sit` | sit | 坐窗沿/Dock | 24 | 20000–35000 | 25s | sit | `sit:window` | pointer | 有可坐表面（**仅 window-top / Dock**；menubar 不落座） |
| `sleep` | sleep | 睡觉 | 10 | 25000–45000 | 120s | sleep | `sleep` | none | grounded + 用户不在 ≥20s 且距交互 ≥12s |
| `dropDown` | dropDown | 跳下窗口 | 6 | 1200–2000 | 45s | fall | `fall:jump` | none | 站在窗口上沿/菜单栏/Dock |
| `followWindow` | followWindow | 跟随窗口 | 0 | 1000–1400 | — | walk 或 sit | `follow:window` | pointer | 事件驱动（`transitions.moved`）：站姿水平 walk / 坐姿重新下发 sit |

`schedulable=false` **只表示不进自主随机池**（`scoreActivity` 权重恒 0）：
`climb` 仍可通过调试 API `triggerActivity('climb', nowMs)` 显式触发（需有可爬/上方窗口，
两段式路径照常准备；2026-11-08 用户移除的是自主爬窗，debug 排查入口保留）；
`followWindow` 正常由窗口移动事件发起（调试触发没有可准备的目标，下一帧即 invalid 结束）。
调试触发不会把活动重新放回随机池。

### 2.1 落点过滤（Lead 的 B5/B2 边界决策，2026-11-08 集成）

- **`menubar` 不作为坐/站立落点**：overlay frame = workArea，菜单栏表面 `top=0`（窗口本地 y=0），
  宠物 feet 在 y=0 时整个身体渲染在 overlay 视口之外。B1 在 `behavior-director.ts` 里用
  `SITTABLE_SURFACE_KINDS = {window-top, dock}` 过滤 sit 候选、用
  `CLIMBABLE_SURFACE_KINDS = {window-top, window-side, dock, screen-bottom}` 过滤攀爬候选；
  菜单栏表面即使被 B5 标为 `sittable/climbable` 也不会被 B1 选中（可坐/可爬计数为 0）。
- **Dock（底部/Dock 上沿）可以坐/站**（在 workArea 内完全可见）；**window-top 也可以**。
- `menubar` 若将来只用于「扒着上沿探头」的视觉边缘（B3/B2 新增能力），再讨论是否加入；
  目前 B1 直接不使用它作为活动落点。B5 修改表面语义时同步改上面两个集合即可。
- **`elevated`（「站在高处」）口径（M-13）**：`window-top/menubar/dock` 且表面 `top` 至少高出
  workArea 底边 `ELEVATED_MIN_RISE_PX=8px` 才算高处。Dock 与地面同 top 时 **不是**高处
  （否则 `dropDown` 会原地跳）；Dock 上沿 / 菜单栏 / 窗沿仍会触发真实跳下。

### 2.2 `requirements` 枚举值（代码里就是这些，Lead 接线/冒烟可直接对表）

```text
idle          → ['grounded']
idleCoin      → ['grounded']            idleToss → ['grounded']       idleTidy → ['grounded']
idleStretch   → ['grounded']            idleGaze → ['grounded']       idleSalute → ['grounded','pointerNear']
lookAround    → ['grounded']            walkTo   → ['grounded']       returnCorner → ['grounded']
climb         → ['climbableSurface']    sit      → ['sittableSurface']
sleep         → ['grounded','mouseAway']                        // mouseAway 额外要求闲置≥20s 且距交互≥12s
dropDown      → ['elevated']            followWindow → []（schedulable=false，事件驱动）
// climb 同为 schedulable=false：不参与自主随机池，仅 debug `triggerActivity` 显式触发
```

`isRequirementMet(requirement, SchedulerContext)` 是唯一判定入口；权重为 0 = 不可抽。
`SchedulerContext.sittableSurfaceCount / climbableSurfaceCount` 使用上面的落点过滤结果
（menubar 不计入）。调试时 `countCoolingActivities(ctx)` 可数当前冷却中的活动数。

### 2.3 climb / follow 目标点算法（两段式；用户实机反馈「横着往上走很诡异」修正）

**climb（爬窗沿，debug-only）**——`prepareClimbTarget` + `updateClimbActivity`：
自主调度已按用户 2026-11-08 要求禁用（`schedulable=false`/权重 0）；本节算法只为
`triggerActivity('climb', nowMs)` 的人工排查保留，调试触发时与其他活动一样执行目标准备。

1. **候选**：脚底上方的 `window-top` 表面 + B5 提供的 `climbable` 表面（menubar 已过滤）；
   候选按「横向接近距离 + 竖直爬升距离 × 0.75」从近到远排序，爬升高度不足 24px 的不选。
2. **边缘 x**：`window-top` 取 `rect` 左/右边中离脚底更近的一侧；`window-side` 取 `rect` 中心 x；
   再钳制进 workArea 并留 8px 边距。**不选窗口顶部中点**（中点属于 sit 活动的位置）。
3. **第一段（walk）**：`{edgeX, 当前脚底 y}`，`motion={kind:'moveTo',mode:'walk'}`，
   速度 = `LEVEL_PACE.walkSpeedPxPerSec`（62/86/112）；facing 与水平运动方向一致。
4. **第二段（climb）**：`{edgeX, surface.top + 6}`，`motion={kind:'moveTo',mode:'climb'}`，
   x 固定、y 逐步减少，速度 = `LEVEL_PACE.climbSpeedPxPerSec` = **28/40/48 px/s（全部在 25–50）**；
   facing 朝窗口内侧（B2 的 facing 只用于姿态/朝向语义，不旋转模型）。
5. **到位**（距终点 ≤16px）：改发 `{kind:'hold'}`，B2 用 `CLIMB_SETTLE_SNAP_EPS_PX=24`
   吸附落到 `surface.top`（x 仍保持在边缘），活动结束 → `idle` 站在窗沿边缘；
   不会落到顶部中点（后续要坐由独立 `sit` 活动负责）。
6. 距离远时活动按路径动态续期（每帧 `endsAt = now + 2.5s`，安全上限 45s），
   不会爬到一半因 maxDuration 到点而松手掉落；目标表面消失/超时则结束（交给 fall）。

**followWindow（跟随窗口移动）**——`startFollowActivity` + `updateMovementActivity`：

- 站姿：`moveTo` 新表面顶边中点，**一律 `mode:'walk'`**（竖直位移由 B2
  「同窗口垂直移动自动吸附 top」处理）；**不再按 dy 推断 climb**，避免窗口上下移动时出现斜线爬。
- 坐姿（`activity.seated` / 当前 mood=sit）：重新下发 `{kind:'sit', surfaceId}`，
  由 B2 的 sit 接近逻辑执行；跟随活动结束后自动恢复坐姿（重新 start 一个 sit 活动）。
- 只匹配 `transitions.moved` 中 windowId == 宠物当前支撑窗口的事件；无关窗口事件忽略。

### 2.4 目标点可达性（H-3b）与窗沿自动坐下（N-1/N-2）

**运动目标可达（H-3b，契约字段 `BehaviorInput.motionLimits`）**：B2 的左右墙会按宠物半宽钳制
（可达 xRange = `[workArea.x + 半宽, workArea.right - 半宽]`），而旧目标只按 workArea 钳制 →
目标落进墙内不可达带时，宠物「原地走 + 活动永不结束」（returnCorner 永不到达、约 20% walkTo 原地走）。

- B1 在 `buildFrame` 读取 `motionLimits?: {minX,maxX}`（PetRuntime 依 workArea+petSize 计算）并 sanitize
  （两值有限、`minX<=maxX`、都落在 workArea 内；否则视为缺省）。
- 所有会下发给 B2 的 `moveTo` 目标（`cornerPoint`、`walkTo`、`returnCorner`、`followWindow`、
  movement/climb 路径段）统一经 `clampMotionTarget`：**x 钳进 `[minX,maxX]`（有 limits 时），
  y 仍按 workArea 钳制**；无 limits → 回退旧口径（workArea 全宽，兼容旧测试/无运行时限制调用方）。
- 移动类活动（walkTo/returnCorner/followWindow）在有 limits 时**按路径动态续期**（到达前每帧
  `endsAt = now+2.5s`，安全上限 45s）：目标可能很远（1600 宽 @86px/s 回右下角约 14s > 活动 3–6s），
  旧逻辑会走到一半就结束；无 limits 时保持旧时长口径（避免不可达目标变成长时间走墙）。
- 实测（1600×900 + 398 宽宠物 + motionLimits{199.07,1400.93}，10min ground-only）：
  cornerNeverArrived **4/4 → 0**、不可达目标 **0**；按「step 前后脚底位移」的正确口径，原地走 **0** 帧
  （旧 repro R7 的 stuck=1081/1081 是统计口径问题：它比较「帧前快照」与「上一帧 step 后状态」，恒相等）。

**窗沿自动坐下（N-1/N-2）**——`trySitOnWindowTop`：

- **N-2 绑定当前表面**：站在可坐 `window-top` 上方空闲 ≥`WINDOW_TOP_AUTO_SIT_DELAY_MS(700ms)`
  自动坐下；目标用 `frame.currentSurface` **显式构造**（surfaceId/windowId/surface 中心），
  不再走 `prepareActivity` 的「最近 3 个可坐表面随机」（旧实现约 52% 概率把目标定到旁边另一块窗沿）。
  落地 `finishFall` 的「优先坐下」同样记录 `preferredSurfaceId`，450ms 后绑定落地那块表面。
- **N-1 自动坐下间隔**：自动发起的 sit 结束后进入 `AUTO_SIT_GAP_MS`（20–40s）强制间隔，
  并把该活动冷却推到间隔结束（避免随机抽取又立刻坐下）；间隔内**其它自主活动照常抽取**；
  `sit` 自身冷却仍被尊重。宠物离开/切换到其它表面时重置间隔（并恢复被推后的冷却），
  重新放到窗沿仍可 ~700ms 内坐下。旧缺陷：坐 20–35s 后 700ms 又坐 → 150s 里 97.6% 帧在坐、
  其它活动 0、25/30 seeds 绕过 25s cooldown；修复后同场景 sit 占比约 44–55%、其它活动 ≥6 次/10min。

## 3. 权重上下文系数

| 因子 | 效果 |
|---|---|
| `autonomousLevel` | low：活跃类 ×0.55、待机类 ×1.35、睡 ×1.35，间隔 14–28s；normal ×1，间隔 8–18s；high：活跃 ×1.55、待机 ×0.72、睡 ×0.7，间隔 4.2–10s。首活动延迟 low 12–22s / normal 6–12s / high 3.2–7s |
| 窗口数量 | 坐/爬权重 × min(2.2, 0.55+0.4×表面数)；新窗口出现后 12s 内再 ×1.5 |
| 鼠标悬停宠物 | 互动类（敬礼/抛币/整理）×1.8；走/爬/坐/睡/跳下/回角落 ×0.12 |
| 鼠标靠近（≤420px） | 敬礼 ×2.2、睡 ×0.12、走/爬/回角落 ×0.7 |
| 用户不在（无鼠标或 >640px） | 睡 ×1.6、望呆 ×1.45、伸懒腰 ×1.2、走 ×1.15、敬礼 ×0.4 |
| 闲置时长 | 睡在 ≥20s 后 ×1.65（<20s 时 `mouseAway` 需求先不满足 → 权重 0，×0.35 分支实际不可达）；伸懒腰在 ≥90s 后 ×1.6；刚回 idle <4s 时活跃类 ×0.7 |
| 安静活动（H-5） | 待机小动作/四处看不打断 idle 基线累计（`idleElapsedMs` 继续增长）；走/坐/睡等活动会清零 |
| DSH 反应刚结束 15s 内 | 活跃类 ×0.55、待机类 ×1.2 |
| 连续重复 | 上一次同活动 ×0.2 |

`LEVEL_PACE` 还给出 B2 消费的速度：walk 62/86/112 px/s、climb **28/40/48 px/s**（low/normal/high，均落在用户要求的 25–50 区间）。

**sleep 可达性（H-5）**：`sleep` 的 `mouseAway` 需求要求 `idleElapsedMs >= SLEEP_MIN_IDLE_MS(20s)`，
但活动结束后的下一次抽取固定在 `LEVEL_PACE.idleDelayMs`（normal 8–18s / high 4.2–10s）——永远 <20s，
旧实现默认两档 **sleep 永不调度**（10min 仿真 sleepFrames normal/high=0）。修复：

1. 待机小动作/四处看这类「安静活动」不打断 idle 基线累计（见上表「安静活动」行）；
2. 鼠标离开时，idle 基线保证下一次抽取**不晚于** `idleSince + SLEEP_MIN_IDLE_MS + 抖动(0–5s)`
   （`buildAutonomousDecision` 取 min），让抽到 sleep 时需求已满足；鼠标在场时不做该提前调度。
3. 10min ground-only 仿真（seed 2026）：normal/high sleepFrames **0 → >0**（实测约 2.4k/3.4k 帧），
   low 仍可睡；且 non-idle 活动发起次数（normal ≥5、high ≥10）不出现活动饥饿。

## 4. 台词气泡池（B1 只负责文本，B3 负责姿态/表情）

- **台词来源（用户硬性要求，2026-11-08）**：全部使用《崩坏：星穹铁道》游戏内
  **砂金 / 砂金·戏浪 的官方中文语音原文**，单一来源 = `src/renderer/src/core/voicelines.ts`
  （Lead 抓取 BWIKI 两个语音页并逐条核对；**禁止自创/改写/仿写**，原文照录含「…」「？」等标点）。
  `dialogue.ts` 只做场景映射，不再自带文本；测试 `tests/voicelines.test.ts` 用官方原文集合兜底防回归。
- 场景映射（用户 2026-11-08 指示；同一句官方原文可跨场景复用）：
  - `idle` 闲置 = 关于自己（含戏浪「关于自己•戏浪/欢愉」）/ 闲谈•* / 爱好 / 烦恼 / 分享 / 见闻 / 关于角色系列 / 回合待机（两个版本全部收录，共 30 条）；
  - `celebrate` 完成庆祝、`dshDone` 任务成功 = 开启战利品（含「开启贵重战利品」）/ 终结技（激活/施放）/ 角色晋阶 / 角色满级 / 行迹激活（两个版本，共 15 条）；
  - `gloom` 沮丧、`dshError` 失败 = 无法战斗（「满盘皆输啊…」/「扫兴呐。」）；
  - `hover` 鼠标靠近 = 问候；`pat` 摸头 = 回合待机 + 返回城镇（休闲闲聊类）；
    `poke` 被戳 = 轻受击；`drag` 被拖拽 = 重受击；
  - `dshBusy` 任务开始 = 战技 / 秘技 / 战斗开始（准备行动，共 10 条）。
- 冷却（默认）：任意两句 ≥**60s**；同场景（category）≥120s；同一句 ≥300s；且不连续重复上一句。
- 只有「确实要说话」的帧才返回 `bubble`（摸头/戳/拖拽开始/悬停进入/望呆活动开始/外部反应首帧）；
  main.ts 负责显示时长与去重（气泡最大宽 340px，长句自动换行）。
- 外部 DSH 台词：`ExternalReaction.bubble` 由 B7 提供（同一来源 `core/voicelines.ts`），B1 只播一次
  （key = `mood:startedAtMs`），出现后刷新全局冷却，避免紧接着再冒自主台词；`config.dshLink=false` 时静默。
- 若外部反应 `bubble=null`，B1 会用同场景池兜底（dshBusy/dshDone/dshError）。

## 5. 对外 API

```ts
// src/renderer/src/behavior/index.ts
import { BehaviorDirector } from './behavior'

const director = new BehaviorDirector({ seed?: number, initialMood?: PetMood, random?: () => number })

director.update(input: BehaviorInput): BehaviorDecision        // 每帧一次
director.applyExternalReaction(reaction: ExternalReaction): void   // 可选（也可只用 input.external）
director.setRandom(random: () => number): void
director.getDebugSnapshot(): BehaviorDebugSnapshot            // main.ts 写 debug.behavior
director.triggerActivity(activityId: string, nowMs: number): boolean
```

`BehaviorDecision` 字段使用（契约同口径）：

- `motion` → `PetPhysics.setCommand(decision.motion)`（必须在 B2 `step` 之前）；
- `mood` / `facing` / `lookTarget` / `poseHint` → `PetScene.setAnimationInput(...)`（B3 消费；
  `PetMood → 姿态` 映射由 B3 内部完成，B1 不输出姿态 id）；
- `bubble` → main.ts 气泡显示（建议 3–4s，`bubble !== null` 时才刷新，避免每帧重置）；
- `lookTarget` 在睡觉/拖拽/掉落/DSH 反应时保证为 `null`（B3 不必再判）。

调试面推荐接线：

```ts
window.__aventurineDebug.behavior = director.getDebugSnapshot()
// debugTriggerActivity(activityId) → director.triggerActivity(activityId, performance.now())
```

`triggerActivity` 接受活动 id 或宽松别名（`walk`/`sit`/`sleep`/`coin`/`toss`/`tidy`/`gaze`/
`salute`/`scan`/`corner`/`jump`/`follow` …）。调试强制发起的活动在 debug 快照里
`autonomous=false`；`autonomous=false` 配置下仍可用于人工排查，但不会影响随机漫游开关语义。

调试触发**不受 `schedulable` 限制**：自主调度已禁用的 `climb` 仍可用
`triggerActivity('climb', nowMs)` 人工触发（需有可爬/上方窗口，两段式路径由
`prepareClimbTarget` 正常准备；冷却/拖拽等前置条件照常生效）。它不会因此回到随机池。

## 6. Lead 接线步骤（main.ts）

1. boot 时 `const behavior = new BehaviorDirector()`；`debug.behavior = behavior.getDebugSnapshot()`。
2. 每帧（**B1 先于 B2**，与 `docs/wave2-integration.md` §2 顺序一致）：
   ```ts
   const motionBefore = physics.getSnapshot()
   const decision = behavior.update({
     nowMs, dt,
     motion: motionBefore,
     desktop: desktopSensor.snapshot(nowMs),
     interaction: interactionController.getSnapshot(),
     events: interactionController.drainEvents(),
     external: dshTracker.reactionAt(nowMs),
     config: { autonomous, autonomousLevel, mischief, dshLink },
     random: Math.random
   })
   physics.setCommand(decision.motion)
   // physics.step(dt, nowMs) → MotionSnapshot → petRect → placePet → 动画输入
   ```
3. `config` 变化时不需要重建 director（每帧传入）；`autonomous` 关闭会立刻取消自主活动（不回退位置）。
4. 交互事件同时给 B4 的物理拖拽（`dragStart/dragMove/dragEnd` → `physics.beginDrag/dragTo/endDrag`）；
   B1 只消费事件改状态，不自己驱动拖拽/物理。
5. `fpsCap` 跳帧时仍要按真实 dt 调用 `behavior.update`（B1 用 `nowMs`，不依赖渲染帧）。
6. `bubble` 显示：建议 3.5s 自动隐藏；同一句不重复弹（B1 已做冷却，main.ts 只需避免每帧重置计时）。

## 7. 与其它模块的约定 / 风险

- **B5（desktop）**：`window-top` 表面需要在窗口移动后把新 `top/rect` 反映到同一 `surfaceId`
  （建议 `win-<windowId>-top`）；B1 优先用跟踪到的 `surfaceId` 找新表面，找不到再按 `windowId` 兜底。
  `transitions.closed` 必须对「宠物正站在其上的窗口」发一次；B1 只在宠物确实靠该窗口支撑时掉落。
  **`menubar` 表面不参与坐/爬落点**（top=0 → 宠物渲染出视口，Lead 2026-11-08 决策，见 §2.1）：
  B5 仍可照常提供该表面，B1 内部会过滤，不会选它当落点。
- **B2（physics）**：`moveTo.target` 是**脚底点**（窗口本地 px，已钳制进 workArea）；`sit` 由 B2
  负责移动到 `surface.top`；B2 可用 `speedPxPerSec/mode` 决定走/爬速度与姿态切换。
  空中时 B2 可忽略 `moveTo`（契约允许）。
  两段式攀爬依赖 B2 的两条既有语义：① `mode='climb'` 的 2D 受控位移（无重力）；
  ② 到位改发 hold 后 `CLIMB_SETTLE_SNAP_EPS_PX=24` 吸附落到 `surface.top`。
  因此 B1 的 climb 最后一段目标取 `{edgeX, surface.top + 6}`（不是精确 top），由吸附完成落座。
- **B3（animation）**：`poseHint` 只是提示（`idle:coin` / `pat:head` / `poke:leg` / `sit:window` …），
  可忽略；B1 不申请 idle 变体 id，变体由 B1 通过 poseHint 提示。
- **B4（interaction）**：B1 需要 `interaction.dragging`、`pointer`、`hoveringPet` 与事件数组；
  事件由 main.ts 每帧收集后传入并在消费后清空（同一事件也可给 B3）。
- **B7（dsh）**：外部反应持续期与时钟口径用 `performance.now()`；`online=false`/陈旧时 B7 应静默。
- **运动目标可达（H-3b）**：B1 通过 `BehaviorInput.motionLimits?`（PetRuntime 依 workArea+petSize
  计算的可达 x 区间）钳制所有 moveTo 目标；该字段缺省（B1 单测/旧接线）时回退旧口径（只按 workArea）。
  有 limits 时移动类活动会按路径动态续期到抵达目标（上限 45s）。契约字段由 F2b 在
  `core/wave2-contract.ts` 定义、`pet-runtime.ts` 注入。
- 已知取舍：B1 不知道宠物尺寸/模型宽高比，只消费 PetRuntime 算好的 `motionLimits`；
  移动目标只给脚底点，其余边界（y 方向/半宽细节）仍由 B2 兜底。
- `mischief` 配置在 B1 内暂不使用（C2 的 `mischief.ts` 负责捣乱行为）；B1 不越界实现。

## 8. 测试

```bash
pnpm exec vitest run tests/behavior-director.test.ts   # 状态机/优先级/复现性/桌面事件/两段式攀爬（debug-only）/官方台词（39 tests）
pnpm exec vitest run tests/behavior-activities.test.ts # 权重/调度/冷却门/随机工具（26 tests）
pnpm exec vitest run tests/behavior-                    # 全部（65 tests）
# F2a 修复回归（H-3b motionLimits / H-5 sleep / N-1 自动坐下循环 / N-2 表面绑定 / M-13 elevated / M-14 优先级）
pnpm exec vitest run tests/fix-f2a-motion-limits.test.ts tests/fix-f2a-sleep.test.ts \
  tests/fix-f2a-autosit.test.ts tests/fix-f2a-priority-elevated.test.ts
pnpm run typecheck:web 2>&1 | grep behavior/            # 本模块应 0 错误
```

`tests/behavior-director.test.ts` 内含假 `MotionSnapshot/DesktopSnapshot/InteractionSnapshot`
构造器，不依赖 B2/B4/B5 真实实现或模型资源；两个测试文件都是 node 环境纯逻辑。
