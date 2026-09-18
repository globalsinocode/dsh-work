import ElementPlus from 'element-plus'
import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'

import { TaskComposer } from '@dsh-work/workbench-components'

function mountComposer(props: Record<string, unknown> = {}) {
  return mount(TaskComposer, {
    props,
    global: { plugins: [ElementPlus] },
  })
}

function submitPayload(wrapper: ReturnType<typeof mountComposer>) {
  return wrapper.emitted('submit')?.[0]?.[0] as {
    prompt: string
    files: File[]
    workspaceId: string
    mentions: string[]
    confirm: () => void
  }
}

describe('TaskComposer', () => {
  it('keeps submit unavailable for empty input and while a request is in flight', async () => {
    const empty = mountComposer()
    expect(empty.get('[aria-label="发送消息"]').attributes('disabled')).toBeDefined()

    const submitting = mountComposer({ initialPrompt: '分析库存', submitting: true })
    expect(submitting.get('[aria-label="发送消息"]').attributes('disabled')).toBeDefined()
    expect(submitting.get('[aria-label="发送消息"]').attributes('aria-busy')).toBe('true')
  })

  it('turns the send control into the stop control while a run is active', async () => {
    const wrapper = mountComposer({ initialPrompt: '保留这段草稿', running: true })
    const stop = wrapper.get('[aria-label="停止本轮执行"]')

    expect(stop.attributes('disabled')).toBeUndefined()
    expect(wrapper.find('[aria-label="发送消息"]').exists()).toBe(false)

    await stop.trigger('click')

    expect(wrapper.emitted('stop')).toEqual([[]])
    expect(wrapper.emitted('submit')).toBeUndefined()
    expect(wrapper.get<HTMLTextAreaElement>('[aria-label="对话输入"]').element.value).toBe('保留这段草稿')
  })

  it('disables the merged control while cancellation is being submitted', () => {
    const wrapper = mountComposer({ running: true, stopping: true })
    const stop = wrapper.get('[aria-label="正在停止本轮执行"]')

    expect(stop.attributes('disabled')).toBeDefined()
    expect(stop.attributes('aria-busy')).toBe('true')
  })

  it('submits a trimmed prompt and clears input only after the parent confirms', async () => {
    const wrapper = mountComposer({
      initialWorkspaceId: 'ws-supply',
      initialWorkspaceName: '供应链经营分析',
      workspaceLocked: true,
    })
    const input = wrapper.get<HTMLTextAreaElement>('[aria-label="对话输入"]')
    await input.setValue('  汇总本周延期订单  ')
    await wrapper.get('[aria-label="发送消息"]').trigger('click')

    const payload = submitPayload(wrapper)
    expect(payload).toMatchObject({ prompt: '汇总本周延期订单', files: [], workspaceId: 'ws-supply', mentions: [] })
    // 父级确认前保留草稿——异步失败（上传/建 Run/发消息）时输入不得丢失。
    expect(input.element.value).toBe('  汇总本周延期订单  ')

    payload.confirm()
    await wrapper.vm.$nextTick()
    expect(input.element.value).toBe('')
    expect(wrapper.text()).toContain('供应链经营分析')
  })

  it('keeps prompt and attachments when the parent never confirms (async failure)', async () => {
    const wrapper = mountComposer({ initialPrompt: '看看这个文件' })
    const fileInput = wrapper.get<HTMLInputElement>('input[type="file"]')
    const file = new File(['库存'], '库存计划.xlsx', {
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    })
    Object.defineProperty(fileInput.element, 'files', { configurable: true, value: [file] })
    await fileInput.trigger('change')

    await wrapper.get('[aria-label="发送消息"]').trigger('click')

    expect(wrapper.emitted('submit')).toHaveLength(1)
    expect(wrapper.get<HTMLTextAreaElement>('[aria-label="对话输入"]').element.value).toBe('看看这个文件')
    expect(wrapper.text()).toContain('库存计划.xlsx')
  })

  it('submits with Enter and keeps Shift+Enter available for a new line', async () => {
    const wrapper = mountComposer({ initialPrompt: '查询库存' })
    await wrapper.get('[aria-label="对话输入"]').trigger('keydown', { key: 'Enter' })
    expect(wrapper.emitted('submit')?.[0]?.[0]).toMatchObject({ prompt: '查询库存' })

    const multiline = mountComposer({ initialPrompt: '第一行' })
    await multiline.get('[aria-label="对话输入"]').trigger('keydown', { key: 'Enter', shiftKey: true })
    expect(multiline.emitted('submit')).toBeUndefined()
  })

  it('does not submit while an input method editor is composing text', async () => {
    const wrapper = mountComposer({ initialPrompt: '查询库存' })
    await wrapper.get('[aria-label="对话输入"]').trigger('keydown', { key: 'Enter', isComposing: true })
    expect(wrapper.emitted('submit')).toBeUndefined()
  })

  it('renders uploaded attachments in the upper-left before the prompt input', async () => {
    const wrapper = mountComposer({ initialPrompt: '帮我分析一下这个文件' })
    const fileInput = wrapper.get<HTMLInputElement>('input[type="file"]')
    const file = new File(['库存'], '库存计划.xlsx', {
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    })
    Object.defineProperty(fileInput.element, 'files', { configurable: true, value: [file] })

    await fileInput.trigger('change')

    const surface = wrapper.get('.composer__surface').element
    const attachments = wrapper.get('[aria-label="已选择文件"]').element
    const input = wrapper.get('[aria-label="对话输入"]').element
    expect(surface.firstElementChild).toBe(attachments)
    expect(attachments.nextElementSibling).toBe(input)
    expect(wrapper.text()).toContain('库存计划.xlsx')
  })

  it('shows server-enforced permission context without unsupported selectors', () => {
    const wrapper = mountComposer()
    expect(wrapper.find('[aria-label="选择执行模式"]').exists()).toBe(false)
    expect(wrapper.find('[aria-label="选择数据权限范围"]').exists()).toBe(false)
    expect(wrapper.text()).toContain('按企业身份和工作空间权限执行')

    const compact = mountComposer({ compact: true })
    expect(compact.find('[aria-label="选择执行模式"]').exists()).toBe(false)
    expect(compact.find('[aria-label="选择数据权限范围"]').exists()).toBe(false)
    expect(compact.text()).toContain('按企业权限执行')
  })

  it('shows the selected Skill as an @ reference without its version and can remove it', async () => {
    const wrapper = mountComposer({ selectedSkillName: '文档处理' })

    expect(wrapper.get('[aria-label="已选择 Skill"]').text()).toContain('@文档处理')
    expect(wrapper.text()).not.toContain('v1.0.0')

    await wrapper.get('[aria-label="移除已选择 Skill"]').trigger('click')
    expect(wrapper.emitted('clear-skill')).toEqual([[]])
  })

  it('keeps prompt and attachments when files require an @Agent mention (TW-10)', async () => {
    const wrapper = mountComposer({
      initialPrompt: '看看这个文件',
      filesRequireMention: true,
      mentionOptions: [{ id: 'wam-1', name: '欠料追踪助手' }],
    })
    const fileInput = wrapper.get<HTMLInputElement>('input[type="file"]')
    const file = new File(['库存'], '库存计划.xlsx', {
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    })
    Object.defineProperty(fileInput.element, 'files', { configurable: true, value: [file] })
    await fileInput.trigger('change')

    await wrapper.get('[aria-label="发送消息"]').trigger('click')

    expect(wrapper.emitted('submit')).toBeUndefined()
    expect(wrapper.get<HTMLTextAreaElement>('[aria-label="对话输入"]').element.value).toBe('看看这个文件')
    expect(wrapper.text()).toContain('库存计划.xlsx')
  })

  it('only resolves @mentions at a token boundary, not inside words', async () => {
    const mentionOptions = [{ id: 'wam-1', name: '助手' }]
    const embedded = mountComposer({ mentionOptions })
    await embedded.get<HTMLTextAreaElement>('[aria-label="对话输入"]').setValue('发到 user@助手 邮箱')
    await embedded.get('[aria-label="发送消息"]').trigger('click')
    expect(submitPayload(embedded).mentions).toEqual([])

    const boundary = mountComposer({ mentionOptions })
    await boundary.get<HTMLTextAreaElement>('[aria-label="对话输入"]').setValue('请 @助手 查一下')
    await boundary.get('[aria-label="发送消息"]').trigger('click')
    expect(submitPayload(boundary).mentions).toEqual(['wam-1'])
  })

  it('resolves duplicate agent names deterministically to the first listed member', async () => {
    const wrapper = mountComposer({
      mentionOptions: [
        { id: 'wam-1', name: '助手' },
        { id: 'wam-2', name: '助手' },
      ],
    })
    await wrapper.get<HTMLTextAreaElement>('[aria-label="对话输入"]').setValue('@助手 汇总')
    await wrapper.get('[aria-label="发送消息"]').trigger('click')

    expect(submitPayload(wrapper).mentions).toEqual(['wam-1'])
  })

  it('does not let a duplicate-name mention selection drift after the token moves', async () => {
    const wrapper = mountComposer({
      mentionOptions: [
        { id: 'wam-1', name: '助手' },
        { id: 'wam-2', name: '助手' },
      ],
    })
    const input = wrapper.get<HTMLTextAreaElement>('[aria-label="对话输入"]')
    await input.setValue('@')
    await wrapper.vm.$nextTick()
    await wrapper.findAll('.composer__mention-option')[1]!.trigger('mousedown')
    expect(input.element.value).toBe('@助手 ')

    await input.setValue('前缀 @助手 汇总')
    await wrapper.get('[aria-label="发送消息"]').trigger('click')

    expect(submitPayload(wrapper).mentions).toEqual(['wam-1'])
  })

  it('keeps an explicitly selected duplicate mention at its recorded position', async () => {
    const wrapper = mountComposer({
      mentionOptions: [
        { id: 'wam-1', name: '助手' },
        { id: 'wam-2', name: '助手' },
      ],
    })
    const input = wrapper.get<HTMLTextAreaElement>('[aria-label="对话输入"]')
    await input.setValue('@')
    await wrapper.vm.$nextTick()
    await wrapper.findAll('.composer__mention-option')[1]!.trigger('mousedown')

    await input.setValue('@助手 汇总')
    await wrapper.get('[aria-label="发送消息"]').trigger('click')

    expect(submitPayload(wrapper).mentions).toEqual(['wam-2'])
  })

  it('drops a selected mention when its @ token is edited into a word', async () => {
    const wrapper = mountComposer({ mentionOptions: [{ id: 'wam-1', name: '助手' }] })
    const input = wrapper.get<HTMLTextAreaElement>('[aria-label="对话输入"]')
    await input.setValue('@')
    await wrapper.vm.$nextTick()
    await wrapper.get('.composer__mention-option').trigger('mousedown')
    expect(input.element.value).toBe('@助手 ')

    await input.setValue('发给 user@助手 邮箱')
    await wrapper.get('[aria-label="发送消息"]').trigger('click')

    expect(submitPayload(wrapper).mentions).toEqual([])
  })

  it('defaults to the personal workspace and never offers an unassigned conversation', () => {
    const wrapper = mountComposer({
      initialWorkspaceId: 'ws-personal-U00001',
      initialWorkspaceName: '我的空间',
      workspaces: [
        { id: 'ws-personal-U00001', name: '我的空间', type: 'personal' },
        { id: 'ws-supply', name: '供应链经营分析', type: 'team' },
      ],
    })

    expect(wrapper.text()).toContain('我的空间')
    expect(wrapper.text()).not.toContain('未加入工作空间')
  })
})
