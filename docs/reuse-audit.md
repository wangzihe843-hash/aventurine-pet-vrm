# v1 复用/替换审计（Phase 3 基线）

> 审计对象：`/Volumes/4TB外置盘/deepseek-harness/aventurine-pet`（v1 工作区，含 Wave 2.5 未提交改动快照）
> 审计日期：2026-11-08 · 结论：**约 55% 直接复用；渲染/动画/模型层替换**

## 1. 总量

| 项 | 数值 |
|---|---|
| `src/` TypeScript | 约 28,320 行（含 debug/入口） |
| `tests/` | 59 个测试文件 / 约 21,900 行 |
| `src/main + preload + shared` | 5,797 行 |
| renderer 各模块 | 约 21,500 行（其中 animation 8,526、interaction 2,508、behavior 3,121） |
| `native/`（Swift） | 195 行 |
| `bridge/`（DSH 桥插件） | 726 行 |

## 2. 模块级处置

| 模块 | 行数 | 处置 | 原因 / 迁移方式 |
|---|---|---|---|
| `src/main/**` | 5,067 | ✅ 保留 | 透明 overlay/点击穿透/winlist/drag/DSH watcher/config/tray 与模型无关 |
| `src/preload/**` | 93 | ✅ 保留 | IPC 白名单，新增 VRM 配置读取即可 |
| `src/shared/**` | 637 | ✅ 扩展 | 新增 `vrm.ts` / `animation-contract.ts`；旧 PMX manifest 由 V4 清理 |
| `renderer/behavior/**` | 3,121 | ✅ 保留 | 状态机/活动/随机调度；只改动画回调 |
| `renderer/physics/**` | 1,221 | ✅ 保留 | 拖拽/惯性/重力/窗口上沿碰撞；模型高度从 VRM bbox 传入 |
| `renderer/desktop/**` | 1,152 | ✅ 保留 | 窗口探测消费/坐窗/爬行/跟随/目标可见性过滤 |
| `renderer/interaction/**` | 2,508 | ✅ 保留 | 指针/拖拽/摸头/触摸区/右键菜单；头骨换 VRM humanoid `head` |
| `renderer/settings/**` | 825 | ✅ 扩展 | 增加 modelBackend/animBackend 选项 |
| `renderer/reactions/**` | 260 | ✅ 保留 | DSH 反应 → 新 clip 名映射 |
| `renderer/core/**` | 1,341 | ⚠️ 部分 | bubble/voicelines/wave2-contract 保留；`pet-runtime` 动画接线改 |
| `renderer/assets/**` | 366 | ⚠️ 部分 | `pet-asset://`、重试加载保留；manifest 换 VRM/motions |
| `renderer/scene/**` | 1,742 | 🔁 替换 | three-vrm 场景；仅 fps-limiter/pixel-ratio 保留 |
| `renderer/model/**` | 476 | 🔁 替换 | PMX layout/bounding/morph-map → VRM 版本 |
| `renderer/animation/**` | 8,526 | 🔁 替换（legacy 保留） | VMD/程序化 → humanoid clip/expression/spring；v1 实现移到 `animation/legacy/` |
| `native/winlist` | 195 | ✅ 保留 | CoreGraphics 窗口枚举 |
| `bridge/dsh-aventurine-bridge` | 726 | ✅ 保留 | 文件桥（status.json/events.jsonl） |
| `scripts/anim-pipeline/**` | — | ⚠️ 归档 | PMX/VMD 转换脚本移 `scripts/legacy/` 参考；不再进入主线 |
| `scripts/{build-native,prepare-assets,profile,worktree}` | — | ✅ 保留 | 构建/环境脚本 |
| `docs/anim-*.md` 等 | — | ✅ 保留 | 调研/验收/参考清单继续有效 |
| `tests/**` | 59 文件 | ⚠️ 部分 | 11 个 `animation-*` 测试随实现替换；desktop/behavior/physics/interaction/bridge/main 测试保留适配 |

## 3. 测试分类（v1）

| 前缀 | 文件数 | 处置 |
|---|---|---|
| animation* | 11 | 重写（新 humanoid/spring/expression 测试） |
| interaction* | 7 | 保留（头骨引用调整） |
| desktop* | 5 | 保留 |
| pet* | 3 | 部分（运行时接线） |
| dsh* / bridge* | 5 | 保留 |
| protocol / overlay / window / tray / winlist / assets / settings / shared / physics / behavior / renderer / scripts / voicelines / vpd2vmd | 其余 | 大部分保留；V4 适配 |

## 4. 明确丢弃/归档

- PMX 模型加载与材质 morph 映射（`model/morph-map.ts` 系列）
- VMD 外部动作驱动/转换（`animation/external/**`、`scripts/anim-pipeline/**` 的转换器）
- PMX 专属程序化姿态库（`animation/poses/**`）——保留在 `legacy/` 供回退与对照
- 与 PMX 绑定的场景/包围盒/描边实现

## 5. 新工作区已继承

- 全部 `src/ / tests/ / scripts/ / native/ / bridge/ / docs/` 工作树（含 v1 未提交的 Wave 2.5 改动）
- `docs/archive/PLAN-v1.md`（v1 计划归档）
- 私有资产与参考项目见 `PLAN.md` §2 与 `refs/README.md`
