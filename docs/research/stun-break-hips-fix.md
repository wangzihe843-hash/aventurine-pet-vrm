# 修复：抛掷/高处落下触发 stun/break 时的「腰部固定 → 起跳 + 蜷缩」（2026-11-09）

> 状态：**已修复 + 已验证**（数据管线 + 重新生成 HSR 动作数据；纯数据/工具链改动，运行时播放器不需要改）。
> 关联：`docs/vrm-motion-hsr.md`（HSR 动作管线）、`scripts/vrm/motion/lib/retarget.mjs`（Hips 基准/参考帧裁剪）。
> 用户反馈：把桌宠拿起来从高处扔下并触发 stun/break 时，会出现类似「突然起跳然后蜷起来」的状态。

## 0. TL;DR

两个数据 bug 叠加，**不是播放器的问题**：

1. **`stun` / `hitL` 的 Hips 竖直基准错误**：retarget 的「首帧 T-pose 参考帧裁剪」启发式误把这两个
   take 的**真实首帧**（站立 → 受击的合法 snap）裁掉，导致 Hips 基准落在动作中段的受击下蹲帧上。
   `Hips.p` 于是从「下蹲 -0.176m」变成「上升 +0.16m」（×1.122 缩放 ≈ **+0.18m**）——
   播放时角色整体抬升 18cm，即用户看到的「突然起跳」。
2. **`breaked` / `revive` 丢失绝对髋高**：这两个 clip 用「相对首帧」的 Hips.p，而它们的首帧本身就是
   跪姿/趴跪（源 hips 世界高度 `0.455m` / `0.401m`，站立 rest 为 `0.950m`）。首帧基准把绝对下沉量
   当成 0 → 腰停在站立髋高（1.066m）、腿在下方折叠 = 悬空「蜷起来」；`revive` 的起身竖直位移
   （0.535m）还被 `heightRange > 0.5m → staging 归零` 启发式误清成 0。

修法：给「跪/趴/起身/受击」类 clip 增加 `hipsBase: "rest"`（= VRMA / three-vrm 的绝对髋高语义），
参考帧裁剪增加「该帧必须接近 rest」的判定，rest 基准的 staging 阈值放宽到 1m。重新生成 4 条 clip
（`stun` / `hitL` / `breaked` / `revive`），其余 10 条 HSR clip 字节不变。

## 1. 证据（修复前）

| clip | Hips.p Y（修复前） | 源采样 hips 世界高度 | 结论 |
|---|---|---|---|
| `stun` | 0 → **+0.1604**（×1.122≈+0.18m）@0.45s | 0.931 → 0.755m（下蹲 -0.176m） | 方向相反 = 起跳 |
| `hitL` | 0 → **+0.0783** | 0.862 → 0.940m（下蹲 -0.088m） | 方向相反 |
| `breaked` | ≈ 0（-0.003~0） | 恒 **0.452~0.455m**（跪姿） | 绝对下沉量丢失 ≈ 0.5m |
| `revive` | 全 0 | **0.401 → 0.936m**（起身 +0.535m） | 被 staging 归零清掉 |

交叉证据：同语义的 `assets/motions/adv/stun.json`（另一条 3ds Max→VRM 管线）Hips.p Y = **-0.207m**
（正确的向下方向）。

复现：`node scripts/vrm/motion/retarget-hsr.mjs --out /tmp/hsr-retest`（旧代码）得到同样的 +0.1604。

## 2. 修复内容

### 2.1 `scripts/vrm/motion/lib/retarget.mjs`
- 新增 `isRestLikeReferenceFrame(frame, rest)`：参考帧必须「整体接近 rest」（平均偏差 ≤12° 且 80%
  骨骼偏差 ≤20°）；受击/眩晕首帧偏差 38.9°（53/236 骨 >45°），**不是**参考帧。
- 裁剪循环增加上述判定：只有 `bigJumps ratio > 0.15` **且**被丢弃帧接近 rest 才裁。
- Hips 基准：`clipDef.hipsBase`（`first-frame` 默认 | `rest`）。
  - `rest`：`Hips.p = 源 hips 世界位置 − 源 rest 髋高`（绝对偏移，首帧不为 0）；
  - staging 阈值：`rest` 基准用 **1m**（真实起身/倒地 ≤1m；HSR staging 数米），`first-frame` 保持 0.5m；
  - clip JSON 在 `rest` 时写出 `"hipsBase": "rest"`（`first-frame` 省略，保持旧契约）。
- `translationStats.hipsBase` 记录到 retarget 报告。

### 2.2 `scripts/vrm/motion/clips.hsr.json`
`breaked` / `hitL` / `stun` / `revive` 增加 `"hipsBase": "rest"`（含注释说明语义）。

### 2.3 QA
- `scripts/vrm/motion/lib/qa.mjs`：`hipsBase:'rest'` 的 clip 不再要求「Hips.p 首帧归零」，
  改为「首帧绝对偏移 ≤ 1m」量级兜底（`CLIP_QA_LIMITS.hipsRestOffsetMax`）。
- `scripts/vrm/motion/validate-hsr-clips.mjs`：U-lane `validateClipData` 对 `rest` 基准放宽
  `hipsFirstFrameToleranceMeters` 到 1m（通用 validator 不改）。

### 2.4 运行时：空中不播地面受击/过场（本轮一并修）
数据修好后，另有一处时序问题会让「从高处扔下」仍显得怪：`thrown` 在腾空瞬间就播 `hsr-stun`
（地面受击语义），角色会在半空做受击/蜷缩动作。本轮加了两处最小延迟：
- `src/renderer/src/vrm/clip-player.ts`：`thrown` 且 `motion.airborne === true` 时不立刻播，
  记录 `pendingThrownLanding`，落地 `landed` 时改播 `hsr-stun`（替代默认 landed 的起身 clip）；
  重新拖拽会清掉记录（防过期补播）。
- `src/renderer/src/vrm/animator.ts`：mood 过场 clip（dshError 进入 `hsr-breaked` / 离开
  `hsr-revive`）若在腾空时触发，推迟到落地补播一次；期间换 mood 会覆盖旧 pending。
单测：`tests/vrm-clip-player.test.ts`（+2 例）、`tests/vrm-animator.test.ts`（+1 例）。

### 2.5 重新生成数据（私有，gitignore）
```bash
node scripts/vrm/motion/retarget-hsr.mjs --out assets/motions/hsr --report-dir tests/tmp/hsr-motion
node scripts/vrm/motion/build-hsr-manifest.mjs
node scripts/vrm/motion/build-app-manifest.mjs
node scripts/vrm/motion/validate-hsr-clips.mjs --dir assets/motions/hsr
```
只有 4 个 clip 文件变化（`stun` 55→56 帧、`hitL` 48→49 帧，恢复被误裁的首帧；`breaked`/`revive`
仅 Hips.p 变化）；其余 10 条逐字节不变。

## 3. 验证

### 3.1 数据（修复后）
| clip | Hips.p Y（raw，播放 ×1.122） | 说明 |
|---|---|---|
| `stun` | -0.019 → **-0.195** → -0.047 | 站立起步 → 下蹲 19.5cm → 恢复（不再上升） |
| `hitL` | -0.019 → -0.088 → -0.010 | 受击下蹲 |
| `breaked` | 恒 **-0.495**（×1.122 = -0.556m） | 跪姿腰沉到 ≈0.51m |
| `revive` | **-0.549 → -0.019** | 从跪姿（hips 0.45m）起身到站立（1.045m） |

### 3.2 正解算（`simulateNormalizedHumanoid`，目标 T-pose VRM）
| clip | hips Y 首→末（m） | 最低骨 Y（m） | 落地面判断 |
|---|---|---|---|
| `idle`（对照） | 1.066 → 1.066 | 0.074（+feet grounding 后 ≈0.096） | 正常 |
| `stun` | 1.045 → 1.013（min 0.848） | 0.046 | 不再抬升 |
| `breaked` | **0.510** 恒定（min 0.507） | **0.005**（膝/手贴地） | ✅ 跪在地面上 |
| `revive` | **0.450 → 1.045** | -0.005 @ 首帧（≈5mm 软穿地） | ✅ 从地面起身 |

### 3.3 预览/验证
- `node scripts/vrm/motion/preview-hsr.mjs --clips stun,hitL,breaked,revive --out tests/tmp/hsr-fix-preview`
  接触表：`tests/tmp/hsr-fix-preview/*-sheet.jpg`（breaked 侧视已跪在地面高度；stun 首帧为站立）。
- `validate-hsr-clips`：**PASS 9 / WARN 5 / FAIL 0，U-lane 0 errors**。
  剩余 WARN：`stun/hitL` 首帧→次帧 105–109°（源自带的受击 snap，恢复首帧后如实保留；
  app 侧 0.15s crossfade 会吸收），其余为既有手指骨/技能帧跳变 WARN。
- 单测：`tests/vrm-motion-retarget.test.ts` 新增 5 例（rest 基准 / staging 阈值 / 参考帧判定 / 裁剪），
  `tests/vrm-motion-qa.test.ts` 既有 9 例；全套 `vitest run` 109 files / 1898 tests 全绿；`pnpm typecheck` 0。

### 3.4 实机（app 端）证据
`capture-app` 在 dev 环境需带 `--noSandbox`（否则 Chromium sandbox 初始化被拒）；本轮用等价的手工
`electron-vite dev --noSandbox` 跑 `PET_DEV_CAPTURE_MOOD_SEQUENCE=idle:600,dshError:900,dshError:1200`：
- `tests/tmp/stunfix-app/01-mood-idle.png`：站立（bbox 高 530px，脚在屏幕底边）；
- `tests/tmp/stunfix-app/02-mood-dshError.png`：`hsr-breaked`（bbox 高 299px，**身体压到屏幕底边/地面**，
  不再悬空在站立髋高）；debug 快照 `clipId=hsr-breaked`、`visualOffsetYPx=0`。
- 旧行为对照：breaked 悬空时脚/膝会离底边约 0.55m×(像素/米) ≈ 170px。

## 4. 已知限制 / 后续

- `stun`/`hitL` 恢复首帧后，首帧→次帧有 105–109° 的拇指 snap（源内容，WARN 保留）。
- `stun`/`hitL` 是 `grounding:'none'`，脚底与桌面有约 2–3cm 残差（原先被 +18cm 错误掩盖；如需更严可后续
  做逐帧 feet grounding）。
- 「被抛掷 → 空中 → 落地」的**姿态素材**仍是现有动作（用户要求没有把握不做新动作）；时序已修为
  「空中不播、落地补播眩晕」，观感方案对比与后续建议见 `docs/research/throw-fall-options.md`。
- 回滚：`git checkout -- scripts/vrm/motion/lib/retarget.mjs scripts/vrm/motion/lib/qa.mjs
  scripts/vrm/motion/validate-hsr-clips.mjs scripts/vrm/motion/clips.hsr.json`
  后重跑 §2.4 的 retarget/build 命令即可恢复旧数据。
