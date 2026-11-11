# adv 动作集管线命令手册（3ds Max Biped → VRM）

- 日期：2026-11-09 · 状态：**工具链已就绪，合成夹具端到端冒烟通过；等真实 Biped FBX 到位照抄本文件**
- 范围：新动作集 **adv**（砂金·戏浪官方 3ds Max Biped 动作包）的「采样 → 重定向 → manifest → 校验 → 预览」整条 Mac 侧命令链。
- 关联文档：`docs/max-anim-conversion-plan.md`（路线/阶段）、`docs/user-3dsmax-export-guide.md`（Windows 侧导出）、
  `docs/adv-acceptance-plan.md`（两级对拍验收）、`docs/adv-clip-selection.md`（选片/接入设计）、
  `docs/vrm-motion-hsr.md`（同结构的目标 VRM 与 HSR 管线先例）、`scripts/vrm/motion/README.md`。
- 工具脚本（均为本任务新增，不改 HSR 管线）：
  - `scripts/vrm/motion/build-adv-manifest.mjs`
  - `scripts/vrm/motion/validate-adv-clips.mjs`
  - `scripts/vrm/motion/preview-adv.mjs`
- 红线：官方游戏资源与全部产物**仅本机私有**；`assets/motions/**`、`tests/tmp/**`、`work/**` 均 gitignore，禁止提交/分发。

---

## 0. 一页速查（真实数据到位后按顺序执行）

```bash
cd /Volumes/4TB外置盘/deepseek-harness/aventurine-pet-vrm

# 环境变量
BLENDER=/Volumes/4TB外置盘/deepseek-harness/tools/blender/Blender.app/Contents/MacOS/Blender
FBX_DIR="$HOME/Downloads/fbx-all"          # 用户回传解压目录（全量 138 个骨架 FBX + Tpose.fbx + export_log.txt）
CFG=scripts/vrm/motion/clips.adv.json       # 选片 registry（25 条代表动作）
TMP=tests/tmp/adv-motion

# 1) 采样（Blender headless；全量目录一次会话，共用一份 rest）
"$BLENDER" -b --factory-startup --python scripts/vrm/motion/extract-biped-anims.py -- \
  --fbx-dir "$FBX_DIR" --config "$CFG" \
  --out "$TMP/samples.json" --report "$TMP/samples-report.json" --minimal

# 1b) 采样后门禁：samples 里 25 条 clip 是否齐全 + report 警告（见 §3.1）
node -e 'const fs=require("fs");const s=JSON.parse(fs.readFileSync("'"$TMP"'/samples.json","utf8"));const c=JSON.parse(fs.readFileSync("'"$CFG"'","utf8"));const miss=c.clips.filter(x=>!s.clips[x.id]).map(x=>x.id);console.log(`samples=${Object.keys(s.clips).length}/${c.clips.length} missing=${miss.join(",")||"none"}`)'

# 2) 重定向 → assets/motions/adv/<id>.json（私有）+ retarget/mapping 报告
node scripts/vrm/motion/retarget-adv.mjs \
  --samples "$TMP/samples.json" --out assets/motions/adv --report-dir "$TMP"

# 3) manifest + index（幂等；--check 用于 CI/复跑比对）
node scripts/vrm/motion/build-adv-manifest.mjs --dir assets/motions/adv --config "$CFG" --report "$TMP/manifest-report.json"
node scripts/vrm/motion/build-adv-manifest.mjs --dir assets/motions/adv --config "$CFG" --check

# 4) QA（结构/指标/贴地/次级骨 + U-lane 22 骨双保险）
node scripts/vrm/motion/validate-adv-clips.mjs --dir assets/motions/adv --json "$TMP/validation-report.json"

# 5) 预览（三视角 + 手脚特写 + 接触表；--all 读 manifest 产出的 index.json）
node scripts/vrm/motion/preview-adv.mjs --all --out "$TMP/preview" \
  --frames 0,0.2,0.4,0.6,0.8 --views front,side,threeQuarter,hand,feet
```

**门禁顺序**：采样缺 clip → 先修文件名/take 匹配（§3.1）；retarget 出现 `grade=FAIL` → 先修映射/数据（§3.2）；
manifest 报 `覆盖不足`/缺核心骨 → 不写盘，按提示修 count/数据（§3.3）；validate FAIL → 按报告定位（§3.4）；
预览看得到模型且朝向正确（正面相机在 +Z 侧）→ 数据链路 OK（§3.5）。

---

## 1. 前置条件与输入

| 项 | 值/说明 |
|---|---|
| 仓库 | `/Volumes/4TB外置盘/deepseek-harness/aventurine-pet-vrm` |
| Blender | `/Volumes/4TB外置盘/deepseek-harness/tools/blender/Blender.app/Contents/MacOS/Blender`（4.2 LTS；`-b --factory-startup --python <脚本> -- <参数>`） |
| Node | `>= 22.12`（项目 `package.json` engines）；`sharp`/`electron` 已在 `node_modules` |
| 目标 VRM | 由 `src/shared/vrm-manifest.json` 的 `aventurine-waveflair` 解析 = `assets/vrm/aventurine-tpose.vrm`（规范 T-pose、面向 +Z、53 humanoid 骨、无 upperChest、SpringBone 50 链） |
| 动作源 FBX | Windows 侧 `scripts/max-export/export_max.ms` 批量导出：全量 `--mode all` 每个 `.max` → 一个「删网格后的骨架 FBX」`<take>.fbx`；pilot 每个场景还会多一个 `<take>_skel.fbx`（采样器目录模式自动优先 `_skel` 并在两者成对时跳过另一个） |
| 文件名约定 | **FBX basename = `.max` basename = clip registry 的 `file` 字段**（如 `StandBy.max` → `StandBy.fbx`）；空格/括号复本（`StandBy (2)`）已在 `clips.adv.json` 的 excluded 里，不接入 |
| 选片 registry | `scripts/vrm/motion/clips.adv.json`：25 条代表动作（`id/takeMatch/file/fps/loop/slot/grounding/priority/tags/note`）+ `requirements` 覆盖门槛（idle≥5、walk≥2、react≥3、skill≥5） |
| 产物目录 | `assets/motions/adv/**`（manifest/index/clip JSON，私有）；`tests/tmp/adv-motion/**`（采样/报告/预览，私有） |

> Windows 侧导出步骤与 pilot/全量操作见 `docs/user-3dsmax-export-guide.md`（含 `run_pilot.bat` / `run_full.bat` 与
> `export_log.txt` 的 `=== DONE mode=all ok=138 fail=0 ===` 验收行）。

---

## 2. 管线总览

```
Windows: 138 × .max ──export_max.ms──▶ <take>.fbx（骨架+烘焙动画；场景帧率原样，采样侧统一到 30fps）
                                            │
Mac:  extract-biped-anims.py（Blender headless）──▶ tests/tmp/adv-motion/samples.json + samples-report.json
                                            │        （schema 与 HSR samples.json 完全一致）
       clips.adv.json（选片/take/loop/slot/grounding）│
                                            ▼
      retarget-adv.mjs（Biped→VRM humanoid：world-delta + R_align + rest 方向修正 + in-place/grounding）
                                            │
                                            ▼
      assets/motions/adv/<id>.json（私有 clip 数据，humanoid 52 骨 + rawPolicy=spring）
                                            │
        build-adv-manifest.mjs ──▶ assets/motions/adv/{manifest,index}.json + 构建报告
        validate-adv-clips.mjs ──▶ tests/tmp/adv-motion/validation-report.json（PASS/WARN/FAIL）
        preview-adv.mjs（Electron + three-vrm）──▶ tests/tmp/adv-motion/preview/*.png + <id>-sheet.jpg
```

| 步骤 | 命令入口 | 产物 | 通过标准 |
|---|---|---|---|
| 1 采样 | `extract-biped-anims.py` | `samples.json`、`samples-report.json` | `EXTRACT_DONE ... clips=25`；samples-report 无致命 warning（rest/fps 一致性见 §3.1） |
| 2 重定向 | `retarget-adv.mjs` | `assets/motions/adv/<id>.json`、`retarget-report.json`、`mapping-report.json` | 每 clip `grade=PASS`；汇总 `FAIL 0` |
| 3 manifest | `build-adv-manifest.mjs` | `manifest.json`、`index.json`、`manifest-report.json` | `OK set=adv clips=25`；`--check` 通过；coverage 满足 requirements |
| 4 校验 | `validate-adv-clips.mjs` | `validation-report.json` | `FAIL 0`（WARN 可接受，逐条记录原因） |
| 5 预览 | `preview-adv.mjs` | `<clip>-<view>-<pct>.png`、`<clip>-sheet.jpg` | 模型可见、朝向正确、动作与参考视频一致 |

---

## 3. 分步命令（每步：命令 / 产物 / 预期输出 / 排错）

### 3.1 Step 1：采样（Biped FBX → samples.json）

**A. 全量目录（138 文件，真实数据主路径）**

```bash
BLENDER=/Volumes/4TB外置盘/deepseek-harness/tools/blender/Blender.app/Contents/MacOS/Blender
FBX_DIR="$HOME/Downloads/fbx-all"
CFG=scripts/vrm/motion/clips.adv.json
TMP=tests/tmp/adv-motion

"$BLENDER" -b --factory-startup --python scripts/vrm/motion/extract-biped-anims.py -- \
  --fbx-dir "$FBX_DIR" --config "$CFG" \
  --out "$TMP/samples.json" --report "$TMP/samples-report.json" --minimal
```

- `--minimal`：只采 registry 列出的 take（25 条），其余 FBX 只读 rest 不采动画 → 全量 138 个文件可在一次 Blender 会话跑完；
- 目录模式**共用一份 rest 基准**：目录里存在 `*Tpose*.fbx` 时**优先 Tpose 文件**（`restSource.reason="tpose-prefer"`），否则按文件名排序第一个（`"first-file"`）；后续文件 rest/height/fps 不一致会写 warning（`samples-report.json`）。
- 目录内 30/60fps 混用时：每个 clip 写 `samples.clips[id].sourceFps`（下游按 clip 读），顶层 `samples.sourceFps` 取最常见值，`samples-report.json#sourceFpsByFile` 记录逐文件帧率。

产物：

| 路径 | 内容 |
|---|---|
| `tests/tmp/adv-motion/samples.json` | `{schemaVersion, sourceFps, fps, sourceHeightMeters, sourceHipsHeightMeters, rest, children, clips}`；`clips[id] = {action,takeMatch,srcFrames,frames,sourceFps,data:[{f,q,h}]}`（与 HSR samples.json 同 schema；唯一扩展是 per-clip `sourceFps`，下游可忽略） |
| `tests/tmp/adv-motion/samples-report.json` | 诊断：`mode/config/files[]/warnings`（take 映射、链接骨、fps、rest 一致性、config 文件缺失）+ `restSource`（rest 基准文件：`tpose-prefer`/`first-file`）+ `sourceFpsByFile`/`clipSourceFps`/`processingOrder` |

预期输出（每匹配到一条 clip 一行）：

```
SAMPLED idle ...  action='Bip001|StandBy|StandBy' src=[0, 60] frames=61 fps=30.0->30.0
...
EXTRACT_DONE mode=dir clips=25 sourceFps=30.0 sourceHeight=1.88 sourceHipsHeight=0.95
WROTE .../tests/tmp/adv-motion/samples.json (xx MB)
REPORT .../tests/tmp/adv-motion/samples-report.json
```

> 合成夹具实测（本任务冒烟，可作格式参照）：
> `EXTRACT_DONE mode=single clips=2 sourceFps=30.0 sourceHeight=1.880 sourceHipsHeight=0.950`；
> `WARN 链接骨归一化：断开 49 根 use_connect（否则 location 动画会被 Blender 忽略）`（正常，非错误）。

**采样后门禁（真实数据必做）**

```bash
# a) 25 条 clip 是否都采到（缺一条就说明 file/take 名没对上）
node -e '
const fs=require("fs");
const s=JSON.parse(fs.readFileSync("tests/tmp/adv-motion/samples.json","utf8"));
const c=JSON.parse(fs.readFileSync("scripts/vrm/motion/clips.adv.json","utf8"));
const miss=c.clips.filter(x=>!s.clips[x.id]).map(x=>x.id);
console.log(`samples clips=${Object.keys(s.clips).length}/${c.clips.length} missing=${miss.join(",")||"none"}`);
'
# b) 看报告里的 warning（take 映射/rest/fps）
node -e '
const fs=require("fs");
const r=JSON.parse(fs.readFileSync("tests/tmp/adv-motion/samples-report.json","utf8"));
console.log("warnings:", r.warnings.length);
for (const w of r.warnings) console.log(" -", w);
'
```

**Pilot 阶段（6 个 FBX，先验格式再跑全量）**：同一命令把 `--fbx-dir` 指向 pilot 解压目录即可
（pilot 目录含 `X.fbx` + `X_skel.fbx` 成对文件，采样器自动优先 `_skel`）。pilot 只会产出约 5 条 clip
（`Tpose` 无动画、不产生 clip，可单独采样用来核对 rest），**不足以过 registry 覆盖门槛**：pilot 只看
「能采样、能重定向、数据门禁 PASS」，不要跑 Step 3 的 `clips.adv.json` manifest（会按设计报覆盖不足）
——覆盖门槛等全量数据。

**排错**

| 症状 | 根因 | 处理 |
|---|---|---|
| `目录内没有 .fbx` / `FBX 导入失败` | 路径错 / FBX 损坏 / 传输不完整 | 检查解压目录与 `export_log.txt` 的 `ok=138 fail=0`，重新解压 |
| 某 clip 没采到（missing 非 none） | config `file` 的 basename 与 FBX 不一致（大小写/空格/括号/`_skel` 后缀） | `ls "$FBX_DIR"`（排序）对照 config `file`；不要改 `clips.adv.json` 去迁就错误文件名，先归一名（导出侧已按 .max basename 命名） |
| `WARN config clip 引用的文件在目录中不存在：X.fbx` | 全量目录缺该 take（导出失败/被排除） | 查 `export_log.txt` 的 `failed:` 行，单独重导该 .max |
| `骨架 rest 与首文件不一致（max diff …）` | 不同 FBX 的绑定/当前帧姿势不同（见 §6-R1） | 记录并向 Lead/采样器负责人反馈；pilot 先用单文件模式对 `Tpose_skel.fbx` 单独采样核对 rest |
| `sourceHipsHeightMeters` 明显不是米级（如 ~95） | 3ds Max 单位是 cm、导出未归一 | 与 Windows 侧确认 `units.SystemType`（导出日志有 `unit=` 字段）；米级应在 0.9~1.1 |
| 帧率 `fps=60.0->30.0` | 场景 fps=60 | 正常：采样器按 `clips.adv.json.fps=30` 降采样；`sourceFps` 记录原帧率 |
| `WARN 骨骼名不是 BipXXX 命名` | 导出丢失 Bip2FBX / 骨架不是标准 Biped | 检查导出设置 `Bip2FBX=true`；非标准骨架需要先改 `lib/humanoid-biped.mjs` 命名解析（不要盲接） |

### 3.2 Step 2：重定向（samples.json → VRM clip JSON）

```bash
node scripts/vrm/motion/retarget-adv.mjs \
  --samples tests/tmp/adv-motion/samples.json \
  --out assets/motions/adv \
  --report-dir tests/tmp/adv-motion
```

- 目标 VRM 默认从 `src/shared/vrm-manifest.json` 取 `aventurine-waveflair`（= `assets/vrm/aventurine-tpose.vrm`）；
- 只写 `assets/motions/adv/<id>.json`（私有）；报告写 `tests/tmp/adv-motion/{retarget-report,mapping-report}.json`；
- 可用 `--only idle,walk` 先单 clip 试跑；`--raw off` 可关 raw（Biped 目标 rawPolicy=spring，一般不需要动）。

产物：`assets/motions/adv/<id>.json`（每个 config clip 一个）、`retarget-report.json`（逐 clip 指标+grade）、
`mapping-report.json`（Biped→VRM 映射表、rest 方向差、手指赋值打分）。

预期输出：

```
[retarget-adv] source=biped bones=... -> target=aventurine-tpose.vrm humanoid=53 spring=50链/175collider rawPolicy=spring
[retarget-adv] mapping: mapped=51 restFixMismatchMax=...° fingerAssign(chosen mean=...°, thumbVsIndex=0°)
[retarget-adv] idle           frames= 60 humanoid=52 restFix=... ground=feet(shift ...m) grade=PASS
...
[retarget-adv] clips=25 grade: PASS 25 / WARN 0 / FAIL 0 -> assets/motions/adv
[retarget-adv] OK（门禁通过；下一步：validate-hsr-clips --dir assets/motions/adv 双保险）
```

> 最后一行提示里的命令名是旧文案，**adv 请用本文件 Step 4 的 `validate-adv-clips.mjs`**。

**排错**

| 症状 | 根因 | 处理 |
|---|---|---|
| `采样文件不存在` | Step 1 未产出 / 路径错 | 回到 §3.1 |
| `source 解析失败：源骨架缺少必需 humanoid 骨映射` | 骨名匹配失败/非标准 Biped | 看 `mapping-report.json` 的 `ignoredBones/unsupportedBones`、`boneNameStyles`；真实 FBX 常见的是前缀/分隔符差异，`lib/humanoid-biped.mjs` 已兼容多种，仍失败就把采样到的骨名列给 Lead |
| 单 clip `grade=FAIL`（帧跳变/循环接缝/四元数） | 采样数据坏帧/动作本身瞬移（技能位移/切镜） | 看 `retarget-report.json` 的 `grades.items[].errors`；必要时 `--only` 隔离该 clip，先确认源 FBX 曲线，再定是否调 `grounding/loop` |
| `restFixMismatchMax` 很大（>60°） | 源 rest 与目标 rest 差异大 / rest 不是 T-pose | 正常时 rest-direction-fix 会修正；若导致手/脚方向怪 → 对照 `mapping-report` 分组差（upperArm/lowerArm/hand/fingers）判断是否映射错 |
| 手指方向明显不对 | Finger 链赋值/rest 方向异常 | 看 `mapping-report.json` 的 `fingers.assignment`（chosenMeanDeg / thumbVsIndexDeg）；Biped Finger0=拇指已有三重证据，若真实数据不符先记录再改 |
| hips 高度/脚悬空 | sourceHipsHeight 单位错 / grounding 语义 | 检查 `source.sourceHipsHeightMeters` 是否米级；standing 类必须 `grounding:"feet"`、倒地/受击类 `"none"`（见 clips.adv.json notes） |

### 3.3 Step 3：manifest + index

```bash
node scripts/vrm/motion/build-adv-manifest.mjs \
  --dir assets/motions/adv \
  --config scripts/vrm/motion/clips.adv.json \
  --report tests/tmp/adv-motion/manifest-report.json

# 幂等校验（CI/复跑；不写盘）
node scripts/vrm/motion/build-adv-manifest.mjs \
  --dir assets/motions/adv --config scripts/vrm/motion/clips.adv.json --check
```

产物：

| 路径 | 内容 |
|---|---|
| `assets/motions/adv/manifest.json` | `set:"adv"`；`clips[]` 含 `id/file:"adv/<id>.json"/slot/tags/loop/timeScale/priority/duration/fps/frames/sourcePath/sourceFile/channels/rawPolicy/grounding/note`；`coverage`（tag 计数）；`stats`（slot/grounding/loop/channels 统计）；`checks{ok,errors,warnings}` |
| `assets/motions/adv/index.json` | `set:"adv"` + `clips{id:{file,slot,loop,duration,fps,frames}}`（预览/加载器用） |
| `tests/tmp/adv-motion/manifest-report.json` | 构建报告：`coverage` + `stats{slots,grounding,loop,channels}`（slot/贴地/循环/通道统计） |

预期输出：

```
[build-adv-manifest] OK set=adv clips=25 coverage={"idle":11,"combat":1,"show":3,"walk":2,"run":1,"social":7,"react":5,"death":1,"skill":5} loop=14/11 grounding={"feet":15,"none":10} -> assets/motions/adv/manifest.json
[build-adv-manifest] check OK（manifest + index 与数据一致；clips=25 coverage={...}）
```

> `coverage`/`slots/grounding/loop` 由 `clips.adv.json` 的 25 条 registry 决定，真实数据齐全时应与上面一致
> （tag 计数：idle 11 / show 3 / social 7 / react 5 / skill 5 / walk 2 / combat 1 / run 1 / death 1；
> slot：idle 11 / walk 2 / null 12；grounding：feet 15 / none 10；loop 14 / 非循环 11）。

**排错**

| 症状 | 根因 | 处理 |
|---|---|---|
| `覆盖不足：tag "idle" 需要 ≥5，实际 N` | 真实数据缺片 / 某 clip 没被采样 | 先回 §3.1 门禁查 missing；确实缺片则修导出，**不要**下调 requirements 掩盖 |
| `clip 目录不存在` | 还没跑 Step 2 | 先跑 retarget-adv |
| `磁盘缺少 clip 文件，跳过`（warning） | registry 有但目录没有该 id | 同 missing 处理；构建仍会因 coverage 失败不写盘 |
| `缺核心骨 Hips,...` | clip 不是 22 骨契约数据（手工/旧数据混入） | 确认 `retarget-adv.mjs` 产出；清掉混入文件 |
| `slot 非法` | registry slot 不在契约 13 mood 内 | 改 `clips.adv.json`（slot 只允许 13 mood 或 null） |
| `--check` 不一致 | clip 数据比 manifest 新 | 去掉 `--check` 重建，再跑 `--check` 确认幂等 |

### 3.4 Step 4：QA 校验

```bash
node scripts/vrm/motion/validate-adv-clips.mjs \
  --dir assets/motions/adv \
  --json tests/tmp/adv-motion/validation-report.json
# 可选：--unity-validator=false 跳过 U-lane 22 骨校验（只跑本管线 grade）
```

产物：`tests/tmp/adv-motion/validation-report.json`（summary + 每 clip 的 `status/errors/warnings/metrics/unity`）。
退出码：`0`=无 FAIL（可有 WARN）；`1`=有 FAIL；`2`=参数错。

预期输出：

```
clip             frames humanoid raw maxJump loopSeam ground(m) status
idle             60     52       0   5.12°   0.61°    0..0.003  PASS
...
[validate-adv] set=adv target=aventurine-tpose.vrm yaw=0 spring=50链 humanoid=53
[validate-adv] 25 clip: PASS 22 / WARN 3 / FAIL 0（U-lane validator: 0 errors / N warnings；额外手指骨会产生 warning）
[validate-adv] 报告：tests/tmp/adv-motion/validation-report.json
```

> 上面的 PASS/WARN 分布是示例；真实预期是 **FAIL 0**，WARN 逐条读 `validation-report.json` 的 `clips[].warnings`
> 并记录原因（常见：循环接缝 2–6°、贴地残差 1–3cm、rawPolicy=spring 无 raw 相关提示）。

**排错**

| 症状 | 根因 | 处理 |
|---|---|---|
| `FAIL` + `缺少核心 humanoid 骨` | clip 不是 retarget-adv 产出/版本错 | 重跑 Step 2 |
| `FAIL` + `Hips.p 首帧未归零` | grounding/in-place 失败 | 看 retarget-report 该 clip 的 groundStats；必要时 `--max-ground-shift` 调小重跑 |
| `FAIL` + `帧跳变 > 150°` | 源曲线有瞬移（技能切镜/首帧未归位） | 先看源 FBX 是否本身瞬移；对非循环技能可接受但需记录；不要用平滑掩盖（会改变动作） |
| `WARN 循环接缝` | 动作首末帧不完全一致 | 循环类 clip 需修 loop（源数据/剪帧）；非循环 clip 无此检查 |
| `WARN 贴地：穿地/悬空` | grounding 残差 >3cm/6cm | 检查 `grounding` 语义标注（站立=feet，倒地=none）与 hips 缩放 |
| U-lane validator errors > 0 | 22 骨契约不满足 | 优先修数据，不要关校验交付 |

### 3.5 Step 5：无头预览 + 接触表

```bash
# 全部 clip（--all 读 index.json；25 clip × 5 view × 5 frame ≈ 625 png，耗时较长）
node scripts/vrm/motion/preview-adv.mjs --all \
  --out tests/tmp/adv-motion/preview \
  --frames 0,0.2,0.4,0.6,0.8 --views front,side,threeQuarter,hand,feet

# 或先挑代表性 clip 冒烟
node scripts/vrm/motion/preview-adv.mjs --clips idle,walk,skill01,die \
  --out tests/tmp/adv-motion/preview-smoke
```

- 复用 `preview-electron.mjs` + `viewer.html/viewer.js`（three-vrm normalized humanoid + SpringBone 按 delta 步进）；
- Electron userData 固定 `tests/tmp/electron-userdata-adv`（与 HSR 预览互不加锁，可并行）；
- 相机朝向：`--yaw` 默认 `auto` 按 `vrm-manifest.json` 的 `yawOffsetDeg`（当前目标为 0，模型规范面向 +Z，正面相机在 +Z 侧）。

产物：`tests/tmp/adv-motion/preview/<clip>-<view>-<pct>.png` + 每个 clip 一张 `<clip>-sheet.jpg`（rows=views × cols=frames）。

预期输出：

```
[preview-adv] server :5xxxx vrm=assets/vrm/aventurine-tpose.vrm yaw=0 clips=25 views=front,side,threeQuarter,hand,feet out=tests/tmp/adv-motion/preview
[preview] model: {"vrm":"assets/vrm/aventurine-tpose.vrm","yawDeg":0,"boneCount":51,...}
[preview] clip: idle {"clip":"idle","frames":60,"fps":30,"duration":2,"loop":true,"humanoid":52,"raw":0,"rawPolicy":"spring",...}
[preview-adv] sheet idle -> tests/tmp/adv-motion/preview/idle-sheet.jpg
...
[preview-adv] OK：tests/tmp/adv-motion/preview
```

**排错**

| 症状 | 根因 | 处理 |
|---|---|---|
| `--all 需要 .../index.json` | 还没跑 Step 3 | 先跑 build-adv-manifest |
| `index.json set="hsr" ≠ "adv"` | `--clips-dir` 指到了 HSR 目录 | 指回 `assets/motions/adv`（adv 预览拒绝 HSR index，防误看） |
| `electron 不存在` | 依赖未安装 | `pnpm install` |
| `VRM 不存在` | 私有资产缺 | 确认 `assets/vrm/aventurine-tpose.vrm` 存在（见 vrm-manifest） |
| 模型 T-pose 不动 / 白图 | viewer 未 ready / clip 结构错 | 看 `[preview] model:` 与 `[preview] clip:` 行；回 Step 2/4 修数据 |
| 朝向侧/背对 | yaw 配置 | `--yaw auto` 应与 manifest 一致；临时 `--yaw 0` 验证 |
| electron exit code≠0 | 无头/权限环境 | 与 HSR preview 同环境依赖；`--no-sandbox` 已内置；看 stderr |

---

## 4. 真实数据到位后的首跑检查清单

1. **Windows 侧验收**：`export_log.txt` 末行 `=== DONE mode=all ok=138 fail=0 ===`；zip 完整解压（无 0 字节 FBX）；目录里应含 `Tpose.fbx`（目录模式优先拿它当 rest 基准）。
2. **Pilot 先跑一遍（必做）**：pilot FBX 目录 → Step 1（`--fbx-dir`）→ 门禁 `python3 scripts/vrm/motion/verify-pilot.py --dir <pilot根目录>`（G0–G6 自动判定）→ Step 2 → 抽样 Step 4/5，确认真实 Biped 数据的骨骼命名/单位/帧率/rest 与合成夹具一致；此时**跳过** Step 3（覆盖不足是预期）。详见 `docs/adv-pilot-ingest-runbook.md`。
3. **全量**：Step 1（`--minimal`）→ 采样门禁（25/25、warning 逐条读）→ Step 2 → Step 3 → `--check` → Step 4 → Step 5。
4. **证据归档**（私有）：`tests/tmp/adv-motion/{samples-report,retarget-report,mapping-report,validation-report,manifest-report}.json`
   + 预览接触表 + 对拍图（对拍工具见 `docs/adv-acceptance-plan.md` / `work/adv-biped/qa/REPORT.md`）。
5. **全部通过后再进 app 接入**（§5）。

---

## 5. 后续：app 接入（本任务**未**实现，另开任务）

当前 `scripts/vrm/motion/build-app-manifest.mjs` 的 `SOURCE_SETS = ['mate','hsr']` **不含 adv**，即 adv 目前只有
`assets/motions/adv/manifest.json`（动作集级），尚未进 `assets/motions/app-manifest.json` / `app-catalog.json`。
真实数据验收通过后需要：

1. `build-app-manifest.mjs` 加 `adv` 到 `SOURCE_SETS`，并评审 adv 的 `PRIORITY_OVERRIDES` / mood 别名
   （idle 变体优先级 `clips.adv.json` 已给：StandBy=10、Idle_Show_01=8、Common_IdleShow=6…；`slot` 只允许 13 mood 或 null）；
2. 重跑 `build-app-manifest.mjs` 与 `--check`，跑 `pnpm test`（app 契约清洗/组件测试）；
3. app 侧 clip id 前缀为 `adv-`（与 mate/hsr 隔离，同名 idle 不冲突）；`rawPolicy=spring` 无需播放器额外处理。

风险提示：`src/shared/animation-contract.ts` 对 id 长度（64）/slot 枚举/时长有清洗限制，25 条 clip 的
`priority` 语义（循环变体准入 ≥-9、稀有变体 ≤-7）需要在接入任务里统一评审，不要直接照搬 HSR 的 priority。

---

## 6. 已知风险（真实数据到位前无法 100% 验证）

| # | 风险 | 说明 / 检测 | 处理 |
|---|---|---|---|
| R1 | **多文件 rest 一致性** | 目录模式共用一份 rest 基准（**优先 `Tpose.fbx`**，否则排序第一个；见 `samples-report.json#restSource`）；若各 FBX 的骨架 rest 不同，重定向可能出现整体常偏转。检测：`samples-report.json` 的 `骨架 rest 与首文件不一致` warning、`mapping-report.json` 的 rest 方向差分组异常 | 全量首跑先看 `restSource` 是否 `tpose-prefer`、再逐条读 rest 一致性 warning；若普遍不一致 → 暂停接入并向 Lead 反馈 |
| R2 | **Biped rest 不一定是 T-pose** | 采样器取 armature 的 **bind/rest 矩阵**（不是动画首帧），且目录模式优先用 `Tpose.fbx` 作基准；但若 FBX 未带 bind pose，rest 仍可能是导出时姿势 | rest-direction-fix 按实测 rest 做 swing 修正，通常可兜底；若 R1 同时出现则叠加误差 → 先按 R1 处理；预览手/脚方向明显异常时用 mapping-report 定位 |
| R3 | **单位** | 3ds Max 场景单位可能是 cm/inch，导出设置未归一 | 看 `export_log.txt` 的 `unit=` 与 `samples.sourceHipsHeightMeters`（米级≈0.95）；异常时 Windows 侧统一单位重导 |
| R4 | **take 名匹配** | 真实 FBX 的 action 名可能是 `Take 001` / `Bip001\|...` 等，与 config `takeMatch` 不一致 | 采样器单 take 文件会自动回退并 warning；看 `samples-report.json` 的 `candidate_actions` 与 take 映射；必要时给 config/take 名归一化 |
| R5 | **grounding 语义** | 站立类标 `feet`、倒地/受击/技能标 `none`（clips.adv.json 已定） | 真实预览若见倒地动作被吸地/站立动作悬空 → 修 `grounding` 标注重跑 Step 2 |
| R6 | **Biped 缩放/拉伸通道** | 采样 schema 只含旋转+hips 位移，Squash&Stretch 忽略（与 HSR 同口径） | 已知近似，报告注明；源侧夸张拉伸无法表达 |
| R7 | **手指语义** | Finger0=拇指（Autodesk 文档+BipedPlus+Avatar Toolkit 证据，rest 方向打分复核） | 真实数据用 `mapping-report.json#fingers.assignment` 复核；若拇指/食指错位（thumbVsIndex 接近 0 或赋值非恒等）再修映射 |
| R8 | **预览性能** | 25 clip × 5 view × 5 frame = 625 张 PNG + 25 张接触表，Electron 渲染较慢 | 先 `--clips` 抽几条冒烟，验收全量再 `--all`；或降 `--frames` 数量 |

---

## 7. 本次合成夹具冒烟记录（2026-11-09，tooling 自测）

> 目的：在真实 Biped FBX 未到时，用 task-5 的合成 Biped 夹具 FBX 走通「采样→重定向→manifest→validate→preview」
> 全链路，证明工具逻辑可用（**合成数据，不写入 `assets/motions/adv`，不冒充真实动作**）。
> 详细日志：`work/adv-biped/tooling/logs/*.log`，总报告：`work/adv-biped/tooling/SMOKE-REPORT.md`。

命令（在仓库根执行）：

```bash
# 0) 冒烟专用 registry：work/adv-biped/tooling/configs/clips.fixture.json（2 条 test take，requirements.test=2）
BLENDER=/Volumes/4TB外置盘/deepseek-harness/tools/blender/Blender.app/Contents/MacOS/Blender

# 1) 采样（用 task-5 的合成 Biped FBX）
"$BLENDER" -b --factory-startup --python scripts/vrm/motion/extract-biped-anims.py -- \
  --fbx work/adv-biped/fixture/biped-anim-skel.fbx \
  --config work/adv-biped/tooling/configs/clips.fixture.json \
  --out work/adv-biped/tooling/samples.json --report work/adv-biped/tooling/samples-report.json

# 2) 重定向
node scripts/vrm/motion/retarget-adv.mjs \
  --samples work/adv-biped/tooling/samples.json \
  --config work/adv-biped/tooling/configs/clips.fixture.json \
  --out work/adv-biped/tooling/clips --report-dir work/adv-biped/tooling/retarget-reports

# 3) manifest（+ --check 幂等）
node scripts/vrm/motion/build-adv-manifest.mjs \
  --dir work/adv-biped/tooling/clips \
  --config work/adv-biped/tooling/configs/clips.fixture.json \
  --report work/adv-biped/tooling/manifest-report.json
node scripts/vrm/motion/build-adv-manifest.mjs \
  --dir work/adv-biped/tooling/clips \
  --config work/adv-biped/tooling/configs/clips.fixture.json --check

# 4) 校验
node scripts/vrm/motion/validate-adv-clips.mjs \
  --dir work/adv-biped/tooling/clips --json work/adv-biped/tooling/validation-report.json

# 5) 预览（--all 走 index.json；三视角+手脚特写接触表）
node scripts/vrm/motion/preview-adv.mjs --all \
  --clips-dir work/adv-biped/tooling/clips \
  --out tests/tmp/adv-motion/preview \
  --frames 0,0.25,0.5,0.75 --views front,side,threeQuarter,hand,feet
```

结果：

| 步骤 | 结果 | 关键输出 |
|---|---|---|
| 采样 | PASS | `EXTRACT_DONE mode=single clips=2 sourceFps=30.0 sourceHeight=1.880 sourceHipsHeight=0.950`；链接骨 unconnect 49（正常 warning） |
| 重定向 | **PASS 2 / WARN 0 / FAIL 0** | `mapping: mapped=51 restFixMismatchMax=45°`；`armRaise frames=30 grade=PASS`、`hipsTurn frames=61 ground=feet(shift 0.1122m) grade=PASS` |
| manifest | PASS | `OK set=adv clips=2 coverage={"test":2} loop=1/1 grounding={"none":1,"feet":1}`；report 含 `stats.slots/grounding/loop/channels` |
| manifest `--check` | PASS（幂等） | `check OK（manifest + index 与数据一致；clips=2 coverage={"test":2}）` |
| validate | **PASS 2 / WARN 0 / FAIL 0** | U-lane validator `0 errors / 4 warnings`（额外手指骨 warning，符合预期）；`set=adv target=aventurine-tpose.vrm spring=50链` |
| preview | PASS | `[preview] model: ... height:1.734`；2 clip × 5 view × 4 frame = 40 png + `armRaise-sheet.jpg` / `hipsTurn-sheet.jpg`；接触表里模型清晰可见（armRaise 抬臂 90°、hipsTurn 转身 90° 与夹具设计值一致） |
| manifest 负向测试 | PASS（按设计拒绝） | 用真实 registry（25 条）指向只有 2 条合成 clip 的目录：`覆盖不足 4 条 + 没有任何可用 clip → ERROR 构建失败（5 errors / 25 warnings），未写盘`，exit 1 |

冒烟产物路径（私有，gitignore）：

- `work/adv-biped/tooling/samples.json` / `samples-report.json`
- `work/adv-biped/tooling/clips/{armRaise,hipsTurn,manifest,index}.json`
- `work/adv-biped/tooling/{retarget-reports/*.json, manifest-report.json, validation-report.json}`
- `tests/tmp/adv-motion/preview/{*.png, *-sheet.jpg}`（40 PNG + 2 接触表）
- `work/adv-biped/tooling/logs/*.log`（逐条命令原始输出）

**结论**：工具链逻辑正确，命令顺序可复制到真实数据流程；真实数据到位后按 §0/§3 执行即可。

---

## 8. 参考：脚本帮助与退出码

```bash
node scripts/vrm/motion/build-adv-manifest.mjs --help
node scripts/vrm/motion/validate-adv-clips.mjs --help
node scripts/vrm/motion/preview-adv.mjs --help
```

| 脚本 | 退出码 |
|---|---|
| `build-adv-manifest.mjs` | 0=成功/一致；1=构建失败或 `--check` 不一致；2=参数错误 |
| `validate-adv-clips.mjs` | 0=无 FAIL；1=有 FAIL；2=参数错误 |
| `preview-adv.mjs` | 0=成功；1=失败；2=参数错误 |

---

## 9. 一键脚本（推荐入口）

`scripts/vrm/motion/run-adv-pipeline.sh` 把 §0 的 5 步串起来（采样 → 覆盖门禁 → 重定向 → [full] manifest+check → validate → preview），已用合成夹具实测跑通（pilot 模式含 Electron 预览）。

```bash
# pilot（6 个试点文件；输出到 tests/tmp/adv-pipeline，跳过 manifest 覆盖门槛，预览匹配到的前 6 条）
scripts/vrm/motion/run-adv-pipeline.sh --fbx-dir <pilot FBX 目录> --mode pilot

# 全量 135 条 catalog（要求 135/135 采样齐全；输出 assets/motions/adv + manifest/index）
scripts/vrm/motion/run-adv-pipeline.sh --fbx-dir <全量 FBX 目录> --mode full

# 可选：--config <registry> / --tmp-dir <dir> / --clips-out <dir> / --skip-preview / --dry-run
```

> 说明：full 模式用 `clips.adv-all.json`（135 条 catalog 全收）；pilot/验收首轮用 `clips.adv.json`（25 条代表动作）。
> 源保真渲染与官方参考三列对拍仍按 §7/`docs/adv-acceptance-plan.md` §5 手动跑（不在本脚本内）。
