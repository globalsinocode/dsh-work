import type { AdminConversation } from '../types/assistant'
export function conversationFixture(): AdminConversation {
  return { id: 'admin-session-00000000-0000-4000-8000-000000000001', title: '安装 Skill',
    messages: [{ id: 'm1', role: 'user', text: 'https://example.org/skill.zip', runId: 'run-1' }, { id: 'm2', role: 'assistant', text: '包检查完成，请确认。', runId: 'run-1' }],
    runs: [{ id: 'run-1', status: 'succeeded', error: null }],
    installations: [{ id: 'install-1', runId: 'run-1', source: 'https://example.org/skill.zip', resolvedUrl: null, resolvedRef: null, status: 'pending', skillId: null, resultType: null, installedVersion: null, compatibilityStatus: 'compatible', planSha256: 'd'.repeat(64),
      package: { name: '真实测试包', description: '来自服务端的包说明', version: null, sha256: 'a'.repeat(64), archiveSha256: 'b'.repeat(64), instructions: '按包内规则执行，不生成新的指令或数据。', toolIds: [], files: [{ path: 'SKILL.md', size: 150, sha256: 'c'.repeat(64) }], requirements: [], compatibility: { status: 'compatible', issues: [] }, disableModelInvocation: false },
      plan: { planVersion: '1.0', rootName: '真实测试包', packages: [], edges: [], compatibility: { status: 'compatible', issues: [] }, summary: { packageCount: 1, dependencyCount: 0, toolIds: [], pythonFiles: 0 }, sha256: 'd'.repeat(64) },
    }],
  }
}
