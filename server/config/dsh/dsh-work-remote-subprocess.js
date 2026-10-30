import process from 'node:process'
import { Buffer } from 'node:buffer'
import { request } from 'node:http'

/**
 * dsh-work 执行容器模式的 `ctx.subprocess`：DSH 里所有子进程都经本 Attempt 的平台工具桥
 * （`DSH_PLATFORM_TOOL_SOCKET`）转给平台，由平台在本 Attempt 的执行容器内执行；宿主机上不起进程。
 *
 * - 只支持收集模式输出（`dsh-bash-local` 与 `glob`/`grep` 都用这种），命令结束后一次拿回；
 * - 不支持 stdin 与终端；
 * - 环境变量不转发：容器内的环境由平台固定，DSH 交来的 env（含 DSH_HOME 等）一律不带进容器；
 * - 取消时断开请求，平台随之整组杀掉容器内的进程。
 */
export const name = 'dsh-work-remote-subprocess'

const REQUEST_TIMEOUT_GRACE_MS = 30_000
const DEFAULT_TIMEOUT_MS = 600_000

export function apply(ctx) {
  ctx.provide('subprocess', createRemoteSubprocess(process.env.DSH_PLATFORM_TOOL_SOCKET))
}

export default apply

export function createRemoteSubprocess(socketPath) {
  return {
    async resolveExecutable(command) {
      if (typeof command !== 'string' || command.length === 0) throw new Error('remote subprocess: empty command')
      return command
    },
    async spawnTerminal() {
      throw new Error('remote subprocess: terminal sessions are not supported')
    },
    spawn(spec) {
      if (!socketPath) throw new Error('remote subprocess: execution container is not available in this process')
      if (spec.signal?.aborted) throw new Error('remote subprocess: aborted before spawn')
      if (!Array.isArray(spec.argv) || spec.argv.length === 0) throw new Error('remote subprocess: argv must not be empty')
      const stdin = spec.stdio?.stdin
      if (stdin !== 'ignore' && !(typeof stdin === 'object' && stdin !== null && stdin.data === '')) {
        throw new Error('remote subprocess: stdin is not supported')
      }
      const maxOutputBytes = Math.max(collectLimit(spec.stdio?.stdout, 'stdout'), collectLimit(spec.stdio?.stderr, 'stderr'))
      const state = { stdout: undefined, stderr: undefined, truncated: false }
      const controller = new globalThis.AbortController()
      const signal = spec.signal === undefined ? controller.signal : globalThis.AbortSignal.any([spec.signal, controller.signal])
      const done = post(socketPath, '/subprocess/exec', {
        argv: [...spec.argv],
        cwd: spec.cwd,
        maxOutputBytes,
        timeoutMs: DEFAULT_TIMEOUT_MS,
      }, signal, DEFAULT_TIMEOUT_MS + REQUEST_TIMEOUT_GRACE_MS).then(result => {
        state.stdout = Buffer.from(typeof result.stdout === 'string' ? result.stdout : '', 'utf8')
        state.stderr = Buffer.from(typeof result.stderr === 'string' ? result.stderr : '', 'utf8')
        state.truncated = result.truncated === true
        return {
          exitCode: typeof result.exitCode === 'number' ? result.exitCode : null,
          signal: result.timedOut === true ? 'SIGKILL' : null,
        }
      }, error => {
        if (signal.aborted) {
          state.stdout ??= Buffer.alloc(0)
          state.stderr ??= Buffer.alloc(0)
          return { exitCode: null, signal: 'SIGKILL' }
        }
        throw error
      })
      const settled = done.then(() => undefined, () => undefined)
      return {
        pid: 0,
        stdin: undefined,
        stdout: undefined,
        stderr: undefined,
        collected: { stdout: reader(state, 'stdout'), stderr: reader(state, 'stderr') },
        done,
        terminate: () => controller.abort(),
        async waitForExit(waitSignal) {
          if (waitSignal === undefined) {
            await settled
            return true
          }
          return Promise.race([settled.then(() => true), new Promise(resolve => {
            if (waitSignal.aborted) resolve(false)
            waitSignal.addEventListener('abort', () => resolve(false), { once: true })
          })])
        },
      }
    },
  }
}

function collectLimit(mode, stream) {
  if (typeof mode !== 'object' || mode === null || typeof mode.maxBytes !== 'number') {
    throw new Error(`remote subprocess: ${stream} must use collected output`)
  }
  return mode.maxBytes
}

/** Readable before exit as empty, after exit as the full text; offsets are bytes and readers never consume. */
function reader(state, stream) {
  return {
    readFrom(fromByte) {
      const bytes = state[stream]
      if (bytes === undefined) return { text: '', nextOffset: fromByte, lossy: false }
      const start = Math.min(Math.max(0, fromByte), bytes.length)
      return { text: bytes.subarray(start).toString('utf8'), nextOffset: bytes.length, lossy: state.truncated && start === 0 }
    },
  }
}

function post(socketPath, path, body, signal, timeoutMs) {
  return new Promise((resolve, reject) => {
    const payload = Buffer.from(JSON.stringify(body))
    const req = request({
      socketPath,
      path,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': payload.length },
      timeout: timeoutMs,
    }, response => {
      const chunks = []
      response.on('data', chunk => chunks.push(chunk))
      response.on('end', () => {
        let parsed
        try { parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { parsed = undefined }
        if ((response.statusCode ?? 500) >= 400) {
          const message = typeof parsed?.error?.message === 'string' ? parsed.error.message : `命令执行失败（${response.statusCode}）`
          reject(new Error(message))
          return
        }
        resolve(parsed ?? {})
      })
      response.on('error', reject)
    })
    const onAbort = () => req.destroy(new globalThis.DOMException('Aborted', 'AbortError'))
    if (signal.aborted) onAbort()
    else signal.addEventListener('abort', onAbort, { once: true })
    req.on('timeout', () => req.destroy(new Error('remote subprocess: request timed out')))
    req.on('error', reject)
    req.on('close', () => signal.removeEventListener('abort', onAbort))
    req.end(payload)
  })
}
