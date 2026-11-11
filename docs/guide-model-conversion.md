# 三种模型转 VRM：从 PMX / FBX / VRM0 到能渲染的资产

**中文** · [English](guide-model-conversion.en.md)

> 属于 [README](../README.md) 的「不会建模怎么用」系列。
> 上游：[素材去哪找](guide-asset-sourcing.md) · 下游：[动作管线](guide-motion-conversion.md) ·
> 排错：[高频坑](guide-asset-pitfalls.md)

项目只认一种模型：**VRM 1.0 + 规范 T-pose + 面向 +Z / 左手 +X**。你手上可能是三种东西，
对应三条路线；选错路线会在后面所有动作上叠一层常量错误。

## 路线对照

| 源格式 | 推荐路线 | 为什么 | 完整步骤 |
|---|---|---|---|
| **PMX（MMD 模型）** | **VRMify**（纯 Python，一条命令） | 自动把 A-pose 抬成规范 T-pose、把付与骨（足D 等）合并进所跟随骨+权重、MMD 物理转 SpringBone、清理控制骨 | [`vrm-tpose-repair.md`](vrm-tpose-repair.md) §2.1 |
| **PMX / FBX / GLB（任意 DCC）** | **Blender 4.2 LTS + MMD Tools + VRM Add-on 4.10.4** | 可控、可无头批处理；能手工绑 humanoid、加 spring、处理材质 | [`vrm-toolchain.md`](vrm-toolchain.md) §6（脚本骨架）；道具烘焙示例 [`research/watergun-bake-vrm.md`](research/watergun-bake-vrm.md) |
| **VRM 0.x / 已转好的 VRM** | **Blender VRM Add-on 重导出** + 运行时 `rotateVRM0` 兜底 | VRM 0/1 由 armature 的 `spec_version` 决定，不是导出参数 | [`vrm-toolchain.md`](vrm-toolchain.md) §4.7；清单示例 [`../src/shared/vrm-manifest.json`](../src/shared/vrm-manifest.json) |

### 路线 1：PMX → VRM（VRMify）

```bash
git clone --depth 1 --filter=blob:none --sparse https://github.com/JiGuang283/VRMify.git /tmp/vrmify
python3 /tmp/vrmify/convert/pmx2vrm.py "assets/model/你的模型.pmx" \
  -o "assets/vrm/你的模型.vrm" --spec 1.0 --scale <缩放> \
  --title "角色名" --author "原作者 / 本地转换"
```

`--scale` 把 PMX 单位换算成米（本模型用的是 `0.0799777`）；不确定就用 Blender 量一下源模型身高，
再用 `目标身高 / 源单位身高` 换算。VRMify 默认会把 A-pose 手臂抬平，这正是我们要的。

### 路线 2：Blender 路线（可控，也能处理 FBX/GLB）

```bash
# 一次性：安装 VRM Add-on（幂等，pin 版本 + sha256）
scripts/vrm/install-vrm-addon.sh

# 无头导入 → 绑 humanoid / spring / 表情 → 导出（脚本骨架见 vrm-toolchain §6.2）
BL="/path/to/Blender.app/Contents/MacOS/Blender"
"$BL" --background --factory-startup --python scripts/vrm/export-dummy-vrm.py   # 验证环境
```

要点：PMX 要先装 **MMD Tools** 扩展才能导入；VRM 1.0 导出前必须满足 humanoid 必需骨、T-pose、
表情/材质基本要求（`vrm-toolchain.md` §4.8 逐条列了）。

### 路线 3：VRM 0.x → 规范 VRM 1.0

Blender 里把 armature 的 `spec_version` 改成 `1.0` 后重导出，并补齐 VRM 1.0 必填项。
运行时另有兜底：`avatar-loader.ts` 对 0.x 资产调 `VRMUtils.rotateVRM0`，表情走 three-vrm 的
v0compat 归一化（`joy→happy`、`blink_l→blinkLeft` 等）。canary 制服模型就是这条**运行时兜底**的现成样本。

## 转完必须过的两道闸

1. **T-pose 合规**：手臂沿 X 水平、掌心朝 -Y、四指伸直、拇指在 X 与 +Z 之间 45°。
   A-pose（手臂下斜）会让整条手臂在播放时带一个**常量偏转**（实测旧资产 39.6°），
   症状是「手一靠近身体就穿模，手伸出去的动作反而正常」。
2. **朝向 / 手性**：VRM 1.0 面向 +Z、左手 +X。这条同时决定动作数据用 `--axis x` 还是 `--axis z`，
   选错的表现是**左右镜像**（idle 会双手抬到头顶）。

自检办法（不用懂骨骼数学）：
- 播一遍 `idle`，手臂往躯干里插 → T-pose 没抬起来；
- 播放时角色背对镜头 → 朝向错，改模型或在清单里给 `yawOffsetDeg`；
- 动作左右反 → 手性错，回去查动作管线的 `--axis`。

> 目标模型**没有 `upperChest` 是常态**（VRMify 产物就是）。播放器会把 `UpperChest` 轨道折叠进
> `chest`，不需要你为了「骨全」去补一根。

## 接进 app（只改两处）

1. 把 `.vrm` 放进 `assets/vrm/`（可用子目录）。
2. 在 [`../src/shared/vrm-manifest.json`](../src/shared/vrm-manifest.json) 加一条，并把 `defaultAvatarId` 指过去：

| 字段 | 说明 |
|---|---|
| `id` | 内部标识，动作清单/调试都用它 |
| `file` | **相对 `assets/` 根**的路径，如 `vrm/你的模型.vrm`（走 `pet-asset://` 协议） |
| `specVersion` | `"1.0"` 或 `"0.x"` |
| `heightMeters` | 参与贴地/缩放，写错会悬空或陷地 |
| `expressions` | 业务名 → 模型自带 VRM expression 名；缺 preset 会回退 |
| `lookAt` | `mode`（`vrm`/`procedural`/`none`）+ 偏航/俯仰上限 |
| `yawOffsetDeg` | 朝向修正（180 就是转身） |
| `springChains` | 头发/衣摆链数，仅记录用 |

## 校验

```bash
# 出三视图 + 诊断（会启动 Electron 抓图，证据落 tests/tmp）
node scripts/vrm/capture-vrm.mjs --vrm assets/vrm/你的模型.vrm --tag mymodel \
  --views front,side,threeQuarter

# 只校验已有产物，不启动窗口（CI/复跑）
node scripts/vrm/capture-vrm.mjs --vrm assets/vrm/你的模型.vrm --tag mymodel --check

# 端到端：真实窗口 + 资产 + 桥
pnpm smoke
```

## 常见失败

| 症状 | 大概率原因 | 去哪看 |
|---|---|---|
| 模型全黑 / 材质发灰 | MToon 材质没转换、贴图 alphaMode 不对 | [`vrm-toolchain.md`](vrm-toolchain.md) §4.8；[`known-issues.md`](known-issues.md) |
| 贴图缺失 / 花屏 | 贴图路径大小写、未随包、`pet-asset://` 根目录限制 | [`pet-asset-protocol.md`](pet-asset-protocol.md) |
| 悬空 / 陷地 / 大小不对 | `heightMeters` 与实际不符、`--scale` 换算错 | [`vrm-tpose-repair.md`](vrm-tpose-repair.md) §2.1 |
| 背对镜头 | 源模型面向 -Z（旧 VRM0 风格） | 本页「两道闸」 |
| 手臂穿胸 | rest 不是 T-pose | 本页「两道闸」；[`guide-asset-pitfalls.md`](guide-asset-pitfalls.md) |
