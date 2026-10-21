# Batch 1 Conversation and Run Reliability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make message/Run retries idempotent across uncertain network outcomes, eliminate empty or attachment-leaking Sessions, restore team discussions correctly, and automatically reconcile terminal/background Runs.

**Architecture:** Keep PostgreSQL as the Session/Run fact source and the existing Run/Attempt → Runtime Adapter → DSH execution chain. Add an explicit draft Session state plus a small client intent registry; reuse one attachment compensation path and one team composer path; use bounded refresh only to discover/reconcile Runs, never to execute Agents.

**Tech Stack:** Vue 3, Pinia, TypeScript, Fastify-style custom Router, Node test runner, Vitest, PostgreSQL, Playwright, pnpm.

---

## Scope and ownership

- Findings: F-06, F-11 message/Run portion, F-12, F-14, F-19, F-18 Run/recent-task portion.
- Integration branch: `dev`; start from the latest `dev` and land Batch 1 as a continuous, self-contained commit range after its Green gate passes.
- Reserved migration: `server/migrations/0084_session_drafts.sql`; if `0084` is occupied, rename to the next free number without changing SQL semantics.
- Do not edit automation lifecycle, file projection, notification schema, catalog version selection, exports, or admin authorization refresh.

## File map

- Create `apps/workbench-web/src/utils/idempotent-intent.ts`: stable key lifecycle and uncertain-error classification.
- Create `apps/workbench-web/src/utils/idempotent-intent.test.ts`: deterministic key reuse/rotation tests.
- Create `server/migrations/0084_session_drafts.sql`: additive draft state and intent index.
- Modify `server/src/modules/workbench/application/postgres-conversation-repository.ts`: draft creation/activation/safe discard and hidden-list filtering.
- Modify `server/src/modules/run/run-orchestration-service.ts`: activate draft after committed message/Run and expose safe discard.
- Modify `server/src/http/workbench/conversation-routes.ts`: intent-aware Session responses and discard route.
- Modify `apps/workbench-web/src/stores/tasks.ts`: stable intents, shared upload compensation, bounded reconciliation, explicit refresh.
- Modify `apps/workbench-web/src/views/SessionResumeView.vue`: reuse Store actions and team composer behavior.
- Modify `apps/workbench-web/src/components/ConversationStarter.vue`: retain draft Session and retry the same intent.
- Modify `apps/workbench-web/src/api/client.ts` and `apps/workbench-web/src/types/domain.ts`: draft/replay contracts.
- Test `apps/workbench-web/src/stores/tasks.test.ts`, `apps/workbench-web/src/views/SessionResumeView.test.ts`, `server/src/http/team-workspace-discussion-api.integration.test.ts`, `server/src/infrastructure/postgres/m3-orchestration.integration.test.ts`.
- Modify `e2e/TEST-CATALOG.md`; create `e2e/conversation-reliability.integration.spec.ts` and `playwright.conversation-reliability.config.ts`.

### Task 1: Record acceptance journeys before implementation

**Files:**
- Modify: `e2e/TEST-CATALOG.md`

- [ ] **Step 1: Add six P1 journey records**

Add records `CR-01` through `CR-06` with these observable outcomes:

```markdown
| CR-01 | P1 | employee | 服务端已提交但响应丢失后重试讨论 | 同一 Session、同一意图键 | 发送讨论；代理丢弃首次响应；点击重试 | 线程只有一条消息，响应返回同一 messageId |
| CR-02 | P1 | employee | 服务端已提交但响应丢失后重试 Run | 可用 Agent 与受控 Runtime | 启动 Run；丢弃响应；点击重试 | 只有一个 Run/Attempt，未重复扣费或执行 |
| CR-03 | P1 | employee | 新会话首步失败不污染历史 | 附件上传或 Run 受理失败 | 新建任务并触发失败；返回历史 | 草稿不出现在历史；重试沿用同一 Session |
| CR-04 | P1 | team member | 团队纯讨论恢复 | 无 Run 的团队 Session | 从历史打开；发普通讨论；再选择 @Agent | 讨论不产生 Run；@Agent 只产生一个 Run |
| CR-05 | P1 | employee | 部分附件失败补偿 | 两个附件，第二个失败 | 从恢复页提交 | 第一个附件被安全移除，输入仍可重试 |
| CR-06 | P1 | employee | 终态快照瞬时失败恢复 | SSE 已终态，首次 GET Run 失败 | 等待自动恢复 | 最终回答、成果、token 与终态一致 |
```

- [ ] **Step 2: Check catalog formatting**

Run: `pnpm verify project`

Expected: PASS; catalog links and referenced spec/config names are accepted.

- [ ] **Step 3: Commit the acceptance specification**

```bash
git add e2e/TEST-CATALOG.md
git commit -m "test: specify conversation reliability journeys"
```

### Task 2: Add explicit draft Session persistence

**Files:**
- Create: `server/migrations/0084_session_drafts.sql`
- Modify: `server/src/modules/workbench/application/postgres-conversation-repository.ts`
- Test: `server/src/http/team-workspace-sessions-api.integration.test.ts`

- [ ] **Step 1: Write failing integration assertions**

Add a test that creates a draft Session and proves history hides it until activation:

```ts
test('draft Session is hidden until first committed message or Run', async () => {
  const created = await api('POST', '/api/workbench/v1/sessions', {
    as: 'U00001',
    body: { title: '网络恢复测试', clientIntentId: 'intent-session-1' },
  })
  assert.equal(created.status, 201)
  assert.equal(created.body.data.status, 'draft')
  assert.equal((await listHistory('U00001')).some(item => item.sessionId === created.body.data.id), false)

  const posted = await api('POST', `/api/workbench/v1/sessions/${created.body.data.id}/messages`, {
    as: 'U00001',
    body: { content: '确认需求', idempotencyKey: 'intent-message-1' },
  })
  assert.equal(posted.status, 201)
  assert.equal((await listHistory('U00001')).some(item => item.sessionId === created.body.data.id), true)
})
```

- [ ] **Step 2: Run the test and observe the contract failure**

Run: `pnpm test:m5:sessions:integration`

Expected: FAIL because `clientIntentId`/`draft` is not persisted and the Session appears immediately.

- [ ] **Step 3: Add the additive migration**

Create the migration with these exact invariants:

```sql
alter table sessions drop constraint if exists sessions_status_check;
alter table sessions add constraint sessions_status_check
  check (status in ('draft', 'active', 'archived'));
alter table sessions add column if not exists client_intent_id text;
create unique index if not exists sessions_creator_intent_unique
  on sessions (tenant_id, created_by, client_intent_id)
  where client_intent_id is not null;
create index if not exists sessions_draft_created_at_idx
  on sessions (tenant_id, created_at)
  where status = 'draft';
```

- [ ] **Step 4: Implement repository methods and filters**

Add these methods/signatures and make all history/recent queries require `s.status = 'active'`:

```ts
createSession(input: {
  userId: string
  title: string
  workspaceId: string
  agentVersionId?: string | null
  selectedSkillVersionId?: string
  clientIntentId?: string
  initialStatus?: 'draft' | 'active'
}): Promise<SessionRecord>

activateSession(sessionId: string, transaction?: DatabaseTransaction): Promise<boolean>

discardEmptyDraftSession(input: {
  sessionId: string
  userId: string
  clientIntentId: string
}): Promise<boolean>
```

`discardEmptyDraftSession` must delete only when status is draft and `not exists` checks confirm zero messages, Runs and Session files in the same transaction.

- [ ] **Step 5: Run migration/session integration tests**

Run: `pnpm test:m5:sessions:integration`

Expected: PASS, including draft hidden/activation and unsafe discard refusal.

- [ ] **Step 6: Commit draft persistence**

```bash
git add server/migrations/0084_session_drafts.sql server/src/modules/workbench/application/postgres-conversation-repository.ts server/src/http/team-workspace-sessions-api.integration.test.ts
git commit -m "feat: add recoverable draft sessions"
```

### Task 3: Preserve one idempotency key per user intent

**Files:**
- Create: `apps/workbench-web/src/utils/idempotent-intent.ts`
- Create: `apps/workbench-web/src/utils/idempotent-intent.test.ts`
- Modify: `apps/workbench-web/src/utils/request-error.ts`

- [ ] **Step 1: Write failing utility tests**

```ts
import { describe, expect, it } from 'vitest'
import { createIntentRegistry } from './idempotent-intent'

describe('idempotent intent registry', () => {
  it('reuses a key after an uncertain failure and rotates after success', () => {
    const keys = ['key-1', 'key-2']
    const registry = createIntentRegistry(() => keys.shift()!)
    const first = registry.begin('run:session-1', 'fingerprint-a')
    registry.markUncertain('run:session-1', first.key)
    expect(registry.begin('run:session-1', 'fingerprint-a').key).toBe('key-1')
    registry.complete('run:session-1', first.key)
    expect(registry.begin('run:session-1', 'fingerprint-a').key).toBe('key-2')
  })

  it('rejects key reuse when the request fingerprint changes', () => {
    const registry = createIntentRegistry(() => 'key-1')
    registry.begin('message:session-1', 'body-a')
    expect(() => registry.begin('message:session-1', 'body-b')).toThrow('意图内容已变化')
  })
})
```

- [ ] **Step 2: Run the new test**

Run: `pnpm --filter @dsh-work/workbench-web test -- idempotent-intent.test.ts`

Expected: FAIL because the module does not exist.

- [ ] **Step 3: Implement the registry**

Implement exactly this public API; store only opaque keys/fingerprints, never prompt text:

```ts
export interface IntentHandle { key: string; fingerprint: string }
export interface IntentRegistry {
  begin(slot: string, fingerprint: string): IntentHandle
  markUncertain(slot: string, key: string): void
  complete(slot: string, key: string): void
  clear(slot: string): void
}

export function createIntentRegistry(generate = () => crypto.randomUUID()): IntentRegistry

export function isUncertainRequestFailure(error: unknown): boolean {
  return error instanceof TypeError
    || (error instanceof RequestError && [0, 502, 503, 504].includes(error.status))
}
```

Use a `Map<string, { key; fingerprint; state: 'pending' | 'uncertain' }>`; `begin` reuses pending/uncertain only for the same fingerprint, `complete` and `clear` delete the slot.

- [ ] **Step 4: Run utility tests**

Run: `pnpm --filter @dsh-work/workbench-web test -- idempotent-intent.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit the utility**

```bash
git add apps/workbench-web/src/utils/idempotent-intent.ts apps/workbench-web/src/utils/idempotent-intent.test.ts apps/workbench-web/src/utils/request-error.ts
git commit -m "feat: retain idempotency keys for uncertain retries"
```

### Task 4: Wire draft and stable-intent contracts through API and Store

**Files:**
- Modify: `server/src/modules/run/run-orchestration-service.ts`
- Modify: `server/src/http/workbench/conversation-routes.ts`
- Modify: `apps/workbench-web/src/api/client.ts`
- Modify: `apps/workbench-web/src/types/domain.ts`
- Modify: `apps/workbench-web/src/stores/tasks.ts`
- Test: `apps/workbench-web/src/stores/tasks.test.ts`

- [ ] **Step 1: Add failing Store tests for ambiguous retry**

```ts
it('reuses the Run idempotency key after an uncertain response', async () => {
  const { useTaskStore } = await import('./tasks')
  api.startRun.mockRejectedValueOnce(new TypeError('network lost')).mockResolvedValueOnce(baseTask)
  const store = useTaskStore()
  await expect(store.startRunWithSessionFiles('session-001', { prompt: '分析', attachments: [] })).rejects.toThrow()
  await store.startRunWithSessionFiles('session-001', { prompt: '分析', attachments: [] })
  expect(api.startRun.mock.calls[0]![1].idempotencyKey).toBe(api.startRun.mock.calls[1]![1].idempotencyKey)
})
```

- [ ] **Step 2: Run the Store test**

Run: `pnpm --filter @dsh-work/workbench-web test -- tasks.test.ts`

Expected: FAIL because each call creates a new UUID.

- [ ] **Step 3: Extend API types**

Use these request/response fields:

```ts
type SessionStatus = 'draft' | 'active' | 'archived'
interface SessionCreateInput {
  title: string
  workspaceId?: string
  agentId?: string
  skillId?: string
  workspaceAgentMemberId?: string
  clientIntentId: string
}
interface SessionCreateResult extends SessionRecord {
  status: SessionStatus
  replayed: boolean
}
```

Add `discardDraftSession(sessionId, clientIntentId)` to `workbenchApi`.

- [ ] **Step 4: Activate only after durable content**

In `postDiscussionMessage`, activate the Session in the same database transaction that inserts the first message. In `startRun`, activate after the idempotent Run and user message are committed. A replay must return the existing resource and leave the Session active.

- [ ] **Step 5: Replace inline UUID creation**

In `tasks.ts`, use one module-level registry and slots `message:${sessionId}` / `run:${sessionId}`. Compute the fingerprint from normalized prompt plus sorted file IDs and selected Agent member ID; never persist raw prompt in the registry.

- [ ] **Step 6: Run server and Store tests**

Run: `pnpm test:m3:integration && pnpm --filter @dsh-work/workbench-web test -- tasks.test.ts`

Expected: PASS; duplicate calls return one Run/message and draft activation is idempotent.

- [ ] **Step 7: Commit contract wiring**

```bash
git add server/src/modules/run/run-orchestration-service.ts server/src/http/workbench/conversation-routes.ts apps/workbench-web/src/api/client.ts apps/workbench-web/src/types/domain.ts apps/workbench-web/src/stores/tasks.ts apps/workbench-web/src/stores/tasks.test.ts
git commit -m "feat: bind retries to stable conversation intents"
```

### Task 5: Unify attachment compensation and team Session recovery

**Files:**
- Modify: `apps/workbench-web/src/stores/tasks.ts`
- Modify: `apps/workbench-web/src/views/SessionResumeView.vue`
- Create: `apps/workbench-web/src/views/SessionResumeView.test.ts`
- Modify: `apps/workbench-web/src/components/team-space-composer/team-space-composer.vue`

- [ ] **Step 1: Write failing view tests**

Cover partial upload cleanup and team member forwarding:

```ts
it('delegates resume uploads to the compensated Store action', async () => {
  await wrapper.get('[aria-label="发送消息"]').trigger('click')
  expect(taskStore.startRunWithSessionFiles).toHaveBeenCalledWith('session-team', expect.objectContaining({
    workspaceAgentMemberId: 'member-agent-1',
  }))
  expect(api.uploadSessionFile).not.toHaveBeenCalled()
})

it('posts a team discussion without starting a Run when no Agent is mentioned', async () => {
  await submit({ prompt: '确认发布时间', files: [] })
  expect(taskStore.postSessionMessage).toHaveBeenCalledWith('session-team', '确认发布时间')
  expect(taskStore.startRunWithSessionFiles).not.toHaveBeenCalled()
})
```

- [ ] **Step 2: Run the new tests**

Run: `pnpm --filter @dsh-work/workbench-web test -- SessionResumeView.test.ts`

Expected: FAIL because the view uploads directly and has no Agent selection path.

- [ ] **Step 3: Expose one compensated Store action**

Keep this single signature in `tasks.ts`:

```ts
startRunWithSessionFiles(sessionId: string, input: {
  prompt: string
  attachments: File[]
  referencedFileIds?: string[]
  workspaceAgentMemberId?: string
}): Promise<TaskRun>
```

On any upload/start failure or generation change, call `discardSessionFiles` with every successfully uploaded ID before rethrowing. Do not delete referenced workspace logical files.

- [ ] **Step 4: Replace `SessionResumeView` submit branching**

For team Sessions, render the existing team composer contract. When no Agent member is selected call `postSessionMessage`; when selected call `startRunWithSessionFiles`. For personal Sessions call `startRunWithSessionFiles` with no member ID.

- [ ] **Step 5: Run view and Store tests**

Run: `pnpm --filter @dsh-work/workbench-web test -- SessionResumeView.test.ts tasks.test.ts`

Expected: PASS, including route-change cleanup and viewer read-only behavior.

- [ ] **Step 6: Commit recovery flow**

```bash
git add apps/workbench-web/src/stores/tasks.ts apps/workbench-web/src/views/SessionResumeView.vue apps/workbench-web/src/views/SessionResumeView.test.ts apps/workbench-web/src/components/team-space-composer/team-space-composer.vue
git commit -m "fix: reuse compensated team session recovery"
```

### Task 6: Reconcile terminal and background Runs

**Files:**
- Modify: `apps/workbench-web/src/stores/tasks.ts`
- Modify: `apps/workbench-web/src/layouts/EmployeeShell.vue`
- Test: `apps/workbench-web/src/stores/tasks.test.ts`

- [ ] **Step 1: Add failing reconciliation tests**

```ts
it('retries a transient GET after terminal SSE before closing the stream', async () => {
  api.getRun.mockRejectedValueOnce(new TypeError('temporary')).mockResolvedValueOnce({
    ...baseTask, status: 'succeeded', messages: [{ id: 'answer', role: 'assistant', content: '完成' }],
  })
  const store = useTaskStore()
  await store.loadTask('run-001')
  FakeEventSource.instances[0]!.emit('run.completed', terminalEvent)
  await vi.waitFor(() => expect(api.getRun).toHaveBeenCalledTimes(2))
  expect(store.getTask('run-001')?.messages.at(-1)?.content).toBe('完成')
})

it('refresh discovers a Run created by another tab and subscribes to it', async () => {
  api.getTasks.mockResolvedValueOnce([]).mockResolvedValueOnce([baseTask])
  const store = useTaskStore()
  await store.load()
  await store.refresh()
  expect(store.getTask('run-001')).toBeDefined()
  expect(FakeEventSource.instances.at(-1)?.url).toBe('/events/run-001')
})
```

- [ ] **Step 2: Run Store tests**

Run: `pnpm --filter @dsh-work/workbench-web test -- tasks.test.ts`

Expected: FAIL on first-error early return and missing `refresh()`.

- [ ] **Step 3: Implement bounded retry and refresh**

`settleRunSnapshot` must retry both stale projections and uncertain GET failures up to six attempts with existing `120 * (attempt + 1)` backoff. Add `refresh()` that always calls `getTasks`, merges by Run ID, removes only server-confirmed absent terminal rows according to current policy, and subscribes newly discovered active Runs.

- [ ] **Step 4: Add visibility refresh**

`EmployeeShell.vue` registers one `visibilitychange` listener; when `document.visibilityState === 'visible'`, call `taskStore.refresh()` and report failure without clearing existing tasks. Remove the listener on unmount.

- [ ] **Step 5: Run Store and shell tests**

Run: `pnpm test:m5:frontend`

Expected: PASS; no leaked EventSource or visibility listeners.

- [ ] **Step 6: Commit reconciliation**

```bash
git add apps/workbench-web/src/stores/tasks.ts apps/workbench-web/src/stores/tasks.test.ts apps/workbench-web/src/layouts/EmployeeShell.vue
git commit -m "fix: reconcile terminal and background runs"
```

### Task 7: Add PostgreSQL and browser regression coverage

**Files:**
- Modify: `server/src/http/team-workspace-discussion-api.integration.test.ts`
- Modify: `server/src/infrastructure/postgres/m3-orchestration.integration.test.ts`
- Create: `e2e/conversation-reliability.integration.spec.ts`
- Create: `playwright.conversation-reliability.config.ts`

- [ ] **Step 1: Add integration fault cases**

Prove same-key duplicate requests return identical IDs, different fingerprints conflict, draft discard refuses non-empty Sessions, and team recovery requires a current Agent member.

- [ ] **Step 2: Run integration tests**

Run: `pnpm test:m3:integration && pnpm test:m5:sessions:integration`

Expected: PASS against disposable PostgreSQL.

- [ ] **Step 3: Implement the Playwright journey**

The spec must use a dedicated database/runtime fixture and conditional assertions, not fixed sleeps:

```ts
test('team discussion recovers and starts exactly one mentioned Agent Run', async ({ page }) => {
  await page.goto('/history')
  await page.getByRole('button', { name: /发布排期讨论/ }).click()
  await page.getByRole('textbox', { name: '任务描述' }).fill('确认发布时间')
  await page.getByRole('button', { name: '发送' }).click()
  await expect(page.getByText('确认发布时间')).toHaveCount(1)
  await page.getByRole('button', { name: /选择 Agent/ }).click()
  await page.getByRole('option', { name: /发布助手/ }).click()
  await page.getByRole('button', { name: '发送' }).click()
  await expect(page.getByText(/运行中|已完成/)).toHaveCount(1)
})
```

- [ ] **Step 4: Run the dedicated browser suite**

Run: `pnpm exec playwright test --config playwright.conversation-reliability.config.ts`

Expected: PASS with a disposable PostgreSQL database and controlled Runtime; no production/development business database connection.

- [ ] **Step 5: Commit regression coverage**

```bash
git add server/src/http/team-workspace-discussion-api.integration.test.ts server/src/infrastructure/postgres/m3-orchestration.integration.test.ts e2e/conversation-reliability.integration.spec.ts playwright.conversation-reliability.config.ts
git commit -m "test: cover conversation retry and recovery faults"
```

### Task 8: Verify and package Batch 1 independently

**Files:**
- Modify: `docs/development/openapi-workbench.json`
- Create: `docs/release/2026-10-21-b1-conversation-reliability-acceptance.md`

- [ ] **Step 1: Update OpenAPI and acceptance evidence fields**

Document draft status, client intent, discard endpoint, replay result, compatibility, migration, rollback and P0/P1/P2 evidence slots. Do not claim P2 until collected.

- [ ] **Step 2: Run focused verification**

Run: `pnpm test:m3:integration && pnpm test:m5:sessions:integration && pnpm test:m5:frontend`

Expected: PASS.

- [ ] **Step 3: Run repository gates**

Run: `pnpm verify && pnpm check:architecture && pnpm typecheck && pnpm lint && pnpm build`

Expected: all commands exit 0; architecture output confirms no second Agent execution path.

- [ ] **Step 4: Run P0 and the dedicated P1 suite**

Run: `pnpm test:e2e && pnpm exec playwright test --config playwright.conversation-reliability.config.ts`

Expected: PASS; record P0 and P1 separately.

- [ ] **Step 5: Commit release evidence**

```bash
git add docs/development/openapi-workbench.json docs/release/2026-10-21-b1-conversation-reliability-acceptance.md
git commit -m "docs: record batch 1 acceptance contract"
```

## Independent rollback

1. Stop admitting new Batch 1 Release traffic and atomically switch both frontends/API back to the prior Release.
2. Leave `0084` applied; old queries continue to see active/archived Sessions and ignore draft rows.
3. Do not delete draft Sessions during rollback. Run a read-only count and preserve them for the next forward deployment.
4. Confirm old Release health and Run queue recovery; do not bypass DSH for interrupted work.
