import { execSync } from 'node:child_process'
import { platform } from 'node:os'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const DEFAULT_PORTS = {
  workbench: 4174,
  admin: 4180,
  server: 4190,
}

const KILL_TIMEOUT_MS = 20_000

// Docker Desktop 自己的端口转发进程会以容器发布端口（如 4174）出现在 netstat 里；
// 杀掉它们会让整个 Docker 引擎退出。这些 PID 必须跳过，容器端口由 compose 重建时自行交接。
const WINDOWS_PROTECTED_PROCESS_NAMES = [/^com\.docker\.backend$/i, /^wslrelay$/i, /^vpnkit$/i]

function devPorts() {
  return [
    Number(process.env.DSH_WORK_WORKBENCH_PORT ?? DEFAULT_PORTS.workbench),
    Number(process.env.DSH_WORK_ADMIN_PORT ?? DEFAULT_PORTS.admin),
    Number(process.env.DSH_WORK_SERVER_PORT ?? DEFAULT_PORTS.server),
  ].filter(port => Number.isFinite(port) && port > 0 && port < 65536)
}

function parseWindowsListeningPid(line, port) {
  if (!line.includes('LISTENING')) return null
  const localAddress = line.trim().split(/\s+/)[1]
  if (!localAddress?.endsWith(`:${port}`)) return null
  const pid = Number(line.trim().split(/\s+/).at(-1))
  return Number.isInteger(pid) && pid > 0 ? pid : null
}

function listeningPidsWindows(port) {
  let output = ''
  try {
    output = execSync(`netstat -ano | findstr LISTENING | findstr :${port}`, {
      encoding: 'utf8',
      windowsHide: true,
      shell: true,
      timeout: KILL_TIMEOUT_MS,
    })
  } catch (error) {
    if (error.status === 1) return []
    throw error
  }
  const pids = new Set()
  for (const line of output.split(/\r?\n/)) {
    const pid = parseWindowsListeningPid(line, port)
    if (pid) pids.add(pid)
  }
  return [...pids]
}

function listeningPidsUnix(port) {
  try {
    const output = execSync(`lsof -nP -iTCP:${port} -sTCP:LISTEN -t`, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: KILL_TIMEOUT_MS,
    })
    return output
      .split(/\r?\n/)
      .map(line => Number(line.trim()))
      .filter(pid => Number.isInteger(pid) && pid > 0)
  } catch {
    return []
  }
}

function listeningPids(port) {
  return platform() === 'win32' ? listeningPidsWindows(port) : listeningPidsUnix(port)
}

function windowsProcessName(pid) {
  try {
    return execSync(
      `powershell -NoProfile -Command "(Get-Process -Id ${pid} -ErrorAction Stop).ProcessName"`,
      { encoding: 'utf8', windowsHide: true, timeout: KILL_TIMEOUT_MS },
    ).trim()
  } catch {
    return undefined
  }
}

function isProtectedWindowsProcess(pid) {
  if (platform() !== 'win32') return false
  const name = windowsProcessName(pid)
  return name !== undefined && WINDOWS_PROTECTED_PROCESS_NAMES.some(pattern => pattern.test(name))
}

function killPid(pid) {
  if (pid === process.pid) return false
  try {
    if (platform() === 'win32') {
      // taskkill 在部分 Windows + Node 场景会长时间阻塞；Stop-Process 更可靠。
      execSync(
        `powershell -NoProfile -Command "Stop-Process -Id ${pid} -Force -ErrorAction SilentlyContinue"`,
        { stdio: 'ignore', windowsHide: true, timeout: KILL_TIMEOUT_MS },
      )
    } else {
      process.kill(pid, 'SIGTERM')
    }
    return true
  } catch {
    return false
  }
}

export function freeDevPorts(ports = devPorts()) {
  const killed = []
  const pidsByPort = new Map()
  for (const port of ports) {
    for (const pid of listeningPids(port)) {
      if (!pidsByPort.has(pid)) pidsByPort.set(pid, port)
    }
  }
  for (const [pid, port] of pidsByPort) {
    if (isProtectedWindowsProcess(pid)) {
      console.log(`跳过 Docker Desktop 端口转发进程 PID ${pid}（端口 ${port}），由容器重建自行交接。`)
      continue
    }
    if (killPid(pid)) killed.push({ port, pid })
  }
  return killed
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const killed = freeDevPorts()
  if (killed.length === 0) {
    console.log('开发端口未被占用，无需释放。')
  } else {
    for (const { port, pid } of killed) {
      console.log(`已结束占用端口 ${port} 的进程 PID ${pid}`)
    }
  }
}
