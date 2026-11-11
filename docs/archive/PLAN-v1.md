# 砂金·戏浪 全局桌宠 — 实施计划（PLAN）

> 状态：**Wave 0（M0-1 / M0-2 / M0-3）已完成并合入 main（2026-11-07）；Wave 0.5「Wave 1 开工前置修复」已完成并复验（§17.3-10 / §17.5、§17.4 修复批次）；Wave 1（A1–A5）已全部完成并合入 main（2026-11-07，见 §19）；**Wave 0–1 独立审查修复批次已完成**（3 HIGH + 11 MED + LOW/NIT 全部处理，见 §19.9），Wave 2 可开工**；Wave 2 开工前后先读 §17.3 关键决策、§17.5 前置清单、§18 调研记录、§19.6 接口现状、§19.9 修复记录。
> 目标平台：macOS（本机 macOS 27.0.1 / arm64）。
> 模型：星穹铁道「砂金·戏浪」优化版 PMX（作者：流云景 / 优化：Lily0725，版权 miHoYo）。
> **模型仅限本机个人使用，禁止二次配布、禁止商用；模型资源不得提交到任何仓库、不得发布、不得随 app 分发。**
> 代码部分（本项目）不受该限制。

---

## 0. 一句话目标

做一个 **独立 macOS 应用**：透明悬浮在所有窗口之上的「砂金·戏浪」全身 3D 桌宠。它会站在桌面角落、长时间没操作时自己活动、能坐在窗口/菜单栏/Dock 上、能爬窗口、能随机捣乱、能被拖拽甩出、能真实拖动其它窗口，并与 DSH 的任务状态联动。

**不做**：舞蹈、粒子特效、离线 LLM 闲聊、多角色同屏（后续可扩展）。

---

## 1. 已确认决策（D1–D10）

| ID | 决策 | 说明 |
|---|---|---|
| D1 | 形态：**独立 Electron 应用**，不是 DSH 插件 | 只有独立程序才能做全局悬浮/置顶/坐别的应用窗口；DSH 皮肤只能在 DSH 页面内 |
| D2 | 渲染：**three.js + MMDLoader 直接读 PMX** | 不转 VRM；在线 PMX→VRM 会丢 toon/sphere/材质 morph/物理。资源已准备好（见 §3） |
| D3 | 窗口：**每显示器一个透明无边框置顶窗口** + 点击穿透 | `screen-saver` 层级、所有 Space/全屏应用之上；鼠标悬停宠物区域时才拦截点击 |
| D4 | **真实拖动其它窗口**：做，需要「辅助功能」权限 | 未授权时自动降级为"扒着窗口晃"的视觉效果，不阻断使用 |
| D5 | **DSH 联动**：做，独立 host-only 桥接插件 + 文件通道 | 不再依赖已卸载的皮肤插件；桥接插件写 `~/.dsh/aventurine-pet/`，app 尾随文件；DSH 未运行时静默 |
| D6 | 尺寸：**默认 50% 屏高**（1080p = 540px；原定 30%≈324px，**2026-11-07 用户实机对比后确认改为 50% 近景默认**，见 §19.8），设置里可调 **10%–100%**（2026-11-07 用户再次放宽上限，见 §19.11）；**100% 时受 overlay 窗口高度 `display.workArea.height` 封顶**（1080p：1080→961/963，宠物不出窗） | 50% 为默认近景模式（见 §13 说明）；30% 可作标准大小切换；100% ≈ 满工作区高；实现时所有锚点/点击区域按比例换算 |
| D7 | 「乱爬捣乱」：**随机**，加权随机 + 冷却 + 上下文感知 | 窗口/菜单栏/Dock/闲置时长/鼠标位置/DSH 状态都会影响权重；可在设置里整体关闭 |
| D8 | 技术栈：electron-vite + TypeScript + three.js + electron-builder + Swift 原生助手 | Swift 助手用于窗口枚举/拖窗，随 app 打包 |
| D9 | 无本地 LLM / 无联网 | 台词用脚本气泡；声音可选用 macOS `say` 或本地音效素材 |
| D10 | 资产策略：`assets/model/` **gitignore**，打包只在本机 | 任何公开仓库/分享包必须排除模型；发布版应做成"用户自备模型"（可选后续） |

---

## 2. 当前已就绪的资产（勿重复劳动）

- 模型（已解包、贴图已统一 PNG、PMX 内贴图名已同步）：
  - `assets/model/星穹铁道—砂金·戏浪.pmx`
  - `assets/model/*.png`（28 张，含官方 `Avatar_AventurineW_00_Body_Color_A_LA.png`）
  - `assets/model/使用规则.txt`
- 数据（2026-11-07 完整解析 PMX 复核，读到文件末尾 0 字节残留）：32,966 顶点 / 51,829 三角 / 39 材质 / 382 骨骼（含 4 根 IK 足骨）/ 85 表情 morph / 20 贴图引用（已全部校验存在）；14 个「表示枠」只是 MMD 的 UI 分组，**不是预设姿势**。
- 资源产物（M0-3；Wave 0.5 修复后）：`assets/model/optimized/` = **20 张优化贴图 + PMX 字节级副本（共 21 文件，gitignore）**，供 `pet-asset://` 协议与打包 `extraResources` 使用；`src/shared/assets-manifest.json`（tracked，不含模型二进制）记录文件/尺寸/哈希，`pnpm assets:prepare --check` 可只读复验。
- **模型自带内容（已实测，详见 §11）**：
  - **表情：有。** 85 个 morph = 82 个顶点 morph + 3 个材质 morph；按面板分：眉 10 / 目 22 / 口 37 / 其他 16。PLAN 需要的映射全部存在：`まばたき`（眨眼）、`笑い/笑目/笑/にやり`（笑）、`照れ`（材质 morph，显示腮红 `颜赤`）、`怒り`、`悲しい`、`ウィンク`、`星目`（名称带尾随空格，代码里需 trim）、`はぁと`；口型 `あいうえおん` 可做口型同步。另有 111/1111/11+ 等少量占位/重复 morph。**85 个的完整清单（索引/英文名/影响顶点/重复提示/核心表情建议）见 [docs/model-morphs.md](docs/model-morphs.md)。**
  - **表情符号：有。** `bq.png` 是漫画符号贴图（汗滴/怒气十字/心/星星/！？等），挂在 `biaoq` 材质上；符号面片默认藏在脑后，由若干 4–8 顶点的小 morph（`！`/`？`/`！！`/`汗`/`怒`/`脸红`/`汗颜` 等）移到脸旁显示。
  - **动作：没有。** 资产中没有任何 `.vmd/.vpd/.bvh` 等动作文件（原始模之屋下载包也没有）；PMX 2.0 格式只含顶点/面/材质/骨骼/morph/表示枠/刚体/关节，不存储动作关键帧。走/坐/爬/摸头等动作必须程序化摆姿态（B3）或另配 VMD 外部动作（见 §11.1 / B8）。
  - **物理：有。** 284 刚体 + 318 关节（头发/衣摆/腰穗），可选 `MMDPhysics` + ammo.js 消费；不用则退回轻量弹簧（§11）。
- 模型卡点：**不需要 VRM 转换**；如需给别的 MMD/VRM 生态用，已单独准备转换包（另存，不在本仓库）。
- 预览：可从 `default-workspace/_vrmfix/preview_patched.png` 查看（本仓库不引）。
- 授权规则（必须遵守）：允许改造/优化骨骼刚体/重制 UV；**请勿二次配布、请勿商用**；版权 miHoYo。

---

## 3. 目录结构（目标）

```
aventurine-pet/
├─ PLAN.md
├─ README.md                    # 运行/权限说明（后期补）
├─ .gitignore
├─ package.json
├─ electron.vite.config.ts
├─ electron-builder.yml
├─ tsconfig.json / tsconfig.node.json
├─ vitest.config.ts             # Wave 0.5：vitest 测试基建（tests/**）
├─ assets/
│  ├─ README.md                 # 说明 assets/model 私有、不可发布
│  ├─ icons/                    # 占位图标（trayTemplate*.png / app-icon-placeholder.png，可替换，见 §17.5）
│  ├─ model/                    # 【gitignore】PMX + PNG + 使用规则 + optimized/（21 文件产物）
│  └─ sounds/                   # 可选音效（自备/自制）
├─ bridge/
│  └─ dsh-aventurine-bridge/    # DSH host-only 桥插件（独立 npm 包）
├─ native/
│  ├─ winlist/                  # Swift 窗口枚举
│  └─ dragwindow/               # Swift 真实拖窗/模拟事件
├─ scripts/
│  ├─ prepare-assets.mjs        # 贴图降采样、PMX 副本、manifest、--check 校验
│  ├─ worktree-setup.sh         # 新 worktree 软链 node_modules + assets/model（Wave 1 必需，见 §6）
│  └─ build-native.mjs          # 编译 Swift 助手
├─ src/
│  ├─ shared/                   # 冻结契约：types / ipc / config / bridge-schema
│  ├─ main/                     # Electron 主进程
│  ├─ preload/
│  └─ renderer/                 # three.js 场景 / 行为 / 物理 / 交互 / 设置 UI
├─ tests/
└─ docs/                        # 补充设计（可选）
```

---

## 4. 架构要点

```
┌──────────────────────── Electron 主进程 ────────────────────────┐
│ index.ts                                                        │
│ ├─ windows.ts      每显示器透明 overlay 窗口 + 点击穿透控制      │
│ ├─ tray.ts         菜单栏图标/菜单（显示/隐藏/设置/退出）        │
│ ├─ config.ts       配置持久化（userData/config.json）            │
│ ├─ protocol.ts     pet-asset:// 协议 → app Resources 内模型资源  │
│ ├─ desktop/        winlist.ts（Swift 调用）/ drag.ts（真实拖窗） │
│ ├─ dsh/           dsh-events.ts（尾随 ~/.dsh/aventurine-pet/）   │
│ └─ notifications.ts 闹钟/提醒                                    │
├──────────────────────── preload ──────────────────────────────┤
│ contextBridge 暴露受限 IPC API（窗口信息/配置/拖拽/权限/DSH）     │
├──────────────────────── renderer ─────────────────────────────┤
│ three.js 场景（正交相机，toon/MMD 材质）                          │
│ ├─ model/        PMX 加载、morph/材质处理、坐标映射               │
│ ├─ physics/      重力/惯性/碰撞（屏幕边/窗口上沿）                │
│ ├─ animation/    程序化姿态库、表情、呼吸、发丝微动               │
│ ├─ behavior/     状态机 + 加权随机调度 + 捣乱                     │
│ ├─ desktop/      窗口吸附/坐窗口/爬行/跟随                        │
│ ├─ interaction/  拖拽/摸头/戳/视线/右键菜单                       │
│ └─ settings/     设置窗（独立普通窗口）                           │
└───────────────────────────────────────────────────────────────┘
外部：Swift 助手（winlist / dragwindow）、~/.dsh/aventurine-pet/（DSH 桥文件）
```

> Wave 0.5 已预置集成骨架（Wave 1 各任务不要重复造）：`src/main/app-context.ts`（overlay 注册表 + 类型安全 `broadcast`）、`src/main/ipc/index.ts`（`registerIpcHandlers(ctx)` 聚合 window/config/desktop 三个 registrar）、`src/main/ipc/window.ts`（`pet:window-info`/`pet:screen-info`，A1 续填窗口动作 handler）、`src/main/protocol.ts`（`pet-asset://` 接线，A3 填加固实现）、`src/main/index.ts`（仅 Lead 可改：lifecycle/窗口创建/托盘接线/smoke）。

关键技巧：
- 透明窗口全屏铺满 + `setIgnoreMouseEvents(true, { forward: true })`；渲染进程用 `mousemove`（含 screenX/screenY）做命中检测，命中宠物时经 IPC 让主进程 `setIgnoreMouseEvents(false)`，离开/释放后恢复。
- 模型的屏幕位置统一由「世界坐标（逻辑像素）」→ 渲染进程计算；主进程只负责窗口/系统交互。
- 窗口信息每 250–500ms 拉取一次即可（不需要每帧）。

---

## 5. 任务分解（含并行标记）

> 标记说明：`⚡` = 与其他同 Wave 任务可并行（文件 scope 不重叠）；`🔗` = 依赖（必须等前序 merge 到 main）。
> 每个任务都应「一个窗口/worktree 独立完成」，完成后合入 `main`。

### Wave 0 — 基线（串行，先由一个窗口完成）

| ID | 任务 | 并行 | 依赖 | 产出 / Scope | 验收 |
|---|---|---|---|---|---|
| M0-1 | 工程脚手架 | ⚡ 可与 M0-3 并行 | — | `package.json`、`electron.vite.config.ts`、`tsconfig*`、`src/main/index.ts`、`src/preload/*`、`src/renderer/index.html`+入口、`pnpm dev` 能起一个透明空窗 | `pnpm dev` 成功；`pnpm typecheck` 通过；`pnpm build` 可产出 |
| M0-2 | **冻结共享契约** | 与 M0-1 同一人做 / 紧随 | M0-1 | `src/shared/types.ts`、`src/shared/ipc.ts`、`src/shared/config.ts`（含默认值）、`src/shared/bridge-schema.ts` | 契约评审通过并 commit；后续任务不得擅改 |
| M0-3 | 资源管线脚本 | ⚡ 可与 M0-1 并行 | — | `scripts/prepare-assets.mjs`：贴图最大边降采样到 2048、校验 PMX 贴图全部存在、输出 `src/shared/assets-manifest.json`（文件/尺寸/哈希） | 脚本可重复执行；manifest 生成；不修改原始贴图（输出到 `assets/model/optimized/` 或缓存） |

### Wave 1 — 外壳/渲染/原生/桥接（5 个窗口并行）

> A6（测试基建）已在 Wave 0.5 完成并**从并行表移除**：Lead 预置 `vitest@5.1.0` + `pnpm test`/`test:watch` 脚本；`vitest.config.ts`、`tests/setup.ts` 与首批契约/资源单测随修复批次落地（§17.5 P0-4）。后续任务只新增自己的 `*.test.ts`，不改基建。

| ID | 任务 | 并行 | 依赖 | Scope（不要碰其它目录） | 验收 |
|---|---|---|---|---|---|
| A1 | 透明置顶窗 + 点击穿透 + 多屏 + 托盘 | ⚡ | M0-1/2；集成骨架已由 Lead 预置（§17.5 P0-2） | `src/main/windows/**`、`src/main/tray.ts`、`src/main/ipc/window.ts`（续填窗口动作 handler）、`assets/icons/trayTemplate*.png` 消费 | 1080p 下 frame=`display.workArea` 的透明置顶窗；点击能穿透到下层应用；悬停宠物占位矩形可拦截（`pet:set-ignore-mouse` 带单帧延迟保护）；托盘用 `assets/icons/trayTemplate.png`（template image，深浅色自动适配）可显示/隐藏/退出；每 display 一个 overlay（Wave 1 仅主屏渲染宠物，§17.3-2）；**不抢焦点**：`focusable:false` + `showInactive()`，`isFocusable()===false && isFocused()===false`，无 Dock 图标；监听 `display-added/removed/metrics-changed`（debounce 200ms）按新 `workArea` 重建窗口并广播 `screens-updated` |
| A2 | three.js 渲染核心 + PMX 加载 | ⚡ | M0-1/2、M0-3；**A3 不再阻塞**（`pet-asset://` 协议与 CSP 由 Lead 预置，§17.5 P0-3） | `src/renderer/scene/**`、`src/renderer/model/**`、`src/renderer/assets/**`、`src/renderer/index.html`、`src/renderer/src/main.ts`（后两者 A2 唯一 owner） | 经 `pet-asset://model/<文件名>` 加载 `assets/model/optimized/` 内 **PMX 副本 + 20 张贴图**；贴图正确、alpha 正确、表情 morph 可驱动（材质 morph 需自定义处理）；正交相机；`MMDAnimationHelper.add(mesh, { physics: false })`（本 Wave 不引入 ammo.js）；FPS 上限控制器（读 `fpsCap`，默认 30，`onConfigChanged` 热更）；尺寸=`sizePercent% × display.bounds.height`（100% 时按 `workArea.height` 封顶，§19.11）、脚底贴 `workArea` 底边（§17.3-2 修正口径）；订阅 `onScreensUpdated` + window `resize` 重算 |
| A3 | 配置/资源协议加固/日志 | ⚡ | M0-1/2；协议主体与接线已由 Lead 预置（§17.5 P0-2/P0-3） | `src/main/config.ts`、`src/main/logger.ts`、`src/main/protocol.ts`（加固/映射文档）、`src/main/ipc/config.ts` | `pet-asset://` dev/prod 两模式读模型（dev 根 `assets/model/optimized`、prod 根 `resources/model`）；handler 加固：`decodeURIComponent`、防目录穿越/非法段、`Access-Control-Allow-Origin: *`、404/403；配置读写与默认值生效、变更广播 `config-changed`；日志落盘（userData/logs，失败不抛） |
| A4 | Swift 窗口枚举助手 | ⚡ | M0-2 | `native/winlist/**`、`src/main/desktop/winlist.ts`、`src/main/ipc/desktop.ts`、`scripts/build-native.mjs`、`tests/winlist.test.ts` | `winlist --json` 返回屏幕内窗口（bounds/pid/owner/layer/alpha）；TS 封装可注入 mock；`src/main/ipc/desktop.ts` 注册 `pet:windows` 并在变化时广播 `windows-updated`（500ms 轮询）；build 脚本能编译（本机已验证可行，无需屏幕录制权限） |
| A5 | DSH 桥插件（独立包） | ⚡（可完全独立开发） | 无（契约见 §8） | `bridge/dsh-aventurine-bridge/**`（package.json、lib/index.js、cordis.patch.yml、README）、`tests/bridge-plugin.test.ts` | 安装进 DSH 后，`~/.dsh/aventurine-pet/status.json` 与 `events.jsonl` 随任务开始/结束更新；DSH 未运行时文件陈旧可判离线；桥常量**单一来源**=`src/shared/bridge-schema.ts`（bridge 包 import 或 parity test 对齐，禁止复制一份魔法字符串）；安装验收必须用**独立 DSH profile**（`dsh plugin --profile pet-bridge-test …`），不得装进正在使用的 profile（§17.5 P1-8） |


### Wave 2 — 行为/物理/动画/交互/桌面感知（7 个窗口并行）

| ID | 任务 | 并行 | 依赖 | Scope | 验收 |
|---|---|---|---|---|---|
| B1 | 状态机 + 随机调度 | ⚡ | A2、A3 | `src/renderer/behavior/**`（不含 mischief） | 状态可切换且可打断；加权随机（可注入 seed 复现）；冷却生效；配置可关"自主活动" |
| B2 | 运动与物理 | ⚡ | A2 | `src/renderer/physics/**` | 拖拽跟随；释放后惯性+重力；落到屏幕底/窗口上沿停住；可被甩出；边界不穿透 |
| B3 | 动画/姿态/表情系统 | ⚡ | A2 | `src/renderer/animation/**` | 程序化姿态库：站/走/爬/坐/睡/被摸/被甩/注视；姿态间平滑过渡；眨眼/笑/害羞等表情可触发；发丝/衣摆轻量微动（可选）。姿态清单可参考 Mate-Engine 的 PET_IDLE/PET_SITTING/PET_LOCOMOTION 分类，但其 `.anim` 不能直接复用（见 §11.1） |
| B4 | 交互（拖拽/摸头/戳/视线/右键） | ⚡ | A2、A1 | `src/renderer/interaction/**` | 按住拖动、甩出；头部圆形轨迹摸头触发；戳不同部位不同反应；头/眼跟随鼠标；右键菜单 |
| B5 | 桌面感知消费（坐/爬/跟随） | ⚡ | A2、A4 | `src/renderer/desktop/**` | 从主进程拿窗口列表：吸附窗口上沿坐下、窗口移动跟随、窗口关闭落下；菜单栏/Dock 上沿可站/坐；可沿边缘爬行 |
| B6 | 设置面板 | ⚡ | A1、A3 | `src/renderer/settings/**` | 尺寸(10–100%，默认 50)、透明度、自主活动开关/频率、捣乱开关、DSH 开关、FPS、开机自启、权限状态；保存后立即生效 |
| B7 | DSH 反应消费 | ⚡ | A5、A3 | `src/main/desktop/dsh-watch.ts`、`src/renderer/reactions/dsh.ts` | DSH 任务开始→"忙碌"姿态+气泡；结束→完成反应；错误→沮丧；DSH 未运行/陈旧→静默降级 |

### Wave 3 — 真实拖窗/捣乱/系统集成（4 个窗口并行）

| ID | 任务 | 并行 | 依赖 | Scope | 验收 |
|---|---|---|---|---|---|
| C1 | 真实拖动其它窗口 | ⚡ | A4、B5 | `native/dragwindow/**`、`src/main/desktop/drag.ts`、`src/renderer/behavior/grab-window.ts` | 有辅助功能权限时：宠物抓住窗口上沿可拖动该窗口；释放后停止；无权限时自动降级为视觉扒窗；不碰自身/系统 UI 窗口 |
| C2 | 随机捣乱行为集 | ⚡ | B1、B5 | `src/renderer/behavior/mischief.ts` | 随机触发：扒窗/推窗（依赖 C1）/跳窗/绕圈/坐菜单栏/偷看/踩线；有冷却与频率上限；可在设置关闭 |
| C3 | 通知/闹钟/声音/权限引导 | ⚡ | A1、A3 | `src/main/notifications.ts`、`src/renderer/tools/**`、`assets/sounds/**` | 闹钟/计时器到点通知+反应；权限缺失时引导到系统设置；声音可关 |
| C4 | 性能调优 + 打包 | ⚡（后期收口） | A1、A2、B2 | `electron-builder.yml`、`scripts/package.mjs`、`docs/` | 打包出可双击运行的 .app（unsigned）；空闲降帧、内存达标；首次启动权限引导；多屏/全屏/Space 切换不崩 |

### Wave 4 — 验收与收尾（串行/并行测试）

| ID | 任务 | 依赖 | 产出 |
|---|---|---|---|
| Q1 | 验收测试执行 + 缺陷修复 | 全部 | 按 §12 测试矩阵跑一遍，缺陷分派回各 scope |
| Q2 | 文档/打包交付/演示 | Q1 | `README.md`（运行/权限/常见问题）、演示截图/录屏、最终 .app |

---

## 6. 并行执行矩阵（开窗口建议）

| Wave | 并行窗口数 | 任务 |
|---|---|---|
| 0 | 1（先做） | M0-1 + M0-2（同一人），M0-3 可同窗口/另开 |
| 1 | **5** | A1、A2、A3、A4、A5（A6 已在 Wave 0.5 完成，不占窗口） |
| 2 | **7** | B1、B2、B3、B4、B5、B6、B7 |
| 3 | **4** | C1、C2、C3、C4 |
| 4 | 1–2（收口） | Q1、Q2 |

Git worktree 用法（每个窗口一个；**依赖与私有资产的唯一来源是主工作树**）：
```bash
cd /Volumes/4TB外置盘/deepseek-harness/aventurine-pet
git worktree add ../wt-a2 -b feat/a2-render
scripts/worktree-setup.sh ../wt-a2   # 软链 node_modules + assets/model，打印 PET_PROFILE 用法
cd ../wt-a2 && pnpm dev:worktree     # dev:worktree 自动注入 PET_PROFILE=$(basename "$PWD")
```
- 新 worktree **不带** `node_modules/` 与 `assets/model/**`（二者 gitignore）；一律用 `scripts/worktree-setup.sh` 软链（幂等，可重复执行；目标已是真实目录时脚本拒绝覆盖并报错；**目标必须是 `git worktree add` 创建的根目录**——传入主工作树子目录或其它仓库的 worktree 会报错；脚本打印的 `PET_PROFILE` 与 app 侧校验正则完全一致）。
- **禁止在 worktree 内** `pnpm install`（会为每个窗口重复下载 Electron）与 `pnpm assets:prepare`（会改写 tracked 的 `src/shared/assets-manifest.json` 造成合并冲突）；需要 regenerate manifest 时只在 Lead 集成窗口做并单独 commit。
- **PET_PROFILE 隔离 userData**：dev 下 userData → `~/Library/Application Support/aventurine-pet-<profile>`，5 个并行窗口的 config/log 不互相覆盖；单实例锁只在打包版启用（见 §17.5「P2 同步处理」）。
- 合并顺序：A4/A5（无集成文件）→ A3（协议加固/config）→ A1（窗口/托盘）→ A2（renderer）；每个任务合并前 rebase 到最新 `main`。`src/shared/**`、`package.json`、`pnpm-lock.yaml`、`src/main/index.ts`、`electron.vite.config.ts`、`src/preload/**`、`src/shared/assets-manifest.json` 为**集成文件**，只由 Lead 在合并窗口处理；冲突解决后必须重跑 `pnpm typecheck && pnpm test && pnpm smoke`。

---

## 7. 文件所有权（避免同文件冲突）

> Wave 0.5 修复后规则：**集成骨架由 Lead 预置，Wave 1 各任务只填自己的 registrar/模块**；`src/preload/**` 已冻结为完整 `PetApi`，本 Wave 任何人不得改。

| 文件/目录 | 所有人 |
|---|---|
| `package.json`、`pnpm-lock.yaml` | Lead（唯一；新增依赖走 Lead，并行窗口不要 `pnpm add`） |
| `electron.vite.config.ts`、`tsconfig*` | Lead（B6 设置窗第二入口由 Lead 在 Wave 2 前加） |
| `src/shared/**` | Lead（冻结契约；Wave 0.5 已完成小版本变更：+`screens-updated`，之后仍不得擅改） |
| `src/main/index.ts` | **唯一 Lead**（app 生命周期 / 窗口创建接线 / 托盘接线 / smoke；A1/A3/A4 不得改） |
| `src/main/app-context.ts`、`src/main/ipc/index.ts`、`src/main/protocol.ts` | Lead 预置、后续 Lead 集成（A3 只填 `protocol.ts` 加固实现与映射文档，不改接线） |
| `src/main/windows/**`、`src/main/tray.ts`、`src/main/ipc/window.ts` | A1（`window.ts` 的 window-info/screen-info handler 与 `screens-updated` 推送由 Lead 预置，A1 续填窗口动作 handler） |
| `src/main/config.ts`、`src/main/logger.ts`、`src/main/ipc/config.ts` | A3 |
| `src/main/desktop/winlist.ts`、`src/main/ipc/desktop.ts`、`native/winlist/**` | A4（`pet:windows`）；C1 只续填 `pet:move-window`；`pet:set-ignore-mouse`/`set-visible`/`quit` 归 A1（`ipc/window.ts`） |
| `src/preload/**` | **Lead（冻结）**；Wave 1 不得改，需扩展能力先改 `src/shared/ipc.ts` 走契约评审 |
| `src/renderer/index.html`、`src/renderer/src/main.ts`、`src/renderer/scene/**`、`src/renderer/model/**`、`src/renderer/assets/**` | A2（Wave 1 唯一 owner；`index.html` 含 CSP） |
| `bridge/**` | A5 |
| `tests/**` | Lead 基建（`vitest.config.ts`/`tests/setup.ts`/fixtures）；各任务只**新增**自己的 `*.test.ts`，不改基建 |
| `scripts/worktree-setup.sh`、`assets/icons/**` | Lead（Wave 1 固定；A1 只消费托盘图标，C4 打包消费 app icon） |
| `scripts/prepare-assets.mjs`、`src/shared/assets-manifest.json` | Lead / 集成窗口（只在主工作树 regenerate 并单独 commit） |
| `src/main/desktop/dsh-watch.ts` | B7 |
| `src/renderer/behavior/**`（mischief 除外） | B1 |
| `src/renderer/behavior/mischief.ts` | C2 |
| `src/renderer/physics/**` | B2 |
| `src/renderer/animation/**` | B3 |
| `src/renderer/interaction/**` | B4 |
| `src/renderer/desktop/**` | B5 |
| `src/renderer/settings/**` | B6 |
| `native/dragwindow/**`、`desktop/drag.ts` | C1 |
| `src/main/notifications.ts` | C3 |
| `electron-builder.yml`、`scripts/package.mjs`、`docs/**` | C4（`docs/pet-asset-protocol.md` 由审查修复批新增） |
| `scripts/print-profile.sh`、`scripts/profile-lib.sh` | Lead（审查修复批 M-4；`worktree-setup.sh` 复用同一规范化实现） |
| `tests/helpers/**` | Lead 测试基建（审查修复批：electron stub，不得被 `tests/**/*.test.ts` 收集） |
| `src/renderer/src/model/bounding.ts`、`src/renderer/src/scene/pixel-ratio.ts`、`src/renderer/src/assets/retrying-texture-loader.ts` | A2（审查修复批新增纯函数模块） |
| `src/renderer/src/interaction/**` | B4 主 owner；审查修复批已先落 `pointer-gate.ts` 实现 Wave 1 悬停拦截（B4 继续扩展交互） |

---

## 8. 接口契约（M0-2 冻结；Wave 0.5 小版本变更见 §17.5，所有任务照此实现）

`src/shared/types.ts`（示意；**以文件为准**）：
```ts
export interface Rect { x: number; y: number; width: number; height: number }

/** 显示器信息（pet:screen-info 返回值 / screens-updated 事件 payload） */
export interface DisplayInfo {
  id: number
  bounds: Rect          // 物理屏幕全尺寸（含菜单栏/Dock 区域；sizePercent 基准）
  workArea: Rect        // 可用工作区（overlay frame 与定位/命中/渲染坐标的基准）
  scaleFactor: number
  isPrimary: boolean
}

export interface WindowInfo {
  id: number
  pid: number
  owner: string
  layer: number
  alpha: number
  bounds: Rect       // 屏幕全局逻辑坐标（左上原点）
  onScreen: boolean
}

export type PetMood = 'idle' | 'walk' | 'climb' | 'sit' | 'sleep' | 'drag' | 'fall'
  | 'pat' | 'grabWindow' | 'dshBusy' | 'dshDone' | 'dshError'

export interface PetConfig {
  sizePercent: number        // 10–100，默认 50（2026-11-07 用户确认；见 §19.8/§19.11）；高度 = sizePercent% × bounds.height，100% 受 workArea 封顶（D6）
  opacity: number            // 0.3–1
  clickThrough: boolean
  autonomous: boolean        // 自主活动总开关
  autonomousLevel: 'low' | 'normal' | 'high'
  mischief: boolean          // 捣乱总开关
  dshLink: boolean           // DSH 联动
  fpsCap: number             // 5–60，默认 30
  launchAtLogin: boolean
  position: 'corner' | 'free'
  sound: boolean
}

export interface DshEvent {
  ts: number
  type: 'agent/status' | 'task/start' | 'task/end' | 'task/error' | 'session/event'
  payload: Record<string, unknown>
}

export interface DshStatus {
  online: boolean            // 心跳新鲜度 < 30s，且 ts 不在未来（未来时间戳不算 online）
  running: boolean
  lastEventAt: number
  lastType: DshEvent['type'] | null
}
```

IPC 通道（`src/shared/ipc.ts`，preload 只暴露白名单）：
```
pet:get-config / pet:set-config
pet:screen-info           -> DisplayInfo[]
pet:windows               -> WindowInfo[]（主进程每 500ms 更新并推送）
pet:set-ignore-mouse      (ignore: boolean)
pet:window-info           (id, bounds)  // overlay 窗口自身
pet:accessibility-status / pet:open-accessibility-settings
pet:move-window?          // 物理拖窗用（C1）
pet:dsh-status            -> DshStatus
pet:notify                (title, body)
pet:show-settings / pet:quit / pet:set-visible
events（主→渲染，共 4 个）: windows-updated / dsh-event / config-changed / screens-updated
```
- `PetApi` = 14 个 invoke + 4 个事件订阅（preload 完整转发、已冻结；Wave 1 只补 main handler）：
  `onWindowsUpdated(WindowInfo[])`、`onDshEvent(DshEvent)`、`onConfigChanged(PetConfig)`、**`onScreensUpdated(DisplayInfo[])`**。
- **已注册 handler 现状（Wave 0.5 修复后）**：`pet:window-info`、`pet:screen-info` 与 `screens-updated` 推送由 Lead 预置；其余 channel 由各任务在自己的 `src/main/ipc/*.ts` registrar 中补注册（未注册前 renderer 侧保持 catch）。

### 8.1 `pet-asset://` 协议契约（Wave 0.5 新增；Lead 预置接线 / A3 加固 / A2 消费）

- **URL 形式**：`pet-asset://model/<文件名>`（host 固定 `model`；`<文件名>` 是 `assets/model/optimized/` 下的**单段文件名**，含 CJK/空格/em-dash 时调用方 `encodeURIComponent`，handler 侧 `decodeURIComponent`）。
- **根目录**：
  - dev（`!app.isPackaged`）：`<appPath>/assets/model/optimized`（**唯一合法根，无回退**；冒烟额外从主进程断言 PMX 副本与贴图确实存在于该根，防止回退根让「PMX 已进 optimized」的证据失真——§17.3-10 修复 MED-2/LOW-3）
  - prod（打包）：`<process.resourcesPath>/model`（过渡兼容其下 `model/optimized/` 布局）
  - `electron-builder` 的 `extraResources` 把 `assets/model/optimized/**` 映射到 `model/`。**`optimized/` 现在包含 PMX 字节级副本 + 20 张贴图（21 文件）**，所以打包产物同时有 PMX 与贴图；原「只放 optimized 贴图」的写法作废（§11 / §17.3-7 同步修正）。
- **协议注册**：`protocol.registerSchemesAsPrivileged([{ scheme: 'pet-asset', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } }])` 必须在 `app.whenReady()` **之前**调用；ready 后 `protocol.handle('pet-asset', handler)`。接线在 Lead-owned `src/main/index.ts` + `src/main/protocol.ts`（§17.5 P0-2）。
- **handler 安全要求**（审查修复批 M-2/F3/F7/F8 后已补齐并有 handler 级测试）：仅允许 `GET`；URL 必须 `pet-asset:` scheme、host 必须 `model`、**不得带 port、不得带 userinfo**；`decodeURIComponent` 后按**单段文件名**契约拒绝 `..`、`/`（含 `%2F`）、`\`、NUL、空段与非法文件名（`sub/nested.png` 一律 403，不再作为根内子目录读取）；父目录 `realpath` + 根内二次校验后，用 `open(O_RDONLY|O_NOFOLLOW)` + `fstat().isFile()` + fd 读取，防止符号链接逃逸并收窄 TOCTOU（残余同用户竞态已记为接受风险）；`ENAMETOOLONG`/`ELOOP` → 403；返回 `Response` 并统一加 `Access-Control-Allow-Origin: *`、`Cache-Control: no-cache`；PNG → `image/png`、PMX → `application/octet-stream`；不存在 404、越界/非法 403。URL/路径解析抽到纯函数模块 `src/main/protocol-path.ts`；逐条审计清单与测试映射见 `docs/pet-asset-protocol.md`，handler 级用例见 `tests/protocol-handler.test.ts`（32 例），URL 用例见 `tests/protocol-path.test.ts`（27 例）。
- **CSP**（`src/renderer/index.html`，A2 owner）：`img-src 'self' data: blob: pet-asset:; connect-src 'self' ws: pet-asset:`（`ws:` 仅 dev HMR，C4 生产构建收紧）。
- **A2 加载方式**：`MMDLoader.load('pet-asset://model/' + encodeURIComponent(pmx文件名))`；PMX 内贴图引用是相对文件名，MMDLoader 以 PMX URL 的基址解析 → 贴图自动请求 `pet-asset://model/<贴图名>`（PMX 副本与 20 张贴图同在 optimized 根目录，映射成立）。

DSH 桥文件契约（A5 写、B7 读）：
- `~/.dsh/aventurine-pet/status.json`：
```json
{ "ts": 1762500000000, "running": true, "agents": 1, "lastEventAt": 1762499998000, "lastType": "task/start", "offline": false }
```
- `~/.dsh/aventurine-pet/events.jsonl`：每行一个 `DshEvent`（追加写；桥插件负责 5MB 轮转；app 按 mtime/size 尾随）。
- **判在线**：`online = !offline && now >= ts && now - ts < 30000`。DSH 运行时每 5s 更新 status.json；**未来时间戳不算 online**（时钟回拨/伪造不会产生永久在线）；`DshBridgeStatusFile.offline?: boolean` 是插件退出时的**显式离线标记**，为 true 时即使 ts 新鲜也判 offline。offline 时仍透传 `running/lastEventAt/lastType`，**B7 必须只看 `online`**，避免陈旧文件误触发。
- **单行上限**：`BRIDGE_MAX_LINE_BYTES = 64KB`，`parseDshEventLine` 对超长行直接返回 null（防内存膨胀）；半行/非 JSON/字段缺失等脏输入一律返回 null 且不抛异常。

---

## 9. DSH 桥插件设计（A5）

- 位置：`bridge/dsh-aventurine-bridge/`，独立 npm 包，**host-only**（`main: lib/index.js` + `cordis.patch.yml`，无 client 半）。
- 入口（**必须导出为箭头函数**；审查修复批 H-2：cordis 4.x 用 `isConstructor(fn)=!!fn.prototype` 判定插件形态，普通 `function` 会被 `new` 调用，apply 返回的 disposer 被当作构造器返回值丢弃 → 心跳 interval 不清、offline 帧不写）：
```js
export const name = 'dsh-aventurine-bridge'
export const apply = (ctx, config = {}) => {          // 箭头函数（不可构造）
  ctx.on('agent/status', p => write({ type: 'agent/status', payload: p }))  // { status, agent }
  ctx.on('agent/error', p => write({ type: 'task/error', payload: p }))     // { turn, step, error, agent }
  ctx.on('session/event', (s, e) => { /* turn/end 按 e.data.reason.kind 分流 */ })
  // 定时写 status.json 心跳；返回的 disposer 清 interval + 写 offline:true
}
```
- 事件映射（**真实 DSH 形状**；审查修复批 H-3）：`agent/status` running/idle → task/start、task/end（payload `{status, agent}`，只在变化时 emit）；`agent/error` → task/error；`session/event` 的 `turn/end`：`event.data.reason.kind==='error'` → task/error（不再透传 session/event），其余 completed/aborted 等 → session/event；`assistant/message`、`tool/result` → session/event；同一 agent/session + turn 的 task/error 只报一次（FIFO 去重上限 64）。**不再**用 `/error|failed|cancel|denied/i` 模糊匹配事件名（真实 durable 事件表没有这些类型，`task/error` 曾被永远映射成 `task/end`）。
- 目录创建与写文件注意：`~/.dsh/aventurine-pet/`；失败只 warn 不抛；限制单行大小（64KB，见 `BRIDGE_MAX_LINE_BYTES`）；5MB 轮转。
- 桥常量**单一来源**：`src/shared/bridge-schema.ts`（文件名/心跳周期/TTL/轮转阈值/64KB 行上限/事件类型白名单）。bridge 包与 app 侧必须引用同一来源：bridge 包直接 import 该 TS（host 侧可加载 TS）或加 parity test 断言两边常量一致，**禁止各写一份魔法字符串**。
- 安装（后续；Q1 或独立 profile）：`dsh plugin --profile pet-bridge-test add -w bridge/dsh-aventurine-bridge` → 重启该 profile 的 DSH → 确认文件更新。**禁止装进正在使用的 profile**（会重启当前 DSH、影响其他并行窗口；A5 的安装验收不得有全局副作用）。
- 注意：不要再依赖旧皮肤插件的 `/aventurine-skin/status`（已确认本机未安装，且用户已同意卸载方案）。

### 9.1 为什么不复用旧皮肤的状态路由（决策记录）

旧皮肤的宿主半确实有一个现成接口 `GET /aventurine-skin/status`（running / runningAgents / lastDoneAt / 缓存命中率），看起来"少写一个插件"，但整体更麻烦：

| 问题 | 说明 |
|---|---|
| **端口发现** | DSH 的 Web 端口每次启动都变（实测 59974 → 61887 → 49193），且 `~/.dsh` 的配置/日志里没有记录该端口。桌宠 app 只能靠扫描端口 / `lsof` / 进程参数去猜，比读固定文件路径脆弱得多 |
| **鉴权/同源不确定性** | 皮肤路由做了 same-origin 校验（无 Origin 时放行），但整条 Web 链路是否还有连接鉴权需要额外验证；文件通道完全绕开这些 |
| **数据太薄** | 只有 running/idle 和完成时间，没有错误、会话、任务文本、step 等；宠物的"出错沮丧/完成庆祝"等反应做不细 |
| **必须长期装皮肤** | 依赖旧皮肤意味着它要继续装在 DSH 里、继续随 DSH 版本适配；其 client 半还会给 DSH 整体换肤（用户明确要卸载），耦合面变大 |
| **反而不是零成本** | 想"只装宿主半"就得改它的 package.json/loader 条目，等于维护一个皮肤分支；不如直接写 100 行的专用桥插件 |

**结论**：`A5 文件桥插件` 是最简方案——固定路径、无网络、无鉴权、事件更丰富、与旧皮肤解耦。
（补充：还有"零插件"方案——让桌宠 app 直接尾随 DSH 的 `~/.dsh/sessions/**/session.v4.jsonl.zstd`。不推荐作为正式方案：zstd 压缩 + 内部 v4 格式、版本易变、且包含完整对话内容有隐私面；只适合应急/原型验证。）

---

## 10. 权限与系统集成

| 能力 | 权限 | 检测/申请 | 无权限降级 |
|---|---|---|---|
| 悬浮/置顶/坐窗口/爬窗口 | 无 | — | — |
| 真实拖动其它窗口 / 推窗 / 全局模拟点击 | 辅助功能（Accessibility） | `systemPreferences.isTrustedAccessibilityClient(true)` + 深链 `x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility` | 视觉扒窗，不移动真窗口 |
| 闹钟通知 | 通知 | `Notification.isSupported()` / user 允许 | 气泡提示 |
| 开机自启 | 登录项 | `app.setLoginItemSettings` | 手动启动 |
| 录屏/窗口标题 | **不需要** | 已实测：`CGWindowListCopyWindowInfo` 的 bounds/pid/layer 无需屏幕录制；标题才需要（我们不用） | — |

其他：无 Dock 图标 / 不抢焦点——运行时 `app.setActivationPolicy('accessory')` + `app.dock?.hide()`（Wave 0.5 已实现），打包版再用 `LSUIElement: true`（`mac.extendInfo`）固化；overlay 窗口 `focusable:false` + `showInactive()`（禁止 `show()`/`focus()`）；窗口层级 `'screen-saver'`、`setVisibleOnAllWorkspaces(true, {visibleOnFullScreen:true})`、`backgroundThrottling:false`。

---

## 11. 关键实现细节备忘

- **尺寸/坐标口径（Wave 0.5 统一，覆盖 D6/§17.3-2 的旧冲突写法）**：`sizePercent` 相对 **`display.bounds.height`**（D6：50% @1080p=540px，30%≈324px，100% 受 workArea 封顶 ≈961px）；**定位/命中检测/渲染坐标**相对 **`display.workArea`**（overlay frame=workArea）；`petHeightPx = min(clamp(sizePercent,10,100)/100 × bounds.height, workArea.height)`；脚底贴 `workArea` 底边；窗口本地坐标 = 全局坐标 − `win.bounds` 原点（primary 上 y 从 30 起，不是 0）；DPR 只用于 canvas backing store，命中检测只用 DIP/CSS 像素。workArea 变化（Dock/菜单栏自动隐藏、分辨率/插拔屏）时按 `screens-updated` 重算，不允许用启动时快照。
- 模型朝向/坐标：以 A2 实测为准（PMX 常见朝向需 yaw 180° 校正）；世界单位 1 米 ≈ 模型 1.7 高；屏幕映射按上一条口径。
- 材质：`颜赤`（腮红贴图）diffuse alpha=0 默认隐形，靠材质 morph `照れ` 加亮显示；`目影` 默认 alpha=0.3，`目影消` / `目影濃` 材质 morph 分别把它乘 0 / 加 1（PMX 材质 morph mode：0=乘算、1=加算）；`biaoq`(bq.png) 符号面片默认藏在脑后，靠顶点 morph 移到脸旁。材质 morph 需自定义处理（MMDLoader 对材质 morph 支持有限）。
- 表情映射：`まばたき`→眨眼，`笑い/にやり`→笑，`照れ`→害羞，`怒り`→生气，`悲しい`→难过，`ウィンク`→眨眼，`星目/はぁと`→好感反应。（以上均已确认存在于模型；`星目 ` 名称带尾随空格需 trim；85 个里含少量重复/近义/占位 morph，实际常用 10–15 个即可；完整清单见 [docs/model-morphs.md](docs/model-morphs.md)。）
- 物理：**模型实际自带 284 刚体 + 318 关节**（头发/衣摆/腰穗），并非「无物理」。Wave 1 **不引入 ammo.js**：A2 用 `MMDAnimationHelper.add(mesh, { physics: false })`，发丝/衣摆先用轻量弹簧/微动；B2 阶段再决定是否引入 `MMDPhysics` + ammo.js（注意包体/初始化成本）。
- 窗口吸附：优先 `layer==0 && alpha>0.01 && height>80` 的前台窗口；窗口列表按 CGWindowList 的前后顺序；宠物脚底 y 与窗口上沿 y 差 < 24px 且 x 在窗口内 → 可坐。
- Dock/菜单栏：菜单栏/Dock 区域直接用 `display.bounds` 与 `display.workArea` 的差集判定（左/右/下/上），不再硬编码菜单栏高度；宠物活动区 = `workArea`，"坐菜单栏 / Dock 上沿"贴 workArea 边缘做视觉效果。
- 多屏：每个 display 一个 overlay（frame=该 display.workArea）；**Wave 1 只有主屏窗口加载/渲染宠物**，其余窗口保持透明空窗（renderer 用 `pet:window-info.displayId` 判断）；宠物跨屏迁移留 B5/C4。
- 打包：`extraResources` 放 `assets/model/optimized/**` → `process.resourcesPath/model`（optimized 内已含 PMX 副本 + 20 贴图，**打包不会缺 PMX**）；`pet-asset://` dev/prod 根目录见 §8.1；**不要把 assets/model 明文放进公开仓库**。

### 可选后置任务（不阻塞主线）

| ID | 任务 | 依赖 | Scope | 说明 |
|---|---|---|---|---|
| B8 | 外部动画资产管线探索（可选） | A2、B3 | `scripts/anim-pipeline/**`、`docs/anim-strategy.md` | 如果程序化姿态效果不够，再评估：① Unity 烘焙 Mate-Engine 的 humanoid `.anim` → FBX/glTF → 重定向到 PMX 骨骼（需装 Unity + 先把 PMX 转 VRM/humanoid；几天级工作量）；② 引入 MMD VMD 动作（MMDLoader 原生支持，但宠物类动作少、授权逐个确认）。先产出决策备忘，不进入主线 |

---

### 11.1 动画来源策略（重要）

**结论：主线用程序化姿态（B3），Mate-Engine 的动画不能直接复用，只能"借鉴清单/参考节奏"；如确需外部动画，走 B8 独立管线，不阻塞 P1/P2。**

> 完整清单（已排除全部舞蹈）：**[docs/anim-reference.md](docs/anim-reference.md)** —— 收录 109 个非舞蹈片段，含分类、文件大小、与 B3 姿态的对应参考。

实测 Mate-Engine 仓库的动画资产（blobless 拉取源码树检查）：

| 项 | 情况 |
|---|---|
| 数量 | `Assets/MATE ENGINE - Animations/` 下 **128 个 `.anim`**：IDLE 35、SITTING 26、DANCING 17、LOCOMOTION 7、MISC 9、HIDING 6、BIG_SCREEN 5、UPDATE_2 5、POSE 4、INTRO 4、FACE 6、SLEEPING 1 等（另有 DLC/示例动画） |
| 覆盖 | 正好是我们要的：站/待机、走左右、坐窗口（BETA_PET_WINDOW_LAY 1–6）、睡觉、被拖拽、开心/摸头、躲藏、hover 反应 |
| 格式 | 全部是 Unity **Humanoid muscle clip**（YAML `.anim`，曲线是 `RootT.*`、`LeftFootT.*` 等 muscle 属性，`path` 为空），不是 FBX/glTF，也不是普通骨骼 transform 曲线 |
| 直接可用性 | ❌ three.js 不能读；仓库里也没有对应 FBX 动画源（FBX 全是道具/模型） |
| 复用成本 | 需要 Unity Editor + 把我们的 PMX 转成 VRM/Unity Humanoid avatar（Blender+MMD Tools+UniVRM）→ 在 Unity 里 bake 成骨骼关键帧 → 导出 FBX/glTF → 在 three.js 里做 humanoid→MMD 骨架重定向（rest pose 校正）→ 坐姿等还要按窗口高度/模型比例再调。属于几天级独立工程 |
| 授权 | MateEngine Pro License v2.1：素材 © Shiny，个人/教育/非商业使用允许、需署名，**不得单独再分发**；UMotion 等第三方组件另有条款。我们 app 本来就因模型禁止二次配布而不能分享，本地自用理论上可用，但跨项目搬运要谨慎 |

**其它可选动画来源**：
1. **MMD VMD 动作**：我们的模型是 MMD 系，`MMDLoader` 原生支持 VMD，是最"顺路"的外部动画格式；但宠物类的坐窗口/摸头/睡觉 VMD 很少，且每个 VMD 需确认作者授权 → 适合补充，不做主方案。
2. **Mixamo / 开源动作包**：可用 Blender 重定向到 MMD 骨骼，质量/数量不错，但同样有账号与授权流程，且坐窗口这类姿势要自己调。
3. **程序化姿态**（主线）：代码摆骨骼 + blend + 表情 morph，针对我们的模型和窗口高度调，授权干净、轻量、可迭代；先做 8–10 个核心姿态即可覆盖需求。

**执行建议**：B3 先实现「站/待机呼吸/走/爬/坐窗口/睡/被摸/被甩/跳跃/完成庆祝」10 个姿态；Mate-Engine 的动画只作为**节奏与姿态清单参考**（看它有哪些状态、时长多久），不复制文件。等 P2 觉得不够生动，再决定是否启动 B8。

---

## 12. 测试与验收清单

自动化（**修复后验收命令**汇总见 §17.5）：
- `pnpm typecheck`、`pnpm test`（vitest）、`pnpm build`；
- `pnpm smoke`（dev 模式冒烟：断言 workArea 几何 / focus / `pet-asset://` / 事件通道 / preload 白名单）；
- `pnpm smoke:file`（**生产 loadFile 路径**冒烟：`pnpm build` 后 `electron .` 加载 `out/renderer/index.html`）；
- `pnpm assets:prepare --check`（资源管线只读校验：manifest + optimized 落盘产物，含 PMX 副本）；
- 依赖真实模型的测试必须 `describe.skipIf(!existsSync(modelPath))`（干净 clone/CI 全绿，skip 算过）；A2 的数据侧断言用 tracked `src/shared/assets-manifest.json`，不依赖模型二进制。
- `prepare-assets.mjs` **write 模式**的 `generatedAt` 幂等不纳入单测（会写 tracked manifest、且 worktree 里禁止运行），由 §17.5「修复后验收命令」第 3 步验收；单测只覆盖 `--check` 只读路径。

单元测试（vitest）：
- 共享契约：14 IPC 名称/唯一性、4 个事件通道、`sanitizeConfig` 钳制/默认值/脏输入/仅自有属性、`PetApi` 键集合（编译期精确断言）；
- pet-asset 路径解析：`tests/protocol-path.test.ts` 覆盖 `..`/编码斜杠/NUL/反斜杠/双编码/绝对路径/空段、host+port 校验与根边界；
- DSH 桥 schema：`toDshStatus`（未来 ts→offline、`offline:true`→offline、TTL 边界、offline 透传）、`parseDshEventLine` 脏输入与 64KB 上限；
- 资源：manifest 结构/数值（20 贴图、3 张降采样、17 张字节级拷贝、9 个未引用、PMX counts）、`--check` exit 0；
- B1 随机调度（seed 固定 → 序列可复现）、冷却时间；B2 物理积分/边界碰撞；A4 winlist JSON 解析；A5/B7 桥事件解析与轮转；A3 配置默认值/迁移。
- **审查修复批新增自动化覆盖**（23 files / 419 tests，见 §19.9）：A1 `overlay-manager`/`tray`/`window-ipc`（electron stub）、A4 `desktop-ipc`（poller 基线/变化/失败/清理）、A2 `bounding`/`pointer-gate`/`pixel-ratio`、A3 `protocol-handler`（真实 fs 符号链接/packaged 根/headers）与 `ipc-config`（userData 不可写降级）、基建 `scripts`（prepare-assets/print-profile/worktree 退出码）、桥插件真实形状 fixture（agent/error、turn/end reason）。

手动测试矩阵（macOS 27，本机）：
1. 单屏 1080p / 内建 Retina：悬浮、点击穿透（点下层 Chrome 可正常操作）、尺寸 10/30/50/100%（100% 应贴满 workArea 高、不出窗）。
2. **启动/重建窗口不抢焦点、无 Dock 图标**：app 启动后在前台编辑器连续输入 10 秒不被打断；Cmd+Tab 列表无桌宠；点托盘菜单后原前台 app 仍是前台。
3. **长跑 ≥70s 不自杀**：`pnpm dev` 起窗后观察 ≥70s，无 `SMOKE_FAIL`、进程不退出（smoke 守护只在 `PET_SMOKE_TEST=1` 挂载）。
4. 全屏应用（Safari/播放器）之上仍可见；所有 Space 切换。
5. **显示器变化**：改分辨率 / 开关"自动隐藏 Dock" / 插拔外接屏 → overlay 贴住新 `workArea`、宠物尺寸重算、无越界。
6. 拖拽/甩出/落下；落到窗口上沿 → 坐；窗口移动 → 跟随；窗口关闭 → 掉落。
7. 菜单栏上沿、Dock 上沿站立/坐下（workArea 边缘的视觉效果）。
8. 长时间无操作（≥ 3 分钟）：自主活动出现；鼠标回来会避让。
9. 摸头（圆形轨迹）/戳脸/戳身体/右键菜单。
10. 真实拖窗：授权后抓窗口上沿拖动；撤销权限后降级。
11. DSH 联动：开始任务→忙碌；完成→庆祝；关 DSH→静默；DSH 重启→恢复。
12. 多显示器、睡眠唤醒、启动项、退出后无残留进程。
13. 性能：闲置 30fps / 交互 60fps（可配置）；CPU 平均 <8%（M 系列）；内存 <500MB（贴图降采样后）；连续运行 1 小时无泄漏。

---

## 13. 尺寸说明（回应"半屏高"）

- 参考 Desktop Mate / MateEngine：角色通常占屏幕高度 **1/4 ~ 1/3**（1080p 约 270–360px）。
- **半屏高（≈540px @1080p）会非常挡桌面**，且模型细节会被放大（贴图/边缘更明显），交互区域过大也更容易误触。
- 结论（**2026-11-07 用户决定更新**）：**默认 50%（@1080p = 540px，「近景模式」）**；随后用户把可调上限从 50% 放宽到 **100%**（§19.11），30%（≈324px）仍可作标准大小。用户实机对比 30%/50% 后确认 50% 观感更好（§19.7 C / §19.8）。**100% 受 overlay 窗口高度（`display.workArea.height`）封顶**：1080p 下 bounds 1080 > workArea 961/963，实际约 89%，宠物不出窗。半屏/满屏会占更多桌面，故设置面板保留滑杆，后续如需可再调。
- 口径补充（Wave 0.5）：百分比基准是 **`display.bounds.height`**（1080p 的 ≈324px 不变）；宠物摆放/命中/渲染坐标以 **`display.workArea`** 为基准，因此菜单栏/Dock 存在时"屏幕高度占比"视觉上略大于工作区占比，属预期。

---

## 14. 风险与缓解

| 风险 | 缓解 |
|---|---|
| 启动/重建窗口抢焦点、抢 Dock 图标（打断用户输入） | `focusable:false` + `showInactive()` + `accessory` 激活策略/隐藏 Dock；smoke 断言 `isFocusable()/isFocused()`（§17.5 P1-5）；人工矩阵 §12-2 |
| 显示器拓扑/workArea 变化（分辨率、Dock/菜单栏自动隐藏、插拔屏）导致 overlay 错位、宠物尺寸漂移 | 监听 `display-added/removed/metrics-changed` debounce 重建 + `screens-updated` 推送重算；统一坐标口径（§17.3-2）；禁止启动快照 |
| `pet-asset://` 被 CSP 拦 / 目录穿越 / PMX 未随包分发 | 协议/CSP/`extraResources` 由 Lead 预置（§8.1）；handler 加固由 A3；`--check` 校验 optimized 内 PMX 副本 |
| 长跑误自杀/冒烟守护泄漏到正常模式 | smoke 守护仅 `PET_SMOKE_TEST=1` 挂载、成功即 clearTimeout、`process.on` 只注册一次；§12-3 长跑 ≥70s 回归 |
| 头发/衣摆物理：模型自带 284 刚体/318 关节，但接入 `MMDPhysics` + ammo.js 有包体/初始化成本 | 先做轻量发丝弹簧 + 呼吸/重心微动；效果不够再评估 ammo.js（见 §11） |
| 坐姿/爬行姿态程序化摆不自然 | 姿态库单独任务（B3），先做 3 个关键姿态，再迭代 |
| 透明窗在某些全屏/游戏上表现异常 | 实测矩阵；失败时自动隐藏（检测全屏 app）；不抢焦点 |
| 辅助功能权限被拒 | 降级已设计；设置页有引导与状态显示 |
| 贴图显存高（4K×多张） | `prepare-assets` 统一降到 2048，必要时按材质等级 1024 |
| 模型版权限制 | 不公开仓库/不分发；`assets/model/` gitignore；README 写明 |
| Electron 体积/内存 | 接受（个人工具）；持续监控，必要时换 Tauri（非本项目初期目标） |

---

## 15. 给并行 Agent 的通用规则

1. 开工前读本 PLAN 的对应任务行 + §8 契约（含 §8.1 `pet-asset://`）+ §17.3/§17.5；只改自己 Scope 内的文件。
2. `src/main/index.ts` **只有 Lead 能改**；`src/shared/**`、`package.json`、`pnpm-lock.yaml`、`electron.vite.config.ts`、`src/preload/**`、`src/shared/assets-manifest.json` 均为集成文件，Wave 1 任务不得改。需要 lifecycle/接线/契约变更 → 写进自己的 `src/main/ipc/*.ts` registrar 或提给 Lead。
3. **preload 已冻结**为唯一桥接面（完整 `PetApi`，含 `onScreensUpdated`）；**不要拆 `window-api.ts`/`config-api.ts`**，Wave 1 只在 main 侧补 handler。
4. 每个任务完成必须：`pnpm typecheck` 通过、`pnpm test` 相关用例通过、自测 Checklist 附在 PR/提交说明里。
5. 提交信息：`feat(<task-id>): ...`，例如 `feat(A2): pmx loader + toon materials`。
6. 不提交 `assets/model/**`、不把模型打进任何公开产物；`.gitignore` 已处理，提交前 `git status` 复查。
7. worktree 一律按 §6：`git worktree add` → `scripts/worktree-setup.sh <path>` → `pnpm dev:worktree`；**禁止**在 worktree 内 `pnpm install` / `pnpm assets:prepare`。
8. 遇到依赖未合并：基于 `main` 开发；接口按 §8 契约 stub 允许，**资产/协议/窗口几何不可 stub**（A2 必须用真模型验收）。
9. 每个任务最多一个窗口；跨任务协调走 Lead 或任务看板，不直接改别人 scope；同一时刻建议只跑 1 个实例做人工视觉验收。
10. 新增/续填 IPC handler 前先 `grep -R "ipcMain.handle" src/main` 确认该 channel 没有被其它 registrar 注册（同一 channel 重复 `ipcMain.handle` 会抛错，非 smoke 模式启动即 `app.exit(1)`）。ownership：`pet:set-ignore-mouse` / `pet:set-visible` / `pet:quit` 归 A1（`ipc/window.ts`）；`src/main/ipc/desktop.ts` 里 A4 做 `pet:windows`、C1 只做 `pet:move-window`。

---

## 16. 建议的开工顺序

> **Wave 0.5 前置修复已完成（2026-11-07）**：§17.5 的 P0/P1 项已落地（集成骨架、`pet-asset://` 协议 + CSP、A6 测试基建、worktree 脚本、占位图标、契约与文档修正）。修复后的独立复验结果见 §17.3-10（**已由 fresh-context verifier 独立复跑 + Lead 终验；复验发现的非阻断缺陷已修复，见 §17.4**）。

1. **窗口 1**：M0-1 + M0-2（脚手架 + 契约冻结）→ commit → 推 `main`——**已完成**。
2. **窗口 1**：M0-3（资源管线）→ commit——**已完成**；Wave 0.5 修复（PMX 入 optimized + generatedAt 幂等）随修复批次合入。
3. 并行开 **5 个**：A1、A3、A4、A5 + A2（A2 不再等 A3：协议/CSP 已预置；A2 可并行开发，视觉验收等 A1 窗口几何合并后再做）。
4. Wave 1 合入后，再开 **7 个**：B1–B7。
5. Wave 2 合入后，开 **4 个**：C1–C4。
6. 最后收口：Q1 验收、Q2 文档与打包。

> 备注：A5（DSH 桥插件）不依赖 Electron，可以在任何时间先做（安装验收用独立 DSH profile）；A4（Swift 窗口枚举）已在本机验证可行。**合并顺序**：A4/A5 → A3 → A1 → A2（见 §6）。

---

## 17. Wave 0 实施记录（2026-11-07，已完成）

> 本节记录落地后的真实环境/版本/决策，Wave 1+ 并行窗口直接引用；与 §5 原始计划冲突时以本节为准。

### 17.1 环境与版本（已实测）

- 环境：macOS 27.0.1（26A434）/ arm64 / Node v24.21.0 / **pnpm 10.20.0**（corepack 启用）；npm registry 可直连。
- 技术栈：**electron-vite 6.0.0、Electron 44.10.2、Vite 8.3.6、TypeScript 5.9.3**；electron-builder **尚未安装**（C4 再装）。渲染依赖已 pin **three 0.171.0 + @types/three 0.171.0**（Wave 1 开工前置，见 17.3-1）。
- `src/shared/**` 已冻结（环境中立纯 TS，禁止 import `electron` / `node:` 内置模块 / 第三方运行时依赖）；main/preload/renderer 三端统一 `@shared` → `src/shared` alias（electron.vite.config.ts + tsconfig paths）。
- **`three` 已在 Wave 1 开工前由 Lead 统一加入**（devDependencies；renderer 侧由 Vite 打包进产物，不会作为 node_modules 生产依赖进 app 包）——见 17.3-1。
- pnpm 10 + Electron 44 注意：Electron 二进制由根目录 `postinstall: install-electron` 下载（Electron 44 起依赖自身不再自动下载）；弱网可 `ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ pnpm install`。
- 本机 DSH / VS Code 系终端会继承 `ELECTRON_RUN_AS_NODE=1`，会让 Electron 以纯 Node 方式启动而崩溃；`dev/start/smoke` 脚本已加 `ELECTRON_RUN_AS_NODE=` 前缀抵消（普通终端无副作用）。新增 Electron 相关脚本沿用此写法。

### 17.2 交付物与验收结果（W0 基线为 fresh-context verifier 独立复跑；Wave 0.5 修复项由 2 位 fresh-context verifier 独立复验 + Lead 无沙箱终验，见 §17.3-10）

| ID | 交付 | 验收 |
|---|---|---|
| M0-1 | electron-vite 脚手架 + 透明置顶 overlay 空窗 + preload 严格白名单 `PetApi` 转发层（仅 `window.api`）+ renderer 占位。**Wave 0.5 修复**：smoke 守护只在冒烟模式挂载（正常 `pnpm dev`/`start`/`electron .` 不再 60s 自杀）、did-finish-load 成功后 clearTimeout；overlay 改 workArea 几何 + `showInactive()`/`focusable:false`/accessory（无 Dock 图标）；smoke 断言升级（`bounds===display.workArea` 精确、`isFocusable/isFocused===false`、`window.electron===undefined`/`window.api` 18 方法/`onScreensUpdated`、`pet-asset://` PMX fetch 200 且 byteLength===manifest.pmx.bytes、PMX/贴图确实位于 pet-asset 主根（dev=optimized/）、贴图 crossOrigin 不 taint、`windows-updated`/`screens-updated` 事件端到端） | W0 基线复跑：`pnpm install` / `pnpm install --frozen-lockfile` / `pnpm typecheck` / `pnpm build` 均 exit 0；`pnpm smoke` 打印 `SMOKE_OK` 并自动 exit 0；`pnpm dev` 可正常起窗。**Wave 0.5 独立复验 PASS（2026-11-07；verifier-runtime 动态 + verifier-static 静态 + Lead 默认命令终验，详见 §17.3-10）**：`pnpm smoke` 与 `pnpm smoke:file`（生产 loadFile 路径）均 exit 0，SMOKE_OK 新断言全过（bounds=`{0,30,1920,961}`===workArea、`isFocusable/isFocused=false`、`window.electron===undefined`/api=18、PMX 200/3,233,886B、贴图 1024×1024 且 `crossOrigin=anonymous` + `getImageData` 不 taint、`windows-updated`/`screens-updated` 各 1 次）；`pnpm dev` 长跑 78s、生产 `electron .` 长跑 72s 均无 `SMOKE_FAIL` 且进程存活（修复前 60s 必自杀） |
| M0-2 | `src/shared/{types,ipc,config,bridge-schema}.ts`，含 14 个 IPC + **4 个事件通道**（Wave 0.5 由 Lead 扩展 `screens-updated`）、`PetApi`、默认配置/`sanitizeConfig`、DSH 桥文件常量与校验函数（含 `offline?`/未来时间戳/64KB 行上限）、`AssetsManifest` 类型 | 契约评审通过；Node 直接 import + 31 项断言通过；`assets-manifest.json` 的结构/`schemaVersion` 由 `tests/assets-manifest.test.ts` 运行时断言（审查修复批 F-03 更正：原先「用 tsc 单独做结构化类型检查」的声明不可复现——JSON 数字会拓宽为 number，无法赋给 `schemaVersion: 1` 字面量；现以运行时测试为准）。**Wave 0.5 独立复验（verifier-static + Lead）**：`pnpm test` 59/59 通过（shared-contract 25 + bridge-schema 19 + assets-manifest 10 + assets-pipeline 5），其中覆盖未来 ts 不算 online、`offline:true`、TTL 边界、>64KB 行丢弃、`screens-updated` 通道与 `PetApi.onScreensUpdated`；复验修复批次补强后 **86/86（5 files）** 通过（新增 protocol-path 23 + sanitize 自有属性 3 + PetApi 键集合 + utf8 parity 等，见 §17.4） |
| M0-3 | `scripts/prepare-assets.mjs` + `assets/model/optimized/`（gitignore，**20 张 PNG + 1 个 PMX 字节级副本 = 21 文件**）+ `src/shared/assets-manifest.json`。**Wave 0.5 修复**：PMX 入 optimized（打包 payload 完整）、`--check` 校验 PMX 副本存在/大小/sha256 且多余 `.pmx` 报错、`generatedAt` 幂等（内容不变则不重写 manifest） | W0 基线：两次运行 exit 0 且 manifest 除 `generatedAt` 外完全一致；`--check` exit 0（同时校验 optimized/ 落盘产物的存在/大小/hash/多余受管产物——受管扩展名=图片与 `.pmx`；其它扩展名按设计保留，见 `scripts/prepare-assets.mjs` 头注）；原始 `assets/model` 31 个文件 sha256 全不变；独立校验 63/63 断言通过（3 张 4096×2048→2048×1024、17 张字节级拷贝、9 个未引用文件）；贴图总体积 21.73 MB → 8.56 MB（-60.6%）。**Wave 0.5 独立复验 PASS（2026-11-07；verifier-runtime + Lead）**：`pnpm assets:prepare` 连跑两次均 exit 0 且输出 `manifest 未变化`、`git diff src/shared/assets-manifest.json` 为空（sha256 仍 `35a5212c…`）；`--check` exit 0（`textures=20 resized=3 pmxCopy=1`）；`optimized/` 恰 21 文件，PMX 副本 3,233,886B 且 sha256 与 `manifest.pmx` 一致；`sharp` 精确 pin `0.35.5`（hash 可复现） |

### 17.3 关键决策 / Wave 1 必读

1. **three.js 版本（已定，A2 直接按此实现）**：three.js 自 **r172 起移除 MMD 相关的 5 个 addon 模块**——`MMDLoader` / `MMDAnimationHelper` / `MMDPhysics` / `MMDToonShader` / `MMDExporter`（r171 是最后一个包含它们的官方版本；已核实 r171 / r172 npm 包内容，three.js 官方论坛确认为减小体积提前移除），并同时移除了 three 包内 vendored 的 MMD parser（`examples/jsm/libs/mmdparser.module.js`）。**决策：pin `three@0.171.0` + `@types/three@0.171.0`**（devDependencies；@types 内含上述 MMD* 声明）。已做集成冒烟：`import { MMDLoader } from 'three/examples/jsm/loaders/MMDLoader.js'` 在 Vite 8 + TS 5.9 下 typecheck / build 均通过（renderer 打包 three 后约 624 KB，属预期）。备选（均暂不采用）：① **社区第三方重实现/维护分支**（如 `@yohawing/three-mmd-loader@0.8.6`，TS-first、peer three>=0.176；非官方维护，长期风险自担）；② vendor r171 的 MMD 模块配新版 three（API 漂移、升级成本高）。注意：`MMDLoader` 用的是 three 包内 vendored parser；npm `mmd-parser@1.1.4` 只是资源管线 `scripts/prepare-assets.mjs` 的构建期依赖（devDependencies），两者不要混淆。`MMDPhysics` 需外部 `ammo.js`，B2 阶段再决定是否引入（Wave 1 用 `physics:false`，见 §11 / §14）。
2. **overlay 窗几何（已定，A1/A2 按此实现）**：macOS 27 + Electron 44 会把 borderless 透明窗 `show()` 约束到菜单栏下方——Lead 复测：requested `{0,0,1920,1080}` → 实际 `{0,30,1920,1080}`（高度不变、底部溢出 30px），`setBounds` 不能绕过。**决策：overlay frame = `display.workArea`**（主屏当前 `{0,30,1920,961}`），菜单栏与 Dock 保持系统可交互，"坐菜单栏 / Dock 上沿"贴着 `workArea` 上 / 下边缘做视觉效果。`setSimpleFullScreen(true)` 虽能拿回整屏 `{0,0,1920,1080}`，但**退出后恢复到 `normalBounds`（即 workArea），不是"保持整屏"**，且有一次全屏过渡副作用 → **不采用**，仅当后续确实需要覆盖菜单栏区域（如宠物爬上菜单栏上方）时再评估。
   - **尺寸/坐标口径（修正 D6/§11 旧写法）**：`sizePercent` 基准 = **`display.bounds.height`**（D6：50% @1080p=540px；30%≈324px）；窗口定位/命中检测/渲染坐标基准 = **`display.workArea`**；`petHeightPx = sizePercent/100 × bounds.height`；脚底贴 `workArea` 底边；窗口本地坐标 = 全局坐标 − `win.bounds` 原点（primary 上 y 从 30 起，不是 0）；DPR 只用于 canvas backing store，命中检测用 DIP/CSS 像素。
   - **多屏与显示器变化**：每个 display 一个 overlay（D3），但 **Wave 1 只有主屏窗口加载/渲染宠物**，其余为透明空窗（renderer 依据 `pet:window-info.displayId` 判断），跨屏迁移留 B5/C4。**Wave 0.5 只预置「主屏 1 个 overlay + 显示器变化时同步几何并广播 `screens-updated`」；每 display 建窗/重建是 A1 的 Wave 1 实现任务**。A1 监听 `display-added` / `display-removed` / `display-metrics-changed`，debounce 200ms 后按新 `workArea` 重建/`setBounds`，并 `broadcast('screens-updated', DisplayInfo[])`；A2 订阅 `onScreensUpdated` + window `resize` 双保险重算。
3. **preload / 窗口安全（已定，Wave 1 冻结）**：W0 早期 `@electron-toolkit/preload` 额外暴露 `window.electron`（任意 channel 的 ipcRenderer + **`process.env` 全量宿主环境变量**）的问题已移除；现在 preload **只暴露 `window.api`**（完整 `PetApi`，含 `onScreensUpdated`），**Wave 1 无需也不再拆分 `window-api.ts`/`config-api.ts`**——preload 已冻结，各任务只在 main 侧补 handler。`webPreferences` 已切到 **`sandbox: true`**（`contextIsolation:true`、`nodeIntegration:false`、`webSecurity` 默认 true 不变；preload 只用 contextBridge/ipcRenderer，three/WebGL 不需要 sandbox:false）。同时已加：`will-navigate`/`will-redirect` 全拒（dev 仅放行 renderer dev URL 同源）、`setWindowOpenHandler` → deny、`session.setPermissionRequestHandler`/`setPermissionCheckHandler` 全拒。唯一允许的 webPreferences 改动由 Lead 做，A1/A3 不得自行修改。
4. **契约细节（Wave 0.5 已更新，B6/B7 直接用）**：`pet:set-config` 入参 `Partial<PetConfig>`、返回清洗后的 `PetConfig`；`pet:screen-info` 返回 `DisplayInfo[]`（含 `bounds`/`workArea`/`scaleFactor`/`isPrimary`）。事件通道共 **4 个**：`windows-updated` / `dsh-event` / `config-changed` / **`screens-updated`**（`PetApi.onScreensUpdated(DisplayInfo[])`）。`DshStatus`：**未来时间戳不算 online**（需 `now >= ts`）；`DshBridgeStatusFile.offline?: boolean` 是插件退出时的显式离线标记，为 true 时即使 ts 新鲜也判 offline；offline 时仍透传 running/lastEventAt/lastType，**B7 必须只看 `online`**。`parseDshEventLine` 强制 `BRIDGE_MAX_LINE_BYTES = 64KB` 上限，超长/脏行返回 null。`pet:move-window` 的 payload 是占位结构，C1 如需扩展先走 Lead 契约评审。
5. **已注册 handler 现状（Wave 0.5）**：Lead 预置了 `pet:window-info`、`pet:screen-info` 两个 handler 与 `screens-updated` 推送；其余 channel 由 Wave 1 各任务在自己的 `src/main/ipc/*.ts` registrar 中注册（未注册前 renderer 侧保持 catch）。集成骨架 `src/main/app-context.ts` / `src/main/ipc/index.ts` 已预置，A1/A3/A4 只填各自 registrar。
6. `src/shared/assets-manifest.json` 已生成、可提交（不含模型二进制）；`assets/model/**` 仍在 `.gitignore` 内，提交前 `git status` 复查。
7. **打包 / 工作树流程（Wave 0.5 修正）**：
   - 打包：`extraResources` 放 `assets/model/optimized/**` → `process.resourcesPath/model`（optimized 内已含 PMX 副本 + 20 贴图，**打包不会缺 PMX**；原「只放 optimized 贴图」写法作废），C4 打包前先在主工作树 `pnpm assets:prepare`。`pet-asset://` dev 根 `assets/model/optimized`、prod 根 `resources/model`（§8.1）。
   - 工作树：`git worktree add` → `scripts/worktree-setup.sh <path>`（软链 `node_modules`/`assets/model` + 打印 `PET_PROFILE`）→ `cd <path> && pnpm dev:worktree`；**禁止** worktree 内 `pnpm install` / `pnpm assets:prepare`（§6）。
8. **依赖与脚本清单现状（Wave 0.5 后）**：
   - `dependencies`：仅 `@electron-toolkit/utils`（main 进程运行时）。
   - `devDependencies`：electron ^44.7.2（安装 44.10.2）/ electron-vite ^6.0.0 / vite ^8.3.4 / typescript ^5.9.3 / **three 0.171.0（精确 pin）** / **@types/three 0.171.0（精确 pin）** / mmd-parser ^1.1.4（仅资源管线构建期）/ **sharp 0.35.5（精确 pin，保证 manifest hash 可复现）** / **vitest ^5.1.0（安装 5.1.0）** / @electron-toolkit/tsconfig / @types/node。
   - scripts：`dev`、**`dev:worktree`**（自动 `PET_PROFILE=$(bash scripts/print-profile.sh "$PWD")`，与 app 侧 `DEV_PROFILE_PATTERN` 同源规范化，M-4）、`start`、`smoke`、**`smoke:file`**（生产 loadFile 路径；二者先跑 `node scripts/build-native.mjs` 保证 native 助手存在）、`typecheck`/`typecheck:node`/`typecheck:web`、`build`、**`test`/`test:watch`**（vitest，配置为 `vitest.config.mts`）、`assets:prepare`、**`native:build`/`native:check`**、`postinstall: install-electron`。
   - 新增依赖仍由 Lead 统一改 `package.json` + `pnpm-lock.yaml`；并行窗口不要自己 `pnpm add`（尤其 worktree 里）。
9. **安全状态（Wave 0.5 修复后）**：`webPreferences.sandbox:true` 已切换（见第 3 条），preload 仍严格白名单（只 `window.api`）；导航/重定向/新窗口/权限请求全部拒绝；CSP Wave 1 基线含 `pet-asset:`（`img-src` / `connect-src`），其中 `connect-src 'self' ws: pet-asset:` 的 `ws:` 只是 dev HMR，**C4 生产构建必须收紧**并在构建脚本 / `electron-builder.yml` 落实记录。smoke 已断言 `window.electron===undefined`、`window.api` 18 方法、事件通道端到端，防暴露面复发。另注意：smoke JSON 里的 `constructOnly` 段（`transparent`/`ignoreMouse`/`sandbox`/`backgroundThrottling`/`textureCrossOrigin`）是构造期配置自报值（Electron 无公开 getter），不是运行时查询；`window`/`smoke`/`assetRoots`/`taint` 等其余字段均来自运行时查询或状态推导（复验修复批次已消除 9 处硬编码，见 §17.4）。另：dev HMR 在 `script-src 'self'` + `ws:` 下已由 `pnpm smoke`/`smoke:file` 默认形式通过验证（C4 生产收紧仍待办）。排障以源码/断言为准。
10. **独立复验（2026-11-07；证据在 `tests/tmp/`，不随 git 提交）**：
    - **Wave 0**：由 fresh-context verifier 完整复跑（依赖复现 / typecheck / build / smoke / preload 白名单 / 契约 / 资源管线两遍一致性 + 455 项独立断言 / three 准备度 / 范围卫生），15/15 检查点 PASS、裁决可交付；其发现的 `--check` 不校验 optimized/ 落盘产物缺口已修复。
    - **Wave 0.5 修复后**：
      - `verifier-runtime`（fresh context，19:44–19:52）：§17.5 验收命令逐项复跑，13 个检查点 PASS（install/typecheck/test/build/smoke/smoke:file/长跑/assets `--check`+幂等/worktree/图标/环境/卫生）；4 份 `SMOKE_OK` 载荷共 **152 项独立断言全过**；报告 `tests/tmp/verify-runtime/report.md`。
      - `verifier-static`（fresh context，19:44–20:05）：对抗性源码审计，**0 BLOCKER / 0 HIGH**；17 例恶意 `pet-asset://` URL 全部拒绝、无安全逃逸路径；发现 6 项 MED + 9 LOW + 4 DOC，报告 `tests/tmp/verify-static/report.md`。
      - **本轮修复批次已处理全部可执行 MED/LOW/DOC**（MED-1 worktree 目标校验、MED-2 smoke 资产根断言、MED-3 ownership、MED-4 smoke 自报字段、MED-6 PET_PROFILE 对齐，以及 LOW-1/2/3/4/5/6/7/11/12、DOC-1/2/3 与覆盖补强），明细见 §17.4；修复后 `pnpm test` **86/86（5 files）**，typecheck/build/smoke/smoke:file/assets/长跑全部回归通过。
      - **Lead 默认命令终验**（20:10–20:13，无沙箱会话）：`pnpm install --frozen-lockfile` / `typecheck` / `test` / `build` / `smoke` / `smoke:file` / `assets:prepare --check` / 资源幂等 ×2 / `pnpm dev` 与生产 `electron .` 各 75s 长跑全部 exit 0 或 PASS（日志 `tests/tmp/lead-final/`；smoke 关键字段与 §17.2 一致）。
    - **环境注意（DSH agent 沙箱会话）**：`workspace-write` 沙箱禁止写工作区外的 pnpm store，并阻止嵌套 Chromium sandbox 初始化，因此沙箱内 `pnpm install --frozen-lockfile` 会报 `ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY`、`pnpm smoke` 会报 `sandbox initialization failed: Operation not permitted`，**这不是仓库缺陷**（等价/提权/普通终端均通过）。沙箱内复跑请用等价命令（install 加 `--lockfile-only` 或 `--store-dir=<.modules.yaml 记录的 store>`；smoke 用 `ELECTRON_DISABLE_SANDBOX=1` + `HOME`/`TMPDIR` 指向工作区，仅限本地验证），或提权/普通终端执行原始命令。
    - **口径说明**：§17.2/§17.5 的「复验 PASS」指 fresh-context verifier 独立复验 + Lead 终验；Lead 本人的复跑记录只作为终验证据，不单独称为「独立复验」。

### 17.4 提交记录

- `feat(M0-2)` 冻结共享契约 → `feat(M0-1)` 脚手架 + 透明 overlay → `feat(M0-3)` 资源管线 → `docs` 本记录；均以 `git log` 为准。
- Wave 1 开工前置（2026-11-07 补记）：`refactor(M0-1)` preload 严格白名单（移除 `window.electron` / `process.env` 暴露面）、`chore(deps)` pin three 0.171.0 + 移除 `@electron-toolkit/preload`、`docs` 本节决策更新、`fix(M0-3)` `--check` 补校验 optimized/ 落盘产物。
- Wave 0.5 修复批次（2026-11-07，**已合入 main**；基线 tag **`wave0-baseline` = `b9ffbfd`**，提交 hash 以 `git log` 为准）：
  - `fix(M0-2): DSH 契约 future-ts/offline/64KB + screens-updated 事件`
  - `feat(M0-4): workArea overlay / 焦点与 Dock / pet-asset 协议 / CSP + smoke 守护修复`（含 M0-1 HIGH 缺陷修复）
  - `chore(deps): pin sharp 0.35.5 + 引入 vitest 5.1.0（test/smoke:file/dev:worktree 脚本）`
  - `fix(M0-3): PMX 入 optimized + generatedAt 幂等 + --check 扩展`
  - `test(A6): vitest 测试基建 + 契约/资源测试`
  - `docs: Wave 1 开工前置清单（§17.5）+ worktree-setup 脚本 + 占位图标`（含 `.gitignore` 防 tsc 误产物）
- Wave 0.5 复验修复批次（2026-11-07，MED/LOW/DOC 修复 + 覆盖补强；hash 以 `git log` 为准；原 tag `wave0.5-fixed` 曾误指修复前 `1343b99`，审查修复批已将其移到修复后 `fff09aa`，原提交保留 tag `wave0.5-pre-fix`）：
  - `fix(wave0.5): 复验缺陷修复——worktree 目标/仓库校验与 PET_PROFILE 对齐（MED-1/6）、pet-asset 主根与 host+port/realpath 加固（MED-2/LOW-2/3/4）、smoke 证据自洽（MED-4）与 debounce 200ms（LOW-1）、ownership 注释（MED-3）`
  - `test(wave0.5): protocol-path 安全用例 + sanitizeConfig 自有属性 + utf8 parity + PetApi 精确类型断言（LOW-6/7 覆盖补强）`
  - `fix(icons): 写盘读回自校验 + 原子 rename + changed 状态（LOW-11）`
  - `docs(PLAN): 复验口径与环境注意、§8.1 dev 根/安全要求同步（MED-5/DOC-1/2/3）`

---

### 17.5 Wave 1 开工前置清单（2026-11-07 修复）

> 背景：T4 对抗性复核（`tests/tmp/wave1-gaps/report.md`）发现 **4 类 P0 硬阻塞 + 7 类 P1 规格缺口**，本轮修复已全部落地（代码由 Lead/WS1/WS3 提交，文档/脚本/图标由 WS4 提交；最终以工作区代码为准）。本节是 Wave 1 各窗口的**开工说明**；与 §5/§6/§7/§8/§11/§17.3 表述冲突时，以本节 + §17.3 为准。
> 状态标记：✅ = 修复项已实现，并已由 fresh-context verifier 独立复验 + Lead 终验（2026-11-07，§17.3-10）；其中 6 项 MED 非阻断缺陷已由后续修复批次处理（§17.4）。

#### P0（开工即卡，已修）

- **P0-1 worktree 私有依赖/资产 → `scripts/worktree-setup.sh`** ✅
  `git worktree add` 不带 `node_modules/` 与 `assets/model/**`（均 gitignore）。新 worktree 一律：
  ```bash
  cd /Volumes/4TB外置盘/deepseek-harness/aventurine-pet
  git worktree add ../wt-a2 -b feat/a2-render
  scripts/worktree-setup.sh ../wt-a2
  cd ../wt-a2 && pnpm dev:worktree
  ```
  脚本从主工作树软链 `node_modules`、`assets/model`（幂等；目标已是真实目录时拒绝覆盖并报错），打印 `PET_PROFILE` 用法；`PET_PROFILE` 使 dev userData 隔离到 `~/Library/Application Support/aventurine-pet-<profile>`。**禁止** worktree 内 `pnpm install` / `pnpm assets:prepare`。**复验修复（MED-1/MED-6）**：脚本强校验目标必须是 linked worktree 根且与本仓库同源（子目录 / 其它仓库直接报错），并把 PET_PROFILE 规范化为与 app 侧 `DEV_PROFILE_PATTERN` 完全一致的字符串（如 `_wt` → `wt-_wt`、全非 ASCII → `wt-<cksum>`）。
- **P0-2 集成文件死锁 → 集成骨架由 Lead 预置** ✅
  `src/main/index.ts` **仅 Lead 可改**；已预置 `src/main/app-context.ts`（overlay 注册表 + 类型安全 `broadcast`）、`src/main/ipc/index.ts`（`registerIpcHandlers(ctx)` 聚合 window/config/desktop registrar）、`src/main/protocol.ts` 接线。A1/A3/A4 只填自己的 `ipc/{window,config,desktop}.ts` 与模块，不改 index.ts；`src/preload/**` 冻结（**不拆** window-api/config-api）。
- **P0-3 A2 的协议/CSP/打包阻塞 → `pet-asset://` + CSP + PMX 入 optimized** ✅
  详见 §8.1：URL `pet-asset://model/<文件名>`；dev 根 `assets/model/optimized`（**无回退**；smoke 额外从主进程断言 PMX/贴图存在于该根，保证「PMX 已进 optimized」证据成立）、prod 根 `resources/model`；privileges `{standard, secure, supportFetchAPI, corsEnabled, stream}`（必须在 ready 前 registerSchemesAsPrivileged）；CSP 加 `img-src`/`connect-src pet-asset:`；`optimized/` = PMX 副本 + 20 贴图（21 文件），`extraResources` 映射到 `model/`。**A2 不再被 A3 阻塞**。
- **P0-4 测试基建 A6 → vitest 落地** ✅
  Lead 预置 `vitest@5.1.0` + `pnpm test` / `test:watch`；`vitest.config.ts`、`tests/setup.ts` 与首批契约/资源单测随修复批次落地。A6 已从 Wave 1 并行表移除；各任务只**新增**自己的 `*.test.ts`，依赖真实模型的测试用 `describe.skipIf`（干净 clone/CI 全绿）。

#### P1（返工/验收失真，已定规格）

- **P1-5 焦点/Dock（A1 必做）**：`focusable:false` + 显示一律 `showInactive()`（禁止 `show()`/`focus()`）；`app.setActivationPolicy('accessory')` + `app.dock?.hide()`（darwin）；smoke 断言 `isFocusable()===false && isFocused()===false`；人工验收见 §12-2。
- **P1-6 显示器变化（契约已扩展）**：事件通道 `screens-updated`（`DisplayInfo[]`）+ `PetApi.onScreensUpdated`；A1 监听 `display-*` debounce 200ms 重建/`setBounds` 并广播；A2 订阅重算 + window `resize` 双保险。
- **P1-7 坐标系/尺寸（统一口径，见 §17.3-2）**：尺寸基准 `display.bounds.height`；定位/命中/渲染基准 `display.workArea`；本地坐标 = 全局 − `win.bounds` 原点；DPR 只进 canvas backing store；Wave 1 每 display 建窗但**仅主屏渲染宠物**。
- **P1-8 图标占位（`assets/icons/`）** ✅：`trayTemplate.png`（16×16）/`trayTemplate@2x.png`（32×32）为黑+alpha template image；`app-icon-placeholder.png`（512×512）；全部自绘、无版权问题；README 说明占位性质与替换流程，`node assets/icons/generate.mjs` 可重生成并自校验。A1 消费托盘图，C4 转 `.icns`。
- **P1-9 安全基线（已定）**：`sandbox:true`、CSP 含 `pet-asset:`、`will-navigate`/`will-redirect`/新窗口/权限全拒（§17.3-3/9）；A1/A3 不改 webPreferences；生产 CSP 收紧留 C4。
- **P1-10 设置窗/退出/显隐归属**：A1 在 `src/main/ipc/window.ts` 注册 `pet:set-ignore-mouse` / `pet:set-visible` / `pet:quit`，托盘菜单调用同一组函数；设置窗（`focusable:true` 普通窗 + `src/renderer/settings.html`）归 B6，第二入口由 Lead 在 Wave 2 前加。**复验修复（MED-3）**：`src/main/ipc/desktop.ts` 所有权注释已同步——A4 做 `pet:windows`、C1 仅 `pet:move-window`，`set-ignore-mouse`/`set-visible`/`quit` 只由 A1 注册（防止重复 `ipcMain.handle` 启动崩溃）。**另（LOW-13）**：托盘接入后 `window-all-closed → app.quit()` 的退出语义需同步调整（隐藏窗口不应退出 app），该改动在 Lead 的 Wave 1 A1 合并窗口完成。
- **P1-11 验收可测性**：自动化断言见 §12 与 `pnpm smoke`；人工项（点击穿透、全屏之上、贴图/表情）每任务 ≤3 条且带通过判据；接口可 stub，**资产/协议/窗口几何不可 stub**（A2 必须用真模型验收）。
- **P2 同步处理**：单实例锁只在打包版启用（dev 多实例靠 `PET_PROFILE` 隔离）；FPS 上限归 A2 实现；A5 安装验收用独立 DSH profile；`assets/model/**` 的 manifest 只在 Lead 集成窗口 regenerate；**手工跑 `tsc` 必须加 `--noEmit`**（无 emit 的 `*.js` 会被 Vite 优先解析、遮蔽同名 `.ts`；`.gitignore` 已忽略 `src/**/*.js` 等误产物作为兜底）。`prepare-assets.mjs` 的 `--check`/清理只管理「图片 + `.pmx`」受管产物（其它扩展名保留，LOW-8）；write 模式非事务（中途失败重跑自愈，`--check` 可发现中间态，LOW-9），且不要与 `--check` 并发（LOW-12）；write 模式 `generatedAt` 幂等不写单测（会弄脏 tracked manifest），由 §17.5 命令 3 验收。

#### 各 Wave 1 任务接口约定（照此开工）

- **A1**：只写 `src/main/windows/**`、`src/main/tray.ts`、`src/main/ipc/window.ts`（续填）；消费 `assets/icons/trayTemplate.png`；窗口选项/lifecycle/smoke 由 Lead 的 `index.ts` 接线；屏幕事件 → 重建 overlay + `screens-updated`；另注册 `pet:set-ignore-mouse`/`pet:set-visible`/`pet:quit`。
- **A2**：写 `src/renderer/{scene,model,assets}/**` + `index.html` + `src/main.ts`（唯一 owner）；用 `pet-asset://model/<encodeURIComponent(文件名)>` 加载 `assets/model/optimized/` 内 PMX 副本 + 20 贴图；`MMDAnimationHelper.add(mesh, {physics:false})`；FPS 控制器读 `fpsCap`；尺寸/坐标按 §17.3-2；订阅 `onScreensUpdated`。
- **A3**：协议主体/接线已预置，只做加固与映射文档（`decodeURIComponent`/防穿越/ACAO/404-403）+ `src/main/config.ts` / `logger.ts` / `ipc/config.ts`；config 变更广播 `config-changed`。
- **A4**：`native/winlist/**` + `src/main/desktop/winlist.ts` + `src/main/ipc/desktop.ts`；注册 `pet:windows` + 变化时 `windows-updated` 推送（500ms）；测试 `tests/winlist.test.ts`。
- **A5**：`bridge/**` 独立包；桥常量与 `src/shared/bridge-schema.ts` 单一来源（import 或 parity test）；安装验收用独立 DSH profile；产物写 `~/.dsh/aventurine-pet/`，失败只 warn。

#### 修复后验收命令（Lead 复验按此跑）

```bash
# 0) 主工作树状态/工作树列表（除本轮预期改动外应干净）
cd /Volumes/4TB外置盘/deepseek-harness/aventurine-pet
git status --short && git worktree list && git log --oneline -8

# 1) 依赖 / 类型 / 测试 / 构建
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm build

# 2) 两种冒烟（dev + 生产 loadFile）+ 长跑回归
pnpm smoke          # 期望 SMOKE_OK + exit 0 + 新断言全过（几何/focus/协议/事件/白名单）
pnpm smoke:file     # 期望 exit 0（生产 loadFile 路径）
# 长跑：pnpm dev 运行 ≥70s，不应出现 SMOKE_FAIL、进程不退出

# 3) 资源管线（PMX 已入 optimized）
pnpm assets:prepare --check    # 期望 exit 0（含 PMX 副本校验）
# 幂等：主工作树 pnpm assets:prepare 连跑两次后，git status 不应出现 src/shared/assets-manifest.json

# 4) worktree 脚本探针（结束时必须清理，git worktree list 恢复原状）
git worktree add --detach tests/tmp/wt-setup-probe HEAD
scripts/worktree-setup.sh tests/tmp/wt-setup-probe
test -x tests/tmp/wt-setup-probe/node_modules/.bin/electron-vite && echo NODE_MODULES_LINK_OK
ls tests/tmp/wt-setup-probe/assets/model/optimized/*.png >/dev/null && echo ASSETS_LINK_OK
git worktree remove --force tests/tmp/wt-setup-probe && git worktree prune
git worktree list   # 应恢复仅主工作树

# 5) 图标（尺寸/alpha + 可重生成）
file assets/icons/trayTemplate.png assets/icons/trayTemplate@2x.png assets/icons/app-icon-placeholder.png
node assets/icons/generate.mjs   # 期望幂等、全部 OK
```

> 环境注意：DSH workspace-write 沙箱会话内第 1/2 步默认命令会因沙箱失败（见 §17.3-10「环境注意」）；请用等价命令或提权/普通终端复跑。修复批次后 smoke 额外输出 `smoke`/`constructOnly`/`assetRoots`/`taint` 字段（MED-2/MED-4 证据自洽）。
>
> 复验结果：Wave 0.5 已由 `verifier-runtime` / `verifier-static` 独立复验 + Lead 无沙箱终验（2026-11-07，§17.3-10）；修复批次后 `pnpm test` 86/86、typecheck/build/smoke/smoke:file/assets/长跑全部通过；本节 ✅ = 已实现且复验通过。

---

## 18. Wave 1 调研记录（2026-11-07，Lead 开工前调查）

> 目的：Wave 1 五个并行任务开工前，对「怎么弄」做参考资料调查（GitHub 参考项目 / 官方文档 / 论文 / 视频攻略），并把可执行结论固化。外部资料仅作参考，实现仍以本 PLAN 冻结契约为准；与 §8/§17.3/§17.5 冲突时以契约与 §17.3/§17.5 为准。

### 18.1 参考项目与资料

| 主题 | 参考 | 可复用结论（→ 本 Wave 任务） |
|---|---|---|
| 点击穿透 / 前向鼠标事件 | Electron 官方 [Custom Window Interactions](https://www.electronjs.org/docs/latest/tutorial/custom-window-interactions) | `setIgnoreMouseEvents(true, { forward: true })` 仍投递 mousemove 给页面，可做命中检测后再切回拦截；与 PLAN §4 的技巧一致（A1/A2） |
| DSH 桌面伴侣（Electron 44 同版本） | [takboo/dsh-coopanion](https://github.com/takboo/dsh-coopanion)（`docs/multi-display-contract.md`、`desktop/display-controller.cjs`、`desktop/always-on-top.cjs`） | ① 一个透明原生窗只覆盖一块显示器的 workArea，**不用所有屏的包围矩形**；② 显示器 DIP 与 renderer CSS 像素分离、几何消息带 revision、只信匹配 revision 的 cursor；③ 布局变化优先保留仍存在的 display id，移除后按到最近 workArea 迁移；④ `displayTarget()` 写成纯函数便于注入测试；⑤ always-on-top 在 win32 有丢失 TOPMOST 问题需周期 repair，macOS 无需（我们的 A1 只做 macOS，但仍用 `screen-saver` 层级，见 P1-5） |
| macOS 桌宠主进程实践 | [xiangzi1025/desktop-pet-macos](https://github.com/xiangzi1025/desktop-pet-macos)（Electron） | 透明窗 + `showInactive()` + `setIgnoreMouseEvents(true,{forward:true})` + workArea 定位 + 多显示器优先当前屏；行为循环/状态机拆独立模块（behavior.js）。A1 窗口/托盘、A2 渲染器分层可参考其模块划分 |
| three.js MMD | [three.js r171 webgl_loader_mmd 示例](https://github.com/mrdoob/three.js/blob/r171/examples/webgl_loader_mmd.html) + 本仓库 `node_modules/three/examples/jsm/loaders/MMDLoader.js` 源码实测 | 见 §18.2（A2 必读） |
| Swift 窗口枚举 | [trailofbits macos_window_info.swift](https://github.com/trailofbits/skills-curated/blob/main/plugins/openai-screenshot/skills/openai-screenshot/scripts/macos_window_info.swift) | `CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID)` + `kCGWindowNumber/OwnerName/OwnerPID/Layer/Alpha/Bounds` 即可；**窗口标题才需要屏幕录制权限，bounds/pid/layer/owner/alpha 不需要**（A4；PLAN §10 已实测） |
| DSH 插件开发 | 本机 app 内 skill：`@deepseek-ai/dsh-agent-preset/skills/cordis-plugin-development`（`references/host-plugin.md`、`practices.md`）+ 已安装插件源码 | host-only bundle 格式：`package.json` 的 `dsh.bundle.patch` 指向 `cordis.patch.yml`（`- insert: [{ id, name, config? }]`），入口 `export function apply(ctx, config)` / `export const inject`；插件需 `locale/{en,zh}.json` 的 `meta.title/description` + 图标（`files`/`exports` 同步）；全局事件用 `{ global: true }`：`agent/status`（payload `{ agent }`，status 仅 `'idle'|'running'`，只在变化时 emit）与 `session/event`（`(session, event)`）。参考实现：`dsh-api-session-controller/lib/types/state/listener.js`、`dsh-experimental-agent-team/lib/index.js`（A5） |
| 学术论文（HCI） | [Presence You Can Ignore: Engineering Non-Intrusion in a Shipping Desktop Companion](https://zenodo.org/records/22806803)（Zenodo，DOI 10.5281/zenodo.22806803，CC-BY-4.0）；[Evaluating How Desktop Companion Robot Behaviors Influence Work Experience and Robot Perception](https://dl.acm.org/doi/10.1145/3613905.3651027)（ACM CHI 2024） | 桌面伴侣「非侵入」工程参数：环境微动取 **0.15–0.42 Hz 锚定振荡**（感知文献中最不干扰的频段）；未经请求的话语「送达即完整、定时过期、无关闭 affordance、不被计数」；显眼行为用 **variable-time** 调度（区别于说服设计的 variable-ratio）；活动抑制轴用「用户不在」而非「用户忙」；论文自述失败点：角色 37.5% 流浪片段浮在普通窗口之上且无前台窗口豁免、面板覆盖所有 app。→ A1 不抢焦点/不挡交互的边界、A2 呼吸/微动频率、Wave 2 B1/B3/C3 行为调度参数（本轮只记录，不改 Wave 1 范围） |
| B 站/中文攻略 | [BV14u411c7TB](https://www.bilibili.com/video/BV14u411c7TB/)、[BV1Se4y1u7Ag](https://www.bilibili.com/video/BV1Se4y1u7Ag/)、[BV1Aw411j7NW](https://www.bilibili.com/video/BV1Aw411j7NW/)；[Vue3+Electron 桌宠实践](https://www.cnblogs.com/smileZAZ/p/23417675) | 与官方文档一致（透明窗 + 穿透 + 托盘 + 多显示器 + 上层应用窗口沿边巡逻）；未提供超出官方文档的新技术，作为学习路径记录，不作为实现依据 |

### 18.2 three.js r171 / MMD 实测要点（A2 必读）

- MMD 系 addon 模块 r172 起被删，必须用 r171（§17.3-1 已定，依赖已 pin）。
- 加载：`MMDLoader.load('pet-asset://model/' + encodeURIComponent(pmx文件名), cb, onProgress, onError)`。纹理基址 = `LoaderUtils.extractUrlBase(url)` 即 `pet-asset://model/`；PMX 内贴图名是相对文件名（含 CJK/空格），浏览器会自动百分号编码 → `pet-asset://model/衣.png` 应能命中。若个别纹理 404，用 `LoadingManager.setURLModifier` 对 `pet-asset:` URL 的路径段 `encodeURIComponent` 后重试（A2 验收：20 张贴图全部 ready）。
- **材质 morph：r171 `MMDLoader` 对 `morph.type === 8` 是 `// TODO: implement`**（`MMDLoader.js` 的 `buildMorphTargets` 分支），但每个材质 morph 仍会生成一个零位移的 morphTarget，`mesh.morphTargetDictionary['照れ']` 存在。A2 需在渲染循环里读这三个 morph 的 `morphTargetInfluences` 权重并**手动改材质**：`照れ` → `颜赤` alpha += w；`目影消` → `目影` alpha ×= (1−w)；`目影濃` → `目影` alpha += w（材质按名称 trim 后查找；细节见 [docs/model-morphs.md](docs/model-morphs.md)）。
- 无 VMD 时 `MMDAnimationHelper.add(mesh, { physics: false })` 仍会创建 ikSolver/grantSolver（`_setupMeshAnimation` 无条件创建），`helper.update(dt)` 会跑 IK/grant——Wave 1 的静态站姿/呼吸可先挂它，B2/B3 再驱动骨骼。
- 渲染：正交相机；`WebGLRenderer({ alpha: true, antialias: true })` + `setClearColor(0x000000, 0)`；MMDToonMaterial 需要 ambient + directional 光（官方示例强度 3）；容器透明、`pointer-events: none`；DPR 只用于 canvas backing store（§17.3-2）。
- 尺寸/坐标：`petHeightPx = min(clamp(sizePercent,10,100)/100 × display.bounds.height, display.workArea.height)`（100% 封顶，§19.11）；脚底贴 `workArea` 底边；本地坐标 = 全局 − `win.bounds` 原点（主屏 y 从 30 起）。

### 18.3 调研结论对 Wave 1 的落地约束

- **A1**：多屏一律「每 display 一个 overlay + frame = 该 display.workArea」，禁止用所有屏包围矩形；显示器移除时按最近 workArea 迁移当前屏选择；`setAlwaysOnTop(true,'screen-saver')` + `setVisibleOnAllWorkspaces(true,{visibleOnFullScreen:true})`；显示只走 `showInactive()`；窗口穿透/显隐/退出/辅助功能 handler 归 A1。
- **A2**：视觉验收不能只靠「窗口起来了」——必须用 `capturePage` 出 PNG（Lead 已提供 `tests/tmp/capture.cjs` 采集器）+ alpha 覆盖/包围盒统计做自动断言，Lead 再人工看图；调试面 `window.__aventurineDebug`（ready/model/morphs/stats）供 smoke 与实机断言（A2 实现）；环境呼吸/微动频率取 0.15–0.42Hz 档。
- **A3**：config 持久化与日志必须能在无 Electron 的 vitest 环境用注入目录单测（不依赖 `app.getPath`）。
- **A4**：Swift 枚举无需录屏权限（bounds/pid/layer/owner/alpha 均可得；不使用窗口标题）；TS 侧 spawn 可注入 mock 便于单测。
- **A5**：host-only bundle（`dsh.bundle.patch`）；事件订阅用 `{ global: true }`；桥常量与 `src/shared/bridge-schema.ts` 单一来源用 parity test 对齐；测试用 fake ctx + 临时目录；**安装验收由 Lead 在独立 profile（`pet-bridge-test`）收口，A5 不得装进当前正在使用的 profile**。

### 18.4 参考资料链接（完整）

- Electron Custom Window Interactions — https://www.electronjs.org/docs/latest/tutorial/custom-window-interactions
- three.js r171 MMD 示例 — https://github.com/mrdoob/three.js/blob/r171/examples/webgl_loader_mmd.html
- MMDLoader / MMDAnimationHelper 源码 — `node_modules/three/examples/jsm/loaders/MMDLoader.js`、`node_modules/three/examples/jsm/animation/MMDAnimationHelper.js`
- takboo/dsh-coopanion — https://github.com/takboo/dsh-coopanion
- xiangzi1025/desktop-pet-macos — https://github.com/xiangzi1025/desktop-pet-macos
- Swift CGWindowList 参考 — https://github.com/trailofbits/skills-curated/blob/main/plugins/openai-screenshot/skills/openai-screenshot/scripts/macos_window_info.swift
- Presence You Can Ignore（DOI 10.5281/zenodo.22806803）— https://zenodo.org/records/22806803
- CHI 2024 desktop companion robot study — https://dl.acm.org/doi/10.1145/3613905.3651027
- B 站参考视频 — https://www.bilibili.com/video/BV14u411c7TB/ 、https://www.bilibili.com/video/BV1Se4y1u7Ag/ 、https://www.bilibili.com/video/BV1Aw411j7NW/
- Vue3 + Electron 桌宠实践 — https://www.cnblogs.com/smileZAZ/p/23417675
- DSH host-only 插件开发 skill — 本机 app 内 `@deepseek-ai/dsh-agent-preset/skills/cordis-plugin-development/`（`references/host-plugin.md`、`references/practices.md`、`templates/decoration/*`）

---

## 19. Wave 1 实施记录（2026-11-07，全部完成并合入 main）

> 状态：**A1–A5 全部完成并合入 main**（并行基线 `6fab7bc` → 合并后 `b2a420b`）；5 个并行 worktree 已清理（仅保留主工作树）。调研依据见 §18，开工前置见 §17.5。

### 19.1 提交与合并记录（hash 以 `git log` 为准）

| 任务 | 分支 | 提交 | 合并提交 | 交付摘要 |
|---|---|---|---|---|
| A1 | feat/a1-windows | `03c14ca` | `1e93c7d` | 多屏 overlay 管理器（每 display 一个 workArea 透明窗；display-* debounce 200ms 重建 + 广播 screens-updated）、点击穿透状态机（拦截→穿透单帧延迟保护）、托盘（template image / 显示隐藏 / 退出 / 设置占位）、窗口动作 IPC（set-ignore-mouse / set-visible / quit / accessibility×2） |
| A2 | feat/a2-renderer | `1db631e` | `b2a420b` | three.js r171 MMDLoader 经 `pet-asset://` 加载 optimized PMX + 20 贴图、正交相机、透明渲染、材质 morph 自定义（照れ/目影消/目影濃）、呼吸微动 0.15–0.42Hz、FPS 上限 30、`window.__aventurineDebug` 调试面；审查修复批：H-1 几何刷新、M-1 绑定姿势包围盒、M-3 悬停拦截闭环、F03/F04/F05/F07/F08 等（§19.9） |
| A3 | feat/a3-config | `fc54f9c` | `d4d236a` | config-store（版本化 / 原子写 / 坏文件回退 / 注入目录可测）、logger（1MB 轮转、失败不抛）、config IPC + `config-changed`、§8.1 协议安全审计（protocol.ts 零改动）；审查修复批：M-2 单段文件名+handler 级测试、M-11 启动健壮性、F3/F4/F7/F8/F9/F10/F13（§19.9） |
| A4 | feat/a4-winlist | `d51739f` | `403af51` | Swift CGWindowList 助手（`--json`、无需录屏权限、不读标题）、`scripts/build-native.mjs`（幂等 + --check）、TS 解析/超时降级/排自身 pid、`pet:windows` + 500ms 轮询变化时 `windows-updated`；审查修复批：M-6 poller 正式测试+native --check 实跑门禁、F04/F05/F07（§19.9） |
| A5 | feat/a5-bridge | `1eae9b1` | `605b27b` | DSH host-only bundle（locale/icon）、status.json 原子心跳 5s、events.jsonl（64KB 单行上限 / 5MB 轮转）、事件映射、与 `src/shared/bridge-schema.ts` 的 parity test；**原实现有 2 个 HIGH（disposer 被 cordis 丢弃、task/error 永不触发），审查修复批已修**：箭头 apply / 真实事件形状映射 / disposed-running 终止事件 / status tmp 唯一（§19.9） |
| Lead（集成） | main | `6fab7bc` / `d4bf44b` / `1f89936` / `16db00f` | — | §18 开工调研、`app-context` 多屏注册表、`index.ts` 集成接线（管理器/托盘/LOW-13 退出语义）、冒烟 Wave 1 断言（含渲染帧断言）、`tests/tmp/capture.cjs` 采集器（含 appPath 自迁移修复）；审查修复批集成（§19.9） |

### 19.2 自动化验收（全部 exit 0）

> 以下为 **Wave 1 合并时**的验收数字（历史记录；审查修复批后最新数字见 §19.9，测试为 23 files / 419 tests、性能统计为全帧口径）。

- `pnpm typecheck`、`pnpm build` 通过；`pnpm test` = **13 files / 261 tests**（Wave 0 基线 86 → +175：A1 22 / A2 44 / A3 35 / A4 56 / A5 18；A2 单测含 morph 字典下标错位回归。**更正**：原记录写 A2=48/分项和 179，实测 A2=44、分项和 175，总数 261 正确）。
- `pnpm smoke`（dev）：`SMOKE_OK`，Wave 1 新增断言全过 —— overlay 数量 == display 数量、每窗 bounds == 对应 `workArea`、`isFocusable/isFocused === false`、托盘 `getBounds()` 非空、config 往返 + 钳制（opacity 9→1）+ `config-changed` 恰好 1 次 + 恢复、`pet:windows` 结构校验（真实 12 窗口）、accessibility、`set-visible(false/true)` 生效且仍不抢焦点；**渲染断言**：`__aventurineDebug.ready`、model loaded、morph **85**、材质 **39**、贴图 **20 / 缺失 0**、drawCalls 22 / triangles 37537（**口径更正**：这是 OutlineEffect 描边 pass，不是整帧；整帧口径见 §19.9）、`petHeightPx=324`（当时默认 30%）、主屏渲染、capturePage 合成帧不透明像素 **43,403**。
- `pnpm smoke:file`（生产 `loadFile` 路径）：exit 0 + `SMOKE_OK`。
- 长跑：生产 `electron .` **72s 后仍存活**（窗口 visible、not focused、fps 29、drawCalls 22），72s 时截图宠物完整（bbox 240×323、opaque 20,223）。
- `pnpm assets:prepare --check`：exit 0（`textures=20 resized=3 pmxCopy=1`）。

### 19.3 实机验收证据（macOS 27 arm64 / 1920×1080@1x，主屏 display id=6）

| 项 | 证据 |
|---|---|
| overlay 几何 | smoke：bounds 与**当时** workArea 动态相等（首轮 `{0,30,1920,961}`，末轮 `{0,30,1920,963}`；会话中途系统 workArea 高度 961→963，多轮断言均通过——正好验证「显示器/workArea 变化后按 `screens-updated` 重算、不用启动快照」）；多窗计数 == display 数 |
| 置顶层级 | A4 Swift 实测 CGWindowList：本 app overlay `layer=1000`（kCGScreenSaverWindowLevel），前向顺序中位于所有 `layer=0` 应用窗口之前 |
| 不抢焦点 / 无 Dock | smoke `isFocusable=false/isFocused=false`；采集 JSON `window.isFocused=false`；accessory 策略沿用 Wave 0.5 |
| 托盘 | smoke `getActiveTray().getBounds()` = `{1420,0,32,30}`（菜单栏内非空），template image |
| 点击穿透 | `pet:set-ignore-mouse` invoke 不抛 + mouse-gate 单测（单帧延迟/合并/幂等）；**真实点击穿透到下层应用仍为人工项**（§12-1，需要真实鼠标操作）。审查修复批 M-3 已接通悬停拦截：合成 mousemove 命中宠物→主进程 `applied=false`、移出→`true`（冒烟断言） |
| 配置 / 日志 | `~/Library/Application Support/aventurine-pet/config.json`（`version:1` + 11 项）与 `logs/main.log` 实际落盘；smoke 覆盖部分更新/钳制/恢复/广播 |
| PMX / 贴图 | capturePage + debug：morph 85 / 材质 39 / 贴图 20 缺失 0 / 顶点 32966 / 三角 51829；人工看图：砂金·戏浪沙滩装、透明底、右下角脚底贴 workArea 底边；`笑い+照れ` 表情可辨（face-compare.png） |
| 尺寸 | Wave 1 验收时 `petHeightPx=324` = 30% × 1080；bbox 高 322–323。审查修复批 M-1（绑定姿势包围盒）后 50% 默认下实际绘制高度≈540、`petRect.width=398.1`（此前 394.4） |
| 性能 | 闲置 fps 29–29.5（上限 30）、drawCalls 22（描边 pass）；72s 长跑无崩溃/无 SMOKE_FAIL。审查修复批 F03 后全帧口径约 60 draws / 86,792 tris（fps 仍受 fpsCap 限制） |
| A5 真实安装（**口径更正，见审查修复批 M-9**） | 独立 profile `pet-bridge-test`（headless 模板）与 `pet-bridge-test-web`（web 模板）安装确实发生：`dsh plugin --profile … add -w bridge/…` → profile `dsh.profile.bundles` 自动追加；headless 那次 run 实际是 **MISSING_CREDENTIAL 失败任务**，bridge 写出 `task/start` → `session/event(turn/end, seq=16)` → `task/end`（**没有 `task/error`**——这正是原 H-3 缺陷的真实反例，修复后应以失败任务复验出 `task/error`）。`offline` 标记当时**未被真实捕获**（原文写「按 TTL 30s 判 offline」，属 TTL 兜底而非显式 offline 帧；H-2 修复后才具备）。「web 心跳每 5s 递增」无文件证据、「无残留进程」当时因沙箱禁 `ps` 未独立验证（profile 清理已核实）。A5 修复细节见 §19.9；**真实 DSH 重装验收仍待 Q1 重做**。 |

### 19.4 偏差 / 观察（不影响验收）

1. A3 交付文件名为 `src/main/config-store.ts`（PLAN §7 原写 `src/main/config.ts`），避免与 `@shared/config` 混淆，交付物一致。
2. 会话中途系统 `display.workArea` 高度由 **961→963**（Dock / 菜单栏指标变化）。`capturePage` 尺寸、`win.getBounds()`、`getContentBounds()` 均等于**当时**的 workArea（963），**不存在固定 2px 合成差异**（早前「963 vs 961」实为 workArea 已变化的误读，本项观察已更正）。A1 的 overlay 与 smoke 断言都动态跟随 workArea，符合 §17.3-2「禁止启动快照」；B4 命中检测也不得硬编码 961/963，应以 `pet:window-info.bounds` 为准。
3. 模型默认 bind pose 为 A/T-pose：Wave 1 只做加载/材质 morph/呼吸，自然站姿与下垂手臂归 **B3**；`照れ` 腮红是低 alpha 资产叠加，324px 下很淡（机制已验证），B3 可叠加 `脸红` 顶点 morph 增强。
4. ~~使用官方同款 `OutlineEffect`~~ **已被 §19.11 取代**：改为 vendored 屏幕空间自适应描边（CSS 像素、横竖同宽、随宠物高度自适应），皮肤 edgeColor 仍调为深棕近黑。
5. smoke（dev + capturePage 干扰）里 `stats.fps` 瞬时约 16.5，低于闲置 29–30；smoke 对 fps 断言放宽为 >5 以保证稳定性，**真正性能判据以长跑实测为准**。
6. 每 display 都加载 renderer，由 A2 依据 `pet:window-info.displayId` vs `isPrimary` 只渲染主屏宠物（符合 §17.3-2 Wave 1 约定）；跨屏迁移留 B5/C4。
7. 本机为单屏 1920×1080@1x：多屏几何只有纯函数单测覆盖，**物理多屏需后续真机验收**。
8. **渲染高度口径（审查修复批 M-1）**：原实现用 `geometry.computeBoundingBox()`，r171 会把 85 个 morph target 并入包围盒（union 高 21.885）、导致实际绘制高度 = `petHeightPx × 0.9907`（540→约 535px）。现改用绑定姿势包围盒（`model/bounding.ts`），50% 下 `petRect.width` 由 394.4 变为 398.1、实际高度≈540。
9. **性能统计口径（审查修复批 F03）**：`debug.stats().drawCalls/triangles` 现为**全帧累计**（OutlineEffect 主 pass + 描边 pass）：50% 时约 60 draws / 86,792 tris；旧记录里的 22 / 37,537 只是描边 pass，不能当整帧性能指标。
10. **悬停拦截已闭环（审查修复批 M-3）**：renderer 新增 `interaction/pointer-gate.ts`，`mousemove` 命中宠物矩形→`setIgnoreMouse(false)`、移出→`setIgnoreMouse(true)`；冒烟新增端到端断言（合成 mousemove 命中心→主进程实际 `applied=false`，移出→`true`）。真实鼠标点击穿透到下层应用仍为人工项。
11. **A5 桥插件修复（审查修复批 H-2/H-3/M-7/M-8）**：`apply` 改箭头函数（真实 cordis 4.1.0 下 disposer 才会被收集、offline 帧才会写）；错误映射改为真实 DSH 形状（`agent/error` 与 `turn/end.data.reason.kind==='error'` → `task/error`，同 turn 去重）；`agent/disposed` 时 running 补 `task/end`；status 临时文件名按 pid+实例+序号唯一。真实 DSH 重装验收留 Q1（本轮以真实 cordis + 真实 session 形状复现验证）。
12. **悬停命中区临时收缩（手工验收发现，2026-11-07 补）**：M-3 最初的悬停拦截用的是**模型渲染包围盒**（50% 时约 398×540，含 T-pose 手臂与透明边缘），实测会把包围盒右侧透明区域内的桌面图标整片拦截（用户放上去的 `Assignment_1.pdf` 点不开，而宠物躯干外的透明区也「点透明区域没反应」）。现命中区改为**躯干中心带**：宽 = `min(包围盒宽, 高×0.5)`、水平居中、垂直保持全身（`interaction/pointer-gate.ts` 的 `computePointerHitRect`）。悬停躯干/头/腿仍拦截，两侧透明边缘恢复点击穿透；像素级命中（按渲染 alpha）归 B4 实现。

### 19.5 未覆盖 / 后续 Wave 需补的实机项

- 物理多显示器插拔 / Dock 自动隐藏 / 菜单栏自动隐藏 / 分辨率切换（A1 有纯函数单测 + display-* 监听；H-1 修复后有 stale 快照单测 + `screens-updated → pet:window-info 重新 invoke` 冒烟断言，但真实多屏/自动隐藏仍无法在本机实测）。
- 点击穿透到下层应用的真实鼠标操作、全屏应用之上可见性、Space 切换（§12-1/4 人工矩阵）。
- **A5 真实 DSH 重装验收**：H-2/H-3 修复后尚未重跑真实 profile 安装（本轮以真实 cordis 4.1.0 + 真实 session 事件形状复现验证）；Q1 需用独立 profile 复验「失败任务→task/error」「退出→offline:true」「心跳序列」并留原始 transcript。
- `pet:dsh-status` 与桌面端消费桥文件 → **Wave 2 B7**（A5 已在真实 DSH 产生文件，B7 消费即可；B7 需只用 `online`，并在 F2 修复后消费 `task/error`）。
- 打包（C4）：packaged 托盘图标路径、Swift 助手 `extraResources` 映射、`pet-asset://` prod 根。
- 真实拖窗（C1）、设置窗（B6）、行为/物理/交互（B1–B5）；A5 多实例仍为 last-writer-wins（已文档化单写者假设）。

### 19.6 Wave 1 结束时的接口现状（Wave 2 直接照此开工）

- **已注册 handler（10/14）**：`pet:get-config`、`pet:set-config`、`pet:screen-info`、`pet:windows`、`pet:set-ignore-mouse`、`pet:window-info`、`pet:set-visible`、`pet:quit`、`pet:accessibility-status`、`pet:open-accessibility-settings`。
- **未注册（留给后续）**：`pet:move-window`（C1）、`pet:notify`（C3）、`pet:show-settings`（B6）、`pet:dsh-status`（B7）。
- **事件通道**：`windows-updated`（A4 变化时）、`config-changed`（A3 set 时）、`screens-updated`（A1 显示器变化时）、`dsh-event`（待 B7 发送）。
- **可复用调试面**：`window.__aventurineDebug`（`ready` / `model` / `stats()` / `setMorph` / `geometryRefreshCount` / `pointerIntercepting` / `errors`），A2 已保证生产构建存在；`stats().petHeightPx/petRect` 供 B2/B4 命中换算参考；`pointerIntercepting` 与主进程 `getIgnoreMouseAppliedState(win)`（`src/main/ipc/window.ts` 导出）构成 M-3 悬停拦截的冒烟断言面。
- **冒烟新增断言（审查修复批）**：`pet:windows` 至少 1 个窗口（native helper 门禁）、`screens-updated` 后 `geometryRefreshCount` 递增（H-1）、悬停/移出时 renderer 与主进程穿透状态一致（M-3）、`constructOnly` 由 `getOverlayConstructOnlySnapshot()` 单源派生、fps/不透明像素阈值按当前配置推导。
- **集成文件仍由 Lead 持有**：`src/main/index.ts`、`electron.vite.config.ts`、`package.json`、`pnpm-lock.yaml`、`src/shared/**`、`src/preload/**`、`src/shared/assets-manifest.json`。Wave 2 的 B6 设置窗第二入口需 Lead 先改 `electron.vite.config.ts`（PLAN §7 已约定）。

### 19.7 用户反馈后的画质修正（2026-11-07，Wave 1 收尾补丁）

> 背景：用户实机反馈「砂金的脸看不清」，并发现一个 **W0 占位旧实例残留窗口**。两者均已定位并修复，`pnpm test` 261/261、`pnpm smoke` 回归通过。

**A. 残留 W0 窗口（已清理 + 脚本修正）**
- 根因：Lead 的实机探针用 `node_modules/.bin/electron`（npm shim）启动，`kill $PID` 只杀了 shim，**真实 Electron 主进程（PID 不同）仍在运行**，屏幕上残留旧 build 的 W0 占位窗。
- 修复：清理全部残留进程/窗口（已确认 `NO_ELECTRON_WINDOWS`）；`tests/tmp/longrun.sh` 改为直接用真实 Electron 二进制启动并按主进程 PID 清理；临时 userData profile（`aventurine-pet-lead-*`、`-wt-a2-renderer`）全部删除，默认 profile 配置已恢复 `sizePercent=30`。

**B. 脸部清晰度：不是加载失败，是「屏幕尺寸 + 采样 + 描边 + 资产设计」叠加**
1. **尺寸（主因）**：默认 30% 屏高 @1080p = **324px**；头高约 60px、脸约 **30px**，用户显示器 scaleFactor=1（非 Retina）。这是 D6 默认值下的物理上限（参考 Desktop Mate/MateEngine 也是 1/4–1/3 屏高）。
2. **采样**：原渲染 `pixelRatio = min(DPR,2) = 1`（1x 屏无超采样）→ 边缘发虚。已改为**像素预算超采样**（审查修复批 F08：1x 1080p 仍 2x；1440p 1x ≈1.5x；4K/更大 1x 按预算降到 1x；Retina 按原生 dpr），并给颜色贴图/环境贴图（`map`/`matcap`）开**各向异性过滤**（min(8,maxAniso)；`gradientMap` 是 NearestFilter 无 mipmap，不需要各向异性）。实测 fps 仍 27.9–29.5（上限 30），细节明显更锐。
3. **描边**：PMX 里 `颜/颜赤/肌/肌2/印` 的 edgeColor 是**纯红 (0.5,0,0,0.7)**，小尺寸在脸/脖子/手臂形成红圈，观感像“脸脏/糊”。已把这些材质描边改为**深棕近黑 + alpha≤0.45**，并关闭 `颜赤`（腮红叠加层）描边；其余黑描边保持作者原样。
4. **资产设计**：模型自带刘海遮眼 + 脸部贴图本身是风格化低细节（`颜.png` 1024² 里脸区大面积纯肤色、简笔眉线/嘴线，眼睛是独立 UV 区），并非贴图缺失/加载失败（20/20 贴图、morph 85、材质 39 均已断言）。同等条件下换大尺寸/Retina 屏会更清晰。

**C. 尺寸对比证据**（native 1:1，左=30% 右=50%；`tests/tmp/wave1-evidence/face-clarity/`）
- 同一机位：30% 时脸约 30px；50%（540px 宠物、脸约 50px）时眼/眉/嘴清晰可辨、红圈消失。
- **建议**：B6 设置面板（Wave 2）落地前，想临时更清楚可把 `~/Library/Application Support/aventurine-pet/config.json` 的 `config.sizePercent` 改为 `50` 后重启；B6 会提供 **10–100%** 滑杆（§19.11 已把上限放宽到 100）与“近景模式”。用户已确认默认改为 **50%**（见 §19.8）——B6 设置面板（Wave 2）会提供 10–100% 滑杆，30% 可作标准大小，100% 受 workArea 封顶。

**D. 修改文件**：`src/renderer/src/scene/pet-scene.ts`（pixelRatio 超采样 / `applyTextureQuality` / `tuneOutlineParameters`）。冒烟新增渲染断言不受影响（fps 断言 >5 仍过；`capturedOpaquePixels` 43,740）。

### 19.8 默认尺寸调整为 50%（用户决定，2026-11-07）

- **决策**：用户实机对比 30% / 50% 后确认「50 挺好看」，默认 `sizePercent` 由 **30 → 50**（当时可在 10–50 调整；**2026-11-07 后续把上限放宽到 100，见 §19.11**；30% 作为标准大小可切换）。
- **改动**：`src/shared/config.ts` 的 `DEFAULT_CONFIG.sizePercent=50`（冻结契约默认值变更，已同步注释）；`src/shared/types.ts` 注释；`tests/shared-contract.test.ts` / `tests/config-store.test.ts` 默认值期望；`src/main/index.ts` 冒烟尺寸断言改为**按当前配置动态计算**（不再硬编码 324px）；本机 `~/Library/Application Support/aventurine-pet/config.json` 已同步 `sizePercent=50`（持久化值优先于默认值，避免改默认后本机仍是 30）。
- **影响**：1080p 下宠物高 **540px**（脸部约 50px，肉眼可辨眼/眉/嘴）；50% 下 A2 右下角摆放与脚底贴底边不变（`petHeightPx` 随配置）；B6 设置面板将提供 10–100% 滑杆（§19.11）。
- **回归**：`pnpm typecheck` + `pnpm test` 261/261 + `pnpm build` + `pnpm smoke`（50% 下动态断言 `petHeightPx=540`，`petRect {x:1506.6,y:423,w:394.4,h:540}`，贴图 20/缺失 0）+ `pnpm smoke:file` + 实机 capture 人工确认。

---

### 19.9 Wave 0–1 审查修复批次（2026-11-07，独立审查后全量修复）

> 背景：Wave 1 合入后做了一次全量独立审查（Lead 运行时复跑 + 6 名 fresh-context 审查员分模块深读 + 关键 HIGH 亲自复现），发现 **0 BLOCKER / 3 HIGH / 11 MED / 30+ LOW/NIT**。本批次已按「HIGH → MED → LOW/NIT」全部处理完毕，改动在分支 `fix/wave1-review`（hash 以 `git log` 为准）。审查证据与分报告在 `tests/tmp/review-w1/`（gitignored，含 REPORT.md 总报告与 6 份分报告）。

#### A. 修复清单

**HIGH（3）**
1. **H-1（A2）几何刷新用启动快照**：`screens-updated` / window resize 后不再用缓存的 `pet:window-info.bounds`；`main.ts` 新增 `requestGeometryRefresh()`（in-flight + queued 合并），事件与 resize 都重新 invoke `pet:window-info` + `pet:screen-info` 并只用最新几何；新增 stale 单测与 `geometryRefreshCount` 冒烟断言（广播 `screens-updated` 后计数 1→2）。
2. **H-2（A5）cordis disposer 被丢弃**：`apply` 改为箭头函数（不可构造）；真实 cordis 4.1.0 复现验证 dispose 后 `offline:true`、心跳停止；新增 `apply.prototype === undefined` 回归断言。
3. **H-3（A5）task/error 永不触发**：按真实 DSH 形状重写映射——订阅 `agent/error`、读取 `turn/end.data.reason.kind==='error'`，同一 agent/session + turn 去重（上限 64）；真实失败 session 17 事件复放输出 `task/start → task/error → task/end`；删除旧 `/error|failed|cancel|denied/i` 模糊匹配。

**MED（11）**
4. **M-1（A2）实际渲染高度偏小 0.93%**：新增 `model/bounding.ts` 用绑定姿势包围盒（忽略 r171 会并入的 85 个 morph target）；50% 下 `petRect.width` 394.4→398.1、实际高度≈540；新增 `tests/bounding.test.ts`。同时 `FALLBACK_MODEL_ASPECT` 修正为真实 0.7373。
5. **M-2（A3）pet-asset 单段/审计**：`parseSafeRelativePath` 恢复单段契约（解码后含 `/` → 403）；新增 `tests/protocol-handler.test.ts`（32 例：合法/403/404/405/headers/MIME/符号链接/packaged 根/超长名）与 `docs/pet-asset-protocol.md`（§8.1 逐条审计清单+测试映射）。
6. **M-3（A1）悬停拦截端到端**：新增 `interaction/pointer-gate.ts` + `main.ts` mousemove/mouseleave 接线（仅状态变化发 IPC，主进程仍有 16ms mouseup 保护）；冒烟新增端到端断言（命中→renderer `pointerIntercepting=true` 且主进程 `applied=false`；移出→相反）。
7. **M-4（Wave 0.5）dev:worktree profile 未规范化**：新增 `scripts/profile-lib.sh`（唯一 `normalize_profile_name`，与 app 正则一致）与 `scripts/print-profile.sh`；`worktree-setup.sh` 改为复用同一实现；`package.json` 的 `dev:worktree` 改为 `PET_PROFILE=$(bash scripts/print-profile.sh "$PWD")`。
8. **M-5（A1）overlay/tray/ipc 无正式测试**：新增 `tests/helpers/electron-stub.ts` + `overlay-manager.test.ts`(16)/`tray.test.ts`(9)/`window-ipc.test.ts`(12)；`overlay-manager` 的 display 变化与 `sync()` 加 try/catch + 单屏建窗失败隔离；`setVisible` destroy 顺序修复；mouse-gate 在 closed 时 dispose、hide 前 flush；`ipc/window.ts` 导出 `getIgnoreMouseAppliedState(win)` 供冒烟断言。
9. **M-6（A4）poller 无测试 / native 无门禁**：新增 `desktop-ipc.test.ts`(9)；`build-native --check` 改为「存在+可执行+实际运行 `--json`+JSON 数组校验+5s 超时」，幂等改为 build signature stamp；`ipc/desktop.ts` 加 poll catch；`winlist.ts` stdout 改 `setEncoding('utf8')`+4MB 上限；Swift `Int` 钳制 Int32；`build-native` 接入 `smoke`/`smoke:file`（先构建助手），smoke 断言 `pet:windows.length>0`。
10. **M-7（A5）disposed-running 无终止事件**：`agent/disposed` 时若上一状态 running，先写 `task/end {reason:'disposed'}`。
11. **M-8（A5）多实例/临时文件**：status tmp 名改为 `.status.json.<pid>.<instance>.<seq>.tmp`（并发不互踩）+ 失败清理；README/PLAN 明确单写者假设。
12. **M-9（A5）真实验收叙事失真**：PLAN §19.3 已按事实更正（失败任务/offline 仅 TTL/心跳无证据/无残留进程未独立验证）；真实 DSH 重装验收列入 Q1（本轮用真实 cordis + 真实 session 形状复现验证修复）。
13. **M-10（smoke）脆弱断言/自报字段**：`screensUpdated` 改 `>=1`；fps 上限按当前 `fpsCap+10`；不透明像素阈值按 `petHeightPx×3` 推导；`constructOnly` 改为 `getOverlayConstructOnlySnapshot()` 单源派生。
14. **M-11（A3）配置启动健壮性**：`ipc/config.ts` 的 `mkdirSync` 包 try/catch，store 构造失败降级内存配置；新增 `ipc-config.test.ts`(3)。

**LOW/NIT（主要项）**
15. A2：`drawCalls/triangles` 改全帧累计（主 pass+描边 pass）；PMX/贴图加载失败指数退避重试（PMX 1/2/4s×3、贴图 250/500/1000ms×3）；config 与几何 `Promise.all` 后首次布局（消除默认尺寸闪变）；贴图 tracker pending 配平；非主屏不建 WebGL/不跑 rAF（惰性建 scene）；像素预算 pixelRatio（1080p 2x/1440p≈1.5x/4K 1x）；delta clamp；`setViewport` 单次 setSize；注释修正。
16. A3：TOCTOU 收窄（父目录 realpath + `open(O_NOFOLLOW)` + fstat + fd 读取，残余同用户竞态注释记录）；logger `Error` meta 输出 `{name,message,stack}`；String 兜底换行转义；`ENAMETOOLONG/ELOOP` → 403；userinfo URL 拒绝；config-store 启动清理其它 pid 的 `.config.json.*.tmp`；protocol 可选注入 logger（index.ts 已接线 userData/logs）。
17. A4：`WinlistHelper` 跨 chunk UTF-8 修复 + 输出上限；README 补 B5 消费注意（订阅后先 invoke `pet:windows`、`onScreen` 恒 true、`--json` 单行）；`onScreen`/`0B` 注释修正。
18. A5：payload 增补安全标量（turn/step/reasonKind，不含正文）；README 事件表与安装路径修正；轮转两段语义写明；文件/目录权限 0700/0600；事件类型运行时白名单；`~/` 展开；`payload.status` 优先。
19. 基建：`vitest.config.mts`（消除 ESM-in-CJS 警告、alias 用 `import.meta.url`）；`tests/scripts.test.ts`(15 例：prepare-assets/print-profile/worktree 退出码与规范化)；`assets-manifest` 唯一名断言改「去重后唯一」；`docs/pet-asset-protocol.md` 新增。
20. 文档：§17.2 的 tsc 结构化检查声明更正为运行时断言；§17.4 tag 修正；§19.2 测试数字与性能口径更正；§19.3 A5 证据口径更正；§19.7 各向异性措辞修正；§19.1 补 Lead 集成 hash（`1f89936`/`16db00f`）；§7 文件所有权补新增文件。

#### B. 修复后自动化验收（本机实跑，全部通过）

| 命令 | 结果 |
|---|---|
| `pnpm typecheck` | exit 0 |
| `pnpm test` | **23 files / 419 tests passed**（Wave 1 基线 261 → +158） |
| `pnpm build` | exit 0 |
| `pnpm smoke`（dev，沙箱等价命令） | `SMOKE_OK` exit 0；新增断言全过：`geometryRefresh 1→2`、`pointerGate inside/outside + main applied false/true`、`pet:windows=12`、`constructOnly` 单源、全帧 `drawCalls=60 / triangles=86,792`、`petHeightPx=540`、`petRect.width=398.1`、`capturedOpaquePixels≈44.5k` |
| `pnpm smoke:file`（生产 loadFile） | `SMOKE_OK` exit 0（同上断言） |
| `node scripts/build-native.mjs` / `--check` | 均 exit 0（`--check` 实跑 `winlist --json` 校验 12 条窗口，112,584B） |
| 生产 `electron .` 长跑 75s | `ALIVE_75S` → 干净退出，无 `SMOKE_FAIL`、无残留进程 |
| `pnpm assets:prepare --check` | exit 0（`textures=20 resized=3 pmxCopy=1`） |
| 资源/图标/worktree 幂等回归 | 与 §17.5 一致（manifest sha 不变、图标 changed=false、worktree 探针清理复原） |

#### C. 残余限制（不阻塞 Wave 2）

- 物理多屏 / 菜单栏自动隐藏 / Dock 自动隐藏 / 分辨率切换仍缺真机验收（H-1 修复已有单测 + 冒烟机制断言，但真实 AppKit 行为需人工矩阵）。
- A5 修复以「真实 cordis 4.1.0 + 真实 DSH session 事件形状」复现验证，**真实 DSH 重装/失败任务/退出 offline 的端到端验收留 Q1**（独立 profile，不得污染 desktop）。
- 真实鼠标点击穿透、全屏上方可见性、Space 切换：人工项。
- 打包 C4（`extraResources`、prod 协议根、托盘/助手路径、生产 CSP 收紧）未验证。
- A5 多实例仍为 last-writer-wins（单写者假设已写入 README/PLAN）。

#### D. tag / 证据修正

- `wave0.5-fixed` 已从误指的修复前提交 `1343b99` 移到修复后 `fff09aa`；原提交保留 tag `wave0.5-pre-fix`。
- 审查报告与修复报告在 `tests/tmp/review-w1/`（不随仓库提交）：`REPORT.md`、`a1.md`…`a5.md`、`wave0-infra.md`、`fix-renderer.md`、`fix-bridge.md`、`fix-main-assets.md`、`fix-windows-native.md`、`fix-infra.md`。

### 19.10 手工验收结果（2026-11-07，Lead 驱动 + 用户配合）

> 环境：macOS 27.0.1 / arm64 / 1920×1080@1x / 通过 Screen Sharing 远程控制（**无实体屏幕**）。
> 方式：生产构建 `electron .` + 远程调试端口（Lead 用 CDP 驱动配置与读取调试面）+ 系统设置辅助功能自动化。
> 记录：`tests/tmp/review-w1/MANUAL-TEST-RESULTS.md`、`round-d.log`、`c3-test.log`。

| 项 | 结果 | 证据 / 说明 |
|---|---|---|
| A1 渲染/透明/位置 | ✅ | 宠物 50%@右下角、脚底贴底、透明无黑框；模型自带 T-pose 属 Wave 1 预期 |
| A2 悬停拦截 | ✅ | 程序化复验：合成 mousemove 命中躯干 → `pointerIntercepting=true`，移出 → `false`；真实鼠标人工 A3 同判 |
| A3 点击穿透 | ✅ | 修复命中区后（§19.4-12）：点宠物旁透明区/桌面图标可穿透；点躯干被拦截、下层不响应；快速移出再点正常 |
| A4 不抢焦点/无 Dock | ✅ | smoke `isFocusable/isFocused=false`；System Events `background only=true`（accessory，不进 Cmd+Tab/Dock） |
| A5 透明叠加 | ✅ | 截图无黑边/异常矩形；宠物身上黑边为 PMX 自带 edgeColor + OutlineEffect（§19.7 已调色，非渲染错误） |
| B1–B4 托盘 | ✅ | 菜单栏「猫头」占位图标即托盘；菜单（显示桌宠/设置…灰/退出）、显示隐藏切换、深浅色反色均正常；用户测试期间经托盘退出成功 |
| C1 Dock 位置/ C2 自动隐藏 Dock | ✅ | 用户实测：宠物始终贴工作区右下角 |
| C3 自动隐藏菜单栏（H-1） | ✅ | **自动化实测**：`始终` 后 workArea y 30→0、h 963→993，窗口 bounds 跟随，`petRect.y 423→453`，脚底始终=窗口高度，`geometryRefreshCount` +2、无错误；测完恢复原设置「仅在全屏幕视图下」 |
| C4 分辨率切换 | N/A | CoreGraphics 报告该显示只有 1 个模式（1920×1080@60），远程/无实体屏无法切换 |
| C5 全屏应用之上 | ✅ | 用户实测：全屏仍可见、退出全屏正常 |
| C6 Space 切换 / C7 睡眠 | N/A | Screen Sharing 远程会话下不可用 |
| D1 尺寸热更 50→30→10→45→50 | ✅ | `petHeightPx=540/324/108/486/540`；每档脚底对齐 workArea 底边、x 锚点正确、无错误 |
| D2 透明度 1→0.5→0.3→1 | ✅ | canvas `style.opacity` 热更生效后恢复 |
| D3 clickThrough=false→true | ✅ | false 时恒定拦截（`pointerIntercepting=true`），恢复后按命中状态穿透 |
| E1 退出清理 | ✅ | `pet:quit`（与托盘退出同路径）后进程数 0、无残留、日志无异常 |
| E2 配置持久化 | ✅ | 设 30% → 退出 → 重启后 `petHeightPx=324`（落盘生效）→ 回改 50 后磁盘 config=50 |
| F1 性能/长跑 | ✅ | 旧实例连续运行约 22 分钟无崩溃；新实例空闲 RSS≈177MB、CPU 采样 0.3–0.5%（fps 上限 30） |

**结论**：除明确标注 N/A 的「多屏 / 分辨率 / Space / 睡眠」（远程无实体屏环境限制）外，Wave 0–1 手工验收全部通过；其中 C3 以自动化方式实测了 H-1 修复的真实场景（workArea 原点 30→0 后宠物脚底仍贴底）。

### 19.11 尺寸上限 10%–100% + 屏幕空间自适应描边（方案 B，2026-11-07）

> 用户决定：①描边改用**方案 B（屏幕空间恒定像素 + 随模型大小自适应）**；②可选尺寸从 10%–50% 放宽到 **10%–100%**；改完跑实机回归。

**A. 尺寸 10%–100%（100% 受 overlay 窗口高度封顶）**
- 契约：`CONFIG_LIMITS.sizePercent.max 50 → 100`（`src/shared/config.ts`），类型注释同步（`src/shared/types.ts`）。
- 布局（`src/renderer/src/model/layout.ts`）：`computePetHeightPx(sizePercent, boundsHeight, maxHeightPx?)` 新增可选封顶参数；`computePetLayout` 传入 `display.workArea.height` → `petHeightPx = min(clamp(%,10,100)/100 × bounds.height, workArea.height)`。**原因**：1080p 下 100% 的 bounds 高度 1080 > workArea 高度 961/963，不封顶会把头顶裁出窗口；封顶后 100% = 贴满工作区高度（头顶贴窗口顶、脚底贴底），且 30%/50%/80% 等未触顶档位仍严格按 bounds 计算。
- 单测：`tests/renderer-layout.test.ts` 增加 100% 封顶、workArea 1055 变体、60/80% 中间档位；越界钳制改为 `5→10 / 150→100 / 80 保持 80`。`tests/shared-contract.test.ts` 限制常量与钳制用例同步（`999→100`）；`tests/config-store.test.ts` 越界落盘用例同步（`51` 不再钳制、`101→100`）。
- 冒烟（`src/main/index.ts`）：期望高度改为 `min(sizePercent% × bounds.height, workArea.height)`，不再硬编码 324/540。

**B. 描边方案 B：屏幕空间自适应（vendored 屏幕空间 OutlineEffect）**
- 调研依据（详见 §18 调研；本轮检索结论）：MToon 的 `outlineWidthMode` 有 **worldCoordinates / screenCoordinates** 两种官方语义（screen 模式公式 `outlineOffset *= vViewPosition.z / projectionMatrix[1].y`，见 [three-vrm mtoon.vert](https://raw.githubusercontent.com/pixiv/three-vrm/dev/packages/three-vrm-materials-mtoon/src/shaders/mtoon.vert)）；drei `<Outlines>` 用 `screenspace` 开关 + `normalize(clipNormal.xy) * thickness / size * clipPosition.w * 2.0` 实现恒定像素（[Outlines.tsx](https://raw.githubusercontent.com/pmndrs/drei/master/src/core/Outlines.tsx)）；Poiyomi 用 `_OutlineFixedSize` 做固定屏幕尺寸（[文档](https://raw.githubusercontent.com/Yuki001/game-dev-skills/main/skills/animation-shader/references/PoiyomiShaders/Details/05_Outline.md)）；three.js 论坛确认 OutlineEffect 的厚度按材质 `userData.outlineParameters` 配置（[帖](https://discourse.threejs.org/t/how-do-i-use-outlineeffect-with-mmdloader/8976)）。
- 现状问题（r171 `OutlineEffect`）：`norm = normalize(pos - pos2)` 在 **NDC 空间**归一化、厚度是 NDC 单位 → 16:9 视口下横边 ≈ 竖边 2 倍粗（实测旧值：竖边 1.65px / 横边 3.30px），且不随模型缩放/尺寸变化（50% 与 30% 像素宽相同，放大后视觉更显粗）。
- 实现：
  - 新增 `src/renderer/src/scene/outline-effect-screen.ts`：**vendored** 自 r171 `OutlineEffect.js`（`@ts-nocheck` 逐字节保留上游 JS 结构，仅做最小改动），把 `outlineThickness` 语义改为 **CSS 像素**，`calculateOutline` 改为**像素空间归一化**（`dirPx = normalize((ndc - ndc2) * outlineViewport * 0.5)`，再换算回 clip 偏移）→ 任意宽高比/分辨率/模型缩放下横竖同宽；新增 `outlineViewport` uniform 与 `setViewportSize(width,height)`（不重复 `renderer.setSize`，保持 F12 单次 setSize）。上游材质的 `onBeforeRender → updateUniforms()` 每帧从 `userData.outlineParameters` 读 thickness，因此运行中改厚度即时生效、无需清缓存。
  - 新增 `src/renderer/src/scene/outline-thickness.ts`（纯函数）：`basePx = clamp(petHeightPx × 0.0022, 0.6, 1.6)`；单材质 `px = clamp(basePx × (edgeSize/1.03), 0.45, 1.6)`，保留 PMX 作者各材质相对粗细。→ 30%（324px）≈0.71px、50%（540px）≈1.19px、100%（961px）=1.6px。
  - `src/renderer/src/scene/pet-scene.ts`：改用 vendored effect；`tuneOutlineParameters` 反解 MMDLoader 的 `edgeSize = thickness × 300` 并保存各材质比例；新增 `updateOutlineThickness()` 在 `placePet()`（尺寸/显示器变化后）与视图变化时写入 CSS 像素；`getRenderStats().outlinePx` 暴露到调试面。
  - `src/renderer/src/debug.ts` / `src/renderer/src/main.ts` / `src/main/index.ts`：调试面 stats 增加 `outlinePx`，冒烟断言 `0.45 ≤ outlinePx ≤ 1.6`。
  - 单元测试：`tests/outline-thickness.test.ts`（8 例：三档基础宽度、钳制/单调性/非法输入、各材质比例、下限/上限）。
- **实机回归（全部通过）**：
  - `pnpm typecheck` / `pnpm build` ✅；`pnpm test` **24 files / 433 tests**（新增 8 描边 + 尺寸新用例；原有用例同步新契约）。
  - `pnpm smoke`（dev）✅：config 50%、`petHeightPx=540`、`outlinePx=1.19`、fps 28.9、drawCalls 60（两 pass 累计）、贴图 20 缺失 0、opaque 52,158。
  - `pnpm smoke:file`（生产 loadFile）✅：`petHeightPx=540`、`outlinePx=1.19`、opaque 52,150。
  - 实机 30% / 50% / 100% 采集（生产路径 + `capture.cjs`）：bbox 240×325 / 400×541 / **712×963**；`petHeightPx=324/540/963`（100% 被 workArea 963 封顶）；`outlinePx=0.71/1.19/1.6`；三档 fps 28.5–29.5。实机截图人工确认：30%/50%/100% 描边均细且一致，100% 头顶贴窗口顶、脚底贴底不出窗。
  - 旧/新 50% 同机位对比（旧截图 `tests/tmp/captures-size50`）：头顶上缘描边竖宽 median/p90 = **1/4px → 1/1px**（mean 1.43→1.0），横边由 NDC 各向异性改为与竖边同宽。
  - 72s 长跑（生产 `electron .`）存活无异常；`pnpm assets:prepare --check` ✅（textures=20/pmxCopy=1）；`node scripts/build-native.mjs --check` ✅。
  - 清理：临时 userData profile、Electron 残留进程均为 0。
- **回归判断**：本轮**无功能回归**（无需回滚/拆步重做）。实现期两处必要调整：①`config-store` 测试里 `51` 的旧期望因契约上限变更同步改为 `51 保持/101→100`（属预期契约变更）；②vendored 文件用 `@ts-nocheck` 是为保持上游 JS 结构的最小改动（对外类型面在 `pet-scene.ts` 用局部 interface 收口），已记录为后续可平滑升级的技术债。
- **已知限制**：①100% 高度受 workArea 限制（1080p 实际 ≈89%），若未来要真正满 bounds 需在 A1 侧扩展窗口覆盖菜单栏（§17.3-2 已决策不做）；②描边目标像素系数 0.0022 为初值，B6 设置面板可考虑暴露 `outlineScale`；③`@ts-nocheck` vendored 文件在升级 three 时需人工 diff。

## 20. Wave 2 实施记录（2026-11-08，B1–B7 已实现并接线；动作观感未过用户验收，待专项重做）

> 状态：**B1–B7 全部落地并经 Lead 集成、自动化验收通过**；B3 姿态库经过 4 轮自然度迭代（v1→v4b），
> **用户实机观感仍未通过**，已按用户指示停止继续盲调，转为「先补动作参考/可视化调参工具再重做」（见 §20.7）。
> 本轮沿用**共享工作树 + 模块 scope 隔离**（未开 git worktree）：6 个 teammate 并行写互不重叠目录，
> Lead 负责契约/集成文件/冒烟/实机截图回环与最终验收。

### 20.1 交付与任务完成情况

| 任务 | 负责人（teammate） | 交付 | 自动化 |
|---|---|---|---|
| B1 状态机 + 随机调度 | behavior-b1 | `src/renderer/src/behavior/**`：15 活动（6 待机变体 + 走/回角落/两段式爬窗/坐窗沿/睡/跳下/跟随窗口）、加权随机+冷却、优先级 drag>pat/poke>fall>DSH>自主>idle、台词池（官方台词）、桌窗事件跟随/掉落；61 tests | ✅ 全绿 |
| B2 运动与物理 | motion-b2 | `src/renderer/src/physics/**`：重力/惯性/地面摩擦/边界/窗口上沿与 Dock 落地/拖拽平滑/甩出速度估计/sit 受控接近/climb 吸附；45 tests | ✅ |
| B3 动画/姿态/表情 | anim-b3 | `src/renderer/src/animation/**`：方案 B 分层姿态混合、12 基础姿态、6 待机变体、6 反应、两骨 IK+髋高补偿+脚掌贴平、look-at 分层 lag、眨眼/情绪/口型/材质 morph 调度、发辫+袖子 verlet 弹簧、微动层、错峰过渡；123 tests | ✅ |
| B4 交互 | interact-b4 | `src/renderer/src/interaction/**`：区域命中（头/身/腿）、拖拽阈值+甩出速度、摸头圆形轨迹、戳、注视平滑、右键 DOM 菜单、pointer-gate `forceIntercept`；112 tests | ✅ |
| B5 桌面感知 | desktop-b5 | `src/renderer/src/desktop/**`：全局→本地换算、窗口过滤/排序、window-top/window-side/menubar/Dock/screen-bottom 表面、moved/closed/appeared 去重、吸附与跟随查询；110 tests | ✅ |
| B6 设置面板 | settings-dsh | `src/renderer/settings.html` + `src/renderer/src/settings/**`：尺寸/透明度/自主频率/捣乱/DSH/FPS/开机自启/音效/权限/DSH 状态、即时保存、恢复默认；19 tests | ✅ 截图验收 |
| B7 DSH 反应 | settings-dsh | `src/main/desktop/dsh-watch.ts`（status 750ms 轮询 + events.jsonl 偏移尾随/轮转/64KB 行上限）、`src/main/ipc/dsh.ts`（`pet:dsh-status` + 仅 online 转发 `dsh-event`）、`src/renderer/src/reactions/dsh.ts`（task/start|end|error → dshBusy/done/error，官方台词）；59 tests | ✅ |
| Lead 集成 | lead | `core/wave2-contract.ts`（冻结模块契约）、`core/pet-runtime.ts`（B1+B2+B5+B7 编排）、`main.ts`（每帧数据流/交互/拖拽/菜单/气泡/调试面）、`pet-scene.ts`（B3 PoseDriver 注入 + facing 转身）、`main/index.ts`（设置窗第二入口/托盘设置入口/launchAtLogin/冒烟 Wave 2 探针/dev 截图回环/DSH-状态断言）；契约/设置窗/回归 | ✅ |

**调研交付**（Wave 2 开工前由 2 个 subagent 完成，Lead 复核）：
- `docs/aventurine-character-brief.md`：砂金人设（三层性格/笑分五层/官方短句语料）、待机动作证据等级、12 姿态骨架级设计、6 待机变体权重、无道具取舍；
- `docs/anim-tech-survey.md`：three r171 MMD 程序化姿态技术调研（源码级证据）——**模型是 A-pose 非 T-pose**、腿蒙皮权重全在 D 链（`足/ひざ/足首` 权重 0，写标准腿骨不动）、眼球权重全在 `目先`（`目/両目` 权重 0）、`helper.update` 无 VMD 时为 no-op、方案 B 分层混合优于 AnimationMixer、解析二骨 IK+髋高补偿贴地、6 发辫+10 袖弹簧（不引 ammo.js/MMDPhysics）；
- `tests/tmp/bones.json`：382 骨完整清单（索引/父级/层级/IK/grant/rest 位置，gitignored 可重建）。
- `docs/wave2-integration.md`：Wave 2 模块分工、坐标系、每帧数据流、各模块 API/接线约定、测试约定。

### 20.2 关键集成决策

1. **冻结模块间类型契约**：`src/renderer/src/core/wave2-contract.ts`（Lead-owned、纯类型、可被单测直接 import），定义 `MotionSnapshot/MotionCommand`（B2）、`DesktopSurface/DesktopSnapshot`（B5）、`InteractionSnapshot/InteractionEvent`（B4）、`ExternalReaction`（B7）、`BehaviorInput/BehaviorDecision`（B1）、`AnimationInput/AnimationDebugSnapshot`（B3）、`PoseDriver`（B3 由 PetScene 注入）。各模块内部实现自由，Lead 在 `main.ts` 适配。
2. **PetRuntime 编排层**（`core/pet-runtime.ts`）：B1 决策 → B2 物理 step → 摆放矩形/动画输入装配；DSH 反应仅在 `dshLink` 开启且未过期时注入 B1 `external`；拖拽事件（B4）即时转 B2（`beginDrag/dragTo/endDrag`），甩出/落地沿检测生成 B3 事件。
3. **B3 驱动注入**：`PetScene` 构造可选 `createPoseDriver(ctx)`，PMX 加载后创建 `createPetAnimator({mesh,root})`；`step()` 内调用 `driver.update(AnimationInput)` 后 `materialMorphs.update()` 再渲染；**B3 与 MMDAnimationHelper 互斥**（动画启用时不再调 helper/IdleMotion）；驱动创建/运行失败自动降级 Wave 1 微动。
4. **朝向转身（修“螃蟹横移”）**：B2 `motion.facing` → PetRuntime 输出 `facing`（walk/climb/fall/drag 用运动方向，其余 front）→ `PetScene.setFacing()` 把 `modelRoot` 绕 Y 平滑转 ±90°；B3 look-at 按同 facing 做 ±90° 局部化。模型始终站在脚底锚点、转身不改变脚底位置。
5. **设置窗第二入口**（Lead 前置）：`electron.vite.config.ts` renderer 多页入口（index + settings）；`src/main/windows/settings-window.ts`（普通可聚焦窗、sandbox+preload 白名单、单例）；`pet:show-settings` registrar；托盘“设置…”启用；`launchAtLogin` 主进程落地（dev 跳过，打包版 `setLoginItemSettings`）；设置页独立 CSP。
6. **DSH 接线**：`registerIpcHandlers` 聚合新增 `registerSettingsIpc` + `registerDshIpc`（占位→B7 实现，签名不变）；`pet:dsh-status` 由 B7 registrar 注册；renderer 订阅 `dsh-event` 推给 tracker，每帧 `reactionAt()` 注入行为层。
7. **冒烟 Wave 2 探针**（`src/main/index.ts`）：设置窗真实 invoke+加载断言、`pet:dsh-status` 形状、B3 动画快照（pose/missingBones/morphs/spring）、B1 behavior、B2 motion feet、B5 desktop surfaces、B3 眨眼 8s 内出现、`debugSetPose('sit'→'stand')`、站姿 `footErrorPx<2.5`、`debugSetGaze(25°,0)` 跟踪（按 facing 换算期望值）。
8. **dev 姿态截图回环**（`PET_DEV_CAPTURE_*`）：生产/开发均可启动后按 `debugSetPose`/`debugTeleport`/`debugTriggerActivity`/`debugSetGaze` 批量截图 + 抓 debug JSON，自动退出；支持 `PET_DEV_CAPTURE_CENTER`（瞬移居中）/`IDLE`（临时关自主，退出自动恢复）/`SETTINGS`（设置窗截图）/`FRAMES+INTERVAL`（行为连拍）。用于 anim 视觉迭代与 Lead 验收。

### 20.3 用户反馈与修正记录（按时间）

1. **「动作太僵硬，僵尸都比这活人；内置很多关节怎么这么僵」**：初版姿态是 A/T-pose 直出（B3 尚未接线时）；B3 接线后做了 4 轮自然度迭代：
   - v2：连续微动层（呼吸/重心/头颈 lag/手臂 follow/手指）、过渡错峰 0–80ms、walk/climb 重做、弹簧 v2（发辫+袖子）；
   - v3：contrapposto（重心/肩高/骨盆 roll/双脚前后差）、3/4 侧身 `センター Y+8°`、手指半握（修正轴向）、idle 变体轴向修正、换承重脚慢层；
   - v4/v4b：根据「关节角度调反」反馈改用 FK 反解校准，曾做「双手叉腰」，后按用户「手像鸡爪」反馈改为**自然垂臂 + 轻微放松手指（5–13°）**，只有抛接/整理等手势才加大弯曲；walk 改为按速度推导步幅+低抬脚+脚掌滚动。
   - **诚实结论**：自动化指标（命中/贴地/眨眼/姿态切换/性能）全部通过，但**用户实机观感仍未通过**；用户已指示停止盲调，根因判断为「缺少足够动作参考素材与可视化调参工具」（见 §20.7）。
2. **「横着往上走很诡异」**：B1 climb 重做为两段式（先水平走到窗口侧边下方 → x 固定、竖直向上爬，速度 28–48px/s），menubar 不参与落座；B3 climb 姿态改为竖直贴墙、四肢交替。
3. **「像螃蟹一样横着走」**：见 §20.2-4 朝向转身；侧身行走 + 步态投影可读。
4. **「不要自创台词，直接用游戏里有的角色台词」**：B1 `BUBBLE_LINES` 与 B7 `DSH_REACTION_BUBBLES` 全部替换为**游戏内官方中文语音原文**；进一步按用户 2026-11-08 的第二版指示扩展为**两个角色版本（砂金 + 砂金·戏浪）的全量官方语音池**，并把场景映射固化为：
   - **任务成功 / 完成庆祝** = 开启战利品（含「开启贵重战利品」）/ 终结技（激活·施放）/ 角色晋阶 / 角色满级 / 行迹激活（随机一条）；
   - **失败 / 出错** = 无法战斗（「满盘皆输啊…」/「扫兴呐。」）；
   - **闲置** = 关于自己（含戏浪「关于自己•戏浪/欢愉」）/ 闲谈•* / 爱好 / 烦恼 / 分享 / 见闻 / 关于角色系列 / 回合待机（随机一条）；
   - 其它交互按同一逻辑取最接近官方分类：鼠标靠近=问候、摸头=回合待机+返回城镇、戳=轻受击、拖拽=重受击、DSH 忙碌=战技/秘技/战斗开始；
   台词**单一来源** `src/renderer/src/core/voicelines.ts`（Lead 抓取 BWIKI 砂金/语音 与 砂金•戏浪/语音 两个页面并逐条核对，共 **111 条**：基础版 58 + 戏浪版 53；按文本去重后成功池 15、失败池 2、闲置池 30、忙碌池 10）；B1/B7 只引用不复制；`tests/voicelines.test.ts` 锁死「所有气泡文本 ∈ 官方原文集合」+ 场景映射 + 两版本覆盖，防回归成自创文本。气泡最大宽度放宽到 340px 以容纳官方长句。
5. **「手指像骨折 / 所有时候像鸡爪子」**：手指弯曲轴向用 FK + rest 向量叉积确认为「掌心朝下/后」，修正左右符号；静态弯曲从 18–40° 先减半到 8–19°、最终 5–13°，大角度仅用于手势；`hand-on-hips` 方案已验证但最终按用户反馈改回自然垂臂。
6. **用户提供的参考项目**（要求参考）：`shinyflvre/Mate-Engine`（Unity humanoid `.anim`，three 不能直接读，仅姿态/节奏参考——§11.1 已定）、`jinsc123654/l2dpet`（Live2D C++ 桌宠：待机呼吸/视线跟随/触摸反应/情景气泡分层思路可借鉴，资源与技术栈不可移植）、`sixtysevenlf/dsh-blender-plugin`（Blender 可视化建模/调参工具链，**可作为后续姿态作者工具**）、`xkk6663/dsh-live2d-mao`（Live2D + DSH 状态驱动，状态分层/气泡/行为触发思路已借鉴）。结论：这些项目**不能直接提供本 PMX 的可用动作资产**，但验证了“参考体系/工具链”是下一轮的关键。

### 20.4 自动化验收（2026-11-08 本机实跑，全部通过）

| 命令 | 结果 |
|---|---|
| `pnpm typecheck` | exit 0 |
| `pnpm test` | **52 files / 970 tests passed** |
| `pnpm build` | exit 0（renderer 双入口，含 `out/renderer/settings.html`） |
| `pnpm smoke`（dev） | `SMOKE_OK` exit 0；Wave 2 新增断言全过：`animation.pose='stand'`/`missingBones=[]`/`morphs`/`spring`、`behavior.mood/activity`、`motion.feet`、桌面 surfaces≥1 含 screen-bottom、眨眼 2s 内出现、`debugSetPose sit→stand`、`footErrorPx=0`、`debugSetGaze 25°→实际 24.9°`、设置窗加载/可聚焦/preload、`pet:dsh-status` 形状、`ignoreMouse` 端到端 |
| `pnpm smoke:file`（生产 loadFile） | `SMOKE_OK` exit 0 |
| `pnpm assets:prepare --check` | exit 0（textures=20 / pmxCopy=1） |
| `node scripts/build-native.mjs --check` | exit 0（winlist `--json` 实际运行） |
| dev 截图回环 | `PET_DEV_CAPTURE_*` 多轮（姿态 sheet/行为连拍/设置窗）全 OK，产物在 `tests/tmp/`（不入库） |

> 修正：dev smoke 曾两处偶发时序失败，均已修复并连续复跑稳定通过：①「mousemove 悬停拦截」——宠物自主走动导致读 rect 与派发 mousemove 之间位移，已在悬停探针前临时 `autonomous=false` 并延后恢复；②「overlay bounds===display.workArea」——系统 workArea 指标抖动（观测到 961↔963）+ A1 display watcher 200ms debounce 导致 report 抢跑，已改为最多 2s 重取显示器快照对齐后仍做**精确相等**断言（不放宽）。

### 20.5 实机观感证据（当前默认站姿/行为）

- `tests/tmp/anim-v4b-idle/sheet.png`：16 帧 idle（自然垂臂 + 3/4 侧身 + 重心慢移 + 官方台词气泡）；
- `tests/tmp/anim-v4b-walk/sheet.png`、`tests/tmp/anim-v4b-gest/sheet.png`：侧身走/手势（anim-b3 抓取）；
- `tests/tmp/v6-caps/01-stand*.png`、`v6-natural/10-idle.png`、`v6-idle/sheet.png`：Lead 抓的叉腰版/走路帧/连续 idle（历史轮次，留档对比）；
- `tests/tmp/cap-settings/settings.png`：设置面板截图（深色主题、尺寸 50%→540px、行为/DSH/系统区）；
- 全部 `tests/tmp/**` 已 gitignore，不入库。

### 20.6 已知限制 / 未覆盖

1. **动作观感未达用户验收**（最高优先）：见 §20.7；其余功能链路可用但视觉表演仍需重做。
2. **MMDPhysics/ammo.js 未引入**：模型 284 刚体/318 关节只用了手选发辫+袖子弹簧（轻量、无新依赖）；用户提到“内置很多关节”，后续若要衣摆/腰穗全物理需评估 ammo.js 包体/初始化/与程序化骨骼互斥（survey §6.2）。
3. **walk 正面投影偏弱**：模型正面朝镜头时前后摆腿投影小；已加 3/4 侧身与侧身转身，仍建议真机看一次。
4. `sit/sitEdge` 姿态需“窗口上沿/半悬边缘”场景验收（dev 截图放屏幕底部时腿会出画）。
5. 真实多屏/菜单栏自动隐藏/Space/睡眠唤醒、A5 真实 DSH 重装、打包（C4）仍按原计划留 Q1/C4。
6. `debugTriggerActivity` 在 `autonomous=false` 时会被 B1 取消（语义即“自主活动总开关关闭”），调试时需先开启自主；非 bug。
7. 手指/关节最终数值为“自然垂臂+轻微放松”版本，未经用户确认；不建议继续在其上调参（见下）。

### 20.7 后续建议：Wave 2.5「动作参考与姿态重做」专项（用户指示暂停后的正确下一步）

**问题定性**：本轮 B3 在缺少高质量动作参考与可视化调参工具的情况下，用 FK 反解+截图盲调姿态，空间轴向多次出错，收益递减；用户判断“没有给足够参考资料”成立。

**建议先做（独立调研+工具准备，不直接改姿态）**：
1. **参考素材采集**：官方基础版/戏浪版待机 GIF（B3 已下载基础版 2 段到 `tests/tmp/ref/`，戏浪版官方页为空占位）、走路/坐/摸头反应视频逐帧拆解（B站官方 PV/实机，标注时间点与 beat），真人 reference（站立 contrapposto/走路循环/手部放松姿态）；产出 `docs/anim-reference-v2.md`（beat 表 + 每拍骨骼目标 + 可验收判据）。
2. **可视化调参工具**：a) three.js 内 debug pose editor（滑杆调骨/实时侧视/正视图）；b) 或 Blender 工具链（可参考用户给的 `dsh-blender-plugin` 思路：PMX→VRM/FBX 在 Blender 摆姿→导出 VPD/JSON→回灌；注意需 MMD Tools + 授权）；
3. **姿态重做顺序**：stand（自然垂臂/叉腰二选一，以参考图为准）→ walk（侧视 + 正面双视角）→ sit/sitEdge（真实窗口上沿场景）→ 摸头/戳/拖拽反应；
4. **验收方式**：每姿态正/侧/45° 三视图截图 + 用户实机 10 秒观察；不再以“数值有变化”当作通过。

**其它可并行**：C1 真实拖窗、C2 捣乱、C3 通知/声音、C4 性能与打包（Wave 3 计划不变）；MMDPhysics 评估可并入 C4 性能决策。

---

## 21. Wave 2.5 动作专项调研（2026-11-08；调研完成，待用户确认后实施）

> 背景：Wave 2 的 B3 程序化姿态经 4 轮盲调仍未过用户验收（见 §20.3/§20.7）。用户指示**停止盲调**，先找「能直接拿来用的动作包/参考项目」，找不到再找「插件/skill」；用户无动捕设备，授权搜索替代方案。
> 本轮**未改任何 app 动画代码**（`src/**` 零改动）；交付为调研文档 + 可复用工具脚本 + 本机实测证据。
> **完整决策文档：[docs/anim-strategy.md](docs/anim-strategy.md)**（本文只记录结论与任务分解）。

### 21.1 结论（一句话版）

1. **用户点名的 4 个仓库都不能直接提供动作**：Mate-Engine = 128 个 Unity Humanoid muscle `.anim`（需 Unity 烘焙，仅宠物专属片段值得）；l2dpet / dsh-live2d-mao = Live2D 2D；`dsh-blender-plugin` = 工具（不含动作）但**是解决「盲调」的可视化回路现实手段**（BSD-3，v3.0.6）。
2. **主线改为「MMD 原生 VMD/VPD」**：three r171 `MMDLoader` 原生支持，**零引擎改动**；免费「下载即用」的宠物动作包基本不存在（需登录/失效/舞蹈为主），最干净的来源是 BOOTH「モーションパッケージ」男性待机包（¥2,000/20 个）。
3. **关键突破：`reze-rig`（MIT）humanoid FBX → VMD（以本 PMX 实测骨骼为目标）**。本机已实测：以本 PMX 为目标转换 4/5 样例成功，产出 VMD **54/54 骨轨道命中**、含足ＩＫ、`--in-place` 生效；`Idle.vmd`（3.00s 循环）在独立预览器渲染观感自然。Mixamo / Rokoko Create / Plask / CMU 等任何 humanoid FBX 都可走这条管线。
4. **无动捕设备方案**：首选 **Reze MiPo**（浏览器摄像头/视频 → 直接导出 VMD；0 账号 0 元 0 上传；适合待机/坐姿/反应）；走路/坐姿质量补强走 reze-rig + 外部 FBX。官方 PV/待机 GIF 做动捕已否证（wiki GIF 是 400×540 半身特写）。
5. **可视化调参回路已实跑**：Blender 4.2.23 LTS（仓库外 `/Volumes/4TB外置盘/deepseek-harness/tools/blender/`）+ MMD Tools v4.5.14 无头导入本 PMX（贴图/骨骼正常）、四视图 Workbench 渲染、摆姿→VPD 导出（roundtrip 0.04°）、three r171 可消费（bone-only VPD，cp932 → `loadVPD(url,false)`）。
6. **架构原则**：B3 的 poses/gestures 数据一行不改；新增「外部动作层」与 B3 互斥/分层，由动画门面调度（详见 docs/anim-strategy.md §4）。

### 21.1b 实施进展（2026-11-08 凌晨，Wave 2.5 已开工）

用户拍板「零额外花费、按需组合」后，已落地 D1/D2/D3：

| 项 | 状态 | 说明 |
|---|---|---|
| **D1 VMD 动作层接入 app** | ✅ 已实现 | `src/renderer/src/animation/external/**`（manifest/selection/grounding 纯逻辑 + vmd-clip/vmd-driver three 适配）；`createHybridAnimator` 由 main.ts 注入；VMD 激活时 B3 只写 morph（表情/眨眼/口型）；无清单/加载失败/异常全量回退 B3。调试快照新增 `source/clipId/clipTimeSec/externalFootErrorPx/externalIk/externalPlaybackRate`。 |
| **D2 零成本素材 + 管线固化** | ✅ 已实现 | `scripts/anim-pipeline/reze/`（reze-rig MIT 原样入库 + build/convert/glb2fbx）；`assets/model/optimized/motion-{idle,walk,taunt}.vmd + motion-index.json`（本地 gitignore；idle 54/54、walk 51/51 骨命中，walk 1.03s 完美原地循环）。 |
| **D3 走路速度匹配** | ✅ 已修复 | 实测 B1 原走速 62–112px/s 与真实步态差 4–7 倍（0.5× 慢放仍滑步）。改为**体高相对自然步速**：`PetRuntime` 把 `moveTo(walk)` 速度替换为 `petHeightPx × 0.87 体高/秒 × 档位系数`；VMD 层按宠物高度换算 manifest nominal（参考高度 540px）。实测实机：walk 时 `velocity=470px/s @540px`、`externalPlaybackRate=1.0`、`clipId=walk`、脚底误差 0。任意 sizePercent 均不滑步（单测覆盖 108/324/540/861px）。 |
| **冒烟断言** | ✅ 已加 | `motion-index.json` 不存在 → 跳过（干净 clone 全绿）；存在 → 校验清单合法/文件齐全/`source==='vmd'`/`clipId` 非空/IK 模式/idle `externalFootErrorPx<2`。`pnpm smoke` 与 `pnpm smoke:file` 均 exit 0。 |
| **D4c 坐姿接近动画修正** | ✅ 已修复 | B1 的 sit activity 从接近阶段就置 `mood=sit`（旧 B3 同问题，会「坐着滑向窗口顶部」）。集成层 `PetRuntime.animationMoodFor()` 在 `motion.kind='sit' && !grounded` 时把**动画** mood 改成 `walk`（水平接近，播真实 VMD 步态）/ `climb`（垂直接近，回退 B3 爬行），`decision.mood` 不变；单元测试 6 例。 |
| **D4k 自主行为连拍回归** | ✅ 已跑 | 2.25 分钟 dev 连拍 90 帧（`tests/tmp/wave25-wander/`）：0 错误；自主 mood 分布 idle/climb/sit/walk 正常，clip 语义一致（攀爬阶段先 fallback B3 procedural climb、落座后 VMD sit），fps 平均 28.5、min 26.3；验证「自主走动 + 爬窗 + 坐下」全链路与 VMD 层共存无异常。 |
| **D6d 坐姿锚点修正（屁股贴沿）** | ✅ 已完成 | 用户反馈「屁股定位不对，现在腰跟窗口齐平」：最初锚 `下半身`（bind y=13.33，是腰/腹节点）→ 腰贴沿、屁股沉下去；改为锚 `センター`（bind y=8.93，骨盆中心）+ manifest 新增 `seatedAnchorOffsetUnits`（正 = 下移），sit 设为 `3.2` 单位。实测 Finder 顶边 local y=390：`visualOffsetYPx≈-170`，窗沿红线穿过臀/大腿根，身体在上、腿悬垂在下（`tests/tmp/wave25-winsit7/body-line.png`）。 |
| **D9a 静态坐姿 + microSway** | ✅ 已完成 | 用户反馈「坐下变成捧腹大笑的前摇」「姿态僵硬」：坐姿 clip 换成 Sitting Laughing **单帧安静姿势**（frame 90，vmd-clip 支持单帧静态姿势最短 0.2s 循环）+ manifest `microSway`（程序化呼吸/头微摆，±0.6°）；窗沿 hip 锚点不变。 |
| **D9b 站在可坐窗沿自动坐下** | ✅ 已完成 | 用户反馈「窗口拖到下半屏，它只会站上去」：`finishFall` 落地窗沿 450ms 内优先坐；新增「空闲站在可坐窗口上沿 ≥700ms 自动坐下」兜底（可重复坐）；不可坐高窗口顶 250ms 后直接跳下。单测 2 例。 |
| **D9c Mate-Engine / VRM 路线评估** | ✅ 已记录 | 见 `docs/research/mate-engine-vrm-eval.md`：Mate-Engine 为完整 Unity 6000.2.6f2 工程（AGPL+MateProv2，可私下修改）；官方 macOS 移植为 Pre-Alpha 未完成；推荐先用 three-vrm 在现有 app 获得 VRM spring bone 物理。 |
| **D8a 摸头不再自卫（移除 taunt）** | ✅ 已完成 | 用户反馈「点头还是自卫」：pat mood 之前播 Mixamo Taunt（手抬到胸前，看着像防御/挑衅）。manifest 移除 `taunt` clip，摸头改为 B3 程序化 pat 反应（被摸头基底 + 反应手势）；戳头事件在 VMD 激活时已不转 B3 骨骼。 |
| **D8b 坐姿改安静版（不再捧腹大笑）** | ✅ 已完成 | 用户反馈「一直捧腹大笑诡异」：坐姿 clip 从 Sitting Laughing 全片换成**前 3 秒安静段**（`motion-sit-calm.vmd`，手搭膝/降肩，3s 循环）→ 实测窗沿坐安静自然。 |
| **D8c 到窗沿立即坐 / 不可坐直接跳下** | ✅ 已完成 | 落地在可坐窗沿 450ms 后立即坐（不再先站着）；落在不可坐窗口顶（太高/被挡）250ms 后直接 `dropDown` 跳下，不在高窗口上站立。 |
| **D8d 拖拽姿态更「悬空下垂」** | ✅ 已完成 | 拖拽 B3 姿态：手臂自然垂在身侧、膝盖放松微屈、脚尖下垂、双腿略内收；拖拽时暂停 VMD（不再播甩出）。 |
| **D7a 拖拽改为「被拎起、四肢下垂」** | ✅ 已完成 | 用户反馈仍看到「奇怪的拖拽甩出动作」并要求参考 Mate-Engine：拖拽时暂停 VMD，交给 B3 `drag` 姿态；该姿态改为手臂自然垂在身侧、腿垂下、肩放松（原版手臂上举像被拉直）。manifest 移除 drag clip（不再播 Shoved-spin）。 |
| **D7b 脚趾上翘修复（站立+走路）** | ✅ 已完成 | 用户反馈「走路和普通站立脚趾都上翘」：根因是外部 VMD 的 `足先EX` 轨道（+20~50°）；manifest 新增 `suppressBones`（按 PMX 骨名剔除轨道），所有 clip 剔除 `左足先EX/右足先EX`。实测 idle/walk 截图中脚掌平放。 |
| **D7c 落到可坐窗沿后优先坐下** | ✅ 已完成 | 用户反馈「把宠物放到窗口上沿不会坐下、只会掉下来」：B1 `finishFall` 检测落点若为可见可坐的 `window-top`，短恢复后优先启动 `sit` 活动；新增单测（落地窗沿→mood=sit/hold）。**几何限制**：默认 50% 尺寸下窗口顶边需在 workArea 顶部往下 ≥343px（约屏幕下半部）才可能坐下，否则头会跑出屏幕外（不是检测过严）。 |
| **D6a 窗口顶边可见性遮挡裁剪** | ✅ 已完成 | 用户实机反馈「坐到了访达上，但访达在下层，像在屏幕中间虚空坐下」。B5 `createWindowSurfaces` 按 CGWindowList 前→后顺序，用前层窗口矩形求交，只保留窗口顶边**未被遮挡的可见区间**生成 `window-top` 表面（完全遮挡则无表面；部分遮挡裁剪 rect）；`DesktopSensor.buildSurfaces` 传入 `visible.slice(0, index)` 作为遮挡者。单测：完全遮挡不可坐 / 部分遮挡裁剪到可见段 / 无遮挡不变。实测：Terminal 置前时 Finder 顶边表面消失，sit 不再触发（无可见可坐窗口）。 |
| **D6b 新走路（模之屋 qqasd）+ morph 剥离** | ✅ 已完成 | 采用用户下载的「走路动作(0-39为一组循环)」：1.33s 循环、IK 控制骨 + FK 腿、`ik:"on"`；natural speed 按足ＩＫ步幅实测 ≈286px/s@540 → app 速度 470 时 playbackRate=1.6（clamp 上限，脚底误差 0–1.15px）；新增 `scripts/anim-pipeline/reze/strip-vmd-morphs.py`：原生 MMD 动作的 morph 轨道会让 r171 `animationBuilder.build` 抛错（`Cannot read properties of undefined (reading '真面目')`），接入前剥掉（表情由 B3 管）。 |
| **D6c 新坐姿（Sitting Laughing + hip 锚点）实测** | ✅ 已完成 | 坐姿 clip 换成 Mixamo Sitting Laughing（8.33s 循环，穿「坐窗沿笑」）；`seatedAnchor:"hips"`；Finder 低窗口（顶边 local y=430）实测：`clipId=sit / surface=win-4452-top / visualOffsetYPx≈-206~-213`，臀部贴窗沿、腿悬垂（截图 `tests/tmp/wave25-winsit4/seated-closeup.png`）。 |
| **D5a 移除爬窗** | ✅ 已完成 | 2026-11-08 用户实机反馈「爬窗双臂高举很奇怪，不会做就算了，改计划不要爬」。`climb` activity `baseWeight=0`/`schedulable=false`，`triggerActivity('climb')` 直接拒绝；B1 爬窗路径用例标 skip。 |
| **D5b 坐窗重构（窗沿 + hip 锚点）** | ✅ 已完成 | 只在 `window-top` 上坐（Dock/菜单栏/地面不再坐）；`sittable` headroom 改为 0.62×身高（上半身可见即可）；VMD clip 新增 `seatedAnchor:"hips"`：坐地时把 `下半身` 骨对齐摆放线世界高度（实测 `visualOffsetYPx=-214px`，臀部贴沿、腿悬垂）；新增调试快照 `visualOffsetYPx`，hit/气泡矩形跟随视觉偏移；接近阶段 mood 由 `climb` 改 `walk`（不再举手），接近速度 120→520px/s、坐姿时长 8–16s→20–35s。用 Finder 低窗口（顶边 y=420）实测：`clipId=sit / surface=win-4278-top / visualOffsetYPx≈-214`。 |
| **D5c pat/poke 反应不再转 B3** | ✅ 已完成 | 用户反馈「点击头部出现自卫反应很怪」：VMD 激活时 `b3.update({...input, events: []})`，pat/poke/thrown/landed 的 B3 骨骼手势不再触发（表情仍由 B3 驱动）；后续 landed 改由 VMD 落地 clip 承担。 |
| **D5d `mmd_motion_tools` 动作修复工具** | 🔜 待安装使用 | 用户提供 Blender 插件 v1.1.0（穿模检测/批量修动作/重复帧查找/相机修复），已解压 `tests/tmp/motions/mmd-motion-tools/`；待装到本地 Blender 4.2 跑穿模检测与动作修复。 |
| **D5e 模之屋通用动作** | 🔜 待用户下载 | 用模之屋公开列表接口筛出免费动作清单（待机/走路/坐姿/摸头），已把链接发用户下载；到货后预览择优接入。 |
| **D4j 全 mood→clip 实机映射冒烟** | ✅ 已加 | 冒烟新增 `runMotionMoodProbe()`：通过 `debugSetAnimationMood` 逐个覆盖动画 mood（只在动画层，不影响 B1/B2），在**真实 app** 里断言 walk/sit/pat/drag/dshDone/dshError → 期望 VMD（walk/sit/taunt/drag/salute/reaction）且 `source=vmd`；`pnpm smoke` 与 `pnpm smoke:file` 均 `moodProbe.ok=true`（dev/生产 loadFile 两条链路）。 |
| **D4i pat/drag 实机验证钩子** | ✅ 已加 | 调试面新增 `debugSetAnimationMood(mood\|null)`（只覆盖 `AnimationInput.mood`，不影响 B1/B2；默认 null 零影响）+ dev capture `PET_DEV_CAPTURE_MOOD=pat\|drag`；实测 `motion-taunt.vmd`/`motion-drag.vmd` 在实机渲染链路正确选中（`source=vmd`、`clipId=taunt/drag`、播放时间正常），截图 `tests/tmp/wave25-{pat,drag}-inapp/`。 |
| **D4h 坐/爬目标可见性过滤** | ✅ 已修复 | 实机验证发现：屏幕最上方最大化窗口顶边被 B5 标为可坐，B2 把 feet 放到 surface.top 后宠物大半身体在屏幕外（截图只剩脚）。集成层新增 `PetRuntime.filterDesktopTargetsForPet()`：只对 B1 目标选择过滤（`headroom ≥ petHeight + 8px` 才保留 sittable/climbable），B2 物理落点不变；单测 7 例；实测 sit 目标不再选到屏幕上方窗口（切换为 dock/screen-bottom）。 |
| **D4g 验收清单 + 长跑回归** | ✅ 就绪 | 新增 `docs/anim-acceptance.md`（用户逐项打勾的实机验收清单 + 证据索引 + 复现命令 + 已知限制）；dev 长跑 **103s 存活、0 错误**（`/tmp/longrun.log`，PET_PROFILE=wave25，VMD 7 clips 激活）。 |
| **D4f 走路片段替换（观感）** | ✅ 已替换 | 旧 Soldier Walk（军事步态）→ three.ws `Walking.fbx`（Mixamo 标准 Walk，0.967s、54/54 骨、自然步速≈490px/s@540px）；manifest nominal 470→490、app 实测 rate=0.959/滑步<5%；旧版留档未入清单。 |
| **D4d VPD 工具链闭环** | ✅ 已实现 | `scripts/anim-pipeline/reze/vpd2vmd.mjs`（零依赖）：Blender MMD Tools 导出的 `.vpd`（兼容单行 CSV 与 Blender 多行变体、cp932/UTF-8 自动检测、科学计数法、零四元数）→ 单帧 `.vmd`，可直接进 app 的 VMD 通道；**实测** Blender 导出 VPD → VMD → 预览器 5/5 骨命中 PREVIEW_OK；回归测试 9 例（`tests/vpd2vmd.test.ts`）。 |
| **D4 坐姿/反应 + look-at** | ✅ 已实现（遗留 1 项） | ① sit：GitHub `nirholas/three.ws` 的 Mixamo `Sitting Clap.fbx` → `motion-sit.vmd`（54/54 骨、5.67s 循环、センター Y≈−4.7 坐面高度、预览 7/7 PREVIEW_OK），实机 dock-bottom 坐姿截图通过；② 反应：`motion-salute.vmd`→`dshDone`、`motion-reaction.vmd`→`dshError`；③ manifest 3→7 clips（D4e 补 `drag`→Mixamo Shoved Reaction With Spin 4.53s 一次性，摸头→taunt 已有）；④ **additive look-at**：VMD 激活时头/颈按 30%、眼球 100% 叠加跟随鼠标（facing ±90° 局部化、±31° 钳制、90ms 平滑、2.5s 回落），实机强制注视 ±25° 对称生效（`gaze.yaw≈±0.436`、`lookYaw≈±0.806`）；⑤ manifest 新增 `grounding: feet|none`（坐姿/悬垂腿可关闭脚底补偿）。**遗留**：仍缺「被拎起持续挣扎循环」素材（当前一次性反应+回退 B3 拖拽姿态）；拖拽观感待用户实机确认。 |
| **D5 Blender 回路** | ✅ 工具已就绪 | Blender 4.2.23 + MMD Tools v4.5.14 实测可无头导入/四视图/VPD 导出（见 `docs/research/tooling-blender.md`）；`dsh-blender-plugin` 未安装（待用户批准）。 |

> 实机证据（gitignore）：`tests/tmp/wave25-idle/idle-strip.png`（VMD idle 4 帧）、`tests/tmp/wave25-walk-after2/walk-strip.png`（VMD walk 3 帧 + 停步）、`tests/tmp/smoke-wave25.log`、`tests/tmp/smoke-file-wave25.log`。
> 已知限制：① 发辫/袖摆/布料静态（physics:false，未引入 ammo.js）；② B3 的 6 个 idle 手势在 VMD idle 下不可见（骨骼写入互斥；后续用独立 VMD 反应片段或 additive 层补）；③ 走路 clip 来自 Mixamo 军事角色 Walk（气质偏硬，可替换）；④ sit approach 期间坐姿 clip 提前播放（B1 mood 语义问题，需过渡 clip 或 mood 修正）；⑤ look-at 为 additive 近似（头/颈 30%，大角度不如 B3 自然，实机可调参）。

### 21.2 本轮交付物

| 交付 | 路径 |
|---|---|
| **决策文档（必读）** | `docs/anim-strategy.md` |
| **验收清单（用户确认用）** | `docs/anim-acceptance.md` |
| 4 仓库审计（含 Mate-Engine 128 动画全量实测/Unity 转换路线） | `docs/research/repos-audit.md` |
| MMD 动作包渠道/真实下载解析/授权 | `docs/research/motion-assets.md` |
| 无动捕方案（MiPo/reze-rig/服务矩阵/额度测算） | `docs/research/mocap-options.md` |
| Blender 回路实测（安装/渲染/VPD/three 兼容） | `docs/research/tooling-blender.md` |
| VMD/VPD 独立预览器（动作包验收工具） | `docs/research/vmd-preview-tool.md`、`scripts/anim-pipeline/preview/` |
| 官方/真人参考素材 + beat 表 | `docs/anim-reference-v2.md` |
| 可复用脚本 | `scripts/anim-pipeline/{blender,preview,reze,motions}/`（不含模型/动作二进制；`motions/` 只有清单模板与再生成说明） |
| 本机实测证据（gitignore） | `tests/tmp/{motions,preview,blender-probe,ref2,repo-audit,mocap-eval}/` |

> 预览器默认**不可见窗口**（capturePage 截图）；仅 `--show` 时显示，避免验证时在用户桌面闪模型/转视角。

### 21.3 Wave 2.5 任务分解（建议，待用户确认后开工）

| ID | 任务 | 依赖 | Scope | 验收 |
|---|---|---|---|---|
| D1 | VMD/VPD 动画源接入 + 与 B3 互斥门面 | 无 | `src/renderer/src/animation/**`（新增 external 层）、`main.ts` 工厂、调试快照扩展 | ✅ 已完成：`source='vmd'`/idle `externalFootErrorPx<2`/无 NaN 冒烟通过；实机 idle 观感自然 |
| D2 | reze-rig 批量转换固化 + 动作素材获取 | 可与 D1 并行 | `scripts/anim-pipeline/reze/`、`docs/research/motion-free-pipeline.md` | ✅ 已完成（idle/walk/taunt；sit 仍 TODO，见 D4）；授权记录在 motion-free-pipeline.md |
| D3 | 走路速度匹配（体高相对自然步速 + 高度换算 nominal） | D1、D2 | `core/pet-runtime.ts`、`animation/external/selection.ts` + 单测 | ✅ 已完成：实机 470px/s@540px、rate=1.0、脚底误差 0；任意尺寸不滑步（单测 108/324/540/861px） |
| D4 | 坐姿/窗沿坐 + 摸头/拖拽反应（VPD/VMD） | D1、D3 | `animation/external/**` + `scripts/anim-pipeline/blender/**` | 三视图 + 真实窗口上沿场景验收 |
| D5 | Blender 可视化回路常态化 +（可选）`dsh-blender-plugin` 独立 profile 安装验收 | 无 | `scripts/anim-pipeline/blender/**` | `doctor.kind=ok` 或 worker 出帧；自定义姿态→VPD→回灌闭环 |
| D6 | 参考 beat 表驱动的观感验收 | D3、D4 | 验收文档/截图 | 每姿态三视图 + beat 对照 + 用户实机通过 |
| D7（可选） | MiPo 定制动作 / Mate-Engine Unity 烘焙（3–5 人日，仅 VMD 不足时） | D6 后仍不足 | 独立 | 补足宠物专属动作（窗沿坐/躲藏/拖拽/摸头） |

### 21.4 需要用户操作/拍板（详见 docs/anim-strategy.md §9）

1. **是否按路线 A 进入 Wave 2.5 编码**（0.5–1 天出可看效果，不需要任何外部账号）。
2. 动作素材（可选）：Adobe/Mixamo 免费账号 / BOOTH 第 91·22 弹（¥2,000/包）/ 微云砂金动作配布（需 QQ/微信登录）/ Rokoko Create 免费 5 clips。
3. 是否安装 `dsh-blender-plugin@3.0.6`（建议独立 profile，`doctor.kind=ok` 验收）。
4. 是否接受「外部动作本地自用、不随 app 分发」（授权已核对，符合模型不可再配布前提）。
5. 是否保留已装 Blender 与 `scripts/anim-pipeline/` 工具脚本。

### 21.5 与旧结论的关系

- §11.1「主线用程序化姿态，Mate-Engine 动画不能直接复用」：**前半句作废**。外部动画主线改为 **MMD VMD（MMDLoader 原生支持）+ reze-rig 重定向**；Mate-Engine 仍不直接复用（仅 25–35 个宠物专属片段值得 Unity 烘焙）。
- §20.7 的四条建议：①②（参考素材 + 可视化工具）已在本轮完成；③④（姿态重做/三视图验收）并入 Wave 2.5 的 D1–D6。
- 旧 B3 程序化姿态不再是唯一来源，但保留为**兜底层**（VMD 未覆盖的状态：climb/sleep/fall 等）与表情/微动来源。

---
