import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'

import { AssistantMessageContent } from '@dsh-work/ui-core'

describe('AssistantMessageContent', () => {
  it('renders readable Markdown structure while keeping model output escaped', () => {
    const wrapper = mount(AssistantMessageContent, { props: { text: [
      '已获取安装计划。',
      '',
      '**来源**',
      '- 仓库：https://github.com/example/skills',
      '- 版本：`abc123`',
      '',
      '1. **grill-me**',
      '   - 描述：主 Skill',
      '2. **grilling**',
      '<img src=x onerror=alert(1)>',
      '',
      '```text',
      'Error: tool is not authorized',
      '```',
    ].join('\n') } })

    expect(wrapper.findAll('strong').map(item => item.text())).toEqual(['来源', 'grill-me', 'grilling'])
    expect(wrapper.findAll('li')).toHaveLength(5)
    expect(wrapper.get('ol').text()).toContain('grill-me描述：主 Skillgrilling')
    expect(wrapper.get('code').text()).toBe('abc123')
    expect(wrapper.get('a').attributes()).toMatchObject({ href: 'https://github.com/example/skills', target: '_blank', rel: 'noopener noreferrer' })
    expect(wrapper.find('img').exists()).toBe(false)
    expect(wrapper.text()).toContain('<img src=x onerror=alert(1)>')
    expect(wrapper.get('.assistant-code-block > span').text()).toBe('text')
    expect(wrapper.get('pre code').text()).toBe('Error: tool is not authorized')
  })
})
