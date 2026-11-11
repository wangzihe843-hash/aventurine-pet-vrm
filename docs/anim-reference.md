# Mate-Engine 动画参考清单（仅参考，不含资产）

> 来源：<https://github.com/shinyflvre/Mate-Engine>，分支 `main`，commit `2c5ea6b`（2026-01-20）。
> 抓取方式：GitHub Trees API 读取文件树（只取文件名与大小，未下载动画资产本身）。
> 用途：**仅作为姿态/状态/时长参考**。Mate-Engine 动画资产版权 © Shiny，个人非商业使用需署名、不得单独再分发；我们**不复制、不搬运动画文件**。
> 格式：全部为 Unity **Humanoid muscle `.anim`**（YAML，`RootT.*`/`LeftFootT.*` 等 muscle 曲线），three.js 不能直接加载，详见 `PLAN.md` §11.1。

## 统计

- `Assets/MATE ENGINE - Animations/` 共 **128** 个 `.anim`。
- **排除舞蹈 19 个**：PET_DANCING 全部 17 个 + `PET_IDLE/CUSTOM_DANCE.anim` + `U_MOTIONS/AnkhaZone.anim`。
- 本清单收录 **109** 个。

| 分类 | 收录数 | 总大小 | 用途 |
|---|---|---|---|
| PET_IDLE | 34 | 205.1 MB | 待机循环（核心参考） |
| PET_SITTING | 26 | 120.8 MB | 坐姿，含坐窗口（核心参考） |
| PET_LOCOMOTION | 7 | 12.1 MB | 走路循环 |
| PET_MISC | 9 | 29.8 MB | 拖拽/开心/害羞/悬停等互动 |
| PET_SLEEPING | 1 | 5.4 MB | 睡觉 |
| PET_HIDING | 6 | 49.1 MB | 躲藏/探头/窗口边缘隐藏 |
| FACE_LAYER | 6 | 133 KB | 面部叠加/表情层（拖拽、摸头、待机） |
| PET_INTRO | 4 | 7.0 MB | 开屏/入场动画 |
| PET_POSE | 4 | 42.2 MB | 摆 pose 循环 |
| UPDATE_2 | 5 | 23.3 MB | 待机补充 + 说话口型 |
| U_MOTIONS | 2 | 80.4 MB | 浮动/长待机（可参考、非核心） |
| PET_BIG_SCREEN | 5 | 75.4 MB | 屏保/大屏模式（可选，非核心） |

## 与 B3 程序化姿态的对应关系

| 我们的姿态（B3） | 可参考的 Mate-Engine 片段 |
|---|---|
| 站立/待机呼吸 | `PET_IDLE.anim`、`PET_IDLE_1..22`、`UPDATE_2/*` |
| 走路 | `PET_WALK_LEFT/RIGHT`、`walk_cycle_*` |
| 坐窗口/窗沿 | `BETA_PET_WINDOW_LAY 1–7`、`WINDOW_LAY_8/9/10` |
| 普通坐下 | `PET_SIT_01..07`、`suwari1/3`、`sit 1` |
| 睡觉 | `PET_SLEEPING` |
| 被拖拽/甩出 | `PET_DRAGGING`、`FACE_DRAG` |
| 摸头/开心 | `PET_HAPPY`、`FACE_HAIR_STROKE`、`FACE_SMILE*`、`PET_LAUGHING`、`PET_SHY_POINT` |
| 躲藏/探头 | `PET_HIDE`、`PET_HIDE_SHOW_LOOP_LEFT/RIGHT` |
| 开屏/完成庆祝 | `PET_INTRO_START/LOOP/END` |
| 说话/口型 | `PET_TALKING`、`FACE_INTIME`、`FACE_IDLE_1` |
| 随机摆 pose | `PET_POSE_1..4` |
| 鼠标悬停反应 | `HoverFace`、`HoverReaction` |

> 爬行/翻越窗口、扒窗、偷看、推窗、跳跃等动作 Mate-Engine 没有直接对应，由我们程序化实现。

## PET_IDLE（34）

| 文件 | 大小 | 参考 |
|---|---|---|
| `HUS_DRAG.anim` | 1.0 MB | 男角色（Husbando）专用 |
| `HUS_IDLE01.anim` | 2.0 MB | 男角色（Husbando）专用 |
| `HUS_IDLE02.anim` | 2.3 MB | 男角色（Husbando）专用 |
| `HUS_IDLE03.anim` | 544 KB | 男角色（Husbando）专用 |
| `HUS_IDLE04.anim` | 1.7 MB | 男角色（Husbando）专用 |
| `HUS_IDLE05.anim` | 968 KB | 男角色（Husbando）专用 |
| `HUS_IDLE06.anim` | 1.1 MB | 男角色（Husbando）专用 |
| `HUS_IDLE07.anim` | 548 KB | 男角色（Husbando）专用 |
| `HUS_IDLE08.anim` | 3.2 MB | 男角色（Husbando）专用 |
| `HUS_IDLE09.anim` | 708 KB | 男角色（Husbando）专用 |
| `HUS_SITTING.anim` | 594 KB | 男角色（Husbando）专用 |
| `PET_IDLE 1.anim` | 907 KB | 待机 |
| `PET_IDLE.anim` | 907 KB | 待机 |
| `PET_IDLE_10.anim` | 3.6 MB | 待机 |
| `PET_IDLE_11.anim` | 3.7 MB | 待机 |
| `PET_IDLE_12.anim` | 3.1 MB | 待机 |
| `PET_IDLE_13.anim` | 3.7 MB | 待机 |
| `PET_IDLE_14.anim` | 3.9 MB | 待机 |
| `PET_IDLE_15.anim` | 4.3 MB | 待机 |
| `PET_IDLE_16.anim` | 12.9 MB | 待机 |
| `PET_IDLE_17.anim` | 9.9 MB | 待机 |
| `PET_IDLE_19.anim` | 20.0 MB | 待机 |
| `PET_IDLE_2.anim` | 14.3 MB | 待机 |
| `PET_IDLE_20.anim` | 13.2 MB | 待机 |
| `PET_IDLE_21.anim` | 18.2 MB | 待机 |
| `PET_IDLE_22.anim` | 12.6 MB | 待机 |
| `PET_IDLE_3.anim` | 13.5 MB | 待机 |
| `PET_IDLE_4.anim` | 14.1 MB | 待机 |
| `PET_IDLE_5.anim` | 10.7 MB | 待机 |
| `PET_IDLE_6.anim` | 6.0 MB | 待机 |
| `PET_IDLE_7.anim` | 9.8 MB | 待机 |
| `PET_IDLE_8.anim` | 6.3 MB | 待机 |
| `PET_IDLE_9.anim` | 3.4 MB | 待机 |
| `PET_IDLE_NON_1.anim` | 1.3 MB | 待机 |

## PET_SITTING（26）

| 文件 | 大小 | 参考 |
|---|---|---|
| `BETA_PET_WINDOW_LAY.anim` | 496 KB | 坐窗口/窗沿姿态 |
| `BETA_PET_WINDOW_LAY_2.anim` | 202 KB | 坐窗口/窗沿姿态 |
| `BETA_PET_WINDOW_LAY_3.anim` | 202 KB | 坐窗口/窗沿姿态 |
| `BETA_PET_WINDOW_LAY_4.anim` | 202 KB | 坐窗口/窗沿姿态 |
| `BETA_PET_WINDOW_LAY_5.anim` | 106 KB | 坐窗口/窗沿姿态 |
| `BETA_PET_WINDOW_LAY_6.anim` | 91 KB | 坐窗口/窗沿姿态 |
| `BETA_PET_WINDOW_LAY_7.anim` | 105 KB | 坐窗口/窗沿姿态 |
| `PET_SIT_01.anim` | 1.1 MB | 坐姿 |
| `PET_SIT_02.anim` | 2.7 MB | 坐姿 |
| `PET_SIT_03.anim` | 21.1 MB | 坐姿 |
| `PET_SIT_04.anim` | 5.9 MB | 坐姿 |
| `PET_SIT_05.anim` | 10.0 MB | 坐姿 |
| `PET_SIT_06.anim` | 15.1 MB | 坐姿 |
| `PET_SIT_07.anim` | 16.2 MB | 坐姿 |
| `PET_SIT_SMOOTHIE_01.anim` | 17.4 MB | 坐姿 |
| `PET_SITTING_DEMO.anim` | 126 KB | 坐姿 |
| `PET_SITTING_DEMO_2.anim` | 110 KB | 坐姿 |
| `sippose39.anim` | 103 KB | 坐姿 |
| `sipposeC06.anim` | 95 KB | 坐姿 |
| `sit 1.anim` | 346 KB | 坐姿 |
| `suwari1.anim` | 8.6 MB | 坐姿 |
| `suwari1_copy.anim` | 17.4 MB | 坐姿 |
| `suwari3.anim` | 1016 KB | 坐姿 |
| `WINDOW_LAY_10.anim` | 847 KB | 坐窗口/窗沿姿态 |
| `WINDOW_LAY_8.anim` | 797 KB | 坐窗口/窗沿姿态 |
| `WINDOW_LAY_9.anim` | 649 KB | 坐窗口/窗沿姿态 |

## PET_LOCOMOTION（7）

| 文件 | 大小 | 参考 |
|---|---|---|
| `PET_WALK_LEFT.anim` | 2.2 MB | 走路循环 |
| `PET_WALK_RIGHT.anim` | 2.2 MB | 走路循环 |
| `walk_cycle_sexy_01_light.anim` | 1.2 MB | 走路循环 |
| `walk_cycle_sexy_02.anim` | 2.2 MB | 走路循环 |
| `walk_cycle_sexy_02_light.anim` | 1.2 MB | 走路循环 |
| `walk_cycle_sexy_03.anim` | 2.2 MB | 走路循环 |
| `walk_cycle_sexy_03_light.anim` | 1.1 MB | 走路循环 |

## PET_MISC（9）

| 文件 | 大小 | 参考 |
|---|---|---|
| `FACE_SMILE 1.anim` | 9 KB | 面部叠加（拖拽/摸头/待机） |
| `FACE_SMILE.anim` | 9 KB | 面部叠加（拖拽/摸头/待机） |
| `HoverFace.anim` | 907 KB | 鼠标悬停反应 |
| `HoverReaction.anim` | 907 KB | 鼠标悬停反应 |
| `PET_DRAGGING.anim` | 3.9 MB | 被拖拽 |
| `PET_HAPPY.anim` | 2.8 MB | 开心/害羞互动 |
| `PET_LAUGHING.anim` | 8.7 MB | 开心/害羞互动 |
| `PET_SHY_POINT.anim` | 11.9 MB | 开心/害羞互动 |
| `PLACE_HOLDER_ANIMATION.anim` | 850 KB |  |

## PET_SLEEPING（1）

| 文件 | 大小 | 参考 |
|---|---|---|
| `PET_SLEEPING.anim` | 5.4 MB | 睡觉 |

## PET_HIDING（6）

| 文件 | 大小 | 参考 |
|---|---|---|
| `PET_HIDE 1.anim` | 4.9 MB | 躲藏/探头 |
| `PET_HIDE.anim` | 4.9 MB | 躲藏/探头 |
| `PET_HIDE_SHOW_LOOP_LEFT.anim` | 19.5 MB | 躲藏/探头 |
| `PET_HIDE_SHOW_LOOP_RIGHT.anim` | 19.5 MB | 躲藏/探头 |
| `TEST_HIDE_LEFT.anim` | 201 KB | 躲藏/探头 |
| `TEST_HIDE_RIGHT.anim` | 201 KB | 躲藏/探头 |

## FACE_LAYER（6）

| 文件 | 大小 | 参考 |
|---|---|---|
| `FACE_DRAG.anim` | 25 KB | 被拖拽 |
| `FACE_HAIR_STROKE.anim` | 24 KB | 面部叠加（拖拽/摸头/待机） |
| `FACE_IDLE_1.anim` | 31 KB | 面部叠加（拖拽/摸头/待机） |
| `FACE_INTIME.anim` | 25 KB | 面部叠加（拖拽/摸头/待机） |
| `FACE_RESET.anim` | 23 KB | 面部叠加（拖拽/摸头/待机） |
| `PET_HAPPY.anim` | 5 KB | 开心/害羞互动 |

## PET_INTRO（4）

| 文件 | 大小 | 参考 |
|---|---|---|
| `PET_INTRO.anim` | 3.4 MB | 开屏/入场 |
| `PET_INTRO_END.anim` | 1.0 MB | 开屏/入场 |
| `PET_INTRO_LOOP.anim` | 1.6 MB | 开屏/入场 |
| `PET_INTRO_START.anim` | 1.0 MB | 开屏/入场 |

## PET_POSE（4）

| 文件 | 大小 | 参考 |
|---|---|---|
| `PET_POSE_1.anim` | 12.4 MB | 摆 pose |
| `PET_POSE_2.anim` | 12.2 MB | 摆 pose |
| `PET_POSE_3.anim` | 5.2 MB | 摆 pose |
| `PET_POSE_4.anim` | 12.3 MB | 摆 pose |

## UPDATE_2（5）

| 文件 | 大小 | 参考 |
|---|---|---|
| `PET_IDLE_UPDATE2_01.anim` | 6.1 MB | 待机 |
| `PET_IDLE_UPDATE2_02.anim` | 5.3 MB | 待机 |
| `PET_IDLE_UPDATE2_03.anim` | 4.8 MB | 待机 |
| `PET_IDLE_UPDATE2_04.anim` | 7.2 MB | 待机 |
| `PET_TALKING.anim` | 11 KB | 说话口型 |

## U_MOTIONS（2）

| 文件 | 大小 | 参考 |
|---|---|---|
| `Float 2.anim` | 29.4 MB |  |
| `Float v3.anim` | 51.0 MB |  |

## PET_BIG_SCREEN（5）

| 文件 | 大小 | 参考 |
|---|---|---|
| `BIG_SCREEN_01.anim` | 14.1 MB | 屏保/大屏（可忽略） |
| `SCREEN_SAVER_01.anim` | 28.5 MB | 屏保/大屏（可忽略） |
| `SCREEN_SAVER_02.anim` | 13.5 MB | 屏保/大屏（可忽略） |
| `SCREEN_SAVER_03.anim` | 14.1 MB | 屏保/大屏（可忽略） |
| `SCREEN_SAVER_04.anim` | 5.1 MB | 屏保/大屏（可忽略） |

## 已排除（舞蹈）

| 文件 | 分类 | 大小 |
|---|---|---|
| `AnkhaZone.anim` | U_MOTIONS | 2.2 MB |
| `CUSTOM_DANCE.anim` | PET_IDLE | 907 KB |
| `HUS_DANCE_01.anim` | PET_DANCING | 6.9 MB |
| `HUS_DANCE_02.anim` | PET_DANCING | 10.8 MB |
| `HUS_DANCE_03.anim` | PET_DANCING | 6.2 MB |
| `HUS_DANCE_04.anim` | PET_DANCING | 3.2 MB |
| `PET_DANCING.anim` | PET_DANCING | 20.1 MB |
| `PET_DANCING_10.anim` | PET_DANCING | 13.9 MB |
| `PET_DANCING_11.anim` | PET_DANCING | 14.3 MB |
| `PET_DANCING_12.anim` | PET_DANCING | 3.2 MB |
| `PET_DANCING_13.anim` | PET_DANCING | 6.9 MB |
| `PET_DANCING_2.anim` | PET_DANCING | 1.2 MB |
| `PET_DANCING_3.anim` | PET_DANCING | 1.5 MB |
| `PET_DANCING_4.anim` | PET_DANCING | 673 KB |
| `PET_DANCING_5.anim` | PET_DANCING | 659 KB |
| `PET_DANCING_6.anim` | PET_DANCING | 763 KB |
| `PET_DANCING_7.anim` | PET_DANCING | 1.4 MB |
| `PET_DANCING_8.anim` | PET_DANCING | 748 KB |
| `PET_DANCING_9.anim` | PET_DANCING | 1.8 MB |

## 其它目录的动画（未纳入）

| 目录 | 数量 | 说明 |
|---|---|---|
| `Assets/MATE ENGINE - Custom Dance Player/` | 2 | 舞蹈播放器动画 |
| `Assets/MATE ENGINE - DLCs/` | 1 | DLC 配件（赛博界面） |
| `Assets/MATE ENGINE - Mod SDK/DanceModExample/` | 1 | 舞蹈 mod 示例 |
| `Assets/QuQu/Sakura_Halo/Animation/` | 2 | 樱花光环配件动画 |
| `Assets/UMotionExamples/Exported Animations/` | 4 | UMotion 插件示例（第三方） |
| `Assets/[CooGee Works]/HeartParticle_MA_Gimmick/` | 22 | 粒子/手势特效（不做粒子） |
| `Assets/noirunn/KawaiiMacaronMotion/` | 2 | 食物系统道具 |

> 这些 `.anim` 只有参考价值；实现仍按 PLAN §11.1 走程序化姿态（B3），或以后单独启动 B8。
