/**
 * Why a file under output/ was not registered as an artifact (execution isolation 2b-2).
 * Fixed codes with fixed wording: shown under the reply, never a parser or scanner message.
 */
export type ArtifactSkipReason =
  | 'invalid_name'
  | 'hidden_file'
  | 'not_regular_file'
  | 'unsupported_format'
  | 'empty_file'
  | 'too_large'
  | 'total_too_large'
  | 'too_many_files'
  | 'content_mismatch'
  | 'active_content'
  | 'unverifiable'
  | 'security_scan_failed'

/** Fixed wording shown under the reply; never a parser message. */
export const ARTIFACT_SKIP_REASON_TEXT: Record<ArtifactSkipReason, string> = {
  invalid_name: '文件名无效',
  hidden_file: '隐藏文件不作为成果',
  not_regular_file: '不是普通文件（目录、链接或特殊文件）',
  unsupported_format: '格式不支持',
  empty_file: '文件为空',
  too_large: '超过 20 MB',
  total_too_large: '本轮成果合计超过 50 MB',
  too_many_files: '本轮成果超过 20 个',
  content_mismatch: '文件内容与扩展名不符',
  active_content: '含宏、脚本或会访问外部内容的组件',
  unverifiable: '文件结构无法完整检查',
  security_scan_failed: '安全检查未通过',
}

export function isArtifactSkipReason(value: unknown): value is ArtifactSkipReason {
  return typeof value === 'string' && Object.hasOwn(ARTIFACT_SKIP_REASON_TEXT, value)
}
