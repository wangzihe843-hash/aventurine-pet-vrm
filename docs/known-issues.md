# 已知问题（已接受 / 延后）

> 更新：2026-11-11。本文只记录**复核确认、本轮明确不修**的事项；不写未验证的推测。
> 修复状态变化时请同步删除/更新对应条目（审查原文见 `docs/code-review-2026-11-10.md`）。

## 打包与分发

### R-07 打包链路已实现（dir + ad-hoc 签名）；Developer ID/公证/图标仍缺（Wave 3 / V9，2026-11-11 更新）

- 现状：`electron-builder.yml` + `build/after-pack-adhoc-sign.cjs`（afterPack ad-hoc 签名）+
  `build/entitlements.mac.plist` + `scripts/package-check.mjs` 已落地；
  本机 `pnpm package:dir` 产出 `dist/mac-arm64/AventurinePet.app`（601 MB，**ad-hoc 签名**：
  `Signature=adhoc`、`Identifier=com.aventurine.pet`、`Sealed Resources version=2`），
  `pnpm package:check` **35 passed / 1 warning / 0 failed**（唯一 warning：缺 `.icns` 应用图标）；
  本机 0 个有效 Developer ID codesigning identity。
- 影响：`.app` **仅限本机自用**；ad-hoc 不是 Developer ID → 换机器/分发仍会被 Gatekeeper 拦截；
  无 dmg/zip 分发目标；应用图标回退 Electron 默认图标。
- 处理：正式分发前需 Developer ID Application 证书 + hardenedRuntime + 公证，并**移除 afterPack ad-hoc 钩子**
  （避免覆盖正式签名）；清单/命令见 [packaging.md](packaging.md) §2.1/§2.5/§2.6；交付报告见
  [wave3-packaging-report-2026-11-11.md](wave3-packaging-report-2026-11-11.md)。

### 打包版行为：隔离 E2E 已通过，仅剩目视与登录项

- 现状：`pnpm package:check`（bundle id/app.asar/Resources/helper 架构）+ `ELECTRON_RUN_AS_NODE` 加载探针通过；
  verifier 打包版冷启动 E2E **23/23 PASS**（资源/VRM/overlay/气泡/winlist spawn/单实例）；
  真实 `.app` 已被真机 DSH 激活用于拉起桌宠（2026-11-11 12:33）。
- 仍待：托盘图标/设置窗目视、开机自启登录项（dist 运行的 ad-hoc app 实测 `Operation not permitted`，
  wrapper 仍记 `applied:true`；默认 `launchAtLogin=false`，无用户可见影响）。
- 处理：见 [packaging.md](packaging.md) §2.5/§4 与 [wave3-acceptance.md](wave3-acceptance.md) §2。

## 渲染 / 性能

### R-18 legacy 静态 import 使 renderer bundle 变大（待测量）

- 现状：`src/renderer/src/main.ts` 顶部静态 `import { createHybridAnimator } from './animation'`，
  legacy PMX 动画模块图会进入 renderer bundle；实际只在 `animBackend === 'legacy-pmx'` 分支实例化。
- 未验证：tree-shaking 是否已把未使用部分摇掉、实际体积增量多少，需 bundle analyzer。
- 处理：本轮不改（动态 import 改造风险大于收益）；测出体积后再决定。
- 2026-11-11（Wave 3）更新：legacy 按 D9 **继续保留**（`legacy-pmx` 回退可用）；A6 的
  `scripts/vrm/measure-runtime.mjs` 测的是运行时 fps/RSS/CPU，**不**包含 bundle 体积分析，本条仍未闭环。

## IPC / 系统集成

### R-21 `moveWindow` / `notify` 为 Wave 3 占位

- 现状：preload 暴露 `window.api.moveWindow` / `window.api.notify`，shared 契约冻结了对应
  channel，但 main 进程没有注册 handler；renderer 当前无调用点。
- 影响：若未来 renderer 调用会 reject `No handler registered`。
- 处理：契约保留（Wave 3 本轮聚焦 DSH 双向集成/V9，**未**实现 C1/C3）；实现前不要新增调用点。

### R-25 通知授权状态无法查询

- 现状：Electron 44 没有 `Notification.getSettings()`，`systemPreferences` 也没有通知授权查询
  API；`pet:accessibility-status` 只能返回 `notifications: 'unknown' | 'unsupported'`。
- 影响：设置面板无法显示真实通知授权状态；这是平台 API 限制，不是本仓漏实现。
- 处理：保留 `'unknown'` 并在调用处注释；不猜测/伪造授权状态。

### R-05 残余：`unresponsive` 恢复对「真卡死」可能无效（待真机验证）

- 现状：`windows/crash-recovery.ts` 对 `unresponsive` 仅调用 `webContents.reload()`；Electron 44
  对真正 hang 的 renderer 建议先 `forcefullyCrashRenderer()` 再 reload 才能在新进程恢复。
- 未改原因：force crash 在无 RenderWidgetHostView（隐藏窗口）时是 no-op；可能连带崩溃共享
  renderer 的其它窗口；且 `render-process-gone` 是异步事件，与 5min 冷却 / 10min 限流交互必须
  真机注入 hang 验证。本轮单测无法证明收益大于风险，故不改。
- 后续方案：`forcefullyCrashRenderer()` → 统一 `render-process-gone` 恢复路径（限流只计一次），
  先真机验证再改。`render-process-gone` / GPU 崩溃两条主恢复路径已工作。

### A-02 `PET_SMOKE_TEST` 在生产态可达（接受）

- 现状：`SMOKE_TEST = process.env['PET_SMOKE_TEST'] === '1'` 无 `is.dev` / `app.isPackaged` 门控；
  打包版若被注入该环境变量也会进入冒烟模式（加载 watchdog / 内存内 capturePage / 临时改 config
  后恢复 / 完成或失败即 `app.exit`）。
- 为何接受：① 需要同用户控制启动环境（同用户本就可执行任意代码），非跨权限攻击面；② 冒烟模式
  不向任意路径写文件（`writeFileSync` 全在 dev-capture 内，R-06 已用 `is.dev` 封死该链路）；③
  保留可达是为了未来在真实打包 `.app` 上做端到端冒烟验收。
- 关于 `is.dev` 门控：`pnpm smoke` 与 `pnpm smoke:file`（`electron .` 未打包，`is.dev=true`）
  在 is.dev 门控下仍可运行，**并不依赖**「生产态可达」；若后续收紧可改为
  `is.dev || PET_PACKAGED_SMOKE=1`（显式二次确认后才进入冒烟模式）。

### R-23 残余：renderer 仍可发动 ws/wss 出站

- 现状：打包态 `onBeforeRequest` 只拦 `http(s)`；overlay CSP 的 `connect-src` 允许 `ws:`。
  真实利用需要 renderer 已被注入，属纵深防御残余项。
- 处理：打包落地时可将 `ws://*/*`、`wss://*/*` 加入 filter 或收紧 CSP；本轮记录不修。

## 桥 / 文件权限

### bridge 文件权限仅在创建时设置

- 现状：`events.jsonl` 追加写时 `mode: 0o600`、桥目录 `mkdirSync(..., mode: 0o700)`；
  已存在的文件/目录不强制 `chmod`（避免改动宿主既有权限）。
- 兜底：父目录 0700，且威胁模型是同用户/同权限边界。
- 处理：接受；不追加运行期 chmod。

## 构建 / 工具链

### C-03 工具链默认路径硬编码 `/Volumes/...`（可移植性）

- 现状：部分安装/导出脚本默认路径写死本机外置盘位置（如 `TOOLS_ROOT`、Blender/Unity 路径），
  换机器需用环境变量覆盖；脚本已支持 override，属开发机便利默认值。
- 处理：记录不修；打包/CI 落地时统一改为可配置路径。

### dev 路径只接了一半（C-02 / R-11）

- 现状：`predev` 只构建 native helper（`scripts/build-native.mjs`），**不做私有资产 check**；
  `predev:worktree` 已补（与 `predev` 相同），但干净 worktree 仍只保证 helper 存在。
  无 `assets/model/optimized/` 时 `pnpm dev` 不会像 `pnpm build` 那样给出资产缺失指引，
  仍可能启动后白屏/加载失败。
- 处理：dev 保持轻量（改 UI 代码不需要私有资产）；资产完整性校验以 `pnpm build` /
  `pnpm assets:prepare --check` 为准。`C-02/R-11` 的「干净 clone 不再静默降级/白屏」只对
  build 路径成立。

### `native:check` 不校验「stamp 与源码是否同步」

- 现状：`--check` 只校验产物本身（架构/minos/可执行/`--json`），不比对源码/stamp；单独把它
  当 CI 门禁时，源码改了未重编仍会绿。正常流程 `predev`/`prebuild` 会先构建，无影响。
- 处理：记录；CI 需要时先跑 `node scripts/build-native.mjs`（幂等）再 `--check`。

## 测试

### 条件跳过（`skipIf`）依赖私有资产 / `tests/tmp`

- 现状：17 处 `.skipIf(...)`（9 处 `describe.skipIf` + 8 处 `it.skipIf`），大部分依赖私有
  模型/VMD/fixtures 或本机私有目录（干净 clone 中会 skipped，属预期）；另有平台/工作树条件
  （如 win32、`IS_MAIN_WORKTREE`），在对应环境满足时照常运行。不代表功能回退。
- 处理：README 已说明；不把跳过当失败，也不为凑数删测试。

### preload 白名单无独立单测（D-04）

- 现状：preload 的 14 个 invoke + 4 个 subscribe 白名单没有专门单测，当前由构建/类型与
  端到端 smoke 间接覆盖。
- 处理：本轮仅记录；后续补测试时避免启动 Electron，用 fake `contextBridge`/`ipcRenderer` 单测。

### `src/main/index.ts` 接线无集成测试

- 现状：R-05 崩溃/GPU 恢复监听挂载、R-06 dev-capture `is.dev` 门控、R-23 网络 guard 的
  `isPackaged` 接线都只测了纯模块（crash-recovery / network-guard / navigation-guard），
  `index.ts` 的 Electron 事件接线本身没有自动化测试。
- 影响：接线退化只能靠静态审查或真机 smoke 发现；纯策略逻辑已有 30+ 条单测兜底。
- 处理：记录；后续可把判定抽成可 import 的纯函数（如 `shouldStartDevCapture`）再补真值表测试，
  避免为测试启动完整 Electron。

### R-12 残余：avatar-loader 加载成功路径仍未单测

- 现状：`tests/avatar-loader.test.ts`（13 条）覆盖 `parseVrmGlb` 失败/修复重试/统计与 HTTP 早退；
  `loadVrmAvatar` 主体里的 VRM0 `rotateVRM0`、humanoid 必需骨缺失、`missingTextures` 计数分支
  仍无单测（`avatar-loader.ts` 行覆盖约 30%）。
- 处理：记录；后续可导出 `buildVrmAvatar` 用 fake vrm/gltf 直测（无需私有 GLB，约 0.5 天）。

### R-32 coverage 口径与阈值偏弱

- 现状：coverage 排除两个 `main.ts` 入口（共约 src 的 9.4%，其中 `src/main/index.ts` 并非纯入口，
  含 boot/dev-capture/崩溃恢复/IPC 装配）；阈值 20/20/15/20 远低于实测 76/73/75/78，
  防回归意义有限；preload/`pet-scene-vrm.ts` 等关键文件仍 0% 或低覆盖。
- 处理：记录；后续给关键文件加 per-file 阈值或补集成测试，再逐步提高全局阈值。


## 行为 / 动画（2026-11-11 修复后的接受项）

> 关联报告：[fix-report-2026-11-11-ledge-rest-and-leg-ik.md](fix-report-2026-11-11-ledge-rest-and-leg-ik.md)。

### 窗沿卧姿期间的交互/DSH 反应被压成坐姿（产品取舍）

- 现状：可坐窗口上沿被强制 recumbent（只 sit/趴/躺）后，摸头/戳/DSH 反应的**动画 mood** 被安全网压成
  `sit`，窗沿上只显示气泡/表情，不再做站立反应动作。
- 为何接受：用户设计约束「窗沿上只趴/坐/躺」优先；若要保留窗沿反应，需要坐姿版反应素材（当前没有）。
- 处理：记录；后续有坐姿反应素材时可给安全网加白名单。

### foot-lock 骨盆对齐会让身体相对脚平移（A → v2 候选 g）

- 现状：跨 idle 变体站姿差由 hips 偏移吸收（非累积），身体视觉中心因此相对物理脚位平移；
  **2026-11-11 v2** 起由 3-DOF 距离保持解（候选 g）取代旧 A，实测 9 条 idle 水平偏移
  ≤0.093m（旧 A 0–0.18m）、垂直 δy ∈ [−0.02,+0.01]m、切换期身体速度 ≤46px/s（旧 A ≤56px/s）。
- **2026-11-11 v3（stance replant）后**：换 idle clip 时 pin 会重锚到新作者站姿，稳态 g 的
  hipShift 回到「micro 相位差」量级（离线 6 段轮换实测 19–45mm；锚点 clip hsr-idle 本身 21.3mm；
  旧行为 adv-think 57mm/common 72mm）。20mm 的 idle 水平预算尚未实现（需改 g/micro 语义，本任务不动）。
- **2026-11-11 v3 Lead 复核补充**：3-DOF 解已改为从 0 出发（不用 warm start），消除「沿近相切
  约束流形被 micro 逐帧推着漂移」（实测旧写法站稳后 hipShift 从 0 漂到 65mm）；settle 0.4s +
  投影 0.5s 渐入，换步结束单帧身体跳 8.7px→1.7px。**仍余**：idle 稳态 hipShift 随 micro 缓慢摆动
  （19–45mm），开始走路（foot-lock 进入 `!eligible`）时该偏移在 τ=0.2s 内归零 → 起步瞬间
  ≤4.5cm（14px@540/7px@270）的身体侧移。彻底消除需 R3′（micro 的 hips 旋转改 spine/chest，
  见 tests/tmp/inv-leg2/REPORT.md §7）或把 g 的 idle 水平预算降到 2–3cm（需重跑膝角验收）。
  用户 2026-11-11 15:1x 报「走路会漂移」与此相关，也可能来自当时运行的 13:28 中间构建
  （未含 14:32 最终修复），待用户重启后确认。
- **2026-11-11 已修 L2/M-3**：`hipShift` 经 `PetView.getHipShiftScreenXPx()` 换算成屏幕 px，
  `currentPointerRect`（hit/pat/气泡/pointerGate）已横向同步；实机最大误差 0.04px（idle）/≤2.1px（窗沿过渡）。
  v2 保持 `hipShiftXM/ZM` 语义不变（只新增 `hipShiftYM` 调试字段），pointer-rect 不回归。
- 处理：记录；若要进一步消掉身体侧移可叠加数据侧站姿归一化（task-3 bake，见
  [fix-report-2026-11-11-standing-leg-data-bake.md](fix-report-2026-11-11-standing-leg-data-bake.md)），
  或按 web research §⑤ 把 g 的 idle 水平预算降到 2–3cm（需重跑膝角/脚位验收）。

### 换 idle 姿势脚不动 / 各站姿被抹平 → **2026-11-11 v3 已修**（stance replant）

- 旧现状（已解决）：`pinPosition` 跨 clip 永久保持 + crossfade 冻结接触；普通 idle 作者踝抬升
  ≤0.4mm、水平速度≈0，永远到不了 2cm/0.9m/s 释放阈值 → 脚位/站姿宽从当天第一次锚定起恒定不变；
  g 只能把差异吸收成腿方向偏转 + 身体侧移。
- **v3 修复**：animator 把 `clipId` 传给 foot-lock；fade 结束第一帧一次性采样新 clip 作者踝位/朝向，
  按水平距离降序**单脚错峰抬脚弧线**（`T=clamp(d/0.45,0.30,0.45)s`、`gap=0.08s`、水平只在
  `u∈[0.12,0.88]`、`lift=clamp(0.15d,0.012,0.030)·sin(πu)`）把 pin 搬到新站姿；`d<12mm` 走
  0.15s 迷你混合（不抬脚）。重踏期 contact 冻结、g 让位（δ 按进度衰减到 0），落地后 δ=0 保持
  0.2s 再恢复；新 clip 中途再换从当前 pin 重规划；进入 walk/sit/drag/pat 立即结束重踏走原释放路径。
- 离线实测（真实 VRM/idle 轮换 6 段，fade 0.9/hold 3.2）：稳态脚位 vs 作者最大均值误差
  **173.4mm → 17.4mm**、站姿宽误差 **36.5mm → 1.3mm**（旧行为 5 段恒 31.2cm）；切换接地滑移
  5.7px@540、单帧最大 9.15px、同时离地 0（非表演 idle）、contact 抖动/NaN 0。
- 回滚：`poseReplant:false`（完全旧行为）或 `stanceAlignMode:'mean'`（旧 A + replant 自动关闭）。
- 仍保留：表演型 `hsr-idleShow` 右脚作者抬 4.2cm → 释放跟随作者、左脚重踏；稳态宽 33.3cm vs
  作者 26.8cm（旧 50.1cm），见下条 R1。
- 关联报告：[fix-report-2026-11-11-footlock-stance-replant.md](fix-report-2026-11-11-footlock-stance-replant.md)。

### 方案 A 固有残差 → **2026-11-11 v2 已修**（候选 g + IK margin）

- 旧现状（已解决）：单一 hips 均值平移无法同时满足双脚「髋→踝距离 = 作者距离」，近伸直腿对距离敏感
  （1mm≈2–3.6°）→ idle 膝屈曲角系统性偏弯 8–20°（其中 micro×IK 约 62%、跨变体 A 残差约 38%）。
- **2026-11-11 v2 已修**：foot-lock 改用「3-DOF 骨盆距离保持解」——每帧解 hips 偏移 δ 使每条 pinned 腿
  `|hip+δ−pin| = 作者本帧髋→踝距离`，IK 膝角自动回到作者；平滑后把 δ 投影回约束流形消掉 τ 滞后造成的
  近伸直膝尖峰；`solveKneePosition` 腿长钳制余量 1mm→0.2mm（作者数据最伸直帧余量仅 0.135mm）。
  实测（真实 VRM/clip）：idle 9 条稳态 Δ膝 0.00–0.41°（旧 A 4.2–16.9°）、逐帧 max ≤0.74°、
  脚零滑（footError ≤0.0001m/冻结点漂移 ≤0.02px）、残差 <0.5mm。
- **仍保留 R1**：`hsr-idleShow` 作者右脚有意抬升 4.1cm，抬脚释放阈值 1.2/2.0cm（进入/退出）下该脚正常释放；
  v2 未改 R1 阈值与语义。
- 未修（数据侧 D 类）：作者数据本身「静态站立却屈膝」6–14°（idle 轮换池 7 条、一次性可见池约 7 条），
  运行时只能保证「腿形=作者」；由 task-3 数据 bake 处理（见
  [fix-report-2026-11-11-standing-leg-data-bake.md](fix-report-2026-11-11-standing-leg-data-bake.md)）。
- 回滚：`new VrmFootLock(avatar, { stanceAlignMode: 'mean' })` 回到旧 A 行为（v1 单测保留覆盖）。
- 关联报告：[fix-report-2026-11-11-leg-bend-v2.md](fix-report-2026-11-11-leg-bend-v2.md)、
  [fix-report-2026-11-11-limits-r1-l2.md](fix-report-2026-11-11-limits-r1-l2.md)。

### idle 作者抬脚释放阈值（R1，2026-11-11 起）

- 现状：contact 抬脚释放阈值改为 进入 1.2cm / 退出 2.0cm（原 3/5cm）。作者动画中**有意抬脚 ≥2cm** 的
  idle（如 `hsr-idleShow` 右脚 4.1cm）不再被 IK 钉回地面，脚跟随作者动画抬起，落地后按当时姿态重新锚定。
- 影响：≥2cm 的有意抬脚会有一次「抬脚→落地重锚」的脚位落点变化（本来就是这个动画的意图，不是滑步）；
  <2cm 的普通站姿/微动不受影响。可用 `VrmFootLockOptions.contactEnterLiftM/contactExitLiftM` 显式传旧值回退。
- **v3 replant 交互**：换到表演型 idle 时，作者抬着的脚不重锚（不能把 pin 搬到空中），按 R1 释放跟随作者；
  另一只落地脚仍重踏到作者站姿。实测 `hsr-idleShow` 稳态宽 33.3cm vs 作者 26.8cm（旧 50.1cm），
  仍偏宽 6.5cm——表演型 clip 的释放脚本不强行拉回，留给后续按标签关闭/软锚点处理。
- 处理：记录；若实机观感需要更保守，改回 3/5cm 并同步 `tests/vrm-foot-lock.test.ts`。

### pat 动态反应不做脚固定（v2 新增禁锁）

- 现状：**2026-11-11 v2 起 `pat` 加入 `FOOT_LOCK_DISABLED_MOODS`**。pat 是动态反应 clip：约 19% 的
  「脚短暂触地」帧会被重锚，随后作者把脚带远 → IK 把腿拉直（`mate-shyPoint` 左膝在现状/旧 g 下
  +19.8°/+24.3°，比作者还直）；动态反应本就不该锁脚。
- 实测（dev-capture）：pat 3 条全程 `pinned=false`、运行时膝角=作者（Δ0.00°）、无「直腿 pop」。
- 处理：记录；若后续有「站着不动的拍头反应」素材，可单独白名单启用。

### idle 一次性小动作（manual clip）不做脚固定

- 现状：`IdleOneShotFidget`/DSH 工作小动作等一次性 clip 播放期间 foot-lock 不参与（既有设计），结束时
  重锁可能带来 ~20–60px 脚位位移；实机 idle 验收已按 manual 段排除该项。
- 处理：记录；如要消除，可对「脚不动的 one-shot」白名单启用 foot-lock（需逐 clip 标注/验收）。

### 窗沿坐姿风格轮换仅限窗沿适配素材

- 现状：高窗候选固定 `mate-windowLay8`（headroom≥0.60×身高+8 时可加 `lie(mate-sitWindow)`）；矮窗固定标准 sit；
  用户 50%@top=324 场景**不轮换**。标准 sit 的 playlist 含 `mate-suwari3` 等 floor-sit 素材，放上窗沿会像
  「盘腿悬在窗口上」，因此不进高窗候选；轮换切换瞬间的身体横移（53–64px）也随之消失（实测相邻帧 3px）。
- 处理：记录；若要恢复更丰富轮换，需先排除/替换 floor-sit 素材或重新验收 `windowLay9/10`。

### 窗沿受控 dropDown 的概率/间隔

- 现状：窗沿连续完成 ≥2 段 recumbent 后，每段结束以 P=0.4 选 `dropDown` 自主跳下（实测均值 ~94.5s）；
  `autonomous=false` 时永不跳。常量在 `behavior-director.ts`（`WINDOW_TOP_REST_EXIT_*`）。
- 处理：产品可调参数；如需「永不跳下/更频繁跳下」改常量并同步测试即可（当前按 Lead 决策实现）。

### D6a 段 id 残留路径

- 现状：可坐窗沿不变量用 `top±2px` + 横向覆盖脚底做 id 抖动 rematch；若 `motion.surfaceId` 仍残留旧 id，
  既有 `updateTrackedSupport` 会走 fall 兜底（视觉非站立，落地后恢复）。
- 处理：记录；后续可让 B2 快照 id 与 motion 一致，或在该兜底加同样的 top rematch。

## Wave 3（2026-11-11）已知限制（已接受 / 待后续）

> 完整验收矩阵与激活/回滚说明见 [wave3-acceptance.md](wave3-acceptance.md)；打包相关见
> [packaging.md](packaging.md) §4 与 [wave3-packaging-report-2026-11-11.md](wave3-packaging-report-2026-11-11.md)。

### W3-L1 打包产物仅 ad-hoc 签名、无应用图标、601 MB、无 dmg/zip

- 现状：`--mac dir` + afterPack ad-hoc 签名（`codesign --sign -`），仅本机自用；
  `Contents/Resources/assets` 占 ~265 MB（含 VRM 历史副本与一个 `.zip`）、Frameworks ~317 MB；
  应用图标回退 Electron 默认图标。
- 处理：接受（本 Wave 目标就是本机自用）；Developer ID/公证/图标/分发属后续；详见 R-07 与 packaging.md §4。

### W3-L2 HMR 激活的两个边界

- **HMR `root` 不 watch 本仓库源码**：修改 `bridge/dsh-aventurine-bridge/lib/index.js` 后，需要再触发一次
  profile patch 重载（或下次重启 DSH）才生效——不能指望改代码后立刻热更。
- **桥入口以仓库绝对路径注册**：移动/删除仓库目录、或删除 `dist/*.app` 会使激活配置失效，需要重新激活；
  回滚 = 恢复 `cordis.patch.yml.bak-wave3-*` 或删除 insert 行（HMR detach）。

### W3-L3 强耦合的 dev gating 与安全阀

- 未打包（dev）构建：`dshCoupling` 必须叠加 `PET_DSH_COUPLING=1` 才生效（防开发调试误杀真实 DSH）；
  打包版按配置默认生效。
- `PET_DSH_COUPLING_DISABLE=1` 在任何构建下强制关闭；`PET_DSH_TEST_HOOKS=1` 的 fake 进程/拉起命令
  **仅 dev 生效**（打包版忽略，防伪造环境变量执行任意命令）。
- 用户已确认选择「强耦合」；误杀风险由 1.5s grace、`quitReason`/`dshTerminatedByPet` 防环与日志缓解。

### W3-L4 气泡的已知行为取舍

- **多 session**：去重 key/文本预算含 `sessionId`（内容不串），但队列按**事件到达顺序**全局播放；
  多个 agent/子代理同时产出时，气泡顺序是到达序而非会话优先级。
- **单 turn 超长回复**：切块 96 字 + 队列上限 8（溢出丢最旧）+ 单 turn 4000 字预算 → 一次超长回复
  实际只播最后约 8 段；`task/error` 清空未播文本（错误交给反应层表演）。
- 关闭 `dshBubbleSync` 后恢复 Wave 2 行为（仅动作反应台词/表情），已显示文本自然过期。

### W3-L5 canary 的覆盖边界

- 默认 `pnpm dsh:canary` 用**本地 mock SSE**（127.0.0.1，无外网/费用）覆盖成功回合的
  `assistant/message.text` + `control.json attached→detached`；`--online`（真实模型成功回合）
  **本轮未跑**，mock 不能完全代表真实 provider 的流式边界/错误码。
- DSH 跨 minor 升级后必须重跑 canary；`engines.dsh` 只挡版本号，不保证事件形状不变（升级 runbook 见 bridge README）。

### W3-L6 桥文件会包含 assistant 输出正文（隐私边界已定）

- `payload.text` 只来自 **assistant 输出**（模型回复，UI 本就会展示），截断 8000 字符；**不写** user 输入、
  reasoning/thinking 正文、tool 参数/结果正文、system 提示。桥目录 0700 / 文件 0600。
- 桥目录对同用户进程可读（与 DSH 自身会话日志同权限边界），文档已明示；如需更严格隔离属后续设计。

### W3-L7 control.json 不能单独证明 DSH 退出

- `attached`/`detached` 只描述**桥实例**状态；崩溃/SIGKILL 时 disposer 不跑，`control.json` 可能停留在
  `attached`。因此桌宠侧必须组合 status 心跳 TTL + 进程探测判定（已实现）；不要 single-source 到 control。

### W3-L8 打包版忽略 `PET_PROFILE`，测试隔离受限

- `applyDevProfile()` 在打包版直接 return（`PET_PROFILE` 不生效）；`HOME` 覆盖在 macOS 上不保证改变
  `app.getPath('userData')`（系统 home 由用户账户决定）。打包版实机 E2E 会读写真实默认
  `~/Library/Application Support/aventurine-pet`（主要是 `logs/main.log`）；verifier 用
  `PET_DSH_COUPLING_DISABLE=1` + 临时 `PET_DSH_DIR` 控制风险。严格隔离需后续支持
  `--user-data-dir` 或打包版 E2E profile env（`src/main/index.ts` 属 Lead-only）。
- 参考：[wave3-e2e-report-2026-11-11.md](wave3-e2e-report-2026-11-11.md) §2.4/§4。

### W3-L9 性能/隔离 E2E 已落地（原「待产出」条目关闭）

- 已产出：[wave3-perf-baseline-2026-11-11.md](wave3-perf-baseline-2026-11-11.md)（idle fps 28.1–28.3@cap30、
  drawCalls 39、tri 51829、整树 RSS 964–993 MB、CPU 14.7%、启动 ready 0.78–0.80 s）与
  [wave3-e2e-report-2026-11-11.md](wave3-e2e-report-2026-11-11.md)（桥/气泡/强耦合/打包版/smoke 全部 PASS；
  激活脚本缺陷已修复，见 [wave3-acceptance.md](wave3-acceptance.md) §2.2）。
- 保留限制：性能数据来自非打包 `electron .` 构建且机器有并行负载；`.app` 上的复测未做（脚本可直接复用）。

### W3-L10 无 Developer ID / 公证：仅本机 ad-hoc 签名

- 现状：本机 0 个有效 Developer ID；完全未签名 `.app` 被 macOS 27 AMFI 拒绝（no CMS blob，
  表现为拉起即退），因此打包加了 `build/after-pack-adhoc-sign.cjs` 做 `codesign --sign -`（ad-hoc）。
- 边界：ad-hoc 只让 app **本机可启动**；不是 Developer ID、不被 Gatekeeper 信任、**不可分发/换机器**；
  dmg/zip/公证未配置。正式分发需证书 + hardenedRuntime + notarize，并移除 afterPack ad-hoc 钩子。
- 参考：[packaging.md](packaging.md) §2.6/§4。

### W3-L11 HMR 同路径不热更 → 激活使用 `work/live-bridge/<rev>` 副本

- 现状：HMR 只比较 profile 目录/ linked 包，**不 watch 仓库源码**；Node ESM 按 URL 缓存 →
  同一 Host 进程内，改 `bridge/lib/index.js` 后无论 recompose 还是 remove→re-add 同一路径，都会继续执行旧代码
  （隔离实测，见 [wave3-hmr-activation-verification-2026-11-11.md](wave3-hmr-activation-verification-2026-11-11.md)）。
  因此激活脚本每次生成**新路径 live 副本**（`work/live-bridge/rev-<ts>/`，含 index/constants/package.json，
  gitignored，自动保留最近 5 个 rev），patch 的 `name` 指向该副本；副本 `BRIDGE_PLUGIN_VERSION` 打印，
  激活后必须核对 `control.json.bridgeVersion`。
- 维护边界：**升级 = `--rollback` 后重新激活（自动新 rev）**，不要同 id 改 name / 同路径 recompose；
  移动仓库或删除 `work/live-bridge/<rev>` 会导致 DSH 下次启动时该插件行入口不存在（行加载失败，需回滚或重新激活）；
  `work/` 内旧 rev 可清理但当前激活引用的 rev 必须保留。
- 参考：[wave3-acceptance.md](wave3-acceptance.md) §3；[wave3-hmr-activation-verification](wave3-hmr-activation-verification-2026-11-11.md) §5/§8。

### W3-L12 `ELECTRON_RUN_AS_NODE=1` 继承：direct-exec 方案与 fallback 缺口

- 现状：DSH Host 环境自带 `ELECTRON_RUN_AS_NODE=1`；旧的 `open` 拉起会让桌宠继承该变量而以 Node 模式退出。
  桥 v2 改为**直接 spawn `.app/Contents/MacOS/<CFBundleExecutable>`** 并在子进程 env 中清洗
  `ELECTRON_RUN_AS_NODE`（真机实测：桌宠 pid 90219 父进程=Host 18937、正常渲染）。
- 已知缺口：`.app` 解析失败时的 **fallback `open` 分支仍继承该 env**（隔离实测 `open.log` 中为 1）；
  当前真实 `.app` 结构正常（`Contents/MacOS/AventurinePet` 存在）不会触发；后续建议给 fallback 也传清洗后 env。
- 参考：[wave3-hmr-activation-verification-2026-11-11.md](wave3-hmr-activation-verification-2026-11-11.md) §4。

### W3-L13 打包版隔离限制与登录项

- 见 W3-L8（`PET_PROFILE`/`HOME` 隔离受限）。另：从 dist 运行 ad-hoc app 时，Electron 登录项 API 报
  `Unable to set login item: Operation not permitted`，而 `src/main/login-item.ts` wrapper 仍记 `applied:true`
  （Electron API 未抛错）；当前 `launchAtLogin=false` 默认无用户可见影响，未来启用开机自启前建议用
  `app.getLoginItemSettings()` 复核真实状态。
- 参考：[packaging.md](packaging.md) §4；[wave3-e2e-report-2026-11-11.md](wave3-e2e-report-2026-11-11.md) §2.4/§4。
