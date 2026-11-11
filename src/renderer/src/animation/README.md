# 动画模块（V4 facade）

Wave 2 V4 legacy 隔离：v1 的 VMD/程序化动画实现整体位于 [`legacy/`](./legacy/README.md)，保留到 W3 再评估删除。
本文件所在目录的 `index.ts` 仅作 **facade**，只 re-export `legacy/**`，导出符号集合与迁移前完全一致
（`main.ts` 的 `import { createHybridAnimator } from './animation'` 不变）。
完整架构/文件职责说明见 [`legacy/README.md`](./legacy/README.md)；新 VRM 运行时见 `src/renderer/src/vrm/**`。
