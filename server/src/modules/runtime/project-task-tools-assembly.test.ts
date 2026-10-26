import assert from 'node:assert/strict'
import { test } from 'node:test'

import { projectTaskToolNames } from './builtin-tools.ts'

test('项目任务工具按开关与运行模式装配', () => {
  assert.deepEqual(projectTaskToolNames({ enabled: false, mode: 'read-write' }), [])
  assert.deepEqual(projectTaskToolNames({ enabled: true, mode: 'none' }), [])
  assert.deepEqual(projectTaskToolNames({ enabled: true, mode: 'read' }), [
    'project_tasks_list', 'project_task_get',
  ])
  assert.deepEqual(projectTaskToolNames({ enabled: true, mode: 'read-write' }), [
    'project_tasks_list', 'project_task_get', 'project_task_create', 'project_task_update',
  ])
})
