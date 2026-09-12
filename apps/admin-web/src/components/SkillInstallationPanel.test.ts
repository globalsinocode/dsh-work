import ElementPlus from 'element-plus'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'

import SkillInstallationPanel from './SkillInstallationPanel.vue'

const wrappers: VueWrapper[] = []
afterEach(() => {
  wrappers.splice(0).forEach(wrapper => wrapper.unmount())
  vi.restoreAllMocks()
})

function render() {
  const wrapper = mount(SkillInstallationPanel, { global: { plugins: [ElementPlus] } })
  wrappers.push(wrapper)
  return wrapper
}

function button(wrapper: VueWrapper, label: string) {
  const found = wrapper.findAll('button').find(item => item.text().includes(label))
  if (!found) throw new Error(`Button not found: ${label}`)
  return found
}

async function chooseFile(wrapper: VueWrapper, name: string, content = 'sample') {
  const input = wrapper.get('input[type="file"]')
  Object.defineProperty(input.element, 'files', { value: [new File([content], name)], configurable: true })
  await input.trigger('change')
  await flushPromises()
}

describe('Skill installation interaction preview', () => {
  it('validates file selection locally, supports replacement and removal, and never uploads', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Unexpected network request'))
    const request = vi.spyOn(XMLHttpRequest.prototype, 'send')
    const wrapper = render()
    expect(button(wrapper, '预览安装流程').attributes('disabled')).toBeDefined()
    await chooseFile(wrapper, 'instructions.txt')
    expect(wrapper.get('[role="alert"]').text()).toContain('ZIP')
    await chooseFile(wrapper, 'empty.zip', '')
    expect(wrapper.get('[role="alert"]').text()).toContain('文件为空')
    await chooseFile(wrapper, 'first.zip')
    await chooseFile(wrapper, 'second.zip')
    expect(wrapper.text()).not.toContain('first.zip')
    expect(wrapper.text()).toContain('second.zip')
    expect(wrapper.text()).toContain('尚未上传或解析')
    await button(wrapper, '移除').trigger('click')
    expect(button(wrapper, '预览安装流程').attributes('disabled')).toBeDefined()
    expect(fetch).not.toHaveBeenCalled()
    expect(request).not.toHaveBeenCalled()
  })

  it('requires confirmation, resets it after revising the source, and distinguishes demo completion', async () => {
    const wrapper = render()
    await button(wrapper, '使用示例包').trigger('click')
    expect(wrapper.text()).toContain('并非从所选文件或链接中解析')
    expect(button(wrapper, '确认安装（演示）').attributes('disabled')).toBeDefined()
    await wrapper.get('input[type="checkbox"]').setValue(true)
    await button(wrapper, '返回修改来源').trigger('click')
    await button(wrapper, '预览安装流程').trigger('click')
    expect(button(wrapper, '确认安装（演示）').attributes('disabled')).toBeDefined()
    await wrapper.get('input[type="checkbox"]').setValue(true)
    await button(wrapper, '确认安装（演示）').trigger('click')
    expect(wrapper.text()).toContain('本次未创建 Skill 或版本记录')
    await button(wrapper, '返回 Skill 中心').trigger('click')
    expect(wrapper.emitted('back')).toHaveLength(1)
  })

  it('offers only ZIP upload and delegates conversational management to the unified assistant', async () => {
    const wrapper = render()
    expect(wrapper.find('textarea').exists()).toBe(false)
    expect(wrapper.text()).not.toContain('对话安装')
    await button(wrapper, '前往管理助手').trigger('click')
    expect(wrapper.emitted('assistant')).toHaveLength(1)
  })

  it('clears previous confirmation and sources when switching the installation target', async () => {
    const wrapper = render()
    await button(wrapper, '使用示例包').trigger('click')
    await wrapper.get('input[type="checkbox"]').setValue(true)
    await wrapper.setProps({ target: { id: 'skill-existing', name: '已有 Skill' } })
    expect(wrapper.text()).toContain('已有 Skill 的新版本')
    expect(button(wrapper, '预览安装流程').attributes('disabled')).toBeDefined()
    expect(wrapper.find('input[type="checkbox"]').exists()).toBe(false)
  })
})
