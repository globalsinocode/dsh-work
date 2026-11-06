/** Vite `server` block for workbench/admin (shared/ must not import `vite`). */
export interface DockerDevViteServerOptions {
  port: number
  strictPort: boolean
  host?: '0.0.0.0'
  watch?: { usePolling: boolean; interval: number }
  hmr?: { clientPort: number; host: string }
  proxy: {
    '/api': { target: string; changeOrigin: boolean }
    '/auth': { target: string; changeOrigin: boolean }
  }
}

/** When `DSH_WORK_DOCKER_DEV=1`: bind 0.0.0.0, poll watch, HMR via host-mapped ports. */
export function createDockerDevServerOptions(options: {
  port: number
  serverPort: number
}): DockerDevViteServerOptions {
  const dockerDev = process.env.DSH_WORK_DOCKER_DEV === '1'
  const proxyTarget = `http://127.0.0.1:${options.serverPort}`

  return {
    port: options.port,
    strictPort: true,
    ...(dockerDev
      ? {
          host: '0.0.0.0' as const,
          watch: { usePolling: true, interval: 500 },
          hmr: { clientPort: options.port, host: 'localhost' },
        }
      : {}),
    proxy: {
      '/api': {
        target: proxyTarget,
        changeOrigin: false,
      },
      '/auth': {
        target: proxyTarget,
        changeOrigin: false,
      },
    },
  }
}
