import { ref, watch, type Ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'

import { useTaskStore } from '@/stores/tasks'
import type { Artifact, TaskRun } from '@/types/domain'
import { downloadArtifactFile, notifyActionFailure } from '@/utils/feedback'

export interface ReferencedArtifact {
  fileId: string
  name: string
  version: number
}

const maxReferencedFiles = 5

/**
 * 一次执行（Run）上的操作：停止、重新执行、复制与下载，以及 EX-02「继续修改」的成果引用。
 * A 的对话详情与 B 的对话页共用；写权限由调用方按服务端角色判定后传入 `canOperate`，
 * 函数本身也 fail-closed，服务端写轨仍是最终裁决。
 */
export function useRunActions(task: Ref<TaskRun | undefined>, options: {
  canOperate: Ref<boolean>
  /** 重新执行产生了新的 Run 时由调用方决定如何导航。 */
  onRetried?: (next: TaskRun) => void | Promise<void>
}) {
  const taskStore = useTaskStore()
  const stopping = ref(false)

  async function stopRun() {
    if (!task.value || stopping.value || !options.canOperate.value) return
    try {
      await ElMessageBox.confirm(
        '停止后会终止本轮运行尝试，已有对话和执行记录仍会保留。',
        '停止本轮执行？',
        {
          confirmButtonText: '停止本轮执行',
          cancelButtonText: '继续等待',
          type: 'warning',
        },
      )
      stopping.value = true
      await taskStore.cancelTask(task.value.id)
      ElMessage.success('本轮执行已停止，对话记录已保留')
    } catch {
      // User cancelled the confirmation.
    } finally {
      stopping.value = false
    }
  }

  async function retryRun(): Promise<boolean> {
    if (!task.value || !options.canOperate.value) return false
    try {
      const next = await taskStore.retryTask(task.value.id)
      ElMessage.success('已创建新的运行尝试')
      if (next && next.id !== task.value.id) await options.onRetried?.(next)
      return true
    } catch (error) {
      notifyActionFailure('重新执行', `运行 ${task.value.id}`, error, '刷新对话状态；确认本轮仍为失败或已停止后再重试。')
      return false
    }
  }

  function copyAnswer(content: string) {
    void navigator.clipboard.writeText(content)
    ElMessage.success('回答已复制')
  }

  function copyConversationLink(url = window.location.href) {
    void navigator.clipboard.writeText(url)
    ElMessage.success('对话链接已复制')
  }

  function download(item: Artifact) {
    void downloadArtifactFile(item)
  }

  /**
   * EX-02「继续修改」：把本轮成果作为只读输入带进下一条消息。服务端按会话与空间权限
   * 重新校验；Agent 输出同名文件时登记为该成果的下一版本，旧版本保持可下载。
   */
  const referencedArtifacts = ref<ReferencedArtifact[]>([])

  function continueEditing(artifact: Artifact) {
    if (!artifact.fileId || !artifact.canReference) return
    if (referencedArtifacts.value.some(item => item.fileId === artifact.fileId)) return
    if (referencedArtifacts.value.length >= maxReferencedFiles) {
      ElMessage.warning(`每条消息最多引用 ${maxReferencedFiles} 个文件`)
      return
    }
    referencedArtifacts.value.push({ fileId: artifact.fileId, name: artifact.name, version: artifact.version })
    ElMessage.success(`已引用 ${artifact.name}，在下方说明要怎么修改`)
  }

  function removeReferencedArtifact(fileId: string) {
    referencedArtifacts.value = referencedArtifacts.value.filter(item => item.fileId !== fileId)
  }

  // 引用只在当前会话内有效：切到其他会话时清空，避免把成果带进无关对话。
  watch(() => task.value?.sessionId, (sessionId, previous) => {
    if (sessionId !== previous) referencedArtifacts.value = []
  })

  return {
    stopping,
    stopRun,
    retryRun,
    copyAnswer,
    copyConversationLink,
    download,
    referencedArtifacts,
    continueEditing,
    removeReferencedArtifact,
  }
}
