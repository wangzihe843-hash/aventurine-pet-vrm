/**
 * renderer 全局类型声明（Wave 1 A2）。
 *
 * - `window.__aventurineDebug`：A2 调试面（生产构建同样存在；Lead 实机采集器 / smoke 使用）；
 * - `window.api` 的声明在 `src/preload/index.d.ts`（冻结契约，不在本文件重复）。
 * - `vite/client`：提供 `import.meta.glob` 等 Vite 特有 API 的类型（私有台词文件按需加载）。
 */

/// <reference types="vite/client" />

import type { AventurineDebug } from './debug'

declare global {
  interface Window {
    __aventurineDebug?: AventurineDebug
  }
}

export {}
