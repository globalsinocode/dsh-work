import ElementPlus from 'element-plus'
import { createPinia, setActivePinia } from 'pinia'
import { flushPromises, mount } from '@vue/test-utils'
import { describe, expect, it, vi } from 'vitest'

import { useAgentGovernanceStore, type ZipInspection } from '@/stores/agentGovernance'
import AgentZipImportPanel from './AgentZipImportPanel.vue'

const inspection: ZipInspection = {
  fileName: 'agent.zip',
  manifest: { id: 'text-agent', name: '文本 Agent', version: '0.1.0', description: '整理输入文本' },
  files: ['agent.yaml', 'SOUL.md'],
  systemPrompt: '你是文本整理助手，只依据用户输入回答。',
  resolved: { skills: [], tools: [] },
  missing: { skills: [], tools: [] },
  packageRefs: { skills: [], tools: [] },
  cases: [],
  warnings: [],
}

async function preview(result: ZipInspection) {
  const pinia = createPinia()
  setActivePinia(pinia)
  vi.spyOn(useAgentGovernanceStore(), 'inspectPackage').mockResolvedValue(result)
  const wrapper = mount(AgentZipImportPanel, { global: { plugins: [pinia, ElementPlus] } })
  const input = wrapper.get('input[type="file"]')
  Object.defineProperty(input.element, 'files', {
    value: [new File(['zip-bytes'], 'agent.zip', { type: 'application/zip' })],
    configurable: true,
  })
  await input.trigger('change')
  await flushPromises()
  return wrapper
}

describe('Agent ZIP dependency preview', () => {
  it('does not call entirely unresolved declarations undeclared', async () => {
    const wrapper = await preview({
      ...inspection,
      missing: { skills: ['read@9.9.9'], tools: [] },
    })
    expect(wrapper.text()).toContain('缺少：')
    expect(wrapper.text()).toContain('read@9.9.9')
    expect(wrapper.text()).toContain('声明的依赖均未解析到已发布版本')
    expect(wrapper.text()).not.toContain('未声明 Skill 或工具依赖')
    wrapper.unmount()
  })

  it('identifies a package with no Skill or tool declarations', async () => {
    const wrapper = await preview(inspection)
    expect(wrapper.text()).toContain('未声明 Skill 或工具依赖')
    expect(wrapper.text()).not.toContain('缺少：')
    wrapper.unmount()
  })
})
