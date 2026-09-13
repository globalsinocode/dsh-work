const requiredPaths = {
  workbench: [
    '/session', '/workspaces', '/sessions', '/agents', '/sessions/{sessionId}/runs',
    '/runs/{runId}/events', '/runs/{runId}/cancel', '/artifacts/{artifactId}/versions/{versionId}/download',
  ],
  admin: [
    '/agents', '/agents/draft', '/agents/test', '/agents/status', '/agents/rollback',
    '/agents/{agentId}', '/agents/{agentId}/workspaces',
    '/agent-versions', '/agent-release-records', '/skills', '/skills/test', '/skills/status',
    '/skills/rollback', '/skill-versions', '/skill-release-records', '/tools', '/tools/status',
    '/tools/permissions', '/connectors', '/connectors/check', '/runtimes', '/runtimes/check',
    '/runtimes/configuration', '/sessions', '/workspaces', '/audit-events', '/health',
    '/model-providers', '/provider-models', '/model-routes', '/operations/summary', '/operations/runs/{runId}',
    '/grant-sources/unresolved', '/grant-sources/reconcile', '/skill-installations', '/skill-installations/{id}/confirm',
  ],
}

export function checkContracts(check) {
  for (const [audience, paths] of Object.entries(requiredPaths)) {
    const file = `docs/development/openapi-${audience}.json`
    const api = check.json(file)
    check.assert(api?.openapi === '3.1.0', `${file} 必须使用 OpenAPI 3.1.0`)
    for (const path of paths) check.assert(Boolean(api?.paths?.[path]), `${file} 缺少路径 ${path}`)
    const required = api?.components?.schemas?.ErrorEnvelope?.properties?.error?.required ?? []
    for (const field of ['code', 'message', 'object', 'suggestion', 'traceId']) {
      check.assert(Array.isArray(required) && required.includes(field), `${file} 错误契约缺少 ${field}`)
    }
  }
  const manifest = check.json('docs/development/runtime-manifest.schema.json')
  const events = check.json('docs/development/run-event.schema.json')
  for (const [schema, name] of [[manifest, 'runtime-manifest'], [events, 'run-event']]) {
    check.assert(schema?.$id === `https://dsh-work.local/schemas/${name}.schema.json`, `${name} 缺少稳定 $id`)
  }
  check.assert(Boolean(manifest?.properties?.knowledge_context), 'Runtime Manifest 缺少 knowledge_context')
  for (const field of ['file_id', 'mount_path', 'access', 'source_name', 'media_type', 'content_sha256', 'content']) {
    const required = manifest?.$defs?.fileMount?.required
    check.assert(Array.isArray(required) && required.includes(field), `FileMount 缺少必填字段 ${field}`)
  }
  const fixtures = check.json('docs/development/fixtures/mvp-fixtures.json')
  for (const collection of ['users', 'roles', 'workspaces', 'businessRecords', 'knowledgeDocuments', 'files']) {
    check.assert(Array.isArray(fixtures?.[collection]), `合成测试数据缺少数组 ${collection}`)
  }
}
