import type { PetApi } from '@shared/ipc'

declare global {
  interface Window {
    /**
     * 冻结契约 src/shared/ipc.ts 的 PetApi 转发层。
     * 这是 preload 暴露给 renderer 的唯一桥接面（严格白名单，见 PLAN §4）。
     */
    api: PetApi
  }
}
