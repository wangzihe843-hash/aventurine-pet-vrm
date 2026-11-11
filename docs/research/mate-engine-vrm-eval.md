# Mate-Engine / VRM 路线评估（2026-11-08）

用户提出：「把模型转成 VRM，对 Mate-Engine 做点改动（mac 适配 + 接 DeepSeek Harness），直接用优化后的 Mate-Engine」。
本文件记录事实核查与建议。

## 事实核查

| 项 | 结论 | 来源 |
|---|---|---|
| Mate-Engine 源码 | **完整 Unity 工程**（`Assets/`、`ProjectSettings/`、`Packages/`、`UMotionData/` 等），不是只有资产 | GitHub 仓库根目录 API 列表 |
| Unity 版本 | **6000.2.6f2**（Unity 6） | `ProjectSettings/ProjectVersion.txt` |
| 许可 | MateEngine Pro License v2.1 + AGPL v3 混合；**允许私下修改**；衍生作品要求以同许可公开完整源码（非商业代码托管平台），禁止在 Steam/itch 等商业或二进制分发平台发布 | `LICENSE.md` |
| 平台 | Steam 商店版面向 Windows（主仓库为 Unity Windows 工程） | README / 工程配置 |
| macOS 支持 | 有**非官方**移植仓库 [coffeecat-meow/Mate-Engine-MacOS-Port](https://github.com/coffeecat-meow/Mate-Engine-MacOS-Port)，但状态 **Pre-Alpha、无 release**；roadmap 中透明窗口/置顶/点击穿透/CoreGraphics 窗口探测/Dock 交互均未完成 | 仓库 README |
| 模型支持 | **支持自定义 VRM**（MToon、spring bone 物理、舞蹈/拖拽/坐窗口/任务栏等行为自带） | 仓库 README |
| LLM | 内置 Qwen 2.5 1.5b（Apache 2.0）用于角色对话/事件消息；DSH 本身不是 OpenAI 兼容 LLM 服务，接入需要额外桥接 | 仓库 README |

## 结论

1. 「直接给 Mate-Engine 做 mac 适配 + 接 DSH」= 完成官方 macOS 移植（Unity 6 + Xcode + AppKit 原生窗口层 + CoreGraphics 窗口探测 + 权限）并给 DSH 写桥接；这是**项目级**工作量（远大于当前桌宠剩余打磨），且是非官方移植仓库的未完成部分。
2. 但 Mate-Engine 的**核心价值**（VRM + spring bone 物理 + 动作/交互/坐窗行为）可以在我们现有 Electron 壳里通过 **three-vrm** 获得：保留已验证的窗口探测/点击穿透/行为/DSH 集成，仅替换模型渲染层；spring bone 会直接解决「衣服穿模/头发僵硬」，VRM humanoid 也让悬空拖拽姿态更自然。
3. 前提都是**把 PMX 转成 VRM**：Blender + MMD Tools 导入 PMX → 绑定 humanoid → 给衣摆/发梢加 spring bone → VRM addon 导出。

## 建议路径

- **推荐（Phase 1）**：用户/Lead 在 Blender 完成 PMX→VRM（本地私有，不分发），我在 app 里加 three-vrm 渲染路径（复用现有 PoseDriver/行为/桌面感知）。
- **可选（Phase 2）**：若坚持 Mate-Engine，基于官方 Unity 工程做 macOS build（Unity 6 + Xcode），再实现其 roadmap 的窗口层，并为 DSH 写 LLM/事件桥接；工作量大、需持续投入。
- 现有 PMX 路线继续可用（无需 VRM），但布料/头发无物理，穿模/僵硬只能靠调动作。
