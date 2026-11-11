# 砂金·戏浪 动作转换验收方案（证据分级 + 两级对拍）

> 状态：2026-11-09 · 适用对象：`assets/motions/adv/**`（由 138 个 3ds Max Biped 场景转换出的 VRM clip）
> 关联：`docs/research/aventurine-reference-videos.md`（参考素材/时间码/138 take 全表）、`docs/research/wave1-15-pitfalls.md`（QA 方法论）、`docs/max-anim-conversion-plan.md`（转换路线）

## 0. 为什么不能只做"B站视频 vs 成品"一层验收

用户要求「做完去 B站/米游社找实机演示，确认转完的动作跟原本一样」。参考素材调查结论：

| 证据等级 | 覆盖动作 | 可做的事 |
|---|---|---|
| **A（金标准）** | 技能类：Skill01/02/03/04、Skill41、MazeSkill01（官方 wiki GIF + 自带中文标签的实机视频） | 逐帧/逐姿态对拍，可判"动作对不对" |
| **B（可对拍但需人眼对应）** | StandBy、AttackStandBy、Idle_Show_01/02、Common_IdleShow、Walk、Run | 节奏/姿态形状对拍，具体 take 归属需人眼确认 |
| **C** | Ready 循环、MazeAttack01、移动转身类 | 只能近似参考或跳过 |
| **E（缺口）** | 社交动作约 57 takes（Akimbo 明确叉腰/Build/Forerake/Bye/CoverMouth/ScratchHead/Shrug/Snap/StrikeChest/HoldHead/Injured/Alert/BackWard/UseHeadPhone/UseProp/Worry/Turn*/RunStop）、TeamStandBy、Hit/Die/Stun/Revive | 公开视频**没有**逐条素材，无法做"视频对拍"；2026-11-09 补采后 Talk01/02→B、HoldArm/Think/LookAtPhone/WatchPhone→C、Idle_Show 补强→B、Walk/Run→B–C（见 `docs/research/aventurine-reference-videos.md` §9）；剩余唯一可靠补法=游戏内录屏 |

因此验收拆成两层，**两层都过才算"跟原本一样"**：

### 第 1 层：源保真（导出是否把 .max 的动作原样带出来）

- 方法：`pilot` 的全场景 FBX（含模型+蒙皮+Biped 动画）在 Blender 里直接渲染 → 与官方参考（A/B 级）同姿态/同时刻对比。
- 判据：A 级动作（技能）姿态轮廓/时序错位 ≤ 1–2 帧；B 级动作节奏一致；无明显丢骨骼/反关节/scale 爆炸。
- 覆盖缺口动作的办法：**用 `.max` 源数据本身作为"原本"**——同一动画的"全场景 FBX 渲染"就是源保真的 ground truth；后续第 2 层以它为基准。这样 E 级动作也能客观验证"转换有没有走样"（走样与否 = 与源 FBX 骨架姿态的偏差）。
- 自动化指标：对每个 clip 采样每帧每骨的世界旋转/关节位置，比较「源 FBX 骨架」vs「VRM 播放结果」，输出每骨角度误差（阈值参考 Wave1：< 5° 合格，> 10° 必须查因）。

### 第 2 层：重定向保真（源骨架 → VRM humanoid 是否等价）

- 方法：同一时刻并排渲染「源 Biped 骨架/模型」与「VRM clip」的三视图 + 手脚特写（复用 `preview-hsr.mjs` 接触表工作流），叠加骨架探针。
- 判据：
  - 每帧每核心骨**局部旋转映射误差** ≤ 5°（rest-direction-fix 后；Wave1 验收口径）；
  - 手腕/脚踝世界位置差 ≤ 3–5 cm（比例差异除外）；
  - 手指/脚趾方向正确（Biped Finger0-4 语义需先验证：见 `lib/humanoid-biped.mjs` 证据）；
  - hips 高度/缩放口径正确（目标 1.122 基准，重新实测后写进报告）；
  - grounding：站立动作脚底贴地残差 ≤ 2–3cm（Wave1 为 0.4–2.2cm）；跪/躺动作显式 `grounding:"none"`，不吸地。
- 工具：`validate-adv-clips.mjs`（由 `validate-hsr-clips.mjs` 泛化）+ `preview-adv.mjs`（由 preview-hsr 泛化）+ 对拍拼图脚本（源 FBX/VRM/参考视频三列）。

## 1. 验收清单（按类别）

| 类别 | 验收动作 | 第 1 层（源保真） | 第 2 层（重定向保真） | 人眼实机 |
|---|---|---|---|---|
| 待机 | StandBy / TeamStandBy / AttackStandBy / Idle_Show_01/02 / Common_IdleShow | V10/V4/V1 对拍 + 源渲染 | 三视角接触表 + 指标 | 用户勾选 |
| 移动 | Walk / Run / WalkStop/RunStop / Turn_* | V1 对拍 | 脚掌落地/滑步指标 | 用户勾选 |
| 技能 | Skill01–04 / Skill41 / MazeSkill01 / MazeAttack01 | **A 级官方 GIF + 标签视频逐段对拍（硬门禁）** | 手/武器（无道具时的近似）姿态对拍 | 用户勾选 |
| 受击/异常 | Hit_L/Hit_H/Hit_Stun/BeHit/State_Stun*/Die*/Revive | 无视频 → 源渲染为基准 | 姿态指标 + 自然度 | 用户勾选 |
| 社交 | 25 组 AS/BS/Loop（Talk/Think/Worry/Shrug/ScratchHead/LookAtPhone/WatchPhone/UseHeadPhone/Snap/Bye/CoverMouth/Hold*/Injured/Alert/BackWard/Build/Forerake/PutHand/StrikeChest/UseProp…） | 无视频 → 源渲染为基准（记录为"源保真已验证，公开视频无法对拍"） | 指标 + 三段拼接逻辑（AS→Loop→BS?） | 用户勾选 |
| Tpose | 仅作 rest 参考，不产出 clip | — | — | — |

## 2. 三段式社交动作的处理（重要）

绝大多数社交动作在 `.max` 里是 3 段：`*AS`（A 起手）、`*BS`（B 起手）、`*Loop`（循环）。到 app 层有三种接法：
1. **只接 Loop** 作为待机变体（最安全，先把循环段跑通）；
2. **AS→Loop→BS** 编排成完整表演（需要 clip 序列能力，当前 `VrmClipPlayer` 只有单条 `playClipById`，需要 animator 层扩展——属 app 改动，先出设计再动）；
3. AS/BS 单独作为一次性过渡动作。
> 本轮验收先做 (1)+(3)，(2) 视玩家体验再定；不在验收前擅自改 app 契约。

## 3. 差异处理纪律（用户要求）

任何"和原本不一样"的差异，**先查清原因、写进报告，再改**；禁止为了"看起来顺"直接改数值。原因分类模板：
- 坐标/朝向/手性（axis/R_align/左手系）
- rest 姿态差（Biped T-pose vs 目标 T-pose）
- 骨骼语义（脊柱节数/upperChest 折叠/手指命名/脚趾）
- 缩放/单位/帧率
- 位移/grounding/in-place
- 道具/武器缺失（技能类动作源场景里可能有道具约束，我们只取骨架）
- 视频参考本身的机位/特效遮挡（判定为"参考不可用"而非"转换错"）

## 4. 交付验收物

1. `docs/wave4-adv-report.md`：转换管线 + 选片表 + 映射表 + 两级对拍结果 + 差异清单与修法。
2. `tests/tmp/adv-motion/`（私有）：samples、retarget-report、validation-report、源/VRM 对拍拼图、官方参考段截图。
3. app 内实机：用户勾选清单（待机/走路/社交/受击/技能各至少一条）。

---

## 5. 对拍工具链（2026-11-09 就绪，原型已验证）

| 工具 | 用途 | 命令示例 |
|---|---|---|
| [`render-source-fbx.py`](../../scripts/vrm/motion/render-source-fbx.py) | 源 FBX 动作渲染（网格模式 / 纯骨架模式、固定机位 front/side/threeQuarter/hand/feet、PNG+接触表+`render-meta.json`，含 action 盘点 `--list-actions`） | `"$BLENDER" -b --factory-startup --python scripts/vrm/motion/render-source-fbx.py -- --fbx foo.fbx --clip-id idle --frames 0,0.2,0.4,0.6,0.8 --views front,side,threeQuarter --out work/adv-biped/qa/render/idle` |
| [`build-compare-sheet.py`](../../scripts/vrm/motion/build-compare-sheet.py) | 三列（官方参考 / 源 FBX / VRM）或两列（源 / VRM）对比图；参考帧支持 mp4 抽帧（ffmpeg）、官方 GIF 直抽、预抽目录 | `python3 scripts/vrm/motion/build-compare-sheet.py --ref-video x.mp4 --ref-times 0,2,4 --source-dir <渲染目录> --vrm-dir <预览目录> --out work/adv-biped/qa/compare/x` |

- 原型验证（旧 HSR FBX + 现有 VRM clip）：`work/adv-biped/qa/compare/idle/idle-prototype-compare.jpg`、`.../skill01/skill01-prototype-compare.jpg`、`.../idle-layer2/...`（两列模式）；另用合成 Biped 夹具跑通网格/纯骨架/无 action/多 armature/Z-up/generic 骨名/60fps/EEVEE/Cycles 全部变体。
- 真实数据 SOP：pilot 6 个文件先 `--list-actions` 盘点 → 渲染 5 帧三视图 → 核对 `render-meta.json`（rest 高/hips 高/fps/朝向/贴地残差）→ 与官方参考拼三列图；全量 138 纯骨架先 3 帧 triage 再精验。
- 限制：官方视频机位/着装/特效不可复现，视觉对拍只能判「姿态形状/节奏」；源/VRM 比例差异用 pose 指标补齐（§0 第 2 层）。
