import ElementPlus from 'element-plus'
import { createPinia, setActivePinia } from 'pinia'
import { createMemoryHistory, createRouter } from 'vue-router'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'

import RuntimeManagementView from './RuntimeManagementView.vue'
import { useAuthStore } from '../stores/auth'
import { useContentStore } from '../stores/content'
import type { DshRuntimeToolConnectorStatus, RuntimeDefinition } from '../types/domain'

const wrappers: VueWrapper[] = []

afterEach(() => {
  wrappers.splice(0).forEach(wrapper => wrapper.unmount())
  vi.restoreAllMocks()
})

const runtime: RuntimeDefinition = {
  id: 'runtime-local-01', name: '本地 DSH Runtime', environment: '本地环境', mode: 'dsh-worker',
  status: 'healthy', schedulingStatus: 'accepting', version: '1.0.0', endpoint: 'ACP stdio（本机子进程）',
  maxConcurrentWorkers: 4, activeWorkers: 1, queuedRuns: 0, attemptTimeoutMinutes: 30,
  lastHeartbeat: '刚刚', checkedAt: '刚刚', healthMessage: 'DSH Runtime 可用。',
  capabilities: ['ACP stdio', 'DSH Agent Loop'],
}

const toolConnector: DshRuntimeToolConnectorStatus = {
  runtimeId: runtime.id,
  connectorId: 'connector-dsh-workspace',
  name: 'DSH Runtime 内置工具连接器',
  status: 'healthy',
  endpoint: 'dsh://workspace',
  toolCount: 4,
  activeBindingCount: 3,
  latestBindingRevision: 2,
  catalogDigest: '1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
  lastCheckedAt: '刚刚',
  lastHealthMessage: 'DSH 内置工具目录检查通过。',
}

async function render() {
  const pinia = createPinia()
  setActivePinia(pinia)
  useAuthStore().$patch({ permissions: ['admin:write'] })
  const content = useContentStore()
  vi.spyOn(content, 'load').mockResolvedValue(undefined)
  content.runtimes.push(runtime)
  content.dshRuntimeToolConnector = toolConnector
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [{ path: '/runtimes', component: RuntimeManagementView }],
  })
  await router.push('/runtimes')
  await router.isReady()
  const wrapper = mount(RuntimeManagementView, {
    attachTo: document.body,
    global: {
      plugins: [pinia, router, ElementPlus],
      stubs: {
        teleport: true,
        ElSelect: { template: '<div class="el-select-stub"><slot /></div>' },
        ElOption: true,
        ElTable: { template: '<div class="el-table-stub"><slot /></div>' },
        ElTableColumn: true,
        ElPagination: true,
      },
    },
  })
  wrappers.push(wrapper)
  await flushPromises()
  return { wrapper, content }
}

describe('Runtime DSH built-in tool connector operations', () => {
  it('shows the internal connector in Runtime details and checks it from the operations entry', async () => {
    const { wrapper, content } = await render()
    const check = vi.spyOn(content, 'checkDshRuntimeToolConnector').mockResolvedValue(toolConnector)

    const setupState = (wrapper.vm.$ as unknown as {
      setupState: { inspect: (item: RuntimeDefinition) => void }
    }).setupState
    setupState.inspect(runtime)
    await flushPromises()

    const panel = wrapper.get('[aria-label="DSH Runtime 内置工具连接"]')
    expect(panel.text()).toContain('connector-dsh-workspace')
    expect(panel.text()).toContain('4 个')
    expect(panel.text()).toContain('3 个 · 最高 rev2')
    expect(panel.text()).toContain('1234567890ab')
    expect(panel.text()).not.toContain('Bearer Token')
    expect(panel.text()).not.toContain('Agent 权限')

    await panel.get('[data-action="check-dsh-tool-connector"]').trigger('click')
    await flushPromises()
    expect(check).toHaveBeenCalledOnce()
  })
})
