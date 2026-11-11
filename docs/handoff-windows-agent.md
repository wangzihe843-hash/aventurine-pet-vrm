# 给 Windows 侧执行者（豆包）的交接说明：砂金戏浪 .max → FBX 导出

> 目的：把 `砂金戏浪.zip` 里的 138 个 `.max`（3ds Max 2021 场景，Biped 骨架）导出成 FBX，回传给 Mac 侧做动作转换与验收。
> **Mac 侧已全部准备好，只等 FBX。** 不需要你改任何场景内容，不需要你在 Windows 上转换动作。

## 0. 现状与红线

- 唯一任务：**用 3ds Max 批量导出 FBX**，然后回传。不要尝试在 Windows 上做重定向/转换/改动作。
- **不要修改 `.max` 文件**、不要改场景帧率/单位/骨骼/模型（导出脚本只读场景）。
- 版权：官方游戏资源，仅本机私用；不要公开分享/上传公开链接。
- 路径建议纯英文无空格：`D:\sjxl\max`（素材）、`D:\sjxl\`（脚本与输出）。

## 1. 前置

1. Windows 必须是 **Windows 11**（3ds Max 2027 只支持 Win11）；C 盘留 ≥20GB、D 盘留 ≥10GB。
2. 安装 **3ds Max 2027 官方 30 天试用**（免费、无需信用卡）：
   - 入口：https://www.autodesk.com.cn/products/3ds-max/free-trial （或国际站）
   - Autodesk 账号登录 → 下载安装（在线安装器或完整包都行）→ 装完重启。
   - **必须先用 GUI 打开一次 3ds Max 并登录账号进入 Trial**（看到 "30 days left"），否则后面的批处理会报 license 错误（退出码 -8）。
3. `砂金戏浪.zip`（617MB，用户百度网盘里有）下载解压到 **`D:\sjxl\max\`**：该目录下应直接是 **138 个 `.max`**（不要再套一层目录）。
4. 工具包（7 个文件）放到 **`D:\sjxl\`**：来自网盘 `砂金动作转换/aventurine-max-export-kit.zip` 或 Mac 仓库 `aventurine-pet-vrm/scripts/max-export/`：
   `export_max.ms`、`run_pilot.bat`、`run_full.bat`、`run_subset.bat`、`diagnose_max.ms`、`export_one.ms`、`README-USER-GUIDE.md`（完整中文指南，优先读它）。

## 2. 执行顺序（严格按序）

### 第 1 步：pilot（先做，必须成功才继续）
双击 **`run_pilot.bat`**，输出到 `D:\sjxl\fbx-pilot`。预期内容：
- `Tpose.fbx`、`StandBy.fbx`、`Walk.fbx`、`Talk01.fbx`、`Skill01.fbx`、`State_Stun.fbx`
- 同名 `*_skel.fbx`（6 个）
- `export_log.txt`（每行一个文件，含 `fps=`/`unit=`/`frames=`/`MB=`）、`listener.log`、`max.log`

**自检**：`export_log.txt` 中 6 行全为 `OK`、无 `FAIL`；两个版本 FBX 都存在且非 0 字节；窗口 Exit code = 0。
把整个 `D:\sjxl\fbx-pilot` 压缩，放回用户百度网盘（例如 `砂金动作转换/` 下），通知 Mac 侧。

### 第 2 步：全量（等 Mac 侧确认 pilot 通过后再做！）
双击 **`run_full.bat`** → `D:\sjxl\fbx-all`。预期：
- 138 个 FBX（每个约 0.1–2MB），外加 `Tpose.fbx`
- `export_log.txt` 末行：`=== DONE mode=all ok=138 fail=0 ===`（个别文件 FAIL 可接受但要记录文件名单）
压缩整个目录回传。

### 第 3 步：subset（可选但推荐，也等确认后再做）
双击 **`run_subset.bat`** → `D:\sjxl\fbx-subset`（约 14 个带模型的关键片段，100–200MB），压缩回传。

## 3. 出问题怎么办（按顺序）

1. **先看日志**：`export_log.txt` / `listener.log` / `max.log`，把报错原文保存。
2. **跑诊断**：用记事本打开 `D:\sjxl\diagnose_max.ms`，确认 `SRC` 指向一个真实 `.max`（如 `D:\sjxl\max\StandBy.max`），在 3ds Max 里 `Scripting → Run Script...` 选它，生成 `D:\sjxl\diagnose.txt`，回传。
3. **手动兜底**：若批处理完全跑不起来，在 3ds Max 里逐个打开 pilot 的 6 个 `.max`，每次 `Scripting → Run Script...` 选 `export_one.ms`，导出到 `D:\sjxl\manual\`，6 个都导完后压缩回传。
4. 常见弹窗：缺失贴图/外部文件 → **Skip All/跳过全部**（不影响动作）；缺插件（Corona/V-Ray）→ **Ignore/忽略**。
5. **批处理 Exit code**（官方 3ds Max Batch 文档值）：`0` 成功；`-8` 试用未激活→先 GUI 登录；`-7` 图形设备→改用 GUI Run Script；`-130` 脚本报错→把 `listener.log`/`max.log` 发回；`-110` Max 进程起不来→重启后重试；`-120` 通信失败→杀进程重试。
6. 不要自己改脚本参数/导出设置来"修复"问题；把日志发回由 Mac 侧判断（导出设置是查证过官方文档的，随意改会引入数据问题）。

## 4. 回传验收核对（Mac 侧会做，你也可以先自查）

| 检查 | 期望 |
|---|---|
| `Tpose.fbx` 存在 | 是（Mac 侧要用它作为 rest/T-pose 基准） |
| 骨架 | 每个 FBX 内应有 Biped 骨（Pelvis/Spine/Neck/Head/L|R UpperArm/…），骨数 ≥60 |
| 单位/身高 | 髋部高约 0.95 单位（cm 口径≈0.95m），角色高约 1.7 |
| 帧率 | 记录在 `export_log.txt` 的 `fps=`（30 或 60 都可能，Mac 侧会处理混用） |
| 动画 | 每个动作 FBX 的帧数 >0，且与文件名对应动作时长相当 |

有任何一项异常，先别继续，把日志和异常文件清单发回。

## 5. 关键提醒（一句话版）

**先 GUI 登录试用 → 解压到 D:\sjxl\max → 双击 run_pilot.bat → 回传 fbx-pilot → 等 Mac 回复 → 再 run_full.bat + run_subset.bat。** 不要改场景、不要改脚本参数、不要公开分享。

---

## 6. 2026-11-09 pilot 回传后的反馈（重要，下一步照这个做）

Mac 侧已收到并验证 `fbx-pilot`：**格式/骨架/单位/fps/时长全部通过**，但发现 **2 个导出设置问题**（详见 `PILOT-FINDINGS.md`）：

1. **P1（阻塞）Biped 身体动画没导出**：65 根 Biped 骨在 FBX 里没有动画曲线（只有头发/表情等 267 根次级骨有），所以动作是静止 T-pose。
2. **P2（次要）`_skel` 没瘦身**：`deletedMeshes=0`，骨架版和全场景版一样大（Mac 侧已改脚本修好，重跑即可）。

请执行（约 2 分钟）：

1. 把新版工具包里的两个脚本放到 `D:\sjxl\`：`probe_scene_anim.ms`、`export_experiments.ms`（网盘 `砂金动作转换/aventurine-max-export-kit.zip` 里已有）。
2. 3ds Max 里 `Scripting → Run Script...`：
   - 先跑 **`probe_scene_anim.ms`** → 生成 `D:\sjxl\probe-scene-anim.txt`（诊断 Biped 是否在动/隐藏/参数支持）；它默认打开 `D:\sjxl\max\StandBy.max`，需要时改脚本开头 `SRC`。
   - 再跑 **`export_experiments.ms`** → 导出 **10 个设置变体**到 `D:\sjxl\exp\`（每 5–10MB，合计约 60–90MB）。脚本会：
     - 探测并打印 FBX 导出参数是否被识别；
     - 探测 Biped Figure Mode 状态（并尝试关闭，变体 G/H）；
     - 打印 Biped Layers（层数/层名/是否 active）并在变体 I/J 中把所有层激活、合并到 base layer 后导出；
     - 全部结果写进 `experiments-log.txt`。
     如果日志显示 Figure Mode 探测不到，请手工确认一次：选中 Biped 根（如 Bip001）→ Motion 面板 → Biped rollout → Figure Mode（小人图标）是否高亮？高亮的话点一下关掉，再单独重跑一次 `export_experiments.ms`（已关闭状态下 G–J 变体会正常）。
3. **额外做个手动对照（1 分钟）**：用 3ds Max GUI 默认设置导一次 `StandBy.max`：
   - 打开 `D:\sjxl\max\StandBy.max` → `File → Export → Export...` → 类型选 **FBX (*.FBX)** → 存到 `D:\sjxl\exp\StandBy_gui.fbx`；
   - 对话框默认预设（**Autodesk Media & Entertainment**）、勾选 **Animation**（Bake Animation 保持默认勾选）→ OK。
   - 这个文件用来区分「MaxScript 参数问题」还是「场景/Figure Mode/图层问题」。
4. 把 `probe-scene-anim.txt` + `D:\sjxl\exp` 文件夹压缩传回 Mac。
4. **等 Mac 回复正确设置后**再重跑 `run_pilot.bat`；建议先只发 `StandBy.fbx` + `Skill01.fbx`（含 skel 版）做快速验证，通过后再跑全量 6 个 pilot 文件。

不要自己改导出参数试；6 个变体已经覆盖了最可能的组合，Mac 侧会逐个检查哪个变体保留了 Biped 动画。

---

## 7. 2026-11-09 晚 v2 复核结论（以这份为准）

豆包第二版 `fbx-pilot-v2.zip` 已复核：**与第一版数据等价**——12/12 FBX 的 Biped 骨仍是 0 条动画曲线，6 个 `_skel` 与 v1 逐字节相同（P1/P2 均未修复），且没有回传任何日志/诊断物（`export_log.txt`、`probe-scene-anim.txt`、`exp` 变体、`StandBy_gui.fbx` 都没有）。

**下一轮唯一任务**（不需要写/改脚本，约 5 分钟，纯 GUI）：
1. 打开 `StandBy.max` 播放，录屏 + 截 Motion 面板（Figure Mode / Biped Layers）状态；
2. 用 3ds Max 的 GUI 手动导出 `StandBy_gui.fbx`（Animation + Bake Animation + Resample All，Bake 范围=场景范围），自己导入回空场景自检后回传。

完整指令（含分支处理/回传清单/红线）：**`docs/doubao-v2-problem-report.md`**（网盘同名副本：`砂金动作转换/给豆包的v2问题报告与改进方案.md`）。
对比证据与根因调查：`docs/pilot-v2-comparison-2026-11-09.md`。本轮**不要**跑全量、不要再用旧批量方式重导。

---

## 8. 2026-11-09 晚 v3 复核结论（以这份为准）

豆包第三版 `fbx-pilot-v2-gui.zip`（包内实际为 v3）**已通过 pilot 门禁**：P1（Biped 0 曲线）与 P2（`_skel` 不瘦身）均修复，12/12 FBX 数据自检通过、日志/诊断/源码齐全。**可以放行全量 138 的 `_skel`。**

- v3 复核细节：`docs/pilot-v3-comparison-2026-11-09.md`
- **给豆包的全量导入指令与增强自检要求**：`docs/doubao-v3-problem-report.md`（网盘同步 `砂金动作转换/给豆包的v3全量导出指令与改进方案.md`）
- 本轮新发现（**Mac 侧待办，不是豆包问题**）：① v3 FBX 新增 `Bip001` 根对象动画（转身/位移/竖直起伏），当前采样器只采骨骼、未采对象级动画 → Skill01/State_Stun/Walk 的 VRM 输出缺这部分，待 Mac 侧修 `extract-biped-anims.py`（方案见 v3 报告 §5.3）；② 重定向库旧的“首帧参考姿势裁剪”启发式误裁 `State_Stun` 前 2 帧，已修（`scripts/vrm/motion/lib/retarget.mjs` 限定 HSR 源）。
- 旧文档 `docs/research/max-windows-routes.md` 里“强烈建议 `Bip2FBX true`”的建议**已证伪并标注禁止**（见该文件 §12.3.1/§12.3.2/§12.8 的修订）。

---

## 9. 2026-11-09 晚 追加：水枪网格已找到，本轮无新增任务（以这份为准）

Mac 侧已在 pilot 回传的**全场景 FBX**（`Skill01.fbx`/`Tpose.fbx` 等）里找到游戏角色模型 + 独立水枪网格 `0009_Weapon`（4642 顶点/4508 面）+ 武器骨 `Gun_b/c/d/e_01_JNT`/`prop_JNT`，并用本地 `assets/model/水枪.png` 验证 UV 吻合；已提取为 `assets/props/watergun/watergun.glb`（方案见 `docs/research/watergun-prop-plan.md`）。

**给 Windows 侧的增量要求（很少，按序照做即可）：**

1. **全量 138 继续按 `run_full.bat` 的 `skeleton-only` 导出，保持不变**；**不要**改成全场景/带模型导出（体积会涨到 GB 级，没必要）。
2. **保留** `D:\sjxl\fbx-pilot*` 里回传过的全场景 FBX（尤其 `Tpose.fbx`、`Skill01.fbx`），不要删——水枪网格只在这些全场景文件里，Mac 侧已够用。
3. **可选**：若 `D:\sjxl\max\` 目录里能看到 `Avatar_AventurineW_00_Weapon_Color.png` 等游戏贴图，把这一张单独打包回传（用于和本地 `水枪.png` 对比；不回传也不影响）。
4. **只有后续需要「技能里武器自身动画」时**（Mac 侧会另行通知）才用 `run_subset.bat` 补导约 14 个关键片段的**全场景 FBX**（含武器网格/武器骨动画）。**本轮不要动 subset。**
5. 其余红线不变：不改 `.max`、不改脚本参数、不公开分享。

> 2026-11-09 晚补充：水枪已在 Mac 侧接入 app（V1，运行时挂点）；规则为**只有 `adv` 动作集里的 `skill` 类动作持枪，idle/walk/talk/stun 等普通动作不持枪**。对 Windows 侧仍无新增任务。

---

## 10. 2026-11-09 晚 v4 全量回传后的最终结论（以这份为准，Windows 侧本轮无新增任务）

豆包全量回传 `fbx-all-v3.zip`（138 个 `_skel.fbx`）已通过本机验收并完成转换/接入：

1. **数据真实性 100% 通过**：sha256 138/138、keytime 138/138、二进制结构、导出日志 138 行全 OK；`Bip2Fbx` 红线（从未设 true + 每文件回读 false）落实有效。
2. **pilot v3 与全量 v3 数据级完全等价**（6 个同名 take 逐帧逐分量 bit-identical）——本轮豆包"重做之前测试动作"没有引入任何变化，验证了 v3 导出设置可复现；**统一使用全量数据**。
3. **已知数据特征（不是错误）**：60fps 场景固定 30 key/s（27 个，时长/时序正确）、4 个 60fps 奇数帧尾多 1 key（0–16.7ms）、40 个 30fps 非整数帧尾 ceil、Idle_Show_01/02 次级骨长曲线把时间轴拉到 366/411 帧（Mac 侧已按 Biped 167 帧裁剪修复）。
4. **Mac 侧已修**：Bip001 对象级根运动采样（方案 A，A0=各 clip 首帧，不能用 Tpose 基准）；Idle_Show 帧范围；loopSeam 校验口径；全量首跑暴露的 5 个 staging clip 根切镜（`sourceRootMotion:ignore`）与源 1–3 帧姿态尖峰（保守净化）。
5. **产物**：`assets/motions/adv/` 137 clip（135 + `StandBy (2)`/`Skill04 (2)` 两个不同变体；Tpose 不入 clip），retarget/validation **0 FAIL**；app 已接入（app-manifest 38 / catalog 180）；水枪按数据驱动白名单 7 条持枪（其余空手，含官方实机确认无枪的过场技能）。
6. **验收报告**：`docs/adv-full-v3-acceptance.md`（总报告）、`tests/tmp/adv-full-v3/evidence/VERIFY-FULL-138.md`（数据）、`tests/tmp/adv-full-v3/pipeline/PIPELINE-REPORT.md`（转换/接入）、`work/adv-biped/qa/full-acceptance/REPORT.md`（实机三级对拍）、`docs/research/watergun-adv-integration.md`（水枪）。

**Windows 侧后续（仅当需要时）**：① 若需要 60Hz 原始密度或"武器自身动画"的 subset 全场景导出，另行通知（本轮不做）；② 无需重导、无需改导出设置。
