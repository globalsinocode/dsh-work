import assert from 'node:assert/strict'
import { test } from 'node:test'

import { isWeknoraConfigured, loadWeknoraConfig } from './config.ts'

test('loadWeknoraConfig requires both base URL and secret', () => {
  assert.equal(loadWeknoraConfig({}), null)
  assert.equal(loadWeknoraConfig({ WEKNORA_BASE_URL: 'https://kb.example' }), null)
  assert.equal(loadWeknoraConfig({ WEKNORA_INTEGRATION_SECRET: 'secret' }), null)
})

test('loadWeknoraConfig trims trailing slash from base URL', () => {
  const config = loadWeknoraConfig({
    WEKNORA_BASE_URL: 'https://kb.example/',
    WEKNORA_INTEGRATION_SECRET: 'secret',
  })
  assert.deepEqual(config, { baseUrl: 'https://kb.example', integrationSecret: 'secret' })
  assert.equal(isWeknoraConfigured({
    WEKNORA_BASE_URL: 'https://kb.example',
    WEKNORA_INTEGRATION_SECRET: 'secret',
  }), true)
})
