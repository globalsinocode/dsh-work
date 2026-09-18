import { skillConflict } from './skill-errors.ts'
import { normalizeSkillTestScenario, evaluateScenarioAssertions } from '../../domain/skill-test-scenario.ts'
import { createHash } from 'node:crypto'
import { canonicalJson } from '../runtime/canonical-json.ts'
import type { RuntimeManifest } from '../runtime/runtime-types.ts'
import type { RuntimeSkillConfiguration } from './postgres-skill-service.ts'

export const SKILL_TEST_EVIDENCE_POLICY = 'attempt-v2'
export const SKILL_TEST_SCENARIO_POLICY = 'scenario-v1'

/** Fingerprint the exact root and transitive dependencies supplied when a test starts. */
export function runtimeSkillFingerprint(root: RuntimeSkillConfiguration): string {
  const entries = new Map<string, unknown>()
  const visiting = new Set<string>()
  const visit = (skill: RuntimeSkillConfiguration) => {
    const reference = `${skill.id}@${skill.version}`
    if (visiting.has(reference)) throw skillConflict('Skill 试运行依赖包含循环', 'skill_dependency_conflict')
    const entry = {
      id: skill.id, version: skill.version, name: skill.name ?? skill.id, description: skill.description ?? '',
      instructionsSha256: createHash('sha256').update(skill.instructions).digest('hex'),
      packageSha256: skill.artifact?.sha256 ?? null,
      files: (skill.files ?? skill.artifact?.files ?? []).map(file => ({ path: file.path, sha256: file.sha256, size: file.size }))
        .sort((left, right) => left.path.localeCompare(right.path)),
      tools: [...new Set(skill.tools)].sort(), dependencies: [...new Set(skill.dependencies ?? [])].sort(),
      disableModelInvocation: Boolean(skill.disableModelInvocation),
    }
    if (entries.has(reference) && canonicalJson(entries.get(reference)) !== canonicalJson(entry)) {
      throw skillConflict('同一 Skill 版本的试运行内容不一致', 'skill_dependency_conflict')
    }
    entries.set(reference, entry)
    visiting.add(reference)
    for (const dependency of skill.dependencySkills ?? []) visit(dependency)
    visiting.delete(reference)
  }
  visit(root)
  return createHash('sha256').update(canonicalJson({ root: `${root.id}@${root.version}`,
    entries: [...entries.entries()].sort(([left], [right]) => left.localeCompare(right)),
  })).digest('hex')
}

export function evaluateAttemptEvidence(input: {
  attemptId: string; runStatus: string; attemptStatus: string; manifest: RuntimeManifest;
  activations: Array<{ attemptId: string; skillId: string; skillVersion: string }>;
  pythonExecutions: Array<{ attemptId: string; skillId: string; entry: string; succeeded: boolean }>;
  events: Array<{ attemptId: string; eventType: string; displayMessage: string | null }>;
}) {
  const catalog = input.manifest.agent_configuration.skill_instructions
  const scenario = input.manifest.test_scenario === undefined ? undefined
    : normalizeSkillTestScenario(input.manifest.test_scenario, catalog)
  const required = scenario ? catalog.filter(skill => scenario.requiredSkills.includes(`${skill.id}@${skill.version}`)) : catalog
  const missingActivations = required.filter(skill => !input.activations.some(row =>
    row.attemptId === input.attemptId && row.skillId === skill.id && row.skillVersion === skill.version,
  )).map(skill => `${skill.id}@${skill.version}`)
  const missingPython = scenario
    ? scenario.requiredPythonEntries.filter(entry => !input.pythonExecutions.some(row =>
      row.attemptId === input.attemptId && `${row.skillId}@${catalog.find(skill => skill.id === row.skillId)?.version}` === entry.skill
      && row.entry === entry.entry && row.succeeded)).map(entry => `${entry.skill}:${entry.entry}`)
    : catalog.filter(skill => skill.files?.some(file => file.path.endsWith('.py')))
      .filter(skill => !input.pythonExecutions.some(row => row.attemptId === input.attemptId
        && row.skillId === skill.id && row.succeeded
        && skill.files?.some(file => file.path === row.entry && file.path.endsWith('.py')))).map(skill => skill.id)
  const reply = input.events.filter(row => row.attemptId === input.attemptId && row.eventType === 'assistant.completed').at(-1)?.displayMessage ?? ''
  const hasAssistantResult = Boolean(reply.trim())
  const assertionResults = scenario ? evaluateScenarioAssertions(scenario, reply) : []
  const passed = input.runStatus === 'succeeded' && input.attemptStatus === 'succeeded'
    && missingActivations.length === 0 && missingPython.length === 0 && hasAssistantResult
    && assertionResults.every(result => result.passed)
  return { missingActivations, missingPython, hasAssistantResult, passed, assertionResults,
    validationLevel: assertionResults.length ? 'business-assertions' as const : 'execution' as const,
    // Publication may combine different passing scenarios, never different Attempts
    // within one scenario or configurations from different start bindings.
    verifiedSkillReferences: passed ? required.map(skill => `${skill.id}@${skill.version}`) : [],
    verifiedPythonSkillIds: passed ? (scenario
      ? scenario.requiredPythonEntries.map(entry => entry.skill.slice(0, entry.skill.lastIndexOf('@')))
      : catalog.filter(skill => skill.files?.some(file => file.path.endsWith('.py'))).map(skill => skill.id)) : [],
  }
}

export function assertStartedSkillTest(
  current: { versionId: string; fingerprint: string; runtimeFingerprint: string },
  started: { versionId: string; fingerprint: string; runtimeFingerprint: string } | undefined,
): void {
  if (!started || current.versionId !== started.versionId || current.fingerprint !== started.fingerprint
    || current.runtimeFingerprint !== started.runtimeFingerprint) {
    throw Object.assign(new Error('Skill 配置或依赖已变化，旧试运行不能用于当前草稿；请重新测试'), {
      status: 409, code: 'skill_test_snapshot_changed',
    })
  }
}
