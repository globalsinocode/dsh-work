import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath, URL } from 'node:url'

import vue from '@vitejs/plugin-vue'
import { defineConfig } from 'vite'

interface ServerPackageMetadata {
  releaseVersion?: string
}

interface RuntimeLockMetadata {
  version?: string
  commit?: string
  protocolVersion?: number
}

const serverPackage = JSON.parse(readFileSync(new URL('../../server/package.json', import.meta.url), 'utf8')) as ServerPackageMetadata
const runtimeLock = JSON.parse(readFileSync(new URL('../../server/config/dsh/runtime-lock.json', import.meta.url), 'utf8')) as RuntimeLockMetadata

function resolveBuildCommit() {
  const configured = process.env.GITHUB_SHA?.trim()
  if (configured && /^[0-9a-f]{40}$/i.test(configured)) return configured.toLowerCase()
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
  } catch {
    return '开发构建'
  }
}

const adminPort = Number(process.env.DSH_WORK_ADMIN_PORT ?? 4180)
const serverPort = Number(process.env.DSH_WORK_SERVER_PORT ?? 4190)

export default defineConfig({
  plugins: [vue()],
  define: {
    __DSH_WORK_RELEASE_VERSION__: JSON.stringify(serverPackage.releaseVersion ?? '开发构建'),
    __DSH_WORK_BUILD_COMMIT__: JSON.stringify(resolveBuildCommit()),
    __DSH_WORK_DSH_VERSION__: JSON.stringify(runtimeLock.version ?? '—'),
    __DSH_WORK_DSH_COMMIT__: JSON.stringify(runtimeLock.commit ?? '—'),
    __DSH_WORK_DSH_PROTOCOL_VERSION__: JSON.stringify(runtimeLock.protocolVersion ?? '—'),
  },
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  server: {
    port: adminPort,
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
