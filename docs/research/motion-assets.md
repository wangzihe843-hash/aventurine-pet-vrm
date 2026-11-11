# MMD 动作资产调研（VMD / VPD）：可直接用于「砂金·戏浪」的待机/走路/坐姿/反应

> 任务：B3 动作来源（task-2）。Wave2 程序化姿态被否决后，本报告核实「能直接拿来用的动作包」。
> 调研日期：2026-11-08。作者：motion-hunt（团队动作资产猎手）。
> 产物目录：`tests/tmp/motions/`（**gitignore（`.gitignore` 第 17 行 `tests/tmp/`），未入 tracked 路径，不再分发**）。
> 模型：`assets/model/星穹铁道—砂金·戏浪.pmx`（PMX 2.0，382 骨、标准 MMD 日文骨名、A-pose、高 21.681 单位）。
> 播放端：three.js r171 `MMDLoader` / `MMDAnimationHelper`（原生支持 VMD 动作 + VPD 姿势）。

---

## 0. 一页结论（TL;DR）

| 问题 | 结论 |
|---|---|
| **有没有「下载即用」的免费 VMD 待机/走路/坐姿？** | **基本没有。** 现存免费 VMD 配布几乎全部需要「登录账号 / 下载键 / 失效 / 网盘会员」之一；且绝大多数是**舞蹈**而非宠物态动作。能直接下载并解析验证的 VMD/VPD 只有 three.js 官方示例（舞蹈）与 GitHub 上的无授权声明收藏（舞蹈/走路），**授权都不允许再分发**。 |
| **最靠谱的「买到即可用」路线是什么？** | **BOOTH「モーションパッケージ」系列（デジタルモーション株式会社）**：第 91 弾「自然に待機する男性」¥2,000 / 20 个待机；第 22 弾「クール男性待機モーション」¥2,000 / 20 个待机（含片膝跪）。条款明确允许**自由改変 + 个人商用（署名）**，仅禁「可提取形式的二次配布」→ 买来转 VMD、本机自用完全合规。格式是 **FBX 30fps Humanoid**，需 FBX→VMD（`reze-rig`，MIT，浏览器内完成；本工作区并行管线 `scripts/anim-pipeline/` 已实测跑通）。 |
| **免费 + 授权干净 + 能转的** | **名もなきモーション（東映ツークン研究所，BOOTH zukun-lab）**：12 个免费样本（¥0，含「立っている人③(若者/男性)」「ごあいさつをするモブ」= 反应/挥手），**FBX 60fps + BIP，VICON/HumanIK**；但 BOOTH 下载**必须登录 pixiv 账号**，且需转 VMD。 |
| **砂金官方动作有 VMD 配布吗？** | **没有官方配布。** 找到 2 个 B 站同人「砂金动作配布」：BV1uv421y7v9（木木中人，微云链接+密码，**需微云登录**）、BV1WE421M7ac（小王动画制作，爱发电付费）。官方游戏动作只能从游戏本体提取（Windows，SRStudio 类工具 + Blender/reze-rig），macOS 用户本机不具备条件 → 列为条件性可选项。 |
| **哪些文件真的下载并解析过了？** | 5 类共 21 个文件：three.js r171 `wavefile_v2.vmd`（93.6s 舞蹈）+ 11 个 VPD、`bear0830/mmd` walk/1.vmd、`blender_mmd_tools` 测试夹具 VMD/VPD、以及工作区并行管线产出的 4 个 Mixamo→VMD（Idle/Taunt/Run_Lfoot/Arms Down）。**关键好消 息**：这些 VMD 的标准人形骨覆盖率 23–27/29，**Mixamo→VMD 产物 54/54 轨全部命中本模型骨骼**，`Idle.vmd`（3.00s / 90 帧循环）可直接播放。 |
| **授权底线** | 所有动作文件**只能本机个人自用、不得再分发/再嵌入分发**（项目模型本身也禁止二次配布）。报告与产物仅在 `tests/tmp/`，未 commit。 |

**一句话建议**：让用户花 ¥2,000 买 BOOTH 第 91 弾（男性待机 20 个）→ `reze-rig` 转 VMD → `MMDLoader` 播；同时用工作区已有的 `converted/Idle.vmd`（3s）先打通 MMD 动画通道做最小验证。砂金专属动作等用户登录微云确认 BV1uv421y7v9 的配布内容。

---

## 1. 调研范围与方法

### 1.1 关键词（中文 / 日文 / 英文都试过）

- 中文：`MMD 动作配布`、`动作配布 VMD`、`待机动作 配布`、`走路 动作配布`、`坐 动作配布 MMD`、`砂金 动作配布`、`砂金 MMD 动作`、`崩坏星穹铁道 动作 VMD`、`模之屋 砂金`、`流云景 砂金`。
- 日文：`MMD モーション配布`、`待機モーション`、`歩行モーション 配布`、`座り モーション 配布`、`モーションパッケージ 男性`、`名もなきモーション`、`立ちモーション`。
- 英文：`free MMD motion VMD download`、`MMD motion pack idle walk`、`Aventurine MMD motion`、`humanoid FBX to VMD`。

### 1.2 渠道覆盖与可访问性实测

| 渠道 | 结果 |
|---|---|
| **BOOTH**（`booth.pm` / `motionpackage.booth.pm` / `zukun-lab.booth.pm`） | ✅ 页面/商品信息可抓（含 ld+json、价格、完整利用規約）；**下载必须登录 pixiv 账号**（免费商品也一样）。 |
| **BowlRoll**（`bowlroll.net`） | ✅ 文件页可抓；页面内嵌 `data-download_control` 状态：`login`（需登录）/ `permission`（需下载键）/ `expired`（已失效）。下载 API `/api/file/{id}/download-check` 有反爬（缺 `freepass_bidder` cookie 时返回 `download_key` 错误）→ 只能人工浏览器下载。 |
| **ニコニ・コモンズ**（`3d.nicovideo.jp`） | ⚠️ 页面可访问；下载需 niconico 账号（本报告未登录，未实际取文件）。 |
| **GitHub**（repo 搜索 + 文件树） | ✅ 可用 `git clone --depth 1 --filter=blob:none --no-checkout` 列文件树（绕开已耗尽的 `api.github.com` 限额），`raw.githubusercontent.com` 可直接下 VMD/VPD。 |
| **Bilibili**（视频简介/置顶评论） | ✅ 视频信息 API 与评论 API 可用，能从简介/置顶评论提取「网盘/微云/爱发电/BowlRoll 链接+提取码」；搜索页 HTML 可解析（搜索 API 返回 -352）。 |
| **微云 / 夸克 / 百度网盘** | ❌ 页面可访问，下载需登录/客户端（微云分享页为 JS 壳，需账号）。 |
| **VPVP wiki**（`w.atwiki.jp/vpvpwiki`） | ❌ Cloudflare 403（脚本/浏览器可过，本环境不行）。 |
| **Fantia / 爱发电** | ⚠️ 内容页可看，取文件需账号/付费。 |
| **mixamo.com** | ⚠️ 需 Adobe 账号（本报告未登录；已有第三方转换产物可验证路线，见 §4.4）。 |

---

## 2. 候选清单（含许可证与获取门槛）

> 「适配度」按：①标准 MMD 日文骨名 ②是否能覆盖 382 骨模型的标准人形骨 ③男性/少年体适配 ④是否需要转换。**授权列的每一条都请以原页面为准**（链接均已给出）。

### 2.1 免费、可直接下到文件的（已真实下载并解析，见 §3）

| # | 名称 / 内容 | 来源 URL | 作者 | 格式 / 大小 | 授权要点（原文摘要） | 适配度 |
|---|---|---|---|---|---|---|
| A1 | three.js 官方示例动作 `wavefile_v2.vmd`（93.63s 舞蹈「WAVE」，140 轨 / 31 morph） | [three.js r171 examples/models/mmd](https://github.com/mrdoob/three.js/tree/r171/examples/models/mmd) | three.js 示例资产（舞踏数据来自 niconico `sm13147122`） | VMD，1,601,247 B | **非 MIT**。目录 [Readme.txt](https://raw.githubusercontent.com/mrdoob/three.js/r171/examples/models/mmd/Readme.txt)：MMD 资产无统一许可，须回原始压缩包读 readme；「Most MMD assets are NOT allowed for redistribution / commercial use」。**仅本地研究，不可再分发**。 | 骨 23/29 标准、morph 22/31 在本模型存在；是舞蹈，需裁片段 |
| A2 | three.js 官方示例姿势 `01–11.vpd`（11 个，各 93 骨） | 同上 `examples/models/mmd/vpds/` | 同上（初音ミク姿势） | VPD（Shift-JIS），11×~12KB | 同上，**非 MIT、不可再分发** | 60/93 骨命中；`09/10.vpd` 有 ~140° 屈膝（坐/跪姿参考） |
| A3 | `bear0830/mmd`：`walk.vmd` + 24 个舞蹈 VMD | [github.com/bear0830/mmd](https://github.com/bear0830/mmd) | bear0830（Vocaloid 动作收藏） | VMD，walk 490,971 B；其余 0.1–4.3 MB | **仓库无 LICENSE、README 未声明授权** → 默认保留所有权利，**不可再分发**；仅本地解析/测试用 | walk：26/29 标准骨、足 IK 轨、原地（见 §3） |
| A4 | `blender_mmd_tools` 测试夹具 `samples/vmd/test.vmd`、`samples/vpd/test.vpd` | [github.com/MMD-Blender/blender_mmd_tools](https://github.com/MMD-Blender/blender_mmd_tools) | MMD-Blender（GPL-3.0 代码库） | VMD 146,150 B / VPD 24,676 B | 代码 GPL-3.0；样本夹具仅作**解析器测试**用，不作资产 | 27/29 标准骨；含大量 FBX rig 转换后的非标准骨（见 §3） |

### 2.2 免费 VMD 配布站（文件在站上，下载需账号/下载键/已失效——**需用户操作**）

| # | 名称 / 内容 | URL | 状态（实测） | 备注 |
|---|---|---|---|---|
| B1 | 「MMD走路动作」by Lct（bilibili BV1uW411M7pm 简介：`dl: bowlroll.net/file/163009 pass:2323`） | [bowlroll.net/file/163009](https://bowlroll.net/file/163009) | ❌ `data-download_control=expired`（已失效） | 走路动作，原配布页已关闭 |
| B2 | 「[MMD]ｸﾞﾙｸﾞﾙ待機モーション」（待机） | [bowlroll.net/file/195206](https://bowlroll.net/file/195206) | ⚠️ `permission`、`download_key=false`；API 下载被反爬拦截 | 浏览器人工可试；待机候选 |
| B3 | 「ヤンキー座り MMDモーション」（不良坐姿） | [bowlroll.net/file/324696](https://bowlroll.net/file/324696) | ⚠️ `login`（需 BowlRoll 账号） | 坐姿候选 |
| B4 | 「もーいいかい モーション」 | [bowlroll.net/file/277348](https://bowlroll.net/file/277348) | ⚠️ `login` | 简介注明「转载不提供，原网址查询」 |
| B5 | 「メズマライザーモーション Ver1.1a」by 鈴守頼貞 | [bowlroll.net/file/323914](https://bowlroll.net/file/323914) | ⚠️ `permission` + `download_key=true`（键在原视频页） | 舞蹈 |
| B6 | ニコニ・コモンズ（MMD 动作最大配布渠道） | `https://3d.nicovideo.jp/` | ⚠️ 下载需 niconico 账号 | 分类含待機/歩行/座り 等 |
| B7 | **名もなきモーション** 免费样本（12+ 个） | [namonaki.motion.toei.co.jp/home/for-free](https://namonaki.motion.toei.co.jp/home/for-free)、[免费商品列表](https://zukun-lab.booth.pm/item_lists/8GXT3eL0) | ⚠️ ¥0，但 **BOOTH 下载需登录** | 见 §2.4 详情（含**男性站立样本**） |

### 2.3 付费但授权最清晰（FBX，需转 VMD）

| # | 名称 / 内容 | URL / 价格 | 格式 | 授权要点（原文摘要，逐条） | 适配度 |
|---|---|---|---|---|---|
| C1 | **モーションパッケージ第 91 弾「自然に待機する男性」**（20 个待机） | [booth.pm/ja/items/8304365](https://booth.pm/ja/items/8304365) / **¥2,000** | FBX 30fps + unitypackage；OptiTrack 采集；Humanoid 骨结构 | 版权归 デジタルモーション株式会社；**允许**：自由改変、禁止事项外的自由使用、VRChat、视频内容、**个人商用（需署名，YouTube 广告收入 OK）**；**禁止**：以可提取状态二次配布、宗教政治用途、违法/侵权、性暴力内容；法人中規模以上商用需咨询。→ **本地桌宠可用；转 VMD 属「改変」，允许；但动作文件不可随 app 分发** | 男性待机 20 个（両腕おろし/腕組み/腰に手/伸び/時間を気にする/髪型を直す/イライラ 等），**最贴需求** |
| C2 | **モーションパッケージ 第 22 弾「クール男性待機モーション」**（20 个待机） | [booth.pm/ja/items/8303253](https://booth.pm/ja/items/8303253) / **¥2,000** | 同上 | 同上（同一作者/同一规约） | 含「腕を組む」「ネクタイを直す」「**片膝をついて膝まづく（BK_18）**」「銃を撃つ」等，可作 sit/跪姿素材 |
| C3 | デジタルモーション BOOTH 商店（系列已出到 91 弹+） | [motionpackage.booth.pm](https://motionpackage.booth.pm/) | FBX | 同上（系列统一规约） | 商店搜索页显示「歩行」相关 24 件、「座り」相关 30 件（含其他作者/其他系列）；**未能逐个确认「男性走路/男性坐姿」具体条目**（BOOTH 搜索页由 JS 渲染，HTML 无商品链接）→ 需用户登录后按分类翻 |
| C4 | ニコニ・コモンズ / Fantia 上其他作者的 VMD 动作包 | — | VMD | 逐作者条款，需逐个确认 | 未逐个核实 |

### 2.4 名もなきモーション（東映ツークン研究所）免费样本详情

- **商品**：【サンプル】【#0】立っている人③(若者/男性)【モブ用モーション】，**¥0**，[zukun-lab.booth.pm/items/5942446](https://zukun-lab.booth.pm/items/5942446)。
- **格式**：FBX（**60fps** 关键帧，另附 24fps 关键帧）+ **BIP**（3ds MAX）；「人型 3D モデル付のアニメーション」「Autodesk HumanIK 準拠の一般的な命名規則構造の骨ツリー、HumanIK セットアップ済」；VICON 光学式采集；**首尾平滑、已做循环处理**。
- **免费样本清单**（页面文字）：立っている人③(若者/男性)、すごい速さで回るモブ、塁上でポーズを決めるモブ、すごい見てくるモブ、蚊に刺されて痒そうなモブ、現実逃避したいモブ、会議中に踊るモブ、熱狂的ファンなモブ、ケーキを運ぶモブ、ろうそくの火を消すモブ、**ごあいさつをするモブ（打招呼=反应/挥手候选）**、重い荷物を運ぼうとするモブ、バレンタインのモブ（实际 12 个左右）。
- **授权**：使用 **VN3 许可模板**（`https://www.vn3.org/`，日本语优先），四语全文 PDF：[日本語](https://drive.google.com/file/d/1_kRn7uJpXhXw3shG3J67PKpCPDhlkuDf/view)、[English](https://drive.google.com/file/d/1On-pn4uy5xGpplFies8exPiJFPPNEXaa/view)、[한국어](https://drive.google.com/file/d/16JSaiL5ujwJlQ4B5eVl7AzmqXIivincN/view)、[中文](https://drive.google.com/file/d/10WgG-G8oOcBPObIfoupU8y0znqmtG8V7/view)。**本报告已下载中文 PDF（4 页）但 PDF 为 CID 字体，无法可靠提取文本 → 具体条款需人工阅读**（VN3 模板通常允许个人使用/视频利用、禁再配布/转售，但请以 PDF 为准）。
- **付费套装**：官网分类含 `座り / 立ち / 歩き / 走り / ジャンプ / 会話 / 拍手 / ダンス / 街中 / 交通機関 / …`（[官网](https://namonaki.motion.toei.co.jp/)），属付费套装（价格需登录 BOOTH 查看）。

### 2.5 砂金专项（官方 / 同人）

| # | 内容 | URL | 获取门槛 | 备注 |
|---|---|---|---|---|
| D1 | **【动作配布】不眠之夜-完整版-砂金入池考核**（B 站 UP：木木中人，2024-02） | [BV1uv421y7v9](https://www.bilibili.com/video/BV1uv421y7v9) → 配布：`https://share.weiyun.com/zQxZHodg` **密码 [已脱敏]**（UP 置顶评论） | ❌ 微云下载需 QQ/微信账号或客户端 | **最贴砂金的动作线索**；文件类型未验证（疑 VMD/MMD 工程）。用户登录后可确认 |
| D2 | **砂金PUBG爱的主打歌动作配布**（B 站 UP：小王动画制作，动作自制/爱发电配布） | [BV1WE421M7ac](https://www.bilibili.com/video/BV1WE421M7ac) → 爱发电 [afdian.net/a/xiaowangdongzuo](https://afdian.net/a/xiaowangdongzuo) | ❌ 爱发电需登录/付费 | 舞蹈类；作者自述「模型来自 miHoYo/流云景/观海/神帝宇」 |
| D3 | 官方游戏动作提取路线 | — | ⚠️ 需 **Windows + 游戏本体** + [SRStudio](https://github.com/Sycamore0/SRStudio)（HSR 版 AssetStudio，可导出模型/动画）→ Blender/reze-rig → VMD | **无官方 VMD 配布**；macOS 本机无游戏文件，判为条件性可选项 |
| D4 | 模型来源（动作不含）：模之屋 aplaybox（流云景 / 观海 / 神帝宇等） | `https://www.aplaybox.com/` | 需登录 | 模之屋只发模型不发动作；BV1WE421M7ac 的模型借物表可交叉验证 |

### 2.6 重定向类备选（需 humanoid→MMD 转换，非主结论）

| # | 来源 | 内容 / 数量 | 授权 | 成本 |
|---|---|---|---|---|
| E1 | **Mixamo**（Adobe） | 数千个 humanoid FBX 动作（Idle/Walking/Run/Taunt/…） | Adobe 条款：可免费用于个人/商业项目，**禁止再分发原始动画文件** | 需 Adobe 账号；用 **`reze-rig`（MIT，浏览器内上传动画→PMX 预览→下载 VMD）** 转换。工作区并行管线已实测跑通（§4.4） |
| E2 | **YUI**（`github.com/yw0nam/YUI`，桌面 VRM 桌宠） | `public/motions/` **49 个 `.vrma`**：`idle_01..13`、`walk`、`sit_01..05`、`suwari1/3`、`happy`、`laugh`、`embarrassed`、`sheepish`、`calm`、`head_pat`（复用 idle_10）、`drag`、`jump`、`peek`、`climb_*`、`dance_01..13` | 代码 **PolyForm Noncommercial 1.0.0**；LICENSE 明确：「This license covers YUI's own source code only. Bundled motion assets (`public/motions/*.vrma`) … remain subject to its original author's license」；[docs/guide/motions.md](https://github.com/yw0nam/YUI/blob/main/docs/guide/motions.md) 显示来源为 **Mate-Engine（PET_IDLE/PET_HAPPY…，© Shiny，不可再配布）与 Mixamo** → **授权链不干净，不可搬用** | .vrma 是 glTF binary + `VRMC_vrm_animation` 扩展；转 MMD 需 humanoid 重定向。**仅作动作语义/时长参考** |
| E3 | **Mate-Engine** | 109 个非舞蹈 `.anim`（Unity Humanoid muscle） | MateEngine Pro License v2.1：个人/教育非商业可用、需署名、**不得单独再分发** | 详见 [docs/anim-reference.md](../anim-reference.md)、PLAN §11.1；需 Unity + bake + humanoid→MMD 重定向，几天级工程 |
| E4 | CMU MoCap / AMASS / BVH 数据集 | 大 | 学术许可（AMASS 还含各数据集条款） | 需重定向（`bvh-to-vmd` 等工具），质量风格偏真人，宠物化需重调 |

---

## 3. 真实下载与解析验证（mmd-parser 1.1.4）

**解析脚本**：`tests/tmp/motions/analyze-motions.mjs`（本任务新写，可复跑）
**解析器**：项目 `node_modules/mmd-parser@1.1.4`，与 three.js r171 `MMDLoader` 内置 `jsm/libs/mmdparser.module.js` 同一套逻辑。
**模型骨清单**：`tests/tmp/bones.json`（382 骨；唯一名 381，重名 `后碎髮9`×2；4 个 IK：`右足ＩＫ/右つま先ＩＫ/左足ＩＫ/左つま先ＩＫ`；26 个 grant（16 个骨带 grantedBy））。
**结果文件**：`tests/tmp/motions/analysis.json`（21 条记录）。

复跑命令：

```bash
cd tests/tmp/motions && node analyze-motions.mjs          # 扫描本目录全部 .vmd/.vpd
node analyze-motions.mjs path/to/foo.vmd                  # 单个文件
```

### 3.1 下载清单与校验

| 文件（`tests/tmp/motions/` 下） | 大小 | SHA-256 前 16 位 | 来源 |
|---|---:|---|---|
| `threejs_r171/wavefile_v2.vmd` | 1,601,247 B | `9cf9264ccbefcc2c` | raw.githubusercontent three.js `r171` |
| `threejs_r171/wavefile_camera.vmd` | 4,336 B | — | 同上 |
| `threejs_r171/vpds/01–11.vpd` | 11×~12 KB | — | 同上 |
| `bear_walk.vmd` | 490,971 B | `c96c1ae5c03b2678` | raw.githubusercontent bear0830/mmd |
| `bear_1.vmd` | 2,346,449 B | `a531dd56675b8927` | 同上 |
| `fixtures/blender_mmd_tools_test.vmd` | 146,150 B | `0e85c7df4aa8f777` | raw.githubusercontent MMD-Blender/blender_mmd_tools |
| `fixtures/blender_mmd_tools_test.vpd` | 24,676 B | `ef99eb540e382767` | 同上 |
| `converted/{Idle,Taunt,Run_Lfoot,Arms Down}.vmd` | 12–546 KB | — | **并行管线产物**（`scripts/anim-pipeline/`，非本任务写入；见 §4.4） |

均只落在 `tests/tmp/`（gitignored，`git check-ignore` 已验证），**未 commit、未放 tracked 路径**。

### 3.2 VMD 解析结果

| 文件 | 时长@30fps | 骨帧/轨 | morph | 标准骨 | 命中本模型 | 足 IK 轨 | センター位移 | 结论 |
|---|---:|---:|---:|---:|---:|---|---|---|
| `threejs_r171/wavefile_v2.vmd`（初音ミク） | 93.63 s（帧 0–2809） | 14,160 / 140 | 31（1,279 帧） | **23/29** | 81/140（57.9%） | 有（左右足ＩＫ+つま先ＩＫ） | Δx9.15 Δy3.93 Δz14.8（舞蹈位移大） | **能播**；内容为 WAVE 舞蹈，需裁剪「挥手」片段；morph 22/31 在本模型存在 |
| `bear_walk.vmd`（十六夜咲夜） | 38.17 s（帧 0–1145） | 4,322 / 262 | 225（485 帧） | **26/29** | 70/262（26.7%） | 有（左右足ＩＫ，IK 位移 dz≈9.6） | Δx0 Δy0.62 Δz0.09 → **原地** | 走/跑循环（含多段），最像「走路包」；大量非本模型骨（头发/裙/泪/表情骨）会被忽略 |
| `bear_1.vmd`（DIVA風ミク） | 208.33 s（帧 0–6250） | 20,657 / 165 | 34 | **23/29** | 67/165（40.6%） | 有（4 轨） | Δx38.5 Δy8.1 Δz3.9（全场舞蹈） | 长舞蹈，仅作 walk/idle 片段裁切候选 |
| `fixtures/blender_mmd_tools_test.vmd` | 0.80 s（帧 0–24） | 1,316 / 188 | 0 | **27/29** | 79/188（42%） | 有（含足IK親） | Δ0 → 纯姿势 | 工具链测试夹具；非标准骨（`FSkirt_*`/`Hair*`/`boneXXXX`）说明「FBX rig 直转 VMD 会带一坨非 MMD 骨名」 |
| `converted/Idle.vmd` | **3.00 s（帧 0–90）** | 54 轨 | 0 | 22/29 | **54/54（100%）** | 有（左右足ＩＫ） | Δx0.33 Δy0.09 | **直接可播**（Mixamo Idle；循环待机） |
| `converted/Taunt.vmd` | 2.83 s（帧 0–85） | 54 轨 | 0 | 22/29 | **54/54（100%）** | 有 | Δx0.73 Δy0.51 Δz0.94 | **直接可播**（反应/挑衅动作） |
| `converted/Run_Lfoot.vmd` | 0.67 s（帧 0–20） | 54 轨 | 0 | 22/29 | **54/54（100%）** | 有 | Δy0.66 | **直接可播**（跑步循环；不是走路） |
| `converted/Arms Down.vmd` | 0.03 s（帧 0–1） | 54 轨 | 0 | 22/29 | **54/54（100%）** | 有 | Δ0 | 单帧姿势（T/A-pose 过渡辅助） |

> **解析器行为要点（对「直接用」很关键）**：`mmd-parser@1.1.4` 与 three r171 内置解析器都只读 VMD 的 **motions → morphs → cameras** 三段；VMD 0002 在 cameras 之后还有 light/shadow/**IK solver（IK ON/OFF）** 段，二者**都不解析**。因此：①three 端脚 IK 是否生效取决于 `MMDAnimationHelper` 的 `params.ik`（默认 true）与模型 IK 定义；②若动作依赖 VMD 内 IK 开关切换（步行动作常见），three 端不会读到 → 可能需要手动补 IK 或改用 baked（已烘焙骨骼）动作。`converted/*.vmd` 属 baked 类，无此问题，更稳。

### 3.3 VPD 解析结果

| 文件 | 编码 | 父模型 | 骨数 | 命中本模型 | 内容判读 |
|---|---|---|---:|---:|---|
| `threejs_r171/vpds/01–11.vpd` | Shift-JIS | `初音ミク.osm` | 93 | 60/93（64.5%） | 初音ミク姿势集；`09.vpd`/`10.vpd` 屈膝 ~139–145°、センター旋转 120–178° → **坐/跪姿参考姿势**；`11.vpd` 接近中性站姿 |
| `fixtures/blender_mmd_tools_test.vpd` | Shift-JIS | `4.5A3_arm.osm` | 188 | 79/188（42%） | 工具链姿势夹具；同样带非标准骨 |

> VPD 通道确认可用：r171 `MMDLoader.loadVPD(url, isUnicode, …)`（[MMDLoader.js L353](../../node_modules/three/examples/jsm/loaders/MMDLoader.js)）→ `parser.parseVpd(text, true)` → `MMDAnimationHelper.pose(mesh, vpd, {resetPose, ik})`（[MMDAnimationHelper.js L185](../../node_modules/three/examples/jsm/animation/MMDAnimationHelper.js)）。VPD 是**一次性姿态**，不是片段；可作坐姿/跪姿的关键帧插入。

---

## 4. 与本模型（382 骨）的兼容性分析

### 4.1 骨骼命名：**全部命中标准 MMD 人形骨**

- 模型 382 骨（唯一名 381，重名 `后碎髮9`×2），**标准人形骨 29/29 齐全**：`全ての親/センター/グルーブ/腰/上半身/上半身1/上半身2/首/頭/肩P/肩C/右肩/左肩/腕/ひじ/手首/下半身/足/ひざ/足首/つま先`。
- **脚 IK 命名符合 MMD 惯例**：`右足ＩＫ`（全角ＩＫ）用于 VMD 常规轨道，`右足IK親`（半角 IK）为父级；`右つま先ＩＫ` 同位。→ 网上标准 VMD 的足 IK 轨道**能直接对上**。
- 模型还带 `腕捩/手捩`（3 段）、`肩P/肩C`、`腰キャンセル右/左`、`足D/ひざD/足首D/足先EX` 链、`上半身3` 无（本体只有 上半身1/2），`グルーブ` 存在。
- **VMD 里出现但模型没有的骨会被 three 忽略**（`MMDLoader` 建 AnimationClip 时只匹配存在的骨名），不会报错；反过来模型有但 VMD 没动的骨保持 rest pose —— 这正是我们可以「套用异形模型动作」的基础。

### 4.2 IK / センター / 位移

- 模型有 **4 个 IK 定义**（`右足ＩＫ/右つま先ＩＫ/左足ＩＫ/左つま先ＩＫ`）+ **26 个 grant**（捩/肩/腰キャンセル/D 链）→ `MMDAnimationHelper` 默认 `ik: true, grant: true` 会自动处理。
- VMD 的足 IK 关键帧（`右足ＩＫ` 等平移轨道）在标准 VMD 里是**世界方向**目标位置，受模型腿长/比例影响；本模型高 **21.681**（标准 MMD 约 20），センター rest y=8.93 → 建议对足 IK 目标/センター位移做 **×1.084（21.681/20）** 或在 helper 外按比例调 offset，否则可能脚滑/穿地。
- 桌面宠物建议：**保留原地动作（idle/walk-in-place）**，位移由 B2 物理/窗口逻辑驱动；不要把 VMD 的 root motion 直接播。

### 4.3 表情 morph：标准 MMD 表情名大多存在

模型有 **85 个 morph**（82 顶点 + 3 材质，详见 [docs/model-morphs.md](../model-morphs.md)）。实测：

- `wavefile_v2.vmd` 用 31 个 morph，**22 个在本模型存在**（`真面目/困る/怒り/上/下/まばたき/笑い/ウィンク/ウィンク２/ウィンク右/はぅ/あ/い/う/え/お/…`）。
- `bear_walk.vmd` 用了 225 个 morph（含大量模型专用表情），**30 个命中**（`あ/い/う/え/お/まばたき/笑い/にやり/…`）。
- → 标准 VMD 的**眨眼/口型/笑い**能部分驱动本模型表情；模型专有表情不匹配的会被忽略，不会崩。

### 4.4 FBX→VMD 重定向路线已被工作区验证

`scripts/anim-pipeline/`（并行任务产物，非本报告写入）已用 Blender/Mixamo 管线产出 `tests/tmp/motions/converted/` 下 4 个 VMD：每文件 54 条骨骼轨道、**54/54 全部命中本模型骨名**、含 `右足ＩＫ/左足ＩＫ` 轨道、30fps 帧号、`Idle` 恰为 90 帧（3.00s）循环、center 位移很小 —— 这证明「外部 humanoid 动作 → VMD → 本模型直接播」链路可行且产物干净。另有 MIT 工具 **`reze-rig`（[github.com/AmyangXYZ/reze-rig](https://github.com/AmyangXYZ/reze-rig)，浏览器内上传 humanoid 动画、在 PMX 上预览、导出 VMD）** 可给用户/后续任务用；BOOTH/名もなき 的 FBX 均可用它转。

---

## 5. 砂金官方 / 专属动作：结论

1. **没有官方 VMD 配布**。米哈游不发行 MMD 动作；游戏内动作只能从客户端提取。
2. **同人配布有 2 个**（§2.5 D1/D2），都是舞蹈、且都落在需登录的网盘/爱发电——**这是「最贴角色」的动作来源，但需用户本人操作**。D1 微云文件若为 VMD/MMD 工程，价值最高（砂金同人 K 帧）。
3. **官方动作提取（条件性）**：HSR 客户端（Windows/Android）→ [SRStudio](https://github.com/Sycamore0/SRStudio)（AssetStudio 改版，可导出模型/动画）或 HoyoStudio 类工具 → FBX/anim → Blender（[ModelImporter](https://github.com/michael-gh1/Model-Importer) 类插件）/reze-rig → VMD。本机 macOS 无游戏本体，**不建议现在投入**；若用户有 Windows 或游戏文件，再评估。
4. **模型作者/来源**：模之屋（aplaybox）流云景等只发模型、不发动作（BV1WE421M7ac 借物表可佐证）。**不要期待「模型包里带动作」**。

---

## 6. Shortlist（≥5，覆盖 stand/idle/walk/sit/反应）

> 状态：✅=已真实拿到并解析验证；💰=需付费；🔑=需用户登录/下载键；🛠=需 FBX→VMD 转换；✂=需裁剪/拼接。

| 需求 | 首选 | 备选 | 状态 / 落地成本 |
|---|---|---|---|
| **待机/呼吸（stand-idle）** | **BOOTH 第 91 弾「自然に待機する男性」EB_01/EB_02**（20 个待机，¥2,000）→ reze-rig 转 VMD | ① 名もなき「立っている人③(若者/男性)」¥0（FBX 60fps，需登录 BOOTH）② 并行管线 `converted/Idle.vmd`（Mixamo Idle 3s，✅已解析） | ✅ 已有可播验证物（Idle.vmd）；💰+🛠 正式版 1 人日（转 20 个+挑 3–5 个） |
| **走路循环（walk）** | BOOTH 系列中「歩行」男性包（商店搜索显示 24 件相关，需登录确认具体条目）→ reze-rig | ① `bear_walk.vmd`（✅26/29 标准骨、原地、38s 多段，✂裁一段）② B 站 BV1dm411y72n 分享的 **5 组 Mixamo 走路 VMD**（🔑夸克网盘）③ 用户 Adobe 账号导 Mixamo Walking → reze-rig | ✅ 解析验证过走路 VMD 结构；💰/🔑 获取，🛠 转换 |
| **坐姿（sit）** | **BOOTH 第 22 弾 BK_18「片膝をついて膝まづく」**（¥2,000，跪姿）+ 需要普通坐姿时用 `threejs_r171/vpds/10.vpd`（✅初音ミク坐姿，60/93 骨，作骨架参考，✂按比例修正） | ① BowlRoll「ヤンキー座り」🔑登录 ② YUI `sit_01..05/suwari1/3`（仅参考，授权不干净） | ✅ VPD 已验证（可作一次性姿态/过渡帧）；💰 跪姿；普通坐姿暂无干净来源 |
| **反应/打招呼/摸头** | 名もなき「**ごあいさつをするモブ**」¥0（🔑BOOTH 登录，FBX 60fps）→ reze-rig | ① 并行管线 `converted/Taunt.vmd`（✅2.83s 直接可播）② `wavefile_v2.vmd` 里挥手片段 ✂（93.6s 舞蹈中 `手を振る` 段） | ✅ Taunt 已可播；¥0 样本需登录+转换 |
| **砂金专属动作** | **B 站 BV1uv421y7v9 微云配布** `share.weiyun.com/zQxZHodg`（密码 [已脱敏]） | B 站 BV1WE421M7ac 爱发电（🔑付费） | 🔑 需用户登录微云；未验证文件格式 |
| **待机（正式、可长期用）** | BOOTH 第 91 弾 20 个里挑 3–5 个（通常待機/かわいく待機/元気に待機/時間を気にしつつ待機） | — | 💰¥2,000 + 🛠转换 |

**「能直接用」vs「需要处理」速查**：

- **直接可播（零转换）**：`converted/{Idle,Taunt,Run_Lfoot,Arms Down}.vmd`（✅54/54 骨命中、baked、3s/2.8s/0.67s）；`threejs_r171/wavefile_v2.vmd`（能播但需✂裁挥手段）；`bear_walk.vmd`（能播但✂裁 1 个循环并忽略 200+ 非本模型骨）。
- **需转换（FBX 30/60fps → VMD）**：BOOTH 第 91/22 弾（💰）、名もなき免费样本（¥0、🔑）、Mixamo 自导（🔑）。
- **需重定向（VRMA / Unity .anim / BVH）**：YUI、Mate-Engine、CMU/AMASS —— vrm/humanoid → MMD 骨架（工作量 ≥1 人日/类）。
- **仅姿态（VPD）**：three.js `10.vpd`（坐姿）、`09.vpd`（跪姿）—— 只能当一次性 pose 或过渡帧，不能直接循环。

---

## 7. 获取步骤（需要用户亲自操作的清单）

### 7.1 BOOTH 付费（推荐，一次 ¥2,000）

1. 注册/登录 **pixiv / BOOTH** 账号（`booth.pm`），准备信用卡/PayPal/BOOST 余额。
2. 打开商品页购买：[第 91 弾「自然に待機する男性」](https://booth.pm/ja/items/8304365)（¥2,000）/ [第 22 弾「クール男性待機モーション」](https://booth.pm/ja/items/8303253)（¥2,000）；预览视频：91 弾 `https://www.youtube.com/embed/6je-eEPCWw0`、22 弾 `https://www.youtube.com/embed/kWrDOgfMck`。
3. 购买后从 BOOTH 订单页下载 ZIP（含 `FBX`（30fps Humanoid）+ `unitypackage` 样例场景），解压到 `tests/tmp/motions/booth/`（gitignored，**不要 commit**）。
4. 用 **reze-rig**（MIT，浏览器打开即可，无需安装）或本工作区 `scripts/anim-pipeline/`：导入 FBX → 选 PMX 模型 → 预览 → 导出 `.vmd` 到 `tests/tmp/motions/booth_vmd/`。
5. 复跑 `node analyze-motions.mjs booth_vmd/` 确认骨覆盖/帧数后，再对接 `MMDLoader.loadAnimation`。

### 7.2 BOOTH 免费（名もなき样本）

1. 登录 BOOTH → [免费商品列表](https://zukun-lab.booth.pm/item_lists/8GXT3eL0) → 下载「【サンプル】【#0】立っている人③(若者/男性)」等（¥0）。
2. 注意格式是 **FBX 60fps + BIP**：转 VMD 时需重采样到 30fps（`reze-rig` 或 Blender 时间缩放），并做站姿 rest-pose 校正。
3. 使用前请打开并阅读 [中文规约 PDF](https://drive.google.com/file/d/10WgG-G8oOcBPObIfoupU8y0znqmtG8V7/view)（本报告无法可靠解析 PDF 文本）。

### 7.3 BowlRoll / ニコニ・コモンズ（免费 VMD，但需账号/键）

1. 注册 **niconico** 账号（BowlRoll 部分文件要求登录）；打开候选文件页（§2.2）。
2. 页面若显示「ダウンロード鍵を入力」→ 在对应 niconico 视频简介/作者页找键（例：323914 的键在原视频 `sm44044507`）。
3. 下载后放 `tests/tmp/motions/bowlroll/`，跑解析脚本；同时**读文件内 readme/作者规约**（BowlRoll 无统一许可）。

### 7.4 微云 / 夸克 / 百度网盘（砂金配布 & Mixamo 走路 VMD）

1. 微云：`https://share.weiyun.com/zQxZHodg` → 登录 QQ/微信（网页或客户端）→ 输密码 `[已脱敏]` → 下载 → 放 `tests/tmp/motions/aventurine/`，确认是 `.vmd` 还是 MMD 工程（`.pmm`）。
2. 夸克（Mixamo 走路 5 组）：`https://pan.quark.cn/s/e8c9022fed76` → 登录下载 → `tests/tmp/motions/mixamo_walk/`。
3. 下载物**一律不进 tracked 路径**；确认内容后再决定是否值得买/转换。

### 7.5 可选：官方动作提取（需 Windows + 游戏本体）

1. Windows 机器安装/定位 HSR 客户端资源。
2. 用 [SRStudio](https://github.com/Sycamore0/SRStudio) 导出角色 anim（或 FBX）。
3. Blender（ModelImporter 类插件）导入 → 对齐 MMD 骨骼 → reze-rig 导出 VMD。

---

## 8. 授权与合规结论

| 资产 | 本地个人自用 | 改変/转 VMD | 再分发/嵌入 app 分发 | 商用 |
|---|---|---|---|---|
| three.js MMD 示例（A1/A2） | ✅ | ✅ | ❌（非 MIT，须回原始 readme） | ❌ |
| bear0830/mmd（A3） | ✅（研究/测试） | ✅ | ❌（无授权声明→默认保留） | ❌ |
| BowlRoll 各文件（B1–B5） | 以各页规约（多数允许个人/视频，禁再配布） | 视规约 | ❌ 大多禁止 | 视规约 |
| 名もなき（B7，免费/付费） | ✅（VN3 模板，需人工读 PDF） | ✅（改変一般允许） | ❌（VN3 通常禁再配布/转售） | ⚠️ 以 PDF 为准 |
| BOOTH モーションパッケージ 第 91/22 弾（C1/C2） | ✅ | ✅（明文「自由な本データの改変」） | ❌（明文禁「许可なく取り出せる状態で二次配布」） | 个人商用 ✅（需クレジット）；法人中规模以上需咨询 |
| YUI 动作（E2） | 代码许可不覆盖动作；动作来源为 Mate-Engine/Mixamo | — | ❌ | ❌ |
| Mixamo（E1） | ✅（个人项目） | ✅ | ❌（禁止再分发原始动画；转 VMD 后分发仍有风险） | ✅（项目内使用，不得转售动作本身） |
| 砂金同人配布（D1/D2） | 需作者规约 | — | ❌ | ❌ |

**统一底线（与项目现状一致）**：模型本身禁止二次配布，动作资产同样**只在本机开发/自用**；`tests/tmp/` 已 gitignore，本报告未 commit；交付物**不得**把 `.vmd/.vpd/.fbx` 放进 tracked 路径或随 app 打包再分发。

---

## 9. 未确认项与下一步建议

### 未确认（诚实标注）

1. **BV1uv421y7v9 微云配布的具体格式/内容**——需微云登录，未下载。
2. **BowlRoll 文件的实际内容/授权**——全部因登录/下载键/反爬未能取到文件。
3. **名もなき VN3 规约的具体条款**——PDF 为 CID 字体，脚本无法提取，需人工阅读。
4. **BOOTH 商店中「男性走路/男性坐姿」具体商品**——商店搜索页 JS 渲染，只拿到 2 个男性待机包与商店首页；需登录后按分类翻。
5. **VPD 坐姿（three.js `10.vpd`）直接套到本模型的实际观感**——未在 Electron 里渲染验证（只做骨骼/角度解析）。
6. **VMD IK ON/OFF 段**——解析器不读，实际脚部表现需在 app 里验证。

### 下一步（按性价比排序）

1. **先用 `converted/Idle.vmd`（3.00s，100% 骨命中、baked）在 app 里打通 MMD 动画通道**（最小验证：`MMDLoader.loadAnimation` + `MMDAnimationHelper`，确认 382 骨/IK/grant 正常），再谈采购。
2. **用户购买 BOOTH 第 91 弾**（¥2,000）→ reze-rig 批量转 20 个待机 → 挑 3–5 个做 idle/呼吸；这是「授权清晰 + 质量好 + 男性适配」的最优解。
3. **用户登录微云取 D1 砂金配布**——若能拿到 `.vmd`，优先验证；这最贴角色。
4. 走路：等用户 Adobe 账号导 Mixamo Walking（reze-rig 转），或买 BOOTH 歩行包；先用 `bear_walk.vmd` 裁一段做临时循环（仅本地）。
5. 坐姿：用 `threejs_r171/vpds/10.vpd` 做一次性坐姿骨架参考（不可分发），正式坐姿等 BOOTH 22 弾 BK_18 或名もなき 座り套装。
6. 若走 Mixamo/BOOTH 路线：确认 `MMDAnimationHelper` 参数（`ik:true, grant:true, physics:false`）与模型身高比 **×1.084** 的脚 IK 修正。

---

## 附录 A. 产物与复跑命令

```
tests/tmp/motions/                      # 全部 gitignored（.gitignore:17 tests/tmp/）
├── analyze-motions.mjs                 # 本任务写的 VMD/VPD 解析+骨比对脚本（mmd-parser 1.1.4）
├── analysis.json                       # 21 条解析结果（本报告 §3 数据来源）
├── threejs_r171/
│   ├── wavefile_v2.vmd                 # three.js r171 官方示例动作（93.63s 舞蹈）
│   ├── wavefile_camera.vmd
│   └── vpds/{01..11}.vpd               # three.js r171 官方示例姿势（初音ミク）
├── bear_walk.vmd / bear_1.vmd          # bear0830/mmd（无授权声明，仅解析测试）
├── fixtures/blender_mmd_tools_test.{vmd,vpd}
├── converted/                          # 并行管线产物（非本任务写入，Mixamo→VMD）
│   └── {Idle,Taunt,Run_Lfoot,Arms Down}.vmd
└── （待用户下载）booth/ bowlroll/ aventurine/ mixamo_walk/
```

复跑：

```bash
cd tests/tmp/motions
node analyze-motions.mjs                 # 全量解析 → analysis.json
node analyze-motions.mjs converted/Idle.vmd
```

下载示例（公开文件）：

```bash
curl -L -o threejs_r171/wavefile_v2.vmd \
  "https://raw.githubusercontent.com/mrdoob/three.js/r171/examples/models/mmd/vmds/wavefile_v2.vmd"
curl -L -o bear_walk.vmd \
  "https://raw.githubusercontent.com/bear0830/mmd/master/walk.vmd"
```

## 附录 B. 搜索关键词记录

`MMD 动作配布` / `动作配布 VMD` / `待机动作 配布` / `走路 动作配布` / `坐 动作配布 MMD` / `砂金 动作配布` / `砂金 MMD 动作` / `崩坏星穹铁道 动作 VMD` / `模之屋 砂金` / `流云景 砂金` / `MMD モーション配布` / `待機モーション` / `歩行モーション 配布` / `座り モーション 配布` / `モーションパッケージ 男性` / `名もなきモーション` / `free MMD motion VMD download` / `MMD motion pack idle walk` / `Aventurine MMD motion` / `humanoid FBX to VMD`。

失败/受限渠道：`w.atwiki.jp/vpvpwiki`（Cloudflare 403）、`api.github.com`（共享 IP 限额耗尽 → 改用 `git clone --filter=blob:none` + raw）、bilibili 搜索 API（-352 → 改用搜索页 HTML 解析）、微云分享页（JS 壳，需登录）。
