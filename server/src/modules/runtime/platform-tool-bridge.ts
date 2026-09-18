import { createServer } from 'node:http'
import { chmod, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export type PlatformToolHandler = (input: Record<string, unknown>, signal: AbortSignal) => Promise<unknown>

/** Per-Attempt local transport. No credentials, model calls or agent loop live here. */
export async function createPlatformToolBridge(handlers: Record<string, PlatformToolHandler>, limit: number, authorize?: () => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-tool-'))
  const socket = join(directory, 'bridge.sock')
  const controller = new AbortController()
  let count = 0
  const active = new Set<Promise<void>>()
  const server = createServer((request, response) => {
    const task = (async () => {
      response.setHeader('Content-Type', 'application/json')
      // Internal policy probe, never registered as an Agent tool or counted as a tool call.
      if (request.url === '/authorize-execution') {
        if (request.method !== 'POST' || !authorize || controller.signal.aborted) {
          response.writeHead(403).end(JSON.stringify({ error: 'Attempt 未获授权' }))
          return
        }
        try {
          await authorize()
          response.end(JSON.stringify({ authorized: true }))
        } catch {
          response.writeHead(403).end(JSON.stringify({ error: '当前执行授权不可用或已撤销' }))
        }
        return
      }
      const toolName = request.url === '/prepare-skill'
        ? 'prepare_skill_installation'
        : request.url?.match(/^\/tools\/([a-z0-9_]+)$/)?.[1]
      const handler = toolName ? handlers[toolName] : undefined
      if (request.method !== 'POST' || !handler || ++count > limit || controller.signal.aborted) {
        response.writeHead(403).end(JSON.stringify({ error: '工具未获授权或 Attempt 已结束' }))
        return
      }
      try {
        const input = await readBody(request)
        await authorize?.()
        controller.signal.throwIfAborted()
        const value = await handler(input, controller.signal)
        await authorize?.()
        controller.signal.throwIfAborted()
        response.end(JSON.stringify(value))
      } catch (error) {
        response.writeHead(422).end(JSON.stringify({ error: error instanceof Error ? error.message : '包解析失败' }))
      }
    })()
    active.add(task)
    void task.catch(() => response.destroy()).finally(() => active.delete(task))
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

async function readBody(request: import('node:http').IncomingMessage): Promise<Record<string, unknown>> {
  let body = ''
  for await (const chunk of request) {
    body += String(chunk)
    if (Buffer.byteLength(body) > 65536) throw new Error('工具参数超过 64 KB')
  }
  if (!body) return {}
  const parsed = JSON.parse(body) as unknown
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('工具参数必须是对象')
  return parsed as Record<string, unknown>
}
