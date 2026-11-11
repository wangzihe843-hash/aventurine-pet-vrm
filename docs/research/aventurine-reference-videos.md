# 砂金·戏浪 官方动作参考视频 — 搜集、下载与切片证据包

> 任务：team task-4（reference-video-hunter）· 生成：2026-11-09
> 工作区：`/Volumes/4TB外置盘/deepseek-harness/aventurine-pet-vrm`
> 本地私有产物：`work/ref-aventurine/**`（`work/` 已被 `.gitignore`，**不提交、不发布**）
> 用途：给「141 个 3ds Max 场景 → VRM clip」的逐条验收提供**权威对拍素材 + 时间码 + 本地可复核文件**。
> 版权：官方游戏素材/视频 © miHoYo / COGNOSPHERE / HoYoverse；B 站视频 © 各 UP 主。本目录仅供本机内部比对，禁止再分发。

---

## 0. TL;DR（给 Lead / 验收同学先看）

1. **已拿到的最权威素材 = 官方游戏 GIF 8 条**（来源：Biligame wiki 官方游戏录制）：
   戏浪 6 条技能动作（普攻 / 战技 / 终结技 / 秘技 / 欢愉技 / 强化欢愉技）+ 基础版砂金 2 条「站立动作」。已转成 mp4 并抽关键帧拼图，**技能动作逐条验收应以这 8 条为金标准**（`official/gifs/`、`clips/official_*.mp4`）。
2. **已下载 47 个视频文件**（1080p/近 1080p + 360p 扫片；B 站免登录实测可下 1080p，见 §2；合计约 683MB。**2026-11-09 补采新增 14 个**，见 §9），关键动作已切成 **25 个本地 clip**（`clips/`，约 103MB），并产出 **204 张带时间码的缩略帧拼图**（`sheets/`，约 70MB）。
3. **已确认的视频时间码（实测抽帧）**：
   - `BV1Nyta66Evh`（30.1s 技能演示，画面自带中文标签）：**普攻 0:00–0:02.2 / 战技 0:02.0–0:08.6 / 欢愉时刻 0:08.5–0:15.4 / 大招 0:15.4–0:26.5** ← 对拍 Skill01–04 最省事的一条；
   - `BV1mYTn6dEQL`（56.9s）：**战斗待机 0:00–0:10.6**、终结技冲浪过场 0:13–0:19.5；
   - `BV1WQYH6XEQQ`（149.7s）：战斗待机 0:00–0:40（含镜头运动）、技能/广告镜头/战斗杂糅 0:54–2:30；
   - `BV1JSev6xEfz`（75.8s 试用关卡）：**走路/跑动 0:03–0:17**、**站立动作（抛硬币）0:23–0:36.5**（机位较远）；
   - 官方 `BV1yjYx6AEp7` 角色PV（p1 111.6s）与 `BV19qgK6qEb6` 4.5 版本PV（p1 192.9s）已下载，均为快剪分镜（**不适合逐帧动作对拍，只作官方风格/姿态参考**）。
4. **缺口现状（2026-11-09 补采后，详见 §9）**：`TeamStandBy`、`Hit/Die/Stun/Revive` 仍无干净公开素材；NPC 社交动作 80 条中，**Talk01/02 → B（2 条）**、**HoldArm/LookAtPhone/WatchPhone/Think01 → C（约 20 条）**，其余约 57 条仍 E（见 §7 与全表 E 级行 + §9.5）；Biligame wiki 的「戏浪站立动作」GIF 仍是**空占位**（页面显示“请上传文件”）。米游社渠道已打通（§9.1），但**未找到逐条社交动作视频**。
5. **限制**：YouTube 在本机**不通**（curl 15s 超时）；HoYoLab/HoYoWiki **区域封锁 403**；B 站**未登录**（无账号/密码，按约束不使用），免登录最高 **1080p**，`1080P60 / 4K / 1080P高码率` 需大会员 → 已记录，未绕过。全部下载命令可复现（§3）。

---

## 1. 结论一览（按动作类别）

| 动作类别（对应 .max take） | 参考来源 | 证据等级 | 本地证据 |
|---|---|---|---|
| 普攻 Skill01 | 官方 GIF W1 + `BV1Nyta66Evh` 0:00–0:02.2（带「普攻」标签） | **A** | `clips/official_skill_puwang_普攻.mp4`、`clips/labeled_puwang_普攻.mp4` |
| 战技 Skill02 | 官方 GIF W2 + `BV1Nyta66Evh` 0:02.0–0:08.6（「战技」标签） | **A** | `clips/official_skill_zhanji_战技.mp4`、`clips/labeled_zhanji_战技.mp4` |
| 终结技 Skill03 | 官方 GIF W3 + `BV1Nyta66Evh` 0:15.4–0:26.5（「大招」标签）+ `BV1mYTn6dEQL` 0:13–0:19.5 | **A** | `clips/official_skill_zhongjieji_终结技.mp4`、`clips/labeled_ultimate_大招.mp4` |
| 欢愉技 Skill04 / 强化欢愉技 Skill41 | 官方 GIF W5（欢愉技）/ W6（强化欢愉技）+ `BV1Nyta66Evh` 0:08.5–0:15.4（「欢愉时刻」标签） | **B**（Skill04↔哪张 GIF 需人眼确认） | `clips/labeled_huanyu_moment_欢愉时刻.mp4`、`clips/official_skill_huanyuji_欢愉技.mp4`、`clips/official_skill_qianghua_huanyuji_强化欢愉技.mp4` |
| 秘技 MazeSkill01 | 官方 GIF W4 + `BV1WQYH6XEQQ` ≈0:58–1:04 冲浪位移 | **B** | `clips/official_skill_miji_秘技.mp4`、`clips/xilang_miji_wavedash_秘技冲浪_待确认.mp4` |
| 战斗待机 StandBy / AttackStandBy | `BV1mYTn6dEQL` 0:00–0:10.6、`BV1WQYH6XEQQ` 0:00–0:14 | **B** | `clips/xilang_standby_battle_arena*.mp4` |
| 队伍待机 TeamStandBy | 无干净公开素材（候选见 §7） | **E** | — |
| 站立动作 Idle_Show_01/02、Common_IdleShow | `BV1JSev6xEfz` 0:23–0:36.5（试用关卡抛硬币）；官方 wiki GIF 空占位 | **B**（具体是 01 还是 02 未区分） | `clips/xilang_idleshow_cointoss_站立动作_抛硬币.mp4` |
| 走路/跑步 Walk/Run | `BV1JSev6xEfz` 0:03–0:17；`BV1WQYH6XEQQ` 偶发走位 | **B–C** | `clips/xilang_walk_run_trial_走路跑步.mp4` |
| 转身/急停 Turn_*/RunStop*/WalkStop* | 无干净公开素材（跟随镜头里被遮挡/切镜） | **C–E** | — |
| 受击 Hit_H/Hit_L/Hit_Stun/BeHit | 战斗视频中瞬间被特效遮挡，无干净单条 | **E** | —（战斗视频 URL 见 §7） |
| 眩晕/死亡/复活 State_Stun*/Die*/Revive | 无干净公开素材 | **E** | — |
| 天赋 PassiveSkill | 无独立展示 | **E** | — |
| NPC 社交动作（80 条：Akimbo/Talk/Think/Worry/Shrug/ScratchHead/LookAtPhone/WatchPhone/UseHeadPhone/Snap/Bye/CoverMouth/Hold*/Injured/Alert/BackWard/Build/Forerake/PutHand/StrikeChest/UseProp） | **2026-11-09 补采**：Talk01/02 用 4.5 剧情 cut 大厅对话（33:20–34:40）→ B；HoldArm/LookAtPhone/WatchPhone/Think01 用同角色站姿 / 米游社通用 NPC → C；其余仍 E（详见 §9） | **部分 B/C、多数 E** | `clips/social_45cut_hall_dialogue_33-20_34-40_B级.mp4`、`clips/mys_77824028_npc_phone_通用NPC看手机_C级.mp4` 等（§9.5） |
| T-pose | 源绑定姿势，非表演动作 | n/a | — |

> 等级定义：**A** = 有官方/明确标注来源且已本机抽帧核对；**B** = 本机抽帧可见、但需人眼对应到具体 take；**B–C/C–E** = 区间（部分可见/部分缺失）；**C** = 按命名/机位推断；**E** = 公开素材缺口；**n/a** = 不适用。
> 注意：表中「等级」指**参考素材的可对拍程度**；它与「`.max` take 名 → 游戏内动作」的对应关系（属命名推断，C 级）是两件事，后者见 §6 表头说明。

---

## 2. 环境实测与可用性（先看，决定后续能做什么）

| 项 | 实测结果 |
|---|---|
| yt-dlp | `<home>/.local/bin/yt-dlp`，版本 **2026.10.21**，可用 |
| 系统 ffmpeg/ffprobe/brew | **均未安装**（`/opt/homebrew`、`/usr/local/bin` 无；`brew` 命令不存在） |
| ffmpeg 替代 | ✅ Python 包 **imageio-ffmpeg 0.8.1** 自带静态二进制 **ffmpeg 9.0 (macos-aarch64)**：`<home>/.local/lib/python3.10/site-packages/imageio_ffmpeg/binaries/ffmpeg-macos-aarch64-v9.0`；已在 `work/ref-aventurine/tools/bin/ffmpeg` 做 symlink，`yt-dlp --ffmpeg-location work/ref-aventurine/tools/bin` 即可合并音视频/切段（实测有效）。注意它**没有 ffprobe**（yt-dlp 合并/切段够用，抽帧用 ffmpeg 即可）。 |
| 其它可用 | Python 3.10 + numpy/Pillow/ImageIO；Node 24；macOS 27.2 arm64；磁盘 3.4TB 可用 |
| B 站 | 可访问（首页 HTTP 200，~0.16s）。**免登录可下 1080p（format 30080 / 100026）**；`1080P60 / 4K / 1080P高码率` 提示 “you have to become a premium member” → **本次不登录、不使用账号密码**，故最高只取 1080p30。搜索 API 需 cookie jar（b_nut）+ 限速（3s/次），否则返回风控 HTML。 |
| YouTube | **不通**（`https://www.youtube.com/` curl 15s 超时，HTTP 000）；官方 YouTube/HoYo 发布源只能留 URL 备注，未下载 |
| HoYoLab / HoYoWiki | **区域封锁**（`bbs-api-os.hoyolab.com` 403 Denied by region_block；`wiki.hoyolab.com` 403 “not available in your country or region”）→ 官方 wiki 资料无法抓取，仅保留入口 URL |
| **米游社**（miyoushe.com） | ✅ **可访问、免登录**（`https://www.miyoushe.com/` 与 `/sr/` HTTP 200 SSR；`bbs.miyoushe.com` 直连不稳定/超时，以 www 为准）。搜索/详情 API 可直连（`api-takumi.miyoushe.com/post/wapi/searchPosts` 与 `getPostFull`，无需 cookie/签名）；视频帖 `data.post.vod_list[].resolutions[].url` 为可直下的 `prod-vod-sign.miyoushe.com` MP4（480P/720P/1080P，带时效 auth_key）。已下 7 条视频，详见 §9.1/§9.2。 |

---

## 3. 可复现流程（下载 → 抽帧 → 切片 → 拼图）

目录结构（全部在 `work/ref-aventurine/`，gitignore）：

```
work/ref-aventurine/
├─ video/     # yt-dlp 下载的原始视频 + info.json（1080p，见 §8.1 清单）
├─ official/gifs/  # Biligame wiki 官方游戏 GIF（8 条，见 §4.1）
├─ clips/     # 切好的对拍片段（19 条，见 §8.2 清单）
├─ sheets/    # 带时间码缩略帧拼图（122 张 .jpg；命名=<来源>-pNN.jpg）
├─ meta/      # 搜索命中结果 json（可按关键词复查候选视频）
└─ tools/
   ├─ bin/ffmpeg              # → imageio-ffmpeg 自带 ffmpeg 9.0 的 symlink
   ├─ bili_search.py          # B 站搜索（cookie-jar + 限速，免登录）
   ├─ miyoushe_search.py      # 米游社搜索 / 帖子详情 / vod_list 视频下载（免登录，见 §9.1）
   ├─ make_sheet.py           # 视频 → 带时间码 contact sheet（PIL 拼图）
   └─ build_evidence.py       # 官方 GIF→mp4+关键帧拼图；视频→切片（本次全部产物）
```

关键命令（本次实际使用，均可复跑）：

```bash
export YTDLP=<home>/.local/bin/yt-dlp
export FFDIR="$PWD/work/ref-aventurine/tools/bin"
cd work/ref-aventurine

# 1) B 站搜索（免登录；cookie-jar 自动建立，3s 限速防 412/风控）
python3 tools/bili_search.py "砂金戏浪 实机" 1 meta/search-砂金戏浪_实机.json

# 1b) 米游社搜索 / 帖子详情 / 视频下载（免登录，2026-11-09 新增；详见 §9.1）
python3 tools/miyoushe_search.py "砂金 待机" 1 meta/mys-search-砂金_待机.json
python3 tools/miyoushe_search.py --post 77991326 --outdir meta/mys-posts

# 2) 免登录下载 1080p（自动选 bv*[height<=1080]+ba，失败回退 b）
"$YTDLP" --ffmpeg-location "$FFDIR" -f "bv*[height<=1080]+ba/b[height<=1080]" \
  --write-info-json --no-playlist -o "video/%(id)s-%(title).60B.%(ext)s" \
  "https://www.bilibili.com/video/BV1Nyta66Evh/"

# 2b) 只取 360p 做“扫片”省流量；指定分P
"$YTDLP" --ffmpeg-location "$FFDIR" -f 30016 --no-playlist -o "video/%(id)s_p%(playlist_index)s.%(ext)s" \
  "https://www.bilibili.com/video/BV1E8bG6GE1s/?p=2"

# 2c) 只下指定时间段（需要 ffmpeg，已具备）
"$YTDLP" --ffmpeg-location "$FFDIR" --download-sections "*00:23-00:36.5" \
  -f "bv*[height<=1080]+ba" -o "video/section-BV1JSev6xEfz.%(ext)s" "https://www.bilibili.com/video/BV1JSev6xEfz/"

# 3) 抽时间码拼图（默认 1fps、4×5 格、320~384px 宽；--start/--end 可截区间）
python3 tools/make_sheet.py "video/<file>.mp4" "sheets/vX-名称" --fps 1 --cols 4 --rows 5 --tile-w 384

# 4) 官方 GIF → mp4 + 关键帧拼图；视频 → 对拍切片（全部路径/时间段写在 build_evidence.py）
python3 tools/build_evidence.py
```

官方 GIF 规格（下载自 Biligame wiki，见 §4.1）：`wiki-1…wiki-6` = 戏浪 6 技能；`wiki-7/8` = 基础版站立动作 1/2。

---

## 4. 权威参考源清单

### 4.1 官方游戏 GIF（Biligame wiki，官方游戏录制；**技能验收金标准**）

| ID | 本地文件 | 内容（本机抽帧确认） | 规格 | 时长 | 来源 URL |
|---|---|---|---|---|---|
| W1 | `official/gifs/wiki-3.gif` → `clips/official_skill_puwang_普攻.mp4` | **普攻**：持枪/矛突刺 → 白光 → 破韧数字 | 480×270 | 1.45s（29f×50ms） | <https://wiki.biligame.com/sr/砂金•戏浪> |
| W2 | `official/gifs/wiki-4.gif` → `clips/official_skill_zhanji_战技.mp4` | **战技**：抛筹码 → 金色爆炸 → 多段伤害 | 480×270 | 4.65s（93f） | 同上 |
| W3 | `official/gifs/wiki-5.gif` → `clips/official_skill_zhongjieji_终结技.mp4` | **终结技**：剪影开场 → 巨浪/冲浪 → 冰爆收尾 | 480×270 | 8.65s（173f） | 同上 |
| W4 | `official/gifs/wiki-1.gif` → `clips/official_skill_miji_秘技.mp4` | **秘技**：大世界触发 → 卡牌/冰晶 → 进入战斗 | 640×360 | 4.00s（60f） | 同上 |
| W5 | `official/gifs/wiki-2.gif` → `clips/official_skill_huanyuji_欢愉技.mp4` | **欢愉技**：广告镜头 → 汽水罐墙 → 金色爆发 | 480×270 | 4.45s（89f） | 同上 |
| W6 | `official/gifs/wiki-6.gif` → `clips/official_skill_qianghua_huanyuji_强化欢愉技.mp4` | **强化欢愉技**：城中场景/沙滩球 → 广告镜头 → 金色喷泉/汽水 | 480×270 | 12.66s（152f） | 同上 |
| W7 | `official/gifs/wiki-7.gif` → `clips/official_idle_base_站立动作1.mp4` | 基础版·站立动作 1（摊手展示等） | 400×540 | 11.76s（196f） | <https://wiki.biligame.com/sr/砂金> |
| W8 | `official/gifs/wiki-8.gif` → `clips/official_idle_base_站立动作2.mp4` | 基础版·站立动作 2（看表/喷香水/抛硬币等） | 400×540 | 12.48s（208f） | 同上 |

> ⚠️ 戏浪页的「站立动作 / 站立动作2」GIF 在 wiki 上仍是**空占位**（链接为“特殊:上传文件”，无实际文件）→ **戏浪 Idle_Show 无官方 GIF**，只能用 §5 的实机视频。
> 已产出逐帧关键帧拼图：`sheets/clip-official_skill_*-keyframes.jpg`（每条 8 帧 + 近似时间）。
> 注：Biligame wiki 页面标注许可 CC BY-NC-SA 4.0，图片来自官方游戏画面；仅本机比对用。

### 4.2 官方 B 站视频（已下载 1080p）

| ID | 标题 / UP 主 | 时长 | 实测内容与可用性 | B 站 URL | 本地文件 |
|---|---|---|---|---|---|
| O1 | 《崩坏：星穹铁道》砂金•戏浪角色PV——「独家爆料」/ 崩坏星穹铁道（官方号） | 111.6s（p1；合集共 4 语种 439s） | 快剪分镜流 PV，**只作官方风格/服装/镜头参考**，不适合逐帧对拍 | <https://www.bilibili.com/video/BV1yjYx6AEp7/> | `video/BV1yjYx6AEp7_p1-…mp4` |
| O2 | 《崩坏：星穹铁道》4.5版本PV：「挥掷千星的筹码」/ 崩坏星穹铁道（官方号） | 192.9s（p1） | 版本 PV 混剪（沙滩/剧情/千星城/版本内容展示）；1:28–1:30 有官方 KV 图 | <https://www.bilibili.com/video/BV19qgK6qEb6/> | `video/BV19qgK6qEb6_p1-…mp4` |
| O3 | 《崩坏：星穹铁道》「星际和平导览：千星城旅游指南」/ 帕姆的收藏夹（官方内容搬运） | 82.4s（p1） | 千星城官方宣传片；0:22–0:40 沙滩/排球、0:56–1:00 戏浪代言广告牌 | <https://www.bilibili.com/video/BV1JCgN6yEkf/> | `video/BV1JCgN6yEkf_p1-…mp4` |

### 4.3 实机/演示视频（已下载 1080p，**对拍主力**）

| ID | 标题 / UP 主 | 时长 | 分辨率 | 实测内容（抽帧确认）+ 可用时间段 | B 站 URL |
|---|---|---|---|---|---|
| V1 | 砂金·戏浪的待机动画【崩坏：星穹铁道】/ 夏末初秋Kzyp | 75.8s | 1920×1080@30 | 试用关卡：走动/跑动 0:03–0:17；站立动作（抛硬币+抬手+白色星芒）0:23–0:36.5；其余为其他试用角色 | <https://www.bilibili.com/video/BV1JSev6xEfz/> |
| V4 | 砂金·戏浪实机演示 / 最善逢魔时王 | 149.7s | 1920×1080@30 | 战斗待机长镜头 0:00–0:40；0:54–0:56 旋转攻击；≈1:02 冲浪位移；1:10–1:18 广告镜头；1:20–2:30 战斗/技能/广告杂糅 | <https://www.bilibili.com/video/BV1WQYH6XEQQ/> |
| V5 | 4K砂金戏浪全技能慢放 / 1emonTxT | 102.7s | 1920×1080@30（4K 需会员） | 慢放剪辑：终结技/欢愉技过场为主（0:00–1:19），身体动作被慢放/叠化 | <https://www.bilibili.com/video/BV1HcbC6YEoE/> |
| V7 | 4.5砂金戏浪两个专属成就 / 剑羽 | 123.8s | 1920×1080@30 | 4.5 成就玩法（派对相关）；战斗+演出混剪 | <https://www.bilibili.com/video/BV1TfYD6rEk1/> |
| V10 | 崩坏星穹铁道 砂金•戏浪 实机演示 / 欢愉令使-龘龘鸭鸭 | 56.9s | 1920×1080@28 | **战斗待机 0:00–0:10.6（干净全身）**；0:11–0:12 广告镜头；0:13–0:19.5 终结技冲浪过场 | <https://www.bilibili.com/video/BV1mYTn6dEQL/> |
| V11 | 【崩坏星穹铁道】全角色技能展示——砂金•戏浪 / 魔法盒Magesbox | 82.2s | 1920×1080@30 | 大世界普攻 0:00–0:03；卡片/秘技特效 0:04–0:05；广告镜头+技能 0:06–0:19；战斗 0:20–0:30；1:04–1:22 战斗/冲浪 | <https://www.bilibili.com/video/BV12Ceq6MEQC/> |
| V13 | 砂金-戏浪 技能演示 / 植awa | 30.1s | 1920×864@30 | **画面自带中文标签**：普攻 0:00–0:02.2 / 战技 0:02.0–0:08.6 / 欢愉时刻 0:08.5–0:15.4 / 大招 0:15.4–0:26.5 | <https://www.bilibili.com/video/BV1Nyta66Evh/> |
| V19 | 【星铁】砂金·戏浪列车对话 / 粉红公主 | 11 个分P，p1 73s | 360p（扫片用；1080p 可选下） | p1「初次上车」0:03–1:13 对话站姿语境（**不是社交动作逐条素材**）；p2–p11 各 55–87s | <https://www.bilibili.com/video/BV1E8bG6GE1s/> |
| Vb2 | 【星铁】试用砂金2款待机动作+普攻+秘技 / 清新宜人好青年 | 41.9s | 1920×1080@30 | **基础版**砂金：待机1 0:00–0:20；待机2 0:20–0:35.5；普攻/秘技 0:36–0:40 | <https://www.bilibili.com/video/BV1vq421A7fQ/> |
| Vb3 | 砂金的角色界面待机动画 / 黑枪皇-冷酷的毒士 | 59.1s | 1920×1080@30 | **基础版**砂金角色界面待机长镜头 0:00–0:59（对拍基础版 Idle_Show 节奏参考） | <https://www.bilibili.com/video/BV1hK421h79W/> |

> 另有 6 个已下但对拍价值低的文件：`BV1pHgK6UEY6`（4.5 前瞻泄漏向技能实机，114s）、`BV1PsYX6kEqx`（“新泳装”二创混剪）、`BV1dV8Q6JEoo`/`BV18u8R6SEde`（4.5 剧情高光，含大段非动作镜头）、`BV1k8d3Y7E8d`/`BV14fRLB8EWm`（队伍界面待机展示，**无砂金**）、`BV1FctA67EKY`（千星城成就指引）、`BV1J3xL63EaZ`（同人手书，已弃用）。完整清单见 §8.1。

### 4.4 未下载候选源（缺口补齐时用；仅记录，未验证画面）

| 用途 | 标题 / UP 主 | 时长 | URL | 备注 |
|---|---|---|---|---|
| 4.5 千星城剧情完整 cut（找 NPC 社交动作/大世界动作的最佳候选） | 【砂金丨4K高清】4.5千星城开拓续闻剧情完整纯享版cut / 筱叶子Leaf | 81:06 | <https://www.bilibili.com/video/BV1Kd4R6BEYh/> | 未下载（体积大）；若需逐条验社交动作，建议先下 360p 扫片再补 1080p 段 |
| 砂金全剧情 cut 合集（含 4.5） | 【砂金】单人向全剧情cut合集 / 樱桃冻奶沫 | 365:35 | <https://www.bilibili.com/video/BV1FJ4m1j7Vd/> | 同上 |
| 官方动画短片全收集（4K） | 砂金 动画全收集【4K典藏版】/ 星忆月眠 | 19:51 | <https://www.bilibili.com/video/BV1uVVJzpEnH/> | 官方过场动画，非游戏动作 |
| 4.6 星际和平盛典活动（可观察角色演出） | 【星穹铁道】星际和平盛典：一镜到底 / 你的影月月 | 25:20 | <https://www.bilibili.com/video/BV1wwnq6FEFa/> | 4.6 活动，版本晚于 4.5，仅作演出参考 |
| B 站官方号其它砂金相关 | 砂金角色PV/演示（基础版）等 | — | 站内搜索“崩坏星穹铁道 砂金 角色PV” | 基础版参考价值低于戏浪 |

---

## 5. 关键动作时间码（本机抽帧实测；用于对拍）

> 时间码 = 视频播放时间；对应抽帧拼图见 `sheets/` 同名文件。全部是 30fps 视频（V10 为 28fps）。

### 5.1 技能（推荐用 V13 的标签段，或直接看官方 GIF）

| 动作 | 推荐素材 | 时间段 | 本地 clip |
|---|---|---|---|
| 普攻（Skill01） | `BV1Nyta66Evh`（画面标签「普攻」） | **0:00.0–0:02.2** | `clips/labeled_puwang_普攻.mp4` |
| 战技（Skill02） | `BV1Nyta66Evh`（标签「战技」） | **0:02.0–0:08.6** | `clips/labeled_zhanji_战技.mp4` |
| 欢愉技（Skill04/Skill41） | `BV1Nyta66Evh`（标签「欢愉时刻」） | **0:08.5–0:15.4** | `clips/labeled_huanyu_moment_欢愉时刻.mp4` |
| 终结技（Skill03） | `BV1Nyta66Evh`（标签「大招」） | **0:15.4–0:26.5** | `clips/labeled_ultimate_大招.mp4` |
| 终结技（过场补充） | `BV1mYTn6dEQL` | 0:13.0–0:19.5 | `clips/xilang_ultimate_surf_cinematic_终结技冲浪过场.mp4` |
| 秘技（MazeSkill01） | 官方 GIF W4；`BV1WQYH6XEQQ` 冲浪位移 | GIF 全段；视频 ≈0:58–1:04（**待人工确认**） | `clips/official_skill_miji_秘技.mp4`、`clips/xilang_miji_wavedash_秘技冲浪_待确认.mp4` |
| 大世界攻击（MazeAttack01 参考） | `BV12Ceq6MEQC` 大世界普攻段 | 0:00–0:03 | 未切（见 URL） |

### 5.2 待机/表演/移动

| 动作 | 推荐素材 | 时间段 | 本地 clip |
|---|---|---|---|
| 战斗待机 StandBy | `BV1mYTn6dEQL`（干净全身） | **0:00.0–0:10.6** | `clips/xilang_standby_battle_arena_戏浪战斗待机.mp4` |
| 战斗待机（备选长镜头） | `BV1WQYH6XEQQ` | 0:00–0:14（更长 0:00–0:40，含镜头运动） | `clips/xilang_standby_battle_arena2_戏浪战斗待机.mp4` |
| 站立动作 Idle_Show（抛硬币） | `BV1JSev6xEfz` 试用关卡 | **0:23.0–0:36.5**（机位较远、有树遮挡） | `clips/xilang_idleshow_cointoss_站立动作_抛硬币.mp4` |
| 走路/跑动 | `BV1JSev6xEfz` 试用关卡 | **0:03.0–0:17.0**（跟随机位） | `clips/xilang_walk_run_trial_走路跑步.mp4` |
| 基础版站立动作 1/2（对照节奏用） | 官方 GIF W7/W8 | 全段 | `clips/official_idle_base_站立动作1/2.mp4` |

### 5.3 其它已抽帧确认的内容（备查）

- `BV1HcbC6YEoE`（慢放剪辑）：0:00–0:40 冲浪/冰爆过场；0:45–0:53 广告镜头（手部/汽水罐）；1:13–1:19 喝汽水广告镜头 —— 只适合看**技能过场构图/节奏**。
- `BV19qgK6qEb6`（4.5 版本 PV）：0:00–0:40 沙滩度假；0:40–1:20 千星城/赛车/剧情混剪；1:28–1:30 戏浪官方 KV。
- `BV1yjYx6AEp7`（角色 PV）：0:00–1:11 全程快剪分镜（含海浪/广告/睁眼特写），**动作连续性被剪碎**。
- `BV1E8bG6GE1s`（列车对话）：p1 0:03–1:13 玩家与戏浪对话，戏浪站姿基本静止 —— 只能作为「对话场景站姿」语境参考，不能当社交动作证据。
- `BV1JCgN6yEkf`（千星城导览）：0:22–0:40 沙滩排球、0:56–1:00 戏浪代言广告牌，官方宣传片。

---

## 6. 动作 id → 参考来源 → 本地文件 全表（138 条 .max 场景）

> 说明：
> - `.max` 名来自 `/Volumes/4TB外置盘/百度网盘/砂金戏浪.zip` 实测清单：**138 个 `.max`**（任务书写的是 141；压缩包内另有 35 个贴图/材质 png，合计 173 文件。两个带 “ (2)” 的重名变体 `StandBy (2)`、`Skill04 (2)` 已单列）。
> - “动作（命名推断）”依据 HSR 动画器命名惯例 + 官方视频标签对照，**不是从 .max 内部读出的绑定信息**（.max 解析是 task-1 的工作）。
> - “等级”沿用 §1 定义；`E` 行 = 公开素材缺口，**验收时不要拿别的动作冒充**。
> - 参考 video id 与 URL 对应见 §4.3；clip 路径相对 `work/ref-aventurine/`。

| # | .max 场景 | 动作（命名推断） | 参考来源 / 时间段 | 本地证据文件（work/ref-aventurine/） | 等级 | 备注 |
|---|---|---|---|---|---|---|
| 1 | `Akimbo01AS` | NPC 社交：叉腰/Akimbo 01AS | 见 §9 社交动作参考补充（2026-11-09 补采：Talk/HoldArm/Think/LookAtPhone/WatchPhone 部分 B/C，其余仍 E） | clips/xilang_dialog_standing_列车对话站姿_360p.mp4（仅语境参考） | E | 建议：游戏内千星城 NPC 环境行为录屏，或按「通用NPC动作」接受近似 |
| 2 | `Akimbo01BS` | NPC 社交：叉腰/Akimbo 01BS | 见 §9 社交动作参考补充（2026-11-09 补采：Talk/HoldArm/Think/LookAtPhone/WatchPhone 部分 B/C，其余仍 E） | clips/xilang_dialog_standing_列车对话站姿_360p.mp4（仅语境参考） | E | 建议：游戏内千星城 NPC 环境行为录屏，或按「通用NPC动作」接受近似 |
| 3 | `Akimbo01HandAS` | NPC 社交：叉腰/Akimbo 01HandAS | 见 §9 社交动作参考补充（2026-11-09 补采：Talk/HoldArm/Think/LookAtPhone/WatchPhone 部分 B/C，其余仍 E） | clips/xilang_dialog_standing_列车对话站姿_360p.mp4（仅语境参考） | E | 建议：游戏内千星城 NPC 环境行为录屏，或按「通用NPC动作」接受近似 |
| 4 | `Akimbo01HandBS` | NPC 社交：叉腰/Akimbo 01HandBS | 见 §9 社交动作参考补充（2026-11-09 补采：Talk/HoldArm/Think/LookAtPhone/WatchPhone 部分 B/C，其余仍 E） | clips/xilang_dialog_standing_列车对话站姿_360p.mp4（仅语境参考） | E | 建议：游戏内千星城 NPC 环境行为录屏，或按「通用NPC动作」接受近似 |
| 5 | `Akimbo01HandLoop` | NPC 社交：叉腰/Akimbo 01HandLoop | 见 §9 社交动作参考补充（2026-11-09 补采：Talk/HoldArm/Think/LookAtPhone/WatchPhone 部分 B/C，其余仍 E） | clips/xilang_dialog_standing_列车对话站姿_360p.mp4（仅语境参考） | E | 建议：游戏内千星城 NPC 环境行为录屏，或按「通用NPC动作」接受近似 |
| 6 | `Akimbo01Loop` | NPC 社交：叉腰/Akimbo 01Loop | 见 §9 社交动作参考补充（2026-11-09 补采：Talk/HoldArm/Think/LookAtPhone/WatchPhone 部分 B/C，其余仍 E） | clips/xilang_dialog_standing_列车对话站姿_360p.mp4（仅语境参考） | E | 建议：游戏内千星城 NPC 环境行为录屏，或按「通用NPC动作」接受近似 |
| 7 | `Akimbo02AS` | NPC 社交：叉腰/Akimbo 02AS | 见 §9 社交动作参考补充（2026-11-09 补采：Talk/HoldArm/Think/LookAtPhone/WatchPhone 部分 B/C，其余仍 E） | clips/xilang_dialog_standing_列车对话站姿_360p.mp4（仅语境参考） | E | 建议：游戏内千星城 NPC 环境行为录屏，或按「通用NPC动作」接受近似 |
| 8 | `Akimbo02BS` | NPC 社交：叉腰/Akimbo 02BS | 见 §9 社交动作参考补充（2026-11-09 补采：Talk/HoldArm/Think/LookAtPhone/WatchPhone 部分 B/C，其余仍 E） | clips/xilang_dialog_standing_列车对话站姿_360p.mp4（仅语境参考） | E | 建议：游戏内千星城 NPC 环境行为录屏，或按「通用NPC动作」接受近似 |
| 9 | `Akimbo02HandAS` | NPC 社交：叉腰/Akimbo 02HandAS | 见 §9 社交动作参考补充（2026-11-09 补采：Talk/HoldArm/Think/LookAtPhone/WatchPhone 部分 B/C，其余仍 E） | clips/xilang_dialog_standing_列车对话站姿_360p.mp4（仅语境参考） | E | 建议：游戏内千星城 NPC 环境行为录屏，或按「通用NPC动作」接受近似 |
| 10 | `Akimbo02HandBS` | NPC 社交：叉腰/Akimbo 02HandBS | 见 §9 社交动作参考补充（2026-11-09 补采：Talk/HoldArm/Think/LookAtPhone/WatchPhone 部分 B/C，其余仍 E） | clips/xilang_dialog_standing_列车对话站姿_360p.mp4（仅语境参考） | E | 建议：游戏内千星城 NPC 环境行为录屏，或按「通用NPC动作」接受近似 |
| 11 | `Akimbo02HandLoop` | NPC 社交：叉腰/Akimbo 02HandLoop | 见 §9 社交动作参考补充（2026-11-09 补采：Talk/HoldArm/Think/LookAtPhone/WatchPhone 部分 B/C，其余仍 E） | clips/xilang_dialog_standing_列车对话站姿_360p.mp4（仅语境参考） | E | 建议：游戏内千星城 NPC 环境行为录屏，或按「通用NPC动作」接受近似 |
| 12 | `Akimbo02Loop` | NPC 社交：叉腰/Akimbo 02Loop | 见 §9 社交动作参考补充（2026-11-09 补采：Talk/HoldArm/Think/LookAtPhone/WatchPhone 部分 B/C，其余仍 E） | clips/xilang_dialog_standing_列车对话站姿_360p.mp4（仅语境参考） | E | 建议：游戏内千星城 NPC 环境行为录屏，或按「通用NPC动作」接受近似 |
| 13 | `Alert01AS` | NPC 社交：警觉/Alert 01AS | 见 §9 社交动作参考补充（2026-11-09 补采：Talk/HoldArm/Think/LookAtPhone/WatchPhone 部分 B/C，其余仍 E） | clips/xilang_dialog_standing_列车对话站姿_360p.mp4（仅语境参考） | E | 建议：游戏内千星城 NPC 环境行为录屏，或按「通用NPC动作」接受近似 |
| 14 | `Alert01BS` | NPC 社交：警觉/Alert 01BS | 见 §9 社交动作参考补充（2026-11-09 补采：Talk/HoldArm/Think/LookAtPhone/WatchPhone 部分 B/C，其余仍 E） | clips/xilang_dialog_standing_列车对话站姿_360p.mp4（仅语境参考） | E | 建议：游戏内千星城 NPC 环境行为录屏，或按「通用NPC动作」接受近似 |
| 15 | `Alert01Loop` | NPC 社交：警觉/Alert 01Loop | 见 §9 社交动作参考补充（2026-11-09 补采：Talk/HoldArm/Think/LookAtPhone/WatchPhone 部分 B/C，其余仍 E） | clips/xilang_dialog_standing_列车对话站姿_360p.mp4（仅语境参考） | E | 建议：游戏内千星城 NPC 环境行为录屏，或按「通用NPC动作」接受近似 |
| 16 | `AttackStandBy` | 战斗待机/攻击待机 | V10 t=00:00–00:10.6；V4 t=00:00–00:14 | clips/xilang_standby_battle_arena_戏浪战斗待机.mp4；clips/xilang_standby_battle_arena2_戏浪战斗待机.mp4 | B |  |
| 17 | `BackWard01AS` | NPC 社交：后退/BackWard 01AS | 见 §9 社交动作参考补充（2026-11-09 补采：Talk/HoldArm/Think/LookAtPhone/WatchPhone 部分 B/C，其余仍 E） | clips/xilang_dialog_standing_列车对话站姿_360p.mp4（仅语境参考） | E | 建议：游戏内千星城 NPC 环境行为录屏，或按「通用NPC动作」接受近似 |
| 18 | `BackWard01BS` | NPC 社交：后退/BackWard 01BS | 见 §9 社交动作参考补充（2026-11-09 补采：Talk/HoldArm/Think/LookAtPhone/WatchPhone 部分 B/C，其余仍 E） | clips/xilang_dialog_standing_列车对话站姿_360p.mp4（仅语境参考） | E | 建议：游戏内千星城 NPC 环境行为录屏，或按「通用NPC动作」接受近似 |
| 19 | `BackWard01Loop` | NPC 社交：后退/BackWard 01Loop | 见 §9 社交动作参考补充（2026-11-09 补采：Talk/HoldArm/Think/LookAtPhone/WatchPhone 部分 B/C，其余仍 E） | clips/xilang_dialog_standing_列车对话站姿_360p.mp4（仅语境参考） | E | 建议：游戏内千星城 NPC 环境行为录屏，或按「通用NPC动作」接受近似 |
| 20 | `BeHit` | 受击/受击眩晕 | 【缺口】战斗视频中受击瞬间被特效遮挡、无干净单条引用。可用战斗视频：V4 BV1WQYH6XEQQ、BV1ZveV6xEjX 等 | — | E | 建议游戏内逐条录屏或接受近似 |
| 21 | `Build02AS` | NPC 社交：建造/Build（沙堡类） 02AS | 见 §9 社交动作参考补充（2026-11-09 补采：Talk/HoldArm/Think/LookAtPhone/WatchPhone 部分 B/C，其余仍 E） | clips/xilang_dialog_standing_列车对话站姿_360p.mp4（仅语境参考） | E | 建议：游戏内千星城 NPC 环境行为录屏，或按「通用NPC动作」接受近似 |
| 22 | `Build02BS` | NPC 社交：建造/Build（沙堡类） 02BS | 见 §9 社交动作参考补充（2026-11-09 补采：Talk/HoldArm/Think/LookAtPhone/WatchPhone 部分 B/C，其余仍 E） | clips/xilang_dialog_standing_列车对话站姿_360p.mp4（仅语境参考） | E | 建议：游戏内千星城 NPC 环境行为录屏，或按「通用NPC动作」接受近似 |
| 23 | `Build02Loop` | NPC 社交：建造/Build（沙堡类） 02Loop | 见 §9 社交动作参考补充（2026-11-09 补采：Talk/HoldArm/Think/LookAtPhone/WatchPhone 部分 B/C，其余仍 E） | clips/xilang_dialog_standing_列车对话站姿_360p.mp4（仅语境参考） | E | 建议：游戏内千星城 NPC 环境行为录屏，或按「通用NPC动作」接受近似 |
| 24 | `Bye01` | NPC 社交：挥手告别/Bye 01 | 见 §9 社交动作参考补充（2026-11-09 补采：Talk/HoldArm/Think/LookAtPhone/WatchPhone 部分 B/C，其余仍 E） | clips/xilang_dialog_standing_列车对话站姿_360p.mp4（仅语境参考） | E | 建议：游戏内千星城 NPC 环境行为录屏，或按「通用NPC动作」接受近似 |
| 25 | `Common_IdleShow` | 站立动作/待机表演 | V1 t=23.0–36.5（试用关卡站立动作/抛硬币，机位较远）；官方 wiki 站立动作 GIF 仍为空占位；米游社 51213852 大世界待机（B）与 77991326 硬币待机对比（B）见 §9.2 | clips/xilang_idleshow_cointoss_站立动作_抛硬币.mp4 | B | 与 Idle_Show_01/02 具体哪一条尚未逐帧确认 |
| 26 | `CoverMouth01AS` | NPC 社交：捂嘴/CoverMouth 01AS | 见 §9 社交动作参考补充（2026-11-09 补采：Talk/HoldArm/Think/LookAtPhone/WatchPhone 部分 B/C，其余仍 E） | clips/xilang_dialog_standing_列车对话站姿_360p.mp4（仅语境参考） | E | 建议：游戏内千星城 NPC 环境行为录屏，或按「通用NPC动作」接受近似 |
| 27 | `CoverMouth01BS` | NPC 社交：捂嘴/CoverMouth 01BS | 见 §9 社交动作参考补充（2026-11-09 补采：Talk/HoldArm/Think/LookAtPhone/WatchPhone 部分 B/C，其余仍 E） | clips/xilang_dialog_standing_列车对话站姿_360p.mp4（仅语境参考） | E | 建议：游戏内千星城 NPC 环境行为录屏，或按「通用NPC动作」接受近似 |
| 28 | `CoverMouth01Loop` | NPC 社交：捂嘴/CoverMouth 01Loop | 见 §9 社交动作参考补充（2026-11-09 补采：Talk/HoldArm/Think/LookAtPhone/WatchPhone 部分 B/C，其余仍 E） | clips/xilang_dialog_standing_列车对话站姿_360p.mp4（仅语境参考） | E | 建议：游戏内千星城 NPC 环境行为录屏，或按「通用NPC动作」接受近似 |
| 29 | `Die` | 眩晕/死亡/复活 | 【缺口】无干净公开素材 | — | E | 建议游戏内录屏 |
| 30 | `Die_Loop` | 眩晕/死亡/复活 | 【缺口】无干净公开素材 | — | E | 建议游戏内录屏 |
| 31 | `FastRun` | 跑步/转身/停跑 | 【缺口】公开视频缺少干净的 45°/90°/180° 转身与急停素材（跟拍/切镜遮挡） | — | C–E |  |
| 32 | `FastRunStop_R` | 跑步/转身/停跑 | 【缺口】公开视频缺少干净的 45°/90°/180° 转身与急停素材（跟拍/切镜遮挡） | — | C–E |  |
| 33 | `FastRun_TurnRight_L` | 跑步/转身/停跑 | 【缺口】公开视频缺少干净的 45°/90°/180° 转身与急停素材（跟拍/切镜遮挡） | — | C–E |  |
| 34 | `Forerake02AS` | NPC 社交：耙沙/Forerake 02AS | 见 §9 社交动作参考补充（2026-11-09 补采：Talk/HoldArm/Think/LookAtPhone/WatchPhone 部分 B/C，其余仍 E） | clips/xilang_dialog_standing_列车对话站姿_360p.mp4（仅语境参考） | E | 建议：游戏内千星城 NPC 环境行为录屏，或按「通用NPC动作」接受近似 |
| 35 | `Forerake02BS` | NPC 社交：耙沙/Forerake 02BS | 见 §9 社交动作参考补充（2026-11-09 补采：Talk/HoldArm/Think/LookAtPhone/WatchPhone 部分 B/C，其余仍 E） | clips/xilang_dialog_standing_列车对话站姿_360p.mp4（仅语境参考） | E | 建议：游戏内千星城 NPC 环境行为录屏，或按「通用NPC动作」接受近似 |
| 36 | `Forerake02Loop` | NPC 社交：耙沙/Forerake 02Loop | 见 §9 社交动作参考补充（2026-11-09 补采：Talk/HoldArm/Think/LookAtPhone/WatchPhone 部分 B/C，其余仍 E） | clips/xilang_dialog_standing_列车对话站姿_360p.mp4（仅语境参考） | E | 建议：游戏内千星城 NPC 环境行为录屏，或按「通用NPC动作」接受近似 |
| 37 | `Hit_H` | 受击/受击眩晕 | 【缺口】战斗视频中受击瞬间被特效遮挡、无干净单条引用。可用战斗视频：V4 BV1WQYH6XEQQ、BV1ZveV6xEjX 等 | — | E | 建议游戏内逐条录屏或接受近似 |
| 38 | `Hit_L` | 受击/受击眩晕 | 【缺口】战斗视频中受击瞬间被特效遮挡、无干净单条引用。可用战斗视频：V4 BV1WQYH6XEQQ、BV1ZveV6xEjX 等 | — | E | 建议游戏内逐条录屏或接受近似 |
| 39 | `Hit_Stun` | 受击/受击眩晕 | 【缺口】战斗视频中受击瞬间被特效遮挡、无干净单条引用。可用战斗视频：V4 BV1WQYH6XEQQ、BV1ZveV6xEjX 等 | — | E | 建议游戏内逐条录屏或接受近似 |
| 40 | `HoldArm01AS` | NPC 社交：抱臂/HoldArm 01AS | 见 §9 社交动作参考补充（2026-11-09 补采：Talk/HoldArm/Think/LookAtPhone/WatchPhone 部分 B/C，其余仍 E） | clips/xilang_dialog_standing_列车对话站姿_360p.mp4（仅语境参考） | E | 建议：游戏内千星城 NPC 环境行为录屏，或按「通用NPC动作」接受近似 |
| 41 | `HoldArm01BS` | NPC 社交：抱臂/HoldArm 01BS | 见 §9 社交动作参考补充（2026-11-09 补采：Talk/HoldArm/Think/LookAtPhone/WatchPhone 部分 B/C，其余仍 E） | clips/xilang_dialog_standing_列车对话站姿_360p.mp4（仅语境参考） | E | 建议：游戏内千星城 NPC 环境行为录屏，或按「通用NPC动作」接受近似 |
| 42 | `HoldArm01HandAS` | NPC 社交：抱臂/HoldArm 01HandAS | 见 §9 社交动作参考补充（2026-11-09 补采：Talk/HoldArm/Think/LookAtPhone/WatchPhone 部分 B/C，其余仍 E） | clips/xilang_dialog_standing_列车对话站姿_360p.mp4（仅语境参考） | E | 建议：游戏内千星城 NPC 环境行为录屏，或按「通用NPC动作」接受近似 |
| 43 | `HoldArm01HandBS` | NPC 社交：抱臂/HoldArm 01HandBS | 见 §9 社交动作参考补充（2026-11-09 补采：Talk/HoldArm/Think/LookAtPhone/WatchPhone 部分 B/C，其余仍 E） | clips/xilang_dialog_standing_列车对话站姿_360p.mp4（仅语境参考） | E | 建议：游戏内千星城 NPC 环境行为录屏，或按「通用NPC动作」接受近似 |
| 44 | `HoldArm01HandLoop` | NPC 社交：抱臂/HoldArm 01HandLoop | 见 §9 社交动作参考补充（2026-11-09 补采：Talk/HoldArm/Think/LookAtPhone/WatchPhone 部分 B/C，其余仍 E） | clips/xilang_dialog_standing_列车对话站姿_360p.mp4（仅语境参考） | E | 建议：游戏内千星城 NPC 环境行为录屏，或按「通用NPC动作」接受近似 |
| 45 | `HoldArm01Loop` | NPC 社交：抱臂/HoldArm 01Loop | 见 §9 社交动作参考补充（2026-11-09 补采：Talk/HoldArm/Think/LookAtPhone/WatchPhone 部分 B/C，其余仍 E） | clips/xilang_dialog_standing_列车对话站姿_360p.mp4（仅语境参考） | E | 建议：游戏内千星城 NPC 环境行为录屏，或按「通用NPC动作」接受近似 |
| 46 | `HoldHead01AS` | NPC 社交：抱头/HoldHead 01AS | 见 §9 社交动作参考补充（2026-11-09 补采：Talk/HoldArm/Think/LookAtPhone/WatchPhone 部分 B/C，其余仍 E） | clips/xilang_dialog_standing_列车对话站姿_360p.mp4（仅语境参考） | E | 建议：游戏内千星城 NPC 环境行为录屏，或按「通用NPC动作」接受近似 |
| 47 | `HoldHead01BS` | NPC 社交：抱头/HoldHead 01BS | 见 §9 社交动作参考补充（2026-11-09 补采：Talk/HoldArm/Think/LookAtPhone/WatchPhone 部分 B/C，其余仍 E） | clips/xilang_dialog_standing_列车对话站姿_360p.mp4（仅语境参考） | E | 建议：游戏内千星城 NPC 环境行为录屏，或按「通用NPC动作」接受近似 |
| 48 | `HoldHead01Loop` | NPC 社交：抱头/HoldHead 01Loop | 见 §9 社交动作参考补充（2026-11-09 补采：Talk/HoldArm/Think/LookAtPhone/WatchPhone 部分 B/C，其余仍 E） | clips/xilang_dialog_standing_列车对话站姿_360p.mp4（仅语境参考） | E | 建议：游戏内千星城 NPC 环境行为录屏，或按「通用NPC动作」接受近似 |
| 49 | `Idle_Show_01` | 站立动作/待机表演 | V1 t=23.0–36.5（试用关卡站立动作/抛硬币，机位较远）；官方 wiki 站立动作 GIF 仍为空占位；米游社 51213852 大世界待机（B）与 77991326 硬币待机对比（B）见 §9.2 | clips/xilang_idleshow_cointoss_站立动作_抛硬币.mp4 | B | 与 Idle_Show_01/02 具体哪一条尚未逐帧确认 |
| 50 | `Idle_Show_02` | 站立动作/待机表演 | V1 t=23.0–36.5（试用关卡站立动作/抛硬币，机位较远）；官方 wiki 站立动作 GIF 仍为空占位；米游社 51213852 大世界待机（B）与 77991326 硬币待机对比（B）见 §9.2 | clips/xilang_idleshow_cointoss_站立动作_抛硬币.mp4 | B | 与 Idle_Show_01/02 具体哪一条尚未逐帧确认 |
| 51 | `Injured01AS` | NPC 社交：受伤/Injured 01AS | 见 §9 社交动作参考补充（2026-11-09 补采：Talk/HoldArm/Think/LookAtPhone/WatchPhone 部分 B/C，其余仍 E） | clips/xilang_dialog_standing_列车对话站姿_360p.mp4（仅语境参考） | E | 建议：游戏内千星城 NPC 环境行为录屏，或按「通用NPC动作」接受近似 |
| 52 | `Injured01BS` | NPC 社交：受伤/Injured 01BS | 见 §9 社交动作参考补充（2026-11-09 补采：Talk/HoldArm/Think/LookAtPhone/WatchPhone 部分 B/C，其余仍 E） | clips/xilang_dialog_standing_列车对话站姿_360p.mp4（仅语境参考） | E | 建议：游戏内千星城 NPC 环境行为录屏，或按「通用NPC动作」接受近似 |
| 53 | `Injured01Loop` | NPC 社交：受伤/Injured 01Loop | 见 §9 社交动作参考补充（2026-11-09 补采：Talk/HoldArm/Think/LookAtPhone/WatchPhone 部分 B/C，其余仍 E） | clips/xilang_dialog_standing_列车对话站姿_360p.mp4（仅语境参考） | E | 建议：游戏内千星城 NPC 环境行为录屏，或按「通用NPC动作」接受近似 |
| 54 | `LookAtPhoneAS` | NPC 社交：看手机/LookAtPhone AS | 见 §9 社交动作参考补充（2026-11-09 补采：Talk/HoldArm/Think/LookAtPhone/WatchPhone 部分 B/C，其余仍 E） | clips/xilang_dialog_standing_列车对话站姿_360p.mp4（仅语境参考） | E | 建议：游戏内千星城 NPC 环境行为录屏，或按「通用NPC动作」接受近似 |
| 55 | `LookAtPhoneBS` | NPC 社交：看手机/LookAtPhone BS | 见 §9 社交动作参考补充（2026-11-09 补采：Talk/HoldArm/Think/LookAtPhone/WatchPhone 部分 B/C，其余仍 E） | clips/xilang_dialog_standing_列车对话站姿_360p.mp4（仅语境参考） | E | 建议：游戏内千星城 NPC 环境行为录屏，或按「通用NPC动作」接受近似 |
| 56 | `LookAtPhoneLoop` | NPC 社交：看手机/LookAtPhone Loop | 见 §9 社交动作参考补充（2026-11-09 补采：Talk/HoldArm/Think/LookAtPhone/WatchPhone 部分 B/C，其余仍 E） | clips/xilang_dialog_standing_列车对话站姿_360p.mp4（仅语境参考） | E | 建议：游戏内千星城 NPC 环境行为录屏，或按「通用NPC动作」接受近似 |
| 57 | `MazeAttack01` | 大世界/秘技攻击 | V11 t=00:00–00:03（大世界攻击片段） | — | C | 未切 clip |
| 58 | `MazeSkill01` | 秘技（MazeSkill01） | W4 官方秘技GIF；V4 t≈00:58–01:04 冲浪位移 | clips/official_skill_miji_秘技.mp4；clips/xilang_miji_wavedash_秘技冲浪_待确认.mp4 | B | V4 该段为实机杂糅，秘技动作与镜头切换需人工确认 |
| 59 | `PutHand01AS` | NPC 社交：手部姿势/PutHand 01AS | 见 §9 社交动作参考补充（2026-11-09 补采：Talk/HoldArm/Think/LookAtPhone/WatchPhone 部分 B/C，其余仍 E） | clips/xilang_dialog_standing_列车对话站姿_360p.mp4（仅语境参考） | E | 建议：游戏内千星城 NPC 环境行为录屏，或按「通用NPC动作」接受近似 |
| 60 | `PutHand01BS` | NPC 社交：手部姿势/PutHand 01BS | 见 §9 社交动作参考补充（2026-11-09 补采：Talk/HoldArm/Think/LookAtPhone/WatchPhone 部分 B/C，其余仍 E） | clips/xilang_dialog_standing_列车对话站姿_360p.mp4（仅语境参考） | E | 建议：游戏内千星城 NPC 环境行为录屏，或按「通用NPC动作」接受近似 |
| 61 | `PutHand01Loop` | NPC 社交：手部姿势/PutHand 01Loop | 见 §9 社交动作参考补充（2026-11-09 补采：Talk/HoldArm/Think/LookAtPhone/WatchPhone 部分 B/C，其余仍 E） | clips/xilang_dialog_standing_列车对话站姿_360p.mp4（仅语境参考） | E | 建议：游戏内千星城 NPC 环境行为录屏，或按「通用NPC动作」接受近似 |
| 62 | `Revive` | 眩晕/死亡/复活 | 【缺口】无干净公开素材 | — | E | 建议游戏内录屏 |
| 63 | `Run` | 跑步/转身/停跑 | 【缺口】公开视频缺少干净的 45°/90°/180° 转身与急停素材（跟拍/切镜遮挡） | — | C–E |  |
| 64 | `RunStop_L` | 跑步/转身/停跑 | 【缺口】公开视频缺少干净的 45°/90°/180° 转身与急停素材（跟拍/切镜遮挡） | — | C–E |  |
| 65 | `RunStop_R` | 跑步/转身/停跑 | 【缺口】公开视频缺少干净的 45°/90°/180° 转身与急停素材（跟拍/切镜遮挡） | — | C–E |  |
| 66 | `Run_BS_L` | 跑步/转身/停跑 | 【缺口】公开视频缺少干净的 45°/90°/180° 转身与急停素材（跟拍/切镜遮挡） | — | C–E |  |
| 67 | `Run_BS_R` | 跑步/转身/停跑 | 【缺口】公开视频缺少干净的 45°/90°/180° 转身与急停素材（跟拍/切镜遮挡） | — | C–E |  |
| 68 | `Run_TurnLeft_L` | 跑步/转身/停跑 | 【缺口】公开视频缺少干净的 45°/90°/180° 转身与急停素材（跟拍/切镜遮挡） | — | C–E |  |
| 69 | `Run_TurnLeft_R` | 跑步/转身/停跑 | 【缺口】公开视频缺少干净的 45°/90°/180° 转身与急停素材（跟拍/切镜遮挡） | — | C–E |  |
| 70 | `Run_TurnRight_L` | 跑步/转身/停跑 | 【缺口】公开视频缺少干净的 45°/90°/180° 转身与急停素材（跟拍/切镜遮挡） | — | C–E |  |
| 71 | `Run_TurnRight_R` | 跑步/转身/停跑 | 【缺口】公开视频缺少干净的 45°/90°/180° 转身与急停素材（跟拍/切镜遮挡） | — | C–E |  |
| 72 | `ScratchHead01AS` | NPC 社交：挠头/ScratchHead 01AS | 见 §9 社交动作参考补充（2026-11-09 补采：Talk/HoldArm/Think/LookAtPhone/WatchPhone 部分 B/C，其余仍 E） | clips/xilang_dialog_standing_列车对话站姿_360p.mp4（仅语境参考） | E | 建议：游戏内千星城 NPC 环境行为录屏，或按「通用NPC动作」接受近似 |
| 73 | `ScratchHead01BS` | NPC 社交：挠头/ScratchHead 01BS | 见 §9 社交动作参考补充（2026-11-09 补采：Talk/HoldArm/Think/LookAtPhone/WatchPhone 部分 B/C，其余仍 E） | clips/xilang_dialog_standing_列车对话站姿_360p.mp4（仅语境参考） | E | 建议：游戏内千星城 NPC 环境行为录屏，或按「通用NPC动作」接受近似 |
| 74 | `ScratchHead01Loop` | NPC 社交：挠头/ScratchHead 01Loop | 见 §9 社交动作参考补充（2026-11-09 补采：Talk/HoldArm/Think/LookAtPhone/WatchPhone 部分 B/C，其余仍 E） | clips/xilang_dialog_standing_列车对话站姿_360p.mp4（仅语境参考） | E | 建议：游戏内千星城 NPC 环境行为录屏，或按「通用NPC动作」接受近似 |
| 75 | `Shrug01AS` | NPC 社交：耸肩/Shrug 01AS | 见 §9 社交动作参考补充（2026-11-09 补采：Talk/HoldArm/Think/LookAtPhone/WatchPhone 部分 B/C，其余仍 E） | clips/xilang_dialog_standing_列车对话站姿_360p.mp4（仅语境参考） | E | 建议：游戏内千星城 NPC 环境行为录屏，或按「通用NPC动作」接受近似 |
| 76 | `Shrug01BS` | NPC 社交：耸肩/Shrug 01BS | 见 §9 社交动作参考补充（2026-11-09 补采：Talk/HoldArm/Think/LookAtPhone/WatchPhone 部分 B/C，其余仍 E） | clips/xilang_dialog_standing_列车对话站姿_360p.mp4（仅语境参考） | E | 建议：游戏内千星城 NPC 环境行为录屏，或按「通用NPC动作」接受近似 |
| 77 | `Shrug01Loop` | NPC 社交：耸肩/Shrug 01Loop | 见 §9 社交动作参考补充（2026-11-09 补采：Talk/HoldArm/Think/LookAtPhone/WatchPhone 部分 B/C，其余仍 E） | clips/xilang_dialog_standing_列车对话站姿_360p.mp4（仅语境参考） | E | 建议：游戏内千星城 NPC 环境行为录屏，或按「通用NPC动作」接受近似 |
| 78 | `Skill01` | 普攻（Skill01） | V13 t=00:00–00:02.2（画面标注「普攻」）；W1 官方GIF | clips/labeled_puwang_普攻.mp4；clips/official_skill_puwang_普攻.mp4 | A |  |
| 79 | `Skill01ReadyBS` | 普攻准备待机 | 无独立公开素材；用战斗待机/技能准备段近似：V10 t=00:00–00:10.6、V4 t=00:00–00:14 | clips/xilang_standby_battle_arena_戏浪战斗待机.mp4 | C | Ready/循环待机未单独验证 |
| 80 | `Skill01ReadyLoop` | 普攻准备待机 | 无独立公开素材；用战斗待机/技能准备段近似：V10 t=00:00–00:10.6、V4 t=00:00–00:14 | clips/xilang_standby_battle_arena_戏浪战斗待机.mp4 | C | Ready/循环待机未单独验证 |
| 81 | `Skill01_Ready` | 普攻准备待机 | 无独立公开素材；用战斗待机/技能准备段近似：V10 t=00:00–00:10.6、V4 t=00:00–00:14 | clips/xilang_standby_battle_arena_戏浪战斗待机.mp4 | C | Ready/循环待机未单独验证 |
| 82 | `Skill01_Ready_Loop` | 普攻准备待机 | 无独立公开素材；用战斗待机/技能准备段近似：V10 t=00:00–00:10.6、V4 t=00:00–00:14 | clips/xilang_standby_battle_arena_戏浪战斗待机.mp4 | C | Ready/循环待机未单独验证 |
| 83 | `Skill01toSkill02` | 技能衔接过渡 | 【缺口】无公开素材 | — | E |  |
| 84 | `Skill02` | 战技（Skill02） | V13 t=00:02.0–00:08.6（画面标注「战技」）；W2 官方GIF | clips/labeled_zhanji_战技.mp4；clips/official_skill_zhanji_战技.mp4 | A |  |
| 85 | `Skill02ReadyLoop` | 战技准备待机 | 无独立公开素材；用战斗待机/技能准备段近似：V10 t=00:00–00:10.6、V4 t=00:00–00:14 | clips/xilang_standby_battle_arena_戏浪战斗待机.mp4 | C | Ready/循环待机未单独验证 |
| 86 | `Skill02_Ready_Loop` | 战技准备待机 | 无独立公开素材；用战斗待机/技能准备段近似：V10 t=00:00–00:10.6、V4 t=00:00–00:14 | clips/xilang_standby_battle_arena_戏浪战斗待机.mp4 | C | Ready/循环待机未单独验证 |
| 87 | `Skill02toSkill01` | 技能衔接过渡 | 【缺口】无公开素材 | — | E |  |
| 88 | `Skill03` | 终结技（Skill03） | V13 t=00:15.4–00:26.5（画面标注「大招」）；W3 官方GIF | clips/labeled_ultimate_大招.mp4；clips/official_skill_zhongjieji_终结技.mp4 | A |  |
| 89 | `Skill03_Ready` | 终结技准备待机 | 无独立公开素材；用战斗待机/技能准备段近似：V10 t=00:00–00:10.6、V4 t=00:00–00:14 | clips/xilang_standby_battle_arena_戏浪战斗待机.mp4 | C | Ready/循环待机未单独验证 |
| 90 | `Skill04` | 欢愉技（Skill04 系） | V13 t=00:08.5–00:15.4（画面标注「欢愉时刻」）；W5/W6 官方GIF | clips/labeled_huanyu_moment_欢愉时刻.mp4；clips/official_skill_huanyuji_欢愉技.mp4；clips/official_skill_qianghua_huanyuji_强化欢愉技.mp4 | B | Skill04/Skill41 与「欢愉技/强化欢愉技」的对应关系按命名推断 |
| 91 | `Skill04 (2)` | 欢愉技（Skill04 系） | V13 t=00:08.5–00:15.4（画面标注「欢愉时刻」）；W5/W6 官方GIF | clips/labeled_huanyu_moment_欢愉时刻.mp4；clips/official_skill_huanyuji_欢愉技.mp4；clips/official_skill_qianghua_huanyuji_强化欢愉技.mp4 | B | Skill04/Skill41 与「欢愉技/强化欢愉技」的对应关系按命名推断 |
| 92 | `Skill04_Ready` | 欢愉技准备待机 | 无独立公开素材；用战斗待机/技能准备段近似：V10 t=00:00–00:10.6、V4 t=00:00–00:14 | clips/xilang_standby_battle_arena_戏浪战斗待机.mp4 | C | Ready/循环待机未单独验证 |
| 93 | `Skill04_Ready_Loop` | 欢愉技准备待机 | 无独立公开素材；用战斗待机/技能准备段近似：V10 t=00:00–00:10.6、V4 t=00:00–00:14 | clips/xilang_standby_battle_arena_戏浪战斗待机.mp4 | C | Ready/循环待机未单独验证 |
| 94 | `Skill41` | 强化欢愉技（Skill41） | V13 t=00:08.5–00:15.4（画面标注「欢愉时刻」）；W5/W6 官方GIF | clips/labeled_huanyu_moment_欢愉时刻.mp4；clips/official_skill_huanyuji_欢愉技.mp4；clips/official_skill_qianghua_huanyuji_强化欢愉技.mp4 | B | Skill04/Skill41 与「欢愉技/强化欢愉技」的对应关系按命名推断 |
| 95 | `Snap01AS` | NPC 社交：打响指/Snap 01AS | 见 §9 社交动作参考补充（2026-11-09 补采：Talk/HoldArm/Think/LookAtPhone/WatchPhone 部分 B/C，其余仍 E） | clips/xilang_dialog_standing_列车对话站姿_360p.mp4（仅语境参考） | E | 建议：游戏内千星城 NPC 环境行为录屏，或按「通用NPC动作」接受近似 |
| 96 | `Snap01BS` | NPC 社交：打响指/Snap 01BS | 见 §9 社交动作参考补充（2026-11-09 补采：Talk/HoldArm/Think/LookAtPhone/WatchPhone 部分 B/C，其余仍 E） | clips/xilang_dialog_standing_列车对话站姿_360p.mp4（仅语境参考） | E | 建议：游戏内千星城 NPC 环境行为录屏，或按「通用NPC动作」接受近似 |
| 97 | `Snap01Loop` | NPC 社交：打响指/Snap 01Loop | 见 §9 社交动作参考补充（2026-11-09 补采：Talk/HoldArm/Think/LookAtPhone/WatchPhone 部分 B/C，其余仍 E） | clips/xilang_dialog_standing_列车对话站姿_360p.mp4（仅语境参考） | E | 建议：游戏内千星城 NPC 环境行为录屏，或按「通用NPC动作」接受近似 |
| 98 | `StandBy` | 战斗待机/攻击待机 | V10 t=00:00–00:10.6；V4 t=00:00–00:14 | clips/xilang_standby_battle_arena_戏浪战斗待机.mp4；clips/xilang_standby_battle_arena2_戏浪战斗待机.mp4 | B |  |
| 99 | `StandBy (2)` | 战斗待机/攻击待机 | V10 t=00:00–00:10.6；V4 t=00:00–00:14 | clips/xilang_standby_battle_arena_戏浪战斗待机.mp4；clips/xilang_standby_battle_arena2_戏浪战斗待机.mp4 | B |  |
| 100 | `State_Stun` | 眩晕/死亡/复活 | 【缺口】无干净公开素材 | — | E | 建议游戏内录屏 |
| 101 | `State_Stun_Loop` | 眩晕/死亡/复活 | 【缺口】无干净公开素材 | — | E | 建议游戏内录屏 |
| 102 | `State_Stun_Recover` | 眩晕/死亡/复活 | 【缺口】无干净公开素材 | — | E | 建议游戏内录屏 |
| 103 | `StrikeChest01AS` | NPC 社交：捶胸/StrikeChest 01AS | 见 §9 社交动作参考补充（2026-11-09 补采：Talk/HoldArm/Think/LookAtPhone/WatchPhone 部分 B/C，其余仍 E） | clips/xilang_dialog_standing_列车对话站姿_360p.mp4（仅语境参考） | E | 建议：游戏内千星城 NPC 环境行为录屏，或按「通用NPC动作」接受近似 |
| 104 | `StrikeChest01BS` | NPC 社交：捶胸/StrikeChest 01BS | 见 §9 社交动作参考补充（2026-11-09 补采：Talk/HoldArm/Think/LookAtPhone/WatchPhone 部分 B/C，其余仍 E） | clips/xilang_dialog_standing_列车对话站姿_360p.mp4（仅语境参考） | E | 建议：游戏内千星城 NPC 环境行为录屏，或按「通用NPC动作」接受近似 |
| 105 | `StrikeChest01Loop` | NPC 社交：捶胸/StrikeChest 01Loop | 见 §9 社交动作参考补充（2026-11-09 补采：Talk/HoldArm/Think/LookAtPhone/WatchPhone 部分 B/C，其余仍 E） | clips/xilang_dialog_standing_列车对话站姿_360p.mp4（仅语境参考） | E | 建议：游戏内千星城 NPC 环境行为录屏，或按「通用NPC动作」接受近似 |
| 106 | `Talk01` | NPC 社交：说话/Talk 01 | 见 §9 社交动作参考补充（2026-11-09 补采：Talk/HoldArm/Think/LookAtPhone/WatchPhone 部分 B/C，其余仍 E） | clips/xilang_dialog_standing_列车对话站姿_360p.mp4（仅语境参考） | E | 建议：游戏内千星城 NPC 环境行为录屏，或按「通用NPC动作」接受近似 |
| 107 | `Talk02` | NPC 社交：说话/Talk 02 | 见 §9 社交动作参考补充（2026-11-09 补采：Talk/HoldArm/Think/LookAtPhone/WatchPhone 部分 B/C，其余仍 E） | clips/xilang_dialog_standing_列车对话站姿_360p.mp4（仅语境参考） | E | 建议：游戏内千星城 NPC 环境行为录屏，或按「通用NPC动作」接受近似 |
| 108 | `TeamStandBy` | 队伍待机 | 【缺口】队伍界面/编队界面里戏浪的干净镜头未找到（已下的两个队伍界面视频里没有砂金）；暂用战斗待机节奏近似 | — | E |  |
| 109 | `Think01AS` | NPC 社交：思考/Think 01AS | 见 §9 社交动作参考补充（2026-11-09 补采：Talk/HoldArm/Think/LookAtPhone/WatchPhone 部分 B/C，其余仍 E） | clips/xilang_dialog_standing_列车对话站姿_360p.mp4（仅语境参考） | E | 建议：游戏内千星城 NPC 环境行为录屏，或按「通用NPC动作」接受近似 |
| 110 | `Think01BS` | NPC 社交：思考/Think 01BS | 见 §9 社交动作参考补充（2026-11-09 补采：Talk/HoldArm/Think/LookAtPhone/WatchPhone 部分 B/C，其余仍 E） | clips/xilang_dialog_standing_列车对话站姿_360p.mp4（仅语境参考） | E | 建议：游戏内千星城 NPC 环境行为录屏，或按「通用NPC动作」接受近似 |
| 111 | `Think01HandAS` | NPC 社交：思考/Think 01HandAS | 见 §9 社交动作参考补充（2026-11-09 补采：Talk/HoldArm/Think/LookAtPhone/WatchPhone 部分 B/C，其余仍 E） | clips/xilang_dialog_standing_列车对话站姿_360p.mp4（仅语境参考） | E | 建议：游戏内千星城 NPC 环境行为录屏，或按「通用NPC动作」接受近似 |
| 112 | `Think01HandBS` | NPC 社交：思考/Think 01HandBS | 见 §9 社交动作参考补充（2026-11-09 补采：Talk/HoldArm/Think/LookAtPhone/WatchPhone 部分 B/C，其余仍 E） | clips/xilang_dialog_standing_列车对话站姿_360p.mp4（仅语境参考） | E | 建议：游戏内千星城 NPC 环境行为录屏，或按「通用NPC动作」接受近似 |
| 113 | `Think01HandLoop` | NPC 社交：思考/Think 01HandLoop | 见 §9 社交动作参考补充（2026-11-09 补采：Talk/HoldArm/Think/LookAtPhone/WatchPhone 部分 B/C，其余仍 E） | clips/xilang_dialog_standing_列车对话站姿_360p.mp4（仅语境参考） | E | 建议：游戏内千星城 NPC 环境行为录屏，或按「通用NPC动作」接受近似 |
| 114 | `Think01Loop` | NPC 社交：思考/Think 01Loop | 见 §9 社交动作参考补充（2026-11-09 补采：Talk/HoldArm/Think/LookAtPhone/WatchPhone 部分 B/C，其余仍 E） | clips/xilang_dialog_standing_列车对话站姿_360p.mp4（仅语境参考） | E | 建议：游戏内千星城 NPC 环境行为录屏，或按「通用NPC动作」接受近似 |
| 115 | `Tpose` | T-pose 参考姿势 | n/a：源资产绑定姿势，非表演动作 | — | n/a | 不在实机对照范围 |
| 116 | `Turn_180_L` | 跑步/转身/停跑 | 【缺口】公开视频缺少干净的 45°/90°/180° 转身与急停素材（跟拍/切镜遮挡） | — | C–E |  |
| 117 | `Turn_180_R` | 跑步/转身/停跑 | 【缺口】公开视频缺少干净的 45°/90°/180° 转身与急停素材（跟拍/切镜遮挡） | — | C–E |  |
| 118 | `Turn_45_L` | 跑步/转身/停跑 | 【缺口】公开视频缺少干净的 45°/90°/180° 转身与急停素材（跟拍/切镜遮挡） | — | C–E |  |
| 119 | `Turn_45_R` | 跑步/转身/停跑 | 【缺口】公开视频缺少干净的 45°/90°/180° 转身与急停素材（跟拍/切镜遮挡） | — | C–E |  |
| 120 | `Turn_90_L` | 跑步/转身/停跑 | 【缺口】公开视频缺少干净的 45°/90°/180° 转身与急停素材（跟拍/切镜遮挡） | — | C–E |  |
| 121 | `Turn_90_R` | 跑步/转身/停跑 | 【缺口】公开视频缺少干净的 45°/90°/180° 转身与急停素材（跟拍/切镜遮挡） | — | C–E |  |
| 122 | `UseHeadPhone01AS` | NPC 社交：戴耳机/UseHeadPhone 01AS | 见 §9 社交动作参考补充（2026-11-09 补采：Talk/HoldArm/Think/LookAtPhone/WatchPhone 部分 B/C，其余仍 E） | clips/xilang_dialog_standing_列车对话站姿_360p.mp4（仅语境参考） | E | 建议：游戏内千星城 NPC 环境行为录屏，或按「通用NPC动作」接受近似 |
| 123 | `UseHeadPhone01BS` | NPC 社交：戴耳机/UseHeadPhone 01BS | 见 §9 社交动作参考补充（2026-11-09 补采：Talk/HoldArm/Think/LookAtPhone/WatchPhone 部分 B/C，其余仍 E） | clips/xilang_dialog_standing_列车对话站姿_360p.mp4（仅语境参考） | E | 建议：游戏内千星城 NPC 环境行为录屏，或按「通用NPC动作」接受近似 |
| 124 | `UseHeadPhone01Loop` | NPC 社交：戴耳机/UseHeadPhone 01Loop | 见 §9 社交动作参考补充（2026-11-09 补采：Talk/HoldArm/Think/LookAtPhone/WatchPhone 部分 B/C，其余仍 E） | clips/xilang_dialog_standing_列车对话站姿_360p.mp4（仅语境参考） | E | 建议：游戏内千星城 NPC 环境行为录屏，或按「通用NPC动作」接受近似 |
| 125 | `UseProp01` | NPC 社交：使用道具/UseProp 01 | 见 §9 社交动作参考补充（2026-11-09 补采：Talk/HoldArm/Think/LookAtPhone/WatchPhone 部分 B/C，其余仍 E） | clips/xilang_dialog_standing_列车对话站姿_360p.mp4（仅语境参考） | E | 建议：游戏内千星城 NPC 环境行为录屏，或按「通用NPC动作」接受近似 |
| 126 | `UseProp02` | NPC 社交：使用道具/UseProp 02 | 见 §9 社交动作参考补充（2026-11-09 补采：Talk/HoldArm/Think/LookAtPhone/WatchPhone 部分 B/C，其余仍 E） | clips/xilang_dialog_standing_列车对话站姿_360p.mp4（仅语境参考） | E | 建议：游戏内千星城 NPC 环境行为录屏，或按「通用NPC动作」接受近似 |
| 127 | `Walk` | 走路/停步 | V1 t=03.0–17.0（试用关卡走动/跑动）；V4 偶发走位；4.5 剧情 cut 千星城街道 1:14–1:30（C） | clips/xilang_walk_run_trial_走路跑步.mp4 | B–C | V1 机位跟随，步态细节一般；4.5 剧情/大世界视频可补充 |
| 128 | `WalkStop_L` | 走路/停步 | V1 t=03.0–17.0（试用关卡走动/跑动）；V4 偶发走位；4.5 剧情 cut 千星城街道 1:14–1:30（C） | clips/xilang_walk_run_trial_走路跑步.mp4 | B–C | V1 机位跟随，步态细节一般；4.5 剧情/大世界视频可补充 |
| 129 | `WalkStop_R` | 走路/停步 | V1 t=03.0–17.0（试用关卡走动/跑动）；V4 偶发走位；4.5 剧情 cut 千星城街道 1:14–1:30（C） | clips/xilang_walk_run_trial_走路跑步.mp4 | B–C | V1 机位跟随，步态细节一般；4.5 剧情/大世界视频可补充 |
| 130 | `WatchPhone01AS` | NPC 社交：看手机（看）/WatchPhone 01AS | 见 §9 社交动作参考补充（2026-11-09 补采：Talk/HoldArm/Think/LookAtPhone/WatchPhone 部分 B/C，其余仍 E） | clips/xilang_dialog_standing_列车对话站姿_360p.mp4（仅语境参考） | E | 建议：游戏内千星城 NPC 环境行为录屏，或按「通用NPC动作」接受近似 |
| 131 | `WatchPhone01BS` | NPC 社交：看手机（看）/WatchPhone 01BS | 见 §9 社交动作参考补充（2026-11-09 补采：Talk/HoldArm/Think/LookAtPhone/WatchPhone 部分 B/C，其余仍 E） | clips/xilang_dialog_standing_列车对话站姿_360p.mp4（仅语境参考） | E | 建议：游戏内千星城 NPC 环境行为录屏，或按「通用NPC动作」接受近似 |
| 132 | `WatchPhone01Loop` | NPC 社交：看手机（看）/WatchPhone 01Loop | 见 §9 社交动作参考补充（2026-11-09 补采：Talk/HoldArm/Think/LookAtPhone/WatchPhone 部分 B/C，其余仍 E） | clips/xilang_dialog_standing_列车对话站姿_360p.mp4（仅语境参考） | E | 建议：游戏内千星城 NPC 环境行为录屏，或按「通用NPC动作」接受近似 |
| 133 | `Worry01AS` | NPC 社交：担忧/Worry 01AS | 见 §9 社交动作参考补充（2026-11-09 补采：Talk/HoldArm/Think/LookAtPhone/WatchPhone 部分 B/C，其余仍 E） | clips/xilang_dialog_standing_列车对话站姿_360p.mp4（仅语境参考） | E | 建议：游戏内千星城 NPC 环境行为录屏，或按「通用NPC动作」接受近似 |
| 134 | `Worry01BS` | NPC 社交：担忧/Worry 01BS | 见 §9 社交动作参考补充（2026-11-09 补采：Talk/HoldArm/Think/LookAtPhone/WatchPhone 部分 B/C，其余仍 E） | clips/xilang_dialog_standing_列车对话站姿_360p.mp4（仅语境参考） | E | 建议：游戏内千星城 NPC 环境行为录屏，或按「通用NPC动作」接受近似 |
| 135 | `Worry01Loop` | NPC 社交：担忧/Worry 01Loop | 见 §9 社交动作参考补充（2026-11-09 补采：Talk/HoldArm/Think/LookAtPhone/WatchPhone 部分 B/C，其余仍 E） | clips/xilang_dialog_standing_列车对话站姿_360p.mp4（仅语境参考） | E | 建议：游戏内千星城 NPC 环境行为录屏，或按「通用NPC动作」接受近似 |
| 136 | `Worry02AS` | NPC 社交：担忧/Worry 02AS | 见 §9 社交动作参考补充（2026-11-09 补采：Talk/HoldArm/Think/LookAtPhone/WatchPhone 部分 B/C，其余仍 E） | clips/xilang_dialog_standing_列车对话站姿_360p.mp4（仅语境参考） | E | 建议：游戏内千星城 NPC 环境行为录屏，或按「通用NPC动作」接受近似 |
| 137 | `Worry02BS` | NPC 社交：担忧/Worry 02BS | 见 §9 社交动作参考补充（2026-11-09 补采：Talk/HoldArm/Think/LookAtPhone/WatchPhone 部分 B/C，其余仍 E） | clips/xilang_dialog_standing_列车对话站姿_360p.mp4（仅语境参考） | E | 建议：游戏内千星城 NPC 环境行为录屏，或按「通用NPC动作」接受近似 |
| 138 | `Worry02Loop` | NPC 社交：担忧/Worry 02Loop | 见 §9 社交动作参考补充（2026-11-09 补采：Talk/HoldArm/Think/LookAtPhone/WatchPhone 部分 B/C，其余仍 E） | clips/xilang_dialog_standing_列车对话站姿_360p.mp4（仅语境参考） | E | 建议：游戏内千星城 NPC 环境行为录屏，或按「通用NPC动作」接受近似 |

---

## 7. 缺口、限制与建议（验收前必读）

### 7.1 硬缺口（公开素材没有）

1. **NPC 社交动作 80 条**（Akimbo/Talk/Think/Worry/Shrug/ScratchHead/LookAtPhone/WatchPhone/UseHeadPhone/Snap/Bye/CoverMouth/HoldArm/HoldHead/Injured/Alert/BackWard/Build/Forerake/PutHand/StrikeChest/UseProp 及其 AS/BS/Loop/Hand 变体）：
   - 这些是 HSR **通用人类 NPC 社交动画集**（同骨架的其他角色/NPC 也在用），公开视频**没有被逐条录下来**；B 站搜索 “NPC 动作 / 社交动作 / 待机动作 合集” **没有找到砂金或戏浪的逐条素材**。
   - **2026-11-09 补采进展（详见 §9）**：米游社渠道打通 + `BV1Kd4R6BEYh`（81min 剧情 cut）扫片 + 通用 NPC 合集后，**Talk01/02 → B（2 takes）**，**HoldArm01 / LookAtPhone / WatchPhone01 / Think01 → C（约 20 takes）**，其余约 57 takes 仍 E。
   - 候选路径（按性价比）：
     a. **游戏内录屏（推荐）**：4.5 千星城（Qianxing City / 度假村）里砂金作为 NPC 的环境行为、或车站/列车对话中触发的动作；录制 1080p60 最好；
     b. 下载 `BV1Kd4R6BEYh`（81min 4K 千星城剧情完整 cut）逐段扫，找砂金 NPC 站姿/手势（成本高、需人工）；
     c. 按「同一套通用 NPC 动画」接受近似：从任意同骨架 NPC 视频取同名动作即可（需要先确认游戏内存在该通用动作）；
     d. 若都不行 → 验收时把社交动作降级为「姿态/节奏合理性抽查」，不要按 A 级逐帧对拍。
2. **Hit_H / Hit_L / Hit_Stun / BeHit / State_Stun* / Die* / Revive**：战斗视频里这些瞬间都被打击特效/镜头震动/慢放遮住，且没有公开的「受击动作展示」合集。→ 只能游戏内录屏（可用练习/模拟宇宙敌我同屏反复触发）。
3. **TeamStandBy**：需要“队伍界面/编队界面”里戏浪的干净镜头；公开视频里没找到（找到的两个队伍界面视频里没有砂金）。→ 队伍界面截屏/录屏最直接。
4. **转身/急停（Turn_45/90/180、RunStop、WalkStop、Run_BS）**：公开视频里转身镜头都被切走或跟拍遮挡 → 建议游戏内原地转向/急停录屏。
5. **戏浪 Idle_Show_01/02 的官方 GIF**：wiki 仍空占位；V1 的试用关卡站立动作 **只能确认到“有一条抛硬币的站立动作”**，无法可靠区分 01 vs 02。→ 若要严格区分，需游戏内角色详情界面各录 1 条。

### 7.2 环境限制（已记录，未绕过）

- **B 站未登录**：最高 1080p30；`1080P60 / 4K / 1080P高码率` 需大会员 → 本次**未使用任何账号密码/cookies 登录**。若验收需要 4K/60（例如看手指细节），**需要用户提供**（或由用户自行下载后放入 `work/ref-aventurine/video/`）。
- **YouTube 不通**：官方 HoYoverse YouTube 频道视频无法抓取；仅记录 URL 入口（如 <https://www.youtube.com/@HonkaiStarRail>）。
- **HoYoLab/HoYoWiki 区域封锁**：官方 wiki(1920/6566) 页面 403；官方资料以 B 站官方号 + Biligame wiki 镜像替代。
- yt-dlp 搜索/API 有风控：需要 cookie jar + ≥3s 间隔，否则返回 HTML；`tools/bili_search.py` 已处理。
- 部分视频 UP 主为**前瞻/测试服泄漏**内容（如 `BV1pHgK6UEY6`），证据等级应低于正式服视频；本包已把它标为“辅助参考”。

### 7.3 建议的验收操作流程（逐条动作）

1. 从 §6 表查到该 take 的参考来源与时间段；
2. 抽参考帧：`ffmpeg -ss <start> -to <end> -i <本地视频> -vf fps=10 ref/%04d.png`（或直接看 `clips/` 现成片段）；
3. 用本项目管线渲染同一条 clip（three-vrm / Unity GT 均可），同 fps 抽帧；
4. 生成并排对比图（左=官方参考、右=本项目渲染；按 0/25/50/75/100% 相位取 5–8 帧），检查：**全身姿态轮廓、手脚轨迹、重心移动、起止帧、时长/节拍**；
5. 结论标注 A/B/C/E 等级并留图到 `work/ref-aventurine/verify/`（建议新建，不提交）。

---

## 8. 附件清单

### 8.1 已下载视频（47 个 mp4，合计约 683MB；`work/ref-aventurine/video/`）

> 下表按“有 info.json 元数据的源视频（22 条）”列出；另有 `BV1E8bG6GE1s_p2 … p11` 共 10 个列车对话 360p 分P（无 info.json），未单列。全部 1080p 视频均为免登录可下的 1080p30（非 4K/60）。

| 本地文件（work/ref-aventurine/video/） | 标题 | UP主 | 时长 | 体积 |
|---|---|---|---|---|
| `BV1HcbC6YEoE` | 4K砂金戏浪全技能慢放 | 1emonTxT | 102.702s | 23.1MB |
| `BV19qgK6qEb6_p1` | 《崩坏：星穹铁道》4.5版本PV：「挥掷千星的筹码」 p01 《崩坏：星穹铁道》4.5版本PV：「挥掷千星的筹码」 | 崩坏星穹铁道 | 192.874s | 38.5MB |
| `BV1JCgN6yEkf_p1` | 《崩坏：星穹铁道》「星际和平导览：千星城旅游指南」 p01 《崩坏：星穹铁道》「星际和平导览：千星城旅游指南」 | 帕姆的收藏夹 | 82.433s | 14.8MB |
| `BV1yjYx6AEp7_p1` | 《崩坏：星穹铁道》砂金•戏浪角色PV——「独家爆料」 p01 《崩坏：星穹铁道》砂金•戏浪角色PV——「独家爆料」 | 崩坏星穹铁道 | 111.552s | 30.9MB |
| `BV12Ceq6MEQC` | 【崩坏星穹铁道】全角色技能展示——砂金•戏浪 | 魔法盒Magesbox | 82.245s | 18.2MB |
| `BV1FctA67EKY` | 【崩坏：星穹铁道】千星城熟人！《莫愁前路无知己》过去版本四名NPC熟人千星城相遇对话隐藏成就获取详细指引 | 赤风の夜 | 91.811s | 42.7MB |
| `BV1E8bG6GE1s_p1` | 【星铁】砂金·戏浪列车对话 p01 初次上车 | 粉红公主 | 73.049s | 1.6MB |
| `BV1vq421A7fQ` | 【星铁】试用砂金2款待机动作+普攻+秘技（自留） | 清新宜人好青年 | 41.94s | 16.4MB |
| `BV1k8d3Y7E8d` | 以防你没见过队伍界面所有人一起做待机动作 | 昵称3836 | 130.555s | 22.4MB |
| `BV1dV8Q6JEoo` | 原来砂金也是带着任务来的！钻石要求砂金找出石心十人的叛徒！！要一命抵一石！【崩坏星穹铁道4.5版本「挥掷千星的筹码」高光剧情收录】 | 原神高玩专家-向晚 | 124.714s | 7.1MB |
| `BV14fRLB8EWm` | 在队伍里也能看角色的待机动作？ | 辞轩よ | 52.633s | 5.0MB |
| `BV1mYTn6dEQL` | 崩坏星穹铁道 砂金•戏浪 实机演示 | 欢愉令使-龘龘鸭鸭 | 56.857s | 10.3MB |
| `BV1pHgK6UEY6` | 崩铁4.5新角色，砂金戏浪技能实机展示，SP砂金是格调战舰的，崩铁4.5前瞻 | 裂-瞳 | 114.0s | 28.6MB |
| `BV18u8R6SEde` | 开拓者和砂金互爆了！这段和砂金拍卖的对手戏太逗了！【崩坏星穹铁道4.5版本「挥掷千星的筹码」高光剧情收录】 | 原神高玩专家-向晚 | 163.933s | 26.4MB |
| `BV1PsYX6kEqx` | 当砂金换上了新泳装…… | 小星想叭叭 | 139.343s | 27.3MB |
| `BV1Nyta66Evh` | 砂金-戏浪  技能演示 | 植awa | 30.1s | 5.6MB |
| `BV1WQYH6XEQQ` | 砂金·戏浪实机演示 | 最善逢魔时王 | 149.71s | 52.1MB |
| `BV1JSev6xEfz` | 砂金·戏浪的待机动画【崩坏：星穹铁道】 | 夏末初秋Kzyp | 75.767s | 18.5MB |
| `BV1u8nU6zE5a` | 砂金呐砂金 舒俱断不了情根~ | 墨逸尘丶 | 15.069s | 1.5MB |
| `BV1hK421h79W` | 砂金的角色界面待机动画 | 黑枪皇-冷酷的毒士 | 59.054s | 20.0MB |
| `BV1J3xL63EaZ` | 舒俱砂金｜你們不要再打了！ | 南忘今枭 | 69.543s | 7.3MB |
| `BV1TfYD6rEk1` | （崩铁）4.5砂金戏浪两个专属成就：不可战胜的夏天和POV：派对遇到了对手但不想翻脸 | 剑羽 | 123.766s | 38.7MB |


#### 8.1b 2026-11-09 补采新增（长视频 360p + 定点段 1080p + 通用 NPC 合集；米游社 7 条见 §9.2）

| 本地文件（`work/ref-aventurine/video/`） | 内容/UP 主 | 时长 | 规格/体积 | 用途 |
|---|---|---|---|---|
| `BV1Kd4R6BEYh-360p-…mp4` | 【砂金丨4K高清】4.5千星城开拓续闻剧情完整纯享版cut / 筱叶子Leaf | 4865s（81:05） | 360p / 146MB | 扫片主源（§9.3） |
| `section-BV1Kd4R6BEYh-walk-70-90.mp4` | 同源 1:10–1:30 定点段 | 20s | 1080p / 7.0MB | 千星城街道群像（C） |
| `section-BV1Kd4R6BEYh-halltalk-1980-2130.mp4` | 同源 33:00–35:30 定点段 | 150s | 1080p / 14MB | 大厅对话/抱臂站姿（B 素材） |
| `section-BV1Kd4R6BEYh-citytalk-3240-3360.mp4` | 同源 54:00–56:00 定点段 | 120s | 1080p / 31MB | 街道对话（C） |
| `section-BV1Kd4R6BEYh-corridor-2240-2290.mp4` | 同源 37:20–38:10 定点段 | 50s | 1080p / 4.5MB | 走廊（未用） |
| `BV1GvXDYqEap_p1/p2/p13/p14…mp4` | 神谕圣地-雅努萨波利斯 NPC 合集（天文索拉尔，14P/28:56）p1 闲晃男子 / p2 热情少女 / p13 圣地守卫 / p14 祭司 | 154/127/205/278s | 360p | 通用 NPC C 级参考（§9.4） |
| `BV1MDk3YoEpJ_p3/p6/p28…mp4` | 崩坏：星穹铁道 仙舟罗浮 星槎海中枢 NPC合集（39P/98:54+）p3 说书人 / p6 愁眉紧锁的年轻人 / p28 求药少年 | 313/66/172s | 360p | 通用 NPC C 级参考（§9.4） |
| `BV1hH4y1h79e-360p-…mp4` | 「星穹铁道」NPC离谱对话大赏 4.0 / 星穹日报 | 202s | 360p | 通用 NPC 对话/手势 C 级语境（§9.4） |

> 米游社 7 条视频（59MB）在 `meta/mys-posts/`，不是 yt-dlp 下载，未列入本表，详见 §9.2。

### 8.2 已切片 clip（25 个，约 103MB；`work/ref-aventurine/clips/`）

| clip 文件（work/ref-aventurine/clips/） | 内容 | 时长 | 尺寸 |
|---|---|---|---|
| `labeled_huanyu_moment_欢愉时刻.mp4` | 见文件名 | 00:00:06.90 | 1920x864 |
| `labeled_puwang_普攻.mp4` | 见文件名 | 00:00:02.20 | 1920x864 |
| `labeled_ultimate_大招.mp4` | 见文件名 | 00:00:11.10 | 1920x864 |
| `labeled_zhanji_战技.mp4` | 见文件名 | 00:00:06.70 | 1920x864 |
| `official_idle_base_站立动作1.mp4` | 见文件名 | 00:00:11.76 | 400x540 |
| `official_idle_base_站立动作2.mp4` | 见文件名 | 00:00:12.48 | 400x540 |
| `official_skill_huanyuji_欢愉技.mp4` | 见文件名 | 00:00:04.45 | 480x270 |
| `official_skill_miji_秘技.mp4` | 见文件名 | 00:00:04.00 | 640x360 |
| `official_skill_puwang_普攻.mp4` | 见文件名 | 00:00:01.45 | 480x270 |
| `official_skill_qianghua_huanyuji_强化欢愉技.mp4` | 见文件名 | 00:00:12.67 | 480x270 |
| `official_skill_zhanji_战技.mp4` | 见文件名 | 00:00:04.65 | 480x270 |
| `official_skill_zhongjieji_终结技.mp4` | 见文件名 | 00:00:08.65 | 480x270 |
| `xilang_dialog_standing_列车对话站姿_360p.mp4` | 见文件名 | 00:00:16.06 | 640x296 |
| `xilang_idleshow_cointoss_站立动作_抛硬币.mp4` | 见文件名 | 00:00:13.50 | 1920x1080 |
| `xilang_miji_wavedash_秘技冲浪_待确认.mp4` | 见文件名 | 00:00:06.00 | 1920x1080 |
| `xilang_standby_battle_arena2_戏浪战斗待机.mp4` | 见文件名 | 00:00:14.00 | 1920x1080 |
| `xilang_standby_battle_arena_戏浪战斗待机.mp4` | 见文件名 | 00:00:10.61 | 1920x1080 |
| `xilang_ultimate_surf_cinematic_终结技冲浪过场.mp4` | 见文件名 | 00:00:06.50 | 1920x1080 |
| `xilang_walk_run_trial_走路跑步.mp4` | 见文件名 | 00:00:14.00 | 1920x1080 |
| `social_city_crowd_45cut_1-14_1-30_C级.mp4` | 4.5 剧情 cut·千星城街道 NPC/角色群像（C 级通用参考） | 00:00:16 | 1920x1080 |
| `social_45cut_hall_dialogue_33-20_34-40_B级.mp4` | 4.5 剧情 cut·砂金大厅对话/抱臂站姿（B 级同角色） | 00:01:20 | 1920x1080 |
| `mys_51213852_sandgold_world_idle_大世界待机_B级.mp4` | 米游社·基础版砂金大世界待机 | 00:00:20 | 998x480 |
| `mys_77991326_coin_idle_compare_硬币待机对比_B级.mp4` | 米游社·戏浪/基础版硬币待机对比 | 00:00:10 | 1440x1080 |
| `mys_77824028_npc_phone_通用NPC看手机_C级.mp4` | 米游社·通用 NPC 托腮/看手机 | 00:00:08 | 1440x1080 |
| `mys_78127992_qxc_npc_sleepstand_站着睡觉彩蛋_C级.mp4` | 米游社·千星城狸狸 NPC 站立睡觉彩蛋 | 00:00:12 | 2160x1080 |

### 8.3 缩略帧拼图（`work/ref-aventurine/sheets/`，共 204 张）

| 拼图前缀 | 内容 |
|---|---|
| `v1-xilang-idle` / `v1b-idle-10-40` / `v1c-idle-40-76` / `v1d-idle-22-38` | V1 试用关卡（待机/走跑/站立动作）1–3fps 抽帧 |
| `v4-xilang-gameplay` | V4 实机（0.5fps，全程覆盖） |
| `v6-skills-slowmo` | V5 慢放剪辑（1fps） |
| `v7-official-charPV` | 官方角色PV p1（0.5fps） |
| `v8-official-45PV` | 官方 4.5 版本PV p1（0.5fps） |
| `v10-xilang-demo57` / `v10-xilang-demo57b` | V10 实机（1fps） |
| `v11-skills-showcase` | V11 全角色技能展示（1fps） |
| `v13-skill-demo` | V13 技能演示（2fps，带标签） |
| `v19-train-dialog-p1` / `p2` | 列车对话 360p（1fps） |
| `v20-qxc-tour-guide` | 千星城导览（0.5fps） |
| `official-skills-gifs-grid.jpg` | 6 条官方技能 GIF 统一网格（6 帧/条，用于快速辨认） |
| `official-wiki-gifs.jpg` | 8 条官方 GIF 首/中/末帧总览 |
| `clip-official_skill_*-keyframes.jpg` | 每条官方技能 GIF 的 8 帧关键帧 |
| `clip-inventory-proof.jpg` | 全部切片的三帧验证图（确认无空片段） |
| `v21-45cut-81min-20s` | 81min 剧情 cut 每 20s 缩略（7 页，扫片主图，§9.3） |
| `v22-81cut-W3-hall` / `v22-81cut-W5-city` | 大厅/城市定点窗口（0.2–0.25fps） |
| `v23-beach/walkNpc/cityStand/hallEarly/dome/corridor/pool/bar` | 8 个候选窗口（0.25–0.5fps） |
| `sec-halltalk` / `sec-citytalk` / `sec-walk` | 1080p 定点段抽帧（1–2fps） |
| `npc-janus-p1/p2/p13/p14`、`npc-luofu-p3/p6/p28`、`npc-dialog-compilation` | 通用 NPC 合集 360p 概览（0.1–0.5fps） |
| `mys-51213852-idle48s`、`mys-52184410-idlebug`、`mys-77991326-sp-actions`、`mys-77824028-npcfan`、`mys-78127992-sleepnpc`、`mys-77661982-npccannon`、`mys-77798840-qxc-npc` | 米游社 7 条视频抽帧（0.5–2fps） |
| `social-clip-proof.jpg` / `hall-pose-check.jpg` | 新增切片三帧复核图 / 大厅抱臂站姿高清复核 |

### 8.4 搜索命中记录（`meta/`）

`meta/search-*.json` 保存了各关键词的 B 站搜索结果（bvid/标题/播放量/时长），可用于复查候选或补搜（如 “砂金 待机动作 合集”“星穹铁道 NPC 动作合集” 等 20+ 关键词）。

2026-11-09 补采新增米游社数据：`meta/mys-search-*.json`（20+ 关键词命中，含 post_id/标题/URL）、`meta/mys-posts/miyoushe-post-*.json`（getPostFull 原文，含 `vod_list/resolutions` 与视频直链）、`meta/mys-posts/miyoushe-*.mp4`（7 条视频，约 59MB）。

---

## 9. 社交动作参考补充（2026-11-09 补采：米游社 + 4.5 千星城剧情 cut）

> 目标：把 80 个「NPC 社交动作」take 的参考证据从 E 级往上提。**只写实际看过/抽帧确认的内容；近似动作不得冒充官方同一动作。**
> 补采结论先行：**Talk01/02 → B（2 takes）；HoldArm01、LookAtPhone、WatchPhone01、Think01（+ 弱证据 PutHand01）→ C（约 20 takes）；其余约 57 takes 仍 E。**

### 9.1 米游社（新渠道）可访问性与抓取方法

| 项 | 实测结果 |
|---|---|
| 站点 | `https://www.miyoushe.com/`（首页）与 `/sr/`（星穹铁道版）**HTTP 200、SSR 可用、免登录**；`bbs.miyoushe.com` 直连不稳定（curl 超时/000），以 `www.miyoushe.com` 为准 |
| 搜索 API | `GET https://api-takumi.miyoushe.com/post/wapi/searchPosts?keyword=<URL编码>&page=1` → JSON（`retcode:0`）；**无需 cookie / 签名**；返回 `data.posts[].post`（post_id / subject / created_at / images / content 摘要） |
| 帖子详情 API | `GET https://api-takumi.miyoushe.com/post/wapi/getPostFull?post_id=<id>` → `data.post`（含 `vod_list`） |
| 视频下载 | `data.post.vod_list[].resolutions[]`：`{url, definition(480P/720P/1080P), width, height, size}`；`url` 为 `prod-vod-sign.miyoushe.com` 直链（**带时效 auth_key，免 cookie 可下**） |
| 工具 | `work/ref-aventurine/tools/miyoushe_search.py`：`"关键词" [页数] [out.json]` 搜索；`--post <id> [--outdir DIR]` 拉详情并下载最高清视频 |
| 限制 | ① 搜索命中的多为**图文攻略**，逐条动作视频很少；② 帖子可能被删/风控（如 77695023 取详情失败）；③ vod 直链 auth_key 过期需重新 getPostFull 取新链；④ 米游社**没有**「砂金/戏浪 全动作展示」类视频（搜索 20+ 关键词未见） |

### 9.2 米游社已下载视频（7 条，`meta/mys-posts/`，约 59MB）

| 米游社 post | 标题 | 时长/分辨率 | 抽帧确认内容 | 本地文件 | 等级/用途 |
|---|---|---|---|---|---|
| [51213852](https://www.miyoushe.com/sr/article/51213852) | 砂金待机 | 48.7s / 998x480 | **基础版砂金大世界待机实录**（固定机位、全身可见、小动作循环） | `meta/mys-posts/miyoushe-51213852-480P_998x480_2790021.mp4` | **B**（待机/StandBy 类节奏参考，基础版≠戏浪） |
| [52184410](https://www.miyoushe.com/sr/article/52184410) | 砂金待机动作bug:磁悬浮香水 | 11.3s / 1066x480 | 角色详情界面「喷香水」待机（香水瓶磁悬浮 bug） | `meta/mys-posts/miyoushe-52184410-480P_1066x480_777544.mp4` | B（基础版待机细节，非社交） |
| [77991326](https://www.miyoushe.com/sr/article/77991326) | 关于SP砂金的有趣小发现！腹肌，动作，耳环，羽毛！ | 23.4s / 1440x1080 | 抽帧：**戏浪硬币待机 ≈t 6.2–7.2s**；基础版硬币待机 t≈7.3–9.9s；**戏浪/基础版站姿对比 t≈11.8–15.8s**；末尾 t≈22–23.4s 戏浪持币 | `meta/mys-posts/miyoushe-77991326-1080P_1440x1080_8906955.mp4` | **B**（「换皮肤保留硬币待机」同角色可见证据；具体 take 编号未确认） |
| [77824028](https://www.miyoushe.com/sr/article/77824028) | 论崩铁NPC的变脸速度 | 89.6s / 1440x1080 | 千星城 NPC 近景：银发 NPC **托腮/思考 ≈40–42s**；金发 NPC **手持手机看 ≈42–47s** | `meta/mys-posts/miyoushe-77824028-1080P_1440x1080_22514756.mp4` | **C**（通用 NPC 动作参考，非砂金） |
| [77798840](https://www.miyoushe.com/sr/article/77798840) | 被千星城的npc笑死怎么办？ | 28.2s / 1920x1080 | 千星城机器人 NPC 搞笑动作（非人形骨架） | `meta/mys-posts/miyoushe-77798840-1080P_1920x1080_7998900.mp4` | 仅语境（非人类社交动作集） |
| [78127992](https://www.miyoushe.com/sr/article/78127992) | 狸狸周刊千星城分部彩蛋（站着睡觉） | 29.3s / 2160x1080 | 千星城狸狸 NPC 站立睡觉彩蛋（非人形） | `meta/mys-posts/miyoushe-78127992-1080P_2160x1080_5369059.mp4` | 仅语境 |
| [77661982](https://www.miyoushe.com/sr/article/77661982) | 这NPC血好厚啊！扛着大炮筒也很搞笑 | 86.8s / 1600x720 | NPC 战斗/待机（非人形） | `meta/mys-posts/miyoushe-77661982-720P_1600x720_13112348.mp4` | 仅语境 |

> 另有检索命中但**未下载/未采用**的米游社帖（可复查）：52184410/51213852（已下）、78075556《砂金戏浪角色PV独家爆料，有哪些梗》（图文）、77991326（已下）、77798840（已下）、77824028（已下）、78127992（已下）、77970819《星穹会客厅｜砂金·戏浪》（图文）、76332325《4.0前瞻就有千星城 砂金》（图文）。命中 JSON 见 `meta/mys-search-*.json`。

### 9.3 4.5 千星城剧情 cut 扫片（`BV1Kd4R6BEYh`，81:05）

- 下载：360p 全片 146MB（`video/BV1Kd4R6BEYh-360p-…mp4`）；扫片用 `make_sheet.py --fps 0.05`（每 20s 一帧，7 页 `sheets/v21-45cut-81min-20s-p01..07`），再用 0.2–0.5fps 定点窗口（`sheets/v22-*`、`v23-*`）与 1080p 定点段复查。
- 结构判断：该 cut 以**剧情对话/近景**为主（大量对话切换、镜头常为半身/近景），并非"全动作展示"；只在少数段落可看到全身站姿/手势。且该视频为**砂金 POV 剧情 cut**，角色在部分段落穿 4.5 毛领剧情服、部分穿戏浪泳装 → 验收标注时必须写清"同角色，但造型/场景为剧情演出"。
- 已验证段落（抽帧确认）：

| 片段 | 源时间码 | 抽帧看到的内容 | 本地文件 | 等级 |
|---|---|---|---|---|
| 千星城大街群像 | 1:14–1:30 | 戏浪+紫帽 NPC+路人 NPC 在街道走动/站立（可看通用 NPC 待机/行走姿态） | `clips/social_city_crowd_45cut_1-14_1-30_C级.mp4` | **C**（通用 NPC 群像） |
| 大厅对话（砂金×开拓者） | 33:20–34:40 | 砂金**双臂交叉抱胸站姿**（约 33:40–34:52 持续）+ 说话/放下手臂，全身可见 | `clips/social_45cut_hall_dialogue_33-20_34-40_B级.mp4` | **B**（同角色站姿素材）/ **C**（对应 take 未确认） |
| 大厅近景 | 33:18–33:30 | 砂金手指触碰耳饰/耳侧（≈1s） | 同切片段（0–15s） | C（仅类似手部动作） |
| 桌面操作 | 36:00–37:16 | 砂金伸手触碰全息屏/落座 | 未切（`sheets/v22-81cut-W3-hall-p04`） | C |
| 街道对话 | 54:20–56:00 | 砂金与紫帽 NPC 并排站立对话（小动作少） | 未切（`sheets/v22-81cut-W5-city-p02`） | C |
| 列车对话 | p1 0:03–1:13 | 戏浪站姿（已列 §4.3 V19） | `clips/xilang_dialog_standing_列车对话站姿_360p.mp4` | C（仅语境） |

### 9.4 通用 NPC 动作参考候选（B 站，**C 级；非砂金角色**）

| 来源 | 规格 | 本地文件 | 用途/限制 |
|---|---|---|---|
| [BV1GvXDYqEap](https://www.bilibili.com/video/BV1GvXDYqEap/) 神谕圣地-雅努萨波利斯 NPC 合集 / 天文索拉尔（14P，28:56） | 已下 p1/p2/p13/p14 360p | `video/BV1GvXDYqEap_p{1,2,13,14}_pNA-NA.mp4` | 单个 NPC 环境行为展示（闲晃男子/热情少女/圣地守卫/祭司）；跟随机位、以走动/对话为主，动作细节一般 |
| [BV1MDk3YoEpJ](https://www.bilibili.com/video/BV1MDk3YoEpJ/) 崩坏：星穹铁道 仙舟罗浮 星槎海中枢 NPC 合集 / 天文索拉尔（39P，98:54+） | 已下 p3/p6/p28 360p | `video/BV1MDk3YoEpJ_p{3,6,28}_pNA-NA.mp4` | p3 说书人（说话手势）、p6 愁眉紧锁的年轻人（担忧姿态候选）、p28 求药少年（受伤/求助候选） |
| [BV1hH4y1h79e](https://www.bilibili.com/video/BV1hH4y1h79e/) 「星穹铁道」NPC 离谱对话大赏 4.0 / 星穹日报 | 已下 360p | `video/BV1hH4y1h79e-360p-…mp4` | 千星城/匹诺康尼 NPC 对话混剪，可看说话手势；无逐条标注 |
| B 站搜索到的其它候选（未下载） | — | — | `BV1Ze411B7xd`《星铁角色（只测了部分）东张西望待机动作》2:02；`BV1srhq6ZEEB`《公司普通员工对战星铁人脉王？》0:47；`BV1FS4d6hEmb`《千星城零工周刊》0:42 |

> 重要口径：这些 NPC 与砂金**骨架不同**，只能作为「通用人类社交动作库」的**姿态/节奏参考（C 级）**；不得标成砂金/戏浪的同一动作。

### 9.5 社交动作 take → 参考补采结果（25 组 / 80 takes）

| # | 动作组（.max 前缀） | take 数 | 补采参考（来源 + 时间码） | 本地文件 | 新等级 | 说明 |
|---|---|---|---|---|---|---|
| 1 | `Akimbo01/02`（叉腰类） | 12 | 未找到明确"双手叉腰"镜头；大厅对话中砂金为**双臂交叉抱胸**（33:40–34:52），可作相近站姿参考 | `clips/social_45cut_hall_dialogue_33-20_34-40_B级.mp4` | **C** | 抱臂 ≠ 叉腰，映射需人眼确认 |
| 2 | `HoldArm01`（抱臂类） | 6 | 同上：砂金双臂交叉抱胸站姿 33:40–34:52（同角色、全身可见） | 同上 | **C** | 同角色可见抱臂站姿；具体 take 编号未确认 |
| 3 | `Talk01/02`（说话手势） | 2 | 砂金大厅对话说话/抬手下放 33:20–34:40 | 同上 | **B** | 同角色说话动作可见；take01 vs 02 未区分 |
| 4 | `Think01`（思考/托腮） | 6 | 米游社 77824028 银发 NPC 托腮 ≈40–42s | `clips/mys_77824028_npc_phone_通用NPC看手机_C级.mp4` | **C** | 通用 NPC（非砂金） |
| 5 | `LookAtPhone`（看手机） | 3 | 米游社 77824028 金发 NPC 持手机看 ≈42–47s | 同上 | **C** | 通用 NPC；与 `WatchPhone` 区分需人眼 |
| 6 | `WatchPhone01`（看/操作手机） | 3 | 同上 | 同上 | **C** | 同上 |
| 7 | `PutHand01` | 3 | 砂金触耳饰/耳侧 33:18–33:30（≈1s） | `clips/social_45cut_hall_dialogue_33-20_34-40_B级.mp4`（0–15s） | **C**（弱） | 仅类似手部动作，证据很弱 |
| 8 | `Worry01/02` | 6 | 候选：仙舟 NPC 合集 p6「愁眉紧锁的年轻人」（已下 360p，**未抽帧确认**） | `video/BV1MDk3YoEpJ_p6_pNA-NA.mp4` | **E→候选** | 未确认动作，仍按 E 处理 |
| 9 | `Build02`（沙堡/建造） | 3 | 未找到 | — | **E** | |
| 10 | `Forerake02`（耙沙） | 3 | 未找到 | — | **E** | |
| 11 | `Bye01`（挥手告别） | 1 | 未找到 | — | **E** | |
| 12 | `CoverMouth01` | 3 | 未找到 | — | **E** | |
| 13 | `ScratchHead01`（挠头） | 3 | 未找到 | — | **E** | |
| 14 | `Shrug01`（耸肩） | 3 | 未找到 | — | **E** | |
| 15 | `Snap01`（打响指） | 3 | 未找到 | — | **E** | |
| 16 | `StrikeChest01`（捶胸） | 3 | 未找到 | — | **E** | |
| 17 | `HoldHead01`（抱头） | 3 | 未找到 | — | **E** | |
| 18 | `Injured01`（受伤） | 3 | 未找到（候选：仙舟 p28 求药少年，未确认） | — | **E** | |
| 19 | `Alert01`（警觉） | 3 | 未找到 | — | **E** | |
| 20 | `BackWard01`（后退） | 3 | 未找到 | — | **E** | |
| 21 | `UseHeadPhone01`（戴耳机） | 3 | 未找到 | — | **E** | |
| 22 | `UseProp01/02`（使用道具） | 2 | 剧情里有持杯/持道具镜头，但属剧情演出，不作证据 | — | **E** | |
| 23 | Walk / WalkStop / Run / RunStop 等 locomotion | 20 | 4.5 剧情 cut 千星城街道 1:14–1:30（C）+ 原有 V1 试用关卡走跑（B–C） | `clips/social_city_crowd_45cut_1-14_1-30_C级.mp4`、`clips/xilang_walk_run_trial_走路跑步.mp4` | **B–C** | 转身/急停仍 E |
| 24 | Turn_45/90/180 | 6 | 未找到干净素材 | — | **E** | |
| 25 | Idle_Show_01/02、Common_IdleShow（非社交，本轮补强） | 3 | 米游社 51213852 基础版大世界待机（B）；77991326 硬币待机对比（B，含戏浪持币） | `clips/mys_51213852_sandgold_world_idle_大世界待机_B级.mp4`、`clips/mys_77991326_coin_idle_compare_硬币待机对比_B级.mp4` | **B** | 具体 01 vs 02 仍未区分 |

> **净变化（对照上一版全 E）**：B 级 +2 takes（Talk01/02）；C 级 +约 20 takes（HoldArm 6、Think 6、LookAtPhone 3、WatchPhone 3、PutHand 3 弱、Akimbo 12 中的部分按相近站姿理解但不计入）；仍 E 约 57 takes。**没有任何动作被提升为 A**——因为公开素材都无法确认到「砂金/戏浪正在播放该 take」的级别。

### 9.6 仍为 E 的动作与补齐建议

- 仍 E 的组：Akimbo（叉腰明确镜头）、Build02、Forerake02、Bye01、CoverMouth01、ScratchHead01、Shrug01、Snap01、StrikeChest01、HoldHead01、Injured01、Alert01、BackWard01、UseHeadPhone01、UseProp01/02、Worry01/02、Turn_*/RunStop。
- **唯一可靠补法 = 游戏内录屏**（免登录素材已到极限）：
  1. 千星城 hub：靠近砂金 NPC 等待环境行为，逐组录 3–5s（叉腰/挠头/耸肩/看手机/戴耳机/打响指/挥手/捂嘴/抱臂/抱头/受伤/警觉/后退/建造/耙沙/使用道具/担忧/思考/说话）；
  2. 角色详情界面：Idle_Show_01/02 各录完整一轮（约 10–12s），用于区分 01/02；
  3. 战斗：受击 Hit_H/Hit_L/Hit_Stun、Stun 三态、Die/Revive 逐条录（模拟宇宙/周本可反复触发）；
  4. 队伍界面：TeamStandBy 录干净一轮。
- 若无法录屏：验收时将上述动作降级为「姿态/节奏合理性抽查（C/E）」，**不要**按 A 级逐帧对拍；本补充包中的 B/C 素材只能覆盖 Talk/抱臂/托腮/看手机等少数类别。

## 10. 复现性 / 版权声明

- 全部下载物在 `work/ref-aventurine/`，`work/` 在 `.gitignore` 中 → **不会进 git、不随应用分发**；`docs/research/aventurine-reference-videos.md` 只含元数据与本地相对路径。
- 官方游戏素材与视频 © miHoYo / COGNOSPHERE / HoYoverse；B 站视频 © 各 UP 主；Biligame wiki 页面 CC BY-NC-SA 4.0。**仅供个人非商业内部比对**，禁止二次配布/商用。
- 本次未使用任何账号密码、未登录、未购买会员；B 站免登录 1080p 为实测能力边界。若后续需要 4K/60 镜头，需用户授权提供（或自行下载）。
