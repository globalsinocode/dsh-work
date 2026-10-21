# Batch 3 Workspace Notifications Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver privacy-safe team discussion, mention and Run notifications with cross-workspace discovery, realtime refresh and cursor-based read state.

**Architecture:** Preserve `workspace_activities` as the shared workspace event log, add monotonic sequence plus per-recipient notification deliveries, and create deliveries in the same transaction as the source business event. Expose paginated account/workspace projections and one account-level SSE; clients use sequence watermarks rather than wall-clock timestamps.

**Tech Stack:** PostgreSQL, TypeScript, Node HTTP/SSE, Vue 3, Pinia, Element Plus, Node test runner, Vitest, Playwright, pnpm.

---

## Scope and ownership

- Findings: F-01, F-07, F-09.
- Integration branch: `dev`; start from the latest `dev` and land Batch 3 as a continuous, self-contained commit range after its Green gate passes.
- Reserved migration: `server/migrations/0086_workspace_notifications.sql`; renumber if occupied.
- Default recipients: discussion/reply → existing Session participants except actor; explicit member mention → mentioned member; Run terminal → requester; existing file/member events → authorized workspace members. No message/answer body is stored in notification metadata.
- Do not modify DSH execution, files, automation lifecycle, catalog versions, exports or auth refresh.

## File map

- Create `server/migrations/0086_workspace_notifications.sql`.
- Modify `server/src/modules/workbench/application/workspace-activity-writer.ts`.
- Modify `server/src/modules/workbench/application/postgres-workspace-activity-service.ts`.
- Create `server/src/modules/workbench/application/workspace-notification-recipient-service.ts` and tests.
- Modify conversation/Run terminal transaction hooks to write events through the activity writer.
- Modify `server/src/http/workbench/workspace-activity-routes.ts`; create account notification SSE route in the same module.
- Create `apps/workbench-web/src/stores/notifications.ts`, `NotificationInbox.vue` and tests.
- Modify `EmployeeShell.vue`, `WorkspacesView.vue`, `WorkspaceDetailView.vue`, API/domain types.
- Extend `team-workspace-activity-api.integration.test.ts`; create P1 notification E2E.

### Task 1: Specify notification acceptance journeys

**Files:**
- Modify: `e2e/TEST-CATALOG.md`

- [ ] **Step 1: Add `NT-01` through `NT-06`**

```markdown
| NT-01 | P1 | two team members | 新讨论通知参与者 | 已有共享 Session | A 发讨论 | B 收到一条通知，A 不收到自己通知，正文不进入 metadata |
| NT-02 | P1 | mentioned member | 明确 @成员 | 团队 Session | A @B | 只有 B 收到 mention 通知 |
| NT-03 | P1 | Run requester | Agent Run 终态 | 受控 Runtime | 启动并完成/失败 Run | 请求者收到对应终态通知 |
| NT-04 | P1 | employee | 跨空间发现 | 两个空间 | 停留空间 A，空间 B 产生事件 | 全局入口和 B 卡片未读数更新 |
| NT-05 | P1 | employee | 游标已读并发 | 已加载 sequence N | 标记到 N，同时提交 N+1 | N 已读，N+1 仍未读 |
| NT-06 | P1 | revoked member | 撤权后隐私 | 已有旧通知 | 撤销空间成员后打开通知 | 不泄露对象标题/摘要，入口不可访问 |
```

- [ ] **Step 2: Validate catalog and commit**

Run: `pnpm verify project`

Expected: PASS.

```bash
git add e2e/TEST-CATALOG.md
git commit -m "test: specify workspace notification journeys"
```

### Task 2: Add sequence and delivery schema

**Files:**
- Create: `server/migrations/0086_workspace_notifications.sql`
- Modify: `server/src/infrastructure/postgres/team-workspace-migration.integration.test.ts`

- [ ] **Step 1: Add a failing migration assertion**

Assert `workspace_activities.sequence` is non-null/unique, delivery rows reference activities, and watermark cannot be negative.

- [ ] **Step 2: Run migration integration**

Run: `pnpm test:integration src/infrastructure/postgres/team-workspace-migration.integration.test.ts`

Expected: FAIL because notification tables/columns do not exist.

- [ ] **Step 3: Create the additive migration**

```sql
create sequence if not exists workspace_activity_sequence;
alter table workspace_activities add column if not exists sequence bigint;
update workspace_activities set sequence = nextval('workspace_activity_sequence') where sequence is null;
alter table workspace_activities alter column sequence set default nextval('workspace_activity_sequence');
alter table workspace_activities alter column sequence set not null;
create unique index if not exists workspace_activities_sequence_unique
  on workspace_activities (tenant_id, sequence);

create table workspace_notification_deliveries (
  tenant_id text not null,
  activity_id text not null,
  recipient_user_id text not null,
  workspace_id text not null,
  sequence bigint not null,
  muted boolean not null default false,
  created_at timestamptz not null default now(),
  primary key (tenant_id, activity_id, recipient_user_id),
  foreign key (tenant_id, activity_id) references workspace_activities (tenant_id, id)
);
create index workspace_notification_recipient_sequence_idx
  on workspace_notification_deliveries (tenant_id, recipient_user_id, sequence desc);

alter table workspace_notification_reads add column if not exists last_read_sequence bigint not null default 0;
```

Extend the existing activity-kind CHECK with `discussion_posted`, `member_mentioned`, `run_completed`, `run_failed` while retaining every old kind.

- [ ] **Step 4: Run migration integration**

Run: `pnpm test:integration src/infrastructure/postgres/team-workspace-migration.integration.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit schema**

```bash
git add server/migrations/0086_workspace_notifications.sql server/src/infrastructure/postgres/team-workspace-migration.integration.test.ts
git commit -m "feat: add sequenced workspace notification deliveries"
```

### Task 3: Centralize event and recipient creation

**Files:**
- Modify: `server/src/modules/workbench/application/workspace-activity-writer.ts`
- Create: `server/src/modules/workbench/application/workspace-notification-recipient-service.ts`
- Create: `server/src/modules/workbench/application/workspace-notification-recipient-service.test.ts`

- [ ] **Step 1: Write recipient rule tests**

```ts
test('discussion excludes actor and deduplicates participants', async () => {
  participants.list.mockResolvedValue(['user-a', 'user-b', 'user-b'])
  assert.deepEqual(await service.resolve({ kind: 'discussion_posted', actorUserId: 'user-a', sessionId: 's1' }), ['user-b'])
})

test('mention targets only explicit current member', async () => {
  members.isCurrent.mockResolvedValue(true)
  assert.deepEqual(await service.resolve({ kind: 'member_mentioned', actorUserId: 'user-a', mentionedUserId: 'user-c' }), ['user-c'])
})

test('terminal Run targets requester only', async () => {
  assert.deepEqual(await service.resolve({ kind: 'run_failed', actorUserId: 'system', requestedBy: 'user-b' }), ['user-b'])
})
```

- [ ] **Step 2: Run the unit test**

Run: `pnpm test:unit src/modules/workbench/application/workspace-notification-recipient-service.test.ts`

Expected: FAIL because the service is absent.

- [ ] **Step 3: Implement closed event inputs**

```ts
export type WorkspaceNotifiableEvent =
  | { kind: 'discussion_posted'; workspaceId: string; sessionId: string; messageId: string; actorUserId: string }
  | { kind: 'member_mentioned'; workspaceId: string; sessionId: string; messageId: string; actorUserId: string; mentionedUserId: string }
  | { kind: 'run_completed' | 'run_failed'; workspaceId: string; sessionId: string; runId: string; requestedBy: string; actorUserId: 'system' }
```

The writer accepts only this closed type plus existing management events. Safe metadata contains IDs, kind and display actor/Agent name only; reject keys named `content`, `prompt`, `answer`, `filename` or `reasonText`.

- [ ] **Step 4: Insert activity and deliveries atomically**

Expose:

```ts
writeNotifiableEvent(event: WorkspaceNotifiableEvent, transaction: DatabaseTransaction): Promise<{ activityId: string; sequence: number }>
```

Insert one activity and `on conflict do nothing` delivery rows in the caller transaction.

- [ ] **Step 5: Run unit tests and commit**

Run: `pnpm test:unit src/modules/workbench/application/workspace-notification-recipient-service.test.ts`

Expected: PASS.

```bash
git add server/src/modules/workbench/application/workspace-activity-writer.ts server/src/modules/workbench/application/workspace-notification-recipient-service.ts server/src/modules/workbench/application/workspace-notification-recipient-service.test.ts
git commit -m "feat: resolve privacy-safe notification recipients"
```

### Task 4: Emit discussion, mention and Run terminal events

**Files:**
- Modify: `server/src/modules/run/run-orchestration-service.ts`
- Modify: `server/src/modules/workbench/application/postgres-conversation-repository.ts`
- Modify: `server/src/modules/run/postgres-run-repository.ts`
- Test: `server/src/http/team-workspace-discussion-api.integration.test.ts`
- Test: `server/src/infrastructure/postgres/m3-orchestration.integration.test.ts`

- [ ] **Step 1: Add failing transactional tests**

For a discussion transaction, assert one activity/delivery; roll back the transaction and assert neither remains. For terminal Run, assert one requester delivery and no answer text in metadata.

- [ ] **Step 2: Run focused integration tests**

Run: `pnpm test:m3:integration && pnpm test:m5:activity:integration`

Expected: FAIL because message/Run events are not emitted.

- [ ] **Step 3: Parse explicit mentions at the API boundary**

Add `mentionedUserIds?: string[]` to the discussion request; validate IDs are current workspace members and store mentions as relations/metadata IDs, not by parsing display text. The existing plain discussion contract remains valid with an empty list.

- [ ] **Step 4: Call the writer inside source transactions**

After inserting a new discussion message (`created === true`), emit `discussion_posted` and each deduplicated mention. On Run terminal transition, emit exactly once using the persisted terminal event ID as the idempotency source.

- [ ] **Step 5: Run integration tests and commit**

Run: `pnpm test:m3:integration && pnpm test:m5:activity:integration`

Expected: PASS; rollback leaves no orphan notification and replay creates no duplicate.

```bash
git add server/src/modules/run/run-orchestration-service.ts server/src/modules/workbench/application/postgres-conversation-repository.ts server/src/modules/run/postgres-run-repository.ts server/src/http/team-workspace-discussion-api.integration.test.ts server/src/infrastructure/postgres/m3-orchestration.integration.test.ts
git commit -m "feat: emit discussion and run notifications"
```

### Task 5: Replace time watermark with sequence APIs and account SSE

**Files:**
- Modify: `server/src/modules/workbench/application/postgres-workspace-activity-service.ts`
- Modify: `server/src/http/workbench/workspace-activity-routes.ts`
- Test: `server/src/http/team-workspace-activity-api.integration.test.ts`
- Modify: `docs/development/openapi-workbench.json`

- [ ] **Step 1: Add failing cursor/read tests**

```ts
const page = await api('GET', '/api/workbench/v1/notifications?limit=20', { as: memberId })
assert.equal(page.status, 200)
const visibleMax = page.body.data.items[0].sequence
await createConcurrentActivityAfterReadStarted()
await api('POST', '/api/workbench/v1/notifications/read', { as: memberId, body: { throughSequence: visibleMax } })
const unread = await api('GET', '/api/workbench/v1/notifications?unread=true', { as: memberId })
assert.equal(unread.body.data.items.length, 1)
assert.ok(unread.body.data.items[0].sequence > visibleMax)
```

- [ ] **Step 2: Run activity integration**

Run: `pnpm test:m5:activity:integration`

Expected: FAIL because APIs use `now()` and have no account inbox.

- [ ] **Step 3: Implement paginated projections**

```ts
listNotifications(input: { userId: string; workspaceId?: string; unreadOnly?: boolean; cursor?: string; limit: number }): Promise<NotificationPage>
markRead(input: { userId: string; throughSequence: number; workspaceId?: string }): Promise<{ lastReadSequence: number }>
countUnread(userId: string): Promise<{ total: number; byWorkspace: Record<string, number> }>
```

Before projecting each item, recheck current workspace read authorization. Unauthorized rows contribute neither content nor count.

- [ ] **Step 4: Add account SSE**

Expose `/notifications/events?since=<sequence>` with event ID equal to sequence. Send only safe invalidation/count payloads, support `Last-Event-ID`, heartbeat and disconnect cleanup. Do not stream message bodies.

- [ ] **Step 5: Run integration and OpenAPI coverage**

Run: `pnpm test:m5:activity:integration && pnpm test:unit src/http/openapi-coverage.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit APIs**

```bash
git add server/src/modules/workbench/application/postgres-workspace-activity-service.ts server/src/http/workbench/workspace-activity-routes.ts server/src/http/team-workspace-activity-api.integration.test.ts docs/development/openapi-workbench.json
git commit -m "feat: expose cursor-based notification inbox"
```

### Task 6: Build the employee notification projection

**Files:**
- Create: `apps/workbench-web/src/stores/notifications.ts`
- Create: `apps/workbench-web/src/stores/notifications.test.ts`
- Create: `apps/workbench-web/src/components/NotificationInbox.vue`
- Create: `apps/workbench-web/src/components/NotificationInbox.test.ts`
- Modify: `apps/workbench-web/src/api/client.ts`
- Modify: `apps/workbench-web/src/types/domain.ts`
- Modify: `apps/workbench-web/src/layouts/EmployeeShell.vue`
- Modify: `apps/workbench-web/src/views/WorkspacesView.vue`
- Modify: `apps/workbench-web/src/views/WorkspaceDetailView.vue`

- [ ] **Step 1: Write failing Store reconnect test**

```ts
it('refreshes counts and resumes from the last sequence', async () => {
  api.getNotificationCounts.mockResolvedValue({ total: 2, byWorkspace: { 'ws-b': 2 } })
  const store = useNotificationStore()
  await store.load()
  FakeEventSource.instances[0]!.emit('notification.changed', { sequence: 42 })
  await vi.waitFor(() => expect(api.getNotificationCounts).toHaveBeenCalledTimes(2))
  store.reconnect()
  expect(FakeEventSource.instances.at(-1)?.url).toContain('since=42')
})
```

- [ ] **Step 2: Run frontend tests**

Run: `pnpm --filter @dsh-work/workbench-web test -- notifications.test.ts NotificationInbox.test.ts`

Expected: FAIL because Store/component are absent.

- [ ] **Step 3: Implement Store and component**

Store owns `items`, `unreadTotal`, `unreadByWorkspace`, `lastSequence`, paging and one EventSource. Inbox marks read only through the highest rendered sequence. Shell badge uses `unreadTotal`; workspace cards use `unreadByWorkspace[id]`; detail refreshes its activity summary on matching event.

- [ ] **Step 4: Run frontend tests**

Run: `pnpm test:m5:frontend`

Expected: PASS; account switch closes SSE and clears counts.

- [ ] **Step 5: Commit frontend notification flow**

```bash
git add apps/workbench-web/src/stores/notifications.ts apps/workbench-web/src/stores/notifications.test.ts apps/workbench-web/src/components/NotificationInbox.vue apps/workbench-web/src/components/NotificationInbox.test.ts apps/workbench-web/src/api/client.ts apps/workbench-web/src/types/domain.ts apps/workbench-web/src/layouts/EmployeeShell.vue apps/workbench-web/src/views/WorkspacesView.vue apps/workbench-web/src/views/WorkspaceDetailView.vue
git commit -m "feat: surface realtime workspace notifications"
```

### Task 7: Add multi-role P1 browser coverage

**Files:**
- Create: `e2e/workspace-notifications.integration.spec.ts`
- Create: `playwright.workspace-notifications.config.ts`

- [ ] **Step 1: Implement two-context journeys**

Use separate authenticated contexts for actor/recipient. Verify discussion, mention, terminal Run, cross-space badge, sequence read race and revocation privacy with conditional waits.

- [ ] **Step 2: Run dedicated P1**

Run: `pnpm exec playwright test --config playwright.workspace-notifications.config.ts`

Expected: PASS with disposable PostgreSQL/controlled Runtime.

- [ ] **Step 3: Commit E2E**

```bash
git add e2e/workspace-notifications.integration.spec.ts playwright.workspace-notifications.config.ts
git commit -m "test: cover workspace notification delivery"
```

### Task 8: Verify and package Batch 3 independently

**Files:**
- Create: `docs/release/2026-10-21-b3-workspace-notifications-acceptance.md`

- [ ] **Step 1: Record event/recipient/privacy/sequence evidence fields**

Include delivery counts by kind, duplicate rate, SSE reconnect, authorization filtering, migration/rollback and separate P0/P1/P2 status.

- [ ] **Step 2: Run focused and repository gates**

Run: `pnpm test:m5:activity:integration && pnpm test:m5:frontend && pnpm verify && pnpm check:architecture && pnpm typecheck && pnpm lint && pnpm build`

Expected: all exit 0.

- [ ] **Step 3: Run P0/P1 and commit evidence**

Run: `pnpm test:e2e && pnpm exec playwright test --config playwright.workspace-notifications.config.ts`

Expected: PASS, recorded separately.

```bash
git add docs/release/2026-10-21-b3-workspace-notifications-acceptance.md
git commit -m "docs: record batch 3 notification acceptance"
```

## Independent rollback

1. Switch frontend/API atomically to the prior Release; leave `0086` applied.
2. Old code ignores deliveries and sequence columns; stop the new account SSE with the Release rollback.
3. Do not delete new activities or deliveries. Read-only count unknown kinds before rollback and retain them for forward recovery.
4. Existing file/member activity remains readable under the old UI.
