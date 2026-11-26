import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readPythonEntriesField, skillPythonEntries, undeclaredPythonEntry } from './skill-python-entries.ts'

const skill = (frontmatter: string) => `---\nname: report\ndescription: 汇总表格。\n${frontmatter}---\n按说明运行脚本，汇总员工上传的表格并输出结果。\n`
const files = (frontmatter: string) => [
  { path: 'SKILL.md', content: skill(frontmatter) },
  { path: 'scripts/main.py', content: 'from helpers import total\n' },
  { path: 'scripts/helpers.py', content: 'def total(): pass\n' },
]

test('python-entries accepts a path or a list of relative .py paths', () => {
  assert.equal(readPythonEntriesField(undefined), undefined)
  assert.deepEqual(readPythonEntriesField('scripts/main.py'), ['scripts/main.py'])
  assert.deepEqual(readPythonEntriesField([' scripts/main.py ', 'run.py']), ['scripts/main.py', 'run.py'])
  for (const invalid of [[], 'scripts/main.sh', '/abs/main.py', '../main.py', 'scripts/./main.py', 'a..b.py', ['a.py', 'a.py'], [1], { a: 'b' }, Array.from({ length: 33 }, (_, index) => `s${index}.py`)]) {
    assert.throws(() => readPythonEntriesField(invalid), /python-entries/)
  }
})

test('without python-entries every .py stays an entry; with it only the declared ones', () => {
  assert.deepEqual(skillPythonEntries(files('')), { declared: false, entries: ['scripts/main.py', 'scripts/helpers.py'] })
  assert.deepEqual(skillPythonEntries(files('python-entries: [scripts/main.py]\n')), { declared: true, entries: ['scripts/main.py'] })
  // 登记了不存在的文件不会变成入口；登记格式无效时不放行任何入口。
  assert.deepEqual(skillPythonEntries(files('python-entries: [scripts/main.py, scripts/gone.py]\n')).entries, ['scripts/main.py'])
  assert.deepEqual(skillPythonEntries(files('python-entries: 42\n')), { declared: true, entries: [] })
  assert.deepEqual(skillPythonEntries([{ path: 'run.py' }]), { declared: false, entries: ['run.py'] })
})

test('python_execute rejects an entry that the Skill did not declare', () => {
  assert.equal(undeclaredPythonEntry(files(''), 'scripts/helpers.py'), null)
  const declared = files('python-entries: scripts/main.py\n')
  assert.equal(undeclaredPythonEntry(declared, 'scripts/main.py'), null)
  assert.match(undeclaredPythonEntry(declared, 'scripts/helpers.py') ?? '', /scripts\/helpers\.py 未在 Skill 的 python-entries 中登记；可运行的入口：scripts\/main\.py/)
  assert.match(undeclaredPythonEntry(declared, '') ?? '', /（未提供）/)
})
