import type { RuntimeManifest } from './runtime-types.ts'

type PersistedRuntimeManifest = Omit<RuntimeManifest, 'budget'> & {
  budget?: RuntimeManifest['budget']
}

/**
 * PF-02 upgrade bridge for immutable manifests persisted before cumulative
 * budgets existed. New producers and compileRuntimeManifest remain strict;
 * only trusted persisted records may enter through this normalizer.
 */
export function normalizePersistedRuntimeManifest(input: PersistedRuntimeManifest): RuntimeManifest {
  if (input.budget) return input as RuntimeManifest
  return {
    ...input,
    budget: {
      scope_task_id: input.task_id,
      cumulative_limits: {
        max_duration_ms: null,
        max_tool_calls: null,
        max_output_bytes: null,
      },
      reservation: {
        duration_ms: input.limits.timeout_seconds * 1_000,
        tool_calls: input.limits.max_tool_calls,
        output_bytes: input.limits.max_output_bytes,
      },
      enforcement: {
        duration: 'hard',
        tool_calls: 'hard',
        output_bytes: 'hard',
        tokens: 'unsupported',
        cost: 'unsupported',
      },
    },
  }
}
