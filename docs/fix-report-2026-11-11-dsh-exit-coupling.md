# 修复报告：关闭 DSH 后桌宠反而把 DSH 重新拉起（强耦合方向反了）

> 日期：2026-11-11 · 关联设计：[wave3-dsh-integration-design.md](wave3-dsh-integration-design.md) §3.2/§4.1
> 用户报告：「关掉 DeepSeek harness 并不会让桌宠关掉，反而会让桌宠重新打开 DeepSeek harness。
> 我的设想是 DeepSeek harness 关掉的同时桌宠也会消失，而不是反过来。」

## 0. TL;DR

| 项目 | 结论 |
|---|---|
| 根因 | `dsh-lifecycle` 状态机两处把「用户显式关闭 DSH」误判成「DSH 崩溃」，按崩溃恢复策略 `open -b com.deepseek.dsh` 把 DSH 又拉起来 |
| 触发路径 | ① 3s 进程 tick 抢在 1.5s detached grace 之前探测到进程消失 → 直接重启；② detached 后 grace 到期时进程仍在（关机慢），保持等待态；之后进程消失走 `process-gone` → 重启 |
| 修复 | detached 待定期**禁止重启**；任何「进程消失」都先过 grace 确认窗口，期间收到 detached = 显式退出 → 跟随退出（`dsh-exit`，不重启）；始终无 detached = 崩溃 → 才重启恢复 |
| 影响面 | 仅 `src/main/desktop/dsh-lifecycle.ts`（主进程状态机）+ 单测 + E2E；不改桥、不改 IPC、不改配置 |
| 验证 | 单测 36/36；旧实现下新回归用例 8 failed；全量 `pnpm test` 129 files / 2424 passed；`pnpm typecheck` 双端通过；隔离 fake-DSH E2E 47/47（含新增场景 E） |
| 实机 | 需重建 `dist` 并重启桌宠后生效（**重启桌宠不会终止 DSH**；不要直接退出桌宠——旧版 before-quit 会 SIGTERM DSH） |

## 1. 实机证据（2026-11-11 12:48 本地，`~/Library/Application Support/aventurine-pet/logs/main.log`）

```
04:48:25.686 [INFO] [dsh-lifecycle] 收到 detached，等待重新 attached（grace） {"graceMs":1500,"ts":1794372505682,"dshPid":18937}
04:48:26.152 [DEBUG] [dsh-process] 查询失败: pgrep -f DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness
04:48:26.153 [WARN] [dsh-lifecycle] DSH 疑似退出，进入重启恢复（process-gone） {"lastKnownRunning":false}
04:48:26.153 [INFO] [dsh-lifecycle] 尝试重启 DSH（process-gone）第 1/2 次
04:48:26.153 [INFO] [dsh-process] launch open -b com.deepseek.dsh          ← 用户刚关掉 DSH，桌宠又把它打开
04:48:27.188 [INFO] [dsh-lifecycle] 取消重启恢复（bridge-attached） {"attempts":1}
04:48:27.191 [WARN] [dsh-lifecycle] detached grace 到期但 DSH 进程仍在运行…  ← grace 22ms 后才到期
```

时间线：用户关闭 DSH → 桥 dispose 写 `detached`（25.682）→ 桌宠 750ms 轮询在 25.686 读到 →
1.5s grace 应在 27.186 裁决；但 3s 进程 tick 在 **26.152** 先探测到进程已消失，直接按崩溃
重启 → 27.188 新 DSH 的桥 `attached` 到达，恢复流程被取消 → 桌宠保持运行、DSH 被重新拉起。
**根因不是 grace 语义错，而是两个独立时间线（3s tick vs 1.5s grace / 750ms 轮询）的抢跑。**

## 2. 根因（两处）

1. **tick 抢跑**（实机命中）：`tickPaired()` 发现进程消失就 `beginRecovery('process-gone')`，
   不检查「是否已收到 detached / grace 是否在途」。3s tick 有概率落在
   `[detached 写入, grace 到期]` 之间，把显式退出的慢关机窗口当成崩溃。
2. **等待态没有记忆**：设计原文「detached + grace 到期 + 进程仍在 → 保持 PAIRED 等待重新 attached，
   （或后续进程消失走 process-gone 恢复路径）」——括号里的旧路径本身就是错的：这里后续的
   「进程消失」正对应 DSH 真正完成退出，必须跟随退出，而不是重启。

## 3. 修复（`src/main/desktop/dsh-lifecycle.ts`）

新增两个内部状态：

- `bridgeDetached`：收到 `detached` 且尚未收到新的 `attached`（显式退出候选）。`attached`/online
  心跳会清除；置位期间 `beginRecovery` 直接拒绝重启。
- `exitConfirmHandle`：PAIRED 下探测到进程消失后的确认定时器（复用 detached grace 时长）。

语义矩阵（修复后）：

| 场景 | 行为 |
|---|---|
| detached → grace 内 attached（HMR 重载） | 取消退出判定，保持 PAIRED（原语义） |
| detached → grace 到期 + 进程已不在 | 跟随退出 `dsh-exit`，**不重启**（原语义） |
| detached → grace 未到期，tick 先看到进程消失 | **禁止重启**，交 grace 裁决（本次修复①） |
| detached → grace 到期 + 进程仍在（关机慢/插件卸载） | 保持 PAIRED；之后进程消失 → 跟随退出 `dsh-exit`（本次修复②） |
| 无 detached → 进程消失（崩溃/SIGKILL） | 先等 grace 确认窗口；期间读到 detached → `dsh-exit`；无 detached → 重启恢复 ≤2 次，仍失败 `dsh-gone`（防 watcher 轮询晚于 tick 的同类竞态） |
| detached 到达时正在重启恢复（launch 已发出） | 取消后续恢复/验证，不再补拉起，按显式退出收尾 |

配套：恢复流程每一步都检查 `bridgeDetached`/`stopped`/`quitting()`；日志新增
`等待 1500ms 确认：收到 detached = 显式退出…`、`detached 后探测到 DSH 进程消失 → 跟随退出` 等可排障行。

## 4. 验证

### 4.1 单测（`tests/dsh-lifecycle.test.ts`，离线全注入）

- 新增 describe「显式退出语义：收到 detached 后绝不重启 DSH」5 条：
  1. 3s tick 先于 1.5s grace 探测到进程消失 → 0 次拉起，grace 到期 `dsh-exit`（实机 bug 回归）；
  2. tick 先看到进程消失、detached 在确认窗口内才到达 → 取消重启，`dsh-exit`（watcher 轮询晚于 tick）；
  3. grace 到期进程仍在，之后进程消失 → `dsh-exit` 而非重启；
  4. detached 后重新 attached → 清除显式退出标记，真崩溃仍按重启恢复；
  5. 重启恢复过程中收到 detached → 立即作废（不再补第 2 次拉起）并跟随退出。
- 修正 3 条既有用例的时序（崩溃恢复现在先等确认窗口，重启时刻 +1500ms），语义不变。
- 结果：36/36 passed。
- **反向验证**：把 `dsh-lifecycle.ts` 换回修复前版本跑同一套测试 → **8 failed**（5 条新用例 + 3 条时序用例），
  证明回归用例确实卡住旧行为。

### 4.2 全量

- `pnpm test`：129 files / 2424 passed / 11 skipped。
- `pnpm typecheck`：node + web 均通过。
- DSH 相关 8 个测试文件（lifecycle/ipc/watch/process/dialogue/reactions/work-fidget/bridge-plugin）253 passed。

### 4.3 隔离 fake-DSH E2E（不碰真实 DSH）

`scripts/wave3-e2e/e2e-coupling.mjs`：
- 新增**场景 E**：attach → 写 detached → SIGKILL fake（launch-direct，若错误重启会真的起第 2 个 fake）
  → 断言 pet 自行退出、`级联退出（dsh-exit`、fake 启动次数 = 1、日志无 `尝试重启 DSH`。
- 全量 A–E：**47/47 断言 PASS**（`tests/tmp/wave3-e2e/2026-11-11T05-24-08-335Z-coupling/result.json`）。
- 场景过滤：`node scripts/wave3-e2e/e2e-coupling.mjs e`（默认仍跑全部）。
- 顺手修了 E2E 自身两个会造成假 PASS/假 FAIL 的问题：
  1. dev userData 在真实 `~/Library/Application Support/aventurine-pet-<profile>`（macOS Electron 不认
     子进程 HOME），main.log 跨 run 追加 → `waitLog` 会命中历史日志。现在 `startCoupledPet` 启动前
     删除本脚本测试 profile 目录（只删 `w3e2e-cpl-*`，不碰真实桌宠 userData）。
  2. 隔离自证 `real-bridge-dir-unchanged` 在真实 DSH 运行期间必然失败（宿主每 5s 写 status.json）；
     改为断言真正要证明的东西：**control.json 未被 E2E 改动 + 桥目录文件集合未变**，真实宿主心跳增长
     只影响 events/status 内容，不再误报。
- 安全自证保持：真实 DSH pid 不变、desktop patch 不变、真实 `open -b com.deepseek.dsh` 未被调用。

## 5. 交付与生效方式（重要）

本修复在主进程，**必须重建 `out/` + `dist/` 并重启桌宠进程**才生效。重启桌宠时**不要用托盘/菜单
「退出」**（当前线上旧版 before-quit 会 SIGTERM DSH）；安全做法：

```bash
# 1) 重建（含 ad-hoc 签名 + package-check）
pnpm package:dir
# 2) SIGKILL 旧桌宠主进程（不触发 before-quit，DSH 不受影响）
kill -9 <AventurinePet 主进程 pid>
# 3) 直接 exec 新构建（不带 ELECTRON_RUN_AS_NODE，后台）
env -u ELECTRON_RUN_AS_NODE nohup \
  dist/mac-arm64/AventurinePet.app/Contents/MacOS/AventurinePet \
  >/tmp/aventurine-pet-relaunch.log 2>&1 &
# 4) 核对：main.log 出现「进入 PAIRED」、DSH pid 未变
```

之后用户关闭 DSH → 桌宠应在 ~1.5–2.5s 内跟随退出（`CASCADING dsh-exit`），不会再拉起 DSH；
重新打开 DSH → 桥 apply 时 `launchPet` 拉起桌宠（原设计保留）。

## 6. 保留的既有语义 / 风险

- **崩溃仍会重启**（设计 §1 用户已拍板：意外崩溃时对方在冷却/grace 内先尝试拉起，失败才跟随退出）。
  只有「无 detached 的进程消失」才走这条路径；显式退出（桥有 dispose）绝不重启。
- **强杀 DSH（SIGKILL/断电）没有 detached**：会被判为崩溃并按设计尝试重启 ≤2 次；这是设计取舍，
  不是本次 bug。
- 若桥 dispose 未写 control（例如被强杀），同样走崩溃路径；如需「任何 DSH 消失都跟随退出」，
  需用户改设计决策（本轮未改）。
- 联动只读真实桥文件，未修改 `~/.dsh/profiles/desktop/cordis.patch.yml`、未重启/终止真实 DSH。
