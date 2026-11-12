/**
 * 平台在回答末尾追加的资料页脚（企业知识与受控记忆）。
 *
 * 页脚随回答存入消息，下一轮又作为对话历史发给模型；模型会照着历史格式自己写一段“本次检索到的资料”，
 * 平台再追加一次，员工就看到两段且编号可能不一致（2026-11-12 KO8/KO9 对比：39 个回答中 11 个）。
 * 因此历史发给模型前去掉页脚，平台追加页脚前也先去掉模型写在末尾的同类段落。
 */
export const knowledgeFooterHeading = '本次检索到的资料'
export const memoryFooterHeading = '受控记忆参考（非权威业务事实）'

export const knowledgeFooterNotes = {
  noMatch: '已查询所添加的知识库，没有找到相关内容，本次回答未引用企业知识。',
  agentNotPermitted: '当前 AI 同事未开通企业知识，本次未使用所添加的知识库。',
  unavailable: '企业知识库暂不可用，本次回答未引用企业知识。',
  skipped: (name: string) => `知识库“${name}”你已无权查看，本次未使用。`,
  moved: (name: string) => `知识库“${name}”的连接已更换，暂不可用，本次未使用；如需继续使用请联系管理员。`,
}

/** 标题行加至少一行【n】列表才算页脚；只有标题或只有列表都不动，避免误删正文。 */
const footerBlocks = [
  { heading: knowledgeFooterHeading, item: /^[-*•]\s*(【\d+】)+/ },
  { heading: memoryFooterHeading, item: /^[-*•]\s*【M\d+】/ },
]

const footerNotes: RegExp[] = [
  exact(knowledgeFooterNotes.noMatch),
  exact(knowledgeFooterNotes.agentNotPermitted),
  exact(knowledgeFooterNotes.unavailable),
  /^知识库“.*”你已无权查看，本次未使用。$/,
  /^知识库“.*”的连接已更换，暂不可用，本次未使用；如需继续使用请联系管理员。$/,
]

/**
 * 去掉回答末尾连续的资料页脚（平台追加的或模型照抄的）。按行识别，容忍模型的常见变体：
 * 标题加粗或写成 Markdown 标题、末尾带冒号、用 `*` 列表、只用单个换行与正文相连、前面加 `---` 分隔线。
 * 末尾没有页脚时原样返回。
 */
export function stripCitationFooters(content: string): string {
  const lines = content.replace(/\r\n/g, '\n').split('\n')
  let end = lines.length
  let stripped = false
  for (;;) {
    while (end > 0 && !lines[end - 1]!.trim()) end -= 1
    if (end > 0 && footerNotes.some(pattern => pattern.test(plain(lines[end - 1]!)))) {
      end -= 1
      stripped = true
      continue
    }
    const block = footerBlocks.find(candidate => {
      let start = end
      while (start > 0 && candidate.item.test(lines[start - 1]!.trim())) start -= 1
      return start < end && start > 0 && plain(lines[start - 1]!) === candidate.heading
    })
    if (!block) break
    while (end > 0 && block.item.test(lines[end - 1]!.trim())) end -= 1
    end -= 1
    stripped = true
  }
  if (!stripped) return content
  while (end > 0 && /^(\s*|-{3,}|\*{3,}|_{3,})$/.test(lines[end - 1]!.trim())) end -= 1
  return lines.slice(0, end).join('\n').trimEnd()
}

/** 去掉 Markdown 标题符号、加粗与末尾冒号，便于和页脚文案比较。 */
function plain(line: string): string {
  const bare = (text: string) => text.trim().replace(/[:：]$/, '').trim()
  return bare(bare(line.replace(/^\s*#{1,6}\s*/, '')).replace(/^\*\*(.*)\*\*$/, '$1'))
}

function exact(text: string): RegExp {
  return new RegExp(`^${text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`)
}
