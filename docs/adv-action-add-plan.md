# adv 动作加入「现存动作系列」的添加计划单（v2）

> 状态：**已实现（2026-11-10）**——按 §4 分期落地，最终实现记录与偏差见 §11；用户中途补充要求（保留 idle 定时轮换、保留抛硬币/手机/耳机类、不接缺滑板/苏乐达/切镜类）已并入。
> **v2 修订（2026-11-10）**：首版去重口径错误——把「同功能/同语义」当成「同动作」，把 idle 系列、skill 系列等**动画本身不同**的动作误判为重复。本版改为：**只有动作本身相同才不添加；不同动画（idle 系列、skill 系列、show/社交/移动过渡等）全部纳入添加计划。**
> 用户口径（2026-11-10）：**比照之前 hsr-系列动作的加法；动作一模一样的（如眩晕/倒地）无需再次添加。**
> 关联：`docs/adv-app-integration.md`、`docs/adv-clip-selection.md`、`docs/adv-full-v3-acceptance.md`、`docs/adv-app-manifest-proposal.md`、`docs/vrm-motion-mapping-recommendations.md`、`scripts/vrm/motion/README.md`。
> 数据底稿（本机临时产物，gitignored）：`work/adv-plan/adv-inventory.md`（137 clip 分类/风险/去重）、`work/adv-plan/audit-hsr-wiring.md`（现有动作接线逐层审计 + file:line）。

---

## 0. 一页结论（先回答「加没加」）

| 问题 | 结论 |
|---|---|
| adv-系列动作**已加进现存动作系列了吗？** | **只加了一半**：数据/清单层已加，**行为接线层没加**。 |
| 数据层（catalog / mood 槽位 / 道具规则） | ✅ 已加：137 条 adv clip 全量进 `app-catalog.json`（181 条中 adv 137，任何 adv clip 可 `playClipById`）；6 条进 `app-manifest.json` 槽位（idle 5 + walk 1，走源 manifest `slot` 直映射，**不是**别名）；7 条持枪 clip 进 `watergun-attach.json` 白名单；`build-app-manifest --check` PASS。 |
| 行为层（hsr 之前接的那几类动作编排） | ❌ **零接线**：`dshBusy/dshDone/dshError` 别名全是 hsr/mate；`dshError` 进出场用 `hsr-breaked`/`hsr-revive`；交互事件 `poke/thrown/landed` 用 `hsr-hitL`/`hsr-stun`/`hsr-revive`；DSH 工作小动作用 `hsr-skill01/02`；入场序列用 `mate-intro*`（当前默认关闭）。 |
| **v2 去重结论**（动作本身是否相同） | **不添加 12 条**：① 与现役**同一条动画**的 2 条（`idle2`、`commonIdle`，帧数/时长一致、逐帧姿态平均差 0.4–0.5°）；② 用户口径的**反应类 10 条**（眩晕/受击/倒地/死亡/复活：`behit/die/die-loop/hit-h/hitL/hit-stun/stun/stunLoop/state-stun-recover/revive`）。**其余 125 条都是不同动画 → 全部进入添加计划**（其中 5 条已加，120 条待加）。 |
| 待加清单规模 | **120 条待加** = idle 待机 4（`attackStandby`/`standby2`/`idleShow`/`idleShow2`）+ walk/run 2（`run`/`fastrun`，P8 质量待修）+ locomotion 18 + social 77（80 条中 3 条已在 idle 池）+ skill 19（4 条可直接用 / 4 条待 P9 遮罩 / 11 条 ready·过渡段）；另有 5 条已在池（`idle`/`walk`/`think01`/`worry01`/`scratchHead01`）。 |
| 需要 user 拍板的 | §8 共 8 个决策点（idle 去重/扩池、dshBusy/dshDone 别名、工作小动作技能池、闲时展示·社交机制、反应类是否新增、locomotion 时机）。 |

**一句话**：数据已经全量进 app、adv 动作“能按 id 播”；但“什么时候自动播哪些 adv 动作”这一层（= 现存动作系列的行为编排）目前仍 100% 是 hsr/mate。本计划单照 hsr 的加法，把 adv 里**动作不同**的部分全部接进去；只有数据核对确认是同一条动画的 2 条 + 你点名的反应类 10 条不加。

---

## 1. 现状核对（证据）

「现存动作系列」在本项目分三层，必须分开核对：

| 层 | 载体 | 是什么 | 谁在用 |
|---|---|---|---|
| **数据层** | `assets/motions/app-catalog.json` | 全部动作索引（可按 id `playClipById`） | 事件/调试/道具规则 |
| **槽位层** | `assets/motions/app-manifest.json` | `mood` → 动作候选池（idle/walk/sit/… + dsh*） | B1 行为状态机选片 |
| **行为接线层** | `src/renderer/src/**` + 生成器别名 | 事件/状态过渡/一次性小动作调度 | hsr/mate 动作实际“演出来”的地方 |

### 1.1 数据层（✅ 已完成，2026-11-09 adv v3 全量）

| 产物 | 现状 | 证据 |
|---|---|---|
| adv 动作数据 | 138 个`.max`（含 Tpose 绑定参考；两个下载复本按变体处理）→ **137 条 clip**（humanoid 52 骨、in-place、rawPolicy=spring） | `assets/motions/adv/{manifest,index}.json`、`assets/motions/adv/*.json` |
| clip 校验 | **118 PASS / 19 WARN / 0 FAIL**；19 WARN 归因（P8 run/fastrun 悬空 10、P9 切镜 4、P10 首帧急启 3、alert01 悬空 2） | `docs/adv-full-v3-acceptance.md` §3.2/§6.3；`tests/tmp/adv-full-v3/pipeline/validation-report.json` |
| `app-catalog.json` | **181 条** = mate 30 + hsr 14 + **adv 137 全收**（131 catalog-only + 6 槽位映射） | `assets/motions/app-catalog.json` |
| `app-manifest.json` | **39 条**（mate 26 / hsr 7 / **adv 6**；idle 20 / walk 3 / sit 7 / pat 3 / drag 2 / sleep 1 / dsh 3）；adv 6 条 = idle `idle`(9)/`commonIdle`(6)/`think01`(-7)/`worry01`(-8)/`scratchHead01`(-8) + walk `walk`(5) | `assets/motions/app-manifest.json` |
| 水枪持枪 | 7 条 adv skill 家族的 app catalog id 白名单（`adv-skill01`、`adv-mazeattack01`、`adv-skill01readybs`、`adv-skill01readyloop`、`adv-skill01-ready`、`adv-skill01-ready-loop`、`adv-skill02toskill01`） | `src/renderer/src/vrm/watergun-attach.json`、`prop-config.ts` |
| 生成器 | `build-app-manifest.mjs` 支持 adv 为可选源集；`--check` 幂等 PASS | `scripts/vrm/motion/build-app-manifest.mjs`（`MOOD_CLIP_ALIASES` L136、`PRIORITY_OVERRIDES` L90、`OPTIONAL_SOURCE_SETS` L52） |
| 当前基线（回滚用） | `app-manifest.json` sha256 `8ff9cdee…dd9592`；`app-catalog.json` `dddd90b8…eb395c`；`adv/manifest.json` `98f40b59…e0896` | 本机 2026-11-10 实测 |

> **数字口径提示**：仓库部分旧文档数字已漂移/口径有误，本文以当前产物为准：
> - `docs/adv-full-v3-acceptance.md` §4 写 38/180，当前 **39/181**（差值 = 后加的 `mate-dragFemale`，mate 29→30）；
> - `scripts/vrm/motion/README.md` L162-165 仍写 32/43（旧口径）、idle pose 优先级仍写 -7/-8/-8（实际 -10/-11/-12）；
> - `build-app-manifest.mjs` L86 注释把 `adv-walk` 误写成“HSR 官方”；
> - `docs/adv-full-v3-acceptance.md` §5.1 持枪分类写「held_l 11 / 其余 116」，实际 **held_l 12 / 不持枪 117**（漏 `standby2`）。

### 1.2 行为层（❌ 未接线）——「现存动作系列」实际由 hsr/mate 组成

| 动作通道 | 现役动作 | 代码/配置位置 | adv 现状 |
|---|---|---|---|
| idle mood 变体池 | hsr-idle(10)/hsr-idleShow(8)/hsr-idle2(5)/hsr-idleShow2(4)/hsr-commonIdle(3) + adv 5 条 | `app-manifest.json`（生成） | **✅ 已加 5 条（含 1 条同动画重复，见 §2.2）** |
| walk | adv-walk(5) 主选，mate-walk/-Alt 降到 -10/-11 | 同上 | **✅ 已加 1 条** |
| dshBusy 别名 | `hsr-commonIdle`（loop，prio 0，fade 0.3/0.3） | `build-app-manifest.mjs` L136-147 | ❌ 无 adv |
| dshDone 别名 | `mate-happy`（非循环，prio 0，fade 0.15/0.3） | 同上 L148-158 | ❌ 无 adv |
| dshError 别名（兜底） | `hsr-stun`（loop，prio 0，fade 0.15/0.25） | 同上 L159-169 | ❌ 无 adv（反应类按口径不补） |
| dshError 进场/退场 | `hsr-breaked`（进入·非循环·hold 停末帧）/ `hsr-revive`（离开） | `src/renderer/src/main.ts` L212-219 | ❌ 无 adv（反应类按口径不补） |
| 交互事件反应 | `poke → hsr-hitL`；`thrown → hsr-stun`；`landed → hsr-revive / hsr-hitL` | `src/renderer/src/vrm/clip-player.ts` L230-236（`EVENT_CLIP_IDS`） | ❌ 无 adv（反应类按口径不补） |
| DSH 工作小动作 | `hsr-skill01`/`hsr-skill02`，online && running 时随机 30–60s 一次（首次 10–20s） | `src/renderer/src/reactions/dsh-work-fidget.ts` L39-52；`main.ts` L165/L667-683 | ❌ 无 adv |
| 入场序列 | `mate-introStart/Loop/End`（**当前 `enabled:false`**） | `main.ts` L197-206、L458 | ❌ 无 adv 素材 |
| 水枪持枪 | adv skill 白名单（见 §1.1） | `watergun-attach.json` | **✅ 已加** |
| pat / sit / sleep / drag | mate 动作 | `app-manifest.json` | ❌ adv 无对应动作 |

> 机制补充：`MOOD_CLIP_ALIASES` 共 6 条（3 条 dsh + mate pose1/2/3→idle 三条，已降为 -10/-11/-12）；**adv 别名 0 条**。mood 进出场一次性过渡在 `animator.ts`，`playOneShotClip` 也在 `animator.ts` L199-211（委托 `playClipById`）。

### 1.3 结论

- 若「现存动作系列」指 **app-manifest 的动作池**：adv 已加 **6 条**（idle 5 + walk 1），并全量进 catalog —— **算“加了一部分”**。
- 若指 **hsr 那种“会自己演出来”的行为动作系列**：adv 接入 **0 条** —— 本计划单的主体。
- 因此按用户要求出本添加计划单：**不同动画全部加**，只剔除「动作一模一样」的（§2.2）。

---

## 2. 去重口径（v2 修正）：只按“动作本身是否相同”判定

### 2.1 判定方法

不看功能/语义，直接比对**动作数据**：

1. 帧数/时长是否一致（同一段动画重导出 → 帧数、时长相同）；
2. 逐帧姿态差异：对齐首帧后（去除每骨常量偏移），比较各帧各骨旋转角（阈值：**平均差 < 1° 判同一条动画**）；
3. 用户点名的「反应类」按用户口径整组处理（不重复添加）。

### 2.2 不添加清单（12 条）

| 组 | clip | 条数 | 判定依据 |
|---|---|---|---|
| **A 同一条动画** | `idle2`、`commonIdle` | 2 | 与现役 `hsr-idle2`/`hsr-commonIdle` **帧数·时长完全一致**（60f/2.0s、251f/8.367s），去常量偏差后逐帧姿态平均差 **0.40°/0.48°** → 同一条动画。**`adv-commonIdle` 目前已在 idle 池 → P0-1 清理** |
| **B 反应类（用户口径）** | `behit`、`die`、`die-loop`、`hit-h`、`hitL`、`hit-stun`、`stun`、`stunLoop`、`state-stun-recover`、`revive` | 10 | 眩晕/受击/倒地/死亡/复活：现役 hsr 动作已承担（用户口径：如眩晕/倒地无需再次添加）。其中 `hitL`/`stun`/`revive` 与现役同名 clip 帧数·时长一致（同动作的不同重定向）；`die`/`die-loop` 与现役 `breaked` 不是同一条动画，但同属「倒地」类，按用户口径一并归入不添加（若要把 adv 的新倒地/受击动画也加进来，见决策 D6-B） |

> 其余 **125 条** = 不同动画（idle 系列的非重复项、skill 系列全部、social 80、locomotion 18、walk/run 等）→ 全部进入 §4 添加计划。

### 2.3 数据核对表（idle/skill/show 关键同名对）

| 现役 hsr | adv | 帧数（hsr/adv） | 时长（hsr/adv） | 去常量后逐帧平均差 | 结论 |
|---|---|---|---|---|---|
| `idle2` | `idle2` | 60 / 60 | 2.0s / 2.0s | **0.40°** | 同一条动画 → 不添加 |
| `commonIdle` | `commonIdle` | 251 / 251 | 8.37s / 8.37s | **0.48°** | 同一条动画 → 不添加（P0-1 清理） |
| `idle` | `idle` | 60 / 84 | 2.0s / 2.8s | 0.51°（前 60 帧） | 不同动画（adv 为更长版本）→ 保留（已加） |
| `idleShow` | `idleShow` | 310 / 167 | 10.33s / 5.53s | 22.85° | **不同动画** → 加 |
| `idleShow2` | `idleShow2` | 357 / 167 | 11.90s / 5.53s | 11.97° | **不同动画** → 加 |
| `skill01` | `skill01` | 67 / 98 | 2.20s / 3.23s | 33.55° | **不同动画（4.5 版重制）** → 加 |
| `skill02` | `skill02` | 61 / 102 | 2.00s / 3.37s | 30.55° | 不同动画 → 加 |
| `skill03` | `skill03` | 240 / 181 | 7.97s / 6.00s | 36.60° | 不同动画 → 加（P9 切镜，质量另处理） |
| `mazeSkill` | `mazeSkill` | 90 / 131 | 2.97s / 4.33s | 28.41° | 不同动画 → 加 |

> 结论：**idle 系列、skill 系列的动作与现役 hsr 版本都是不同动画**（帧数、时长、曲线都不同），首版把它们当重复是错的；本版全部纳入添加。

---

## 3. hsr 现役动作 → adv 对应动作 判定总表（v2）

| # | hsr 现役动作（用途/参数） | adv 对应动作 | 判定 | 计划 |
|---|---|---|---|---|
| 1 | `hsr-idle`(idle 10，主待机 2.0s) | `adv-idle`(idle 9，2.8s) | 不同动画（更长版本） | 已加为变体；主待机保持 hsr-idle（换主待机另议） |
| 2 | `hsr-idle2`(5)、`hsr-commonIdle`(3) | `adv-idle2`、`adv-commonIdle` | **同一条动画** | **不添加**；`adv-commonIdle` 已在池 → P0-1 清理 |
| 3 | `hsr-idleShow`(8)、`hsr-idleShow2`(4) | `adv-idleShow`、`adv-idleShow2`（一次性 5.53s） | **不同动画** | P3-1 闲时展示候选 |
| 4 | （hsr 无对应） | `adv-attackStandby`、`adv-standby2` | 不同动画（战斗待机/60fps 变体） | `attackStandby` → P1-1 idle 变体；`standby2`（一次性）→ P3-1 展示候选 |
| 5 | `hsr-hitL`（poke 事件 + landed 兜底） | `adv-hitL`/`adv-hit-h`/`adv-behit` | 反应类（B 组） | **不添加**（catalog 可回放；要加新版=决策 D6） |
| 6 | `hsr-stun`（thrown 事件 + dshError 兜底） | `adv-stun`/`adv-stunLoop`/`adv-hit-stun`/`adv-state-stun-recover` | 反应类（B 组） | **不添加** |
| 7 | `hsr-breaked`（dshError 进场·hold 末帧） | `adv-die`/`adv-die-loop` | 反应类（B 组，与现役不同动画但同类） | **不添加**（按口径；D6-B 可选） |
| 8 | `hsr-revive`（dshError 退场 + landed） | `adv-revive` | 反应类（B 组） | **不添加** |
| 9 | `hsr-commonIdle`（dshBusy 别名，loop 8.37s） | `adv-think01`（loop 2.8s，PASS/feet） | 不同动画 | **P1-2 加 dshBusy 第二候选**（决策 D1） |
| 10 | `mate-happy`（dshDone 别名，非循环 6.55s） | `adv-snap01loop`（loop 3.43s，PASS/feet，打响指） | 不同动画 | **P1-3 加 dshDone 候选**（决策 D2） |
| 11 | `hsr-skill01`/`hsr-skill02`（DSH 工作小动作） | `adv-skill01`/`skill02`/`skill03`/`mazeSkill`/`skill04`/`skill41`/`skill04-2`/`mazeattack01` | **全部不同动画** | **P2-1 技能池加入**（4 条 clean；P9 4 条待遮罩，决策 D4） |
| 12 | `hsr-skill03`/`mazeSkill`/`passiveSkill`（catalog-only 备选） | `adv-skill04`/`skill41` 等新招式 | 不同动画 | 与 P2-1 一并评估（长/切镜的质量另处理） |
| 13 | `mate-introStart/Loop/End`（入场，当前禁用） | adv 无 intro 动作 | — | 无候选 |
| 14 | `mate-happy/laughing/shyPoint`（pat） | adv 无摸头反应 | — | 无候选 |
| 15 | mate sit/sleep/drag | adv 无对应动作 | — | 无候选 |
| 16 | （hsr 无） | **adv 社交 80 条（26 个 base id）** | 不同动画（新内容） | **P3-1 新机制（闲时社交/展示小动作）** |
| 17 | （hsr 无） | **adv locomotion 过渡 18 条 + run/fastrun 3 条** | 不同动画（新内容） | **P4-1 暂缓**（需 B1/B2 状态；P8 数据问题先修） |

---

## 4. 添加计划单（分期）

> 每个 Phase 独立可落地/可回滚。P0/P1 纯数据、P2 小改 src、P3 新机制、P4 暂缓。

### Phase 0 — 去重清理（数据层）

#### P0-1 把 `adv-commonIdle` 移出 idle 槽位（推荐，决策 D0）

- **问题**：`adv-commonIdle` 与 `hsr-commonIdle` 是**同一条动画**（帧数/时长一致、逐帧平均差 0.48°），现在 idle 池里同一动作被算两个变体（adv 6 / hsr 3）。
- **改法**：`scripts/vrm/motion/clips.adv-all.b.json` 里 `commonIdle` 的 `slot:"idle"` → `null`（priority 不用动；无槽位不进 app-manifest）；按 §6.2 重建两条清单。
- **影响**：app-manifest **39 → 38**；idle 活跃池 10 → 9；catalog 不变。
- **验收**：idle 池不再出现同一动作两次；其余轮换无缺失。
- **风险**：低（纯数据，可回滚）。

### Phase 1 — 数据层：idle 池 / dsh 别名（只改 registry/生成器，不动 `src/**`）

#### P1-1 idle 池加入 `adv-attackStandby`（决策 D3）

- **源 clip**：`adv-attackStandby`（3.37s，loop=true，feet，PASS；战斗待机，与现役 hsr idle 都不同动画）。
- **改法**：registry 里 `attackStandby` 的 `slot:"idle"`、`priority:3`（profile B 曾降级为 null，这里恢复）；重建 manifest。
- **注意**：源数据左手持枪（held_l，runtime 只挂右手 → 枪隐藏，观感需实机确认）。
- **影响**：app-manifest 38 → 39；idle 活跃池 9 → 10。

#### P1-2 dshBusy 增加 adv 候选（推荐，决策 D1）

- **目标**：DSH 忙碌（5s 窗口）时在 `hsr-commonIdle` 与 adv `think01` 之间随机，更贴「忙碌思考」语义。
- **改法**：`scripts/vrm/motion/build-app-manifest.mjs` 的 `MOOD_CLIP_ALIASES` 追加（app id = `adv-think01-dshBusy`）：

  ```js
  { set: 'adv', clip: 'think01', mood: 'dshBusy', loop: true, priority: 0,
    timeScale: 1, fadeInSec: 0.3, fadeOutSec: 0.3,
    note: 'DSH 任务进行中：adv Think01 思考待机循环（与 hsr-commonIdle 同分随机）' }
  ```

- **前置条件**（生成器校验）：源 clip 已在 `assets/motions/adv/manifest.json` 登记、`adv/think01.json` 存在、mood ∈ 13 个 `CLIP_SLOT_MOODS`。
- **行为**：dshBusy 两条同 priority 0 → `pickInitialEntry` 同分等概率随机（`clip-player.ts` L1030-1040）；busy 5s 内不会轮换。
- **影响**：app-manifest +1（40）。

#### P1-3 dshDone 增加 adv 候选（推荐，决策 D2）

- **源 clip**：`adv-snap01loop`（3.43s，loop=true，feet，PASS，打响指；不同动画）。备选 `adv-snap01as`（3.3s，非循环，AS 起手段，语义待预览确认）。
- **改法**：`MOOD_CLIP_ALIASES` 追加（app id = `adv-snap01loop-dshDone`）：

  ```js
  { set: 'adv', clip: 'snap01loop', mood: 'dshDone', loop: true, priority: 0,
    timeScale: 1, fadeInSec: 0.15, fadeOutSec: 0.3,
    note: 'DSH 任务完成：adv Snap01 打响指庆祝（2.5s mood 窗口截断，同 mate-happy 先例）' }
  ```

- **行为**：dshDone 两条同 priority 0 → 每次完成随机二选一；dshDone 只持续 2.5s（`dsh.ts` `DSH_REACTION_DURATIONS`），clip 被截断——与现有 `mate-happy` 6.55s 被截断一致。
- **影响**：app-manifest +1（41）。

#### P1-4 idle 稀有池加入 adv 社交循环（不同动画，决策 D3）

- **候选**（loop=true + feet + PASS，均与现役不同动画，来自 26 条循环合格池）：`adv-shrug01`(2.13s)、`adv-akimbo01loop`(2.83s)、备选 `adv-holdarm01loop`(2.73s)/`adv-covermouth01loop`(2.67s)。
- **改法**：registry 对应条目 `slot:"idle"`、`priority:-7/-8`（profile B 曾降级，这里恢复）；重建 manifest。
- **权重**：稀有变体从 3 → 6 条时，把 `rareVariant.weight` 从 0.3 调到 ≈**0.15**（`main.ts` `createVrmClipPlayer` tuning，`clip-player.ts` L172-177/L1117），保持稀有占比 ≈11%（否则会升到 ≈20%，约 1–2 分钟一次，太频繁）。
- **影响**：idle 活跃池 10 → 13；app-manifest +3（44）。

### Phase 2 — 行为接线：DSH 工作小动作技能池（小改 `src/**`）

#### P2-1 skill 系列加入工作小动作候选池（推荐，决策 D4）

- **现状**：`DshWorkFidget` 默认候选 `['hsr-skill01','hsr-skill02']`（`dsh-work-fidget.ts` L39-52），online && running 时随机 30–60s 播一次（首次 10–20s），`main.ts` L165 构造 + L667-683 每帧 update + `playOneShotClip`。
- **adv skill 系列 = 全部不同动画**（见 §2.3，帧数/曲线都与 hsr 版不同），按「不同动画 → 加」纳入：
  - **第一批（PASS 且无切镜问题）**：`adv-skill01`(3.23s，持枪)、`adv-mazeSkill`(4.33s)、`adv-skill04`(5.53s，欢愉技，新招式)、`adv-mazeattack01`(5s，持枪)；
  - **第二批（P9 切镜帧，79–145° 单帧跳变）**：`adv-skill02`/`adv-skill03`/`adv-skill41`/`adv-skill04-2` —— 需要 cut 帧 0.1–0.2s 交叉淡入遮罩后再接（属独立小课题），本轮先 catalog-only；
  - **ready/过渡段 11 条**（skill01readybs/readyloop/ready/ready-loop/toskill02、skill02*、skill03-ready、skill04-ready*）：单独播放不成立，留给未来「技能序列器」（AS→Loop→BS 同款思路）。
- **改法**：`main.ts` 构造处传候选（不改模块默认常量）：

  ```ts
  const dshWorkFidget = new DshWorkFidget({
    clipIds: ['hsr-skill01', 'hsr-skill02', 'adv-skill01', 'adv-mazeSkill', 'adv-skill04', 'adv-mazeattack01']
  })
  ```

- **水枪**：`adv-skill01`/`adv-mazeattack01` 在 `holdClipIds` 白名单 → 播时水枪显示；`adv-mazeSkill`/`adv-skill04` 不持枪。**验收必须覆盖**显隐。
- **参数**：间隔/首次延迟不变；clip 2–5.5s 级，远小于 30–60s 间隔。
- **测试**：`main.ts` 只传参 → 默认常量断言不变；补一条 6 候选自定义用例。
- **风险**：中（“工作时偶尔举水枪”观感需实机确认；不接受可退回 hsr 或去掉持枪两条）。

#### P2-2 反应类事件/过渡：不做（见 §5-B）

### Phase 3 — 新机制：闲时展示 / 社交小动作（中改 `src/**`，新模块）

> adv 独有 80 条社交动作 + 4 条一次性 idle 展示（idleShow/idleShow2/standby2 等）没有现成钩子；照 `DshWorkFidget`（hsr 技能小动作的加法）新建同构调度器。

#### P3-1 `IdleOneShotFidget`（推荐，决策 D5）

- **模块**：`src/renderer/src/reactions/idle-one-shot-fidget.ts`（纯逻辑，不 import DOM/three/Electron，仿 `dsh-work-fidget.ts`）。
- **触发条件**：VRM 就绪、mood=`idle`、非拖拽/摸头/菜单/DSH 反应、无 intro/一次性 clip 正在播、未睡眠/悬空。
- **节奏**：每 **2–5 分钟**随机一次（首次 40–90s，可配）；`playOneShotClip(id, { loop:false, fadeSec:0.2–0.3 })`（`animator.ts` L199-211），播完回 idle；blocked 不重置计时。
- **第一批候选（完整单段/一次性，PASS/feet，均不同动画）**：
  - 展示类：`adv-idleShow`(5.53s)、`adv-idleShow2`(5.53s)、`adv-standby2`(2.0s)；
  - 社交类：`adv-talk01`(3.37s)、`adv-talk02`(3.5s)、`adv-bye01`(3.23s)。
- **第二批候选（loop 段可单播，需先预览）**：`adv-shrug01`、`adv-akimbo01loop`/`akimbo02loop`/`akimbo01handloop`、`adv-holdarm01loop`/`holdarm01handloop`、`adv-covermouth01loop`、`adv-worry02loop`、`adv-think01handloop`、`adv-snap01loop`、`adv-puthand01loop`、`adv-backward01loop`、`adv-holdhead01loop`、`adv-strikechest01loop`。
- **第三批（AS→Loop→BS 三段式序列，50 个过渡段）**：单播 AS/BS 会停在半姿态；需要序列器（可参考 `animator.ts` 的 `introSequence.steps` 扩成通用播放序列），属独立设计，本轮只做单段/loop 段。
- **候选排除（不是重复，是缺道具/质量）**：`build02*`/`forerake02*`/`useprop01/02`/`useheadphone01*`（无道具）、`watchphone01*`/`lookatphone*`/`lookAtPhone`（手机不可见）、`injured01*`（受伤语义与 dshError 冲突）、`alert01as/loop`（悬空 0.088m）。
- **接线**：`main.ts` 每帧调用；blocked 复用同一批条件；与 `DshWorkFidget` 互斥（同一帧只允许一个 one-shot，优先 DSH 工作小动作）。
- **测试**：新增 `tests/idle-one-shot-fidget.test.ts`（间隔、blocked、非 idle、空候选、时钟异常）。
- **验收**：实机 10 分钟观察（2–5 分钟一次；不打断拖拽/摸头/DSH 反应；idle 展示类播完回位自然）。
- **风险**：中（待机观感频率；需 user 确认候选/频率/是否启用在 config）。

### Phase 4 — 暂缓：locomotion 过渡（依赖 B1/B2 状态）

#### P4-1 移动过渡/转向（决策 D7）

- **内容（不同动画）**：`adv-walkstop-l/r`(2)、`turn-45/90/180-l/r`(6)、`run-bs-l/r`(2) —— 10 条可用；`run`/`fastrun`/`runstop-*`/`run-turn*`(10 条) 有 P8 竖直轴悬空（0.25–0.63m）需先修数据。
- **为什么暂缓**：当前 `walk` 只是 mood 循环，行为层没有「转向/停止」事件可挂；要接需 B1/B2 移动状态或 animator 钩子（Wave 3+ 设计）。
- **本轮结论**：保持 catalog-only，等状态机/数据修复后再接。

### 4.5 质量待修（不是重复，另立事项）

| 类 | clip | 数量 | 问题 | 处理 |
|---|---|---|---|---|
| P8 竖直轴 | `run`、`fastrun`、`runstop-l/r`、`run-turnleft/right-l/r`、`fastrunstop-r`、`fastrun-turnright-l` | 10 | 悬空 0.25–0.63m（WARN） | 修采样器/retarget 竖直分解后再进 locomotion（P4） |
| P9 切镜 | `skill02`、`skill03`、`skill41`、`skill04-2` | 4 | 单帧 79–145° pose cut | 加 cut 帧淡入遮罩后再进技能池（P2 第二批） |
| 道具缺失 | `build02*`、`forerake02*`、`useprop01/02`、`useheadphone01*`、`watchphone01*`、`lookatphone*`、`lookAtPhone` | 17 | 手上无手机/耳机/沙堡等 | 道具到位再接（P3 排除项） |
| 轻微悬空 | `alert01as`、`alert01loop` | 2 | 悬空 0.088m | 预览确认或修 grounding 标注 |
| 左手持枪 | `attackStandby`、`standby2`、`idle2` 等 | 12 | 源里枪在左手，runtime 只挂右手 → 空手播放 | 非 skill 一律隐藏（现规则）；观感需实机确认 |

---

## 5. 明确不添加（12 条，v2）

| # | 组 | clip | 条数 | 原因 |
|---|---|---|---|---|
| A | 同一条动画 | `idle2`、`commonIdle` | 2 | 与现役 `hsr-idle2`/`hsr-commonIdle` 帧数·时长一致、逐帧平均差 0.40°/0.48° → 同一条动画；`adv-commonIdle` 已在 idle 池（P0-1 清理） |
| B | 反应类（用户口径） | `behit`、`die`、`die-loop`、`hit-h`、`hitL`、`hit-stun`、`stun`、`stunLoop`、`state-stun-recover`、`revive` | 10 | 眩晕/受击/倒地/死亡/复活：现役 hsr 动作已承担，按用户口径不重复添加；catalog 保留可 `playClipById` 回放 |

> 其余 125 条均为不同动画，按 §4 分期添加（不是“跳过”）。如果你希望把 B 组里与现役不同动画的 `die`/`die-loop`（倒地）也加进来，见决策 **D6-B**，我把它移到添加清单。

---

## 6. 落地步骤与验收

### 6.1 前置：备份 + 记录基线

```bash
cd /Volumes/4TB外置盘/deepseek-harness/aventurine-pet-vrm
mkdir -p work/adv-action-add-plan/rollback
cp assets/motions/app-manifest.json assets/motions/app-catalog.json \
   assets/motions/adv/manifest.json assets/motions/adv/index.json \
   work/adv-action-add-plan/rollback/
shasum -a 256 assets/motions/app-manifest.json assets/motions/app-catalog.json \
  assets/motions/adv/manifest.json assets/motions/adv/index.json \
  | tee work/adv-action-add-plan/rollback/SHA256SUMS.txt
# 当前基线：app-manifest 8ff9cdee…dd9592 / app-catalog dddd90b8…eb395c
#           adv/manifest 98f40b59…e0896 / adv/index b7add402…0c00fb
```

### 6.2 Phase 0/1 执行命令

```bash
# 0) 动 idle 槽位（P0-1 清理 / P1-1 / P1-4）时：先改 registry，再重建 adv manifest
node scripts/vrm/motion/build-adv-manifest.mjs \
  --dir assets/motions/adv --config scripts/vrm/motion/clips.adv-all.b.json
node scripts/vrm/motion/build-adv-manifest.mjs \
  --dir assets/motions/adv --config scripts/vrm/motion/clips.adv-all.b.json --check

# 1) 重建 app 清单（P1-2/P1-3 只改 MOOD_CLIP_ALIASES 时直接跑这步）
node scripts/vrm/motion/build-app-manifest.mjs

# 2) 幂等校验（必须 PASS；FAIL 说明手改过生成物）
node scripts/vrm/motion/build-app-manifest.mjs --check
```

> 注意：`build-adv-manifest.mjs` 默认 `--config` 是 25 条代表集 `clips.adv.json`，全量必须显式传 `--config scripts/vrm/motion/clips.adv-all.b.json`（踩坑点）。

### 6.3 改动文件清单（实现时）

| 文件 | 改动 | Phase |
|---|---|---|
| `scripts/vrm/motion/clips.adv-all.b.json` | `commonIdle` slot→null；`attackStandby` slot=idle/prio 3；`shrug01`/`akimbo01loop`(+`holdarm01loop`) slot=idle/prio -7/-8 | P0/P1 |
| `scripts/vrm/motion/build-app-manifest.mjs` | `MOOD_CLIP_ALIASES` 追加 adv dshBusy/dshDone 两条 | P1-2/P1-3 |
| `src/renderer/src/main.ts` | ①`new DshWorkFidget({ clipIds: [...] })` ②接线 `IdleOneShotFidget`（含 blocked 互斥）③（可选）`rareVariant.weight` tuning | P1-4/P2-1/P3-1 |
| `src/renderer/src/reactions/idle-one-shot-fidget.ts` | **新增**（仿 `dsh-work-fidget.ts`） | P3-1 |
| `tests/idle-one-shot-fidget.test.ts` | **新增**单测 | P3-1 |
| `src/shared/config.ts`（可选） | 展示/社交小动作开关、间隔、候选配置化 | P3-1（决策 D5） |

### 6.4 测试同步清单（改清单/别名必看）

| 测试文件 | 会失败的断言 | 处理 |
|---|---|---|
| `tests/vrm-clip-registry.test.ts` L665-780 | app-manifest **39** 条、catalog **181** 条、dsh 三条 id/loop/fade（L673-683）、idle 活跃 **10 条**列表（L709-720）、walk 池仅 adv-walk（L751-753） | 按执行范围更新（条数推进见下方“app-manifest 条数推进”注）：P0-1 → 39→38、idle 活跃去掉 `adv-commonIdle`；P1-1 → 39；P1-2/P1-3 → 40/41；P1-4 → 44；dsh 3→5；catalog 不变 181 |
| `tests/adv-app-manifest.test.ts` L302-320 | `stats.moodAliasCount === 6` + 6 条别名 id 精确列表 | P1-2/P1-3 后 → **8** + 别名列表追加两条（**加任何别名必挂**） |
| `tests/dsh-work-fidget.test.ts` L68-92 | 默认 `clipIds=['hsr-skill01','hsr-skill02']` | 只在 `main.ts` 传参 → 默认常量不变；补 6 候选自定义用例 |
| `tests/vrm-animator.test.ts` L135-136/L200-247 | 过渡 clip fixture | 不改过渡 → 不用动 |
| `tests/vrm-hand-prop.test.ts` L88-96/L100-133 | 7 条白名单精确 + 命中矩阵 | 白名单不变；P2-1 验收跑 `node scripts/props/check-watergun-policy.mjs` |
| `tests/adv-app-manifest.test.ts` L220-284 | adv 映射纯函数/priority 直取 | P0/P1 只改 registry 不改生成器规则 → 不用动 |

> app-manifest 条数推进（按范围累加）：当前 **39** → P0-1 **38** → P1-1 **39** → P1-2 **40** → P1-3 **41** → P1-4 **44**（全做）；idle 活跃池 **10 → 9 → 10 → 13**；idle 名义条目 20 → 23。

### 6.5 验收清单

```bash
pnpm typecheck
pnpm vitest run tests/vrm-clip-registry.test.ts tests/adv-app-manifest.test.ts \
  tests/dsh-work-fidget.test.ts tests/vrm-animator.test.ts tests/vrm-hand-prop.test.ts
node scripts/vrm/motion/build-app-manifest.mjs --check
node scripts/props/check-watergun-policy.mjs
PET_MODEL_BACKEND=vrm pnpm smoke
```

- **P0-1**：idle 池不再出现同一动作两次；
- **P1-1/P1-4**：idle 10 分钟截屏/日志，新变体（attackStandby/耸肩/叉腰）出现且不突兀；稀有占比 ≈11%；
- **P1-2**：触发一次 DSH 任务开始，dshBusy 5s 内随机 hsr-commonIdle / adv-think01；
- **P1-3**：完成 5–10 个任务，dshDone 随机 mate-happy / adv-snap01loop，截断可接受；
- **P2-1**：工作 5 分钟出现 3–5 次小动作；adv-skill01/mazeattack01 播时水枪显示、结束隐藏；
- **P3-1**：空闲 10 分钟，展示/社交小动作每 2–5 分钟一次，不打断拖拽/摸头/DSH 反应；
- **回归**：idle 轮换、walk、sit、drag、pat、dshError 倒地/起身链路与现状一致。

### 6.6 回滚

```bash
cp work/adv-action-add-plan/rollback/app-manifest.json assets/motions/app-manifest.json
cp work/adv-action-add-plan/rollback/app-catalog.json assets/motions/app-catalog.json
cp work/adv-action-add-plan/rollback/manifest.json assets/motions/adv/manifest.json
cp work/adv-action-add-plan/rollback/index.json assets/motions/adv/index.json
node scripts/vrm/motion/build-adv-manifest.mjs --dir assets/motions/adv \
  --config scripts/vrm/motion/clips.adv-all.b.json --check
node scripts/vrm/motion/build-app-manifest.mjs --check
# 期望 sha256 回到：8ff9cdee…dd9592 / dddd90b8…eb395c
```

> 生成物（`assets/motions/app-*.json`、`assets/motions/adv/manifest.json`）**不要手改**；回滚以「备份恢复」或「改回源配置+重跑」为准。

---

## 7. 风险

| # | 风险 | 影响 | 处理 |
|---|---|---|---|
| R0 | `adv-commonIdle` 同动画重复 | 同一动作占两个变体权重 | P0-1 清理（纯数据可回滚） |
| R1 | dshBusy 随机二选一 | 观感变化 | 决策 D1；回退=删别名 |
| R2 | dshDone 2.5s 窗口截断 | adv-snap01loop 只播前 2.5s（同 mate-happy 先例） | 可接受；若要完整播需改 `DSH_REACTION_DURATIONS`（B7 改动另评审） |
| R3 | idle 池扩充（attackStandby + 3 稀有） | 稀有频率/观感 | 稀有 weight 0.3→0.15；先实机看 10 分钟 |
| R4 | 工作小动作持枪 | “工作时举水枪”观感 | 决策 D4；可只加不持枪的 adv-mazeSkill/skill04 |
| R5 | 展示/社交小动作打断节奏/竞态 | 与 fidget/pat/dsh 反应冲突 | blocked 互斥 + 单帧只允许一个 one-shot；单测覆盖 |
| R6 | AS/BS 段单播收尾突兀 | 半姿态被 crossfade 拉回 | 第一批只接完整单段/整段 loop；三段式留给序列器（P3 第三批） |
| R7 | P8/P9 clip 混入 | 悬空/切镜瞬移 | §4.5 质量待修；先修再接 |
| R8 | 测试基线写死真实产物 | 每次改清单会红 | §6.4 同步更新（只改期望值，不放宽断言） |
| R9 | 冻结 `PetMood` 契约 | 本计划不新增 mood（复用现有 13 槽位/事件/一次性播放） | 若未来要新 mood 需契约评审 |
| R10 | 私有资产约束 | adv 数据/生成物均 gitignore | 命令只在本机跑；不要提交 `assets/**`、`work/**`、`tests/tmp/**` |
| R11 | 仓库文档数字漂移 | 按旧文档核对会得错误结论 | 以当前产物（39/181）为准，见 §1.1 |

---

## 8. 待 user 拍板的决策点

| # | 问题 | 选项 | 推荐 |
|---|---|---|---|
| D0 | `adv-commonIdle` 与现役同一条动画（已误入 idle 池），清不清理？ | A 清理（移出槽位，catalog 保留）；B 保留现状 | **A**（符合「一模一样不添加」） |
| D1 | dshBusy 加 adv 候选？ | A 保持仅 hsr-commonIdle；B 加 adv-think01（同分随机） | **B** |
| D2 | dshDone 加 adv 候选？ | A 保持 mate-happy；B 加 adv-snap01loop（随机二选一）；C 先拉长 dshDone 2.5s 再加 | **B**（C 属 B7 改动另议） |
| D3 | idle 池怎么扩？ | A 全加（attackStandby + 3 条社交稀有，见 P1-1/P1-4）；B 只加 attackStandby；C 只加稀有；D 都不动 | **A**（skill/idle 系列都不同动画，丰富待机） |
| D4 | 工作小动作技能池怎么加 adv skill？ | A 加 4 条 clean（skill01/mazeSkill/skill04/mazeattack01）；B 再等 P9 4 条加遮罩后一起；C 加全部 19 条 | **A**（P9 4 条第二批，ready/过渡段留序列器） |
| D5 | 是否新增「闲时展示/社交小动作」机制？ | A 做（idleShow×2/standby2 + talk/bye 第一批，2–5 分钟一次）；B 不做；C 只做社交不做展示 | **A**（80 条社交动作只有这里有落点） |
| D6 | 反应类（10 条）确认不添加？其中 `die`/`die-loop` 与现役不是同一条动画 | A 全部不添加（按你原口径）；B 把新倒地/受击动画也加进来（移到添加清单） | **A**；如你想要新的倒地动画选 B |
| D7 | locomotion 过渡（walkstop/turn/run-bs 10 条）何时接？ | A 暂缓（先把上列做完，等 B1/B2 转向/停止状态）；B 先接 catalog 播放试验 | **A** |

---

## 9. 附录 A：adv 137 条全景处置表（v2）

> 处置：✅已加 / 🧹去重清理 / ➕本计划新增 / ⏭不添加（同动画/反应类）/ ⏸暂缓（需状态/序列/道具/质量修复）/ 📦catalog-only（等修复/序列）
> 唯一分类（idle 7 + walk/run 3 + locomotion 18 + social 80 + skill 19 + react 10 = 137）。

| 组 | clip id | 条数 | 关键属性 | 处置 |
|---|---|---|---|---|
| idle 待机（tag=idle） | `idle`、`idle2`、`attackStandby`、`standby2`、`idleShow`、`idleShow2`、`commonIdle` | 7 | idleShow/idleShow2/standby2 一次性；idle2/attackStandby/standby2 源 held_l | `idle` ✅（变体）；`commonIdle` ✅→🧹P0-1；`idle2` ⏭（同一条动画）；`attackStandby` ➕P1-1；`idleShow`/`idleShow2`/`standby2` ➕P3-1（一次性展示） |
| 待机循环（social tag，已在/可进 idle 池） | `think01`、`worry01`、`scratchHead01` | 3 | loop/feet/PASS | ✅已加（-7/-8/-8） |
| （social 中）可扩 idle 稀有 | `shrug01`、`lookAtPhone` | 2 | loop/feet/PASS；lookAtPhone 需手机 | `shrug01` ➕P1-4；`lookAtPhone` ⏸（手机缺失） |
| walk/run | `walk`、`run`、`fastrun` | 3 | walk loop/feet/PASS；run/fastrun WARN P8 | `walk` ✅；`run`/`fastrun` ⏸（P8 修复后） |
| locomotion 过渡 | `walkstop-l/r`、`turn-45/90/180-l/r`、`run-bs-l/r`、`run-turnleft/right-l/r`、`runstop-l/r`、`fastrunstop-r`、`fastrun-turnright-l` | 18 | 一次性；其中 run/stop 族 8 条 WARN P8 | `walkstop`/`turn`/`run-bs`（10）⏸P4-1；其余 8 条 ⏸（P8） |
| social 社交（26 个 base id / 80 clip） | 家族：akimbo01/02、alert01、backward01、build02、bye01、covermouth01、forerake02、holdarm01、holdhead01、injured01、lookatphone、puthand01、scratchhead01、shrug01、snap01、strikechest01、talk01/talk02、think01、useheadphone01、useprop01/02、watchphone01、worry01/02 | 80 | 三段式 AS/BS/Hand/Loop + 单段；多数 feet | `talk01`/`talk02`/`bye01` ➕P3-1 第一批；loop/单段（shrug01/akimbo01loop/holdarm01loop/covermouth01loop/worry02loop/snap01loop 等）➕P1-4/P3-1 第二批（先预览）；build02*/forerake02*/useprop*/useheadphone*/injured01*/lookatphone*/watchphone* ⏸（道具缺失，非重复）；手机/耳机类 ⏸；AS/BS/Hand 50 段 📦（序列器后） |
| （social 已在上方 idle 行的 5 条） | `think01`、`worry01`、`scratchHead01`、`shrug01`、`lookAtPhone` | — | — | 见 idle 行（3 ✅ / 1 ➕P1-4 / 1 ⏸） |
| skill 技能 | `skill01`、`skill02`、`skill03`、`skill04`、`skill04-2`、`skill41`、`mazeSkill`、`mazeattack01`、`skill01readybs`、`skill01readyloop`、`skill01-ready`、`skill01-ready-loop`、`skill01toskill02`、`skill02readyloop`、`skill02-ready-loop`、`skill02toskill01`、`skill03-ready`、`skill04-ready`、`skill04-ready-loop` | 19 | 全部 grounding=none；持枪 held_r 7 条；P9 切镜 4 条 | `skill01`/`mazeSkill`/`skill04`/`mazeattack01` ➕P2-1 第一批；`skill02`/`skill03`/`skill41`/`skill04-2` ⏸P2-1 第二批（P9 遮罩后）；ready/transition 11 段 📦（技能序列器后） |
| react/死亡 | `behit`、`die`、`die-loop`、`hit-h`、`hitL`、`hit-stun`、`revive`、`stun`、`stunLoop`、`state-stun-recover` | 10 | 多 none；held_l 7 条 | ⏭ **不添加**（反应类，用户口径；catalog 可回放；D6-B 可选） |

### 附录 B：数字核对（可复跑）

> 注：manifest `tags` 是多标签（idle 12 含 5 条社交待机循环、locomotion 19 含 fastrun），相加会超过 137；附录 A 用去重后的唯一分类（7+3+18+80+19+10=137）。

```bash
python3 - <<'EOF'
import json, collections
m = json.load(open('assets/motions/adv/manifest.json')); c = m['clips']
print('clips:', len(c))
print('tags:', collections.Counter(t for x in c for t in x.get('tags', [])))
print('loop:', collections.Counter(x.get('loop') for x in c))
print('grounding:', collections.Counter(x.get('grounding') for x in c))
print('slot:', collections.Counter(x.get('slot') for x in c))
cat = json.load(open('assets/motions/app-catalog.json'))
man = json.load(open('assets/motions/app-manifest.json'))
print('catalog:', len(cat['clips']), collections.Counter(x['set'] for x in cat['clips']))
print('manifest:', len(man['clips']), 'adv=', sum(1 for x in man['clips'] if x['id'].startswith('adv-')))
EOF
```

---

## 10. 证据索引

- adv 产出/校验：`assets/motions/adv/{manifest,index}.json`、`docs/adv-full-v3-acceptance.md` §3/§4/§6.3/§7、`tests/tmp/adv-full-v3/pipeline/validation-report.json`
- adv 全景清单/风险/去重底稿：`work/adv-plan/adv-inventory.md`（本机临时产物，gitignored；含 26 条循环合格池、19 条 WARN 逐条、profile B 前后差异）
- 同动画数据核对（本文 §2.3 的方法）：逐帧对齐 + 去每骨常量偏移后比较姿态角；同一条动画判定阈值平均差 <1°
- app 清单：`assets/motions/app-manifest.json`、`assets/motions/app-catalog.json`、生成器 `scripts/vrm/motion/build-app-manifest.mjs`
- hsr 动作接线先例：`build-app-manifest.mjs` `MOOD_CLIP_ALIASES`、`src/renderer/src/main.ts` L197-219/L664-683、`src/renderer/src/vrm/clip-player.ts` L105-246/L1015-1040、`src/renderer/src/reactions/dsh-work-fidget.ts`
- 现有接线逐层审计：`work/adv-plan/audit-hsr-wiring.md`（本机临时产物，gitignored；各层 adv 现状 + file:line + 测试同步清单）
- 用户决策：`docs/vrm-motion-mapping-recommendations.md` §4、`docs/adv-app-manifest-proposal.md` §3
- 水枪：`src/renderer/src/vrm/watergun-attach.json`、`prop-config.ts`、`docs/research/watergun-adv-integration.md`
- 验收口径：`docs/adv-acceptance-plan.md`、`docs/anim-acceptance.md`


---

## 11. 实现记录（2026-11-10，Lead 收口）

> 本节记录实际落地与计划单的差异；代码未 git commit（工作树改动，测试已全绿）。

### 11.1 实际落地

| 层 | 实现 | 文件 |
|---|---|---|
| 数据/清单 | `adv-idle` priority 9→**10**（与 `hsr-idle` 同级）；`adv-commonIdle` 移出 idle 槽（与 hsr 同一条动画去重，catalog 保留）；`dshBusy←adv-think01`、`dshDone←adv-snap01loop` 两条别名；app-manifest **40 条**（idle 19 / walk 3 / sit 7 / drag 2 / pat 3 / sleep 1 / dshBusy 2 / dshDone 2 / dshError 1），catalog 181 不变 | `clips.adv-all.b.json`、`build-app-manifest.mjs`、`apply-adv-app-profile.py`；产物 `assets/motions/**`（gitignored） |
| idle 主待机随机 | 播放器：一次性/手动 clip 播完回 mood 时按「初始选片」重新随机（最高优先级并列随机）；**idle 定时轮换保持默认 12–20s（用户中途要求不要关闭）**；打开/回归 idle 时 `hsr-idle` / `adv-idle` 同分随机 | `src/renderer/src/vrm/clip-player.ts` |
| 倒地随机 | 进入 dshError 时在 `hsr-breaked` / **`adv-die`** 之间等概率随机（非循环 + hold 末帧；退出仍 `hsr-revive`，error 12s 不变） | `runtime-types.ts`（enterClip 支持数组）、`animator.ts`（随机挑选）、`main.ts` |
| DSH 工作小动作 | 技能池 = `hsr-skill01`/`hsr-skill02` + **`adv-skill01`**（持枪）+ **`adv-mazeattack01`**（持枪）；不接 skill02/03/04/41/04-2/mazeSkill（缺滑板/苏乐达、P9 切镜） | `main.ts` |
| 闲时一次性动作（新机制） | 新增 `IdleOneShotFidget`：mood=idle 且不阻塞时每 **2–5 分钟**随机播一条一次性动作（首次 40–90s，blocked 不重置计时，与 DSH fidget 同帧互斥）；候选 8 条：`adv-talk01`/`adv-talk02`/`adv-bye01`（社交单段）+ `adv-idleShow`/`adv-idleShow2`（抛硬币展示）+ `adv-lookAtPhone`/`adv-watchphone01loop`/`adv-useheadphone01loop`（手机/耳机 loop 段各播一轮） | 新增 `src/renderer/src/reactions/idle-one-shot-fidget.ts`；`main.ts` 接线；新增 `tests/idle-one-shot-fidget.test.ts` |

### 11.2 明确未接（用户口径：缺大件配件/缺动画/看起来怪）

- 缺场景大件道具：`build02*`、`forerake02*`、`useprop01/02`（沙堡/耙子等会空手比划）；`injured01*`（受伤语义）、`alert01*`（悬空 0.088m）、`adv-standby2`（一次性战斗待机变体）。
- 缺动画/切镜：`skill02/03/04/41/04-2/mazeSkill`（缺滑板/苏乐达或 P9 单帧 79–145° 跳变）；ready/transition 段留给序列器。
- 反应类其余动作（`behit/die-loop/hit-h/hit-stun/stunLoop/state-stun-recover/revive` 等）按「一模一样/同功能」口径仍不加（仅把 `adv-die` 用户特别点名加进倒地随机）。
- P8 竖直轴悬空 10 条（`run`/`fastrun`/`runstop`/`run-turn`）与社交 AS/BS/Hand 过渡段（会停在半姿态）保持 catalog-only；locomotion 过渡（walkstop/turn/run-bs）等 B1/B2 状态后再接。

### 11.3 验证

- `pnpm typecheck`：Exit 0。
- `pnpm test`（全量）：**112 files / 1959 passed / 14 skipped / 0 failed**（无回归；含新增 micro-motion 6 用例）。
- `node scripts/vrm/motion/build-app-manifest.mjs --check`：PASS；`build-adv-manifest.mjs --check`：OK（clips=137）。
- 定向新测试：`tests/idle-one-shot-fidget.test.ts` 14 用例；`tests/vrm-clip-player.test.ts` 新增 idle 同级随机/回归随机/轮换保留 3 用例；`tests/vrm-animator.test.ts` 新增数组随机倒地用例；`tests/dsh-work-fidget.test.ts` 新增 adv 候选集合用例。
- 回滚基线：`work/adv-impl/rollback/`（改动前 4 份产物 + SHA256SUMS）。

### 11.3b 追加修正（2026-11-10，用户实机反馈）

- **女体待机**：mate 女体 idle 的 10 条全部 priority ≤ -10，被播放器 -9 阈值挡在轮换外（**仍不会自动轮换**）。审计发现轮换池里实际偏女性化的是 adv 的 3 条 **NPC 社交待机**：`adv-think01`(-7)/`adv-worry01`(-8)/`adv-scratchHead01`(-8)（托腮/捂胸口/挠头，稀有变体）。
  - 中途曾按用户「不要自动进轮换」把这 3 条移出 idle 槽（app-manifest 40→37、idle 活跃 9→6）；**用户随后改口「不要把 adv 移出 idle 轮换」→ 已放回**（priority -7/-8/-8）。
  - **最终状态**：app-manifest **40 条**，idle 名义 **19** / 活跃 **9**（hsr-idle/idle2/idleShow/idleShow2/commonIdle + adv-idle + adv-think01/worry01/scratchHead01 三条稀有变体）；catalog 181 不变；`build-app-manifest --check` PASS。
- **adv 待机水枪**：审计确认运行时从未接过——水枪白名单自首个提交起只有 7 条 adv **skill**（右手），idle 类全部不在白名单；源数据里 `idle2`(TeamStandBy)/`attackStandby`/`standby2` 是**左手**持枪、`idle`(StandBy) 枪在脚边地面；官方「战斗待机/走跑/站立」实机空手。用户若要在待机显示水枪，需要：①改 `prop-layer` 支持 per-clip 左手/双实例 + 左手校准；或②把持枪普攻（adv-skill01/mazeattack01）放 idle 一次性展示（右手，现有 DSH 小动作先例）。
- **脚/腰观感（已实现，2026-11-10）**：
  - 根因（调研 + 数据双证）：① foot-lock **从不写 hips.quaternion**，只改腿 + 有界骨盆下沉，所以不是“腰被锁死”；② 源 idle **本身腰就不动**（HSR StandBy Root_M 旋转 0.000°/位移 0mm；adv StandBy Pelvis 0.532°/3.19mm，且 retarget 只剥了表演 idle 的水平位移、旋转完整保留）；③ 站立时髋→踝 0.8801m vs 腿长 0.8814m，膝部余量仅 **1.3mm**，腿几乎是直杆，所以数据静止 + 双脚钉死 → 看起来僵；④ VRM 后端没有旧 PMX 后端的程序化微动层。
  - 修复：新增 `src/renderer/src/vrm/micro-motion.ts`（`VrmMicroMotion`），在 `clip-player.update()` 之后、`foot-lock.update()` 之前叠加载性微动：呼吸（胸/脊 1.2–1.5°、周期 4.3s）、重心（骨盆侧移 ±1.5cm / roll ±2° / yaw ±1.2° / pitch ±0.5°、8–15s 承重脚慢层）、头/颈极慢漂移（2.4°）、**软膝基准下沉 0.8cm**（research 实测：膝弯 7.7°→15.6°，foot-lock 额外下沉仅 1.1mm、脚漂移 0mm）。只在 `mood=idle 且 slot=idle、grounded、!dragging、foot-lock 存在` 时启用；crossfade 期间 ×0.85（不归零）、表演型 idle（Idle_Show）压到 0.3、一次性/手动 clip 0.2–0.35s 淡出；`needsRawSync` 已包含本层。
  - 集成验证（新测试 `tests/vrm-micro-motion.test.ts`，用真实 `VrmFootLock` + 真实 normalized rest 比例）：微动下双脚漂移 ≤2mm、踝误差 ≤3mm、pinned、骨盆下沉 ≤4cm、膝部明显弯曲。
  - 调研来源：Orange Duck IK/foot locking、rabfulton/VRM foot-planting、Unity Two Bone IK、UntoldEngine FootIK、FBG Pelvis、Idle Weaver 等（完整 URL 见 `work/adv-research/hip-motion-report.md`）。

### 11.4 遗留风险（需实机确认）

1. `adv-die` 末帧姿态与 `hsr-revive` 首帧跪伏姿态的衔接可能有一帧 pop（尤其随机到 adv-die 后 12s 起身时）。
2. `adv-idleShow`/`idleShow2` 含抛硬币/香水手势但无对应道具，实机观感需确认（用户认为问题不大，故保留）。
3. 闲时一次性动作每 2–5 分钟打断 idle 一次；如嫌频繁可调 `IDLE_ONE_SHOT_FIDGET_DEFAULTS` 或加 config。
4. idle 定时轮换保留（用户要求）：进入 idle 随机到的 `hsr-idle`/`adv-idle` 会在 12–20s 后按原逻辑轮换到其它 idle 变体（含 idleShow 等）。
5. DSH 工作小动作与闲时动作只有「同一帧」互斥；DSH 小动作 due 恰好落在闲时动作播放期间时可能替换它（按任务范围未改 DSH 的 blocked 逻辑）。
