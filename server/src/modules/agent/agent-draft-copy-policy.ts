import type { AgentDefinition, UpdateAgentDraftInput } from '../../domain/types.ts'
import { requestInvalid } from '../authorization/authorization-errors.ts'
import { canonicalJson } from '../runtime/canonical-json.ts'

/** Copy-only, NOT model instructions. Default deny: additions require a policy review. */
export const DRAFT_COPY_FIELDS = ['name', 'description', 'welcomeMessage', 'examplePrompts'] as const
export const DRAFT_COPY_POLICY = 'draft-copy-v1' as const
const protectedFields = ['owner', 'department', 'visibility', 'roleIds', 'dataScopes', 'systemPrompt',
  'maxOutputBytes', 'maxToolCalls', 'timeoutSeconds', 'skills', 'tools', 'delegationPolicy'] as const

type CopyBefore = Pick<AgentDefinition, 'id' | 'status' | typeof DRAFT_COPY_FIELDS[number] | typeof protectedFields[number]>
type CopyAfter = Omit<UpdateAgentDraftInput, 'actor'>

export function assertDraftCopyFields(changes: Record<string, unknown>): void {
  const fields = Object.keys(changes)
  if (!fields.length || fields.some(field => !(DRAFT_COPY_FIELDS as readonly string[]).includes(field))) {
    throw requestInvalid('一次确认只允许现有草稿的 name、description、welcomeMessage、examplePrompts；执行指令、权限、发布与 Runtime 变更必须委派后再次确认')
  }
}

/** Check the complete normalized diff, not a model-supplied risk label or action name. */
export function assertDraftCopyPlan(before: CopyBefore, after: CopyAfter): void {
  if (before.status !== 'draft' || after.agentId !== before.id) throw requestInvalid('一次确认仅限已存在的 Agent 草稿')
  for (const field of protectedFields) {
    if (canonicalJson(before[field]) !== canonicalJson(after[field])) {
      throw requestInvalid(`一次确认不能变更 ${field}，请通过专用助手的两次确认流程`)
    }
  }
  if (!DRAFT_COPY_FIELDS.some(field => canonicalJson(before[field]) !== canonicalJson(after[field]))) {
    throw requestInvalid('草稿文案计划没有实际变更')
  }
}
