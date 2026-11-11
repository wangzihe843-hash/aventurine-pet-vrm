# 桌宠 × DSH 强耦合的兼容性安全调查（2026-11-11）

> 范围：只调查、不改代码。结论基于 DSH 0.2.2-rc.1 shipped build + 本仓库当前实现 + 隔离 DSH_HOME 实测。

## 0. 结论（TL;DR）

1. **你担心的"DSH 版本更新 → 桌宠不兼容 → 两个都起不来"在 DSH 侧基本不会发生。** DSH 对"可选插件"有明确的失败隔离策略，版本不匹配时只是**禁用那一行并继续启动**；实测三种故障（版本不匹配 / 模块 import 抛错 / apply 抛错）DSH 都能正常起来。
2. **真正不保险的是桌宠侧的联动策略，而不是 DSH 本体。** 现在桌宠只按"DSH 进程在不在"判定联动：桥没装/被禁用也照样进 `PAIRED`；已联动后 DSH 起不来 → 桌宠重启 2 次后**自杀**；桌宠退出 → **SIGTERM/SIGKILL 掉 DSH**。所以"版本不兼容"本身不会让 DSH 起不来（也就不会直接触发自杀），但一旦因为别的兼容问题（例如 patch 写坏）DSH 起不来，桌宠会连坐；而且桌宠被关/更新时会把 DSH 一起杀掉。
3. **"不兼容就跳提示"目前做不到，不是因为 DSH 不给，而是因为桌宠侧没有兼容判定，也没有提示通道。** 桌宠只知道 `control.json.bridgeVersion`（且只解析、不校验），完全不知道 DSH 版本；DSH 的禁用提示只写 stderr，桌面版正常启动时看不到。
4. **可行方案**：把联动从"进程同生共死"升级为"**能力握手后才联动**"——桥/桌宠各声明兼容契约，任一项不满足就进入 `DEGRADED`：弹一次提示、停止联动动作、**绝不杀 DSH、绝不因 DSH 退出而自杀**，DSH 本体照常打开。改动集中在桌宠 1 个状态机 + 桥 1 个字段，DSH 侧不用改。
5. **当前真实状态的一个意外发现**：`~/.dsh/profiles/desktop/cordis.patch.yml` 里**没有桥插件行**（整个 `~/.dsh` 都搜不到 `aventurine-bridge`）。也就是说"同生共死"现在是**桥未安装但默认开启**（打包版 `dshCoupling: true`）：桌宠仍会按进程存在进入联动，并在自己退出时杀掉 DSH。

## 1. 实测证据（隔离 DSH_HOME，未触碰真实 `~/.dsh`）

实验方式：临时 `DSH_HOME` + `dsh --profile <p> --from-default-profile headless` 初始化，把桥包复制一份并改 `engines.dsh`，用原始 `insert` 行（绝对路径）挂进 profile patch，然后用"模型指向已关闭端口"的方式跑一个必然失败的回合——只要能跑到 `TRANSPORT failed`，就证明宿主已经完成启动。

| 场景 | DSH 行为 | 实测结果 |
|---|---|---|
| 桥 `engines.dsh` 改成 `>=0.3.0 <0.4.0`（不兼容） | 该行被禁用，stderr 输出 `dsh: disabling profile plugin row ...`，宿主继续启动 | 宿主正常跑完回合；桥产物目录（status/control/events）**为空** |
| 桥模块顶层 `throw` | `dsh: warning: 1 entry did not activate`，宿主继续启动 | 宿主正常跑完回合；桥零产物 |
| 同步 `apply()` 抛错 | 同上，entry 未激活 | 宿主正常跑完回合；桥零产物 |
| 插件里 `setTimeout(() => { throw ... })`（脱离 apply 的异步抛错） | `dsh: fatal uncaught exception`，**宿主直接退出** | 这是唯一实测能打死 DSH 的插件行为 |
| profile patch YAML 写坏（多追加一个 list 到 `[]` 后面） | `dsh: failed to parse overlay ...`，**启动直接失败** | DSH 完全起不来（不是版本问题，是 patch 写入问题） |

配套证据：
- 版本闸门发生在 profile 组合阶段，`manifestOf` 会从入口文件**向上找 `package.json`**（`dsh-app-boot/lib/index.js:3047`），所以"绝对路径插进 patch"同样受 `engines.dsh` 约束；拒绝逻辑在 `preflight` 里 `row.disabled = true` + `report(...)`（`:3091-3172`）。
- 失败策略（可选 entry 失败只 warn、必需 entry 失败 abort、异步孤儿抛错 fatal）见 `dsh-app-boot/README.zh.md` 的「启动失败策略」表。
- 桌面版对"宿主起不来"有兜底：`lib/main.js:15920-16000` 弹「DeepSeek Harness 无法使用」对话框，按钮含「**禁用第三方插件、备份 profile patch 并重启**」。但该按钮走 `sanitizeProfile(profile, WEB_PROFILE.bundles)`（`lib/main.js:5555-5580`）：**把整个 `cordis.patch.yml` 改名备份、bundles 还原成官方 web 模板**——端口固定等自定义行也会一起失效。

复现目录（本轮实验留下的临时证据，可删）：
- `/tmp/pet-compat-probe.JCy4M8`（A/B：不兼容 vs 兼容）
- `/tmp/pet-fail-probe.A0mQxx`（import / apply 抛错）
- `/tmp/pet-fatal-probe.UBjPY0`（timer 抛错 fatal）

## 2. 当前耦合链到底怎么长的

### DSH → 桥
- 桥是 host-only bundle：`bridge/dsh-aventurine-bridge`，`engines.dsh: ">=0.2.2-rc.1 <0.3.0"`，`cordis.patch.yml` 里以 `insert` 行注册。
- 桥做三件事：订阅 `session/event` 写 `events.jsonl`、写 `status.json` 心跳、写 `control.json`（`attached`/`detached` + `bridgeVersion: 3`）。
- 桥的所有事件处理都有 try/catch，定时器 `unref`，`spawn` 错误被消费——这部分已经接近"不会伤到宿主"。

### 桥 → 桌宠
- 桌宠的 `DshWatch` 读 status/control/events；`control.json` 的 `schemaVersion` / `bridgeVersion` 只在 `bridge-schema.ts` 里做**类型校验**，没有版本比较，也没有"不兼容"状态。

### 桌宠自己的状态机（真正的不保险点）
`src/main/desktop/dsh-lifecycle.ts`：

| 行为 | 位置 | 后果 |
|---|---|---|
| `STARTING` 探测到 DSH 进程就 `enterPaired('startup-detected')` | `:527-530` | **不需要桥健康**；桥被版本闸门禁用时，桌宠仍认为"已联动" |
| `PAIRED` 下 DSH 进程消失 → 重启 ≤ 2 次 → 仍失败 `cascade()` | `:440-500`、`:386-402` | **已经联动之后**，DSH 因任何原因起不来，桌宠都会自杀（`STARTING` 阶段则只是限流重试、不退出） |
| `STARTING` 拉起限流 60s 冷却 + 3 次/90s | `:410-438` | DSH 持续启动失败时，桌宠会停在"一直尝试"而不是报错 |
| 桌宠退出 → `terminateDshForQuit()`（SIGTERM→SIGKILL，≤5s） | `:694-730` | **桌宠被关/更新 → DSH 被一起杀** |
| 关掉 `dshCoupling` 只停动作、不杀 DSH | `:569-605` | 这是目前唯一的安全阀 |

配置默认：`src/shared/config.ts:46-47` `dshCoupling: true` / `dshBubbleSync: true`。

## 3. 为什么"版本不兼容就提示"现在做不到

1. **没有兼容判定方**：桥没有稳定的公开 API 获取 DSH 版本（只能依赖宿主内部实现，不建议）；桌宠不知道 DSH 版本（没有任何读取 Info.plist / bundle 版本的代码），两边唯一的版本信号是 `bridgeVersion: 3`，且没被使用。
2. **DSH 的提示不可见**：版本不匹配只写 stderr；桌面版只有在宿主**异常退出**时才把 stderr 尾巴塞进"无法使用"对话框。正常启动时用户什么也看不到。
3. **唯一可见的 UI 路径是插件管理器**：只有把桥装成正规 bundle（`dsh plugin add`）才会有安装期版本检查 + 明确的 incompatible 对话框 + `allow-version` 例外流程；但**升级后的下次启动**仍然只是静默禁用该行。
4. **桌宠把"桥缺失"当正常**：`tickStarting` 只看进程，导致"桥被禁用"和"桥正常工作"在桌宠眼里没区别。

## 4. 方案对比

### 方案 A（推荐）：兼容握手 + `DEGRADED` 降级态
把"同生共死"的触发条件从"进程存在"改成"**兼容握手成功**"。

- **桥侧**（~0.5 天）：`control.json` / `status.json` 增加 `compat` 块：`{ bridgeSchema, bridgeVersion, dshRange }`（DSH 版本不用桥提供）；`apply` 外层加能力探测（`typeof ctx.on === 'function'`、必要事件名存在），失败只写诊断文件并返回 no-op disposer，**绝不 throw 到宿主**；所有异步路径强制 `catch`。
- **桌宠侧**（~1-1.5 天）：
  - 读 DSH 版本：从 `/Applications/DeepSeek Harness.app/Contents/Info.plist` 的 `CFBundleShortVersionString`（实测 `0.2.2-rc.1`），app 路径可配置、可用 `lsappinfo` 兜底；
  - 读桥的 `compat`，与桌宠内置的支持范围比较（范围由桥 `engines.dsh` 生成，附一致性测试防漂移）；
  - 新增 `DEGRADED`：任一项不满足 → ① 首次 `dialog.showMessageBox` + 托盘通知 + 设置页持久 banner（文案「DeepSeek Harness 0.3.x 与当前桌宠联动插件不兼容，联动已暂停」）；② 停止一切联动动作：**不杀 DSH、不因 DSH 退出而 cascade**；③ 仍允许 `open -b` 打开 DSH（满足"本体照常打开"）；
  - 只有"兼容 + 桥 attached"才进 `PAIRED`；只看到进程 → 新状态 `UNPAIRED`（不联动、不杀）。
- **DSH 侧**：不改。已有版本闸门 + 失败隔离就是"内置插件"的行为。

### 方案 B（与 A 组合）：桥改为正规 bundle 安装
- 用 `dsh plugin --profile desktop add -w <repo>/bridge/dsh-aventurine-bridge` 替代裸 patch 行。
- 收益：安装期就有版本检查 + 明确 UI + `allow-version` 例外；不兼容组合包整层跳过、宿主照常启动（`skippedBundles` 只写 stderr）。
- 代价：升级后的启动仍然是静默禁用，所以**仍然需要 A 的桌宠提示**；另外 bundle 安装会引入 pnpm 依赖面。

### 方案 C（不推荐）：把桌宠做成 DSH 进程内插件
- 技术上可做（插件已经能 `spawn` 桌宠；进一步甚至可能拿 Electron API 开窗），但桌宠是独立 three.js/VRM 渲染 + 独立 preload，塞进宿主进程会把渲染崩溃、GPU、内存压力直接带进 DSH，和"保证本体能开"的目标相反。保持独立进程、用契约隔离才是对的方向。

### 对比

| 维度 | 现状 | A | A+B | C |
|---|---|---|---|---|
| 版本不兼容时 DSH 能否打开 | 能（实测） | 能 | 能 | 能 |
| 用户能否看到提示 | 不能 | 能 | 能（安装期更完整） | 取决于实现 |
| 桌宠会不会因 DSH 起不来而自杀 | 会 | 不会 | 不会 | 不适用 |
| 桌宠退出会不会杀 DSH | 会 | 兼容时才杀 | 兼容时才杀 | 不适用 |
| 改动面 | — | 桌宠状态机 + 桥字段 | +安装方式 | 大 |
| 风险 | 静默降级/连坐 | 低 | 低 | 高（拖垮宿主） |

## 5. 落地清单（待你确认后再动代码）

1. 定义契约文件（单一事实源）：桥 `package.json.engines.dsh` → 生成桌宠侧 `compat.json`（`dshRange` + `bridgeSchema` + `bridgeVersion`），加一条测试断言两处一致。
2. 桥：`control.json`/`status.json` 增 `compat`；`apply` 外包 try/catch + 能力探测；所有 promise `.catch`；保持零依赖、无模块级副作用。
3. 桌宠：新增 `DEGRADED` / `UNPAIRED`；`tickStarting` 不再仅凭进程进 `PAIRED`；退出与 cascade 路径加"兼容"前置条件；拉起失败连续 N 次后停止重试并提示。
4. 提示通道：首次 dialog + 托盘通知 + 设置页 banner（附"查看原因 / 打开 DSH / 暂停联动"按钮）。
5. 安装/升级脚本：写 `cordis.patch.yml` 前做 YAML 解析校验 + 备份；唯一 id；绝不进 required 列表。
6. 验证：扩 `pnpm dsh:canary` 三组断言（版本不匹配 / import 抛错 / apply 抛错 → 宿主仍启动、桥零产物）；桌宠 E2E 伪桥写 `compat.incompatible` → 断言进 `DEGRADED`、不杀 DSH、弹提示。

## 6. 需要你决策的点

- 提示形态：首次 modal dialog + 托盘通知 + 设置页 banner（推荐），还是只做托盘通知？
- 不兼容期间是否仍允许"桌宠退出时杀 DSH"？推荐：**不杀**（只有兼容且桥 attached 时才杀）。
- 是否把桥改成 bundle 安装（方案 B），还是继续裸 patch 行 + 桌宠侧判定（方案 A 单独）？
