import { createServer } from 'node:http'
import { chmod, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** Per-Attempt local transport. No credentials, model calls or agent loop live here. */
export async function createPlatformToolBridge(prepare: (signal: AbortSignal) => Promise<unknown>, limit: number) {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-tool-'))
  const socket = join(directory, 'bridge.sock')
  const controller = new AbortController()
  let count = 0
  const active = new Set<Promise<void>>()
  const server = createServer((request, response) => {
    const task = (async () => {
      response.setHeader('Content-Type', 'application/json')
      if (request.method !== 'POST' || request.url !== '/prepare-skill' || ++count > limit || controller.signal.aborted) {
        response.writeHead(403).end(JSON.stringify({ error: '工具未获授权或 Attempt 已结束' }))
        return
      }
      request.resume()
      try {
        const value = await prepare(controller.signal)
        response.end(JSON.stringify(value))
      } catch (error) {
        response.writeHead(422).end(JSON.stringify({ error: error instanceof Error ? error.message : '包解析失败' }))
      }
    })()
    active.add(task)
    void task.finally(() => active.delete(task))
  })
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(socket, resolve) })
  await chmod(socket, 0o600)
  return {
    socket,
    abort: () => controller.abort(),
    async close() {
      controller.abort()
      server.closeAllConnections()
      await new Promise<void>(resolve => server.close(() => resolve()))
      await Promise.allSettled(active)
      await rm(directory, { recursive: true, force: true })
    },
  }
}
