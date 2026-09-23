import assert from 'node:assert/strict'
import { test } from 'node:test'

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

import { startPf07McpFixture } from './pf07-mcp-fixture.mjs'

const token = 'pf07-disposable-test-token-only'

async function connect(url) {
  const client = new Client({ name: 'pf07-test', version: '1.0.0' })
  await client.connect(new StreamableHTTPClientTransport(new URL(url), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  }))
  return client
}

function payload(result) {
  return JSON.parse(result.content.find(item => item.type === 'text').text)
}

test('PF-07 fixture enforces Bearer and exposes a stable MCP catalog', async () => {
  const fixture = await startPf07McpFixture({ token })
  try {
    const denied = await fetch(fixture.url, { method: 'POST', body: '{}', headers: { 'Content-Type': 'application/json' } })
    assert.equal(denied.status, 401)
    const client = await connect(fixture.url)
    try {
      const listed = await client.listTools()
      assert.deepEqual(listed.tools.map(tool => tool.name).sort(), ['get_receipt', 'put_receipt', 'unknown_after_commit'])
    } finally { await client.close() }
  } finally { await fixture.close() }
})

test('PF-07 fixture preserves one authoritative receipt across duplicate and unknown responses', async () => {
  const fixture = await startPf07McpFixture({ token })
  try {
    const client = await connect(fixture.url)
    try {
      const input = { operationKey: 'disposable-key', value: 'fixture-only-value' }
      const first = payload(await client.callTool({ name: 'put_receipt', arguments: input }))
      const replay = payload(await client.callTool({ name: 'put_receipt', arguments: input }))
      assert.equal(first.id, replay.id)
      assert.equal(first.status, 'completed')
      const conflicting = await client.callTool({ name: 'put_receipt', arguments: { ...input, value: 'different' } })
      assert.equal(conflicting.isError, true)
      assert.equal(payload(await client.callTool({ name: 'get_receipt', arguments: { operationKey: input.operationKey } })).id, first.id)

      await assert.rejects(client.callTool({
        name: 'unknown_after_commit', arguments: { operationKey: 'slow-key', value: 'committed', delayMs: 200 },
      }, undefined, { timeout: 20 }))
      assert.equal(fixture.getReceipt('slow-key')?.status, 'completed')
    } finally { await client.close() }
  } finally { await fixture.close() }
})

test('PF-07 fixture can publish a changed tool catalog', async () => {
  const fixture = await startPf07McpFixture({ token })
  try {
    fixture.setCatalogVersion(2)
    const client = await connect(fixture.url)
    try { assert.ok((await client.listTools()).tools.some(tool => tool.name === 'catalog_probe_v2')) }
    finally { await client.close() }
  } finally { await fixture.close() }
})
