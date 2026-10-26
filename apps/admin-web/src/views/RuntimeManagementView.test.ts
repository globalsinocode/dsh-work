import ElementPlus, { ElMessageBox } from 'element-plus'
import { createPinia, setActivePinia } from 'pinia'
import { createMemoryHistory, createRouter } from 'vue-router'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'

import RuntimeManagementView from './RuntimeManagementView.vue'
import { useAuthStore } from '../stores/auth'
import { useContentStore } from '../stores/content'
import type { BuiltinToolStatus, RuntimeDefinition } from '../types/domain'

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
  disabledTools: [],
}

const builtin: BuiltinToolStatus = {
  tools: [
    { name: 'read', label: '读取文本文件', source: 'dsh', effect: 'read', risk: 'low', assembly: 'always', constraints: [] },
    { name: 'web_search', label: '联网搜索', source: 'dsh', effect: 'read', risk: 'medium', assembly: 'agent-opt-in', constraints: [] },
    { name: 'python_execute', label: 'Python 执行', source: 'platform', effect: 'write', risk: 'medium', assembly: 'runtime', constraints: [] },
    { name: 'bash', label: '运行命令', source: 'dsh', effect: 'write', risk: 'medium', assembly: 'execution-container', constraints: [] },
  ],
  disabledTools: [],
  catalog: { checkedAt: '2026-10-22T00:00:00.000Z', missingTools: ['web_search'] },
  executionContainer: { status: 'unavailable' },
}

async function render() {
  const pinia = createPinia()
  setActivePinia(pinia)
  useAuthStore().$patch({ permissions: ['admin:write'] })
  const content = useContentStore()
  vi.spyOn(content, 'load').mockResolvedValue(undefined)
  content.runtimes.push(runtime)
  content.builtinTools = builtin
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

interface RuntimeViewState {
  inspect: (item: RuntimeDefinition) => void
  openConfiguration: (item: RuntimeDefinition) => void
  saveConfiguration: () => Promise<void>
  configurationForm: { disabledTools: string[] }
  disableableTools: Array<{ name: string }>
  catalogAlert: { type: string; title: string } | null
}

function state(wrapper: VueWrapper) {
  return (wrapper.vm.$ as unknown as { setupState: RuntimeViewState }).setupState
}

describe('Runtime built-in tools', () => {
  it('shows the read-only registry and the catalog check in Runtime details', async () => {
    const { wrapper } = await render()
    state(wrapper).inspect(runtime)
    await flushPromises()

    const panel = wrapper.get('[aria-label="内置工具"]')
    expect(panel.text()).toContain('随平台代码发布')
    expect(panel.text()).toContain('DSH 未提供以下内置工具，相关运行会失败：web_search')
    // 执行容器决定 bash 是否装配：不可用时说明影响与处理方式，原因只在服务日志。
    expect(panel.get('[data-testid="execution-container-status"]').text()).toContain('执行容器启动检查未通过：本次启动不装配 bash')
    expect(state(wrapper).disableableTools.map(tool => tool.name)).toEqual(['read', 'web_search', 'bash'])
  })

  it('confirms before disabling a tool and saves the list with the Runtime configuration', async () => {
    const { wrapper, content } = await render()
    const confirm = vi.spyOn(ElMessageBox, 'confirm').mockResolvedValue('confirm' as never)
    const update = vi.spyOn(content, 'updateRuntimeConfiguration').mockResolvedValue({ ...runtime, disabledTools: ['web_search'] })
    state(wrapper).openConfiguration(runtime)
    await flushPromises()
    state(wrapper).configurationForm.disabledTools = ['web_search']
    await state(wrapper).saveConfiguration()
    await flushPromises()

    expect(confirm).toHaveBeenCalledWith(expect.stringContaining('web_search'), '确认停用内置工具', expect.anything())
    expect(update).toHaveBeenCalledWith(expect.objectContaining({ runtimeId: runtime.id, disabledTools: ['web_search'] }))
  })
})
