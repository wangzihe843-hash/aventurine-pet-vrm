# 素材去哪找：模型与动作

**中文** · [English](guide-asset-sourcing.en.md)

> 属于 [README](../README.md) 的「不会建模怎么用」系列。
> 配套：[三种模型转 VRM](guide-model-conversion.md) · [四条动作管线](guide-motion-conversion.md) ·
> [高频坑与 AI 修复模板](guide-asset-pitfalls.md)

本项目要的两类素材形态固定，先认清再去找，能省掉一半返工：

| 素材 | 项目要的形态 | 落位 |
|---|---|---|
| 模型 | **VRM 1.0 + 规范 T-pose**（面向 +Z、左手 +X） | `assets/vrm/*.vrm` + `src/shared/vrm-manifest.json` 条目 |
| 动作 | **VRM humanoid normalized JSON clip**（逐帧四元数 + Hips 位移 + 贴地元数据） | `assets/motions/*.json` + `app-manifest.json` / `app-catalog.json` |

最小可跑集合：1 个 VRM + `idle` / `walk` / `sit` 三条动作。完整清单当前 40 条（`app-manifest.json`），
缺哪个槽位就退化到 idle，不会崩。

## 一、模型去哪找

| 渠道 | 能给什么 | 门槛 / 注意 |
|---|---|---|
| **模之屋 aplaybox** <https://www.aplaybox.com/> | 中文 MMD 圈主站，PMX 为主，也有转好的 VRM 1.0 | 需登录；站内搜索是 SPA，浏览器里搜比爬取可靠。本项目砂金模型即来自这里（模型编辑：流云景，版权 miHoYo） |
| **BowlRoll** <https://bowlroll.net/> | PMX / VMD 配布 | 多数需下载键（`download_control: permission`） |
| **ニコニ・コモンズ** <https://3d.nicovideo.jp/> | 3D 模型/动作配布 | 需 niconico 账号 |
| **BOOTH** <https://booth.pm/> | 模型、动作包（见下节） | 需 pixiv 账号；免费商品也要登录 |
| **官方游戏模型** | HSR 等游戏的 FBX/PMX | 需 Windows + 游戏本体自行提取；**本仓库不提供提取工具、不附资产**，macOS 本机做不了 |
| **自己建** | 任意 | Blender 建模后按[模型转换攻略](guide-model-conversion.md)第 2 条导出 VRM |

三个反复踩到的现实：

1. **模型站只发模型，不发动作。** 别指望「下载一个包就啥都有」——本项目模型和动作是两条独立供应链。
2. **模型包通常不含道具。** 我们的水枪就是包外另找/另做的，排查过程见
   [`research/watergun-asset-sourcing.md`](research/watergun-asset-sourcing.md)。
3. **授权看包里的 `使用规则.txt`**，不是看平台。本项目红线：**不得二次配布、不得商用**（见 [README 红线](../README.md#红线先读这段)）。

## 二、动作去哪找（优先级别颠倒）

1. **同游戏、同角色**的解包动作 —— 最贴角色，首选。本项目的 HSR 官方动作就是这么来的。
2. **同体型角色**的动作 —— 身高/四肢比例接近，重定向误差最小。
3. **同性别动作** —— 女体动作套男体会肩塌/溜肩，姿态语汇也不对（原因见[高频坑](guide-asset-pitfalls.md)第 3 条）。
4. **公开动作库**（下表）。
5. **自己录** —— Reze MiPo（浏览器摄像头或手机视频 → 动作，0 账号、视频不出本机）；有动捕设备直接用自己的数据。

| 动作来源 | 格式 | 质量 / 适配 | 授权（本地自用） | 门槛 |
|---|---|---|---|---|
| HSR / 游戏官方动作 | FBX | 最贴角色（idle/walk/待机） | 游戏资产版权，仅本地研究 | Windows + 本体提取 |
| Mate-Engine `.anim` | Unity Humanoid muscle | 109 个宠物专属片段（窗沿坐/躲藏/拖拽/摸头） | 个人非商用 + 署名，不得再分发（含转换产物） | Unity 烘焙 |
| Mixamo <https://www.mixamo.com/> | FBX | 专业级通用动作，走路/坐姿首选 | Adobe 条款：可免费用，禁再分发原始动画 | 免费账号 |
| BOOTH「モーションパッケージ」 | FBX | 男性待机 20 个/包，最对味 | 允许改変 + 本地个人用 + 个人商用（署名），禁可提取形式再配布 | ¥2,000/包 + 账号 |
| 名もなきモーション（zukun-lab） | FBX + BIP | VICON 采集、首尾循环干净 | 免费样本，条款需人工读 | BOOTH 登录 |
| CMU MoCap / AMASS | BVH / SMPL | 真人质量，风格需调 | 学术许可 | 需转 FBX 再重定向 |
| Reze MiPo <https://mipo.reze.one> | 直接出动作 | 定制待机/坐姿/反应；走路需另找 | 代码 GPL-3.0；产出归自己 | 0 |

> 各来源的实测结论、授权原文与坑，见
> [`research/motion-assets.md`](research/motion-assets.md) 与 [`research/mocap-options.md`](research/mocap-options.md)。

## 三、一条铁律：没有动捕设备，别让 AI 从零捏动作

这不是保守，是本项目付过学费的结论：

- Wave 2 走过「程序化姿态」路线，**被实测否决**——缺参考、缺可视化回看，纯写数字只会得到反关节、
  滑步、诡异手位；根因分析见 [`anim-strategy.md`](anim-strategy.md) C4。
- 骨骼动作的真实来源只有三种：**实拍/动捕数据、游戏或作者已做好的动作、人工逐帧摆姿 + 截图回看**。
  AI 擅长的是「重定向、修偏移、补接触、批量校验」，不是「凭空生成关键帧」。

所以正确姿势是：**找现成动作 → 转成项目格式 → 让 AI 修比例/接触/朝向**。素材到位后，
转换流程见[动作管线](guide-motion-conversion.md)。

## 四、授权底线（一页）

| 素材 | 本地个人用 | 改変 / 转格式 | 再分发 / 嵌进分发包 | 商用 |
|---|---|---|---|---|
| 本项目模型（miHoYo / 流云景） | ✅ | ✅ | ❌ | ❌ |
| 游戏官方动作（HSR 等） | ✅ | ✅ | ❌ | ❌ |
| Mate-Engine 动作 | ✅（需署名 Shiny） | ✅ | ❌（含烘焙 JSON） | 需作者书面许可 |
| Mixamo | ✅ | ✅ | ❌（原始动画） | ✅（Adobe 条款） |
| BOOTH 动作包 | ✅ | ✅ | ❌（可提取形式） | 视单包条款 |
| 仓库代码（本项目） | ✅ | ✅ | 未附 LICENSE 文件，默认保留所有权利，公开前需先定许可证 | 同左 |

任何「公开仓库 / 分享包 / PR」都不允许包含 `assets/{model,vrm,motions,expressions,props}/`，
`.gitignore` 已兜底，但别用 `git add -f` 绕过。
