# Batch 4 Automation Lifecycle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make automation archival reversible, preserve audit history, paginate all executions, retain idempotency across uncertain manual triggers, and refresh running execution status without leaking timers.

**Architecture:** Reuse the existing `disabled` database state as product-level archived state, add explicit archive metadata and a restore transition that revalidates authorization. Keep Run/Attempt/DSH unchanged; the UI consumes cursor pages and uses visibility-aware polling only while nonterminal executions are displayed.

**Tech Stack:** PostgreSQL, TypeScript, automation application service/repository, Vue 3, Element Plus, Vitest, Node test runner, Playwright, pnpm.

---

## Scope and ownership

- Findings: F-11 automation portion, F-15, F-16, F-18 automation portion.
- Integration branch: `dev`; start from the latest `dev` and land Batch 4 as a continuous, self-contained commit range after its Green gate passes.
- Reserved migration: `server/migrations/0087_automation_archive_metadata.sql`; renumber if occupied.
- Do not modify conversation Task Store, notifications, files, catalog selection, exports or auth refresh.

## File map

- Create `server/migrations/0087_automation_archive_metadata.sql`.
- Modify `server/src/modules/automation/automation-types.ts`, `postgres-automation-repository.ts`, `automation-service.ts`.
- Modify `server/src/http/workbench/automation-routes.ts`, OpenAPI and integration tests.
- Create `apps/workbench-web/src/stores/automation-intents.ts` and test.
- Modify `apps/workbench-web/src/views/AutomationsView.vue`, API/domain types; create/extend view tests.
- Modify P0 smoke routes/fixtures for compatibility.
- Extend existing automation P1 Playwright suite.

### Task 1: Specify automation acceptance journeys

**Files:**
- Modify: `e2e/TEST-CATALOG.md`

- [ ] **Step 1: Add `AU-01` through `AU-05`**

```markdown
| AU-01 | P1 | employee | 归档和恢复自动任务 | 已启用任务及历史 | 归档；切到归档筛选；恢复 | 默认列表隐藏、历史可读、恢复后为 paused |
| AU-02 | P1 | employee | 超过 50 条历史分页 | 75 条执行 | 连续加载更多 | 75 条不重不漏且 hasMore 最终 false |
| AU-03 | P1 | employee | 执行抽屉自动收敛 | running execution | 保持抽屉打开 | 状态变终态，取消按钮消失，轮询停止 |
| AU-04 | P1 | employee | 手工触发响应丢失重试 | 服务端受理后丢弃响应 | 点击重试同一意图 | 只产生一个 execution/Run |
| AU-05 | P1 | employee | 恢复时重新授权 | 归档后撤销 workspace/Agent 权限 | 点击恢复 | 明确拒绝，任务保持 archived |
```

- [ ] **Step 2: Validate and commit catalog**

Run: `pnpm verify project`

Expected: PASS.

```bash
git add e2e/TEST-CATALOG.md
git commit -m "test: specify automation lifecycle journeys"
```

### Task 2: Add archive metadata and repository projections

**Files:**
- Create: `server/migrations/0087_automation_archive_metadata.sql`
- Modify: `server/src/modules/automation/automation-types.ts`
- Modify: `server/src/modules/automation/postgres-automation-repository.ts`
- Test: `server/src/infrastructure/postgres/automation.integration.test.ts`

- [ ] **Step 1: Add failing repository tests**

```ts
test('archived automation remains queryable with history', async () => {
  const archived = await service.archive(ownerId, automationId)
  assert.equal(archived.status, 'disabled')
  assert.ok(archived.archivedAt)
  assert.equal((await service.listMine(ownerId, { status: 'archived' })).length, 1)
  assert.equal((await service.listExecutions(ownerId, automationId, { limit: 20 })).items.length, 1)
})
```

- [ ] **Step 2: Run automation integration**

Run: `pnpm test:automation:integration`

Expected: FAIL because disabled tasks are filtered/404.

- [ ] **Step 3: Add migration**

```sql
alter table agent_automations add column if not exists archived_at timestamptz;
alter table agent_automations add column if not exists archived_by text;
create index if not exists agent_automations_owner_status_created_idx
  on agent_automations (tenant_id, owner_user_id, status, created_at desc);
```

- [ ] **Step 4: Add repository filters without renaming stored status**

```ts
listByOwner(ownerUserId: string, input?: { status?: 'active' | 'archived' }): Promise<AutomationRecord[]>
archive(id: string, ownerUserId: string, actorUserId: string, tx?: DatabaseTransaction): Promise<AutomationRecord>
restoreArchived(id: string, ownerUserId: string, tx?: DatabaseTransaction): Promise<AutomationRecord>
```

`active` excludes disabled; `archived` includes only disabled. `getByIdForOwner` no longer hides disabled; service methods decide allowed transitions.

- [ ] **Step 5: Run integration and commit**

Run: `pnpm test:automation:integration`

Expected: repository-level archive/list/history assertions PASS.

```bash
git add server/migrations/0087_automation_archive_metadata.sql server/src/modules/automation/automation-types.ts server/src/modules/automation/postgres-automation-repository.ts server/src/infrastructure/postgres/automation.integration.test.ts
git commit -m "feat: preserve archived automation records"
```

### Task 3: Implement archive/restore application transitions

**Files:**
- Modify: `server/src/modules/automation/automation-service.ts`
- Modify: `server/src/http/workbench/automation-routes.ts`
- Test: `server/src/infrastructure/postgres/automation.integration.test.ts`

- [ ] **Step 1: Add failing authorization transition tests**

Assert archive keeps history, restore sets `paused`, restore of non-archived conflicts, and current workspace/Agent/scope revocation rejects restore without changing state.

- [ ] **Step 2: Run integration**

Run: `pnpm test:automation:integration`

Expected: FAIL because restore/archive semantics are absent.

- [ ] **Step 3: Implement service methods**

```ts
async archive(ownerUserId: string, automationId: string): Promise<AutomationRecord>
async restore(ownerUserId: string, automationId: string, roleIds: string[]): Promise<AutomationRecord>
```

Archive cancels only future scheduling and leaves already-started Run behavior unchanged. Restore calls the same current identity, workspace, Agent version and scope-ceiling validation used by enable, then transitions to `paused`; user must explicitly enable scheduling.

- [ ] **Step 4: Add routes**

Use `POST /automations/:automationId/archive` and `POST /automations/:automationId/restore`. Keep old DELETE route for one compatibility window but make it call archive and return a deprecation header.

- [ ] **Step 5: Run integration and commit**

Run: `pnpm test:automation:integration`

Expected: PASS.

```bash
git add server/src/modules/automation/automation-service.ts server/src/http/workbench/automation-routes.ts server/src/infrastructure/postgres/automation.integration.test.ts
git commit -m "feat: restore archived automations with authorization checks"
```

### Task 4: Add stable cursor pagination to executions

**Files:**
- Modify: `server/src/modules/automation/postgres-automation-repository.ts`
- Modify: `server/src/modules/automation/automation-service.ts`
- Modify: `server/src/http/workbench/automation-routes.ts`
- Modify: `apps/workbench-web/src/types/domain.ts`
- Modify: `apps/workbench-web/src/api/client.ts`
- Test: `server/src/infrastructure/postgres/automation.integration.test.ts`

- [ ] **Step 1: Add a failing 75-row pagination test**

```ts
const first = await service.listExecutions(ownerId, automationId, { limit: 50 })
assert.equal(first.items.length, 50)
assert.equal(first.hasMore, true)
const second = await service.listExecutions(ownerId, automationId, { limit: 50, cursor: first.nextCursor! })
assert.equal(second.items.length, 25)
assert.equal(new Set([...first.items, ...second.items].map(item => item.id)).size, 75)
assert.equal(second.hasMore, false)
```

- [ ] **Step 2: Run integration**

Run: `pnpm test:automation:integration`

Expected: FAIL because the repository always limits to 50 and returns an array.

- [ ] **Step 3: Implement cursor page**

```ts
interface AutomationExecutionPage {
  items: AutomationExecution[]
  nextCursor: string | null
  hasMore: boolean
}
```

Encode cursor from `(created_at, id)`, query descending with a strict tuple boundary, clamp limit to 1–100, fetch `limit + 1`, and return no total count.

- [ ] **Step 4: Preserve compatibility**

The API returns the page envelope. Update P0 fixtures and all frontend callers in the same Release; document that mixing old/new frontend/API artifacts is unsupported.

- [ ] **Step 5: Run server/client tests and commit**

Run: `pnpm test:automation:integration && pnpm --filter @dsh-work/workbench-web test -- api/client.test.ts`

Expected: PASS.

```bash
git add server/src/modules/automation/postgres-automation-repository.ts server/src/modules/automation/automation-service.ts server/src/http/workbench/automation-routes.ts apps/workbench-web/src/types/domain.ts apps/workbench-web/src/api/client.ts server/src/infrastructure/postgres/automation.integration.test.ts server/src/testing/p0-smoke/workbench-routes.ts
git commit -m "feat: paginate automation execution history"
```

### Task 5: Retain manual-trigger intent keys

**Files:**
- Create: `apps/workbench-web/src/stores/automation-intents.ts`
- Create: `apps/workbench-web/src/stores/automation-intents.test.ts`
- Modify: `apps/workbench-web/src/views/AutomationsView.vue`

- [ ] **Step 1: Write failing intent tests**

```ts
it('reuses run-now key after an uncertain failure and rotates for explicit run again', () => {
  const store = useAutomationIntentStore()
  const first = store.begin('automation-1', 'run-now')
  store.markUncertain('automation-1', 'run-now', first)
  expect(store.begin('automation-1', 'run-now')).toBe(first)
  store.complete('automation-1', 'run-now', first)
  expect(store.begin('automation-1', 'run-now')).not.toBe(first)
})
```

- [ ] **Step 2: Run frontend test**

Run: `pnpm --filter @dsh-work/workbench-web test -- automation-intents.test.ts`

Expected: FAIL because the Store is absent.

- [ ] **Step 3: Implement local intent slots**

Key slots are `${automationId}:run-now` and `${automationId}:trial-run`; 502/503/504/network failures retain the key, definite 4xx clears it, accepted/skipped/interrupted completion clears it. UI action “再次运行” always creates a new key.

- [ ] **Step 4: Update view action calls and tests**

Replace inline `crypto.randomUUID()` with Store keys and show “重试本次请求” for uncertain outcomes.

- [ ] **Step 5: Run frontend tests and commit**

Run: `pnpm test:m5:frontend`

Expected: PASS.

```bash
git add apps/workbench-web/src/stores/automation-intents.ts apps/workbench-web/src/stores/automation-intents.test.ts apps/workbench-web/src/views/AutomationsView.vue
git commit -m "fix: retain automation trigger idempotency keys"
```

### Task 6: Build archived filter, paging and bounded status refresh

**Files:**
- Modify: `apps/workbench-web/src/views/AutomationsView.vue`
- Create: `apps/workbench-web/src/views/AutomationsView.test.ts`

- [ ] **Step 1: Write failing UI/timer tests**

```ts
it('loads archived tasks and restores to paused', async () => {
  await wrapper.get('[aria-label="任务状态筛选"]').setValue('archived')
  expect(api.listAutomations).toHaveBeenCalledWith({ status: 'archived' })
  await wrapper.getByRole('button', { name: '恢复' }).trigger('click')
  expect(api.restoreAutomation).toHaveBeenCalledWith('automation-1')
})

it('polls while a visible execution is nonterminal and stops at terminal', async () => {
  vi.useFakeTimers()
  api.listAutomationExecutions.mockResolvedValueOnce(runningPage).mockResolvedValueOnce(completedPage)
  await openDrawer()
  await vi.advanceTimersByTimeAsync(5_000)
  expect(api.listAutomationExecutions).toHaveBeenCalledTimes(2)
  await vi.advanceTimersByTimeAsync(10_000)
  expect(api.listAutomationExecutions).toHaveBeenCalledTimes(2)
})
```

- [ ] **Step 2: Run view tests**

Run: `pnpm --filter @dsh-work/workbench-web test -- AutomationsView.test.ts`

Expected: FAIL.

- [ ] **Step 3: Implement UI behavior**

Add active/archived filter, archive/restore wording, paginated “加载更多”, and a 5-second poll only when drawer visible, document visible and at least one execution is queued/running/waiting/cancel_requested. Clear timer on terminal, close, unmount, account reset and hidden document.

- [ ] **Step 4: Run frontend tests and commit**

Run: `pnpm test:m5:frontend`

Expected: PASS with zero pending fake timers.

```bash
git add apps/workbench-web/src/views/AutomationsView.vue apps/workbench-web/src/views/AutomationsView.test.ts
git commit -m "feat: restore and monitor archived automations"
```

### Task 7: Update OpenAPI and P1 automation E2E

**Files:**
- Modify: `docs/development/openapi-workbench.json`
- Modify: `e2e/automation.integration.spec.ts`
- Modify: `playwright.automation.config.ts`

- [ ] **Step 1: Document archive/restore/filter/page contracts**

Include compatibility DELETE behavior, cursor rules and stable manual-trigger idempotency.

- [ ] **Step 2: Add the five catalog journeys to E2E**

Use controlled scheduler/runtime and disposable PostgreSQL. Seed 75 executions directly through fixtures, not production APIs.

- [ ] **Step 3: Run contract and P1 tests**

Run: `pnpm test:unit src/http/openapi-coverage.test.ts && pnpm test:e2e:automation`

Expected: PASS.

- [ ] **Step 4: Commit tests/docs**

```bash
git add docs/development/openapi-workbench.json e2e/automation.integration.spec.ts playwright.automation.config.ts
git commit -m "test: cover automation archive and history lifecycle"
```

### Task 8: Verify and package Batch 4 independently

**Files:**
- Create: `docs/release/2026-10-21-b4-automation-lifecycle-acceptance.md`

- [ ] **Step 1: Record migration, pagination, polling and authorization evidence fields**

Include archived counts, execution page boundaries, timer cleanup, uncertain retry duplicate count and separate P0/P1/P2 status.

- [ ] **Step 2: Run gates**

Run: `pnpm test:automation:integration && pnpm test:m5:frontend && pnpm verify && pnpm check:architecture && pnpm typecheck && pnpm lint && pnpm build && pnpm test:e2e:automation`

Expected: all exit 0.

- [ ] **Step 3: Commit acceptance**

```bash
git add docs/release/2026-10-21-b4-automation-lifecycle-acceptance.md
git commit -m "docs: record batch 4 automation acceptance"
```

## Independent rollback

1. Switch frontend/API back atomically; leave `0087` applied.
2. Archived rows remain `disabled`, so old code continues to hide them and never schedules them.
3. Do not rewrite archived tasks to enabled during rollback.
4. Confirm scheduler claims no disabled tasks and existing in-flight Runs converge through the normal Run/Attempt path.
