import type { PlatformToolContract } from './platform-tool-contract.ts'
import type { AdminRunPurpose, RuntimeManifest } from './runtime-types.ts'
import type { ToolCategory, ToolGovernanceMode } from '../../domain/tool-category.ts'

const objectOutput = { type: 'object' } as const
const boundedString = { type: 'string', maxLength: 1_048_576 } as const
const PYTHON_OUTPUT_MAX_BYTES = 16 * 1024 * 1024

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
            properties: { name: { type: 'string', maxLength: 500 }, size: { type: 'integer', minimum: 0, maximum: 10 * 1024 * 1024 } },
            required: ['name', 'size'],
          },
        },
      },
      required: ['exitCode', 'stdout', 'stderr', 'artifacts'],
    },
    effect: 'write', retryPolicy: 'never', concurrencyPolicy: 'serialized', timeoutMs: 300_000,
    maxOutputBytes: PYTHON_OUTPUT_MAX_BYTES,
  }),
} satisfies Record<string, PlatformToolContract>

export type PlatformToolName = keyof typeof platformToolContracts

type DshWorkBuiltInToolDefinition =
  | {
      category: Extract<ToolCategory, 'dsh_work_execution'>
      governanceMode: Extract<ToolGovernanceMode, 'manifest_intrinsic'>
    }
  | {
      category: Extract<ToolCategory, 'dsh_work_platform'>
      governanceMode: Extract<ToolGovernanceMode, 'purpose_scoped'>
      allowedPurposes: readonly AdminRunPurpose[]
    }

/**
 * dsh-work 通过 Platform Tool Bridge 暴露的内置工具分类。
 * 执行工具由 Agent/Skill 的 Manifest 声明；平台工具只能由指定管理流程注入。
 */
export const dshWorkBuiltInToolDefinitions = {
  prepare_skill_installation: {
    category: 'dsh_work_platform', governanceMode: 'purpose_scoped',
    allowedPurposes: ['admin-skill-install'],
  },
  inspect_admin_state: {
    category: 'dsh_work_platform', governanceMode: 'purpose_scoped',
    allowedPurposes: ['admin-assistant', 'admin-agent-manage', 'admin-platform-operations'],
  },
  propose_admin_task: {
    category: 'dsh_work_platform', governanceMode: 'purpose_scoped',
    allowedPurposes: ['admin-assistant'],
  },
  prepare_admin_action: {
    category: 'dsh_work_platform', governanceMode: 'purpose_scoped',
    allowedPurposes: ['admin-assistant', 'admin-agent-manage', 'admin-platform-operations'],
  },
  activate_skill: { category: 'dsh_work_execution', governanceMode: 'manifest_intrinsic' },
  python_execute: { category: 'dsh_work_execution', governanceMode: 'manifest_intrinsic' },
} as const satisfies Record<PlatformToolName, DshWorkBuiltInToolDefinition>

export function platformToolsForPurpose(purpose: AdminRunPurpose): RuntimeManifest['tools'] {
  return Object.entries(dshWorkBuiltInToolDefinitions)
    .filter(([, definition]) => {
      if (definition.category !== 'dsh_work_platform') return false
      return (definition.allowedPurposes as readonly AdminRunPurpose[]).includes(purpose)
    })
    .map(([id]) => ({ id, version: '1.0.0' }))
}

export function assertPlatformToolPurpose(manifest: Pick<RuntimeManifest, 'purpose' | 'tools'>): void {
  for (const tool of manifest.tools) {
    if (!(tool.id in dshWorkBuiltInToolDefinitions)) continue
    const definition = dshWorkBuiltInToolDefinitions[tool.id as PlatformToolName]
    if (definition.category === 'dsh_work_execution') continue
    const allowedPurposes = definition.allowedPurposes as readonly AdminRunPurpose[]
    if (!manifest.purpose || !allowedPurposes.includes(manifest.purpose as AdminRunPurpose)) {
      throw new Error(`dsh-work 内置平台工具 ${tool.id} 不允许用于当前运行用途：${manifest.purpose ?? 'employee'}`)
    }
  }
}

function contract(input: Omit<PlatformToolContract, 'completionSemantics' | 'maxOutputBytes'> & { maxOutputBytes?: number }): PlatformToolContract {
  const { maxOutputBytes = 1024 * 1024, ...definition } = input
  return { ...definition, completionSemantics: 'completed', maxOutputBytes }
}
