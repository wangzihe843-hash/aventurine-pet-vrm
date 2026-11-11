# 修复报告：窗沿「只趴/坐/躺」+ 静态脚固定后的腿形异常

> 日期：2026-11-11 · 范围：VRM 渲染后端（`behavior-director` / `pet-runtime` / `main.ts` / `foot-lock`）
> 用户报告（2026-11-10 23:25）：
> 1）「自从修过静态动作滑步之后，模型有时候会出现如图所示的腿异常弯曲；我推测是脚固定做得太粗糙；
>    我们之前尝试过调整腰的位置但没能成功解决。」
> 2）「坐窗口为什么会出现站起来的情况？我们的设计不是要桌宠被放在窗口上之后只会趴/坐/躺吗？
>    为什么它自己走上去就不行？」
>
> 调研报告（含完整证据链）：`tests/tmp/inv-leg/REPORT.md`（bug A，39KB）、
> `tests/tmp/inv-sitwindow/REPORT.md`（bug B，651 行）；实现记录：`tests/tmp/fix-{leg-ik,window-b1,window-anim}/NOTES.md`；
> 实机验收采集：`tests/tmp/lead-accept/post-{window,window-long,idle,ground}/`（`tests/tmp/` gitignore，证据不随仓库分发）。

---

## 0. TL;DR

| 项 | 结论 |
|---|---|
| 腿异常弯曲根因 | **不是坏锚点/作者姿态**：foot-lock 把首次站姿的踝锚点**跨 idle 变体保留**，而各 idle 变体作者脚位相差 **13–21cm** → 两骨 IK 每帧把腿拧向旧锚点（膝相对踝横移 12–42px、膝屈曲偏差最大 17.5°、脚 yaw 偏差最大 17°），并保持 12–20s；micro-motion（软膝/骨盆横移）是同 clip 残差的放大器（膝多弯 ~14°，非主因）。**调腰无效**：锚点在脚、IK 每帧解腿，腰只是输入，改不了「锚点站姿 ≠ 当前 clip 作者站姿」。 |
| 腿形修法 | foot-lock 增加 **A 锚点-作者脚位对齐**（把「锚点−作者踝位」残差均值平移 normalized hips x/z，≤0.18m、deadband 5mm、τ0.30s、非累积）+ **B 脚朝向软跟随**（偏差 >9° 时锚点朝向以 τ0.4s 转向作者脚朝向，位置仍钉死；保留 >35°/0.25s 硬释放安全网）。只动 `foot-lock.ts`（+可选调试字段），walk/drag/sit/sleep 行为不变。 |
| 腿形改善 | 真实 VRM+clip 离线 A/B：膝相对踝横向残差 **31–48px → 1–12px**（多数场景 60–95%），脚仍钉死（footError≈0）；实机 idle 基座变体切换脚像素漂移 ≤6.5px（手工测试项见 §2.4）。 |
| 窗沿站立根因 | ① 自主 sit 结束后 `AUTO_SIT_GAP` 强制间隔 **20–40s**，gap 内只落回 idle 站立（用户截图/实机 38–50% 窗沿帧在站）；② gap 内随机调度仍能抽到 `walkTo`（明确允许当前表面=window-top）/`returnCorner`/`lookAround`/idle 变体；③ 放置/落地触发的非自主 sit 结束后另有 **~0.7s** 站立空档；④ pat/poke/DSH 反应无动画层兜底；⑤ `autonomous=false` 时坐完直接站。 |
| 窗沿修法 | 新增「**OnLedge（grounded 在 sittable window-top）只允许 recumbent**」不变量（B1 最高优先级、当帧续下一段 sit、零 idle 帧；禁止 walkTo/returnCorner/lookAround/idle 变体；窗沿不设 GAP；唯一自主离开=受控 `dropDown`（≥2 段后每段 P=0.4）；`autonomous=false` 也维持）+ 动画层安全网（非 recumbent 动画 mood 强制 `sit`，排除 drag/airborne/fall）+ 坐姿风格轮换**收紧为只用窗沿适配素材**：高窗候选固定 `mate-windowLay8`（headroom≥0.60H+8 时可加 `lie`），矮窗固定标准 sit；用户 50%@top=324 场景单候选不轮换（避免 floor-sit 上窗沿/切换横移）+ DSH one-shot 在 sit 时阻塞。 |
| 窗沿改善 | 仿真 3 seeds×10min：站立帧 **44.0/46.0/49.7% → 0**、walkTo 帧 **311–914 → 0**；实机放置到 Finder 窗沿 62/62 帧全 sit（0 站立、0 走动），风格轮换 windowLay8↔mate-sit1 正常；自主「滑上窗沿」路径（sit-approach）落座后直接坐、约 50s 后按策略跳下（受控 dropDown）。 |
| 回归门禁 | `pnpm typecheck` 0；`pnpm test` **123 files / 2129 passed / 11 skipped**（基线 122/2071/11，+58 用例，0 回归）；`pnpm build` 0；实机 idle/ground/window 三场景 0 errors。 |

---

## 1. 用户报告与复现

### 1.1 现场截图

- 23:15 截图：宠物站在桌面地面（idle 变体 A，腿基本正常）。
- 23:16 截图：宠物站在 Finder 窗口上沿（`win-*-top`，top=324），**上半身出屏、只露腿**；腿呈外八/脚掌外翻。
  实机复现（`tests/tmp/lead-accept/`、`/tmp/lead-window/`）：宠物在窗沿上约 38–50% 的帧是站立 idle
  （`behavior.mood=idle`，clip 为 `hsr-idle` / `hsr-idle2` / `hsr-idleShow2` / `lookAround(adv-think01)` 等），
  与被截图状态一致。

### 1.2 复跑方式

```bash
# 实机采集（隔离 profile，dev-capture）
node tests/tmp/lead-accept/run-case.mjs window tests/tmp/lead-accept/post-window 220 800
node tests/tmp/lead-accept/run-case.mjs idle  tests/tmp/lead-accept/post-idle  140 600
node tests/tmp/lead-accept/run-case.mjs ground tests/tmp/lead-accept/post-ground 150 800
# 分析
node tests/tmp/lead-accept/accept.mjs window <dir>   # 窗沿站立帧 = 0 判据
node tests/tmp/lead-accept/accept.mjs idle <dir>     # 脚像素漂移/pin/误差
node tests/tmp/lead-accept/accept.mjs ground <dir>   # 地面行为不回归
```

---

## 2. 问题 A：静态脚固定后的腿部异常弯曲

### 2.1 根因（证据见 `tests/tmp/inv-leg/REPORT.md` §2–§6）

1. **feet 锚点跨 idle 变体保留**（`foot-lock.ts` 的 pin 设计：跨 clip 保持不被换锚）。
2. **idle 变体作者站姿差异大**（真实 VRM+clip FK 实测，`fk.test.ts`）：
   - `hsr-idle`：左踝 (x=0.272, z=-0.033)、右踝 (-0.039, -0.180)；
   - `adv-idle`：左踝 (0.111, -0.090)、右踝 (-0.173, -0.083)；
   - 左踝 Δ(-16.1cm, -5.7cm)、右踝 Δ(-13.4cm, +9.7cm)；`hsr-commonIdle` 亦有 ~13cm 差异。
3. **IK 把腿拧向旧锚点**（离线复现 animator 层序，`sim.test.ts`）：脚钉死的同时，膝相对踝横移 12–42px、
   膝屈曲偏差最大 17.5°、脚 yaw 被钉在旧值偏差最大 17°；用户截图/实机帧观感一致。
4. **micro-motion 是放大器**（不是主因）：同 clip 下 softKneeDrop(0.8cm)+hips 横移 ±1.5cm/roll±2°
   会让「运行时 vs 作者」再有 12–16px / ~14° 残差；micro 单独开（无 footLock）腿形偏差为 0。
5. **已排除**：坏锚点捕获时机（sit→idle 时 pin 的 lift≈0、err≈6mm；`visualOffset` 只作用于 root，
   锚点 scene-local 不受影响）、单脚释放（全程双脚 pinned）、骨骼/数据问题（同名 clip 地面与窗沿轮廓一致）、
   纯 micro-motion 主因。
6. **为什么「调腰」没用**：hips 每帧被 clip-player 重写、micro-motion 再改；foot-lock 每帧解腿到固定锚点，
   腰位置只是 IK 输入/骨盆下沉，不改变「锚点站姿 ≠ 当前 clip 作者站姿」这个残差（只有 lift/速度/不可达/
   脚朝向 >35° 才释放）。用户此前调腰当然无效。

### 2.2 修法（`src/renderer/src/vrm/foot-lock.ts`）

- **A：锚点-作者脚位对齐（主修）**
  - 每帧对 pinned 脚计算 `pinPosition − 当前作者踝位（IK 前）` 的残差，取双脚平均 → 目标 `hipShift`（x/z）；
  - 向量长度钳制 `MAX_HIP_SHIFT_M = 0.18`（方向保持）、deadband 5mm、平滑 `STANCE_ALIGN_TAU_SEC = 0.30s`；
  - 只写 normalized `hips.position.x/z`（y 仍归 `pelvisDropM`），每帧基于 clip-player 刚写回的基准重新计算
    → **非累积**；不写 `avatar.scene`/root；离开 idle（非 eligible）按同 τ 归零；`reset()` 归零；
  - 调用点：`updateContact()` 之后、可达性/pelvisDrop 之前；预分配 `rigs` 数组保持 R-03 零每帧分配口径。
- **B：脚朝向软跟随（辅修）**
  - 脚朝向与（跟随后的）锚点偏差 > `9°` 时，`pinQuaternion` 同半球 slerp 向当前作者脚朝向
    （`ORIENTATION_SOFT_FOLLOW_TAU_SEC = 0.4s`，位置仍钉住），消踝扭转/外八；
  - 保留既有 >35°/0.25s 硬释放安全网，判定用「本帧跟随前」角度（不会被软跟随拖住）。
- **调试字段**：`VrmFootLockDebugSnapshot` 增加可选 `hipShiftXM/ZM`、`left/rightFootOrientationErrDeg`
  （`runtime-types.ts` + `wave2-contract.ts` 内联类型同步，均为可选、旧消费方兼容）。
- **不改**：`solveKneePosition`/poleHint/不可达释放/转身释放/接触迟滞/pelvisDrop/micro-motion 语义；
  walk/climb/fall/drag/grabWindow/sit/sleep 仍不锁。

### 2.3 验证

- 单测：`tests/vrm-foot-lock.test.ts` 46/46（原 28 + 新增 A/B 10 组：15/21cm 站姿差恢复、钳制/deadband/
  单脚、离开 idle 归零、朝向 5°/20°/60°/70°、30/60/144Hz、reset 重锁、不累积/平滑/脚不滑）。
- 离线真实资产 A/B（`tests/tmp/inv-leg/sim.test.ts`）：多数变体膝相对踝横向残差 31–48px → 1–12px（60–95%）；
  脚 `footError≈0`、pinned=true；`hipShift` 实测峰值 0.18m（钳制生效），离开 idle 归零。
- 实机（`tests/tmp/lead-accept/post-idle`）：排除一次性小动作（manual clip）后，基座 idle 变体全程脚像素漂移
  左 2.5px / 右 6.5px（单 clip 段 ≤3.5px）；`footErrorM ≈ 0`；髋部平移最大 0.18m 平滑过渡；脚朝向残差
  稳态 ~8.8°（软跟随阈值 9°），无外八硬拧帧。

### 2.4 已知限制（方案固有，见 §5）

- 两脚**不对称**残差本模型实测最大 7.8cm（单一平移无法同时对齐两只脚）+ 近伸直腿对髋-锚点距离极敏感
  （1mm≈3.6°）→ 部分变体膝屈曲角仍有 8–20° 偏差（不再有 40px 级横向扭曲）；
- `hsr-idleShow` 作者脚位均值差 21cm > 0.18m 预算，钳制后仍有少量 IK 兜底；
- micro-motion 的 softKneeDrop 贡献的 ~14° 膝弯未改（用户已验收「腰要会动」）；
- 身体会随锚点-作者差**缓慢水平平移**（≤0.18m，观感为重心转移；命中/气泡仍按 `petRect`，可能有 ≤0.18m 偏差）。

---

## 3. 问题 B：窗沿上站起来/走动

### 3.1 根因（证据见 `tests/tmp/inv-sitwindow/REPORT.md` §2–§3）

| # | 路径 | 说明 |
|---|---|---|
| R1（主因） | 自主 sit 结束 → `AUTO_SIT_GAP` 20–40s | `finishActivity` 设 gap 并把 sit 冷却推到 gap 末；gap 内 `trySitOnWindowTop` 直接 return null → 落回 `buildIdleDecision`（mood=idle）→ 动画层照搬站立 idle。仿真 3 seeds×10min 窗沿站立帧 44.0/46.0/49.7%。 |
| R2 | gap 内随机调度 | `walkTo`（weight 20）的 `prepareWalkTarget` 明确允许当前表面=window-top；`returnCorner` 目标在屏幕右下 → B2 水平走出沿边掉落；`lookAround`/idle 变体为站立表演。实机 run1 窗沿帧 42.2% 站立，含沿上 walkTo 2.9s。 |
| R3 | 非自主 sit 结束后 0.7s 空档 | 放置/落地触发的 sit 结束 → 到下一次 auto-sit 有 700ms 延迟，期间站立（实机 39/41 帧一致命中）。 |
| R4 | pat/poke/DSH 反应无兜底 | 反应优先级高于自主分支，可在窗沿上切到站立 reaction/one-shot clip。 |
| R5 | 落地 450ms 缓冲 | 从空中落到窗沿后 450ms 站立窗口。 |
| R6 | D6a 段 id 抖动 | `currentSurface` id 暂时对不上时可能漏判窗沿。 |
| R7 | `autonomous=false` | 直接走 idle 分支，坐完即站。 |

排除路径：可坐窗沿自动吸附/放置逻辑本身正常（「被放上去会坐」一直成立）。

### 3.2 修法（Lead 批准的产品决策，见调研报告 §4/§6）

1. **B1 不变量**（`behavior-director.ts`）：`onSittableWindowTop`（含 D6a top±2px + 横向覆盖脚底 rematch）
   + `maintainWindowTopRest` 置于 `buildAutonomousDecision` 最高优先级（先于 `autonomous=false` 分支）：
   - OnLedge 只发 **sit**；sit 结束**当帧**续下一段 sit（跳过随机池/冷却/GAP）→ 零 idle 帧；
   - 其它活动（walkTo/returnCorner/lookAround/idle 变体/climb/sleep）立即终止；
   - `followWindow`（坐着跟窗口）放行；`dropDown` 为唯一自主离开方式；
   - **受控离开**：连续完成 ≥2 段 recumbent 后，每段结束以 seeded random **P=0.4** 选 `dropDown`
     （`autonomous=false` 不跳）；实测均值 ~94.5s/次（12 seeds×10min 65 次）。
   - 调度层兜底：`prepareWalkTarget` 遇可坐窗沿返回 null；`pickAndStartActivity` 窗沿白名单 `sit`/`dropDown`；
     debug `triggerActivity` 拒绝站立类；`finishActivity` 窗沿不设 GAP。
2. **动画层安全网**（`pet-runtime.ts`）：`isGroundedOnSittableWindowTop` + `animationMoodFor(..., onSittableWindowTop)`
   —— grounded 在可坐窗沿时，非 recumbent 的动画 mood（pat/poke/DSH 反应等）强制 `sit`；排除 drag/airborne/fall。
   **tradeoff（Lead 批准）**：窗沿上摸头/DSH 反应被压成坐姿，仅气泡/表情可见。
3. **坐姿风格轮换（收紧版）**（`main.ts` + `pet-runtime.buildSitWindowStyleCandidates`）：
   - 高窗（基线 sitVariant）候选 = **仅窗沿适配素材** `mate-windowLay8`；headroom ≥ **0.60×身高+8** 时追加 `lie(mate-sitWindow)`；
   - 矮窗（基线标准 sit）候选 = 仅标准 sit（恢复既有已验收固定行为）；
   - 轮换每 20–30s、不连续同风格；`autonomous=false` 不轮换；窗口移动/换沿/几何变化重置状态；
   - **用户场景（50%/top=324）候选只有 windowLay8 → 不轮换**：杜绝 base sit playlist 的 `mate-suwari3` 等
     floor-sit 素材被搬到窗沿（会像「盘腿/蹲在窗口上」），也消除风格切换瞬间身体横移（实测 53–64px → 3px）；
   - `updateDshWorkFidget` 在 sit 时阻塞 one-shot 站立技能。
4. **行为变化（用户可见）**：
   - 窗沿上不再出现站立/走动/看风景 idle；坐下后持续是坐/趴/躺（风格会换）；
   - 约每 1–2 分钟（随机）可能自己跳下窗沿（保留既有「跳下窗口」能力，避免永久锁在窗沿）；
   - 窗沿上的摸头/戳/DSH 反应只剩气泡与表情，不做站立反应动作；
   - `autonomous=false` 时同样维持卧姿（不随机换风格、不主动跳下）。

### 3.3 验证

- 仿真（3 seeds×10min，窗沿静止）：站立帧 **44.0/46.0/49.7% → 0**；walkTo 帧 **311–914 → 0**；
  dropDown 首次均 ≥2 段完整 recumbent；`autonomous=false` 10min 0 跳下。
- 新增/更新单测：`tests/window-top-recumbent.test.ts`（14 例：T1–T10 + 窗口关闭 fallback + 地面不回归）、
  `tests/fix-f2a-autosit.test.ts`（N-1 按新口径重写、N-2 保留并收紧）、`tests/behavior-director.test.ts`（5 例）、
  `tests/pet-runtime-animation-mood.test.ts`（16→36 例：安全网/候选/轮换/pat 打断端到端）、
  `tests/fix-f2a-motion-limits.test.ts`（fixture 窗沿改不可坐）。
- 实机（`tests/tmp/lead-accept/post-window`，放置到 Finder 可见窗沿 top=324）：
  - 放置后 `place-immediate` 即 sit（无站立中间态）；
  - 窗沿 grounded 帧 **62/62 全 sit**、0 站立、0 walkTo；风格轮换 `mate-windowLay8 → mate-sit1 → mate-windowLay8`；
  - 约 50s（2 段 recumbent）后受控 dropDown 跳下，落地后正常 idle/sleep；
  - 另一段自主「滑上窗沿」（ground 场景 n=15 帧 `sit-approach` clip=adv-walk、grounded=false → n=16 落座
    `mate-windowLay8`）验证了用户问的「它自己走上去」路径：落座后不再站起，直到受控跳下。
- 长采集（`post-window-long`，260 帧×1s≈4.3min，见 §4）覆盖多轮风格切换+受控跳下。

---

## 4. 回归门禁与实机验收（2026-11-11 最终）

| 检查 | 结果 |
|---|---|
| `pnpm typecheck` | exit 0（node+web） |
| `pnpm test` | **123 files / 2131 passed / 11 skipped（2142）**（基线 122 files / 2071 passed / 11 skipped；+60 用例，0 失败） |
| `pnpm build` | exit 0（typecheck + electron-vite build） |
| 独立验证（verifier subagent） | 见 `tests/tmp/verify-fixes/REPORT.md`：0 Blocker/0 High；窗沿 179/179 帧 sit、clip 恒 windowLay8、0 次切换、bbox 相邻帧 ≤3px；idle 脚漂移 ≤2px、pinned 220/220；ground 0 errors。M-1/M-2 已复验 RESOLVED，M-3（hit 区横移）留 follow-up |
| 实机 window | 窗沿 grounded 帧 **194/194 全 sit**、0 站立 / 0 走动；放置即坐；clip 恒为 `mate-windowLay8`（无 floor-sit；150ms 采样下 bbox 中心相邻帧最大 3px）；受控 dropDown 后正常回地面 |
| 实机 idle | 基座 idle 脚像素漂移 ≤6.5px；脚仍钉死；腿形 normal montage 见 `tests/tmp/lead-accept/idle-legs-montage.png` |
| 实机 ground | 自主 150 帧 0 errors；`idle 18 / sit 131 / fall 1`；滑上窗沿→坐下链路正常，无站立窗沿帧 |

> 说明：idle 采集中的「一次性小动作（manual clip，如 adv-talk02）」期间与结束后，脚位会有 ~20–60px 位移
> （既有设计：一次性/手动 clip 不做脚固定；本次不变），分析时已按 manual 段排除（见 §5）。

---

## 5. 已知限制 / 后续（本轮明确不做）

1. **方案 A 固有上限**：两脚不对称残差（本模型最大 7.8cm）与近伸直腿对距离的敏感性，导致部分变体膝屈曲
   角仍有 8–20° 偏差（横向扭曲已消除）；`hsr-idleShow` 21cm > 0.18m 预算仍有少量 IK 兜底。若要根治需数据侧
   归一化 idle 站姿（改 bake 管线，另案）。
2. **身体水平平移**：`hipShift` 使身体相对脚最多平移 0.18m（观感为重心转移）；`petRect`/命中区/气泡仍按
   物理脚位，视觉中心与命中区最多偏差 ~0.18m（Low）。
3. **窗沿反应被压成坐姿**：摸头/戳/DSH 反应在窗沿上只显示气泡/表情，不做站立反应动作（产品 tradeoff，
   Lead 已批准）。
4. **受控 dropDown 概率/间隔**：`WINDOW_TOP_REST_EXIT_MIN_SEGMENTS=2`、`P=0.4`（均值 ~94.5s）；如用户希望
   「永不自主跳下 / 更频繁跳下」，改这两个常量即可（测试会同步）。
5. **一次性小动作不做脚固定**：idle one-shot（manual clip）播放/结束重锁时脚位会位移 ~20–60px（既有行为）。
6. **窗沿坐姿轮换仅限窗沿适配素材**：高窗固定 windowLay8（+空间足够时的 lie），用户 50%/top=324 场景不轮换；
   若未来要恢复更丰富轮换，应先把标准 sit playlist 的 floor-sit 素材排除或改用窗沿适配变体（windowLay9/10
   曾因观感不稳被排除，需重新验收）。
7. **D6a 旧 id 残留**：`motion.surfaceId` 残留旧 id 时走既有 fall 兜底（视觉非站立），未扩范围。
8. **非可坐高窗沿**（headroom 不足）与 `anchor` 站定路径保持原行为，不属于「窗沿卧姿」范围。
9. **micro-motion softKneeDrop** 的 ~14° 膝弯未改（用户要求「腰要会动」，本轮不动）。

---

## 6. 回滚

- 代码：`git checkout <修复前 HEAD> -- src/renderer/src/vrm/foot-lock.ts src/renderer/src/vrm/runtime-types.ts
  src/renderer/src/core/wave2-contract.ts src/renderer/src/core/pet-runtime.ts src/renderer/src/main.ts
  src/renderer/src/behavior/behavior-director.ts tests/...`（本次改动未提交，可直接用 `git diff` 审查/挑拣）。
- 运行时：仓内无配置开关；如只回退脚部固定 A/B，可把 `VrmFootLock` 内部 `applyStanceAlign` 目标恒 0、
  或 `CreateVrmPetAnimatorOptions.footLock=false`（回到旧实现，注意旧实现本身有腿形问题）。

## 7. 主要文件

```
src/renderer/src/vrm/foot-lock.ts            A 锚点-作者脚位对齐 + B 脚朝向软跟随 + 调试字段
src/renderer/src/vrm/runtime-types.ts        调试快照可选字段
src/renderer/src/core/wave2-contract.ts      footLock 内联类型可选字段同步
src/renderer/src/core/pet-runtime.ts         动画层安全网 + 风格候选/轮换纯函数
src/renderer/src/main.ts                     坐姿风格轮换状态机 + DSH one-shot 阻塞
src/renderer/src/behavior/behavior-director.ts 窗沿 recumbent 不变量/调度白名单/受控 dropDown
tests/vrm-foot-lock.test.ts                  46 用例（+A/B 10 组）
tests/window-top-recumbent.test.ts           窗沿不变量 14 用例（新增）
tests/pet-runtime-animation-mood.test.ts     36 用例（安全网/候选/轮换）
tests/fix-f2a-autosit.test.ts                 N-1 新口径 + N-2 保留
tests/behavior-director.test.ts               受影响用例更新
tests/fix-f2a-motion-limits.test.ts           fixture 窗沿改不可坐（1 处）
```
