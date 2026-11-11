# 砂金·戏浪 官方动作包（3ds Max Biped）→ VRM 桌宠动作 转换计划

> 状态：**2026-11-09 调查完成，路线已定（Windows 3ds Max 试用 → FBX → macOS 重定向）**
> 输入：`/Volumes/4TB外置盘/百度网盘/砂金戏浪.zip`（617 MB；**138 个 `.max` + 35 个贴图/材质辅助文件**，解压 3.27 GB）
> 目标产物：`assets/motions/adv/**`（私有）clip JSON + manifest/catalog 接入 + 视觉对拍验收
> 关联：`docs/research/wave1-15-pitfalls.md`（两波踩坑）、`docs/vrm-motion-hsr.md`、`docs/research/max-windows-routes.md`、`docs/research/max-importer-capabilities.md`、`docs/research/aventurine-reference-videos.md`

---

## 0. 结论摘要

1. 新动作包与 Wave 1（HSR 官方 `Avatar_Aventurine_00.fbx`）/ Wave 1.5（Mate-Engine Unity `.anim`）**格式完全不同**：
   - 每个 `.max` 是 **3ds Max 2021 场景**（OLE/CFB 容器、`Scene` stream；`DllDirectory` 含 `biped.dlc`/`Biped Controller`；`ClassDirectory3` 含 `Biped`/`BipSlave`）；
   - 场景内是 **完整 Avatar_AventurineW_00 模型 + 标准 3ds Max Biped 骨架**（`Bip001 Pelvis/Spine/Spine1/Spine2/Neck/Head/L|R Clavicle/UpperArm/Forearm/Hand/Thigh/Calf/Foot/Toe0/Finger0-4`，含 Nub/Footsteps），
     贴图路径来自数据挖掘机 `G:\game_ziyuan\...\Animator\Avatar_AventurineW_00\`（本包已带 35 张）；
   - 这是 **HSR 4.5 新角色「砂金·戏浪」（SP 砂金）的官方动作源**，含 138 个动作/分身段（社交、移动、战斗、受击、技能、待机表演）。
2. 旧 FBX 帮不上忙的实测证据：`Avatar_Aventurine_00.fbx` 里 `Adv_Ani_*`（社交/移动）take 虽然存在，但 **0 根核心人形骨有动画**（只动头发/布料/脸），身体动画不在其中 → 必须从 `.max` 取。
3. 离线路线结论（`docs/research/max-importer-capabilities.md`）：Blender 官方 `io_scene_max` 只能导入网格/材质，Biped 只建成空物体、**无骨骼动画/蒙皮**；目前没有可用的 macOS 离线 `.max→骨骼动画` 方案。
4. 因此走：**用户 Windows PC 装 3ds Max 官方试用 → 我们的一键 MaxScript 批量导出 FBX（只导骨架+动画）→ macOS Blender 采样 → Biped→VRM humanoid 重定向（复用 rest-direction-fix/QA）→ 对拍验收**。
5. 用户已确认：**有 Windows 电脑、没有 3ds Max、可自己注册/登录 Autodesk 账号**。

---

## 1. 资产清单（138 个 .max，按用途分类）

| 类别 | 文件（去重后） | 说明 |
|---|---|---|
| 绑定姿态 | `Tpose` | Biped bind/T-pose，重定向 rest 参考（**必须导**） |
| 战斗待机/队伍 | `StandBy`（另有 `StandBy (2)` 复本）、`StandBy (2)`、`TeamStandBy`、`AttackStandBy` | 主 idle 候选 |
| 待机表演 | `Idle_Show_01`、`Idle_Show_02`、`Common_IdleShow` | 长待机展示（Wave1 已有旧版，新版可替换） |
| 社交（三段式 AS/BS/Loop） | `Akimbo01`、`Akimbo02`（含 Hand 变体）、`Alert01`、`BackWard01`、`Build02`、`CoverMouth01`、`Forerake02`、`HoldArm01`（含 Hand）、`HoldHead01`、`Injured01`、`LookAtPhone`、`PutHand01`、`ScratchHead01`、`Shrug01`、`Snap01`、`StrikeChest01`、`Think01`（含 Hand）、`UseHeadPhone01`、`Worry01`、`Worry02` | 每个动作有 `*AS`（A 起手）/`*BS`（B 起手）/`*Loop`（循环）三段，另 `Hand*` 为手部变体 |
| 社交（单段） | `Talk01`、`Talk02`、`Bye01`、`WatchPhone01*`、`LookAtPhoneLoop`、`UseProp01/02` | 完整单段或特殊 |
| 移动 | `Walk`、`WalkStop_L/R`、`Run`、`Run_BS_L/R`、`Run_TurnLeft/Right_L/R`、`RunStop_L/R`、`FastRun`、`FastRunStop_R`、`FastRun_TurnRight_L`、`Turn_45/90/180_L/R` | 宠物走路/转身/跑动候选 |
| 战斗 | `Skill01`、`Skill02`、`Skill03`、`Skill04`（+`Skill04 (2)` 复本）、`Skill41`、`MazeSkill01`、`MazeAttack01`、`Skill01_Ready(_Loop)`、`Skill02_Ready_Loop`、`Skill03_Ready`、`Skill04_Ready(_Loop)`、`Skill01ReadyBS/BSLoop`、`Skill01toSkill02`、`Skill02toSkill01` | 技能/大招/秘技/Ready 循环 |
| 受击/异常/死亡 | `BeHit`、`Hit_H`、`Hit_L`、`Hit_Stun`、`State_Stun`、`State_Stun_Loop`、`State_Stun_Recover`、`Die`、`Die_Loop`、`Revive` | 反应/倒地/复活 |
| 复本（需二选一） | `StandBy (2)` vs `StandBy`；`Skill04 (2)` vs `Skill04`；`Skill01ReadyLoop/Skill01ReadyBS` vs `Skill01_Ready_Loop/Skill01_Ready`；`Skill02ReadyLoop` vs `Skill02_Ready_Loop`；`Skill04_Ready` vs `Skill04_Ready_Loop` | 文件修改时间不同（11-08 vs 11-09），需导 FBX 后对比曲线/时长再定，禁止盲选 |

> 完整文件名/大小清单见 `work/max-inventory.md`（生成：`python3 scripts/max-export/inventory.py --zip "<砂金戏浪.zip>" --out work/max-inventory.md`，已生成：138 max / 3.02 GiB / 分类 bind 1 · combat-idle 4 · idle-show 3 · locomotion 21 · combat-skill 19 · combat-react 10 · social 80）。
> 每个 .max 20–75 MB，其中绝大部分是重复的模型网格；**导出时只保留 Biped 骨架+动画**（删除几何体后导出），预计每个 FBX ≪ 1 MB，全量 ~50–150 MB，便于回传。

---

## 2. 数据流转（这条线决定协作方式）

```
Mac: 砂金戏浪.zip (百度网盘同步目录)
  └─ 用户在 Windows 的百度网盘客户端下载同一文件（同账号）→ 解压 D:\砂金戏浪\
Windows: 3ds Max 2026/2027 试用 + scripts/max-export/export-clips.ms（本仓库提供）
  └─ 批量导出 D:\aventurine-fbx\*.fbx + export-log.txt
  └─ 打包 zip → 用户上传百度网盘 → Mac 端 /Volumes/4TB外置盘/百度网盘/ 自动同步
Mac: 采样 + 重定向 + QA + 对拍 + 接入 app（本仓库继续）
```

> 备选传输：用户把 Windows 与 Mac 放同一局域网，Mac 开 SMB/文件共享；或 U 盘（需 exFAT 格式）。**不要**让用户把 .max 单独传到别处再转——保持原包完整。

---

## 3. 分阶段计划

### 阶段 A（用户侧，今天开始）：装 3ds Max 试用 + 试点 6 个文件
- 用户按 `docs/user-3dsmax-export-guide.md`：Autodesk 账号 → 3ds Max 免费试用下载（约 10 GB）→ 安装 → 登录。
- 试点导出 **6 个代表性文件**（覆盖不同类别、便于我们验证格式/坐标/骨骼命名/帧率）：
  `Tpose`、`StandBy`、`Walk`、`Talk01`、`Skill01`、`State_Stun`。
- 回传 `pilot-fbx.zip` + `export-log.txt`；我们做**格式验证**（Blender 导入是否成功、骨骼列表是否标准 Biped、帧率/单位/时长、动画是否真的有身体曲线）。
- 门禁：试点 FBX 在 Blender 中可导入、52/22 核心骨有 fcurve、动画时长≈官方演示时长；否则**先修导出设置再继续**（禁止拿不合格数据做全量）。

### 阶段 B（用户侧）：全量导出 138 个
- 试点通过后跑全量脚本 → 回传 `aventurine-fbx-all.zip`。
- 脚本对每个文件输出：FBX + 日志行（场景 FPS、帧范围、Biped 骨骼数、导出耗时、错误）。

### 阶段 C（Mac 侧）：采样 + 重定向
- 新脚本 `scripts/vrm/motion/extract-biped-anims.py`：Blender 导入 FBX → 按 30fps 采样全部 Biped 骨 → `samples.json`（复用 `extract-hsr-anims.py` 结构，字段兼容）。
- 新脚本 `scripts/vrm/motion/retarget-biped.mjs` + `lib/humanoid-biped.mjs`：
  - Biped 骨名 → VRM humanoid 映射（22 核心 + 30 手指；Biped 5 指 × 3 节 + 拇指语义待试点数据确认）；
  - 延用 Wave1 的 **world-rotation-delta + per-bone rest-direction-fix**（`lib/rest-direction-fix.mjs`）以消除 Biped 与目标 T-pose 的 rest 差；
  - 目标缺 `upperChest`（tpose VRM 53 骨无 upperChest）→ Biped `Spine2` 旋转按 Wave1 口径并入 `chest`，clip 仍写满 22 骨契约；
  - Hips 位置：`in-place` 处理（水平归零；大位移段归零）+ `normalizedRestPose.hips.y / sourceHipsHeight` 缩放（目标 1.122 基准，以实测 samples 为准重新算）；
  - `grounding`：站立动作 `feet`；跪/躺/死亡类显式 `none`（Wave1 教训：未标注会被 pose 兜底吸地）；
  - `rawPolicy=spring`（目标自带 SpringBone，raw 留空）。
- 门禁：`validate-hsr-clips` 等价校验器（可泛化为 `validate-clips.mjs`）→ PASS；三视角 contact sheet 与官方参考视频同机位比对。

### 阶段 D（Mac 侧）：对拍验收（用户要求硬性）
- 参考视频：`work/ref-aventurine/**`（`docs/research/aventurine-reference-videos.md` 有动作→URL→时间段对照表）。
- 对每条要接入的 clip：官方实机片段 vs 我们渲染片段，同姿态/同时刻对比；差异逐条记录原因（坐标/rest/手指/道具/位移/grounding…），**先查清原因再改**。
- 用户验收：实机在 app 里看（待机/走路/社交/受击/技能各至少一条）。

### 阶段 E（Mac 侧）：接入 app
- `assets/motions/adv/**` + manifest（新动作集 `adv`）+ `app-catalog.json`/`app-manifest.json` 增补；
- `src/renderer/src/vrm/**` 如需扩展（事件触发新 clip）先出设计再改；
- `pnpm typecheck` + `pnpm test` + `pnpm smoke` 全绿；文档 `docs/wave4-adv-report.md`。

---

## 4. 风险与对策

| 风险 | 对策 |
|---|---|
| 用户 Windows 上 Autodesk 下载慢/试用不可用 | 备选：云 Windows（按量付费）、或用户从 3ds Max 订阅/教育版渠道；先试点验证再全量 |
| 3ds Max 打开 2021 场景报缺失贴图/缺失插件（Corona/Vray/Arnold） | 只要 Biped+动画，缺贴图可忽略；脚本用 `quiet` 加载 + 用户遇到弹窗手动 "Skip All"；日志留证 |
| Biped 导出 FBX 后骨骼名/层级与预期不同（Nub、BipSlave、缩放） | 试点先验证；采样器按实际骨名自适应；映射表放 `lib/humanoid-biped.mjs` 可改 |
| 场景帧率不统一（30/60） | MaxScript 读 `frameRate` 写日志；采样器按 FBX 自带 time mode；重定向按每 clip 实际时长 |
| 本地 60 帧动作被 30fps 采样丢细节 | 与 Wave1 同口径（30fps 输出，采样前先低通？沿用 W1 做法）；如发现抖动再评估 60fps |
| Biped 与目标 rest 差异导致常量偏转 | 强制 rest-direction-fix + GT 对拍（Wave1 已踩过，0.37–0.45 m 级别误差） |
| 手指语义（Biped Finger0=拇指?） | 试点帧用 Tpose 与目标 T-pose 双手特写对拍确认，禁止凭猜 |
| 社交三段式 AS/BS/Loop 语义 | 按官方演示确认拼接顺序；先只接 Loop 与单段，AS/BS 作为 transition 候选 |
| 版权 | 官方游戏资源，私有本机使用，禁止再分发/提交 git（`assets/motions/**` 已 gitignore） |

---

## 5. 待办（Lead 跟踪）

- [ ] 用户装好 3ds Max、版本号回报 → `docs/user-3dsmax-export-guide.md` 校准
- [ ] 试点 6 文件导出验证（格式/骨架/帧率/身体曲线）
- [ ] 全量导出 138 文件
- [ ] `extract-biped-anims.py` + `retarget-biped.mjs` + 合成 Biped 测试（Mac 侧可先做）
- [ ] clip 选片表（按 app 状态需求 + 官方语义）
- [ ] 对拍验收报告 + app 接入 + 测试

---

## 6. 进度更新（2026-11-09 下午 · Mac 侧预备全部完成）

- **Windows 侧**：用户已确认 Windows 11；`scripts/max-export/` 工具包（pilot 双变体 + 全量骨架版）与 `docs/user-3dsmax-export-guide.md` 已交付，等用户装 3ds Max 2027 试用后跑 pilot。
- **Mac 侧管线（已完成并验证）**：
  - 采样：`extract-biped-anims.py`（Biped FBX→samples.json，schema 同 HSR；per-clip sourceFps、Tpose-rest 优先、take 回退、linked-bone 修复）——`verify-biped-sampler.py` **334/334 PASS**（含 HSR 零回归 23/23）。
  - 重定向：`lib/humanoid-biped.mjs` + `retarget-adv.mjs` + `clips.adv.json`（25 条首批）；lib 可插拔 source 纯增量；HSR retarget **14/14 clip SHA-256 逐字节零回归**；`pnpm test` 105 files/1816 passed、`pnpm typecheck` 0。
  - 工具链：`build-adv-manifest.mjs` / `validate-adv-clips.mjs` / `preview-adv.mjs`；合成夹具全链路冒烟 PASS（PASS 2/WARN 0/FAIL 0）。
  - 对拍工具：`render-source-fbx.py` + `build-compare-sheet.py`（原型验证中，见 task-7）。
- **验收/选片**：`docs/adv-acceptance-plan.md`（两级对拍）、`docs/adv-clip-selection.md`（catalog 全收 / app-manifest 精选）。
- **下一步**：用户 pilot FBX 回传 → 格式验证（骨架/动画完整性/单位/fps）→ 放行全量 138 → 真实数据跑 §0 管线 → 对拍验收 → app 接入（需用户确认选片）。

## 7. 进度更新（2026-11-09 傍晚 · 对拍工具链就绪）

- `scripts/vrm/motion/render-source-fbx.py`（源 FBX→固定机位渲染/接触表/render-meta）+ `build-compare-sheet.py`（官方参考|源|VRM 三列对比）已完成原型验证（旧 HSR FBX + 现有 VRM clip + 官方视频/GIF 均跑通；合成 Biped 夹具 7 种数据变体全跑通），SOP 见 `docs/adv-acceptance-plan.md` §5、`work/adv-biped/qa/REPORT.md` §7。
- 至此 **Mac 侧全链路 100% 就绪**：采样 → 重定向 → manifest → validate → preview → 源保真渲染 → 三列对拍。唯一阻塞 = 用户 Windows 侧 3ds Max 2027 试用安装 + pilot/全量 FBX 回传。

## 8. 进度更新（2026-11-09 · app 接入预备与全量选片完成）

- **全量 catalog 选片 registry**：`scripts/vrm/motion/clips.adv-all.json`（138 .max → 135 clip；25 首批沿用 + 110 启发式；Tpose/2 个复本排除；idle 11 / walk 2 / catalog-only 122）。生成器 `scripts/max-export/gen-adv-registry.py`。
- **一键管线**：`scripts/vrm/motion/run-adv-pipeline.sh`（pilot/full 双模式：采样→覆盖门禁→重定向→manifest/validate→preview；已用合成夹具实测含 Electron 预览）。
- **app 接入预备**：`build-app-manifest.mjs` 支持 adv 可选源集（缺省时整集跳过，现有 app-manifest/catalog **sha256 逐字节不变**、`--check` PASS；合成 adv fixture 10 用例、`pnpm test` 1826 passed）。详见 `docs/adv-app-integration.md`。
- **仍阻塞**：用户 Windows 侧 3ds Max 2027 试用安装 + pilot/全量 FBX 回传。数据到位后的操作顺序 = `docs/adv-pipeline-commands.md`（或一键脚本 run-adv-pipeline.sh）。
