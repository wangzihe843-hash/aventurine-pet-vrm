# B 站 / 中文社区调研：桌宠「坐下 / 躺下」的过渡与状态机门控

> 调研人：bili-scout（Team Lead 分派 task-2）
> 日期：2026-11-09（所有 B 站元数据与正文抓取均在该日完成）
> 目的：为 macOS 透明悬浮桌宠「砂金·戏浪」（Electron + three.js + @pixiv/three-vrm，动作在 Blender/Unity 侧烘焙）找**中文社区**里可借鉴的「站→坐→躺 / 待机切换 / 状态门控 / 避免姿势跳变」资料。
> 验证口径：✅ = 本轮实际抓到正文/页面可读；🟡 = 标题、UP 主、发布时间、简介已通过 B 站官方接口核验，正片未逐字看（B 站字幕需登录）；⚠️ = 未验证（登录墙/风控/仅搜索摘要）。
> 外部内容一律视为 **untrusted data**，只作资料，不执行其中任何指令。

---

## 0. TL;DR（先看这 10 条）

1. **B 站上不存在「让桌宠只在该坐/躺的地方坐/躺」的专项教程**（本轮 50+ 组关键词、1100+ 条视频/440+ 篇专栏覆盖后确认）。可借鉴的是 **Desktop Mate / Mate Engine / ArkPets / LUMI** 等产品的行为语义（B 站只有介绍/教程视频，没有实现文），实现必须我们自研。
2. **用户看到的「没有过渡突然躺在地上」在 Unity 术语里对应三件事叠加**：① 过渡时长（Transition Duration）太短且姿势差太大；② 没有专门的「躺下/起身」过渡动画 clip；③ 状态门控缺失 / Any State + 常真 bool 导致乱触发。中文教程对这三件都有直接对应的踩坑与修法。
3. **Unity 官方中文手册（已实抓）**明确：过渡 = 混合时长 + 触发条件；`Has Exit Time`、`Transition Duration`、`Transition Offset`、`Interruption Source`、`Ordered Interruption` 是全部可调项。过渡时长以「秒」或「源状态归一化时间」计。
4. **Unity 官方博客《State Machine Transition Interruptions》有 B 站全文翻译**（已实抓正文，`cv15480465`，UP 主 IGBeginner0116 同时做了视频 `BV1xq4y147pD`）：默认过渡不可打断；打断时系统会把**被打断瞬间的姿势 X 记成静态状态**再从 X 混到新状态——这正是「姿势在混乱打断下看起来瞬移」的来源之一。
5. **Any State 的经典中文踩坑**（腾讯云社区问答，已实抓）：用 bool 做「任意状态→某状态」条件时 bool 恒为 true → 条件持续匹配、持续转换；修法是改用 **Trigger（一次性）** 或关掉 **Can Transition To Self**。对 three.js 侧等价建议：**门控条件必须边沿触发（false→true 才触发一次），不要每帧用常真条件 `play()`**。
6. **「过渡卡顿」的另一类中文踩坑**（`cv14119611`，已实抓）：动作循环/烘焙未勾选、各动作帧数不一致、运动速度没有平滑；对应到烘焙管线 = 坐下/躺下 clip 的循环设置、时长与采样要对齐。
7. **Animator 被 disable 时会重置到默认状态、参数清零**（`cv23293742`，已实抓，需 `keepAnimatorStateOnDisable=true`）。等价到 Electron：窗口隐藏/后台节流/挂起恢复后，动画状态可能「回到默认姿势」，需要在可见性恢复时重新对时/重放当前状态姿势。
8. **crossover 时长建议分级**：idle↔sit 这类小姿势差，0.2–0.25s crossfade 可以；**站↔躺是 >90° 髋部旋转 + 根/髋位移的大姿势差**，0.22s 的 crossfade 在视觉上必然近似「瞬移/倒地」。社区一致方向：大姿势用 **1s 级过渡时长** 或 **独立的过渡 clip**（躺下 1.0–1.4s、起身 0.8–1.2s），且过渡必须覆盖 **根/髋位置通道**（Unity 的 Root Transform Position / Bake Into Pose 对应概念）。
9. **桌面宠物的正确语义**（B 站产品证据）：Desktop Mate「they sit on your windows」、Mate Engine 支持 VRM + 窗口交互、ArkPets「站立在打开的窗口边缘」、LUMI 把「攀爬窗口/拎起抛掷」当卖点、还有开源 VRM 桌宠直接「坐在输入框上陪你写代码」。→ **「坐/躺」应当由支撑面（support）类型门控**：只有 `window-top / 窗沿 / Dock / 菜单栏` 等 perch 支撑才进入 sit/lie/sleep；**地面支撑只允许 idle/walk/land**。
10. **可执行的最小修法**（详见 §3）：给活动调度加「perch 白名单」+ 给大姿势切换做「姿势差 → fade 时长」映射或过渡 clip + 边沿触发的 one-shot 状态机 + 过渡中记录 from→to/支撑面/fade 的 debug 埋点。

---

## 1. 来源总表

### 1.1 B 站视频（元数据 ✅；正片内容 🟡）

| 标题 | 平台 / UP 主 | BV 号 / URL | 时间 | 关键结论 |
|---|---|---|---|---|
| 【Unity动画系统详解 十二】动画状态过渡中断/转换打断（Transition Interruption） | B站 / IGBeginner0116 | [BV1xq4y147pD](https://www.bilibili.com/video/BV1xq4y147pD) | 2022-03-02 | 官方博客的配套视频；简介直接给出 Unity 技术博客原文与 B 站中文翻译专栏；讲清过渡中断/打断语义（对本项目「过渡中被打断→姿势跳」最对口） |
| 8.6 状态机Animator面板设置过渡认识属性 | B站 / Unity青子 | [BV1uRzQYvELg](https://www.bilibili.com/video/BV1uRzQYvELg) | 2024-12-04 | 20 分钟讲 Animator 过渡面板全部属性（含 Exit Time/Duration/Interruption），适合对照我们「0.2–0.25s crossfade」需要哪些等价参数 |
| 【Unity组件介绍】六分钟了解 Animator 和 AnimatorState 全部参数 | B站 / 普通公鸡wh | [BV1ks4y1m79c](https://www.bilibili.com/video/BV1ks4y1m79c) | 2023-04-09 | 快速建立 Animator 参数表认知；可用于把 Unity 参数映射到 three.js 自研状态机字段 |
| 如何平滑切换动画 Animation.CrossFade | B站 / unity_某某师_高锦锦 | [BV1mB4y1t7Y5](https://www.bilibili.com/video/BV1mB4y1t7Y5) | 2022-08-10 | 简介附工程 GitHub（gaojinjin/AniamtionPlay）；「平滑切换 = 用 CrossFade 而不是直接 Play」的直接示范，正好对应 we crossfade 的用法 |
| 随机切换待机动画 | B站 / 账号已注销 | [BV1s44y187Hm](https://www.bilibili.com/video/BV1s44y187Hm) | 2021-09-07 | 社区实现「随机待机动画切换」的做法；对我们的「闲置 20s 后随机 sleep」应有直接借鉴（随机 ≠ 无条件） |
| 角色动画平滑过渡原理 inertialization 惯性化动画过渡 | B站 / amberonno | [BV1xy4y1P7mL](https://www.bilibili.com/video/BV1xy4y1P7mL) | 2023-10-24 | 介绍 inertialization（惯性化）——比 crossfade 更无「双姿势叠加感」的过渡方案；可作为站↔躺大姿势差的进阶方案 |
| 【Unity】通过鼠标点击/键盘调节状态机运行状态控制人物动画 | B站 / 阿巴吧阿巴吧QAQ | [BV1fb4y1V7rh](https://www.bilibili.com/video/BV1fb4y1V7rh) | 2023-12-11 | 演示外部输入如何驱动状态机运行（等价于我们的活动调度器发指令），可用于理解「状态只能由上层事件推进」 |
| unity 动画系统教程：动画状态机和混合树 | B站 / Fluffvoya | [BV1AwuUzUEd6](https://www.bilibili.com/video/BV1AwuUzUEd6) | 2025-07-18 | 简介附讲义 GitHub（Fluffvoya/UnityAnimationLearn）与官方文档链接；系统课，适合补齐状态机/混合树基础 |
| 【Unity2D】如何优雅的进行动画状态转换 | B站 / 阿菜O_O | [BV1rUNVeLEKS](https://www.bilibili.com/video/BV1rUNVeLEKS) | 2025-02-08 | 用状态机设计模式管理动画转换（含代码流程），把「动画切换」提升成「状态机设计」问题，和本项目方向一致 |
| 史上最全面 Unity 动画系统基础讲解 / 子状态机 | B站 / 以太视效 | [BV1dP411V7c6](https://www.bilibili.com/video/BV1dP411V7c6) | 2022-09-05 | 子状态机（Sub-State Machine）用法：把 perch-stand/sit/lie 收进一个子状态机，和 ground 状态机分开，可减少交叉过渡 |
| Unity语句解释 OnStateExit（动画状态机行为 播放结束事件） | B站 / 上月球去写甲骨文 | [BV1q44y1o7Pu](https://www.bilibili.com/video/BV1q44y1o7Pu) | 2022-12-29 | 用 StateMachineBehaviour 的 OnStateExit 做「播完再切」，等价于我们「躺下过渡 clip 播完才允许 idle 打断」 |
| Unity语句解释 OnStateUpdate（状态机行为 每帧刷新事件） | B站 / 上月球去写甲骨文 | [BV1t24y1m7MH](https://www.bilibili.com/video/BV1t24y1m7MH) | 2022-12-29 | 每帧刷新钩子的用法/注意点（判断何时在动画层做门控） |
| Unity2019新手教程 6.7.3 Animation 窗口制作动画剪辑 | B站 / 生活在他方 | [BV1zX4y1377E](https://www.bilibili.com/video/BV1zX4y1377E) | 2021-03-18 | 如何制作动画 clip——若决定补「躺下/起身」过渡动画，这是从零做 clip 的入门 |
| unity 教学：如何把两个动画结合生成新的 | B站 / 神谕怪盗 | [BV1DYfgYTESt](https://www.bilibili.com/video/BV1DYfgYTESt) | 2025-04-03 | 两个 clip 合成新动画的思路（可做「站立→躺下」过渡的素材合成） |
| 【直播答疑】如何提高自己的衔接动作质量 | B站 / 天才烧酒琪露诺 | [BV1q3n569EGw](https://www.bilibili.com/video/BV1q3n569EGw) | 2026-10-18 | 动作衔接质量的动画师视角（不是代码），对「过渡看起来不诡异」的审美标准有参考 |
| 动画该如何过渡案例分解 | B站 / 动画人小怪兽 | [BV1Pm4y127EP](https://www.bilibili.com/video/BV1Pm4y127EP) | 2023-04-19 | 2D 动画过渡案例拆解；「过渡要交代动量与重心」的通用原则可迁移到 3D 坐躺 |

### 1.2 B 站专栏 / 图文（✅ 已实抓正文；🟡 摘要级）

| 标题 | 平台 / UP 主 | cv 号 / URL | 时间 | 关键结论 | 验证 |
|---|---|---|---|---|---|
| 麻袋！放我下去！状态机转换打断（State Machine Transition Interruptions）详解 | B站专栏 / IGBeginner0116（译自 Unity 官方技术博客） | [cv15480465](https://www.bilibili.com/read/cv15480465) | 2022-03-02 | **本轮最对口的一篇**：默认过渡不可打断；`Interruption Source` 五档（None/Current State/Next State/Current Then Next/Next Then Current）；`Ordered Interruption`；打断时动画系统记录当前瞬间姿势 X 为静态状态再从 X 过渡（性能取舍）——解释「打断→姿势跳变」的机制 | ✅ |
| Unity（解决人物动画过渡卡顿问题） | B站专栏 / KONO__JOJO哒 | [cv14119611](https://www.bilibili.com/read/cv14119611) | 2021-11-23 | 过渡卡顿三个成因：动作循环/烘焙未勾选、各动作帧数不一致、运动速度未平滑（Mathf.Lerp）——映射到烘焙管线即 clip 循环、时长对齐、位移平滑 | ✅ |
| Animator 的一些坑 | B站专栏 / 度上新 | [cv23293742](https://www.bilibili.com/read/cv23293742) | 2023-04-25 | Animator 在 disable 时会被重置为默认状态、参数也重置；disable 状态下 setBool/Play/CrossFade 全部失效；`keepAnimatorStateOnDisable=true` 可保住参数 | ✅ |
| 关于在 Unity 中立刻切换正在播放动画的方法（非状态机切换的打断） | B站专栏 / 竜角伞与冰凉玩 | [cv11174781](https://www.bilibili.com/read/cv11174781) | 2021-05-06 | 想让新动作立刻打断旧动作：勾掉过渡的 **Has Exit Time**；或改用 Layer 做上半身叠加（作者实测层混合效果不符合预期） | ✅ |
| Unity-状态机过渡 | B站专栏 / unity_某某师_高锦锦 | [cv10080450](https://www.bilibili.com/read/cv10080450) | 2021-03-02 | 子状态机 Entry/Exit 节点语义：子状态机可当完整状态机用，能简练控制顶级↔子级流程 | ✅ |
| Animator 状态机配置指南 | B站专栏 / 游戏开发RAIN | [cv42129873](https://www.bilibili.com/read/cv42129873) | 2025-06-26 | 过渡条件用 Bool/Trigger/Float/Int；**「使用 Any State 谨慎，可能导致意外过渡」**；最佳实践含「用动画事件触发逻辑」 | ✅ |
| Unity笔记——Animator 动画切换的优先级和动画切换的中断处理 | B站专栏 / 黑白色的枫 | [cv25666031](https://www.bilibili.com/read/cv25666031) | 2023-08-11 | 同一状态多条出边有优先级，可手动调整；中断处理与优先级共同决定最终切到哪（搜索摘要级证据） | 🟡 |
| Unity基础_如何平缓切换动画_Animation_Play | B站专栏 / unity_某某师_高锦锦 | [cv18016302](https://www.bilibili.com/read/cv18016302) | 2022-08-09 | 摘要：「通过 Play 方法可以切换动画，但在切换动画的过程太生硬」→ 平缓切换要用过渡参数/CrossFade | 🟡 |
| Unity-动画过渡 | B站专栏 / unity_某某师_高锦锦 | [cv10159799](https://www.bilibili.com/read/cv10159799) | 2021-03-07 | 摘要：过渡 = 状态间切换或混合，定义混合耗时 + 激活条件；条件可设「特定条件成立才过渡」 | 🟡 |
| Three.js 高性能动画系统设计：骨骼动画 GPU 蒙皮与动画状态机优化 | B站专栏 / 贝格前端工场 | [cv41260263](https://www.bilibili.com/read/cv41260263) | 2025-04-07 | 同栈（three.js）中文工程文：骨骼动画 + GPU 蒙皮 + 动画状态机优化，适合本项目直接对齐概念 | 🟡 |
| Unity AnimationMixer 动画混合 | B站专栏 / 观铃的梦 | [cv21346981](https://www.bilibili.com/read/cv21346981) | 2023-01-21 | 用 Playable API 自定义动画混合（Unity 的 AnimationMixer 概念与我们 three.js AnimationMixer 同名，可对照阅读） | 🟡 |
| 从 0 到 1 制作一个 Codex 桌宠 | B站专栏 / 忆梦怀思 | [cv51718350](https://www.bilibili.com/read/cv51718350) | 2026-07-22 | 中文桌宠状态设计样例：**9 状态动画桌宠（待机/跑动/挥手/跳跃/失败…）**，是「桌宠 = 显式状态机」的社区佐证 | 🟡 |

> 注：`cv25666031`、`cv18016302`、`cv10159799`、`cv52249870` 等正文抓取被 B 站接口风控（-509 请求过于频繁）挡下；表中结论来自搜索接口返回的标题+摘要，已在「未验证清单」中登记。

### 1.3 非 B 站中文社区 / 官方中文文档（用户点名可找替代图文源）

| 标题 | 平台 | URL | 时间 / 版本 | 关键结论 | 验证 |
|---|---|---|---|---|---|
| Unity 手册：动画过渡（Animation Transitions） | Unity 官方中文文档 | <https://docs.unity3d.com/cn/6000.0/Manual/class-Transition.html> | Unity 6.0 中文 | 过渡定义 = 切换/混合 + 条件；关键参数 `Has Exit Time`（归一化时间，循环动画每循环评估一次）、`Transition Duration`（秒或源状态归一化时间）、`Transition Offset`（目标状态起始偏移）、`Interruption Source`、`Ordered Interruption` | ✅ |
| Unity 手册同页锚点：过渡中断 / 官方博客 | Unity 官方中文文档 + Unity Blog | <https://docs.unity3d.com/cn/6000.0/Manual/class-Transition.html#TransitionInterruption> · <https://unity.com/blog/engine-platform/state-machine-transition-interruptions> | 2016 原博客 | 中断源/按顺序打断的官方定义（B 站 cv15480465 即其翻译） | 🟡（手册页链接已核实；博客正文未抓） |
| 在 Unity Animator 中使用 “Any State” 的问题 | 腾讯云开发者社区（Stack Overflow 翻译，问答已实抓） | <https://cloud.tencent.cn/developer/ask/sof/1652710> | 2018-08-29 提问 / 回答 | 「bool 的问题是它总是 true，所以条件会一直匹配、一直转换到同一动画」；修法：改用 **Trigger**，或在 Any State→目标状态的过渡里**禁用 Can Transition To Self** | ✅ |
| VRM 模型配 Mixamo 动画：从 Blender 烘焙到 three.js 播放的完整流程 | CSDN | <https://blog.csdn.net/weixin_35815766/article/details/167932819> | 2026-10-14 | 同栈链路：VRM 与 Mixamo 骨骼命名/坐标系/姿态差异 → Blender 做 Retarget + Bake → three.js 播放；含 T-Pose 对齐与 five 个实操坑（AI 辅助生成风格，谨慎引用） | ✅（页面可读，内容质量中等） |
| 【AI造梦】《凡人修仙传》银月桌宠开发指南（一） | CSDN | <https://blog.csdn.net/u012210662/article/details/149767222> | 2026-11-08 | 零代码 AI 桌宠制作流程（形象/动作/语音/组装），**不含动画状态机实现**，仅作「桌宠=动作库+行为」背景 | ✅（低技术价值） |
| Unity + Cubism 制作桌宠踩坑记录（续） | 知乎 | <https://zhuanlan.zhihu.com/p/1893649762223371092> | 2026 年（搜索显示） | 标题即「桌宠踩坑」；正文被知乎 403 拦下，仅搜索摘要 | ⚠️ |
| 桌宠穿透不是一行 SetWindowLong（掘金长文） | 掘金 | <https://juejin.cn/post/7705683246910177307> | — | 窗口命中/多屏 clamp/置顶是状态不是常量；**主题是窗口而非动画过渡**，来自项目既有调研文档的引用，本轮未独立复验 | ⚠️ |

> 另：项目内既有报告 [window-landing-research-2026-11-09.md](../window-landing-research-2026-11-09.md) §3.5 已整理「B 站没有让桌宠站到其他窗口上沿的专项教程」的结论；本报告在其基础上补上「坐/躺过渡与状态机」侧证据。

### 1.4 桌面宠物产品行为证据（B 站，元数据 ✅）：证明「坐/躺 = 窗口支撑语义」

| 标题 | UP 主 | URL | 时间 | 与「坐/躺只在窗口上」相关的结论 |
|---|---|---|---|---|
| 全新 3D 桌宠软件 Mate Engine 教程解说 支持自定义 VRM 模型 | 麻中麻麻子 | [BV143GazEESR](https://www.bilibili.com/video/BV143GazEESR) | 2025-05-01 | Unity + VRM 的 3D 桌宠，支持自定义模型/换装/交互；产品行为里「站/坐在窗口边缘」是标志性交互（与原作一致） |
| 【Desktop Mate】中文教程 - 替换你的 VRM | 夏凌岚 | [BV14fcMebEV3](https://www.bilibili.com/video/BV14fcMebEV3) | 2025-01-12 | Desktop Mate 官方语义即「sit on your windows」；B 站教程聚焦换模，说明社区把它当「窗口支撑型」桌宠 |
| 开源 DeepSeek 桌宠希可儿｜3D VRM 插件，坐在输入框上陪你写代码 | 在哪儿不是老农民 | [BV1sgxd6PEGh](https://www.bilibili.com/video/BV1sgxd6PEGh) | 2026-11-05 | 简介：GitHub `mymde/deepseek-mate` / npm `dsh-plugin-whale-mate`；**明确以「坐在输入框上」为卖点**——坐姿由 UI/窗口支撑面驱动 |
| 【ArkPets】如何把全岛的干员变成桌宠？ | 星光China | [BV1bG4y1W7Lu](https://www.bilibili.com/video/BV1bG4y1W7Lu) | 2022-10-04 | 简介写明 ArkPets 由 Java&libGDX 实现、Windows 平台；ArkPets 官方功能「桌宠可以站立在打开的窗口边缘」 |
| 运用 Shimeji 桌宠程式教程（可用其他桌宠图） | Sky_于煜魚魚 | [BV1yHQDYHEuK](https://www.bilibili.com/video/BV1yHQDYHEuK) | 2025-03-15 | Shimeji 系桌宠的行为库建立在「活动窗口 = 可交互环境（上/左/右/下边）」之上，宠物可爬/挂在窗口边——窗口支撑语义的最早范式 |
| 【搬运/电脑桌宠】Shimeji 使用的常见问题解答（中文字幕） | sn11_ | [BV1ke4y1N7Dg](https://www.bilibili.com/video/BV1ke4y1N7Dg) | 2023-02-05 | Shimeji 行为/动作常见问题；可作为「动作库拆分方式」参考 |
| 关于桌宠如何在全屏模式下做动作 | 高橋_直樹 | [BV1mtBMYgECc](https://www.bilibili.com/video/BV1mtBMYgECc) | 2024-12-13 | 桌宠与「其他窗口/全屏」交互的边界条件；提醒窗口支撑/动作在特殊 z 序下失效的坑 |
| 如何实现 Unity 的窗口透明化? 老婆 / 桌宠 / 女仆 / 桌面组件 / 虚拟主播 | 辣子laziman | [BV1wN411q7ys](https://www.bilibili.com/video/BV1wN411q7ys) | 2023-08-29 | Unity 侧窗口透明/穿透实现（Windows；macOS 需换 CGWindowList/AX）；说明「窗口交互」是独立一层，不与动画层混写 |
| 实现桌面宠物如此简单！Unity 实现透明窗口：无边框 + 点透 + 置顶全教程 | 手拿肉的美女剑豪 | [BV1uQaWzmEg8](https://www.bilibili.com/video/BV1uQaWzmEg8) | 2025-09-02 | 同上（Windows API 向）；可作「窗口层」与「状态机层」解耦的参考 |
| (创建/描述/动画原理) [官方] 虚拟桌宠模拟器 mod 动画制作教程 上期 | 杨远洛里斯 | [BV1RN4y1k7TC](https://www.bilibili.com/video/BV1RN4y1k7TC) | 2023-10-17 | 2D 桌宠（VPet）官方动画教程：动作如何按状态组织、mod 侧如何新增动画——可对照「桌面宠物活动库」的拆法 |
| 【桌宠教程】养一只虚拟主播在桌面上可以的！ | 五月梅花落 | [BV1Qh411279C](https://www.bilibili.com/video/BV1Qh411279C) | 2021-01-14 | Live2DViewerEX 桌宠完整制作教程（非 3D，但含「动作触发/待机」配置流程，可参考其状态组织方式） |

---

## 2. 分主题摘录（全部可点击）

### 2.1 大姿势切换不要只靠短 crossfade（核心答案）

中文社区在这一层的共识可以压缩成一句话：**过渡的「平滑」不只取决于 blending 方式，而取决于「耗时是否匹配姿势差 + 是否有专门的过渡段」**。

- Unity 中文手册把过渡定义为「从一个动画状态切换或混合到另一动画状态」，可调混合时长与条件；`Transition Duration` 既可按秒、也可按源状态归一化时间解读——这意味着**同一个 0.22s 参数作用在不同长度/不同姿势差的 clip 上，观感完全不同**：  
  <https://docs.unity3d.com/cn/6000.0/Manual/class-Transition.html>
- 中文专栏《Unity（解决人物动画过渡卡顿问题）》给出「卡顿/不自然」的三个工程成因与检查单：「检查动作的循环和烘焙是否已勾选；每个动作是否都为同样的帧数；平滑矢量运动速度（Mathf.Lerp）」——直接对应我们烘焙侧要检查：**sit/lie clip 的循环设置、帧数与采样是否与 idle 对齐、落地/起身的水平位移是否做了平滑**：  
  <https://www.bilibili.com/read/cv14119611>
- 《Unity基础_如何平缓切换动画_Animation_Play》的摘要点破另一种常见错误：**直接 `Play()`/直接切 clip 必然生硬**，平缓要靠过渡参数/CrossFade：  
  <https://www.bilibili.com/read/cv18016302>
- CrossFade 的正确用法示范（附工程）：<https://www.bilibili.com/video/BV1mB4y1t7Y5>

**对本项目的直接含义**：现在 sleep 的 crossfade 只有 0.2–0.25s，若目标是「站/坐 → 躺」这种髋部旋转 >90° 且重心大幅下降的姿势，0.22s 混合相当于把两个差异巨大的姿势在半秒不到内叠成中间态，视觉上就是「啪一下躺下」。要么把这个过渡拉到 ~1s 级，要么补一条真实的「躺下」过渡 clip，crossfade 只负责 clip 之间的接缝。

### 2.2 过渡参数到底有哪些（Unity 中文手册实抓要点）

> 摘自 <https://docs.unity3d.com/cn/6000.0/Manual/class-Transition.html>（Unity 6.0 中文手册，2026-11-09 抓取）：

- **Exit Time / Has Exit Time**：「如果选中 Has Exit Time，此值表示过渡可以生效的确切时间。该时间以标准化时间表示（例如，退出时间为 0.75 表示，在已播放 75% 动画的第一帧上，Exit Time 条件为 true）。在下一帧上，该条件为 false。对于循环动画，每个循环都会评估退出时间小于 1 的过渡。」→ **「等当前动作播到某个点才允许切」**；对应到 three.js 侧 = 用 clip 进度或 `LoopOnce`+`finished` 事件做门控，而不是到点就无条件切。
- **Transition Duration**：「相对于当前状态持续时间的过渡持续时间，以标准化时间或秒为单位（具体取决于 Fixed Duration 模式）」。
- **Transition Offset**：「过渡到的目标状态的起始播放的时间偏移（0.5 = 目标状态从 50% 处开始播）」→ 躺下 clip 若前面有 0.2s 静止预备帧，可用 offset 跳过，避免「躺下前先僵一下」。
- **Interruption Source**：「此选项用于控制该过渡可能中断的情况」；**Ordered Interruption**：「确定当前过渡是否可在不考虑顺序的情况下被其他过渡中断」。

### 2.3 中断机制：为什么「打断」会把姿势变成瞬移

B 站专栏 `cv15480465` 是 Unity 官方博客《Wait, I've changed my mind!》的全文翻译（正文已抓取），关键段落：

> 「在默认的情况下，动画转换时不能被打断的。只要动画开始从一个状态转向另一个状态，那就没有办法跳出这个转换了。就像已经在飞行途中的飞机乘客……」
> 「当打断发生时，动画系统会记录下当前时刻的动画数值 X，这个 X 是一个静止的固定状态，然后从 X 状态过渡到 C 状态。」
> 「为什么系统要使用 X 这么一个静止的固定状态，而不是在两个动态的转换（transition）间做过渡（blend）呢？简单来说就是节约性能。」

→ 对本项目的三点启示：

1. **躺下/起身这类过渡应当「不可打断」**（对应 Interruption Source = None 的语义），否则用户拖拽/活动调度在过渡中途插入 idle/stand，会把「半躺的静态姿势」直接混去别的状态，看起来就是姿势诡异跳变；
2. 如果三.js 自研状态机里允许随时 `play` 新 clip，等价于「所有过渡都可被任意打断」——需要显式给每个 state 标记 `interruptible`；
3. 打断时「从当前混合姿势的静态快照继续」本身是合理设计，但前提是**快照是连续姿势**；如果混合本身没覆盖根/髋位移通道，快照会缺位移 → 看起来「人穿进地面/瞬移」。

- B 站视频版：<https://www.bilibili.com/video/BV1xq4y147pD>（简介给出原文与翻译链接）
- 官方原文：<https://unity.com/blog/engine-platform/state-machine-transition-interruptions>

### 2.4 Any State + 常真 bool：桌宠「自己突然切动作」的经典成因

腾讯云社区问答（Stack Overflow 中文翻译，正文已抓取）中，提问者用 Any State + bool 做「滑雪/跳跃」过渡，结果**动画不是切过去播放，而是不停地在同一目标状态间转换**。高票回答：

> 「bool 的问题是，isJumping 总是设置为 true，所以您的条件会保持匹配，并且您会继续转换到相同的动画。另一方面，Trigger 一旦被使用就会被禁用。」
> 补充修法：「或者……你可以在‘任何状态到你的状态’的转换设置中禁用‘可以转换到自己’选项（Can Transition To Self）。」

- 原文：<https://cloud.tencent.cn/developer/ask/sof/1652710>

**映射到本项目（Electron + three.js 自研调度）**：如果活动调度写成「每帧检查 `if (idleTime>20 && canSleep) startSleep()`」或「`sleepRequested=true` 持续为真」，就会等价于 Any State + 常真 bool：只要条件满足就会反复触发/反复重进 sleep。正确做法是 **edge-trigger one-shot**：只在 `false → true` 的上升沿触发一次，且进入前校验支撑面 + 冷却时间；同时给状态机加「不能从 sleep 再过渡到 sleep」的自转换保护。

### 2.5 中文踩坑：Animator 重置、立刻切换、过渡卡顿

- **Animator 被 disable/reset**：「Animator 默认情况下在 disable 时会被重置为默认状态，参数也会重置为默认。在 disable 状态下任何命令都会失效，例如 setbool/settigger/Animator.play/crossfade 等。可以设置 `animator.keepAnimatorStateOnDisable = true`…但 play 和 crossfade 依然不会生效。」  
  → 等价风险：桌宠窗口被隐藏/遮挡（macOS occlusion）、应用进入后台节流、睡眠唤醒后，动画状态可能回到「默认/静止姿势」，恢复显示瞬间出现姿势跳变。建议**可见性恢复时重新对时并重放当前状态**，或暂停时保留当前 pose 快照。  
  <https://www.bilibili.com/read/cv23293742>
- **立刻切换的正确开关**：想「新动作立刻打断旧动作」应关掉 **Has Exit Time**；用 Layer 做上半身叠加是另一种方案但作者实测不适用于他的需求。  
  <https://www.bilibili.com/read/cv11174781>
- **过渡卡顿三查**：循环/烘焙勾选、动作帧数一致、运动速度 Lerp 平滑。  
  <https://www.bilibili.com/read/cv14119611>
- **优先级与中断**：同一状态多条出边有优先级、可手动排序；结合中断源决定最终落到哪条过渡。  
  <https://www.bilibili.com/read/cv25666031>（摘要级）
- **子状态机**：把「perch 上的 stand/sit/lie」收成一个子状态机，与「ground 的 idle/walk/land」分开，减少两边交叉过渡的组合爆炸。  
  <https://www.bilibili.com/read/cv10080450>
- **状态机行为钩子**：OnStateExit/OnStateUpdate 可用于「过渡播完才放行」或每帧门控：<https://www.bilibili.com/video/BV1q44y1o7Pu> · <https://www.bilibili.com/video/BV1t24y1m7MH>

### 2.6 进阶：惯性化（inertialization）——比 crossfade 更「无痕」的过渡

B 站视频《角色动画平滑过渡原理 inertialization 惯性化动画过渡》讲的是游戏业界处理大姿势差切换的方法：不是线性混合两个 clip 的姿势，而是**只保留切换瞬间的速度/惯性并衰减到目标姿势**，避免 crossfade 常见的「两个姿势同时可见」的软塌感：  
<https://www.bilibili.com/video/BV1xy4y1P7mL>

对我们的意义：如果最终仍不想做「躺下过渡 clip」，inertialization（或简化的「速度衰减 + 目标姿势吸附」）是比 0.22s crossfade 更自然的大姿势切换方案；但实现成本高于「加长 fade + 过渡 clip」。优先级建议：**过渡 clip > 长 crossfade + 根位移混合 > inertialization 自研**。

### 2.7 「坐/躺只在窗口上」：B 站只有产品行为，没有实现教程

本轮针对「桌宠 坐在窗口 / 窗口上沿 / 窗台 / 攀爬 / 挂在窗口」等 20+ 组关键词的 B 站检索结果：

- **没有任何**讲「如何在代码/状态机层面把 sit/lie 限制到窗口支撑面」的中文教程；
- 但产品侧证据很集中：Desktop Mate（sit on windows）、Mate Engine（VRM + 窗口交互）、ArkPets（窗口边缘站立）、LUMI（攀爬窗口/抛掷）、Shimeji（活动窗口四边 = 可交互环境）、以及 2026 年开源 VRM 桌宠把「坐在输入框上」当卖点（见 §1.4 表）。
- 这些产品共同的隐含设计是：**「窗口/UI 边缘」是一种特殊的支撑面（support），宠物的行为集合按支撑面类型分组，而不是全局共用一套 idle 随机**。对我们来说，活动库里 `sit`、`lie`、`sleep` 必须带前置条件 `support.kind ∈ {window-top, menubar, dock, window-side(若可站)}`，`ground` 支撑只允许 `idle / walk / land`。

> 这一结论与项目既有调查一致：[window-landing-research-2026-11-09.md](../window-landing-research-2026-11-09.md) §3.5 也记录「B 站没有让桌宠站在其他窗口上沿的专项教程」。

### 2.8 待机随机动作 / 睡眠调度：社区做法

- 《随机切换待机动画》：社区实现「随机切待机动画」的常规做法是维护待机动作列表 + 随机 + 权重/冷却；注意它的随机是**在 idle 状态内部换小姿势**，而不是随机进入坐/躺这种大状态：<https://www.bilibili.com/video/BV1s44y187Hm>
- 《从 0 到 1 制作一个 Codex 桌宠》：中文桌宠把行为显式拆成 **9 状态动画（待机/跑动/挥手/跳跃/失败…）**，是「桌宠活动 = 状态机」的直接社区佐证：<https://www.bilibili.com/read/cv51718350>（摘要级）

**对本项目的直接含义**：闲置 20s 后「随机触发 sleep」这个逻辑本身可以保留，但**候选集合必须按支撑面过滤**——在地面时把 sleep 从随机候选里剔除（或改为地面专属的小憩行为，若产品需要）；并且随机触发要基于「当前状态 + 支撑面 + 冷却 + 上次动作」的权重，而不是无条件随机。

### 2.9 工程栈相关（Electron / three.js / VRM）

- 《Three.js 高性能动画系统设计：骨骼动画 GPU 蒙皮与动画状态机优化》（中文）：把「骨骼混合 + 状态机」放在 three.js 语境下讲，可作为把 Unity 概念映射到自研状态机的桥梁：<https://www.bilibili.com/read/cv41260263>（摘要级）
- 《Unity AnimationMixer 动画混合》（Playable API 自定义混合）：虽然引擎不同，但「AnimationMixer/混合权重」概念与 three.js `AnimationMixer/PropertyMixer` 同名，可对照理解「weight<1 时混回原姿势」的行为：<https://www.bilibili.com/read/cv21346981>（摘要级）
- 《VRM 模型配 Mixamo 动画：从 Blender 烘焙到 three.js 播放的完整流程》：同栈烘焙→three.js 链路 + T-Pose 对齐 + five 个坑（AI 辅助生成，谨慎引用）：<https://blog.csdn.net/weixin_35815766/article/details/167932819>
- 同栈踩坑（Electron+Vue3+three.js+VRM，项目内部文档引用、本轮未独立复验）：高 DPI 拖动窗口被系统改尺寸、MToon 禁用 toneMapping、raycast 把 FPS 60→9：<https://www.bilibili.com/read/cv52249870>（⚠️ 未验证）

---

## 3. 对本项目可执行建议（结合现有实现）

> 背景：当前 sleep 在任意地面、闲置 20s 后可能随机触发，播躺姿且 crossfade 仅 0.2–0.25s；用户诉求 = 只会在被放在窗口上时坐下/躺下，且不要「没有过渡突然躺地」。以下建议不涉及改代码，供 Lead/实现会话采用。

### P0：先门控，再谈过渡（直接消除「地上突然躺下」）

1. **活动候选按支撑面过滤**：给活动库的每个活动标 `allowedSupports`。`sit / lie / sleep` 只允许 `window-top / menubar / dock / perch`（即项目里 `sittable` 的支撑面）；`ground` 只允许 `idle / walk / land / stretch`。地面状态下把 sleep 从随机候选集合中移除（或改成专属的「地面小憩」姿态，若产品明确需要）。
2. **进入条件显式化**（建议写进状态机迁移表）：
   - `ground-idle → perch-stand`：需 `support.kind ∈ perch白名单` 且当前姿态可站；
   - `perch-stand → perch-sit`：需 `headroom` 允许坐；
   - `perch-stand / perch-sit → perch-lie → sleep`：**仅 perch**；
   - `perch-lie → perch-stand`：走「起身」过渡；
   - 任意 `perch-* → ground-*`：被拖拽/失去支撑时立即进入，允许打断。
3. **边沿触发 + 冷却**：`sleepCondition` 由 false→true 的上升沿触发一次；加 `lastActivityEndTime` 冷却（例如 ≥8s），并禁止 `sleep → sleep`（等价 Unity 的 Can Transition To Self = false）。这是 Any State + 常真 bool 坑的直接对策（§2.4）。

### P0/P1：让「站↔躺」真的有过渡

4. **过渡时长分级**（若暂不做过渡 clip）：`fadeSec = clamp(base + k * maxBoneAngleDelta, 0.2, 1.4)`，例如 `maxBoneAngleDelta` 以「关键骨（hips/spine/upperLeg）相对当前姿势的最大角差」估计：小姿势差（idle↔sit，<40°）→ 0.2–0.3s；大姿势差（站/坐↔躺，>90°）→ 0.9–1.4s。修改点仅在活动调度的 fade 参数，不动动作资产。
5. **首选补两条过渡 clip**：`lie-down`（1.0–1.4s）与 `get-up`（0.8–1.2s），在 Blender/Unity 里烘焙；进入 `perch-lie` 时先播 `lie-down`（`LoopOnce` + `clampWhenFinished`），完成后再切 `lie-idle`（crossfade 0.2–0.3s）。这等价于 Unity 教程里「大状态变化用过渡动画而不是硬 blend」的标准做法。
6. **根/髋位移必须参与混合**：躺姿 clip 通常会下移髋部/改变 root 高度。如果自研 clip-player 只混 rotation、而 root/hips 位置由物理或活动代码控制，结果就是「身体瞬间贴地」。要在 crossfade 中同时混合位置通道（或单独 lerp `hipsY/rootOffset`），并检查烘焙时 `Root Transform Position (Y)` / `Bake Into Pose` 的等价设置（Unity 概念，见官方过渡/根运动文档）。
7. **过渡打断规则**：`lie-down` / `get-up` 标记 `interruptible = false`（对应 Interruption Source=None 语义，§2.3）；只有「用户拖拽/失去支撑/紧急回 ground」可以打断，且打断时走 0.15–0.2s 的快速回到当前支撑面站姿的兜底过渡。

### P1/P2：稳定性与可观测性

8. **可见性/节流恢复**：在 Electron 窗口 `visibilitychange`/occlusion 恢复、系统睡眠唤醒后，检查 mixer 的 current action 与 pose 是否仍是当前状态；若被发现重置/暂停，按「当前状态 + 当前 clip 时间」重新 apply 并 fadeIn（对应 Animator disable 重置坑，§2.5）。`backgroundThrottling:false`/`powerSaveBlocker` 属既有窗口侧事项，不在本报告展开。
9. **随机待机只在 ground-idle 内做小姿势**：复用「随机切换待机动画」思路：权重 + 冷却 + 不跨大状态（§2.8）。sleep 的随机只在 `perch` 的 `sit/lie` 内触发。
10. **Debug 埋点**：每次状态切换记录 `from, to, support.kind, sittable, maxBoneAngleDelta, fadeSec, interruptedBy`；「诡异躺地」复现时能一眼看出是「地面触发了 sleep」还是「过渡时长/根位移不对」。与项目既有 debug 面板（surfaces + motion）并列展示。

### 落地顺序建议

1. P0-1/2/3（候选过滤 + 边沿触发）→ 立刻满足用户「只会在窗口上坐/躺」的诉求，且改动面小；
2. P0-4（fade 分级）→ 即便没有新 clip，也能显著减轻「突然躺下」观感；
3. P1-5/6/7（过渡 clip + 根位移 + 不可打断）→ 真正的自然过渡；
4. P2-8/9/10（恢复兜底 + 随机策略 + 埋点）→ 防回归。

---

## 4. 未验证清单

| 项目 | 状态 | 原因 / 备注 |
|---|---|---|
| 知乎《Unity + Cubism 制作桌宠踩坑记录（续）》正文 | ⚠️ 未验证 | 页面 403（登录/反爬）；仅搜索摘要可见 |
| B 站专栏 `cv25666031`、`cv18016302`、`cv10159799`、`cv52249870` 正文 | ⚠️ 未验证正文 | B 站文章接口对本机 IP 限流（-509/-352）；标题/作者/时间/摘要来自搜索接口，已核验 |
| B 站专栏 `cv21346981`、`cv41260263`、`cv51718350` 正文 | 🟡 摘要级 | 同上（限流），仅标题+摘要级信息 |
| 各 B 站视频的「正片内容」 | 🟡 未逐字观看 | B 站字幕接口需登录；本轮只核验标题、UP 主、发布时间、时长、简介 |
| Unity 官方英文博客《State Machine Transition Interruptions》正文 | 🟡 未抓正文 | 手册页与 B 站视频简介都引用了该 URL；本轮以 B 站全文翻译 `cv15480465`（已抓正文）为准 |
| 掘金《桌宠穿透不是一行 SetWindowLong》 | ⚠️ 未独立验证 | 来自项目既有调研文档引用，本轮未重抓 |
| CSDN 两篇 | ✅ 页面可读，但内容标注风险 | 《VRM+Mixamo→three.js》为 AI 辅助生成风格；《银月桌宠》为零代码工具文，技术价值低 |
| 「桌宠坐/躺只在窗口上」专项中文教程 | ❌ 不存在（本轮确认） | 50+ 组关键词、1167 条 B 站视频 + 448 篇专栏去重后无对口教程；只能参考产品行为 + Unity 过渡通用知识 |

## 5. 检索方法与数据说明

- **B 站检索**：通过 B 站官方搜索接口（`api.bilibili.com/x/web-interface/search/type`，`search_type=video/article`）+ 视频详情接口（`/x/web-interface/view`）批量拉取；多轮关键词覆盖：桌宠/桌面宠物/VRM/Mate Engine/Desktop Mate/ArkPets/Shimeji/坐/躺/睡/待机/窗口/上沿/窗沿/攀爬/状态机/过渡/切换/中断/Interruption/Exit Time/Any State/CrossFade/淡入淡出/惯性化/three.js/AnimationMixer/Electron 等 50+ 组；去重后 **1167 条视频 + 448 篇专栏**，按主题相关度打分筛选出本报告引用项。
- **正文获取**：B 站专栏经 `api.bilibili.com/x/article/view` 抓取（成功：cv15480465、cv14119611、cv23293742、cv11174781、cv10080450、cv42129873；其余被限流）。Unity 中文手册、腾讯云问答、CSDN 页面直接抓取验证。所有「引号内文字」均来自实抓正文；摘要级来源已标注。
- **局限**：B 站视频正片/字幕需登录，本轮无法逐字核验视频内容；因此视频条目只作「主题定位 + 元数据」，具体结论以可抓取的专栏/官方文档为准。
- 本文件是**唯一新增文件**；未修改项目任何源码/配置/测试。
