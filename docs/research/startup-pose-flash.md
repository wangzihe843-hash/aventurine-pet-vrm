# 启动闪现 T/A-pose 根因与修复（2026-11-09）

> 用户反馈：启动桌宠时会先出现一瞬间「不知道是 T-pose 还是 A-pose」的状态，之后才变成 idle。
> 本文记录**实测复现证据 → 根因 → 修复 → 验证/回滚**。相关代码：
> `vrm/pet-scene-vrm.ts`、`vrm/clip-player.ts`、`vrm/startup-pose.ts`、`renderer/src/main.ts`。

## 1. 现象与实测（逐帧捕获）

用一次性 dev 捕获（`scripts/vrm/capture-startup.mjs` + 主进程 `PET_DEV_CAPTURE_STARTUP_FRAMES=N`
`webContents.beginFrameSubscription` 抓 did-finish-load 后每个呈现帧，零侵入）对**真实 app** 逐帧分析
（非透明像素 bbox 宽高比：T-pose 手臂水平 → 宽；idle → 窄）。

| 指标 | 修复前（before） | 修复后（after-final，freeze 版） |
|---|---|---|
| 捕获帧数 / 有效 fps | 150 帧 / 27.9fps | 150 帧 / 27.9fps |
| **宽 bbox 帧（T-pose）** | **3 帧**（t=465–534ms，最长连续 69ms） | **0 帧**（0 wide / 0 transition / 144 narrow） |
| 首个可见帧 | t=**465ms**，aspect **0.861 = wide（rest T-pose）** | t=**514ms**，aspect **0.5248 = narrow（idle）** |
| 从首个可见帧到稳定 idle | 102ms（t=465→567ms，含中间态） | **0**（首个可见帧即 idle） |
| 可见帧 aspect 区间 / 最大 | [0.4718, **0.8611**] | [0.4681, **0.5248**]（idle 中位 0.4752，首可见帧 ratio 1.10 vs before 1.83） |
| debug 首次 pose 非空 | t≈603ms（`hsr-idle` weight 0.74，仍在淡入） | t≈304ms（`hsr-idle` weight **1**；首个呈现帧 t=505ms 时快照已 pose=hsr-idle/weight=1） |
| 首个可见帧延迟（相对修复前） | — | +49ms（远低于 2.5s 兜底阈值，无隐藏过久回归） |

关键帧：`tests/tmp/startup-pose/keyframes/before-005-first-visible-T-pose.png`（清晰 T-pose）vs
`keyframes/after-final-007-first-visible-idle.png`（首个可见帧已是 idle），对比 sheet
`keyframes/contact-sheet-before-after.png`。数据：`tests/tmp/startup-pose/before/analysis.json`、
`after-final/analysis.json`、`comparison.json`/`comparison.md`（before vs after-final 5 项 checks 全 PASS；
上一版 after 保留为 `comparison-after1.*`）；代码状态快照 `before-code-state.txt` / `after-final-code-state.txt`
（含修复前后 hash 与修复标记行号；`after-final` 为 freeze 版：只有 main.ts 的 ready 等待改动，渲染逻辑 hash 不变）。
`after-final-readyprobe/` 为 50ms 细采样：ready 翻转 ≈253ms、poseApplied ≈304ms、首个呈现帧 t=505ms
→ ready→可见 252ms（<500ms），ready 语义 OK。

## 2. 根因（两条，叠加成「既不像 T 也不像 A」）

1. **可见性门控被绕过（主因，占 ~69ms 纯 rest T-pose）**
   `VrmPetScene` 旧实现已有 `firstAnimationApplied` 门控，但只存在于 `setPetVisible()`；
   真正的可见性写在 `applyModelTransform()` 里（`root.visible = this.petVisible`），而它由
   `placePet()` 每帧调用 → 模型一放进场景就被渲染成 **VRM rest T-pose**，此时动画驱动还在
   异步初始化（clip registry 预载）、首帧 clip 尚未写骨。实测模型可见时 `debug.ready=false`、
   `animation.pose=null`，与根因完全一致。
2. **首条 clip 从 rest 姿势 crossfade（次因，约 4 帧中间态）**
   自定义 clip-player 用 per-bone slerp 做交叉淡入：首条 idle clip 的 `fromBones` 是
   `appliedPose`（初始化为 rest quats），且 manifest `fadeInSec=0.15` → 前几帧是
   **rest T-pose ↔ idle 的插值**，看起来「既不像 T 也不像 A」。这与 three.js `AnimationMixer`
   的 `PropertyMixer` 在 `cumulativeWeight < 1` 时按 `1-weight` 混回 original（绑定 rest）的
   引擎级机制等价（见 §5 来源）。

## 3. 修复（4 点，最小改动）

| # | 文件 | 改动 |
|---|---|---|
| 1 | `vrm/pet-scene-vrm.ts` | **可见性唯一 owner** `syncModelVisibility()`：`visible = petVisible && placed && startupPoseApplied`；从 `applyModelTransform()` 删除 `root.visible = petVisible`（根因 1）。`setPetVisible`/摆放/门控解除/失败降级全部走该函数。 |
| 2 | `vrm/pet-scene-vrm.ts` | 门控判定改为「**clip 姿势完整写入**」而不是「驱动存在」：`step()` 在 `poseDriver.update()` 后用 `getDebugSnapshot()` 判定 `pose !== 'rest' && poseWeight ≈ 1` 才显示（根因 2 的中间态也一并挡掉）；首帧通常一次 update 即满足。 |
| 3 | `vrm/clip-player.ts` | **首条 clip 直接吸附**：`poseEverApplied=false` 时 `beginClip` 的 fadeSec 强制 0（首发满权重写姿势）；`applyFrame` 写骨后置位。后续切换仍走 crossfade，且始终从「当前已应用姿势快照」起混（永不从 rest 起混）。 |
| 4 | `vrm/pet-scene-vrm.ts` | 兜底：①动画更新/驱动创建失败 → 立即解除门控显示静态 rest（不隐身）；②驱动存在但 2.5s 仍未完整应用（clip 数据缺失/降级/无动画输入）→ 超时显示静态 rest 并 warn（正常路径 ~1 帧即满足，不会触发）。 |
| 5 | `renderer/src/main.ts` | 配套语义修正：`debug.ready` 等到首帧姿势应用/模型显示后再置 true（最多等 2 rAF / 500ms 兜底），保证「ready ⇒ 可见宠物已就绪」，dev-capture 在 ready 后立即截图不会截到隐藏模型。 |

判定逻辑抽成纯函数 `vrm/startup-pose.ts`（`computeModelVisible` / `isStartupPoseApplied` /
`startupPoseFallbackDue`），单测 `tests/vrm-startup-pose.test.ts`；clip-player 首帧吸附用例在
`tests/vrm-clip-player.test.ts`。

## 4. 验证与回滚

- 实机逐帧（最终 freeze 版）：`node scripts/vrm/capture-startup.mjs --out tests/tmp/startup-pose/after-final --frames 150 --max-ms 8000 --width 512`
  → `wideFrames=0`、首个可见帧 aspect 0.5248（idle）、verdict `no-flash-detected`；
  修复前基线 `before/` 同口径复现（3 宽帧 / 69ms / aspect 0.8611）；`after/`、`after-rerun/` 两次复验同为 0 宽帧。
- `pnpm typecheck`：0 error（node + web）。
- `pnpm test`：**109 files / 1871 passed / 14 skipped**（修复前基线 108 files / 1860 passed；
  新增 `vrm-startup-pose.test.ts` 10 条 + clip-player 首帧吸附 1 条）。无回归。
- 回归时的回滚粒度：本修复可整体回滚（上表 5 个文件）；其中 1+2 必须成对回滚（只回滚 1 会
  漏掉中间态，只回滚 2 会重新露出纯 rest T-pose），3 可独立保留（首帧吸附本身无副作用）。
- 旧验收口径的教训：`docs/wave2-acceptance.md` §3.6 曾以「启动后首 3 帧 debug snapshot 均为
  `hsr-idle`」作为无闪现证据，但 snapshot 在 `debug.ready` 后才读取，**覆盖不到显示前的
  rest 帧**；本次改为逐呈现帧捕获 + bbox 宽高比判定。

## 5. 外部来源（web 调研）

- VRM 1.0 规范 T-pose：<https://github.com/vrm-c/vrm-specification/blob/master/specification/VRMC_vrm-1.0/tpose.md>
  ——VRM 的 authored rest pose 规定为 T-pose（所以「不写骨」= 渲染 T-pose）。
- three-vrm `VRMHumanoid`：<https://pixiv.github.io/three-vrm/docs/classes/three-vrm.VRMHumanoid.html>
  ——normalized 骨姿势是相对 rest 的局部量；`update()` 才拷到 raw 骨；`resetNormalizedPose` 回 T。
- three-vrm `VRMCore.update()`：<https://github.com/pixiv/three-vrm/blob/dev/packages/three-vrm-core/src/VRMCore.ts>
  ——确认「先写 normalized 骨 → humanoid.update() → 渲染」的帧内顺序。
- three.js r171 `PropertyMixer`：<https://github.com/mrdoob/three.js/blob/r171/src/animation/PropertyMixer.js>
  ——`weight<1` 时用 original（绑定 rest）补足权重：淡入=从 T-pose 混出来（根因 2 的引擎级证据）。
- three.js 论坛「T-pose between animation transitions」：<https://discourse.threejs.org/t/t-pose-between-animation-transitions/68541>
  ——社区复现「切换时从 T-pose 淡出」，修法=先处理旧 action 再 fadeIn 新 action。
- three.js 论坛「Animation t-poses on switching clips」：<https://discourse.threejs.org/t/animation-t-poses-on-switching-animation-clips/46494>
  ——`clampWhenFinished` 保留末帧姿势而非回 rest。
- Electron 窗口优雅显示：<https://www.electronjs.org/docs/latest/api/browser-window#showing-the-window-gracefully>
  ——`ready-to-show` 只保证首绘；若需「首帧已是正确姿势」须绑定 renderer 的 poseReady 信号（本修复用透明窗口 + 模型级门控达成，无需额外隐藏窗口）。
- 真实 three-vrm 部署卡 T-pose 案例：<https://huggingface.co/spaces/WolfDavid/japanese-learning-avatar/blob/main/RESUME.md>
  ——根因「没有代码在渲染前应用 idle 姿势」；固定 sleep 不可靠，须以姿势就绪为准。
