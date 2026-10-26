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
  server: {
    deps: {
      inline: ['vue', 'element-plus'],
    },
  },
  test: {
    environment: 'happy-dom',
    include: ['src/**/*.test.ts'],
    // 与员工端一致：重异步组件用例在整机高负载下会超过默认 5s。
    // 显式提升单用例的墙钟预算，不放宽任何断言，也不使用 bail/重试掩盖真实失败。
    testTimeout: 20_000,
    hookTimeout: 20_000,
    restoreMocks: true,
    clearMocks: true,
  },
})
