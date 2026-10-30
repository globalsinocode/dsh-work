/**
 * Poll /health/live until the API accepts connections (dev startup ordering).
 */
const port = Number(process.env.DSH_WORK_SERVER_PORT ?? 4190)
const host = process.env.DSH_WORK_SERVER_HEALTH_HOST ?? '127.0.0.1'
const url = `http://${host}:${port}/health/live`
const timeoutMs = Number(process.env.DSH_WORK_DEV_SERVER_WAIT_MS ?? 120_000)
const intervalMs = 500
const deadline = Date.now() + timeoutMs

while (Date.now() < deadline) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(2_000) })
    if (response.ok) {
      console.log(`后端已就绪：${url}`)
      process.exit(0)
    }
  } catch {
    // Server still booting (migrations, runtime probe, etc.)
  }
  await new Promise(resolve => setTimeout(resolve, intervalMs))
}

console.error(`等待后端超时（${timeoutMs}ms）：${url}`)
process.exit(1)
