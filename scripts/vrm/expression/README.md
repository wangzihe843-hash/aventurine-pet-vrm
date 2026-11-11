# `scripts/vrm/expression/` — V6 表情层数据管线（dev-only）

把两个动作/表情来源的**表情动画**转换成项目统一的 VRM 1.0 expression 权重 clip
（`src/shared/expression-contract.ts`），供 V6 表情层运行时消费：

| 来源 | 原始数据 | 管线 | 产物（私有，gitignore） |
|---|---|---|---|
| Mate-Engine（Wave 1.5 动作包） | Unity `.anim` 的 face blendshape 曲线（VRM 0.x 表达名） | `extract-mate-face.mjs`（YAML 解析 + Unity Hermite 重采样） | `assets/expressions/mate/*.json`（7 clip） |
| HSR 官方 FBX（Wave 1.0 动作包） | `Emo_*` take 的 73 根脸骨动画（60fps） | `sample-hsr-emo.py`（Blender）→ `decode-hsr-emo.mjs`（OMP+NNLS → preset 权重） | `assets/expressions/hsr/*.json`（10 clip） |

统一 manifest：`assets/expressions/manifest.json`（由 `build-expression-manifest.mjs` 生成）。
设计/映射/限制/验收详见 **`docs/expression-mapping.md`**；运行时模块见
`src/renderer/src/vrm/expressions.ts`。

## 快速开始（本机私有资产就位时）

```bash
# 1) Mate-Engine（refs/Mate-Engine 本地克隆；输出 assets/expressions/mate）
node scripts/vrm/expression/extract-mate-face.mjs \
  --anim-dir "refs/Mate-Engine/Assets/MATE ENGINE - Animations" \
  --config scripts/vrm/expression/config/mate-face.json \
  --out assets/expressions/mate

# 2) HSR Emo_（需要 HSR 官方 FBX，本地私有；Blender 4.2 + in-between patch 已内置）
BLENDER=/Volumes/4TB外置盘/deepseek-harness/tools/blender/Blender.app/Contents/MacOS/Blender
"$BLENDER" -b --factory-startup --python scripts/vrm/expression/sample-hsr-emo.py -- \
  --fbx "/path/to/Avatar_Aventurine_00.fbx" \
  --config scripts/vrm/expression/config/hsr-emo.json \
  --out assets/expressions/_samples
node scripts/vrm/expression/decode-hsr-emo.mjs \
  --samples assets/expressions/_samples/emo-face-samples.json \
  --config scripts/vrm/expression/config/hsr-emo.json \
  --out assets/expressions/hsr

# 3) 生成 manifest（两个来源一起）+ 校验 + 预览
node scripts/vrm/expression/build-expression-manifest.mjs \
  --configs scripts/vrm/expression/config/mate-face.json,scripts/vrm/expression/config/hsr-emo.json
node scripts/vrm/expression/validate-expression-clips.mjs --vrm assets/vrm/aventurine-tpose.vrm
node scripts/vrm/expression/preview-expressions.mjs --mode all --out tests/tmp/expression/preview
```

所有 CLI 都支持 `--help`（exit 0）、未知参数（exit 2）、失败（exit 1）；
`extract-mate-face` / `decode-hsr-emo` / `build-expression-manifest` 支持 `--check`（幂等对比，CI/回归用）。
预览产物（PNG + 接触表 + summary）写在 `tests/tmp/**`（gitignore）。

## 数据形状（`ExpressionClip`）

```json
{
  "schemaVersion": 1,
  "id": "faceIdle",
  "source": "mate",
  "sourceFile": "FACE_LAYER/FACE_IDLE_1.anim",
  "fps": 30,
  "frames": 301,
  "duration": 10.033334,
  "loop": true,
  "tracks": { "blink": [0, 0, ...], "ee": [0, ...] },
  "fadeInSec": 0.5,
  "fadeOutSec": 0.5
}
```

- 轨道键 = VRM expression 名（本管线只输出 VRM 1.0 preset：`happy/angry/sad/relaxed/surprised/
  aa/ih/ou/ee/oh/blink/blinkLeft/blinkRight`；自定义 expression 也允许，校验器给 warning）；
- 帧数约定：loop = `round(duration*fps)`（不复制末帧）；non-loop = `round(duration*fps)+1`；
- 值域 0..1，权重越界在清洗时钳制；`fadeInSec/fadeOutSec` 来自源状态机过渡（Mate）或按用途设定（HSR）。

## 映射配置（可审阅、可单测）

| 文件 | 内容 |
|---|---|
| `config/mate-face.json` | 源 → clip 清单（文件/loop/fps/triggers/tags/priority/fade/scale）、VRM0→VRM1 别名、控制器事实（层/优先级/过渡时长） |
| `config/hsr-emo.json` | 采样 take 清单（17 条）、脸部三层骨表、校准基（20 个通道）、preset 规则/门控、导出 clip 清单（10 条） |

## HSR 解码器（`lib/hsr-face.mjs`）

1. 中性 = `emo_default` 首帧；每骨取 local 四元数增量，乘 rest 朝向 → armature 空间旋转向量，按层拼特征；
2. 每层用校准姿态作基，OMP 选 ≤3 个基 + 非负最小二乘（权重上限 1.5）→ 层强度 0..1+；
3. 层强度按 preset 规则加权（目标模型 preset 本身就是眉/眼/嘴 morph 组合），带互斥门控与 blink 特殊处理；
4. `bash decode-hsr-emo.mjs` 输出 `ExpressionClip`（loop clip 的 duration 归一到 frames/fps）。

`tests/expression-hsr-decode.test.ts` 用合成采样覆盖四元数/分解/preset 规则/整条解码；真实数据对拍见
`docs/expression-mapping.md` §6（与独立 Python 解码实现逐 clip preset 均值一致）。

## 校验 / 预览

```bash
# 数据校验（schema/帧数/轨道长度/权重/loop 接缝/目标模型 expression 名存在性/manifest 一致性）
node scripts/vrm/expression/validate-expression-clips.mjs --vrm assets/vrm/aventurine-tpose.vrm \
  --json tests/tmp/expression/validation-report.json

# 预览：presets（模型 13 preset + neutral 基线）/ clips（每条 clip 采样 4 帧脸特写）/ combo（运行时组合）
node scripts/vrm/expression/preview-expressions.mjs --mode all --dir assets/expressions \
  --out tests/tmp/expression/preview
```

预览依赖本机 Electron（`node_modules/.bin/electron`）+ 目标 VRM；输出
`presets-face.jpg` / `presets-full.jpg` / `clip-<set>-<id>-sheet.jpg` / `combos.jpg` / `summary.json`。

## 已知限制

- **不搬源面部 rig**：HSR 73 根脸骨 / Mate-Engine VRM0 blendshape 都只映射到目标模型 **已有**的
  VRM1 preset 组合；目标模型没有 jaw 骨/舌头 morph，HSR 的舌头/牙齿细节丢弃。
- **HSR Emo_ 没有嘴角上扬通道**：`happy` 只能取「笑眼（Close02/03）」近似；`shy`（笑眼+嘴角下压）
  与 `trouble`（困扰）用 preset 只能低置信近似（sad/angry 低权重），高保真需目标模型 custom
  expression（`笑い`/`困る`/`やっかい` 等已存在，列为后续可选项）。
- **目标模型无 neutral preset**：业务 neutral = expression 全清 0（不播放 clip）。
- 数据为**私有游戏/参考资产**，不进 git、不发布；本目录只提交脚本/配置/测试/文档。
