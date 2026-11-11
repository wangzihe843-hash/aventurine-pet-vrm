# reze-rig 固化：humanoid FBX → MMD VMD（自用转换管线）

本目录把 [reze-rig](https://github.com/AmyangXYZ/reze-rig)（MIT）的 **node 端批处理 CLI**
（`scripts/fbx2vmd.ts` + `lib/`）固化进本仓库，作为「任意 humanoid 动作（Mixamo / UE / Unity /
3ds Max Biped / Character Creator 命名）→ 以本项目 PMX 为 target 的 MMD VMD」的**唯一转换入口**。

> **用途边界**：只用于**本机开发/个人自用**。转换产物（`.vmd`）来自外部动作库（Mixamo / three.js
> 示例等）或其派生数据，**不随 app 分发、不进 git、不提交**；本目录也不含任何模型/动作二进制。
> 素材来源与许可逐条记录在 [`docs/research/motion-free-pipeline.md`](../../../docs/research/motion-free-pipeline.md)。

## 来源 / 许可

| 项 | 值 |
|---|---|
| 上游仓库 | https://github.com/AmyangXYZ/reze-rig |
| 上游 commit | `28a9a9e31e33efcd0f5061ab3ffdc20e93541eba`（2026-10-22，`git log -1`） |
| 上游版本 | `package.json` version `0.3.2` |
| 许可 | **MIT**（`LICENSE`，Copyright (c) 2026 Amyang）——允许复制、修改、再分发（保留版权声明） |
| 本目录内容 | `lib/*.ts`（fbx / retarget / retarget-core / fbx-morph / fbx-camera / engine-clip / utils / device / uploads）与 `scripts/fbx2vmd.ts`，**未改一行源码**；只补了最小 `package.json` / `build.sh` / `convert.sh` / `glb2fbx.py`（Blender glTF→FBX 桥） |
| 依赖 | `reze-engine@0.68.10`（MIT，PMX/VMD 解析与写出）、`pako@^3.0.3`（MIT，FBX 解压）、`esbuild@0.25.12`（MIT，devDep，打包 CLI） |

上游是 Next.js 网页工程（浏览器内上传 FBX → 选 PMX → 预览 → 导出 VMD）；本目录只取 **node CLI** 部分，
因此不需要 Next/React/浏览器/GPU/Blender。依赖装在本目录 `node_modules/`（gitignore），
**不要**在仓库根跑 `npm/pnpm install` 来装这些。

## 用法

```bash
# 1) 首次：安装依赖 + esbuild 打包成单文件 CLI（.dist/fbx2vmd.mjs，约 1.8MB）
./scripts/anim-pipeline/reze/build.sh

# 2) 转换（仓库根目录执行；参数与上游 CLI 完全一致）
./scripts/anim-pipeline/reze/convert.sh \
  "tests/tmp/motions/free/fbx/Walk.fbx" \
  --target-pmx "assets/model/optimized/星穹铁道—砂金·戏浪.pmx" \
  --in-place \
  --out "tests/tmp/motions/free/vmd"

# 多条一起转（目录会递归扫描 .fbx）：
./scripts/anim-pipeline/reze/convert.sh "tests/tmp/motions/free/fbx" \
  --target-pmx "assets/model/optimized/星穹铁道—砂金·戏浪.pmx" \
  --in-place --out "tests/tmp/motions/free/vmd"
```

常用参数：

| 参数 | 说明 |
|---|---|
| `--target-pmx <pmx>` | **必带**。CLI 会实际加载该 PMX、settle 一帧后读骨骼世界坐标（`measureTargetPositions`）与 morph 表，因此比例/单位/眼睑 morph 自动适配；目标模型用 `assets/model/optimized/星穹铁道—砂金·戏浪.pmx` |
| `--in-place` | 清掉 `センター` 水平位移、保留竖直（桌宠原地走，位移交给 app 物理层） |
| `--out <dir>` | 输出目录（每个 clip 一个 `<basename>.vmd`，文件名保留、平铺） |
| `--bind-ref <idle.fbx>` | 用一条 idle 作为 bind 参考（UE/Unity 逐姿态导出的 FBX 常把循环中段当 rest；Mixamo 形状的 clip 会忽略它） |
| `--no-foot-ik` | 不生成 `左足ＩＫ/右足ＩＫ` 位移轨道（纯 FK）。**默认开脚 IK**，走路/坐下必须保持默认 |

成功后日志形如：

```
target skeleton: measured from .../星穹铁道—砂金·戏浪.pmx
[retarget] "mixamo.com": Mixamo, scale=0.1278, 51 mapped (47 aligned)
Walk.vmd (XXX KB)
```

### glTF（.glb/.gltf）→ FBX 桥（`glb2fbx.py`）

上游只吃 FBX。three.js 官方示例模型（如 `examples/models/gltf/Soldier.glb`，Mixamo 骨架）
可用本目录的 Blender 无头脚本先转成「每个动画一个 FBX」，再走上面的 `convert.sh`：

```bash
BLENDER='/Volumes/4TB外置盘/deepseek-harness/tools/blender/Blender.app/Contents/MacOS/Blender'
"$BLENDER" --background --python scripts/anim-pipeline/reze/glb2fbx.py -- \
  --glb tests/tmp/motions/free/glb/Soldier.glb \
  --out tests/tmp/motions/free/fbx \
  --actions Idle,Walk,Run
# → tests/tmp/motions/free/fbx/{Idle,Walk,Run}.fbx（输出名 = 动画名，Idle.fbx 会被 CLI 自动当 bind reference）
```

脚本行为：空场景 + `fps=30`（在 import 前设置，避免 24fps 重采样）→ 导入 glTF → 每条 animation
取 fcurve 最多的那条 action（glTF importer 会拆出 `Walk_Character` + 若干末端 EMPTY 的 action）→
**选中骨架 + 全部蒙皮网格**导出独立 FBX。

> ⚠️ **必须带蒙皮网格一起导出**：只选 armature 时 Blender 写出的 FBX 会丢 skin bind/Deformer，
> reze 读到的 rest pose 会错（实测 `WORLD FRAME OFF BY 136°`、产物腿常开/手臂外张/idle 也在踏步）。
> 带 mesh 后恢复一致（实测 `world frame corrected 180°, 44 aligned`）。

## 产物验收

改完/转完**先过预览器**再谈接入 app（默认隐藏窗口，勿加 `--show`）：

```bash
./scripts/anim-pipeline/preview/run.sh \
  --motion "tests/tmp/motions/free/vmd/Walk.vmd" \
  --frames 0,5,10,15,20,25,30 --angles front,side,45
```

看 `tests/tmp/preview/<case>/compatibility.md` 的：骨骼命中（必需 17 根人形骨）、
`左足ＩＫ/右足ＩＫ` 轨道、`センター` 位移（`--in-place` 后应 ±1 内）、脚底漂移；
再看 `contact-sheet.png` 的观感（是否原地、是否滑步/穿地/膝反关节）。

## 已知限制（上游行为，非本目录引入）

- 输入**只吃 FBX**（不吃 BVH / SMPL / GLB）。glTF（如 three.js 示例 `Soldier.glb`）需先用 Blender
  导入 → 导出 FBX（用本目录的 `glb2fbx.py`，见上）。
- 只认 humanoid 命名表（Mixamo / UE-Mannequin / Unity Humanoid / 3ds Max Biped / Character Creator）。
- 固定 **30fps**；手臂不做 IK。
- morph 只在源 FBX 带 blendshape 时转出（眨眼/EB_* 面部通道）；本项目模型的表情仍由 app 表情调度器负责。
- 上游 r171 页面用 `public/mmd-skeleton.json`；CLI 用 `--target-pmx`，两种路径等价。

## 复验记录（本机 macOS arm64，2026-11-08）

- `build.sh`：`reze-engine@0.68.10 + pako@3.0.3 + esbuild@0.25.12` 安装成功，bundle 1.8MB，exit 0。
- `convert.sh` 用上游样例 `public/fbx/{Idle,Taunt,Run_Lfoot,Arms Down}.fbx`（已复制到本机
  `tests/tmp/motions/free/fbx-samples/`，未入库）重新转换 → 产物与已有
  `tests/tmp/motions/converted/` **逐字节一致（sha256 相同）**：54 骨轨道、54/54 命中本模型、
  含 `左足ＩＫ/右足ＩＫ`、`--in-place` 后センター 首尾差 0。逐文件结果见
  `docs/research/motion-free-pipeline.md` §1.4。
- three.js r171 `Soldier.glb`（Mixamo）→ `glb2fbx.py` → `convert.sh`：`Walk` 成 51 轨 51/51 命中、
  1.03s 完美原地循环，最终作为 `motion-walk.vmd`；`Idle`/`Run` 也转出（51/51）作测试素材。

## VPD → VMD：`vpd2vmd.mjs`（Wave 2.5 / D4c）

Blender + MMD Tools 摆好姿势导出的 `.vpd`（静态姿势）可以转成 app 外部动作层能直接加载的
**单帧 VMD**，用于一次性静态姿势/过渡帧（VPD 本身 three r171 也能 `loadVPD`，但 app 目前只走
VMD 通道；转成 VMD 后与其它 clip 走同一条 manifest/播放路径，零额外运行期代码）。

- **零依赖**：`node scripts/anim-pipeline/reze/vpd2vmd.mjs <in.vpd> [--out <out.vmd>] [--frame N]`
  不需要 `npm install`（VMD 写盘/Shift-JIS 编码表自带；思路与 reze-engine MIT 实现一致）。
- **兼容两种 VPD 格式**：MMD/PMXEditor 单行 CSV，以及 **Blender MMD Tools 的多行变体**
  （`Bone0{名称` 换行 pos 行 `;`+`// 注释` 换行 quat 行）。
- **编码自动检测**：先 UTF-8 strict，失败再 Shift-JIS（cp932）；数字支持科学计数法
  （three r171 `parseVpd` 不支持，会抛 "the file seems not vpd file."）。
- **只转骨骼块**：`Morph{}` 块忽略（表情由 app 的 B3 表情系统驱动，外部 morph 名/索引不保证匹配）。
- 已验证：本机 Blender 导出的 `pose-test-boneonly.vpd` → VMD → 预览器 5/5 骨命中、PREVIEW_OK；
  回归测试 `tests/vpd2vmd.test.ts`（cp932/UTF-8/Blender 多行/科学计数法/零四元数/CLI 边界）。

```bash
node scripts/anim-pipeline/reze/vpd2vmd.mjs tests/tmp/blender-probe/pose-test-boneonly.vpd \
  --out tests/tmp/motions/converted/pose-blender.vmd
./scripts/anim-pipeline/preview/run.sh --motion tests/tmp/motions/converted/pose-blender.vmd \
  --frames 0 --angles front,side,45
```


## 附：剥离 VMD morph 轨道（原生 MMD 动作接入前必做）

```bash
python3 scripts/anim-pipeline/reze/strip-vmd-morphs.py <src.vmd> <dst.vmd>
```

原因：three r171 `MMDLoader.animationBuilder.build` 在本模型上处理某些原生 MMD 动作的 morph 轨道会抛错
（`Cannot read properties of undefined (reading '真面目')`）；本 app 的表情统一由 B3 驱动，接入前剥掉 morph
更稳（`vmd-clip` 也会二次剥）。骨骼 / 相机 / 灯光 / 阴影 / IK 段原样保留。


## 附：裁剪 VMD 帧区间

```bash
python3 scripts/anim-pipeline/reze/trim-vmd.py <src.vmd> <dst.vmd> --start 0 --end 30
```

用于从长动作切出「落地」等片段（`变久` 的 Mixamo fall-to-landing 取前 1s 作为 `landed` 一次性动作候选）。
