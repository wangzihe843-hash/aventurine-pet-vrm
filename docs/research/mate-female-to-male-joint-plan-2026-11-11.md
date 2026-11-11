# Mate-Engine 女体源动作 × 男体 VRM：逐关节审计与修正方案（2026-11-11，调查稿 v3）

> **用户决策（2026-11-11 14:36）**：① **拒绝任何花钱方案**（免费/注册账号可行）；② **语义无所谓**——「可可爱爱的砂金总监也有卖萌的自由」，**不要刻板印象/不要强行男性化**；女性化/卖萌手势保留，只修真实畸变。
>
> **用户 2026-11-11 15:01 重要修正（v4）**：用户指出「溜肩看起来还是很怪异」，并**质疑 Lead 之前「Unity on 男体也这样所以不是 bug」的结论**：应去看 **Mate-Engine 官方展示视频（B站/Steam）里原版女体的效果**；用户判断这很可能是**女体肩相对较短的体型 bug**，且之前列出的需修点也可能都是体型差导致的真实 bug；要求**继续派 subagent 执行原修复计划**。→ 本轮已按此：① 验证了比例假说（见 §0.2）；② 派 subagent 去官方展示视频取证；③ 派 subagent 实现比例感知肩/臂重定向。
>
> 状态：P0 α-fold 已实现并提交（§0.1）；**P1 比例感知肩/臂重定向（S2+S4' 的 source-intent 版）实现中**；官方展示视频取证中。
> 触发：用户反馈 mate-engine 女体源资产（例：坐窗口）在男体 VRM 上「骨骼被拉伸/严重溜肩」；
> 用户要求：① 不能只修肩、要逐关节调查；② 先上网找方案再复核；③ 等腿部修复会话完成后再动手改。
> 证据目录（gitignore，只读）：`tests/tmp/lead-shoulder/**`、`/tmp/research-r1/**`、`/tmp/research-r2/**`、`/tmp/research-r3/**`；
> 复现脚本：`tests/tmp/lead-shoulder/{probe,audit,rest-audit}.test.ts`、`gt-joint-compare.py`、`scripts/unity-bake/preview-clips.mjs`。

---

## 0. TL;DR

1. **「严重溜肩」已在当前 app 复现**（dev-capture `mate-sit1` 帧与用户截图同族）。它**不是渲染错觉**，也不是腿/脚锁层的问题：肩窝（upperArm 关节点）在 idle/sit 类 clip 里相对 chest 被压低 **4.3–6.0cm**、后移 ~3.5cm，然后衣服/肩袖网格随之塌陷。
2. 直接原因按证据强度排序：
   - **C1（真 bug，10/30 clip）**：目标男体 VRM **无 upperChest**，播放器把 clip 的 `UpperChest` 轨道**整条丢弃**（`laughing 23.7° / sleep 16.9° / idle4 15.5° / idle2 12.7° …`）。数学上不是「少转」而是**反向旋转**：neck/leftShoulder/rightShoulder（及 head、双臂）相对源被 **counter-rotate |U|**（误差角 = |U|，共轭不变）；头/手位移实测 2.4–6.4cm（sleep 12.7cm）。**R1 复核：公式已证；HSR/ADV 14 条 clip 的 UpperChest 全为 identity（我逐条复算），所以 HSR/ADV 男性正常不只是因为男源/体型，还因为 upperChest 处理对了**。
   - **C2（姿势语义，主因）**：女体动作把锁骨当下沉+后缩的审美骨用：`Shoulder` 局部旋转 **17–38°**（男体参考 adv-idle 2.1° / adv-walk 7.0°；mate-walk 7.2° 已验收）；锁骨长 12.34cm，每多压 1° 肩窝下沉 ≈2.2mm → 4.3cm 级下坠。
   - **C3（烘焙数据保真度）**：**已用「Unity GT on 男体目标」重新定量**（§2.6）：current app vs Unity 自己在同一男体上的结果，差异 = 每个 clip 一个**全局常量旋转**（0.5–4.2°，所有关节同值，来自合成骨架 muscle 限位 vs 目标 avatar 标定）+（10 条 clip）**UpperChest 未折叠的 |U|**（4–10°）。**折叠后**整条链的残余只有 1–3.3°；也就是说，**Aventurine 男体上「溜肩/姿势怪」不是我们管线的明显错误，而主要是源女体姿势意图 + 男体比例/蒙皮/衣物**——这决定了我们不搞「男性化」，只修 bug 与真实畸变。
   - **C4（身体比例/rest 差）**：男体比烘焙合成骨架：上臂+前臂长 **0.443m vs 0.530m（84%）**、upperArm 关节点高 chest **0.126m vs 0.220m（57%，posed sit1 仅 32%）**、颈长 0.74×、锁骨 rest 方向差 3.84°、足骨 rest 方向差 19.9°、hips/spine/chest 骨位语义不同。关键几何（R1 复核）：**手臂下垂时肩点低与臂短几乎抵消（≈0.7cm），但上举 90° 手低 ≈18cm、前平举 ≈10cm、正前伸 ≈13cm**——这正好解释「站姿/HSR 正常，sit/睡/躲藏（手前上抬）坏」。normalized 只保**骨朝向**、不保关节点位置/手位，所以方向指标测不到这类误差。
   - **C5（动作语汇）**：手抬胸前（肘 117° vs 男 idle 17–23°）、手只比肩低 8cm、摆胯/侧倾等；只能靠「男性动作源替换/手臂层嫁接」解决，全局 offset 救不了。
3. **方案骨架（v4，2026-11-11 15:01 用户反馈后）**：`S1 upperChest α-fold`（P0，**已完成并提交 83d4d6c**）→ `P1-v4 比例感知肩/臂重定向`（**实现中**：以源 Zome 视觉姿态为目标，锁骨按 L_s/L_t·H_t/H_s≈0.71–0.80 缩放 + 手臂 world 朝向保持（S2），再用 hand-target IK 把手放回源归一化位置（S4'）；保留可爱手势，不是男性化）→ 官方展示视频/Steam 截帧目视验收（原版女体基准）→ 袖型权重/穿模等按需（S6）。**S3 手臂层嫁接（男性语汇）已否决**；S5 幅度阻尼只在有技术性副作用时考虑。
4. **「男女体型差距」是部分解释、不是充分解释**（R1 独立结论，与本轮审计/GT 对拍一致）：它解释手位 10–18cm 的**身体比例差**（相对源女体）与肩线观感差异；但**管线本身 after fold 与 Unity 官方重定向只差 1–3°、手位差 1–2.8cm**——剩下的「好看/不好看」是姿势意图、蒙皮/衣物的审美问题，不是数学错。
5. **明确不改**：`walk/walkAlt`、HSR/adv 管线、脚锁/微动层（已由另一会话修复并提交，**不碰**）；不碰骨骼 scale / 不缩骨长 / 不大幅降骨盆 / 不用大角度 upperArm 全局 offset（会回归 A-pose）；**不做「去女性化/男性化」动作层替换**（用户已否决）。
6. 逐关节审计表见 §3（22 核心骨 + 30 手指，逐 clip 数据见 `audit-out.json`）；外包调研 R1/R2/R3 均已完成并复核（§5），R1 的可复算几何（肩点/臂长/抬臂误差）已并入 §2.4。

### 0.1 当前落地状态（2026-11-11 14:51）

- ✅ **P0 S1 α-fold 已实现并提交**（α=1，与 Unity on 男体行为一致）：commit `83d4d6c`（4 files，新增 `upper-chest-fold.ts`；`clip-player.ts` 的 `applyFrame` + `applyClipPoseDirect` 贴地测量路径都折叠；`clip-viewer.js` 同步；`tests/vrm-upper-chest-fold.test.ts` 14 用例）。验证：`pnpm typecheck` 通过、fold 定向 72/72、**全量 `pnpm test` 2727 passed / 11 skipped**、app 实机 dev-capture `PET_DEV_CAPTURE_MOOD=sleep` 正常渲染（`tests/tmp/lead-shoulder/app-sleep-fold/`）。
- ✅ **Unity GT on 男体目标已跑完**（30 clip，`tests/tmp/lead-shoulder/gt-male/out/unity/`）：结论见 §2.6——fold 后与 Unity 官方重定向只差 1–3.3°、逐关节残余 ≤1°、手位差 1–2.8cm。
- 📷 **P0b 视觉 A/B 已生成**：`tests/tmp/lead-shoulder/fold-after/`（fold 后 8 clip 接触表）vs `tests/tmp/lead-shoulder/all-mate/`（fold 前）；对比图 `tests/tmp/lead-shoulder/evidence/fold-ab-zoom.png` / `fold-ab-sheets.jpg`。**待用户目视确认「卖萌姿势是否 OK」**（尤其 sleep/laughing/idle4）。
- ✅ **官方展示素材取证（A）完成**：Steam 官方 trailer（1280x720/1080p，2:56）+商店页；结论：**官方女体坐/躺肩线正常（轻微斜肩是设计，无塌肩/拉伸）**；男体是真实缺陷：同一 20° 锁骨下压，女体肩点位移 1.84cm vs 男体 4.16cm（2.26×；按躯干归一 1.58×）；男体 neck→shoulder 绝对 1.75×（按躯干归一 1.20×）。证据：`tests/tmp/lead-shoulder/evidence/source-official-evidence-board.jpg`、`source-vs-male-shoulder-closeup.png`；报告 `/tmp/mate-source-evidence/REPORT.md`。注意：商店/trailer 角色是 Yorshka 黑发演示模型（非 Zome），默认场景模型才是 Zome；官方没有 Zome 坐窗公开视频，B站只有 Zome 站立教程 → 1:1 Zome 坐姿基准缺失，用「官方女体视觉 + Zome canonical 3D 渲染」补。
- 🔄 **P1-v4 比例感知重定向 round-1 原型（B）完成，发现需修问题**：absolute 模式坐姿 socket 抬 2.4–4.4cm、windowLay8/sit1 目视明显改善（三栏 A/B：`tests/tmp/lead-proportion/evidence/*-f000-ab.jpg`；截图 `tests/tmp/lead-shoulder/evidence/proportion-retarget-{sit1,windowLay8}-ab-round1.jpg`）；但 **idle 族 A-pose 回归**（上臂体相对水平角变化 6.3° >5°，手 IK 把可爱手势张开）、sit1/sit2/windowLay9/10/idle4 手位误差 4–8cm（臂长比例不可达）、sleep 病态、部分帧跳增大。→ 已派 subagent C 做 v2：**S2-only（只锁骨预算转移，不动手）为 idle/手势类主方案** + Hybrid（接触类受限手 IK + A-pose/位移 guard + 时域平滑）+ sleep 排除；k 两档 0.713/0.80 对比；输出 `tests/tmp/lead-proportion-v2/`。
- ✅ **v2 精修（C）完成**：新增 `scripts/unity-bake/{lib/proportion-retarget-v2.mjs,proportion-retarget-v2.mjs}`、`tests/unity-bake-proportion-retarget-v2.test.ts`（16 例；与 B 合计 33 passed）；23 clip × 6 variant 全部 validate ok；CPU 蒙皮拉伸 sit1：Chest p99 16.63→12.56mm（−24%）、LeftUpperArm 17.79→15.77（−11%）、RightUpperArm 24.09→18.38（−24%）。C 推荐：S2-socket k=0.714 全量基线 + Hybrid（严格 guards）只对 suwari3/windowLay8/9/hideLeft/hideOnce；sit1/sit2/windowLay10 IK 全 0%（guards 回退），sleep/sitWindow 排除。C 自己也标注：S2 只修「动画下坠量」，**肩点绝对高度仍比源归一化低 ~3cm**；k=0.80/0.857 均不如 0.714。报告 `tests/tmp/lead-proportion-v2/summary-v2.md`。
- **Lead 判定 + v3（D）完成**：C 的 k=0.714 只抬 1.0–1.5cm，视觉上仍不够；Lead 实测 **S2-absolute（锁骨 aim 到源视觉绝对高度）→ socket 抬 2.4–4.4cm、肩线明显接近源**，idle 手势完整；接触类再叠加「目标=修正前原手位置、≤4cm、肘限、回退、5-tap 平滑」的受限手 IK 后，手回接触位置、肩线保持（证据 `tests/tmp/lead-shoulder/evidence/s2-only-vs-s2-limited-ik-{sit1,windowLay8}.jpg`）。D 已实现 `s2-absolute`/`hybrid-absolute`/`hybrid-absolute-blend` + `--lift-fraction`/`--partial-ik`，测试 47/47（B17+C16+D14）、typecheck 通过；输出 `tests/tmp/lead-proportion-v3/**`（`clips-recommended/` 23/23 validate ok、`recommended.json`、`summary-v3.md`、evidence full/shoulder/contact/recommended）。
  - **推荐 balanced（v3 优先，v2 兜底）**：idle/idle2–7/happy/laughing/shyPoint/pose1–3 → `s2-absolute`（idle f=1.0，idle6 f=0.95，其余 f=0.80；**A-pose 0°/hand 朝向不变**，手整体上移 2.5–4.5cm、无接触语义问题）；sit1/suwari3/windowLay8 → `hybrid-absolute` g=15°（手回接触：0.9/4.8、0.3/4.6、0.6/0.9cm，肩高误差 -0.2/+0.5/-0.4cm）；sitWindow → `hybrid-absolute` g=4°（手 0/0，肩高 +0.4cm）；hideLeft/hideOnce/windowLay9/sit2/windowLay10 → v2 保守回退（肩只抬 1.0–1.5cm，normErr 仍 -3cm 左右）；sleep 排除。
  - **已知弱项**：hide/sit2/windowLay9/10 无法同时满足「肩不塌+手不浮+A-pose≤5°」；v3 激进档代价已量化（手浮 4.6–5.1cm 或 A-pose 9.2°/蒙皮 +70%）。idle 类手整体上移 4.5cm 需目视是否自然；happy/suwari3/sitWindow CPU 蒙皮局部 +38–58% 需真实渲染目视。
  - **✅ 已按用户决策集成（2026-11-11 16:30）**：用户拍板——① 接受 balanced 推荐切 app；② 5 个弱项 clip **肩线优先、接受手浮 4–5cm** → hideLeft/hideOnce/sit2/windowLay9/windowLay10 改用 `s2-absolute f=1`（不再用 v2 保守档）。最终 **22 个 tuned clip** 放 `assets/motions/mate-tuned/`（`assets/motions/` 整体 gitignore、本地私有，不提交）；`app-manifest.json`/`app-catalog.json` 的 mate 路径已切到 `mate-tuned/`（这两个清单也在 gitignore 内，本地生效）。**回滚**：`assets/motions/app-manifest.before-mate-tuned.json` / `app-catalog.before-mate-tuned.json` 覆盖回去即可；原始 `assets/motions/mate/*.json` 未改。`sleep` 保持原样；`sitWindow` 用 hybrid g=4°；其余按推荐表。
  - **验证**：`pnpm test` **2781 passed / 11 skipped**（139 files）、`pnpm typecheck` 通过；app 实机 dev-capture（`PET_DEV_CAPTURE_MOOD=idle|sit`）加载 tuned 清单正常、无 error/warn；tuned clip 逐帧数据来自 v3 管线（23→22 clip validate ok）。
  - **工具提交范围**：`scripts/unity-bake/{lib/proportion-retarget*.mjs,proportion-retarget*.mjs,source-canonical-reference.mjs,compose-proportion-ab*.mjs}`、`tests/unity-bake-proportion-retarget*.test.ts`（47 tests，已改为可移植路径）、`docs/research/proportion-retarget-prototype-2026-11-11.md`。**不提交**：assets/motions（私有）、tests/tmp（gitignore）、app-manifest/app-catalog（gitignore）。
  - **残余风险/待目视**：idle 类手整体上移 4.5cm；5 个弱项已按用户选择接受手浮 4–5cm；happy/suwari3/sitWindow 局部蒙皮 p99 +38–58%（真实渲染需再目视）。
  - **2026-11-11 16:41 用户要求重启 + sleep 不行就移出自动播放**：① 首次 restart 用的仍是旧包（`pnpm package:dir` 因一次性 tsc 失败未产出新包）→ 16:50 重新 `pnpm package:dir` 成功，tuned assets 已进 `dist/mac-arm64/AventurinePet.app/Contents/Resources/assets/motions/{mate-tuned, app-manifest.json}`（21/22 tuned 引用），16:52 以新包重启（注意本机 shell 有 `ELECTRON_RUN_AS_NODE=1`，启动需 unset，否则 Electron 以 Node 模式跑、应用闪退）；② **sleep 已移出自主调度**：`activities.ts` sleep `schedulable=false`、`baseWeight=0`（保留定义供 debug trigger；同 climb 机制）；`fix-f2a-sleep.test.ts` 标注废止并 skip；`behavior-activities.test.ts` sleep 权重用例改为「任何上下文权重 0」；全量测试 **2777 passed / 15 skipped**。
  - **给用户的验证点**：重启后先看 idle/坐窗变化；若某个具体 clip 仍看不出差异，记录 clip 名/帧，后续可继续调 `liftFraction`、改用 partial IK 或查蒙皮/衣权重。
- B 的完整报告：`docs/research/proportion-retarget-prototype-2026-11-11.md`；代码/测试/渲染：`scripts/unity-bake/{proportion-retarget.mjs,lib/proportion-retarget.mjs,source-canonical-reference.mjs,compose-proportion-ab.mjs}`、`tests/unity-bake-proportion-retarget.test.ts`、`tests/tmp/lead-proportion/**`。
- Lead 独立三栏检查（源 Zome | 原男体 | **S2-only k=0.7**）：idle 双手身前手势保留、肩点抬起，无 round-1 的 A-pose 张开问题；sit1/windowLay8 肩线改善且手位自然。证据：`tests/tmp/lead-shoulder/evidence/s2only-vs-source-before-3panel.png`。
- **2026-11-11 15:45 用户要求「sit/window/hide 先单 S2 试，不行再加受限手」→ Lead 已验证**：
  - 按比例 k=0.714 的 S2-only：socket 只抬 **1.0–1.5cm**，归一化肩高误差仍 -3~-4cm → **视觉不够**（C smoke：idle/sit1/windowLay8 均如此）。
  - 改为「S2 锁骨 aim 到源视觉绝对高度」的 S2-only（只改 Shoulder/UpperArm、保手臂 world 朝向、不碰手）：socket 抬 **2.4–4.4cm**、肩线接近源，idle 可爱手势完整；**但接触类手随肩整体上浮 2–4cm**（sit1 手离膝、windowLay8 手离腿）。
  - 再加**受限手 IK**（修正量 ≤4cm、肘限、保留手/手指旋转）：手回到原接触位置、肩线保持抬升——sit1/windowLay8 目视明显优于单 S2。证据：`tests/tmp/lead-shoulder/evidence/s2-only-vs-s2-limited-ik-{sit1,windowLay8}.jpg`。
  - **结论/最终策略**：idle/手势类 = S2-absolute-only（不动手）；sit/window/hide 接触类 = S2-absolute + 受限手 IK（≤4cm、guards、平滑）；sleep 先排除/单独 A/B。C 的 v2 k-scaled 基座需替换为「源视觉绝对高度」clavicle aim（已作为 v2.1 下一步）。
- ⏳ 未做/按用户决策否决：S3 手臂层嫁接、S5 幅度阻尼、A1 男反应替换、任何付费采购。

### 0.2 【v4 关键修正】用户「女体肩短导致 bug」假说已被本地几何验证

用 Unity GT rest 骨位置直接量（`tests/tmp/wave15/groundtruth/unity/zome-rest.json` vs `tests/tmp/lead-shoulder/gt-male/out/unity/aventurine-tpose-rest.json`）：

| 项 | 源女体 Zome（1.455m） | 男体 Aventurine（1.734m） | 比例（男/源） |
|---|---:|---:|---:|
| 锁骨 Shoulder→UpperArm | **6.16cm** | **12.34cm** | **2.00×** |
| hips→head（躯干参照） | 33.2cm | 47.45cm | 1.43× |
| 肩点半宽（左右 UpperArm） | 9.27cm | 15.87cm | 1.71× |
| UpperArm→Hand | 36.42cm | 44.34cm | 1.22× |
| **锁骨 / 躯干长** | **0.186** | **0.260** | **1.40×**（男体锁骨相对长 40%） |
| 臂长 / 躯干长 | 1.097 | 0.935 | — |
| 身高 | 1.455m | 1.734m | 1.19× |

- 结论 1：**用户假说成立**。同一段女体动画的锁骨旋转（mate idle/sit1/windowLay 等 17–38° 下压+后缩）在男体上因锁骨**绝对长 2 倍**、躯干只高 1.43 倍，肩点位移会被放大约 **1.4–2×** → 视觉上的严重溜肩/肩袖塌陷是**体型比例 bug**，不是「设计如此」。
- 结论 2：**此前「臂短 16%」「手位差 10–18cm」的口径需要纠正**——那是拿**烘焙合成骨架**（1.7m、肩点 0.22m、臂 0.53m）当参照得到的；对**真正的源女体 Zome**，臂长/躯干比（1.10 vs 0.94）并不支持「臂明显偏短」是主因。**主因是锁骨/肩宽比例**（以及可能的上臂/前臂位置）。→ 修正目标应以**源 Zome 的视觉姿态**为准，而不是合成骨架。
- 结论 3：**§2.6 的「Unity on 男体也这样」不能证明不是 bug**：Unity 只是忠实重定向了同一套带比例失真的数据/骨骼；它证明的是「我们管线忠实于 Unity 重定向」，不是「重定向结果忠实于源女体视觉意图」。**验收基线要改为「源 Zome 渲染/官方展示视频里的姿态」+ 用户目视**；Unity-on-男体 GT 降级为诊断工具（分离管线误差 vs 比例误差）。
- 结论 4（官方素材 A 补强）：官方 trailer/商店页里**女体坐/躺肩线正常、没有塌肩/拉伸**（仅设计性轻微斜肩）；同一 20° 锁骨下压，女体肩点位移 **1.84cm**、男体 **4.16cm**（**2.26×**；按躯干归一 1.58×）；男体 neck→shoulder 绝对 1.75×、按躯干归一 1.20×。→ **用户判断正确：是比例重定向缺失导致的真实 bug，不是设计**。网格 p99 拉伸（sit1 1.45–1.54×、sitWindow 1.66–1.69×）是伴生现象，不是独立根因。

---

## 1. 本轮做了什么（可复现）

| # | 动作 | 产出 |
|---|---|---|
| 1 | 阅读历史文档/会话：wave15 男性适配、HSR/ADV 管线、脚锁/膝弯并发会话边界 | 见 §2 引用 |
| 2 | **实测复现**：dev-capture 强制 `mood=sit` 抓 40 帧（隔离 profile，未影响用户 app）；另在用户窗口上沿放置抓 40 帧 | `tests/tmp/lead-shoulder/app-sit/*.png|json`、`app-window.log`；截图对比 `evidence/app-sit1-repro-bust.png`（app 现状）与 `evidence/user-shot-sit-crop.png`（用户截图裁剪） |
| 3 | **逐 clip × 逐关节审计**：真实 VRM + 30 个 mate clip + 5 个男性参考 clip；逐帧 22 骨世界位置/四元数、关节相对角；CPU 蒙皮网格边长拉伸（按主导骨聚合） | `audit.test.ts` → `audit-out.json`（140 记录） |
| 4 | **rest/比例审计**：男体 normalized rest vs 烘焙合成骨架（ClipExporter 复刻）：骨长比、骨段方向差、关节相对 chest/hips 位置 | `rest-audit.test.ts` → `rest-mismatch.json` |
| 5 | **GT 数据保真度对拍**：Unity GT on Zome（源 avatar 上的真实结果）vs 我们的 baked 数据在 Zome 回放：逐关节相对旋转角差（11 clip × 22 骨 × 全帧） | `gt-joint-compare.py` → `gt-joint-compare.json` |
| 6 | **外包调研复核**：3 个只读 research subagent 全部回收（R3 肩部/风格化、R2 男性动作源、R1 normalized/跨体型重定向）；关键数字均用本轮独立审计/数据复算复核 | `/tmp/research-r3/R3-report.md`、`/tmp/research-r2/REPORT.md`、`/tmp/research-r1/report-r1.md`；复核见 §5 |
| 7 | 复核要点：R3 的锁骨角/肩窝高度/UpperChest 清单/手臂朝向；R1 的 375/375 rest identity、upperChest counter-rotate 公式、肩点 57%/臂长 84%、HSR upperChest=identity；R2 的 HUS 清单/官方文案/adv 动作库 | see §5；GLB/HSR 数据本轮直接复算一致 |

关键复现命令（只读，输出 tests/tmp）：

```bash
# 逐关节/网格审计（真实 VRM + 资产）
./node_modules/.bin/vitest run --config tests/tmp/lead-shoulder/vitest.config.mts tests/tmp/lead-shoulder/audit.test.ts
# rest/比例审计
./node_modules/.bin/vitest run --config tests/tmp/lead-shoulder/vitest.config.mts tests/tmp/lead-shoulder/rest-audit.test.ts
# GT 保真度（用既有 GT 快照，既有快照与当前数据逐位一致，已核）
python3 tests/tmp/lead-shoulder/gt-joint-compare.py
# 视觉 A/B（30 clip × 4 帧 + 接触表）
node scripts/unity-bake/preview-clips.mjs --all --vrm assets/vrm/aventurine-tpose.vrm \
  --out tests/tmp/lead-shoulder/all-mate --metrics tests/tmp/lead-shoulder/all-mate-metrics --sheet
```

---

## 2. 根因（已确认 / 部分确认）

### 2.1 已确认：UpperChest 轨道被静默丢弃（真 bug）

- 目标 VRM humanoid 列表**无 upperChest**（53 骨）；`humanoid-map.ts` 的 `VRM_BONE_FALLBACKS` 没有 upperChest → `clip-player.ts` 绑定循环直接 `continue`，不折叠、不告警（只有 `missingBones` 里一个名字）。
- 30 个 mate clip 中 **10 个** UpperChest 非单位（独立复算）：

| clip | UpperChest 最大旋转 |
|---|---:|
| laughing | 23.7° |
| sleep | 16.9° |
| idle7 | 15.6° |
| idle4 | 15.5° |
| idle5 | 12.9° |
| idle2 | 12.7° |
| shyPoint / happy | 7.6° |
| pose3 | 6.8° |
| drag | 4.8° |

- **数学后果（R1 复核，已证）**：设 chest 世界 delta = `D_C`、upperChest 局部 = `U`、子骨局部 = `q_N`：
  - 源：`D_N^src = D_C · U · q_N`；目标（轨道被丢）：`D_N^tgt = D_C · q_N`；
  - 误差：`D_N^tgt⁻¹ · D_N^src = q_N⁻¹ · U · q_N` → **误差角 = |U|，方向是 counter-rotate**；neck/leftShoulder/rightShoulder 及 head、双臂全部受影响（含 4 条是 roll 侧倾）。
- **官方兼容修法（VRMA 规范，已抓原文核对）**：目标少骨时，把 upperChest 旋转乘到其**直接子骨**（neck、leftShoulder、rightShoulder）上：“the neck, leftShoulder, and rightShoulder of the destination model should be transformed by both the rotation of upperChest and the rotation of the bone itself by multiplying the two”。
- 因此实现为 **α-fold（连续旋钮）**：`q_chest' = q_chest · U^α`；`q_neck' = U^(1-α) · q_neck`；`q_shoulder' = U^(1-α) · q_shoulder`（左右；`U^α = slerp(I,U,α)`）。α=0 = 规范推荐（子骨吸收，chest 网格不拿 U）；α=1 = HSR 风格（chest 吸收）；**任何 α 下 neck/shoulder/head 世界朝向都精确恢复**，α 只决定 chest 网格/肩点分配。先 A/B α=0、0.5、1，建议 0.3–0.5；只对 UpperChest 非 identity 且目标缺该骨的 clip 生效。
- 与 GT 对拍一致：**Chest 关节角差与 UpperChest 大小正相关**（idle2 4.05°、happy 4.2°、sleep 9.92°，而 UpperChest=0 的 idle/sitWindow/hideLeft 等 Chest 差 0.0°）→ α-fold 应能把 Chest 保真度拉回；这是 P0。
- 补充（R1，🟡二级因素）：`.anim` 存的是 **Unity muscle 值**，同一 muscle 值在不同 Avatar 的 T-pose/肌肉限位下展开角度不同；合成骨架对全部骨用 `HumanLimit{useDefaultValues=true}`（默认限位），这是 C3 里「部分 clip 肩/胸差 10–15°」的合理来源之一。修法优先「用目标 avatar 重烘」（S0'），bake 侧收窄 Muscle & Settings 是全局改动，须 A/B，不能替代 α-fold。

### 2.2 已确认：女体锁骨姿势 × 男体锁骨长度 = 溜肩主因

- 实测（本轮的 audit，独立复算 R3）：

| clip | Shoulder 关节相对角 | 肩窝相对 chest 高度（rest 12.63cm） |
|---|---:|---:|
| mate-idle | 27.0° | 6.58cm（−6.0cm） |
| mate-sit1 | 25.5° | 7.05cm |
| mate-windowLay8 | 17.8° | 10.27cm |
| mate-windowLay10 | 22.4° | 6.78cm |
| mate-sleep | 24.7° | —（躺姿，按帧变化） |
| adv-idle（男体参考） | 2.1° | 12.65cm |
| mate-walk（已验收） | 7.2° | 12.40cm |

- 世界系分解：mate-idle 左锁骨**下压 21.9° + 后缩 16.4°**（右 20.4°/17.8°），adv-walk 仅 ±2.6°/≈0°。锁骨长 12.34cm → 每 1° 约 2.2mm 肩窝位移；17–38° 即 4–6cm 级下坠。
- 结论：这是**女体审美语言被放大到男体**，不是矩阵错；修法应该改锁骨（socket），不动手臂方向（R3 的 S2 与 Houdini/UE 社区做法同构）。
- **与 R1 的「4.04° 锁骨差不是主因」不矛盾**：R1 说的是 **rest 骨段方向差 3.84°**（≈0.9cm 关节点位移，确实小）；本节说的是**动画里锁骨被旋转 17–38°**（下压+后缩，导致 4–6cm 级 socket 下坠）。两者是不同量，修法也不同。

### 2.3 已确认（局部）：合成骨架 bake 与真实 avatar 重定向在肩/上胸有差

- GT 对拍（Unity 在 Zome 上播原 .anim vs 我们数据在 Zome 上回放；逐关节相对旋转角差，11 clip 全帧）：
  - 躯干/腿/手脚：**≤0.2°**（Spine/Neck/Head/Legs/Toes 0.0–0.02，Foot 0.16–0.18，UpperArm 0.2–0.3，LowerArm 0.1）；
  - **Hips 1.2°（max 3.2）**、**Chest 1.65°（worst clip 9.9°/p95 15.8）**、**Shoulder 左 1.84°/worst 10.95°、右 2.64°/worst 15.16°（p95 17.2）**；
  - 按 clip：idle 双肩 10.95/9.3°、hideLeft 右肩 15.16°、happy 5.4/3.1°、sleep Chest 9.9°、idle2 Chest 4.05°；sitWindow/walk/intro/pose1/idle3 等 ≈0。
- 说明：bake 的归一化旋转在「源 avatar 没有 upperChest / 肩部 Muscle 标定不同」的 clip 上与 Unity 对真实 avatar 的重定向不一致（C3）。量级 10–15°，是「怪异角度」的第二来源（且与 C1 叠加）。R1 的独立解释（🟡）：`.anim` 是 **muscle 值**，合成骨架用**默认肌肉限位**、真实 avatar 的限位不同，所以同一 muscle 在肩/臂大幅前上抬的 clip 上展开角度不同 → 与「坏的是肩/臂大幅动作」一致。
- 典型干净修法 = 用**目标 avatar 在 Unity 里重定向一遍再转 normalized**（即把 GT 工具用于 `aventurine-tpose.vrm`）；但本机 Unity 在当前 DSH 沙箱下无法写 license/工程（报 project read-only），需在非沙箱 shell 跑一次（GT 工程/配置已备好：`tests/tmp/lead-shoulder/gt-male/config.json`，30 clip 对齐帧数）。若不可行，用 R3 的锁骨策略把该 clamp 掉（误差被吸收），并把重烘列为后续。

### 2.4 部分确认：身体比例/rest 差（逐关节见 §3）

- 男体 vs 烘焙合成骨架（normalized rest）：上臂 0.82×、前臂 0.85×、颈 0.74×、肩窝相对 chest 低 8.6cm，锁骨 rest 方向差 3.84°、足骨方向差 19.92°、hips→spine 1.36cm vs 12cm、spine→chest 18.15cm vs 12cm。
- **R1 的几何量化（已独立复核并复算一致）**：

| 项 | 合成骨架 | 男体 | 比例 |
|---|---:|---:|---:|
| hips 高度 | 1.000 | 1.066 | 1.066 |
| chest 高度 | 1.240 | 1.261 | 1.02 |
| upperArm 关节点高于 chest（rest） | 0.220 | **0.126** | **0.57** |
| upperArm→hand 长 | 0.530 | **0.443** | **0.84** |
| shoulder→upperArm 方向 | 0° | −3.7° | 4.0° |
| upperArm 高于 chest（sit1 第 0 帧，posed） | ~0.22 | **0.071** | **0.32** |

- **抬臂角放大效应**（同方向直臂，男体手相对合成骨架）：正下垂 ≈ −0.7cm；水平外展 ≈ −9.8cm；上举 90° ≈ **−18cm**；正前平举 ≈ −10cm；正前伸 ≈ −13cm。→ 站姿/HSR/ADV（手臂下垂）误差被抵消；sit/睡/躲藏（手到脸/胸前/膝上，前上抬）误差叠加。这正是「为什么某些动作坏、某些正常」的几何答案。
  - **口径澄清（v3）**：这里的 10–18cm 是「男体手 vs（源女体/合成骨架）手」的**身体比例差**，不是我们管线的错；§2.6 的 Unity-on-男体对拍显示 fold 后我们的手位与 Unity 官方重定向只差 **1–2.8cm**。所以「手比 Zome 里低/近」是换体型的必然结果；是否要再把手拉回「脸/膝/腰」地标，属于产品选择（S4'，仅按需）。
- 这不是 bug，但意味着**同一 normalized 姿势在男体上的关节位置不同**：normalized 只保骨朝向（本模型 53/53 humanoid、375/375 节点 rest rotation 全 identity，我的复核与 R1 一致），不保关节点位置/手位；要靠**比例感知 hand-target 重定向/IK** 补。

### 2.5 已确认不是本轮范围

- 腿部弯曲/脚滑：并发会话（`修复桌宠腿部异常弯曲`）正在修 foot-lock/micro-motion/idle 站姿；本方案不动 foot-lock/micro-motion/animator。
- 网格蒙皮本身：CPU 蒙皮拉伸审计显示肩/上臂/腰在**所有** clip（含 HSR 男体参考）都有 10–20mm 级拉伸（衣装+蒙皮正常量），女体 clip 的 sleep/windowLay 更高（rightUpperArm 42mm、hips/腿 25–34mm）；先把骨骼修对，再复测蒙皮，不先怀疑渲染。

---

### 2.6 【新增·最强证据】Unity GT on 男体目标 vs 当前 app（逐关节误差）

> 目的：把「数据/管线误差」与「身体比例/姿势意图」彻底分开。方法：用 `work/UnityGroundTruthProj`（UniVRM）在**同一个** `aventurine-tpose.vrm` 的真实 Avatar 上播原始 `.anim`，采每帧 humanoid worldRot/位置（`tests/tmp/lead-shoulder/gt-male/out/unity/**`，30 clip 全部成功，Unity Personal 免费授权）；再与 three-vrm 回放当前 baked 数据对比。坐标系用 rest 拟合（signed permutation = `diag(-1,1,1)`，rest 方向 rms=0，Unity→three 反射 X + 旋转伪向量映射 `axis'=det(M)M·axis`）。
> 复现：`tests/tmp/lead-shoulder/gt-app-compare.test.ts` → `gt-app-compare-out.json`。

| clip | 当前 app vs Unity-on-男体（世界旋转误差，所有骨均匀的全局分量） | UpperChest 分量（10 条 clip） | α=1 折叠后残余 |
|---|---:|---:|---:|
| idle / idle2 / walk / sit1 / windowLay8 / hideLeft / pose1（U=0） | 2.6 / 4.0 / 2.8 / 4.0 / 2.0 / 0.6 / 0.5° | 0° | 同左（不适用） |
| idle4 | 9.7° | ~9.1°（U mean 9.79°） | **1.1°** |
| laughing | 8.0° | ~6.8°（U 9.28°） | **1.2–1.6°** |
| sleep | 9.2° | ~7.1°（U 9.59°） | **2.6–3.3°** |
| happy | 4.2° | ~3.4°（U 4.33°） | **1.4–2.0°** |

- **结论 1（P0 验证）**：Unity 在男体目标上**确实把 upperChest 旋转折叠进了 chest**（表现为 chest 及其全部子骨同幅误差 = |U|）；我们的 **α=1 fold 与 Unity 行为一致**——折叠后残余从 4–10° 降到 1–3.3°。→ S1 α=1 可直接实现。
- **结论 2（逐关节）**：U=0 的 clip 残余是**所有关节同值的全局常量旋转**（0.5–4.2°），来源是合成骨架 muscle 限位 vs 目标 avatar 标定（R1 的 Unity muscle space 二级因素）；**逐关节残余（扣掉全局）≤~1°**，所以**大部分关节不需要逐关节修正**。可选：用 GT 拟合每 clip 一个 hips 全局旋转常量做数据侧补偿（0.5–4°，视觉差异很小）。
- **结论 3（手位/比例）**：fold 后手/肘相对位置与 Unity-on-男体差约 **1–2.8cm**（sleep 最大 2.8cm），属臂长/肩点比例差；若要让手贴到「脸/膝/腰」等地标，才需要 S4'（比例感知 hand-target）；纯为「和 Unity 一致」不必做。
- **结论 4（v4 修正）**：fold 后 app 与 Unity 官方重定向只差 1–3.3° —— 这证明**我们的管线忠实于 Unity 重定向**，但**不能证明 Unity 的重定向结果忠实于源女体的视觉意图**（Unity 只是把同一套带比例问题的骨骼数据套到男体上）。§0.2 已用几何证明：源 Zome 锁骨 6.16cm、男体 12.34cm（2.0×）、锁骨/躯干比 0.186 vs 0.260（男体相对长 40%）——**同一锁骨旋转在男体上肩点位移被放大 1.4–2×，这是真实的体型比例 bug**。用户 2026-11-11 15:01 的判断正确。→ 修正目标改为**「还原源 Zome 的视觉姿态比例」**（比例感知 retarget），不是「跟随 Unity-on-男体」；同时保留可爱动作语义、不做男性化。

## 3. 逐关节审计表（22 核心骨 × 30 clip；30 手指单列）

> 判据：**jointRelDeg** = 关节相对旋转角（坐标/左右手系不敏感）；**socket** = upperArm 关节点相对 chest 的高度；**fidelity** = 与 Unity GT(Zome) 逐关节角差；**rest** = 男体 vs 合成骨架 rest 差。
> 详细数字：`audit-out.json`（逐 clip × 4 帧 × 52 骨）、`gt-joint-compare.json`、`rest-mismatch.json`。

| 关节 | 现状证据（已量化） | 目标 / 判据 | 本轮建议修正 | 层级 | 优先级 |
|---|---|---|---|---|---|
| **UpperChest** | 30 clip 中 10 条非单位（4.8–23.7°），运行时整条丢弃；颈部/双肩/双臂被 **counter-rotate |U|**；Chest fidelity 与它正相关 | 缺骨必须折叠：neck/左右 shoulder 的世界朝向精确恢复 | **S1 α-fold**：`q_chest'=q_chest·U^α`，`q_neck'=U^(1-α)·q_neck`，左右 `q_shoulder'=U^(1-α)·q_shoulder`；α=0/0.5/1 A/B（建议 0.3–0.5）；写骨前、crossfade 后；同步 clip-viewer | 运行时 `clip-player.ts`（或 bake 后处理，见 §4.1） | **P0** |
| **Chest** | fidelity 1.65°（worst 9.9/15.8°）；女体含胸/侧倾大（mate jointRel mean 10.8 vs 男参考 9.2，max 32.9） | fidelity→≤2°；男体胸腔略开 | S1 先修；S5 对 idle 族 chest 侧倾/前后 ×0.65；坐卧保留意图 | 运行时 + 数据 | P0/P4 |
| **Spine** | fidelity 0.0°；幅度 mate mean 11.6（max 41.1）vs 男 7.7（max 19.2） | 站立 idle 不超过男参考 +20% | S5：idle 族 spine 幅度 ×0.6–0.65 | 数据 | P4 |
| **Neck** | fidelity 0.0°；颈长 0.74×（7.4 vs 10cm）；mate jointRel mean 14.4 vs 男 9.1；S1 折叠会再移动头位 | 头相对 chest 方向/位置接近源；look-at 不被破坏 | S1 后复测；S5 neck/head 幅度 ×0.7–0.8（idle 族） | 运行时 + 数据 | P2/P4 |
| **Head** | fidelity 0.0°；mate head 幅度大（max 47.6 vs 男 26.4）；S1 影响头位 | 保持 look-at 行为 | 同上（只做幅度，不加常量偏转） | 数据 | P4 |
| **Hips** | fidelity 1.2°（max 3.2）；女体摆胯/侧移大（wave15：横漂 5.27cm vs 男 0）；hips 平移缩放已用 1.066 | 横漂 ≤3cm；坐/躺姿态保留 | S5：idle/walk 族 hips 平移 ×0.55、旋转 ×0.72；坐卧不动 | 数据 | P4 |
| **Shoulder L/R** | 女体**动画里**的锁骨旋转 17–38°（男参考 2–7°），socket 下坠 4.3–6cm；**rest 方向差仅 3.84°（≈0.9cm，R1 确认不是主因）**；fidelity 有 10–15° 系统差；sleep max 65° | 锁骨局部角 ≤8–10°；socket 相对 chest 0.118–0.127m；手臂 world 朝向不变 | **S2 锁骨预算转移**（每 clip 常数 k：`S'=slerp(I,S,k)`，`A'=S'⁻¹·S·A`，白名单见 §4.2）+ Houdini 式 clavicle 限位；walk/walkAlt 不动 | 数据 bake | **P1** |
| **UpperArm L/R** | 世界朝向正确（R1 确认本模型 rest 全 identity，0.00° 是必然）；但**关节点位置**：肩点高 chest 0.126 vs 0.220m（57%）、上臂+前臂长 0.443 vs 0.530m（84%）→ 抬臂时手位偏差 10–18cm；关节角幅度 mate 64/68 mean vs 男 81/75（女 idle 手抬胸前） | world 朝向不变（S2 恒等式）；肘 10–35°（站立自然）；手位按躯干比例回到目标地标 | S2 吸收旋转；**S4' 比例感知 hand-target 重定向**（见 §4.3）；idle 族可选 **S3 手臂层嫁接** | 数据 | P1/P2/P3 |
| **LowerArm L/R** | 女 idle 肘 117° vs 男 17–23°；sit/gesture 类 100–150°（意图本身）；fidelity 0.1°；臂短导致同样肘角下手位更近 | 站立 idle 肘 10–35°；保留接触意图；肘限 [10,150] | S3 只换 idle 族手臂层；其他 clip 由 S4' IK 解肘（pole 取源肘平面） | 数据 | P3 |
| **Hand L/R** | fidelity 0.0（数据是 Unity GT 手指探针合并的）；S2 后手位会移 3–4cm；比例差使手比源低/近（抬臂 10–18cm） | 手位误差 ≤1cm；手-躯干 0.22–0.28m（过远 >0.32 / 过近 <0.16）；手到脸/膝/腰按目标地标 | **S4'**：把源手/肘世界位置按**躯干长比例**映射到目标 chest/hips 系，clamp 98% reach，两骨 IK；容差 1cm，肘限 [10°,150°]，pole 取源肘平面；体前闭拢加宽 1.2–1.5×，头球 margin 3–5cm | 数据 bake | P2 |
| **UpperLeg L/R** | fidelity 0.0；长度 0.97、方向 1.15°；坐/躺为设计姿态 | 交给腿部会话；本方案不动 | 不改（协调：不碰 foot-lock/髋平移后的腿） | — | 协调 |
| **LowerLeg L/R** | fidelity 0.02；方向 6.4°；腿形由 foot-lock/站姿归一化负责 | 同上 | 不改 | — | 协调 |
| **Foot L/R** | fidelity 0.16–0.18；**rest 方向差 19.92°**（男体 足→趾 rest 与合成骨架不同）；脚 yaw 已被腿部会话 B 修过 | 脚 yaw 残差 ≤4°；不引入脚滑 | 本轮不改，写进与腿部会话的交接检查表（若重烘再统一修 rest） | — | 协调 |
| **Toes L/R** | fidelity 0.0；方向继承 Foot | 同上 | 不改 | — | 协调 |
| **手指 30 根** | 数据来自 Unity GT 手指探针（52 骨 pipeline），不是重定向猜测；女体手势（并指/翘指/半握）仍在 | 男性动作不做兰花指；不做逐指重定向 | P5（可选）：对 idle 族做手指阻尼/半握；本轮不做 | 数据 | P5 |
| 次级骨（头发/衣摆 SpringBone） | 未由 clip 驱动（rawPolicy=spring） | 不参与 | 不改 | — | — |

**逐 clip × 逐关节的「是否越界」清单**：`audit-out.json` 全部 140 条记录（30 clip × 4 帧 × 52 骨）。已知重点 clip：`idle`（肩/肘语汇）、`idle2/4/5/7`（UpperChest+锁骨）、`sit1/sit2/suwari3/sitWindow/windowLay8/9/10`（锁骨+socket 下坠）、`sleep`（UpperChest 16.9° + 躺姿）、`happy/laughing/shyPoint/pose*`（UpperChest+手势）。

### 3.1 逐关节调整清单（实现 subagent 可直接照做）

> 顺序即实现顺序；「数据层」= `scripts/unity-bake/masculinize-clips.mjs` + `assets/motions/mate-male-tuned/**`（新目录，不覆盖原数据）；「运行时」= `clip-player.ts`。

1. **UpperChest（先做，P0）**：目标缺 upperChest 时做 **α-fold**：`q_chest'=q_chest·U^α`、`q_neck'=U^(1-α)·q_neck`、左右 `q_shoulder'=U^(1-α)·q_shoulder`（crossfade 混合后、写骨前）；只对 UpperChest 非 identity 的 clip 生效；单测用「虚拟 upperChest 链」验 neck/shoulder/head world 误差 = 0（任意 α）；A/B α=0/0.5/1，建议 0.3–0.5。
2. **Chest（P0/P4）**：S1 后重测 GT fidelity；idle 族额外「胸腔打开」+2–4°（向 rest 反向 pitch）可选，且侧倾/前后幅度 ×0.65（S5）；坐/躺保留意图。
3. **男体目标 GT 对拍（已完成，§2.6）**：结论——fold 后 app 与 Unity 官方重定向只差 1–3.3°；剩下的「观感」来自源姿势意图+男体比例+蒙皮，**不强行男性化**。
4. **Shoulder L/R（仅按需，P2）**：**不做「男性参考角」限位**（用户否决刻板印象）。只有当视觉 A/B 显示某 clip 的肩/袖网格出现**真实塌陷/拉伸**（不是「看起来不够男性」）时，才对**该 clip 的该帧区间**做小幅锁骨修正（参考源 Zome/Unity GT 渲染，幅度 ≤5°，必须带上臂补偿 S2 公式）。
5. **UpperArm L/R（不主动改）**：fold 后已与 Unity-on-男体一致（残余 ≤1° 扣全局）；**不做男性化手臂层嫁接（S3 已否决）**。
6. **LowerArm/Hand L/R（仅按需，P2）**：若用户希望手贴到「脸/膝/腰/窗沿」等地标（或截图里出现手穿模/悬空），再做 S4' 比例感知 hand-target；否则保留源手势（卖萌自由）。
7. **蒙皮/袖型（仅按需，P2–P3）**：若 fold+姿势保留后袖口/肩部仍明显拉伸，再做权重/袖型修正（这是「真实畸变」而非语义问题，符合用户「只修真实问题」的指示）。
8. **Neck/Head（P0 已随 fold 修正）**：fold 后与 Unity-on-男体差 1–3.3°（含全局常量）；**不做幅度阻尼/男性化**；仅保留 look-at 正常。
9. **Hips/Spine（不主动改）**：fold 后扣掉全局常量残差 ≤1°；**不做幅度阻尼**（用户保留可爱摆胯）；若追求与 Unity 完全一致，可选「用 GT 拟合每 clip 全局 hips 旋转常量」数据侧补偿（0.5–4°，视觉收益小、非必需）。
10. **Legs/Feet/Toes（协调，不改）**：交给腿部会话（foot-lock/micro-motion/站姿归一化）；本方案不写任何 leg/foot 轨道；验收时确认腿/脚指标不回归（pinned/footError/脚像素漂移）。
11. **Fingers（P5，可选）**：只对 idle 族做半握/阻尼；其余 clip 不动（手型语义）。
12. **Secondary（不参与）**：SpringBone 链由渲染层模拟，不写数据。

---

## 4. 修正方案（按可落地顺序）

### 4.0 分层原则

- **α-fold 两种落点**：运行时（一次改、全 clip/未来 clip 生效、零资产风险，但每帧计算）或 **bake 后处理（首选：一次性写回新 clip 目录、可逐 clip A/B、零运行时成本）**；必须先 A/B α=0/0.5/1 再定。
- **数据层只放「真实畸变修正」**（only if needed）：可离线批量、可 A/B、可逐 clip 回滚——复用 `scripts/unity-bake/lib/pose-tune.mjs` 的 quaternion 工具与 `pose-tune.mjs` 的「帧区间偏移」先例，新脚本 `scripts/unity-bake/fix-clips.mjs`（不是 masculinize）+ 配置，产出新目录（gitignore），manifest 先不切，6 指标闸门过了再逐 clip 切。
- **不碰**：`walk/walkAlt`、HSR/adv 管线、`foot-lock.ts`/`micro-motion.ts`/`animator.ts`（腿部会话已修复并提交）、骨骼 scale、锁骨缩短、大幅降骨盆；**不做任何「去女性化」的姿势/手臂层替换**（用户 2026-11-11 决策）。

### 4.1 S1 upperChest α-fold（P0，0.5–1 天）

- **依据**：VRMA 规范（已抓原文核对）：目标少骨时把 upperChest 旋转乘到其直接子骨（neck、leftShoulder、rightShoulder）——“the neck, leftShoulder, and rightShoulder of the destination model should be transformed by both the rotation of upperChest and the rotation of the bone itself by multiplying the two”。
- 公式（`U` = clip 的 UpperChest 归一化旋转）：
  - `q_chest' = q_chest · U^α`（右乘；α 分给 chest）
  - `q_neck' = U^(1-α) · q_neck`；`q_shoulder' = U^(1-α) · q_shoulder`（左乘；左右都做）
  - `U^α = slerp(I, U, α)`；α∈[0,1]。**任意 α 下 neck/shoulder/head 世界朝向精确恢复**（恒等式），α 只决定 chest 网格/肩点分配：α=0 = 规范推荐（child absorb，chest 不拿 U）；α=1 = HSR 风格（chest absorb）。
- 位置：**优先 bake 后处理**（一次性写回新 clip 目录，`masculinize-clips.mjs` 的第一步，0 运行时成本、便于 A/B）；其次 runtime load 时逐帧预乘。**不要**在 `humanoid.update()` 之后改 raw 骨。
- 仅当「clip 有 UpperChest 非 identity」且「目标模型无 upperChest」时生效；目标有 upperChest 时不做。
- **α 取值（v3 决策）**：Unity GT on 男体目标显示，Unity 自己就是「fold 进 chest」（§2.6）→ **默认 α = 1.0**（与 Unity/HSR 行为一致）；实现里保留常量方便以后调。fold 后 sleep/laughing/idle4 与 Unity-on-男体残余 1–3.3°（折叠前 4–10°）。
- **本轮已在当前 app 语义（three-vrm normalized 骨）下模拟验证**（`tests/tmp/lead-shoulder/sim-fold.test.ts`，结果 `sim-fold-out.json`）：

| clip | 当前（丢 U）neck/肩/head 世界朝向误差 | α-fold 后误差（α=0/0.5/1） |
|---|---:|---:|
| sleep | 2.95–14.28°（随帧，U mean 9.59°） | **0.00° / 0.00° / 0.00°** |
| laughing | 0–23.16°（U mean 9.28°） | 0.00° / 0.00° / 0.00° |
| idle4 | 0–15.47°（U mean 9.79°） | 0.00° / 0.00° / 0.00° |
| idle2 | 0–12.43°（U mean 4.25°） | 0.00° / 0.00° / 0.00° |
| pose3 | 4.98–6.69° | 0.00° / 0.00° / 0.00° |
| happy | 0.63–5.95° | 0.00° / 0.00° / 0.00° |

  → 恒等式在真实管线成立（任意 α）；**当前误差恰好=|U|**，与 R1 公式一致。α 只影响 chest 网格/肩点分配，不影响 neck/肩/head 世界朝向。
- 验收/单测：纯函数对拍「虚拟 upperChest 链」：neck/shoulder/head world 旋转误差 <1e-6；A/B α=0/0.5/1 于 `sleep/laughing/idle4`（预期改善）+ `sit1/hideLeft`（U=0，预期不变，作干净对照）；Chest fidelity（重跑 GT 对拍）从 9.9°→≤2°。
- 风险：α 选错会让下胸过转或上胸滞后；`laughing/idle2/4/5/7` 观感变化（属修正，需 A/B 确认不引入僵硬）。

### 4.1b 男体目标 Unity GT 对拍（P1，验证层，不改产品）

- 目的：把「拓扑 bug（upperChest）/ 体型（肩点/臂长）/ 蒙皮（袖型）」分开，避免继续用 Zome 侧证据推断男体。
- 做法：用 `work/UnityGroundTruthProj`（UniVRM）+ `tests/tmp/lead-shoulder/gt-male/config.json`（30 clip 已对齐 baked frames），在 `aventurine-tpose.vrm` 的真实 Avatar 上播原 `.anim`，导出每帧 humanoid worldRot + shoulder/upperArm/hand 世界位置。
- 建议在**非沙箱 shell**跑（本轮 DSH 沙箱下 Unity 报 project read-only：license/工程写权限被挡）。
- 产出指标：`E_rot`、`E_ua`、`E_hand`、手-手/手-脸/手-胸距离（定义见 §6）；用它决定 S2/S4' 的 cap 与手位目标。
- 现状：配置已生成，未跑成功（沙箱限制）；作为实施 P1 第一步。

### 4.2 S2 锁骨预算转移（**v4：按源比例修正，P1 主线**）

> v4 修正（2026-11-11 15:01 用户反馈 + §0.2 几何验证）：这不是「男性化」，而是**修正源→目标锁骨长度比造成的真实放大**。目标 = 让男体的**肩点归一化位移/肩线视觉比例**与源 Zome 一致，同时保持手臂世界朝向、手/手指旋转（可爱手势不动）。

- **比例系数（由 rest 几何推导，P1 初值）**：设 `L_s = 源锁骨长 0.0616m`、`L_t = 目标锁骨长 0.1234m`、`H_s = 源 hips→head 0.332m`、`H_t = 目标 hips→head 0.4745m`。
  - 若目标是「肩点相对躯干高的下坠量归一化一致」：`sinθ_t = sinθ_s · (L_s/L_t) · (H_t/H_s)` → 小角度 `k ≈ 0.713`（即女体 20° 下压 → 男体约 14.3°）。
  - 若目标是「视觉肩线斜率（下坠/肩点半宽）一致」：需解 `L_t sinθ_t / (shoulderHeadHalf_t + L_t cosθ_t) = L_s sinθ_s / (shoulderHeadHalf_s + L_s cosθ_s)`；肩头半宽 0.0356 vs 0.0311m，数值解约 `θ_t ≈ 0.8·θ_s`（20°→16°）。
  - **建议 A/B 两档 k=0.71 / 0.80**（逐 clip 可调），默认取 0.75 起步；sleep 躺姿、windowLay 侧躺单独 A/B。
- 保持手臂世界朝向：`S' = slerp(I, S, k)`、`A' = S'⁻¹ · S · A`（R3 恒等式，实测手臂 world 变化 0.00°；见 §4.3 sim-s2 数据）。
- **S4' 必须同批**：锁骨折叠会把 socket 抬回 2–3cm，手位随之移动；用比例感知 hand-target IK 把腕放回源归一化位置（保留手/手指旋转）。
- 验收：肩点相对 chest 的**归一化高度**与源 Zome 同帧差 ≤5%；肩线视觉斜率差 ≤5°；手臂 world 朝向变化 ≤1°（除 S4' IK 明确修正的部分）；手到源归一化位置 ≤2cm；对照**官方展示视频截帧**目视无明显溜肩/肩袖塌陷；保留可爱手势。
- **白名单**：idle/idle2/idle4/idle5/idle6/idle7、sit1/sit2/suwari3、sitWindow/windowLay8/9/10、hideLeft/hideOnce、happy/laughing/shyPoint/pose*（按 clip 单独 A/B）；`walk/walkAlt` 已验收暂不动；`sleep`/`drag` 单独处理（躺/拖拽语义）。

- 公式（R3，复核通过）：
  - 每 clip 常数 `k = min(1, cap / p95(θ_shoulder))`；`θ` 用该 clip Shoulder 局部旋转角统计；
  - `S' = slerp(I, S, k)`；`A' = S'⁻¹ · S · A` → 恒等式 `C · S' · A' = C · S · A`（手臂 world 朝向逐帧不变，实测 1e-16）；
  - 肩窝 `p' = p_clav + C·(S'·v_clav)`，`Δy ≈ 0.1234·(sinθ−sin(kθ))`（抬回 3–4cm）。
- 初值（白名单）：站立 idle 族 cap 8°；坐/窗 cap 10°；`sleep` 15° 或跳过；`dragFemale` 不动；**walk/walkAlt 不动**。
- 白名单建议：`idle, idle2, idle4, idle5, idle6, idle7, sit1, sit2, suwari3, sitWindow, windowLay8, windowLay9, windowLay10, hideLeft, hideOnce`（A/B 后逐 clip 决定）。
- **本轮已在当前 app 语义（three-vrm normalized 骨）下模拟验证**（`tests/tmp/lead-shoulder/sim-s2.test.ts`，结果 `sim-s2-out.json`）：

| clip | 锁骨 p95 角 | k | **手臂 world 朝向变化** | **肘 world 变化** | **肩窝抬升** | 手位移 |
|---|---:|---:|---:|---:|---:|---:|
| idle | 27.9° | 0.287 | 0.00° | 0.00° | +3.4cm | 4.1cm |
| idle6 | 29.4° | 0.273 | 0.00° | 0.00° | +2.2cm | 2.6cm |
| sit1 | 26.0° | 0.385 | 0.00° | 0.00° | +2.7cm | 3.0cm |
| sit2 | 27.5° | 0.363 | 0.00° | 0.00° | +2.5cm | 2.7cm |
| windowLay8 | 30.7° | 0.326 | 0.00° | 0.00° | +3.2cm | 3.5cm |
| windowLay10 | 26.4° | 0.379 | 0.00° | 0.00° | +2.9cm | 3.2cm |
| walk/walkAlt | 9.0° | 0.887 | 0.00° | 0.00° | +0.06cm | 0.2cm |

  → 恒等式成立；白名单里「锁骨头大」的 clip 抬 2–3.4cm，walk 几乎不动（不会带坏已验收动作）。**idle2/4/5 因锁骨 p95 角较小，抬升≈0（-0.2~-0.7cm），可跳过或单独 k**。
- 验收：手臂 world 朝向误差 <0.01°；socket 相对 chest 0.118–0.127；锁骨局部角 ≤10°；肘屈不变；loopSeam 不增；脚指标不变（该层不碰腿/hips）。
- 风险：肩窝抬升 → 手整体上移/内收 2.5–4cm，接触类（手放腿/窗沿/胸）会脱手 → **必须配 S4'**；sleep 躺姿锁骨语义不同，建议观察或跳过。

### 4.3 S4' 比例感知 hand-target 重定向（P2，3–5 天；与 S2 同批）

> 由 R1 提出（同构于 BOOTH「VRM Motion Fixer」与 VmdSizing 的比例适配思路），比单纯「把 S2 前腕位置钉回去」更适合 sit/sleep/hide：女体手要放在**脸/膝/腰/窗沿**等地标上，而男体臂短 16%、肩点低 → 直接保留原世界位置会悬空/穿模。

- 步骤（bake 内，只改手臂链，不动脚/hips）：
  1. 从源 clip 求每帧源手/肘世界位置，表达在源躯干坐标（hips→chest→neck 的坐标 + 躯干长比例）；
  2. 按**目标/源躯干长比例**映射到男体 chest/hips 局部系（手到脸/腰/膝等地标按同一比例映射）；
  3. 目标臂长 0.443m，clamp 到 **98% reach**；不可达时缩短目标而不是拉直手臂；
  4. 两骨 IK 解 upperArm/lowerArm；**肘 pole 取源肘平面**（防翻转）；容差 1cm，肘限 [10°,150°]；
  5. 体前闭拢动作加宽 1.2–1.5×（防手臂贴胸/穿模）；头部球 margin 3–5cm；腰部碰撞筒；
  6. 保留手/手指的源旋转（或按目标手部姿态微调），输出新 clip；原始 clip 归档回滚。
- 适用：sit1/sit2/suwari3/sitWindow/windowLay8/9/10/hide*（手有接触/地标语义）；**不适用** idle 族（改用 S3）与手势类（happy/laughing/shyPoint，语义本身是女性化手势）。
- 验收：手到目标地标 ≤2–3cm；手-躯干 ≥0.16m；无穿模/反关节；手指方向不突变（逐帧角速度门限）；loopSeam 不增；脚指标不变。
- 复用：两骨 IK 纯函数可从 `foot-lock.ts` 的数学部分抽到 `scripts/unity-bake/lib/`（不 import 运行时 three 模块），或在新脚本自写（约 100–150 行）。

### 4.4 S3 手臂层嫁接 —— **已否决（2026-11-11 用户决策）**

- 原因：用户明确「语义无所谓，可可爱爱的砂金总监也有卖萌的自由，不能刻板印象」；把女体 idle 手臂换成 adv/HUS 男性手臂属于「去女性化」，不做。
- 保留：若将来想增加 **中性/多样性** 动作可以在 app-manifest 层加候选，但**不以「修正」名义替换**。

### 4.5 S5 幅度阻尼 —— **降级为「只在有技术性副作用时」可选项**

- 用户要求保留可爱摆胯/姿态，**不因「男性参考幅度」而阻尼**。
- 仅当某个 clip 的摆胯/位移造成**真实问题**（穿模、脚滑、窗沿掉落、与道具冲突）时，才对该 clip 做最小幅度修正；优先修根因（接触/碰撞），不是整体阻尼。
- 验收：若做，只按技术指标（穿模、接触）判，不按「像不像男性」。

### 4.6 S0（验证部分已完成）：目标 avatar GT / 可选重烘

> **§2.6 已完成「Unity GT on 男体目标」只读对拍**（免费、无采购；Unity Personal 授权有效）。结论：fold 后 app≈Unity 官方重定向（1–3.3° 残余），**不再需要为了「修肩」而重烘**。下面保留「重烘」仅作为可选实验（若以后想要 100% 匹配 Unity 官方结果/消除全局常量 0.5–4.2°）。

- 与 §4.1b 同一套 Unity GT 能力，但多走一步：把真实男体 Avatar 上采到的 raw local/world 旋转**反算成 normalized**（`Q = P · q_local · R⁻¹ · P⁻¹`，`P` = 父骨 rest world rot、`R` = 本骨 rest local rot），直接生成 `mate-male-tuned/`。
- 收益：把 C3（肩/上胸 10–15° 保真度差）一次消掉，并顺带消除合成骨架 muscle 限位差；可作为 S2 的对照/替代。风险：Unity license/工程写权限（本轮被沙箱拒绝：project read-only）、转换链路需复核；1–1.5 人日。
- 建议：先把 §4.1b 只读 GT 对拍跑通（P1）；若 GT 显示肩/胸仍有 >5° 差，再上 S0 重烘；否则 S1+S2 已够。

### 4.7 资产替换：R2 调研结论 + 用户「不花钱」决策

**用户决策（2026-11-11）**：拒绝任何花钱方案；注册账号可以。→ 以下按「免费/本地/可注册」重排，付费项明确 **REJECTED**。

- Mate-Engine 男体动作全集 = 15 个 HUS：HUS_IDLE01–09、HUS_DRAG、HUS_DANCE_01–04，外加 **controller 里完全没接线的 `HUS_SITTING`**（10.87s 循环，**.anim 曲线实测：根高 0.265m、髋屈 −0.919、躯干后仰、双臂后展 → 地面坐姿**，不是窗沿坐；半成品，必须烘出目视）。**免费、本地**，可用。
- 官方 2.4.0/仓库文案确认 Husbando Mode 只换 idle+drag+dance、**"does not affect sitting animations"、headpats disabled**；X3.4 至今没补男性 sit/sleep/hide。→ 不要等官方。
- **HSR `adv`（砂金官方 138 个 .max，本地已重定向）**：free、本地；含大量反应/手势动作（scratchHead01/holdhead01/covermouth01/shrug01/think01/alert01loop/talk01/02/akimbo01loop/snap01loop/lookAtPhone/useHeadphone01loop…）。按用户「语义无所谓」决策，**不作为「去掉女性化」的替换**；仅作为**动作多样性/新状态**的免费候选（需语义 A/B）。
- **免费/可注册的缺失姿势来源（只列免费）**：
  - `HUS_SITTING`（本地，地面坐）——唯一现成男坐。
  - **CMU MoCap**（mocap.cs.cmu.edu，免费可商用、禁转售数据；sit/stand/lie trial 有，#13/#14/#75/#82/#86/#143）——需注册/下载，无手指。
  - **Rokoko 免费库**（免费，需邮箱注册；263 资产，坐/躺覆盖未确认）。
  - **BOOTH 免费动作/姿势**（需 pixiv 注册；免费项的规约需逐条读；**付费项一律不买**）。
  - **BowlRoll / NicoNico 免费 VMD**（需注册；多为蹲坐/舞蹈，长循环睡姿没有）。
  - **vrma-lab**（开源，FBX→VRMA，本地）、**VmdSizing**（免费 MMD 跨模型比例适配）、**Blender Retarget 扩展**（免费）——格式/工具链备选。
  - **Mixamo**（免费但官方 FAQ：中国大陆区账号不可用 → 放弃，不算采购）。
- **REJECTED（用户拒绝付费）**：MotionPackage #74（¥2,000）、Sway Motion（¥1,650）、TOEI #71（¥2,200）、3DTexel（付费）、VRM Motion Fixer（BOOTH 付费，若收费）、AnyHumanMotionConverter 正式版（¥1,000；若期间限定免费可用则可用）等。
- **负结论不变**：无 Mate-Engine 全动作男体 mod；无现成免费男 windowSit/windowLay/sleep/hide；程序化从站姿生成坐姿不现实；HSR 官方可复用包无 sit/lie/sleep。
- R2 纠正：wave15 文档的 timeScale 数字（PET_IDLE 0.4/HUS 0.65）在当前 refs 快照不成立（V2 controller 32/34 个 speed=1，仅 Sleeping 0.6）→ 不要沿用旧数字。

### 4.8 资产替换建议（v3：只保留免费/不改变可爱语义的选项）

| # | 替换/补充 | 覆盖 | 方式 | 成本 | 风险 |
|---|---|---|---|---|---|
| A2 | 地面 sit → `HUS_SITTING` | 标准地面 sit（`sit1/sit2/suwari3` 的可选替代） | 现有 Unity 烘焙管线烘 VRMA + 接地/IK + 目视 | 免费 + 0.5–1 人日 | 孤儿资产质量未知；只地面坐；不影响窗沿 |
| A4 | sleep/lie 免费源 | 缺失男版时用 | CMU（免费可商用禁转售）/Rokoko 免费库（注册）/BOOTH 免费 | 免费 + 3–5 人日 | 写实风格/无手指/需过渡；没有就维持女体睡姿（可爱也 OK） |
| A5 | 动作多样性（非替换） | 反应/pose 池 | app-manifest 增补本地 HSR adv 动作（不删女体可爱动作） | 免费 + 0.5 人日 | 仅多样性，不做「去女性化」 |

**推荐组合（v3）**：**P0 α-fold 修完 → 视觉 A/B 让用户验收可爱姿势（默认全部保留）→ 若用户对某姿势仍觉得「畸变」再针对性修（S2 小范围/蒙皮/S4'）→ 若想补缺失姿势，用 A2/A4 免费源（注册即可），不做任何付费采购。** S3/S5/A1 已否决。

## 5. 对 subagent 调研的复核（R1/R2/R3 均已回）

### 5.1 R3（肩部/风格化）——结论复核通过的部分

| R3 结论 | 本轮独立复核 | 结论 |
|---|---|---|
| 女体锁骨 17–38° 下压+后缩（男参照 2–7°） | 本 audit：mate idle Shoulder jointRel 27.0°、sit1 25.5°、windowLay10 22.4°；adv-idle 2.1°；world 分解下压 21.9°/后缩 16.4° | ✅ 一致 |
| 肩窝下坠 4.3–4.5cm | 本 audit socket 相对 chest：idle 6.58cm vs rest 12.63cm（−6.0cm）、sit1 7.05cm；R3 idle 8.25cm（−4.4cm），差异来自采样帧/定义（相对于 chest 位置随胸旋转），量级一致 | ✅ 方向/量级一致 |
| UpperChest 被丢（10/30 clip，max 23.7°） | 独立复算 clip JSON：一致（见 §2.1 表） | ✅ |
| 手臂世界朝向正确（是 socket 位置错） | 本轮 probe：同一 normalized 序列在合成骨架与男体上 upperArm 骨段方向差 **0.00°**；仅锁骨 4.04° | ✅ |
| S2 恒等式保手臂朝向 | 数学上成立（`C·S'·A' = C·S·A`），实现需注意「A' 写回的归一化局部空间与父级坐标系一致」；验证法：逐帧比 arm world quat，误差应 ≈0 | ✅（实现注意项） |
| S1 upperChest 折叠等价 | 与 GT 对拍相关性一致（UpperChest 越大 Chest fidelity 差越大）；建议实现后用「虚拟 upperChest 链」对拍 0 误差 | ✅（需实现验证） |
| sleep/dragFemale 特殊处理、walk 不动 | 与 wave15/已验收数据一致 | ✅ |

### 5.2 R3 需要注意/修正的部分

1. **S2 的「手整体上移 3–4cm」后果**：R3 已提出 S4' 重钉，但要明确 **S2 单独不能上线**（会把坐姿手从腿上抬起来）；本轮方案把 P1/P2 绑定验收。
2. **sleep 的锁骨语义**：躺姿下锁骨旋转 28.5°（max 65°）可能包含支撑/贴床的意图，直接按 k=0.3 压会破坏躺姿；建议 sleep 先跳过或单独 A/B（R3 也建议）。
3. **C3（合成骨架 vs 真实 avatar 的肩/胸保真度差 10–15°）R3 未覆盖**：本轮 GT 对拍给出；S2 会 clamp 掉一部分，但建议把 S0（目标 avatar 重烘）列为验证路径，否则「修完仍差 10°」可能被用户当成没修好。
4. **HUS_SITTING 未在 R3 调研范围**：R2 正在查；若可用，sit 槽位可优先换男性源而不是修女体动作（成本更低、语汇更对）。

### 5.3 R2（男性动作源）——复核

| R2 结论 | 本轮复核 | 结论 |
|---|---|---|
| HUS_SITTING 存在但未接线、地面坐 | 本地 `refs/.../HUS_SITTING.anim` 存在（10.87s、m_StopTime 10.8667、130 曲线）；`u3-precheck` 旧清单确实未选它；R2 的 muscle 解析结论（根高 0.265/髋屈 −0.919）与 `.anim` 数据特征一致【未渲染目视】 | ✅ 事实成立；**必须烘出目视再决定能不能用** |
| Mate-Engine 官方无男坐/睡/躲 | R2 引用官方 2.4.0 patch notes + 仓库文案；与历史 wave15 结论（HUS 仅 idle/drag/dance）一致 | ✅ |
| adv 库可替换反应动作 | 本地 `assets/motions/adv` 确有 scratchHead01/holdhead01/covermouth01/shrug01/think01/alert01loop/talk01 等（app-manifest 已用 think01/scratchHead01/worry01） | ✅（映射与语义需 A/B） |
| 采购源/许可 | 未逐条核验 BOOTH 条款原文（R2 引用页面快照）；采购前必须用户亲自读许可 | ⚠️ 待用户决定 |
| wave15 timeScale 数字不成立 | 与仓库当前 controller 快照一致（R2 实测 V2 controller 32/34 个 m_Speed=1、Sleeping 0.6）；旧文档数字可能来自旧版 | ✅ 提醒后续不要沿用 |

### 5.4 R1（VRM normalized/跨体型重定向）——复核

| R1 结论 | 本轮独立复核 | 结论 |
|---|---|---|
| 本模型 53/53 humanoid、375/375 节点 rest rotation = identity；上臂方向 0.00° 是必然 | 直接解析 `aventurine-tpose.vrm` GLB：375 节点、非 identity 旋转 **0** 个 | ✅ 一致 |
| upperChest 被丢 = neck/shoulder/head counter-rotate |U|（不是「少转」） | 公式推导正确（误差 `q_N⁻¹Uq_N`，角 = |U|）；10 条非单位 clip 独立复算一致 | ✅ |
| 官方修法：目标少骨时把 U 乘到 neck/leftShoulder/rightShoulder | 抓 VRMA spec 原文核对：确有 “When the target model has few bones … neck, leftShoulder, and rightShoulder … transformed by both the rotation of upperChest and the rotation of the bone itself by multiplying the two” | ✅；α-fold 是其连续化（恒等式成立） |
| 肩点高 chest 0.126 vs 0.220m（57%）、臂长 0.443 vs 0.530m（84%）、抬臂手位偏差 10–18cm | 与本轮 rest-audit 一致（upperArm rel chest 12.63cm vs 22cm；upperArm+forearm 44.34 vs 53cm） | ✅ 一致 |
| α-fold 公式（任意 α 精确恢复 neck/shoulder/head 世界朝向） | 在真实管线模拟：当前误差 = |U|（laughing 最大 23.16°、idle4 15.47°、sleep 14.28°）；α-fold α=0/0.5/1 误差全部 **0.00°**（`sim-fold.test.ts`/`sim-fold-out.json`） | ✅ 一致（精确） |
| HSR/ADV 的 UpperChest 全部 identity | 我逐条扫 `assets/motions/{hsr,adv}/*.json`：非 identity 的 **0 条** | ✅ 一致 |
| 4.04° 锁骨 rest 差不是主因 | 与我的 rest 审计一致（3.84°，≈0.9cm）；但注意这与「**动画里**锁骨旋转 17–38°」是两回事（§2.2） | ✅ 不矛盾，需分开表述 |
| 「男女体型差距」部分解释非充分解释 | 与本轮结论一致（C1/C4/C5 叠加） | ✅ |
| R1 提到「Zome vs 男体同时变体型+upperChest 两变量」 | **对我方 GT 数据保真度对拍不适用**：那组对拍是「Unity GT on Zome vs 我们的数据在 **Zome** 回放」（同一模型），只测数据保真；R1 的提醒只适用于「Zome 视觉 vs 男体视觉」这种跨模型归因 | 口径澄清 |
| 推荐顺序：α-fold → 男体目标 GT → 比例感知 hand-target → 锁骨限位 → 蒙皮 | 本轮采纳并调整 §4/§7 顺序 | ✅ 已并入 |

**R1 补充提醒（已并入方案）**：① Unity muscle space 是肩/胸保真度差的二级因素（合成骨架默认限位 vs 真实 avatar），修法优先目标 avatar 重烘（S0'）；② Blender Retarget 可作离线备选，但引入第二工具链；③ Unreal Speed Planting 只治脚滑不治肩。

### 5.5 R3 明确不可行项（复核认同）

- 神经风格迁移无 checkpoint（1–3 月）→ 不采用。
- Unity Animation Rigging 双向运动转移不支持 Humanoid → 不采用。
- 骨骼 scale/缩短锁骨/大幅降骨盆 → VRM 通道不允许/毁 IK → 不采用。
- 全局一套 offset → 会带坏已验收 walk/手势 → 不采用（逐 clip 白名单）。

---

## 6. 验收指标与回归闸门（冻结建议）

**离线指标（bake 后逐 clip 跑，脚本化）**：

| 指标 | 目标 | 来源 |
|---|---|---|
| UpperChest 折叠后子骨 world 误差 | =0（对虚拟 upperChest 链） | 新单测 |
| 手臂 world 朝向变化（S2 前后） | <0.01° | R3 恒等式 |
| **Unity-on-男体 GT 对拍（§2.6）**：fold 后全局/逐骨世界旋转差 | ≤3.5°（目标；当前 fold 前 4–10°） | gt-app-compare.test.ts |
| UpperChest α-fold 恒等式 | neck/shoulder/head world 误差 = 0（任意 α） | 新单测 + sim-fold |
| 手位（相对 Unity-on-男体，fold 后） | ≤3cm（现状 1–2.8cm），不做硬性男性化目标 | §2.6 |
| **真实畸变（蒙皮）**：袖口/肩部边拉伸率 | max <1.3（按资产标定）；只在「肉眼可见拉伸」时作为修复触发条件 | 蒙皮/权重热图 |
| loopSeam | 不高于原 clip +5° | 既有 validate-clips 指标 |
| 脚像素漂移（实机） | 不引入脚滑（与腿部会话同判据） | 既有 dev-capture |
| Chest/Shoulder GT fidelity（若跑 S0） | ≤2° / ≤3° | gt-joint-compare.py |
| **E_rot**（男体目标 GT vs 回放） | neck/左右 shoulder/head/upperArm **<1°**（修前 affected clip ≈|U| 可达 24°） | §4.1b Unity GT |
| **E_ua**（肩点位置） | ≤2% torso（≈1cm）；rest 0.126 vs 0.22 是已知差 | §4.1b |
| **E_hand**（手位） | 到手部地标/GT ≤2–3cm；不穿胸/脸 | §4.1b + S4' |
| 肩线角（shoulder→upperArm 与水平） | 与 GT 差 ≤3°；4° rest 差可接受 | 骨骼叠加/截图量角 |
| 袖口拉伸率（LBS 边长比） | max <1.3（按资产标定） | 蒙皮/权重热图 |
| A-pose 回归（手臂下垂 idle） | 与当前差 ≤3° | 同相机 A/B |

**视觉 A/B**：同一相机、同帧、同分辨率，每 clip 4 帧/2 循环；三张并排：源（Zome/Unity GT）| 男体当前 | 男体修复；再加**骨骼叠加**（只画骨不画 mesh）与**权重热图**，把「朝向错 / 位置错 / 蒙皮错」分开。**不做**「只跑数值就切 manifest」。

**R1 建议的 controlled A/B（用于归因，实施前先做）**：
- A 只变 upperChest：同男体同 clip，α=0/0.5/1 vs 当前跳过 → 若 sleep/laughing/idle 改善、sit/hide 不变 ⇒ C1 证实（sit/hide 的 U=0，天然对照）。
- B 只变抬臂角度：同男体，arms-down idle vs arms-up sit/sleep/hide → 只有抬臂坏 ⇒ C4 证实/量化。
- C 只变体型：同拓扑、不同肩点/臂长的 target（或同模型缩放肩/臂）→ 差异随肩点/臂长单调 ⇒ C4 证实。
- D 只变 mesh：骨骼叠加 vs 画 mesh → 骨骼对齐但 mesh 拉伸 ⇒ C5/蒙皮。

**回归**：`pnpm test` + `pnpm typecheck`（实现后）；manifest/校验脚本 `node scripts/vrm/motion/build-app-manifest.mjs --check`；dev-capture 实机（隔离 profile）复看 3 类 clip：idle 轮换、sit 轮换、DSH 反应。

---

## 7. 实施顺序、文件作用域与并发冲突

| 阶段 | 内容 | 触达文件 | 与腿部会话冲突 | 估时 |
|---|---|---|---|---|
| P0 | S1 α-fold（α=1）+ 单测 + clip-viewer 同步 + **贴地测量路径也折叠** | `src/renderer/src/vrm/{upper-chest-fold.ts(新),clip-player.ts}`、`scripts/unity-bake/clip-viewer.js`、`tests/vrm-upper-chest-fold.test.ts` | 低（腿部会话已提交，clip-player 无冲突） | ✅ 已实现（Lead 复核中，待 commit） |
| P0b | 视觉 A/B：fold 前后 `sleep/laughing/idle4/idle2` + 坐姿 `sit1/windowLay8`；用户验收「可爱姿势是否 OK」 | dev-capture / preview-clips（只读输出 tests/tmp） | 低 | 0.5 天 |
| P1 | **男体目标 Unity GT 对拍（已完成 §2.6）** + 可选每 clip 全局 hips 常量补偿 | `tests/tmp/lead-shoulder/gt-male/**`；数据侧 bake 脚本（若做补偿） | 低 | GT 已完成；补偿 0.5–1 天 |
| P1-v4 | **比例感知肩/臂重定向（S2+S4' 的 source-intent 版）**：以源 Zome 视觉姿态为目标，解锁骨（肩点位置）+ 两骨 IK（腕位置），保留手/手指旋转；输出 `mate-proportion-tuned/` + A/B + 指标 | 新增 `scripts/unity-bake/proportion-retarget.mjs` / `lib/proportion-retarget.mjs` + `tests/unity-bake-proportion-retarget.test.ts` + 新 clips 目录（gitignore） | 低（新文件；不改运行时） | 进行中（Lead 已派 subagent） |
| P1-evid | **官方展示视频取证**（Steam trailer/B站）：确认原版女体（Zome）坐/躺/idle 的肩线观感，作为可目视验收的 reference | 只读下载/抽帧 → `/tmp/mate-source-evidence/**`；不放仓库 | 无 | 进行中（Lead 已派 subagent；Steam trailer 已下载 1280x720、2:56，sit-on-apps 段已抽帧） |
| P2 | 仅按需：真实畸变修复（袖型权重/穿模/极端帧） | 视问题选择：VRM 权重 / 数据侧 | 低 | 视 A/B 结果 |
| — | ~~S3 手臂层嫁接~~ / ~~S5 幅度阻尼~~ / A1 男性反应替换 | — | — | **已否决（用户 2026-11-11）** |

> **硬性顺序更新（2026-11-11 14:32）**：`修复桌宠腿部异常弯曲` 会话**已提交**（`2b9340a fix(anim): foot-lock 3D 距离保持解…`、`fb21e61 feat(tools): 静态站立 clip 膝拉直 bake 脚本…`，含修复报告），可以开始本方案 P0。当前共享工作区另有 DSH 桥/其他会话的改动（与本方案文件不重叠）。
> **并发风险**：P0 只碰 `clip-player.ts` + 新增文件 + preview viewer，不改 foot-lock/micro-motion/animator/资产，冲突面小；若发现 `clip-player.ts` 已被其他会话改到，先 rebase 再合。
> **不碰**：`foot-lock.ts`、`micro-motion.ts`、`animator.ts`、`src/renderer/src/core/**`（腿/行为层）、`walk/walkAlt` 数据。

---

## 8. 决策状态

**已由用户拍板（2026-11-11）**：
1. **拒绝一切付费方案**、注册账号可以 → 只走免费/本地/可注册来源（§4.7/§4.8）；付费工具/动作包全部 REJECTED。
2. **语义无所谓/不要刻板印象** → 保留女体可爱动作与手势；**取消 S3（男性化手臂层）与 A1（男反应替换）**；S5 幅度阻尼只在技术性副作用时用。
3. **Unity GT 可以跑**（免费本地；本会话已用 danger-full-access 跑完 30 clip，§2.6）。

**用户 2026-11-11 15:01 追加指令（v4）**：① 不能只看男体结果，要拿 **Mate-Engine 官方展示视频（B站/Steam）**里原版女体的效果当基准；② 「溜肩」很可能是**女体肩相对较短的体型 bug**，不是设计；之前列出的修复点也可能是比例差导致的真实 bug；③ **继续派 subagent 执行原本修复计划**（S2+S4' 等）。→ 已照做：几何验证见 §0.2；比例感知重定向实现中（§7 P1-v4）；官方视频取证中（§7 P1-evid）。

**仍待用户/Lead 定的（实现相关）**：
4. **α 值**：默认 1.0（= Unity on 男体行为）；若视觉 A/B 觉得 chest 转动过多可试 0.5（只是 chest 网格分配，neck/肩/头 world 不受影响）。
5. **P0 视觉验收**：fold 后 `sleep/laughing/idle4/idle2` + `sit1/windowLay8` 是否「好看/可爱」；用户愿抽 3–5 分钟看 A/B。
6. 若用户仍觉得某坐/躺姿势「溜肩/畸变」：是否要做**小范围真实畸变修复**（S2 小幅锁骨 + 袖型权重 + S4' 手部地标）；若觉得可爱就保留则不做。
7. 缺失姿势（窗沿坐/躺/睡）是否要补免费源（HUS_SITTING 地面坐 / CMU / Rokoko / BOOTH 免费）；用户接受「用免费源+注册」即可，不需要付费。

---

## 9. 证据与引用

- 本轮审计：`tests/tmp/lead-shoulder/{audit-out.json, rest-mismatch.json, gt-joint-compare.json, sim-s2-out.json, sim-fold-out.json}`；渲染：`tests/tmp/lead-shoulder/all-mate/**`（30 clip 接触表）；实机：`app-sit/`（`mate-sit1` 复现溜肩）。
- 方案验证脚本：`tests/tmp/lead-shoulder/{sim-s2.test.ts（锁骨预算转移）, sim-fold.test.ts（α-fold 精确性）}`。
- R3 报告（外包调研）：`/tmp/research-r3/R3-report.md`；本地复现脚本 `/tmp/research-r3/replay.py`。
- R1 报告：`/tmp/research-r1/report-r1.md`（VRMA spec/three-vrm/Unity/Unreal/Houdini/VRM Motion Fixer/3dretarget 链接与公式）。
- R2 报告：`/tmp/research-r2/REPORT.md`（HUS 清单/官方 2.4.0 文案/采购源/许可）。
- 项目既有：`docs/research/wave15-male-motion-tune.md`（女体→男体微调可行性）、`tests/tmp/wave15/groundtruth/REPORT.md`（Unity GT 对拍方法与数据）、`docs/known-issues.md`（腿/脚既有接受项）、`docs/vrm-motion-hsr.md`（归一化语义）、`docs/research/startup-pose-flash.md`（normalized 回放语义）。
- 关键外部参考（R3 复核）：UE IK Retargeter / Retarget Operation Stack / Speed Planting（官方）、Houdini KineFX「Fixing sloped shoulders」（官方，锁骨限位=溜肩修法）、Epic 论坛 MetaHuman 溜肩帖、UNAmedia Mixamo→UE 重定向改进、日本 MMD 社区「女性モーションを男性モデルに」经验（锁骨塌陷与把角度还给上臂）、VmdSizing、Blender Retarget 扩展、MediBang 男女骨骼差异。

---

## 10. 外包调研状态（全部完成并复核）

- **R3（肩部/风格化修正）**：✅ `+ /tmp/research-r3/R3-report.md`；结论已并入 §2.2/§4.2/§5.1–5.2，关键数字用本轮 audit 复算一致。
- **R2（男性动作源 / Mate-Engine HUS 清单）**：✅ `/tmp/research-r2/REPORT.md`（+ `hus-curves.json` / `mate-anims.json` / `news.json`）；并入 §4.7/§4.8/§5.3。
- **R1（VRM normalized 语义 / 跨体型重定向逐关节机制）**：✅ `/tmp/research-r1/report-r1.md`；并入 §2.1/§2.3/§2.4/§3/§4.1/§4.1b/§4.3/§5.4——新增：α-fold 连续旋钮（规范原文已核）、normalized 只保朝向不保位置、肩点 57%/臂长 84%/抬臂手位偏差 10–18cm、目标 avatar GT 对拍作为 P1、比例感知 hand-target 重定向。
- **复核方式**：R1 的 375/375 rest identity、HSR/ADV upperChest=identity、10 条非单位 clip 清单、VRMA 规范原文均由本轮独立复算/抓原文核对；R1 的「Zome vs 男体两变量」提醒只适用于跨模型视觉归因，不适用于我方同模型（Zome↔Zome）的数据保真度对拍。
- **新增（2026-11-11 14:38）**：**Unity GT on 男体目标**已跑通（30 clip，`/tmp`…不对，`tests/tmp/lead-shoulder/gt-male/out/unity/**`；Unity Personal 免费授权），并完成 current app vs Unity 官方重定向的逐关节对比（`gt-app-compare.test.ts`）：**fold 后残余 1–3.3°、逐关节残余 ≤1°、手位差 1–2.8cm** → 结论：管线本身没有需要「逐关节大修」的问题，剩余观感来自源姿势意图+比例+蒙皮；按用户决策不搞男性化，只做 P0 bug 修复 + 按需真实畸变修正。
- **P0 实现**：✅ 已实现、复核、全量测试通过并提交（`83d4d6c`）；Lead 额外把同一 fold 应用到 `applyClipPoseDirect`（贴地/步幅测量），避免显示姿势与 grounding 常量不一致；app 实机 sleep 冒烟通过。P0b 视觉 A/B 已出图（`tests/tmp/lead-shoulder/evidence/fold-ab-zoom.png`），待用户目视确认可爱姿势。
- 本文件其余结论均来自本地实测（`tests/tmp/lead-shoulder/**`）。
