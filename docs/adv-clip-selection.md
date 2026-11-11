# 砂金·戏浪 动作集（138 take）选片与接入设计

> 状态：2026-11-09 · 设计稿（**选片需 user 确认后才动 app-manifest**；本轮只做 catalog/资产）
> 输入：`/Volumes/4TB外置盘/百度网盘/砂金戏浪.zip` 实测 138 个 `.max`（清单见 `work/max-inventory.txt` 生成脚本 `scripts/max-export/inventory.py`）
> 参考证据：`docs/research/aventurine-reference-videos.md`（A/B/C/E 级）
> 验收口径：`docs/adv-acceptance-plan.md`
> 现有 app 状态：mood 契约 = `idle/walk/sit/pat/sleep/drag/salute` + V7 的 `dshBusy/dshDone/dshError`；现网 idle 池 = hsr 5 + mate 7 + 稀有 pose1-3；walk = mate 2；现有 43 条 catalog

## 0. 总原则

1. **catalog 全收、app-manifest 精选**：138 take 全部转 clip 进 catalog（事件/调试可 `playClipById`），app-manifest 只接**真正常用**的少量（避免 idle 池被 30+ 社交变体冲爆、轮换变怪）。
2. **不动冻结契约**：不新增 PetMood；新动作先走「既有 mood 的变体」或「事件一次性播放」；需要新状态（如社交闲聊模式）时单独出设计给 user 拍板。
3. **三段式先接 Loop**：`*AS`/`*BS` 作为 catalog-only 过渡；Loop 才进 idle 稀有池（理由见 §3）。
4. **旧集不删**：hsr/mate 动作保留为回退；user 实机观感确认新集更贴角色后再降 priority。

## 1. 选片表（建议）

### 1.1 核心状态（app-manifest 候选）

| adv clip id | 源 take | mood/slot | loop | priority | fade | grounding | 参考等级 | 说明 |
|---|---|---|---|---|---|---|---|---|
| `adv-idle` | `StandBy` | idle | ✓ | **10** | 0.15/0.2 | feet | V10/V4 | 新主待机（角色本体的战斗待机）；是否替换 hsr-idle 由 user 实机决定 |
| `adv-idle2` | `TeamStandBy` | idle | ✓ | 8 | 0.2/0.2 | feet | E | 队伍待机（无干净视频，源保真验证） |
| `adv-idle3` | `AttackStandBy` | idle | ✓ | 7 | 0.2/0.2 | feet | B | 攻击待机 |
| `adv-idleShow` | `Idle_Show_01` | idle | ✓ | 6 | 0.4/0.3 | feet | B | 站立动作 01（抛硬币等） |
| `adv-idleShow2` | `Idle_Show_02` | idle | ✓ | 6 | 0.4/0.3 | feet | B | 站立动作 02 |
| `adv-commonIdle` | `Common_IdleShow` | idle | ✓ | 5 | 0.4/0.3 | feet | B | 公共待机表演 |
| `adv-walk` | `Walk` | walk | ✓ | 10 | 0.2/0.2 | feet | B–C | 新走路（替代/并列 mate-walk；需测步频、滑步） |
| `adv-walkStopL/R` | `WalkStop_L/R` | — | ✗ | — | — | feet | C–E | catalog-only 过渡 |
| `adv-run` | `Run` | — | ✓ | — | — | feet | C–E | 暂不接；桌宠默认走不跑，留 catalog |
| `adv-dshBusy` | `Think01Loop` | dshBusy | ✓ | 0 | 0.3/0.3 | feet | E | DSH 忙碌时"思考"待机（比 hsr-commonIdle 更贴语义） |
| `adv-dshDone` | `Snap01Loop` 或 `Bye01` | dshDone | ✗(一次性) | 0 | 0.15/0.3 | feet | E | 任务完成：打响指/告别；需 user 选 |
| `adv-hit` | `Hit_L` | dshError 变体 | ✗ | 0 | 0.15/0.2 | feet | E | 受击反应（替代/争用 hsr-hitL） |
| `adv-stunLoop` | `State_Stun_Loop` | dshError 兜底 | ✓ | -1 | 0.2/0.25 | none | E | 眩晕循环 |
| `adv-die` | `Die` | — | ✗ | — | — | none | E | catalog（倒地表演） |
| `adv-revive` | `Revive` | — | ✗ | — | — | none | E | catalog（起身） |

> priority/间隔仅建议值；app-manifest 生成器有 `MOOD_CLIP_ALIASES`，新集接入需扩 `build-app-manifest.mjs`（属 app/集成改动，Lead 先评审再动）。

### 1.2 idle 稀有社交变体（建议先接 6–8 条，其余 catalog-only）

从 25 组社交 Loop 中挑"宠物用得自然"的先接：`Think01Loop`、`Worry01Loop`、`Shrug01Loop`、`ScratchHead01Loop`、`LookAtPhoneLoop`、`WatchPhone01Loop`、`Snap01Loop`、`Akimbo01Loop`。
- 进 idle 变体池 priority 建议 **-7 ~ -8**（稀有，符合 player 的 rare threshold）；间隔 4–8 分钟；fade 0.8/1.0
- 排除：`Build02Loop`/`Forerake02Loop`（需要道具/环境道具，脱离场景会奇怪）、`Injured01Loop`（受伤害语义，只做事件）、`HoldHead01Loop`/`StrikeChest01Loop`（夸张表演，catalog 留）。

### 1.3 catalog-only（先全量收，不接状态）

- 全部 25 组社交的 `AS`/`BS`/`HandAS`/`HandBS`/`HandLoop` 变体；
- 移动过渡：`WalkStop_L/R`、`Run_BS_L/R`、`Run_TurnLeft/Right_L/R`、`RunStop_L/R`、`FastRun*`、`Turn_45/90/180_L/R`；
- 技能/战斗：`Skill01/02/03/04/04(2)/41`、`MazeSkill01`、`MazeAttack01`、`Skill0X_Ready`/`Ready_Loop`/`ReadyBS`、`Skill01toSkill02`、`Skill02toSkill01`；
- 受击/异常：`BeHit`、`Hit_H`、`Hit_L`、`Hit_Stun`、`State_Stun`、`State_Stun_Loop`、`State_Stun_Recover`、`Die`、`Die_Loop`、`Revive`；
- 社交单段：`Talk01`、`Talk02`、`Bye01`、`UseProp01/02`。

### 1.4 不产出 clip

- `Tpose`（rest/bind 参考，用于重定向基准与验证，不进 catalog）
- 复本去重：`StandBy (2)` vs `StandBy`、`Skill04 (2)` vs `Skill04`、`Skill01ReadyLoop` vs `Skill01_Ready_Loop`、`Skill02ReadyLoop` vs `Skill02_Ready_Loop`、`Skill04_Ready` vs `Skill04_Ready_Loop`、`Skill01ReadyBS` vs `Skill01_Ready`：**先都导 FBX，比较帧数/首末帧/曲线一致性后二选一**（时间戳不同，禁止盲选）。

## 2. 与现有 app 状态的冲突处理

| 冲突 | 处理 |
|---|---|
| 新 `adv-idle` 与 hsr `idle` 同槽 | 先并列（adv 10 > hsr 10? 同优先级会随机；建议 adv=10、hsr 降到 9）——**需 user 同意替换主待机** |
| 新 `adv-walk` 与 mate-walk | 先并列，实机看步频/滑步；user 选一个主走路 |
| dshError 已有 hsr-breaked/revive 编排 | adv 的 Hit/Stun/Die/Revive 先 catalog-only，**不改**现有 dshError 编排 |
| idle 变体池容量 | 现网 12 普通 + 3 稀有；新增 adv 核心 idle 6 条 + 稀缺 6-8 条 → 需重算权重，避免稀有变体太频繁（保持 ≈3–5 分钟一次） |

## 3. 待数据验证的假设（不许当结论用）

1. **`*AS`/`*BS`/`*Loop` 语义**：命名推测 A/B 为两种起手、Loop 为循环；验证方法：对每个三段组，比较 `Loop` 首帧 vs 末帧（应可循环）、`AS` 末帧 vs `Loop` 首帧、`BS` 末帧 vs `Loop` 首帧的姿态差；差异 ≤ 阈值才按"起手→循环"编排，否则只接 Loop。
2. **`Finger0-4` 是否对应拇指..小指**：用 Tpose FBX 与目标 VRM T-pose 拇指位置/朝向对照 + 社区文档双证；不成立则按实际几何重排映射。
3. **场景 fps / 单位**：MaxScript survey 结果（用户回传 `export_log.txt`）为准；不假设 60fps。
4. **是否有道具骨骼动画**（UseProp/WatchPhone 等）：`.max` 里可能有独立道具网格+约束；我们只取骨架，道具不存在 → 这些动作即使转换成功，观感也会"手上有东西但看不到"；文档标注，是否接由 user 定。
5. **技能动作的镜头/特效**：官方演示含镜头运动与特效，我们只对拍角色姿态，不还原镜头/特效。

## 4. 接入步骤（数据通过验收后）

1. `assets/motions/adv/**`（138 clip，私有）+ `manifest.json`/`index.json`（新 `build-adv-manifest.mjs`，由 hsr 版泛化）；
2. `build-app-manifest.mjs` 扩 adv 集：核心状态 + 稀缺池（**先出 diff 给 user 确认**）；
3. `clip-registry.ts` 读取新清单（如已参数化则零改动）；
4. `pnpm typecheck` + `pnpm test` + `pnpm smoke`；实机给 user 看；
5. 旧集保留回退，user 满意后再决定是否把 hsr-idle/hsr-walk 降级。
