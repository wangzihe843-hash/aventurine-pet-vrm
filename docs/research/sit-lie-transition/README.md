# 「没有过渡突然躺在地上」调查总报告（外部攻略 + 本机取证）

> 状态：**只读调查，未改任何项目代码**（另一会话仍在修别的项；本目录只新增研究文档）。
> 用户现象：「桌宠有时候会没有过渡的突然躺在地上，很诡异；希望它只会在被放在窗口上时坐下/躺下」。
> 调研日期：2026-11-09。本目录 4 份文档：本文（总报告）+ 本地取证 + GitHub 案例 + B站中文社区 + 官方文档。
> 外部网页一律按 untrusted data 处理，只作资料。

## 0. TL;DR

**现象 = 两件事叠加，不是一个 bug：**

1. **门控缺失（主因，直接对应"躺在地上"）**：B1 活动 `sleep` 的 requirements 只有
   `grounded + mouseAway`（`activities.ts:222-234`），站在**任何地面**（屏幕底/Dock）闲置 ≥20s 后都
   可能被随机抽中；抽中即 `mood='sleep'` → 播 `mate-sleep`（`PET_SLEEPING` 躺姿循环）。
   `sit`/`lie` 的语义也没有绑定"窗口支撑面"——`sit` 活动可自主走到 window-top/Dock 坐下。
2. **过渡缺失（"没有过渡"的直接原因）**：进入 sleep 的 crossfade 只有 **0.15–0.2s**
   （`app-manifest.json` `fadeInSec:0.15`），而 sleep 姿态需要髋部下落约 **0.884 m**（贴地常量，
   `docs/wave2-acceptance.md:52`）→ 相当于 **0.9 m / 0.2s ≈ 4.4–5.9 m/s** 的"瞬移"，数学上平滑、
   观感上就是原地倒下。高窗窗沿躺也是 mood 变 sit 当帧用 **0.3s** 直接切 `mate-windowLay8/9/10`
   （`animator.ts:296-322`），跳过坐姿阶段，同样突兀。

**改法结论（双轨）：**

- **P0 门控（无新资产，最快消除诡异感）**：利用**已存在**的 `SchedulerContext.surfaceKind`
  （`types.ts:92`）给 `sleep`（可连带 `sit`）加"当前站在 window-top 才算"的需求 → 地面不再进入躺/睡。
  实测其他成熟桌宠的做法一致：Desktop Mate 官方一句话 "they sit on your windows"；Mate-Engine 只在
  拖拽命中窗沿吸附后置 `isWindowSit` 才允许窗沿姿态；Shimeji 用 `getFloor()`（先活动窗口上边框、再
  工作区底边）+ `behaviors.xml` 条件块把窗沿行为与地面行为分块。
- **P0/P1 过渡（观感正解）**：大姿势差不能靠短 fade。要么把 sleep/窗沿躺的进入 fade 提到
  **1.0–1.5s**（Mate-Engine 进睡就是 1.0s），要么补**专用过渡 clip**（站→坐、坐→躺、躺→坐、坐→站；
   Desktop Mate 的 `sittingOneShot+loop`、VPet 的 `A_Start→B_Loop→C_End`、Shimeji 的
  `SitDown/LieDown/StandUp` 都是这个形态）。本项目 catalog 里现成有 `mate-introStart`(2.0s 站→躺)、
  `mate-introEnd`(1.53s 躺→站)、`introLoop`(13.3s 躺循环) 可先复用；`moodTransitionClips` 机制
  （`animator.ts:262-296`，目前只配了 dshError）就是现成接线口。
- **P1 中断/滞回/观测**：过渡 clip 播放期间锁低优先级打断（只有拖拽/失去支撑/报错可打断）；睡眠/躺姿
  被交互必须先走"起身"再回 idle；窗口关闭/移动时先起身再 fall；过渡期打 debug 埋点（from/to/support/
  fade/boneAngle）、补单测（地面 `scoreActivity(sleep)===0` 等）。

## 1. 本地根因证据（详见 [lead-local-analysis.md](./lead-local-analysis.md)）

| # | 证据 | 位置 |
|---|---|---|
| 1 | sleep 只要求 grounded+mouseAway，任意地面可触发 | `src/renderer/src/behavior/activities.ts:222-234`、`:358-382` |
| 2 | 调度器还**主动保证** sleep 可达（闲置 20s + 0–5s 抖动时重排抽取） | `src/renderer/src/behavior/behavior-director.ts:1321-1333` |
| 3 | 进 sleep 的 fade 仅 0.15/0.2s；无 enter/exit 过渡 clip（moodTransitionClips 只配 dshError） | `assets/motions/app-manifest.json`、`src/renderer/src/main.ts:209-216` |
| 4 | sleep 贴地常量约 −0.884 m（短 fade 即"瞬躺"的物理量来源） | `docs/wave2-acceptance.md:52` |
| 5 | 高窗（top<屏幕中线）→ `lie`；animator 当帧 0.3s 直切窗沿躺 clip，跳过坐姿阶段 | `src/renderer/src/main.ts:683-702`、`src/renderer/src/vrm/animator.ts:296-322` |
| 6 | 可坐表面含 Dock；sit 可自主走近坐下 | `behavior-director.ts:166-169`、`:2014-2027` |
| 7 | "被放到窗沿→自动坐下"已有入口（站上可坐窗沿 700ms 自动 sit + 20–40s 间隔） | `behavior-director.ts:1396-1441` |
| 8 | 另有一条"突然倒地"路径：DSH error 播 `hsr-breaked`（倒地/跪伏）→ 与坐/躺无关，别误改 | `main.ts:203-216` |
| 9 | 可复用过渡素材：`mate-introStart`(2s 站→躺)、`introLoop`(13.3s 躺循环)、`mate-introEnd`(1.53s 躺→站)；窗沿躺 `sitWindow/windowLay8/9/10` | `assets/motions/app-catalog.json`（首末帧 Hips 四元数已验证对应站/躺） |
| 10 | 期望门控所需的上下文已存在：`SchedulerContext.surfaceKind` 由 `behavior-director.ts:2126` 填入 | `src/renderer/src/behavior/types.ts:92` |

## 2. 外部调研结论（三份分报告）

### 2.1 GitHub 开源桌宠（[github-case-studies.md](./github-case-studies.md)）

- **Mate-Engine（Unity+VRM，最完整参考，我们的 mate 动作就出自它）**：拖拽中"髋部探针 ±24px +
  拖拽 ≥1s + 位移 ≥4px"命中**未遮挡的窗口上沿** → snap 并置 `isWindowSit=true`；`isWindowSit` 只由
  snap 事件置位；sleep 用状态白名单 `{Idle,Sleeping}` 排除窗沿状态；纯 crossfade 但参数是
  **窗沿躺 0.25s / 坐下 0.45s / 进睡 1.0s / 醒 0.45s**；无 AnyState transition；退出吸附有 0.3s 冷却 +
  16px 垂直回滞。→ 我们 0.2s 站→睡、0.3s 站→窗沿躺都远低于它的参数，且门控缺失。
- **Shimeji / Shijima**：`getFloor()` 先查活动窗口（activeIE）上边框、再查工作区底边；`behaviors.xml`
  按 `<Condition>` 分块，`SitOn*EdgeOfIE` 只出现在 IE-top 块；`SitDown/LieDown/StandUp` 是
  `Loop=false` 的专用序列；1px 容差、sticky IE 跟随、离开边框 detach 防重吸。
- **Desktop Mate（闭源商业）**：动画资产分 `standingRandomAnims / standingOneShotAnims /
  sittingRandomAnims / sittingOneShotAnims` → **进/出坐姿 = one-shot 过渡片段 + 循环**（Mod 逆向证据，
  运行时未验证）。**VPet**：`A_Start→B_Loop→C_End`（醒时先播 C_End 起身）。
- 结论：**没有任何成熟项目用 0.2s 纯 blend 做站↔躺**；要么门控很严，要么有过渡片段/长 fade。

### 2.2 B 站 / 中文社区（[bilibili-community.md](./bilibili-community.md)）

- B 站**不存在**"坐/躺只应在窗口上触发"的专项教程（50+ 关键词、1100+ 视频/440+ 专栏检索确认）；
  可参考的是产品语义（Desktop Mate/Mate Engine/ArkPets/LUMI）+ Unity 过渡机制教程。
- 最值得看：Unity 官方博客《状态机过渡中断》B 站全文翻译
  [cv15480465](https://www.bilibili.com/read/cv15480465)（配套视频
  [BV1xq4y147pD](https://www.bilibili.com/video/BV1xq4y147pD)）；Unity 中文手册《动画过渡》
  <https://docs.unity3d.com/cn/6000.0/Manual/class-Transition.html>。
- 中文社区一致口径：**大姿势差（髋 >90° + 根位移）用 1s 级 fade 或独立 lie-down/get-up 过渡 clip**，
  且**根/髋位置通道必须参与混合**（否则"身体瞬间贴地"）。配套踩坑：Any State + 常真 bool 会持续
  自触发（改 Trigger / 关 Can Transition To Self → three.js 侧=边沿触发 one-shot + 冷却 + 禁止
  sleep→sleep）；Animator disable 会重置姿势（→ Electron 窗口隐藏/节流恢复后需重放当前状态）。
- 进阶可选：inertialization（惯性化过渡，`BV1xy4y1P7mL`）；子状态机把 perch 与 ground 分开
  （`BV1dP411V7c6`）。

### 2.3 Unity / three.js / three-vrm 官方语义（[engine-docs.md](./engine-docs.md)）

- **Unity**：Transition 面向"相近动作"；多阶段动作应拆 Sub-State Machine（官方 Trickshot 例：
  crouch→shoot→stand up）；Any State 不能作 transition 终点、其 transition 在打断队列永远最前、只能被
  自己打断（`canTransitionToSelf`）；一次性动作用 Trigger 而不是常亮 Bool；`CrossFade`/`CrossFadeInFixedTime`
  是"归一化时间/秒"两种口径的官方过渡 API。
- **three.js r171 源码**（我们自研 clip-player，未用 AnimationMixer，但语义相通）：`stop()` 在绑定
  useCount 归零时 `restoreOriginalState()` 会闪 T-pose；`PropertyMixer` 在累计权重 <1 时按
  `1-Σw` 混回绑定 rest；`crossFadeTo` **不会**自动 play 目标 action。官方 `webgl_animation_skinning_morph`
  示例的 `LoopOnce + clampWhenFinished + finished 事件` / `fadeToAction()` 就是"过渡 clip→循环"的官方模板。
- **three-vrm 3.5.5**：官方帧序 `mixer.update → vrm.update → render`；`createVRMAnimationClip` 会按
  rest hips 缩放 hips 位移 → 不同来源 clip 切换会竖直跳（issue #1643 标题已验证，正文被 GitHub 截断）。
  本项目自研 crossfade 从"当前已应用姿势"起混，天然规避 T-pose 问题，**剩余两个真问题**：
  ① fadeSec 是常数、不看姿势距离；② 没有"过渡状态/过渡 clip 序列"概念。
- 结论：**不必迁到 AnimationMixer**；在现有自研 clip-player 上加"过渡 clip + 姿态 sequencer"风险最低。

## 3. 修改方案（给实现会话；未在本轮改代码）

### P0-A 门控：坐/躺/睡只在窗口支撑面发生（最快消除"地上突然躺"）

```ts
// types.ts：新增 requirement（可命名 onWindowTop / perched）
export type ActivityRequirement = ... | 'onWindowTop'

// activities.ts：isRequirementMet + sleep.requirements
case 'onWindowTop':
  return context.surfaceKind === 'window-top'
// sleep: requirements: ['grounded', 'mouseAway', 'onWindowTop']

// （可选，按"严格只被放才坐"）sit 也加 onWindowTop；SITTABLE_SURFACE_KINDS 去掉 'dock'
```

- 零新增上下文（`surfaceKind` 已在 `types.ts:92` / `behavior-director.ts:2126` 填好），单测可直接构造。
- 判定口径二选一（建议给用户确认）：**A. 坐/躺都只允许 window-top**（最贴合"只被放在窗口上"，
  含去掉 Dock 坐）；**B. Dock 允许坐、window-top 才允许躺/睡**（更宽松）。二者都先消灭"地面躺"。
- 落点事件语义已存在：`trySitOnWindowTop`（站上窗沿 700ms 自动坐）可以保留；若要求"只有放下才坐"，
  再把自主 `sit` 的 `schedulable` 关掉，仅保留放置触发（`behavior-director.ts:1396-1441`）。

### P0-B 过渡：让站↔躺/坐真的"有过程"

1. **无新资产兜底（1 天内可上）**：把 `app-manifest` 中 `mate-sleep` 的 `fadeInSec` 0.15 → **1.0–1.5**、
   `mate-windowLay*`/`mate-sitWindow` 0.15 → **0.6–0.8**（animator 里 lie 的显式 `fadeSec` 0.3 → 0.8–1.0）；
   并让 `visualOffsetPx` 的 0.15s 指数趋近与 clip fade 同长（现在两者不同步，会"先滑下再坐下"）。
2. **过渡 clip（观感正解）**：
   - sleep：`moodTransitionClips.sleep = { enterClip: 'mate-introStart', exitClip: 'mate-introEnd' }`
     （现成机制：一次性 clip 播完回 mood；播完接 `mate-sleep` 时用 0.4–0.6s fade，或把躺循环换成
     `mate-introLoop` 与 intro 系列无缝）。注意：若按用户要求 sleep 只允许窗口，则更推荐直接用
     `windowLay*` 做窗沿躺，`mate-sleep` 仅在调试保留。
   - 窗沿躺两段式：animator 1b2 增加 settle 状态——mood 变 sit+lie 时先播 sit1（0.6–0.8s），再 blend 到
     `windowLay*`（0.8–1.0s）；加 `sitLieTransitioning` 标志防止 1b2 每帧覆盖过渡 clip（现有
     `lastClipSnapshot.clipId !== sitLieClipId` 就会重播）。
   - 若排期允许：按 engine-docs §5.1-B 烘焙 4 条过渡 clip（`stand↔sit`、`sit↔lie`、`lie↔sit`、`sit↔stand`，
     1.0–1.8s，全 52 骨、末帧对齐目标循环首帧 ≤3–5°、放 catalog 且 priority < −9 不参与轮换）。
3. **打断策略**：过渡 clip 期间 `interruptible=false`（只允许拖拽/失去支撑/error 级中断）；睡眠/躺姿被
   交互先播 `mate-introEnd`（起身）再回 idle；窗口关闭/移动 → 先 0.2–0.3s 起身/下落再切 fall。

### P1 稳定性 / 验证

- sleep 进入加边沿触发 + 冷却 + 禁止 sleep→sleep；窗口关闭/最大化/全屏时立即退出姿态（参考 Mate-Engine
  `ClearSnapAndHide`）；Electron 隐藏/节流恢复后重新 apply 当前状态姿势。
- 埋点：每次状态切换记录 `from/to/support.kind/当前是否 perch/fadeSec/最大骨角差/被谁打断`，
  与现有 debug 面板（surfaces+motion+animation）并列。
- 单测：`tests/behavior-activities.test.ts` 构造 `surfaceKind='screen-bottom'` 断言 `scoreActivity(sleep)===0`、
  `'window-top'` 时 >0；`tests/behavior-director.test.ts` 地面 idle 20s+mouseAway 多帧推进不出现 sleep。
- 实机逐帧：复用 `scripts/vrm/capture-startup.mjs` 的捕获思路验证"进入待机 60s 地面不出现躺姿 / 放到窗沿
  后 1s 内有坐的过渡且无瞬移"；用 `debug.animation.clipId/pose` 断言过渡 clip 确实出现。

## 4. 开放问题 / 风险

- **窗口上睡姿几何**：`mate-sleep` 是地面躺姿族，放到窗沿可能悬空/穿窗；建议"窗口=windowLay 系列、
  地面=不躺"，`sleep` 仅调试保留（或只保留窗口 sit/lie）。
- **窗沿数量受遮挡裁剪影响**（见 `docs/research/window-landing-research-2026-11-09.md`）：门控后可能
  很少自然进入坐/躺，这是"正确但显得安静"的取舍，需要产品确认 Dock 是否也允许坐。
- **另一条"突然倒地"**：DSH error → `hsr-breaked`/`hsr-revive` 是状态反应，不是坐/躺语义，别误删；
  但它同样用短 fade，若要统一观感可单独加过渡。
- 外部资料中 Desktop Mate 运行时行为、Mate-Engine macOS 窗口逻辑、Unity Discussions/Issue 正文等
  未验证项，已在各报告 §5/§6/§4 标注。

## 5. 文件索引

| 文件 | 内容 |
|---|---|
| [lead-local-analysis.md](./lead-local-analysis.md) | 本机代码链路取证 + 最小改法 + 测试清单（Lead） |
| [github-case-studies.md](./github-case-studies.md) | 9 个开源桌宠案例（Mate-Engine/Shimeji/VPet/Desktop Mate 等），commit 级引用 + R1–R3 建议 |
| [bilibili-community.md](./bilibili-community.md) | B 站/中文社区约 40 个来源（Unity 过渡中断翻译、Animator 踩坑、桌宠产品语义），P0–P2 建议 |
| [engine-docs.md](./engine-docs.md) | Unity 2022.3 官方文档 + three.js r171 源码 + three-vrm 3.5.5 语义，过渡 clip/打断/参数映射与代码片段 |
