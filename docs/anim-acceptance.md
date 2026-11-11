# Wave 2.5 动作验收清单（待用户实机确认）

> 日期：2026-11-08 · 状态：**自动化验证全部通过，等待用户实机观感确认**
> 目标：让 stand/idle、walk、sit、摸头/拖拽反应由**真实人类动作（MMD VMD）**驱动，并用预览器三视图 + 实机观感验收。
> 运行：`cd /Volumes/4TB外置盘/deepseek-harness/aventurine-pet && pnpm dev`

---

## 0. 一图速览（实机拼接，不是渲染摆拍）

![Wave 2.5 实机动作总览](tests/tmp/wave25-acceptance-montage.png)

> 六行依次：待机 / 走路 / 坐姿 / 摸头反应 / 拖拽反应 / 鼠标注视（+25° 与 −25°）。
> 全部来自本机 `pnpm dev` 实机截图（`tests/tmp/`，gitignore）。

## 1. 怎么看 / 怎么确认

启动后观察以下 6 项，**逐项打勾即可**（任何一项不对，把具体画面/时机描述给 Lead 继续调）：

- [ ] **待机（idle）**：站立自然、有呼吸/重心转移，不是僵硬直立或「木偶感」
- [ ] **走路（walk）**：步态自然（手臂反相、脚掌落地），**不滑步、不膝反关节、不螃蟹横走**；走动时面朝运动方向
- [ ] **坐姿（sit）**：随机坐下时先正常移动/爬到位，落座后是「坐」的姿态（不再出现坐着滑行）
- [ ] **摸头反应（pat）**：在头部画圈后触发反应动作（taunt），不僵硬
- [ ] **拖拽反应（drag）**：按住拖动/甩出时，出现「被抓住/被甩」的真实反应（一次性），松手后落地正常
- [ ] **鼠标注视**：鼠标移动时头/眼跟随（VMD 动作叠加上去的 additive look-at），不是完全僵住
- [ ] （可选）**DSH 反应**：任务完成/出错时敬礼/惊讶（`dshLink` 打开且 DSH 在跑时）

> 建议同时打开一个窗口在宠物旁边（让它能坐窗口上沿），并切一次 30%/50%/100% 尺寸看走路是否仍不滑步。

---

## 2. 当前动作清单（本地 `assets/model/optimized/`，gitignore，不随 app 分发）

| mood | 文件 | 来源（零成本） | 时长/循环 | 验证 |
|---|---|---|---|---|
| idle | `motion-idle.vmd` | reze-rig 样例 Idle.fbx（UE/Unity Idle） | 3.00s 循环 | 54/54 骨；预览 7/7 PREVIEW_OK |
| walk | `motion-walk.vmd` | GitHub `nirholas/three.ws` → Mixamo 标准 Walk | 0.967s 循环 | 54/54 骨；自然步速≈490px/s@540px；预览 7/7 |
| sit | `motion-sit.vmd` | 同上 → Mixamo Sitting Clap | 5.67s 循环 | 54/54 骨；预览 7/7 |
| pat | `motion-taunt.vmd` | reze-rig 样例 Taunt.fbx（Mixamo Taunt） | 2.83s 一次性 | 54/54 骨；预览 7/7 |
| drag | `motion-drag.vmd` | 同上 → Mixamo Shoved Reaction With Spin | 4.53s 一次性 | 54/54 骨；预览 7/7 |
| dshDone | `motion-salute.vmd` | 同上 → Mixamo Salute | 2.83s 一次性 | 54/54 骨；预览 7/7 |
| dshError | `motion-reaction.vmd` | 同上 → Mixamo Surprised | 1.83s 一次性 | 54/54 骨；预览 7/7 |

其余 mood（climb/sleep/fall/grabWindow 等）继续由 B3 程序化姿态兜底；没有动作清单时整个外部层自动回退 B3（干净 clone 行为不变）。

## 3. 预览器三视图证据（gitignore：`tests/tmp/preview/`）

| clip | 接触表 |
|---|---|
| idle | `tests/tmp/preview/Idle/contact-sheet.png` |
| walk（新） | `tests/tmp/preview/walk-threews/contact-sheet.png` |
| walk（旧 Soldier，留档对比） | `tests/tmp/preview/walk-soldier/contact-sheet.png` |
| sit | `tests/tmp/preview/final-sit/contact-sheet.png` |
| pat（taunt） | `tests/tmp/preview/final-taunt/contact-sheet.png` |
| drag（shoved） | `tests/tmp/preview/drag-Shoved_Reaction_With_Spin/contact-sheet.png` |
| dshDone / dshError | `tests/tmp/preview/final-salute/`、`final-reaction/` |

实机 dev 截图/动图（gitignore）：

- 待机：`tests/tmp/wave25-idle/idle-strip.png`、`wave25-idle-demo.gif`
- 走路（新）：`tests/tmp/wave25-walk-v2/walk-v2-strip.png`
- 坐姿：`tests/tmp/wave25-sit2/sit2-strip.png`
- 坐姿上爬接近：`tests/tmp/wave25-sit-approach-3/approach-strip.png`
- 注视：`tests/tmp/lookat-compare.png`
- 摸头反应（pat）实机：`tests/tmp/wave25-pat-inapp/pat-strip.png`（`clipId=taunt`，source=vmd）
- 拖拽反应（drag）实机：`tests/tmp/wave25-drag-inapp/drag-strip.png`（`clipId=drag`，source=vmd）
  > 这两个是通过调试面 `debugSetAnimationMood(mood)` 临时覆盖动画 mood 截的（只影响动画层，不影响
  > 行为/物理；dev 仅 `PET_DEV_CAPTURE_MOOD=pat|drag` 时使用），用来证明外部 VMD 在**实机渲染链路**里
  > 正确选中并播放；正常交互（真鼠标摸头/拖拽）走同一条选择逻辑。

## 4. 自动化验证（本机结果）

| 检查 | 结果 |
|---|---|
| `pnpm typecheck` | exit 0 |
| `pnpm test` | **58 files / 1088 tests** 全绿 |
| `pnpm smoke`（dev） | `SMOKE_OK` exit 0；`motions.ok=true`、7 个 VMD 全存在、`source=vmd`、idle `externalFootErrorPx=0`；**mood→clip 实机映射探针**：walk→walk / sit→sit / pat→taunt / drag→drag / dshDone→salute / dshError→reaction，全部 `source=vmd`、`moodProbe.ok=true` |
| `pnpm smoke:file`（生产 loadFile 路径） | `SMOKE_OK` exit 0 |
| 无动作清单回退 | 移除 motion-* 后 `SMOKE_OK`、`source=procedural`（不崩） |
| 长跑稳定性 | 103s 存活、0 错误 |
| **自主行为连拍（2.25 分钟 / 90 帧）** | `tests/tmp/wave25-wander/`：0 错误；mood 序列 idle 62 / climb 15 / sit 7 / walk 6，clip 与语义一致（walk→walk、idle→idle、sit 落座→sit、攀爬→回退 B3 procedural climb）；fps 平均 28.5（min 26.3） |
| 预览器 | 全部 7 clip 7/7 断言 `PREVIEW_OK` |

## 5. 已知限制（如实记录）

1. 发辫/袖摆/布料静态（未引入 ammo.js；`physics:false`），VMD 与 MMDPhysics 互斥。
2. B3 的 6 个 idle 小手势（抛硬币等）在 VMD 待机下不可见（骨骼写入互斥）；后续可用独立 VMD 反应片段补。
3. 拖拽：当前是「一次性被甩反应 → 回退 B3 拖拽姿态」；没有「被拎起持续挣扎循环」素材。
4. sit：已修正接近阶段动画（walk/climb→sit），但缺真正的「坐下/起身」过渡片段（落座瞬间是 200ms 淡入）。
5. look-at 为 additive 近似（头/颈 30%、眼 100%），大角度不如 B3 原生自然；可调 `VMD_LOOK_AT_HEAD_SCALE`。
6. 走路/坐姿素材来自 Mixamo 示例（免费用于项目，但版本/气质有限）；想更贴角色可后续换素材。
7. 动作/VPD 文件均在 `assets/model/` 或 `tests/tmp/`（gitignore），**不随 app 分发、不进 git**。
8. **目标表面可见性过滤**（Wave 2.5 实机验证新增）：屏幕最上方被最大化窗口的顶边不再作为坐/爬目标
   （否则 50% 尺寸下宠物坐下后大半身体在屏幕外，只剩脚）。
9. **2026-11-08 用户实机反馈后的调整**：移除「爬窗」自主行为；坐姿只在**窗口上沿**（Dock/地面不再坐），
   用 hip 锚点让臀部贴窗沿、腿悬垂；接近阶段用 walk 快速滑行（不再举手爬）；戳/摸头等事件在 VMD 激活
   时不再触发 B3 骨骼反应。
10. **坐窗可见性（2026-11-08 上午补）**：只能坐**屏幕上可见的窗口顶边**——被前层窗口完全挡住的顶边
   不生成表面，部分挡住只保留露出的一段（避免「坐到下层访达上、看起来像屏幕中间虚空坐」）。因此默认
   50% 尺寸（540px）下，窗口顶边必须在 workArea 顶部往下约 0.62×宠物高 + 8px（≈343px）以下才会去坐；
   当前桌面若窗口都靠上或被遮挡，宠物就暂时不坐（这是预期行为，不是 bug）。
11. **坐姿锚点**（2026-11-08 下午修正）：`seatedAnchor="hips"` 锚 `センター`（骨盆中心）+
    `seatedAnchorOffsetUnits=3.2`，让**臀/大腿根贴窗沿**、腿悬垂（此前误锚 `下半身` 导致腰贴沿、屁股沉下去）。
12. **2026-11-08 下午批次**：拖拽改为 B3「被拎起、四肢自然下垂」（VMD 拖拽暂停，不再播甩出）；
    所有 clip 剔除 `足先EX` 轨道修脚趾上翘；落到可坐窗沿后优先坐下。**注意：动作清单/行为改动在 app
    启动时加载，改动后必须重启 `pnpm dev`（Ctrl+C 再起）才能生效**。
13. **摸头反应**（2026-11-08 下午再次调整）：移除 Mixamo Taunt（被用户指出像自卫/挑衅）→ 摸头改由
    B3 程序化反应（被摸头基底 + 反应手势）；外部真实动作的「摸头反应」暂缺，可后续用专业摸头 VMD 替换。
14. 走路已换成模之屋免费动作（qqasd「走路动作 0-39 循环」），IK on、播放速率 clamp 到 1.6；坐姿换成
   Mixamo Sitting Laughing（窗沿笑），`听歌坐姿`（晃腿）等更好的素材到货后可一行 manifest 替换。

## 6. 复现命令

```bash
# 预览某个动作的三视图 + 兼容性体检（默认隐藏窗口）
./scripts/anim-pipeline/preview/run.sh --motion assets/model/optimized/motion-walk.vmd \
  --frames 0,10,20,30 --angles front,side,45

# 重新生成走/坐/反应动作（需要对应 FBX；转换器已固化）
./scripts/anim-pipeline/reze/convert.sh <source.fbx> --bind-ref <Idle.fbx> \
  --target-pmx "assets/model/optimized/星穹铁道—砂金·戏浪.pmx" --in-place --out <dir>

# Blender VPD 姿势 → 单帧 VMD（VPD 工具链闭环）
node scripts/anim-pipeline/reze/vpd2vmd.mjs <pose.vpd> --out <out.vmd>

# 冒烟
pnpm smoke && pnpm smoke:file
```
