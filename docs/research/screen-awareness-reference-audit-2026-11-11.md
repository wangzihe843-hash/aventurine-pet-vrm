# 参考项目事实与许可证审计：darkitten-launcher vs darkitten-pet 及 7 个参考仓库

> 日期：2026-11-11（审计执行 16:30–17:10 +08:00）
> 审计对象：`docs/research/screen-awareness-privacy-focus-feasibility-2026-11-11.md`（下称「豆包报告」）§2/§3/§5/§8 对各参考项目的事实描述、参数、许可证与审计 commit。
> 审计范围：**只读参考仓库**（全部 `git clone --depth 1` 到 `/tmp/ref-audit/**`），不修改本仓库除本文件外的任何内容，不安装依赖，不执行 build/test。
> 结论先行：**报告主体事实可信度高（抽查 60 余条事实描述，绝大多数准确；硬性不准确 5 条、表述偏差/引用过期若干）**，但存在 1 个**引用错位级问题**（用户点名的 `darkitten-launcher` 与报告实际引用的 `darkitten-pet` 不是同一个仓库，报告未说明关系、也未审计 launcher），以及 5 条硬性事实错误（2 个参数/机制误读、1 个统计以偏概全、1 个技术栈过时、1 个条数少算；见 §6 E2–E5、E12）、2 个审计 commit 已过期、若干许可证表述不够精确。详见 §6「报告错误清单」。

---

## 0. 一句话结论

1. **`LFELKEEA/darkitten-launcher` 是 Minecraft 启动器 + 下载站源码，不含任何桌宠/窥屏实现**；窥屏互动（`screen_watcher.py`）只在同作者的 `LFELKEEA/darkitten-pet` 里。报告"把参考项目写成 darkitten-pet"在**实现主体上是对的**，但**对用户点名仓库是错位的**：它既没有说明两个仓库的关系（launcher 的 README 指路 + release 包 + update.json 分发 pet），也没有审计 launcher 中与桌宠交付直接相关的机制（安装/更新/诊断/单实例）。
2. **launcher 里没有任何屏幕采集/OCR/隐私/专注机制**（全仓库 198 个 `.py` 文件，无 `grabWindow`/`screen_watch`/OCR 实现；仅 `website/public/plugins/example.screen_note-1.0.0.zip` 这类"分发屏幕插件"的产物）。它对本项目的价值只在**原生 helper 的发布/校验/回滚**这类分发域，与「窥屏互动」本体弱相关。
3. 许可证结论：**darkitten（两个仓库）代码均为 MIT ✅**，但 `vendor/live2d` 运行库与第三方语音模型**不在 MIT 覆盖内**；LingChat 为 AGPL-3.0 ❌（只借设计），screenpipe 为 Source-available 商业许可 ❌（只借设计），N.E.K.O / Miru / BongoCat / VPet 均为 Apache-2.0 ✅（可复制实现，保留许可与 NOTICE）。报告「只复制 MIT/Apache、AGPL/商业只借设计」的总原则正确。
4. 报告最需要修正的三处硬事实：**（a）`lfelkeea.focus_guard` 默认是 50 分钟专注 / 5 分钟休息，不是"5 分钟插件计时"；（b）`last_comment` 在 darkitten 是死字段（从未参与去重），不能写"与 darkitten 一致，避免重复同一句"；（c）BongoCat 在报告审计 commit 已是 Rust/GPUI 原生应用，不是 Tauri。**

---

## 1. 审计方法与可复现命令

```bash
mkdir -p /tmp/ref-audit && cd /tmp/ref-audit
# 必审（用户点名仓库 + 报告实际引用仓库）
git clone --depth 1 https://github.com/LFELKEEA/darkitten-launcher.git launcher   # HEAD 39ccc87
git clone --depth 1 https://github.com/LFELKEEA/darkitten-pet.git      pet        # HEAD e1b0951
# 其余 6 个参考项目：只取 blob 不 checkout，减少体积
for spec in "LingChat https://github.com/SlimeBoyOwO/LingChat.git" \
            "Miru https://github.com/kiyotakali/Miru.git" \
            "screenpipe https://github.com/mediar-ai/screenpipe.git" \
            "BongoCat https://github.com/ayangweb/BongoCat.git" \
            "NEKO https://github.com/Project-N-E-K-O/N.E.K.O.git" \
            "VPet https://github.com/LorisYounger/VPet.git"; do
  set -- $spec; git clone --depth 1 --filter=blob:none --no-checkout "$2" "$1"
done
# 按需读文件：git -C <repo> show HEAD:<path>（行号以该文件自身为准）
```

- 引用格式：`仓库@commit短哈希:文件:行号`；报告本身用 `报告 §x（L行号）` 定位。
- 审计 commit 一律用**本审计时点的默认分支 HEAD**（见 §8 表）；报告审计 commit 未在本地保存历史时，用 GitHub `.patch` 网页核对 commit 存在性与日期。
- 局限：screenpipe / N.E.K.O 只比对报告审计 commit 与当前 HEAD 的**当前文件内容**，未做逐 commit diff；对所有项目均为**定点抽查**（每项目 3–8 项），不是全量深读。

---

## 2. 核心审计：darkitten-launcher 到底是什么，与 pet 什么关系

### 2.1 launcher 仓库真伪与内容（`launcher@39ccc87`，2026-11-09 23:34 +0800）

| 项 | 事实 | 证据 |
|---|---|---|
| 定位 | **Minecraft 启动器 + 静态下载站源码**，当前版本 1.11.10 | `launcher@39ccc87:README.md:3` |
| 技术栈 | Python + PySide6 桌面启动器；`website/` 为下载站；`qa/` 为 100+ 自动化/截图测试 | `app.py:1-30`、`README.md:5-15` |
| 桌宠实现 | **没有**。`darkitten/pet.py` 只是桌宠的**安装/更新/启动器**（下载 zip、sha256 校验、原子替换、写 state.json、`subprocess.Popen` 启动 `LFELKEEA.exe`） | `darkitten/pet.py:20-27,119,177,294-308,373,392` |
| 屏幕/OCR 代码 | **0 处**。全仓库 `git ls-tree -r HEAD` 中匹配 `ocr|vision|screen|grab` 的只有网站截图 `.webp` 与一个插件 zip（`example.screen_note-1.0.0.zip`） | `git -C launcher ls-tree -r --name-only HEAD \| grep -iE "ocr\|vision\|screen\|grab"` |
| 桌宠源码指路 | README 明确写：桌宠源码 = `LFELKEEA/darkitten-pet` | `README.md:8` |
| 桌宠发布清单 | `website/public/update.json` 的 `pet` 子对象：name/version 1.4.5/released 2026-11-07/size/sha256/download_url（URL 指向 **launcher 仓库的 release** `pet-v1.4.5`） | `website/public/update.json:20-27`；`website/pet_release.json:1-14` |
| 许可证 | MIT（代码）；Minecraft 商标免责声明 | `LICENSE:1`；`README.md:43-47` |

### 2.2 pet 仓库与 launcher 的关系（`pet@e1b0951`，2026-11-07 16:50 +0800）

- 同一作者 LFELKEEA；launcher README 指向 pet；pet 的 `README.md` 尾部同样回到 launcher 发布链。
- **分发关系是双向且是闭环的**：launcher 侧 `darkitten/pet.py` 从 launcher 站点的 `update.json` → `pet` manifest 拉 `LFELKEEA-1.4.5.zip` 并 sha256 校验安装（`pet.py:119-135,177,222`）；pet 侧 `updater.py` 的 `UPDATE_URL = https://lfelkeea.github.io/darkitten-launcher/update.json`（同文件，`updater.py:5-9,28-30`）用于自身 OTA，`data/` 不动。
- 版本：launcher 1.11.10（2026-11-07 发布 notes）、pet 1.4.5（`version.json`、`website/public/update.json:22`），两者发布清单日期一致 → **launcher 是 pet 的发布/分发控制面**。

### 2.3 判定：报告是否"错位/漏项"

| 判据 | 结论 |
|---|---|
| 用户点名的仓库里有没有窥屏互动实现？ | **没有**。launcher = 启动器 + 下载站；屏实现全部在 pet |
| 报告实际引用的 `darkitten-pet` 是不是正确的窥屏参考？ | **是**。`screen_watcher.py` 是完整实现；报告 §2.1 的机制描述可被逐条验证（见 §3） |
| 报告有没有交代两者关系？ | **没有**。报告全文未出现 `darkitten-launcher`，§8 证据表也没有 launcher 审计 commit |
| 是否构成"错位"？ | **构成引用错位，但非事实性张冠李戴**：报告写的 `darkitten-pet` 机制是真的，只是没告诉读者「用户点名的那个 repo 不是它」，属**溯源缺失 + 漏审计** |
| 用户点名的 launcher 里有没有报告该覆盖的机制？ | **屏相关机制 0 个**；只有通用工程机制（安装/更新/诊断/单实例）——详见 §7 |

**结论**：豆包报告的**技术结论不需要推翻**，但应按「用户点名的 launcher 是分发外壳，窥屏实现在其姊妹仓库 pet」修正参考项目表述；若项目未来要交付 screen helper，launcher/pet 的**发布与更新链路**是报告完全没覆盖的一手参考。

---

## 3. 报告 §2.1 对 darkitten 的逐条核对（15 条主表 + 2 条其他章节延伸）

> 报告位置：§2.1 正文 L61–84；§0 表 L16-25；§3 矩阵 L232-248；§5 配置草案 L474–516（`lastComment` L500）。
> 证据仓库：`pet@e1b0951`。

| # | 报告原述（摘要） | 代码证据 | 判定 |
|---|---|---|---|
| 1 | `screen_watch.mode ∈ {window, ocr, vision, auto}`，四档 | `config.py:30`（默认 `auto`）、`config.py:52` `SCREEN_WATCH_MODES=("auto","window","vision","ocr")`、`screen_watcher.py:389-398` | **准确**（注：§0 表/§3 矩阵写"三档模式"与正文四档略有口径差异，见 E11） |
| 2 | `auto` 在模型不支持视觉时退回 `window`（`_resolved_mode`） | `screen_watcher.py:392-395`：auto → `supports_vision()` 成立则 vision，否则 window | **准确（但不完整）**：运行期视觉拒绝还有第二次回退（`_vision_blocked`），见 E7 |
| 3 | 闸门 1：用户隐藏/睡觉 → 跳过 | `screen_watcher.py:436-438`（`_hidden_by_user` / `_sleeping`） | **准确** |
| 4 | 闸门 2：聊天窗打开/语音中 → 跳过 | `screen_watcher.py:439-441`（`_chat_open` / `_voice_active`） | **准确** |
| 5 | 闸门 3：距上次互动 `< min_idle_seconds`（默认 45s）→ 跳过 | `screen_watcher.py:442-446`；`config.py:31` | **准确**（测量的是"距上次与桌宠互动"的 monotonic 时长，不是系统空闲） |
| 6 | 闸门 4：前台命中的 `SENSITIVE_PROCESSES`（1Password/Bitwarden/远程桌面/虚拟机…）或标题命中 `SENSITIVE_TITLE_WORDS`（密码/验证码/支付/银行/无痕/隐私…）→ 跳过 | `screen_watcher.py:44-101`（词表原文）、`147-149`（匹配逻辑：进程名精确集合命中 + 标题子串） | **准确**：进程集合为 `keepass/keepassxc/1password/bitwarden/lastpass/mstsc/teamviewer/anydesk/rustdesk/vmware/virtualbox`；标题词表 25 项，报告举例为其子集 |
| 7 | 闸门 5：全屏应用（窗口 rect 与 monitor rect 误差 ≤2px）→ 跳过 | `screen_watcher.py:193-217`（`tolerance = 2`）、`455-460` | **准确** |
| 8 | 闸门 6：插件 `screen.context` 可再否决；"先让插件补充或跳过，再决定是否截屏，避免白截一张隐私画面" | `screen_watcher.py:468-474`（代码注释原文一致）、`499-505`（`plugins.emit("screen.context")`） | **准确**（引文与源码注释逐字一致） |
| 9 | 截图抓**主屏整屏**：`QGuiApplication.primaryScreen().grabWindow(0)` | `screen_watcher.py:231-237` | **准确** |
| 10 | 数据最小化：仅内存压缩 JPEG，`max_edge` 1280 / quality 68，不写磁盘 | `screen_watcher.py:231`（默认参数）、`244-256`（缩边+JPEG 编码，无落盘）、`config.py:34-35` | **准确**；报告未提钳制：`max_edge` 钳到 480–1920、quality 钳到 40–90（`screen_watcher.py:225,244`） |
| 11 | OCR 临时图放 `C:\Users\Public\LFELKEEA\ocr` 且结束删除；OCR 结果按行丢弃命中 `REDACT_WORDS` 的行（`_redact_sensitive_text`） | `screen_watcher.py:287-294`（`PUBLIC/LFELKEEA/ocr` + mkdtemp）、`336-342`（`finally: rmtree`）、`73-87`（词表）、`152-160`（整行丢弃）、`536`（调用点） | **准确**（若 `PUBLIC` 不可写会回退系统临时目录，仍删除；属实现细节） |
| 12 | 节奏：`interval_seconds` 默认 120，实际延迟 `interval × uniform(0.85,1.15)`，下限 15s；默认关闭 | `config.py:28-29`、`screen_watcher.py:408-415` | **准确**（另：interval 被钳到 45–1800，报告未提，`screen_watcher.py:413`） |
| 13 | SKIP 提示词：只 1–2 句、只挑安全细节、绝不复述隐私、模棱两可、涉及隐私只回 `SKIP` | `screen_watcher.py:32-42`（系统提示原文）、`622`（`text.upper().startswith("SKIP")` 则沉默） | **准确** |
| 14 | 报告 §2.1"它做错了什么"：无回看面板、无规则引擎、无未知应用默认拒绝、**无输出过滤器**（模型复述会直接 say） | `screen_watcher.py:609-636`（回复只做 strip/截 140 字后直接 `pet.say`，无敏感词过滤）；`settings.py:220-272`（仅开关/间隔/状态文案） | **准确** |
| 15 | 报告 §2.1"闸门是**硬编码**的 pre-gate" | `config.py:32-33` 存在 `pause_when_fullscreen`/`pause_sensitive` 开关（默认 True）；`screen_watcher.py:432-446` 前 3 道闸门只在自动观察分支生效，`manual=True` 会跳过 | **有偏差**："词表硬编码"成立，"闸门整体硬编码不可配"不成立，见 E6 |
| 16 | 报告 §3 矩阵：darkitten 聚焦/低打扰 = **"5 分钟插件计时"** | `plugins/lfelkeea.focus_guard/main.py:13-14`：`DEFAULT_FOCUS_MINUTES=50`、`DEFAULT_BREAK_MINUTES=5`；`:31-32` 5–180/1–30 可配；`:62-66` 完成专注→stretch→休息 5 分钟 | **不准确**：5 分钟是**休息**时长，专注默认 50 分钟，见 E2 |
| 17 | 报告 §5 配置草案 `lastComment: "" // 与 darkitten 一致，避免重复同一句` | `config.py:37` 确有 `last_comment` 字段，但 `screen_watcher.py:373,631` 只赋值给**私有属性** `_last_comment`，**从未读取或与上一条比较**；全仓库仅 3 处出现 | **不准确（把死字段当机制）**，见 E3 |

**§2.1 小结**：15 条 §2.1 条款抽查中 13 条准确、2 条有偏差/不完整（auto 二次回退、"硬编码"表述）、0 条过时；§2.1 未提及的周边机制见 §7-B。另 2 条（focus_guard、last_comment）不在 §2.1 但出现在报告其他章节，判定为**不准确**。

---

## 4. 其余 6 个参考项目抽查（每项目 3–8 条）

### 4.1 LingChat（`LingChat@848fd34`，2026-09-13；AGPL-3.0）

| 报告原述 | 证据 | 判定 |
|---|---|---|
| 20s 滑窗统计 keystrokes / game keys / clicks / mouse distance | `src-tauri/src/ai_service/proactive_system/activity_monitor.rs:118-122`（cutoff=now-20s）、`:163`（日志确认 "last 20s"） | **准确** |
| IDLE(-15) / BROWSING(+10) / GAME(+20) / WORK(-10) / CASUAL(0)，含 0.6/20、30/0.4 门槛 | `activity_monitor.rs:176-199`：IDLE 条件 `mouse_distance<10 && keystrokes==0 && clicks==0`；BROWSING `keystrokes<5 && (mouse_distance>2000 || clicks>2)`；GAME `(game_ratio>=0.6 && keystrokes>20)||(clicks>30 && game_ratio>=0.4)` | **准确** |
| interest 每次 tick `+= U(5,10)`，上限 100；触发概率 `(interest+status_mod-50)/50` | `interest_manager.rs:46-47`（`gen_range(5.0..10.0)`、`.min(max_interest_cap)`，初值 100）、`:66` | **准确** |
| 发言后 `interest=0`、`proactive_times++`、`max_interest_cap -= 50/max_proactive_count`（下限 50）；restore 重置 | `interest_manager.rs:56-58`（次数上限判断）、`:80-88`（reset + decay，`.max(50.0)`）、`:90-95`（restore）、`:17`（decay_step） | **准确** |
| `max_proactive_times` 默认 **3** | `src-tauri/src/config/proactive.rs:31`（`max_proactive_times: 3`） | **准确** |
| 优先级 `重要日 > Todo > 屏幕观察 > 话题`；屏幕权重 GAME=60、其他=30；轮盘赌 | `strategy_dispatcher.rs:37`（注释原文）、`:87-126`（权重表）、`:136-139`（`gen_range(0..total_weight)` 轮盘赌） | **准确**（默认配置 `screen_weight: 30.0`，GAME 时覆写为 60：`proactive.rs:33`、`strategy_dispatcher.rs:108-113`） |
| 投递闸门：所有意图必经，`can_deliver` 由前端上报（聊天界面 + 无设置面板 + 输入为空） | `delivery_evaluator.rs:1-26`（注释与实现一致） | **准确** |
| 9×8 灰度网格 → 64-bit dHash，Hamming ≥6 才算变化 | `visual_monitor.rs:33-34`（9×8、72 灰度）、`:57-70`（dHash/count_ones）、`:74`（`diff >= 6`） | **准确** |
| AGPL-3.0 / Rust+Tauri | `LICENSE:1-2`（AGPL v3）；根目录 `src-tauri/`、`package.json` | **准确** |

注：报告把 "interest 累积/衰减" 合写；实际 interest 本身**没有连续衰减**，衰减的是 `max_interest_cap`（每次发言降 50/N，下限 50），另有发言清零。语义方向对，措辞可更精确。

### 4.2 Miru（`Miru@cbea20b`，2026-10-14；Apache-2.0）

| 报告原述 | 证据 | 判定 |
|---|---|---|
| `CHECK_INTERVAL=30` / `MIN_INTERVAL=5` / `CHANGE_THRESHOLD=0.30` / `CAPTURE_MAX_SIZE=1920×1080` / `JPEG_QUALITY=60` / `_user_enabled` 默认 false | `sensor.py:24-29`（常量原文）、`:112`（`self._user_enabled = False`） | **准确** |
| 200×150 缩略图上 30% 像素差才算变化 | `sensor.py:27`（`THUMBNAIL_SIZE=(200,150)`）、`:26`（注释 30% pixel diff）、`:326,364` | **准确** |
| 连续 3 次失败 → 暂停捕获、记录原因、到点自动重试；重新授权后 reset 立即恢复 | `sensor.py:296-322`（注释与实现：3 次失败 → `_capture_disabled_until = now + 5min`；到点清计数重试）、`:150-165,197-205`（`set_enabled` 重置退避） | **准确**（具体冷却 5 分钟，报告未写数值） |
| `get_system_idle_seconds()` 走 `ioreg -c IOHIDSystem -d 4` 读 `HIDIdleTime`，零权限 | `sensor.py:52-56` | **准确** |
| `PROACTIVE_MIN_INTERVAL=15min`、`INTENT_DEDUP=30min`、聊天中静默 2min、`SIGNAL_BUFFER_MAX=160`/`AGE=3600`、`INTENT_QUEUE_LIMIT=40` | `attention_engine.py:32-33,38-42`（常量逐项一致） | **准确** |
| salience 延迟 strong 10–20s / normal 60–90s / weak 180–300s | `attention_engine.py:57-61`（`_DELAY_RANGES` 逐项一致）、`:779-782` | **准确** |
| 内部状态含 `focused` 显式状态（8 态） | `attention_engine.py:63-65`（`_STATE_KEYS` 8 项原文） | **准确** |
| 决策与措辞分离：Attention LLM 只决定说不说，主 agent 写措辞 | `attention_engine.py:15-17`（产品说明原文） | **准确** |
| `screen_analyzer.py`：per-device VLM 冷却 10s（下限 5s）、观察去重、`sig>=2` 只进 Attention 不进记忆 | `screen_analyzer.py:23-24`（`DEFAULT_VLM_INTERVAL=10`、`MIN_SIGNIFICANCE_FOR_ATTENTION=2`）、`:44`（`max(int(interval),5)`）、`:36,150-155`（per-device dedup） | **准确** |
| 整屏 `screencapture`、无敏感应用/标题/全屏/通话闸门、截图经 HTTP POST | `sensor.py:462-470`（`screencapture` + 失败信息）、`:516`（`requests.post`）；`grep -i "password\|incognito\|sensitive\|fullscreen" sensor.py` 0 命中 | **准确** |
| 截屏写记忆链路 2026-05 后半废弃（`trigger_route_async` no-op） | `docs/SCREENSHOT_REFACTOR_TODO.md:1-8,22-36`（状态"暂缓"、no-op stubs、silent drop） | **准确** |
| Apache-2.0 | `LICENSE` v2.0 | **准确** |

### 4.3 screenpipe（`screenpipe@79c05c3`，2026-11-11；报告审计 commit 为 `2619d10`，见 §8）

| 报告原述 | 证据（当前 HEAD） | 判定 |
|---|---|---|
| `window_pattern.rs` 语法：`App`=应用或标题包含（逻辑 OR）；`App::Title`=App 且 Title；`::Keyword`=任意应用标题包含；`App::` 等价 `App` | `crates/screenpipe-core/src/window_pattern.rs:17-20`（模块文档逐字一致）、`:81-99`（matches 实现） | **准确** |
| capture-filters 有效状态 `captured/ignored/partial/outside-allowlist` + 单独 `blockedIndirectly`（过宽规则误伤，例：`bit` 吞 Bitwarden） | `apps/screenpipe-app-tauri/lib/settings/capture-filters.ts:57-64`（状态枚举）、`:87`（`blockedIndirectly: boolean`）、`:231-264`（resolveAppState）、`:84,377`（`bit`/Bitwarden 例子） | **准确** |
| 隐私设置页信息架构：内容过滤（应用/窗口）、排除网站、忽略无痕窗口、PII 遮蔽、采集时间表（星期+时段+模式）、隐私处理状态、应用后重启提示 | `components/settings/privacy-section.tsx:14-28`（导航项原文）、`:1352`（`<ScheduleSettings>`）、`:1779`（`<ApplyRestartBar>`）；`schedule-settings.tsx:23-29`（`ScheduleRule{dayOfWeek,startTime,endTime,recordMode:"all"|"audio_only"|"screen_only"}`） | **准确** |
| 无痕识别是显式能力：`planEnhancedIncognitoPermission` 拆成 ready / prompt / settings / arc-only / open-browser 五种 UI 决策 | `lib/utils/incognito-permission.ts:10-16`（5 种 kind 原文）、`:26-62`（决策函数；Arc 走 Accessibility、其他走 Automation 的注释在 `:20-25`） | **准确** |
| 商业许可、代码不可复制 | `LICENSE.md:1-30`（"Screenpipe Commercial License"，个人非商用/教育研究/7 天评估免费）、`README.md:209,314` | **准确（需精确化）**，见 E9 |
| 常驻全量录制（产品定位） | `README.md` 产品描述（"AI that knows everything you've seen…"）、默认采集策略；属产品判断，无法从单文件反证 | **准确（产品层）** |

另注：仓库现重定向为 `screenpipe/screenpipe`（`mediar-ai/screenpipe` 仍可 clone），见 E8。

### 4.4 BongoCat（`BongoCat@47a73ed`，2026-10-28；Apache-2.0）

| 报告原述 | 证据 | 判定 |
|---|---|---|
| overlay 行为声明式，字段清单（click_through / hold_modifier_to_interact / always_on_top / scale_percent / opacity_percent / corner_radius_percent / hide_on_pointer_hover(_delay) / hide_on_idle(_delay) / keep_inside_screen / maximum_fps） | `shared/config/fixtures/accept-idle-hide.json:11-24`（12 字段名+值与报告引文逐字一致）、`shared/config/config.schema.json:414-472`（对应 schema 定义） | **准确** |
| 每个字段都有 `accept-*.json` fixture 与 schema，配置契约可测 | schema 81 个 properties；`shared/config/fixtures/` 共 114 个文件，其中 `accept-*.json` **19 个**（另有 reject/behavior 等） | **不准确（以偏概全）**，见 E4 |
| Apache-2.0 | `LICENSE` v2.0；workspace `Cargo.toml` `license = "Apache-2.0"` | **准确** |
| "Tauri" | 当前 HEAD 为 **Rust workspace（25 个 crates + 3 个内置插件）+ GPUI 系 UI**：`Cargo.toml` members 含 `bongocat-app/overlay/plugins/update/...`，UI 依赖 `gpui-kit` v0.7.3；全仓库 `grep -ci tauri` = **0** | **不准确（技术栈过时）**，见 E5 |
| 附加发现（报告未提） | 仓库自带 `plugins/pomodoro/` 番茄钟插件（默认 25 分钟、1–180 可配、capabilities: model_ui/configuration/persistent_state/localized_views_v1，宿主不懂计时业务规则） | **报告遗漏的高价值机制**，见 §7-C1 |

### 4.5 N.E.K.O（`NEKO@0984249`，2026-11-11；报告审计 commit 为 `a89b685`，见 §8）

| 报告原述 | 证据（当前 HEAD） | 判定 |
|---|---|---|
| 屏幕评论污染隔离：问题定义是"异常回答进入历史变成 few-shot"；普通生成/逐字引用/引用翻译分析三种任务权限不互继承；原始记录/用户可见交付/自动模型上下文分开（完整保存≠自动注入，隔离≠删除）；引用原文及派生默认不进后续普通生成上下文 | `docs/design/screen-history-local-reference.md:12-22`（问题定义与 6 条原则原文）、`:3`（文档性质：0A-1 已实现） | **准确** |
| 0A-1 已实现 `utils/screen_comment_guard.py::project_screen_history` | `utils/screen_comment_guard.py:501`（函数存在）、`:143`（`screen_guard_enabled`）；设计文档 `:3,84` | **准确** |
| 观察曝光 UI：`ScreenObservationExposure.tsx` 把"本轮有屏幕观察"做成可曝光/可交互锚点（`recommendationId` → `proactive_recommendation_shown`） | `frontend/react-neko-chat/src/ScreenObservationExposure.tsx:28-31`（`useRecommendationExposure(..., 'proactive_recommendation_shown', ...)`） | **准确** |
| Focus 状态机 `REGULAR --charge>=enter--> FOCUS`，退出靠 decay/topic change/hard cap；episode/turn token 防旧回调污染；总开关默认关闭 | `docs/design/focus-truename-mode.md:7`（`FOCUS_MODE_ENABLED` 默认关闭）、`:23-31`（状态模型与 episode/turn token 原文） | **准确** |
| Focus 是"模型思考预算"（provider thinking 参数），不是用户专注模式 | 同文档 `:7,33-37`（provider 对应思考参数 override、按 provider 映射） | **准确** |
| 图片规格统一：前端 1280 宽 / 后端 720 高 / JPEG 80 | `utils/screenshot_utils.py:38-47`（`COMPRESS_TARGET_HEIGHT=720`、`COMPRESS_JPEG_QUALITY=80`、`MODEL_IMAGE_MAX_WIDTH=1280`，注释说明两端口径一致） | **准确** |
| Apache-2.0 / Python + React | `LICENSE` v2.0；根目录 `app/ brain/ main_logic/`，前端 `frontend/react-neko-chat/` | **准确** |

### 4.6 VPet（`VPet@c26be33`，2026-11-08；Apache-2.0）

| 报告原述 | 证据 | 判定 |
|---|---|---|
| `WorkTimer.xaml.cs` 会话状态机把"工作结束"分 `TimeFinish / MenualStop / StateFail / Other` | `VPet-Simulator.Core/Display/WorkTimer.xaml.cs:61-79`（`StopReason` 枚举原文，`MenualStop` 拼写与源码一致）、`:124-135`（TimeFinish 触发）、`:239-252`（Stop 默认 MenualStop） | **准确** |
| 有"剩余时间 / 已获取收益"**两种**显示模式 | 同文件 `:27-32`（`DisplayType` 0=默认/1=剩余时间/2=已获取/3=隐藏）、`:144-162`（switch 分支）、`:239-252` | **不准确（少算默认与隐藏态）**，见 E6 |
| Apache-2.0 / WPF | `LICENSE` v2.0；`VPet-Simulator.Windows.Interface/` 等 .NET/WPF 项目结构 | **准确** |

### 4.7 Mate-Engine（本地 refs，报告 §2.6；非必审，顺带复核）

- 本地 `refs/Mate-Engine` HEAD `2c5ea6b`（2026-01-20）与报告审计 commit 一致。
- `Assets/MATE ENGINE - Scripts/Tools/DesktopAmbientProbe.cs`：`captureWidth=160 / captureHeight=90`（:16-17）、`bandThicknessPx=120`（:18，按分辨率换算 :203）、`smoothing=0.85`（:20）、`captureHz=10`（:15，`LateUpdate` 节流 :116-122）、`StretchBlt` 到 160×90（:189）、`Exclude(ref …Rect, inside)` 排除自身窗口（:218-221）、`RGBToHSV`（:238-241）→ 报告 §2.6 全部**准确**。
- 许可证：根 `LICENSE.md` 是 **MateEngine Pro License v2.1**（自定义/商业型，非 MIT/Apache）；报告写"混合许可"含糊但"不可复制"方向正确。

---

## 5. 许可证核对与「可复制实现 vs 只借设计」结论

| 仓库 | 报告写的许可 | 实测（LICENSE/清单） | 判定 |
|---|---|---|---|
| `LFELKEEA/darkitten-pet` | MIT | `LICENSE:1` MIT；README 同 | **准确**，但有资产边界（见下） |
| `LFELKEEA/darkitten-launcher`（报告未列） | — | `LICENSE:1` MIT；README.md:43-45 | **MIT** |
| `Project-N-E-K-O/N.E.K.O` | Apache-2.0 | `LICENSE` Apache License 2.0 | **准确** |
| `SlimeBoyOwO/LingChat` | AGPL-3.0 | `LICENSE:1-2` GNU AGPL v3 | **准确** |
| `kiyotakali/Miru` | Apache-2.0 | `LICENSE` Apache v2.0；README 徽章同 | **准确** |
| `mediar-ai/screenpipe` | 商业许可 | `LICENSE.md:1-30` **Screenpipe Commercial License**（源可用；个人非商业/教育研究/7 天评估免费，商业需授权） | **准确但欠精确**（E9） |
| `ayangweb/BongoCat` | Apache-2.0 | `LICENSE` Apache v2.0；workspace Cargo.toml 同 | **准确** |
| `LorisYounger/VPet` | Apache-2.0 | `LICENSE` Apache v2.0 | **准确** |
| `refs/Mate-Engine` | 混合许可 | `LICENSE.md` **MateEngine Pro License v2.1**（自定义） | **含糊/不精确**（非必审项） |

### 结论

1. **可复制实现**（代码级借鉴/移植）：
   - `darkitten-pet`（MIT）✅ —— 但注意 **MIT 只覆盖本项目代码**：`vendor/live2d/`（live2d-py + GLFW 运行库，仓库内无独立许可文件）与 `assets/models/paraformer_zh_small/`（第三方语音模型，README `:96,155` 明确"遵循其原始许可，重分发前自行确认"）不在 MIT 覆盖内；桌宠 Live2D 模型本身也不随仓库分发（`README.md:31-39`）。**可复制 `screen_watcher.py`/`config.py` 的实现，不可默认复制 `vendor/` 与第三方模型资产**。
   - `N.E.K.O` / `Miru` / `BongoCat` / `VPet`（Apache-2.0）✅ —— Apache-2.0 允许复制/修改/分发，需保留许可证与 NOTICE（N.E.K.O 根目录有 `NOTICE`），不得暗示背书。
   - `darkitten-launcher`（MIT）✅ —— 可复制，但其代码与本项目屏幕能力无关。
2. **只借设计、不复制实现**：
   - `LingChat`（AGPL-3.0）❌ —— 复制进非 AGPL 项目会触发整体 AGPL 化；报告结论正确。
   - `screenpipe`（Commercial License / source-available）❌ —— 商业/产品使用需授权；报告结论正确。
   - `Mate-Engine`（MateEngine Pro License）❌ —— 自定义许可，非开源许可；报告"混合"表述应改为"自定义商业许可，仅借设计"。
3. **报告总原则（"只复制 MIT/Apache；AGPL/商业只借设计"）正确**，只需补 3 个注脚：darkitten 的 vendor/资产边界、screenpipe 许可的免费范围、Mate-Engine 的许可名称。

---

## 6. 报告错误清单（按严重度排序）

> 「错误」含事实错误、以偏概全、口径不一致与过期引用；「偏差」指方向对但表述不精确。

| 编号 | 级别 | 位置 | 问题 | 证据 | 建议修正 |
|---|---|---|---|---|---|
| **E1** | **高（引用错位/漏项）** | §0 表 L18、§2.1 L61、§8 L597 | 全文把参考项目写成 `darkitten-pet`，从未说明用户点名的是 `darkitten-launcher`；两仓库关系（launcher=MIT 启动器+下载站；pet=窥屏实现；launcher 分发 pet 的 release/update.json）完全缺失；launcher 未被审计 | `launcher@39ccc87:README.md:3,8`、`website/public/update.json:20-27`、`pet@e1b0951:screen_watcher.py`；launcher 全仓库无 screen/OCR 实现 | 在 §2.1 开头加一句"用户点名仓库为 launcher（启动器+下载站，无屏实现），窥屏实现在其姊妹仓库 pet"；§8 证据表补 launcher 审计 commit |
| **E2** | 中（事实错误） | §3 矩阵 L238 | darkitten"聚焦/低打扰 = 5 分钟插件计时" | `pet@e1b0951:plugins/lfelkeea.focus_guard/main.py:13-14,31-32`：默认专注 **50 分钟**、休息 **5 分钟**（5–180/1–30 可配） | 改为"50 分钟专注 / 5 分钟休息插件计时，默认本机计数" |
| **E3** | 中（事实错误） | §5 配置草案 L500 | `lastComment: "" // 与 darkitten 一致，避免重复同一句` | `pet@e1b0951:config.py:37` 字段存在但 `screen_watcher.py:373,631` 只赋值不读取，无比较逻辑 | 删除该注释或改为"预留字段（darkitten 亦未接线）" |
| **E4** | 中（以偏概全） | §2.5 L177 | "每个字段都有 accept-*.json fixture 与 schema" | `BongoCat@47a73ed`：schema 81 properties；`fixtures/accept-*.json` 仅 19 个（fixtures 共 114） | 改为"核心 overlay 行为有 accept fixture 与 schema 契约测试（覆盖 schema 81 属性中的关键子集）" |
| **E5** | 中（技术栈过时） | §2.5 L156 | "BongoCat（Apache-2.0，Tauri）" | `BongoCat@47a73ed:Cargo.toml` 为 Rust workspace（25 crates + 3 plugins，UI 依赖 `gpui-kit` v0.7.3）；`grep -ci tauri`=0 | 改为"Rust/GPUI 原生应用（历史版本曾用 Tauri）" |
| **E6** | 低（偏差） | §2.1 L66 | "隐私闸门是硬编码的 pre-gate" | `pet@e1b0951:config.py:32-33` 有 `pause_when_fullscreen`/`pause_sensitive` 开关（默认 True）；`screen_watcher.py:432-446` 前 3 道只在自动观察生效，manual 路径跳过 | 改为"闸门词表硬编码；敏感/全屏闸门可配置（默认开）；手动观察绕过空闲相关闸门" |
| **E7** | 低（不完整） | §2.1 L65 | auto 降级只写"模型不支持视觉→window" | `screen_watcher.py:396-397,644-664`：运行期 AI 返回"疑似不支持图片"时置 `_vision_blocked`，本次及后续均回退 window（`vision_fallback` 默认 True，`config.py:36`） | 补"运行期视觉拒绝也会一次性回退 window，不反复发图" |
| **E8** | 中（引用过期） | §8 L601-602 | screenpipe 审计 commit `2619d10`（2026-11-09）、N.E.K.O `a89b685`（2026-11-10）已非 HEAD；且 screenpipe 仓库现重定向 `screenpipe/screenpipe` | 当前 HEAD：`screenpipe@79c05c3` 2026-11-11 00:33 UTC（报告 commit 经 .patch 核实为 2026-11-09 16:22 -0800）；`NEKO@0984249` 2026-11-11 15:52 +0800（报告 commit 2026-11-10 18:14 +0800 核实）；抽查 HEAD 文件后机制仍成立，结论不推翻 | 更新 commit 与日期，注明"抽查 HEAD 仍一致" |
| **E9** | 低（许可表述） | §0 L22、§3 L241 | screenpipe 只写"商业许可" | `screenpipe@79c05c3:LICENSE.md:1-30`：Screenpipe Commercial License（source-available；个人非商业/教育/研究/7 天评估免费；商业需授权） | 补全许可名称与免费范围 |
| **E10** | 低（资产边界） | §0 L18、§3 L241 | darkitten 标 MIT ✅ 且"可复制实现"，未提 vendor/第三方资产 | `pet@e1b0951:LICENSE:1`、`README.md:31-39,96,155`；`vendor/live2d` 无独立许可文件 | 补"仅代码 MIT；`vendor/live2d` 与第三方模型资产不在 MIT 覆盖内，模型不随仓库分发" |
| **E11** | 低（口径不一致） | §0 L18 / §3 L234 vs §2.1 L65 | §0/§3 说"三档观察模式"，§2.1 说四档 `{window,ocr,vision,auto}`；实际 config 有 4 个可选值 | `pet@e1b0951:config.py:52` | 统一为"三档模式（window/ocr/vision）+ auto 自动选择，共 4 个可选值" |
| **E12** | 低（少算） | §2.8 L224 | VPet"剩余时间 / 已获取收益两种显示模式" | `VPet@c26be33:VPet-Simulator.Core/Display/WorkTimer.xaml.cs:27-32,144-162`：0=默认（已工作）、1=剩余、2=已获取、3=隐藏 | 改为"默认/剩余/已获取三种可见模式 + 隐藏态" |
| **E13** | 低（措辞） | §2.3 L121 | "interest 累积/衰减"暗示 interest 自身衰减 | `LingChat@848fd34:.../interest_manager.rs:80-88`：interest 每次发言清零；衰减的是 `max_interest_cap`（-50/N，下限 50） | 改为"interest 累积、发言清零；上限随发言次数衰减（50/N，下限 50）" |

**未构成错误、但值得补的准确性说明**（不编号）：
- darkitten `max_edge`/`quality` 有钳制 480–1920 / 40–90（`screen_watcher.py:225,244`）；`interval` 钳制 45–1800（`:413`）——报告只写了默认值。
- darkitten 的 `auto` 模式在默认 provider（pollinations/openai-fast）下解析为 `window`（只发标题/进程，不发截图），README `:144` 亦说明"免费公共通道下只读窗口标题"——这是比"截屏"更保守的默认，报告未强调。
- Miru 退避冷却精确为 **5 分钟**（`sensor.py:319`）；报告只写"到点自动重试"。
- screenpipe 的 `App` legacy 语义在 include 列表里还有"per-app whitelist"复合规则（`window_pattern.rs:110-166`），报告 §4.4 只借了 4 条基础语法，未展开；对我项目足够。
- Mate-Engine 根许可是 MateEngine Pro License v2.1，"混合许可"建议改为"自定义商业许可"。

---

## 7. 用户参考项目中被报告遗漏、但对本项目有价值的机制

> 判定标准：与「窥屏互动 / 隐私保护 / 聚焦模式 / 原生 helper 交付」直接相关，且报告未覆盖。

### A. launcher（用户点名仓库）——结论：**屏相关机制 0 个**，只有分发/运维机制

| 编号 | 机制 | 证据 | 对本项目价值 |
|---|---|---|---|
| A1 | **桌宠安装/更新控制面**：launcher 的 `website/public/update.json` 内嵌 `pet` manifest（version/sha256/size/download_url/notes），launcher 侧 `pet.py` 按 sha256 校验后解压安装，`.backup-<id>` 备份失败回滚，exe 锁定检测，读包内 `version.json` 优先于 `state.json` | `launcher@39ccc87:website/public/update.json:20-27`、`darkitten/pet.py:119-135,177-192,222,294-308,373,392` | 中低（非窥屏本体）。若本项目 W-C/W-D 要交付 `native/screengrab` 二进制/模型资产，这套"**manifest+sha256+原子替换+失败回滚+版本来源优先级**"可直接借鉴到打包/发布脚本；报告 §4.7 只写了"打包公证"，没有 helper 分发与回滚设计 |
| A2 | **应用自更新两阶段 apply**：下载→sha256→启动隐藏 PowerShell 等进程退出→备份代码→替换→失败回滚；`CODE_PATHS` 白名单、`MAX_UPDATE_BYTES` 上限、`_safe_extract` 防 zip-slip | `launcher@39ccc87:darkitten/updater.py:5-9,26-36,36-115,287-360` | 中低。本项目当前无 autoUpdater（`package.json`/`src/main` 无 electron-updater 引用），若 W-C 后需要热修 helper，这是现成模式 |
| A3 | **诊断包隐私脱敏**：support bundle 主动隐藏访问令牌/刷新令牌/第三方 token，声明不含密码/皮肤/存档/Mod | `launcher@39ccc87:darkitten/diagnostics.py:170-180` | 中。本项目目前 `src/main/logger.ts` 无脱敏层；「观察日志只存元数据、support bundle 不含屏幕内容」可借这个"白名单 + 固定免责声明"的写法 |
| A4 | 单实例守卫（QLocalServer/Socket + activate 消息，把已有窗口拉回前台） | `launcher@39ccc87:darkitten/single_instance.py:13,38,68,114` | 低。本项目已有 `requestSingleInstanceLock`（`src/main/index.ts:2746,2773`） |
| A5 | 插件库分发（下载站 build_plugins 从 pet 仓库 `plugins/` 打包） | `launcher@39ccc87:website/public/plugins/example.screen_note-1.0.0.zip`、`website/build_plugins.py` | 低。若未来本项目开放"屏幕观察插件"，可参考其"仓库→站点→客户端市场"的发布形态 |

**明确结论**：launcher **没有**进程守护（只 `Popen` 启动，无 watchdog）、**没有**权限引导（Windows 无 TCC）、**没有**窥屏相关隐私提示——报告"漏掉 launcher"对**屏能力结论无实质影响**，但漏掉了 A1–A3 的打包/运维参考。

### B. pet（报告已引用，但仍有遗漏的屏相关机制）

| 编号 | 机制 | 证据 | 为何有价值 |
|---|---|---|---|
| B1 | **能力失败的第二级降级**：视觉得到"疑似不支持图片"的响应后置 `_vision_blocked`，此后 auto 直接走 window，不再反复发图 | `pet@e1b0951:screen_watcher.py:396-397,644-664`、`config.py:36` | 对应本项目 P3 的失败降级：报告只设计了"失败→静默/退避"，缺"能力级永久降级避免重复无效请求" |
| B2 | **OCR 链路失败也降级到 window**：OCR 无文字/失败 → 用标题+进程发 window 提示，而不是丢弃本次观察；且 OCR 文本超长在任务层截 4000、提示词层再截 1600 | `screen_watcher.py:518-542,544-562`、`:330` | 报告 P2 失败处理写"跳过"，darkitten 的实际策略是"降级到更低信息量层"，可作为 P2 的失败语义选项（仍 fail-closed 于图片，但保留 P0 互动） |
| B3 | **闸门可配置化**：`pause_sensitive`/`pause_when_fullscreen` 开关 + 托盘开关 + 设置页间隔下拉（60/120/300/600s）+ 状态文案（"检测到隐私窗口，本次跳过"） | `config.py:32-33,51`、`settings.py:220-272,371-499`、`pet.py:935-967`、`app.py:260-275` | 报告只把 darkitten 归为"仅状态文案"；它其实提供了最小「用户可管」UI：总开关+间隔档位+状态原因。对应本项目 W-C 设置页的"当前档位/降级原因"文案设计 |
| B4 | **插件双向钩子**：`screen.context`（截屏前补充/否决）+ `screen.comment`（发言后通知）+ `prompt_context(source="screen")`（插件向系统提示注入块） | `screen_watcher.py:468-474,499-505,564-576,637-641` | 报告只提"插件可再否决"，漏了"插件可补充信息/注入提示词"这一扩展面；对"可扩展观察管线 vs 硬编码闸门"的取舍有参考价值 |
| B5 | **不该抄的部分（反向提醒）**：`_consecutive_skip` 只自增无任何使用；`last_comment` 配置字段从未被读取 | `screen_watcher.py:375,623,627`、`config.py:37` | 报告 §5 把 `lastComment` 当去重机制（E3）；实际是半成品。本项目实现"避免重复"时必须自己写比较与状态持久化，不能照抄配置键 |
| B6 | **最小观察上下文**：prompt 只带 时间/标题/进程/是否全屏/OCR 文本/插件补充，按层截断；`_user_prompt` 明确"信息不足就回 SKIP" | `screen_watcher.py:544-562` | 报告 §4.3 有脱敏/截断原则，但没给"提示词结构本身也是最小化对象"的模板；这是可直接对齐的 prompt 形态 |

### C. 其他仓库中被报告遗漏、值得纳入实施参考的机制

| 编号 | 仓库/机制 | 证据 | 价值 |
|---|---|---|---|
| C1 | **BongoCat 内置番茄钟插件**：独立插件承载计时业务规则（默认 25 分钟，1–180 可配），宿主只提供 `model_ui/configuration/persistent_state/localized_views_v1` 能力与三按钮 UI（开始/暂停/重新计时），暂停/重启/状态持久化 | `BongoCat@47a73ed:plugins/pomodoro/plugin.json`、`plugins/pomodoro/src/main.rs:1-140` | **高**：与报告 §4.5 专注模式（`pomodoro` 25/5、50/10）直接同题。可用于「专注计时是独立可替换模块，宿主不持有业务规则」的架构取舍；也可对照其"未开始显示整段时长、结束后停在 0"的 UX 细节 |
| C2 | **screenpipe 采集时间表的三态 `recordMode`**：`all / audio_only / screen_only`，按星期+时段配置 | `screenpipe@79c05c3:components/settings/schedule-settings.tsx:23-29,44-52` | 中：报告 §4.4 只借"应用/窗口规则 + 时间表"，未提"按内容类型分档采集"。本项目可做等价物："某时段只允许 P0/P1，或只做 OCR 不做 VLM" |
| C3 | **N.E.K.O 的链式污染判定器**：`_ChainTracker` + 增量词法器（引号/代码块/`<think>`/句读边界）跨消息追踪"屏幕评论串"，只保留首条评论并把后续移出请求视图 | `NEKO@0984249:utils/screen_comment_guard.py:576-593,772-831`、设计文档 `:7,84` | 中高：报告 §4.6 借"来源标记/不注入"的思想，但本项目要落地"输出过滤器/历史投影"时，逐句正则不够；其**跨消息边界词法器**是"防复读"的实现级参考（Apache-2.0，可复制） |
| C4 | **Miru 的 VLM 观察去重（per-device 相似观察跳过）** | `Miru@cbea20b:screen_analyzer.py:36,150-155` | 低中：报告提了 dHash 变化检测，但"同一画面重复观察文本去重"是 VLM 层的第二道省 token 闸门 |
| C5 | **VPet 的隐藏显示态（DisplayType=3）** | `VPet@c26be33:VPet-Simulator.Core/Display/WorkTimer.xaml.cs:144-162,180-205` | 低：专注模式"计时小条可隐藏、不占位"的最小实现语义 |

---

## 8. 审计 commit / 日期差异总表（是否推翻报告结论）

| 仓库 | 报告审计 commit（自述日期） | 本审计 HEAD（日期） | 差异 | 是否推翻报告结论 |
|---|---|---|---|---|
| `LFELKEEA/darkitten-pet` | `e1b0951`（2026-11-07） | `e1b0951` 2026-11-07 16:50 +0800 | **一致** | 不推翻（且报告 §2.1 引文可逐字对上） |
| `LFELKEEA/darkitten-launcher` | 未审计 | `39ccc87` 2026-11-09 23:34 +0800 | 报告漏项（E1） | 需补审，见 §2 |
| `SlimeBoyOwO/LingChat` | `848fd34`（2026-09-13） | `848fd34` 2026-09-13 12:56 +0800 | **一致** | 不推翻 |
| `kiyotakali/Miru` | `cbea20b`（2026-10-14） | `cbea20b` 2026-10-14 00:26 +0800 | **一致** | 不推翻 |
| `mediar-ai/screenpipe` | `2619d10`（2026-11-09） | `79c05c3` 2026-11-11 00:33 UTC | 新 2 个自然日（同一天内的后继提交）；仓库组织名现为 `screenpipe/screenpipe` | 抽查 HEAD 文件后**不推翻**（window_pattern/capture-filters/incognito/privacy 页机制仍在），但引用 commit/行号需更新（E8） |
| `Project-N-E-K-O/N.E.K.O` | `a89b685`（2026-11-10 18:14 +0800，经 .patch 核实） | `0984249` 2026-11-11 15:52 +0800 | 新 1 天 | 抽查 HEAD 文件后**不推翻**（screen_comment_guard / focus doc / exposure / screenshot_utils 均仍成立），引用 commit 需更新（E8） |
| `ayangweb/BongoCat` | `47a73ed`（2026-10-28） | `47a73ed` 2026-10-28 08:12 +0800 | **一致** | 机制不推翻，但"Tauri"技术栈错误（E5）与 fixture 统计（E4）需改 |
| `LorisYounger/VPet` | `c26be33`（2026-11-08） | `c26be33` 2026-11-08 02:28 +0800 | **一致** | 机制不推翻，显示模式条数需改（E12） |
| `refs/Mate-Engine` | `2c5ea6b`（2026-01-20） | `2c5ea6b` 2026-01-20（本地 refs） | **一致** | 不推翻；许可表述需精确化 |

> 说明：本审计时点（2026-11-11 16:30 +08:00）之后尚无更新，因此"2026-11-11 之后是否推翻"问题在当前快照下为"无 post-audit commit"；上表列的是"报告审计 commit vs 当前 HEAD"的差异。screenpipe/N.E.K.O 的差异均在同一工作日内，属正常迭代；抽查的屏相关文件未变语义。

---

## 9. 与豆包报告的最终对账

| 维度 | 报告结论 | 本审计结论 | 差异 |
|---|---|---|---|
| 选谁做窥屏参考 | darkitten-pet | **正确**（用户点名的 launcher 无实现，pet 才是） | 需补 launcher 关系说明（E1） |
| darkitten 机制清单 | 三档+auto、6 道闸门、默认关闭、内存态、SKIP、行级脱敏、整屏 `grabWindow(0)` | **逐条成立** | 2 个周边事实需改（E2/E3）；"硬编码"与 auto 降级可补精确（E6/E7） |
| darkitten 隐私缺点 | 整屏、关键词闸门、无回看/规则引擎/输出过滤 | **成立** | 无 |
| 其他 6 项目关键参数 | 具体数值/机制 | **抽查 34 条：30 准确、2 不准确（BongoCat fixtures、VPet 模式数）、2 需精确（screenpipe 许可、BongoCat 技术栈相关）** | 见 E4/E5/E9/E12 |
| 许可证 | MIT/Apache/AGPL/商业 | **方向与逐项名称均正确** | 需补 3 个注脚（E9/E10/Mate） |
| 可复制 vs 只借设计 | MIT/Apache 抄实现；AGPL/商业借设计 | **成立** | 补 vendor/资产与 NOTICE 义务 |
| 审计 commit | 8 个仓库 commit | 7 个仍一致；2 个已更新；1 个（launcher）缺失 | 更新 §8 证据表（E8） |

**建议给豆包报告的最小修改集**（按优先级）：
1. §2.1 开头加"launcher vs pet"关系说明；§8 补 launcher 审计行（E1）。
2. 改 §3 矩阵"5 分钟插件计时"→"50 分钟专注 / 5 分钟休息"（E2）；删/改 §5 `lastComment` 注释（E3）。
3. 改 §2.5"BongoCat … Tauri"→"Rust/GPUI"（E5）；"每个字段都有 fixture"→"核心行为有 fixture"（E4）。
4. 更新 §8 screenpipe/NEKO 的 commit 与日期（E8）；screenpipe 许可写全称（E9）。
5. 补 darkitten 的 vendor/资产边界（E10）；统一"三档/四档"口径（E11）；VPet 显示模式改 3 种（E12）。

---

## 10. 证据索引（本审计实际读取的文件）

**launcher@39ccc87**：`README.md`、`LICENSE`、`app.py`、`darkitten/single_instance.py`、`darkitten/updater.py`、`darkitten/diagnostics.py`、`darkitten/pet.py`、`darkitten/ui/pet_dialog.py`、`website/public/update.json`、`website/pet_release.json`、`website/public/plugins/example.screen_note-1.0.0.zip`（清单）。

**pet@e1b0951**：`LICENSE`、`README.md`、`config.py`、`screen_watcher.py`（全文 682 行）、`settings.py`、`app.py`、`plugins/lfelkeea.focus_guard/main.py`、`updater.py`、`version.json`。

**LingChat@848fd34**：`LICENSE`、`src-tauri/src/ai_service/proactive_system/{activity_monitor,interest_manager,strategy_dispatcher,delivery_evaluator,visual_monitor}.rs`、`src-tauri/src/config/proactive.rs`。

**Miru@cbea20b**：`LICENSE`、`sensor.py`、`attention_engine.py`、`screen_analyzer.py`、`docs/SCREENSHOT_REFACTOR_TODO.md`。

**screenpipe@79c05c3**：`LICENSE.md`、`README.md`、`crates/screenpipe-core/src/window_pattern.rs`、`apps/screenpipe-app-tauri/lib/settings/capture-filters.ts`、`apps/screenpipe-app-tauri/lib/utils/incognito-permission.ts`、`apps/screenpipe-app-tauri/components/settings/privacy-section.tsx`、`.../schedule-settings.tsx`。

**NEKO@0984249**：`LICENSE`、`NOTICE`、`utils/screen_comment_guard.py`、`utils/screenshot_utils.py`、`docs/design/screen-history-local-reference.md`、`docs/design/focus-truename-mode.md`、`frontend/react-neko-chat/src/ScreenObservationExposure.tsx`。

**BongoCat@47a73ed**：`LICENSE`、`Cargo.toml`、`shared/config/config.schema.json`、`shared/config/fixtures/accept-idle-hide.json`（及 fixtures 目录 114 文件清单）、`plugins/pomodoro/{plugin.json,src/main.rs}`。

**VPet@c26be33**：`LICENSE`、`VPet-Simulator.Core/Display/WorkTimer.xaml.cs`。

**refs/Mate-Engine@2c5ea6b**（本地）：`LICENSE.md`、`Assets/MATE ENGINE - Scripts/Tools/DesktopAmbientProbe.cs`。

**外部网页**：GitHub commit `.patch`（screenpipe `2619d10`、N.E.K.O `a89b685`，用于核对报告审计 commit 的存在性与日期）；screenpipe 仓库重定向（`mediar-ai/screenpipe` → `screenpipe/screenpipe`）。
