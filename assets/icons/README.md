# assets/icons — 占位图标（非最终美术）

Wave 1 开工前置补齐的**占位**图标资源，用于托盘（A1）与打包（C4）不再因缺美术而阻塞。
**这些不是最终设计稿**，后续有正式图标时随时替换（流程见下）。

## 文件

| 文件 | 尺寸 / 格式 | 用途 |
|---|---|---|
| `trayTemplate.png` | 16×16 PNG（黑 + alpha） | macOS 菜单栏托盘图标（template image） |
| `trayTemplate@2x.png` | 32×32 PNG（黑 + alpha） | 同上，Retina @2x；Electron 按文件名约定自动选用 |
| `app-icon-placeholder.png` | 512×512 PNG（RGBA） | **占位**应用图标；C4 打包时转 `.icns` |
| `src/trayTemplate.svg` | 矢量源 | 托盘图标源文件（可编辑） |
| `src/app-icon.svg` | 矢量源 | 应用图标源文件（可编辑） |
| `generate.mjs` | Node 脚本 | 从 `src/*.svg` 重新生成上面 3 个 PNG（sharp） |

## 版权说明

图形全部为本仓库自绘的简单几何图形（猫头剪影 / 骰子主题色块），**无任何第三方素材**，
不受 `assets/model/` 的模型版权（miHoYo / 作者二次配布限制）影响，可随仓库公开与分发。
正式替换时也请确保素材授权允许随 app 分发。

## macOS template image 约定

- 托盘图标必须是**纯黑 + alpha**（黑色部分即图形，alpha 决定形状）；macOS 深浅色菜单栏会自动反色，
  A1 创建 Tray 时必须 `nativeImage.setTemplateImage(true)` 或 `new Tray(image)` 时传入 template 图。
- 建议**只显式加载** `trayTemplate.png`，不要自己拼 `@2x`：Electron 的 `nativeImage` 会按
  `trayTemplate@2x.png` 命名约定自动选择高分辨率版本。
- 16×16 图形细节有限，正式图标也请保持"单色剪影 + 透明背景"，避免小尺寸糊成一团。

## 重新生成

在主工作树（已 `pnpm install`，devDependencies 里有 sharp）执行：

```bash
node assets/icons/generate.mjs
```

脚本会：渲染 → 校验尺寸/alpha（template 图还会校验 RGB 全 0、必须同时有透明与不透明像素）→ 写盘。
校验失败不会写出半成品图标。

## A1 / C4 消费方式（约定，细节以 C4 打包配置为准）

- A1（`src/main/tray.ts`）：开发模式用仓库相对路径
  `join(app.getAppPath(), 'assets/icons/trayTemplate.png')`；打包模式由 C4 在
  `electron-builder` 的 `files`/`extraResources` 里纳入 `assets/icons/**` 后再拼
  `process.resourcesPath`（具体路径由 C4 定，写进 `electron-builder.yml`）。
- C4：把 `app-icon-placeholder.png` 转成 `.icns`（`electron-builder.yml` 的 `mac.icon`）。
  512×512 是占位下限，正式图标建议提供 1024×1024 再转。
- 运行时若图标文件缺失：A1 应回退到 `nativeImage.createEmpty()` 之外的兜底方案并在日志告警，
  不允许因图标缺失导致托盘不出现（用户会失去唯一入口）。
