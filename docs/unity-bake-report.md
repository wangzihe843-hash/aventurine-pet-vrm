# U1 报告：Mate-Engine Humanoid 动作烘焙

日期：2026-11-08
状态：**U1 跑通**（8 个代表性 clip 已导出 + 在戏浪 VRM 上渲染验证）；**U2/U3 已完成**，最终 29 clip 选择、manifest 与三份验收清单见 `docs/wave15-report.md`。**W1.5-Tpose 更新**：目标 VRM 已重制为规范 T-pose（`assets/vrm/aventurine-tpose.vrm`），clip 数据改用 `--axis x` 重烘焙，见 `docs/vrm-tpose-repair.md`。

## 1. 环境

- Unity **6000.2.6f2**（Apple Silicon）已安装，路径 `/Applications/Unity/Hub/Editor/6000.2.6f2/Unity.app`；
- 安装方式：官方 `.pkg`（MD5 与 Unity CDN ETag 一致；Developer ID: Unity Technologies SF；未公证，已手动放行）；
- License：`Unity Personal`（登录账号已脱敏；有效期至 2026-11-18）；
- Unity CLI（Hub 自带 `~/.unity/bin/unity`）可识别编辑器，可用于 `editors -i`、`license`、`logs`、`projects` 等；
- 环境细节与 Unity 中国区/Hub 切换记录见 `scripts/unity-bake/environment.md`。

## 2. 方案调整（相对原 U1/U2 计划）

原计划把 Mate-Engine 工程整个导入 Unity（2.4GB、Package 依赖多、还要找默认 avatar），实测改为**最小工程 + 合成 humanoid 骨架**：

1. 用 Unity 创建空工程 `work/AventurineBakeProj`；
2. 只从 `refs/Mate-Engine/Assets/MATE ENGINE - Animations` 拷 128 个 `.anim`（不导入工程脚本/资源包）；
3. `Editor/ClipExporter.cs` 里用 `AvatarBuilder.BuildHumanAvatar` 合成标准 T-pose 人类骨架（22 骨），把 Humanoid clip 用 `AnimationMode.SampleAnimationClip` 逐帧采样；
4. 导出"相对静止姿势的归一化局部旋转 + Hips 位移"JSON，再转 glTF 右手系。

好处：不依赖 Mate-Engine 的默认 avatar/DLC/Addressables，工程打开/编译快，首次全流程约 1 分钟（缓存后约 20 秒）。

## 3. 关键校准（实测踩坑）

| 问题 | 结论 |
|---|---|
| 手臂朝上/扭曲 | 坐标反射轴用 **Z**（`--axis z`），不是 X；X 反射下手臂翻转 |
| idle 整体横向漂移 0.3–0.4m | Unity humanoid 重定向到合成骨架时 Hips 带常驻偏移；用 `--hips-mode relative` 减去首帧基准 |
| sitWindow/sleep 看起来悬空 | 同上，坐/躺的绝对高度交给 app 摆放；预览只验证姿态 |
| 循环 clip 末帧重复 | 采样时去掉"末帧回 0"逻辑，交给 player loop |
| **合成骨架左右手性** | Unity 左手系（面向 +Z 时 Left 在 **-X**）；初版把 Left 骨放在 +X（镜像），导致手臂 normalized 旋转手性错误（GT 实测手臂 ΔW 166°）。已修正（Left X 取负/Right 取正）并**重烘焙全部 29 clip**：同模型 Unity GT 对拍手臂关节误差 40–60°→~1°（详见 `docs/wave15-report.md` §5） |

## 4. 首批导出结果

| clip | 来源 | 帧数 | 时长 | 循环 | 用途 |
|---|---|---|---|---|---|
| idle | PET_IDLE | 74 | 2.45s | ✓ | 待机 |
| walk | PET_LOCOMOTION/PET_WALK_LEFT | 42 | 1.42s | ✓ | 走动 |
| sitWindow | PET_SITTING/BETA_PET_WINDOW_LAY | 599 | 19.96s | ✓ | 窗沿躺/坐（长 clip，后续可截取片段） |
| drag | PET_MISC/PET_DRAGGING | 385 | 12.78s | – | 被拖拽 |
| sleep | PET_SLEEPING | 1055 | 35.17s | ✓ | 睡觉 |
| happy | PET_MISC/PET_HAPPY | 197 | 6.55s | – | 抚摸/开心反应 |
| hideLeft | PET_HIDING/PET_HIDE_SHOW_LOOP_LEFT | 240 | 8.0s | ✓ | 躲藏/探头循环 |
| introLoop | PET_INTRO/PET_INTRO_LOOP | 400 | 13.33s | ✓ | 开场 |

- 每 clip 22 个 humanoid 骨骼、30fps、四元数模长 1.000；
- 原始导出：`scripts/unity-bake/out/*.json`；转换后：`assets/motions/mate/*.json` + `index.json`（均为私有，gitignore）；
- 预览 evidence：`tests/tmp/clip-preview/`（每 clip 4 帧 + `contact-firstframes.jpg` / `seq-*.jpg`，由 `preview-clips.mjs` 生成，不入库，因为基于私有的戏浪 VRM 渲染）。

## 5. 预览工具

`scripts/unity-bake/preview-clips.mjs`：
- 启动本地静态服务器 + 无头 Electron；
- three-vrm 加载 `assets/vrm/aventurine-tpose.vrm`（W1.5-Tpose；旧资产渲染需 `--axis z` 数据）；
- 把 clip 的 `r` 直接设到 **normalized humanoid 骨骼**（rest 相对旋转），`p` 加到 normalized hips；`vrm.humanoid.update()` 自动转到 raw；
- 逐 clip 抓帧 PNG 并打印骨骼探针，方便排查旋转/位移。

注意：three-vrm 3.x 的 `humanoid.update()` 方向是 **normalized → raw**（不是反过来）；动画必须写在 normalized 骨骼上。

## 6. 下一步（2026-11-08 更新：U2/U3 已完成）

- **U2/U3 已完成**：最终 29 个宠物专属 clip（8 类覆盖达标）+ `assets/motions/mate/manifest.json`（canonical/mirror）+ 数据校验/自然度/覆盖三份清单；工具链（`validate-clips` / `build-motion-manifest` / `preview-clips --all --metrics --yaw` / `contact-sheets`）与报告见 **`docs/wave15-report.md`**。
- **V-lane（V10）**：clip player 消费 `assets/motions/mate/*.json`（normalized 骨骼 + Hips 位移缩放）、动作状态机映射（idle/walk/sit/sleep/drag/hide 映射）、循环与过渡；事件类 clip（intro/hiding/pose）由行为/事件驱动。
- **HSR FBX（2026-11-09 到）**：若可用，走 Blender → VRM 重定向，和本管线并列为动作源；游戏原版 idle/walk 可能比 Mate-Engine 更贴角色。
- 版权：Mate-Engine 动作私有使用；不发布、不随 app 分发。
