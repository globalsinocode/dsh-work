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
  resultType: null, installedVersion: null,
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
    const confirm = vi.spyOn(adminApi, 'confirmZipSkillInstallation').mockResolvedValue({ ...pending, status: 'installed', skillId: 'skill-1', resultType: 'created', installedVersion: '0.1.0' })
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

  it('shows an existing matching package as reused instead of a new draft', async () => {
    vi.spyOn(adminApi, 'prepareZipSkillInstallation').mockResolvedValue(pending)
    vi.spyOn(adminApi, 'confirmZipSkillInstallation').mockResolvedValue({ ...pending, status: 'installed', skillId: 'skill-existing', resultType: 'duplicate', installedVersion: '1.2.0' })
    const wrapper = render()
    await chooseFile(wrapper, 'document-summary.zip')
    await button(wrapper, '解析安装包').trigger('click'); await flushPromises()
    await wrapper.get('input[type="checkbox"]').setValue(true)
    await button(wrapper, '确认安装').trigger('click'); await flushPromises()

    expect(wrapper.text()).toContain('Skill 已存在，无需重复安装')
    expect(wrapper.text()).toContain('没有创建重复 Skill 或版本')
    expect(wrapper.text()).toContain('已存在 · v1.2.0')
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

const pendingLink: SkillInstallation = { ...pending, channel: 'link', source: 'https://github.com/fixture/document-summary',
  canSaveDraft: true, canPublish: false, publicationBlockers: [
    { code: 'RUNTIME_UNAVAILABLE', message: 'DSH 执行能力不可用，当前不可发布' },
    { code: 'TRIAL_REQUIRED', message: '发布前必须完成当前版本的真实试运行' },
  ],
}
async function linkMode(wrapper: VueWrapper) {
  await button(wrapper, '链接导入').trigger('click')
  await wrapper.get('input#skill-source-url').setValue(pendingLink.source)
}

describe('C7 direct link installation', () => {
  it('C7 RED: previews and saves a link draft without a chat, ZIP or model route', async () => {
    const prepare = vi.spyOn(adminApi, 'prepareLinkSkillInstallation').mockResolvedValue(pendingLink)
    const zip = vi.spyOn(adminApi, 'prepareZipSkillInstallation')
    const confirm = vi.spyOn(adminApi, 'confirmDirectSkillInstallation').mockResolvedValue({ ...pendingLink, status: 'installed', skillId: 'skill-link', resultType: 'created', installedVersion: '0.1.0', canSaveDraft: false })
    const wrapper = render()
    await linkMode(wrapper)
    await wrapper.get('input#skill-source-selected').setValue('document-summary')
    await button(wrapper, '解析链接').trigger('click'); await flushPromises()
    expect(prepare).toHaveBeenCalledWith({ url: pendingLink.source, selected: 'document-summary' })
    expect(zip).not.toHaveBeenCalled(); expect(wrapper.emitted('assistant')).toBeUndefined()
    expect(wrapper.text()).toContain('当前不可发布')
    expect(wrapper.text()).toContain('DSH 执行能力不可用')
    await wrapper.get('input[type="checkbox"]').setValue(true)
    expect(button(wrapper, '确认安装').attributes('disabled')).toBeUndefined()
    await button(wrapper, '确认安装').trigger('click'); await flushPromises()
    expect(confirm).toHaveBeenCalledWith(pendingLink.id, pendingLink.planSha256)
    expect(wrapper.emitted('installed')).toEqual([['skill-link']])
    expect(wrapper.text()).toContain('本次没有执行发布')
  })

  it('C7 RED: incompatible link packages cannot be confirmed despite an otherwise available UI', async () => {
    vi.spyOn(adminApi, 'prepareLinkSkillInstallation').mockResolvedValue({ ...pendingLink, canSaveDraft: false,
      plan: { ...pendingLink.plan!, compatibility: { status: 'incompatible', issues: [{ code: 'forbidden-tool', message: 'Bash 不支持', severity: 'error' }] } } })
    const confirm = vi.spyOn(adminApi, 'confirmDirectSkillInstallation')
    const wrapper = render(); await linkMode(wrapper)
    await button(wrapper, '解析链接').trigger('click'); await flushPromises()
    expect(button(wrapper, '确认安装').attributes('disabled')).toBeDefined()
    expect(wrapper.get('input[type="checkbox"]').attributes('disabled')).toBeDefined()
    expect(confirm).not.toHaveBeenCalled()
  })

  it('retains source and displays sanitized backend errors without creating a plan', async () => {
    vi.spyOn(adminApi, 'prepareLinkSkillInstallation').mockRejectedValue(new Error('来源域名未获准'))
    const wrapper = render(); await linkMode(wrapper)
    await button(wrapper, '解析链接').trigger('click'); await flushPromises()
    expect(wrapper.get('input#skill-source-url').element).toHaveProperty('value', pendingLink.source)
    expect(wrapper.get('[role="alert"]').text()).toContain('来源域名未获准')
    expect(wrapper.find('input[type="checkbox"]').exists()).toBe(false)
  })

  it('changing source/mode invalidates the prior digest and explicit acknowledgement', async () => {
    vi.spyOn(adminApi, 'prepareLinkSkillInstallation').mockResolvedValue(pendingLink)
    const wrapper = render(); await linkMode(wrapper)
    await button(wrapper, '解析链接').trigger('click'); await flushPromises()
    await wrapper.get('input[type="checkbox"]').setValue(true)
    await button(wrapper, '返回修改来源').trigger('click')
    expect(wrapper.text()).not.toContain('plan-sha')
    await button(wrapper, 'ZIP 文件').trigger('click')
    expect(wrapper.find('input#skill-source-url').exists()).toBe(false)
    expect(button(wrapper, '解析安装包').attributes('disabled')).toBeDefined()
  })

  it('freezes source during acquisition and discards a response after unmount', async () => {
    let resolve: (value: SkillInstallation) => void = () => undefined
    vi.spyOn(adminApi, 'prepareLinkSkillInstallation').mockImplementation(() => new Promise(done => { resolve = done }))
    const wrapper = render(); await linkMode(wrapper)
    await button(wrapper, '解析链接').trigger('click')
    expect(wrapper.get('input#skill-source-url').attributes('disabled')).toBeDefined()
    expect(button(wrapper, 'ZIP 文件').attributes('disabled')).toBeDefined()
    wrapper.unmount(); resolve(pendingLink); await flushPromises()
    expect(wrapper.emitted('installed')).toBeUndefined()
  })
})
