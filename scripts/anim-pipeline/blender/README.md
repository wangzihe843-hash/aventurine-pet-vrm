# Blender 摆姿 → 渲染对照 → VPD 导出 → three.js 回灌

本目录是 Wave 2「程序化姿态观感失败」的可视化调参回路：用 **Blender 4.2 LTS + MMD Tools** 无头导入
`assets/model/optimized/星穹铁道—砂金·戏浪.pmx`，摆姿、出四视图/前后对比图、导出 VPD，并用
three.js **r171（node_modules 里实际安装的 0.171.0）** 的 `MMDParser`/`MMDAnimationHelper.pose` 语义
验证 VPD 是否可被 app 直接消费。

> 模型与生成的 `.vpd`/PNG 都是私有/派生产物：本目录**只放脚本与说明**，渲染证据统一写
> `tests/tmp/blender-probe/`（`.gitignore` 已忽略 `tests/tmp/`），不要提交进仓库。

## 1. 安装（一次性，无 sudo、无 Homebrew）

```bash
bash scripts/anim-pipeline/blender/install-blender.sh
```

默认安装到 `/Volumes/4TB外置盘/deepseek-harness/tools/blender/Blender.app`，MMD Tools 走
extensions 通道（Blender 官方 CLI）。实际验证的版本与命令、镜像/挂载坑见
[`docs/research/tooling-blender.md`](../../../docs/research/tooling-blender.md)。

安装后的可执行文件：

```bash
BL="/Volumes/4TB外置盘/deepseek-harness/tools/blender/Blender.app/Contents/MacOS/Blender"
"$BL" --version   # Blender 4.2.23 LTS
```

## 2. 四视图渲染（rest pose）

```bash
"$BL" -b --factory-startup --python scripts/anim-pipeline/blender/render_views.py -- \
  --pmx "$PWD/assets/model/optimized/星穹铁道—砂金·戏浪.pmx" \
  --out "$PWD/tests/tmp/blender-probe" \
  --views front,side,three-quarter,back
```

- 引擎默认 `workbench`（macOS `--background` 实测可出图，~0.2s/视图，贴图正常）。
- 需要光照时用 `--engine cycles --cycles-samples 32`（CPU；脚本会自动调用
  `mmd_tools.convert_materials_for_cycles`，否则 MMD 卡通材质在 Cycles 下偏黑）。
- 相机正交、按包围盒自动取景；`front` 看向 +Y（模型面朝 -Y），`side` 为角色左侧（+X）。

## 3. 摆姿 → 前后对比 → 导出 VPD

```bash
"$BL" -b --factory-startup --python scripts/anim-pipeline/blender/render_views.py -- \
  --pmx "$PWD/assets/model/optimized/星穹铁道—砂金·戏浪.pmx" \
  --out "$PWD/tests/tmp/blender-probe" \
  --views front,side,three-quarter,back \
  --pose scripts/anim-pipeline/blender/poses/example-pose.json \
  --pose-views front,three-quarter \
  --vpd-out "$PWD/tests/tmp/blender-probe/pose-test.vpd" \
  --vpd-strip-morphs \
  --dump "$PWD/tests/tmp/blender-probe/pose-dump.json" \
  --report "$PWD/tests/tmp/blender-probe/report.json"
```

产出：

| 文件 | 含义 |
|---|---|
| `front/side/three-quarter/back.png` | rest pose 四视图 |
| `posed-front.png`、`posed-three-quarter.png` | 同一相机下的摆姿后对比图 |
| `pose-test.vpd` | MMD Tools 原始导出（Shift-JIS/cp932；有表情权重时含 `Morph` 块） |
| `pose-test-boneonly.vpd` | `--vpd-strip-morphs` 生成的**只含骨骼块**版本 = three r171 `loadVPD` 的安全输入 |
| `pose-dump.json` | 摆姿后每根变化骨骼的 `matrix_basis`/`head_world`，供跨引擎校验 |
| `report.json` | 导入/渲染/VPD/roundtrip 的结构化结果 |

摆姿 JSON 格式（`poses/example-pose.json`）：

```json
{
  "bones": {
    "頭":   { "rot": [5, 12, 0] },
    "左腕": { "rot": [40, 0, 20] },
    "センター": { "loc": [0, -0.06, 0] }
  },
  "morphs": { "笑い": 0.45 }
}
```

- 骨名用 **PMX 原名（日文）**：脚本以 `rename_bones=False` 导入，保证 VPD 导出的
  `mmd_bone.name_j` 与 three/PMX 完全一致。
- `rot` 是度、XYZ 欧拉角，写在 Blender 骨骼局部空间（`pose_bone.rotation_euler`）；
  `loc` 是米、骨骼局部平移。
- 有表情权重时**必须加 `--vpd-strip-morphs`**：three r171 的 `parseVpd` 不认识
  MikuMikuMoving 的 `Morph` 块，直接抛 `the file seems not vpd file.`（实测，见 docs）。

## 4. 校验 VPD 能否被 three r171 消费

```bash
node scripts/anim-pipeline/blender/verify_vpd.mjs \
  --pmx "$PWD/assets/model/optimized/星穹铁道—砂金·戏浪.pmx" \
  --vpd "$PWD/tests/tmp/blender-probe/pose-test.vpd" \
  --vpd-boneonly "$PWD/tests/tmp/blender-probe/pose-test-boneonly.vpd" \
  --dump "$PWD/tests/tmp/blender-probe/pose-dump.json" \
  --out "$PWD/tests/tmp/blender-probe/vpd-compat-check.json"
```

用仓库里**真实的** `three@0.171.0`（`node_modules/three`）做三件事：

1. 按 `MMDLoader.loadVPD` 的方式解码（Shift-JIS）并调用 `MMDParser.parseVpd(text, true)`；
2. 把 VPD 骨名逐一对到 PMX 骨表（`helper.pose` 对未命中骨名是**静默跳过**的）；
3. 复刻 `MMDLoader` 的 PMX 骨架构建 + `MMDAnimationHelper.pose()` 的数学
   （`position.add` / `quaternion.multiply`），与 Blender 导出的世界空间骨头位置对比。
   实测最大误差 ~1e-7 m（相对 1.7m 的模型 = 浮点级一致）。

输出 `pass: true` 才认为 VPD 回灌链路成立。

## 5. 接触表（验收用）

```bash
python3 scripts/anim-pipeline/blender/make_contact_sheet.py \
  --dir tests/tmp/blender-probe --out tests/tmp/blender-probe/contact-sheet.png
```

把四视图与摆姿前后 6 张拼成一张带标签的图（`read_image` 一次看完）。这就是
「参考图三视图对照 + 接触表」验收流程里的 contact sheet；与角色设定三视图并排比较，
逐轮看轮廓/比例/穿模，再决定改 pose JSON 还是 app 侧数字。

## 6. 证据位置

`tests/tmp/blender-probe/`：

- `env.txt` 版本/路径/镜像/命令/扩展状态快照
- `report.json`（含 `vpd.roundtrip` 数值）、`pose-dump.json`
- `vpd-compat-check.json`（three r171 兼容性结论，含 Morph 块/科学计数法陷阱的实测结果）
- 四视图 PNG、`posed-*.png`、`contact-sheet.png`、`cycles-test/front.png`

## 7. 已知坑速查

| 坑 | 结论 |
|---|---|
| `download.blender.org` 直连 403 | Cloudflare 拦截 curl；用 dotsrc/nluug 官方镜像 |
| `hdiutil attach -mountpoint <外置盘路径>` 权限被拒 | 自动挂载到 `/Volumes/Blender` 再 `ditto` 拷贝 |
| Workbench 背景是黑的 | 同时设置 `scene.world.color`（脚本已处理） |
| Cycles 里 MMD 材质发黑 | 调 `mmd_tools.convert_materials_for_cycles`（脚本已处理）；面部 overlay（目影/颜赤）仍与视口不同 |
| three 解析 VPD 报 `the file seems not vpd file.` | 1) 文件含 `Morph` 块 → 用 `-boneonly.vpd`；2) 数值出现科学计数法（如 `8.7e-05`）→ 该行会被正则拒绝 |
| `loadVPD(url, false)` 还是 `true` | MMD Tools 写 cp932（Shift-JIS 超集）→ `isUnicode=false` |
| 摆了 `_dummy_*` / `_shadow_*` 骨（MMD Tools 附加的 D 链/捩骨/影子辅助骨） | VPD 里这些名字不在 PMX 中，three 静默跳过；只摆 PMX 原名骨 |
| PMX 内重名骨（本例 `后碎髮9` 有两根） | VPD 按骨名匹配，three 取最后一个；避免直接摆这两根 |
| `helper.pose` 默认 `ik/grant:true` | 会再跑 CCD IK 与 grant 解算；要 1:1 复刻 Blender 姿态用 `helper.pose(mesh, vpd, { ik: false, grant: false })` |
