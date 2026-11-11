# 修复报告：拎起 → 放下后宠物停在窗口上（2026-11-10）

> 关联调查：[window-landing-research-2026-11-09.md](./window-landing-research-2026-11-09.md)（只读调查 / 外部方案）
> 用户决策（本轮开工前确认）：**混合语义** —— 能坐的窗沿吸上去坐/躺；窗沿太高就站在松手位置不再下落；
> 停住之后**原地待机**（可再次拎起，不自主走开）。

## 1. 问题与根因（结论）

现象：把宠物拎起来从高处松手，它**不会停在窗口上**，而是掉到屏幕底。

调查结论（详见调查文档 §1）：物理积分器/落地检测本身没问题（离线用真实 surfaces 复现：有够得着的窗沿时会准确停住）。
真正原因是三件事叠加：

1. **交互语义缺口**：旧实现只认「自由落体过程中脚底**跨越** `window-top` 的 top」才落地；
   而用户最自然的操作是"把它**放到**窗口上"——松手时身体已经压在窗口区域里（脚底在窗沿下方），
   永远不会"跨越"上沿 → 直接掉到屏幕底。
2. **窗沿可达性**：拖拽锚的是脚底 + 抓取偏移 + workArea clamp，被拎到最高时脚底约 270–540px，
   而实机快照里唯一的可见窗沿在 y=36（贴屏幕顶），永远够不到。
3. **高窗沿不可坐**：`filterDesktopTargetsForPet` 的 headroom 规则（≈0.62×身高）会把贴屏幕顶的窗沿判为
   不可坐，旧行为是"落上去后立刻跳下"（`finishFall` → `dropDown`），于是观感仍是"不停在窗口上"。

## 2. 实现（混合语义）

### 2.1 新增「放置」状态机（`src/renderer/src/physics/pet-physics.ts`）

- `beginPlacement(plan, nowMs)`：松手后从当前脚底**平滑移动**到目标（easeOutCubic，120–340ms，
  距离/速度自适应）。完成前 `grounded=false && airborne=false`（第三态），不受重力。
- 两种模式：
  - `surface`（能坐）：移动到窗沿上方 **2px** 后转回自由落体 → 复用既有落地检测 / `landed` 事件 /
    B1 `finishFall`（落地后优先坐下）。**不另写落地管线**。
  - `anchor`（窗沿太高/被遮挡）：滑到目标点后进入**站定**（`grounded=true, surfaceId=null`）：
    不随重力下落、忽略 `moveTo`/`sit`/`drop` 指令；`beginDrag`/`teleport` 会解除。
- 新增公开查询：`isAnchored()` / `isPlacing()` / `consumePlacementLanded()`；
  `getDebugSnapshot().placement = 'none' | 'placing' | 'anchored'`。
- P1：`endDrag` 增加**贴沿吸附**（±4px 容差、竖直速度 ≤320px/s）：松手时脚底恰好压在窗沿带内也直接落上。

### 2.2 新增放置目标查找（`src/renderer/src/desktop/`）

- `geometry.ts`：`rectContainsPoint` / `horizontalOverlapWidth` 纯函数。
- `sensor.ts`：`findPlacementTarget(petRect)` —— 按 CGWindowList **前→后**顺序取第一个包含宠物中心点的窗口，
  返回其 overlay 本地**完整矩形** + 当前**可见**的 `window-top` 表面（被前层完全遮挡时为 null）。
  只读、不消费 transitions，可在拖拽松手瞬间（帧外）安全调用。

### 2.3 集成层（`src/renderer/src/core/pet-runtime.ts`）

- `endDrag` → `tryBeginPlacement`：
  - 松手速度 **≥520px/s**（与 B1 `THROW_SPEED_THRESHOLD` 对齐）= 甩出，走原物理；
  - 慢速松手 + 中心压在窗口上：
    - 窗沿经 B1 **同一套 headroom/宽度过滤**后 `sittable` → `surface` 吸附；
    - 否则（沿太高/被遮挡）→ `anchor` 站定，脚底钳到「全身可见」位置（被拎到屏幕顶时平滑滑到可见处）；
  - 松手点在桌面 / 无窗口 → 保持原自由落体。
- 站定期间给 B1 传 `autonomous=false` → **原地待机**（复用既有"关闭自主"路径，不新增行为分支）；
  再次拎起即恢复原配置。
- `anchor` 完成时给 B3 补一个 `landed` 动画事件（播落地姿态）。

## 3. 验证证据

### 3.1 单测 / 类型 / 构建

| 项 | 结果 |
|---|---|
| `pnpm typecheck`（node+web） | ✅ 通过 |
| `pnpm test` | ✅ **110 文件 / 1918 用例通过**（新增 23 条：sensor 放置目标 7、物理放置/贴沿 8、runtime 放置集成 3 + 其它） |
| `pnpm build` | ✅（typecheck + electron-vite build） |
| `PET_SMOKE_TEST=1` 实机冒烟 | ✅ `SMOKE_OK`（窗口/事件/渲染/交互/桌面感知链路无回归） |

新增测试文件：`tests/pet-runtime-placement.test.ts`（3 条真机几何场景的集成单测）；
`tests/physics-pet-physics.test.ts` + `tests/desktop-sensor.test.ts` 追加放置相关用例。

### 3.2 实机端到端（真实桌面窗口 + 合成鼠标事件）

新增 dev-only 验证钩子：主进程 `PET_DEV_CAPTURE_PLACE="<cx>,<cy>"`（抓图脚本 `--place "<cx>,<cy>"`），
流程 = 悬停宠物 → mousedown → 分步拖到目标（宠物身体中心坐标）→ 停 320ms（松手速度归零）→ mouseup
→ 等 1.2s → `place-after.png` + 调试快照 JSON。

**A. 高窗沿 → 原地站定**（50% 尺寸，目标中心 (960,370)，压在实机 DSH 窗口上，其顶边本地 y=36）：

```
DEV_CAPTURE_PLACE {"ok":true,"from":{"x":1702,"y":691},"to":{"x":960,"y":370}}
place-after.json → motion: {"feet":{"x":1013,"y":663},"grounded":true,"surfaceId":null,"airborne":false}
                   behavior: {"mood":"idle","activity":"idle","autonomous":false}
                   errors: []
```
→ 站定生效（`grounded=true` + `surfaceId=null` + `autonomous=false`），不再掉到屏幕底。
产物：`tests/tmp/placement/anchor/place-after.{png,json}`。

**B. 可坐窗沿 → 吸附坐下**（20% 尺寸让 Finder 可见窗沿满足 headroom；目标中心 (1700,600)）：

```
place-after.json → motion: {"feet":{"x":1700.93,"y":324},"grounded":true,"surfaceId":"win-3394-top"}
                   behavior: {"mood":"sit","activity":"sit","autonomous":true}
                   animation.clipId: "mate-sitWindow"   // 高窗沿 → 窗沿躺 clip
                   errors: []
```
→ 吸附到 Finder 可见上沿（本地 y=324，可见段 x=1600..1741）并坐下。
产物：`tests/tmp/placement/sit-autonomous/place-after.{png,json}`。

## 4. 已知限制 / 后续可做

- 站定期望窗口移动/关闭时暂**不跟随**（宠物留在原地）；后续可按 `windowId` 在 `windows-updated` 里解除站定。
- 站定期间暂停全部自主活动（用户明确要求"不要自己走开"）；若以后想要"窗口内活动"，需要把窗口当作活动平台单独设计。
- 自由落体（甩出）落到"不可坐的高窗沿"仍沿用旧规则：落地后 250ms 起跳落下（`finishFall→dropDown`），
  避免宠物大半出屏站着；本轮未改该分支。
- 窗沿吸附/站定依赖 winlist 的窗口几何，轮询已从 500ms 提到 **250ms**（`src/main/ipc/desktop.ts`）以降低滞后。

## 5. 复跑命令

```bash
# 单测 / 类型 / 冒烟
pnpm typecheck && pnpm test
ELECTRON_RUN_AS_NODE= PET_SMOKE_TEST=1 node_modules/electron-vite/bin/electron-vite.js dev

# 实机放置验证（A 站定 / B 吸附坐下；会短暂弹出宠物窗口）
node scripts/vrm/capture-app.mjs --out tests/tmp/placement/anchor --poses stand --size 50 \
  --place "960,370" --no-idle --hold-ms 500
node scripts/vrm/capture-app.mjs --out tests/tmp/placement/sit-autonomous --poses stand \
  --config '{"sizePercent":20,"autonomous":true,"dshLink":false}' --place "1700,600" --no-idle --hold-ms 900
```
（实机抓图需要写应用 userData/GPU 缓存，需在完整文件权限下运行；脚本本身不修改仓库外其它数据。）

---

## 6. 追加修复（2026-11-10 晚：用户反馈「站在窗口上 / 趴下时头被截」）

> 本节修正 §4 的旧说法：**窗沿躺素材没有坏**——20% 尺寸下趴/躺观感正常；之前把「气泡遮挡」
> 误判成「素材渲染坏了」，已更正并按真因修复。

### 6.1 「怎么变成站在窗口上了」= 自主活动开关吞掉了落地坐下

- 旧实现 `finishFall`/`trySitOnWindowTop` 的「落地到可坐窗沿 → 优先坐下」被 `autonomous` 开关门控；
  测试/关闭自主活动的配置下宠物落在窗沿上只会站着（实机抓图 `sit-50pct` 即此现象）。
- 修复：`finishFall` 的窗沿落地反应（`sit` / `dropDown`）不再受 `autonomous` 门控；`autonomous=false`
  时由 `consumePreferredWindowTopReaction` 以非自主活动执行一次（保留 250/450ms 落地延迟）。
- 测试：`behavior-director.test.ts` 新增 autonomous=false 落地坐下用例；
  `pet-runtime-placement.test.ts` 新增 autonomous=false 放置→坐下集成用例。

### 6.2 「头明明没顶到屏幕顶端，头还是被截掉了」= 气泡盖住宠物（真因）

- 根因：`computeBubblePosition` 在「头顶放不下」时回落到 `petRect.y + 8` 并钳到窗口顶；
  宠物坐在高窗沿/躺在窗沿时 `petRect.y` 为负（50% → -216、70% → -432），气泡被钳到 y=8，
  **正好压住宠物头部**（20% 时 petRect 仍在屏内，所以小比例看起来正常）。
- 修复（`core/bubble.ts`）：头顶放不下时依次改为 **① 宠物侧面（水平分离）→ ② 宠物下方 → ③ 兜底贴顶**，
  不再盖住宠物；新增 3 条单测（含「坐高窗沿时气泡不落在宠物矩形内」断言）。

### 6.3 坐姿 headroom 公式修正（50% 明明有空间却被判不可坐）

- 旧公式把 0.62 当成「上半身高度」，实际 `髋高 ≈ 0.62×身高`，**头到髋只有 (1−0.62)≈0.38×身高**；
  旧规则多要了 0.24×身高（540px 宠物多 ≈130px）→ Finder 窗沿 top=324 在 50% 被判不可坐。
- 修复（`core/pet-runtime.ts`）：坐姿阈值改为 `(1−0.62)×身高 + margin`：
  540px（50% 档）≈213px、756px（70% 档）≈295px → 高窗沿（324）在 50%~79% 尺寸下都能完整坐下。

### 6.4 坐 / 趴 / 躺 风格选择（保留小比例趴躺，大比例自动坐）

- 躺姿素材竖向占用比坐姿大，且不同素材不同（抓图实测：`mate-sitWindow` ≈0.44×身高、
  `mate-windowLay8` ≈0.60×身高）→ 新增纯函数 `chooseSitWindowStyle`：
  - 上沿在屏幕上半部 且 headroom ≥ **0.62×身高 + 8px**（最坏躺姿也能放下）→ `lie`（趴/躺）；
  - 否则 → `sit`（头到髋 0.38×身高，更省空间；保证头不出屏）。
- 结果：20%~45% 尺寸在高窗沿上趴/躺（小比例观感正常），50%+ 自动坐；贴屏幕顶（y=36）的窗口
  仍走「原地站定」（任何坐/躺都会大半出屏）。
- 同时恢复 `SIT_WINDOW_LIE_ENABLED=true`；新增 dev A/B 抓图开关
  `PET_DEV_CAPTURE_SIT_STYLE=sit|lie`（主进程写 `window.__petDevSitStyle`）。

### 6.5 实机证据（真实 Finder 可见上沿 top=324，50%/70% 为当前配置尺寸）

| 尺寸 | 选中风格 / clip | 渲染包围盒顶部 | 结论 |
|---|---|---|---|
| 20% | `mate-windowLay8`（趴/躺） | y=193px | 完整可见（小比例趴/躺保留） |
| 50% | `mate-sit1`（坐沿） | y=96px | 完整可见、腿垂下 |
| 70% | `mate-sit1`（坐沿） | y=36px | 完整可见（贴近屏顶但未截） |

抓图：`tests/tmp/placement/final-20/`、`final-50/`、`final-70/`（`place-after.png/json`）；
20% 无错误、50%/70% `errors: []`，`behavior.mood=sit`、`motion.surfaceId=win-3394-top`。

### 6.6 复跑（追加）

```bash
for sz in 20 50 70; do
  node scripts/vrm/capture-app.mjs --out tests/tmp/placement/final-$sz --poses stand --size $sz \
    --config "{\"sizePercent\":$sz,\"autonomous\":false,\"dshLink\":false}" \
    --place "1700,600" --no-idle --hold-ms 700
done
# 可选：--sit-style lie 强制趴/躺、--sit-style sit 强制坐，做逐尺寸 A/B
```

---

## 7. 最终修正（2026-11-10 深夜，用户三轮反馈后）

> 本节更正 §6 中的两处误判：① `windowLay8/9/10` **不是趴/躺素材**，原始标注就是「窗沿坐姿变体」；
> ② 「头被截」**不是素材问题**，真因是气泡遮挡 + VRM 分 mesh 视锥剔除。

### 7.1 「蹲在窗口上」= 坐姿变体用错了锚点

- 现象：50%/70% 时宠物像"蹲/跪在窗沿上"，用户指出那是坐姿、锚定位置错了。
- 根因：旧实现把 `mate-windowLay8/9/10` 归入 `lie` 风格，按**脚底平面锚点**（visualOffset=0）渲染；
  这些素材本质是坐姿，应以**臀部贴窗沿**（与 sit1 相同的 hips 锚点）渲染，腿才会自然垂下。
- 修复（`vrm/animator.ts` + `core/pet-runtime.ts`）：
  - 新增 `sitVariant` 风格：手动播放窗沿坐姿变体，但使用 **hips 贴沿锚点**（`poseHipsAboveLowestM`）；
  - 变体固定为 `mate-windowLay8`（预览确认的正坐姿态）；`windowLay9/10` 姿态差异大（盘腿/侧倒），
    不再随机切换，保留 catalog 供后续选片；
  - 选择规则：窗沿在上半屏且 headroom ≥ 0.38×H + 8px（坐姿实测竖向占用）→ `sitVariant`；
    否则标准 sit（sit1）；放置层本身只在可坐时吸附，因此 50%/70% 尺寸都是"坐在窗沿上"。

### 7.2 「头没顶到屏幕顶却消失」= 气泡遮挡 + VRM 分 mesh 视锥剔除（真因）

1. **气泡遮挡**（`core/bubble.ts`）：宠物矩形超出屏幕顶时（高窗沿坐/躺），旧 `computeBubblePosition`
   把气泡钳到窗口顶 → 正好盖住头部。已改为：头顶放不下 → 宠物**侧面**（水平分离）→ **下方** → 兜底贴顶。
2. **VRM 分 mesh 的视锥剔除**（`vrm/pet-scene-vrm.ts`）：VRM 每个材质是独立 SkinnedMesh，
   three.js 用 **bind-pose 包围球**做视锥剔除；模型整体下移贴到屏幕顶时，头部 mesh 的包围球越出
   正交视锥 → **整块被剔除**（表现为头消失、眼镜还浮着）。已对模型所有 mesh 关闭 `frustumCulled`
   （桌面宠物固定正交相机、mesh 极少，代价可忽略）。实测 70% 时头部从"消失"变为完整渲染。

### 7.3 「被放到窗口上第一时间永远站着」= 落地延迟 + 自主门控

- 旧链路：松手 → 平滑滑到窗沿上方 → 2px 自由落体 → 落地 → B1 `finishFall` **450ms 延迟** → 坐下。
  中间有明显站姿（用户称"雷霆 bug"）。
- 修复：`PetPhysics.snapOntoSurface()` **直接吸附到位**（无过渡/无落差）；`BehaviorDirector.requestSitOnSurface()`
  下一帧**立即**以非自主活动启动 sit（跳过 450ms 延迟与 autonomous 门控）。放置后第一帧就是坐姿。

### 7.4 最终实机证据（真实 Finder 可见上沿 top=324，`--place` 抓图）

| 尺寸 | 放置后 250ms（place-immediate） | 稳定帧（place-after） |
|---|---|---|
| 20% | `mood=sit`、`clip=mate-windowLay8` | 同左，包围盒顶=235px，头完整 |
| 50% | `mood=sit`、`clip=mate-windowLay8`、offset≈-142 | offset≈-108，头完整、腿垂下 |
| 70% | `mood=sit`、`clip=mate-windowLay8`、offset≈-172 | offset≈-151，**头完整**（culling 修复生效） |

抓图：`tests/tmp/placement/v6-20|50|70/{place-immediate,place-after}.{png,json}`；`errors: []`。

### 7.5 本轮代码改动

- `vrm/pet-scene-vrm.ts`：模型所有 mesh `frustumCulled=false`（修头消失）。
- `vrm/animator.ts` / `vrm/runtime-types.ts`：新增 `sitVariant` 风格（坐姿变体 + hips 贴沿锚点）、
  lie 素材覆盖/下沉参数。
- `core/pet-runtime.ts`：`chooseSitWindowStyle`（sitVariant/sit）、`SIT_VARIANT_CLIP_ID`。
- `core/bubble.ts`：气泡不再盖住宠物（头顶→侧面→下方→兜底）。
- `behavior/behavior-director.ts`：`requestSitOnSurface` + `consumeImmediateSit`（立刻坐下）。
- `physics/pet-physics.ts`：`snapOntoSurface`（直接吸附，无中间站立）。
- `main.ts`：坐姿风格注入（sitVariant/lie）、dev A/B 覆盖；`main/index.ts`：放置抓图增加
  `place-immediate` 帧（250ms）用于验证"第一时间已坐下"。
- 单测：+16（chooser、snapOntoSurface、requestSitOnSurface、气泡避让、放置即刻坐下等）。

---

## 8. 恢复「自由落体」语义（2026-11-10 深夜，用户最终要求）

用户要求：**保留原先"没有可坐窗口就掉下去 + 高处落地眩晕动画"的逻辑**，只有碰到能坐/趴/躺的窗沿才坐下/躺下。
据此撤销 §2 的 `anchor` 原地站定：

- `PetRuntime.tryBeginPlacement`：仅在「目标窗口可见上沿可坐（经 B1 headroom 过滤 sittable）」时
  直接吸附 + 立刻坐下；**其余情况（无窗口 / 上沿太高 / 被遮挡 / 不可坐 / 吸附失败）直接返回**，
  保持 `endDrag` 后的 airborne 状态走原自由落体/抛掷物理。
- 删除 `computePlacementAnchorFeet` 与运行时 anchor 分支；`PetPhysics.beginPlacement('anchor')`
  作为底层能力保留（当前集成层不再使用）。
- 落地眩晕/受击链路未改动：`thrown`（空中）→ `landed` → `clip-player` 播 `hsr-stun`（甩出后落地）
  或 `hsr-revive/hsr-hitL`（普通落地）；`finishFall` 的落地反应逻辑保留。

### 实机验证（50% 尺寸，真实窗口）

| 场景 | 放置后 250ms | 稳定帧 |
|---|---|---|
| 松手在贴屏幕顶的大窗口上（不可坐） | `mood=fall`、airborne、feet.y=863（下落中） | `grounded`、surface=`dock-bottom`、feet.y=961（正常落地） |
| 松手在可坐的 Finder 可见上沿 | `mood=sit`、surface=`win-3394-top`、y=324、clip=`mate-windowLay8` | 同左（已经坐在窗沿上） |

抓图：`tests/tmp/placement/rev-fall/`（掉落）、`rev-sit/`（坐窗沿）。
单测：新增「thrown → landed 链路保留」用例；「不可坐窗口 → 掉落并产生 landed」替代原“原地站定”用例。
