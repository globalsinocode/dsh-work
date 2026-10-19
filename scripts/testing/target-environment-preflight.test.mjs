import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { checkTargetEnvironment } from './target-environment-preflight.mjs'

const snapshot = JSON.parse(readFileSync(new URL('../../config/target-environment/2026-10-17.json', import.meta.url), 'utf8'))
const legacyLockMarker = 'legacy-development-profile-marker'
const markerSuffix = 'packages/bundle/acp-app/cordis.patch.yml'

function normalizePath(filePath) {
  return String(filePath).replaceAll('\\', '/')
}

function matchingInputs(overrides = {}) {
  const { env: envOverrides, removeEnv = [], ...rest } = overrides
  const env = {
    DSH_RUNTIME_HOME: 'preferred-home',
    DSH_WORK_TEST_DATABASE_URL: 'postgresql://example.invalid/preflight',
    ...envOverrides,
  }
  for (const key of removeEnv) delete env[key]
  return {
    env,
    nodeVersion: 'v26.8.1',
    pnpmVersion: '11.24.0\n',
    gitCommit: `${snapshot.sourceCommit}\n`,
    runtimeLock: {
      version: snapshot.dsh.version,
      commit: snapshot.dsh.commit,
      compatibility: { [legacyLockMarker]: { scope: 'development' } },
    },
    migrationVersion: '0081_knowledge_chunks.sql',
    fileExists(filePath) {
      return normalizePath(filePath) === `preferred-home/${markerSuffix}`
    },
    ...rest,
  }
}

function statusOf(result, name) {
  const found = result.items.find(entry => entry.name === name)
  assert.ok(found, name)
  return found.status
}

function rendered(result) {
  return `${result.stdout}${result.stderr}${result.json}`
}

test('matching injected toolchain, lock, profile and migrations passes', () => {
  const result = checkTargetEnvironment(snapshot, matchingInputs())
  assert.equal(result.exitCode, 0)
  for (const name of ['node', 'pnpm', 'sourceCommit', 'dsh.version', 'dsh.commit', 'dsh.profile', 'dsh.compatibility', 'migrations']) {
    assert.equal(statusOf(result, name), 'match', name)
  }
  assert.equal(result.items.find(entry => entry.name === 'dsh.profile').actual, 'acp-app')
  assert.equal(result.secrets.DSH_WORK_TEST_DATABASE_URL, 'SET')
  assert.equal(result.secrets.DSH_RUNTIME_COMPATIBILITY, 'MISSING')
  const output = rendered(result)
  assert.equal(output.includes(legacyLockMarker), false)
  assert.equal(output.includes('preferred-home'), false)
  assert.equal(output.includes('example.invalid'), false)
})

test('node version mismatch fails', () => {
  const result = checkTargetEnvironment(snapshot, matchingInputs({ nodeVersion: 'v22.0.0' }))
  assert.equal(statusOf(result, 'node'), 'mismatch')
  assert.equal(result.exitCode, 1)
})

test('pnpm version mismatch fails', () => {
  const result = checkTargetEnvironment(snapshot, matchingInputs({ pnpmVersion: '11.7.0' }))
  assert.equal(statusOf(result, 'pnpm'), 'mismatch')
  assert.equal(result.exitCode, 1)
})

test('dsh commit mismatch fails', () => {
  const result = checkTargetEnvironment(snapshot, matchingInputs({
    runtimeLock: {
      version: snapshot.dsh.version,
      commit: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      compatibility: { [legacyLockMarker]: { scope: 'development' } },
    },
  }))
  assert.equal(statusOf(result, 'dsh.version'), 'match')
  assert.equal(statusOf(result, 'dsh.commit'), 'mismatch')
  assert.equal(result.exitCode, 1)
  assert.equal(rendered(result).includes(legacyLockMarker), false)
})

test('any DSH_RUNTIME_COMPATIBILITY value fails without printing it', () => {
  const secret = 'compat-value-not-for-output-55aa'
  const result = checkTargetEnvironment(snapshot, matchingInputs({
    env: { DSH_RUNTIME_COMPATIBILITY: secret },
  }))
  assert.equal(statusOf(result, 'dsh.compatibility'), 'mismatch')
  assert.equal(result.secrets.DSH_RUNTIME_COMPATIBILITY, 'SET')
  assert.equal(result.exitCode, 1)
  assert.equal(rendered(result).includes(secret), false)
})

test('migrations behind the snapshot fail', () => {
  const result = checkTargetEnvironment(snapshot, matchingInputs({
    migrationVersion: '0080_previous.sql',
  }))
  assert.equal(statusOf(result, 'migrations'), 'mismatch')
  assert.equal(result.exitCode, 1)
})

test('migrations are not-checked when the test database url is unset', () => {
  const result = checkTargetEnvironment(snapshot, matchingInputs({
    removeEnv: ['DSH_WORK_TEST_DATABASE_URL'],
    env: { DSH_WORK_DATABASE_URL: 'postgresql://example.invalid/should-not-be-used' },
    migrationVersion: '0001_old.sql',
  }))
  assert.equal(statusOf(result, 'migrations'), 'not-checked')
  assert.equal(result.secrets.DSH_WORK_TEST_DATABASE_URL, 'MISSING')
  assert.equal(result.exitCode, 0)
  const output = rendered(result)
  assert.equal(output.includes('should-not-be-used'), false)
  assert.equal(output.includes('example.invalid'), false)
})

test('a missing required snapshot key fails', () => {
  const broken = structuredClone(snapshot)
  delete broken.node
  const result = checkTargetEnvironment(broken, matchingInputs())
  assert.equal(statusOf(result, 'node'), 'missing')
  assert.equal(result.exitCode, 1)
})

test('dsh profile is missing when neither runtime home is set', () => {
  const result = checkTargetEnvironment(snapshot, matchingInputs({
    removeEnv: ['DSH_RUNTIME_HOME', 'DSH_HOME'],
    fileExists() {
      throw new Error('profile lookup should not guess a home')
    },
  }))
  assert.equal(statusOf(result, 'dsh.profile'), 'missing')
  assert.equal(result.exitCode, 1)
})

test('dsh profile follows DSH_RUNTIME_HOME and does not print the home', () => {
  const result = checkTargetEnvironment(snapshot, matchingInputs({
    env: { DSH_HOME: 'fallback-home' },
    fileExists(filePath) {
      return normalizePath(filePath) === `fallback-home/${markerSuffix}`
    },
  }))
  assert.equal(statusOf(result, 'dsh.profile'), 'mismatch')
  const output = rendered(result)
  assert.equal(output.includes('preferred-home'), false)
  assert.equal(output.includes('fallback-home'), false)
})

test('output never contains injected secret values', () => {
  const secret = 'preflight-sentinel-7c1e9b2a4d'
  const result = checkTargetEnvironment(snapshot, matchingInputs({
    env: {
      DSH_RUNTIME_HOME: `home-${secret}`,
      DSH_WORK_TEST_DATABASE_URL: `postgresql://db.example/${secret}`,
      DSH_RUNTIME_COMPATIBILITY: `compat-${secret}`,
      UNIT_TEST_API_KEY: secret,
      UNIT_TEST_TOKEN: secret,
      UNIT_TEST_SECRET: secret,
      UNIT_TEST_PASSWORD: secret,
      UNIT_TEST_CREDENTIAL: secret,
    },
    fileExists(filePath) {
      return normalizePath(filePath) === `home-${secret}/${markerSuffix}`
    },
  }))
  assert.equal(result.secrets.DSH_WORK_TEST_DATABASE_URL, 'SET')
  assert.equal(result.secrets.DSH_RUNTIME_COMPATIBILITY, 'SET')
  assert.equal(result.secrets.UNIT_TEST_API_KEY, 'SET')
  assert.equal(result.secrets.UNIT_TEST_TOKEN, 'SET')
  assert.equal(result.secrets.UNIT_TEST_SECRET, 'SET')
  assert.equal(result.secrets.UNIT_TEST_PASSWORD, 'SET')
  assert.equal(result.secrets.UNIT_TEST_CREDENTIAL, 'SET')
  for (const value of Object.values(result.secrets)) {
    assert.ok(value === 'SET' || value === 'MISSING')
  }
  assert.equal(rendered(result).includes(secret), false)
  assert.equal(JSON.stringify(result).includes(secret), false)
})
