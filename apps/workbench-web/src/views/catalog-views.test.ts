import ElementPlus from 'element-plus'
import { createPinia, setActivePinia } from 'pinia'
import { flushPromises, mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { workbenchApi } from '@/api/client'
import { useUiModeStore } from '@/stores/ui-mode'
import type { WorkbenchAgent, WorkbenchSkill } from '@/types/domain'
import AgentPlazaView from './AgentPlazaView.vue'
import SkillPlazaView from './SkillPlazaView.vue'

const router = vi.hoisted(() => ({ push: vi.fn() }))
vi.mock('vue-router', () => ({ useRouter: () => router }))

const skills: WorkbenchSkill[] = [
  {
    id: 'skill-knowledge',
    versionId: 'skill-version-knowledge-1',
    versionReference: 'skill-knowledge@1.0.0',
    name: '企业知识问答',
    version: '1.0.0',
    publishedAt: '2026-09-23T00:00:00.000Z',
    category: '知识',
    description: '查询当前有效制度并给出来源。',
    owner: '知识运营组',
    testPrompt: '差旅报销需要哪些材料？',
    updatedAt: '2026-09-23',
  },
  {
    id: 'skill-sheet',
    versionId: 'skill-version-sheet-11',
    versionReference: 'skill-sheet@1.1.0',
    name: '表格分析',
    version: '1.1.0',
    publishedAt: '2026-09-23T00:00:00.000Z',
    category: '文件',
    description: '分析表格并识别异常。',
    owner: 'AI 平台组',
    testPrompt: '分析这份表格。',
    updatedAt: '2026-09-23',
  },
]

const agents: WorkbenchAgent[] = [{
  id: 'agent-assistant',
  versionId: 'agent-version-assistant-120',
  versionReference: 'agent-assistant@1.2.0',
  name: '经营分析同事',
  description: '帮助员工分析经营数据。',
  welcomeMessage: '告诉我分析主题和时间范围。',
  version: '1.2.0',
  publishedAt: '2026-09-23T00:00:00.000Z',
  examplePrompts: ['分析本月订单交付情况'],
}]

describe('员工能力目录', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
  })

  it('按服务端分类展示 Skill，并从加号预选已有 Skill', async () => {
    vi.spyOn(workbenchApi, 'getSkills').mockResolvedValue(skills)
    vi.spyOn(workbenchApi, 'getAgents').mockResolvedValue(agents)
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
    expect(router.push).toHaveBeenCalledWith({
      path: '/workbench',
      query: { skill: 'skill-sheet', skillVersion: 'skill-version-sheet-11' },
    })
    // 员工没有可用的 Skill 创建专家时不显示“创建 Skill”。
    expect(wrapper.find('[data-testid="skill-plaza-create"]').exists()).toBe(false)
  })

  it('“创建 Skill”进入开启“可创建 Skill”的 AI 同事的新对话，不预填；B 模式进入单聊', async () => {
    vi.spyOn(workbenchApi, 'getSkills').mockResolvedValue(skills)
    vi.spyOn(workbenchApi, 'getAgents').mockResolvedValue([
      ...agents,
      { ...agents[0]!, id: 'agent-skill-creator', name: 'Skill 创建专家', canCreateSkills: true },
    ])
    const wrapper = mount(SkillPlazaView, { global: { plugins: [ElementPlus] } })
    await flushPromises()

    await wrapper.get('[data-testid="skill-plaza-create"]').trigger('click')
    expect(router.push).toHaveBeenCalledWith({ path: '/workbench', query: { agent: 'agent-skill-creator' }, state: { agentRecommendationPrefill: '' } })

    useUiModeStore().mode = 'collab'
    await wrapper.get('[data-testid="skill-plaza-create"]').trigger('click')
    expect(router.push).toHaveBeenLastCalledWith({ name: 'collab-agent-chat', params: { agentId: 'agent-skill-creator' }, state: { agentRecommendationPrefill: '' } })
  })

  it('AI 同事读取失败时只是不显示“创建 Skill”，Skill 列表照常', async () => {
    vi.spyOn(workbenchApi, 'getSkills').mockResolvedValue(skills)
    vi.spyOn(workbenchApi, 'getAgents').mockRejectedValue(new Error('network'))
    const wrapper = mount(SkillPlazaView, { global: { plugins: [ElementPlus] } })
    await flushPromises()
    expect(wrapper.get('[aria-label="Skill 列表"]').text()).toContain('企业知识问答')
    expect(wrapper.find('[data-testid="skill-plaza-create"]').exists()).toBe(false)
  })

  it('只展示员工接口返回的 AI 同事，并从加号预选 Agent', async () => {
    vi.spyOn(workbenchApi, 'getAgents').mockResolvedValue(agents)
    const wrapper = mount(AgentPlazaView, { global: { plugins: [ElementPlus] } })
    await flushPromises()

    expect(wrapper.get('[aria-label="AI 同事列表"]').text()).toContain('经营分析同事')
    await wrapper.get('button[aria-label="与 AI 同事开始对话：经营分析同事"]').trigger('click')
    expect(wrapper.get('button[aria-label="与 AI 同事开始对话：经营分析同事"]').text()).toContain('去对话')
    expect(router.push).toHaveBeenCalledWith({
      path: '/workbench',
      query: { agent: 'agent-assistant', agentVersion: 'agent-version-assistant-120' },
    })
  })
})
