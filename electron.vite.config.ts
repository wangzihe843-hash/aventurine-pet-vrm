import { resolve } from 'node:path'
import { defineConfig } from 'electron-vite'

// 三端共享同一个 `@shared` 别名，指向 src/shared（冻结契约所在目录）。
// 注意：src/shared/** 是环境中立纯 TS，不允许 import electron / node: 内置模块。
const sharedAlias = {
  '@shared': resolve('src/shared')
}

export default defineConfig({
  main: {
    resolve: { alias: sharedAlias }
  },
  preload: {
    resolve: { alias: sharedAlias }
  },
  renderer: {
    resolve: { alias: sharedAlias },
    build: {
      rollupOptions: {
        // Wave 2 B6：设置窗第二入口（Lead 在 Wave 2 开工前置加，见 PLAN §7/§19.6）。
        // - overlay 页 index.html：透明宠物渲染（A2）
        // - settings.html：普通设置窗（B6），由 src/main/windows/settings-window.ts 加载
        input: {
          index: resolve('src/renderer/index.html'),
          settings: resolve('src/renderer/settings.html')
        }
      }
    }
  }
})
