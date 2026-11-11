# 外部 MMD 动作预览器（PMX × VMD/VPD）

独立 Electron 预览器：把**外部 MMD 动作包（VMD 动作 / VPD 静态姿势）直接套到本项目的私有
PMX「星穹铁道—砂金·戏浪」**上，渲染并截图（PNG + 多帧接触表），同时输出**动作兼容性元数据**
（骨骼名交集/缺失、帧率/时长、IK 轨道与 IK on/off 段、センター 位移范围、脚底漂移……）。

> 用途：验证「外部 MMD 动作包能不能直接给这只桌宠用、观感如何」。它**不修改** app 的
> `src/**`、`package.json`、`PLAN.md`，也不依赖 `pet-asset://` 协议：直接以 `file://`
> 读 `assets/model/optimized/`。模型/动作二进制只会写进 `tests/tmp/`（gitignore）。

## 目录

```
scripts/anim-pipeline/preview/
├── run.sh              启动入口（会 unset ELECTRON_RUN_AS_NODE 后用真正的 electron 启动）
├── main.cjs            Electron 主进程：参数解析 / 静态解析 VMD·VPD / 驱动渲染 / capturePage / 接触表 / 元数据落盘
├── renderer.js         浏览器端：MMDLoader 加载 PMX、MMDAnimationHelper 播放 VMD、helper.pose 应用 VPD、相机/光照/截图辅助
├── index.html          importmap（three → node_modules/three r171）+ 透明页面
├── lib/
│   ├── motion-meta.cjs PMX/VMD/VPD 解析与兼容性检查器（main 侧，mmd-parser 同源）
│   └── synthetic-motion.cjs 内置自造最小 VMD（真实二进制格式）与 UTF-8 VPD（用于管线自检/回归）
└── gen-evidence.sh     批量证据生成（对 tests/tmp/motions/ 下已知动作逐个出接触表）
```

## 快速开始

在**仓库根目录**：

```bash
# 1) 无参数：自动扫描 tests/tmp/motions/**（含 converted/）找 VMD/VPD；找不到就用内置自造 VMD
./scripts/anim-pipeline/preview/run.sh

# 2) 指定动作 + 采样帧 + 相机角度（帧号 = VMD 30fps 帧号）
./scripts/anim-pipeline/preview/run.sh \
  --motion "tests/tmp/motions/converted/Idle.vmd" \
  --frames 0,10,20,30,40,50,60,70,80,90 \
  --angles front,side,45,back

# 3) VPD 静态姿势
./scripts/anim-pipeline/preview/run.sh --vpd "tests/tmp/motions/threejs_r171/vpds/01.vpd" \
  --angles front,side,45

# 4) 对比 CCDIK 开/关（判断「模型自带 4 根足ＩＫ 是否覆盖了 VMD 的 FK 腿」）
./scripts/anim-pipeline/preview/run.sh --motion tests/tmp/motions/bear_walk.vmd \
  --frames 0,8,16,24,32 --angles side --ik off --out tests/tmp/preview/bear_walk-ik-off

# 5) 批量生成全部证据（motion-hunt / Lead 准备好的动作）
./scripts/anim-pipeline/preview/gen-evidence.sh
```

输出示例（`--out` 缺省为 `tests/tmp/preview/<动作文件名>/`）：

```
tests/tmp/preview/Idle/
├── frames/f0000-front.png … f0090-45.png   逐帧逐角度 PNG（透明背景，capturePage）
├── contact-sheet.png                        接触表（行=帧，列=角度；透明处画棋盘格）
├── metadata.json                            全部元数据（模型/动作/兼容性/采样/断言/结论）
├── compatibility.md                         兼容性检查清单（人/agent 读）
├── index.md                                 截图索引
└── run.log                                  运行日志
```

## 命令行参数

| 参数 | 环境变量 | 说明 |
|---|---|---|
| `--pmx <path>` | `PREVIEW_PMX` | PMX 路径；默认在 `assets/model/optimized/` 自动发现 |
| `--motion <path>` | `PREVIEW_MOTION` | VMD 动作 |
| `--vpd <path>` | `PREVIEW_VPD` | VPD 静态姿势（与 `--motion` 二选一） |
| `--frames <list>` | `PREVIEW_FRAMES` | VMD 采样帧号（30fps），逗号分隔；默认按动作时长均匀取 4 帧 |
| `--angles <list>` | `PREVIEW_ANGLES` | `front`/`side`/`45`/`back` 或任意度数；默认 `front,side,45,back` |
| `--out <dir>` | `PREVIEW_OUT` | 输出目录 |
| `--size <w>x<h>` | `PREVIEW_SIZE` | 窗口/截图 CSS 尺寸，默认 `480x720`（Retina 上 PNG 为 2x 像素） |
| `--sheet-cell <w>x<h>` | — | 接触表单格像素，默认 `300x450` |
| `--no-sheet` | `PREVIEW_SHEET=0` | 不生成接触表 |
| `--ik <on\|off>` | `PREVIEW_IK` | 是否让 MMDAnimationHelper 跑 CCDIK，默认 `on` |
| `--synthetic` | — | 强制用内置自造 VMD（验证管线/回归，不依赖外部下载） |
| `--synthetic-vpd` | — | 强制用内置自造 VPD（真实骨名 + UTF-8，验证 VPD 管线） |
| `--debug-info` | — | 打印 mixer/骨骼调试信息（排查「动作没生效」） |
| `--show` | `PREVIEW_SHOW=1` | **显示**预览窗口（默认不可见，见下节） |
| `--json` | — | 额外把断言/结论 JSON 打到 stdout |
| `--no-verify` | — | 跳过骨骼移动量/贴地等自动断言 |
| `--timeout <s>` | `PREVIEW_TIMEOUT` | 总超时，默认 180s |
| `-h, --help` | — | 帮助 |

退出码：`0` 成功 / `1` 运行失败 / `2` 参数或环境错误 / `3` 看门狗超时。
成功时 stdout 打印 `PREVIEW_OK` 与 `PREVIEW_FAIL` 二选一，最后一行便于脚本断言。

## 窗口可见性（重要）

- **默认不显示给用户**：窗口仍 `show: true`（macOS 合成器保持渲染，`capturePage` 才稳定），
  但 `opacity: 0` + `focusable: false` + `setIgnoreMouseEvents(true)` + `app.dock.hide()`，
  所以用户屏幕上**看不到**任何预览窗口/模型。
- 只有显式 `--show`（或 `PREVIEW_SHOW=1`）才会把窗口显示出来（不建议：会在屏幕上闪/切机位）。
  这是早期版本的问题——默认 `show: true` 时窗口会在桌面上可见，循环切 front/side/45 时
  看起来像「模型在 360° 转圈」，曾被误认为是 app bug。
- 因此**日常出证据一律用默认（不要加 `--show`）**。

## 动作文件自动发现

无 `--motion/--vpd` 时递归扫描 `tests/tmp/motions/`（最多 4 层，含 `converted/`、
`threejs_r171/` 等子目录），按 mtime 从新到旧取第一个 `.vmd`（优先）或 `.vpd`；
都没有则用内置自造 VMD。可用 `ls tests/tmp/motions` 查看 motion-hunt 队友下载的素材。

## 自动断言与元数据（compatibility.md / metadata.json）

每次运行输出并自动判定：

- **模型**：382 骨 / 85 morph / 4 根 IK / 26 根 grant / 重名骨；运行时顶点数/材质数/贴图加载数交叉校验（PMX 的 20 张贴图必须全部加载成功）。
- **VMD**：magic、30fps、帧范围/时长、骨骼关键帧数、每骨关键帧统计；
  **骨骼名交集/缺失**（MMDLoader 会静默丢弃缺失轨道）；
  **IK 控制骨轨道**（足ＩＫ/つま先ＩＫ）与 **VMD 末尾 IK on/off 段**（r171 helper 不消费）；
  **センター/グルーブ/全ての親 位移范围**（X/Y/Z min..max，模型单位与 540px 宠物像素换算）；
  morph 轨道命中/缺失；灯光帧/自阴影帧。
- **VPD**：编码探测（UTF-8 / Shift-JIS）、父模型名、骨数、骨名命中/缺失，
  `helper.pose` 应用后有多少根骨偏离 rest。
- **渲染**：每帧 alpha 覆盖率（证明透明背景上真的画出了模型）、2D 包围盒、是否 taint、
  渲染耗时；**骨架运动量**（跨帧骨骼世界位移/旋转最大值）；**脚底贴地**（脚骨世界高度
  相对 bind pose 的漂移量与 540px 宠物像素换算）。
- 人类/agent 可读的结论会写进 `compatibility.md` 第 4/5 节，并打印到 stdout。

## 已知坑 / 实现要点（都是本机实测）

1. **`mixer.setTime(t)` + `helper.update(0)` 不能用来「快速定位帧」**：r171 的
   `PropertyMixer.apply` 有「累计 buffer 与上一累加槽相同则跳过 `binding.setValue`」的优化，
   而 `MMDAnimationHelper._animateMesh` 每帧先 `_restoreBones` 复位；当 delta=0 且姿势与
   上次完全相同时 setValue 被跳过 → 骨骼停留在 restore 后的 rest 姿势（实测确实如此，
   表现为「时间在走但骨架不动」）。**正确做法**：从第 0 帧开始按 `helper.update(1/30)`
   逐帧步进；需要回退时移除/重挂 clip 并从 0 重放（本工具已实现）。
2. **VMD 的 IK on/off 段被 r171 忽略**：`mmd-parser` 只解析到 camera 段，`MMDAnimationHelper`
   也没有按帧开关 IK 的接口；模型自带的 4 根足ＩＫ 会**始终**每帧解算。若动作包靠 IK on/off
   段关闭 IK、只用 FK 腿，则直接套用会和 MMD 播放器不一致（用 `--ik off` 对比可量化）。
3. **`physics:false`**：不引入 ammo.js，MMDPhysics 完全关闭（裙摆/辫子/袖带不会动）。
   这与 app Wave 1/2 的决策一致；观感评估时不要把它当成动作包的问题。
4. **VMD 贝塞尔插值**：r171 `MMDLoader` 内置 `CubicBezierInterpolation`，会读 VMD 自带的
   64 字节插值参数（不是线性），这一点与 MMD 官方播放器一致；`frameNum/30` 秒。
5. **坐标系**：MMDLoader 解析 PMX/VMD 时均做 `leftToRight`（z 取反、四元数 x/y 取反），
   模型面向 +Z；相机 `front` 在 +Z 看向 -Z。VPD 同理（`parseVpd(text, true)`）。
6. **file:// 加载**：窗口 `webSecurity:false` + `loader.setCrossOrigin(undefined)`，PMX 内
   20 张贴图按 PMX URL 的 base 解析为 `file://.../optimized/<贴图名>`；渲染器侧
   `getImageData` 读回用来同时验证「未 taint」。
7. **本机环境变量 `ELECTRON_RUN_AS_NODE=1`**：会导致 `electron` 退化成纯 Node，所以必须用
   `run.sh` 启动（脚本里 `env -u ELECTRON_RUN_AS_NODE`）。直接跑 `node main.cjs` 会报错退出。
8. **相机取景**：按 bind pose 包围盒 + 18% 余量自动取景（透视 30°），所以抬手/蹲下不会裁切；
   透明背景 PNG 用 `win.webContents.capturePage()` 直出。
9. **重名骨**：模型有 1 组重名（`后碎髮9` ×2），MMDLoader 的骨骼轨道按名字匹配时只会命中其一；
   `compatibility.md` 会报告重名骨清单。

## 边界

- 只写 `scripts/anim-pipeline/preview/`、`docs/research/vmd-preview-tool.md`、`tests/tmp/preview/`。
- 不改 `src/**`、`package.json`、`PLAN.md` 与其他 docs；不 commit。
- 不复制模型/动作二进制到 tracked 路径；本工具只在 `tests/tmp/`（gitignore）下生成产物。
