import './vite-esbuild-temp.ts'
import { fileURLToPath, URL } from 'node:url'

import vue from '@vitejs/plugin-vue'
import { VitePWA } from 'vite-plugin-pwa'
import { defineConfig } from 'vite'

import { resolveBrandPublicDir } from '../shared/vite-brand-public.ts'
import { createDshWorkPwaOptions } from '../shared/vite-pwa-options.ts'

const workbenchPort = Number(process.env.DSH_WORK_WORKBENCH_PORT ?? 4174)
const serverPort = Number(process.env.DSH_WORK_SERVER_PORT ?? 4190)

export default defineConfig({
  publicDir: resolveBrandPublicDir(import.meta.url),
  plugins: [
    vue(),
    VitePWA(
      createDshWorkPwaOptions(
        {
          name: 'dsh-work 员工 AI 工作台',
          short_name: 'dsh-work',
          description: 'dsh-work 员工 AI 工作台',
          start_url: '/workbench',
          id: '/workbench',
        },
        { importScripts: ['push-sw.js'] },
      ),
    ),
  ],
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
