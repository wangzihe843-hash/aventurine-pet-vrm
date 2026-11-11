# 修复报告：DSH × 桌宠强耦合的版本更新兼容性安全（v2）

> 日期：2026-11-11 · 用户目标：**保留"DSH 启动→桌宠启动、DSH 退出→桌宠退出"的默认强耦合**，
> 同时**保证将来某次版本更新出现兼容问题时，DSH 本体一定能打开来修桌宠**。
> 关联：[豆包调查](research/pet-coupling-compat-investigation-2026-11-11.md)、
> [Lead 评估（错误/疏漏清单）](research/pet-coupling-compat-plan-review-2026-11-11.md)、
> [修正计划](pet-dsh-coupling-safety-plan-2026-11-11.md)、
> [独立验收报告](pet-dsh-coupling-verification-2026-11-11.md)、
> [运行手册](pet-dsh-coupling-runbook.md)。
>
> 状态：**实现 + 隔离验证完成（PASS）**；真实 `~/.dsh` 部署**未执行**（安全约束，步骤见 §6）。

## 0. TL;DR

| 项 | 结论 |
|---|---|
| 豆包计划 | 方向正确（握手 + DEGRADED），但含 **1 个过时事实、1 个让版本闸门在真实安装形态下失效的漏洞、4 处与"保留同生共死"冲突的语义、11 处实现/验收疏漏**（详见评估文档） |
| 已实现 | 桥 v4 兼容自述 + 防孤儿抛错；激活/安装加固（live 副本带 `engines.dsh`、`install.json`、严格 YAML、定向 `--remove/--replace`）；桌宠握手四门槛 + `UNPAIRED`/`DEGRADED` + 安全模式 + 版本/兼容判定 + 主进程提示；canary `--compat` C1–C6；E2E A–F |
| 默认语义 | 健康时**与旧行为一致**：DSH→桌宠拉起、DSH 显式退出→桌宠跟随、崩溃→重启≤2、PAIRED 下桌宠退出→SIGTERM DSH |
| 降级语义 | 不兼容/不可验证/桥丢失/拉不起来/崩溃恢复失败 → `DEGRADED`：**不拉起、不重启、不 SIGTERM、不再自杀**；DSH 消失则单向跟随退出（`dsh-degraded`）；握手恢复自动回 `PAIRED` |
| 逃生阀 | `PET_DSH_COUPLING_DISABLE=1` / `~/.dsh/aventurine-pet/safe-mode` 文件 / 配置 `dshCoupling:false`；三段式保持"DSH 永远能打开" |
| 验证 | 单测 408（主力）+ 217（回归）；typecheck:node 通过；canary C1–C6 PASS；**独立 verifier PASS with issues（0 FAIL）**；**E2E A–F 62/62 PASS**（隔离，真实 DSH pid/profile/桥文件前后不变） |
| 未验证 | 真实桌面 profile 的 v4 激活+HMR 部署（需在空闲时刻执行，见 §6）；安装脚本真实写盘路径（dry-run+canary 形态等价覆盖） |

## 1. 背景：用户担心什么

"DSH 与桌宠同生共死"意味着桌宠退出会杀 DSH、DSH 起不来会级联退出桌宠。若未来某次 DSH
更新导致桥/桌宠不兼容，用户担心**两个都打不开**，从而失去"打开 DSH 修桌宠"的通道。
本轮把保障目标拆成三层：

1. **宿主侧不因插件而打不开**：DSH 对 import/apply 失败有隔离；唯一能打死宿主的是
   异步孤儿抛错与坏 YAML → 桥必须杜绝前者、安装脚本必须杜绝后者；
2. **不兼容时桌宠不再加害 DSH**：不重启、不 SIGTERM、不因"DSH 起不来"而自杀；
3. **不兼容可被看见、可被修复**：运行时 compat + 安装清单 + 桥诊断 + 主进程告警 + runbook。

## 2. 对豆包计划的修正（摘要，详见评估文档）

| 编号 | 豆包计划的问题 | 本轮修正 |
|---|---|---|
| E1 | 断言"桥未安装/闸门会兜底"——实际 12:33 桥已安装，且 live 副本 `package.json` 无 `engines.dsh`，**真实形态下 DSH 版本闸门根本不生效** | 激活脚本复制 `engines.dsh` 进 live 副本；canary 用真实安装形态（绝对路径 insert）验证闸门 |
| E2 | `DEGRADED` 下"不因 DSH 退出而 cascade"与用户保留语义冲突 | 保留**单向安全跟随退出**（进程消失→桌宠退出，不重启不发信号） |
| E3/E4 | `UNPAIRED` 无退出语义/无超时；只看 control 帧不看心跳新鲜度 | 四门槛 + 20s UNPAIRED 超时 + 陈旧帧不得 PAIRED |
| E5 | 未考虑现网 v3 桥向后兼容 | v3 legacy 回退 `BRIDGE_LEGACY_DSH_RANGE`（现网桌宠更新后可继续 PAIRED） |
| E6 | 桥被闸门禁用时 compat 块不可达、无解释通道 | 激活脚本写 `install.json`；桥 apply 失败写 `bridge-error.json`；告警带原因码 |
| E7/E13 | 版本比较未定义 prerelease/失效语法；canary 只测 bundle 安装形态 | 实现与 DSH 闸门同语义的 SemVer 子集（含 `includePrerelease`）；D1 收口后桥范围限定裸比较符；canary C1–C6 |
| E8/E11 | 提示含 renderer banner（与模型侧会话冲突）；无文件级逃生阀 | 纯主进程 dialog+Notification+log；新增 safe-mode 文件 |
| E9/E14 | 安装脚本 YAML 校验可降级、只能整份回滚；恢复对话框会清掉整份 patch | PyYAML fail-closed、定向 `--remove/--replace`、激活后 control 验证、runbook 优先定向移除 |
| E10 | 未把"禁止异步孤儿抛错"落实为约束与测试 | 桥 `apply` 外层兜底 + 全路径 try/catch + 投毒测试 + 维护规则 |
| E15/E16 | PAIRED 后桥长期丢失无降级出口；崩溃重启用尽仍 cascade 自杀 | bridge-lost→DEGRADED；崩溃重启用尽→DEGRADED 常驻（不再自杀） |

## 3. 实现概览

### 3.1 共享契约层（Lead）

| 文件 | 内容 |
|---|---|
| `src/shared/semver-range.ts`（新） | 环境中立 SemVer 子集（对齐 DSH 闸门的 `includePrerelease` 语义；解析失败→`null`=不可验证） |
| `src/shared/bridge-schema.ts` | `BRIDGE_PLUGIN_VERSION=4`、`BRIDGE_PLUGIN_MIN_SUPPORTED=3`、`BRIDGE_LEGACY_DSH_RANGE`、`install.json`/`bridge-error.json` 契约（类型+解析器）、control/status 可选 `compat`（非法→整帧无效） |
| `tests/semver-range.test.ts` / `tests/bridge-schema-compat.test.ts` | 83 + 13 用例（含 DSH 闸门实况范围、prerelease 边界、非法输入） |

### 3.2 桥 v4（`bridge/dsh-aventurine-bridge/**`）

- `BRIDGE_PLUGIN_VERSION=4`、package version 0.2.0；
- `control.json`/`status.json` **每帧**带 `compat: { bridgeVersion, controlSchema, dshRange }`，
  `dshRange` 运行时读相邻 `package.json.engines.dsh`（与 DSH 闸门同源，读不到→null 不猜）；
- `apply` = `startBridge()` + 外层兜底：任何启动失败写 `bridge-error.json` +
  warn + 返回 no-op disposer，**绝不 throw 给宿主**；成功 apply 清理旧诊断；
- 心跳/事件/写盘/disposer 全路径 try/catch，无异步孤儿抛错、模块顶层零 IO；
- README 记录 v4 契约、legacy 兼容、`engines.dsh` 裸比较符规则（D1）、排障入口。

### 3.3 安装/激活加固（`scripts/**`）

- `activate-dsh-bridge.mjs`（重写加固）：live 副本复制 `name/version/engines/type/main`
  （**engines 缺失即错**）；写 `install.json`（原子 0600，形状按共享契约）；
  PyYAML 严格校验 fail-closed（`--skip-yaml-check` 才降级）；新增 `--remove`/`--replace`
  （定向删桥块、保留固定端口等其它 patch，幂等）；`--rollback` 保留；激活前 DSH 版本预检警告；
  DSH 在跑时轮询 control 验 attached/`bridgeVersion=4`/`compat.dshRange`；
- `dsh-patch-lib.mjs`（新）：patch 块定位/定向 strip/append/结构自检（26 用例）；
- `dsh-canary.mjs` 新增 `--compat`/`--only-compat`：C1 bundle 安装被拒；C2 真实形态（绝对路径
  insert + 不兼容 engines）→ 宿主仍启动、stderr 有 disable 行、桥零产物；C3 同形态兼容 →
  attached+bridgeVersion=4+compat；C4 import 抛错；C5 apply 抛错；C6 桥 apply 失败 →
  `bridge-error.json`、宿主无感。

### 3.4 桌宠侧（`src/main/**`）

- `dsh-version.ts`（新）：DSH 版本探测器（`PET_DSH_APP_PATH`→`/Applications`→`lsappinfo`→
  `mdfind`；XML/二进制 plist；60s 缓存；失败 null 不抛）；
- `dsh-compat.ts`（新）：纯函数兼容判定（ok/incompatible/unverified + code/detail；
  runtime compat > 安装清单兜底 > v3 legacy 回退；不可验证不猜兼容）；
- `dsh-bridge-state.ts`（新）：读 `install.json`/`bridge-error.json`（mtime 缓存/上限/不抛）；
- `dsh-lifecycle.ts`（850→1435 行）：新增 `UNPAIRED`/`DEGRADED`/`dsh-degraded`；
  **PAIRED 四门槛**（进程 + status.online + control attached + compat ok/legacy）；
  陈旧帧不得 PAIRED；STARTING 180s 拉不起来→DEGRADED；UNPAIRED 20s 超时→DEGRADED；
  compat 不兼容立即 DEGRADED；PAIRED 心跳丢失 30s→DEGRADED；崩溃重启用尽→DEGRADED（不自杀）；
  DEGRADED 不 launch/restart/terminate、握手恢复自动回 PAIRED；
  **before-quit 只在 PAIRED 才 SIGTERM DSH**；safe-mode 每 tick 热检查；告警进入/恢复各一次；
- `ipc/dsh.ts`：版本探测器/桥状态/安全模式/告警接线（modal 同原因每 app 运行一次 +
  Notification + main.log；`PET_DSH_COUPLING_SILENT_ALERTS=1` 静默；文案含原因码/DSH 版本/
  桥范围/"DSH 本体不受影响 + runbook"）；不新增 IPC channel、不改 `src/main/index.ts`。

### 3.5 语义矩阵（最终实现）

| 场景 | 行为 |
|---|---|
| 健康（四门槛全满足） | `PAIRED`；DSH 显式退出→桌宠跟随（`dsh-exit`，不重启）；崩溃→重启≤2；桌宠退出→SIGTERM DSH |
| DSH 运行但桥不健康（禁用/未装/装坏/旧帧） | `UNPAIRED` 20s → `DEGRADED`（不重启/不杀；跟随 DSH 退出 `dsh-degraded`） |
| compat 明确不兼容（DSH 版本不在桥范围 / 桥版本/schema 不匹配） | 立即 `DEGRADED(compat-incompatible)`，0 次 launch/terminate |
| DSH 版本或范围不可验证 | 不猜兼容：超时 `DEGRADED(compat-unverified)` |
| v3 legacy 桥（无 compat） | 用 `>=0.2.2-rc.1 <0.3.0` 回退判定（现网更新桌宠后可直接 PAIRED） |
| 崩溃重启 ≤2 次仍失败 | `DEGRADED(crash-recovery-failed)` **常驻不自杀**；用户修好 DSH 后自动回 PAIRED |
| 桌宠拉不起 DSH 180s | `DEGRADED(startup-failed)` 常驻；用户手动打开 DSH 后自动回 PAIRED |
| `DEGRADED` 下 DSH 进程消失 | 进入降级时 DSH 在运行 → 跟随退出 `dsh-degraded`（不重启不发信号）；进入时本就不在运行 → 常驻等待 |
| `DEGRADED`/`UNPAIRED` 下桌宠退出 | 放行，**不杀 DSH** |
| safe-mode 文件 / disable env / config off | `DISABLED`：不拉起/不重启/不杀/不跟随；每 3s 重查可热生效恢复 |

## 4. 验证证据

### 4.1 自动化（Lead + 独立 verifier 均复跑）

| 项 | 结果 |
|---|---|
| 主力 10 文件 vitest | **10 files / 408 passed** |
| 既有 DSH/桥回归 4 文件 | **4 files / 108 passed** |
| 扩回归（dsh-dialogue/reactions/work-fidget/desktop-* 等） | 217 passed |
| `pnpm typecheck:node` | exit 0 |
| `node scripts/dsh-canary.mjs --compat` | **PASS，C1–C6 全 PASS**（C3 实测 attached+bridgeVersion=4+compat；C6 bridge-error.json） |
| `node scripts/dsh-canary.mjs`（既有契约） | PASS 无回归 |
| verifier 独立对抗 | **19/19 PASS**（含陈旧帧不误 PAIRED、compat 不兼容立即降级、v3 legacy 双向、崩溃重启用尽不退出、degradedSawRunning 语义、safe-mode、告警去重、SILENT） |
| 桥 apply 探针 / 安装脚本探针 | 14/14、17/17 PASS |
| **coupling E2E（A–F）** | **62/62 断言 PASS**；真实 DSH pid、真实 desktop profile sha256、真实桥 `control.json`/文件集合前后不变、`open -b com.deepseek.dsh` 未被调用 |

### 4.2 独立验收

`docs/pet-dsh-coupling-verification-2026-11-11.md`：**PASS with issues，0 FAIL**。唯一契约
偏差 D1（桌宠 semver caret 语义与 DSH 内嵌 7.8.6 有差异）已在本轮收口：
**桥 `engines.dsh` 契约限定为裸比较符**（由 `tests/bridge-plugin.test.ts` 守卫），不依赖
caret/tilde 语义；其余为文案级 nit 已修。

## 5. 已知限制 / 剩余风险

1. **未部署到真实环境**：本轮**没有**修改真实 `~/.dsh`、没有激活 v4 桥、没有重建 `dist`。
   现网仍是 v3 桥（无 compat）→ 新版桌宠经 legacy 回退可正常工作；但**版本闸门要等重新激活
   v4 桥后才对未来 DSH 升级生效**（部署步骤见 §6）。
2. **部署前窗口的残余风险**：现网已装 v3 桥没有 `engines.dsh`，若 DSH 在下一次激活前就大版本
   升级，旧桥仍会被加载。桥代码本身已高度防御（fs/事件全 try/catch），但理论上仍存在异步
   孤儿抛错打死宿主的可能（豆包实测唯一能打死宿主的行为）。**建议尽快完成 §6 部署**。
3. **"DSH 启动→桌宠启动"在桥被闸门禁用时会断**（评审 E12）：这是已知限制，手动打开桌宠即可，
   桌宠自己会走握手/降级逻辑并提示；不引入 LaunchAgent 等新常驻组件。
4. **PAIRED 心跳丢失→DEGRADED 的最坏时延约 60s**（status TTL 30s + 宽限 30s）。当前实现与计划
   "丢失后 30s 降级"字面一致；如需更短需调 watcher TTL。
5. **E2E G/H 未加**（DEGRADED 下桌宠退出不杀 DSH / 握手恢复自动 PAIRED）：已由单测 §7.3 #7/#8
   覆盖；E2E A–F 已实跑通过。
6. **安装脚本真实写盘路径**（live 副本 + `install.json` + HMR 验证）未在真实 profile 跑：
   已用临时 DSH_HOME 集成自测（`--dry-run` 零写入、`--replace` 幂等、`dsh --dump-config` 接受）
   + canary C2/C3 形态等价覆盖。
7. **DSH 桌面版"禁用第三方插件"恢复按钮会清整份 patch**（含 webserver 固定端口行）：
   runbook 首选 `--remove`/`--rollback` 定向恢复；若已用恢复按钮，从 `cordis.patch.yml.bak-*`
   挑回端口行。

## 6. 部署 / 上线（用户执行，必须在 DSH 无跑着的 Agent 会话的空闲时刻）

1. 确认模型侧会话已收口（`git status` 无在途 renderer 改动）后重建桌宠：
   `pnpm typecheck && pnpm package:dir`（或仅 `pnpm build` + 现有打包流程）；
2. 激活 v4 桥（会触发 HMR：旧桥 detached → 新桥 attached，**不要在有 Agent 会话运行时做**）：
   ```bash
   node scripts/activate-dsh-bridge.mjs --replace --pet-app "<桌宠.app 绝对路径>"
   # 脚本会：生成带 engines.dsh 的 live 副本、写 install.json、轮询 control.json 验证
   ```
3. 核对：`~/.dsh/aventurine-pet/control.json` 出现 `bridgeVersion:4` 与
   `compat.dshRange`；`install.json` 存在；桌宠进入 `PAIRED`；
4. 建议跑一次 `pnpm dsh:canary --compat` 与（可选）`node scripts/wave3-e2e/e2e-coupling.mjs`；
5. 回滚：`node scripts/activate-dsh-bridge.mjs --rollback`（整份备份）或 `--remove`（只移除桥行）；
   桌宠侧逃生阀：`touch ~/.dsh/aventurine-pet/safe-mode` 或 `PET_DSH_COUPLING_DISABLE=1`。

## 7. 文件清单（本轮新增/修改）

**契约层（Lead）**：`src/shared/semver-range.ts`、`src/shared/bridge-schema.ts`、
`tests/semver-range.test.ts`、`tests/bridge-schema-compat.test.ts`

**桥**：`bridge/dsh-aventurine-bridge/{lib/constants.js, lib/index.js, package.json, README.md}`、
`tests/bridge-plugin.test.ts`

**安装/加固**：`scripts/activate-dsh-bridge.mjs`、`scripts/dsh-patch-lib.mjs`、
`scripts/dsh-canary.mjs`、`scripts/dsh-canary-lib.mjs`、`tests/dsh-patch-lib.test.ts`、
`tests/dsh-canary-lib.test.ts`

**桌宠**：`src/main/desktop/{dsh-lifecycle.ts, dsh-version.ts, dsh-compat.ts, dsh-bridge-state.ts}`、
`src/main/ipc/dsh.ts`、`tests/{dsh-lifecycle.test.ts, dsh-ipc.test.ts, dsh-version.test.ts,
dsh-compat.test.ts, dsh-bridge-state.test.ts}`

**E2E**：`scripts/wave3-e2e/lib.mjs`、`scripts/wave3-e2e/e2e-coupling.mjs`

**文档**：本报告、`docs/pet-dsh-coupling-safety-plan-2026-11-11.md`、
`docs/pet-dsh-coupling-runbook.md`、`docs/pet-dsh-coupling-verification-2026-11-11.md`、
`docs/research/pet-coupling-compat-plan-review-2026-11-11.md`

**未触碰**：`src/renderer/**`（模型侧会话在改）、`~/.dsh` 真实 profile/桥目录、DSH 安装目录、
真实进程（E2E 隔离自证通过）。
