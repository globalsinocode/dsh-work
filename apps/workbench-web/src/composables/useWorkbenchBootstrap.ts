import { onMounted, watch } from 'vue'

import { useAuthStore } from '@/stores/auth'
import { useContentStore } from '@/stores/content'
import { useTaskStore } from '@/stores/tasks'
import { notifyActionFailure } from '@/utils/feedback'

/**
 * 员工端壳层共用的启动加载：两种模式的壳层（EmployeeShell / CollabShell）读取同一份
 * 身份、对话与工作内容；换账号时清空上一账号的内容再加载。
 */
export function useWorkbenchBootstrap() {
  const authStore = useAuthStore()
  const taskStore = useTaskStore()
  const contentStore = useContentStore()

  watch(() => authStore.user.id, (id, previous) => {
    if (previous && id !== previous) { taskStore.reset(); contentStore.reset() }
    if (id === '—') return
    void Promise.all([taskStore.load(), contentStore.load()]).catch(cause => notifyActionFailure('加载工作台', '工作内容', cause))
  }, { immediate: true })
  onMounted(() => { void authStore.load().catch(cause => notifyActionFailure('加载身份', '当前账号', cause)) })
}
