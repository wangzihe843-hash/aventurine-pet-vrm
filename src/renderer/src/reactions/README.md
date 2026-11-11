# `src/renderer/src/reactions/**` —— DSH 外部反应（Wave 2 B7）

纯逻辑模块：**不 import DOM / Electron / three**，只把主进程推来的 DSH 桥事件折算为
`ExternalReaction`（`src/renderer/src/core/wave2-contract.ts` 冻结类型），供 B1 行为在
「自主行为」之上做一次优先级表演。

## `dsh.ts` API

```ts
export class DshReactionTracker {
  /** 消费一条 dsh-event（脏事件/重复事件安全忽略） */
  pushEvent(event: DshEvent, nowMs: number): void
  /** 可选：同步 pet:dsh-status；仅在转为离线时清空残留反应（静默安全） */
  pushStatus(status: DshStatus, nowMs: number): void
  /** 当前未过期的反应（null = 不表演） */
  reactionAt(nowMs: number): ExternalReaction | null
  /** 清空反应与去重状态（关闭 DSH 联动 / Lead 复位） */
  reset(): void
}

export const DSH_REACTION_DURATIONS // { dshBusy: 5000, dshDone: 2500, dshError: 12000 }
export const DSH_REACTION_BUBBLES   // 每 mood 取自单一来源 core/voicelines（官方原文，顺序循环）
```

## 映射与去重

| 桥事件（`events.jsonl`） | mood | 时长 |
|---|---|---|
| `task/start`、`agent/status` + `status==='running'` | `dshBusy` | 5s |
| `task/end`、`agent/status` + `status==='idle'` | `dshDone` | 2.5s |
| `task/error` | `dshError` | **12s**（用户 2026-11-09 决策：长时间倒地显示严重程度；配 `hsr-breaked` 倒地前摇 → `hsr-stun` 保持 → `hsr-revive` 起身） |
| `session/event`、未知类型 | 无反应 | — |

- 同一 agent 连续 `task/start`（未 end）只表演一次 busy；
- 同一 agent 连续相同 `type + turn` 的事件只表演一次；
- `task/error` 另按 `agent + turn` 去重（桥插件 `agent/error` 与 `turn/end(error)` 双信号兜底）；
- 反应自然过期后 `reactionAt` 返回 `null`，B1 回到自主行为。

## 接线（Lead 在 `main.ts` 完成）

1. `const tracker = new DshReactionTracker()`
2. `window.api.onDshEvent((event) => { if (behaviorConfig.dshLink) tracker.pushEvent(event, performance.now()) })`
   （main 侧 B7 已保证只在 `DshStatus.online` 时广播事件）
3. 每帧：`behaviorDirector.update({ ..., external: tracker.reactionAt(performance.now()) })`

**本模块不读 config、不读 DshStatus.online** —— 是否调用由 Lead 决定；未调用时完全静默。
台词为用户要求的**游戏内砂金 / 砂金·戏浪 官方中文语音原文**（单一来源 `src/renderer/src/core/voicelines.ts`；
Lead 抓取 BWIKI 两版语音页并逐条核对），不改写/不扩写、保持原文标点。映射（用户 2026-11-08 指示）：
- `dshDone`（任务成功）= 开启战利品（含贵重）/ 终结技 / 角色晋阶 / 角色满级 / 行迹激活；
- `dshError`（失败）= 无法战斗；
- `dshBusy`（开始忙碌）= 战技 / 秘技 / 战斗开始。


## `dsh-work-fidget.ts` API（用户 2026-11-09 决策）

DSH **工作模式**（`status.online === true && status.running === true`）期间，不定期播放一次
`hsr-skill01` / `hsr-skill02` 技能展示动作（`loop=false` 一次性，播完回当前 mood）。

```ts
export class DshWorkFidget {
  constructor(options?: DshWorkFidgetOptions)
  update(input: { nowMs: number; status: Pick<DshStatus,'online'|'running'> | null; blocked: boolean }): string | null
  reset(): void
  getSnapshot(nowMs?: number): DshWorkFidgetSnapshot
}
export const DSH_WORK_FIDGET_DEFAULTS // { minIntervalMs:30000, maxIntervalMs:60000,
                                      //   initialDelayMinMs:10000, initialDelayMaxMs:20000,
                                      //   clipIds:['hsr-skill01','hsr-skill02'], enabled:true }
```

- 间隔随机 30–60s（首次进入工作 10–20s 随机延迟），同一次 update 最多返回一个 clip，且不与上次重复；
- `blocked=true`（拖拽/摸头/右键菜单/DSH 反应进行中）时本次不触发且不重置计时，解除后顺延触发一次；
- 非 online / 非 running / status=null → 重置排程（下次重新随机 initial delay）；
- 台词/文本不参与本调度；由 Lead 在 `main.ts` 每帧调用并转交 `vrmAnimator.playOneShotClip()`。
- 决策依据：桥只有 `agent/status running|idle`（变化时）与 `turn/end` 等 session 事件，逐“思考结束”触发
  频率不可控且会与 `dshDone` 庆祝撞车；随机 30–60s 更接近参考项目 Mate-Engine 的 idle/dance 随机切换节奏。
