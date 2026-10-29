import { registerSW } from 'virtual:pwa-register'

/** 生产构建注册 Service Worker；开发模式不注册，避免缓存干扰联调。 */
export function registerAppPwa() {
  if (!import.meta.env.PROD) return

  registerSW({
    immediate: true,
    onRegistered(error) {
      if (error) console.warn('[pwa] Service Worker 注册失败', error)
    },
    onRegisterError(error) {
      console.warn('[pwa] Service Worker 注册异常', error)
    },
  })
}
