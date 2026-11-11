# 四条动作管线：把 FBX / .anim / .max / VMD 变成 app 能播的 clip

**中文** · [English](guide-motion-conversion.en.md)

> 属于 [README](../README.md) 的「不会建模怎么用」系列。
> 上游：[模型转 VRM](guide-model-conversion.md) · 素材来源：[去哪找](guide-asset-sourcing.md) ·
> 排错：[高频坑](guide-asset-pitfalls.md)

## 目标格式长什么样

app 只读一种动作数据：`assets/motions/<set>/<clip>.json`。以 `mate-idle` 为例：

```jsonc
{
  "version": 1, "clip": "idle", "mood": "idle", "loop": true,
  "fps": 30, "frames": 74, "duration": 2.433,
  "space": "gltf-rh",                       // 坐标系：右手系、Y 向上
  "sourceHeight": 1.66, "sourceHipsHeight": 0.95,   // 用于按目标身高换算 Hips 位移
  "bones": {
    "Hips":        { "r": [ [x,y,z,w], ... ], "p": [ [x,y,z], ... ] },
    "LeftUpperArm":{ "r": [ ... ], "p": [ [0,0,0], ... ] }
  }
}
```

- **`r`**：每帧一根 humanoid 骨的四元数（相对 T-pose rest 的 normalized 旋转）；
- **`p`**：每帧位移，**只有 Hips 有非零值**（水平必须 in-place，竖直由播放器贴地补偿）；
- 当前集每 clip **52 骨**（含 30 手指），字段契约在
  [`../src/shared/animation-contract.ts`](../src/shared/animation-contract.ts)。

## 四条管线（仓库里都跑通过）

| 源 | 管线 | 入口脚本 | 完整文档 |
|---|---|---|---|
| Unity `.anim`（Humanoid muscle，如 Mate-Engine） | Unity 逐帧采样 → normalized JSON | `scripts/unity-bake/convert-clips.mjs`（默认 `--axis x`；旧 VRM0 资产用 `--axis z`） | [`unity-bake-report.md`](unity-bake-report.md)、[`wave15-report.md`](wave15-report.md) |
| 游戏官方 **FBX**（全骨，如 HSR 135 个 take） | Blender 采世界四元数 → 按目标 rest 做 delta 重定向 → grounding | `extract-hsr-anims.py` → `retarget-hsr.mjs` → `validate-hsr-clips.mjs` | [`vrm-motion-hsr.md`](vrm-motion-hsr.md)、[`../scripts/vrm/motion/README.md`](../scripts/vrm/motion/README.md) |
| **3ds Max Biped** `.max` | MaxScript 批量导出 FBX → Biped 采样 → Biped→VRM 映射 → 重定向 | `scripts/max-export/export_fbx.ms`（Windows）→ `run-adv-pipeline.sh` → `retarget-adv.mjs` | [`max-anim-conversion-plan.md`](max-anim-conversion-plan.md)、[`research/max-windows-routes.md`](research/max-windows-routes.md)、[`user-3dsmax-export-guide.md`](user-3dsmax-export-guide.md) |
| 任意 humanoid **FBX → VMD**（Mixamo / Rokoko / Plask） | reze-rig 浏览器/CLI 重定向成 VMD | `scripts/anim-pipeline/reze/` | [`research/motion-free-pipeline.md`](research/motion-free-pipeline.md)、[`research/mocap-options.md`](research/mocap-options.md) |
| 视频 / 摄像头 | MiPo / Plask 等三条管线直接出动作 | 见文档 | [`research/mocap-options.md`](research/mocap-options.md) §4 |

> **VMD 只能给 `legacy-pmx` 后端用。** VRM 后端不加载 VMD（`MMDLoader` 只在
> `src/renderer/src/scene/pet-scene.ts` 里）。要把 VMD 用到 VRM 角色上，得先转成 FBX/humanoid
> 再走上面的重定向管线。

## 清单：最小接入 vs 完整管线

**最小接入（只有几条动作）**——直接手写 `assets/motions/app-manifest.json`（该文件是私有生成物，gitignore）：

```json
{ "schemaVersion": 1, "clips": [
  { "id": "my-idle", "mood": "idle", "file": "my/idle.json",
    "loop": true, "timeScale": 1, "fadeInSec": 0.15, "fadeOutSec": 0.2,
    "rootMotion": "inPlace", "priority": -10 }
]}
```

**完整管线**——`build-app-manifest.mjs` 是「汇总器」，它要求 `assets/motions/mate/manifest.json`
与 `hsr/manifest.json` 存在（adv 可选）。也就是说，它是给本项目的多来源动作集用的，
不是给「只有三条自备动作」的人用的。

```bash
node scripts/vrm/motion/build-app-manifest.mjs           # 生成 app-manifest + app-catalog
node scripts/vrm/motion/build-app-manifest.mjs --check   # 只校验磁盘与现状一致（幂等）
```

两条清单的分工：`app-manifest.json` 只放 mood/salute 槽位（决定「平时播什么」），
`app-catalog.json` 列全部 clip（含 hide/intro/pose/skill 等一次性片段，供事件/调试按 id 播放）。

## 校验工具

| 工具 | 用途 |
|---|---|
| `scripts/unity-bake/lib/validate-clips.mjs`、`scripts/vrm/motion/validate-hsr-clips.mjs`、`validate-adv-clips.mjs` | 数据侧 PASS/WARN/FAIL：骨集合、四元数单位化、loop 接缝、贴地残差 |
| `scripts/unity-bake/preview-clips.mjs`、`preview-hsr.mjs`、`preview-adv.mjs` | 三视图/手脚特写/接触表，肉眼验收 |
| `scripts/vrm/motion/viewer.html`、`scripts/unity-bake/clip-viewer.html` | 浏览器里逐帧看 clip |
| `pnpm smoke` | 真实窗口里加载全部资产，验证播放不崩 |

## 字段语义（改清单时最容易搞错）

- `mood`：槽位名，必须在 `PET_MOODS` + `salute` 里；写错 = 该动作永远不被选中。
- `priority`：同槽位多 clip 的排序，**负数越小越靠前**；调低会让它优先播放。
- `timeScale`：播放速度倍率（女体 idle 偏快时用 0.4–0.6 压慢）。
- `rootMotion: "inPlace"`：水平位移被抹掉，只保留原地动作；有位移需求的片段不要设。
- `loop`：与 `fadeInSec/fadeOutSec` 配合决定切换是否生硬。

## 授权

动作和模型一样是私有资产：只本地个人自用，**不得再分发，也不得随 `.app` 分发**。
`assets/motions/**` 与 `dist/` 里的产物都在 `.gitignore` 或「禁止分发」范围内。
