import { ElMessage, ElNotification } from 'element-plus'

import { workbenchApi } from '@/api/client'
import type { Artifact } from '@/types/domain'

interface StructuredFailure extends Error {
  object?: string
  suggestion?: string
  traceId?: string
}

export function notifyActionFailure(
  action: string,
  object: string,
  cause: unknown,
  fallbackSuggestion = '请稍后重试；若问题持续，请联系管理员。',
) {
  const failure = cause instanceof Error ? cause as StructuredFailure : undefined
  const reason = failure?.message ?? `${action}未完成`
  const suggestion = failure?.suggestion ?? fallbackSuggestion
  const trace = failure?.traceId && failure.traceId !== '—' ? ` 链路编号：${failure.traceId}` : ''
  ElNotification.error({
    title: `${action}失败：${failure?.object ?? object}`,
    message: `原因：${reason}。下一步：${suggestion}${trace}`,
    duration: 8000,
  })
}

export async function downloadArtifactFile(artifact: Pick<Artifact, 'id' | 'version' | 'name'>) {
  try {
    const blob = await workbenchApi.downloadArtifact(artifact.id, artifact.version)
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = artifact.name
    anchor.click()
    URL.revokeObjectURL(url)
    ElMessage.success(`已下载“${artifact.name}”`)
  } catch (cause) {
    notifyActionFailure('成果下载', `成果“${artifact.name}”V${artifact.version}`, cause, '返回成果列表刷新版本；若仍失败，请联系工作空间管理员。')
  }
}
