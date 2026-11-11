import { fileURLToPath } from 'node:url'

import { defineConfig } from 'vitest/config'

// A6 测试基建（Wave 0，修 F-09）：
// - 共享契约位于 src/shared（环境中立纯 TS），测试通过 `@shared` 别名导入；
// - 只收集 tests/**/*.test.ts；tests/tmp/** 是其它 Wave 的本地证据/临时目录，不纳入收集；
// - 集成类用例（scripts/prepare-assets.mjs --check）自行用 describe.skipIf 在无私有模型时跳过。
// - R-32：v8 coverage 先设宽松全局阈值（lines/statements 20、functions 20、branches 15），
//   只统计 src/**；排除类型声明与两个 Electron/渲染入口 main.ts（启动/装配层，node 环境不可测，
//   其中 src/main/index.ts 并非「纯入口」，占 src 行数相当比例，见 docs/known-issues.md R-32）；
//   provider 依赖 @vitest/coverage-v8。
// - 使用 `.mts` 前缀避免 Vite 的 "ESM syntax in a file loaded as CommonJS" 警告；
//   alias 用 import.meta.url 计算，避免依赖 process.cwd()。
export default defineConfig({
  resolve: {
    alias: {
      '@shared': fileURLToPath(new URL('./src/shared', import.meta.url))
    }
  },
  test: {
    include: ['tests/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**', '**/out/**', '**/tests/tmp/**'],
    environment: 'node',
    setupFiles: ['tests/setup.ts'],
    restoreMocks: true,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      include: ['src/**/*.{ts,tsx}'],
      exclude: ['src/**/*.d.ts', 'src/main/index.ts', 'src/renderer/src/main.ts'],
      thresholds: {
        lines: 20,
        functions: 20,
        branches: 15,
        statements: 20
      }
    }
  }
})
