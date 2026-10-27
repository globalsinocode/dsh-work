import { fileURLToPath, URL } from 'node:url'

import vue from '@vitejs/plugin-vue'
import * as vueCompiler from 'vue/compiler-sfc'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  plugins: [vue({ compiler: vueCompiler })],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
      vue: fileURLToPath(new URL('./node_modules/vue/dist/vue.esm-bundler.js', import.meta.url)),
      'vue/compiler-sfc': fileURLToPath(new URL('./node_modules/vue/compiler-sfc/index.mjs', import.meta.url)),
    },
    dedupe: ['vue'],
  },
  test: {
    environment: 'happy-dom',
    // Vitest 4：依赖内联配置从顶层 server.deps 迁到 test.server.deps。
    server: {
      deps: {
        inline: ['vue', 'element-plus'],
      },
    },
    include: ['src/**/*.test.ts'],
    // 重异步组件用例（如 WorkspaceMemberDialog 的 20 个用例，单个通常 0.3–1s）
    // 在整机高负载（load avg 25 / 10 CPU）下曾超过默认 5s 而报
    // 「Test timed out in 5000ms」。这里给纯异步等待留出合理上限；
    // 它只放宽单用例的墙钟预算，不放宽任何断言，也不使用 bail/重试掩盖真实失败。
    testTimeout: 20_000,
    hookTimeout: 20_000,
    restoreMocks: true,
    clearMocks: true,
  },
})
