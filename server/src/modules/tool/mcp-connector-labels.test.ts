import assert from 'node:assert/strict'
import { test } from 'node:test'

import type { DatabaseClient } from '../../infrastructure/postgres/database.ts'
import { describeUnavailableMcpConnectors } from './mcp-connector-labels.ts'

function databaseReturning(rows: Array<{ id: string; name: string }>): DatabaseClient {
  return (async () => rows) as unknown as DatabaseClient
}

test('unavailable connectors are named in the original order and keep the identifier', async () => {
  const database = databaseReturning([
    { id: 'connector-mcp-d79be18a', name: 'WK知识库-开发知识库' },
    { id: 'connector-mcp-healthy', name: '健康连接器' },
  ])
  assert.equal(
    await describeUnavailableMcpConnectors(database, 'tenant-dsh-work', ['connector-mcp-d79be18a']),
    'WK知识库-开发知识库（connector-mcp-d79be18a）',
  )
})

test('a deleted or unknown connector falls back to its identifier instead of disappearing', async () => {
  const database = databaseReturning([{ id: 'connector-mcp-live', name: '现场连接器' }])
  assert.equal(
    await describeUnavailableMcpConnectors(database, 'tenant-dsh-work', ['connector-mcp-live', 'connector-mcp-deleted']),
    '现场连接器（connector-mcp-live）、connector-mcp-deleted',
  )
})

test('no unavailable connectors produces no label', async () => {
  const database = databaseReturning([])
  assert.equal(await describeUnavailableMcpConnectors(database, 'tenant-dsh-work', []), '')
})
