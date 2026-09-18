import { createHash } from 'node:crypto'
import { canonicalJson } from '../runtime/canonical-json.ts'
import type { RuntimeManifest } from '../runtime/runtime-types.ts'
import type { RuntimeSkillConfiguration } from './postgres-skill-service.ts'

export const SKILL_TEST_EVIDENCE_POLICY = 'attempt-v2'

/** Fingerprint the exact root and transitive dependencies supplied when a test starts. */
export function runtimeSkillFingerprint(root: RuntimeSkillConfiguration): string {
  const entries = new Map<string, unknown>()
  const visiting = new Set<string>()
  const visit = (skill: RuntimeSkillConfiguration) => {
    const reference = `${skill.id}@${skill.version}`
    if (visiting.has(reference)) throw new Error('Skill 试运行依赖包含循环')
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
      throw new Error('同一 Skill 版本的试运行内容不一致')
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
  const missingActivations = catalog.filter(skill => !input.activations.some(row =>
    row.attemptId === input.attemptId && row.skillId === skill.id && row.skillVersion === skill.version,
  )).map(skill => `${skill.id}@${skill.version}`)
  const missingPython = catalog.filter(skill => skill.files?.some(file => file.path.endsWith('.py')))
    .filter(skill => !input.pythonExecutions.some(row => row.attemptId === input.attemptId
      && row.skillId === skill.id && row.succeeded
      && skill.files?.some(file => file.path === row.entry && file.path.endsWith('.py'))))
    .map(skill => skill.id)
  const hasAssistantResult = input.events.some(row => row.attemptId === input.attemptId
    && row.eventType === 'assistant.completed' && Boolean(row.displayMessage?.trim()))
  return { missingActivations, missingPython, hasAssistantResult,
    passed: input.runStatus === 'succeeded' && input.attemptStatus === 'succeeded'
      && missingActivations.length === 0 && missingPython.length === 0 && hasAssistantResult }
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
