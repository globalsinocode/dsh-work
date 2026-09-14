import ElementPlus from 'element-plus'
import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'

import AboutView from './AboutView.vue'
import { buildInfo, shortCommit } from '@/utils/build-info'

describe('AboutView', () => {
  it('shows the system release and DSH runtime identity', () => {
    const wrapper = mount(AboutView, { global: { plugins: [ElementPlus] } })

    expect(wrapper.get('[data-testid="about-system-version"]').text()).toBe(`v${buildInfo.releaseVersion}`)
    expect(wrapper.get('[data-testid="about-release-version"]').text()).toBe(`v${buildInfo.releaseVersion}`)
    expect(wrapper.get('[data-testid="about-build-commit"]').text()).toBe(shortCommit(buildInfo.buildCommit))
    expect(wrapper.get('[data-testid="about-dsh-version"]').text()).toBe(buildInfo.dshVersion)
    expect(wrapper.get('[data-testid="about-dsh-commit"]').text()).toBe(shortCommit(buildInfo.dshCommit))
    expect(wrapper.text()).toContain('版本说明')
  })
})
