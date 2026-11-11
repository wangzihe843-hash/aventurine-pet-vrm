# 砂金·戏浪 桌面宠物（aventurine-pet-vrm）

**中文** · [English](README.en.md)

macOS 透明悬浮桌宠。角色是《崩坏：星穹铁道》的**砂金·戏浪**（VRM 1.0，私有资产、不进 git），
渲染用 **three.js + three-vrm**，外壳是 **Electron**，动作来自 Blender 重定向管线，并与
**DeepSeek Harness（DSH）** 通过文件桥双向联动。

本 README 讲**代码库怎么组织、数据怎么流、改哪里**。**不会建模、只想换个模型或换套动作**，直接跳到
[「不会建模怎么用：四篇攻略」](#不会建模怎么用四篇攻略)。

历史进展与逐 Wave 验收记录见 [项目记录](docs/archive/README-2026-11-11-wave-log.md)，
实施计划见 [PLAN.md](PLAN.md)。

| 事实 | 值（本快照实测） |
|---|---|
| 运行时 | Electron `^44.7.2` / three `0.171.0` / three-vrm `3.5.5` |
| 构建 | electron-vite `^6` + Vite `^8` + TypeScript `5.9` |
| Node / 包管理 | Node `>=22.12.0` / `pnpm@10.20.0`（`packageManager` 固定） |
| 目标平台 | macOS 13+，`appId com.aventurine.pet`，产物 `dist/mac-arm64/AventurinePet.app` |
| 源码规模 | `src/**` 161 个文件；`src/main/index.ts` 2788 行（启动 + 冒烟 + dev 截图） |
| 测试 | 139 个 test 文件（138 通过 / 1 条件跳过）；**2779 passed + 16 skipped（2795 cases）**，2026-11-11 实测（本机私有资产齐全） |
| 私有动作清单 | `app-manifest.json` **40 clip** / `app-catalog.json` **181 clip** |

## 红线（先读这段）

- 模型版权归 **miHoYo**；作者规则**禁止二次配布、禁止商用**。仓库只含代码与公开资源，
  模型/动作/表情/道具全部是本机私有资产。
- 以下目录被 `.gitignore` 明确排除，任何公开仓库、分享包、PR 都必须不含它们：
  `assets/model/`、`assets/vrm/`、`assets/motions/`、`assets/expressions/`、`assets/props/`、
  `assets/voicelines.json`、`*.pmx`、`refs/`、`work/`。
- `dist/` 里的 `.app` 内含私有资产且是 **ad-hoc 签名/未公证**，**仅限本机使用，不得分发**。
- v1 归档工作区（`deepseek-harness/aventurine-pet`）只读参考，不要改。

## 快速开始

```bash
pnpm install          # postinstall 会自动装 Electron 二进制
pnpm native:build     # 编译 native/winlist（Swift；predev/prebuild 自动跑，幂等）
pnpm dev              # 默认 VRM 后端
pnpm typecheck        # tsconfig.node + tsconfig.web 两侧
pnpm test             # vitest，tests/**/*.test.ts
pnpm build            # prebuild 资产校验 + typecheck + electron-vite build
pnpm package:dir      # build → electron-builder --mac dir → package-check
```

首次跑起来需要两样外部条件：

1. **私有资产**：`assets/vrm/`（至少 `aventurine-tpose.vrm`）与 `assets/motions/`。缺资产时
   `prebuild` 的 `prepare-assets.mjs --check` 会失败，可用
   `AVENTURINE_SKIP_ASSETS_CHECK=1 pnpm build` 跳过**校验**（但不会凭空生成资产，产物不可渲染）。
2. **Xcode Command Line Tools**：`native/winlist` 用 `swiftc` 编出 universal（arm64 + x86_64，
   minos 13.0）二进制，供主进程枚举窗口。

常用补充命令：

```bash
pnpm smoke            # 端到端冒烟（PET_SMOKE_TEST=1，拉真实窗口/资产/桥）
pnpm assets:prepare   # 生成/校验 assets/model/optimized（PMX 回退路径）
pnpm dsh:canary       # DSH 桥契约 canary（临时 DSH_HOME + mock LLM，不碰真实 ~/.dsh）
pnpm package:check    # 校验 .app 的 bundle id / app.asar / Resources / helper 架构
pnpm test:coverage    # v8 coverage，阈值见 vitest.config.mts
```

并行开发多个 worktree 时用 `pnpm dev:worktree`：它把 `PET_PROFILE` 设成目录名派生值，
让每个 worktree 有独立的 `userData`、配置和单实例锁空间（打包版才启用单实例锁）。

## 不会建模怎么用：四篇攻略

| 你卡在哪 | 看这篇 |
|---|---|
| 不知道模型 / 动作去哪下 | [素材去哪找：模型与动作](docs/guide-asset-sourcing.md) |
| 手上是 PMX / FBX / VRM0，要变成能渲染的 VRM | [三种模型转 VRM](docs/guide-model-conversion.md) |
| 有 FBX / `.anim` / `.max` / VMD，要变成 app 能播的 clip | [四条动作管线](docs/guide-motion-conversion.md) |
| 转完出现类 A-pose、溜肩、镜像、滑步 | [高频坑 + 丢给 AI 的模板](docs/guide-asset-pitfalls.md) |

三句原则：模型必须是**规范 T-pose 的 VRM 1.0**；动作优先**同游戏同角色**，其次同体型、同性别；
**没有动捕设备不要 AI 从零捏动作**。坑都有确定解法，把现象 + 报错丢给 AI 即可。

## 架构总览

三层：**Electron 主进程 / preload / 渲染进程（两个页面入口）**，外加一条完全解耦的
**DSH 文件桥**。共享层 `src/shared/**` 是环境中立纯 TS（禁 `electron`、禁 `node:` 内置模块），
三端共用同一份契约。

```text
┌──────────────────────────── macOS ────────────────────────────────┐
│  DeepSeek Harness Host（另一个 Electron 应用，独立进程）            │
│    └─ bridge/dsh-aventurine-bridge（cordis 插件，host-only）        │
│         status.json / control.json / events.jsonl（原子写）         │
│                        │ 文件，轮询 750ms                          │
│  ┌─────────────────────▼───────────────────────────────────────┐  │
│  │ AventurinePet.app（Electron 44）                             │  │
│  │                                                             │  │
│  │ main      overlay×N（每显示器一个透明窗）/ 托盘 / 设置窗       │  │
│  │           pet-asset:// 协议 / 配置持久化 / 安全加固            │  │
│  │           dsh-watch → dsh-event（仅 online 转发）              │  │
│  │           dsh-lifecycle（互保活 / 同生共死状态机）              │  │
│  │           winlist helper（Swift, 250ms CGWindowList）          │  │
│  │ preload   window.api = PetApi 白名单转发（contextIsolation）   │  │
│  │ renderer  index.html（透明 overlay：three-vrm 场景 + 运行时）  │  │
│  │           settings.html（普通设置窗，第二入口）                │  │
│  └─────────────────────────────────────────────────────────────┘  │
└───────────────────────────────────────────────────────────────────┘
```

关键边界选择：

- **渲染进程只看到一个受限 API**：`window.api`（`PetApi`）。不暴露 `window.electron`、
  原始 `ipcRenderer` 或 `process.env`；`contextIsolation` 关闭时 preload 直接抛错（fail-fast）。
- **资产不走 `file://`**：统一走自定义协议 `pet-asset://model/...` 与 `pet-asset://assets/...`，
  由主进程做路径校验、根目录限定与符号链接竞态防护。
- **DSH 不通过端口通信**：桥只写固定目录的文件，桌宠轮询。DSH 崩了桌宠能活，桌宠关了 DSH 不受影响
  （除非显式开启强耦合）。

## 代码地图

| 路径 | 职责 |
|---|---|
| `src/shared/` | **冻结契约**：`ipc.ts`（通道 + `PetApi`）、`types.ts`、`config.ts`（默认值/`sanitizeConfig`）、`bridge-schema.ts`（桥文件校验）、`vrm.ts` / `animation-contract.ts` / `expression-contract.ts`、`peek.ts` |
| `src/main/index.ts` | 启动接线、单实例、安全加固、崩溃恢复、冒烟报告、dev 姿态截图；**不是纯入口**，改动最需谨慎 |
| `src/main/app-context.ts` | 进程级 overlay 注册表 + 类型安全 `broadcast()` |
| `src/main/windows/` | `overlay-manager`（多屏同步/重建/显隐）、`settings-window`、`mouse-gate`、`layout`、`crash-recovery` |
| `src/main/ipc/` | 按领域注册 handler：`window` / `config` / `desktop` / `settings` / `dsh` |
| `src/main/desktop/` | `winlist.ts`（helper 调用 + 兜底）、`dsh-watch.ts`（文件尾随）、`dsh-version.ts` + `dsh-compat.ts`（兼容判定）、`dsh-process.ts`（进程操作）、`dsh-lifecycle.ts`（强耦合状态机）、`dsh-bridge-state.ts` |
| `src/main/protocol.ts` / `protocol-path.ts` | `pet-asset://` 协议与纯函数路径校验（可单测） |
| `src/main/config-store.ts` | `userData/config.json` 原子读写 + 清洗（不依赖 Electron，可注入临时目录） |
| `src/main/logger.ts` / `tray.ts` / `login-item.ts` / `security/` | 文件日志、菜单栏托盘、开机自启、导航与网络护栏 |
| `src/main/peek/` | 窥屏互动的**预留桩**：只有类型/fail-closed gate，默认关闭、零采集 |
| `src/preload/index.ts` | `PetApi` 白名单转发（纯转发，无业务逻辑） |
| `src/renderer/src/main.ts` | overlay 页启动、布局、rAF 渲染循环、调试面、资源释放 |
| `src/renderer/src/core/` | `pet-runtime.ts`（把桌面感知/行为/物理/DSH 反应编排成每帧输出）、`wave2-contract.ts`（渲染层冻结契约）、`bubble.ts`、`voicelines.ts` |
| `src/renderer/src/behavior/` | 行为状态机 + 加权随机活动调度（纯逻辑） |
| `src/renderer/src/physics/` | 重力/碰撞/拖拽甩出/表面吸附（纯逻辑，脚底点为唯一权威） |
| `src/renderer/src/desktop/` | 窗口列表 → 桌面表面（`DesktopSensor`：坐标换算、过滤、transitions） |
| `src/renderer/src/interaction/` | 拖拽/摸头/戳/注视/右键菜单（纯逻辑与 DOM 分层） |
| `src/renderer/src/scene/` | `PetView` 抽象 + legacy PMX 场景 + fps 限制/轮廓/像素比等公共渲染设施 |
| `src/renderer/src/vrm/` | VRM 场景、clip 播放、动画组合层、表情层、look-at、foot-lock、手持道具、上下胸折叠 |
| `src/renderer/src/animation/` | legacy（v1 VMD/程序化）动画，`index.ts` 仅 facade；`legacy-pmx` 回退时使用 |
| `src/renderer/src/reactions/` | DSH 事件 → 一次性表演；DSH 回复气泡状态机；工作/闲时小动作 |
| `src/renderer/src/settings/` | 设置页模型与 DOM（图片/滑杆/开关的纯函数换算均在 `settings-model.ts`） |
| `bridge/dsh-aventurine-bridge/` | DSH 侧 host-only 插件（ESM，无构建步骤） |
| `native/winlist/` | Swift 窗口枚举 helper 源码与说明 |
| `scripts/` | 构建/打包/资产/动作管线/验收脚本（`vrm/`、`unity-bake/`、`anim-pipeline/`、`max-export/`、`props/`、`wave3-e2e/`） |
| `tests/` | 139 个 vitest 用例文件；`tests/tmp/` 是本地证据目录，不收集 |

## 启动链路（主进程）

`src/main/index.ts` 的顺序是有依赖的，改动时按这个顺序理解：

1. **`app.whenReady()` 之前**：`applyDevProfile()`（`PET_PROFILE` 改 `userData`）、
   `registerPetAssetScheme()`（Electron 硬性要求先注册 scheme）。
2. `bootstrap()`：macOS 设为 `accessory`（无 Dock 图标、不进 Cmd+Tab）、`hardenSession()`、
   建文件 logger、挂崩溃恢复、`registerPetAssetProtocol()`、`registerIpcHandlers()`。
3. `createOverlayWindowsManager({ getDisplays, loadContents, hardenWebContents })`：
   `manager.sync(getDisplayInfos())` → **每个显示器一个 overlay**；再 `startDisplayWatchers()`
   监听拓扑/workArea 变化（防抖重建 + 广播 `screens-updated`）。
4. 托盘（显示/隐藏、设置、退出）；`will-quit` 时释放恢复策略、设置窗、overlay。
5. 退出语义：托盘常驻，隐藏不是关闭；只有托盘「退出」、`pet:quit` 或没有托盘时才退出。

## 渲染进程：启动与每帧管线

`boot()` 先建气泡、DSH 回复状态机、交互控制器，订阅 `config-changed` / `screens-updated` /
`windows-updated` / `dsh-event`，然后**并行**取初始配置与窗口几何，最后 `updateLayout()`；
场景在布局确认「宠物该显示」后才创建（`ensureScene`，默认 VRM，`legacy-pmx` 走旧场景）。

每个 rAF 帧（`frame()`）的固定顺序：

```text
interaction.drainEvents()            # 取走本帧交互事件
interaction.getSnapshot()            # 指针/悬停/拖拽/摸头进度/注视目标
forwardDragEvents()                  # 拖拽事件立刻下发物理，保证跟手
runtime.frame({ nowMs, dt, ... })    # 见下
  ├─ 1 desktopSensor.snapshot()      # 桌面表面 + transitions
  ├─ 2 dshReactionTracker.reactionAt()
  ├─ 3 behaviorDirector.update()     # 行为决策（B1）
  ├─ 4 physics.setCommand + step()   # 物理步进（B2）→ feet
  └─ 5 组装动画输入（mood/facing/事件 thrown·landed）
applyRuntimeOutput()                 # 气泡仲裁 → setAnimationInput → placePet → 命中门 → 调试面
scene.step(nowMs)                    # 渲染 + 动画层
```

要点：

- **气泡仲裁**：DSH 对话层（`DshDialogue`）优先于行为层台词；`dshBubbleSync=false` 时跳过。
- **命中矩形跟随视觉**：foot-lock 的 hips 横移与 sit 下沉都会让视觉位置偏离物理 `petRect`，
  命中/气泡用 `pointerRect` 修正常量级的偏移（不改物理口径）。
- **fps 上限在场景内**（`fps-limiter`）：跳帧不影响行为/物理，因为它们按真实 `nowMs`/`dt` 推进。
- **连续异常 3 次停止更新场景**但保留 rAF，便于读取 `window.__aventurineDebug` 排查。

VRM 动画层顺序（`vrm/animator.ts` 顶部有完整说明）：

```text
clip-player.update()      # humanoid 骨 + Hips 位移 + 贴地
expression-layer.update() # expressionManager
look-at.update()          # 头/眼 additive
humanoid.update()         # 同步 raw 骨
vrm.update(dt)            # spring bone / 材质 / 内建 lookAt
```

## 关键子系统

### 行为（`behavior/`）

优先级从高到低：**拖拽 > 摸头/戳即时反应 > 掉落 > DSH 外部反应 > 自主活动 > idle**。
自主活动是「加权随机 + 最短持续 + 独立冷却 + 上下文系数」的调度器，活动表覆盖待机小动作
（捻筹码/抛硬币/整理衣领/伸懒腰/望呆/敬礼）、走动、坐窗沿、睡觉、跳下、跟随窗口。
`climb`（爬窗沿）保留为 **debug-only**（`schedulable=false`，只能 `triggerActivity('climb')`）。
台词属于**私有内容**，写在 `assets/voicelines.json`（本地维护、已 gitignore，仓库只留读取逻辑，
缺文件时宠物不说话），**禁止自创/改写**。
完整活动表、权重系数与调度口径见 [`behavior/README.md`](src/renderer/src/behavior/README.md)。

### 物理（`physics/`）

- **脚底点 `motion.feet` 是唯一位置权威**，`petRect` 由尺寸反算。
- 坐标系是 overlay 窗口本地 CSS px（x→右，y→下）；重力向下为正。
- 负责左右墙/地面、窗口上沿落地、表面吸附、拖拽平滑跟随、甩出速度估计；
  慢速松手且压在可坐窗沿时走「放置并坐下」而不是自由落体。

### 桌面感知（`desktop/`）

输入是**屏幕全局**逻辑像素的窗口列表，输出是**overlay 本地**坐标（`local = global − overlayOrigin`，
**不要硬编码菜单栏 30/24px**）。表面 id 约定：

```text
win-<windowId>-top|left|right   menubar   dock-bottom|left|right   screen-bottom
```

过滤：`layer===0`、`alpha>0.01`、`height>80`、与当前显示器有正面积交集、排除自身 overlay 进程。
窗口「消失」有 600ms 宽限期去抖（最小化/切 Space 不误判为关闭）；宽限期内表面保留但
`sittable=false`。菜单栏表面虽然存在，但**不作为坐/爬落点**（`top=0` 会渲染出视口）。

### 交互（`interaction/`）

纯逻辑（命中区域、拖拽状态机、摸头圆轨迹检测、注视平滑、右键菜单状态机）与 DOM 层
（`controller.ts` / `menu-view.ts`）严格分离。`PointerGate` 决定何时穿透、何时拦截点击；
拖拽与菜单打开期间强制拦截。

### 渲染（`scene/` + `vrm/`）

- `PetView` 是场景抽象；`scene/pet-scene.ts` 是 legacy PMX 实现，`vrm/pet-scene-vrm.ts` 是主路径。
- VRM 侧包含：humanoid 重定向/clip 播放、表情五层合成（情绪/一次性/表情 clip/程序化眨眼/口型）、
  look-at（含侧身局部化）、foot-lock（脚固定 + hips 对齐 + 换步收敛）、手持道具（水枪）、
  outline（屏幕空间描边）、上下胸折叠、context-loss 恢复。
- 渲染器与相机用正交米制投影；贴图/VRM 均经 `pet-asset://` 读取，走重试式加载器。

## IPC 与配置

`src/shared/ipc.ts` 是冻结契约：**14 个 invoke 通道 + 4 个主→渲染事件**。

| 方向 | 通道 |
|---|---|
| invoke | `pet:get-config`、`pet:set-config`、`pet:screen-info`、`pet:windows`、`pet:set-ignore-mouse`、`pet:window-info`、`pet:accessibility-status`、`pet:open-accessibility-settings`、`pet:move-window`*、`pet:dsh-status`、`pet:notify`*、`pet:show-settings`、`pet:quit`、`pet:set-visible` |
| 事件 | `windows-updated`、`dsh-event`、`config-changed`、`screens-updated` |

`*` 两个通道是**契约占位**：键被 `tests/shared-contract.test.ts` 冻结，但主进程没有 handler、
渲染层没有调用点，调用会 reject `No handler registered`。不要为了「看起来完整」补实现或删键。

配置落盘在 `<userData>/config.json`，形状 `{ version, config }`：

- 读取任何异常都回退 `DEFAULT_CONFIG`，绝不阻塞启动；
- 一切输入交 `sanitizeConfig`（钳制、枚举白名单、未知键丢弃、只读自有属性）；
- 写入是「合并 + 清洗 + 同目录 tmp 文件 `rename` 原子替换」。

主要配置项：`sizePercent`(10–100，默认 50)、`opacity`(0.3–1)、`clickThrough`、`autonomous`、
`autonomousLevel`(low/normal/high)、`mischief`、`dshLink`、`dshCoupling`、`dshBubbleSync`、
`fpsCap`(5–60)、`launchAtLogin`、`position`(corner/free)、`sound`、`modelBackend`、`animBackend`、
`motionSet`。设置页是 `settings.html` 第二入口，字段换算集中在 `settings-model.ts`。

## DSH 双向集成

四个能力：**状态反应**（busy/done/error → 动作 + 官方台词）、**气泡同步**（思考中 → 分段输出
→ 96 字切块 → 停留 → 下一段）、**强耦合**（互保活 / 同生共死）、**窥屏接口预留**（未接线）。

文件契约（`~/.dsh/aventurine-pet/`，桥版本 `4`）：

| 文件 | 写者 | 用途 |
|---|---|---|
| `status.json` | 桥，5s 心跳覆盖写 | `running/agents/lastEventAt/lastType/offline/compat` |
| `control.json` | 桥，仅状态切换时写 | `action: attached/detached`、`dshPid`、`bridgeVersion` |
| `events.jsonl` | 桥，NDJSON 追加 | `task/start · task/end · task/error · session/event`（5MB 轮转，保留两段） |
| `bridge-error.json` | 桥，仅 apply 失败 | `phase/message` 诊断 |
| `install.json` | 激活脚本 | 安装清单 |

判在线规则（消费端必须照此实现）：

```text
online = (offline !== true) && (now >= ts) && (now - ts < 30000)
```

`dsh-event` **只在 `online` 时**广播给渲染层；事件尾随轮询 750ms，尾随时支持文件被轮转/截断后重开。
`control.json` 的 `detached` **不能单独证明 DSH 退出**（HMR 重载也是先 detach 再 attach），
所以强耦合状态机有 1.5s grace：grace 内收到新 `attached` 就取消退出判定。

同生共死（`dsh-lifecycle.ts`）的核心安全语义：

- 桌宠显式退出时，**只有握手健康（`PAIRED`）才先 SIGTERM（≤5s 后 SIGKILL）DSH**；
  `UNPAIRED` / `DEGRADED` / `DISABLED` 一律放行，留「打开 DSH 修桌宠」的活口。
- DSH 显式退出 → 桌宠跟随退出，**绝不重启**；DSH 崩溃 → 冷却重启 ≤2 次（间隔 5s），
  用尽后进入 `DEGRADED` 常驻，不再级联自杀。
- 进入 `PAIRED` 需要四门槛同时满足：进程在跑、心跳新鲜（30s）、`control.json` 最近帧 attached、
  兼容判定通过。陈旧握手不得进 `PAIRED`（否则会误杀/误重启）。
- `~/.dsh/aventurine-pet/safe-mode` 文件存在 = 视同关闭耦合（热生效）；
  `PET_DSH_COUPLING_DISABLE=1` 优先级最高；**未打包的 dev 必须显式 `PET_DSH_COUPLING=1`** 才启用。

激活与回滚（HMR，免重启 DSH）：

```bash
node scripts/activate-dsh-bridge.mjs --pet-app "$PWD/dist/mac-arm64/AventurinePet.app" --dry-run
node scripts/activate-dsh-bridge.mjs --pet-app "$PWD/dist/mac-arm64/AventurinePet.app"
node scripts/activate-dsh-bridge.mjs --rollback   # 恢复 cordis.patch.yml 备份
```

HMR **不会重新求值同一模块路径**（Node ESM 缓存），所以脚本每次生成新的 live 副本
`work/live-bridge/rev-<ts>/`（自动保留最近 5 个），并核对 `control.json.bridgeVersion`。
桥的完整契约、版本护栏、canary 分组见 [`bridge/.../README.md`](bridge/dsh-aventurine-bridge/README.md)，
接线与排障见 [docs/wave3-dsh-integration-design.md](docs/wave3-dsh-integration-design.md) 与
[docs/pet-dsh-coupling-runbook.md](docs/pet-dsh-coupling-runbook.md)。

## 资产与动作管线

所有模型/动作数据都是**私有资产**（不进 git，需要单独发放）。仓库能跑代码与测试，但缺资产时
宠物不可渲染。

```text
assets/
├── vrm/          # 目标 VRM（当前 manifest 指向 aventurine-tpose.vrm）+ canary
├── motions/      # app-manifest.json（40）/ app-catalog.json（181）；mate/ hsr/ adv/
├── expressions/  # 17 条表情 clip + manifest（mate 7 / hsr 10）
├── model/        # PMX 回退模型与 optimized/（20 贴图 + 1 PMX 副本 + manifest）
├── props/        # 手持道具（水枪等）
└── icons/        # 托盘/应用图标（tracked）
```

管线分工：

- **动作**：Unity Humanoid `.anim` 采样烘焙（`scripts/unity-bake/`）、HSR 官方 FBX 全骨重定向
  （`scripts/vrm/motion/retarget-hsr.mjs`）、Adv 动作重定向（`retarget-adv.mjs`）；
  最终由 `build-app-manifest.mjs --check` 收口到运行时清单。
- **表情**：Mate 脸部 `.anim` 解析 + Unity Hermite 采样、HSR 脸骨采样 + OMP/NNLS 解码，
  产出映射到模型自带 VRM 1.0 preset。
- **VRM 转换**：Blender 4.2 工具链（VRM Add-on for Blender / MMD Tools），T-pose 规范化用
  VRMify（纯 Python，外部一次性准备）。详见 [docs/vrm-toolchain.md](docs/vrm-toolchain.md)
  与 [docs/vrm-tpose-repair.md](docs/vrm-tpose-repair.md)。
- 道具提取：3ds Max 全场景 FBX → 单手挂点（`scripts/props/` + `src/renderer/src/vrm/watergun-attach.json`）。

> `src/shared/motion-manifest.json` 是 W0-3 的**空占位**（私有资产不入库），不是缺陷；
> 运行时真正读的是 `assets/motions/app-manifest.json`。

**自己换模型 / 换动作**：不看上面这套「项目自己的」管线，直接按需求看
[模型转换](docs/guide-model-conversion.md)、[动作管线](docs/guide-motion-conversion.md)、
[高频坑](docs/guide-asset-pitfalls.md)。

## 测试与质量门禁

- `pnpm test`：139 个文件，**2779 passed + 16 skipped**（2026-11-11 实测，本机私有资产齐全）。
  跳过项多依赖私有资产 / `tests/tmp` fixtures，干净 clone 会条件跳过（预期）；另有平台/工作树条件
  （如 win32、`IS_MAIN_WORKTREE`）。
- `pnpm typecheck`：`tsconfig.node`（main/preload/shared）+ `tsconfig.web`（renderer/shared），
  两侧都过才算过。
- `pnpm test:coverage`：v8，只统计 `src/**`；阈值 lines/statements/functions 20、branches 15；
  排除两个启动装配入口（`src/main/index.ts`、`src/renderer/src/main.ts`）——它们是
  `SMOKE_TEST` / dev capture 覆盖的，不靠单测。
- 契约回归：`tests/shared-contract.test.ts`（IPC/PetApi 键集合）、`tests/bridge-plugin.test.ts`
  （桥常量 parity + apply 形态 + 失败隔离）。
- 冒烟 `pnpm smoke`：真实窗口里跑 API 探针、VRM 资产加载、pose/foot 误差、gaze、设置窗、
  穿透与几何刷新，最后打印 `SMOKE_OK {json}`。

## 常见改动落点

| 想做的事 | 改哪里 |
|---|---|
| 新增 IPC 能力 | `src/shared/ipc.ts`（通道 + 类型）→ `src/preload/index.ts`（白名单方法）→ `src/main/ipc/<域>.ts`（`ipcMain.handle`）；补契约测试 |
| 新增自主活动 | `renderer/src/behavior/activities.ts`（权重/时长/冷却/需求）+ 对应 `tests/behavior-*.test.ts` |
| 新增动作 clip | 资产目录 + `scripts/vrm/motion/build-app-manifest.mjs --check`；确认 `motionSet` 指向 |
| 新增配置项 | `shared/types.ts` → `shared/config.ts`（默认值 + sanitize）→ `settings/settings-model.ts` → 设置页 DOM |
| 改桌面表面规则 | `renderer/src/desktop/filter.ts` / `geometry.ts` / `transitions.ts`（纯函数，先补测试） |
| 改窗口/多屏行为 | `main/windows/overlay-manager.ts`；packaged 资源映射同步 `electron-builder.yml` + `docs/packaging.md` |
| 改桥文件契约 | `shared/bridge-schema.ts` **与** `bridge/.../lib/constants.js` 同步，parity 测试必须过 |
| 调行为/姿态观感 | `window.__aventurineDebug`（`debugTriggerActivity`、`debugSetPose`、`debugSetGaze`），或 `PET_DEV_CAPTURE_DIR` 走 dev 截图 |

## 已知限制（速览）

完整清单见 [docs/known-issues.md](docs/known-issues.md)，以下是最容易踩到的几条：

- `pet:move-window` / `pet:notify` 是契约占位，没有 handler（见上文 IPC 表）。
- 打包只有 `--mac dir` + ad-hoc 签名；无 Developer ID/公证/dmg，`.app` 不得分发；
  缺 `.icns` 图标，`package:check` 会报 1 个 warning。
- 开机自启在 dist 运行的 ad-hoc app 上会被系统拒绝（默认 `launchAtLogin=false`，无用户可见影响）。
- legacy PMX 动画是静态 import，会进 renderer bundle；未做体积分析（tree-shaking 效果未知）。
- `onScreen` 目前恒 true，窗口关闭靠列表存在性 + 600ms 宽限期判断。
- 窥屏互动只有类型和 fail-closed 桩：默认关闭、零采集、零 TCC，设置页不显示。
- 桥的 `status.json` 是单写者假设（多 DSH 实例同写 = last-writer-wins）。

## 文档导航

**计划与契约**

- [PLAN.md](PLAN.md)（实施计划 / Wave 0–3）
- [docs/vrm-contract.md](docs/vrm-contract.md)（W0-3 冻结契约）、[docs/reuse-audit.md](docs/reuse-audit.md)（v1 复用审计）
- [docs/wave2-vrm-runtime-design.md](docs/wave2-vrm-runtime-design.md)、[docs/wave3-dsh-integration-design.md](docs/wave3-dsh-integration-design.md)

**验收与基线**

- [docs/wave0-report.md](docs/wave0-report.md)、[docs/wave2-acceptance.md](docs/wave2-acceptance.md)、
  [docs/wave3-acceptance.md](docs/wave3-acceptance.md)（含激活/回滚矩阵）
- [docs/wave3-packaging-report-2026-11-11.md](docs/wave3-packaging-report-2026-11-11.md)、
  [docs/wave3-e2e-report-2026-11-11.md](docs/wave3-e2e-report-2026-11-11.md)、
  [docs/wave3-perf-baseline-2026-11-11.md](docs/wave3-perf-baseline-2026-11-11.md)
- Wave 1.5：[Unity 烘焙动作](docs/wave15-report.md) / [手指补全](docs/wave15-fingers-report.md)、
  [HSR 官方动作](docs/vrm-motion-hsr.md)、[Adv 动作](docs/wave4-adv-report.md)

**素材与格式转换（不会建模先看）**

- 上手攻略：[素材去哪找](docs/guide-asset-sourcing.md) · [三种模型转 VRM](docs/guide-model-conversion.md) ·
  [四条动作管线](docs/guide-motion-conversion.md) · [高频坑与 AI 模板](docs/guide-asset-pitfalls.md)
- 调研底稿：[motion-assets](docs/research/motion-assets.md)、[mocap-options](docs/research/mocap-options.md)、
  [motion-free-pipeline](docs/research/motion-free-pipeline.md)、[wave1-15-pitfalls](docs/research/wave1-15-pitfalls.md)
- 转换细节：[max-anim-conversion-plan](docs/max-anim-conversion-plan.md)、
  [max-windows-routes](docs/research/max-windows-routes.md)、[user-3dsmax-export-guide](docs/user-3dsmax-export-guide.md)、
  [unity-bake-report](docs/unity-bake-report.md)、[女体→男体关节](docs/research/mate-female-to-male-joint-plan-2026-11-11.md)、
  [比例重定向](docs/research/proportion-retarget-prototype-2026-11-11.md)、
  [男体动作微调](docs/research/wave15-male-motion-tune.md)、[水枪来源](docs/research/watergun-asset-sourcing.md)

**资产管线**

- [docs/vrm-toolchain.md](docs/vrm-toolchain.md)、[docs/vrm-tpose-repair.md](docs/vrm-tpose-repair.md)、
  [docs/expression-mapping.md](docs/expression-mapping.md)、[docs/anim-strategy.md](docs/anim-strategy.md)
- [scripts/vrm/motion/README.md](scripts/vrm/motion/README.md)

**运行与运维**

- [docs/packaging.md](docs/packaging.md)、[docs/pet-asset-protocol.md](docs/pet-asset-protocol.md)、
  [docs/pet-dsh-coupling-runbook.md](docs/pet-dsh-coupling-runbook.md)、[docs/known-issues.md](docs/known-issues.md)
- [docs/peek-interface.md](docs/peek-interface.md)（预留接口清单）

**模块级说明**（就在代码旁边）

- [behavior](src/renderer/src/behavior/README.md)、[physics](src/renderer/src/physics/README.md)、
  [desktop](src/renderer/src/desktop/README.md)、[interaction](src/renderer/src/interaction/README.md)、
  [reactions](src/renderer/src/reactions/README.md)、[animation](src/renderer/src/animation/README.md)、
  [native/winlist](native/winlist/README.md)、[bridge](bridge/dsh-aventurine-bridge/README.md)

**设计与研究归档**：[docs/research/](docs/research/)、[docs/archive/](docs/archive/)（含 v1 PLAN 与历史 README）

## 项目记录

本 README 取代了此前按 Wave 累积的进度型 README，原文完整保留在
[`docs/archive/README-2026-11-11-wave-log.md`](docs/archive/README-2026-11-11-wave-log.md)，
作为 2026-11-07 ~ 2026-11-11 的开发记录与验收索引（含各 Wave 的测试基线演进、打包现状、
激活步骤与遗留待办）。

## 参考项目与致谢

| 项目 | 用途 | 说明 |
|---|---|---|
| [Mate-Engine](https://github.com/shinyflvre/Mate-Engine) | 动画清单、姿态与状态划分的**参考** | **未复制其代码或动画资产**；其动画资产版权归 Shiny，按其许可证个人非商业使用需署名、不得单独再分发 |
| [reze-rig](https://github.com/AmyangXYZ/reze-rig)（MIT） | v1 的 VMD 路线对照 | 仅对照，Phase 3 起未使用 |
| [dsh-blender-plugin](https://github.com/sixtysevenlf/dsh-blender-plugin) | Blender 自动化工具参考 | 按需参考，未复制 |
| [Reze MiPo](https://mipo.reze.one)（GPL-3.0） | 摄像头 / 视频动捕（可选外部工具） | 代码未引入本仓库，仅文档指引自行使用 |
| [VRMify](https://github.com/JiGuang283/VRMify) | PMX → VRM 转换工具 | 外部工具，未打包 |

以上均为「参考 / 外部工具」关系，其许可证与本仓库的 MIT **相互独立**，不构成对本仓库代码的再授权。

## 许可证

代码本体以 [MIT](LICENSE) 发布。仓库内**不包含**模型、动作、台词等第三方版权资产，
这些资产的使用需自行取得授权（见「红线」一节），不在 MIT 覆盖范围内。
