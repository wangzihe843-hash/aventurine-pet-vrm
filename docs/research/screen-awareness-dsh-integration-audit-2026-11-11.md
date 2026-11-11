# DSH 0.2.2-rc.1 侧能力审计：桌宠「窥屏实时互动 + 隐私 + 聚焦」的 DSH 集成可行性

> 任务：`task-3`（T3 DSH harness 侧能力与窥屏方案集成审计）。执行者：`dsh-auditor`。日期：2026-11-11。
> 审计对象：本机安装的 DeepSeek Harness 桌面版 **0.2.2-rc.1**（`/Applications/DeepSeek Harness.app`；`app.asar` 213,240,777 B，22,105 个文件；bundle id `com.deepseek.dsh`；TeamIdentifier `NAN929V4UM`；硬化运行时；签名时间 2026-11-04）。
> 关联输入文档（本文不重复其已证明内容，只补 DSH 侧问题）：
> - `docs/research/screen-awareness-privacy-focus-feasibility-2026-11-11.md`（豆包方案，下文简称「豆包报告」）
> - `docs/research/dsh-harness-audit-2026-11-11.md`（前置 DSH 源码审计，下文简称「前置审计」）
> 边界：**只读**安装包解包副本与真实 `~/.dsh`（只读）；未重启/杀死正在运行的 DSH（本会话即运行其中）；未安装/卸载任何插件到真实 desktop profile；未写 `~/.dsh`；未改 `/Applications`；唯一写入是本文件。
> 解包副本新鲜度已核对：`/tmp/dsh-asar-audit/extract` 与当前安装 asar 抽样 6 个文件（含 838KB `lib/main.js`、`dsh-llm`、`dsh-official-bundles`、`dsh-desktop-host`、`dsh-session` 类型表）**SHA-256 逐一相等**，版本 `0.2.2-rc.1` 一致。下文 `asar/...` 指`/tmp/dsh-asar-audit/extract/...`（= `app.asar` 内路径，字节相同）。

---

## 0. 结论速查（TL;DR）

| # | 问题 | 结论 | 关键证据 |
|---|---|---|---|
| 1 | 安装态 DSH 有没有 desktop control / 屏幕截图 / 屏幕理解 / accessibility 能力？ | **没有**。asar 内 330 个 `@deepseek-ai/*` 包中无 camera/screen/cua/vision 类包；全 asar 检索不到 `desktopCapturer` / `CGWindowListCreateImage` / `SCScreenshotManager` / `AXUIElement` / `AXIsProcessTrusted` 等采集或辅助功能 API；唯一命中的 TCC 查询是**麦克风**（语音输入插件需要），不是屏幕。唯一原生 addon 是 POSIX flock，不是媒体采集。 | §2.1；`asar/lib/main.js:13551`（`getMediaAccessStatus("microphone")`） |
| 2 | 官方/可选 bundle 里有没有？ | **有一个，但是 on-demand、未安装**：`@deepseek-ai/dsh-cua-bundle`（Computer Use，官方 on-demand 目录第 3 项，darwin-only、Experimental）。元数据明说：为 PTC 会话加载计算机使用能力，需用户授予 **辅助功能（Accessibility）+ 屏幕录制（Screen Recording）** 权限。本机真实 desktop profile 的 bundle 列表不含它，asar/pnpm store 里也没有它的代码 → 本机**不可用**（要联网安装才可能出现）。 | §2.2；`asar/dsh/node_modules/@deepseek-ai/dsh-official-bundles/lib/index.js:54,114,126,199-236`；真实 profile `profiles/desktop/package.json` |
| 3 | 若有，权限记给谁、数据形态、能否被第三方消费？ | 按官方元数据与 `cuaAccess` API 反推：权限请求走「provider-owned native provider」，TCC 授权对象是 **DSH app（或其 helper）**，不是桌宠；数据形态是 CUA 模型可见的截图/应用信息（格式需装后实测）；**第三方插件/外部进程无法消费**——CUA 能力只对 PTC 会话的模型工具暴露，`cuaAccess` 是给浏览器控制 CUA 自己权限页的 Remote API，不是采集 API。 | §2.3/§2.4；`dsh-tool-cordis/lib/types/api-catalog.js:890-949`（`cuaAccess`） |
| 4 | DSH 模型层支持图片输入吗？插件能调模型并带图吗？ | **支持，且插件可调**：base 组合挂载 `dsh-llm` + `dsh-llm-deepseek`（API-key/account 两条 route）+ `dsh-llm-pi-ai`（多 provider/网关）+ `dsh-attachment-local`；图片是 **durable attachment / ImageBlock**，`deepseek-flash` 声明为 image-capable（`deepseek-v4-pro` 是 text-only）。插件 `inject:['llm','attachments']` 后可 `ctx.llm.stream()` + `ctx.attachments.saveImage()` 带图调用；官方 compaction 插件就是范例。限制：**附件永不自动删除**（落 `$DSH_HOME`）、无逐次审批、费用走用户 DSH 账户、图片仅输入不支持模型输出图。 | §3；`dsh-base/cordis.patch.yml:35,136,146-147,532,535`；`dsh-llm-deepseek/README.md:48-53,177,209`；`dsh-attachment/README.md:119` |
| 5 | 桌宠 P3「截图→VLM」该复用 DSH 模型层吗？ | **默认不推荐**。推荐 P3 = 桌宠自建 native helper 采集（自有 TCC）+ 桌宠侧 VLM provider 客户端（内存态、不落盘）。「DSH 代跑 VLM」只能作为可选实验（Phase-2 后评估），因为 DSH 侧有四个硬障碍：截图源在 DSH 侧不存在（CUA 未装/不可消费）、附件永久落盘违反隐私不变量、模型调用无逐次用户审批、成本记到用户 DSH 配额。 | §4/§5 |
| 6 | 桥插件契约能扩展「专注状态 / 屏幕观察元数据」吗？ | **能，但大多数方向没价值**：DSH 不知道「专注状态」和「屏幕观察」，这两个状态天然属于桌宠侧；桥是 **DSH→桌宠单向**（status/control/events 全由桥写），没有 pet→DSH 通道。若确要让 DSH 知道桌宠专注态，需新增 `pet-state.json` 轮询通道（加法式、不破坏 v3/v4 compat，但要桥改代码+契约+parity+canary）。屏幕内容（截图/OCR）**不要**走桥：64KB 行上限、5MB 轮转、明文落盘、且桥无法回传图像。 | §6 |
| 7 | 能否复用 DSH 的 permission/approval 做「透明面板/可撤销」？ | **不能直接复用**，只有设计参考价值：`dsh-user-approval` 只有 `ask`/`never` 两种 policy、只有一次性 grants（**无 allow-always、无撤销、无 grant store**）、pending 是进程内、`approval/asked`/`decided` 只是 log-only 事件；审批 UI 是 DSH 自己的浏览器客户端插件，外部进程无 API 注入。最接近「按 app 允许/拒绝 + 可撤销」的官方先例是 CUA 的 `cuaAccess`（applications/revoke/retryApproval/session scope），但同样不对外提供通用服务。 | §7；`dsh-user-approval/README.md:12,165,168`；`dsh-client-ui-approval/README.md:23` |
| 8 | 对豆包报告 §4.7 / §6 的 DSH 相关修正 | 8 条（见 §8）：核心是 **DSH 侧不需要新增任何采集组件，唯一可能的改动是桥事件契约（加法式，5 个文件 + canary）；TCC 必须留在桌宠自己的 helper，不要借 DSH 的 TCC；不要把 DSH 当作 P3 的截图/OCR/VLM 后端**。 | §8 |
| 9 | 本机真实 DSH 现状（只读观察，供 lead 判断另一会话） | 模型当前 `deepseek-account / deepseek-flash / reasoningEffort=max`（profile patch 的 `agent-default-model` row）；`$DSH_HOME/llm-deepseek/files-v3.json` mtime 16:25（活跃写，疑似另一会话的模型/图片相关操作）；桥**正在运行**（status 心跳 16:33），但跑的是 **v3 legacy live 副本**（`work/live-bridge/rev-1794371618691`），仓库源码已是 **v4**（未激活）——审计期间未做任何改动。 | §9 |

---

## 1. 审计方法与版本核对

### 1.1 版本/新鲜度核对（先排除「读的是旧包」）

| 项 | 值 | 方法 |
|---|---|---|
| 安装包 | `/Applications/DeepSeek Harness.app`，0.2.2-rc.1，asar 213,240,777 B（mtime 2026-11-04 17:16） | `ls -la`、`PlistBuddy` |
| 解包副本 | `/tmp/dsh-asar-audit/extract`（前置审计产物，mtime 2026-11-11 01:56） | 直接读 |
| 身份 | `com.deepseek.dsh`；TeamIdentifier `NAN929V4UM`；hardened runtime；签名 2026-11-04 | `codesign -dv`、`PlistBuddy` |
| 一致性 | 抽样 6 文件 SHA-256 与安装 asar 逐一相等（`dsh/node_modules/@deepseek-ai/dsh-llm/lib/index.js`、`dsh-official-bundles/lib/index.js`、`dsh-desktop-host/lib/index.js`、`dsh-session/lib/types/known-event-types.js`、根 `package.json`、`lib/main.js` 838KB） | 自写 `/tmp/dsh-verify/verify.mjs` 按 asar 头 offset 读取后与解包文件 hash 比对 |
| 包数量 | `asar/dsh/node_modules/@deepseek-ai` = **330** 个 | `ls | wc -l` |

> 结论：`/tmp/dsh-asar-audit/extract` 就是当前这台机器安装的 0.2.2-rc.1，可作源码证据；与前置审计读到的包数量（其记 332）差异不影响结论（同一版本内计数口径差异，不影响「无 CUA 包」的判定，因为按名字逐个核对）。

### 1.2 实验边界

- 真实 `~/.dsh -> /Volumes/4TB外置盘/dsh-appdata`：**只读**浏览了 `profiles/desktop/`、`storages/`、`aventurine-pet/`、`llm-deepseek/`，用于（a）确认桥正在运行、（b）确认本机实际可用模型、（c）发现另一会话活跃写。
- 没有在真实 profile 安装/启用/禁用任何插件，没有触发 HMR 重配置，没有 `open -a`，没有写 `~/.dsh`。
- 没有跑桌宠项目的 build/test/package；没有 `git add/commit/stash/reset/clean/checkout`；没有触另一会话活跃文件（`tests/tmp/lead-proportion-v3/**`、`scripts/unity-bake/**`、`assets/**`、`docs/research/proportion-*`）。
- 没有做「安装 `dsh-cua-bundle` 到临时 profile」的实验：它是 on-demand 网络包（本地 store 无副本），安装会引入网络与 TCC 副作用，已经超出本任务 40 分钟预算；因此 **CUA 的数据形态/采集 API 细节标记为 unverified**，§11 给了验证方法。

---

## 2. 问题 1：DSH 0.2.2-rc.1 现成能力盘点（desktop control / 截图 / 屏幕理解 / accessibility）

### 2.1 安装态：**没有**任何屏幕采集 / 屏幕理解 / 辅助功能能力（确认级证据）

检索范围：`/tmp/dsh-asar-audit/extract` 下全部 JS/MJS/JSON/YML/MD（`dsh/` 的 330 个包 + Electron shell `lib/main.js` + `renderer/`）。

| 检索目标 | 结果 |
|---|---|
| `desktopCapturer` / `getUserMedia`(screen) / `systemPreferences.getMediaAccessStatus('screen')` | **0 命中**（唯一 `getMediaAccessStatus` 命中在 `lib/main.js:13551`，参数是 `"microphone"`，属语音输入插件的麦克风权限检查） |
| `CGWindowListCreateImage` / `CGDisplayCreateImage` / `SCShareableContent` / `SCScreenshotManager` / `screencapture` | **0 命中** |
| `AXUIElement` / `AXIsProcessTrusted` / `CGEvent` / `NSEvent`（辅助功能/输入注入） | **0 命中** |
| 包名含 `cua`/`screen`/`screenshot`/`capture`/`vision`/`computer` 的 `@deepseek-ai/*` | **0 个** |
| 任何屏幕相关原生 addon | **没有**；唯一原生包 `@deepseek-ai/node-addon-system-darwin-arm64` 的 description 是 "Prebuilt POSIX flock Node-API binding for macOS arm64"（进程锁，不是采集） |
| Electron shell 的权限相关代码 | 只有麦克风授权检查（同上）；`Info.plist` entitlements 由安装包决定，本会话不允许改/深挖签名 entitlement（属只读边界外，但即使有 entitlement 也无采集调用点） |

**结论（confirmed）**：安装版 0.2.2-rc.1 **不包含**桌面截图、屏幕录制、窗口内容读取、OCR、辅助功能（AX）自动化能力。DSH 的「感知世界」只有：workspace 文件、终端、网络（web_search/fetch）、以及用户主动附加的图片/文件。桌宠若想「看屏幕」，DSH 目前**给不了**。

### 2.2 唯一存在的官方能力：on-demand `dsh-cua-bundle`（Computer Use）

`asar/dsh/node_modules/@deepseek-ai/dsh-official-bundles/lib/index.js` 是官方 bundle 清单的单一事实源：

```js
// :54  ON_DEMAND_BUNDLES —— 公开 DSH 发布成员，走普通按需安装器
const ON_DEMAND_BUNDLES = [
  "@deepseek-ai/dsh-subagent-claude-code",
  "@deepseek-ai/dsh-subagent-codex",
  "@deepseek-ai/dsh-cua-bundle"
];
// :114 MORE_BUNDLES（插件管理「更多」列表）；:126 EXPERIMENTAL_BUNDLES（打 Experimental 标）
// :199 OFFICIAL_ON_DEMAND_CATALOG 中的条目：
{
  packageName: "@deepseek-ai/dsh-cua-bundle",
  platforms: ["darwin"],          // 仅 macOS（Windows 开发中）
  listedByDefault: false,
  meta: { title: { en: "Computer use", zh: "Computer Use", ... },
    description: { en: "Currently supports macOS; Windows support is in development.
      Loads computer use for existing and new PTC sessions. Switch to PTC mode
      and grant Accessibility and Screen Recording permissions to use it.", ... } }
}
```

要点（confirmed，来自官方元数据）：

1. **不是安装态**：它属于 `ON_DEMAND_BUNDLES`，即「安装包不携带、用户按需从 registry 安装」；本机 asar 内没有它的包，真实 desktop profile 的 `dsh.profile.bundles` 也没有它，pnpm store 里也没有副本（§9.1）。要靠插件管理页/`dsh plugin ... add` **联网安装**才可用（`dsh-plugin-manager` 的 `installBundle` 走 npm registry + fallbacks，`lib/index.js:1079,2712`）。
2. **macOS only**（`platforms: ["darwin"]`），Experimental。
3. **能力语义是「计算机使用」而不是「屏幕观察 API」**：描述明确是给 **PTC（programmatic tool calling）会话**加载 computer use，需要 **辅助功能 + 屏幕录制** 两项系统权限，并且要切到 PTC 模式。这意味着它的截图是**喂给模型的输入**（模型看到屏幕、点击/输入），不是给第三方插件/外部进程调用的采集服务。
4. **权限归属**：元数据说「grant Accessibility and Screen Recording permissions」——这类权限由**发起请求的进程**获得。CUA 的权限请求经 `cuaAccess.requestPermission(permission, locale)` 的 **native provider** 发出（`dsh-tool-cordis/lib/types/api-catalog.js:890,925`），而 DSH 桌面 app 是签名 app `com.deepseek.dsh`（TeamIdentifier NAN929V4UM，hardened runtime），CUA 的 host 插件/native helper 由 DSH Host 子进程加载 → **TCC 记录在 DSH app（`com.deepseek.dsh`）或其 helper 的 bundle id 上，而不是桌宠的 `com.aventurine.pet`**。helper 若自带独立 Info.plist/bundle id，则可能单独出现在系统设置列表里（**这一点未安装实测，标 unverified**，验证方法见 §11）。
5. **对第三方可消费性**：**不可**。`cuaAccess` 暴露的方法是 `applications()/systemStatus()/requestPermission()/openSettings()/revoke()/retryApproval()/ptcConfiguration()/enablePersistentPtc()/applicationIcons()`——全是「浏览器控制 CUA 自己的权限页/应用授权」的 Remote API（`api-catalog.js:890-949`），没有一个「截一张图给我」的方法；CUA 的键盘/鼠标/截图是**模型工具**，只在 CUA 会话内被模型调用。外部进程（桌宠）既没有 DSH 的登录 token（Web API 也有 token/Origin 鉴权门槛，见前置审计 §6.4/§7），也没有宿主服务调用权。
6. **审批语义**：CUA 的应用授权走 DSH 的 approval UI，默认 Enter 只授予 **current session** 范围，持久化要显式点 Always allow（`dsh-client-ui-approval/README.md:23`）；这恰好是「按 app 授权」的先例，但它是 CUA 专属，没有通用 contribution API（§7）。

### 2.3 能力矩阵（DSH 侧，安装态 vs 可选）

| 能力 | 安装态 0.2.2-rc.1 | on-demand `dsh-cua-bundle`（未装） | 能否给桌宠用 |
|---|---|---|---|
| 桌面截图（整屏/单窗口） | ❌ 无代码 | ✅（模型工具，PTC 会话） | ❌（无 API；且 TCC 归 DSH） |
| 屏幕理解 / VLM 输入 | ⚠️ 模型层支持图片输入，但**没有采集源** | ✅（截图喂模型） | 模型层可复用，采集源不可复用 |
| 窗口枚举/标题/几何 | ❌ | 可能（CUA 应用列表 `applications()` 是「已授权应用决策」，不是任意窗口枚举） | ❌ |
| 辅助功能自动化（AX/点击/输入） | ❌ | ✅ | ❌ |
| OCR / 本地文本识别 | ❌ | 未知（unverified；DSH 全 asar 无 OCR 引擎） | ❌ |
| 麦克风占用布尔 | ✅ Electron `getMediaAccessStatus("microphone")`（语音输入用） | — | 仅概念参考，桌宠自己也能查 |
| 图片输入 / 视觉模型 | ✅（§3） | ✅ | ✅ 经插件 API 可复用（有隐私代价） |
| 自定义 HTTP/WS 路由 | ✅ 插件 `inject:['webServer']` 可注册 loopback 路由（前置审计 §7） | — | 可作桌宠↔DSH 低延迟通道（可选） |
| 应用级 permission/approval | ✅ 但仅 DSH 工具调用，一次性 | ✅ CUA 应用授权（scope=session/always） | 仅设计参考 |

### 2.4 结论

- **不存在**「DSH 提供 screenshot/vision API 给第三方插件或外部进程消费」的现成能力（安装态无代码；on-demand CUA 也不暴露采集 API，且权限在 DSH 名下）。
- DSH 当前能给桌宠的、与「感知」有关的可用接口只有两类：**(a) 模型层图片输入**（§3，需插件调用、有落盘/费用/无审批代价）；**(b) 事件/状态**（现有桥，§6）。屏幕采集必须由桌宠自己做。

---

## 3. 问题 3：模型 / 多模态（provider、vision、插件调模型 API、限制）

### 3.1 本机可读的 provider / 模型（只读，不泄露密钥）

| 事实 | 证据 |
|---|---|
| base 组合挂载模型栈：`dsh-llm`（服务）、`dsh-llm-retry`、`dsh-llm-pi-ai`（多 provider/OpenAI 兼容网关/自建 endpoint）、`dsh-llm-deepseek-api-key`、`dsh-llm-deepseek-account` | `dsh-base/cordis.patch.yml:35,100,136,532,535` |
| 图片相关：`dsh-attachment-local`（附件服务本地后端）、`dsh-compaction-image-offload`（图片超预算时替换为占位并重试）挂在 base | `dsh-base/cordis.patch.yml:146-147,434-435` |
| 本机真实选择：`provider: deepseek-account`，`model: deepseek-flash`，`reasoningEffort: max` | `$DSH_HOME/profiles/desktop/cordis.patch.yml` 的 `agent-default-model` row（只读；**未改动**） |
| `deepseek-flash` 在 adapter 默认目录里是 **text+image** 能力；`deepseek-v4-pro` 是 text-only；显式 `models` 会整表替换；官方 endpoint 的 API-key route 跟随服务端 listing | `dsh-llm-deepseek/README.md:48-53`；`dsh-llm/README.md`（listModels/listConfigurableProviders） |
| 另一条 route：account（已登录的 DSH grant）；pi-ai 适配器支持多 provider / 自建 gateway，图片预算可配（`requestImagePixelBudget`/`requestImageMaxBytes`/`maxRequestImageBytes`） | `dsh-llm-pi-ai/README.md`（Configure provider routes）；`dsh-llm-deepseek/README.md:218` |
| Files API 上传：`/v1/files`，请求带 `anthropic-beta: files-api-2025-04-14`；失败/超时回退 inline base64；per-image Files 解析 60s 超时 | `dsh-llm-deepseek/README.md:66,70,97` |

> 只读确认：当前会话实际运行的模型就是 `deepseek-flash`（image-capable），所以「DSH 能不能看图」在本机**是能**的；密钥永远不在 profile 配置里（`apiKeyEnv` 引用 + credential seam），我只看到引用名/无值（`cordis.patch.yml` 无任何 API key 字面量；`~/.dsh/.credentials.yaml` 未读内容）。

### 3.2 图片输入（vision）能力边界

| 维度 | 事实 | 证据 |
|---|---|---|
| 图片本质 | durable `ImageBlock` + `ImageAttachmentRef`；provider adapter 在请求时投影成 route 尺寸/字节目标的 request version | `dsh-llm/README.md:129,138`；`dsh-attachment/README.md:69,75` |
| 谁可以带图 | 用户消息、tool 结果（role-neutral）；**模型输出图片不支持**（assistant image output 是 forward compat，生产 adapter 只声明 text output） | `dsh-llm-deepseek/README.md:209`；`dsh-attachment/README.md:136` |
| 尺寸/预算 | adapter 按 14px patch/3:1 降采样、单图 ≤1024 visual token 计算目标；总计有 `maxRequestFilesBytes`(128MiB)/`maxImagesPerRequest`(600)/inline 20MiB；超限 → `IMAGE_OFFLOAD_REQUIRED` → image-offload 插件把最老图片替换为文本占位后**自动重试** | `dsh-llm-deepseek/README.md:48-53,64-71,177`；`dsh-compaction-image-offload/README.md` |
| 截图消费者钩子 | `ctx.llm.imageRequestTarget(provider, model, image)` 明确写着 "exposes the same request-image dimensions and byte target to **screenshot consumers**" —— 说明 DSH 内部（CUA）正是拿它做「截图→发给视觉模型」的尺寸计算 | `dsh-llm-deepseek/README.md:177`；`dsh-tool-cordis/lib/types/api-catalog.js`（llm service） |
| OCR | **没有**。全 asar 无 OCR 引擎/调用（只有图片压缩/归一化与 Files 上传） | §2.1 检索 + `dsh-attachment` 无 OCR |

### 3.3 插件能否调模型（具体 API）并带图？

**能**（host-only bundle，`inject` 后可访问 Cordis 服务）：

| API | 说明 | 证据 |
|---|---|---|
| `ctx.llm.stream(options)` | 唯一受支持的模型调用路径；异步产出 raw chunk，`BlockAssembler` 组装；永远以一个 terminal `finish` 结束（error/aborted 有稳定 code：`NO_ADAPTER/MISSING_CREDENTIAL/AUTH/RATE_LIMIT/CONTEXT_WINDOW_EXCEEDED/...`） | `dsh-llm/README.md`（Stream one model call / Failures）；`dsh-compaction-basic/lib/index.js:323`（`for await (const chunk of ctx.llm.stream(options))`） |
| `ctx.attachments.saveImage/saveImages` + `readImageRequest` + `imageLimits` | 保存图片为 durable attachment、按目标尺寸投影、读回；`imageHostPath/fileHostPath` 只对 trusted same-process consumers 暴露宿主路径 | `dsh-tool-cordis/lib/types/api-catalog.js` 的 `attachments` 服务；`dsh-attachment/README.md:75` |
| `inject` 声明 | 访问服务必须声明，如官方 compaction 引擎 `static inject = ["llm","tokenMeter","sessions"]`；否则 `ctx.get(...)` 为 undefined（前置审计 §3.3 已实测） | `dsh-compaction-basic/lib/index.js:801-805` |
| 辅助用途（purpose） | `GenerateOptions.purpose` 是 TS 类型增强（`LlmRequestPurposeMap`），运行时未做白名单校验（asar 内 `dsh-llm/lib/index.js` 无 purpose 校验字符串）；辅助调用可省略或自定义 | `dsh-llm/lib/typert.host.js:463-464`；`dsh-compaction-basic` 用 `purpose:"compaction"` |
| 图片消息形态 | `messages: [{ role:'user', content:[{type:'image', ...},{type:'text', text:'...'}] }]`（durable `ImageBlock`） | `dsh-llm/README.md:129,138`；`dsh-attachment/README.md:69` |

**可复用的现成范例**：`dsh-compaction-basic` 的 `summarizeWithLlm`（`lib/index.js:289-335`）就是「插件发一次辅助 LLM 请求」的完整实现（选 provider/model → 拼 messages → `ctx.llm.stream` → 组装 → 错误分类），桌宠桥若要走「DSH 代跑 VLM」，照它写即可。

### 3.4 限制（决定「DSH 代跑 VLM」是否可行）

| 限制 | 影响 | 证据 |
|---|---|---|
| **附件永不自动删除**：图片/文件存入 `$DSH_HOME` 后无限期保留（本地后端「currently retains everything」） | 违反豆包报告 §4.3 不变量 4「内存态、不落盘」——只要经过 DSH 附件层，截图就**持久化**了，且会话 resume/fork 后仍可复用 | `dsh-attachment/README.md:119,132` |
| 无逐次用户审批：approval 只用于**工具调用/权限**（bash 等），模型调用本身不弹审批；`cuaAccess.requestPermission` 是 CUA 的系统权限页，不是「每次发图前确认」 | 「首次/每次采集前显式确认」必须由桌宠自己做；DSH 不会替桌面宠问 | `dsh-user-approval/README.md`；`dsh-client-ui-approval/README.md` |
| 费用/配额记到用户 DSH 账户（deepseek-account route 用 stored grant；api-key route 用用户 key）；image token 按视觉计价 | 桌宠 P3 的调用会花用户 DSH 额度，与桌宠自己的预算/成本面板脱节；用户可能不希望宠物耗 agent 配额 | `dsh-llm-deepseek/README.md:177,218` |
| 超时/重试由 adapter 的 retry policy 决定（默认 5 次退避），Files 解析 60s 超时 | 宠物想要的「2–10s 内出结果、失败即沉默」与 DSH 的重试语义不一致（重试会放大延迟与费用） | `dsh-llm/README.md`（Failures/retry）；`dsh-llm-deepseek/README.md:70` |
| 模型可用性受 catalog/route 限制；explicit `models` 整表替换；text-only route 会给图片占位符 | 若用户切到 text-only 模型，图片会被替换为占位文本，VLM 静默失效 | `dsh-llm-deepseek/README.md:53,209` |
| 截图「源」不存在 | 桥插件拿不到屏幕（§2）；必须由桌宠截图后把字节送进 DSH（落盘附件），或由 CUA 会话内的模型工具截图（不可编程调用） | §2、§6 |

**结论**：DSH 模型层**技术上可以**当桌宠 P3 的 VLM 后端（一次辅助请求 + 图片附件），但代价是隐私（永久落盘）、计费（用户 DSH 账户）、审批（无）、数据通路（截图必须先进 DSH 附件目录）——**不建议作为默认架构**，最多作为「用户显式开启的实验选项」。

---

## 4. 问题 2：能否把 DSH 当「内容采集后端」？三方案对比

| 维度 | (a) 桌宠自建 native helper + 自有 TCC + 自有 VLM client（推荐） | (b) 借 DSH 采集/CUA（若未来安装 CUA） | (c) 不做内容级（P0/P1 only） |
|---|---|---|---|
| 可行性（今天） | ✅ 完全可行，豆包报告 §4.7 的 `native/screengrab` 设计成立 | ❌ 今天不可行：CUA 未安装、无采集 API、只对 PTC 模型工具暴露；装它需要联网 + 用户给 DSH 两项系统权限 | ✅ 已有 P0 元数据 + P1 氛围（若做） |
| 权限归属 | 桌宠 app（`com.aventurine.pet`）自己的「屏幕录制」TCC；用户可在系统设置里单独撤销桌宠的权限，DSH 不受影响 | TCC 记在 **DSH**（`com.deepseek.dsh`）名下；桌宠要「看屏幕」必须让用户先给 DSH 授权，撤销也会影响 DSH 的 computer-use（未来） | 无新增权限 |
| 数据形态/落点 | helper 内存 → stdout JSON → 主进程内存，**不落盘**（豆包报告 §4.3 不变量 4） | 截图进入 DSH session/attachments：`$DSH_HOME` 明文/附件永久保留（§3.4），且会进会话历史 | 名称/数值/4–8 个浮点 |
| 延迟 | 单窗口 SCK 截图 + Vision OCR：本地 50–150ms 级；VLM 网络 2–10s（桌宠自己控超时） | 需要：DSH 模型路由 + Files API 上传（60s 超时/回退）+ 模型推理；且桥文件轮询再 +750ms–5s；不可控 | ~0（已有 250ms 窗口轮询） |
| 隐私可控性 | 高：单窗口、fail-closed 规则、可回看、可删、可暂停；出口脱敏全在桌宠 | 低：DSH 会话/附件/日志多处留痕，DSH 侧无「按 app 拒绝」策略，无法一键清空附件（永不删除） | 最高 |
| 耦合/升级风险 | 低：只依赖 Apple API + 自己的 provider | 高：依赖未发布实验 bundle（engines/HMR/版本漂移）、DSH 附件格式、account 登录态、模型 catalog | 无 |
| 计费 | 桌宠自己的 provider/API key（用户可单独管） | 用户 DSH 账户/额度，与桌宠预算脱节 | 0 |
| 与现有代码 | 与豆包 §4.7 新增文件完全一致，不影响渲染/动画主干 | 需要改桥 + DSH 插件 + 可能改 DSH 侧凭据；侵入 cua bundle | 最小 |

**推荐**：**(a) 为主，DSH 只提供「状态/事件」元数据（现有桥，必要时加法式扩展）；(b) 明确不做；(c) 作为 P1 的隐私折中保留。**

补充：如果未来官方 CUA 稳定且暴露了**插件可调**的采集服务（目前没有），可以重新评估「借采集」；但即使那时，TCC 归属和附件落盘两个问题仍会让它不如自建 helper。

---

## 5. P3 推荐架构（截图 → VLM）

```
[前台窗口几何/标题(已有 native/winlist + CGWindowList)]         ← P0，零权限
        │
[隐私闸门 fail-closed] → [单窗口截图(自建 helper, 内存 JPEG)]     ← 新增 native/screengrab，TCC 归桌宠
        │
[dHash 变化检测 / 预算 / 兴趣]                                    ← 纯逻辑，shared
        │
[桌宠自有 VLM client(provider 可配, 内存态, 超时/退避/出口过滤)]    ← 新增，不经过 DSH
        │
[ExternalReaction 注入 + 气泡 + 记忆边界 source=screen]            ← 复用现有路径
```

- **不新增 DSH 侧组件**；DSH 仍是「状态/事件源」：`agent/status`、`task/*`、`assistant/message.text` 已经够桌宠做「专注中不打扰 / agent 完成时轻反应」。
- 若某天要复用 DSH 模型层（用户已登录 account、不想再配 key），把它做成**用户显式开启的实验选项**，且必须新写一个独立的 host-only 插件（`inject:['llm','attachments']`）或在桥里加一个 guarded 分支；**默认关闭**，并在开关处写清三个代价：图片落 `$DSH_HOME` 永久保留、费用走 DSH 账户、无逐次审批。技术上可参考 `compaction-basic` 的 `summarizeWithLlm` 写法。
- **不要**把截图塞进 `events.jsonl` / `status.json`：见 §6.4。

---

## 6. 问题 4：桥插件契约现状与扩展可行性

### 6.1 现有契约（三文件 + 两个新增诊断文件）

| 文件 | 写入方 | 形状（冻结） | 证据 |
|---|---|---|---|
| `~/.dsh/aventurine-pet/status.json` | 桥，5s 心跳（`BRIDGE_HEARTBEAT_MS=5000`），原子 tmp→rename，0600 | `{ ts, running, agents, lastEventAt, lastType, offline?, compat? }`；`online = !offline && now>=ts && now-ts<30s` | `src/shared/bridge-schema.ts:145-146,163-178`；`bridge/.../lib/index.js:814-844` |
| `events.jsonl` | 桥，追加 NDJSON；5MB 轮转；单行 >64KB 丢弃 | `DshEvent = { ts, type, payload }`；type 白名单 **5 种**：`agent/status`、`task/start`、`task/end`、`task/error`、`session/event`；payload 白名单 **11 个标量**：`agent/status/reason/reasonKind/turn/step/message/text/sessionId/eventType/seq`；`message ≤512`、`text ≤8000`、其余 ≤256 字符；未知键只透传 JSON 标量 | `bridge-schema.ts:148-152,155-161,218-246,283-324` |
| `control.json` | 桥，仅 apply→`attached` / dispose→`detached`（心跳不写） | `{ schemaVersion:1, ts, action, dshPid?, bridgeVersion?, compat? }`；`schemaVersion` 必须 ===1 否则整帧无效 | `bridge-schema.ts:40-41,124-140,430-456`；`bridge/.../lib/index.js:859-885` |
| `install.json` | 激活脚本（`scripts/activate-dsh-bridge.mjs`） | `{schemaVersion, installedAt, installMethod:'live-copy-insert'|'bundle', bridgeEntry, bridgePackageName, bridgePackageVersion, bridgeVersion, controlSchema, dshRange, dshVersionAtInstall?...}` | `bridge-schema.ts:478-585` |
| `bridge-error.json` | 桥 apply 失败时（v4） | `{schemaVersion, ts, phase, message ≤1024, bridgeVersion?, dshRange?}` | `bridge-schema.ts:587-650`；`bridge/.../lib/index.js:395-455` |

**运行时兼容自述（v4）**：`compat = { bridgeVersion, controlSchema, dshRange }`，`status`/`control` 每帧携带；`dshRange` 运行时读桥包 `package.json.engines.dsh`（`bridge/.../lib/index.js:333-362`），读不到 → `null` 且 v4 桌宠判 `incompatible/range-missing`；v3 legacy 桥无 compat → 桌宠回退 `BRIDGE_LEGACY_DSH_RANGE='>=0.2.2-rc.1 <0.3.0'`（`bridge-schema.ts:48-57`；`src/main/desktop/dsh-compat.ts:1-58,110`）。

**桥侧实现要点**（`bridge/dsh-aventurine-bridge/lib/index.js`，1190 行，当前仓库为 v4）：

| 行为 | 行号 |
|---|---|
| 订阅 5 个事件（global）：`agent/status`、`agent/created`、`agent/error`、`agent/disposed`、`session/event` | `:1095-1100` |
| `agent/status` → `task/start|end`（只认 idle/running） | `:932-954` |
| `agent/error` → `task/error`（与 `turn/end(error)` 按 agent+turn 去重，FIFO 上限 64） | `:973-992`；`:133-134,893-904` |
| `agent/disposed`：上一状态 running → 补 `task/end{reason:'disposed'}` | `:998-1016` |
| durable 事件只透传 `turn/end`、`assistant/message`、`tool/result`（`NOTABLE_SESSION_EVENTS`）；`assistant/message` 额外带 `text`（多 text 块 `\n` join、trim、≤8000；纯 tool-call/空文本不带） | `:142-143,205-230,1025-1052,1076-1091` |
| `turn/end(reason.kind==='error')` → `task/error` 而非 `session/event` | `:1054-1069` |
| 隐私：**不写** user/system 消息、reasoning、tool 参数/结果正文 | `:1018-1024` 注释与实现 |
| 启动预检（建目录+写探针，不可写则 fail-fast）、apply 绝不抛（失败写 `bridge-error.json` + no-op disposer） | `:1093-1095,1160-1190`；`:457-490,395-455` |
| `launchPet`（默认 false）：apply 时拉起桌宠 app 一次，可被 `AVENTURINE_BRIDGE_DISABLE_LAUNCH=1` 禁用 | `:656-730,1121-1123` |

**桌宠侧读取**（`src/main/desktop/dsh-watch.ts`，618 行）：**750ms 轮询**（`DSH_POLL_INTERVAL_MS=750`，`:56`）；启动时以 EOF 为基线避免重放历史（`:322-336`）；按 inode 检测轮转/截断（`:518`）；`control.json` 用 mtime+size 签名去重；所有解析失败静默降级、首次 warn（`:235-267`）；`status/control/event` 三路 listener 分发都有 try/catch。→ **元数据端到端延迟 ≈ 桥写盘时刻 + 0–750ms**；`text` 进 renderer 气泡（消费点：`src/renderer/src/reactions/dsh-dialogue.ts:12`「`session/event` + `eventType==='assistant/message'` + `payload.text` → 气泡」；前置审计 §6.1 已核）。

**契约版本/守护**：`BRIDGE_PLUGIN_VERSION=4`（`bridge-schema.ts:48`）与桥 `lib/constants.js` 由 parity 测试守护（`tests/bridge-plugin.test.ts:177-187` 读取 schema 常量；`:438-521` 校 package/patch/README/locale/icon）；v4 兼容性/安装形态 canary C1–C6 在 `scripts/dsh-canary.mjs`（`--compat`/`--only-compat`，含 C3 绝对路径 insert + compat 断言、C6 桥 apply 失败隔离 → `bridge-error.json`）。激活脚本 `scripts/activate-dsh-bridge.mjs` 生成 `work/live-bridge/<rev>/`（live 副本**必须带 `engines.dsh`**，否则 DSH 版本闸门失效）、写 `install.json`、激活后 ≤10s 轮询 control 核对 `attached/bridgeVersion`。

### 6.2 扩展「专注状态 / 屏幕观察元数据」事件：可行性与方向判断

| 候选扩展 | 方向 | 可行性 | 是否值得做 |
|---|---|---|---|
| 「专注状态」事件 | DSH→桌宠 | 低价值：专注是**桌宠自己的状态机**（豆包报告 §4.5 明确定位应用内），DSH 没有专注概念，不会产生该事件 | ❌ 不需要 |
| 「DSH 知道桌宠在专注（以便抑制某些 DSH 输出）」 | 桌宠→DSH | **当前无通道**：`control.json` 由桥写，`status.json` 由桥写，`events.jsonl` 由桥写；桌宠没有任何写文件被桥读取的契约。要做必须新增 `pet-state.json`（桥用现有 5s 心跳 timer 轮询）→ 加法式、不破坏 v3/v4，但要改桥 + 契约 + parity + canary + 文档 | ⚠️ 可选，价值低（DSH 不主动说话；桥只是把事件写给桌宠） |
| 「屏幕观察元数据」事件 | DSH→桌宠 | **不可行**：DSH 观测不到屏幕（§2），没有数据源 | ❌ |
| 若未来 CUA 装了：从 CUA 工具调用推「DSH 刚看了屏幕」 | DSH→桌宠 | 可行且**无需新契约**：CUA 的 `tool/call` 是 durable `session/event`，桥目前只透传 `tool/result`；把 `tool/call` 加入 `NOTABLE_SESSION_EVENTS` 即可（payload 只有 name/turn/step，不带参数正文） | ✅ 后续可选（加法式） |
| 「屏幕内容（截图/OCR）」事件 | 任意 | ❌ 见 §6.4 | ❌ |

**加法式扩展的做法（不破坏 compat）**：现有读取端对「未知事件类型」直接丢弃（`isDshEventType` 白名单 → `parseDshEventLine` 返回 null，`bridge-schema.ts:189-193,356-375`），对「未知 payload 键」只保留标量（`:309-322`），对 status/control 的未知顶层键忽略（`isDshBridgeStatusFile` 只校验已知键，`:378-390`）。因此新增事件类型/new payload 标量对旧桌宠**安全**；旧桥（v3）对新桌宠也安全（v4 读取端走 legacy 范围回退）。需要同步改的文件：`src/shared/bridge-schema.ts`（`DSH_EVENT_TYPES`/`DSH_EVENT_PAYLOAD_KEYS`/长度上限）、`bridge/.../lib/constants.js`（白名单副本）、`bridge/.../lib/index.js`（写入点）、`tests/bridge-plugin.test.ts`（parity）、`scripts/dsh-canary.mjs`（canary 断言）、以及 `src/main/desktop/dsh-watch.ts`+renderer 消费端（若要消费）。**不要** bump `BRIDGE_CONTROL_SCHEMA_VERSION`（会让旧桌宠把整帧判无效）。

### 6.3 桥适合做「屏幕观察通道」吗？—— 不适合

| 维度 | 事实 | 后果 |
|---|---|---|
| 方向 | 桥是 DSH→桌宠**单向**（status/control/events 全部桥写；桌宠只读） | 桌宠无法通过桥「请求截一张图/问 DSH 模型」；也没有 request/response id、超时、取消语义 |
| 体积 | 单行 64KB 上限、5MB 轮转、payload 字符串默认 ≤256 字符（`text` 例外 8000） | 一张 JPEG base64（哪怕 1280px/70q）是数百 KB–MB 级 → 要么被丢弃，要么打爆轮转与磁盘 |
| 隐私 | 桥目录在 `~/.dsh/` 下，明文、同用户可读、7×24 常驻；豆包报告的核心不变量是「不落盘」 | 截图/OCR 一旦进 events.jsonl 就持久化，违背方案红线 |
| 延迟 | 750ms 轮询 + 5s 心跳；无事件驱动 | 不适合「实时互动」的内容级链路（只适合元数据） |

**结论**：桥只承载**元数据**（状态/事件/标量），屏幕内容（截图/OCR/VLM 结果）**不应**走桥；若未来做「DSH 代跑 VLM」，应走 host 插件内的内存调用（或 loopback HTTP/WS），并把结果只写「是否看了/摘要等级」这类标量，不回传图像。

---

## 7. 问题 5：能否复用 DSH 的 permission/approval 做「透明面板 / 可撤销」

### 7.1 DSH 的 permission/approval 机制（事实）

| 机制 | 语义 | 证据 |
|---|---|---|
| `dsh-user-approval` | 主机服务 `ctx.approval`；`setPolicy(agent, policy)` / `request(req)` / `overrideOf(session)`；policy 只有 **`ask` / `never`**；`never` 在 waterfall 之前确定性拒绝；无 answerer → `unavailable`（fail-closed）；`approval/asked`→`approval/decided` 写 session 日志（**log-only**）；pending 是进程内（checkpoint 不恢复） | `dsh-user-approval/README.md:12,32,36,90,165,168`；`dsh-tool-cordis/lib/types/api-catalog.js` 的 `approval` 服务 |
| 一次性 grants | 结果词汇只有 `allowed-once`；**没有 allow-always、记住规则、撤销、grant store** | `dsh-user-approval/README.md:165` |
| UI（浏览器） | DSH Web GUI 的 approval 卡片：Enter = 受限范围（tool approval 为 once；**CUA 为 current session**）；持久化必须显式点 Always allow；`conversation.approval.card` Factory 可被「application consent」复用（但仅限 DSH 客户端插件内部） | `dsh-client-ui-approval/README.md:23,38` |
| permission presets | 把 sandbox mode + approval policy 打包成 preset（Read Only/Workspace Write/Full access/Auto review）；`permission/preset` durable 事件；进程级 catalog 供客户端渲染；`custom` 不可选；**不允许第三方发布新 preset** | `dsh-permission-presets/README.md:28-60,112` |
| Auto review | 每次工具调用前用当前 agent 的模型审查（允许即跑、拒绝转用户审批）；实验性 | `dsh-experimental-auto-review/README.md` |
| CUA 应用授权（最接近「按 app 允许/拒绝 + 可撤销」的官方先例） | `cuaAccess`：`applications()`（已保存 grant/refused 应用）、`systemStatus()`、`requestPermission()`、`openSettings()`、`revoke(id)`（撤销并 join 相关操作）、`retryApproval(id)`（清 refusals 允许再次询问）；**session 级/持久**两档 | `dsh-tool-cordis/lib/types/api-catalog.js:890-949`；`dsh-client-ui-approval/README.md:23` |

### 7.2 能否复用？—— 不能直接复用，只能借设计

| 豆包报告里的需求 | DSH 能力 | 结论 |
|---|---|---|
| 「刚刚看到了什么」透明面板（最近 10 次、是否发送、[删除]、一键清空） | **没有**任何外部可用的观察记录/审计服务；approval 事件只记工具审批，且 log-only、无删除 API | ❌ 必须桌宠自建 |
| 「按 app 允许/拒绝」（屏幕规则） | DSH 没有「按 app」概念；CUA 的 applications 只对 CUA 自己有效的应用授权页 | ❌ 桌宠自建规则引擎（豆包 §4.4 正确） |
| 「可撤销/全局暂停」 | `cuaAccess.revoke` 只撤销 CUA 的 app 访问；DSH 无通用撤销 API，无 grant store，pending 进程内 | ❌ 桌宠自建 |
| 「首次采集前显式确认（consent sheet）」 | approval 只针对 DSH 工具调用，无法由外部进程发起 | ❌ 桌宠自建；但可参考 CUA 的「应用图标 + session/always 范围」交互 |
| 「观察时宠物有可感知状态」 | DSH 无宠物概念 | ❌ 桌宠自建 |

**限制清单**（若未来想「让 DSH 帮忙弹一个审批卡」）：
1. 没有任何公开/Remote API 允许**外部进程**创建 approval request；只有 host 插件（DSH 进程内）能调 `ctx.approval.request`。
2. approval 是逐次、进程内、不持久；关掉 DSH 后全部丢失，不能当授权记录。
3. 无撤销/查询 API；`approval/asked|decided` 是 log-only durable 事件，且属于会话日志（含在 `$DSH_HOME` sessions 里）。
4. CUA 的 `cuaAccess` 是 CUA bundle 专属（未安装、无第三方 contribution 点），且权限对象是 CUA 的系统权限，不是桌宠的截图规则。
5. 桌面 approval UI 在 DSH Web GUI 内；桌宠是独立 Electron app，弹卡必须切到 DSH 窗口，破坏「宠物不打断」的体验。

**结论**：豆包报告自建「透明面板 + 规则引擎 + 可撤销」的方向**正确且必要**；DSH 侧只能借**信息架构**（CUA 的 apps/revoke/retryApproval、session/always 范围、有效状态）作为设计参考，不能复用实现。

---

## 8. 问题 7：对豆包报告 §4.7 / §6 的 DSH 相关修正

### 8.1 逐条修正

| # | 豆包报告原文位置 | 修正/补充 | 依据 |
|---|---|---|---|
| 1 | §4.7 表（L436-455）：「新增 `native/screengrab` + `scripts/build-native.mjs` + `src/shared/screen-*` + `src/main/desktop/screen-observer.ts` + IPC + renderer reactions + settings + behavior-director + index + packaging」 | **DSH 侧完全不需要新增组件**；该表保持原样即可（它本来就是桌宠自建）。唯一要补一行：**不要**尝试复用 DSH 的屏幕/辅助功能能力（§2） | §2、§4 |
| 2 | §4.7「与 DSH 的联动」仅一句（L426：专注中若 DSH 有 task/error 只做表情反应） | 该联动**已实现**：桥的 `task/error`、`task/start|end`、`assistant/message.text` 都可直接消费（`bridge-schema.ts:155-161,218-230`；`bridge/.../lib/index.js:932-1091`；`dsh-watch.ts:56,196+`）。无需新事件 | §6.1 |
| 3 | §4.7 未提「TCC 归属」 | 明确写：**TCC 必须归桌宠 app**。若借 DSH 的屏幕授权，用户将无法单独撤销宠物的权限（DSH 与宠物共享 `com.deepseek.dsh` 的授权），且未来 DSH CUA 也依赖同一授权，互相牵连 | §2.3、§4 |
| 4 | §4.3 不变量 4「内存态、不落盘」 | 增加一条反例约束：**P3 若走 DSH 模型层，截图会成为 `$DSH_HOME` 附件并永久保留**（`dsh-attachment/README.md:119`）→ 直接违反不变量 4。因此「DSH 代跑 VLM」只能作为显式实验选项，默认路径必须桌宠自建 | §3.4 |
| 5 | §4.3 不变量 6「出口前脱敏」 | DSH 模型层不提供按 app 的规则/脱敏钩子（`dsh-llm` 无 pre-request 内容过滤 API；approval 不管模型输入）→ 脱敏必须桌宠侧完成，不能外包给 DSH | §3.3/§7 |
| 6 | §6 W-A/W-B/W-C/W-D 分期 | **保持不变**（无 DSH 依赖）。新增可选 **W-E（DSH 代跑 VLM 实验）**：用户显式开启 + 独立 host 插件（`inject:['llm','attachments']`）+ 只允许低敏窗口 + 附件清理策略（无官方删除 API → 需要自行清理 `$DSH_HOME/attachments`，有风险）。建议排在 W-D 之后、默认不做 | §5 |
| 7 | §6 未提桥契约变更成本 | 若要把「宠物专注态」告知 DSH（低价值，见 §6.2），需要改 **5 个文件 + parity + canary**（`bridge-schema.ts`、`lib/constants.js`、`lib/index.js`、`tests/bridge-plugin.test.ts`、`scripts/dsh-canary.mjs`），并新增 `pet-state.json` 通道 + 文档；不 bump `BRIDGE_CONTROL_SCHEMA_VERSION`。**建议不做** | §6.2 |
| 8 | §4.9/§4.8 权限与降级矩阵 | 补充一行「DSH 侧无采集权限」：DSH 当前没有 Screen Recording 授权（asar 无采集代码，也无调用点；CUA 未安装）→ 不要假设 DSH 能替桌宠截屏；也不要试图通过 DSH 的 Web/loopback 路由取图（无此接口） | §2 |

### 8.2 「报告未考虑 DSH 侧」的关键遗漏（新增到豆包报告 §0/§3）

1. **DSH 0.2.2-rc.1 有「模型层图片输入」但没有「屏幕采集」**：`deepseek-flash` image-capable，可被插件用 `ctx.llm.stream` + `ctx.attachments.saveImage` 调；但截图必须来自外部 → 这给了一条「桌宠截图 → DSH VLM」的捷径，代价是**永久落盘 + 用户账户计费 + 无逐次审批**（§3.4）。
2. **官方 CUA bundle 存在但未装、且 TCC 归 DSH**：容易被误以为「DSH 能截屏」，实际它是 on-demand、darwin-only、Experimental、只服务 PTC 会话模型工具（§2.2-2.4）。
3. **桥是 DSH→桌宠单向**，没有 request/response 通道；「实时内容级」不可能靠桥（§6.3）。
4. **DSH 的 approval 不能复用**（无 grant store/撤销/外部注入，§7）。
5. **当前现网桥跑的是 v3 legacy**（`work/live-bridge/rev-1794371618691`，2026-11-11 12:33），仓库源码已是 v4（14:15 后），v4 的 compat（`compat` 块/install.json/bridge-error.json）**还没在现网激活**——任何「依赖 v4 compat 字段」的新功能，都必须先做一次激活 + canary 验证（§9.2）。
6. **隐私边界**：DSH 的 `attachments/`、`sessions/`、`storages/` 都是明文/半明文持久化；若桌宠把观察元数据「顺便」写进桥目录，也在 `~/.dsh` 下——豆包报告「观察日志只存元数据、7 天清理」需要桌宠自己落实，DSH 不会清理（§3.4、§6.3）。

---

## 9. 本机现状观察（只读，问题 6）

### 9.1 真实 profile / 模型 / 桥

| 项 | 观察（**未修改**） | 依据 |
|---|---|---|
| 真实 `~/.dsh` | 符号链接 → `/Volumes/4TB外置盘/dsh-appdata`（owner wangzihe，`drwx------`） | `ls -la ~/.dsh` |
| desktop bundle 列表 | `dsh-base`、`dsh-web-app` + 13 个 experimental/optional；**不含 `dsh-cua-bundle`** | `profiles/desktop/package.json` |
| 模型 | `provider: deepseek-account`、`model: deepseek-flash`、`reasoningEffort: max` | `profiles/desktop/cordis.patch.yml` 的 `agent-default-model` row |
| 桥 | `aventurine-bridge` 以 **live 副本** insert（`work/live-bridge/rev-1794371618691/lib/index.js`），`launchPet: true`，`petAppPath` 指向仓库 `dist/mac-arm64/AventurinePet.app` | 同上 patch 末尾 |
| 桥运行态 | `status.json`：`{"ts":1794386037833,"running":true,"agents":6,"lastEventAt":1794386035137,"lastType":"session/event","offline":false}`；events.jsonl 1,492,867B，mtime 16:33:58（**桥正在运行，本会话就在其中**） | `~/.dsh/aventurine-pet/status.json`、`ls -laT` |
| 桥版本 | live 副本 = **v3**（`package.json` `dsh-aventurine-bridge-live-rev-...`、`version 0.0.0-live`，无 `compat`）；仓库 `bridge/dsh-aventurine-bridge` = **v4**（`0.2.0`、`engines.dsh`、compat、install/diagnostic）；**两者不同，v4 未激活** | `diff -u work/live-bridge/... bridge/...`（见 §11） |
| 另一会话痕迹 | `$DSH_HOME/llm-deepseek/files-v3.json` mtime **16:25:56**（636KB，Files API 上传索引，活跃写）；`storages/session_projcache/sessions` mtime 16:33:56；`profiles/desktop/cordis.patch.yml` mtime 12:33（早于本次审计）；`attachments/` mtime 11-04。**未读内容、未改动** | `ls -laT` |

> 提醒 lead：另一会话若在改「模型问题」，最可能触碰 `profiles/desktop/cordis.patch.yml` 的 `agent-default-model` row / `$DSH_HOME/llm-deepseek/` / `storages/`。我**只读**观察，未做任何写操作；本报告不依赖这些文件的稳定性。

### 9.2 对「桥扩展」的直接影响

- 现网桥是 **v3**：没有 `compat`/`install.json`/`bridge-error.json` 的运行时写入（install.json 由激活脚本写，但当前 patch 的 live 副本是 v3 → v4 的 `control.compat` 断言不会出现）。
- 任何「v4 才能用」的新语义（如依赖 `compat` 判定）在现网**不可用**；v2 契约（`text`、`task/*`、`session/event`）已可用。
- 若要验证桥扩展/升级：用 `pnpm dsh:canary --compat`（临时 DSH_HOME，前置审计 §附录 A 有完整安全实验方法），**不要**在真实 profile 上试。

---

## 10. 推荐方案与分阶段（DSH 相关部分）

| 阶段 | DSH 相关动作 | 验收 |
|---|---|---|
| 现在（P0/P1） | 维持现有桥 v2 契约（或升级到 v4：激活脚本 + canary）；桌宠消费 `agent/status`、`task/*`、`session/event(assistant/message.text)` | 桥心跳在线、`task/error`/`turn/end` 去重正确、canary 默认组 + `--compat` 通过（在临时 home） |
| P2（本地 OCR） | **DSH 不参与**；截图/OCR 全在桌宠 helper；若要「专注中 DSH 安静」→ 桌宠侧自行决定是否渲染 DSH 事件 | 无新增 DSH 依赖；桥事件照常消费 |
| P3（VLM） | **默认不参与**（桌宠自建 VLM client）。可选实验 W-E：独立 host 插件 + `inject:['llm','attachments']` + 用户显式开关 + 附件/费用/审批三重提示 | 关闭开关后零 DSH 网络/附件增长；打开后能在临时 profile 用 mock/小图跑通一次辅助调用 |
| 未来（若 CUA 官方稳定且暴露可调 API） | 重新评估「DSH 采集」；但 TCC/附件/审批三问题不消失前，仍不推荐 | — |

---

## 11. 风险、未知与验证方法

| 项 | 等级 | 说明 / 验证方法 |
|---|---|---|
| CUA bundle 未安装，数据形态/采集 API 未实测 | 中 | 验证方法（**隔离**）：`T=$(mktemp -d /tmp/dsh-cua-home-XXXX); CLI='.../runtime/cli/bin/dsh'; env DSH_HOME=$T "$CLI" --profile cua-probe --from-default-profile web; env DSH_HOME=$T "$CLI" plugin --profile cua-probe add -w @deepseek-ai/dsh-cua-bundle`（需网络）→ 读临时 profile `node_modules/@deepseek-ai/dsh-cua-bundle/**` 源码，确认截图/窗口/OCR 数据形态与 helper 的 Info.plist/签名；**不要**装进真实 desktop profile |
| TCC 归属（DSH app vs helper）未实测 | 中 | 装到临时 profile 后触发一次权限请求，看「系统设置 → 隐私与安全性 → 屏幕录制/辅助功能」列表出现的 app 名/签名主体；或 `log stream --predicate 'subsystem == "com.apple.TCC"'` 观察请求方；预期为 `com.deepseek.dsh`（签名 TeamIdentifier NAN929V4UM） |
| DSH 未来版本契约漂移 | 中 | 桥已用 `engines.dsh` + compat + canary；CUA/图片 API 尚未被桌宠依赖 → 风险低 |
| 「DSH 代跑 VLM」的附件永久落盘 | 高 | 若做 W-E，必须：只开低敏窗口、每次调用后自行清理 `$DSH_HOME/attachments`（无官方删除 API，需自己按 mtime/引用清；有误删/残留风险）、UI 明示；或干脆不做 |
| 桥 v4 未在现网激活 | 中 | 激活前用 `activate-dsh-bridge.mjs --dry-run` 核对；激活后用 canary C3/C6 复验；注意这属于「改真实 profile」，本次审计**未做** |
| **另一会话正在改模型/配置** | 中 | 只读观察（§9.1）；建议 lead 在合并/落盘前确认 `profiles/desktop/cordis.patch.yml` 与 `$DSH_HOME/llm-deepseek/` 的最终状态；本报告结论不依赖其当前值 |
| 双实例/多 profile 写同一桥目录 | 低 | 现有单写者假设（`status.json` last-writer-wins；前置审计 §9 已列） |
| 隐私：桥目录在 `~/.dsh` 下 | 中 | 只放元数据；不把屏幕内容写桥（§6.3）；观察日志若落盘，建议放桌宠自己的 `app.getPath('userData')` 并 7 天清理（豆包 §4.3 不变量 7） |
| DeepSeek 账户额度/登录态 | 低 | W-E 才相关；默认路径不触碰 |

---

## 12. 证据清单（可复核）

### 12.1 DSH 侧源码（行号取自 `/tmp/dsh-asar-audit/extract/dsh/node_modules/@deepseek-ai/`）

| 事实 | 引用 |
|---|---|
| 官方 bundle 清单 / on-demand CUA / Experimental / 列表顺序 | `dsh-official-bundles/lib/index.js:54`（ON_DEMAND_BUNDLES）、`:114`（MORE_BUNDLES）、`:126`（EXPERIMENTAL_BUNDLES）、`:199-236`（CUA meta：darwin only / Accessibility + Screen Recording / PTC） |
| CUA 权限/应用授权 Remote API（无截图 API） | `dsh-tool-cordis/lib/types/api-catalog.js:890-949`（`cuaAccess`：applications/systemStatus/requestPermission/openSettings/revoke/retryApproval/ptcConfiguration/enablePersistentPtc/applicationIcons） |
| 安装态无采集 API；唯一 TCC 查询是麦克风 | `asar/lib/main.js:13551`（`systemPreferences.getMediaAccessStatus("microphone")`）；全 asar grep `desktopCapturer|CGWindowListCreateImage|SCScreenshotManager|SCShareableContent|AXUIElement|AXIsProcessTrusted|CGEvent|NSEvent` = 0 命中（`lib/main.js` 外；`lib/main.js` 仅麦克风行） |
| 唯一原生 addon 非采集 | `node-addon-system-darwin-arm64/package.json`（"Prebuilt POSIX flock Node-API binding for macOS arm64"） |
| base 组合：模型栈/附件/审批 | `dsh-base/cordis.patch.yml:35`（llm）、`:100`（llm-retry）、`:136`（llm-pi-ai）、`:146-147`（attachment-local）、`:260`（user-approval）、`:265`（permission-presets）、`:434-435`（image-offload）、`:532`（deepseek-api-key）、`:535`（deepseek-account） |
| `ctx.llm` 服务 API（stream / imageRequestTarget / listModels / prepareCall…） | `dsh-tool-cordis/lib/types/api-catalog.js`（`key:'llm'`）；`dsh-llm/README.md`（Stream one model call / What you can do / Failures） |
| 图片输入/预算/Files/只输入 | `dsh-llm-deepseek/README.md:48-53,64-71,97,129,138,177,209,218`；`dsh-llm/README.md:129,138` |
| 插件调用模型范例（inject + stream + 组装 + 错误处理） | `dsh-compaction-basic/lib/index.js:289-335`（`summarizeWithLlm`）、`:801-805`（`static inject=["llm","tokenMeter","sessions"]`） |
| 附件服务 API / 永久保留 | `dsh-attachment/README.md:12,32,69,75,119,132,136`；`dsh-tool-cordis/lib/types/api-catalog.js`（`key:'attachments'`、`key:'approval'`、`key:'sandbox'`、`key:'sandboxPolicy'`） |
| approval 语义/限制/事件 | `dsh-user-approval/README.md:12,32,36,90,165,168`；`dsh-session/lib/types/known-event-types.js:24-26,49,53`（`approval/asked|decided|policy`、`permission/preset`、`sandbox/mode`） |
| approval UI 作用域（once / CUA current session / Always allow） | `dsh-client-ui-approval/README.md:23,38` |
| permission preset 语义 | `dsh-permission-presets/README.md:28-60`；`dsh-client-ui-permission-presets/README.md`（picker/Settings row） |
| Auto review（模型审查工具调用） | `dsh-experimental-auto-review/README.md`（Summary/Use） |
| on-demand 安装走 registry（未装即不可用） | `dsh-plugin-manager/lib/index.js:1079`（registry 判定 fallbacks）、`:2137`（`OFFICIAL_ON_DEMAND_CATALOG`）、`:2712`（`installBundle`） |

### 12.2 桌宠侧（工作区）

| 事实 | 引用 |
|---|---|
| 桥 5 种事件/11 个 payload 键/长度上限/在线 TTL/轮转/64KB | `src/shared/bridge-schema.ts:145-161,218-246,283-324,356-375` |
| control/install/diagnostic 契约与版本 | `src/shared/bridge-schema.ts:40-41,124-140,430-456,478-650` |
| v4 compat 自述 + 桌宠兼容判定 | `bridge/dsh-aventurine-bridge/lib/index.js:333-362`；`src/main/desktop/dsh-compat.ts:1-58,110` |
| 桥事件映射/去重/隐私/启动预检/apply 不抛 | `bridge/dsh-aventurine-bridge/lib/index.js:142-143,205-230,932-1160,1160-1190`（全文 1190 行） |
| 750ms 轮询 / EOF 基线 / 轮转 / 三路分发 | `src/main/desktop/dsh-watch.ts:56,196-336,373+,518` |
| 桥持久化/安装清单/诊断文件 | `~/.dsh/aventurine-pet/{status.json,control.json,events.jsonl,install.json,bridge-error.json}`（真实目录只读观察；当前只有前三个，见 §9.1） |
| 激活/回滚/canary | `scripts/activate-dsh-bridge.mjs`（live 副本 + engines + install.json + 激活后 ≤10s 校验）、`scripts/dsh-canary.mjs`（默认组 + `--compat` C1–C6）、`tests/bridge-plugin.test.ts`（parity） |
| 前置审计已证明、本文不重复 | `docs/research/dsh-harness-audit-2026-11-11.md` §2（事件形状）、§3.3（inject）、§3.6（HMR）、§4（进程/拉起）、§6（v2 契约建议） |

### 12.3 复现命令（全部只读 / 临时目录）

```bash
# 1) 核对解包副本与安装 asar 一致（抽样 6 文件 SHA-256）
node /tmp/dsh-verify/verify.mjs "dsh/node_modules/@deepseek-ai/dsh-llm/lib/index.js" \
  "dsh/node_modules/@deepseek-ai/dsh-official-bundles/lib/index.js" \
  "dsh/node_modules/@deepseek-ai/dsh-session/lib/types/known-event-types.js" \
  "dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/index.js" "lib/main.js" "package.json"

# 2) 安装态无采集/无 CUA（在解包副本里）
cd /tmp/dsh-asar-audit/extract
grep -rIl -E 'desktopCapturer|CGWindowListCreateImage|SCScreenshotManager|SCShareableContent|AXUIElement|AXIsProcessTrusted' --include='*.js' . | head
ls dsh/node_modules/@deepseek-ai | grep -Ei 'cua|screen|screenshot|capture|vision|computer'
# 3) CUA 只在 on-demand 清单里
grep -n '"@deepseek-ai/dsh-cua-bundle"' dsh/node_modules/@deepseek-ai/dsh-official-bundles/lib/index.js

# 4) 本机真实 profile 只读核对（不写）
cat /Volumes/4TB外置盘/dsh-appdata/profiles/desktop/package.json          # bundles 不含 cua
sed -n '1,20p' /Volumes/4TB外置盘/dsh-appdata/profiles/desktop/cordis.patch.yml  # agent-default-model
ls -laT /Volumes/4TB外置盘/dsh-appdata/llm-deepseek/                       # 另一会话活跃写（mtime）
cat /Volumes/4TB外置盘/dsh-appdata/aventurine-pet/status.json              # 桥心跳（v3 live rev）

# 5) 现网桥 v3 vs 仓库 v4（只读 diff）
cd /Volumes/4TB外置盘/deepseek-harness/aventurine-pet-vrm
diff -u work/live-bridge/rev-1794371618691/lib/constants.js bridge/dsh-aventurine-bridge/lib/constants.js | head -40
```

---

## 13. 一句话给 lead

**DSH 0.2.2-rc.1 安装态没有任何屏幕采集/辅助功能/OCR 能力（唯一 on-demand 的 `dsh-cua-bundle` 未安装、只服务 PTC 会话模型工具、TCC 归 DSH）；模型层支持图片输入且插件可调，但附件永久落盘 + 用户账户计费 + 无逐次审批，因此「截图→VLM」应保持在桌宠自建 helper + 自有 provider；现有桥只适合承载元数据（DSH→桌宠单向、无图像通道），专注状态/屏幕观察本属桌宠侧、无需扩展桥；DSH 的 approval 机制不能复用给外部进程，只能借 CUA 的信息架构做设计参考。**

---

# §附录 A：DSH 生成屏幕评论链路的可行性设计（T3b，2026-11-11）

> 背景变更（用户 2026-11-11 16:45 拍板）：屏幕感知的「说话」文本来源由「自研/官方池映射」改为**借 DSH 模型生成评论**；本轮**只出修正设计，不改代码**。
> 本附录**不修改上文任何结论**。上文结论仍然成立：DSH 没有采集能力（§2）、桥单向（§6）、approval 不可复用（§7）；本附录只回答「既然要借 DSH 生成评论，这条链路怎么设计」。
> 与既有文档的关系：`docs/research/screen-awareness-architecture-review-2026-11-11.md`（下称「架构复核」）的 M4/M5 断言「模型生成台词不成立」是基于**当时用户约束（台词只能官方原文）**；用户已变更该决策，因此本附录把它降级为「新增文本来源需显式分类 + UI 标注 + 出口过滤」，不是推翻其证据。
> 时间盒：25 分钟；结论等级：API/契约类 `confirmed`（asar 源码），未实测项明确标 `unverified`。

## A.0 TL;DR

| 问题 | 结论 |
|---|---|
| 能否不建 agent/session 直接调模型 | **能**。`GenerateOptions` 无 agent 字段，`sessionId` 可选；传 `sessionId` 才可能与会话/上传关联，**省略即不污染会话历史**（证据 A.1）。 |
| 纯文本 prompt 是否零落盘 | **基本零落盘（有条件）**：插件直调（无 sessionId）不写 session JSONL、不触发 `dsh_session_log`（官方 README 明说 direct requests without a live Session omit it）、不产生 OTel session 记录；`~/Library/Logs/DeepSeek Harness/` 实测为空。**但**：网络请求本身会带 OCR 文本给 DeepSeek（不可避免）；必须自行保证「不写日志、不落盘缓存、不带图」。 |
| 传输通道 | **推荐 loopback HTTP 路由（新独立插件）**，不推荐复用桥文件。延迟 1–20ms vs 文件轮询 750ms–5s；但需自建 token/限流/超时。 |
| 是否要图 | **必须纯文本**。图片走 `ctx.attachments.saveImage` → 永久落盘（`dsh-attachment/README.md:119`），直接违反「不落盘」红线；且当前不需要（OCR 文本足够生成评论）。 |
| 对现有桥 v4 compat/canary 影响 | **零影响**（若采用「新增独立 commenter 插件 + 新增能力文件」方案）；若硬把评论塞进桥，需 v5 兼容层 + canary 全改，不推荐。 |
| 台词硬约束 | **有条件可行**：生成的评论**不是**「官方语音台词」，必须作为新增文本类别「DSH 评论」显式建模（不进口 `voicelines.ts` 池、不参与 SHA-256 锁测试、UI 标注来源、默认关闭、长度上限、出口过滤）；若要「砂金语气」需用户再决策（A.5）。 |
| 总判定 | **有条件可行**。阻断项只有两个且都可设计规避：(1) OCR 文本出网需用户同意 + 强脱敏；(2) 与官方台词单一来源约束的冲突需 Lead/用户按 A.5 选形态。 |

## A.1 精确调用 API（`ctx.llm.stream`）

### A.1.1 服务与签名（confirmed，asar 源码）

- 服务：`ctx.llm`（Cordis 服务，`dsh-llm` 提供；base 组合在 `dsh-base/cordis.patch.yml:35` 挂载），插件需 `export const inject = ['llm', ...]` 才可访问（无 inject 时 `ctx.llm` 为 undefined，前置审计 §3.3 已实测同机制）。
- `GenerateOptions` **精确字段**（`dsh-llm/lib/typert.host.js:360`，类型声明原文）：

```ts
export interface GenerateOptions<Purpose extends string = LlmRequestPurpose> {
  provider: string                 // 路由名，如 'deepseek-account' / 'deepseek-official' / pi-ai 自定义
  model: string                    // 如 'deepseek-flash'
  reasoningEffort?: ReasoningEffortId   // 'off' | 'low' | 'high' | 'max'（adapter 能力子集）
  messages: RequestMessage[]       // Message | RequestUserInput
  system?: string                  // 顶层 system prompt
  tools?: ToolSchema[]             // 评论生成不需要（省略）
  toolHistory?: ToolHistory
  temperature?: number
  maxTokens?: number
  stop?: string[]
  signal?: AbortSignal             // 取消/超时（配合 AbortSignal.timeout）
  sessionId?: Branded<'SessionId'> // ★ 可选；评论生成必须省略
  purpose?: Purpose                // 辅助请求用途（类型层声明；运行时未见白名单校验）
}
```

- `RequestMessage = Message | RequestUserInput`；`RequestUserInput` 形状（`dsh-llm/lib/typert.host.js:552`）：

```ts
export interface RequestUserInput {
  readonly role: 'user'
  readonly content: UserMessage['content']   // 文本块数组
  readonly id?: never
  readonly source?: never
}
```

- 调用方式（官方 compaction 插件是同一写法的范本：`dsh-compaction-basic/lib/index.js:289-335`、`static inject` 在 `:801-805`）：

```js
for await (const chunk of ctx.llm.stream({ provider, model, system, messages, maxTokens, temperature, signal })) {
  // chunk.type: 'block-start' | 'text-delta' | 'reasoning-delta' | 'tool-call-delta' | 'block-end' | 'usage' | 'finish'
}
```

- **终态形状**（`dsh-llm/lib/typert.host.js:355`，`FinishReasonMap`）：
  `stop` / `tool-calls` / `max-tokens` / `aborted{failure: LlmFailure}` / `error{failure: LlmFailure}`；`finish` chunk 的 `reason` 取其中一种（`dsh-llm/lib/types/index.js:972` 的 `{ kind:'error', failure }` 构造点）。可见文本来自 `chunk.type==='text-delta'` 的 `chunk.text`（前置审计 §2.2/§2.5 已实测该 chunk 协议）。
- **重试语义（重要）**：`dsh-llm` 服务本身**不会**重跑请求——重试是 `dsh-llm-retry` 在 agent 的 failed-step 扩展点做的（`dsh-llm/README.md`「Failures and recovery」）。插件直调 `ctx.llm.stream` **没有隐藏的 5 次重试**，不会放大延迟/费用；失败即失败，由插件自己决定退避或静默。
- **不需要 `BlockAssembler` 导入**：bridge 类插件是零依赖包（`bridge/dsh-aventurine-bridge/package.json` 无 dependencies；`tests/bridge-plugin.test.ts:438-521` 锁定包形态），从 `work/live-bridge/<rev>/` 加载时**无法 resolve `@deepseek-ai/dsh-llm`**（DSH 包在 `app.asar/dsh/node_modules/` 内，不在插件路径的 node_modules 链上）→ 插件侧手写 10 行最小拼装（累加 `text-delta.text`、遇 `finish` 判 `reason.kind`）即可，不要 import DSH 包。

### A.1.2 能否不创建 agent/session

**能**，三条证据：

1. `GenerateOptions` 里**没有 agent 字段**，`sessionId` 是 `?:`（A.1.1）。
2. `dsh-session-log-deepseek/README.md`（Request field / Acceptance and retry 两节）明说：**“Direct requests without a live Session omit `dsh_session_log`.”** —— 没有 live sessionId 时，官方 API 的 session-log 上传字段直接省略。
3. `ctx.llm.stream` 只是服务到 adapter 的分发（`dsh-llm/README.md`：服务不重跑、不写 session；durable 历史由 agent loop 负责）。插件不创建 agent/session 时，**没有任何代码路径 append session 事件**（会话 JSONL 只由 `dsh-session` 的 `append()` 写入，调用方是 agent-loop，不是 llm 服务）。

→ 评论生成用**匿名辅助请求**：不传 `sessionId`，不 `ctx.agents.create`，不 `ctx.sessions.create`。这同时是隐私设计的关键（A.3）。

### A.1.3 最小可行伪代码（插件侧，Node/JS，零依赖）

```js
// bridge/dsh-aventurine-commenter/lib/index.js（新独立 bundle，见 A.2）
export const name = 'dsh-aventurine-commenter'
export const inject = ['llm', 'webServer']

const FAILURE_TEXT = { RATE_LIMIT: 429, QUOTA: 402, AUTH: 401, MISSING_CREDENTIAL: 401,
  TRANSPORT: 502, TIMEOUT: 504, NO_ADAPTER: 503, CONTEXT_WINDOW_EXCEEDED: 413 }

export const apply = (ctx, config = {}) => {
  const provider = config.provider ?? 'deepseek-account'
  const model = config.model ?? 'deepseek-flash'
  const maxChars = Math.min(config.maxPromptChars ?? 1200, 4000)
  const token = crypto.randomBytes(24).toString('hex')   // 每次 apply 轮换

  const route = {
    kind: 'exact',
    path: '/__aventurine/comment',
    handler: async (req, res) => {
      const reply = (status, body) => { res.statusCode = status; res.setHeader('content-type','application/json'); res.end(JSON.stringify(body)) }
      try {
        if (req.method !== 'POST') return reply(405, { code: 'method' })
        if (req.socket.remoteAddress !== '127.0.0.1' && req.socket.remoteAddress !== '::1') return reply(403, { code: 'loopback-only' })
        if (req.headers['x-aventurine-token'] !== token) return reply(401, { code: 'token' })
        const body = await readBodyCapped(req, 32 * 1024)              // 自写：超限直接 413，不缓存
        const text = typeof body.text === 'string' ? body.text.slice(0, maxChars) : ''
        if (text.trim() === '') return reply(400, { code: 'empty' })
        // 严禁：把 text 写日志/写盘；下面只拼进 messages
        const messages = [{ role: 'user', content: [ { type: 'text', text:
          `你在桌宠里对用户当下活动做一句简短旁白。只输出一句中文，不超过 40 字；` +
          `不要复述原文/文件名/URL/数字串；不要用「我看到/你的屏幕上/你正在输入」；不确定就输出 SKIP。\n` +
          `活动：${text}` } ] }]
        const ac = new AbortController()
        const timer = setTimeout(() => ac.abort(), config.timeoutMs ?? 20000); timer.unref?.()
        let out = '', reason = null
        try {
          for await (const chunk of ctx.llm.stream({
            provider, model, messages,
            system: '你是桌面宠物的旁白生成器；只输出一句评论或 SKIP。',
            maxTokens: Math.min(config.maxTokens ?? 120, 300),
            temperature: 0.7,
            reasoningEffort: 'off',            // 省钱/降延迟；adapter 支持 off 时禁用 thinking
            signal: ac.signal                  // 注意：不传 sessionId
          })) {
            if (chunk.type === 'text-delta' && typeof chunk.text === 'string') out += chunk.text
            else if (chunk.type === 'finish') reason = chunk.reason
          }
        } finally { clearTimeout(timer) }
        if (reason?.kind === 'error' || reason?.kind === 'aborted')
          return reply(FAILURE_TEXT[reason.failure?.code] ?? 502, { code: reason.failure?.code ?? 'llm' })
        if (out.trim() === '' || /^SKIP$/i.test(out.trim())) return reply(200, { code: 'skip' })
        return reply(200, { code: 'ok', comment: out.trim().slice(0, 120), model })
      } catch (e) {
        // 只记错误码，绝不打 text/comment 内容
        return reply(500, { code: 'internal', message: String(e?.code ?? e?.name ?? 'error').slice(0, 64) })
      }
    }
  }
  const off = ctx.webServer.register(route)
  const capability = { schemaVersion: 1, ts: Date.now(), origin: ctx.webServer.getOrigin(),
    path: route.path, token, provider, model, limits: { maxPromptChars: maxChars,
    maxTokens: config.maxTokens ?? 120, timeoutMs: config.timeoutMs ?? 20000 } }
  writeAtomic0600(join(resolveBridgeDir(config), 'commenter.json'), capability)
  return () => { off(); try { rmSync(commenterFile) } catch {} }
}
```

> 说明：`readBodyCapped/writeAtomic0600` 为示意（与桥现有写法一致：tmp+rename、0600）。`reasoningEffort:'off'` 的合法性由 adapter 能力决定，调用前可用 `ctx.llm.resolveModelInfo(provider, model)` 查 `reasoning.efforts`（A.4）。

### A.1.4 错误/超时/限流形状

| 场景 | 形状 | 建议处理 |
|---|---|---|
| 模型失败 | `finish.reason = { kind:'error', failure:{ code, message } }`；稳定 code 含 `NO_ADAPTER` / `MISSING_CREDENTIAL` / `INVALID_CREDENTIAL` / `AUTH` / `RATE_LIMIT` / `QUOTA` / `ACCOUNT_QUOTA` / `CONTEXT_WINDOW_EXCEEDED` / `TRANSPORT` / `TIMEOUT` / `ABORTED` / `UNSUPPORTED_REASONING_EFFORT` / `EMPTY_RESPONSE`（`dsh-llm/README.md`「Failures and recovery」；`dsh-llm-deepseek/README.md:119`） | 按 code 映射 HTTP 语义（见伪代码）；`RATE_LIMIT/QUOTA/ACCOUNT_QUOTA` → 插件级冷却 10min；`TRANSPORT/TIMEOUT` → 连续 3 次退避 10min |
| 超时 | 无内置 per-call timeout 参数；用 `AbortSignal.timeout()` 包 `signal`；stream 结束为 `finish.reason.kind='aborted'`。adapter 另有自己的 stream-idle 超时（`TIMEOUT` code） | 主进程侧同样加 20s 上限，双保险 |
| 未登录/离线 | `MISSING_CREDENTIAL` / `AUTH` / `TRANSPORT` | 桌宠侧显示「DSH 未登录/离线」，不报错弹窗、静默降级 |
| 模型不可用/无该模型 | `NO_ADAPTER`；或 `resolveModelInfo` 直接拒绝 | apply 时 lazy 校验一次并缓存；不可用 → 能力文件 `enabled:false`，桌宠不调用 |

## A.2 传输通道对比与推荐

### A.2.1 候选 a：插件注册 loopback HTTP 路由（推荐）

**API（confirmed）**：`ctx.webServer.register(route)`，`inject:['webServer']`。

- 路由对象形状（官方插件实例，`dsh-host-open-in-app/lib/types/index.js:147-160`）：
  `{ kind:'exact'|'prefix', path:'/…', handler(req,res) }`（Node `IncomingMessage/ServerResponse` 风格），或 `{ ..., resource:(request)=>Response }`（Fetch 风格，**仅 GET/HEAD**，`dsh-host-webserver/README.md:63`）。POST 必须用 `handler`。
- 端口/地址：`ctx.webServer.getOrigin()` 返回根 URL（`README.md:39,85`，由 host/protocol/实际 listen 端口组合）；本机 desktop profile 已把端口固定为 **38765**（`$DSH_HOME/profiles/desktop/cordis.patch.yml` webserver row），但**不要硬编码**，一律从 `getOrigin()` 写进能力文件。
- 认证：**webServer 无全局认证/Origin 策略**（`dsh-host-webserver/README.md:132`：「No server-wide authentication or origin policy — route owners … enforce their own request policy」）；`readResource` 也不校验 cookie/Host/Origin（`:63`）。→ **必须自建**：每次 apply 生成随机 token（`crypto.randomBytes`），写 `~/.dsh/aventurine-pet/commenter.json`（0600）；请求带 `x-aventurine-token`；再校验 `req.socket.remoteAddress` 是 127.0.0.1/::1；POST-only；body 上限 32KB；Content-Type 校验。
- CSP：与本链路无关（桌宠主进程用 Node `http`/`fetch` 请求，不经渲染层；项目 renderer 网络守卫只约束 renderer，`src/main/security/renderer-network-guard.ts:31,100`）。
- 是否要求 web profile：不要求。desktop 组合本身就挂 `dsh-host-webserver`（base 的 webserver + profile patch 固定端口），host 插件可注册路由；`dsh-client-modules` 等官方插件也这么做。
- 生命周期：`ctx.effect(() => ctx.webServer.register(...))` 或手动收集 disposer；apply/dispose 时写/删能力文件 + token 轮换。

**优点**：请求/响应/错误码/超时语义完整；延迟 1–20ms；不落盘（只要 handler 不记 body）；天然支持“请求-响应”与并发；失败快（connection refused）。
**缺点**：需要 token/限流/body 上限等安全面；本机其他进程也可访问端口（token 兜底）。

### A.2.2 候选 b：复用桥文件通道（不推荐）

- 现状：桥三文件全部由桥写（DSH→桌宠单向，§6.1）；要 pet→DSH 必须新增 `comment-request.json` + 桥 5s 心跳 timer 轮询 + `comment.json` 回写 + requestId 关联。
- 延迟：最坏 5s（心跳周期）或另起更快的 timer（又增加插件复杂度）；对「评论 2–10s 内出现」的目标只是勉强。
- 落盘：OCR 文本/评论会写进 `~/.dsh` 明文目录（虽然可删，但窗口期内持久化），与「纯文本零落盘」目标冲突。
- 契约影响：需要改桥（白名单/常量/parity/canary）或新增文件；若进 `control.json` 必然破坏 schema 严格校验（`schemaVersion` 必须 ===1 且 action 二值，`bridge-schema.ts:430-456`）。新增独立 `commenter.json`/`comment-request.json` 虽加法式，但等于重造一套 RPC。
- 结论：**只可作为离线降级**（DSH 插件不支持注入 webServer 时），不作为主通道。

### A.2.3 推荐与组件清单

**推荐：a（loopback HTTP）**，DSH 侧**新增独立 bundle**（不要改现有桥）：

DSH 侧新增（文件级）：

```
bridge/dsh-aventurine-commenter/
  package.json           name=dsh-aventurine-commenter, private, type=module, main=./lib/index.js,
                         engines.dsh=">=0.2.2-rc.1 <0.3.0"（与桥同闸门）、files=[lib,...]
  cordis.patch.yml       - insert: [{ id: aventurine-commenter, name: dsh-aventurine-commenter }]
  lib/index.js           apply：inject ['llm','webServer']；注册 /__aventurine/comment；token/限流/超时；
                         ctx.llm.stream（无 sessionId）；写/删 ~/.dsh/aventurine-pet/commenter.json
  locale/{zh,en}.json    meta title/description（插件管理页展示用，可选）
  README.md              用户文档（安装/配置/隐私说明）
```

- 需同步：`scripts/activate-dsh-bridge.mjs` 增加 commenter bundle 的激活/回滚（或独立 `scripts/activate-dsh-commenter.mjs`，推荐后者，保持桥脚本单一职责）。
- **对现有 bridge v4 compat/canary 影响：零**。commenter 是独立 bundle（独立 `id`/独立 `package.json`/独立 `engines.dsh`），不 import 桥、不写 `status.json`/`control.json`/`events.jsonl`；桥的 v3/v4 契约、`bridge-schema.ts`、canary C1–C6 全部不动。唯一交集是同一目录下多一个 0600 文件 `commenter.json`（桥不读未知文件，桌宠 `dsh-watch` 只 tail 两个固定文件名，不受影响）。
- 安装方式沿用前置审计 §3.7 方案 A（绝对路径 insert + HMR 免重启）或方案 B（bundle 安装）；升级走 `engines.dsh` 版本闸门。

桌宠侧新增（文件级，均为新增；`src/shared/**` 为 Lead-owned 冻结契约，需 Lead 评审后落）：

| 文件 | 内容 |
|---|---|
| `src/shared/commenter-schema.ts` | 能力文件（commenter.json）与请求/响应 JSON 的纯校验：`CommenterCapabilities {schemaVersion, ts, origin, path, token, provider, model, limits}`；`parseCommenterCapabilities()`（0 信任、截断、绝不抛）；`CommentFailureCode` 枚举；`buildCommentRequest(redactedText)`；`isCommentSafe(){…}`（出口过滤器纯函数，A.5） |
| `src/main/desktop/dsh-commenter.ts` | 主进程客户端：读 `~/.dsh/aventurine-pet/commenter.json`（存在性/TTL，每次请求前读、失败回退缓存）；`POST {origin}{path}`（Node http/https，127.0.0.1，15–20s AbortSignal，单飞/并发 1，token header）；错误码映射/退避状态机；**绝不记录 prompt/评论正文**（只记 code/latency） |
| `src/main/peek/comment-orchestrator.ts` | 编排：peek gate 放行 → 取 OCR 脱敏文本（或 metadata-only 模式）→ 出口前脱敏（复用 `redactObservationText` 纯函数，见 `docs/peek-interface.md:184`）→ 调 commenter → 出口过滤 → 结果（评论 or 失败码）|
| `src/main/ipc/screen-comment.ts` | 加法式 IPC（需 Lead 评审）：`pet:screen-comment-status`（能力/开关/预算）、`pet:screen-comment-now`（手动一次）、`pet:screen-comment-config`（焦点/开关）；**payload 只含评论文本 + 非敏感元数据（app 类别/时长/来源标记），绝不含 OCR 原文** |
| `src/renderer/src/reactions/peek-comment.ts` | 渲染层：把评论作为「DSH 评论」气泡显示（独立样式/角标）；不进官方台词池、不触发 `BubbleGate` 官方冷却逻辑（用独立节流）；出口过滤二次兜底（renderer 再校验长度/禁用词，失败静默） |
| `src/shared/config.ts`（Lead-owned，追加扁平键） | `screenCommentEnabled`（默认 false）、`screenCommentProvider`、`screenCommentModel`、`screenCommentMaxChars`、`screenCommentTier`（metadata/content）；**扁平可选原始键、不 bump CONFIG_VERSION**（架构复核 M3 理由） |
| `src/shared/ipc.ts` + `tests/shared-contract.test.ts` | IPC 通道加法（Lead 评审）；现有 shared 契约测试同步 |
| 测试 | `tests/commenter-schema.test.ts`、`tests/dsh-commenter.test.ts`（mock HTTP：200/401/429/超时/畸形 JSON）、`tests/peek-comment.test.ts`（出口过滤 fixture）、`tests/screen-comment-ipc.test.ts` |

## A.3 隐私/落盘核实（纯文本 prompt）

| 落点 | 是否记录 prompt？ | 证据/结论 |
|---|---|---|
| 会话 JSONL（`$DSH_HOME/sessions/**/session.v4.jsonl.zstd`） | **不写**（只要不建 session、不传 sessionId） | `GenerateOptions.sessionId` 可选；session append 由 agent-loop 负责，`ctx.llm.stream` 只到 adapter（A.1.2） |
| `dsh_session_log`（发给官方 API 的请求附带字段） | **不发送**（无 live session） | `dsh-session-log-deepseek/README.md`：「Direct requests without a live Session omit `dsh_session_log`」；该字段内容本身是 canonical session events，本就会包含会话输入 |
| OTel session telemetry | **不产生**（无 session 记录；默认 mode=FEEDBACK_ONLY） | `dsh-session-telemetry-otel/README.md`（Modes：FEEDBACK_ONLY 默认，只有显式反馈才释放；DISABLED 无传输）；`dsh-otel/README.md`（挂载本身不发任何东西） |
| 插件包清单 `dsh_plugin_packages` | 每次请求附带（默认开），**只含已装插件包名/版本**，不是 prompt | `dsh-llm-deepseek/README.md:111,160`；`dsh-plugin-package-inventory-deepseek` |
| 匿名 user id | 请求头/元数据（adapter 行为），非 prompt | `dsh-llm-deepseek/README.md:143`（「stable anonymous user id outside model input」） |
| 本地日志 | `~/Library/Logs/DeepSeek Harness/` **实测为空目录**；`$DSH_HOME` 无 logs 目录 | 只读 `ls`/`find`（本次审计实测） |
| 本地缓存 | adapter 只缓存 **Files/marketplace** 类元数据（`llm-deepseek/files-v3.json` 是图片 Files 上传索引，纯文本调用不产生）；无 prompt 缓存 | `dsh-llm-deepseek/README.md`（Files reuse）；本次实测该文件来自既有会话 |
| 附件 | 不用 `ctx.attachments` → 零附件落盘 | `dsh-attachment/README.md:119`（一旦用即永久保留） |
| 网络 | **OCR 文本会发给 DeepSeek**（模型请求本身）；provider 侧日志由 DeepSeek 政策决定（**unverified**） | `dsh-llm-deepseek/README.md`（endpoint/attribution） |

**必须由设计显式规避的点**：

1. **不传 `sessionId`**，不 `ctx.sessions.create`/`ctx.agents.create`（否则 session-log/OTel 都可能带上内容）。
2. **不用 `ctx.attachments`**（图片/文件附件永久落盘）→ **纯文本**是唯一符合「不落盘」的形态；**结论：必须纯文本，不做图**。
3. 插件 handler **不得把 body/prompt/comment 写进 `ctx.logger`/console/异常 message**；异常只回 code（伪代码已如此）。
4. 插件侧限流/预算（每分钟 N 次、每小时 M 次），防止任何本机进程借 token 刷用户额度。
5. 桌宠侧发前**行级脱敏**（复用 W-C 的 `redactObservationText`），且 content-tier 默认关闭，先上 metadata-only 评论（见 A.6）。
6. 请求/响应都带 `schemaVersion`；桌宠 0 信任解析能力文件（同桥的 `parseDshBridge*` 风格，`bridge-schema.ts:525-650`）。

## A.4 模型/费用/可用性

| 项 | 结论 | 证据 |
|---|---|---|
| 本机默认可用模型 | `provider: deepseek-account`，`model: deepseek-flash`（profile `agent-default-model` row；`deepseek-flash` 是 catalog 里 text+image 的默认项） | `$DSH_HOME/profiles/desktop/cordis.patch.yml`（只读）；`dsh-llm-deepseek/README.md:48-53` |
| 不硬编码路由 | 用户可能用 `deepseek-official`（api-key）或 pi-ai 自定义 route → 插件 config 暴露 `provider/model`，桌宠能力文件回传实际值；插件 apply 时 `ctx.llm.listProviders()` 校验，失败则能力文件 `enabled:false` | `dsh-llm/README.md`（listProviders / listModels） |
| 成本粗估（纯文本） | system+few-shot ≈60–120 tokens；OCR 正文截断 ≤1200 字符（中文≈600–900 tokens）；输出 ≤120 tokens；reasoningEffort=off 时无思考 token → **单次 ≈0.8–1.2k tokens**。若沿用 profile 的 `effort=max`，thinking token 可能 5–20×，**必须在调用里显式 `reasoningEffort:'off'`（或 low）**，不能继承 agent 默认 | 字段见 A.1.1；`dsh-llm-deepseek/README.md:103`（off→thinking disabled） |
| 费率 | DSH 不暴露定价，无法在插件内计费；桌宠侧用 `usage` chunk（`chunk.type==='usage'`）与调用次数做**预算面板**（次数/输入输出 token 统计），金额由用户按自己的套餐换算 | 前置审计 §2.2（usage chunk）；`dsh-llm-deepseek/README.md:177`（image pricing 不涉及纯文本） |
| 频率/限流 | 服务端能力未知（`RATE_LIMIT`/`QUOTA`/`ACCOUNT_QUOTA` 是稳定 code）；桌宠侧按豆包 §4.2 预算：评论 ≤3 次/小时、最小间隔 10min、专注/通话/全屏硬闸门 | `dsh-llm/README.md`（failure codes） |
| 隐藏重试 | **无**（`ctx.llm.stream` 单次尝试；retry 在 agent loop） | `dsh-llm/README.md`「This service never re-runs a request」 |
| 离线/未登录 | `TRANSPORT` / `MISSING_CREDENTIAL` / `AUTH` → 桌宠静默降级（不弹窗），状态面板显示原因码 | 同上 |

**降级阶梯（主进程状态机，建议实现为纯函数便于测试）**：

```
L0 commenter 能力文件缺失/过期        → disabled(reason=no-commenter)，零调用
L1 HTTP 401/403                        → disabled(reason=token/denied)，重新读能力文件（token 轮换）
L2 连接失败/503                        → backoff(10min)，菜单显示「DSH 未运行/插件未装」
L3 模型错误码                          → 按 code 映射（RATE_LIMIT/QUOTA → 冷却 10min；TRANSPORT → 3 次退避）
L4 超时                                → 丢弃本次，不重试（避免费用/延迟翻倍）
L5 出口过滤失败 / SKIP                  → 静默（或官方台词池兜底，见 A.5）
L6 评论成功                            → 显示「DSH 评论」气泡；`source:'dsh-model'`，不进长期记忆
```

## A.5 台词硬约束评估与设计建议

**现有硬约束（confirmed）**：宠物台词单一来源 = `src/renderer/src/core/voicelines.ts` 的 **111 条官方语音原文**（`:1-33` 文件头明确「禁止自创/改写/扩写」）；全表 SHA-256 锁 `OFFICIAL_LINE_SHA256`（`:176-177`）；测试锚点 `tests/voicelines.test.ts:140-143,175`（架构复核 M4 已核）。`src/shared/peek.ts:215-233` 的 payload 也规定 `text`/`vision` **只在主进程内存、不过 IPC、不进日志**（`docs/peek-interface.md:88-90`）。

**模型生成评论 = 新增文本来源**，与上述约束冲突的三种处理形态：

| 形态 | 描述 | 与硬约束关系 | 建议 |
|---|---|---|---|
| **A1（推荐，默认关闭的实验）** | 评论作为独立文本类别「**DSH 评论**」：不进入 `voicelines.ts`、不参与 SHA-256 锁和官方池测试；UI 明确标注来源（气泡角标/不同气泡样式/「DSH」前缀）；默认关闭；长度 ≤40 汉字；出口过滤；仅当用户显式开启 | 不改官方台词池 → SHA 锁测试不动；但引入新的角色外文本，需 Lead + 用户在 `docs/` 记录该决策（类似「思考中…」先例：非角色台词的 UI 文本，`docs/research/wave3-project-audit-2026-11-11.md:310,630`） | 可作为 W-B2 落地形态 |
| **A2（最保守，零新文本）** | 模型**只输出场景/情绪标签**（如 `WORK_LONG`/`GAME_WIN`/`AWAY_BACK`/`FOCUS_DONE`），文本仍从官方池按分类取（`voicelines.ts:193-237` 场景映射） | **完全满足硬约束**（无自创文本；模型只做分类，不做措辞） | 若用户/Lead 不愿开新文本源，落这个 |
| **A3（需用户明确授权）** | 自由生成「砂金语气」评论并入角色文本体系（更新 voicelines 约束文档、扩池或 relax 测试） | 直接改变「禁止自创/改写/扩写」红线，必须用户书面决策 | 不建议本轮做；若用户坚持，需更新 `docs/` 约束与 `tests/voicelines.test.ts` 口径 |

**出口过滤规则（A1 必须实现，主进程后、显示前）**：

1. 长度 ≤40 个汉字（或 ≤120 UTF-8 字节），超长截断/丢弃。
2. 禁止第一人称/接触式措辞：`我看到|你的屏幕上|你正在输入|正在看|屏幕里`（沿用豆包/架构复核的模糊表述原则：`这会儿…`/`你好像…`）。
3. **禁止复述屏幕原文**：与本次 OCR 文本做**最长公共子串检测**，连续 ≥8 个字符重叠 → 丢弃（评论是「旁白」不是「复读」）。
4. 禁止数字串（≥11 连续数字）、邮箱、URL、文件路径、代码样式（`{…}`/`=>`/`function`）。
5. 禁止官方台词原文片段：与 `OFFICIAL_VOICE_LINES` 全文做 ≥8 字连续匹配 → 丢弃（防止模型复读/改写官方语音）。
6. 命中 `SKIP`/空/含系统提示泄漏（如「作为 AI」）→ 静默。
7. 失败处理：静默优先；可选「offical 池兜底」——过滤失败时改发一条官方台词（不越过硬约束）。

**风险**：
- 模型可能输出「砂金语气」→ 看似官方台词改写 → 出口过滤器第 5 条兜底；system prompt 明令「不要模仿/引用角色语音台词」。
- 评论是**新增文本事实来源**：UI 不标注会被误认为官方台词 → 必须标注「DSH 评论」；并进入记忆边界（`source:'dsh-model'` / `memoryEligible:false`，扩展豆包 §4.6）。
- 官方台词池的 SHA 测试不受影响（新文本不进 `voicelines.ts`），但产品语义上「宠物说的话」边界变了 → 需 Lead 在文档中记录该决策，避免后续 review 再判违规。

## A.6 分期与对豆包报告 §4.7 / §6 / §8 的修正

### A.6.1 修正条目

| # | 豆包报告位置 | 修正 |
|---|---|---|
| A-1 | §4.7 表（L436-455） | 新增两行：DSH 侧 `bridge/dsh-aventurine-commenter/`（独立 bundle，A.2.3）；桌宠侧 `src/{shared/commenter-schema.ts, main/desktop/dsh-commenter.ts, main/peek/comment-orchestrator.ts, main/ipc/screen-comment.ts, renderer/src/reactions/peek-comment.ts}` + 扁平 config 键 |
| A-2 | §4.7「与 DSH 的联动」（L426） | 从「只做表情反应」升级为「**借 DSH 模型生成评论文本**」（用户 2026-11-11 决策）；但评论**不是**官方台词，需按 A.5-A1 建模 |
| A-3 | §4.3 不变量 4「内存态、不落盘」 | 评论链路必须显式满足：不带图/不用 attachments/不传 sessionId/插件不记 body；OCR 文本仍是唯一出网内容（用户同意 + 行级脱敏）|
| A-4 | §4.3 不变量 6「出口前脱敏」与「输出过滤器」 | 豆包原「SKIP/敏感词/复述」链路**重新成立**，但作用对象改为**模型评论**（A.5 七条规则），不是官方台词 |
| A-5 | §4.6 记忆与上下文边界 | 评论句打 `source:'dsh-model'`，`memoryEligible:false`，不进入对话历史/长期记忆；「你刚才看到什么」仍只答元数据 |
| A-6 | §6 分期 | 新增 **W-B2（DSH 评论链路，建议 2–3 人日）**：B2a metadata-only 评论（零 OCR、零新 TCC，可先上）；B2b content 评论（依赖 W-C 的 OCR 脱敏）。**原 W-D（VLM）可降级/取消**——用户已选择「借 DSH 模型生成评论」替代自建 VLM；W-C 仍是内容级前置 |
| A-7 | §6 W-C | 若只做 B2a（metadata-only），**不需要录屏权限**（评论基于 app 类别/时长/状态），可把内容级 TCC 决策后移；这与用户「只交付设计」一致 |
| A-8 | §8 证据清单 | 追加 DSH 侧证据：`dsh-llm/lib/typert.host.js:355,360,552`（GenerateOptions/FinishReason/RequestUserInput）；`dsh-base/cordis.patch.yml:35,43-44,85-86,202-203,218-219`；`dsh-llm/README.md`（Failures）；`dsh-session-log-deepseek/README.md`（无 session 省略上传）；`dsh-session-telemetry-otel/README.md`（FEEDBACK_ONLY）；`dsh-host-webserver/README.md:39,63,132`（getOrigin/route/无全局认证）；`dsh-host-open-in-app/lib/types/index.js:147-160`（route 形状实例）；`dsh-compaction-basic/lib/index.js:289-335,801-805`（直调范例）；`dsh-llm-deepseek/README.md:103,111,119,160`；`src/shared/peek.ts:215-233`；`src/renderer/src/core/voicelines.ts:1-33,176-177`；`tests/voicelines.test.ts:140-143,175` |

### A.6.2 推荐落地顺序

1. **W-B2a（零内容、零新权限）**：DSH commenter bundle（HTTP 路由 + `ctx.llm.stream`）+ 桌宠 client/IPC/气泡（A1 形态）+ 出口过滤 + metadata-only prompt（app 类别/时长/切换频率，不经 OCR）。验收：无录屏权限、DSH 离线时零调用、评论 ≤40 字且过滤 fixture 全绿。
2. **W-B2b（内容级，随 W-C）**：接入 OCR 脱敏文本 → 同一链路；用户 consent sheet 明示「脱敏文本会发送给 DeepSeek 用于生成评论」；content-tier 默认关。
3. **W-D（原 VLM）**：标记为「被 A1/B2 替代，暂不排期」；仅保留 §3.4 的 DSH 图片输入能力作为未来可选。

### A.6.3 未验证项（`unverified`，需真机/临时 profile 验证）

- `ctx.webServer.register` 在 **desktop profile 宿主进程**中的可用性（机制上 base 挂载 webserver；本次未在临时 profile 实测自定义路由）。
- `reasoningEffort:'off'` 对 `deepseek-account` + `deepseek-flash` 的实际接受（catalog 能力声明支持；未实测）。
- account route 在插件直调（无 sessionId）时是否要求额外客户端元数据（`deepseek-account` 有 client identity 概念，插件调用可能被拒/降级 → 先在临时 profile 用 mock 或真实短请求验证）。
- 出口过滤与模型实际输出分布（需 A/B 采样 50–100 条评论校准阈值）。
- 插件直调是否计入用户可见用量/账单面板（`ACCOUNT_QUOTA` 语义未实测）。
- 验证方法（隔离）：临时 `DSH_HOME` + `web` profile + 绝对路径 insert commenter 插件 + 本地回环 HTTP 调用 + 无网络 mock（沿用前置审计附录 A 的安全实验法），**不得**在真实 desktop profile 上装。

## A.7 一句话结论

**「借 DSH 模型生成屏幕评论」有条件可行：技术上插件可 `inject:['llm','webServer']`、用 `ctx.llm.stream`（无 sessionId、纯文本、无附件、单次不重试）生成评论，经本机 loopback HTTP（自建 token/限流/超时）回传桌宠；隐私上纯文本直调不落 session/JSONL/OTel，唯一出网内容是脱敏后的 OCR 文本；唯一需要 Lead/用户拍板的是「模型评论是否算新增文本来源」——建议按「DSH 评论」独立类别落地（不进官方台词池/SHA 锁、UI 标注、默认关闭、七条出口过滤），或用 A2「模型只选场景、文本仍取官方池」的零新文本形态；对现有桥 v4 compat/canary 零影响，前提是 commenter 做成独立 bundle。**
