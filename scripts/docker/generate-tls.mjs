#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import { mkdirSync, existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const tlsDir = resolve(dirname(fileURLToPath(import.meta.url)), '../../deploy/docker/tls')
mkdirSync(tlsDir, { recursive: true })

const key = resolve(tlsDir, 'server.key')
const crt = resolve(tlsDir, 'server.crt')

if (process.platform === 'win32') {
  const result = spawnSync(
    'openssl',
    [
      'req', '-x509', '-nodes', '-days', '825', '-newkey', 'rsa:2048',
      '-keyout', key, '-out', crt,
      '-subj', '/CN=localhost',
      '-addext', 'subjectAltName=DNS:localhost,DNS:host.docker.internal,IP:127.0.0.1',
    ],
    { stdio: 'inherit' },
  )
  if (result.status !== 0) process.exit(result.status ?? 1)
} else {
  const script = resolve(dirname(fileURLToPath(import.meta.url)), '../../deploy/docker/generate-tls.sh')
  spawnSync('bash', [script], { stdio: 'inherit' })
}

if (!existsSync(crt)) {
  console.error('TLS 生成失败')
  process.exit(1)
}
console.log(`TLS: ${crt}`)
