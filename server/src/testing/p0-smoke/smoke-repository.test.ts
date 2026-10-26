import assert from 'node:assert/strict'
import { test } from 'node:test'

import { SmokeRepository } from './smoke-repository.ts'

test('P0 冒烟仓库每个实例独立：新实例不继承上一个实例的写入（P2-28 重置）', async () => {
  const first = new SmokeRepository()
  const [skill] = await first.read('skills')
  assert.ok(skill, '夹具至少有一个 Skill')
  await first.updateSkill(skill.id, { name: '被上一个用例改过的名称' })
  assert.equal((await first.read('skills')).find(item => item.id === skill.id)?.name, '被上一个用例改过的名称')

  const reset = new SmokeRepository()
  assert.equal((await reset.read('skills')).find(item => item.id === skill.id)?.name, skill.name)
})
