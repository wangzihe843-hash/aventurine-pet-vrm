# Pilot FBX 回传后的处理与验收 Runbook（6 个试点文件）

> 适用：用户 Windows 侧第一次跑 `run_pilot.bat` 后回传的 `fbx-pilot`（6 个动作 × 全场景/_skel 两版 + 日志）。
> 目标：**在放行全量 138 之前**验证「导出格式/骨架/动画/单位/fps」都符合预期，并让 pilot 的 6 个动作走完两级对拍。
> 关联：`docs/adv-pipeline-commands.md`（全量管线）、`docs/adv-acceptance-plan.md`（两级验收口径）、`docs/research/aventurine-reference-videos.md`（参考源/时间码）、`work/adv-biped/qa/REPORT.md` §7（渲染对拍 SOP）。

## 0. 收到文件后第一件事：核对回传物

- [ ] `fbx-pilot/` 里应有 ≥12 个 FBX：`Tpose/StandBy/Walk/Talk01/Skill01/State_Stun` 各 `*.fbx` + `*_skel.fbx`
- [ ] `export_log.txt`：6 行 OK、无 FAIL；记录每行 `fps=` / `unit=` / `frames=` / `MB=`
- [ ] `listener.log` / `max.log` 无红色错误（有则记入报告）
- [ ] 文件大小：全场景版应明显大于 `_skel` 版（`_skel` 预期 0.1–2MB；若 `_skel` 为 0 字节 → 导出失败）

> 存放：解压到 `tests/tmp/adv-pilot/fbx/`（`tests/tmp` 已 gitignore，私有）。

## 1. 格式/骨架/单位/fps 验证（硬门禁）

```bash
cd /Volumes/4TB外置盘/deepseek-harness/aventurine-pet-vrm
BLENDER=/Volumes/4TB外置盘/deepseek-harness/tools/blender/Blender.app/Contents/MacOS/Blender
PILOT=tests/tmp/adv-pilot

# 1a) 逐文件盘点 action / 骨数 / 帧范围 / fps（不渲染，几秒/文件）
#     输出是一行 LIST_ACTIONS_JSON（含 armatures/bones/actions/frameStart/frameEnd/sceneFps）
for f in "$PILOT"/fbx/*.fbx; do
  echo "== $(basename "$f")"
  "$BLENDER" -b --factory-startup --python scripts/vrm/motion/render-source-fbx.py -- \
    --fbx "$f" --list-actions 2>&1 | grep -E 'LIST_ACTIONS_JSON|scene:'
done > "$PILOT/list-actions.txt" 2>&1

# 1b) 采样（pilot 用 25 条 registry；覆盖 6/25 是预期）
scripts/vrm/motion/run-adv-pipeline.sh --fbx-dir "$PILOT/fbx" --mode pilot \
  --tmp-dir "$PILOT/pipeline" --skip-preview

# 1c) 自动跑 G0–G6 门禁并生成报告（PASS/FAIL/WARN 表格 + JSON）
python3 scripts/vrm/motion/verify-pilot.py --dir "$PILOT"
#    默认期望 pilot clip = idle,walk,talk01,skill01,stun；如 pilot 名单有变用 --expect 覆盖
#    产物：$PILOT/PILOT-VERIFY.md / $PILOT/PILOT-VERIFY.json（exit 0 = 全过）
```

**门禁（全过才放行全量；由 `verify-pilot.py` 自动判定）**：

| # | 检查 | 通过标准 | 不通过怎么办 |
|---|---|---|---|
| G1 | 骨架识别 | 每个 FBX 1 个 armature；Biped 骨名（`Bip001 Pelvis/Spine/.../L UpperArm/...`）或可被采样器解析的变体；骨数 ≥ 60 | 记录实际骨名 → 更新 `lib/humanoid-biped.mjs` 匹配器（先改后跑，禁盲改） |
| G2 | 动画存在 | 6 个动作 FBX 都有 action；帧数 > 0；核心骨有动画（采样器 report 无「config 未匹配」警告） | 看 `listener.log` 是否 bake 失败；跑 `diagnose_max.ms` 回传 |
| G3 | 单位/比例 | `samples.sourceHipsHeightMeters` ≈ 0.9–1.1（Biped 米制口径约 0.95）；`sourceHeightMeters` ≈ 1.6–1.9；与旧 HSR FBX（1.839/0.9502）差 <5% | 单位不对 → Windows 侧 `export_log.txt` 的 `unit=` 与 Max 场景单位核对；必要时统一以 cm 重导 |
| G4 | fps | report 的 `sourceFpsByFile`：每个文件 30 或 60（可混，per-clip 已支持）；`srcFrames` 与动作时长一致（例如 StandBy 若 60fps×121 帧≈2s） | 记录实际值；与官方演示节奏对比确认没有慢放/快放 |
| G5 | Tpose rest | 采样器 report `restSource.reason = tpose-prefer`；Tpose 不产 clip；rest 为 T-pose（手臂水平、掌心向下） | rest 非 T-pose → 检查 Tpose.max 是否 Figure Mode；必要时用 Tpose FBX 重导/重采 |
| G6 | 重定向 | `retarget-adv` 6/6 PASS、无 FAIL；`restFixMismatchMax` 有合理值（预期 30–60°，手臂 rest 差）→ 说明 rest 修正生效 | FAIL 先看 `mapping-report.json` 与 report 的 warnings；禁止直接放宽阈值 |

> G1–G6 的原始输出都要贴进 `docs/wave4-adv-report.md` 的「Pilot 验证」节。

## 2. 两级对拍（pilot 6 个动作）

### 2.1 参考映射（pilot 片段）

| Pilot clip | 参考等级 | 参考素材（`work/ref-aventurine/`） | 时间段 | 对拍方式 |
|---|---|---|---|---|
| `Tpose` | n/a | — | — | 只做 rest 数值检查（G5）+ 源渲染 vs 目标 VRM rest 对比图 |
| `StandBy`（战斗待机） | B | `video/BV1mYTn6dEQL-…mp4`；[`clips/xilang_standby_battle_arena_戏浪战斗待机.mp4`](../../work/ref-aventurine/clips/xilang_standby_battle_arena_戏浪战斗待机.mp4) | 0:00–0:10.6 | 源 FBX vs 官方视频：姿态轮廓/呼吸节奏 |
| `Walk` | B–C | `video/BV1JSev6xEfz-…mp4`；[`clips/xilang_walk_run_trial_走路跑步.mp4`](../../work/ref-aventurine/clips/xilang_walk_run_trial_走路跑步.mp4) | 0:03–0:17 | 源 FBX vs 官方视频：步频/摆臂相位；机位差大，只判节奏 |
| `Talk01` | **B**（2026-11-09 补采） | [`clips/social_45cut_hall_dialogue_33-20_34-40_B级.mp4`](../../work/ref-aventurine/clips/social_45cut_hall_dialogue_33-20_34-40_B级.mp4)（4.5 千星城大厅对话，同角色说话手势） | 全段（33:20–34:40 剧情段） | 源 FBX vs 官方剧情帧（姿态/节奏）+ 源 vs VRM；take01/02 具体对应需人眼确认 |
| `Skill01`（普攻） | **A（金标准）** | [`clips/official_skill_puwang_普攻.mp4`](../../work/ref-aventurine/clips/official_skill_puwang_普攻.mp4)（官方 GIF）；[`clips/labeled_puwang_普攻.mp4`](../../work/ref-aventurine/clips/labeled_puwang_普攻.mp4)（含中文标签） | GIF 全段；视频 0:00–0:02.2 | 源 FBX vs 官方 GIF 帧（第 1 层）+ 源 vs VRM（第 2 层） |
| `State_Stun` | **E（缺口）** | 无干净素材 | — | 源 vs VRM 两列 + 自然度检查（对外口径：源保真+重定向保真已验证，公开视频无法对拍） |

### 2.2 命令

```bash
# 第 1 层：源 FBX 渲染（用全场景版，含模型；固定机位三视图 5 帧）
"$BLENDER" -b --factory-startup --python scripts/vrm/motion/render-source-fbx.py -- \
  --fbx "$PILOT/fbx/Skill01.fbx" --clip-id skill01 \
  --frames 0,0.2,0.4,0.6,0.8 --views front,side,threeQuarter --res 512x768 \
  --out "$PILOT/source-render/skill01"

# 第 2 层：VRM 预览（pipeline 产物；或用 preview-adv.mjs 指定 clip）
node scripts/vrm/motion/preview-adv.mjs --clips skill01,idle,walk \
  --clips-dir "$PILOT/pipeline/clips" --out "$PILOT/vrm-preview" \
  --frames 0,0.2,0.4,0.6,0.8 --views front,side,threeQuarter

# 三列对比图（官方参考 | 源 FBX | VRM）
python3 scripts/vrm/motion/build-compare-sheet.py \
  --ref-video "work/ref-aventurine/clips/labeled_puwang_普攻.mp4" --ref-times 0,0.5,1,1.5,2 \
  --source-dir "$PILOT/source-render/skill01" --source-prefix skill01 \
  --vrm-dir "$PILOT/vrm-preview" --vrm-prefix skill01 \
  --frames 0,0.25,0.5,0.75 \
  --out "$PILOT/compare/skill01" --title "Skill01 对拍（官方|源|VRM）"

# 注：--frames 取 0..1 的分数（对应源渲染/VRM 预览文件名里的 000/025/050/075 百分比标签）；
#     --ref-times 是参考视频内的秒数；缺图会以 MISSING 占位（例如参考段不够长）。
```

### 2.3 判定与差异纪律

- **判「一样」**：第 1 层——源渲染与官方素材的姿态形状/节奏一致（技能类逐段动作顺序、待机类呼吸节奏）；第 2 层——VRM 与源渲染同帧姿态对应（手/脚/头朝向、无镜像/反关节、无滑步），量化指标见验收文档阈值（每核心骨旋转 ≤5°、手腕/脚踝 ≤3–5cm、脚底残差 ≤2–3cm）。
- **判「不一样」**：先按 `docs/adv-acceptance-plan.md` §3 的原因分类（坐标/手性、rest、脊柱折叠、缩放/单位、fps、grounding、道具缺失、参考素材遮挡）写清「现象 → 根因假设 → 验证方法 → 修法」，**改完重跑 pilot 同步骤复验**；禁止为了让画面"顺眼"直接改数值/阈值。
- E 级动作（Talk01/State_Stun）对外口径：**「源保真 + 重定向保真已验证；公开视频无逐条素材，无法做视频对拍」**，不能写成"已与官方演示一致"。

## 2.4 已用合成 pilot 副本彩排（命令链已验证）

在真实数据到达前，已用合成 Biped 夹具伪造了一个 pilot 目录（Tpose + 5 动作 × 全场景/_skel，见 `tests/tmp/adv-pilot-sim/`，私有）把本 runbook 的命令链完整跑通：
- `--list-actions` 输出可解析；目录采样 5/5、Tpose 优先作 rest、成对 `_skel` 优先；
- `run-adv-pipeline --mode pilot` → retarget 5/5 PASS；
- 源渲染（mesh 模式 5 帧×3 视图）、`preview-adv`（三视角）、`build-compare-sheet`（两列/三列，含官方参考视频抽帧）全部产出成功。
- 彩排中发现并已修正：compare-sheet 的 `--frames` 需传 0..1 分数（不是百分比标签）。

## 3. Pilot 通过后的动作

1. 回传用户：pilot 验证结论 + 放行全量 `run_full.bat`（138 个 → `D:\sjxl\fbx-all`）。
2. 同步更新 `docs/wave4-adv-report.md`「Pilot 验证」节（G1–G6 数据 + 对拍图路径）。
3. 全量回来后按 `docs/adv-pipeline-commands.md` §0（或 `run-adv-pipeline.sh --mode full`）跑 135 条 catalog。
