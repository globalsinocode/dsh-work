import { existsSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'

function environmentValues(source) {
  return Object.fromEntries([...source.matchAll(/^([A-Z_]+)=(.*)$/gm)].map(match => [match[1], match[2].trim()]))
}

export function checkRuntime(check) {
  const lock = check.json('server/config/dsh/runtime-lock.json')
  const targets = [lock, ...Object.values(lock?.compatibility ?? {})]
  for (const target of targets) {
    check.assert(typeof target?.version === 'string' && target.version.length > 0, 'DSH Lock 缺少版本')
    check.assert(/^[0-9a-f]{40}$/.test(target?.commit ?? ''), 'DSH Lock 必须固定完整 Commit SHA')
    check.assert(target?.protocolVersion === 1, 'DSH Lock 的 ACP protocolVersion 必须为 1')
    check.assert(['official-acp-profile', 'legacy-acp-demo'].includes(target?.adapter), 'DSH Lock Adapter 无效')
  }
  check.assert(lock?.adapter === 'official-acp-profile', '生产 DSH 必须使用正式 ACP profile')
  for (const target of Object.values(lock?.compatibility ?? {})) {
    check.assert(target?.scope === 'development', 'DSH 兼容模式只允许 development')
  }
  const production = environmentValues(check.read('deploy/runtime.env.example'))
  const local = environmentValues(check.read('.env.example'))
  const localTarget = local.DSH_RUNTIME_COMPATIBILITY ? lock?.compatibility?.[local.DSH_RUNTIME_COMPATIBILITY] : lock
  check.assert(Boolean(localTarget), '本地模板选择了未知的 DSH 兼容模式')
  for (const [values, target, label] of [[production, lock, '生产'], [local, localTarget, '本地']]) {
    check.assert(values.DSH_EXPECTED_VERSION === target?.version, `${label} DSH Version 与 Lock 不一致`)
    check.assert(values.DSH_EXPECTED_COMMIT === target?.commit, `${label} DSH Commit 与 Lock 不一致`)
  }
  check.assert(!production.DSH_RUNTIME_COMPATIBILITY, '生产模板不得启用开发兼容模式')
  check.includes('scripts/deploy/preflight.sh', [
    'DSH_RUNTIME_COMPATIBILITY is development-only',
    'apps/cli/src/bin.ts', 'apps/cli/lib/bin.js', 'packages/bundle/acp-app/cordis.patch.yml',
  ])
  check.files(['server/migrations/0019_dsh_runtime_0_1_2_rc_1.sql', 'scripts/runtime/probe.ts'])
  for (const suffix of ['', '.legacy']) {
    check.includes(`server/config/dsh/acp-managed-credentials${suffix}.cordis.yml`, ['DSH_AGENT_SYSTEM_PROMPT'])
  }
  const scripts = check.json('package.json')?.scripts ?? {}
  for (const mode of ['handshake', 'model', 'tool', 'artifact', 'cancel', 'concurrency']) {
    check.assert(scripts[`probe:${mode}`] === `pnpm probe -- ${mode}`, `缺少 probe:${mode} 探针入口`)
  }
  checkExecutionImage(check)
  checkReleaseCopiesRuntimeConfig(check)
}

/** Files the server loads at run time from server/config must ship in the release bundle. */
function checkReleaseCopiesRuntimeConfig(check) {
  const build = check.read('scripts/release/build-release.sh')
  for (const directory of ['server/config/dsh', 'server/config/execution']) {
    const path = resolve(check.root, directory)
    if (!existsSync(path)) continue
    for (const name of readdirSync(path).filter(file => !/\.test\.[cm]?[jt]s$/.test(file))) {
      check.assert(build.includes(`${directory}/${name}`), `发布包未复制运行时配置 ${directory}/${name}（scripts/release/build-release.sh）`)
    }
  }
}

/** The execution image must be rebuildable from pinned inputs only (plan 4.6, 2b-1). */
function checkExecutionImage(check) {
  const dockerfile = check.read('deploy/execution-image/Dockerfile')
  const bases = [...dockerfile.matchAll(/^FROM\s+(\S+)/gm)].map(match => match[1])
  check.assert(bases.length > 0, '执行镜像 Dockerfile 缺少 FROM')
  for (const base of bases) check.assert(/@sha256:[0-9a-f]{64}$/.test(base), `执行镜像基础镜像必须按摘要锁定：${base}`)
  check.assert(/^ARG DEBIAN_SNAPSHOT=\d{8}T\d{6}Z$/m.test(dockerfile), '执行镜像必须固定 Debian 快照时间')
  check.assert(dockerfile.includes('https://snapshot.debian.org/archive/debian/${DEBIAN_SNAPSHOT}')
    && dockerfile.includes('https://snapshot.debian.org/archive/debian-security/${DEBIAN_SNAPSHOT}'), '执行镜像的 apt 源必须指向固定快照')
  check.assert(!/deb\.debian\.org/.test(dockerfile.replace(/^#.*$/gm, '')), '执行镜像不得使用滚动的 deb.debian.org 源')
  check.assert(/--require-hashes/.test(dockerfile) && /--only-binary=:all:/.test(dockerfile), '执行镜像的 pip 安装必须校验哈希且只用 wheel')
  const lock = check.read('deploy/execution-image/requirements.lock')
  const entries = lock.split(/\n(?=[^\s#-])/).map(entry => entry.trim()).filter(entry => entry && !entry.startsWith('#') && !entry.startsWith('--'))
  check.assert(entries.length > 0, '执行镜像 requirements.lock 为空')
  for (const entry of entries) {
    const requirement = entry.split(/\s/)[0]
    check.assert(/^[a-z0-9][a-z0-9._-]*==[^=\s]+$/i.test(requirement), `执行镜像依赖必须固定版本：${requirement}`)
    check.assert(/--hash=sha256:[0-9a-f]{64}/.test(entry), `执行镜像依赖缺少哈希：${requirement}`)
  }
  const locked = new Set(entries.map(entry => entry.split('==')[0].toLowerCase()))
  for (const name of check.read('deploy/execution-image/requirements.in').split('\n').map(line => line.trim()).filter(line => line && !line.startsWith('#'))) {
    check.assert(locked.has(name.toLowerCase()), `requirements.lock 未包含 ${name}，请重新生成`)
  }
  const workflow = check.read('.github/workflows/execution-image.yml')
  for (const match of workflow.matchAll(/^\s*uses:\s*(.+)$/gm)) {
    check.assert(/^[\w.-]+\/[\w.-]+@[0-9a-f]{40}\s+# v\d/.test(match[1]), `执行镜像工作流的 Action 必须固定带版本注释的 Commit SHA：${match[1]}`)
  }
  check.includes('.github/workflows/execution-image.yml', [
    'runs-on: ubuntu-24.04-arm', 'bash deploy/execution-image/smoke-test.sh',
    "if: github.event_name != 'pull_request' && github.ref == 'refs/heads/main'",
  ])
}
