# 外部动作清单（motion-index）示例与再生成步骤

本目录只保存 **清单模板**（`motion-index.example.json`）与说明；**动作文件本身（.vmd）不随仓库分发**（版权/授权原因，见 `docs/research/motion-free-pipeline.md` §6）。

## 运行期位置

app 从 `<assets/model/optimized>/motion-index.json` 读取清单（`pet-asset://model/motion-index.json`），
同目录放 `motion-<id>.vmd`（**必须是单段文件名**，协议契约 M-2）。这两个路径都在 `.gitignore` 的
`assets/model/` 下，仅本机存在；干净 clone（无清单）时 app 自动回退 B3 程序化姿态，`pnpm smoke` 跳过相关断言。

## 再生成步骤（本机）

1. 用 `scripts/anim-pipeline/reze/convert.sh` 把 FBX 转成 VMD（以本模型为目标，例子见
   `docs/research/motion-free-pipeline.md`）：
   ```bash
   ./scripts/anim-pipeline/reze/convert.sh <source.fbx> \
     --bind-ref <同源或 Idle.fbx> \
     --target-pmx "assets/model/optimized/星穹铁道—砂金·戏浪.pmx" \
     --in-place --out tests/tmp/motions/free/out
   ```
2. 用预览器验证（骨骼命中/循环/脚底/观感）：
   ```bash
   ./scripts/anim-pipeline/preview/run.sh --motion tests/tmp/motions/free/out/<file>.vmd \
     --frames 0,10,20,30 --angles front,side,45
   ```
3. 把最终 VMD 复制成 `assets/model/optimized/motion-<id>.vmd`；
4. 复制本目录 `motion-index.example.json` 为 `assets/model/optimized/motion-index.json`，
   按实际 clip 增删（字段含义见 `src/renderer/src/animation/external/manifest.ts` 顶部注释；
   `grounding` 可选 `feet`/`none`：坐姿/悬垂腿用 `none` 跳过脚底补偿）。

## 当前示例清单（7 clips）

| id | file | moods | 说明 |
|---|---|---|---|
| idle | motion-idle.vmd | idle | 站立待机 3.00s 循环（reze 样例 Idle.fbx） |
| walk | motion-walk.vmd | walk | 走路 0.97s 原地循环（Mixamo 标准 Walk，自然步速≈490px/s@540px；旧 Soldier 版留档 motion-walk-soldier.vmd） |
| taunt | motion-taunt.vmd | pat | 摸头反应 2.83s（reze 样例 Taunt.fbx / Mixamo） |
| sit | motion-sit.vmd | sit | 坐姿 5.67s 循环（Mixamo Sitting Clap） |
| salute | motion-salute.vmd | dshDone | 任务完成敬礼 2.83s（Mixamo Salute） |
| reaction | motion-reaction.vmd | dshError | 出错惊讶 1.83s（Mixamo Surprised） |
| drag | motion-drag.vmd | drag | 被抓住/被甩反应 4.53s 一次性（Mixamo Shoved Reaction With Spin） |

> 所有来源均只作**本地个人自用、不再分发**；授权记录见 `docs/research/motion-free-pipeline.md`。
