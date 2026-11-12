import type { PlatformToolContract } from './platform-tool-contract.ts'
import type { AdminRunPurpose, RuntimeManifest } from './runtime-types.ts'

const objectOutput = { type: 'object' } as const
const boundedString = { type: 'string', maxLength: 1_048_576 } as const
const PYTHON_OUTPUT_MAX_BYTES = 16 * 1024 * 1024
const projectTaskAssigneeSchema = {
  type: 'object', additionalProperties: false,
  properties: {
    type: { type: 'string', enum: ['employee', 'agent'] },
    id: { type: 'string', minLength: 1, maxLength: 160 },
  },
  required: ['type', 'id'],
} as const

export const platformToolContracts = {
  prepare_skill_installation: contract({
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    outputSchema: objectOutput,
    effect: 'read', retryPolicy: 'safe', concurrencyPolicy: 'serialized', timeoutMs: 120_000,
  }),
  inspect_admin_state: contract({
    inputSchema: {
      type: 'object',
      properties: {
        domain: { type: 'string', enum: ['overview', 'skills', 'agents', 'operations'] },
        query: { type: 'string', maxLength: 200 },
      },
      required: ['domain'], additionalProperties: false,
    },
    outputSchema: objectOutput,
    effect: 'read', retryPolicy: 'safe', concurrencyPolicy: 'concurrent', timeoutMs: 30_000,
  }),
  propose_admin_task: contract({
    inputSchema: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['skill-install', 'agent-management', 'platform-operations'] },
        summary: { type: 'string', minLength: 4, maxLength: 240 },
        impact: { type: 'string', minLength: 4, maxLength: 500 },
      },
      required: ['kind', 'summary', 'impact'], additionalProperties: false,
    },
    outputSchema: objectOutput,
    effect: 'write', retryPolicy: 'never', concurrencyPolicy: 'serialized', timeoutMs: 30_000,
  }),
  prepare_admin_action: contract({
    inputSchema: {
      type: 'object',
      properties: {
        actionType: { type: 'string', enum: ['agent-update-draft', 'agent-set-status', 'runtime-update-configuration'] },
        target: { type: 'string', minLength: 1, maxLength: 160 },
        summary: { type: 'string', minLength: 4, maxLength: 300 },
        changes: { type: 'object' },
      },
      required: ['actionType', 'target', 'summary', 'changes'], additionalProperties: false,
    },
    outputSchema: objectOutput,
    effect: 'write', retryPolicy: 'never', concurrencyPolicy: 'serialized', timeoutMs: 30_000,
  }),
  activate_skill: contract({
    inputSchema: {
      type: 'object', properties: { name: { type: 'string', minLength: 1, maxLength: 160 } },
      required: ['name'], additionalProperties: false,
    },
    outputSchema: {
      type: 'object', additionalProperties: false,
      properties: {
        id: { type: 'string' }, name: { type: 'string' }, version: { type: 'string' },
        instructions: boundedString, resourceDirectory: { type: ['string', 'null'] },
        dependencies: { type: 'array', items: { type: 'string' } },
        pythonEntries: { type: 'array', items: { type: 'string' } },
        contentSha256: { type: 'string', pattern: '^[a-f0-9]{64}$' },
      },
      required: ['id', 'name', 'version', 'instructions', 'resourceDirectory', 'dependencies', 'pythonEntries', 'contentSha256'],
    },
    effect: 'write', retryPolicy: 'safe', concurrencyPolicy: 'serialized', timeoutMs: 30_000,
  }),
  python_execute: contract({
    inputSchema: {
      type: 'object',
      properties: {
        skill: { type: 'string', minLength: 1, maxLength: 160 },
        entry: { type: 'string', minLength: 1, maxLength: 500 },
        args: { type: 'array', items: { type: 'string', maxLength: 1000 }, maxItems: 32 },
      },
      required: ['skill', 'entry'], additionalProperties: false,
    },
    outputSchema: {
      type: 'object', additionalProperties: false,
      properties: {
        exitCode: { type: 'integer' }, stdout: boundedString, stderr: boundedString,
        artifacts: {
          type: 'array', maxItems: 20,
          items: {
            type: 'object', additionalProperties: false,
            properties: { name: { type: 'string', maxLength: 500 }, size: { type: 'integer', minimum: 0, maximum: 20 * 1024 * 1024 } },
            required: ['name', 'size'],
          },
        },
      },
      required: ['exitCode', 'stdout', 'stderr', 'artifacts'],
    },
    effect: 'write', retryPolicy: 'never', concurrencyPolicy: 'serialized',
    // Script budget. At this deadline the bridge aborts the sandbox and waits
    // until the named container is stopped and removed (or cleanup fails loudly).
    timeoutMs: 300_000,
    maxOutputBytes: PYTHON_OUTPUT_MAX_BYTES,
  }),
  // 项目空间 S6：Agent 查看与维护项目任务。读取安全可重试；写入不重试，重放由操作登记去重。
  project_tasks_list: contract({
    inputSchema: {
      type: 'object', additionalProperties: false,
      properties: {
        status: { type: 'string', enum: ['open', 'todo', 'in_progress', 'done', 'all'] },
        assigneeId: { type: 'string', minLength: 1, maxLength: 160 },
        query: { type: 'string', minLength: 1, maxLength: 120 },
        limit: { type: 'integer', minimum: 1, maximum: 50 },
      },
    },
    outputSchema: objectOutput,
    effect: 'read', retryPolicy: 'safe', concurrencyPolicy: 'concurrent', timeoutMs: 30_000,
  }),
  project_task_get: contract({
    inputSchema: {
      type: 'object', additionalProperties: false,
      properties: { taskId: { type: 'string', minLength: 1, maxLength: 160 } },
      required: ['taskId'],
    },
    outputSchema: objectOutput,
    effect: 'read', retryPolicy: 'safe', concurrencyPolicy: 'concurrent', timeoutMs: 30_000,
  }),
  project_task_create: contract({
    inputSchema: {
      type: 'object', additionalProperties: false,
      properties: {
        title: { type: 'string', minLength: 1, maxLength: 120 },
        description: { type: 'string', maxLength: 4000 },
        assignee: projectTaskAssigneeSchema,
        dueDate: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
      },
      required: ['title', 'assignee'],
    },
    outputSchema: objectOutput,
    effect: 'write', retryPolicy: 'never', concurrencyPolicy: 'serialized', timeoutMs: 30_000,
  }),
  project_task_update: contract({
    inputSchema: {
      type: 'object', additionalProperties: false,
      properties: {
        taskId: { type: 'string', minLength: 1, maxLength: 160 },
        title: { type: 'string', minLength: 1, maxLength: 120 },
        description: { type: 'string', maxLength: 4000 },
        assignee: projectTaskAssigneeSchema,
        dueDate: { type: ['string', 'null'], pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
        status: { type: 'string', enum: ['todo', 'in_progress', 'done'] },
        completionNote: { type: 'string', maxLength: 4000 },
      },
      required: ['taskId'], minProperties: 2,
    },
    outputSchema: objectOutput,
    effect: 'write', retryPolicy: 'never', concurrencyPolicy: 'serialized', timeoutMs: 30_000,
  }),
  // 推荐 AI 同事（推荐方案 4.1）：目录只读可重试；推荐写入不重试，同一 Attempt 再次调用替换上一组。
  list_colleague_agents: contract({
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    outputSchema: objectOutput,
    effect: 'read', retryPolicy: 'safe', concurrencyPolicy: 'concurrent', timeoutMs: 30_000,
  }),
  recommend_agents: contract({
    inputSchema: {
      type: 'object', additionalProperties: false,
      properties: {
        recommendations: {
          type: 'array', minItems: 1, maxItems: 3,
          items: {
            type: 'object', additionalProperties: false,
            properties: {
              agentId: { type: 'string', minLength: 1, maxLength: 160 },
              reason: { type: 'string', minLength: 1, maxLength: 120 },
              suggestedPrompt: { type: 'string', minLength: 1, maxLength: 500 },
            },
            required: ['agentId', 'reason'],
          },
        },
      },
      required: ['recommendations'],
    },
    outputSchema: objectOutput,
    effect: 'write', retryPolicy: 'never', concurrencyPolicy: 'serialized', timeoutMs: 30_000,
  }),
  list_available_skills: contract({
    inputSchema: {
      type: 'object', additionalProperties: false,
      properties: { query: { type: 'string', maxLength: 100 } },
    },
    outputSchema: objectOutput,
    effect: 'read', retryPolicy: 'safe', concurrencyPolicy: 'concurrent', timeoutMs: 30_000,
  }),
  skill_draft_save: contract({
    inputSchema: {
      type: 'object', additionalProperties: false,
      properties: { directory: { type: 'string', minLength: 1, maxLength: 200 } },
      required: ['directory'],
    },
    outputSchema: objectOutput,
    effect: 'write', retryPolicy: 'never', concurrencyPolicy: 'serialized', timeoutMs: 60_000,
  }),
  /**
   * Agent 知识检索工具方案（KO9）：在会话所选、员工当前可见的知识库中检索。读工具：写入的引用快照与审计是
   * 执行证据，不是业务效果，不进入 task_operations 登记；同一 Attempt 内串行，保证引用序号连续。
   */
  knowledge_search: contract({
    inputSchema: {
      type: 'object', additionalProperties: false,
      properties: {
        query: { type: 'string', minLength: 1, maxLength: 500 },
        knowledgeBaseNames: { type: 'array', minItems: 1, maxItems: 20, items: { type: 'string', minLength: 1, maxLength: 60 } },
      },
      required: ['query'],
    },
    outputSchema: {
      type: 'object', additionalProperties: false,
      properties: {
        documents: {
          type: 'array',
          items: {
            type: 'object', additionalProperties: false,
            properties: {
              ordinal: { type: 'integer', minimum: 1 },
              title: { type: 'string' },
              knowledgeBaseName: { type: 'string' },
              updatedDate: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
              excerpt: { type: 'string', maxLength: 4000 },
            },
            required: ['ordinal', 'title', 'knowledgeBaseName', 'updatedDate', 'excerpt'],
          },
        },
        skippedBases: { type: 'array', items: { type: 'string' } },
        movedBases: { type: 'array', items: { type: 'string' } },
        remainingCalls: { type: 'integer', minimum: 0 },
      },
      required: ['documents', 'skippedBases', 'movedBases', 'remainingCalls'],
    },
    // WeKnora 检索与文档元数据各最多 10 秒（weknoraSearchTimeoutMs），留出余量；须小于 DSH 侧默认 30 秒。
    effect: 'read', retryPolicy: 'safe', concurrencyPolicy: 'serialized', timeoutMs: 25_000,
  }),
  propose_memory: contract({
    inputSchema: {
      type: 'object', additionalProperties: false,
      properties: {
        kind: { type: 'string', enum: ['experience'] },
        title: { type: 'string', minLength: 3, maxLength: 120 },
        content: { type: 'string', minLength: 20, maxLength: 4000 },
      },
      required: ['kind', 'title', 'content'],
    },
    outputSchema: {
      type: 'object', additionalProperties: false,
      properties: { proposalId: { type: 'string' }, status: { type: 'string', enum: ['pending_admin_review', 'trial_only'] } },
      required: ['proposalId', 'status'],
    },
    // Only the application staging is complete here; administrative review and publication are separate actions.
    effect: 'write', retryPolicy: 'safe', concurrencyPolicy: 'serialized', timeoutMs: 30_000,
  }),
} satisfies Record<string, PlatformToolContract>

export type PlatformToolName = keyof typeof platformToolContracts

/**
 * 按管理运行用途注入的平台工具。其余平台工具（activate_skill、python_execute、
 * propose_memory）由运行内容装配，见 builtin-tools.ts。
 */
export const platformToolPurposes: Partial<Record<PlatformToolName, readonly AdminRunPurpose[]>> = {
  prepare_skill_installation: ['admin-skill-install'],
  inspect_admin_state: ['admin-assistant', 'admin-agent-manage', 'admin-platform-operations'],
  propose_admin_task: ['admin-assistant'],
  prepare_admin_action: ['admin-assistant', 'admin-agent-manage', 'admin-platform-operations'],
}

export function platformToolsForPurpose(purpose: AdminRunPurpose): RuntimeManifest['tools'] {
  return Object.entries(platformToolPurposes)
    .filter(([, purposes]) => purposes?.includes(purpose))
    .map(([id]) => ({ id, version: '1.0.0' }))
}

/**
 * 项目空间 S6 的任务工具只用于员工在团队空间发起的运行，推荐、Skill 创建与知识检索工具只用于员工个人对话；
 * 它们都不进入任何管理或系统运行。
 */
const projectTaskTools = new Set<string>([
  'project_tasks_list', 'project_task_get', 'project_task_create', 'project_task_update',
  'list_colleague_agents', 'recommend_agents',
  'list_available_skills', 'skill_draft_save',
  'knowledge_search',
])

export function assertPlatformToolPurpose(manifest: Pick<RuntimeManifest, 'purpose' | 'tools'>): void {
  for (const tool of manifest.tools) {
    if (projectTaskTools.has(tool.id) && manifest.purpose) {
      throw new Error(`dsh-work 内置平台工具 ${tool.id} 不允许用于当前运行用途：${manifest.purpose}`)
    }
    const purposes = platformToolPurposes[tool.id as PlatformToolName]
    if (!purposes) continue
    if (!manifest.purpose || !purposes.includes(manifest.purpose as AdminRunPurpose)) {
      throw new Error(`dsh-work 内置平台工具 ${tool.id} 不允许用于当前运行用途：${manifest.purpose ?? 'employee'}`)
    }
  }
}

function contract(input: Omit<PlatformToolContract, 'maxOutputBytes' | 'completionSemantics'> & {
  maxOutputBytes?: number
  completionSemantics?: PlatformToolContract['completionSemantics']
}): PlatformToolContract {
  const { maxOutputBytes = 1024 * 1024, ...definition } = input
  return { ...definition, completionSemantics: definition.completionSemantics ?? 'completed', maxOutputBytes }
}
