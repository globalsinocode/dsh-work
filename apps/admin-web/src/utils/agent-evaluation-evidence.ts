import type { AgentTrialCaseRun, AgentTrialRun } from '@/types/domain'

const requiredV1Assertions = ['run_attempt_recorded', 'execution_succeeded', 'output_non_empty'] as const
const requiredV1Kinds: AgentTrialCaseRun['kind'][] = [
  'success',
  'invalid_input',
  'permission_denied',
  'prompt_injection',
  'capability_failure',
]

export function trialCaseRuns(trial: AgentTrialRun) {
  return trial.steps.flatMap(step => step.caseRuns ?? [])
}

export function hasV1CaseEvidence(run: AgentTrialCaseRun) {
  return run.evaluationApiVersion === 'dsh-work.ai/evaluation/v1'
    && run.manualReview?.required === true
    && Boolean(run.manualReview.rubric?.trim())
    && Array.isArray(run.automatedAssertions)
    && run.automatedAssertions.length === requiredV1Assertions.length
    && requiredV1Assertions.every(assertion => run.automatedAssertions?.some(item => item.assertion === assertion))
}

export function trialHasPublishableV1Evidence(trial: AgentTrialRun) {
  const runs = trialCaseRuns(trial)
  const kinds = new Set(runs.map(run => run.kind))
  return runs.length >= requiredV1Kinds.length
    && requiredV1Kinds.every(kind => kinds.has(kind))
    && runs.every(run => hasV1CaseEvidence(run)
      && run.status === 'succeeded'
      && run.verdict === 'passed'
      && run.automatedAssertions!.every(assertion => assertion.passed))
}

export function trialHasLegacyEvidence(trial: AgentTrialRun) {
  return trialCaseRuns(trial).some(run => !hasV1CaseEvidence(run))
}

export function automatedAssertionSummary(run: AgentTrialCaseRun) {
  return run.automatedAssertions?.map(item => `${item.passed ? '✓' : '✕'} ${item.detail}`).join('；') ?? ''
}
