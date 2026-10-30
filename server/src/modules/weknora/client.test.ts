import assert from 'node:assert/strict'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { after, before, test } from 'node:test'

import {
  WeknoraAccountNotProvisionedError,
  WeknoraClient,
} from './client.ts'

const secret = 'integration-secret'
const config = { baseUrl: 'http://127.0.0.1:0', integrationSecret: secret }

let baseUrl = ''
let server: ReturnType<typeof createServer>
const calls: Array<{ path: string; auth?: string; body?: unknown }> = []

before(async () => {
  server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    let body = ''
    request.on('data', chunk => { body += chunk })
    request.on('end', () => {
      const parsed = body ? JSON.parse(body) : undefined
      calls.push({ path: url.pathname, auth: request.headers.authorization, body: parsed })
      if (url.pathname === '/api/v1/integrations/dsh-work/sessions' && request.method === 'POST') {
        if (parsed?.subject === 'missing') {
          response.writeHead(404, { 'Content-Type': 'application/json' })
          response.end(JSON.stringify({ error: 'account_not_provisioned' }))
          return
        }
        response.writeHead(200, { 'Content-Type': 'application/json' })
        response.end(JSON.stringify({
          user_id: 'wk-1',
          tenant_id: 7,
          access_token: 'user-token',
          expires_in: 3600,
        }))
        return
      }
      if (url.pathname === '/api/v1/integrations/dsh-work/bind-codes/exchange') {
        response.writeHead(200, { 'Content-Type': 'application/json' })
        response.end(JSON.stringify({ user_id: 'wk-bind' }))
        return
      }
      if (url.pathname === '/api/v1/knowledge-bases' && request.headers.authorization === 'Bearer user-token') {
        response.writeHead(200, { 'Content-Type': 'application/json' })
        response.end(JSON.stringify({
          success: true,
          data: [{ id: 'kb-1', name: '手册', description: '说明' }],
        }))
        return
      }
      response.writeHead(404)
      response.end()
    })
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve())
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('missing listen address')
  baseUrl = `http://127.0.0.1:${address.port}`
})

after(async () => {
  await new Promise<void>((resolve, reject) => server.close(error => (error ? reject(error) : resolve())))
})

test('exchangeSession sends integration secret and directory fields without password', async () => {
  calls.length = 0
  const client = new WeknoraClient({ ...config, baseUrl })
  const session = await client.exchangeSession({ subject: 'sub-1', aiHubUserId: 'hub-1' })
  assert.equal(session.accessToken, 'user-token')
  assert.equal(calls[0]?.auth, `Bearer ${secret}`)
  assert.deepEqual(calls[0]?.body, { ai_hub_user_id: 'hub-1', subject: 'sub-1' })
  assert.equal('password' in (calls[0]?.body as object), false)
})

test('exchangeSession maps account_not_provisioned', async () => {
  const client = new WeknoraClient({ ...config, baseUrl })
  await assert.rejects(
    () => client.exchangeSession({ subject: 'missing' }),
    error => error instanceof WeknoraAccountNotProvisionedError,
  )
})

test('redeemBindCode posts bind_code only', async () => {
  calls.length = 0
  const client = new WeknoraClient({ ...config, baseUrl })
  const result = await client.redeemBindCode('code-1')
  assert.equal(result.userId, 'wk-bind')
  assert.deepEqual(calls.at(-1)?.body, { bind_code: 'code-1' })
})

test('listKnowledgeBases uses user token and maps camelCase fields', async () => {
  const client = new WeknoraClient({ ...config, baseUrl })
  const session = await client.exchangeSession({ subject: 'ok' })
  const list = await client.listKnowledgeBases(session.accessToken)
  assert.deepEqual(list, [{ id: 'kb-1', name: '手册', description: '说明' }])
})
