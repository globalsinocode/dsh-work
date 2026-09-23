/** Disposable, loopback-only Streamable HTTP MCP for PF-07 acceptance. */
import { randomUUID, timingSafeEqual } from 'node:crypto'
import { appendFileSync, readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { fileURLToPath } from 'node:url'

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { z } from 'zod'

function authorized(value, token) {
  const actual = Buffer.from(value ?? '')
  const expected = Buffer.from(`Bearer ${token}`)
  return actual.length === expected.length && timingSafeEqual(actual, expected)
}

export async function startPf07McpFixture({ token, port = 0, receiptPath, catalogVersion = 1 } = {}) {
  if (typeof token !== 'string' || token.length < 24) throw new Error('PF-07 MCP fixture requires a token of at least 24 characters')
  if (![1, 2].includes(catalogVersion)) throw new Error('catalogVersion must be 1 or 2')
  const receipts = new Map()
  let currentCatalogVersion = catalogVersion
  const record = (operationKey, value) => {
    const existing = receipts.get(operationKey)
    if (existing && existing.value !== value) return { conflict: true, receipt: existing }
    if (existing) return { conflict: false, receipt: existing }
    const receipt = { id: `receipt-${randomUUID()}`, operationKey, value, status: 'completed', createdAt: new Date().toISOString() }
    receipts.set(operationKey, receipt)
    if (receiptPath) appendFileSync(receiptPath, `${JSON.stringify(receipt)}\n`, { mode: 0o600 })
    return { conflict: false, receipt }
  }
  const toolResult = value => ({ content: [{ type: 'text', text: JSON.stringify(value) }] })

  const handle = async (request, response) => {
    if (request.url !== '/mcp') { response.writeHead(404).end(); return }
    if (!authorized(request.headers.authorization, token)) {
      response.writeHead(401, { 'WWW-Authenticate': 'Bearer realm="pf07-fixture"' }).end('Unauthorized')
      return
    }
    const mcp = new McpServer({ name: 'pf07-disposable-fixture', version: '1.0.0' }, { capabilities: { tools: {} } })
    mcp.registerTool('get_receipt', {
      description: 'Read the authoritative result of a PF-07 disposable test operation.',
      inputSchema: { operationKey: z.string().min(1).max(100) },
    }, async ({ operationKey }) => toolResult(receipts.get(operationKey) ?? { status: 'not_found', operationKey }))
    mcp.registerTool('put_receipt', {
      description: 'Write one disposable test receipt. Repeating the same key and value is idempotent.',
      inputSchema: { operationKey: z.string().min(1).max(100), value: z.string().max(256) },
    }, async ({ operationKey, value }) => {
      const result = record(operationKey, value)
      return result.conflict
        ? { ...toolResult({ status: 'conflict', operationKey }), isError: true }
        : toolResult(result.receipt)
    })
    mcp.registerTool('unknown_after_commit', {
      description: 'Commit one disposable test receipt, then delay the response to exercise unknown-effect reconciliation.',
      inputSchema: {
        operationKey: z.string().min(1).max(100), value: z.string().max(256), delayMs: z.number().int().min(0).max(60_000),
      },
    }, async ({ operationKey, value, delayMs }) => {
      const result = record(operationKey, value)
      if (result.conflict) return { ...toolResult({ status: 'conflict', operationKey }), isError: true }
      await new Promise(resolve => setTimeout(resolve, delayMs))
      return toolResult(result.receipt)
    })
    if (currentCatalogVersion === 2) {
      mcp.registerTool('catalog_probe_v2', { description: 'Read-only catalog change marker.', inputSchema: {} }, async () => toolResult({ catalogVersion: currentCatalogVersion }))
    }
    const transport = new StreamableHTTPServerTransport({})
    response.on('close', () => { void transport.close(); void mcp.close() })
    await mcp.connect(transport)
    await transport.handleRequest(request, response)
  }
  const server = createServer((request, response) => {
    void handle(request, response).catch(() => {
      if (!response.headersSent) response.writeHead(500)
      response.end('MCP fixture error')
    })
  })
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve) })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('PF-07 MCP fixture has no TCP port')
  return {
    url: `http://127.0.0.1:${address.port}/mcp`,
    getReceipt: operationKey => receipts.get(operationKey) ?? null,
    setCatalogVersion: version => {
      if (![1, 2].includes(version)) throw new Error('catalogVersion must be 1 or 2')
      currentCatalogVersion = version
    },
    close: () => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())),
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const tokenPath = process.env.PF07_MCP_TEST_TOKEN_FILE
  if (!tokenPath) throw new Error('PF07_MCP_TEST_TOKEN_FILE is required; use a local 0600 file outside Git')
  const token = readFileSync(tokenPath, 'utf8').trim()
  const fixture = await startPf07McpFixture({
    token,
    port: Number(process.env.PF07_MCP_TEST_PORT ?? 0),
    receiptPath: process.env.PF07_MCP_RECEIPTS_PATH,
    catalogVersion: Number(process.env.PF07_MCP_CATALOG_VERSION ?? 1),
  })
  console.log(JSON.stringify({ url: fixture.url, catalogVersion: Number(process.env.PF07_MCP_CATALOG_VERSION ?? 1) }))
  const stop = () => { void fixture.close().finally(() => process.exit()) }
  process.once('SIGINT', stop)
  process.once('SIGTERM', stop)
}
