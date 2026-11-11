# GitHub 开源桌宠：坐/躺/睡姿态的「表面门控」与过渡实现（案例研究）

> 状态：**只读研究，未改任何项目源码/配置/测试**；本文件是唯一新增交付物。
> 调研日期：2026-11-09。方法：目标仓库浅克隆到 `/tmp/ghh`（`--filter=blob:none`）后全量 grep + 逐文件读；引用锚定到具体 commit；
> 所有 GitHub 链接在 2026-11-09 用 `curl -o /dev/null -w '%{http_code}'` 实测 **200**（Steam 页面同样实测，见 §5）。
> 本地上下文（Lead 取证，[lead-local-analysis.md](./lead-local-analysis.md)）：
> ① `sleep` 活动 requirements 仅 `grounded + mouseAway` → 任意地面可触发；② 进入 `mate-sleep` 的 crossfade 只有 0.15–0.2s，无躺下过渡 clip；
> ③ 高窗（`top < 屏幕中线`）时 `resolveSitWindowStyle` 返回 `lie`，当帧 0.3s fade 切 `mate-windowLay8/9/10`，跳过坐姿阶段。

---

## TL;DR（先看这 8 条）

1. **成熟桌宠不是给 clip 加条件，而是先做「当前站在哪类表面上」的能力查询，再由行为/状态按表面类型分块。**
   最干净的是 Shimeji 的 `environment.getFloor()`：先查**活动窗口上边框**（activeIE），再查工作区底部边框；
   两者都返回同一种 `Border`，但 `behaviors.xml` 用不同 `<Condition>` 块把「窗沿坐」和「地面坐」分开。
2. **「窗沿=可坐表面」在实现上是一次吸附（snap）事件，不是每帧判断。** Mate-Engine 用**髋部探针 + 24px 半径 + 拖拽保持 ≥1s**
   命中窗口上沿后置 `isWindowSit=true`，并把角色窗口钉在窗沿上跟随窗口移动；未吸附时永远不进入窗沿姿态状态。
3. **避免「地面随机躺」最有效的两条**：① 把躺/睡姿态从「地面条件块」里拿掉或加上 `onWindowTop` 型需求
   （Shimeji 的 if 块结构、本项目的 `requirements` 都支持）；② 睡/躺只允许在特定状态白名单里进入
   （Mate-Engine `AvatarSleepController.allowedStates = {"Idle","Sleeping"}`，WindowSit/Sitting 期间不能睡）。
4. **过渡有两种成熟做法，且都存在于商业/开源产品中**：
   **A. 纯 crossfade + 表面吸附/座位校准**（Mate-Engine，0.25s 进窗沿躺、0.45s 坐、1.0s 进睡）；
   **B. 专用 one-shot 过渡片段**（Desktop Mate 的 `sittingOneShotAnims`/`standingOneShotAnims`；VPet 的 `A_Start → B_Loop → C_End` 三元组；
   Shimeji 的 `SitDown`/`LieDown`/`StandUp` Sequence）。**纯 0.2s 站→躺 blend 没有任何一个成熟项目这么做**——它们要么门控严格，要么有过渡。
5. **中断/恢复有统一套路**：窗口最大化/全屏/最小化/cloaked/关闭 → 立即退出姿态（Mate-Engine `ClearSnapAndHide`）；
   拖拽/点击 → 高优先级状态直接抢占（Shimeji 拖拽时直接 `setBehavior("Dragged")`）；
   离开窗沿 → 冷却 0.3s + 16px 垂直带回滞，防止抖动重入。
6. **「被放在窗口上才坐下」= 吸附语义（snap on drag end / drag hold），不是「站上去 700ms」**。Mate-Engine 的触发条件是
   `isDragging && dragDuration ≥ 1s && cursor 位移 ≥ 4px && 髋部探针在窗口上沿 ±24px`；松手后保持吸附。
7. **对我们的 bug**：主因是外部研究能直接证伪的「地面睡」+「短 crossfade 直接换大姿势」组合；仅靠调长 crossfade 不够，
   需要「表面能力门控 + 过渡片段/两段姿态」两件事一起做（与 Lead 本地分析结论一致）。
8. **数据模型上我们已有过渡 clip 的承载位**：catalog 里 `adv-*as`/`adv-*bs` 就是 `loop:false` 的一次性片段族
   （[app-catalog.json](../../../assets/motions/app-catalog.json) L498–507），把 `lie-down`/`get-up` 加进去不需要新机制；缺的是 wiring + 门控。

### 四问速答

| 问题 | 直接答案 | 证据 |
|---|---|---|
| ① 如何把 sit/lie/sleep 绑到窗口表面、避免地面随机躺 | Shimeji：`getFloor()` 先 activeIE 上边框、再工作区底边；`behaviors.xml` 按 `<Condition>` 分块，窗沿行为只出现在 IE-top 块。Mate-Engine：拖拽中做「探针命中窗沿→snap」，`isWindowSit` 只由 snap 事件置位；sleep 用状态白名单排除窗沿状态。Ark-Pets/uDesktopMascot/macOS Electron 宠无此门控（负面样本）。 | §2.2、§2.1、§2.5–2.8 |
| ② 进/出用过渡动画还是 crossfade？参数？ | 两种都用：Desktop Mate = `standingOneShot + loop` / `sittingOneShot + loop`；VPet = `A_Start → B_Loop → C_End`（起身播 `C_End` 再回 normal）；Shimeji = `SitDown`/`LieDown`/`StandUp` `Loop="false"` Sequence。Mate-Engine = 纯 crossfade：窗沿躺 **0.25s**、坐 **0.45s**、进睡 **1.0s**、醒 **0.45s**（无 AnyState transition）。 | §2.1.2、§2.2、§2.4、§2.7 |
| ③ 值得抄的状态机门控结构 | 表面→行为条件块（Shimeji）；`preferredActivityId` 式事件绑定（本项目已有）；阻塞 bool 列表 `blockSitIfBoolTrue`；guard/latch 帧回滞 + unsnap 冷却；睡眠白名单；无候选行为时回退 fall（Shimeji `buildNextBehavior` fallback）。 | §2.1.3、§2.2.4、§2.4 |
| ④ 移植建议 | 见 §3 的 R1–R3（表面能力查询/门控、过渡片段或两段式、吸附+回滞+中断）。 | §3 |

---

## 1. 案例总表

| repo（commit） | 技术栈 | sit/lie 表面门控方式 | 进入/退出过渡方式 | 关键文件 / 链接 |
|---|---|---|---|---|
| **shinyflvre/Mate-Engine** `2c5ea6b` | Unity 6000.2.6f2 + VRM（Windows；窗口吸附逻辑 Windows-only） | 拖拽中「髋部探针 ±24px + 拖拽 ≥1s + 位移 ≥4px」命中**未被遮挡的窗口上沿** → snap；`isWindowSit` 只由 snap 置位；窗沿/任务栏两套 bool；睡眠白名单排除窗沿 | 纯 Animator crossfade：**0.25s** 进/出 WindowSit，**0.45s** 坐/起，**1.0s** 进睡 / **0.45s** 醒；无 AnyState transition；躺姿是 BlendTree（静态 pose + 2–20s 循环） | [AvatarWindowHandler.cs](https://github.com/shinyflvre/Mate-Engine/blob/2c5ea6b8f4cf5e1773a0816b46d9267cda5174d4/Assets/MATE%20ENGINE%20-%20Scripts/AvatarHandlers/AvatarWindowHandler.cs)、[AvatarAnimatorController.controller](https://github.com/shinyflvre/Mate-Engine/blob/2c5ea6b8f4cf5e1773a0816b46d9267cda5174d4/Assets/MATE%20ENGINE%20-%20Animations/AvatarAnimatorController.controller) |
| **DalekCraft2/Shimeji-Desktop** `bded6e1`（Kilkakon Shimeji-ee 的维护 fork） | Java/Swing；Windows/macOS/Linux；行为由 `actions.xml`+`behaviors.xml` 配置 | 环境边框模型：`getFloor()` **先查活动窗口(activeIE)上边框、再查工作区底边**；`behaviors.xml` 按 `<Condition>` 分块（On the Floor / On Top of IE / On the Side of IE…），`SitOn*EdgeOfIE` 只出现在 IE-top 块 | **专用序列动作**：`SitDown`/`LieDown`/`StandUp` 均 `Type="Sequence" Loop="false"`；窗沿坐 = walk→stand→sit 序列；无骨骼 crossfade（2D 精灵） | [behaviors.xml](https://github.com/DalekCraft2/Shimeji-Desktop/blob/bded6e1d477fea12553c53427d86d3b51fa40038/conf/behaviors.xml)、[actions.xml](https://github.com/DalekCraft2/Shimeji-Desktop/blob/bded6e1d477fea12553c53427d86d3b51fa40038/conf/actions.xml)、[MascotEnvironment.java](https://github.com/DalekCraft2/Shimeji-Desktop/blob/bded6e1d477fea12553c53427d86d3b51fa40038/src/main/java/com/group_finity/mascot/environment/MascotEnvironment.java) |
| **pixelomer/libshijima** `361f452` + **Shijima-Qt** `57723f1` | C++ 引擎 + Qt 前端；macOS/Linux/Windows | 引擎级 `Border.is_on()`（**1px 容差**）、`area.is_on(anchor)`、`on_land()`；`activeIE` 移动时 `sticky_ie` 跟随；离开边框时 `detach_from_borders()` 把 anchor 推开 1.1px 防重吸 | 仅提供引擎；Sit/Lie 由 Shimeji pack 的 actions/behaviors 定义（同 Shimeji 语义） | [environment.hpp](https://github.com/pixelomer/libshijima/blob/361f452f3e89cdfaf04624db1c7641e3db410da9/shijima/mascot/environment.hpp)、[manager.cc](https://github.com/pixelomer/libshijima/blob/361f452f3e89cdfaf04624db1c7641e3db410da9/shijima/mascot/manager.cc)、[Shijima-Qt README（macOS AX 权限）](https://github.com/pixelomer/Shijima-Qt/blob/57723f1d7a4ea4a32e5fbb90deb7febc0dd49f63/README.md) |
| **LorisYounger/VPet** `c26be33` | C# WPF（2D 精灵；无窗口表面/重力概念） | 无表面门控（宠物浮在桌面）；姿态是动画类型，睡眠是 `WorkingState.Sleep` + 随机 idle 事件 | **专门 get-in/get-out**：`AnimatType.A_Start/B_Loop/C_End`；`DisplaySleep` 播 `A_Start`→循环 B→醒时 `ToolBar` 播 `C_End` 再回 normal | [GraphInfo.cs](https://github.com/LorisYounger/VPet/blob/c26be33d730ea5547711f6cc9781cf94e4d6ac7d/VPet-Simulator.Core/Graph/GraphInfo.cs)、[MainDisplay.cs](https://github.com/LorisYounger/VPet/blob/c26be33d730ea5547711f6cc9781cf94e4d6ac7d/VPet-Simulator.Core/Display/MainDisplay.cs)、[ToolBar.xaml.cs](https://github.com/LorisYounger/VPet/blob/c26be33d730ea5547711f6cc9781cf94e4d6ac7d/VPet-Simulator.Core/Display/ToolBar.xaml.cs) |
| **isHarryh/Ark-Pets** `574b7c6` | Java + libGDX + Spine 2D | 无姿态×表面门控；sit/sleep 是马尔可夫状态，仅受 config 开关限制；窗口站立是另一套「逐列 barrier」物理 | Spine `setAnimation()` 硬切，无 mix 过渡（2D 精灵） | [StochasticMatrix.java](https://github.com/isHarryh/Ark-Pets/blob/574b7c63397827e4e52d9d3e6b0ce726923a32c5/core/src/cn/harryh/arkpets/animations/StochasticMatrix.java)、[GeneralBehavior.java](https://github.com/isHarryh/Ark-Pets/blob/574b7c63397827e4e52d9d3e6b0ce726923a32c5/core/src/cn/harryh/arkpets/animations/GeneralBehavior.java)、[ArkPets.java](https://github.com/isHarryh/Ark-Pets/blob/574b7c63397827e4e52d9d3e6b0ce726923a32c5/core/src/cn/harryh/arkpets/ArkPets.java) |
| **xiangzi1025/desktop-pet-macos** `5c39419` | Electron + macOS（与我们是最近的技术栈） | 有窗口上沿 ledges（`validWindowLedges` 过滤宽度/位置），用于巡逻/坠落支撑；**sleep 是纯随机自主状态，不做表面门控** | 视频/PNG 切换（2D），无骨骼过渡 | [behavior.js](https://github.com/xiangzi1025/desktop-pet-macos/blob/5c39419f616ae59da668fb7e7d88e0465b466f8b/behavior.js)、[main.js](https://github.com/xiangzi1025/desktop-pet-macos/blob/5c39419f616ae59da668fb7e7d88e0465b466f8b/main.js) |
| **Desktop Mate**（闭源，Steam 3301060） | Unity + VRM（官方） | 官方文案「they **sit on your windows**」；实现闭源 | **逆向/Mod 文档**显示动画分为 `standingRandomAnims / standingOneShotAnims / sittingRandomAnims / sittingOneShotAnims`（+坐/站两种被摸、被拎、JumpIn/Out、HideLeft/Right）→ **进/出坐姿 = one-shot 过渡片段 + 循环** | [Steam 商店页](https://store.steampowered.com/app/3301060/Desktop_Mate/)、[CharaData.cs](https://github.com/Xyzstk/DesktopMateAssetDecryptor/blob/425189db9c4976883d133892cb9d5fff0cf45023/ExampleProject/Assets/Scripts/CharaData.cs)、[Mod 说明 README](https://github.com/Xyzstk/DesktopMateAssetDecryptor/blob/425189db9c4976883d133892cb9d5fff0cf45023/README.md) |
| **MidraLab/uDesktopMascot** `f00728d` | Unity 6 + VRM，Apache-2.0，支持 macOS | **有素材但未接线**：controller 里有 `Sit_01`/`lie_01`/`lie_02` 状态和 `IsSitting` 参数，但没有任何 transition 指向它们；代码只算「是否在 Explorer 窗口上沿 ±50px」且只把 `IsSitting` 置 false | PlayableGraph 双 clip 权重混合，`PlayAnimation(clip, blendDuration)`（可调时长） | [CharacterManager.cs](https://github.com/MidraLab/uDesktopMascot/blob/f00728d9040176469ee9a04092bf7205a5cb887f/Assets/uDesktopMascot/Scripts/Character/CharacterManager.cs)、[CharacterAnimationController.controller](https://github.com/MidraLab/uDesktopMascot/blob/f00728d9040176469ee9a04092bf7205a5cb887f/Assets/uDesktopMascot/Resources/CharacterAnimationController.controller)、[CharacterAnimationController.cs](https://github.com/MidraLab/uDesktopMascot/blob/f00728d9040176469ee9a04092bf7205a5cb887f/Assets/uDesktopMascot/Scripts/Character/CharacterAnimationController.cs) |

---

## 2. 逐案例摘录

### 2.1 shinyflvre/Mate-Engine（Unity + VRM，最完整参考）

commit `2c5ea6b8f4cf5e1773a0816b46d9267cda5174d4`（2026-01-20，main；本地 `refs/Mate-Engine` 副本即此 commit）。
注意：**窗口坐立是 Windows-only**——`AvatarWindowHandler.Update()` 开头 `#if !UNITY_STANDALONE_WIN return;`（[L167–171](https://github.com/shinyflvre/Mate-Engine/blob/2c5ea6b8f4cf5e1773a0816b46d9267cda5174d4/Assets/MATE%20ENGINE%20-%20Scripts/AvatarHandlers/AvatarWindowHandler.cs#L167-L171)），macOS 需换 AX/CGWindowList 实现（见 §2.2/§2.6）。

#### 2.1.1 窗沿吸附（surface gating 的核心）

参数（[AvatarWindowHandler.cs L8–34、L63–71](https://github.com/shinyflvre/Mate-Engine/blob/2c5ea6b8f4cf5e1773a0816b46d9267cda5174d4/Assets/MATE%20ENGINE%20-%20Scripts/AvatarHandlers/AvatarWindowHandler.cs#L8-L34)）：

```csharp
public float minDragHoldSecondsToSit = 1f;   // 拖拽满 1s 才允许 sit
public float unsnapCooldownSeconds = 0.3f;   // 脱离后 0.3s 内不可再吸
public float probeRadiusPx = 24f;            // 髋部探针命中窗口上沿的半径
public float probeGuardPx = 240f;            // 吸附点周围 240px 守卫区，防抖
public List<string> blockSitIfBoolTrue;      // 任意 Animator bool 为真则禁止坐（如拖拽/睡眠）
public int snapGuardFrames = 8, snapLatchFrames = 18; // 滞回帧
public int unsnapVerticalBand = 16;          // 离开上沿 16px 才判定脱离
```

「探针命中窗沿 → snap」关键段（[L412–546](https://github.com/shinyflvre/Mate-Engine/blob/2c5ea6b8f4cf5e1773a0816b46d9267cda5174d4/Assets/MATE%20ENGINE%20-%20Scripts/AvatarHandlers/AvatarWindowHandler.cs#L412-L469) 摘要）：

```csharp
void TrySnap() {
    if (Time.unscaledTime < _unsnapCooldownUntil) return;      // 冷却
    if (IsSitBlocked()) return;                                // 任一块 bool
    if (useGuardZone && _guardZoneActive && 距上次吸附点 < 240px) return;
    if (!ComputeZoneDesktop(out px, out py)) return;          // 髋部世界坐标→屏幕坐标
    if (_recentUnsnap && |py - _lastSnapTopY| < max(16, probeRadius)) return;
    foreach (window in cachedWindows) {
        if (!(px in [window.Left, window.Right])) continue;   // 水平落在窗口内
        if (|py - window.Top| > 24f) continue;                // 垂直在上沿 ±24px
        if (IsOccludedByHigherWindowsAtPoint(...)) continue;  // 被更高 z 序窗口盖住 → 不可坐
        snappedHWND = win.hwnd;
        animator.SetBool("isWindowSit", true);                // 唯一置 true 的地方
        animator.Update(0f);                                  // 立刻推进状态机
        CalibrateSeatAnchorToDesktopY(top + seatOffsetPx);    // 座位锚点校准
        ...
    }
}
```

触发时机（[L194–241](https://github.com/shinyflvre/Mate-Engine/blob/2c5ea6b8f4cf5e1773a0816b46d9267cda5174d4/Assets/MATE%20ENGINE%20-%20Scripts/AvatarHandlers/AvatarWindowHandler.cs#L194-L241)）：
**只在拖拽中**（`controller.isDragging`）才尝试吸附，且要求拖拽已持续 ≥`minDragHoldSecondsToSit(1s)`、光标位移 ≥`minDragPixelsToSnap(4px)`；
非拖拽时只做「跟随已吸附窗口」(`FollowSnapped`)。也就是说**「被放在窗口上」= 拖拽中命中上沿并吸附，松手后保持**，而不是「站上去自动坐」。
吸附后每帧 `PinToTarget()`（[L559–596](https://github.com/shinyflvre/Mate-Engine/blob/2c5ea6b8f4cf5e1773a0816b46d9267cda5174d4/Assets/MATE%20ENGINE%20-%20Scripts/AvatarHandlers/AvatarWindowHandler.cs#L559-L596)）把角色窗口钉在「窗口上沿 + seatOffset，水平按 snapFraction 跟随」，窗口移动时一起移动。

可坐窗口过滤（[IsSitEligibleWindow L395–403](https://github.com/shinyflvre/Mate-Engine/blob/2c5ea6b8f4cf5e1773a0816b46d9267cda5174d4/Assets/MATE%20ENGINE%20-%20Scripts/AvatarHandlers/AvatarWindowHandler.cs#L395-L403)）：排除子窗口/被最小化/cloaked/无标题/宽<200/高<60/桌面类窗口；`UpdateCachedWindows` 还按透明度/点击穿透/工具窗口过滤，并按 8–15Hz 刷新（拖拽/吸附中 15Hz，空闲 8Hz）。

#### 2.1.2 Animator：无 AnyState，全显式 transition（这是「没有过渡」的直接证据）

- 三个 `m_AnyStateTransitions: []`（[L1359](https://github.com/shinyflvre/Mate-Engine/blob/2c5ea6b8f4cf5e1773a0816b46d9267cda5174d4/Assets/MATE%20ENGINE%20-%20Animations/AvatarAnimatorController.controller#L1359)、L1946、L2381）——**不靠 AnyState 抢占**。
- `WindowSit` 状态（[L1646–1672](https://github.com/shinyflvre/Mate-Engine/blob/2c5ea6b8f4cf5e1773a0816b46d9267cda5174d4/Assets/MATE%20ENGINE%20-%20Animations/AvatarAnimatorController.controller#L1646-L1665)）的 motion 是 `WindowSitIndex` 参数的 1D BlendTree（10 个子 clip：`BETA_PET_WINDOW_LAY` 19.96s 循环 + `WINDOW_LAY_2..7/9/10` 等静态/短循环 pose，阈值 0–9；[L857–860](https://github.com/shinyflvre/Mate-Engine/blob/2c5ea6b8f4cf5e1773a0816b46d9267cda5174d4/Assets/MATE%20ENGINE%20-%20Animations/AvatarAnimatorController.controller#L857-L860)）。
- 过渡时长（由状态机 YAML 逐块解析）：`Drag → WindowSit`（条件 `isWindowSit`）**0.25s**（[L597–621](https://github.com/shinyflvre/Mate-Engine/blob/2c5ea6b8f4cf5e1773a0816b46d9267cda5174d4/Assets/MATE%20ENGINE%20-%20Animations/AvatarAnimatorController.controller#L597-L621)）；`WindowSit → Drag`（`!isWindowSit`）**0.25s**（[L1368–1392](https://github.com/shinyflvre/Mate-Engine/blob/2c5ea6b8f4cf5e1773a0816b46d9267cda5174d4/Assets/MATE%20ENGINE%20-%20Animations/AvatarAnimatorController.controller#L1368-L1392)）；`Idle → Sitting`（任务栏坐）**0.45s**，`Sitting → Idle` **0.45s**；`Idle → Sleeping` **1.0s**（[L1053–1077](https://github.com/shinyflvre/Mate-Engine/blob/2c5ea6b8f4cf5e1773a0816b46d9267cda5174d4/Assets/MATE%20ENGINE%20-%20Animations/AvatarAnimatorController.controller#L1053-L1077)），`Sleeping → Idle` **0.45s**（[L1779–1803](https://github.com/shinyflvre/Mate-Engine/blob/2c5ea6b8f4cf5e1773a0816b46d9267cda5174d4/Assets/MATE%20ENGINE%20-%20Animations/AvatarAnimatorController.controller#L1779-L1803)）。
- 关键观察：**从站姿到窗沿躺也只有 0.25s blend**，没有专用 lie-down clip——Mate-Engine 的解法是「严格表面吸附 + 座位校准（把身体钉在窗沿）」而不是过渡动画；
  同一份 Animator 里 Sleeping（更大幅度的地面躺）用了 **1.0s** 进，说明作者知道「姿势差异越大过渡越长」。
- 进入 WindowSit 时随机换姿势：`if (isWindowSitNow && !wasSitting) SetFloat(WindowSitIndex, Random.Range(0, totalWindowSitAnimations))`（[L178–184](https://github.com/shinyflvre/Mate-Engine/blob/2c5ea6b8f4cf5e1773a0816b46d9267cda5174d4/Assets/MATE%20ENGINE%20-%20Scripts/AvatarHandlers/AvatarWindowHandler.cs#L178-L184)）。

#### 2.1.3 中断 / 滞回 / 冷却（值得抄的数值）

- 窗口变化中断（[L225–247](https://github.com/shinyflvre/Mate-Engine/blob/2c5ea6b8f4cf5e1773a0816b46d9267cda5174d4/Assets/MATE%20ENGINE%20-%20Scripts/AvatarHandlers/AvatarWindowHandler.cs#L225-L247)）：目标窗口变为**最大化 / 全屏 / 最小化 / cloaked** → `ClearSnapAndHide()`（置 `isWindowSit=false`、`isTaskbarSit=false`、解除吸附）；`isBigScreenAlarm` 也强制清除。
- 拖走离开（[IsStillNearSnappedWindow L597–621](https://github.com/shinyflvre/Mate-Engine/blob/2c5ea6b8f4cf5e1773a0816b46d9267cda5174d4/Assets/MATE%20ENGINE%20-%20Scripts/AvatarHandlers/AvatarWindowHandler.cs#L597-L643)）：先消耗 `_latch(18帧)` / `_guard(8帧)`；之后要求探针仍在窗口水平范围内、|py−top| ≤ max(16,24)，且拖拽时光标垂直位移 ≤ 带宽，否则 `ClearSnapAndHide(fromUnsnap=true)` → 启动 0.3s 冷却 + 记录 `_recentUnsnap`，垂直带内不允许重新吸附（防抖动重入）。
- 快速刷新：吸附/拖拽中窗口枚举 15Hz、空闲 8Hz（[L186–192](https://github.com/shinyflvre/Mate-Engine/blob/2c5ea6b8f4cf5e1773a0816b46d9267cda5174d4/Assets/MATE%20ENGINE%20-%20Scripts/AvatarHandlers/AvatarWindowHandler.cs#L186-L192)）。
- 座位校准：用骨点（Head/Hips/双腿/双脚）屏幕投影做二分，求「让胯部落在 windowTop+seatOffset」的骨骼 localY（[CalibrateSeatAnchorToDesktopY L489–546](https://github.com/shinyflvre/Mate-Engine/blob/2c5ea6b8f4cf5e1773a0816b46d9267cda5174d4/Assets/MATE%20ENGINE%20-%20Scripts/AvatarHandlers/AvatarWindowHandler.cs#L489-L546)）；之后 `GetSeatWorldCurrent()` 用 `boundsMinSnapLocal + seatNormY * boundsSize` 计算每帧座位。
- 任务栏坐：窗口底部中央 100×10 的「粉区」与任务栏顶边 5px 重叠 → 直接 `animator.SetBool("isSitting", isNearTaskbar)`（[AvatarTaskbarController.cs L77–84](https://github.com/shinyflvre/Mate-Engine/blob/2c5ea6b8f4cf5e1773a0816b46d9267cda5174d4/Assets/MATE%20ENGINE%20-%20Scripts/AvatarHandlers/AvatarTaskbarController.cs#L77-L84)），不要求拖拽。
- 睡眠门控（[AvatarSleepController.cs L7–17、L52–71](https://github.com/shinyflvre/Mate-Engine/blob/2c5ea6b8f4cf5e1773a0816b46d9267cda5174d4/Assets/MATE%20ENGINE%20-%20Scripts/AvatarHandlers/AvatarSleepController.cs#L7-L17)）：

```csharp
public bool enableSleep = false;                 // 默认关闭
public float sleepTimer = 60f;                   // 30–360s
public string[] allowedStates = { "Idle", "Sleeping" };  // 只有 Idle 能进睡
public string[] wakeUpBools = { "isDragging" };          // 拖拽立刻醒
...
bool allowed = IsInAllowedState(state);
if (allowed) { if (!isSleeping) idleTime += dt; if (idleTime >= sleepTimer && !isSleeping) SetSleeping(true); }
else { idleTime = 0; SetSleeping(false); }
```

→ Mate-Engine 里 **WindowSit / Sitting 期间不会睡**（白名单只有 Idle），「窗沿躺」和「地面睡」是两个互斥来源。

#### 2.1.4 对本 bug 的启示

- 它的「窗沿躺」不可能在普通地面出现：`isWindowSit` 只有探针命中窗口上沿并吸附才会置 true；
- 它的「地面睡」用**长 timer（60s）+ 1.0s 长 fade + 默认关闭**降低突兀感，且不允许在坐/躺状态叠加；
- 但它**没有**专用 lie-down clip，所以「严格门控」是它避免「地面突然躺」的主要手段——这正是我们当前缺的那层。

### 2.2 DalekCraft2/Shimeji-Desktop（Shimeji-ee 维护 fork，Java）——「按表面能力分块」的最佳范例

commit `bded6e1d477fea12553c53427d86d3b51fa40038`（2026-11-04，main）。

#### 2.2.1 环境解析：先窗口上沿、再工作区底边

[`MascotEnvironment.getFloor()` L211–235](https://github.com/DalekCraft2/Shimeji-Desktop/blob/bded6e1d477fea12553c53427d86d3b51fa40038/src/main/java/com/group_finity/mascot/environment/MascotEnvironment.java#L211-L235)：

```java
public Border getFloor(boolean ignoreSeparator) {
    Point anchor = mascot.getAnchor();
    Area activeIe = getActiveIE();
    Border activeIeBorder = activeIe.getTopBorder();
    if (activeIeBorder.isOn(anchor)) return activeIeBorder;   // ① 活动窗口上沿
    Area workArea = getWorkArea();
    Border workAreaBorder = workArea.getBottomBorder();
    if (workAreaBorder.isOn(anchor)) { ... return workAreaBorder; } // ② 工作区底边
    return NotOnBorder.INSTANCE;
}
```

- `Border.isOn(Point)` 是接口（[Border.java L21](https://github.com/DalekCraft2/Shimeji-Desktop/blob/bded6e1d477fea12553c53427d86d3b51fa40038/src/main/java/com/group_finity/mascot/environment/Border.java#L21)）；具体判定是**整数精确相等 + 水平范围**（[FloorCeiling.isOn L147–149](https://github.com/DalekCraft2/Shimeji-Desktop/blob/bded6e1d477fea12553c53427d86d3b51fa40038/src/main/java/com/group_finity/mascot/environment/FloorCeiling.java#L147-L149)）：`area.isVisible() && getY()==location.y && left<=x<=right`。
  （`libshijima` 移植版改成 `|Δy| < 1px` 容差，见 §2.3。）
- `getWall()/getCeiling()` 结构相同（activeIE 侧边/底边 优先，其次工作区边框），`getActiveIE()` = 平台实现的前台窗口（[L280–288](https://github.com/DalekCraft2/Shimeji-Desktop/blob/bded6e1d477fea12553c53427d86d3b51fa40038/src/main/java/com/group_finity/mascot/environment/MascotEnvironment.java#L280-L288)）。
- macOS 版通过 **Accessibility API** 取前台 App 的 focused window：`AXUIElementCreateApplication(pid)` + `kAXFocusedWindowAttribute` + `kAXPositionAttribute/kAXSizeAttribute`（[MacEnvironment.getFrontmostAppRect L129–152](https://github.com/DalekCraft2/Shimeji-Desktop/blob/bded6e1d477fea12553c53427d86d3b51fa40038/src/main/java/com/group_finity/mascot/platform/mac/MacEnvironment.java#L129-L152)）。这正是我们在 macOS 上实现「活动窗口窗沿」可走的路（需辅助功能授权）。

#### 2.2.2 behaviors.xml：表面条件块 + 窗沿专属行为

[behaviors.xml L40–56](https://github.com/DalekCraft2/Shimeji-Desktop/blob/bded6e1d477fea12553c53427d86d3b51fa40038/conf/behaviors.xml#L40-L56)（地面块）：

```xml
<Condition Condition="#{mascot.environment.floor.isOn(mascot.anchor)}">
  <Behavior Name="StandUp" Frequency="200" Hidden="true"/>
  <Behavior Name="SitDown" Frequency="200">
    <NextBehaviorList Add="true">
      <BehaviorReference Name="SitWhileDanglingLegs" Frequency="100"/>
      <BehaviorReference Name="LieDown" Frequency="100"/>
    </NextBehaviorList>
  </Behavior>
  ...
</Condition>
```

[behaviors.xml L112–131](https://github.com/DalekCraft2/Shimeji-Desktop/blob/bded6e1d477fea12553c53427d86d3b51fa40038/conf/behaviors.xml#L112-L131)（**On Top of IE** 块）：

```xml
<Condition Condition="#{mascot.environment.activeIE.topBorder.isOn(mascot.anchor)}">
  <Behavior Name="WalkAlongIECeiling" Frequency="100" Hidden="true"/>
  <Behavior Name="SitOnTheLeftEdgeOfIE" Frequency="100" Hidden="true"/>
  <Behavior Name="SitOnTheRightEdgeOfIE" Frequency="100" Hidden="true"/>
  <Behavior Name="JumpFromLeftEdgeOfIE" Frequency="100" Hidden="true"/>
  ...
</Condition>
```

→ **「窗沿坐」只写在 IE-top 条件块里**。默认 pack 同时也允许地面坐/躺（这是它的角色设定），
但**它把「地面」和「窗口上沿」建模为两个不同条件块，坐在哪个块里就是产品决策**——我们只需把 `SitDown/LieDown` 从地面块删掉或只保留在 IE-top 块，就得到「只在窗口上坐/躺」。

#### 2.2.3 专用过渡动作（actions.xml）

[actions.xml L333–343](https://github.com/DalekCraft2/Shimeji-Desktop/blob/bded6e1d477fea12553c53427d86d3b51fa40038/conf/actions.xml#L333-L343)：

```xml
<Action Name="StandUp" Type="Sequence" Loop="false">
    <ActionReference Name="Stand" Duration="${500+Math.random()*1000}"/>
</Action>
<Action Name="SitDown" Type="Sequence" Loop="false">
    <ActionReference Name="Sit" Duration="${500+Math.random()*1000}"/>
</Action>
<Action Name="LieDown" Type="Sequence" Loop="false">
    <ActionReference Name="Sprawl" Duration="${500+Math.random()*1000}"/>
</Action>
```

- 默认 2D pack 里 `SitDown` 只是把静态 `Sit` pose 撑 0.5–1.5s（2D 精灵无骨骼 fade），但**结构上它就是「进入姿态的专用非循环动作」**；
  角色包作者可以在 `SitDown` 里放多帧坐下动画（动作类型 `Sequence Loop=false` 的语义就是一次性播完再选下一个 behavior）。
- 窗沿坐序列（[actions.xml L478–494](https://github.com/DalekCraft2/Shimeji-Desktop/blob/bded6e1d477fea12553c53427d86d3b51fa40038/conf/actions.xml#L478-L494)）：`SitOnTheLeftEdgeOfIE` = 走到 `activeIE.left+100..+400` → `Stand` 100–200ms → `Sit` 500–1500ms，即「**靠近→站定→坐下**」三段，不是瞬间切姿态。
- 静态姿态 clip：`Sit`（L46）、`Sprawl`（L103）都是 `Type="Stay" BorderType="Floor"`；`BorderType="Floor"` 是动作级的表面约束（意味着该动作只允许贴在 floor 类边框上）。

#### 2.2.4 行为选择与优先级（可抄的门控结构）

[`Configuration.buildNextBehavior` L516–582](https://github.com/DalekCraft2/Shimeji-Desktop/blob/bded6e1d477fea12553c53427d86d3b51fa40038/src/main/java/com/group_finity/mascot/config/Configuration.java#L516-L580)：

- 候选 = 上一行为 `NextBehaviorList`（`Add=true` 时叠加顶层行为）；
- 过滤条件：`Frequency > 0`、**条件全部为真**（`isEffective`）、对当前 image set 启用；
- **按 Frequency 加权随机**（`random -= getFrequency()`）；
- **无候选时兜底**：把宠物挪到屏幕上方并返回 `Fall` 行为——「当前位置无合法姿态」时宁可掉下去，也不停在非法姿态。

拖拽抢占（[UserBehavior.java L282](https://github.com/DalekCraft2/Shimeji-Desktop/blob/bded6e1d477fea12553c53427d86d3b51fa40038/src/main/java/com/group_finity/mascot/behavior/UserBehavior.java#L282)）：鼠标拖拽时直接 `mascot.setBehavior(buildBehavior("Dragged"))`，绕过条件选择；`behaviors.xml` 顶部把 `Dragged/Thrown/PullUp/Divided` 标为 `ALWAYS REQUIRED`。
→ 即「**拖拽是最高优先级硬中断**」，与 Mate-Engine 的 `blockSitIfBoolTrue/isDragging` 等价。

### 2.3 pixelomer/libshijima + Shijima-Qt（C++ 引擎，跨平台含 macOS）

commit `361f452f3e89cdfaf04624db1c7641e3db410da9`（2026-07-25）；Shijima-Qt `57723f1d7a4ea4a32e5fbb90deb7febc0dd49f63`（2026-04-29，**已归档**）。

- 边框判定比 Java 版宽容：`hborder.is_on` = `fabs(p.y - y) < 1.0 && faces(p)`（[environment.hpp L74–80](https://github.com/pixelomer/libshijima/blob/361f452f3e89cdfaf04624db1c7641e3db410da9/shijima/mascot/environment.hpp#L74-L80)）；`area.is_on(anchor)` = 任一边框命中（[L137–142](https://github.com/pixelomer/libshijima/blob/361f452f3e89cdfaf04624db1c7641e3db410da9/shijima/mascot/environment.hpp#L137-L142)）。
- 环境字段：`floor / work_area / active_ie / sticky_ie`（[L199–207](https://github.com/pixelomer/libshijima/blob/361f452f3e89cdfaf04624db1c7641e3db410da9/shijima/mascot/environment.hpp#L199-L207)）；`on_land()` 把 floor/ceiling/work_area/active_ie 任一命中视为着地（[state.cc L66–72](https://github.com/pixelomer/libshijima/blob/361f452f3e89cdfaf04624db1c7641e3db410da9/shijima/mascot/state.cc#L66-L72)）。
- 两个可复用的「防粘滞 / 跟随」实现：
  - `detach_from_borders()`：离开边框时把 anchor 沿垂直于边框方向推 **1.1px**，避免下一帧又吸附（[manager.cc L85–107](https://github.com/pixelomer/libshijima/blob/361f452f3e89cdfaf04624db1c7641e3db410da9/shijima/mascot/manager.cc#L85-L107)）；
  - `sticky_ie`：窗口移动时把 `active_ie_offset` 累加进 anchor，若新 anchor 仍在 active_ie 上则保持吸附（[manager.cc L186–199](https://github.com/pixelomer/libshijima/blob/361f452f3e89cdfaf04624db1c7641e3db410da9/shijima/mascot/manager.cc#L186-L199)）；`was_on_ie` 在 post_tick 更新（[L206–209](https://github.com/pixelomer/libshijima/blob/361f452f3e89cdfaf04624db1c7641e3db410da9/shijima/mascot/manager.cc#L206-L209)）。
- macOS 平台注意：Shijima-Qt README 明确「**需要辅助功能权限才能访问前台窗口**」（[README L53–55](https://github.com/pixelomer/Shijima-Qt/blob/57723f1d7a4ea4a32e5fbb90deb7febc0dd49f63/README.md#L53-L55)）；API 文档里 `active_behavior` 会直接暴露 `SitDown` 等行为名（[HTTP-API.md L140–152](https://github.com/pixelomer/Shijima-Qt/blob/57723f1d7a4ea4a32e5fbb90deb7febc0dd49f63/HTTP-API.md#L140-L152)），说明「SitDown」是 pack 行为名而非引擎内建姿态。

### 2.4 LorisYounger/VPet（C# WPF）——专用「进入/退出」动画三元组

commit `c26be33d730ea5547711f6cc9781cf94e4d6ac7d`（2026-11-08）。

- 动画定义 = `类型(GraphType) + 名字 + 动作(AnimatType) + 状态(ModeType)`；`AnimatType = { Single, A_Start, B_Loop, C_End }`（[GraphInfo.cs L257–275](https://github.com/LorisYounger/VPet/blob/c26be33d730ea5547711f6cc9781cf94e4d6ac7d/VPet-Simulator.Core/Graph/GraphInfo.cs#L257-L275)），Sleep 是独立 `GraphType`（[L194–196](https://github.com/LorisYounger/VPet/blob/c26be33d730ea5547711f6cc9781cf94e4d6ac7d/VPet-Simulator.Core/Graph/GraphInfo.cs#L194-L196)）。
- 进入睡眠（[MainDisplay.DisplaySleep L332–343](https://github.com/LorisYounger/VPet/blob/c26be33d730ea5547711f6cc9781cf94e4d6ac7d/VPet-Simulator.Core/Display/MainDisplay.cs#L332-L343)）：先播 `Sleep` 的 `A_Start`（躺下过渡），回调后循环 `B_Loop`，`DisplayBLoopingToNomal` 按随机次数后播 `C_End`（[L320–329](https://github.com/LorisYounger/VPet/blob/c26be33d730ea5547711f6cc9781cf94e4d6ac7d/VPet-Simulator.Core/Display/MainDisplay.cs#L320-L329)）再回 normal。
- 醒/起身（[ToolBar.xaml.cs L415–424](https://github.com/LorisYounger/VPet/blob/c26be33d730ea5547711f6cc9781cf94e4d6ac7d/VPet-Simulator.Core/Display/ToolBar.xaml.cs#L415-L424)）：`m.State = WorkingState.Nomal; m.Display(GraphType.Sleep, AnimatType.C_End, m.DisplayNomal);` —— **退出睡眠永远先播 C_End 起身动画**。
- 睡眠状态字段 `WorkingState.Sleep`（[MainLogic.cs L671–684](https://github.com/LorisYounger/VPet/blob/c26be33d730ea5547711f6cc9781cf94e4d6ac7d/VPet-Simulator.Core/Display/MainLogic.cs#L671-L684)）；随机待机里 `case 7: DisplaySleep()`（[L518–551](https://github.com/LorisYounger/VPet/blob/c26be33d730ea5547711f6cc9781cf94e4d6ac7d/VPet-Simulator.Core/Display/MainLogic.cs#L518-L551)）；`IsIdel` 只允许 Default/Work 两型（[L494](https://github.com/LorisYounger/VPet/blob/c26be33d730ea5547711f6cc9781cf94e4d6ac7d/VPet-Simulator.Core/Display/MainLogic.cs#L494)）。
- 它没有窗口表面门控（VPet 宠物是浮在桌面上的窗口，不建模其它窗口上沿），但 **A_Start/B_Loop/C_End 的三段式正是我们缺的「过渡 clip」结构**；另外它在屏幕边缘用 `MoveSideHideCheck` 做「靠边隐藏」姿态（[L568+](https://github.com/LorisYounger/VPet/blob/c26be33d730ea5547711f6cc9781cf94e4d6ac7d/VPet-Simulator.Core/Display/MainLogic.cs#L568-L620)），是同一「表面位置→特殊姿态」思路的 2D 版。

### 2.5 isHarryh/Ark-Pets（Java + Spine 2D）——马尔可夫姿态矩阵（负面样本 + 可插入门控的位置）

commit `574b7c63397827e4e52d9d3e6b0ce726923a32c5`（2026-11-03）。当前默认分支 HEAD。

- `AnimType` 用正则从命名识别 `SIT("^Sit$", 50)`、`SLEEP("^Sleep$", 25)`（[AnimClip.java L29–42](https://github.com/isHarryh/Ark-Pets/blob/574b7c63397827e4e52d9d3e6b0ce726923a32c5/core/src/cn/harryh/arkpets/animations/AnimClip.java#L29-L42)）。
- 姿态切换是**马尔可夫权重矩阵**：行=当前状态，列=目标状态，`{IDLE 40, SIT 20, SLEEP 10, ...}`、`{SLEEP 20, SIT 20, SLEEP 60...}`（[StochasticMatrix.java L16–24](https://github.com/isHarryh/Ark-Pets/blob/574b7c63397827e4e52d9d3e6b0ce726923a32c5/core/src/cn/harryh/arkpets/animations/StochasticMatrix.java#L16-L24)，状态枚举 L28–45）。
- 唯一门控是 config 开关：`if (sitAnim != null && config.behavior_allow_sit) bind(SIT) else disable`、sleep 同理（[GeneralBehavior.java L39–63](https://github.com/isHarryh/Ark-Pets/blob/574b7c63397827e4e52d9d3e6b0ce726923a32c5/core/src/cn/harryh/arkpets/animations/GeneralBehavior.java#L39-L63)）。
- 切换是硬切：Spine `state.setAnimation(track, name, loop)`，无 mix/fade 时长（[AnimComposer.offer L35–47](https://github.com/isHarryh/Ark-Pets/blob/574b7c63397827e4e52d9d3e6b0ce726923a32c5/core/src/cn/harryh/arkpets/animations/AnimComposer.java#L38-L47)）。
- 「站在窗口边缘」是另一套：按宠物所在竖线，把该列上位于宠物下方的窗口上沿转成水平 barrier（`line` map → `plane.setBarrier(...)`，[ArkPets.java L401–470](https://github.com/isHarryh/Ark-Pets/blob/574b7c63397827e4e52d9d3e6b0ce726923a32c5/core/src/cn/harryh/arkpets/ArkPets.java#L400-L470)），并用窗口标题黑名单/透明窗口过滤；FAQ 也承认透明边界会导致悬空站立（[FAQ L20–26](https://github.com/isHarryh/Ark-Pets/blob/574b7c63397827e4e52d9d3e6b0ce726923a32c5/docs/zh_CN/FAQ.md#L20-L26)）。
- 启示：姿态矩阵是一个**非常好的门控插入点**——把「当前 surface 不允许」的行权重清零或把 SIT/SLEEP 从候选里 disable，就能实现「只在允许表面上坐/躺」，比散落 if 更可测。

### 2.6 xiangzi1025/desktop-pet-macos（Electron，与本项目同栈）——有窗沿、但没有姿态门控

commit `5c39419f616ae59da668fb7e7d88e0465b466f8b`（2026-07-26，main）。

- 窗口 ledges：`validWindowLedges` 过滤 `width ≥ 180`、`y` 在 workArea 内缩进（上 60px/下 80px）且与屏幕相交（[behavior.js L282–303](https://github.com/xiangzi1025/desktop-pet-macos/blob/5c39419f616ae59da668fb7e7d88e0465b466f8b/behavior.js#L282-L303)）。
- 支撑判定用「**跨边 + ±4px**」：`candidateY = ledge.y - size.height + 20`、`crossesLedge = previousY <= candidateY + 4 && nextY >= candidateY`（[nearestSupportY L440–471](https://github.com/xiangzi1025/desktop-pet-macos/blob/5c39419f616ae59da668fb7e7d88e0465b466f8b/behavior.js#L433-L475)），落地后按 `supportKind` 区分 `window`/`screen`（[land L520–535](https://github.com/xiangzi1025/desktop-pet-macos/blob/5c39419f616ae59da668fb7e7d88e0465b466f8b/behavior.js#L500-L535)）——这层「支撑面 kind」正是姿态门控可以直接复用的字段。
- 但 **sleep 是随机自主状态**，无表面条件（`startSleep` 只设计时，[L425–429](https://github.com/xiangzi1025/desktop-pet-macos/blob/5c39419f616ae59da668fb7e7d88e0465b466f8b/behavior.js#L425-L429)；`AUTONOMOUS_STATES` L9）；用户有活动时 `registerUserActivity()` 会打断自主状态（[L109–115](https://github.com/xiangzi1025/desktop-pet-macos/blob/5c39419f616ae59da668fb7e7d88e0465b466f8b/behavior.js#L109-L115)）。
- 窗口枚举用 `osascript` 调 System Events（需辅助功能授权），`parseWindowLedges` 丢弃 `width<120 || height<80` 的窗口（[main.js L1016–1088](https://github.com/xiangzi1025/desktop-pet-macos/blob/5c39419f616ae59da668fb7e7d88e0465b466f8b/main.js#L1016-L1088)），1200ms 轮询（[L1107–1125](https://github.com/xiangzi1025/desktop-pet-macos/blob/5c39419f616ae59da668fb7e7d88e0465b466f8b/main.js#L1107-L1125)）。
- 结论：**同栈项目也没解决「姿态只在窗口上」的问题**；它只有「窗沿可走/可落」的支撑判定，sleep 仍然随处可发。我们的需求比它更进一步。

### 2.7 Desktop Mate（闭源商业产品）——「专用过渡 clip」路线的商业证据

- 官方商店页文案（curl 实测页面内 meta description）：「they **sit on your windows**, play with your mouse cursor, and respond to head pats...」— [Steam 3301060](https://store.steampowered.com/app/3301060/Desktop_Mate/)。
- Mate-Engine README 对比表把它列为 `Open Source ❌ / Window Sitting ✅ / Taskbar Sitting ✅`（[README L90–97](https://github.com/shinyflvre/Mate-Engine/blob/2c5ea6b8f4cf5e1773a0816b46d9267cda5174d4/README.md#L90-L97)）——即「窗口坐」是这一品类的基础能力。
- 逆向/Mod 文档（`DesktopMateAssetDecryptor`，commit `425189d`，2026-07-31）给出了可验证的动画资产结构：
  - README：「You will need animations for **Standing(oneShot and loop), Sitting(oneShot and loop)**, Dragged, Stroked(standing and sitting), Picked(standing and sitting), JumpOut, JumpIn, HideLeft, HideRight and Alarm.」（[README L29](https://github.com/Xyzstk/DesktopMateAssetDecryptor/blob/425189db9c4976883d133892cb9d5fff0cf45023/README.md#L29)）
  - 示例工程脚本字段：`standingRandomAnims`、`standingOneShotAnims`、`sittingRandomAnims`、`sittingOneShotAnims`，以及 `strokedStandingAnim/strokedSittingAnim`、`pickedStandingAnim/pickedSittingAnim`（[CharaData.cs L4–28](https://github.com/Xyzstk/DesktopMateAssetDecryptor/blob/425189db9c4976883d133892cb9d5fff0cf45023/ExampleProject/Assets/Scripts/CharaData.cs#L4-L28)）。
  - 也就是说：**进/出坐姿用 one-shot 过渡动画，坐/站各有自己的循环；交互动画按「当前姿态」再分出一套（站着被摸 vs 坐着被摸）**。
- 局限：行为逻辑闭源，以上仅为资产结构/Mod 接口证据，**运行时状态机未验证**。

### 2.8 MidraLab/uDesktopMascot（Unity 6 + VRM，Apache-2.0，支持 macOS）——「有素材、没接线」的反面案例

commit `f00728d9040176469ee9a04092bf7205a5cb887f`（2025-09-12）。

- `CharacterAnimationController.controller` 里已有状态 `Sit_01`、`lie_01`、`lie_02`（[L219 / L245 / L271](https://github.com/MidraLab/uDesktopMascot/blob/f00728d9040176469ee9a04092bf7205a5cb887f/Assets/uDesktopMascot/Resources/CharacterAnimationController.controller#L219-L271)）和参数 `IsSitting`（[L187](https://github.com/MidraLab/uDesktopMascot/blob/f00728d9040176469ee9a04092bf7205a5cb887f/Assets/uDesktopMascot/Resources/CharacterAnimationController.controller#L187)），但 `m_AnyStateTransitions: []`（[L89](https://github.com/MidraLab/uDesktopMascot/blob/f00728d9040176469ee9a04092bf7205a5cb887f/Assets/uDesktopMascot/Resources/CharacterAnimationController.controller#L89)）且**没有任何 transition 指向 Sit/lie 状态**；运行时只把 `IsSitting` 置 false（[CharacterManager.cs L181、L196](https://github.com/MidraLab/uDesktopMascot/blob/f00728d9040176469ee9a04092bf7205a5cb887f/Assets/uDesktopMascot/Scripts/Character/CharacterManager.cs#L181-L196)）。
- 但它已经算出了「是否在 Explorer 窗口上沿 ±50px」：模型屏幕坐标落在窗口 x 范围内且 `顶边-50 <= y <= 顶边+50` → `isNearExplorerTop = true`（[CharacterManager.cs L133–175](https://github.com/MidraLab/uDesktopMascot/blob/f00728d9040176469ee9a04092bf7205a5cb887f/Assets/uDesktopMascot/Scripts/Character/CharacterManager.cs#L139-L175)），只是这个值没被用来驱动姿态。
- 动画切换是 PlayableGraph 两条 clip 按 `blendDuration` 权重插值（[CharacterAnimationController.cs L88–147](https://github.com/MidraLab/uDesktopMascot/blob/f00728d9040176469ee9a04092bf7205a5cb887f/Assets/uDesktopMascot/Scripts/Character/CharacterAnimationController.cs#L88-L147)），与我们 three.js crossfade 同类。
- 启示：**光有 sit/lie clip 不够**；缺的正是「surface → 姿态状态」的接线和「进入/退出用哪条 clip」的决策——这两件事是本项目要补的。

### 2.9 danhab99/shimeji-rs（Rust 现代重写，补充）

commit `028039330e0a15a94edb90ea750251c8db7f2c10`（2026-09-11）。README 明确「window-climbing (`activeIE`)」通过 EWMH `_NET_ACTIVE_WINDOW` 跟踪，且**没有标题白名单/黑名单**（[README L19–20、L89–90、L112–114](https://github.com/danhab99/shimeji-rs/blob/028039330e0a15a94edb90ea750251c8db7f2c10/README.md#L19-L20)）；边框判定用 `0.5px` epsilon（[environment.rs L31–38](https://github.com/danhab99/shimeji-rs/blob/028039330e0a15a94edb90ea750251c8db7f2c10/crates/shimeji-core/src/environment.rs#L44-L50)）。可作为「activeIE 概念在 X11 的现代实现」参考，但无 macOS。

---

## 3. 对本项目的可执行建议（Electron + three.js + three-vrm）

> 与 Lead 本地分析（[lead-local-analysis.md](./lead-local-analysis.md) §2）配套：本地侧 P0-A/P0-B 已有代码级方案；下面是**外部案例直接支持、且本地分析未展开**的三条补充。

### R1（P0）把「表面能力」做成一次查询，姿态只依赖查询结果——不要散落 if

外部依据：Shimeji `getFloor()` 先 activeIE 再 workArea 并返回具体 Border（§2.2.1）；libshijima 用 `on_land()`/`border.is_on` 聚合同一判定（§2.3）；desktop-pet-macos 落地时就带 `supportKind = 'window' | 'screen'`（§2.6）。

落地（对齐现有代码，不新造概念）：
- 在 [`behavior-director.ts`](../../../src/renderer/src/behavior/behavior-director.ts) 的 `buildSchedulerContext`（现有 `sittableSurfaces` / `surfaceKind` 来源）里，把当前支撑面解析为
  `{ kind: 'screen-bottom' | 'dock' | 'window-top' | 'menubar', windowId, top, widthPx, perched, ageMs }`，其中 `perched` = 脚底站在 `window-top` 且该窗沿可见段宽 ≥ 180px、窗口非全屏/最小化（过滤规则照 Mate-Engine `IsSitEligibleWindow`：宽≥200/高≥60、排除桌面/透明/工具窗口、被更高 z 序遮挡的不可坐）。
- `sleep`（[`activities.ts`](../../../src/renderer/src/behavior/activities.ts) `requirements: ['grounded','mouseAway']`）改为 `['grounded','mouseAway','perchOnly']`（新增 requirement，`isRequirementMet` 里查 `context.perchedWindowTop`）；`sit` 的 `sittableSurface` 已存在，但建议给**自动发起**的 sit 增加 `perched` 要求（保留 `trySitOnWindowTop` 的「放置后」入口，把 `prepareSitTarget` 随机走过去坐的路径去掉或降权），这样「被放在窗口上才坐/躺」和用户语义一致。
- 同时加「窗沿状态变化事件」：窗口 close/moved/minimized/fullscreen 时，把 `perched` 置 false 并触发一次 `startFall`/`cancelActivity`（对齐 Mate-Engine §2.1.3 与现有 `handleTransitions` 的 `closed → startFall`）。
- 不要只限制 sleep：如果产品允许 Dock 坐，把 Dock 视为「可坐」但**不可躺/睡**（`dock` 没有 windowId、宽度是全屏工作区，躺上去等于地面躺）。

### R2（P0）进入/退出姿态必须有「过渡」，不能只调长 crossfade

外部依据：Desktop Mate 的 `sittingOneShotAnims/standingOneShotAnims`（§2.7）；VPet `A_Start → B_Loop → C_End`（§2.4）；Shimeji `SitDown/LieDown/StandUp` `Loop=false` 序列（§2.2.3）；Mate-Engine 对差异最大的 Sleep 用 **1.0s** 进入、0.45s 退出，而窗沿躺因为吸附+座位校准只需 0.25s（§2.1.2）。

落地（按成本从低到高，可叠加）：
1. **低成本兜底（1 天内）**：给 `sleep`/窗沿躺槽位的 crossfade 分层配置——进入 ≥0.8–1.0s、退出 ≥0.5s，且过渡期间禁止变体轮换/覆盖（[clip-player.ts](../../../src/renderer/src/vrm/clip-player.ts) 的 `fadeSec`/`VARIANT_SWITCH_CONFIG` 已支持 per-slot 覆盖；`sleep` 现在的 0.2–0.25s 是「瞬躺」的直接来源）。注意 engine-docs 已论证「两个差异极大的姿势直接长 blend 会经过中间失真姿态」，所以这只是兜底。
2. **推荐（2–3 天）**：新增/复用 `lie-down`、`get-up`、`sit-down`、`stand-up` 一次性 clip（catalog 里 `adv-*as`/`adv-*bs` 已是非 loop 片段，数据模型无需改），在 `moodTransitionClips`（[main.ts](../../../src/renderer/src/main.ts) 现有机制）里配 `sleep: { enter: 'lieDown', exit: 'getUp' }`；进入时「站→lieDown→mate-sleep」，退出时「mate-sleep→getUp→idle/walk」。若没有对应素材，用现有 `mate-introStart/mate-introEnd`（Lead 已盘点：2.0s 站→侧躺 / 1.53s 躺→站）作为过渡族，注意与 `mate-sleep` 姿态族差异需要 0.4–0.6s 补偿 fade（Lead §1.5）。
3. **窗沿躺（高窗）**：不要「mood 变 sit 当帧直接 0.3s 切 windowLay」；改成两段——先 `mate-sit1/sitWindow`（0.6–0.8s）把身体落座，再 0.8–1.0s blend 到 `mate-windowLay8/9/10`；加 `sitLieTransitioning` 标志防止 per-frame 覆盖（Lead §2 P0-B2）。**几何上优先使用窗沿系 clip**（windowLay），因为 `mate-sleep` 的地面躺姿在窗沿上会悬空/穿窗。

### R3（P1）抄「吸附 + 回滞 + 中断」的可调数值，避免抖动与「躺一半被拖走」的二次诡异

外部依据（§2.1.3、§2.2.4、§2.3）：Mate-Engine 的 `minDragHoldSecondsToSit=1s`、`minDragPixelsToSnap=4px`、`unsnapCooldownSeconds=0.3s`、`probeRadius=24px`、`guard=240px`、`guardFrames=8`/`latchFrames=18`、`unsnapVerticalBand=16px`；libshijima 的 1.1px detach + 1px 容差；Shimeji 的「无候选行为 → 回退 Fall」。

落地（可映射到本项目现有字段）：
- **进入**：`perched` 需要连续 N 帧（建议 6–8 帧、约 100–130ms）稳定才允许 `sleep`/`lie`；复用 `trySitOnWindowTop` 的 idle 计时思路，并把阈值从 700ms 提高到「被放下后 ≥800ms」或新增 `perchedAtMs` 时间戳。
- **退出**：只有脚底离开窗沿垂直带（建议 16px，可复用 `unsnapVerticalBand` 语义）+ 连续 3–5 帧才退出；退出后 0.3s 内禁止再次进入（`sleep` 冷却沿用 `cooldownMs: 120_000` 太长，建议另加「起身后 20–40s 内不再躺」的短冷却，与 `AUTO_SIT_GAP_MS` 同源）。
- **中断优先级**：拖拽/窗口关闭/DSH 反应 > 起身 > 行走 > 坐/躺。允许用 `moodTransitionClips` 的 exit clip（getUp）做「先起身再进位」，但**拖拽必须允许打断**（对齐 Shimeji 拖拽直接 `setBehavior("Dragged")`、Mate-Engine `isDragging` 清窗沿状态）；窗口关闭时当前实现直接 `startFall`，建议在 fall 之前插 0.2–0.3s 的 `getUp`/`hsr-revive` 过渡，避免「躺着直接变下落」。
- **可观测性**：在 sleep/sit/lie 的进入/退出点各打一条 debug 日志（`surfaceKind/surfaceId/windowId/perched/enterClip/fadeSec/reason`），并在 debug 面板显示 `perchedAgeMs`；这是复现「5 分钟定位」的关键。

> 备注：Desk Mate / Mate-Engine 的窗口坐是 **Windows-only 或闭源**；macOS 上建议走「AX 前台窗口 + CGWindowList 所有窗口」两条来源（Shimeji mac §2.2.1、desktop-pet-macos §2.6），AX 需要辅助功能授权，拿不到时按 `perched=false` 降级（绝不能退化成「地面也能躺」）。
> 过渡 clip 在 three.js/three-vrm 侧的 API 细节（`LoopOnce`/`clampWhenFinished`/finished 事件/交叉淡入顺序）见同目录 [engine-docs.md](./engine-docs.md) §2.5/§3.2，不在此重复。

---

## 4. 来源清单（均为本次实际访问；GitHub 链接 curl 实测 200）

| # | 来源 | commit / 版本 | 用途 | 状态 |
|---|---|---|---|---|
| 1 | [shinyflvre/Mate-Engine](https://github.com/shinyflvre/Mate-Engine)（本地副本 `refs/Mate-Engine` 同 commit） | `2c5ea6b8f4cf5e1773a0816b46d9267cda5174d4`（2026-01-20） | 窗沿吸附/Animator/睡眠门控 | ✅ 200，源码逐行 |
| 2 | [Mate-Engine AvatarWindowHandler.cs](https://github.com/shinyflvre/Mate-Engine/blob/2c5ea6b8f4cf5e1773a0816b46d9267cda5174d4/Assets/MATE%20ENGINE%20-%20Scripts/AvatarHandlers/AvatarWindowHandler.cs) | 同上 | 探测/吸附/回滞/座位校准 | ✅ 200 |
| 3 | [Mate-Engine AvatarSleepController.cs](https://github.com/shinyflvre/Mate-Engine/blob/2c5ea6b8f4cf5e1773a0816b46d9267cda5174d4/Assets/MATE%20ENGINE%20-%20Scripts/AvatarHandlers/AvatarSleepController.cs) | 同上 | 睡眠白名单/计时器 | ✅ 200 |
| 4 | [Mate-Engine AvatarAnimatorController.controller](https://github.com/shinyflvre/Mate-Engine/blob/2c5ea6b8f4cf5e1773a0816b46d9267cda5174d4/Assets/MATE%20ENGINE%20-%20Animations/AvatarAnimatorController.controller) | 同上 | 过渡时长/AnyState/BlendTree 参数 | ✅ 200 |
| 5 | [Mate-Engine AvatarTaskbarController.cs](https://github.com/shinyflvre/Mate-Engine/blob/2c5ea6b8f4cf5e1773a0816b46d9267cda5174d4/Assets/MATE%20ENGINE%20-%20Scripts/AvatarHandlers/AvatarTaskbarController.cs) | 同上 | 任务栏坐立（粉区重叠） | ✅ 200 |
| 6 | [DalekCraft2/Shimeji-Desktop](https://github.com/DalekCraft2/Shimeji-Desktop) | `bded6e1d477fea12553c53427d86d3b51fa40038`（2026-11-04） | 表面条件块/专用过渡动作/行为选择 | ✅ 200，全仓 grep |
| 7 | [Shimeji behaviors.xml](https://github.com/DalekCraft2/Shimeji-Desktop/blob/bded6e1d477fea12553c53427d86d3b51fa40038/conf/behaviors.xml) / [actions.xml](https://github.com/DalekCraft2/Shimeji-Desktop/blob/bded6e1d477fea12553c53427d86d3b51fa40038/conf/actions.xml) | 同上 | IE-top 条件块、SitDown/LieDown/StandUp | ✅ 200 |
| 8 | [Shimeji MascotEnvironment.java](https://github.com/DalekCraft2/Shimeji-Desktop/blob/bded6e1d477fea12553c53427d86d3b51fa40038/src/main/java/com/group_finity/mascot/environment/MascotEnvironment.java) / [MacEnvironment.java](https://github.com/DalekCraft2/Shimeji-Desktop/blob/bded6e1d477fea12553c53427d86d3b51fa40038/src/main/java/com/group_finity/mascot/platform/mac/MacEnvironment.java) | 同上 | getFloor 优先级 / macOS AX 取前台窗口 | ✅ 200 |
| 9 | [pixelomer/libshijima](https://github.com/pixelomer/libshijima) | `361f452f3e89cdfaf04624db1c7641e3db410da9`（2026-07-25） | 引擎级 Border/sticky_ie/detach | ✅ 200，全仓 grep |
| 10 | [libshijima environment.hpp](https://github.com/pixelomer/libshijima/blob/361f452f3e89cdfaf04624db1c7641e3db410da9/shijima/mascot/environment.hpp) / [manager.cc](https://github.com/pixelomer/libshijima/blob/361f452f3e89cdfaf04624db1c7641e3db410da9/shijima/mascot/manager.cc) / [state.cc](https://github.com/pixelomer/libshijima/blob/361f452f3e89cdfaf04624db1c7641e3db410da9/shijima/mascot/state.cc) | 同上 | 1px 容差 / sticky / on_land | ✅ 200 |
| 11 | [pixelomer/Shijima-Qt](https://github.com/pixelomer/Shijima-Qt)（README / HTTP-API.md） | `57723f1d7a4ea4a32e5fbb90deb7febc0dd49f63`（2026-04-29，已归档） | macOS 辅助功能权限；行为名 API | ✅ 200 |
| 12 | [LorisYounger/VPet](https://github.com/LorisYounger/VPet) | `c26be33d730ea5547711f6cc9781cf94e4d6ac7d`（2026-11-08） | A_Start/B_Loop/C_End 三段式 | ✅ 200，全仓 grep |
| 13 | [VPet GraphInfo.cs](https://github.com/LorisYounger/VPet/blob/c26be33d730ea5547711f6cc9781cf94e4d6ac7d/VPet-Simulator.Core/Graph/GraphInfo.cs) / [MainDisplay.cs](https://github.com/LorisYounger/VPet/blob/c26be33d730ea5547711f6cc9781cf94e4d6ac7d/VPet-Simulator.Core/Display/MainDisplay.cs) / [ToolBar.xaml.cs](https://github.com/LorisYounger/VPet/blob/c26be33d730ea5547711f6cc9781cf94e4d6ac7d/VPet-Simulator.Core/Display/ToolBar.xaml.cs) | 同上 | 动画三元组/睡眠进出 | ✅ 200 |
| 14 | [isHarryh/Ark-Pets](https://github.com/isHarryh/Ark-Pets) | `574b7c63397827e4e52d9d3e6b0ce726923a32c5`（2026-11-03） | 马尔可夫姿态矩阵/窗口 barrier | ✅ 200，全仓 grep |
| 15 | [Ark-Pets StochasticMatrix.java](https://github.com/isHarryh/Ark-Pets/blob/574b7c63397827e4e52d9d3e6b0ce726923a32c5/core/src/cn/harryh/arkpets/animations/StochasticMatrix.java) / [GeneralBehavior.java](https://github.com/isHarryh/Ark-Pets/blob/574b7c63397827e4e52d9d3e6b0ce726923a32c5/core/src/cn/harryh/arkpets/animations/GeneralBehavior.java) | 同上 | 姿态权重/config 门控 | ✅ 200 |
| 16 | [xiangzi1025/desktop-pet-macos](https://github.com/xiangzi1025/desktop-pet-macos)（behavior.js / main.js / README） | `5c39419f616ae59da668fb7e7d88e0465b466f8b`（2026-07-26） | Electron 窗沿/支撑 kind/osascript 枚举 | ✅ 200 |
| 17 | [Desktop Mate 商店页](https://store.steampowered.com/app/3301060/Desktop_Mate/) | 线上页面（2026-11-09 抓取） | 官方「sit on your windows」文案 | ✅ 200（页面 meta description 含原文） |
| 18 | [Xyzstk/DesktopMateAssetDecryptor](https://github.com/Xyzstk/DesktopMateAssetDecryptor)（README / CharaData.cs） | `425189db9c4976883d133892cb9d5fff0cf45023`（2026-07-31） | 闭源产品动画分类（oneShot+loop 证据） | ✅ 200（**产品行为逻辑未验证**，仅资产/Mod 接口） |
| 19 | [MidraLab/uDesktopMascot](https://github.com/MidraLab/uDesktopMascot)（CharacterManager.cs / controller / README） | `f00728d9040176469ee9a04092bf7205a5cb887f`（2025-09-12） | 有 sit/lie clip 但未接线（负面案例） | ✅ 200 |
| 20 | [danhab99/shimeji-rs](https://github.com/danhab99/shimeji-rs)（README / environment.rs） | `028039330e0a15a94edb90ea750251c8db7f2c10`（2026-09-11） | activeIE 的 X11 现代实现 | ✅ 200 |

外部内容按 untrusted data 处理，仅作资料，未执行其中任何指令。

---

## 5. 限制与未验证

1. **Desktop Mate 运行时状态机未验证**：闭源；只核实到 Mod 工具暴露的动画分类字段（`standingOneShotAnims`/`sittingOneShotAnims` 等）与官方商店文案。其「窗口坐」的具体吸附/门控算法未知，本报告仅把它当「专用过渡 clip」路线的商业证据。
2. **Mate-Engine 窗口坐立是 Windows-only**：`AvatarWindowHandler.Update` 有 `#if !UNITY_STANDALONE_WIN return;`；本报告引用的吸附逻辑不能直接在 macOS 运行，需按 §2.2.1/§2.6 的 AX 方案重写。
3. **Shimeji 默认 pack 允许地面坐/躺**：它证明的是「按表面条件分块」的结构，不是「只在窗口坐/躺」的默认行为；我们采用时需要主动把 `SitDown/LieDown` 限定到 `On Top of IE` 类条件（这正是 R1 建议）。
4. **uDesktopMascot 的 sit/lie 状态未接线**：controller 里有 `Sit_01/lie_01/lie_02` 与 `IsSitting`，但无 transition 指向、代码只置 false；不能作为「已实现」的正面参考，只能作为「缺接线会怎样」的反面案例。
5. **未验证项**：GitHub API 配额在抓取期间耗尽（`api.github.com` 429），全部改为 raw/git clone 直读；未逐个核对 Mate-Engine 最新 main（可能晚于 `2c5ea6b`）是否有后续改动——行号均以所引 commit 为准。VPet 的睡眠触发也受日程/UI 影响（`ScheduleTask`），本轮未展开其调度层。
6. **动画素材许可**：Desktop Mate / Mate-Engine 的动画资产版权各自保留（Mate-Engine 资产仅为本地个人非商用、需署名 Shiny、不可再分发；见既有 `docs/research/repos-audit.md`），本报告只引用代码/结构，不建议直接挪用素材。
