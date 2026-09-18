/** Deterministic, data-only expectations. No regexes, scripts or evaluators from packages. */
export interface SkillTestScenario {
  id: string
  requiredSkills: string[]
  requiredPythonEntries: Array<{ skill: string; entry: string }>
  assertions: Array<
    | { kind: 'reply_contains'; value: string }
    | { kind: 'reply_json_equals'; path: string[]; expected: string | number | boolean | null }
  >
}
export interface TestCatalogEntry { id: string; version: string; files?: Array<{ path: string }> }
const unsafeKeys = new Set(['__proto__', 'prototype', 'constructor'])
function invalid(): never {
  throw Object.assign(new Error('试运行场景无效：必须使用锁定 Skill/脚本及受支持的有限结果断言'), { status: 422, code: 'invalid_test_scenario' })
}
function object(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid()
  const result = value as Record<string, unknown>
  if (Object.keys(result).some(key => !keys.includes(key))) return invalid()
  return result
}
export function normalizeSkillTestScenario(value: unknown, catalog: TestCatalogEntry[]): SkillTestScenario {
  const raw = object(value, ['id', 'requiredSkills', 'requiredPythonEntries', 'assertions'])
  if (!catalog.length || typeof raw.id !== 'string' || !/^[a-z][a-z0-9_-]{0,63}$/.test(raw.id)) return invalid()
  if (!Array.isArray(raw.requiredSkills) || raw.requiredSkills.length > 64
    || !Array.isArray(raw.requiredPythonEntries) || raw.requiredPythonEntries.length > 64
    || !Array.isArray(raw.assertions) || raw.assertions.length > 32) return invalid()
  const available = new Map(catalog.map(skill => [`${skill.id}@${skill.version}`, skill]))
  const required = new Set([`${catalog[0]!.id}@${catalog[0]!.version}`])
  for (const reference of raw.requiredSkills) {
    if (typeof reference !== 'string' || !available.has(reference)) return invalid()
    required.add(reference)
  }
  const requiredPythonEntries = raw.requiredPythonEntries.map(value => {
    const item = object(value, ['skill', 'entry'])
    if (typeof item.skill !== 'string' || typeof item.entry !== 'string'
      || !item.entry.endsWith('.py') || !available.get(item.skill)?.files?.some(file => file.path === item.entry)) return invalid()
    required.add(item.skill)
    return { skill: item.skill, entry: item.entry }
  })
  const assertions: SkillTestScenario['assertions'] = raw.assertions.map(value => {
    const item = object(value, ['kind', 'value', 'path', 'expected'])
    if (item.kind === 'reply_contains') {
      if (typeof item.value !== 'string' || !item.value.trim() || item.value.length > 1000
        || Object.hasOwn(item, 'path') || Object.hasOwn(item, 'expected')) return invalid()
      return { kind: item.kind, value: item.value }
    }
    if (item.kind !== 'reply_json_equals' || !Array.isArray(item.path) || !item.path.length || item.path.length > 8
      || item.path.some(key => typeof key !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(key) || unsafeKeys.has(key))
      || Object.hasOwn(item, 'value')) return invalid()
    const expected = item.expected
    if (!(expected === null || typeof expected === 'boolean' || (typeof expected === 'number' && Number.isFinite(expected))
      || (typeof expected === 'string' && expected.length <= 1000))) return invalid()
    return { kind: item.kind, path: item.path as string[], expected }
  })
  return { id: raw.id, requiredSkills: [...required].sort(), requiredPythonEntries, assertions }
}
export function evaluateScenarioAssertions(scenario: SkillTestScenario, reply: string) {
  let json: unknown
  try { json = JSON.parse(reply) } catch { json = undefined }
  return scenario.assertions.map((assertion, index) => {
    let passed: boolean
    if (assertion.kind === 'reply_contains') passed = reply.includes(assertion.value)
    else {
      let current = json
      for (const key of assertion.path) {
        if (!current || typeof current !== 'object' || !Object.hasOwn(current, key)) { current = undefined; break }
        current = (current as Record<string, unknown>)[key]
      }
      passed = current === assertion.expected
    }
    return { id: `assertion-${index + 1}`, kind: assertion.kind, passed }
  })
}
