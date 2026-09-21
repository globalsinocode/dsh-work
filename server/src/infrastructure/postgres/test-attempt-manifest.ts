import type { JsonObject } from '../../modules/run/run-types.ts'

/**
 * Minimal persisted Attempt fixture for repository-focused integration tests.
 * It deliberately includes PF-02's immutable reservation snapshot even when a
 * test does not compile or execute the rest of the Runtime Manifest.
 */
export function testAttemptManifest(
  taskId: string,
  runId: string,
  extra: JsonObject = {},
): JsonObject {
  const limits = {
    timeout_seconds: 300,
    max_tool_calls: 20,
    max_output_bytes: 65_536,
  }
  return {
    ...extra,
    task_id: taskId,
    run_id: runId,
    limits,
    budget: {
      scope_task_id: taskId,
      cumulative_limits: {
        max_duration_ms: null,
        max_tool_calls: null,
        max_output_bytes: null,
      },
      reservation: {
        duration_ms: limits.timeout_seconds * 1000,
        tool_calls: limits.max_tool_calls,
        output_bytes: limits.max_output_bytes,
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
