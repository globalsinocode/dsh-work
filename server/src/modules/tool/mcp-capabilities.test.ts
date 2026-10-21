import assert from 'node:assert/strict'
import { test } from 'node:test'

import { mergeMcpCapabilities, pendingMcpCapabilities } from './mcp-capabilities.ts'

const read = { name: 'read_order', description: '读取订单', inputSchema: { type: 'object', properties: { id: { type: 'string' } } } }
const list = { name: 'list_orders', description: '列出订单', inputSchema: { type: 'object' } }

test('unchanged tools stay effective and take the latest description', () => {
  const { effective, pending } = mergeMcpCapabilities([read, list], [{ ...read, description: '按编号读取订单' }, list])
  assert.deepEqual(effective.map(item => [item.name, item.description]), [['list_orders', '列出订单'], ['read_order', '按编号读取订单']])
  assert.deepEqual(pending, [])
})

test('removed tools go offline immediately', () => {
  const { effective, pending } = mergeMcpCapabilities([read, list], [read])
  assert.deepEqual(effective.map(item => item.name), ['read_order'])
  assert.deepEqual(pending, [])
})

test('added tools and input Schema changes wait for confirmation', () => {
  const create = { name: 'create_order', description: '创建订单', inputSchema: { type: 'object' } }
  const changedRead = { ...read, inputSchema: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } } }
  const { effective, pending } = mergeMcpCapabilities([read, list], [changedRead, list, create])
  assert.deepEqual(effective.map(item => item.name), ['list_orders'])
  assert.deepEqual(pending.map(item => item.name).sort(), ['create_order', 'read_order'])
})

test('Schema key order does not count as a change', () => {
  const reordered = { ...read, inputSchema: { properties: { id: { type: 'string' } }, type: 'object' } }
  assert.deepEqual(pendingMcpCapabilities([read], [reordered]), [])
})
