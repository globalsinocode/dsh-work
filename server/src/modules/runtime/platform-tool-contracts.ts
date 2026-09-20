import type { PlatformToolContract } from './platform-tool-contract.ts'

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

function contract(input: Omit<PlatformToolContract, 'completionSemantics' | 'maxOutputBytes'> & { maxOutputBytes?: number }): PlatformToolContract {
  const { maxOutputBytes = 1024 * 1024, ...definition } = input
  return { ...definition, completionSemantics: 'completed', maxOutputBytes }
}
