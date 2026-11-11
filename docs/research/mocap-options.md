# 无动捕设备条件下的动作来源评估（视频动捕 / 浏览器实时动捕 / FBX→VMD 重定向）

> 目标读者：Lead（决策与接线）、B3 动画实现者、B8/后续动作管线负责人。
> 调研日期：**2026-11-08**。环境：macOS 27（26A434，Apple Silicon arm64）、Node v24.21.0、python 3.10.22 + torch 2.14.1（MPS 可用）、**Swift 6.4 命令行工具链可用**、Chrome 已装、**无 Blender、无 ffmpeg、无 Homebrew**、有外网。
> 项目约束：three.js **r171** `MMDLoader` 读 PMX（382 骨、标准日文骨名、**A-pose**、高 21.681 单位）；需要 4 类自然动作：**站立待机呼吸 / 走路循环 / 坐窗口沿 / 摸头·被拖拽反应**；最终动作最好进 **MMD VMD**（`MMDLoader` 原生支持 VMD/VPD）。
> 本文只做调研与方案判定，不改任何源码；探针产物在 `tests/tmp/mocap-eval/`。
> 关联文档（不重复内容）：`docs/anim-tech-survey.md`（B3 程序化姿态、VPD、MMD 骨架实测）、`docs/research/motion-assets.md`（motion-hunt：现成 VMD 动作包）、`docs/research/tooling-blender.md`（Blender+MMD Tools 工具链）、`docs/research/vmd-preview-tool.md`（VMD 预览器）。**如果 motion-assets 能直接找到可用的宠物向 VMD，那仍是最便宜路线，本文是它的补充/兜底。**

---

## 0. 一页结论（决策表）

| # | 结论 | 一句话理由 |
|---|---|---|
| **C1** | **首选管线 A：Reze MiPo 浏览器「视频/摄像头 → VMD」**（本地或 mipo.reze.one） | 唯一「**零动捕设备、零账号、零云端上传、直接产出 VMD**」的工具；MIT 生态（本仓库 GPL-3.0）；已在本机 `npm ci && npm run build` 复现通过（见附录 A.2）。适合 **待机呼吸 / 坐姿 / 摸头·拖拽反应** 这类原地、短时动作。 |
| **C2** | **管线 B（质量补强）：任意 humanoid FBX → `reze-rig` CLI → 指定本 PMX 目标 → VMD**（MIT） | 自动重定向（读 PMX 实测骨骼/比例/尺度、任意 bind pose、可开脚部 IK、可 `--in-place`、带 morph/眨眼映射）。动作来源可用 **Mixamo 免费库 / Rokoko Create 免费文本生成 FBX / 各视频动捕服务的 FBX**。**走路循环/坐下过渡优先走这条**（脚部 IK 与原地化明显好于摄像头实时解算）。**已在本机 macOS arm64 实测跑通**：最小 npm 目录（reze-engine+esbuild）打包 CLI 一次成功，用本 PMX 作 target、仓库自带样例 FBX 转出 4 条 VMD，**54/54 骨轨道全部命中本模型骨骼名**、含脚 IK、`--in-place` 生效（见 §4 与附录 A.4）。 |
| **C3** | **备选管线 C：macOS 原生 Vision 3D body pose（零安装 Swift 探针已跑通）自研 → VMD** | 完全离线私密、无任何依赖；但只有 **17 关节（无脚趾/手指/颈）**、无脚部 IK，需要自写 17 关节→MMD 重定向（约 2–4 天）。**仅在「不能上传任何视频/不想用浏览器」时作为兜底**。 |
| **C4** | 视频动捕云服务（Plask/DeepMotion/Rokoko/Move） | 能用且质量通常最好，但**都要账号 + 上传视频**；免费额度按秒计（见 §6 测算），只适合补 1–2 个关键镜头，不做主力。 |
| **C5** | 开源视觉动捕（GVHMR/WHAM/TRAM/4D-Humans…） | **macOS arm64 上不可实用**：依赖 CUDA 版 torch / PyTorch3D（无 arm64 wheel）/ SMPL·SMPL-X 注册账号；只用其 HuggingFace Space/Colab 又引入账号与下载。**不推荐**。 |
| **C6** | 用官方 PV/实机视频直接动捕 | **否证**：官方 wiki 的两段待机 GIF 是 **400×540 半身特写**（画面只有头/肩/手），根本不含全身关节；PV 有镜头运动/剪辑/遮挡，且是风格化 2D。**只作参考素材（task-6），不作动捕来源**。 |
| **C7** | Cascadeur / Move One 等 | Cascadeur **无 macOS 版**（官方安装文档只有 Windows/Ubuntu）；Move One 是 iPhone 单机 App、免费仅一次性 30 credits，性价比低。 |

> **最小成本先跑通（推荐执行顺序）**：MiPo 直接用本机 Chrome 打开 `mipo.reze.one`（或 `npm ci && npm run dev`）→ 上传本 PMX 文件夹（PMX+20 贴图）→ 手机横拍 5–8s 待机视频（全身入镜、固定机位）→ 导出 VMD → 用 `docs/research/vmd-preview-tool.md` 的预览器套我们的 PMX 看观感（约 **0.5–1 小时**，0 账号 0 费用）。观感 OK 后，走路/坐姿再走管线 B。

---

## 1. 判定标准（为什么很多「看起来能用」的方案被排除）

| 标准 | 含义 | 对方案的硬性影响 |
|---|---|---|
| 输入 | 只需要用户**手机/摄像头拍视频**（无动捕服、无 iPhone Pro 深度相机） | 排除 mocopi/VR 追踪器类硬件方案 |
| 本机可行性 | macOS **arm64 原生**可跑；不要求 CUDA | 排除 GVHMR/WHAM/TRAM/4D-Humans 本地部署（见 §3.2） |
| 依赖/包体 | 不引入 >200MB 的重依赖（除非 Lead 批准）；不要求编译 CUDA 扩展 | 倾向浏览器（MediaPipe WASM）或纯 Node CLI |
| 账号/费用 | **优先 0 账号 0 元**；付费只在能省很多时间时考虑 | MiPo/Vision 胜出；Mixamo 因 Adobe 中国区限制降级（见 §3.1 注） |
| 输出格式 | 能到 **VMD**（或 FBX，再经 reze-rig 一步到 VMD） | 排除纯 GLB/纯视频工具；SMPL 输出要额外转换（成本高） |
| 隐私 | 视频是否必须上传云端 | MiPo / Apple Vision / reze-rig 全本地；云服务需知悉并接受上传 |
| 授权 | 生成的动作数据能否本地自用、能否不再分发 | 本项目手机模型本身已禁止二次配布，动作只本地自用；Mixamo/Plask 等条款另见 §3.1 |
| 与 MMD 骨名的衔接 | VMD 骨名必须是本模型存在的日文骨名（Shift-JIS 编码） | MiPo/reze-rig 都直接写 MMD 骨名；SMPL/BVH 转换链要自己做骨名映射 |

---

## 2. 实测环境结论（本轮在本机跑出来的，不是查资料）

| 探针 | 结果 | 位置/证据 |
|---|---|---|
| `torch 2.14.1` + MPS | **可用**（`torch.backends.mps.is_available()==True`），但 PyTorch3D 无 macOS arm64 wheel（PyPI 只有 x86_64） | 见 §3.2 |
| **Swift 6.4 / macOS 27 原生 Vision 3D body pose** | **跑通**：`VNDetectHumanBodyPose3DRequest` 对真人 10.4s 视频抽 313 帧，**309 帧检出（98.7%）**，全帧处理 **34.7s（≈9 帧/s，CPU）**；输出 **17 个 3D 关节**（root/spine/center_shoulder/center_head/top_head/双肩/肘/腕/双髋/膝/踝，**无脚趾/手指**），`bodyHeight` 恒为 1.8m（归一化骨架，比例可用、绝对身高不估）；随机色块负样本**不误检** | `tests/tmp/mocap-eval/vision3d_pose.swift`、`vision_human_full.jsonl`（见附录 A.1） |
| **Vision 对官方/风格化素材** | 官方 400×540 **半身特写** GIF 帧也返回 `detected=true, confidence=1.0, 17 关节`（下半身是**脑补**的）；官方全身立绘/我们自己的 PMX 渲染图同样检出 | 同上 `vision_anime_run1.jsonl`；结论：**检测器会过置信，不能直接信 `confidence`，必须人工验片** |
| **Reze MiPo 本机可运行性** | `npm ci` 成功（node_modules **561MB**，Next 16 + MediaPipe + reze-engine）、`npm run build` **exit 0**、`npm run start` 起服务返回 200，headless Chrome 可加载 DOM（WebGPU 渲染与摄像头需交互式窗口，未在无头下验证） | 见附录 A.2 |
| **Reze rig CLI（FBX→VMD）本机可运行性** | **一次成功**：最小 npm 目录（`reze-engine`+`esbuild`，补 `pako`）打包 CLI → 用本 PMX 作 target → 仓库样例 FBX 转出 4 条 VMD；**54/54 骨轨道命中本模型骨骼名**、含 `左足ＩＫ/右足ＩＫ`、`--in-place` 生效（`センター` ±1 内） | 见 §4 管线 B / 附录 A.4（Lead 实测） |
| PyPI wheel（macOS arm64） | `mediapipe 1.2.2` **有 arm64 wheel 39.6MB**；`imageio-ffmpeg 0.8.1` **arm64 22.6MB**（补 ffmpeg 用，本次未安装）；`smplx` 纯 Python 但**模型需注册** | `pip`/PyPI JSON 探测 |
| CMU mocap 库 | 可访问；**2605 段动作、免费可用（可进商业产品、不可直接转售数据）**，BVH/ASF-AMC 格式 | [mocap.cs.cmu.edu](http://mocap.cs.cmu.edu/) |

> 一句话：**「本机能自己算」不再是障碍** —— 浏览器 MediaPipe（MiPo 同款）和 macOS 原生 Vision 都能在本机出 3D 人体；真正的差距在 **关节数、脚部接触、手部细节、以及到 VMD 的最后一公里**。

---

## 3. 方案对比矩阵

### 3.1 视频动捕云服务（2026-11 现状，全部需账号）

| 服务 | 输入 | 免费额度 | 免费能导出什么 | 付费门槛 | 输出格式 | macOS/GPU | 隐私 | 质量/适用 |
|---|---|---|---|---|---|---|---|---|
| **Plask** [pricing](https://plask.ai/en-US/pricing) / [FAQ](https://plask.ai/en-US/docs/faqs) | mp4/webm，**3s–5min**、≤100MB、建议 720p 横拍、全身正对 | **15 秒/天**（每天重置） | **FBX / GLB / BVH** 全给 | Standard $18/月起（10min/月）；有 7 天试用 | FBX/GLB/BVH | 纯浏览器，无 GPU 要求 | 视频上传云端；[FAQ](https://plask.ai/en-US/docs/faqs) 明确生成动画 IP 归用户 | 质量口碑较好；**V2 有脚部地面修正 + 动态相机**；还支持直接导入 PMX/VRM 预览（Babylon-mmd 物理） |
| **DeepMotion Animate 3D** [pricing](https://www.deepmotion.com/pricing-animate3d) | mp4/mov/avi | **60 秒/月**，无需信用卡，**仅个人非商用** | FBX / BVH / MP4（GLB 仅自定义角色） | 商用需订阅（价格由页面 JS 渲染，未截到具体档位） | FBX/BVH/GLB/MP4 | 浏览器，云端处理 | 视频私有，不上公开展示；免费档限非商用 | 老牌，质量稳定；手/脸追踪各 +0.5 credit/s |
| **Rokoko Vision 3.0（已并入 Rokoko Create）** [产品页](https://www.rokoko.com/products/vision) | 任何视频 | **30 秒/月** 处理 | **仅 FBX**（BVH 要 Basic 档） | Basic **$10–12/月**（600s/月） | FBX（付费加 BVH） | 浏览器 | 上传云端 | Vision 3.0 宣称重建解算、速度×4；另有**免费 Text-to-Motion**（见 3.3） |
| **Move（Move One iPhone App）** [Move One 定价](https://docs.move.ai/knowledge/move-one-pricing) / [输出格式](https://docs.move.ai/knowledge/genesis-output-formats) | iPhone 拍摄（免费 30s/条；付费 60s） | **一次性 30 credits**（Gen1≈30s / Gen2≈15s） | FBX 等（Move 平台输出 FBX/BVH/GLB/USDZ/blend/C3D/JSON） | $18/月起（60 credits） | FBX/BVH/GLB/USDZ/… | 需 iPhone；处理在云端 | 上传云端 | 需要 iPhone 是额外门槛，免费额度太少 |
| **RADiCAL** | — | **2026-04 核心团队/技术被 Autodesk 收购**（[CG Channel](https://www.cgchannel.com/2026/04/autodesk-acquires-core-tech-of-ai-motion-capture-firm-radical/)），不再作为独立服务推荐 | — | — | — | — | — |
| **Cascadeur** [系统要求](https://cascadeur.com/help/installation/system_requirements) | 不是视频动捕；FBX 关键帧 + AutoPosing/AutoPhysics | 免费版（工具） | FBX | 付费版 | FBX/GLB/USD | **官方安装文档只有 Windows / Ubuntu，无 macOS**（另有 Cascadeur Mobile，但非视频动捕） | 本地 | 排除（无 macOS） |
| **Meshcapade / Uthana** | 视频→SMPL / 文本→动作 | 未验证（需账号/付费） | SMPL npz / FBX? | — | SMPL 系 | 云端 | 云端 | SMPL 到手后仍要再转换到 MMD，链路长，不推荐作为第一选择 |

> 注：Mixamo 不在此表（它是**动作库**不是视频动捕），见 §3.3，且注意 Adobe FAQ 明确「**country code from China 的账号不可用 Mixamo**」（[Mixamo FAQ](https://helpx.adobe.com/creative-cloud/faq/mixamo-faq.html)），对本机用户可能是硬门槛。

### 3.2 开源视觉动捕（本机可行性是第一筛子）

| 项目 | 许可证/规模 | 本机 macOS arm64 可行性 | 输出 | 结论 |
|---|---|---|---|---|
| **GVHMR**（SIGGRAPH Asia 2024，[repo](https://github.com/zju3dv/GVHMR)） | 代码可获取；模型权重+**SMPL/SMPL-X 需注册** | ❌ 安装文档要求 **CUDA torch + PyTorch3D（CUDA 编译）+ DPVO/SimpleVO CUDA 扩展**；PyPI 的 pytorch3d 只有 x86_64 wheel（[PyPI](https://pypi.org/project/pytorch3d/)） | SMPL-X 参数/npz（**不是 FBX/BVH**） | 不可行（除非用 HF Space 云端，再解决 SMPL 转换） |
| **WHAM**（CVPR 2024）、**TRAM**（ECCV 2024）、**4D-Humans/HMR2.0** | 4D-Humans MIT；均需 SMPL + CUDA 环境 | ❌ 同上（GPU/CUDA 依赖 + SMPL 注册） | SMPL 参数 | 不可行 |
| **MotionBERT** | Apache-2.0 | ⚠️ 纯 PyTorch 可装，但需 2D 关键点前端，输出 H36M 3D 关节，仍要自写关节→MMD 映射 | 3D 关节 | 理论可行但工作量大、质量一般，不推荐 |
| **EasyMocap** | 多视角、ZJU | ❌ 重依赖、需标定/多机位 | SMPL | 不推荐 |
| **FreeMoCap**（[repo](https://github.com/freemocap/freemocap)） | **AGPL-3.0**，`pip install freemocap[cpu]` **官方支持 macOS CPU** | ⚠️ 依赖大（>500MB 量级）；输出 **FBX/BVH 走其 Blender 导出路径（需要 Blender）**，单摄像头需先标定/地平面，精度一般 | FBX/BVH（经 Blender） | **备选 3**：任务书外、链路长；只有「全开源+多机位」需求才值得 |
| **toyxyz_RGBMocap**（近期热度高的 GUI 工具） | 见 [repo](https://github.com/toyxyz/toyxyz_RGBMocap) | ❌ **Windows 原生 App**（.cmd、VS2022/CUDA 构建） | FBX/BVH | 排除 |
| **Reze MiPo（本项目首选，浏览器）** | **GPL-3.0**；MediaPipe Holistic WASM + WebGPU 渲染 | ✅ 本机 **Chrome** 即可；`npm ci`/`build` 已在本机通过（561MB node_modules，仅开发用） | **VMD（30fps）** + morph/视线 | 见管线 A |
| **Reze rig（重定向，浏览器+Node CLI）** | **MIT**；依赖 `reze-engine`（MIT，5.8MB） | ✅ **已实测**：纯 JS/Node，无 GPU、无 Blender；本机最小 npm 目录（reze-engine+esbuild）打包 CLI 一次成功 | FBX→**VMD** | 见管线 B |

### 3.3 动作库 / 文本生成动作（可作为管线 B 的输入）

| 来源 | 账号/费用 | 动作覆盖 | 到 VMD | 备注 |
|---|---|---|---|---|
| **Mixamo** | 免费 Adobe ID；**中国区账号不可用**（[FAQ](https://helpx.adobe.com/creative-cloud/faq/mixamo-faq.html)）；素材 royalty-free（个人/商业/非营利） | 海量 idle/walk/sit/反应动作，含 `Standing Idle`、`Walking`、`Sitting`、`Surprised` 等 | 下载 FBX → reze-rig（**明确列为 Tested 的 Mixamo 命名**） | 本机用户的可用性取决于能否注册非中国区 Adobe 账号，**列为「有账号才用」** |
| **Rokoko Create Text-to-Motion**（[产品页](https://www.rokoko.com/products/studio/rokoko-create)） | 免费：文本生成**不限条**、每月 **5 条导入 Studio**；免费档可 **导出 FBX** | idle / sitting / squat / walk 等简单动作**正是其宣称的最强项** | FBX → reze-rig | **0 元路线里性价比最高**；需 Rokoko 账号（免费注册）；生成的 clip 默认原地、无 root 位移，正好适合桌宠 |
| **DeepMotion SayMotion**（text-to-3D） | 免费额度**未确认**（定价页由 JS 渲染，抓取不到） | 文本→3D 动画 | FBX/BVH → reze-rig | 作为 Rokoko 的备选；需自行确认免费档 |
| **Kimodo / HY-Motion 等 2026 开源文本→动作模型** | 开源权重；Kimodo 官方文档称全 GPU 约 17GB 显存、`TEXT_ENCODER_DEVICE=cpu` 可 <3GB | 文本→SMPL-X/SOMA/G1 骨架 | **SMPL-X→MMD 链路要自己做**（重定向+骨名映射） | 2026 年技术很热，但**离「直接可用的 VMD」还很远**，不建议为 4 个动作上这套 |
| **CMU mocap / AMASS / LAFAN1** | CMU 免费（可商用但不可转售数据）；AMASS 需 SMPL 许可 | 走/坐/日常行为极全 | **BVH/AMASS npz → 需要 BVH→FBX（Blender）或自写转换** | 作为「无账号」兜底动作库；到 VMD 多一步转换 |

### 3.4 手机/摄像头方案补充

- **iPhone 拍视频 + MiPo**：最推荐 —— 不装任何 App，视频上传到本地 MiPo 页面处理，隐私最好。
- **Move One（iPhone App）**：单机位 ARKit 类方案，输出 FBX/BVH，但免费额度仅一次性 30 credits，之后 $18/月；且要 iPhone。
- **ARKit Body Tracking 的通用 App**：输出 FBX 的 App 多为付费/订阅，且骨名/retarget 仍要处理；**不如直接用 MiPo 的通用视频路径**。
- 没有 iPhone 也没关系：**普通 1080p 手机视频 + MiPo/Plask** 即可；Plask 明确要求 720p 以上、全身、横拍、净背景。

---

## 4. 三条推荐管线（含步骤、坑、工作量）

### 管线 A（首选，0 账号 0 元 0 上传）：**Reze MiPo：视频/摄像头 → VMD**

**定位**：原地、短时、上半身细节要求不高的动作：**站立待机呼吸、坐姿（含「坐窗口沿」的静态/微动）、摸头反应、被拖拽/惊讶反应**。
**不擅长的**：需要**脚掌接触锁定**的走路循环（其求解器明确是 in-place、以「最低脚」定身体高度，没有脚部 IK 钉地）、以及全身远景下的手指细节（README 自己写「Next up: wrist-cropped hand detection」）。

**事实核对**（读源码得出，见附录 A.2 引用行号）：
- 输入：**摄像头实时**或**上传视频**（`accept="video/*,image/*"`，图片 = 单帧姿势 VMD），视频按**逐帧 30fps** 处理、时间戳用视频自身时钟；上传文件**留在浏览器本地**（IndexedDB），不上传自己的视频（只从 CDN 拉 demo 资源）。
- 模型：**可上传任意 PMX 目录**（`webkitdirectory`，PMX+贴图整个目录；工程要求目录内只有一个 PMX），加载时**按该 PMX 的 rest pose 自动标定**，不要求 T-pose（对 A-pose 模型友好）。
- 输出：`src/lib/vmd.ts` 写 **VMD 30fps**、标准线性插值手柄；写 `センター` 竖直位移（原地）、骨骼四元数、morph（`まばたき/あ/ワ/ウィンク`）与视线（`左目/右目`）；带关键帧精简与 Savitzky-Golay 导出平滑。
- **IK 坑（重要）**：MiPo 输出的是 **FK 腿**，它会在 VMD 里写「`左足ＩＫ`/`右足ＩＫ` enabled=false」的 IK 开关帧来让 MMD 里的 IK 让位。但**three r171 `MMDLoader` 不消费 VMD 的 IK 开关帧**（只读 PMX 里的 IK 定义，`MMDLoader.js` 全文没有 VMD IK 帧解析），`MMDAnimationHelper` 会照常跑 `CCDIKSolver` → **腿部会被拉回 IK 静止位置**。app 侧接线时必须 `helper.enable('ik', false)`（r171 官方开关，见 `MMDAnimationHelper.enable()`），并依赖 GrantSolver 让 `足D/ひざD/足首D`（本模型可见的蒙皮腿）跟随 FK 的 `足/ひざ/足首`；grant 默认是开的，`docs/anim-tech-survey.md` §2.4 的权重结论与此一致。
- **许可**：仓库 **GPL-3.0**（代码）。本地自用/生成动作数据不受影响；**不要把它的代码或改版打进产品分发**（站点本身也声明只支持官方地址的 web 版）。生成 VMD 是用户自己录自己，不存在第三方素材授权问题。

**执行步骤**：
1. `git clone https://github.com/AmyangXYZ/MiKaPo && npm ci && npm run dev`（或直接开 `https://mipo.reze.one`；本机已实测 `npm ci`+`npm run build` 通过，见附录 A.2）。
2. 上传本模型目录（`assets/model/optimized/` 里 PMX + 贴图；目录内只留一个 PMX）。
3. 用**手机横拍**录 5–8s：全身入镜、固定机位、光线均匀、背景干净；待机就自然呼吸+微重心；坐姿可拿椅子侧对镜头；摸头反应自己把手放到头上。
4. 上传视频 → 点转换 → 导出 `.vmd`。
5. 用 `docs/research/vmd-preview-tool.md` 的预览器（或临时 app 侧 loadVMD）套我们的 PMX 看观感；**重点看：脚是否穿地/滑、手臂是否穿胸、手部是否抖**。
6. 进 app 前做一次「VMD 骨骼交集检查」（模型 382 骨 vs VMD 骨名）、并确认 app 侧 helper 的 `ik` 开关状态。

**预计工作量**：环境 0（本机已验证）～0.5h；每个动作录制+转换+回看 0.5–1h；4 个动作含重试 **约 3–5h**；走路需另走管线 B。

---

### 管线 B（质量补强，MIT）：**任意 humanoid FBX → `reze-rig` → 以本 PMX 为目标 → VMD**

**定位**：所有「必须先有专业动作，再落到 MMD 骨架」的场景，尤其是**走路循环、坐下/站起过渡、跑跳**；也是把**云服务/文本生成/Mixamo 的输出变成 VMD** 的通用最后一公里。

**为什么是它**（[reze-rig README](https://github.com/AmyangXYZ/reze-rig)，本轮已 clone 读源码）：
- **MIT 许可**；浏览器 UI + **`scripts/fbx2vmd.ts` Node CLI**（`npx esbuild ... --platform=node` 打包后 `node fbx2vmd.mjs <files> [--out] [--target-pmx] [--in-place] [--no-foot-ik] [--bind-ref]`），**不需要 Blender、不需要浏览器**。
- **自动识别** Mixamo / UE-Mannequin(Unity Humanoid) / 3ds Max Biped / Character Creator 骨名 → MMD 日文骨名；对任意 bind pose（T/A/relaxed）做解剖段对齐；
- **目标 PMX 实测**：`--target-pmx` 会 `PmxLoader.loadFromBuffer` 后 `model.update()` 读 `measureTargetPositions`（骨骼世界坐标），因此**比例/单位（cm/m/inch）自适应**；同时读 PMX 的 morph 表与眼睑几何，**眨眼 morph（まばたき）会按目标模型拟合**（`lib/fbx-morph.ts` 的 `readTargetEyelids/fitEyelids`）。
- **脚部 IK 默认开**（CLI 注释「matches the site」）：把 FK 踝轨迹写成 `左足ＩＫ/右足ＩＫ` 的 VMD 位移轨道，身体抬到低脚离地、支撑脚钉地；`--no-foot-ik` 则纯 FK。**走路/坐下必须用默认的 IK**，否则滑步明显。
- `--in-place` 去掉水平位移、保留竖直（桌宠在原地走，正是我们要的）；`--bind-ref` 用一条 Idle 作为 bind 参考，避免 Unity/UE 的「首帧=循环中段」被当成 rest。
- 仓库自带样例 FBX（`animation.fbx` 5MB、`AM_Attack01.fbx` 15.7MB）可自测，无需外网素材。
- **限制**：输入**只吃 FBX**（不吃 BVH/SMPL/GLB）；只认 humanoid 命名表；30fps；手臂不做 IK（够用）。

**✅ 本机实测（Lead，2026-11-08，macOS arm64，本机环境）**：

| 项 | 实测结果 |
|---|---|
| 环境 | **只需 2 个 npm 包**：`reze-engine@0.68.10`（MIT）+ `esbuild`，建最小目录即可；**不需要 Next.js 全家桶、不需要 Blender、不需要 GPU** |
| 打包 | `node_modules/.bin/esbuild scripts/fbx2vmd.ts --bundle --platform=node --format=esm --outfile=/tmp/fbx2vmd.mjs` **一次成功**，bundle 1.7MB；`lib/fbx.ts` 依赖 **`pako`**（正常 `npm install` 会带上，最小目录需补装） |
| 转换 | `node /tmp/fbx2vmd.mjs public/fbx/{Idle,Taunt,Arms Down,Run_Lfoot}.fbx --target-pmx "<我们的PMX>" --in-place --out tests/tmp/motions/converted`；日志出现 `target skeleton: measured from ...`、`[retarget] "mixamo.com": Mixamo, scale=0.1278, 51 mapped (47 aligned)`、`[retarget] "Mvm_Idle": UE/Unity, scale=0.1360, 51 mapped` |
| 成功率 | **4/5 成功**；`Humanoid_F.FBX` 无 animation clip（正常，不是失败） |
| 产物 | `Idle.vmd` 533KB / `Taunt.vmd` 504KB / `Run_Lfoot.vmd` 123KB / `Arms Down.vmd` 12KB |
| 骨名 | mmd-parser 1.1.4 解析：**54 条骨轨道，54/54 全部命中本模型骨骼名（0 missing）**，含 `左足ＩＫ/右足ＩＫ` 脚 IK 帧 |
| 原地化 | `センター` 位移在 ±1 内，`--in-place` 生效 |
| morph | 仓库样例 FBX **没有 blendshape**，所以样例产物无 morph；Rokoko/Mixamo 带表情通道的 FBX 才有（链路代码已支持：眨眼/EB_* 映射 + 按目标 PMX 拟合眼睑） |
| 视觉验证 | 独立 three.js r171 预览器（vmd-viewer 队友）正在套本 PMX 出接触表，**观感结论待 Lead 转达** |

> 意义：**「FBX→VMD」这一公里已经从「待验证」变成「本机可复现」**——剩下的是拿到更贴近项目需求的 FBX 动作（§4 输入来源）并做观感调优。

**输入从哪来（按 0 元优先）**：
1. **Rokoko Create 文本生成**（免费 5 clips/月，导出 FBX）——写「a man standing idle, gentle breathing, 8 seconds」「walk cycle in place」「sitting on a ledge, relaxed」等 prompt；**这是最贴合本项目 4 类动作的 0 元来源**；
2. **Mixamo 免费动作库**（有 Adobe 账号且非中国区才可用）——直接下 `Standing Idle / Walking / Sitting Idle / Surprised` 的 FBX；
3. **视频动捕服务**（Plask 15s/天、DeepMotion 60s/月）拍真人视频 → FBX/BVH（BVH 需先转 FBX，见坑）→ reze-rig；
4. **CMU/AMASS BVH**（免费）→ 需先 BVH→FBX（Blender 一段脚本或 bvh2fbx 工具）→ reze-rig。

**执行步骤**（已验证的命令形态）：
1. 建一个最小目录并装 2 个包：`npm i reze-engine esbuild pako`（`pako` 是 `lib/fbx.ts` 的运行时依赖；若直接 `npm install` 整个 repo 则自动带）；
2. 取 reze-rig 源码：`git clone --depth 1 https://github.com/AmyangXYZ/reze-rig`（或只拷 `scripts/` + `lib/`）；
3. 打包 CLI：`node_modules/.bin/esbuild scripts/fbx2vmd.ts --bundle --platform=node --format=esm --outfile=/tmp/fbx2vmd.mjs`；
4. 准备一条 `Idle.fbx` 作为 bind 参考（Rokoko/Mixamo 的 idle 即可），然后转换：`node /tmp/fbx2vmd.mjs <fbx或目录> --target-pmx "assets/model/optimized/<我们的>.pmx" --out tests/tmp/motions/converted --in-place`（走路/坐下保持默认脚 IK；纯原地摆动可加 `--no-foot-ik` 对比）；
5. 预览器/MMD 里看：**脚是否钉地、膝盖有无反关节、肩/肘是否别扭、センター高度是否正确**（vmd-viewer 的接触表可以直接用）；
6. app 接线：**VMD 里有 足ＩＫ 轨道 → helper ik 保持默认 true**；grant 保持 true（让 D 链腿、腕捩跟随）；详见 §5.1 对照表。
7. morph：reze-rig 只会带它认得的表情通道（眨眼/EB_* 面部 rig）；我们的 85 个 morph 里的 `照れ/星目` 等仍由 B3 表情调度器负责，**VMD morph 轨道与 B3 的写 morph 逻辑要仲裁**（同一帧只有一个写入方）。

**预计工作量**：CLI 已验证（0.5h 内可复现）；每个动作源获取（Rokoko/Mixamo/Plask 取一条 FBX）0.5–1h；4 类动作含调参/回看 **约 4–6h**（不含注册账号的时间）。

---

### 管线 C（离线兜底，需自研）：**macOS Vision 3D pose → 自研重定向 → VMD**

**定位**：隐私要求最高、不接受任何浏览器/账号/云；或想完全掌控重定向质量曲线的情境。
**本机能力已实测**（附录 A.1）：Swift 一行 `VNDetectHumanBodyPose3DRequest()`，无任何第三方依赖，CPU 约 **9 帧/s**；输出身体相对坐标的 17 关节（米、Y-up、root 在原点），`bodyHeight` 恒 1.8（比例不变、绝对尺寸不估）。
**要补的工程**：
1. 视频抽帧：本机无 ffmpeg —— 用 **Swift/AVFoundation 直接读视频**（探针已这么做，无需 ffmpeg），或用 `imageio-ffmpeg`（pip，22.6MB）补 ffmpeg；
2. 17 关节 → MMD 骨：用 PMX 骨骼世界坐标（`tests/tmp/bones.json` 已有）构造 rest 段向量；按「父骨旋转 = 把 rest 段方向旋到 live 段方向」的 quaternion 公式逐骨求解（MiPo 的求解器思路可参考、**不要抄代码**，它是 GPL）；缺 `つま先/足首` 细节 → 脚掌朝向只能用足首段方向近似；
3. 平滑（One-Euro/低通）+ 缺失帧回退（沿用上一帧、500ms 内缓出）；
4. VMD 写文件（30fps、Shift-JIS 骨名、线性插值、センター 位移=髋部世界位移 - rest）——格式很薄，~150 行；
5. 手部：Vision 另有 `VNDetectHumanHandPoseRequest`（2D 手部 21 点）；要做摸头/挥手得再补这一层，工作量翻倍。
**预计工作量**：**2–4 天**（含调试与验收）；质量大概率**低于 MiPo**（关节更少、无脚 IK、无手部细节）。**结论：不作为首选，只在管线 A/B 被否时启动。**

---

## 5. 与 three.js r171 `MMDLoader` 的衔接（这是最容易踩坑的部分）

| 事项 | 结论与坑 | 依据 |
|---|---|---|
| 加载 VMD | `loader.loadVMD(url, vmd => helper.add(mesh, {animation: ...}))`；`MMDAnimationHelper` 每帧 `mixer.update` + grant + IK | `node_modules/three/examples/jsm/loaders/MMDLoader.js`、`.../animation/MMDAnimationHelper.js` |
| 帧率 | VMD **固定 30fps**；渲染 60fps 由 AnimationMixer 插值，无问题；VMD 的插值手柄是 Bezier 127 空间，MiPo/reze-rig 都写标准线性手柄 | MiPo `src/lib/vmd.ts:20,28`；reze-rig `VMDWriter` |
| **IK 开关** | three **不读 VMD 的 IK 开关帧**（只在 PMX 里建 IK 链）；所以：<br>• 用 **reze-rig（默认脚 IK，VMD 有 足ＩＫ 轨道）** → helper `ik:true` 正常解算；<br>• 用 **MiPo（FK 腿）** → **必须 `helper.enable('ik', false)`**，否则 CCDIK 把腿拉回静止位 | `MMDLoader.js` 仅有 `metadata.ikCount`（PMX）；VMD 解析路径无 IK 帧消费 |
| 付与（grant） | 本模型腿/腕的可见蒙皮在 `足D/ひざD/足首D`、`腕捩1..3` 等 grant 骨上；helper 的 `GrantSolver` 默认开，**保持 `grant:true`** 才能让 FK 的 `足/ひざ` 驱动可见的 D 链 | `MMDAnimationHelper.js:1128+`、`MMDLoader.js:788-852`（本项目实测见 `docs/anim-tech-survey.md` §2.4） |
| A-pose / bind pose | 本模型是 **A-pose**；MiPo 加载时按模型 rest 标定（不要求 T-pose）；reze-rig 对任意 bind pose 做解剖对齐 —— 两者都能处理；**不要**再用「T-pose 假设」的转换脚本 | reze-rig README / MiPo README |
| 比例与单位 | MMD 单位：模型高 21.681 单位 ≈ 1.75m → **1 单位 ≈ 8.07cm**；reze-rig 直接读目标 PMX 骨骼坐标，不靠猜；MiPo 直接对 PMX 标定 | 本模型实测（`docs/anim-tech-survey.md` §1.2） |
| センター 与位移 | 桌宠的位移/朝向由 app 控制 → 用 `--in-place`；VMD 里的 `センター` 竖直位移可保留（呼吸/蹲起），水平位移应清零 | reze-rig `--in-place`；MiPo README「Capture stays in place」 |
| 骨名与编码 | VMD 骨名是 **Shift-JIS** 编码的日文名；`足ＩＫ` 的 `ＩＫ` 是**全角**（U+FF29/U+FF2B）；VMD 里不存在的模型骨骼会被 `MMDLoader` 静默跳过 | `docs/anim-tech-survey.md` §2.1 |
| **与 B3 程序化姿态的冲突（必须 Lead 决策）** | `MMDAnimationHelper` 一旦挂 VMD，会每帧 `_restoreBones`（按 pmx 动画系统重算 IK/grant）并覆盖同批骨骼；B3「直接写骨骼」与 VMD 不能同时驱动同一根骨。可选：①VMD 只做基础层，B3 降级为「表情/视线/弹簧」独立层；②两者按状态互斥切换（crossfade 用两个 mixer 或手写权重混合）；③暂不接 VMD，继续 B3 | `MMDAnimationHelper.js` `_animateMesh`（restore→mixer→save→animatePMXMesh）与本项目 B3 契约（`docs/anim-tech-survey.md` §1.3） |
| VMD 里没有的骨 | 手指（21 骨/手）、`目先`、`腰キャンセル` 等通常不在 VMD 里 → 保持 rest；表情/注视仍由 app 负责，正好和 B3 分工一致 | 本模型 382 骨清单（`tests/tmp/bones.json`） |

> 验收建议（结合 task-5 预览器）：每个 VMD 先跑「骨骼名交集 / 帧数 / 是否含 IK 帧 / 是否含 センター 位移」「首尾帧是否可循环」「脚底最低点是否稳定」四项自动检查，再人工看 3 个角度截图。

### 5.1 两种 VMD 的 IK 语义对照（接入 three r171 时必看）

同样是 `.vmd`，**MiPo 与 reze-rig 产出的腿部驱动方式相反**，app 侧 `MMDAnimationHelper` 的 `ik` 开关必须跟着切换——这是本轮最容易出的「腿被钉死/穿模」事故来源。

| 对比项 | **reze-rig 产出**（管线 B，默认 `footIK`） | **MiPo 产出**（管线 A，FK 腿） |
|---|---|---|
| 骨骼命名 | 标准 MMD 日文骨名（**已实测 54/54 命中本模型**） | 标准 MMD 日文骨名（同样直接写 MMD 骨） |
| 腿部数据 | **FK 骨轨道**（`足/ひざ/足首`）+ **`左足ＩＫ/右足ＩＫ` 位移轨道**（脚 IK 目标） | **只有 FK 骨轨道**（`足/ひざ/足首`）；VMD 里另有 `左足ＩＫ/右足ＩＫ` 的 **IK 开关帧**（`enabled=false`） |
| 谁负责脚落地 | **three 的 CCDIK** 按 IK 目标解算（身体抬到低脚离地、支撑脚钉地） | **MiPo 求解器已经算好 FK**；不需要（也不能）再让 CCDIK 解算 |
| `MMDLoader` 读到的 IK 帧 | 只有**位移轨道**（普通骨骼 translation，loader 照常建 track） | **IK 开关帧 three 不消费**（`MMDLoader` 只读 PMX 的 IK 定义）→ 开关帧等于被忽略 |
| app 侧 `MMDAnimationHelper` | **`ik` 保持 `true`**（默认）→ helper 用 `左足ＩＫ/右足ＩＫ` 的目标位置跑 `CCDIKSolver` | **`helper.enable('ik', false)`** → helper 不再跑 CCDIK，腿完全由 VMD 的 FK 轨道决定 |
| `grant`（付与） | **保持 `true`**（本模型可见腿在 `足D/ひざD/足首D`，靠 grant 从 `足/ひざ` 取旋转） | **保持 `true`**（同上；`腕捩1..3` 也靠 grant） |
| `--in-place` / 位移 | CLI `--in-place` 清水平位移；`センター` 保留竖直 | 求解时即原地；`センター` 只有竖直位移 |
| morph | FBX 有 blendshape 才带；含 `まばたき` 与 EB_* 映射，并按目标 PMX 眼睑拟合 | 带 `まばたき/あ/ワ/ウィンク` 与视线 `左目/右目`（按目标模型求解） |
| 适合动作 | 走路循环、坐下/站起过渡、跑跳（脚部接触关键） | 待机呼吸、坐姿、摸头/拖拽反应（原地、短时） |
| 一句话记忆 | **有 IK 目标轨 → ik 开** | **纯 FK 腿 → ik 关** |

> 若同一个 app 里两套 VMD 都要放（状态机按 pose 切换），最稳妥的做法是**每个 VMD 加载时同步切换 `helper.enable('ik', …)`**（clip 级元数据里记 `hasFootIk: boolean`），并在切换帧做一次 `helper.enable` + mixer crossfade；不要假设一套设置通吃两种 VMD。

---

## 6. 免费额度够不够？（4 类动作的秒数测算）

**需求拆解**（按最终可用素材计，取偏保守）：

| 动作 | 最终片长 | 用途 |
|---|---|---|
| 站立待机呼吸（循环） | 8s | idle 层 |
| 走路循环（5 个循环） | 5s（1s/循环 ×5） | 走 |
| 坐窗口沿 | 3s（过渡+保持） | sit |
| 摸头反应 | 2.5s | pat |
| 被拖拽/惊讶反应 | 2.5s | drag |
| **合计** | **21s** | |

拍摄还要起手/收尾（×1.6 → **33.6s**）；考虑重试（×2.2 → **约 74s**；最坏 ×3 → 101s）。

**各免费额度覆盖情况**：

| 来源 | 免费额度 | 是否够做全套 | 结论 |
|---|---|---|---|
| **Plask** | 15s/**天**（≈450s/月） | ✅ 够；idle 8s + walk 5s 一天做完，sit/pat/drag 第 2–3 天 | **免费里最宽裕的云服务**；0 元可完成全套（含走路） |
| **DeepMotion Animate3D** | 60s/月（个人非商用） | ⚠️ 74s 需约 1.3 个月；一次过（33.6s）可以 | 够「干净地做一遍」，重试要跨月；商用需订阅 |
| **Rokoko Vision** | 30s/月（免费导出仅 FBX） | ❌ 33.6s 起就超；需 2 个月或砍动作 | 免费不够全套；Budget Basic $10–12/月可解决 |
| **Move One** | 一次性 30 credits（Gen1≈30s / Gen2≈15s） | ❌ 不够 | 不推荐为额度买 |
| **Rokoko Create Text-to-Motion** | 免费：**5 条/月导入 Studio** + 免费 FBX 导出 | ✅ 4 类动作 = 4–5 条，**刚好** | **0 元路线首选（文本生成）**；无需拍视频，需免费账号 |
| **MiPo** | 无额度概念（本地/免费网页） | ✅ 不限秒数（只耗本机算力） | **0 账号 0 元 0 上传** |
| **Mixamo** | 无限动作库 | ✅（若账号可用） | 动作库免费，但中国区账号受限 |

**结论**：**「0 元、0 账号」能把待机/坐姿/反应做出来（MiPo）**；**走路与专业感补强**用「Rokoko Create 免费 5 clips」或「Plask 免费 15s/天」→ reze-rig → VMD；完全不想注册任何账号时，用 MiPo + 自己拍走路视频（接受脚滑，或用 app 侧步频/位移补偿）。

---

## 7. 专项：用官方 PV / 游戏实机视频做动捕，可行吗？

**结论：不可行（至少不能当主力来源），只适合当参考帧。**

| 检查项 | 事实 | 影响 |
|---|---|---|
| 素材本身 | 本仓库 `tests/tmp/ref/` 的官方待机 GIF：**400×540，196/208 帧，画面是头肩特写**（见 `tests/tmp/mocap-eval/ref_frame_48.png`），**没有全身** | 全身动捕无从谈起；最多做表情/头肩微动参考 |
| 官方全身图 | wiki 的角色展示图有全身站立（`tests/tmp/ref/compare-stand.png` 的 official 帧）；用 Vision 探针检测**能检出 17 关节** | 单帧姿势可参考，但**风格化 2D 的 3D 关节精度不可信**（见附录 A.1 的「半身图也返回 17 关节」） |
| 镜头 | PV/实机演示有**运镜、剪辑、特效、遮挡**；云服务里只有 Plask V2 / DeepMotion 等支持动态相机，且要求「全身始终在画面内、人物清晰无遮挡」 | 可用片段极少，需要人工挑镜头修剪 |
| 检测器 | Plask FAQ 明确「只识别人形，非人物体不兼容；宽松衣物会干扰」；服务模型都训练在真人上 | 二次元渲染/风格化比例（头大、四肢细）容易失真 |
| 授权 | 游戏 PV/角色演示是版权素材；由此提取动作再生成 VMD，**只可本地个人研究，绝不能再分发**（本项目本来就因 PMX 版权不分发） | 合规风险可接受但不宜作为唯一来源 |
| 已有替代 | task-6 正在产出官方素材的 beat 表/姿态目标；B3 用程序化姿态复刻 | 参考比动捕提取更靠谱 |

**建议**：把官方素材用在 **①姿态目标（beat 表）②观感对照**；不要花时间做「PV→VMD」的自动提取。

---

## 8. 风险登记（按优先级）

| # | 风险 | 影响 | 缓解 |
|---|---|---|---|
| R1 | **IK 开关语义不匹配**：MiPo 的 FK 腿 VMD + three 默认 CCDIK 会把腿拉回静止 | 腿看起来「被钉住/穿模」 | app 侧接 VMD 时明确设置 `helper.enable('ik', false)`（MiPo）或保持 true（reze-rig 默认脚 IK）；在预览器里先验证 |
| R2 | **脚滑/穿地**：摄像头实时 in-place 解算没有脚部接触锁定 | 走路不自然，用户观感差 | 走路/坐下改走管线 B（reze-rig 脚 IK + in-place）；MiPo 只做原地小动作 |
| R3 | **手部细节差**：MiPo README 自认全身远景手指跟踪是 next-up；MediaPipe 手部在远景会收缩 | 摸头/拖拽的手部动作糊 | 拍近一点的半身/全身视频；或把「摸头反应」做成程序化手势 + 表情（B3），VMD 只做身体 |
| R4 | **风格化/半身素材过置信**：Vision 探针对半身图返回 confidence 1.0；商业服务虽较稳但仍可能失真 | 自动流水线不可全信 | 每个 VMD 必须人工看片 + 预览器三视图；不要以 `confidence` 作为验收 |
| R5 | ~~reze-rig CLI 端到端未定论~~ **已消除**：Lead 实测 4/5 样例成功、54/54 骨名命中、脚 IK 帧与 `--in-place` 均生效 | —（残留：最小目录要补 `pako`；样例 FBX 无 blendshape 所以样例无 morph；视觉观感待 preview 接触表） | 用完整 `npm install` 或补 `pako`；真实 FBX（Rokoko/Mixamo）自带表情通道时再验 morph；观感以 vmd-viewer 接触表为准 |
| R6 | **账号/地区限制**：Mixamo 对中国区 Adobe 账号不可用；云服务需账号；Move One 需 iPhone | 部分来源不可用 | 默认走 MiPo/Rokoko Create；把「需账号」的来源放备选 |
| R7 | **隐私**：Plask/DeepMotion/Rokoko 要上传视频 | 用户可能不接受 | 首选本地 MiPo / Vision；云服务只上传裁剪过的必要片段 |
| R8 | **授权**：GPL-3.0（MiPo 代码）、AGPL（FreeMoCap）；Mixamo/云服务的素材条款；CMU「不可转售数据」 | 合规 | 只本地自用、不分发 app 资产；不把第三方代码打进产品；动作数据从自己拍摄/免费库生成 |
| R9 | **与 B3 的驱动冲突** | 动画系统打架 | Lead 决策：VMD 作基础层 / B3 降为表情+视线层，或按状态互斥 |
| R10 | **30fps + 关键帧精简**：MiPo 导出会精简关键帧（误差ε），快速动作可能掉细节 | 反应类动作略钝 | 需要时在预览器看曲线；必要时保留全帧（改导出逻辑）或缩小 ε |

---

## 9. 建议的下一步（给 Lead 的决策项）

1. **管线 B 已通过本机验证**（Lead：CLI 一次成功、4/5 样例、54/54 骨名命中、脚 IK + `--in-place` 生效）→ **下一步就是拿「贴近 4 类动作」的 FBX**：Rokoko Create 免费文本生成 4–5 条（idle / walk in place / sitting / surprised-or-shrug）→ reze-rig 转 4–5 条 VMD → vmd-viewer 的接触表验收。**验收标准**：脚不明显穿地/滑、膝盖无反关节、手臂不穿胸、`センター` 高度合理、骨名覆盖 `上半身/頭/腕/ひじ/足/ひざ/足首/センター/足ＩＫ` 等核心骨。
2. **管线 A 补位**（0 账号 0 上传的兜底）：MiPo 上传本 PMX → 拍/录 5–8s 待机/坐姿/摸头反应 → 导出 VMD → 与管线 B 同场景对比观感；注意接 VMD 时按 §5.1 切换 `helper.enable('ik', …)`（MiPo 必须 `false`）。
3. **需要真人唯一动作时**（比如特定的摸头反应）：Plask 免费 15s/天拍 1–2 条 → FBX → reze-rig；或 Rokoko Create 文本生成先试（0 元、5 条/月）。
4. **不建议投入**：GVHMR/WHAM/TRAM 本地部署、官方 PV 动捕、Cascadeur、Move One、Kimodo 自部署（除非用户明确要「AI 文本生成动作」且接受几天工程）。
5. **长期**：把 reze-rig 的 VMD 输出 + task-5 预览器 + task-4 的 Blender 工具链固定成 `scripts/anim-pipeline/` 的「动作入库」流程；VMD 作为外部动作资产格式，程序化 B3 继续负责表情/视线/弹簧；每颗 VMD 的元数据里记 `hasFootIk: boolean` 供 §5.1 的切换逻辑使用。

---

## 10. 证据链接

**Reze 家族（本轮核心发现）**
- MiPo（实时/视频 → VMD）：[GitHub MiKaPo](https://github.com/AmyangXYZ/MiKaPo)（现名 reze-mipo，[repo](https://github.com/AmyangXYZ/reze-mipo)）、[在线版](https://mipo.reze.one)
- reze-rig（FBX → VMD）：[GitHub](https://github.com/AmyangXYZ/reze-rig)（MIT，含 README 的 batch CLI 说明）
- reze-engine（WebGPU MMD 渲染，MIT，npm `reze-engine` 5.8MB）：[npm](https://www.npmjs.com/package/reze-engine)

**视频动捕服务**
- Plask：[定价](https://plask.ai/en-US/pricing)、[FAQ/政策](https://plask.ai/en-US/docs/faqs)（15s/天、FBX/GLB/BVH、3s–5min、100MB、PMX 导入）
- DeepMotion：[Animate3D 定价/FAQ](https://www.deepmotion.com/pricing-animate3d)（60s/月、个人非商用、FBX/BVH/MP4/GLB）
- Rokoko：[Vision 3.0](https://www.rokoko.com/products/vision)（30s/月、免费仅 FBX、BVH 需 Basic）、[Create 文本生成](https://www.rokoko.com/products/studio/rokoko-create)（免费 5 clips/月）
- Move：[Move One 定价](https://docs.move.ai/knowledge/move-one-pricing)、[输出格式](https://docs.move.ai/knowledge/genesis-output-formats)
- Cascadeur：[系统要求](https://cascadeur.com/help/installation/system_requirements)（仅 Windows/Ubuntu）
- RADiCAL/Autodesk：[CG Channel 2026-04 收购报道](https://www.cgchannel.com/2026/04/autodesk-acquires-core-tech-of-ai-motion-capture-firm-radical/)
- Mixamo：[Adobe Mixamo FAQ](https://helpx.adobe.com/creative-cloud/faq/mixamo-faq.html)（免费、需 Adobe ID、中国区不可用、royalty-free）

**开源视觉动捕**
- GVHMR：[repo](https://github.com/zju3dv/GVHMR)（SIGGRAPH Asia 2024；安装需 CUDA/PyTorch3D/SMPL 注册）
- WHAM：[repo](https://github.com/yohanshin/WHAM)、TRAM：[repo](https://github.com/yufu-wang/TRAM)、4D-Humans：[repo](https://github.com/shubham-goel/4D-Humans)（MIT）
- MotionBERT：[repo](https://github.com/Walter0807/MotionBERT)（Apache-2.0）
- FreeMoCap：[repo](https://github.com/freemocap/freemocap)（AGPL-3.0，macOS CPU）、[FBX/BVH 导出文档](https://docs.freemocap.org/guides/export-formats/)
- toyxyz_RGBMocap：[repo](https://github.com/toyxyz/toyxyz_RGBMocap)（Windows-only）
- CMU mocap：[mocap.cs.cmu.edu](http://mocap.cs.cmu.edu/)（2605 段、免费、不可转售数据）
- MediaPipe：[Pose Landmarker](https://ai.google.dev/edge/mediapipe/solutions/vision/holistic_landmarker)（MiPo 用的 Holistic；macOS arm64 wheel 已确认 39.6MB）

**macOS 原生 / 2026 文本生成**
- Apple Vision 3D body pose：[DetectHumanBodyPose3DRequest 文档](https://developer.apple.com/documentation/vision/detecthumanbodypose3drequest)
- Kimodo（NVIDIA 文本→运动，2026）：[项目页](https://research.nvidia.com/labs/sil/projects/kimodo/)、[arXiv 2603.15546](https://arxiv.org/abs/2603.15546)

---

## 附录 A. 本轮探针方法与结果（可复现）

### A.1 macOS 原生 Vision 3D body pose（零依赖）

文件：`tests/tmp/mocap-eval/vision3d_pose.swift`（约 130 行，只用 Vision/AVFoundation/CoreGraphics/ImageIO）。

```bash
cd tests/tmp/mocap-eval
swiftc -O vision3d_pose.swift -o vision3d_pose
./vision3d_pose image ref_frame_48.png                      # 官方半身 GIF 帧
./vision3d_pose video human_sample.mp4 313 1                # 313 帧逐帧
```

| 测试 | 结果 |
|---|---|
| 真人视频（GVHMR 仓库示例 `tennis.mp4`，10.445s） | 313 帧采样 → **309 帧检出（98.7%）**；总耗时 **34.72s（CPU，≈9 帧/s）** |
| 负样本（随机色块图） | **未检出**（说明不是「永远返回结果」） |
| 官方半身特写 GIF 帧 | **检出 17 关节、confidence=1.0**，但下半身为脑补 → **检测器过置信** |
| 官方全身立绘/本模型渲染图 | 检出 17 关节 |
| 关节集合 | 17：`root/spine/center_shoulder/center_head/top_head` + 左右 `shoulder/elbow/wrist/hip/knee/ankle`；**无脚趾、手指、颈** |
| 坐标约定 | 相对 root 的米制坐标、Y-up；`bodyHeight` 恒 1.8（归一化骨架） |

**含义**：本机完全可以零安装地产出 3D 关节；但「17 关节 + 无脚部接触」决定了它只能做兜底，不能替代 MiPo（33 点 body+双手 21×2+面部）。

### A.2 Reze MiPo 本机可运行性（arm64）

```bash
cd /tmp && git clone --depth 1 https://github.com/AmyangXYZ/MiKaPo && cd MiKaPo
npm ci            # 561MB node_modules；exit 0
npm run build     # Next 16.3.3（Turbopack）；Compiled successfully；TypeScript 通过；BUILD_EXIT=0
npm run start     # :3000 返回 HTTP 200；headless Chrome 可加载 DOM
```

源码核对（作为上文的依据）：
- `src/lib/vmd.ts`：`VMD_FPS = 30`、线性插值手柄、`センター` 竖直位移、IK 开关帧（`左足ＩＫ/右足ＩＫ enabled=false`）、关键帧精简、Savitzky-Golay；
- `src/lib/pose-worker.ts`：MediaPipe `HolisticLandmarker` 在 Web Worker；模型自托管 `holistic_landmarker.task`（public，13MB）；**wasm 从 jsDelivr CDN 拉**（`FilesetResolver.forVisionTasks("https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.32/wasm")`）→ 离线使用需改成自托管；
- `src/components/motion-capture.tsx`：`<input type="file" accept="video/*,image/*">` 上传视频/图片；`<input ... webkitdirectory>` 上传 PMX 目录；按视频自身时钟逐帧 30fps；
- `src/lib/assets.ts`：`next dev` 用本地 `public/`，生产构建读 `https://assets.reze.one/demo/mikapo`（我们本地开发无需外网资源）；
- `harness/record.mjs`：作者自带 **headless Chrome 录制 landmarks 的 harness**（可复现实验），但依赖 `ffmpeg/ffprobe`（本机暂无）→ 若要完全无界面批处理，需要补 ffmpeg 或改造。

### A.3 配额测算脚本

`tests/tmp/mocap-eval/quota_math.py`（本机 python3 直接跑）→ 输出见 §6。

### A.4 reze-rig CLI 端到端实测（Lead 在本机 macOS arm64 执行，2026-11-08）

**环境**：只装 2 个 npm 包（`reze-engine@0.68.10` MIT + `esbuild`）的最小目录；`lib/fbx.ts` 需要 `pako`（完整 `npm install` 会自动带）。
**打包**（一次成功，bundle 1.7MB）：

```bash
node_modules/.bin/esbuild scripts/fbx2vmd.ts --bundle --platform=node --format=esm --outfile=/tmp/fbx2vmd.mjs
```

**转换**（target 用本项目的 PMX，仓库自带样例 FBX）：

```bash
node /tmp/fbx2vmd.mjs public/fbx/{Idle,Taunt,Arms\ Down,Run_Lfoot}.fbx \
  --target-pmx "<我们的 PMX>" --in-place --out tests/tmp/motions/converted
```

**日志关键行**：
```
target skeleton: measured from ...
[retarget] "mixamo.com": Mixamo, scale=0.1278, 51 mapped (47 aligned)
[retarget] "Mvm_Idle": UE/Unity, scale=0.1360, 51 mapped
```

**结果**：
- **4/5 成功**；`Humanoid_F.FBX` 无 animation clip（属正常，不是失败）。
- 产物：`Idle.vmd` 533KB / `Taunt.vmd` 504KB / `Run_Lfoot.vmd` 123KB / `Arms Down.vmd` 12KB。
- mmd-parser 1.1.4 解析：**54 条骨轨道，54/54 全部命中本模型骨骼名（0 missing）**；含 `左足ＩＫ/右足ＩＫ` 脚 IK 帧。
- `センター` 位移在 ±1 内 → `--in-place` 生效。
- 样例源 FBX 无 blendshape → 样例产物无 morph（Rokoko/Mixamo 带表情通道的 FBX 才可验 morph 链路）。
- 视觉观感：**独立 three.js r171 预览器（vmd-viewer 队友）正在出接触表，结论待 Lead 转达**；本文 §5.1 的 `helper.enable('ik', …)` 对照表就是为这一步准备的接入说明。

**复现命令（最小）**：
```bash
mkdir -p /tmp/reze-cli && cd /tmp/reze-cli && npm init -y && npm i reze-engine@0.68.10 esbuild pako
git clone --depth 1 https://github.com/AmyangXYZ/reze-rig /tmp/reze-rig
cd /tmp/reze-rig && cp -r scripts lib /tmp/reze-cli/   # 或直接在 clone 里 npm i
node /tmp/reze-cli/node_modules/.bin/esbuild scripts/fbx2vmd.ts --bundle --platform=node --format=esm --outfile=/tmp/fbx2vmd.mjs
```

---

## 附录 B. 与其它文档的关系（避免重复）

| 文档 | 覆盖内容 | 本文不重复的部分 |
|---|---|---|
| `docs/anim-tech-survey.md` | B3 程序化姿态、MMD 骨骼/坐标系/grant 实测、VPD 工作流、表情系统 | 本文只引用其结论（A-pose、D 链权重、骨名规则） |
| `docs/research/motion-assets.md`（motion-hunt） | 现成 MMD VMD/VPD 动作包下载与解析、官方动作转换 | **若能直接找到可用 VMD，优先级高于本文所有管线** |
| `docs/research/tooling-blender.md`（task-4） | Blender 4.2 + MMD Tools 无头摆姿/渲染/VPD 导出 | 本文的「无 Blender」路线与它互补；管线 B 若 CLI 失败可回归 Blender |
| `docs/research/vmd-preview-tool.md`（task-5） | VMD/VPD 预览器、兼容性检查、截图 | 本文建议的验证手段依赖它 |
