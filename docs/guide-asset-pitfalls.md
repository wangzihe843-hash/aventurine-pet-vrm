# 素材管线高频坑（附「直接丢给 AI」模板）

**中文** · [English](guide-asset-pitfalls.en.md)

> 属于 [README](../README.md) 的「不会建模怎么用」系列。
> 上游：[素材去哪找](guide-asset-sourcing.md) · [模型转 VRM](guide-model-conversion.md) ·
> [动作管线](guide-motion-conversion.md)

这一页只讲**转完之后的怪现象**。所有条目都已在仓库里复现、定位到具体脚本或参数，解法是确定的：
**你不需要懂骨骼数学，把现象 + 报错 + 文件名丢给 AI，让它按本页链接的文档复现即可。**

## 速查表

| # | 现象 | 根因 | 解法 | 证据 |
|---|---|---|---|---|
| 1 | 转完模型是**类 A-pose**（手臂下垂 ~40°） | 转换时没把 rest 抬成规范 T-pose | VRMify 重转（默认会抬）；或 Blender 里手工校 T-pose | [`vrm-tpose-repair.md`](vrm-tpose-repair.md) §1.1 |
| 2 | **A-pose 模型套 T-pose 动作**就穿模/反关节 | normalized 动画是「相对 T-pose rest」的旋转，rest 不是 T-pose 就叠常量偏转 | **必须重转模型格式**，只改动作数据救不回来 | [`vrm-tpose-repair.md`](vrm-tpose-repair.md) §1；[`research/wave1-15-pitfalls.md`](research/wave1-15-pitfalls.md) §0-2 |
| 3 | **女体动作转男体后肩关节异常**：溜肩、肩袖塌陷、手臂像被拉长 | 三因叠加（见下节）：`upperChest` 轨道被丢、女体锁骨审美下压、体型比例差 | 已内置：`upperChest` α-fold + 比例感知肩/臂重定向 | [`research/mate-female-to-male-joint-plan-2026-11-11.md`](research/mate-female-to-male-joint-plan-2026-11-11.md) |
| 4 | 手臂**左右镜像 / 抬到头顶** | 手性/朝向错（Unity 左手系 vs VRM1 左手 +X） | 重定向时选对 `--axis x`（VRM1）或 `--axis z`（旧 VRM0/面向 -Z） | [`vrm-tpose-repair.md`](vrm-tpose-repair.md) §1.2 |
| 5 | 走路**滑步 / 脚穿地 / 抖动** | in-place 与脚 IK 口径不一致；VMD 的 IK 开关帧 three 不消费 | 走路/坐起用带脚 IK 的管线；legacy 播 VMD 要 `helper.enable('ik', false)` | [`foot-slide-fix-report.md`](foot-slide-fix-report.md)、[`research/mocap-options.md`](research/mocap-options.md) §4 |
| 6 | 动作条数对但**永远只播 idle** | 清单没被收口、`mood` 写错、`motionSet` 不匹配 | 先跑 `build-app-manifest.mjs --check`，再核 `PET_MOODS` 槽位名 | [`guide-motion-conversion.md`](guide-motion-conversion.md)、[`../scripts/vrm/motion/README.md`](../scripts/vrm/motion/README.md) |
| 7 | Blender **导入官方 FBX 直接崩** | Maya 式 in-between shape keys | 用 `extract-hsr-anims.py` 的 monkey-patch 过滤 `len(entry[3]) > 1` | [`research/wave1-15-pitfalls.md`](research/wave1-15-pitfalls.md) §0-7 |

## 三个需要展开说的

### 1）「转完是类 A-pose」与「A-pose 模型播 T-pose 动作」

这两件事是同一个根因的两面：**VRM 的动画是「相对 T-pose rest」的旋转增量**。模型 rest 若是 A-pose，
播放时整条手臂会带一个常量偏转。本项目旧资产实测偏转 **39.6°**，表现非常典型：

- 手伸出去的动作（drag）看起来正常；
- 手靠近身体的动作（idle 交叉手、走路摆臂）手臂压进躯干/袖子 → 穿模；
- 腿看起来正常（A/T-pose 差异主要在肩臂，腿都竖直）。

结论：**先重转模型（VRMify 默认会抬平），再重烘动作**。只修一边都留着常量误差。

### 2）女体动作套男体：肩关节为什么塌

三个独立原因叠在一起（都有实测数据）：

1. **目标模型没有 `upperChest`**：播放器把整条 `UpperChest` 轨道丢弃，结果是 neck/肩/头相对源**反向旋转**
   （误差角 = 原轨道角度）。30 条 mate clip 里 10 条命中，|U| = 4–10°，肩窝下沉 4.3–6.0 cm。
   HSR/adv 的男性动作 `UpperChest` 全是 identity，所以它们不塌——不只是「男源/体型」的功劳。
2. **女体把锁骨当「下沉 + 后缩」的审美骨用**：`Shoulder` 局部旋转 17–38°，男体参考只有 2.1–7.0°；
   锁骨长 12.34 cm，每多压 1° 肩窝下沉约 2.2 mm。
3. **体型比例差**：上臂+前臂 0.443 m（男体）vs 0.530 m（源女体）= 84%；upperArm 关节点高 0.126 m vs 0.220 m
   = 57%。手臂下垂时两者几乎抵消，但**手前上抬时手位差 10–18 cm**——所以「站姿正常、坐/躺/躲藏坏」。

仓库里的修法（已实现，不是建议）：

- `upperChest` **α-fold**：把被丢弃的轨道折叠进 `chest`，折叠后与 Unity 官方重定向只差 1–3.3°；
- **比例感知肩/臂重定向**：`scripts/unity-bake/proportion-retarget.mjs` / `-v2` / `-v3`，按源视觉姿态
  抬锁骨 + 受限手 IK；推荐参数表在
  [`research/proportion-retarget-prototype-2026-11-11.md`](research/proportion-retarget-prototype-2026-11-11.md)；
- 本项目已产出 **22 条 tuned clip** 放在 `assets/motions/mate-tuned/`（私有、不进 git）。
  干净 clone 需要用上面的脚本重跑，不能指望仓库自带。

> 注意语义边界：能修的是「比例/接触/肩线」这类真实畸变；「动作语汇」（双手抬胸前、掩口、内八）
> 是源动作的表演意图，换男性动作源才能解决，全局参数救不了。详见
> [`research/wave15-male-motion-tune.md`](research/wave15-male-motion-tune.md)。

### 3）没有动捕设备，别让 AI 从零捏动作

这是本项目付过学费的结论：Wave 2 走过程序化姿态路线，**被实测否决**——缺参考、缺可视化回看，
纯写数字只会得到反关节、滑步和诡异手位（根因见 [`anim-strategy.md`](anim-strategy.md) C4）。

动作只有三种可靠来源：实拍/动捕、作者已做好的动作、人工逐帧摆姿 + 截图回看。
AI 该做的是**重定向、修偏移、补接触、批量校验**，不是凭空生成关键帧。

## 直接丢给 AI 的模板

```text
我在「<哪一步>」卡住。现象：<截图 / 报错原文>。
文件：模型 <路径>，动作 <路径>，清单 <路径>，目标 <哪个 clip / 哪个槽位>。
期望：<能站 / 能走 / 肩不塌 / 不穿模 / 不镜像>。
请先读 docs/guide-asset-pitfalls.md 和 <本页对应条目链接>，
用仓库里的脚本复现；先给可选方案（含代价与回滚点），我确认后再动手。
改完跑 pnpm typecheck + pnpm test，并给预览器/截图证据。
```

配套约束（写进给 AI 的要求里，能省很多来回）：

- **先读文档再改**：本页与链接文档已记录根因，不要让 AI 从零「猜」；
- **一次只改一个变量**（`--axis`、`liftFraction`、`timeScale` 分开试），否则无法归因；
- **必须给验证**：`pnpm typecheck` + `pnpm test` + 预览器/三视图截图，缺一不算完成；
- **必须给回滚点**：私有资产不要原地覆盖，先备份或用 `assets/motions/*.before-*.json`；
- **不许生成动作**：没有实拍数据时，拒绝「让 AI 生成一套待机动作」这类请求。
