import { createPinia, setActivePinia } from 'pinia'
import { effectScope, nextTick, ref } from 'vue'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { useTaskStore } from '@/stores/tasks'
import type { Artifact, TaskRun } from '@/types/domain'
import { useRunActions } from './useRunActions'

vi.mock('@/api/client', () => ({ workbenchApi: {} }))
const feedback = vi.hoisted(() => ({ notifyActionFailure: vi.fn(), downloadArtifactFile: vi.fn() }))
vi.mock('@/utils/feedback', () => feedback)
vi.mock('element-plus', () => ({
  ElMessage: { success: vi.fn(), warning: vi.fn() },
  ElMessageBox: { confirm: vi.fn().mockResolvedValue('confirm') },
}))

function run(overrides: Partial<TaskRun> = {}) {
  return { id: 'run-1', sessionId: 'session-1', status: 'failed', ...overrides } as TaskRun
}

function file(id: string): Artifact {
  return { id, name: `${id}.md`, version: 1, fileId: `file-${id}`, canReference: true } as Artifact
}

function setup(canOperate = true) {
  const task = ref<TaskRun | undefined>(run())
  const onRetried = vi.fn()
  const scope = effectScope()
  const actions = scope.run(() => useRunActions(task, { canOperate: ref(canOperate), onRetried }))!
  return { task, actions, onRetried, store: useTaskStore() }
}

describe('useRunActions', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    feedback.notifyActionFailure.mockReset()
  })

  it('retries and hands a new run to the caller', async () => {
    const { actions, onRetried, store } = setup()
    vi.spyOn(store, 'retryTask').mockResolvedValue(run({ id: 'run-2' }))
    await expect(actions.retryRun()).resolves.toBe(true)
    expect(onRetried).toHaveBeenCalledWith(expect.objectContaining({ id: 'run-2' }))
  })

  it('fails closed without write permission', async () => {
    const { actions, store } = setup(false)
    const retry = vi.spyOn(store, 'retryTask')
    const cancel = vi.spyOn(store, 'cancelTask')
    await expect(actions.retryRun()).resolves.toBe(false)
    await actions.stopRun()
    expect(retry).not.toHaveBeenCalled()
    expect(cancel).not.toHaveBeenCalled()
  })

  it('reports a failed retry and keeps the current run', async () => {
    const { actions, onRetried, store } = setup()
    vi.spyOn(store, 'retryTask').mockRejectedValue(new Error('不可重试'))
    await expect(actions.retryRun()).resolves.toBe(false)
    expect(onRetried).not.toHaveBeenCalled()
    expect(feedback.notifyActionFailure).toHaveBeenCalled()
  })

  it('stops after confirmation', async () => {
    const { actions, store } = setup()
    const cancel = vi.spyOn(store, 'cancelTask').mockResolvedValue(undefined as never)
    await actions.stopRun()
    expect(cancel).toHaveBeenCalledWith('run-1')
    expect(actions.stopping.value).toBe(false)
  })

  it('references at most five results once each and clears them on another session', async () => {
    const { task, actions } = setup()
    for (const id of ['a', 'a', 'b', 'c', 'd', 'e', 'f']) actions.continueEditing(file(id))
    expect(actions.referencedArtifacts.value.map(item => item.fileId)).toEqual(['file-a', 'file-b', 'file-c', 'file-d', 'file-e'])
    actions.removeReferencedArtifact('file-b')
    expect(actions.referencedArtifacts.value).toHaveLength(4)
    actions.continueEditing({ ...file('g'), canReference: false })
    expect(actions.referencedArtifacts.value).toHaveLength(4)

    task.value = run({ sessionId: 'session-2' })
    await nextTick()
    expect(actions.referencedArtifacts.value).toEqual([])
  })
})
