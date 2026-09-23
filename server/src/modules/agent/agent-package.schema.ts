import Ajv2020Module from 'ajv/dist/2020.js'
import type { ErrorObject } from 'ajv'

import { AGENT_MODEL_REQUIREMENTS, AGENT_SPEC_API_VERSION, AGENT_SPEC_BOUNDS, AGENT_SPEC_INSTRUCTIONS_PATH } from './agent-spec.ts'

// ajv is a CommonJS package: under NodeNext the default import types as the
// module namespace; unwrap `.default` for the construct signature.
const Ajv2020 = Ajv2020Module.default

/**
 * Agent 发布包 agent.yaml 的唯一清单格式（apiVersion/kind/metadata/spec）。
 * 与 docs/development/agent-package.schema.json 保持一致；agent-package.test.ts
 * 校验两边同步。
 *
 * 严格字段政策：additionalProperties 一律 false——未知字段、旧扁平字段与别名
 * 都按 schema 违规拒绝；平台受管字段（身份/凭据/端点/模型路由/绑定等）在
 * schema 之前由 RESERVED_MANIFEST_KEYS 递归扫描给出明确原因。
 */

const CAPABILITY_ID = '^[a-z0-9][a-z0-9._-]{0,79}$'
const EXACT_VERSION = '^\\d+\\.\\d+\\.\\d+$'

export const AGENT_PACKAGE_SCHEMA = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://dsh-work.ai/schemas/agent-package.json',
  title: 'AgentPackage',
  type: 'object',
  additionalProperties: false,
  required: ['apiVersion', 'kind', 'metadata', 'spec'],
  properties: {
    apiVersion: { const: AGENT_SPEC_API_VERSION },
    kind: { const: 'AgentPackage' },
    metadata: {
      type: 'object',
      additionalProperties: false,
      required: ['id', 'name', 'version', 'description'],
      properties: {
        id: { type: 'string', pattern: '^[a-z][a-z0-9-]{2,47}$' },
        name: { type: 'string', minLength: AGENT_SPEC_BOUNDS.name.min, maxLength: AGENT_SPEC_BOUNDS.name.max },
        version: { type: 'string', pattern: EXACT_VERSION },
        description: { type: 'string', minLength: AGENT_SPEC_BOUNDS.description.min, maxLength: AGENT_SPEC_BOUNDS.description.max },
      },
    },
    spec: {
      type: 'object',
      additionalProperties: false,
      required: ['instructions'],
      properties: {
        instructions: { const: AGENT_SPEC_INSTRUCTIONS_PATH },
        capabilities: {
          type: 'object',
          additionalProperties: false,
          properties: {
            skills: { type: 'array', maxItems: AGENT_SPEC_BOUNDS.capabilities.max, items: { $ref: '#/$defs/capabilityRef' } },
            tools: { type: 'array', maxItems: AGENT_SPEC_BOUNDS.capabilities.max, items: { $ref: '#/$defs/capabilityRef' } },
          },
        },
        input: {
          type: 'object',
          additionalProperties: false,
          required: ['type'],
          properties: { type: { const: 'text' } },
        },
        output: {
          type: 'object',
          additionalProperties: false,
          required: ['type'],
          properties: { type: { const: 'text' } },
        },
        context: {
          type: 'object',
          additionalProperties: false,
          required: ['conversationHistory'],
          properties: { conversationHistory: { const: 'recent' } },
        },
        catalog: {
          type: 'object',
          additionalProperties: false,
          properties: {
            welcomeMessage: { type: 'string', maxLength: AGENT_SPEC_BOUNDS.welcomeMessage.max },
            examplePrompts: {
              type: 'array',
              maxItems: AGENT_SPEC_BOUNDS.examplePrompts.max,
              items: { type: 'string', minLength: 1, maxLength: AGENT_SPEC_BOUNDS.examplePrompts.itemMax },
            },
          },
        },
        limits: {
          type: 'object',
          additionalProperties: false,
          properties: {
            timeoutSeconds: { type: 'integer', minimum: AGENT_SPEC_BOUNDS.timeoutSeconds.min, maximum: AGENT_SPEC_BOUNDS.timeoutSeconds.max },
            maxToolCalls: { type: 'integer', minimum: AGENT_SPEC_BOUNDS.maxToolCalls.min, maximum: AGENT_SPEC_BOUNDS.maxToolCalls.max },
            maxOutputBytes: { type: 'integer', minimum: AGENT_SPEC_BOUNDS.maxOutputBytes.min, maximum: AGENT_SPEC_BOUNDS.maxOutputBytes.max },
          },
        },
        evaluation: {
          type: 'object',
          additionalProperties: false,
          required: ['cases'],
          properties: {
            cases: { type: 'string', pattern: `^(?:[A-Za-z0-9._-]+/)*[A-Za-z0-9._-]+\\.ya?ml$` },
          },
        },
        model: {
          type: 'object',
          additionalProperties: false,
          required: ['requirements'],
          properties: {
            requirements: {
              type: 'array',
              maxItems: 8,
              uniqueItems: true,
              items: { type: 'string', enum: [...AGENT_MODEL_REQUIREMENTS] },
            },
          },
        },
      },
    },
  },
  $defs: {
    capabilityRef: {
      type: 'object',
      additionalProperties: false,
      required: ['id', 'version'],
      properties: {
        id: { type: 'string', pattern: CAPABILITY_ID },
        version: { type: 'string', pattern: EXACT_VERSION },
      },
    },
  },
} as const

export interface AgentPackageManifestDocument {
  apiVersion: string
  kind: string
  metadata: { id: string; name: string; version: string; description: string }
  spec: {
    instructions: string
    capabilities?: { skills?: Array<{ id: string; version: string }>; tools?: Array<{ id: string; version: string }> }
    input?: { type: string }
    output?: { type: string }
    context?: { conversationHistory: string }
    catalog?: { welcomeMessage?: string; examplePrompts?: string[] }
    limits?: { timeoutSeconds?: number; maxToolCalls?: number; maxOutputBytes?: number }
    evaluation?: { cases: string }
    model?: { requirements: string[] }
  }
}

const ajv = new Ajv2020({ strict: true, allErrors: true })
const validateManifest = ajv.compile(AGENT_PACKAGE_SCHEMA)

/** ajv 错误 → 可读的首个结构违规描述；调用方统一包装为 agent_package_invalid。 */
export function manifestSchemaErrors(value: unknown): string[] {
  if (validateManifest(value)) return []
  return (validateManifest.errors ?? []).map((error: ErrorObject) => {
    const path = error.instancePath ? error.instancePath.replace(/^\//, '').replace(/\//g, '.') : 'agent.yaml'
    if (error.keyword === 'additionalProperties') {
      const extra = (error.params as { additionalProperty?: string }).additionalProperty
      return `${path} 包含未定义字段 ${extra}`
    }
    if (error.keyword === 'required') {
      const missing = (error.params as { missingProperty?: string }).missingProperty
      return `${path} 缺少必填字段 ${missing}`
    }
    if (error.keyword === 'const') return `${path} 必须为 ${JSON.stringify((error.params as { allowedValue?: unknown }).allowedValue)}`
    return `${path} ${error.message}`
  })
}
