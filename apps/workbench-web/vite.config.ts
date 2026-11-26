import { readFileSync } from 'node:fs'
import { fileURLToPath, URL } from 'node:url'

import vue from '@vitejs/plugin-vue'
import { defineConfig } from 'vite'

const serverPackage = JSON.parse(readFileSync(new URL('../../server/package.json', import.meta.url), 'utf8')) as { releaseVersion?: string }
const workbenchPort = Number(process.env.DSH_WORK_WORKBENCH_PORT ?? 4174)
const serverPort = Number(process.env.DSH_WORK_SERVER_PORT ?? 4190)

export default defineConfig({
  plugins: [vue()],
  define: {
    // 错误记录样本的版本号（与管理端相同来源）。
    __DSH_WORK_RELEASE_VERSION__: JSON.stringify(serverPackage.releaseVersion ?? '开发构建'),
  },
  // 源码映射只供服务端还原错误堆栈：不在产物中引用，发布时移出前端目录（错误记录方案 6.4）。
  build: { sourcemap: 'hidden' },
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  server: {
    port: workbenchPort,
    strictPort: true,
    proxy: {
      '/api': {
        target: `http://127.0.0.1:${serverPort}`,
        changeOrigin: false,
      },
      '/auth': {
        target: `http://127.0.0.1:${serverPort}`,
        changeOrigin: false,
      },
    },
  },
})
