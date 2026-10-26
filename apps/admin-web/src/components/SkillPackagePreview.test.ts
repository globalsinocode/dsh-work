import ElementPlus from 'element-plus'
import { mount } from '@vue/test-utils'
import { expect, it } from 'vitest'

import SkillPackagePreview from './SkillPackagePreview.vue'
import type { InstalledSkillPackage } from '@/types/assistant'

function pkg(overrides: Partial<InstalledSkillPackage> = {}): InstalledSkillPackage {
  return {
    name: 'shell-skill', description: '需要 Shell 的 Skill。', instructions: '运行仓库脚本并汇报结果。', version: null,
    toolIds: [], sha256: 'a'.repeat(64), archiveSha256: 'b'.repeat(64), files: [{ path: 'SKILL.md', size: 120, sha256: 'c'.repeat(64) }],
    requirements: [], compatibility: { status: 'needs_review', issues: [] }, disableModelInvocation: false,
    ...overrides,
  }
}

function render(value: InstalledSkillPackage) {
  return mount(SkillPackagePreview, { props: { source: 'upload', package: value }, global: { plugins: [ElementPlus] } })
}

it('不把声明了不支持工具的 Skill 说成纯指令 Skill，并用中文显示依赖状态', () => {
  const wrapper = render(pkg({ requirements: [{ type: 'tool', name: 'Bash', status: 'unsupported', evidence: 'allowed-tools 声明' }] }))
  const panel = wrapper.get('.dependency-panel').text()
  expect(panel).not.toContain('纯指令 Skill')
  expect(panel).toContain('Bash')
  expect(panel).toContain('不支持')
  expect(panel).not.toContain('unsupported')
})

it('没有任何工具依赖时显示纯指令 Skill', () => {
  expect(render(pkg()).get('.dependency-panel').text()).toContain('纯指令 Skill，无工具依赖。')
})
