import { onBeforeUnmount, ref, watch } from 'vue'

import { workbenchApi } from '@/api/client'
import type { Artifact } from '@/types/domain'

/**
 * 执行隔离 2b-5：图片成果经鉴权下载取得 Blob，再以本地 object URL 交给 `<img>`；
 * 不拼接直链、不经第三方服务。切换成果或卸载时作废在途请求并释放 URL。
 */
export function useArtifactImage(source: () => Pick<Artifact, 'id' | 'version'> | null | undefined) {
  const url = ref('')
  const loading = ref(false)
  const error = ref(false)
  let requestSeq = 0

  function release() {
    if (url.value) URL.revokeObjectURL(url.value)
    url.value = ''
  }

  async function load() {
    const artifact = source()
    const seq = ++requestSeq
    release()
    error.value = false
    if (!artifact) {
      loading.value = false
      return
    }
    loading.value = true
    try {
      const blob = await workbenchApi.downloadArtifact(artifact.id, artifact.version)
      if (seq !== requestSeq) return
      url.value = URL.createObjectURL(blob)
    } catch {
      if (seq === requestSeq) error.value = true
    } finally {
      if (seq === requestSeq) loading.value = false
    }
  }

  watch(() => [source()?.id, source()?.version], () => { void load() }, { immediate: true })
  onBeforeUnmount(() => {
    requestSeq += 1
    release()
  })

  return { url, loading, error, reload: load }
}
