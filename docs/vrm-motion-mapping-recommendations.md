# VRM 多余动作映射推荐（只做建议，本轮不接线）

> 状态：**2026-11-09**。本文对 `assets/motions/app-catalog.json`（43 条）/ `app-manifest.json`
> （29 条）里**尚未绑定到任何状态**的动作给出接线建议。
>
> **本轮明确不实现**：不修改 app-manifest / app-catalog、不改 `clip-player.ts`/行为层代码；
> 下列建议需要 Lead / B1（行为状态）、B2（座位/窗口锚点）、B7（DSH 事件）先定义状态或事件后
> 才能接线（接线方式参考 V7 的 `MOOD_CLIP_ALIASES`，见 `scripts/vrm/motion/README.md`）。
> 优先级 / 间隔 / 淡入均为**建议值**（可调），不是现有行为。

## 0. 现状与口径

- 已绑定状态：`idle` / `walk` / `sit` / `drag` / `pat` / `sleep` + V7 新增
  `dshBusy`（hsr commonIdle）/ `dshDone`（mate happy）/ `dshError`（hsr hitL）。
- 未绑定动作共 16 条 + 4 条「窗沿躺」保留动作：
  - mate 8 条：`hideLeft` / `hideOnce` / `introStart` / `introLoop` / `introEnd` / `pose1` / `pose2` / `pose3`；
  - hsr 8 条：`breaked` / `skill01` / `skill02` / `skill03` / `mazeSkill` / `passiveSkill` / `stun` / `revive`；
  - 窗沿躺 4 条：`sitWindow` / `windowLay8` / `windowLay9` / `windowLay10`（目前在 app-manifest 里
    以 -10…-13 保留，仅备将来特殊动作；不参与待机轮换）。
- 接线时的通用口径（V7 已实现能力的复用）：
  - **一次性展示动作**（`loop=false`）→ 事件驱动：`clipPlayer.playClipById(catalogId)`；若需要
    mood 驱动，可用 app-manifest 的 catalog→mood 别名（同 `MOOD_CLIP_ALIASES`），但新 mood 属于
    `PetMood` 契约变更，需 Lead 评审。
  - **循环展示动作**（`loop=true`）→ 作为某 mood 的低优先级变体（app-manifest 别名 priority
    负数但仍 **≥ -9**，否则会被 player 的变体池过滤掉）；变体间隔/淡入由
    `VARIANT_SWITCH_CONFIG`（V7）按槽位控制。
  - **pose grounding（V5）**：数据**未标注** `grounding` 的 clip 会被「最低骨贴地」兜底；
    hsr 显式 `grounding:'none'` 的 clip 不兜底。躺/跪类动作若接入状态，需要动作本身适配地面或
    改数据标注，否则会浮空/穿地。
  - **站立类 vs 非站立类**：本文档中 skill*/stun/revive 是站立表演，可直接用；breaked/hide/
    windowLay 是非站立或需要特殊锚点，风险更高。

## 1. 推荐总表

> `priority` 为「若进入 app-manifest 变体池」的建议值（同 mood 内比较）；`间隔/淡入` 指作为
> 循环变体时的轮换间隔与 crossfade。一次性动作没有轮换，只列触发方式与淡入。

### 1.1 入场系列（intro*）

| catalog id | 时长/loop | 建议状态系列 | 接线方式 | 建议 priority | 间隔 | 淡入 | 风险/依赖 |
|---|---|---|---|---|---|---|---|
| `mate-introStart` | 2.0s / 非循环 | 入场序列第 1 段（应用启动 / DSH 会话开始） | 事件 `intro` 播放 → 结束后接 introLoop | — | — | 0.3s | 需要「启动/会话开始」事件（B7 或 Lead main 接线）；模型刚加载时首帧可能被贴图/材质就绪延迟吃掉 |
| `mate-introLoop` | 13.33s / 循环 | 入场序列第 2 段（等待玩家/空闲展示） | 循环 N 秒（建议 5–8s 或直到首次交互） | — | — | 0.3–0.5s | 需要序列编排（播放队列）能力；当前 `playClipById` 只支持单条手动 clip，序列需要 animator/B1 配合 |
| `mate-introEnd` | 1.53s / 非循环 | 入场序列收尾（回到 idle） | 事件驱动，接回 idle | — | — | 0.3s | 同上；序列中途被打断（拖拽/摸头）需要 cancel 逻辑 |

### 1.2 idle 稀有变体（pose*）

| catalog id | 时长/loop | 建议状态系列 | 接线方式 | 建议 priority | 间隔 | 淡入 | 风险/依赖 |
|---|---|---|---|---|---|---|---|
| `mate-pose1` | 6.8s / 循环 | idle 稀有展示动作 | app-manifest alias → mood `idle` | -7 | 4–8 分钟一次（稀有） | 0.8–1.0s | **V7 变体池是均匀随机**：低 priority 只作准入、不会更稀有；要真稀有需开 `weightedByPriority` 或「稀有变体池」机制（需 Lead 定方案） |
| `mate-pose2` | 6.8s / 循环 | 同上 | 同上 | -8 | 同上 | 0.8–1.0s | 同上 |
| `mate-pose3` | 5.0s / 循环 | 同上 | 同上 | -8 | 同上 | 0.8–1.0s | 同上 |

### 1.3 DSH 完成庆祝变体（skill*/mazeSkill/passiveSkill）

| catalog id | 时长/loop | 建议状态系列 | 接线方式 | 建议 priority | 触发 | 淡入 | 风险/依赖 |
|---|---|---|---|---|---|---|---|
| `hsr-skill01` | 2.2s / 非循环 | `dshDone` 庆祝变体（首选补充） | dshDone mood 变体 or 事件按概率挑一条 | 0 | DSH 任务完成事件（B7） | 0.2–0.3s | 与现有 `mate-happy` 风格不同（战斗技能 vs 开心）；建议按事件强度/概率选，不替换默认 |
| `hsr-skill02` | 2.0s / 非循环 | 同上 | 同上 | -1 | 同上 | 0.2–0.3s | 同上 |
| `hsr-mazeSkill` | 2.97s / 非循环 | 同上 | 同上 | -2 | 同上 | 0.2–0.3s | 同上 |
| `hsr-passiveSkill` | 3.87s / 非循环 | 同上 | 同上 | -3 | 同上 | 0.2–0.3s | 同上 |
| `hsr-skill03` | 7.97s / 非循环 | `dshDone` 长庆祝（低频） | 事件（仅当反应时长足够时） | -4 | 大任务完成 | 0.3s | 片长 8s，B7 反应时长通常更短 → 会被中途切回 idle；且是终结技动作，语义偏「战斗」 |

### 1.4 出错/恢复（stun/breaked/revive）

| catalog id | 时长/loop | 建议状态系列 | 接线方式 | 建议 priority | 触发/间隔 | 淡入 | 风险/依赖 |
|---|---|---|---|---|---|---|---|
| `hsr-stun` | 1.8s / 非循环 | `dshError` 变体（与现有 hitL 竞争） | dshError 变体（随机）或事件 | 0 | DSH 出错事件 | 0.15–0.2s | 与 hitL 语义相近，二选一随机；两者都是站立受击，grounding 未标注 none → 不吸地，基本 OK |
| `hsr-revive` | 1.5s / 非循环 | 出错后「恢复」一次性表演 | 事件 `recover`（需新增）/ dshError 结束回 idle 前插播 | — | DSH 错误消除/重连成功 | 0.2s | 需要新事件或 B1 在 dshError→idle 过渡时触发；Lead 需定状态机钩子 |
| `hsr-breaked` | 2.67s / 循环 | 长时间 `dshError` 的循环姿态（破韧/虚弱） | dshError 持续 >2s 时循环；短错误仍用 hitL/stun | -1 | 作为 dshError 循环备选 | 0.3–0.5s | 数据 `grounding:'none'` 且是跪趴姿势 → 若直接播会**悬空**；接入前需重标 grounding 或加座位/地面锚点 |

### 1.5 躲藏 / 捣乱（hide*）

| catalog id | 时长/loop | 建议状态系列 | 接线方式 | 建议 priority | 间隔 | 淡入 | 风险/依赖 |
|---|---|---|---|---|---|---|---|
| `mate-hideLeft` | 8.0s / 循环 | 新状态 `hide`（躲避/害羞/捣乱） | 需要 B1 新增状态（自主 mischief 或 DSH 空闲时）；catalog id 手动播放 | — | 状态持续期循环 | 0.3–0.5s | 需要行为层新状态 + 隐藏期间的 hover/气泡/命中逻辑（V7）；「左侧躲」无右向对应动作（源镜像不可用），朝向处理需 Lead 定 |
| `mate-hideOnce` | 13.98s / 非循环 | `hide` 进入/退出一次性动画 | 事件驱动（躲起来/被找到） | — | — | 0.3s | 同上；13.98s 较长，需要可打断逻辑（拖拽/点击） |

### 1.6 窗沿躺（windowLay*/sitWindow，保留系列）

| catalog id | 时长/loop | 建议状态系列 | 接线方式 | 建议 priority | 间隔 | 淡入 | 风险/依赖 |
|---|---|---|---|---|---|---|---|
| `mate-sitWindow` | 19.96s / 循环 | 「窗沿躺」新状态（坐在窗口上沿并躺下） | 需要 **B2 座位/窗口锚点** 后由 B1 新状态驱动；当前 app-manifest -10 仅保留 | 保留 | 状态持续期循环 | 0.8–1.0s | 当前 V5 pose grounding 会把它们吸到地面（错误：应贴窗口上沿）；需要 B2 提供 `seatedAnchor`（legacy 有 `visualOffsetYPx`/`seatedAnchor='hips'` 概念），或在 player 增加 seated-anchor 模式 |
| `mate-windowLay8` | 2.4s / 循环 | 窗沿躺随机变体 | 同上 | 保留 | 8–15s | 0.8–1.0s | 同上 |
| `mate-windowLay9` | 2.05s / 循环 | 窗沿躺随机变体 | 同上 | 保留 | 8–15s | 0.8–1.0s | 同上 |
| `mate-windowLay10` | 3.02s / 循环 | 窗沿躺随机变体 | 同上 | 保留 | 8–15s | 0.8–1.0s | 同上 |

## 2. 需要 Lead 决定的事项

1. **契约**：intro/hide/恢复 是否新增 `PetMood`（`dshBusy/dshDone/dshError` 之外的 mood 属于
   冻结契约变更，需评审）；还是只做「事件一次性播放」（不改 mood 契约、不需要 app-manifest）。
2. **接线形态**：一次性展示动作建议走 `playClipById(catalogId)`（事件层/animator 编排）；
   需要 mood 驱动的循环/变体才加 app-manifest alias（同 V7 dsh 模式，改 `MOOD_CLIP_ALIASES`
   即可，不需要动 player）。
3. **稀有变体**：pose1-3 若要「稀有」而非均匀随机，需要 V7 的 `weightedByPriority`（已实现可
   配置，默认关）或新增「稀有池 / 概率门」机制——建议由 B1 决定（行为层更适合做稀有频率）。
4. **序列编排**：introStart → introLoop → introEnd 需要「播放列表/回调」能力，当前
   `VrmClipPlayer` 只有单条 `playClipById`；建议由 Lead 的 `animator.ts` 或 B1 编排，player 不扩。
5. **座位锚点**：windowLay 系列需要 B2/V7 的窗口上沿座位锚点（吸附到 hitRect 的窗口 top），
   以及 player 的 seated-anchor 竖直偏移模式；在此之前保持 catalog-only、不接线。
6. **数据标注**：`breaked`（跪趴）等非站立动作若接入，需要重新标 `grounding`（或在 app-catalog
   增加 `grounding` 覆盖字段），否则 V5 pose grounding 行为不合适。

## 3. 明确不做（本轮）

- 不修改 `assets/motions/app-manifest.json` / `app-catalog.json`；
- 不修改 `src/renderer/src/vrm/clip-player.ts` 的选片/事件逻辑（只做 V7 随机轮换 + 参数化）；
- 不新增 PetMood/行为层状态、不改 B1/B2/B4/B7；
- 不播放/预览这些多余动作（无实机截图证据；接线前需要 V5/V8 截图验收）。


## 4. 用户 2026-11-09 决策与落地状态

| 动作 | 用户决策 | 落地状态 |
|---|---|---|
| `hsr-stun` | **做长时间 error**（用户认为它倒地不动） | ⚠️ 实机数据复核：**stun 是站立眩晕摆动、不是倒地**；改为 app-manifest 兜底（breaked 不可用时显示） |
| `hsr-breaked` | **出错非循环**（进入 error 的倒地前摇） | ✅ **实际承担长时间 error 姿态**：进入 dshError 播一次（非循环）后 `hold` 停末帧保持倒地 ≈9s（`dshError` 12s，用户要的「倒地不动」由此实现） |
| `hsr-revive` | **只在倒地之后出现**（需要倒地初始姿态） | ✅ 离开 dshError 时一次性播放（其首帧=跪伏，正好接 breaked 末帧起身）→ 回当前 mood |
| `hsr-passiveSkill` | 暂不应用 | ⏸ 保持 catalog，不接线 |
| `hsr-skill03` | 暂不应用 | ⏸ 保持 catalog，不接线 |
| `hsr-skill01` / `hsr-skill02` | 工作过程中不定期触发、不密集 | ✅ **采用「DSH 工作模式（online && running）下随机 30–60s 一次 one-shot」**（首次 10–20s 延迟；拖拽/摸头/菜单/error 时跳过；idle/offline 重置）。决策理由：桥只有 agent/status 变化 + turn/end（turn/end 已有 dshDone 庆祝、频率不可控且会撞车），逐轮触发不可控；随机 30–60s 更接近参考项目 Mate-Engine 的 idle/dance 随机切换节奏 |
| `mate-introStart/Loop/End` | 按推荐的入场系列 | ⏸ 实现完成但**默认关闭**（用户 2026-11-09：启动应直接是待机姿势）；`introSequence.enabled=true` 可开启（introStart 2.1s → introLoop 4.5s → introEnd 1.6s） |
| `mate-pose1/2/3` | 按推荐的 idle 稀有变体 | ✅ 进 app-manifest idle 池（priority -7/-8/-8）+ 稀有权重 0.3（约 3–5 分钟一次） |
| `mate-hideLeft/hideOnce` | （推荐文档列为新 hide 状态） | ⏸ **本轮暂缓**：需要 B1 新增 hide 活动状态 + B4 命中/气泡处理，且 hideLeft 无右向镜像；留 Wave 3 |
| `sitWindow/windowLay8/9/10` | （推荐文档列为窗沿躺系列） | ⏸ **本轮暂缓**：需要 B2 窗口上沿座位锚点 + player seated-anchor 模式（否则 pose grounding 会把躺姿吸到地面）；留 Wave 3 |
