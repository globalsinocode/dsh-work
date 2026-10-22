import { ElMessage } from 'element-plus'

import { workbenchApi } from '@/api/client'
import { triggerBlobDownload } from '@/utils/download-file'
import { notifyActionFailure } from '@/utils/feedback'

export async function exportConversation(input: {
  scope: 'session' | 'run'
  sessionId: string
  runId?: string
  title: string
}) {
  try {
    const downloaded = input.scope === 'session'
      ? await workbenchApi.downloadSessionExport(input.sessionId)
      : await workbenchApi.downloadRunExport(input.runId ?? '')
    const fallback = input.scope === 'session'
      ? `${input.title}-完整会话.txt`
      : `${input.title}-本次Run.txt`
    triggerBlobDownload(downloaded.blob, downloaded.filename ?? fallback)
    ElMessage.success(input.scope === 'session' ? '完整会话已导出' : '本次 Run 已导出')
  } catch (error) {
    notifyActionFailure(
      input.scope === 'session' ? '导出完整会话' : '导出本次 Run',
      `对话“${input.title}”`,
      error,
      '刷新对话状态后重试；若仍失败，请联系管理员。',
    )
  }
}
