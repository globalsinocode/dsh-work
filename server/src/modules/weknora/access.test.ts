import assert from 'node:assert/strict'
import { test } from 'node:test'

import { RequestError } from '../../domain/request-errors.ts'
import {
  WeknoraAccessService,
  type WeknoraIdentityContext,
} from './access.ts'
import {
  WeknoraAccountNotProvisionedError,
  type WeknoraClient,
  type WeknoraSession,
} from './client.ts'
import type { WeknoraLinkStore, WeknoraUserLink } from './link-store.ts'

const config = { baseUrl: 'http://example', integrationSecret: 'secret' }

class MemoryLinks implements Pick<WeknoraLinkStore, 'findByUserId' | 'upsert' | 'delete' | 'saveBindState' | 'consumeBindState' | 'purgeExpiredBindStates'> {
  rows = new Map<string, WeknoraUserLink>()

  async findByUserId(userId: string) {
    return this.rows.get(userId) ?? null
  }

  async upsert(userId: string, weknoraUserId: string, linkSource: WeknoraUserLink['linkSource']) {
    this.rows.set(userId, { userId, weknoraUserId, linkSource })
  }

  async delete(userId: string) {
    this.rows.delete(userId)
  }

  async saveBindState() {}
  async consumeBindState() { return null }
  async purgeExpiredBindStates() {}
}

class FakeClient implements Pick<WeknoraClient, 'exchangeSession' | 'startBind' | 'redeemBindCode' | 'listKnowledgeBases'> {
  sessions = 0

  async exchangeSession(input: { subject?: string; userId?: string }): Promise<WeknoraSession> {
    this.sessions += 1
    if (input.subject === 'missing') throw new WeknoraAccountNotProvisionedError()
    if (input.userId === 'wk-bind') {
      return { userId: 'wk-bind', tenantId: 1, accessToken: `token-${this.sessions}`, expiresIn: 3600 }
    }
    return { userId: 'wk-dir', tenantId: 1, accessToken: `token-${this.sessions}`, expiresIn: 3600 }
  }

  async startBind() { return { url: 'https://kb/bind' } }
  async redeemBindCode() { return { userId: 'wk-bind' } }
  async listKnowledgeBases(accessToken: string) {
    return [{ id: 'kb', name: accessToken }]
  }
}

const directory = { async loadExternalUserId() { return 'hub-1' } }

function aiHubIdentity(overrides: Partial<WeknoraIdentityContext> = {}): WeknoraIdentityContext {
  return {
    userId: 'u-1',
    subject: 'sub-1',
    identityProvider: 'ai-hub-oidc',
    externalUserId: 'hub-1',
    ...overrides,
  }
}

function localIdentity(): WeknoraIdentityContext {
  return {
    userId: 'u-local',
    subject: 'local',
    identityProvider: 'local-password',
    externalUserId: null,
  }
}

test('unconfigured access does not call WeKnora client', async () => {
  const client = new FakeClient()
  const service = new WeknoraAccessService(null, null, new MemoryLinks() as unknown as WeknoraLinkStore, directory)
  const status = await service.getStatus(aiHubIdentity())
  assert.equal(status.configured, false)
  assert.equal(client.sessions, 0)
})

test('directory link succeeds without bind row', async () => {
  const client = new FakeClient()
  const service = new WeknoraAccessService(
    config,
    client as unknown as WeknoraClient,
    new MemoryLinks() as unknown as WeknoraLinkStore,
    directory,
  )
  const status = await service.getStatus(aiHubIdentity())
  assert.equal(status.linked, true)
  assert.equal(status.source, 'directory')
})

test('directory missing with no bind stays unlinked', async () => {
  const client = new FakeClient()
  const service = new WeknoraAccessService(
    config,
    client as unknown as WeknoraClient,
    new MemoryLinks() as unknown as WeknoraLinkStore,
    directory,
  )
  const status = await service.getStatus(aiHubIdentity({ subject: 'missing' }))
  assert.equal(status.linked, false)
  assert.equal(status.directoryAccount, 'missing')
})

test('bind link uses stored weknora user id', async () => {
  const client = new FakeClient()
  const links = new MemoryLinks()
  await links.upsert('u-local', 'wk-bind', 'bind')
  const service = new WeknoraAccessService(
    config,
    client as unknown as WeknoraClient,
    links as unknown as WeknoraLinkStore,
    { async loadExternalUserId() { return null } },
  )
  const list = await service.withAccessToken(localIdentity(), token => client.listKnowledgeBases(token))
  assert.equal(list[0]?.name, 'token-1')
})

test('directory overrides conflicting bind row', async () => {
  const client = new FakeClient()
  const links = new MemoryLinks()
  await links.upsert('u-1', 'wk-bind', 'bind')
  const service = new WeknoraAccessService(
    config,
    client as unknown as WeknoraClient,
    links as unknown as WeknoraLinkStore,
    directory,
  )
  await service.withAccessToken(aiHubIdentity(), async () => 'ok')
  assert.equal((await links.findByUserId('u-1'))?.weknoraUserId, 'wk-dir')
})

test('not linked throws weknora_not_linked', async () => {
  const service = new WeknoraAccessService(
    config,
    new FakeClient() as unknown as WeknoraClient,
    new MemoryLinks() as unknown as WeknoraLinkStore,
    { async loadExternalUserId() { return null } },
  )
  await assert.rejects(
    () => service.withAccessToken(localIdentity(), async () => null),
    error => error instanceof RequestError && error.code === 'weknora_not_linked',
  )
})
