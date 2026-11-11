# `scripts/vrm/motion/` — V3 HSR 官方动作管线（dev-only）

把 HSR 官方角色 FBX（`Avatar_Aventurine_00.fbx`，135 个 60fps take）里的全身动画
重定向为 **VRM clip 数据**，输出到私有目录 `assets/motions/hsr/**`，并提供 QA/预览工具。

> 资产与产物均为私有（游戏官方资源，禁止再分发/提交 git）：FBX、`assets/motions/hsr/**`、
> `tests/tmp/hsr-motion/**` 都在 `.gitignore` 覆盖范围内。只提交脚本/测试/文档。

当前目标模型：`assets/vrm/aventurine-tpose.vrm`（W1.5-Tpose 重制，规范 T-pose、面向 +Z、
53 humanoid 骨（无 upperChest）、SpringBone 50 链）。旧 A-pose legfix 资产保留回滚。

## 管线

```
HSR FBX ──extract-hsr-anims.py（Blender 4.2 + in-between patch）──▶ tests/tmp/hsr-motion/samples.json
                                                                         │
      src/shared/vrm-manifest.json → aventurine-tpose.vrm ◀────────────────┤
      scripts/vrm/motion/clips.hsr.json（选片/槽位/loop/grounding）        │
                                                                         ▼
                retarget-hsr.mjs（humanoid 52 骨 + rest 方向修正 + grounding；raw 视目标 spring）
                                                                         │
                                                                         ▼
                                  assets/motions/hsr/<clip>.json（私有）
                                                                         │
          validate-hsr-clips.mjs（PASS/WARN/FAIL）→ preview-hsr.mjs（三视角/手脚特写+接触表）
                                                                         │
                                                    build-hsr-manifest.mjs（manifest + index）
```

## 命令

```bash
# 0) 前置：RAR 解包后的 FBX（本机私有路径）；Blender 4.2.23 LTS
BLENDER=/Volumes/4TB外置盘/deepseek-harness/tools/blender/Blender.app/Contents/MacOS/Blender
FBX="/path/to/砂金/Animator/Avatar_Aventurine_00/Avatar_Aventurine_00.fbx"

# 1) Blender 全骨采样（236 骨 × 30fps；自动跳过 FBX in-between shape keys）
"$BLENDER" -b --factory-startup --python scripts/vrm/motion/extract-hsr-anims.py -- \
  --fbx "$FBX" --config scripts/vrm/motion/clips.hsr.json --out tests/tmp/hsr-motion/samples.json

# 2) 重定向 → assets/motions/hsr/<id>.json（T-pose 目标：rest 方向修正 + chest 重映射 + raw=spring）
node scripts/vrm/motion/retarget-hsr.mjs \
  --samples tests/tmp/hsr-motion/samples.json --out assets/motions/hsr --report-dir tests/tmp/hsr-motion

# 3) QA（结构/指标/贴地/spring 策略；并跑 Wave1.5 的 22 骨 validator 双保险）
node scripts/vrm/motion/validate-hsr-clips.mjs --dir assets/motions/hsr \
  --json tests/tmp/hsr-motion/validation-report.json

# 4) 构建 manifest + index
node scripts/vrm/motion/build-hsr-manifest.mjs --dir assets/motions/hsr \
  --config scripts/vrm/motion/clips.hsr.json

# 5) 无头预览 + 接触表（--all 预览全部；相机按 manifest yaw 朝 +Z，spring 按 delta 步进）
node scripts/vrm/motion/preview-hsr.mjs --all --out tests/tmp/hsr-motion/preview-tpose \
  --frames 0,0.2,0.4,0.6,0.8 --views front,side,threeQuarter,hand,feet
```

## 关键选项

- `retarget-hsr.mjs --raw auto|off|map`
  - `auto`（默认）：目标有 SpringBone → `rawPolicy=spring`（raw 留空，由 three-vrm 物理驱动次级骨）；
    否则回退旧 chain raw 映射（旧 A-pose 资产行为）。
  - `off`：强制不烘 raw；`map`：强制旧 chain 映射（调试/旧资产）。
- `preview-hsr.mjs --yaw auto|<deg>`：朝向修正；默认按 `vrm-manifest.json` 的 `yawOffsetDeg` 匹配。
- `preview-hsr.mjs --raw 0`：忽略 clip raw 通道（B 方案做 A/B 时用）。

## 文件

| 文件 | 作用 |
|---|---|
| `clips.hsr.json` | 选片 registry：HSR take → clip id / slot / loop / priority / grounding / tags |
| `extract-hsr-anims.py` | Blender headless 采样（含 FBX in-between shape keys patch） |
| `retarget-hsr.mjs` | 重定向 CLI（默认目标 = `vrm-manifest` 的 `aventurine-waveflair` = T-pose VRM） |
| `validate-hsr-clips.mjs` | QA CLI（PASS/WARN/FAIL + JSON 报告） |
| `build-hsr-manifest.mjs` | 构建 `assets/motions/hsr/manifest.json` + `index.json`（`--check` 支持） |
| `build-app-manifest.mjs` | 由 mate/hsr 两套 manifest 生成 app 层 `assets/motions/app-manifest.json` + `app-catalog.json`（运行时候选/一次性动作；`--check` 幂等，见下节） |
| `preview-hsr.mjs` / `preview-electron.mjs` / `viewer.html` / `viewer.js` | 无头 Electron 预览、spring 步进、接触表 |
| `lib/quat.mjs` | 四元数/矩阵纯函数 |
| `lib/vrm-rest.mjs` | GLB/VRM rest 解析、humanoid 映射、effectiveParent、alignment（upperChest fallback）、spring 摘要 |
| `lib/humanoid-hsr.mjs` | HSR→VRM humanoid 映射 + target-aware 映射（chest←Chest_M）+ 方向表 |
| `lib/rest-direction-fix.mjs` | rest 方向修正（手臂/手/手指 per-bone swing） |
| `lib/secondary-map.mjs` | 旧无 spring 资产的头发/衣摆 chain→chain 映射（V3.0 行为保留） |
| `lib/retarget.mjs` | 重定向核心（映射/修正/归一化旋转/in-place/grounding/参考帧裁剪） |
| `lib/qa.mjs` | 结构校验 + 指标 + 分级 |

详细设计/验收数据见 [`docs/vrm-motion-hsr.md`](../../../docs/vrm-motion-hsr.md)。

## app 层清单（`app-manifest.json` / `app-catalog.json`，Wave 2 / V1）

运行时（`src/renderer/src/vrm/clip-registry.ts` + `clip-player.ts`）不直接读 mate/hsr 的
源 manifest，而是读本脚本生成的**两份私有 app 清单**（`file` 均相对 `assets/motions/`，不入 git）：

```bash
# 生成（读 assets/motions/{mate,hsr}/manifest.json，同时校验 clip 文件存在）
node scripts/vrm/motion/build-app-manifest.mjs

# 幂等校验（产物不含时间戳，逐字节比较；一致 exit 0 且不写盘）
node scripts/vrm/motion/build-app-manifest.mjs --check
```

### `app-manifest.json`（冻结契约）

`src/shared/animation-contract.ts` 的 `AnimationClipManifest` 形状，只含 **mood/salute 槽位**：

```jsonc
{
  "schemaVersion": 1,
  "clips": [
    {
      "id": "hsr-idle",          // app 层唯一 id = "<set>-<源 clip id>"（mate/hsr 有同名 idle）
      "mood": "idle",            // 合法动作槽位（= PET_MOODS + salute）
      "file": "hsr/idle.json",   // 相对 assets/motions/
      "loop": true,
      "timeScale": 1,
      "fadeInSec": 0.15,
      "fadeOutSec": 0.2,
      "rootMotion": "inPlace",
      "priority": 10             // 同 mood 多 clip 时高者优先；低优先级做待机变体轮换
    }
  ]
}
```

映射规则（设计 `docs/wave2-vrm-runtime-design.md` §2.3 + V5/V7 修正）：
- `slot ∈ ANIMATION_CLIP_MOODS` 且非 null 的源 clip 直接映射（`pat ← happy/laughing/shyPoint`
  已由源 manifest 的 `slot:"pat"` 表达）；
- idle：hsr 官方待机 prio 10/8/5/4/3 + mate idle 系列 prio 0…-6，播放器按 priority 排序，
  每 8–20s（或一次性事件后）轮换一个待机变体；
- **sit（V5 实机修正）**：默认地面坐姿 = `sit1`(10) > `sit2`(9) > `suwari3`(8)；
  `sitWindow` / `windowLay8/9/10` 是「窗沿躺」姿势，优先级降到 -10…-13，只保留在
  app-manifest 供将来按 id 播放，**不参与待机变体轮换**（clip-player 的轮换阈值是
  priority ≥ -9）；
- walk = mate walk/walkAlt；sleep = mate sleep；drag = mate drag；salute 暂缺（可不提供）。

**catalog clip → mood 别名（V7 补 DSH 联动 + V11 pose 稀有变体）**：mate/hsr 源 manifest
没有绑定 `dshBusy/dshDone/dshError` 的 clip（B1/B7 在 DSH 任务开始/完成/出错时会发这三个
PetMood），idle 也需要低概率展示动作；脚本用 `MOOD_CLIP_ALIASES` 把 catalog 里已有的
展示/一次性 clip「起别名」追加进 app-manifest（**不动 catalog、不复制文件**）：

| mood | 来源 clip | loop | priority | fadeIn/fadeOut | 用途 |
|---|---|---|---|---|---|
| `dshBusy` | hsr `commonIdle` | true | 0 | 0.3s / 0.3s | DSH 任务进行中：安静待机（B1 保持该 mood 期间循环） |
| `dshDone` | mate `happy` | false | 0 | 0.15s / 0.3s | 任务完成：开心庆祝（非循环，播完回当前 mood） |
| `dshError` | hsr `stun`（兜底） | true | 0 | 0.15s / 0.25s | 出错/受挫。**实机修正**：真正「倒地不动」由 animator 的 mood 过渡完成——进入 dshError 播 `hsr-breaked`（非循环）后 hold 末帧保持 ≈9s，离开时播 `hsr-revive` 起身；本表 stun 仅作 breaked 不可用时的兜底。`hsr-hitL` 只留 catalog 不接线 |
| `idle`（稀有） | mate `pose1` | true | -7 | 0.8s / 1.0s | idle 稀有展示动作 1（6.8s 循环） |
| `idle`（稀有） | mate `pose2` | true | -8 | 0.8s / 1.0s | idle 稀有展示动作 2（6.8s 循环） |
| `idle`（稀有） | mate `pose3` | true | -8 | 0.8s / 1.0s | idle 稀有展示动作 3（5.0s 循环） |

**稀有权重（V11，clip-player）**：priority ≤ -7 的变体在随机轮换中权重 = 0.3（普通 = 1，
可 tuning 覆盖 `rareVariant.priorityThreshold/weight`）。idle 池 12 条普通变体 + 3 条 pose →
pose 每次轮换概率 ≈ 0.9/(12+0.9) ≈ 7%（实测 seeded 1000 次 ≈ 8.2%），按 idle 12–20s 轮换
约 **3–5 分钟**出现一次。

别名 id 固定为 `<set>-<clip>-<mood>`（如 `hsr-commonIdle-dshBusy`），避免与 catalog 里同源
clip 的 `<set>-<clip>` id 冲突；**同一个 clip 可以同时出现在 catalog（原 id，事件/调试用）与
app-manifest（别名 id，mood 驱动）中**，这是预期行为。源 clip 缺失时构建报 error（防止漂移）。

> 未绑定动作（intro/pose/skill/stun/revive/hide/windowLay 等）的接线建议见
> [`docs/vrm-motion-mapping-recommendations.md`](../../../docs/vrm-motion-mapping-recommendations.md)：
> **只做推荐，本轮不接线**（不改 app-manifest/catalog）。

生成后统计：app-manifest **32 clips**（idle 15 = 12 普通 + pose1/2/3 稀有 / walk 2 / sit 7 /
pat 3 / sleep 1 / drag 1 / dshBusy 1 / dshDone 1 / dshError 1；其中 6 条为 catalog→mood 别名）；
app-catalog **43 clips**（全部 clip 不变，含 `hsr-hitL`/`hsr-skill*`/`hsr-breaked`/`hsr-revive`
等 catalog-only 动作，可 `playClipById` 手动播放）。

### `app-catalog.json`（运行时扩展格式）

列出**全部** clip（含 hide/intro/pose/skill/hit 等一次性片段），供事件/调试按 id 播放：

```jsonc
{
  "version": 1,
  "clips": [
    {
      "id": "hsr-hitL",          // app 层唯一 id
      "set": "hsr",              // mate / hsr
      "file": "hsr/hitL.json",   // 相对 assets/motions/
      "loop": false,
      "duration": 1.566667,      // 秒（源 manifest duration）
      "tags": ["react"],         // 语义标签（事件回退用）
      "mood": null               // 绑定槽位；一次性片段为 null
    }
  ]
}
```

说明：
- **mood 与 catalog 一次性 clip 的关系**：app-manifest 是「mood → clip 候选池」（B1 状态机
  按 `input.mood` 选片，同 mood 多 clip 按 priority + 待机变体轮换）；catalog 是「全部 clip
  的索引」（事件/调试按 id 播放，`clip-player` 的事件映射先按策展 id、再按 tag
  `react`/`interaction` + `loop:false` 回退）。两份清单引用同一批 clip JSON；
  V7 的 dsh* 别名只进 app-manifest，不进 catalog；
- catalog 同时包含 mood clip（`mood` 非 null）与一次性片段（`mood: null`）；
- catalog-only 动作（如 `hsr-skill01/02`、`hsr-breaked`、`hsr-revive`）可用
  `clipPlayer.playClipById(id, { loop, hold, fadeSec })` 手动播放（loop/hold 可覆盖条目默认），
  播完（非 hold）回当前 mood；
- 新 clip 只需更新 mate/hsr 源 manifest 后重跑本脚本，**不要手改生成物**；
- 槽位列表在脚本内硬编码（`CLIP_SLOT_MOODS`，脚本不能 import TS 契约），
  改 `ANIMATION_CLIP_MOODS` 时需同步（否则生成器会把新槽位判为非法并退出 1）。

---

## 数据侧「静态站立膝拉直」bake（`straighten-standing-knees.mjs`，2026-11-11）

> **背景**：调查报告 `tests/tmp/inv-leg2/REPORT.md` §13 发现「作者数据本身屈膝」的 D 类问题：
> 一部分用户可见的站立 idle / 一次性社交 clip 作者膝角均值 166–174°（比伸直少 6–14°），
> 在 one-shot/manual 路径（foot-lock allow=false）下腿形 = 作者数据，运行时代码修不了。
> 本脚本是 P2 数据侧 bake：**脚位/脚朝向不变、只抬髋 + 重解双腿旋转**，把站立膝角拉到目标。
>
> **2026-11-11 14:22 已 apply**（Lead 复核批准后）：11 条 baked clip 写入 `assets/motions/**`，写后复验 PASS；
> 原文件备份在 `assets/motions-leg-backup-2026-11-11/<relPath>`（11/11 sha256Before 校验通过），
> 一键回滚：`node scripts/vrm/motion/straighten-standing-knees.mjs rollback --yes`。
> 注意：备份目录不在 `.gitignore` 覆盖范围内（apply 后 `git status` 出现 untracked），不要 commit。

### 命令

```bash
# 1) 只分析：目标池全帧 FK 统计 + 清单筛选（不写盘）
node scripts/vrm/motion/straighten-standing-knees.mjs analyze

# 2) bake 到 staging + 数值验证 + metrics（不碰 assets/**）
node scripts/vrm/motion/straighten-standing-knees.mjs bake
#   → tests/tmp/bake-leg/staging/<relPath>、metrics.json、staging-manifest.json

# 3) 产品口径验证（parseClipData + sampling 逐帧复算；含 apply/rollback 沙盒端到端）
./node_modules/.bin/vitest run --config tests/tmp/bake-leg/vitest.config.mts

# 4) apply（⚠️ Lead 批准后）：备份 → 原子写 assets/motions/** → 写后复验（失败自动回滚）
node scripts/vrm/motion/straighten-standing-knees.mjs apply --yes
#   备份：assets/motions-leg-backup-2026-11-11/<relPath>（本地目录，勿提交）

# 5) 一键回滚（幂等；staging manifest 丢失时直接扫备份目录兜底）
node scripts/vrm/motion/straighten-standing-knees.mjs rollback --yes
```

### 口径与算法（详见 `docs/fix-report-2026-11-11-standing-leg-data-bake.md`）

- 复刻产品层序：`clip JSON → normalized humanoid 骨 + Hips.p（× hipsRestHeight/sourceHipsHeight）
  → grounding==='feet' 首帧脚骨贴地常量 → FK`；真实 VRM 用 `three-vrm` 解析（去贴图加速）。
- 目标：逐帧目标膝角 = 作者膝角 + Δ_leg（Δ≥0，**只拉直不掰弯**；保留作者逐帧变化与左右差异方向）；
  idle 轮换池均值 175.5° / 最差帧 ≥174°；社交/一次性均值 173° / 最差帧 ≥170°（179.5° 上限）。
- 髋位移：先解 1 维最小二乘 δy（≤5mm），再补 ≤30mm 的 hips x/z 极小修正（近伸直时左右膝角差
  ⇔ 髋→踝距离差被放大，只用 δy 无法同时满足左右差异/最差帧门禁；实测 9/11 clip 会失败）。
- 两骨 IK 与 `src/renderer/src/vrm/foot-lock.ts:solveKneePosition` 同款（IK 余量 1e-6m，数据侧无运行时防抖需求），
  脚踝位置/脚朝向固定，重解 UpperLeg/LowerLeg 并反解 Foot；只改 `Hips.p` + 6 条腿骨 `r`，其余逐位保留。
- 数值验证（每 clip 15 项）：膝角均值/最差/逐帧目标、脚位漂移 <0.5mm、脚朝向 <0.5°、抬升 ≤5mm、
  knee range 不增、loop 连续性不劣化、无 NaN、未改动其他轨道、求解残差。
- 防二次 bake：若资产 sha 已等于上次 staging 的 sha256After，bake 会拒绝重跑（要重炙需先 apply/回滚或删除 manifest）。

### 产物

| 路径 | 内容 |
|---|---|
| `scripts/vrm/motion/straighten-standing-knees.mjs` | 主脚本（analyze/bake/validate/apply/rollback） |
| `tests/tmp/bake-leg/staging/<relPath>` | bake 产物（apply 源） |
| `tests/tmp/bake-leg/metrics.json` | 逐 clip before/after 指标 + 逐帧数据 + 15 项验证结果 |
| `tests/tmp/bake-leg/staging-manifest.json` | apply 清单（sha256Before/After、路径、参数） |
| `tests/tmp/bake-leg/diff-stats.json` | 改动轨道/数值 diff 统计（回归/审计用） |
| `tests/tmp/bake-leg/validate-product-parse.test.ts` + `vitest.config.mts` | 产品 parseClipData 口径验证 + apply/rollback 沙盒端到端 |
| `tests/tmp/bake-leg/run-logs/apply-rollback-sandbox.log` | apply/rollback/自动回滚演练日志 |
