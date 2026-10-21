# Batch 5 Versioned Selection and Session Export Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bind new Sessions to the exact Agent/Skill version the user selected and provide truthful, authorized exports for either one Run or the complete Session.

**Architecture:** Extend catalog projections and Session creation with immutable version identifiers while keeping business-ID fallback for old clients. Move export assembly to the server, read authorized Session thread pages, and stream bounded text with explicit scope metadata; never use sidebar `TaskRun.messages` as the full conversation source.

**Tech Stack:** TypeScript, PostgreSQL services, Workbench HTTP API, Vue 3, Pinia, Vitest, Node test runner, streaming HTTP responses, Playwright, pnpm.

---

## Scope and ownership

- Findings: F-17, F-20.
- Integration branch: `dev`; start from the latest `dev` and land Batch 5 as a continuous, self-contained commit range after its Green gate passes.
- No database migration is expected; existing immutable Agent/Skill version and Session binding columns remain authoritative.
- Do not change Agent execution, notification schema, files, automation lifecycle or auth refresh.

## File map

- Modify Agent/Skill catalog service projections and Workbench routes.
- Modify `apps/workbench-web/src/types/domain.ts`, API client, Plaza views and `ConversationStarter.vue`.
- Modify `server/src/http/workbench/conversation-routes.ts`, `run-orchestration-service.ts`, `postgres-conversation-repository.ts`.
- Create `server/src/modules/workbench/application/session-export-service.ts` and tests.
- Modify `EmployeeShell.vue` and `ConversationView.vue`; create export utility/tests.
- Update OpenAPI, P0 fixtures, catalog/session integration tests and Playwright journeys.

### Task 1: Specify version and export journeys

**Files:**
- Modify: `e2e/TEST-CATALOG.md`

- [ ] **Step 1: Add `VE-01` through `VE-05`**

```markdown
| VE-01 | P1 | employee | Agent 选择后发布新版本 | 广场显示 v1 | 选择 v1；管理员发布 v2；提交 | Session 仍绑定 v1 |
| VE-02 | P1 | employee | Skill 选择后发布新版本 | 广场显示 Skill v1 | 选择 v1；发布 v2；提交 | Session 仍绑定 Skill v1 |
| VE-03 | P1 | employee | 所选版本失效 | 选择后版本被停用 | 提交新对话 | 返回明确冲突并要求重新选择，不静默换版 |
| VE-04 | P1 | team member | 导出完整团队 Session | 纯讨论 + 两个 Run | 选择导出完整会话 | 文件包含三段内容和 scope=session 元数据 |
| VE-05 | P1 | employee | 导出单 Run | 多轮 Session | 选择导出本次 Run | 只包含该 Run，文件名/元数据明确 scope=run |
```

- [ ] **Step 2: Validate and commit catalog**

Run: `pnpm verify project`

Expected: PASS.

```bash
git add e2e/TEST-CATALOG.md
git commit -m "test: specify immutable selection and export journeys"
```

### Task 2: Add immutable version identifiers to catalog projections

**Files:**
- Modify: `server/src/modules/agent/postgres-agent-service.ts`
- Modify: `server/src/modules/skill/postgres-skill-service.ts`
- Modify: `server/src/http/workbench/agent-routes.ts`
- Modify: `server/src/http/workbench/content-routes.ts`
- Modify: `apps/workbench-web/src/types/domain.ts`
- Modify: `server/src/testing/p0-smoke/workbench-routes.ts`
- Test: `server/src/infrastructure/postgres/m4-agent-management.integration.test.ts`

- [ ] **Step 1: Add failing catalog assertions**

```ts
assert.equal(typeof agent.versionId, 'string')
assert.equal(agent.versionReference, `${agent.slug}@${agent.version}`)
assert.equal(typeof skill.versionId, 'string')
assert.equal(skill.versionReference, `${skill.slug}@${skill.version}`)
```

- [ ] **Step 2: Run catalog integration/unit tests**

Run: `pnpm test:m4:authorization:integration && pnpm test:m5:api`

Expected: FAIL because Workbench DTOs expose display version only.

- [ ] **Step 3: Extend DTOs**

```ts
export interface WorkbenchAgent {
  id: string
  versionId: string
  versionReference: string
  version: string
  publishedAt: string
  // retain current display fields
}

export interface WorkbenchSkill {
  id: string
  versionId: string
  versionReference: string
  version: string
  publishedAt: string
  // retain current display fields
}
```

Populate identifiers from the same published row used for every display field; never join name/version from different rows.

- [ ] **Step 4: Update P0 fixtures and run tests**

Run: `pnpm test:m5:api && pnpm test:e2e`

Expected: PASS.

- [ ] **Step 5: Commit catalog projection**

```bash
git add server/src/modules/agent/postgres-agent-service.ts server/src/modules/skill/postgres-skill-service.ts server/src/http/workbench/agent-routes.ts server/src/http/workbench/content-routes.ts apps/workbench-web/src/types/domain.ts server/src/testing/p0-smoke/workbench-routes.ts server/src/infrastructure/postgres/m4-agent-management.integration.test.ts
git commit -m "feat: expose immutable catalog version identifiers"
```

### Task 3: Validate exact versions during Session creation

**Files:**
- Modify: `server/src/http/workbench/conversation-routes.ts`
- Modify: `server/src/modules/run/run-orchestration-service.ts`
- Modify: `server/src/modules/agent/postgres-agent-service.ts`
- Modify: `server/src/modules/skill/postgres-skill-service.ts`
- Test: `server/src/infrastructure/postgres/m4-authorization.integration.test.ts`
- Test: `server/src/http/team-workspace-discussion-api.integration.test.ts`

- [ ] **Step 1: Add failing version-race tests**

Create/publish Agent v1, capture its `versionId`, publish v2, then create Session with business ID + v1 ID and assert Session binds v1. Disable v1 and assert HTTP 409 `selected_version_unavailable` rather than v2 substitution. Repeat for Skill.

- [ ] **Step 2: Run focused integration tests**

Run: `pnpm test:m4:authorization:integration && pnpm test:m5:sessions:integration`

Expected: FAIL because create Session accepts only business IDs.

- [ ] **Step 3: Add exact resolver methods**

```ts
resolveWorkbenchAgentVersionById(input: {
  agentId: string
  versionId: string
  userId: string
  roleIds?: string[]
  requiredSkillReferences?: string[]
}): Promise<AgentVersionRecord>

resolveWorkbenchSkillVersionById(input: {
  skillId: string
  versionId: string
}): Promise<SkillVersionRecord>
```

Resolvers require the version to belong to the supplied business ID, be published/visible/currently usable and satisfy existing authorization/tool-closure checks.

- [ ] **Step 4: Extend Session request**

```ts
interface CreateSessionBody {
  title: string
  workspaceId?: string
  agentId?: string
  agentVersionId?: string
  skillId?: string
  skillVersionId?: string
  workspaceAgentMemberId?: string
}
```

If a version ID is provided, use the exact resolver. If omitted, retain current latest-resolution behavior for old clients. Never accept a version ID without its matching business ID.

- [ ] **Step 5: Return actual binding**

Session creation response includes `agentVersionId`, `agentVersionReference`, `skillVersionId`, `skillVersionReference`; persisted Session/Attempt remains the fact source.

- [ ] **Step 6: Run integration and commit**

Run: `pnpm test:m4:authorization:integration && pnpm test:m5:sessions:integration`

Expected: PASS.

```bash
git add server/src/http/workbench/conversation-routes.ts server/src/modules/run/run-orchestration-service.ts server/src/modules/agent/postgres-agent-service.ts server/src/modules/skill/postgres-skill-service.ts server/src/infrastructure/postgres/m4-authorization.integration.test.ts server/src/http/team-workspace-discussion-api.integration.test.ts
git commit -m "feat: bind sessions to selected immutable versions"
```

### Task 4: Carry the selected version from Plaza to composer

**Files:**
- Modify: `apps/workbench-web/src/views/AgentPlazaView.vue`
- Modify: `apps/workbench-web/src/views/SkillPlazaView.vue`
- Modify: `apps/workbench-web/src/components/ConversationStarter.vue`
- Modify: `apps/workbench-web/src/api/client.ts`
- Modify: `apps/workbench-web/src/components/ConversationStarter.catalog.test.ts`

- [ ] **Step 1: Write failing catalog-selection tests**

```ts
it('submits the exact Agent version selected in the plaza', async () => {
  route.query = { agent: 'agent-1', agentVersion: 'agent-version-v1' }
  contentStore.agents = [{ ...agent, id: 'agent-1', versionId: 'agent-version-v1' }]
  await submitPrompt('分析库存')
  expect(api.createSession).toHaveBeenCalledWith(expect.objectContaining({
    agentId: 'agent-1', agentVersionId: 'agent-version-v1',
  }))
})
```

- [ ] **Step 2: Run component tests**

Run: `pnpm --filter @dsh-work/workbench-web test -- ConversationStarter.catalog.test.ts`

Expected: FAIL because query/API omit version IDs.

- [ ] **Step 3: Update Plaza navigation**

Agent query carries `agent` + `agentVersion`; Skill carries `skill` + `skillVersion`. ConversationStarter accepts selection only when both business/version IDs match one loaded catalog row, displays the exact version, and clears both values together.

- [ ] **Step 4: Handle version conflict explicitly**

On `selected_version_unavailable`, retain prompt/files, clear stale selection, refresh only that catalog and show “所选版本已不可用，请重新选择”; do not silently retry with latest.

- [ ] **Step 5: Run frontend tests and commit**

Run: `pnpm test:m5:frontend`

Expected: PASS.

```bash
git add apps/workbench-web/src/views/AgentPlazaView.vue apps/workbench-web/src/views/SkillPlazaView.vue apps/workbench-web/src/components/ConversationStarter.vue apps/workbench-web/src/api/client.ts apps/workbench-web/src/components/ConversationStarter.catalog.test.ts
git commit -m "feat: submit exact catalog selections"
```

### Task 5: Create an authorized server-side export service

**Files:**
- Create: `server/src/modules/workbench/application/session-export-service.ts`
- Create: `server/src/modules/workbench/application/session-export-service.test.ts`
- Modify: `server/src/modules/workbench/application/postgres-conversation-repository.ts`
- Modify: `server/src/http/workbench/conversation-routes.ts`

- [ ] **Step 1: Write failing export tests**

```ts
test('session export includes discussions and all Runs in chronological order', async () => {
  conversation.pages.mockResolvedValueOnce({ items: [discussion, runOneMessage], nextCursor: 'c2' })
    .mockResolvedValueOnce({ items: [runTwoMessage], nextCursor: null })
  const result = await service.exportSession({ sessionId: 's1', userId: 'u1' })
  assert.match(result.filename, /完整会话/)
  assert.match(result.content, /范围：完整会话/)
  assert.ok(result.content.indexOf(discussion.content) < result.content.indexOf(runTwoMessage.content))
})

test('run export contains only the requested Run', async () => {
  const result = await service.exportRun({ runId: 'r1', userId: 'u1' })
  assert.match(result.content, /范围：本次 Run/)
  assert.doesNotMatch(result.content, /另一个 Run/)
})
```

- [ ] **Step 2: Run unit test**

Run: `pnpm test:unit src/modules/workbench/application/session-export-service.test.ts`

Expected: FAIL because the service is absent.

- [ ] **Step 3: Define bounded export service**

```ts
export interface ConversationExport {
  filename: string
  contentType: 'text/plain; charset=utf-8'
  content: AsyncIterable<string>
}

export class SessionExportService {
  exportSession(input: { sessionId: string; userId: string }): Promise<ConversationExport>
  exportRun(input: { runId: string; userId: string }): Promise<ConversationExport>
}
```

Call existing Session/Run authorization before reading. Read thread pages of at most 100 messages; stream header then messages. Header includes scope, generated timestamp, Session ID, optional Run ID, and `截断：否`. Exclude internal Runtime events, hidden reasoning and inaccessible attachments.

- [ ] **Step 4: Add routes**

Use `GET /sessions/:sessionId/export` and `GET /runs/:runId/export`; set `Content-Disposition` with sanitized UTF-8 filename and stream response. Do not return export through JSON envelope.

- [ ] **Step 5: Run unit/integration tests and commit**

Run: `pnpm test:unit src/modules/workbench/application/session-export-service.test.ts && pnpm test:m5:sessions:integration`

Expected: PASS.

```bash
git add server/src/modules/workbench/application/session-export-service.ts server/src/modules/workbench/application/session-export-service.test.ts server/src/modules/workbench/application/postgres-conversation-repository.ts server/src/http/workbench/conversation-routes.ts
git commit -m "feat: export authorized session and run transcripts"
```

### Task 6: Replace client-side ambiguous export actions

**Files:**
- Create: `apps/workbench-web/src/utils/conversation-export.ts`
- Create: `apps/workbench-web/src/utils/conversation-export.test.ts`
- Modify: `apps/workbench-web/src/api/client.ts`
- Modify: `apps/workbench-web/src/layouts/EmployeeShell.vue`
- Modify: `apps/workbench-web/src/views/ConversationView.vue`

- [ ] **Step 1: Write failing export action tests**

```ts
it('downloads full Session from the server instead of TaskRun.messages', async () => {
  api.downloadSessionExport.mockResolvedValue(new Blob(['full']))
  await exportConversation({ scope: 'session', sessionId: 's1', title: '发布讨论' })
  expect(api.downloadSessionExport).toHaveBeenCalledWith('s1')
})
```

- [ ] **Step 2: Run frontend test**

Run: `pnpm --filter @dsh-work/workbench-web test -- conversation-export.test.ts`

Expected: FAIL because export is inline in EmployeeShell.

- [ ] **Step 3: Implement explicit actions**

`downloadSessionExport(sessionId)` and `downloadRunExport(runId)` call requestBlob and honor server filename when present. Menus display “导出完整会话” and “导出本次 Run”; remove the function that concatenates `task.messages`.

- [ ] **Step 4: Run frontend tests and commit**

Run: `pnpm test:m5:frontend`

Expected: PASS.

```bash
git add apps/workbench-web/src/utils/conversation-export.ts apps/workbench-web/src/utils/conversation-export.test.ts apps/workbench-web/src/api/client.ts apps/workbench-web/src/layouts/EmployeeShell.vue apps/workbench-web/src/views/ConversationView.vue
git commit -m "fix: distinguish full session and run exports"
```

### Task 7: Update OpenAPI and P1 browser coverage

**Files:**
- Modify: `docs/development/openapi-workbench.json`
- Create: `e2e/version-selection-export.integration.spec.ts`
- Create: `playwright.version-export.config.ts`

- [ ] **Step 1: Document exact version and binary export contracts**

Include backward-compatible omission behavior, 409 error code, actual binding response, export content type and authorization errors.

- [ ] **Step 2: Implement five P1 journeys**

Use disposable PostgreSQL, admin setup helpers for v1/v2 publish, separate member context, and downloaded file assertions. Do not expose hidden reasoning in fixtures.

- [ ] **Step 3: Run contract and P1 tests**

Run: `pnpm test:unit src/http/openapi-coverage.test.ts && pnpm exec playwright test --config playwright.version-export.config.ts`

Expected: PASS.

- [ ] **Step 4: Commit docs/tests**

```bash
git add docs/development/openapi-workbench.json e2e/version-selection-export.integration.spec.ts playwright.version-export.config.ts
git commit -m "test: cover exact version binding and exports"
```

### Task 8: Verify and package Batch 5 independently

**Files:**
- Create: `docs/release/2026-10-21-b5-version-export-acceptance.md`

- [ ] **Step 1: Record binding/export evidence fields**

Include selected/actual version pairs, conflict behavior, export counts/order, large Session memory behavior, authorization denial and P0/P1/P2 status.

- [ ] **Step 2: Run gates**

Run: `pnpm test:m4:authorization:integration && pnpm test:m5:sessions:integration && pnpm test:m5:frontend && pnpm verify && pnpm check:architecture && pnpm typecheck && pnpm lint && pnpm build && pnpm test:e2e`

Expected: all exit 0.

- [ ] **Step 3: Run dedicated P1 and commit evidence**

Run: `pnpm exec playwright test --config playwright.version-export.config.ts`

Expected: PASS.

```bash
git add docs/release/2026-10-21-b5-version-export-acceptance.md
git commit -m "docs: record batch 5 version and export acceptance"
```

## Independent rollback

1. Atomically switch frontend/API to the prior Release; there is no schema rollback.
2. Sessions already bound to explicit immutable versions remain valid because bindings use existing columns.
3. Old UI resumes latest-version resolution for new Sessions and client-side Run export; document the temporary regression if rollback is required.
4. Do not rewrite existing Session/Attempt version IDs.
