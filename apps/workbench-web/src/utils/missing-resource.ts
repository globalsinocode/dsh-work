/**
 * 服务端明确答复“没有这个对象或无权访问”：401/403/404，以及 ID 格式无效的 400。
 * 其余错误（5xx、网络中断、请求被中止）只说明暂时拿不到，不能当作对象不存在——
 * 调用方据此决定是提示“未找到”、清理缓存，还是保留现有内容并允许重试。
 */
export function isMissingResource(error: unknown) {
  const status = error instanceof Error && 'status' in error ? error.status : undefined
  return typeof status === 'number' && [400, 401, 403, 404].includes(status)
}
