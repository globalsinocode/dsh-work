import assert from 'node:assert/strict'
import { test } from 'node:test'

import { stripCitationFooters } from './citation-footer.ts'

const knowledge = '本次检索到的资料\n- 【1】差旅报销管理办法.md（更新于 2026-11-12）\n- 【2】【3】考勤制度.md（更新于 2026-11-12）'
const memory = '受控记忆参考（非权威业务事实）\n- 【M1】报销偏好 v2（仅自己）'

test('去掉平台追加的知识与记忆页脚，保留正文', () => {
  const answer = '住宿上限 420 元【1】。\n\n伙食补贴无需发票【2】。'
  assert.equal(stripCitationFooters(`${answer}\n\n${knowledge}\n\n${memory}`), answer)
})

test('模型照抄的页脚与平台页脚连续出现时一起去掉（KO8/KO9 对比中的重复页脚）', () => {
  const answer = '上海住宿上限 550 元【1】。'
  const copied = '本次检索到的资料\n- 【1】差旅报销管理办法.md（更新于 2026-11-12）'
  assert.equal(stripCitationFooters(`${answer}\n\n${copied}\n\n${knowledge}`), answer)
  assert.equal(stripCitationFooters(`${answer}\n\n${memory}\n\n${memory}`), answer)
})

test('容忍模型的常见写法变体', () => {
  const answer = '上海住宿上限 550 元【1】。'
  const item = '【1】差旅报销管理办法.md（更新于 2026-11-12）'
  for (const footer of [
    `**本次检索到的资料**\n- ${item}`,
    `**本次检索到的资料：**\n- ${item}`,
    `### 本次检索到的资料\n* ${item}`,
    `本次检索到的资料:\n- ${item}`,
    `---\n本次检索到的资料\n- ${item}`,
  ]) assert.equal(stripCitationFooters(`${answer}\n\n${footer}`), answer, footer)
  assert.equal(stripCitationFooters(`${answer}\n本次检索到的资料\n- ${item}`), answer, '只用单个换行与正文相连')
  assert.equal(stripCitationFooters(`${answer}\r\n\r\n本次检索到的资料\r\n- ${item}\r\n`), answer, 'Windows 换行')
})

test('提示类页脚段落也会去掉，库名含引号时同样识别', () => {
  const notes = [
    '已查询所添加的知识库，没有找到相关内容，本次回答未引用企业知识。',
    '知识库“安全”制度”你已无权查看，本次未使用。',
    '知识库“旧库”的连接已更换，暂不可用，本次未使用；如需继续使用请联系管理员。',
    '企业知识库暂不可用，本次回答未引用企业知识。',
    '当前 AI 同事未开通企业知识，本次未使用所添加的知识库。',
  ]
  assert.equal(stripCitationFooters(`回答\n\n${notes.join('\n\n')}`), '回答')
})

test('正文中间提到“本次检索到的资料”、只有标题没有列表或格式不符时不动', () => {
  const middle = `${knowledge}\n\n以上资料之外，还需要部门审批。`
  assert.equal(stripCitationFooters(middle), middle)
  const prose = '回答\n\n本次检索到的资料很少，建议补充文档。'
  assert.equal(stripCitationFooters(prose), prose)
  const headingOnly = '回答\n\n本次检索到的资料'
  assert.equal(stripCitationFooters(headingOnly), headingOnly)
  const listOnly = '回答\n\n- 【1】第一条\n- 【2】第二条'
  assert.equal(stripCitationFooters(listOnly), listOnly)
  assert.equal(stripCitationFooters('只有正文'), '只有正文')
  assert.equal(stripCitationFooters(''), '')
})

test('整条只有页脚时返回空串，由调用方决定保留原文', () => {
  assert.equal(stripCitationFooters(knowledge), '')
})
