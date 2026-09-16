import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const releasePath = join(projectRoot, 'scripts/deploy/release.sh')
const restorePath = join(projectRoot, 'scripts/deploy/restore.sh')
const backupPath = join(projectRoot, 'scripts/deploy/backup.sh')
const buildPath = join(projectRoot, 'scripts/release/build-release.sh')
const preflightPath = join(projectRoot, 'scripts/deploy/preflight.sh')
const endpointRendererPath = join(projectRoot, 'scripts/deploy/render-endpoint-compose.mjs')
const endpointConfiguratorPath = join(projectRoot, 'scripts/deploy/configure-macmini-endpoints.mjs')
const endpointWrapperPath = join(projectRoot, 'scripts/deploy/render-endpoint-compose.sh')

const [release, restore, backup, build, preflight, endpointWrapper] = await Promise.all([
  readFile(releasePath, 'utf8'),
  readFile(restorePath, 'utf8'),
  readFile(backupPath, 'utf8'),
  readFile(buildPath, 'utf8'),
  readFile(preflightPath, 'utf8'),
  readFile(endpointWrapperPath, 'utf8'),
])

const upgradeStart = release.indexOf('if [[ -n "${old_release}" && -d "${old_release}" ]]; then\n  if launchctl')
const upgradeEnd = release.indexOf('\nnode_bin=', upgradeStart)
assert.notEqual(upgradeStart, -1, 'release upgrade block is missing')
assert.notEqual(upgradeEnd, -1, 'release upgrade block is incomplete')
const upgradeBlock = release.slice(upgradeStart, upgradeEnd)
assertOrder(upgradeBlock, '/scripts/deploy/backup.sh', 'mark_attempted')
assertOrder(upgradeBlock, 'mark_attempted', 'run_compose "${compose_file}" up -d --wait postgres')

assertOrder(release, 'tar -xzf "${archive}"', 'if [[ -d "${release_dir}" ]]')
assert.match(release, /mv "\$\{release_dir\}" "\$\{stale_release\}"/)
assert.doesNotMatch(release, /if \[\[ ! -d "\$\{release_dir\}" \]\]; then\s+tar -xzf/)

const restoreOperationStart = restore.lastIndexOf('maintenance_started=true\ntrap cleanup EXIT')
assert.notEqual(restoreOperationStart, -1, 'restore maintenance block is missing')
const restoreOperation = restore.slice(restoreOperationStart)
assertOrder(restoreOperation, 'maintenance_started=true\ntrap cleanup EXIT', 'run_compose stop web')
assertOrder(restoreOperation, 'destructive_started=true', 'dropdb --if-exists --force')
assert.match(restore, /restore failed after database replacement began; services remain stopped/)

assert.doesNotMatch(build, /cp -R "\$\{project_root\}\/deploy\/\."/)
assert.match(build, /refusing to build beside sensitive deployment material/)
assert.match(build, /deploy\/runtime\.env\.example/)
assert.match(build, /acp-managed-credentials\.legacy\.cordis\.yml/)

assert.match(preflight, /git -C "\$\{runtime_home\}" rev-parse --is-inside-work-tree/)
assert.doesNotMatch(preflight, /-d "\$\{runtime_home\}\/\.git"/)
assert.match(preflight, /offline CA private keys must never be stored on the Mac mini/)
assert.match(preflight, /"\$\{candidate_endpoint_compose\}" "\$\{runtime_env\}"/)
assert.match(endpointWrapper, /runtime_env=\$\{4:-"\$\{deploy_root\}\/runtime\.env"\}/)
assert.match(backup, /DSH_WORK_OFF_HOST_BACKUP_DIRECTORY/)
assert.match(backup, /storage_class": "off-host"/)
assert.match(backup, /shasum -a 256 -c/)
assert.match(backup, /off-host backup filesystem changed while the backup was being written/)

for (const [script, version] of [[buildPath, '0.1.0'], [releasePath, '2026.9.7-01']]) {
  const result = spawnSync('bash', [script, version], { encoding: 'utf8' })
  assert.notEqual(result.status, 0, `${script} accepted non-stable version ${version}`)
  assert.match(result.stderr, /invalid stable release version/)
}

const fixtureRoot = await mkdtemp(join(tmpdir(), 'dsh-work-deployment-safety.'))
try {
  await verifyDestructiveRestoreFailsClosed(join(fixtureRoot, 'restore'))
  await verifySameFilesystemBackupIsRejected(join(fixtureRoot, 'backup'))
  await verifySensitiveBuildInputIsRejected(join(fixtureRoot, 'build'), build)
  await verifyEndpointRenderer(join(fixtureRoot, 'endpoints'))
  await verifyEndpointConfigurator(join(fixtureRoot, 'endpoint-config'))
  await verifyEndpointRestartFailure(join(fixtureRoot, 'endpoint-restart'))
  await verifyNativeCertificateIssuance(join(fixtureRoot, 'certificates'))
  for (const app of ['admin-web', 'workbench-web']) {
    const vite = await readFile(join(projectRoot, 'apps', app, 'vite.config.ts'), 'utf8')
    assert.doesNotMatch(vite, /changeOrigin: true/, 'development proxy must preserve the portal Host')
    assert.equal(vite.match(/changeOrigin: false/g)?.length, 2)
  }
} finally {
  await rm(fixtureRoot, { recursive: true, force: true })
}

async function verifySameFilesystemBackupIsRejected(fixture) {
  const binRoot = join(fixture, 'bin')
  const currentRoot = join(fixture, 'current')
  const offHostRoot = join(fixture, 'off-host')
  const launchctlLog = join(fixture, 'launchctl.log')
  await mkdir(join(currentRoot, 'deploy'), { recursive: true })
  await mkdir(binRoot, { recursive: true })
  await mkdir(offHostRoot, { recursive: true })
  await writeFile(join(currentRoot, 'deploy/compose.yaml'), 'name: backup-test\nservices: {}\n')
  await writeFile(join(fixture, 'runtime.env'), [
    `PATH=${shellQuote(`${binRoot}:${process.env.PATH ?? '/usr/bin:/bin'}`)}`,
    `DSH_WORK_OFF_HOST_BACKUP_DIRECTORY=${shellQuote(offHostRoot)}`,
    `DSH_WORK_DATA_ROOT=${shellQuote(join(fixture, 'data'))}`,
    '',
  ].join('\n'), { mode: 0o600 })
  await writeExecutable(join(binRoot, 'df'), `#!/usr/bin/env bash
printf '%s\\n' 'Filesystem 1024-blocks Used Available Capacity Mounted on' '/dev/disk1 100 1 99 1% /'
`)
  await writeExecutable(join(binRoot, 'launchctl'), `#!/usr/bin/env bash
printf '%s\\n' "$*" >> ${shellQuote(launchctlLog)}
exit 0
`)

  const result = spawnSync('bash', [backupPath, fixture, currentRoot], { encoding: 'utf8' })
  assert.notEqual(result.status, 0, 'backup accepted storage on the deployment filesystem')
  assert.match(result.stderr, /must use a filesystem distinct/)
  const launchctlCalled = await readFile(launchctlLog, 'utf8').then(() => true, () => false)
  assert.equal(launchctlCalled, false, 'backup entered maintenance before validating off-host storage')
}

console.log('deployment safety contract tests passed')

function assertOrder(source, before, after) {
  const beforeIndex = source.indexOf(before)
  const afterIndex = source.indexOf(after)
  assert.notEqual(beforeIndex, -1, `missing deployment contract marker: ${before}`)
  assert.notEqual(afterIndex, -1, `missing deployment contract marker: ${after}`)
  assert.ok(beforeIndex < afterIndex, `deployment contract order is invalid: ${before} must precede ${after}`)
}

async function verifyDestructiveRestoreFailsClosed(fixture) {
  const binRoot = join(fixture, 'bin')
  const currentRoot = join(fixture, 'current')
  const backupRoot = join(fixture, 'backup')
  const dockerLog = join(fixture, 'docker.log')
  const installLog = join(fixture, 'install.log')
  await mkdir(join(currentRoot, 'deploy'), { recursive: true })
  await mkdir(join(currentRoot, 'scripts/deploy'), { recursive: true })
  await mkdir(binRoot, { recursive: true })
  await mkdir(backupRoot, { recursive: true })
  await writeFile(join(currentRoot, 'deploy/compose.yaml'), 'name: restore-test\nservices: {}\n')
  await writeFile(join(fixture, 'compose.endpoints.yaml'), 'services: {}\n')
  await writeFile(join(backupRoot, 'SHA256SUMS'), 'fixture\n')
  await writeFile(join(backupRoot, 'database.dump'), 'fixture\n')
  await writeFile(join(fixture, 'runtime.env'), [
    `PATH=${shellQuote(`${binRoot}:${process.env.PATH ?? '/usr/bin:/bin'}`)}`,
    'DSH_WORK_POSTGRES_USER=dsh_work',
    'DSH_WORK_POSTGRES_DB=dsh_work',
    `DSH_WORK_DATA_ROOT=${shellQuote(join(fixture, 'data'))}`,
    '',
  ].join('\n'), { mode: 0o600 })

  await writeExecutable(join(binRoot, 'docker'), `#!/usr/bin/env bash
printf '%s\\n' "$*" >> ${shellQuote(dockerLog)}
case "$*" in
  *pg_restore*) exit 42 ;;
  *) exit 0 ;;
esac
`)
  await writeExecutable(join(binRoot, 'launchctl'), `#!/usr/bin/env bash
[[ "\${1:-}" == print ]] && exit 1
exit 0
`)
  await writeExecutable(join(binRoot, 'shasum'), '#!/usr/bin/env bash\nexit 0\n')
  await writeExecutable(join(currentRoot, 'scripts/deploy/install-launchd.sh'), `#!/usr/bin/env bash
printf 'started\\n' >> ${shellQuote(installLog)}
`)
  await writeExecutable(join(currentRoot, 'scripts/deploy/render-endpoint-compose.sh'), `#!/usr/bin/env bash
printf '%s\\n' ${shellQuote(join(fixture, 'compose.endpoints.yaml'))}
`)

  const result = spawnSync('bash', [restorePath, fixture, backupRoot, '--confirm'], { encoding: 'utf8' })
  assert.notEqual(result.status, 0, 'restore unexpectedly succeeded after pg_restore failure')
  assert.match(result.stderr, /services remain stopped so partial data is not exposed/)
  const dockerCalls = await readFile(dockerLog, 'utf8')
  assert.doesNotMatch(dockerCalls, / up /, 'restore restarted web after destructive failure')
  assert.ok(dockerCalls.match(/ stop web/g)?.length === 2, 'restore did not stop web again after destructive failure')
  const installCalled = await readFile(installLog, 'utf8').then(() => true, () => false)
  assert.equal(installCalled, false, 'restore restarted launchd after destructive failure')
}

async function verifySensitiveBuildInputIsRejected(fixture, buildSource) {
  const fixtureBuild = join(fixture, 'scripts/release/build-release.sh')
  const outputRoot = join(fixture, 'output')
  await mkdir(dirname(fixtureBuild), { recursive: true })
  await mkdir(join(fixture, 'scripts/deploy'), { recursive: true })
  await mkdir(join(fixture, 'server'), { recursive: true })
  await mkdir(join(fixture, 'deploy'), { recursive: true })
  await writeFile(fixtureBuild, buildSource)
  await chmod(fixtureBuild, 0o755)
  await writeFile(join(fixture, 'server/package.json'), '{"version":"0.1.1","releaseVersion":"2026.09.07-01"}\n')
  await writeFile(
    join(fixture, 'scripts/deploy/release-version.sh'),
    await readFile(join(projectRoot, 'scripts/deploy/release-version.sh')),
    { mode: 0o755 },
  )
  await writeFile(join(fixture, 'deploy/runtime.env'), 'AI_HUB_CLIENT_SECRET=must-not-ship\n', { mode: 0o600 })

  const result = spawnSync('bash', [fixtureBuild, '2026.09.07-01', outputRoot], { encoding: 'utf8' })
  assert.notEqual(result.status, 0, 'release build accepted deploy/runtime.env')
  assert.match(result.stderr, /refusing to build beside sensitive deployment material/)
  const bundleExists = await readFile(join(outputRoot, 'dsh-work-v2026.09.07-01/release.json'), 'utf8')
    .then(() => true, () => false)
  assert.equal(bundleExists, false, 'failed sensitive build left a release payload behind')
}

async function verifyEndpointRenderer(fixture) {
  const validEnvironment = {
    ...process.env,
    NODE_ENV: 'production',
    DSH_WORK_BIND_ADDRESSES: '192.168.1.99,192.168.34.20',
    DSH_WORK_BIND_ADDRESS: '192.168.1.99',
    DSH_WORK_WORKBENCH_PORT: '4174',
    DSH_WORK_ADMIN_PORT: '4180',
    DSH_WORK_WORKBENCH_ORIGINS: [
      'https://192.168.1.99:4174',
      'https://192.168.34.20:4174',
      'https://work.example.com:4174',
    ].join(','),
    DSH_WORK_ADMIN_ORIGINS: [
      'https://192.168.1.99:4180',
      'https://192.168.34.20:4180',
      'https://work.example.com:4180',
    ].join(','),
  }
  const valid = spawnSync(
    process.execPath,
    [endpointRendererPath, fixture, projectRoot],
    { encoding: 'utf8', env: validEnvironment },
  )
  assert.equal(valid.status, 0, valid.stderr)
  const generated = await readFile(join(fixture, 'generated/compose.endpoints.yaml'), 'utf8')
  for (const mapping of [
    '192.168.1.99:4174:8443',
    '192.168.1.99:4180:8444',
    '192.168.34.20:4174:8443',
    '192.168.34.20:4180:8444',
  ]) {
    assert.ok(generated.includes(mapping), `endpoint override is missing ${mapping}`)
  }
  assert.match(generated, /DSH_WORK_WORKBENCH_SERVER_NAMES: .*work\.example\.com/)

  const publicAddress = spawnSync(
    process.execPath,
    [endpointRendererPath, join(fixture, 'invalid'), projectRoot],
    {
      encoding: 'utf8',
      env: {
        ...validEnvironment,
        DSH_WORK_BIND_ADDRESSES: '203.0.113.10',
        DSH_WORK_BIND_ADDRESS: '203.0.113.10',
      },
    },
  )
  assert.notEqual(publicAddress.status, 0, 'endpoint renderer accepted a public bind address')
  assert.match(publicAddress.stderr, /RFC1918/)
}

async function verifyEndpointConfigurator(fixture) {
  await mkdir(fixture, { recursive: true })
  const runtimeEnv = join(fixture, 'runtime.env')
  const candidateEnv = join(fixture, 'candidate.env')
  await writeFile(runtimeEnv, [
    'DSH_WORK_BIND_ADDRESS=192.168.1.99',
    'DSH_WORK_WORKBENCH_PORT=4174',
    'DSH_WORK_ADMIN_PORT=4180',
    'DSH_WORK_POSTGRES_PASSWORD=preserve-this-secret',
    '',
  ].join('\n'), { mode: 0o600 })
  const result = spawnSync(process.execPath, [
    endpointConfiguratorPath,
    '--env-file', runtimeEnv,
    '--output', candidateEnv,
    '--bind-address', '192.168.1.99',
    '--bind-address', '192.168.34.20',
    '--workbench-origin', 'https://192.168.1.99:4174',
    '--workbench-origin', 'https://192.168.34.20:4174',
    '--workbench-origin', 'https://work.example.com:4174',
    '--admin-origin', 'https://192.168.1.99:4180',
    '--admin-origin', 'https://192.168.34.20:4180',
    '--admin-origin', 'https://work.example.com:4180',
    '--workbench-default-origin', 'https://work.example.com:4174',
    '--admin-default-origin', 'https://work.example.com:4180',
  ], { encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
  const candidate = await readFile(candidateEnv, 'utf8')
  assert.match(candidate, /DSH_WORK_BIND_ADDRESSES=192\.168\.1\.99,192\.168\.34\.20/)
  assert.match(candidate, /AI_HUB_WORKBENCH_REDIRECT_URI=https:\/\/work\.example\.com:4174\/auth\/workbench\/callback/)
  assert.match(candidate, /DSH_WORK_POSTGRES_PASSWORD=preserve-this-secret/)
}

async function writeExecutable(path, content) {
  await writeFile(path, content)
  await chmod(path, 0o755)
}

async function verifyNativeCertificateIssuance(fixture) {
  const env = { ...process.env, PATH: '/usr/bin:/bin:/usr/sbin:/sbin' }
  const ca = spawnSync('/bin/bash', [join(projectRoot, 'scripts/deploy/init-intranet-ca.sh'),
    '--ca-dir', join(fixture, 'ca')], { encoding: 'utf8', env })
  assert.equal(ca.status, 0, ca.stderr)
  for (const [args, name] of [
    [['--ip', '192.168.1.99'], 'single'],
    [['--ip', '192.168.1.99', '--ip', '192.168.101.20',
      '--dns', 'work.example.com'], 'multi'],
  ]) {
    const output = join(fixture, name)
    const issued = spawnSync('/bin/bash', [join(projectRoot, 'scripts/deploy/issue-intranet-certificate.sh'),
      '--ca-dir', join(fixture, 'ca'), '--output-dir', output, ...args], { encoding: 'utf8', env })
    assert.equal(issued.status, 0, issued.stderr)
    const verified = spawnSync('/usr/bin/openssl', ['verify', '-CAfile', join(output, 'root-ca.crt'),
      join(output, 'server.crt')], { encoding: 'utf8', env })
    assert.equal(verified.status, 0, verified.stderr)
    const cert = spawnSync('/usr/bin/openssl', ['x509', '-in', join(output, 'server.crt'), '-noout', '-text'],
      { encoding: 'utf8', env })
    assert.equal(cert.status, 0, cert.stderr)
    assert.match(cert.stdout, /IP Address:192\.168\.1\.99/)
    if (name === 'multi') {
      assert.match(cert.stdout, /IP Address:192\.168\.101\.20/)
      assert.match(cert.stdout, /DNS:work\.example\.com/)
    }
  }
}

async function verifyEndpointRestartFailure(fixture) {
  const scripts = join(fixture, 'current/scripts/deploy')
  const bin = join(fixture, 'bin')
  await mkdir(scripts, { recursive: true })
  await mkdir(bin)
  await mkdir(join(fixture, 'generated'))
  const originalEnv = `DSH_WORK_NODE_BIN=${process.execPath}\n`
  await writeFile(join(fixture, 'runtime.env'), originalEnv)
  const originalCompose = 'services: {}\n'
  await writeFile(join(fixture, 'generated/compose.endpoints.yaml'), originalCompose)
  await writeFile(join(scripts, 'configure-macmini-endpoints.mjs'), `
import { readFileSync, writeFileSync } from 'node:fs';
writeFileSync(process.argv[5], readFileSync(process.argv[3], 'utf8') + '# candidate\\n');
`)
  await writeExecutable(join(scripts, 'render-endpoint-compose.sh'), `#!/bin/bash
printf 'candidate compose\\n' > "$3"
`)
  await writeExecutable(join(scripts, 'preflight.sh'), '#!/bin/bash\nexit 0\n')
  await writeExecutable(join(scripts, 'install-launchd.sh'), `#!/bin/bash
printf 'install\\n' >> ${shellQuote(join(fixture, 'install.log'))}
if [[ ! -e ${shellQuote(join(fixture, 'failed-once'))} ]]; then
  touch ${shellQuote(join(fixture, 'failed-once'))}
  exit 42
fi
`)
  await writeExecutable(join(bin, 'docker'), `#!/bin/bash
printf 'docker\\n' >> ${shellQuote(join(fixture, 'docker.log'))}
`)
  await writeExecutable(join(bin, 'curl'), '#!/bin/bash\nexit 0\n')
  const result = spawnSync('/bin/bash', [join(projectRoot, 'scripts/deploy/set-macmini-endpoints.sh'),
    'apply', '--deploy-root', fixture, '--bind-address', '192.168.101.20', '--confirm'], {
    encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
  })
  assert.notEqual(result.status, 0, 'failed launchd restart was reported as applied')
  assert.match(result.stderr, /endpoint apply failed; previous configuration restored/)
  assert.equal(await readFile(join(fixture, 'runtime.env'), 'utf8'), originalEnv)
  assert.equal(await readFile(join(fixture, 'generated/compose.endpoints.yaml'), 'utf8'), originalCompose)
  assert.equal(await readFile(join(fixture, 'install.log'), 'utf8'), 'install\ninstall\n')
  assert.equal(await readFile(join(fixture, 'docker.log'), 'utf8'), 'docker\n',
    'Compose should only run for the successful rollback restart')
}

function shellQuote(value) {
  return `'${value.replaceAll("'", `'"'"'`)}'`
}
