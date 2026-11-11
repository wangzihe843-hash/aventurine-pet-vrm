# Wave 1.5 手指补全报告（22 骨 → 22 + 30 手指）

> 日期：2026-11-08 · 状态：**已完成并验证**（29 clip 全部补 30 根手指；数据/GT/视觉证据齐全）
> 触发：用户实机观感「Wave 1.5 的动作关节末端（尤其手指）不细致」，要求调查是 Mate-Engine 原版没有细节，还是转换丢了。
> 结论：**源动画有手指细节，是转换侧只采 22 骨丢掉了**。已用 Unity+UniVRM 真实 VRM avatar 手指探针补回
> 30 根手指（每 clip +30 条 normalized 旋转轨道），并完成 Unity GT 数值对拍、参考视频对比与手部特写视觉验收。
> 关联：`docs/wave15-report.md`（U2/U3 主报告）、`docs/vrm-tpose-repair.md`、`docs/vrm-motion-hsr.md`（V3 的 52 骨手指链路）

---

## 0. 摘要

| 项 | 结果 |
|---|---|
| 源数据事实 | 29/29 选中 clip 都是 Unity Humanoid muscle clip，每个带 **40 条手指 muscle 曲线**（每手 20：5 指 × 3 节 Stretched + 1 条 Spread）；15 个 clip 手指活动强、4 中等、4 轻微、6 为恒定手型（详见 §2） |
| 丢失根因 | Wave 1.5 的 U2 管线是 **22 骨契约 + 合成 humanoid 骨架**：`includeFingers` 开关存在但从未启用，且合成骨架没有手指骨（开了也采不到）；下游 map/validator/preview 全按 22 骨 |
| 原版是否动手指 | **是**。Mate-Engine 自带 Zome 的 Unity Avatar 资产映射了 30 根手指骨（`m_LeftHand/m_RightHand.m_HandBoneIndex` 15+15，`m_HumanDescription` 53 人形骨）；官方 trailer/B站演示里也能看到手指级手势（张开掌/剪刀手/指人/握拳）。Zome 官方素材手被大袖遮住，无法逐关节对比 |
| 补全方案 | Unity + 同款 UniVRM 导入目标 VRM（`aventurine-tpose.vrm`）→ 逐帧采样全部 humanoid 骨 worldRot → 按 three-vrm normalized 语义换算手指 r → 合并进已烘焙 clip（保留原 22 骨不动） |
| 交付数据 | `assets/motions/mate/**`（私有）：29 clip × (22 核心 + 30 手指) = **52 骨/ clip**；帧数、Hips 位移、22 核心骨数据完全不变 |
| 数据校验 | `validate-clips` **29 PASS / 0 WARN / 0 FAIL**；`build-motion-manifest --check` PASS |
| 数值对拍 | 用同一 GT 公式重算 22 核心骨 vs 已烘焙 r：平均 **0.29–1.02°**（预期级）；three-vrm 回放（含手指）vs Unity GT 手指段方向误差：idle **1.8°**、walk 2.5°、drag 1.8°、sitWindow 2.4°、sleep 6.6°（sleep 的 wrist 段也 8.7°，误差来自躺姿 body 链而非手指），段长比 **1.0000** |
| 跨模型一致性 | 同一份 normalized 手指旋转在 Zome 与 aventurine 上：30 指平均差 **0.44°**（拇指 ≤5°）→ 手指数据是模型无关的 normalized 空间 |
| 视觉验收 | 手部特写 + 全身渲染证据：`tests/tmp/fingers/preview/**`（348 PNG）、`tests/tmp/fingers/metrics/**`（29 份）、`tests/tmp/fingers/montages/HANDS.jpg`、`FULLBODY.jpg` |
| 回归 | `pnpm test` 全绿、`pnpm typecheck` exit 0；29 clip 的 body 自然度 metrics 与补前**逐项相同**（仅 loopSeam 因手指骨纳入统计有 <1° 的小变化） |
| 回滚 | 补手指前的 29 clip 备份在 `work/backup/mate-pre-finger/`（私有，gitignore）；删除/恢复该目录即可回滚数据 |

---

## 1. 调查方法与证据链

三条独立证据：

1. **源 `.anim` 解析**（`refs/Mate-Engine/Assets/MATE ENGINE - Animations/**`）：直读 Unity YAML 的
   `m_FloatCurves`，确认 29 个选中 clip 都有 40 条手指 muscle 曲线，并统计每条曲线的 range。
2. **Unity 真实 avatar 手指探针**（`work/UnityGroundTruthProj`，Unity 6000.2.6f2 + Mate-Engine 同款 UniVRM 0.128.3）：
   用 `Vrm10Importer` 导入目标 VRM 得到 53 骨 humanoid Avatar（含 30 手指），用 `AnimationMode.SampleAnimationClip`
   逐帧采样全部 humanoid 骨的 worldRot；先对 4 clip（zome+aventurine）小批量验证换算公式，再全量 29 clip（aventurine）。
3. **参考视频/媒体**（`tests/tmp/wave15/reference/**` + 追加抽帧 `tests/tmp/finger-ref/**` + 联网检索）：
   Steam 官方 trailer 1080p、官方截图、B站 4 个教程/演示视频、GitHub README；逐帧裁手部特写核对。

---

## 2. 源数据：Mate-Engine 原版每 clip 都有手指通道

Unity Humanoid 每手 20 条手指 muscle：`Thumb/Index/Middle/Ring/Little` × `{1/2/3 Stretched, Spread}`，两手共 **40 条**。
按通道 range（muscle 单位，±1≈关节极限；Unity 不 clamp，源里存在超 ±1 的作者值）分档：

| 档位（手指 range） | 数量 | clip |
|---|---|---|
| strong（≥1.0） | 15 | idle2, idle4, idle5, idle6, idle7, drag, happy, laughing, shyPoint, sleep, hideLeft, hideOnce, introLoop, introStart, introEnd |
| moderate（0.3–1.0） | 4 | idle3, walk, walkAlt, sit2 |
| subtle（0.05–0.3） | 4 | windowLay10, suwari3, sit1, pose1 |
| static（<0.05，恒定手型） | 6 | idle, sitWindow, windowLay8, windowLay9, pose2, pose3 |

具体例子（GT 采样换算到 normalized 后的角度，见 §4）：

- `idle`（PET_IDLE）：手指恒定微弯（约 59°），**不是 T-pose 张开手**；手腕也不动（<2°）。
- `idle5`（PET_IDLE_8）：手指相对 rest 最大弯曲 **151.6°**、clip 内手指运动量 **135.6°**（左右小指/无名指中节为主）。
- `happy`（PET_HAPPY）：手指最大弯曲 **105.1°**、运动量 **71.8°**（握拳/指向类手势）。
- `drag`（PET_DRAGGING）：手指运动量 **58.3°**；`sleep` 手指运动量 **120.9°**；`walk` 23.6°；`shyPoint` 25.4°。
- 6 个 static clip 的恒定值本身是 authored 手型（很多是半握/弯指），补采样后手型与原动画一致、不再是 T-pose 平摊手。

**结论：不是 Mate-Engine 原版没有细节，而是我们只采了 22 骨把 40 条手指通道整段裁掉。**

---

## 3. 丢失根因（代码层）

| 位置 | 现状（补全前） | 说明 |
|---|---|---|
| `scripts/unity-bake/clips.json` | `"includeFingers": false` | U1 就写下开关，但从未启用 |
| `Editor/ClipExporter.cs` | `CollectBones(animator, includeFingers)`；`BuildSyntheticHumanoid()` 只有 22 骨 | 合成骨架没有手指 `Transform`，**开关即使 true 也采不到**（`GetBoneTransform` 返回 null） |
| `scripts/unity-bake/lib/humanoid-map.mjs` | 22 骨映射，注释「未来 includeFingers 可扩展」 | 手/腕有，手指无 |
| `tests/unity-bake-humanoid-map.test.ts` | 写死 22 骨 | 扩展点未实现 |
| GT 对拍 lane | `FrameBoneNames` 也写死 22 骨 | 连「和原版对拍」都没覆盖手指 → 缺口一直未暴露 |
| 冻结契约 `src/shared/vrm.ts` | `HUMANOID_BONES` 本来就含 30 手指（可选） | **契约不是阻塞点**，阻塞在实际采样链路 |

另外，Mate-Engine 自带 Zome Avatar（`refs/Mate-Engine/Assets/MATE ENGINE - Avatar/Zome.Avatar/VrmAvatar.asset`）
`m_LeftHand/m_RightHand.m_HandBoneIndex` 各 15 项、`m_HumanDescription` 53 个人形骨（含全部手指）→ 原版 app 会驱动手指；
动画 controller 无 AvatarMask（`m_Mask: {fileID: 0}`），humanoid clip 的手指曲线正常生效。

---

## 4. 参考视频对比（能验证到哪一层）

> 详细逐帧表与素材索引：`tests/tmp/finger-ref/NOTES.md`、`tests/tmp/finger-ref/FINGER-KEY-MONTAGE.jpg`、
> `tests/tmp/finger-ref/finger-curve-ranges.csv`；原参考媒体索引：`tests/tmp/wave15/reference/README.md`。

| 来源 | 手部可辨度 | 看到的手指 | 结论 |
|---|---|---|---|
| Steam 官方 trailer 正片 | pet 尺度下手指 10–25px，基本不可辨；唯一大近景 02:27「catch your mouse」 | **全程握拳**（五指粘成拳块） | 手势级：握拳 |
| Steam 官方静帧 `steam-06` | 手掌张开、可辨 | **张开掌、五指分开** | 手势级：张开 |
| B站 BV143 01:44–02:20 舞蹈 | 手 50–70px，可辨 | 01:49 张开掌、01:51 **剪刀手 V**、02:16 **双食指指人**，0.2–1s 内切换 | 手势级：开/握/V/指人 |
| B站 BV14 开头 0–5.3s / GitHub 官方预览 | 180px 小窗 / 大袖遮手 | 不可辨 | Zome 无可用手部参考 |
| idle/sit/lying/drag/walk/headpat | 8–15px 或特效遮挡 | 「连指手套/扁铲/半握」不可辨 | 无法逐关节对比 |

**参考视频只能支撑 gesture-level 验收**（手掌张开/握拳/V/指人），不足以逐关节对比；而参考媒体本身已证明原版 app 的手指是动的、
且与源数据「有手指动作」一致。我们补出的数据在相同手势级别上与之相符（§6 手部特写）。

---

## 5. 补全方案与关键公式

### 5.1 路线（小批量验证后定型）

1. **Unity 真实 VRM avatar 采样**（优先于「合成骨架扩 30 指」）：用 `work/UnityGroundTruthProj`（已有 UniVRM 运行时导入）
   导入**目标** `assets/vrm/aventurine-tpose.vrm`（53 humanoid 骨含 30 手指），逐帧 `AnimationMode.SampleAnimationClip`
   后导出全部 humanoid 骨的 `worldRot`（`GT_ALL_HUMANOID_BONES=1`，`work/gt-src/GroundTruthExporter.cs` 已加该开关）。
2. **换算成 three-vrm normalized 手指旋转**（与 HSR V3 lane 的 `localNormalizedQuat` 同义）：
   ```
   ΔW_b = W_pose_b · W_rest_b⁻¹                     （b = 骨；世界旋转 delta）
   N_b  = ΔW_parent⁻¹ · ΔW_b                         （parent = normalized humanoid 父骨；three-vrm normalized 语义）
   r_b  = unityToGltfQuat(N_b) = (x, -y, -z, w)       （与 convert-clips.mjs --axis x 同一映射）
   ```
   合成骨架方案里的 `qNorm = inv(restLocal)·localRot` 是 rest=identity 时的特例；本方案对真实 avatar 的 rest≠identity 仍成立。
3. **合并进已有 clip**：只追加 30 根手指的 `r` 轨道，**保留原 22 骨数据/帧数/Hips 位移不动**；
   工具 `scripts/unity-bake/merge-finger-tracks.mjs`（会重算 22 骨做护栏校验、打印每 clip 手指活动量）。
4. **下游扩展**：`humanoid-map.mjs` +30 手指映射（拇指错位一节的 Unity↔VRM 映射已用 rest 位置逐骨核验）；
   validator 增加 `CLIP_OPTIONAL_BONES`；预览工具新增手部特写相机（`PREVIEW_HANDS=1`）。

### 5.2 小批量验证（先 4 clip，再全量）

- **公式/映射验证**：用同一公式重算 22 核心骨，与已烘焙 r（合成骨架 pipeline 产物）对比——zome 平均 0.53°、
  aventurine 平均 0.60°；三-vrm 回放手指 vs Unity GT 手指段方向（同模型）：idle 1.8°、walk 2.5°、drag 1.8°、sitWindow 2.4°，
  段长比 1.0000；sleep 6.6° 但同 clip 的 wrist 段误差 8.7°（误差来自躺姿 body 链而非手指）。
- **跨模型一致性**：同一 clip 在 Zome/aventurine 上 normalized 手指旋转平均差 0.44°（拇指 4–5°）→ 选**目标模型**
  `aventurine-tpose` 做全量探针（与最终播放模型一致，避免 VRM0 朝向约定差异）。
- **不做 clamp**：Unity 不 clamp muscle 值；源里存在 |v|>1 的作者值（如 idle5 的 −2.4、舞蹈最高 5.81），
  在 Unity 内采样即保真；我们保留原值（视觉上 idle5 最极端帧经手部特写检查无破形，见 §6）。若未来实机认为个别帧过弯，
  可再加“可配置软限位”，但默认不改数据。
- **帧对齐**：探针帧数 = round(duration*fps)（非 loop +1），与 U1 导出规则一致；merge 脚本对 frames 不一致的 clip 直接跳过并报警。

---

## 6. 验证结果

### 6.1 数据与回归

| 检查 | 结果 |
|---|---|
| `validate-clips`（29 clip，含手指必填） | **PASS 29 / WARN 0 / FAIL 0** |
| `build-motion-manifest --check` | PASS |
| body22 重算 vs 已烘焙 r（29 clip） | 平均 **0.29–1.02°**（与 # 预期一致；个别帧 max 至 ~23° 属 upperChest 缺失/瞬时） |
| `pnpm test` / `pnpm typecheck` | 全绿 / exit 0（新增 finger merge CLI 测试、humanoid-map/validator/assets 测试更新） |
| 29 clip body 自然度 metrics（补前 vs 补后） | 除 loopSeam（手指骨纳入统计，<1° 小变化）外**逐项相同** |

### 6.2 Unity GT / 视觉

- 同模型（aventurine-tpose）three-vrm 回放（含 30 手指）vs Unity GT：见 §5.2 段方向误差表；段长比 1.0000。
- 手部特写（`tests/tmp/fingers/preview/**-hand-*.png`）：idle 微弯手型、idle5 开掌、walk 放松手、happy 握拳、
  drag 开掌向上、sleep 手垫在头侧、hideLeft 五指张开、pose1 手指展开——**无破形/反关节/大面积穿模**；
  汇总 `tests/tmp/fingers/montages/HANDS.jpg`（12 clip 特写）与 `FULLBODY.jpg`（同帧全身）。

---

## 7. 已知限制

1. **上限 = Unity Humanoid 手指维度**：每只手 20 条 muscle（每指 3 个单轴弯曲 + 1 个开合），不是 HSR 的 30 骨 × 3 轴；
   补齐后手势自然，但达不到 HSR 战斗 clip 的逐关节精细度（HSR `skill01` 单指可到 124°，是 3 轴全骨旋转）。
2. **源里有超 ±1 的 muscle 值**（作者数据），Unity 不 clamp，本方案保真保留；如实机觉得个别帧过弯，可后续加可配置软限位。
3. **6/29 个 clip 手指是恒定手型**（idle/sitWindow/windowLay8/9/pose2/3）：补完后手型正确但没有手指运动。
4. **眼/颌/尾巴未补（已确认落点）**：
   - **颌/口型是表情层的事，不是骨骼层**：29/29 源 clip 的 `Jaw Close` / `Jaw Left-Right` 曲线 range **全为 0**；
     目标 `aventurine-tpose.vrm` 也没有 **jaw humanoid 骨**（53 个 humanoid 骨里无 jaw）。Mate-Engine 的张口/口型在
     **blendshape / face layer**（`FACE_LAYER/*.anim`、`UPDATE_2/PET_TALKING.anim` 的 `A/E/I/O/U` 等 26 条 shape-key 曲线），
     对应 VRM 能力是 expression 预设 `aa/ih/ou/ee/oh`（目标模型都有）→ **留到 V6/V10 表情层做，不补进骨骼 clip**。
   - **眼**：源有少量 eye muscle 运动（idle6 0.93、windowLay10 0.80、suwari3 0.27），VRM 有 leftEye/rightEye 人形骨；
     但眼动同样归 lookAt / 表情层（用户确认之后补）。
   - **尾巴**：intro 系 5 条 `Manuka_tail` 非人形曲线对戏浪无意义，不补。
5. **VRM0 目标注意**：本数据按标准 VRM1（面向 +Z）烘焙（`--axis x`）；播放到 VRM0/面向 -Z 模型需按既有约定换算（见 `docs/vrm-tpose-repair.md`）。
6. **参考视频只能到手势级**：Zome 官方素材手被大袖遮挡；Steam trailer 角色非 Zome；逐关节正确性以 Unity GT 数值对拍为准。
7. 数据/探针均为私有（`assets/**`、`work/**`、`tests/tmp/**`，gitignore），不随 app 分发。

---

## 8. 复跑命令

```bash
# 0) 前置：Unity 6000.2.6f2 + 授权 + work/UnityGroundTruthProj（GT lane 私有工程，含 UniVRM）
#    目标 VRM = assets/vrm/aventurine-tpose.vrm；GT 工程 Assets/Clips/MateAnimations 需含 29 个 .anim

# 1) 全量手指探针（目标模型，导出全部 humanoid 骨 worldRot；输出 work/finger-probe/full-aventurine）
GT_CONFIG="$PWD/work/gt-finger-probe-full.json" GT_MODE=full \
GT_OUT="$PWD/work/finger-probe/full-aventurine" GT_RENDER=0 GT_ALL_HUMANOID_BONES=1 \
  ~/.unity/bin/unity run "$PWD/work/UnityGroundTruthProj" --no-tail --timeout 1800 \
  -l "$PWD/work/finger-probe/run-full.log" -- -executeMethod GroundTruth.Exporter.Run

# 2) 合并手指轨道（22 → 52 骨；先备份 assets/motions/mate）
node scripts/unity-bake/merge-finger-tracks.mjs \
  --gt work/finger-probe/full-aventurine/unity --model aventurine \
  --in assets/motions/mate --out assets/motions/mate \
  --report work/finger-probe/full-merge-report.json

# 3) 校验 + manifest
node scripts/unity-bake/validate-clips.mjs
node scripts/unity-bake/build-motion-manifest.mjs --check

# 4) 预览（含手部特写 + metrics）
PREVIEW_HANDS=1 node scripts/unity-bake/preview-clips.mjs --all \
  --vrm assets/vrm/aventurine-tpose.vrm \
  --frames 0,0.25,0.5,0.75 \
  --out tests/tmp/fingers/preview --metrics tests/tmp/fingers/metrics

# 5) 测试
pnpm test && pnpm typecheck
```

- 探针配置：`work/gt-finger-probe-full.json`（29 clip）；分析脚本：`work/finger-probe-analyze2.py`、
  `work/finger-validate-compare.py`；three-vrm 对拍：`work/gt-threevrm.mjs` + `work/gt-finger-validate.json`
  （均私有 dev-only，不提交）。
- 手部特写相机在 `scripts/unity-bake/clip-viewer.js` 的 `captureHandAt`，由 `preview-electron.mjs` 的
  `PREVIEW_HANDS=1` 触发（`PREVIEW_MOTIONS_REL` 可指向试跑目录）。

## 9. 变更文件 / 回滚

| 类型 | 文件 |
|---|---|
| 提交代码 | `scripts/unity-bake/lib/humanoid-map.mjs`（+30 手指）、`lib/clip-validation.mjs`（optionalBones 默认静默）、`validate-clips.mjs`（显式检查手指）、`merge-finger-tracks.mjs`（新）、`clip-viewer.js`（手部特写相机）、`preview-electron.mjs`（PREVIEW_HANDS / PREVIEW_MOTIONS_REL） |
| 提交测试 | `tests/unity-bake-humanoid-map.test.ts`、`unity-bake-clip-validation.test.ts`、`unity-bake-cli.test.ts`、`unity-bake-assets.test.ts`、`unity-bake-finger-merge.test.ts`（新）、`fixtures/unity-bake/fixtures.ts` |
| 私有数据 | `assets/motions/mate/*.json`（+30 手指轨道；gitignore） |
| 私有证据 | `work/finger-probe/**`、`work/finger-trial/**`、`work/backup/mate-pre-finger/**`、`tests/tmp/fingers/**`、`tests/tmp/finger-ref/**`、`tests/tmp/wave15/**` |
| 回滚 | 用 `work/backup/mate-pre-finger/*.json` 覆盖回 `assets/motions/mate/`（恢复 22 骨数据）；代码回退本报告列出的提交即可 |
