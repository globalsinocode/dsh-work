import ElementPlus from 'element-plus'
import { createPinia, setActivePinia } from 'pinia'
import { flushPromises, mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { workbenchApi } from '@/api/client'
import type { WorkbenchAgent, WorkbenchSkill } from '@/types/domain'
import AgentPlazaView from './AgentPlazaView.vue'
import SkillPlazaView from './SkillPlazaView.vue'

const router = vi.hoisted(() => ({ push: vi.fn() }))
vi.mock('vue-router', () => ({ useRouter: () => router }))

const skills: WorkbenchSkill[] = [
  {
    id: 'skill-knowledge',
    name: '企业知识问答',
    version: '1.0.0',
    category: '知识',
    description: '查询当前有效制度并给出来源。',
    owner: '知识运营组',
    testPrompt: '差旅报销需要哪些材料？',
    updatedAt: '2026-09-23',
  },
  {
    id: 'skill-sheet',
    name: '表格分析',
    version: '1.1.0',
    category: '文件',
    description: '分析表格并识别异常。',
    owner: 'AI 平台组',
    testPrompt: '分析这份表格。',
    updatedAt: '2026-09-23',
  },
]

const agents: WorkbenchAgent[] = [{
  id: 'agent-assistant',
  name: '经营分析同事',
  description: '帮助员工分析经营数据。',
  welcomeMessage: '告诉我分析主题和时间范围。',
  version: '1.2.0',
  examplePrompts: ['分析本月订单交付情况'],
}]

describe('员工能力目录', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
  })

  it('按服务端分类展示 Skill，并从加号预选已有 Skill', async () => {
    vi.spyOn(workbenchApi, 'getSkills').mockResolvedValue(skills)
    const wrapper = mount(SkillPlazaView, { global: { plugins: [ElementPlus] } })
    await flushPromises()

    expect(wrapper.get('[aria-label="Skill 列表"]').text()).toContain('企业知识问答')
    const fileCategory = wrapper.findAll<HTMLButtonElement>('.skill-category-tab')
      .find(button => button.text() === '文件')
    await fileCategory?.trigger('click')
    expect(wrapper.get('[aria-label="Skill 列表"]').text()).toContain('表格分析')
    expect(wrapper.get('[aria-label="Skill 列表"]').text()).not.toContain('企业知识问答')

    await wrapper.get('button[aria-label="使用 Skill：表格分析"]').trigger('click')
    expect(wrapper.get('button[aria-label="使用 Skill：表格分析"]').text()).toContain('去对话')
    expect(router.push).toHaveBeenCalledWith({ path: '/workbench', query: { skill: 'skill-sheet' } })
  })

  it('只展示员工接口返回的 AI 同事，并从加号预选 Agent', async () => {
    vi.spyOn(workbenchApi, 'getAgents').mockResolvedValue(agents)
    const wrapper = mount(AgentPlazaView, { global: { plugins: [ElementPlus] } })
    await flushPromises()

    expect(wrapper.get('[aria-label="AI 同事列表"]').text()).toContain('经营分析同事')
    await wrapper.get('button[aria-label="与 AI 同事开始对话：经营分析同事"]').trigger('click')
    expect(wrapper.get('button[aria-label="与 AI 同事开始对话：经营分析同事"]').text()).toContain('去对话')
    expect(router.push).toHaveBeenCalledWith({ path: '/workbench', query: { agent: 'agent-assistant' } })
  })
})
