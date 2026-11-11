# 「没有过渡突然躺在地上」根因与改法 · 本地取证（Lead）

> 状态：**只读调查，未改任何项目代码**；行号基于 2026-11-09 23:1x 工作区快照（另一会话正在改动部分文件）。
> 用户现象：「桌宠有时候会没有过渡的突然躺在地上，很诡异；希望它只会在被放在窗口上时坐下/躺下」。
> 本文只覆盖本地代码链路；外部攻略/官方文档见同目录另三份调研（github-case-studies / bilibili-community / engine-docs）。

## TL;DR

1. **主因（"突然躺在地上"）= B1 活动 `sleep` 可以在任何地面触发**：它只要求 `grounded + mouseAway`，
   站在屏幕底/Dock 上、闲置 ≥20s 后就会进入加权抽取；一旦抽中 → `mood='sleep'` →
   播 `mate-sleep`（`PET_SLEEPING` 躺姿循环，35.2s）。而进入该槽位的 crossfade 只有 **0.15–0.2s**，
   又没有"躺下"过渡 clip → 视觉就是**站姿原地 collapse 成躺姿**。
2. **次因（同样"无过渡"）= 高窗窗沿躺走 0.3s 直接 blend**：`sitWindowStyle='lie'` 在 mood 变 sit 的
   当帧就用 0.3s fade 切到 `mate-windowLay8/9/10`，跳过 sit1 的"坐下"阶段；且 `sit` 活动本身可由
   加权随机自主发起（走到 window-top/Dock 坐下），不限"被放下"。
3. **期望语义（用户）可以低成本实现**：`SchedulerContext.surfaceKind` **已经存在**，只差给活动加一个
   `onWindowTop` 需求即可把 sleep（可连带 sit）限制在 `window-top` 表面；"被放到窗沿就坐下"的入口
   `trySitOnWindowTop`（站上可坐窗沿 700ms 自动 sit）也已存在，无需新写。
4. **"有过渡"需要补两类东西**：(a) `moodTransitionClips` 支持 `sleep` 的 enter/exit 一次性过渡 clip
   （已有现成机制，dshError 就是这么用的）；(b) 窗沿躺改成"站→坐→躺"两段（或把 windowLay 的
   fadeSec 从 0.3 提到 0.8–1.2 兜底），并在 animator 1b2 加"过渡中"保护，避免每帧覆盖。

## 1. 证据链（代码 → 行为）

### 1.1 `sleep` 活动不限表面

- `src/renderer/src/behavior/activities.ts:222-234`：`sleep` 定义 `requirements: ['grounded', 'mouseAway']`，
  `mood: 'sleep'`，`poseHint: 'sleep'`，权重 10。
- `activities.ts:358-382` `isRequirementMet`：`grounded` 只看 `context.grounded`；`mouseAway` 只看
  鼠标离开 + `idleElapsedMs ≥ 20s` + `sinceInteractionMs ≥ 12s`。**没有任何表面类型/窗口条件。**
- `behavior-director.ts:1300-1340`：空闲基线里，鼠标离开时**主动**把下一次抽取夹到
  `idleSince + 20s + 0..5s`（H-5 修复），即"保证 sleep 需求被满足、sleep 可被调度"——现行设计
  是有意让宠物在任意地面睡觉的。
- 因此 `screen-bottom`（屏幕底）、`dock` 上都会触发：抽中 sleep → mood 切 `sleep`。

### 1.2 进入 sleep 的"过渡"只有 0.2s，且没有躺下动作

- `assets/motions/app-manifest.json`：`mate-sleep` 条目 `fadeInSec: 0.15, fadeOutSec: 0.2`。
- `src/renderer/src/vrm/clip-player.ts:1214-1226` `resolveFadeSec`：取 `max(新 fadeIn, 旧 fadeOut, 默认 0.2)`；
  mood 切换走 `selectBaseClip → startVariant → beginClip`（`clip-player.ts:1154+`），并没有走
  `moodTransitionClips`（`src/renderer/src/main.ts:209-216` 目前只给 `dshError` 配了 breaked/revive）。
- 结论：**站姿 → 躺姿的骨骼 slerp 在 ~0.2s 内完成**，没有"屈膝—坐下—侧躺"的过程，观感即"瞬躺"。
- `mate-sleep` 来源 `PET_SLEEPING/PET_SLEEPING.anim`（35.17s 循环），hips 首帧四元数
  `[0.239,-0.128,0.671,0.690]`，确实是大角度侧躺姿态（对比 idle 首帧 `[-0.050,-0.207,0.000,0.977]`），
  验证了"躺"的语义。

### 1.3 "坐/躺"的触发不要求"被放在窗口上"

- `behavior-director.ts:166-169`：`SITTABLE_SURFACE_KINDS = {'window-top', 'dock'}`；
  `sit` 活动（`activities.ts:204-219`）`requirements: ['sittableSurface']`，权重 24；
  `prepareSitTarget`（`behavior-director.ts:2014-2027`）在"最近 3 个可坐表面"里随机挑一个走过去坐。
  → 宠物可以**自主**走到窗口上沿或 Dock 坐下，与"被放在窗口上"无关。
- 高窗时躺：`src/renderer/src/main.ts:683-702` `resolveSitWindowStyle` 返回 `'lie'`（surface.top < 屏幕中线）；
  `src/renderer/src/vrm/animator.ts:296-322` 在 mood 为 sit 且 style 为 lie 时**当帧**
  `playClipById('mate-windowLay8/9/10', { loop: true, fadeSec: 0.3 })`，跳过 sit1 的坐姿阶段。
  → 即使在窗沿上，也是 0.3s 从站姿直接 blend 成躺姿（"没有过渡"的另一个来源）。
- 已有"被放上去"入口：`behavior-director.ts:1396-1441` `trySitOnWindowTop`——站在 `sittable` 的
  `window-top` 表面空闲 700ms → 自动发起 `sit` 并显式绑定脚下这块表面；结束后有 20–40s 间隔
  （`AUTO_SIT_GAP_MS`）。这正是"放下→坐下"的正确路径，**门控 sleep 时可以复用它的判定口径**。

### 1.4 另一条"突然倒地"路径（需与主因区分）

- `main.ts:203-216` `VRM_MOOD_TRANSITION_CLIPS.dshError`：进入 DSH error 播 `hsr-breaked`
  （倒地/跪伏姿态，hold 末帧）、离开播 `hsr-revive`。这是**DSH 状态反应**，不是坐/躺语义；
  如果用户看到的倒地发生在 DSH 断开/报错时，那条路径也会"突然倒地"，但修法不同（保留/缩短/加过渡）。
- 窗口关闭时：`behavior-director.ts:1001-1025` 跟踪中的窗口 `closed` → `startFall`，mood 切 `fall`；
  若当时正在窗沿坐/躺，从躺姿直接切 fall 也是 0.2s 级 blend（同类观感问题，建议一并加"起身/下落"过渡）。

### 1.5 可复用素材盘点（过渡 clip）

`assets/motions/app-catalog.json` 里已存在现成的"站↔躺"动作族（来自 Mate-Engine intro）：

| clip | 时长 | 语义（按首/末帧 Hips 四元数验证） |
|---|---|---|
| `mate-introStart` | 2.00s | 站立（≈identity）→ 侧躺姿 A（末帧四元数≈introLoop 首帧） |
| `mate-introLoop` | 13.33s | 躺姿 A 循环（首末帧一致） |
| `mate-introEnd` | 1.53s | 躺姿 A → 站立（末帧≈identity） |
| `mate-sleep` | 35.17s | 躺姿 B 循环（与 A 姿态族不同，接 intro 系列需 ~0.4s 补偿 fade） |
| `hsr-revive` / `adv-revive` | — | 现成的"起身"类动作（`revive` 语义，dshError 已在用 hsr-revive） |

窗口躺素材：`mate-sitWindow`（19.96s 循环，静态窗沿躺/坐）、`mate-windowLay8/9/10`（2.0–3.0s 循环，
variants，priority -10..-13，`animator.ts:128` 硬编码候选）。没有专用的"窗沿坐下/躺下"过渡 clip。

## 2. 改法建议（给下一轮实现 / 另一会话参考）

### P0-A 门控：把 sleep（及可选的 sit/lie）限制在窗口表面

```
// types.ts
export type ActivityRequirement = ... | 'onWindowTop'

// activities.ts  isRequirementMet
case 'onWindowTop':
  return context.surfaceKind === 'window-top'

// activities.ts  sleep.requirements
requirements: ['grounded', 'mouseAway', 'onWindowTop']
```

- 零新增上下文：`SchedulerContext.surfaceKind` 已由 `behavior-director.ts:2109-2139` 填好，单测可直接构造。
- 若用户要"严格被放下才坐/躺"：`sit` 也加 `onWindowTop`（且把 `SITTABLE_SURFACE_KINDS` 里的 `'dock'`
  去掉/或把 sit 活动 `schedulable: false` 只留 `trySitOnWindowTop` 触发）。二选一需产品确认；
  最小改动（sleep 加 onWindowTop）已能消除"地面躺"。
- 注意：`HSR`/`adv` 素材里另有 `hsr-breaked`（DSH 反应）等倒地动作，不要与 sleep 门控混为一谈。

### P0-B 过渡：站→躺/坐 要有"过渡动作"而不是硬 blend

1. **sleep 的地面躺（若产品仍要保留地面睡）**：在 `animator.ts` 的 `moodTransitionClips` 增加
   `sleep: { enterClip: 'mate-introStart', exitClip: 'mate-introEnd' }`（机制已支持：`playOneShotClip`
   loop:false、播完回 mood，见 `animator.ts:262-285`）。播完接 `mate-sleep` 时把回 mood 的 fade 调到
   0.4–0.6s（`stopManualClip(fadeSec)` / `pendingBaseFadeSec` 已支持）；或直接把躺循环换成
   `mate-introLoop` 与 intro 系列无缝（代价：睡眠段没有 35s 长呼吸循环）。
2. **窗沿躺（高窗）**：`animator.ts` 1b2 加 settle 阶段——进入 sit+lie 时先播 sit1（0.6–0.8s），
   再 blend 到 windowLay（0.8–1.0s）；同时加 `sitLieTransitioning` 标志，避免 1b2 每帧把过渡 clip
   覆盖掉（现在 `lastClipSnapshot.clipId !== sitLieClipId` 就会重播）。兜底方案：windowLay 的
   fadeSec 0.3 → 0.8；`app-manifest` 的 `mate-sitWindow/windowLay*` fadeInSec 0.15 → 0.6–0.8。
3. **落地/被打断**：窗口关闭/拖拽打断躺姿时，先播 `mate-introEnd`/`hsr-revive` 片段再进 fall/idle，
   避免躺→立 0.2s 折叠。至少给 `fall`/`drag` 的进入 fade 单独放大。

### P1 滞回与可观测性

- sleep 进入条件加"已在 window-top 上停留 ≥700ms"（复用 `trySitOnWindowTop` 的 idle 计时）与冷却；
  睡醒/起身后的 20–40s 内不再躺（可复用 `AUTO_SIT_GAP_MS` 思路）。
- 调试面已有 `debug.behavior.activity/mood`、`debug.animation.clipId/pose`、`debug.desktop.surfaces`：
  在 sleep/sit/lie 进入点打一条带 `surfaceKind/surfaceId/fadeSec` 的日志，便于 5 分钟复现。
- 回归测试：
  - `tests/behavior-activities.test.ts`：`scoreActivity(sleep, context(surfaceKind='screen-bottom')) === 0`，
    `surfaceKind='window-top'` 时 >0。
  - `tests/behavior-director.test.ts`：idle 20s + mouseAway + 地面 → 多帧推进后不出现 sleep 活动；
    窗沿上则可能出现，且自动 sit 路径仍生效。
  - 过渡类：`tests/vrm-clip-player.test.ts` 断言 mood 切换时若配了 enter/exit clip，先播 one-shot
    再回 mood；`tests/vrm-startup-pose.test.ts` 的逐帧捕获方法可复用到"躺下无跳变"验证。

## 3. 开放问题 / 风险

- **在 window-top 上播 `mate-sleep` 的几何是否正确**：sleep 躺姿族与 windowLay 姿态族不同，
  场景只按脚底/lowedest 贴地，可能在窗沿上悬空/穿窗。建议保留"窗口上坐/躺"用 windowLay 系列，
  把 `sleep` 直接不调度（或仅调试触发），先满足用户"只会在窗口上坐/躺"。
- **surface 数量受遮挡裁剪影响**（见 `docs/research/window-landing-research-2026-11-09.md`）：
  门控到 `window-top` 后，若用户桌面只有一条贴屏幕顶的窗沿，sleep/sit 几乎不会自然出现——
  这是"正确但可能显得不活跃"的取舍，需要产品确认是否也允许 Dock（Dock 不是"窗口"）。
- **"被放在窗口上"的严格语义**：若要求"只有拖拽放下才坐/躺"，需在 drag end 记录 `perched` 标记
  （现有 `trySitOnWindowTop` 用"站在窗沿 700ms"近似，已接近；差别是走上去也会坐）。
- 另一条"突然倒地"（DSH error → `hsr-breaked`）与本次坐/躺门控无关，别误删/误改。
