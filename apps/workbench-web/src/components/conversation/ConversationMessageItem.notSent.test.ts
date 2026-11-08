import ElementPlus from 'element-plus'
import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'

import ConversationMessageItem from './ConversationMessageItem.vue'

const render = (notSentToModel?: boolean) => mount(ConversationMessageItem, {
  props: { message: { role: 'user', content: '帮我看看', createdAt: '10:00', ...(notSentToModel ? { notSentToModel } : {}) } },
  global: { plugins: [ElementPlus] },
})

describe('未发送给模型的标记', () => {
  it('被拦截的消息显示标记和固定说明', () => {
    const note = render(true).get('[data-testid="message-not-sent"]')
    expect(note.text()).toContain('未发送给模型')
    expect(note.text()).toContain('这条消息包含 密钥，按公司数据防护策略未发送给模型。请删除后重新发送。')
  })

  it('普通消息不显示', () => {
    expect(render().find('[data-testid="message-not-sent"]').exists()).toBe(false)
  })
})
