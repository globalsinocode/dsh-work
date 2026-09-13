import ElementPlus from 'element-plus'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { adminApi } from '@/api/client'
import type { SkillInstallation } from '@/types/assistant'
import SkillInstallationPanel from './SkillInstallationPanel.vue'

const wrappers: VueWrapper[] = []
afterEach(() => {
  wrappers.splice(0).forEach(wrapper => wrapper.unmount())
  vi.restoreAllMocks()
})

const packagePreview = {
  name: 'document-summary', description: '整理文档并输出摘要', instructions: 'Read the input and summarize it.', version: '1.2.0', toolIds: ['read@1.0.0'],
  sha256: 'package-sha', archiveSha256: 'archive-sha', files: [{ path: 'SKILL.md', size: 120, sha256: 'file-sha' }], requirements: [],
  compatibility: { status: 'compatible' as const, issues: [] }, disableModelInvocation: false,
}
const pending: SkillInstallation = {
  id: 'installation-1', runId: null, source: 'document-summary.zip', resolvedUrl: null, resolvedRef: null, status: 'pending', skillId: null,
  package: packagePreview, planSha256: 'plan-sha', compatibilityStatus: 'compatible',
  plan: { planVersion: '1.0', rootName: packagePreview.name, packages: [packagePreview], edges: [], compatibility: packagePreview.compatibility, summary: { packageCount: 1, dependencyCount: 0, toolIds: packagePreview.toolIds, pythonFiles: 0 }, sha256: 'plan-sha' },
}

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

describe('ZIP Skill installation', () => {
  it('validates the local file before uploading it', async () => {
    const prepare = vi.spyOn(adminApi, 'prepareZipSkillInstallation')
    const wrapper = render()
    expect(button(wrapper, '解析安装包').attributes('disabled')).toBeDefined()
    await chooseFile(wrapper, 'instructions.txt')
    expect(wrapper.get('[role="alert"]').text()).toContain('ZIP')
    await chooseFile(wrapper, 'empty.zip', '')
    expect(wrapper.get('[role="alert"]').text()).toContain('文件为空')
    await chooseFile(wrapper, 'skill.zip')
    expect(wrapper.text()).toContain('等待解析')
    await button(wrapper, '移除').trigger('click')
    expect(button(wrapper, '解析安装包').attributes('disabled')).toBeDefined()
    expect(prepare).not.toHaveBeenCalled()
  })

  it('uploads the selected ZIP, displays the parsed plan, and confirms the exact digest', async () => {
    const prepare = vi.spyOn(adminApi, 'prepareZipSkillInstallation').mockResolvedValue(pending)
    const confirm = vi.spyOn(adminApi, 'confirmZipSkillInstallation').mockResolvedValue({ ...pending, status: 'installed', skillId: 'skill-1' })
    const wrapper = render()
    await chooseFile(wrapper, 'document-summary.zip', 'zip-bytes')
    await button(wrapper, '解析安装包').trigger('click')
    await flushPromises()
    expect(prepare).toHaveBeenCalledWith(expect.objectContaining({ name: 'document-summary.zip' }))
    expect(wrapper.text()).toContain('document-summary')
    expect(wrapper.text()).toContain('真实安装计划')
    expect(wrapper.text()).toContain('plan-sha')
    expect(button(wrapper, '确认安装').attributes('disabled')).toBeDefined()
    await wrapper.get('input[type="checkbox"]').setValue(true)
    await button(wrapper, '确认安装').trigger('click')
    await flushPromises()
    expect(confirm).toHaveBeenCalledWith('installation-1', 'plan-sha')
    expect(wrapper.text()).toContain('Skill 已安装为草稿')
    expect(wrapper.emitted('installed')).toEqual([['skill-1']])
  })

  it('keeps the selected file and shows actionable server errors', async () => {
    vi.spyOn(adminApi, 'prepareZipSkillInstallation').mockRejectedValue(Object.assign(new Error('Skill 包校验失败'), { suggestion: '检查 SKILL.md 后重新上传', traceId: 'trace-1' }))
    const wrapper = render()
    await chooseFile(wrapper, 'broken.zip')
    await button(wrapper, '解析安装包').trigger('click')
    await flushPromises()
    expect(wrapper.text()).toContain('broken.zip')
    expect(wrapper.get('[role="alert"]').text()).toContain('检查 SKILL.md 后重新上传')
    expect(wrapper.get('[role="alert"]').text()).toContain('trace-1')
  })

  it('blocks confirmation for an incompatible parsed plan and keeps the assistant entry', async () => {
    const incompatible: SkillInstallation = { ...pending, compatibilityStatus: 'incompatible', plan: { ...pending.plan!, compatibility: { status: 'incompatible', issues: [{ code: 'python', severity: 'error', message: 'Python 沙箱不可用' }] } } }
    vi.spyOn(adminApi, 'prepareZipSkillInstallation').mockResolvedValue(incompatible)
    const wrapper = render()
    await chooseFile(wrapper, 'python-skill.zip')
    await button(wrapper, '解析安装包').trigger('click')
    await flushPromises()
    expect(wrapper.text()).toContain('Python 沙箱不可用')
    expect(wrapper.get('input[type="checkbox"]').attributes('disabled')).toBeDefined()
    expect(button(wrapper, '确认安装').attributes('disabled')).toBeDefined()
    await button(wrapper, '返回修改来源').trigger('click')
    await button(wrapper, '前往管理助手').trigger('click')
    expect(wrapper.emitted('assistant')).toHaveLength(1)
  })
})
