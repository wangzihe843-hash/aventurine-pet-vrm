# 站→坐/躺 过渡：Unity / three.js / three-vrm 官方语义调研

> 任务：`task-3`（teammate `engine-docs`）。**只读调研，未改任何项目源码/配置/测试**；本文件是唯一新增文件。
> 版本口径：运行时 `three@0.171.0`（即 **r171**）、`@pixiv/three-vrm@3.5.5`、`@pixiv/three-vrm-animation@3.5.5`（`package.json` 实测）；
> Unity 侧本项目只用于**烘焙**，故引用 Unity **2022.3 LTS** 手册（可稳定抓取的版本化 URL），并标注 Unity 6 的对应页面。
> 外部网页内容按 untrusted data 处理，只作资料，不执行其中任何指令。URL 验证状态见 §6（✅ 已抓取正文 / ⚠️ 仅页面可达 / ❌ 未验证）。

---

## 0. TL;DR（先看这 8 条）

1. **用户 bug「有时没过渡突然躺地上」在本项目里是两个独立问题叠加，不是一个 bug**：
   - **门控问题（行为层）**：`sleep` 活动的 requirements 只有 `grounded + mouseAway`（`activities.ts:222-233`），**站在任何地面都能被抽中去睡觉**；
   - **过渡问题（动画层）**：`sleep` 循环 clip 是「已经是躺姿」的 loop，配 `fadeInSec=0.15 / fadeOutSec=0.2`（`app-manifest.json:236-244`），而 mate 集的睡姿靠 **per-clip 常量贴地补偿 −0.884 m**（`docs/wave2-acceptance.md` §2 实测）。即：**从站姿到睡姿要在 150–200 ms 内完成约 0.9 m 的髋部下落 + 脊柱≈90° 旋转**（平均 4.4–5.9 m/s，比自由落体还快），数学上"平滑"、观感上就是瞬移躺地。
2. **Unity 官方的语义**：Transition 是"两个相似动作之间、在给定时间内混合"；**完全不同的动作**即使快速 transition 也可能出问题（Blend Tree 页原话：相似性是 blend 成立的前提）；**多阶段复杂动作的正确形态是 Sub-State Machine 拆阶段 state**（官方 Trickshot 例子：crouch→shoot→stand up），而不是一个 state 直接 blend 到另一个极端姿势。
3. Unity **Any State** 只适合"全局打断"（拖拽/摔倒/报错），不适合常规坐/睡；官方明确 **Any State 不能作为 transition 的终点**，且它的 transition 在打断队列里**永远排最前**。官方提供 `canTransitionToSelf` 专门控制 AnyState 自打断。常规姿态度用 Bool/Enum 参数 + 条件 transition，一次性动作用 **Trigger**（被消费后自动重置），而不是 Bool 常亮。
4. **three.js 侧「无过渡/姿势跳变」的三大机制性成因**（r171 源码定论）：
   - `stop()` 会 deactivate action，当最后一个引用该绑定的 action 被 deactivate 时 `PropertyMixer.restoreOriginalState()` **把骨架写回绑定姿势（T-pose）**；先 `stop` 旧 action 再 `play` 新 action 就可能闪一帧 T-pose；
   - `PropertyMixer.apply()` 在**累计权重 < 1** 时按 `(1 - Σw)` **混回绑定原姿势**；`crossFadeTo()` **不会帮你 play 目标 action**，目标没激活/权重到不了 1 时权重和不足 → 渐变到 T-pose（社区 thread 63467 正是此现象，官方 blending 示例也专门在 fade 前 `setWeight(endAction, 1)`）；
   - faded-out action 在 fade 结束帧被自动 `enabled=false`，**不会保持末帧**；要"停在末帧"必须 `clampWhenFinished=true`（paused 在最后一帧），否则要么等 `finished` 事件接续（有一帧空窗风险），要么在结束前提前 overlap 交叉淡化。
5. **three.js 官方示例已经给出了本项目要的模板**：`webgl_animation_skinning_morph` 用 `LoopOnce + clampWhenFinished + mixer 'finished' 事件` 做"基础 loop state ↔ 一次性动作（含 Sitting/Death）"，`fadeToAction()` 的 `fadeOut 旧 + reset().setEffectiveTimeScale(1).setEffectiveWeight(1).fadeIn 新 + play` 是官方写法（discourse 上 donmccurdy 亲自贴过同一段）。
6. **three-vrm 侧**：AnimationMixer 直接写 **normalized humanoid 骨**；官方 VRMA 示例的帧序是 `mixer.update(dt)` → `vrm.update(dt)` → render（`VRM.update` 内部依次 `humanoid.update()`→lookAt→expression→constraints→springBone→materials）。`createVRMAnimationClip` 会按 `humanoid.normalizedRestPose.hips.position.y / vrmAnimation.restHipsPosition.y` 缩放 hips 位移，**不同来源 clip 的 hips 基准不同**（GitHub issue #1643 标题即"切换动画后下陷，Mixamo hips position offset"），这正是"换 clip 竖直跳变"的常见来源。
7. **必须做（P0）**：① sleep/躺 加"当前站在可坐表面（window-top/dock）"门控（`SchedulerContext.surfaceKind` 已存在，`types.ts:92`）；② 补一套**姿态过渡 clip + 显式姿态 sequencer**：`stand→sitDown→sitLoop`、`sitLoop→lieDown→lieLoop`、反向 `wakeUp/standUp`；③ 过渡期间锁打断（只允许 drag/error 级中断），sleep 中鼠标靠近/交互必须走 wake-up 出场 clip。
8. **参数调优（P1）**：fade 时长按**姿势距离**自适应（髋位移 Δy、最大关节角），不要固定 0.2 s；站→睡走过渡 clip 时只保留 0.1–0.2 s 首尾对齐淡入；同步 `visualOffsetPx`（现在指数 0.15 s，`animator.ts:350-358`）和 clip fade 的时长/缓动；补齐过渡 clip 的全骨覆盖校验（`missingBones`）与首末帧对齐校验（否则未覆盖骨会回 rest = 骨骼"跳一下"）。

---

## 1. Unity 官方文档（Animator / Mecanim）

来源均为 `docs.unity3d.com/2022.3/Documentation/...`（已验证正文；Unity 6 对应页面迁到 `docs.unity.com/en-us/engine/6000.0/manual/...`，抓取仅拿到标题，正文为 JS 渲染，见 §6）。

### 1.1 Animation States：Any State、Write Defaults

`Manual/class-State.html`：

- **Any State**（原文）：
  > "Any State is a special state which is always present. It exists for the situation where you want to go to a specific state regardless of which state you are currently in. This is a shorthand way of adding the same outward transition to all states in your machine. Note that the special meaning of **Any State implies that it cannot be the end point of a transition** (ie, jumping to “any state” cannot be used as a way to pick a random state to enter next)."
  → 它只能作为 **transition 的起点**，是"所有 state 共用一条出边"的语法糖，不是"随机目标"。
- **Write Defaults**（原文）：
  > "Whether the AnimatorStates writes the default values for properties that are not animated by its motion."
  → 这是 Unity 里"未动画属性被重置"的开关。对应到本项目就是 `clip-player.ts` 的**"clip 未覆盖的骨回 rest"**（见 §2.8）——两者都会造成"只动了一半的姿势被另一半拽回默认值"的观感。

### 1.2 Transition 属性（`Manual/class-Transition.html`，逐项原文 + 本项目映射）

| 属性 | 官方原文要点 | 映射到本项目 |
|---|---|---|
| Has Exit Time / Exit Time | "Exit Time is a special transition that doesn't rely on a parameter… relies on the normalized time of the state."；"for example an exit time of 0.75 means that on the first frame where 75% of the animation has played… On the next frame, the condition is false. For looped animations, transitions with exit times smaller than 1 are evaluated every loop… Transitions with an Exit Time greater than 1 are evaluated only once…（例如 3.5 = 3.5 个循环后一次）" | 我们的"一次性过渡 clip 播完再进 loop"就是 Exit Time≈1.0 的语义；**循环 clip 用 Exit Time 定时退出**可用于"睡够一个循环再起身"的节拍对齐 |
| Fixed Duration / Transition Duration | "If the Fixed Duration box is checked, the transition time is interpreted in seconds… otherwise as a fraction of the normalized time of the source state."；"The duration of the transition, in normalized time or seconds… relative to the current state's duration." | 我们的 `fadeSec` 是**秒**口径 = Fixed Duration；语义上等价 `Animator.CrossFadeInFixedTime` |
| Transition Offset | "The offset of the time to begin playing in the destination state… value of 0.5 means the target state begins playing at 50% of the way through its own timeline." | 目标循环 clip 可以从"已经躺好"的相位开始播，避免从 loop 首帧重新起势（`AnimationAction.startAt/time` 对应） |
| Interruption Source | None / Current State / Next State / Current State then Next State / Next State then Current State；"The transitions in AnyState are always added first in the queue, then other transitions are queued depending on the value of Interruption Source" | 我们的 `eventPriority` + "manual clip 不被普通事件打断"就是 interruption source 的政策化实现 |
| Ordered Interruption | Checked："Ends when: A valid transition or the current transition has been found"；Unchecked："A valid transition has been found" | 决定"正在播的过渡 clip 是否允许被另一条更早排队的 transition 覆盖"；建议过渡 clip 期间 **Ordered Interruption = checked**（先到先得） |
| Conditions | "A transition happens when all its conditions are met"；"If you have Has Exit Time selected… the Unity Editor considers whether the conditions are true after the Exit Time." | 门控参数必须"全真"才走；与时间条件串联时先过 Exit Time 再判条件 |

同一页还给出两条关键约束：

> "Only one transition can be active at a given time. However, you can configure the settings to interrupt the currently active transition with another transition."
> "Only an AnyState transition can be interrupted by itself."（Interruption 小节）

以及 Transition 曲线图的官方建议（对"脚滑/跳变"直接相关）：

> "You should adjust the transition settings until there is a smooth transition between states. A white line with a smooth transition avoids foot slips, jumps in animation, and preserves the dynamics of the motion."

**AnyState 的陷阱（官方机制 + 直接推论）**：

1. 官方只说明"AnyState transition 永远排打断队列最前 + 只能被自己打断"。这意味着**如果 AnyState 的条件在目标 state 里仍然成立，它每一帧都有资格再次触发**（"A transition happens when all its conditions are met"），从而反复打断/重入 → 表现为动作被按住从头播、或抽搐。**推论性建议**：一次性动作一律用 **Trigger**（官方 `AnimationParameters` 页：Trigger 是"被 transition 消费后由 controller 自动重置"的 bool）；用 Bool 时在 `OnStateEnter` 里清掉/用 `canTransitionToSelf=false`（`Animations.AnimatorStateTransition-canTransitionToSelf.html` 原文："Set to true to allow or disallow transition to self during AnyState transition."）。
2. AnyState 不能作为终点（见 1.1），所以"随机进入某个 state"的写法在 Unity 里本来就不被支持。
3. 打断队列里 AnyState 永远最优先 → 不要用 AnyState 做"日常状态切换"（坐/睡/走），否则它会跟普通 state 出边抢优先级。

### 1.3 打断的运行时语义（`ScriptReference/StateMachineBehaviour.html`，原文）

> "State machines can have up to three different active states at the same time: the current state, the next state and the interrupted state."
> "If an ongoing transition is interrupted by a transition to a new state, then the next state becomes the interrupted state and the state targeted by the new transition is now the next state. The current state will remain the same until all interrupted transitions have completed."
> 消息顺序："current state, then interrupted state, then next state."

→ 给本项目的直接启示：**"过渡进行中"本身是一个需要被显式建模的状态**（Unity 用 interrupted state 表示）。我们的实现里过渡是一段权重插值、没有"正在过渡"的一等状态；改成"姿态 sequencer"时，应把 `transitioning` 作为状态（或至少可查询），供"禁止新活动抢占/拖拽可打断"使用。

### 1.4 `Animator.CrossFade` / `CrossFadeInFixedTime`（API 原文）

- `CrossFade(string stateName, float normalizedTransitionDuration, int layer=-1, float normalizedTimeOffset=-inf, float normalizedTransitionTime=0)` 摘要：
  > "Creates a crossfade from the current state to any other state using normalized times."
  说明：stateName 要带层名，如 `"Base Layer.Run"`。
- `CrossFadeInFixedTime(...)` 摘要：
  > "Creates a crossfade from the current state to any other state using times in seconds."
  `fixedTransitionDuration` 参数说明："The duration of the transition (in seconds)."

→ 与 three.js 的对应：`AnimationAction.crossFadeTo/crossFadeFrom` ≈ `CrossFadeInFixedTime`；但**Unity 的 CrossFade 会主动"进入目标 state 并让它播"**，而 three.js 的 `crossFadeTo` **只排权重插值，不会 `play()` 目标**（见 §2.2）。这是社区大量"crossFadeTo 变成 T-pose"帖的根因。

### 1.5 Sub-State Machine 与"过渡动画 clip"的官方形态

`Manual/NestedStateMachines.html`（原文要点）：

> "It is common for a character to have complex actions that consist of a number of stages. Rather than handle the entire action with a single state, it makes sense to identify the separate stages and use a separate state for each. For example… a character may have an action called “Trickshot” where it crouches to take a steady aim, shoots and then stands up again."
> "…Mecanim goes a step further… by allowing you to collapse a group of states into a single named item… These collapsed groups of states are called **Sub-state machines**."
> 外部 transition 必须选择子状态机里的具体目标 state；子状态机里有一个 `Up` state 代表"外层世界"。

`Manual/StateMachineTransitions.html` 补充：Entry/Exit node 用于"进入子状态机时按参数决定从哪个 state 开始 / 何时退出"；"Each sub-state within a state machine is considered a separate and complete state machine"。

→ **"过渡动画 clip"在 Unity 里不是 transition 的一个属性，而是一个独立 State（Motion = transition clip）**。Unity 推荐用 sub-state machine 把 `SitDown → SitIdle → LieDown → LieIdle → WakeUp → StandUp` 拆成多个 state，每个 transition 只负责相邻、相近姿势之间的短 blend。这就是本项目应照抄的形态（见 §5-B）。

### 1.6 Blend Tree 与"差异大的姿势不要直接 blend"（`Manual/class-BlendTree.html`，原文）

> "It is important to distinguish between Transitions and Blend Trees. While both are used for creating smooth animation, they are used for different kinds of situations."
> "Transitions are used for transitioning smoothly from one Animation State to another over a given amount of time. … A transition from one motion to a completely different motion is usually fine if the transition is quick."
> "Blend Trees are used for allowing multiple animations to be blended smoothly… **In order for the blended motion to make sense, the motions that are blended must be of similar nature and timing.**"
> "Since normalized time is used, it doesn't matter if the clips are of different length."（相似动作要求相位对齐，例如左脚 0.0 / 右脚 0.5）

→ 对"站 vs 躺"这种**本质不同**的动作：
- 不能做 1D `posture` Blend Tree 直接 stand↔lie（not similar nature/timing）；
- 短 crossfade 也可能"看起来过得去"，但**过渡中间态是物理上不存在的姿势**（人不会在半空中从站直接插值成躺），而且本项目的髋部位移大到 0.88 m，短 fade 的"速度感"必然像瞬移。→ 用**过渡 clip（带重心转移的中间姿势）**，而不是纯权重插值。

### 1.7 其他被问到的点

- **Animation Layers / Write Defaults（跨层重置）**：`Manual/AnimationLayers.html` 说明 Override 层按 mask 覆盖下层、Additive 层叠加、base layer 权重恒 1。官方没有把 Write Defaults 的坑写成警告，但从 class-State 定义可推出：**partial clip + Write Defaults on = 未覆盖属性被写默认值**；多 action/多层的等价场景就是"某个 clip 只动画上半身，其余骨被重置回 rest"。本项目的等价物是 clip 未覆盖骨回 rest（`clip-player.ts:5-20` 文件头注释），所以**过渡 clip 必须全骨覆盖**。
- **StateMachineBehaviour**（`Manual/StateMachineBehaviours.html` + API 页）：可挂在 state 上收 `OnStateEnter/OnStateExit/OnStateUpdate/OnStateMove/OnStateIK` 与子状态机级 `OnStateMachineEnter/Exit`。→ 对应本项目 `animator.ts` 在 mood 变化时播 enter/exit clip 的 hook（`animator.ts:262-290`）。当前只配置了 `dshError` 一组（`main.ts:209-216`），sit/sleep 没配 → 这正是"进入坐/躺没有入场动作"的代码层证据。
- **Mecanim FAQ**：layers 从上到下求值、Override 层完全覆盖、base layer weight 恒 1；"Animation with Curve 与 without Curve 混合时用参数默认值混合"（同理：**没有数据的通道 = 默认值参与混合**）。
- **Animation Parameters**：四种参数 Integer/Float/**Bool**/**Trigger**；Trigger = "a boolean parameter that is reset by the controller when consumed by a transition"；脚本用 `SetBool/SetTrigger/ResetTrigger` 驱动 → 桌宠 AI 状态门控的正确参数形态（§4.4）。

### 1.8 Unity 语义 → 本项目设计映射表（供另一会话参考）

| Unity 概念 | 本项目对应物 | 现状 | 建议 |
|---|---|---|---|
| State + loop Motion | activity + mood + manifest 循环 clip | ✅ 有 | 保留 |
| Transition Duration（Fixed Duration=秒） | `clip-player.ts` 的 `fadeSec`（per-bone slerp + hips lerp，`resolveFadeSec` `clip-player.ts:1212-1227`） | ⚠️ 固定 0.15–0.2 s 用于 mood 切换 | 按姿势距离自适应；站→睡 ≥ 1 s 或走过渡 clip |
| Exit Time / Has Exit Time | 一次性 clip 播完由 `advanceActiveTime` 回 mood | ⚠️ 无"过渡状态"概念 | 过渡 clip 用 LoopOnce+hold，播完再切 loop |
| Transition Offset | 目标循环 clip 起始相位 | ❌ 无（每次从 loop 首帧混入） | 过渡 clip 末帧对齐 loop 首帧后，用 0 相位进入最稳 |
| Any State | 全局打断：drag/fall/error 事件（`eventPriority`） | ✅ 近似有 | 保持；**不要**把常规 sit/sleep 放到全局打断语义里 |
| Interruption Source / Ordered Interruption | `eventPriority` + manual clip 保护（`clip-player.ts` `manualActive`） | ⚠️ 无"过渡不可打断"一等状态 | 加 `interruptible`/`transitioning` 状态，过渡期间只接受更高优先级中断 |
| Sub-State Machine | 缺失 | ❌ | 新增姿态 sequencer：stand→sitDown→sitLoop→lieDown→lieLoop→wakeUp→standUp |
| StateMachineBehaviour OnStateEnter/Exit | `animator.ts` `moodTransitionClips`（`animator.ts:262-290`） | ⚠️ 只配了 dshError | 给 sit/sleep 配 enter/exit 过渡 clip |
| Write Defaults | clip 未覆盖骨回 rest（`clip-player.ts:1251-1258`） | ⚠️ 靠"回 rest"兜底 | 过渡 clip 全骨覆盖 + 构建期校验 `missingBones` 为空 |
| Blend Tree | 不适用 | — | 站/躺不做直接 blend，用过渡 clip |

---

## 2. three.js r171：官方文档 / 源码语义

> 文档正文用 **r171 tag 的源文件**核对（`raw.githubusercontent.com/mrdoob/three.js/r171/...`，✅ 正文可读）；
> `threejs.org/docs/#...` 是 SPA，直接抓取只得到壳（⚠️）。所有结论都以 r171 源码为准，标了函数名便于复核。

### 2.1 Action 状态机模型（`docs/api/en/animation/AnimationAction.html`）

- `AnimationAction` 概述："AnimationActions schedule the performance of the animations which are stored in AnimationClips. Note: Most of AnimationAction's methods can be chained."
- 关键属性（原文摘要）：
  - `enabled`："Setting `enabled` to false disables this action, so that it has no impact. … When the action is re-enabled, the animation continues from its current `time` … Setting `enabled` to true doesn't automatically restart the animation."
  - `weight`："The degree of influence of this action (in the interval `[0,1]`)… can be used to blend between several actions."
  - `paused`："pauses the execution of the action by setting the effective time scale to 0."
  - `clampWhenFinished`："If true the animation will automatically be paused on its last frame. If false, `enabled` will automatically be switched to false when the last loop… has finished, so that this action has no further impact. … Note: clampWhenFinished has no impact if the action is interrupted."
  - `loop`：LoopOnce / LoopRepeat / LoopPingPong（默认 LoopRepeat, repetitions=Infinity）。
- 方法：`play/stop/reset/fadeIn/fadeOut/crossFadeFrom/crossFadeTo/setEffectiveWeight/setEffectiveTimeScale/setLoop/warp/syncWith/halt` 均可链式。
  - `play` 注意："Activating this action doesn't necessarily mean that the animation starts immediately: If the action had already finished before… a `reset` must be executed first. Some other settings (`paused=true`, `enabled=false`, `weight=0`, `timeScale=0`) can prevent the animation from playing, too."
  - `reset`："sets `paused` to false, `enabled` to true, `time` to 0, interrupts any scheduled fading and warping, and removes the internal loop count and scheduling… Note: `reset` is always called by `stop`, but `reset` doesn't call `stop`."
  - `stop`："deactivate this action… immediately stopped and completely reset."
  - 事件：mixer 上 `'loop'` / `'finished'`（"properties of e: type, action and loopDelta / direction"）。

### 2.2 fadeIn / fadeOut / crossFadeFrom / crossFadeTo 的真实语义（r171 源码）

`src/animation/AnimationAction.js`：

```js
fadeIn( duration )  { return this._scheduleFading( duration, 0, 1 ); }
fadeOut( duration ) { return this._scheduleFading( duration, 1, 0 ); }

crossFadeFrom( fadeOutAction, duration, warp ) {
  fadeOutAction.fadeOut( duration );
  this.fadeIn( duration );
  if ( warp ) { /* 按两段 clip 时长比 warp timeScale */ }
  return this;
}
crossFadeTo( fadeInAction, duration, warp ) {
  return fadeInAction.crossFadeFrom( this, duration, warp );
}

_scheduleFading( duration, weightNow, weightThen ) {
  const mixer = this._mixer, now = mixer.time;
  // 从“当前 mixer 时间”开始，排一条 [now, now+duration] 的线性权重插值：weightNow → weightThen
  ...
}
```

要点：

1. **`crossFadeFrom` 只排权重插值，不会激活/播放任何一个 action**。若目标 action 没 `play()`（或 `weight=0` 且没有权重可乘），`fadeIn` 也无法产生有效权重。
2. `fadeIn` 的权重曲线**固定从 0 开始**（`_scheduleFading(duration, 0, 1)`），**不是从当前 weight 起**。所以"连续两次 fadeIn 同一个 action"会从 0 重来；要打断重排必须先 `stopFading()`（或 `reset()`）。
3. `_updateWeight(time)`（同文件）：
   ```js
   let weight = 0;
   if ( this.enabled ) {
     weight = this.weight;
     const interpolant = this._weightInterpolant;
     if ( interpolant !== null ) {
       const interpolantValue = interpolant.evaluate( time )[ 0 ];
       weight *= interpolantValue;
       if ( time > interpolant.parameterPositions[ 1 ] ) {
         this.stopFading();
         if ( interpolantValue === 0 ) {
           this.enabled = false;   // ← fadeOut 结束后自动 disable，不保留姿态
         }
       }
     }
   }
   this._effectiveWeight = weight;
   return weight;
   ```
   → **`fadeOut` 结束 = `enabled=false`**；如果此时没有别的 action 在同一批属性上以 >0 权重写入，那批绑定会回到"原姿势"（见 2.3）。要"保持末帧"只能 `clampWhenFinished=true`（paused 而非 disabled）。
4. `crossFadeTo` 会 **disable 起始 action**（`crossFadeTo` 内部 `fadeOut` 到 0 → enabled=false）并（warp=true 时）改它的 timeScale——官方 blending 示例的注释原话：
   > "This function is needed, since animationAction.crossFadeTo() disables its start action and sets the start action's timeScale to ((start animation's duration) / (end animation's duration))"
   所以复用旧 action 前必须 `reset()` / 重新 `setEffectiveWeight`。

### 2.3 weight 混合与"回退到绑定姿势"（`src/animation/PropertyMixer.js`）

这是"看起来没过渡/闪 T-pose"的**数学根因**。r171 `PropertyMixer.apply()`：

```js
apply( accuIndex ) {
  const weight = this.cumulativeWeight;
  ...
  if ( weight < 1 ) {
    // accuN := accuN + original * (1 - cumulativeWeight)
    this._mixBufferRegion( buffer, offset, originalValueOffset, 1 - weight, stride );
  }
  ...
}
```

- `original` 是 binding 第一次被激活时 `saveOriginalState()` 存下的**绑定姿势**（对 VRM 就是 T-pose/rest）。
- 因此：**同一批属性上所有 action 的有效权重和 < 1 时，剩余权重会混到 rest pose**。两个 action 交叉淡入淡出时只要权重和恒为 1 就没问题（官方 blending 示例就是这样设计）；但"目标 action 没播/权重到不了 1"、"先 fadeOut 旧的、几个 action 之后才 play 新的"、"只对一个 action 做了 stop" 都会让 Σw<1 → **渐变或瞬跳回 T-pose**。
- 另一个推论：**fadeOut 到 0 的 action 即使仍处于 active（未被 stop），也不再贡献权重**；如果它是这些属性唯一的 owner，`apply()` 会以累计权重 0 写入 original → **模型回 T-pose**。这正是社区 "fadeOut 后 T-pose" 的机制解释。
- 官方 blending 示例对权重的处理（`examples/webgl_animation_skinning_blending.html`）：
  ```js
  function executeCrossFade( startAction, endAction, duration ) {
    // Not only the start action, but also the end action must get a weight of 1 before fading
    setWeight( endAction, 1 );
    endAction.time = 0;
    startAction.crossFadeTo( endAction, duration, true );
  }
  // setWeight: enabled=true + setEffectiveTimeScale(1) + setEffectiveWeight(weight)
  ```

### 2.4 stop / reset 顺序与 T-pose 闪现（`src/animation/AnimationMixer.js`）

```js
_deactivateAction( action ) {
  if ( this._isActiveAction( action ) ) {
    const bindings = action._propertyBindings;
    for ( let i = 0; i !== bindings.length; ++ i ) {
      const binding = bindings[ i ];
      if ( -- binding.useCount === 0 ) {
        binding.restoreOriginalState();   // ← 最后一个 owner 被移除时，直接写回原姿势
        this._takeBackBinding( binding );
      }
    }
    this._takeBackAction( action );
  }
}
stop() { this._mixer._deactivateAction( this ); return this.reset(); }
```

- **`stop()` = deactivate + reset**；deactivate 在 useCount 归零时 `restoreOriginalState()` → 立即写回 T-pose。
- 安全顺序：**先让新 action `play()`（并给出目标权重）→ 再交叉淡化 → 旧 action 等 fade 完成（自动 disabled）或被新 action 占住绑定后，才可 stop**。不要在旧 action 还占着绑定、新 action 还没激活时 `stopAllAction()`/`stop()`。
- `AnimationMixer.update(dt)` 的顺序：先遍历 active actions 累加权重，再统一 `bindings.apply(accuIndex)` 写场景图；`'finished'` 事件是在 `_updateTime` 里 dispatch 的（update 循环内）。**在 `finished` listener 里刚 `play()` 的新 action 本帧不会被 update（循环长度已捕获），下一帧才生效** → 等 `finished` 再切换会有一帧空窗，更稳的做法是见 §2.5 的"提前 overlap"。

### 2.5 LoopOnce / clampWhenFinished / finished 事件：过渡 clip 的正确用法

r171 `_updateTime()` 的 LoopOnce 分支（原文摘录）：

```js
if ( loop === LoopOnce ) {
  handle_stop: {
    if ( time >= duration ) { time = duration; }
    else if ( time < 0 ) { time = 0; }
    else { this.time = time; break handle_stop; }
    if ( this.clampWhenFinished ) this.paused = true;
    else this.enabled = false;
    this.time = time;
    this.mixer.dispatchEvent( { type: 'finished', action: this, direction: ... } );
  }
}
```

→ **过渡 clip 模式**：`loop=LoopOnce`，播完时二选一：
- `clampWhenFinished=true`：paused 在末帧（weight 仍有效），可以**在结束前 overlap 交叉淡化到循环动作**，或等 finished 后从末帧淡出；官方 morph 示例就是给 emote/一次性动作设 `clampWhenFinished=true`，在 `finished` 回调里 `fadeToAction(restore)`。
- `clampWhenFinished=false`：末帧被 disabled；若不等权重交接就会 Σw<1 → 回 rest。需要在 `finished` 里**立刻**给后续 action 权重 1，且最好提前 overlap 避免空窗。
- 注意 docs 原话："clampWhenFinished has no impact if the action is interrupted"——被打断的 LoopOnce 不会 clamp，中断时要自己处理姿态。

**"过渡 clip 事件切循环"的可运行骨架**（细节见 §5.3）：在 `update` 里检测 `transition.time >= duration - blend` 时启动 `follow.crossFadeFrom(transition, blend, false)`，而不是等 `finished`——这样两个 action 的权重和始终为 1，不会经过 rest。

### 2.6 官方示例的两种模板

| 示例 | 用途 | 关键代码/结论 |
|---|---|---|
| `webgl_animation_skinning_blending`（r171） | 多 loop 动作按权重混合 | 页面提示 "crossfades are possible with blend weights being set to (1,0,0), (0,1,0) or (0,0,1)"；`prepareCrossFade` 在 walk→run 等"非 idle"切换时**等当前 loop 播完**再 `executeCrossFade`；`executeCrossFade` 先 `setWeight(end,1); end.time=0; start.crossFadeTo(end,duration,true)`；`setWeight` 里 `enabled=true; setEffectiveTimeScale(1); setEffectiveWeight(w)` |
| `webgl_animation_skinning_morph`（r171） | **基础 loop state ↔ 一次性动作**（含 Sitting/Death） | 初始化时对 emote 和 state≥4 的 clip 设 `action.clampWhenFinished = true; action.loop = THREE.LoopOnce;`；`fadeToAction()`：`previousAction.fadeOut(duration)` + `activeAction.reset().setEffectiveTimeScale(1).setEffectiveWeight(1).fadeIn(duration).play()`；`mixer.addEventListener('finished', restoreState)` 回到 base state。页面说明："looping in one of several base animation states, then transitioning smoothly to one-time actions" |

→ 本项目要的"站→坐/躺过渡 clip"就是 **morph 示例的一次性动作模式**；"坐下后保持坐姿"就是 base state 模式。

### 2.7 "切换 clip 无过渡/姿势跳变"常见成因清单（r171 口径）

1. **`stop()` 旧 action → restoreOriginalState → T-pose 闪帧**（§2.4）。
2. **`crossFadeTo` 目标未 `play()`/权重到不了 1 → Σw<1 → 混回 rest**（§2.2/2.3；社区 63467、官方示例注释均指向此）。
3. **`fadeOut` 到 0 后没有接续 action**：即使不 stop，weight=0 的 action 不再写姿势，Σw 不足 → 回 rest（§2.3）。
4. **LoopOnce 播完 + `clampWhenFinished=false`**：enabled=false，等 `finished` 再切换 → 一帧空窗 / 回 rest（§2.5）。
5. **复用已播完的 action 忘了 `reset()`**：docs 明确 "a reset must be executed first"，否则 time 停在 duration，`play()` 相当于没动（社区 68541 的答案也是 reset）。
6. **clip 轨道与骨架不匹配**：`THREE.PropertyBinding: Trying to update node for track: Armature.quaternion but it wasn't found.`（社区 68541 实测）→ 该通道根本不参与混合，看起来"fade 没生效/部分骨不动"。
7. **partial clip（缺少通道）**：没有被任何 action 动画的属性能否回到 rest 取决于 binding 的 owner 状态；等价于 Unity Write Defaults 的"未动画属性被写默认值"问题。
8. **hips/root 位移基准不同**：即使权重完美、姿势旋转完全一致，两个 clip 的 hips 高度差也会在淡入淡出中表现为"竖直滑/跳"（three-vrm issue #1643 标题即此；本项目 sleep 的 −0.884 m 常量偏移是同类问题，见 §3.3/§5-E）。
9. **首帧从绑定姿势 fadeIn**：第一条 clip 的 fadeIn 从 0 开始，权重和 <1 的帧里即混 rest；本项目已用"首条 clip 直接满权重吸附"修过（`clip-player.ts:1184`、`docs/research/startup-pose-flash.md`），**说明团队已经踩过同一个坑**。
10. **权重曲线是线性的**：`_scheduleFading` 用 LinearInterpolant；长距离姿势过渡线性权重观感像匀速滑；社区 10189 建议自己 tween 权重做 ease-in/out（本项目自定义 crossfade 已用 smoothstep，是优势）。

### 2.8 本项目自定义 crossfade 与 three.js 的差异（重要）

`clip-player.ts` 不是 AnimationMixer 方案，而是**自研 per-bone slerp + hips lerp**：

- "交叉淡入：per-bone 短弧 slerp + Hips 位置 lerp，权重用 smoothstep；时长取 `新 clip.fadeInSec` / `旧 clip.fadeOutSec`，无数据时默认 0.2s"（`clip-player.ts:19-25`）；
- 从**当前已应用姿势快照**（`appliedPose`/`appliedHips`）起混，而不是从 rest 起混（`clip-player.ts:1188-1200`）→ **天然规避了 §2.3 的"权重和<1 混回 T-pose"和 §2.4 的 stop 回写绑定姿势**；
- 未覆盖骨回 rest（`clip-player.ts:1251-1258`）→ 等价 Write Defaults 风险；
- 首条 clip 直接吸附、后续才 crossfade（`clip-player.ts:1184`）→ 已修启动 T-pose；
- **剩下的两个真问题**：
  1. `fadeSec` 是常数时间，不看**姿势距离**；站→睡（髋 −0.88 m、脊柱大角度）用 0.15–0.2 s 必然像瞬移；
  2. 自定义方案没有"过渡状态/过渡 clip 序列"概念，mood 一切换就是两个循环 clip 直接插值——中间没有作者设计的重心转移姿势。

→ 迁移到 AnimationMixer 不是必须；**保留自研 crossfade，但把"过渡 clip + 姿态 sequencer"做在同一 writer 里**（同一套 per-bone 写入 + humanoid.update），风险最低。若未来改用 AnimationMixer，务必按 §2.2–2.5 的顺序/权重规则，且帧序仍为 `mixer.update` → `vrm.update`。

---

## 3. three-vrm 3.5.5：官方文档 / README / 示例

> 版本口径：包版本 `3.5.5`（`node_modules` 实测）；官方 API 文档站是 `3.x latest`（✅ 可读），行为以 **`v3.5.5` tag 源码**核对（✅ raw 可读）。
> 注意：3.5.5 官方示例 importmap 写的是 `three@0.180.0`；本项目锁 `three@0.171.0`（`three-vrm` peer 要求 `>=0.137`），升级 three 时需回归。

### 3.1 normalized / raw 与帧内顺序（API 文档 + 源码）

`docs/classes/three-vrm.VRMHumanoid.html`（✅）：

- `autoUpdateHumanBones`："Whether it copies pose from normalizedHumanBones to rawHumanBones on `update`. `true` by default."
- `getNormalizedPose()` / `setNormalizedPose()`："Each transform is a local transform relative from rest pose (T-pose)."
- `update()`："If `autoUpdateHumanBones` is `true`, it transfers the pose of normalized human bones to raw human bones."
- `normalizedRestPose`、`rawRestPose`、`getNormalizedBoneNode()` / `getRawBoneNode()` 区分两套节点。

`packages/three-vrm-core/src/VRMCore.ts`（v3.5.5）`update(delta)` 的真实顺序：

```ts
public update( delta: number ): void {
  this.humanoid.update();                 // normalized → raw
  if ( this.lookAt ) { this.lookAt.update( delta ); }
  if ( this.expressionManager ) { this.expressionManager.update(); }
}
```

`packages/three-vrm/src/VRM.ts`（v3.5.5）在 `super.update(delta)` 之后继续：`nodeConstraintManager.update()` → `springBoneManager.update(delta)` → 每个 `material.update(delta)`。

→ **推荐帧序**（官方示例同款）：写 normalized（AnimationMixer 或手写）→ **`vrm.update(dt)`** → render。
`vrm.update(dt)` 不可省："**You need to call this on your update loop.**"（VRM.update 文档）。
官方 VRMA 示例（`packages/three-vrm-animation/examples/loader-plugin.html`，v3.5.5）原文顺序：

```js
const deltaTime = clock.getDelta();
mixer.update( deltaTime );
vrm.update( deltaTime );
renderer.render( scene, camera );
```

### 3.2 官方 VRMA 播放示例（✅ 源码可读）

`loader-plugin.html`（v3.5.5）关键链路：

```js
loader.register( ( parser ) => new VRMLoaderPlugin( parser ) );
loader.register( ( parser ) => new VRMAnimationLoaderPlugin( parser ) );
const vrm = ( await loader.loadAsync( './models/VRM1_Constraint_Twist_Sample.vrm' ) ).userData.vrm;
const lookAtQuatProxy = new VRMLookAtQuaternionProxy( vrm.lookAt );   // 播 look-at 轨道需要
lookAtQuatProxy.name = 'lookAtQuaternionProxy';
vrm.scene.add( lookAtQuatProxy );
const vrmAnimation = ( await loader.loadAsync( './models/test.vrma' ) ).userData.vrmAnimations[ 0 ];
const clip = createVRMAnimationClip( vrmAnimation, vrm );
const mixer = new THREE.AnimationMixer( vrm.scene );
mixer.clipAction( clip ).play();
```

API 文档（✅）：`@pixiv/three-vrm-animation` 模块导出 `VRMAnimation`、`VRMAnimationLoaderPlugin`、`VRMLookAtQuaternionProxy`、`createVRMAnimationClip`、`createVRMAnimationHumanoidTracks/ExpressionTracks/LookAtTrack`；示例目录仅 `loader-plugin.html` / `dnd.html` 两个（✅ 列表页），**官方没有提供"多 clip 过渡/混合"的 three-vrm 示例**——过渡要按 three.js AnimationAction 语义自己做（§2）。

### 3.3 多 clip / hips 位移注意事项（官方源码 + issue）

- `createVRMAnimationClip.ts`（v3.5.5）对 hips 位移的处理：
  ```ts
  const animationY = vrmAnimation.restHipsPosition.y;
  const humanoidY = humanoid.normalizedRestPose.hips!.position![1];
  const scale = humanoidY / animationY;
  // translation track values *= scale（VRM0 还有轴翻转）
  ```
  → VRMA 的 hips 位移是**按"动画自身 rest hips 高 / 目标模型 normalized rest hips 高"缩放后**写进目标模型的 normalized hips position。**不同来源的 clip（Mixamo/Unity bake/手 K）rest 基准不同时，缩放后仍会残留不同的整体高度偏移**，换 clip 时表现为"下沉/上浮/瞬移"。
- `VRMAnimationLoaderPlugin.ts` 对 T-pose 违规的官方警告：
  > "VRMAnimationLoaderPlugin: The loaded VRM Animation might violate the VRM T-pose (The y component of the rest hips position is approximately zero or below.)"
- GitHub issue（标题已验证，正文被 GitHub 前端截断未读全）：**`pixiv/three-vrm#1643` "VRM model sinks into floor after animation switch due to Mixamo hips position offsets"** → 与上面源码机制完全对应。
- 结论：**做 clip 间过渡时，必须把"hips 竖直基准差"当成独立通道处理**（过渡 clip 里烘焙 hips 轨迹，或过渡期间对 hips 偏移单独做缓动/归一化），不要指望旋转/权重插值能掩盖它。

### 3.4 对本项目的结论

1. 本项目目前**不用 AnimationMixer**：`clip-player.ts` 直接写 `humanoid.getNormalizedBoneNode(...).quaternion` + hips position，然后 `humanoid.update()`（`clip-player.ts:1317`），animator 再 `vrm.update(dt)`（`animator.ts:400`）——**与 three-vrm 官方推荐帧序一致**，不需要改。
2. 如果为了过渡 clip 引入 AnimationMixer：**必须保持 single writer**（别让 mixer 和 clip-player 同时写 normalized 骨）；mixer 的 root 用 `vrm.scene`，轨道名用 normalized 骨节点名；`mixer.update` 之后 `vrm.update`，不要在 `vrm.update` 之后再 `mixer.update`（否则 spring bone 用上一帧骨架）。
3. 归一化姿势写入后**不要只调 `humanoid.update()` 忘了 `vrm.update(dt)`**；否则表情/材质/spring/约束不更新（既有 `docs/research/vrm-runtime-research.md` 已详述，这里不重复）。
4. VRM 0.x 的 `metaVersion` 轴翻转只在 `createVRMAnimationClip` 里做；本项目 clip 数据是 Unity humanoid → VRM normalized 的自烘焙格式（`clip-data.ts`），**不要混用两套 hips 语义**（一套是 VRMA rest-hips 缩放，一套是 `avatar.hipsRestHeight / clip.sourceHipsHeight` 缩放，见 `clip-player.ts` 文件头）。

---

## 4. 社区/权威帖结论

### 4.1 three.js discourse（✅ 正文可读）

- **`/t/how-to-transition-between-animations-smoothly/16004`**：症状"walk/run 之间会瞬间闪现 T-pose 再进下一个动作"。donmccurdy 给出官方 morph 示例的写法：
  ```js
  previousAction.fadeOut( duration );
  activeAction.reset().setEffectiveTimeScale(1).setEffectiveWeight(1).fadeIn(duration).play();
  ```
  楼主确认 "我加了 fadeOut() 和 reset() 后修好了"。（本项目的 m7 结论：**reset 缺失**也是同类问题的常见一环）
- **`/t/t-pose-between-animation-transitions/68541`**：切换 clip 会经过 T-pose；回答包括"在 fadeIn 前 reset"，并发现真正原因是 **`Armature.quaternion` 轨道在骨架里找不到**（"THREE.PropertyBinding: Trying to update node for track… but it wasn't found"）→ 部分通道没被动画时观感就是"fade 不工作"。**结论：先保证轨道全部绑定成功，再谈过渡。**
- **`/t/animationaction-crossfadeto-not-working/63467`**：`walkAction.crossFadeTo(idleAction, 1)` "fades the walk animation to the rest T-pose"；把 `idleAction.weight = 1` 作为 workaround 后正常。→ 与 §2.2/2.3 的"crossFadeTo 不 play 目标 / 权重和<1 混回 rest"机制一致。
- **`/t/t-pose-between-animation-transitions/68541` 邻帖 & `/t/animation-t-poses-on-switching-animation-clips/46494`**：一次性动作播完切回 base state 时 T-pose；答案 `clampWhenFinished`（保持末帧）+ 在 `finished` 事件里接续 → 就是 §2.5 的官方模式。
- **`/t/smooth-fading-between-animation-clips/10189`**：讨论"three.js 的 crossfade 权重是线性的"；解法是**自己缓动权重**（ease-in/out），或保持两份权重和=1 做自定义混合。
- **`/t/what-variable-to-pass-for-crossfadeto/28186`**：Mugen87 澄清 `crossFadeTo` 的参数是 `AnimationAction` 实例；多名用户反馈 crossFadeTo 不工作、crossFadeFrom 正常 → 再次指向"目标 action 必须已激活"。

### 4.2 GitHub issues（标题 ✅ / 正文 ⚠️ 截断）

- **`mrdoob/three.js#19328`**：标题 "Inconsistent behavior between AnimationMixer.stopAllActions() and AnimationAction.stop()" → stop 语义有历史坑；本项目结论以 r171 源码为准（`stop = deactivate + reset`；deactivate 可能 restore 绑定姿势）。
- **`pixiv/three-vrm#1643`**：标题 "VRM model sinks into floor after animation switch due to Mixamo hips position offsets" → 与 §3.3 对应。
- （GitHub 搜索页/API 本次被限流，正文未逐条读取；标题来自页面 `<title>`，按"标题已验证、正文未验证"标注。）

### 4.3 Unity 社区（❌ 未验证，仅记录检索线索）

- `discussions.unity.com` 的 AnyState 相关帖（如 "Mecanim: How to stop the Any State transition being called multiple times to same state"、`/t/the-any-state-to-animation-the-animation-is-playing-wrong/636496`）**本次抓取返回 `unsupported content type`**，正文未能验证；Unity Issue Tracker（`issuetracker-mig.prd.it.unity3d.com`）返回 **502**；Unity 官方博客 `state-machine-transition-interruptions` 只抓到导航壳。→ 本报告对 AnyState 的判断**只引用官方手册/API 原文 + 直接推论**，不把上述社区帖当证据。

### 4.4 桌宠状态门控的常见写法（设计综合，非外部结论）

未检索到可引用的"官方桌宠状态机规范"；但 Unity 官方参数机制足够明确：**AI/逻辑层只写参数（Bool/Trigger/Integer/Float），Animator 只按条件 transition**（`AnimationParameters.html` 原文）。落到本项目（Unity 等价写法）：

- `posture`（Enum/Integer：0=stand 1=sit 2=lie）+ `surface`（Integer：ground/window/dock）+ `interrupt`（Trigger：drag/error）；
- 常规态只允许相邻状态边：stand→sit 条件 `surface != ground`；sit→lie 条件 `surface == window && highWindow`；**没有 stand→lie 直达边**（对应 §1.5 的 sub-state machine）；
- 一次性过渡 clip 用 Trigger；Bool 条件在进入目标 state 的 OnStateEnter 里复位（避免 AnyState 常亮重入）。

---

## 5. 对本项目的可执行建议

> 下面"必须做"是修用户 bug 的必要条件；"参数调优"可在同一轮或下一轮做。**不要改项目源码的约束只针对本报告；实施由 Lead/另一会话负责。**

### 5.1 P0 必须做

#### A. 行为门控：sleep/躺 只能在可坐表面（window-top/dock）上发生

**本地事实**：
- `sleep` 定义 `requirements: ['grounded','mouseAway']`（`src/renderer/src/behavior/activities.ts:222-233`）→ 地面可睡；
- `isRequirementMet('sittableSurface')` 只是 `sittableSurfaceCount > 0`（`activities.ts:358-381`）——**"桌面上存在可坐表面"，不等于"宠物正站在上面"**；直接给 sleep 加 `'sittableSurface'` 不能修 bug；
- 但 `SchedulerContext` 已有 `surfaceKind: SurfaceKind | null`（`src/renderer/src/behavior/types.ts:92`，由 `behavior-director.ts:2126` 从 `frame.currentSurface?.kind` 填入）；
- `prepareActivity('sleep')` 返回 `{}`（`behavior-director.ts:1879-1882`）→ 睡眠是"原地开始"，不会先走到窗沿；所以门控判定必须基于**当前所站表面**。

**最小改法（示意，未实施）**：

```ts
// 1) behavior/types.ts：新增一个"当前站在可坐表面"的 requirement
export type ActivityRequirement =
  | 'grounded' | 'sittableSurface' | 'climbableSurface'
  | 'elevated' | 'pointerNear' | 'mouseAway'
  | 'standingOnSittable'        // ← 新增

// 2) behavior/activities.ts：sleep 改为
{
  id: 'sleep',
  requirements: ['standingOnSittable', 'mouseAway'],   // 原来 ['grounded','mouseAway']
  ...
}

// 3) behavior/activities.ts isRequirementMet()
case 'standingOnSittable':
  return context.surfaceKind === 'window-top' || context.surfaceKind === 'dock'
```

**产品口径二选一（需 Lead/用户拍板）**：
- 方案 1（推荐，贴合用户原话"只会在被放在窗口上时坐下/躺下"）：**sit 的 `prepareSitTarget` 也收紧为"只有当前站在可坐表面时才允许坐"**，即删掉"从地面自动走到窗沿坐下"的路径；保留 `trySitOnWindowTop` / 落地在窗沿的事件驱动坐（`behavior-director.ts:1123-1129`、`1387-1430`）。
- 方案 2（保守）：sleep 严格窗沿限定；sit 仍允许"走过去坐"，但**离开窗沿/落地到地面后禁止再随机抽到 sit**（否则用户会看到它自己走到窗沿坐，和"只被放上去才坐"的预期不符）。

另外：`menubar top=0` 的不可见表面已按 B1 决策排除（不在 `sittableSurfaces`），无需重复处理。

#### B. 姿态过渡状态机 + 过渡 clip（核心资产改动）

**为什么必须做**：Unity 官方把"多阶段复杂动作"定义为 sub-state machine（§1.5）；unity 把"差异大的动作 blend"限制为"相似才自然"（§1.6）；本项目 sleep 的髋偏移 −0.884 m 使 0.15–0.2 s 的纯权重过渡在物理速度上不成立（§0-1）。**纯参数调长 fade 只能变成"慢动作滑下去"，仍然是中间姿势不存在的观感问题。**

**建议的资产清单（Blender/Unity bake，全部 rootMotion=inPlace；时长建议）**：

| clip id（建议命名） | 用途 | 时长 | 首帧要求 | 末帧要求 |
|---|---|---|---|---|
| `mate-trans-stand-sit` | 站→坐 | 1.0–1.4 s | 与 idle 站姿关键骨一致（误差 <3°） | 与 `mate-sit1` 循环首帧一致 |
| `mate-trans-sit-lie` | 坐→躺/趴（高窗） | 1.2–1.8 s | 与 `mate-sit1` 首帧一致 | 与 `mate-windowLay8/9/10` 之一首帧一致（建议固定选一个作为 lie 主循环） |
| `mate-trans-lie-sit` | 躺→坐起身 | 1.0–1.5 s | 对齐 lie 主循环首帧 | 对齐 sit 首帧 |
| `mate-trans-sit-stand` | 坐→站 | 0.8–1.2 s | 对齐 sit 首帧 | 对齐 idle 站姿 |
| `mate-trans-sleep`（可选） | 站/坐→睡（若保留"站着睡"产品） | 1.5–2.2 s | 对齐当前站姿或坐姿 | 对齐 `mate/sleep.json` 循环首帧 |
| `mate-trans-wake`（可选） | 睡→坐/站 | 1.0–1.5 s | 对齐 sleep 循环首帧 | 对齐 sit/站姿 |

**关键资产规范**：
1. **过渡 clip 必须全骨覆盖**（本项目写 52 根 normalized 骨；可用 `snapshot().missingBones` 校验，`clip-player.ts` 已有该字段）——未覆盖骨回 rest 会造成"过渡到一半某根骨头跳一下"，等价 Unity Write Defaults 问题（§1.1）。
2. **末帧必须精确落在目标循环 clip 的首帧姿势上**（四元数夹角 ≤3–5°、hips 位置差 ≤2 cm）；这样"过渡 clip → 循环 clip"的 crossfade 可以短到 0.1–0.15 s 甚至瞬时（因为两端同姿势）。
3. **hips 轨迹烘焙在过渡 clip 里**（重心从脚移到臀/背），不要把 −0.884 m 的大位移留给运行时 per-clip 常量补偿插值。
4. **不要放进 `app-manifest` 的 mood 槽位**（否则会参与 mood 变体随机轮换）；只放 `app-catalog.json`，`tags:["transition"]`，并保证 priority < −9（现有约定"低于 −9 的保留不参与轮换"，见 `clip-player.ts` 选片注释）。

**接线方式（按现有代码，风险最低）**：
- 现有 `animator.ts` 的 `moodTransitionClips` 正好是"进入/离开 mood 播一次性 clip"的 hook（`animator.ts:262-290`；配置在 `main.ts:209-216`）。最小接线：
  ```ts
  const VRM_MOOD_TRANSITION_CLIPS = {
    dshError: { /* 现有 */ },
    sit:   { enterClip: 'mate-trans-stand-sit',  enterHold: false, exitClip: 'mate-trans-sit-stand' },
    sleep: { enterClip: 'mate-trans-sleep',      enterHold: false, exitClip: 'mate-trans-wake' }
  } as const;
  ```
  注意现有逻辑：进入 mood 时先播 **previous mood 的 exitClip** 再播 **新 mood 的 enterClip**（`animator.ts:264-296`）。真正安全的是：**进入 sit 时只播 sit 的 enterClip（站→坐）**；离开 sit 时播 exitClip（坐→站）。用 `hold:false` 让一次性 clip 播完自动回 mood 循环（现有 `playOneShotClip` 语义：`hold=false` 播完回 mood；`hold=true` 保持末帧）。
- **sit→lie 不能用 moodTransitionClips**（同一个 mood `sit` 内部切换）：需要把"lie"提升为姿态层的子状态。建议做一个轻量 posture sequencer（可放在 `animator.ts`，复用 `clipPlayer.playClipById`/`playOneShotClip`）：
  ```ts
  type Posture = 'stand' | 'sit' | 'lie'
  const POSTURE_TRANSITION: Partial<Record<`${Posture}->${Posture}`, string>> = {
    'stand->sit': 'mate-trans-stand-sit',
    'sit->lie':   'mate-trans-sit-lie',
    'lie->sit':   'mate-trans-lie-sit',
    'sit->stand': 'mate-trans-sit-stand'
  }
  // 触发：playOneShotClip(transitionId, { loop:false, hold:true, fadeSec:0.15 });
  // 播完：写 posture 主循环 clip（playClipById(loopId,{loop:true,fadeSec:0.12}))；
  // 期间 postureTransitioning=true → 拒绝低优先级活动/情绪抢占（见 C）。
  ```
  如果不想改 animator 结构：**最低限度**把 `animator.ts:298-320` 的"高窗 lie = 直接 `playClipById(candidate,{loop:true,fadeSec:0.3})`"改成"先播 `mate-trans-sit-lie` 一次性，再 loop lie"。当前这里就是"坐姿 0.3 s 直接淡成躺姿"——窗沿上同样会显得突然躺下。
- 过渡 clip 与循环 clip 交接时的 `fadeSec` 用 0.1–0.2 s（姿势已对齐）。

#### C. 打断策略：过渡期间锁状态，睡眠中必须"醒"

- 现状：`clip-player.update` 里 `manualActive = active.manual && !active.finished` 会阻止事件 clip 覆盖（`clip-player.ts` update 开头），但**没有"过渡 clip 不可被普通 mood 变化打断"的概念**；`setMoodOverride` 会直接清 active（调试路径可控）。行为层也没有 `interruptible` 标记。
- 建议：
  1. 给 activity/posture 增加 `interruptible: boolean`（或 sequencer 内部 `transitioning` 状态）：站立→坐/躺的过渡**不可**被 idle/walk/sit 变体打断；只有 drag/fall/pat 等**高优先级事件**能中断（中断后按 `stopManualClip(0.2)` 淡出到当前姿态，并**重置 posture 状态机**，不要留下"半躺"状态）。
  2. 睡眠中鼠标靠近/被点击/被拖拽 → 必须先播 `mate-trans-wake`（或至少 0.4–0.6 s 的起身过渡）再回 idle；不要直接 `sleep`→`idle` 0.2 s 硬切。
  3. 退出 sleep 的 exitClip（`wake`）用 `hold:false`；如果用户连续交互打断了 wake，把 posture 重置为 `stand`/`sit` 中最接近的一个，避免状态与视觉不一致。
- Unity 语义映射：过渡剪辑期间 = `Ordered Interruption: checked`；只有更高优先级事件 = `Interruption Source` 里允许的全局打断。

### 5.2 P1 参数调优

#### D. fade 时长按"姿势距离"自适应（不要常数 0.2 s）

即使走过渡 clip，首尾 fade 和"没有过渡 clip 的兜底路径"也需要自适应。建议在 clip 加载时预计算每个 clip 相对"站姿参考"的距离元数据（离线在 `build-app-manifest.mjs` 里算好写进 catalog 最省运行时）：

```ts
// 建议的兜底公式（无过渡 clip 时）；hipsDeltaM 来自 hips 位置差，angle 为关键骨最大夹角
function transitionFadeSec(hipsDeltaM: number, angleRad: number): number {
  const byHips = hipsDeltaM / 0.6;          // 0.6 m 给 1 s
  const byAngle = angleRad / (Math.PI / 3) * 0.6;
  return Math.min(2, Math.max(0.25, 0.2 + byHips + byAngle));
}
// 例：idle→sleep（hips 0.884 m、脊柱大角度）≈ 0.2 + 1.47 + 0.6 → clamp 2 s；
// 即使不走过渡 clip，也应 ≥1.0–1.5 s，而不是 0.15–0.2 s。
```

- 现有 `resolveFadeSec` 取 `max(新.fadeInSec, 旧.fadeOutSec)` 并 clamp 2 s（`clip-player.ts:1212-1227`）——**对 sleep/sit 这类大位移 clip，manifest 的 0.15/0.2 必须改**（或加"大位移 clip 最低 fade 下限"规则）。
- 权重曲线保持 `smoothstep`（已是缓入缓出，`clip-player.ts:1242`），比 three.js 默认线性好；无需改。

#### E. grounding offset / hips 轨迹：别让常量贴地补偿变成"瞬移源"

- 现状：mate 集未标 `grounding` 的 clip 走 pose grounding 兜底，**每 clip 一个常量偏移**；实测 `sleep = −0.884 m`（`docs/wave2-acceptance.md` §2）。`applyFrame` 把 `targetOffset[1] += groundOffsetForClip(...)`，再与 `fromHips` 做 lerp（`clip-player.ts:1288-1310`）——与 fade 同步，但 fade 只有 0.15–0.2 s 时就是 0.88 m/0.2 s 的下坠。
- 建议（任选，按成本）：
  1. **资产侧**：把 sleep/lie 类 clip 的 hips 高度按目标姿态重新烘焙到"贴地正确"的位置（`grounding:'feet'` 或显式 `grounding:'none'` + 作者保证），使常量偏移尽量接近 0；过渡 clip 自带 hips 轨迹；
  2. **运行时**：对"大位移 clip"的 groundOffset 施加上限/独立时长（例如 groundOffset 用 max(fadeSec, 0.8 s) 缓动，或在 transition clip 期间冻结 offset 由 clip 自身 hips 决定）；
  3. **过渡 clip 期间**：把 `groundOffsetForClip` 对新旧 clip 的偏移也做同一条缓动曲线（现在 lerp 已经跟随 fade，但时长太短，治标不治本）。
- 同步问题：`visualOffsetPx`（sit 时 hips 贴窗沿的整体下移）当前用 `1 - exp(-dt/0.15)` 指数趋近（`animator.ts:350-358`），与 clip fade 时长无关；**进坐时"整体模型下移"和"姿势混合"两条曲线应共用时长/缓动**，否则一个先到一个后到，会看到"先滑下去再坐下"或反之。

#### F. 构建期/测试校验（防回归）

1. 过渡 clip 全骨覆盖：`snapshot().missingBones === []`；若不为空，构建脚本 fail。
2. 首末帧对齐：对每条过渡 clip 采样首帧/末帧，与相邻循环 clip 的首帧比较：四元数最大夹角 ≤5°、hips 位置差 ≤2 cm；在 `scripts/vrm/motion/build-app-manifest.mjs` 或新校验脚本里断言。
3. 单测建议（可直接给另一会话）：`behavior-director` 在地面时 `scoreActivity(sleep) === 0`、站在 `window-top` 时可 >0；`animator` 在 mood `idle→sit→sleep` 序列中必须观察到 transition clip id 出现在 `lastClipSnapshot.clipId`；过渡期间插入中低优先级事件不得改变 clip id。
4. 验收视觉：逐帧截图/录屏对比"地面待机 60s 不出现睡姿"、"放到窗沿后 0.5–1s 内出现 sit 过渡且不瞬移"。

### 5.3 three.js 侧可直接用的代码片段（给"若迁移/若参考"用）

> 本项目当前是自研 clip-player；以下是 **three.js r171 + three-vrm 3.5.5 官方语义**的可运行模式，便于对照实现或未来迁移。

**（1）正确的 fadeToAction（官方 morph 示例模式，带 reset）**

```js
function fadeToAction(actions, mixer, name, duration) {
  const activeAction = actions[name];
  const previousAction = actions._active ?? null;
  if (previousAction && previousAction !== activeAction) previousAction.fadeOut(duration);
  activeAction
    .reset()                       // 必须：清掉 enabled/time/loopCount/残留 fading
    .setEffectiveTimeScale(1)
    .setEffectiveWeight(1)         // 让权重能从 1 起算（fadeIn 会乘到 0→1）
    .fadeIn(duration)
    .play();
  actions._active = activeAction;
  return activeAction;
}
```

**（2）过渡 clip（LoopOnce）→ 循环 action：提前 overlap，避免经过 rest pose**

```js
// transition: LoopOnce 的过渡 clip；follow: 目标循环 clip
// 在每帧 update 中提前 blend：
function playTransition(mixer, transition, follow, blendSec = 0.15) {
  // 目标循环先激活并占住 PropertyMixer（权重 0 也可以；避免 stop 时 restore 绑定姿势）
  follow.reset().setEffectiveTimeScale(1).setEffectiveWeight(0).play();
  // 过渡 clip 满权重播放；首帧应与当前已应用姿势一致（资产保证）
  transition
    .reset()
    .setLoop(THREE.LoopOnce, 1)
    .setEffectiveTimeScale(1)
    .setEffectiveWeight(1)
    .play();
  transition.clampWhenFinished = true;   // 末帧保持（paused），等 follow 接管

  return {
    update() {
      const duration = transition.getClip().duration;
      if (transition.time >= duration - blendSec) {
        follow.setEffectiveWeight(1);
        follow.crossFadeFrom(transition, blendSec, false); // 两个权重和保持 1
        return true; // done
      }
      return false;
    }
  };
}

// 主循环（three-vrm 官方帧序）
const dt = clock.getDelta();
pending = pending && !pending.update() ? pending : null;
mixer.update(dt);
vrm.update(dt);
renderer.render(scene, camera);
```

> 为什么不用 `finished` 事件直接切：`clampWhenFinished=false` 时 action 在末帧被 `enabled=false`，`finished` listener 里 `play()` 的新 action 要下一帧才被 mixer 更新 → 至少一帧没有 action 写这些通道 → `PropertyMixer` 以权重 0 写回绑定姿势（T-pose 闪帧）。提前 overlap（或 `clampWhenFinished=true` 后再淡出）可规避。

**（3）反例/时序注意点**

```js
// ❌ 错误 1：旧 action 先 stop → deactivate 可能 restoreOriginalState → 一帧 T-pose
oldAction.stop();
newAction.play();

// ❌ 错误 2：crossFadeTo 不会 play 目标；目标未激活时 Σw<1 → 混回 rest
oldAction.crossFadeTo(newAction, 0.3);   // newAction 从未 play() → T-pose

// ✅ 正确顺序：
newAction.reset().setEffectiveTimeScale(1).setEffectiveWeight(1).play();
oldAction.crossFadeTo(newAction, 0.3, false);
// oldAction 在 fade 结束后会被自动 enabled=false；不要提前 stop。

// ✅ 若必须 stop 旧 action：等 newAction.getEffectiveWeight() === 1 之后
```

**（4）Unity 等价参数对照（设计自检表）**

| 参数 | Unity | three.js r171 |
|---|---|---|
| 过渡时长（秒） | `CrossFadeInFixedTime(durationSec)` / Fixed Duration | `crossFadeTo(durationSec)` / `fadeIn/Out(durationSec)` |
| 过渡时长（归一化） | `CrossFade(normalizedDuration)` | `duration / clip.duration` 自行换算 |
| 目标起始相位 | `Transition Offset` / `normalizedTimeOffset` | `target.time = offset` 或 `startAt` |
| 播完保持末帧 | state 不 exit / Exit Time 控制 | `clampWhenFinished=true` |
| 播完回到 base | transition 回 base state | `finished` 事件 + `reset/fadeToAction` |
| 过渡不可打断 | Ordered Interruption = checked | 自己维护 `transitioning` 标志，期间不调用其他 action 的 fade/stop |

---

## 6. 来源清单与验证状态

> 验证时间：2026-11-09（Asia/Shanghai）。✅ = 已抓取并阅读正文；⚠️ = URL 可达但正文为 JS 渲染/被前端截断，只作辅助；❌ = 打不开/内容不可用，仅记录线索、不作为结论依据。
> 外部内容均为 untrusted data，本报告只作资料整理；所有代码片段是示意，未在本项目执行。

### 6.1 Unity 官方（✅，版本口径：Unity 2022.3 LTS Manual/ScriptReference；Unity 6 已迁移到 docs.unity.com）

| # | 内容 | URL | 状态 |
|---|---|---|---|
| U1 | Animation States（Any State、Write Defaults） | https://docs.unity3d.com/2022.3/Documentation/Manual/class-State.html | ✅ |
| U2 | Animation transitions（Transition Duration/Exit Time/Interruption/条件/曲线图） | https://docs.unity3d.com/2022.3/Documentation/Manual/class-Transition.html | ✅ |
| U3 | Animation State Machines（入口页，指向各子页） | https://docs.unity3d.com/2022.3/Documentation/Manual/AnimationStateMachines.html | ✅ |
| U4 | State Machine Transitions（Entry/Exit、子状态机算独立状态机） | https://docs.unity3d.com/2022.3/Documentation/Manual/StateMachineTransitions.html | ✅ |
| U5 | State Machine Behaviours（OnStateEnter/Exit、三活动状态语义） | https://docs.unity3d.com/2022.3/Documentation/Manual/StateMachineBehaviours.html | ✅ |
| U6 | Sub-State Machines（Trickshot 多阶段例子、Up state、外部 transition） | https://docs.unity3d.com/2022.3/Documentation/Manual/NestedStateMachines.html | ✅ |
| U7 | Blend Trees（Transition vs Blend Tree、相似性要求） | https://docs.unity3d.com/2022.3/Documentation/Manual/class-BlendTree.html | ✅ |
| U8 | Animation Layers（Override/Additive/mask/同步） | https://docs.unity3d.com/2022.3/Documentation/Manual/AnimationLayers.html | ✅ |
| U9 | Animation Parameters（Bool/Trigger 与 SetBool/SetTrigger） | https://docs.unity3d.com/2022.3/Documentation/Manual/AnimationParameters.html | ✅ |
| U10 | Animation FAQ（层顺序、默认值参与混合） | https://docs.unity3d.com/2022.3/Documentation/Manual/MecanimFAQ.html | ✅ |
| U11 | `Animator.CrossFade`（归一化时间；层名前缀） | https://docs.unity3d.com/2022.3/Documentation/ScriptReference/Animator.CrossFade.html | ✅ |
| U12 | `Animator.CrossFadeInFixedTime`（秒） | https://docs.unity3d.com/2022.3/Documentation/ScriptReference/Animator.CrossFadeInFixedTime.html | ✅ |
| U13 | `StateMachineBehaviour`（三状态、消息顺序、实例化） | https://docs.unity3d.com/2022.3/Documentation/ScriptReference/StateMachineBehaviour.html | ✅ |
| U14 | `Animations.AnimatorStateTransition`（duration/exitTime/hasFixedDuration/interruptionSource/orderedInterruption 等） | https://docs.unity3d.com/2022.3/Documentation/ScriptReference/Animations.AnimatorStateTransition.html | ✅ |
| U15 | `AnimatorStateTransition.canTransitionToSelf`（AnyState 自打断开关） | https://docs.unity3d.com/2022.3/Documentation/ScriptReference/Animations.AnimatorStateTransition-canTransitionToSelf.html | ✅ |
| U16 | Unity 6 对应页（JS 渲染，正文未抓全） | https://docs.unity.com/en-us/engine/6000.0/manual/animation-section/animation-mecanim/animation-animator-controller/animation-state-machines/class-transition | ⚠️ |
| U17 | Unity 博客 "State Machine Transition Interruptions"（只抓到导航壳） | https://unity.com/blog/engine-platform/state-machine-transition-interruptions | ⚠️ |
| U18 | Unity Issue Tracker：Any State + Ordered Interruption（502） | https://issuetracker-mig.prd.it.unity3d.com/issues/any-state-transitions-do-not-work-correctly-with-ordered-interruption | ❌ |
| U19 | Unity Discussions：AnyState 重复触发（`unsupported content type`） | https://discussions.unity.com/t/mecanim-how-to-stop-the-any-state-transition-being-called-multiple-times-to-same-state/626105 | ❌ |
| U20 | Unity Discussions：Any State 播放错误（同上） | https://discussions.unity.com/t/the-any-state-to-animation-the-animation-is-playing-wrong/636496 | ❌ |

### 6.2 three.js（版本口径：r171 / `three@0.171.0`；文档正文用 r171 tag 仓库源文件核对）

| # | 内容 | URL | 状态 |
|---|---|---|---|
| J1 | `AnimationAction` 文档（属性与 fade/crossFade/stop/reset/事件） | https://raw.githubusercontent.com/mrdoob/three.js/r171/docs/api/en/animation/AnimationAction.html | ✅ |
| J2 | `AnimationMixer` 文档（update/stopAllAction/clipAction） | https://raw.githubusercontent.com/mrdoob/three.js/r171/docs/api/en/animation/AnimationMixer.html | ✅ |
| J3 | Animation System 手册（架构类似 Unity/UE4） | https://raw.githubusercontent.com/mrdoob/three.js/r171/docs/manual/en/introduction/Animation-system.html | ✅ |
| J4 | `AnimationAction.js` 源码（fade/crossFade/_scheduleFading/_updateWeight/LoopOnce） | https://raw.githubusercontent.com/mrdoob/three.js/r171/src/animation/AnimationAction.js | ✅ |
| J5 | `AnimationMixer.js` 源码（activate/deactivate/stop 语义/update 顺序） | https://raw.githubusercontent.com/mrdoob/three.js/r171/src/animation/AnimationMixer.js | ✅ |
| J6 | `PropertyMixer.js` 源码（权重和<1 混回 original 的关键代码） | https://raw.githubusercontent.com/mrdoob/three.js/r171/src/animation/PropertyMixer.js | ✅ |
| J7 | 官方示例 webgl_animation_skinning_blending（权重混合/crossfade 顺序/setWeight） | https://raw.githubusercontent.com/mrdoob/three.js/r171/examples/webgl_animation_skinning_blending.html | ✅ |
| J8 | 官方示例 webgl_animation_skinning_morph（LoopOnce+clampWhenFinished+finished，含 Sitting/Death） | https://raw.githubusercontent.com/mrdoob/three.js/r171/examples/webgl_animation_skinning_morph.html | ✅ |
| J9 | 官方文档入口（SPA；正文以 J1–J3 核对） | https://threejs.org/docs/#api/en/animation/AnimationAction | ⚠️ |
| J10 | 官方示例在线页（JS 渲染，只读到标题） | https://threejs.org/examples/#webgl_animation_skinning_blending | ⚠️ |
| J11 | discourse：transition 时闪 T-pose；reset+fadeOut 修复（donmccurdy 贴官方写法） | https://discourse.threejs.org/t/how-to-transition-between-animations-smoothly/16004 | ✅ |
| J12 | discourse：T-pose between transitions；轨道缺失 `Armature.quaternion`；reset 建议 | https://discourse.threejs.org/t/t-pose-between-animation-transitions/68541 | ✅ |
| J13 | discourse：crossFadeTo 变成 T-pose；`target.weight=1` workaround | https://discourse.threejs.org/t/animationaction-crossfadeto-not-working/63467 | ✅ |
| J14 | discourse：一次性动作播完 T-pose；clampWhenFinished + finished 事件 | https://discourse.threejs.org/t/animation-t-poses-on-switching-animation-clips/46494 | ✅ |
| J15 | discourse：线性权重 vs 缓动 | https://discourse.threejs.org/t/smooth-fading-between-animation-clips/10189 | ✅ |
| J16 | discourse：crossFadeTo 参数是 AnimationAction 实例；From 可用 To 不行 | https://discourse.threejs.org/t/what-variable-to-pass-for-crossfadeto/28186 | ✅ |
| J17 | GitHub issue：stopAllActions vs stop 行为不一致（标题已验证，正文截断） | https://github.com/mrdoob/three.js/issues/19328 | ⚠️ |

### 6.3 three-vrm（版本口径：v3.5.5 tag / npm 3.5.5；官方示例 importmap three@0.180.0，本项目 three@0.171.0）

| # | 内容 | URL | 状态 |
|---|---|---|---|
| V1 | `VRMHumanoid` API（normalized/raw、autoUpdateHumanBones、update/getNormalizedPose/setNormalizedPose） | https://pixiv.github.io/three-vrm/docs/classes/three-vrm.VRMHumanoid.html | ✅ |
| V2 | `VRM` API（update 必须每帧调用） | https://pixiv.github.io/three-vrm/docs/classes/three-vrm.VRM.html | ✅ |
| V3 | `three-vrm` 模块首页/README（加载、插件注册） | https://pixiv.github.io/three-vrm/docs/modules/three-vrm | ✅ |
| V4 | `VRMAnimation` API（humanoidTracks/restHipsPosition/duration） | https://pixiv.github.io/three-vrm/docs/classes/three-vrm-animation.VRMAnimation.html | ✅ |
| V5 | `three-vrm-animation` 模块（导出清单） | https://pixiv.github.io/three-vrm/docs/modules/three-vrm-animation | ✅ |
| V6 | 官方示例列表（loader-plugin.html / dnd.html） | https://pixiv.github.io/three-vrm/packages/three-vrm-animation/examples/ | ✅ |
| V7 | 官方 VRMA 播放示例源码（mixer→vrm.update→render 顺序） | https://raw.githubusercontent.com/pixiv/three-vrm/v3.5.5/packages/three-vrm-animation/examples/loader-plugin.html | ✅ |
| V8 | `VRM.ts` 源码（update 顺序：core→constraints→spring→materials） | https://raw.githubusercontent.com/pixiv/three-vrm/v3.5.5/packages/three-vrm/src/VRM.ts | ✅ |
| V9 | `VRMCore.ts` 源码（humanoid.update→lookAt→expression） | https://raw.githubusercontent.com/pixiv/three-vrm/v3.5.5/packages/three-vrm-core/src/VRMCore.ts | ✅ |
| V10 | `VRMHumanoid.ts` 源码（normalized→raw 仅 rotation 全量/hips position） | https://raw.githubusercontent.com/pixiv/three-vrm/v3.5.5/packages/three-vrm-core/src/humanoid/VRMHumanoid.ts | ✅ |
| V11 | `VRMAnimationLoaderPlugin.ts` 源码（T-pose 违规警告、hips 节点映射） | https://raw.githubusercontent.com/pixiv/three-vrm/v3.5.5/packages/three-vrm-animation/src/VRMAnimationLoaderPlugin.ts | ✅ |
| V12 | `createVRMAnimationClip.ts` 源码（hips 位移按 rest hips 缩放；VRM0 轴翻转） | https://raw.githubusercontent.com/pixiv/three-vrm/v3.5.5/packages/three-vrm-animation/src/createVRMAnimationClip.ts | ✅ |
| V13 | 官方 basic 示例（单 clip、不含 mixer） | https://raw.githubusercontent.com/pixiv/three-vrm/v3.5.5/packages/three-vrm/examples/basic.html | ✅ |
| V14 | 官方 README dev（链接/版本可能领先于 3.5.5） | https://raw.githubusercontent.com/pixiv/three-vrm/dev/packages/three-vrm/README.md | ⚠️ |
| V15 | GitHub issue：切换动画后下陷（Mixamo hips offset） | https://github.com/pixiv/three-vrm/issues/1643 | ⚠️（标题 ✅，正文截断） |

### 6.4 未验证/不可用说明（不用于结论）

- Unity Discussions 页面（U19/U20）：本次抓取报 `unsupported content type "unknown"`，可能被站点反爬/CDN 拦截；未用其正文。
- Unity Issue Tracker（U18）：连续两次 502。
- Unity 博客（U17）：只取到导航壳（JS 渲染）。
- GitHub issue 正文（J17/V15）：GitHub issue 页面正文被前端组件截断，仅 `<title>` 可验证；机制结论以 r171/v3.5.5 **源码**为准，不依赖 issue 正文。
- threejs.org 文档/示例在线页（J9/J10）：SPA，正文以 r171 仓库 docs/示例源文件核对（J1–J3/J7/J8）。

---

## 7. 落地顺序建议（给 Lead/另一会话）

1. **先修门控（A）**：1–2 处小改 + 单测，立刻消掉"地面随机躺下"的最刺眼场景（不依赖资产）。
2. **再补过渡资产（B）**：4 条过渡 clip 进 Blender/Unity bake，接 `moodTransitionClips`（站↔坐、睡↔醒）+ lie sequencer（坐↔躺）；同时把 sleep/sit 的 manifest fade 值改大，作为过渡 clip 缺失时的兜底。
3. **打断策略（C）**：过渡/睡眠期间的状态锁 + 醒来链路，避免"修好瞬移后又出现半途抽搐"。
4. **参数/校验（D–F）**：自适应 fade、groundOffset 限制、全骨覆盖与首末帧对齐的构建期断言、逐帧验收（地面 60 s 不睡、窗沿 1 s 内坐下、无 T-pose 帧）。

> 若资产侧排期紧：**A + C + D（把 sleep 的 fade 调到 ≥1.0–1.5 s 且 sleep 仅窗沿触发）** 是"无新资产"的最小可行降级方案；但它只能把"瞬移"变成"较慢的滑落"，B 才是用户观感上的正解。
