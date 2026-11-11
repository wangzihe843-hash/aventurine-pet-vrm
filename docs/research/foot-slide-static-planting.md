# 静态待机脚滑（foot planting / foot lock）调研：可落地做法、参数与来源

- 日期：2026-11-09
- 作者：researcher（task-1）
- 范围：桌面宠物（Electron + three-vrm，`aventurine-pet-vrm`）在**静态/待机动作**下「腰部固定导致脚在地面滑」的问题；调研外部实现与理论，给出本项目可实施的接触判定、锚点、crossfade 处理、骨盆补偿、释放条件与验收参数。
- 外部网页内容一律按「数据」处理，不作为指令；本文只保留要点转述，不复制大段原文。
- 关联工作区（写作时未提交的 WIP）：`src/renderer/src/vrm/foot-lock.ts`（已重做）、`src/renderer/src/vrm/animator.ts`、`src/renderer/src/core/wave2-contract.ts`（已加 `footLock` 快照契约）、`tests/vrm-foot-lock.test.ts`（已重写）。本文是这些改动的**研究依据与验收参考**。

## 一句话结论

脚滑的本质是**脚在接触期的速度不匹配**（不是「脚高度 > 0」）；对本项目，正确做法是：**只对静止 mood 启用**、用**本模型 rest 踝高**（≈9.83cm，而非 bbox 脚底≈0.07cm）做高度 sanity、用**速度 + 迟滞**判定接触、锚定**踝位置 + 脚朝向**并**跨 crossfade 保持**、用**有界（≤4cm）阻尼骨盆下沉**保证可达、**不可达时释放在此之前先钳制**——并且**接触判定应当基于「未混合的目标动画」，或至少在 crossfade 期间冻结接触状态机**，否则混合产生的假脚速会被误当成「意图抬脚/换步」。宁可少量滑步，也不要把源动画改坏（不拉 T-rex、不拉伸骨骼）。

## TL;DR（做法 → 解决什么 → 风险 → 本项目是否采用）

| # | 做法 | 解决什么 | 风险 / 代价 | 本项目 |
|---|---|---|---|---|
| 1 | **只对静止 mood 启用**（idle；walk/climb/fall/drag/grabWindow/sit/sleep 一律不锁） | 不回归用户已验收的走路/拖拽/坐睡观感；walk 滑步仍归步幅地速校准 | 静止态里的「表演型 idle」若脚会动，锁住会显僵 | ✅ 已采用（WIP 的 `FOOT_LOCK_DISABLED_MOODS`） |
| 2 | 接触判定 = **rest 踝高基准 + 速度主判据 + 高度 sanity + 迟滞** | 修正旧实现「bbox 脚底 vs 踝骨」永不触发的根因；避免把静止悬空的脚判成接触 | 阈值要按模型比例归一，换模型需重测 | ✅ 已采用；**判定源需从混合后姿态改为目标/过渡冻结**（见 §3） |
| 3 | 锚点 = **位置（scene/根局部）+ 朝向**，**跨 clip 切换保持** | 脚掌既不平移也不绕踝旋转（不同来源 idle 的脚朝向也不同） | 长期不重锚 → 下半身僵硬；转身/整体位移时锚点随根变换 | ✅ 已采用（scene 局部空间 + 可选朝向锚定） |
| 4 | 两骨解析 IK = **对现有姿势的最小修改**（保留当前膝平面，渐伸直时防膝翻） | 不重摆姿势、保留源动画细节 | 近伸直/极向量突变时膝盖弹跳 | ✅ 已采用，建议补「极向量保持/限速」 |
| 5 | **有界骨盆下沉**（本项目 ≤4cm，阻尼 τ≈0.12s；仅垂直） | 保证锚点在腿长内可达，减少硬超伸/无法到点 | 拉低过多 → T-rex / 身材压扁 | ✅ 已采用（4cm ≈ 4.5% 腿长，远小于 rabfulton 的 18% 上限） |
| 6 | **不可达时释放锚点**（允许少量滑步），目标先经 soft clamp | 绝不把腿拉畸形/改坏源动画 | 少量滑步残留 | ✅ 已采用（释放 + 权重淡出） |
| 7 | 锁 **踝/脚掌**（静态平脚）；动态需锁 **toe/ball** 而非 heel | 静态下脚掌刚性、踝锚≈脚掌锚；动态脚掌 roll 时必须锁前掌 | 若未来启用走路/踮脚，踝锚会拖脚尖 | ✅ 静态用踝锚（够用）；⏳ 未来动态改 toe 锚 |
| 8 | **接触判定用未混合目标动画** / 或 fade 期间冻结状态机 | 防止 0.8–1.0s crossfade 的 15–20cm 姿态插值假速度被误判为抬脚/换步 → 提前释放 → 滑回 | 需要 clip-player 暴露目标姿态/接触标注，改动稍大 | ⚠️ **本项尚未落实**（当前 WIP 仍在测混合后姿态；建议见 §3） |
| 9 | 走路/拖拽/坐/睡/空中锁脚 | — | 与已验收行为冲突 | ❌ 不做 |
| 10 | 大幅拉低骨盆 / 拉伸骨骼 / 每帧硬贴地 | — | T-rex、抖动、源动画被破坏 | ❌ 不做 |

---

## 0. 问题定位（本地代码与实测证据）

### 0.1 用户症状与 Lead 复现数据

- idle 动作每 **12–20s** 随机切换一次（`VARIANT_SWITCH_CONFIG.idle.intervalSec`，`clip-player.ts:105–112`），crossfade **0.8–1.0s**、随机起始相位；
- 不同来源 idle clip 的**站姿脚位差 ≈15cm**；切换时脚在地面**滑动 36–49px**（540px 宠物高）。

### 0.2 换算基准（本模型实测，用于把像素/米互换）

默认资产 `aventurine-tpose.vrm`：`heightMeters = 1.734`（`src/shared/vrm-manifest.json:32`，Lead 实测同值）；宠物高 540px
→ **px/m = 540 / 1.734 ≈ 311.4**。由 `tests/vrm-foot-lock.test.ts` 头部的实测 rest 数据：

| 量 | 值（米） | 换算像素（@540px） |
|---|---|---|
| bbox 脚底 y | ≈0.0007 | ≈0.2px |
| **rest 踝骨 y** | **0.0983（9.83cm）** | **≈30.6px** |
| hips rest y | 1.0661 | ≈332px |
| 大腿段长 / 小腿段长 | 0.4358 / 0.4456（合计 L≈0.8814） | 腿长 L ≈ 274px |
| 15cm 站姿差 | 0.15 | **≈46.7px**（与实测 36–49px 吻合） |
| 20cm 站姿差 | 0.20 | ≈62.3px |

结论：**旧实现把「bbox 脚底（≈0）」当作接触基准去比较「踝骨（≈9.83cm）」，需要 ≥9.76cm 的容差才可能触发**；旧值 2cm 意味着永远 false。这也解释了为什么旧单测没抓到：旧假 rig 脚骨 y≈−3cm（hips 0.55 − 0.28 − 0.30），`−3cm ≤ restFeetY(0) + 2cm` 恰好能触发，掩盖了真实模型踝高 9.83cm 时永不触发的缺陷（见 `git show HEAD:src/renderer/src/vrm/foot-lock.ts` 与旧 `tests/vrm-foot-lock.test.ts`）。

### 0.3 滑动的直接来源：crossfade 的逐骨插值

`clip-player.ts` 的 `beginClip()`（1154 起）在切换时快照**上一帧实际写入的混合姿势** `fromBones` / `fromHips`（1186–1191），随后 `applyFrame()`（1227 起）对每根骨做 `from → target` 的 slerp、对 hips 做线性插值（1242、1288–1309），权重为 `smoothstep(elapsed/duration)`（1242）。

因此切换期间**脚的位置是两条源动画站姿的合成轨迹**：两条静态 clip 本身脚速为 0，但混合轨迹在 0.8–1.0s 内把脚移动 15–20cm——平均 **0.15–0.25 m/s**，smoothstep 峰值约为平均的 1.5 倍 → **≈0.23–0.38 m/s**。这不是任何一条源动画的真实运动，是纯合成运动。

### 0.4 idle 变体池：多来源站姿不同

`assets/motions/app-manifest.json` 共 20 条 idle，参与变体轮换（`priority ≥ VARIANT_ROTATION_MIN_PRIORITY = -9`，`clip-player.ts:209`）的是 **10 条**：

- HSR 源 5 条：`hsr-idle`、`hsr-idle2`、`hsr-idleShow`、`hsr-idleShow2`、`hsr-commonIdle`；
- ADV（Bip001）源 5 条：`adv-idle`、`adv-commonIdle`、`adv-think01`、`adv-worry01`、`adv-scratchHead01`。

逐 clip 统计（本次调研脚本读取 JSON）：
- 大多数 idle 的单 clip 内**脚/脚趾旋转几乎恒定**（如 `hsr-idle` 左脚 max dev 1.63°、`adv-idle` 0.19°），`Hips` 位移 p 变化 ≈0 —— 即**单条静态 clip 内部本来不滑**，滑是切换/混合造成的；
- 但 **`hsr-idleShow` / `hsr-idleShow2` 是「表演型 idle」**：脚旋转 8–11°、右趾 8.35°、hips 旋转 31–40°（可能转身/换重心）——若把它们也纳入锁脚，需要抬脚/转身释放条件，否则会与作者意图打架（见 §6）。

---

## 1. 接触判定：为什么用速度而不是纯高度

### 1.1 核心来源：Orange Duck《Inverse Kinematics and Foot Locking》

[theorangeduck.com/page/inverse-kinematics-foot-locking](https://theorangeduck.com/page/inverse-kinematics-foot-locking)（2026-07-30，全文已读）给出的关键结论：

1. **「Foot sliding is about velocity」**：脚滑的本质是**运行时脚的实际速度与源动画脚速度不匹配**；接触期只是这个问题最显眼的时间窗口（因为地面提供了参照）。强行在「接触期约束速度」是工程取舍，不代表腾空期就正确。
2. **纯高度判定不可靠**：作者对比了 toe 的「速度信号」与「高度信号」，指出人走路时脚抬得并不高、接触期高度本身也会上下变化，**高度很难设阈值**；速度信号在接触期明显接近 0，好设阈值。
3. 推荐启发式阈值（人体尺度、高质量动捕数据）：**速度 0.5 → 0.1 m/s**、高度 sanity **0.1m**；并强调**高度仍然是有用的 sanity check**——用于排除「脚静止但被举在空中」这类假接触。
4. 后处理：对二值接触标注做**多数投票 / 中值滤波（5 帧 @60Hz）**去毛刺；再做 **Gaussian 平滑**得到连续权重，方便运行时调阈值/提前或延后接触。
5. 运行时锁定用**惯性化（inertialization）**在「跟随输入动画」与「跟随固定 contact 点」两路之间平滑切换（带 lockDistance/unlockDistance 与 blendTime）；提示「接触标注」最理想是**人工标注**，启发式约能覆盖 90%。

对本项目的推论：
- idle 是静态的，**脚在源动画里的速度本来就≈0**，所以「速度阈值」只需用来区分「静态接触」与「有意的抬脚/换步/转身」（阈值可比人体低很多）；
- **高度 sanity 不能省**：要排除「脚静止但被举在空中」的姿势（例如表演型 idle、未来 pat 动作）；
- 由于我们不需要处理整个步态周期，**最简单稳的做法是「静止 mood 白名单 + 目标 clip 的接触标注/判定」**，而不是每帧对混合后姿态做速度阈值。

### 1.2 工程实现参考：rabfulton/VRM `docs/foot-planting.md`

[github.com/rabfulton/VRM/blob/master/docs/foot-planting.md](https://github.com/rabfulton/VRM/blob/master/docs/foot-planting.md)（全文已读）实现的是**扁平地面、模型空间**的运行时 foot planting（ozz `IKTwoBoneJob`），与本项目场景高度同构，其参数可直接对照：

- **接触获取**：约 **60ms** 的低运动 + 近地面 → 判定接触；**influence 80ms 内升到 1**；目标抬脚/迈步/转身超角/不可达时 **120ms 内释放**。
- **floor plane 来自每个踝的 bind-pose 高度**；clip 进入时用「较低的 target 脚」推断一个有界常量 clip-floor 偏移（允许区间 **−10%…+18% 腿长**）以兼容重定向后略微浮空的 clip；**物理锚定平面保持固定**；之后抬脚高度相对校准后的 clip 地面测量。
- 明确写：**接触分类使用「未混合的目标动画」（unblended target animation）**，因为 transition 引入的运动不能被误当成作者画出来的迈步；**IK 修正施加在「显示的、已混合的」姿态上**；transition 的姿势/速度历史在 **IK 之前**记录（若记录 IK 后的姿态，重启时会把骨盆/腿的修正**重复应用两次**）。
- **骨盆**：小幅下沉让近伸直的腿回到可达范围；**上限 18% 腿长**，且是**临界阻尼响应**（不会随 reach 需求瞬间变化）。
- **膝方向**：取**混合后姿态**的膝方向，接近伸直时保留上一帧的膝平面（避免极向量翻转）。
- **可达性检查**：要考虑「骨盆下沉还在收敛中」的暂时误差；**不能因为暂时不可达就丢弃锚点**（否则脚会反复释放/重获、身体弹跳）；超过「正常容差 + 待应用下沉量」才释放。
- 锚点包括**踝位置 + 踝朝向**，两者一起随 contact influence 淡入淡出（只插值位置而朝向权重仍满值，会在极小权重下仍施加完整膝平面修正）。
- 验证覆盖 30/60/144Hz、抬脚/迈步/跳跃/转身释放、重定向高度校准、可达上限等。

> 注意：这两条来源在「接触判定源」上说法一致且是本项目当前 WIP 的最大缺口（见 §3）。rabfulton 的 18% 腿长上限（本模型 L≈0.881m → **15.9cm ≈ 49.4px**）对 540px 的桌宠**视觉上不可接受**，所以本项目把上限收紧到 4cm 是合理的（≈4.5% 腿长 / 2.3% 身高 / 12.5px）。

### 1.3 Unity / 中文社区侧证

- Unity 官方 `OnAnimatorIK` 文档（[cn current](https://docs.unity3d.com/cn/current/ScriptReference/MonoBehaviour.OnAnimatorIK.html)，已读）：IK 是动画系统求值后的**后处理**，通过 weight 0–1 在「动画驱动」与「IK 驱动」之间混合；常用法就是设置脚 IK goal 位置/旋转并用权重做渐变。
- Unity 官方 Animation Rigging `TwoBoneIKConstraint`（[1.2 文档](https://docs.unity3d.com/Packages/com.unity.animation.rigging@1.2/manual/constraints/TwoBoneIKConstraint.html)，已读）：Root/Mid/Tip + Target + Hint(pole) + **Target Position/Rotation Weight** + **Maintain Target Offset**（保留 Tip 与 Target 的初始位置/旋转偏移）——这正好对应「最小修改 + 位置/朝向分别加权 + 保留原始偏移」的实现要素。
- 团结引擎 `FootPlacement` 节点（[中文手册](https://docs.unity.cn/cn/tuanjiemanual/Manual/AnimGraphAnimationNodeFootPlacement.html)，已读）：把「脚目标位置/旋转」与「腿 IK」拆开；参数表里有 **Lock Foot Enabled / Lock Ground Distance / Unlock Radius / Relock Radius Ratio（0–1，相对 Unlock Radius）**、`SmoothDamp` 平滑、以及「**静止状态下会回正足部位置**（Auto-Correction Internal）」；地面用 raycast。可视为「锁/解锁半径 + 重锁比例 + 静止回正」的成熟参数化模板，与本项目的「进入/退出迟滞」等价。
- 中文 DCC 教程（[博客园《人形动画常见IK的处理》](https://www.cnblogs.com/OwlCat/p/18312604)，全文已读）：从脚上方发 raycast 求地面；**「调整质心位置」只在 idle 开启，奔跑时不建议**（否则快速上楼梯会剧烈抖动）；且调整前先记录脚 IK 原始朝向，再叠加贴地旋转以**保持动画原本的 yaw（外八/内八）**。这为「只静态启用 + 保留朝向」提供了社区侧证。
- Unity 社区排错文（[bugnet: Fix Unity Mecanim Target Matching Foot Slide](https://bugnet.io/blog/fix-unity-mecanim-target-matching-foot-slide)，已读）：症状描述为「idle↔run 过渡时脚在半空滑」；标准修法是开 IK Pass + `OnAnimatorIK` + 由动画曲线给每只脚 0/1 的 planted 权重，让权重在脚 strike 附近 0→1 渐变。其思路仍是「**接触权重来自源数据**」，与本项目应把接触判定建在目标动画上一致。

---

## 2. 锚点：位置 + 朝向；锁 toe/踝 vs heel

### 2.1 为什么位置和朝向都要锚

- 只锚位置：不同 idle clip 的**脚朝向（yaw/pitch）差异**会让脚掌绕踝关节旋转——脚踝不动，但脚尖会在屏幕上「扫」过地面（用户同样会感知为滑动/蹭地）。本项目的 idle 变体来自 HSR/ADV 两套 rig，脚朝向差是现实存在的。
- 只锚朝向不锚位置：回到当前的原始问题。
- rabfulton 的做法是「**model-space ankle anchor + orientation anchor + influence weight**」，并特别指出位置与朝向要一起按权重淡入淡出；本项目 WIP 的 `pinQuaternion` + `anchorOrientation` 选项与此一致。

### 2.2 锁 toe（前掌）而不是 heel——以及本项目为什么可以先锚踝

Orange Duck 的明确结论（§Conclusion）：

- 在移动数据里，**约 90% 的时间与地面接触的是 toe 关节附近的前掌区域**；人其实比我们想象的更前掌落地，而「只有 heel 接触、toe 不接触」的时间占比极小，且 heel-only 接触**几乎不是稳定姿势**；
- 脚掌绕 toe 转动（提踵、放踵）非常常见；**真正需要锁的是 toe**，给 heel 自由度会让结果更自然；把 heel 硬锁会明显变差；
- 因此其 IK 方案是：以 **toe target → 反推 heel target → 两骨 IK 解 heel → 再把脚掌/脚趾朝向 toe target**（必要时做地面高度 clamp）。

本项目边界：
- 本轮**只做静态待机**，双脚平放、脚掌刚性，**锚踝位置 + 锚脚（foot）世界朝向**在数学上等价于锚住整个刚性脚掌（多数 idle 脚趾几乎无动画，个别表演型 clip 例外）——够用，且实现比 toe 链短得多（VRM 有 `leftToes/rightToes` 骨，后续可扩展）。
- 若未来把「走路/踮脚/表演型 idle」也纳入锁脚，必须改成 **toe/ball 锚点**（或至少把脚趾旋转也纳入锚定），否则提踵时锚踝会把脚尖拖走。
- 当前 WIP 已锚踝 + 脚朝向；建议文档化这条边界，避免以后有人把 mood 白名单扩大时踩坑。

### 2.3 锚点空间：world vs pet root/scene 局部

- rabfulton 用「model-space」（模型空间）锚点——随模型整体变换走；对「角色被 root motion 推着走、脚要钉在世界地面」这类需求，锚点语义要仔细定义（模型空间记录 + 骨骼位置换算）。
- 本项目 WIP 用 **`avatar.scene` 局部空间**（`pinPosition` 为 scene-local Vector3、`pinQuaternion` 为 scene-local Quaternion）：模型整体摆放/朝向（`modelRoot` 的旋转/平移在 `avatar.scene` 之上）会带动锚点；**脚不会因为整宠转身/移动而被世界坐标「钉住」造成腿扭**。对桌宠是合理取舍（转身时整只宠转，脚随之转；而不是脚钉原地、身体拧过去）。
- 关键推论：
  - 静止 idle 时 scene 不变，scene-local 锚点 = 世界锚点，满足消滑需求；
  - 走路/拖拽等已禁用，所以不需要「身体移动、脚留原地」；
  - **若将来要支持行走 lock（世界地面固定）或窗口表面移动**，需要重新评估锚点空间，并处理「surface 移动」时整宠平移是否带动锚点（B2 的 `feet` 位移）。
- 若改用世界坐标锚点，必须额外监听：`grounded`/`surfaceId` 变化、整宠平移、`facing` 旋转；否则会拧腿/拉扯。本项目的 scene-local 方案用「禁用列表 + 速度/抬升释放」覆盖了大部分风险，但**surface 变化（窗口移动/掉落）时仍建议直接 reset**。

### 2.4 释放条件清单（研究归纳 + 本项目取值）

| 释放条件 | 依据 | 本项目建议 |
|---|---|---|
| 抬脚（lift 超迟滞） | Orange Duck / rabfulton | 进入 lift ≤3cm；退出 lift >5cm（现有 WIP 值，≈9.4/15.6px） |
| 目标脚速过快（有意换步/转身） | Orange Duck 速度本质 / rabfulton 120ms release | 进入速度 ≤0.25 m/s；保持速度 >0.9 m/s 释放（WIP 值；见 §3 关于混合假速度的风险） |
| 转身超过角度容差 | rabfulton「turns beyond the orientation tolerance」 | 目前靠速度兜底；建议补「锚定脚朝向 vs 目标脚朝向差 >20–30° 持续 >0.15s → 释放」或「body yaw 累计 >15° → 释放」 |
| 不可达 | rabfulton / Orange Duck soft clamp | 超过「腿长 + 允许下沉」→ 释放（WIP 已实现） |
| mood/接地/拖拽变化 | 本项目边界 | `walk/climb/fall/drag/grabWindow/sit/sleep`、`grounded=false`、`dragging=true` 立即 deactivate（WIP 已实现） |
| clip 未就绪/降级 | 启动姿势窗口 | `clipId == null` 时 `reset()`（WIP 已实现） |
| 锚点长期冻结 | 本调研风险（见 §6） | 接受「同一段 idle 会一直锚到下一次状态切换」；释放后自然重锚即可，不必定时重锚 |

---

## 3. crossfade / 过渡：为什么接触判定要用「未混合的目标动画」

### 3.1 来源结论（最直接的证据）

rabfulton 原文（已读）两句就是答案：

> "Contact classification uses the **unblended target animation**, so motion introduced by a transition is not mistaken for an authored walking step. The IK correction is then applied to the displayed, blended pose."
>
> "Transition pose/velocity history is recorded **before IK**."

翻译：接触判定必须看「目标动画」本身；transition 引入的运动不能当作作者画出来的迈步。而 IK 修正作用在「显示的混合姿态」上。另外历史记录要在 IK 前做，避免修正被重复施加。

Orange Duck 也给了同方向的解释：脚滑的第二类成因正是「**对局部关节旋转做插值/混合/修改**时，末端（脚）产生的运动不一定是自然/真实的」——所以判定「接触意图」必须回到源数据，而不是看混合结果。

### 3.2 本项目当前 WIP 的状态与风险

当前 WIP `foot-lock.ts` 的 `updateContact()` 测量的是 **`rig.foot` 在本帧 `clip-player.applyFrame()` 写入混合姿势之后**的 scene-local 位置：抬高 + 水平速度双条件 + 迟滞（3/5cm、0.25/0.9 m/s）。

- 在**稳态**（无 crossfade）时这没问题：混合权重=1，测到的就是目标 clip 的姿势；
- 但在 **0.8–1.0s crossfade 期间**，测到的是「上一条 clip 站姿 → 下一条 clip 站姿」的合成轨迹。代入本项目数字：
  - 15cm / 0.9s ≈ **0.167 m/s** 平均；smoothstep 峰值 ≈ **0.25 m/s**；
  - 20cm / 0.8s ≈ **0.25 m/s** 平均；smoothstep 峰值 ≈ **0.375 m/s**；
  - 即「进入接触」阈值 0.25 m/s 正好压在合成假速度上；若某次变体间距更大、或帧率抖动让单帧速度尖峰，可能在接触尚未建立/已释放后**永远进不了接触**，或在保持期某个尖峰触发释放。
- 更隐蔽的问题是**方向**：接触尚未建立的那一帧（例如启动后、或释放后重新进入），锚点是在混合姿态上取的；如果恰好在 fade 中取锚，会把「中间态脚位」当成锚点，等 fade 结束脚视觉上要往目标站姿走，画面是「先按住再滑」。
- 反之，**如果判定看的是未混合目标**：两条静态 idle 的脚速都是 0、抬升也都在 rest 踝高附近 → 接触稳定保持；fade 的 15cm 合成运动只影响「显示姿态」，由 IK 去抵消 → 视觉上不滑。这正是我们要的。

### 3.3 可落地的两种修法（按代价从低到高）

**方案 A（推荐，改动最小）：crossfade 期间冻结接触状态机**

- animator 已经能在 `clipPlayer.update()` 后拿到 `lastClipSnapshot.fading`（`VrmClipDebugSnapshot` 有 `fading` 字段，`clip-player.ts` 的 `snapshot()` 里已实现）；把它作为 `footLock.update()` 的附加参数（内部字段即可，不必动冻结契约）：
  - `fading === true`：**不执行进入/退出判定**，保持当前 `contact`/`pin`/权重状态；但仍更新 `previousLocal`（否则 fade 结束后第一帧的速度会是「整段站姿差 / dt」的大尖峰，立刻误释放）；
  - `fading === false`：正常判定（此时测到的是目标 clip 的稳态姿态）。
- 同时保证：**pin 与 contact 跨 clip 切换不重置**（WIP 已满足：`pinPosition` 只在释放淡出归零或不可达时清）。
- 注意：启动第一条 clip 是「首帧直接吸附、不走 fade」（`clip-player.ts:1184`），所以不会出现「首个锚点取在 fade 中间」的问题。
- 若希望 fade 期间新变体确实想抬脚（表演型 idle），这段冻结最多延迟一次释放（<1s），可以接受；真正抬脚会在 fade 结束后由稳态 lift/速度判定释放。

**方案 B（更通用、稍大改动）：接触判定改用未混合目标动画**

- 需要 `clip-player` 暴露「目标 clip 的脚接触信息」，两种实现：
  1. **逐帧目标 FK**：在 applyFrame 里对目标 clip 采样后（它本来就要采样每根骨），仅对两条腿做 FK 求目标踝的 scene-local 位置/速度，随 snapshot 暴露（不在动画骨上写，只用于判定）；foot-lock 用目标姿势做进入/退出判定，IK 仍作用在混合姿态上。
  2. **per-clip 接触标注（数据侧，最终形态）**：clip 加载时（或离线管线）对每条 clip 均匀采样 ≤16 帧（`clip-player.ts` 已有同类采样基础设施，`measureClipMinBoneLocalY` / `POSE_GROUND_MAX_SAMPLES`），对每只脚记录「该帧是否接触 / lift / 速度」，生成 `contactRanges` 存到 clip 元数据；运行时按 `timeSec` 查表并插值。这最接近 Orange Duck 的 contact-times 做法，且**没有每帧额外 FK 成本**；缺点是要动 clip 数据生成脚本（`scripts/vrm/motion/**`），本轮可先不做。
- 方案 B 的另一半（无论选 1 还是 2）：**transition 历史记录在 IK 之前**——本项目 `clip-player` 的 `appliedPose` 在 `foot-lock` 之前写入（`clip-player.ts:1273–1277` 写 `appliedPose`，`animator.ts:325–330` 才调 foot-lock），所以这一点**天然满足**；不要为了「记录视觉姿势」把 IK 之后的姿态写回 `appliedPose`，否则会双重修正。

### 3.4 与「首次吸附」的兼容

- `beginClip` 的 `fromBones` 快照是上一帧的混合姿势（**pre-IK**），因此 crossfade 的起点仍是「上一条 clip 的混合姿态」而不是被 IK 修正过的腿——这与 rabfulton 的「history before IK」一致，**保留现状**。
- 但要注意注释语义（`clip-player.ts:1185` 当前写「mid-fade 时也是当前视觉姿势」）：自 foot-lock 生效后，**视觉腿姿 != `appliedPose`**；注释应改为「上一帧 IK 之前的混合姿势」，避免后来者误以为快照含 IK 修正。

---

## 4. 骨盆补偿：有界下沉、阻尼、避免 T-rex

### 4.1 为什么需要（以及为什么只能小）

- 两脚锚定后，若目标动画的 hips 相对锚点把腿拉到超过腿长（L≈0.881m），IK 只能（a）拉直腿/超伸、或（b）把骨盆往下拉、或（c）释放锚点。
- Orange Duck 的「Avoid the dinosaur」非常明确：很多实现在可达性不足时把 hips 拉低，结果膝盖长期弯曲，出现 **T-rex 效果**；真实动画里腿常常"接近但没超过"完全伸直，这也是 foot lock 难的原因。他的取舍是 **限制伸展（soft clamp）**、**宁可让脚滑一点，也不要破坏源动画**——「a little bit of sliding is a lot better than breaking the source animation」。
- rabfulton 的做法：**小幅下沉 + 上限 18% 腿长 + 临界阻尼**，且可达检查要把「下沉还在收敛中」的暂时误差算进去，不能因为暂时不可达就丢锚点。

### 4.2 本项目的数值建议

| 参数 | 建议值 | 理由 |
|---|---|---|
| 最大骨盆下沉 | **0.04 m**（WIP 已用；≈4.5% 腿长 / 2.3% 身高 / 12.5px） | rabfulton 的 18% 腿长（≈15.9cm≈49.4px）在 540px 桌宠上是明显的整个人往下坐，不可取 |
| 下沉平滑 | 一阶平滑 τ≈0.12s（WIP）；等价于临界阻尼的近似 | 避免逐帧跳变；下沉是「借一点 reach」，不是姿态目标 |
| 只垂直、不水平 | 只改 normalized hips 的 y | 水平位移交给脚锚点 + 腿 IK；水平拉 hips 会改变重心，违反最小修改 |
| 施加时机 | clip-player 写 hips 之后、腿 IK 之前；每帧基于刚写回的基准值重新计算（非累积） | 与 `clip-player.ts:1288–1309` 的每帧 hips 写入兼容；WIP 在 `update()` 里对 `this.hips.position.y -= drop` 是非累积的（下一帧被 clip-player 覆盖重写） |
| 超出上限 | **释放锚点**（WIP 已实现：`needed > maxDrop` → release），而不是继续下沉或拉直腿 | 遵循 Orange Duck 取舍 |
| 下沉计入可达检查 | 判断是否释放时用「腿长 + 当前/目标下沉」；避免下沉收敛中误释放 | rabfulton 的「pending drop」 |
| 下沉时接触不丢 | 释放条件不应包含「暂时够不到」；要看「腿长 + 允许下沉」 | 防抖动/弹跳 |

### 4.3 关于「腰固定」的另一半问题

用户描述是「静态动作时**腰部固定**导致脚滑」——严格说腰部固定本身不是 bug：idle 是原地动画，本来 hips 就固定在角色局部；真正的问题是**两条源动画的脚相对腰的位置不同**，切换时被混合。因此本轮不要试图让腰动起来抵消脚（那是另一套 locomotion 方案），而是把脚锚住、让腿 IK 吸收腰/姿态差。骨盆下沉仅作为「可达性保险」，不是主要手段；**主要手段是脚锚点 + IK**。

---

## 5. 可达性钳制与「宁可少量滑步也不改坏源动画」

### 5.1 三层优先级（研究一致结论）

1. **最小修改 IK 解**：保留当前膝平面/脚朝向、只做刚好够的旋转（Orange Duck「IK is a modification, not a replacement」；Unity TwoBoneIK 的 Target Weight / Maintain Offset 同思想）；
2. **目标 soft clamp**：目标超腿长时，先沿「hip→target」方向把目标平滑收进可达球（Orange Duck 的 `maxExtension` + `softening`：指数饱和而不是硬 clamp），再做 IK；
3. **有界骨盆下沉**兜底 reach；
4. 仍不可达 → **释放锚点，跟随动画**（允许少量滑步）。

本项目的实现顺序建议就是：`目标脚位/朝向 → soft clamp（可选）→ 两骨 IK → 有界骨盆下沉（下沉量来自可达缺口）→ 仍不可达则 release`。WIP 目前是「先算需要多少下沉，超限直接 release，不超限则下沉 + IK」，没有 soft clamp——因为静态 idle 的姿势差几乎都在水平方向、腿本来就接近伸直但不超伸，通常不会触发 clamp；**保留 soft clamp 作为防御**（未来表演型 idle / 不同模型比例），可以避免「一瞬间刚好超几毫米就释放」的抖动。

### 5.2 「少量滑步」的可接受量

- 用户原始抱怨是 36–49px（≈12–16cm）的滑动；只要把滑动压到 **<1–2cm（≈3–6px）** 就已经视觉上「不滑」。
- 因此释放策略可以保守：**宁可偶发几毫米滑步，也不要为了 100% 钉死而牺牲可达性/姿势**。验收时用「脚错误 ≈0（稳态）且最大瞬时位移小」而不是「绝对零位移」。
- 一个具体数值：WIP 的 `REACH_MARGIN_M = 0.002`（2mm）软化了完全伸直；对应本模型 `upper+lower-1e-3` 的钳制（`solveKneePosition` 里 `maxDistance = L1+L2-1e-3`）本身就会让脚「差 1mm 到不了」，不会超伸——这是可接受的余量。

---

## 6. 「只静态启用、走路不动」的风险与建议

| 风险 | 具体表现 | 建议 |
|---|---|---|
| 表演型 idle 被锁僵 | `hsr-idleShow` / `hsr-idleShow2` 有 8–11° 脚旋转、31–40° hips 旋转，可能是作者设计的换重心/转身；锁脚会与其意图打架 | 依赖抬脚/速度/转身释放；或把这两条从「可锁 idle」白名单排除（需要 per-clip 标注/白名单，见 §3.3 方案 B） |
| 一次性/手动 clip 与 pat/dsh* 误锁 | `playClipById()` 播一次性 clip 时 mood 仍可能='idle'；`pat`/`dshBusy`/`dshDone`/`dshError` 也不在禁用列表 → 若这些动作抬脚/换姿势会被锁 | 用 `clipPlayer.snapshot()` 的 `slot`/`manual`/`oneShot`（animator 已有 `lastClipSnapshot`）判定：只有 `slot==='idle'` 且非手动/非一次性的基座 clip 才启用；或给 foot-lock 传 input 之外的白名单标志 |
| idle→walk 切换瞬间拖脚 | mood 变 walk 后 foot-lock 不再做接触判定，但若立刻清 pin 会在待机→走路起手时看到脚「弹回 clip 位」的一次跳变 | **WIP 已处理**：`beginTransitionRelease`（停止判定 + 清速度历史、保留 pin）+ `solveFoot` 用 `weightTauOut≈0.15s` 淡出；注意淡出期间 IK 仍按混合姿态修正，需视觉确认起手不拖脚 |
| 长期 idle 锚点永不更新 | 用户看 30 分钟后，下半身一直保持第一次 idle 的站姿，可能显得「腿僵」 | 现有逻辑：一旦接触因 lift/速度/不可达释放，会自然重锚；不做定时重锚。观察实际观感再调（可加「每 N 次变体切换允许一次重锚」的旋钮，但会重新引入少量滑动，默认关闭） |
| 帧率/掉帧 | dt 被 clamp 0.1s；低帧率下速度估计抖动、IK 权重步进大 | 30/60/144Hz 单测（rabfulton 同款验证项）；速度用「位移/dt」并 clamp dt；权重用指数平滑（WIP 已是 `1-exp(-dt/τ)`） |
| 不同模型/换资产 | 踝高、腿长、脚掌厚度都不同；`0.057×height` 兜底只在构造期测量失败时用 | 参数全部按 rest 实测（WIP `restFootLocalY`、腿长构造期测量）；换模型后必须重跑快照验收；不要写死 9.8cm |
| 构造期 rest 测量时机 | 若 `new VrmFootLock()` 发生在首帧 clip 已写入之后，rest 踝高会测成动画姿势 | animator 在 clip 初始化前构造（现状 OK）；加单测：构造后 `leftFootLiftM≈0` 可验证基准正确 |
| 快照/验收口径 | 旧快照只有 pinned 三字段；`wave2-contract.ts` 已扩为 pelvisDropM/error/lift | 验收必须同时看 `leftPinned/rightPinned`、`*FootErrorM≈0`、`pelvisDropM ≤ 上限`、walk/drag/sit/sleep 时 pinned=false（契约注释已写明） |
| 误把 `restFeetLocalY` 当踝高 | clip-player 的 `restFeetLocalY` 是 **feet+toes 最低骨 y**（`FOOT_BONE_NAMES` 含 toes，`clip-player.ts:198`），不是踝高 | 接触基准必须单独测 `leftFoot/rightFoot` 的 rest y；不要把贴地基准（含 toe）复用到接触判定 |

---

## 7. 本项目推荐参数表（可直接用于 WIP 调参/验收）

| 参数 | 建议值 | 依据 |
|---|---|---|
| 启用 mood（allowlist） | `idle`（+ 确认为静止的基座 clip） | 用户反馈范围 + 不回归已验收行为 |
| 禁用 mood | walk/climb/fall/drag/grabWindow/sit/sleep | WIP 已实现 |
| 接触基准 | 构造期实测 rest 踝 scene-local y（本模型 0.0983m） | 修正旧实现根因 |
| 接触进入 lift | ≤0.03m（≈9.4px） | WIP 值；rest 踝高；下限可用 0.02m 更严 |
| 接触退出 lift | >0.05m（≈15.6px） | WIP 迟滞；也可 0.04m |
| 接触进入水平速度 | ≤0.25 m/s | WIP；但见 §3：fade 假速度峰值可达 0.23–0.38 m/s，**配合 fade 冻结**后此阈值只用于稳态，足够 |
| 接触保持水平速度 | ≤0.9 m/s | WIP；对桌宠足够宽松（正常 idle 稳态脚速≈0） |
| 权重 τ（in/out） | 0.08s / 0.15s | rabfulton 60ms/80ms/120ms 量级；WIP 值 |
| 锚点 | scene-local 踝位置 + 脚朝向 quaternion | WIP；静态平脚=刚性脚掌锚 |
| 锚点保持 | 跨 clip 切换保持（不 reset） | rabfulton「跨 transition」+ 本地滑动机理 |
| 转身释放 | 脚朝向差 >20–30° 或 body yaw 累计 >15°（建议补充） | rabfulton「turns beyond orientation tolerance」；目前仅速度兜底 |
| 骨盆下沉上限 | 0.04m | 4.5% L / 2.3% 身高 / 12.5px；远小于 rabfulton 18% L（≈49.4px） |
| 下沉 τ | 0.12s | WIP |
| 下沉触发 | reach 缺口 >0 且 ≤上限；超上限 → release | WIP |
| IK 余量 | 2mm + 膝极向量用当前膝 | 防超伸/膝翻；WIP |
| 验收阈值（稳态） | `footErrorM ≤0.005m`、`pinned=true`、`pelvisDropM ≤0.04` | `wave2-contract.ts:344–362` 契约注释 |
| 验收阈值（crossfade 瞬态） | 脚世界位移单帧 <0.5cm、整段 <1cm；无「释放-重锚」抖动 | 相对 36–49px 的改善量级 |

---

## 8. 验收建议（单测 + 快照 + 视觉）

### 8.1 单测（WIP `tests/vrm-foot-lock.test.ts` 已覆盖大部分，建议补充）

现有 WIP 测试已覆盖：rest 踝高基准回归（真实比例 rig）、锚点误差≈0、跨 clip 站姿变化保持锚点、脚朝向锚定、hips 缓慢移动时脚不动、骨盆下沉有界、拖拽/空中不锁、抬脚释放、不可达释放、恢复后重接触。建议补：

1. **crossfade 假速度回归**：模拟 `fading=true` 期间目标站姿从 A 到 B 线性/平滑移动 15–20cm（0.8–1.0s），断言 `contact` 不因中间假速度/假 lift 被释放（配合 §3 方案 A）。
2. **fade 结束后 previousLocal 不尖峰**：fade 冻结期间仍更新 `previousLocal`，fade 结束第一帧速度不超阈值 → 不释放。
3. **旧实现根因回归（加强版）**：构造 bbox 脚底≈0、rest 踝≈9.8cm 的 rig，用旧判据必然 false（可写成注释断言/文档性测试）。
4. **朝向释放（补充）**：目标 clip 脚 yaw 差 25° 持续 0.2s → 释放（若采纳 §6 建议）。
5. **事件 clip 不锁（补充）**：`slot='manual'`/`oneShot=true` 时不启用（若采纳 §6 建议）。
6. **30/60/144Hz**：同一场景不同 dt 下锚点误差与释放行为一致（rabfulton 验证项）。

### 8.2 集成/快照验收（debug 快照已有字段）

`AnimationDebugSnapshot.footLock`（`wave2-contract.ts:344–362`）已含 `enabled/leftPinned/rightPinned/*Weight/pelvisDropM/*FootErrorM/*FootLiftM`。建议验证：

- 静止 idle 稳定 ≥2s 后：`leftPinned === rightPinned === true`、`leftFootErrorM/rightFootErrorM ≤ 0.005`、`leftFootLiftM ≈ 0`（±0.01）；
- 跨一次 idle 变体切换（12–20s 等待，或用 tuning 把 `VARIANT_SWITCH_CONFIG.idle.intervalSec` 缩短）：整段 `pinned` 不翻 false；脚世界位置（可加 debug 字段或截图对比）最大位移 <1cm；
- 切 walk / 拖拽 / 坐 / 睡 / 空中瞬间：`pinned === false`、`weight → 0`；
- 性能：单帧 foot-lock 耗时（`updateMs` 可参照）应 <0.5ms 量级（每帧两条腿、无分配大对象；WIP 已尽量用 tmp）。

### 8.3 视觉 A/B（540px 下）

- 切换时脚不再出现 36–49px 的横向滑移；
- 不出现膝翻（膝盖朝背后/抖动）——重点看 `hsr-idleShow` 这类旋转幅度大的 clip 切换；
- 骨盆下沉 ≤12.5px，不出现明显「下蹲/压扁」；
- 走路/拖拽/坐姿与改动前一致（回归）。

---

## 9. 不要做什么（汇总）

1. **不要用 bbox 脚底（≈0.07cm）或「feet+toes 最低骨」当踝接触基准**——前者永远不触发（本模型差 9.76cm），后者是 toe 高度不是踝高。
2. **不要用混合后姿态的脚速/高度直接做接触判定**（尤其 crossfade 期间）；要么用未混合目标动画，要么在 fade 期间冻结状态机。
3. **不要在 crossfade/clip 切换时重置 pin 与权重**（会瞬间回弹/滑一下）；锚点跨变体保持。
4. **不要在 walk/climb/fall/drag/grabWindow/sit/sleep 或空中/拖拽时锁脚**；也不要让这些状态的 pin 残留一帧。
5. **不要为了消滑把骨盆大幅拉低**（本项目 >4cm 就会显得下蹲；更别说 18% 腿长的量级），也不要把腿拉直/拉伸骨骼制造「刚好够到」。
6. **不要每帧硬钳模型整体高度/贴地**（现有 clip-player 每 clip 常量 offset 是对的；每帧硬钳会抖）。
7. **不要用「零滑动」当验收目标**；正确目标是「脚误差≈0 + 不破坏源动画 + 少量滑步可接受」。
8. **不要锁 heel**（Orange Duck：heel-only 接触既少又不稳定，锁它会限制提踵/自然摆动）；静态平脚锁踝可以，动态必须锁 toe/ball。
9. **不要把 IK 修正后的姿态写回 transition 历史/appliedPose**（会双重修正，rabfulton 明确警告）。
10. **不要在 clip 未就绪/rest T-pose 时建锚点**（启动窗口要 reset，WIP 已处理）。

---

## 10. 来源清单（分类 + 一句话要点 + 核实状态）

> 核实方式：`web_fetch` 读取页面内容（✅）；仅搜索结果确认标题/摘要、页面因验证码/403/PDF 无法读取的标 ⚠️。外部内容按数据对待。

### A. GitHub 可参考实现 / 代码

| 来源 | 要点 | 核实 |
|---|---|---|
| [orangeduck/GenoView-InverseKinematics](https://github.com/orangeduck/GenoView-InverseKinematics) | Orange Duck 文章配套完整 C 源码（two-bone IK、FootLockingState、接触标注、离线清理）；含 BVH 加载与脚滑可视化 | ✅ README 已读 |
| [rabfulton/VRM `docs/foot-planting.md`](https://github.com/rabfulton/VRM/blob/master/docs/foot-planting.md) | 与本项目最同构：unblended target 判接触、IK 作用于混合姿态、踝位置+朝向锚点、60/80/120ms、骨盆 ≤18% 腿长 + 临界阻尼、不可达释放、clip-floor 校准 | ✅ raw 全文已读 |
| [plonkabartosz/IKFootPlacement](https://github.com/plonkabartosz/IKFootPlacement) | Unity 免费脚部放置：raycast 地面 + Animation Rigging TwoBoneIK + IAnimationJob；任意腿数 | ✅ README 已读 |
| [guillaumeblanc/ozz-animation](https://github.com/guillaumeblanc/ozz-animation) | 开源 C++ 动画库；其 `IKTwoBoneJob` 是 rabfulton 实现所用的两骨 IK 求解器（MIT） | ✅ README 已读 |
| [pixiv/three-vrm VRMHumanoid 文档](https://pixiv.github.io/three-vrm/docs/classes/three-vrm.VRMHumanoid.html) | 本项目 API 依据：`normalizedBones`/`normalizedRestPose`/`getNormalizedBoneNode`，`update()` 把 normalized 抄到 raw（`autoUpdateHumanBones`） | ✅ 已读 |
| [pixiv/three-vrm issue #1643](https://github.com/pixiv/three-vrm/issues/1643) | 标题即结论：切换 Mixamo 动画后 hips position offset 导致模型下陷/贴地错位——印证「每 clip 位置偏移需单独校准」 | ⚠️ 仅标题确认（正文抓取被截断/API 限流） |

### B. Unity 官方 / 社区

| 来源 | 要点 | 核实 |
|---|---|---|
| [Unity OnAnimatorIK 脚本参考](https://docs.unity3d.com/cn/current/ScriptReference/MonoBehaviour.OnAnimatorIK.html) | IK 是动画求值后的后处理；用 weight 0–1 混合「动画驱动/IK 驱动」；需 Humanoid + IK Pass | ✅ 已读 |
| [Unity Animation Rigging：TwoBoneIKConstraint](https://docs.unity3d.com/Packages/com.unity.animation.rigging@1.2/manual/constraints/TwoBoneIKConstraint.html) | Root/Mid/Tip + Target + Hint；Target Position/Rotation Weight；Maintain Target Offset（保留 Tip 原始偏移）= 最小修改 | ✅ 已读 |
| [团结引擎 FootPlacement 节点](https://docs.unity.cn/cn/tuanjiemanual/Manual/AnimGraphAnimationNodeFootPlacement.html) | 脚目标位置/旋转与腿 IK 分离；Lock Foot/Lock Ground Distance/Unlock Radius/Relock Ratio；SmoothDamp；静止回正；raycast 地面 | ✅ 已读 |
| [bugnet: Fix Unity Mecanim Target Matching Foot Slide](https://bugnet.io/blog/fix-unity-mecanim-target-matching-foot-slide) | 症状「idle↔run 过渡脚悬空滑」；标准修法 IK Pass + OnAnimatorIK + 由源动画曲线提供 planted 0/1 权重；MatchTarget 处理落地事件 | ✅ 已读 |

### C. B 站（MMD 足 IK / 脚滑修复 / 动作修复）

| 来源 | 要点 | 核实 |
|---|---|---|
| [av842153411《【MMD教程】完美修复MMD祖传崴脚足IK》](https://www.bilibili.com/video/av842153411/) | MMD 足 IK 导致崴脚的常见问题与修复流程；理解「足 IK 是目标而非解算结果」 | ✅ 标题/页面已确认 |
| [BV1FdNPeSELN《了解MMD骨骼，足IK使用，为什么骨骼是日文的》](https://www.bilibili.com/video/BV1FdNPeSELN/) | MMD 足 IK 骨（`左足ＩＫ`/`右足ＩＫ`）+ IK 链的入门讲解；VMD 脚 IK 轨道=世界方向目标 | ✅ 标题/页面已确认 |
| [BV1icbMejE3J《如何修复脚滑和可视化脚步声 \| 动作捕捉动画课程 \| iClone 8》](https://www.bilibili.com/video/BV1icbMejE3J/) | iClone 的脚滑修复 + 脚步声可视化流程；「接触点/脚步事件」思路与 contact annotation 一致 | ⚠️ 页面验证码，标题经搜索结果确认 |
| [BV13Vf9BnExZ《GVHMR视频动捕转MMD动作修复方案！【技术分享】》](https://www.bilibili.com/video/BV13Vf9BnExZ/) | 视频动捕 → MMD 动作的修复流程（含脚部/贴地处理），可对照数据侧修 vs 运行时修 | ✅ 标题/页面已确认 |

### D. 模之屋（aplaybox）/ VRCD / 中文 DCC 社区

| 来源 | 要点 | 核实 |
|---|---|---|
| [VRCD 文档库：虚拟形象骨架（Avatar Rigs）](https://docs.vrcd.org.cn/books/vrc-school-vrchat/page/avatar-rigs) | Unity Humanoid 骨架配置；**Feet spacing / Translation DoF** 等会影响脚位与骨盆位移的参数（对应本项目「hips position 是否参与动画」问题域） | ✅ 全文已读 |
| [博客园《人形动画常见IK的处理》](https://www.cnblogs.com/OwlCat/p/18312604) | 脚上方 raycast 找地面；**质心调整只在 idle 开启**、奔跑时易抖；先记录原 IK 朝向再叠加贴地旋转以保留外八/内八 | ✅ 全文已读 |
| [CSDN《Unity3D：深入解析Foot IK实现原理与实战应用》](https://blog.csdn.net/weixin_29015127/article/details/158554733) | 中文实践总结：OnAnimatorIK + 权重曲线 + raycast + 骨盆偏移 + 平滑过渡（后半付费） | ✅ 部分已读 |
| [模之屋 aplaybox 教程文章（3D 同人动画教学）](https://www.aplaybox.com/article/details/641623224) | 模之屋站点以模型分享为主，检索到的教程偏 MMD 动画制作流程，**未找到专门的足 IK/脚滑修复专题**；作为中文 DCC 社区生态参考 | ⚠️ 页面可访问但内容为 JS 渲染，仅标题级 |

### E. 理论最佳实践（foot sliding 本质 / 接触标注 / 骨盆）

| 来源 | 要点 | 核实 |
|---|---|---|
| [Orange Duck《Inverse Kinematics and Foot Locking》](https://theorangeduck.com/page/inverse-kinematics-foot-locking) | 脚滑=速度不匹配；高度只作 sanity；速度阈值 0.1–0.5 m/s、高度 0.1m；中值/多数投票 + Gaussian 平滑；**锁 toe 不锁 heel**；IK 是「最小修改」；**避免 T-rex**，宁可少量滑步也不破坏源动画；离线 position-based 清理 | ✅ 全文已读 |
| [GDC Vault《Fitting the World: A Biomechanical Approach to Foot IK》](https://www.gdcvault.com/play/1023316/Fitting-the-World-A-Biomechanical) | 从生物力学角度处理脚部 IK：脚部接触/平滑与程序化感之间的取舍（Orange Duck 文首推荐资源之一） | ✅ 标题/摘要已读（会员视频） |
| [Okan Arikan, FootSkate cleanup（ACM DOI）](https://dl.acm.org/doi/10.1145/1111411.1111420) | 经典「离线脚滑清理」论文（约束优化消除滑步，保留动作风格）——若未来做数据侧清理可参考 | ⚠️ 仅 DOI 链接可达（PDF 被 Cloudflare 挡住，未读正文） |

### F. 本仓库内部依据（供实现核对）

> 行号按本文写作时（2026-11-09 23:1x）工作区状态；WIP 文件仍在编辑会漂移，以函数名/内容为准。

| 文件 | 相关行/内容 |
|---|---|
| `src/renderer/src/vrm/foot-lock.ts` | 当前 WIP（行号随编辑漂移，按函数名定位）：常量 57–80；`FootRig` 类型 86–109；构造/rest 实测 `createRig` 287–341；主流程 `update` 346–419；`applyPelvisDrop` 421–439；`beginTransitionRelease` 440–444（非静止状态平滑淡出，已修「起手回弹」）；接触状态机 `updateContact` 446–490（**仍测混合后姿态**，见 §3.2）；`releaseContact`/`deactivate` 493–507；`solveFoot` 509–590；快照 609–626；`reset` 628；`dispose` 634 |
| `src/renderer/src/vrm/clip-player.ts` | 变体参数 105–112；`VARIANT_ROTATION_MIN_PRIORITY=-9`（209）；`FOOT_BONE_NAMES` 198；`captureRestPose` 517–558（`restFeetLocalY` 554）；`beginClip` 1154–1198（首帧吸附 1184、fromBones 1186）；`applyFrame` 1227–1320（逐骨 slerp 1242–1277、hips 插值 1288–1309、humanoid.update 1317）；`groundTargetY` 1345–1348 |
| `src/renderer/src/vrm/animator.ts` | foot-lock 创建 114；调用顺序 325–330（clip-player 之后）；`needsRawSync` 358–365（第二次 humanoid.update）；快照接线 423/475–476 |
| `src/renderer/src/vrm/avatar-loader.ts` | `restFeetY`（bbox 脚底）613；`hipsRestHeight` 648–655 |
| `src/renderer/src/vrm/runtime-types.ts` | `VrmFootLockOptions` / `VrmFootLockDebugSnapshot`（139–155，WIP 新增）；`footLock?: boolean` 352 |
| `src/renderer/src/core/wave2-contract.ts` | `footLock` 快照契约 344–362（验收断言口径） |
| `src/shared/vrm-manifest.json` | 默认资产 `aventurine-tpose.vrm`（3、30–32），`heightMeters=1.73`（32） |
| `assets/motions/app-manifest.json` | idle 20 条、参与轮换 10 条（priority ≥ −9） |
| `tests/vrm-foot-lock.test.ts` | 2026-11-09 重写的 WIP 单测：真实比例（hips 1.0661m/踝 0.0983m/大腿 0.4358m/小腿 0.4456m/bbox 0.0007m/身高 1.734m）、crossfade 保持锚点、朝向锚定、骨盆下沉有界、释放/重接触 |
| `docs/wave2-acceptance.md:96` | V5 旧脚锁验收记录（历史背景） |
| `docs/research/vrm-runtime-research.md:619` | 早期结论「three-vrm 无内置 IK，V1 不建议运行时 IK，先数据侧修」——本轮因用户反馈静态 idle 滑步，改为「只静态、有界、可释放」的运行时方案，属有意修订 |

---

## 11. 核实记录（本次调研的抓取统计）

- `web_fetch` 共发起 **30+ 次**抓取（含同文不同入口、镜像、404 重试）；返回 200 的约 **20+ 次**（其中 B 站验证码页、GitHub 截断页只能确认标题）。
- 读取到**实质全文/主要内容 12 个**：Orange Duck 文章、rabfulton `foot-planting.md`（raw）、GenoView / IKFootPlacement / ozz README、Unity TwoBoneIK、Unity OnAnimatorIK、团结引擎 FootPlacement、博客园人形 IK、VRCD Avatar Rigs、bugnet foot slide、three-vrm VRMHumanoid 文档。
- **标题/摘要级确认 6–7 个**：GDC Vault（标题+overview）、three-vrm issue #1643（标题）、B 站 av842153411 / BV1FdNPeSELN / BV13Vf9BnExZ（标题）、B 站 BV1icbMejE3J（搜索标题）、模之屋文章页（站点可访问、JS 渲染标题级）、CSDN（部分正文）。
- **失败/受限 9 次**（均**未**作为已验证来源，文中相应标注 ⚠️）：GitHub API issue 403（限流）、ACM DOI Cloudflare 403、PDF 类型不支持（FootSkate/其他）、B 站验证码 4 次（BV1icbMejE3J、BV1j8h16uEQy、opus、镜像页）、Unity Discussions 页面类型不支持、`/Manual/FootIK.html` 404、Orange Duck `/page/inertialization` 404、`r.jina.ai` 代理失败。
- 结论：文中所有外链均可定位到页面（✅ 或 ⚠️ 标注）；关键结论（速度 vs 高度、toe vs heel、IK 最小修改、避免 T-rex、未混合目标判接触、骨盆上限/阻尼、60/80/120ms 时序）均有至少 1 条全文级来源支撑，且与 WIP 实现一致或给出明确改进建议。
