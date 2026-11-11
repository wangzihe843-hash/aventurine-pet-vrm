# adv 动作集接入 app 层清单（`build-app-manifest.mjs` 扩展）

- 日期：2026-11-09 · 任务：task-9 · 状态：**生成器已支持 adv（可选缺省），现有 mate/hsr 产物逐字节不变；等真实数据到位一条命令接入**
- 范围：只改**生成器 + 测试 + 文档**；`src/**` 运行时（`clip-registry.ts` / `clip-player.ts`）**零改动**（已参数化）。
- 关联文档：`docs/adv-pipeline-commands.md`（adv 动作集管线命令）、`docs/adv-clip-selection.md`（选片/接入设计）、
  `scripts/vrm/motion/README.md`「app 层清单」、`src/shared/animation-contract.ts`（冻结契约）、
  `src/renderer/src/vrm/clip-registry.ts`（运行时读取）。

---

## 0. 摘要

| 项 | 结论 |
|---|---|
| 生成器改动 | `SOURCE_SETS` 末尾追加 `adv`；新增 `OPTIONAL_SOURCE_SETS=['adv']`：`assets/motions/adv/manifest.json` 不存在时**整集跳过**（不报错）；存在时与 mate/hsr **同一套规则**生成 app 条目/catalog 条目 |
| adv 映射 | `slot` 非 null（首期 idle/walk）→ `app-manifest.json`；全部 adv clip → `app-catalog.json`；app 层 id `adv-<源 id>`、file `adv/<id>.json`、priority **直取源 manifest**（无 override） |
| mood 别名 | **首期不给 adv 加** `MOOD_CLIP_ALIASES`（动作→mood 绑定需 user 确认）；代码结构已可扩展并写清注释 |
| 零变更验收 | adv 缺省时产物 sha256 = 改前 baseline：`app-manifest.json 1f97ec72…e62bbe2`、`app-catalog.json d7b34e9a…b916c045`（现有 `assets/motions/app-*.json` 也逐字节一致） |
| 运行时 | `clip-registry.ts` / `clip-player.ts` 不改；同 priority 同 mood 时按 app-manifest 清单顺序（mate → hsr → adv），adv 追加在最后 |
| 测试 | 新增 `tests/adv-app-manifest.test.ts`（10 用例：纯函数映射/缺省零变更/CLI 生成/`--check`/篡改/缺文件报错）；`pnpm typecheck` 0 |
| 回滚 | 移走 `assets/motions/adv/manifest.json` 后重跑生成器 → 回到 baseline sha256；生成物不要手改 |

---

## 1. 背景：app 层两级清单

运行时（`clip-registry.ts` + `clip-player.ts`）不直接读 mate/hsr/adv 的源 manifest，而读生成器产出的两份私有清单
（`file` 均相对 `assets/motions/`）：

| 产物 | 形状 | 内容 | 用途 |
|---|---|---|---|
| `app-manifest.json` | 冻结契约 `AnimationClipManifest`（schemaVersion=1，clips[] 只含 mood/salute 槽位） | 每个 slot 非 null 的源 clip 一条：`id/mood/file/loop/timeScale/fadeInSec/fadeOutSec/rootMotion/priority` | B1 状态机按 `input.mood` 选片；同 mood 按 priority 排序 + 待机变体轮换 |
| `app-catalog.json` | 运行时扩展格式（version=1，clips[]） | **全部** clip（含一次性/表演/技能）：`id/set/file/loop/duration/tags/mood` | 事件/调试 `playClipById`；tag 回退 |

生成命令（真实数据到位后）：

```bash
node scripts/vrm/motion/build-app-manifest.mjs          # 生成
node scripts/vrm/motion/build-app-manifest.mjs --check  # 幂等校验（逐字节）
```

---

## 2. 本次改动（`scripts/vrm/motion/build-app-manifest.mjs`）

| 位置 | 改动 | 作用 |
|---|---|---|
| `SOURCE_SETS` | `['mate','hsr']` → `['mate','hsr','adv']`（**adv 在末尾**） | 固定顺序保证产物确定；adv 条目追加在既有集之后，缺省时既有产物字节不变 |
| 新增 `OPTIONAL_SOURCE_SETS` | `Object.freeze(['adv'])` + 内部 lookup | 声明「manifest 允许不存在」的源集；mate/hsr 仍为**必需**源（缺文件直接 fail，防静默残缺） |
| `buildAppManifests()` | 缺省可选源 → 跳过 + 记入返回值新字段 `skippedOptionalSets` | 纯函数可测；`sets` 自定义时行为一致（`sets:['mate','hsr']` 不会误报 adv 缺省） |
| `PRIORITY_OVERRIDES` | 新增 `adv: Object.freeze({})` | 首期**不启用** override（priority 直取源 manifest）；真实数据验收后如需压槽位冲突，在此补表即可，空表不会产生「未命中」warning |
| `MOOD_CLIP_ALIASES` | **不新增 adv 条目**；在数组后补扩展说明注释 | 后续给 adv 接线只需追加 `{set:'adv', clip:'<源 id>', mood:'<槽位>', ...}`；源 clip 必须在 adv 源 manifest 登记、app id = `adv-<clip>-<mood>` |
| `buildSetEntries()` | 注释泛化为 mate/hsr/adv 共用；规则/错误文案不变 | adv 与既有集共用同一套契约校验（非法 slot、重复 id、超长 id、缺文件 → error） |
| `generate()` / CLI | 可选源 manifest 缺省 → 不载入并打印 `可选源缺省跳过：adv（…）`；其余逻辑不变 | 真实数据未到时 CI/本地构建照常；`--check` 幂等/篡改检测保持 |
| `HELP` / 输入注释 | 描述改成 `{mate,hsr}(+可选 adv)` | 文档同步 |

**没有改的**：`CLIP_SLOT_MOODS`、catalog 条目字段、alias 规则、`--check` 逐字节比较逻辑、`src/**`。

---

## 3. adv 映射规则（与 mate/hsr 同表）

| 源 manifest 字段 | 进 app-manifest（当 slot 非 null） | 进 catalog（全部） |
|---|---|---|
| `id` | `adv-<id>`（如 `adv-idle`；长度 ≤64） | `adv-<id>` |
| `slot` | `mood = slot`（必须是 `CLIP_SLOT_MOODS` 13 个之一） | `mood = slot`（null 则 null） |
| `file` | 约定 `adv/<id>.json`（源 manifest 写别的值 → warning，以约定为准） | 同 |
| `loop/timeScale/fadeInSec/fadeOutSec/rootMotion` | 沿用源 clip / 源 defaults / 契约默认值 | 仅 `loop` 进 catalog |
| `priority` | **直取源 manifest**（不做 adv override） | catalog **不含** priority |
| `duration/tags` | — | `duration`（秒；缺失按 0）、`tags` |
| `set` | — | `"adv"` |

校验（与既有集一致，任一失败 → 不写盘 exit 1）：
- 缺 `id`/`id` 非法/重复 id/app 层 id 超 64 → error；
- `slot` 非 null 且不在 `CLIP_SLOT_MOODS` → error；
- `clipExists(file)` 为 false（`assets/motions/adv/<id>.json` 不存在）→ error（清单/文件漂移不静默）。

### 3.1 首期绑定表（以 `scripts/vrm/motion/clips.adv.json` 的 25 条为例）

> 真实全量选片由另一套 registry（`clips.adv-all.json`，135 clip）决定；**以最终 `assets/motions/adv/manifest.json`
> 里的 `slot` 为准**。下表只是 25 条代表集的预期行为，用于人工核对。

**进 app-manifest（slot 非 null，13 条）**

| mood | adv 源 id（priority） |
|---|---|
| idle | `idle`(10)、`idleShow`(8)、`commonIdle`(6)、`idle2`(5)、`idleShow2`(4)、`attackStandby`(3)、`think01`(2)、`worry01`(2)、`shrug01`(2)、`scratchHead01`(2)、`lookAtPhone`(2) |
| walk | `walk`(10)、`run`(4) |

**只进 catalog（slot=null，12 条）**：`talk01`、`talk02`、`stun`、`stunLoop`、`die`、`hitL`、`revive`、`skill01`~`skill04`、`mazeSkill`。

> 全量 135 clip 时：`slot` 非 null 的仍按上表规则进 app-manifest（数量由 registry 决定，通常仍是 idle/walk 少量绑定），
> 其余全部进 catalog（catalog 会显著变大，属预期；见 §7-R2）。

---

## 4. 启用 / 回滚

### 4.1 启用（真实数据到位后，按顺序）

```bash
cd /Volumes/4TB外置盘/deepseek-harness/aventurine-pet-vrm

# 0) 前置：adv 动作集已产出（见 docs/adv-pipeline-commands.md 的 manifest 步骤）
ls assets/motions/adv/manifest.json          # 必须存在（build-adv-manifest.mjs 产物）

# 1) 备份当前 app 清单 + 记录 sha256（回滚基线）
mkdir -p work/adv-biped/app/rollback
cp assets/motions/app-manifest.json assets/motions/app-catalog.json work/adv-biped/app/rollback/
shasum -a 256 assets/motions/app-*.json | tee work/adv-biped/app/rollback/SHA256SUMS.txt

# 2) 重新生成（adv 自动纳入；没有 adv 时则安静跳过）
node scripts/vrm/motion/build-app-manifest.mjs
node scripts/vrm/motion/build-app-manifest.mjs --check

# 3) 回归
pnpm typecheck
pnpm vitest run tests/adv-app-manifest.test.ts tests/vrm-clip-registry.test.ts
```

预期输出（adv 存在时，数字随 registry 变化）：

```
[app-manifest] app-manifest：32+N clips（…含 6 条 catalog→mood 别名）
[app-manifest] 槽位分布：idle 15+N_idle / walk 2+N_walk / …
[app-manifest] app-catalog：43+N clips（一次性 17+N_null：mate 8 / hsr 9 / adv N_null）
[app-manifest] 来源：mate 29 / hsr 14 / adv N
[app-manifest] --check PASS：产物与源 manifest 一致（…）
```

> `--check` 只在“产物 = 由当前源 manifest 重新生成”时 PASS；若只改源 manifest 不重跑，`--check` 会 exit 1（防漂移）。

### 4.2 回滚（一条命令回到接入前）

```bash
# 方式 A：移走 adv 源 manifest → 重跑（推荐；产物回到 baseline 字节）
mv assets/motions/adv/manifest.json work/adv-biped/app/rollback/adv-manifest.json
node scripts/vrm/motion/build-app-manifest.mjs
node scripts/vrm/motion/build-app-manifest.mjs --check   # 应 PASS
shasum -a 256 assets/motions/app-manifest.json assets/motions/app-catalog.json
# 预期（假设 hsr/mate manifest 与 2026-11-09 相同）：
#   1f97ec72b365fcbf925408c7c3c267a09cdf887783ff3512625747b35e62bbe2  app-manifest.json
#   d7b34e9ab19b279f97b4d7e1239c1109e5f94fb68b5c3dfe159dc040b916c045  app-catalog.json

# 方式 B：直接用备份覆盖（不重跑生成）
cp work/adv-biped/app/rollback/app-manifest.json assets/motions/app-manifest.json
cp work/adv-biped/app/rollback/app-catalog.json assets/motions/app-catalog.json
```

> **不要手改** `assets/motions/app-manifest.json` / `app-catalog.json`：它们是生成物（gitignore），
> 手改后 `--check` 会 FAIL；回滚以「移走源 manifest + 重跑」为准。

---

## 5. 验证证据（task-9，2026-11-09）

### 5.1 零变更（adv 缺省）

| 文件 | 改前 baseline（当前代码 + 当前 assets 生成到临时目录） | 改后重新生成 | 现有 `assets/motions/` 生成物 |
|---|---|---|---|
| `app-manifest.json` | `1f97ec72b365fcbf925408c7c3c267a09cdf887783ff3512625747b35e62bbe2` | 同左（`cmp` 逐字节一致） | 同左 |
| `app-catalog.json` | `d7b34e9ab19b279f97b4d7e1239c1109e5f94fb68b5c3dfe159dc040b916c045` | 同左（`cmp` 逐字节一致） | 同左 |

- baseline 存档：`work/adv-biped/app/baseline/{app-manifest,app-catalog}.baseline.json` + `SHA256SUMS.txt`
- 改后 `node scripts/vrm/motion/build-app-manifest.mjs --check`（真实 assets）→ **PASS**
- 关键实现：adv 缺省时 `buildAppManifests` 不产出任何 adv 条目，`stats`/条目顺序均与只有 mate/hsr 时一致。

### 5.2 合成 adv 路径（不碰私有 assets）

fixture 生成器：`work/adv-biped/app/make-fixture.mjs` → `work/adv-biped/app/synthetic/motions/{mate,hsr,adv}/`
（mate 13 clip / hsr 4 clip / adv 9 clip：3 条 slot 非 null + 6 条 catalog-only）。

| 场景 | 命令 | 结果 |
|---|---|---|
| adv 存在：生成 | `node scripts/vrm/motion/build-app-manifest.mjs --motions-dir <fixture> --manifest <out>/app-manifest.json --catalog <out>/app-catalog.json` | app-manifest **21 clips**（adv 直映射 3 条：`adv-idle`(idle,10)、`adv-walk`(walk,10)、`adv-idleShow`(idle,8)）；app-catalog **26 clips**（adv 9 条全收，6 条 `mood:null`）；来源 `mate 13 / hsr 4 / adv 9` |
| adv 存在：幂等 | 同命令 + `--check` | `--check PASS`，exit 0 |
| adv 存在：篡改 | 在 `app-manifest.json` 末尾加 1 字节后 `--check` | `--check FAIL：1 个问题`，exit 1（未被静默接受） |
| adv 缺省：生成 | 把 `adv/` 移出 fixture 后重跑 | `可选源缺省跳过：adv（…）`；app-manifest 18 clips / catalog 17 clips；无任何 `adv-*` 条目；exit 0 |
| adv 缺省：确定性 | 同 fixture 再生成一次到另一目录 | `cmp` 逐字节一致 |
| adv 缺省：`--check` | 同命令 + `--check` | PASS，exit 0 |
| adv 缺省：真实 assets | `node scripts/vrm/motion/build-app-manifest.mjs --check` | PASS，exit 0（输出含「可选源缺省跳过：adv」） |
| adv clip 文件缺失 | 删 fixture 的 `adv/idle.json` 后生成 | exit 1，stderr 含 `adv/idle.json`（清单/文件漂移不静默） |

证据文件（私有）：

```
work/adv-biped/app/
├── make-fixture.mjs                       # 合成 fixture 生成器（可复跑）
├── baseline/SHA256SUMS.txt + *.baseline.json
├── synthetic/motions/{mate,hsr,adv}/      # 假 manifest + clip 文件
├── synthetic/out/{app-manifest,app-catalog}.json          # adv 存在
├── synthetic/out-absent/…                 # adv 缺省
└── logs/*.log                             # 每条命令原始输出（present/absent/check/tamper/summary/sha256）
```

### 5.3 测试

- 新增 `tests/adv-app-manifest.test.ts`：**10 用例**（常量注册、adv 映射/priority/文件命名、缺省零变更、
  非法 slot/缺文件报错、无 adv 别名、CLI 生成 + `--check` + 篡改 + 缺省跳过）。
- 既有 `tests/vrm-clip-registry.test.ts`（含 build-app-manifest 纯函数用例）**23 用例全绿**。
- `pnpm typecheck`：**0 errors**。
- 全量 `pnpm test`：**106 files / 1826 passed / 14 skipped**（含本文件新增 10 用例；0 failed）。

---

## 6. 合成冒烟命令（可复跑）

```bash
cd /Volumes/4TB外置盘/deepseek-harness/aventurine-pet-vrm
APP=work/adv-biped/app

node $APP/make-fixture.mjs
M=$APP/synthetic/motions

# adv 存在：生成 + 幂等
node scripts/vrm/motion/build-app-manifest.mjs \
  --motions-dir $M --manifest $APP/synthetic/out/app-manifest.json --catalog $APP/synthetic/out/app-catalog.json
node scripts/vrm/motion/build-app-manifest.mjs \
  --motions-dir $M --manifest $APP/synthetic/out/app-manifest.json --catalog $APP/synthetic/out/app-catalog.json --check

# adv 缺省：移走 adv/ 再生成（验证 mate/hsr 产物与 adv 无关）
mv $M/adv $APP/synthetic/adv-hidden
node scripts/vrm/motion/build-app-manifest.mjs \
  --motions-dir $M --manifest $APP/synthetic/out-absent/app-manifest.json --catalog $APP/synthetic/out-absent/app-catalog.json
mv $APP/synthetic/adv-hidden $M/adv

# 真实 assets（adv 不存在）零变更路径
node scripts/vrm/motion/build-app-manifest.mjs --check
```

---

## 7. 风险 / 待决

| # | 风险 | 说明 | 处理 |
|---|---|---|---|
| R1 | **idle/walk 优先级竞争** | adv 源 manifest 的 priority 直取 registry：若 `adv-idle=10` 与 `hsr-idle=10` 同分，运行时稳定排序保留 manifest 顺序（mate→hsr→adv），**同分时 hsr 在前**，adv 不会意外抢主待机；但一旦 registry 给 adv 更高 priority（如 11+），adv 会成为主待机 | 接入前由 user 实机看观感是否切换主待机；需要替换时在 `PRIORITY_OVERRIDES.adv` 或 registry 里调（改完跑 `--check` 并评审产物 diff） |
| R2 | **catalog 体积** | 全量 135 clip 全收进 `app-catalog.json`（约 +135 行/几十 KB）；运行时 catalog 一次性解析，槽位选择只走 app-manifest | 可接受；若未来过大，另议 catalog 分片（不在本轮） |
| R3 | **mood 绑定未定** | dshBusy/dshDone/dshError、idle 稀有变体等 adv 别名**首期不加**（选片需 user 确认） | 后续按 `MOOD_CLIP_ALIASES` 扩展说明追加条目（不改生成规则） |
| R4 | **新 mood 需求** | `CLIP_SLOT_MOODS` 硬编码 13 个槽位（= `ANIMATION_CLIP_MOODS`）；若 adv 需要新 PetMood（社交等），必须同时改契约 `src/shared/animation-contract.ts` 与本脚本 | 本轮禁止改 src；出现需求先报 Lead 评审 |
| R5 | **真实 manifest 契约** | 若 `build-adv-manifest.mjs` 产出的 adv 源 manifest 字段非法（slot 越界/缺文件/重复 id），生成器会 fail 不写盘 | 按 `docs/adv-pipeline-commands.md` 的 validate/manifest 门禁先过，再接 app 层 |
| R6 | **回滚 sha 依赖 mate/hsr 不变** | §4.2 的 baseline sha256 前提是 mate/hsr 源 manifest 不变；若旧集也更新过，只能回到当次 `work/adv-biped/app/rollback/` 备份 | 每次接入前都跑 §4.1 第 1 步备份 |
| R7 | **同分顺序是隐式契约** | 「adv 追加在末尾 → 同分时既有集优先」依赖清单顺序；如果未来要求 adv 优先，不应靠调顺序，而应用 priority override | 已写入 §3/§7-R1，避免后人误改 SOURCE_SETS 顺序 |

---

## 8. FAQ

- **adv 源 manifest 不存在为什么不报错？** adv 是「可选源」（`OPTIONAL_SOURCE_SETS`）：真实数据未到时 CI/本地构建必须
  能正常产出既有 mate/hsr 清单；文件存在但内容非法仍按必需源规则报 error（防静默残缺）。
- **为什么 adv 追加在 SOURCE_SETS 末尾？** 固定顺序 + 追加末尾保证 adv 缺省时既有产物**逐字节不变**；新条目只追加不插入。
- **同 mood 同 priority 谁赢？** `clip-registry.rebuildIndexes()` 用稳定排序（priority 降序、同分保持清单顺序）；
  manifest 顺序 = mate → hsr → adv（adv 直映射）→ mood 别名，因此同分时既有集在前。
- **可以只给 adv 加 catalog 不接 mood 吗？** 可以：把 adv 源 manifest 的 slot 全部设为 null（或 registry 不绑 slot），
  则 adv 只进 catalog，`playClipById('adv-<id>')` 可播。
- **改了 `CLIP_SLOT_MOODS` 会怎样？** 必须同步 `src/shared/animation-contract.ts` 的 `ANIMATION_CLIP_MOODS`，
  否则生成器把新槽位判非法并 exit 1（脚本不能 import TS 契约）。
