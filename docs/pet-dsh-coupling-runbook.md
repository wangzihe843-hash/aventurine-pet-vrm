# 桌宠 × DSH 强耦合：运行手册（故障检测 / 恢复 / 部署 / 回滚）

> 日期：2026-11-11 · 适用：`aventurine-pet` 仓 + DeepSeek Harness 桌面版（当前 0.2.2-rc.1）
> 关联设计：[pet-dsh-coupling-safety-plan-2026-11-11.md](pet-dsh-coupling-safety-plan-2026-11-11.md)、
> 复核：[research/pet-coupling-compat-plan-review-2026-11-11.md](research/pet-coupling-compat-plan-review-2026-11-11.md)
>
> **一句话原则**：桌宠可以坏、可以降级，**但 DSH 本体必须永远能打开**。
> 本手册的第一优先级不是"把桌宠修好"，而是"先保证你能打开 DSH 去修桌宠"。

## 0. 先记住三个逃生阀（按优先级从高到低）

| 逃生阀 | 操作 | 效果 |
|---|---|---|
| `PET_DSH_COUPLING_DISABLE=1` 环境变量 | 启动 DSH/桌宠前导出（或写进 shell 配置） | 耦合完全关闭：不拉起、不重启、不杀 DSH、不跟随退出 |
| 安全模式文件 | `mkdir -p ~/.dsh/aventurine-pet && touch ~/.dsh/aventurine-pet/safe-mode` | 等价于关闭耦合（优先级高于 config，低于环境变量）；每 3s 复查，**可热生效/热失效** |
| 配置开关 `dshCoupling` | 桌宠设置页 | 常规关闭方式（但桌宠打不开时够不到，所以排最后） |

> 桌宠打不开 / 行为失控 / 反复杀 DSH 时：**先执行前两条中的任意一条**，DSH 就安全了，再慢慢修。

## 1. 兼容性三层信号（排查时按这个顺序看）

1. **运行时信号（最可信）**：`~/.dsh/aventurine-pet/control.json` + `status.json`
   - v4 桥每帧带 `compat: { bridgeVersion, controlSchema, dshRange }`；
   - `dshRange` 来自桥自己 `package.json` 的 `engines.dsh`；v3 旧桥没有 `compat`（走
     legacy 回退范围 `>=0.2.2-rc.1 <0.3.0`）。
2. **安装信号**：`~/.dsh/aventurine-pet/install.json`（激活脚本写；**桥被 DSH 版本闸门静默禁用时
   这是唯一能解释"为什么桥没加载"的证据**）
   - 关键字段：`bridgeVersion`、`controlSchema`、`dshRange`、`dshVersionAtInstall`、
     `bridgeEntry`、`installedAt`；
   - 注意：清单存在 ≠ 桥已加载。它只是"装了什么、当时 DSH 是什么版本"的静态证据。
3. **宿主信号**：DSH app `Info.plist` 的 `CFBundleShortVersionString`
   （或 `PET_DSH_APP_PATH` 指向的 app）；被比较的 DSH 版本。

配套诊断文件：`~/.dsh/aventurine-pet/bridge-error.json`（桥 `apply` 失败时写，
`phase` 一般为 `apply`，含 `message/bridgeVersion/dshRange`）。

## 2. `DEGRADED` 是什么意思（桌宠侧）

桌宠状态机新增 `UNPAIRED` / `DEGRADED` 两态（详见计划 §2.2）。`DEGRADED` 的含义是：

> **桌宠已确认"联动不健康"，于是主动放弃一切危险动作，但继续活着等恢复。**
> DSH 本体不受影响，可以正常打开/关闭/使用。

`DEGRADED` 下**禁止**：拉起 DSH、重启 DSH、`SIGTERM`/`SIGKILL` DSH、因 DSH 退出而重启 DSH。
`DEGRADED` 下**允许**：跟随 DSH 显式/崩溃退出（退出原因 `dsh-degraded`，不重启、不发信号）、
每 3s 重试握手、握手恢复后自动回 `PAIRED`。

常见原因码（桌宠告警/日志里会写）：

| 原因码 | 含义 | 先做什么 |
|---|---|---|
| `compat-incompatible` | DSH 版本不在桥声明范围内（或 bridgeVersion/schema 不兼容） | 升级桥（重新激活带新 `engines.dsh` 的 live 副本）或升级 DSH；见 §4.A2/A3 |
| `compat-unverified` | 读不到 DSH 版本 / 范围无法解析 | 看 `PET_DSH_APP_PATH`、`install.json`、`control.json`；见 §4.A2 |
| `bridge-not-loaded`（`UNPAIRED` 超时） | DSH 在跑但桥没有 attached（被禁用/加载失败/没装） | 看 `bridge-error.json`、DSH stderr；见 §4.A2 |
| `bridge-lost`（PAIRED 后心跳丢失 >30s） | 桥被 HMR 卸载后没回来 / 被禁用 | 重新激活桥；见 §4.A2 |
| `startup-failed` | 桌宠拉不起 DSH（约 180s 仍失败） | 手动打开 DSH 看 crash log；见 §4.B |
| `crash-recovery-failed` | DSH 崩溃重启 ≤2 次仍失败 | 手动打开 DSH 修；见 §4.B |

> "DSH 启动 → 桌宠启动"这条链路是桥 `launchPet` 实现的；桥被闸门禁用时该链路必然断（评审 E12）。
> 这不是故障，是降级期已知限制：手动打开桌宠即可，桌宠自己会走握手/`DEGRADED` 逻辑。

## 3. 检测阶梯（从便宜到贵）

```bash
# ① 桌宠侧信号
cat ~/.dsh/aventurine-pet/control.json     # 最近一帧：attached/detached、bridgeVersion、compat
cat ~/.dsh/aventurine-pet/status.json      # 心跳：offline/running/agents、compat
cat ~/.dsh/aventurine-pet/install.json     # 安装清单（桥被禁用时的解释权）
cat ~/.dsh/aventurine-pet/bridge-error.json 2>/dev/null   # 桥 apply 失败诊断

# ② DSH 版本 × 桥范围（静态判定）
plutil -extract CFBundleShortVersionString raw -o - \
  "/Applications/DeepSeek Harness.app/Contents/Info.plist"

# ③ 桥行是否还在 profile patch 里（只读）
grep -n "aventurine-bridge\|insert:" ~/.dsh/profiles/desktop/cordis.patch.yml

# ④ DSH 日志（stderr 文案是权威证据）
#    被版本闸门禁用：dsh: disabling profile plugin row "aventurine-bridge": … engines.dsh …
#    插件加载失败：  dsh: warning: 1 entry did not activate / failed to import / Error: …
#    桥 apply 失败：  [dsh-aventurine-bridge] …（bridge-error.json 才是结构化证据）

# ⑤ DSH 打不开时看崩溃日志
ls -lt ~/Library/Logs/DeepSeek\ Harness/crash-*.log | head
```

兼容性契约自检（隔离临时目录，**不会碰真实 `~/.dsh`**、不会拉起真实桌宠）：

```bash
# 既有事件/文本/control 契约（约 40s）
pnpm dsh:canary

# 追加 v4 兼容性/安装形态组（C1–C6：真实 insert + live 副本形态、版本闸门、桥 apply 失败隔离）
pnpm dsh:canary --compat          # 既有组 + compat 组（约 1.5–2 分钟）
pnpm dsh:canary --only-compat     # 只跑 C1–C6
```

`--compat` 全部在临时 `DSH_HOME`/临时桥目录/live 副本里跑，`AVENTURINE_BRIDGE_DISABLE_LAUNCH=1`
保证不会真的拉起桌宠。C1–C6 含义见 `scripts/dsh-canary.mjs` 头注释。

## 4. 恢复决策树

### A. DSH 能打开（最常见）

1. **先清桌宠侧危险动作**（如桌宠在反复折腾 DSH）：
   `touch ~/.dsh/aventurine-pet/safe-mode` 或 `export PET_DSH_COUPLING_DISABLE=1`。
2. **判断桥是否加载**：`control.json` 的 `action === 'attached'` 且 `compat` 存在且范围包含当前 DSH？
   - **是** → 联动链路基本健康；若桌宠仍异常，问题在桌宠侧（看桌宠 main.log / 安全模式先保 DSH）。
   - **否 / 文件缺失** → 进入 A2/A3。

**A2. 桥没加载（被禁用 / 加载失败 / HMR 未回来）**

```bash
# 1) 看 bridge-error.json 与 install.json 的 dshRange/dshVersionAtInstall
# 2) 若 install.json 的 dshRange 不含当前 DSH → 版本闸门禁用；重新激活（新桥/新范围）或移除
node scripts/activate-dsh-bridge.mjs --replace --pet-app "<桌宠.app 绝对路径>"
#    ↑ 会生成带 engines.dsh 的新 live 副本 + 写 install.json + 轮询 control.json 验证

# 备选：暂时不要联动，先把桥行整行拿掉（保留固定端口等其它自定义 patch）
node scripts/activate-dsh-bridge.mjs --remove
```

- `--replace` 输出里的「预检 WARNING：DSH 版本与桥 engines.dsh 不匹配」= 写入后 DSH 启动时仍会
  禁用该行（但 **DSH 能正常打开**，桌宠会 `DEGRADED`）。此时正解是**更新桥的 `engines.dsh`**
  （先跑 `--compat` canary 验证事件契约）后在空闲时 `--replace`。
- 只是 HMR 时机问题（刚激活 1–2s）：看脚本的「PASS 桥已 attached」或稍等再看 `control.json`。

**A3. `compat-incompatible`（版本/协议不兼容）**

- DSH 升级跨 minor（当前桥范围 `>=0.2.2-rc.1 <0.3.0`）：桥会被闸门禁用。
  - 首选：升级桥（更新 `bridge/dsh-aventurine-bridge/package.json` 的 `engines.dsh`）→
    `pnpm dsh:canary --compat` 全绿 → `--replace`；
  - 临时：`--remove` 拿掉桥行（DSH 照常可用，桌宠 `DEGRADED`/手动开）；
  - **不要**为了跑旧桥去 `dsh plugin allow-version … --accept-risk` 长期豁免（版本不兼容可能崩宿主）。
- 桌宠自身 bridgeVersion/schema 不兼容：更新桌宠（本仓构建）而不是改 DSH。

### B. DSH 打不开（最需要冷静的路径）

**第一步（可选但推荐）**：先关掉桌宠耦合，避免它继续拉起/杀 DSH：
`touch ~/.dsh/aventurine-pet/safe-mode`（或导出 `PET_DSH_COUPLING_DISABLE=1`）。

**第二步：判断是不是 profile patch 被写坏 / 桥行导致。**

```bash
# 看最近崩溃日志（DSH 桌面版的诊断报告）
ls -lt ~/Library/Logs/DeepSeek\ Harness/crash-*.log | head -3
tail -80 "$(ls -t ~/Library/Logs/DeepSeek\ Harness/crash-*.log | head -1)"

# 从命令行复现启动（能看到真实 stderr；只读，不写 profile）
DSH_HOME="$HOME/.dsh" "/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh" \
  --profile desktop --dump-config >/dev/null
# 若报 YAML 错误 → 多半是 cordis.patch.yml 被写坏
```

- **优先用定向移除，而不是 DSH 恢复对话框**：
  ```bash
  node scripts/activate-dsh-bridge.mjs --remove --dry-run   # 先看会删什么
  node scripts/activate-dsh-bridge.mjs --remove             # 只删桥 insert 块，保留固定端口等其它行
  ```
  若连激活脚本都跑不了（profile patch 语法已经坏到 PyYAML 解析失败），先手工把 patch 备份：
  `cp ~/.dsh/profiles/desktop/cordis.patch.yml ~/cordis.patch.yml.bad`，再用
  `node scripts/activate-dsh-bridge.mjs --rollback`（整份最近备份恢复）。
- **⚠️ 不要首选 DSH 启动失败对话框里的「禁用第三方插件 / 备份 profile patch 并重启」**：
  它会把整份 `cordis.patch.yml` 改名备份、bundles 还原成官方模板 —— 你自定义的
  **webserver 固定端口 38765** 等行会一起失效（端口变化还会影响 auth cookie / 431 问题，评审 E14）。
- **如果已经点了恢复对话框**：在 profile 目录找它留下的备份
  `~/.dsh/profiles/desktop/cordis.patch.yml.bak-<ts>`，把 `- id: webserver` 那段固定端口行
  手工挑回新的 patch；再按需 `--replace` 重装桥。

**第三步：修复后确认。**
```bash
# DSH 能启动后：重新激活桥（空闲时；见 §5 部署顺序）
node scripts/activate-dsh-bridge.mjs --replace --pet-app "<桌宠.app>"
# 或先不装桥，让 DSH/桌宠都可用（桌宠 DEGRADED；手动打开桌宠）
rm ~/.dsh/aventurine-pet/safe-mode   # 恢复耦合前确认 DSH 已稳定
```

### C. 桌宠打不开 / 行为失控，但 DSH 正常

1. `touch ~/.dsh/aventurine-pet/safe-mode`（或 `PET_DSH_COUPLING_DISABLE=1`）→ DSH 立即安全；
2. 手动结束异常桌宠进程（`pkill -f AventurinePet` 前确认路径），排查桌宠 main.log；
3. 修好后删除 `safe-mode`（每 3s 自动生效）或重启桌宠。

## 5. 部署顺序（重要，别在错误时间点点激活）

原则：**先有新桌宠产物，再激活桥；激活桥是唯一会动真实 `~/.dsh` 的步骤，必须在空闲时刻做。**

1. **等模型侧会话收口**：`git status` 里 `src/renderer/**` 无在途改动（本轮曾与另一会话并行）。
2. 构建桌宠（会跑 typecheck/web 构建，**不要在 DSH 里有 Agent 会话时**做大规模构建，
   避免资源争抢/误操作）：
   ```bash
   pnpm typecheck && pnpm package:dir
   # 产物：dist/mac-arm64/AventurinePet.app
   ```
3. **选一个没有正在跑 Agent 会话的空闲时刻**重新激活桥（v4 live 副本 + engines + install.json）：
   ```bash
   node scripts/activate-dsh-bridge.mjs --replace --dry-run --pet-app "$PWD/dist/mac-arm64/AventurinePet.app"
   node scripts/activate-dsh-bridge.mjs --replace --pet-app "$PWD/dist/mac-arm64/AventurinePet.app"
   ```
   - 激活会触发 HMR：旧桥 `detached`（桌宠会看到 detached grace）→ 新桥 `attached`；
   - **不要在正在跑 Agent 会话的 DSH 上做 HMR 激活**：会打断会话事件流、桌宠联动状态抖动；
   - 脚本会轮询 `control.json` ≤10s，输出 `PASS 桥已 attached（bridgeVersion=4，compat.dshRange=…）`
     或可操作诊断（见 §3）。
   - `--replace` 幂等，可重复执行；写前自动备份（`cordis.patch.yml.bak-wave3-<ts>`）。
4. 验证：新桌宠实机观察 `control.json` 的 `bridgeVersion=4` / `compat`；跑一次 `pnpm dsh:canary --compat`。
5. **本轮验收/自动化期间**（模板/CI/队友）：**绝不做非 dry-run 的
   activate/remove/replace/rollback**（真实 profile 只读检查允许）；需要试验时用 `--home` 指向临时
   `DSH_HOME` 副本。

## 6. 回滚 / 撤销

| 目标 | 命令 | 行为 |
|---|---|---|
| 只撤桥行（保留其它 patch） | `node scripts/activate-dsh-bridge.mjs --remove` | 定向删 `insert` 块 + 删 `install.json`；HMR 后桥 `detached` |
| 整份恢复最近备份 | `node scripts/activate-dsh-bridge.mjs --rollback` | 恢复 `cordis.patch.yml.bak-wave3-<ts>` + 删 `install.json`；若备份本身含桥行会提示再 `--remove` |
| 指定备份 | `node scripts/activate-dsh-bridge.mjs --rollback --backup <path>` | 同上；恢复前严格 YAML 校验，校验不过拒绝写入 |
| 只看不写 | 上述任意命令加 `--dry-run` | 只打印将做的变更，不写 profile/live 副本/install.json |

> 若因 DSH 恢复对话框导致固定端口行丢失，可参考 §4.B 从 `cordis.patch.yml.bak-<ts>` 挑回；
> 本脚本的备份是**整份文件**，保存的是操作前状态（含当时所有自定义行）。

## 7. 安全与协调约束（执行任何操作前读一遍）

- **不要**在 DSH 有正在跑 Agent 会话时做 HMR 激活/移除（打断会话、桌宠抖动）；
- **不要**直接编辑 `~/.dsh/profiles/desktop/cordis.patch.yml`：用 `--replace` / `--remove`；
- **YAML 校验 fail-closed**：PyYAML 不可用时激活默认拒绝写入（防止写入让 DSH 下次打不开的
  YAML）。装好 PyYAML（`python3 -m pip install --user pyyaml`）或明确使用 `--skip-yaml-check`
  承担风险（仅结构自检，发现不了缩进/流式语法错误）；
- live 副本必须带 `engines.dsh`（脚本已强制；缺失直接报错）——否则 DSH 版本闸门在真实安装
  形态下不生效（评审 E1）；
- `--replace` 会生成新的 `work/live-bridge/rev-<ts>/`（gitignored），保留最近 5 个；当前
  patch 引用的副本不会被删除；
- canary 全部隔离（临时 `DSH_HOME`/桥目录），不会写真实 `~/.dsh`；若它报「真实
  ~/.dsh/aventurine-pet 在 canary 期间发生变化」，通常是**真实 DSH 正在运行且旧桥在写心跳**，
  与 canary 无关；
- 本仓 `src/renderer/**` 曾由另一会话并行修改：任何会话都不得 `git checkout/stash/clean` 回滚它；
- 桥 v3（旧版，无 `compat`）仍可用：桌宠按 `BRIDGE_LEGACY_DSH_RANGE` 回退判定；但建议尽快
  `--replace` 到 v4（否则失去运行时范围自述，只能靠 `install.json` 静态判定）。

## 8. 相关文件/命令速查

```text
~/.dsh/profiles/<profile>/cordis.patch.yml            # DSH profile patch（桥 insert 行）
~/.dsh/profiles/<profile>/cordis.patch.yml.bak-wave3-<ts>  # 激活脚本备份
~/.dsh/aventurine-pet/control.json                    # 桥 attached/detached + compat
~/.dsh/aventurine-pet/status.json                     # 心跳（offline/running/agents + compat）
~/.dsh/aventurine-pet/install.json                    # 安装清单（激活脚本写）
~/.dsh/aventurine-pet/bridge-error.json               # 桥 apply 失败诊断（v4）
~/.dsh/aventurine-pet/safe-mode                       # 安全模式文件（存在=关闭耦合）
~/Library/Logs/DeepSeek Harness/crash-*.log           # DSH 启动崩溃诊断报告
work/live-bridge/rev-<ts>/                            # 桥 live 副本（package.json 带 engines.dsh）

node scripts/activate-dsh-bridge.mjs --help           # 激活/替换/移除/回滚 用法
pnpm dsh:canary --compat                              # 兼容性 + 安装形态自检（隔离）
```
