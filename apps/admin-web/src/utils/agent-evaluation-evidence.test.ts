import { describe, expect, it } from 'vitest'

import type { AgentTrialCaseRun, AgentTrialRun } from '@/types/domain'
import {
  automatedAssertionSummary,
  hasV1CaseEvidence,
  trialHasLegacyEvidence,
  trialHasPublishableV1Evidence,
} from './agent-evaluation-evidence'

const kinds: AgentTrialCaseRun['kind'][] = [
  'success',
  'invalid_input',
  'permission_denied',
  'prompt_injection',
  'capability_failure',
]

const v1Run = (kind: AgentTrialCaseRun['kind']): AgentTrialCaseRun => ({
  caseId: `case-${kind}`,
  name: kind,
  kind,
  evaluationApiVersion: 'dsh-work.ai/evaluation/v1',
  automatedAssertions: [
    { assertion: 'run_attempt_recorded', passed: true, detail: 'Run/Attempt 已记录' },
    { assertion: 'execution_succeeded', passed: true, detail: '执行成功' },
    { assertion: 'output_non_empty', passed: true, detail: '输出非空' },
  ],
  manualReview: { required: true, rubric: '符合目标质量' },
  runId: `run-${kind}`,
  attemptId: `attempt-${kind}`,
  status: 'succeeded',
  outputExcerpt: '结果',
  verdict: 'passed',
})

const trial = (caseRuns: AgentTrialCaseRun[]): AgentTrialRun => ({
  id: 'trial-1',
  submissionRevision: 1,
  status: 'passed',
  steps: [{ id: 'dsh', label: 'DSH 执行评估案例', status: 'passed', caseRuns }],
  startedAt: '2026-09-21T00:00:00.000Z',
})

describe('Agent v1 试运行证据识别', () => {
  it('旧版 JSONB 案例安全识别为不可发布证据', () => {
    const legacy: AgentTrialCaseRun = {
      caseId: 'case-old', name: '旧案例', kind: 'success', expect: '返回结果',
      runId: 'run-old', attemptId: 'attempt-old', status: 'succeeded', outputExcerpt: '旧输出', verdict: 'passed',
    }
    expect(hasV1CaseEvidence(legacy)).toBe(false)
    expect(trialHasLegacyEvidence(trial([legacy]))).toBe(true)
    expect(trialHasPublishableV1Evidence(trial([legacy]))).toBe(false)
    expect(automatedAssertionSummary(legacy)).toBe('')
  })

  it('仅五类完整且全部通过的 v1 证据可进入发布', () => {
    const current = trial(kinds.map(v1Run))
    expect(trialHasLegacyEvidence(current)).toBe(false)
    expect(trialHasPublishableV1Evidence(current)).toBe(true)
    expect(automatedAssertionSummary(current.steps[0]!.caseRuns![0]!)).toContain('✓ 执行成功')
  })
})
