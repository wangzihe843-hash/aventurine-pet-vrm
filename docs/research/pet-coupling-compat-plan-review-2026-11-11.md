# 评估：豆包《桌宠 × DSH 强耦合的兼容性安全调查》与方案

> 日期：2026-11-11 · 评估者：Lead
> 复核基线：本仓库当前 working tree（含 **12:33** 对真实 `~/.dsh/profiles/desktop` 的桥激活）、
> DSH 0.2.2-rc.1 桌面版（`/Applications/DeepSeek Harness.app`，Info.plist
> `CFBundleShortVersionString=0.2.2-rc.1`）、从 `app.asar` 抽取的 DSH 源码
> `/tmp/dsh-asar-audit/extract`（`lib/main.js`、`dsh/node_modules/@deepseek-ai/dsh-app-boot/lib/index.js`）。
>
> 豆包原文：`docs/research/pet-coupling-compat-investigation-2026-11-11.md`（写于 11:02）。
>
> **总评**：宿主侧失败隔离的实测结论基本成立，方向（能力握手 + `DEGRADED` 降级）正确；
> 但计划里有 **1 个已过时的关键事实**、**1 个会让版本护栏直接失效的安装形态漏洞**、
> **4 处与用户"保留同生共死"目标冲突的语义错误**，另有 **11 处实现/验收疏漏**。
> 按本评估与配套计划
> [`docs/pet-dsh-coupling-safety-plan-2026-11-11.md`](../pet-dsh-coupling-safety-plan-2026-11-11.md)
> 修正后再实施；原调查文档的 §1 实验证据仍可作为回归素材保留。

## 1. 成立、可直接沿用的部分

1. **DSH 对"可选插件"的失败隔离**：`preflight()` 只对 `engines.dsh`/dsh peers 冲突的行
   `row.disabled = true` + stderr 报告，宿主继续启动（`dsh-app-boot/lib/index.js:3091-3172`）；
   插件 import 抛错 / `apply` 同步抛错 → entry 不激活、宿主继续；这些与豆包实测一致。
2. **唯一能打死宿主的插件行为是脱离 apply 的异步孤儿抛错**（定时器/回调里 throw 或无
   `catch` 的 promise rejection），以及 **profile patch YAML 写坏导致启动直接失败**。
   这两条决定了本计划的加固重点，判断正确。
3. **"版本不兼容本身不会直接让两个都打不开"**：DSH 侧确实不会因为桥不兼容而打不开
   （但见 E1：真实安装形态下**闸门根本不生效**，因此这条不能靠"闸门会禁用"来保障）。
4. **桌宠侧才是主要风险**：`STARTING` 只看进程就 `enterPaired`、PAIRED 后 DSH 起不来会
   cascade 自杀、桌宠退出会杀 DSH、`STARTING` 无限重试 —— 这些与当前代码一致
   （`src/main/desktop/dsh-lifecycle.ts`）。
5. **`control.json` 的 `schemaVersion`/`bridgeVersion` 目前只做类型校验、没有版本比较**；
   设置页 banner / 托盘提示等"提示通道"确实缺（但见 E8、E11 的实现约束）。
6. **方案 C（把桌宠做成进程内插件）拒绝**：结论正确。
7. **§6 的三个决策点**：本次已按用户"保留同生共死 + 保证 DSH 能打开修桌宠"的目标拍板，
   见修正计划的 §2/§3（不再阻塞实现）。

## 2. 错误与过时结论（必须修正）

### E1（关键）"桥未安装 / `~/.dsh` 搜不到 aventurine-bridge"已过时；且真实安装形态没有 `engines.dsh`，DSH 版本闸门实际不生效

- 现状（12:33 起）：`~/.dsh/profiles/desktop/cordis.patch.yml` **已有** `aventurine-bridge` insert 行，
  入口是 `work/live-bridge/rev-1794371618691/lib/index.js`（`scripts/activate-dsh-bridge.mjs`
  生成的 live 副本）；`~/.dsh/aventurine-pet/control.json` 为 `attached, bridgeVersion:3`。
  豆包文档 11:02 写就，其"整个 `~/.dsh` 搜不到"只对那一刻成立，现已失效。
- 更严重的是：`manifestOf()` 从入口向上找最近 `package.json`（`dsh-app-boot/lib/index.js:3047`），
  而 live 副本的 `package.json` 只写了 `name/version/type/main`，**没有 `engines.dsh`**；
  `unmetRequirements()` 只在 manifest 有自有 `engines.dsh`（或 dsh peer）时才拦
  （`:1097-1116`）→ **真实部署形态下版本闸门完全不存在**，未来 DSH 0.3 会把旧桥照装不误。
  豆包计划"DSH 侧不用改、已有版本闸门兜底"的核心假设在真实形态下不成立。
- 修正：激活脚本生成的 live 副本必须复制 `engines.dsh`，并写入安装清单；canary 必须覆盖
  "绝对路径 insert + live 副本 package.json"这一真实形态（不能只测 `dsh plugin add` bundle 形态）。

### E2 "`DEGRADED` 停止一切联动：不杀 DSH、**不因 DSH 退出而 cascade**"与用户的保留语义冲突

用户明确要求**保留**"DSH 启动 → 桌宠启动；DSH 退出 → 桌宠退出"。`DEGRADED` 下应保留
**单向安全跟随**：DSH 进程消失 → 桌宠跟随退出（`dsh-degraded`，不重启、不发信号）；
只去掉危险动作（重启 DSH、SIGTERM DSH、拉起循环）。"不跟随退出"会让桌宠在 DSH 已关闭后
常驻，既违背用户设计，也让排障状态不可预期。

### E3 `UNPAIRED` 只有"不联动、不杀"，没有退出语义与超时

"只看到进程 → `UNPAIRED`"需要补充：① 超时（建议 20s，须覆盖桥 HMR 1~2s 与首次启动窗口）
→ `DEGRADED`；② `UNPAIRED` 下 DSH 进程消失 → 同 E2 跟随退出；③ 握手恢复健康 → `PAIRED`
（自动恢复，不能要求重启桌宠）。

### E4 没有"新鲜度"判定：陈旧的 `control.json` 会造成假 `PAIRED`

`dsh-watch` 启动后首次轮询会无条件读一次 `control.json`，上一次 DSH 会话留下的
`attached` 帧会被 `handleControl` 当成"桥已加载"直接 `enterPaired()`（当前
`dsh-lifecycle.ts:731-746` 不看进程、不看心跳新鲜度）。若此时 DSH 并未运行/桥已被禁用，
后续"进程消失"会走崩溃恢复把 DSH 拉起来 —— 正是版本更新场景下最需要避免的竞态。
修正：`PAIRED` 门槛 = **进程在运行 + `status.online`（30s TTL 心跳新鲜）+ `control.attached`
+ compat 校验通过**，四者同时成立。

### E5 没有对"现网已安装的 v3 桥"的向后兼容

真实桥是 `bridgeVersion:3`，升级后的桌宠若要求必须带 `compat` 块，用户不先重装桥就会
直接降级、丢失联动。修正：v3（无 compat）走 **legacy 范围回退**（`>=0.2.2-rc.1 <0.3.0`，
折入桌宠共享契约常量），能验证就照常 `PAIRED`；v4 起必须带 compat。

### E6 桥被闸门禁用时"桥侧 compat 块"不可达，没有可解释性通道

版本闸门静默禁用 → 桥一次都不会 apply → 不会写 `status/control/compat`。此时桌宠只能看到
"DSH 在跑但没有桥文件"，无法区分"没装 / 被禁用 / 装坏 / 版本不兼容"。
修正：① 激活脚本写 `~/.dsh/aventurine-pet/install.json` 安装清单（桥的声明范围、版本、
安装时间、入口、pet 路径），桌宠在桥缺席时用它 + DSH 版本做静态判定；② 桥 apply 失败时写
`bridge-error.json` 诊断；③ 告警里给出原因码与 DSH 版本/桥范围，而不是笼统"未连接"。

### E7 版本比较细节未定义（prerelease 语义、失效范围）

DSH 闸门用 `semver.satisfies(..., { includePrerelease: true })`（`dsh-app-boot/lib/index.js:1094-1095`）。
桌宠侧必须用同一语义，否则会出现"DSH 认为兼容、桌宠认为不兼容"的双源漂移。且
`0.3.0-rc.1` 在 `<0.3.0` 下按 includePrerelease 语义**是满足的**（prerelease 只影响比较，
不排除），这类边界要有单测锁定。解析失败/未知语法一律按"不可验证"降级，不得猜"兼容"。

### E8 提示通道方案包含设置页 banner（renderer），与另一个会话的模型侧改动冲突

`src/renderer/**` 正在被另一个会话修改（当前 `src/renderer/src/vrm/foot-lock.ts` 有未提交改动）。
本轮**不改 renderer**。提示改为纯主进程：一次性原生对话框 + 系统通知 + main.log +
`bridge-error.json`/`install.json` 证据；设置页 banner 列为后续项（等模型侧收口后）。
同时必须提供 `PET_DSH_COUPLING_SILENT_ALERTS=1`（测试/E2E 静默，避免模态框卡住自动化）。

### E9 安装脚本加固不足（直接关系"DSH 能不能打开"）

`scripts/activate-dsh-bridge.mjs` 现状：PyYAML 缺失时 `validateYaml()` 降级为
"有 `- ` 行就算过"的结构检查 → 仍可能写入让下次启动直接失败的 YAML；无定向
`--replace/--remove`（只能整份备份回滚）；live 副本丢 `engines.dsh` 且 `name` 每 rev 变化
（版本豁免键不稳定）；不预检 DSH 版本与桥范围；不写安装清单；激活后不验证。
修正见计划 §5。

### E10 "桥绝不产生异步孤儿抛错"没有落实为显式约束与测试

豆包自己实测"timer 里 throw 会 fatal 宿主"，但计划只写"apply 外包 try/catch + 所有 promise
`.catch`"，没覆盖 `setInterval` 回调、事件 handler、spawn 异步 error 的边界断言。
修正：`apply` 外层兜底（失败写诊断 + 返回 no-op disposer，绝不 throw 给宿主）+ 心跳/事件
路径逐层 try/catch + 单测用"投毒 ctx / 不可写目录 / spawn 失败"断言不抛、不产生
unhandledRejection；并在桥 README 写入"禁止异步孤儿抛错"的维护规则。

### E11 缺"桌宠自己打不开/行为失控"时也能保住 DSH 的逃生阀

计划只提"关掉 `dshCoupling` 就不杀 DSH"，但开关在设置页里，桌宠打不开时够不到。
修正：增加**文件级安全模式** `~/.dsh/aventurine-pet/safe-mode`（存在即等价于关闭耦合：
不拉起、不重启、不杀 DSH、不跟随退出），与既有 `PET_DSH_COUPLING_DISABLE=1` / config 开关
并列，写进 runbook。任何一条都必须是"打开 DSH 修桌宠"时的第一道保护。

### E12 "桥被禁用 → DSH 启动不再拉起桌宠"没有明确处理

"DSH 启动→桌宠启动"是桥 `launchPet` 实现的；桥被闸门禁用时这条链路必然断。
本轮接受为降级期已知限制（手动打开桌宠即可，且桌宠手动启动后会走自己的握手/降级逻辑），
在 `DEGRADED` 文案与 runbook 里写清楚；不引入 LaunchAgent 等新常驻组件（额外风险大于收益）。

### E13 canary 验收缺口

现有 `pnpm dsh:canary` 用 `dsh plugin --profile <tmp> add -w <bridge>`（bundle 安装形态），
**不是**真实 deployment 形态（绝对路径 insert + live 副本）。豆包实测是手工脚本，没有沉淀。
修正：新增 `--compat` 组，覆盖 ① bundle 安装被拒（兼容性报错）；② 绝对路径 insert +
不兼容 `engines.dsh` → 宿主仍启动、stderr 有 disable 行、桥零产物；③ 绝对路径 insert +
兼容 `engines.dsh` → 桥正常 attached 且带 compat；④ import 抛错；⑤ apply 抛错。
另加安装脚本的 YAML/`--replace` 纯函数单测。

### E14 恢复/回滚路径会误伤自定义 patch（固定端口行）

DSH 桌面版"启动失败"对话框的「禁用第三方插件、备份 profile patch 并重启」会把整份
`cordis.patch.yml` 改名备份、bundles 还原成官方模板（`lib/main.js:5517-5532`）——
webserver 固定端口 38765 等自定义行会一起失效。计划没给"定向移除桥行"的恢复路径。
修正：runbook 首选 `activate-dsh-bridge.mjs --remove`（只删桥 insert 块、保留其它 patch），
或在确实用了恢复对话框后，从 `cordis.patch.yml.bak-<ts>` 里挑回端口行。另：若 DSH 打不开，
桌面版会在 `~/Library/Logs/DeepSeek Harness/crash-*.log` 落诊断报告，runbook 要教用户看它。

### E15 `PAIRED` 后期桥长期丢失没有降级出口

若 DSH 活着但桥被 HMR 卸载后永不回来（或桥被禁用），当前语义是"保持 PAIRED 等 attached"
（`onGraceExpired`）→ 桌宠会一直以为已联动，退出时仍会杀 DSH。修正：心跳/桥状态
健康度丢失超过宽限期（建议 30s）→ `DEGRADED`（此后不杀 DSH），允许握手恢复后自动回 `PAIRED`。

### E16 崩溃恢复失败仍会 cascade 自杀，没有给"打开 DSH 修桌宠"留活口

当前 PAIRED 下 DSH 崩溃 → 重启 ≤2 次 → 仍失败 `cascade('dsh-gone')` → 桌宠退出。
如果崩溃根因是"DSH 版本更新后 profile/patch 需要手工修"，这恰好把桌宠也关掉。
修正：重启上限用尽 → `DEGRADED` 常驻（不再重启、不杀 DSH、提示原因）；用户修好 DSH 后
桌宠握手恢复 → `PAIRED`。**显式退出（detached→dsh-exit）语义保持原样。**

## 3. 结论

- 豆包文档 §1 的实验证据、§4 的方向、§5 的落点顺序可复用；
- 其"DSH 侧已有闸门兜底、桌宠只需提示"的隐含前提**在真实安装形态下不成立**，这是最需要修正的；
- 实施必须同时改三处：**桥（v4 compat + 防孤儿抛错）**、**安装/激活（engines 进 live 副本 +
  安装清单 + 严格 YAML + 定向回滚）**、**桌宠（握手门槛 + `UNPAIRED`/`DEGRADED` +
  新鲜度 + legacy 兼容 + 安全模式 + 提示）**，并按计划 §6 验收。
