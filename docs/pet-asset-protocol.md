# `pet-asset://` 协议映射与安全审计（A3 / F13）

> 契约来源：`PLAN.md` §8.1（URL 形式 / 根目录 / 注册 / handler 安全要求 / CSP）。
> 实现：`src/main/protocol-path.ts`（纯函数 URL/路径校验）+ `src/main/protocol.ts`（Electron 集成与 fs 读取）。
> 回归：`tests/protocol-path.test.ts`（纯函数矩阵）+ `tests/protocol-handler.test.ts`（真实 handler + 临时文件系统 / 符号链接 / TOCTOU / packaged 根）。
> 本文档是 §8.1「12 条安全审计」的可复现交付物（M-2/F13），逐条给出实现位置与测试证据。

---

## 1. URL 契约

```
pet-asset://model/<文件名>
```

| 组成 | 约束 | 实现 |
|---|---|---|
| scheme | 必须 `pet-asset:` | `protocol-path.ts:isAllowedPetAssetUrl` |
| host | 必须 `model`（大小写不敏感，WHATWG URL 语义） | 同上 |
| port | 必须为空（`model:1337` 拒绝；`model:` 空 port 视作无 port） | 同上 |
| userinfo | `username`/`password` 必须为空（`pet-asset://evil@model/x` 拒绝，F8） | 同上 |
| pathname | URL pathname 恒以 `/` 开头；`decodeURIComponent` 后必须是**单段文件名** | `parseSafeRelativePath` |
| method | 只允许 `GET`（POST/HEAD/PUT → 405） | `protocol.ts` handler |

`<文件名>` 允许 CJK、空格、括号、em-dash、字面量 `%` 等；调用方用 `encodeURIComponent` 编码，
handler 只解码一次（不做二次解码）。**不支持子目录**：解码后出现 `/`（含 `%2F`、`%2f`）一律 403。

- 反例：`pet-asset://model/sub/nested.png`、`pet-asset://model/sub%2Fnested.png`、`pet-asset://model/a%2Fb.png`。
- 双编码 `%252e%252e%252fetc` 解码一次后是字面量文件名 `%2e%2e%2fetc`，不会被二次解码；若磁盘无此文件则为 404（不逃逸）。
- 非法百分号编码 / overlong UTF-8（`%c0%ae`、`%FF%FE`）→ 403。

## 2. 资源根

| 运行模式 | 根（按顺序尝试） | 说明 |
|---|---|---|
| dev（`!app.isPackaged`） | `<appPath>/assets/model/optimized` | **唯一合法根，无回退**。`assets/model` 下的原图不可读；保证冒烟 200 能证明 PMX 已进 `optimized/`。 |
| packaged（`app.isPackaged`） | `<process.resourcesPath>/model`，再 `<process.resourcesPath>/model/optimized` | `extraResources` 把 `assets/model/optimized/**` 映射到 `model/`；第二个根兼容过渡期的 `model/optimized/` 布局。 |

`optimized/` 内容 = 20 张贴图 + 1 个 PMX 字节级副本（21 文件）；`getAssetRoots()` 导出供冒烟断言。

## 3. 协议注册与 privileges

```ts
protocol.registerSchemesAsPrivileged([{
  scheme: 'pet-asset',
  privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true }
}])
```

- `registerPetAssetScheme()` 必须在 `app.whenReady()` **之前**同步调用（Electron 硬性要求）。
- `registerPetAssetProtocol(logger?)` 在 ready 后调用；可选注入 logger（F6），无参调用保持兼容。
- 当前接线：`src/main/index.ts`（Lead-owned）调用两个函数；logger 接线由 Lead 后续完成。

## 4. 响应

| 状态 | 触发 | 头 |
|---|---|---|
| 200 | 根内合法普通文件 | `Content-Type`（见下）、`Content-Length`、`Access-Control-Allow-Origin: *`、`Cache-Control: no-cache` |
| 403 | scheme/host/port/userinfo 不符；路径非法（`..`、`/`、NUL、`\`、空段、`:`、解码失败）；TOCTOU 竞态中最终段被换成符号链接（`O_NOFOLLOW`/`ELOOP`）；`ENAMETOOLONG` | ACAO + Cache-Control + `text/plain; charset=utf-8` |
| 404 | 文件不存在、目录/非普通文件、根外符号链接、双编码字面名、packaged 根均未命中 | 同上 |
| 405 | 非 GET | 同上 |
| 500 | 意外 fs 错误（EACCES/EIO 等；**不包含**非法名字/符号链接） | 同上，且错误走注入 logger / console |

MIME 映射（`MIME_BY_EXTENSION`，大小写不敏感）：`.png → image/png`、`.jpg/.jpeg → image/jpeg`、
`.bmp → image/bmp`、`.gif → image/gif`、`.webp → image/webp`、`.pmx/.vmd → application/octet-stream`；
未知扩展名统一 `application/octet-stream`。

## 5. 安全约束与威胁模型

1. **字符串级校验**：`join(root, segment)` 后必须位于根内（`isInsideRoot` 按路径分隔符边界比较，不是简单 `startsWith`）。
2. **根 realpath**：允许根目录本身是符号链接（git worktree 场景），先解析为真实根。
3. **父目录 realpath 再拼 basename**（F3）：先 `realpath(candidate)` 做静态符号链接与根内二次校验，再以 `realpath(dirname(resolved))` + `basename(resolved)` 构造最终路径，先解析中间目录符号链接。
4. **`O_NOFOLLOW` + fstat + fd 读取**（F3）：最终段以 `O_RDONLY | O_NOFOLLOW | O_NONBLOCK` 打开，`fstat().isFile()` 通过后按 fd 读取。
   - 校验通过后最终段被换成根外符号链接 → `ELOOP` → 403，绝不读到根外（`tests/protocol-handler.test.ts` 的 TOCTOU 用例）。
   - 目录 / FIFO / 设备 → 404；`O_NONBLOCK` 避免 FIFO 阻塞。
5. **符号链接策略**（F3 / M-2）：
   - 根内目标 → 200（`realpath(candidate)` 后根内二次校验通过；保持 §8.1 既有「根内符号链接可读」语义）。
   - 根外目标 → 404（不泄露根外文件是否存在）。
   - 根目录本身是符号链接 → 正常读取（`realpath(root)`，worktree 场景）。
   - 校验通过后最终段被替换为符号链接（TOCTOU）→ `O_NOFOLLOW` / `ELOOP` → **403**，绝不读到根外。
6. **非法名映射 403**（F7）：`ENAMETOOLONG`、`ELOOP` 不落 500。
7. **威胁模型**：协议 handler 与资源根同属一个 macOS 用户。realpath + `O_NOFOLLOW` 能阻止
   「校验后被替换为符号链接」的竞态读取，但无法消除同用户对**父目录本身**的并发替换；
   攻击者已具备同等文件权限，不构成跨权限边界。此残余风险被记录并接受（F3/F11）。

## 6. §8.1 逐条审计清单

| # | §8.1 要求 | 实现 | 测试证据 |
|---|---|---|---|
| 1 | URL `pet-asset://model/<文件名>`，host 固定 `model` | `isAllowedPetAssetUrl` | `protocol-path.test.ts › isAllowedPetAssetUrl`；`protocol-handler.test.ts › 403 host 非 model` |
| 2 | 不带 port | `isAllowedPetAssetUrl` 的 `url.port === ''` | `protocol-path.test.ts › 带 port 一律拒绝`；handler `403 带 port` |
| 3 | scheme 必须 `pet-asset:` | `isAllowedPetAssetUrl` | `protocol-path.test.ts › 其它 scheme`；handler `403 scheme 非 pet-asset` |
| 4 | 无 userinfo（F8） | `url.username === '' && url.password === ''` | `protocol-path.test.ts › 带 userinfo 一律拒绝` |
| 5 | `<文件名>` 是单段文件名 | `parseSafeRelativePath` 解码后含 `/` → null | `protocol-path.test.ts › 单段文件名契约`；handler `403 裸/编码多段` |
| 6 | `decodeURIComponent` 后拒绝 `..`、路径分隔符、空段、非法文件名 | `parseSafeRelativePath` | `protocol-path.test.ts › 恶意 URL 必须拒绝`；handler 403 矩阵 |
| 7 | 拒绝 NUL / 反斜杠 / 盘符冒号 / 绝对路径 | `parseSafeRelativePath` | 同上 |
| 8 | 仅允许 GET | handler `request.method !== 'GET'` | `protocol-handler.test.ts › 405：仅允许 GET` |
| 9 | `realpath` 二次校验 + 只读根内普通文件 | `readAssetFromRoot` 根 realpath + `isInsideRoot` | handler `根外符号链接 → 404`、`packaged 根` |
| 10 | 符号链接逃逸防护（F3） | `realpath(root)` + `realpath(candidate)` 根内二次校验；`O_NOFOLLOW` + `fstat().isFile()` 防竞态 | handler `根内符号链接 → 200`、`根外符号链接 → 404`、`TOCTOU → 403 且不泄露`、`根目录符号链接 → 200` |
| 11 | 返回 `Response` + ACAO `*` + Cache-Control `no-cache` | `createResponse` / `COMMON_HEADERS` | handler 200 头断言、403/404 头断言 |
| 12 | `Content-Length` 精确 | `asset.bytes.byteLength` | handler PNG/PMX `content-length` 断言 |
| 13 | MIME：PNG `image/png`、PMX `application/octet-stream` | `MIME_BY_EXTENSION` | handler PNG/PMX/未知扩展名断言 |
| 14 | 不存在 404、越界/非法 403 | handler `kind` 映射 | handler 403/404 矩阵 |
| 15 | 非法名不回 500（F7） | `ENAMETOOLONG`/`ELOOP` → forbidden | handler `超长文件名 → 403` |
| 16 | dev 根唯一、packaged 根 + `optimized/` 兼容 | `getAssetRoots` | handler `dev 无回退 → 404`、`packaged 根 → 200` |
| 17 | scheme 注册在 ready 前、privileges 五元组 | `registerPetAssetScheme` | handler `scheme 注册` 断言 |
| 18 | 错误可观测（F6） | `registerPetAssetProtocol(logger?)` | handler `意外错误 → 500 + 注入 logger.error` |

## 7. 复跑

```bash
npx vitest run tests/protocol-path.test.ts tests/protocol-handler.test.ts
```

历史独立审查探针（gitignored）：`tests/tmp/review-w1/a3-probe-url.mjs`、
`a3-probe-handler.mjs`、`a3-probe-toctou.mjs`。
