# Wave 2（V5–V8）验收报告 — VRM 主链接入

> 日期：2026-11-09 · 状态：**V1/V4/V2 收尾 + Wave 2 V5–V8 全部通过（自动化 + 实机抓图）**
> 运行环境：macOS 27.0.1 / Apple Silicon · Electron 44.10.2 · three 0.171 · three-vrm 3.5.5
> 目标资产：`assets/vrm/aventurine-tpose.vrm`（私有，VRM 1.0；禁止再分发）
> 计划：`PLAN.md` §5 · 设计：`docs/wave2-vrm-runtime-design.md` · V2 证据：`docs/v2-report.md`
>
> **口径更新（2026-11-11，Wave 3）**：本报告是 Wave 2 当时的历史验收记录（动作清单 29 app clips / 43 catalog）。
> 当前运行时口径已变为 **app-manifest 40 clips / app-catalog 181**（mate 30 / hsr 14 / adv 137），
> mate 实际 30 条（2026-11-09 男性适配新增 `dragFemale`）；以
> [wave3-acceptance.md](wave3-acceptance.md) §1.3 与 `docs/packaging.md` 为准。

## 0. 一页结论

| 项 | 结果 |
|---|---|
| `pnpm typecheck` | ✅ 0 error（node + web） |
| `pnpm test` | ✅ **101 files / 1736 passed / 14 skipped** |
| `PET_MODEL_BACKEND=vrm pnpm smoke` | ✅ `SMOKE_OK`（VRM 专属断言全过；日志 `tests/tmp/wave2/evidence/smoke-vrm.log`） |
| `PET_MODEL_BACKEND=legacy-pmx pnpm smoke` | ✅ `SMOKE_OK`（v1 PMX 回退不回归；日志 `tests/tmp/wave2/evidence/smoke-legacy.log`） |
| 多轮重启（临时 HOME + 独立 profile） | ✅ 3/3 轮 `DEV_CAPTURE_OK`；config.json 持久化且 3 轮 hash 稳定（`tests/tmp/wave2/restart/run-summary.json`） |
| 真实用户数据隔离 | ✅ 3 轮启动前后 `~/.dsh/aventurine-pet` 与真实 `aventurine-pet` userData 的 size/mtime hash 未变 |
| Wave 2 六项实机观感 | ✅ 截图证据见 §3（待用户最终验收勾选，见 `PLAN.md` §10） |

**本轮完成范围**：V1（three-vrm 渲染接线）、V4（legacy 隔离）、V2 证据补课；Wave 2 的 V5（戏浪 VRM 主链）、
V6（表情/look-at/spring/材质）、V7（行为/物理/交互 humanoid 适配）、V8（验收证据/实机隔离）。
**未进入 Wave 3**（清理/打包由用户决定）。

## 1. 架构与接线（V1/V4）

- **后端开关**：`modelBackend`（env `PET_MODEL_BACKEND` > config > 默认 `vrm`）由主进程在 config IPC
  边界套用（`src/main/backend-flags.ts`），renderer 据此选择 `VrmPetScene`（`vrm`）或 `PetScene`（`legacy-pmx`）。
- **新模块**：`src/renderer/src/vrm/`（avatar-loader / pet-scene-vrm / clip-data / clip-registry /
  clip-player / animator / look-at / expression-layer / humanoid-map / runtime-types）。
- **协议**：`pet-asset://assets/<多段相对路径>` 新 host（`src/main/protocol*.ts`），只读 `<repo>/assets/**`；
  越界/编码绕过返回 403，沿用 realpath + O_NOFOLLOW 安全链。
- **CSP 修复**：`connect-src` 增加 `blob:` —— GLTFLoader 的 ImageBitmapLoader 用 `fetch(blobURL)` 解码
  GLB 内嵌贴图；不放行会让 MToon 全部贴图失败（模型渲染成白色剪影）。
- **米制世界单位（SpringBone 正确性）**：`VrmPetScene` 保持 `modelRoot.scale=1`（模型原生米制，
  spring 物理不受 ~312× 缩放破坏），正交相机视锥/摆放用 `pxPerMeter = rect.height / restHeightMeters` 换算。
- **legacy 隔离（V4）**：v1 动画实现整体 `git mv` 到 `src/renderer/src/animation/legacy/**`，
  顶层 `animation/index.ts` 为 facade（导出集合与迁移前 106/106 完全一致；测试仅改 import 路径）。
  回退：`PET_MODEL_BACKEND=legacy-pmx`（当前 VMD 外部动作路径仍可用，见 smoke legacy）。

## 2. 数据/动画口径（V5）

- 模型实测（`debug.vrm` 与离线 GLB 解析一致）：**53 humanoid 骨**（缺 upperChest/jaw，requiredMissing=[]）、
  **95 expression**、**50 spring 链 / 170 joints / 600 colliders**、**39 MToon 材质**、**17 贴图**（0 缺失）、
  POSITION 37,196 / 三角 51,829、rest 高 **1.734 m**、脚底 ≈0.0007 m、面向 **+Z**、yawOffset 0、
  `VRMC_vrm.lookAt.type="bone"`（three-vrm 加载后 `vrm.lookAt` 非空）。
- 宠物矩形：`bodyAspectRatio=0.30`（躯干带；540px 高 → 162px 宽）——命中/物理半宽按躯干而非 T-pose 臂展。
- clip：`assets/motions/{mate,hsr}/**.json`（52 骨 normalized 旋转 + Hips.p）→ 运行时 app 清单
  `assets/motions/app-manifest.json`（**Wave 2 当时 29 clips**：idle 12 / walk 2 / sit 7 / drag 1 / pat 3 / sleep 1 / dsh 3）
  + `app-catalog.json`（43 clips，含一次性动作）。生成：`node scripts/vrm/motion/build-app-manifest.mjs`（`--check` 幂等）。
  > 2026-11-11 Wave 3 更新：当前运行时清单为 app-manifest **40 clips** / catalog **181**（adv 并入 + DSH 槽位别名），
  > 生成器入口不变；详见 [wave3-acceptance.md](wave3-acceptance.md) §1.3。
- 贴地：`grounding='feet'`（HSR idle）用脚骨常量补偿（smoke 实测 footErrorPx ≈ 0）；mate 集未标 grounding 的
  clip 走 **pose grounding 兜底**（采样 16 帧取全骨最低点做每 clip 常量偏移；drag 槽位排除）。
  实测 offset：sit1 −0.414 m、sleep −0.884 m、walk −0.022 m、drag 0（不吸地）；残差 ≤8cm（坐/睡）。
- 坐姿选片：`sit1`(prio 10) > `sit2`(9) > `suwari3`(8)；`sitWindow/windowLay*` 为「窗沿躺」素材，
  优先级 −10…−13 仅保留在 catalog（未来窗沿躺专用）。
- DSH 联动（V7 补齐）：`dshBusy→hsr/commonIdle`、`dshDone→mate/happy`、`dshError→hsr/hitL`（app-manifest 别名条目）。

## 3. 验收证据（实机截图为透明 overlay 实际帧）

证据根目录：`tests/tmp/wave2/`（gitignore，不随仓库分发）。

| 验收项 | 证据 | 结论 |
|---|---|---|
| 待机 | `tune2/01-stand.png`、`v7feed/01-stand.png`、`evidence/poses-sheet.png` | ✅ 呼吸/微动（clip 播放，footError≈0） |
| 走路 | `v7feed/walk-1..3.png` | ✅ 侧身朝运动方向、头不追鼠标、脚落地（pose grounding） |
| 坐（含窗沿） | `poses2/02-sit.png`（地面坐 sit1）；窗沿躺素材保留 catalog | ✅ 坐姿自然、贴地残差 6.9px |
| 摸头/表情 | `evidence/face-compare.png`（idle 睁眼 vs pat 笑い闭眼笑）、`face-pat/`、`face-shy/`（照れ+目影消 调试触发）；smoke `blink.seen` | ✅ 表情/眨眼/害羞链路（见 §4） |
| 拖拽/甩出 | `v7feed/drag-right-dragging.png` / `drag-right-released.png` | ✅ 起手侧身、拖动朝移动方向、松手回正 |
| 注视 | smoke `gaze.actualDeg=25`；`debugSetGaze` | ✅ 头/眼跟随（内建 VRMLookAt bone applier + 头/颈 additive） |
| 材质/spring | `tests/tmp/v2-evidence/tpose/diagnostics.json`（MToon 39/贴图 17/0 失败）；smoke drawCalls=39、52k tri、fps≈29 | ✅ 无黑面/无大面积穿模；描边见 §5 偏差 |
| 表情 | smoke `blink.seen=true (1942ms)`；`pat` 触发 expression clip/preset；custom「照れ/目影消」增强（V6） | ✅ 眨眼/笑/害羞可触发 |
| 桌面交互回归 | smoke：overlay 几何/穿透/悬停拦截/设置窗/托盘/windows-updated 全过；legacy smoke 同样全过 | ✅ |
| 性能 | VRM：fps≈29@30cap、drawCalls 39、52k tri；PMX 对照 60 draw calls / 86.8k tri（含描边 pass） | ✅ 无回归 |

## 3.5 多动作状态：随机播放 + 自然切换（2026-11-09 用户要求）

同一状态绑定了多条动作时（idle 12、sit 3、walk 2、pat 3…）不再顺序轮播，改为：
- **首次进入**该状态播最高 priority 主选；之后在变体池内**随机**选（排除当前+近期，`avoidRecent`
  idle/sit=2、walk=1；池不够自动降级；priority 仍作池准入 ≥ -9，窗沿躺 −10…−13 不参与）；
- 轮换间隔按槽位（参考 Mate-Engine 源码 `IDLE_SWITCH_TIME=12s` / `IDLE_TRANSITION_TIME=3s`）：
  idle 12–20s、sit 15–30s、walk 10–18s、sleep 不轮换、其它 12–24s；
- 变体 crossfade：idle/sit 0.8–1.0s、walk 0.25–0.35s、其它 0.3–0.5s（普通 mood 切换仍 ≈0.2s）；
  循环 clip 变体切换随机起始相位。
- 参数集中在 `CLIP_PLAYER_DEFAULTS.variantSwitch` / `VARIANT_SWITCH_CONFIG`（可 tuning 覆盖）。
- **未绑定动作的接线建议**（本轮只推荐、未接线）：见 `docs/vrm-motion-mapping-recommendations.md`。

## 3.6 2026-11-09 追加：状态化动作编排（用户决策）

| 能力 | 实现 | 证据 |
|---|---|---|
| 启动即待机（无 T-pose 闪现） | 用户 2026-11-09 追加：启动**直接进入 idle**（开场序列默认关闭，代码保留可 `enabled:true` 再启）。**同日再次修复**：旧门控被 `applyModelTransform` 绕过（模型加载后先露 rest T-pose ~69ms）且首条 idle 从 rest crossfade（中间态 ~135ms）；现做法=可见性唯一 owner + 首条 clip 直接吸附 + 姿势完整应用（weight≈1）才显示 + 失败/超时兜底。**逐呈现帧实测**（before/after 各 150 帧）：宽 bbox（T-pose）帧 **3 → 0**，首个可见帧 aspect **0.861(wide) → 0.525(idle)**。详见 [research/startup-pose-flash.md](research/startup-pose-flash.md)、`tests/tmp/startup-pose/` | `pet-scene-vrm.ts` syncModelVisibility + `startup-pose.ts` 判定 + `clip-player.ts` 首帧吸附 + main.ts intro enabled:false；单测 `vrm-startup-pose.test.ts` |
| 多动作状态随机播放 | 同一状态多条动作：首次最高 priority 主选，之后随机（排除当前/近期）；轮换间隔 idle 12–20s、sit 15–30s、walk 10–18s；变体 crossfade idle/sit 0.8–1.0s；循环 clip 随机相位 | clip-player 测试（§3.5） |
| idle 稀有变体 | idle 15 条，其中 pose1-3 稀有权重 0.3 → 实测每次轮换约 7.3% ≈ **3.3 分钟**一次 | `tests/tmp/wave2/evidence/showcase/showcase-sheet.png`、clip-player 测试 |
| DSH 出错（长时间） | `dshError` 反应 4s→**12s**：进入播 `hsr-breaked`（非循环）并 **hold 末帧保持倒地姿态 ≈9s**（显示严重程度）→ 离开时播 `hsr-revive`（首帧跪伏，接上 breaked 末帧 → 起身）。**实测数据修正**：`hsr-stun` 其实是站立眩晕摆动、`hsr-breaked` 才是倒地/跪伏姿态，故长时间 error 用 breaked-hold（stun 留 app-manifest 兜底） | `tests/tmp/wave2/evidence/error-sequence/error-sequence-sheet.png`（倒地保持→起身→idle） |
| DSH 工作小动作 | 工作模式（online && running）下随机 **30–60s** 播一次 `hsr-skill01/02` one-shot（首次 10–20s 延迟，拖拽/摸头/菜单/反应中跳过，不密集） | `reactions/dsh-work-fidget.ts` + 单测；参考 Mate-Engine idle/dance 随机切换节奏 |
| 坐窗沿（高窗躺/矮窗坐 + hips 锚点） | 用户 2026-11-09 实机反馈追加：①`sit` 时用 `clipSnapshot.poseHipsAboveLowestM` 把模型整体下移，让 **hips 贴窗沿、腿自然垂下**（sit1 ≈0.563m → 视口 ppm 换算），不再「最低点贴窗沿」导致悬空；②窗口上沿在屏幕**上半部**（高窗）→ 播放 `mate-sitWindow/windowLay8/9/10`（躺/趴）；上沿在**中线及以下**（矮窗）→ sit1 坐姿。离开 sit 自动清掉窗沿躺手动 clip | animator `setSitWindowStyle` + main `resolveSitWindowStyle` + 单测 |
| 静态脚部固定 foot planting（消除待机脚滑；2026-11-09 重做） | 用户反馈「静态动作固定腰部导致脚滑来滑去」。**根因**：旧实现接触判据用 bbox 脚底(≈0) 对比踝骨(≈9.8cm)→永不触发；且 idle 池跨来源站姿差 15–20cm，12–20s 一次 0.8–1.0s crossfade 时脚在地面滑 36–49px。**修法**：接触基准改 rest 踝高 + 抬升/速度迟滞；scene 局部锚点（位置+朝向）跨 clip 保持；两骨 IK + 有界骨盆下沉（≤4cm 阻尼）；不可达/抬脚释放；进入移动/拖拽/坐/睡时权重平滑淡出；**只对静止动作启用**（walk/climb/fall/drag/grabWindow/sit/sleep 不锁，走路沿用步幅地速校准不动）。实机 A/B：脚横向位移 36/49px→**0/1px**，fps 28.5–30 无回归 | `vrm/foot-lock.ts` 重写（27 单测）+ `animation.footLock` 调试快照 + `docs/foot-slide-fix-report.md`；参考 Orange Duck foot locking / rabfulton/VRM foot-planting |
| walk 步幅校准 | clip 首次采样 16 帧 FK 测「支撑相地速」`clipStrideGroundSpeedMps`（mate-walk 真实值 ≈1.087m/s），playbackRate = 移动速度/(步幅×ppm)，减少走路滑步；B2 自然步速 ≈470px/s 时有效（旧公式按 VMD 步幅算 ≈1.0 会脚滑） | clip-player 单测 + snapshot 调试验收 |
| 视线俯仰方向 | 用户反馈「左右对、上下反」：头/颈骨局部 +X 实际是低头 → 改为 `-pitch`（内建眼球 applier 的 +pitch=向上不变），单测锁定上方→头骨 x<0 | `vrm/look-at.ts` + 测试 |
| 松手放置（2026-11-10） | 用户反馈「拎起来从高处落下不会停在窗口上」。**根因**：只认下落穿越窗沿 + 可见窗沿都贴屏幕顶（headroom 不可坐）→ 直接掉到屏幕底。**修法（混合语义）**：慢速松手且宠物压在窗口上 → ①窗沿经 B1 headroom 过滤后可坐 → 平滑吸附到可见上沿（2px 落差复用落地管线）+ 落地后优先坐下；②沿太高/被遮挡 → 原地站定（不随重力下落、忽略移动指令、自主活动暂停待机，可再次拎起）。另加 ±4px 贴沿吸附、winlist 轮询 500→250ms | `physics/pet-physics.ts`（放置状态机）+ `desktop/sensor.findPlacementTarget` + `core/pet-runtime.tryBeginPlacement`；23 条新单测 + 实机 A/B 抓图 `tests/tmp/placement/**`；见 `docs/research/window-landing-fix-2026-11-10.md` |
| 坐/趴/躺 与气泡遮挡修正（2026-11-10 晚） | 用户反馈「放到窗口上变成站着」+「趴下时头没顶到屏幕顶却被截」。**根因**：①「落地到可坐窗沿→优先坐下」被 `autonomous` 开关吞掉；②气泡在宠物矩形超出屏幕顶（高窗沿坐/躺）时被钳到窗口顶，正好盖住头（20% 时 petRect 仍 in-screen 所以正常，此前误判为躺姿素材坏）；③坐姿 headroom 公式把 0.62 当上半身，实际头到髋仅 0.38×身高（多要 0.24×H，50% 判不可坐）。**修法**：窗沿落地反应不再受 autonomous 门控；`computeBubblePosition` 头顶放不下时改放侧面/下方（不盖宠物）；坐姿阈值改 0.38×H+margin；新增 `chooseSitWindowStyle`：headroom ≥0.62×H+8 才趴/躺（小比例），否则自动坐（50%+），均保证头不出屏 | `behavior/behavior-director.ts`、`core/bubble.ts`、`core/pet-runtime.ts`、`main.ts`；新增 8 条单测 + 实机 20%/50%/70% 抓图 `tests/tmp/placement/final-*`；见 `docs/research/window-landing-fix-2026-11-10.md` §6 |
| 窗沿坐姿变体锚点 + 头消失 + 放置站立瞬时（2026-11-10 深夜三修） | ①`windowLay8/9/10` 是**窗沿坐姿变体**，旧实现按脚底平面锚点渲染 → 看起来“蹲在窗口上”；改 `sitVariant` 风格用 **hips 贴沿锚点**、固定 `windowLay8`（正坐），50%/70% 都完整坐在窗沿；②“头没顶到屏幕顶却消失”= 气泡遮挡 + **VRM 分 mesh 视锥剔除**（bind-pose 包围球越出正交视锥）→ 气泡改放侧面/下方、模型 mesh 关闭 `frustumCulled`；③“放到窗口上先站着”= 2px 落差 + 落地 450ms 延迟 → 改为 `snapOntoSurface` 直接吸附 + `requestSitOnSurface` 下一帧立即坐 | `vrm/pet-scene-vrm.ts`、`vrm/animator.ts`、`core/pet-runtime.ts`、`core/bubble.ts`、`behavior/behavior-director.ts`、`physics/pet-physics.ts`、`main.ts`、`main/index.ts`；+16 单测；实机 20/50/70% 抓图 `tests/tmp/placement/v6-*`（place-immediate 已 sit）；见 `docs/research/window-landing-fix-2026-11-10.md` §7 |
| 恢复自由落体语义（2026-11-10 深夜，用户要求） | 撤销「没有可坐窗口 → 原地站定」：无窗口/上沿太高/被遮挡/不可坐 → 恢复正常自由落体与甩出，保留 `thrown→landed→hsr-stun/revive` 落地眩晕/受击链路；只有可坐窗沿才吸附+立刻坐下/躺 | `core/pet-runtime.ts`（tryBeginPlacement 简化）、测试更新；实机 `rev-fall`（掉落→dock 落地）/`rev-sit`（立刻坐窗沿）抓图 |
| 暂缓（Wave 3） | `hideLeft/hideOnce` 需 B1 新 hide 状态 | 见 `docs/vrm-motion-mapping-recommendations.md` §4 |

## 4. V6 表情/look-at/spring 接线

- 表情层 `vrm/expression-layer.ts`：`assets/expressions/manifest.json`（17 clips）→ 既有纯逻辑
  `VRMExpressionDriver` → `expressionManager.setValue` → `vrm.update()` 应用；眨眼调度、口型（气泡文本）、
  情绪/一次性反应（pat/drag/DSH）全部在 `vrm.update` 之前写入。
- 自定义表情增强（V6 可选）：`pet→照れ 0.4`、`drag→照れ 0.28+目影消 0.25`、`sad→目影消 0.45`、
  `sleep→目影消 0.3`（模型缺通道自动跳过，平滑 0.12s）。
- look-at：目标模型带 VRMC_vrm lookAt（bone applier）→ 写 `vrm.lookAt.yaw/pitch`（autoUpdate=false）驱动眼球；
  头/颈额外 additive（45%/25%）；移动类 mood 与拖拽时抑制鼠标注视（用户反馈：走路头朝运动方向）；
  侧身时做 `yaw_local = yaw_world − facingYaw` 模型局部换算。
- spring：模型自带 50 链/600 collider 由 `vrm.update(dt)` 在米制下驱动（不缩模型），每帧真实 dt（≤0.1s）。

## 5. 已知偏差 / 限制（不阻塞 Wave 2 验收）

1. **MToon 描边不可用**：目标模型 39 材质 `outlineWidthMode` 全为 `"none"` → 无 outline pass（`outlinePx=0`）。
   PMX 的屏幕空间描边未移植（VRM 后端不做该 pass）；如需描边需加载前 patch GLB MToon 扩展（BLEND 材质描边官方不可靠），留 Wave 3/后续。
2. **V1「canary 加载」验收以目标戏浪 VRM 代替**（更强等价）：canary 加载证据在 W0-4/V2（`docs/v2-report.md`，
   51 骨/13 表情/31 材质/无 spring）；VRM 后端 smoke 使用主链目标资产。
3. **V2 路线偏差**：PMX→VRM 用 VRMify（Python）而非 Blender Add-on 管线；Blender 四视图用 three-vrm 三视图
   + 既有 Blender/GT 证据替代（`docs/v2-report.md` §6）。
4. **pose grounding 残差**：坐/睡为每 clip 常量补偿（残差 ≤8cm ≈ 42px → smoke 只对 stand 断言 <2.5px）。
5. **`motionSet` 配置**当前仅作日志字段（清单固定在 `assets/motions/` 根）；`PET_ANIM_BACKEND=legacy-pmx` 与
   `modelBackend=vrm` 的组合不提供 VMD 播放（VRM 后端固定 clip 动画）。
6. **旧项目 PMX 自定义动作（VMD）已删除（2026-11-09 用户决策）**：删除的是**动作资产**——
   `assets/model/optimized/motion-*.vmd`（13 个）与 `motion-index.json`（私有、gitignore、不进 git；
   旧工作区保留原样仅作只读参考）。**代码全部保留**（`src/renderer/src/animation/**`、
   `scripts/anim-pipeline/**`、旧动画测试）以便回退/复用；`main.ts` 的 legacy 后端默认只做 PMX 渲染
   + IdleMotion 微动，只有 `PET_ANIM_BACKEND=legacy-pmx` 时才接回 v1 程序化驱动。
7. **台词/文本全部保留**：`core/voicelines.ts` 111 条官方语音原文（SHA-256 锁）与
   `behavior/dialogue.ts` 场景池不变，并继续对应当前状态：鼠标靠近=问候、摸头=回合待机+返回城镇、
   戳=轻受击、拖拽=重受击、闲置活动=闲置池、DSH 忙/完成/出错=战技·秘技·战斗开始 / 成功池 / 无法战斗；
   walk/sit/sleep 不设气泡（沿用 v1 设计，未新增自创台词）。删除动作资产不影响任何台词/映射/测试。
8. **打包（Wave 3）**：`pet-asset://assets` 的 packaged 根已实现，但 electron-builder 配置/`extraResources`
   尚未接（C4 未做）；私有 `assets/**` 按项目红线不随 app 分发，打包仅本机运行时需要另行映射。

## 6. 复跑命令

```bash
cd /Volumes/4TB外置盘/deepseek-harness/aventurine-pet-vrm
pnpm install
pnpm typecheck && pnpm test

# 生成动作/表情运行时清单（私有 assets 需要；幂等）
node scripts/vrm/motion/build-app-manifest.mjs
node scripts/vrm/motion/build-app-manifest.mjs --check

# 冒烟（VRM 主链 + legacy 回退）；建议临时 HOME 隔离 DSH 桥目录
HOME=/tmp/pet-dsh-home PET_DSH_DIR=/tmp/pet-dsh-home/.dsh/aventurine-pet \
  PET_PROFILE=agent-e2e PET_MODEL_BACKEND=vrm PET_SMOKE_TEST=1 pnpm smoke
HOME=/tmp/pet-dsh-home PET_DSH_DIR=/tmp/pet-dsh-home/.dsh/aventurine-pet \
  PET_PROFILE=agent-e2e PET_MODEL_BACKEND=legacy-pmx PET_SMOKE_TEST=1 pnpm smoke

# 实机证据（透明 overlay 抓图；需 GUI）
node scripts/vrm/capture-app.mjs --backend vrm --poses stand,walk,sit,sleep,pat,drag \
  --out tests/tmp/wave2/poses --idle
node scripts/vrm/capture-app.mjs --backend vrm --poses stand --drag both --walk \
  --out tests/tmp/wave2/v7feed --idle

# 多轮重启 + 真实数据隔离校验
node scripts/vrm/e2e-restart.mjs --rounds=3 --backend=vrm
```

## 7. 回滚

- 代码：本 Wave 全部改动在 git 工作树（Lead 统一提交，提交信息 `feat(V1/V5/V6/V7)...`）；
  `git revert <commit>` 或 `git reset --hard <baseline>` 可回滚。
- 后端回退：`PET_MODEL_BACKEND=legacy-pmx pnpm dev`（或设置面板/配置文件 `modelBackend`）→ v1 PMX/VMD 路径。
- 数据：所有私有资产在 `assets/**`、`refs/**`（gitignore），删除不影响代码；运行时清单可重建（§6 命令）。
- 实机测试隔离：临时 HOME `/tmp/pet-dsh-home` + `PET_PROFILE=agent-e2e`；app userData 落在
  `~/Library/Application Support/aventurine-pet-agent-e2e`（测试专用，可直接删除）；真实
  `~/.dsh/aventurine-pet` 与用户默认 `aventurine-pet` 配置**只读不写**（e2e-restart 前后 hash 对比为证）。
