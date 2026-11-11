# adv 动作集接入 app 的选片提案（待用户拍板，不阻塞转换）

> 状态：**提案（2026-11-09）**·真实 FBX 未到，本文件只做决策预演，**未改动任何 app 清单/资产**。
> 依据：`clips.adv-all.json`（135 条 catalog）、规模彩排结果（adv 全进时 idle 池 15→26、walk 2→4、catalog 43→178）、`docs/adv-clip-selection.md`。
> 一句话：**catalog 全收（135 条，事件/调试可播）**；app-manifest 只装 curated 子集，否则待机轮换会太花。

## 0. 生成机制（先明白怎么改）

- app-manifest 的候选池来自**源 manifest 里 `slot` 非 null 的 clip**（`build-adv-manifest` → `build-app-manifest`）。
- 因此「哪些 adv 动作进 app」= 改 `clips.adv-all.json` 里对应 clip 的 `slot`（idle/walk/…）与 `priority`，然后重跑两条构建命令即可；不需要改代码。
- 未进 app 的 adv clip 仍保留在 **catalog**（`playClipById` 可手动播，事件层可后续接线）。
- 现有 mate/hsr 集合与所有产物的 sha256 基线在 `work/adv-biped/app/baseline/`，随时可回滚。

## 1. adv 里可用的 app 槽位资源（registry 现状）

| 槽位 | adv clip（take） | 现 priority | 说明 |
|---|---|---|---|
| idle | `idle`(StandBy) | 10 | 新角色战斗待机（最贴角色） |
| idle | `idle2`(TeamStandBy) | 5 | 队伍待机（无干净参考视频） |
| idle | `attackStandby`(AttackStandBy) | 3 | 攻击待机 |
| idle | `idleShow`(Idle_Show_01) | 8 | 站立表演 01（抛硬币等，B 级参考） |
| idle | `idleShow2`(Idle_Show_02) | 4 | 站立表演 02 |
| idle | `commonIdle`(Common_IdleShow) | 6 | 公共待机表演 |
| idle | `think01`/`worry01`/`shrug01`/`scratchHead01`/`lookAtPhone`（社交 Loop） | 2 | 5 条社交循环（可作为稀有变体，需降为负 priority） |
| walk | `walk`(Walk) | 10 | 新角色走路（B–C 参考；步频/滑步待实机） |
| walk | `run`(Run) | 4 | 跑（桌宠默认用不到，作变体） |

## 2. 三个方案

| 方案 | 进 app 的 adv clip | idle 池大小 | walk 池 | 特点 |
|---|---|---|---|---|
| **A 保守** | idle(9)、idleShow(7)、think01(-7)、worry01(-8) | 15 → **19** | 2 → 3（adv walk 5） | 只加 4 条，风险最小；先看实机观感 |
| **B 平衡（推荐）** | A + commonIdle(6)、scratchHead01(-8) | 15 → **21** | 2 → 3 | 新角色动作占比适度（6 条），稀有社交 3 条，轮换仍有节制 |
| **C 全展示** | registry 现状全进（11 idle + 2 walk） | 15 → **26** | 2 → 4 | 轮换太花（约每 10–20s 换一条，同动作久不复现）；不建议 |

> 括号里是建议 priority：idle 主/展示 6–10、稀有社交 ≤ **-7**（player 的稀有阈值/权重规则，负 priority ≥-9 才准入变体池）。
> 未进 app 的 adv clip 一律保持 catalog-only（`slot:null`），不受影响。

### 2.1 落地方式（已提供脚本，避免手改 JSON）

```bash
# 例：选方案 B → 生成 profile registry（只保留 6 条 idle + 2 条 walk 进 app，其余 slot=null）
python3 scripts/max-export/apply-adv-app-profile.py --profile B   --in scripts/vrm/motion/clips.adv-all.json   --out scripts/vrm/motion/clips.adv-all.b.json

# 真实数据到位后：
node scripts/vrm/motion/build-adv-manifest.mjs --dir assets/motions/adv --config scripts/vrm/motion/clips.adv-all.b.json
node scripts/vrm/motion/build-app-manifest.mjs
node scripts/vrm/motion/build-app-manifest.mjs --check
```

已用 135 条合成 clips 实测方案 B：app-manifest 40 条（idle **21** / walk **4**，其中 adv 8 条），catalog 仍收 178 条（adv 135 全保留）。

### 2.2 各方案对 registry 的改动（脚本内部规则，便于 review）

- 方案 A：`idle2/attackStandby/idleShow2/commonIdle/lookAtPhone/shrug01/scratchHead01` 的 slot → null；`idle→idle(9)`、`idleShow→idle(7)`、`think01→idle(-7)`、`worry01→idle(-8)`；`walk→walk(5)`、`run→walk(4)`（run 保持变体）。
- 方案 B：在 A 基础上保留 `commonIdle→idle(6)`、`scratchHead01→idle(-8)`。
- 方案 C：不做改动（registry 现状即全进），仅调整优先级。

## 3. 需要你拍板的 4 个问题

1. **主待机要不要换**？
   - 现状：`hsr-idle`（旧角色战斗待机，priority 10）是主待机；adv 的 `StandBy` 是新角色本体的待机。
   - 选项：① 先保持旧主待机、adv 作变体（方案 A/B，最稳）；② 直接把 adv-idle 提为主（需把 hsr-idle 降到 9 或加 `PRIORITY_OVERRIDES`；实机对比后再定）。
2. **待机池规模选 A(19) / B(21) / C(26)？**（推荐 B）
3. **走路**：保持 `mate-walk` 为主 + `adv-walk` 变体（推荐，mate 已调过步频）；还是让 `adv-walk` 当主（新角色动作，但需先看实机滑步/步频）？
4. **DSH 事件动作是否替换/扩展**？
   - 现状：dshBusy=hsr commonIdle、dshDone=mate happy、dshError=hsr breaked/revive 编排（已验收）。
   - 可选：dshBusy 换成 adv `think01` 循环（更贴"忙碌思考"）；dshDone 加 adv `Snap01Loop`/`Bye01` 作为随机变体；dshError 保持现状（冒险改已有编排不划算）。
   - 这些属于行为/事件层，建议 Phase 2 再动。

## 4. 推荐执行顺序（真实数据验收后）

1. 先按**方案 B** 落地（改 registry slot/priority → 重建 adv manifest → 重建 app 清单 → `--check`）；
2. app 实机给用户看 3–5 分钟（待机轮换/走路/社交稀有），收集观感；
3. 按反馈微调 priority/名单（每次只改 registry + 重跑两条命令，可 `--check` 校验、可回滚）；
4. 稳定后再考虑 DSH 事件扩展（属行为层改动，先出设计）。
